/**
 * The route table of the discovery router (epic #2014 phase #2016), pinned the way the admin
 * router's is (`test/admin-route-inventory.unit.test.ts`). A router mounted at "/" merges its
 * entries into the API's, so one entry with a wildcard path would guard, or answer for, every route
 * of the Worker: the table is exactly two documents, and each route carries its surface check as its
 * FIRST handler, by reference, so a refactor that drops or reorders it fails here by name.
 *
 * Hono lists one entry per handler of a chain: `get(path, oidcSurface, publicDocument, handler)` is
 * three.
 */

import { describe, expect, test } from "bun:test";
import { OIDC_DISCOVERY_PATH, OIDC_JWKS_PATH } from "../../shared/oidc";
import { oidcDiscoveryRoutes, oidcSurface } from "../src/routes/oidc-discovery";

describe("the discovery router's route table", () => {
  test("is exactly the two documents, three handlers each, and nothing else", () => {
    const counts: Record<string, number> = {};
    for (const r of oidcDiscoveryRoutes.routes) {
      const key = `${r.method} ${r.path}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    expect(counts).toEqual({
      [`GET ${OIDC_DISCOVERY_PATH}`]: 3,
      [`GET ${OIDC_JWKS_PATH}`]: 3,
    });
  });

  test("no entry is a wildcard or an ALL: mounted at the root it would reach every route of the API", () => {
    for (const r of oidcDiscoveryRoutes.routes) {
      expect(r.method).not.toBe("ALL");
      expect(r.path).not.toContain("*");
    }
  });

  test("the first handler of each route is the surface check", () => {
    for (const path of [OIDC_DISCOVERY_PATH, OIDC_JWKS_PATH]) {
      const chain = oidcDiscoveryRoutes.routes.filter((r) => r.path === path);
      expect(chain).toHaveLength(3);
      expect(chain[0]?.handler).toBe(oidcSurface);
    }
  });
});
