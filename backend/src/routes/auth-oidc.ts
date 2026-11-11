/**
 * The OpenID Connect authorization endpoint's two routes (epic #2014 phase #2017; ADR 0119), mounted
 * under the same `/auth` prefix as the other auth families:
 *
 *   POST /auth/oidc/authorize   check: what should happen to this authorization request
 *   POST /auth/oidc/consent     decide: the person's answer on the consent screen
 *
 * Both are reached only by the website's page at `app.nemar.org/oauth/authorize`, server-side,
 * forwarding the person's `Cookie` header with an `Origin` pinned to its own. Every decision is in
 * `services/oidc-authorize.ts`; the shapes are `shared/contract/oidc-authorize.ts`.
 *
 * THE ORDER OF THE GUARDS, which a route cannot reorder (`test/oidc-authorize-inventory.test.ts`
 * walks the router's table):
 *
 *   1. {@link oidcAuthorizeSurface}: 404, as an unrouted path does, unless the provider is on
 *      (`OIDC_SECRET`), the request is on the issuer's host with no `/nemar` prefix
 *      (`onOidcSurface`), and sessions are issued under the `__Host-` cookie name
 *      (`HOST_PREFIXED_SESSION_COOKIE`). Only a `__Host-` session may approve a grant (ADR 0119
 *      rule 10); with the flag off none exists, and a person sent to sign in would come back to the
 *      same answer for ever.
 *   2. {@link callerGuard}: 403 unless the call carries `OIDC_AUTHORIZE_CALLER_HEADER`, which the
 *      authorization page's server-side client sets and the website's general browser proxy never
 *      forwards. An answer can carry a code or a consent token, and only the page's server code may
 *      read one.
 *   3. {@link originGuard}: 403 for a missing or foreign `Origin`, before the session is read, as
 *      every other cookie-authenticated write here does. A partner host is foreign (ADR 0119 rule 9).
 *   4. `webSessionMiddleware`, then the handler: a session read under the LEGACY cookie name is no
 *      session at all here, because a sibling host can set that cookie for the parent domain; then
 *      the per-account budget (thirty a minute, both routes together); then the body.
 *
 * Every answer is `no-store`: it carries a code, a consent token, or a refusal about one.
 */

import { Hono, type MiddlewareHandler } from "hono";
import {
  OIDC_AUTHORIZE_CALLER_HEADER,
  OIDC_AUTHORIZE_CALLER_VALUE,
  OIDC_AUTHORIZE_CHECK_PATH,
  OIDC_AUTHORIZE_CONSENT_PATH,
  OIDC_CONSENT_DECISIONS,
  type OidcConsentDecision,
} from "../../../shared/contract/oidc-authorize.js";
import { notFoundResponse } from "../lib/not-found";
import { checkOidcAuthorizeBudget } from "../middleware/rateLimit";
import { webSessionMiddleware } from "../middleware/webSession";
import { checkAuthorization, decideConsent } from "../services/oidc-authorize";
import { onOidcSurface } from "../services/oidc-config";
import {
  SESSION_COOKIE_NAME,
  hostPrefixedSessionCookie,
  isAllowedOrigin,
} from "../services/web-session";
import type { Bindings, Variables } from "../types/bindings";

type Env = { Bindings: Bindings; Variables: Variables };
type Ctx = Parameters<MiddlewareHandler<Env>>[0];

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** The mount this router sits under in `index.ts`. */
const MOUNT = "/auth";

/** A contract path as this router spells it, under {@link MOUNT}. */
function routed(path: string): string {
  if (!path.startsWith(`${MOUNT}/`)) throw new Error(`${path} is not under ${MOUNT}`);
  return path.slice(MOUNT.length);
}

/**
 * 404, exactly as a route that does not exist, unless the request is on the OpenID Connect surface
 * and the session cookie is issued under the `__Host-` name. See the module comment.
 */
export const oidcAuthorizeSurface: MiddlewareHandler<Env> = async (c, next) => {
  if (!onOidcSurface(c.env, c.req.url, c.req.path) || !hostPrefixedSessionCookie(c.env)) {
    return notFoundResponse(c);
  }
  await next();
};

/**
 * 403 unless the call is the authorization page's own (see the module comment). Fixed name and value,
 * no secret: the website's browser proxy forwards a fixed list of headers that never includes it.
 */
export const callerGuard: MiddlewareHandler<Env> = async (c, next) => {
  if (c.req.header(OIDC_AUTHORIZE_CALLER_HEADER) !== OIDC_AUTHORIZE_CALLER_VALUE) {
    return c.json({ error: "Caller not allowed" }, 403, NO_STORE);
  }
  await next();
};

/**
 * 403 for a missing or foreign `Origin`, before anything reads the session. The website's
 * server-side call sends no `Origin` of its own, so its page pins one; a request without one is not
 * the website's.
 */
export const originGuard: MiddlewareHandler<Env> = async (c, next) => {
  if (!isAllowedOrigin(c.req.header("Origin"))) {
    return c.json({ error: "Origin not allowed" }, 403, NO_STORE);
  }
  await next();
};

/**
 * The app session that may approve a grant: one the middleware found AND read under the `__Host-`
 * cookie name. A legacy-name session is null here, so it is treated as no session.
 */
function approvingSession(c: Ctx): { id: number; userId: number } | null {
  if (c.var.webSessionCookieName !== SESSION_COOKIE_NAME) return null;
  const session = c.var.webSession;
  return session ? { id: session.id, userId: session.user_id } : null;
}

/** `waitUntil`, or undefined outside a real Worker invocation, where Hono's getter throws. */
function backgroundOf(c: Ctx): ((work: Promise<unknown>) => void) | undefined {
  try {
    const ctx = c.executionCtx;
    return (work) => ctx.waitUntil(work);
  } catch {
    return undefined;
  }
}

/** The budget's refusal for this account, or null when the call may go on. */
async function overBudget(c: Ctx, userId: number): Promise<Response | null> {
  const budget = await checkOidcAuthorizeBudget(c.env, c.req.raw, userId, backgroundOf(c));
  if (budget.allowed) return null;
  const refused = new Response(budget.response.body, budget.response);
  refused.headers.set("Cache-Control", "no-store");
  return refused;
}

/** The JSON object body, or null for anything else. Never echoed. */
async function objectBody(c: Ctx): Promise<Record<string, unknown> | null> {
  const body = (await c.req.json().catch(() => null)) as unknown;
  return body !== null && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

const invalidBody = (c: Ctx) =>
  c.json(
    { error: "invalid_body", message: "The request body does not have the contract's shape." },
    400,
    NO_STORE,
  );

export const authOidcRoutes = new Hono<Env>();

authOidcRoutes.post(
  routed(OIDC_AUTHORIZE_CHECK_PATH),
  oidcAuthorizeSurface,
  callerGuard,
  originGuard,
  webSessionMiddleware,
  async (c) => {
    const session = approvingSession(c);
    if (session) {
      const refused = await overBudget(c, session.userId);
      if (refused) return refused;
    }
    const body = await objectBody(c);
    if (!body || typeof body.request !== "string") return invalidBody(c);
    const answer = await checkAuthorization(c.env, body.request, session?.id ?? null);
    return c.json(answer, 200, NO_STORE);
  },
);

authOidcRoutes.post(
  routed(OIDC_AUTHORIZE_CONSENT_PATH),
  oidcAuthorizeSurface,
  callerGuard,
  originGuard,
  webSessionMiddleware,
  async (c) => {
    const session = approvingSession(c);
    if (session) {
      const refused = await overBudget(c, session.userId);
      if (refused) return refused;
    }
    const body = await objectBody(c);
    if (
      !body ||
      typeof body.request !== "string" ||
      typeof body.consent_token !== "string" ||
      !(OIDC_CONSENT_DECISIONS as readonly unknown[]).includes(body.decision)
    ) {
      return invalidBody(c);
    }
    const answer = await decideConsent(
      c.env,
      body.request,
      body.consent_token,
      body.decision as OidcConsentDecision,
      session?.id ?? null,
    );
    return c.json(answer, 200, NO_STORE);
  },
);
