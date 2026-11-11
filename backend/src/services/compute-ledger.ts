/**
 * The compute gateway's allocation ledger (epic #2005 phase A2, #2007; ADR 0118, decision 3).
 *
 * A hold, a release, a settlement, a grant, an adjustment and an expiry, over the three
 * tables of migration 0114: `compute_pools` (a holder's running totals), `compute_ledger` (the
 * append-only entries) and the trigger that is the ONE writer of the totals. Amounts are whole
 * thousandths of a service unit (SU), never floating point.
 *
 * THE RULES, each one deliberate:
 *  - Nothing here writes a total. Every function inserts a ledger entry; the migration's AFTER
 *    INSERT trigger takes its deltas into the pool's row (and its held and charged deltas into the
 *    budget pool's), in the same statement. So the totals can never disagree with the ledger and
 *    "only if the entry was written" needs no second statement. A test reads every source file for a
 *    write of a total that is not the trigger's.
 *  - The table refuses what the statements here refuse. Its BEFORE INSERT triggers refuse an entry
 *    whose pool or budget totals would leave 0 to 2^53 - 1, a hold that would take available below 0,
 *    a hold, release, charge, overrun or final settlement on an account or partner pool that names no
 *    `people` budget, any entry whose budget is not the `people` budget of its pool's word, and a
 *    release or charge that does not close the hold it names, under every conflict clause. A
 *    correction of a charge may name the budget or none, and so may an entry of kind `refund` (the
 *    vocabulary keeps the kind and nothing here writes one): never crediting the budget back is this
 *    module's rule (the owner's option A, decided 2026-11-04) and not the table's. The statements
 *    below say the same as WHERE terms, so that a refusal writes nothing and raises nothing; a caller
 *    that skips them is refused by the table with an error.
 *  - THE `people` BUDGET RECORDS CONSUMPTION ONLY (option A, the owner's decision of 2026-11-04). It
 *    is the overall cap on everything people can spend, so what it counts is what was consumed, and
 *    nothing a person or an administrator does to a person's pool gives it back. There is no
 *    refund here (no failure is refunded automatically: a job that never started is RELEASED, which
 *    gives back a hold and consumed nothing, and compensation is a manual grant). A correction that
 *    lowers the charge of an account's or a partner's pool names NO budget (`adjustPool` refuses one
 *    that does), so the pool falls and the budget stays; one that raises it names the budget, so
 *    both rise. The only entry that names the budget and lowers its charged total is a job's FINAL
 *    settlement (`settleFinal`), because it corrects a figure that was recorded as consumption (the
 *    provisional charge was counted against the budget, and the true cost replaces it), and it can
 *    only take back what that job itself charged. The owner's own correction of a platform pool is
 *    the pool's own entry and names no budget.
 *  - A hold is ONE conditional INSERT (`HOLD_INSERT_SQL`): the pool not frozen, the pool's
 *    available at least the amount, the budget pool's available at least the amount, the key unused
 *    and any guard the caller adds, all in its WHERE. D1 runs a statement whole, so two holds for the
 *    last SU cannot both be written, and a refused hold writes nothing (ADR 0099; the claim of
 *    upstream-repull-dispatch.ts is the precedent). `meta.changes` is the winner test, and the
 *    reasons are read only after a refusal, to say which one. Freezing applies to the holder's own
 *    pool; a frozen budget pool does not refuse a hold.
 *  - A closing entry is one INSERT too, taken from the hold row itself (`RELEASE_INSERT_SQL`,
 *    `SETTLE_INSERT_SQL`): the HELD side and the release are the hold's, so a caller cannot misstate
 *    them, and the hold must be open in the same statement, so a hold closes once. The CHARGED
 *    figure of a settlement is the caller's, capped at the hold; what it used above the hold is an
 *    `overrun` entry written by the same statement.
 *  - The unique indexes are the backstop and the WHERE terms are the ordinary path. A statement that
 *    reached a hold that was already closed, or a step already taken, would be refused by
 *    `compute_ledger_closes_once` or by the unique key, and the caller reads that as closed; the
 *    `NOT EXISTS` terms make the ordinary refusal a statement that writes nothing and raises
 *    nothing, so the two layers answer alike.
 *  - Available is granted minus held minus charged and MAY BE NEGATIVE (an overrun, or an
 *    adjustment of the grant below what is used, is a fact that already happened). It is computed in
 *    Number arithmetic over totals that are checked to be safe integers, so it is exact within
 *    +-(2^53 - 1) and throws beyond; the SQL compares 64-bit integers. A stored total never is
 *    negative or beyond 2^53 - 1.
 *  - Arithmetic is integer. Every amount is checked to be a safe whole number before a statement is
 *    built (`ComputeLedgerError`, `invalid_argument`), so a fraction, NaN or a number a double
 *    cannot hold exactly never reaches SQL; the table refuses what slips past (`typeof`).
 *  - A retry is safe, and a key is never shared. Every entry has a unique key. The Worker's own keys
 *    are made of the job (`job:<id>:hold`, `:final`) or the hold (`hold:<id>:charge`), so
 *    no caller builds a colliding one (a caller's key may not start with `job:` or `hold:`); a grant,
 *    an adjustment and an expiry take the caller's, which an administrator's route scopes to the
 *    actor (`adminKey`). A key that finds its entry returns it only if the request is the same on
 *    EVERY field (kind, pool, budget, amounts, job and reason), and a key reused for anything else is
 *    a conflict.
 *  - A closing step is replayed: the closing entry comes back with `replayed: true` when it is of the
 *    requested kind, and `hold_closed` says which kind closed the hold otherwise. A hold is replayed
 *    only while it is open: the same hold asked for again after it was released or settled is
 *    `hold_closed` too, because a replay would tell the caller a hold is live that its pool no
 *    longer holds.
 *  - Nothing here mails, calls GitHub or Tapis, or is a cron. The job table and the job-count
 *    guards on a hold are phase A3's: `placeHold` takes a caller's own guards and writes nothing.
 */

import {
  type COMPUTE_LEDGER_REASONS,
  COMPUTE_WORD_RE,
  type ComputeRefusalCode,
  type LedgerEntryKind,
} from "../../../shared/compute-state.js";
import {
  type COMPUTE_PLATFORM_KEYS,
  COMPUTE_POOL_HOLDER_KINDS,
  type ComputePoolHolderKind,
} from "../../../shared/contract/compute-admin.js";
import {
  COMPUTE_JOB_ID_RE,
  COMPUTE_POOLS,
  type ComputePool,
} from "../../../shared/contract/compute.js";

/** A ledger key: 1 to 128 letters, digits and `. _ : -`, which is what the table accepts. */
export const LEDGER_KEY_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/** The keys the ledger writes of itself start with these, so a caller's key may not. */
const RESERVED_KEY_RE = /^(job|hold):/;

/** The largest a stored total may be: what a double holds exactly, and what the table allows. */
const TOTAL_MAX = Number.MAX_SAFE_INTEGER;

/** A pool's holder, as the table's CHECK takes it. */
const HOLDER_REF_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const ACCOUNT_REF_RE = /^[1-9][0-9]*$/;

/** The reasons the service writes when its caller names none, from the one list of them. */
const REASON = {
  grant: "grant",
  released: "released",
  expired: "expired",
  final: "final_settlement",
  unreserved: "unreserved_usage",
} as const satisfies Record<string, (typeof COMPUTE_LEDGER_REASONS)[number]>;

export interface PoolRow {
  id: number;
  holder_kind: ComputePoolHolderKind;
  holder_ref: string;
  pool: ComputePool;
  granted_milli: number;
  held_milli: number;
  charged_milli: number;
  frozen: number;
  created_at: string;
  updated_at: string;
}

export interface LedgerRow {
  id: number;
  kind: LedgerEntryKind;
  pool_id: number;
  budget_pool_id: number | null;
  granted_delta_milli: number;
  held_delta_milli: number;
  charged_delta_milli: number;
  job_id: string | null;
  hold_ref: number | null;
  reason: string | null;
  actor_user_id: number | null;
  idempotency_key: string;
  created_at: string;
}

export type LedgerErrorCode = "invalid_argument" | "idempotency_conflict" | "pool_not_found";

/**
 * A request the ledger cannot answer with a result: an argument that is not what the table takes
 * (a programming error, never a refusal), a key reused for something else, or a pool that is not
 * there. Nothing has been written when one is thrown.
 */
export class ComputeLedgerError extends Error {
  constructor(
    readonly code: LedgerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ComputeLedgerError";
  }
}

const invalid = (message: string): never => {
  throw new ComputeLedgerError("invalid_argument", message);
};

// --- The keys the ledger writes ---------------------------------------------------------------

/** A job's hold: a job has one, so its key is the job's, and no caller picks one. */
export const holdKey = (jobId: string): string => `job:${jobId}:hold`;

/** A job's final settlement, once. */
export const finalKey = (jobId: string): string => `job:${jobId}:final`;

/**
 * An administrator's key as the ledger stores it: behind the kind of entry and the actor, so two
 * administrators sending the same key each make their own entry, and no key an administrator sends
 * is one the ledger writes. 8 to 100 characters of header, an actor id of at most 16 digits and the
 * two separators fit the table's 128.
 */
export function adminKey(kind: "grant" | "adjust", actorId: number, key: string): string {
  return `${kind}:${positiveId("an actor", actorId)}:${key}`;
}

// --- Arguments -------------------------------------------------------------------------------

/** A whole number of milli-SU from `min` to the largest a double holds exactly. */
function amount(name: string, value: unknown, min: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) {
    return invalid(`${name} is a whole number of milli-SU, at least ${min}`);
  }
  return value;
}

/** A nonzero whole number, either sign, within what a double holds exactly. */
function signedAmount(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value === 0) {
    return invalid(`${name} is a whole number of milli-SU and not 0`);
  }
  return value;
}

function positiveId(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    return invalid(`${name} is a positive whole number`);
  }
  return value;
}

function jobIdArg(value: unknown): string {
  if (typeof value !== "string" || !COMPUTE_JOB_ID_RE.test(value)) {
    return invalid("a job id is job_ and 24 lowercase hex digits");
  }
  return value;
}

/** A key a caller chose: the table's shape, and not one the ledger writes of itself. */
function keyArg(value: unknown): string {
  if (typeof value !== "string" || !LEDGER_KEY_RE.test(value)) {
    return invalid("an idempotency key is 1 to 128 letters, digits and . _ : -");
  }
  if (RESERVED_KEY_RE.test(value)) {
    return invalid("an idempotency key may not start with job: or hold:, which the ledger writes");
  }
  return value;
}

function reasonArg(value: unknown, fallback: string | null): string | null {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || !COMPUTE_WORD_RE.test(value)) {
    return invalid("a reason is a fixed word of lowercase letters, digits and _");
  }
  return value;
}

function actorArg(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  return positiveId("an actor", value);
}

// --- Available -------------------------------------------------------------------------------

/**
 * What a pool may still take: granted minus held minus charged. It MAY BE NEGATIVE (an overrun
 * happened, or a grant was adjusted below what is used). Each total is checked to be a whole
 * number a double holds exactly (the table never stores another), so each subtraction is exact
 * while its result is within 2^53, and a result beyond the safe range, which rounding could not
 * bring back inside it, throws.
 */
export function availableMilli(
  row: Pick<PoolRow, "granted_milli" | "held_milli" | "charged_milli">,
): number {
  for (const total of [row.granted_milli, row.held_milli, row.charged_milli]) {
    if (!Number.isSafeInteger(total)) throw new RangeError("a pool's total is a whole number");
  }
  const value = row.granted_milli - row.held_milli - row.charged_milli;
  if (!Number.isSafeInteger(value)) {
    throw new RangeError("available is beyond what a double holds exactly");
  }
  return value;
}

// --- Pools -----------------------------------------------------------------------------------

const POOL_COLUMNS =
  "id, holder_kind, holder_ref, pool, granted_milli, held_milli, charged_milli, frozen, created_at, updated_at";

export const POOL_BY_ID_SQL = `SELECT ${POOL_COLUMNS} FROM compute_pools WHERE id = ?1`;

export const POOL_BY_HOLDER_SQL = `SELECT ${POOL_COLUMNS} FROM compute_pools
  WHERE holder_kind = ?1 AND holder_ref = ?2 AND pool = ?3`;

/**
 * A pool of a holder, once. The unique key makes it idempotent, and the insert names no total: a
 * new pool starts at zero and only the ledger moves it.
 */
export const ENSURE_POOL_SQL = `INSERT INTO compute_pools (holder_kind, holder_ref, pool)
  VALUES (?1, ?2, ?3)
  ON CONFLICT (holder_kind, holder_ref, pool) DO NOTHING`;

export async function getPool(db: D1Database, id: number): Promise<PoolRow | null> {
  return db.prepare(POOL_BY_ID_SQL).bind(id).first<PoolRow>();
}

/**
 * The pool of a holder, made if it is not there (an idempotent insert). Phase A3 and #2012 use it
 * for a person's and a partner's pools; the platform's four are seeded by the migration.
 */
export async function ensurePool(
  db: D1Database,
  holderKind: ComputePoolHolderKind,
  holderRef: string,
  pool: ComputePool,
): Promise<PoolRow> {
  if (!(COMPUTE_POOL_HOLDER_KINDS as readonly string[]).includes(holderKind)) {
    return invalid("a pool's holder is an account, the platform or a partner");
  }
  if (!(COMPUTE_POOLS as readonly string[]).includes(pool)) {
    return invalid("a pool is cpu or gpu");
  }
  if (
    typeof holderRef !== "string" ||
    !HOLDER_REF_RE.test(holderRef) ||
    (holderKind === "account" && !ACCOUNT_REF_RE.test(holderRef))
  ) {
    return invalid("a pool's holder reference is not one the table takes");
  }
  await db.prepare(ENSURE_POOL_SQL).bind(holderKind, holderRef, pool).run();
  const row = await db
    .prepare(POOL_BY_HOLDER_SQL)
    .bind(holderKind, holderRef, pool)
    .first<PoolRow>();
  if (!row) throw new Error("a pool that was just ensured could not be read");
  return row;
}

// --- Entries ---------------------------------------------------------------------------------

const ENTRY_COLUMNS = `id, kind, pool_id, budget_pool_id, granted_delta_milli, held_delta_milli,
  charged_delta_milli, job_id, hold_ref, reason, actor_user_id, idempotency_key, created_at`;

export const ENTRY_BY_KEY_SQL = `SELECT ${ENTRY_COLUMNS} FROM compute_ledger WHERE idempotency_key = ?1`;

/** The entry that holds a key, or null. */
export async function findEntryByKey(db: D1Database, key: string): Promise<LedgerRow | null> {
  return db.prepare(ENTRY_BY_KEY_SQL).bind(key).first<LedgerRow>();
}

/** What a request says it is, field by field; a stored entry must agree on every one named. */
type RequestFields = Partial<
  Pick<
    LedgerRow,
    | "kind"
    | "pool_id"
    | "budget_pool_id"
    | "granted_delta_milli"
    | "held_delta_milli"
    | "charged_delta_milli"
    | "job_id"
    | "reason"
  >
>;

/**
 * The entry a key found, as a replay, if the request is the same on every field it names; the key
 * reused for anything else throws `idempotency_conflict`. The one copy of that rule.
 */
function replayOrConflict(
  entry: LedgerRow,
  request: RequestFields,
): { ok: true; replayed: true; entry: LedgerRow } {
  for (const [field, value] of Object.entries(request) as Array<[keyof RequestFields, unknown]>) {
    if (entry[field] !== value) {
      throw new ComputeLedgerError(
        "idempotency_conflict",
        "that idempotency key was used for a different request",
      );
    }
  }
  return { ok: true, replayed: true, entry };
}

/** The audit row an administrator's entry leaves, written only if the entry before it was. */
export const AUDIT_LEDGER_ENTRY_SQL = `INSERT INTO audit_log (user_id, action, resource_type, resource_id, details)
  SELECT ?1, ?2, 'compute_pool', CAST(l.pool_id AS TEXT),
         json_object('entry_id', l.id, 'kind', l.kind, 'holder_kind', p.holder_kind,
                     'holder_ref', p.holder_ref, 'pool', p.pool,
                     'granted_delta_milli', l.granted_delta_milli,
                     'charged_delta_milli', l.charged_delta_milli, 'reason', l.reason)
    FROM compute_ledger l JOIN compute_pools p ON p.id = l.pool_id
   WHERE l.id = last_insert_rowid() AND changes() > 0`;

/** The audit row to write in the same batch as an entry: who, and the action word. */
export interface LedgerAudit {
  userId: number | null;
  action: string;
}

const looksUnique = (err: unknown) => /UNIQUE constraint failed/i.test(String(err));

/** Run a statement that may meet a unique index (a step taken twice): the rows it wrote, 0 if it did. */
async function runOrZero(statement: D1PreparedStatement): Promise<number> {
  try {
    return (await statement.run()).meta?.changes ?? 0;
  } catch (err) {
    if (looksUnique(err)) return 0;
    throw err;
  }
}

/** Run an entry's INSERT, with its audit row in the same batch when there is one; the rows it wrote. */
async function writeEntry(
  db: D1Database,
  insert: D1PreparedStatement,
  audit?: LedgerAudit,
): Promise<number> {
  if (audit) {
    const results = await db.batch([
      insert,
      db.prepare(AUDIT_LEDGER_ENTRY_SQL).bind(audit.userId, audit.action),
    ]);
    return results[0]?.meta?.changes ?? 0;
  }
  return runOrZero(insert);
}

// --- Hold ------------------------------------------------------------------------------------

/**
 * A guard of the caller's, ANDed into a hold's WHERE: a boolean SQL expression with plain `?`
 * placeholders and the values to bind to them. It runs in the same statement as the hold, so a
 * limit it expresses (a person's live jobs) holds under a race as the balance does.
 */
export interface HoldGuard {
  sql: string;
  binds?: readonly unknown[];
}

export interface HoldInput {
  poolId: number;
  /** The platform `people` pool of the pool's word; null for the platform's own pool. */
  budgetPoolId: number | null;
  amountMilli: number;
  jobId: string;
  extraGuards?: readonly HoldGuard[];
}

/**
 * The hold, with no guard of the caller's. `?1` pool, `?2` budget pool (NULL for none), `?3` amount,
 * `?4` job, `?5` key (the job's, `holdKey`). One INSERT whose WHERE is every condition; it inserts a
 * row or none, and the trigger of migration 0114 takes the held amount into both pools in the same
 * statement.
 */
export const HOLD_INSERT_SQL = `INSERT INTO compute_ledger
  (kind, pool_id, budget_pool_id, held_delta_milli, job_id, idempotency_key)
  SELECT 'hold', p.id, ?2, ?3, ?4, ?5
    FROM compute_pools p
   WHERE p.id = ?1
     AND p.frozen = 0
     AND p.granted_milli - p.held_milli - p.charged_milli >= ?3
     AND (?2 IS NULL OR (SELECT b.granted_milli - b.held_milli - b.charged_milli
                           FROM compute_pools b WHERE b.id = ?2) >= ?3)
     AND NOT EXISTS (SELECT 1 FROM compute_ledger WHERE idempotency_key = ?5)`;

/** A guard's `?` placeholders numbered after the statement's own, and how many it takes. */
function numberedGuard(sql: string, from: number): { sql: string; count: number } {
  if (/\?\d|\?\?/.test(sql)) invalid("a hold guard uses plain ? placeholders");
  let n = from;
  const numbered = sql.replace(/\?/g, () => `?${n++}`);
  return { sql: numbered, count: n - from };
}

/**
 * The hold's statement, to run alone (`placeHold`) or in a batch with the caller's own, where a
 * statement after it that checks `changes()` happens only if the hold was written. An array so a
 * caller can spread it into a batch; today it holds the one INSERT.
 */
export function holdStatements(db: D1Database, input: HoldInput): D1PreparedStatement[] {
  const poolId = positiveId("a pool", input.poolId);
  const budget =
    input.budgetPoolId === null ? null : positiveId("a budget pool", input.budgetPoolId);
  const milli = amount("a hold", input.amountMilli, 1);
  const job = jobIdArg(input.jobId);
  let sql = HOLD_INSERT_SQL;
  const binds: unknown[] = [poolId, budget, milli, job, holdKey(job)];
  for (const guard of input.extraGuards ?? []) {
    const { sql: part, count } = numberedGuard(guard.sql, binds.length + 1);
    const values = guard.binds ?? [];
    if (values.length !== count) invalid("a hold guard binds one value for each ? it has");
    sql += `\n     AND (${part})`;
    binds.push(...values);
  }
  return [db.prepare(sql).bind(...binds)];
}

/** Why a hold was refused: three words of the gateway's own vocabulary and the caller's guard. */
export type HoldRefusal = Extract<
  ComputeRefusalCode,
  "insufficient_balance" | "suspended" | "platform_budget_exhausted" | "guard_refused"
>;

export type HoldResult =
  | { ok: true; replayed: boolean; entry: LedgerRow }
  | { ok: false; code: HoldRefusal }
  /** The job's hold was taken and has since been closed: its pool no longer holds it. */
  | Extract<CloseRefusal, { code: "hold_closed" }>;

/**
 * Take a hold, or say why not. One INSERT decides (`HOLD_INSERT_SQL`), and a refusal writes
 * nothing. On a refusal the pool and the budget are read to name the reason, in this order: a
 * frozen pool is `suspended`, a pool without the amount is `insufficient_balance`, a budget without
 * it is `platform_budget_exhausted`; a refusal none of those explains is the caller's own guard when
 * one was passed, and otherwise `insufficient_balance` (the balance moved between the refusal and
 * the read). The hold's key is the job's, so a hold of the same job again is a replay of the first
 * while the hold is open and the request is the same on every field, `idempotency_conflict` when
 * the request is not, and `hold_closed` (`closedBy` says which step) once the hold was released
 * or settled: that replay would say a hold is live that the pool no longer holds.
 */
export async function placeHold(db: D1Database, input: HoldInput): Promise<HoldResult> {
  const [insert] = holdStatements(db, input);
  const changes = await runOrZero(insert as D1PreparedStatement);
  const entry = await findEntryByKey(db, holdKey(input.jobId));
  if (changes > 0) {
    if (!entry) throw new Error("a hold that was just written could not be read");
    return { ok: true, replayed: false, entry };
  }
  if (entry) {
    const replay = replayOrConflict(entry, {
      kind: "hold",
      pool_id: input.poolId,
      budget_pool_id: input.budgetPoolId,
      held_delta_milli: input.amountMilli,
      job_id: input.jobId,
    });
    // A replay says the hold is live, so a hold that was released or settled is refused instead:
    // its pool no longer holds it, and a caller that took the replay for a hold would run a job
    // nothing is held for.
    const hold = await db.prepare(HOLD_OF_JOB_SQL).bind(input.jobId).first<HoldOfJob>();
    if (hold?.closed_by) {
      return {
        ok: false,
        code: "hold_closed",
        closedBy: hold.closed_by === "release" ? "released" : "settled",
      };
    }
    return replay;
  }

  return { ok: false, code: await holdRefusalReason(db, input) };
}

/**
 * Why a hold that was not written was refused, read from the pool and the budget AFTER the refusal:
 * a frozen pool is `suspended`, a pool without the amount is `insufficient_balance`, a budget without
 * it is `platform_budget_exhausted`; a refusal none of those explains is the caller's own guard when
 * one was passed, and otherwise `insufficient_balance` (the balance moved between the refusal and
 * the read). `placeHold` uses it, and so does a caller that ran the hold's statements in a batch of
 * its own (phase A3's job and hold, #2008) and saw `changes` of 0: it writes nothing and takes no
 * hold, so it can be asked after a batch that has already refused.
 */
export async function holdRefusalReason(
  db: D1Database,
  input: Pick<HoldInput, "poolId" | "budgetPoolId" | "amountMilli" | "extraGuards">,
): Promise<HoldRefusal> {
  const pool = await getPool(db, input.poolId);
  if (!pool) throw new ComputeLedgerError("pool_not_found", "no such pool");
  if (pool.frozen !== 0) return "suspended";
  if (availableMilli(pool) < input.amountMilli) return "insufficient_balance";
  if (input.budgetPoolId !== null) {
    const budget = await getPool(db, input.budgetPoolId);
    if (!budget) throw new ComputeLedgerError("pool_not_found", "no such budget pool");
    if (availableMilli(budget) < input.amountMilli) return "platform_budget_exhausted";
  }
  const guarded = (input.extraGuards?.length ?? 0) > 0;
  return guarded ? "guard_refused" : "insufficient_balance";
}

// --- Closing a hold --------------------------------------------------------------------------

/**
 * The job's hold, and which kind of entry closed it (`release` or `charge`), or null while it is
 * open. `compute_ledger_closes_once` is the index the closing lookup uses.
 */
export const HOLD_OF_JOB_SQL = `SELECT h.id AS id,
    (SELECT c.kind FROM compute_ledger c
      WHERE c.hold_ref = h.id AND c.kind IN ('release', 'charge')) AS closed_by
  FROM compute_ledger h WHERE h.kind = 'hold' AND h.job_id = ?1`;

interface HoldOfJob {
  id: number;
  closed_by: "release" | "charge" | null;
}

/** The entries that closed a job's hold: the release, or the charge and any overrun, in order. */
export const CLOSING_ENTRIES_SQL = `SELECT ${ENTRY_COLUMNS} FROM compute_ledger
  WHERE job_id = ?1 AND kind IN ('release', 'charge', 'overrun') ORDER BY id`;

/**
 * A release, taken from the open hold of the job: `?1` the job, `?2` the reason (or NULL). The
 * amount is the hold's, the key is the hold's (`hold:<id>:release`), and the hold must be open in
 * this statement: a hold that was closed, or never made, writes nothing.
 */
const RELEASE_INSERT_BASE = `INSERT INTO compute_ledger
  (kind, pool_id, budget_pool_id, held_delta_milli, job_id, hold_ref, reason, idempotency_key)
  SELECT 'release', h.pool_id, h.budget_pool_id, -h.held_delta_milli, h.job_id, h.id, ?2,
         'hold:' || h.id || ':release'
    FROM compute_ledger h
   WHERE h.kind = 'hold' AND h.job_id = ?1
     AND NOT EXISTS (SELECT 1 FROM compute_ledger c
                      WHERE c.hold_ref = h.id AND c.kind IN ('release', 'charge'))`;

/**
 * The release statement with a caller's gate ANDed into its WHERE (a boolean SQL expression with
 * plain `?` placeholders, numbered here after the statement's own `?1` and `?2`). Phase A5 gates a
 * release on the job row having just taken its terminal state, so the state change and the release
 * are one batch (`releaseStatements`). With no gate it is exactly `RELEASE_INSERT_SQL`.
 */
export function releaseInsertSql(gate?: string): string {
  if (gate === undefined) return RELEASE_INSERT_BASE;
  return `${RELEASE_INSERT_BASE}\n     AND (${numberedGuard(gate, 3).sql})`;
}

export const RELEASE_INSERT_SQL = releaseInsertSql();

const SETTLE_INSERT_HEAD = `INSERT INTO compute_ledger
  (kind, pool_id, budget_pool_id, held_delta_milli, charged_delta_milli, job_id, hold_ref,
   idempotency_key)`;

/**
 * A settlement, taken from the open hold of the job: `?1` the job, `?2` what the job used. One
 * INSERT of up to two rows: the `charge` (the hold leaves `held`, which is the hold's own amount;
 * what was used, at most the hold, enters `charged`, so the rest of the hold is released by it), and
 * an `overrun` for what was used above the hold. Both read the open hold in this statement, so a
 * hold settles once, and the two rows are written together or not at all. With a gate (see
 * `releaseInsertSql`) the gate is ANDed into BOTH of its WHEREs; with none it is exactly
 * `SETTLE_INSERT_SQL`.
 */
export function settleInsertSql(gate?: string): string {
  const and = gate === undefined ? "" : `\n     AND (${numberedGuard(gate, 3).sql})`;
  return `${SETTLE_INSERT_HEAD}
  SELECT 'charge', h.pool_id, h.budget_pool_id, -h.held_delta_milli,
         MIN(?2, h.held_delta_milli), h.job_id, h.id, 'hold:' || h.id || ':charge'
    FROM compute_ledger h
   WHERE h.kind = 'hold' AND h.job_id = ?1
     AND NOT EXISTS (SELECT 1 FROM compute_ledger c
                      WHERE c.hold_ref = h.id AND c.kind IN ('release', 'charge'))${and}
  UNION ALL
  SELECT 'overrun', h.pool_id, h.budget_pool_id, 0, ?2 - h.held_delta_milli, h.job_id, h.id,
         'hold:' || h.id || ':overrun'
    FROM compute_ledger h
   WHERE h.kind = 'hold' AND h.job_id = ?1 AND ?2 > h.held_delta_milli
     AND NOT EXISTS (SELECT 1 FROM compute_ledger c
                      WHERE c.hold_ref = h.id AND c.kind IN ('release', 'charge'))${and}`;
}

export const SETTLE_INSERT_SQL = settleInsertSql();

/**
 * The release of a job's whole hold as a statement for a batch of the caller's own, gated by `gate`
 * (a job that never started: nothing was consumed, so nothing is charged; this is a release and never
 * a refund). The gate's values are bound after `?1` the job and `?2` the reason.
 */
export function releaseStatements(
  db: D1Database,
  input: { jobId: string; reason?: string },
  gate?: HoldGuard,
): D1PreparedStatement[] {
  const job = jobIdArg(input.jobId);
  const reason = reasonArg(input.reason, REASON.released);
  const values = gate?.binds ?? [];
  if (gate !== undefined && values.length !== numberedGuard(gate.sql, 3).count) {
    invalid("a gate binds one value for each ? it has");
  }
  return [db.prepare(releaseInsertSql(gate?.sql)).bind(job, reason, ...values)];
}

/** The settlement of a job's hold as a statement for a batch of the caller's own, gated by `gate`. */
export function settleStatements(
  db: D1Database,
  input: { jobId: string; chargeMilli: number },
  gate?: HoldGuard,
): D1PreparedStatement[] {
  const job = jobIdArg(input.jobId);
  const used = amount("a charge", input.chargeMilli, 0);
  const values = gate?.binds ?? [];
  if (gate !== undefined && values.length !== numberedGuard(gate.sql, 3).count) {
    invalid("a gate binds one value for each ? it has");
  }
  return [db.prepare(settleInsertSql(gate?.sql)).bind(job, used, ...values)];
}

// --- Use that skipped the reservation (phase A7, #2012) ----------------------------------------

/** The key of the entry that records a job's use that skipped the reservation, once. */
export const unreservedKey = (jobId: string): string => `job:${jobId}:unreserved`;

/**
 * THE CHARGE OF A JOB THAT SKIPPED THE RESERVATION (design section 6): `?1` the job, `?2` the tenant
 * partner pool, `?3` the platform `people` budget of the pool's word, `?4` what the job used, `?5` the
 * entry's reason. There is no hold, and the table refuses a `charge` that does not close one
 * (`compute_ledger_closes_its_hold`), so the entry is an `overrun`: use beyond (here, without) a hold,
 * charged to the pool and counted against the budget, with the balance free to go negative. It is
 * written once per job (the key), only for a figure above 0, and never to a person: the pool is the
 * partner's. A gate (see `releaseInsertSql`) ANDs into the WHERE, numbered after the five.
 */
export function unreservedChargeInsertSql(gate?: string): string {
  const and = gate === undefined ? "" : `\n     AND (${numberedGuard(gate, 6).sql})`;
  return `INSERT INTO compute_ledger
  (kind, pool_id, budget_pool_id, charged_delta_milli, job_id, reason, idempotency_key)
  SELECT 'overrun', p.id, ?3, ?4, ?1, ?5, 'job:' || ?1 || ':unreserved'
    FROM compute_pools p
   WHERE p.id = ?2 AND p.holder_kind = 'partner' AND ?4 > 0
     AND NOT EXISTS (SELECT 1 FROM compute_ledger WHERE idempotency_key = 'job:' || ?1 || ':unreserved')${and}`;
}

export const UNRESERVED_CHARGE_INSERT_SQL = unreservedChargeInsertSql();

/** The statement of an unreserved job's charge, for a batch of the caller's own, gated by `gate`. */
export function unreservedChargeStatements(
  db: D1Database,
  input: { jobId: string; poolId: number; budgetPoolId: number; chargeMilli: number },
  gate?: HoldGuard,
): D1PreparedStatement[] {
  const job = jobIdArg(input.jobId);
  const pool = positiveId("a pool", input.poolId);
  const budget = positiveId("a budget pool", input.budgetPoolId);
  const used = amount("a charge", input.chargeMilli, 0);
  const values = gate?.binds ?? [];
  if (gate !== undefined && values.length !== numberedGuard(gate.sql, 6).count) {
    invalid("a gate binds one value for each ? it has");
  }
  return [
    db
      .prepare(unreservedChargeInsertSql(gate?.sql))
      .bind(job, pool, budget, used, REASON.unreserved, ...values),
  ];
}

export type CloseRefusal =
  | { ok: false; code: "no_hold" }
  /** The hold was closed, by a release (`released`) or by a settlement (`settled`). */
  | { ok: false; code: "hold_closed"; closedBy: "released" | "settled" };

async function closingEntries(db: D1Database, job: string): Promise<LedgerRow[]> {
  return (await db.prepare(CLOSING_ENTRIES_SQL).bind(job).all<LedgerRow>()).results;
}

export type ReleaseResult =
  | { ok: true; replayed: boolean; holdId: number; releasedMilli: number }
  | CloseRefusal;

/**
 * Give the job's whole hold back (a job that never started). A release replayed returns the
 * release (`replayed: true`); a hold that a settlement closed is `hold_closed` (`closedBy:
 * 'settled'`); a job with no hold is `no_hold`.
 */
export async function releaseHold(
  db: D1Database,
  input: { jobId: string; reason?: string },
): Promise<ReleaseResult> {
  const job = jobIdArg(input.jobId);
  const reason = reasonArg(input.reason, REASON.released);
  const wrote = (await runOrZero(db.prepare(RELEASE_INSERT_SQL).bind(job, reason))) > 0;
  const hold = await db.prepare(HOLD_OF_JOB_SQL).bind(job).first<HoldOfJob>();
  if (!hold) return { ok: false, code: "no_hold" };
  if (hold.closed_by === "charge") return { ok: false, code: "hold_closed", closedBy: "settled" };
  if (hold.closed_by === null) throw new Error("a hold that a release found open was not closed");
  const entry = (await closingEntries(db, job)).find((e) => e.kind === "release");
  if (!entry) throw new Error("a release that was just written could not be read");
  return { ok: true, replayed: !wrote, holdId: hold.id, releasedMilli: -entry.held_delta_milli };
}

export type SettleResult =
  | {
      ok: true;
      replayed: boolean;
      holdId: number;
      holdMilli: number;
      /** What entered `charged` through the charge entry: at most the hold. */
      chargedMilli: number;
      /** The hold's remainder, returned to available. */
      releasedMilli: number;
      /** What was used above the hold, written as an `overrun` (available may go negative). */
      overrunMilli: number;
    }
  | CloseRefusal;

/**
 * Settle the job's hold provisionally, from what the job used (`chargeMilli`, 0 or more): one
 * `charge` entry closes the hold and enters at most the hold, the rest of the hold is released, and
 * any excess is an `overrun` entry written in the same statement. Available may then be negative.
 * A settlement replayed with the same figure returns it (`replayed: true`); another figure for a
 * settled hold, or any figure for a released one, is `hold_closed` and says which closed it.
 */
export async function settleProvisional(
  db: D1Database,
  input: { jobId: string; chargeMilli: number },
): Promise<SettleResult> {
  const job = jobIdArg(input.jobId);
  const used = amount("a charge", input.chargeMilli, 0);
  const wrote = (await runOrZero(db.prepare(SETTLE_INSERT_SQL).bind(job, used))) > 0;
  const hold = await db.prepare(HOLD_OF_JOB_SQL).bind(job).first<HoldOfJob>();
  if (!hold) return { ok: false, code: "no_hold" };
  if (hold.closed_by === "release") return { ok: false, code: "hold_closed", closedBy: "released" };
  if (hold.closed_by === null) {
    throw new Error("a hold that a settlement found open was not closed");
  }
  const rows = await closingEntries(db, job);
  const charge = rows.find((r) => r.kind === "charge");
  if (!charge) throw new Error("a settlement that was just written could not be read");
  const overrun = rows.find((r) => r.kind === "overrun")?.charged_delta_milli ?? 0;
  // A replay is of the same figure: what was charged and what overran are what the caller used.
  if (!wrote && charge.charged_delta_milli + overrun !== used) {
    return { ok: false, code: "hold_closed", closedBy: "settled" };
  }
  const holdMilli = -charge.held_delta_milli;
  return {
    ok: true,
    replayed: !wrote,
    holdId: hold.id,
    holdMilli,
    chargedMilli: charge.charged_delta_milli,
    releasedMilli: holdMilli - charge.charged_delta_milli,
    overrunMilli: overrun,
  };
}

// --- Final settlement ------------------------------------------------------------------------

/**
 * What a job has been charged on its pool, and what happened to it: `?1` the job. `settled` (its
 * hold was closed by a charge), `refunded` (an entry of kind `refund` exists: nothing in this module
 * writes one, the vocabulary keeps the kind) and `total` (the sum of `charged_delta_milli` by job
 * over its pool: the charge, the overrun, the final settlement and any refund entry). Driven from
 * the hold, so every lookup is by the job's index.
 */
export const JOB_CHARGE_SQL = `SELECT h.id AS hold_id,
    EXISTS (SELECT 1 FROM compute_ledger c
             WHERE c.hold_ref = h.id AND c.kind IN ('release', 'charge')
               AND c.kind = 'charge') AS settled,
    EXISTS (SELECT 1 FROM compute_ledger r
             WHERE r.job_id = h.job_id AND r.kind = 'refund') AS refunded,
    COALESCE((SELECT SUM(e.charged_delta_milli) FROM compute_ledger e
               WHERE e.job_id = h.job_id AND e.pool_id = h.pool_id), 0) AS total
  FROM compute_ledger h WHERE h.kind = 'hold' AND h.job_id = ?1`;

interface JobCharge {
  hold_id: number;
  settled: number;
  refunded: number;
  total: number;
}

/**
 * The final settlement: `?1` the job, `?2` the figure Expanse's own accounting gave. One `adjust`
 * entry of the difference between that and everything already charged to the job on its pool (the
 * charge and any overrun), once per job (`job:<id>:final`), only after the hold was settled by a
 * charge and never after an entry of kind `refund` (which ends the job's charge, so a final
 * settlement after it would charge again; nothing here writes one). A difference of 0 is still the
 * entry: the key is what records that the final settlement happened. One that would take the
 * pool's or the budget's charged below zero (an administrator already corrected it) writes nothing.
 *
 * THE ONE ENTRY THAT MAY LOWER THE `people` BUDGET'S CONSUMPTION. The entry names the budget of the
 * job's hold (`d.budget_pool_id`) and its delta may be negative: under option A (the budget records
 * consumption only, the owner's decision of 2026-11-04) a negative figure is still not a credit
 * back, it is the correction of a number that was recorded as consumption. The provisional charge
 * was counted against the budget when the job ended, and Expanse's own accounting replaces it, so
 * the budget ends at what was truly consumed. The delta is the job's own (the figure minus what THIS
 * job was charged), so it can never take back more than the job consumed. No other entry that names
 * the budget lowers its charged total; `compute-ledger-budget.test.ts` enumerates every operation
 * and says so.
 */
export const FINAL_INSERT_SQL = `INSERT INTO compute_ledger
  (kind, pool_id, budget_pool_id, charged_delta_milli, job_id, reason, idempotency_key)
  SELECT 'adjust', d.pool_id, d.budget_pool_id, d.delta, d.job_id, 'final_settlement',
         'job:' || d.job_id || ':final'
    FROM (SELECT h.pool_id AS pool_id, h.budget_pool_id AS budget_pool_id, h.job_id AS job_id,
                 ?2 - COALESCE((SELECT SUM(e.charged_delta_milli) FROM compute_ledger e
                                 WHERE e.job_id = h.job_id AND e.pool_id = h.pool_id), 0) AS delta
            FROM compute_ledger h
           WHERE h.kind = 'hold' AND h.job_id = ?1
             AND EXISTS (SELECT 1 FROM compute_ledger c
                          WHERE c.hold_ref = h.id AND c.kind IN ('release', 'charge')
                            AND c.kind = 'charge')) d
   WHERE (SELECT charged_milli FROM compute_pools WHERE id = d.pool_id) + d.delta >= 0
     AND (d.budget_pool_id IS NULL
          OR (SELECT charged_milli FROM compute_pools WHERE id = d.budget_pool_id) + d.delta >= 0)
     AND NOT EXISTS (SELECT 1 FROM compute_ledger r WHERE r.job_id = d.job_id AND r.kind = 'refund')
     AND NOT EXISTS (SELECT 1 FROM compute_ledger WHERE idempotency_key = 'job:' || d.job_id || ':final')`;

export type FinalResult =
  | { ok: true; replayed: boolean; deltaMilli: number; entry: LedgerRow }
  | {
      ok: false;
      code: "not_settled" | "already_final" | "refunded" | "would_go_negative";
    };

/**
 * Settle the job finally, to `finalMilli` (Expanse's own figure): an `adjust` of the charged delta
 * that brings the job's whole charge to it, once per job, even when the figure is the charge
 * already (an entry of nothing). The same figure again is a replay (`replayed: true`); another is
 * `already_final`. `not_settled` when the hold was never settled by a charge (open, released or
 * never made); `refunded` after an entry of kind `refund` (nothing here writes one), whatever the
 * figure; `would_go_negative` when a correction would take a stored total below zero, and nothing
 * is written.
 *
 * A figure BELOW the job's charge lowers the person's pool and the `people` budget together, and
 * this is the only path that lowers the budget's consumption (see `FINAL_INSERT_SQL`): it corrects
 * a figure that was recorded as consumption, it is not a refund.
 */
export async function settleFinal(
  db: D1Database,
  input: { jobId: string; finalMilli: number },
): Promise<FinalResult> {
  const job = jobIdArg(input.jobId);
  const figure = amount("a final figure", input.finalMilli, 0);
  const changes = await runOrZero(db.prepare(FINAL_INSERT_SQL).bind(job, figure));
  const entry = await findEntryByKey(db, finalKey(job));
  if (changes > 0) {
    if (!entry) throw new Error("a final settlement that was just written could not be read");
    return { ok: true, replayed: false, deltaMilli: entry.charged_delta_milli, entry };
  }
  const charge = await db.prepare(JOB_CHARGE_SQL).bind(job).first<JobCharge>();
  if (charge?.refunded) return { ok: false, code: "refunded" };
  if (entry) {
    // The final settlement happened. It is replayed by its own figure: the charge it made is now
    // the whole of what the job holds.
    return charge?.total === figure
      ? { ok: true, replayed: true, deltaMilli: entry.charged_delta_milli, entry }
      : { ok: false, code: "already_final" };
  }
  if (!charge || !charge.settled) return { ok: false, code: "not_settled" };
  return { ok: false, code: "would_go_negative" };
}

// --- Grant, adjustment and expiry ------------------------------------------------------------

/**
 * A grant: `?1` pool, `?2` amount, `?3` actor, `?4` reason, `?5` key. Only if the pool is there, the
 * key unused and the granted total stays within 2^53 - 1.
 */
export const GRANT_INSERT_SQL = `INSERT INTO compute_ledger
  (kind, pool_id, granted_delta_milli, actor_user_id, reason, idempotency_key)
  SELECT 'grant', p.id, ?2, ?3, ?4, ?5
    FROM compute_pools p
   WHERE p.id = ?1
     AND p.granted_milli + ?2 <= ${TOTAL_MAX}
     AND NOT EXISTS (SELECT 1 FROM compute_ledger WHERE idempotency_key = ?5)`;

/**
 * An adjustment: `?1` pool, `?2` the budget pool (NULL for none), `?3` the change to granted, `?4`
 * the change to charged, `?5` actor, `?6` reason, `?7` key. Only if the pool is there, the key
 * unused, and no stored total (the pool's granted or charged, or the budget's charged) would leave
 * 0 to 2^53 - 1, and a budget is named only with a charged change that RAISES it (`?2 IS NULL OR
 * ?4 > 0`): the `people` budget records consumption only, so a correction that lowers a charge never
 * reaches it. `adjustPool` refuses the same case with an error before it binds, and the statement
 * says it as well, so that a caller that binds it directly writes nothing.
 */
export const ADJUST_INSERT_SQL = `INSERT INTO compute_ledger
  (kind, pool_id, budget_pool_id, granted_delta_milli, charged_delta_milli, actor_user_id, reason,
   idempotency_key)
  SELECT 'adjust', p.id, ?2, ?3, ?4, ?5, ?6, ?7
    FROM compute_pools p
   WHERE p.id = ?1
     AND p.granted_milli + ?3 BETWEEN 0 AND ${TOTAL_MAX}
     AND p.charged_milli + ?4 BETWEEN 0 AND ${TOTAL_MAX}
     AND (?2 IS NULL OR ?4 > 0)
     AND (?2 IS NULL OR (SELECT b.charged_milli FROM compute_pools b WHERE b.id = ?2) + ?4
                          BETWEEN 0 AND ${TOTAL_MAX})
     AND NOT EXISTS (SELECT 1 FROM compute_ledger WHERE idempotency_key = ?7)`;

/** An expiry of the pool's whole unused balance: `?1` pool, `?2` reason, `?3` key, `?4` actor. */
export const EXPIRE_INSERT_SQL = `INSERT INTO compute_ledger
  (kind, pool_id, granted_delta_milli, reason, idempotency_key, actor_user_id)
  SELECT 'expire', p.id, -(p.granted_milli - p.held_milli - p.charged_milli), ?2, ?3, ?4
    FROM compute_pools p
   WHERE p.id = ?1
     AND p.granted_milli - p.held_milli - p.charged_milli > 0
     AND NOT EXISTS (SELECT 1 FROM compute_ledger WHERE idempotency_key = ?3)`;

export type EntryResult = { ok: true; replayed: boolean; entry: LedgerRow };

/**
 * Give SU to a pool: one `grant` entry, with who did it and a fixed-word reason (default `grant`).
 * `audit` writes an audit row in the same batch, only if the entry was written. A repeated key
 * returns the entry it made and grants once; the same key for another pool, amount or reason throws
 * `idempotency_conflict`. A grant that would take the granted total past 2^53 - 1 is
 * `would_exceed_limit` and writes nothing.
 */
export async function grantPool(
  db: D1Database,
  input: {
    poolId: number;
    amountMilli: number;
    actorUserId: number | null;
    reason?: string;
    idempotencyKey: string;
    audit?: LedgerAudit;
  },
): Promise<EntryResult | { ok: false; code: "would_exceed_limit" }> {
  const poolId = positiveId("a pool", input.poolId);
  const milli = amount("a grant", input.amountMilli, 1);
  const actor = actorArg(input.actorUserId);
  const reason = reasonArg(input.reason, REASON.grant);
  const key = keyArg(input.idempotencyKey);
  const changes = await writeEntry(
    db,
    db.prepare(GRANT_INSERT_SQL).bind(poolId, milli, actor, reason, key),
    input.audit,
  );
  const entry = await findEntryByKey(db, key);
  if (changes > 0) {
    if (!entry) throw new Error("a grant that was just written could not be read");
    return { ok: true, replayed: false, entry };
  }
  if (entry) {
    return replayOrConflict(entry, {
      kind: "grant",
      pool_id: poolId,
      budget_pool_id: null,
      granted_delta_milli: milli,
      held_delta_milli: 0,
      charged_delta_milli: 0,
      job_id: null,
      reason,
    });
  }
  if (!(await getPool(db, poolId))) throw new ComputeLedgerError("pool_not_found", "no such pool");
  return { ok: false, code: "would_exceed_limit" };
}

export type AdjustResult =
  | EntryResult
  | { ok: false; code: "would_go_negative" | "would_exceed_limit" };

/**
 * Correct a pool's grant or its charge, up or down: one `adjust` entry whose delta is on exactly
 * one of them, with who and a fixed-word reason (required). THE `people` BUDGET RECORDS CONSUMPTION
 * ONLY (the owner's option A, 2026-11-04), so a correction of the charge of an account's or a
 * partner's pool that RAISES it names the platform `people` budget of its word (`budgetPoolId`),
 * which rises with it, and one that LOWERS it names NONE: the pool falls and the budget stays as it
 * was. A lowering correction that names a budget is `invalid_argument` (a programming error: the
 * table would take the entry, which is why this refuses it), and nothing is written. A correction of
 * the grant names none either way, and a platform pool's own correction names none (it is the
 * budget). One that would take a stored total below zero (the pool's granted or charged, or the
 * budget's charged) is `would_go_negative`, and one that would take it past 2^53 - 1 is
 * `would_exceed_limit`; both write nothing. A grant adjusted below what is used is allowed, and
 * available goes negative. A budget that is not there is `pool_not_found`.
 */
export async function adjustPool(
  db: D1Database,
  input: {
    poolId: number;
    budgetPoolId?: number | null;
    grantedDeltaMilli?: number;
    chargedDeltaMilli?: number;
    actorUserId: number | null;
    reason: string;
    idempotencyKey: string;
    audit?: LedgerAudit;
  },
): Promise<AdjustResult> {
  const poolId = positiveId("a pool", input.poolId);
  const granted =
    input.grantedDeltaMilli === undefined
      ? 0
      : signedAmount("an adjustment of the grant", input.grantedDeltaMilli);
  const charged =
    input.chargedDeltaMilli === undefined
      ? 0
      : signedAmount("an adjustment of the charge", input.chargedDeltaMilli);
  if ((granted !== 0) === (charged !== 0)) {
    return invalid("an adjustment changes exactly one of the grant and the charge");
  }
  const budget =
    input.budgetPoolId === undefined || input.budgetPoolId === null
      ? null
      : positiveId("a budget pool", input.budgetPoolId);
  if (budget !== null && charged === 0) invalid("only an adjustment of the charge names a budget");
  if (budget !== null && charged < 0) {
    // Option A: the people budget records consumption only, so lowering a charge never credits it.
    invalid(
      "an adjustment that lowers a charge names no budget: the people budget records consumption only",
    );
  }
  if (input.reason === undefined || input.reason === null) invalid("an adjustment has a reason");
  const reason = reasonArg(input.reason, null);
  const actor = actorArg(input.actorUserId);
  const key = keyArg(input.idempotencyKey);
  const changes = await writeEntry(
    db,
    db.prepare(ADJUST_INSERT_SQL).bind(poolId, budget, granted, charged, actor, reason, key),
    input.audit,
  );
  const entry = await findEntryByKey(db, key);
  if (changes > 0) {
    if (!entry) throw new Error("an adjustment that was just written could not be read");
    return { ok: true, replayed: false, entry };
  }
  if (entry) {
    return replayOrConflict(entry, {
      kind: "adjust",
      pool_id: poolId,
      budget_pool_id: budget,
      granted_delta_milli: granted,
      held_delta_milli: 0,
      charged_delta_milli: charged,
      job_id: null,
      reason,
    });
  }
  const pool = await getPool(db, poolId);
  if (!pool) throw new ComputeLedgerError("pool_not_found", "no such pool");
  const budgetPool = budget === null ? null : await getPool(db, budget);
  if (budget !== null && !budgetPool) {
    throw new ComputeLedgerError("pool_not_found", "no such budget pool");
  }
  const totals = [
    pool.granted_milli + granted,
    pool.charged_milli + charged,
    ...(budgetPool ? [budgetPool.charged_milli + charged] : []),
  ];
  return totals.some((t) => t > TOTAL_MAX)
    ? { ok: false, code: "would_exceed_limit" }
    : { ok: false, code: "would_go_negative" };
}

export type ExpireResult =
  | { ok: true; replayed: boolean; expiredMilli: number; entry: LedgerRow }
  | { ok: false; code: "nothing_to_expire" };

/**
 * Let a pool's unused balance lapse (a renewal): one `expire` entry that takes the whole available
 * balance out of granted. What is held and charged stays, so an open hold still settles. A pool with
 * no positive available (an overrun left it negative) has nothing to take: `nothing_to_expire`. A
 * repeated key returns the entry it made, if the request is the same pool and reason.
 */
export async function expireUnused(
  db: D1Database,
  input: { poolId: number; reason?: string; idempotencyKey: string; actorUserId?: number | null },
): Promise<ExpireResult> {
  const poolId = positiveId("a pool", input.poolId);
  const reason = reasonArg(input.reason, REASON.expired);
  const key = keyArg(input.idempotencyKey);
  const actor = actorArg(input.actorUserId);
  const changes = await runOrZero(db.prepare(EXPIRE_INSERT_SQL).bind(poolId, reason, key, actor));
  const entry = await findEntryByKey(db, key);
  if (changes > 0) {
    if (!entry) throw new Error("an expiry that was just written could not be read");
    return { ok: true, replayed: false, expiredMilli: -entry.granted_delta_milli, entry };
  }
  if (entry) {
    const replay = replayOrConflict(entry, {
      kind: "expire",
      pool_id: poolId,
      budget_pool_id: null,
      held_delta_milli: 0,
      charged_delta_milli: 0,
      job_id: null,
      reason,
    });
    return { ...replay, expiredMilli: -entry.granted_delta_milli };
  }
  if (!(await getPool(db, poolId))) throw new ComputeLedgerError("pool_not_found", "no such pool");
  return { ok: false, code: "nothing_to_expire" };
}

// --- Reads for the routes --------------------------------------------------------------------

/** A page of pools, oldest first: `?1` holder kind (NULL for any), `?2` after this id, `?3` a page of this many. */
export const POOLS_PAGE_SQL = `SELECT ${POOL_COLUMNS} FROM compute_pools
  WHERE (?1 IS NULL OR holder_kind = ?1) AND id > ?2 ORDER BY id LIMIT ?3`;

export async function listPools(
  db: D1Database,
  q: { holderKind?: ComputePoolHolderKind; after?: number; limit: number },
): Promise<{ pools: PoolRow[]; nextAfter: number | null }> {
  const rows = (
    await db
      .prepare(POOLS_PAGE_SQL)
      .bind(q.holderKind ?? null, q.after ?? 0, q.limit + 1)
      .all<PoolRow>()
  ).results;
  const pools = rows.slice(0, q.limit);
  return { pools, nextAfter: rows.length > q.limit ? (pools[pools.length - 1]?.id ?? null) : null };
}

/** An account's pools (at most one for each word), cpu first. */
export const ACCOUNT_POOLS_SQL = `SELECT ${POOL_COLUMNS} FROM compute_pools
  WHERE holder_kind = 'account' AND holder_ref = ?1 ORDER BY pool`;

export async function accountPools(db: D1Database, accountId: number): Promise<PoolRow[]> {
  return (await db.prepare(ACCOUNT_POOLS_SQL).bind(String(accountId)).all<PoolRow>()).results;
}

/** A platform budget's pool of one word, which the migration seeds for every platform key. */
export async function platformPool(
  db: D1Database,
  key: (typeof COMPUTE_PLATFORM_KEYS)[number],
  pool: ComputePool,
): Promise<PoolRow | null> {
  return db.prepare(POOL_BY_HOLDER_SQL).bind("platform", key, pool).first<PoolRow>();
}
