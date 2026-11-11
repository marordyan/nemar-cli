/**
 * What the revocation suites of the OpenID Connect provider (epic #2014 phase #2019) share, on top of
 * `oidc-harness.ts` and `oidc-flow.ts`: an account that holds a live grant, an access and a refresh
 * token and an unspent code at one or more clients, and the questions asked of the database and of
 * the real endpoints afterwards.
 *
 * Nothing here replaces NEMAR logic. Every grant, token and code comes from the real authorization
 * routes and the real token endpoint, every client from the owner's route, and "does it still work"
 * is asked of the real introspection and token endpoints, not read off a row. The one thing read off
 * a row is what a cascade WRITES (a revoked time, a deleted code, a queued delivery), because that is
 * the thing under test.
 */

import { expect } from "bun:test";
import {
  OIDC_AUTHORIZE_CALLER_HEADER,
  OIDC_AUTHORIZE_CALLER_VALUE,
  OIDC_AUTHORIZE_CHECK_PATH,
} from "../../../shared/contract/oidc-authorize";
import { hashApiKey } from "../../src/services/token";
import {
  APP,
  RFC_CHALLENGE,
  type RegisteredClient,
  authorize,
  basic,
  formPost,
  redeem,
  registerClient,
  seedAccount,
  sessionCookie,
  tokenRequest,
} from "./oidc-flow";
import type { OidcHarness } from "./oidc-harness";

/** A partner's logout address on a host that no dev worker will send to (it is fenced), so a suite
 *  that is about what is QUEUED never depends on what a sender does with it. */
export const PARTNER_LOGOUT = "https://partner.example.org/oidc/logout";

/** Register a client with a back-channel logout address (a partner's, unless told otherwise). */
export function registerLogoutClient(
  h: OidcHarness,
  over: Record<string, unknown> = {},
): Promise<RegisteredClient> {
  return registerClient(h, { backchannel_logout_uri: PARTNER_LOGOUT, ...over });
}

/** What one account was handed at one client. */
export interface Held {
  client: RegisteredClient;
  access: string;
  refresh: string;
  /** An authorization code that was minted and never redeemed. */
  unspentCode: string;
}

/**
 * Sign `userId` in at `client` through the real routes: a grant, an access token, a refresh token,
 * and a second code that is left unspent.
 */
export async function signInAt(
  h: OidcHarness,
  userId: number,
  client: RegisteredClient,
  opts: { scope?: string } = {},
): Promise<Held> {
  const scope = opts.scope ?? "openid profile offline_access";
  const cookie = await sessionCookie(h, userId);
  const first = await redeem(h, client, await authorize(h, client, cookie, { scope }));
  expect(first.status).toBe(200);
  const body = first.json as { access_token: string; refresh_token: string };
  const unspentCode = await authorize(h, client, cookie, { scope });
  return { client, access: body.access_token, refresh: body.refresh_token, unspentCode };
}

/** A person with a proven ORCID iD (an `oauth_identities` row), the account `person_proven_orcid` takes. */
let orcidCounter = 0;
export function seedProvenAccount(h: OidcHarness): number {
  orcidCounter += 1;
  const orcid = `0000-0002-${String(1000 + orcidCounter).padStart(4, "0")}-${String(2000 + orcidCounter).padStart(4, "0")}`;
  return seedAccount(h, { orcid, identity: orcid, orcidVerified: true });
}

/** An API key for an account the harness did not seed one for. */
export async function giveKey(h: OidcHarness, userId: number, key: string): Promise<void> {
  h.db
    .query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)")
    .run(userId, await hashApiKey(key), key.slice(0, 8));
}

export function usernameOf(h: OidcHarness, userId: number): string {
  const row = h.db
    .query<{ username: string }, [number]>("SELECT username FROM users WHERE id = ?")
    .get(userId);
  if (!row) throw new Error(`no account ${userId}`);
  return row.username;
}

/** The public `oc_...` id to the row id every cascade table stores. */
export function clientRowId(h: OidcHarness, client: RegisteredClient): number {
  const row = h.db
    .query<{ id: number }, [string]>("SELECT id FROM oidc_clients WHERE client_id = ?")
    .get(client.clientId);
  if (!row) throw new Error("no such client");
  return row.id;
}

export function subjectOf(h: OidcHarness, userId: number): string {
  const row = h.db
    .query<{ oidc_subject: string }, [number]>("SELECT oidc_subject FROM users WHERE id = ?")
    .get(userId);
  if (!row) throw new Error(`no account ${userId}`);
  return row.oidc_subject;
}

/** What an account holds in the three OIDC tables, counted by the columns a cascade writes. */
export interface Counts {
  grantsLive: number;
  grantsRevoked: number;
  tokensLive: number;
  tokensRevoked: number;
  codesUnused: number;
}

export function countsOf(h: OidcHarness, userId: number): Counts {
  const one = (sql: string) => h.db.query<{ n: number }, [number]>(sql).get(userId)?.n ?? 0;
  return {
    grantsLive: one(
      "SELECT COUNT(*) AS n FROM oidc_grants WHERE user_id = ? AND revoked_at IS NULL",
    ),
    grantsRevoked: one(
      "SELECT COUNT(*) AS n FROM oidc_grants WHERE user_id = ? AND revoked_at IS NOT NULL",
    ),
    tokensLive: one(
      "SELECT COUNT(*) AS n FROM oidc_tokens WHERE user_id = ? AND revoked_at IS NULL",
    ),
    tokensRevoked: one(
      "SELECT COUNT(*) AS n FROM oidc_tokens WHERE user_id = ? AND revoked_at IS NOT NULL",
    ),
    codesUnused: one("SELECT COUNT(*) AS n FROM oidc_codes WHERE user_id = ? AND used_at IS NULL"),
  };
}

/** The reasons the account's revoked tokens carry, de-duplicated and sorted. */
export function revokedReasons(h: OidcHarness, userId: number): string[] {
  return h.db
    .query<{ revoked_reason: string }, [number]>(
      "SELECT DISTINCT revoked_reason FROM oidc_tokens WHERE user_id = ? AND revoked_at IS NOT NULL ORDER BY 1",
    )
    .all(userId)
    .map((r) => r.revoked_reason);
}

export interface DeliveryRow {
  id: number;
  client_id: number;
  sub: string;
  reason: string;
  status: string;
  attempts: number;
  next_attempt_at: string | null;
  last_status: number | null;
  last_error_class: string | null;
  jti: string | null;
  sent_at: string | null;
}

/** Every queued delivery, oldest first, or those of one account (by its subject). */
export function deliveries(h: OidcHarness, userId?: number): DeliveryRow[] {
  if (userId === undefined) {
    return h.db.query<DeliveryRow, []>("SELECT * FROM oidc_logout_deliveries ORDER BY id").all();
  }
  return h.db
    .query<DeliveryRow, [string]>("SELECT * FROM oidc_logout_deliveries WHERE sub = ? ORDER BY id")
    .all(subjectOf(h, userId));
}

/** Is this access token still active, as the client it was issued to is told by introspection? */
export async function introspectActive(
  h: OidcHarness,
  client: RegisteredClient,
  token: string,
): Promise<boolean> {
  const res = await formPost(
    h,
    "/oauth/introspect",
    { token },
    { authorization: basic(client.clientId, client.secret) },
  );
  // A client that cannot authenticate (a disabled one) is told 401 and learns nothing: not active.
  return res.status === 200 && res.json?.active === true;
}

/** Does userinfo still answer for this access token? */
export async function userinfoStatus(h: OidcHarness, access: string): Promise<number> {
  return (
    await h.call("GET", "/oauth/userinfo", { headers: { Authorization: `Bearer ${access}` } })
  ).status;
}

/** Try to refresh: the status and the OAuth error word, if any. */
export async function refreshAnswer(
  h: OidcHarness,
  client: RegisteredClient,
  refresh: string,
): Promise<{ status: number; error: unknown }> {
  const res = await tokenRequest(h, client, {
    grant_type: "refresh_token",
    refresh_token: refresh,
  });
  return { status: res.status, error: res.json?.error };
}

/** Try to redeem a code: the status and the OAuth error word, if any. */
export async function redeemAnswer(
  h: OidcHarness,
  client: RegisteredClient,
  code: string,
): Promise<{ status: number; error: unknown }> {
  const res = await redeem(h, client, code);
  return { status: res.status, error: res.json?.error };
}

/**
 * Everything a held credential could still do, asked of the real endpoints. `works` is true when ANY
 * of the four still answers: introspection, userinfo, a refresh, a redemption of the unspent code. A
 * cascade has done its job when this is false for every credential the account held, and a
 * re-approval of the account must not change that.
 */
export async function stillWorks(h: OidcHarness, held: Held): Promise<boolean> {
  if (await introspectActive(h, held.client, held.access)) return true;
  if ((await userinfoStatus(h, held.access)) === 200) return true;
  if ((await refreshAnswer(h, held.client, held.refresh)).status === 200) return true;
  return (await redeemAnswer(h, held.client, held.unspentCode)).status === 200;
}

/** Put an account back as it was before it was revoked, as an approval would (no IAM, no mail). */
export function restoreAccount(h: OidcHarness, userId: number): void {
  h.db
    .query(
      "UPDATE users SET status = 'verified', revoked_at = NULL, deleted_at = NULL WHERE id = ?",
    )
    .run(userId);
}

/**
 * What the REAL authorization check answers for an account that presents a live app session, at a
 * client: `kind` (`redirect` when a grant would be given, `rule_refused`, `login`, ...), the refusal's
 * `reason` when it has one, and the `location` it sends the person to. The session is issued afresh, as a person who signed in again would hold it,
 * so this asks "can this account get a grant NOW", not "does an old credential still work".
 */
export async function authorizeAnswer(
  h: OidcHarness,
  userId: number,
  client: RegisteredClient,
): Promise<{ kind: string; reason?: string; location?: string }> {
  const request = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: client.redirect,
    response_type: "code",
    scope: "openid profile",
    state: "s-check",
    code_challenge: RFC_CHALLENGE,
    code_challenge_method: "S256",
  }).toString();
  const res = await h.call("POST", OIDC_AUTHORIZE_CHECK_PATH, {
    body: { request },
    headers: {
      Cookie: await sessionCookie(h, userId),
      Origin: APP,
      [OIDC_AUTHORIZE_CALLER_HEADER]: OIDC_AUTHORIZE_CALLER_VALUE,
    },
  });
  expect(res.status).toBe(200);
  return res.json as { kind: string; reason?: string; location?: string };
}
