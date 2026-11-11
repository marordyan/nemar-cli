/**
 * The compute ledger service (epic #2005 phase A2, #2007; ADR 0118), against the real migration on
 * a real database (bun:sqlite behind `realD1`). The trigger of migration 0114 is the one writer of
 * a pool's totals, so what is proven here is the service's behaviour on top of it and the property
 * the design rests on: after any sequence of operations every pool's three totals equal the sums of
 * its ledger deltas.
 *
 * What is pinned: a seeded random sequence of every operation leaves the totals equal to the
 * ledger's sums (and reaches the refusals, the overruns and a negative available, so it is not a
 * sequence that cannot fail); a settle then a final adjustment ends at the final figure, once;
 * excess use writes an `overrun` and a negative available but never a negative total; a hold closes
 * once whichever way it is closed; an adjustment and an expiry move what they say and refuse what
 * would make a total negative; the `people` budget records consumption only, so a correction that
 * lowers a charge never lowers it (the budget's own file is compute-ledger-budget.test.ts, and the
 * random sequence below checks the same of every entry it writes); an amount that is not a whole
 * number of milli-SU is
 * refused before anything is written; a hold that is not written leaves the database as it was; and
 * no source file or migration writes a pool's totals except the trigger.
 *
 * The concurrency of a hold is proven on Miniflare's D1 in compute-ledger-race.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import {
  ComputeLedgerError,
  type LedgerRow,
  type PoolRow,
  adjustPool,
  availableMilli,
  ensurePool,
  expireUnused,
  grantPool,
  holdStatements,
  placeHold,
  releaseHold,
  settleFinal,
  settleProvisional,
} from "../src/services/compute-ledger";
import { jobId, seeded, totalsDisagreements } from "./helpers/compute-ledger";
import { freshDb, realD1 } from "./helpers/d1";

const MAX = Number.MAX_SAFE_INTEGER;

let seq = 0;
const next = () => ++seq;

function world() {
  const db = freshDb();
  const d1 = realD1(db);
  return { db, d1 };
}
type World = ReturnType<typeof world>;

async function platform(w: World, key: "pipelines" | "people", pool: "cpu" | "gpu") {
  return ensurePool(w.d1, "platform", key, pool);
}

async function reread(w: World, pool: PoolRow): Promise<PoolRow> {
  return (await w.d1
    .prepare("SELECT * FROM compute_pools WHERE id = ?")
    .bind(pool.id)
    .first<PoolRow>()) as PoolRow;
}

async function grant(w: World, pool: PoolRow, amountMilli: number) {
  const r = await grantPool(w.d1, {
    poolId: pool.id,
    amountMilli,
    actorUserId: 1,
    idempotencyKey: `grant-${next()}`,
  });
  expect(r.ok).toBe(true);
}

/** A person with `grantMilli` cpu, a platform budget of `budgetMilli`, and a job held for `holdMilli`. */
async function held(
  w: World,
  o: { grantMilli?: number; budgetMilli?: number; holdMilli?: number },
) {
  const person = await ensurePool(w.d1, "account", String(10000 + next()), "cpu");
  const budget = await platform(w, "people", "cpu");
  await grant(w, person, o.grantMilli ?? 100000);
  if ((o.budgetMilli ?? 0) > 0) await grant(w, budget, o.budgetMilli as number);
  const job = jobId(next());
  const hold = await placeHold(w.d1, {
    poolId: person.id,
    budgetPoolId: budget.id,
    amountMilli: o.holdMilli ?? 5000,
    jobId: job,
  });
  return { person, budget, job, hold };
}

const count = async (w: World, where = "1 = 1") =>
  (
    await w.d1
      .prepare(`SELECT COUNT(*) AS n FROM compute_ledger WHERE ${where}`)
      .first<{ n: number }>()
  )?.n;

describe("availableMilli", () => {
  test("is granted minus held minus charged, and may be negative", () => {
    expect(availableMilli({ granted_milli: 10, held_milli: 3, charged_milli: 2 })).toBe(5);
    expect(availableMilli({ granted_milli: 10, held_milli: 0, charged_milli: 14 })).toBe(-4);
    expect(availableMilli({ granted_milli: 0, held_milli: 0, charged_milli: 0 })).toBe(0);
  });

  test("is exact at the largest total, where a double would not be", () => {
    expect(availableMilli({ granted_milli: MAX, held_milli: 0, charged_milli: MAX })).toBe(0);
    expect(availableMilli({ granted_milli: 0, held_milli: 0, charged_milli: MAX })).toBe(-MAX);
    expect(availableMilli({ granted_milli: MAX, held_milli: 1, charged_milli: 0 })).toBe(MAX - 1);
  });

  test("refuses a total that is not a whole number, and a result no double holds", () => {
    expect(() => availableMilli({ granted_milli: 1.5, held_milli: 0, charged_milli: 0 })).toThrow(
      RangeError,
    );
    expect(() =>
      availableMilli({ granted_milli: Number.NaN, held_milli: 0, charged_milli: 0 }),
    ).toThrow(RangeError);
    // Fractions that cancel are still not totals the table could have stored.
    expect(() => availableMilli({ granted_milli: 1.5, held_milli: 0.5, charged_milli: 0 })).toThrow(
      RangeError,
    );
    expect(() => availableMilli({ granted_milli: 0, held_milli: MAX, charged_milli: 2 })).toThrow(
      RangeError,
    );
    expect(() => availableMilli({ granted_milli: 0, held_milli: MAX, charged_milli: MAX })).toThrow(
      RangeError,
    );
  });
});

describe("ensurePool", () => {
  test("makes a pool once, with zero totals, and returns the same one again", async () => {
    const w = world();
    const a = await ensurePool(w.d1, "account", "77", "gpu");
    const b = await ensurePool(w.d1, "account", "77", "gpu");
    expect(b.id).toBe(a.id);
    expect([a.granted_milli, a.held_milli, a.charged_milli, a.frozen]).toEqual([0, 0, 0, 0]);
    expect((await ensurePool(w.d1, "account", "77", "cpu")).id).not.toBe(a.id);
    expect((await ensurePool(w.d1, "partner", "tenant", "cpu")).holder_kind).toBe("partner");
  });

  test("never changes the totals of a pool that has them", async () => {
    const w = world();
    const p = await ensurePool(w.d1, "account", "78", "cpu");
    await grant(w, p, 4000);
    const again = await ensurePool(w.d1, "account", "78", "cpu");
    expect(again.granted_milli).toBe(4000);
  });

  test("refuses a holder or a pool the table would, before writing", async () => {
    const w = world();
    for (const [kind, ref, pool] of [
      ["account", "abc", "cpu"],
      ["account", "012", "cpu"],
      ["partner", "has space", "cpu"],
      ["tenant", "x", "cpu"],
      ["account", "5", "tpu"],
    ] as const) {
      await expect(ensurePool(w.d1, kind as never, ref, pool as never)).rejects.toBeInstanceOf(
        ComputeLedgerError,
      );
    }
    expect(
      (await w.d1.prepare("SELECT COUNT(*) AS n FROM compute_pools").first<{ n: number }>())?.n,
    ).toBe(4);
  });
});

describe("a hold", () => {
  test("is one entry that takes the amount from the pool's and the budget's available", async () => {
    const w = world();
    const { person, budget, hold } = await held(w, { budgetMilli: 50000, holdMilli: 5000 });
    expect(hold.ok).toBe(true);
    if (!hold.ok) return;
    expect(hold.replayed).toBe(false);
    expect(hold.entry.kind).toBe("hold");
    expect(hold.entry.held_delta_milli).toBe(5000);
    expect(hold.entry.budget_pool_id).toBe(budget.id);
    expect(availableMilli(await reread(w, person))).toBe(95000);
    expect(availableMilli(await reread(w, budget))).toBe(45000);
    expect(await totalsDisagreements(w.d1)).toEqual([]);
  });

  test("takes exactly what is available, and no more", async () => {
    const w = world();
    const { person, budget } = await held(w, {
      grantMilli: 10000,
      budgetMilli: 50000,
      holdMilli: 6000,
    });
    const second = (milli: number) =>
      placeHold(w.d1, {
        poolId: person.id,
        budgetPoolId: budget.id,
        amountMilli: milli,
        jobId: jobId(next()),
      });
    expect(await second(4001)).toEqual({ ok: false, code: "insufficient_balance" });
    expect((await second(4000)).ok).toBe(true);
    expect(await second(1)).toEqual({ ok: false, code: "insufficient_balance" });
    expect(availableMilli(await reread(w, person))).toBe(0);
  });

  test("a pipelines hold names no budget: its own pool is the platform's", async () => {
    const w = world();
    const pipelines = await platform(w, "pipelines", "gpu");
    await grant(w, pipelines, 8000);
    const r = await placeHold(w.d1, {
      poolId: pipelines.id,
      budgetPoolId: null,
      amountMilli: 3000,
      jobId: jobId(next()),
    });
    expect(r.ok).toBe(true);
    expect(availableMilli(await reread(w, pipelines))).toBe(5000);
    expect(await totalsDisagreements(w.d1)).toEqual([]);
  });

  test("refuses a pool that does not exist, without writing", async () => {
    const w = world();
    const budget = await platform(w, "people", "cpu");
    await expect(
      placeHold(w.d1, {
        poolId: 987654,
        budgetPoolId: budget.id,
        amountMilli: 1,
        jobId: jobId(next()),
      }),
    ).rejects.toMatchObject({ code: "pool_not_found" });
    expect(await count(w)).toBe(0);
  });

  test("a hold of the same job again is a replay of the first, and moves no total", async () => {
    const w = world();
    const { person, budget, job, hold } = await held(w, { budgetMilli: 50000, holdMilli: 5000 });
    expect(hold.ok).toBe(true);
    if (!hold.ok) return;
    const again = await placeHold(w.d1, {
      poolId: person.id,
      budgetPoolId: budget.id,
      amountMilli: 5000,
      jobId: job,
    });
    expect(again).toEqual({ ok: true, replayed: true, entry: hold.entry });
    expect(await count(w, "kind = 'hold'")).toBe(1);
    expect(availableMilli(await reread(w, person))).toBe(95000);
  });

  test("a spend on an account pool that names no budget is refused by the table, and writes nothing", async () => {
    const w = world();
    const person = await ensurePool(w.d1, "account", "32", "cpu");
    await grant(w, person, 9000);
    const before = await count(w);
    await expect(
      placeHold(w.d1, {
        poolId: person.id,
        budgetPoolId: null,
        amountMilli: 1,
        jobId: jobId(next()),
      }),
    ).rejects.toThrow(/names the platform people budget/);
    expect(await count(w)).toBe(before);
  });

  test("composes into a batch: a statement after it that checks changes() runs only if it was written", async () => {
    const w = world();
    const person = await ensurePool(w.d1, "account", "32", "cpu");
    const budget = await platform(w, "people", "cpu");
    await grant(w, person, 3000);
    await grant(w, budget, 3000);
    const markIfHeld = (tag: string) =>
      w.d1
        .prepare(
          "INSERT INTO audit_log (user_id, action, resource_type, resource_id) SELECT NULL, ?, 'test', 'x' WHERE changes() > 0",
        )
        .bind(tag);
    const make = (amount: number, tag: string) =>
      w.d1.batch([
        ...holdStatements(w.d1, {
          poolId: person.id,
          budgetPoolId: budget.id,
          amountMilli: amount,
          jobId: jobId(next()),
        }),
        markIfHeld(tag),
      ]);
    await make(2000, "compute-test-first");
    await make(2000, "compute-test-refused");
    const tags = w.db
      .query("SELECT action FROM audit_log WHERE action LIKE 'compute-test-%' ORDER BY id")
      .all() as Array<{ action: string }>;
    expect(tags.map((t) => t.action)).toEqual(["compute-test-first"]);
  });

  describe("a caller's own guard", () => {
    const limitedTo = (n: number, poolId: number) => ({
      sql: "(SELECT COUNT(*) FROM compute_ledger WHERE kind = 'hold' AND pool_id = ?) < ?",
      binds: [poolId, n],
    });

    test("is part of the statement's WHERE: a hold it refuses writes nothing", async () => {
      const w = world();
      const person = await ensurePool(w.d1, "account", "33", "cpu");
      const budget = await platform(w, "people", "cpu");
      await grant(w, person, 90000);
      await grant(w, budget, 90000);
      const place = () =>
        placeHold(w.d1, {
          poolId: person.id,
          budgetPoolId: budget.id,
          amountMilli: 1000,
          jobId: jobId(next()),
          extraGuards: [limitedTo(2, person.id)],
        });
      expect((await place()).ok).toBe(true);
      expect((await place()).ok).toBe(true);
      const before = await count(w);
      expect(await place()).toEqual({ ok: false, code: "guard_refused" });
      expect(await count(w)).toBe(before);
      expect(availableMilli(await reread(w, person))).toBe(88000);
    });

    test("is bound after the statement's own parameters, and a guard that misuses them is refused", async () => {
      const w = world();
      const person = await ensurePool(w.d1, "account", "34", "cpu");
      const budget = await platform(w, "people", "cpu");
      const input = {
        poolId: person.id,
        budgetPoolId: budget.id,
        amountMilli: 1,
        jobId: jobId(next()),
      };
      for (const bad of [
        { sql: "? = ?", binds: [1] },
        { sql: "?1 = ?", binds: [1, 2] },
        { sql: "1 = 1", binds: [1] },
      ]) {
        expect(() => holdStatements(w.d1, { ...input, extraGuards: [bad] })).toThrow(
          ComputeLedgerError,
        );
      }
      expect(await count(w)).toBe(0);
    });
  });
});

describe("a refused hold writes nothing", () => {
  /** Every table's row count and the pools as they are: a refused hold leaves all of it alone. */
  function snapshot(w: World): string {
    const counts = ["compute_ledger", "audit_log", "compute_policy"].map(
      (t) => (w.db.query(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n,
    );
    const pools = w.db.query("SELECT * FROM compute_pools ORDER BY id").all();
    return JSON.stringify({ counts, pools });
  }

  test("for want of balance, of budget, of a thaw, or of a guard", async () => {
    const w = world();
    const person = await ensurePool(w.d1, "account", "41", "cpu");
    const budget = await platform(w, "people", "cpu");
    await grant(w, person, 1000);
    await grant(w, budget, 500);
    const place = (amount: number, poolId = person.id, guards: unknown[] = []) =>
      placeHold(w.d1, {
        poolId,
        budgetPoolId: budget.id,
        amountMilli: amount,
        jobId: jobId(next()),
        extraGuards: guards as never,
      });
    const before = snapshot(w);
    expect(await place(1001)).toEqual({ ok: false, code: "insufficient_balance" });
    expect(await place(501)).toEqual({ ok: false, code: "platform_budget_exhausted" });
    expect(await place(10, person.id, [{ sql: "0 = 1" }])).toEqual({
      ok: false,
      code: "guard_refused",
    });
    expect(snapshot(w)).toBe(before);
    w.db.run("UPDATE compute_pools SET frozen = 1 WHERE id = ?", [person.id]);
    const frozen = snapshot(w);
    expect(await place(10)).toEqual({ ok: false, code: "suspended" });
    expect(snapshot(w)).toBe(frozen);
  });

  test("a frozen pool is suspended before it is short, and a short pool before a short budget", async () => {
    const w = world();
    const person = await ensurePool(w.d1, "account", "42", "cpu");
    const budget = await platform(w, "people", "cpu");
    const input = (amount: number) => ({
      poolId: person.id,
      budgetPoolId: budget.id,
      amountMilli: amount,
      jobId: jobId(next()),
    });
    // Nothing granted to either: the person is short first.
    expect(await placeHold(w.d1, input(1))).toEqual({ ok: false, code: "insufficient_balance" });
    w.db.run("UPDATE compute_pools SET frozen = 1 WHERE id = ?", [person.id]);
    expect(await placeHold(w.d1, input(1))).toEqual({ ok: false, code: "suspended" });
    w.db.run("UPDATE compute_pools SET frozen = 0 WHERE id = ?", [person.id]);
    await grant(w, person, 100);
    expect(await placeHold(w.d1, input(1))).toEqual({
      ok: false,
      code: "platform_budget_exhausted",
    });
  });
});

describe("integer thousandths only", () => {
  const BAD = [
    1.5,
    0.1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -1,
    0,
    MAX + 1,
    "5",
    null,
    undefined,
  ];

  test("a hold, a grant, an adjustment and a settlement refuse any amount that is not a whole number", async () => {
    const w = world();
    const person = await ensurePool(w.d1, "account", "51", "cpu");
    const budget = await platform(w, "people", "cpu");
    await grant(w, person, 100000);
    await grant(w, budget, 100000);
    const { job } = await held(w, { budgetMilli: 10000 });
    const before = await count(w);
    for (const bad of BAD) {
      const amount = bad as number;
      const attempts: Array<[string, () => Promise<unknown>]> = [
        [
          "hold",
          () =>
            placeHold(w.d1, {
              poolId: person.id,
              budgetPoolId: budget.id,
              amountMilli: amount,
              jobId: jobId(next()),
            }),
        ],
        [
          "grant",
          () =>
            grantPool(w.d1, {
              poolId: person.id,
              amountMilli: amount,
              actorUserId: 1,
              idempotencyKey: `grant-${next()}`,
            }),
        ],
        [
          "adjust of the grant",
          () =>
            adjustPool(w.d1, {
              poolId: person.id,
              grantedDeltaMilli: amount,
              actorUserId: 1,
              reason: "correction",
              idempotencyKey: `adjust-${next()}`,
            }),
        ],
        ["settle", () => settleProvisional(w.d1, { jobId: job, chargeMilli: amount })],
        ["final", () => settleFinal(w.d1, { jobId: job, finalMilli: amount })],
      ];
      /** Whether this operation takes the value, so the attempt would be a real write. */
      const takes = (name: string): boolean => {
        const whole = Number.isSafeInteger(amount);
        if (name === "hold" || name === "grant") return whole && amount >= 1;
        if (name === "adjust of the grant") return whole && amount !== 0;
        return whole && amount >= 0;
      };
      for (const [name, run] of attempts) {
        if (takes(name)) continue;
        await expect(run(), `${name} ${String(amount)}`).rejects.toMatchObject({
          code: "invalid_argument",
        });
      }
    }
    expect(await count(w)).toBe(before);
  });

  test("a pool id that is not a positive whole number is refused before anything is written", async () => {
    const w = world();
    const budget = await platform(w, "people", "cpu");
    for (const poolId of [
      1.5,
      0,
      -1,
      Number.NaN,
      "1" as unknown as number,
      null as unknown as number,
    ]) {
      await expect(
        placeHold(w.d1, {
          poolId,
          budgetPoolId: budget.id,
          amountMilli: 1,
          jobId: jobId(next()),
        }),
      ).rejects.toMatchObject({ code: "invalid_argument" });
      await expect(
        grantPool(w.d1, {
          poolId,
          amountMilli: 1,
          actorUserId: 1,
          idempotencyKey: `grant-${next()}`,
        }),
      ).rejects.toMatchObject({ code: "invalid_argument" });
    }
    await expect(
      placeHold(w.d1, {
        poolId: budget.id,
        budgetPoolId: 1.5,
        amountMilli: 1,
        jobId: jobId(next()),
      }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(
      grantPool(w.d1, {
        poolId: budget.id,
        amountMilli: 1,
        actorUserId: 1.5,
        idempotencyKey: `grant-${next()}`,
      }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    expect(await count(w)).toBe(0);
  });

  test("a negative charge or final figure is refused, and 0 is a charge", async () => {
    const w = world();
    const { job } = await held(w, { budgetMilli: 10000 });
    await expect(settleProvisional(w.d1, { jobId: job, chargeMilli: -1 })).rejects.toMatchObject({
      code: "invalid_argument",
    });
    const r = await settleProvisional(w.d1, { jobId: job, chargeMilli: 0 });
    expect(r).toMatchObject({ ok: true, chargedMilli: 0, releasedMilli: 5000, overrunMilli: 0 });
  });

  test("a job id, a key and a reason that the table would refuse (and a key the ledger writes) are refused first", async () => {
    const w = world();
    const person = await ensurePool(w.d1, "account", "52", "cpu");
    const budget = await platform(w, "people", "cpu");
    const hold = (over: Record<string, unknown>) =>
      placeHold(w.d1, {
        poolId: person.id,
        budgetPoolId: budget.id,
        amountMilli: 1,
        jobId: jobId(next()),
        ...over,
      } as never);
    await expect(hold({ jobId: "job_nope" })).rejects.toMatchObject({ code: "invalid_argument" });
    for (const idempotencyKey of ["has space", "", "k".repeat(129), "job:x", "hold:1:charge"]) {
      await expect(
        grantPool(w.d1, { poolId: person.id, amountMilli: 1, actorUserId: 1, idempotencyKey }),
      ).rejects.toMatchObject({ code: "invalid_argument" });
    }
    await expect(
      grantPool(w.d1, {
        poolId: person.id,
        amountMilli: 1,
        actorUserId: 1,
        reason: "Not A Word",
        idempotencyKey: `grant-${next()}`,
      }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(releaseHold(w.d1, { jobId: "nope" })).rejects.toMatchObject({
      code: "invalid_argument",
    });
    expect(await count(w)).toBe(0);
  });
});

describe("a release", () => {
  test("gives the whole hold back, to the pool and to the budget", async () => {
    const w = world();
    const { person, budget, job } = await held(w, { budgetMilli: 50000, holdMilli: 7000 });
    const r = await releaseHold(w.d1, { jobId: job, reason: "never_started" });
    expect(r).toMatchObject({ ok: true, releasedMilli: 7000 });
    expect(availableMilli(await reread(w, person))).toBe(100000);
    expect(availableMilli(await reread(w, budget))).toBe(50000);
    const e = w.db.query("SELECT * FROM compute_ledger WHERE kind = 'release'").get() as LedgerRow;
    expect([e.held_delta_milli, e.reason, e.job_id]).toEqual([-7000, "never_started", job]);
    expect(await totalsDisagreements(w.d1)).toEqual([]);
  });
});

describe("a hold closes once", () => {
  /**
   * Close a hold one way, then try every way of closing it again: the same step is a replay of the
   * first (it writes nothing), the other step is `hold_closed` and says which closed it, and a
   * settlement with another figure is `hold_closed` too. Nothing moves in any of them.
   */
  const closedTwice = async (first: "release" | "settle") => {
    const w = world();
    const { person, budget, job } = await held(w, { budgetMilli: 50000, holdMilli: 5000 });
    const run = (which: "release" | "settle", chargeMilli = 3000) =>
      which === "release"
        ? releaseHold(w.d1, { jobId: job })
        : settleProvisional(w.d1, { jobId: job, chargeMilli });
    const firstResult = await run(first);
    expect(firstResult).toMatchObject({ ok: true, replayed: false });
    const entries = await count(w);
    const poolAfter = await reread(w, person);
    const budgetAfter = await reread(w, budget);
    const by = first === "release" ? "released" : "settled";
    const other = first === "release" ? "settle" : "release";
    expect(await run(first)).toEqual({ ...(firstResult as object), replayed: true });
    expect(await run(other)).toEqual({ ok: false, code: "hold_closed", closedBy: by });
    expect(await run("settle", 99999)).toEqual({ ok: false, code: "hold_closed", closedBy: by });
    expect(await count(w)).toBe(entries);
    expect(await reread(w, person)).toEqual(poolAfter);
    expect(await reread(w, budget)).toEqual(budgetAfter);
    expect(await totalsDisagreements(w.d1)).toEqual([]);
  };

  test("a settle is replayed by the same step, and refuses the other", async () => {
    await closedTwice("settle");
  });

  test("a release is replayed by the same step, and refuses the other", async () => {
    await closedTwice("release");
  });

  test("a job that was never held has nothing to close", async () => {
    const w = world();
    const job = jobId(next());
    expect(await releaseHold(w.d1, { jobId: job })).toEqual({ ok: false, code: "no_hold" });
    expect(await settleProvisional(w.d1, { jobId: job, chargeMilli: 1 })).toEqual({
      ok: false,
      code: "no_hold",
    });
    expect(await count(w)).toBe(0);
  });
});

describe("a provisional settlement", () => {
  test("charges what was used, releases the rest, and never writes an overrun for less", async () => {
    const w = world();
    const { person, budget, job } = await held(w, { budgetMilli: 50000, holdMilli: 5000 });
    const r = await settleProvisional(w.d1, { jobId: job, chargeMilli: 3200 });
    expect(r).toMatchObject({
      ok: true,
      holdMilli: 5000,
      chargedMilli: 3200,
      releasedMilli: 1800,
      overrunMilli: 0,
    });
    const p = await reread(w, person);
    expect([p.held_milli, p.charged_milli, availableMilli(p)]).toEqual([0, 3200, 96800]);
    const b = await reread(w, budget);
    expect([b.held_milli, b.charged_milli]).toEqual([0, 3200]);
    expect(await count(w, "kind = 'overrun'")).toBe(0);
    const charge = w.db
      .query("SELECT * FROM compute_ledger WHERE kind = 'charge'")
      .get() as LedgerRow;
    expect([charge.held_delta_milli, charge.charged_delta_milli]).toEqual([-5000, 3200]);
    expect(await totalsDisagreements(w.d1)).toEqual([]);
  });

  test("an exact hold is a charge of all of it", async () => {
    const w = world();
    const { person, job } = await held(w, { budgetMilli: 50000, holdMilli: 5000 });
    expect(await settleProvisional(w.d1, { jobId: job, chargeMilli: 5000 })).toMatchObject({
      releasedMilli: 0,
      overrunMilli: 0,
    });
    expect((await reread(w, person)).charged_milli).toBe(5000);
  });

  test("excess use writes an overrun, may make available negative, and never a stored total", async () => {
    const w = world();
    const { person, budget, job } = await held(w, {
      grantMilli: 6000,
      budgetMilli: 20000,
      holdMilli: 5000,
    });
    const r = await settleProvisional(w.d1, { jobId: job, chargeMilli: 8000 });
    expect(r).toMatchObject({
      ok: true,
      chargedMilli: 5000,
      releasedMilli: 0,
      overrunMilli: 3000,
    });
    const p = await reread(w, person);
    expect([p.granted_milli, p.held_milli, p.charged_milli]).toEqual([6000, 0, 8000]);
    expect(availableMilli(p)).toBe(-2000);
    const b = await reread(w, budget);
    expect([b.held_milli, b.charged_milli]).toEqual([0, 8000]);
    const overrun = w.db
      .query("SELECT * FROM compute_ledger WHERE kind = 'overrun'")
      .get() as LedgerRow;
    expect([overrun.charged_delta_milli, overrun.job_id, overrun.budget_pool_id]).toEqual([
      3000,
      job,
      budget.id,
    ]);
    // Negative available is a balance that refuses a hold, not a state the pool cannot be in.
    expect(
      await placeHold(w.d1, {
        poolId: person.id,
        budgetPoolId: budget.id,
        amountMilli: 1,
        jobId: jobId(next()),
      }),
    ).toEqual({ ok: false, code: "insufficient_balance" });
    // Until a grant brings it back above zero.
    await grant(w, person, 2001);
    expect(availableMilli(await reread(w, person))).toBe(1);
    expect(await totalsDisagreements(w.d1)).toEqual([]);
  });
});

describe("the final settlement", () => {
  const settle = async (w: World, job: string, charge: number) =>
    settleProvisional(w.d1, { jobId: job, chargeMilli: charge });

  test("a final figure above the provisional one is an adjustment of the difference, and ends there", async () => {
    const w = world();
    const { person, budget, job } = await held(w, { budgetMilli: 50000, holdMilli: 5000 });
    await settle(w, job, 3000);
    const r = await settleFinal(w.d1, { jobId: job, finalMilli: 3500 });
    expect(r).toMatchObject({ ok: true, deltaMilli: 500 });
    const entry = w.db
      .query("SELECT * FROM compute_ledger WHERE kind = 'adjust'")
      .get() as LedgerRow;
    expect([entry.charged_delta_milli, entry.granted_delta_milli, entry.job_id]).toEqual([
      500,
      0,
      job,
    ]);
    expect((await reread(w, person)).charged_milli).toBe(3500);
    expect((await reread(w, budget)).charged_milli).toBe(3500);
    expect(await totalsDisagreements(w.d1)).toEqual([]);
  });

  test("a final figure below it takes the difference back", async () => {
    const w = world();
    const { person, budget, job } = await held(w, { budgetMilli: 50000, holdMilli: 5000 });
    await settle(w, job, 3000);
    expect(await settleFinal(w.d1, { jobId: job, finalMilli: 2000 })).toMatchObject({
      ok: true,
      deltaMilli: -1000,
    });
    expect((await reread(w, person)).charged_milli).toBe(2000);
    expect((await reread(w, budget)).charged_milli).toBe(2000);
  });

  test("counts an overrun in what was charged, so the final figure is the job's whole charge", async () => {
    const w = world();
    const { person, job } = await held(w, { budgetMilli: 50000, holdMilli: 5000 });
    await settle(w, job, 7000);
    expect((await reread(w, person)).charged_milli).toBe(7000);
    expect(await settleFinal(w.d1, { jobId: job, finalMilli: 6000 })).toMatchObject({
      deltaMilli: -1000,
    });
    expect((await reread(w, person)).charged_milli).toBe(6000);
    expect(await totalsDisagreements(w.d1)).toEqual([]);
  });

  test("is once per job: another figure writes nothing, and the same figure is a replay", async () => {
    const w = world();
    const { person, job } = await held(w, { budgetMilli: 50000, holdMilli: 5000 });
    await settle(w, job, 3000);
    await settleFinal(w.d1, { jobId: job, finalMilli: 3500 });
    const entries = await count(w);
    expect(await settleFinal(w.d1, { jobId: job, finalMilli: 3500 })).toMatchObject({
      ok: true,
      replayed: true,
    });
    expect(await settleFinal(w.d1, { jobId: job, finalMilli: 9000 })).toEqual({
      ok: false,
      code: "already_final",
    });
    expect(await count(w)).toBe(entries);
    expect((await reread(w, person)).charged_milli).toBe(3500);
  });

  test("needs the hold to have been settled: not before, not after a release", async () => {
    const w = world();
    const open = await held(w, { budgetMilli: 50000, holdMilli: 5000 });
    expect(await settleFinal(w.d1, { jobId: open.job, finalMilli: 100 })).toEqual({
      ok: false,
      code: "not_settled",
    });
    await releaseHold(w.d1, { jobId: open.job });
    expect(await settleFinal(w.d1, { jobId: open.job, finalMilli: 100 })).toEqual({
      ok: false,
      code: "not_settled",
    });
    expect(await settleFinal(w.d1, { jobId: jobId(next()), finalMilli: 100 })).toEqual({
      ok: false,
      code: "not_settled",
    });
  });
});

describe("a final figure after an administrator corrected the charge", () => {
  test("a final figure that would take it below zero is would_go_negative and writes nothing", async () => {
    const w = world();
    const { person, budget, job } = await held(w, { budgetMilli: 50000, holdMilli: 5000 });
    await settleProvisional(w.d1, { jobId: job, chargeMilli: 4000 });
    // The correction lowers the person's charge alone: the budget keeps the 4000 it recorded.
    await adjustPool(w.d1, {
      poolId: person.id,
      chargedDeltaMilli: -3000,
      actorUserId: 9,
      reason: "correction",
      idempotencyKey: `adjust-${next()}`,
    });
    expect((await reread(w, budget)).charged_milli).toBe(4000);
    const entries = await count(w);
    // Expanse says the job cost 500: 3500 less than the 4000 charged, and the pool holds 1000.
    expect(await settleFinal(w.d1, { jobId: job, finalMilli: 500 })).toEqual({
      ok: false,
      code: "would_go_negative",
    });
    expect(await count(w)).toBe(entries);
    // A figure the pool can take still settles.
    expect(await settleFinal(w.d1, { jobId: job, finalMilli: 3500 })).toMatchObject({
      ok: true,
      deltaMilli: -500,
    });
    expect((await reread(w, person)).charged_milli).toBe(500);
    // The final settlement is the one entry that lowers the budget: it corrects the figure.
    expect((await reread(w, budget)).charged_milli).toBe(3500);
    expect(await totalsDisagreements(w.d1)).toEqual([]);
  });
});

describe("a correction the platform budget could not follow", () => {
  /** A settled job whose budget the owner then corrected down, so the budget holds less than the person. */
  async function budgetCorrectedDown() {
    const w = world();
    const { person, budget, job } = await held(w, { budgetMilli: 50000, holdMilli: 5000 });
    await settleProvisional(w.d1, { jobId: job, chargeMilli: 4000 });
    // The owner takes 3500 of the budget's charge back, leaving 500: the person still holds 4000.
    expect(
      (
        await adjustPool(w.d1, {
          poolId: budget.id,
          chargedDeltaMilli: -3500,
          actorUserId: 9,
          reason: "correction",
          idempotencyKey: `adjust-${next()}`,
        })
      ).ok,
    ).toBe(true);
    return { w, person, budget, job };
  }

  test("a final figure the budget cannot take is would_go_negative, though the person could", async () => {
    const { w, person, job } = await budgetCorrectedDown();
    const entries = await count(w);
    expect(await settleFinal(w.d1, { jobId: job, finalMilli: 2500 })).toEqual({
      ok: false,
      code: "would_go_negative",
    });
    expect(await count(w)).toBe(entries);
    expect((await reread(w, person)).charged_milli).toBe(4000);
    // A smaller correction the budget can take still settles.
    expect(await settleFinal(w.d1, { jobId: job, finalMilli: 3600 })).toMatchObject({
      ok: true,
      deltaMilli: -400,
    });
    expect(await totalsDisagreements(w.d1)).toEqual([]);
  });

  test("a correction downward of a person's charge does not need the budget to hold it", async () => {
    const w = world();
    const person = await ensurePool(w.d1, "account", "81", "cpu");
    const budget = await platform(w, "people", "cpu");
    // The person has 500 charged, and the owner then took the budget's charge back: the person
    // holds what the budget no longer does. Lowering the person's charge never touches the
    // budget, so it is not refused for the budget's sake (option B would have refused it).
    await grant(w, person, 1000);
    const charge = (poolId: number, budgetPoolId: number | null, chargedDeltaMilli: number) =>
      adjustPool(w.d1, {
        poolId,
        budgetPoolId,
        chargedDeltaMilli,
        actorUserId: 9,
        reason: "correction",
        idempotencyKey: `adjust-${next()}`,
      });
    expect((await charge(person.id, budget.id, 500)).ok).toBe(true);
    expect((await charge(budget.id, null, -500)).ok).toBe(true);
    const before = await count(w);
    const lowered = await charge(person.id, null, -500);
    expect(lowered).toMatchObject({ ok: true });
    expect(await count(w)).toBe(before + 1);
    expect((await reread(w, person)).charged_milli).toBe(0);
    expect((await reread(w, budget)).charged_milli).toBe(0);
    expect(await totalsDisagreements(w.d1)).toEqual([]);
  });
});

describe("an administrator's grant and adjustment", () => {
  test("a grant adds to granted, with who did it and why", async () => {
    const w = world();
    const p = await ensurePool(w.d1, "account", "61", "cpu");
    const r = await grantPool(w.d1, {
      poolId: p.id,
      amountMilli: 12500,
      actorUserId: 9,
      reason: "top_up",
      idempotencyKey: "grant-61-a",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect([
      r.replayed,
      r.entry.granted_delta_milli,
      r.entry.actor_user_id,
      r.entry.reason,
    ]).toEqual([false, 12500, 9, "top_up"]);
    expect((await reread(w, p)).granted_milli).toBe(12500);
  });

  test("a repeated key grants once, and the same key for another amount is a conflict", async () => {
    const w = world();
    const p = await ensurePool(w.d1, "account", "62", "cpu");
    const input = { poolId: p.id, amountMilli: 1000, actorUserId: 9, idempotencyKey: "grant-62-a" };
    const first = await grantPool(w.d1, input);
    const again = await grantPool(w.d1, input);
    expect(first.ok && again.ok && again.replayed && !first.replayed).toBe(true);
    if (first.ok && again.ok) expect(again.entry).toEqual(first.entry);
    await expect(grantPool(w.d1, { ...input, amountMilli: 2000 })).rejects.toMatchObject({
      code: "idempotency_conflict",
    });
    await expect(grantPool(w.d1, { ...input, poolId: p.id + 1 })).rejects.toMatchObject({
      code: "idempotency_conflict",
    });
    expect((await reread(w, p)).granted_milli).toBe(1000);
    expect(await count(w)).toBe(1);
  });

  test("a grant to a pool that does not exist is refused", async () => {
    const w = world();
    await expect(
      grantPool(w.d1, {
        poolId: 99999,
        amountMilli: 1,
        actorUserId: 1,
        idempotencyKey: "grant-63-a",
      }),
    ).rejects.toMatchObject({ code: "pool_not_found" });
    expect(await count(w)).toBe(0);
  });

  test("an adjustment corrects the grant or the charge, either way, and exactly one of them", async () => {
    const w = world();
    const p = await ensurePool(w.d1, "account", "64", "cpu");
    const people = await platform(w, "people", "cpu");
    await grant(w, p, 10000);
    // A charge raised on an account's pool names the people budget; one lowered names none.
    const adjust = (over: Record<string, unknown>) =>
      adjustPool(w.d1, {
        poolId: p.id,
        budgetPoolId: Number(over.chargedDeltaMilli) > 0 ? people.id : null,
        actorUserId: 9,
        reason: "correction",
        idempotencyKey: `adjust-${next()}`,
        ...over,
      } as never);
    expect((await adjust({ grantedDeltaMilli: -2500 })).ok).toBe(true);
    expect((await adjust({ chargedDeltaMilli: 700 })).ok).toBe(true);
    expect((await adjust({ chargedDeltaMilli: -200 })).ok).toBe(true);
    const row = await reread(w, p);
    expect([row.granted_milli, row.held_milli, row.charged_milli]).toEqual([7500, 0, 500]);
    await expect(adjust({})).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(adjust({ grantedDeltaMilli: 0, chargedDeltaMilli: 0 })).rejects.toMatchObject({
      code: "invalid_argument",
    });
    await expect(adjust({ grantedDeltaMilli: 1, chargedDeltaMilli: 1 })).rejects.toMatchObject({
      code: "invalid_argument",
    });
    // An explicit 0 for the field that is not changing is a mistake, not a way to say nothing.
    await expect(adjust({ grantedDeltaMilli: 0, chargedDeltaMilli: 5 })).rejects.toMatchObject({
      code: "invalid_argument",
    });
    await expect(adjust({ grantedDeltaMilli: 1, reason: undefined })).rejects.toMatchObject({
      code: "invalid_argument",
    });
    expect(await totalsDisagreements(w.d1)).toEqual([]);
  });

  test("an adjustment that would make a stored total negative is refused and writes nothing", async () => {
    const w = world();
    const p = await ensurePool(w.d1, "account", "65", "cpu");
    await grant(w, p, 1000);
    const before = await count(w);
    for (const over of [
      { grantedDeltaMilli: -1001 },
      { chargedDeltaMilli: -1 },
      { grantedDeltaMilli: -MAX },
    ]) {
      expect(
        await adjustPool(w.d1, {
          poolId: p.id,
          actorUserId: 9,
          reason: "correction",
          idempotencyKey: `adjust-${next()}`,
          ...over,
        }),
      ).toEqual({ ok: false, code: "would_go_negative" });
    }
    expect(await count(w)).toBe(before);
    expect(await reread(w, p)).toMatchObject({ granted_milli: 1000, charged_milli: 0 });
  });

  test("an adjustment of the grant below what is used makes available negative, not a total", async () => {
    const w = world();
    const { person, job } = await held(w, {
      grantMilli: 10000,
      budgetMilli: 50000,
      holdMilli: 4000,
    });
    await settleProvisional(w.d1, { jobId: job, chargeMilli: 4000 });
    const r = await adjustPool(w.d1, {
      poolId: person.id,
      grantedDeltaMilli: -9000,
      actorUserId: 9,
      reason: "correction",
      idempotencyKey: "adjust-65-a",
    });
    expect(r.ok).toBe(true);
    expect(availableMilli(await reread(w, person))).toBe(-3000);
  });

  test("an adjustment of the charge of an account's pool raises the platform budget with it, and lowering it leaves the budget", async () => {
    const w = world();
    const { person, budget, job } = await held(w, { budgetMilli: 50000, holdMilli: 4000 });
    await settleProvisional(w.d1, { jobId: job, chargeMilli: 4000 });
    const adjust = (delta: number) =>
      adjustPool(w.d1, {
        poolId: person.id,
        budgetPoolId: delta > 0 ? budget.id : null,
        chargedDeltaMilli: delta,
        actorUserId: 9,
        reason: "correction",
        idempotencyKey: `adjust-${next()}`,
      });
    expect((await adjust(1000)).ok).toBe(true);
    expect((await reread(w, budget)).charged_milli).toBe(5000);
    // Taking 5000 back leaves the pool at 0 and the budget at the 5000 it recorded as consumed.
    expect((await adjust(-5000)).ok).toBe(true);
    expect((await reread(w, person)).charged_milli).toBe(0);
    expect((await reread(w, budget)).charged_milli).toBe(5000);
    // More than the pool has charged would put the POOL below zero, whatever the budget holds.
    expect(await adjust(-1)).toEqual({ ok: false, code: "would_go_negative" });
    expect(await totalsDisagreements(w.d1)).toEqual([]);
  });

  test("an adjustment of the grant never names a budget", async () => {
    const w = world();
    const p = await ensurePool(w.d1, "account", "66", "cpu");
    const budget = await platform(w, "people", "cpu");
    await grant(w, p, 100);
    await expect(
      adjustPool(w.d1, {
        poolId: p.id,
        budgetPoolId: budget.id,
        grantedDeltaMilli: 5,
        actorUserId: 9,
        reason: "correction",
        idempotencyKey: `adjust-${next()}`,
      }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  });

  test("a repeated adjustment key adjusts once", async () => {
    const w = world();
    const p = await ensurePool(w.d1, "account", "67", "cpu");
    await grant(w, p, 1000);
    const input = {
      poolId: p.id,
      grantedDeltaMilli: 500,
      actorUserId: 9,
      reason: "correction",
      idempotencyKey: "adjust-67-a",
    };
    const a = await adjustPool(w.d1, input);
    const b = await adjustPool(w.d1, input);
    expect(a.ok && b.ok && !a.replayed && b.replayed).toBe(true);
    expect((await reread(w, p)).granted_milli).toBe(1500);
    await expect(adjustPool(w.d1, { ...input, grantedDeltaMilli: 501 })).rejects.toMatchObject({
      code: "idempotency_conflict",
    });
  });
});

describe("expiry of unused SU", () => {
  test("takes the unused balance out of granted and leaves what is held and charged", async () => {
    const w = world();
    const { person, job } = await held(w, {
      grantMilli: 10000,
      budgetMilli: 50000,
      holdMilli: 3000,
    });
    const r = await expireUnused(w.d1, { poolId: person.id, idempotencyKey: "expire-71-a" });
    expect(r).toMatchObject({ ok: true, replayed: false, expiredMilli: 7000 });
    const p = await reread(w, person);
    expect([p.granted_milli, p.held_milli, availableMilli(p)]).toEqual([3000, 3000, 0]);
    // The job the hold is for still settles.
    expect(await settleProvisional(w.d1, { jobId: job, chargeMilli: 2000 })).toMatchObject({
      ok: true,
    });
    expect(await totalsDisagreements(w.d1)).toEqual([]);
  });

  test("has nothing to take from a pool with no unused balance, and is replayed by its key", async () => {
    const w = world();
    const p = await ensurePool(w.d1, "account", "72", "cpu");
    expect(await expireUnused(w.d1, { poolId: p.id, idempotencyKey: "expire-72-a" })).toEqual({
      ok: false,
      code: "nothing_to_expire",
    });
    await grant(w, p, 500);
    const first = await expireUnused(w.d1, { poolId: p.id, idempotencyKey: "expire-72-b" });
    const again = await expireUnused(w.d1, { poolId: p.id, idempotencyKey: "expire-72-b" });
    expect(first).toMatchObject({ ok: true, replayed: false, expiredMilli: 500 });
    expect(again).toMatchObject({ ok: true, replayed: true, expiredMilli: 500 });
    expect((await reread(w, p)).granted_milli).toBe(0);
  });

  test("a repeated key is a replay even after the pool has been given more", async () => {
    const w = world();
    const p = await ensurePool(w.d1, "account", "74", "cpu");
    await grant(w, p, 500);
    const first = await expireUnused(w.d1, { poolId: p.id, idempotencyKey: "expire-74-a" });
    await grant(w, p, 900);
    const entries = await count(w);
    const again = await expireUnused(w.d1, { poolId: p.id, idempotencyKey: "expire-74-a" });
    expect(first).toMatchObject({ ok: true, replayed: false, expiredMilli: 500 });
    expect(again).toMatchObject({ ok: true, replayed: true, expiredMilli: 500 });
    expect(await count(w)).toBe(entries);
    expect(availableMilli(await reread(w, p))).toBe(900);
    // The same key for another pool is a conflict.
    const other = await ensurePool(w.d1, "account", "75", "cpu");
    await expect(
      expireUnused(w.d1, { poolId: other.id, idempotencyKey: "expire-74-a" }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  test("never expires a negative balance", async () => {
    const w = world();
    const { person, job } = await held(w, {
      grantMilli: 6000,
      budgetMilli: 20000,
      holdMilli: 5000,
    });
    await settleProvisional(w.d1, { jobId: job, chargeMilli: 8000 });
    expect(await expireUnused(w.d1, { poolId: person.id, idempotencyKey: "expire-73-a" })).toEqual({
      ok: false,
      code: "nothing_to_expire",
    });
    expect((await reread(w, person)).granted_milli).toBe(6000);
  });
});

describe("a seeded random sequence of every operation", () => {
  const STEPS = 700;

  async function run(seed: number) {
    const w = world();
    const rand = seeded(seed);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
    const amount = (max: number) => 1 + Math.floor(rand() * max);

    const accounts = ["101", "102", "103"];
    const pools: PoolRow[] = [];
    for (const a of accounts) {
      for (const word of ["cpu", "gpu"] as const) {
        pools.push(await ensurePool(w.d1, "account", a, word));
      }
    }
    const budgets = {
      cpu: await platform(w, "people", "cpu"),
      gpu: await platform(w, "people", "gpu"),
    };
    const pipelines = {
      cpu: await platform(w, "pipelines", "cpu"),
      gpu: await platform(w, "pipelines", "gpu"),
    };
    for (const p of pools) await grant(w, p, 30000);
    // The budgets are smaller than what the people can ask for, so the platform refusal is reached.
    await grant(w, budgets.cpu, 120000);
    await grant(w, budgets.gpu, 120000);
    await grant(w, pipelines.cpu, 40000);
    await grant(w, pipelines.gpu, 20000);

    const open: string[] = [];
    const settled: string[] = [];
    const tally = {
      holds: 0,
      insufficient: 0,
      platform: 0,
      overruns: 0,
      negativeAvailable: 0,
      finals: 0,
      finalsLowering: 0,
      lowerings: 0,
      loweringsRefused: 0,
      negativeRefused: 0,
      expired: 0,
      released: 0,
    };

    const budgetCharged = async () => [
      (await reread(w, budgets.cpu)).charged_milli,
      (await reread(w, budgets.gpu)).charged_milli,
    ];

    for (let step = 1; step <= STEPS; step++) {
      const op = rand();
      // The people budget records consumption only: no step may lower its charged total, but a
      // job's final settlement (it corrects a figure recorded as consumption against it) and the
      // owner's own correction of the budget pool itself.
      let mayLowerBudget = false;
      const budgetBefore = await budgetCharged();
      if (op < 0.14) {
        await grant(w, pick(pools), amount(40000));
      } else if (op < 0.4) {
        const p = pick(pools);
        const job = jobId(next());
        const useBudget = rand() < 0.85;
        const target = useBudget ? p : pick([pipelines.cpu, pipelines.gpu]);
        const r = await placeHold(w.d1, {
          poolId: target.id,
          budgetPoolId: useBudget ? (p.pool === "cpu" ? budgets.cpu.id : budgets.gpu.id) : null,
          amountMilli: amount(15000),
          jobId: job,
        });
        if (r.ok) {
          tally.holds++;
          open.push(job);
        } else if (r.code === "insufficient_balance") tally.insufficient++;
        else if (r.code === "platform_budget_exhausted") tally.platform++;
      } else if (op < 0.5 && open.length > 0) {
        const job = open.splice(Math.floor(rand() * open.length), 1)[0] as string;
        expect((await releaseHold(w.d1, { jobId: job })).ok).toBe(true);
        tally.released++;
      } else if (op < 0.66 && open.length > 0) {
        const job = open.splice(Math.floor(rand() * open.length), 1)[0] as string;
        const r = await settleProvisional(w.d1, {
          jobId: job,
          chargeMilli: Math.floor(rand() * 22000),
        });
        expect(r.ok).toBe(true);
        if (r.ok && r.overrunMilli > 0) tally.overruns++;
        settled.push(job);
      } else if (op < 0.74 && settled.length > 0) {
        const r = await settleFinal(w.d1, {
          jobId: pick(settled),
          finalMilli: Math.floor(rand() * 25000),
        });
        if (r.ok && r.deltaMilli !== 0) tally.finals++;
        // A final settlement that names the budget and lowers it (a pipelines job names none).
        if (r.ok && !r.replayed && r.deltaMilli < 0 && r.entry.budget_pool_id !== null) {
          tally.finalsLowering++;
          mayLowerBudget = true;
        }
      } else if (op < 0.9) {
        const p = pick([...pools, budgets.cpu, pipelines.cpu]);
        const field = rand() < 0.5 ? "grantedDeltaMilli" : "chargedDeltaMilli";
        const delta = (rand() < 0.5 ? -1 : 1) * amount(20000);
        const isBudget = p.holder_kind === "platform";
        // The people budget of the pool's word: what a charge correction on a person would name.
        const bud =
          !isBudget && field === "chargedDeltaMilli"
            ? p.pool === "cpu"
              ? budgets.cpu
              : budgets.gpu
            : null;
        const input = {
          poolId: p.id,
          [field]: delta,
          actorUserId: 9,
          reason: "correction",
          idempotencyKey: `adjust-${next()}`,
        };
        if (bud !== null && delta < 0) {
          // A correction that lowers a person's charge may not name the budget (the service refuses
          // it, nothing is written), and the same correction without it moves the person alone.
          const before = await count(w);
          await expect(
            adjustPool(w.d1, { ...input, budgetPoolId: bud.id } as never),
          ).rejects.toMatchObject({ code: "invalid_argument" });
          expect(await count(w)).toBe(before);
          tally.loweringsRefused++;
          const r = await adjustPool(w.d1, { ...input, budgetPoolId: null } as never);
          if (r.ok) tally.lowerings++;
          else tally.negativeRefused++;
        } else {
          const r = await adjustPool(w.d1, { ...input, budgetPoolId: bud?.id ?? null } as never);
          if (!r.ok) tally.negativeRefused++;
          // An owner's correction of the budget pool itself, which is its own pool and names none.
          if (r.ok && isBudget && field === "chargedDeltaMilli" && delta < 0) mayLowerBudget = true;
        }
      } else if (op < 0.94) {
        const r = await expireUnused(w.d1, {
          poolId: pick(pools).id,
          idempotencyKey: `expire-${next()}`,
        });
        if (r.ok) tally.expired++;
      } else {
        const p = pick(pools);
        expect((await ensurePool(w.d1, "account", p.holder_ref, p.pool)).id).toBe(p.id);
      }

      if (!mayLowerBudget) {
        const after = await budgetCharged();
        expect(
          after.map((v, i) => v >= (budgetBefore[i] as number)),
          `seed ${seed} step ${step}: op ${op}`,
        ).toEqual([true, true]);
      }
      if (step % 25 === 0 || step === STEPS) {
        expect(await totalsDisagreements(w.d1), `seed ${seed} step ${step}`).toEqual([]);
      }
      for (const p of pools) {
        if (availableMilli(await reread(w, p)) < 0) {
          tally.negativeAvailable++;
          break;
        }
      }
    }

    // Replaying every hold of the run moves nothing: the same key finds the same entry while the
    // hold is open, and a hold the run released or settled is refused as closed, with the step.
    const holds = w.db
      .query("SELECT * FROM compute_ledger WHERE kind = 'hold'")
      .all() as LedgerRow[];
    const before = await count(w);
    let openHolds = 0;
    let closedHolds = 0;
    for (const h of holds) {
      const closedBy = (
        w.db
          .query(
            "SELECT kind FROM compute_ledger WHERE hold_ref = ? AND kind IN ('release', 'charge')",
          )
          .get(h.id) as { kind: "release" | "charge" } | null
      )?.kind;
      const replay = await placeHold(w.d1, {
        poolId: h.pool_id,
        budgetPoolId: h.budget_pool_id,
        amountMilli: h.held_delta_milli,
        jobId: h.job_id as string,
        idempotencyKey: h.idempotency_key,
      });
      if (closedBy) {
        closedHolds++;
        expect(replay).toEqual({
          ok: false,
          code: "hold_closed",
          closedBy: closedBy === "release" ? "released" : "settled",
        });
      } else {
        openHolds++;
        expect(replay).toEqual({ ok: true, replayed: true, entry: h });
      }
    }
    // The ledger says the same of every entry the run wrote: one that names the budget and lowers
    // its charged total is a job's final settlement, whatever else the run did, and nothing is a
    // refund (the kind has no writer).
    const lowering = w.db
      .query(
        "SELECT kind, job_id, idempotency_key FROM compute_ledger WHERE budget_pool_id IS NOT NULL AND charged_delta_milli < 0",
      )
      .all() as Array<{ kind: string; job_id: string | null; idempotency_key: string }>;
    expect(lowering.length).toBe(tally.finalsLowering);
    for (const e of lowering) {
      expect([e.kind, e.idempotency_key]).toEqual(["adjust", `job:${e.job_id}:final`]);
    }
    expect(await count(w, "kind = 'refund'")).toBe(0);
    expect(openHolds + closedHolds).toBe(holds.length);
    expect(closedHolds).toBeGreaterThan(0);
    expect(await count(w)).toBe(before);
    expect(await totalsDisagreements(w.d1)).toEqual([]);
    if (process.env.COMPUTE_TALLY) console.log(seed, JSON.stringify(tally));
    return tally;
  }

  for (const seed of [1, 2, 3, 20261104]) {
    test(`seed ${seed}: the totals equal the ledger's sums, and the run reached the boundaries`, async () => {
      const tally = await run(seed);
      // A run that never refuses, never overruns and never goes negative proves nothing about them.
      expect(tally.holds).toBeGreaterThan(20);
      expect(tally.insufficient).toBeGreaterThan(0);
      expect(tally.platform).toBeGreaterThan(0);
      expect(tally.overruns).toBeGreaterThan(0);
      expect(tally.negativeAvailable).toBeGreaterThan(0);
      expect(tally.finals).toBeGreaterThan(0);
      // The run lowered a budget by a final settlement, and tried to by a correction (refused),
      // and lowered a person's charge alone: the three sides of the rule were all reached.
      expect(tally.finalsLowering).toBeGreaterThan(0);
      expect(tally.loweringsRefused).toBeGreaterThan(0);
      expect(tally.lowerings).toBeGreaterThan(0);
      expect(tally.released).toBeGreaterThan(0);
    });
  }
});

describe("no path writes a pool's totals except a ledger entry", () => {
  const ROOT = join(import.meta.dir, "..", "..");
  const TOTALS = /\b(granted|held|charged)_milli\b/;
  const TRIGGER_FILE = "0114_compute_ledger.sql";

  /**
   * One table's name as SQL may write it: bare, quoted four ways (double, single, backtick,
   * bracket) and with a schema in front (`main.`, `"main".`, `main .`).
   */
  const table = (name: string) =>
    `(?:[\\w"'\`\\[\\]\\\\]+\\s*\\.\\s*)?["'\`\\[\\\\]*${name}\\b["'\`\\]\\\\]*`;
  const POOLS = table("compute_pools");
  const LEDGER = table("compute_ledger");
  const BODY = "[^;`]{0,2000}";
  const statement = (verb: string, target: string) =>
    new RegExp(`${verb}\\s+${target}${BODY}`, "gi");

  /** Every statement of a text that writes one of the two tables in a way nothing may. */
  function scanText(path: string, text: string): string[] {
    const offences: string[] = [];
    const flag = (m: RegExpMatchArray) =>
      offences.push(`${path}: ${m[0].replace(/\s+/g, " ").slice(0, 90)}`);
    const trigger = path.endsWith(TRIGGER_FILE);
    // A total written by an UPDATE of the pools, in any spelling of the table and of the verb;
    // only the migration's own trigger may.
    for (const m of text.matchAll(statement("UPDATE(?:\\s+OR\\s+\\w+)?", POOLS))) {
      if (TOTALS.test(m[0]) && !trigger) flag(m);
    }
    // A pool made with a total in it is a write of the total that no entry accounts for.
    for (const m of text.matchAll(statement("INSERT(?:\\s+OR\\s+\\w+)?\\s+INTO", POOLS))) {
      if (TOTALS.test(m[0])) flag(m);
    }
    // No conflict clause on an INSERT into the ledger: `OR IGNORE` and `OR FAIL` override the
    // clause inside the trigger, and `OR REPLACE` rewrites a row without the append-only trigger.
    for (const m of text.matchAll(statement("INSERT\\s+OR\\s+\\w+\\s+INTO", LEDGER))) flag(m);
    for (const m of text.matchAll(statement("INSERT\\s+OR\\s+REPLACE\\s+INTO", POOLS))) flag(m);
    // REPLACE on either table, and a delete from either.
    for (const target of [POOLS, LEDGER]) {
      for (const m of text.matchAll(statement("REPLACE\\s+INTO", target))) flag(m);
      for (const m of text.matchAll(statement("DELETE\\s+FROM", target))) flag(m);
    }
    // An upsert that updates a total is a write of it too.
    for (const m of text.matchAll(/ON\s+CONFLICT[^;`]{0,400}?DO\s+UPDATE[^;`]{0,400}/gi)) {
      if (TOTALS.test(m[0])) flag(m);
    }
    return offences;
  }

  /** The files that name a trigger on the pools: a trigger that writes a total is a writer of it. */
  function triggersOnPools(text: string): number {
    const on = new RegExp(`CREATE\\s+(?:TEMP(?:ORARY)?\\s+)?TRIGGER[^;]*?\\bON\\s+${POOLS}`, "gi");
    return [...text.matchAll(on)].length;
  }

  /** Every TypeScript, JavaScript and SQL file the product ships, by relative path. */
  function sources(): Array<{ path: string; text: string }> {
    const out: Array<{ path: string; text: string }> = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === ".wrangler") continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx|sql|js|mjs)$/.test(entry.name)) {
          out.push({ path: relative(ROOT, full), text: readFileSync(full, "utf8") });
        }
      }
    };
    for (const dir of ["backend/src", "backend/scripts", "src", "shared", "scripts"]) {
      if (existsSync(join(ROOT, dir))) walk(join(ROOT, dir));
    }
    return out;
  }

  test("the scan reads the files it is meant to, and finds the trigger it exempts", () => {
    const all = sources();
    expect(all.length).toBeGreaterThan(200);
    const migration = all.find((s) => s.path.endsWith(TRIGGER_FILE));
    expect(migration).toBeDefined();
    // The trigger's own UPDATE is seen by the scan (so the exemption is what lets it pass) ...
    expect(scanText("x/other.sql", migration?.text ?? "").length).toBeGreaterThan(0);
    expect(scanText(`x/${TRIGGER_FILE}`, migration?.text ?? "")).toEqual([]);
  });

  /** Statements that must each be refused: every spelling the review found past the old scan. */
  const PLANTED = [
    "UPDATE compute_pools SET held_milli = 0",
    "update compute_pools\n   set granted_milli = granted_milli + 1",
    "UPDATE OR IGNORE compute_pools SET held_milli = 0",
    "UPDATE OR REPLACE compute_pools SET charged_milli = 1",
    "UPDATE OR FAIL compute_pools SET charged_milli = 1",
    "UPDATE main.compute_pools SET granted_milli = 1",
    'UPDATE "compute_pools" SET granted_milli = 1',
    "UPDATE [compute_pools] SET granted_milli = 1",
    "UPDATE `compute_pools` SET held_milli = 1",
    "UPDATE 'compute_pools' SET held_milli = 1",
    'UPDATE "main"."compute_pools" SET held_milli = 1',
    "UPDATE [main].[compute_pools] SET held_milli = 1",
    "UPDATE main . compute_pools SET held_milli = 1",
    'UPDATE OR IGNORE main."compute_pools" SET held_milli = 1',
    "INSERT OR IGNORE INTO compute_ledger (kind) VALUES ('grant')",
    "INSERT OR FAIL INTO compute_ledger (kind) VALUES ('grant')",
    "INSERT OR REPLACE INTO compute_ledger (kind) VALUES ('grant')",
    "INSERT OR ROLLBACK INTO main.compute_ledger (kind) VALUES ('grant')",
    'INSERT OR IGNORE INTO "compute_ledger" (kind) VALUES (1)',
    "REPLACE INTO compute_ledger (kind) VALUES ('grant')",
    "REPLACE INTO compute_pools (id) VALUES (1)",
    'REPLACE INTO "main"."compute_pools" (id) VALUES (1)',
    "INSERT OR REPLACE INTO compute_pools (id) VALUES (1)",
    "DELETE FROM compute_ledger WHERE id = 1",
    'DELETE FROM "compute_pools"',
    "DELETE FROM main.compute_pools",
    "INSERT INTO compute_pools (holder_kind, holder_ref, pool, granted_milli) VALUES (1, 1, 1, 5)",
    "INSERT INTO compute_pools (holder_kind, holder_ref, pool, charged_milli) VALUES (1, 1, 1, 5)",
    "INSERT OR IGNORE INTO compute_pools (holder_kind, held_milli) VALUES (1, 5)",
    "INSERT INTO t (a) VALUES (1) ON CONFLICT (a) DO UPDATE SET granted_milli = 5",
    // As they are written inside a JavaScript string, with the quotes escaped.
    String.raw`UPDATE \"compute_pools\" SET held_milli = 1`,
    String.raw`UPDATE OR IGNORE main.\"compute_pools\" SET held_milli = 0`,
    String.raw`UPDATE \'compute_pools\' SET held_milli = 0`,
    String.raw`REPLACE INTO \"compute_ledger\" (kind) VALUES (1)`,
    String.raw`INSERT OR IGNORE INTO \"main\".\"compute_ledger\" (kind) VALUES (1)`,
    String.raw`DELETE FROM \"compute_pools\"`,
  ];

  test("every planted spelling of a write is refused (the scan is not blind to a quoted name, a schema or a conflict clause)", () => {
    for (const planted of PLANTED) {
      expect([
        planted,
        scanText("backend/src/x.ts", `const q = \`${planted}\`;`).length > 0,
      ]).toEqual([planted, true]);
      // And in a migration of another number, where even the trigger's own UPDATE is no exemption.
      expect([
        planted,
        scanText("backend/src/db/migrations/0200_x.sql", `${planted};`).length > 0,
      ]).toEqual([planted, true]);
    }
  });

  test("what the service and the trigger legitimately write is not refused", () => {
    const fine = [
      "UPDATE compute_pools SET frozen = 1 WHERE id = 1",
      'UPDATE "compute_pools" SET frozen = 0',
      "UPDATE compute_pools SET updated_at = datetime('now') WHERE id = 1",
      "INSERT INTO compute_pools (holder_kind, holder_ref, pool) VALUES ('platform', 'x', 'cpu')",
      "INSERT INTO compute_pools (holder_kind, holder_ref, pool) VALUES (?1, ?2, ?3) ON CONFLICT (holder_kind, holder_ref, pool) DO NOTHING",
      "INSERT INTO compute_ledger (kind, pool_id) VALUES ('grant', 1)",
      "INSERT INTO other_table (granted_milli) VALUES (1)",
      "UPDATE other_table SET granted_milli = 1",
      "SELECT held_milli FROM compute_pools",
      "-- UPDATE compute_pools is described here",
    ];
    for (const sql of fine.slice(0, -1)) {
      expect([sql, scanText("backend/src/x.ts", `const q = \`${sql}\`;`)]).toEqual([sql, []]);
    }
  });

  test("only migration 0114's trigger writes a pool's totals, and nothing deletes or replaces a pool or an entry", () => {
    const offences = sources().flatMap(({ path, text }) => scanText(path, text));
    expect(offences).toEqual([]);
  });

  test("migration 0114 creates the triggers on compute_pools, and migration 0130 only replaces the identity one with its anonymizing exception", () => {
    const files = sources().filter((s) => triggersOnPools(s.text) > 0);
    expect(files.map((f) => f.path)).toEqual([
      expect.stringContaining(TRIGGER_FILE),
      expect.stringContaining("0130_compute_anonymise.sql"),
    ]);
    // The count it sees in the migration is the two it creates, and a planted one is seen.
    expect(triggersOnPools(files[0]?.text ?? "")).toBe(2);
    // Phase A7's replacement is the one identity trigger, which only ever RAISES: it writes no total.
    expect(triggersOnPools(files[1]?.text ?? "")).toBe(1);
    expect(files[1]?.text).toContain("CREATE TRIGGER compute_pools_identity_fixed");
    expect(files[1]?.text).not.toContain("CREATE TRIGGER compute_ledger_apply");
    // The A2 guard is NOT loosened to "any trigger on the pools": the one trigger 0130 may create on them
    // is BEFORE UPDATE, and its body only raises. A body that writes anything is a writer of a total.
    const created =
      /CREATE TRIGGER compute_pools_identity_fixed BEFORE UPDATE OF[\s\S]*?\bEND;/.exec(
        files[1]?.text ?? "",
      )?.[0];
    expect(created).toBeDefined();
    const body = /\bBEGIN([\s\S]*)\bEND;/.exec(created ?? "")?.[1] ?? "";
    expect(body.trim()).toMatch(/^SELECT RAISE\(ABORT, '[^']*(?:''[^']*)*'\);$/);
    expect(body).not.toMatch(/\b(?:UPDATE|INSERT|DELETE|REPLACE)\b/i);
    expect(
      triggersOnPools("CREATE TRIGGER t AFTER INSERT ON compute_pools BEGIN SELECT 1; END;"),
    ).toBe(1);
    expect(
      triggersOnPools(
        'CREATE TRIGGER t BEFORE UPDATE OF a ON "main"."compute_pools" BEGIN SELECT 1; END;',
      ),
    ).toBe(1);
    expect(triggersOnPools("CREATE TRIGGER t AFTER INSERT ON other BEGIN SELECT 1; END;")).toBe(0);
  });

  /**
   * Paren depth and quote state at each character of a statement, so a comma or a keyword can be
   * judged TOP-LEVEL (outside any parenthesis or quoted text).
   */
  function topLevelMap(sql: string): { depth: number[]; quoted: boolean[] } {
    const depth: number[] = [];
    const quoted: boolean[] = [];
    let d = 0;
    let q: string | null = null;
    for (const c of sql) {
      if (q) {
        depth.push(d);
        quoted.push(true);
        if (c === q) q = null;
      } else if (c === "'" || c === '"') {
        q = c;
        depth.push(d);
        quoted.push(true);
      } else if (c === "(") {
        depth.push(d++);
        quoted.push(false);
      } else if (c === ")") {
        depth.push(--d);
        quoted.push(false);
      } else {
        depth.push(d);
        quoted.push(false);
      }
    }
    return { depth, quoted };
  }

  /** The pieces of a list, split on its top-level commas. */
  function splitTop(list: string): string[] {
    const { depth, quoted } = topLevelMap(list);
    const out: string[] = [];
    let from = 0;
    for (let i = 0; i < list.length; i++) {
      if (list[i] === "," && depth[i] === 0 && !quoted[i]) {
        out.push(list.slice(from, i).trim());
        from = i + 1;
      }
    }
    out.push(list.slice(from).trim());
    return out;
  }

  /** A string literal, bare or with its quotes escaped as inside a JavaScript string. */
  const LITERAL = /^\\?['"][a-z_]+\\?['"]$/i;
  const REFUND = /\\?['"]refund\\?['"]/i;

  /**
   * What is wrong with one statement that inserts into the ledger, as sentences (empty when
   * nothing is). The kind `refund` has no writer (the owner decided on 2026-11-04 that none is
   * automatic), so: a `'refund'` literal anywhere in the statement that is not the right side of a
   * comparison or inside an `IN (...)` list (those are reads, such as the final settlement's
   * `r.kind = 'refund'` guard) is refused wherever it stands, and so is a kind that is not a plain
   * literal in the kind column's position of every VALUES row and every top-level SELECT list (a
   * bound `?`, a column, an expression), because the scan could not say what it writes. A statement
   * that a template interpolation cuts short (`settleInsertSql` starts from `${SETTLE_INSERT_HEAD}`) is
   * seen only as far as the interpolation, and its head names columns and no values, so the kind
   * position of its SELECTs is out of this scan's reach; the behavioural test of
   * compute-ledger-budget.test.ts, which runs every operation and finds no `refund` row, covers it.
   */
  function ledgerInsertProblems(sql: string): string[] {
    const flat = sql.replace(/\s+/g, " ");
    const problems: string[] = [];
    const written = flat
      .replace(/(?:=|<>|!=)\s*\\?['"]refund\\?['"]/gi, "")
      .replace(/\bIN\s*\([^)]*\)/gi, "");
    if (REFUND.test(written)) problems.push("a refund literal that is not a comparison");

    const whole = topLevelMap(flat);
    const open = flat.indexOf("(");
    if (open < 0) return [...problems, "no column list"];
    let close = open + 1;
    while (
      close < flat.length &&
      !(flat[close] === ")" && !whole.quoted[close] && whole.depth[close] === 0)
    ) {
      close++;
    }
    const kind = splitTop(flat.slice(open + 1, close)).indexOf("kind");
    if (kind < 0) return [...problems, "no kind column"];
    const rest = flat.slice(close + 1);
    const map = topLevelMap(rest);
    const atTop = (i: number) => map.depth[i] === 0 && !map.quoted[i];
    const exprs: Array<string | undefined> = [];
    const values = [...rest.matchAll(/\bVALUES\b/gi)].find((m) => atTop(m.index as number));
    if (values) {
      const after = rest.slice((values.index as number) + 6);
      const inner = topLevelMap(after);
      let from = -1;
      for (let i = 0; i < after.length; i++) {
        if (after[i] === "(" && inner.depth[i] === 0 && !inner.quoted[i]) from = i + 1;
        if (after[i] === ")" && inner.depth[i] === 0 && !inner.quoted[i] && from >= 0) {
          exprs.push(splitTop(after.slice(from, i))[kind]);
          from = -1;
        }
      }
    }
    for (const m of rest.matchAll(/\bSELECT\b/gi)) {
      if (!atTop(m.index as number)) continue;
      const start = (m.index as number) + 6;
      const end = [...rest.slice(start).matchAll(/\b(?:FROM|WHERE|UNION)\b/gi)].find((e) =>
        atTop(start + (e.index as number)),
      );
      exprs.push(
        splitTop(rest.slice(start, end ? start + (end.index as number) : undefined))[kind],
      );
    }
    for (const expr of exprs) {
      if (expr === undefined || !LITERAL.test(expr)) {
        problems.push(`the kind is not a plain literal: ${expr ?? "missing"}`);
      }
    }
    return problems;
  }

  /** Every statement of a text that inserts into the ledger and has a problem, as one line each. */
  function ledgerKindOffences(text: string): string[] {
    return [...text.matchAll(statement("INSERT(?:\\s+OR\\s+\\w+)?\\s+INTO", LEDGER))].flatMap((m) =>
      ledgerInsertProblems(m[0]).map(
        (problem) => `${problem}: ${m[0].replace(/\s+/g, " ").slice(0, 100)}`,
      ),
    );
  }

  test("no statement the product ships writes a refund entry, or a kind the scan cannot read", () => {
    // Every spelling of a write the scan must see: the first shape each was found to survive the
    // old scan in is listed last.
    for (const planted of [
      "INSERT INTO compute_ledger (kind, pool_id) VALUES ('refund', 1)",
      "insert into main.compute_ledger (kind) values ('refund')",
      "INSERT INTO compute_ledger (kind, pool_id) SELECT 'refund', d.pool_id FROM t d",
      "INSERT INTO compute_ledger (kind) SELECT 'grant' UNION ALL SELECT 'refund'",
      'INSERT INTO "compute_ledger" (kind) VALUES ("refund")',
      // The kind is not the first column or the first value.
      "INSERT INTO compute_ledger (pool_id, kind, charged_delta_milli) VALUES (?1, 'refund', -1)",
      "INSERT INTO compute_ledger (pool_id, kind) SELECT d.pool_id, 'refund' FROM t d",
      'INSERT INTO compute_ledger (pool_id, kind) VALUES (1, "refund"), (2, "refund")',
      // The kind is bound, read from a column or computed, so the scan cannot say what it is.
      "INSERT INTO compute_ledger (kind, pool_id) VALUES (?1, ?2)",
      "INSERT INTO compute_ledger (pool_id, kind) VALUES (?1, ?2)",
      "INSERT INTO compute_ledger (pool_id, kind) SELECT d.pool_id, ?1 FROM t d",
      "INSERT INTO compute_ledger (pool_id, kind) SELECT d.pool_id, d.kind FROM t d",
      "INSERT INTO compute_ledger (kind) SELECT 'grant' UNION ALL SELECT ?1",
      "INSERT INTO compute_ledger (kind, pool_id) VALUES ('grant' || ?1, 1)",
      "INSERT INTO compute_ledger (kind, pool_id) VALUES ('grant', 1), (?1, 2)",
      // The literal escaped as it is inside a JavaScript string.
      String.raw`INSERT INTO compute_ledger (pool_id, kind) VALUES (1, \'refund\')`,
    ]) {
      expect([planted, ledgerKindOffences(`const q = \`${planted}\`;`).length > 0]).toEqual([
        planted,
        true,
      ]);
    }
    for (const fine of [
      "INSERT INTO compute_ledger (kind, pool_id) VALUES ('grant', 1)",
      "INSERT INTO compute_ledger (pool_id, kind) VALUES (?1, 'grant'), (?2, 'expire')",
      "INSERT INTO compute_ledger (pool_id, kind) SELECT (SELECT 1 FROM t), 'hold' FROM t",
      "INSERT INTO compute_ledger (kind) SELECT 'charge' FROM t UNION ALL SELECT 'overrun' FROM t",
      "INSERT INTO other_table (kind) VALUES ('refund')",
      "INSERT INTO other_table (kind) VALUES (?1)",
      "SELECT kind FROM compute_ledger WHERE kind = 'refund'",
      // The final settlement's statement READS refund entries (a guard), which is not writing one.
      "INSERT INTO compute_ledger (kind) SELECT 'adjust' FROM t d WHERE NOT EXISTS (SELECT 1 FROM compute_ledger r WHERE r.kind = 'refund')",
      "INSERT INTO compute_ledger (kind) SELECT 'adjust' FROM t d WHERE d.kind IN ('x', 'refund') AND d.kind <> 'refund'",
      // A head cut short by an interpolation names columns and no values: nothing to judge.
      "INSERT INTO compute_ledger\n  (kind, pool_id, held_delta_milli)",
    ]) {
      expect([fine, ledgerKindOffences(`const q = \`${fine}\`;`)]).toEqual([fine, []]);
    }
    // The scan reads the statements it is meant to: the seven the ledger service ships.
    const inserts = sources().flatMap(({ text }) => [
      ...text.matchAll(statement("INSERT(?:\\s+OR\\s+\\w+)?\\s+INTO", LEDGER)),
    ]);
    expect(inserts.length).toBeGreaterThanOrEqual(7);
    const offences = sources().flatMap(({ path, text }) =>
      ledgerKindOffences(text).map((problem) => `${path}: ${problem}`),
    );
    expect(offences).toEqual([]);
  });

  test("the service's inserts into the pools name no total", () => {
    const service = readFileSync(join(ROOT, "backend/src/services/compute-ledger.ts"), "utf8");
    const inserts = [...service.matchAll(/INSERT\s+INTO\s+compute_pools[^;`]*/gi)].map((m) => m[0]);
    expect(inserts.length).toBe(1);
    for (const s of inserts) expect(TOTALS.test(s)).toBe(false);
  });
});
