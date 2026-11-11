/**
 * Contract for the docs admin gate (epic #1336 phase 0, issue #1338).
 *
 * `docs.nemar.org/admin/*` is gated by NEMAR's own admin-only session, not by
 * Cloudflare Access, so `users.role` stays the single source of truth for who
 * is an admin (ADR 0056). It is a ROLE check and nothing in the flow requires
 * an ORCID link: an admin holding a passwordless email-code session passes
 * `verify` identically, so do not describe it as ORCID-backed.
 *
 * Three parties share the literals below and none of them can import each
 * other's code: this backend, the website's authorize page
 * (`nemarOrg/website`), and a Cloudflare Pages Function in `nemarOrg/docs`.
 *
 * THIS FILE IS NOW AN ENFORCED CONTRACT, on the same terms as `account-copy.ts`:
 * a drift test on each side plus a CI sparse checkout pinned to this repo's
 * `dev` branch (the ref pairing of ADR 0046, which exists because pinning `main`
 * deadlocks a coordinated release symmetrically). `nemarOrg/website` compares in
 * `test/docs-auth-contract-drift.test.ts`; `nemarOrg/docs` compares in
 * `test/docs-auth-contract.test.ts`. Both read this file as TEXT rather than
 * importing it, so every value below has to stay a plain literal to be seen: a
 * value built from an expression is reported as absent rather than guessed at,
 * which is why `DOCS_SESSION_TTL_SECONDS` is compared as a computed number.
 *
 * THREE THINGS IN THIS REPOSITORY READ THESE CONSTANTS, and the most important
 * one was missing from this sentence for two revisions: `services/docs-auth.ts`
 * interpolates `DOCS_ADMIN_ROLES` into the WHERE clause of both mint statements,
 * which is the single most load-bearing use of any value in this file. The other
 * two are `routes/auth-docs.ts` and, since phase 3, the CLI's
 * `lib/docs-fetch.ts`, which sets the cookie itself when retrieving a gated page
 * without a browser. All three import this module, so none can drift from it. The website and the docs Pages Function
 * cannot import it, so those two tests are the only thing standing between a
 * value here and the copies they spell. That is not hypothetical: an earlier
 * version named the cookie `nemar_docs_session` while the deployed Pages
 * Function set `__Host-nemar_docs_session`, and nothing noticed. Change a value
 * here and both sides go red until they follow, which is the point.
 *
 * The flow, and which party does what:
 *
 *   1. docs Pages Function  - no docs cookie, so 302 to APP authorize path
 *   2. website (SSR)        - proves an admin session, POST /auth/docs/grant
 *   3. website              - 302 to the docs callback path with the code
 *   4. docs Pages Function  - POST /auth/docs/exchange, set the docs cookie
 *   5. docs Pages Function  - GET /auth/docs/verify on every later request
 *
 * The code is one-time and short-lived because it travels in a URL, where it
 * lands in history, logs and any `Referer` a page later sends. The session
 * value it buys never travels in a URL at all.
 */

/** Cookie the docs host sets for itself, matching what the Pages Function
 *  actually sets (`nemarOrg/docs`, `functions/__docs-auth/callback.ts`).
 *
 *  A DIFFERENT name from the app's session cookie (`__Host-nemar_session`, or
 *  the legacy `nemar_session`) on purpose: two host-scoped cookies with one
 *  name is a debugging trap, and the distinct name makes a
 *  mix-up visible in a request dump rather than silent.
 *
 *  The `__Host-` prefix is the part that is load-bearing rather than cosmetic:
 *  it makes host-only scope BROWSER-ENFORCED. A cookie so named is refused
 *  unless it is `Secure`, `Path=/` and carries no `Domain` attribute, so no
 *  sibling host can plant one and no misconfiguration can widen it to
 *  `.nemar.org` — which is the whole reason this credential is separate from
 *  the app session (ADR 0056). */
export const DOCS_SESSION_COOKIE_NAME = "__Host-nemar_docs_session";

/** Header the docs Pages Function presents the session value in when it calls
 *  `verify`. A header rather than a `Cookie`, because that call is
 *  server-to-server: nothing about it is a browser cookie exchange, and
 *  sending it as one would invite a proxy or log to treat it as session state
 *  belonging to `api.nemar.org`. */
export const DOCS_SESSION_HEADER = "X-Docs-Session";

/** Seconds a one-time grant code stays claimable. Sixty is generous for a
 *  single redirect hop and short enough that a code leaked from a URL is
 *  almost certainly already dead. */
export const DOCS_GRANT_TTL_SECONDS = 60;

/** Seconds a docs session lasts. Roughly a working day, and deliberately not
 *  remember-me: this is an admin-only reading surface, so re-proving identity
 *  tomorrow costs one redirect through a browser that is already signed in. */
export const DOCS_SESSION_TTL_SECONDS = 8 * 60 * 60;

/** Seconds a docs session minted for the CLI lasts.
 *
 *  MUCH SHORTER THAN THE BROWSER'S, on purpose. A browser session is held by
 *  one person at one keyboard and costs a redirect to renew; this one is
 *  handed to a program, and a program's credential reaches places a browser's
 *  does not: a shell history, a CI log, an agent's transcript. Fifteen minutes
 *  is long enough to read a set of pages in one sitting and short enough that a
 *  value recovered from a log later is almost certainly dead. Renewing costs
 *  one authenticated API call, which the CLI makes anyway.
 *
 *  This constant, `DocsCliSessionRefusal` and `DocsCliSessionResponse` below are
 *  the only three things in this file outside the three-party contract: they are
 *  shared
 *  between this repository's backend and its CLI, both of which import this
 *  module directly. The website and the docs Pages Function neither know nor
 *  need them, and the drift tests on those two sides compare only the literals
 *  they spell for themselves, so adding to this section cannot break them. */
export const DOCS_CLI_SESSION_TTL_SECONDS = 15 * 60;

/** Where the docs host sends an unauthenticated visitor. Path only; the app
 *  origin comes from the caller's environment. */
export const DOCS_AUTHORIZE_PATH = "/auth/docs/authorize";

/** Where the website sends the visitor back to, on the docs host, carrying the
 *  one-time code. Under `/__docs-auth/` so it cannot collide with a docs page:
 *  no content route starts with a double underscore. */
export const DOCS_CALLBACK_PATH = "/__docs-auth/callback";

/** The only path prefix on the docs host this gate protects, and the only
 *  prefix a `next` parameter may point at. Declared here so the website's
 *  open-redirect check and the Pages Function's route scope cannot disagree
 *  about what counts as gated. */
export const DOCS_GATED_PATH_PREFIX = "/admin/";

/** Roles that may read the gated docs. Owner is included because an owner can
 *  do everything an admin can; `member` is not, and neither is any other
 *  value, so a new role added later is refused until someone decides. */
export const DOCS_ADMIN_ROLES = ["admin", "owner"] as const;

/** `POST /auth/docs/grant` refusals.
 *  `not_found` for a signed-in non-admin is not a mistake: it mirrors
 *  `adminGate` on the website, which answers 404 rather than 403 so the
 *  existence of the admin surface is not disclosed to someone who may not
 *  know it is there. */
export type DocsGrantRefusal = "unauthenticated" | "not_found";

/** `POST /auth/docs/exchange` refusals. A code that never existed and one
 *  already spent are the SAME answer (`invalid_grant`): distinguishing them
 *  would tell a caller holding a stolen code that it was real. */
export type DocsExchangeRefusal = "invalid_grant" | "not_authorized";

/** `GET /auth/docs/verify` refusals. */
export type DocsVerifyRefusal = "invalid_session" | "not_authorized";

export interface DocsGrantResponse {
  readonly code: string;
  readonly expires_in: number;
}

export interface DocsExchangeResponse {
  /** The docs cookie value. Returned exactly once, in a response body that is
   *  never cached and never logged by the caller. */
  readonly session: string;
  readonly max_age_seconds: number;
  readonly username: string | null;
}

/** `POST /auth/docs/cli-session` refusals. Both spellings already exist
 *  above: an absent or dead API key is `unauthenticated`, and a live key whose
 *  account is not an admin gets `not_found`, the same disguise `grant` gives a
 *  signed-in non-admin. */
export type DocsCliSessionRefusal = "unauthenticated" | "not_found";

/** What `POST /auth/docs/cli-session` returns: the same credential the browser
 *  exchange produces, obtained in one step instead of three because the caller
 *  already holds a long-lived key and there is no cross-host redirect to
 *  protect. The CLI sets it as a `Cookie` header on its own request to
 *  `docs.nemar.org`; the gate reads that header and cannot tell, nor care,
 *  that no browser was involved. */
export interface DocsCliSessionResponse {
  /** The docs session value. Returned exactly once, never cached, and never
   *  written to disk by the CLI. */
  readonly session: string;
  readonly max_age_seconds: number;
  readonly username: string | null;
}

export interface DocsVerifyResponse {
  readonly ok: true;
  readonly username: string | null;
  readonly role: string;
}

export const DOCS_AUTH_MESSAGES: Record<
  DocsGrantRefusal | DocsExchangeRefusal | DocsVerifyRefusal,
  string
> = {
  unauthenticated: "Sign in to nemar.org first, then open the documentation link again.",
  not_found: "Not found.",
  invalid_grant: "That documentation sign-in link is no longer valid. Open the page again.",
  not_authorized: "This account does not have access to the operations documentation.",
  invalid_session: "The documentation session has expired. Open the page again to sign in.",
};
