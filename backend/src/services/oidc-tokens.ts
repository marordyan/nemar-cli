/**
 * The token store and the token endpoint's three grants (epic #2014 phase #2018; ADR 0119 rules 1,
 * 3, 4, 12 and 13). The routes are `routes/oauth.ts`; the table is migration 0123.
 *
 * TOKENS ARE OPAQUE AND STORED ONLY AS THEIR SHA-256. `nmo_at_` (access) and `nmo_rt_` (refresh)
 * plus 256 random bits as unpadded base64url. The value is in the one response that issues it and
 * nowhere else; a token is found by `hashApiKey`, the hash every NEMAR credential is stored by. With
 * 256 random bits there is nothing to guess, so no slow hash and no key: a stolen table yields no
 * token. Nothing here logs a token, a code, a verifier or a secret.
 *
 * EVERY DECISION IS D1'S, IN THE STATEMENT THAT WRITES. A read before a batch only chooses which
 * batch to send and says why a request failed; the batch's own WHERE clauses re-read the code, the
 * client, the grant and the account and decide, and `meta.changes` of the statement that mints is the
 * winner. A refused mint writes nothing.
 *
 *   AUTHORIZATION CODE. The code is read once. The PKCE verifier is checked against its S256
 *   challenge and the redirect address exactly, in constant time, and a mismatch writes nothing,
 *   whether or not the code is used. Then one batch (which a used code loses, see below):
 *   the access token is inserted only while the code is unused and live, is this client's, and its
 *   client, grant and account still pass (`CODE_CLAIM_PREDICATE`, the claim of the issue verbatim,
 *   plus the gates); the refresh token only beside that access token; and the code is marked used
 *   only when this request's access token row exists. So two redemptions in flight cannot both mint,
 *   and a redemption whose gates failed spends nothing. A code that lost the claim and is used by now
 *   is a SECOND REDEMPTION: every token issued from it is revoked (`code_replay`), and nothing else
 *   is written. Tokens carry the CODE's scopes, never the grant's (which accumulate).
 *
 *   REFRESH. One batch rotates: the child refresh token is inserted only while the parent is live,
 *   unrevoked, this client's, its grant, client and account still pass, and EITHER the parent is
 *   unspent with no child yet, OR it was spent under 30 seconds ago and has exactly one child (the
 *   retried request: one more child, never two); the access token is inserted beside that child; and
 *   the parent is marked spent if it was not already, so the grace is measured from the first
 *   rotation. The retry is honoured only while the first child is untouched (neither rotated nor
 *   revoked). THE CHILDREN OF ONE PARENT ARE MUTUALLY EXCLUSIVE: rotating one of them revokes its
 *   live siblings (`refresh_superseded`) in the same batch, so the retry's second child and the first
 *   can never both go on rotating; whichever is presented first wins, and the other one, presented
 *   later, is a revoked token. A retry that comes after the first child was rotated or revoked is
 *   reuse. A parent that is revoked, or spent and past the grace, or
 *   already retried, revokes its whole family (`refresh_reuse`), in a statement that re-checks that
 *   very condition. A refresh
 *   token keeps its scopes; the access token gets the scopes asked for, which may only narrow. The
 *   child expires 30 days after it is minted and never after the family's absolute expiry, which
 *   every rotation copies from the family's first token (90 days after the code was redeemed).
 *
 *   CLIENT CREDENTIALS. One access token for the client's machine-only scopes (`compute.stats`):
 *   no account, no grant, no family, no identity token, no refresh token.
 *
 * `client_id` IN THESE TABLES IS THE `oidc_clients.id` ROW ID, NOT THE PUBLIC `oc_...` STRING.
 */

import type { OIDC_TOKEN_ERROR_CODES } from "../../../shared/oidc.js";
import {
  OIDC_ACCESS_TOKEN_PREFIX,
  OIDC_ACCESS_TOKEN_TTL_SECONDS,
  OIDC_END_REASONS,
  OIDC_ID_TOKEN_TTL_SECONDS,
  OIDC_REFRESH_GRACE_SECONDS,
  OIDC_REFRESH_TOKEN_ABSOLUTE_SECONDS,
  OIDC_REFRESH_TOKEN_IDLE_SECONDS,
  OIDC_REFRESH_TOKEN_PREFIX,
  OIDC_SCOPES,
  type OidcTokenErrorCode,
  isMachineOnlyScope,
  isOidcScope,
} from "../../../shared/oidc.js";
import { timingSafeEqual } from "../lib/constant-time.js";
import type { Bindings } from "../types/bindings.js";
import { hashGrantCode } from "./docs-auth.js";
import { ACCOUNT_CLAIM_COLUMNS, type ClaimAccount, claimsForScopes } from "./oidc-claims.js";
import { type AuthenticatedClient, stillFirstParty } from "./oidc-clients.js";
import { oidcIssuer } from "./oidc-config.js";
import { randomHex, toBase64Url } from "./oidc-encoding.js";
import { SIGN_IN_RULE_SQL } from "./oidc-identity.js";
import { signJwt } from "./oidc-keys.js";
import { hashApiKey } from "./token.js";

type TokenEnv = Pick<Bindings, "DB" | "ENVIRONMENT" | "API_BASE_URL" | "OIDC_SECRET">;

// ---------------------------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------------------------

/** `nmo_at_` or `nmo_rt_` plus 256 random bits as 43 unpadded base64url characters. */
export function generateOidcToken(kind: "access" | "refresh"): string {
  const prefix = kind === "access" ? OIDC_ACCESS_TOKEN_PREFIX : OIDC_REFRESH_TOKEN_PREFIX;
  return `${prefix}${toBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

/** The SHA-256 a token is stored and found by: 64 lowercase hex characters. */
export function hashOidcToken(token: string): Promise<string> {
  return hashApiKey(token);
}

/** The scopes only a machine may hold, as JSON, for the statements that refuse them. */
const MACHINE_ONLY_SCOPES_JSON = JSON.stringify(
  OIDC_SCOPES.filter((s) => s.machineOnly).map((s) => s.name),
);

/** `base64url(left half of SHA-256(token))`: the identity token's `at_hash` for ES256. */
async function atHash(accessToken: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(accessToken));
  return toBase64Url(new Uint8Array(digest).slice(0, 16));
}

/**
 * The fixed words a token's `revoked_reason` holds, declared once; every statement that revokes a
 * token writes one of them, here and in `services/oidc-cascade.ts`. The table checks only the shape,
 * so a new word needs no migration.
 *
 *   code_replay         its code was redeemed a second time
 *   refresh_reuse       a spent, revoked or already retried refresh token of its family was presented
 *   refresh_superseded  a sibling (another child of the same parent) was rotated first
 *   client_revoked      its client revoked it (RFC 7009)
 *   client_disabled     the owner disabled its client, which revokes everything the client holds
 *
 * and the words of the paths that end an account's grants (phase #2019), `OIDC_END_REASONS` in
 * `shared/oidc.ts`: `account_revoked`, `account_deleted`, `account_merged`, `compute_suspended`,
 * `orcid_changed` and `kind_changed`.
 */
export const OIDC_TOKEN_REVOKE_REASONS = [
  "code_replay",
  "refresh_reuse",
  "refresh_superseded",
  "client_revoked",
  "client_disabled",
  ...OIDC_END_REASONS,
] as const;
export type OidcTokenRevokeReason = (typeof OIDC_TOKEN_REVOKE_REASONS)[number];

/** A reason as a SQL literal; the words are this module's constants, never input. */
const reason = (word: OidcTokenRevokeReason): string => `'${word}'`;

// ---------------------------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------------------------

/**
 * Delete what no rule reads any more: an access token a day past its expiry, and a refresh token a
 * day past its FAMILY's absolute expiry. A spent refresh token is kept that long because presenting
 * it again is how reuse is detected. Run at the head of every batch that mints.
 */
export const TOKENS_PRUNE_SQL = `DELETE FROM oidc_tokens
 WHERE (kind = 'access' AND expires_at < datetime('now', '-1 day'))
    OR (kind = 'refresh' AND absolute_expires_at < datetime('now', '-1 day'))`;

/** A code as the token endpoint checks it before the batch, with D1's clock. */
export const CODE_READ_SQL = `SELECT k.id, k.client_id, k.redirect_uri, k.scopes, k.nonce,
       k.code_challenge,
       CAST(strftime('%s', k.auth_time) AS INTEGER) AS auth_time_unix,
       CAST(strftime('%s', 'now') AS INTEGER) AS now_unix
  FROM oidc_codes k WHERE k.code_hash = ?`;

/**
 * The account a code names, read before the batch for the identity token's claims. The batch's own
 * gates read the account again, so a change in between mints nothing; at worst the claims of a token
 * that was then not minted are discarded with it.
 */
export const CODE_ACCOUNT_SQL = `SELECT ${ACCOUNT_CLAIM_COLUMNS}
  FROM oidc_codes k JOIN users u ON u.id = k.user_id WHERE k.id = ?`;

/**
 * What must still hold for a code (aliased `k`) to mint: its client (`c`) is active and allowed the
 * authorization code grant, its account (`u`) has a subject and passes the client's sign-in rule,
 * its grant (`g`) is live and is this account's to this client, and every scope it carries is one the
 * grant and the client allow and none is machine-only. One machine-only JSON list bound.
 */
const CODE_GATES = `c.status = 'active'
   AND EXISTS (SELECT 1 FROM json_each(c.allowed_grants) WHERE value = 'authorization_code')
   AND u.oidc_subject IS NOT NULL
   AND ${SIGN_IN_RULE_SQL}
   AND g.revoked_at IS NULL
   -- Defence in depth over the join on the code's grant id: the grant must be this account's, to this
   -- client (no route writes a code whose grant is not; a store test holds the rule anyway).
   AND g.user_id = k.user_id AND g.client_id = k.client_id
   AND NOT EXISTS (SELECT 1 FROM json_each(k.scopes) s
                    WHERE s.value NOT IN (SELECT value FROM json_each(g.scopes))
                       OR s.value NOT IN (SELECT value FROM json_each(c.allowed_scopes))
                       OR s.value IN (SELECT value FROM json_each(?)))`;

/**
 * The claim of a code, as the issue states it: this hash, this client, unused, unexpired, by D1's
 * clock. It gates the access token's INSERT below, so the claim and the mint are one statement.
 */
export const CODE_CLAIM_PREDICATE = `k.code_hash = ? AND k.client_id = ? AND k.used_at IS NULL
   AND k.expires_at > datetime('now')`;

/**
 * Mint the access token of a code, or nothing. Binds: token hash, family id, lifetime in seconds,
 * code hash, client row id, the machine-only scopes. The token carries the code's scopes, its
 * client's audience, and the code's id (so a second redemption finds it).
 */
export const ACCESS_FROM_CODE_SQL = `INSERT INTO oidc_tokens
    (token_hash, kind, client_id, user_id, grant_id, code_id, family_id, audience, scopes, expires_at)
  SELECT ?, 'access', k.client_id, k.user_id, k.grant_id, k.id, ?, c.audience, k.scopes,
         datetime('now', '+' || ? || ' seconds')
    FROM oidc_codes k
    JOIN oidc_clients c ON c.id = k.client_id
    JOIN users u ON u.id = k.user_id
    JOIN oidc_grants g ON g.id = k.grant_id
   WHERE ${CODE_CLAIM_PREDICATE}
     AND ${CODE_GATES}`;

/**
 * Mint the refresh token of a code beside its access token, or nothing. Binds: token hash, idle
 * lifetime, absolute lifetime, the access token's hash. Only when the code carries `offline_access`
 * and the client is allowed the refresh token grant (ADR 0119 rule 3).
 */
export const REFRESH_FROM_CODE_SQL = `INSERT INTO oidc_tokens
    (token_hash, kind, client_id, user_id, grant_id, code_id, family_id, audience, scopes,
     expires_at, absolute_expires_at)
  SELECT ?, 'refresh', a.client_id, a.user_id, a.grant_id, a.code_id, a.family_id, a.audience,
         k.scopes, datetime('now', '+' || ? || ' seconds'), datetime('now', '+' || ? || ' seconds')
    FROM oidc_tokens a
    JOIN oidc_codes k ON k.id = a.code_id
    JOIN oidc_clients c ON c.id = a.client_id
   WHERE a.token_hash = ? AND a.kind = 'access'
     AND EXISTS (SELECT 1 FROM json_each(k.scopes) WHERE value = 'offline_access')
     AND EXISTS (SELECT 1 FROM json_each(c.allowed_grants) WHERE value = 'refresh_token')`;

/**
 * Mark a code used, only when THIS request's access token was minted from it in the same batch.
 * Binds: code id, the access token's hash.
 */
export const CODE_SPEND_SQL = `UPDATE oidc_codes SET used_at = datetime('now')
 WHERE id = ?
   AND EXISTS (SELECT 1 FROM oidc_tokens t WHERE t.token_hash = ? AND t.code_id = oidc_codes.id)`;

/** Whether a code of this client is used by now. Binds: code hash, client row id. */
export const CODE_USED_SQL = `SELECT 1 AS used FROM oidc_codes
 WHERE code_hash = ? AND client_id = ? AND used_at IS NOT NULL`;

/**
 * A second redemption: revoke every token issued from the code, and write nothing else. Every token
 * of a family carries the family's `code_id`, rotations included. Conditioned on the code being this
 * client's and used, so the statement itself re-checks why it runs. Binds: code hash, client row id.
 */
export const CODE_REPLAY_REVOKE_SQL = `UPDATE oidc_tokens
   SET revoked_at = datetime('now'), revoked_reason = ${reason("code_replay")}
 WHERE revoked_at IS NULL
   AND code_id = (SELECT id FROM oidc_codes
                   WHERE code_hash = ? AND client_id = ? AND used_at IS NOT NULL)`;

/** A refresh token as the token endpoint reads it before the batch. */
export const REFRESH_READ_SQL = `SELECT t.id, t.client_id, t.scopes, g.consent_kind
  FROM oidc_tokens t LEFT JOIN oidc_grants g ON g.id = t.grant_id
 WHERE t.token_hash = ? AND t.kind = 'refresh'`;

/**
 * Rotate: mint the child refresh token of the parent aliased `p`, or nothing. Binds: child hash, idle
 * lifetime, parent id, client row id, the grant's consent kind as read, the scopes asked for (JSON),
 * grace seconds. The child keeps the parent's scopes, family, code and absolute expiry, and expires
 * at the earlier of its idle lifetime and the family's end.
 */
export const REFRESH_CHILD_SQL = `INSERT INTO oidc_tokens
    (token_hash, kind, client_id, user_id, grant_id, code_id, family_id, parent_id, audience,
     scopes, expires_at, absolute_expires_at)
  SELECT ?, 'refresh', p.client_id, p.user_id, p.grant_id, p.code_id, p.family_id, p.id,
         c.audience, p.scopes,
         min(datetime('now', '+' || ? || ' seconds'), p.absolute_expires_at), p.absolute_expires_at
    FROM oidc_tokens p
    JOIN oidc_clients c ON c.id = p.client_id
    JOIN users u ON u.id = p.user_id
    JOIN oidc_grants g ON g.id = p.grant_id
   WHERE p.id = ? AND p.kind = 'refresh' AND p.client_id = ?
     AND p.revoked_at IS NULL
     AND p.expires_at > datetime('now') AND p.absolute_expires_at > datetime('now')
     AND c.status = 'active'
     AND EXISTS (SELECT 1 FROM json_each(c.allowed_grants) WHERE value = 'refresh_token')
     AND g.revoked_at IS NULL AND g.user_id = p.user_id AND g.client_id = p.client_id
     AND g.consent_kind = ?
     AND u.oidc_subject IS NOT NULL
     AND ${SIGN_IN_RULE_SQL}
     AND EXISTS (SELECT 1 FROM json_each(p.scopes) WHERE value = 'offline_access')
     AND NOT EXISTS (SELECT 1 FROM json_each(p.scopes) s
                      WHERE s.value NOT IN (SELECT value FROM json_each(g.scopes))
                         OR s.value NOT IN (SELECT value FROM json_each(c.allowed_scopes)))
     AND NOT EXISTS (SELECT 1 FROM json_each(?) r
                      WHERE r.value NOT IN (SELECT value FROM json_each(p.scopes)))
     AND ((p.used_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM oidc_tokens k WHERE k.parent_id = p.id AND k.kind = 'refresh'))
       OR (p.used_at > datetime('now', '-' || ? || ' seconds')
           AND (SELECT COUNT(*) FROM oidc_tokens k
                 WHERE k.parent_id = p.id AND k.kind = 'refresh') = 1
           -- The retry is a retry only while the first child is untouched: once it was rotated or
           -- revoked, a second child would be a branch the sibling rule can no longer reach.
           AND NOT EXISTS (SELECT 1 FROM oidc_tokens k
                            WHERE k.parent_id = p.id AND k.kind = 'refresh'
                              AND (k.used_at IS NOT NULL OR k.revoked_at IS NOT NULL))))`;

/**
 * Mint the access token of a rotation beside the child, or nothing. Binds: token hash, the scopes
 * asked for (JSON), lifetime in seconds, the child's hash.
 */
export const ACCESS_FROM_REFRESH_SQL = `INSERT INTO oidc_tokens
    (token_hash, kind, client_id, user_id, grant_id, code_id, family_id, parent_id, audience,
     scopes, expires_at)
  SELECT ?, 'access', r.client_id, r.user_id, r.grant_id, r.code_id, r.family_id, r.parent_id,
         r.audience, ?, datetime('now', '+' || ? || ' seconds')
    FROM oidc_tokens r WHERE r.token_hash = ? AND r.kind = 'refresh'`;

/**
 * Spend the parent, if it is not spent already, only when this request's child of it exists. A
 * retried request leaves the first rotation's time alone, so the grace never stretches. Binds:
 * parent id, the child's hash.
 */
export const REFRESH_SPEND_SQL = `UPDATE oidc_tokens SET used_at = datetime('now')
 WHERE id = ? AND used_at IS NULL
   AND EXISTS (SELECT 1 FROM oidc_tokens k WHERE k.token_hash = ? AND k.parent_id = oidc_tokens.id)`;

/**
 * Siblings: revoke the live refresh tokens that share the presented token's parent, other than the
 * presented token, only when this request's child of the presented token exists. The retry of rule
 * 13 gives a parent a second child only while the first is untouched (`REFRESH_CHILD_SQL`); this makes
 * the two mutually exclusive, so whichever is rotated first wins and the other, presented later, is a
 * revoked token whose presentation revokes the family. A sibling is therefore never spent when this
 * runs, and none is spared for being spent. Their access tokens are left to expire (at most 15
 * minutes): one of them may be the one the session that rotated is still using. A family's first
 * token has no parent and no sibling. Binds: presented token id (three times), the child's hash.
 */
export const REFRESH_SIBLINGS_REVOKE_SQL = `UPDATE oidc_tokens
   SET revoked_at = datetime('now'), revoked_reason = ${reason("refresh_superseded")}
 WHERE kind = 'refresh' AND revoked_at IS NULL
   AND parent_id = (SELECT parent_id FROM oidc_tokens WHERE id = ?)
   AND id <> ?
   AND EXISTS (SELECT 1 FROM oidc_tokens k WHERE k.token_hash = ? AND k.parent_id = ?)`;

/**
 * Reuse: revoke the presented token's whole family, access tokens included, when that token is
 * revoked, or spent and past the grace, or already retried once, or spent with a child that was
 * itself rotated or revoked since (the retry's own refusal, mirrored). The condition is re-checked here,
 * so a rotation that failed for another reason (an inactive account, a revoked grant) revokes
 * nothing. Binds: the token's id, client row id, grace seconds.
 */
export const REFRESH_REUSE_REVOKE_SQL = `UPDATE oidc_tokens
   SET revoked_at = datetime('now'), revoked_reason = ${reason("refresh_reuse")}
 WHERE revoked_at IS NULL
   AND family_id = (SELECT p.family_id FROM oidc_tokens p
                     WHERE p.id = ? AND p.kind = 'refresh' AND p.client_id = ?
                       AND (p.revoked_at IS NOT NULL
                         OR (p.used_at IS NOT NULL
                           AND (p.used_at <= datetime('now', '-' || ? || ' seconds')
                             OR (SELECT COUNT(*) FROM oidc_tokens k
                                  WHERE k.parent_id = p.id AND k.kind = 'refresh') >= 2
                             OR EXISTS (SELECT 1 FROM oidc_tokens k
                                         WHERE k.parent_id = p.id AND k.kind = 'refresh'
                                           AND (k.used_at IS NOT NULL
                                             OR k.revoked_at IS NOT NULL))))))`;

/**
 * A client credentials token, or nothing. Binds: token hash, scopes (JSON), lifetime in seconds,
 * client row id. The client is re-read: active, allowed the grant, allowed every scope.
 */
export const CLIENT_CREDENTIALS_SQL = `INSERT INTO oidc_tokens
    (token_hash, kind, client_id, audience, scopes, expires_at)
  SELECT ?, 'access', c.id, c.audience, ?, datetime('now', '+' || ? || ' seconds')
    FROM oidc_clients c
   WHERE c.id = ? AND c.status = 'active'
     AND EXISTS (SELECT 1 FROM json_each(c.allowed_grants) WHERE value = 'client_credentials')
     AND NOT EXISTS (SELECT 1 FROM json_each(?) r
                      WHERE r.value NOT IN (SELECT value FROM json_each(c.allowed_scopes)))`;

/**
 * A token as every reader of one sees it, with whether it is ACTIVE NOW: not revoked, not expired,
 * not spent, its client active, and, for an account's token, its grant live and its account passing
 * the client's sign-in rule, read live from `users` and never from the token row (ADR 0119 rule 12).
 * The account's claim columns come with it, read in the same statement as the decision.
 */
export const TOKEN_LOOKUP_SQL = `SELECT t.id, t.kind, t.client_id AS client_row_id,
       c.client_id AS client_public_id, t.user_id, t.scopes, t.audience,
       CAST(strftime('%s', t.created_at) AS INTEGER) AS iat,
       CAST(strftime('%s', t.expires_at) AS INTEGER) AS exp,
       ${ACCOUNT_CLAIM_COLUMNS},
       CASE WHEN t.revoked_at IS NULL AND t.used_at IS NULL AND t.expires_at > datetime('now')
                 AND c.status = 'active'
                 AND (t.user_id IS NULL
                   OR (g.id IS NOT NULL AND g.revoked_at IS NULL
                       AND g.user_id = t.user_id AND g.client_id = t.client_id
                       AND u.id IS NOT NULL AND u.oidc_subject IS NOT NULL
                       AND ${SIGN_IN_RULE_SQL}))
            THEN 1 ELSE 0 END AS active
  FROM oidc_tokens t
  JOIN oidc_clients c ON c.id = t.client_id
  LEFT JOIN users u ON u.id = t.user_id
  LEFT JOIN oidc_grants g ON g.id = t.grant_id
 WHERE t.token_hash = ?`;

/** Revoke one access token of this client (RFC 7009). Binds: token hash, client row id. */
export const REVOKE_ACCESS_SQL = `UPDATE oidc_tokens
   SET revoked_at = datetime('now'), revoked_reason = ${reason("client_revoked")}
 WHERE token_hash = ? AND client_id = ? AND kind = 'access' AND revoked_at IS NULL`;

/**
 * Revoke the family of one refresh token of this client, access tokens included (RFC 7009 section
 * 2.1). Binds: token hash, client row id.
 */
export const REVOKE_FAMILY_SQL = `UPDATE oidc_tokens
   SET revoked_at = datetime('now'), revoked_reason = ${reason("client_revoked")}
 WHERE revoked_at IS NULL
   AND family_id = (SELECT family_id FROM oidc_tokens
                     WHERE token_hash = ? AND client_id = ? AND kind = 'refresh')`;

// ---------------------------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------------------------

/** An error of RFC 6749 section 5.2, as the route answers it. */
export type OAuthErrorCode = OidcTokenErrorCode;

/**
 * Compile-time guard, checked by `tsc -p backend`: the Worker's error type is exactly the declared list,
 * so a word added here without being added to `OIDC_TOKEN_ERROR_CODES` (or the reverse) fails the
 * typecheck. The runtime half is `test/oidc-token-error-codes.test.ts`.
 */
type SameType<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
type MustBeTrue<T extends true> = T;
export type OAuthErrorCodesAreDeclared = MustBeTrue<
  SameType<OAuthErrorCode, (typeof OIDC_TOKEN_ERROR_CODES)[number]>
>;

export type GrantOutcome =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; error: OAuthErrorCode; description: string };

const fail = (error: OAuthErrorCode, description: string): GrantOutcome => ({
  ok: false,
  error,
  description,
});

/** The token's own columns, as {@link TOKEN_LOOKUP_SQL} reads them. */
interface TokenColumns {
  id: number;
  kind: "access" | "refresh";
  client_row_id: number;
  client_public_id: string;
  user_id: number | null;
  scopes: string;
  audience: string;
  iat: number;
  exp: number;
  active: number;
}

/**
 * A token as every reader sees it: its own columns, and the account it names with that account's
 * claim columns, or `user: null` for a client credentials token. The statement LEFT JOINs `users`,
 * so a machine token's account columns are all NULL; they are never typed as an account's.
 */
export interface TokenRow extends TokenColumns {
  user: (ClaimAccount & { id: number }) | null;
}

/** The token row of a value, or null. Any string: an unknown or malformed one is simply not found. */
export async function lookupToken(db: D1Database, token: string): Promise<TokenRow | null> {
  const row = await db
    .prepare(TOKEN_LOOKUP_SQL)
    .bind(await hashOidcToken(token))
    .first<TokenColumns & Partial<ClaimAccount>>();
  if (!row) return null;
  const columns: TokenColumns = {
    id: row.id,
    kind: row.kind,
    client_row_id: row.client_row_id,
    client_public_id: row.client_public_id,
    user_id: row.user_id,
    scopes: row.scopes,
    audience: row.audience,
    iat: row.iat,
    exp: row.exp,
    active: row.active,
  };
  if (row.user_id === null) return { ...columns, user: null };
  return {
    ...columns,
    user: {
      id: row.user_id,
      oidc_subject: row.oidc_subject as string,
      given_name: row.given_name ?? null,
      family_name: row.family_name ?? null,
      email: row.email as string,
      email_verified: row.email_verified as number,
      orcid: row.orcid ?? null,
      orcid_proven: row.orcid_proven as number,
      account_kind: row.account_kind as string,
      status: row.status as string,
      service_access: row.service_access as number,
    },
  };
}

/**
 * The scopes a `scope` parameter names, sorted with no repeat, or null when it names nothing, or
 * names something that is not in the catalogue. Split on the single space RFC 6749 section 3.3 names.
 */
function parseScopeParam(raw: string): string[] | null {
  const names = raw.split(" ").filter((s) => s !== "");
  if (names.length === 0 || names.some((s) => !isOidcScope(s))) return null;
  return [...new Set(names)].sort();
}

/** The success body every grant answers with. */
function tokenBody(accessToken: string, scopes: readonly string[]): Record<string, unknown> {
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: OIDC_ACCESS_TOKEN_TTL_SECONDS,
    scope: scopes.join(" "),
  };
}

// ---------------------------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------------------------

/** RFC 7636 section 4.1: 43 to 128 characters of `[A-Za-z0-9-._~]`. */
const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;

/** Whether a verifier has the form RFC 7636 section 4.1 gives it. */
export function isWellFormedVerifier(verifier: string): boolean {
  return VERIFIER_RE.test(verifier);
}

/** Whether `verifier` is the one behind `challenge` under S256, compared in constant time. */
export async function verifierMatches(verifier: string, challenge: string): Promise<boolean> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return timingSafeEqual(toBase64Url(new Uint8Array(digest)), challenge);
}

// ---------------------------------------------------------------------------------------------
// The authorization code grant
// ---------------------------------------------------------------------------------------------

interface CodeRow {
  id: number;
  client_id: number;
  redirect_uri: string;
  scopes: string;
  nonce: string | null;
  code_challenge: string;
  auth_time_unix: number;
  now_unix: number;
}

/**
 * A second redemption of a code (RFC 6749 section 4.1.2): revoke every token issued from it, and
 * write nothing else. The statement re-checks that the code is this client's and used.
 */
async function secondRedemption(
  db: D1Database,
  codeHash: string,
  clientRowId: number,
  invalid: () => GrantOutcome,
): Promise<GrantOutcome> {
  await db.prepare(CODE_REPLAY_REVOKE_SQL).bind(codeHash, clientRowId).run();
  return invalid();
}

/**
 * Redeem a code (RFC 6749 section 4.1.3, RFC 7636 section 4.6). `form` was checked by the route: one
 * of each parameter, and `code`, `redirect_uri` and a well-formed `code_verifier` present.
 */
export async function redeemAuthorizationCode(
  env: TokenEnv,
  client: AuthenticatedClient,
  form: { code: string; redirectUri: string; verifier: string },
): Promise<GrantOutcome> {
  const db = env.DB;
  // The hash the authorization routes stored the code by (SHA-256, as for a token).
  const codeHash = await hashGrantCode(form.code);
  const code = await db.prepare(CODE_READ_SQL).bind(codeHash).first<CodeRow>();
  const invalid = () => fail("invalid_grant", "The code is not valid for this request.");
  // Another client's code is not this one's to redeem, or to replay: nothing is written for it.
  if (!code || code.client_id !== client.id) return invalid();
  // The verifier and the redirect come first, and a mismatch writes nothing, used code or not: a code
  // someone captured cannot be used to make the legitimate client end its owner's tokens by
  // presenting it again with another verifier.
  const verifierOk = await verifierMatches(form.verifier, code.code_challenge);
  const redirectOk = timingSafeEqual(form.redirectUri, code.redirect_uri);
  if (!verifierOk || !redirectOk) return invalid();
  // A used code that matched goes on to the batch, whose claim it loses; that loss is a second
  // redemption (below). Whoever redeemed first held this verifier, so it is the legitimate client's
  // own replay, or a leak of everything it holds: everything the code issued is revoked.

  const account = await db.prepare(CODE_ACCOUNT_SQL).bind(code.id).first<ClaimAccount>();
  if (!account || !account.oidc_subject) return invalid();
  const scopes = JSON.parse(code.scopes) as string[];
  const accessToken = generateOidcToken("access");
  const accessHash = await hashOidcToken(accessToken);
  // Whether a refresh token is issued is the statement's to decide (`offline_access` in the code,
  // the refresh token grant on the client), and the answer carries one only when its row exists.
  const refreshToken = generateOidcToken("refresh");

  // Signed before the batch, so a signing failure mints nothing; discarded if the claim is lost.
  const idToken = await signJwt(env, {
    iss: oidcIssuer(env),
    aud: client.clientId,
    iat: code.now_unix,
    exp: code.now_unix + OIDC_ID_TOKEN_TTL_SECONDS,
    auth_time: code.auth_time_unix,
    ...(code.nonce !== null ? { nonce: code.nonce } : {}),
    at_hash: await atHash(accessToken),
    ...claimsForScopes(scopes, account),
  });

  const results = await db.batch([
    db.prepare(TOKENS_PRUNE_SQL),
    db
      .prepare(ACCESS_FROM_CODE_SQL)
      .bind(
        accessHash,
        randomHex(16),
        OIDC_ACCESS_TOKEN_TTL_SECONDS,
        codeHash,
        client.id,
        MACHINE_ONLY_SCOPES_JSON,
      ),
    db
      .prepare(REFRESH_FROM_CODE_SQL)
      .bind(
        await hashOidcToken(refreshToken),
        OIDC_REFRESH_TOKEN_IDLE_SECONDS,
        OIDC_REFRESH_TOKEN_ABSOLUTE_SECONDS,
        accessHash,
      ),
    db.prepare(CODE_SPEND_SQL).bind(code.id, accessHash),
  ]);
  const minted = results[1]?.meta?.changes ?? 0;

  if (minted !== 1) {
    // Lost: either the code is used by now (a second redemption, which revokes what the first
    // issued and writes nothing else) or something the gates read changed (nothing was written).
    const used = await db.prepare(CODE_USED_SQL).bind(codeHash, client.id).first();
    if (used) return secondRedemption(db, codeHash, client.id, invalid);
    return invalid();
  }
  if ((results[3]?.meta?.changes ?? 0) !== 1) {
    throw new Error("an access token was minted from a code that was not then marked used");
  }
  const refreshMinted = (results[2]?.meta?.changes ?? 0) === 1;
  return {
    ok: true,
    body: {
      ...tokenBody(accessToken, scopes),
      id_token: idToken,
      ...(refreshMinted ? { refresh_token: refreshToken } : {}),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The refresh token grant
// ---------------------------------------------------------------------------------------------

interface RefreshRow {
  id: number;
  client_id: number;
  scopes: string;
  consent_kind: string | null;
}

/** Rotate a refresh token (RFC 6749 section 6). `scope` is the parameter as sent, or null. */
export async function refreshTokens(
  env: TokenEnv,
  client: AuthenticatedClient,
  form: { refreshToken: string; scope: string | null },
): Promise<GrantOutcome> {
  const db = env.DB;
  const invalid = () => fail("invalid_grant", "The refresh token is not valid.");
  const parent = await db
    .prepare(REFRESH_READ_SQL)
    .bind(await hashOidcToken(form.refreshToken))
    .first<RefreshRow>();
  // Another client's token is not this one's to rotate, or to revoke by replaying it.
  if (!parent || parent.client_id !== client.id) return invalid();

  const held = JSON.parse(parent.scopes) as string[];
  let scopes = held;
  if (form.scope !== null) {
    const asked = parseScopeParam(form.scope);
    if (asked === null || asked.some((s) => !held.includes(s))) {
      return fail("invalid_scope", "The scope asked for is not within the refresh token's.");
    }
    scopes = asked;
  }
  // A grant recorded while the client was first-party feeds refresh only while it still is.
  if (parent.consent_kind === "first_party" && !stillFirstParty(client, env)) return invalid();

  const accessToken = generateOidcToken("access");
  const refreshToken = generateOidcToken("refresh");
  const childHash = await hashOidcToken(refreshToken);
  const results = await db.batch([
    db.prepare(TOKENS_PRUNE_SQL),
    db
      .prepare(REFRESH_CHILD_SQL)
      .bind(
        childHash,
        OIDC_REFRESH_TOKEN_IDLE_SECONDS,
        parent.id,
        client.id,
        parent.consent_kind,
        JSON.stringify(scopes),
        OIDC_REFRESH_GRACE_SECONDS,
      ),
    db
      .prepare(ACCESS_FROM_REFRESH_SQL)
      .bind(
        await hashOidcToken(accessToken),
        JSON.stringify(scopes),
        OIDC_ACCESS_TOKEN_TTL_SECONDS,
        childHash,
      ),
    db.prepare(REFRESH_SPEND_SQL).bind(parent.id, childHash),
    db.prepare(REFRESH_SIBLINGS_REVOKE_SQL).bind(parent.id, parent.id, childHash, parent.id),
  ]);
  if ((results[1]?.meta?.changes ?? 0) !== 1) {
    await db
      .prepare(REFRESH_REUSE_REVOKE_SQL)
      .bind(parent.id, client.id, OIDC_REFRESH_GRACE_SECONDS)
      .run();
    return invalid();
  }
  if ((results[2]?.meta?.changes ?? 0) !== 1) {
    throw new Error("a refresh token was rotated without the access token beside it");
  }
  return { ok: true, body: { ...tokenBody(accessToken, scopes), refresh_token: refreshToken } };
}

// ---------------------------------------------------------------------------------------------
// The client credentials grant
// ---------------------------------------------------------------------------------------------

/**
 * An access token for the client itself (RFC 6749 section 4.4), for machine-only scopes only. With
 * no `scope`, the client's own machine-only scopes. Every scope must be in the catalogue, machine
 * only, and one the client is allowed.
 */
export async function clientCredentials(
  env: TokenEnv,
  client: AuthenticatedClient,
  form: { scope: string | null },
): Promise<GrantOutcome> {
  const db = env.DB;
  const own = client.allowedScopes.filter(isMachineOnlyScope).sort();
  const scopes = form.scope === null ? own : parseScopeParam(form.scope);
  if (
    scopes === null ||
    scopes.length === 0 ||
    scopes.some((s) => !isMachineOnlyScope(s) || !client.allowedScopes.includes(s))
  ) {
    return fail("invalid_scope", "Only the client's own machine scopes can be asked for here.");
  }
  const accessToken = generateOidcToken("access");
  const results = await db.batch([
    db.prepare(TOKENS_PRUNE_SQL),
    db
      .prepare(CLIENT_CREDENTIALS_SQL)
      .bind(
        await hashOidcToken(accessToken),
        JSON.stringify(scopes),
        OIDC_ACCESS_TOKEN_TTL_SECONDS,
        client.id,
        JSON.stringify(scopes),
      ),
  ]);
  if ((results[1]?.meta?.changes ?? 0) !== 1) {
    // The client was disabled or changed between authentication and this statement.
    return fail("invalid_client", "The client could not be authenticated.");
  }
  return { ok: true, body: tokenBody(accessToken, scopes) };
}

// ---------------------------------------------------------------------------------------------
// Revocation and introspection
// ---------------------------------------------------------------------------------------------

/**
 * RFC 7009: end `token` if it is this client's. An access token ends alone; a refresh token ends its
 * family, access tokens included. Anything else (unknown, another client's, already ended) changes
 * nothing, and the caller answers 200 whatever happened. The hint is not needed: both are tried.
 */
export async function revokeToken(
  db: D1Database,
  client: AuthenticatedClient,
  token: string,
): Promise<void> {
  const hash = await hashOidcToken(token);
  await db.batch([
    db.prepare(REVOKE_FAMILY_SQL).bind(hash, client.id),
    db.prepare(REVOKE_ACCESS_SQL).bind(hash, client.id),
  ]);
}

/**
 * RFC 7662: what `caller` may be told about `token`. Inactive (`{active: false}`, and nothing else)
 * unless the token is active NOW and the caller may see it: its own token of either kind, or an
 * ACCESS token whose audience is one the caller is registered to introspect. A refresh token is
 * shown to its own client only.
 */
export async function introspectToken(
  env: Pick<Bindings, "DB" | "API_BASE_URL">,
  caller: AuthenticatedClient,
  token: string,
): Promise<Record<string, unknown>> {
  const row = await lookupToken(env.DB, token);
  if (!row || row.active !== 1) return { active: false };
  const own = row.client_row_id === caller.id;
  const audienceMatch =
    row.kind === "access" && caller.introspectionAudiences.includes(row.audience);
  if (!own && !audienceMatch) return { active: false };
  return {
    active: true,
    scope: (JSON.parse(row.scopes) as string[]).join(" "),
    client_id: row.client_public_id,
    // RFC 7662's token_type is an access token's type (RFC 6749 section 7.1); a refresh token has none.
    ...(row.kind === "access" ? { token_type: "Bearer" } : {}),
    exp: row.exp,
    iat: row.iat,
    ...(row.user !== null ? { sub: row.user.oidc_subject } : {}),
    aud: row.audience,
    iss: oidcIssuer(env),
  };
}
