/**
 * One job's whole life through the REAL entry points, and the entry points racing one another (epic
 * #2005 phase A5, #2010; ADR 0118, round 1 of the review of PR #2041). Nothing here calls a lifecycle
 * service for a step a route owns: the launcher is a client of the real routes over a real loopback
 * port, with presigned PUTs to the real local S3 interface; the status changes reach the Worker as
 * the Tapis stand-in's own webhooks; the sign-in and the links go through the real middleware.
 * `playLauncher` (which writes the launcher's files into the bucket directly and stamps
 * `outputs_completed_at`) is NOT used in this file. The Tapis tenant is the A4 stand-in, no response of
 * which was recorded from a real tenant.
 *
 * What is pinned:
 *  - the full path: hold, submit (no archive fields), every Tapis status in order reaching the row,
 *    the launcher's outputs and complete through the routes, FINISHED verified, settled once, records
 *    copied, the results-ready mail sent once, and the owner's links returning the bytes;
 *  - the race: the webhook route, the tick and a cancel, all at once, interleaved by a database whose
 *    statements each take a round trip, leave ONE terminal state and ONE closing ledger entry, and a
 *    replay of each changes nothing. HONEST LIMIT: this test did NOT kill the mutants that drop
 *    `state = <from>` from the live transition or make the settlement gate always true when they were
 *    tried (the interleaving they need is not one real entry points reach reliably). Those mutants are
 *    killed by `compute-lifecycle.test.ts` and `compute-lifecycle-money.test.ts`, which hand a writer a
 *    stale row to force it. What this adds is that the real entry points, through the real router, keep
 *    the invariants under overlap.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { Server } from "bun";
import { LAUNCHER_FILES, RECORDS_RESULT_MANIFEST_FILE } from "../../shared/contract/compute";
import { LaunchSpecSchema } from "../../shared/contract/compute-launch";
import { runComputeAdvanceCron } from "../src/services/compute-advance";
import { requestComputeCancel, submitComputeJob } from "../src/services/compute-lifecycle";
import { logKey, recordKey } from "../src/services/compute-records";
import { signComputeToken } from "../src/services/compute-tokens";
import { hashApiKey } from "../src/services/token";
import type { Bindings } from "../src/types/bindings";
import {
  CALLBACK_SECRET,
  type LifecycleFixture,
  MINUTE,
  RUNTIME_IMAGE_DIGEST,
  launchSpecTextSeenByTapis,
  makeJob,
  reread,
  setTapisTimes,
  startLifecycleFixture,
} from "./helpers/compute-lifecycle-fixture";
import { type RoutesHandle, makeRoutesApp, serveRoutes } from "./helpers/compute-routes-app";
import { roundTripD1 } from "./helpers/compute-seed";

let fx: LifecycleFixture;
let handle: RoutesHandle;
let server: Server;
let workerEnv: Bindings;

beforeAll(async () => {
  fx = await startLifecycleFixture();
  handle = makeRoutesApp();
}, 120_000);

beforeEach(async () => {
  await fx.reset();
  server = serveRoutes(handle, () => workerEnv);
  workerEnv = fx.env({ API_BASE_URL: `http://127.0.0.1:${server.port}` });
});

afterEach(() => {
  server.stop(true);
});

afterAll(async () => {
  await fx?.dispose();
}, 30_000);

const encoder = new TextEncoder();
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const base = () => `http://127.0.0.1:${server.port}`;

let keySeq = 0;
async function keyFor(accountId: number): Promise<string> {
  const key = `full-path-key-${++keySeq}-0123456789abcdef0123456789abcdef`;
  fx.harness.db
    .query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)")
    .run(accountId, await hashApiKey(key), key.slice(0, 8));
  return key;
}

async function ledgerKinds(jobId: string): Promise<string[]> {
  return (
    await workerEnv.DB.prepare("SELECT kind FROM compute_ledger WHERE job_id = ?1 ORDER BY id")
      .bind(jobId)
      .all<{ kind: string }>()
  ).results.map((r) => r.kind);
}

/** What the launcher does with the routes, from the launch specification it was handed. */
async function runLauncher(
  uuid: string,
  jobId: string,
  files: Array<{ path: string; content: string }>,
) {
  const spec = LaunchSpecSchema.parse(JSON.parse(launchSpecTextSeenByTapis(fx, uuid)));
  const launcherText: Record<string, string> = {
    [LAUNCHER_FILES.result]: JSON.stringify({
      job_id: jobId,
      failure_code: null,
      detail: null,
      exit_number: 0,
      entry_exit_code: 0,
    }),
    [LAUNCHER_FILES.provenance]: JSON.stringify({
      job_id: jobId,
      // What the launcher hashed: the value it was handed, never a number the Worker stored.
      launch_spec_digest: sha(launchSpecTextSeenByTapis(fx, uuid)),
      bundle_digest: null,
      image: { uri: spec.image.uri, digest: RUNTIME_IMAGE_DIGEST },
      runtime_version: "full-path 1.0",
      staging: [],
      timings: { run: 1 },
      slurm_job_id: null,
      entry_exit_code: 0,
    }),
    [LAUNCHER_FILES.manifest]: JSON.stringify({
      job_id: jobId,
      files: files.map((f) => ({
        path: f.path,
        size: encoder.encode(f.content).length,
        sha256: sha(f.content),
      })),
    }),
    [LAUNCHER_FILES.log]: "launcher log line\n",
  };
  const headers = { "Content-Type": "application/json", "X-Compute-Job-Token": spec.job_token };
  const outputs = await fetch(`${spec.api_base}/compute/jobs/${jobId}/outputs`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      outputs: files.map((f) => ({
        path: f.path,
        size: encoder.encode(f.content).length,
        sha256: sha(f.content),
      })),
      launcher: Object.values(LAUNCHER_FILES).map((name) => ({
        name,
        size: encoder.encode(launcherText[name] as string).length,
      })),
    }),
  });
  expect(outputs.status).toBe(200);
  const { uploads } = (await outputs.json()) as { uploads: Array<{ path: string; url: string }> };
  for (const u of uploads) {
    const content = u.path.startsWith("outputs/")
      ? (files.find((f) => `outputs/${f.path}` === u.path)?.content as string)
      : (launcherText[u.path.replace("launcher/", "")] as string);
    expect((await fetch(u.url, { method: "PUT", body: encoder.encode(content) })).status).toBe(200);
  }
  const complete = await fetch(`${spec.api_base}/compute/jobs/${jobId}/outputs/complete`, {
    method: "POST",
    headers,
  });
  expect(complete.status).toBe(200);
}

describe("one job's whole life, through the entry points", () => {
  test("hold, submit, every status by webhook, the launcher through the routes, verified, settled once, copied, mailed once, and linked", async () => {
    const made = await makeJob(fx, { env: workerEnv });
    const id = made.job.id;
    expect(await ledgerKinds(id)).toEqual(["hold"]);

    // Submit: once, no archive fields, a webhook subscribed.
    expect(await submitComputeJob(workerEnv, id)).toEqual({ ok: true, outcome: "submitted" });
    const submits = fx.tapis.log.filter((r) => r.route === "POST /v3/jobs/submit");
    expect(submits).toHaveLength(1);
    const sent = JSON.parse(submits[0]?.body ?? "{}");
    for (const key of ["archiveSystemId", "archiveSystemDir", "archiveMode", "archiveOnAppError"]) {
      expect(sent).not.toHaveProperty(key);
    }
    const uuid = (await reread(workerEnv, id)).tapis_uuid as string;

    // Every status, in order, reaches the row through the webhook ROUTE (the stand-in posts to the
    // address the Worker subscribed).
    const expected: Array<[string, string]> = [
      ["PROCESSING_INPUTS", "submitted"],
      ["STAGING_INPUTS", "submitted"],
      ["STAGING_JOB", "submitted"],
      ["SUBMITTING_JOB", "submitted"],
      ["QUEUED", "queued"],
      ["RUNNING", "running"],
      ["ARCHIVING", "archiving"],
    ];
    for (const [status, state] of expected) {
      fx.tapis.advance(uuid, status);
      expect((await fx.tapis.fireWebhook(uuid)).status).toBe(200);
      const row = await reread(workerEnv, id);
      expect([status, row.state, row.tapis_status]).toEqual([status, state, status]);
    }
    expect(await ledgerKinds(id)).toEqual(["hold"]);

    // The launcher: outputs, the PUTs, complete.
    const files = [
      { path: "report.txt", content: "the report" },
      { path: "deep/table.csv", content: "a,b\n1,2\n" },
    ];
    await runLauncher(uuid, id, files);
    expect((await reread(workerEnv, id)).outputs_completed_at).not.toBeNull();

    // FINISHED by webhook: verified, settled once, copied, mailed once.
    fx.tapis.advance(uuid, "FINISHED");
    setTapisTimes(fx, uuid, 30 * MINUTE, 0);
    const finishedRecord = fx.tapis.jobs.get(uuid)?.record as Record<string, unknown>;
    finishedRecord.remoteResultInfo = "0";
    expect((await fx.tapis.fireWebhook(uuid)).status).toBe(200);
    const job = await reread(workerEnv, id);
    expect(job.state).toBe("finished");
    expect(job.results_verified_at).not.toBeNull();
    expect(job.settled_provisional_at).not.toBeNull();
    expect(job.charged_milli).toBe(2000);
    expect(await ledgerKinds(id)).toEqual(["hold", "charge"]);
    expect(job.result_records_at).not.toBeNull();
    for (const key of [
      recordKey(id, "result.json"),
      recordKey(id, "provenance.json"),
      recordKey(id, RECORDS_RESULT_MANIFEST_FILE),
      logKey(id, "launcher.log"),
    ]) {
      expect([key, (await fx.harness.records.head(key)) !== null]).toEqual([key, true]);
    }
    expect(fx.mail.mails).toHaveLength(1);
    expect(fx.mail.mails[0]?.html).toContain(`/compute/jobs/${id}`);

    // The tick and a replayed webhook change nothing.
    expect((await fx.tapis.fireWebhook(uuid)).status).toBe(200);
    await runComputeAdvanceCron(workerEnv);
    expect(await ledgerKinds(id)).toEqual(["hold", "charge"]);
    expect(fx.mail.mails).toHaveLength(1);

    // The owner's links return the bytes.
    const key = await keyFor(made.accountId);
    const links = await fetch(`${base()}/compute/jobs/${id}/links`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(links.status).toBe(200);
    const body = (await links.json()) as { links: Array<{ path: string; url: string }> };
    expect(body.links.map((l) => l.path)).toEqual(["deep/table.csv", "report.txt"]);
    for (const l of body.links) {
      const original = files.find((f) => f.path === l.path)?.content;
      expect(await (await fetch(l.url)).text()).toBe(original as string);
    }
  });
});

describe("the entry points racing one another", () => {
  /**
   * Every statement takes a round trip, as D1's network does, so a read-then-write is not atomic here
   * and the three entry points really interleave. `to` is what Tapis says when they all read it.
   */
  async function race(to: "ARCHIVING" | "FAILED") {
    const made = await makeJob(fx, { env: workerEnv });
    const id = made.job.id;
    expect(await submitComputeJob(workerEnv, id)).toMatchObject({ ok: true });
    const uuid = (await reread(workerEnv, id)).tapis_uuid as string;
    fx.tapis.advance(uuid, "RUNNING");
    expect((await fx.tapis.fireWebhook(uuid)).status).toBe(200);
    if (to === "FAILED") fx.tapis.advance(uuid, "FAILED", "JOB_LAUNCH_FAILURE");
    else fx.tapis.advance(uuid, "ARCHIVING");
    setTapisTimes(fx, uuid, 30 * MINUTE, 0);
    const token = await signComputeToken(
      "webhook",
      { jobId: id, nonce: (await reread(workerEnv, id)).webhook_nonce as string },
      CALLBACK_SECRET,
    );
    const saved = workerEnv;
    workerEnv = { ...workerEnv, DB: roundTripD1(workerEnv.DB) } as Bindings;
    let results: [Response, unknown, unknown, Response];
    try {
      results = await Promise.all([
        fetch(`${base()}/webhooks/tapis/${id}/${token}`, { method: "POST", body: "{}" }),
        runComputeAdvanceCron(workerEnv),
        requestComputeCancel(workerEnv, id, "user"),
        fetch(`${base()}/webhooks/tapis/${id}/${token}`, { method: "POST", body: "{}" }),
      ]);
    } finally {
      workerEnv = saved;
    }
    expect([results[0].status, results[3].status]).toEqual([200, 200]);
    return { id, token };
  }

  for (const to of ["ARCHIVING", "FAILED"] as const) {
    test(`the webhook route, the tick and a cancel all at once, with Tapis at ${to}, leave ONE terminal state and ONE closing ledger entry, and a replay of each changes nothing`, async () => {
      for (let round = 0; round < 3; round++) {
        const { id, token } = await race(to);
        const job = await reread(workerEnv, id);
        // One terminal state (a live write never resurrects a cancelled job), settled once.
        expect(["failed", "cancelled"]).toContain(job.state);
        expect(job.settled_provisional_at).not.toBeNull();
        const kinds = await ledgerKinds(id);
        expect(kinds[0]).toBe("hold");
        expect(kinds).toHaveLength(2);
        expect(["charge", "release"]).toContain(kinds[1] as string);
        await fetch(`${base()}/webhooks/tapis/${id}/${token}`, { method: "POST", body: "{}" });
        await runComputeAdvanceCron(workerEnv);
        expect(await ledgerKinds(id)).toEqual(kinds);
        expect((await reread(workerEnv, id)).state).toBe(job.state);
      }
    });
  }
});
