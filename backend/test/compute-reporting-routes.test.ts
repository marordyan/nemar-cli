/**
 * The reporting, legal-hold and ACCESS-report routes (epic #2005 phase A7, #2012; ADR 0118; design section
 * 9), through the REAL admin router with its real authentication, admin and cookie-origin middleware, over
 * real migrated SQLite with real API keys, Miniflare's R2 and the Tapis stand-in (no response of which was
 * recorded from a real tenant).
 *
 * What is pinned, each with a test of its own:
 *  - `jobs list` filters by flag, state and account and pages newest first; `record` finds a job by its
 *    NEMAR id, its Tapis uuid and its Slurm id, and answers the index row, the ledger entries, the
 *    provenance and a manifest summary;
 *  - NO ADMIN VIEW CARRIES IDENTITY: not a name, an email, an ORCID iD, a country or an affiliation, in
 *    any answer here (MUTATION: add `email` to a view);
 *  - an identity or specification read is OWNER-ONLY, needs a stated reason and is audited before it is
 *    read: an administrator is refused with nothing read and nothing written;
 *  - `report` and `access-report` count what they say, an `access-report` counts a person ONCE however
 *    many jobs, and leaves out an unattributed or unreserved job;
 *  - holds and the re-queue of a failed ACCESS report are owner-only; the re-queue needs the explicit
 *    acknowledgement and writes nothing without it (MUTATION: drop the acknowledgement check).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  ComputeAccessReportResponseSchema,
  ComputeAccessReportsResponseSchema,
  ComputeAccountReportResponseSchema,
  ComputeHoldResponseSchema,
  ComputeHoldsResponseSchema,
  ComputeJobsListResponseSchema,
  ComputeRecordReadResponseSchema,
  ComputeRecordResponseSchema,
  ComputeRequeueResponseSchema,
} from "../../shared/contract/compute-admin";
import { requeueAccessReport } from "../src/services/compute-reporting";
import type { Bindings } from "../src/types/bindings";
import {
  COMPUTE_KEYS,
  type ComputeWho,
  makeComputeApp,
  seedComputeUsers,
} from "./helpers/compute-app";
import { endedJob } from "./helpers/compute-ended";
import {
  type LifecycleFixture,
  makeJob,
  startLifecycleFixture,
} from "./helpers/compute-lifecycle-fixture";
import { seedUser } from "./helpers/compute-seed";

let fx: LifecycleFixture;
const handle = makeComputeApp();

beforeAll(async () => {
  fx = await startLifecycleFixture();
}, 120_000);

beforeEach(async () => {
  await fx.reset();
  await seedComputeUsers(fx.harness.db);
});

afterAll(async () => {
  await fx?.dispose();
}, 30_000);

interface Reply {
  status: number;
  text: string;
  body: Record<string, any>;
}

async function call(
  method: "GET" | "POST" | "DELETE",
  path: string,
  who: ComputeWho | null,
  body?: unknown,
  env: Bindings = fx.env(),
): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (who) headers.Authorization = `Bearer ${COMPUTE_KEYS[who]}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await handle(
    new Request(`http://api.test/admin${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }),
    env,
  );
  const text = await res.text();
  let parsed: Record<string, any> = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, text, body: parsed };
}

const sql = {
  one: <T>(q: string, ...p: unknown[]) => fx.harness.db.query(q).get(...(p as never[])) as T,
  all: <T>(q: string, ...p: unknown[]) => fx.harness.db.query(q).all(...(p as never[])) as T[],
  run: (q: string, ...p: unknown[]) => fx.harness.db.run(q, p as never[]),
};

/** Words the seeded people carry that no administrator's view may ever show. */
const IDENTITY = [
  "Ada",
  "Lovelace",
  "@example.org",
  "0000-0002",
  "Freedonia",
  "Analytical Engines",
  "Sylvania",
];
const expectNoIdentity = (text: string) => {
  for (const word of IDENTITY) expect([word, text.includes(word)]).toEqual([word, false]);
};

describe("jobs list", () => {
  test("filters by flag, state and account, newest first, and pages", async () => {
    const a = await makeJob(fx);
    const b = await makeJob(fx);
    const c = await makeJob(fx);
    sql.run(
      "UPDATE compute_jobs SET flag_unreserved = 1, cancel_reason = 'unreserved' WHERE id = ?",
      b.job.id,
    );
    sql.run(
      "UPDATE compute_jobs SET state = 'cancelled', ended_at = datetime('now') WHERE id = ?",
      c.job.id,
    );

    const all = await call("GET", "/compute/jobs", "admin");
    expect(all.status).toBe(200);
    expect(ComputeJobsListResponseSchema.safeParse(all.body).success).toBe(true);
    expect(all.body.jobs.map((j: { id: string }) => j.id)).toEqual([c.job.id, b.job.id, a.job.id]);
    expect(all.body.next_after).toBeNull();

    const flagged = await call("GET", "/compute/jobs?flag=unreserved", "admin");
    expect(flagged.body.jobs.map((j: { id: string }) => j.id)).toEqual([b.job.id]);
    expect(flagged.body.jobs[0].flags).toEqual(["unreserved"]);
    const cancelled = await call("GET", "/compute/jobs?state=cancelled", "admin");
    expect(cancelled.body.jobs.map((j: { id: string }) => j.id)).toEqual([c.job.id]);
    const mine = await call("GET", `/compute/jobs?account=${a.accountId}`, "admin");
    expect(mine.body.jobs.map((j: { id: string }) => j.id)).toEqual([a.job.id]);

    const first = await call("GET", "/compute/jobs?limit=2", "admin");
    expect(first.body.jobs).toHaveLength(2);
    expect(first.body.next_after).not.toBeNull();
    const second = await call(
      "GET",
      `/compute/jobs?limit=2&after=${first.body.next_after}`,
      "admin",
    );
    expect(second.body.jobs.map((j: { id: string }) => j.id)).toEqual([a.job.id]);
    expect(second.body.next_after).toBeNull();
  });

  test("refuses a query that is not valid, a member and a stranger", async () => {
    for (const q of [
      "flag=weird",
      "state=nope",
      "limit=0",
      "limit=9999",
      "account=abc",
      "after=-1",
    ]) {
      expect([q, (await call("GET", `/compute/jobs?${q}`, "admin")).status]).toEqual([q, 400]);
    }
    expect((await call("GET", "/compute/jobs", "member")).status).toBe(403);
    expect((await call("GET", "/compute/jobs", null)).status).toBe(401);
  });

  test("no answer carries an identity", async () => {
    await makeJob(fx);
    const r = await call("GET", "/compute/jobs", "owner");
    expectNoIdentity(r.text);
    expectNoIdentity((await call("GET", "/compute/jobs?flag=unreserved", "owner")).text);
  });
});

describe("record", () => {
  test("finds a job by its NEMAR id, its Tapis uuid and its Slurm id, and answers the chain", async () => {
    const j = await endedJob(fx, 30);
    const slurm = j.job.slurm_job_id as string;
    const answers = [];
    for (const ref of [j.job.id, j.uuid, slurm]) {
      const r = await call("GET", `/compute/records/${encodeURIComponent(ref)}`, "admin");
      expect([ref, r.status]).toEqual([ref, 200]);
      answers.push(r.body);
    }
    for (const a of answers) expect(a).toEqual(answers[0]);
    const body = answers[0] as Record<string, any>;
    expect(ComputeRecordResponseSchema.safeParse(body).success).toBe(true);
    expect(body.job.id).toBe(j.job.id);
    expect(body.identifiers).toMatchObject({ tapis_uuid: j.uuid, slurm_job_id: slurm });
    expect(body.ledger.map((l: { kind: string }) => l.kind)).toEqual(["hold", "charge"]);
    expect(body.provenance).toMatchObject({ runtime_version: "test-runtime 1.0" });
    expect(Object.keys(body.provenance).sort()).toEqual(
      [
        "bundle_digest",
        "entry_exit_code",
        "image",
        "launch_spec_digest",
        "runtime_version",
        "slurm_job_id",
        "timings",
      ].sort(),
    );
    expect(body.manifest).toEqual({ files: 1, bytes: 8 });
    expect(body.legal_hold).toBe(false);
    expectNoIdentity(JSON.stringify(body));
  });

  test("a job that has no records yet still answers, with their absence said", async () => {
    const made = await makeJob(fx);
    const r = await call("GET", `/compute/records/${made.job.id}`, "admin");
    expect(r.status).toBe(200);
    expect(r.body.provenance).toBeNull();
    expect(r.body.manifest).toBeNull();
    expect(r.body.provenance_status).toBe("missing");
  });

  test("an unknown reference is job_not_found, and a held job says so", async () => {
    expect(
      (await call("GET", "/compute/records/job_ffffffffffffffffffffffff", "admin")).body.code,
    ).toBe("job_not_found");
    expect((await call("GET", "/compute/records/no-such-uuid", "admin")).status).toBe(404);
    expect((await call("GET", `/compute/records/${"x".repeat(200)}`, "admin")).status).toBe(404);
    const made = await makeJob(fx);
    await call("POST", "/compute/holds", "owner", {
      scope: "job",
      ref: made.job.id,
      reason: "legal_request",
    });
    expect((await call("GET", `/compute/records/${made.job.id}`, "admin")).body.legal_hold).toBe(
      true,
    );
    expect((await call("GET", `/compute/records/${made.job.id}`, "member")).status).toBe(403);
  });
});

describe("an owner's read of an identity or a specification", () => {
  test("an administrator is refused, and nothing is read or written", async () => {
    const made = await makeJob(fx);
    const auditBefore = sql.one<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log").n;
    const r = await call("POST", `/compute/records/${made.job.id}/read`, "admin", {
      name: "identity.json",
      reason: "the person asked for it",
    });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("owner_only");
    expectNoIdentity(r.text);
    expect(sql.one<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log").n).toBe(auditBefore);
    expect(
      (
        await call("POST", `/compute/records/${made.job.id}/read`, "member", {
          name: "identity.json",
          reason: "a long enough reason",
        })
      ).status,
    ).toBe(403);
  });

  test("the owner check comes before the body is read: a non-owner with a body that is not valid gets 403, never 400 (MUTATION: validate the body first)", async () => {
    const made = await makeJob(fx);
    for (const [path, body] of [
      [`/compute/records/${made.job.id}/read`, "not json {"],
      [`/compute/records/${made.job.id}/read`, { nonsense: true }],
      ["/compute/holds", { scope: "weird" }],
      ["/compute/access-reports/job_00000000000000000000000a/requeue", "garbage"],
    ] as const) {
      for (const who of ["admin", "member"] as const) {
        const r = await call("POST", path, who, body);
        expect([path, who, r.status]).toEqual([path, who, 403]);
      }
    }
  });

  test("an owner needs a reason of 8 to 200 characters; with one, the identity is read and the read is audited first", async () => {
    const made = await makeJob(fx);
    const path = `/compute/records/${made.job.id}/read`;
    for (const reason of ["", "short", "x".repeat(201), "line\nbreak in a reason"]) {
      const r = await call("POST", path, "owner", { name: "identity.json", reason });
      expect([reason.length, r.status, r.body.code]).toEqual([
        reason.length,
        400,
        "invalid_reason",
      ]);
    }
    expect(
      sql.one<{ n: number }>(
        "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'compute.record.read'",
      ).n,
    ).toBe(0);

    const ok = await call("POST", path, "owner", {
      name: "identity.json",
      reason: "subject access request 4411",
    });
    expect(ok.status).toBe(200);
    expect(ComputeRecordReadResponseSchema.safeParse(ok.body).success).toBe(true);
    expect(ok.body.content).toMatchObject({ name: "Ada Lovelace", account_id: made.accountId });
    const audit = sql.all<{ user_id: number; resource_id: string; details: string }>(
      "SELECT user_id, resource_id, details FROM audit_log WHERE action = 'compute.record.read'",
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.resource_id).toBe(made.job.id);
    expect(JSON.parse(audit[0]?.details ?? "{}")).toEqual({
      name: "identity.json",
      reason: "subject access request 4411",
    });
    // The specification is read the same way, by any of the three names.
    const spec = await call(
      "POST",
      `/compute/records/${encodeURIComponent(made.job.id)}/read`,
      "owner",
      {
        name: "spec.json",
        reason: "checking what was asked for",
      },
    );
    expect(spec.body.content).toMatchObject({ runtime: "python" });
  });

  test("a name that is no record is refused, a missing record is record_missing, and a body with another key is invalid", async () => {
    const made = await makeJob(fx);
    const path = `/compute/records/${made.job.id}/read`;
    const reason = "a perfectly good reason";
    expect((await call("POST", path, "owner", { name: "../identity.json", reason })).status).toBe(
      400,
    );
    expect((await call("POST", path, "owner", { name: "unknown.json", reason })).status).toBe(400);
    expect((await call("POST", path, "owner", { name: "provenance.json", reason })).body.code).toBe(
      "record_missing",
    );
    expect(
      (await call("POST", path, "owner", { name: "spec.json", reason, extra: 1 })).status,
    ).toBe(400);
    expect(
      (
        await call("POST", "/compute/records/job_ffffffffffffffffffffffff/read", "owner", {
          name: "spec.json",
          reason,
        })
      ).body.code,
    ).toBe("job_not_found");
  });
});

describe("report", () => {
  test("totals one account's jobs in the range, by pool, and leaves other accounts out", async () => {
    const a = await makeJob(fx);
    const a2 = await makeJob(fx);
    sql.run("UPDATE compute_jobs SET account_id = ? WHERE id = ?", a.accountId, a2.job.id);
    const other = await makeJob(fx);
    sql.run(
      "UPDATE compute_jobs SET charged_milli = 1500, created_at = '2026-10-05 10:00:00' WHERE id = ?",
      a.job.id,
    );
    sql.run(
      "UPDATE compute_jobs SET charged_milli = 2500, created_at = '2026-10-31 23:59:59' WHERE id = ?",
      a2.job.id,
    );
    sql.run(
      "UPDATE compute_jobs SET created_at = '2026-09-30 23:59:59', charged_milli = 99 WHERE id = ?",
      other.job.id,
    );
    const r = await call(
      "GET",
      `/compute/report?account=${a.accountId}&from=2026-10-01&to=2026-10-31`,
      "admin",
    );
    expect(r.status).toBe(200);
    expect(ComputeAccountReportResponseSchema.safeParse(r.body).success).toBe(true);
    // Both jobs are still held and unsettled (makeJob leaves the hold open): they have charged what the
    // test wrote into the column, and the report says they are not final and what they still hold.
    const held = sql.one<{ h: number }>(
      "SELECT SUM(held_milli) AS h FROM compute_jobs WHERE account_id = ?",
      a.accountId,
    ).h;
    expect(held).toBeGreaterThan(0);
    expect(r.body.totals).toEqual({
      jobs: 2,
      charged_milli: 4000,
      unsettled: 2,
      open_hold_milli: held,
    });
    expect(r.body.by_pool).toEqual({
      cpu: { jobs: 2, charged_milli: 4000, unsettled: 2, open_hold_milli: held },
    });
    expect(r.body.jobs.map((j: { settled: boolean }) => j.settled)).toEqual([false, false]);
    expect(r.body.jobs.map((j: { id: string }) => j.id)).toEqual([a.job.id, a2.job.id]);
    expect(r.body.truncated).toBe(false);
    // Outside the range there is nothing.
    const none = await call(
      "GET",
      `/compute/report?account=${a.accountId}&from=2026-11-01&to=2026-11-30`,
      "admin",
    );
    expect(none.body.totals).toEqual({
      jobs: 0,
      charged_milli: 0,
      unsettled: 0,
      open_hold_milli: 0,
    });
    expectNoIdentity(r.text);
  });

  test("a settled job holds nothing and is not counted unsettled; an unsettled one shows its hold", async () => {
    const settled = await endedJob(fx, 30);
    const running = await makeJob(fx);
    sql.run(
      "UPDATE compute_jobs SET account_id = ? WHERE id = ?",
      settled.accountId,
      running.job.id,
    );
    sql.run(
      "UPDATE compute_jobs SET flag_mismatch = 1, flag_unreserved = 1 WHERE id = ?",
      running.job.id,
    );
    const r = await call(
      "GET",
      `/compute/report?account=${settled.accountId}&from=2000-01-01&to=2100-01-01`,
      "admin",
    );
    expect(r.status).toBe(200);
    const byId = Object.fromEntries(r.body.jobs.map((j: { id: string }) => [j.id, j])) as Record<
      string,
      { settled: boolean; open_hold_milli: number; charged_milli: number }
    >;
    expect(byId[settled.job.id]?.settled).toBe(true);
    expect(byId[settled.job.id]?.open_hold_milli).toBe(0);
    expect(byId[settled.job.id]?.charged_milli).toBeGreaterThan(0);
    expect(byId[running.job.id]?.settled).toBe(false);
    expect(byId[running.job.id]?.charged_milli).toBe(0);
    const held = sql.one<{ h: number }>(
      "SELECT held_milli AS h FROM compute_jobs WHERE id = ?",
      running.job.id,
    ).h;
    expect(byId[running.job.id]?.open_hold_milli).toBe(held);
    // The flags come from the columns by the one map the job view uses, in the declared order.
    const flagsOfJob = (id: string) => r.body.jobs.find((j: { id: string }) => j.id === id).flags;
    expect(flagsOfJob(running.job.id)).toEqual(["unreserved", "mismatch"]);
    expect(flagsOfJob(settled.job.id)).toEqual([]);
    expect(r.body.totals.unsettled).toBe(1);
    expect(r.body.totals.open_hold_milli).toBe(held);
  });

  test("an account, a date that is not one, and a missing parameter are refused", async () => {
    for (const q of [
      "from=2026-10-01&to=2026-10-31",
      "account=1&from=2026-13-01&to=2026-10-31",
      "account=1&from=2026-10-01",
      "account=0&from=2026-10-01&to=2026-10-31",
      "account=1&from=Oct&to=Nov",
    ]) {
      expect([q, (await call("GET", `/compute/report?${q}`, "admin")).status]).toEqual([q, 400]);
    }
    expect(
      (await call("GET", "/compute/report?account=1&from=2026-10-01&to=2026-10-31", "member"))
        .status,
    ).toBe(403);
  });
});

describe("access-report", () => {
  test("counts a person once however many jobs, by partition and source, and leaves out the unattributed and the unreserved", async () => {
    const a = await makeJob(fx);
    const a2 = await makeJob(fx);
    const a3 = await makeJob(fx);
    const b = await makeJob(fx);
    const c = await makeJob(fx);
    const d = await makeJob(fx);
    // a, a2 and a3 are one person (a's pseudonym), b another, c is unattributed, d is unreserved.
    const gateway = sql.one<{ gateway_user: string }>(
      "SELECT gateway_user FROM compute_jobs WHERE id = ?",
      a.job.id,
    ).gateway_user;
    for (const j of [a, a2, a3]) {
      sql.run(
        "UPDATE compute_jobs SET gateway_user = ?, account_id = ? WHERE id = ?",
        gateway,
        a.accountId,
        j.job.id,
      );
    }
    sql.run("UPDATE compute_jobs SET flag_unattributed = 1 WHERE id = ?", c.job.id);
    sql.run("UPDATE compute_jobs SET flag_unreserved = 1 WHERE id = ?", d.job.id);
    sql.run("UPDATE compute_jobs SET source = 'web' WHERE id = ?", a3.job.id);
    for (const [i, j] of [a, a2, a3, b, c, d].entries()) {
      sql.run(
        "UPDATE compute_jobs SET slurm_job_id = ?, remote_submitted_at = '2026-11-15 12:00:00' WHERE id = ?",
        `${5000 + i}`,
        j.job.id,
      );
    }
    // Outside the quarter.
    const old = await makeJob(fx);
    sql.run(
      "UPDATE compute_jobs SET slurm_job_id = '4999', remote_submitted_at = '2026-09-30 23:59:59' WHERE id = ?",
      old.job.id,
    );
    const neverSubmitted = await makeJob(fx);
    expect(neverSubmitted.job.id).toBeTruthy();

    const r = await call("GET", "/compute/access-report?quarter=2026Q4", "admin");
    expect(r.status).toBe(200);
    expect(ComputeAccessReportResponseSchema.safeParse(r.body).success).toBe(true);
    expect(r.body.quarter).toBe("2026Q4");
    expect(r.body.rows).toEqual([
      { partition: "shared", source: "cli", distinct_users: 2, jobs: 3 },
      { partition: "shared", source: "web", distinct_users: 1, jobs: 1 },
    ]);
    // Across the sources the person who ran both a cli and a web job is still one person.
    expect(r.body.totals).toEqual({ distinct_users: 2, jobs: 4 });
    expect(r.text).not.toContain("gw_");
    expectNoIdentity(r.text);
    const q3 = await call("GET", "/compute/access-report?quarter=2026Q3", "admin");
    expect(q3.body.totals).toEqual({ distinct_users: 1, jobs: 1 });
  });

  test("counts what ACCESS is told: a Slurm id and the scheduler's own time, in UTC, not NEMAR's bind time", async () => {
    // Accepted by Tapis (submitted_at set) and then failed in staging: no Slurm id, nothing was told to
    // ACCESS, so the report must not count it.
    const staged = await makeJob(fx);
    sql.run(
      "UPDATE compute_jobs SET submitted_at = '2026-11-15 12:00:00', remote_submitted_at = '2026-11-15 12:00:00' WHERE id = ?",
      staged.job.id,
    );
    // Bound to Tapis at 23:58 on 31 December, scheduled at 00:01 on 1 January: ACCESS was sent the
    // January time, so the job belongs to Q1 and not to Q4.
    const straddle = await makeJob(fx);
    sql.run(
      `UPDATE compute_jobs SET submitted_at = '2026-12-31 23:58:00', slurm_job_id = '7001',
              remote_submitted_at = '2027-01-01 00:01:00' WHERE id = ?`,
      straddle.job.id,
    );
    const q4 = await call("GET", "/compute/access-report?quarter=2026Q4", "admin");
    expect(q4.status).toBe(200);
    expect(q4.body.totals).toEqual({ distinct_users: 0, jobs: 0 });
    const q1 = await call("GET", "/compute/access-report?quarter=2027Q1", "admin");
    expect(q1.body.totals).toEqual({ distinct_users: 1, jobs: 1 });
  });

  test("a quarter that is not one is refused", async () => {
    for (const q of ["", "2026", "2026Q5", "2026Q0", "26Q1", "2026-Q1", "2026q1"]) {
      expect([
        q,
        (await call("GET", `/compute/access-report?quarter=${q}`, "admin")).status,
      ]).toEqual([q, 400]);
    }
  });
});

describe("legal holds", () => {
  test("only the owner places or releases one, each is audited, and an administrator may list", async () => {
    const made = await makeJob(fx);
    const body = { scope: "job", ref: made.job.id, reason: "legal_request" };
    expect((await call("POST", "/compute/holds", "admin", body)).body.code).toBe("owner_only");
    expect((await call("POST", "/compute/holds", "member", body)).status).toBe(403);
    expect((await call("POST", "/compute/holds", null, body)).status).toBe(401);
    expect(sql.one<{ n: number }>("SELECT COUNT(*) AS n FROM compute_legal_holds").n).toBe(0);

    const placed = await call("POST", "/compute/holds", "owner", body);
    expect(placed.status).toBe(201);
    expect(ComputeHoldResponseSchema.safeParse(placed.body).success).toBe(true);
    expect(placed.body.hold).toMatchObject({
      scope: "job",
      ref: made.job.id,
      reason: "legal_request",
      released_at: null,
    });
    const listed = await call("GET", "/compute/holds", "admin");
    expect(ComputeHoldsResponseSchema.safeParse(listed.body).success).toBe(true);
    expect(listed.body.holds).toHaveLength(1);
    expect(
      (await call("GET", `/compute/holds?scope=account&ref=${made.accountId}`, "admin")).body.holds,
    ).toEqual([]);

    expect((await call("DELETE", `/compute/holds/${placed.body.hold.id}`, "admin")).body.code).toBe(
      "owner_only",
    );
    const released = await call("DELETE", `/compute/holds/${placed.body.hold.id}`, "owner");
    expect(released.status).toBe(200);
    expect(released.body.hold.released_at).not.toBeNull();
    expect((await call("DELETE", `/compute/holds/${placed.body.hold.id}`, "owner")).body.code).toBe(
      "hold_not_found",
    );
    expect((await call("GET", "/compute/holds", "admin")).body.holds).toEqual([]);
    expect(
      sql
        .all<{ action: string }>(
          "SELECT action FROM audit_log WHERE action LIKE 'compute.hold.%' ORDER BY id",
        )
        .map((a) => a.action),
    ).toEqual(["compute.hold.place", "compute.hold.release"]);
  });

  test("a list of more than 200 active holds is the oldest 200 and SAYS it is cut; 200 exactly is not cut", async () => {
    for (let i = 1; i <= 201; i++) {
      sql.run(
        "INSERT INTO compute_legal_holds (scope, ref, reason, placed_by) VALUES ('account', ?, 'legal_request', 1)",
        String(i),
      );
    }
    const cut = await call("GET", "/compute/holds", "admin");
    expect(cut.status).toBe(200);
    expect(ComputeHoldsResponseSchema.safeParse(cut.body).success).toBe(true);
    expect(cut.body.holds).toHaveLength(200);
    expect(cut.body.truncated).toBe(true);
    // Oldest first: the 201st hold is the one left out.
    expect(cut.body.holds[0].ref).toBe("1");
    expect(cut.body.holds[199].ref).toBe("200");
    // A filter that names one target is not cut, and a list of exactly 200 is not either.
    const one = await call("GET", "/compute/holds?scope=account&ref=201", "admin");
    expect(one.body.holds).toHaveLength(1);
    expect(one.body.truncated).toBe(false);
    sql.run("UPDATE compute_legal_holds SET released_at = datetime('now') WHERE ref = '201'");
    const exact = await call("GET", "/compute/holds", "admin");
    expect(exact.body.holds).toHaveLength(200);
    expect(exact.body.truncated).toBe(false);
  });

  test("an account hold, a second hold, a target that is not there and a ref that is not a ref", async () => {
    const made = await makeJob(fx);
    const ok = await call("POST", "/compute/holds", "owner", {
      scope: "account",
      ref: String(made.accountId),
      reason: "legal_request",
    });
    expect(ok.status).toBe(201);
    expect(
      (
        await call("POST", "/compute/holds", "owner", {
          scope: "account",
          ref: String(made.accountId),
          reason: "again",
        })
      ).body.code,
    ).toBe("hold_exists");
    expect(
      (
        await call("POST", "/compute/holds", "owner", {
          scope: "account",
          ref: "999999999",
          reason: "legal_request",
        })
      ).body.code,
    ).toBe("target_not_found");
    expect(
      (
        await call("POST", "/compute/holds", "owner", {
          scope: "job",
          ref: "job_ffffffffffffffffffffffff",
          reason: "legal_request",
        })
      ).body.code,
    ).toBe("target_not_found");
    for (const bad of [
      { scope: "job", ref: "12", reason: "legal_request" },
      { scope: "account", ref: "job_0123456789abcdef01234567", reason: "legal_request" },
      { scope: "account", ref: "012", reason: "legal_request" },
      { scope: "team", ref: "12", reason: "legal_request" },
      { scope: "account", ref: "12", reason: "Not A Word" },
      { scope: "account", ref: "12", reason: "legal_request", extra: true },
    ]) {
      expect([
        JSON.stringify(bad),
        (await call("POST", "/compute/holds", "owner", bad)).status,
      ]).toEqual([JSON.stringify(bad), 400]);
    }
    expect((await call("DELETE", "/compute/holds/abc", "owner")).status).toBe(404);
  });
});

describe("ACCESS reports that failed", () => {
  const JOBS = [
    "job_00000000000000000000000a",
    "job_00000000000000000000000b",
    "job_00000000000000000000000c",
    "job_00000000000000000000000d",
  ];
  function seed() {
    sql.run(
      `INSERT INTO compute_access_reports (job_id, state, attempts, last_error_code) VALUES
         (?, 'failed', 1, 'outcome_unknown'), (?, 'failed', 8, 'refused'), (?, 'failed', 0, 'no_gateway_user'), (?, 'pending', 0, NULL)`,
      ...JOBS,
    );
  }

  test("are listed by their fixed word, and counted, to an administrator", async () => {
    seed();
    const r = await call("GET", "/compute/access-reports", "admin");
    expect(r.status).toBe(200);
    expect(ComputeAccessReportsResponseSchema.safeParse(r.body).success).toBe(true);
    expect(r.body.rows.map((x: { last_error_code: string }) => x.last_error_code).sort()).toEqual([
      "no_gateway_user",
      "outcome_unknown",
      "refused",
    ]);
    expect(r.body.failed_by_word).toEqual({ no_gateway_user: 1, outcome_unknown: 1, refused: 1 });
    const pending = await call("GET", "/compute/access-reports?state=pending", "admin");
    expect(pending.body.rows).toHaveLength(1);
    expect((await call("GET", "/compute/access-reports?state=weird", "admin")).status).toBe(400);
    expect((await call("GET", "/compute/access-reports", "member")).status).toBe(403);
    const page = await call("GET", "/compute/access-reports?limit=2", "admin");
    expect(page.body.rows).toHaveLength(2);
    expect(page.body.next_after).toBe(page.body.rows[1].job_id);
  });

  test("the re-queue needs the owner AND the explicit acknowledgement, and writes nothing without either (MUTATION: drop the acknowledgement check)", async () => {
    seed();
    const path = `/compute/access-reports/${JOBS[0]}/requeue`;
    const state = () =>
      sql.one<Record<string, unknown>>(
        "SELECT * FROM compute_access_reports WHERE job_id = ?",
        JOBS[0],
      );
    const before = state();
    const auditBefore = sql.one<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log").n;
    for (const body of [
      undefined,
      {},
      { confirmed_not_recorded: false },
      { confirmed_not_recorded: "yes" },
      { confirmed_not_recorded: true, more: 1 },
    ]) {
      const r = await call("POST", path, "owner", body === undefined ? "" : body);
      expect([JSON.stringify(body), r.status, r.body.code]).toEqual([
        JSON.stringify(body),
        400,
        "acknowledgement_required",
      ]);
    }
    expect((await call("POST", path, "admin", { confirmed_not_recorded: true })).body.code).toBe(
      "owner_only",
    );
    expect((await call("POST", path, "member", { confirmed_not_recorded: true })).status).toBe(403);
    expect(state()).toEqual(before);
    expect(sql.one<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log").n).toBe(auditBefore);

    const ok = await call("POST", path, "owner", { confirmed_not_recorded: true });
    expect(ok.status).toBe(200);
    expect(ComputeRequeueResponseSchema.safeParse(ok.body).success).toBe(true);
    expect(ok.body).toMatchObject({ ok: true, job_id: JOBS[0], previous: "outcome_unknown" });
    expect(state()).toMatchObject({
      state: "pending",
      attempts: 0,
      claimed_at: null,
      last_error_code: null,
    });
    const audit = sql.all<{ details: string; resource_id: string }>(
      "SELECT details, resource_id FROM audit_log WHERE action = 'compute.access_report.requeue'",
    );
    expect(audit).toEqual([
      { resource_id: JOBS[0] as string, details: JSON.stringify({ previous: "outcome_unknown" }) },
    ]);
  });

  test("a suspended or deleted owner gets not_owner from the re-queue, and the row is untouched (MUTATION: classify by role alone)", async () => {
    seed();
    const suspended = await seedUser(fx.env().DB, { role: "owner", status: "revoked" });
    const deleted = await seedUser(fx.env().DB, {
      role: "owner",
      deleted_at: "2026-01-01 00:00:00",
    });
    for (const ownerId of [suspended, deleted]) {
      expect(await requeueAccessReport(fx.env().DB, { jobId: JOBS[0] as string, ownerId })).toEqual(
        {
          ok: false,
          code: "not_owner",
        },
      );
    }
    expect(
      sql.one<{ state: string }>(
        "SELECT state FROM compute_access_reports WHERE job_id = ?",
        JOBS[0],
      ).state,
    ).toBe("failed");
  });

  test("only a failed row is re-queued: a pending, a sent and an unknown report are not found", async () => {
    seed();
    sql.run(
      "INSERT INTO compute_access_reports (job_id, state, attempts, sent_at) VALUES ('job_00000000000000000000000e', 'sent', 1, datetime('now'))",
    );
    for (const id of [JOBS[3], "job_00000000000000000000000e", "job_ffffffffffffffffffffffff"]) {
      const r = await call("POST", `/compute/access-reports/${id}/requeue`, "owner", {
        confirmed_not_recorded: true,
      });
      expect([id, r.status, r.body.code]).toEqual([id, 404, "report_not_found"]);
    }
    expect(
      (
        await call("POST", "/compute/access-reports/not-a-job/requeue", "owner", {
          confirmed_not_recorded: true,
        })
      ).status,
    ).toBe(404);
    // The pending row was not changed by the refused attempt.
    expect(
      sql.one<{ state: string }>(
        "SELECT state FROM compute_access_reports WHERE job_id = ?",
        JOBS[3],
      ).state,
    ).toBe("pending");
  });
});
