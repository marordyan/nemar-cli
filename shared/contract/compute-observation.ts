/**
 * The observation document `nemar.observation.v1` and the reading of Slurm's allocation string (epic
 * #2005 phase A7, #2012; ADR 0118, decision 8).
 *
 * THE DOCUMENT IS THE OBSERVER'S, NOT THE WORKER'S. The queue observer (`observer/observe.py` in
 * `nemarOrg/nemar-process`) posts one JSON document per run, and the Worker adopted it as it is (owner
 * decision of 2026-11-06): nothing here describes a shape the observer does not write. The JSON Schema
 * next to this file, `compute-observation.schema.json`, is SHARED BYTE FOR BYTE with nemar-process
 * (`observer/schema/observation-v1.schema.json`); the observer cannot import this file, so the schema is
 * the contract both sides check against. `test/compute-observation-contract.unit.test.ts` holds the zod
 * schema below to the JSON Schema on a corpus of valid and invalid documents, and compares the bytes
 * with nemar-process's copy when a checkout is named. Change the schema in nemar-cli, never in one
 * copy.
 *
 * STRICT ON PURPOSE. Like `./compute-launch.ts`, this document arrives from a sender the Worker does
 * not control and every object the observer writes is closed: an unknown key is a refusal, not
 * something to strip. It is exempted by name in `test/contract-schemas.test.ts`, and no released CLI
 * parses it. The regular expressions end in `(?![\s\S])` and not `$`, so every engine agrees on a
 * trailing newline.
 *
 * WHAT THE SCHEMA CANNOT STATE is the Worker's to check: the 5,000-row bound on partitions and
 * accounting jobs together.
 *
 * `parseAllocTres` is the one place Slurm's allocation text is read. The document carries it as the
 * observer split it (item name to value text); this reads `cpu`, `mem`, `node` and `gres/gpu` and
 * FAILS CLOSED on a value it does not recognize: a figure it had to guess at would be a charge to a
 * person's pool.
 */

import { z } from "zod";

export const OBSERVATION_SCHEMA = "nemar.observation.v1";
export const OBSERVATION_MODES = ["quick", "daily"] as const;
export type ObservationMode = (typeof OBSERVATION_MODES)[number];

const count = z.number().int().min(0).max(999_999_999_999);

const PARTITION_KEY_RE = /^[A-Za-z0-9_.,-]{1,128}(?![\s\S])/;
const TIME_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?![\s\S])/;
const WORD_RE = /^[a-z0-9_]{1,64}(?![\s\S])/;

const time = z.string().regex(TIME_RE).nullable();

/** `.max(n)` on the number of keys of an object: the JSON Schema's `maxProperties`. */
const maxKeys = (n: number) => (o: Record<string, unknown>) => Object.keys(o).length <= n;

const SourceSchema = z.union([
  z.object({ status: z.enum(["ok", "unparsed"]), malformed_rows: count }).strict(),
  z
    .object({
      status: z.enum(["not_found", "timeout", "failed", "error", "skipped"]),
      detail: z.string().regex(WORD_RE).optional(),
    })
    .strict(),
]);

const JobTotalsSchema = z.object({ jobs: count, nodes: count, cpus: count }).strict();

const PartitionSchema = z
  .object({
    available: z.string().min(1).max(32).nullable(),
    nodes: z.record(z.string().regex(/^[a-z_]{1,32}(?![\s\S])/), count).nullable(),
    jobs: z.record(z.string().regex(/^[A-Z_]{1,32}(?![\s\S])/), JobTotalsSchema).nullable(),
    pending_reasons: z.record(z.string().regex(/^[A-Za-z0-9_]{1,64}(?![\s\S])/), count).nullable(),
  })
  .strict();

const PendingStartSchema = z
  .object({
    job_id: z.string().regex(/^[0-9]{1,12}(?![\s\S])/),
    partition: z.string().regex(PARTITION_KEY_RE),
    state: z.string().max(32),
    expected_start: time,
  })
  .strict();

const BalanceSchema = z.union([
  z
    .object({
      status: z.literal("parsed"),
      projects: z
        .array(
          z
            .object({
              project: z.string().regex(/^[A-Za-z0-9_-]{1,32}(?![\s\S])/),
              used: count,
              available: count,
              used_by_project: count,
            })
            .strict(),
        )
        .max(1000),
    })
    .strict(),
  z
    .object({
      status: z.literal("unparsed"),
      raw_lines: z.array(z.string().max(200)).max(50),
    })
    .strict(),
  z.object({ status: z.literal("unavailable"), detail: z.string().regex(WORD_RE) }).strict(),
]);

const AccountingJobSchema = z
  .object({
    job_id: z.string().regex(/^[0-9][0-9_+[\],%-]{0,63}(?![\s\S])/),
    partition: z.string().regex(PARTITION_KEY_RE).nullable(),
    state: z
      .string()
      .regex(/^[A-Za-z_]{1,32}(?![\s\S])/)
      .nullable(),
    elapsed_seconds: z.number().int().min(0).nullable(),
    alloc_tres: z
      .record(z.string().max(64), z.string().max(64))
      .refine(maxKeys(32), { message: "at most 32 items" }),
    submit: time,
    start: time,
    end: time,
  })
  .strict();

const AccountingSchema = z
  .object({
    day: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}(?![\s\S])/),
    rows_total: count,
    rows_included: count,
    truncated: z.boolean(),
    jobs: z.array(AccountingJobSchema).max(5000),
  })
  .strict();

const quickSources = z
  .object({ sinfo: SourceSchema, squeue: SourceSchema, squeue_start: SourceSchema })
  .strict();
const dailySources = z
  .object({
    sinfo: SourceSchema,
    squeue: SourceSchema,
    squeue_start: SourceSchema,
    sacct: SourceSchema,
  })
  .strict();

const shared = {
  schema: z.literal(OBSERVATION_SCHEMA),
  observed_at: z
    .string()
    .regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z(?![\s\S])/),
  observer_version: z
    .string()
    .max(32)
    .regex(/^[0-9A-Za-z][0-9A-Za-z.+-]*(?![\s\S])/),
  partitions: z
    .record(z.string().regex(PARTITION_KEY_RE), PartitionSchema)
    .refine(maxKeys(5000), { message: "at most 5000 partitions" }),
  pending_starts: z.array(PendingStartSchema).max(5000).nullable(),
  balance: z.object({ expanse: BalanceSchema, expanse_gpu: BalanceSchema }).strict(),
  job_ids_dropped: z.number().int().min(1).optional(),
};

/** A quick document has no `accounting` and no `sources.sacct`; a daily one has both (null when sacct was not read). */
export const ObservationDocumentSchema = z.discriminatedUnion("mode", [
  z.object({ ...shared, mode: z.literal("quick"), sources: quickSources }).strict(),
  z
    .object({
      ...shared,
      mode: z.literal("daily"),
      sources: dailySources,
      accounting: AccountingSchema.nullable(),
    })
    .strict(),
]);

export type ObservationDocument = z.infer<typeof ObservationDocumentSchema>;
export type ObservationAccountingJob = z.infer<typeof AccountingJobSchema>;

// --- Slurm's allocation text ---------------------------------------------------------------------------------

/**
 * The upper bound of each numeric column of `compute_sacct_rows` (migration 0118, the CHECK of each
 * column; the Worker's row schema in `services/compute-observer.ts` takes these same numbers). An
 * allocation figure past one would make the D1 insert throw after the run was spent, so the reader below
 * refuses it first. `test/compute-observer.test.ts` reads the migration and holds the two equal.
 */
export const SACCT_COLUMN_MAX = {
  elapsedSeconds: 31_536_000,
  nodes: 100_000,
  cpus: 10_000_000,
  gpus: 1_000_000,
  memMb: 1_000_000_000,
} as const;

/** What an allocation figure may be: the column bounds above, and nothing else. */
export const TRES_MAX = {
  nodes: SACCT_COLUMN_MAX.nodes,
  cpus: SACCT_COLUMN_MAX.cpus,
  gpus: SACCT_COLUMN_MAX.gpus,
  memMb: SACCT_COLUMN_MAX.memMb,
} as const;

/** What `parseAllocTres` read; `null` is an item that is not there (never zero). Memory is in MB. */
export interface AllocTres {
  nodes: number | null;
  cpus: number | null;
  gpus: number | null;
  memMb: number | null;
}

/** The item whose value could not be read: a fixed word, never the text the sender wrote. */
export type TresItem = "node" | "cpu" | "gpu" | "mem";

export type TresResult = { ok: true; value: AllocTres } | { ok: false; item: TresItem };

const WHOLE_RE = /^(?:0|[1-9][0-9]{0,11})(?![\s\S])/;
const MEM_RE = /^(0|[1-9][0-9]{0,11})(?:\.([0-9]{1,3}))?([KMGTP])?(?![\s\S])/;
/** Binary multiples of a megabyte as numerator over denominator: Slurm's K, M, G, T and P are powers of 1024. */
const MEM_UNIT: Readonly<Record<string, readonly [bigint, bigint]>> = {
  K: [1n, 1024n],
  M: [1n, 1n],
  G: [1024n, 1n],
  T: [1_048_576n, 1n],
  P: [1_073_741_824n, 1n],
};

function wholeNumber(text: string, max: number): number | null {
  if (!WHOLE_RE.test(text)) return null;
  const n = Number(text);
  return n <= max ? n : null;
}

/** `16G` is 16,384 MB; a fraction (Slurm prints `1.50G`) rounds UP to a whole megabyte. A number with no unit is refused unless it is 0. */
function memoryMb(text: string): number | null {
  const found = MEM_RE.exec(text);
  if (!found) return null;
  const [, whole = "", fraction = "", unit] = found;
  if (unit === undefined) return whole === "0" && fraction === "" ? 0 : null;
  const [multiply, divide] = MEM_UNIT[unit] ?? [0n, 1n];
  const thousandths = BigInt(whole) * 1000n + BigInt(fraction.padEnd(3, "0") || "0");
  const denominator = 1000n * divide;
  const mb = (thousandths * multiply + denominator - 1n) / denominator;
  return mb <= BigInt(TRES_MAX.memMb) ? Number(mb) : null;
}

/**
 * Read `cpu`, `mem`, `node` and `gres/gpu` from the allocation items of one `sacct` row. Other items
 * (`billing`, `energy`, `fs/disk`, `gres/gpumem` and the rest) are not read. An item that is absent is
 * `null`; an item that is present and not a number of the shape Slurm prints is a failure, naming the
 * item, so the caller refuses the post and settles nothing. GPUs are `gres/gpu`; when only typed
 * entries are present (`gres/gpu:a100`) they are added up, and a typed entry beside the plain one is
 * the same GPUs counted again and is ignored.
 */
export function parseAllocTres(tres: Readonly<Record<string, string>>): TresResult {
  const own = (key: string): string | undefined =>
    Object.hasOwn(tres, key) ? tres[key] : undefined;
  const out: AllocTres = { nodes: null, cpus: null, gpus: null, memMb: null };

  const node = own("node");
  if (node !== undefined) {
    out.nodes = wholeNumber(node, TRES_MAX.nodes);
    if (out.nodes === null) return { ok: false, item: "node" };
  }
  const cpu = own("cpu");
  if (cpu !== undefined) {
    out.cpus = wholeNumber(cpu, TRES_MAX.cpus);
    if (out.cpus === null) return { ok: false, item: "cpu" };
  }
  const mem = own("mem");
  if (mem !== undefined) {
    out.memMb = memoryMb(mem);
    if (out.memMb === null) return { ok: false, item: "mem" };
  }
  const plain = own("gres/gpu");
  if (plain !== undefined) {
    out.gpus = wholeNumber(plain, TRES_MAX.gpus);
    if (out.gpus === null) return { ok: false, item: "gpu" };
  } else {
    let sum = 0;
    let typed = false;
    for (const [key, value] of Object.entries(tres)) {
      if (!key.startsWith("gres/gpu:")) continue;
      const n = wholeNumber(value, TRES_MAX.gpus);
      if (n === null) return { ok: false, item: "gpu" };
      sum += n;
      typed = true;
    }
    if (typed) {
      if (sum > TRES_MAX.gpus) return { ok: false, item: "gpu" };
      out.gpus = sum;
    }
  }
  return { ok: true, value: out };
}
