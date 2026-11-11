/**
 * The ACCESS gateway-attributes report of every Slurm job (epic #2005 phase A8, #2013; ADR 0118
 * decision 9, design section 9), against the real migrations and the real lifecycle over the Tapis
 * stand-in (a real HTTP server built from Tapis's published specifications; NO RESPONSE IN IT WAS
 * RECORDED FROM A REAL TENANT). THE ROW ONLY: the reporter that sends what the row owes, and its
 * stand-in for the ACCESS endpoint, are `compute-access-reporter.test.ts`.
 *
 * The batch in which a job's record first shows a Slurm id inserts a `pending` row,
 * in both writers of `slurm_job_id` (the live transition and the terminal transition), with
 * `INSERT OR IGNORE`, so a replayed read adds no second row and never resets one that has moved on.
 * MUTATIONS: drop `OR IGNORE` (the replay throws on the primary key); remove the insert from the live
 * batch (no row after QUEUED); remove it from the terminal batch (no row for a job first read at its
 * end).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { advanceComputeJob, submitComputeJob } from "../src/services/compute-lifecycle";
import type { Bindings } from "../src/types/bindings";
import {
  type LifecycleFixture,
  type MadeJob,
  makeJob,
  reread,
  setPolicy,
  setTapisTimes,
  startLifecycleFixture,
} from "./helpers/compute-lifecycle-fixture";
import { fundPlatform, seedUser } from "./helpers/compute-seed";

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

// --- Helpers -------------------------------------------------------------------------------------

interface ReportRow {
  job_id: string;
  state: string;
  attempts: number;
  next_attempt_at: string;
  claimed_at: string | null;
  last_error_code: string | null;
  sent_at: string | null;
  created_at: string;
}

async function reportsOf(env: Bindings, jobId: string): Promise<ReportRow[]> {
  return (
    await env.DB.prepare("SELECT * FROM compute_access_reports WHERE job_id = ?1")
      .bind(jobId)
      .all<ReportRow>()
  ).results;
}

async function submittedJob(
  over: Parameters<typeof makeJob>[1] = {},
): Promise<{ made: MadeJob; uuid: string; env: Bindings }> {
  const made = await makeJob(fx, over);
  expect(await submitComputeJob(made.env, made.job.id)).toEqual({
    ok: true,
    outcome: "submitted",
  });
  const job = await reread(made.env, made.job.id);
  return { made: { ...made, job }, uuid: job.tapis_uuid as string, env: made.env };
}

/** Move the Tapis job and let the Worker read it back, as the tick and the webhook both do. */
async function drive(env: Bindings, jobId: string, uuid: string, status: string, cond?: string) {
  fx.tapis.advance(uuid, status, cond);
  return advanceComputeJob(env, jobId);
}

// --- The row -------------------------------------------------------------------------------------

describe("the report row is made in the batch in which a job's record first shows a Slurm id", () => {
  test("no Slurm id, no row: a job at Tapis that the scheduler has not seen owes nothing", async () => {
    const s = await submittedJob();
    expect(await reportsOf(s.env, s.made.job.id)).toEqual([]);
    for (const status of ["PROCESSING_INPUTS", "STAGING_INPUTS", "SUBMITTING_JOB"]) {
      await drive(s.env, s.made.job.id, s.uuid, status);
      expect((await reread(s.env, s.made.job.id)).slurm_job_id).toBeNull();
      expect(await reportsOf(s.env, s.made.job.id)).toEqual([]);
    }
  });

  test("the first read that carries the Slurm id writes the id and ONE pending row, due now (MUTATION: remove the insert from the live batch)", async () => {
    const s = await submittedJob();
    await drive(s.env, s.made.job.id, s.uuid, "QUEUED");
    const job = await reread(s.env, s.made.job.id);
    expect(job.slurm_job_id).toMatch(/^[0-9a-f]{32}$/);
    const rows = await reportsOf(s.env, s.made.job.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      job_id: s.made.job.id,
      state: "pending",
      attempts: 0,
      claimed_at: null,
      last_error_code: null,
      sent_at: null,
    });
    const due = await s.env.DB.prepare(
      "SELECT next_attempt_at <= datetime('now') AS due FROM compute_access_reports WHERE job_id = ?1",
    )
      .bind(s.made.job.id)
      .first<{ due: number }>();
    expect(due?.due).toBe(1);
  });

  test("a replayed read after the Slurm id first appears adds no second row, and the row is not touched (MUTATION: drop OR IGNORE)", async () => {
    const s = await submittedJob();
    await drive(s.env, s.made.job.id, s.uuid, "QUEUED");
    const first = (await reportsOf(s.env, s.made.job.id))[0] as ReportRow;
    // The same record again (a self-edge), the next states (each a live write that carries the id), and
    // a webhook hint read again: every one of them is a write that could add a row.
    for (const status of ["QUEUED", "QUEUED", "RUNNING", "RUNNING", "ARCHIVING"]) {
      await drive(s.env, s.made.job.id, s.uuid, status);
      expect(await reportsOf(s.env, s.made.job.id)).toEqual([first]);
    }
    await advanceComputeJob(s.env, s.made.job.id);
    expect(await reportsOf(s.env, s.made.job.id)).toEqual([first]);
  });

  test("a row that has moved on is not put back by a replay: a sent report stays sent", async () => {
    const s = await submittedJob();
    await drive(s.env, s.made.job.id, s.uuid, "QUEUED");
    await s.env.DB.prepare(
      "UPDATE compute_access_reports SET state = 'sent', sent_at = datetime('now'), attempts = 1 WHERE job_id = ?1",
    )
      .bind(s.made.job.id)
      .run();
    const sent = (await reportsOf(s.env, s.made.job.id))[0] as ReportRow;
    await drive(s.env, s.made.job.id, s.uuid, "RUNNING");
    await drive(s.env, s.made.job.id, s.uuid, "ARCHIVING");
    expect(await reportsOf(s.env, s.made.job.id)).toEqual([sent]);
  });

  test("a job first read at its END, with the Slurm id on the Tapis record, gets its row from the terminal batch (MUTATION: remove the insert from commitTerminal)", async () => {
    const s = await submittedJob();
    // Tapis moved through QUEUED (which is where its record gets the id) and on to FAILED before the
    // Worker read the job back: the terminal batch is the first to see the id.
    fx.tapis.advance(s.uuid, "QUEUED");
    fx.tapis.advance(s.uuid, "RUNNING");
    setTapisTimes(fx, s.uuid, 60_000, 0);
    fx.tapis.advance(s.uuid, "FAILED", "JOB_LAUNCH_FAILURE");
    expect((await reread(s.env, s.made.job.id)).slurm_job_id).toBeNull();
    expect(await reportsOf(s.env, s.made.job.id)).toEqual([]);

    const answer = await advanceComputeJob(s.env, s.made.job.id);
    expect(answer.outcome).toBe("terminal_committed");
    const job = await reread(s.env, s.made.job.id);
    expect(job.state).toBe("failed");
    expect(job.slurm_job_id).toMatch(/^[0-9a-f]{32}$/);
    const rows = await reportsOf(s.env, s.made.job.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "pending", attempts: 0 });
    // And the repair of a terminal row, or any later read of it, adds none.
    await advanceComputeJob(s.env, s.made.job.id);
    expect(await reportsOf(s.env, s.made.job.id)).toHaveLength(1);
  });

  test("a job that was reported live and then ends has still ONE row", async () => {
    const s = await submittedJob();
    await drive(s.env, s.made.job.id, s.uuid, "QUEUED");
    await drive(s.env, s.made.job.id, s.uuid, "RUNNING");
    setTapisTimes(fx, s.uuid, 60_000, 0);
    fx.tapis.advance(s.uuid, "FAILED", "JOB_LAUNCH_FAILURE");
    expect((await advanceComputeJob(s.env, s.made.job.id)).outcome).toBe("terminal_committed");
    expect(await reportsOf(s.env, s.made.job.id)).toHaveLength(1);
  });

  test("a job that never reached the scheduler has no row", async () => {
    const s = await submittedJob();
    fx.tapis.advance(s.uuid, "FAILED", "JOB_UNABLE_TO_STAGE_INPUTS");
    expect((await advanceComputeJob(s.env, s.made.job.id)).outcome).toBe("terminal_committed");
    expect((await reread(s.env, s.made.job.id)).slurm_job_id).toBeNull();
    expect(await reportsOf(s.env, s.made.job.id)).toEqual([]);
  });
});

describe("on Miniflare's D1, the engine `wrangler --local` runs", () => {
  async function onD1() {
    const env = fx.env({ DB: fx.harness.d1 } as Partial<Bindings>);
    const d1 = fx.harness.d1 as D1Database;
    await fundPlatform(d1, "people", 1_000_000_000);
    await setPolicy(d1, miniflareOwner, {});
    return env;
  }

  test("the live write and the terminal write each make the row in their own batch, and a replay adds none", async () => {
    const env = await onD1();
    const live = await makeJob(fx, { env });
    expect((await submitComputeJob(env, live.job.id)).ok).toBe(true);
    const liveUuid = (await reread(env, live.job.id)).tapis_uuid as string;
    await drive(env, live.job.id, liveUuid, "QUEUED");
    await drive(env, live.job.id, liveUuid, "QUEUED");
    expect(await reportsOf(env, live.job.id)).toHaveLength(1);

    const ended = await makeJob(fx, { env });
    expect((await submitComputeJob(env, ended.job.id)).ok).toBe(true);
    const endedUuid = (await reread(env, ended.job.id)).tapis_uuid as string;
    fx.tapis.advance(endedUuid, "QUEUED");
    fx.tapis.advance(endedUuid, "RUNNING");
    setTapisTimes(fx, endedUuid, 60_000, 0);
    fx.tapis.advance(endedUuid, "FAILED", "JOB_LAUNCH_FAILURE");
    expect((await advanceComputeJob(env, ended.job.id)).outcome).toBe("terminal_committed");
    expect(await reportsOf(env, ended.job.id)).toHaveLength(1);
    await advanceComputeJob(env, ended.job.id);
    expect(await reportsOf(env, ended.job.id)).toHaveLength(1);
  });
});

describe("the statement itself", () => {
  test("it makes a row only for a job whose row shows a Slurm id, and only one", async () => {
    const { ACCESS_REPORT_PENDING_SQL } = await import("../src/services/access-attributes");
    const s = await submittedJob();
    const run = async () =>
      (await s.env.DB.prepare(ACCESS_REPORT_PENDING_SQL).bind(s.made.job.id).run()).meta.changes;
    // A job row with no Slurm id owes nothing, however the statement is reached.
    expect(await run()).toBe(0);
    expect(await reportsOf(s.env, s.made.job.id)).toEqual([]);
    await s.env.DB.prepare("UPDATE compute_jobs SET slurm_job_id = '4242' WHERE id = ?1")
      .bind(s.made.job.id)
      .run();
    expect(await run()).toBe(1);
    expect(await run()).toBe(0);
    expect(await reportsOf(s.env, s.made.job.id)).toHaveLength(1);
    // Another job's row is not made by this job's id.
    const other = await submittedJob();
    expect(await reportsOf(other.env, other.made.job.id)).toEqual([]);
  });
});
