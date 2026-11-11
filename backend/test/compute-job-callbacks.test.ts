/**
 * The launcher's three job callbacks, `POST /compute/jobs/:id/bundle`, `.../outputs` and
 * `.../outputs/complete` (epic #2005 phase A5, #2010; ADR 0118), through the REAL compute router over
 * real migrations, the real ledger, Miniflare's R2 through the Worker's own bindings and the real local
 * S3 interface that the presigned addresses are signed for. The launcher is played by the test: it
 * reads `api_base` and `job_token` out of the launch specification the Tapis stand-in RECEIVED (no
 * response of which was recorded from a real tenant), calls the routes over real HTTP, and PUTs to the
 * addresses it is given.
 *
 * What is pinned, each with a test of its own:
 *  - a wrong token, another job's token, a cleared nonce, no header, a token in the URL and a terminal
 *    job's token are refused IDENTICALLY on all three routes (`job_not_found`, 404), and write nothing;
 *  - `bundle` signs only THIS job's own `bundle.tar.gz`, for ten minutes, from the verified job id and
 *    nothing the request carries (MUTATION: sign a caller-supplied path), and a job with no bundle gets
 *    the uniform refusal;
 *  - `outputs` refuses too many files, an over-cap file, an over-cap job, an over-quota person and an
 *    over-total platform each with its own code, records the word as `failure_detail`, still presigns
 *    the four launcher files and nothing else, and claims no bytes; the launcher's follow-up with no
 *    outputs is accepted and `failure_detail` is never cleared;
 *  - two jobs racing for the last bytes of a person or of the platform: exactly one wins (MUTATION: read
 *    the quota in a separate query before the UPDATE);
 *  - a replay re-presigns and changes nothing, another body for a claimed job is `bad_state`, and no
 *    address is issued after `complete`;
 *  - `complete` answers 409 `results_incomplete` for a missing or short object and is idempotent;
 *  - `a..b.csv`, `100%.txt`, a space and a non-ASCII name round-trip, and a traversal is refused;
 *  - the launcher's whole run, through these routes, ends `finished` and verified, and a refusal ends
 *    `result_upload_failed`, charged and not a platform failure;
 *  - no token or presigned address reaches a log.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { Server } from "bun";
import { LAUNCHER_FILE_NAMES, RESULT_MAX_FILE_BYTES } from "../../shared/contract/compute";
import { createJob } from "../src/services/compute-jobs";
import { advanceComputeJob, submitComputeJob } from "../src/services/compute-lifecycle";
import { finalizeBundle } from "../src/services/compute-records";
import { signComputeToken } from "../src/services/compute-tokens";
import { declaredKey } from "../src/services/compute-verify";
import type { Bindings } from "../src/types/bindings";
import {
  CALLBACK_SECRET,
  type LifecycleFixture,
  MINUTE,
  type MadeJob,
  launchSpecTextSeenByTapis,
  makeJob,
  reread,
  setPolicy,
  setTapisTimes,
  startLifecycleFixture,
} from "./helpers/compute-lifecycle-fixture";
import { type RoutesHandle, makeRoutesApp, serveRoutes } from "./helpers/compute-routes-app";
import {
  bundleJobSpec,
  fundAccount,
  fundPlatform,
  roundTripD1,
  seedUser,
  sha256Hex,
} from "./helpers/compute-seed";
import { logged } from "./helpers/logs";

let fx: LifecycleFixture;
let handle: RoutesHandle;
let server: Server;
let workerEnv: Bindings;

beforeAll(async () => {
  fx = await startLifecycleFixture();
  // The REAL maintenance middleware is mounted in front of the routes, as in the entry point; it does
  // nothing unless a test sets `MAINTENANCE_MODE`.
  handle = makeRoutesApp({ maintenance: true });
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

// --- Helpers of this file ------------------------------------------------------------------------

const encoder = new TextEncoder();
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

type Route = "bundle" | "outputs" | "outputs/complete";

interface Reply {
  status: number;
  text: string;
  body: Record<string, any>;
}

/** One call to a callback route over the real router; `token` goes in the header unless `noHeader`. */
async function call(
  jobId: string,
  route: Route,
  init: { token?: string; body?: unknown; raw?: BodyInit; query?: string } = {},
): Promise<Reply> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (init.token !== undefined) headers["X-Compute-Job-Token"] = init.token;
  const url = `http://api.test/compute/jobs/${jobId}/${route}${init.query ?? ""}`;
  const res = await handle(
    new Request(url, {
      method: "POST",
      headers,
      body: init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
    }),
    workerEnv,
  );
  const text = await res.text();
  let body: Record<string, any> = {};
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, text, body };
}

async function tokenFor(jobId: string): Promise<string> {
  const job = await reread(workerEnv, jobId);
  return signComputeToken("job", { jobId, nonce: job.webhook_nonce as string }, CALLBACK_SECRET);
}

interface OutputFile {
  path: string;
  content: string;
}

const launcherFiles = (sizes = [10, 20, 30, 40]) =>
  LAUNCHER_FILE_NAMES.map((name, i) => ({ name, size: sizes[i] as number }));

function outputsBody(files: OutputFile[], launcher = launcherFiles()) {
  return {
    outputs: files.map((f) => ({
      path: f.path,
      size: encoder.encode(f.content).length,
      sha256: sha(f.content),
    })),
    launcher,
  };
}

/** A person with a live job (made through `createJob`); `account` is its id. */
async function person(grant = 100_000): Promise<MadeJob> {
  return makeJob(fx, { env: workerEnv, grant });
}

const policyOf = (over: Record<string, unknown>) =>
  setPolicy(workerEnv.DB, fx.ownerId, {
    resultLimits: {
      maxJobBytes: 1_000_000,
      maxFiles: 100,
      maxStoredBytesPerPerson: 10_000_000,
      maxStoredBytesTotal: 100_000_000,
      ...over,
    },
  });

async function resultsKeys(prefix: string): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | undefined;
  do {
    const listed = await fx.harness.results.list({ prefix, cursor });
    for (const o of listed.objects) out.push(o.key);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return out.sort();
}

const hasDeclared = async (jobId: string) =>
  (await fx.harness.results.head(declaredKey(jobId))) !== null;

/** PUT a file to a presigned address over real HTTP, as the launcher does. */
async function put(url: string, content: string): Promise<number> {
  return (await fetch(url, { method: "PUT", body: encoder.encode(content) })).status;
}

/** The launcher's uploads for a body: every output and the four launcher files, each PUT to its address. */
async function uploadAll(
  reply: Reply,
  files: OutputFile[],
  launcher: Record<string, string> = {},
): Promise<number[]> {
  const statuses: number[] = [];
  for (const u of reply.body.uploads as Array<{ path: string; url: string }>) {
    const output = u.path.startsWith("outputs/")
      ? files.find((f) => `outputs/${f.path}` === u.path)
      : undefined;
    const name = u.path.replace("launcher/", "");
    statuses.push(await put(u.url, output?.content ?? launcher[name] ?? `launcher ${name}`));
  }
  return statuses;
}

const launcherSizesOf = (contents: Record<string, string> = {}) =>
  LAUNCHER_FILE_NAMES.map((name) => ({
    name,
    size: encoder.encode(contents[name] ?? `launcher ${name}`).length,
  }));

// --- The uniform refusals ------------------------------------------------------------------------

describe("every refusal of the token is one answer, on all three routes", () => {
  test("a wrong token, another job's token, a cleared nonce, no header, a token in the URL, a terminal job and a stranger", async () => {
    const a = await person();
    const b = await person();
    const cleared = await person();
    const done = await person();
    await workerEnv.DB.prepare("UPDATE compute_jobs SET webhook_nonce = NULL WHERE id = ?")
      .bind(cleared.job.id)
      .run();
    const goodDone = await tokenFor(done.job.id);
    await workerEnv.DB.prepare(
      "UPDATE compute_jobs SET state = 'failed', failure_code = 'tapis_error' WHERE id = ?",
    )
      .bind(done.job.id)
      .run();
    const good = await tokenFor(a.job.id);
    const other = await tokenFor(b.job.id);
    const body = outputsBody([{ path: "a.txt", content: "a" }]);

    for (const route of ["bundle", "outputs", "outputs/complete"] as const) {
      const attempts: Array<[string, Reply]> = [
        ["a wrong token", await call(a.job.id, route, { token: "0".repeat(64), body })],
        ["another job's token", await call(a.job.id, route, { token: other, body })],
        ["no header", await call(a.job.id, route, { body })],
        ["an empty header", await call(a.job.id, route, { token: "", body })],
        ["the token in the URL", await call(a.job.id, route, { body, query: `?token=${good}` })],
        [
          "the token in the URL under the header's own name",
          await call(a.job.id, route, { body, query: `?X-Compute-Job-Token=${good}` }),
        ],
        [
          "a cleared nonce",
          await call(cleared.job.id, route, {
            token: await signComputeToken(
              "job",
              { jobId: cleared.job.id, nonce: cleared.job.webhook_nonce as string },
              CALLBACK_SECRET,
            ),
            body,
          }),
        ],
        ["a terminal job", await call(done.job.id, route, { token: goodDone, body })],
        [
          "a job that does not exist",
          await call("job_000000000000000000000000", route, { token: good, body }),
        ],
        ["a malformed id", await call("nope", route, { token: good, body })],
        [
          "the webhook kind of token",
          await call(a.job.id, route, {
            token: await signComputeToken(
              "webhook",
              { jobId: a.job.id, nonce: a.job.webhook_nonce as string },
              CALLBACK_SECRET,
            ),
            body,
          }),
        ],
      ];
      const first = attempts[0]?.[1];
      for (const [name, reply] of attempts) {
        expect([route, name, reply.status, reply.text]).toEqual([
          route,
          name,
          first?.status,
          first?.text,
        ]);
      }
      expect(first?.status).toBe(404);
      expect(first?.body.code).toBe("job_not_found");
    }
    // Not one of them wrote anything: no claim, no declared file, no refusal word.
    for (const j of [a, b, cleared, done]) {
      const row = await reread(workerEnv, j.job.id);
      expect([row.results_bytes, row.failure_detail, row.outputs_completed_at]).toEqual([
        null,
        null,
        null,
      ]);
      expect(await hasDeclared(j.job.id)).toBe(false);
    }
    // The good token works, so the refusals were about the token and not the route.
    expect((await call(a.job.id, "outputs", { token: good, body })).status).toBe(200);
  });

  test("a Worker with no callback secret refuses every call the same way", async () => {
    const a = await person();
    const token = await tokenFor(a.job.id);
    workerEnv = { ...workerEnv, PRESCREEN_CALLBACK_SECRET: undefined } as Bindings;
    expect((await call(a.job.id, "outputs", { token, body: outputsBody([]) })).status).toBe(404);
  });
});

// --- bundle --------------------------------------------------------------------------------------

describe("bundle", () => {
  async function bundleJob() {
    const archive = encoder.encode("not really a tarball, but bytes are bytes");
    const digest = await sha256Hex(archive);
    const accountId = await seedUser(workerEnv.DB);
    await fundAccount(workerEnv.DB, accountId, 100_000);
    const made = await createJob(workerEnv, {
      source: "cli",
      accountId,
      appId: "nemar-launch",
      appVersion: "1.0.0",
      spec: bundleJobSpec({ size: archive.length, sha256: digest }),
    });
    if (!made.ok) throw new Error(`no job: ${made.code}`);
    await fx.harness.records.put(`incoming/${made.job.id}/bundle.tar.gz`, archive);
    const fin = await finalizeBundle(workerEnv, made.job.id, {
      archive: { sha256: digest, size: archive.length },
      files: [{ path: "run.py", size: 5 }],
    });
    if (!fin.ok) throw new Error("not finalized");
    return { job: made.job, archive, digest };
  }

  test("it answers a ten-minute presigned GET of THIS job's own bundle, and the bytes are the bundle", async () => {
    const b = await bundleJob();
    const reply = await call(b.job.id, "bundle", { token: await tokenFor(b.job.id) });
    expect(reply.status).toBe(200);
    const url = new URL(reply.body.url);
    expect(decodeURIComponent(url.pathname)).toBe(
      `/nemar-compute-records/records/${b.job.id}/submitted/bundle.tar.gz`,
    );
    expect(url.searchParams.get("X-Amz-Expires")).toBe("600");
    const expires = Date.parse(reply.body.expires_at);
    expect(expires - Date.now()).toBeGreaterThan(9 * MINUTE);
    expect(expires - Date.now()).toBeLessThanOrEqual(10 * MINUTE);
    expect(new Uint8Array(await (await fetch(reply.body.url)).arrayBuffer())).toEqual(b.archive);
  });

  test("it signs only the job's own key: nothing the request carries steers it (MUTATION: sign a caller-supplied path)", async () => {
    const b = await bundleJob();
    const other = await bundleJob();
    const token = await tokenFor(b.job.id);
    const own = `/nemar-compute-records/records/${b.job.id}/submitted/bundle.tar.gz`;
    const steering = [
      { query: `?key=records/${other.job.id}/submitted/bundle.tar.gz` },
      { query: `?path=records/${other.job.id}/identity.json&job=${other.job.id}` },
      {
        body: {
          key: `records/${other.job.id}/identity.json`,
          path: `records/${other.job.id}/spec.json`,
        },
      },
      { body: { id: other.job.id, bundle: `../${other.job.id}/submitted/bundle.tar.gz` } },
    ];
    for (const s of steering) {
      const reply = await call(b.job.id, "bundle", { token, ...s });
      expect(reply.status).toBe(200);
      expect(decodeURIComponent(new URL(reply.body.url).pathname)).toBe(own);
    }
  });

  test("a job with no bundle gets the uniform refusal, and so does one that is terminal", async () => {
    const plain = await person();
    const token = await tokenFor(plain.job.id);
    const wrong = await call(plain.job.id, "bundle", { token: "0".repeat(64) });
    const none = await call(plain.job.id, "bundle", { token });
    expect([none.status, none.text]).toEqual([wrong.status, wrong.text]);
    const b = await bundleJob();
    const bt = await tokenFor(b.job.id);
    await workerEnv.DB.prepare("UPDATE compute_jobs SET state = 'cancelled' WHERE id = ?")
      .bind(b.job.id)
      .run();
    const ended = await call(b.job.id, "bundle", { token: bt });
    expect([ended.status, ended.text]).toEqual([wrong.status, wrong.text]);
  });

  test("it works however long the job waited in the queue: any live state, any age", async () => {
    const b = await bundleJob();
    const token = await tokenFor(b.job.id);
    for (const state of ["created", "submitted", "queued", "running", "archiving", "unreported"]) {
      await workerEnv.DB.prepare(
        "UPDATE compute_jobs SET state = ?1, created_at = datetime('now', '-30 days') WHERE id = ?2",
      )
        .bind(state, b.job.id)
        .run();
      expect([state, (await call(b.job.id, "bundle", { token })).status]).toEqual([state, 200]);
    }
  });

  test("with no signing configuration it is `compute_disabled`", async () => {
    const b = await bundleJob();
    const token = await tokenFor(b.job.id);
    workerEnv = { ...workerEnv, COMPUTE_R2_ACCESS_KEY_ID: undefined } as Bindings;
    const reply = await call(b.job.id, "bundle", { token });
    expect([reply.status, reply.body.code]).toEqual([503, "compute_disabled"]);
  });
});

// --- outputs: the checks come before any address ---------------------------------------------------

describe("outputs refuses before it signs anything", () => {
  const LAUNCHER_PATHS = LAUNCHER_FILE_NAMES.map((n) => `launcher/${n}`).sort();

  async function expectRefused(
    reply: Reply,
    code: string,
    status: number,
    jobId: string,
    detail = code,
  ) {
    expect([reply.status, reply.body.code]).toEqual([status, code]);
    // The launcher's four files are still presigned, and nothing else: its result and log explain the failure.
    expect((reply.body.uploads as Array<{ path: string }>).map((u) => u.path).sort()).toEqual(
      LAUNCHER_PATHS,
    );
    expect(Date.parse(reply.body.expires_at) - Date.now()).toBeGreaterThan(59 * MINUTE);
    const row = await reread(workerEnv, jobId);
    expect(row.failure_detail).toBe(detail);
    // No bytes were claimed and no declared file was written: no output address was ever issued.
    expect(row.results_bytes).toBeNull();
    expect(await hasDeclared(jobId)).toBe(false);
    expect(reply.text).not.toContain("/outputs/");
  }

  test("a fault reading the owner's policy is `policy_unavailable` (503), NOT `compute_disabled`, and nothing is recorded or signed (MUTATION: answer compute_disabled)", async () => {
    const b = await person();
    const token = await tokenFor(b.job.id);
    const real = workerEnv.DB;
    // One read of the policy fails, as a transient database fault does; every other statement is the real one.
    let armed = true;
    const faulty = new Proxy(real, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (armed && sql.includes("FROM compute_policy")) {
              armed = false;
              throw new Error("injected: database fault");
            }
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, prop) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;
    const saved = workerEnv;
    workerEnv = { ...workerEnv, DB: faulty } as Bindings;
    const reply = await call(b.job.id, "outputs", {
      token,
      body: outputsBody([{ path: "a.txt", content: "hello" }]),
    });
    workerEnv = saved;
    expect([reply.status, reply.body.code]).toEqual([503, "policy_unavailable"]);
    expect(reply.body.uploads).toBeUndefined();
    expect(armed).toBe(false);
    expect(await hasDeclared(b.job.id)).toBe(false);
    // The launcher asks again and is served: the fault was not the platform being off.
    const again = await call(b.job.id, "outputs", {
      token,
      body: outputsBody([{ path: "a.txt", content: "hello" }]),
    });
    expect(again.status).toBe(200);
  });

  test("too many files (`too_many_outputs`, 413)", async () => {
    await policyOf({ maxFiles: 3 });
    const j = await person();
    const files = ["a", "b", "c", "d"].map((n) => ({ path: `${n}.txt`, content: n }));
    const reply = await call(j.job.id, "outputs", {
      token: await tokenFor(j.job.id),
      body: outputsBody(files),
    });
    await expectRefused(reply, "too_many_outputs", 413, j.job.id);
    // Exactly at the limit is accepted.
    const ok = await person();
    expect(
      (
        await call(ok.job.id, "outputs", {
          token: await tokenFor(ok.job.id),
          body: outputsBody(files.slice(0, 3)),
        })
      ).status,
    ).toBe(200);
  });

  test("a file over the 5 GB cap, however the job limit is set (`results_too_large`, 413)", async () => {
    await policyOf({
      maxJobBytes: Number.MAX_SAFE_INTEGER,
      maxStoredBytesPerPerson: Number.MAX_SAFE_INTEGER,
      maxStoredBytesTotal: Number.MAX_SAFE_INTEGER,
    });
    const j = await person();
    const body = {
      outputs: [{ path: "big.bin", size: RESULT_MAX_FILE_BYTES + 1, sha256: "a".repeat(64) }],
      launcher: launcherFiles(),
    };
    await expectRefused(
      await call(j.job.id, "outputs", { token: await tokenFor(j.job.id), body }),
      "results_too_large",
      413,
      j.job.id,
    );
    // A file of exactly the cap is within it.
    const ok = await person();
    const exact = {
      outputs: [{ path: "big.bin", size: RESULT_MAX_FILE_BYTES, sha256: "a".repeat(64) }],
      launcher: launcherFiles(),
    };
    expect(
      (await call(ok.job.id, "outputs", { token: await tokenFor(ok.job.id), body: exact })).status,
    ).toBe(200);
  });

  test("a job over the job limit, launcher files counted (`results_too_large`, 413)", async () => {
    await policyOf({ maxJobBytes: 1000 });
    const j = await person();
    const body = {
      outputs: [{ path: "a.bin", size: 901, sha256: "a".repeat(64) }],
      launcher: launcherFiles([10, 20, 30, 40]),
    };
    await expectRefused(
      await call(j.job.id, "outputs", { token: await tokenFor(j.job.id), body }),
      "results_too_large",
      413,
      j.job.id,
    );
    const ok = await person();
    const fits = {
      outputs: [{ path: "a.bin", size: 900, sha256: "a".repeat(64) }],
      launcher: launcherFiles([10, 20, 30, 40]),
    };
    expect(
      (await call(ok.job.id, "outputs", { token: await tokenFor(ok.job.id), body: fits })).status,
    ).toBe(200);
  });

  test("an over-quota person (`results_quota_exceeded`, 409): the account's OTHER totals count, within the window", async () => {
    await policyOf({ maxStoredBytesPerPerson: 1000, maxJobBytes: 1000 });
    const first = await person();
    // Another job of the same person that has claimed 900 bytes.
    const second = await makeJob(fx, { env: workerEnv });
    await workerEnv.DB.prepare("UPDATE compute_jobs SET account_id = ?1 WHERE id = ?2")
      .bind(first.accountId, second.job.id)
      .run();
    await workerEnv.DB.prepare("UPDATE compute_jobs SET results_bytes = 900 WHERE id = ?")
      .bind(first.job.id)
      .run();
    const body = outputsBody(
      [{ path: "a.txt", content: "x".repeat(10) }],
      launcherFiles([10, 20, 30, 40]),
    );
    const reply = await call(second.job.id, "outputs", {
      token: await tokenFor(second.job.id),
      body,
    });
    await expectRefused(reply, "results_quota_exceeded", 409, second.job.id);
    // Expired results no longer count: the first job ended a month ago.
    const third = await makeJob(fx, { env: workerEnv });
    await workerEnv.DB.prepare("UPDATE compute_jobs SET account_id = ?1 WHERE id = ?2")
      .bind(first.accountId, third.job.id)
      .run();
    await workerEnv.DB.prepare(
      "UPDATE compute_jobs SET ended_at = datetime('now', '-31 days') WHERE id = ?",
    )
      .bind(first.job.id)
      .run();
    expect(
      (await call(third.job.id, "outputs", { token: await tokenFor(third.job.id), body })).status,
    ).toBe(200);
  });

  test("an over-total platform (`results_quota_exceeded`, 409) is every job's bytes, whoever's", async () => {
    await policyOf({ maxStoredBytesTotal: 1000, maxJobBytes: 1000, maxStoredBytesPerPerson: 1000 });
    const holder = await person();
    await workerEnv.DB.prepare("UPDATE compute_jobs SET results_bytes = 950 WHERE id = ?")
      .bind(holder.job.id)
      .run();
    const j = await person();
    const body = outputsBody(
      [{ path: "a.txt", content: "x".repeat(10) }],
      launcherFiles([10, 20, 30, 40]),
    );
    await expectRefused(
      await call(j.job.id, "outputs", { token: await tokenFor(j.job.id), body }),
      "results_quota_exceeded",
      409,
      j.job.id,
    );
  });

  test("a job with no account has no person's share, and the platform total still applies", async () => {
    await policyOf({ maxStoredBytesPerPerson: 1, maxStoredBytesTotal: 1000, maxJobBytes: 1000 });
    await fundPlatform(workerEnv.DB, "pipelines", 1_000_000);
    const pipeline = await makeJob(fx, { env: workerEnv, source: "pipeline" });
    await workerEnv.DB.prepare("UPDATE compute_jobs SET account_id = NULL WHERE id = ?")
      .bind(pipeline.job.id)
      .run();
    const body = outputsBody(
      [{ path: "a.txt", content: "x".repeat(10) }],
      launcherFiles([10, 20, 30, 40]),
    );
    // A per-person share of ONE byte would refuse a person; a job with no account is not held to it.
    expect(
      (await call(pipeline.job.id, "outputs", { token: await tokenFor(pipeline.job.id), body }))
        .status,
    ).toBe(200);
    const heavy = await makeJob(fx, { env: workerEnv, source: "pipeline" });
    await workerEnv.DB.prepare("UPDATE compute_jobs SET account_id = NULL WHERE id = ?")
      .bind(heavy.job.id)
      .run();
    await workerEnv.DB.prepare("UPDATE compute_jobs SET results_bytes = 960 WHERE id = ?")
      .bind(pipeline.job.id)
      .run();
    const reply = await call(heavy.job.id, "outputs", {
      token: await tokenFor(heavy.job.id),
      body,
    });
    expect([reply.status, reply.body.code]).toEqual([409, "results_quota_exceeded"]);
  });

  test("a refusal replayed answers the same and records once; the first reason stays", async () => {
    await policyOf({ maxFiles: 1 });
    const j = await person();
    const token = await tokenFor(j.job.id);
    const files = ["a", "b"].map((n) => ({ path: `${n}.txt`, content: n }));
    const first = await call(j.job.id, "outputs", { token, body: outputsBody(files) });
    const again = await call(j.job.id, "outputs", { token, body: outputsBody(files) });
    expect([again.status, again.body.code]).toEqual([first.status, first.body.code]);
    expect((await reread(workerEnv, j.job.id)).failure_detail).toBe("too_many_outputs");
    // Another reason on a later request does not replace it.
    await policyOf({ maxFiles: 100, maxJobBytes: 10 });
    const big = await call(j.job.id, "outputs", {
      token,
      body: outputsBody([{ path: "z", content: "z" }]),
    });
    expect(big.body.code).toBe("too_many_outputs");
    expect((await reread(workerEnv, j.job.id)).failure_detail).toBe("too_many_outputs");
  });

  test("a body over the derived cap is `too_many_outputs`, charged, with the launcher files presigned; a body that is not JSON is `invalid_spec`", async () => {
    await policyOf({ maxFiles: 3 });
    const j = await person();
    const token = await tokenFor(j.job.id);
    const notJson = await call(j.job.id, "outputs", { token, raw: "this is not json" });
    expect([notJson.status, notJson.body.code]).toEqual([400, "invalid_spec"]);
    expect((await reread(workerEnv, j.job.id)).failure_detail).toBeNull();
    // The cap is never below the launcher's own 1 MiB.
    const over = await call(j.job.id, "outputs", {
      token,
      raw: JSON.stringify({ pad: "x".repeat(1024 * 1024) }),
    });
    await expectRefused(over, "too_many_outputs", 413, j.job.id);
  });

  test("the launcher's follow-up with no outputs is accepted; failure_detail is never cleared; outputs after a refusal are refused again", async () => {
    await policyOf({ maxFiles: 1, maxStoredBytesPerPerson: 1 });
    const j = await person();
    const token = await tokenFor(j.job.id);
    const files = ["a", "b"].map((n) => ({ path: `${n}.txt`, content: n }));
    const refused = await call(j.job.id, "outputs", { token, body: outputsBody(files) });
    expect(refused.body.code).toBe("too_many_outputs");
    // The follow-up names no outputs. The PERSON'S share is not applied to the launcher's own files
    // (one byte would refuse them), they are claimed, and the declared file says so. The platform's
    // total still is: see the next test.
    const sizes = launcherSizesOf();
    const followUp = await call(j.job.id, "outputs", {
      token,
      body: { outputs: [], launcher: sizes },
    });
    expect(followUp.status).toBe(200);
    expect((followUp.body.uploads as Array<{ path: string }>).map((u) => u.path).sort()).toEqual(
      LAUNCHER_PATHS,
    );
    const row = await reread(workerEnv, j.job.id);
    expect(row.failure_detail).toBe("too_many_outputs");
    expect(row.results_bytes).toBe(sizes.reduce((n, f) => n + f.size, 0));
    const declared = JSON.parse(
      (await (await fx.harness.results.get(declaredKey(j.job.id)))?.text()) as string,
    );
    expect(declared.outputs).toEqual([]);
    expect(declared.launcher).toHaveLength(4);
    expect(await uploadAll(followUp, [])).toEqual([200, 200, 200, 200]);
    expect((await call(j.job.id, "outputs/complete", { token })).status).toBe(200);
    // After `complete` no address is issued at all, whatever the body names: `bad_state`, no uploads
    // (a refused request BEFORE `complete` is refused with the recorded word: see "a refusal replayed").
    const late = await call(j.job.id, "outputs", {
      token: await tokenFor(j.job.id),
      body: outputsBody([{ path: "a.txt", content: "a" }]),
    });
    expect([late.status, late.body.code, late.body.uploads]).toEqual([409, "bad_state", undefined]);
  });
});

describe("the launcher's own files", () => {
  const LAUNCHER_PATHS = LAUNCHER_FILE_NAMES.map((n) => `launcher/${n}`).sort();

  // Round 1 of #2041: the follow-up claim skipped BOTH quotas and each launcher file's declared size
  // was bounded by nothing but the job limit.
  test("the follow-up is held to the PLATFORM's total even though the person's share is skipped: refused, nothing claimed, the files still presigned", async () => {
    await policyOf({
      maxFiles: 1,
      maxStoredBytesPerPerson: 1,
      maxStoredBytesTotal: 1000,
      maxJobBytes: 1000,
    });
    const holder = await person();
    await workerEnv.DB.prepare("UPDATE compute_jobs SET results_bytes = 950 WHERE id = ?")
      .bind(holder.job.id)
      .run();
    const j = await person();
    const token = await tokenFor(j.job.id);
    const files = ["a", "b"].map((n) => ({ path: `${n}.txt`, content: n }));
    expect((await call(j.job.id, "outputs", { token, body: outputsBody(files) })).body.code).toBe(
      "too_many_outputs",
    );
    // 100 bytes of launcher files do not fit the 50 left on the platform.
    const followUp = await call(j.job.id, "outputs", {
      token,
      body: { outputs: [], launcher: launcherFiles([25, 25, 25, 25]) },
    });
    expect([followUp.status, followUp.body.code]).toEqual([409, "results_quota_exceeded"]);
    const row = await reread(workerEnv, j.job.id);
    expect(row.results_bytes).toBeNull();
    expect(row.failure_detail).toBe("too_many_outputs");
    expect(await hasDeclared(j.job.id)).toBe(false);
    expect((followUp.body.uploads as Array<{ path: string }>).map((u) => u.path).sort()).toEqual(
      LAUNCHER_PATHS,
    );
    // 50 bytes fit exactly.
    const fits = await call(j.job.id, "outputs", {
      token,
      body: { outputs: [], launcher: launcherFiles([10, 10, 10, 20]) },
    });
    expect(fits.status).toBe(200);
    expect((await reread(workerEnv, j.job.id)).results_bytes).toBe(50);
  });

  test("each launcher file is capped on its own: a document at the outputs-body bound and a log at 16 MiB are accepted, one byte more is `results_too_large`, recorded", async () => {
    await policyOf({
      maxFiles: 100,
      maxJobBytes: 4 * 1024 ** 3,
      maxStoredBytesPerPerson: 4 * 1024 ** 3,
      maxStoredBytesTotal: 4 * 1024 ** 3,
    });
    // The documents' bound for maxFiles 100: the 1 MiB floor. The log's: 16 MiB. Written out, not
    // imported, so the test fails at any other value.
    const docCap = 1024 * 1024;
    const logCap = 16 * 1024 * 1024;
    const sizes = (doc: number, log: number) =>
      launcherFiles(LAUNCHER_FILE_NAMES.map((n) => (n === "launcher.log" ? log : doc)));
    const ok = await person();
    const accepted = await call(ok.job.id, "outputs", {
      token: await tokenFor(ok.job.id),
      body: { outputs: [], launcher: sizes(docCap, logCap) },
    });
    expect(accepted.status).toBe(200);
    for (const [name, launcher] of [
      ["a document one byte over", sizes(docCap + 1, logCap)],
      ["a log one byte over", sizes(docCap, logCap + 1)],
    ] as const) {
      const j = await person();
      const reply = await call(j.job.id, "outputs", {
        token: await tokenFor(j.job.id),
        body: { outputs: [], launcher },
      });
      expect([name, reply.status, reply.body.code]).toEqual([name, 413, "results_too_large"]);
      expect([name, (await reread(workerEnv, j.job.id)).failure_detail]).toEqual([
        name,
        "results_too_large",
      ]);
      expect([name, (await reread(workerEnv, j.job.id)).results_bytes]).toEqual([name, null]);
    }
  });
});

// --- outputs: the claim ---------------------------------------------------------------------------

describe("outputs claims the bytes in one conditional UPDATE", () => {
  test("two jobs racing for the last bytes of a person: exactly one wins (MUTATION: read the quota in a separate query before the UPDATE)", async () => {
    await policyOf({ maxStoredBytesPerPerson: 100, maxJobBytes: 100 });
    const a = await person();
    const b = await makeJob(fx, { env: workerEnv });
    await workerEnv.DB.prepare("UPDATE compute_jobs SET account_id = ?1 WHERE id = ?2")
      .bind(a.accountId, b.job.id)
      .run();
    // 40 bytes of output and 40 of launcher files: 80 each; the person has room for one of them.
    const body = outputsBody(
      [{ path: "o.txt", content: "x".repeat(40) }],
      launcherFiles([10, 10, 10, 10]),
    );
    // Mint both tokens first, so the two requests overlap in the statements that matter; every
    // statement takes a round trip, as D1's network does, so a read-then-write is not atomic here.
    const tokens = [await tokenFor(a.job.id), await tokenFor(b.job.id)];
    const saved = workerEnv;
    workerEnv = { ...workerEnv, DB: roundTripD1(workerEnv.DB) } as Bindings;
    const results = await Promise.all([
      call(a.job.id, "outputs", { token: tokens[0], body }),
      call(b.job.id, "outputs", { token: tokens[1], body }),
    ]);
    workerEnv = saved;
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)?.body.code).toBe("results_quota_exceeded");
    const claimed = await workerEnv.DB.prepare(
      "SELECT SUM(results_bytes) AS n FROM compute_jobs WHERE account_id = ?",
    )
      .bind(a.accountId)
      .first<{ n: number }>();
    expect(claimed?.n).toBe(80);
  });

  test("two jobs of two people racing for the last bytes of the platform: exactly one wins", async () => {
    await policyOf({ maxStoredBytesTotal: 100, maxJobBytes: 100, maxStoredBytesPerPerson: 1000 });
    const a = await person();
    const b = await person();
    const body = outputsBody(
      [{ path: "o.txt", content: "x".repeat(40) }],
      launcherFiles([10, 10, 10, 10]),
    );
    const tokens = [await tokenFor(a.job.id), await tokenFor(b.job.id)];
    const saved = workerEnv;
    workerEnv = { ...workerEnv, DB: roundTripD1(workerEnv.DB) } as Bindings;
    const results = await Promise.all([
      call(a.job.id, "outputs", { token: tokens[0], body }),
      call(b.job.id, "outputs", { token: tokens[1], body }),
    ]);
    workerEnv = saved;
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const total = await workerEnv.DB.prepare(
      "SELECT SUM(results_bytes) AS n FROM compute_jobs",
    ).first<{ n: number }>();
    expect(total?.n).toBe(80);
  });

  test("a loser's refusal leaves no address, no claim and no declared file", async () => {
    await policyOf({ maxStoredBytesPerPerson: 100, maxJobBytes: 100 });
    const a = await person();
    await workerEnv.DB.prepare("UPDATE compute_jobs SET results_bytes = 90 WHERE id = ?")
      .bind(a.job.id)
      .run();
    const b = await makeJob(fx, { env: workerEnv });
    await workerEnv.DB.prepare("UPDATE compute_jobs SET account_id = ?1 WHERE id = ?2")
      .bind(a.accountId, b.job.id)
      .run();
    const reply = await call(b.job.id, "outputs", {
      token: await tokenFor(b.job.id),
      body: outputsBody(
        [{ path: "o.txt", content: "x".repeat(40) }],
        launcherFiles([10, 10, 10, 10]),
      ),
    });
    expect(reply.status).toBe(409);
    expect((await reread(workerEnv, b.job.id)).results_bytes).toBeNull();
    expect(await resultsKeys(`jobs/${b.job.id}/`)).toEqual([]);
  });
});

// --- outputs: the accepted path --------------------------------------------------------------------

describe("outputs, accepted", () => {
  const FILES: OutputFile[] = [
    { path: "report.txt", content: "the report" },
    { path: "deep/dir/a..b.csv", content: "dots inside a name" },
    { path: "100%.txt", content: "a percent sign" },
    { path: "with space.txt", content: "a space" },
    { path: "ünï/çødé.txt", content: "non-ASCII" },
    { path: "a+b.txt", content: "a plus" },
  ];

  test("every name round-trips: each address lands its file under the job's prefix, and complete verifies them", async () => {
    const j = await person();
    const token = await tokenFor(j.job.id);
    const launcher = Object.fromEntries(LAUNCHER_FILE_NAMES.map((n) => [n, `launcher ${n}`]));
    const reply = await call(j.job.id, "outputs", {
      token,
      body: outputsBody(FILES, launcherSizesOf(launcher)),
    });
    expect(reply.status).toBe(200);
    const uploads = reply.body.uploads as Array<{ path: string; url: string }>;
    expect(uploads.map((u) => u.path).sort()).toEqual(
      [
        ...FILES.map((f) => `outputs/${f.path}`),
        ...LAUNCHER_FILE_NAMES.map((n) => `launcher/${n}`),
      ].sort(),
    );
    const lifetime = Date.parse(reply.body.expires_at) - Date.now();
    expect(lifetime).toBeGreaterThan(59 * MINUTE);
    expect(lifetime).toBeLessThanOrEqual(60 * MINUTE);
    expect(await uploadAll(reply, FILES, launcher)).toEqual(uploads.map(() => 200));
    expect(await resultsKeys(`jobs/${j.job.id}/outputs/`)).toEqual(
      FILES.map((f) => `jobs/${j.job.id}/outputs/${f.path}`).sort(),
    );
    for (const f of FILES) {
      const object = await fx.harness.results.get(`jobs/${j.job.id}/outputs/${f.path}`);
      expect(await object?.text()).toBe(f.content);
    }
    // Claimed in full, once, and the declared file is canonical (sorted) and the Worker's own.
    const row = await reread(workerEnv, j.job.id);
    const total =
      FILES.reduce((n, f) => n + encoder.encode(f.content).length, 0) +
      Object.values(launcher).reduce((n, t) => n + encoder.encode(t).length, 0);
    expect(row.results_bytes).toBe(total);
    const declared = JSON.parse(
      (await (await fx.harness.results.get(declaredKey(j.job.id)))?.text()) as string,
    );
    expect(declared.outputs.map((o: { path: string }) => o.path)).toEqual(
      [...FILES.map((f) => f.path)].sort(),
    );
    // The declared file is outside the two prefixes an address is ever signed for.
    expect(uploads.some((u) => u.path.includes("declared"))).toBe(false);
    expect((await call(j.job.id, "outputs/complete", { token })).status).toBe(200);
    expect((await reread(workerEnv, j.job.id)).outputs_completed_at).not.toBeNull();
  });

  test("a replay re-presigns and changes nothing; another body for a claimed job is `bad_state`", async () => {
    const j = await person();
    const token = await tokenFor(j.job.id);
    const body = outputsBody(FILES.slice(0, 2));
    const first = await call(j.job.id, "outputs", { token, body });
    const before = await reread(workerEnv, j.job.id);
    const declaredBefore = await (await fx.harness.results.get(declaredKey(j.job.id)))?.text();
    const again = await call(j.job.id, "outputs", {
      token,
      body: { outputs: [...body.outputs].reverse(), launcher: [...body.launcher].reverse() },
    });
    expect(again.status).toBe(200);
    expect((again.body.uploads as Array<{ path: string }>).map((u) => u.path).sort()).toEqual(
      (first.body.uploads as Array<{ path: string }>).map((u) => u.path).sort(),
    );
    const after = await reread(workerEnv, j.job.id);
    expect(after.results_bytes).toBe(before.results_bytes);
    expect(await (await fx.harness.results.get(declaredKey(j.job.id)))?.text()).toBe(
      declaredBefore,
    );
    // Another body (one more file) is not a replay.
    const other = await call(j.job.id, "outputs", { token, body: outputsBody(FILES.slice(0, 3)) });
    expect([other.status, other.body.code]).toEqual([409, "bad_state"]);
    expect((await reread(workerEnv, j.job.id)).results_bytes).toBe(before.results_bytes);
  });

  test("no address is issued after `complete`", async () => {
    const j = await person();
    const token = await tokenFor(j.job.id);
    const reply = await call(j.job.id, "outputs", {
      token,
      body: outputsBody(FILES.slice(0, 1), launcherSizesOf()),
    });
    await uploadAll(reply, FILES.slice(0, 1));
    expect((await call(j.job.id, "outputs/complete", { token })).status).toBe(200);
    const late = await call(j.job.id, "outputs", {
      token,
      body: outputsBody(FILES.slice(0, 1), launcherSizesOf()),
    });
    expect([late.status, late.body.code]).toEqual([409, "bad_state"]);
    expect(late.body.uploads).toBeUndefined();
  });

  test("a request that is not valid is `invalid_spec`, naming the field and never the value", async () => {
    const j = await person();
    const token = await tokenFor(j.job.id);
    const bad: Array<[string, unknown, string?]> = [
      [
        "a traversal",
        { outputs: [{ path: "../x", size: 1, sha256: "a".repeat(64) }], launcher: launcherFiles() },
        "outputs.0.path",
      ],
      [
        "an absolute path",
        {
          outputs: [{ path: "/etc/passwd", size: 1, sha256: "a".repeat(64) }],
          launcher: launcherFiles(),
        },
        "outputs.0.path",
      ],
      [
        "a duplicate path",
        {
          outputs: [
            { path: "a", size: 1, sha256: "a".repeat(64) },
            { path: "a", size: 2, sha256: "b".repeat(64) },
          ],
          launcher: launcherFiles(),
        },
        "outputs.1.path",
      ],
      [
        "a launcher file named twice",
        { outputs: [], launcher: [...launcherFiles().slice(0, 3), launcherFiles()[0]] },
        "launcher",
      ],
      [
        "a missing launcher file",
        { outputs: [], launcher: launcherFiles().slice(0, 3) },
        "launcher",
      ],
      ["an extra key", { outputs: [], launcher: launcherFiles(), more: 1 }, undefined],
      [
        "a negative size",
        { outputs: [{ path: "a", size: -1, sha256: "a".repeat(64) }], launcher: launcherFiles() },
        "outputs.0.size",
      ],
      [
        "a short digest",
        { outputs: [{ path: "a", size: 1, sha256: "abc" }], launcher: launcherFiles() },
        "outputs.0.sha256",
      ],
    ];
    for (const [name, body, field] of bad) {
      const reply = await call(j.job.id, "outputs", { token, body });
      expect([name, reply.status, reply.body.code]).toEqual([name, 400, "invalid_spec"]);
      if (field !== undefined) expect([name, reply.body.field]).toEqual([name, field]);
      expect(reply.text).not.toContain("passwd");
    }
    expect((await reread(workerEnv, j.job.id)).failure_detail).toBeNull();
    expect(await hasDeclared(j.job.id)).toBe(false);
  });

  // Round 1 of #2041: a path the schema allowed (512 characters) whose object KEY could not be signed
  // (over 1,024 bytes of UTF-8, or a lone surrogate) was found out AFTER the claim, so the route
  // answered 500 and the replay answered 409 `bad_state`, with the bytes claimed for nothing.
  test("a path whose object key cannot be signed is `invalid_spec` before the claim, naming the output, and a corrected request is accepted", async () => {
    const j = await person();
    const token = await tokenFor(j.job.id);
    const unsignable: Array<[string, string]> = [
      ["a key over 1,024 bytes", "\u3042".repeat(350)],
      ["a lone surrogate", "bad-\ud800-name.txt"],
    ];
    for (const [name, path] of unsignable) {
      const body = {
        outputs: [
          { path: "fine.txt", size: 1, sha256: "a".repeat(64) },
          { path, size: 1, sha256: "b".repeat(64) },
        ],
        launcher: launcherFiles(),
      };
      const reply = await call(j.job.id, "outputs", { token, body });
      expect([name, reply.status, reply.body.code, reply.body.field]).toEqual([
        name,
        400,
        "invalid_spec",
        "outputs.1.path",
      ]);
      const row = await reread(workerEnv, j.job.id);
      expect([name, row.results_bytes, row.failure_detail]).toEqual([name, null, null]);
      expect([name, await hasDeclared(j.job.id)]).toEqual([name, false]);
      expect(reply.text).not.toContain("\u3042");
    }
    const fixed = await call(j.job.id, "outputs", {
      token,
      body: outputsBody(FILES.slice(0, 1), launcherSizesOf()),
    });
    expect(fixed.status).toBe(200);
  });
});

// --- complete -------------------------------------------------------------------------------------

describe("complete", () => {
  test("a missing or a short object is 409 `results_incomplete`, retryable; all present is 200, once", async () => {
    const j = await person();
    const token = await tokenFor(j.job.id);
    const files = [
      { path: "a.txt", content: "alpha" },
      { path: "b.txt", content: "bravo" },
    ];
    const reply = await call(j.job.id, "outputs", {
      token,
      body: outputsBody(files, launcherSizesOf()),
    });
    const uploads = reply.body.uploads as Array<{ path: string; url: string }>;
    const urlOf = (path: string) => uploads.find((u) => u.path === path)?.url as string;

    // Nothing uploaded: incomplete, and the job is not marked.
    let res = await call(j.job.id, "outputs/complete", { token });
    expect([res.status, res.body.code]).toEqual([409, "results_incomplete"]);
    expect((await reread(workerEnv, j.job.id)).outputs_completed_at).toBeNull();
    // Everything but one launcher file, and an output that is SHORT.
    for (const f of files.slice(0, 1)) await put(urlOf(`outputs/${f.path}`), f.content);
    await put(urlOf("outputs/b.txt"), "bra");
    for (const n of LAUNCHER_FILE_NAMES.slice(1))
      await put(urlOf(`launcher/${n}`), `launcher ${n}`);
    res = await call(j.job.id, "outputs/complete", { token });
    expect([res.status, res.body.code]).toEqual([409, "results_incomplete"]);
    // The launcher uploads what is wrong and asks again.
    await put(urlOf("outputs/b.txt"), "bravo");
    res = await call(j.job.id, "outputs/complete", { token });
    expect([res.status, res.body.code]).toEqual([409, "results_incomplete"]);
    await put(urlOf("launcher/result.json"), "launcher result.json");
    res = await call(j.job.id, "outputs/complete", { token });
    expect([res.status, res.body]).toEqual([200, { ok: true }]);
    const stamped = (await reread(workerEnv, j.job.id)).outputs_completed_at;
    expect(stamped).not.toBeNull();
    // Idempotent: seen twice (a lost answer), it answers the same and writes nothing.
    await workerEnv.DB.prepare(
      "UPDATE compute_jobs SET outputs_completed_at = '2001-01-01 00:00:00' WHERE id = ?",
    )
      .bind(j.job.id)
      .run();
    res = await call(j.job.id, "outputs/complete", { token });
    expect(res.status).toBe(200);
    expect((await reread(workerEnv, j.job.id)).outputs_completed_at).toBe("2001-01-01 00:00:00");
  });

  test("complete before any outputs request is `bad_state`", async () => {
    const j = await person();
    const token = await tokenFor(j.job.id);
    const early = await call(j.job.id, "outputs/complete", { token });
    expect([early.status, early.body.code]).toEqual([409, "bad_state"]);
  });

  test("once complete has answered 200, an object removed afterwards is NOT re-checked: a replay answers the same 200 and writes nothing", async () => {
    const j = await person();
    const token = await tokenFor(j.job.id);
    const files: OutputFile[] = [{ path: "report.txt", content: "a result" }];
    const reply = await call(j.job.id, "outputs", {
      token,
      body: outputsBody(files, launcherSizesOf()),
    });
    expect(await uploadAll(reply, files)).toEqual([200, 200, 200, 200, 200]);
    expect((await call(j.job.id, "outputs/complete", { token })).status).toBe(200);
    const stamped = (await reread(workerEnv, j.job.id)).outputs_completed_at;
    expect(stamped).not.toBeNull();
    await fx.harness.results.delete(`jobs/${j.job.id}/outputs/report.txt`);
    const replay = await call(j.job.id, "outputs/complete", { token });
    expect([replay.status, replay.body]).toEqual([200, { ok: true }]);
    expect((await reread(workerEnv, j.job.id)).outputs_completed_at).toBe(stamped);
  });
});

// --- The launcher's whole run through these routes ------------------------------------------------

// Round 1 of #2041: a job already running on a cluster hands in its results while the API is
// read-only, through the REAL routes behind the REAL maintenance middleware.
describe("maintenance mode and the launcher", () => {
  test("read-only: the three callbacks work for a live job; the person's cancel and links are refused; full refuses the callbacks too", async () => {
    const j = await person();
    const token = await tokenFor(j.job.id);
    workerEnv = { ...workerEnv, MAINTENANCE_MODE: "read-only" } as Bindings;
    const files: OutputFile[] = [{ path: "report.txt", content: "a result" }];
    const outputs = await call(j.job.id, "outputs", {
      token,
      body: outputsBody(files, launcherSizesOf()),
    });
    expect(outputs.status).toBe(200);
    expect(await uploadAll(outputs, files)).toEqual([200, 200, 200, 200, 200]);
    // `complete` is the callback that ends the upload: a job refused here never finishes.
    expect((await call(j.job.id, "outputs/complete", { token })).status).toBe(200);
    const cancel = await handle(
      new Request(`http://api.test/compute/jobs/${j.job.id}/cancel`, { method: "POST" }),
      workerEnv,
    );
    expect(cancel.status).toBe(503);
    const links = await handle(
      new Request(`http://api.test/compute/jobs/${j.job.id}/links`, { method: "POST" }),
      workerEnv,
    );
    expect(links.status).toBe(503);

    const other = await person();
    const otherToken = await tokenFor(other.job.id);
    workerEnv = { ...workerEnv, MAINTENANCE_MODE: "full" } as Bindings;
    for (const route of ["bundle", "outputs", "outputs/complete"] as const) {
      const refused = await call(other.job.id, route, {
        token: otherToken,
        body: outputsBody(files, launcherSizesOf()),
      });
      expect([route, refused.status, refused.body.mode]).toEqual([route, 503, "full"]);
    }
    expect((await reread(workerEnv, other.job.id)).results_bytes).toBeNull();
  });
});

describe("the launcher's whole run, through the routes", () => {
  /** What a launcher does, from the specification Tapis gave it: read `api_base` and the token, call the routes. */
  async function launcherRun(
    uuid: string,
    files: OutputFile[],
    opts: { failure?: { code: string; detail: string } } = {},
  ) {
    const spec = JSON.parse(launchSpecTextSeenByTapis(fx, uuid)) as {
      api_base: string;
      job_id: string;
      job_token: string;
    };
    const post = async (path: string, body?: unknown) => {
      const res = await fetch(`${spec.api_base}/compute/jobs/${spec.job_id}/${path}`, {
        method: "POST",
        headers: { "X-Compute-Job-Token": spec.job_token, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };
    const digest = sha(launchSpecTextSeenByTapis(fx, uuid));
    const exit = opts.failure ? 16 : 0;
    const docs: Record<string, string> = {
      "result.json": JSON.stringify({
        job_id: spec.job_id,
        failure_code: opts.failure?.code ?? null,
        detail: opts.failure?.detail ?? null,
        exit_number: exit,
        entry_exit_code: opts.failure ? 1 : 0,
      }),
      "provenance.json": JSON.stringify({
        job_id: spec.job_id,
        launch_spec_digest: digest,
        bundle_digest: null,
        image: {
          uri: JSON.parse(launchSpecTextSeenByTapis(fx, uuid)).image.uri,
          digest: JSON.parse(launchSpecTextSeenByTapis(fx, uuid)).image.digest,
        },
        runtime_version: "test 1",
        staging: [],
        timings: { run: 1 },
        slurm_job_id: null,
        entry_exit_code: 0,
      }),
      "manifest.json": JSON.stringify({
        job_id: spec.job_id,
        files: files.map((f) => ({
          path: f.path,
          size: encoder.encode(f.content).length,
          sha256: sha(f.content),
        })),
      }),
      "launcher.log": "launcher log\n",
    };
    const sizes = LAUNCHER_FILE_NAMES.map((name) => ({
      name,
      size: encoder.encode(docs[name] as string).length,
    }));
    let answer = await post("outputs", outputsBody(files, sizes));
    if (answer.status !== 200) {
      // The refusal carries the launcher's files; the follow-up declares no outputs.
      await uploadAll({ status: answer.status, text: "", body: answer.body }, [], docs);
      answer = await post("outputs", { outputs: [], launcher: sizes });
    }
    await uploadAll({ status: 200, text: "", body: answer.body }, files, docs);
    const complete = await post("outputs/complete");
    return { complete, exit };
  }

  test("a run that uploads everything, then Tapis FINISHED: verified, finished, charged, copied, mailed once", async () => {
    const made = await makeJob(fx, { env: workerEnv });
    expect(await submitComputeJob(workerEnv, made.job.id)).toEqual({
      ok: true,
      outcome: "submitted",
    });
    const uuid = (await reread(workerEnv, made.job.id)).tapis_uuid as string;
    fx.tapis.advance(uuid, "RUNNING");
    await advanceComputeJob(workerEnv, made.job.id);
    const files = [
      { path: "result.txt", content: "the answer" },
      { path: "sub/x..y.csv", content: "1,2,3" },
    ];
    const run = await launcherRun(uuid, files);
    expect(run.complete.status).toBe(200);
    expect((await reread(workerEnv, made.job.id)).outputs_completed_at).not.toBeNull();
    fx.tapis.advance(uuid, "FINISHED");
    setTapisTimes(fx, uuid, 30 * MINUTE, 0);
    const record = fx.tapis.jobs.get(uuid)?.record;
    if (record) record.remoteResultInfo = "0";
    await advanceComputeJob(workerEnv, made.job.id);
    const job = await reread(workerEnv, made.job.id);
    expect(job.state).toBe("finished");
    expect(job.results_verified_at).not.toBeNull();
    expect(job.charged_milli).toBe(2000);
    expect(job.result_records_at).not.toBeNull();
    expect(job.platform_failure).toBe(0);
    expect(fx.mail.mails).toHaveLength(1);
    // The launcher's files and the manifest (as result-manifest.json) are in the records.
    for (const key of [
      `records/${job.id}/result.json`,
      `records/${job.id}/provenance.json`,
      `records/${job.id}/result-manifest.json`,
      `logs/${job.id}/launcher.log`,
    ]) {
      expect([key, (await fx.harness.records.head(key)) !== null]).toEqual([key, true]);
    }
  });

  test("a run the outputs route refuses ends `result_upload_failed`: charged, and not a platform failure", async () => {
    await policyOf({ maxFiles: 1 });
    const made = await makeJob(fx, { env: workerEnv });
    await submitComputeJob(workerEnv, made.job.id);
    const uuid = (await reread(workerEnv, made.job.id)).tapis_uuid as string;
    fx.tapis.advance(uuid, "RUNNING");
    const files = [
      { path: "a.txt", content: "a" },
      { path: "b.txt", content: "b" },
    ];
    // The launcher is refused, uploads its own files after the follow-up, and fails with the refusal.
    const spec = JSON.parse(launchSpecTextSeenByTapis(fx, uuid)) as {
      api_base: string;
      job_id: string;
      job_token: string;
    };
    const refused = await fetch(`${spec.api_base}/compute/jobs/${spec.job_id}/outputs`, {
      method: "POST",
      headers: { "X-Compute-Job-Token": spec.job_token },
      body: JSON.stringify(outputsBody(files)),
    });
    expect(refused.status).toBe(413);
    fx.tapis.advance(uuid, "FAILED", "JOB_REMOTE_OUTCOME_ERROR");
    setTapisTimes(fx, uuid, 30 * MINUTE, 0);
    const record = fx.tapis.jobs.get(uuid)?.record;
    if (record) record.remoteResultInfo = "16";
    await advanceComputeJob(workerEnv, made.job.id);
    const job = await reread(workerEnv, made.job.id);
    expect([job.state, job.failure_code, job.failure_detail, job.platform_failure]).toEqual([
      "failed",
      "result_upload_failed",
      "too_many_outputs",
      0,
    ]);
    // It ran for 30 minutes, and those units stay consumed: there is no refund.
    expect(job.charged_milli).toBe(2000);
    const kinds = (
      await workerEnv.DB.prepare("SELECT kind FROM compute_ledger WHERE job_id = ? ORDER BY id")
        .bind(job.id)
        .all<{ kind: string }>()
    ).results.map((r) => r.kind);
    expect(kinds).toEqual(["hold", "charge"]);
  });

  test("the launcher's token stops working the moment the job is terminal, and the bundle address is not re-issued", async () => {
    const made = await makeJob(fx, { env: workerEnv });
    await submitComputeJob(workerEnv, made.job.id);
    const uuid = (await reread(workerEnv, made.job.id)).tapis_uuid as string;
    fx.tapis.advance(uuid, "RUNNING");
    const spec = JSON.parse(launchSpecTextSeenByTapis(fx, uuid)) as {
      api_base: string;
      job_id: string;
      job_token: string;
    };
    const callIt = (route: string) =>
      fetch(`${spec.api_base}/compute/jobs/${spec.job_id}/${route}`, {
        method: "POST",
        headers: { "X-Compute-Job-Token": spec.job_token },
        body: JSON.stringify(outputsBody([])),
      });
    expect((await callIt("outputs")).status).toBe(200);
    fx.tapis.advance(uuid, "FAILED", "JOB_LAUNCH_FAILURE");
    await advanceComputeJob(workerEnv, made.job.id);
    for (const route of ["outputs", "outputs/complete", "bundle"]) {
      expect([route, (await callIt(route)).status]).toEqual([route, 404]);
    }
  });
});

// --- Logs ----------------------------------------------------------------------------------------

describe("logs", () => {
  test("no token, presigned address, path or secret reaches a log, for a refusal, a claim, a quota race or a completion", async () => {
    await policyOf({ maxFiles: 2, maxStoredBytesPerPerson: 100_000 });
    const files = [{ path: "very-secret-name.txt", content: "payload" }];
    let token = "";
    let url = "";
    const lines = await logged(async () => {
      const j = await person();
      token = await tokenFor(j.job.id);
      await call(j.job.id, "outputs", { token: "f".repeat(64), body: outputsBody(files) });
      const ok = await call(j.job.id, "outputs", {
        token,
        body: outputsBody(files, launcherSizesOf()),
      });
      url = (ok.body.uploads as Array<{ url: string }>)[0]?.url ?? "";
      await uploadAll(ok, files);
      await call(j.job.id, "outputs/complete", { token });
      const k = await person();
      await call(k.job.id, "outputs", {
        token: await tokenFor(k.job.id),
        body: outputsBody(["a", "b", "c"].map((n) => ({ path: `${n}.txt`, content: n }))),
      });
    });
    const joined = lines.join("\n");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(url).toContain("X-Amz-Signature");
    const signature = new URL(url).searchParams.get("X-Amz-Signature") as string;
    for (const word of [
      token,
      "f".repeat(64),
      signature,
      "X-Amz",
      "very-secret-name",
      CALLBACK_SECRET,
      fx.harness.standin.secretAccessKey,
    ]) {
      expect([word, joined.includes(word)]).toEqual([word, false]);
    }
    expect(
      lines.some((l) => l.includes("[compute-outputs] refused") && l.includes("too_many_outputs")),
    ).toBe(true);
  });
});
