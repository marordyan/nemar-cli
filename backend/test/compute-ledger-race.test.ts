/**
 * The hold is one conditional INSERT (epic #2005 phase A2, #2007; ADR 0118, decision 3), proven on
 * Miniflare's D1, the implementation `wrangler --local` runs, because that is where statements from
 * concurrent requests interleave and where a read-then-write that is not atomic would show.
 * bun:sqlite runs a statement to completion before the next can start, which cannot show it.
 *
 * What is pinned: two concurrent holds for the last SU of one pool, and a crowd of them for a few,
 * leave exactly as many winners as the pool has room for, and every loser writes no ledger row and
 * says `insufficient_balance`; the same for the platform budget (`platform_budget_exhausted`, and
 * the loser's own pool untouched); a frozen pool is `suspended`; a replayed key returns the first
 * hold and moves no total, even when the replay races the original; a grant key grants once under
 * a race; two concurrent settlements of one job write one charge; a caller's own guard is part of
 * the same statement and so holds under a race too; and after a crowd of mixed concurrent
 * operations every pool's totals still equal the sums of its ledger.
 *
 * The ledger is append-only, so nothing can be cleaned up between tests: each test makes its own
 * pools and jobs; the `people` budget is the one shared pool every account's spend is counted
 * against (the table says so), so a test that needs to know what is left sets it first.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type HoldResult,
  type PoolRow,
  adjustPool,
  availableMilli,
  ensurePool,
  expireUnused,
  getPool,
  grantPool,
  placeHold,
  releaseHold,
  settleFinal,
  settleProvisional,
} from "../src/services/compute-ledger";
import { getPolicy, putPolicy } from "../src/services/compute-policy";
import {
  type MiniflareD1,
  jobId,
  ledgerCount,
  miniflareD1,
  poolTotals,
  seeded,
  totalsDisagreements,
} from "./helpers/compute-ledger";

let mf: MiniflareD1;
let d1: D1Database;

beforeAll(async () => {
  mf = await miniflareD1();
  d1 = mf.d1;
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
}, 30_000);

let seq = 0;
const next = () => ++seq;

/** A real account: D1 enforces the foreign key of `audit_log.user_id`, as production does. */
async function user(role: "owner" | "admin"): Promise<number> {
  const n = next();
  await d1
    .prepare(
      `INSERT INTO users (username, email, password_hash, status, role, signup_source, email_verified, service_access, account_kind)
       VALUES (?, ?, 'x', 'approved', ?, 'cli', 1, 0, 'person')`,
    )
    .bind(`race-user-${n}`, `race-user-${n}@example.org`, role)
    .run();
  const row = await d1
    .prepare("SELECT id FROM users WHERE username = ?")
    .bind(`race-user-${n}`)
    .first<{ id: number }>();
  return row?.id ?? 0;
}

async function grant(pool: PoolRow, amountMilli: number) {
  const r = await grantPool(d1, {
    poolId: pool.id,
    amountMilli,
    actorUserId: 1,
    idempotencyKey: `race-grant-${next()}`,
  });
  expect(r.ok).toBe(true);
}

/**
 * The shared platform `people` budget, set to have exactly `n` available: by a grant to it when it
 * has less, and by a hold on a throwaway person when it has more. The table says an account's spend
 * is counted against this one pool, so a test that needs to know what is left sets it first.
 */
async function budgetWith(n: number): Promise<PoolRow> {
  const budget = await ensurePool(d1, "platform", "people", "cpu");
  const have = availableMilli((await getPool(d1, budget.id)) as PoolRow);
  if (have < n) {
    await grant(budget, n - have);
  } else if (have > n) {
    const burner = await ensurePool(d1, "account", String(300000 + next()), "cpu");
    await grant(burner, have - n);
    const burn = await placeHold(d1, {
      poolId: burner.id,
      budgetPoolId: budget.id,
      amountMilli: have - n,
      jobId: jobId(next()),
    });
    expect(burn.ok).toBe(true);
  }
  return budget;
}

/** A person with `personMilli` and the platform budget with exactly `budgetMilli` available. */
async function scene(personMilli: number, budgetMilli: number) {
  const person = await ensurePool(d1, "account", String(300000 + next()), "cpu");
  if (personMilli > 0) await grant(person, personMilli);
  const budget = await budgetWith(budgetMilli);
  return { person, budget };
}

function hold(
  person: PoolRow,
  budget: PoolRow,
  amountMilli: number,
  over: { jobId?: string } = {},
): Promise<HoldResult> {
  return placeHold(d1, {
    poolId: person.id,
    budgetPoolId: budget.id,
    amountMilli,
    jobId: over.jobId ?? jobId(next()),
  });
}

async function holdRows(poolId: number): Promise<number> {
  return (
    (
      await d1
        .prepare("SELECT COUNT(*) AS n FROM compute_ledger WHERE kind = 'hold' AND pool_id = ?")
        .bind(poolId)
        .first<{ n: number }>()
    )?.n ?? 0
  );
}

describe("two holds for the last SU", () => {
  test("exactly one is written, the other writes nothing and says insufficient_balance", async () => {
    // Several rounds: each is its own pool, so a non-atomic claim has many chances to show.
    for (let round = 0; round < 25; round++) {
      const { person, budget } = await scene(1000, 100000);
      const jobs = [jobId(next()), jobId(next())];
      const results = await Promise.all([
        hold(person, budget, 1000, { jobId: jobs[0] }),
        hold(person, budget, 1000, { jobId: jobs[1] }),
      ]);
      const winners = results.filter((r) => r.ok);
      const losers = results.filter((r) => !r.ok);
      expect([round, winners.length, losers.length]).toEqual([round, 1, 1]);
      expect(losers[0]).toEqual({ ok: false, code: "insufficient_balance" });
      const won = results.findIndex((r) => r.ok);
      const lost = 1 - won;
      expect(await holdRows(person.id)).toBe(1);
      const stray = await d1
        .prepare("SELECT COUNT(*) AS n FROM compute_ledger WHERE job_id = ?")
        .bind(jobs[lost])
        .first<{ n: number }>();
      expect(stray?.n).toBe(0);
      const t = await poolTotals(d1, person.id);
      expect([t.held_milli, availableMilli(t)]).toEqual([1000, 0]);
      // The budget is the shared one: this round set it to 100000 available, and took 1000.
      expect(availableMilli(await poolTotals(d1, budget.id))).toBe(99000);
    }
    expect(await totalsDisagreements(d1)).toEqual([]);
  });

  test("a crowd for room for five has five winners, and every loser is insufficient_balance", async () => {
    const { person, budget } = await scene(5000, 1000000);
    const results = await Promise.all(Array.from({ length: 20 }, () => hold(person, budget, 1000)));
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    for (const r of results.filter((r) => !r.ok)) {
      expect(r).toEqual({ ok: false, code: "insufficient_balance" });
    }
    expect(await holdRows(person.id)).toBe(5);
    const t = await poolTotals(d1, person.id);
    expect([t.held_milli, availableMilli(t)]).toEqual([5000, 0]);
    expect(await totalsDisagreements(d1)).toEqual([]);
  });

  test("a crowd of different sizes never takes more than is there", async () => {
    const { person, budget } = await scene(10000, 1000000);
    const sizes = [3000, 3000, 3000, 3000, 2000, 2000, 1500, 1500, 500, 500, 250, 250];
    const results = await Promise.all(sizes.map((s) => hold(person, budget, s)));
    const taken = results.reduce((sum, r, i) => sum + (r.ok ? (sizes[i] as number) : 0), 0);
    const t = await poolTotals(d1, person.id);
    expect(t.held_milli).toBe(taken);
    expect(taken).toBeLessThanOrEqual(10000);
    expect(availableMilli(t)).toBeGreaterThanOrEqual(0);
    expect(await totalsDisagreements(d1)).toEqual([]);
  });
});

describe("the platform budget", () => {
  test("the last SU of the budget goes to one of two people, and the other is platform_budget_exhausted", async () => {
    const budget = await budgetWith(1000);
    const a = await ensurePool(d1, "account", String(300000 + next()), "cpu");
    const b = await ensurePool(d1, "account", String(300000 + next()), "cpu");
    await grant(a, 5000);
    await grant(b, 5000);
    const results = await Promise.all([hold(a, budget, 1000), hold(b, budget, 1000)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toEqual({ ok: false, code: "platform_budget_exhausted" });
    const loser = results[0]?.ok ? b : a;
    expect(await poolTotals(d1, loser.id)).toMatchObject({ held_milli: 0 });
    expect(await holdRows(loser.id)).toBe(0);
    expect(availableMilli(await poolTotals(d1, budget.id))).toBe(0);
    expect(await totalsDisagreements(d1)).toEqual([]);
  });

  test("a person with balance is platform_budget_exhausted when the budget is spent", async () => {
    const { person, budget } = await scene(9000, 500);
    expect(await hold(person, budget, 501)).toEqual({
      ok: false,
      code: "platform_budget_exhausted",
    });
    expect((await hold(person, budget, 500)).ok).toBe(true);
    expect(await hold(person, budget, 1)).toEqual({ ok: false, code: "platform_budget_exhausted" });
    expect(availableMilli(await poolTotals(d1, person.id))).toBe(8500);
  });
});

describe("a job has one hold, and its key is the job's", () => {
  test("a second request for a job's hold that differs is idempotency_conflict on D1 too, and writes nothing", async () => {
    const { person, budget } = await scene(9000, 100000);
    const job = jobId(next());
    expect((await hold(person, budget, 1000, { jobId: job })).ok).toBe(true);
    const outcomes = await Promise.allSettled([
      hold(person, budget, 1001, { jobId: job }),
      hold(person, budget, 999, { jobId: job }),
    ]);
    for (const o of outcomes) {
      expect(o.status).toBe("rejected");
      expect((o as PromiseRejectedResult).reason).toMatchObject({ code: "idempotency_conflict" });
    }
    expect(await holdRows(person.id)).toBe(1);
    expect((await poolTotals(d1, person.id)).held_milli).toBe(1000);
    expect(await totalsDisagreements(d1)).toEqual([]);
  });

  test("two concurrent requests for the same hold write one, and both are told so", async () => {
    for (let round = 0; round < 10; round++) {
      const { person, budget } = await scene(5000, 100000);
      const job = jobId(next());
      const results = await Promise.all([
        hold(person, budget, 2000, { jobId: job }),
        hold(person, budget, 2000, { jobId: job }),
      ]);
      expect(results.every((r) => r.ok)).toBe(true);
      expect(results.filter((r) => r.ok && !r.replayed)).toHaveLength(1);
      expect(await holdRows(person.id)).toBe(1);
      expect((await poolTotals(d1, person.id)).held_milli).toBe(2000);
    }
  });
});

describe("a frozen pool", () => {
  test("is suspended, and writes nothing, until it is thawed", async () => {
    const { person, budget } = await scene(5000, 100000);
    await d1.prepare("UPDATE compute_pools SET frozen = 1 WHERE id = ?").bind(person.id).run();
    const before = await ledgerCount(d1);
    const results = await Promise.all([hold(person, budget, 100), hold(person, budget, 100)]);
    expect(results).toEqual([
      { ok: false, code: "suspended" },
      { ok: false, code: "suspended" },
    ]);
    expect(await ledgerCount(d1)).toBe(before);
    await d1.prepare("UPDATE compute_pools SET frozen = 0 WHERE id = ?").bind(person.id).run();
    expect((await hold(person, budget, 100)).ok).toBe(true);
  });
});

describe("a replayed hold or grant", () => {
  test("a hold replayed by its job returns the first hold and moves no total", async () => {
    const { person, budget } = await scene(5000, 100000);
    const job = jobId(next());
    const first = await hold(person, budget, 2000, { jobId: job });
    expect(first.ok).toBe(true);
    const totalsBefore = await poolTotals(d1, person.id);
    const budgetBefore = await poolTotals(d1, budget.id);
    const again = await hold(person, budget, 2000, { jobId: job });
    expect(again.ok && again.replayed).toBe(true);
    if (first.ok && again.ok) expect(again.entry).toEqual(first.entry);
    expect(await poolTotals(d1, person.id)).toEqual(totalsBefore);
    expect(await poolTotals(d1, budget.id)).toEqual(budgetBefore);
    expect(await holdRows(person.id)).toBe(1);
  });

  test("a hold replayed is returned even when the pool could not take it again", async () => {
    const { person, budget } = await scene(1000, 100000);
    const job = jobId(next());
    expect((await hold(person, budget, 1000, { jobId: job })).ok).toBe(true);
    // Nothing is left, so a fresh hold of the same size is refused, but the replay is not.
    expect(await hold(person, budget, 1000)).toEqual({ ok: false, code: "insufficient_balance" });
    const again = await hold(person, budget, 1000, { jobId: job });
    expect(again.ok && again.replayed).toBe(true);
  });

  test("two concurrent grants with one key grant once", async () => {
    for (let round = 0; round < 10; round++) {
      const person = await ensurePool(d1, "account", String(300000 + next()), "cpu");
      const input = {
        poolId: person.id,
        amountMilli: 1234,
        actorUserId: 1,
        idempotencyKey: `race-grant-${next()}`,
      };
      const results = await Promise.all([grantPool(d1, input), grantPool(d1, input)]);
      expect(results.every((r) => r.ok)).toBe(true);
      expect(results.filter((r) => r.ok && !r.replayed)).toHaveLength(1);
      expect((await poolTotals(d1, person.id)).granted_milli).toBe(1234);
    }
  });
});

describe("a caller's own guard", () => {
  test("is part of the statement, so a limit of one live hold holds under a race", async () => {
    const { person, budget } = await scene(100000, 1000000);
    const limit = {
      sql: "(SELECT COUNT(*) FROM compute_ledger WHERE kind = 'hold' AND pool_id = ?) < ?",
      binds: [person.id, 1],
    };
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        placeHold(d1, {
          poolId: person.id,
          budgetPoolId: budget.id,
          amountMilli: 1000,
          jobId: jobId(next()),
          extraGuards: [limit],
        }),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    for (const r of results.filter((r) => !r.ok)) {
      expect(r).toEqual({ ok: false, code: "guard_refused" });
    }
    expect(await holdRows(person.id)).toBe(1);
    expect((await poolTotals(d1, person.id)).held_milli).toBe(1000);
  });
});

describe("closing a hold", () => {
  test("two concurrent settlements of one job write one charge", async () => {
    for (let round = 0; round < 10; round++) {
      const { person, budget } = await scene(10000, 100000);
      const job = jobId(next());
      expect((await hold(person, budget, 4000, { jobId: job })).ok).toBe(true);
      const results = await Promise.all([
        settleProvisional(d1, { jobId: job, chargeMilli: 3000 }),
        settleProvisional(d1, { jobId: job, chargeMilli: 4500 }),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.find((r) => !r.ok)).toEqual({
        ok: false,
        code: "hold_closed",
        closedBy: "settled",
      });
      const t = await poolTotals(d1, person.id);
      expect([t.held_milli, t.charged_milli === 3000 || t.charged_milli === 4500]).toEqual([
        0,
        true,
      ]);
      const entries = await d1
        .prepare("SELECT kind FROM compute_ledger WHERE job_id = ? AND kind <> 'hold'")
        .bind(job)
        .all<{ kind: string }>();
      expect(entries.results.filter((e) => e.kind === "charge")).toHaveLength(1);
    }
    expect(await totalsDisagreements(d1)).toEqual([]);
  });

  test("a release racing a settlement closes the hold once", async () => {
    for (let round = 0; round < 10; round++) {
      const { person, budget } = await scene(10000, 100000);
      const job = jobId(next());
      expect((await hold(person, budget, 4000, { jobId: job })).ok).toBe(true);
      const results = await Promise.all([
        releaseHold(d1, { jobId: job }),
        settleProvisional(d1, { jobId: job, chargeMilli: 1000 }),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect((await poolTotals(d1, person.id)).held_milli).toBe(0);
    }
    expect(await totalsDisagreements(d1)).toEqual([]);
  });

  test("two concurrent final settlements write one adjustment", async () => {
    const { person, budget } = await scene(10000, 100000);
    const job = jobId(next());
    expect((await hold(person, budget, 4000, { jobId: job })).ok).toBe(true);
    await settleProvisional(d1, { jobId: job, chargeMilli: 3000 });
    const results = await Promise.all([
      settleFinal(d1, { jobId: job, finalMilli: 3500 }),
      settleFinal(d1, { jobId: job, finalMilli: 3600 }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toEqual({ ok: false, code: "already_final" });
    const charged = (await poolTotals(d1, person.id)).charged_milli;
    expect([3500, 3600]).toContain(charged);
    expect(await totalsDisagreements(d1)).toEqual([]);
  });
});

describe("a crowd of mixed concurrent operations", () => {
  test("leaves every pool's totals equal to its ledger's sums, and none negative", async () => {
    const rand = seeded(7);
    const budget = await budgetWith(80000);
    const people: PoolRow[] = [];
    for (let i = 0; i < 4; i++) {
      const p = await ensurePool(d1, "account", String(300000 + next()), "cpu");
      await grant(p, 20000);
      people.push(p);
    }
    for (let wave = 0; wave < 6; wave++) {
      const jobs: string[] = [];
      const holds = people.flatMap((p) =>
        Array.from({ length: 4 }, () => {
          const job = jobId(next());
          jobs.push(job);
          return hold(p, budget, 1 + Math.floor(rand() * 9000), { jobId: job });
        }),
      );
      const settles = jobs
        .slice(0, 8)
        .map((job) =>
          settleProvisional(d1, { jobId: job, chargeMilli: Math.floor(rand() * 12000) }),
        );
      const releases = jobs.slice(8, 12).map((job) => releaseHold(d1, { jobId: job }));
      await Promise.all([...holds, ...settles, ...releases]);
      expect(await totalsDisagreements(d1), `wave ${wave}`).toEqual([]);
    }
    // Whatever interleaving happened, a stored total is never negative (the table refuses it).
    const negatives = await d1
      .prepare(
        "SELECT COUNT(*) AS n FROM compute_pools WHERE granted_milli < 0 OR held_milli < 0 OR charged_milli < 0",
      )
      .first<{ n: number }>();
    expect(negatives?.n).toBe(0);
  });
});

describe("every operation runs on D1 as it does on SQLite", () => {
  test("a whole life of a job, an adjustment and an expiry, with the totals equal to the ledger", async () => {
    const { person, budget } = await scene(20000, 100000);
    // The budget is shared by the file's tests, so what is pinned of it is what THIS test did.
    const budgetBefore = (await poolTotals(d1, budget.id)).charged_milli;
    const job = jobId(next());
    expect((await hold(person, budget, 6000, { jobId: job })).ok).toBe(true);
    // Used more than held: a charge, an overrun, and a negative-free pool.
    expect(await settleProvisional(d1, { jobId: job, chargeMilli: 7500 })).toMatchObject({
      ok: true,
      chargedMilli: 6000,
      overrunMilli: 1500,
      releasedMilli: 0,
    });
    expect(await settleFinal(d1, { jobId: job, finalMilli: 7000 })).toMatchObject({
      ok: true,
      deltaMilli: -500,
    });
    // Final settlement is the one entry that lowers the budget: it took 500 back from both.
    expect((await poolTotals(d1, person.id)).charged_milli).toBe(7000);
    expect((await poolTotals(d1, budget.id)).charged_milli).toBe(budgetBefore + 7000);
    const other = jobId(next());
    expect((await hold(person, budget, 2000, { jobId: other })).ok).toBe(true);
    expect(await releaseHold(d1, { jobId: other })).toMatchObject({
      ok: true,
      releasedMilli: 2000,
    });
    const adj = await adjustPool(d1, {
      poolId: person.id,
      budgetPoolId: budget.id,
      chargedDeltaMilli: 300,
      actorUserId: 1,
      reason: "correction",
      idempotencyKey: `race-adjust-${next()}`,
    });
    expect(adj.ok).toBe(true);
    // The people budget records consumption only: a correction that lowers the person's charge
    // moves the person alone, and one that names the budget for it is refused, here as on SQLite.
    const lower = (budgetPoolId: number | null) =>
      adjustPool(d1, {
        poolId: person.id,
        budgetPoolId,
        chargedDeltaMilli: -300,
        actorUserId: 1,
        reason: "correction",
        idempotencyKey: `race-adjust-${next()}`,
      });
    await expect(lower(budget.id)).rejects.toMatchObject({ code: "invalid_argument" });
    expect((await lower(null)).ok).toBe(true);
    expect((await poolTotals(d1, person.id)).charged_milli).toBe(7000);
    expect((await poolTotals(d1, budget.id)).charged_milli).toBe(budgetBefore + 7300);
    expect(
      await adjustPool(d1, {
        poolId: person.id,
        grantedDeltaMilli: -30000,
        actorUserId: 1,
        reason: "correction",
        idempotencyKey: `race-adjust-${next()}`,
      }),
    ).toEqual({ ok: false, code: "would_go_negative" });
    expect(
      await expireUnused(d1, { poolId: person.id, idempotencyKey: `race-expire-${next()}` }),
    ).toMatchObject({ ok: true, expiredMilli: 13000 });
    const t = await poolTotals(d1, person.id);
    expect([t.granted_milli, t.held_milli, t.charged_milli]).toEqual([7000, 0, 7000]);
    expect(await totalsDisagreements(d1)).toEqual([]);
  });

  test("an administrator's entry and its audit row are one batch, and a repeat writes no second row", async () => {
    const person = await ensurePool(d1, "account", String(300000 + next()), "cpu");
    const admin = await user("admin");
    const input = {
      poolId: person.id,
      amountMilli: 777,
      actorUserId: admin,
      reason: "top_up",
      idempotencyKey: `race-grant-${next()}`,
      audit: { userId: admin, action: `compute.pool.grant.d1.${next()}` },
    };
    const first = await grantPool(d1, input);
    const again = await grantPool(d1, input);
    expect(first.ok && again.ok && again.replayed).toBe(true);
    const rows = await d1
      .prepare("SELECT user_id, resource_id, details FROM audit_log WHERE action = ?")
      .bind(input.audit.action)
      .all<{ user_id: number; resource_id: string; details: string }>();
    expect(rows.results).toHaveLength(1);
    const audit = rows.results[0];
    expect(audit?.user_id).toBe(admin);
    expect(audit?.resource_id).toBe(String(person.id));
    expect(JSON.parse(audit?.details ?? "{}")).toMatchObject({
      entry_id: first.ok ? first.entry.id : -1,
      kind: "grant",
      granted_delta_milli: 777,
      reason: "top_up",
    });
  });

  test("a policy version and its audit row are one batch, and the version is the one the batch made", async () => {
    const owner = { id: await user("owner") };
    const policy = (await getPolicy(d1)).policy;
    const a = await putPolicy(
      d1,
      owner?.id ?? 0,
      { ...policy, maxLiveJobsPerPerson: 11 },
      "d1 test",
    );
    const b = await putPolicy(d1, owner?.id ?? 0, { ...policy, maxLiveJobsPerPerson: 12 }, null);
    expect(a.ok && b.ok && b.version === a.version + 1).toBe(true);
    const current = await getPolicy(d1);
    expect([current.version, current.policy.maxLiveJobsPerPerson, current.set_by]).toEqual([
      b.ok ? b.version : -1,
      12,
      owner?.id,
    ]);
    const audits = await d1
      .prepare(
        "SELECT resource_id FROM audit_log WHERE action = 'compute.policy.set' ORDER BY id DESC LIMIT 2",
      )
      .all<{ resource_id: string }>();
    expect(audits.results.map((r) => r.resource_id)).toEqual([
      String(b.ok ? b.version : -1),
      String(a.ok ? a.version : -1),
    ]);
    // Not an owner: nothing is written, not even an audit row.
    const before = await d1
      .prepare("SELECT COUNT(*) AS n FROM compute_policy")
      .first<{ n: number }>();
    expect(await putPolicy(d1, 987654321, policy, null)).toEqual({ ok: false, code: "not_owner" });
    const after = await d1
      .prepare("SELECT COUNT(*) AS n FROM compute_policy")
      .first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
  });
});
