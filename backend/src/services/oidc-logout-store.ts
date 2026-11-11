/**
 * The statements behind the back-channel logout deliveries (epic #2014 phase #2019; ADR 0119 rule
 * 15; migration 0124): what is due, the claim of an attempt, what an attempt records, and what the
 * owner reads. The sender is `services/oidc-logout.ts`; the rows are QUEUED by the cascade
 * (`OIDC_ENQUEUE_LOGOUTS_SQL` in `services/oidc-cascade.ts`), inside the batch that ends the grants.
 *
 * EVERY TIME IS D1'S, in the statement: `datetime('now')` and a modifier bound as seconds, never a JS
 * `toISOString()` (the two compare unequally on the same day, the trap ADR 0047 records), so a row's
 * `next_attempt_at` and the question "is it due" are measured by one clock.
 *
 * AN ATTEMPT IS CLAIMED BEFORE IT IS MADE, and its answer is recorded only by the attempt that holds the
 * claim. The claim moves `next_attempt_at` to the end of a lease (`OIDC_LOGOUT_LEASE_SECONDS`), counts
 * the attempt and stamps the `jti` of the token about to be sent, all in one conditional UPDATE whose
 * `meta.changes` is the winner test: of two runners that read the same due row (the first attempt after
 * a commit and the retry tick, or two ticks) exactly one sends. The record then names that `jti`, so an
 * attempt that outlived its lease cannot overwrite the answer of a newer one. An attempt that never
 * records, because the isolate was evicted, is taken up again when its lease lapses; it was counted when
 * it was claimed, so the retries stay bounded.
 */

import {
  OIDC_LOGOUT_FAILED_RETENTION_DAYS,
  OIDC_LOGOUT_FENCED_RETENTION_DAYS,
  OIDC_LOGOUT_LEASE_SECONDS,
  OIDC_LOGOUT_MAX_ATTEMPTS,
  OIDC_LOGOUT_PRUNE_PER_TICK,
  OIDC_LOGOUT_SENT_RETENTION_DAYS,
  type OidcLogoutErrorClass,
  type OidcLogoutStatus,
} from "../../../shared/oidc.js";

/** A delivery that is due, with what the sender needs of its client. `client_*` is null when the client row is gone. */
export interface DueDelivery {
  id: number;
  /** The attempts already CLAIMED: 0 for a delivery never tried. */
  attempts: number;
  sub: string;
  client_public: string | null;
  client_status: string | null;
  uri: string | null;
}

const DUE_COLUMNS = `d.id, d.attempts, d.sub, c.client_id AS client_public, c.status AS client_status,
       c.backchannel_logout_uri AS uri`;

/**
 * The pending deliveries that are due, oldest first. Binds: limit. Reads the partial index over pending
 * rows, so it costs the number of rows waiting and not the number ever queued.
 */
export const DUE_DELIVERIES_SQL = `SELECT ${DUE_COLUMNS}
  FROM oidc_logout_deliveries d
  LEFT JOIN oidc_clients c ON c.id = d.client_id
 WHERE d.status = 'pending' AND d.next_attempt_at <= datetime('now')
 ORDER BY d.next_attempt_at, d.id
 LIMIT ?`;

/**
 * The same, for one account: the first attempt after a commit asks only about the account whose grants
 * just ended. Binds: userId, limit. The subject is the account's `users.oidc_subject`, which the
 * tombstone keeps, so a deleted account is found by it as well.
 */
export const DUE_DELIVERIES_FOR_USER_SQL = `SELECT ${DUE_COLUMNS}
  FROM oidc_logout_deliveries d
  LEFT JOIN oidc_clients c ON c.id = d.client_id
 WHERE d.status = 'pending' AND d.next_attempt_at <= datetime('now')
   AND d.sub = (SELECT oidc_subject FROM users WHERE id = ?)
 ORDER BY d.next_attempt_at, d.id
 LIMIT ?`;

/**
 * Claim the next attempt of a delivery: count it, hold the row for the lease, stamp the token's `jti`.
 * Binds: leaseSeconds, jti, id, attemptsAsRead. Changes one row for the runner that wins, none for one
 * that lost (another claimed first, the row is no longer due, or it is no longer pending).
 */
export const CLAIM_DELIVERY_SQL = `UPDATE oidc_logout_deliveries
   SET attempts = attempts + 1,
       next_attempt_at = datetime('now', '+' || ? || ' seconds'),
       jti = ?
 WHERE id = ? AND status = 'pending' AND attempts = ?
   AND next_attempt_at <= datetime('now')`;

/**
 * Record the answer of a claimed attempt: a status, and for a `pending` row the time of its next
 * attempt. Binds: status, status, retryDelaySeconds, lastStatus, errorClass, status, id, jti.
 * Conditional on the claim (`jti`), so only the attempt that holds it records, and only once.
 * `sent_at` is set exactly for `sent` and `next_attempt_at` exactly for `pending`, as the table's CHECKs
 * require.
 */
export const RECORD_ATTEMPT_SQL = `UPDATE oidc_logout_deliveries
   SET status = ?,
       next_attempt_at = CASE WHEN ? = 'pending' THEN datetime('now', '+' || ? || ' seconds') END,
       last_status = ?,
       last_error_class = ?,
       sent_at = CASE WHEN ? = 'sent' THEN datetime('now') END
 WHERE id = ? AND status = 'pending' AND jti = ?`;

/**
 * Finish a delivery that is not to be sent at all (fenced, or refused before any attempt): no attempt is
 * counted and nothing is claimed, and the row must still be due, so a runner that holds a claim on it is
 * not overwritten. Binds: status (`fenced` or `failed`), errorClass, id.
 */
export const FINISH_WITHOUT_SEND_SQL = `UPDATE oidc_logout_deliveries
   SET status = ?, next_attempt_at = NULL, last_error_class = ?
 WHERE id = ? AND status = 'pending' AND next_attempt_at <= datetime('now')`;

/** What an attempt found, in the words the table records. */
export interface AttemptRecord {
  status: OidcLogoutStatus;
  /** For `pending`: the wait before the next attempt. */
  retryDelaySeconds: number;
  lastStatus: number | null;
  errorClass: OidcLogoutErrorClass | null;
}

/** Claim the next attempt; true for the runner that won it. */
export async function claimDelivery(
  db: D1Database,
  id: number,
  attemptsAsRead: number,
  jti: string,
): Promise<boolean> {
  if (attemptsAsRead >= OIDC_LOGOUT_MAX_ATTEMPTS) return false;
  const result = await db
    .prepare(CLAIM_DELIVERY_SQL)
    .bind(OIDC_LOGOUT_LEASE_SECONDS, jti, id, attemptsAsRead)
    .run();
  return (result.meta?.changes ?? 0) === 1;
}

/** Record a claimed attempt's answer. False when the claim was no longer this attempt's. */
export async function recordAttempt(
  db: D1Database,
  id: number,
  jti: string,
  record: AttemptRecord,
): Promise<boolean> {
  const result = await db
    .prepare(RECORD_ATTEMPT_SQL)
    .bind(
      record.status,
      record.status,
      record.retryDelaySeconds,
      record.lastStatus,
      record.errorClass,
      record.status,
      id,
      jti,
    )
    .run();
  return (result.meta?.changes ?? 0) === 1;
}

/**
 * A delivery that is not to be sent, with the one class that goes with each status: `fenced` is always
 * `fenced`, and `failed` is one of the three that need no attempt. The pairs are the only ones that can be
 * written, so a wrong pairing is a type error and not a row.
 */
export type NotSent =
  | { status: "fenced"; errorClass: "fenced" }
  | { status: "failed"; errorClass: "address_refused" | "client_disabled" | "unreported" };

/** Finish a delivery that is not to be sent. False when the row was claimed or finished meanwhile. */
export async function finishWithoutSend(
  db: D1Database,
  id: number,
  outcome: NotSent,
): Promise<boolean> {
  const result = await db
    .prepare(FINISH_WITHOUT_SEND_SQL)
    .bind(outcome.status, outcome.errorClass, id)
    .run();
  return (result.meta?.changes ?? 0) === 1;
}

/** Due deliveries for the tick (all accounts) or for one account. */
export async function dueDeliveries(
  db: D1Database,
  limit: number,
  userId?: number,
): Promise<DueDelivery[]> {
  const statement =
    userId === undefined
      ? db.prepare(DUE_DELIVERIES_SQL).bind(limit)
      : db.prepare(DUE_DELIVERIES_FOR_USER_SQL).bind(userId, limit);
  const { results } = await statement.all<DueDelivery>();
  return results ?? [];
}

// ---------------------------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------------------------

/**
 * Delete finished deliveries past their window, oldest first, at most a tick's worth. Binds: sentDays,
 * fencedDays, failedDays, limit. A `sent` row is aged by `sent_at`, a `fenced` or `failed` row by
 * `created_at` (the table has no last-update column; see `OIDC_LOGOUT_SENT_RETENTION_DAYS`). A `pending` row,
 * which is also what an attempt in flight is, matches none of the three branches and is NEVER deleted,
 * whatever its age. The windows are the owner's to set and are bound, so they live in one place.
 */
export const PRUNE_DELIVERIES_SQL = `DELETE FROM oidc_logout_deliveries
 WHERE id IN (
   SELECT id FROM oidc_logout_deliveries
    WHERE (status = 'sent' AND sent_at < datetime('now', '-' || ? || ' days'))
       OR (status = 'fenced' AND created_at < datetime('now', '-' || ? || ' days'))
       OR (status = 'failed' AND created_at < datetime('now', '-' || ? || ' days'))
    ORDER BY id
    LIMIT ?)`;

/** Prune once, with the windows of `shared/oidc.ts`; returns how many rows went. */
export async function pruneDeliveries(db: D1Database): Promise<number> {
  const result = await db
    .prepare(PRUNE_DELIVERIES_SQL)
    .bind(
      OIDC_LOGOUT_SENT_RETENTION_DAYS,
      OIDC_LOGOUT_FENCED_RETENTION_DAYS,
      OIDC_LOGOUT_FAILED_RETENTION_DAYS,
      OIDC_LOGOUT_PRUNE_PER_TICK,
    )
    .run();
  return result.meta?.changes ?? 0;
}

// ---------------------------------------------------------------------------------------------
// The owner's read view
// ---------------------------------------------------------------------------------------------

/**
 * The deliveries as the owner reads them, newest first. Binds: status (or NULL for every status), status,
 * limit. The client is shown by its PUBLIC id (NULL when its row is gone); no token, no address and no
 * partner text is in any column.
 */
export const LIST_DELIVERIES_SQL = `SELECT d.id, c.client_id AS client_id, d.sub, d.reason, d.status,
       d.attempts, d.next_attempt_at, d.last_status, d.last_error_class, d.jti, d.created_at, d.sent_at
  FROM oidc_logout_deliveries d
  LEFT JOIN oidc_clients c ON c.id = d.client_id
 WHERE (? IS NULL OR d.status = ?)
 ORDER BY d.id DESC
 LIMIT ?`;

/** How many deliveries there are of each status, whatever the filter and the limit. */
export const COUNT_DELIVERIES_SQL =
  "SELECT status, COUNT(*) AS n FROM oidc_logout_deliveries GROUP BY status";
