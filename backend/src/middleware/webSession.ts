/**
 * Web-session middleware (#569).
 *
 * Reads the session cookie (`__Host-nemar_session`, or the legacy `nemar_session`: see
 * `readSessionCookie`), looks up the row, and exposes the
 * joined user (and the raw cookie value) on the Hono context so the
 * route handler can build the response without re-parsing the cookie.
 *
 * Intentionally optional: routes that need it (`/auth/logout`,
 * `/auth/me`) mount this middleware explicitly. We never enforce
 * cookie auth globally because the rest of the API runs on bearer
 * API tokens — mixing would create double-auth ambiguity, and the
 * web flow does not gate any non-web endpoint.
 */

import type { Context, Next } from "hono";
import { findSessionByCookieId, readSessionCookie } from "../services/web-session";
import type { Bindings, Variables } from "../types/bindings";

type WebSessionContext = Context<{ Bindings: Bindings; Variables: Variables }>;

/**
 * Hydrates `c.var.webUser` and `c.var.webSessionCookieId` when a valid
 * cookie is present. Never short-circuits: routes inspect the
 * variables and decide whether to require auth. `/auth/me` returns
 * `{ user: null }` for a missing cookie; `/auth/logout` is idempotent
 * and returns 200 either way.
 */
export async function webSessionMiddleware(c: WebSessionContext, next: Next) {
  const cookieHeader = c.req.header("Cookie");
  const found = readSessionCookie(cookieHeader);
  const cookieIdRaw = found?.value;
  if (!found || !cookieIdRaw) {
    await next();
    return;
  }
  c.set("webSessionCookieId", cookieIdRaw);
  c.set("webSessionCookieName", found.name);

  try {
    const session = await findSessionByCookieId(c.env, cookieIdRaw);
    if (session) {
      c.set("webUser", session.user);
      c.set("webSession", session.session);
    }
  } catch (err) {
    // Cookie lookup failures are non-fatal: the route treats the user
    // as unauthenticated. Log so persistent DB errors surface in logs --
    // a SCHEMA-shaped message (a column or table the query names does not
    // exist, i.e. a migration has not landed on this environment yet) gets
    // its own prefix so it is not indistinguishable from a transient D1
    // blip (epic #1272 phase 4, #1284 review; ADR 0048).
    const message = err instanceof Error ? err.message : String(err);
    if (/no such column|no such table/i.test(message)) {
      console.error("[web-session-mw] SCHEMA lookup failed (migration ordering?)", err);
    } else {
      console.error("[web-session-mw] lookup failed", err);
    }
  }

  await next();
}
