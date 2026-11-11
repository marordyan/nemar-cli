/**
 * From the observer's document to the rows the Worker stores (epic #2005 phase A7, #2012; ADR 0118,
 * decision 8).
 *
 * The observer posts `nemar.observation.v1` (`shared/contract/compute-observation.ts`). The Worker's
 * tables and its settlement are older than that document and are NOT changed by it: this module is the
 * one place the two meet, and it is a pure function with a table of its own (below) that a test pins
 * line by line.
 *
 *   document                                            row
 *   --------                                            ---
 *   partitions.<name>.jobs.PENDING.jobs                 compute_queue_snapshots.pending
 *   partitions.<name>.jobs.RUNNING.jobs                 compute_queue_snapshots.running
 *   accounting.jobs[].job_id                            compute_sacct_rows.slurm_job_id
 *   accounting.jobs[].partition / state                 .partition / .state
 *   accounting.jobs[].elapsed_seconds                   .elapsed_seconds
 *   accounting.jobs[].alloc_tres  node / cpu            .alloc_nodes / .alloc_cpus
 *   accounting.jobs[].alloc_tres  gres/gpu / mem        .alloc_gpus / .alloc_mem_mb (mem in MB, rounded up)
 *   accounting.jobs[].submit / start / end              .submit_time / .start_time / .end_time
 *   (nothing)                                           .charged_milli = NULL
 *
 * `charged_milli` is always NULL: the observer posts no charge, so the settlement prices the allocation
 * with the rate table, as it does for any row without a figure of its own. Everything else in the
 * document (`sources`, `pending_starts`, `balance`, the nodes by state, the pending reasons) is checked
 * and not stored.
 *
 * WHAT IS REFUSED, WHAT IS SKIPPED, WHAT NEVER HAPPENS.
 *  - REFUSED (the post is 400 `invalid_post` and the run is not spent): a document that is not the
 *    document (wrong `schema`, an unknown key, a wrong type), more than 5,000 rows, an allocation item
 *    that `parseAllocTres` cannot read, a row with elapsed time and no `cpu` item (an allocation that
 *    ran and is not on record is a charge of nothing, which is a guess) and a row with elapsed time and
 *    no `node` item (the settlement reads no node as one node, which is a guess too; one word a row). A refusal names the path
 *    and a fixed word, never a value the sender wrote, and never a key the sender chose (`<key>`).
 *  - SKIPPED and COUNTED (`skipped` in the answer): a partition whose queue was not read (`jobs` is
 *    null: the observer says null, never zero, and so does this), and a row that is valid but that no
 *    table of ours can hold: a job id that is not one Slurm job (a pending array `123_[1-5]`, a list), a
 *    partition, state or elapsed time the observer could not read, or a value past a column's bound.
 *    Such a row is not a job NEMAR submitted as a single Slurm job, and one array on the account must
 *    not stop the rest of the day from settling.
 *  - NEVER: a mode is a dry run. The observer defines two modes, `quick` and `daily`; both are live
 *    observations, and the difference is only that `quick` has no `accounting`, so it stores queue
 *    snapshots and settles whatever earlier rows now can be.
 */

import {
  type ObservationDocument,
  parseAllocTres,
} from "../../../shared/contract/compute-observation.js";
import {
  OBSERVER_ROWS_MAX,
  type ObserverBody,
  ObserverSacctRowSchema,
  ObserverSnapshotSchema,
} from "./compute-observer.js";

export interface MappedObservation {
  body: ObserverBody;
  /** Partitions and accounting rows that were valid and were not stored, and why in the code above. */
  skipped: { partitions: number; jobs: number };
  /**
   * The export lost rows to the observer's 1 MiB bound. They are NOT on the next day's export: `sacct`
   * selects a day with `-S day -E day+1`, so a job that began and ended inside the cut day is on no later
   * export and stays at its provisional charge until an administrator moves it.
   */
  truncated: boolean;
}

export type MapResult = { ok: true; mapped: MappedObservation } | { ok: false; fields: string[] };

/** A fixed word per refusal: the field's path and one of these, never a value. */
export const OBSERVATION_REFUSALS = {
  tooManyRows: "too_big",
  malformedTres: "malformed_tres",
  missingCpu: "missing_cpu",
  missingNode: "missing_node",
} as const;

/**
 * The field names the document itself declares. A path segment that is one of these, or a position in a
 * list, is printed; every other segment is a KEY THE SENDER CHOSE (a partition, a node or job state, a
 * pending reason, an allocation item) and is printed as `<key>`, so a refusal never echoes text the
 * sender wrote.
 */
const DECLARED_FIELDS: ReadonlySet<string> = new Set([
  "schema",
  "mode",
  "observed_at",
  "observer_version",
  "sources",
  "partitions",
  "pending_starts",
  "balance",
  "job_ids_dropped",
  "accounting",
  "sinfo",
  "squeue",
  "squeue_start",
  "sacct",
  "status",
  "malformed_rows",
  "detail",
  "available",
  "nodes",
  "jobs",
  "pending_reasons",
  "cpus",
  "expanse",
  "expanse_gpu",
  "projects",
  "project",
  "used",
  "used_by_project",
  "raw_lines",
  "day",
  "rows_total",
  "rows_included",
  "truncated",
  "partition",
  "job_id",
  "state",
  "expected_start",
  "elapsed_seconds",
  "alloc_tres",
  "submit",
  "start",
  "end",
]);

/** The cap on the paths a refusal lists. */
export const OBSERVATION_FIELDS_MAX = 5;

/** Whether `path[i]` is a key the sender chose: a record's key, by where records are in the document. */
function isSenderKey(path: ReadonlyArray<string | number>, i: number): boolean {
  if (path[0] === "partitions") {
    // partitions.<name>.<jobs|nodes|pending_reasons>.<state or reason>
    return i === 1 || (i === 3 && ["jobs", "nodes", "pending_reasons"].includes(String(path[2])));
  }
  // accounting.jobs.<n>.alloc_tres.<item>
  return path[0] === "accounting" && path[1] === "jobs" && path[3] === "alloc_tres" && i === 4;
}

/** `path: code` for the first issues of a failed parse, with every sender-chosen key replaced by `<key>`. */
export function observationIssueFields(
  issues: ReadonlyArray<{ path: ReadonlyArray<string | number>; code: string }>,
): string[] {
  return issues.slice(0, OBSERVATION_FIELDS_MAX).map((issue) => {
    const path = issue.path
      .map((segment, i) => {
        if (typeof segment === "number") return String(segment);
        return DECLARED_FIELDS.has(segment) && !isSenderKey(issue.path, i) ? segment : "<key>";
      })
      .join(".");
    return `${path || "body"}: ${issue.code}`;
  });
}

export function mapObservation(doc: ObservationDocument): MapResult {
  const partitions = Object.entries(doc.partitions);
  const accounting = doc.mode === "daily" ? doc.accounting : null;
  const jobs = accounting?.jobs ?? [];
  if (partitions.length + jobs.length > OBSERVER_ROWS_MAX) {
    return { ok: false, fields: [`body: ${OBSERVATION_REFUSALS.tooManyRows}`] };
  }

  const body: ObserverBody = { snapshots: [], sacct: [] };
  const skipped = { partitions: 0, jobs: 0 };

  for (const [name, partition] of partitions) {
    if (partition.jobs === null) {
      skipped.partitions++;
      continue;
    }
    const snapshot = ObserverSnapshotSchema.safeParse({
      partition: name,
      pending: partition.jobs.PENDING?.jobs ?? 0,
      running: partition.jobs.RUNNING?.jobs ?? 0,
    });
    if (snapshot.success) body.snapshots.push(snapshot.data);
    else skipped.partitions++;
  }

  const refused: string[] = [];
  jobs.forEach((job, index) => {
    const where = `accounting.jobs.${index}.alloc_tres`;
    if (job.partition === null || job.state === null || job.elapsed_seconds === null) {
      skipped.jobs++;
      return;
    }
    // The identity first: a row that is not one Slurm job of ours is skipped before its allocation is read.
    const identity = ObserverSacctRowSchema.safeParse({
      slurm_job_id: job.job_id,
      partition: job.partition,
      state: job.state,
      elapsed_seconds: job.elapsed_seconds,
      alloc_nodes: 0,
      alloc_cpus: 0,
      alloc_gpus: 0,
      alloc_mem_mb: 0,
    });
    if (!identity.success) {
      skipped.jobs++;
      return;
    }
    const tres = parseAllocTres(job.alloc_tres);
    if (!tres.ok) {
      refused.push(`${where}: ${OBSERVATION_REFUSALS.malformedTres}`);
      return;
    }
    const { nodes, cpus, gpus, memMb } = tres.value;
    if (cpus === null && job.elapsed_seconds > 0) {
      refused.push(`${where}: ${OBSERVATION_REFUSALS.missingCpu}`);
      return;
    }
    // The settlement prices per node and reads a node count of 0 as one, so an allocation that ran with
    // no `node` item would be priced as one node: a guess. One word per row, the first that applies.
    if (nodes === null && job.elapsed_seconds > 0) {
      refused.push(`${where}: ${OBSERVATION_REFUSALS.missingNode}`);
      return;
    }
    body.sacct.push({
      ...identity.data,
      alloc_nodes: nodes ?? 0,
      alloc_cpus: cpus ?? 0,
      alloc_gpus: gpus ?? 0,
      alloc_mem_mb: memMb ?? 0,
      submit_time: job.submit,
      start_time: job.start,
      end_time: job.end,
      charged_milli: null,
    });
  });
  if (refused.length > 0) return { ok: false, fields: refused.slice(0, OBSERVATION_FIELDS_MAX) };

  return { ok: true, mapped: { body, skipped, truncated: accounting?.truncated === true } };
}
