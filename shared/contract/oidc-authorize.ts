/**
 * The authorization endpoint's wire contract (epic #2014 phase #2017; ADR 0119, rules 2, 3, 7 and 8).
 *
 * The authorization endpoint is the page `https://app.nemar.org/oauth/authorize`, because the
 * sign-in cookie lives only on the app host. That page decides nothing. It forwards the request,
 * and the person's cookie, to two routes of this API, and renders or follows what they answer:
 *
 *   POST /auth/oidc/authorize   check: what should happen to this authorization request
 *   POST /auth/oidc/consent     decide: the person allowed or denied what the check showed them
 *
 * Both are called by the website's server, never by a browser, with the person's `Cookie` header, an
 * `Origin` the website pins to its own, and {@link OIDC_AUTHORIZE_CALLER_HEADER}, which the website's
 * general browser proxy never forwards: an answer can carry a code or a consent token, and only the
 * page's server-side code may read one. Both answer 404, as an unrouted path does, while the
 * provider is off: until `OIDC_SECRET` is set AND `HOST_PREFIXED_SESSION_COOKIE` is `"1"` (only a
 * `__Host-` session may approve a grant, and none exists while the flag is off).
 *
 * Read as TEXT by the website's drift test (`nemarOrg/website`, `test/oidc-authorize-contract-drift.test.ts`),
 * which cannot import this repository's modules: every constant below is one quoted string or one
 * integer, and every closed list is an `as const` array of quoted strings on one declaration, so
 * the text reader sees them. The types after them are for this repository's own code.
 */

/** The check route's path, under the API's `/auth` mount. */
export const OIDC_AUTHORIZE_CHECK_PATH = "/auth/oidc/authorize";

/** The consent route's path, under the API's `/auth` mount. */
export const OIDC_AUTHORIZE_CONSENT_PATH = "/auth/oidc/consent";

/**
 * The request header that marks a call as the authorization page's own, server-side. The website's
 * general proxy for browser calls forwards a fixed list of headers that never includes it, so a
 * call without it did not come from the page's server code and is refused (403). A fixed name and
 * value, not a secret: what it proves is the path the call took.
 */
export const OIDC_AUTHORIZE_CALLER_HEADER = "X-Nemar-Authorize-Caller";

/** The value of {@link OIDC_AUTHORIZE_CALLER_HEADER}. */
export const OIDC_AUTHORIZE_CALLER_VALUE = "authorize-page";

/**
 * The query parameter that stands for "this person was sent to sign in at this moment". When the
 * check answers `login` or `reauth` for a request that asks for a fresh sign-in, it returns the
 * request to come back with: `prompt=login` removed and this parameter set to a marker the API
 * signed, `<unix seconds by D1's clock>.<mac>` (bound to the client and good for
 * {@link OIDC_AUTH_AFTER_TTL_SECONDS}). Back from signing in, a session at least that new counts as
 * the fresh sign-in the request asked for. A marker that is missing, malformed, unsigned, for
 * another client or expired is treated as absent. A NEMAR parameter, not an OpenID Connect one.
 */
export const OIDC_AUTH_AFTER_PARAM = "nemar_auth_after";

/** How long a sign-in marker is honoured after the API signed it, in seconds. */
export const OIDC_AUTH_AFTER_TTL_SECONDS = 600;

/**
 * The longest authorization request the routes read, in characters of its query string. Longer is
 * refused before it is parsed, on an error page: a request that cannot be read cannot be trusted to
 * name a redirect address.
 */
export const OIDC_AUTHORIZE_REQUEST_MAX_LENGTH = 8192;

/** How long a consent token is honoured after the check that issued it, in seconds. */
export const OIDC_CONSENT_TOKEN_TTL_SECONDS = 600;

/** What the page is told to do. Every answer of both routes is exactly one of these. */
export const OIDC_AUTHORIZE_KINDS = [
  "redirect",
  "error_page",
  "login",
  "reauth",
  "rule_refused",
  "consent",
] as const;
export type OidcAuthorizeKind = (typeof OIDC_AUTHORIZE_KINDS)[number];

/**
 * The `error` values a redirect to the client can carry (RFC 6749 section 4.1.2.1, OpenID Connect
 * Core 3.1.2.6). Nothing here is shown on NEMAR's page: the client reads them.
 */
export const OIDC_AUTHORIZE_REDIRECT_ERRORS = [
  "invalid_request",
  "unsupported_response_type",
  "invalid_scope",
  "request_not_supported",
  "request_uri_not_supported",
  "login_required",
  "consent_required",
  "access_denied",
] as const;
export type OidcAuthorizeRedirectError = (typeof OIDC_AUTHORIZE_REDIRECT_ERRORS)[number];

/**
 * Why an error page is shown instead of a redirect. An error page is the answer whenever the
 * request cannot be trusted to name where to send the person: an unknown or disabled client (one
 * answer for both), a redirect address that is not exactly one the client registered, a request
 * that cannot be read, a consent the page cannot prove was shown to this session, or a mint that
 * wrote nothing because something changed under it.
 */
export const OIDC_ERROR_PAGE_CODES = [
  "invalid_client",
  "invalid_redirect_uri",
  "invalid_request",
  "consent_invalid",
  "unavailable",
] as const;
export type OidcErrorPageCode = (typeof OIDC_ERROR_PAGE_CODES)[number];

/** Why an account may not sign in to a client under its sign-in rule (ADR 0119 rule 7). */
export const OIDC_RULE_REFUSAL_REASONS = [
  "account_inactive",
  "account_not_person",
  "orcid_not_proven",
] as const;
export type OidcRuleRefusalReason = (typeof OIDC_RULE_REFUSAL_REASONS)[number];

/** The two answers a person can give on the consent screen. */
export const OIDC_CONSENT_DECISIONS = ["allow", "deny"] as const;
export type OidcConsentDecision = (typeof OIDC_CONSENT_DECISIONS)[number];

/** The body of `POST /auth/oidc/authorize`: the authorization request's query string, as received. */
export interface OidcAuthorizeCheckRequest {
  readonly request: string;
}

/**
 * The body of `POST /auth/oidc/consent`: the same request string the check read, the consent token
 * the check returned, and the person's answer.
 */
export interface OidcAuthorizeConsentRequest {
  readonly request: string;
  readonly consent_token: string;
  readonly decision: OidcConsentDecision;
}

/**
 * What both routes answer, with HTTP 200. A refusal of the call itself is not one of these: a
 * missing {@link OIDC_AUTHORIZE_CALLER_HEADER} or a missing or foreign `Origin` is 403, a body that
 * is not this shape is 400 `invalid_body`, more than thirty calls a minute for one account is 429
 * with the API's usual rate-limit body, and a provider that is off (no `OIDC_SECRET`, or
 * `HOST_PREFIXED_SESSION_COOKIE` not `"1"`) is 404.
 *
 *   - `redirect`: send the person to `location`, which is built from a redirect address the client
 *     registered, exactly, and carries `code` or `error`, `state` when the request had one, and `iss`.
 *   - `error_page`: show the page for `code` and send the person nowhere.
 *   - `login`: no session that may approve a grant; sign in and come back with `request`.
 *   - `reauth`: the client asked for a fresh sign-in; sign in again and come back with `request`
 *     (rewritten as {@link OIDC_AUTH_AFTER_PARAM} says).
 *   - `rule_refused`: this account may not sign in to this client; `location` returns the person to
 *     it with `access_denied`.
 *   - `consent`: ask. The form carries `consent_token` back with the person's answer, and the page
 *     lets the form's redirect reach `redirect_origin` and nothing else.
 */
export type OidcAuthorizeAnswer =
  | { readonly kind: "redirect"; readonly location: string }
  | { readonly kind: "error_page"; readonly code: OidcErrorPageCode }
  | { readonly kind: "login"; readonly request: string }
  | { readonly kind: "reauth"; readonly request: string }
  | {
      readonly kind: "rule_refused";
      readonly reason: OidcRuleRefusalReason;
      readonly client_name: string;
      readonly location: string;
    }
  | {
      readonly kind: "consent";
      readonly client_name: string;
      /** The scopes the client asked for and may have, in the order of the scope catalogue. */
      readonly scopes: readonly string[];
      /** True when a scope lets the client reserve or spend the person's compute time. */
      readonly compute_spend: boolean;
      readonly consent_token: string;
      readonly redirect_origin: string;
    };

/** Two-way type equality, for the compile-time ties below. */
type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Holds<T extends true> = T;

/** The closed list of kinds and the answer union name the same kinds; `tsc` refuses a drift. */
export type OidcAuthorizeKindsMatchAnswers = Holds<
  Exactly<OidcAuthorizeAnswer["kind"], OidcAuthorizeKind>
>;
