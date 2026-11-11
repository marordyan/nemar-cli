/**
 * Legal holds on compute records (epic #2005 phase A7, #2012; ADR 0118; design section 9): a hold on
 * one job, or on every job of one account, that the retention sweep honors.
 *
 * A hold is a row of `compute_legal_holds` (migration 0118): a D1 flag, because R2 has no versioning and
 * no per-object hold, and the records bucket's own lock covers only the retention period. Placing and
 * releasing one is OWNER-ONLY and audited in the same batch as the change; the role is read from the
 * database in the statement itself (a caller that says it is an owner is not believed). A hold is
 * released, never removed. There is at most one active hold per (scope, ref): a second placement is a
 * conflict. `reason` is a fixed word, never free text.
 *
 * `heldSql` is the one predicate "this job is held, by itself or by its account", used by the
 * retention sweep both to choose its candidates and again, per job, immediately before it deletes.
 */

import type { ComputeHoldScope } from "../../../shared/compute-state.js";
import { ACTIVE_ACCOUNT_STATUS_SQL_LIST } from "./account-tier.js";

/** The audit actions. */
export const HOLD_PLACE_ACTION = "compute.hold.place";
export const HOLD_RELEASE_ACTION = "compute.hold.release";

/**
 * Whether a job row (aliased `<alias>`) is held, by a job hold or by a hold on its account. An account
 * hold is on the row's `account_id`, so a job already reduced to anonymous counts (no account) is held
 * only by a hold on the job itself.
 */
export const heldSql = (alias: string): string =>
  `EXISTS (SELECT 1 FROM compute_legal_holds h WHERE h.released_at IS NULL
      AND ((h.scope = 'job' AND h.ref = ${alias}.id)
        OR (h.scope = 'account' AND ${alias}.account_id IS NOT NULL
            AND h.ref = CAST(${alias}.account_id AS TEXT))))`;

/** Place a hold: `?1` scope, `?2` ref, `?3` reason word, `?4` the owner. Only for an owner, and a target that exists. */
export const PLACE_HOLD_SQL = `INSERT INTO compute_legal_holds (scope, ref, reason, placed_by)
  SELECT ?1, ?2, ?3, u.id FROM users u
   WHERE u.id = ?4 AND u.role = 'owner' AND u.deleted_at IS NULL
     AND u.status IN ${ACTIVE_ACCOUNT_STATUS_SQL_LIST}
     AND ((?1 = 'job' AND EXISTS (SELECT 1 FROM compute_jobs j WHERE j.id = ?2))
       OR (?1 = 'account' AND EXISTS (SELECT 1 FROM users a WHERE CAST(a.id AS TEXT) = ?2)))`;

/** The audit row of a placement, written only if the placement was: `?1` actor, `?2` scope, `?3` ref, `?4` reason. */
export const PLACE_HOLD_AUDIT_SQL = `INSERT INTO audit_log (user_id, action, resource_type, resource_id, details)
  SELECT ?1, '${HOLD_PLACE_ACTION}', 'compute_hold', CAST(last_insert_rowid() AS TEXT),
         json_object('scope', ?2, 'ref', ?3, 'reason', ?4)
   WHERE changes() > 0`;

/** Release a hold: `?1` the hold, `?2` the owner. */
export const RELEASE_HOLD_SQL = `UPDATE compute_legal_holds SET released_at = datetime('now')
  WHERE id = ?1 AND released_at IS NULL
    AND EXISTS (SELECT 1 FROM users u WHERE u.id = ?2 AND u.role = 'owner' AND u.deleted_at IS NULL
                  AND u.status IN ${ACTIVE_ACCOUNT_STATUS_SQL_LIST})`;

export const RELEASE_HOLD_AUDIT_SQL = `INSERT INTO audit_log (user_id, action, resource_type, resource_id, details)
  SELECT ?1, '${HOLD_RELEASE_ACTION}', 'compute_hold', CAST(?2 AS TEXT),
         json_object('scope', h.scope, 'ref', h.ref)
    FROM compute_legal_holds h WHERE h.id = ?2 AND changes() > 0`;

/**
 * Whether a user is an owner who may act: the role, not deleted, in an active status. The same terms the
 * placing and releasing statements carry, so a refusal is classified by the rule that made it (a suspended
 * or deleted owner is `not_owner`, never `target_not_found`). `?1` the user.
 */
export const ACTIVE_OWNER_SQL = `SELECT 1 AS ok FROM users u WHERE u.id = ?1 AND u.role = 'owner'
  AND u.deleted_at IS NULL AND u.status IN ${ACTIVE_ACCOUNT_STATUS_SQL_LIST}`;

export interface HoldRow {
  id: number;
  scope: ComputeHoldScope;
  ref: string;
  reason: string;
  placed_by: number;
  placed_at: string;
  released_at: string | null;
}

const HOLD_COLUMNS = "id, scope, ref, reason, placed_by, placed_at, released_at";

export type PlaceHoldResult =
  | { ok: true; hold: HoldRow }
  | { ok: false; code: "not_owner" | "target_not_found" | "hold_exists" };

const looksUnique = (err: unknown) => /UNIQUE constraint failed/i.test(String(err));

/** Place a hold. A second active hold on the same target is `hold_exists`. */
export async function placeHold(
  db: D1Database,
  input: { scope: ComputeHoldScope; ref: string; reason: string; ownerId: number },
): Promise<PlaceHoldResult> {
  let changes = 0;
  try {
    const results = await db.batch([
      db.prepare(PLACE_HOLD_SQL).bind(input.scope, input.ref, input.reason, input.ownerId),
      db.prepare(PLACE_HOLD_AUDIT_SQL).bind(input.ownerId, input.scope, input.ref, input.reason),
    ]);
    changes = results[0]?.meta?.changes ?? 0;
  } catch (err) {
    if (looksUnique(err)) return { ok: false, code: "hold_exists" };
    throw err;
  }
  if (changes === 0) {
    const owner = await db.prepare(ACTIVE_OWNER_SQL).bind(input.ownerId).first();
    return { ok: false, code: owner === null ? "not_owner" : "target_not_found" };
  }
  const hold = await db
    .prepare(
      `SELECT ${HOLD_COLUMNS} FROM compute_legal_holds WHERE scope = ?1 AND ref = ?2 AND released_at IS NULL`,
    )
    .bind(input.scope, input.ref)
    .first<HoldRow>();
  if (hold === null) throw new Error("a hold that was just placed could not be read");
  return { ok: true, hold };
}

export type ReleaseHoldResult =
  | { ok: true; hold: HoldRow }
  | { ok: false; code: "not_owner" | "hold_not_found" };

/** Release a hold (it stays as a row). A hold already released, or none, is `hold_not_found`. */
export async function releaseHold(
  db: D1Database,
  input: { id: number; ownerId: number },
): Promise<ReleaseHoldResult> {
  const results = await db.batch([
    db.prepare(RELEASE_HOLD_SQL).bind(input.id, input.ownerId),
    db.prepare(RELEASE_HOLD_AUDIT_SQL).bind(input.ownerId, input.id),
  ]);
  const changes = results[0]?.meta?.changes ?? 0;
  const hold = await db
    .prepare(`SELECT ${HOLD_COLUMNS} FROM compute_legal_holds WHERE id = ?1`)
    .bind(input.id)
    .first<HoldRow>();
  if (changes === 0 || hold === null) {
    const owner = await db.prepare(ACTIVE_OWNER_SQL).bind(input.ownerId).first();
    return { ok: false, code: owner === null ? "not_owner" : "hold_not_found" };
  }
  return { ok: true, hold };
}

/** The most active holds one listing answers with; a longer list says so (`truncated`). */
export const HOLDS_LIST_MAX = 200;

/**
 * The active holds, oldest first, optionally for one target. One more row than the maximum is read, so
 * a list that is cut says so: a legal hold missing from a list that does not say it is incomplete is
 * the worse failure.
 */
export async function listActiveHolds(
  db: D1Database,
  filter: { scope?: ComputeHoldScope; ref?: string } = {},
): Promise<{ holds: HoldRow[]; truncated: boolean }> {
  const rows = (
    await db
      .prepare(
        `SELECT ${HOLD_COLUMNS} FROM compute_legal_holds
          WHERE released_at IS NULL AND (?1 IS NULL OR scope = ?1) AND (?2 IS NULL OR ref = ?2)
          ORDER BY id ASC LIMIT ?3`,
      )
      .bind(filter.scope ?? null, filter.ref ?? null, HOLDS_LIST_MAX + 1)
      .all<HoldRow>()
  ).results;
  return { holds: rows.slice(0, HOLDS_LIST_MAX), truncated: rows.length > HOLDS_LIST_MAX };
}
