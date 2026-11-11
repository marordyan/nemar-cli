/**
 * The authorization endpoint's decisions (epic #2014 phase #2017; ADR 0119, rules 2, 3, 7 and 8).
 *
 * The page at `app.nemar.org/oauth/authorize` forwards an authorization request here, through the
 * check and consent routes (`routes/auth-oidc.ts`), and renders or follows the answer. EVERYTHING
 * IS DECIDED HERE, in one order that every request walks the same way:
 *
 *   1. THE CLIENT AND THE REDIRECT ADDRESS. An unknown or disabled client, a missing or repeated
 *      `client_id` or `redirect_uri`, or a redirect address that is not, character for character, one
 *      the client registered, is an ERROR PAGE. Nothing before this step can be trusted to say where
 *      to send the person, so nothing before it ever redirects (RFC 6749 section 4.1.2.1).
 *   2. THE REQUEST. From here on an error OF THE REQUEST is a REDIRECT to that registered address
 *      carrying `error`, the request's `state` and `iss` (RFC 9207): a repeated parameter, `request` or
 *      `request_uri`, a missing response type (`invalid_request`) or one other than `code`
 *      (`unsupported_response_type`: there is no implicit grant, ADR 0119 rule 1), a response mode
 *      other than `query`, a PKCE method other than S256 or no challenge, an unreadable `prompt`,
 *      `max_age` or `nonce`, and the scopes (`openid` missing, a catalogue scope the client may not
 *      have, or a machine-only scope: `invalid_scope`; a name outside the catalogue is dropped).
 *   3. THE SESSION. Only an app session read under the `__Host-` cookie name may approve a grant
 *      (ADR 0119 rule 10); the route passes no session otherwise. None: sign in (`prompt=none`:
 *      `login_required`).
 *   4. FRESHNESS. `prompt=login`, a `max_age` the session is older than, or a valid `id_token_hint`
 *      for another subject: sign in again (`prompt=none`: `login_required`). The sign-in the page sent
 *      the person to satisfies all three, and is recognized by a SIGNED marker (below), never by a
 *      value a caller can write. Front-channel freshness is a courtesy: a client relies on the
 *      identity token's `auth_time`, which the code carries.
 *   5. THE CLIENT'S SIGN-IN RULE (`services/oidc-identity.ts`). Refused: a page that says why and
 *      links back to the client with `access_denied` (`prompt=none`: the `access_denied` redirect).
 *   6. CONSENT. A client is first-party only while EVERY redirect address it registered still passes
 *      `isFirstPartyRedirect`, re-asked now; a client registered first-party whose addresses no longer
 *      qualify is treated as third-party and asked, as any other client is. A third-party client is
 *      asked under its `consent_mode`: `ask_once` asks unless a grant the PERSON gave covers every
 *      scope asked for, `always` asks every time, and so does `prompt=consent` (which a first-party
 *      client ignores). (`prompt=none`: `consent_required`.)
 *   7. THE CODE. 256 random bits, stored only as its hash, for 60 seconds by D1's clock. The
 *      statement that writes it re-reads the session, the account, the client, the sign-in rule, the
 *      redirect address and the grant in its own WHERE clause, so a change since step 1 mints nothing,
 *      and a mint that wrote nothing is an error page, never a redirect.
 *
 * THE CONSENT TOKEN is what proves the person's answer came from a screen this API showed to THIS
 * session for THIS request: an HMAC-SHA256 under `OIDC_SECRET`, over a domain tag and the session,
 * the client, the redirect address, the scope set, `state`, the PKCE challenge, `nonce` and an expiry
 * ten minutes after the check by D1's clock. The consent route walks steps 1 to 6 again and then
 * verifies the token against what it finds, so a token for another session, another request or a
 * past moment is refused, and an answer is never taken for a request the check did not show.
 *
 * THE SIGN-IN MARKER is the same kind of proof for the other half of the flow: when the check sends a
 * person to sign in for a request that asks for a fresh sign-in, the request it returns carries
 * `nemar_auth_after=<unix>.<mac>`, an HMAC-SHA256 under `OIDC_SECRET` with its own domain tag over the
 * moment (D1's clock) and the client, good for ten minutes. A marker that does not verify is treated
 * as absent, so `prompt=login` and `max_age` still apply to a request a caller wrote by hand.
 *
 * `client_id` IN `oidc_grants` AND `oidc_codes` IS THE `oidc_clients.id` ROW ID, NOT THE PUBLIC
 * `oc_...` STRING (migration 0122). The public identifier appears here only as `ClientRow.client_id`
 * and in the statements' `c.client_id = ?` joins.
 *
 * NOTHING HERE LOGS a `state`, a code, a nonce or the request.
 */

import {
  OIDC_AUTHORIZE_REQUEST_MAX_LENGTH,
  OIDC_AUTH_AFTER_PARAM,
  OIDC_AUTH_AFTER_TTL_SECONDS,
  OIDC_CONSENT_TOKEN_TTL_SECONDS,
  type OidcAuthorizeAnswer,
  type OidcAuthorizeRedirectError,
  type OidcConsentDecision,
  type OidcErrorPageCode,
} from "../../../shared/contract/oidc-authorize.js";
import {
  OIDC_AUTHORIZATION_CODE_TTL_SECONDS,
  OIDC_SCOPE_NAMES,
  type OidcSignInRule,
  isMachineOnlyScope,
  isOidcClientId,
  isOidcScope,
  isOidcSignInRule,
} from "../../../shared/oidc.js";
import { timingSafeEqual } from "../lib/constant-time.js";
import type { Bindings } from "../types/bindings.js";
import { generateGrantCode, hashGrantCode } from "./docs-auth.js";
import { isFirstPartyRedirect } from "./oidc-clients.js";
import { oidcIssuer, oidcSecret } from "./oidc-config.js";
import { toBase64Url } from "./oidc-encoding.js";
import { idTokenHintSubject } from "./oidc-id-token.js";
import { ORCID_PROVEN_SQL, SIGN_IN_RULE_SQL, signInRuleRefusal } from "./oidc-identity.js";

type AuthorizeEnv = Pick<Bindings, "DB" | "ENVIRONMENT" | "API_BASE_URL" | "OIDC_SECRET">;

// ---------------------------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------------------------

/** The client an authorization request names, if it is active. A disabled client is not found. */
export const AUTHORIZE_CLIENT_SQL = `SELECT id, client_id, name, redirect_uris, allowed_scopes,
    sign_in_rule, first_party, consent_mode
  FROM oidc_clients WHERE client_id = ? AND status = 'active'`;

/**
 * The live app session a request carries, with what steps 4 and 5 need and D1's clock. The same
 * liveness the session middleware applies (`findSessionByCookieId`): not revoked, not expired, the
 * account not revoked and not deleted. Read again here because the middleware's row has no
 * `created_at`, and so that the clock the decisions use is the database's.
 */
export const AUTHORIZE_SESSION_SQL = `SELECT ws.id AS session_id,
    CAST(strftime('%s', ws.created_at) AS INTEGER) AS created_unix,
    CAST(strftime('%s', 'now') AS INTEGER) AS now_unix,
    u.status, u.deleted_at, u.account_kind, u.oidc_subject,
    ${ORCID_PROVEN_SQL} AS orcid_proven
  FROM web_sessions ws
  JOIN users u ON u.id = ws.user_id
 WHERE ws.id = ?
   AND ws.scope = 'app'
   AND ws.revoked_at IS NULL
   AND ws.expires_at > datetime('now')
   AND u.status != 'revoked'
   AND u.deleted_at IS NULL`;

/** D1's clock in Unix seconds, for a request that has no session to read it with. */
export const NOW_UNIX_SQL = "SELECT CAST(strftime('%s', 'now') AS INTEGER) AS now_unix";

/**
 * The one live grant of the session's account to a client, if any (migration 0122's partial unique
 * index). Binds: the session id, the client's ROW id (`oidc_clients.id`).
 */
export const LIVE_GRANT_SQL = `SELECT id, scopes, consent_kind FROM oidc_grants
  WHERE user_id = (SELECT user_id FROM web_sessions WHERE id = ?)
    AND client_id = ? AND revoked_at IS NULL`;

/**
 * The gates every write here repeats in its own WHERE clause: the app session (aliased `ws`) is live,
 * the client (`c`) is active, and the account (`u`) passes the client's sign-in rule.
 */
const MINT_GATES = `ws.id = ?
   AND ws.scope = 'app'
   AND ws.revoked_at IS NULL
   AND ws.expires_at > datetime('now')
   AND c.status = 'active'
   AND ${SIGN_IN_RULE_SQL}`;

/**
 * Record what the account let the client have, or nothing when a gate fails.
 * Binds: scopes (sorted JSON), consent kind, the client's PUBLIC id (joined to its row), the session
 * id. The row stores the client's ROW id, `oidc_clients.id`.
 *
 * One live grant per account and client, so this is an upsert on migration 0122's partial index.
 * The scopes on a conflict are computed by D1 from the row as it is at write time, never from a copy
 * read earlier. A grant the person gave (`user`) widens only by the person's own answers, or by a
 * first-party authorization, which re-marks it `first_party`, so the scopes it added are never later
 * taken for consent if the client stops being first-party. A person's answer REPLACES a grant that
 * was never theirs (`first_party`), because nobody consented to what it held. The union is sorted,
 * with no repeat (`json_group_array(... ORDER BY value)` over a `UNION`).
 */
export const GRANT_UPSERT_SQL = `INSERT INTO oidc_grants (user_id, client_id, scopes, consent_kind)
  SELECT u.id, c.id, ?, ?
    FROM web_sessions ws
    JOIN users u ON u.id = ws.user_id
    JOIN oidc_clients c ON c.client_id = ?
   WHERE ${MINT_GATES}
  ON CONFLICT (user_id, client_id) WHERE revoked_at IS NULL DO UPDATE SET
    scopes = CASE
      WHEN excluded.consent_kind = 'user' AND oidc_grants.consent_kind <> 'user' THEN excluded.scopes
      ELSE (SELECT json_group_array(value ORDER BY value) FROM (
              SELECT value FROM json_each(oidc_grants.scopes)
              UNION
              SELECT value FROM json_each(excluded.scopes)))
    END,
    consent_kind = excluded.consent_kind`;

/**
 * Mint an authorization code, or insert nothing. Binds: code hash, redirect address, scopes (sorted
 * JSON), nonce, PKCE challenge, lifetime in seconds, the client's PUBLIC id (joined to its row), the
 * session id, the scopes again, the redirect address again. The row stores the client's ROW id.
 *
 * The shape of `DOCS_MINT_INSERT_SQL`: an `INSERT ... SELECT` whose WHERE clause re-reads everything
 * the code depends on at the moment it is written. The session is live (and its `created_at` is the
 * code's `auth_time`), the account passes the client's sign-in rule, the client is active, the
 * redirect address is still one the client registered, and the account's OWN live grant to the
 * client and the client's own allowed scopes both cover every scope the code carries. Zero rows
 * written IS the refusal. The expiry is D1's clock plus the lifetime, and migration 0122's CHECK
 * refuses a row that would outlive sixty seconds.
 */
export const CODE_INSERT_SQL = `INSERT INTO oidc_codes
    (code_hash, client_id, user_id, grant_id, redirect_uri, scopes, nonce, code_challenge,
     auth_time, expires_at)
  SELECT ?, c.id, u.id, g.id, ?, ?, ?, ?, ws.created_at, datetime('now', '+' || ? || ' seconds')
    FROM web_sessions ws
    JOIN users u ON u.id = ws.user_id
    JOIN oidc_clients c ON c.client_id = ?
    JOIN oidc_grants g ON g.user_id = u.id AND g.client_id = c.id AND g.revoked_at IS NULL
   WHERE ${MINT_GATES}
     AND NOT EXISTS (SELECT 1 FROM json_each(?) r
                      WHERE r.value NOT IN (SELECT value FROM json_each(g.scopes))
                         OR r.value NOT IN (SELECT value FROM json_each(c.allowed_scopes)))
     AND EXISTS (SELECT 1 FROM json_each(c.redirect_uris) ru WHERE ru.value = ?)`;

/**
 * Delete codes more than an hour past expiry, used or not. Run at the head of every mint's batch,
 * from either route. A used code is kept that hour so a second redemption is recognized as a replay
 * (#2018) and not mistaken for an unknown code.
 */
export const CODES_PRUNE_SQL =
  "DELETE FROM oidc_codes WHERE expires_at < datetime('now', '-1 hour')";

// ---------------------------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------------------------

interface ClientRow {
  /** The client's ROW id, `oidc_clients.id`: what grants and codes store as `client_id`. */
  id: number;
  /** The PUBLIC client identifier, `oc_...`. */
  client_id: string;
  name: string;
  redirect_uris: string;
  allowed_scopes: string;
  sign_in_rule: string;
  first_party: number;
  consent_mode: string;
}

interface SessionRow {
  session_id: number;
  created_unix: number;
  now_unix: number;
  status: string;
  deleted_at: string | null;
  account_kind: string;
  oidc_subject: string | null;
  orcid_proven: number;
}

/** What step 1 established: the request read, and the client and redirect address it names. */
interface ClientAndRedirect {
  params: URLSearchParams;
  clientId: string;
  redirectUri: string;
}

/** An authorization request after steps 1 and 2. */
interface ParsedRequest extends ClientAndRedirect {
  state: string | null;
  nonce: string | null;
  codeChallenge: string;
  /** Sorted, with no repeat: how scopes are stored and signed. */
  scopes: string[];
  prompt: Set<string>;
  maxAge: number | null;
  idTokenHint: string | null;
  /** The sign-in marker as sent, verified in step 4; anything that does not verify is absent. */
  authAfterRaw: string | null;
}

/** A request that walked steps 1 to 6 and may now be answered by consent or by a code. */
interface Ready {
  client: ClientRow;
  request: ParsedRequest;
  session: SessionRow;
  firstParty: boolean;
  consentNeeded: boolean;
}

/** An answer that ends the walk. */
interface Done {
  done: OidcAuthorizeAnswer;
}

const done = (answer: OidcAuthorizeAnswer): Done => ({ done: answer });
const errorPage = (code: OidcErrorPageCode): Done => done({ kind: "error_page", code });

// ---------------------------------------------------------------------------------------------
// Redirects
// ---------------------------------------------------------------------------------------------

/**
 * `redirectUri` with `params` added to its query. The registered address is kept exactly as it is,
 * its own query included (RFC 6749 section 3.1.2), and the new parameters are appended after it:
 * re-serializing the registered query through `URL` could change how it is encoded. Registration
 * refuses an address whose query already names a parameter the response adds.
 */
export function appendToRedirect(redirectUri: string, params: Array<[string, string]>): string {
  const query = new URLSearchParams(params).toString();
  if (!redirectUri.includes("?")) return `${redirectUri}?${query}`;
  const separator = redirectUri.endsWith("?") || redirectUri.endsWith("&") ? "" : "&";
  return `${redirectUri}${separator}${query}`;
}

function withStateAndIssuer(
  env: AuthorizeEnv,
  state: string | null,
  first: Array<[string, string]>,
): Array<[string, string]> {
  const out = [...first];
  if (state !== null) out.push(["state", state]);
  out.push(["iss", oidcIssuer(env)]);
  return out;
}

function errorRedirect(
  env: AuthorizeEnv,
  redirectUri: string,
  state: string | null,
  error: OidcAuthorizeRedirectError,
): OidcAuthorizeAnswer {
  return {
    kind: "redirect",
    location: appendToRedirect(redirectUri, withStateAndIssuer(env, state, [["error", error]])),
  };
}

// ---------------------------------------------------------------------------------------------
// The two HMACs: the consent token and the sign-in marker
// ---------------------------------------------------------------------------------------------

/** HMAC-SHA256 under `secret` of a JSON array, as unpadded base64url (43 characters). */
async function macOf(secret: string, fields: unknown[]): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  // A JSON array, so no value can run into the next: a `state` holding a separator is one value.
  const message = encoder.encode(JSON.stringify(fields));
  return toBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, message)));
}

/** `<decimal>.<43 base64url characters>`: the shape of both tokens. */
const SIGNED_VALUE_RE = /^(\d{1,12})\.([A-Za-z0-9_-]{43})$/;

/** The first element of every consent token's signed message. Never shared with another token. */
export const OIDC_CONSENT_TOKEN_DOMAIN = "oidc-consent-v1";

/** The first element of every sign-in marker's signed message. Never shared with another token. */
export const OIDC_AUTH_AFTER_DOMAIN = "oidc-reauth-v1";

/** What a consent token is bound to. */
export interface ConsentBinding {
  sessionId: number;
  clientId: string;
  redirectUri: string;
  /** Sorted, with no repeat. */
  scopes: readonly string[];
  state: string | null;
  codeChallenge: string;
  nonce: string | null;
}

function consentFields(binding: ConsentBinding, expiry: number): unknown[] {
  return [
    OIDC_CONSENT_TOKEN_DOMAIN,
    binding.sessionId,
    binding.clientId,
    binding.redirectUri,
    binding.scopes.join(" "),
    binding.state,
    binding.codeChallenge,
    binding.nonce,
    expiry,
  ];
}

/** A consent token for `binding`, valid for ten minutes after `nowUnix` (D1's clock). */
export async function mintConsentToken(
  secret: string,
  binding: ConsentBinding,
  nowUnix: number,
): Promise<string> {
  const expiry = nowUnix + OIDC_CONSENT_TOKEN_TTL_SECONDS;
  return `${expiry}.${await macOf(secret, consentFields(binding, expiry))}`;
}

/**
 * Whether `token` was minted by {@link mintConsentToken} for exactly `binding` and has not expired at
 * `nowUnix`. The comparison is constant time; a token whose expiry is further away than a token is
 * ever minted for is refused without being checked, as is anything that is not of the token's shape.
 */
export async function verifyConsentToken(
  secret: string,
  token: unknown,
  binding: ConsentBinding,
  nowUnix: number,
): Promise<boolean> {
  if (typeof token !== "string") return false;
  const match = SIGNED_VALUE_RE.exec(token);
  if (!match) return false;
  const expiry = Number(match[1]);
  if (expiry <= nowUnix || expiry > nowUnix + OIDC_CONSENT_TOKEN_TTL_SECONDS) return false;
  return timingSafeEqual(match[2], await macOf(secret, consentFields(binding, expiry)));
}

/** A sign-in marker: the moment `unix` (D1's clock) a person was sent to sign in for `clientId`. */
export async function mintAuthAfterMarker(
  secret: string,
  clientId: string,
  unix: number,
): Promise<string> {
  return `${unix}.${await macOf(secret, [OIDC_AUTH_AFTER_DOMAIN, unix, clientId])}`;
}

/**
 * The moment a marker names, when {@link mintAuthAfterMarker} signed it for `clientId` within the
 * last ten minutes of `nowUnix`; otherwise null, which the caller treats as no marker at all.
 */
export async function verifyAuthAfterMarker(
  secret: string,
  raw: string | null,
  clientId: string,
  nowUnix: number,
): Promise<number | null> {
  if (raw === null) return null;
  const match = SIGNED_VALUE_RE.exec(raw);
  if (!match) return null;
  const unix = Number(match[1]);
  if (unix > nowUnix || nowUnix - unix > OIDC_AUTH_AFTER_TTL_SECONDS) return null;
  const expected = await macOf(secret, [OIDC_AUTH_AFTER_DOMAIN, unix, clientId]);
  return timingSafeEqual(match[2], expected) ? unix : null;
}

function requireSecret(env: AuthorizeEnv): string {
  // The routes are unreachable without a valid one (`oidcEnabled`); this is the statement of that
  // fact, and it reads through the one accessor, so a value in the wrong form is never used.
  const secret = oidcSecret(env);
  if (secret === null) throw new Error("OIDC_SECRET is not set, or is not in the required form");
  return secret;
}

// ---------------------------------------------------------------------------------------------
// Steps 1 and 2: the request
// ---------------------------------------------------------------------------------------------

/** Every parameter whose repetition is refused (RFC 6749 section 3.1). An unknown one is ignored. */
const SINGLE_VALUED = [
  "response_type",
  "response_mode",
  "scope",
  "state",
  "nonce",
  "code_challenge",
  "code_challenge_method",
  "prompt",
  "max_age",
  "id_token_hint",
  "login_hint",
  "display",
  "ui_locales",
  "claims_locales",
  "acr_values",
  "request",
  "request_uri",
  OIDC_AUTH_AFTER_PARAM,
];

const PROMPT_VALUES = new Set(["none", "login", "consent", "select_account"]);
const CODE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const MAX_AGE_RE = /^\d{1,12}$/;
const NONCE_MAX_LENGTH = 512;

/** A parameter's one value, or null when it is absent or empty (OpenID Connect Core 3.1.2.1). */
function single(params: URLSearchParams, name: string): string | null {
  const values = params.getAll(name);
  return values.length === 1 && values[0] !== "" ? values[0] : null;
}

function parseClientAndRedirect(raw: unknown): ClientAndRedirect | Done {
  if (typeof raw !== "string" || raw.length > OIDC_AUTHORIZE_REQUEST_MAX_LENGTH) {
    return errorPage("invalid_request");
  }
  const params = new URLSearchParams(raw.startsWith("?") ? raw.slice(1) : raw);
  const clientIds = params.getAll("client_id");
  const redirects = params.getAll("redirect_uri");
  if (clientIds.length > 1 || redirects.length > 1) return errorPage("invalid_request");
  const clientId = clientIds[0] ?? "";
  if (!isOidcClientId(clientId)) return errorPage("invalid_client");
  const redirectUri = redirects[0] ?? "";
  if (redirectUri === "") return errorPage("invalid_redirect_uri");
  return { params, clientId, redirectUri };
}

/** Step 2, for a request whose client and redirect address are known good. */
function parseRest(
  env: AuthorizeEnv,
  client: ClientRow,
  base: ClientAndRedirect,
): ParsedRequest | Done {
  const { params, redirectUri } = base;
  const state = single(params, "state");
  // A repeated `state` is not echoed: which of its values the client meant is unknowable.
  const fail = (error: OidcAuthorizeRedirectError) =>
    done(errorRedirect(env, redirectUri, state, error));

  if (SINGLE_VALUED.some((name) => params.getAll(name).length > 1)) return fail("invalid_request");
  if (single(params, "request") !== null) return fail("request_not_supported");
  if (single(params, "request_uri") !== null) return fail("request_uri_not_supported");
  const responseType = single(params, "response_type");
  if (responseType === null) return fail("invalid_request");
  if (responseType !== "code") return fail("unsupported_response_type");
  const responseMode = single(params, "response_mode");
  if (responseMode !== null && responseMode !== "query") return fail("invalid_request");
  if (single(params, "code_challenge_method") !== "S256") return fail("invalid_request");
  const codeChallenge = single(params, "code_challenge");
  if (codeChallenge === null || !CODE_CHALLENGE_RE.test(codeChallenge)) {
    return fail("invalid_request");
  }

  const prompt = new Set((single(params, "prompt") ?? "").split(" ").filter((p) => p !== ""));
  if ([...prompt].some((p) => !PROMPT_VALUES.has(p))) return fail("invalid_request");
  if (prompt.has("none") && prompt.size > 1) return fail("invalid_request");

  const maxAgeRaw = single(params, "max_age");
  if (maxAgeRaw !== null && !MAX_AGE_RE.test(maxAgeRaw)) return fail("invalid_request");
  const nonce = single(params, "nonce");
  if (nonce !== null && nonce.length > NONCE_MAX_LENGTH) return fail("invalid_request");

  // Scopes: split on the space RFC 6749 names, drop what is not in the catalogue, refuse a machine
  // scope (granted only under the client credentials grant, never by a person) and a catalogue scope
  // the client may not have.
  const requested = new Set(
    (single(params, "scope") ?? "").split(" ").filter((s) => s !== "" && isOidcScope(s)),
  );
  if (!requested.has("openid")) return fail("invalid_scope");
  const allowed = new Set(JSON.parse(client.allowed_scopes) as string[]);
  for (const scope of requested) {
    if (isMachineOnlyScope(scope) || !allowed.has(scope)) return fail("invalid_scope");
  }

  return {
    params,
    clientId: base.clientId,
    redirectUri,
    state,
    nonce,
    codeChallenge,
    scopes: [...requested].sort(),
    prompt,
    maxAge: maxAgeRaw === null ? null : Number(maxAgeRaw),
    idTokenHint: single(params, "id_token_hint"),
    authAfterRaw: single(params, OIDC_AUTH_AFTER_PARAM),
  };
}

/**
 * The request to come back with after signing in: `prompt=login` taken out (the sign-in is the
 * fresh one it asked for) and a signed sign-in marker for now, by D1's clock, so the check that
 * follows counts a session at least that new as the fresh sign-in. Every other parameter, in its
 * order.
 */
async function returnRequest(
  env: AuthorizeEnv,
  request: ParsedRequest,
  nowUnix: number,
): Promise<string> {
  const out = new URLSearchParams();
  for (const [name, value] of request.params) {
    if (name === OIDC_AUTH_AFTER_PARAM) continue;
    if (name === "prompt") {
      const rest = value.split(" ").filter((p) => p !== "" && p !== "login");
      if (rest.length > 0) out.append(name, rest.join(" "));
      continue;
    }
    out.append(name, value);
  }
  out.append(
    OIDC_AUTH_AFTER_PARAM,
    await mintAuthAfterMarker(requireSecret(env), request.clientId, nowUnix),
  );
  return out.toString();
}

function bindingOf(ready: Ready): ConsentBinding {
  return {
    sessionId: ready.session.session_id,
    clientId: ready.client.client_id,
    redirectUri: ready.request.redirectUri,
    scopes: ready.request.scopes,
    state: ready.request.state,
    codeChallenge: ready.request.codeChallenge,
    nonce: ready.request.nonce,
  };
}

// ---------------------------------------------------------------------------------------------
// Steps 1 to 6
// ---------------------------------------------------------------------------------------------

/**
 * Walk steps 1 to 6 for one request. `sessionId` is the app session the route read under the
 * `__Host-` cookie name, or null. `mode` is `consent` when the person is answering the screen: a
 * `prompt=none` request never reached one, so its refusal for needing consent belongs to the check.
 */
async function evaluate(
  env: AuthorizeEnv,
  raw: unknown,
  sessionId: number | null,
  mode: "check" | "consent",
): Promise<Done | { ready: Ready }> {
  // Step 1.
  const base = parseClientAndRedirect(raw);
  if ("done" in base) return base;
  const client = await env.DB.prepare(AUTHORIZE_CLIENT_SQL).bind(base.clientId).first<ClientRow>();
  if (!client || !isOidcSignInRule(client.sign_in_rule)) return errorPage("invalid_client");
  const registered = JSON.parse(client.redirect_uris) as string[];
  if (!registered.includes(base.redirectUri)) return errorPage("invalid_redirect_uri");

  // Step 2.
  const parsed = parseRest(env, client, base);
  if ("done" in parsed) return parsed;
  const request = parsed;
  const none = request.prompt.has("none");
  const refuse = (error: OidcAuthorizeRedirectError) =>
    done(errorRedirect(env, request.redirectUri, request.state, error));
  const asksFreshness = request.prompt.has("login") || request.maxAge !== null;

  // Step 3.
  const session =
    sessionId === null
      ? null
      : await env.DB.prepare(AUTHORIZE_SESSION_SQL).bind(sessionId).first<SessionRow>();
  if (!session) {
    if (none) return refuse("login_required");
    if (!asksFreshness) return done({ kind: "login", request: request.params.toString() });
    const clock = await env.DB.prepare(NOW_UNIX_SQL).first<{ now_unix: number }>();
    if (!clock) throw new Error("D1 returned no clock");
    return done({ kind: "login", request: await returnRequest(env, request, clock.now_unix) });
  }

  // Step 4. Only a marker this API signed for this client, inside its window, counts.
  const authAfter = await verifyAuthAfterMarker(
    requireSecret(env),
    request.authAfterRaw,
    request.clientId,
    session.now_unix,
  );
  const signedInForThisFlow = authAfter !== null && session.created_unix >= authAfter;
  let stale = false;
  if (!signedInForThisFlow) {
    stale =
      authAfter !== null ||
      request.prompt.has("login") ||
      (request.maxAge !== null && session.now_unix - session.created_unix > request.maxAge);
    if (!stale && request.idTokenHint !== null) {
      const hinted = await idTokenHintSubject(env, request.idTokenHint);
      stale = hinted !== null && hinted !== session.oidc_subject;
    }
  }
  if (stale) {
    if (none) return refuse("login_required");
    return done({ kind: "reauth", request: await returnRequest(env, request, session.now_unix) });
  }

  // Step 5.
  const reason = signInRuleRefusal(client.sign_in_rule as OidcSignInRule, session);
  if (reason !== null) {
    if (none) return refuse("access_denied");
    return done({
      kind: "rule_refused",
      reason,
      client_name: client.name,
      location: appendToRedirect(
        request.redirectUri,
        withStateAndIssuer(env, request.state, [["error", "access_denied"]]),
      ),
    });
  }

  // Step 6. First-party is re-decided now, from every registered address.
  const firstParty =
    client.first_party === 1 && registered.every((uri) => isFirstPartyRedirect(uri, env));
  let consentNeeded = false;
  if (!firstParty) {
    if (client.consent_mode !== "ask_once" || request.prompt.has("consent")) {
      consentNeeded = true;
    } else {
      const grant = await env.DB.prepare(LIVE_GRANT_SQL)
        .bind(session.session_id, client.id)
        .first<{ scopes: string; consent_kind: string }>();
      const granted = new Set(
        grant && grant.consent_kind === "user" ? (JSON.parse(grant.scopes) as string[]) : [],
      );
      consentNeeded = !request.scopes.every((s) => granted.has(s));
    }
  }
  if (consentNeeded && none && mode === "check") return refuse("consent_required");

  return { ready: { client, request, session, firstParty, consentNeeded } };
}

// ---------------------------------------------------------------------------------------------
// Step 7 and the two routes' answers
// ---------------------------------------------------------------------------------------------

/**
 * Write the grant (when `grantKind` says one is recorded) and the code in one batch, with the prune,
 * and answer the redirect that carries the code. A batch whose code insert wrote nothing (the
 * session, the account, the client or the grant changed since the request was read) answers the
 * error page, never a redirect: there is no code to send.
 */
async function mint(
  env: AuthorizeEnv,
  ready: Ready,
  grantKind: "first_party" | "user" | null,
): Promise<OidcAuthorizeAnswer> {
  const { client, request, session } = ready;
  const db = env.DB;
  const code = generateGrantCode();
  const scopes = JSON.stringify(request.scopes);
  const statements = [db.prepare(CODES_PRUNE_SQL)];
  if (grantKind !== null) {
    statements.push(
      db.prepare(GRANT_UPSERT_SQL).bind(scopes, grantKind, client.client_id, session.session_id),
    );
  }
  statements.push(
    db
      .prepare(CODE_INSERT_SQL)
      .bind(
        await hashGrantCode(code),
        request.redirectUri,
        scopes,
        request.nonce,
        request.codeChallenge,
        OIDC_AUTHORIZATION_CODE_TTL_SECONDS,
        client.client_id,
        session.session_id,
        scopes,
        request.redirectUri,
      ),
  );
  const results = await db.batch(statements);
  if ((results.at(-1)?.meta?.changes ?? 0) === 0) {
    return { kind: "error_page", code: "unavailable" };
  }
  return {
    kind: "redirect",
    location: appendToRedirect(
      request.redirectUri,
      withStateAndIssuer(env, request.state, [["code", code]]),
    ),
  };
}

/**
 * `POST /auth/oidc/authorize`: walk steps 1 to 6 and answer. A request that needs consent gets the
 * screen and a consent token; one that does not gets a code (a first-party client's authorization
 * records a `first_party` grant as it does).
 */
export async function checkAuthorization(
  env: AuthorizeEnv,
  raw: unknown,
  sessionId: number | null,
): Promise<OidcAuthorizeAnswer> {
  const evaluation = await evaluate(env, raw, sessionId, "check");
  if ("done" in evaluation) return evaluation.done;
  const ready = evaluation.ready;
  if (!ready.consentNeeded) return mint(env, ready, ready.firstParty ? "first_party" : null);
  const scopes = new Set(ready.request.scopes);
  return {
    kind: "consent",
    client_name: ready.client.name,
    scopes: OIDC_SCOPE_NAMES.filter((name) => scopes.has(name)),
    compute_spend: scopes.has("compute.reserve") || scopes.has("compute.submit"),
    consent_token: await mintConsentToken(
      requireSecret(env),
      bindingOf(ready),
      ready.session.now_unix,
    ),
    redirect_origin: new URL(ready.request.redirectUri).origin,
  };
}

/**
 * `POST /auth/oidc/consent`: walk steps 1 to 6 again, then honour the person's answer only if the
 * consent token proves the screen was shown to this session for this request in the last ten
 * minutes. Deny returns the person to the client with `access_denied`; allow records a `user` grant
 * and mints a code.
 */
export async function decideConsent(
  env: AuthorizeEnv,
  raw: unknown,
  consentToken: unknown,
  decision: OidcConsentDecision,
  sessionId: number | null,
): Promise<OidcAuthorizeAnswer> {
  const evaluation = await evaluate(env, raw, sessionId, "consent");
  if ("done" in evaluation) return evaluation.done;
  const ready = evaluation.ready;
  const proven = await verifyConsentToken(
    requireSecret(env),
    consentToken,
    bindingOf(ready),
    ready.session.now_unix,
  );
  if (!proven) return { kind: "error_page", code: "consent_invalid" };
  if (decision === "deny") {
    return errorRedirect(env, ready.request.redirectUri, ready.request.state, "access_denied");
  }
  return mint(env, ready, "user");
}
