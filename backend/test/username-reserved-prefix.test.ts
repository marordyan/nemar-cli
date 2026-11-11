/**
 * The reserved username prefix (epic #2014 phase #2015; ADR 0119, decision 5).
 *
 * `nmu_` begins every OpenID Connect subject, so no username may begin with it: a person, a
 * service and a pipeline all choose their names, and a subject is the one name nobody chooses.
 * Every place a username is accepted is covered through its real route: the self-service profile
 * edit, an owner's edit, and the availability check; the automatic default can never reach the
 * prefix because folding a name to ASCII drops underscores.
 *
 * Real engine: bun:sqlite behind realD1 with every migration applied, the real routers behind
 * their real auth middleware.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { PROFILE_EDIT_ERROR_CODES } from "../../shared/contract/user.js";
import { adminRoutes } from "../src/routes/admin";
import { authRoutes } from "../src/routes/auth";
import { authWebRoutes } from "../src/routes/auth-web";
import { hashApiKey } from "../src/services/token";
import { suggestUsername, validateUsernameFormat } from "../src/services/username";
import { issueSession } from "../src/services/web-session";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const OWNER_KEY = "reserved-owner-key-0123456789abcdef0123456789a";
const APP = "https://app.nemar.org";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let personId: number;
let personCookie: string;

function env(): Bindings {
  return { DB: realD1(db), ENVIRONMENT: "test" } as unknown as Bindings;
}

async function seed(username: string, role: string, apiKey: string | null): Promise<number> {
  db.query(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified, service_access,
                        given_name, family_name)
     VALUES (?, ?, 'x', 'verified', ?, 1, 0, 'Ada', 'Lovelace')`,
  ).run(username, `${username}@example.org`, role);
  const row = db
    .query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?")
    .get(username);
  if (!row) throw new Error("seed: insert failed");
  if (apiKey) {
    db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
      row.id,
      await hashApiKey(apiKey),
      apiKey.slice(0, 8),
    );
  }
  return row.id;
}

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  app.route("/auth", authWebRoutes);
  app.route("/auth", authRoutes);
  await seed("reservedowner", "owner", OWNER_KEY);
  personId = await seed("reservedperson", "member", null);
  const { cookieIdRaw } = await issueSession(env(), personId, false, null, null, "orcid");
  personCookie = `nemar_session=${cookieIdRaw}`;
});

function bearer(key: string): Record<string, string> {
  return { Authorization: `Bearer ${key}` };
}

describe("the reserved username prefix", () => {
  test("validateUsernameFormat refuses a leading nmu_ in any case, and nothing near it", () => {
    for (const reserved of ["nmu_abc", "NMU_ABC", "Nmu_abc", "nmu_", "nmu_0123456789abcdef"]) {
      expect(validateUsernameFormat(reserved)?.error, reserved).toBe("username_reserved");
    }
    for (const fine of [
      "nemar_x",
      "nmu-abc",
      "xnmu_abc",
      "nmu",
      "nmuabc",
      "n_mu_abc",
      "nm_u_abc",
    ]) {
      expect(validateUsernameFormat(fine), fine).toBeNull();
    }
  });

  test("the format rules still come first, so each refusal names the rule it broke", () => {
    expect(validateUsernameFormat("nm")?.error).toBe("username_too_short");
    expect(validateUsernameFormat(`nmu_${"x".repeat(27)}`)?.error).toBe("username_too_long");
    expect(validateUsernameFormat("nmu_ab cd")?.error).toBe("username_charset");
  });

  test("the sentence says what is reserved and why", () => {
    const refusal = validateUsernameFormat("nmu_abc");
    expect(refusal?.message).toContain("nmu_");
  });

  test("the code is in the vocabulary the CLI prints messages for", () => {
    // Without it the CLI would print the bare word `username_reserved` at a person.
    expect(PROFILE_EDIT_ERROR_CODES).toContain("username_reserved");
  });

  test("the default username can never be a reserved one", () => {
    // `asciiFold` removes underscores, so no name folds to a leading `nmu_`: the automatic path
    // needs no check of its own. Pinned so that changing the fold cannot silently open it.
    for (const [given, family] of [
      ["N", "mu_abc"],
      ["N", "mu"],
      ["Nmu", "_abc"],
      ["nmu_", "abc"],
    ] as const) {
      const suggested = suggestUsername(given, family);
      expect(suggested?.toLowerCase().startsWith("nmu_") ?? false).toBe(false);
    }
  });

  test("PATCH /auth/profile refuses it with the code, and leaves the account as it was", async () => {
    const res = await app.request(
      "/auth/profile",
      {
        method: "PATCH",
        headers: { Origin: APP, Cookie: personCookie, "content-type": "application/json" },
        body: JSON.stringify({ username: "nmu_abc" }),
      },
      env(),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("username_reserved");
    expect(
      db
        .query<{ username: string }, [number]>("SELECT username FROM users WHERE id = ?")
        .get(personId)?.username,
    ).toBe("reservedperson");

    const ok = await app.request(
      "/auth/profile",
      {
        method: "PATCH",
        headers: { Origin: APP, Cookie: personCookie, "content-type": "application/json" },
        body: JSON.stringify({ username: "nemar_x" }),
      },
      env(),
    );
    // Whatever else the route decides about a rename, the reserved rule did not stop this one.
    expect(((await ok.json()) as { error?: string }).error).not.toBe("username_reserved");
  });

  test("an owner's edit of a username is refused by the same rule", async () => {
    const res = await app.request(
      `/admin/users/by-id/${personId}`,
      {
        method: "PATCH",
        headers: { ...bearer(OWNER_KEY), "content-type": "application/json" },
        body: JSON.stringify({ username: "nmu_abc" }),
      },
      env(),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("username_reserved");
  });

  test("GET /auth/check-username says a reserved name is not available", async () => {
    const reserved = await app.request("/auth/check-username?username=nmu_abc", {}, env());
    const body = (await reserved.json()) as { available: boolean; reason?: string };
    expect(body.available).toBe(false);
    expect(body.reason).toContain("nmu_");
    const fine = await app.request("/auth/check-username?username=nemar_x", {}, env());
    expect(((await fine.json()) as { available: boolean }).available).toBe(true);
  });
});
