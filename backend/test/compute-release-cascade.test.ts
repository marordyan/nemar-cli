/**
 * Ending an account ends its compute (epic #2005 phase A8, #2013; AGENTS.md, "Revocation cascades,
 * always"; ADR 0118; design section 7): `computeReleaseStatements` runs in the batch of BOTH callers
 * that end every credential of an account, `finalizeRevocation` (admin revoke, by username and by id)
 * and `tombstoneUserCascade` (the owner-only soft delete and the scheduled sweep of the live tests'
 * accounts, which run the same function), and in no other.
 *
 * Every case drives the REAL route (or the real `tombstoneUserCascade`) over a real migrated database
 * carrying real jobs made through `createJob`, real holds and real pools; the Tapis tenant is the A4
 * stand-in (a real HTTP server built from Tapis's published specifications; NO RESPONSE IN IT WAS
 * RECORDED FROM A REAL TENANT) behind the A5 forwarding proxy, and the cancel that follows the batch is
 * made by the real `sweepComputeCancellations`. Nothing here replaces a NEMAR decision.
 *
 * What is pinned, each with a test of its own:
 *  - a job NOT YET AT TAPIS, provably so (no Tapis job, no launch specification written, no live submit
 *    lease), is cancelled with `cancel_reason = 'account_ended'` and its hold released in the SAME batch;
 *  - a job at Tapis, or one a submit may have reached (a lost answer wrote its launch specification; a
 *    submitter holds the lease), is NOT ended in SQL: it records `account_ended` and the intent to
 *    cancel, keeps its hold, and the retried sweep cancels it AT TAPIS (a Tapis call never runs inside
 *    the batch: the stand-in's log is empty between the batch and the sweep);
 *  - every pool of the account is frozen (a new hold is refused `suspended`), no other account's is;
 *  - a job that already ended, and another account's live job, are untouched;
 *  - the first recorded cancel reason stands (a person's earlier cancel stays `user`);
 *  - the guarded call of the scheduled sweep (`onlyIfEmail`) changes NOTHING in compute when its guard
 *    is false, statement by statement: every release statement ends in a WHERE clause;
 *  - a role demotion and a key revocation do NOT end compute (a person who is no longer an admin, or
 *    who revoked one key, still has an account and its jobs);
 *  - the statements are replayable: a second run writes nothing.
 * MUTATIONS, each run alone: remove the statements from `finalizeRevocation`; remove them from
 * `tombstoneUserCascade`; drop the `launch_spec_digest IS NULL` or the lease term of the SQL cancel;
 * drop the freeze; drop the account scope of a statement; drop `COALESCE` of the reason.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { MASK_APPLIED_SQL, tombstoneUserCascade } from "../src/db/user-tombstone";
import { adminRoutes } from "../src/routes/admin";
import { runComputeAdvanceCron, sweepComputeCancellations } from "../src/services/compute-advance";
import { type ComputeJobRow, createJob } from "../src/services/compute-jobs";
import { releaseHold } from "../src/services/compute-ledger";
import {
  CLAIM_SUBMIT_SQL,
  advanceComputeJob,
  claimStamp,
  requestComputeCancel,
  submitComputeJob,
} from "../src/services/compute-lifecycle";
import { computeReleaseStatements } from "../src/services/compute-release";
import { hashApiKey } from "../src/services/token";
import { issueSession } from "../src/services/web-session";
import type { Bindings, Variables } from "../src/types/bindings";
import {
  type LifecycleFixture,
  MINUTE,
  launchableSpec,
  reread,
  setPolicy,
  setTapisTimes,
  startLifecycleFixture,
} from "./helpers/compute-lifecycle-fixture";
import { fundAccount, fundPlatform, seedUser } from "./helpers/compute-seed";

const OWNER_KEY = "release-owner-key-0123456789abcdef0123456789abcdef";

let fx: LifecycleFixture;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;

/** An owner of Miniflare's D1 (never reset) and the key its routes are called with. */
let d1Owner = 0;

beforeAll(async () => {
  fx = await startLifecycleFixture({ withD1: true });
  const d1 = fx.harness.d1 as D1Database;
  d1Owner = await seedUser(d1, { role: "owner", username: "releaseowner-d1" });
  await d1
    .prepare("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)")
    .bind(d1Owner, await hashApiKey(OWNER_KEY), OWNER_KEY.slice(0, 8))
    .run();
}, 120_000);

beforeEach(async () => {
  await fx.reset();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  await fx.harness.db
    .query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)")
    .run(fx.ownerId, await hashApiKey(OWNER_KEY), OWNER_KEY.slice(0, 8));
  await setPolicy(fx.env().DB, fx.ownerId, { maxLiveJobsPerPerson: 10 });
});

afterAll(async () => {
  await fx?.dispose();
}, 30_000);

// --- Helpers -------------------------------------------------------------------------------------

/** What the revoke and delete routes read: the production Worker's bindings minus the ones that would
 *  reach a real service (the admin routes' IAM, GitHub and mail steps are no-ops here, as in
 *  `admin-credential-cascade.test.ts`). The database is the one the fixture's production env uses. */
function routeEnv(): Bindings {
  return fx.env({
    ENVIRONMENT: "test",
    RESEND_API_KEY: "",
    WEB_SESSION_COOKIE_DOMAIN: "",
  });
}

function ownerCall(method: string, path: string, body?: unknown): Promise<Response> {
  return app.request(
    path,
    {
      method,
      headers: {
        Authorization: `Bearer ${OWNER_KEY}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
    routeEnv(),
  );
}

const revoke = (username: string) => ownerCall("POST", `/admin/revoke/${username}`);
const del = (id: number) => ownerCall("DELETE", `/admin/users/by-id/${id}`);

const db = (): Database => fx.harness.db;

interface LedgerKind {
  kind: string;
}

const ledgerKinds = (jobId: string): string[] =>
  db()
    .query<LedgerKind, [string]>("SELECT kind FROM compute_ledger WHERE job_id = ? ORDER BY id")
    .all(jobId)
    .map((r) => r.kind);

interface PoolRow {
  pool: string;
  frozen: number;
  held_milli: number;
  charged_milli: number;
  granted_milli: number;
}

const poolsOf = (accountId: number): PoolRow[] =>
  db()
    .query<PoolRow, [string]>(
      `SELECT pool, frozen, held_milli, charged_milli, granted_milli FROM compute_pools
        WHERE holder_kind = 'account' AND holder_ref = ? ORDER BY pool`,
    )
    .all(String(accountId));

/** A job for an existing account: its hold, its row and its records, made by the real `createJob`. */
async function jobFor(env: Bindings, accountId: number): Promise<ComputeJobRow> {
  const made = await createJob(env, {
    source: "cli",
    accountId,
    appId: "nemar-launch",
    appVersion: "1.0.0",
    spec: launchableSpec(),
  });
  if (!made.ok) throw new Error(`could not make a job: ${made.code}`);
  if (!made.recordsWritten) throw new Error("the job's records were not written");
  return made.job;
}

/** A job submitted to Tapis and moved to RUNNING for thirty minutes. */
async function runningJob(env: Bindings, accountId: number): Promise<ComputeJobRow> {
  const job = await jobFor(env, accountId);
  expect((await submitComputeJob(env, job.id)).ok).toBe(true);
  const bound = await reread(env, job.id);
  fx.tapis.advance(bound.tapis_uuid as string, "RUNNING");
  setTapisTimes(fx, bound.tapis_uuid as string, 30 * MINUTE, null);
  await advanceComputeJob(env, job.id);
  return reread(env, job.id);
}

const cancels = () => fx.tapis.log.filter((r) => r.route === "POST /v3/jobs/:uuid/cancel").length;
const submits = () => fx.tapis.log.filter((r) => r.route === "POST /v3/jobs/submit").length;

interface World {
  /** The account that ends. */
  target: number;
  username: string;
  /** Never submitted: SQL can end it. */
  unsubmitted: ComputeJobRow;
  /** At Tapis, running. */
  running: ComputeJobRow;
  /** A submit's answer was lost: the launch specification is written and a Tapis job may exist. */
  inFlight: ComputeJobRow;
  /** Ended before the account did (a person's own cancel). */
  ended: ComputeJobRow;
  /** Another account, with a job at Tapis and its own pools. */
  bystander: number;
  bystanderJob: ComputeJobRow;
}

/** The account that ends, with one job of each kind, and a bystander that must not be touched. */
async function seedWorld(username = "cascadetarget"): Promise<World> {
  const env = fx.env();
  const target = await seedUser(env.DB, { username });
  await fundAccount(env.DB, target, 100_000, "cpu");
  await fundAccount(env.DB, target, 50_000, "gpu");
  const bystander = await seedUser(env.DB, { username: "cascadebystander" });
  await fundAccount(env.DB, bystander, 100_000, "cpu");

  const ended = await jobFor(env, target);
  expect((await requestComputeCancel(env, ended.id, "user")).state).toBe("cancelled");
  const unsubmitted = await jobFor(env, target);
  const running = await runningJob(env, target);
  const lost = await jobFor(env, target);
  fx.proxy.loseSubmitAnswers(1);
  expect((await submitComputeJob(env, lost.id)).ok).toBe(false);
  const inFlight = await reread(env, lost.id);
  expect(inFlight.state).toBe("created");
  expect(inFlight.tapis_uuid).toBeNull();
  expect(inFlight.launch_spec_digest).not.toBeNull();
  const bystanderJob = await runningJob(env, bystander);
  return {
    target,
    username,
    unsubmitted,
    running,
    inFlight,
    ended: await reread(env, ended.id),
    bystander,
    bystanderJob,
  };
}

/** What the cascade must leave exactly as it was: the bystander's and the ended job's rows, ledgers, pools. */
function untouched(world: World): unknown {
  return {
    bystanderJob: db().query("SELECT * FROM compute_jobs WHERE id = ?").get(world.bystanderJob.id),
    bystanderLedger: ledgerKinds(world.bystanderJob.id),
    bystanderPools: poolsOf(world.bystander),
    ended: db().query("SELECT * FROM compute_jobs WHERE id = ?").get(world.ended.id),
    endedLedger: ledgerKinds(world.ended.id),
  };
}

/** The sweep as the production tick runs it. */
async function sweep() {
  return sweepComputeCancellations(fx.env());
}

// --- The two callers, each driven through its own route ------------------------------------------

describe("revoking an account (finalizeRevocation) ends its compute in the same batch", () => {
  test("a job not yet at Tapis is cancelled and its hold released; one at Tapis records the intent; every pool is frozen; nothing else moves (MUTATION: remove the statements from finalizeRevocation)", async () => {
    const world = await seedWorld();
    const before = untouched(world);
    const holdsBefore = poolsOf(world.target);
    expect(holdsBefore.map((p) => p.frozen)).toEqual([0, 0]);
    const requests = fx.tapis.log.length;

    const res = await revoke(world.username);
    expect(res.status).toBe(200);

    // Not yet at Tapis: ended in SQL, in the batch, with its hold released.
    const unsubmitted = await reread(fx.env(), world.unsubmitted.id);
    expect(unsubmitted.state).toBe("cancelled");
    expect(unsubmitted.cancel_reason).toBe("account_ended");
    expect(unsubmitted.cancel_requested_at).not.toBeNull();
    expect(unsubmitted.ended_at).not.toBeNull();
    expect(unsubmitted.retention_until).not.toBeNull();
    expect(unsubmitted.settled_provisional_at).not.toBeNull();
    expect(unsubmitted.charged_milli).toBe(0);
    expect(ledgerKinds(unsubmitted.id)).toEqual(["hold", "release"]);

    // At Tapis, and one a submit may have reached: the intent and the reason, the hold kept, still live.
    for (const id of [world.running.id, world.inFlight.id]) {
      const job = await reread(fx.env(), id);
      expect(job.state).toBe(id === world.running.id ? "running" : "created");
      expect(job.cancel_reason).toBe("account_ended");
      expect(job.cancel_requested_at).not.toBeNull();
      expect(job.settled_provisional_at).toBeNull();
      expect(ledgerKinds(id)).toEqual(["hold"]);
    }

    // Both pools are frozen, the target's hold on the unsubmitted job is back, the others are still held.
    const pools = poolsOf(world.target);
    expect(pools.map((p) => [p.pool, p.frozen])).toEqual([
      ["cpu", 1],
      ["gpu", 1],
    ]);
    expect(pools[0]?.held_milli).toBe((holdsBefore[0]?.held_milli ?? 0) - 4000);
    // No platform or other account's pool was frozen.
    expect(
      db()
        .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM compute_pools WHERE frozen = 1")
        .get()?.n,
    ).toBe(2);

    // NO NETWORK CALL IN THE BATCH: Tapis saw nothing between the loss of the submit's answer and now.
    expect(fx.tapis.log.length).toBe(requests);

    // A bystander's job, pools and ledger, and the job that ended earlier, are exactly as they were.
    expect(untouched(world)).toEqual(before);
  });

  test("the retried sweep cancels the running job AT TAPIS, the in-flight one's Tapis job is found by tag and cancelled, and the first recorded reason stands", async () => {
    const world = await seedWorld();
    await revoke(world.username);
    const cancelsBefore = cancels();
    expect(cancelsBefore).toBe(0);

    // Tapis is down for the first sweep: nothing changes but the sweep says it tried.
    fx.tapis.down();
    const first = await sweep();
    expect(first).toMatchObject({ examined: 2 });
    expect((await reread(fx.env(), world.running.id)).state).toBe("running");
    expect((await reread(fx.env(), world.inFlight.id)).state).toBe("created");
    expect(ledgerKinds(world.running.id)).toEqual(["hold"]);

    // Tapis is back: the retried sweep cancels.
    fx.tapis.up();
    await sweep();
    const running = await reread(fx.env(), world.running.id);
    expect(running.state).toBe("cancelled");
    expect(running.cancel_reason).toBe("account_ended");
    // Thirty minutes of four cores, give or take the seconds the stand-in took to cancel.
    expect(running.charged_milli).toBeGreaterThanOrEqual(2000);
    expect(running.charged_milli).toBeLessThanOrEqual(2010);
    expect(ledgerKinds(running.id)).toEqual(["hold", "charge"]);

    const inFlight = await reread(fx.env(), world.inFlight.id);
    expect(inFlight.state).toBe("cancelled");
    expect(inFlight.cancel_reason).toBe("account_ended");
    expect(ledgerKinds(inFlight.id)).toEqual(["hold", "release"]);
    // The Tapis job the lost answer made was cancelled: none is left running for an ended account.
    const theirs = [...fx.tapis.jobs.values()].filter((j) => j.uuid === inFlight.tapis_uuid);
    expect(theirs).toHaveLength(1);
    expect(theirs[0]?.status).toBe("CANCELLED");
    expect(cancels()).toBeGreaterThanOrEqual(2);

    // Nothing is left to do, and the bystander's job is still running at Tapis.
    expect(await sweep()).toMatchObject({ examined: 0 });
    expect((await reread(fx.env(), world.bystanderJob.id)).state).toBe("running");
    const stand = fx.tapis.jobs.get(world.bystanderJob.tapis_uuid as string);
    expect(stand?.status).toBe("RUNNING");
  });

  test("a job whose submit is in flight when the account ends keeps its hold, and the submitter's bind turns the intent into a Tapis cancel", async () => {
    const env = fx.env();
    const target = await seedUser(env.DB, { username: "cascademidflight" });
    await fundAccount(env.DB, target, 100_000, "cpu");
    const job = await jobFor(env, target);
    // The stand-in has accepted the submit; before the Worker hears, the account is revoked.
    fx.proxy.afterNextSubmit(async () => {
      expect((await revoke("cascademidflight")).status).toBe(200);
    });
    expect((await submitComputeJob(env, job.id)).ok).toBe(false);

    // The lease was live, so SQL did not end the row and did not release its hold: a Tapis job exists.
    let row = await reread(env, job.id);
    expect(row.state).toBe("created");
    expect(row.cancel_reason).toBe("account_ended");
    expect(ledgerKinds(job.id)).toEqual(["hold"]);
    expect(submits()).toBe(1);

    await sweep();
    row = await reread(env, job.id);
    expect(row.state).toBe("cancelled");
    expect(row.cancel_reason).toBe("account_ended");
    expect(ledgerKinds(job.id)).toEqual(["hold", "release"]);
    const [only] = [...fx.tapis.jobs.values()];
    expect(only?.status).toBe("CANCELLED");
  });

  test("a job whose submitter holds the lease is not ended in SQL (a submit may be in flight), and one with a stale lease (a submitter that died) is", async () => {
    const env = fx.env();
    const target = await seedUser(env.DB, { username: "cascadelease" });
    await fundAccount(env.DB, target, 100_000, "cpu");
    const live = await jobFor(env, target);
    const stale = await jobFor(env, target);
    // The submitter's own claim, with the real statement: a lease taken before the tag search and before
    // any launch specification is written, so no other column says a submit is in flight.
    for (const id of [live.id, stale.id]) {
      const claimed = await env.DB.prepare(CLAIM_SUBMIT_SQL).bind(id, claimStamp(Date.now())).run();
      expect(claimed.meta.changes).toBe(1);
    }
    // One submitter died long ago: its stamp is older than the lease.
    db().run(
      "UPDATE compute_jobs SET submit_claimed_at = datetime('now', '-10 minutes') WHERE id = ?",
      [stale.id],
    );

    expect((await revoke("cascadelease")).status).toBe(200);

    const liveRow = await reread(env, live.id);
    expect(liveRow.state).toBe("created");
    expect(liveRow.cancel_reason).toBe("account_ended");
    expect(ledgerKinds(live.id)).toEqual(["hold"]);
    const staleRow = await reread(env, stale.id);
    expect(staleRow.state).toBe("cancelled");
    expect(ledgerKinds(stale.id)).toEqual(["hold", "release"]);

    // The submitter's lease runs out; the sweep (a tag search finds nothing) ends the row and releases.
    db().run(
      "UPDATE compute_jobs SET submit_claimed_at = datetime('now', '-10 minutes') WHERE id = ?",
      [live.id],
    );
    await sweep();
    expect((await reread(env, live.id)).state).toBe("cancelled");
    expect(ledgerKinds(live.id)).toEqual(["hold", "release"]);
    expect(submits()).toBe(0);
  });

  test("a hold already closed behind the cascade's back does not make the revocation fail: no second release, and the job is still ended and stamped (MUTATION: drop the open-hold check of the release)", async () => {
    const env = fx.env();
    const target = await seedUser(env.DB, { username: "cascadeclosed" });
    await fundAccount(env.DB, target, 100_000, "cpu");
    const job = await jobFor(env, target);
    // Something released the hold already (a repair, an administrator's tool) and did not move the row.
    expect((await releaseHold(env.DB, { jobId: job.id })).ok).toBe(true);
    expect(ledgerKinds(job.id)).toEqual(["hold", "release"]);

    // A second release of one hold is refused by the ledger itself, which would roll the whole batch
    // back and leave the account revoked in no other table: the statement must not write it.
    expect((await revoke("cascadeclosed")).status).toBe(200);

    const row = await reread(env, job.id);
    expect(row.state).toBe("cancelled");
    expect(row.settled_provisional_at).not.toBeNull();
    expect(ledgerKinds(job.id)).toEqual(["hold", "release"]);
    expect(poolsOf(target).map((p) => [p.frozen, p.held_milli])).toEqual([[1, 0]]);
  });

  test("the by-id twin of the route (an account with no username) runs the same batch", async () => {
    const world = await seedWorld("cascadebyid");
    expect((await ownerCall("POST", `/admin/revoke/by-id/${world.target}`)).status).toBe(200);
    expect((await reread(fx.env(), world.unsubmitted.id)).state).toBe("cancelled");
    for (const id of [world.running.id, world.inFlight.id]) {
      expect((await reread(fx.env(), id)).cancel_reason).toBe("account_ended");
    }
    expect(poolsOf(world.target).map((p) => p.frozen)).toEqual([1, 1]);
  });

  test("the 30-minute tick finishes what the batch leaves: the records copy of a job the cascade ended, with no second release", async () => {
    const world = await seedWorld("cascadecopy");
    await revoke(world.username);
    const ended = await reread(fx.env(), world.unsubmitted.id);
    expect(ended.state).toBe("cancelled");
    expect(ended.result_records_at).toBeNull();

    const tick = await runComputeAdvanceCron(fx.env());
    expect(tick).toMatchObject({ errors: [] });
    const after = await reread(fx.env(), world.unsubmitted.id);
    expect(after.result_records_at).not.toBeNull();
    expect(after.state).toBe("cancelled");
    expect(after.cancel_reason).toBe("account_ended");
    expect(ledgerKinds(after.id)).toEqual(["hold", "release"]);
  });

  test("a partner's reservation of the ended account is left alone: no cancel, no release (MUTATION: drop the partner term of the intent, the SQL cancel, the release or the stamp); one that has a Tapis job is cancelled there", async () => {
    // NEMAR never writes a launch specification or takes a submit lease for a partner job (the partner
    // launches its own Tapis job under the reservation), so "never reached Tapis" is true of every
    // reservation without a Tapis job whether or not the partner has launched: releasing its hold could
    // give compute away for a job that runs. The reservation is the partner contract's (phase D4).
    const env = fx.env();
    const target = await seedUser(env.DB, { username: "cascadepartner" });
    await fundAccount(env.DB, target, 100_000, "cpu");
    const reservation = await jobFor(env, target);
    const bound = await runningJob(env, target);
    for (const id of [reservation.id, bound.id]) {
      db().run("UPDATE compute_jobs SET source = 'partner', client_id = 'c1' WHERE id = ?", [id]);
    }
    // And two partner reservations that something else already cancelled and nobody has settled: one
    // whose hold is still open, one whose hold was released already. The cascade settles neither (their
    // release and their stamp are the partner contract's).
    const abandonedOpen = await jobFor(env, target);
    const abandonedClosed = await jobFor(env, target);
    for (const id of [abandonedOpen.id, abandonedClosed.id]) {
      db().run(
        "UPDATE compute_jobs SET source = 'partner', client_id = 'c1', state = 'cancelled', cancel_reason = 'admin', ended_at = datetime('now') WHERE id = ?",
        [id],
      );
    }
    expect((await releaseHold(env.DB, { jobId: abandonedClosed.id })).ok).toBe(true);
    const snapshot = (id: string) =>
      JSON.stringify(db().query("SELECT * FROM compute_jobs WHERE id = ?").get(id));
    const before = Object.fromEntries(
      [reservation.id, abandonedOpen.id, abandonedClosed.id].map((id) => [id, snapshot(id)]),
    );

    expect((await revoke("cascadepartner")).status).toBe(200);

    // The reservation: not one column of its row, not one ledger entry, moved. Nor the two that were
    // cancelled before the account ended.
    for (const id of [reservation.id, abandonedOpen.id, abandonedClosed.id]) {
      expect(snapshot(id)).toBe(before[id]);
    }
    expect(ledgerKinds(reservation.id)).toEqual(["hold"]);
    expect(ledgerKinds(abandonedOpen.id)).toEqual(["hold"]);
    expect(ledgerKinds(abandonedClosed.id)).toEqual(["hold", "release"]);
    // The account's pools are frozen all the same, and the partner job that HAS a Tapis job records the
    // intent for the sweep, which cancels it there.
    expect(poolsOf(target).map((p) => p.frozen)).toEqual([1]);
    const row = await reread(env, bound.id);
    expect(row.cancel_reason).toBe("account_ended");
    expect(await sweep()).toMatchObject({ examined: 1, errors: [] });
    expect((await reread(env, bound.id)).state).toBe("cancelled");
    expect((await reread(env, reservation.id)).state).toBe("created");
    expect(ledgerKinds(reservation.id)).toEqual(["hold"]);
  });

  test("the first recorded reason stands: a person's own earlier cancel stays `user` and keeps its time", async () => {
    const world = await seedWorld();
    // The person asked to cancel the running job; Tapis could not take it yet.
    fx.tapis.fail("POST /v3/jobs/:uuid/cancel", 503);
    await requestComputeCancel(fx.env(), world.running.id, "user");
    const asked = await reread(fx.env(), world.running.id);
    expect(asked.cancel_reason).toBe("user");

    await revoke(world.username);
    const after = await reread(fx.env(), world.running.id);
    expect(after.cancel_reason).toBe("user");
    expect(after.cancel_requested_at).toBe(asked.cancel_requested_at);
  });

  test("new compute is refused for the account: its frozen pool refuses a hold as `suspended`", async () => {
    const world = await seedWorld();
    await revoke(world.username);
    const refused = await createJob(fx.env(), {
      source: "cli",
      accountId: world.target,
      appId: "nemar-launch",
      appVersion: "1.0.0",
      spec: launchableSpec(),
    });
    expect(refused).toMatchObject({ ok: false, code: "suspended" });
    // The bystander is not frozen.
    expect(
      (
        await createJob(fx.env(), {
          source: "cli",
          accountId: world.bystander,
          appId: "nemar-launch",
          appVersion: "1.0.0",
          spec: launchableSpec(),
        })
      ).ok,
    ).toBe(true);
  });
});

describe("deleting an account (tombstoneUserCascade) ends its compute in the same batch", () => {
  test("the owner's soft delete does the same, through its own route (MUTATION: remove the statements from tombstoneUserCascade)", async () => {
    const world = await seedWorld("tombstonetarget");
    const before = untouched(world);
    const requests = fx.tapis.log.length;

    const res = await del(world.target);
    expect(res.status).toBe(200);

    const unsubmitted = await reread(fx.env(), world.unsubmitted.id);
    expect(unsubmitted.state).toBe("cancelled");
    expect(unsubmitted.cancel_reason).toBe("account_ended");
    expect(ledgerKinds(unsubmitted.id)).toEqual(["hold", "release"]);
    for (const id of [world.running.id, world.inFlight.id]) {
      const job = await reread(fx.env(), id);
      expect(job.cancel_reason).toBe("account_ended");
      expect(job.cancel_requested_at).not.toBeNull();
      expect(ledgerKinds(id)).toEqual(["hold"]);
    }
    expect(poolsOf(world.target).map((p) => p.frozen)).toEqual([1, 1]);
    expect(fx.tapis.log.length).toBe(requests);
    expect(untouched(world)).toEqual(before);

    // The retried sweep ends the rest AT TAPIS, for an account that no longer exists.
    await sweep();
    expect((await reread(fx.env(), world.running.id)).state).toBe("cancelled");
    expect((await reread(fx.env(), world.inFlight.id)).state).toBe("cancelled");
  });

  test("the scheduled sweep's call (`onlyIfEmail`) applies it when the address still matches, and touches NOTHING of compute when the row's address changed", async () => {
    const world = await seedWorld("sweeptarget");
    const original = db()
      .query<{ email: string }, [number]>("SELECT email FROM users WHERE id = ?")
      .get(world.target)?.email as string;
    const before = JSON.stringify({
      jobs: db().query("SELECT * FROM compute_jobs ORDER BY id").all(),
      ledger: db().query("SELECT * FROM compute_ledger ORDER BY id").all(),
      pools: db().query("SELECT * FROM compute_pools ORDER BY id").all(),
    });

    // The guard is false: another address than the one the sweep read. Nothing is touched.
    const refused = await tombstoneUserCascade(
      fx.env().DB,
      world.target,
      original,
      "someone-else@example.org",
    );
    expect(refused.tombstoned).toBe(false);
    expect(
      JSON.stringify({
        jobs: db().query("SELECT * FROM compute_jobs ORDER BY id").all(),
        ledger: db().query("SELECT * FROM compute_ledger ORDER BY id").all(),
        pools: db().query("SELECT * FROM compute_pools ORDER BY id").all(),
      }),
    ).toBe(before);

    // The guard is true: the cascade applies, compute included.
    const done = await tombstoneUserCascade(fx.env().DB, world.target, original, original);
    expect(done.tombstoned).toBe(true);
    expect((await reread(fx.env(), world.unsubmitted.id)).state).toBe("cancelled");
    expect((await reread(fx.env(), world.running.id)).cancel_reason).toBe("account_ended");
    expect(poolsOf(world.target).map((p) => p.frozen)).toEqual([1, 1]);
  });

  test("every release statement ends in a WHERE clause: under a false guard each, alone, changes nothing, and under a true one the set changes something", async () => {
    const world = await seedWorld("guardtarget");
    const statements = computeReleaseStatements(world.target);
    expect(statements.length).toBeGreaterThanOrEqual(5);
    const snapshot = () =>
      JSON.stringify({
        jobs: db().query("SELECT * FROM compute_jobs ORDER BY id").all(),
        ledger: db().query("SELECT * FROM compute_ledger ORDER BY id").all(),
        pools: db().query("SELECT * FROM compute_pools ORDER BY id").all(),
      });
    const before = snapshot();
    for (const s of statements) {
      // Plain `?` placeholders only, one per bind: the guard's own `?` follow the statement's.
      expect(s.sql).not.toMatch(/\?\d/);
      expect((s.sql.match(/\?/g) ?? []).length).toBe(s.binds.length);
      expect(s.sql).toMatch(/\bWHERE\b/);
      expect(s.sql.trim()).not.toMatch(/;$/);
      db()
        .prepare(`${s.sql}${MASK_APPLIED_SQL}`)
        .run(...(s.binds as never[]), world.target, "no-such-address@example.org");
      expect(snapshot()).toBe(before);
    }
    // The same statements under a true guard (the target's own address) end the compute.
    const email = db()
      .query<{ email: string }, [number]>("SELECT email FROM users WHERE id = ?")
      .get(world.target)?.email as string;
    for (const s of statements) {
      db()
        .prepare(`${s.sql}${MASK_APPLIED_SQL}`)
        .run(...(s.binds as never[]), world.target, email);
    }
    expect(snapshot()).not.toBe(before);
    expect((await reread(fx.env(), world.unsubmitted.id)).state).toBe("cancelled");
  });
});

describe("what does NOT end compute", () => {
  test("a role demotion leaves the jobs and the pools alone: the person is still an account with compute", async () => {
    const world = await seedWorld("demotetarget");
    db().run("UPDATE users SET role = 'admin' WHERE id = ?", [world.target]);
    const before = JSON.stringify({
      jobs: db().query("SELECT * FROM compute_jobs ORDER BY id").all(),
      pools: db().query("SELECT * FROM compute_pools ORDER BY id").all(),
    });
    const res = await ownerCall("POST", `/admin/users/${world.username}/role`, { role: "member" });
    expect(res.status).toBe(200);
    expect(
      JSON.stringify({
        jobs: db().query("SELECT * FROM compute_jobs ORDER BY id").all(),
        pools: db().query("SELECT * FROM compute_pools ORDER BY id").all(),
      }),
    ).toBe(before);
    expect(poolsOf(world.target).map((p) => p.frozen)).toEqual([0, 0]);
  });

  test("revoking one API key leaves the jobs and the pools alone: a job's identity is not a key", async () => {
    const world = await seedWorld("keytarget");
    db().run("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)", [
      world.target,
      "release-key-hash",
      "relkey01",
    ]);
    const key = db()
      .query<{ id: number }, [number]>("SELECT id FROM tokens WHERE user_id = ?")
      .get(world.target);
    const before = JSON.stringify({
      jobs: db().query("SELECT * FROM compute_jobs ORDER BY id").all(),
      pools: db().query("SELECT * FROM compute_pools ORDER BY id").all(),
    });
    const res = await ownerCall("DELETE", `/admin/users/${world.username}/keys/${key?.id}`);
    expect(res.status).toBe(200);
    expect(
      JSON.stringify({
        jobs: db().query("SELECT * FROM compute_jobs ORDER BY id").all(),
        pools: db().query("SELECT * FROM compute_pools ORDER BY id").all(),
      }),
    ).toBe(before);
  });
});

describe("the statements", () => {
  test("they are replayable: a second run writes no entry and changes no row", async () => {
    const world = await seedWorld("replaytarget");
    const run = () =>
      fx.env().DB.batch(
        computeReleaseStatements(world.target).map((s) =>
          fx
            .env()
            .DB.prepare(s.sql)
            .bind(...s.binds),
        ),
      );
    await run();
    const snapshot = () =>
      JSON.stringify({
        jobs: db().query("SELECT * FROM compute_jobs ORDER BY id").all(),
        ledger: db().query("SELECT * FROM compute_ledger ORDER BY id").all(),
        pools: db().query("SELECT * FROM compute_pools ORDER BY id").all(),
      });
    const once = snapshot();
    await run();
    expect(snapshot()).toBe(once);
    expect(ledgerKinds(world.unsubmitted.id)).toEqual(["hold", "release"]);
  });

  test("they are keyed by the account: another account's statements cannot reach this one's jobs", async () => {
    const world = await seedWorld("scopetarget");
    const before = JSON.stringify(
      db().query("SELECT * FROM compute_jobs WHERE account_id = ?").all(world.target),
    );
    await fx.env().DB.batch(
      computeReleaseStatements(world.bystander).map((s) =>
        fx
          .env()
          .DB.prepare(s.sql)
          .bind(...s.binds),
      ),
    );
    expect(
      JSON.stringify(
        db().query("SELECT * FROM compute_jobs WHERE account_id = ?").all(world.target),
      ),
    ).toBe(before);
    expect(poolsOf(world.target).map((p) => p.frozen)).toEqual([0, 0]);
    expect(poolsOf(world.bystander).map((p) => p.frozen)).toEqual([1]);
  });

  test("they run no network call: the file imports no Tapis client and calls no fetch, and the function is synchronous", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(
      join(import.meta.dir, "../src/services/compute-release.ts"),
      "utf-8",
    );
    const code = source
      .split("\n")
      .filter(
        (l) =>
          !l.trim().startsWith("*") && !l.trim().startsWith("//") && !l.trim().startsWith("/*"),
      )
      .join("\n");
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toMatch(/from\s+["']\.\/tapis\//);
    expect(code).not.toMatch(/\bcancelJob\b|\bdriveCancel\b|\bsearchJobsByTag\b/);
    expect(computeReleaseStatements(7)).toBeInstanceOf(Array);
  });
});

// --- The same batch --------------------------------------------------------------------------------

describe("the compute statements are in the SAME batch as the credential revocations", () => {
  // `finalizeRevocation` orders its batch BEFORE the status write precisely so that a failure leaves
  // the account `approved` and a retry reaches the cascade again; a second batch for compute, after
  // the first, that failed would leave the account's sessions revoked and its compute live, and the
  // route's `User already revoked` would make that unrecoverable. So when ONE statement of the batch
  // aborts (here, the ledger refusing the release), NOTHING of the batch is written (sessions
  // included), and the retry ends both. Run on bun:sqlite and on Miniflare's D1, the engine `wrangler
  // --local` runs, whose batch is the transaction production relies on.
  interface Target {
    id: number;
    username: string;
    job: ComputeJobRow;
  }

  const engines = (): Array<{ name: string; env: Bindings }> => [
    { name: "bun:sqlite", env: fx.env({ ENVIRONMENT: "test", RESEND_API_KEY: "" }) },
    {
      name: "Miniflare D1",
      env: fx.env({
        DB: fx.harness.d1 as D1Database,
        ENVIRONMENT: "test",
        RESEND_API_KEY: "",
      }),
    },
  ];

  let counter = 0;

  /** An account with a live session and a job that never reached Tapis (a hold the cascade releases). */
  async function seedOn(env: Bindings): Promise<Target> {
    const username = `samebatch${++counter}${Math.floor(Math.random() * 1e6)}`;
    const id = await seedUser(env.DB, { username });
    // The platform budget of a database that is never reset (Miniflare's D1): generous, and added to.
    await fundPlatform(env.DB, "people", 1_000_000_000);
    await fundAccount(env.DB, id, 100_000, "cpu");
    const job = await jobFor(env, id);
    await issueSession(env, id, false, "test-agent", "127.0.0.1", "orcid");
    return { id, username, job };
  }

  const one = async <T>(env: Bindings, sql: string, ...binds: unknown[]): Promise<T> =>
    (await env.DB.prepare(sql)
      .bind(...binds)
      .first<T>()) as T;

  /** What an aborted batch must leave exactly as it was, and what a completed one ends. */
  async function observe(env: Bindings, t: Target) {
    return {
      liveSessions: (
        await one<{ n: number }>(
          env,
          "SELECT COUNT(*) AS n FROM web_sessions WHERE user_id = ? AND revoked_at IS NULL",
          t.id,
        )
      ).n,
      jobState: (
        await one<{ state: string }>(env, "SELECT state FROM compute_jobs WHERE id = ?", t.job.id)
      ).state,
      ledger: (
        await env.DB.prepare("SELECT kind FROM compute_ledger WHERE job_id = ? ORDER BY id")
          .bind(t.job.id)
          .all<{ kind: string }>()
      ).results.map((r) => r.kind),
      frozen: (
        await one<{ frozen: number }>(
          env,
          "SELECT frozen FROM compute_pools WHERE holder_kind = 'account' AND holder_ref = ?",
          String(t.id),
        )
      ).frozen,
      status: (await one<{ status: string }>(env, "SELECT status FROM users WHERE id = ?", t.id))
        .status,
      deleted: (
        await one<{ d: number }>(
          env,
          "SELECT deleted_at IS NOT NULL AS d FROM users WHERE id = ?",
          t.id,
        )
      ).d,
    };
  }

  const LIVE = {
    liveSessions: 1,
    jobState: "created",
    ledger: ["hold"],
    frozen: 0,
    status: "approved",
    deleted: 0,
  };

  /** The ledger refuses THIS job's release: the statement of the compute set that fails. */
  async function refuseRelease(env: Bindings, t: Target): Promise<string> {
    const name = `release_refused_${t.id}`;
    await env.DB.prepare(
      `CREATE TRIGGER ${name} BEFORE INSERT ON compute_ledger
         WHEN NEW.kind = 'release' AND NEW.job_id = '${t.job.id}'
       BEGIN SELECT RAISE(ABORT, 'test: the release is refused'); END`,
    ).run();
    return name;
  }

  async function call(env: Bindings, method: string, path: string): Promise<Response> {
    return app.request(path, { method, headers: { Authorization: `Bearer ${OWNER_KEY}` } }, env);
  }

  test("finalizeRevocation: a failing compute statement leaves the sessions AND the compute as they were, and the retry ends both (MUTATION: run the compute statements in a second batch)", async () => {
    for (const { name, env } of engines()) {
      const t = await seedOn(env);
      expect([name, await observe(env, t)]).toEqual([name, LIVE]);
      const trigger = await refuseRelease(env, t);

      const failed = await call(env, "POST", `/admin/revoke/${t.username}`);
      expect([name, failed.status >= 500]).toEqual([name, true]);
      // Nothing of the batch was written: not the session revoke that comes BEFORE the compute
      // statements in it, and not the pool freeze that comes after; the account is still approved, so
      // the retry reaches the cascade again.
      expect([name, await observe(env, t)]).toEqual([name, LIVE]);

      await env.DB.prepare(`DROP TRIGGER ${trigger}`).run();
      const retried = await call(env, "POST", `/admin/revoke/${t.username}`);
      expect([name, retried.status]).toEqual([name, 200]);
      expect([name, await observe(env, t)]).toEqual([
        name,
        {
          liveSessions: 0,
          jobState: "cancelled",
          ledger: ["hold", "release"],
          frozen: 1,
          status: "revoked",
          deleted: 0,
        },
      ]);
    }
  });

  test("tombstoneUserCascade: a failing compute statement leaves the mask, the sessions AND the compute as they were, and the retry ends all (MUTATION: run the compute statements in a second batch)", async () => {
    for (const { name, env } of engines()) {
      const t = await seedOn(env);
      expect([name, await observe(env, t)]).toEqual([name, LIVE]);
      const trigger = await refuseRelease(env, t);

      const failed = await call(env, "DELETE", `/admin/users/by-id/${t.id}`);
      expect([name, failed.status]).toEqual([name, 500]);
      expect([name, await observe(env, t)]).toEqual([name, LIVE]);

      await env.DB.prepare(`DROP TRIGGER ${trigger}`).run();
      const retried = await call(env, "DELETE", `/admin/users/by-id/${t.id}`);
      expect([name, retried.status]).toEqual([name, 200]);
      expect([name, await observe(env, t)]).toEqual([
        name,
        {
          liveSessions: 0,
          jobState: "cancelled",
          ledger: ["hold", "release"],
          frozen: 1,
          status: "revoked",
          deleted: 1,
        },
      ]);
    }
  });
});
