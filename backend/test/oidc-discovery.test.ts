/**
 * Discovery and the key set, as the real Worker serves them (epic #2014 phase #2016; ADR 0119,
 * decision 2): on the issuer's host only, and exempt from the maintenance mode and from the rate
 * limiter, which is the price of putting the issuer on the API host (a client that cannot fetch
 * them during maintenance or a burst cannot validate a token).
 *
 * Driven through `worker.fetch`, the entry point, so the hostname fork, the `/nemar` mount, the
 * global middleware and the route are all the production ones. The limiter and the maintenance
 * middleware are the real ones too: the exemption is shown by the same request being refused on a
 * path that is not exempt, in the same conditions.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { __limits } from "../src/middleware/rateLimit";
import { rotateSigningKeys } from "../src/services/oidc-keys";
import type { Bindings } from "../src/types/bindings";
import { wrapD1 } from "./helpers/d1";
import { ISSUER, type OidcHarness, startOidcHarness } from "./helpers/oidc-harness";
import { BAD_OIDC_SECRETS, fakeOidcSecret } from "./helpers/oidc-secret";
import { T0, edge, useRateLimitHarness } from "./helpers/rate-limit-harness";

const DISCOVERY = "/.well-known/openid-configuration";
const JWKS = "/oauth/jwks";

let h: OidcHarness;

beforeEach(async () => {
  h = await startOidcHarness();
  const rotated = await rotateSigningKeys(h.env, { actorId: h.ids.owner });
  expect(rotated.ok).toBe(true);
});

const kidsInDb = (): string[] =>
  h.db
    .query<{ kid: string }, []>("SELECT kid FROM oidc_signing_keys ORDER BY state")
    .all()
    .map((r) => r.kid);

describe("discovery and the key set are served on the issuer's host", () => {
  test("the discovery document, with the headers a public document carries", async () => {
    const res = await h.call("GET", DISCOVERY);
    expect(res.status, res.text).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect(res.json?.issuer).toBe(ISSUER);
    expect(res.json?.authorization_endpoint).toBe("https://app.nemar.org/oauth/authorize");
    expect(res.json?.jwks_uri).toBe(`${ISSUER}/oauth/jwks`);
    expect(res.json?.token_endpoint).toBe(`${ISSUER}/oauth/token`);
  });

  test("the key set, public keys only, with the same headers", async () => {
    const res = await h.call("GET", JWKS);
    expect(res.status, res.text).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
    const keys = (res.json as { keys: Array<Record<string, string>> }).keys;
    expect(keys.map((k) => k.kid).sort()).toEqual(kidsInDb().sort());
    for (const key of keys) {
      expect(Object.keys(key).sort()).toEqual(["alg", "crv", "kid", "kty", "use", "x", "y"]);
    }
    expect(res.text).not.toContain('"d"');
  });

  test("a page on a NEMAR origin gets the same open answer, not an echo of its origin with credentials", async () => {
    for (const path of [DISCOVERY, JWKS]) {
      const res = await h.call("GET", path, { headers: { Origin: "https://app.nemar.org" } });
      expect(res.status).toBe(200);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    }
  });

  test("a partner host's page can read both, from any origin", async () => {
    for (const path of [DISCOVERY, JWKS]) {
      const res = await h.call("GET", path, { headers: { Origin: "https://compute.nemar.org" } });
      expect(res.status).toBe(200);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    }
  });

  test("HEAD works, and no method but a read does", async () => {
    expect((await h.call("HEAD", DISCOVERY)).status).toBe(200);
    expect((await h.call("HEAD", JWKS)).status).toBe(200);
    for (const method of ["POST", "PUT", "DELETE"]) {
      const res = await h.call(method, DISCOVERY, { body: {} });
      expect(res.status, method).toBe(404);
    }
  });

  test("discovery says it speaks the query response mode and no other", async () => {
    const res = await h.call("GET", DISCOVERY);
    expect(res.json?.response_modes_supported).toEqual(["query"]);
  });

  test("the issuer is API_BASE_URL, whatever the request or its headers say", async () => {
    const res = await h.call("GET", DISCOVERY, {
      headers: { "X-Forwarded-Host": "evil.example", "X-Forwarded-Proto": "http" },
    });
    expect(res.json?.issuer).toBe(ISSUER);
    const withSlash = await h.call("GET", DISCOVERY, {
      env: { API_BASE_URL: "https://api.nemar.org/" },
    });
    expect(withSlash.json?.issuer).toBe(ISSUER);
    expect(withSlash.json?.jwks_uri).toBe(`${ISSUER}/oauth/jwks`);
  });

  test("a staging Worker's issuer is its own API_BASE_URL, on its own host", async () => {
    const staging = {
      API_BASE_URL: "https://api-test.nemar.org",
      APP_BASE_URL: "https://test.nemar.org",
    };
    const res = await h.call("GET", DISCOVERY, {
      base: "https://api-test.nemar.org",
      env: staging,
    });
    expect(res.status).toBe(200);
    expect(res.json?.issuer).toBe("https://api-test.nemar.org");
    expect(res.json?.authorization_endpoint).toBe("https://test.nemar.org/oauth/authorize");
    // And the production host, asked of the staging Worker, is not its issuer.
    const wrong = await h.call("GET", DISCOVERY, { env: staging });
    expect(wrong.status).toBe(404);
  });
});

describe("and answered 404 everywhere else", () => {
  const body = (res: { json: Record<string, unknown> | null }) => JSON.stringify(res.json);

  test("on the data host, the zarr host and the MCP host", async () => {
    for (const host of ["data.nemar.org", "zarr.nemar.org", "mcp.nemar.org"]) {
      for (const path of [DISCOVERY, JWKS]) {
        const res = await h.call("GET", path, { base: `https://${host}` });
        expect(res.status, `${host}${path}`).toBe(404);
        expect(res.text).not.toContain("issuer");
        expect(res.text).not.toContain('"keys"');
      }
    }
  });

  test("on the staging data host the Worker is told about", async () => {
    const res = await h.call("GET", DISCOVERY, {
      base: "https://data-test.nemar.org",
      env: { DATA_HOSTNAME: "data-test.nemar.org" },
    });
    expect(res.status).toBe(404);
  });

  test("under the legacy /nemar mount, on the issuer's own host", async () => {
    for (const path of [DISCOVERY, JWKS]) {
      const res = await h.call("GET", `/nemar${path}`);
      expect(res.status, path).toBe(404);
      expect(res.text).not.toContain("issuer");
      expect(res.text).not.toContain('"keys"');
    }
  });

  /** The same legacy mount, spelled so that a router decodes it but a plain string test does not. */
  const ENCODED_MOUNTS = ["%6eemar", "%6Eemar", "n%65mar", "%256eemar", "%25256eemar"];

  test("under the legacy /nemar mount spelled with percent-encoding, on the issuer's own host", async () => {
    for (const mount of ENCODED_MOUNTS) {
      for (const path of [DISCOVERY, JWKS]) {
        const res = await h.call("GET", `/${mount}${path}`);
        expect(res.status, `/${mount}${path}`).toBe(404);
        expect(res.text).not.toContain("issuer");
        expect(res.text).not.toContain('"keys"');
      }
    }
  });

  test("the router's decoded path is the one that decides: spellings a plain string test misses", async () => {
    for (const mount of ["%6eemar", "%6Eemar", "n%65mar"]) {
      for (const path of [DISCOVERY, JWKS]) {
        for (const tail of ["", "%ff", "/%ff"]) {
          const res = await h.call("GET", `/${mount}${path}${tail}`);
          expect(res.status, `/${mount}${path}${tail}`).toBe(404);
          expect(res.text).not.toContain("issuer");
          expect(res.text).not.toContain('"keys"');
        }
      }
    }
  });

  test("on another hostname", async () => {
    for (const base of [
      "https://api-test.nemar.org",
      "https://nemar-api-dev.sccn-org.workers.dev",
      "https://evil.example",
      "https://api.nemar.org.evil.example",
      "https://sub.api.nemar.org",
    ]) {
      for (const path of [DISCOVERY, JWKS]) {
        const res = await h.call("GET", path, { base });
        expect(res.status, `${base}${path}`).toBe(404);
      }
    }
  });

  test("a forged Host header does not make another host the issuer's", async () => {
    // The request's own URL names the host; a header cannot rename it.
    const res = await h.call("GET", DISCOVERY, {
      base: "https://evil.example",
      headers: { Host: "api.nemar.org", "X-Forwarded-Host": "api.nemar.org" },
    });
    expect(res.status).toBe(404);
  });

  test("when OIDC_SECRET is absent, empty, too short or not an nmsso- secret", async () => {
    for (const [, secret] of BAD_OIDC_SECRETS) {
      for (const path of [DISCOVERY, JWKS]) {
        const res = await h.call("GET", path, { env: { OIDC_SECRET: secret as string } });
        expect(res.status, `${path} with ${JSON.stringify(secret)}`).toBe(404);
        expect(res.text).not.toContain("issuer");
      }
    }
    // Exactly 32 in all, with the prefix, is on.
    const on = await h.call("GET", DISCOVERY, { env: { OIDC_SECRET: fakeOidcSecret("min", 26) } });
    expect(on.status).toBe(200);
  });

  test("the refusal is the API's own unrouted 404 and not a different-looking one", async () => {
    const refused = await h.call("GET", DISCOVERY, { base: "https://evil.example" });
    const unrouted = await h.call("GET", "/.well-known/does-not-exist");
    expect(refused.status).toBe(404);
    expect(refused.headers.get("Cache-Control")).toBe("no-store");
    expect(body(refused)).toContain("Not Found");
    expect(unrouted.status).toBe(404);
    expect(Object.keys(refused.json ?? {}).sort()).toEqual(Object.keys(unrouted.json ?? {}).sort());
  });
});

describe("a rotation shows in the key set at once, in the isolate that made it", () => {
  test("the new next key is published the moment it exists", async () => {
    const before = (await h.call("GET", JWKS)).json as { keys: Array<{ kid: string }> };
    expect(before.keys).toHaveLength(2);
    const rotated = await rotateSigningKeys(h.env, {
      actorId: h.ids.owner,
      force: true,
      emergency: true,
    });
    expect(rotated.ok).toBe(true);
    const after = (await h.call("GET", JWKS)).json as { keys: Array<{ kid: string }> };
    expect(after.keys).toHaveLength(3);
    for (const k of kidsInDb()) expect(after.keys.map((x) => x.kid)).toContain(k);
  });
});

describe("exempt from the maintenance mode", () => {
  test.each(["full", "read-only"])("MAINTENANCE_MODE=%s", async (mode) => {
    const env = { MAINTENANCE_MODE: mode as Bindings["MAINTENANCE_MODE"] };
    // The mode is on: an ordinary read is refused in `full`, and a write in both.
    const control = await h.call(mode === "full" ? "GET" : "POST", "/auth/code/request", {
      body: { email: "x@example.org" },
      env,
    });
    expect(control.status).toBe(503);
    for (const path of [DISCOVERY, JWKS]) {
      const res = await h.call("GET", path, { env });
      expect(res.status, `${path} under ${mode}`).toBe(200);
      expect(res.json).not.toHaveProperty("mode");
    }
  });

  test("the exemption is for a read of those two documents: any other method is under the mode", async () => {
    for (const mode of ["full", "read-only"] as const) {
      for (const method of ["POST", "PUT", "DELETE"]) {
        for (const path of [DISCOVERY, JWKS]) {
          const res = await h.call(method, path, { body: {}, env: { MAINTENANCE_MODE: mode } });
          expect(res.status, `${method} ${path} under ${mode}`).toBe(503);
        }
      }
    }
    // A HEAD is a read.
    const head = await h.call("HEAD", DISCOVERY, { env: { MAINTENANCE_MODE: "full" } });
    expect(head.status).toBe(200);
  });

  test("the exemption is for those two documents and no other path of the OIDC surface", async () => {
    const res = await h.call("GET", "/oauth/token", { env: { MAINTENANCE_MODE: "full" } });
    expect(res.status).toBe(503);
  });
});

describe("exempt from the rate limiter", () => {
  const limiter = useRateLimitHarness();
  const ADDRESS = "203.0.113.77";
  // The real limiter runs in production and staging; bun has no Cache API, and the harness installs
  // the working in-memory one. A bucket at its cap is the condition.
  const exhaust = () =>
    limiter.seed(`ip:${ADDRESS}`, { count: 1000, warned: false, windowEnd: T0 + 30_000 });
  const asProduction = { ENVIRONMENT: "production" } as Partial<Bindings>;

  test("an address whose bucket is full is refused elsewhere and still served both documents", async () => {
    await exhaust();
    const control = await h.call("GET", "/datasets", {
      headers: edge(ADDRESS),
      env: asProduction,
      bypass: false,
    });
    expect(control.status).toBe(429);
    for (const path of [DISCOVERY, JWKS]) {
      const res = await h.call("GET", path, {
        headers: edge(ADDRESS),
        env: asProduction,
        bypass: false,
      });
      expect(res.status, path).toBe(200);
      expect(res.headers.get("X-RateLimit-Bucket")).toBeNull();
    }
  });

  test("serving them does not spend the address's allowance", async () => {
    for (let i = 0; i < 5; i++) {
      await h.call("GET", DISCOVERY, { headers: edge(ADDRESS), env: asProduction, bypass: false });
      await h.call("GET", JWKS, { headers: edge(ADDRESS), env: asProduction, bypass: false });
    }
    expect(await limiter.stored(`ip:${ADDRESS}`)).toBeUndefined();
  });

  test("the exemption is for a read: any other method of those paths is counted", async () => {
    await exhaust();
    for (const method of ["POST", "PUT", "DELETE"]) {
      for (const path of [DISCOVERY, JWKS]) {
        const res = await h.call(method, path, {
          headers: edge(ADDRESS),
          body: {},
          env: asProduction,
          bypass: false,
        });
        expect(res.status, `${method} ${path}`).toBe(429);
      }
    }
    const head = await h.call("HEAD", DISCOVERY, {
      headers: edge(ADDRESS),
      env: asProduction,
      bypass: false,
    });
    expect(head.status).toBe(200);
  });

  test("the exemption is not a way to the rest of the surface", async () => {
    await exhaust();
    const res = await h.call("GET", "/oauth/userinfo", {
      headers: edge(ADDRESS),
      env: asProduction,
      bypass: false,
    });
    expect(res.status).toBe(429);
    // The token endpoint is limited too, by its own bucket (#2018).
    await limiter.seed(`oauth-ip:${ADDRESS}`, {
      count: __limits.OAUTH_MAX_REQUESTS,
      warned: false,
      windowEnd: T0 + 30_000,
    });
    const token = await h.call("POST", "/oauth/token", {
      headers: edge(ADDRESS),
      env: asProduction,
      bypass: false,
    });
    expect(token.status).toBe(429);
    expect(token.headers.get("X-RateLimit-Bucket")).toBe("oauth-ip");
    const legacy = await h.call("GET", `/nemar${DISCOVERY}`, {
      headers: edge(ADDRESS),
      env: asProduction,
      bypass: false,
    });
    expect(legacy.status).toBe(429);
  });
});

describe("a public document is cacheable only when it is the document", () => {
  const brokenDatabase = () =>
    wrapD1(h.env.DB, (sql) => {
      if (sql.includes("oidc_signing_keys")) throw new Error("the database is down");
    });

  test("a key set that could not be read is a 500 with no public cache header and no open CORS grant", async () => {
    const res = await h.call("GET", JWKS, { env: { DB: brokenDatabase() } });
    expect(res.status).toBe(500);
    expect(res.headers.get("Cache-Control") ?? "").not.toContain("public");
    expect(res.headers.get("Access-Control-Allow-Origin")).not.toBe("*");
    expect(res.text).not.toContain('"keys"');
  });

  test("a current key whose public half is broken is a 500, not a quietly shorter key set", async () => {
    h.db.run(
      `UPDATE oidc_signing_keys SET public_jwk = '{"kty":"EC","crv":"P-256","x":"abc"}' WHERE state = 'current'`,
    );
    const res = await h.call("GET", JWKS);
    expect(res.status).toBe(500);
    expect(res.headers.get("Cache-Control") ?? "").not.toContain("public");
    expect(res.text).not.toContain('"keys"');
  });

  test("the answers that are the document carry it", async () => {
    for (const path of [DISCOVERY, JWKS]) {
      const res = await h.call("GET", path);
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    }
  });
});
