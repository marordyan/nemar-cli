/**
 * The owner routes of the OpenID Connect provider (epic #2014 phase #2016; ADR 0119, decision 8):
 * who may call them, where they exist, and the key routes' own behaviour over HTTP. The client
 * routes' behaviour is `oidc-clients.test.ts`; the rotation state machine is `oidc-keys.test.ts`.
 *
 * "Every route" is read from the admin router's own table, not from a list typed here: a route
 * added under `/oidc/` tomorrow is held to the same rules by this file, and a handler that loses
 * its owner check fails by name. The table is also pinned, so a walk that found nothing could not
 * pass.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import {
  oidcKeyRevokeResponseSchema,
  oidcKeysResponseSchema,
  oidcKeysRotateResponseSchema,
} from "../../shared/contract/oidc-admin";
import { notFoundBody } from "../src/lib/not-found";
import { adminRoutes } from "../src/routes/admin";
import {
  ADMIN_KEY,
  MEMBER_KEY,
  OWNER_KEY,
  type OidcHarness,
  startOidcHarness,
} from "./helpers/oidc-harness";
import { BAD_OIDC_SECRETS, fakeOidcSecret } from "./helpers/oidc-secret";

let h: OidcHarness;

beforeEach(async () => {
  h = await startOidcHarness();
});

const CLIENT_ID = "oc_0123456789abcdef01234567";
const KID = "0123456789abcdef";
const USER_ID = "7";

/** Every OIDC owner route the admin router has, as `[method, path with params filled in]`. */
function oidcRoutes(): Array<[string, string]> {
  return adminRoutes.routes
    .filter((r) => r.path.startsWith("/oidc/") && r.method !== "ALL")
    .map(
      (r) =>
        [
          r.method,
          `/admin${r.path.replace(":client_id", CLIENT_ID).replace(":kid", KID).replace(":id", USER_ID)}`,
        ] as [string, string],
    )
    .filter(([m, p], i, all) => all.findIndex(([m2, p2]) => m2 === m && p2 === p) === i);
}

describe("the owner routes the admin router has", () => {
  test("are exactly the ten of phases #2016 and #2019", () => {
    expect(oidcRoutes().sort()).toEqual(
      [
        ["GET", "/admin/oidc/clients"],
        ["POST", "/admin/oidc/clients"],
        ["GET", `/admin/oidc/clients/${CLIENT_ID}`],
        ["POST", `/admin/oidc/clients/${CLIENT_ID}/rotate-secret`],
        ["POST", `/admin/oidc/clients/${CLIENT_ID}/disable`],
        ["GET", "/admin/oidc/keys"],
        ["POST", "/admin/oidc/keys/rotate"],
        ["POST", `/admin/oidc/keys/${KID}/revoke`],
        ["POST", `/admin/oidc/accounts/${USER_ID}/end`],
        ["GET", "/admin/oidc/logout-deliveries"],
      ].sort(),
    );
  });
});

describe("who may call them", () => {
  test("nobody who is not signed in: 401, and nothing is written", async () => {
    for (const [method, path] of oidcRoutes()) {
      const res = await h.call(method, path, { body: method === "POST" ? {} : undefined });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
    expect(h.db.query("SELECT COUNT(*) AS n FROM oidc_clients").get()).toEqual({ n: 0 });
    expect(h.db.query("SELECT COUNT(*) AS n FROM oidc_signing_keys").get()).toEqual({ n: 0 });
  });

  test("not a made-up key: 401", async () => {
    for (const [method, path] of oidcRoutes()) {
      const res = await h.call(method, path, {
        key: "nm_not-a-real-key-0123456789abcdef0123456789abcdef",
        body: method === "POST" ? {} : undefined,
      });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  test("not an administrator who is not the owner: 403", async () => {
    for (const [method, path] of oidcRoutes()) {
      const res = await h.call(method, path, {
        key: ADMIN_KEY,
        body: method === "POST" ? {} : undefined,
      });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.json?.error).toBe("Owner access required");
    }
    expect(h.db.query("SELECT COUNT(*) AS n FROM oidc_clients").get()).toEqual({ n: 0 });
    expect(h.db.query("SELECT COUNT(*) AS n FROM oidc_signing_keys").get()).toEqual({ n: 0 });
  });

  test("not a member: 403", async () => {
    for (const [method, path] of oidcRoutes()) {
      const res = await h.call(method, path, {
        key: MEMBER_KEY,
        body: method === "POST" ? {} : undefined,
      });
      expect(res.status, `${method} ${path}`).toBe(403);
    }
  });

  test("the owner is let through every one of them", async () => {
    for (const [method, path] of oidcRoutes()) {
      const res = await h.call(method, path, {
        key: OWNER_KEY,
        body: method === "POST" ? {} : undefined,
      });
      // A refusal of the request's own content, or a missing client, but never of the caller.
      expect([401, 403], `${method} ${path}`).not.toContain(res.status);
      expect(res.status, `${method} ${path}`).not.toBe(500);
    }
  });
});

describe("where they exist", () => {
  const KEYS = "/admin/oidc/keys";

  test("on the issuer's host and nowhere else", async () => {
    expect((await h.call("GET", KEYS, { key: OWNER_KEY })).status).toBe(200);
    for (const base of [
      "https://data.nemar.org",
      "https://api-test.nemar.org",
      "https://nemar-api-dev.sccn-org.workers.dev",
      "https://app.nemar.org",
      "https://api.nemar.org.evil.example",
    ]) {
      const res = await h.call("GET", KEYS, { key: OWNER_KEY, base });
      expect(res.status, base).toBe(404);
    }
  });

  test("not under the legacy /nemar mount, for any of them", async () => {
    for (const [method, path] of oidcRoutes()) {
      const res = await h.call(method, `/nemar${path}`, {
        key: OWNER_KEY,
        body: method === "POST" ? {} : undefined,
      });
      expect(res.status, `${method} /nemar${path}`).toBe(404);
    }
    expect(h.db.query("SELECT COUNT(*) AS n FROM oidc_signing_keys").get()).toEqual({ n: 0 });
  });

  test("not under the legacy /nemar mount spelled with percent-encoding, for any of them", async () => {
    // A router decodes the path before it matches, so `/%6eemar/...` reaches the same handlers.
    for (const mount of ["%6eemar", "%6Eemar", "n%65mar", "%256eemar"]) {
      for (const [method, path] of oidcRoutes()) {
        const res = await h.call(method, `/${mount}${path}`, {
          key: OWNER_KEY,
          body: method === "POST" ? {} : undefined,
        });
        expect(res.status, `${method} /${mount}${path}`).toBe(404);
      }
    }
    expect(h.db.query("SELECT COUNT(*) AS n FROM oidc_signing_keys").get()).toEqual({ n: 0 });
    expect(h.db.query("SELECT COUNT(*) AS n FROM oidc_clients").get()).toEqual({ n: 0 });
  });

  test("the router's decoded path is the one that decides: spellings a plain string test misses", async () => {
    const SPELLINGS: Array<[string, string]> = [
      ["GET", `/admin/oidc/clients/${CLIENT_ID}%ff`],
      ["POST", `/admin/oidc/clients/${CLIENT_ID}%ff/rotate-secret`],
      ["POST", `/admin/oidc/clients/${CLIENT_ID}%ff/disable`],
      ["POST", `/admin/oidc/keys/${KID}%ff/revoke`],
    ];
    for (const mount of ["%6eemar", "%6Eemar", "n%65mar"]) {
      for (const [method, path] of SPELLINGS) {
        const res = await h.call(method, `/${mount}${path}`, {
          key: OWNER_KEY,
          body: method === "POST" ? {} : undefined,
        });
        expect(res.status, `${method} /${mount}${path}`).toBe(404);
      }
    }
    expect(h.db.query("SELECT COUNT(*) AS n FROM oidc_signing_keys").get()).toEqual({ n: 0 });
    expect(h.db.query("SELECT COUNT(*) AS n FROM oidc_clients").get()).toEqual({ n: 0 });
    expect(
      h.db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'oidc.%'").get(),
    ).toEqual({
      n: 0,
    });
  });

  test("not with the provider off: no secret, or one not in the nmsso- form, is 404 to the owner for every route", async () => {
    for (const [, secret] of BAD_OIDC_SECRETS) {
      for (const [method, path] of oidcRoutes()) {
        const res = await h.call(method, path, {
          key: OWNER_KEY,
          body: method === "POST" ? {} : undefined,
          env: { OIDC_SECRET: secret as string },
        });
        expect(res.status, `${method} ${path} with ${JSON.stringify(secret)}`).toBe(404);
      }
    }
    expect(h.db.query("SELECT COUNT(*) AS n FROM oidc_clients").get()).toEqual({ n: 0 });
    expect(h.db.query("SELECT COUNT(*) AS n FROM oidc_signing_keys").get()).toEqual({ n: 0 });
  });

  test("with the provider off a caller who is not the owner is still told what they are, not that it is absent", async () => {
    const anon = await h.call("GET", KEYS, { env: { OIDC_SECRET: undefined } });
    expect(anon.status).toBe(401);
    const admin = await h.call("GET", KEYS, { key: ADMIN_KEY, env: { OIDC_SECRET: undefined } });
    expect(admin.status).toBe(403);
  });

  test("the refusal is the API's own unrouted 404, plus the owner's word for the secret", async () => {
    const off = await h.call("GET", KEYS, { key: OWNER_KEY, env: { OIDC_SECRET: undefined } });
    expect(off.json).toEqual({ ...notFoundBody("GET", KEYS), oidc_secret: "unset" });
    expect(off.headers.get("Cache-Control")).toBe("no-store");
    const elsewhere = await h.call("GET", KEYS, { key: OWNER_KEY, base: "https://data.nemar.org" });
    expect(elsewhere.status).toBe(404);
  });
});

describe("the signing keys, over HTTP", () => {
  const list = () => h.call("GET", "/admin/oidc/keys", { key: OWNER_KEY });
  const rotate = (body?: unknown) =>
    h.call("POST", "/admin/oidc/keys/rotate", { key: OWNER_KEY, body });

  test("an empty table lists no key", async () => {
    const res = await list();
    expect(res.status).toBe(200);
    expect(oidcKeysResponseSchema.parse(res.json).keys).toEqual([]);
  });

  test("the first rotation makes a current and a next key", async () => {
    const res = await rotate();
    expect(res.status, res.text).toBe(200);
    const body = oidcKeysRotateResponseSchema.parse(res.json);
    expect(body.action).toBe("bootstrapped");
    expect(body.keys.map((k) => k.state).sort()).toEqual(["current", "next"]);
    const listed = oidcKeysResponseSchema.parse((await list()).json);
    expect(listed.keys.map((k) => k.kid).sort()).toEqual(body.keys.map((k) => k.kid).sort());
  });

  test("a second rotation inside 24 hours is 409 with the time it may happen, and --force is 200", async () => {
    await rotate();
    const early = await rotate();
    expect(early.status).toBe(409);
    expect(early.json?.code).toBe("rotation_too_early");
    expect(typeof early.json?.promotable_at).toBe("string");
    const forced = await rotate({ force: true, emergency: true });
    expect(forced.status, forced.text).toBe(200);
    expect(forced.json?.action).toBe("rotated");
    expect(
      (oidcKeysResponseSchema.parse((await list()).json).keys as Array<{ state: string }>).map(
        (k) => k.state,
      ),
    ).toEqual(["current", "next", "retired"]);
  });

  test("a next key that is 24 hours old rotates without force", async () => {
    await rotate();
    h.db.run(
      "UPDATE oidc_signing_keys SET created_at = datetime('now', '-25 hours') WHERE state = 'next'",
    );
    const res = await rotate();
    expect(res.status, res.text).toBe(200);
  });

  test("no response holds a private member, a ciphertext, or the secret", async () => {
    await rotate();
    await rotate({ force: true, emergency: true });
    const rows = h.db
      .query<{ private_jwk_encrypted: string }, []>(
        "SELECT private_jwk_encrypted FROM oidc_signing_keys",
      )
      .all();
    expect(rows.length).toBe(3);
    const texts = [(await list()).text, (await rotate({ force: true, emergency: true })).text];
    for (const text of texts) {
      for (const r of rows) expect(text).not.toContain(r.private_jwk_encrypted);
      expect(text).not.toContain("private");
      expect(text).not.toContain('"d"');
      expect(text).not.toContain('"x"');
      expect(text).not.toContain("OIDC_SECRET");
      expect(text).not.toContain(h.env.OIDC_SECRET as string);
    }
  });

  test("a forced rotation of a key published a moment ago is 409 unless it is an emergency", async () => {
    await rotate();
    const refused = await rotate({ force: true });
    expect(refused.status).toBe(409);
    expect(refused.json?.code).toBe("rotation_next_too_new");
    expect(String(refused.json?.error)).toMatch(/emergency/i);
    expect(
      oidcKeysResponseSchema
        .parse((await list()).json)
        .keys.map((k) => k.state)
        .sort(),
    ).toEqual(["current", "next"]);
    expect((await rotate({ force: true, emergency: true })).status).toBe(200);
  });

  test("a rotation under another OIDC_SECRET is 409 key_unreadable and says which secret was used", async () => {
    await rotate();
    h.db.run(
      "UPDATE oidc_signing_keys SET created_at = datetime('now', '-25 hours') WHERE state = 'next'",
    );
    const other = fakeOidcSecret("another-oidc-secret");
    const res = await h.call("POST", "/admin/oidc/keys/rotate", {
      key: OWNER_KEY,
      body: {},
      env: { OIDC_SECRET: other },
    });
    expect(res.status).toBe(409);
    expect(res.json?.code).toBe("key_unreadable");
    expect(String(res.json?.error)).toMatch(/different OIDC_SECRET/);
    expect(res.text).not.toContain(other);
    expect((await list()).json).toMatchObject({ keys: [{ state: "current" }, { state: "next" }] });
  });

  test("a body that is not {force: boolean, emergency: boolean} is refused and changes nothing", async () => {
    for (const body of [
      { force: "yes" },
      { force: 1 },
      { emergency: "yes" },
      { forced: true },
      [],
      "force",
    ]) {
      const res = await rotate(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.json?.code).toBe("invalid_body");
    }
    expect(h.db.query("SELECT COUNT(*) AS n FROM oidc_signing_keys").get()).toEqual({ n: 0 });
  });

  test("a rotation is in the audit trail by who made it and whether it was forced", async () => {
    await rotate();
    await rotate({ force: true, emergency: true });
    const rows = h.db
      .query<{ user_id: number; details: string }, []>(
        "SELECT user_id, details FROM audit_log WHERE action = 'oidc.keys.rotate' ORDER BY id",
      )
      .all();
    expect(rows.map((r) => r.user_id)).toEqual([h.ids.owner, h.ids.owner]);
    expect(rows.map((r) => JSON.parse(r.details).forced)).toEqual([false, true]);
  });
});

describe("revoking a signing key, over HTTP", () => {
  const rotate = (body?: unknown) =>
    h.call("POST", "/admin/oidc/keys/rotate", { key: OWNER_KEY, body });
  const revoke = (kid: string) =>
    h.call("POST", `/admin/oidc/keys/${kid}/revoke`, { key: OWNER_KEY });
  const kidOf = (state: string): string =>
    (h.db.query("SELECT kid FROM oidc_signing_keys WHERE state = ?").get(state) as { kid: string })
      .kid;

  test("a retired key is revoked, and stops being published at once", async () => {
    await rotate();
    const first = kidOf("current");
    await rotate({ force: true, emergency: true });
    await rotate({ force: true, emergency: true });
    const before = (await h.call("GET", "/oauth/jwks")).json as { keys: Array<{ kid: string }> };
    expect(before.keys.map((k) => k.kid)).toContain(first);
    const res = await revoke(first);
    expect(res.status, res.text).toBe(200);
    const body = oidcKeyRevokeResponseSchema.parse(res.json);
    expect(body.changed).toBe(true);
    expect(body.key.state).toBe("revoked");
    expect(typeof body.key.revoked_at).toBe("string");
    const after = (await h.call("GET", "/oauth/jwks")).json as { keys: Array<{ kid: string }> };
    expect(after.keys.map((k) => k.kid)).not.toContain(first);
    // Twice is the same answer, with changed false.
    const again = await revoke(first);
    expect(again.status).toBe(200);
    expect(again.json?.changed).toBe(false);
  });

  test("the current and the next key are 409, an unknown key is 404, and a malformed id is 400", async () => {
    await rotate();
    for (const state of ["current", "next"]) {
      const res = await revoke(kidOf(state));
      expect(res.status, state).toBe(409);
      expect(res.json?.code).toBe("key_not_revocable");
      expect(String(res.json?.error)).toMatch(/rotate/i);
    }
    const missing = await revoke("00000000000000ff");
    expect(missing.status).toBe(404);
    expect(missing.json?.code).toBe("key_not_found");
    for (const bad of ["nope", "0123456789ABCDEF", "0123456789abcde", "0123456789abcdef0"]) {
      const res = await revoke(bad);
      expect(res.status, bad).toBe(400);
      expect(res.json?.code).toBe("invalid_kid");
    }
  });

  test("it is audited by who did it, and the answer holds no key material", async () => {
    await rotate();
    await rotate({ force: true, emergency: true });
    const retired = kidOf("retired");
    const res = await revoke(retired);
    const row = h.db
      .query("SELECT user_id, resource_id FROM audit_log WHERE action = 'oidc.keys.revoke'")
      .get();
    expect(row).toEqual({ user_id: h.ids.owner, resource_id: retired });
    const ciphertexts = h.db
      .query<{ private_jwk_encrypted: string }, []>(
        "SELECT private_jwk_encrypted FROM oidc_signing_keys",
      )
      .all();
    for (const c of ciphertexts) expect(res.text).not.toContain(c.private_jwk_encrypted);
    expect(res.text).not.toContain('"d"');
  });
});
