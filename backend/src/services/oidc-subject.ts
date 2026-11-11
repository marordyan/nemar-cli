/**
 * Resolving an OpenID Connect subject to an account (epic #2014 phase #2015; ADR 0119,
 * decision 5).
 *
 * The subject itself is `users.oidc_subject`, set by migration 0120 (backfill, an insert trigger,
 * and a trigger that aborts any change to a value that is set). Nothing here writes it, and
 * nothing that already answers a request reads it: it is classified `secret` in
 * `USER_COLUMN_ROLES`, so it is in no admin listing, detail or search, and `/users/me` and
 * `/auth/me` select their columns by name and never name it.
 */

import { isOidcSubject } from "../../../shared/oidc-subject.js";

/** The account that holds a subject, and whether it has been deleted. */
export interface SubjectHolder {
  user_id: number;
  /** A deleted account keeps its subject (the tombstone mask never touches the column), so a
   *  subject a partner stored still resolves, and says so. */
  deleted: boolean;
}

/** The statement, exported so a test imports it and does not copy it. */
export const SUBJECT_HOLDER_SQL = "SELECT id, deleted_at FROM users WHERE oidc_subject = ? LIMIT 1";

/**
 * The account a subject belongs to, or null when nobody holds it.
 *
 * A value that is not a subject is answered null without a query (defence in depth: the query is
 * parameterized, so such a string could only ever match nothing). Includes deleted accounts: a subject is never
 * reused, so a deleted holder is still the answer.
 */
export async function holderOfOidcSubject(
  db: D1Database,
  subject: string,
): Promise<SubjectHolder | null> {
  if (!isOidcSubject(subject)) return null;
  const row = await db
    .prepare(SUBJECT_HOLDER_SQL)
    .bind(subject)
    .first<{ id: number; deleted_at: string | null }>();
  return row ? { user_id: row.id, deleted: row.deleted_at !== null } : null;
}

/**
 * The id of the account that holds a subject, or null. See {@link holderOfOidcSubject}.
 *
 * It returns a DELETED account's id too, so it cannot tell a live account from a tombstone. A
 * phase that authenticates or authorizes by `sub` must use {@link holderOfOidcSubject} and check
 * `deleted`, never this.
 */
export async function userIdForOidcSubject(
  db: D1Database,
  subject: string,
): Promise<number | null> {
  return (await holderOfOidcSubject(db, subject))?.user_id ?? null;
}
