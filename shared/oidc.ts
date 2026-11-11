/**
 * The OpenID Connect provider's fixed vocabulary (epic #2014 phase #2016; ADR 0119).
 *
 * Pure and import-free. The Worker, the CLI and the tests read this one definition; any other
 * repository that needs it transcribes it (as `shared/contract/account-copy.ts` is transcribed by
 * the website), and nothing outside this repository reads this file today.
 *
 * What is here is what a client can come to depend on, so it moves only by a decision: the scope
 * catalogue (ADR 0119 rule 6), the grants and sign-in rules a client is registered with (rules 1
 * and 7), the token prefixes and lifetimes (rule 4), the identifier formats and the endpoint paths
 * (rule 2). The issuer is deliberately NOT here: it is the Worker's `API_BASE_URL`, and nothing
 * derived from a request (`backend/src/services/oidc-config.ts`).
 */

// ---------------------------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------------------------

/** One scope of the catalogue: its name, whether only a machine may hold it, and its claims. */
export interface OidcScopeDefinition {
  readonly name: string;
  /**
   * True for a scope granted only to a client under the client credentials grant, never by a
   * person's consent (ADR 0119 rules 1 and 6). Such a scope is never on a consent screen.
   */
  readonly machineOnly: boolean;
  /**
   * The claims the scope adds to what a client reads, as ADR 0119 rule 6 names them
   * (`backend/src/services/oidc-claims.ts` serves exactly these). `nemar.account`'s "account kind,
   * status and tier" are `nemar_kind`, `nemar_status` and `nemar_tier` (rule 14). A scope with no
   * claim (`offline_access` is a grant; the compute scopes are read through the API, never from a
   * token) declares none, and discovery advertises none for it.
   */
  readonly claims: readonly string[];
}

/** The scope catalogue, in the order of ADR 0119 rule 6. */
export const OIDC_SCOPES: readonly OidcScopeDefinition[] = [
  { name: "openid", machineOnly: false, claims: ["sub"] },
  { name: "profile", machineOnly: false, claims: ["name", "given_name", "family_name"] },
  { name: "email", machineOnly: false, claims: ["email", "email_verified"] },
  { name: "orcid", machineOnly: false, claims: ["orcid", "orcid_verified"] },
  {
    name: "nemar.account",
    machineOnly: false,
    claims: ["nemar_kind", "nemar_status", "nemar_tier"],
  },
  { name: "offline_access", machineOnly: false, claims: [] },
  { name: "compute.read", machineOnly: false, claims: [] },
  { name: "compute.reserve", machineOnly: false, claims: [] },
  { name: "compute.submit", machineOnly: false, claims: [] },
  { name: "compute.stats", machineOnly: true, claims: [] },
];

/** The names of {@link OIDC_SCOPES}, in the same order. */
export const OIDC_SCOPE_NAMES: readonly string[] = OIDC_SCOPES.map((s) => s.name);

/** True for a string that names a scope of the catalogue, exactly. */
export function isOidcScope(value: unknown): value is string {
  return typeof value === "string" && OIDC_SCOPE_NAMES.includes(value);
}

/** True for a catalogue scope that only a machine may hold (`compute.stats`). */
export function isMachineOnlyScope(name: string): boolean {
  return OIDC_SCOPES.some((s) => s.name === name && s.machineOnly);
}

/**
 * The claims discovery advertises (`claims_supported`): the identity token's own (`auth_time` and
 * `at_hash` included, which the token endpoint signs into every identity token), then each scope's
 * in catalogue order. An advertised list that is shorter than what is served is allowed by the
 * discovery specification; one that names a claim that is never served is not.
 */
export function oidcClaimsSupported(): string[] {
  const own = ["iss", "sub", "aud", "exp", "iat", "nonce", "auth_time", "at_hash"];
  const fromScopes = OIDC_SCOPES.flatMap((s) => s.claims).filter((c) => !own.includes(c));
  return [...own, ...fromScopes];
}

// ---------------------------------------------------------------------------------------------
// What a client is registered with
// ---------------------------------------------------------------------------------------------

/** The grants a client may be allowed (ADR 0119 rules 1 and 3). No implicit, no password grant. */
export const OIDC_GRANTS = ["authorization_code", "refresh_token", "client_credentials"] as const;
export type OidcGrant = (typeof OIDC_GRANTS)[number];

/** True for a string that names a grant of {@link OIDC_GRANTS}, exactly. */
export function isOidcGrant(value: unknown): value is OidcGrant {
  return typeof value === "string" && (OIDC_GRANTS as readonly string[]).includes(value);
}

/** Who may sign in to a client (ADR 0119 rule 7). */
export const OIDC_SIGN_IN_RULES = ["active_account", "person_proven_orcid"] as const;
export type OidcSignInRule = (typeof OIDC_SIGN_IN_RULES)[number];

/** True for a string that names a sign-in rule, exactly. */
export function isOidcSignInRule(value: unknown): value is OidcSignInRule {
  return typeof value === "string" && (OIDC_SIGN_IN_RULES as readonly string[]).includes(value);
}

/**
 * How a client that is not first-party is asked for consent: once per set of scopes (`ask_once`, the
 * default) or on every authorization (`always`). A first-party client skips the screen; no client
 * with a redirect address outside NEMAR's own origins ever does.
 */
export const OIDC_CONSENT_MODES = ["ask_once", "always"] as const;
export type OidcConsentMode = (typeof OIDC_CONSENT_MODES)[number];

/** True for a string that names a consent mode, exactly. */
export function isOidcConsentMode(value: unknown): value is OidcConsentMode {
  return typeof value === "string" && (OIDC_CONSENT_MODES as readonly string[]).includes(value);
}

/** The most redirect addresses a client may register. */
export const OIDC_MAX_REDIRECT_URIS = 10;

/** The longest redirect or back-channel logout address, in characters. */
export const OIDC_URI_MAX_LENGTH = 2000;

/** The longest client name, in characters. */
export const OIDC_CLIENT_NAME_MAX_LENGTH = 100;

/**
 * The most scopes a client may be allowed. The catalogue has ten; the table's CHECK allows this many,
 * so a new scope needs no migration while the catalogue stays within it (a test pins that).
 */
export const OIDC_MAX_ALLOWED_SCOPES = 20;

/** The longest audience identifier, in characters. */
export const OIDC_AUDIENCE_MAX_LENGTH = 200;

/** The most introspection audiences a client may name. */
export const OIDC_MAX_INTROSPECTION_AUDIENCES = 10;

/** How long the previous secret stays valid after a rotation when the owner names no time. */
export const OIDC_SECRET_GRACE_HOURS_DEFAULT = 24;

/** The longest a previous secret may stay valid after a rotation. */
export const OIDC_SECRET_GRACE_HOURS_MAX = 168;

// ---------------------------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------------------------

/** Every client id starts with this. */
export const OIDC_CLIENT_ID_PREFIX = "oc_";

/** Lowercase hexadecimal characters after the prefix (96 random bits). */
export const OIDC_CLIENT_ID_HEX_LENGTH = 24;

const CLIENT_ID_RE = new RegExp(`^${OIDC_CLIENT_ID_PREFIX}[0-9a-f]{${OIDC_CLIENT_ID_HEX_LENGTH}}$`);

/** True for a string of exactly the client id format. */
export function isOidcClientId(value: unknown): value is string {
  return typeof value === "string" && CLIENT_ID_RE.test(value);
}

/**
 * Every client secret starts with this, so a secret scanner can find one. Tokens are opaque and a
 * secret is checked by its hash only, so the prefix is a convention inside the Worker and nothing
 * else depends on it.
 */
export const OIDC_CLIENT_SECRET_PREFIX = "nmo_cs_";

/** Base64url characters after the prefix: 256 random bits, unpadded. */
export const OIDC_CLIENT_SECRET_BODY_LENGTH = 43;

/** Lowercase hexadecimal characters of a signing key id (64 random bits). */
export const OIDC_KID_HEX_LENGTH = 16;

const KID_RE = new RegExp(`^[0-9a-f]{${OIDC_KID_HEX_LENGTH}}$`);

/** True for a string of exactly the key id format. */
export function isOidcKid(value: unknown): value is string {
  return typeof value === "string" && KID_RE.test(value);
}

// ---------------------------------------------------------------------------------------------
// Signing keys
// ---------------------------------------------------------------------------------------------

/** The one signing algorithm: ECDSA over P-256 with SHA-256. */
export const OIDC_SIGNING_ALG = "ES256";

/** A `next` key signs only once it has been published this long, unless the owner forces it. */
export const OIDC_KEY_MIN_NEXT_AGE_HOURS = 24;

/** A retired key stays in the published set this long. */
export const OIDC_RETIRED_KEY_PUBLISH_DAYS = 7;

/** At most this many retired keys are published, the most recently retired first. */
export const OIDC_RETIRED_KEY_PUBLISH_MAX = 5;

/**
 * How long a client may cache discovery and the key set: their `Cache-Control: max-age`. It bounds
 * how long a client can go on using a key set that predates a rotation or a revocation.
 */
export const OIDC_PUBLIC_DOCUMENT_MAX_AGE_SECONDS = 300;

/**
 * `keys rotate --force` refuses while the next key is younger than this many minutes, unless the
 * owner says it is an emergency: a key that has been published for a moment may not be in the key
 * set a client cached, so a token signed with it can fail verification there for about five minutes
 * (the key set's `Cache-Control: max-age`).
 */
export const OIDC_FORCE_MIN_NEXT_AGE_MINUTES = 6;

/**
 * `OIDC_SECRET` encrypts the private keys at rest: shorter than this (the prefix included) and the
 * provider is off.
 */
export const OIDC_SECRET_MIN_LENGTH = 32;

/**
 * THE SECRET FAMILY'S PREFIX (owner decision, 2026-11-07). `OIDC_SECRET` is valid only when it
 * starts with this, so a wrong or placeholder value cannot switch the provider on. Make one with
 * `nmsso-` followed by `openssl rand -hex 32` (70 characters); dev and production hold different
 * values.
 *
 * Any further secret the OpenID Connect handshake ever needs uses the same prefix. It is added as a
 * new constant beside this one and a new pure check beside {@link isOidcSecret} (the prefix, a
 * minimum length and the same body alphabet), never as a second format.
 */
export const OIDC_SECRET_PREFIX = "nmsso-";

/** What may follow the prefix: letters, digits, underscore and hyphen (the shipped values are hex). */
const OIDC_SECRET_BODY_RE = /^[A-Za-z0-9_-]+$/;

/**
 * True only for a string that starts with {@link OIDC_SECRET_PREFIX} in exactly that case, is at
 * least {@link OIDC_SECRET_MIN_LENGTH} characters in all, and whose body is `[A-Za-z0-9_-]`: no
 * space, newline or other character. This is the ONE test of validity; the Worker reads the secret
 * only through `oidcSecret` (`backend/src/services/oidc-config.ts`), which calls it.
 */
export function isOidcSecret(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= OIDC_SECRET_MIN_LENGTH &&
    value.startsWith(OIDC_SECRET_PREFIX) &&
    OIDC_SECRET_BODY_RE.test(value.slice(OIDC_SECRET_PREFIX.length))
  );
}

/**
 * What an operator may be told about `OIDC_SECRET` without hearing the value: `ok`, `unset`
 * (absent or empty) or `malformed` (set, but not in the `nmsso-` form). A fixed word, never a length.
 */
export const OIDC_SECRET_STATES = ["ok", "unset", "malformed"] as const;
export type OidcSecretState = (typeof OIDC_SECRET_STATES)[number];

/** The {@link OidcSecretState} of a binding's value. */
export function oidcSecretState(value: unknown): OidcSecretState {
  if (isOidcSecret(value)) return "ok";
  return value === undefined || value === null || value === "" ? "unset" : "malformed";
}

// ---------------------------------------------------------------------------------------------
// Tokens (ADR 0119 rule 4)
// ---------------------------------------------------------------------------------------------

/** Access tokens are opaque and start with this; API keys start with `nm_`, which does not match. */
export const OIDC_ACCESS_TOKEN_PREFIX = "nmo_at_";

/** Refresh tokens are opaque and start with this. */
export const OIDC_REFRESH_TOKEN_PREFIX = "nmo_rt_";

/** An authorization code is single use and lives this long. */
export const OIDC_AUTHORIZATION_CODE_TTL_SECONDS = 60;

/** An identity token lives 5 minutes. */
export const OIDC_ID_TOKEN_TTL_SECONDS = 5 * 60;

/** An access token lives 15 minutes. */
export const OIDC_ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

/** A refresh token expires after this long without use. */
export const OIDC_REFRESH_TOKEN_IDLE_SECONDS = 30 * 24 * 60 * 60;

/** A refresh token family expires this long after it began, however often it is used. */
export const OIDC_REFRESH_TOKEN_ABSOLUTE_SECONDS = 90 * 24 * 60 * 60;

/** A spent refresh token is still accepted this long, for a request that was retried. */
export const OIDC_REFRESH_GRACE_SECONDS = 30;

/**
 * The `error` words the token endpoint answers (RFC 6749 section 5.2), in the order the RFC lists them.
 * The Worker's `OAuthErrorCode` is derived from this list, so a word cannot be written without being
 * declared here, and the public page's drift test reads this list.
 */
export const OIDC_TOKEN_ERROR_CODES = [
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
] as const;
export type OidcTokenErrorCode = (typeof OIDC_TOKEN_ERROR_CODES)[number];

// ---------------------------------------------------------------------------------------------
// Endpoint paths (ADR 0119 rule 2). The issuer and the host they are served from are the Worker's.
// ---------------------------------------------------------------------------------------------

/** The discovery document, at the issuer's `.well-known` root. */
export const OIDC_DISCOVERY_PATH = "/.well-known/openid-configuration";

/** The signing keys' public set. */
export const OIDC_JWKS_PATH = "/oauth/jwks";

/** The authorization endpoint's path, on the app host (the sign-in cookie lives only there). */
export const OIDC_AUTHORIZE_PATH = "/oauth/authorize";

/** The token endpoint's path, on the issuer. */
export const OIDC_TOKEN_PATH = "/oauth/token";

/** The userinfo endpoint's path, on the issuer. */
export const OIDC_USERINFO_PATH = "/oauth/userinfo";

/** The revocation endpoint's path (RFC 7009), on the issuer. */
export const OIDC_REVOKE_PATH = "/oauth/revoke";

/** The introspection endpoint's path (RFC 7662), on the issuer. */
export const OIDC_INTROSPECT_PATH = "/oauth/introspect";

/**
 * The two documents that live on the issuer host permanently and are exempt from the maintenance
 * mode and from the rate limiter (ADR 0119, Alternatives considered): a client that cannot fetch
 * them during maintenance or a burst cannot validate a token.
 */
export const OIDC_PUBLIC_DOCUMENT_PATHS: readonly string[] = [OIDC_DISCOVERY_PATH, OIDC_JWKS_PATH];

// ---------------------------------------------------------------------------------------------
// Ending an account's grants, and telling the client (ADR 0119 rule 12 and rule 15)
// ---------------------------------------------------------------------------------------------

/**
 * Why a path ended an account's grants: a fixed word, never text a caller wrote. It is the
 * `revoked_reason` of every token the path revoked (`OIDC_TOKEN_REVOKE_REASONS` in the Worker adds
 * these to its own words) and the `reason` of every logout delivery it queued, and migration 0124's
 * CHECK on `oidc_logout_deliveries.reason` lists exactly these.
 *
 *   account_revoked    an administrator revoked the account (`finalizeRevocation`)
 *   account_deleted    the owner soft-deleted it, or the sweep of the live tests' accounts did
 *   account_merged     the owner ended the loser of a manual merge (ADR 0043)
 *   compute_suspended  compute was suspended; only grants that carry a `compute.` scope end. No path
 *                      writes this word yet: the compute access phase of the compute program adds the
 *                      caller, and the filter it needs ({@link OIDC_COMPUTE_SCOPE_PREFIX}) is built
 *   orcid_changed      the ORCID iD was unlinked or replaced; only grants of clients that sign in by
 *                      `person_proven_orcid` end
 *   kind_changed       the account's kind was changed away from `person`; the same grants end
 */
export const OIDC_END_REASONS = [
  "account_revoked",
  "account_deleted",
  "account_merged",
  "compute_suspended",
  "orcid_changed",
  "kind_changed",
] as const;
export type OidcEndReason = (typeof OIDC_END_REASONS)[number];

/** True for a string that names an end reason, exactly. */
export function isOidcEndReason(value: unknown): value is OidcEndReason {
  return typeof value === "string" && (OIDC_END_REASONS as readonly string[]).includes(value);
}

/** The scope prefix that makes a grant a compute grant: a compute suspension ends only these. */
export const OIDC_COMPUTE_SCOPE_PREFIX = "compute.";

/** The two reasons an owner may name for `nemar admin oidc end-account`, and the words they become. */
export const OIDC_ACCOUNT_END_NAMES = ["merged", "revoked"] as const;
export type OidcAccountEndReason = (typeof OIDC_ACCOUNT_END_NAMES)[number];
export const OIDC_ACCOUNT_END_REASONS: Readonly<Record<OidcAccountEndReason, OidcEndReason>> = {
  merged: "account_merged",
  revoked: "account_revoked",
};

/** The states of a logout delivery (`oidc_logout_deliveries.status`). */
export const OIDC_LOGOUT_STATUSES = ["pending", "sent", "failed", "fenced"] as const;
export type OidcLogoutStatus = (typeof OIDC_LOGOUT_STATUSES)[number];

/** True for a string that names a delivery state, exactly. */
export function isOidcLogoutStatus(value: unknown): value is OidcLogoutStatus {
  return typeof value === "string" && (OIDC_LOGOUT_STATUSES as readonly string[]).includes(value);
}

/**
 * What a delivery records of a failed or refused attempt, as a fixed word and never the text of an
 * error or of the partner's answer (`oidc_logout_deliveries.last_error_class`).
 *
 *   timeout          no answer inside {@link OIDC_LOGOUT_TIMEOUT_MS}
 *   network          the connection could not be made, or broke before an answer
 *   redirect         the partner answered with a redirect, which is never followed
 *   http_4xx         the partner refused the token (any 4xx but 408 and 429): not retried
 *   http_5xx         the partner failed (any 5xx): retried
 *   http_throttled   the partner answered 408 or 429: retried on the same schedule, and its `Retry-After`,
 *                    if it sent one, is a LOWER bound for the wait (at most
 *                    {@link OIDC_LOGOUT_RETRY_AFTER_MAX_SECONDS})
 *   http_other       any answer that is neither 200, 204, a redirect, a 4xx nor a 5xx: not retried
 *   sign_failed      NEMAR could not sign the token (no key, a database fault): retried
 *   address_refused  the registered address is not one NEMAR will send to (not https, or in
 *                    production a loopback or an IP literal)
 *   client_disabled  the client was disabled before the token was sent: telling it is not owed
 *   fenced           outside production, an address that is neither loopback nor listed
 *   unreported       the last attempt was claimed and never recorded (the Worker was evicted) and
 *                    none is left to make
 */
export const OIDC_LOGOUT_ERROR_CLASSES = [
  "timeout",
  "network",
  "redirect",
  "http_4xx",
  "http_5xx",
  "http_throttled",
  "http_other",
  "sign_failed",
  "address_refused",
  "client_disabled",
  "fenced",
  "unreported",
] as const;
export type OidcLogoutErrorClass = (typeof OIDC_LOGOUT_ERROR_CLASSES)[number];

/** The event a back-channel logout token carries (OpenID Connect Back-Channel Logout 1.0, 2.4). */
export const OIDC_BACKCHANNEL_LOGOUT_EVENT = "http://schemas.openid.net/event/backchannel-logout";

/** The `typ` header of a logout token (RFC 8725, section 3.11: explicit typing). */
export const OIDC_LOGOUT_TOKEN_TYP = "logout+jwt";

/** A logout token is good for this long: the partner reads it the moment it arrives. */
export const OIDC_LOGOUT_TOKEN_TTL_SECONDS = 120;

/** How long NEMAR waits for the partner's answer, and the redirect it never follows. */
export const OIDC_LOGOUT_TIMEOUT_MS = 5000;

/**
 * The wait before retry n (the first retry is index 0) after a 5xx or a network error: 1 minute,
 * 5 minutes, 30 minutes, 2 hours and 12 hours. A delivery is attempted once and retried at most
 * {@link OIDC_LOGOUT_RETRY_DELAYS_SECONDS}`.length` times, then recorded `failed`. The wait is the
 * EARLIEST time of the next attempt: the retry tick runs every half hour, so a short wait is taken up
 * at the next tick.
 */
export const OIDC_LOGOUT_RETRY_DELAYS_SECONDS: readonly number[] = [60, 300, 1800, 7200, 43200];

/** The most attempts of one delivery: the first and every retry. */
export const OIDC_LOGOUT_MAX_ATTEMPTS = OIDC_LOGOUT_RETRY_DELAYS_SECONDS.length + 1;

/**
 * An attempt is claimed for this long before its answer is recorded, so a second runner (the first
 * attempt after a commit and the retry tick, or two ticks) never sends the same delivery twice at
 * once. An attempt that never records its answer, because the isolate was evicted, is taken up
 * again when this lapses; it was counted when it was claimed, so the retries stay bounded.
 */
export const OIDC_LOGOUT_LEASE_SECONDS = 120;

/**
 * The most a partner's `Retry-After` can postpone the next attempt of a throttled delivery (408 or 429):
 * twelve hours, the longest wait of the schedule. It is a LOWER bound only (the wait is the longer of the
 * schedule's and the partner's, capped here), so a partner can slow a delivery and can never add an attempt.
 */
export const OIDC_LOGOUT_RETRY_AFTER_MAX_SECONDS = 43200;

// ---------------------------------------------------------------------------------------------
// How long a finished delivery is kept
// ---------------------------------------------------------------------------------------------

/**
 * THE OWNER SETS THESE, before the first client registers. They are DEFAULTS pending that decision, not
 * a ruling: a delivery row holds the pseudonymous `sub` of an account, possibly a deleted one (the
 * tombstone keeps the subject), so pruning is also data minimisation, and the windows are the time a
 * finished row stays readable for the owner's own debugging. A row that is NOT finished (`pending`, which
 * includes an attempt in flight) is never pruned, whatever its age.
 *
 * The production retry tick prunes after its delivery work, at most {@link OIDC_LOGOUT_PRUNE_PER_TICK}
 * rows a tick, oldest first: `sent` and `fenced` rows older than the first two windows (by `sent_at` for
 * `sent`, by `created_at` for `fenced`), `failed` rows older than the third (by `created_at`; the table
 * has no last-update column, and a failed row's last attempt comes within three days of its creation:
 * the first attempt, at the next tick if the one after the commit did not run, and five waits of at most
 * {@link OIDC_LOGOUT_RETRY_AFTER_MAX_SECONDS}, each taken up at the next half-hour tick, are 63 hours at
 * the most, which does not matter against the window). A dev or staging Worker has no tick, so its table
 * is not pruned and grows with the number of endings there, which is few.
 */
export const OIDC_LOGOUT_SENT_RETENTION_DAYS = 30;
export const OIDC_LOGOUT_FENCED_RETENTION_DAYS = 30;
export const OIDC_LOGOUT_FAILED_RETENTION_DAYS = 180;

/** The most finished deliveries one tick deletes, so a backlog clears over several ticks. */
export const OIDC_LOGOUT_PRUNE_PER_TICK = 500;
