/**
 * The `people` budget records consumption only (epic #2005, follow-up to phase A2, #2007; ADR 0118,
 * item 5 of the A2 amendment as the owner's decision of 2026-11-04 settled it: option A).
 *
 * The budget is the overall cap on what people can spend, so it counts what was consumed and nothing
 * a person or an administrator does to a person's pool gives it back. Against the real migration on a
 * real database (bun:sqlite behind `realD1`), what is pinned is:
 *  - a correction that LOWERS the charge of an account's or a partner's pool lowers the pool and
 *    leaves the budget's consumption exactly as it was, and the service refuses a caller that names
 *    the budget for it; one that RAISES the charge raises both; a correction of the grant moves
 *    neither the budget's charged nor its held;
 *  - the only entry that names the budget and lowers its charged is a job's final settlement, which
 *    corrects a figure that was recorded as consumption, and it can never take the budget below what
 *    the other jobs consumed;
 *  - an enumerated table of every operation the service has, run against every kind the vocabulary
 *    allows, says which of them lowers the budget (one) and a ledger scan says the same of every
 *    entry written;
 *  - the refund path is gone.
 *
 * The guards this file and its neighbours hold, each proven by mutating it alone and watching a test
 * of the file named fail:
 *  - `adjustPool` refuses a lowering charge correction that names the budget (here, and the random
 *    sequence and the D1 life of a job in compute-ledger.test.ts and compute-ledger-race.test.ts);
 *  - `ADJUST_INSERT_SQL` writes nothing for a budget with a charged change that does not raise it
 *    (the statement bound directly, here);
 *  - the route names the budget only when `delta_milli > 0` (compute-pool-routes.test.ts and the
 *    admin compute CLI test);
 *  - the final settlement's delta is the job's own, so it cannot take back other jobs' consumption
 *    (here), and it names the budget (here, and the final-settlement suites);
 *  - the per-step check of the random sequence, that no step lowers the budget but a final
 *    settlement or the owner's platform correction (compute-ledger.test.ts);
 *  - the source scan that refuses a shipped ledger insert that writes `refund` or a kind it cannot
 *    read, and the export check that the refund function, statement and key are gone (here);
 *  - the vocabulary check that every ledger kind but `refund` is written by a row of the table (here);
 *  - the `pool adjust` help text that says what lowers the budget (admin-compute-cli.test.ts).
 */

import { describe, expect, test } from "bun:test";
import { LEDGER_ENTRY_KINDS, type LedgerEntryKind } from "../../shared/compute-state";
import * as ledgerModule from "../src/services/compute-ledger";
import {
  ADJUST_INSERT_SQL,
  ComputeLedgerError,
  type LedgerRow,
  type PoolRow,
  adjustPool,
  ensurePool,
  expireUnused,
  finalKey,
  grantPool,
  placeHold,
  releaseHold,
  settleFinal,
  settleProvisional,
  unreservedChargeStatements,
} from "../src/services/compute-ledger";
import { jobId, totalsDisagreements } from "./helpers/compute-ledger";
import { freshDb, realD1 } from "./helpers/d1";

let seq = 0;
const next = () => ++seq;

function world() {
  const db = freshDb();
  return { db, d1: realD1(db) };
}
type World = ReturnType<typeof world>;

const reread = async (w: World, pool: PoolRow): Promise<PoolRow> =>
  (await w.d1
    .prepare("SELECT * FROM compute_pools WHERE id = ?")
    .bind(pool.id)
    .first<PoolRow>()) as PoolRow;

async function grant(w: World, pool: PoolRow, amountMilli: number) {
  const r = await grantPool(w.d1, {
    poolId: pool.id,
    amountMilli,
    actorUserId: 1,
    idempotencyKey: `grant-${next()}`,
  });
  expect(r.ok).toBe(true);
}

/** A holder's cpu pool with a grant, and the platform people budget of cpu with one. */
async function scene(
  kind: "account" | "partner",
  o: { grantMilli?: number; budgetMilli?: number } = {},
) {
  const w = world();
  const holder = await ensurePool(
    w.d1,
    kind,
    kind === "account" ? String(30000 + next()) : `client_${next()}`,
    "cpu",
  );
  const budget = await ensurePool(w.d1, "platform", "people", "cpu");
  await grant(w, holder, o.grantMilli ?? 100000);
  await grant(w, budget, o.budgetMilli ?? 500000);
  return { w, holder, budget };
}

/** A job held for `holdMilli` on the holder, counted against the budget. */
async function hold(
  w: World,
  holder: PoolRow,
  budget: PoolRow,
  holdMilli: number,
): Promise<string> {
  const job = jobId(next());
  const r = await placeHold(w.d1, {
    poolId: holder.id,
    budgetPoolId: budget.id,
    amountMilli: holdMilli,
    jobId: job,
  });
  expect(r.ok).toBe(true);
  return job;
}

const correction = (
  w: World,
  pool: PoolRow,
  chargedDeltaMilli: number,
  budgetPoolId: number | null,
) =>
  adjustPool(w.d1, {
    poolId: pool.id,
    budgetPoolId,
    chargedDeltaMilli,
    actorUserId: 9,
    reason: "correction",
    idempotencyKey: `adjust-${next()}`,
  });

const ledgerRows = (w: World, where = "1 = 1") =>
  w.db.query(`SELECT * FROM compute_ledger WHERE ${where} ORDER BY id`).all() as LedgerRow[];

describe("a correction of the charge of an account's or a partner's pool", () => {
  for (const kind of ["account", "partner"] as const) {
    test(`${kind}: lowering it lowers the pool and leaves the people budget's consumption as it was`, async () => {
      const { w, holder, budget } = await scene(kind);
      // 3000 consumed: counted against the pool and the budget alike.
      expect((await correction(w, holder, 3000, budget.id)).ok).toBe(true);
      expect([
        (await reread(w, holder)).charged_milli,
        (await reread(w, budget)).charged_milli,
      ]).toEqual([3000, 3000]);
      const before = await reread(w, budget);

      const lowered = await correction(w, holder, -2000, null);
      expect(lowered).toMatchObject({ ok: true, replayed: false });
      if (!lowered.ok) return;
      // The entry names no budget, so the trigger has no second row to move.
      expect(lowered.entry).toMatchObject({
        kind: "adjust",
        pool_id: holder.id,
        budget_pool_id: null,
        charged_delta_milli: -2000,
        job_id: null,
      });
      expect((await reread(w, holder)).charged_milli).toBe(1000);
      const after = await reread(w, budget);
      expect([after.charged_milli, after.held_milli, after.granted_milli]).toEqual([
        before.charged_milli,
        before.held_milli,
        before.granted_milli,
      ]);
      expect(after.charged_milli).toBe(3000);
      expect(await totalsDisagreements(w.d1)).toEqual([]);
    });

    test(`${kind}: the service refuses a caller that names the budget for a correction downward, and writes nothing`, async () => {
      const { w, holder, budget } = await scene(kind);
      expect((await correction(w, holder, 3000, budget.id)).ok).toBe(true);
      const entries = ledgerRows(w).length;
      const poolBefore = await reread(w, holder);
      const budgetBefore = await reread(w, budget);
      const refused = await correction(w, holder, -1, budget.id).then(
        () => null,
        (err: unknown) => err,
      );
      expect(refused).toBeInstanceOf(ComputeLedgerError);
      expect((refused as ComputeLedgerError).code).toBe("invalid_argument");
      expect((refused as ComputeLedgerError).message).toMatch(
        /people budget records consumption only/,
      );
      expect(ledgerRows(w)).toHaveLength(entries);
      expect(await reread(w, holder)).toEqual(poolBefore);
      expect(await reread(w, budget)).toEqual(budgetBefore);
    });

    test(`${kind}: raising it raises the pool and the budget together`, async () => {
      const { w, holder, budget } = await scene(kind);
      const raised = await correction(w, holder, 1500, budget.id);
      expect(raised).toMatchObject({ ok: true });
      if (!raised.ok) return;
      expect(raised.entry).toMatchObject({ budget_pool_id: budget.id, charged_delta_milli: 1500 });
      expect((await reread(w, holder)).charged_milli).toBe(1500);
      expect((await reread(w, budget)).charged_milli).toBe(1500);
      expect(await totalsDisagreements(w.d1)).toEqual([]);
    });

    test(`${kind}: a correction of the grant moves neither the budget's charged nor its held`, async () => {
      const { w, holder, budget } = await scene(kind);
      const job = await hold(w, holder, budget, 4000);
      await settleProvisional(w.d1, { jobId: job, chargeMilli: 2500 });
      const before = await reread(w, budget);
      for (const grantedDeltaMilli of [-3000, 7000]) {
        const r = await adjustPool(w.d1, {
          poolId: holder.id,
          grantedDeltaMilli,
          actorUserId: 9,
          reason: "correction",
          idempotencyKey: `adjust-${next()}`,
        });
        expect(r).toMatchObject({ ok: true });
        if (r.ok) expect(r.entry.budget_pool_id).toBeNull();
      }
      expect(await reread(w, budget)).toEqual(before);
      expect((await reread(w, holder)).granted_milli).toBe(100000 + 4000);
    });
  }

  test("a person's correction downward needs nothing from the budget: the owner may have lowered it and it still applies", async () => {
    const { w, holder, budget } = await scene("account");
    expect((await correction(w, holder, 500, budget.id)).ok).toBe(true);
    // The owner's own platform correction takes the budget's charge back to 0.
    expect((await correction(w, budget, -500, null)).ok).toBe(true);
    expect((await reread(w, budget)).charged_milli).toBe(0);
    // Option B would have refused this as `would_go_negative`: the budget could not credit 500.
    expect(await correction(w, holder, -500, null)).toMatchObject({ ok: true });
    expect((await reread(w, holder)).charged_milli).toBe(0);
    expect((await reread(w, budget)).charged_milli).toBe(0);
    expect(await totalsDisagreements(w.d1)).toEqual([]);
  });

  test("the owner's correction of a platform pool names no budget, as before", async () => {
    const { w, budget } = await scene("account");
    const up = await correction(w, budget, 1000, null);
    expect(up).toMatchObject({ ok: true });
    if (up.ok) expect(up.entry.budget_pool_id).toBeNull();
    expect(await correction(w, budget, -1000, null)).toMatchObject({ ok: true });
    expect((await reread(w, budget)).charged_milli).toBe(0);
  });
});

describe("the adjustment statement carries the rule itself", () => {
  /** `ADJUST_INSERT_SQL` bound as `adjustPool` binds it, but without any of `adjustPool`'s checks. */
  const bound = (
    w: World,
    pool: PoolRow,
    budgetPoolId: number | null,
    grantedDeltaMilli: number,
    chargedDeltaMilli: number,
  ) =>
    w.d1
      .prepare(ADJUST_INSERT_SQL)
      .bind(
        pool.id,
        budgetPoolId,
        grantedDeltaMilli,
        chargedDeltaMilli,
        9,
        "correction",
        `direct-${next()}`,
      )
      .run();

  test("a budget with a charged delta that does not raise it writes nothing, whoever binds it", async () => {
    const { w, holder, budget } = await scene("account");
    expect((await correction(w, holder, 3000, budget.id)).ok).toBe(true);
    const entries = ledgerRows(w).length;
    const [holderBefore, budgetBefore] = [await reread(w, holder), await reread(w, budget)];
    // A fall, and a delta of 0 (which the table would raise a CHECK for): both are refused here, as
    // a statement that writes nothing, so a caller that skips `adjustPool` cannot credit the budget.
    for (const [granted, charged] of [
      [0, -1],
      [0, -2000],
      [0, -3000],
      [5, 0],
    ] as const) {
      const r = await bound(w, holder, budget.id, granted, charged);
      expect([granted, charged, r.meta?.changes]).toEqual([granted, charged, 0]);
    }
    expect(ledgerRows(w)).toHaveLength(entries);
    expect(await reread(w, holder)).toEqual(holderBefore);
    expect(await reread(w, budget)).toEqual(budgetBefore);

    // The same statement still does what it should: a raise names the budget, and a fall that names
    // none moves the pool alone.
    // (`changes` counts the trigger's updates of the pools too, so a write is more than 0.)
    expect((await bound(w, holder, budget.id, 0, 500)).meta?.changes).toBeGreaterThan(0);
    expect((await reread(w, budget)).charged_milli).toBe(3500);
    expect((await bound(w, holder, null, 0, -500)).meta?.changes).toBeGreaterThan(0);
    expect((await reread(w, holder)).charged_milli).toBe(3000);
    expect((await reread(w, budget)).charged_milli).toBe(3500);
    expect(await totalsDisagreements(w.d1)).toEqual([]);
  });
});

describe("a job's final settlement is the one path that lowers the budget's consumption", () => {
  test("a final figure below the provisional charge lowers the person and the budget by the job's difference", async () => {
    const { w, holder, budget } = await scene("account");
    const job = await hold(w, holder, budget, 5000);
    await settleProvisional(w.d1, { jobId: job, chargeMilli: 3000 });
    expect((await reread(w, budget)).charged_milli).toBe(3000);

    const r = await settleFinal(w.d1, { jobId: job, finalMilli: 2000 });
    expect(r).toMatchObject({ ok: true, deltaMilli: -1000 });
    if (!r.ok) return;
    // The entry names the budget: the figure it corrects was recorded as consumption against it.
    expect(r.entry).toMatchObject({
      kind: "adjust",
      budget_pool_id: budget.id,
      charged_delta_milli: -1000,
      job_id: job,
      idempotency_key: finalKey(job),
      reason: "final_settlement",
    });
    expect((await reread(w, holder)).charged_milli).toBe(2000);
    expect((await reread(w, budget)).charged_milli).toBe(2000);
    expect(await totalsDisagreements(w.d1)).toEqual([]);
  });

  test("it cannot take the budget below what the OTHER jobs consumed: it corrects its own job's figure only", async () => {
    const { w, holder, budget } = await scene("account");
    const [a, b] = [await hold(w, holder, budget, 5000), await hold(w, holder, budget, 5000)];
    await settleProvisional(w.d1, { jobId: a, chargeMilli: 3000 });
    await settleProvisional(w.d1, { jobId: b, chargeMilli: 4000 });
    expect((await reread(w, budget)).charged_milli).toBe(7000);
    // The lowest a final figure goes is 0, which takes back the whole of THIS job's charge.
    expect(await settleFinal(w.d1, { jobId: a, finalMilli: 0 })).toMatchObject({
      ok: true,
      deltaMilli: -3000,
    });
    expect((await reread(w, budget)).charged_milli).toBe(4000);
    expect((await reread(w, holder)).charged_milli).toBe(4000);
  });

  test("a final figure above it, or equal to it, never lowers the budget", async () => {
    const { w, holder, budget } = await scene("account");
    const [up, same] = [await hold(w, holder, budget, 5000), await hold(w, holder, budget, 5000)];
    await settleProvisional(w.d1, { jobId: up, chargeMilli: 3000 });
    await settleProvisional(w.d1, { jobId: same, chargeMilli: 2000 });
    expect(await settleFinal(w.d1, { jobId: up, finalMilli: 3500 })).toMatchObject({
      deltaMilli: 500,
    });
    expect(await settleFinal(w.d1, { jobId: same, finalMilli: 2000 })).toMatchObject({
      deltaMilli: 0,
    });
    expect((await reread(w, budget)).charged_milli).toBe(5500);
  });
});

/**
 * Every operation the service has, each in a world of its own, against the budget's charged total:
 * what the act did to it, and the kinds of entry it wrote. The expectation is spelled out per row so
 * that a new way of moving the budget has to be written down here, and the kinds the rows write must
 * be every kind the vocabulary allows (but the ones with no writer).
 */
describe("which operations lower the people budget's consumption", () => {
  type Effect = "lowers" | "raises" | "none";
  type Scene = Awaited<ReturnType<typeof scene>>;
  interface Row {
    name: string;
    effect: Effect;
    /** The kinds the ACT writes (not the set-up), which the vocabulary check unions. */
    writes: LedgerEntryKind[];
    /** What has to exist before the act, whose effect on the budget is not the row's. */
    setup?: (s: Scene) => Promise<string>;
    act: (s: Scene, job: string) => Promise<unknown>;
  }

  /** An open hold of 5000 on the person. */
  const held = (s: Scene) => hold(s.w, s.holder, s.budget, 5000);
  /** A job settled provisionally at 3000 of a 5000 hold. */
  const settled = async (s: Scene) => {
    const job = await held(s);
    await settleProvisional(s.w.d1, { jobId: job, chargeMilli: 3000 });
    return job;
  };
  const adjustGrant = (s: Scene, grantedDeltaMilli: number) =>
    adjustPool(s.w.d1, {
      poolId: s.holder.id,
      grantedDeltaMilli,
      actorUserId: 9,
      reason: "correction",
      idempotencyKey: `adjust-${next()}`,
    });

  const ROWS: Row[] = [
    {
      name: "a grant to the person",
      effect: "none",
      writes: ["grant"],
      act: (s) => grant(s.w, s.holder, 1000),
    },
    { name: "a hold", effect: "none", writes: ["hold"], act: (s) => held(s) },
    {
      name: "a release of a hold",
      effect: "none",
      writes: ["release"],
      setup: held,
      act: (s, job) => releaseHold(s.w.d1, { jobId: job }),
    },
    {
      name: "a provisional settlement within the hold",
      effect: "raises",
      writes: ["charge"],
      setup: held,
      act: (s, job) => settleProvisional(s.w.d1, { jobId: job, chargeMilli: 1500 }),
    },
    {
      name: "a provisional settlement above the hold (a charge and an overrun)",
      effect: "raises",
      writes: ["charge", "overrun"],
      setup: held,
      act: (s, job) => settleProvisional(s.w.d1, { jobId: job, chargeMilli: 7000 }),
    },
    {
      name: "a final settlement above the provisional figure",
      effect: "raises",
      writes: ["adjust"],
      setup: settled,
      act: (s, job) => settleFinal(s.w.d1, { jobId: job, finalMilli: 3500 }),
    },
    {
      name: "a final settlement equal to the provisional figure",
      effect: "none",
      writes: ["adjust"],
      setup: settled,
      act: (s, job) => settleFinal(s.w.d1, { jobId: job, finalMilli: 3000 }),
    },
    {
      name: "a final settlement below the provisional figure",
      effect: "lowers",
      writes: ["adjust"],
      setup: settled,
      act: (s, job) => settleFinal(s.w.d1, { jobId: job, finalMilli: 1000 }),
    },
    {
      name: "an administrator's correction of the charge, upward",
      effect: "raises",
      writes: ["adjust"],
      act: (s) => correction(s.w, s.holder, 700, s.budget.id),
    },
    {
      name: "an administrator's correction of the charge, downward",
      effect: "none",
      writes: ["adjust"],
      setup: settled,
      act: (s) => correction(s.w, s.holder, -700, null),
    },
    {
      name: "an administrator's correction of the grant, down and up",
      effect: "none",
      writes: ["adjust"],
      act: async (s) => {
        await adjustGrant(s, -900);
        return adjustGrant(s, 400);
      },
    },
    {
      name: "an unreserved job's charge to the partner pool (an overrun that names the budget)",
      effect: "raises",
      writes: ["overrun"],
      act: async (s) => {
        const tenant = await ensurePool(s.w.d1, "partner", "tenant", "cpu");
        const [statement] = unreservedChargeStatements(s.w.d1, {
          jobId: jobId(next()),
          poolId: tenant.id,
          budgetPoolId: s.budget.id,
          chargeMilli: 2000,
        });
        return statement?.run();
      },
    },
    {
      name: "an expiry of the person's unused balance",
      effect: "none",
      writes: ["expire"],
      act: (s) => expireUnused(s.w.d1, { poolId: s.holder.id, idempotencyKey: `expire-${next()}` }),
    },
  ];

  /** The vocabulary kinds that no operation of the service writes any more. */
  const UNWRITTEN: readonly LedgerEntryKind[] = ["refund"];

  const WORDS: Record<Effect, string> = {
    none: "does not move",
    raises: "rises",
    lowers: "falls",
  };

  for (const row of ROWS) {
    test(`${row.name}: the budget's consumption ${WORDS[row.effect]}`, async () => {
      const s = await scene("account");
      const job = row.setup ? await row.setup(s) : "";
      const before = (await reread(s.w, s.budget)).charged_milli;
      const entriesBefore = ledgerRows(s.w).length;
      await row.act(s, job);
      const after = (await reread(s.w, s.budget)).charged_milli;
      const effect: Effect = after < before ? "lowers" : after > before ? "raises" : "none";
      expect(effect).toBe(row.effect);
      // What the act wrote is the kinds the row says: a new kind of entry has to be written down.
      const written = ledgerRows(s.w)
        .slice(entriesBefore)
        .map((e) => e.kind);
      for (const kind of row.writes)
        expect(written, `${row.name} writes a ${kind}`).toContain(kind);
      // And whatever was written, only a job's final settlement names the budget AND lowers it.
      for (const e of ledgerRows(s.w)) {
        if (e.budget_pool_id === s.budget.id && e.charged_delta_milli < 0) {
          expect([e.kind, e.job_id === null, e.idempotency_key]).toEqual([
            "adjust",
            false,
            finalKey(e.job_id as string),
          ]);
        }
      }
      expect(await totalsDisagreements(s.w.d1)).toEqual([]);
    });
  }

  test("exactly one row lowers the budget, and it is the final settlement", () => {
    expect(ROWS.filter((r) => r.effect === "lowers").map((r) => r.name)).toEqual([
      "a final settlement below the provisional figure",
    ]);
  });

  test("the rows write every kind the vocabulary allows, but the ones that have no writer", () => {
    const written = new Set(ROWS.flatMap((r) => r.writes));
    expect(new Set([...written, ...UNWRITTEN])).toEqual(new Set(LEDGER_ENTRY_KINDS));
    for (const kind of UNWRITTEN) expect(written.has(kind)).toBe(false);
  });
});

describe("the refund path no longer exists", () => {
  test("the service exports no refund function, statement or key", () => {
    for (const name of ["refundJob", "REFUND_INSERT_SQL", "refundKey"]) {
      expect([name, name in ledgerModule]).toEqual([name, false]);
    }
    expect(Object.keys(ledgerModule).filter((n) => /refund/i.test(n))).toEqual([]);
  });

  test("a whole life of operations writes no entry of kind refund", async () => {
    const { w, holder, budget } = await scene("account");
    const job = await hold(w, holder, budget, 5000);
    await settleProvisional(w.d1, { jobId: job, chargeMilli: 6000 });
    await settleFinal(w.d1, { jobId: job, finalMilli: 5000 });
    await correction(w, holder, 100, budget.id);
    await correction(w, holder, -100, null);
    await releaseHold(w.d1, { jobId: await hold(w, holder, budget, 1000) });
    expect(ledgerRows(w, "kind = 'refund'")).toEqual([]);
  });
});
