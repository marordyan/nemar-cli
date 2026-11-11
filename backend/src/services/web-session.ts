/**
 * Web-dashboard session helpers (#569).
 *
 * The dashboard authenticates via an opaque HttpOnly session cookie.
 * The CLI continues to use bearer API tokens. These helpers are shared by
 * every cookie-authenticated route — the passwordless and email-verification
 * flows and the settings endpoints in `routes/auth-web.ts`, the ORCID flow in
 * `routes/auth-orcid.ts`, `middleware/webSession.ts`, and the cookie path of
 * `middleware/auth.ts` (#572), which is how the dashboard reaches the
 * user-scoped /datasets and /users routes.
 *
 * Cookie value is 256 bits of random base64url. Only the SHA-256 hash
 * of that value lives in D1, so an exfiltrated DB cannot forge
 * cookies (256-bit preimage). The hashing is unkeyed because the
 * value's entropy is already infeasible to brute. The hashing for
 * auth codes IS keyed (HMAC-SHA256) because 6-digit codes have only
 * ~20 bits of entropy and an unkeyed at-rest hash could be
 * brute-forced offline.
 */

import type { AccountKind, AccountStatus } from "../../../shared/contract/user.js";
import { isPartnerHost } from "../../../shared/partner-hosts.js";
import { flag } from "../db/flag";
import { type Bindings, type UserRole, parseRole } from "../types/bindings";

/** The app session cookie's name once `HOST_PREFIXED_SESSION_COOKIE` is on (ADR 0119 decision 10).
 *
 *  `__Host-` is enforced by the browser: it refuses the cookie unless it is `Secure`, has
 *  `Path=/` and carries NO `Domain`, and it will not let any other host set one for this host.
 *  The principle: every cookie the API trusts to authenticate or link a session is host-only and
 *  `__Host-` prefixed, because a page on a sibling host can set a cookie for the parent domain
 *  (`Domain=nemar.org`), which is how the legacy name below is scoped.
 *
 *  The cookie stays host-only (ADR 0056): this name never goes through
 *  `WEB_SESSION_COOKIE_DOMAIN`, and a `Domain` on it would make a browser discard it. */
export const SESSION_COOKIE_NAME = "__Host-nemar_session";

/** The name every session cookie had before the move. Still READ for as long as the legacy
 *  window lasts, so a session minted before the flag is a session after it, and still WRITTEN
 *  (with its `Domain`) while the flag is off. */
export const LEGACY_SESSION_COOKIE_NAME = "nemar_session";

/** Which host's credential a `web_sessions` row is. `app` is every session the
 *  dashboard issues; `docs` is the short-lived admin credential the docs host
 *  holds (epic #1336 phase 0, migration 0083); `private` is the session the
 *  private site (`private.nemar.org`) holds for any active account (migration
 *  0089, ADR 0079).
 *
 *  One table, three scopes, and the scope is a REQUIRED argument to every lookup
 *  rather than an optional filter, defaulted to `app` so existing callers keep
 *  their exact behaviour. That default is the safe direction: a caller that
 *  forgets the argument authenticates app sessions only, which is what every
 *  pre-existing route wants.
 *
 *  This function is not the only reader, and that is the part worth remembering:
 *  `middleware/auth.ts` carries a second copy of the same SELECT for the
 *  management API, and it needs the predicate just as much. Review found it
 *  missing there after this one had it, and the docs credential authenticated
 *  `/admin/*` as a result. Prefer routing a new reader through this function over
 *  writing a third copy. */
export type SessionScope = "app" | "docs" | "private";

/** Server-side cap on non-remember-me sessions. Browser drops session
 *  cookies on close already; the cap keeps the DB row from outliving any
 *  reasonable session. It does NOT bound the table: nothing prunes expired
 *  `web_sessions` rows anywhere in this worker (an earlier version of this
 *  comment credited a cleanup that does not exist), so the row survives its
 *  own expiry -- inert, because every reader compares against it. */
const NON_REMEMBER_TTL_MS = 24 * 60 * 60 * 1000;
const REMEMBER_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Sliding-window refresh: only extend the expiry when the remaining
 *  lifetime drops below this threshold. Avoids a Set-Cookie storm on
 *  every dashboard request — most calls just bump last_used_at. */
const SLIDING_REFRESH_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

/** Origin allow-list for cookie-issuing/mutating routes.
 *
 *  A host on the partner list (`shared/partner-hosts.ts`) is refused even though it ends in
 *  `.nemar.org`: another party runs it, and a cookie-authenticated write from it would be a
 *  write from someone else's page.
 *
 *  Narrower than the CORS callback in `index.ts` on purpose: the
 *  CORS layer's `*.osc.earth` allowance was for the legacy api.osc.earth
 *  buffer; the web dashboard only lives on nemar.org / app.nemar.org,
 *  so accepting cookies via osc.earth domains is just attack surface
 *  with no real consumer. Localhost is allowed without a port check
 *  because dev tools commonly bind to ephemeral ports. */
export function isAllowedOrigin(origin: string | null | undefined): boolean {
  if (!origin) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const h = url.hostname.toLowerCase();
  // A partner host is not a NEMAR page (ADR 0119 decision 9), whatever its suffix says. Asked
  // first, so no rule below can admit it.
  if (isPartnerHost(h)) return false;
  if (h === "localhost" || h === "127.0.0.1") return true;
  if (h === "nemar.org" || h.endsWith(".nemar.org")) return true;
  return false;
}

/** 256 random bits, URL-safe base64 (43 chars, no padding). */
export function generateCookieId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

/** Unkeyed SHA-256 hex of the cookie value, for DB storage. */
export async function hashCookieId(cookieIdRaw: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(cookieIdRaw));
  const arr = new Uint8Array(digest);
  let out = "";
  for (let i = 0; i < arr.length; i++) out += arr[i].toString(16).padStart(2, "0");
  return out;
}

/** Best-effort SHA-256 of an IP for privacy-preserving storage. Returns
 *  null on empty input; callers should record null then. */
export async function hashIp(ip: string | null | undefined): Promise<string | null> {
  if (!ip) return null;
  return hashCookieId(ip);
}

/** Best-effort client IP off the request, preferring Cloudflare's
 *  `CF-Connecting-IP` and falling back to the first `X-Forwarded-For` hop.
 *  `null` when neither header is present (e.g. a local test request).
 *
 *  Hoisted here from routes/auth-orcid.ts (#1281, epic #1272 phase 1): the
 *  device-authorization routes need the same lookup for `hashIp`-backed
 *  audit details, and a helper earns a shared home once it has a second
 *  real consumer rather than living duplicated in each caller. */
export function clientIp(c: {
  req: { header: (k: string) => string | undefined };
}): string | null {
  return (
    c.req.header("CF-Connecting-IP") ||
    c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ||
    null
  );
}

/** Parse a single named cookie out of a request's `Cookie` header.
 *  Returns null if the header is missing or doesn't contain the name.
 *  Matches the strict comma-and-semicolon syntax of RFC 6265 enough
 *  for our purposes; we never set multi-value cookies. */
export function parseCookieHeader(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  const parts = header.split(";");
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) return part.slice(eq + 1).trim();
  }
  return null;
}

interface CookieOptions {
  domain?: string; // Empty/undefined → host-only (no Domain attribute)
  maxAgeSeconds?: number; // Undefined → session cookie (no Max-Age)
}

/** One `Set-Cookie` value. Flags: HttpOnly, Secure, SameSite=Lax, Path=/.
 *  Private on purpose: callers go through {@link sessionCookieHeaders}, so no route can pick a
 *  cookie name or a `Domain` for itself. */
function buildCookie(name: string, value: string, opts: CookieOptions = {}): string {
  const parts = [`${name}=${value}`, "HttpOnly", "Secure", "SameSite=Lax", "Path=/"];
  if (opts.domain) parts.push(`Domain=${opts.domain}`);
  if (typeof opts.maxAgeSeconds === "number") parts.push(`Max-Age=${opts.maxAgeSeconds}`);
  return parts.join("; ");
}

/**
 * Whether sessions are issued under the `__Host-` name. True only for the exact string `"1"`, so
 * a flag typed `true` or `0` cannot move anyone's cookie by accident.
 *
 * Unset is production until the owner sets it: the order of release is the website's reader, then
 * the API, then this flag, because a reader must exist before a writer (ADR 0119 decision 10).
 */
export function hostPrefixedSessionCookie(
  env: Pick<Bindings, "HOST_PREFIXED_SESSION_COOKIE">,
): boolean {
  return env.HOST_PREFIXED_SESSION_COOKIE === "1";
}

/**
 * The zone a sibling host can set a cookie for. A cookie set with `Domain=nemar.org` is sent to
 * every host in the zone, and is not removed by a clear scoped to `app.nemar.org` or to the host
 * alone, so the flag-on writers clear the legacy name for the parent domain too.
 */
const SESSION_PARENT_DOMAIN = "nemar.org";

/** What one pass over a `Cookie` header finds under the two session cookie names. */
interface SessionCookieScan {
  /** Every value under `__Host-nemar_session`. A browser sends at most one; more than one means
   *  the header did not come from a browser that stored it. */
  host: string[];
  /** Every value under the legacy `nemar_session`. More than one is normal during the window: a
   *  host-only and a `Domain` cookie of that name are both sent. */
  legacy: string[];
}

/**
 * The ONE parse of a request's session cookies. Everything below reads this, so no second copy of
 * the cookie syntax exists: {@link readSessionCookie}, {@link carriesHostSessionCookie} and
 * {@link allSessionCookieValues}.
 */
function scanSessionCookies(header: string | null | undefined): SessionCookieScan {
  const scan: SessionCookieScan = { host: [], legacy: [] };
  if (!header) return scan;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name === SESSION_COOKIE_NAME) scan.host.push(part.slice(eq + 1).trim());
    else if (name === LEGACY_SESSION_COOKIE_NAME) scan.legacy.push(part.slice(eq + 1).trim());
  }
  return scan;
}

/**
 * The session cookie out of a request's `Cookie` header, for EVERY reader of it, with the name it
 * was read under.
 *
 * The new name is read first and the legacy one only when the new one is absent. A new cookie
 * that is present but wrong (empty, expired, revoked) is NOT rescued by a valid legacy one: with
 * both on the wire the legacy one is, at best, a stale copy and, at worst, set by a page on a
 * sibling subdomain, and a request must never end up signed in as whoever set it because the
 * real cookie was spoiled. Swapping the order is exactly that bug. A header that carries MORE
 * THAN ONE `__Host-nemar_session` is no session at all, and is not rescued either.
 *
 * The name is returned because what a caller may do depends on it: a `__Host-` cookie is minted
 * only by a sign-in, so a route that re-issues the cookie (the expiry slide) must never do so
 * from a value that was read under the legacy name.
 *
 * Two readers exist and both call this: `webSessionMiddleware` and `resolveCookieUser`. Do not
 * add a third copy of the parse.
 */
export function readSessionCookie(
  header: string | null | undefined,
): { name: string; value: string } | null {
  const { host, legacy } = scanSessionCookies(header);
  if (host.length > 1) return null;
  if (host.length === 1) return { name: SESSION_COOKIE_NAME, value: host[0] };
  if (legacy.length > 0) return { name: LEGACY_SESSION_COOKIE_NAME, value: legacy[0] };
  return null;
}

/** True when the request carried a `__Host-nemar_session` cookie, whatever its value. The writers
 *  use it to clear one that is stale (see {@link sessionCookieHeaders}). */
export function carriesHostSessionCookie(header: string | null | undefined): boolean {
  return scanSessionCookies(header).host.length > 0;
}

/** Every distinct non-empty session cookie value the request carries, under either name. Sign-out
 *  revokes the session behind each, so signing out ends every session the browser could present. */
export function allSessionCookieValues(header: string | null | undefined): string[] {
  const { host, legacy } = scanSessionCookies(header);
  return [...new Set([...host, ...legacy].filter((v) => v !== ""))];
}

/**
 * Every `Set-Cookie` value that issues, refreshes or (with `value: ""` and `maxAgeSeconds: 0`)
 * ends a session. The five writers append all of them, in order. `cookieHeader` is the request's
 * own `Cookie` header, which is how a writer says whether the request carried a `__Host-` cookie.
 *
 * Flag off, request carried no `__Host-nemar_session`: exactly today's one header, byte for byte:
 * the legacy name, with `Domain` when `WEB_SESSION_COOKIE_DOMAIN` is set.
 *
 * Flag off, request carried one: the same header, then a clear of `__Host-nemar_session` (no
 * `Domain`). That cookie was issued while the flag was on and nothing else would ever remove it,
 * and the reader prefers it, so without the clear a person who signs out and in again after the
 * flag is turned back off stays signed out until it expires. This is what makes the flag
 * reversible. A request with no such cookie gets nothing extra.
 *
 * Flag on: the new name with `Secure; HttpOnly; SameSite=Lax; Path=/` and no `Domain`, then
 * clears of the legacy name: with the configured `Domain`, host-only, and with the zone's parent
 * domain (`nemar.org`), because a cookie is identified by name, domain and path and a sibling
 * host can set a parent-domain one that no other clear reaches. Duplicates are not sent: staging
 * leaves the domain empty, so its two are the same cookie.
 */
export function sessionCookieHeaders(
  env: Pick<Bindings, "WEB_SESSION_COOKIE_DOMAIN" | "HOST_PREFIXED_SESSION_COOKIE">,
  value: string,
  opts: { maxAgeSeconds?: number; cookieHeader?: string | null } = {},
): string[] {
  const domain = env.WEB_SESSION_COOKIE_DOMAIN || undefined;
  const { maxAgeSeconds, cookieHeader } = opts;
  if (!hostPrefixedSessionCookie(env)) {
    const headers = [buildCookie(LEGACY_SESSION_COOKIE_NAME, value, { domain, maxAgeSeconds })];
    if (carriesHostSessionCookie(cookieHeader)) {
      headers.push(buildCookie(SESSION_COOKIE_NAME, "", { maxAgeSeconds: 0 }));
    }
    return headers;
  }
  const headers = [buildCookie(SESSION_COOKIE_NAME, value, { maxAgeSeconds })];
  const clearDomains = new Set<string | undefined>([domain, undefined, SESSION_PARENT_DOMAIN]);
  for (const d of clearDomains) {
    headers.push(buildCookie(LEGACY_SESSION_COOKIE_NAME, "", { domain: d, maxAgeSeconds: 0 }));
  }
  return headers;
}

export interface WebSessionRow {
  id: number;
  user_id: number;
  /** Boolean here, even though D1 stores 0/1 — the conversion happens
   *  at the read boundary in `findSessionByCookieId` so consumers
   *  never have to remember the SQLite convention. */
  remember: boolean;
  /** SQLite's own `datetime()` spelling, `'YYYY-MM-DD HH:MM:SS'` in UTC, which
   *  is what every reader's `> datetime('now')` compares against. NOT an ISO
   *  string, and do not hand one to `new Date()` without appending a `Z` --
   *  see `maybeSlideExpiry`. */
  expires_at: string;
  last_used_at: string;
}

export interface WebSessionUser {
  id: number;
  email: string;
  /** Validated via `parseRole` at the DB boundary so downstream
   *  comparisons against the `UserRole` union are type-safe. `null`
   *  means the role column held an unrecognised value; treat as no
   *  role rather than guess. */
  role: UserRole | null;
  /** The COLUMN's vocabulary (shared/contract/user.ts), closed by migration
   *  0001's CHECK constraint -- not the collapsed value `/auth/me` reports,
   *  which `publicUser` derives from this one. */
  status: AccountStatus;
  /** Whether the account has proved control of `email` (ADR 0040 phase 2).
   *  Surfaced on /auth/me so the dashboard can render its verify-your-email
   *  step, and read by /auth/email/verify to answer idempotently when there
   *  is nothing left to verify. Converted from the 0/1 D1 column here. */
  email_verified: boolean;
  /** Profile fields surfaced on /auth/me for the website Settings page
   *  (#910). All nullable in D1 (migrations 0051/0052); `null` here means
   *  the column is unset, and the website renders its fallback state. */
  given_name: string | null;
  family_name: string | null;
  orcid: string | null;
  /** Boolean here, even though D1 stores 0/1 — converted at the read
   *  boundary like `WebSessionRow.remember`. */
  orcid_verified: boolean;
  github_username: string | null;
  city: string | null;
  country: string | null;
  affiliation: string | null;
  /** Tiered access (website ADR 0010, #1013): true once an admin grants service
   *  access (upload + compute). Base-access accounts are false. Converted
   *  from the 0/1 D1 column at the read boundary like `orcid_verified`. */
  service_access: boolean;
  /** NULL on every web/ORCID row until onboarding sets one (migration 0026).
   *  Carried on the session so /auth/me can report it: the dashboard was
   *  fetching it from GET /users/me separately, purely because it was absent
   *  here (nemarOrg/website#306). */
  username: string | null;
  /** True when that username was DERIVED from the name rather than chosen --
   *  by the ADR 0042 backfill sweep or at a web sign-in (#1268, ADR 0045) --
   *  and has not been changed since. Onboarding and Settings use it to offer
   *  "we picked this, change it if you like", an offer that would be nonsense
   *  to someone who typed their own. Converted from the 0/1 column here. */
  username_auto_assigned: boolean;
  /** The DATES behind the two upload-access states (ADR 0042), so the
   *  dashboard can render "granted"/"requested" as events rather than flags. */
  service_access_granted_at: string | null;
  upload_access_requested_at: string | null;
  /** What this account IS (epic #1272 phase 4, #1284; ADR 0048). Read so
   *  `publicUser` (routes/auth-web.ts) can compute `profile_gaps` for the
   *  session row through the same `profileGapsForRow` every other reader
   *  uses -- it is NOT itself put on the wire (webUserSchema carries no
   *  such field; only `userSchema` and `adminUserListItemSchema` do). */
  account_kind: AccountKind;
}

/** The `waitUntil` half of an `ExecutionContext`: all a caller outside the
 *  HTTP app needs to hand over so a background write outlives it. */
export type BackgroundContext = Pick<ExecutionContext, "waitUntil">;

/** Look up an active session by cookie value, returning the joined
 *  user row. Returns null if the cookie doesn't match, is revoked,
 *  or has expired. Touches last_used_at as a side effect.
 *
 *  `ctx` is optional and only changes how long that touch is kept alive. A
 *  caller outside the HTTP app (the service-binding entrypoint, `rpc/`)
 *  passes its `ExecutionContext` so the write is handed to `waitUntil`: a
 *  promise left floating there may be cancelled when the method returns. */
export async function findSessionByCookieId(
  env: Bindings,
  cookieIdRaw: string,
  scope: SessionScope = "app",
  ctx?: BackgroundContext,
): Promise<{ session: WebSessionRow; user: WebSessionUser } | null> {
  if (!cookieIdRaw) return null;
  const cookieHash = await hashCookieId(cookieIdRaw);
  // `u.status != 'revoked'` retires sessions for users an admin
  // revoked after the cookie was issued. Without it, a stale cookie
  // resolves to a valid login until the cookie expires or /auth/logout
  // lands.
  const row = await env.DB.prepare(
    `SELECT ws.id, ws.user_id, ws.remember, ws.expires_at, ws.last_used_at,
            u.email, u.role, u.status, u.email_verified,
            u.given_name, u.family_name, u.orcid, u.orcid_verified,
            u.github_username, u.city, u.country, u.affiliation, u.service_access,
            u.username, u.username_auto_assigned,
            u.service_access_granted_at, u.upload_access_requested_at, u.account_kind
       FROM web_sessions ws
       JOIN users u ON u.id = ws.user_id
      WHERE ws.cookie_id_hash = ?
        AND ws.scope = ?
        AND ws.revoked_at IS NULL
        AND ws.expires_at > datetime('now')
        AND u.status != 'revoked'
        AND u.deleted_at IS NULL
      LIMIT 1`,
  )
    .bind(cookieHash, scope)
    .first<{
      id: number;
      user_id: number;
      remember: number;
      expires_at: string;
      last_used_at: string;
      email: string;
      role: string | null;
      // Closed by migration 0001's CHECK constraint (shared/contract/user.ts).
      status: AccountStatus;
      // NOT NULL DEFAULT 0 in D1 (0001), so plain number.
      email_verified: number;
      given_name: string | null;
      family_name: string | null;
      orcid: string | null;
      // NOT NULL DEFAULT 0 in D1 (0050), so plain number.
      orcid_verified: number;
      github_username: string | null;
      city: string | null;
      country: string | null;
      affiliation: string | null;
      // NOT NULL DEFAULT 0 in D1 (0062), so plain number.
      service_access: number;
      // NULL on every web/ORCID row until onboarding sets one (migration 0026).
      username: string | null;
      // NOT NULL DEFAULT 0 in D1 (0079), so plain number.
      username_auto_assigned: number;
      // The two dates the dashboard needs to render "granted"/"requested" as
      // events rather than as flags (ADR 0042; nemarOrg/website#306).
      service_access_granted_at: string | null;
      upload_access_requested_at: string | null;
      // Closed by migration 0082's CHECK constraint (epic #1272 phase 4,
      // #1284; ADR 0048).
      account_kind: AccountKind;
    }>();
  if (!row) return null;

  // Bump last_used_at on every hit. This is fire-and-forget — we don't
  // want to fail the request on a slow D1 write, and a stale
  // last_used_at is harmless for now (no SLA on it).
  const touch = env.DB.prepare(
    `UPDATE web_sessions SET last_used_at = datetime('now') WHERE id = ?`,
  )
    .bind(row.id)
    .run()
    .catch((err) => console.error("[web-session] failed to bump last_used_at", err));
  ctx?.waitUntil(touch);

  return {
    session: {
      id: row.id,
      user_id: row.user_id,
      remember: row.remember === 1,
      expires_at: row.expires_at,
      last_used_at: row.last_used_at,
    },
    user: {
      id: row.user_id,
      email: row.email,
      role: parseRole(row.role, row.email),
      status: row.status,
      email_verified: row.email_verified === 1,
      given_name: row.given_name,
      family_name: row.family_name,
      orcid: row.orcid,
      orcid_verified: row.orcid_verified === 1,
      github_username: row.github_username,
      city: row.city,
      country: row.country,
      affiliation: row.affiliation,
      service_access: row.service_access === 1,
      username: row.username,
      username_auto_assigned: flag(row.username_auto_assigned),
      service_access_granted_at: row.service_access_granted_at,
      upload_access_requested_at: row.upload_access_requested_at,
      account_kind: row.account_kind,
    },
  };
}

/** How a session was established. Stored on `web_sessions.auth_method`
 *  (0050) so /auth/me and admin tooling can distinguish the flows.
 *
 *  `api_key` is written only by the CLI docs mint (`DOCS_CLI_MINT_INSERT_SQL`,
 *  epic #1336 phase 3), which spells the literal in SQL rather than binding a
 *  value from here. It is listed anyway: nothing surfaces this column today, so
 *  the omission was invisible, but migration 0050 says the column exists for
 *  "/auth/me and admin tooling", and the first reader to take that up would
 *  type it as this union and silently fail to model a real value.  */
export type AuthMethod = "email_code" | "orcid" | "api_key";

/** The cookie a caller will set, plus the not-yet-executed INSERT that makes
 *  it valid. Split out of `issueSession` so a caller can put the session row
 *  in the SAME `db.batch()` as the writes it must not outlive — a sign-in
 *  that consumes a code and promotes an account either lands whole or not at
 *  all (#1252 review). `issueSession` remains the one-shot form. */
export interface PreparedSession {
  cookieIdRaw: string;
  maxAgeSeconds: number | undefined;
  statement: D1PreparedStatement;
}

/**
 * Build (but do not run) the web_sessions INSERT for a new session.
 *
 * THE EXPIRY IS WRITTEN SQL-SIDE, and that is a fix rather than a style choice.
 * This used to bind `new Date(...).toISOString()` while every reader compares
 * `expires_at > datetime('now')`, and SQLite compares those two spellings as
 * TEXT: `'2026-09-10T11:07:21.484Z'` against `'2026-09-10 12:07:21'` is decided
 * by byte 11, where `'T'` (0x54) sorts after `' '` (0x20). So an ISO expiry
 * bearing the same calendar date as the moment of comparison ALWAYS compared
 * greater, and a session stayed live until the next UTC midnight past its
 * nominal expiry -- up to a day of extra life on a 24-hour session, silently.
 * This is the trap ADR 0047 records for the device flow, in the table the docs
 * gate's own `DOCS_GRANT_INSERT_SQL` re-proves an app session against.
 * Migration 0084 rewrites the rows the old code left behind. Never reintroduce
 * a JS timestamp here.
 *
 * `expiresAt` is deliberately no longer returned: no caller ever read it, and
 * the only honest value would now have to be read back from the row, since the
 * database's clock is the one that set it.
 */
export async function prepareSessionInsert(
  env: Bindings,
  userId: number,
  remember: boolean,
  userAgent: string | null,
  ip: string | null,
  authMethod: AuthMethod = "email_code",
): Promise<PreparedSession> {
  const cookieIdRaw = generateCookieId();
  const cookieIdHash = await hashCookieId(cookieIdRaw);
  const ttlSeconds = Math.floor((remember ? REMEMBER_TTL_MS : NON_REMEMBER_TTL_MS) / 1000);
  const ipHash = await hashIp(ip);

  return {
    cookieIdRaw,
    // Browser-session cookies (no Max-Age) for non-remember; explicit
    // Max-Age for remember-me so reloads survive a browser restart.
    maxAgeSeconds: remember ? ttlSeconds : undefined,
    statement: env.DB.prepare(
      `INSERT INTO web_sessions (
       user_id, cookie_id_hash, remember, expires_at, user_agent, ip_hash, auth_method
     ) VALUES (?, ?, ?, datetime('now', '+' || ? || ' seconds'), ?, ?, ?)`,
    ).bind(userId, cookieIdHash, remember ? 1 : 0, ttlSeconds, userAgent, ipHash, authMethod),
  };
}

/** Insert a new web_sessions row and return the row id + cookie
 *  options for the response. `cookieIdRaw` is returned to the caller
 *  so it can be set as the Set-Cookie value. */
export async function issueSession(
  env: Bindings,
  userId: number,
  remember: boolean,
  userAgent: string | null,
  ip: string | null,
  authMethod: AuthMethod = "email_code",
): Promise<{ cookieIdRaw: string; maxAgeSeconds: number | undefined }> {
  const prepared = await prepareSessionInsert(env, userId, remember, userAgent, ip, authMethod);
  await prepared.statement.run();
  const { cookieIdRaw, maxAgeSeconds } = prepared;
  return { cookieIdRaw, maxAgeSeconds };
}

/**
 * The account an UNREVOKED session cookie belongs to, whether or not that
 * session is still otherwise usable.
 *
 * One caller: `/auth/logout`'s cascade into the docs and private-site
 * credentials. Which predicates are dropped and which are kept is the whole
 * design here, and the two halves were each found by a separate round of review:
 *
 * - The EXPIRY and account predicates go. A docs session runs eight hours from
 *   its mint while a non-remember app session runs 24 hours from sign-in, so the
 *   windows do not nest, and keying the cascade on a live session meant signing
 *   out with a lapsed cookie answered `ok`, cleared the cookie, and left the
 *   docs session and any outstanding grant spendable.
 * - `revoked_at IS NULL` STAYS. Without it, a cookie value that had already been
 *   signed out remained a working handle for tearing down whatever docs session
 *   the account established later, and nothing prunes this table, so the handle
 *   would never expire. A revoked credential must confer nothing, including the
 *   power to revoke.
 *
 * Scope is unconstrained, which is safe rather than powerful: presenting a
 * docs- or private-scoped value here ends that same account's docs and
 * private-site access, which is what signing out is for, and nothing else (the
 * app session survives and can mint a new grant immediately), and those cookies
 * have different names on different hosts, so one cannot arrive by accident.
 *
 * NEVER use this to authenticate anything. It answers "whose unrevoked row is
 * this" and nothing about whether the row may still be used.
 */
export async function userIdForCookieId(
  env: Bindings,
  cookieIdRaw: string | null,
): Promise<number | null> {
  if (!cookieIdRaw) return null;
  const cookieHash = await hashCookieId(cookieIdRaw);
  const row = await env.DB.prepare(
    "SELECT user_id FROM web_sessions WHERE cookie_id_hash = ? AND revoked_at IS NULL LIMIT 1",
  )
    .bind(cookieHash)
    .first<{ user_id: number }>();
  return row?.user_id ?? null;
}

/**
 * The (not-yet-run) statement that marks the row backing this cookie revoked.
 * Idempotent.
 *
 * A statement rather than a one-shot call, for the same reason
 * `prepareSessionInsert` is: its only caller has to put it in the SAME
 * `db.batch()` as the writes it must not be separated from. Sign-out revokes
 * the app row AND the account's docs sessions and grants, and doing that in two
 * round trips means a failure between them leaves the app row revoked while the
 * docs credential lives on -- with the app row gone, `userIdForCookieId` can no
 * longer resolve the account, so a retry cannot finish the job either. One
 * batch is one transaction: all of it lands or none of it does, and "none"
 * leaves a state the retry can still act on.
 */
export async function revokeSessionStatement(
  env: Bindings,
  cookieIdRaw: string,
): Promise<D1PreparedStatement> {
  const cookieHash = await hashCookieId(cookieIdRaw);
  return env.DB.prepare(
    `UPDATE web_sessions SET revoked_at = datetime('now')
      WHERE cookie_id_hash = ? AND revoked_at IS NULL`,
  ).bind(cookieHash);
}

/** If a remember-me session is in the final ${SLIDING_REFRESH_THRESHOLD_MS}
 *  of its lifetime, extend it by REMEMBER_TTL_MS. Returns a fresh Max-Age for
 *  the route to put in Set-Cookie, or null if no refresh was needed.
 *
 *  BOTH THE TEST AND THE WRITE ARE SQL-SIDE, for two different reasons that
 *  point the same way. The write, because a JS `toISOString()` value does not
 *  compare correctly against `datetime('now')` (see `prepareSessionInsert`) --
 *  sliding a session used to reintroduce the very format the insert had just
 *  been fixed to stop writing. The test, because reading `expires_at` back into
 *  `new Date(...)` is the mirror-image trap: `'YYYY-MM-DD HH:MM:SS'` has no
 *  timezone designator, so JS parses it as LOCAL time, and this code runs under
 *  UTC on Workers but under the developer's zone in tests. One UPDATE whose
 *  WHERE clause carries the threshold avoids both; `changes` reports whether it
 *  fired.
 */
export async function maybeSlideExpiry(
  env: Bindings,
  session: WebSessionRow,
): Promise<{ maxAgeSeconds: number } | null> {
  if (!session.remember) return null;
  const ttlSeconds = Math.floor(REMEMBER_TTL_MS / 1000);
  const thresholdSeconds = Math.floor(SLIDING_REFRESH_THRESHOLD_MS / 1000);
  const result = await env.DB.prepare(
    `UPDATE web_sessions
        SET expires_at = datetime('now', '+' || ? || ' seconds')
      WHERE id = ?
        AND remember = 1
        AND revoked_at IS NULL
        AND expires_at < datetime('now', '+' || ? || ' seconds')`,
  )
    .bind(ttlSeconds, session.id, thresholdSeconds)
    .run();
  if ((result.meta?.changes ?? 0) === 0) return null;
  return { maxAgeSeconds: ttlSeconds };
}
