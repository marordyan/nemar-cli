/**
 * What an administrator reads about compute jobs, people and quarters, and the one thing an owner does
 * to an ACCESS report that failed (epic #2005 phase A7, #2012; ADR 0118; design section 9).
 *
 * Every view here is FIXED WORDS, NUMBERS AND TIMES. None carries identity: not a name, an email, an
 * ORCID iD, a country or an affiliation, none a specification, a token, an address or a log. A job's
 * account is its number, as `jobView` always showed it. The identity snapshot and a submitted file are
 * reached only through `readRecordObject` (owner-only, reasoned, audited), and the provenance and
 * manifest summaries below are read from the records bucket without them: the launcher's provenance
 * names an image digest, timings and dataset versions, and the manifest summary is a count and a size,
 * never a path.
 *
 *   `listJobRows`                 jobs by flag, state and account, newest first, keyset-paged
 *   `listUnmatchedSacct`          Expanse's rows that no job claims
 *   `resolveJobRef`               a NEMAR job id, a Tapis uuid or a Slurm id, in that order
 *   `recordSummary`               one job: the index row, its ledger entries, provenance, manifest
 *   `accountReport`               one account's jobs and charge in a date range
 *   `accessReport`                distinct gateway users and jobs by partition and source in a quarter
 *   `listAccessReportFailures`    `failed` ACCESS report rows, counted by their fixed word
 *   `listAccessReports`           those rows, listed
 *   `requeueAccessReport`         OWNER-ONLY: put a `failed` row back to `pending`, on the owner's
 *                                 explicit word that ACCESS did NOT record it
 */

import {
  COMPUTE_JOB_FLAGS,
  COMPUTE_STATES,
  type ComputeJobFlag,
  type ComputeState,
} from "../../../shared/compute-state.js";
import type { ComputeRecordStatus } from "../../../shared/contract/compute-admin.js";
import { COMPUTE_JOB_ID_RE } from "../../../shared/contract/compute.js";
import { LAUNCHER_FILES, RECORDS_RESULT_MANIFEST_FILE } from "../../../shared/contract/compute.js";
import type { Bindings } from "../types/bindings.js";
import { ACTIVE_ACCOUNT_STATUS_SQL_LIST } from "./account-tier.js";
import { FLAG_COLUMN, type FlagColumns, flagsOf } from "./compute-job-flags.js";
import { type ComputeJobRow, getJob } from "./compute-jobs.js";
import { ACTIVE_OWNER_SQL, heldSql } from "./compute-legal-holds.js";
import { jobView } from "./compute-lifecycle.js";
import { recordKey } from "./compute-records.js";

/** The most rows a list answers with at once. */
export const REPORT_PAGE_MAX = 200;
/** The most jobs one account report carries; the rest is `truncated`. */
export const ACCOUNT_REPORT_ROWS_MAX = 5000;

// --- Jobs -----------------------------------------------------------------------------------------------

export interface JobListQuery {
  flag?: ComputeJobFlag;
  state?: ComputeState;
  account?: number;
  limit: number;
  /** The `seq` of the last job of the previous page. */
  after?: number;
}

/**
 * A page of jobs, newest first, with the keyset `next_after` (the oldest row's `seq`, its rowid) or null
 * at the end. Every filter is a column test with a bound value; the flag's column comes from a fixed map.
 */
export async function listJobRows(
  db: D1Database,
  q: JobListQuery,
): Promise<{ jobs: ComputeJobRow[]; next_after: number | null }> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (q.flag !== undefined) {
    if (!(COMPUTE_JOB_FLAGS as readonly string[]).includes(q.flag))
      throw new RangeError("not a flag");
    where.push(`${FLAG_COLUMN[q.flag]} = 1`);
  }
  if (q.state !== undefined) {
    if (!(COMPUTE_STATES as readonly string[]).includes(q.state))
      throw new RangeError("not a state");
    where.push("state = ?");
    binds.push(q.state);
  }
  if (q.account !== undefined) {
    where.push("account_id = ?");
    binds.push(q.account);
  }
  if (q.after !== undefined) {
    where.push("rowid < ?");
    binds.push(q.after);
  }
  const limit = Math.min(Math.max(1, Math.trunc(q.limit)), REPORT_PAGE_MAX);
  const rows = (
    await db
      .prepare(
        `SELECT rowid AS seq, * FROM compute_jobs ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY rowid DESC LIMIT ?`,
      )
      .bind(...binds, limit + 1)
      .all<ComputeJobRow & { seq: number }>()
  ).results;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    jobs: page,
    next_after: rows.length > limit && last !== undefined ? last.seq : null,
  };
}

export interface UnmatchedRow {
  slurm_job_id: string;
  partition: string;
  state: string;
  elapsed_seconds: number;
  alloc_nodes: number;
  alloc_cpus: number;
  alloc_gpus: number;
  charged_milli: number | null;
  ingested_at: string;
}

/** Expanse's rows that no job claims, newest first. */
export async function listUnmatchedSacct(
  db: D1Database,
  limit: number,
): Promise<{ rows: UnmatchedRow[]; total: number }> {
  const rows = (
    await db
      .prepare(
        `SELECT slurm_job_id, partition, state, elapsed_seconds, alloc_nodes, alloc_cpus, alloc_gpus,
                charged_milli, ingested_at
           FROM compute_sacct_rows WHERE matched_job_id IS NULL ORDER BY ingested_at DESC, slurm_job_id
          LIMIT ?`,
      )
      .bind(Math.min(Math.max(1, Math.trunc(limit)), REPORT_PAGE_MAX))
      .all<UnmatchedRow>()
  ).results;
  const total = await db
    .prepare("SELECT COUNT(*) AS n FROM compute_sacct_rows WHERE matched_job_id IS NULL")
    .first<{ n: number }>();
  return { rows, total: total?.n ?? 0 };
}

// --- One job, by any of its three names --------------------------------------------------------------------

/** The job a reference names: a NEMAR job id, else a Tapis job uuid, else a Slurm job id. Null when none. */
export async function resolveJobRef(db: D1Database, ref: string): Promise<ComputeJobRow | null> {
  if (typeof ref !== "string" || ref.length === 0 || ref.length > 128) return null;
  if (COMPUTE_JOB_ID_RE.test(ref)) return getJob(db, ref);
  const byUuid = await db
    .prepare("SELECT id FROM compute_jobs WHERE tapis_uuid = ?1")
    .bind(ref)
    .first<{ id: string }>();
  if (byUuid !== null) return getJob(db, byUuid.id);
  const bySlurm = await db
    .prepare("SELECT id FROM compute_jobs WHERE slurm_job_id = ?1 ORDER BY created_at DESC LIMIT 1")
    .bind(ref)
    .first<{ id: string }>();
  return bySlurm === null ? null : getJob(db, bySlurm.id);
}

/** The launcher's provenance, reduced to the fields that name no one. */
const PROVENANCE_FIELDS = [
  "launch_spec_digest",
  "bundle_digest",
  "image",
  "runtime_version",
  "timings",
  "slurm_job_id",
  "entry_exit_code",
] as const;

/** The most bytes of a record read for a summary. */
const SUMMARY_READ_MAX = 1024 * 1024;

async function readJsonRecord(
  env: Bindings,
  key: string,
): Promise<{ kind: "ok"; value: unknown } | { kind: "missing" } | { kind: "unreadable" }> {
  if (!env.COMPUTE_RECORDS) return { kind: "unreadable" };
  try {
    const object = await env.COMPUTE_RECORDS.get(key);
    if (object === null) return { kind: "missing" };
    if (object.size > SUMMARY_READ_MAX) return { kind: "unreadable" };
    return { kind: "ok", value: JSON.parse(await object.text()) };
  } catch {
    return { kind: "unreadable" };
  }
}

/** A record that was read but whose value is not the shape a summary needs is unreadable, not present. */
function statusOf(kind: ComputeRecordStatus, view: unknown): ComputeRecordStatus {
  return kind === "ok" && view === null ? "unreadable" : kind;
}

export interface LedgerLine {
  id: number;
  kind: string;
  pool_id: number;
  budget_pool_id: number | null;
  granted_delta_milli: number;
  held_delta_milli: number;
  charged_delta_milli: number;
  reason: string | null;
  created_at: string;
}

/** One job as an administrator reads it: the index row, its ledger entries, provenance, manifest summary. */
export async function recordSummary(env: Bindings, job: ComputeJobRow) {
  const ledger = (
    await env.DB.prepare(
      `SELECT id, kind, pool_id, budget_pool_id, granted_delta_milli, held_delta_milli,
              charged_delta_milli, reason, created_at
         FROM compute_ledger WHERE job_id = ?1 ORDER BY id`,
    )
      .bind(job.id)
      .all<LedgerLine>()
  ).results;
  const held = await env.DB.prepare(
    `SELECT CASE WHEN ${heldSql("j")} THEN 1 ELSE 0 END AS held FROM compute_jobs j WHERE j.id = ?1`,
  )
    .bind(job.id)
    .first<{ held: number }>();

  const provenance = await readJsonRecord(env, recordKey(job.id, "provenance.json"));
  const manifest = await readJsonRecord(env, recordKey(job.id, RECORDS_RESULT_MANIFEST_FILE));
  let provenanceView: Record<string, unknown> | null = null;
  if (
    provenance.kind === "ok" &&
    typeof provenance.value === "object" &&
    provenance.value !== null
  ) {
    const source = provenance.value as Record<string, unknown>;
    provenanceView = {};
    for (const field of PROVENANCE_FIELDS) {
      if (field in source) provenanceView[field] = source[field];
    }
  }
  let manifestView: { files: number; bytes: number } | null = null;
  if (manifest.kind === "ok" && typeof manifest.value === "object" && manifest.value !== null) {
    const files = (manifest.value as { files?: unknown }).files;
    if (Array.isArray(files)) {
      let bytes = 0;
      for (const f of files) {
        const size = (f as { size?: unknown } | null)?.size;
        if (typeof size === "number" && Number.isSafeInteger(size) && size >= 0) bytes += size;
      }
      manifestView = { files: files.length, bytes };
    }
  }
  return {
    job: jobView(job),
    identifiers: {
      tapis_uuid: job.tapis_uuid,
      slurm_job_id: job.slurm_job_id,
      app_id: job.app_id,
      app_version: job.app_version,
      image_digest: job.image_digest,
      spec_digest: job.spec_digest,
      launch_spec_digest: job.launch_spec_digest,
    },
    ledger,
    provenance: provenanceView,
    provenance_status: statusOf(provenance.kind, provenanceView),
    manifest: manifestView,
    manifest_status: statusOf(manifest.kind, manifestView),
    legal_hold: (held?.held ?? 0) === 1,
    retention_until: job.retention_until,
    // Every launcher file name, so a reader of the summary knows which records exist to be asked for.
    launcher_files: Object.values(LAUNCHER_FILES),
  };
}

// --- A person, a range ---------------------------------------------------------------------------------------

export interface AccountReport {
  account_id: number;
  from: string;
  to: string;
  /**
   * `charged_milli` is what is CHARGED so far. A job whose settlement has not been written still has
   * its hold open and charges 0, so `unsettled` counts those jobs and `open_hold_milli` is what they
   * still hold: the account has used at least `charged_milli` and may owe up to
   * `charged_milli + open_hold_milli`.
   */
  totals: { jobs: number; charged_milli: number; unsettled: number; open_hold_milli: number };
  by_pool: Record<
    string,
    { jobs: number; charged_milli: number; unsettled: number; open_hold_milli: number }
  >;
  jobs: Array<{
    id: string;
    created_at: string;
    ended_at: string | null;
    state: string;
    partition: string;
    pool: string;
    source: string;
    charged_milli: number;
    /** False while the job's hold is open: `charged_milli` is not its final figure yet. */
    settled: boolean;
    /** The hold the job still has open: 0 once it is settled (the hold was closed by the settlement). */
    open_hold_milli: number;
    flags: string[];
  }>;
  truncated: boolean;
}

/** An account's jobs created from `from` to the end of `to` (dates, `YYYY-MM-DD`), and what they cost. */
export async function accountReport(
  db: D1Database,
  input: { account: number; from: string; to: string },
): Promise<AccountReport> {
  const rows = (
    await db
      .prepare(
        `SELECT id, created_at, ended_at, state, partition, pool, source, charged_milli,
                held_milli, settled_provisional_at, flag_unreserved, flag_unattributed, flag_mismatch, flag_overrun
           FROM compute_jobs
          WHERE account_id = ?1 AND created_at >= ?2 AND created_at < date(?3, '+1 day')
          ORDER BY created_at ASC, id ASC LIMIT ?4`,
      )
      .bind(input.account, input.from, input.to, ACCOUNT_REPORT_ROWS_MAX + 1)
      .all<
        FlagColumns & {
          id: string;
          created_at: string;
          ended_at: string | null;
          state: string;
          partition: string;
          pool: string;
          source: string;
          charged_milli: number;
          held_milli: number;
          settled_provisional_at: string | null;
        }
      >()
  ).results;
  const truncated = rows.length > ACCOUNT_REPORT_ROWS_MAX;
  const page = rows.slice(0, ACCOUNT_REPORT_ROWS_MAX);
  const byPool: AccountReport["by_pool"] = {};
  const totals = { jobs: 0, charged_milli: 0, unsettled: 0, open_hold_milli: 0 };
  const jobs = page.map((r) => {
    const settled = r.settled_provisional_at !== null;
    const openHold = settled ? 0 : r.held_milli;
    const entry = byPool[r.pool] ?? { jobs: 0, charged_milli: 0, unsettled: 0, open_hold_milli: 0 };
    byPool[r.pool] = entry;
    for (const t of [entry, totals]) {
      t.jobs++;
      t.charged_milli += r.charged_milli;
      t.open_hold_milli += openHold;
      if (!settled) t.unsettled++;
    }
    return {
      id: r.id,
      created_at: r.created_at,
      ended_at: r.ended_at,
      state: r.state,
      partition: r.partition,
      pool: r.pool,
      source: r.source,
      charged_milli: r.charged_milli,
      settled,
      open_hold_milli: openHold,
      flags: flagsOf(r),
    };
  });
  return {
    account_id: input.account,
    from: input.from,
    to: input.to,
    totals,
    by_pool: byPool,
    jobs,
    truncated,
  };
}

// --- A quarter, for ACCESS ----------------------------------------------------------------------------------------

const QUARTER_RE = /^(\d{4})Q([1-4])$/;

/** `2026Q4` as its first day and the first day of the next quarter, or null. */
export function quarterBounds(quarter: string): { start: string; end: string } | null {
  const m = QUARTER_RE.exec(quarter);
  if (m === null) return null;
  const year = Number(m[1]);
  const q = Number(m[2]);
  const month = (q - 1) * 3 + 1;
  const pad = (n: number) => String(n).padStart(2, "0");
  const next = q === 4 ? { y: year + 1, m: 1 } : { y: year, m: month + 3 };
  return {
    start: `${year}-${pad(month)}-01 00:00:00`,
    end: `${next.y}-${pad(next.m)}-01 00:00:00`,
  };
}

export interface AccessReport {
  quarter: string;
  rows: Array<{ partition: string; source: string; distinct_users: number; jobs: number }>;
  totals: { distinct_users: number; jobs: number };
}

/**
 * For ACCESS, the jobs the scheduler took in the quarter: the distinct gateway users (pseudonyms,
 * counted and never listed) and the jobs, by partition and source. A job counts when it has a Slurm id
 * and its `remote_submitted_at` (the scheduler's own submission time, UTC) falls in the quarter, which
 * is exactly what the ACCESS reporter sends; `submitted_at` (NEMAR's bind to Tapis) is not used, so a
 * job Tapis accepted that never reached the scheduler is not counted, and one bound late on the last
 * day of a quarter and scheduled in the next belongs to the next. A job that skipped the reservation or
 * whose owner NEMAR could not attribute is excluded: it has no gateway user to report, and ACCESS is
 * not told of use NEMAR did not authorise as the person's. A person is counted once however many jobs.
 */
export async function accessReport(db: D1Database, quarter: string): Promise<AccessReport | null> {
  const bounds = quarterBounds(quarter);
  if (bounds === null) return null;
  const where = `slurm_job_id IS NOT NULL AND remote_submitted_at >= ?1 AND remote_submitted_at < ?2
      AND flag_unattributed = 0 AND flag_unreserved = 0 AND gateway_user IS NOT NULL`;
  const rows = (
    await db
      .prepare(
        `SELECT partition, source, COUNT(DISTINCT gateway_user) AS distinct_users, COUNT(*) AS jobs
           FROM compute_jobs WHERE ${where} GROUP BY partition, source ORDER BY partition, source`,
      )
      .bind(bounds.start, bounds.end)
      .all<{ partition: string; source: string; distinct_users: number; jobs: number }>()
  ).results;
  const totals = await db
    .prepare(
      `SELECT COUNT(DISTINCT gateway_user) AS distinct_users, COUNT(*) AS jobs
         FROM compute_jobs WHERE ${where}`,
    )
    .bind(bounds.start, bounds.end)
    .first<{ distinct_users: number; jobs: number }>();
  return {
    quarter,
    rows,
    totals: { distinct_users: totals?.distinct_users ?? 0, jobs: totals?.jobs ?? 0 },
  };
}

// --- ACCESS reports that failed ------------------------------------------------------------------------------------------

/** `failed` ACCESS report rows counted by their fixed word (`outcome_unknown`, `no_gateway_user`, ...). */
export async function listAccessReportFailures(db: D1Database): Promise<Record<string, number>> {
  const rows = (
    await db
      .prepare(
        `SELECT last_error_code AS word, COUNT(*) AS n FROM compute_access_reports
          WHERE state = 'failed' GROUP BY last_error_code ORDER BY last_error_code`,
      )
      .all<{ word: string; n: number }>()
  ).results;
  return Object.fromEntries(rows.map((r) => [r.word, r.n]));
}

export interface AccessReportRow {
  job_id: string;
  state: string;
  attempts: number;
  last_error_code: string | null;
  next_attempt_at: string;
  sent_at: string | null;
  created_at: string;
}

/** ACCESS report rows in one state, oldest first, keyset-paged by creation order. */
export async function listAccessReports(
  db: D1Database,
  input: { state: string; limit: number; after?: string },
): Promise<{ rows: AccessReportRow[]; counts: Record<string, number>; next_after: string | null }> {
  const limit = Math.min(Math.max(1, Math.trunc(input.limit)), REPORT_PAGE_MAX);
  const rows = (
    await db
      .prepare(
        `SELECT job_id, state, attempts, last_error_code, next_attempt_at, sent_at, created_at
           FROM compute_access_reports
          WHERE state = ?1 AND (?2 IS NULL OR job_id > ?2) ORDER BY job_id ASC LIMIT ?3`,
      )
      .bind(input.state, input.after ?? null, limit + 1)
      .all<AccessReportRow>()
  ).results;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const counts = await listAccessReportFailures(db);
  return {
    rows: page,
    counts,
    next_after: rows.length > limit && last !== undefined ? last.job_id : null,
  };
}

/**
 * Put a `failed` ACCESS report back to `pending`, due now, with its attempts cleared. OWNER-ONLY, and
 * only on the owner's explicit acknowledgement that the report is confirmed NOT recorded at ACCESS: an
 * unknown outcome is never sent again by code (a report may be lost, never doubled), so a person has
 * looked and says so. Audited in the same batch, with the word the row failed with. The role is read in
 * the statement itself.
 */
export const REQUEUE_ACCESS_REPORT_SQL = `UPDATE compute_access_reports SET
    state = 'pending', attempts = 0, next_attempt_at = datetime('now'), claimed_at = NULL,
    last_error_code = NULL
  WHERE job_id = ?1 AND state = 'failed'
    AND EXISTS (SELECT 1 FROM users u WHERE u.id = ?2 AND u.role = 'owner' AND u.deleted_at IS NULL
                  AND u.status IN ${ACTIVE_ACCOUNT_STATUS_SQL_LIST})`;

export const REQUEUE_AUDIT_ACTION = "compute.access_report.requeue";

export type RequeueResult =
  | { ok: true; previous: string | null }
  | { ok: false; code: "not_owner" | "report_not_found" };

export async function requeueAccessReport(
  db: D1Database,
  input: { jobId: string; ownerId: number },
): Promise<RequeueResult> {
  const before = await db
    .prepare("SELECT state, last_error_code FROM compute_access_reports WHERE job_id = ?1")
    .bind(input.jobId)
    .first<{ state: string; last_error_code: string | null }>();
  const results = await db.batch([
    db.prepare(REQUEUE_ACCESS_REPORT_SQL).bind(input.jobId, input.ownerId),
    db
      .prepare(
        `INSERT INTO audit_log (user_id, action, resource_type, resource_id, details)
         SELECT ?1, '${REQUEUE_AUDIT_ACTION}', 'compute_job', ?2, json_object('previous', ?3)
          WHERE changes() > 0`,
      )
      .bind(input.ownerId, input.jobId, before?.last_error_code ?? null),
  ]);
  if ((results[0]?.meta?.changes ?? 0) === 1) {
    return { ok: true, previous: before?.last_error_code ?? null };
  }
  const owner = await db.prepare(ACTIVE_OWNER_SQL).bind(input.ownerId).first();
  return { ok: false, code: owner === null ? "not_owner" : "report_not_found" };
}
