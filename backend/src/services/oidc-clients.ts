/**
 * The OpenID Connect client registry (epic #2014 phase #2016; ADR 0119, decision 8): what a client
 * may be registered with, its secret, and what rotating and disabling do.
 *
 * CLIENTS ARE REGISTERED BY THE OWNER AND NO ONE ELSE. Everything here is reached from the owner
 * routes (`routes/admin/oidc.ts`), and every refusal is a fixed word (`code`) plus a sentence that
 * names the field and never echoes what was typed.
 *
 * THE SECRET. `nmo_cs_` (so a secret scanner can find one) plus 256 random bits as unpadded
 * base64url, shown once, in the response that creates or rotates it, and stored only as the SHA-256
 * of the whole string (`hashApiKey`). A secret that is this long and this random needs no slow hash:
 * there is nothing to guess. Verification compares in constant time and honours the previous secret
 * until its grace ends. A disabled client authenticates with neither.
 *
 * FIRST-PARTY (ADR 0119 rule 8): a client is first-party, and so skips the consent screen, only when
 * EVERY redirect address passes {@link isFirstPartyRedirect}: https, `nemar.org` or a subdomain, not a
 * partner host, the default port, and a loopback address or a website preview only outside
 * production. That is its own rule and not the cross-origin one (`isNemarWebOrigin`), which admits
 * loopback and previews everywhere. A client with any other redirect address is third-party: it never
 * skips the consent screen, and follows its `consent_mode` (`ask_once` by default, or `always`).
 * {@link firstPartyRefusal} applies the rule to a registration; the authorization phase asks
 * {@link isFirstPartyRedirect} again at every request, as the ADR requires.
 */

import type { OidcAdminErrorCode } from "../../../shared/contract/oidc-admin.js";
import {
  OIDC_AUDIENCE_MAX_LENGTH,
  OIDC_CLIENT_ID_HEX_LENGTH,
  OIDC_CLIENT_ID_PREFIX,
  OIDC_CLIENT_NAME_MAX_LENGTH,
  OIDC_CLIENT_SECRET_PREFIX,
  OIDC_CONSENT_MODES,
  OIDC_GRANTS,
  OIDC_MAX_INTROSPECTION_AUDIENCES,
  OIDC_MAX_REDIRECT_URIS,
  OIDC_SECRET_GRACE_HOURS_DEFAULT,
  OIDC_SECRET_GRACE_HOURS_MAX,
  OIDC_SIGN_IN_RULES,
  OIDC_URI_MAX_LENGTH,
  type OidcConsentMode,
  type OidcSignInRule,
  isMachineOnlyScope,
  isOidcClientId,
  isOidcConsentMode,
  isOidcGrant,
  isOidcScope,
  isOidcSignInRule,
} from "../../../shared/oidc.js";
import { isPartnerHost } from "../../../shared/partner-hosts.js";
import {
  AUDIT_IF_PREVIOUS_CHANGED_SQL,
  applyEditWithAudit,
  auditLogParams,
  auditLogStatement,
} from "../db/audit-log.js";
import { timingSafeEqual } from "../lib/constant-time.js";
import type { Bindings } from "../types/bindings.js";
import { isWebsitePagesHost } from "./cors-origins.js";
import { isNonProductionEnv } from "./environment.js";
import { oidcClientEndStatements } from "./oidc-cascade.js";
import { randomHex, toBase64Url } from "./oidc-encoding.js";
import { hashApiKey } from "./token.js";

// ---------------------------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------------------------

/** A request to register a client, after the route's shape check (types and bounds). */
export interface ClientInput {
  name: string;
  redirect_uris: string[];
  allowed_scopes: string[];
  allowed_grants: string[];
  sign_in_rule: OidcSignInRule;
  first_party?: boolean;
  consent_mode?: OidcConsentMode;
  backchannel_logout_uri?: string | null;
  audience: string;
  introspection_audiences?: string[];
  cap_open_reservations?: number | null;
  cap_su_per_day?: number | null;
}

/** A refusal of the registry: a fixed word, a sentence, and the field it is about. */
export interface ClientRefusal {
  code: OidcAdminErrorCode;
  message: string;
  field?: string;
}

/** One client as the owner sees it: no secret, no hash. */
export interface ClientView {
  client_id: string;
  name: string;
  redirect_uris: string[];
  allowed_scopes: string[];
  allowed_grants: string[];
  sign_in_rule: string;
  first_party: boolean;
  consent_mode: string;
  backchannel_logout_uri: string | null;
  audience: string;
  introspection_audiences: string[];
  cap_open_reservations: number | null;
  cap_su_per_day: number | null;
  status: string;
  disabled_at: string | null;
  previous_secret_expires_at: string | null;
  created_by: number;
  created_at: string;
  updated_at: string;
}

/** What authentication reads of a client: the status and the two hashes, never returned to a caller. */
export interface ClientAuthRow {
  status: string;
  secret_hash: string;
  previous_secret_hash: string | null;
  previous_secret_expires_at: string | null;
}

// ---------------------------------------------------------------------------------------------
// Identifiers and secrets
// ---------------------------------------------------------------------------------------------

/** `oc_` plus 24 lowercase hexadecimal characters (96 random bits). */
export function generateClientId(): string {
  return `${OIDC_CLIENT_ID_PREFIX}${randomHex(OIDC_CLIENT_ID_HEX_LENGTH / 2)}`;
}

/**
 * `nmo_cs_` plus 256 random bits as 43 unpadded base64url characters. Shown once and stored nowhere;
 * only the hash of the whole string is kept.
 */
export function generateClientSecret(): string {
  return `${OIDC_CLIENT_SECRET_PREFIX}${toBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

/** A SQL timestamp (`YYYY-MM-DD HH:MM:SS`, UTC) as epoch milliseconds; NaN when it is not one. */
function sqlUtcMs(stamp: string): number {
  return Date.parse(`${stamp.replace(" ", "T")}Z`);
}

/**
 * Which of a client's secrets a presented one is, if any: `current`, `previous` (a rotation's
 * grace is still running) or null. Both comparisons are made whatever the first says, in constant
 * time, and a disabled client matches neither. An unparseable expiry is an ended grace: it fails
 * closed.
 */
export async function verifyClientSecret(
  row: ClientAuthRow,
  presented: string,
  now: Date = new Date(),
): Promise<"current" | "previous" | null> {
  if (row.status !== "active") return null;
  const presentedHash = await hashApiKey(presented);
  const currentMatches = timingSafeEqual(presentedHash, row.secret_hash);
  const previousLive =
    row.previous_secret_hash !== null &&
    row.previous_secret_expires_at !== null &&
    sqlUtcMs(row.previous_secret_expires_at) > now.getTime();
  // The same work whether or not there is a previous secret to compare with.
  const previousMatches =
    timingSafeEqual(
      presentedHash,
      previousLive ? (row.previous_secret_hash as string) : row.secret_hash,
    ) && previousLive;
  if (currentMatches) return "current";
  return previousMatches ? "previous" : null;
}

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

const refuse = (code: OidcAdminErrorCode, message: string, field?: string): ClientRefusal => ({
  code,
  message,
  ...(field ? { field } : {}),
});

/** Whitespace, a backslash, an asterisk or a control character: none belongs in an address. */
const FORBIDDEN_IN_ADDRESS = /[\s\\*\p{Cc}]/u;

/** Characters that never belong in a name or an audience. */
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

export function isLoopbackHost(hostname: string): boolean {
  // One dot: a canonical fully qualified name has exactly one, and a first-party loopback address (a
  // developer's machine, outside production) is exactly the name and no stranger spelling.
  const host = hostname.replace(/\.$/, "");
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

/**
 * Every trailing dot, for the REFUSING side. A fully qualified name ends in a dot and names the same host
 * (`localhost.` is `localhost`), and `URL` keeps the dot, so a test of the host that did not fold it would
 * call `https://localhost./x` a named host. Registration of a logout address and the sender's check at send
 * time both read the host through {@link isLocalOrLiteral}, which folds all of them, so a refusal cannot be
 * walked around by writing more dots, and the two cannot disagree.
 */
function withoutTrailingDots(hostname: string): string {
  return hostname.replace(/\.+$/, "");
}

/** A dotted IPv4 address or a bracketed IPv6 one, as `URL` writes a host that is a literal address. */
function isIpLiteral(hostname: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.startsWith("[");
}

/** A host that names the machine itself or no name at all: loopback, `localhost` or any IP literal. */
export function isLocalOrLiteral(hostname: string): boolean {
  const host = withoutTrailingDots(hostname);
  return isLoopbackHost(host) || host.endsWith(".localhost") || isIpLiteral(host);
}

/**
 * Why an address is not acceptable, or null. Exact addresses only: no wildcard, no fragment, no
 * user information. `https` always; `http` only for a loopback host and only outside production
 * (a developer's machine), never for anything else. And canonical: what is stored must equal what a
 * browser navigates to (`new URL(raw).href === raw`), so an address cannot be one thing to this
 * registry and another to the browser that follows it. That one comparison catches a scheme with no
 * slashes, an upper-case scheme or host, a dot segment however it is spelled, an explicit default
 * port, a missing path, an ideographic full stop, an internationalised look-alike, and the invisible
 * and bidirectional format characters, none of which the rules above need to list.
 */
function addressProblem(raw: string, allowLoopbackHttp: boolean): string | null {
  if (raw.length === 0 || raw.length > OIDC_URI_MAX_LENGTH) {
    return `is empty or longer than ${OIDC_URI_MAX_LENGTH} characters`;
  }
  if (FORBIDDEN_IN_ADDRESS.test(raw)) {
    return "contains whitespace, a backslash, a wildcard or a control character";
  }
  if (raw.includes("#")) return "has a fragment";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "is not an absolute address";
  }
  if (url.username !== "" || url.password !== "") return "carries user information";
  if (url.hostname === "") return "has no host";
  if (url.href !== raw) {
    return "is not in canonical form (write it as a browser would navigate to it: lower-case, a path, no dot segments, no default port)";
  }
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:") {
    return allowLoopbackHttp && isLoopbackHost(url.hostname)
      ? null
      : "uses plain http (only a loopback address, and not in production, may)";
  }
  return "is not an https address";
}

/** The parameters the authorization response appends to a redirect address (RFC 6749, RFC 9207). */
const RESPONSE_PARAMETERS = ["code", "state", "iss", "error"];

/**
 * Why a redirect address's own query is not acceptable, or null: it must not already name a
 * parameter the authorization response appends, or the client would receive two values for it.
 * Asked of an address `addressProblem` accepted, so it parses.
 */
function responseParameterProblem(uri: string): string | null {
  const query = new URL(uri).searchParams;
  const named = RESPONSE_PARAMETERS.find((name) => query.has(name));
  return named
    ? `already names ${named} in its query, which the authorization response adds`
    : null;
}

/**
 * Whether ONE redirect address is a first-party origin (ADR 0119 rule 8). Its own rule, not the
 * cross-origin one: https only (a loopback address outside production may also be http), the host is
 * `nemar.org` or a subdomain of it and not a partner host, the default port only, no user
 * information. Outside production a loopback address (any port) and a website preview (a Pages project
 * NEMAR deploys) count as well, so staging and local runs work; in production they never do, because
 * a client whose redirect is a developer's machine, or a preview any collaborator can deploy, must
 * not skip consent. An unset or unknown `ENVIRONMENT` is production.
 *
 * Exported for the authorization phase, which asks it again at every request.
 */
export function isFirstPartyRedirect(uri: string, env: Pick<Bindings, "ENVIRONMENT">): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.username !== "" || url.password !== "") return false;
  const host = url.hostname;
  if (isPartnerHost(host)) return false;
  const outsideProduction = isNonProductionEnv(env);
  if (isLoopbackHost(host)) {
    return outsideProduction && (url.protocol === "http:" || url.protocol === "https:");
  }
  if (url.protocol !== "https:" || url.port !== "") return false;
  if (isWebsitePagesHost(host)) return outsideProduction;
  return host === "nemar.org" || host.endsWith(".nemar.org");
}

const THIRD_PARTY =
  "Register the client without first_party and it is a third-party client: it never skips the consent screen, and follows its consent_mode.";

/**
 * Whether a client may be first-party: every redirect address passes {@link isFirstPartyRedirect}.
 * Returns the refusal, or null when it may. A partner host is named as such, because that is the case
 * the rule exists for; any other address is the same refusal in other words.
 */
export function firstPartyRefusal(
  redirectUris: readonly string[],
  env: Pick<Bindings, "ENVIRONMENT">,
): ClientRefusal | null {
  for (const uri of redirectUris) {
    let host = "";
    try {
      host = new URL(uri).hostname;
    } catch {}
    if (host !== "" && isPartnerHost(host)) {
      return refuse(
        "first_party_not_allowed",
        `first_party is refused: a redirect address on a partner host cannot be first-party, because a partner must never skip the consent screen. ${THIRD_PARTY}`,
        "first_party",
      );
    }
    if (!isFirstPartyRedirect(uri, env)) {
      return refuse(
        "first_party_not_allowed",
        `first_party is refused: every redirect address must be an https address on nemar.org or one of its subdomains, on the default port (a loopback address or a website preview only outside production). ${THIRD_PARTY}`,
        "first_party",
      );
    }
  }
  return null;
}

function checkAudience(value: string, field: string): ClientRefusal | null {
  if (
    value.length === 0 ||
    value.length > OIDC_AUDIENCE_MAX_LENGTH ||
    /\s/.test(value) ||
    CONTROL_OR_FORMAT.test(value)
  ) {
    return refuse(
      "invalid_audience",
      `${field} must be 1 to ${OIDC_AUDIENCE_MAX_LENGTH} characters with no whitespace or control character.`,
      field,
    );
  }
  return null;
}

/**
 * The registry's rules, in the order an owner meets them. Null when the input may be registered.
 * `env` is read for one thing: whether a loopback address may use plain http.
 */
export function validateClientInput(
  input: ClientInput,
  env: Pick<Bindings, "ENVIRONMENT">,
): ClientRefusal | null {
  const name = input.name.trim();
  if (
    name.length === 0 ||
    name.length > OIDC_CLIENT_NAME_MAX_LENGTH ||
    CONTROL_OR_FORMAT.test(name)
  ) {
    return refuse(
      "invalid_name",
      `name must be 1 to ${OIDC_CLIENT_NAME_MAX_LENGTH} printable characters.`,
      "name",
    );
  }

  if (!isOidcSignInRule(input.sign_in_rule)) {
    return refuse(
      "invalid_body",
      `sign_in_rule must be one of: ${OIDC_SIGN_IN_RULES.join(", ")}.`,
      "sign_in_rule",
    );
  }
  if (input.consent_mode !== undefined && !isOidcConsentMode(input.consent_mode)) {
    return refuse(
      "invalid_body",
      `consent_mode must be one of: ${OIDC_CONSENT_MODES.join(", ")}.`,
      "consent_mode",
    );
  }

  const allowLoopbackHttp = isNonProductionEnv(env);
  if (input.redirect_uris.length === 0 || input.redirect_uris.length > OIDC_MAX_REDIRECT_URIS) {
    return refuse(
      "invalid_body",
      `redirect_uris must hold 1 to ${OIDC_MAX_REDIRECT_URIS} addresses.`,
      "redirect_uris",
    );
  }
  const seenUris = new Set<string>();
  for (const [i, uri] of input.redirect_uris.entries()) {
    const problem = addressProblem(uri, allowLoopbackHttp) ?? responseParameterProblem(uri);
    if (problem) {
      return refuse("invalid_redirect_uri", `redirect_uris[${i}] ${problem}.`, "redirect_uris");
    }
    if (seenUris.has(uri)) {
      return refuse(
        "duplicate_redirect_uri",
        `redirect_uris[${i}] is listed twice.`,
        "redirect_uris",
      );
    }
    seenUris.add(uri);
  }

  const seenScopes = new Set<string>();
  for (const scope of input.allowed_scopes) {
    if (!isOidcScope(scope)) {
      return refuse(
        "invalid_scope",
        "allowed_scopes names a scope that is not in the catalogue.",
        "allowed_scopes",
      );
    }
    if (seenScopes.has(scope)) {
      return refuse("invalid_scope", `allowed_scopes lists ${scope} twice.`, "allowed_scopes");
    }
    seenScopes.add(scope);
  }

  const seenGrants = new Set<string>();
  for (const grant of input.allowed_grants) {
    if (!isOidcGrant(grant)) {
      return refuse(
        "invalid_grant",
        `allowed_grants may hold only: ${OIDC_GRANTS.join(", ")}.`,
        "allowed_grants",
      );
    }
    if (seenGrants.has(grant)) {
      return refuse("invalid_grant", `allowed_grants lists ${grant} twice.`, "allowed_grants");
    }
    seenGrants.add(grant);
  }

  // A machine-only scope is granted only under the client credentials grant, so a client that
  // cannot use that grant can never hold it.
  for (const scope of seenScopes) {
    if (isMachineOnlyScope(scope) && !seenGrants.has("client_credentials")) {
      return refuse(
        "scope_grant_mismatch",
        `${scope} is a machine scope and needs the client_credentials grant.`,
        "allowed_scopes",
      );
    }
  }

  // What a person's consent covers is consistent with how a client may get it (ADR 0119 rule 1):
  // a scope that is not machine-only is granted by a person at the authorization endpoint, so it
  // needs the authorization code grant; a refresh token comes only from that flow; and the
  // offline_access scope and the refresh_token grant come together.
  if (!seenGrants.has("authorization_code")) {
    // First, so that its own message is the one given when the grant list is what is wrong.
    if (seenGrants.has("refresh_token")) {
      return refuse(
        "invalid_body",
        "allowed_grants has refresh_token, which needs the authorization_code grant: a refresh token comes from a person's authorization.",
        "allowed_grants",
      );
    }
    for (const scope of seenScopes) {
      if (!isMachineOnlyScope(scope)) {
        return refuse(
          "invalid_body",
          `allowed_scopes names ${scope}, which a person grants and so needs the authorization_code grant: a client with only the client_credentials grant may hold only machine scopes.`,
          "allowed_scopes",
        );
      }
    }
  }
  if (seenScopes.has("offline_access") && !seenGrants.has("refresh_token")) {
    return refuse(
      "invalid_body",
      "allowed_scopes has offline_access, which needs the refresh_token grant.",
      "allowed_scopes",
    );
  }
  if (seenGrants.has("refresh_token") && !seenScopes.has("offline_access")) {
    return refuse(
      "invalid_body",
      "allowed_grants has refresh_token, which needs the offline_access scope.",
      "allowed_grants",
    );
  }

  if (input.backchannel_logout_uri !== undefined && input.backchannel_logout_uri !== null) {
    const uri = input.backchannel_logout_uri;
    // `addressProblem(uri, false)` below already refuses http, because no logout address may be a
    // loopback one over http. This test stays first, and says so in words of its own, because it is the
    // rule the table's CHECK enforces (https only): were `addressProblem` ever loosened, an http
    // address would otherwise reach the table and fail there as a 500 instead of a typed refusal.
    if (!uri.startsWith("https://")) {
      return refuse(
        "invalid_logout_uri",
        "backchannel_logout_uri must be an https address.",
        "backchannel_logout_uri",
      );
    }
    const problem = addressProblem(uri, false);
    if (problem) {
      return refuse(
        "invalid_logout_uri",
        `backchannel_logout_uri ${problem}.`,
        "backchannel_logout_uri",
      );
    }
    // In production NEMAR's server calls this address with a signed token, so it must be a named host:
    // not the machine itself, and not an IP literal that would aim the call at an internal address.
    if (!allowLoopbackHttp && isLocalOrLiteral(new URL(uri).hostname)) {
      return refuse(
        "invalid_logout_uri",
        "backchannel_logout_uri must name a host in production, not a loopback or IP address.",
        "backchannel_logout_uri",
      );
    }
  }

  const audience = checkAudience(input.audience, "audience");
  if (audience) return audience;
  const introspection = input.introspection_audiences ?? [];
  if (introspection.length > OIDC_MAX_INTROSPECTION_AUDIENCES) {
    return refuse(
      "invalid_body",
      `introspection_audiences may hold at most ${OIDC_MAX_INTROSPECTION_AUDIENCES}.`,
      "introspection_audiences",
    );
  }
  for (const value of introspection) {
    const problem = checkAudience(value, "introspection_audiences");
    if (problem) return problem;
  }

  if (input.first_party === true) return firstPartyRefusal(input.redirect_uris, env);
  return null;
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

/**
 * The owner's view of a client. Never the hashes: the previous secret's expiry is read only while
 * its grace is still running (D1's clock), and NULL once it has ended.
 */
const VIEW_COLUMNS = `client_id, name, redirect_uris, allowed_scopes, allowed_grants, sign_in_rule,
  first_party, consent_mode, backchannel_logout_uri, audience, introspection_audiences,
  cap_open_reservations, cap_su_per_day, status, disabled_at,
  CASE WHEN previous_secret_hash IS NOT NULL AND previous_secret_expires_at > datetime('now')
       THEN previous_secret_expires_at END AS previous_secret_expires_at,
  created_by, created_at, updated_at`;

export const LIST_CLIENTS_SQL = `SELECT ${VIEW_COLUMNS} FROM oidc_clients ORDER BY id LIMIT 500`;
export const GET_CLIENT_SQL = `SELECT ${VIEW_COLUMNS} FROM oidc_clients WHERE client_id = ?`;
export const CLIENT_AUTH_SQL = `SELECT status, secret_hash, previous_secret_hash, previous_secret_expires_at
  FROM oidc_clients WHERE client_id = ?`;

interface StoredView
  extends Omit<
    ClientView,
    | "redirect_uris"
    | "allowed_scopes"
    | "allowed_grants"
    | "introspection_audiences"
    | "first_party"
  > {
  redirect_uris: string;
  allowed_scopes: string;
  allowed_grants: string;
  introspection_audiences: string;
  first_party: number;
}

function toView(row: StoredView): ClientView {
  return {
    ...row,
    redirect_uris: JSON.parse(row.redirect_uris) as string[],
    allowed_scopes: JSON.parse(row.allowed_scopes) as string[],
    allowed_grants: JSON.parse(row.allowed_grants) as string[],
    introspection_audiences: JSON.parse(row.introspection_audiences) as string[],
    first_party: row.first_party === 1,
  };
}

export async function listClients(db: D1Database): Promise<ClientView[]> {
  const { results } = await db.prepare(LIST_CLIENTS_SQL).all<StoredView>();
  return (results ?? []).map(toView);
}

export async function getClient(db: D1Database, clientId: string): Promise<ClientView | null> {
  const row = await db.prepare(GET_CLIENT_SQL).bind(clientId).first<StoredView>();
  return row ? toView(row) : null;
}

/** The status and hashes authentication reads. Never put this in a response. */
export async function getClientAuthRow(
  db: D1Database,
  clientId: string,
): Promise<ClientAuthRow | null> {
  return db.prepare(CLIENT_AUTH_SQL).bind(clientId).first<ClientAuthRow>();
}

// ---------------------------------------------------------------------------------------------
// Authenticating a client at the token, revocation and introspection endpoints (#2018)
// ---------------------------------------------------------------------------------------------

/** What those endpoints know of a client that authenticated. Never a hash. */
export interface AuthenticatedClient {
  /** The ROW id, `oidc_clients.id`: what grants, codes and tokens store as `client_id`. */
  id: number;
  /** The PUBLIC client id, `oc_...`. */
  clientId: string;
  allowedGrants: string[];
  allowedScopes: string[];
  audience: string;
  introspectionAudiences: string[];
  /** As registered; whether it still qualifies is {@link isFirstPartyRedirect}'s to say. */
  firstParty: boolean;
  redirectUris: string[];
}

/** The row authentication reads: the status, the two hashes, and what the endpoints need after. */
export const CLIENT_TOKEN_AUTH_SQL = `SELECT id, client_id, status, secret_hash, previous_secret_hash,
    previous_secret_expires_at, allowed_grants, allowed_scopes, audience, introspection_audiences,
    first_party, redirect_uris
  FROM oidc_clients WHERE client_id = ?`;

interface ClientTokenAuthRow extends ClientAuthRow {
  id: number;
  client_id: string;
  allowed_grants: string;
  allowed_scopes: string;
  audience: string;
  introspection_audiences: string;
  first_party: number;
  redirect_uris: string;
}

/**
 * Body parameters that carry a client credential. A client authenticates with HTTP Basic and
 * nothing else (ADR 0119 rule 1): a secret in the body is refused even beside a valid header, so a
 * client cannot come to depend on a second method by accident, and `private_key_jwt` is not decided.
 */
const BODY_CREDENTIALS = ["client_secret", "client_assertion", "client_assertion_type"] as const;

/** `application/x-www-form-urlencoded` decoding of one value: `+` is a space, then percent-decoding. */
function formDecode(value: string): string | null {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return null;
  }
}

/**
 * The client id and secret of an `Authorization: Basic` header, each form-decoded as RFC 6749
 * section 2.3.1 requires (the client form-encodes both before it joins them with a colon), or null
 * for a header that is absent, of another scheme, not base64, not UTF-8, without a colon, or with an
 * empty half. The scheme name is matched without regard to case (RFC 7235).
 */
export function readBasicCredentials(
  header: string | undefined,
): { id: string; secret: string } | null {
  if (!header) return null;
  const match = /^basic ([A-Za-z0-9+/]+={0,2})$/i.exec(header.trim());
  if (!match) return null;
  let decoded: string;
  try {
    const binary = atob(match[1] as string);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
  const colon = decoded.indexOf(":");
  if (colon < 0) return null;
  const id = formDecode(decoded.slice(0, colon));
  const secret = formDecode(decoded.slice(colon + 1));
  if (id === null || secret === null || id === "" || secret === "") return null;
  return { id, secret };
}

/**
 * The client a token, revocation or introspection request authenticates as, or null: no Basic
 * header, a credential in the body, a `client_id` in the body that is not the header's, an unknown
 * client, a disabled one, or a secret that is neither the current one nor the previous one inside
 * its grace ({@link verifyClientSecret}: compared as hashes, in constant time). Every null is the
 * same answer to the caller (`invalid_client`).
 */
export async function authenticateClient(
  db: D1Database,
  authorization: string | undefined,
  form: URLSearchParams,
): Promise<AuthenticatedClient | null> {
  if (BODY_CREDENTIALS.some((name) => form.has(name))) return null;
  const pair = readBasicCredentials(authorization);
  if (!pair || !isOidcClientId(pair.id)) return null;
  // RFC 6749 section 3.2.1 lets a client name itself in the body as well; it must be the same one.
  const named = form.getAll("client_id").filter((v) => v !== "");
  if (named.length > 1 || (named.length === 1 && named[0] !== pair.id)) return null;
  const row = await db.prepare(CLIENT_TOKEN_AUTH_SQL).bind(pair.id).first<ClientTokenAuthRow>();
  if (!row) return null;
  if ((await verifyClientSecret(row, pair.secret)) === null) return null;
  return {
    id: row.id,
    clientId: row.client_id,
    allowedGrants: JSON.parse(row.allowed_grants) as string[],
    allowedScopes: JSON.parse(row.allowed_scopes) as string[],
    audience: row.audience,
    introspectionAudiences: JSON.parse(row.introspection_audiences) as string[],
    firstParty: row.first_party === 1,
    redirectUris: JSON.parse(row.redirect_uris) as string[],
  };
}

/** Whether a registered first-party client still qualifies: every redirect address passes now. */
export function stillFirstParty(
  client: Pick<AuthenticatedClient, "firstParty" | "redirectUris">,
  env: Pick<Bindings, "ENVIRONMENT">,
): boolean {
  return client.firstParty && client.redirectUris.every((uri) => isFirstPartyRedirect(uri, env));
}

// ---------------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------------

/** Is an active client already called this (ignoring case)? */
export const NAME_TAKEN_SQL =
  "SELECT 1 AS taken FROM oidc_clients WHERE name = ? COLLATE NOCASE AND status = 'active'";

/** The active-name index refusing a second client of one name, as SQLite and D1 word it. */
const NAME_INDEX_RE =
  /UNIQUE constraint failed: (oidc_clients\.name|index 'oidc_clients_active_name')/;

const nameTaken = (): ClientRefusal =>
  refuse(
    "client_name_taken",
    "An active client already has that name. If this registration was retried after a network error, run `nemar admin oidc clients list` first: the earlier request may have registered the client, and its secret was shown only to that request.",
    "name",
  );

export const INSERT_CLIENT_SQL = `INSERT INTO oidc_clients
  (client_id, name, secret_hash, redirect_uris, allowed_scopes, allowed_grants, sign_in_rule,
   first_party, consent_mode, backchannel_logout_uri, audience, introspection_audiences,
   cap_open_reservations, cap_su_per_day, created_by)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/**
 * Register a client: validate, make its id and secret, write the row and its audit row in one
 * batch. The secret is returned here and kept nowhere. The audit row holds the shape of the
 * registration (flags, grants, scopes, counts) and none of its content: no name, no address, no
 * audience, no secret.
 */
export async function createClient(
  env: Pick<Bindings, "DB" | "ENVIRONMENT">,
  input: ClientInput,
  actorId: number,
): Promise<
  { ok: true; client: ClientView; secret: string } | { ok: false; refusal: ClientRefusal }
> {
  const refusal = validateClientInput(input, env);
  if (refusal) return { ok: false, refusal };

  const db = env.DB;
  const name = input.name.trim();
  if (await db.prepare(NAME_TAKEN_SQL).bind(name).first()) {
    return { ok: false, refusal: nameTaken() };
  }

  const clientId = generateClientId();
  const secret = generateClientSecret();
  const firstParty = input.first_party === true;
  const consentMode = input.consent_mode ?? "ask_once";
  const statements = [
    db
      .prepare(INSERT_CLIENT_SQL)
      .bind(
        clientId,
        name,
        await hashApiKey(secret),
        JSON.stringify(input.redirect_uris),
        JSON.stringify(input.allowed_scopes),
        JSON.stringify(input.allowed_grants),
        input.sign_in_rule,
        firstParty ? 1 : 0,
        consentMode,
        input.backchannel_logout_uri ?? null,
        input.audience,
        JSON.stringify(input.introspection_audiences ?? []),
        input.cap_open_reservations ?? null,
        input.cap_su_per_day ?? null,
        actorId,
      ),
    auditLogStatement(db, {
      userId: actorId,
      action: "oidc.client.create",
      resourceType: "oidc_client",
      resourceId: clientId,
      details: JSON.stringify({
        first_party: firstParty,
        sign_in_rule: input.sign_in_rule,
        consent_mode: consentMode,
        grants: input.allowed_grants,
        scopes: input.allowed_scopes,
        redirects: input.redirect_uris.length,
        logout: input.backchannel_logout_uri != null,
      }),
    }),
  ];
  try {
    await db.batch(statements);
  } catch (err) {
    // A registration that overlapped another of the same name: the index decided, so it is the same
    // answer as the check above. Anything else is a defect and is thrown.
    if (NAME_INDEX_RE.test(err instanceof Error ? err.message : String(err))) {
      return { ok: false, refusal: nameTaken() };
    }
    throw err;
  }
  const client = await getClient(db, clientId);
  if (!client) throw new Error("the client was written and could not be read back");
  return { ok: true, client, secret };
}

/**
 * Replace the secret. The old one stays valid for `graceHours` (0 for none, at most a week) so a
 * client that has not yet been given the new one keeps working; a second rotation inside the grace
 * ends the first secret at once and keeps the one before it. A disabled client's secret cannot be
 * rotated: the update names `status = 'active'`, so there is no read-then-write for a disable to
 * slip between.
 */
export const ROTATE_SECRET_SQL = `UPDATE oidc_clients
  SET previous_secret_hash = CASE WHEN ? > 0 THEN secret_hash END,
      previous_secret_expires_at = CASE WHEN ? > 0 THEN datetime('now', ?) END,
      secret_hash = ?,
      updated_at = datetime('now')
  WHERE client_id = ? AND status = 'active'`;

export async function rotateClientSecret(
  env: Pick<Bindings, "DB">,
  clientId: string,
  graceHours: number | undefined,
  actorId: number,
): Promise<
  | { ok: true; client: ClientView; secret: string; graceHours: number }
  | { ok: false; code: "client_not_found" | "client_disabled" }
> {
  const grace = graceHours ?? OIDC_SECRET_GRACE_HOURS_DEFAULT;
  if (!Number.isInteger(grace) || grace < 0 || grace > OIDC_SECRET_GRACE_HOURS_MAX) {
    throw new RangeError("graceHours is out of range; the route validates it first");
  }
  const db = env.DB;
  const secret = generateClientSecret();
  const changed = await applyEditWithAudit(
    db,
    db
      .prepare(ROTATE_SECRET_SQL)
      .bind(grace, grace, `+${grace} hours`, await hashApiKey(secret), clientId),
    {
      userId: actorId,
      action: "oidc.client.rotate_secret",
      resourceType: "oidc_client",
      resourceId: clientId,
      details: JSON.stringify({ grace_hours: grace }),
    },
  );
  const client = await getClient(db, clientId);
  // The update names `status = 'active'`, so one statement decides; what it did not change is
  // told apart afterwards: no such client, or one that is disabled.
  if (!changed) return { ok: false, code: client ? "client_disabled" : "client_not_found" };
  if (!client) return { ok: false, code: "client_not_found" };
  return { ok: true, client, secret, graceHours: grace };
}

export const DISABLE_CLIENT_SQL = `UPDATE oidc_clients
  SET status = 'disabled', disabled_at = datetime('now'), updated_at = datetime('now')
  WHERE client_id = ? AND status = 'active'`;

/** What disabling a client revoked, as the rows the batch changed: the owner is told these. */
export interface DisabledHoldings {
  tokens: number;
  grants: number;
  codes: number;
}

/**
 * Cut a client off, in ONE batch: the status and the time, then everything the client holds. Every
 * token it was issued (an account's, and the client's own), every grant any account made to it and
 * every unused code are revoked or deleted, so the client has nothing left to use and a person's
 * consent to it is gone (ADR 0119 rule 12). It queues NO logout: the owner cut the client off and
 * telling it is not owed (`oidcClientEndStatements`).
 *
 * The three statements are NOT conditional on this request having changed the status, and that is on
 * purpose: they are keyed by the client and idempotent, so disabling a client that is already
 * disabled revokes whatever it may still hold (a client disabled before the revocation existed
 * included) and a second run reports what it found. The audit row is written only when the status
 * changed (`AUDIT_IF_PREVIOUS_CHANGED_SQL` reads the statement just before it, so it directly follows
 * the update); it holds the shape of the act, never a name or an address.
 */
export async function disableClient(
  env: Pick<Bindings, "DB">,
  clientId: string,
  actorId: number,
): Promise<
  | { ok: true; client: ClientView; changed: boolean; revoked: DisabledHoldings }
  | { ok: false; code: "client_not_found" }
> {
  const db = env.DB;
  const ending = oidcClientEndStatements(clientId);
  const results = await db.batch([
    db.prepare(DISABLE_CLIENT_SQL).bind(clientId),
    db.prepare(AUDIT_IF_PREVIOUS_CHANGED_SQL).bind(
      ...auditLogParams({
        userId: actorId,
        action: "oidc.client.disable",
        resourceType: "oidc_client",
        resourceId: clientId,
        details: null,
      }),
    ),
    ...ending.map((s) => db.prepare(s.sql).bind(...s.binds)),
  ]);
  const changed = (results[0]?.meta?.changes ?? 0) > 0;
  const client = await getClient(db, clientId);
  if (!client) return { ok: false, code: "client_not_found" };
  return {
    ok: true,
    client,
    changed,
    revoked: {
      tokens: results[2]?.meta?.changes ?? 0,
      grants: results[3]?.meta?.changes ?? 0,
      codes: results[4]?.meta?.changes ?? 0,
    },
  };
}
