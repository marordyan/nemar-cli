/**
 * A partner subdomain is not a NEMAR origin (epic #2014 phase #2015, ADR 0119 decision 9).
 *
 * `compute.nemar.org` is run by another party and serves pages whose JavaScript people write
 * themselves. Until now the API trusted every `*.nemar.org` host twice: in the cross-origin
 * allow-list (the api, zarr and mcp forks all read it through `isNemarWebOrigin`) and in the origin
 * check on a write that carries the session cookie (`isAllowedOrigin`). Both now refuse a partner
 * host, and this file proves it through the worker's real `fetch`, the way Cloudflare drives it,
 * with the real routes behind a real database. Nothing here calls the two predicates directly:
 * `cors-origins.test.ts` does that, and a predicate test cannot catch a call site that stopped
 * asking.
 *
 * Each "refused" assertion has an "unchanged" twin on `app.nemar.org`, so a fork that refuses
 * everything does not pass, and the twin is what says the exclusion changed nothing else.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import worker from "../src/index";
import { hashApiKey } from "../src/services/token";
import { issueSession } from "../src/services/web-session";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const ctx = {
  waitUntil: (p: Promise<unknown>) => {
    p.catch(() => {});
  },
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

const APP = "https://app.nemar.org";
/** The partner host, a subdomain of it, the same host in capitals (a browser lowercases it; a
 *  header written by hand need not), and a host that only ends in the partner's label. */
const PARTNER = "https://compute.nemar.org";
const PARTNER_SUBDOMAIN = "https://x.compute.nemar.org";
const PARTNER_CAPITALS = "https://COMPUTE.nemar.org";
const LOOKALIKE = "https://notcompute.nemar.org";

const REFUSED_PARTNER_ORIGINS = [PARTNER, PARTNER_SUBDOMAIN, PARTNER_CAPITALS];

let db: Database;

function env(): Bindings {
  // "development" is rateLimiter's own documented bypass: caches.default does not exist here.
  return { DB: realD1(db), ENVIRONMENT: "development" } as unknown as Bindings;
}

function get(url: string, origin?: string, method = "GET"): Promise<Response> {
  return Promise.resolve(
    worker.fetch(
      new Request(url, { method, headers: origin ? { Origin: origin } : {} }),
      env(),
      ctx,
    ),
  );
}

beforeEach(() => {
  db = freshDb();
});

describe("the api fork's CORS rule", () => {
  test("allows app.nemar.org, as it always did", async () => {
    const res = await get("https://api.nemar.org/health", APP);
    expect(res.headers.get("access-control-allow-origin")).toBe(APP);
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  test("gives a partner host no allowance, on a request or on its preflight", async () => {
    for (const origin of REFUSED_PARTNER_ORIGINS) {
      const simple = await get("https://api.nemar.org/health", origin);
      // Hono sends `Allow-Credentials` whatever the origin; without an `Allow-Origin` a browser
      // ignores it, so the allow header is the one that decides.
      expect(simple.headers.get("access-control-allow-origin")).toBeNull();
      const preflight = await get("https://api.nemar.org/datasets", origin, "OPTIONS");
      expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  test("a host that merely ends in the partner's label is still a NEMAR host", async () => {
    // The exclusion is the partner and its subdomains, not every name that ends the same way:
    // `notcompute.nemar.org` is not under `compute.nemar.org`, so nothing about it changes.
    const res = await get("https://api.nemar.org/health", LOOKALIKE);
    expect(res.headers.get("access-control-allow-origin")).toBe(LOOKALIKE);
  });
});

describe("the zarr fork's CORS rule", () => {
  // Any path will do: the preflight is answered for every one of them, and it is where the
  // allow header is decided.
  const ZARR_URL = "https://zarr.nemar.org/nm000104/zarr/recording.zarr/.zarray";

  test("allows app.nemar.org, as it always did", async () => {
    const res = await get(ZARR_URL, APP, "OPTIONS");
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(APP);
  });

  test("gives a partner host no allowance", async () => {
    for (const origin of REFUSED_PARTNER_ORIGINS) {
      const res = await get(ZARR_URL, origin, "OPTIONS");
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    }
  });
});

describe("the mcp fork's origin gate", () => {
  const MODERN_META = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientCapabilities": {},
  };

  function discover(origin: string): Promise<Response> {
    return Promise.resolve(
      worker.fetch(
        new Request("https://mcp.nemar.org/mcp", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Mcp-Method": "server/discover",
            Origin: origin,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "server/discover",
            params: { _meta: MODERN_META },
          }),
        }),
        env(),
        ctx,
      ),
    );
  }

  test("admits app.nemar.org, as it always did", async () => {
    const res = await discover(APP);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(APP);
  });

  test("refuses a request from a partner host outright", async () => {
    for (const origin of REFUSED_PARTNER_ORIGINS) {
      const res = await discover(origin);
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error?: { code: number } };
      expect(body.error?.code).toBe(-32000);
    }
  });
});

describe("a write that carries the session cookie", () => {
  let cookie: string;

  beforeEach(async () => {
    db.run(
      `INSERT INTO users (username, email, password_hash, status, role, email_verified)
       VALUES ('partneradmin', 'partneradmin@example.org', 'x', 'approved', 'admin', 1)`,
    );
    const row = db
      .query<{ id: number }, []>("SELECT id FROM users WHERE username = 'partneradmin'")
      .get();
    if (!row) throw new Error("seed: the admin insert failed");
    const { cookieIdRaw } = await issueSession(env(), row.id, false, "test-agent", null, "orcid");
    cookie = `nemar_session=${cookieIdRaw}`;
  });

  /** An admin-router write (id 999999 names no account, so the handler's own answer is a 404). */
  function adminWrite(origin: string): Promise<Response> {
    return Promise.resolve(
      worker.fetch(
        new Request("https://api.nemar.org/admin/revoke/by-id/999999", {
          method: "POST",
          headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" },
          body: "{}",
        }),
        env(),
        ctx,
      ),
    );
  }

  /** A route that checks the origin itself, with `isAllowedOrigin`, rather than through the
   *  admin router's guard. */
  function logout(origin: string): Promise<Response> {
    return Promise.resolve(
      worker.fetch(
        new Request("https://api.nemar.org/auth/logout", {
          method: "POST",
          headers: { Cookie: cookie, Origin: origin },
        }),
        env(),
        ctx,
      ),
    );
  }

  test("is let through from app.nemar.org, as it always was", async () => {
    const res = await adminWrite(APP);
    // The guard did not refuse it: the handler ran and found no such account.
    expect(res.status).toBe(404);
    expect((await logout(APP)).status).toBe(200);
  });

  test("from a partner host is 403 origin_not_allowed on the admin router", async () => {
    for (const origin of REFUSED_PARTNER_ORIGINS) {
      const res = await adminWrite(origin);
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string; code: string };
      expect(body.error).toBe("origin_not_allowed");
      expect(body.code).toBe("origin_not_allowed");
    }
  });

  test("from a partner host is refused by a route that checks the origin itself", async () => {
    for (const origin of REFUSED_PARTNER_ORIGINS) {
      const res = await logout(origin);
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("Origin not allowed");
    }
    // ...and the refused sign-outs did not end the session.
    const live = await db
      .query<{ revoked_at: string | null }, []>("SELECT revoked_at FROM web_sessions")
      .get();
    expect(live?.revoked_at).toBeNull();
  });

  test("a bearer key is still accepted from a partner host: the exclusion is about the cookie", async () => {
    // The origin rule exists because a cookie rides along on a cross-site request. A bearer key
    // cannot be forged cross-site, and a partner reaches NEMAR through bearer tokens by design,
    // so excluding the host from the cookie rule must not touch this path.
    const key = "partner-admin-key-0123456789abcdef0123456789abcdef";
    const row = db
      .query<{ id: number }, []>("SELECT id FROM users WHERE username = 'partneradmin'")
      .get();
    db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
      row?.id ?? 0,
      await hashApiKey(key),
      key.slice(0, 8),
    );
    const res = await worker.fetch(
      new Request("https://api.nemar.org/admin/revoke/by-id/999999", {
        method: "POST",
        headers: {
          Origin: PARTNER,
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: "{}",
      }),
      env(),
      ctx,
    );
    // The handler ran and found no such account; the origin rule never asked.
    expect(res.status).toBe(404);
  });
});
