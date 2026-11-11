/**
 * The route table of the authorization router (epic #2014 phase #2017), pinned the way the discovery
 * router's is (`oidc-discovery-inventory.test.ts`). The router is mounted under `/auth` beside every
 * other auth family, so a wildcard entry would guard, or answer for, all of them. The table is exactly
 * the two routes the contract names, POST only, and each carries its guards in the one order the
 * module comment of `routes/auth-oidc.ts` gives: the surface, the caller marker, the Origin, the session, the handler.
 *
 * Hono lists one entry per handler of a chain: `post(path, a, b, c, d, handler)` is five.
 */

import { describe, expect, test } from "bun:test";
import {
  OIDC_AUTHORIZE_CHECK_PATH,
  OIDC_AUTHORIZE_CONSENT_PATH,
} from "../../shared/contract/oidc-authorize";
import { webSessionMiddleware } from "../src/middleware/webSession";
import {
  authOidcRoutes,
  callerGuard,
  oidcAuthorizeSurface,
  originGuard,
} from "../src/routes/auth-oidc";

const ROUTED = [OIDC_AUTHORIZE_CHECK_PATH, OIDC_AUTHORIZE_CONSENT_PATH].map((p) =>
  p.slice("/auth".length),
);

describe("the authorization router's route table", () => {
  test("is exactly the two POST routes of the contract, five handlers each", () => {
    const counts: Record<string, number> = {};
    for (const r of authOidcRoutes.routes) {
      const key = `${r.method} ${r.path}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    expect(counts).toEqual(Object.fromEntries(ROUTED.map((p) => [`POST ${p}`, 5])));
  });

  test("no entry is a wildcard or an ALL", () => {
    for (const r of authOidcRoutes.routes) {
      expect(r.method).not.toBe("ALL");
      expect(r.path).not.toContain("*");
    }
  });

  test("the guards come first, in order: surface, caller marker, Origin, session", () => {
    for (const path of ROUTED) {
      const chain = authOidcRoutes.routes.filter((r) => r.path === path);
      expect(chain).toHaveLength(5);
      expect(chain[0]?.handler).toBe(oidcAuthorizeSurface);
      expect(chain[1]?.handler).toBe(callerGuard);
      expect(chain[2]?.handler).toBe(originGuard);
      expect(chain[3]?.handler).toBe(webSessionMiddleware);
    }
  });
});
