/**
 * The rules the Opus checkpoint and the review panel of phase A2 (#2007; ADR 0118) settled, each on
 * the real migration and the real service (bun:sqlite behind `realD1`; the engine parity of the
 * statements is in compute-ledger-race.test.ts and compute-ledger-migration.test.ts).
 *
 * What is pinned: a refund entry that exists ends a job's charge (a final settlement after one is
 * `refunded`, never a re-charge; no code writes one any more, the owner having decided that no failure
 * is refunded, so the entry here is a row put in by hand); a job's final settlement happens once even when it equals the charge; a closing step
 * is replayed (the closing entry, `replayed: true`) when it is of the requested kind, and `hold_closed`
 * says which kind closed the hold otherwise; the hold's key is made of the job, so no caller can
 * build a colliding one, and an idempotency key is compared on EVERY field of the request; an
 * administrator's key is scoped to the actor; a refusal nothing explains is `insufficient_balance`
 * unless the caller passed a guard; a correction to a budget that is not there is `pool_not_found`;
 * a total that would pass 2^53 - 1 is `would_exceed_limit`, never an error; and every statement the
 * service exports searches `compute_ledger` by an index and never scans it.
 */

import { describe, expect, test } from "bun:test";
import * as ledgerModule from "../src/services/compute-ledger";
import {
  ComputeLedgerError,
  type PoolRow,
  adjustPool,
  adminKey,
  ensurePool,
  expireUnused,
  finalKey,
  findEntryByKey,
  grantPool,
  holdKey,
  placeHold,
  releaseHold,
  settleFinal,
  settleProvisional,
} from "../src/services/compute-ledger";
import * as policyModule from "../src/services/compute-policy";
import { jobId, totalsDisagreements } from "./helpers/compute-ledger";
import { freshDb, interceptingD1, realD1 } from "./helpers/d1";

const MAX = Number.MAX_SAFE_INTEGER;

let seq = 0;
const next = () => ++seq;

function world() {
  const db = freshDb();
  return { db, d1: realD1(db) };
}
type World = ReturnType<typeof world>;

const platform = (w: World, key: "pipelines" | "people", word: "cpu" | "gpu") =>
  ensurePool(w.d1, "platform", key, word);

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

/** A person with a grant, a platform budget with one, and a job held on them. */
async function held(
  w: World,
  o: { grantMilli?: number; budgetMilli?: number; holdMilli?: number } = {},
) {
  const person = await ensurePool(w.d1, "account", String(20000 + next()), "cpu");
  const budget = await platform(w, "people", "cpu");
  await grant(w, person, o.grantMilli ?? 100000);
  await grant(w, budget, o.budgetMilli ?? 100000);
  const job = jobId(next());
  const hold = await placeHold(w.d1, {
    poolId: person.id,
    budgetPoolId: budget.id,
    amountMilli: o.holdMilli ?? 5000,
    jobId: job,
  });
  expect(hold.ok).toBe(true);
  return { person, budget, job };
}

const count = async (w: World, where = "1 = 1") =>
  (
    await w.d1
      .prepare(`SELECT COUNT(*) AS n FROM compute_ledger WHERE ${where}`)
      .first<{ n: number }>()
  )?.n;

describe("the keys the ledger writes of itself", () => {
  test("a hold's key is made of its job, and a job has one", async () => {
    const w = world();
    const { job } = await held(w);
    expect(holdKey(job)).toBe(`job:${job}:hold`);
    expect(finalKey(job)).toBe(`job:${job}:final`);
    const entry = await findEntryByKey(w.d1, holdKey(job));
    expect(entry).toMatchObject({ kind: "hold", job_id: job });
  });

  test("a caller's key can never be one of them: a grant, an adjustment or an expiry that tries is refused", async () => {
    const w = world();
    const { person, job } = await held(w);
    // The retired refund key is still a `job:` key, which no caller may use.
    const taken = [holdKey(job), finalKey(job), `job:${job}:refund`, "hold:1:charge", "job:x"];
    for (const idempotencyKey of taken) {
      await expect(
        grantPool(w.d1, { poolId: person.id, amountMilli: 1, actorUserId: 1, idempotencyKey }),
      ).rejects.toMatchObject({ code: "invalid_argument" });
      await expect(
        adjustPool(w.d1, {
          poolId: person.id,
          grantedDeltaMilli: 1,
          actorUserId: 1,
          reason: "correction",
          idempotencyKey,
        }),
      ).rejects.toMatchObject({ code: "invalid_argument" });
      await expect(expireUnused(w.d1, { poolId: person.id, idempotencyKey })).rejects.toMatchObject(
        {
          code: "invalid_argument",
        },
      );
    }
    expect(await findEntryByKey(w.d1, finalKey(job))).toBeNull();
  });

  test("an administrator's key is scoped to the actor, and fits the table's 128 characters at the limit", async () => {
    expect(adminKey("grant", 7, "abcdefgh")).toBe("grant:7:abcdefgh");
    expect(adminKey("adjust", 7, "abcdefgh")).toBe("adjust:7:abcdefgh");
    const longest = adminKey("adjust", Number.MAX_SAFE_INTEGER, "k".repeat(100));
    expect(longest.length).toBeLessThanOrEqual(128);
    const w = world();
    const person = await ensurePool(w.d1, "account", "31", "cpu");
    const r = await grantPool(w.d1, {
      poolId: person.id,
      amountMilli: 5,
      actorUserId: Number.MAX_SAFE_INTEGER,
      idempotencyKey: adminKey("grant", Number.MAX_SAFE_INTEGER, "k".repeat(100)),
    });
    expect(r.ok).toBe(true);
    // Two actors sending the same key and body each grant: the key is not shared.
    const [a, b] = [adminKey("grant", 1, "samekey-1"), adminKey("grant", 2, "samekey-1")];
    for (const idempotencyKey of [a, b]) {
      const g = await grantPool(w.d1, {
        poolId: person.id,
        amountMilli: 100,
        actorUserId: 1,
        idempotencyKey,
      });
      expect(g).toMatchObject({ ok: true, replayed: false });
    }
    expect((await reread(w, person)).granted_milli).toBe(205);
  });
});

describe("a refund entry that exists ends a job's charge", () => {
  test("a final settlement after one is refused, whatever the figure, and moves no total", async () => {
    const w = world();
    const { person, budget, job } = await held(w);
    await settleProvisional(w.d1, { jobId: job, chargeMilli: 3000 });
    // No function of the service writes a refund (the owner decided that none is automatic), but the
    // kind stays in the table's vocabulary, so a row of it put in by hand, which names no budget,
    // is what this guard is for: it must not be possible to charge the job again after it.
    w.db.run(
      `INSERT INTO compute_ledger (kind, pool_id, budget_pool_id, charged_delta_milli, job_id, reason, idempotency_key)
       VALUES ('refund', ?, NULL, -3000, ?, 'refund', ?)`,
      [person.id, job, `by-hand:${job}`],
    );
    const entries = await count(w);
    const before = [await reread(w, person), await reread(w, budget)];
    expect(before.map((p) => p.charged_milli)).toEqual([0, 3000]);
    for (const finalMilli of [3000, 3500, 0, 1]) {
      expect([finalMilli, await settleFinal(w.d1, { jobId: job, finalMilli })]).toEqual([
        finalMilli,
        { ok: false, code: "refunded" },
      ]);
    }
    expect(await count(w)).toBe(entries);
    expect([await reread(w, person), await reread(w, budget)]).toEqual(before);
    expect(await totalsDisagreements(w.d1)).toEqual([]);
  });
});

describe("a job's final settlement happens once, even of nothing", () => {
  test("a final figure equal to the charge is an entry of nothing, and the next figure is already_final", async () => {
    const w = world();
    const { person, budget, job } = await held(w);
    await settleProvisional(w.d1, { jobId: job, chargeMilli: 3000 });
    const first = await settleFinal(w.d1, { jobId: job, finalMilli: 3000 });
    expect(first).toMatchObject({ ok: true, replayed: false, deltaMilli: 0 });
    if (!first.ok) return;
    expect(first.entry).toMatchObject({
      kind: "adjust",
      job_id: job,
      granted_delta_milli: 0,
      charged_delta_milli: 0,
      budget_pool_id: budget.id,
      reason: "final_settlement",
    });
    expect(first.entry.idempotency_key).toBe(finalKey(job));
    const entries = await count(w);
    // A different figure afterwards is refused: the final settlement already happened.
    expect(await settleFinal(w.d1, { jobId: job, finalMilli: 3500 })).toEqual({
      ok: false,
      code: "already_final",
    });
    expect(await settleFinal(w.d1, { jobId: job, finalMilli: 1 })).toEqual({
      ok: false,
      code: "already_final",
    });
    // The same figure is a replay of it.
    const again = await settleFinal(w.d1, { jobId: job, finalMilli: 3000 });
    expect(again).toMatchObject({ ok: true, replayed: true, deltaMilli: 0 });
    if (again.ok) expect(again.entry).toEqual(first.entry);
    expect(await count(w)).toBe(entries);
    expect((await reread(w, person)).charged_milli).toBe(3000);
    expect(await totalsDisagreements(w.d1)).toEqual([]);
  });

  test("a final figure that differs is one entry of the difference, replayed by its own figure only", async () => {
    const w = world();
    const { person, job } = await held(w);
    await settleProvisional(w.d1, { jobId: job, chargeMilli: 3000 });
    const first = await settleFinal(w.d1, { jobId: job, finalMilli: 3500 });
    expect(first).toMatchObject({ ok: true, replayed: false, deltaMilli: 500 });
    expect(await settleFinal(w.d1, { jobId: job, finalMilli: 3500 })).toMatchObject({
      ok: true,
      replayed: true,
      deltaMilli: 500,
    });
    expect(await settleFinal(w.d1, { jobId: job, finalMilli: 3600 })).toEqual({
      ok: false,
      code: "already_final",
    });
    expect((await reread(w, person)).charged_milli).toBe(3500);
  });

  test("the entry names the job's charge, so a later reader sums it with the charge and the overrun", async () => {
    const w = world();
    const { job } = await held(w);
    await settleProvisional(w.d1, { jobId: job, chargeMilli: 7000 });
    await settleFinal(w.d1, { jobId: job, finalMilli: 6000 });
    const sum = await w.d1
      .prepare(
        "SELECT SUM(charged_delta_milli) AS s FROM compute_ledger WHERE job_id = ? AND kind IN ('charge', 'overrun', 'refund', 'adjust')",
      )
      .bind(job)
      .first<{ s: number }>();
    expect(sum?.s).toBe(6000);
  });
});

describe("a job's charge is the job's own, not its pool's", () => {
  /** Two jobs held on one pool. */
  async function twoJobs() {
    const w = world();
    const person = await ensurePool(w.d1, "account", String(20000 + next()), "cpu");
    const budget = await platform(w, "people", "cpu");
    await grant(w, person, 100000);
    await grant(w, budget, 100000);
    const [a, b] = [jobId(next()), jobId(next())];
    for (const jobId of [a, b]) {
      expect(
        (
          await placeHold(w.d1, {
            poolId: person.id,
            budgetPoolId: budget.id,
            amountMilli: 5000,
            jobId,
          })
        ).ok,
      ).toBe(true);
    }
    return { w, person, a, b };
  }

  test("a final settlement is replayed by the job's own figure while another job charges the pool", async () => {
    const { w, a, b } = await twoJobs();
    await settleProvisional(w.d1, { jobId: a, chargeMilli: 3000 });
    await settleProvisional(w.d1, { jobId: b, chargeMilli: 4000 });
    expect(await settleFinal(w.d1, { jobId: a, finalMilli: 3500 })).toMatchObject({
      ok: true,
      replayed: false,
      deltaMilli: 500,
    });
    // The pool holds 7500 and the job 3500: the replay is of the job's figure.
    expect(await settleFinal(w.d1, { jobId: a, finalMilli: 3500 })).toMatchObject({
      ok: true,
      replayed: true,
    });
    expect(await settleFinal(w.d1, { jobId: a, finalMilli: 7500 })).toEqual({
      ok: false,
      code: "already_final",
    });
  });
});

describe("a closing step is replayed when it is of the requested kind", () => {
  test("a release replayed returns the release, and one after a settlement says the hold was settled", async () => {
    const w = world();
    const { job } = await held(w, { holdMilli: 5000 });
    const first = await releaseHold(w.d1, { jobId: job, reason: "never_started" });
    expect(first).toMatchObject({ ok: true, replayed: false, releasedMilli: 5000 });
    const entries = await count(w);
    expect(await releaseHold(w.d1, { jobId: job, reason: "never_started" })).toEqual({
      ...(first as object),
      replayed: true,
    });
    expect(await settleProvisional(w.d1, { jobId: job, chargeMilli: 1 })).toEqual({
      ok: false,
      code: "hold_closed",
      closedBy: "released",
    });
    expect(await count(w)).toBe(entries);
  });

  test("a settlement replayed with the same figure returns it, overrun included; another figure is hold_closed", async () => {
    const w = world();
    const { job } = await held(w, { holdMilli: 5000 });
    const first = await settleProvisional(w.d1, { jobId: job, chargeMilli: 8000 });
    expect(first).toMatchObject({
      ok: true,
      replayed: false,
      chargedMilli: 5000,
      overrunMilli: 3000,
      releasedMilli: 0,
    });
    const entries = await count(w);
    expect(await settleProvisional(w.d1, { jobId: job, chargeMilli: 8000 })).toEqual({
      ...(first as object),
      replayed: true,
    });
    for (const chargeMilli of [7999, 8001, 0, 99999]) {
      expect(await settleProvisional(w.d1, { jobId: job, chargeMilli })).toEqual({
        ok: false,
        code: "hold_closed",
        closedBy: "settled",
      });
    }
    expect(await releaseHold(w.d1, { jobId: job })).toEqual({
      ok: false,
      code: "hold_closed",
      closedBy: "settled",
    });
    expect(await count(w)).toBe(entries);
    expect(await totalsDisagreements(w.d1)).toEqual([]);
  });

  test("a settlement of less than the hold is replayed with what it released", async () => {
    const w = world();
    const { job } = await held(w, { holdMilli: 5000 });
    const first = await settleProvisional(w.d1, { jobId: job, chargeMilli: 3200 });
    expect(await settleProvisional(w.d1, { jobId: job, chargeMilli: 3200 })).toEqual({
      ...(first as object),
      replayed: true,
    });
    expect(first).toMatchObject({ chargedMilli: 3200, releasedMilli: 1800, overrunMilli: 0 });
  });

  test("a job that was never held is no_hold, and not a replay of anything", async () => {
    const w = world();
    const job = jobId(next());
    expect(await releaseHold(w.d1, { jobId: job })).toEqual({ ok: false, code: "no_hold" });
    expect(await settleProvisional(w.d1, { jobId: job, chargeMilli: 1 })).toEqual({
      ok: false,
      code: "no_hold",
    });
  });
});

describe("a hold is replayed by its job, and a request for it is compared on every field", () => {
  test("the same hold again is a replay; a different pool, budget, amount is a conflict, never a second hold", async () => {
    const w = world();
    const person = await ensurePool(w.d1, "account", "41", "cpu");
    const other = await ensurePool(w.d1, "account", "42", "cpu");
    const budget = await platform(w, "people", "cpu");
    const pipelines = await platform(w, "pipelines", "cpu");
    await grant(w, person, 90000);
    await grant(w, other, 90000);
    await grant(w, budget, 90000);
    await grant(w, pipelines, 90000);
    const job = jobId(next());
    const same = { poolId: person.id, budgetPoolId: budget.id, amountMilli: 5000, jobId: job };
    const first = await placeHold(w.d1, same);
    expect(first).toMatchObject({ ok: true, replayed: false });
    expect(await placeHold(w.d1, same)).toMatchObject({ ok: true, replayed: true });
    const variants: Array<[string, Partial<typeof same> & { budgetPoolId?: number | null }]> = [
      ["another pool", { poolId: other.id }],
      ["another budget", { budgetPoolId: null }],
      ["a platform pool as the pool", { poolId: pipelines.id, budgetPoolId: null }],
      ["another amount", { amountMilli: 5001 }],
      ["a smaller amount", { amountMilli: 4999 }],
    ];
    for (const [name, over] of variants) {
      await expect(placeHold(w.d1, { ...same, ...over }), name).rejects.toMatchObject({
        code: "idempotency_conflict",
      });
    }
    expect(await count(w, "kind = 'hold'")).toBe(1);
  });

  test("a hold that is open when it is replayed is still a replay, and its pool holds it once", async () => {
    const w = world();
    const person = await ensurePool(w.d1, "account", "43", "cpu");
    const budget = await platform(w, "people", "cpu");
    await grant(w, person, 90000);
    await grant(w, budget, 90000);
    const same = {
      poolId: person.id,
      budgetPoolId: budget.id,
      amountMilli: 5000,
      jobId: jobId(next()),
    };
    const first = await placeHold(w.d1, same);
    expect(first).toMatchObject({ ok: true, replayed: false });
    const entries = await count(w);
    for (let again = 0; again < 3; again++) {
      expect(await placeHold(w.d1, same)).toEqual({
        ok: true,
        replayed: true,
        entry: (first as { entry: object }).entry,
      });
    }
    expect(await count(w)).toBe(entries);
    expect((await reread(w, person)).held_milli).toBe(5000);
  });

  test("a hold that was released is hold_closed when it is asked for again, and nothing is written", async () => {
    const w = world();
    const person = await ensurePool(w.d1, "account", "44", "cpu");
    const budget = await platform(w, "people", "cpu");
    await grant(w, person, 90000);
    await grant(w, budget, 90000);
    const same = {
      poolId: person.id,
      budgetPoolId: budget.id,
      amountMilli: 5000,
      jobId: jobId(next()),
    };
    expect(await placeHold(w.d1, same)).toMatchObject({ ok: true, replayed: false });
    expect(await releaseHold(w.d1, { jobId: same.jobId })).toMatchObject({ ok: true });
    expect((await reread(w, person)).held_milli).toBe(0);
    const entries = await count(w);
    expect(await placeHold(w.d1, same)).toEqual({
      ok: false,
      code: "hold_closed",
      closedBy: "released",
    });
    expect(await count(w)).toBe(entries);
    expect((await reread(w, person)).held_milli).toBe(0);
    // The settlement the caller would then try agrees: the hold is closed, and the refusal says by what.
    expect(await settleProvisional(w.d1, { jobId: same.jobId, chargeMilli: 1 })).toEqual({
      ok: false,
      code: "hold_closed",
      closedBy: "released",
    });
    expect(await totalsDisagreements(w.d1)).toEqual([]);
  });

  test("a hold that was settled is hold_closed when it is asked for again, overrun or not", async () => {
    const w = world();
    const person = await ensurePool(w.d1, "account", "45", "cpu");
    const budget = await platform(w, "people", "cpu");
    await grant(w, person, 90000);
    await grant(w, budget, 90000);
    for (const used of [3200, 5000, 8000]) {
      const same = {
        poolId: person.id,
        budgetPoolId: budget.id,
        amountMilli: 5000,
        jobId: jobId(next()),
      };
      expect(await placeHold(w.d1, same)).toMatchObject({ ok: true, replayed: false });
      expect(await settleProvisional(w.d1, { jobId: same.jobId, chargeMilli: used })).toMatchObject(
        {
          ok: true,
        },
      );
      const entries = await count(w);
      const before = await reread(w, person);
      expect(await placeHold(w.d1, same), `settled with ${used}`).toEqual({
        ok: false,
        code: "hold_closed",
        closedBy: "settled",
      });
      expect(await count(w)).toBe(entries);
      expect(await reread(w, person)).toEqual(before);
    }
    expect(await totalsDisagreements(w.d1)).toEqual([]);
  });

  test("a closed hold asked for with another request is still idempotency_conflict, not hold_closed", async () => {
    const w = world();
    const person = await ensurePool(w.d1, "account", "46", "cpu");
    const budget = await platform(w, "people", "cpu");
    await grant(w, person, 90000);
    await grant(w, budget, 90000);
    const same = {
      poolId: person.id,
      budgetPoolId: budget.id,
      amountMilli: 5000,
      jobId: jobId(next()),
    };
    await placeHold(w.d1, same);
    await releaseHold(w.d1, { jobId: same.jobId });
    await expect(placeHold(w.d1, { ...same, amountMilli: 5001 })).rejects.toMatchObject({
      code: "idempotency_conflict",
    });
  });
});

describe("an idempotency key is compared on every field of the request", () => {
  const key = (name: string) => adminKey("adjust", 1, `${name}-key-${next()}`);

  test("a grant: pool, amount and reason, and the kind of the entry that holds the key", async () => {
    const w = world();
    const a = await ensurePool(w.d1, "account", "51", "cpu");
    const b = await ensurePool(w.d1, "account", "52", "cpu");
    const base = { poolId: a.id, amountMilli: 1000, actorUserId: 1, reason: "top_up" };
    const k = adminKey("grant", 1, "grant-key-1");
    expect(await grantPool(w.d1, { ...base, idempotencyKey: k })).toMatchObject({ ok: true });
    expect(await grantPool(w.d1, { ...base, idempotencyKey: k })).toMatchObject({
      ok: true,
      replayed: true,
    });
    const variants: Array<[string, Partial<typeof base>]> = [
      ["another pool", { poolId: b.id }],
      ["another amount", { amountMilli: 1001 }],
      ["another reason", { reason: "correction" }],
      ["no reason (the default)", { reason: undefined }],
    ];
    for (const [name, over] of variants) {
      await expect(
        grantPool(w.d1, { ...base, ...over, idempotencyKey: k }),
        name,
      ).rejects.toMatchObject({
        code: "idempotency_conflict",
      });
    }
    // The key of an adjustment is not a grant's.
    const adj = key("adj");
    await adjustPool(w.d1, {
      poolId: a.id,
      grantedDeltaMilli: 5,
      actorUserId: 1,
      reason: "correction",
      idempotencyKey: adj,
    });
    await expect(
      grantPool(w.d1, { poolId: a.id, amountMilli: 5, actorUserId: 1, idempotencyKey: adj }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect((await reread(w, a)).granted_milli).toBe(1005);
    // The same pool, amount and reason on an entry of ANOTHER KIND is still not a replay of a grant.
    const sameShape = key("same-shape");
    await adjustPool(w.d1, {
      poolId: a.id,
      grantedDeltaMilli: 7,
      actorUserId: 1,
      reason: "grant",
      idempotencyKey: sameShape,
    });
    await expect(
      grantPool(w.d1, { poolId: a.id, amountMilli: 7, actorUserId: 1, idempotencyKey: sameShape }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  test("an adjustment: pool, budget, each delta and the reason", async () => {
    const w = world();
    const a = await ensurePool(w.d1, "account", "53", "cpu");
    const b = await ensurePool(w.d1, "account", "54", "cpu");
    const people = await platform(w, "people", "cpu");
    await grant(w, a, 50000);
    await grant(w, b, 50000);
    await grant(w, people, 50000);
    const base = {
      poolId: a.id,
      budgetPoolId: people.id as number | null,
      chargedDeltaMilli: 700 as number | undefined,
      grantedDeltaMilli: undefined as number | undefined,
      actorUserId: 1,
      reason: "correction",
    };
    const k = key("adjust");
    expect(await adjustPool(w.d1, { ...base, idempotencyKey: k })).toMatchObject({ ok: true });
    expect(await adjustPool(w.d1, { ...base, idempotencyKey: k })).toMatchObject({
      ok: true,
      replayed: true,
    });
    const variants: Array<[string, Partial<typeof base>]> = [
      ["another pool", { poolId: b.id }],
      ["another budget (none)", { budgetPoolId: null }],
      ["another charged delta", { chargedDeltaMilli: 701 }],
      [
        "the grant instead of the charge",
        { chargedDeltaMilli: undefined, grantedDeltaMilli: 700, budgetPoolId: null },
      ],
      ["another reason", { reason: "expanse_figure" }],
    ];
    for (const [name, over] of variants) {
      let outcome: unknown;
      try {
        outcome = await adjustPool(w.d1, { ...base, ...over, idempotencyKey: k });
      } catch (err) {
        outcome = err instanceof ComputeLedgerError ? err.code : String(err);
      }
      expect([name, outcome]).toEqual([name, "idempotency_conflict"]);
    }
    expect((await reread(w, a)).charged_milli).toBe(700);
    expect(await count(w, "kind = 'adjust'")).toBe(1);
  });

  test("an expiry: pool and reason", async () => {
    const w = world();
    const a = await ensurePool(w.d1, "account", "55", "cpu");
    const b = await ensurePool(w.d1, "account", "56", "cpu");
    await grant(w, a, 500);
    await grant(w, b, 500);
    const k = key("expire");
    expect(
      await expireUnused(w.d1, { poolId: a.id, reason: "expired", idempotencyKey: k }),
    ).toMatchObject({
      ok: true,
      replayed: false,
    });
    expect(
      await expireUnused(w.d1, { poolId: a.id, reason: "expired", idempotencyKey: k }),
    ).toMatchObject({
      ok: true,
      replayed: true,
    });
    for (const over of [{ poolId: b.id }, { reason: "lapsed" }]) {
      await expect(
        expireUnused(w.d1, { poolId: a.id, reason: "expired", idempotencyKey: k, ...over }),
      ).rejects.toMatchObject({ code: "idempotency_conflict" });
    }
  });
});

describe("a refusal nothing explains", () => {
  /** A person who is short by 100 until the first read of their pool, which a grant lands between. */
  async function racedHold(extraGuards?: Array<{ sql: string; binds?: unknown[] }>) {
    const w = world();
    const person = await ensurePool(w.d1, "account", "61", "cpu");
    const budget = await platform(w, "people", "cpu");
    await grant(w, person, 100);
    await grant(w, budget, 100000);
    let landed = false;
    const raced = interceptingD1(w.d1, async (sql) => {
      if (!landed && /FROM compute_pools WHERE id = \?1/.test(sql)) {
        landed = true;
        // The balance arrives after the hold was refused and before the reasons are read.
        await grantPool(w.d1, {
          poolId: person.id,
          amountMilli: 100000,
          actorUserId: 1,
          idempotencyKey: `grant-${next()}`,
        });
      }
    });
    const result = await placeHold(raced, {
      poolId: person.id,
      budgetPoolId: budget.id,
      amountMilli: 500,
      jobId: jobId(next()),
      extraGuards,
    });
    return { result, landed };
  }

  test("is insufficient_balance when no guard was passed", async () => {
    const { result, landed } = await racedHold();
    expect(landed).toBe(true);
    expect(result).toEqual({ ok: false, code: "insufficient_balance" });
  });

  test("is guard_refused only when the caller passed a guard", async () => {
    const { result, landed } = await racedHold([{ sql: "1 = 1" }]);
    expect(landed).toBe(true);
    expect(result).toEqual({ ok: false, code: "guard_refused" });
  });
});

describe("a correction to a budget that is not there", () => {
  test("is pool_not_found, not would_go_negative, and writes nothing", async () => {
    const w = world();
    const person = await ensurePool(w.d1, "account", "71", "cpu");
    await grant(w, person, 1000);
    const before = await count(w);
    await expect(
      adjustPool(w.d1, {
        poolId: person.id,
        budgetPoolId: 987654,
        chargedDeltaMilli: 5,
        actorUserId: 1,
        reason: "correction",
        idempotencyKey: `adjust-${next()}`,
      }),
    ).rejects.toMatchObject({ code: "pool_not_found" });
    expect(await count(w)).toBe(before);
  });
});

describe("a total that would pass 2^53 - 1", () => {
  test("is would_exceed_limit for a grant and a positive adjustment, and writes nothing", async () => {
    const w = world();
    const person = await ensurePool(w.d1, "account", "81", "cpu");
    const people = await platform(w, "people", "cpu");
    await grant(w, person, MAX - 5);
    const before = await count(w);
    const adj = (over: Record<string, unknown>) =>
      adjustPool(w.d1, {
        poolId: person.id,
        actorUserId: 1,
        reason: "correction",
        idempotencyKey: `adjust-${next()}`,
        ...over,
      } as never);
    expect(
      await grantPool(w.d1, {
        poolId: person.id,
        amountMilli: 6,
        actorUserId: 1,
        idempotencyKey: `grant-${next()}`,
      }),
    ).toEqual({ ok: false, code: "would_exceed_limit" });
    expect(await adj({ grantedDeltaMilli: 6 })).toEqual({ ok: false, code: "would_exceed_limit" });
    expect(await count(w)).toBe(before);
    // A charge that fills the pool's charged to the largest total is accepted, and one more is not.
    expect(await adj({ chargedDeltaMilli: MAX, budgetPoolId: people.id })).toMatchObject({
      ok: true,
    });
    expect(await adj({ chargedDeltaMilli: 1, budgetPoolId: people.id })).toEqual({
      ok: false,
      code: "would_exceed_limit",
    });
    // Exactly the room is accepted, and then there is none.
    expect(
      await grantPool(w.d1, {
        poolId: person.id,
        amountMilli: 5,
        actorUserId: 1,
        idempotencyKey: `grant-${next()}`,
      }),
    ).toMatchObject({ ok: true });
    expect((await reread(w, person)).granted_milli).toBe(MAX);
    expect(
      await grantPool(w.d1, {
        poolId: person.id,
        amountMilli: 1,
        actorUserId: 1,
        idempotencyKey: `grant-${next()}`,
      }),
    ).toEqual({
      ok: false,
      code: "would_exceed_limit",
    });
  });

  test("is would_exceed_limit when it is the pool's own charged, with no budget to say so", async () => {
    const w = world();
    const pipelines = await platform(w, "pipelines", "cpu");
    const adj = (chargedDeltaMilli: number) =>
      adjustPool(w.d1, {
        poolId: pipelines.id,
        chargedDeltaMilli,
        actorUserId: 1,
        reason: "correction",
        idempotencyKey: `adjust-${next()}`,
      });
    expect(await adj(MAX)).toMatchObject({ ok: true });
    const before = await count(w);
    expect(await adj(1)).toEqual({ ok: false, code: "would_exceed_limit" });
    expect(await count(w)).toBe(before);
  });

  test("is would_exceed_limit when it is the budget's charged that would pass it", async () => {
    const w = world();
    const person = await ensurePool(w.d1, "account", "82", "cpu");
    const other = await ensurePool(w.d1, "account", "83", "cpu");
    const people = await platform(w, "people", "cpu");
    // The budget has nearly all the room taken: a charge on another account counted against it.
    expect(
      await adjustPool(w.d1, {
        poolId: other.id,
        budgetPoolId: people.id,
        chargedDeltaMilli: MAX - 10,
        actorUserId: 1,
        reason: "correction",
        idempotencyKey: `adjust-${next()}`,
      }),
    ).toMatchObject({ ok: true });
    expect(
      await adjustPool(w.d1, {
        poolId: person.id,
        budgetPoolId: people.id,
        chargedDeltaMilli: 11,
        actorUserId: 1,
        reason: "correction",
        idempotencyKey: `adjust-${next()}`,
      }),
    ).toEqual({ ok: false, code: "would_exceed_limit" });
    expect((await reread(w, person)).charged_milli).toBe(0);
  });
});

describe("every statement the service exports searches compute_ledger by an index", () => {
  const exported = (): Array<[string, string]> =>
    [ledgerModule, policyModule].flatMap((m) =>
      Object.entries(m).filter(
        (e): e is [string, string] => e[0].endsWith("_SQL") && typeof e[1] === "string",
      ),
    );

  /** The names a statement calls compute_ledger by: its own, and every alias it gives it. */
  function ledgerNames(sql: string): string[] {
    const aliases = [...sql.matchAll(/(?:FROM|JOIN)\s+compute_ledger\s+(\w+)/gi)]
      .map((m) => m[1] as string)
      .filter(
        (a) =>
          !/^(WHERE|JOIN|ON|UNION|ORDER|GROUP|LIMIT|AND|OR|SET|VALUES|LEFT|INNER|CROSS)$/i.test(a),
      );
    return ["compute_ledger", ...aliases];
  }

  test("the scan reads the statements it is meant to", () => {
    const names = exported().map(([n]) => n);
    for (const n of [
      "HOLD_INSERT_SQL",
      "RELEASE_INSERT_SQL",
      "SETTLE_INSERT_SQL",
      "FINAL_INSERT_SQL",
      "GRANT_INSERT_SQL",
      "ADJUST_INSERT_SQL",
      "EXPIRE_INSERT_SQL",
      "ENTRY_BY_KEY_SQL",
      "HOLD_OF_JOB_SQL",
      "JOB_CHARGE_SQL",
      "AUDIT_LEDGER_ENTRY_SQL",
      "POLICY_CURRENT_SQL",
    ]) {
      expect(names).toContain(n);
    }
    // A plan row that scans the ledger is what this test refuses: prove it sees one.
    expect(ledgerNames("SELECT 1 FROM compute_ledger c WHERE c.kind = 'x'")).toContain("c");
    expect(ledgerNames("SELECT 1 FROM compute_ledger WHERE x = 1")).toEqual(["compute_ledger"]);
  });

  test("no plan scans it, with aliases resolved", () => {
    const db = freshDb();
    const offences: string[] = [];
    for (const [name, sql] of exported()) {
      const params = Math.max(0, ...[...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1])));
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...Array(params).fill(1)) as Array<{
        detail: string;
      }>;
      const names = ledgerNames(sql);
      for (const { detail } of plan) {
        const scanned = /^SCAN (\w+)/.exec(detail)?.[1];
        if (scanned && names.includes(scanned)) offences.push(`${name}: ${detail}`);
      }
    }
    expect(offences).toEqual([]);
  });

  test("a plan that scans is seen: the test refuses a statement that does", () => {
    const db = freshDb();
    const sql = "SELECT COUNT(*) FROM compute_ledger c WHERE c.charged_delta_milli > 5";
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>;
    const scanned = plan.map((p) => /^SCAN (\w+)/.exec(p.detail)?.[1]).filter(Boolean);
    expect(scanned.some((s) => ledgerNames(sql).includes(s as string))).toBe(true);
  });
});
