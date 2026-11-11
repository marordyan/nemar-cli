/**
 * The route table of the `/oauth` router (epic #2014 phase #2018), pinned the way the authorization
 * router's is (`oidc-authorize-inventory.test.ts`): exactly the four endpoints and their methods,
 * nothing wildcard, and every chain starting with the surface rule (404 unless the provider is on,
 * on the issuer host, with `HOST_PREFIXED_SESSION_COOKIE` "1") and then `noStore`, by reference, so a
 * refactor that drops or reorders either fails here by name. Userinfo's third handler is an
 * `oidcBearer`, and no other route of the router carries one.
 *
 * Hono lists one entry per handler of a chain: `post(path, a, b, handler)` is three.
 */

import { describe, expect, test } from "bun:test";
import { isOidcBearerMiddleware, oidcBearerScopes } from "../src/middleware/oidc-bearer";
import { oidcAuthorizeSurface } from "../src/routes/auth-oidc";
import { noStore, oauthRoutes } from "../src/routes/oauth";

describe("the /oauth router's route table", () => {
  test("is exactly the four endpoints, with these methods and chain lengths", () => {
    const counts: Record<string, number> = {};
    for (const r of oauthRoutes.routes) {
      const key = `${r.method} ${r.path}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    expect(counts).toEqual({
      "POST /token": 3,
      "GET /userinfo": 4,
      "POST /userinfo": 4,
      "POST /revoke": 3,
      "POST /introspect": 3,
    });
  });

  test("no entry is a wildcard or an ALL", () => {
    for (const r of oauthRoutes.routes) {
      expect(r.method).not.toBe("ALL");
      expect(r.path).not.toContain("*");
    }
  });

  test("every chain starts with the surface, then no-store; only userinfo carries oidcBearer", () => {
    const chains = new Map<string, unknown[]>();
    for (const r of oauthRoutes.routes) {
      const key = `${r.method} ${r.path}`;
      chains.set(key, [...(chains.get(key) ?? []), r.handler]);
    }
    for (const [key, chain] of chains) {
      expect({ key, first: chain[0] === oidcAuthorizeSurface }).toEqual({ key, first: true });
      expect({ key, second: chain[1] === noStore }).toEqual({ key, second: true });
      const bearers = chain.filter(isOidcBearerMiddleware).length;
      expect({ key, bearers }).toEqual({ key, bearers: key.endsWith("/userinfo") ? 1 : 0 });
      if (key.endsWith("/userinfo")) {
        expect(isOidcBearerMiddleware(chain[2])).toBe(true);
        // Both methods require exactly openid.
        expect({ key, scopes: oidcBearerScopes(chain[2]) }).toEqual({ key, scopes: ["openid"] });
      }
    }
  });
});
