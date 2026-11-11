/**
 * The OpenID Connect subject is on no existing response, and the one route that resolves it is
 * owner-only (epic #2014 phase #2015; ADR 0119, decision 5). The reserved username prefix that
 * keeps a username from being mistaken for one is `username-reserved-prefix.test.ts`.
 *
 * Real engine throughout: bun:sqlite behind realD1 with every migration applied (so the subject
 * is the one migration 0120 and its insert trigger gave the row, not a value this file invented),
 * the real routers behind their real auth middleware, hashed tokens and a real session cookie.
 *
 * "In no body" is asserted on the RAW response text, not on the keys a schema lists: a field
 * added to a response tomorrow, under any name, still contains the value, and this fails on it.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { isOidcSubject } from "../../shared/oidc-subject";
import { tombstoneUserCascade } from "../src/db/user-tombstone";
import { adminRoutes } from "../src/routes/admin";
import { authWebRoutes } from "../src/routes/auth-web";
import { userRoutes } from "../src/routes/users";
import { userIdForOidcSubject } from "../src/services/oidc-subject";
import { hashApiKey } from "../src/services/token";
import { issueSession } from "../src/services/web-session";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const OWNER_KEY = "subject-owner-key-0123456789abcdef0123456789ab";
const ADMIN_KEY = "subject-admin-key-0123456789abcdef0123456789ab";
const PERSON_KEY = "subject-person-key-0123456789abcdef0123456789";
const APP = "https://app.nemar.org";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let personId: number;
let personCookie: string;
let personSubject: string;

function env(): Bindings {
  return { DB: realD1(db), ENVIRONMENT: "test" } as unknown as Bindings;
}

async function seed(
  username: string,
  role: string,
  apiKey: string,
  extra: { orcid?: string } = {},
): Promise<number> {
  db.query(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified, service_access,
                        given_name, family_name, orcid, orcid_verified)
     VALUES (?, ?, 'x', 'approved', ?, 1, 1, 'Ada', 'Lovelace', ?, ?)`,
  ).run(username, `${username}@example.org`, role, extra.orcid ?? null, extra.orcid ? 1 : 0);
  const row = db
    .query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?")
    .get(username);
  if (!row) throw new Error("seed: insert failed");
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    row.id,
    await hashApiKey(apiKey),
    apiKey.slice(0, 8),
  );
  return row.id;
}

function subjectOf(id: number): string {
  const row = db
    .query<{ s: string | null }, [number]>("SELECT oidc_subject AS s FROM users WHERE id = ?")
    .get(id);
  if (!row?.s) throw new Error(`user ${id} has no subject: migration 0120 did not run`);
  return row.s;
}

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  app.route("/users", userRoutes);
  app.route("/auth", authWebRoutes);
  await seed("subjectowner", "owner", OWNER_KEY);
  await seed("subjectadmin", "admin", ADMIN_KEY);
  personId = await seed("subjectperson", "member", PERSON_KEY, { orcid: "0000-0002-1825-0097" });
  const { cookieIdRaw } = await issueSession(env(), personId, false, null, null, "orcid");
  personCookie = `nemar_session=${cookieIdRaw}`;
  personSubject = subjectOf(personId);
});

function bearer(key: string): Record<string, string> {
  return { Authorization: `Bearer ${key}` };
}

describe("the subject is in no response that already existed", () => {
  test("the subject under test is a real one, from the migration's trigger", () => {
    // Guards a vacuous pass: every assertion below is "this text does not contain the subject".
    expect(isOidcSubject(personSubject)).toBe(true);
  });

  /** Every existing surface that reads an account, as the person or an admin would. */
  const SURFACES: Array<{ name: string; call: () => Promise<Response> }> = [
    {
      name: "GET /users/me (the CLI's account view)",
      call: () => app.request("/users/me", { headers: bearer(PERSON_KEY) }, env()),
    },
    {
      name: "GET /auth/me (the dashboard's account view)",
      call: () => app.request("/auth/me", { headers: { Cookie: personCookie } }, env()),
    },
    {
      name: "GET /admin/users/by-id/:id (the admin detail)",
      call: () =>
        app.request(`/admin/users/by-id/${personId}`, { headers: bearer(ADMIN_KEY) }, env()),
    },
    {
      name: "GET /admin/users/:username (the older detail)",
      call: () => app.request("/admin/users/subjectperson", { headers: bearer(ADMIN_KEY) }, env()),
    },
    {
      name: "GET /admin/users (the listing)",
      call: () => app.request("/admin/users", { headers: bearer(ADMIN_KEY) }, env()),
    },
    {
      name: "GET /admin/users?include_deleted=true",
      call: () =>
        app.request("/admin/users?include_deleted=true", { headers: bearer(ADMIN_KEY) }, env()),
    },
  ];

  for (const { name, call } of SURFACES) {
    test(`${name} carries neither the value nor the column`, async () => {
      const res = await call();
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("subjectperson"); // the response did describe this account
      expect(text).not.toContain(personSubject);
      expect(text).not.toContain("oidc_subject");
      expect(text).not.toContain("nmu_");
    });
  }

  test("searching for the subject, whole or in part, finds no account", async () => {
    // A searched column is an oracle: an admin could recover a value prefix by prefix.
    for (const q of [personSubject, personSubject.slice(0, 12), "nmu_"]) {
      const res = await app.request(
        `/admin/users?q=${encodeURIComponent(q)}`,
        { headers: bearer(ADMIN_KEY) },
        env(),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { users: Array<{ username: string | null }> };
      expect(body.users.map((u) => u.username)).not.toContain("subjectperson");
    }
  });

  test("an admin's edit response does not carry it either", async () => {
    const res = await app.request(
      `/admin/users/by-id/${personId}`,
      {
        method: "PATCH",
        headers: { ...bearer(OWNER_KEY), "content-type": "application/json" },
        body: JSON.stringify({ city: "Cambridge" }),
      },
      env(),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(personSubject);
    expect(text).not.toContain("oidc_subject");
  });
});

describe("GET /admin/users/by-oidc-subject/:sub", () => {
  function lookup(sub: string, key: string | null): Promise<Response> {
    return Promise.resolve(
      app.request(
        `/admin/users/by-oidc-subject/${sub}`,
        { headers: key ? bearer(key) : {} },
        env(),
      ),
    );
  }

  test("an owner resolves a subject to the account that holds it", async () => {
    const res = await lookup(personSubject, OWNER_KEY);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user_id: personId, deleted: false });
  });

  test("an admin who is not an owner is refused", async () => {
    const res = await lookup(personSubject, ADMIN_KEY);
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain(String(personId));
  });

  test("a member and an unauthenticated caller are refused", async () => {
    expect((await lookup(personSubject, PERSON_KEY)).status).toBe(403);
    expect((await lookup(personSubject, null)).status).toBe(401);
  });

  test("a session cookie reaches it too (a read, so no Origin is asked for)", async () => {
    // The owner's own cookie: same gate as the key.
    const ownerId = db
      .query<{ id: number }, []>("SELECT id FROM users WHERE username = 'subjectowner'")
      .get()?.id as number;
    const { cookieIdRaw } = await issueSession(env(), ownerId, false, null, null, "orcid");
    const res = await app.request(
      `/admin/users/by-oidc-subject/${personSubject}`,
      { headers: { Cookie: `nemar_session=${cookieIdRaw}`, Origin: APP } },
      env(),
    );
    expect(res.status).toBe(200);
  });

  test("a value that is not a subject is 400 and a subject nobody holds is 404", async () => {
    for (const bad of ["nmu_short", personSubject.toUpperCase(), "not-a-subject", "42"]) {
      const res = await lookup(bad, OWNER_KEY);
      expect(res.status, bad).toBe(400);
      expect(((await res.json()) as { error: string }).error, bad).toBe("invalid_subject");
    }
    const unheld = `nmu_${"0".repeat(32)}`;
    expect((await lookup(unheld, OWNER_KEY)).status).toBe(404);
  });

  test("a deleted account's subject still resolves, and says it is deleted", async () => {
    // The tombstone keeps the subject, so a partner that kept a `sub` can still be told which
    // account it was, and the subject is never handed to anyone else.
    const email = db
      .query<{ email: string }, [number]>("SELECT email FROM users WHERE id = ?")
      .get(personId)?.email as string;
    await tombstoneUserCascade(realD1(db), personId, email);
    const res = await lookup(personSubject, OWNER_KEY);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user_id: personId, deleted: true });
  });

  test("the service answers the same way for the same inputs", async () => {
    expect(await userIdForOidcSubject(realD1(db), personSubject)).toBe(personId);
    expect(await userIdForOidcSubject(realD1(db), `nmu_${"0".repeat(32)}`)).toBeNull();
    // A string that is not a subject finds nothing, however it is shaped.
    expect(await userIdForOidcSubject(realD1(db), "' OR 1=1 --")).toBeNull();
  });
});
