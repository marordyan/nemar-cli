/**
 * What a job is charged, and the one batch that charges it (epic #2005 phase A5, #2010; ADR 0118),
 * round 1 of the review of PR #2041. Real migrations, the real ledger (its triggers included), Miniflare's
 * R2, the Tapis stand-in (no response of which was recorded from a real tenant), on bun:sqlite and on
 * Miniflare's D1 where a case says so.
 *
 * What is pinned, each with a test of its own:
 *  - ONLY A JOB THAT NEVER STARTED IS RELEASED. A release closes the hold and the ledger then refuses a
 *    charge, so a job that RAN and was released would never be charged: Tapis FINISHED with no start time,
 *    a FAILED job after the launcher claimed bytes, and a start time that is not a time each charge (the
 *    minimum, or the hold) and flag `mismatch`; a job nothing shows ran is still released in full
 *    (MUTATION: release whenever there is no parsable start);
 *  - a time that runs backwards is zero seconds, not an error (MUTATION: drop `Math.max(0, ...)`);
 *  - ONE BATCH: a charge the table refuses rolls the state change back with it, on bun:sqlite and on
 *    Miniflare's D1, and the retry settles once (MUTATION: run the statements one after the other);
 *  - the gate: a writer that lost to a live write settles nothing in its first batch (MUTATION: the gate
 *    always true); the settled stamp is written only when the ledger holds the closing entry (MUTATION:
 *    drop the `EXISTS` guard).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { RATE_TABLE_V1 } from "../../shared/contract/compute";
import { runComputeAdvanceCron } from "../src/services/compute-advance";
import {
  advanceComputeJob,
  applyTapisJob,
  provisionalCharge,
  submitComputeJob,
} from "../src/services/compute-lifecycle";
import type { Bindings } from "../src/types/bindings";
import {
  type LifecycleFixture,
  MINUTE,
  type MadeJob,
  makeJob,
  playLauncher,
  reread,
  setTapisTimes,
  startLifecycleFixture,
} from "./helpers/compute-lifecycle-fixture";
import { fundPlatform, seedUser, setPolicy } from "./helpers/compute-seed";

let fx: LifecycleFixture;
let miniflareOwner = 0;

beforeAll(async () => {
  fx = await startLifecycleFixture({ withD1: true });
  miniflareOwner = await seedUser(fx.harness.d1 as D1Database, { role: "owner" });
}, 120_000);

beforeEach(async () => {
  await fx.reset();
});

afterAll(async () => {
  await fx?.dispose();
}, 30_000);

const kinds = async (env: Bindings, jobId: string) =>
  (
    await env.DB.prepare("SELECT kind FROM compute_ledger WHERE job_id = ? ORDER BY id")
      .bind(jobId)
      .all<{ kind: string }>()
  ).results.map((r) => r.kind);

async function running(over: Parameters<typeof makeJob>[1] = {}) {
  const made = await makeJob(fx, over);
  expect(await submitComputeJob(made.env, made.job.id)).toEqual({ ok: true, outcome: "submitted" });
  const uuid = (await reread(made.env, made.job.id)).tapis_uuid as string;
  fx.tapis.advance(uuid, "RUNNING");
  await advanceComputeJob(made.env, made.job.id);
  return { made, uuid, env: made.env, id: made.job.id };
}

const rowFor = {
  partition: "shared",
  nodes: 1,
  cores_per_node: 4,
  memory_mb: null,
  gpus: 0,
  held_milli: 4000,
  results_bytes: null,
  outputs_completed_at: null,
} as const;

const recWith = (over: Record<string, unknown>) =>
  ({ uuid: "u-007", status: "FAILED", nodeCount: 1, coresPerNode: 4, ...over }) as never;

describe("only a job that never started is released", () => {
  test("Tapis FINISHED with no start time is a run Tapis did not time: it is charged the minimum and flagged, never released (MUTATION: release when there is no start)", async () => {
    const r = await running();
    await playLauncher(fx, r.env, await reread(r.env, r.id), r.uuid, {});
    fx.tapis.advance(r.uuid, "FINISHED");
    const record = fx.tapis.jobs.get(r.uuid)?.record;
    if (record) {
      record.remoteStarted = null;
      record.remoteEnded = null;
      record.remoteResultInfo = "0";
    }
    await advanceComputeJob(r.env, r.id);
    const job = await reread(r.env, r.id);
    expect(job.state).toBe("finished");
    expect(job.charged_milli).toBe(RATE_TABLE_V1.minChargeMilli);
    expect(job.flag_mismatch).toBe(1);
    expect(await kinds(r.env, r.id)).toEqual(["hold", "charge"]);
  });

  test("a FAILED job after the launcher claimed bytes is charged the minimum and flagged, though Tapis shows no start", async () => {
    const r = await running();
    await r.env.DB.prepare("UPDATE compute_jobs SET results_bytes = 100 WHERE id = ?")
      .bind(r.id)
      .run();
    const record = fx.tapis.jobs.get(r.uuid)?.record;
    if (record) record.remoteStarted = null;
    fx.tapis.advance(r.uuid, "FAILED", "JOB_REMOTE_OUTCOME_ERROR");
    if (record) record.remoteStarted = null;
    await advanceComputeJob(r.env, r.id);
    const job = await reread(r.env, r.id);
    expect(job.state).toBe("failed");
    expect(job.charged_milli).toBe(RATE_TABLE_V1.minChargeMilli);
    expect(job.flag_mismatch).toBe(1);
    expect(await kinds(r.env, r.id)).toEqual(["hold", "charge"]);
  });

  test("a launcher that completed an upload shows a run too (MUTATION: only results_bytes counts)", async () => {
    const r = await running();
    await r.env.DB.prepare(
      "UPDATE compute_jobs SET outputs_completed_at = datetime('now') WHERE id = ?",
    )
      .bind(r.id)
      .run();
    fx.tapis.advance(r.uuid, "FAILED", "JOB_REMOTE_OUTCOME_ERROR");
    const record = fx.tapis.jobs.get(r.uuid)?.record;
    if (record) record.remoteStarted = null;
    await advanceComputeJob(r.env, r.id);
    expect((await reread(r.env, r.id)).charged_milli).toBe(RATE_TABLE_V1.minChargeMilli);
  });

  test("a start time that is not a time fails closed: the hold is charged and the job flagged", async () => {
    for (const bad of ["garbage", "04/11/2026 10:00", "yesterday"]) {
      const r = await running();
      fx.tapis.advance(r.uuid, "FAILED", "JOB_LAUNCH_FAILURE");
      const record = fx.tapis.jobs.get(r.uuid)?.record;
      if (record) record.remoteStarted = bad;
      await advanceComputeJob(r.env, r.id);
      const job = await reread(r.env, r.id);
      expect([bad, job.state, job.charged_milli, job.flag_mismatch]).toEqual([
        bad,
        "failed",
        4000,
        1,
      ]);
      expect(await kinds(r.env, r.id)).toEqual(["hold", "charge"]);
    }
  });

  test("a job nothing shows ran is still released in full, and not flagged", async () => {
    const made = await makeJob(fx);
    await submitComputeJob(made.env, made.job.id);
    const uuid = (await reread(made.env, made.job.id)).tapis_uuid as string;
    fx.tapis.advance(uuid, "STAGING_INPUTS");
    fx.tapis.advance(uuid, "FAILED", "JOB_UNABLE_TO_STAGE_INPUTS");
    await advanceComputeJob(made.env, made.job.id);
    const job = await reread(made.env, made.job.id);
    expect([job.state, job.charged_milli, job.flag_mismatch]).toEqual(["failed", 0, 0]);
    expect(await kinds(made.env, made.job.id)).toEqual(["hold", "release"]);
  });

  test("the rule, as a pure function", () => {
    // Never started, nothing shows a run: released.
    expect(provisionalCharge(rowFor, recWith({ status: "QUEUED" }))).toEqual({ kind: "release" });
    expect(provisionalCharge(rowFor, recWith({ status: "FAILED", remoteStarted: "" }))).toEqual({
      kind: "release",
    });
    // FINISHED shows a run; so does a claim of bytes and a completed upload.
    for (const [row, rec] of [
      [rowFor, recWith({ status: "FINISHED" })],
      [{ ...rowFor, results_bytes: 1 }, recWith({ status: "FAILED" })],
      [
        { ...rowFor, outputs_completed_at: "2026-11-04 10:00:00" },
        recWith({ status: "CANCELLED" }),
      ],
    ] as const) {
      expect(provisionalCharge(row, rec)).toEqual({
        kind: "charge",
        milli: RATE_TABLE_V1.minChargeMilli,
        seconds: 0,
        fallback: true,
      });
    }
    // A start that is not a time: the hold.
    expect(provisionalCharge(rowFor, recWith({ remoteStarted: "garbage" }))).toEqual({
      kind: "charge",
      milli: 4000,
      seconds: 0,
      fallback: true,
    });
    // A run whose record is complete is priced as it always was.
    expect(
      provisionalCharge(
        rowFor,
        recWith({ remoteStarted: "2026-11-04T10:00:00Z", remoteEnded: "2026-11-04T10:30:00Z" }),
      ),
    ).toEqual({ kind: "charge", milli: 2000, seconds: 1800, fallback: false });
  });

  test("a time that runs backwards is zero seconds, charged the minimum, not an error that charges the hold (MUTATION: drop Math.max(0, ...))", () => {
    expect(
      provisionalCharge(
        rowFor,
        recWith({ remoteStarted: "2026-11-04T11:00:00Z", remoteEnded: "2026-11-04T10:00:00Z" }),
      ),
    ).toEqual({ kind: "charge", milli: RATE_TABLE_V1.minChargeMilli, seconds: 0, fallback: false });
  });
});

/** Make the ledger refuse every charge, exactly as its own triggers refuse what they refuse. */
const FAULT =
  "CREATE TRIGGER compute_test_fault BEFORE INSERT ON compute_ledger WHEN NEW.kind = 'charge' BEGIN SELECT RAISE(ABORT, 'injected fault'); END";
const NO_FAULT = "DROP TRIGGER IF EXISTS compute_test_fault";

describe("a transition and its settlement are ONE batch", () => {
  async function bothEngines(body: (env: Bindings, name: string) => Promise<void>) {
    await body(fx.env(), "bun:sqlite");
    const d1 = fx.harness.d1 as D1Database;
    await fundPlatform(d1, "people", 1_000_000_000);
    await setPolicy(d1, miniflareOwner, {});
    await body(fx.env({ DB: d1 } as Partial<Bindings>), "Miniflare D1");
  }

  test("a charge the table refuses rolls the state change back with it, and the retry settles once (MUTATION: run the statements one after the other)", async () => {
    await bothEngines(async (env, engine) => {
      const made = await makeJob(fx, { env });
      expect(await submitComputeJob(env, made.job.id)).toMatchObject({ ok: true });
      const uuid = (await reread(env, made.job.id)).tapis_uuid as string;
      fx.tapis.advance(uuid, "RUNNING");
      await advanceComputeJob(env, made.job.id);
      setTapisTimes(fx, uuid, 30 * MINUTE, 0);
      fx.tapis.advance(uuid, "FAILED", "JOB_LAUNCH_FAILURE");
      setTapisTimes(fx, uuid, 30 * MINUTE, 0);

      await env.DB.prepare(FAULT).run();
      try {
        await expect(advanceComputeJob(env, made.job.id)).rejects.toThrow();
      } finally {
        await env.DB.prepare(NO_FAULT).run();
      }
      // Neither happened: the job is where it was, unsettled, its hold open.
      const stuck = await reread(env, made.job.id);
      expect([engine, stuck.state, stuck.settled_provisional_at, stuck.failure_code]).toEqual([
        engine,
        "running",
        null,
        null,
      ]);
      expect([engine, await kinds(env, made.job.id)]).toEqual([engine, ["hold"]]);

      // The fault cleared, the same step settles: one terminal state, one charge.
      await advanceComputeJob(env, made.job.id);
      const done = await reread(env, made.job.id);
      expect([engine, done.state, done.charged_milli]).toEqual([engine, "failed", 2000]);
      expect([engine, await kinds(env, made.job.id)]).toEqual([engine, ["hold", "charge"]]);
    });
  });

  test("a hold that was closed behind the Worker's back: the transition commits, the ledger writes nothing more, and the row is stamped settled (what the batch does, not what it prevents)", async () => {
    const r = await running();
    await r.env.DB.prepare(
      `INSERT INTO compute_ledger (kind, pool_id, budget_pool_id, held_delta_milli, job_id, hold_ref, reason, idempotency_key)
       SELECT 'release', h.pool_id, h.budget_pool_id, -h.held_delta_milli, h.job_id, h.id, 'by_hand', 'hold:' || h.id || ':release'
         FROM compute_ledger h WHERE h.kind = 'hold' AND h.job_id = ?1`,
    )
      .bind(r.id)
      .run();
    fx.tapis.advance(r.uuid, "FAILED", "JOB_LAUNCH_FAILURE");
    await advanceComputeJob(r.env, r.id);
    const job = await reread(r.env, r.id);
    expect(job.state).toBe("failed");
    expect(await kinds(r.env, r.id)).toEqual(["hold", "release"]);
    expect(job.settled_provisional_at).not.toBeNull();
  });
});

/** A D1 that tells `observe` what the ledger and the row hold right after each batch (a real database, only watched). */
function observingD1(
  d1: D1Database,
  jobId: string,
  seen: Array<{ state: string; kinds: string[] }>,
): D1Database {
  return {
    prepare: (sql: string) => d1.prepare(sql),
    batch: async (statements: D1PreparedStatement[]) => {
      const result = await d1.batch(statements);
      const row = await d1
        .prepare("SELECT state FROM compute_jobs WHERE id = ?1")
        .bind(jobId)
        .first<{ state: string }>();
      const entries = (
        await d1
          .prepare("SELECT kind FROM compute_ledger WHERE job_id = ?1 ORDER BY id")
          .bind(jobId)
          .all<{ kind: string }>()
      ).results.map((e) => e.kind);
      seen.push({ state: row?.state ?? "", kinds: entries });
      return result;
    },
  } as unknown as D1Database;
}

describe("the settlement gate, through the flow", () => {
  test("a terminal writer that lost to a live write settles NOTHING in its first batch, and wins on its retry (MUTATION: the gate always true)", async () => {
    const r = await running();
    const stale = await reread(r.env, r.id);
    const base = fx.tapis.jobs.get(r.uuid)?.record as Record<string, unknown>;
    // A poll moved the job from RUNNING to ARCHIVING after the terminal writer read it.
    fx.tapis.advance(r.uuid, "ARCHIVING");
    await advanceComputeJob(r.env, r.id);
    expect((await reread(r.env, r.id)).state).toBe("archiving");
    setTapisTimes(fx, r.uuid, 30 * MINUTE, 0);

    const seen: Array<{ state: string; kinds: string[] }> = [];
    const watched = { ...r.env, DB: observingD1(r.env.DB, r.id, seen) } as Bindings;
    const failed = {
      ...base,
      status: "FAILED",
      condition: "JOB_LAUNCH_FAILURE",
      remoteStarted: fx.tapis.jobs.get(r.uuid)?.record.remoteStarted,
      remoteEnded: fx.tapis.jobs.get(r.uuid)?.record.remoteEnded,
    } as never;
    const result = await applyTapisJob(watched, stale, failed);
    expect(result.outcome).toBe("terminal_committed");
    // The first batch lost its UPDATE (the row is not `running`): the job is still archiving and the
    // hold is still open. Only the retry, against the fresh row, charges it.
    expect(seen[0]).toEqual({ state: "archiving", kinds: ["hold"] });
    expect(seen[seen.length - 1]).toEqual({ state: "failed", kinds: ["hold", "charge"] });
  });

  test("the settled stamp is written only when the ledger holds the closing entry (MUTATION: drop the EXISTS guard)", async () => {
    // A job row with NO hold at all (nothing in the ledger can close): its terminal batch moves the state
    // and settles nothing, and the row must not claim it was settled.
    const env = fx.env();
    const accountId = await seedUser(env.DB);
    const id = `job_${"ab".repeat(12)}`;
    await env.DB.prepare(
      `INSERT INTO compute_jobs (id, account_id, source, kind, app_id, app_version, spec_digest, partition, pool,
                                 nodes, cores_per_node, minutes, state, tapis_uuid, webhook_nonce)
       VALUES (?1, ?2, 'cli', 'batch', 'nemar-launch', '1.0.0', ?3, 'shared', 'cpu', 1, 4, 60, 'running', 'no-hold-007',
               '00000000-0000-0000-0000-000000000001')`,
    )
      .bind(id, accountId, "c".repeat(64))
      .run();
    const row = await reread(env, id);
    const result = await applyTapisJob(env, row, {
      uuid: "no-hold-007",
      status: "FAILED",
      condition: "JOB_LAUNCH_FAILURE",
      remoteStarted: "2026-11-04T10:00:00Z",
      remoteEnded: "2026-11-04T10:30:00Z",
    } as never);
    expect(result.outcome).toBe("terminal_committed");
    const done = await reread(env, id);
    expect(done.state).toBe("failed");
    expect(await kinds(env, id)).toEqual([]);
    expect(done.settled_provisional_at).toBeNull();
    // And the tick does not loop on it: a row with no hold is not in the repair list.
    expect(await runComputeAdvanceCron(env)).toMatchObject({ repaired: 0, errors: [] });
  });
});
