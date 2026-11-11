/**
 * Ending an account's OpenID Connect grants when a path ends a credential (epic #2014 phase #2019;
 * ADR 0119 rule 12, and rule 15 for what is told to the clients).
 *
 * THE RULE THIS FILE EXISTS TO HOLD (AGENTS.md, "Revocation cascades, always"): ending a credential
 * has to end everything minted from it. A grant and its tokens are minted from an app session, and
 * they outlive it by design (signing out is not withdrawing a partner's access, rule 12), so the paths
 * that END A CREDENTIAL for good have to end them in the statements that end the credential. Before
 * this, a revoked account was refused at every use by the live re-check of status, kind and proof (rule
 * 14) and nothing more: its grant, tokens and codes were live rows, merely suppressed, so putting the
 * status back put the credentials back, and its clients were never told.
 *
 * {@link oidcEndStatements} returns the statements, and EVERY CALLER ADDS THEM TO ITS OWN BATCH. It is
 * four statements, in this order, and the order is load-bearing:
 *
 *   1. QUEUE THE LOGOUTS, from the live grants, before they are revoked. A row per client that has a
 *      back-channel logout address: the INTENT, in the batch that commits the ending. The call to the
 *      partner is never made here, and never inside a batch (a partner's server must not be able to
 *      slow or fail a revocation); the sender reads the row afterwards (`services/oidc-logout.ts`).
 *   2. REVOKE THE ACCOUNT'S LIVE TOKENS, access and refresh, of the grants being ended.
 *   3. REVOKE THE GRANTS. A revoked grant stays for the record and a later sign-in is a NEW row, so an
 *      account that is put back (an approval, a status written by hand) comes back with nothing.
 *   4. DELETE THE ACCOUNT'S UNUSED CODES. A code is sixty seconds of permission to collect tokens,
 *      checked against the account and not against the session that authorized it, so one captured
 *      from a redirect would otherwise be spendable. A USED code is left: it is what a second
 *      redemption is recognized by until it is pruned, and everything it issued is already revoked.
 *
 * `client_id` IN THE GRANT, CODE, TOKEN AND DELIVERY TABLES IS THE `oidc_clients.id` ROW ID, NOT THE
 * PUBLIC `oc_...` STRING. Every join here is `c.id = g.client_id`; a statement written against the
 * public string matches nothing and ends nothing, which is why `oidc-cascade.test.ts` drives each
 * path through the real routes.
 *
 * A FILTER narrows an ending to part of an account's grants: `{rule}` to the grants of the clients that
 * sign people in by that rule (an ORCID unlink or relink, and a change of kind away from `person`, end
 * the `person_proven_orcid` grants, whose proof is gone), and `{scopePrefix}` to the grants that carry
 * a scope with that prefix (a compute suspension ends the grants that carry a `compute.` scope and
 * tells only those clients, so the person stays signed in elsewhere). The filter selects GRANTS, and
 * everything under a grant goes with it: its tokens (whatever scopes they carry, because a grant
 * accumulates the scopes of every sign-in and a token carries only those of its own code), its unused
 * codes, its logout. A compute suspension has no caller yet (its state does not exist; the compute
 * access phase adds the caller), so the filter is shipped and tested directly.
 *
 * EVERY STATEMENT ENDS IN A PREDICATE, and takes its binds left to right, so a caller can append a
 * condition of its own and its binds after these: `tombstoneUserCascade`'s guarded call does, so that
 * a row that changed since it was read loses nothing. A test pins that a predicate appended to each
 * statement is honoured.
 *
 * THE DISABLING OF A CLIENT is the other direction, keyed by the client and not the account, and tells
 * nobody ({@link oidcClientEndStatements}).
 *
 * NOT CALLED, ON PURPOSE, each with its surviving-row test in `oidc-cascade-nonmembership.test.ts`:
 * a role demotion (a token carries no role and no OIDC scope confers admin authority), the revocation
 * of an API key (a grant is not minted from a key), and the app session's sign-out (signing out of NEMAR
 * is not withdrawing a third party's delegated access; this is a departure from ADRs 0021, 0056 and
 * 0079 and marked in ADR 0119 as the owner's decision).
 */

import {
  type OidcEndReason,
  type OidcSignInRule,
  isOidcEndReason,
  isOidcSignInRule,
} from "../../../shared/oidc.js";

/** One statement of the cascade: bind `binds` to `sql`, left to right, and add it to a batch. */
export interface OidcEndStatement {
  sql: string;
  binds: unknown[];
}

/** Which of an account's grants an ending reaches: those of one sign-in rule, or those with a scope prefix. */
export type OidcEndFilter = { rule: OidcSignInRule } | { scopePrefix: string };

/**
 * The paths that call {@link oidcEndStatements}: the list the docblocks below count, and the list
 * `oidc-cascade-callers.test.ts` holds the code to, in both directions. `file` is under `backend/src`.
 * A new path that ends a credential adds a line here AND a row to the table of ADR 0119 rule 12.
 *
 *   finalizeRevocation   an administrator revoked the account, by username or by id (one function)
 *   tombstoneUserCascade the owner's soft delete and the sweep of the live tests' accounts (one function)
 *   unlinkOrcid          the ORCID iD was removed: the `person_proven_orcid` grants end
 *   relinkIdentity       the ORCID iD was replaced: the same grants end
 *   applyKindChange      the account's kind was changed away from `person`: the same grants end
 *   endAccount           the owner's `nemar admin oidc end-account`, the manual merge of ADR 0043 and
 *                        the incident tool
 */
export const OIDC_END_CALLERS = [
  { file: "routes/admin/users.ts", site: "finalizeRevocation" },
  { file: "db/user-tombstone.ts", site: "tombstoneUserCascade" },
  { file: "routes/auth-orcid.ts", site: "unlinkOrcid" },
  { file: "routes/auth-orcid.ts", site: "relinkIdentity" },
  { file: "routes/admin/users.ts", site: "applyKindChange" },
  { file: "routes/admin/oidc.ts", site: "endAccount" },
] as const;

/** The one caller of {@link oidcClientEndStatements}: the owner's disabling of a client. */
export const OIDC_CLIENT_END_CALLERS = [
  { file: "services/oidc-clients.ts", site: "disableClient" },
] as const;

// ---------------------------------------------------------------------------------------------
// The filter
// ---------------------------------------------------------------------------------------------

/** What a filter adds: a conjunct over the grant `g` and its client `c`, and its binds in order. */
interface FilterClause {
  sql: string;
  binds: unknown[];
}

function filterClause(filter: OidcEndFilter | undefined): FilterClause {
  if (filter === undefined) return { sql: "", binds: [] };
  const keys = Object.keys(filter);
  if (keys.length !== 1)
    throw new RangeError("an end filter names exactly one of rule and scopePrefix");
  if ("rule" in filter) {
    if (!isOidcSignInRule(filter.rule))
      throw new RangeError("the filter's rule is not a sign-in rule");
    return { sql: "\n   AND c.sign_in_rule = ?", binds: [filter.rule] };
  }
  if (typeof filter.scopePrefix !== "string" || filter.scopePrefix === "") {
    throw new RangeError("the filter's scopePrefix is empty");
  }
  // `substr` and equality, not LIKE: the prefix is a value, and `%`, `_` and the dot in `compute.` are
  // not wildcards in it. The scopes are a JSON array (`oidc_grants.scopes`), read with `json_each`.
  return {
    sql: "\n   AND EXISTS (SELECT 1 FROM json_each(g.scopes) j WHERE substr(j.value, 1, ?) = ?)",
    binds: [filter.scopePrefix.length, filter.scopePrefix],
  };
}

/** The account's grants that the filter reaches, as a subquery over `g` and `c`. Binds: userId, then the filter's. */
const grantsOfUser = (filter: FilterClause): string =>
  `SELECT g.id FROM oidc_grants g JOIN oidc_clients c ON c.id = g.client_id
       WHERE g.user_id = ?${filter.sql}`;

// ---------------------------------------------------------------------------------------------
// The statements
// ---------------------------------------------------------------------------------------------

const enqueueSql = (filter: FilterClause): string => `INSERT INTO oidc_logout_deliveries
  (client_id, sub, reason, next_attempt_at)
SELECT g.client_id, u.oidc_subject, ?, datetime('now')
  FROM oidc_grants g
  JOIN oidc_clients c ON c.id = g.client_id
  JOIN users u ON u.id = g.user_id
 WHERE g.user_id = ?
   AND g.revoked_at IS NULL
   AND c.status = 'active'
   AND c.backchannel_logout_uri IS NOT NULL${filter.sql}`;

const tokensSql = (filter: FilterClause | null): string => `UPDATE oidc_tokens
   SET revoked_at = datetime('now'), revoked_reason = ?
 WHERE user_id = ?
   AND revoked_at IS NULL${filter ? `\n   AND grant_id IN (${grantsOfUser(filter)})` : ""}`;

const grantsSql = (filter: FilterClause | null): string => `UPDATE oidc_grants
   SET revoked_at = datetime('now')
 WHERE user_id = ?
   AND revoked_at IS NULL${filter ? `\n   AND id IN (${grantsOfUser(filter)})` : ""}`;

const codesSql = (filter: FilterClause | null): string => `DELETE FROM oidc_codes
 WHERE user_id = ?
   AND used_at IS NULL${filter ? `\n   AND grant_id IN (${grantsOfUser(filter)})` : ""}`;

/**
 * Queue one logout delivery for each live grant whose client is active and has a back-channel logout
 * address, from the grants BEFORE they are revoked (it is the first statement for that reason).
 * Binds: reason, userId (then the filter's, if any). `sub` is the account's `users.oidc_subject`, which
 * the tombstone keeps; `next_attempt_at` is D1's `now`, so the sender's first attempt is due at once.
 * No network call, here or in any batch.
 *
 * SIX CALLERS, through {@link oidcEndStatements}, and the count is the point (the list is
 * {@link OIDC_END_CALLERS} and a test holds the code to it): `finalizeRevocation` (admin revoke, by
 * username and by id), the tombstone cascade (`tombstoneUserCascade`, which both the owner's soft delete
 * and the sweep of the live tests' accounts run, so it counts once), the ORCID unlink, the ORCID relink,
 * the change of an account's kind away from `person`, and the owner's `end-account`. A seventh path that
 * ends a credential needs this line too. A compute suspension will be one more when its state exists.
 * The client's disabling is NOT one: it tells nobody ({@link oidcClientEndStatements}).
 */
export const OIDC_ENQUEUE_LOGOUTS_SQL = enqueueSql({ sql: "", binds: [] });

/**
 * Revoke the account's live access and refresh tokens, with the reason of the path (a word of
 * `OIDC_END_REASONS`). Binds: reason, userId (then userId and the filter's, if any). Run BEFORE the
 * grants are revoked, because a filtered ending selects the tokens through their grant.
 *
 * SIX CALLERS: the same six as {@link OIDC_ENQUEUE_LOGOUTS_SQL}, which it always runs beside.
 */
export const OIDC_END_TOKENS_SQL = tokensSql(null);

/**
 * Revoke the account's live grants. A revoked grant stays for the record; a new sign-in is a new row.
 * Binds: userId (then userId and the filter's, if any).
 *
 * SIX CALLERS: the same six as {@link OIDC_ENQUEUE_LOGOUTS_SQL}.
 */
export const OIDC_END_GRANTS_SQL = grantsSql(null);

/**
 * Delete the account's unused authorization codes. A used code is kept: a second redemption is
 * recognized by it. Binds: userId (then userId and the filter's, if any).
 *
 * SIX CALLERS: the same six as {@link OIDC_ENQUEUE_LOGOUTS_SQL}.
 */
export const OIDC_END_CODES_SQL = codesSql(null);

/**
 * The statements that end an account's grants for `reason`, in the order the module comment gives:
 * queue the logouts, revoke the tokens, revoke the grants, delete the unused codes. Add every one to
 * the batch that ends the credential; `{sql, binds}` is the shape of `mailReleaseStatements`. The
 * reason is a word of `OIDC_END_REASONS`, bound and never spliced. A filter narrows the ending (see the
 * module comment); none ends every grant of the account.
 *
 * Throws a `RangeError` for a reason, an account id or a filter that is not one, before building
 * anything: a caller's mistake is found in its own test, never as a statement that ends too much.
 */
export function oidcEndStatements(
  userId: number,
  reason: OidcEndReason,
  filter?: OidcEndFilter,
): OidcEndStatement[] {
  if (!Number.isInteger(userId) || userId < 1) throw new RangeError("userId is not an account id");
  if (!isOidcEndReason(reason)) throw new RangeError("reason is not an end reason");
  const clause = filterClause(filter);
  const filtered = filter === undefined ? null : clause;
  // The filtered subqueries bind the user again, then the filter's values; each is left to right.
  const again = filtered ? [userId, ...clause.binds] : [];
  return [
    {
      sql: enqueueSql(clause),
      binds: [reason, userId, ...clause.binds],
    },
    { sql: tokensSql(filtered), binds: [reason, userId, ...again] },
    { sql: grantsSql(filtered), binds: [userId, ...again] },
    { sql: codesSql(filtered), binds: [userId, ...again] },
  ];
}

// ---------------------------------------------------------------------------------------------
// A client's own ending
// ---------------------------------------------------------------------------------------------

/** The client's row id, from its public id, as a scalar subquery. Binds: the public `oc_...` id. */
const CLIENT_ROW = "(SELECT id FROM oidc_clients WHERE client_id = ?)";

/**
 * Revoke every live token of a client, those issued to an account and those issued to the client
 * itself, with the reason `client_disabled`. Binds: reason, the PUBLIC client id.
 *
 * ONE CALLER: `disableClient` (the owner's disabling of a client), in the batch that sets its status.
 */
export const OIDC_CLIENT_END_TOKENS_SQL = `UPDATE oidc_tokens
   SET revoked_at = datetime('now'), revoked_reason = ?
 WHERE client_id = ${CLIENT_ROW}
   AND revoked_at IS NULL`;

/**
 * Revoke every live grant of a client. Binds: the PUBLIC client id.
 *
 * ONE CALLER: `disableClient`.
 */
export const OIDC_CLIENT_END_GRANTS_SQL = `UPDATE oidc_grants
   SET revoked_at = datetime('now')
 WHERE client_id = ${CLIENT_ROW}
   AND revoked_at IS NULL`;

/**
 * Delete every unused code of a client. Binds: the PUBLIC client id.
 *
 * ONE CALLER: `disableClient`.
 */
export const OIDC_CLIENT_END_CODES_SQL = `DELETE FROM oidc_codes
 WHERE client_id = ${CLIENT_ROW}
   AND used_at IS NULL`;

/**
 * The statements that end everything a client holds: its tokens, its grants and its unused codes.
 * It queues NO logout: the owner has cut the client off, and telling it is not owed (ADR 0119 rule
 * 12). Run in the batch that disables the client, after the status is written; keyed by the client's
 * public id, which each statement resolves to the row id every table stores.
 */
export function oidcClientEndStatements(publicClientId: string): OidcEndStatement[] {
  return [
    { sql: OIDC_CLIENT_END_TOKENS_SQL, binds: ["client_disabled", publicClientId] },
    { sql: OIDC_CLIENT_END_GRANTS_SQL, binds: [publicClientId] },
    { sql: OIDC_CLIENT_END_CODES_SQL, binds: [publicClientId] },
  ];
}
