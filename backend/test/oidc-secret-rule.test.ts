/**
 * The `OIDC_SECRET` form rule (owner decision 2026-11-07; ADR 0119 addendum): the provider is on
 * only when the secret starts with `nmsso-` and is at least 32 characters in all, so a wrong or
 * placeholder value cannot switch it on. This file holds the rule to EVERY route of the surface,
 * taken from the routers' own tables, and to what the owner is told (a fixed word, never the value).
 *
 *   - a bad value is a 404 on every route (discovery, key set, authorization checks, token,
 *     userinfo, revocation, introspection, every owner route), and nothing is written;
 *   - a good value (32 characters in all, 70, any allowed body character) turns the surface on;
 *   - the owner is told `unset` or `malformed`, and the answer never holds the value;
 *   - a signing key made under a good secret is not usable under a bad one.
 */

import { describe, expect, test } from "bun:test";
import { OIDC_SECRET_MIN_LENGTH, OIDC_SECRET_PREFIX, isOidcSecret } from "../../shared/oidc";
import { adminRoutes } from "../src/routes/admin";
import { authOidcRoutes } from "../src/routes/auth-oidc";
import { oauthRoutes } from "../src/routes/oauth";
import { oidcDiscoveryRoutes } from "../src/routes/oidc-discovery";
import { EncryptionError, decrypt, encrypt } from "../src/services/encryption";
import { checkAuthorization, decideConsent } from "../src/services/oidc-authorize";
import { oidcEnabled, oidcSecret, oidcSecretStatus } from "../src/services/oidc-config";
import { signJwt } from "../src/services/oidc-keys";
import type { Bindings } from "../src/types/bindings";
import {
  RFC_CHALLENGE,
  registerClient,
  rotateKeys,
  seedAccount,
  sessionCookie,
} from "./helpers/oidc-flow";
import { OWNER_KEY, type OidcHarness, startOidcHarness } from "./helpers/oidc-harness";
import { BAD_OIDC_SECRETS, GOOD_OIDC_SECRETS, fakeOidcSecret } from "./helpers/oidc-secret";

const CLIENT_ID = "oc_0123456789abcdef01234567";
const KID = "0123456789abcdef";

type Route = readonly [method: string, path: string];

/** Every route of a router, as `[method, mounted path]`, once each (Hono lists one entry per handler). */
function tableOf(routes: ReadonlyArray<{ method: string; path: string }>, mount: string): Route[] {
  const seen = new Set<string>();
  const out: Route[] = [];
  for (const r of routes) {
    if (r.method === "ALL") continue;
    const key = `${r.method} ${r.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([r.method, `${mount}${r.path === "/" ? "" : r.path}`]);
  }
  return out;
}

const OWNER_ROUTES: Route[] = tableOf(
  adminRoutes.routes.filter((r) => r.path.startsWith("/oidc/")),
  "/admin",
).map(([m, p]) => [m, p.replace(":client_id", CLIENT_ID).replace(":kid", KID).replace(":id", "7")]);

/** The public and per-request surface: from the routers' own tables, not a hand-written list. */
const SURFACE: Route[] = [
  ...tableOf(oidcDiscoveryRoutes.routes, ""),
  ...tableOf(oauthRoutes.routes, "/oauth"),
  ...tableOf(authOidcRoutes.routes, "/auth"),
];

const ALL_ROUTES: Route[] = [...SURFACE, ...OWNER_ROUTES];

async function call(h: OidcHarness, [method, path]: Route, secret: unknown, owner = false) {
  return h.call(method, path, {
    key: owner ? OWNER_KEY : null,
    body: method === "POST" ? {} : undefined,
    env: { OIDC_SECRET: secret } as Partial<Bindings>,
  });
}

const SECRET_BEARING = (v: unknown): v is string => typeof v === "string" && v.length > 0;

describe("the route tables the rule is held to", () => {
  test("are the whole surface, so a new route is covered by being in its router", () => {
    // Discovery document and key set, the four token-side endpoints (userinfo has two methods),
    // the two authorization checks, and the ten owner routes.
    expect(SURFACE.map(([m, p]) => `${m} ${p}`).sort()).toEqual(
      [
        "GET /.well-known/openid-configuration",
        "GET /oauth/jwks",
        "POST /oauth/token",
        "GET /oauth/userinfo",
        "POST /oauth/userinfo",
        "POST /oauth/revoke",
        "POST /oauth/introspect",
        "POST /auth/oidc/authorize",
        "POST /auth/oidc/consent",
      ].sort(),
    );
    expect(OWNER_ROUTES).toHaveLength(10);
  });
});

describe("a bad OIDC_SECRET is a 404 on every route of the surface", () => {
  for (const [what, value] of BAD_OIDC_SECRETS) {
    test(`${what}`, async () => {
      const h = await startOidcHarness({ HOST_PREFIXED_SESSION_COOKIE: "1" });
      for (const route of SURFACE) {
        const res = await call(h, route, value);
        expect({ route, what, status: res.status }).toEqual({ route, what, status: 404 });
      }
      for (const route of OWNER_ROUTES) {
        const res = await call(h, route, value, true);
        expect({ route, what, status: res.status }).toEqual({ route, what, status: 404 });
      }
      expect(h.db.query("SELECT COUNT(*) AS n FROM oidc_clients").get()).toEqual({ n: 0 });
      expect(h.db.query("SELECT COUNT(*) AS n FROM oidc_signing_keys").get()).toEqual({ n: 0 });
    });
  }
});

describe("a good OIDC_SECRET puts every route on the surface", () => {
  for (const [what, value] of GOOD_OIDC_SECRETS) {
    test(`${what}: not one route is a 404`, async () => {
      const h = await startOidcHarness({ HOST_PREFIXED_SESSION_COOKIE: "1" });
      for (const route of SURFACE) {
        const res = await call(h, route, value);
        expect({ route, what, notFound: res.status === 404 }).toEqual({
          route,
          what,
          notFound: false,
        });
      }
      for (const route of OWNER_ROUTES) {
        const res = await call(h, route, value, true);
        // Some owner routes answer 404 for a missing client, key or account; those say so by code.
        const surfaceGone = res.status === 404 && res.json?.code === undefined;
        expect({ route, what, surfaceGone }).toEqual({ route, what, surfaceGone: false });
      }
    });
  }

  test("the minimum is exactly 32 characters in all, and the real ones are 70", () => {
    expect(GOOD_OIDC_SECRETS[0]?.[1]).toHaveLength(OIDC_SECRET_MIN_LENGTH);
    expect(GOOD_OIDC_SECRETS[1]?.[1]).toHaveLength(70);
  });
});

describe("the owner is told which word, and never the value", () => {
  test("unset and malformed are different fixed words on the owner routes", async () => {
    const h = await startOidcHarness();
    const words: Record<string, unknown> = {};
    for (const [what, value] of BAD_OIDC_SECRETS) {
      const res = await call(h, OWNER_ROUTES[0] as Route, value, true);
      expect(res.status).toBe(404);
      words[what] = res.json?.oidc_secret;
      // Still the API's own not-found shape, plus the one field.
      expect(res.json?.error).toBe("Not Found");
      expect(typeof res.json?.message).toBe("string");
      // The value, and any long run of it, is nowhere in the body or the headers.
      if (SECRET_BEARING(value)) {
        expect(res.text).not.toContain(value);
        expect(res.text).not.toContain(value.trim().slice(0, 12));
      }
      const wire = JSON.stringify([...res.headers]);
      if (SECRET_BEARING(value)) expect(wire).not.toContain(value);
      expect(Object.keys(res.json ?? {}).sort()).toEqual(["error", "message", "oidc_secret"]);
    }
    for (const unset of ["unset", "empty", "null"]) expect(words[unset]).toBe("unset");
    for (const [what] of BAD_OIDC_SECRETS) {
      if (!["unset", "empty", "null"].includes(what)) {
        expect({ what, word: words[what] }).toEqual({ what, word: "malformed" });
      }
    }
  });

  test("the word does not depend on the length of the value", async () => {
    const h = await startOidcHarness();
    const a = await call(h, OWNER_ROUTES[0] as Route, "x".repeat(5), true);
    const b = await call(h, OWNER_ROUTES[0] as Route, "x".repeat(500), true);
    expect(a.json).toEqual({ ...b.json, message: a.json?.message });
  });

  test("a caller who is not the owner is told what they are, never the word", async () => {
    const h = await startOidcHarness();
    const anon = await h.call("GET", "/admin/oidc/keys", {
      env: { OIDC_SECRET: "wrong" } as Partial<Bindings>,
    });
    expect(anon.status).toBe(401);
    expect(anon.text).not.toContain("malformed");
  });

  test("the public surface says nothing: its 404 is the unrouted one, no word", async () => {
    const h = await startOidcHarness();
    for (const route of SURFACE) {
      const res = await call(h, route, "wrong-form");
      expect(res.json).not.toHaveProperty("oidc_secret");
    }
  });

  test("on another host, or under the legacy mount, the owner gets the plain 404 and no word", async () => {
    const h = await startOidcHarness();
    const elsewhere = await h.call("GET", "/admin/oidc/keys", {
      key: OWNER_KEY,
      base: "https://data.nemar.org",
      env: { OIDC_SECRET: undefined },
    });
    expect(elsewhere.json).not.toHaveProperty("oidc_secret");
    const mounted = await h.call("GET", "/nemar/admin/oidc/keys", {
      key: OWNER_KEY,
      env: { OIDC_SECRET: undefined },
    });
    expect(mounted.json).not.toHaveProperty("oidc_secret");
  });

  test("with a good secret the word is not in any answer", async () => {
    const h = await startOidcHarness();
    const res = await h.call("GET", "/admin/oidc/keys", { key: OWNER_KEY });
    expect(res.status).toBe(200);
    expect(res.text).not.toContain("oidc_secret");
  });
});

describe("the accessor is the one reader", () => {
  test("oidcSecret returns the value only when it is valid; otherwise null, never the bad value", () => {
    for (const [, value] of BAD_OIDC_SECRETS) {
      expect(oidcSecret({ OIDC_SECRET: value as string })).toBeNull();
      expect(oidcEnabled({ OIDC_SECRET: value as string })).toBe(false);
      expect(isOidcSecret(value)).toBe(false);
    }
    for (const [, value] of GOOD_OIDC_SECRETS) {
      expect(oidcSecret({ OIDC_SECRET: value })).toBe(value);
      expect(oidcEnabled({ OIDC_SECRET: value })).toBe(true);
      expect(oidcSecretStatus({ OIDC_SECRET: value })).toBe("ok");
    }
  });

  test("the prefix is nmsso- and nothing else", () => {
    expect(OIDC_SECRET_PREFIX).toBe("nmsso-");
    expect(fakeOidcSecret("x").startsWith(OIDC_SECRET_PREFIX)).toBe(true);
  });
});

describe("a signing key made under a good secret cannot be used under a bad one", () => {
  test("signing refuses with a bad value, and the stored key is untouched", async () => {
    const h = await startOidcHarness();
    await rotateKeys(h);
    const before = h.db.query("SELECT private_jwk_encrypted FROM oidc_signing_keys").all();
    for (const [what, value] of BAD_OIDC_SECRETS) {
      const env = { ...h.env, OIDC_SECRET: value } as unknown as Bindings;
      await expect(signJwt(env, { sub: "x" }), what).rejects.toThrow(/OIDC_SECRET/);
    }
    expect(h.db.query("SELECT private_jwk_encrypted FROM oidc_signing_keys").all()).toEqual(before);
    // And the good one still signs.
    const ok = await signJwt(h.env, { sub: "x" });
    expect(ok.split(".")).toHaveLength(3);
  });

  test("another VALID secret cannot read the key either (existing behavior, unchanged)", async () => {
    const h = await startOidcHarness();
    await rotateKeys(h);
    const other = { ...h.env, OIDC_SECRET: fakeOidcSecret("a-second-valid-secret") } as Bindings;
    await expect(signJwt(other, { sub: "x" })).rejects.toThrow();
  });
});

describe("the authorization service itself never signs a cookie or token with a bad secret", () => {
  async function consentRequest(h: OidcHarness) {
    const client = await registerClient(h, { first_party: false });
    const cookie = await sessionCookie(h, seedAccount(h));
    const sessionId = (
      h.db.query("SELECT id FROM web_sessions ORDER BY id DESC LIMIT 1").get() as { id: number }
    ).id;
    const request = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: client.redirect,
      response_type: "code",
      scope: "openid profile",
      state: "s-1",
      code_challenge: RFC_CHALLENGE,
      code_challenge_method: "S256",
      nonce: "n-0S6_WzA2Mj",
    }).toString();
    return { request, sessionId, cookie };
  }

  test("with the right secret a consent screen carries a consent token (the control)", async () => {
    const h = await startOidcHarness({ HOST_PREFIXED_SESSION_COOKIE: "1" });
    const { request, sessionId } = await consentRequest(h);
    const answer = await checkAuthorization(h.env, request, sessionId);
    expect(answer, JSON.stringify(answer)).toMatchObject({ kind: "consent" });
  });

  test("with any bad value the same call refuses before a consent token is minted", async () => {
    const h = await startOidcHarness({ HOST_PREFIXED_SESSION_COOKIE: "1" });
    const { request, sessionId } = await consentRequest(h);
    for (const [what, value] of BAD_OIDC_SECRETS) {
      const env = { ...h.env, OIDC_SECRET: value } as unknown as Bindings;
      await expect(checkAuthorization(env, request, sessionId), what).rejects.toThrow(
        /OIDC_SECRET/,
      );
      await expect(decideConsent(env, request, "x.y", "allow", sessionId), what).rejects.toThrow(
        /OIDC_SECRET/,
      );
    }
  });
});

describe("the accessor hands back the stored bytes, never an altered copy", () => {
  // What was encrypted before this rule used the raw binding string as the key. The accessor must
  // return that same string for a valid value (so every stored key stays readable) and null, never a
  // trimmed or case-folded copy, for a value that is not exactly it.
  test("a blob encrypted under the raw secret decrypts under oidcSecret(env)", async () => {
    const raw = fakeOidcSecret("old-path-blob");
    const blob = await encrypt("private-key-material", raw);
    const key = oidcSecret({ OIDC_SECRET: raw });
    expect(key).toBe(raw);
    expect(await decrypt(blob, key as string)).toBe("private-key-material");
  });

  test.each([
    ["a leading space", (v: string) => ` ${v}`],
    ["a trailing newline", (v: string) => `${v}\n`],
    ["a trailing CRLF", (v: string) => `${v}\r\n`],
    ["a trailing NUL", (v: string) => `${v}\0`],
    ["an uppercase body", (v: string) => v.toUpperCase()],
    ["an uppercase prefix", (v: string) => `NMSSO-${v.slice(OIDC_SECRET_PREFIX.length)}`],
  ])("the same secret with %s is rejected, not repaired", async (_what, spoil) => {
    const raw = fakeOidcSecret("old-path-blob");
    const blob = await encrypt("private-key-material", raw);
    const spoiled = spoil(raw);
    expect(spoiled).not.toBe(raw);
    expect(oidcSecret({ OIDC_SECRET: spoiled })).toBeNull();
    expect(oidcEnabled({ OIDC_SECRET: spoiled })).toBe(false);
    // And a repaired copy would not have been the same key anyway.
    await expect(decrypt(blob, spoiled)).rejects.toBeInstanceOf(EncryptionError);
  });
});
