/**
 * The retention sweep (epic #2005 phase A7, #2012; ADR 0118, decision 9 and the amendment of 2026-11-04;
 * design section 9): NEMAR keeps compute records only as long as policy says, and says how many it let go.
 *
 * Daily, in production only, `runComputeRetentionSweep` does five things, each bounded:
 *
 *  1. RECORDS. For a terminal job past `retention_until` with no legal hold (a job hold, or a hold on its
 *     account), it deletes `records/<id>/` and `logs/<id>/` through the binding, then reduces the index row
 *     to anonymous counts (`account_id`, `tapis_owner`, `gateway_user` and `idempotency_key` become NULL).
 *  2. LOGS. For a terminal job with no flag and no hold, `logs/<id>/` is deleted once `retention.logsDays`
 *     have passed since `ended_at` (a flagged job keeps its logs with its records, design section 9).
 *  3. RESULTS. Results expire by the results bucket's own lifecycle rule, so this only reconciles: a job's
 *     `jobs/<id>/` objects still present a day after `retention.resultsDays` are deleted and counted `late`.
 *     A hold NEVER keeps a result (a result is the person's, not a record).
 *  4. IDENTIFIERS. A deleted account's pools and the ledger entries it acted on are reduced to anonymous
 *     counts, through the one exception migration 0130 makes (the holder reference and the actor, nothing
 *     else), once none of its jobs remain with its number and nothing is open or held.
 *  5. HOUSEKEEPING. Observer runs past their hour are `expired`, and queue snapshots older than 90 days go.
 *
 * THE RULES.
 *  - A BUCKET LOCK IS NEVER BYPASSED BY CODE. The sweep never changes a lock, a rule or a bucket setting; a
 *    lifecycle rule cannot delete a locked object, so this sweep is what deletes records, and it only ever
 *    asks the binding to delete. ANY refusal on a `records/` or `logs/` key is counted `locked`, whatever its
 *    text (the text of R2's refusal is not verified), the job is left whole, and the next day asks again;
 *    a job that was refused is stamped (`retention_attempted_at`) and goes to the back of the line, so ten
 *    jobs whose locks have not lapsed cannot hold every newer one.
 *  - A LIVE JOB IS NEVER TOUCHED: only terminal states are listed.
 *  - A HOLD IS A D1 FLAG THE SWEEP HONORS (R2 has no per-object hold), read in the candidate query AND
 *    again immediately before a job's objects are deleted.
 *  - DELETION AT PERIOD END IS BY COUNT, LOGGED, NEVER PER JOB: one audit row of counts and one log line.
 *    The sweep never logs a job id, an account or a key.
 *  - IT NEVER RUNS OUTSIDE EXACT PRODUCTION, and it reads no compute switch: a record that is due goes
 *    whether or not compute is on.
 */

import { COMPUTE_ANONYMOUS_ACTOR_ID, anonymousPoolRef } from "../../../shared/compute-state.js";
import { auditLogStatement } from "../db/audit-log.js";
import type { Bindings } from "../types/bindings.js";
import { TERMINAL_STATES_SQL } from "./compute-jobs.js";
import { heldSql } from "./compute-legal-holds.js";
import { errorClassName } from "./compute-lifecycle.js";
import { getPolicy } from "./compute-policy.js";
import { isExactProduction } from "./repull-switches.js";

/** Jobs a stage handles at most in one run. */
export const RETENTION_JOBS_PER_STAGE = 20;
/** Pools, and deleted accounts' ledger entries, one run anonymizes at most. */
export const RETENTION_ANON_PER_RUN = 50;
/** Days a queue snapshot is kept. */
export const SNAPSHOT_KEEP_DAYS = 90;
/** The retention audit action. */
export const RETENTION_AUDIT_ACTION = "compute.retention.sweep";

export interface RetentionResult {
  /** Jobs whose records and logs were deleted and whose index row was reduced. */
  recordsDeleted: number;
  /** Jobs whose logs alone were deleted (the shorter period). */
  logsDeleted: number;
  /** Objects deleted from the two private buckets, records and logs and results together. */
  objectsDeleted: number;
  /**
   * The class of the first refusal of a delete in the run (never its text), and how many refused jobs are
   * more than a day past `retention_until`: a lock that should have lapsed and has not, which needs a person.
   */
  lockClass: string | null;
  overdueLocked: number;
  /**
   * Due jobs the cap of a stage left for tomorrow, by stage: a backlog that grows is a sweep that cannot
   * keep up, and needs a person (the log line is at error level while any is above 0).
   */
  backlog: { records: number; logs: number; results: number };
  /** Jobs whose prefix was bigger than one run's page bound: left whole and finished by the next run. */
  incomplete: number;
  /** Jobs the bucket refused to delete for (a lock that has not lapsed), left whole and retried tomorrow. */
  locked: number;
  /** Jobs whose results were still present a day after the window, deleted. */
  late: number;
  /** A deleted account's pools and ledger entries anonymized. */
  poolsAnonymised: number;
  entriesAnonymised: number;
  /** Observer runs expired and snapshots trimmed. */
  runsExpired: number;
  snapshotsTrimmed: number;
  /** Fixed words; never a message. */
  errors: string[];
  errorClass: string | null;
}

const emptyResult = (): RetentionResult => ({
  recordsDeleted: 0,
  logsDeleted: 0,
  objectsDeleted: 0,
  backlog: { records: 0, logs: 0, results: 0 },
  lockClass: null,
  overdueLocked: 0,
  incomplete: 0,
  locked: 0,
  late: 0,
  poolsAnonymised: 0,
  entriesAnonymised: 0,
  runsExpired: 0,
  snapshotsTrimmed: 0,
  errors: [],
  errorClass: null,
});

// --- Statements ------------------------------------------------------------------------------------

/** Terminal jobs whose records are due: past `retention_until`, not held, in rotation. `?1` the limit. */
export const RECORDS_DUE_SQL = `SELECT j.id AS id,
    (j.retention_until < datetime('now', '-1 day')) AS overdue FROM compute_jobs j
  WHERE j.state IN (${TERMINAL_STATES_SQL}) AND j.records_deleted_at IS NULL
    AND j.retention_until IS NOT NULL AND j.retention_until < datetime('now')
    AND NOT ${heldSql("j")}
  ORDER BY j.retention_attempted_at ASC, j.retention_until ASC LIMIT ?1`;

/**
 * Terminal jobs whose logs are due early: no flag, not held, ended more than `?1` days ago (`?2` the
 * limit). A flagged job keeps its logs until its records go.
 */
export const LOGS_DUE_SQL = `SELECT j.id AS id FROM compute_jobs j
  WHERE j.state IN (${TERMINAL_STATES_SQL}) AND j.logs_deleted_at IS NULL
    AND j.records_deleted_at IS NULL AND j.ended_at IS NOT NULL
    AND j.ended_at < datetime('now', '-' || ?1 || ' days')
    AND j.flag_unreserved = 0 AND j.flag_unattributed = 0 AND j.flag_mismatch = 0
    AND j.flag_overrun = 0
    AND NOT ${heldSql("j")}
  ORDER BY j.retention_attempted_at ASC, j.ended_at ASC LIMIT ?2`;

/** Terminal jobs whose results were not yet reconciled and are past the window plus a day: `?1` days, `?2` limit. */
export const RESULTS_DUE_SQL = `SELECT j.id AS id FROM compute_jobs j
  WHERE j.state IN (${TERMINAL_STATES_SQL}) AND j.results_reconciled_at IS NULL
    AND j.ended_at IS NOT NULL AND j.ended_at < datetime('now', '-' || ?1 || ' days')
  ORDER BY j.ended_at ASC LIMIT ?2`;

/**
 * How many rows a due-list has beyond the cap: the same statement counted with a very large limit. The
 * limit is the LAST bound value of every due statement.
 */
export const BACKLOG_COUNT_LIMIT = 1_000_000;

/** The job is held now: `?1` the job. */
export const IS_HELD_SQL = `SELECT CASE WHEN ${heldSql("j")} THEN 1 ELSE 0 END AS held
  FROM compute_jobs j WHERE j.id = ?1`;

export const STAMP_RETENTION_ATTEMPT_SQL =
  "UPDATE compute_jobs SET retention_attempted_at = datetime('now') WHERE id = ?1";

/**
 * Reduce a job to anonymous counts after its records and logs are gone: `?1` the job. It is written only
 * for a terminal, un-held job, so a hold placed since the check is not defeated by the row alone.
 */
export const REDUCE_JOB_SQL = `UPDATE compute_jobs SET
    records_deleted_at = datetime('now'),
    logs_deleted_at = COALESCE(logs_deleted_at, datetime('now')),
    retention_attempted_at = datetime('now'),
    account_id = NULL, tapis_owner = NULL, gateway_user = NULL, idempotency_key = NULL
  WHERE id = ?1 AND records_deleted_at IS NULL AND state IN (${TERMINAL_STATES_SQL})
    AND NOT ${heldSql("compute_jobs")}`;

export const MARK_LOGS_SQL = `UPDATE compute_jobs SET
    logs_deleted_at = datetime('now'), retention_attempted_at = datetime('now')
  WHERE id = ?1 AND logs_deleted_at IS NULL AND state IN (${TERMINAL_STATES_SQL})
    AND NOT ${heldSql("compute_jobs")}`;

export const MARK_RESULTS_SQL =
  "UPDATE compute_jobs SET results_reconciled_at = datetime('now') WHERE id = ?1 AND results_reconciled_at IS NULL";

/** Pools of deleted accounts that can be anonymized: nothing held, no job still carries the number, no hold. `?1` limit. */
export const POOLS_DUE_SQL = `SELECT p.id AS id FROM compute_pools p
  JOIN users u ON u.id = CAST(p.holder_ref AS INTEGER)
  WHERE p.holder_kind = 'account' AND p.held_milli = 0 AND u.deleted_at IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM compute_jobs j WHERE j.account_id = u.id)
    AND NOT EXISTS (SELECT 1 FROM compute_legal_holds h
                     WHERE h.released_at IS NULL AND h.scope = 'account' AND h.ref = p.holder_ref)
  ORDER BY p.id ASC LIMIT ?1`;

export const ANONYMISE_POOL_SQL = "UPDATE compute_pools SET holder_ref = ?2 WHERE id = ?1";

/**
 * Deleted accounts with a ledger entry the update can change, and no job or hold. An account whose only
 * entries are the entries of holds still open is NOT listed (the update leaves them alone, so it would sit
 * at the head of the window every day and starve the rest). `?1` limit.
 */
export const ACTORS_DUE_SQL = `SELECT u.id AS id FROM users u
  WHERE u.deleted_at IS NOT NULL
    AND EXISTS (SELECT 1 FROM compute_ledger l WHERE l.actor_user_id = u.id
                 AND (l.kind <> 'hold' OR EXISTS (SELECT 1 FROM compute_ledger c
                                                   WHERE c.hold_ref = l.id
                                                     AND c.kind IN ('release', 'charge'))))
    AND NOT EXISTS (SELECT 1 FROM compute_jobs j WHERE j.account_id = u.id)
    AND NOT EXISTS (SELECT 1 FROM compute_legal_holds h
                     WHERE h.released_at IS NULL AND h.scope = 'account' AND h.ref = CAST(u.id AS TEXT))
  ORDER BY u.id ASC LIMIT ?1`;

/**
 * The anonymizing update of one deleted account's ledger entries: `?1` the account. It leaves an open
 * hold's own entry alone, exactly as migration 0130's trigger requires.
 */
export const ANONYMISE_ACTOR_SQL = `UPDATE compute_ledger SET actor_user_id = ${COMPUTE_ANONYMOUS_ACTOR_ID}
  WHERE actor_user_id = ?1
    AND (kind <> 'hold' OR EXISTS (SELECT 1 FROM compute_ledger c
                                    WHERE c.hold_ref = compute_ledger.id
                                      AND c.kind IN ('release', 'charge')))`;

export const EXPIRE_RUNS_SQL = `UPDATE compute_observer_runs SET status = 'expired'
  WHERE status = 'issued' AND expires_at <= datetime('now')`;

export const TRIM_SNAPSHOTS_SQL = `DELETE FROM compute_queue_snapshots
  WHERE captured_at < datetime('now', '-${SNAPSHOT_KEEP_DAYS} days')`;

// --- Deleting under a prefix -----------------------------------------------------------------------

const PROGRAMMING_ERRORS = [TypeError, RangeError, ReferenceError, SyntaxError] as const;

/** Pages of objects one call deletes at most, and the objects in a page. */
export const PREFIX_MAX_PAGES = 20;
export const PREFIX_PAGE_SIZE = 1000;

export interface PrefixDeletion {
  deleted: number;
  /** The bucket refused to delete (any throw from `delete`): the rest of the prefix is left for tomorrow. */
  locked: boolean;
  /** The class of the first throw, when `locked` (the text is never kept). */
  lockClass?: string;
  /** Nothing is left under the prefix. False after the page bound: the caller must NOT treat the prefix as gone. */
  complete: boolean;
}

/**
 * Delete every object under `prefix`, a page at a time, for at most `maxPages` pages. Returns how many
 * were deleted, whether the bucket refused (`locked`) and whether the prefix is `complete`: a prefix
 * bigger than the page bound is left for the next run, and a caller that reduces a row or marks a result
 * reconciled must see `complete` first.
 */
export async function deletePrefix(
  bucket: R2Bucket,
  prefix: string,
  options: { maxPages?: number; pageSize?: number } = {},
): Promise<PrefixDeletion> {
  const maxPages = options.maxPages ?? PREFIX_MAX_PAGES;
  const limit = options.pageSize ?? PREFIX_PAGE_SIZE;
  let deleted = 0;
  for (let page = 0; page < maxPages; page++) {
    const listed = await bucket.list({ prefix, limit });
    const keys = listed.objects.map((o) => o.key);
    if (keys.length === 0) return { deleted, locked: false, complete: true };
    try {
      await bucket.delete(keys);
    } catch (err) {
      // A programming error (a wrong argument, a missing name) is not a refusal of a lock: it is the
      // sweep's own fault and is reported as a failed stage, not hidden as a lock for a day.
      if (PROGRAMMING_ERRORS.some((c) => err instanceof c)) throw err;
      return { deleted, locked: true, complete: false, lockClass: errorClassName(err) };
    }
    deleted += keys.length;
    if (!listed.truncated) return { deleted, locked: false, complete: true };
  }
  return { deleted, locked: false, complete: false };
}

// --- The sweep --------------------------------------------------------------------------------------

async function isHeld(db: D1Database, id: string): Promise<boolean> {
  return ((await db.prepare(IS_HELD_SQL).bind(id).first<{ held: number }>())?.held ?? 0) === 1;
}

/**
 * One run of the retention sweep. Null outside exact production, before anything is read. Every stage is
 * in its own try, so a failure in one is a fixed word and does not stop the rest.
 */
export async function runComputeRetentionSweep(env: Bindings): Promise<RetentionResult | null> {
  if (!isExactProduction(env)) return null;
  const r = emptyResult();
  const db = env.DB;
  let policy: Awaited<ReturnType<typeof getPolicy>>["policy"];
  try {
    policy = (await getPolicy(db)).policy;
  } catch (err) {
    r.errors.push("policy_unreadable");
    r.errorClass = errorClassName(err);
    return r;
  }
  const records = env.COMPUTE_RECORDS;
  const resultsBucket = env.COMPUTE_RESULTS;
  // A job the bucket refused is counted once, whichever stage met the refusal first.
  const lockedJobs = new Set<string>();
  const overdueJobs = new Set<string>();
  const locked = (id: string, lockClass?: string, overdue = false) => {
    lockedJobs.add(id);
    r.locked = lockedJobs.size;
    r.lockClass ??= lockClass ?? null;
    if (overdue) {
      overdueJobs.add(id);
      r.overdueLocked = overdueJobs.size;
    }
  };

  /** The due rows beyond the cap, when a stage's list came back full; 0 otherwise. */
  const leftover = async (sql: string, binds: unknown[], got: number): Promise<number> => {
    if (got < RETENTION_JOBS_PER_STAGE) return 0;
    const counted = await db
      .prepare(`SELECT COUNT(*) AS n FROM (${sql})`)
      .bind(...binds.slice(0, -1), BACKLOG_COUNT_LIMIT)
      .first<{ n: number }>();
    return Math.max(0, (counted?.n ?? 0) - got);
  };

  const stage = async (word: string, body: () => Promise<void>) => {
    try {
      await body();
    } catch (err) {
      r.errors.push(word);
      r.errorClass = errorClassName(err);
    }
  };

  // 1. Records and logs, and the reduction of the row.
  await stage("records_failed", async () => {
    if (!records) {
      r.errors.push("records_unbound");
      return;
    }
    const due = (
      await db
        .prepare(RECORDS_DUE_SQL)
        .bind(RETENTION_JOBS_PER_STAGE)
        .all<{ id: string; overdue: number }>()
    ).results;
    r.backlog.records = await leftover(RECORDS_DUE_SQL, [RETENTION_JOBS_PER_STAGE], due.length);
    for (const { id, overdue } of due) {
      await db.prepare(STAMP_RETENTION_ATTEMPT_SQL).bind(id).run();
      if (await isHeld(db, id)) continue;
      const a = await deletePrefix(records, `records/${id}/`);
      r.objectsDeleted += a.deleted;
      if (a.locked) {
        locked(id, a.lockClass, overdue === 1);
        continue;
      }
      if (!a.complete) {
        r.incomplete++;
        continue;
      }
      // A hold placed since the first read, while the records were being deleted, still keeps the logs: the
      // hold is read again between the two prefixes (the reducing statement guards the row, not the objects).
      if (await isHeld(db, id)) continue;
      const b = await deletePrefix(records, `logs/${id}/`);
      r.objectsDeleted += b.deleted;
      if (b.locked) {
        locked(id, b.lockClass, overdue === 1);
        continue;
      }
      if (!b.complete) {
        r.incomplete++;
        continue;
      }
      const reduced = await db.prepare(REDUCE_JOB_SQL).bind(id).run();
      if ((reduced.meta?.changes ?? 0) === 1) r.recordsDeleted++;
    }
  });

  // 2. Logs alone, for an unflagged job past the shorter period.
  await stage("logs_failed", async () => {
    if (!records) return;
    const logsBinds = [policy.retention.logsDays, RETENTION_JOBS_PER_STAGE];
    const due = (
      await db
        .prepare(LOGS_DUE_SQL)
        .bind(...logsBinds)
        .all<{ id: string }>()
    ).results;
    r.backlog.logs = await leftover(LOGS_DUE_SQL, logsBinds, due.length);
    for (const { id } of due) {
      await db.prepare(STAMP_RETENTION_ATTEMPT_SQL).bind(id).run();
      if (await isHeld(db, id)) continue;
      const a = await deletePrefix(records, `logs/${id}/`);
      r.objectsDeleted += a.deleted;
      if (a.locked) {
        locked(id, a.lockClass);
        continue;
      }
      if (!a.complete) {
        r.incomplete++;
        continue;
      }
      const marked = await db.prepare(MARK_LOGS_SQL).bind(id).run();
      if ((marked.meta?.changes ?? 0) === 1) r.logsDeleted++;
    }
  });

  // 3. Results the lifecycle rule did not take. A hold never keeps a result.
  await stage("results_failed", async () => {
    if (!resultsBucket) return;
    const resultsBinds = [policy.retention.resultsDays + 1, RETENTION_JOBS_PER_STAGE];
    const due = (
      await db
        .prepare(RESULTS_DUE_SQL)
        .bind(...resultsBinds)
        .all<{ id: string }>()
    ).results;
    r.backlog.results = await leftover(RESULTS_DUE_SQL, resultsBinds, due.length);
    for (const { id } of due) {
      const a = await deletePrefix(resultsBucket, `jobs/${id}/`);
      r.objectsDeleted += a.deleted;
      if (a.deleted > 0) r.late++;
      // A refusal here is not a lock (the results bucket has none), and a prefix left over the page bound
      // is not gone: leave the row to be tried again.
      if (a.locked || !a.complete) {
        if (!a.locked) r.incomplete++;
        continue;
      }
      await db.prepare(MARK_RESULTS_SQL).bind(id).run();
    }
  });

  // 4. A deleted account's pools and ledger entries.
  await stage("anonymise_failed", async () => {
    const pools = (
      await db.prepare(POOLS_DUE_SQL).bind(RETENTION_ANON_PER_RUN).all<{ id: number }>()
    ).results;
    for (const { id } of pools) {
      const done = await db.prepare(ANONYMISE_POOL_SQL).bind(id, anonymousPoolRef(id)).run();
      r.poolsAnonymised += done.meta?.changes ?? 0;
    }
    const actors = (
      await db.prepare(ACTORS_DUE_SQL).bind(RETENTION_ANON_PER_RUN).all<{ id: number }>()
    ).results;
    for (const { id } of actors) {
      const done = await db.prepare(ANONYMISE_ACTOR_SQL).bind(id).run();
      r.entriesAnonymised += done.meta?.changes ?? 0;
    }
  });

  // 5. Housekeeping.
  await stage("housekeeping_failed", async () => {
    r.runsExpired = (await db.prepare(EXPIRE_RUNS_SQL).run()).meta?.changes ?? 0;
    r.snapshotsTrimmed = (await db.prepare(TRIM_SNAPSHOTS_SQL).run()).meta?.changes ?? 0;
  });

  // One audit row of counts, only when something happened.
  const counts = {
    records_deleted: r.recordsDeleted,
    logs_deleted: r.logsDeleted,
    objects_deleted: r.objectsDeleted,
    locked: r.locked,
    late: r.late,
    pools_anonymised: r.poolsAnonymised,
    entries_anonymised: r.entriesAnonymised,
  };
  if (Object.values(counts).some((n) => n > 0)) {
    try {
      await auditLogStatement(db, {
        userId: null,
        action: RETENTION_AUDIT_ACTION,
        resourceType: "compute_retention",
        details: JSON.stringify(counts),
      }).run();
    } catch (err) {
      r.errors.push("audit_failed");
      r.errorClass = errorClassName(err);
    }
  }
  return r;
}

/** The retention sweep's one log line: counts and fixed words. Null when nothing happened and nothing failed. */
export function retentionLogLine(
  r: RetentionResult,
): { level: "info" | "error"; line: string } | null {
  const acted =
    r.recordsDeleted +
    r.logsDeleted +
    r.late +
    r.incomplete +
    r.locked +
    r.backlog.records +
    r.backlog.logs +
    r.backlog.results +
    r.poolsAnonymised +
    r.entriesAnonymised +
    r.runsExpired +
    r.snapshotsTrimmed;
  if (acted === 0 && r.errors.length === 0) return null;
  const line = [
    "[compute-retention]",
    `records=${r.recordsDeleted}`,
    `logs=${r.logsDeleted}`,
    `objects=${r.objectsDeleted}`,
    `backlog_records=${r.backlog.records}`,
    `backlog_logs=${r.backlog.logs}`,
    `backlog_results=${r.backlog.results}`,
    `incomplete=${r.incomplete}`,
    `locked=${r.locked}`,
    `overdue_locked=${r.overdueLocked}`,
    ...(r.lockClass === null ? [] : [`lock_class=${r.lockClass}`]),
    `late=${r.late}`,
    `pools_anonymised=${r.poolsAnonymised}`,
    `entries_anonymised=${r.entriesAnonymised}`,
    `runs_expired=${r.runsExpired}`,
    `snapshots_trimmed=${r.snapshotsTrimmed}`,
    `errors=${r.errors.length > 0 ? [...new Set(r.errors)].join(",") : "none"}`,
    ...(r.errorClass === null ? [] : [`class=${r.errorClass}`]),
  ].join(" ");
  const behind = r.backlog.records + r.backlog.logs + r.backlog.results > 0;
  return {
    level: r.errors.length > 0 || r.overdueLocked > 0 || behind ? "error" : "info",
    line,
  };
}
