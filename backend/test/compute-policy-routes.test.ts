/**
 * The owner policy (epic #2005 phase A2, #2007; ADR 0118): `getPolicy` and `putPolicy`
 * (services/compute-policy.ts) and `GET` and `PUT /admin/compute/policy`, through the REAL admin
 * router and its middleware (`app.fetch`), against a real migrated database (bun:sqlite behind
 * `realD1`), with real API keys. No mocks.
 *
 * What is pinned:
 *  - no stored version means the default policy, flagged as the default; the highest version is the
 *    current one and every version stays;
 *  - the write path: owner only (an admin and a member are refused, by the route and by the service
 *    itself), validated by the strict schema (an invalid body is a 400 that names fields and never
 *    echoes a value), and audited in the same batch as the version (a write whose audit fails leaves
 *    no version);
 *  - the read path fails closed: a stored row the strict schema cannot parse is a 503
 *    `policy_unreadable`, never the default, and a later valid version makes it readable again.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { type ComputePolicy, DEFAULT_COMPUTE_POLICY } from "../../shared/contract/compute";
import { ComputePolicyUnreadable, getPolicy, putPolicy } from "../src/services/compute-policy";
import {
  COMPUTE_KEYS,
  type ComputeWho,
  computeEnv,
  makeComputeApp,
  seedComputeUsers,
} from "./helpers/compute-app";
import { freshDb, realD1 } from "./helpers/d1";

const MARK = "SECRET-MARKER-9731";

let db: Database;
let ids: Record<ComputeWho, number>;
const handle = makeComputeApp();

beforeEach(async () => {
  db = freshDb();
  ids = await seedComputeUsers(db);
});

async function call(who: ComputeWho | null, method: string, body?: unknown, raw?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (who) headers.Authorization = `Bearer ${COMPUTE_KEYS[who]}`;
  const res = await handle(
    new Request("http://api.test/admin/compute/policy", {
      method,
      headers,
      body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    }),
    computeEnv(db),
  );
  const text = await res.text();
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON; `text` is what the assertion reads.
  }
  return { status: res.status, body: json, text };
}

/** A valid policy that is not the default. */
function policy(over: Partial<ComputePolicy> = {}): ComputePolicy {
  return {
    ...structuredClone(DEFAULT_COMPUTE_POLICY),
    defaultGrantMilli: { cpu: 50000, gpu: 5000 },
    clients: { "partner-one": { maxOpenReservations: 3, maxReservedMilliPerDay: 100000 } },
    ...over,
  } as ComputePolicy;
}

const rows = (table: string) =>
  (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const audits = (action: string) =>
  db.query("SELECT * FROM audit_log WHERE action = ? ORDER BY id").all(action) as Array<{
    user_id: number | null;
    resource_type: string | null;
    resource_id: string | null;
    details: string | null;
  }>;

describe("getPolicy", () => {
  test("is the default, flagged as it, while no version has been set", async () => {
    const got = await getPolicy(realD1(db));
    expect(got).toEqual({
      version: null,
      is_default: true,
      policy: DEFAULT_COMPUTE_POLICY,
      set_by: null,
      note: null,
      created_at: null,
    });
  });

  test("is the highest version, and every version stays", async () => {
    const d1 = realD1(db);
    const a = await putPolicy(d1, ids.owner, policy(), "first");
    const b = await putPolicy(d1, ids.owner2, policy({ maxLiveJobsPerPerson: 9 }), null);
    expect([a, b]).toEqual([
      { ok: true, version: 1 },
      { ok: true, version: 2 },
    ]);
    const got = await getPolicy(d1);
    expect(got).toMatchObject({ version: 2, is_default: false, set_by: ids.owner2, note: null });
    expect(got.policy.maxLiveJobsPerPerson).toBe(9);
    expect(rows("compute_policy")).toBe(2);
    expect((await getPolicy(d1)).created_at).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  });

  test("fails closed on a stored row the strict schema cannot parse, and never falls back to the default", async () => {
    const d1 = realD1(db);
    await putPolicy(d1, ids.owner, policy(), null);
    // Valid JSON, an object, and not a policy: the stricter reader refuses it.
    db.run("INSERT INTO compute_policy (policy_json, set_by) VALUES (?, ?)", [
      '{"defaultGrantMilli":{"cpu":1}}',
      ids.owner,
    ]);
    await expect(getPolicy(d1)).rejects.toBeInstanceOf(ComputePolicyUnreadable);
    // A key the schema does not know is unreadable too, as strict as a write: the Worker that
    // writes a key must be the Worker that reads it, and a new key is added as optional.
    db.run("INSERT INTO compute_policy (policy_json, set_by) VALUES (?, ?)", [
      JSON.stringify({ ...policy(), futureKey: 1 }),
      ids.owner,
    ]);
    await expect(getPolicy(d1)).rejects.toBeInstanceOf(ComputePolicyUnreadable);
    // The next valid version makes it readable again.
    expect(await putPolicy(d1, ids.owner, policy({ maxLiveJobsPerPerson: 2 }), null)).toEqual({
      ok: true,
      version: 4,
    });
    expect((await getPolicy(d1)).policy.maxLiveJobsPerPerson).toBe(2);
  });
});

describe("putPolicy", () => {
  test("stores the validated policy, and the version and its audit row are one batch", async () => {
    const d1 = realD1(db);
    expect(await putPolicy(d1, ids.owner, policy(), "why")).toEqual({ ok: true, version: 1 });
    const stored = db.query("SELECT * FROM compute_policy").get() as {
      policy_json: string;
      set_by: number;
      note: string;
    };
    expect(JSON.parse(stored.policy_json)).toEqual(policy());
    expect([stored.set_by, stored.note]).toEqual([ids.owner, "why"]);
    const [audit] = audits("compute.policy.set");
    expect(audit).toMatchObject({
      user_id: ids.owner,
      resource_type: "compute_policy",
      resource_id: "1",
    });
    // The shape of the event, never the policy: no partner id, no figure.
    expect(JSON.parse(audit?.details ?? "{}")).toEqual({ version: 1 });
    expect(audit?.details).not.toContain("partner-one");
  });

  test("a write whose audit row cannot be written leaves no version", async () => {
    const d1 = realD1(db);
    db.run("DROP TABLE audit_log");
    await expect(putPolicy(d1, ids.owner, policy(), null)).rejects.toThrow();
    expect(rows("compute_policy")).toBe(0);
  });

  test("refuses anyone who is not an owner, by the service itself, and writes nothing", async () => {
    const d1 = realD1(db);
    // An earlier version and its audit row are there, so a refused write that wrote an audit row
    // about "the latest version" would be seen as one more.
    expect(await putPolicy(d1, ids.owner, policy(), null)).toEqual({ ok: true, version: 1 });
    for (const who of [ids.admin, ids.member, 99999]) {
      expect(await putPolicy(d1, who, policy(), null)).toEqual({ ok: false, code: "not_owner" });
    }
    expect(rows("compute_policy")).toBe(1);
    expect(audits("compute.policy.set")).toHaveLength(1);
  });

  test("an invalid policy leaves the audit rows alone too", async () => {
    const d1 = realD1(db);
    await putPolicy(d1, ids.owner, policy(), null);
    expect(await putPolicy(d1, ids.owner, { nope: 1 }, null)).toMatchObject({
      code: "invalid_policy",
    });
    expect(await putPolicy(d1, ids.owner, policy(), "")).toMatchObject({ code: "invalid_note" });
    expect(rows("compute_policy")).toBe(1);
    expect(audits("compute.policy.set")).toHaveLength(1);
  });

  test("refuses an owner account that was deleted or is not active, by the statement itself", async () => {
    const d1 = realD1(db);
    db.run("UPDATE users SET deleted_at = datetime('now') WHERE id = ?", [ids.owner]);
    expect(await putPolicy(d1, ids.owner, policy(), null)).toEqual({
      ok: false,
      code: "not_owner",
    });
    db.run("UPDATE users SET deleted_at = NULL WHERE id = ?", [ids.owner]);
    for (const status of ["pending", "revoked"]) {
      db.run("UPDATE users SET status = ?, email_verified = 0 WHERE id = ?", [status, ids.owner]);
      expect([status, await putPolicy(d1, ids.owner, policy(), null)]).toEqual([
        status,
        { ok: false, code: "not_owner" },
      ]);
    }
    expect(rows("compute_policy")).toBe(0);
    expect(rows("audit_log")).toBe(0);
    // Both active statuses write.
    for (const status of ["verified", "approved"]) {
      db.run("UPDATE users SET status = ?, email_verified = 1 WHERE id = ?", [status, ids.owner]);
      expect((await putPolicy(d1, ids.owner, policy(), null)).ok).toBe(true);
    }
  });

  test("names where a policy is wrong under a prefix when asked, and the same paths without one", async () => {
    const d1 = realD1(db);
    const bad = { ...policy(), defaultGrantMilli: { cpu: "x", gpu: -1 } };
    const plain = await putPolicy(d1, ids.owner, bad, null);
    const prefixed = await putPolicy(d1, ids.owner, bad, null, "policy");
    if (plain.ok || plain.code !== "invalid_policy") throw new Error("expected invalid_policy");
    if (prefixed.ok || prefixed.code !== "invalid_policy")
      throw new Error("expected invalid_policy");
    expect(plain.issues.map((i) => i.path)).toEqual([
      "defaultGrantMilli.cpu",
      "defaultGrantMilli.gpu",
    ]);
    expect(prefixed.issues.map((i) => i.path)).toEqual([
      "policy.defaultGrantMilli.cpu",
      "policy.defaultGrantMilli.gpu",
    ]);
    // A problem at the root of the policy is the prefix alone, and plain it is the empty path.
    const root = await putPolicy(d1, ids.owner, [], null, "policy");
    if (root.ok || root.code !== "invalid_policy") throw new Error("expected invalid_policy");
    expect(root.issues.map((i) => i.path)).toEqual(["policy"]);
  });

  test("refuses a policy the strict schema refuses, naming where and never what", async () => {
    const d1 = realD1(db);
    const bad = {
      ...policy(),
      defaultGrantMilli: { cpu: MARK, gpu: -1 },
      futureKey: MARK,
      registries: [MARK],
      clients: { [`bad ${MARK}`]: { maxOpenReservations: 1, maxReservedMilliPerDay: 1 } },
    };
    const r = await putPolicy(d1, ids.owner, bad, null);
    expect(r.ok).toBe(false);
    if (r.ok || r.code !== "invalid_policy") throw new Error("expected invalid_policy");
    const text = JSON.stringify(r);
    expect(text).not.toContain(MARK);
    const paths = r.issues.map((i) => i.path);
    expect(paths).toContain("defaultGrantMilli.cpu");
    expect(paths).toContain("defaultGrantMilli.gpu");
    expect(paths).toContain("registries.0");
    expect(rows("compute_policy")).toBe(0);
    expect(rows("audit_log")).toBe(0);
  });

  test("refuses what is not an object, and a policy over 64 KiB", async () => {
    const d1 = realD1(db);
    for (const bad of [null, undefined, "x", 1, [], [policy()]]) {
      const r = await putPolicy(d1, ids.owner, bad, null);
      expect(r).toMatchObject({ ok: false, code: "invalid_policy" });
    }
    const huge = policy({
      clients: Object.fromEntries(
        Array.from({ length: 2000 }, (_, i) => [
          `client-${"x".repeat(40)}-${i}`,
          { maxOpenReservations: 1, maxReservedMilliPerDay: 1 },
        ]),
      ),
    });
    expect(await putPolicy(d1, ids.owner, huge, null)).toMatchObject({
      ok: false,
      code: "invalid_policy",
    });
    expect(rows("compute_policy")).toBe(0);
  });

  test("refuses a note that is empty or over 500 characters", async () => {
    const d1 = realD1(db);
    for (const note of ["", "n".repeat(501)]) {
      expect(await putPolicy(d1, ids.owner, policy(), note)).toMatchObject({
        ok: false,
        code: "invalid_note",
      });
    }
    expect(rows("compute_policy")).toBe(0);
  });
});

describe("GET /admin/compute/policy", () => {
  test("is refused to anyone but an owner: no key, a member, an admin", async () => {
    expect((await call(null, "GET")).status).toBe(401);
    expect((await call("member", "GET")).status).toBe(403);
    const admin = await call("admin", "GET");
    expect(admin.status).toBe(403);
    expect(admin.body).toMatchObject({ code: "owner_only" });
    expect(typeof admin.body.error).toBe("string");
  });

  test("answers the default for an owner while none is set", async () => {
    const r = await call("owner", "GET");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      version: null,
      is_default: true,
      policy: JSON.parse(JSON.stringify(DEFAULT_COMPUTE_POLICY)),
      set_by: null,
      note: null,
      created_at: null,
    });
  });

  test("answers the current version", async () => {
    await putPolicy(realD1(db), ids.owner, policy(), "n1");
    await putPolicy(realD1(db), ids.owner, policy({ maxLiveJobsPerPerson: 7 }), "n2");
    const r = await call("owner", "GET");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ version: 2, is_default: false, set_by: ids.owner, note: "n2" });
    expect(r.body.policy.maxLiveJobsPerPerson).toBe(7);
  });

  test("is a 503 policy_unreadable, never the default, when the stored row cannot be read", async () => {
    db.run("INSERT INTO compute_policy (policy_json, set_by) VALUES ('{}', ?)", [ids.owner]);
    const r = await call("owner", "GET");
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ code: "policy_unreadable" });
    expect(r.text).not.toContain("defaultGrantMilli");
  });
});

describe("PUT /admin/compute/policy", () => {
  test("is refused to anyone but an owner, and writes nothing", async () => {
    const body = { policy: policy() };
    expect((await call(null, "PUT", body)).status).toBe(401);
    expect((await call("member", "PUT", body)).status).toBe(403);
    const admin = await call("admin", "PUT", body);
    expect([admin.status, admin.body.code]).toEqual([403, "owner_only"]);
    expect(rows("compute_policy")).toBe(0);
    expect(audits("compute.policy.set")).toEqual([]);
  });

  test("the route's owner gate answers before the body is read: an invalid or non-JSON body is owner_only too", async () => {
    const bad: Array<[string, unknown, string | undefined]> = [
      [
        "an invalid policy",
        { policy: { ...policy(), defaultGrantMilli: { cpu: MARK, gpu: 1 } } },
        undefined,
      ],
      ["a body with an unknown key", { policy: policy(), [MARK]: 1 }, undefined],
      ["no policy", {}, undefined],
      ["not JSON", undefined, "{not json"],
      ["an empty body", undefined, ""],
    ];
    for (const [name, body, raw] of bad) {
      const admin = await call("admin", "PUT", body, raw);
      expect([name, admin.status, admin.body.code]).toEqual([name, 403, "owner_only"]);
      // It says nothing about what was wrong with the body, which an admin has no right to probe.
      expect([name, "fields" in admin.body]).toEqual([name, false]);
      expect(admin.text).not.toContain(MARK);
      const member = await call("member", "PUT", body, raw);
      expect([name, member.status]).toEqual([name, 403]);
      expect([name, "fields" in member.body]).toEqual([name, false]);
    }
    expect(rows("compute_policy")).toBe(0);
    expect(audits("compute.policy.set")).toEqual([]);
  });

  test("an owner's valid body is stored as the next version and audited", async () => {
    const r1 = await call("owner", "PUT", { policy: policy(), note: "first" });
    expect(r1.status).toBe(200);
    expect(r1.body).toMatchObject({
      version: 1,
      is_default: false,
      set_by: ids.owner,
      note: "first",
    });
    expect(r1.body.policy).toEqual(JSON.parse(JSON.stringify(policy())));
    const r2 = await call("owner2", "PUT", { policy: policy({ maxLiveJobsPerPerson: 3 }) });
    expect([r2.status, r2.body.version, r2.body.set_by, r2.body.note]).toEqual([
      200,
      2,
      ids.owner2,
      null,
    ]);
    const audit = audits("compute.policy.set");
    expect(audit.map((a) => [a.user_id, a.resource_id])).toEqual([
      [ids.owner, "1"],
      [ids.owner2, "2"],
    ]);
    expect((await call("owner", "GET")).body.version).toBe(2);
  });

  test("an invalid body is a 400 that names the fields and never echoes a value", async () => {
    const bodies: unknown[] = [
      { policy: { ...policy(), defaultGrantMilli: { cpu: MARK, gpu: 1 } } },
      { policy: { ...policy(), [MARK]: 1 } },
      { policy: { ...policy(), registries: [MARK] } },
      { policy: { ...policy(), clients: { [`bad ${MARK}`]: {} } } },
      { policy: { ...policy(), maxLiveJobsPerPerson: -1 } },
      { policy: policy(), note: MARK.repeat(60) },
      { policy: policy(), note: 5 },
      { policy: policy(), [MARK]: 1 },
      { policy: MARK },
      { policy: null },
      {},
    ];
    for (const body of bodies) {
      const r = await call("owner", "PUT", body);
      expect([r.status, r.body.code, typeof r.body.error]).toEqual([400, "invalid_body", "string"]);
      expect(r.text).not.toContain(MARK);
    }
    // Not JSON at all, and an empty body.
    expect((await call("owner", "PUT", undefined, "{not json")).body.code).toBe("invalid_body");
    expect((await call("owner", "PUT", undefined, "")).body.code).toBe("invalid_body");
    expect(rows("compute_policy")).toBe(0);
    expect(audits("compute.policy.set")).toEqual([]);
  });

  test("names the fields that are wrong", async () => {
    const r = await call("owner", "PUT", {
      policy: { ...policy(), defaultGrantMilli: { cpu: "x", gpu: 1 } },
    });
    expect(r.body.error).toContain("policy.defaultGrantMilli.cpu");
    expect(r.body.fields.map((f: { path: string }) => f.path)).toEqual([
      "policy.defaultGrantMilli.cpu",
    ]);
  });
});
