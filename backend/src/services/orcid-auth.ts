/**
 * ORCID OAuth 2.0 SSO helpers (#832).
 *
 * ORCID is a confidential authorization-code client. The browser-facing
 * redirects are reached through the same same-origin proxy the passwordless
 * flow uses (so the session cookie stays host-scoped to app.nemar.org), and
 * the code->token exchange runs here in the Worker with ORCID_CLIENT_SECRET.
 *
 * Scope is `/authenticate` only: ORCID's token response carries `orcid` (the
 * iD) and `name` directly in the JSON body, so there is no id_token to verify
 * and no Member API call needed. The TLS server-to-server exchange with our
 * client_secret is the trust anchor; we read orcid + name and discard the
 * access token (ORCID tokens live ~20 years -- nothing worth storing).
 *
 * No PKCE: ORCID deliberately does not support it (orcid/ORCID-Source#5977).
 * CSRF is the `state` param compared against the state cookie (`__Host-nemar_oauth_state`)
 * in the callback route.
 *
 * The security-critical decisions (link outcome, discovered-vs-verified iD
 * reconciliation) live as pure functions here so they are unit-tested
 * independently of the HTTP plumbing in routes/auth-orcid.ts.
 */

import { timingSafeEqual } from "../lib/constant-time";
import type { Bindings } from "../types/bindings";

export const ORCID_SCOPE = "/authenticate";

/**
 * The two cookies that can mint or link a session (the CSRF state of the ORCID flow, and the
 * pending signup that carries a verified iD across the email step) are host-only and `__Host-`
 * prefixed, like the session cookie (ADR 0119, decision 10). A cookie the API trusts to
 * authenticate or link a session must be one a page on a sibling host cannot set: the partner-host
 * rule does not stop a sibling from setting a cookie for the parent domain, and a `__Host-` cookie
 * (Secure, Path=/, no Domain) is the one kind a browser will not accept from any other host.
 *
 * NOT behind `HOST_PREFIXED_SESSION_COOKIE`: nothing on the website reads the state cookie, and
 * the website checks the pending cookie only for presence, under either name. The state cookie
 * is read ONLY under the new name, with no fallback, so an old-name state cookie is no state
 * (it lives ten minutes, so a flow that was in flight at the deploy fails once with
 * `orcid_state`).
 */
export const STATE_COOKIE_NAME = "__Host-nemar_oauth_state";
/** Pending-signup cookie for a brand-new ORCID with no NEMAR account yet
 *  (carries the verified iD + name across the email-collection step). */
export const PENDING_COOKIE_NAME = "__Host-nemar_orcid_pending";
/** The names before the move. Still CLEARED, never read (except on an http loopback request). */
export const LEGACY_STATE_COOKIE_NAME = "nemar_oauth_state";
export const LEGACY_PENDING_COOKIE_NAME = "nemar_orcid_pending";

/**
 * True for a plain-http request to a loopback host: local development (`wrangler dev`).
 *
 * A `__Host-` cookie must be `Secure`, and a browser on plain http may refuse it, so local
 * development keeps the unprefixed names, the same way the website's dev login keeps the legacy
 * session cookie name (`devSessionCookie` in the website's `auth-dev.ts`). `Secure` itself is
 * set on every one of these cookies today and stays set: it is the NAME that changes. Anything
 * that is not plain http on loopback gets the prefixed names, including https on localhost.
 */
export function isLoopbackHttp(requestUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return false;
  }
  const host = url.hostname;
  return (
    url.protocol === "http:" &&
    (host === "localhost" ||
      host === "127.0.0.1" ||
      host === "[::1]" ||
      host.endsWith(".localhost"))
  );
}

function cookie(
  name: string,
  value: string,
  opts: { domain?: string; maxAgeSeconds?: number } = {},
): string {
  const parts = [`${name}=${value}`, "HttpOnly", "Secure", "SameSite=Lax", "Path=/"];
  if (opts.domain) parts.push(`Domain=${opts.domain}`);
  if (typeof opts.maxAgeSeconds === "number") parts.push(`Max-Age=${opts.maxAgeSeconds}`);
  return parts.join("; ");
}

/** The state and pending cookies of the ORCID flow, for ONE request: the names to read, and the
 *  `Set-Cookie` values to write and to clear. */
export interface OauthCookies {
  /** The name the state cookie is read under for this request. */
  stateName: string;
  /** The name the pending cookie is read under for this request. */
  pendingName: string;
  state(value: string, maxAgeSeconds: number): string;
  pending(value: string, maxAgeSeconds: number): string;
  clearState(): string[];
  clearPending(): string[];
}

/**
 * The cookie set for a request. `domain` is `WEB_SESSION_COOKIE_DOMAIN`.
 *
 * Off loopback: the `__Host-` names with no `Domain`, and clears of the old names, with the
 * configured `Domain` and without, so a stale old-name cookie disappears. On plain-http loopback
 * (see {@link isLoopbackHttp}): the old names with the configured `Domain`, exactly as before.
 */
export function oauthCookies(requestUrl: string, domain: string | undefined): OauthCookies {
  if (isLoopbackHttp(requestUrl)) {
    const clear = (name: string) => [cookie(name, "", { domain, maxAgeSeconds: 0 })];
    return {
      stateName: LEGACY_STATE_COOKIE_NAME,
      pendingName: LEGACY_PENDING_COOKIE_NAME,
      state: (value, maxAgeSeconds) =>
        cookie(LEGACY_STATE_COOKIE_NAME, value, { domain, maxAgeSeconds }),
      pending: (value, maxAgeSeconds) =>
        cookie(LEGACY_PENDING_COOKIE_NAME, value, { domain, maxAgeSeconds }),
      clearState: () => clear(LEGACY_STATE_COOKIE_NAME),
      clearPending: () => clear(LEGACY_PENDING_COOKIE_NAME),
    };
  }
  const clear = (name: string, legacy: string) => [
    cookie(name, "", { maxAgeSeconds: 0 }),
    ...(domain ? [cookie(legacy, "", { domain, maxAgeSeconds: 0 })] : []),
    cookie(legacy, "", { maxAgeSeconds: 0 }),
  ];
  return {
    stateName: STATE_COOKIE_NAME,
    pendingName: PENDING_COOKIE_NAME,
    state: (value, maxAgeSeconds) => cookie(STATE_COOKIE_NAME, value, { maxAgeSeconds }),
    pending: (value, maxAgeSeconds) => cookie(PENDING_COOKIE_NAME, value, { maxAgeSeconds }),
    clearState: () => clear(STATE_COOKIE_NAME, LEGACY_STATE_COOKIE_NAME),
    clearPending: () => clear(PENDING_COOKIE_NAME, LEGACY_PENDING_COOKIE_NAME),
  };
}

/** ORCID iD canonical form: 4 groups of 4 digits, last char may be X (checksum). */
const ORCID_ID_RE = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/;

export function isValidOrcidId(value: string | null | undefined): value is string {
  return typeof value === "string" && ORCID_ID_RE.test(value);
}

/** Accept a bare iD or a full `https://orcid.org/<id>` URI; return the bare
 *  iD, or null if no well-formed iD is present. */
export function normalizeOrcidId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = raw.trim().match(/(\d{4}-\d{4}-\d{4}-\d{3}[\dX])$/);
  return m ? m[1] : null;
}

export interface OrcidConfig {
  /** No trailing slash, e.g. https://orcid.org or https://sandbox.orcid.org */
  base: string;
  clientId: string;
  clientSecret: string;
}

/** Read ORCID config from env. Returns null when the client credentials are
 *  unset so the route can degrade to a clear "unavailable" redirect rather
 *  than a 500. Base defaults to the sandbox outside production. */
export function getOrcidConfig(env: Bindings): OrcidConfig | null {
  const clientId = env.ORCID_CLIENT_ID;
  const clientSecret = env.ORCID_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  const base =
    env.ORCID_API_BASE?.trim() ||
    (env.ENVIRONMENT === "production" ? "https://orcid.org" : "https://sandbox.orcid.org");
  return { base: base.replace(/\/+$/, ""), clientId, clientSecret };
}

export interface BuildAuthorizeUrlOptions {
  config: Pick<OrcidConfig, "base" | "clientId">;
  redirectUri: string;
  state: string;
  scope?: string;
}

export function buildAuthorizeUrl(o: BuildAuthorizeUrlOptions): string {
  const u = new URL(`${o.config.base}/oauth/authorize`);
  u.searchParams.set("client_id", o.config.clientId);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", o.scope ?? ORCID_SCOPE);
  u.searchParams.set("redirect_uri", o.redirectUri);
  u.searchParams.set("state", o.state);
  return u.toString();
}

export interface OrcidTokenResult {
  /** Validated bare iD. */
  orcid: string;
  /** ORCID may withhold the name; null when absent/blank. */
  name: string | null;
}

/** Exchange an authorization code for the ORCID token response and pull out
 *  `orcid` + `name`. The access token is intentionally discarded. Network is
 *  reached via `config.base`, so tests point that at a local Bun.serve. */
export async function exchangeCodeForOrcid(
  config: OrcidConfig,
  code: string,
  redirectUri: string,
  fetchFn: typeof fetch = fetch,
): Promise<OrcidTokenResult> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });
  const res = await fetchFn(`${config.base}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(
      `ORCID token exchange -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`,
    );
  }
  const json = (await res.json()) as { orcid?: unknown; name?: unknown };
  const orcid = normalizeOrcidId(typeof json.orcid === "string" ? json.orcid : null);
  if (!orcid) {
    throw new Error(
      `ORCID token response missing or invalid \`orcid\`: ${JSON.stringify(json).slice(0, 200)}`,
    );
  }
  const name = typeof json.name === "string" && json.name.trim() ? json.name.trim() : null;
  return { orcid, name };
}

// ---------------------------------------------------------------------
// state cookie (CSRF + carried mode/next, kept server-side via the cookie
// so neither is exposed or tamperable in the redirect URL)
// ---------------------------------------------------------------------

export type OauthMode = "login" | "link" | "relink";

export interface OauthState {
  csrf: string;
  mode: OauthMode;
  /** Same-origin relative path to land on after the flow. */
  next: string;
}

function b64urlEncode(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function b64urlDecode(s: string): string {
  const pad = (s + "===".slice((s.length + 3) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return atob(pad);
}

export function encodeState(s: OauthState): string {
  return b64urlEncode(JSON.stringify(s));
}

export function decodeState(raw: string | null | undefined): OauthState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(b64urlDecode(raw)) as Partial<OauthState>;
    if (typeof parsed.csrf !== "string" || parsed.csrf.length === 0) return null;
    const mode: OauthMode =
      parsed.mode === "link" || parsed.mode === "relink" ? parsed.mode : "login";
    const next = safeNextPath(typeof parsed.next === "string" ? parsed.next : "/");
    return { csrf: parsed.csrf, mode, next };
  } catch {
    return null;
  }
}

/** 256 bits of URL-safe randomness for the CSRF token. */
export function generateCsrf(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return b64urlEncode(String.fromCharCode(...bytes));
}

/** Reject open-redirect targets: only same-origin absolute paths survive.
 *  `//evil.com`, backslashes, CR/LF, and anything not starting with `/`
 *  collapse to `/`. */
export function safeNextPath(raw: string | null | undefined): string {
  if (!raw || typeof raw !== "string") return "/";
  if (raw.includes("\\") || raw.includes("\n") || raw.includes("\r")) return "/";
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return "/";
  }
  if (!decoded.startsWith("/") || decoded.startsWith("//")) return "/";
  if (decoded.includes("\\") || decoded.includes("\n") || decoded.includes("\r")) return "/";
  return raw;
}

// ---------------------------------------------------------------------
// pure decision helpers (security-critical; unit-tested directly)
// ---------------------------------------------------------------------

export type LinkOutcome = "already_linked" | "conflict" | "link_new";

/** Decide what happens when an authenticated user finishes an ORCID flow.
 *   - no existing identity            -> link it ("link_new")
 *   - identity already on this user   -> idempotent ("already_linked")
 *   - identity on a different user    -> refuse ("conflict"); one ORCID can
 *                                        only back one NEMAR account.
 */
export function decideLinkOutcome(
  existingIdentityUserId: number | null,
  currentUserId: number,
): LinkOutcome {
  if (existingIdentityUserId === null) return "link_new";
  if (existingIdentityUserId === currentUserId) return "already_linked";
  return "conflict";
}

export type SecondOrcidOutcome = "replace" | "refuse";

/**
 * Decide what happens when an authenticated user completes a flow with an iD
 * that is linked to NO account, while already having a *different* linked iD
 * (#913). Only an explicit relink flow (Settings' "Change / re-link", which
 * starts with mode=relink behind a confirm step) may swap the identity; a
 * login- or link-mode completion keeps the historical refusal so a stray
 * second sign-in can never silently rewrite which iD backs the account.
 * The conflict case (new iD backs a DIFFERENT account) never reaches this
 * decision — decideLinkOutcome refuses it first, in every mode.
 */
export function decideSecondOrcidOutcome(mode: OauthMode): SecondOrcidOutcome {
  return mode === "relink" ? "replace" : "refuse";
}

/**
 * The identity-swap statement set for an explicit relink (#913), exported as
 * SQL + params so the behavioral test can run the real statements against a
 * real SQLite (the audit-log.ts pattern). DELETE + INSERT rather than UPDATE:
 * if a concurrent unlink already removed the row, the DELETE matches nothing
 * and the INSERT still lands, so the final state honours the user's expressed
 * intent either way. UNIQUE(provider, provider_subject) remains the backstop
 * against a concurrent claim of the new iD by another account.
 *
 * users.orcid is deliberately overwritten here, unlike decideVerifiedFlag's
 * keep-the-citation-value rule for first links: a relink is the user
 * explicitly correcting which iD is theirs, so the citation value follows it
 * and orcid_verified=1 records that the two agree (0050's invariant).
 */
export const RELINK_DELETE_IDENTITY_SQL =
  "DELETE FROM oauth_identities WHERE user_id = ? AND provider = 'orcid'";
export const RELINK_INSERT_IDENTITY_SQL = `INSERT INTO oauth_identities (user_id, provider, provider_subject, provider_email, display_name, last_login_at)
   VALUES (?, 'orcid', ?, NULL, ?, datetime('now'))`;
export const RELINK_UPDATE_USER_SQL = "UPDATE users SET orcid = ?, orcid_verified = 1 WHERE id = ?";

export function relinkParams(
  userId: number,
  newOrcid: string,
  displayName: string | null,
): {
  deleteIdentity: [number];
  insertIdentity: [number, string, string | null];
  updateUser: [string, number];
} {
  return {
    deleteIdentity: [userId],
    insertIdentity: [userId, newOrcid, displayName],
    updateUser: [newOrcid, userId],
  };
}

export interface VerifiedFlagDecision {
  /** New value for users.orcid, or null to leave it unchanged. */
  setUsersOrcid: string | null;
  /** New value for users.orcid_verified. */
  orcidVerified: 0 | 1;
  /** True when the verified iD disagrees with an existing discovered value;
   *  the route logs this for admin reconciliation. */
  needsAdminReview: boolean;
}

/** Reconcile a freshly OAuth-verified iD against the citation-facing
 *  `users.orcid` (which may hold a DOI-*discovered* iD from enrichment).
 *   - users.orcid empty           -> adopt the verified iD, mark verified
 *   - users.orcid == verified iD  -> mark verified (they agree)
 *   - users.orcid != verified iD  -> keep the citation value, do NOT mark
 *                                    verified, flag for admin review. The
 *                                    real verified iD still lives in
 *                                    oauth_identities.provider_subject.
 */
export function decideVerifiedFlag(
  existingUsersOrcid: string | null | undefined,
  verifiedOrcid: string,
): VerifiedFlagDecision {
  const current = normalizeOrcidId(existingUsersOrcid ?? null);
  if (!current) {
    return { setUsersOrcid: verifiedOrcid, orcidVerified: 1, needsAdminReview: false };
  }
  if (current === verifiedOrcid) {
    return { setUsersOrcid: null, orcidVerified: 1, needsAdminReview: false };
  }
  return { setUsersOrcid: null, orcidVerified: 0, needsAdminReview: true };
}

// ---------------------------------------------------------------------
// public-record name lookup (#835)
//
// ORCID is the canonical source for a researcher's name. The /authenticate
// token body only carries the full `name`, not the given/family split, so to
// store structured names we read the public record (no client creds needed).
// ---------------------------------------------------------------------

/** Public ORCID API host for reading a record. No auth required. Mirrors the
 *  sandbox/prod split of the OAuth base. */
export function orcidPubBase(env: Bindings): string {
  // Explicit override wins: the derivation below can only ever produce one of
  // ORCID's two public hosts, so a mirror -- or a local server standing in for
  // ORCID in a test -- has no other way in.
  const explicit = env.ORCID_PUB_API_BASE?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const base =
    env.ORCID_API_BASE?.trim() ||
    (env.ENVIRONMENT === "production" ? "https://orcid.org" : "https://sandbox.orcid.org");
  return base.includes("sandbox") ? "https://pub.sandbox.orcid.org" : "https://pub.orcid.org";
}

export interface OrcidName {
  given: string | null;
  family: string | null;
}

/** Read the public given/family name for an ORCID iD. Best-effort: returns
 *  nulls when the record hides its name; throws only on a transport/HTTP error
 *  so callers can log and continue without a name. `pubBase` lets tests point
 *  at a local Bun.serve. */
export async function fetchOrcidName(
  orcid: string,
  pubBase: string,
  fetchFn: typeof fetch = fetch,
): Promise<OrcidName> {
  const res = await fetchFn(`${pubBase}/v3.0/${orcid}/personal-details`, {
    headers: { Accept: "application/json" },
    // Bounded like the other ORCID reads (doi-orcid-discovery.ts). Load
    // bearing since #1255: the name backfill loops this up to 100 times in a
    // single Worker invocation, so one hung connection must not consume the
    // whole request budget. A timeout throws, which callers already treat as
    // "no name from the record" / lookup_failed.
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`ORCID personal-details ${orcid} -> HTTP ${res.status}`);
  }
  const json = (await res.json()) as {
    name?: {
      "given-names"?: { value?: unknown } | null;
      "family-name"?: { value?: unknown } | null;
    } | null;
  };
  const name = json.name ?? null;
  const pick = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    given: name ? pick(name["given-names"]?.value) : null,
    family: name ? pick(name["family-name"]?.value) : null,
  };
}

// ---------------------------------------------------------------------
// pending-signup token (brand-new ORCID, no NEMAR account yet)
//
// ORCID gives us a verified iD + name but no email, and users.email is
// NOT NULL, so the account cannot be created until the user supplies an
// email. We carry the verified iD across that email-collection step in an
// HMAC-signed, short-lived cookie rather than a DB row: the signature
// (keyed with ENCRYPTION_KEY) makes the iD unforgeable, and there is no
// orphan row to clean up if the user abandons the form.
// ---------------------------------------------------------------------

export interface PendingOrcid {
  orcid: string;
  name: string | null;
  /** Epoch ms after which the token is rejected. */
  exp: number;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  const arr = new Uint8Array(sig);
  let out = "";
  for (let i = 0; i < arr.length; i++) out += arr[i].toString(16).padStart(2, "0");
  return out;
}

export async function signPending(p: PendingOrcid, secret: string): Promise<string> {
  const payload = b64urlEncode(JSON.stringify(p));
  const sig = await hmacHex(secret, payload);
  return `${payload}.${sig}`;
}

export async function verifyPending(
  token: string | null | undefined,
  secret: string,
  nowMs: number,
): Promise<PendingOrcid | null> {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = await hmacHex(secret, payload);
  if (!timingSafeEqual(sig, expected)) return null;
  try {
    const p = JSON.parse(b64urlDecode(payload)) as Partial<PendingOrcid>;
    if (!isValidOrcidId(p.orcid) || typeof p.exp !== "number") return null;
    if (nowMs > p.exp) return null;
    return { orcid: p.orcid, name: typeof p.name === "string" ? p.name : null, exp: p.exp };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------
// CLI-initiated link state (#1266, ADR 0044)
// ---------------------------------------------------------------------
//
// ORCID is a browser flow and stays one: the CLI cannot show a consent
// screen, and nobody should type an ORCID password into a terminal. So
// `POST /auth/orcid/cli-start` mints the intent for the TOKEN'S account and
// hands back a URL to open; the browser that opens it has no NEMAR session,
// which is exactly what the callback used to resolve the user from.
//
// The account therefore travels INSIDE the state, and the state is HMAC
// signed with ENCRYPTION_KEY (the same key and the same construction as the
// pending-signup cookie above). Two properties follow, and both are
// load-bearing:
//
//   - a state minted for user A can never link to user B, because the id is
//     covered by the signature and nothing else in the callback supplies one
//     for this path; and
//   - a state cannot be MADE at all without a live API token for the account
//     it names, so the ADR 0022 rule survives: relink intent is still minted
//     only by an authenticated POST, never by following a link.
//
// The token is short-lived (10 minutes, the same TTL as the website's state
// cookie) and is carried to ORCID in the state COOKIE rather than in the
// `state` query parameter, so a leaked authorize URL is not on its own enough
// to finish a link from another browser -- see `/auth/orcid/cli-handoff`.

/** How long a CLI-minted ORCID link intent stays usable. */
export const CLI_STATE_TTL_MS = 10 * 60 * 1000;

export interface CliOauthState {
  csrf: string;
  /** Never "login": a CLI flow always acts on an existing account. */
  mode: "link" | "relink";
  /** The account the intent was minted FOR. Covered by the signature. */
  userId: number;
  /**
   * Server-side handle for this intent (`orcid_link_intents.nonce`, migration
   * 0078). The signature makes an intent unforgeable; this makes it
   * UNREPEATABLE -- the callback consumes the row, so a second completion with
   * the same URL is refused. Covered by the signature like the rest, so a
   * replay cannot swap in a fresh nonce.
   */
  nonce: string;
  /** Same-origin relative path to land the browser on afterwards. */
  next: string;
  /** Epoch ms after which the state is rejected. */
  exp: number;
}

export async function signCliState(s: CliOauthState, secret: string): Promise<string> {
  const payload = b64urlEncode(JSON.stringify(s));
  const sig = await hmacHex(secret, payload);
  return `${payload}.${sig}`;
}

/**
 * Verify and decode a CLI state, or null for anything that is not one: a
 * missing value, a web flow's plain state cookie, a bad signature, an expired
 * intent, or a payload whose fields are not the shape above.
 *
 * `null` is not an error here -- the callback tries this FIRST and falls back
 * to the web `decodeState`, so "this is not a CLI state" is the normal answer
 * for every dashboard sign-in.
 */
export async function verifyCliState(
  token: string | null | undefined,
  secret: string,
  nowMs: number,
): Promise<CliOauthState | null> {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = await hmacHex(secret, payload);
  if (!timingSafeEqual(sig, expected)) return null;
  try {
    const p = JSON.parse(b64urlDecode(payload)) as Partial<CliOauthState>;
    if (typeof p.csrf !== "string" || p.csrf.length === 0) return null;
    if (p.mode !== "link" && p.mode !== "relink") return null;
    if (typeof p.userId !== "number" || !Number.isInteger(p.userId) || p.userId <= 0) return null;
    // A state with no nonce cannot be consumed, so it cannot be single-use.
    // Rejected outright rather than treated as "no replay protection": the
    // only states without one predate migration 0078 and expired long ago.
    if (typeof p.nonce !== "string" || p.nonce.length === 0) return null;
    if (typeof p.exp !== "number" || nowMs > p.exp) return null;
    return {
      csrf: p.csrf,
      mode: p.mode,
      userId: p.userId,
      nonce: p.nonce,
      next: safeNextPath(typeof p.next === "string" ? p.next : "/"),
      exp: p.exp,
    };
  } catch {
    return null;
  }
}
