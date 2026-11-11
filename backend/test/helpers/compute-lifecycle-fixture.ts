/**
 * The world the compute lifecycle suites run in (epic #2005 phase A5, #2010; ADR 0118).
 *
 * NO NEMAR DECISION IS STOOD IN FOR, but ONE STEP IS PLAYED: `playLauncher` writes the launcher's files
 * and `declared.json` into the results bucket directly and stamps `outputs_completed_at` by an UPDATE,
 * where the launcher would go through the outputs and complete routes. Those routes are driven for real
 * by `compute-job-callbacks.test.ts` and by the route-driven full path in `compute-full-path.test.ts`
 * (which does not use `playLauncher` at all); a suite that uses `playLauncher` is about what the
 * lifecycle does with what the launcher left, not about how it got there.
 *
 * The database is real SQLite carrying every migration (and,
 * for the cases that name it, Miniflare's D1, the engine `wrangler --local` runs); the two buckets are
 * Miniflare's R2 reached through the Worker's own bindings; the S3 interface the signer addresses is
 * the real local server over those buckets; the Tapis tenant is the A4 stand-in (a real HTTP server
 * built from Tapis's published specifications, no response of which was recorded from a real tenant);
 * mail goes to a local server in place of `api.resend.com`. The services and routes under test are the
 * production ones.
 *
 * The one thing added here is a forwarding proxy in front of the Tapis stand-in (`LossyProxy`), a real
 * HTTP intermediary that can drop the answer to a submit AFTER the stand-in has acted on it, which is
 * what a lost response is and what the stand-in's own failure modes (they act before they answer)
 * cannot make. It decides nothing.
 *
 * THE LAUNCHER STAND-IN HASHES WHAT THE TAPIS STAND-IN RECEIVED. `launchSpecEnvSeenByTapis` reads
 * the `NEMAR_LAUNCH_SPEC` environment value out of the stand-in's own job record, and
 * `launchSpecTextSeenByTapis` decodes it the way the launcher does (`decodeLaunchSpecEnv`, strict)
 * into the specification's JSON text. The launcher's `provenance.json` is built from the digest of
 * THAT TEXT, never from the digest the Worker stored: a check that compared the Worker's number
 * with itself would prove nothing.
 */

import type { Database } from "bun:sqlite";
import type { JobSpec } from "../../../shared/contract/compute";
import { JobSpecSchema, LAUNCHER_FILES } from "../../../shared/contract/compute";
import {
  decodeLaunchSpecEnv,
  resultsLauncherKey,
  resultsOutputKey,
} from "../../../shared/contract/compute-launch";
import { type ComputeJobRow, createJob, getJob } from "../../src/services/compute-jobs";
import { declaredKey, declaredText } from "../../src/services/compute-verify";
import { __resetTapisTokenCacheForTests } from "../../src/services/tapis/auth";
import type { Bindings } from "../../src/types/bindings";
import { type ComputeHarness, startComputeHarness } from "./compute-harness";
import { fundAccount, fundPlatform, seedUser, setPolicy, sha256Hex } from "./compute-seed";
import { type TapisStandin, startTapisStandin } from "./tapis-standin";

export const CALLBACK_SECRET = "lifecycle-callback-secret-0123456789abcdef";
export const RUNTIME_IMAGE_DIGEST = `sha256:${"b".repeat(64)}`;
export const RUNTIME_IMAGE = `ghcr.io/example/nemar-python@${RUNTIME_IMAGE_DIGEST}`;
export const APP_BASE = "https://app.example.test";

// --- A real HTTP intermediary in front of the stand-in -------------------------------------------

export interface LossyProxy {
  url: string;
  /** Forward the next `n` submits to the stand-in (which acts on them) and answer 503 instead. */
  loseSubmitAnswers(n: number): void;
  /** Run `fn` after the stand-in has handled the next submit and before the answer goes back. */
  afterNextSubmit(fn: () => Promise<void>): void;
  stop(): void;
}

export function startLossyProxy(upstream: string): LossyProxy {
  let lose = 0;
  let after: (() => Promise<void>) | null = null;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const url = new URL(req.url);
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.text();
      let forwarded: Response;
      try {
        forwarded = await fetch(`${upstream}${url.pathname}${url.search}`, {
          method: req.method,
          headers: req.headers,
          body,
          redirect: "manual",
        });
      } catch {
        // The stand-in is down: a proxy answers that the gateway is bad, as every proxy does.
        return new Response("bad gateway", { status: 502 });
      }
      const isSubmit = req.method === "POST" && url.pathname === "/v3/jobs/submit";
      if (isSubmit) {
        const hook = after;
        after = null;
        if (hook) await hook();
        if (lose > 0) {
          lose -= 1;
          return new Response("upstream gateway error", { status: 503 });
        }
      }
      return new Response(await forwarded.arrayBuffer(), {
        status: forwarded.status,
        headers: { "Content-Type": forwarded.headers.get("content-type") ?? "application/json" },
      });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    loseSubmitAnswers(n) {
      lose = n;
    },
    afterNextSubmit(fn) {
      after = fn;
    },
    stop() {
      server.stop(true);
    },
  };
}

// --- Mail, captured at the boundary ----------------------------------------------------------------

export interface CapturedMail {
  to: string[];
  subject: string;
  html: string;
}

export interface MailCapture {
  mails: CapturedMail[];
  stop(): void;
}

/** `api.resend.com` redirected to a local server for as long as the capture lives (as `withFakeResend` does). */
export function startMailCapture(): MailCapture {
  const mails: CapturedMail[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const body = (await req.json().catch(() => null)) as CapturedMail | null;
      if (body && typeof body === "object" && "subject" in body) mails.push(body);
      return new Response(JSON.stringify({ id: "mail-ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    if (url.hostname === "api.resend.com") {
      return realFetch(new Request(new URL(url.pathname, `http://127.0.0.1:${server.port}`), req));
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
  return {
    mails,
    stop() {
      globalThis.fetch = realFetch;
      server.stop(true);
    },
  };
}

// --- The fixture -----------------------------------------------------------------------------------

export interface LifecycleFixture {
  harness: ComputeHarness;
  tapis: TapisStandin;
  proxy: LossyProxy;
  mail: MailCapture;
  /** The owner account policy writes are made as. */
  ownerId: number;
  /** A Worker environment: production, compute on, Tapis and the buckets configured. */
  env(over?: Partial<Bindings>): Bindings;
  reset(): Promise<void>;
  dispose(): Promise<void>;
}

export async function startLifecycleFixture(
  options: { withD1?: boolean } = {},
): Promise<LifecycleFixture> {
  const harness = await startComputeHarness(options);
  const tapis = startTapisStandin();
  // The stand-in's `up()` listens unconditionally, so a case that left it down must be brought back
  // exactly once and a case that did not must not be.
  let tapisDown = false;
  const downOnce = tapis.down.bind(tapis);
  const upOnce = tapis.up.bind(tapis);
  tapis.down = () => {
    if (!tapisDown) downOnce();
    tapisDown = true;
  };
  tapis.up = () => {
    if (tapisDown) upOnce();
    tapisDown = false;
  };
  const proxy = startLossyProxy(tapis.url);
  const mail = startMailCapture();
  const previous = (globalThis as { NEMAR_TAPIS_API_URL?: string }).NEMAR_TAPIS_API_URL;
  (globalThis as { NEMAR_TAPIS_API_URL?: string }).NEMAR_TAPIS_API_URL = proxy.url;
  __resetTapisTokenCacheForTests();

  const fx: LifecycleFixture = {
    harness,
    tapis,
    proxy,
    mail,
    ownerId: 0,
    env(over = {}) {
      return harness.env({
        COMPUTE_ENABLED: "1",
        TAPIS_AUTH_STRATEGY: "password",
        TAPIS_USERNAME: tapis.username,
        TAPIS_PASSWORD: tapis.password,
        TAPIS_TENANT_ID: tapis.tenantId,
        PRESCREEN_CALLBACK_SECRET: CALLBACK_SECRET,
        API_BASE_URL: "http://127.0.0.1:9",
        APP_BASE_URL: APP_BASE,
        COMPUTE_RUNTIME_IMAGE: RUNTIME_IMAGE,
        RESEND_API_KEY: "re_lifecycle_test",
        FROM_EMAIL: "NEMAR <noreply@example.test>",
        ...over,
      });
    },
    async reset() {
      await harness.reset();
      tapis.up();
      tapis.reset();
      proxy.loseSubmitAnswers(0);
      mail.mails.length = 0;
      __resetTapisTokenCacheForTests();
      fx.ownerId = await seedUser(fx.env().DB, { role: "owner" });
      // A platform budget that does not bind, so a case sees only what it is about.
      await fundPlatform(fx.env().DB, "people", 1_000_000_000);
    },
    async dispose() {
      mail.stop();
      proxy.stop();
      tapis.stop();
      (globalThis as { NEMAR_TAPIS_API_URL?: string }).NEMAR_TAPIS_API_URL = previous;
      __resetTapisTokenCacheForTests();
      await harness.dispose();
    },
  };
  return fx;
}

// --- Jobs --------------------------------------------------------------------------------------------

/** A job a launcher can run: a python command (no recipe), one dataset at a version with a data-plane tag. */
export function launchableSpec(over: Record<string, unknown> = {}): JobSpec {
  return JobSpecSchema.parse({
    name: "a launchable job",
    runtime: "python",
    command: ["analyse", "--fast"],
    datasets: [{ id: "nm000104", version: "1.0.2" }],
    partition: "shared",
    cores: 4,
    minutes: 60,
    ...over,
  });
}

export interface MadeJob {
  job: ComputeJobRow;
  accountId: number;
  env: Bindings;
}

/** A funded person and a job made through `createJob` (its hold included), records written. */
export async function makeJob(
  fx: LifecycleFixture,
  over: {
    spec?: Record<string, unknown>;
    grant?: number;
    source?: "cli" | "web" | "pipeline";
    account?: Parameters<typeof seedUser>[1];
    env?: Bindings;
  } = {},
): Promise<MadeJob> {
  const env = over.env ?? fx.env();
  const accountId = await seedUser(env.DB, over.account ?? {});
  await fundAccount(env.DB, accountId, over.grant ?? 100_000);
  const result = await createJob(env, {
    source: over.source ?? "cli",
    accountId,
    appId: "nemar-launch",
    appVersion: "1.0.0",
    spec: launchableSpec(over.spec),
  });
  if (!result.ok) throw new Error(`could not make a job: ${result.code}`);
  if (!result.recordsWritten) throw new Error("the job's records were not written");
  return { job: result.job, accountId, env };
}

export async function reread(env: Bindings, id: string): Promise<ComputeJobRow> {
  const job = await getJob(env.DB, id);
  if (!job) throw new Error("no such job");
  return job;
}

export const iso = (ms: number) => new Date(ms).toISOString();

/** Set the times Tapis reports for a job (the stand-in serves its record as it is mutated). */
export function setTapisTimes(
  fx: LifecycleFixture,
  uuid: string,
  startedMsAgo: number | null,
  endedMsAgo: number | null,
): void {
  const record = fx.tapis.jobs.get(uuid)?.record;
  if (!record) throw new Error("no such Tapis job");
  const now = Date.now();
  record.remoteStarted = startedMsAgo === null ? null : iso(now - startedMsAgo);
  record.remoteEnded = endedMsAgo === null ? null : iso(now - endedMsAgo);
}

export const MINUTE = 60_000;

// --- The launcher stand-in -----------------------------------------------------------------------------

/** The `NEMAR_LAUNCH_SPEC` value the Tapis stand-in received for a job: base64url, as sent. */
export function launchSpecEnvSeenByTapis(fx: LifecycleFixture, uuid: string): string {
  const record = fx.tapis.jobs.get(uuid)?.record as
    | { parameterSet?: { envVariables?: Array<{ key: string; value: string }> } }
    | undefined;
  const value = record?.parameterSet?.envVariables?.find(
    (v) => v.key === "NEMAR_LAUNCH_SPEC",
  )?.value;
  if (typeof value !== "string") throw new Error("the stand-in received no launch specification");
  return value;
}

/**
 * The launch specification's JSON TEXT the launcher gets from that value: decoded strictly, as the
 * launcher does, and the bytes it hashes. A value the launcher would refuse throws here, so a test
 * never reads a specification the real launcher could not.
 */
export function launchSpecTextSeenByTapis(fx: LifecycleFixture, uuid: string): string {
  const decoded = decodeLaunchSpecEnv(launchSpecEnvSeenByTapis(fx, uuid));
  if (!decoded.ok) {
    throw new Error(`the launcher would refuse the launch specification: ${decoded.reason}`);
  }
  return decoded.text;
}

/** The job token inside the launch specification the Tapis stand-in received. */
export function jobTokenSeenByTapis(fx: LifecycleFixture, uuid: string): string {
  return (JSON.parse(launchSpecTextSeenByTapis(fx, uuid)) as { job_token: string }).job_token;
}

export interface LauncherPlan {
  outputs?: Array<{ path: string; content: string }>;
  /** The launcher's failure code and detail (a non-null code makes the exit number the code's). */
  failureCode?: string | null;
  detail?: string | null;
  /** Override what the launcher writes; each is the launcher's own mistake or lie. */
  jobIdInDocs?: string;
  launchDigest?: string;
  bundleDigest?: string | null;
  imageDigest?: string;
  exitNumber?: number;
  /** Do not upload this launcher file, or this output. */
  omit?: Array<"result" | "provenance" | "manifest" | "log" | "declared">;
  /** The declared size of an output that differs from the bytes uploaded. */
  declaredSizeDelta?: number;
  /** Do not mark the upload complete (the launcher never called `complete`). */
  incomplete?: boolean;
  /** Skip uploading the bytes of the output at this index (declared and never uploaded). */
  skipUpload?: number;
}

const encoder = new TextEncoder();

/**
 * Play the launcher's end of a job by writing what it would have uploaded into the results bucket,
 * through the binding, and marking the upload complete the way the `complete` route does. The
 * provenance carries the digest of the value the Tapis stand-in RECEIVED. The route-driven version,
 * which goes through the outputs and complete routes and presigned addresses, is
 * `compute-job-callbacks.test.ts`'s and `compute-full-path.test.ts`'s.
 */
export async function playLauncher(
  fx: LifecycleFixture,
  env: Bindings,
  job: ComputeJobRow,
  uuid: string,
  plan: LauncherPlan = {},
): Promise<{ digest: string }> {
  const results = fx.harness.results;
  const jobId = plan.jobIdInDocs ?? job.id;
  const outputs = plan.outputs ?? [{ path: "report.txt", content: "a result" }];
  const files: Array<{ path: string; size: number; sha256: string }> = [];
  for (const [i, o] of outputs.entries()) {
    const bytes = encoder.encode(o.content);
    if (plan.skipUpload !== i) await results.put(resultsOutputKey(job.id, o.path), bytes);
    files.push({
      path: o.path,
      size: bytes.length + (i === 0 ? (plan.declaredSizeDelta ?? 0) : 0),
      sha256: await sha256Hex(bytes),
    });
  }
  const digest = await sha256Hex(encoder.encode(launchSpecTextSeenByTapis(fx, uuid)));
  const code = plan.failureCode ?? null;
  const exit =
    plan.exitNumber ??
    (code === null
      ? 0
      : 10 +
        [
          "code_fetch_failed",
          "dataset_fetch_failed",
          "entry_not_found",
          "runtime_error",
          "out_of_memory",
          "time_limit",
          "result_upload_failed",
        ].indexOf(code));
  const docs = {
    result: {
      job_id: jobId,
      failure_code: code,
      detail: plan.detail ?? null,
      exit_number: exit,
      entry_exit_code: code === null ? 0 : 1,
    },
    provenance: {
      job_id: jobId,
      launch_spec_digest: plan.launchDigest ?? digest,
      bundle_digest: plan.bundleDigest === undefined ? null : plan.bundleDigest,
      image: { uri: RUNTIME_IMAGE, digest: plan.imageDigest ?? RUNTIME_IMAGE_DIGEST },
      runtime_version: "test-runtime 1.0",
      staging: [],
      timings: { run: 1 },
      slurm_job_id: null,
      entry_exit_code: code === null ? 0 : 1,
    },
    manifest: { job_id: jobId, files },
  };
  const skipped = new Set(plan.omit ?? []);
  const launcherSizes: Array<{
    name: (typeof LAUNCHER_FILES)[keyof typeof LAUNCHER_FILES];
    size: number;
  }> = [];
  const put = async (
    tag: "result" | "provenance" | "manifest" | "log",
    name: (typeof LAUNCHER_FILES)[keyof typeof LAUNCHER_FILES],
    text: string,
  ) => {
    const bytes = encoder.encode(text);
    launcherSizes.push({ name, size: bytes.length });
    if (!skipped.has(tag)) await results.put(resultsLauncherKey(job.id, name), bytes);
  };
  await put("result", LAUNCHER_FILES.result, JSON.stringify(docs.result));
  await put("provenance", LAUNCHER_FILES.provenance, JSON.stringify(docs.provenance));
  await put("manifest", LAUNCHER_FILES.manifest, JSON.stringify(docs.manifest));
  await put("log", LAUNCHER_FILES.log, "launcher log line\n");
  if (!skipped.has("declared")) {
    await results.put(
      declaredKey(job.id),
      encoder.encode(
        declaredText(
          job.id,
          files,
          launcherSizes.map((f) => ({ name: f.name, size: f.size })),
        ),
      ),
    );
  }
  if (!plan.incomplete) {
    await env.DB.prepare(
      "UPDATE compute_jobs SET outputs_completed_at = datetime('now') WHERE id = ?1",
    )
      .bind(job.id)
      .run();
  }
  return { digest };
}

/** A direct handle on the bun:sqlite database, for the cases that age a row or read what no route shows. */
export function sqliteOf(fx: LifecycleFixture): Database {
  return fx.harness.db;
}

export { setPolicy };
