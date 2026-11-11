/**
 * The compute job lifecycle (epic #2005 phase A5, #2010; ADR 0118 and its amendments of 2026-11-04):
 * submit, advance, settle, verify, copy, cancel and the 30-minute tick, against the real migrations,
 * the real ledger, Miniflare's R2 through the Worker's own bindings, the real local S3 interface, and
 * the Tapis stand-in (a real HTTP server built from Tapis's published specifications; NO RESPONSE IN IT
 * WAS RECORDED FROM A REAL TENANT). The launcher is played by the test (`compute-lifecycle-fixture.ts`):
 * it decodes the launch specification value the Tapis stand-in RECEIVED (base64url, strictly, as the
 * launcher does) and hashes the TEXT, never the digest the Worker stored, so the digest check proves
 * something.
 *
 * What is pinned, each with a test of its own:
 *  - a job is submitted ONCE: the hold exists, the request names no archive field and asks Tapis not to
 *    archive the launch files, the owner is the NEMAR service identity from configuration, the launch
 *    specification (token and all) is in the one environment variable, as base64url text that a shell
 *    sources intact even for shell-active arguments, and nowhere in D1; the SHA-256 written to the row
 *    BEFORE the call is of the TEXT, not of the value; and a webhook is subscribed;
 *  - a submit whose answer was lost finds its job by tag and submits once (MUTATION: skip the tag
 *    search and the stand-in sees two submits); a rejection fails the job and releases the hold; an
 *    unavailable Tapis leaves it `created`; two jobs under one tag submit nothing and flag the job;
 *  - `advance` follows every Tapis status, refreshes on a self-edge and ignores an older one;
 *  - settlement: what the Tapis record says was used is charged (never above the hold, the excess an
 *    overrun entry and the overrun flag), a job that never started is RELEASED in full, NOTHING IS EVER
 *    REFUNDED, a platform failure is a flag and not a ledger write, and the `people` budget only grows;
 *  - concurrency: a webhook, a tick and a cancel applied together leave one final state and one charge
 *    entry, and replaying each changes nothing (MUTATION: drop `state = <from>`);
 *  - verification: a missing output, a size mismatch and a `launch_spec_digest` mismatch each end the
 *    job `failed` with `result_verification_failed`; a `FINISHED` job whose launcher never completed
 *    ends `result_upload_failed`; a `FAILED` job takes its code from a TRUSTED `result.json` only;
 *  - the records copy writes the launcher's files and `tapisjob.out`, finishes after a failure and
 *    never overwrites;
 *  - the tick (production only) submits, reads back, repairs, clears nonces and marks `unreported`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { RESULT_REFUSAL_DETAILS } from "../../shared/compute-state";
import {
  DEFAULT_COMPUTE_POLICY,
  RECORDS_RESULT_MANIFEST_FILE,
} from "../../shared/contract/compute";
import { ComputeJobViewSchema } from "../../shared/contract/compute-admin";
import {
  LaunchSpecSchema,
  decodeLaunchSpecEnv,
  encodeLaunchSpec,
  encodeLaunchSpecEnv,
  isShellInertEnvValue,
} from "../../shared/contract/compute-launch";
import { resultsLauncherKey, resultsOutputKey } from "../../shared/contract/compute-launch";
import {
  ADVANCE_ROWS_PER_TICK,
  cancellationsLogLine,
  computeAdvanceLogLine,
  runComputeAdvanceCron,
  sweepComputeCancellations,
} from "../src/services/compute-advance";
import type { ComputeJobRow } from "../src/services/compute-jobs";
import { releaseStatements, settleStatements } from "../src/services/compute-ledger";
import {
  SETTLEMENT_GATE_SQL,
  UNCOPIED_TERMINAL_SQL,
  advanceComputeJob,
  applyTapisJob,
  copyResultRecords,
  countCopyAbandoned,
  jobView,
  provisionalCharge,
  requestComputeCancel,
  sqliteTime,
  submitComputeJob,
} from "../src/services/compute-lifecycle";
import {
  logKey,
  outputsBodyLimitBytes,
  recordKey,
  sha256Hex,
} from "../src/services/compute-records";
import { verifyComputeToken } from "../src/services/compute-tokens";
import { submitJob } from "../src/services/tapis/client";
import type { Bindings } from "../src/types/bindings";
import {
  CALLBACK_SECRET,
  type LifecycleFixture,
  MINUTE,
  type MadeJob,
  RUNTIME_IMAGE,
  RUNTIME_IMAGE_DIGEST,
  iso,
  jobTokenSeenByTapis,
  launchSpecEnvSeenByTapis,
  launchSpecTextSeenByTapis,
  makeJob,
  playLauncher,
  reread,
  setPolicy,
  setTapisTimes,
  startLifecycleFixture,
} from "./helpers/compute-lifecycle-fixture";
import { roundTripD1, seedUser } from "./helpers/compute-seed";
import { launchSecretForms } from "./helpers/launch-secret-forms";
import { logged } from "./helpers/logs";
import { makeSandbox, sourceLaunchFile } from "./helpers/scheduler-launch-file";

let fx: LifecycleFixture;
/** An owner of the Miniflare D1, which is never reset. */
let miniflareOwner = 0;

beforeAll(async () => {
  fx = await startLifecycleFixture({ withD1: true });
  miniflareOwner = await seedUser(fx.harness.d1 as D1Database, { role: "owner" });
}, 120_000);

beforeEach(async () => {
  await fx.reset();
}, 60_000);

afterAll(async () => {
  await fx?.dispose();
}, 60_000);

// --- Helpers of this file ------------------------------------------------------------------------

interface Ledger {
  kind: string;
  held: number;
  charged: number;
  reason: string | null;
}

async function ledgerOf(env: Bindings, jobId: string): Promise<Ledger[]> {
  return (
    await env.DB.prepare(
      `SELECT kind, held_delta_milli AS held, charged_delta_milli AS charged, reason
         FROM compute_ledger WHERE job_id = ?1 ORDER BY id`,
    )
      .bind(jobId)
      .all<Ledger>()
  ).results;
}

const kinds = (entries: Ledger[]) => entries.map((e) => e.kind);

async function poolOf(env: Bindings, accountId: number) {
  return (await env.DB.prepare(
    `SELECT granted_milli, held_milli, charged_milli FROM compute_pools
      WHERE holder_kind = 'account' AND holder_ref = ?1 AND pool = 'cpu'`,
  )
    .bind(String(accountId))
    .first()) as { granted_milli: number; held_milli: number; charged_milli: number };
}

async function peopleBudget(env: Bindings) {
  return (await env.DB.prepare(
    `SELECT held_milli, charged_milli FROM compute_pools
      WHERE holder_kind = 'platform' AND holder_ref = 'people' AND pool = 'cpu'`,
  ).first()) as { held_milli: number; charged_milli: number };
}

function submits(): number {
  return fx.tapis.log.filter((r) => r.route === "POST /v3/jobs/submit").length;
}

/** A job made and submitted: the row is bound to a Tapis job at status PENDING. */
async function submittedJob(
  over: Parameters<typeof makeJob>[1] = {},
): Promise<{ made: MadeJob; uuid: string; env: Bindings }> {
  const made = await makeJob(fx, over);
  const result = await submitComputeJob(made.env, made.job.id);
  expect(result).toEqual({ ok: true, outcome: "submitted" });
  const job = await reread(made.env, made.job.id);
  return { made: { ...made, job }, uuid: job.tapis_uuid as string, env: made.env };
}

/** Move the Tapis job and let the Worker read it back, as the tick and the webhook both do. */
async function drive(env: Bindings, jobId: string, uuid: string, status: string, cond?: string) {
  fx.tapis.advance(uuid, status, cond);
  return advanceComputeJob(env, jobId);
}

/** The exit code Tapis reports for the job (UNVERIFIED against a real tenant: `remoteResultInfo`). */
function setTapisExit(uuid: string, exit: number) {
  const record = fx.tapis.jobs.get(uuid)?.record;
  if (record) record.remoteResultInfo = String(exit);
}

/** Run a job to Tapis `FINISHED` with a launcher that did what the plan says, `usedMs` of run time. */
async function finishJob(
  s: { made: MadeJob; uuid: string; env: Bindings },
  plan: Parameters<typeof playLauncher>[4] = {},
  usedMs = 30 * MINUTE,
) {
  await drive(s.env, s.made.job.id, s.uuid, "RUNNING");
  await drive(s.env, s.made.job.id, s.uuid, "ARCHIVING");
  await playLauncher(fx, s.env, await reread(s.env, s.made.job.id), s.uuid, plan);
  fx.tapis.advance(s.uuid, "FINISHED");
  setTapisTimes(fx, s.uuid, usedMs, 0);
  setTapisExit(s.uuid, plan.exitNumber ?? 0);
  return advanceComputeJob(s.env, s.made.job.id);
}

// --- Submit --------------------------------------------------------------------------------------

describe("submit", () => {
  test("a job is submitted once: no archive fields, NEMAR's identity, the specification in one variable, a webhook", async () => {
    const made = await makeJob(fx);
    expect((await ledgerOf(made.env, made.job.id)).map((e) => e.kind)).toEqual(["hold"]);

    const result = await submitComputeJob(made.env, made.job.id);
    expect(result).toEqual({ ok: true, outcome: "submitted" });
    expect(submits()).toBe(1);

    const job = await reread(made.env, made.job.id);
    expect(job.state).toBe("submitted");
    expect(job.tapis_status).toBe("PENDING");
    expect(job.submitted_at).not.toBeNull();
    expect(job.tapis_uuid).toMatch(/^[A-Za-z0-9-]+$/);

    const request = fx.tapis.log.find((r) => r.route === "POST /v3/jobs/submit");
    const body = JSON.parse(request?.body ?? "{}");
    for (const key of ["archiveSystemId", "archiveSystemDir", "archiveMode", "archiveOnAppError"]) {
      expect(body).not.toHaveProperty(key);
    }
    expect(body.parameterSet.archiveFilter).toEqual({ includeLaunchFiles: false });
    // The Tapis owner is the NEMAR service identity of the configuration, not a person.
    expect(body.owner).toBe(fx.tapis.username);
    expect(body.tags).toEqual([`nemar_job:${job.id}`]);
    expect(body.execSystemLogicalQueue).toBe("shared");
    expect(body.coresPerNode).toBe(4);
    expect(body.maxMinutes).toBe(60);
    expect(body.parameterSet.envVariables).toHaveLength(1);
    expect(body.parameterSet.envVariables[0].key).toBe("NEMAR_LAUNCH_SPEC");
    // The value is shell-inert: base64url text, nothing a shell or a conditional quoter acts on (A1c).
    const value = body.parameterSet.envVariables[0].value as string;
    expect(isShellInertEnvValue(value)).toBe(true);
    expect(value.startsWith("{")).toBe(false);
    expect(value).toBe(launchSpecEnvSeenByTapis(fx, job.tapis_uuid as string));

    // The launch specification the launcher will read: what it decodes the value to.
    const text = launchSpecTextSeenByTapis(fx, job.tapis_uuid as string);
    const spec = LaunchSpecSchema.parse(JSON.parse(text));
    expect(spec.job_id).toBe(job.id);
    expect(spec.datasets).toEqual([{ id: "nm000104", version: "v1.0.2" }]);
    expect(spec.image).toEqual({
      uri: RUNTIME_IMAGE,
      digest: RUNTIME_IMAGE_DIGEST,
      sif: `${"b".repeat(64)}.sif`,
    });
    expect(spec.command).toEqual(["analyse", "--fast"]);
    expect(spec.resources).toEqual({ gpus: 0 });
    expect(spec.api_base).toBe("http://127.0.0.1:9");
    // Its text is exactly what `encodeLaunchSpec` writes, the value is that text in base64url, and the
    // digest the row holds is of the TEXT the launcher decodes: never of the value that was sent.
    expect(text).toBe(encodeLaunchSpec(spec));
    expect(value).toBe(encodeLaunchSpecEnv(text));
    expect(job.launch_spec_digest).toBe(await sha256Hex(new TextEncoder().encode(text)));
    expect(job.launch_spec_digest).not.toBe(await sha256Hex(new TextEncoder().encode(value)));
    // The job's runtime image is recorded, because it is what ran.
    expect(job.image_digest).toBe(RUNTIME_IMAGE_DIGEST);

    // The token is the compute-job HMAC of the job and its nonce, and nothing else answers for it.
    expect(
      await verifyComputeToken(
        "job",
        spec.job_token,
        { jobId: job.id, nonce: job.webhook_nonce as string },
        CALLBACK_SECRET,
      ),
    ).toBe(true);
    expect(
      await verifyComputeToken(
        "webhook",
        spec.job_token,
        { jobId: job.id, nonce: job.webhook_nonce as string },
        CALLBACK_SECRET,
      ),
    ).toBe(false);

    // The specification and its token are NOWHERE in the database.
    const everything = JSON.stringify({
      jobs: (await made.env.DB.prepare("SELECT * FROM compute_jobs").all()).results,
      ledger: (await made.env.DB.prepare("SELECT * FROM compute_ledger").all()).results,
      audit: (await made.env.DB.prepare("SELECT * FROM audit_log").all()).results,
    });
    // Every form of the token: the plain token, the whole encoded value, and the token's base64url text
    // at each alignment (the plain token is no longer a substring of the value, nor of a slice of it).
    launchSecretForms(spec.job_token, value).forEach((form, i) => {
      expect(everything.includes(form), `form ${i} of the token`).toBe(false);
    });
    expect(everything).not.toContain("NEMAR_LAUNCH_SPEC");

    // One webhook subscription, carrying a token that is a different kind from the job's.
    expect(fx.tapis.subscriptions).toHaveLength(1);
    const address = fx.tapis.subscriptions[0]?.address ?? "";
    expect(address).toMatch(
      new RegExp(`^http://127\\.0\\.0\\.1:9/webhooks/tapis/${job.id}/[0-9a-f]{64}$`),
    );
    expect(address).not.toContain(spec.job_token);
    expect(fx.tapis.subscriptions[0]?.eventCategoryFilter).toBe("JOB_NEW_STATUS");
  });

  test("a second submit of a bound job is a no-op", async () => {
    const s = await submittedJob();
    expect(await submitComputeJob(s.env, s.made.job.id)).toEqual({
      ok: true,
      outcome: "already_submitted",
    });
    expect(submits()).toBe(1);
    expect(fx.tapis.subscriptions).toHaveLength(1);
  });

  test("the switch is read here and nowhere else: exactly production or development, exactly 1", async () => {
    const made = await makeJob(fx);
    for (const env of [
      fx.env({ COMPUTE_ENABLED: undefined }),
      fx.env({ COMPUTE_ENABLED: "true" }),
      fx.env({ COMPUTE_ENABLED: " 1" }),
      fx.env({ ENVIRONMENT: "staging" }),
    ]) {
      expect(await submitComputeJob({ ...env, DB: made.env.DB } as Bindings, made.job.id)).toEqual({
        ok: false,
        outcome: "compute_disabled",
      });
    }
    // The switch guards the call that CREATES something at Tapis: the tag search (which is how a job
    // whose answer was lost is found, and how a `created` row reaches `submit_timeout`) is made, and
    // nothing was submitted. The row is as it was.
    expect(fx.tapis.log.filter((r) => r.route === "POST /v3/jobs/submit")).toHaveLength(0);
    expect(fx.tapis.jobs.size).toBe(0);
    expect((await reread(made.env, made.job.id)).state).toBe("created");
    // Development is allowed.
    expect(
      (
        await submitComputeJob(
          { ...fx.env({ ENVIRONMENT: "development" }), DB: made.env.DB } as Bindings,
          made.job.id,
        )
      ).ok,
    ).toBe(true);
  });

  test("a job whose records are not written is not submitted", async () => {
    const made = await makeJob(fx);
    await made.env.DB.prepare("UPDATE compute_jobs SET records_written_at = NULL WHERE id = ?")
      .bind(made.job.id)
      .run();
    expect(await submitComputeJob(made.env, made.job.id)).toEqual({
      ok: false,
      outcome: "records_not_written",
    });
    expect(fx.tapis.log).toHaveLength(0);
  });

  test("a partner's job, a missing job and a job past `created` are never submitted", async () => {
    const made = await makeJob(fx);
    expect(await submitComputeJob(made.env, "job_000000000000000000000000")).toEqual({
      ok: false,
      outcome: "job_not_found",
    });
    await made.env.DB.prepare(
      "UPDATE compute_jobs SET source = 'partner', client_id = 'c1' WHERE id = ?",
    )
      .bind(made.job.id)
      .run();
    expect(await submitComputeJob(made.env, made.job.id)).toEqual({
      ok: false,
      outcome: "bad_state",
    });
    await made.env.DB.prepare(
      "UPDATE compute_jobs SET source = 'cli', client_id = NULL, state = 'running' WHERE id = ?",
    )
      .bind(made.job.id)
      .run();
    expect(await submitComputeJob(made.env, made.job.id)).toEqual({
      ok: false,
      outcome: "bad_state",
    });
    expect(fx.tapis.log).toHaveLength(0);
  });

  test("a submit whose answer was lost finds the job by tag and submits ONCE", async () => {
    const made = await makeJob(fx);
    fx.proxy.loseSubmitAnswers(1);
    expect(await submitComputeJob(made.env, made.job.id)).toEqual({
      ok: false,
      outcome: "unavailable",
    });
    // The stand-in acted on it, the Worker never heard, and the row says nothing happened.
    expect(fx.tapis.jobs.size).toBe(1);
    expect((await reread(made.env, made.job.id)).state).toBe("created");
    const stored = (await reread(made.env, made.job.id)).launch_spec_digest;
    expect(stored).not.toBeNull();

    expect(await submitComputeJob(made.env, made.job.id)).toEqual({ ok: true, outcome: "bound" });
    expect(submits()).toBe(1);
    expect(fx.tapis.log.some((r) => r.route === "POST /v3/jobs/search")).toBe(true);
    const job = await reread(made.env, made.job.id);
    expect(job.state).toBe("submitted");
    expect(job.tapis_uuid).toBe([...fx.tapis.jobs.keys()][0] as string);
    // A job found by tag keeps the digest stored before the first submit: it is the one the launcher hashes.
    expect(job.launch_spec_digest).toBe(stored as string);
    expect(job.launch_spec_digest).toBe(
      await sha256Hex(
        new TextEncoder().encode(launchSpecTextSeenByTapis(fx, job.tapis_uuid as string)),
      ),
    );
  });

  test("a job with shell-active arguments is sent as a value a shell sources back intact, and nothing it holds runs (A1c)", async () => {
    // The scheduler is read as writing the value into a file a shell sources, quoting it only
    // conditionally (`scheduler-launch-file.ts`; unverified). Every string below is inert: a command,
    // if it ran, only makes a file in a fresh directory, which is listed afterwards.
    const sandbox = makeSandbox();
    try {
      const args = [
        "a b",
        `$(touch ${sandbox.sentinel})`,
        `$(touch ${sandbox.relativeSentinel})`,
        `\`touch ${sandbox.sentinel}\``,
        'say "hi"',
        "C:\\dir\\file",
        "a;b&c|d<e>f",
        "line1\nline2",
        "$HOME ${PATH} $$",
        "~ * ? [a-z] ! #",
        "caf\u00e9 \u{1F600}",
      ];
      const made = await makeJob(fx, { spec: { args } });
      expect(await submitComputeJob(made.env, made.job.id)).toEqual({
        ok: true,
        outcome: "submitted",
      });
      const job = await reread(made.env, made.job.id);
      const uuid = job.tapis_uuid as string;

      // What Tapis received, put through the scheduler's quoting and a real shell.
      const value = launchSpecEnvSeenByTapis(fx, uuid);
      const sourced = sourceLaunchFile(value, sandbox);
      expect(sourced.intact).toBe(true);
      expect(sourced.made).toEqual([]);

      // And what the launcher then does with it: decode, hash the text, parse. The arguments are intact.
      const decoded = decodeLaunchSpecEnv(sourced.seen);
      expect(decoded.ok).toBe(true);
      const text = decoded.ok ? decoded.text : "";
      expect(LaunchSpecSchema.parse(JSON.parse(text)).args).toEqual(args);
      expect(job.launch_spec_digest).toBe(await sha256Hex(new TextEncoder().encode(text)));
    } finally {
      sandbox.remove();
    }
  });

  test("a retry that finds nothing rebuilds the specification and overwrites the digest before it submits", async () => {
    const made = await makeJob(fx);
    fx.tapis.fail("POST /v3/jobs/submit", 503);
    expect((await submitComputeJob(made.env, made.job.id)).outcome).toBe("unavailable");
    const first = (await reread(made.env, made.job.id)).launch_spec_digest;
    expect(first).not.toBeNull();
    expect(fx.tapis.jobs.size).toBe(0);

    const other = `ghcr.io/example/nemar-python@sha256:${"c".repeat(64)}`;
    const env = { ...fx.env({ COMPUTE_RUNTIME_IMAGE: other }), DB: made.env.DB } as Bindings;
    expect(await submitComputeJob(env, made.job.id)).toEqual({ ok: true, outcome: "submitted" });
    const job = await reread(made.env, made.job.id);
    expect(job.launch_spec_digest).not.toBe(first);
    expect(job.launch_spec_digest).toBe(
      await sha256Hex(
        new TextEncoder().encode(launchSpecTextSeenByTapis(fx, job.tapis_uuid as string)),
      ),
    );
    expect(job.image_digest).toBe(`sha256:${"c".repeat(64)}`);
  });

  test("the digest is written BEFORE the call: it is there when Tapis was never reached", async () => {
    const made = await makeJob(fx);
    fx.tapis.down();
    expect((await submitComputeJob(made.env, made.job.id)).outcome).toBe("unavailable");
    fx.tapis.up();
    expect((await reread(made.env, made.job.id)).launch_spec_digest).toBeNull();
    fx.tapis.fail("POST /v3/jobs/submit", 503);
    expect((await submitComputeJob(made.env, made.job.id)).outcome).toBe("unavailable");
    expect((await reread(made.env, made.job.id)).launch_spec_digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a rejection fails the job `tapis_submit_failed` and releases the hold: nothing is refunded or charged", async () => {
    const made = await makeJob(fx);
    fx.tapis.fail("POST /v3/jobs/submit", 400);
    expect(await submitComputeJob(made.env, made.job.id)).toEqual({ ok: false, outcome: "failed" });
    const job = await reread(made.env, made.job.id);
    expect(job.state).toBe("failed");
    expect(job.failure_code).toBe("tapis_submit_failed");
    expect(job.platform_failure).toBe(1);
    expect(job.settled_provisional_at).not.toBeNull();
    expect(job.charged_milli).toBe(0);
    expect(job.retention_until).not.toBeNull();
    expect(kinds(await ledgerOf(made.env, job.id))).toEqual(["hold", "release"]);
    const pool = await poolOf(made.env, made.accountId);
    expect(pool.held_milli).toBe(0);
    expect(pool.charged_milli).toBe(0);
    expect((await peopleBudget(made.env)).held_milli).toBe(0);
  });

  test("a proxy's 408 or 302 on the submit is NOT a rejection: the job stays `created` with its hold, and the 400 beside it still ends it (MUTATION: map 408 and 3xx to rejected)", async () => {
    for (const status of [408, 302]) {
      const made = await makeJob(fx);
      fx.tapis.fail("POST /v3/jobs/submit", status);
      expect((await submitComputeJob(made.env, made.job.id)).outcome).toBe("unavailable");
      const job = await reread(made.env, made.job.id);
      expect([status, job.state, job.failure_code]).toEqual([status, "created", null]);
      expect(kinds(await ledgerOf(made.env, job.id))).toEqual(["hold"]);
    }
    for (const status of [400, 405, 409]) {
      const made = await makeJob(fx);
      fx.tapis.fail("POST /v3/jobs/submit", status);
      expect(await submitComputeJob(made.env, made.job.id)).toEqual({
        ok: false,
        outcome: "failed",
      });
    }
  });

  test("an unavailable Tapis leaves the job `created` and the ledger as it was", async () => {
    const made = await makeJob(fx);
    fx.tapis.fail("POST /v3/jobs/submit", 503);
    expect((await submitComputeJob(made.env, made.job.id)).outcome).toBe("unavailable");
    expect((await reread(made.env, made.job.id)).state).toBe("created");
    expect(kinds(await ledgerOf(made.env, made.job.id))).toEqual(["hold"]);
    expect(await submitComputeJob(made.env, made.job.id)).toEqual({
      ok: true,
      outcome: "submitted",
    });
  });

  test("a refused credential leaves the job `created` (it is not the job's fault)", async () => {
    const made = await makeJob(fx);
    fx.tapis.rejectAllTokens(true);
    expect((await submitComputeJob(made.env, made.job.id)).ok).toBe(false);
    expect((await reread(made.env, made.job.id)).state).toBe("created");
    fx.tapis.rejectAllTokens(false);
    expect((await submitComputeJob(made.env, made.job.id)).ok).toBe(true);
  });

  test("two Tapis jobs under one tag: nothing is submitted, nothing is bound, the job is flagged", async () => {
    const made = await makeJob(fx);
    const tag = `nemar_job:${made.job.id}`;
    const ctx = { env: fx.env(), owner: fx.tapis.username };
    const input = {
      jobId: made.job.id,
      appId: "nemar-launch",
      appVersion: "1.0.0",
      partition: "shared" as const,
      nodes: 1,
      coresPerNode: 1,
      gpus: 0,
      minutes: 5,
      launchSpecEnv: encodeLaunchSpecEnv("x"),
    };
    await submitJob(ctx, input);
    await submitJob(ctx, input);
    expect(submits()).toBe(2);
    expect(tag).toContain(made.job.id);
    expect(await submitComputeJob(made.env, made.job.id)).toEqual({
      ok: false,
      outcome: "ambiguous",
    });
    expect(submits()).toBe(2);
    const job = await reread(made.env, made.job.id);
    expect(job.state).toBe("created");
    expect(job.tapis_uuid).toBeNull();
    expect(job.flag_mismatch).toBe(1);
  });

  test("a job found by tag that is already running is caught up", async () => {
    const made = await makeJob(fx);
    const ctx = { env: fx.env(), owner: fx.tapis.username };
    const rec = await submitJob(ctx, {
      jobId: made.job.id,
      appId: "nemar-launch",
      appVersion: "1.0.0",
      partition: "shared",
      nodes: 1,
      coresPerNode: 4,
      gpus: 0,
      minutes: 60,
      launchSpecEnv: encodeLaunchSpecEnv("x"),
    });
    fx.tapis.advance(rec.uuid, "RUNNING");
    expect(await submitComputeJob(made.env, made.job.id)).toEqual({ ok: true, outcome: "bound" });
    const job = await reread(made.env, made.job.id);
    expect(job.state).toBe("running");
    expect(job.tapis_uuid).toBe(rec.uuid);
    expect(job.started_at).not.toBeNull();
    // Nothing was submitted by the Worker: the one job was the test's.
    expect(submits()).toBe(1);
  });

  test("a `created` row past the reservation wait with nothing at Tapis fails `submit_timeout` and is released", async () => {
    const made = await makeJob(fx);
    await setPolicy(made.env.DB, fx.ownerId, { reservationWaitMinutes: 30 });
    await made.env.DB.prepare(
      "UPDATE compute_jobs SET created_at = datetime('now', '-2 hours') WHERE id = ?",
    )
      .bind(made.job.id)
      .run();
    expect(await submitComputeJob(made.env, made.job.id)).toEqual({ ok: false, outcome: "failed" });
    const job = await reread(made.env, made.job.id);
    expect(job.state).toBe("failed");
    expect(job.failure_code).toBe("submit_timeout");
    expect(kinds(await ledgerOf(made.env, job.id))).toEqual(["hold", "release"]);
    expect(submits()).toBe(0);
  });

  test("past the wait, a job Tapis DOES hold is bound, not timed out", async () => {
    const made = await makeJob(fx);
    fx.proxy.loseSubmitAnswers(1);
    expect((await submitComputeJob(made.env, made.job.id)).outcome).toBe("unavailable");
    await made.env.DB.prepare(
      "UPDATE compute_jobs SET created_at = datetime('now', '-2 hours') WHERE id = ?",
    )
      .bind(made.job.id)
      .run();
    expect(await submitComputeJob(made.env, made.job.id)).toEqual({ ok: true, outcome: "bound" });
    expect((await reread(made.env, made.job.id)).state).toBe("submitted");
    expect(submits()).toBe(1);
  });

  test("a job that cannot be launched (a recipe job names no entry or command) is failed, not stranded", async () => {
    const made = await makeJob(fx, { spec: { command: undefined, recipe: "nemar-floor" } });
    expect(await submitComputeJob(made.env, made.job.id)).toEqual({ ok: false, outcome: "failed" });
    const job = await reread(made.env, made.job.id);
    expect(job.state).toBe("failed");
    expect(job.failure_code).toBe("tapis_submit_failed");
    expect(job.failure_detail).toBe("invalid_spec");
    expect(kinds(await ledgerOf(made.env, job.id))).toEqual(["hold", "release"]);
    expect(submits()).toBe(0);
  });

  // Round 1 of #2041: the variable is ONE digest-pinned reference, validated when it is read. A value
  // that is not one (unset, blank, a tag, a short digest, upper case, junk after the digest) is never
  // launched: the job stays `created`, exactly as when it is unset.
  test("an unset or invalid runtime image keeps a python job `created` until it is a digest-pinned reference", async () => {
    const hex = "e".repeat(64);
    const unusable: Array<string | undefined> = [
      undefined,
      "",
      "   ",
      "ghcr.io/example/nemar-python:latest",
      `ghcr.io/example/nemar-python@sha256:${"e".repeat(63)}`,
      `ghcr.io/example/nemar-python@sha256:${hex}\nextra`,
      `ghcr.io/example/nemar-python@sha256:${hex} extra`,
      `GHCR.io/example/nemar-python@sha256:${hex}`,
      `ghcr.io/example/nemar-python@sha256:${"E".repeat(64)}`,
      `{"uri":"ghcr.io/example/nemar-python@sha256:${hex}"}`,
    ];
    for (const value of unusable) {
      const made = await makeJob(fx);
      expect([
        value,
        await submitComputeJob(
          { ...fx.env({ COMPUTE_RUNTIME_IMAGE: value }), DB: made.env.DB } as Bindings,
          made.job.id,
        ),
      ]).toEqual([value, { ok: false, outcome: "unconfigured" }]);
      expect([value, (await reread(made.env, made.job.id)).state]).toEqual([value, "created"]);
    }
    expect(submits()).toBe(0);
  });

  test("a python job's launch specification carries the configured reference, its digest and the Singularity file named for that digest", async () => {
    const hex = "9".repeat(64);
    const made = await makeJob(fx);
    // Padding around the value is not part of it.
    const env = {
      ...fx.env({
        COMPUTE_RUNTIME_IMAGE: `  docker://ghcr.io/example/nemar-python@sha256:${hex}\n`,
      }),
      DB: made.env.DB,
    } as Bindings;
    expect(await submitComputeJob(env, made.job.id)).toEqual({ ok: true, outcome: "submitted" });
    const job = await reread(made.env, made.job.id);
    const spec = LaunchSpecSchema.parse(
      JSON.parse(launchSpecTextSeenByTapis(fx, job.tapis_uuid as string)),
    );
    // Written out, not computed with the contract's own function.
    expect(spec.image).toEqual({
      uri: `docker://ghcr.io/example/nemar-python@sha256:${hex}`,
      digest: `sha256:${hex}`,
      sif: `${hex}.sif`,
    });
    expect(job.image_digest).toBe(`sha256:${hex}`);
  });

  test("an image job brings its own image, and the Singularity file is named for its digest", async () => {
    const digest = `sha256:${"d".repeat(64)}`;
    const image = `ghcr.io/example/own@${digest}`;
    const made = await makeJob(fx, {
      spec: { runtime: "image", image, command: ["tool", "--in", "/data"], datasets: [] },
    });
    expect(await submitComputeJob(made.env, made.job.id)).toEqual({
      ok: true,
      outcome: "submitted",
    });
    const job = await reread(made.env, made.job.id);
    const spec = LaunchSpecSchema.parse(
      JSON.parse(launchSpecTextSeenByTapis(fx, job.tapis_uuid as string)),
    );
    expect(spec.runtime).toBe("image");
    expect(spec.image).toEqual({ uri: image, digest, sif: `${"d".repeat(64)}.sif` });
    expect(job.image_digest).toBe(digest);
  });
});

// --- Advance -------------------------------------------------------------------------------------

describe("advance", () => {
  test("a job follows every Tapis status, and the Slurm id and times appear when Tapis shows them", async () => {
    const s = await submittedJob();
    const id = s.made.job.id;
    const expected: Array<[string, string]> = [
      ["PROCESSING_INPUTS", "submitted"],
      ["STAGING_INPUTS", "submitted"],
      ["STAGING_JOB", "submitted"],
      ["SUBMITTING_JOB", "submitted"],
      ["BLOCKED", "submitted"],
      ["PAUSED", "submitted"],
      ["QUEUED", "queued"],
      ["RUNNING", "running"],
      ["ARCHIVING", "archiving"],
    ];
    for (const [status, state] of expected) {
      const answer = await drive(s.env, id, s.uuid, status);
      const job = await reread(s.env, id);
      expect([status, job.state, job.tapis_status]).toEqual([status, state, status]);
      expect(answer.outcome === "advanced" || answer.outcome === "refreshed").toBe(true);
    }
    const job = await reread(s.env, id);
    expect(job.slurm_job_id).toMatch(/^[0-9a-f]{32}$/);
    expect(job.remote_submitted_at).not.toBeNull();
    expect(job.started_at).not.toBeNull();
    expect(job.tapis_synced_at).not.toBeNull();
    expect(job.ended_at).toBeNull();
    // Nothing is settled while the job is live: the hold is all there is.
    expect(kinds(await ledgerOf(s.env, id))).toEqual(["hold"]);
  });

  test("a self-edge refreshes the record and an older status is ignored", async () => {
    const s = await submittedJob();
    const id = s.made.job.id;
    await drive(s.env, id, s.uuid, "RUNNING");
    const first = await reread(s.env, id);
    const again = await advanceComputeJob(s.env, id);
    expect(again.outcome).toBe("refreshed");
    // An older record applied after a newer one changes nothing.
    const stale = { ...(fx.tapis.jobs.get(s.uuid)?.record as object), status: "QUEUED" } as never;
    await drive(s.env, id, s.uuid, "ARCHIVING");
    const archiving = await reread(s.env, id);
    const result = await applyTapisJob(s.env, archiving, stale);
    expect(result).toMatchObject({ changed: false, outcome: "stale" });
    expect((await reread(s.env, id)).state).toBe("archiving");
    expect(first.state).toBe("running");
  });

  test("an unknown status and a record of another job change nothing", async () => {
    const s = await submittedJob();
    const job = await reread(s.env, s.made.job.id);
    const record = fx.tapis.jobs.get(s.uuid)?.record as object;
    expect(
      (await applyTapisJob(s.env, job, { ...record, status: "WHATEVER" } as never)).outcome,
    ).toBe("unknown_status");
    expect(
      (await applyTapisJob(s.env, job, { ...record, uuid: "another-job-007" } as never)).outcome,
    ).toBe("record_mismatch");
    expect((await reread(s.env, s.made.job.id)).state).toBe("submitted");
  });

  test("a status Tapis reports that NEMAR does not know freezes nothing: the tick counts it, logs the shortened word, and after a day the job is `unreported` (MUTATION: leave the job live without a mark)", async () => {
    const s = await submittedJob();
    const id = s.made.job.id;
    await drive(s.env, id, s.uuid, "RUNNING");
    const stored = fx.tapis.jobs.get(s.uuid);
    if (!stored) throw new Error("no tapis job");
    // A word from the future, with characters a log line must not carry.
    const strange = `NEW-STATUS 9!_${"X".repeat(40)}`;
    stored.status = strange;
    stored.record.status = strange;
    // Read less than a day ago: counted and warned, but not yet marked.
    let tick = null as Awaited<ReturnType<typeof runComputeAdvanceCron>>;
    const lines = await logged(async () => {
      tick = await runComputeAdvanceCron(s.env);
    });
    expect(tick).toMatchObject({ examined: 1, unknown_status: 1, advanced: 0, errors: [] });
    expect((await reread(s.env, id)).state).toBe("running");
    const warned = lines.find((l) => l.includes("unknown_status"));
    expect(warned).toBeDefined();
    expect(warned).not.toContain(id);
    // Stripped to letters and underscores first, then cut to 32.
    expect(warned?.split("status=")[1]).toBe(`NEWSTATUS_${"X".repeat(22)}`);
    expect((tick ? computeAdvanceLogLine(tick) : null)?.line).toContain("unknown_status=1");
    // The last good read ages past the day: the job is `unreported`, and a person is told by the state.
    await s.env.DB.prepare(
      "UPDATE compute_jobs SET tapis_synced_at = datetime('now', '-25 hours') WHERE id = ?",
    )
      .bind(id)
      .run();
    await runComputeAdvanceCron(s.env);
    expect((await reread(s.env, id)).state).toBe("unreported");
    // Tapis speaks a known word again: the job returns.
    stored.status = "RUNNING";
    stored.record.status = "RUNNING";
    await runComputeAdvanceCron(s.env);
    expect((await reread(s.env, id)).state).toBe("running");
  });

  test("a read-back is one attempt with a short ceiling: a down Tapis is answered fast, not after retries", async () => {
    const s = await submittedJob();
    fx.tapis.down();
    const started = Date.now();
    const answer = await advanceComputeJob(s.env, s.made.job.id);
    expect(answer.outcome).toBe("unreachable");
    expect(Date.now() - started).toBeLessThan(5_000);
    fx.tapis.up();
    // The stand-in saw at most one try of the job read per call (down means it saw none).
    expect(fx.tapis.log.filter((r) => r.route === "GET /v3/jobs/:uuid").length).toBeLessThanOrEqual(
      1,
    );
  });

  test("the first sight of a Slurm id writes the id once, and the report ACCESS is owed is made in the same batch", async () => {
    const s = await submittedJob();
    await drive(s.env, s.made.job.id, s.uuid, "QUEUED");
    const job = await reread(s.env, s.made.job.id);
    expect(job.slurm_job_id).not.toBeNull();
    const id = job.slurm_job_id;
    await advanceComputeJob(s.env, s.made.job.id);
    expect((await reread(s.env, s.made.job.id)).slurm_job_id).toBe(id);
    // Phase A8 (#2013): one pending report row, and none added by the read that followed
    // (`compute-access-reports.test.ts` pins both writers and the mutations).
    const reports = await s.env.DB.prepare(
      "SELECT state FROM compute_access_reports WHERE job_id = ?1",
    )
      .bind(s.made.job.id)
      .all<{ state: string }>();
    expect(reports.results).toEqual([{ state: "pending" }]);
  });
});

// --- Settlement ----------------------------------------------------------------------------------

describe("settlement", () => {
  test("a finished job is charged what the Tapis record says it used, and the rest of the hold is returned", async () => {
    const s = await submittedJob();
    const id = s.made.job.id;
    const answer = await finishJob(s, {}, 30 * MINUTE);
    expect(answer.outcome).toBe("terminal_committed");
    const job = await reread(s.env, id);
    expect(job.state).toBe("finished");
    // Four cores for 30 minutes is 2 SU, of the 4 SU held.
    expect(job.charged_milli).toBe(2000);
    expect(job.held_milli).toBe(4000);
    expect(job.settled_provisional_at).not.toBeNull();
    expect(job.flag_overrun).toBe(0);
    expect(job.platform_failure).toBe(0);
    expect(job.failure_code).toBeNull();
    expect(job.results_verified_at).not.toBeNull();
    expect(job.ended_at).not.toBeNull();
    expect(job.retention_until).not.toBeNull();
    const entries = await ledgerOf(s.env, id);
    expect(kinds(entries)).toEqual(["hold", "charge"]);
    expect(entries[1]).toMatchObject({ held: -4000, charged: 2000 });
    const pool = await poolOf(s.env, s.made.accountId);
    expect(pool).toMatchObject({ held_milli: 0, charged_milli: 2000 });
    // The people budget records consumption: it moved by the charge, and nothing credited it back.
    expect((await peopleBudget(s.env)).charged_milli).toBe(2000);
  });

  test("a job that used MORE than its hold is charged the hold plus an overrun entry, and is flagged", async () => {
    const s = await submittedJob();
    const id = s.made.job.id;
    await finishJob(s, {}, 3 * 60 * MINUTE);
    const job = await reread(s.env, id);
    expect(job.state).toBe("finished");
    expect(job.charged_milli).toBe(12_000);
    expect(job.flag_overrun).toBe(1);
    const entries = await ledgerOf(s.env, id);
    expect(kinds(entries)).toEqual(["hold", "charge", "overrun"]);
    expect(entries[1]?.charged).toBe(4000);
    expect(entries[2]?.charged).toBe(8000);
  });

  test("a job that never started on the scheduler is RELEASED in full: nothing is charged", async () => {
    const s = await submittedJob();
    const id = s.made.job.id;
    await drive(s.env, id, s.uuid, "STAGING_INPUTS");
    fx.tapis.advance(s.uuid, "FAILED", "JOB_UNABLE_TO_STAGE_INPUTS");
    await advanceComputeJob(s.env, id);
    const job = await reread(s.env, id);
    expect(job.state).toBe("failed");
    expect(job.failure_code).toBe("staging_failed");
    expect(job.platform_failure).toBe(1);
    expect(job.charged_milli).toBe(0);
    expect(kinds(await ledgerOf(s.env, id))).toEqual(["hold", "release"]);
    expect(await poolOf(s.env, s.made.accountId)).toMatchObject({
      held_milli: 0,
      charged_milli: 0,
    });
  });

  test("a platform failure is a FLAG and not a ledger write: consumed units stay consumed, nothing is refunded", async () => {
    const s = await submittedJob();
    const id = s.made.job.id;
    await drive(s.env, id, s.uuid, "RUNNING");
    await playLauncher(fx, s.env, await reread(s.env, id), s.uuid, {
      failureCode: "dataset_fetch_failed",
      detail: "fetch_failed",
      outputs: [],
    });
    fx.tapis.advance(s.uuid, "FAILED");
    setTapisTimes(fx, s.uuid, 30 * MINUTE, 0);
    setTapisExit(s.uuid, 11);
    await advanceComputeJob(s.env, id);
    const job = await reread(s.env, id);
    expect(job.state).toBe("failed");
    expect(job.failure_code).toBe("dataset_fetch_failed");
    expect(job.failure_detail).toBe("fetch_failed");
    expect(job.platform_failure).toBe(1);
    // It ran for 30 minutes, and those units stay consumed.
    expect(job.charged_milli).toBe(2000);
    expect(kinds(await ledgerOf(s.env, id))).toEqual(["hold", "charge"]);
    const all = await s.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM compute_ledger WHERE kind IN ('refund', 'adjust')",
    ).first<{ n: number }>();
    expect(all?.n).toBe(0);
    expect((await peopleBudget(s.env)).charged_milli).toBe(2000);
  });

  test("a submitter's failure is not a platform failure, and is charged the same way", async () => {
    const s = await submittedJob();
    const id = s.made.job.id;
    await drive(s.env, id, s.uuid, "RUNNING");
    await playLauncher(fx, s.env, await reread(s.env, id), s.uuid, {
      failureCode: "runtime_error",
      detail: "entry_failed",
      outputs: [],
    });
    fx.tapis.advance(s.uuid, "FAILED");
    setTapisTimes(fx, s.uuid, 10 * MINUTE, 0);
    setTapisExit(s.uuid, 13);
    await advanceComputeJob(s.env, id);
    const job = await reread(s.env, id);
    expect([job.failure_code, job.failure_detail, job.platform_failure]).toEqual([
      "runtime_error",
      "entry_failed",
      0,
    ]);
    expect(job.charged_milli).toBe(1000);
  });

  test("a `result_upload_failed` carries a refusal detail: the submitter's, so NOT a platform failure (MUTATION: ignore the detail)", async () => {
    for (const detail of RESULT_REFUSAL_DETAILS) {
      const s = await submittedJob();
      const id = s.made.job.id;
      await drive(s.env, id, s.uuid, "RUNNING");
      await playLauncher(fx, s.env, await reread(s.env, id), s.uuid, {
        failureCode: "result_upload_failed",
        detail,
        outputs: [],
      });
      fx.tapis.advance(s.uuid, "FAILED");
      setTapisTimes(fx, s.uuid, 5 * MINUTE, 0);
      setTapisExit(s.uuid, 16);
      await advanceComputeJob(s.env, id);
      const job = await reread(s.env, id);
      expect([detail, job.failure_code, job.failure_detail, job.platform_failure]).toEqual([
        detail,
        "result_upload_failed",
        detail,
        0,
      ]);
    }
    // Another detail under the same code is the platform's.
    const s = await submittedJob();
    await drive(s.env, s.made.job.id, s.uuid, "RUNNING");
    await playLauncher(fx, s.env, await reread(s.env, s.made.job.id), s.uuid, {
      failureCode: "result_upload_failed",
      detail: "upload_failed",
      outputs: [],
    });
    fx.tapis.advance(s.uuid, "FAILED");
    setTapisExit(s.uuid, 16);
    await advanceComputeJob(s.env, s.made.job.id);
    expect((await reread(s.env, s.made.job.id)).platform_failure).toBe(1);
  });

  test("the arithmetic is the contract's: `provisionalCharge` prices the record's resources and seconds, rounded up", () => {
    const row = {
      partition: "shared",
      nodes: 1,
      cores_per_node: 4,
      memory_mb: null,
      gpus: 0,
      held_milli: 4000,
      results_bytes: null,
      outputs_completed_at: null,
    };
    const rec = (start: string | null, end: string | null) =>
      ({
        uuid: "u-007",
        status: "FINISHED",
        remoteStarted: start,
        remoteEnded: end,
        nodeCount: 1,
        coresPerNode: 4,
      }) as never;
    // FINISHED with no start time is a run Tapis forgot to time, not a job that never started.
    expect(
      provisionalCharge(row, { ...(rec(null, null) as object), status: "QUEUED" } as never),
    ).toEqual({
      kind: "release",
    });
    expect(
      provisionalCharge(row, rec("2026-11-04T10:00:00.000Z", "2026-11-04T10:30:00.000Z")),
    ).toMatchObject({
      kind: "charge",
      milli: 2000,
      seconds: 1800,
    });
    // One second over is rounded up in seconds, and the minimum is one SU.
    expect(
      provisionalCharge(row, rec("2026-11-04T10:00:00.000Z", "2026-11-04T10:00:00.001Z")),
    ).toMatchObject({
      kind: "charge",
      milli: 1000,
      seconds: 1,
    });
    // The record's resources win over the row's: two nodes of four cores for an hour.
    expect(
      provisionalCharge(row, {
        uuid: "u-007",
        status: "FINISHED",
        remoteStarted: "2026-11-04T10:00:00Z",
        remoteEnded: "2026-11-04T11:00:00Z",
        nodeCount: 2,
        coresPerNode: 4,
      } as never),
    ).toMatchObject({ kind: "charge", milli: 8000 });
    // A rate that cannot be priced charges the hold and says so.
    expect(
      provisionalCharge({ ...row, cores_per_node: 0, memory_mb: null }, {
        uuid: "u-007",
        status: "FINISHED",
        remoteStarted: "2026-11-04T10:00:00Z",
        remoteEnded: "2026-11-04T10:30:00Z",
        coresPerNode: 0,
      } as never),
    ).toMatchObject({ kind: "charge", milli: 4000, fallback: true });
  });

  test("Tapis times are written the way the row writes its own", () => {
    expect(sqliteTime("2026-11-04T10:00:00.123Z")).toBe("2026-11-04 10:00:00");
    expect(sqliteTime("2026-11-04T03:00:00-07:00")).toBe("2026-11-04 10:00:00");
    expect(sqliteTime("2026-11-04 10:00:00")).toBe("2026-11-04 10:00:00");
    expect(sqliteTime("not a time")).toBeNull();
    expect(sqliteTime(null)).toBeNull();
  });
});

// --- Concurrency ---------------------------------------------------------------------------------

describe("one final state and one charge under concurrency", () => {
  test("a webhook, a tick and a cancel applied together leave one final state and one charge entry (MUTATION: drop `state = <from>`)", async () => {
    const s = await submittedJob();
    const id = s.made.job.id;
    await drive(s.env, id, s.uuid, "RUNNING");
    setTapisTimes(fx, s.uuid, 30 * MINUTE, 0);
    const running = await reread(s.env, id);
    const base = fx.tapis.jobs.get(s.uuid)?.record as Record<string, unknown>;
    // The webhook and the tick each read the same FAILED record from Tapis; the cancel carries the
    // CANCELLED one. Each writer holds the row as it read it (RUNNING).
    const failed = { ...base, status: "FAILED", condition: "JOB_LAUNCH_FAILURE" } as never;
    const cancelled = { ...base, status: "CANCELLED", condition: "CANCELLED_BY_USER" } as never;

    const racing = { ...s.env, DB: roundTripD1(s.env.DB) } as Bindings;
    const results = await Promise.all([
      applyTapisJob(racing, running, failed),
      applyTapisJob(racing, running, cancelled),
      applyTapisJob(racing, running, failed),
    ]);
    // Exactly one writer won the transition; the others changed nothing.
    expect(results.filter((r) => r.outcome === "terminal_committed")).toHaveLength(1);
    expect(results.filter((r) => r.changed)).toHaveLength(1);
    const final = await reread(s.env, id);
    expect(["failed", "cancelled"]).toContain(final.state);
    // The state and its reason are the winner's, not a mixture.
    expect(final.state === "failed" ? final.failure_code : final.cancel_reason).not.toBeNull();
    expect(final.state === "failed" ? final.cancel_reason : final.failure_code).toBeNull();
    // One settlement, one charge, one stamp.
    const entries = await ledgerOf(s.env, id);
    expect(entries.filter((e) => e.kind === "charge")).toHaveLength(1);
    expect(entries.filter((e) => e.kind === "release")).toHaveLength(0);
    expect(final.settled_provisional_at).not.toBeNull();
    expect(final.charged_milli).toBe(2000);

    // Replaying each, from the old row and from the new, changes nothing and writes nothing.
    const before = JSON.stringify(entries);
    for (const rec of [failed, cancelled]) {
      expect((await applyTapisJob(s.env, running, rec)).changed).toBe(false);
      expect((await applyTapisJob(s.env, final, rec)).changed).toBe(false);
    }
    expect(JSON.stringify(await ledgerOf(s.env, id))).toBe(before);
    expect((await reread(s.env, id)).state).toBe(final.state);
  });

  test("two terminal writers with the same stale row: exactly one wins and the loser changes nothing", async () => {
    const s = await submittedJob();
    const id = s.made.job.id;
    await drive(s.env, id, s.uuid, "RUNNING");
    setTapisTimes(fx, s.uuid, 30 * MINUTE, 0);
    const running = await reread(s.env, id);
    const base = fx.tapis.jobs.get(s.uuid)?.record as Record<string, unknown>;
    const failed = {
      ...base,
      status: "FAILED",
      condition: "JOB_LAUNCH_FAILURE",
    } as never;
    const cancelled = {
      ...base,
      status: "CANCELLED",
      condition: "CANCELLED_BY_USER",
    } as never;
    const first = await applyTapisJob(s.env, running, failed);
    // The second writer still holds the row it read before the first committed.
    const second = await applyTapisJob(s.env, running, cancelled);
    expect(first.outcome).toBe("terminal_committed");
    expect(second.changed).toBe(false);
    const final = await reread(s.env, id);
    expect(final.state).toBe("failed");
    expect(final.failure_code).toBe("launch_failed");
    expect(kinds(await ledgerOf(s.env, id))).toEqual(["hold", "charge"]);
  });

  test("two live writers holding the same stale row: the first wins, and the second cannot move the job back (MUTATION: drop `state = <from>` of the live write)", async () => {
    const s = await submittedJob();
    const id = s.made.job.id;
    await drive(s.env, id, s.uuid, "QUEUED");
    const queued = await reread(s.env, id);
    const base = fx.tapis.jobs.get(s.uuid)?.record as Record<string, unknown>;
    const archiving = { ...base, status: "ARCHIVING" } as never;
    const running = { ...base, status: "RUNNING" } as never;
    // Both writers read the job while it was QUEUED; the later status arrives first.
    expect((await applyTapisJob(s.env, queued, archiving)).outcome).toBe("advanced");
    // The second write loses, reads the row again (ARCHIVING) and finds its RUNNING record is now stale.
    expect(await applyTapisJob(s.env, queued, running)).toMatchObject({
      changed: false,
      outcome: "stale",
    });
    expect((await reread(s.env, id)).state).toBe("archiving");
    expect((await reread(s.env, id)).tapis_status).toBe("ARCHIVING");
  });

  test("a hold closed behind the Worker's back: the transition commits, the ledger writes nothing more, and the row is stamped settled", async () => {
    const s = await submittedJob();
    const id = s.made.job.id;
    await drive(s.env, id, s.uuid, "RUNNING");
    setTapisTimes(fx, s.uuid, 30 * MINUTE, null);
    // Close the hold behind the Worker's back: the ledger's guard DECLINES the settlement (it writes
    // nothing and does not throw), so the state change still commits, and the row is stamped settled
    // because the ledger does hold an entry that closed the hold. (A settlement that THROWS rolls the
    // state change back: compute-lifecycle-money.test.ts.)
    await s.env.DB.prepare(
      `INSERT INTO compute_ledger (kind, pool_id, budget_pool_id, held_delta_milli, job_id, hold_ref, reason, idempotency_key)
       SELECT 'release', h.pool_id, h.budget_pool_id, -h.held_delta_milli, h.job_id, h.id, 'by_hand', 'hold:' || h.id || ':release'
         FROM compute_ledger h WHERE h.kind = 'hold' AND h.job_id = ?1`,
    )
      .bind(id)
      .run();
    fx.tapis.advance(s.uuid, "FAILED", "JOB_LAUNCH_FAILURE");
    await advanceComputeJob(s.env, id);
    const job = await reread(s.env, id);
    // The state moved, the settlement is the ledger's (already released), and `settled` stays false so
    // a retry repairs nothing it cannot: no double entry exists.
    expect(job.state).toBe("failed");
    expect(kinds(await ledgerOf(s.env, id))).toEqual(["hold", "release"]);
    expect(job.settled_provisional_at).not.toBeNull();
  });

  test("a terminal row whose settlement is owed is repaired by a retry (never twice)", async () => {
    const s = await submittedJob();
    const id = s.made.job.id;
    await drive(s.env, id, s.uuid, "RUNNING");
    setTapisTimes(fx, s.uuid, 30 * MINUTE, null);
    // A terminal row with its hold still open, as a crash between a bare state write and a ledger
    // write would leave it (the production path cannot: it is one batch).
    fx.tapis.advance(s.uuid, "FAILED", "JOB_LAUNCH_FAILURE");
    await s.env.DB.prepare(
      "UPDATE compute_jobs SET state = 'failed', failure_code = 'launch_failed', ended_at = datetime('now') WHERE id = ?",
    )
      .bind(id)
      .run();
    expect(kinds(await ledgerOf(s.env, id))).toEqual(["hold"]);
    const answer = await advanceComputeJob(s.env, id);
    expect(answer.outcome).toBe("terminal");
    const job = await reread(s.env, id);
    expect(job.settled_provisional_at).not.toBeNull();
    expect(kinds(await ledgerOf(s.env, id))).toEqual(["hold", "charge"]);
    await advanceComputeJob(s.env, id);
    expect(kinds(await ledgerOf(s.env, id))).toEqual(["hold", "charge"]);
  });
});

describe("the settlement is gated on the job row", () => {
  test("a charge or a release is written only if the row has taken the new state and is not yet settled (MUTATION: drop the gate)", async () => {
    const s = await submittedJob();
    const id = s.made.job.id;
    const db = s.env.DB;
    const gate = { sql: SETTLEMENT_GATE_SQL, binds: [id, "failed"] };
    // The row is `submitted`, so the gate is false: nothing is written, whatever the figure.
    await db.batch(settleStatements(db, { jobId: id, chargeMilli: 1000 }, gate));
    await db.batch(releaseStatements(db, { jobId: id }, gate));
    expect(kinds(await ledgerOf(s.env, id))).toEqual(["hold"]);
    // A row that is terminal but already stamped settled is gated out too.
    await db
      .prepare(
        "UPDATE compute_jobs SET state = 'failed', failure_code = 'tapis_error', settled_provisional_at = datetime('now') WHERE id = ?",
      )
      .bind(id)
      .run();
    await db.batch(settleStatements(db, { jobId: id, chargeMilli: 1000 }, gate));
    expect(kinds(await ledgerOf(s.env, id))).toEqual(["hold"]);
    // The row has taken the state and is not settled: the same statement writes.
    await db
      .prepare("UPDATE compute_jobs SET settled_provisional_at = NULL WHERE id = ?")
      .bind(id)
      .run();
    await db.batch(settleStatements(db, { jobId: id, chargeMilli: 1000 }, gate));
    expect(kinds(await ledgerOf(s.env, id))).toEqual(["hold", "charge"]);
  });
});

describe("on Miniflare's D1, the engine `wrangler --local` runs", () => {
  async function onD1() {
    const env = fx.env({ DB: fx.harness.d1 } as Partial<Bindings>);
    const d1 = fx.harness.d1 as D1Database;
    // The platform budget of a database that is never reset: generous, and added to, never read as exact.
    const { fundPlatform } = await import("./helpers/compute-seed");
    await fundPlatform(d1, "people", 1_000_000_000);
    await setPolicy(d1, miniflareOwner, {});
    return env;
  }

  test("a terminal transition and its settlement are one batch, and a stale writer changes nothing", async () => {
    const env = await onD1();
    const made = await makeJob(fx, { env });
    const submit = await submitComputeJob(env, made.job.id);
    expect(submit.ok).toBe(true);
    const job = await reread(env, made.job.id);
    const uuid = job.tapis_uuid as string;
    fx.tapis.advance(uuid, "RUNNING");
    setTapisTimes(fx, uuid, 30 * MINUTE, 0);
    const running = await reread(env, made.job.id);
    const base = fx.tapis.jobs.get(uuid)?.record as Record<string, unknown>;
    const failed = {
      ...base,
      status: "FAILED",
      condition: "JOB_LAUNCH_FAILURE",
    } as never;
    const cancelled = {
      ...base,
      status: "CANCELLED",
      condition: "CANCELLED_BY_USER",
    } as never;
    const [a, b] = await Promise.all([
      applyTapisJob(env, running, failed),
      applyTapisJob(env, running, cancelled),
    ]);
    expect([a.outcome, b.outcome].filter((o) => o === "terminal_committed")).toHaveLength(1);
    const final = await reread(env, made.job.id);
    expect(final.settled_provisional_at).not.toBeNull();
    expect(final.charged_milli).toBe(2000);
    expect(kinds(await ledgerOf(env, made.job.id))).toEqual(["hold", "charge"]);
  });

  test("a job that never started is released in one batch with its terminal state", async () => {
    const env = await onD1();
    const made = await makeJob(fx, { env });
    await submitComputeJob(env, made.job.id);
    const job = await reread(env, made.job.id);
    fx.tapis.advance(job.tapis_uuid as string, "FAILED", "JOB_UNABLE_TO_STAGE_INPUTS");
    await advanceComputeJob(env, made.job.id);
    expect(kinds(await ledgerOf(env, made.job.id))).toEqual(["hold", "release"]);
    expect((await reread(env, made.job.id)).state).toBe("failed");
  });
});

// --- Verification --------------------------------------------------------------------------------

describe("verification: a Tapis FINISHED stands only after the upload is verified", () => {
  const cases: Array<[string, Parameters<typeof playLauncher>[4], string, number?]> = [
    ["a declared output that is not in the bucket", { skipUpload: 0 }, "output_missing"],
    [
      "an output whose size is not the declared one",
      { declaredSizeDelta: 3 },
      "output_size_mismatch",
    ],
    [
      "a launch specification digest that is not the one NEMAR sent",
      { launchDigest: "e".repeat(64) },
      "launch_digest_mismatch",
    ],
    [
      "a result, provenance or manifest for another job",
      { jobIdInDocs: "job_aaaaaaaaaaaaaaaaaaaaaaaa" },
      "job_id_mismatch",
    ],
    [
      "a bundle digest where the job has no bundle",
      { bundleDigest: "f".repeat(64) },
      "bundle_digest_mismatch",
    ],
    [
      "an image digest that is not the job's",
      { imageDigest: `sha256:${"a".repeat(64)}` },
      "image_digest_mismatch",
    ],
    [
      "a result that reports a failure for a finished job",
      { failureCode: "runtime_error", detail: "entry_failed", exitNumber: 13 },
      "result_reports_failure",
    ],
    ["an exit number that is not the one Tapis reports", {}, "exit_mismatch", 5],
    ["a launcher document that was never uploaded", { omit: ["provenance"] }, "provenance_missing"],
    ["a launcher document that is missing", { omit: ["result"] }, "result_missing"],
    ["a manifest that is missing", { omit: ["manifest"] }, "manifest_missing"],
    ["no declared file", { omit: ["declared"] }, "declared_missing"],
  ];

  for (const [name, plan, reason, tapisExit] of cases) {
    test(`${name} ends the job failed with \`result_verification_failed\` (${reason})`, async () => {
      const s = await submittedJob();
      const id = s.made.job.id;
      await drive(s.env, id, s.uuid, "RUNNING");
      await playLauncher(fx, s.env, await reread(s.env, id), s.uuid, plan);
      fx.tapis.advance(s.uuid, "FINISHED");
      setTapisTimes(fx, s.uuid, 30 * MINUTE, 0);
      // Tapis reports a clean exit unless the case is about the exit it reports.
      setTapisExit(s.uuid, tapisExit ?? 0);
      await advanceComputeJob(s.env, id);
      const job = await reread(s.env, id);
      expect(job.state).toBe("failed");
      expect(job.failure_code).toBe("result_verification_failed");
      expect(job.failure_detail).toBe(reason);
      expect(job.platform_failure).toBe(1);
      expect(job.results_verified_at).toBeNull();
      // The units it used stay consumed: verification is NEMAR's, and nothing is refunded.
      expect(job.charged_milli).toBe(2000);
      expect(kinds(await ledgerOf(s.env, id))).toEqual(["hold", "charge"]);
    });
  }

  test("a mismatch of identity is flagged for an administrator", async () => {
    const s = await submittedJob();
    const id = s.made.job.id;
    await drive(s.env, id, s.uuid, "RUNNING");
    await playLauncher(fx, s.env, await reread(s.env, id), s.uuid, {
      launchDigest: "e".repeat(64),
    });
    fx.tapis.advance(s.uuid, "FINISHED");
    await advanceComputeJob(s.env, id);
    expect((await reread(s.env, id)).flag_mismatch).toBe(1);
  });

  test("a FINISHED job whose launcher never called `complete` ends `result_upload_failed`", async () => {
    const s = await submittedJob();
    const id = s.made.job.id;
    await drive(s.env, id, s.uuid, "RUNNING");
    await playLauncher(fx, s.env, await reread(s.env, id), s.uuid, { incomplete: true });
    fx.tapis.advance(s.uuid, "FINISHED");
    setTapisTimes(fx, s.uuid, 30 * MINUTE, 0);
    await advanceComputeJob(s.env, id);
    const job = await reread(s.env, id);
    expect(job.state).toBe("failed");
    expect(job.failure_code).toBe("result_upload_failed");
    expect(job.failure_detail).toBe("not_completed");
  });

  test("a verified job is `finished`: the manifest and provenance agree, and every output is there at its declared size", async () => {
    const s = await submittedJob();
    await finishJob(s, {
      outputs: [
        { path: "a.txt", content: "alpha" },
        { path: "deep/b..c.csv", content: "beta" },
        { path: "100%.txt", content: "gamma" },
      ],
    });
    const job = await reread(s.env, s.made.job.id);
    expect(job.state).toBe("finished");
    expect(job.results_verified_at).not.toBeNull();
  });

  // Round 1 of #2041: these checks had no failing test (with each disabled every compute test passed).
  async function verifyAfter(
    after: (s: { made: MadeJob; uuid: string; env: Bindings }) => Promise<void>,
    plan: Parameters<typeof playLauncher>[4] = {},
  ) {
    const s = await submittedJob();
    const id = s.made.job.id;
    await drive(s.env, id, s.uuid, "RUNNING");
    await playLauncher(fx, s.env, await reread(s.env, id), s.uuid, plan);
    await after(s);
    fx.tapis.advance(s.uuid, "FINISHED");
    setTapisTimes(fx, s.uuid, 30 * MINUTE, 0);
    setTapisExit(s.uuid, 0);
    await advanceComputeJob(s.env, id);
    return { s, job: await reread(s.env, id) };
  }

  const twoOutputs = [
    { path: "a.txt", content: "alpha" },
    { path: "b.txt", content: "beta" },
  ];

  async function editManifest(
    s: { made: MadeJob },
    edit: (files: Array<{ path: string; size: number; sha256: string }>) => unknown[],
  ) {
    const key = resultsLauncherKey(s.made.job.id, "manifest.json");
    const manifest = JSON.parse((await (await fx.harness.results.get(key))?.text()) as string);
    manifest.files = edit(manifest.files);
    await fx.harness.results.put(key, new TextEncoder().encode(JSON.stringify(manifest)));
  }

  const manifestEdits: Array<
    [string, (f: Array<{ path: string; size: number; sha256: string }>) => unknown[]]
  > = [
    ["another path", (f) => [{ ...f[0], path: "other.txt" }, f[1]]],
    ["another size", (f) => [{ ...f[0], size: (f[0]?.size ?? 0) + 1 }, f[1]]],
    ["another checksum", (f) => [{ ...f[0], sha256: "0".repeat(64) }, f[1]]],
    [
      "one entry more than was declared",
      (f) => [...f, { path: "c.txt", size: 1, sha256: "1".repeat(64) }],
    ],
    ["one entry fewer than was declared", (f) => [f[0]]],
  ];
  for (const [name, edit] of manifestEdits) {
    test(`a manifest with ${name} fails verification as \`manifest_mismatch\`, flagged for an administrator`, async () => {
      const { job } = await verifyAfter((s) => editManifest(s, edit), { outputs: twoOutputs });
      expect([job.state, job.failure_code, job.failure_detail]).toEqual([
        "failed",
        "result_verification_failed",
        "manifest_mismatch",
      ]);
      expect([job.flag_mismatch, job.platform_failure]).toEqual([1, 1]);
    });
  }

  test("an output whose stored SHA-256 is not the declared one fails as `output_checksum_mismatch`; one that matches, or has none, passes", async () => {
    const encoder = new TextEncoder();
    const hex = async (text: string) => sha256Hex(encoder.encode(text));
    // Same size, other bytes, stored WITH R2's checksum of those other bytes.
    const bad = await verifyAfter(
      async (s) => {
        await fx.harness.results.put(
          resultsOutputKey(s.made.job.id, "a.txt"),
          encoder.encode("ALPHA"),
          { sha256: await hex("ALPHA") },
        );
      },
      { outputs: twoOutputs },
    );
    expect([bad.job.state, bad.job.failure_detail, bad.job.flag_mismatch]).toEqual([
      "failed",
      "output_checksum_mismatch",
      1,
    ]);
    // The right bytes with R2's checksum of them: verified.
    const good = await verifyAfter(
      async (s) => {
        await fx.harness.results.put(
          resultsOutputKey(s.made.job.id, "a.txt"),
          encoder.encode("alpha"),
          { sha256: await hex("alpha") },
        );
      },
      { outputs: twoOutputs },
    );
    expect(good.job.state).toBe("finished");
    // The same size, other bytes, and NO checksum from R2: size is all there is to check, and it passes
    // (the residual the ADR states).
    const sizeOnly = await verifyAfter(
      async (s) => {
        await fx.harness.results.put(
          resultsOutputKey(s.made.job.id, "a.txt"),
          encoder.encode("ALPHA"),
        );
      },
      { outputs: twoOutputs },
    );
    expect(sizeOnly.job.state).toBe("finished");
  });

  // A listing is one page per 1,000 objects: a verification that read the first page only would call
  // every output past it missing (or, worse, never look at it). The sizes are the boundaries.
  for (const count of [999, 1000, 1001, 2500]) {
    test(`${count} declared outputs are all checked: all present passes, and the LAST one missing fails as \`output_missing\``, async () => {
      const outputs = Array.from({ length: count }, (_, i) => ({
        path: `o${String(i).padStart(5, "0")}.txt`,
        content: "x",
      }));
      const present = await verifyAfter(async () => {}, { outputs });
      expect([count, present.job.state]).toEqual([count, "finished"]);
      const missing = await verifyAfter(async () => {}, { outputs, skipUpload: count - 1 });
      expect([count, missing.job.state, missing.job.failure_detail]).toEqual([
        count,
        "failed",
        "output_missing",
      ]);
    }, 120_000);
  }

  test("a launcher file replaced after `complete` by an object of another size fails as `launcher_file_missing`", async () => {
    const { job } = await verifyAfter(async (s) => {
      await fx.harness.results.put(
        resultsLauncherKey(s.made.job.id, "launcher.log"),
        new TextEncoder().encode("a log that is not the size that was declared"),
      );
    });
    expect([job.state, job.failure_code, job.failure_detail]).toEqual([
      "failed",
      "result_verification_failed",
      "launcher_file_missing",
    ]);
  });

  test("a recorded specification that cannot be read (deleted, or not the digest the row holds) is `records_unavailable` and the platform's", async () => {
    for (const break_ of [
      (s: { made: MadeJob }) => fx.harness.records.delete(recordKey(s.made.job.id, "spec.json")),
      (s: { made: MadeJob }) =>
        fx.harness.records.put(
          recordKey(s.made.job.id, "spec.json"),
          new TextEncoder().encode("{}"),
        ),
    ]) {
      const { job } = await verifyAfter(async (s) => {
        await break_(s);
      });
      expect([job.state, job.failure_code, job.failure_detail, job.platform_failure]).toEqual([
        "failed",
        "records_unavailable",
        "records_unreadable",
        1,
      ]);
      expect(job.results_verified_at).toBeNull();
    }
  });

  test("a Worker with no records bucket cannot verify, and says so the same way", async () => {
    const s = await submittedJob();
    const id = s.made.job.id;
    await drive(s.env, id, s.uuid, "RUNNING");
    await playLauncher(fx, s.env, await reread(s.env, id), s.uuid, {});
    fx.tapis.advance(s.uuid, "FINISHED");
    setTapisTimes(fx, s.uuid, 30 * MINUTE, 0);
    await advanceComputeJob({ ...s.env, COMPUTE_RECORDS: undefined } as Bindings, id);
    const job = await reread(s.env, id);
    expect([job.state, job.failure_code, job.failure_detail]).toEqual([
      "failed",
      "records_unavailable",
      "records_unreadable",
    ]);
  });
});

describe("a FAILED job's code comes from the launcher only when the launcher is trusted", () => {
  async function failed(
    plan: Parameters<typeof playLauncher>[4],
    tapisExit: number,
    condition = "JOB_REMOTE_OUTCOME_ERROR",
  ) {
    const s = await submittedJob();
    const id = s.made.job.id;
    await drive(s.env, id, s.uuid, "RUNNING");
    await playLauncher(fx, s.env, await reread(s.env, id), s.uuid, { outputs: [], ...plan });
    fx.tapis.advance(s.uuid, "FAILED", condition);
    setTapisTimes(fx, s.uuid, 5 * MINUTE, 0);
    setTapisExit(s.uuid, tapisExit);
    await advanceComputeJob(s.env, id);
    return { s, job: await reread(s.env, id) };
  }

  test("a trusted result.json gives the code and the detail, both stored", async () => {
    const { job } = await failed(
      { failureCode: "code_fetch_failed", detail: "checksum_mismatch" },
      10,
    );
    expect([job.failure_code, job.failure_detail, job.platform_failure]).toEqual([
      "code_fetch_failed",
      "checksum_mismatch",
      1,
    ]);
  });

  test("a submitter-caused detail under a platform code is charged and not a platform failure", async () => {
    const { job } = await failed(
      { failureCode: "code_fetch_failed", detail: "archive_too_large" },
      10,
    );
    expect([job.failure_code, job.platform_failure]).toEqual(["code_fetch_failed", 0]);
  });

  test("a result.json for another job is ignored: the Tapis condition decides, and the job is flagged", async () => {
    const { job } = await failed(
      { failureCode: "entry_not_found", jobIdInDocs: "job_aaaaaaaaaaaaaaaaaaaaaaaa" },
      12,
      "SCHEDULER_TIMEOUT",
    );
    expect(job.failure_code).toBe("time_limit");
    expect(job.flag_mismatch).toBe(1);
  });

  test("an exit number that is not the one Tapis reports is ignored the same way", async () => {
    const { job } = await failed({ failureCode: "entry_not_found" }, 99, "SCHEDULER_OUT_OF_MEMORY");
    expect(job.failure_code).toBe("out_of_memory");
    expect(job.flag_mismatch).toBe(1);
  });

  test("a provenance whose launch specification digest is not NEMAR's makes the result untrusted", async () => {
    const { job } = await failed(
      { failureCode: "entry_not_found", launchDigest: "e".repeat(64) },
      12,
      "JOB_LAUNCH_FAILURE",
    );
    expect(job.failure_code).toBe("launch_failed");
    expect(job.flag_mismatch).toBe(1);
  });

  test("a launcher killed before it wrote result.json (a SIGKILL) takes Tapis's reported condition", async () => {
    const { job } = await failed({ omit: ["result"] }, 137, "SCHEDULER_OUT_OF_MEMORY");
    expect(job.state).toBe("failed");
    expect(job.failure_code).toBe("out_of_memory");
    expect(job.platform_failure).toBe(0);
    const unknown = await failed(
      { omit: ["result", "provenance", "manifest", "log", "declared"] },
      1,
      "SOMETHING_NEW",
    );
    expect(unknown.job.failure_code).toBe("tapis_error");
    expect(unknown.job.platform_failure).toBe(1);
  });

  test("a result that says no failure for a Tapis FAILED job falls back to the condition", async () => {
    const { job } = await failed({}, 0, "JOB_ARCHIVING_FAILED");
    expect(job.failure_code).toBe("archive_failed");
  });

  test("a result refusal the outputs route recorded wins over what the launcher says: the submitter's, charged, not a platform failure", async () => {
    const s = await submittedJob();
    const id = s.made.job.id;
    await drive(s.env, id, s.uuid, "RUNNING");
    // What the outputs route leaves when it refuses a person's results (its own tests drive the route).
    await s.env.DB.prepare(
      "UPDATE compute_jobs SET failure_detail = 'results_quota_exceeded' WHERE id = ?",
    )
      .bind(id)
      .run();
    // The launcher saw a 409 it does not know the meaning of and called it a platform detail.
    await playLauncher(fx, s.env, await reread(s.env, id), s.uuid, {
      failureCode: "result_upload_failed",
      detail: "outputs_refused",
      outputs: [],
    });
    fx.tapis.advance(s.uuid, "FAILED", "JOB_REMOTE_OUTCOME_ERROR");
    setTapisTimes(fx, s.uuid, 30 * MINUTE, 0);
    setTapisExit(s.uuid, 16);
    await advanceComputeJob(s.env, id);
    const job = await reread(s.env, id);
    expect([job.failure_code, job.failure_detail, job.platform_failure]).toEqual([
      "result_upload_failed",
      "results_quota_exceeded",
      0,
    ]);
    expect(job.charged_milli).toBe(2000);
    // And a launcher that never uploaded anything at all, killed after the refusal, is the same.
    const t = await submittedJob();
    await drive(t.env, t.made.job.id, t.uuid, "RUNNING");
    await t.env.DB.prepare(
      "UPDATE compute_jobs SET failure_detail = 'too_many_outputs' WHERE id = ?",
    )
      .bind(t.made.job.id)
      .run();
    fx.tapis.advance(t.uuid, "FAILED", "JOB_REMOTE_OUTCOME_ERROR");
    await advanceComputeJob(t.env, t.made.job.id);
    const lost = await reread(t.env, t.made.job.id);
    expect([lost.failure_code, lost.failure_detail, lost.platform_failure]).toEqual([
      "result_upload_failed",
      "too_many_outputs",
      0,
    ]);
    // A FINISHED that is not verified, after a refusal, is the same word and still not the platform's.
    const u = await submittedJob();
    await drive(u.env, u.made.job.id, u.uuid, "RUNNING");
    await u.env.DB.prepare(
      "UPDATE compute_jobs SET failure_detail = 'results_too_large' WHERE id = ?",
    )
      .bind(u.made.job.id)
      .run();
    fx.tapis.advance(u.uuid, "FINISHED");
    await advanceComputeJob(u.env, u.made.job.id);
    const fin = await reread(u.env, u.made.job.id);
    expect([fin.state, fin.failure_code, fin.failure_detail, fin.platform_failure]).toEqual([
      "failed",
      "result_upload_failed",
      "results_too_large",
      0,
    ]);
  });

  test("the Worker's own cancel overrules the launcher's `terminated`: the job is `cancelled`, not failed", async () => {
    const s = await submittedJob();
    const id = s.made.job.id;
    await drive(s.env, id, s.uuid, "RUNNING");
    await s.env.DB.prepare(
      "UPDATE compute_jobs SET cancel_requested_at = datetime('now'), cancel_reason = 'user' WHERE id = ?",
    )
      .bind(id)
      .run();
    await playLauncher(fx, s.env, await reread(s.env, id), s.uuid, {
      failureCode: "runtime_error",
      detail: "terminated",
      outputs: [],
    });
    fx.tapis.advance(s.uuid, "FAILED", "JOB_REMOTE_OUTCOME_ERROR");
    setTapisTimes(fx, s.uuid, 5 * MINUTE, 0);
    setTapisExit(s.uuid, 13);
    await advanceComputeJob(s.env, id);
    const job = await reread(s.env, id);
    expect(job.state).toBe("cancelled");
    expect(job.failure_code).toBeNull();
    expect(job.cancel_reason).toBe("user");
    expect(job.charged_milli).toBe(1000);
  });
});

// --- Cancel --------------------------------------------------------------------------------------

describe("cancel", () => {
  test("a job that never reached Tapis is cancelled at once and its hold released", async () => {
    const made = await makeJob(fx);
    const answer = await requestComputeCancel(made.env, made.job.id, "user");
    expect(answer).toEqual({ ok: true, outcome: "cancel_requested", state: "cancelled" });
    const job = await reread(made.env, made.job.id);
    expect(job.state).toBe("cancelled");
    expect(job.cancel_reason).toBe("user");
    expect(job.cancel_requested_at).not.toBeNull();
    expect(kinds(await ledgerOf(made.env, job.id))).toEqual(["hold", "release"]);
    expect(await poolOf(made.env, made.accountId)).toMatchObject({
      held_milli: 0,
      charged_milli: 0,
    });
    expect(fx.tapis.log).toHaveLength(0);
    // Asking again is a replay.
    expect((await requestComputeCancel(made.env, made.job.id, "user")).outcome).toBe(
      "already_cancelled",
    );
    expect(kinds(await ledgerOf(made.env, job.id))).toEqual(["hold", "release"]);
  });

  test("a running job is cancelled AT TAPIS and charged what it used", async () => {
    const s = await submittedJob();
    const id = s.made.job.id;
    await drive(s.env, id, s.uuid, "RUNNING");
    setTapisTimes(fx, s.uuid, 30 * MINUTE, null);
    const answer = await requestComputeCancel(s.env, id, "admin");
    expect(answer.ok).toBe(true);
    expect(fx.tapis.log.some((r) => r.route === "POST /v3/jobs/:uuid/cancel")).toBe(true);
    const job = await reread(s.env, id);
    expect(job.state).toBe("cancelled");
    expect(job.cancel_reason).toBe("admin");
    // Thirty minutes of four cores, give or take the seconds the stand-in took to cancel.
    expect(job.charged_milli).toBeGreaterThanOrEqual(2000);
    expect(job.charged_milli).toBeLessThanOrEqual(2010);
    expect(kinds(await ledgerOf(s.env, id))).toEqual(["hold", "charge"]);
    expect(job.platform_failure).toBe(0);
  });

  test("a queued job that never started is cancelled and released in full", async () => {
    const s = await submittedJob();
    await drive(s.env, s.made.job.id, s.uuid, "QUEUED");
    await requestComputeCancel(s.env, s.made.job.id, "user");
    expect(kinds(await ledgerOf(s.env, s.made.job.id))).toEqual(["hold", "release"]);
  });

  test("a cancel Tapis could not take is recorded, and the sweep carries it out", async () => {
    const s = await submittedJob();
    const id = s.made.job.id;
    await drive(s.env, id, s.uuid, "RUNNING");
    setTapisTimes(fx, s.uuid, 30 * MINUTE, null);
    fx.tapis.fail("POST /v3/jobs/:uuid/cancel", 503);
    const answer = await requestComputeCancel(s.env, id, "user");
    expect(answer.outcome).toBe("cancel_requested");
    let job = await reread(s.env, id);
    expect(job.state).toBe("running");
    expect(job.cancel_requested_at).not.toBeNull();

    expect(
      await sweepComputeCancellations({ ...s.env, ENVIRONMENT: "staging" } as Bindings),
    ).toBeNull();
    const swept = await sweepComputeCancellations(s.env);
    // A TRANSIENT failure that the retry cured is quiet: the retry took the cancel.
    expect(swept).toMatchObject({
      examined: 1,
      errors: [],
      cancel_failed: 0,
      cancel_pending_failed: 0,
    });
    expect(swept ? cancellationsLogLine(swept)?.level : null).toBe("info");
    job = await reread(s.env, id);
    expect(job.state).toBe("cancelled");
    // Thirty minutes of four cores, give or take the seconds the stand-in took to cancel.
    expect(job.charged_milli).toBeGreaterThanOrEqual(2000);
    expect(job.charged_milli).toBeLessThanOrEqual(2010);
    // Nothing is left to do, and the sweep says so.
    expect(await sweepComputeCancellations(s.env)).toMatchObject({ examined: 0 });
  });

  test("a cancel Tapis keeps refusing is LOUD on every tick it persists: counted as `cancel_failed`, logged at error level without an id, and stuck after an hour (MUTATION: count nothing, or log at info)", async () => {
    const s = await submittedJob();
    const id = s.made.job.id;
    await drive(s.env, id, s.uuid, "RUNNING");
    setTapisTimes(fx, s.uuid, 30 * MINUTE, null);
    // The request, then three ticks, fail; the fourth tick is the retry that works.
    fx.tapis.fail("POST /v3/jobs/:uuid/cancel", 503, 4);
    await requestComputeCancel(s.env, id, "user");
    for (const stuck of [0, 0]) {
      const swept = await sweepComputeCancellations(s.env);
      expect(swept).toMatchObject({
        examined: 1,
        errors: [],
        cancel_failed: 1,
        cancel_pending_failed: stuck,
      });
      const log = swept ? cancellationsLogLine(swept) : null;
      expect(log?.level).toBe("error");
      expect(log?.line).toContain("cancel_failed=1");
      expect(log?.line).not.toContain(id);
      expect((await reread(s.env, id)).state).toBe("running");
    }
    // An hour after it was asked for, a cancel still not carried out is reported as stuck.
    await s.env.DB.prepare(
      "UPDATE compute_jobs SET cancel_requested_at = datetime('now', '-61 minutes') WHERE id = ?",
    )
      .bind(id)
      .run();
    const third = await sweepComputeCancellations(s.env);
    expect(third).toMatchObject({ cancel_failed: 1, cancel_pending_failed: 1 });
    expect(third ? cancellationsLogLine(third)?.line : "").toContain("cancel_pending_failed=1");
    // Tapis takes it on the next tick: quiet again.
    const fourth = await sweepComputeCancellations(s.env);
    expect(fourth).toMatchObject({ cancel_failed: 0, cancel_pending_failed: 0 });
    expect((await reread(s.env, id)).state).toBe("cancelled");
  });

  test("a partner's reservation with no Tapis job is not ended by a cancel: the partner launches its own Tapis job, so the row's records prove nothing (MUTATION: drop the partner term of driveCancel, or of the sweep's list)", async () => {
    // NEMAR never takes a submit lease and never writes a launch specification for a partner job, so
    // "no Tapis job, no launch specification, no live lease" is TRUE of a reservation whose partner has
    // already launched, and ending the row would release a hold for a job that runs. The partner
    // contract (phase D4) decides what happens to a reservation; the row is left as it is.
    const made = await makeJob(fx);
    await made.env.DB.prepare(
      "UPDATE compute_jobs SET source = 'partner', client_id = 'c1' WHERE id = ?1",
    )
      .bind(made.job.id)
      .run();
    expect(await requestComputeCancel(made.env, made.job.id, "user")).toEqual({
      ok: true,
      outcome: "cancel_requested",
      state: "created",
    });
    let job = await reread(made.env, made.job.id);
    expect(job.state).toBe("created");
    expect(kinds(await ledgerOf(made.env, job.id))).toEqual(["hold"]);
    expect(job.cancel_requested_at).not.toBeNull();
    // The sweep does not take it either (it would hold one of its ten slots for ever).
    expect(await sweepComputeCancellations(made.env)).toMatchObject({ examined: 0, errors: [] });
    job = await reread(made.env, made.job.id);
    expect(job.state).toBe("created");
    expect(kinds(await ledgerOf(made.env, job.id))).toEqual(["hold"]);
    expect(fx.tapis.log).toHaveLength(0);
  });

  test("a partner job that has a Tapis job IS cancelled there: NEMAR owns every Tapis job", async () => {
    const s = await submittedJob();
    await drive(s.env, s.made.job.id, s.uuid, "RUNNING");
    await s.env.DB.prepare(
      "UPDATE compute_jobs SET source = 'partner', client_id = 'c1' WHERE id = ?1",
    )
      .bind(s.made.job.id)
      .run();
    await requestComputeCancel(s.env, s.made.job.id, "admin");
    expect((await reread(s.env, s.made.job.id)).state).toBe("cancelled");
    expect(fx.tapis.log.some((r) => r.route === "POST /v3/jobs/:uuid/cancel")).toBe(true);
  });

  test("a terminal job cannot be cancelled, and an unknown one is not found", async () => {
    const s = await submittedJob();
    await finishJob(s);
    expect((await requestComputeCancel(s.env, s.made.job.id, "user")).outcome).toBe("bad_state");
    expect(
      (await requestComputeCancel(s.env, "job_000000000000000000000000", "user")).outcome,
    ).toBe("job_not_found");
  });

  test("a cancel that arrives while the submit is in flight cancels the Tapis job the submit made", async () => {
    const made = await makeJob(fx);
    // The stand-in has accepted the submit; before the Worker hears, the person cancels the row.
    fx.proxy.afterNextSubmit(async () => {
      await requestComputeCancel(made.env, made.job.id, "user");
    });
    expect((await submitComputeJob(made.env, made.job.id)).ok).toBe(false);
    // The cancel met a lease and left its intent for the sweep (round 2 of #2041): the submit's own bind
    // turned the pending cancel into an orphan cancel, and the sweep ends the row.
    expect((await reread(made.env, made.job.id)).state).toBe("created");
    await sweepComputeCancellations(made.env);
    const job = await reread(made.env, made.job.id);
    expect(job.state).toBe("cancelled");
    expect(kinds(await ledgerOf(made.env, job.id))).toEqual(["hold", "release"]);
    // The row learned the Tapis job, and the Tapis job was cancelled: none is left running.
    const [only] = [...fx.tapis.jobs.values()];
    expect(job.tapis_uuid).toBe(only?.uuid ?? null);
    expect(only?.status).toBe("CANCELLED");
  });
});

// --- The records copy ----------------------------------------------------------------------------

// The bound is written out here, not imported: a test that reads the code's own constant passes at any value.
const FIVE_MIB = 5 * 1024 * 1024;

describe("copyResultRecords", () => {
  async function finishedJob() {
    const s = await submittedJob();
    fx.tapis.setOutput(s.uuid, "tapisjob.out", "the entry's own output\n");
    await finishJob(s, { outputs: [{ path: "r.txt", content: "r" }] });
    return { ...s, job: await reread(s.env, s.made.job.id) };
  }

  test("a finished job's launcher files and logs are in the records, under their record names", async () => {
    const s = await finishedJob();
    const records = fx.harness.records;
    const text = async (key: string) => (await (await records.get(key))?.text()) ?? null;
    const id = s.job.id;
    expect(s.job.result_records_at).not.toBeNull();
    for (const [from, to] of [
      ["result.json", recordKey(id, "result.json")],
      ["provenance.json", recordKey(id, "provenance.json")],
      ["manifest.json", recordKey(id, "result-manifest.json")],
      ["launcher.log", logKey(id, "launcher.log")],
    ] as const) {
      const source = await (await fx.harness.results.get(resultsLauncherKey(id, from)))?.text();
      expect(await text(to)).toBe(source as string);
    }
    expect(await text(logKey(id, "tapisjob.out"))).toBe("the entry's own output\n");
    // The manifest is `result-manifest.json` in the records and `manifest.json` nowhere there.
    expect(await records.head(`records/${id}/manifest.json`)).toBeNull();
  });

  test("a copy that died halfway is completed by the next call, and nothing is overwritten", async () => {
    const s = await finishedJob();
    const id = s.job.id;
    // Undo the stamp and one object, and plant a different record under another name: the retry must
    // write what is missing and leave what is there exactly as it is.
    await fx.harness.records.delete(logKey(id, "tapisjob.out"));
    await s.env.DB.prepare("UPDATE compute_jobs SET result_records_at = NULL WHERE id = ?")
      .bind(id)
      .run();
    const before = await (await fx.harness.records.get(recordKey(id, "result.json")))?.text();
    await fx.harness.records.delete(recordKey(id, "provenance.json"));
    await fx.harness.records.put(
      recordKey(id, "result.json"),
      new TextEncoder().encode("someone else's bytes"),
    );
    const written = await copyResultRecords(s.env, await reread(s.env, id));
    expect(written).toBe(2);
    expect(await (await fx.harness.records.get(recordKey(id, "result.json")))?.text()).toBe(
      "someone else's bytes",
    );
    expect(before).not.toBe("someone else's bytes");
    expect(await fx.harness.records.head(recordKey(id, "provenance.json"))).not.toBeNull();
    expect(await (await fx.harness.records.get(logKey(id, "tapisjob.out")))?.text()).toBe(
      "the entry's own output\n",
    );
    expect((await reread(s.env, id)).result_records_at).not.toBeNull();
    // And again: nothing more to write.
    expect(await copyResultRecords(s.env, await reread(s.env, id))).toBe(0);
  });

  test("a Tapis that cannot answer leaves the copy owed, and the tick finishes it", async () => {
    const s = await submittedJob();
    fx.tapis.setOutput(s.uuid, "tapisjob.out", "late log\n");
    await drive(s.env, s.made.job.id, s.uuid, "RUNNING");
    await playLauncher(fx, s.env, await reread(s.env, s.made.job.id), s.uuid, {});
    fx.tapis.advance(s.uuid, "FINISHED");
    setTapisTimes(fx, s.uuid, 30 * MINUTE, 0);
    // The read of the job works, the download of the log does not.
    fx.tapis.fail("GET /v3/jobs/:uuid/output/download/*", 503);
    await advanceComputeJob(s.env, s.made.job.id);
    let job = await reread(s.env, s.made.job.id);
    expect(job.state).toBe("finished");
    expect(job.result_records_at).toBeNull();
    expect(await fx.harness.records.head(logKey(job.id, "tapisjob.out"))).toBeNull();
    const tick = await runComputeAdvanceCron(s.env);
    expect(tick?.repaired).toBe(1);
    job = await reread(s.env, s.made.job.id);
    expect(job.result_records_at).not.toBeNull();
    expect(await (await fx.harness.records.get(logKey(job.id, "tapisjob.out")))?.text()).toBe(
      "late log\n",
    );
  });

  test("a job that never ran has nothing to copy and is still marked done", async () => {
    const made = await makeJob(fx);
    await requestComputeCancel(made.env, made.job.id, "user");
    expect((await reread(made.env, made.job.id)).result_records_at).not.toBeNull();
  });

  test("a Tapis log that does not exist is not an error: the copy is done, and no log is recorded", async () => {
    const s = await submittedJob();
    await finishJob(s);
    expect((await reread(s.env, s.made.job.id)).result_records_at).not.toBeNull();
    expect(await fx.harness.records.head(logKey(s.made.job.id, "tapisjob.out"))).toBeNull();
  });

  // Round 1 of #2041: the first test of the 5 MiB bound at all. The old test of this name never
  // supplied a log, so it passed with the bound deleted.
  test("a Tapis log of 5 MiB + 1 byte is copied as its FIRST 5 MiB and the records say it was cut; one of exactly 5 MiB is whole", async () => {
    const make = (size: number) => {
      const bytes = new Uint8Array(size).fill(0x61);
      bytes[0] = 0x62;
      bytes[size - 1] = 0x7a;
      return bytes;
    };
    const over = await submittedJob();
    fx.tapis.setOutput(over.uuid, "tapisjob.out", make(FIVE_MIB + 1));
    await finishJob(over);
    const cut = await fx.harness.records.get(logKey(over.made.job.id, "tapisjob.out"));
    const cutBytes = new Uint8Array((await cut?.arrayBuffer()) ?? new ArrayBuffer(0));
    expect(cutBytes.length).toBe(FIVE_MIB);
    expect(cutBytes[0]).toBe(0x62);
    expect(cutBytes[FIVE_MIB - 1]).toBe(0x61);
    expect(cut?.customMetadata).toEqual({ truncated: "1" });
    expect((await reread(over.env, over.made.job.id)).result_records_at).not.toBeNull();

    const exact = await submittedJob();
    fx.tapis.setOutput(exact.uuid, "tapisjob.out", make(FIVE_MIB));
    await finishJob(exact);
    const whole = await fx.harness.records.get(logKey(exact.made.job.id, "tapisjob.out"));
    const wholeBytes = new Uint8Array((await whole?.arrayBuffer()) ?? new ArrayBuffer(0));
    expect(wholeBytes.length).toBe(FIVE_MIB);
    expect(wholeBytes[FIVE_MIB - 1]).toBe(0x7a);
    expect(whole?.customMetadata ?? {}).toEqual({});
  });

  test("the launcher's own log is cut at 5 MiB the same way, and a launcher document over its bound is not copied while the copy still finishes", async () => {
    const s = await finishedJob();
    const id = s.job.id;
    await setPolicy(s.env.DB, fx.ownerId, {
      resultLimits: { ...DEFAULT_COMPUTE_POLICY.resultLimits, maxFiles: 1 },
    });
    const bound = outputsBodyLimitBytes(1);
    await fx.harness.results.put(
      resultsLauncherKey(id, "launcher.log"),
      new Uint8Array(FIVE_MIB + 10).fill(0x6c),
    );
    await fx.harness.results.put(
      resultsLauncherKey(id, "provenance.json"),
      new Uint8Array(bound + 1).fill(0x20),
    );
    await fx.harness.results.put(
      resultsLauncherKey(id, "manifest.json"),
      new Uint8Array(bound).fill(0x20),
    );
    for (const key of [
      logKey(id, "launcher.log"),
      recordKey(id, "provenance.json"),
      recordKey(id, RECORDS_RESULT_MANIFEST_FILE),
    ]) {
      await fx.harness.records.delete(key);
    }
    await s.env.DB.prepare("UPDATE compute_jobs SET result_records_at = NULL WHERE id = ?")
      .bind(id)
      .run();
    await copyResultRecords(s.env, await reread(s.env, id));
    const log = await fx.harness.records.get(logKey(id, "launcher.log"));
    expect(log?.size).toBe(FIVE_MIB);
    expect(log?.customMetadata).toEqual({ truncated: "1" });
    // A document one byte over its bound is not the launcher's: it is not copied, and it is not owed.
    expect(await fx.harness.records.head(recordKey(id, "provenance.json"))).toBeNull();
    // One exactly at its bound is copied whole.
    expect((await fx.harness.records.head(recordKey(id, RECORDS_RESULT_MANIFEST_FILE)))?.size).toBe(
      bound,
    );
    expect((await reread(s.env, id)).result_records_at).not.toBeNull();
  });

  for (const status of [401, 429, 500]) {
    test(`a log that could not be READ (HTTP ${status}) leaves the copy owed and nothing recorded for it`, async () => {
      const s = await submittedJob();
      fx.tapis.setOutput(s.uuid, "tapisjob.out", "a log\n");
      await drive(s.env, s.made.job.id, s.uuid, "RUNNING");
      await playLauncher(fx, s.env, await reread(s.env, s.made.job.id), s.uuid, {});
      fx.tapis.advance(s.uuid, "FINISHED");
      setTapisTimes(fx, s.uuid, 30 * MINUTE, 0);
      fx.tapis.fail("GET /v3/jobs/:uuid/output/download/*", status, 3);
      await advanceComputeJob(s.env, s.made.job.id);
      const job = await reread(s.env, s.made.job.id);
      expect(job.state).toBe("finished");
      expect(job.result_records_at).toBeNull();
      expect(await fx.harness.records.head(logKey(job.id, "tapisjob.out"))).toBeNull();
    });
  }
});

// --- Mail ----------------------------------------------------------------------------------------

describe("the results-ready mail", () => {
  test("a finished job mails its person ONE link to a page, never to a file", async () => {
    const s = await submittedJob();
    await finishJob(s);
    expect(fx.mail.mails).toHaveLength(1);
    const mail = fx.mail.mails[0];
    expect(mail?.subject).toBe("Your NEMAR compute job has finished");
    expect(mail?.html).toContain(`https://app.example.test/compute/jobs/${s.made.job.id}`);
    expect(mail?.html).not.toMatch(/X-Amz|jobs\/job_[0-9a-f]+\/outputs|report\.txt/);
    // A replay of the same finished job mails nobody again.
    await advanceComputeJob(s.env, s.made.job.id);
    expect(fx.mail.mails).toHaveLength(1);
  });

  test("a failed job, a pipeline job and a service account are not mailed", async () => {
    const failed = await submittedJob();
    await drive(failed.env, failed.made.job.id, failed.uuid, "RUNNING");
    fx.tapis.advance(failed.uuid, "FAILED", "JOB_LAUNCH_FAILURE");
    await advanceComputeJob(failed.env, failed.made.job.id);
    expect(fx.mail.mails).toHaveLength(0);

    const service = await submittedJob({ account: { username: "svc-account" } });
    await service.env.DB.prepare("UPDATE users SET account_kind = 'service' WHERE id = ?")
      .bind(service.made.accountId)
      .run();
    await finishJob(service);
    expect(fx.mail.mails).toHaveLength(0);
  });
});

// --- The tick ------------------------------------------------------------------------------------

describe("the 30-minute tick", () => {
  test("it does nothing, and says nothing, outside exact production", async () => {
    const made = await makeJob(fx);
    for (const environment of ["development", "staging", "test", undefined]) {
      expect(
        await runComputeAdvanceCron({ ...made.env, ENVIRONMENT: environment } as Bindings),
      ).toBeNull();
    }
    expect(fx.tapis.log).toHaveLength(0);
    expect((await reread(made.env, made.job.id)).state).toBe("created");
  });

  test("with no live jobs it reads the database and does nothing else, configured or not", async () => {
    const env = {
      ...fx.env(),
      TAPIS_AUTH_STRATEGY: undefined,
      COMPUTE_ENABLED: undefined,
    } as Bindings;
    expect(await runComputeAdvanceCron(env)).toMatchObject({
      examined: 0,
      submitted: 0,
      errors: [],
    });
    expect(fx.tapis.log).toHaveLength(0);
  });

  test("it submits a created job, then follows it, then settles it", async () => {
    const made = await makeJob(fx);
    expect(await runComputeAdvanceCron(made.env)).toMatchObject({ examined: 1, submitted: 1 });
    const job = await reread(made.env, made.job.id);
    expect(job.state).toBe("submitted");
    fx.tapis.advance(job.tapis_uuid as string, "RUNNING");
    expect(await runComputeAdvanceCron(made.env)).toMatchObject({ advanced: 1 });
    expect((await reread(made.env, made.job.id)).state).toBe("running");
    fx.tapis.advance(job.tapis_uuid as string, "FAILED", "JOB_LAUNCH_FAILURE");
    expect(await runComputeAdvanceCron(made.env)).toMatchObject({ advanced: 1 });
    expect((await reread(made.env, made.job.id)).state).toBe("failed");
  });

  test("it reads no switch: a live job is followed with compute switched off, but a created one is not submitted", async () => {
    const live = await submittedJob();
    const waiting = await makeJob(fx);
    const off = { ...live.env, COMPUTE_ENABLED: undefined } as Bindings;
    fx.tapis.advance(live.uuid, "RUNNING");
    const tick = await runComputeAdvanceCron(off);
    expect(tick?.submitted).toBe(0);
    expect(tick?.waiting).toBe(1);
    expect((await reread(live.env, live.made.job.id)).state).toBe("running");
    expect((await reread(live.env, waiting.job.id)).state).toBe("created");
  });

  test("ten rows a tick, the least recently read first, so every job is read in rotation", async () => {
    const jobs: Array<{ id: string; uuid: string }> = [];
    for (let i = 0; i < ADVANCE_ROWS_PER_TICK + 2; i++) {
      const s = await submittedJob();
      jobs.push({ id: s.made.job.id, uuid: s.uuid });
      // Each job was last examined a different time ago (the first the longest ago), as real jobs are.
      await s.env.DB.prepare(
        "UPDATE compute_jobs SET examined_at = datetime('now', ?1) WHERE id = ?2",
      )
        .bind(`-${200 - i} minutes`, s.made.job.id)
        .run();
    }
    expect(ADVANCE_ROWS_PER_TICK).toBe(10);
    const readUuids = () =>
      fx.tapis.log
        .filter((r) => r.route === "GET /v3/jobs/:uuid")
        .map((r) => r.path.split("/").pop() as string);
    const first = await runComputeAdvanceCron(fx.env());
    expect(first?.examined).toBe(10);
    // The ten read first are the ten read longest ago; the two newest are left for the next tick.
    expect(new Set(readUuids())).toEqual(new Set(jobs.slice(0, 10).map((j) => j.uuid)));
    fx.tapis.log.length = 0;
    const second = await runComputeAdvanceCron(fx.env());
    expect(second?.examined).toBe(10);
    // The two never read this round come first, before any job is read a second time.
    expect(readUuids().slice(0, 2).sort()).toEqual(
      jobs
        .slice(10)
        .map((j) => j.uuid)
        .sort(),
    );
  });

  test("a row that fails is recorded by a fixed word and its class, and the next row is taken up", async () => {
    const a = await submittedJob();
    const b = await submittedJob();
    fx.tapis.advance(a.uuid, "ARCHIVING");
    fx.tapis.advance(b.uuid, "ARCHIVING");
    await playLauncher(fx, a.env, await reread(a.env, a.made.job.id), a.uuid, {});
    await playLauncher(fx, b.env, await reread(b.env, b.made.job.id), b.uuid, {});
    fx.tapis.advance(a.uuid, "FINISHED");
    fx.tapis.advance(b.uuid, "FINISHED");
    // A storage fault aimed at ONE job: reading its launcher's files throws (a failing bucket, not
    // NEMAR logic). The other job's step must still run, and the failure is recorded by class only.
    const results = fx.harness.results;
    const faulty = new Proxy(results, {
      get(target, prop) {
        const value = Reflect.get(target, prop) as unknown;
        if (prop === "head" || prop === "get" || prop === "list") {
          return (key: unknown, ...rest: unknown[]) => {
            const text = typeof key === "string" ? key : JSON.stringify(key);
            if (text.includes(a.made.job.id)) throw new Error("storage fault");
            return (value as (...args: unknown[]) => unknown).call(target, key, ...rest);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as R2Bucket;
    const env = { ...fx.env(), COMPUTE_RESULTS: faulty } as Bindings;
    let tick = null as Awaited<ReturnType<typeof runComputeAdvanceCron>>;
    const lines = await logged(async () => {
      tick = await runComputeAdvanceCron(env);
    });
    expect(tick).toMatchObject({
      examined: 2,
      errors: ["row_failed"],
      errorClass: "Error",
      advanced: 1,
    });
    // Its step failed before anything was written: the row is exactly as it was.
    expect((await reread(env, a.made.job.id)).state).toBe("submitted");
    expect((await reread(env, b.made.job.id)).state).toBe("finished");
    expect(lines.join("\n")).not.toContain("storage fault");
    expect(lines.some((l) => l.includes(a.made.job.id) && l.includes("(Error)"))).toBe(true);
  });

  test("a live job Tapis has not answered for in a day is `unreported`, and returns when Tapis speaks", async () => {
    const s = await submittedJob();
    const id = s.made.job.id;
    await drive(s.env, id, s.uuid, "RUNNING");
    await s.env.DB.prepare(
      "UPDATE compute_jobs SET tapis_synced_at = datetime('now', '-25 hours') WHERE id = ?",
    )
      .bind(id)
      .run();
    fx.tapis.down();
    expect(await runComputeAdvanceCron(s.env)).toMatchObject({ unreachable: 1 });
    expect((await reread(s.env, id)).state).toBe("unreported");
    // It is still live: the tick keeps reading it.
    fx.tapis.up();
    expect(await runComputeAdvanceCron(s.env)).toMatchObject({ advanced: 1 });
    expect((await reread(s.env, id)).state).toBe("running");
    // A job read less than a day ago is not marked, however many reads fail.
    fx.tapis.down();
    await runComputeAdvanceCron(s.env);
    expect((await reread(s.env, id)).state).toBe("running");
    fx.tapis.up();
  });

  /** Take the job's last good read back by `days` days: the clock the lost rules count from. */
  async function ageRead(env: Bindings, id: string, days: number) {
    await env.DB.prepare(
      "UPDATE compute_jobs SET tapis_synced_at = datetime('now', ?2) WHERE id = ?1",
    )
      .bind(id, `-${days} days`)
      .run();
  }
  const liveCount = async (env: Bindings, accountId: number) =>
    (
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM compute_jobs WHERE account_id = ?1 AND state IN ('created', 'uploading', 'submitted', 'queued', 'running', 'archiving', 'unreported')",
      )
        .bind(accountId)
        .first<{ n: number }>()
    )?.n;

  test("a job that NEVER STARTED whose record answers 404 for a week ends `failed`, `tapis_record_lost`: released with no charge, once, flagged, slot freed (MUTATION: drop the week rule)", async () => {
    const s = await submittedJob();
    const id = s.made.job.id;
    // Six days: unreported (a day), not lost.
    await ageRead(s.env, id, 6);
    fx.tapis.fail("GET /v3/jobs/:uuid", 404, 50);
    await runComputeAdvanceCron(s.env);
    expect((await reread(s.env, id)).state).toBe("unreported");
    expect(kinds(await ledgerOf(s.env, id))).toEqual(["hold"]);
    // Past the week it is lost.
    await ageRead(s.env, id, 8);
    const lines = await logged(async () => {
      await runComputeAdvanceCron(s.env);
    });
    let job = await reread(s.env, id);
    expect([job.state, job.failure_code, job.platform_failure, job.flag_mismatch]).toEqual([
      "failed",
      "tapis_record_lost",
      1,
      1,
    ]);
    expect(job.settled_provisional_at).not.toBeNull();
    expect(job.charged_milli).toBe(0);
    expect(job.retention_until).not.toBeNull();
    expect(kinds(await ledgerOf(s.env, id))).toEqual(["hold", "release"]);
    // The line names no job.
    expect(lines.some((l) => l.includes("tapis_record_lost"))).toBe(true);
    expect(lines.some((l) => l.includes("tapis_record_lost") && l.includes(id))).toBe(false);
    const pool = await poolOf(s.env, s.made.accountId);
    expect([pool.held_milli, pool.charged_milli]).toEqual([0, 0]);
    expect((await peopleBudget(s.env)).held_milli).toBe(0);
    // A second tick, the cascade's cancel and an admin advance change nothing: released exactly once.
    await runComputeAdvanceCron(s.env);
    expect(await requestComputeCancel(s.env, id, "admin")).toMatchObject({
      ok: false,
      outcome: "bad_state",
    });
    await advanceComputeJob(s.env, id);
    job = await reread(s.env, id);
    expect([job.state, job.failure_code]).toEqual(["failed", "tapis_record_lost"]);
    expect(kinds(await ledgerOf(s.env, id))).toEqual(["hold", "release"]);
    expect(await liveCount(s.env, s.made.accountId)).toBe(0);
  });

  test("a job that RAN and is then lost is CHARGED once, not released: the code's own rule is that a job that ran is never released (MUTATION: release it)", async () => {
    const s = await submittedJob();
    const id = s.made.job.id;
    await drive(s.env, id, s.uuid, "RUNNING");
    expect((await reread(s.env, id)).started_at).not.toBeNull();
    // It started 30 minutes ago by the record; the record then goes.
    await s.env.DB.prepare(
      "UPDATE compute_jobs SET started_at = datetime('now', '-30 minutes') WHERE id = ?",
    )
      .bind(id)
      .run();
    await ageRead(s.env, id, 8);
    fx.tapis.fail("GET /v3/jobs/:uuid", 404, 50);
    await runComputeAdvanceCron(s.env);
    let job = await reread(s.env, id);
    expect([job.state, job.failure_code, job.flag_mismatch]).toEqual([
      "failed",
      "tapis_record_lost",
      1,
    ]);
    expect(kinds(await ledgerOf(s.env, id))).toEqual(["hold", "charge"]);
    // Thirty minutes of four cores is 2 SU, give or take the seconds the test took.
    expect(job.charged_milli).toBeGreaterThanOrEqual(2000);
    expect(job.charged_milli).toBeLessThanOrEqual(2100);
    const pool = await poolOf(s.env, s.made.accountId);
    expect([pool.held_milli, pool.charged_milli]).toEqual([0, job.charged_milli]);
    expect((await peopleBudget(s.env)).held_milli).toBe(0);
    // Idempotent: another tick and an advance charge nothing more.
    await runComputeAdvanceCron(s.env);
    await advanceComputeJob(s.env, id);
    job = await reread(s.env, id);
    expect(kinds(await ledgerOf(s.env, id))).toEqual(["hold", "charge"]);
    expect((await poolOf(s.env, s.made.accountId)).charged_milli).toBe(job.charged_milli);
  });

  test("other evidence of use (a Slurm id) charges the contract's minimum; a lost job is never charged above the hold", async () => {
    const s = await submittedJob();
    const id = s.made.job.id;
    await s.env.DB.prepare(
      "UPDATE compute_jobs SET slurm_job_id = '4242', state = 'queued', started_at = NULL WHERE id = ?",
    )
      .bind(id)
      .run();
    await ageRead(s.env, id, 8);
    fx.tapis.fail("GET /v3/jobs/:uuid", 404, 50);
    await runComputeAdvanceCron(s.env);
    const job = await reread(s.env, id);
    expect([job.state, job.failure_code]).toEqual(["failed", "tapis_record_lost"]);
    expect(kinds(await ledgerOf(s.env, id))).toEqual(["hold", "charge"]);
    expect(job.charged_milli).toBeGreaterThan(0);
    expect(job.charged_milli).toBeLessThanOrEqual(job.held_milli);
  });

  test("a read that is REFUSED, malformed or down for a week never ends a job as lost: it stays `unreported` and the line is an error (MUTATION: end on any failed read)", async () => {
    for (const mode of ["403", "nonjson", "down"] as const) {
      const s = await submittedJob();
      const id = s.made.job.id;
      await drive(s.env, id, s.uuid, "RUNNING");
      await ageRead(s.env, id, 8);
      if (mode === "403") fx.tapis.fail("GET /v3/jobs/:uuid", 403, 50);
      else if (mode === "nonjson") fx.tapis.nonJson("GET /v3/jobs/:uuid", 50);
      else fx.tapis.down();
      const lines = await logged(async () => {
        await runComputeAdvanceCron(s.env);
      });
      fx.tapis.up();
      const job = await reread(s.env, id);
      expect([mode, job.state, job.failure_code]).toEqual([mode, "unreported", null]);
      expect(kinds(await ledgerOf(s.env, id))).toEqual(["hold"]);
      expect(lines.some((l) => l.includes("unreadable_for_a_week"))).toBe(true);
    }
  });

  test("a job Tapis ANSWERS every day with a word NEMAR does not know is never lost: a 404 after day 7 leaves it `unreported` (MUTATION: base the clock on the last usable read only)", async () => {
    const s = await submittedJob();
    const id = s.made.job.id;
    await drive(s.env, id, s.uuid, "RUNNING");
    const stored = fx.tapis.jobs.get(s.uuid);
    if (!stored) throw new Error("no tapis job");
    stored.status = "SOMETHING_NEW";
    stored.record.status = "SOMETHING_NEW";
    await ageRead(s.env, id, 8);
    await runComputeAdvanceCron(s.env);
    let job = await reread(s.env, id);
    expect([job.state, job.tapis_status]).toEqual(["unreported", "SOMETHING_NEW"]);
    // An administrator is shown the word, and the view is the contract's.
    const view = jobView(job);
    expect(view.tapis_status).toBe("SOMETHING_NEW");
    expect(ComputeJobViewSchema.safeParse(view).success).toBe(true);
    expect(view.flags).toEqual([]);
    // The record then goes: Tapis answered, so this is not a lost record, however old the last usable read.
    fx.tapis.fail("GET /v3/jobs/:uuid", 404, 50);
    await runComputeAdvanceCron(s.env);
    job = await reread(s.env, id);
    expect([job.state, job.failure_code]).toEqual(["unreported", null]);
    expect(kinds(await ledgerOf(s.env, id))).toEqual(["hold"]);
  });

  test("a lost job is recorded as an ORPHAN: the existing retry cancels it once Tapis answers (MUTATION: do not record it)", async () => {
    const s = await submittedJob();
    const id = s.made.job.id;
    await ageRead(s.env, id, 8);
    // The record is not served (404), but the job is in fact still there.
    fx.tapis.fail("GET /v3/jobs/:uuid", 404, 1);
    await runComputeAdvanceCron(s.env);
    expect((await reread(s.env, id)).orphan_tapis_uuid).toBe(s.uuid);
    expect(fx.tapis.jobs.get(s.uuid)?.status).not.toBe("CANCELLED");
    const swept = await sweepComputeCancellations(s.env);
    expect(swept).toMatchObject({ cancel_failed: 0, errors: [] });
    expect(fx.tapis.jobs.get(s.uuid)?.status).toBe("CANCELLED");
    expect((await reread(s.env, id)).orphan_tapis_uuid).toBeNull();
    // Cancelled once: nothing more is asked.
    await sweepComputeCancellations(s.env);
    expect(fx.tapis.log.filter((r) => r.route === "POST /v3/jobs/:uuid/cancel")).toHaveLength(1);
  });

  test("a cancel that answers 404 AND a read-back that answers 404 end the job as lost, but only when its last good read is over a day old; either alone does not (MUTATION: drop the age)", async () => {
    // 404 on the cancel only: the read finds the job, so it is not lost, and the job still runs.
    const a = await submittedJob();
    await drive(a.env, a.made.job.id, a.uuid, "RUNNING");
    fx.tapis.fail("POST /v3/jobs/:uuid/cancel", 404);
    await requestComputeCancel(a.env, a.made.job.id, "user");
    const ja = await reread(a.env, a.made.job.id);
    expect([ja.state, ja.failure_code]).toEqual(["running", null]);
    // 404 on the read-back only: the cancel was accepted, so nothing is lost.
    const b = await submittedJob();
    await drive(b.env, b.made.job.id, b.uuid, "RUNNING");
    fx.tapis.fail("GET /v3/jobs/:uuid", 404);
    await requestComputeCancel(b.env, b.made.job.id, "user");
    expect((await reread(b.env, b.made.job.id)).failure_code).toBeNull();
    // Both 404 on a job read a moment ago: a wrong-tenant 404 cannot end it at once.
    const fresh = await submittedJob();
    await drive(fresh.env, fresh.made.job.id, fresh.uuid, "RUNNING");
    fx.tapis.fail("POST /v3/jobs/:uuid/cancel", 404);
    fx.tapis.fail("GET /v3/jobs/:uuid", 404);
    await requestComputeCancel(fresh.env, fresh.made.job.id, "user");
    const jf = await reread(fresh.env, fresh.made.job.id);
    expect([jf.state, jf.failure_code]).toEqual(["running", null]);
    // Both 404 on a job not read for two days: Tapis has no such job.
    const c = await submittedJob();
    await drive(c.env, c.made.job.id, c.uuid, "RUNNING");
    await ageRead(c.env, c.made.job.id, 2);
    fx.tapis.fail("POST /v3/jobs/:uuid/cancel", 404);
    fx.tapis.fail("GET /v3/jobs/:uuid", 404);
    await requestComputeCancel(c.env, c.made.job.id, "user");
    const lost = await reread(c.env, c.made.job.id);
    expect([lost.state, lost.failure_code, lost.flag_mismatch]).toEqual([
      "failed",
      "tapis_record_lost",
      1,
    ]);
    // It ran (a start time was read), so it is charged, not released.
    expect(kinds(await ledgerOf(c.env, c.made.job.id))).toEqual(["hold", "charge"]);
  });

  test("a terminal row whose copy is not made in the three days it is retried is COUNTED `copy_abandoned`, flagged for an administrator whatever its flag was, and the line is error level (MUTATION: move the boundary, count nothing, or count only unflagged rows)", async () => {
    const inside = await submittedJob();
    await finishJob(inside);
    const outside = await submittedJob();
    await finishJob(outside);
    // Neither copy was made; one ended two days and 23 hours ago, the other three days and an hour ago.
    for (const [s, ago] of [
      [inside, "-71 hours"],
      [outside, "-73 hours"],
    ] as const) {
      await s.env.DB.prepare(
        "UPDATE compute_jobs SET result_records_at = NULL, ended_at = datetime('now', ?2) WHERE id = ?1",
      )
        .bind(s.made.job.id, ago)
        .run();
    }
    expect(await countCopyAbandoned(fx.env().DB)).toBe(1);
    // The row inside the window is on the retry list; the abandoned one is not.
    const listed = (
      await inside.env.DB.prepare(UNCOPIED_TERMINAL_SQL).bind(10).all<{ id: string }>()
    ).results.map((r) => r.id);
    expect(listed).toContain(inside.made.job.id);
    expect(listed).not.toContain(outside.made.job.id);
    let tick = null as Awaited<ReturnType<typeof runComputeAdvanceCron>>;
    await logged(async () => {
      tick = await runComputeAdvanceCron(inside.env);
    });
    expect(tick).toMatchObject({ copy_abandoned: 1, errors: [] });
    const line = tick ? computeAdvanceLogLine(tick) : null;
    expect(line?.level).toBe("error");
    expect(line?.line).toContain("copy_abandoned=1");
    expect(line?.line).not.toContain(outside.made.job.id);
    // The row past the window is flagged for an administrator; the one inside it is not.
    expect((await reread(inside.env, outside.made.job.id)).flag_mismatch).toBe(1);
    expect((await reread(inside.env, inside.made.job.id)).flag_mismatch).toBe(0);
    // The count does not depend on the flag: the next tick reports the row again while it is recent.
    const again = await runComputeAdvanceCron(inside.env);
    expect(again).toMatchObject({ copy_abandoned: 1 });
    // A row BORN flagged (a lost record is) is abandoned all the same, flag or no flag.
    const born = await submittedJob();
    await finishJob(born);
    await born.env.DB.prepare(
      "UPDATE compute_jobs SET result_records_at = NULL, flag_mismatch = 1, ended_at = datetime('now', '-4 days') WHERE id = ?1",
    )
      .bind(born.made.job.id)
      .run();
    expect(await countCopyAbandoned(fx.env().DB)).toBe(2);
    expect(await runComputeAdvanceCron(inside.env)).toMatchObject({ copy_abandoned: 2 });
    // After a month the tick stops reporting it (a standing error line for years would be noise), and the
    // running total an administrator is shown still counts it.
    await born.env.DB.prepare(
      "UPDATE compute_jobs SET ended_at = datetime('now', '-40 days') WHERE id = ?1",
    )
      .bind(born.made.job.id)
      .run();
    expect(await runComputeAdvanceCron(inside.env)).toMatchObject({ copy_abandoned: 1 });
    expect(await countCopyAbandoned(fx.env().DB)).toBe(2);
  });

  test("a tick where Tapis cannot be read for ANY row still logs, at warn level (MUTATION: leave the line null)", async () => {
    const s = await submittedJob();
    await drive(s.env, s.made.job.id, s.uuid, "RUNNING");
    fx.tapis.down();
    const tick = await runComputeAdvanceCron(s.env);
    fx.tapis.up();
    expect(tick).toMatchObject({ examined: 1, unreachable: 1, advanced: 0, repaired: 0 });
    const log = tick ? computeAdvanceLogLine(tick) : null;
    expect(log?.level).toBe("warn");
    expect(log?.line).toContain("unreachable=1");
  });

  test("`repaired` counts what a repair FINISHED: a copy that fails is `repair_attempted`, and the repair that works later is `repaired` (MUTATION: count every attempt)", async () => {
    const s = await submittedJob();
    await finishJob(s);
    const id = s.made.job.id;
    await s.env.DB.prepare("UPDATE compute_jobs SET result_records_at = NULL WHERE id = ?")
      .bind(id)
      .run();
    // The copy was never made (nothing is in the records), and the bucket refuses every write.
    for (const prefix of [`records/${id}/`, `logs/${id}/`]) {
      const listed = await fx.harness.records.list({ prefix });
      if (listed.objects.length > 0) {
        await fx.harness.records.delete(listed.objects.map((o) => o.key));
      }
    }
    const refusing = new Proxy(s.env.COMPUTE_RECORDS as R2Bucket, {
      get(target, prop) {
        if (prop === "put") return () => Promise.reject(new Error("storage fault"));
        const value = Reflect.get(target, prop) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const failing = { ...s.env, COMPUTE_RECORDS: refusing } as Bindings;
    const first = await runComputeAdvanceCron(failing);
    expect(first).toMatchObject({ repaired: 0, repair_attempted: 1, errors: [] });
    expect((await reread(s.env, id)).result_records_at).toBeNull();
    expect((first ? computeAdvanceLogLine(first) : null)?.level).toBe("warn");
    const second = await runComputeAdvanceCron(s.env);
    expect(second).toMatchObject({ repaired: 1, repair_attempted: 0 });
    expect((await reread(s.env, id)).result_records_at).not.toBeNull();
  });

  test("the webhook nonce is cleared one day after the job is terminal, and not before", async () => {
    const s = await submittedJob();
    await finishJob(s);
    const id = s.made.job.id;
    expect((await reread(s.env, id)).webhook_nonce).not.toBeNull();
    await runComputeAdvanceCron(s.env);
    expect((await reread(s.env, id)).webhook_nonce).not.toBeNull();
    await s.env.DB.prepare(
      "UPDATE compute_jobs SET ended_at = datetime('now', '-25 hours') WHERE id = ?",
    )
      .bind(id)
      .run();
    expect(await runComputeAdvanceCron(s.env)).toMatchObject({ cleared: 1 });
    expect((await reread(s.env, id)).webhook_nonce).toBeNull();
  });

  test("a terminal row whose settlement is owed is repaired by the tick", async () => {
    const s = await submittedJob();
    const id = s.made.job.id;
    await drive(s.env, id, s.uuid, "RUNNING");
    setTapisTimes(fx, s.uuid, 30 * MINUTE, null);
    fx.tapis.advance(s.uuid, "FAILED", "JOB_LAUNCH_FAILURE");
    await s.env.DB.prepare(
      "UPDATE compute_jobs SET state = 'failed', failure_code = 'launch_failed', ended_at = datetime('now') WHERE id = ?",
    )
      .bind(id)
      .run();
    expect(await runComputeAdvanceCron(s.env)).toMatchObject({ repaired: 1 });
    expect((await reread(s.env, id)).settled_provisional_at).not.toBeNull();
    expect(kinds(await ledgerOf(s.env, id))).toEqual(["hold", "charge"]);
  });
});

// --- What reaches a log --------------------------------------------------------------------------

describe("logs", () => {
  test("no token, address, path, secret or job output reaches a log, through a full lifecycle with failures", async () => {
    let token = "";
    let launchValue = "";
    let otherToken = "";
    let otherLaunchValue = "";
    const lines = await logged(async () => {
      const s = await submittedJob();
      token = jobTokenSeenByTapis(fx, s.uuid);
      launchValue = launchSpecEnvSeenByTapis(fx, s.uuid);
      fx.tapis.fail("GET /v3/jobs/:uuid", 503);
      await advanceComputeJob(s.env, s.made.job.id);
      await finishJob(s, { outputs: [{ path: "secret-name-path.txt", content: "x" }] });
      fx.tapis.fail("POST /v3/jobs/submit", 503);
      const other = await makeJob(fx);
      await submitComputeJob(other.env, other.job.id);
      // The failed submit built the launch value and logged `submit_unclear`: it is that job's secrets a
      // leak there would carry. A retry succeeds, and the token is a function of the job and its nonce,
      // so the stand-in then holds exactly the value the failed attempt built.
      expect(await submitComputeJob(other.env, other.job.id)).toMatchObject({ ok: true });
      const sent = (await reread(other.env, other.job.id)).tapis_uuid as string;
      otherToken = jobTokenSeenByTapis(fx, sent);
      otherLaunchValue = launchSpecEnvSeenByTapis(fx, sent);
    });
    const joined = lines.join("\n");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(otherToken).toMatch(/^[0-9a-f]{64}$/);
    // The encoded launch value holds the token, and the plain token is no longer a substring of it.
    expect(isShellInertEnvValue(launchValue)).toBe(true);
    expect(isShellInertEnvValue(otherLaunchValue)).toBe(true);
    const forbidden = [
      // Each job's token in every form: plain, the whole encoded value, and its three alignments.
      ...launchSecretForms(token, launchValue),
      ...launchSecretForms(otherToken, otherLaunchValue),
      CALLBACK_SECRET,
      "secret-name-path.txt",
      fx.tapis.password,
      fx.tapis.username,
      "NEMAR_LAUNCH_SPEC",
      "X-Amz",
      "/webhooks/tapis/",
      fx.tapis.url,
    ];
    for (const word of forbidden) expect([word, joined.includes(word)]).toEqual([word, false]);
    // The lines that were written name a job id and a fixed word, and nothing else.
    expect(lines.some((l) => l.includes("readback_failed"))).toBe(true);
    expect(lines.some((l) => l.includes("submit_unclear"))).toBe(true);
  });
});
