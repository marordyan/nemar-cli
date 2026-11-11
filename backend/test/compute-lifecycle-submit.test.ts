/**
 * The lifecycle's submit, cancel and rotation under concurrency and under failure (epic #2005 phase A5,
 * #2010; ADR 0118), round 1 of the review of PR #2041. Real migrations, the real ledger, Miniflare's R2,
 * the Tapis stand-in (no response of which was recorded from a real tenant) behind a forwarding proxy
 * that can drop the answer to a submit AFTER the stand-in has acted on it, and the real services.
 *
 * What is pinned, each with a test of its own:
 *  - the 30-minute tick cannot starve: more than ten rows that cannot be read, or ten `created` rows that
 *    cannot be submitted, never keep a healthy running job from being read; rotation is by EXAMINATION,
 *    and the bound rows and the `created` rows have a quota each (MUTATION: order by the last good read;
 *    one shared list); with compute off a `created` row still reaches `submit_timeout`;
 *  - two submitters cannot both reach Tapis (the lease), and a submitter whose bind lost does not cancel
 *    the Tapis job another path bound to the SAME row (MUTATION: drop the lease; drop the re-read); a
 *    Tapis job no row owns is recorded and cancelled again by the tick until it is cancelled (MUTATION:
 *    do not record it); a cancel pending while the submit is in flight keeps the row from `submitted`
 *    (MUTATION: drop `cancel_requested_at IS NULL` from the bind);
 *  - a cancel of an unbound job whose submit may have reached Tapis asks Tapis FIRST, and releases the
 *    hold only when nothing is there (MUTATION: end the row at once); when Tapis cannot be asked the
 *    cancel stays recorded and nothing is released;
 *  - a terminal hint that loses to a concurrent live write is applied again against the fresh row
 *    (MUTATION: no retry), and a job found by tag is applied from the FULL record, so its exit code is
 *    checked (MUTATION: apply the search record).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PARTITIONS, type PartitionName } from "../../shared/contract/compute";
import {
  BOUND_ROWS_SQL,
  runComputeAdvanceCron,
  sweepComputeCancellations,
} from "../src/services/compute-advance";
import {
  CLAIM_SUBMIT_SQL,
  RELEASE_SUBMIT_SQL,
  SUBMIT_LEASE_MINUTES,
  advanceComputeJob,
  applyTapisJob,
  requestComputeCancel,
  submitComputeJob,
} from "../src/services/compute-lifecycle";
import type { Bindings } from "../src/types/bindings";
import {
  type LifecycleFixture,
  MINUTE,
  makeJob,
  playLauncher,
  reread,
  setTapisTimes,
  startLifecycleFixture,
} from "./helpers/compute-lifecycle-fixture";
import { setPolicy } from "./helpers/compute-seed";
import { roundTripD1 } from "./helpers/compute-seed";
import { logged } from "./helpers/logs";

let fx: LifecycleFixture;

beforeAll(async () => {
  fx = await startLifecycleFixture({ withD1: true });
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

const submitsAtTapis = () => fx.tapis.log.filter((r) => r.route === "POST /v3/jobs/submit").length;

const tapisStatusOf = (uuid: string) => fx.tapis.jobs.get(uuid)?.status;

/** A row bound to a Tapis job that does not exist: Tapis answers 404, so the row cannot be read. */
async function unreadable(index: number) {
  const made = await makeJob(fx);
  await made.env.DB.prepare(
    `UPDATE compute_jobs SET state = 'submitted', tapis_uuid = ?1, tapis_status = 'PENDING',
            submitted_at = datetime('now', '-25 hours'), tapis_synced_at = datetime('now', '-25 hours')
      WHERE id = ?2`,
  )
    .bind(`gone-${index}-007`, made.job.id)
    .run();
  return made;
}

describe("the tick cannot starve", () => {
  test("more than ten rows Tapis cannot be read for do not keep a healthy running job from being read, and they become `unreported` (MUTATION: order by the last good read)", async () => {
    const stuck = [];
    for (let i = 0; i < 11; i++) stuck.push(await unreadable(i));
    const healthy = await makeJob(fx);
    expect(await submitComputeJob(healthy.env, healthy.job.id)).toEqual({
      ok: true,
      outcome: "submitted",
    });
    const uuid = (await reread(healthy.env, healthy.job.id)).tapis_uuid as string;
    fx.tapis.advance(uuid, "RUNNING");

    // Twelve rows, ten slots: the healthy job is read within TWO ticks, whatever the others do.
    await runComputeAdvanceCron(healthy.env);
    await runComputeAdvanceCron(healthy.env);
    expect((await reread(healthy.env, healthy.job.id)).state).toBe("running");
    // Every unreadable row has been examined, and one that Tapis has not answered for in a day is
    // `unreported` (the mark is made on a failed read, which only a row that is examined can have).
    for (const row of stuck) {
      const now = await reread(healthy.env, row.job.id);
      expect([now.state, now.examined_at === null]).toEqual(["unreported", false]);
    }
  });

  // Round 2 of #2041: `ORDER BY COALESCE(examined_at, '')` could not use the index built for the rotation,
  // so every tick walked every row that ever had a Tapis job.
  test("the live-row query is served by the rotation's own index, and a never-examined row still comes first", async () => {
    const plan = (
      fx.harness.db
        .query(`EXPLAIN QUERY PLAN ${BOUND_ROWS_SQL.replace("?1", "10")}`)
        .all() as Array<{ detail: string }>
    ).map((r) => r.detail);
    expect(plan.some((line) => line.includes("compute_jobs_examined"))).toBe(true);
    // The order is unchanged by the bare column: NULL sorts before every time.
    const a = await unreadable(40);
    const b = await unreadable(41);
    await b.env.DB.prepare("UPDATE compute_jobs SET examined_at = datetime('now') WHERE id = ?")
      .bind(b.job.id)
      .run();
    const ids = (await a.env.DB.prepare(BOUND_ROWS_SQL).bind(10).all<{ id: string }>()).results.map(
      (r) => r.id,
    );
    expect(ids.indexOf(a.job.id)).toBeLessThan(ids.indexOf(b.job.id));
  });

  test("rows are stamped as examined whether the step succeeds or not, and the stamp moves a row to the back of the line", async () => {
    const a = await unreadable(1);
    const b = await unreadable(2);
    expect((await reread(a.env, a.job.id)).examined_at).toBeNull();
    await runComputeAdvanceCron(a.env);
    expect((await reread(a.env, a.job.id)).examined_at).not.toBeNull();
    expect((await reread(b.env, b.job.id)).examined_at).not.toBeNull();
  });

  test("compute off and more than ten `created` rows that cannot be submitted do not keep a running job from being read in the FIRST tick (MUTATION: one shared list)", async () => {
    const running = await makeJob(fx);
    await submitComputeJob(running.env, running.job.id);
    const uuid = (await reread(running.env, running.job.id)).tapis_uuid as string;
    fx.tapis.advance(uuid, "RUNNING");
    // Older than the running job, so any single list ordered by age puts them first.
    const waiting = [];
    for (let i = 0; i < 12; i++) {
      const w = await makeJob(fx);
      await w.env.DB.prepare(
        "UPDATE compute_jobs SET created_at = datetime('now', '-1 minutes') WHERE id = ?",
      )
        .bind(w.job.id)
        .run();
      waiting.push(w);
    }
    const off = { ...running.env, COMPUTE_ENABLED: undefined } as Bindings;
    const tick = await runComputeAdvanceCron(off);
    expect(tick?.examined).toBe(11);
    expect((await reread(off, running.job.id)).state).toBe("running");
    // The `created` rows have their own ten slots: ten were examined, the other two come next tick.
    const examined = async () =>
      (
        await off.DB.prepare(
          "SELECT COUNT(*) AS n FROM compute_jobs WHERE examined_at IS NOT NULL AND state = 'created'",
        ).first<{ n: number }>()
      )?.n;
    expect(await examined()).toBe(10);
    await runComputeAdvanceCron(off);
    expect(await examined()).toBe(12);
    // Nothing was submitted while compute was off.
    expect(submitsAtTapis()).toBe(1);
  });

  test("with compute off a `created` row still reaches `submit_timeout`, and a job Tapis already holds is bound", async () => {
    await setPolicy(fx.env().DB, fx.ownerId, { reservationWaitMinutes: 30 });
    const late = await makeJob(fx);
    const held = await makeJob(fx);
    // `held` was submitted and its answer lost, while compute was on.
    fx.proxy.loseSubmitAnswers(1);
    expect((await submitComputeJob(held.env, held.job.id)).outcome).toBe("unavailable");
    for (const j of [late, held]) {
      await j.env.DB.prepare(
        "UPDATE compute_jobs SET created_at = datetime('now', '-3 hours') WHERE id = ?",
      )
        .bind(j.job.id)
        .run();
    }
    const off = { ...late.env, COMPUTE_ENABLED: undefined } as Bindings;
    await runComputeAdvanceCron(off);
    const lateNow = await reread(off, late.job.id);
    expect([lateNow.state, lateNow.failure_code]).toEqual(["failed", "submit_timeout"]);
    expect(await kinds(off, late.job.id)).toEqual(["hold", "release"]);
    // The held one was found by tag and bound, not timed out.
    expect((await reread(off, held.job.id)).state).toBe("submitted");
    expect(submitsAtTapis()).toBe(1);
  });
});

describe("two submitters, one Tapis job", () => {
  test("two submits of one job at once reach Tapis once, and the job stays alive (MUTATION: drop the lease)", async () => {
    const made = await makeJob(fx);
    const racing = { ...made.env, DB: roundTripD1(made.env.DB) } as Bindings;
    const results = await Promise.all([
      submitComputeJob(racing, made.job.id),
      submitComputeJob(racing, made.job.id),
    ]);
    expect(submitsAtTapis()).toBe(1);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toEqual({ ok: false, outcome: "in_progress" });
    const job = await reread(made.env, made.job.id);
    expect(job.state).toBe("submitted");
    expect(tapisStatusOf(job.tapis_uuid as string)).toBe("PENDING");
    expect(job.orphan_tapis_uuid).toBeNull();
    // The lease is released when the attempt ends.
    expect(job.submit_claimed_at).toBeNull();
  });

  test("a lease is held by one submitter, an expired lease may be taken again, and an attempt that ends releases it (MUTATION: drop the expiry)", async () => {
    const made = await makeJob(fx);
    const db = made.env.DB;
    await db
      .prepare("UPDATE compute_jobs SET submit_claimed_at = datetime('now') WHERE id = ?")
      .bind(made.job.id)
      .run();
    expect(await submitComputeJob(made.env, made.job.id)).toEqual({
      ok: false,
      outcome: "in_progress",
    });
    expect(submitsAtTapis()).toBe(0);
    await db
      .prepare("UPDATE compute_jobs SET submit_claimed_at = datetime('now', ?1) WHERE id = ?2")
      .bind(`-${SUBMIT_LEASE_MINUTES + 1} minutes`, made.job.id)
      .run();
    expect(await submitComputeJob(made.env, made.job.id)).toEqual({
      ok: true,
      outcome: "submitted",
    });
    expect((await reread(made.env, made.job.id)).submit_claimed_at).toBeNull();
    expect(CLAIM_SUBMIT_SQL).toContain("submit_claimed_at < datetime('now'");
  });

  test("a bind that lost to another path binding the SAME Tapis job returns, and cancels nothing (MUTATION: drop the re-read)", async () => {
    const made = await makeJob(fx);
    // After the stand-in made the job and before the Worker hears, another path (an adoption by tag, a
    // webhook's read-back) binds the very same Tapis job to the row.
    fx.proxy.afterNextSubmit(async () => {
      const [uuid] = [...fx.tapis.jobs.keys()];
      await made.env.DB.prepare(
        "UPDATE compute_jobs SET tapis_uuid = ?1, state = 'submitted', tapis_status = 'PENDING' WHERE id = ?2",
      )
        .bind(uuid, made.job.id)
        .run();
    });
    expect(await submitComputeJob(made.env, made.job.id)).toEqual({
      ok: true,
      outcome: "already_submitted",
    });
    const job = await reread(made.env, made.job.id);
    expect(job.state).toBe("submitted");
    expect(tapisStatusOf(job.tapis_uuid as string)).toBe("PENDING");
    expect(fx.tapis.log.some((r) => r.route === "POST /v3/jobs/:uuid/cancel")).toBe(false);
    expect(job.orphan_tapis_uuid).toBeNull();
  });

  test("a Tapis job bound to ANOTHER Tapis job's row is an orphan: recorded, flagged, and cancelled again by the tick until it works (MUTATION: do not record it)", async () => {
    const made = await makeJob(fx);
    fx.proxy.afterNextSubmit(async () => {
      await made.env.DB.prepare(
        "UPDATE compute_jobs SET tapis_uuid = 'someone-elses-007', state = 'submitted' WHERE id = ?",
      )
        .bind(made.job.id)
        .run();
    });
    fx.tapis.fail("POST /v3/jobs/:uuid/cancel", 503);
    expect((await submitComputeJob(made.env, made.job.id)).outcome).toBe("bad_state");
    const [only] = [...fx.tapis.jobs.values()];
    const job = await reread(made.env, made.job.id);
    expect(job.tapis_uuid).toBe("someone-elses-007");
    expect(job.orphan_tapis_uuid).toBe(only?.uuid ?? "");
    expect(job.flag_mismatch).toBe(1);
    // The cancel failed: the Tapis job still runs, and the row says so.
    expect(only?.status).toBe("PENDING");
    // The tick asks again, and clears the record only when the cancel is known to have worked.
    expect(
      await sweepComputeCancellations({ ...made.env, ENVIRONMENT: "development" } as Bindings),
    ).toBeNull();
    expect(await sweepComputeCancellations(made.env)).toMatchObject({
      errors: [],
      cancel_failed: 0,
    });
    expect(only?.status).toBe("CANCELLED");
    expect((await reread(made.env, made.job.id)).orphan_tapis_uuid).toBeNull();
    // Nothing is left to do.
    expect(await sweepComputeCancellations(made.env)).toMatchObject({ examined: 0 });
  });

  test("a cancel pending while the submit is in flight keeps the row out of `submitted`, and the Tapis job is cancelled (MUTATION: drop `cancel_requested_at IS NULL` from the bind)", async () => {
    const made = await makeJob(fx);
    fx.proxy.afterNextSubmit(async () => {
      // The intent is recorded; the cancel has not been driven yet.
      await made.env.DB.prepare(
        "UPDATE compute_jobs SET cancel_requested_at = datetime('now'), cancel_reason = 'user' WHERE id = ?",
      )
        .bind(made.job.id)
        .run();
    });
    expect((await submitComputeJob(made.env, made.job.id)).ok).toBe(false);
    const [only] = [...fx.tapis.jobs.values()];
    expect(only?.status).toBe("CANCELLED");
    const job = await reread(made.env, made.job.id);
    expect(job.state).toBe("created");
    expect(job.tapis_uuid).toBe(only?.uuid ?? "");
    // The sweep carries the recorded cancel out against the job the row now knows.
    await sweepComputeCancellations(made.env);
    const done = await reread(made.env, made.job.id);
    expect(done.state).toBe("cancelled");
    expect(await kinds(made.env, made.job.id)).toEqual(["hold", "release"]);
  });
});

describe("cancel of a job whose submit may have reached Tapis", () => {
  test("a submit whose answer was lost, then a cancel: Tapis is asked by tag, the job is cancelled there and the hold is released because it never started (MUTATION: end the row at once)", async () => {
    const made = await makeJob(fx);
    fx.proxy.loseSubmitAnswers(1);
    expect((await submitComputeJob(made.env, made.job.id)).outcome).toBe("unavailable");
    const [only] = [...fx.tapis.jobs.values()];
    expect(only?.status).toBe("PENDING");
    const res = await requestComputeCancel(made.env, made.job.id, "user");
    expect(res.ok).toBe(true);
    // No Tapis job is left running for a row that says it is over.
    expect(only?.status).toBe("CANCELLED");
    const job = await reread(made.env, made.job.id);
    expect([job.state, job.tapis_uuid]).toEqual(["cancelled", only?.uuid ?? ""]);
    expect(await kinds(made.env, made.job.id)).toEqual(["hold", "release"]);
    expect(job.charged_milli).toBe(0);
  });

  test("when Tapis cannot be asked, the cancel stays recorded and NOTHING is released; the sweep finishes it", async () => {
    const made = await makeJob(fx);
    fx.proxy.loseSubmitAnswers(1);
    await submitComputeJob(made.env, made.job.id);
    const [only] = [...fx.tapis.jobs.values()];
    fx.tapis.down();
    try {
      const res = await requestComputeCancel(made.env, made.job.id, "user");
      expect(res).toMatchObject({ ok: true, outcome: "cancel_requested", state: "created" });
    } finally {
      fx.tapis.up();
    }
    let job = await reread(made.env, made.job.id);
    expect([job.state, job.cancel_requested_at === null]).toEqual(["created", false]);
    expect(await kinds(made.env, made.job.id)).toEqual(["hold"]);
    expect(only?.status).toBe("PENDING");
    await sweepComputeCancellations(made.env);
    job = await reread(made.env, made.job.id);
    expect(job.state).toBe("cancelled");
    expect(only?.status).toBe("CANCELLED");
    expect(await kinds(made.env, made.job.id)).toEqual(["hold", "release"]);
  });

  test("a submit that never reached Tapis (nothing found by tag) is ended and released", async () => {
    const made = await makeJob(fx);
    fx.tapis.fail("POST /v3/jobs/submit", 503);
    expect((await submitComputeJob(made.env, made.job.id)).outcome).toBe("unavailable");
    expect(fx.tapis.jobs.size).toBe(0);
    await requestComputeCancel(made.env, made.job.id, "user");
    expect((await reread(made.env, made.job.id)).state).toBe("cancelled");
    expect(await kinds(made.env, made.job.id)).toEqual(["hold", "release"]);
  });
});

// Round 2 of #2041: a cancel that ends the row while a submit is in flight could release the hold for a
// Tapis job that no record knows.
describe("a cancel that meets a submitter's lease", () => {
  test("the cancel's tag search runs before Tapis shows the job and the submit's answer is then lost: the Tapis job still ends CANCELLED and the hold is released once (MUTATION: drop the lease-age condition from driveCancel)", async () => {
    const made = await makeJob(fx);
    let cancelAnswer: Awaited<ReturnType<typeof requestComputeCancel>> | null = null;
    fx.proxy.loseSubmitAnswers(1);
    fx.proxy.afterNextSubmit(async () => {
      // Tapis has made the job but a search cannot find it yet (it has not been persisted): hide it for
      // the length of the cancel, as the race would.
      const created = [...fx.tapis.jobs.values()][0];
      const tags = created?.tags ?? [];
      if (created) created.tags = [];
      try {
        cancelAnswer = await requestComputeCancel(made.env, made.job.id, "user");
      } finally {
        if (created) created.tags = tags;
      }
    });
    expect((await submitComputeJob(made.env, made.job.id)).ok).toBe(false);
    // The cancel recorded its intent and ended nothing: the row is not cancelled and no hold was released.
    expect(cancelAnswer).toMatchObject({ ok: true, outcome: "cancel_requested", state: "created" });
    const mid = await reread(made.env, made.job.id);
    expect([mid.state, mid.cancel_requested_at !== null]).toEqual(["created", true]);
    expect(await kinds(made.env, made.job.id)).toEqual(["hold"]);
    // The lease is gone (the attempt ended), so the sweep's tag search is the authority: it finds the Tapis
    // job, binds it and cancels it.
    await sweepComputeCancellations(made.env);
    await sweepComputeCancellations(made.env);
    const [only] = [...fx.tapis.jobs.values()];
    expect(only?.status).toBe("CANCELLED");
    const done = await reread(made.env, made.job.id);
    expect([done.state, done.tapis_uuid]).toEqual(["cancelled", only?.uuid ?? ""]);
    expect(await kinds(made.env, made.job.id)).toEqual(["hold", "release"]);
  });

  test("a lease that has EXPIRED (a submitter that stalled or died) does not hold a cancel back: with nothing at Tapis the row ends at once", async () => {
    const made = await makeJob(fx);
    await made.env.DB.prepare(
      "UPDATE compute_jobs SET submit_claimed_at = ?1, launch_spec_digest = ?2 WHERE id = ?3",
    )
      .bind(
        // Six minutes ago, in the stamp's own form.
        new Date(Date.now() - (SUBMIT_LEASE_MINUTES + 1) * 60_000)
          .toISOString()
          .replace("T", " ")
          .replace("Z", ""),
        "a".repeat(64),
        made.job.id,
      )
      .run();
    const answer = await requestComputeCancel(made.env, made.job.id, "user");
    expect(answer).toMatchObject({ ok: true, state: "cancelled" });
    expect(await kinds(made.env, made.job.id)).toEqual(["hold", "release"]);
  });

  test("a lease that is live holds a cancel back even before the launch digest is written", async () => {
    const made = await makeJob(fx);
    await made.env.DB.prepare("UPDATE compute_jobs SET submit_claimed_at = ?1 WHERE id = ?2")
      .bind(new Date().toISOString().replace("T", " ").replace("Z", ""), made.job.id)
      .run();
    const answer = await requestComputeCancel(made.env, made.job.id, "user");
    expect(answer).toMatchObject({ ok: true, outcome: "cancel_requested", state: "created" });
    expect(await kinds(made.env, made.job.id)).toEqual(["hold"]);
  });
});

describe("a submitter releases only its own lease", () => {
  test("an attempt that outlived its lease does not clear the lease of the submitter that took the job over (MUTATION: drop the holder check from the release)", async () => {
    const made = await makeJob(fx);
    const other = "2030-01-01 00:00:00.000";
    // While the first attempt is in flight (the stand-in has acted, the answer has not gone back), its
    // lease expires and another submitter takes the job over.
    fx.proxy.afterNextSubmit(async () => {
      await made.env.DB.prepare("UPDATE compute_jobs SET submit_claimed_at = ?1 WHERE id = ?2")
        .bind(other, made.job.id)
        .run();
    });
    expect(await submitComputeJob(made.env, made.job.id)).toEqual({
      ok: true,
      outcome: "submitted",
    });
    // The first attempt finished and released: the other submitter's lease is untouched.
    expect((await reread(made.env, made.job.id)).submit_claimed_at).toBe(other);
  });

  test("the release statement clears a lease only for the stamp that claimed it", async () => {
    const made = await makeJob(fx);
    const db = made.env.DB;
    await db.prepare(CLAIM_SUBMIT_SQL).bind(made.job.id, "2026-11-05 10:00:00.000").run();
    await db.prepare(RELEASE_SUBMIT_SQL).bind(made.job.id, "2026-11-05 10:00:00.001").run();
    expect((await reread(made.env, made.job.id)).submit_claimed_at).toBe("2026-11-05 10:00:00.000");
    await db.prepare(RELEASE_SUBMIT_SQL).bind(made.job.id, "2026-11-05 10:00:00.000").run();
    expect((await reread(made.env, made.job.id)).submit_claimed_at).toBeNull();
  });
});

describe("a terminal hint that lost to a live write", () => {
  test("it is applied again against the fresh row, not dropped for 30 minutes (MUTATION: no retry)", async () => {
    const made = await makeJob(fx);
    await submitComputeJob(made.env, made.job.id);
    const uuid = (await reread(made.env, made.job.id)).tapis_uuid as string;
    fx.tapis.advance(uuid, "QUEUED");
    await advanceComputeJob(made.env, made.job.id);
    const queued = await reread(made.env, made.job.id);
    fx.tapis.advance(uuid, "RUNNING");
    setTapisTimes(fx, uuid, 30 * MINUTE, 0);
    const base = fx.tapis.jobs.get(uuid)?.record as Record<string, unknown>;
    // A poll moves the job from QUEUED to RUNNING; a webhook that read the same QUEUED row holds the
    // FAILED record Tapis has reached by the time it reads back.
    expect(
      (await applyTapisJob(made.env, queued, { ...base, status: "RUNNING" } as never)).outcome,
    ).toBe("advanced");
    const result = await applyTapisJob(made.env, queued, {
      ...base,
      status: "FAILED",
      condition: "JOB_LAUNCH_FAILURE",
    } as never);
    expect(result).toMatchObject({ changed: true, outcome: "terminal_committed" });
    const job = await reread(made.env, made.job.id);
    expect([job.state, job.failure_code, job.charged_milli]).toEqual([
      "failed",
      "launch_failed",
      2000,
    ]);
    expect(await kinds(made.env, made.job.id)).toEqual(["hold", "charge"]);
  });
});

describe("a job found by tag is applied from its FULL record", () => {
  test("an adopted job that already ended is checked against the exit code Tapis reports (MUTATION: apply the search record)", async () => {
    const made = await makeJob(fx);
    fx.proxy.loseSubmitAnswers(1);
    await submitComputeJob(made.env, made.job.id);
    const [only] = [...fx.tapis.jobs.values()];
    const uuid = only?.uuid as string;
    // The job ran to the end while the Worker did not know of it: the launcher wrote a clean result and
    // Tapis reports another exit code (`remoteResultInfo` is on the full record and not on a search hit).
    fx.tapis.advance(uuid, "RUNNING");
    await playLauncher(fx, made.env, await reread(made.env, made.job.id), uuid, {});
    fx.tapis.advance(uuid, "FINISHED");
    setTapisTimes(fx, uuid, 30 * MINUTE, 0);
    const record = fx.tapis.jobs.get(uuid)?.record;
    if (record) record.remoteResultInfo = "5";
    expect(await submitComputeJob(made.env, made.job.id)).toEqual({ ok: true, outcome: "bound" });
    const job = await reread(made.env, made.job.id);
    expect([job.state, job.failure_code, job.failure_detail]).toEqual([
      "failed",
      "result_verification_failed",
      "exit_mismatch",
    ]);
    expect(job.flag_mismatch).toBe(1);
  });
});

describe("what the new paths log", () => {
  test("a lost bind, an orphan and a cancel by tag log job ids and fixed words only", async () => {
    const lines = await logged(async () => {
      const made = await makeJob(fx);
      fx.proxy.afterNextSubmit(async () => {
        await made.env.DB.prepare(
          "UPDATE compute_jobs SET tapis_uuid = 'x-007', state = 'submitted' WHERE id = ?",
        )
          .bind(made.job.id)
          .run();
      });
      fx.tapis.fail("POST /v3/jobs/:uuid/cancel", 503);
      await submitComputeJob(made.env, made.job.id);
    });
    const joined = lines.join("\n");
    expect(joined).toContain("orphan_cancel_failed");
    for (const word of [fx.tapis.url, fx.tapis.password, "NEMAR_LAUNCH_SPEC", "x-007"]) {
      expect([word, joined.includes(word)]).toEqual([word, false]);
    }
  });
});

// --- What every submit asks the scheduler for ----------------------------------------------------

// Tapis always passes a memory to the scheduler and its own default is 100 MB, so a job that names none
// is limited to 100 MB however much its hold charged it for: a whole node would be paid for and not
// given. Every submit therefore carries all four (memory, minutes, nodes and cores), on every partition.
describe("every partition's submit carries memory, minutes, nodes and cores", () => {
  /** Per partition: [row cores, row GPUs, row memory in MB or null, memory the submit must carry]. */
  const WRITTEN_OUT: Record<PartitionName, [number, number, number | null, number]> = {
    shared: [4, 0, null, 8192],
    // A whole node is charged as 262,144 MB and the queue schedules at most 249,208: the submit is clamped.
    compute: [128, 0, null, 249208],
    debug: [4, 0, null, 8192],
    "large-shared": [4, 0, null, 8192],
    preempt: [4, 0, null, 8192],
    "gpu-shared": [10, 1, null, 94208],
    gpu: [40, 4, null, 376832],
    "gpu-debug": [10, 1, null, 94208],
    "gpu-preempt": [10, 1, null, 94208],
  };

  test("the table written out here covers exactly the contract's partitions", () => {
    expect(Object.keys(WRITTEN_OUT).sort()).toEqual(Object.keys(PARTITIONS).sort());
  });

  for (const partition of Object.keys(PARTITIONS) as PartitionName[]) {
    const [cores, gpus, memory, expected] = WRITTEN_OUT[partition];
    test(`${partition}: a row with ${memory === null ? "no memory" : `${memory} MB`} submits memoryMB ${expected} with maxMinutes, nodeCount and coresPerNode`, async () => {
      const made = await makeJob(fx);
      await made.env.DB.prepare(
        `UPDATE compute_jobs SET partition = ?1, pool = ?2, nodes = 1, cores_per_node = ?3,
                gpus = ?4, memory_mb = ?5, minutes = 30 WHERE id = ?6`,
      )
        .bind(partition, PARTITIONS[partition].pool, cores, gpus, memory, made.job.id)
        .run();
      expect(await submitComputeJob(made.env, made.job.id)).toEqual({
        ok: true,
        outcome: "submitted",
      });
      const request = fx.tapis.log.find((r) => r.route === "POST /v3/jobs/submit");
      const body = JSON.parse(request?.body ?? "{}");
      expect([partition, body.memoryMB]).toEqual([partition, expected]);
      expect([partition, body.maxMinutes, body.nodeCount, body.coresPerNode]).toEqual([
        partition,
        30,
        1,
        cores,
      ]);
      expect(body.execSystemLogicalQueue).toBe(partition);
    });
  }

  // Round 2 of #2041: the memory the charge pays for is not always what a queue can schedule. A whole
  // `compute` node's 262,144 MB (its nominal memory) is over the queue's 249,208 MB, and so is a 128-core
  // `debug` job that names no memory (128 x 2,048 MB); either would be refused at submit.
  test("a 128-core compute job, a 128-core debug job and a whole GPU node all submit within their queue's maximum", async () => {
    const shapes: Array<[PartitionName, number, number, number]> = [
      ["compute", 128, 0, 249208],
      ["debug", 128, 0, 249208],
      ["preempt", 128, 0, 249208],
      ["gpu", 40, 4, 376832],
    ];
    for (const [partition, cores, gpus, expected] of shapes) {
      const made = await makeJob(fx);
      await made.env.DB.prepare(
        `UPDATE compute_jobs SET partition = ?1, pool = ?2, nodes = 1, cores_per_node = ?3,
                gpus = ?4, memory_mb = NULL, minutes = 30 WHERE id = ?5`,
      )
        .bind(partition, PARTITIONS[partition].pool, cores, gpus, made.job.id)
        .run();
      fx.tapis.log.length = 0;
      expect(await submitComputeJob(made.env, made.job.id)).toEqual({
        ok: true,
        outcome: "submitted",
      });
      const body = JSON.parse(
        fx.tapis.log.find((r) => r.route === "POST /v3/jobs/submit")?.body ?? "{}",
      );
      expect([partition, body.memoryMB]).toEqual([partition, expected]);
    }
  });

  test("a per-resource job's own memory is what is asked for; a whole node's own is not (the node is charged and given whole)", async () => {
    const own = await makeJob(fx);
    await own.env.DB.prepare("UPDATE compute_jobs SET memory_mb = 20000 WHERE id = ?")
      .bind(own.job.id)
      .run();
    await submitComputeJob(own.env, own.job.id);
    const whole = await makeJob(fx);
    await whole.env.DB.prepare(
      "UPDATE compute_jobs SET partition = 'compute', cores_per_node = 128, memory_mb = 1000, minutes = 30 WHERE id = ?",
    )
      .bind(whole.job.id)
      .run();
    await submitComputeJob(whole.env, whole.job.id);
    const sent = fx.tapis.log
      .filter((r) => r.route === "POST /v3/jobs/submit")
      .map((r) => JSON.parse(r.body ?? "{}").memoryMB);
    expect(sent).toEqual([20000, 249208]);
  });

  test("a row with nothing to ask memory for cannot launch: it ends failed with the hold released, and Tapis is never reached", async () => {
    const made = await makeJob(fx);
    await made.env.DB.prepare(
      "UPDATE compute_jobs SET cores_per_node = 0, memory_mb = NULL WHERE id = ?",
    )
      .bind(made.job.id)
      .run();
    expect(await submitComputeJob(made.env, made.job.id)).toMatchObject({ ok: false });
    const job = await reread(made.env, made.job.id);
    expect([job.state, job.failure_code, job.failure_detail]).toEqual([
      "failed",
      "tapis_submit_failed",
      "invalid_spec",
    ]);
    expect(await kinds(made.env, made.job.id)).toEqual(["hold", "release"]);
    expect(submitsAtTapis()).toBe(0);
  });

  // A5 follow-up of A1c (#2043): a request NEMAR will not send because of the job's own data is wrong
  // the same way on every attempt. It used to fall into the generic "unclear" catch and be tried again
  // on every tick until the reservation wait ran out.
  test("a request the builder refuses for the job's own data ends the job: failed, the hold released, Tapis never reached, and no retry", async () => {
    const made = await makeJob(fx);
    // Zero cores a node with a memory of its own: the memory to ask for is known (so the row gets as far
    // as the request), and `coresPerNode` is not a positive number, which the request builder refuses.
    await made.env.DB.prepare(
      "UPDATE compute_jobs SET cores_per_node = 0, memory_mb = 20000 WHERE id = ?",
    )
      .bind(made.job.id)
      .run();
    const logs = await logged(async () => {
      expect(await submitComputeJob(made.env, made.job.id)).toEqual({
        ok: false,
        outcome: "failed",
      });
    });
    const job = await reread(made.env, made.job.id);
    expect([job.state, job.failure_code, job.failure_detail]).toEqual([
      "failed",
      "tapis_submit_failed",
      "invalid_spec",
    ]);
    expect(job.tapis_uuid).toBeNull();
    // The digest of the launch specification is written BEFORE the call, as always, so the failed row
    // carries it though nothing was sent: it is the digest of the text last built, never of the value.
    expect(job.launch_spec_digest).toMatch(/^[0-9a-f]{64}$/);
    // Released, not refunded, and not charged: the whole hold goes back.
    expect(await kinds(made.env, made.job.id)).toEqual(["hold", "release"]);
    expect(submitsAtTapis()).toBe(0);
    // The log line names a job id and two fixed words, and nothing the request held.
    const line = logs.find((l) => l.includes("launch_unbuildable"));
    expect(line).toContain(`job=${made.job.id}`);
    expect(line).toContain("reason=job_field");
    // A later tick finds a finished row and does nothing: no second release, still no submit.
    expect((await submitComputeJob(made.env, made.job.id)).ok).toBe(false);
    expect(await kinds(made.env, made.job.id)).toEqual(["hold", "release"]);
    expect(submitsAtTapis()).toBe(0);
  });
});
