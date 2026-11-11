/**
 * THE PROOF OF EPIC A (epic #2005 phase A7, #2012; ADR 0118): a job goes from an administrator's request to
 * Expanse's own figure and a record anyone can read, through every real entry point, and an account that
 * ends mid-run ends its job.
 *
 * WHAT "LOCAL BACKEND" MEANS HERE. The Worker runs in-process with `ENVIRONMENT` production-shaped for the
 * crons (the production-only ticks are exercised by their own tests with a production-flagged environment,
 * which is what this file uses) and `COMPUTE_ENABLED` `1`, which is the configuration the compute epic runs
 * in when it is switched on (staging runs it with `ENVIRONMENT` `development`, where a job is advanced by
 * its webhook and by `jobs advance` and no cron runs; the cron-driven steps below are what the production
 * crons do, called as `scheduled()` calls them). The database is real SQLite carrying every migration;
 * the two private buckets are Miniflare's R2 reached through the Worker's own bindings; the Tapis tenant,
 * the S3 interface the signer addresses and the ACCESS endpoint are real HTTP servers (stand-ins built from
 * published specifications; NO RESPONSE IN ANY OF THEM WAS RECORDED FROM A REAL SERVICE). The launcher and
 * the observer are stood in for by this file, as clients of the real routes: they decide nothing.
 *
 * LEG 1, in order: fund the pipelines pool; `pipeline run` a fixture EEG dataset; the hold is present; the
 * stand-in saw the submit; the launcher declares, uploads and completes its outputs through the outputs
 * routes; a webhook hint, then a cron tick, take the job to `finished`; the provisional charge is settled
 * once; ACCESS is told once; an observer post finalizes within tolerance; `record <slurm id>`, run by the
 * REAL CLI against a `Bun.serve` of the real routes, shows the chain.
 * LEG 2: a second account's job is revoked mid-run: `account_ended`, a frozen pool, a Tapis cancel after
 * the sweep, and the use charged.
 * LEG 3: a job nobody reserved is found, cancelled and charged to the tenant pool, not to anyone.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { LAUNCHER_FILES, type PartitionName, suMilliFor } from "../../shared/contract/compute";
import { LaunchSpecSchema } from "../../shared/contract/compute-launch";
import dailyObservation from "../../test/fixtures/compute-observation/daily.v1.json";
import { runAccessReportCron } from "../src/services/access-attributes";
import { runComputeAdvanceCron, sweepComputeCancellations } from "../src/services/compute-advance";
import { advanceComputeJob } from "../src/services/compute-lifecycle";
import { sweepTenantJobs } from "../src/services/compute-tenant-sweep";
import type { Bindings } from "../src/types/bindings";
import { type AccessStandin, startAccessStandin } from "./helpers/access-standin";
import {
  COMPUTE_KEYS,
  type ComputeWho,
  makeComputeApp,
  seedComputeUsers,
} from "./helpers/compute-app";
import {
  type LifecycleFixture,
  MINUTE,
  RUNTIME_IMAGE_DIGEST,
  launchSpecTextSeenByTapis,
  makeJob,
  reread,
  setTapisTimes,
  startLifecycleFixture,
} from "./helpers/compute-lifecycle-fixture";
import {
  floorOutputs,
  fundPipelines,
  seedEegDataset,
  seedPipelinesAccount,
  setTapisExit,
} from "./helpers/compute-pipeline-fixture";
import { makeRoutesApp } from "./helpers/compute-routes-app";

const CLI_ENTRY = join(import.meta.dir, "..", "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..", "..");
const ACCESS_KEY = "e2e-access-key-0123456789abcdef0123456789abcdef";
const encoder = new TextEncoder();
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

let fx: LifecycleFixture;
let access: AccessStandin;
let previousAccessUrl: string | undefined;
let workerEnv: Bindings;
let configDir: string;
const admin = makeComputeApp();
const routes = makeRoutesApp();

/** ONE loopback server for the Worker's routes: `/admin/*` to the admin router, the rest to the compute router. */
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/notices") return Response.json({ notices: [] });
    return url.pathname.startsWith("/admin/") ? admin(req, workerEnv) : routes(req, workerEnv);
  },
});
const base = `http://127.0.0.1:${server.port}`;

beforeAll(async () => {
  fx = await startLifecycleFixture();
  access = startAccessStandin();
  previousAccessUrl = (globalThis as { NEMAR_ACCESS_ATTRIBUTES_URL?: string })
    .NEMAR_ACCESS_ATTRIBUTES_URL;
  (globalThis as { NEMAR_ACCESS_ATTRIBUTES_URL?: string }).NEMAR_ACCESS_ATTRIBUTES_URL = access.url;
}, 120_000);

beforeEach(async () => {
  await fx.reset();
  access.reset();
  await seedComputeUsers(fx.harness.db);
  workerEnv = fx.env({
    API_BASE_URL: base,
    ACCESS_GATEWAY_ATTRIBUTES_KEY: ACCESS_KEY,
    ACCESS_RESOURCE_NAME: "example-resource-name",
  });
  configDir = mkdtempSync(join(tmpdir(), "nemar-compute-e2e-"));
});

afterAll(async () => {
  server.stop(true);
  (globalThis as { NEMAR_ACCESS_ATTRIBUTES_URL?: string }).NEMAR_ACCESS_ATTRIBUTES_URL =
    previousAccessUrl;
  access?.stop();
  await fx?.dispose();
  rmSync(configDir, { recursive: true, force: true });
}, 30_000);

// --- Helpers -----------------------------------------------------------------------------------------

async function adminCall(
  who: ComputeWho,
  method: string,
  path: string,
  body?: unknown,
  env = workerEnv,
) {
  const res = await admin(
    new Request(`http://api.test/admin${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${COMPUTE_KEYS[who]}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
  );
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, any>) : {} };
}

const ledgerKinds = async (jobId: string) =>
  (
    await workerEnv.DB.prepare("SELECT kind FROM compute_ledger WHERE job_id = ?1 ORDER BY id")
      .bind(jobId)
      .all<{ kind: string }>()
  ).results.map((r) => r.kind);

/** What the launcher does with the routes, from the launch specification it was handed. */
async function runLauncher(
  uuid: string,
  jobId: string,
  files: Array<{ path: string; content: string }>,
) {
  const text = launchSpecTextSeenByTapis(fx, uuid);
  const spec = LaunchSpecSchema.parse(JSON.parse(text));
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
      launch_spec_digest: sha(text),
      bundle_digest: null,
      image: { uri: spec.image.uri, digest: RUNTIME_IMAGE_DIGEST },
      runtime_version: "e2e 1.0",
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
  const declared = await fetch(`${spec.api_base}/compute/jobs/${jobId}/outputs`, {
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
  expect(declared.status).toBe(200);
  const { uploads } = (await declared.json()) as { uploads: Array<{ path: string; url: string }> };
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

interface Ran {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** The REAL CLI, against the loopback server, as `who`. */
async function cli(who: ComputeWho, args: string[]): Promise<Ran> {
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      activeAccount: "e2e",
      accounts: { e2e: { apiKey: COMPUTE_KEYS[who] } },
    }),
  );
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({
    ...process.env,
    NEMAR_CONFIG_DIR: configDir,
    TEST_API_URL: base,
    NEMAR_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
    FORCE_COLOR: undefined,
    CLICOLOR_FORCE: undefined,
  })) {
    if (v !== undefined) env[k] = v;
  }
  const proc = spawn({
    cmd: ["bun", "run", CLI_ENTRY, "admin", "compute", ...args],
    cwd: REPO_ROOT,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { stdout, stderr, exitCode: await proc.exited };
}

// --- Leg 1 ---------------------------------------------------------------------------------------------

describe("an administrator's pipeline run, to a record anyone can read", () => {
  test("fund, run, hold, submit, launch, webhook, tick, settle, ACCESS, observer, record", async () => {
    // 1. Fund the pipelines pool, and the world a pipeline run needs.
    await seedPipelinesAccount(workerEnv);
    await fundPipelines(workerEnv);
    await seedEegDataset(workerEnv, "nm000104");

    // 2. The administrator runs the pipeline for a fixture EEG dataset.
    const run = await adminCall("admin", "POST", "/compute/pipeline/run", {
      recipe: "nemar-floor",
      dataset: "nm000104",
    });
    expect(run.status).toBe(201);
    const id = run.body.results[0].job_id as string;

    // 3. The hold is present, on the pipelines budget, and nothing is charged yet.
    expect(await ledgerKinds(id)).toEqual(["hold"]);
    const held = (await reread(workerEnv, id)).held_milli;
    expect(held).toBeGreaterThan(0);

    // 4. The Tapis stand-in saw exactly one submit, tagged for the job.
    const submits = fx.tapis.log.filter((r) => r.route === "POST /v3/jobs/submit");
    expect(submits).toHaveLength(1);
    expect(JSON.parse(submits[0]?.body ?? "{}").tags).toContain(`nemar_job:${id}`);
    const uuid = (await reread(workerEnv, id)).tapis_uuid as string;
    expect(uuid).toBeTruthy();

    // 5. A status hint, by webhook: queued, then running.
    for (const status of ["QUEUED", "RUNNING"]) {
      fx.tapis.advance(uuid, status);
      expect((await fx.tapis.fireWebhook(uuid)).status).toBe(200);
    }
    expect((await reread(workerEnv, id)).state).toBe("running");
    const slurm = (await reread(workerEnv, id)).slurm_job_id as string;
    expect(slurm).toBeTruthy();

    // 6. The launcher declares, uploads and completes its outputs through the routes.
    fx.tapis.advance(uuid, "ARCHIVING");
    expect((await fx.tapis.fireWebhook(uuid)).status).toBe(200);
    await runLauncher(uuid, id, floorOutputs());
    expect((await reread(workerEnv, id)).outputs_completed_at).not.toBeNull();

    // 7. Tapis says FINISHED; the CRON TICK, not a webhook, takes the job there.
    fx.tapis.advance(uuid, "FINISHED");
    setTapisTimes(fx, uuid, 30 * MINUTE, 0);
    setTapisExit(fx, uuid, 0);
    const tick = await runComputeAdvanceCron(workerEnv);
    expect(tick?.errors).toEqual([]);
    const job = await reread(workerEnv, id);
    expect(job.state).toBe("finished");
    expect(job.results_verified_at).not.toBeNull();

    // 8. Settled provisionally, once, to the pipelines pool and the budget; records copied.
    expect(await ledgerKinds(id)).toEqual(["hold", "charge"]);
    expect(job.settled_provisional_at).not.toBeNull();
    expect(job.charged_milli).toBeGreaterThan(0);
    expect(job.result_records_at).not.toBeNull();
    await runComputeAdvanceCron(workerEnv);
    expect(await ledgerKinds(id)).toEqual(["hold", "charge"]);

    // 9. ACCESS is told once, with the pipelines' literal and the Slurm id.
    expect((await runAccessReportCron(workerEnv))?.sent).toBe(1);
    expect(access.requests).toHaveLength(1);
    expect(access.requests[0]?.body).toMatchObject({ gatewayuser: "nemar-pipelines" });
    expect(JSON.stringify(access.requests[0]?.body)).toContain(slurm);
    await runAccessReportCron(workerEnv);
    expect(access.requests).toHaveLength(1);

    // 10. The observer: an administrator mints the token, the observer posts its own document with the
    // token as a bearer, and the Worker prices the allocation it reports, within tolerance. Slurm's ids
    // are numbers and the Tapis stand-in's are not, so the job is given the number the document carries.
    const observed = "424242";
    await workerEnv.DB.prepare("UPDATE compute_jobs SET slurm_job_id = ?1 WHERE id = ?2")
      .bind(observed, id)
      .run();
    const minted = await adminCall("admin", "POST", "/compute/observer-runs");
    expect(minted.status).toBe(201);
    const token = minted.body.token as string;
    const seconds = 1860;
    const posted = await fetch(`${base}/compute/observer`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        ...dailyObservation,
        partitions: {
          [job.partition]: {
            available: "up",
            nodes: { idle: 2 },
            jobs: {
              PENDING: { jobs: 2, nodes: 2, cpus: 8 },
              RUNNING: { jobs: 5, nodes: 5, cpus: 20 },
            },
            pending_reasons: { Priority: 2 },
          },
        },
        accounting: {
          ...dailyObservation.accounting,
          rows_total: 1,
          rows_included: 1,
          jobs: [
            {
              ...dailyObservation.accounting.jobs[0],
              job_id: observed,
              partition: job.partition,
              state: "COMPLETED",
              elapsed_seconds: seconds,
              alloc_tres: {
                cpu: String(job.nodes * job.cores_per_node),
                mem: `${job.memory_mb * job.nodes}M`,
                node: String(job.nodes),
              },
            },
          ],
        },
      }),
    });
    expect(posted.status).toBe(200);
    expect(await posted.json()).toMatchObject({
      snapshots: 1,
      sacct_rows: 1,
      skipped: 0,
      settled: 1,
      mismatched: 0,
      unmatched: 0,
    });
    // Expanse's figure is the rate table's for what the document reports (per node), a little over the provisional one.
    const expanse = suMilliFor(
      job.partition as PartitionName,
      { nodes: job.nodes, cores: job.cores_per_node, memory_mb: job.memory_mb, gpus: 0 },
      seconds,
    );
    expect(expanse).toBeGreaterThan(job.charged_milli);
    expect(expanse - job.charged_milli).toBeLessThanOrEqual(1000);
    const final = await reread(workerEnv, id);
    expect(final.settled_final_at).not.toBeNull();
    expect(final.charged_milli).toBe(expanse);
    expect(final.flag_mismatch).toBe(0);
    expect(await ledgerKinds(id)).toEqual(["hold", "charge", "adjust"]);
    // One post per token, and the old header is not a way in.
    for (const headers of [
      { Authorization: `Bearer ${token}` },
      { "X-Compute-Observer-Token": token },
    ]) {
      expect(
        (await fetch(`${base}/compute/observer`, { method: "POST", headers, body: "{}" })).status,
      ).toBe(403);
    }

    // 11. The REAL CLI reads the chain by the Slurm id.
    const record = await cli("admin", ["jobs", "record", observed]);
    expect(record.exitCode).toBe(0);
    expect(record.stdout).toContain(`job ${id}`);
    expect(record.stdout).toContain("state: finished");
    expect(record.stdout).toMatch(/hold\s+held \d+/);
    expect(record.stdout).toMatch(/charge\s/);
    expect(record.stdout).toMatch(/adjust\s/);
    expect(record.stdout).toContain(`slurm ${observed}`);
    expect(record.stdout).toContain("provenance: {");
    expect(record.stdout).toContain("manifest: 2 file(s)");
    // And the same by the NEMAR id and the Tapis uuid, with no identity in any.
    for (const ref of [id, uuid]) {
      const again = await cli("admin", ["jobs", "record", ref]);
      expect(again.stdout).toContain(`job ${id}`);
      expect(again.stdout + again.stderr).not.toContain("@example.org");
    }
    const list = await cli("admin", ["jobs", "list", "--state", "finished"]);
    expect(list.stdout).toContain(id);
    const report = await cli("admin", [
      "jobs",
      "access-report",
      "--quarter",
      quarterOfNow(),
      "--json",
    ]);
    expect(JSON.parse(report.stdout).totals).toEqual({ distinct_users: 1, jobs: 1 });
  }, 120_000);
});

function quarterOfNow(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}Q${Math.floor(now.getUTCMonth() / 3) + 1}`;
}

// --- Leg 2 ---------------------------------------------------------------------------------------------

describe("an account that ends mid-run ends its job", () => {
  test("revoking the account records account_ended and freezes its pool; the sweep cancels at Tapis and the use is charged", async () => {
    const made = await makeJob(fx, { env: workerEnv, account: { username: "e2e-person" } });
    const id = made.job.id;
    expect((await advanceComputeJob(workerEnv, id)).outcome).toBe("submitted");
    const uuid = (await reread(workerEnv, id)).tapis_uuid as string;
    for (const status of ["QUEUED", "RUNNING"]) {
      fx.tapis.advance(uuid, status);
      await fx.tapis.fireWebhook(uuid);
    }
    expect((await reread(workerEnv, id)).state).toBe("running");

    // The owner revokes the account (the real route; its mail and session steps are no-ops here).
    const revoked = await adminCall(
      "owner",
      "POST",
      "/revoke/e2e-person",
      undefined,
      fx.env({ ENVIRONMENT: "test", RESEND_API_KEY: "", WEB_SESSION_COOKIE_DOMAIN: "" }),
    );
    expect(revoked.status).toBe(200);

    // The batch recorded the intent and froze the pool; it made no Tapis call.
    const afterRevoke = await reread(workerEnv, id);
    expect(afterRevoke).toMatchObject({ cancel_reason: "account_ended", state: "running" });
    expect(afterRevoke.cancel_requested_at).not.toBeNull();
    const pools = workerEnvDb(
      "SELECT frozen FROM compute_pools WHERE holder_kind = 'account' AND holder_ref = ?",
      String(made.accountId),
    );
    expect(pools).toEqual([{ frozen: 1 }]);
    expect(fx.tapis.log.filter((r) => r.route === "POST /v3/jobs/:uuid/cancel")).toHaveLength(0);

    // The sweep cancels at Tapis, reads it back, and charges what the job used.
    setTapisTimes(fx, uuid, 30 * MINUTE, null);
    const swept = await sweepComputeCancellations(workerEnv);
    expect(swept?.errors).toEqual([]);
    expect(fx.tapis.log.filter((r) => r.route === "POST /v3/jobs/:uuid/cancel")).toHaveLength(1);
    const ended = await reread(workerEnv, id);
    expect(ended.state).toBe("cancelled");
    expect(ended.cancel_reason).toBe("account_ended");
    expect(ended.charged_milli).toBeGreaterThanOrEqual(2000);
    expect(await ledgerKinds(id)).toEqual(["hold", "charge"]);
    // And the report shows the job with the reason.
    const listed = await adminCall("admin", "GET", `/compute/jobs?account=${made.accountId}`);
    expect(listed.body.jobs[0]).toMatchObject({
      id,
      state: "cancelled",
      cancel_reason: "account_ended",
    });
  }, 60_000);
});

function workerEnvDb(sql: string, ...params: unknown[]) {
  return fx.harness.db.query(sql).all(...(params as never[]));
}

// --- Leg 3 ---------------------------------------------------------------------------------------------

describe("a job nobody reserved", () => {
  test("is found by the sweep, cancelled and charged to the tenant pool, never to a person, and shows in `jobs list --flag unreserved`", async () => {
    const person = await makeJob(fx, { env: workerEnv });
    // Submitted to the tenant with no reservation and no tag.
    const token = (
      (await (
        await fetch(`${fx.tapis.url}/v3/oauth2/tokens`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            grant_type: "password",
            username: fx.tapis.username,
            password: fx.tapis.password,
          }),
        })
      ).json()) as { result: { access_token: { access_token: string } } }
    ).result.access_token.access_token;
    const submitted = await fetch(`${fx.tapis.url}/v3/jobs/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Tapis-Token": token },
      body: JSON.stringify({
        name: "unreserved",
        appId: "partner-app",
        appVersion: "1.0.0",
        execSystemLogicalQueue: "shared",
        nodeCount: 1,
        coresPerNode: 4,
        memoryMB: 8000,
        maxMinutes: 60,
      }),
    });
    const uuid = ((await submitted.json()) as { result: { uuid: string } }).result.uuid;
    fx.tapis.advance(uuid, "QUEUED");
    fx.tapis.advance(uuid, "RUNNING");
    setTapisTimes(fx, uuid, 30 * MINUTE, null);

    const swept = await sweepTenantJobs(workerEnv, "live");
    expect(swept).toMatchObject({ indexed: 1, cancelled: 1, finished: 1 });
    expect(fx.tapis.jobs.get(uuid)?.status).toBe("CANCELLED");

    const listed = await cli("admin", ["jobs", "list", "--flag", "unreserved"]);
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toContain("[unreserved,unattributed]");
    const pools = Object.fromEntries(
      (
        workerEnvDb("SELECT holder_kind, holder_ref, charged_milli FROM compute_pools") as Array<{
          holder_kind: string;
          holder_ref: string;
          charged_milli: number;
        }>
      ).map((p) => [`${p.holder_kind}:${p.holder_ref}`, p.charged_milli]),
    );
    expect(pools["partner:tenant"]).toBeGreaterThanOrEqual(2000);
    expect(pools[`account:${person.accountId}`] ?? 0).toBe(0);
    // The person's own reservation was not touched.
    expect((await reread(workerEnv, person.job.id)).state).toBe("created");
  }, 60_000);
});
