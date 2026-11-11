/**
 * The charge of use that skipped the reservation (epic #2005 phase A7, #2012; ADR 0118; design section 6),
 * against the real migration on a real database (bun:sqlite behind `realD1`, with the ledger's own triggers).
 *
 * The issue says "a `charge` entry (no hold)". The table refuses a `charge` that closes no hold
 * (`compute_ledger_closes_its_hold`), and a job nobody reserved has none, so the entry is an `overrun`:
 * use charged to the pool without a hold, counted against the `people` budget, with the balance free to go
 * negative. What is pinned:
 *  - it is written to a PARTNER pool only: aimed at a person's pool or a platform pool it writes nothing
 *    (MUTATION: drop `p.holder_kind = 'partner'`);
 *  - it names the budget (the table refuses an unreserved charge that does not) and moves the pool and
 *    the budget together; no total disagrees with the ledger after it;
 *  - it is written once per job (the key), and not at all for a figure of 0;
 *  - a gate decides whether it is written (the batch of the sweep);
 *  - it does not close or open a hold, and a job that has one is not affected.
 */

import { describe, expect, test } from "bun:test";
import {
  UNRESERVED_CHARGE_INSERT_SQL,
  availableMilli,
  ensurePool,
  platformPool,
  unreservedChargeStatements,
  unreservedKey,
} from "../src/services/compute-ledger";
import { jobId, totalsDisagreements } from "./helpers/compute-ledger";
import { freshDb, realD1 } from "./helpers/d1";

async function world() {
  const db = freshDb();
  const d1 = realD1(db);
  const tenant = await ensurePool(d1, "partner", "tenant", "cpu");
  const person = await ensurePool(d1, "account", "77", "cpu");
  const people = await platformPool(d1, "people", "cpu");
  const pipelines = await platformPool(d1, "pipelines", "cpu");
  if (!people || !pipelines) throw new Error("the platform pools are seeded");
  return { db, d1, tenant, person, people, pipelines };
}

const entriesOf = (db: ReturnType<typeof freshDb>, job: string) =>
  db
    .query(
      "SELECT kind, pool_id, budget_pool_id, charged_delta_milli, reason, idempotency_key, hold_ref FROM compute_ledger WHERE job_id = ?",
    )
    .all(job) as Array<Record<string, unknown>>;

describe("an unreserved charge", () => {
  test("is an overrun on the partner pool, counted against the people budget, with no hold, and the pool's available goes negative", async () => {
    const w = await world();
    const job = jobId(1);
    const [statement] = unreservedChargeStatements(w.d1, {
      jobId: job,
      poolId: w.tenant.id,
      budgetPoolId: w.people.id,
      chargeMilli: 2000,
    });
    await statement?.run();
    expect(entriesOf(w.db, job)).toEqual([
      {
        kind: "overrun",
        pool_id: w.tenant.id,
        budget_pool_id: w.people.id,
        charged_delta_milli: 2000,
        reason: "unreserved_usage",
        idempotency_key: unreservedKey(job),
        hold_ref: null,
      },
    ]);
    const pools = w.db
      .query(
        "SELECT id, granted_milli, held_milli, charged_milli FROM compute_pools WHERE id IN (?, ?)",
      )
      .all(w.tenant.id, w.people.id);
    expect(pools).toEqual([
      { id: w.people.id, granted_milli: 0, held_milli: 0, charged_milli: 2000 },
      { id: w.tenant.id, granted_milli: 0, held_milli: 0, charged_milli: 2000 },
    ]);
    // Available is negative: an overrun is a fact that already happened, and the pool had nothing.
    const tenant = w.db
      .query("SELECT granted_milli, held_milli, charged_milli FROM compute_pools WHERE id = ?")
      .get(w.tenant.id) as { granted_milli: number; held_milli: number; charged_milli: number };
    expect(availableMilli(tenant)).toBe(-2000);
    expect(await totalsDisagreements(w.d1)).toEqual([]);
  });

  test("writes nothing aimed at a person's pool or a platform pool (MUTATION: drop the partner term)", async () => {
    const w = await world();
    for (const pool of [w.person, w.pipelines, w.people]) {
      const job = jobId(10 + pool.id);
      const [statement] = unreservedChargeStatements(w.d1, {
        jobId: job,
        poolId: pool.id,
        budgetPoolId: w.people.id,
        chargeMilli: 500,
      });
      // The statement writes nothing for a pool that is not a partner's. (Aimed at a platform pool with a
      // budget named, the table would refuse it anyway; the statement refuses first.)
      await statement?.run();
      expect(entriesOf(w.db, job)).toEqual([]);
    }
    expect(w.db.query("SELECT COUNT(*) AS n FROM compute_ledger").get()).toEqual({ n: 0 });
  });

  test("is written once per job, and not at all for a figure of 0", async () => {
    const w = await world();
    const job = jobId(2);
    const input = { jobId: job, poolId: w.tenant.id, budgetPoolId: w.people.id, chargeMilli: 700 };
    await unreservedChargeStatements(w.d1, input)[0]?.run();
    expect(entriesOf(w.db, job)).toHaveLength(1);
    await unreservedChargeStatements(w.d1, { ...input, chargeMilli: 900 })[0]?.run();
    expect(entriesOf(w.db, job)).toHaveLength(1);
    expect(entriesOf(w.db, job)[0]?.charged_delta_milli).toBe(700);
    const zero = jobId(3);
    await unreservedChargeStatements(w.d1, { ...input, jobId: zero, chargeMilli: 0 })[0]?.run();
    expect(entriesOf(w.db, zero)).toEqual([]);
  });

  test("a gate decides whether it is written, and its values are bound after the statement's own", async () => {
    const w = await world();
    const job = jobId(4);
    const gated = (open: number) =>
      unreservedChargeStatements(
        w.d1,
        { jobId: job, poolId: w.tenant.id, budgetPoolId: w.people.id, chargeMilli: 300 },
        { sql: "? = 1", binds: [open] },
      )[0];
    await gated(0)?.run();
    expect(entriesOf(w.db, job)).toEqual([]);
    await gated(1)?.run();
    expect(entriesOf(w.db, job)).toHaveLength(1);
    expect(() =>
      unreservedChargeStatements(
        w.d1,
        { jobId: job, poolId: 1, budgetPoolId: 1, chargeMilli: 1 },
        { sql: "? = 1 AND ? = 2", binds: [1] },
      ),
    ).toThrow(/binds one value/);
  });

  test("its arguments are checked before a statement exists", async () => {
    const w = await world();
    const ok = { jobId: jobId(5), poolId: w.tenant.id, budgetPoolId: w.people.id, chargeMilli: 1 };
    for (const bad of [
      { ...ok, jobId: "job_nope" },
      { ...ok, poolId: 0 },
      { ...ok, budgetPoolId: -1 },
      { ...ok, chargeMilli: -1 },
      { ...ok, chargeMilli: 1.5 },
    ]) {
      expect(() => unreservedChargeStatements(w.d1, bad)).toThrow();
    }
    expect(UNRESERVED_CHARGE_INSERT_SQL).toContain("holder_kind = 'partner'");
  });
});
