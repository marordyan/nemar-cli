/**
 * The Tapis client (epic #2005 phase A4, #2009; ADR 0118), driven against a REAL local HTTP server,
 * `helpers/tapis-standin.ts`, through `globalThis.NEMAR_TAPIS_API_URL`. The client under test is the
 * production one; nothing in it is replaced.
 *
 * NO RESPONSE THIS FILE RELIES ON WAS RECORDED FROM A REAL TENANT. There is no tenant yet. The
 * stand-in answers with the request and response examples of Tapis's published OpenAPI
 * specifications and documentation, so these tests prove the client does what NEMAR means against
 * what Tapis SAYS it does, and nothing about what a real tenant does. The pull request lists what is
 * unverified: which credential strategy the operator grants, whether `listType=ALL_JOBS` lists more
 * than the caller's own and shared jobs, the POST search body, the permission to mint service tokens,
 * the webhook retry policy, and the scheduler option for GPUs.
 *
 * What is pinned, each by a test of its own:
 *  - both credential strategies (a password grant, and a service credential that mints a token per
 *    username) are chosen by configuration, and the very same client call works under either;
 *  - a token is cached by strategy and username, refreshed inside a lead before it ends, shared by
 *    concurrent callers (one mint), and a failed mint is dropped;
 *  - a 401 refreshes the token once and retries once; a second 401 is `unauthorized`;
 *  - a hung upstream ends as `unavailable` inside the timeout; reads retry through `isRetryable` and
 *    a submit never does; a body that is not JSON, fails its schema or is too large is
 *    `invalid_response`, never partly trusted;
 *  - `submitJob` sends exactly the documented request: the tag, GPUs as a scheduler option, the
 *    partition as the logical queue, and no archive system field;
 *  - the launch specification (which holds the job's token) travels in `parameterSet`, which a Tapis
 *    job record returns to whoever can read the record: the client never hands that field back, and no
 *    credential or token is in any error message or log line;
 *  - the value of `NEMAR_LAUNCH_SPEC` is base64url text and nothing else (A1c, #2043): the client refuses
 *    a raw JSON value, any character outside `A-Za-z0-9-_` and a value over the encoded bound BEFORE a
 *    request is built, so a scheduler that quotes conditionally and has a shell source its launch file
 *    is never handed a value that file cannot carry. The encoded value holds the token, so it is held
 *    to every "never echoed" rule the plain token is.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { TAPIS_JOB_STATUSES } from "../../shared/compute-state";
import { LAUNCHER_ENV, PARTITION_NAMES } from "../../shared/contract/compute";
import {
  LAUNCH_SPEC_ENV_MAX_CHARS,
  LAUNCH_SPEC_MAX_BYTES,
  type LaunchSpecEnvValue,
  SHELL_INERT_ENV_ALPHABET,
  encodeLaunchSpecEnv,
} from "../../shared/contract/compute-launch";
import {
  __resetTapisTokenCacheForTests,
  getTapisToken,
  invalidateTapisToken,
  mintTapisToken,
} from "../src/services/tapis/auth";
import {
  type SubmitJobInput,
  SubmitRequestRefused,
  TAPIS_MAX_DOWNLOAD_BYTES,
  TAPIS_MAX_JSON_BYTES,
  TAPIS_TIMEOUT_MS,
  type TapisContext,
  cancelJob,
  downloadOutput,
  downloadOutputPrefix,
  effectiveTimeoutMs,
  getJob,
  getJobHistory,
  listJobs,
  listOutputs,
  nemarJobTag,
  searchJobsByTag,
  submitJob,
  subscribeWebhook,
  tapisHealth,
} from "../src/services/tapis/client";
import * as clientModule from "../src/services/tapis/client";
import { TAPIS_BASE, tapisConfig } from "../src/services/tapis/config";
import { TAPIS_ERROR_KINDS, TapisError } from "../src/services/tapis/errors";
import { SubmitJobRequestSchema } from "../src/services/tapis/schemas";
import { launchSecretForms } from "./helpers/launch-secret-forms";
import { launchFileLine } from "./helpers/scheduler-launch-file";
import { SPEC_JOB_STATUSES, type TapisStandin, startTapisStandin } from "./helpers/tapis-standin";

const OWNER = "someone-owner";
const OTHER_OWNER = "another-owner";
const JOB_ID = "job_0123456789abcdef01234567";
/** Stands for the job's token inside the launch specification. It must never be echoed. */
const TOKEN_MARK = "JOBTOKEN-MARK-5512";
/**
 * A stand-in for a launch specification's text: NOT a valid specification (the client checks only the
 * shape of the value it is given, never the document), but printable ASCII with the token mark in it
 * and no space, the case a conditional quoter would leave bare.
 */
const LAUNCH_SPEC_TEXT = `{"schema":"nemar.launch-spec.v1","job_id":"${JOB_ID}","job_token":"${TOKEN_MARK}"}`;
/**
 * The value of `NEMAR_LAUNCH_SPEC`: that text in base64url. It holds the token, which is no longer a
 * plain substring of it, so a test that looks for a leak looks for the value too (`SPEC_SECRETS`).
 */
const LAUNCH_SPEC = encodeLaunchSpecEnv(LAUNCH_SPEC_TEXT);
/**
 * What must never be echoed: the token in every form it takes (plain, inside the whole encoded value, and
 * as the three alignments of its base64url text), so that a leak of part of the value is seen too.
 */
const SPEC_SECRETS = launchSecretForms(TOKEN_MARK, LAUNCH_SPEC);
/**
 * A value the client must refuse. The type is branded and only `encodeLaunchSpecEnv` returns the brand,
 * so a value that is meant to be invalid is cast to it, here, in the one place that says so.
 */
const notAValue = (value: string) => value as LaunchSpecEnvValue;

let standin: TapisStandin;
let previousOverride: string | undefined;

beforeAll(() => {
  // The password strategy's configured account IS the owner NEMAR passes (one NEMAR identity).
  standin = startTapisStandin({ username: OWNER });
  previousOverride = (globalThis as { NEMAR_TAPIS_API_URL?: string }).NEMAR_TAPIS_API_URL;
  (globalThis as { NEMAR_TAPIS_API_URL?: string }).NEMAR_TAPIS_API_URL = standin.url;
});

afterAll(() => {
  (globalThis as { NEMAR_TAPIS_API_URL?: string }).NEMAR_TAPIS_API_URL = previousOverride;
  standin.stop();
});

beforeEach(() => {
  standin.reset();
  __resetTapisTokenCacheForTests();
});

type EnvLike = Parameters<typeof tapisConfig>[0];

/** An address nothing listens on and that the override must keep the client away from. */
const UNREACHABLE = "https://tapis-tenant.invalid";

function passwordEnv(over: Record<string, unknown> = {}): EnvLike {
  return {
    ENVIRONMENT: "production",
    TAPIS_AUTH_STRATEGY: "password",
    TAPIS_BASE_URL: UNREACHABLE,
    TAPIS_TENANT_ID: standin.tenantId,
    TAPIS_USERNAME: standin.username,
    TAPIS_PASSWORD: standin.password,
    ...over,
  } as EnvLike;
}

function serviceEnv(over: Record<string, unknown> = {}): EnvLike {
  return {
    ENVIRONMENT: "production",
    TAPIS_AUTH_STRATEGY: "service",
    TAPIS_BASE_URL: UNREACHABLE,
    TAPIS_TENANT_ID: standin.tenantId,
    TAPIS_SERVICE_TOKEN: standin.serviceToken,
    ...over,
  } as EnvLike;
}

const STRATEGIES = [
  ["password", passwordEnv],
  ["service", serviceEnv],
] as const;

/** A call context with a short timeout and no wait between retries, so no test waits. */
function ctx(env: EnvLike, over: Partial<TapisContext> = {}): TapisContext {
  return { env, owner: OWNER, timeoutMs: 400, retryDelayMs: 1, ...over };
}

/** Run with the test override of the address removed, as a deployed Worker is. */
async function withoutOverride<T>(run: () => T | Promise<T>): Promise<T> {
  const g = globalThis as { NEMAR_TAPIS_API_URL?: string };
  const saved = g.NEMAR_TAPIS_API_URL;
  try {
    g.NEMAR_TAPIS_API_URL = undefined;
    return await run();
  } finally {
    g.NEMAR_TAPIS_API_URL = saved;
  }
}

const SUBMIT: SubmitJobInput = {
  jobId: JOB_ID,
  appId: "nemar-launch",
  appVersion: "1.0.0",
  partition: "shared",
  nodes: 1,
  coresPerNode: 8,
  memoryMb: 16384,
  gpus: 0,
  minutes: 120,
  launchSpecEnv: LAUNCH_SPEC,
};

async function failure(run: () => Promise<unknown>): Promise<TapisError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof TapisError) return err;
    throw err;
  }
  throw new Error("expected a TapisError, but the call succeeded");
}

/** Capture what the code under test writes to the console, and put it back. */
function captureConsole(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const saved = { ...console };
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    console[level] = (...args: unknown[]) => {
      lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    };
  }
  return {
    lines,
    restore: () => {
      Object.assign(console, saved);
    },
  };
}

const jobCalls = (route: string) => standin.log.filter((r) => r.route === route);

// ---------------------------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------------------------

describe("tapisConfig and TAPIS_BASE", () => {
  test("a Worker with nothing set is unconfigured, and says which names are missing", async () => {
    // With the test override installed the address is never missing, so it is taken away here.
    const config = await withoutOverride(() => tapisConfig({} as EnvLike));
    expect(config).toEqual({
      unconfigured: true,
      problems: [
        "TAPIS_AUTH_STRATEGY:missing",
        "TAPIS_BASE_URL:missing",
        "TAPIS_TENANT_ID:missing",
      ],
    });
    // The override counts as an address, so only the strategy and the tenant are missing.
    expect(tapisConfig({} as EnvLike)).toEqual({
      unconfigured: true,
      problems: ["TAPIS_AUTH_STRATEGY:missing", "TAPIS_TENANT_ID:missing"],
    });
  });

  test("the password strategy needs a username and a password, and reads them", () => {
    expect(tapisConfig(passwordEnv({ TAPIS_BASE_URL: "https://a.example/" }))).toEqual({
      // The override is installed, so the address is the stand-in's, not the variable's.
      strategy: "password",
      baseUrl: standin.url,
      tenantId: standin.tenantId,
      username: standin.username,
      password: standin.password,
    });
    const missing = tapisConfig(passwordEnv({ TAPIS_PASSWORD: undefined, TAPIS_USERNAME: "" }));
    expect(missing).toEqual({
      unconfigured: true,
      problems: ["TAPIS_USERNAME:missing", "TAPIS_PASSWORD:missing"],
    });
  });

  test("the service strategy needs the service token, and reads an optional probe username", () => {
    expect(tapisConfig(serviceEnv())).toEqual({
      strategy: "service",
      baseUrl: standin.url,
      tenantId: standin.tenantId,
      serviceToken: standin.serviceToken,
      username: undefined,
    });
    expect(tapisConfig(serviceEnv({ TAPIS_USERNAME: "probe-user" }))).toMatchObject({
      strategy: "service",
      username: "probe-user",
    });
    expect(tapisConfig(serviceEnv({ TAPIS_SERVICE_TOKEN: undefined }))).toEqual({
      unconfigured: true,
      problems: ["TAPIS_SERVICE_TOKEN:missing"],
    });
  });

  test("a strategy that is neither is unconfigured, never a guess", () => {
    for (const strategy of ["oauth", "Password", " password", "SERVICE", ""]) {
      const config = tapisConfig(passwordEnv({ TAPIS_AUTH_STRATEGY: strategy }));
      expect(config).toMatchObject({ unconfigured: true });
      expect((config as { problems: string[] }).problems).toContain(
        strategy === "" ? "TAPIS_AUTH_STRATEGY:missing" : "TAPIS_AUTH_STRATEGY:unknown",
      );
    }
  });

  test("TAPIS_BASE is the test override when set, else the variable, without a trailing slash", async () => {
    const env = passwordEnv({ TAPIS_BASE_URL: "https://tenant.example/" });
    expect(TAPIS_BASE(env)).toBe(standin.url);
    await withoutOverride(() => {
      expect(TAPIS_BASE(env)).toBe("https://tenant.example");
      expect(TAPIS_BASE({} as EnvLike)).toBeUndefined();
      expect(TAPIS_BASE(passwordEnv({ TAPIS_BASE_URL: "  " }))).toBeUndefined();
    });
  });

  test("without the override, a variable that is not an https address is refused", async () => {
    await withoutOverride(() => {
      for (const bad of ["http://tenant.example", "tenant.example", "https://u:p@tenant.example"]) {
        expect(tapisConfig(passwordEnv({ TAPIS_BASE_URL: bad }))).toEqual({
          unconfigured: true,
          problems: ["TAPIS_BASE_URL:not_https"],
        });
      }
      expect(tapisConfig(passwordEnv({ TAPIS_BASE_URL: "https://tenant.example" }))).toMatchObject({
        strategy: "password",
        baseUrl: "https://tenant.example",
      });
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Unconfigured: nothing is sent
// ---------------------------------------------------------------------------------------------

describe("a Worker that is not configured", () => {
  test("every call is `unconfigured` and sends no request", async () => {
    const env = {} as EnvLike;
    const calls: Array<() => Promise<unknown>> = [
      () => submitJob(ctx(env), SUBMIT),
      () => getJob(ctx(env), "abc-007"),
      () => getJobHistory(ctx(env), "abc-007"),
      () => cancelJob(ctx(env), "abc-007"),
      () => searchJobsByTag(ctx(env), nemarJobTag(JOB_ID)),
      () => listJobs(ctx(env), { listType: "ALL_JOBS", limit: 10, skip: 0 }),
      () => subscribeWebhook(ctx(env), "abc-007", "https://hooks.example/x", 60),
      () => listOutputs(ctx(env), "abc-007", ""),
      () => downloadOutput(ctx(env), "abc-007", "work/outputs/a.csv", 1000),
      () => getTapisToken(env, { owner: OWNER }),
    ];
    for (const run of calls) {
      expect((await failure(run)).kind).toBe("unconfigured");
    }
    expect(standin.log).toHaveLength(0);
  });

  test("the health call is `unconfigured` without an address, and sends nothing", async () => {
    await withoutOverride(async () => {
      expect((await failure(() => tapisHealth({} as EnvLike))).kind).toBe("unconfigured");
    });
    expect(standin.log).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// The two strategies, and the same client under either
// ---------------------------------------------------------------------------------------------

describe("the password strategy", () => {
  test("posts the password grant, with no token header, for the configured account", async () => {
    const env = passwordEnv();
    await getJob(ctx(env), (await submitJob(ctx(env), SUBMIT)).uuid);
    const mints = jobCalls("POST /v3/oauth2/tokens");
    expect(mints).toHaveLength(1);
    expect(JSON.parse(mints[0]?.body ?? "")).toEqual({
      username: standin.username,
      password: standin.password,
      grant_type: "password",
    });
    expect(mints[0]?.headers["x-tapis-token"]).toBeUndefined();
    expect(mints[0]?.headers["content-type"]).toContain("application/json");
    expect(jobCalls("POST /v3/tokens")).toHaveLength(0);
  });

  test("a submit for an owner other than the configured account is refused, and sends nothing", async () => {
    const env = passwordEnv();
    // The token is always the configured account's, so a request that says another owner is a
    // configuration error, said with a fixed sentence that names no username.
    const err = await failure(() =>
      submitJob(ctx(env, { owner: OTHER_OWNER }), {
        ...SUBMIT,
        jobId: "job_aaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    );
    expect(err.kind).toBe("unconfigured");
    expect(err.message).toContain("owner is not the configured account");
    expect(err.message).not.toContain(OTHER_OWNER);
    expect(err.message).not.toContain(OWNER);
    expect(standin.log).toHaveLength(0);
    // The configured account itself is fine, and one token serves every call.
    await getJob(ctx(env), (await submitJob(ctx(env), SUBMIT)).uuid);
    expect(standin.mints()).toEqual({ password: 1, service: 0 });
  });

  test("a wrong password is `unauthorized` and is not retried", async () => {
    const env = passwordEnv({ TAPIS_PASSWORD: "not-the-password" });
    const err = await failure(() => getJob(ctx(env), "abc-007"));
    expect(err.kind).toBe("unauthorized");
    expect(err.status).toBe(401);
    expect(jobCalls("POST /v3/oauth2/tokens")).toHaveLength(1);
    expect(jobCalls("GET /v3/jobs/:uuid")).toHaveLength(0);
  });
});

describe("the service strategy", () => {
  test("posts the service token in X-Tapis-Token and the owner's username", async () => {
    const env = serviceEnv();
    await submitJob(ctx(env, { owner: OWNER }), SUBMIT);
    const mints = jobCalls("POST /v3/tokens");
    expect(mints).toHaveLength(1);
    expect(mints[0]?.headers["x-tapis-token"]).toBe(standin.serviceToken);
    expect(JSON.parse(mints[0]?.body ?? "")).toEqual({
      account_type: "user",
      token_tenant_id: standin.tenantId,
      token_username: OWNER,
      access_token_ttl: 3600,
    });
    expect(jobCalls("POST /v3/oauth2/tokens")).toHaveLength(0);
  });

  test("a token is kept for each owner, never shared between two", async () => {
    const env = serviceEnv();
    await submitJob(ctx(env, { owner: OWNER }), SUBMIT);
    await submitJob(ctx(env, { owner: OWNER }), {
      ...SUBMIT,
      jobId: "job_bbbbbbbbbbbbbbbbbbbbbbbb",
    });
    expect(standin.mints().service).toBe(1);
    await submitJob(ctx(env, { owner: OTHER_OWNER }), {
      ...SUBMIT,
      jobId: "job_cccccccccccccccccccccccc",
    });
    expect(standin.mints().service).toBe(2);
    const usernames = jobCalls("POST /v3/tokens").map((r) => JSON.parse(r.body).token_username);
    expect(usernames).toEqual([OWNER, OTHER_OWNER]);
    // The jobs were submitted under the token of their own owner.
    const owners = [...standin.jobs.values()].map((j) => j.record.createdby);
    expect(owners).toEqual([OWNER, OWNER, OTHER_OWNER]);
  });

  test("a service credential the tenant does not accept is `unauthorized`", async () => {
    const err = await failure(() =>
      getJob(ctx(serviceEnv({ TAPIS_SERVICE_TOKEN: "nope" })), "abc-007"),
    );
    expect(err.kind).toBe("unauthorized");
    expect(jobCalls("GET /v3/jobs/:uuid")).toHaveLength(0);
  });
});

describe.each(STRATEGIES)("the same client under the %s strategy", (_name, makeEnv) => {
  test("submits, reads, searches, cancels and lists with one set of calls", async () => {
    const env = makeEnv();
    const submitted = await submitJob(ctx(env), SUBMIT);
    expect(submitted.status).toBe("PENDING");
    expect(submitted.owner).toBe(OWNER);

    standin.advance(submitted.uuid, "QUEUED");
    standin.advance(submitted.uuid, "RUNNING");
    const running = await getJob(ctx(env), submitted.uuid);
    expect(running.status).toBe("RUNNING");
    expect(running.remoteStarted).toEqual(expect.any(String));

    const found = await searchJobsByTag(ctx(env), nemarJobTag(JOB_ID));
    expect(found.map((j) => j.uuid)).toEqual([submitted.uuid]);

    const listed = await listJobs(ctx(env), { listType: "ALL_JOBS", limit: 10, skip: 0 });
    expect(listed.map((j) => j.uuid)).toEqual([submitted.uuid]);

    const history = await getJobHistory(ctx(env), submitted.uuid);
    expect(history.map((e) => e.event)).toEqual([
      "JOB_NEW_STATUS",
      "JOB_NEW_STATUS",
      "JOB_NEW_STATUS",
    ]);

    await cancelJob(ctx(env), submitted.uuid);
    expect((await getJob(ctx(env), submitted.uuid)).status).toBe("CANCELLED");
  });

  test("every call after the mint carries the minted token in X-Tapis-Token", async () => {
    const env = makeEnv();
    const submitted = await submitJob(ctx(env), SUBMIT);
    await getJob(ctx(env), submitted.uuid);
    await getJobHistory(ctx(env), submitted.uuid);
    await listJobs(ctx(env), { listType: "MY_JOBS", limit: 5, skip: 0 });
    const calls = standin.log.filter((r) => r.path.startsWith("/v3/jobs/"));
    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(call.headers["x-tapis-token"]).toMatch(/^standin-token-/);
      expect(call.status).toBe(200);
    }
    // One token, used four times.
    expect(new Set(calls.map((c) => c.headers["x-tapis-token"])).size).toBe(1);
  });

  test("a 401 refreshes the token once and retries once", async () => {
    const env = makeEnv();
    const submitted = await submitJob(ctx(env), SUBMIT);
    standin.log.length = 0;
    standin.expireTokens();
    const job = await getJob(ctx(env), submitted.uuid);
    expect(job.uuid).toBe(submitted.uuid);
    // The call, the 401, a fresh mint, the retry that succeeded: and nothing else.
    expect(standin.log.map((r) => `${r.route} ${r.status}`)).toEqual([
      "GET /v3/jobs/:uuid 401",
      expect.stringMatching(/^POST \/v3\/(oauth2\/)?tokens 201$/),
      "GET /v3/jobs/:uuid 200",
    ]);
    expect(jobCalls("GET /v3/jobs/:uuid")[0]?.headers["x-tapis-token"]).not.toBe(
      jobCalls("GET /v3/jobs/:uuid")[1]?.headers["x-tapis-token"],
    );
  });

  test("a second 401 is `unauthorized`, after exactly one refresh and one retry", async () => {
    const env = makeEnv();
    const submitted = await submitJob(ctx(env), SUBMIT);
    standin.log.length = 0;
    standin.rejectAllTokens(true);
    const err = await failure(() => getJob(ctx(env), submitted.uuid));
    expect(err.kind).toBe("unauthorized");
    expect(err.status).toBe(401);
    expect(jobCalls("GET /v3/jobs/:uuid")).toHaveLength(2);
    expect(standin.log.filter((r) => r.route.includes("tokens"))).toHaveLength(1);
  });

  test("a 401 of a submit is refreshed and retried as well, because nothing was created", async () => {
    const env = makeEnv();
    await submitJob(ctx(env), SUBMIT);
    standin.expireTokens();
    await submitJob(ctx(env), { ...SUBMIT, jobId: "job_dddddddddddddddddddddddd" });
    expect([...standin.jobs.values()]).toHaveLength(2);
  });

  test("a hung upstream ends as `unavailable` inside the timeout, and reads try three times", async () => {
    const env = makeEnv();
    const submitted = await submitJob(ctx(env), SUBMIT);
    standin.hang("GET /v3/jobs/:uuid", 10);
    const started = Date.now();
    const err = await failure(() => getJob(ctx(env, { timeoutMs: 150 }), submitted.uuid));
    expect(err.kind).toBe("unavailable");
    expect(Date.now() - started).toBeLessThan(2000);
    expect(jobCalls("GET /v3/jobs/:uuid")).toHaveLength(3);
  });

  test("a submit that hangs is `unavailable` and is NEVER retried inside the client", async () => {
    const env = makeEnv();
    standin.hang("POST /v3/jobs/submit", 10);
    const err = await failure(() => submitJob(ctx(env, { timeoutMs: 150 }), SUBMIT));
    expect(err.kind).toBe("unavailable");
    expect(jobCalls("POST /v3/jobs/submit")).toHaveLength(1);
  });

  test("a submit answered 503 is `unavailable` and is not retried either", async () => {
    const env = makeEnv();
    standin.fail("POST /v3/jobs/submit", 503, 5);
    const err = await failure(() => submitJob(ctx(env), SUBMIT));
    expect(err.kind).toBe("unavailable");
    expect(err.status).toBe(503);
    expect(jobCalls("POST /v3/jobs/submit")).toHaveLength(1);
  });

  test("a read that is answered 503 twice and then 200 succeeds on the third try", async () => {
    const env = makeEnv();
    const submitted = await submitJob(ctx(env), SUBMIT);
    standin.fail("GET /v3/jobs/:uuid", 503, 2);
    const job = await getJob(ctx(env), submitted.uuid);
    expect(job.uuid).toBe(submitted.uuid);
    expect(jobCalls("GET /v3/jobs/:uuid").map((r) => r.status)).toEqual([503, 503, 200]);
  });

  test("a read that is answered 503 three times is `unavailable`, with the status", async () => {
    const env = makeEnv();
    const submitted = await submitJob(ctx(env), SUBMIT);
    standin.fail("GET /v3/jobs/:uuid", 503, 9);
    const err = await failure(() => getJob(ctx(env), submitted.uuid));
    expect(err.kind).toBe("unavailable");
    expect(err.status).toBe(503);
    expect(jobCalls("GET /v3/jobs/:uuid")).toHaveLength(3);
  });

  test("429 is `unavailable` and a read retries it", async () => {
    const env = makeEnv();
    const submitted = await submitJob(ctx(env), SUBMIT);
    standin.fail("GET /v3/jobs/:uuid", 429, 1);
    expect((await getJob(ctx(env), submitted.uuid)).uuid).toBe(submitted.uuid);
    expect(jobCalls("GET /v3/jobs/:uuid").map((r) => r.status)).toEqual([429, 200]);
    // And when it does not clear, it is `unavailable` (a rate limit is not a refusal of the request).
    standin.fail("GET /v3/jobs/:uuid", 429, 9);
    const err = await failure(() => getJob(ctx(env), submitted.uuid));
    expect(err.kind).toBe("unavailable");
    expect(err.status).toBe(429);
  });

  test("404 is `not_found`, 400 and 409 are `rejected`, each with its status and no retry", async () => {
    const env = makeEnv();
    const missing = await failure(() => getJob(ctx(env), "no-such-job-007"));
    expect(missing.kind).toBe("not_found");
    expect(missing.status).toBe(404);
    expect(jobCalls("GET /v3/jobs/:uuid")).toHaveLength(1);

    standin.fail("POST /v3/jobs/submit", 400);
    const bad = await failure(() => submitJob(ctx(env), SUBMIT));
    expect(bad.kind).toBe("rejected");
    expect(bad.status).toBe(400);

    const submitted = await submitJob(ctx(env), {
      ...SUBMIT,
      jobId: "job_eeeeeeeeeeeeeeeeeeeeeeee",
    });
    standin.advance(submitted.uuid, "FINISHED");
    const terminal = await failure(() => cancelJob(ctx(env), submitted.uuid));
    expect(terminal.kind).toBe("rejected");
    expect(terminal.status).toBe(409);
  });

  test("403 is `unauthorized` and is not refreshed", async () => {
    const env = makeEnv();
    const submitted = await submitJob(ctx(env), SUBMIT);
    standin.fail("GET /v3/jobs/:uuid", 403, 5);
    const err = await failure(() => getJob(ctx(env), submitted.uuid));
    expect(err.kind).toBe("unauthorized");
    expect(err.status).toBe(403);
    expect(jobCalls("GET /v3/jobs/:uuid")).toHaveLength(1);
    expect(standin.log.filter((r) => r.route.includes("tokens"))).toHaveLength(1);
  });

  test("a body that is not JSON is `invalid_response`, and is not retried", async () => {
    const env = makeEnv();
    const submitted = await submitJob(ctx(env), SUBMIT);
    standin.nonJson("GET /v3/jobs/:uuid", 5);
    const err = await failure(() => getJob(ctx(env), submitted.uuid));
    expect([err.kind, err.status]).toEqual(["invalid_response", 200]);
    expect(jobCalls("GET /v3/jobs/:uuid")).toHaveLength(1);
  });

  test("a body that fails its schema is `invalid_response`, never partly trusted", async () => {
    const env = makeEnv();
    const submitted = await submitJob(ctx(env), SUBMIT);
    // A job with no uuid, one with a status that is not a string, and an envelope with no result.
    for (const body of [
      {
        status: "success",
        message: "ok",
        version: "1",
        result: { owner: "x", status: "FINISHED" },
      },
      { status: "success", message: "ok", version: "1", result: { uuid: "u-007", status: 7 } },
      { status: "success", message: "ok", version: "1" },
      { status: 7, result: { uuid: "u-007", status: "FINISHED" } },
      [],
      null,
    ]) {
      standin.respond("GET /v3/jobs/:uuid", 200, body);
      const err = await failure(() => getJob(ctx(env), submitted.uuid));
      expect(err.kind).toBe("invalid_response");
    }
  });

  test("a response over the size bound is `invalid_response`", async () => {
    const env = makeEnv();
    const submitted = await submitJob(ctx(env), SUBMIT);
    const big = JSON.stringify({
      status: "success",
      message: "ok",
      version: "1",
      result: {
        uuid: submitted.uuid,
        status: "PENDING",
        lastMessage: "x".repeat(TAPIS_MAX_JSON_BYTES),
      },
    });
    standin.respond("GET /v3/jobs/:uuid", 200, big);
    const err = await failure(() => getJob(ctx(env), submitted.uuid));
    expect(err.kind).toBe("invalid_response");
  });

  test("a body that never ends is cut off at the bound, not read to its end", async () => {
    const env = makeEnv();
    const submitted = await submitJob(ctx(env), SUBMIT);
    let sent = 0;
    let cancelled = false;
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    // No Content-Length (it is chunked): only the streaming bound can stop this.
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    standin.respond("GET /v3/jobs/:uuid", 200, endless, 1, { "Content-Type": "application/json" });
    const err = await failure(() => getJob(ctx(env, { timeoutMs: 5000 }), submitted.uuid));
    expect(err.kind).toBe("invalid_response");
    // The client closed the connection; the server notices a moment later.
    for (let i = 0; i < 100 && !cancelled; i++) await new Promise((r) => setTimeout(r, 10));
    expect(cancelled).toBe(true);
    // It stopped near the bound (the server's own buffer reads a little ahead), not after reading
    // the stream for seconds: an unbounded read would have taken hundreds of megabytes by now.
    expect(sent).toBeLessThan(TAPIS_MAX_JSON_BYTES * 4);
  });

  test("a body that declares a size over the bound is refused before it is read", async () => {
    const env = makeEnv();
    const submitted = await submitJob(ctx(env), SUBMIT);
    // A raw socket, because an HTTP server library drops a declared length from a streamed body: it
    // sends the headers of a 2 MiB + 1 byte answer and then goes silent. A client that waited for the
    // body would end as `unavailable`, at the timeout; only the declared length says
    // `invalid_response` at once. The cached token is used, so the call needs no mint.
    const raw = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket) {
          socket.write(
            `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${TAPIS_MAX_JSON_BYTES + 1}\r\n\r\n `,
          );
        },
      },
    });
    const g = globalThis as { NEMAR_TAPIS_API_URL?: string };
    const saved = g.NEMAR_TAPIS_API_URL;
    try {
      g.NEMAR_TAPIS_API_URL = `http://127.0.0.1:${raw.port}`;
      const started = Date.now();
      const err = await failure(() => getJob(ctx(env, { timeoutMs: 3000 }), submitted.uuid));
      expect(err.kind).toBe("invalid_response");
      expect(Date.now() - started).toBeLessThan(1500);
    } finally {
      g.NEMAR_TAPIS_API_URL = saved;
      raw.stop(true);
    }
  });

  test("concurrent calls mint one token", async () => {
    const env = makeEnv();
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => getJob(ctx(env), "no-such-job-007")),
    );
    // Every call was answered 404 (the stand-in has no such job); what is pinned is the mint count.
    expect(
      results.map((r) => (r.status === "rejected" ? (r.reason as TapisError).kind : "ok")),
    ).toEqual(Array(8).fill("not_found"));
    expect(standin.mints().password + standin.mints().service).toBe(1);
    expect(jobCalls("GET /v3/jobs/:uuid")).toHaveLength(8);
  });

  test("a failed mint is dropped, so the next call mints afresh", async () => {
    const env = makeEnv();
    standin.fail(mintRouteOf(env), 503, 1);
    const first = await failure(() => getTapisToken(env, { owner: OWNER }));
    expect(first.kind).toBe("unavailable");
    const token = await getTapisToken(env, { owner: OWNER });
    expect(token).toMatch(/^standin-token-/);
    expect(standin.mints().password + standin.mints().service).toBe(1);
    // And a token that was minted is cached.
    expect(await getTapisToken(env, { owner: OWNER })).toBe(token);
    expect(standin.mints().password + standin.mints().service).toBe(1);
  });

  test("a mint that fails while callers wait fails them all, and is not remembered", async () => {
    const env = makeEnv();
    standin.fail(mintRouteOf(env), 503, 1);
    const settled = await Promise.allSettled(
      Array.from({ length: 4 }, () => getTapisToken(env, { owner: OWNER })),
    );
    expect(settled.every((s) => s.status === "rejected")).toBe(true);
    expect(standin.log.filter((r) => r.route.includes("tokens"))).toHaveLength(1);
    expect(typeof (await getTapisToken(env, { owner: OWNER }))).toBe("string");
  });

  test("invalidateTapisToken drops the refused token, so the next call mints again", async () => {
    const env = makeEnv();
    const first = await getTapisToken(env, { owner: OWNER });
    expect(await getTapisToken(env, { owner: OWNER })).toBe(first);
    invalidateTapisToken(env, OWNER, first);
    const second = await getTapisToken(env, { owner: OWNER });
    expect(second).not.toBe(first);
    expect(standin.mints().password + standin.mints().service).toBe(2);
  });

  test("invalidateTapisToken with an empty token never drops a mint in flight", async () => {
    const env = makeEnv();
    // The first call has started a mint (its cache entry holds no token yet, ""), and the second must
    // find it. An empty "refused" token must not match that entry: a later sweep could pass one.
    const first = getTapisToken(env, { owner: OWNER });
    invalidateTapisToken(env, OWNER, "");
    const second = getTapisToken(env, { owner: OWNER });
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(standin.mints().password + standin.mints().service).toBe(1);
  });

  test("invalidateTapisToken keeps a token that is not the refused one (compare, then delete)", async () => {
    const env = makeEnv();
    const current = await getTapisToken(env, { owner: OWNER });
    // A caller whose 401 came from an OLDER token must not delete the fresh one another caller minted.
    invalidateTapisToken(env, OWNER, "an-older-token");
    expect(await getTapisToken(env, { owner: OWNER })).toBe(current);
    expect(standin.mints().password + standin.mints().service).toBe(1);
  });

  test("after the tokens expire, many concurrent calls add exactly ONE mint", async () => {
    const env = makeEnv();
    const submitted = await submitJob(ctx(env), SUBMIT);
    const before = standin.mints().password + standin.mints().service;
    standin.expireTokens();
    // Eight callers hold the same stale token, all get a 401, and each used to delete the others'
    // fresh or in-flight mint. They must share one.
    const jobs = await Promise.all(
      Array.from({ length: 8 }, () => getJob(ctx(env), submitted.uuid)),
    );
    expect(jobs.every((j) => j.uuid === submitted.uuid)).toBe(true);
    expect(standin.mints().password + standin.mints().service - before).toBe(1);
    // Eight 401s, and the eight retries that followed.
    const gets = jobCalls("GET /v3/jobs/:uuid").map((r) => r.status);
    expect(gets.filter((c) => c === 401)).toHaveLength(8);
    expect(gets.filter((c) => c === 200)).toHaveLength(8);
  });

  test("a token is refreshed inside its lead and used before it", async () => {
    const env = makeEnv();
    // The stand-in's tokens live 14400 s; the lead is 300 s (5 minutes), so 14100 s is the edge.
    const t0 = 1_000_000_000_000;
    const first = await getTapisToken(env, { owner: OWNER, now: () => t0 });
    expect(await getTapisToken(env, { owner: OWNER, now: () => t0 + 14_099_000 })).toBe(first);
    expect(standin.mints().password + standin.mints().service).toBe(1);
    const refreshed = await getTapisToken(env, { owner: OWNER, now: () => t0 + 14_101_000 });
    expect(refreshed).not.toBe(first);
    expect(standin.mints().password + standin.mints().service).toBe(2);
  });
});

/** The route a strategy mints through. */
function mintRouteOf(env: EnvLike): "POST /v3/oauth2/tokens" | "POST /v3/tokens" {
  return (env as { TAPIS_AUTH_STRATEGY?: string }).TAPIS_AUTH_STRATEGY === "service"
    ? "POST /v3/tokens"
    : "POST /v3/oauth2/tokens";
}

// ---------------------------------------------------------------------------------------------
// submitJob: the documented request, exactly
// ---------------------------------------------------------------------------------------------

describe("submitJob", () => {
  test("sends exactly the documented request for a CPU job", async () => {
    await submitJob(ctx(passwordEnv()), SUBMIT);
    const sent = jobCalls("POST /v3/jobs/submit");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(sent[0]?.body ?? "")).toEqual({
      name: JOB_ID,
      appId: "nemar-launch",
      appVersion: "1.0.0",
      owner: OWNER,
      execSystemLogicalQueue: "shared",
      nodeCount: 1,
      coresPerNode: 8,
      memoryMB: 16384,
      maxMinutes: 120,
      parameterSet: {
        envVariables: [{ key: LAUNCHER_ENV.SPEC, value: LAUNCH_SPEC }],
        // Tapis archives the launch files (`tapisjob.env` holds the launch specification) unless told not to.
        archiveFilter: { includeLaunchFiles: false },
      },
      tags: [`nemar_job:${JOB_ID}`],
    });
  });

  test("passes GPUs as a scheduler option and the partition as the logical queue", async () => {
    await submitJob(ctx(serviceEnv()), {
      ...SUBMIT,
      partition: "gpu-shared",
      gpus: 2,
      memoryMb: undefined,
    });
    expect(JSON.parse(jobCalls("POST /v3/jobs/submit")[0]?.body ?? "")).toEqual({
      name: JOB_ID,
      appId: "nemar-launch",
      appVersion: "1.0.0",
      owner: OWNER,
      execSystemLogicalQueue: "gpu-shared",
      nodeCount: 1,
      coresPerNode: 8,
      maxMinutes: 120,
      parameterSet: {
        envVariables: [{ key: LAUNCHER_ENV.SPEC, value: LAUNCH_SPEC }],
        archiveFilter: { includeLaunchFiles: false },
        schedulerOptions: [{ arg: "--gpus=2" }],
      },
      tags: [`nemar_job:${JOB_ID}`],
    });
  });

  test("names no archive system, no execution system and no archive directory", async () => {
    await submitJob(ctx(passwordEnv()), SUBMIT);
    const body = JSON.parse(jobCalls("POST /v3/jobs/submit")[0]?.body ?? "");
    for (const key of [
      "archiveSystemId",
      "archiveSystemDir",
      "archiveMode",
      "archiveOnAppError",
      "execSystemId",
      "execSystemExecDir",
      "execSystemOutputDir",
      "subscriptions",
      "notes",
    ]) {
      expect(body).not.toHaveProperty(key);
    }
  });

  test("the owner is a parameter: it is the request's owner whoever it is", async () => {
    const env = serviceEnv();
    await submitJob(ctx(env, { owner: "first-person" }), SUBMIT);
    await submitJob(ctx(env, { owner: "second.person@x" }), {
      ...SUBMIT,
      jobId: "job_ffffffffffffffffffffffff",
    });
    const owners = jobCalls("POST /v3/jobs/submit").map((r) => JSON.parse(r.body).owner);
    expect(owners).toEqual(["first-person", "second.person@x"]);
  });

  test("a request it would not send is refused before anything is sent", async () => {
    const env = passwordEnv();
    const bad: Array<Partial<SubmitJobInput>> = [
      { jobId: "job_nothex" },
      { jobId: "JOB_0123456789ABCDEF01234567" },
      { appId: "" },
      { appVersion: "" },
      { partition: "not-a-partition" as never },
      { nodes: 0 },
      { nodes: 1.5 },
      { coresPerNode: 0 },
      { gpus: -1 },
      { minutes: 0 },
      { memoryMb: 0 },
      // The launch value's own refusals (empty, non-ASCII, over the bound, raw JSON, and more) are
      // one table, `REFUSED_VALUES`, further down: not repeated here.
    ];
    for (const over of bad) {
      await expect(submitJob(ctx(env), { ...SUBMIT, ...over })).rejects.toThrow(RangeError);
    }
    for (const owner of ["", " ", "a b", "a\nb", "x".repeat(200), "a/b"]) {
      await expect(submitJob(ctx(env, { owner }), SUBMIT)).rejects.toThrow(RangeError);
    }
    expect(standin.log).toHaveLength(0);
  });

  test("answers the job, and never hands back the field that holds the launch specification", async () => {
    const env = passwordEnv();
    const job = await submitJob(ctx(env), SUBMIT);
    // The stand-in's record has it, as Tapis's does (the job record returns parameterSet).
    const record = standin.jobs.get(job.uuid)?.record;
    // What the stand-in holds is the encoded value: the plain token is not a substring of it.
    expect(JSON.stringify(record)).toContain(LAUNCH_SPEC);
    expect(JSON.stringify(record)).not.toContain(TOKEN_MARK);
    // The client's answer holds neither the value nor the token.
    expect(job.uuid).toEqual(expect.any(String));
    expect(job.tags).toEqual([`nemar_job:${JOB_ID}`]);
    expect(job).not.toHaveProperty("parameterSet");
    expect(job).not.toHaveProperty("subscriptions");
    const read = await getJob(ctx(env), job.uuid);
    expect(read).not.toHaveProperty("parameterSet");
    const found = await searchJobsByTag(ctx(env), nemarJobTag(JOB_ID));
    for (const secret of SPEC_SECRETS) {
      expect(JSON.stringify(job)).not.toContain(secret);
      expect(JSON.stringify(read)).not.toContain(secret);
      expect(JSON.stringify(found)).not.toContain(secret);
    }
  });

  test("keeps what Tapis said that this client did not ask about (open responses)", async () => {
    const env = passwordEnv();
    const job = await submitJob(ctx(env), SUBMIT);
    standin.jobs.get(job.uuid)!.record.aFieldTapisAddedLater = { deep: [1, 2] };
    const read = await getJob(ctx(env), job.uuid);
    expect(read.aFieldTapisAddedLater).toEqual({ deep: [1, 2] });
  });
});

describe("nemarJobTag", () => {
  test("is nemar_job:<id> for a NEMAR job id, and refuses anything else", () => {
    expect(nemarJobTag(JOB_ID)).toBe(`nemar_job:${JOB_ID}`);
    for (const bad of [
      "",
      "job_x",
      "nemar_job:job_0123456789abcdef01234567",
      `${JOB_ID} `,
      "x'; DROP",
    ]) {
      expect(() => nemarJobTag(bad)).toThrow(RangeError);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The other calls, and the paths and bodies they send
// ---------------------------------------------------------------------------------------------

describe("the calls and what they send", () => {
  test("getJob and getJobHistory read the documented paths", async () => {
    const env = passwordEnv();
    const job = await submitJob(ctx(env), SUBMIT);
    standin.advance(job.uuid, "QUEUED");
    standin.log.length = 0;
    const read = await getJob(ctx(env), job.uuid);
    expect(read.status).toBe("QUEUED");
    expect(read.remoteSubmitted).toEqual(expect.any(String));
    expect(read.remoteJobId).toEqual(expect.any(String));
    const history = await getJobHistory(ctx(env), job.uuid, { limit: 5, skip: 1 });
    expect(history).toHaveLength(1);
    // The token was minted by the submit and is cached, so no mint is made here.
    expect(standin.log.map((r) => `${r.method} ${r.path}`)).toEqual([
      `GET /v3/jobs/${job.uuid}`,
      `GET /v3/jobs/${job.uuid}/history?limit=5&skip=1`,
    ]);
  });

  test("a terminal job's condition is carried through", async () => {
    const env = passwordEnv();
    const job = await submitJob(ctx(env), SUBMIT);
    standin.advance(job.uuid, "RUNNING");
    standin.advance(job.uuid, "FAILED", "SCHEDULER_OUT_OF_MEMORY");
    const read = await getJob(ctx(env), job.uuid);
    expect(read.status).toBe("FAILED");
    expect(read.condition).toBe("SCHEDULER_OUT_OF_MEMORY");
    expect(read.ended).toEqual(expect.any(String));
    expect(read.remoteEnded).toEqual(expect.any(String));
  });

  test("cancelJob posts to the cancel path with no body", async () => {
    const env = passwordEnv();
    const job = await submitJob(ctx(env), SUBMIT);
    standin.log.length = 0;
    await cancelJob(ctx(env), job.uuid);
    const call = jobCalls("POST /v3/jobs/:uuid/cancel");
    expect(call).toHaveLength(1);
    expect(call[0]?.path).toBe(`/v3/jobs/${job.uuid}/cancel`);
    expect(call[0]?.body).toBe("");
    expect(standin.jobs.get(job.uuid)?.status).toBe("CANCELLED");
  });

  test("cancelJob is not retried when the answer was lost (the caller's sweep decides)", async () => {
    const env = passwordEnv();
    const job = await submitJob(ctx(env), SUBMIT);
    standin.fail("POST /v3/jobs/:uuid/cancel", 503, 5);
    const err = await failure(() => cancelJob(ctx(env), job.uuid));
    expect(err.kind).toBe("unavailable");
    expect(jobCalls("POST /v3/jobs/:uuid/cancel")).toHaveLength(1);
  });

  test("searchJobsByTag posts the documented search body and asks only for named fields", async () => {
    const env = passwordEnv();
    const job = await submitJob(ctx(env), SUBMIT);
    await submitJob(ctx(env), { ...SUBMIT, jobId: "job_999999999999999999999999" });
    standin.log.length = 0;
    const found = await searchJobsByTag(ctx(env), nemarJobTag(JOB_ID));
    expect(found.map((j) => j.uuid)).toEqual([job.uuid]);
    const call = jobCalls("POST /v3/jobs/search")[0];
    expect(JSON.parse(call?.body ?? "")).toEqual({ search: [`tags IN ('nemar_job:${JOB_ID}')`] });
    const query = new URL(`http://x${call?.path}`).searchParams;
    expect(query.get("listType")).toBe("ALL_JOBS");
    const select = (query.get("select") ?? "").split(",");
    expect(select).toEqual(
      expect.arrayContaining(["uuid", "owner", "status", "tags", "condition"]),
    );
    // The fields that can hold a launch specification or a webhook address are never asked for.
    for (const field of ["parameterSet", "subscriptions", "fileInputs", "notes", "allAttributes"]) {
      expect(select).not.toContain(field);
    }
  });

  test("searchJobsByTag refuses a tag it would have to quote", async () => {
    const env = passwordEnv();
    for (const tag of ["", "a'b", "a b", 'x"y', "a)b", "x".repeat(200)]) {
      await expect(searchJobsByTag(ctx(env), tag)).rejects.toThrow(RangeError);
    }
    expect(standin.log).toHaveLength(0);
  });

  test("searchJobsByTag finds nothing for a tag no job has", async () => {
    const env = passwordEnv();
    await submitJob(ctx(env), SUBMIT);
    expect(await searchJobsByTag(ctx(env), "nemar_job:job_000000000000000000000000")).toEqual([]);
  });

  test("searchJobsByTag can ask for the caller's own jobs, a page at a time", async () => {
    const env = passwordEnv();
    await submitJob(ctx(env), SUBMIT);
    standin.log.length = 0;
    await searchJobsByTag(ctx(env), nemarJobTag(JOB_ID), {
      listType: "MY_JOBS",
      limit: 3,
      skip: 2,
    });
    const query = new URL(`http://x${jobCalls("POST /v3/jobs/search")[0]?.path}`).searchParams;
    expect(query.get("listType")).toBe("MY_JOBS");
    expect(query.get("limit")).toBe("3");
    expect(query.get("skip")).toBe("2");
  });

  test("listJobs sends the list type, the limit and the skip", async () => {
    const env = passwordEnv();
    for (const id of [
      "job_111111111111111111111111",
      "job_222222222222222222222222",
      "job_333333333333333333333333",
    ]) {
      await submitJob(ctx(env), { ...SUBMIT, jobId: id });
    }
    standin.log.length = 0;
    const page = await listJobs(ctx(env), { listType: "ALL_JOBS", limit: 2, skip: 1 });
    expect(page).toHaveLength(2);
    const query = new URL(`http://x${jobCalls("GET /v3/jobs/list")[0]?.path}`).searchParams;
    expect(Object.fromEntries(query)).toEqual({ listType: "ALL_JOBS", limit: "2", skip: "1" });
    for (const bad of [{ limit: 0 }, { limit: 1.5 }, { skip: -1 }, { listType: "EVERYTHING" }]) {
      await expect(
        listJobs(ctx(env), { listType: "ALL_JOBS", limit: 10, skip: 0, ...bad } as never),
      ).rejects.toThrow(RangeError);
    }
  });

  test("subscribeWebhook posts the documented subscription, with ttlminutes as Tapis spells it", async () => {
    const env = passwordEnv();
    const job = await submitJob(ctx(env), SUBMIT);
    standin.log.length = 0;
    const address = "https://hooks.example/compute/webhook/TOKEN-IN-THE-ADDRESS";
    const made = await subscribeWebhook(ctx(env), job.uuid, address, 4320);
    expect(made.url).toEqual(expect.any(String));
    const call = jobCalls("POST /v3/jobs/subscribe/:uuid")[0];
    expect(call?.path).toBe(`/v3/jobs/subscribe/${job.uuid}`);
    expect(JSON.parse(call?.body ?? "")).toEqual({
      description: "NEMAR status hint",
      enabled: true,
      eventCategoryFilter: "JOB_NEW_STATUS",
      deliveryTargets: [{ deliveryMethod: "WEBHOOK", deliveryAddress: address }],
      ttlminutes: 4320,
    });
    expect(standin.subscriptions).toHaveLength(1);
    expect(standin.subscriptions[0]).toMatchObject({
      jobUuid: job.uuid,
      address,
      ttlminutes: 4320,
    });
  });

  test("subscribeWebhook refuses a lifetime or an address Tapis would not take, before sending", async () => {
    const env = passwordEnv();
    const job = await submitJob(ctx(env), SUBMIT);
    standin.log.length = 0;
    for (const ttl of [0, -1, 1.5, 40321, Number.NaN]) {
      await expect(
        subscribeWebhook(ctx(env), job.uuid, "https://hooks.example/x", ttl),
      ).rejects.toThrow(RangeError);
    }
    for (const address of [
      "",
      "not a url",
      "ftp://hooks.example/x",
      `https://hooks.example/${"x".repeat(3000)}`,
    ]) {
      await expect(subscribeWebhook(ctx(env), job.uuid, address, 60)).rejects.toThrow(RangeError);
    }
    expect(standin.log).toHaveLength(0);
  });

  test("a webhook Tapis sends reaches the address that was recorded, shaped as a notification", async () => {
    const env = passwordEnv();
    const job = await submitJob(ctx(env), SUBMIT);
    const received: Array<{ headers: Record<string, string>; body: Record<string, any> }> = [];
    const receiver = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        received.push({
          headers: Object.fromEntries(req.headers),
          body: (await req.json()) as Record<string, any>,
        });
        return new Response("ok");
      },
    });
    try {
      await subscribeWebhook(ctx(env), job.uuid, `http://127.0.0.1:${receiver.port}/hook/abc`, 60);
      standin.advance(job.uuid, "RUNNING");
      const sent = await standin.fireWebhook(job.uuid);
      expect(sent).toEqual({ status: 200, body: "ok" });
      const [hit] = received;
      expect(hit?.headers["user-agent"]).toBe("Tapis/v3");
      expect(hit?.body.event).toMatchObject({
        source: "https://tapis.io/jobs",
        type: "jobs.JOB_NEW_STATUS.RUNNING",
        subject: job.uuid,
        seriesId: job.uuid,
      });
      expect(JSON.parse(hit?.body.event.data)).toMatchObject({
        newJobStatus: "RUNNING",
        jobUuid: job.uuid,
        jobOwner: OWNER,
      });
      expect(hit?.body.deliveryTarget).toEqual({
        deliveryMethod: "WEBHOOK",
        deliveryAddress: `http://127.0.0.1:${receiver.port}/hook/abc`,
      });
    } finally {
      receiver.stop(true);
    }
  });

  test("listOutputs and downloadOutput read the documented paths and the bytes", async () => {
    const env = passwordEnv();
    const job = await submitJob(ctx(env), SUBMIT);
    standin.setOutput(job.uuid, "work/outputs/a.csv", "a,b\n1,2\n");
    standin.setOutput(job.uuid, "launcher/result.json", '{"failure":null}');
    standin.advance(job.uuid, "FINISHED");
    standin.log.length = 0;
    const listed = await listOutputs(ctx(env), job.uuid, "work/");
    expect(listed.map((f) => f.path)).toEqual(["work/outputs/a.csv"]);
    expect(listed[0]).toMatchObject({ size: 8, type: "file", name: "a.csv" });
    const bytes = await downloadOutput(ctx(env), job.uuid, "work/outputs/a.csv", 1000);
    expect(new TextDecoder().decode(bytes)).toBe("a,b\n1,2\n");
    expect(standin.log.map((r) => r.path).filter((p) => p.includes("/output/"))).toEqual([
      `/v3/jobs/${job.uuid}/output/list/work/`,
      `/v3/jobs/${job.uuid}/output/download/work/outputs/a.csv`,
    ]);
    // The root listing has an empty path and still ends the URL with a slash.
    expect((await listOutputs(ctx(env), job.uuid, "")).map((f) => f.path).sort()).toEqual([
      "launcher/result.json",
      "work/outputs/a.csv",
    ]);
  });

  test("a download over the byte bound is `invalid_response`, and one at the bound is read", async () => {
    const env = passwordEnv();
    const job = await submitJob(ctx(env), SUBMIT);
    standin.setOutput(job.uuid, "work/outputs/big.bin", new Uint8Array(1000).fill(7));
    standin.advance(job.uuid, "FINISHED");
    const over = await failure(() =>
      downloadOutput(ctx(env), job.uuid, "work/outputs/big.bin", 999),
    );
    expect(over.kind).toBe("invalid_response");
    expect(await downloadOutput(ctx(env), job.uuid, "work/outputs/big.bin", 1000)).toHaveLength(
      1000,
    );
    const missing = await failure(() =>
      downloadOutput(ctx(env), job.uuid, "work/outputs/none.bin", 10),
    );
    expect(missing.kind).toBe("not_found");
  });

  test("downloadOutputPrefix keeps the first bytes of a file over the bound and says so; a file within it is whole (round 1 of #2041)", async () => {
    const env = passwordEnv();
    const job = await submitJob(ctx(env), SUBMIT);
    const body = new Uint8Array(1001).map((_, i) => i % 251);
    standin.setOutput(job.uuid, "tapisjob.out", body);
    standin.setOutput(job.uuid, "small.out", "short");
    standin.advance(job.uuid, "FINISHED");
    const cut = await downloadOutputPrefix(ctx(env), job.uuid, "tapisjob.out", 1000);
    expect(cut.truncated).toBe(true);
    expect(cut.bytes).toHaveLength(1000);
    expect(cut.bytes).toEqual(body.subarray(0, 1000));
    // At the bound exactly: whole, not truncated. One under: truncated by one byte.
    const exact = await downloadOutputPrefix(ctx(env), job.uuid, "tapisjob.out", 1001);
    expect([exact.truncated, exact.bytes.length]).toEqual([false, 1001]);
    const under = await downloadOutputPrefix(ctx(env), job.uuid, "tapisjob.out", 1);
    expect([under.truncated, under.bytes.length]).toEqual([true, 1]);
    const whole = await downloadOutputPrefix(ctx(env), job.uuid, "small.out", 1000);
    expect([whole.truncated, new TextDecoder().decode(whole.bytes)]).toEqual([false, "short"]);
    // No `Range` header is sent: the stream is read to the bound and cancelled.
    for (const r of standin.log.filter((q) => q.route === "GET /v3/jobs/:uuid/output/download/*")) {
      expect(r.headers.range).toBeUndefined();
    }
    // The existing call is unchanged: over the bound is still `invalid_response`.
    expect(
      (await failure(() => downloadOutput(ctx(env), job.uuid, "tapisjob.out", 1000))).kind,
    ).toBe("invalid_response");
    // The same refusals as the plain download: a missing file, a launch file, a bound past the maximum.
    expect(
      (await failure(() => downloadOutputPrefix(ctx(env), job.uuid, "none.out", 10))).kind,
    ).toBe("not_found");
    await expect(downloadOutputPrefix(ctx(env), job.uuid, "tapisjob.env", 10)).rejects.toThrow(
      RangeError,
    );
    await expect(
      downloadOutputPrefix(ctx(env), job.uuid, "tapisjob.out", TAPIS_MAX_DOWNLOAD_BYTES + 1),
    ).rejects.toThrow(RangeError);
  });

  test("a path that could escape the job's output directory is refused before sending", async () => {
    const env = passwordEnv();
    const job = await submitJob(ctx(env), SUBMIT);
    standin.log.length = 0;
    for (const path of ["../x", "a/../b", "/abs", "a\\b", "a//b", "a\u0000b", "./x"]) {
      await expect(downloadOutput(ctx(env), job.uuid, path, 10)).rejects.toThrow(RangeError);
      await expect(listOutputs(ctx(env), job.uuid, path)).rejects.toThrow(RangeError);
    }
    for (const uuid of ["", "../x", "a/b", "a b", "a?x=1", "x".repeat(200)]) {
      await expect(getJob(ctx(env), uuid)).rejects.toThrow(RangeError);
    }
    expect(standin.log).toHaveLength(0);
  });

  test("a job uuid is encoded once, so what the path says is what was asked", async () => {
    const env = passwordEnv();
    const job = await submitJob(ctx(env), SUBMIT);
    standin.setOutput(job.uuid, "work/outputs/a b+c.txt", "x");
    standin.advance(job.uuid, "FINISHED");
    expect(
      new TextDecoder().decode(
        await downloadOutput(ctx(env), job.uuid, "work/outputs/a b+c.txt", 10),
      ),
    ).toBe("x");
  });

  test("tapisHealth calls the unauthenticated health check, and answers ok", async () => {
    await tapisHealth(passwordEnv(), { timeoutMs: 400 });
    expect(standin.log.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /v3/jobs/healthcheck"]);
    expect(standin.log[0]?.headers["x-tapis-token"]).toBeUndefined();
    standin.fail("GET /v3/jobs/healthcheck", 503, 9);
    expect(
      (await failure(() => tapisHealth(passwordEnv(), { timeoutMs: 400, retryDelayMs: 1 }))).kind,
    ).toBe("unavailable");
  });

  test("mintTapisToken always asks Tapis, and never fills the cache", async () => {
    const env = passwordEnv();
    const a = await mintTapisToken(env, { owner: OWNER, timeoutMs: 400 });
    const b = await mintTapisToken(env, { owner: OWNER, timeoutMs: 400 });
    expect(a.token).not.toBe(b.token);
    expect(a.expiresInSeconds).toBe(14_400);
    expect(standin.mints().password).toBe(2);
    await getTapisToken(env, { owner: OWNER, timeoutMs: 400 });
    expect(standin.mints().password).toBe(3);
  });
});

// ---------------------------------------------------------------------------------------------
// The bounds, and what never appears
// ---------------------------------------------------------------------------------------------

describe("bounds", () => {
  test("every call has a 15-second timeout and no call can lengthen it", () => {
    expect(TAPIS_TIMEOUT_MS).toBe(15_000);
    expect(effectiveTimeoutMs(undefined)).toBe(15_000);
    expect(effectiveTimeoutMs(200)).toBe(200);
    expect(effectiveTimeoutMs(60_000)).toBe(15_000);
    expect(effectiveTimeoutMs(0)).toBe(15_000);
    expect(effectiveTimeoutMs(-5)).toBe(15_000);
    expect(effectiveTimeoutMs(Number.NaN)).toBe(15_000);
  });

  test("a mint that hangs is `unavailable` inside the timeout too", async () => {
    standin.hang("POST /v3/oauth2/tokens", 10);
    const started = Date.now();
    const err = await failure(() => getTapisToken(passwordEnv(), { owner: OWNER, timeoutMs: 150 }));
    expect(err.kind).toBe("unavailable");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("the server being down is `unavailable`, and when it is back the client works", async () => {
    const env = passwordEnv();
    standin.down();
    try {
      expect((await failure(() => getJob(ctx(env), "abc-007"))).kind).toBe("unavailable");
    } finally {
      standin.up();
    }
    const job = await submitJob(ctx(env), SUBMIT);
    expect((await getJob(ctx(env), job.uuid)).uuid).toBe(job.uuid);
  });

  test("a redirect is not followed, so the token never reaches another origin", async () => {
    const env = passwordEnv();
    const job = await submitJob(ctx(env), SUBMIT);
    const reached: Array<Record<string, string>> = [];
    const elsewhere = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => {
        reached.push(Object.fromEntries(req.headers));
        return new Response("{}");
      },
    });
    try {
      standin.respond("GET /v3/jobs/:uuid", 302, "", 1, {
        Location: `http://127.0.0.1:${elsewhere.port}/x`,
      });
      const err = await failure(() => getJob(ctx(env), job.uuid));
      // A redirect is a proxy's answer, not Tapis's decision: retryable later, never followed.
      expect(err.kind).toBe("unavailable");
      expect(err.status).toBe(302);
      expect(reached).toEqual([]);
    } finally {
      elsewhere.stop(true);
    }
  });

  test("the error kinds are the six the design names", () => {
    expect([...TAPIS_ERROR_KINDS]).toEqual([
      "unconfigured",
      "unauthorized",
      "not_found",
      "rejected",
      "unavailable",
      "invalid_response",
    ]);
  });
});

describe("secrets", () => {
  const SECRETS = () => [
    standin.password,
    standin.serviceToken,
    ...SPEC_SECRETS,
    "TOKEN-IN-THE-ADDRESS",
  ];

  test("no password, token or launch specification is in an error message, a cause or a log line", async () => {
    for (const [, makeEnv] of STRATEGIES) {
      __resetTapisTokenCacheForTests();
      standin.reset();
      const env = makeEnv();
      const logs = captureConsole();
      const errors: TapisError[] = [];
      try {
        const job = await submitJob(ctx(env), SUBMIT);
        // Every kind of failure, on calls that carry a secret in the request or in the address.
        standin.fail("POST /v3/jobs/submit", 400);
        standin.fail("POST /v3/jobs/submit", 503);
        standin.respond("POST /v3/jobs/submit", 200, {
          status: "success",
          result: { launch: LAUNCH_SPEC },
        });
        standin.nonJson("POST /v3/jobs/submit");
        for (let i = 0; i < 4; i++) errors.push(await failure(() => submitJob(ctx(env), SUBMIT)));
        standin.fail("POST /v3/jobs/subscribe/:uuid", 400);
        errors.push(
          await failure(() =>
            subscribeWebhook(ctx(env), job.uuid, "https://hooks.example/TOKEN-IN-THE-ADDRESS", 60),
          ),
        );
        standin.rejectAllTokens(true);
        errors.push(await failure(() => getJob(ctx(env), job.uuid)));
        errors.push(await failure(() => submitJob(ctx(env), SUBMIT)));
        standin.rejectAllTokens(false);
        // A cached token is keyed by strategy and username, not by credential: a wrong credential is
        // only tried when nothing is cached, as after a deploy.
        __resetTapisTokenCacheForTests();
        errors.push(
          await failure(() =>
            getJob(
              ctx(makeEnv({ TAPIS_PASSWORD: "wrong", TAPIS_SERVICE_TOKEN: "wrong" })),
              job.uuid,
            ),
          ),
        );
      } finally {
        logs.restore();
      }
      expect(errors.length).toBeGreaterThanOrEqual(8);
      for (const err of errors) {
        const text = `${err.message} ${err.name} ${String(err.cause)} ${JSON.stringify(err)}`;
        for (const secret of SECRETS()) expect(text).not.toContain(secret);
        expect(err.message).not.toContain("hooks.example");
      }
      for (const line of logs.lines) {
        for (const secret of SECRETS()) expect(line).not.toContain(secret);
      }
    }
  });

  test("the minted token is not in the answer of any call either", async () => {
    const env = passwordEnv();
    const job = await submitJob(ctx(env), SUBMIT);
    const token = jobCalls("POST /v3/jobs/submit")[0]?.headers["x-tapis-token"] ?? "";
    expect(token).not.toBe("");
    const answers = [
      job,
      await getJob(ctx(env), job.uuid),
      await getJobHistory(ctx(env), job.uuid),
      await listJobs(ctx(env), { listType: "ALL_JOBS", limit: 5, skip: 0 }),
      await searchJobsByTag(ctx(env), nemarJobTag(JOB_ID)),
    ];
    expect(JSON.stringify(answers)).not.toContain(token);
  });
});

// A partition is the contract's word, and it is the logical queue of the request.
test("every partition word of the contract is accepted and sent as the logical queue", async () => {
  const env = passwordEnv();
  for (const partition of PARTITION_NAMES) {
    await submitJob(ctx(env), { ...SUBMIT, partition });
  }
  const queues = jobCalls("POST /v3/jobs/submit").map(
    (r) => JSON.parse(r.body).execSystemLogicalQueue,
  );
  expect(queues).toEqual([...PARTITION_NAMES]);
});

afterEach(() => {
  standin.rejectAllTokens(false);
});

// ---------------------------------------------------------------------------------------------
// Round 1 review of phase A4: the launch specification's copies, response validation, caps
// ---------------------------------------------------------------------------------------------

const totalMints = () => standin.mints().password + standin.mints().service;

/** What `AbortSignal.timeout` was asked for while a test ran; the real one still does the timing. */
function recordAbortTimeouts(): { values: number[]; restore: () => void } {
  const original = AbortSignal.timeout;
  const values: number[] = [];
  AbortSignal.timeout = ((ms: number) => {
    values.push(ms);
    return original.call(AbortSignal, ms);
  }) as typeof AbortSignal.timeout;
  return {
    values,
    restore: () => {
      AbortSignal.timeout = original;
    },
  };
}

/** The waits `withRetry` asked for, which are cut to 1 ms so the test does not sit through them. */
function recordRetryDelays(): { values: number[]; restore: () => void } {
  const original = globalThis.setTimeout;
  const values: number[] = [];
  globalThis.setTimeout = ((fn: () => void, ms?: number, ...args: unknown[]) => {
    values.push(ms ?? 0);
    return (original as (...a: unknown[]) => unknown)(fn, 1, ...args);
  }) as unknown as typeof setTimeout;
  return {
    values,
    restore: () => {
      globalThis.setTimeout = original;
    },
  };
}

/** A stream of `bytes` bytes in chunks of 400, with no Content-Length: a new one for each request. */
const chunked = (bytes: number) => () =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (let at = 0; at < bytes; at += 400) {
        controller.enqueue(new Uint8Array(Math.min(400, bytes - at)).fill(7));
      }
      controller.close();
    },
  });

describe("the launch specification's other copies (what Tapis archives, and what the client reads)", () => {
  test("the env key is the contract's, not a second copy of the word", async () => {
    const { LAUNCH_SPEC_ENV_KEY } = await import("../src/services/tapis/schemas");
    expect(LAUNCH_SPEC_ENV_KEY).toBe(LAUNCHER_ENV.SPEC);
    await submitJob(ctx(passwordEnv()), SUBMIT);
    const sent = JSON.parse(jobCalls("POST /v3/jobs/submit")[0]?.body ?? "");
    expect(sent.parameterSet.envVariables.map((e: { key: string }) => e.key)).toEqual([
      LAUNCHER_ENV.SPEC,
    ]);
  });

  test("every submit tells Tapis not to archive the launch files (the body that was sent)", async () => {
    // What is asserted is the request on the wire. Whether Tapis takes the flag from a request is
    // UNVERIFIED, and the stand-in's own record of it would only echo what it was sent.
    for (const make of [passwordEnv, serviceEnv]) {
      standin.reset();
      __resetTapisTokenCacheForTests();
      await submitJob(ctx(make()), SUBMIT);
      const sent = JSON.parse(jobCalls("POST /v3/jobs/submit")[0]?.body ?? "");
      expect(sent.parameterSet.archiveFilter).toEqual({ includeLaunchFiles: false });
    }
  });

  test("the request schema allows EXACTLY that archive key, with that value", async () => {
    const { buildSubmitRequest } = clientModule;
    const built = buildSubmitRequest(OWNER, SUBMIT);
    expect(SubmitJobRequestSchema.safeParse(built).success).toBe(true);
    const withFilter = (archiveFilter: unknown) => ({
      ...built,
      parameterSet: { ...built.parameterSet, archiveFilter },
    });
    expect(SubmitJobRequestSchema.safeParse(withFilter({ includeLaunchFiles: true })).success).toBe(
      false,
    );
    expect(SubmitJobRequestSchema.safeParse(withFilter({})).success).toBe(false);
    expect(
      SubmitJobRequestSchema.safeParse(withFilter({ includeLaunchFiles: false, includes: ["x"] }))
        .success,
    ).toBe(false);
    expect(
      SubmitJobRequestSchema.safeParse(withFilter({ includeLaunchFiles: false, excludes: [] }))
        .success,
    ).toBe(false);
    const { archiveFilter: _dropped, ...withoutFilter } = built.parameterSet;
    expect(
      SubmitJobRequestSchema.safeParse({ ...built, parameterSet: withoutFilter }).success,
    ).toBe(false);
  });

  /**
   * Each is a value the client must not send: one the scheduler's launch file could not carry, or one
   * made only of the alphabet that is still not what `encodeLaunchSpecEnv` writes (the schema's rule is
   * the strict decoder's, not a check of the characters alone).
   */
  const REFUSED_VALUES: Array<[string, string]> = [
    ["the raw JSON text, the value before A1c", LAUNCH_SPEC_TEXT],
    ["raw JSON with no space in it, which a conditional quoter leaves bare", '{"a":"b"}'],
    ["a base64 value with its padding", `${LAUNCH_SPEC}==`],
    ["the two standard base64 characters", "ab+/cd"],
    ["a space", "ab cd"],
    ["a trailing newline", `${LAUNCH_SPEC}\n`],
    ["a newline inside", "ab\ncd"],
    ["a double quote", 'ab"cd'],
    ["a single quote", "ab'cd"],
    ["a dollar sign", "ab$cd"],
    ["a semicolon", "ab;cd"],
    ["an ampersand", "ab&cd"],
    ["a pipe", "ab|cd"],
    ["angle brackets", "ab<cd>ef"],
    ["a backtick", "ab`cd"],
    ["a backslash", "ab\\cd"],
    ["a parenthesis", "ab(cd)"],
    ["non-ASCII", "caf\u00e9"],
    ["the empty value", ""],
    ["one over the encoded bound", "x".repeat(LAUNCH_SPEC_ENV_MAX_CHARS + 1)],
    ["the alphabet only, but not canonical (spare bits set)", "QR"],
    ["the alphabet only, but a length of 1 modulo 4", "QUJDR"],
    ["the alphabet only, but it decodes to a control byte", "AA"],
    ["the alphabet only, but it decodes to DEL", "fw"],
    ["the alphabet only, but it decodes to bytes from 0x80 up", "w6k"],
    ["the alphabet only, and long, but not text", "x".repeat(100)],
  ];

  /**
   * A real encoded value that uses all 64 characters of the alphabet: 64 groups of two spaces and a
   * printable byte whose low six bits run through 0 to 63, which is the group's last character.
   */
  const EVERY_CHARACTER_VALUE = encodeLaunchSpecEnv(
    Array.from({ length: 64 }, (_, v) => `  ${String.fromCharCode(v < 32 ? 0x40 + v : v)}`).join(
      "",
    ),
  );
  test("a value that is not shell-inert base64url is refused before anything is sent (A1c)", async () => {
    const env = passwordEnv();
    for (const [label, value] of REFUSED_VALUES) {
      await expect(
        submitJob(ctx(env), { ...SUBMIT, launchSpecEnv: notAValue(value) }),
        label,
      ).rejects.toThrow(RangeError);
    }
    expect(standin.log).toHaveLength(0);
  });

  test("the refusal names the field and never the value, which holds the token", async () => {
    const env = passwordEnv();
    for (const bad of [LAUNCH_SPEC_TEXT, `${LAUNCH_SPEC}==`]) {
      let message = "";
      try {
        await submitJob(ctx(env), { ...SUBMIT, launchSpecEnv: notAValue(bad) });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain("parameterSet.envVariables");
      for (const secret of [...SPEC_SECRETS, "nemar.launch-spec"]) {
        expect(message).not.toContain(secret);
      }
    }
  });

  test("a refusal because of the job's own data is the typed SubmitRequestRefused, with a reason word; the owner's is not", async () => {
    const env = passwordEnv();
    const rows: Array<[string, Partial<SubmitJobInput>, "launch_spec_env" | "job_field"]> = [
      [
        "the launch value is raw JSON",
        { launchSpecEnv: notAValue(LAUNCH_SPEC_TEXT) },
        "launch_spec_env",
      ],
      ["the launch value is not canonical", { launchSpecEnv: notAValue("QR") }, "launch_spec_env"],
      ["the launch value is empty", { launchSpecEnv: notAValue("") }, "launch_spec_env"],
      ["a count is not a positive number", { coresPerNode: 0 }, "job_field"],
      ["the job id is not one", { jobId: "job_nothex" }, "job_field"],
      ["the partition is not one", { partition: "not-a-partition" as never }, "job_field"],
      ["the GPUs are negative", { gpus: -1 }, "job_field"],
    ];
    for (const [label, over, reason] of rows) {
      let error: unknown;
      try {
        await submitJob(ctx(env), { ...SUBMIT, ...over });
      } catch (caught) {
        error = caught;
      }
      expect(error, label).toBeInstanceOf(SubmitRequestRefused);
      // Still a RangeError, as a refused request always was.
      expect(error, label).toBeInstanceOf(RangeError);
      expect((error as SubmitRequestRefused).reason, label).toBe(reason);
      expect((error as Error).name, label).toBe("SubmitRequestRefused");
      // It names the fields and no value: the launch value holds the job's token.
      for (const secret of [...SPEC_SECRETS, "nemar.launch-spec"]) {
        expect((error as Error).message, label).not.toContain(secret);
      }
    }
    // The owner is NEMAR's configuration, not the job's data: it is a plain RangeError, so a caller that
    // ends a job on the typed error leaves a job waiting for a configuration fix.
    for (const run of [
      () => clientModule.buildSubmitRequest("a b", SUBMIT),
      () => clientModule.buildSubmitRequest("", SUBMIT),
    ]) {
      expect(run).toThrow(RangeError);
      expect(run).not.toThrow(SubmitRequestRefused);
    }
    await expect(submitJob(ctx(env, { owner: "a b" }), SUBMIT)).rejects.toThrow(RangeError);
    await expect(submitJob(ctx(env, { owner: "a b" }), SUBMIT)).rejects.not.toBeInstanceOf(
      SubmitRequestRefused,
    );
    // Nothing was sent for any of them.
    expect(standin.log).toHaveLength(0);
  });

  test("a value of exactly the encoded bound is sent, and is the one the stand-in holds", async () => {
    const env = passwordEnv();
    // The encoding of the largest text there is: 64 KiB of printable ASCII.
    const longest = encodeLaunchSpecEnv("a".repeat(LAUNCH_SPEC_MAX_BYTES));
    const job = await submitJob(ctx(env), { ...SUBMIT, launchSpecEnv: longest });
    const sent = JSON.parse(jobCalls("POST /v3/jobs/submit")[0]?.body ?? "");
    expect(sent.parameterSet.envVariables).toEqual([{ key: LAUNCHER_ENV.SPEC, value: longest }]);
    expect(longest.length).toBe(87_382);
    expect(job.uuid).toEqual(expect.any(String));
  });

  test("the request schema allows one variable, whose value is shell-inert and within the encoded bound", async () => {
    const { buildSubmitRequest } = clientModule;
    const built = buildSubmitRequest(OWNER, SUBMIT);
    expect(SubmitJobRequestSchema.safeParse(built).success).toBe(true);
    const withValue = (value: unknown) => ({
      ...built,
      parameterSet: {
        ...built.parameterSet,
        envVariables: [{ key: LAUNCHER_ENV.SPEC, value }],
      },
    });
    expect(SubmitJobRequestSchema.safeParse(withValue(LAUNCH_SPEC)).success).toBe(true);
    // The whole alphabet is accepted, in a value that really is one: all 64 characters, `-` and `_` too.
    expect(new Set(EVERY_CHARACTER_VALUE)).toEqual(new Set(SHELL_INERT_ENV_ALPHABET));
    expect(SubmitJobRequestSchema.safeParse(withValue(EVERY_CHARACTER_VALUE)).success).toBe(true);
    for (const [label, value] of REFUSED_VALUES) {
      expect(SubmitJobRequestSchema.safeParse(withValue(value)).success, label).toBe(false);
    }
    for (const notText of [undefined, null, 7, ["a"], {}]) {
      expect(SubmitJobRequestSchema.safeParse(withValue(notText)).success, String(notText)).toBe(
        false,
      );
    }
  });

  test("the files that hold the launch specification are never downloaded or listed", async () => {
    const env = passwordEnv();
    const job = await submitJob(ctx(env), SUBMIT);
    // The file as the scheduler writes it: the value bare, which is what a shell-inert value allows.
    standin.setOutput(job.uuid, "tapisjob.env", launchFileLine(LAUNCH_SPEC));
    standin.setOutput(job.uuid, "tapisjob.out", "log line");
    standin.setOutput(job.uuid, "work/outputs/mytapisjob.env.csv", "a");
    standin.advance(job.uuid, "FINISHED");
    standin.log.length = 0;
    for (const path of [
      "tapisjob.env",
      "tapisjob.sh",
      "work/tapisjob.env",
      "work/tapisjob.sh",
      "TAPISJOB.ENV",
      "Tapisjob.Sh",
    ]) {
      await expect(downloadOutput(ctx(env), job.uuid, path, 1000)).rejects.toThrow(RangeError);
      await expect(listOutputs(ctx(env), job.uuid, path)).rejects.toThrow(RangeError);
      await expect(listOutputs(ctx(env), job.uuid, `${path}/`)).rejects.toThrow(RangeError);
    }
    expect(standin.log).toHaveLength(0);
    // The names that are only like them are ordinary files.
    expect(
      new TextDecoder().decode(await downloadOutput(ctx(env), job.uuid, "tapisjob.out", 1000)),
    ).toBe("log line");
    expect(
      (await downloadOutput(ctx(env), job.uuid, "work/outputs/mytapisjob.env.csv", 1000)).length,
    ).toBe(1);
  });
});

describe.each(STRATEGIES)(
  "the client never returns a launch specification (%s strategy)",
  (_name, makeEnv) => {
    const ADDRESS_MARK = "TOKEN-IN-THE-ADDRESS-9921";

    test("a tenant that ignores the field list cannot make search or list return parameterSet or subscriptions", async () => {
      const env = makeEnv();
      const job = await submitJob(ctx(env), SUBMIT);
      const record = standin.jobs.get(job.uuid)?.record as Record<string, unknown>;
      record.subscriptions = [
        {
          deliveryTargets: [
            { deliveryMethod: "WEBHOOK", deliveryAddress: `https://hooks.example/${ADDRESS_MARK}` },
          ],
        },
      ];
      standin.fullRecords(true);
      const found = await searchJobsByTag(ctx(env), nemarJobTag(JOB_ID));
      const listed = await listJobs(ctx(env), { listType: "ALL_JOBS", limit: 10, skip: 0 });
      // The fixture really did serve the whole record (the `parameterSet` with the token, and the
      // `subscriptions` with the address), for both calls: it notes a job only when the answer holds both.
      expect(standin.fullRecordsServed).toEqual([job.uuid, job.uuid]);
      for (const answer of [found, listed]) {
        expect(answer.map((j) => j.uuid)).toEqual([job.uuid]);
        for (const j of answer) {
          expect(j).not.toHaveProperty("parameterSet");
          expect(j).not.toHaveProperty("subscriptions");
        }
        for (const secret of SPEC_SECRETS) expect(JSON.stringify(answer)).not.toContain(secret);
        expect(JSON.stringify(answer)).not.toContain(ADDRESS_MARK);
      }
    });

    test("a get and a submit answered with a whole record are cleaned too", async () => {
      const env = makeEnv();
      const job = await submitJob(ctx(env), SUBMIT);
      const record = standin.jobs.get(job.uuid)?.record as Record<string, unknown>;
      record.subscriptions = [
        { deliveryTargets: [{ deliveryAddress: `https://h.example/${ADDRESS_MARK}` }] },
      ];
      const read = await getJob(ctx(env), job.uuid);
      expect(read).not.toHaveProperty("subscriptions");
      expect(JSON.stringify(read)).not.toContain(ADDRESS_MARK);
      const again = await submitJob(ctx(env), { ...SUBMIT, jobId: "job_bbbbbbbbbbbbbbbbbbbbbbbb" });
      for (const secret of SPEC_SECRETS) expect(JSON.stringify(again)).not.toContain(secret);
    });
  },
);

/** Valid JSON of the wrong shape for a token answer, each one a different way to be wrong. */
const BAD_TOKEN_BODIES: Array<[string, unknown]> = [
  ["no result", { status: "success", message: "x", version: "1" }],
  ["no access_token", { status: "success", result: {} }],
  [
    "an empty token",
    { status: "success", result: { access_token: { access_token: "", expires_in: 3600 } } },
  ],
  [
    "expires_in 0",
    { status: "success", result: { access_token: { access_token: "tok-x", expires_in: 0 } } },
  ],
  ["no expires_in", { status: "success", result: { access_token: { access_token: "tok-x" } } }],
  [
    "a fractional expires_in",
    { status: "success", result: { access_token: { access_token: "tok-x", expires_in: 1.5 } } },
  ],
  [
    "a token that is a number",
    { status: "success", result: { access_token: { access_token: 7, expires_in: 60 } } },
  ],
  ["an array", []],
  ["null", null],
];

describe.each(STRATEGIES)("a token answer of the wrong shape (%s strategy)", (_name, makeEnv) => {
  test.each(BAD_TOKEN_BODIES)(
    "%s is `invalid_response`, sends no empty token, and caches nothing",
    async (_what, body) => {
      const env = makeEnv();
      standin.respond(mintRouteOf(env), 201, body);
      const err = await failure(() => getTapisToken(env, { owner: OWNER, timeoutMs: 400 }));
      expect(err.kind).toBe("invalid_response");
      // The status the answer came with is carried (the stand-in answers a mint 201).
      expect(err.status).toBe(201);
      expect(err.message).not.toContain("tok-x");
      // Nothing was cached: the next call asks again, and gets a real token.
      const token = await getTapisToken(env, { owner: OWNER, timeoutMs: 400 });
      expect(token).toMatch(/^standin-token-/);
      expect(standin.log.filter((r) => r.route === mintRouteOf(env))).toHaveLength(2);
      expect(totalMints()).toBe(1);
      // No request ever carried an empty X-Tapis-Token.
      expect(standin.log.filter((r) => r.headers["x-tapis-token"] === "")).toEqual([]);
    },
  );

  test("a mint answered with something that is not JSON is `invalid_response`, with the status it came with", async () => {
    const env = makeEnv();
    standin.nonJson(mintRouteOf(env));
    const err = await failure(() => getTapisToken(env, { owner: OWNER, timeoutMs: 400 }));
    expect(err.kind).toBe("invalid_response");
    // The stand-in's non-JSON page is a 200.
    expect(err.status).toBe(200);
    expect(totalMints()).toBe(0);
    expect(standin.log.filter((r) => r.headers["x-tapis-token"] === "")).toEqual([]);
  });

  test("a call whose token cannot be minted never reaches Tapis's job routes", async () => {
    const env = makeEnv();
    standin.respond(mintRouteOf(env), 201, BAD_TOKEN_BODIES[2]?.[1]);
    const err = await failure(() => getJob(ctx(env), "abc-007"));
    expect(err.kind).toBe("invalid_response");
    expect(jobCalls("GET /v3/jobs/:uuid")).toHaveLength(0);
    expect(standin.log.filter((r) => r.headers["x-tapis-token"] === "")).toEqual([]);
    // A mint that failed this way is not retried as a read: the answer was not a transient fault.
    expect(standin.log.filter((r) => r.route === mintRouteOf(env))).toHaveLength(1);
  });
});

describe("a health answer of the wrong shape", () => {
  test.each([
    ["an empty object", {}],
    ["an array", []],
    ["null", null],
    ["a status that is a number", { status: 7 }],
    ["a string", "ok"],
  ])("%s is `invalid_response` and is not retried", async (_what, body) => {
    standin.respond("GET /v3/jobs/healthcheck", 200, body);
    const err = await failure(() =>
      tapisHealth(passwordEnv(), { timeoutMs: 400, retryDelayMs: 1 }),
    );
    expect(err.kind).toBe("invalid_response");
    expect(err.status).toBe(200);
    expect(jobCalls("GET /v3/jobs/healthcheck")).toHaveLength(1);
  });

  test("a body that is not JSON at all is `invalid_response` as well", async () => {
    standin.nonJson("GET /v3/jobs/healthcheck");
    const err = await failure(() => tapisHealth(passwordEnv(), { timeoutMs: 400 }));
    expect([err.kind, err.status]).toEqual(["invalid_response", 200]);
  });
});

describe("a call that changes something and fails without a clear answer", () => {
  test("`unavailable` and `invalid_response` of a submit mean the OUTCOME IS UNKNOWN, and the error says so", async () => {
    const env = passwordEnv();
    standin.fail("POST /v3/jobs/submit", 503);
    const down = await failure(() => submitJob(ctx(env), SUBMIT));
    expect([down.kind, down.status, down.outcomeUnknown]).toEqual(["unavailable", 503, true]);
    expect(down.message).toContain("outcome is unknown");

    standin.hang("POST /v3/jobs/submit");
    const hung = await failure(() => submitJob(ctx(env, { timeoutMs: 150 }), SUBMIT));
    expect([hung.kind, hung.outcomeUnknown]).toEqual(["unavailable", true]);

    // A 2xx that fails its schema: the job may exist. The status is carried, not lost.
    standin.respond("POST /v3/jobs/submit", 200, { status: "success", result: { foo: 1 } });
    const shapeless = await failure(() => submitJob(ctx(env), SUBMIT));
    expect([shapeless.kind, shapeless.status, shapeless.outcomeUnknown]).toEqual([
      "invalid_response",
      200,
      true,
    ]);
    expect(shapeless.message).toContain("HTTP 200");
    expect(shapeless.message).toContain("outcome is unknown");

    standin.nonJson("POST /v3/jobs/submit");
    const html = await failure(() => submitJob(ctx(env), SUBMIT));
    expect([html.kind, html.status, html.outcomeUnknown]).toEqual(["invalid_response", 200, true]);
  });

  test("an answer that says no, or a mint that failed before anything was sent, is NOT unknown", async () => {
    const env = passwordEnv();
    standin.fail("POST /v3/jobs/submit", 400);
    const bad = await failure(() => submitJob(ctx(env), SUBMIT));
    expect([bad.kind, bad.outcomeUnknown]).toEqual(["rejected", false]);
    expect(bad.message).not.toContain("outcome is unknown");

    standin.rejectAllTokens(true);
    const refused = await failure(() => submitJob(ctx(env), SUBMIT));
    expect([refused.kind, refused.outcomeUnknown]).toEqual(["unauthorized", false]);
    standin.rejectAllTokens(false);

    // The token could not be had, so no submit was sent: the job cannot exist.
    __resetTapisTokenCacheForTests();
    standin.fail("POST /v3/oauth2/tokens", 503);
    const before = jobCalls("POST /v3/jobs/submit").length;
    const noMint = await failure(() => submitJob(ctx(env), SUBMIT));
    expect([noMint.kind, noMint.outcomeUnknown]).toEqual(["unavailable", false]);
    expect(jobCalls("POST /v3/jobs/submit")).toHaveLength(before);
  });

  test("a read never says so, and cancel and subscribe do", async () => {
    const env = passwordEnv();
    const job = await submitJob(ctx(env), SUBMIT);
    standin.fail("GET /v3/jobs/:uuid", 503, 9);
    const read = await failure(() => getJob(ctx(env), job.uuid));
    expect([read.kind, read.outcomeUnknown]).toEqual(["unavailable", false]);
    standin.fail("POST /v3/jobs/:uuid/cancel", 503);
    const cancel = await failure(() => cancelJob(ctx(env), job.uuid));
    expect([cancel.kind, cancel.outcomeUnknown]).toEqual(["unavailable", true]);
    standin.fail("POST /v3/jobs/subscribe/:uuid", 503);
    const subscribe = await failure(() =>
      subscribeWebhook(ctx(env), job.uuid, "https://hooks.example/x", 60),
    );
    expect([subscribe.kind, subscribe.outcomeUnknown]).toEqual(["unavailable", true]);
    standin.respond("POST /v3/jobs/subscribe/:uuid", 200, { status: "success", result: {} });
    const shapeless = await failure(() =>
      subscribeWebhook(ctx(env), job.uuid, "https://hooks.example/x", 60),
    );
    expect([shapeless.kind, shapeless.outcomeUnknown]).toEqual(["invalid_response", true]);
  });
});

describe("what a caller's knobs can and cannot do", () => {
  test("a download is capped at 16 MiB: more is refused before anything is sent, exactly 16 MiB is not", async () => {
    const env = passwordEnv();
    const job = await submitJob(ctx(env), SUBMIT);
    standin.setOutput(job.uuid, "work/outputs/a.bin", "x");
    standin.advance(job.uuid, "FINISHED");
    const cap = (clientModule as unknown as { TAPIS_MAX_DOWNLOAD_BYTES: number })
      .TAPIS_MAX_DOWNLOAD_BYTES;
    expect(cap).toBe(16 * 1024 * 1024);
    standin.log.length = 0;
    for (const bytes of [cap + 1, 2 ** 40, Number.MAX_SAFE_INTEGER]) {
      await expect(downloadOutput(ctx(env), job.uuid, "work/outputs/a.bin", bytes)).rejects.toThrow(
        RangeError,
      );
    }
    expect(standin.log).toHaveLength(0);
    expect(await downloadOutput(ctx(env), job.uuid, "work/outputs/a.bin", cap)).toHaveLength(1);
  });

  test.each([
    [undefined, 3],
    [Number.NaN, 3],
    [Number.POSITIVE_INFINITY, 3],
    [0, 1],
    [-4, 1],
    [1, 1],
    [1.9, 1],
    [2, 2],
    [3, 3],
    [99, 3],
  ])("maxAttempts %p tries a read %p times", async (requested, tries) => {
    const env = passwordEnv();
    const job = await submitJob(ctx(env), SUBMIT);
    standin.fail("GET /v3/jobs/:uuid", 503, 20);
    standin.log.length = 0;
    const err = await failure(() => getJob(ctx(env, { maxAttempts: requested }), job.uuid));
    expect(err.kind).toBe("unavailable");
    expect(jobCalls("GET /v3/jobs/:uuid")).toHaveLength(tries);
  });

  test("the health call guards its attempts the same way", async () => {
    standin.fail("GET /v3/jobs/healthcheck", 503, 20);
    await failure(() =>
      tapisHealth(passwordEnv(), { timeoutMs: 400, retryDelayMs: 1, maxAttempts: Number.NaN }),
    );
    expect(jobCalls("GET /v3/jobs/healthcheck")).toHaveLength(3);
    standin.log.length = 0;
    await failure(() =>
      tapisHealth(passwordEnv(), { timeoutMs: 400, retryDelayMs: 1, maxAttempts: -2 }),
    );
    expect(jobCalls("GET /v3/jobs/healthcheck")).toHaveLength(1);
  });

  test.each([
    [undefined, 500],
    [Number.NaN, 500],
    [Number.POSITIVE_INFINITY, 500],
    [-50, 0],
    [0, 0],
    [25, 25],
    [1e9, 5000],
  ])(
    "retryDelayMs %p waits %p ms between attempts, and never more than 5 seconds",
    async (requested, waited) => {
      const env = passwordEnv();
      const job = await submitJob(ctx(env), SUBMIT);
      standin.fail("GET /v3/jobs/:uuid", 503, 20);
      const timers = recordRetryDelays();
      try {
        await failure(() =>
          getJob(ctx(env, { retryDelayMs: requested, maxAttempts: 2 }), job.uuid),
        );
      } finally {
        timers.restore();
      }
      // One wait between two attempts.
      expect(timers.values).toEqual([waited]);
    },
  );

  test("the health call caps its wait as well", async () => {
    standin.fail("GET /v3/jobs/healthcheck", 503, 20);
    const timers = recordRetryDelays();
    try {
      await failure(() =>
        tapisHealth(passwordEnv(), { timeoutMs: 400, retryDelayMs: 1e9, maxAttempts: 2 }),
      );
    } finally {
      timers.restore();
    }
    expect(timers.values).toEqual([5000]);
  });
});

describe("a webhook address carries a token, so it is https", () => {
  test("with no test override, only https is accepted (http is refused before sending)", async () => {
    // A closed port: an address that passes the check fails at the connection, as a TapisError.
    const env = passwordEnv({ TAPIS_BASE_URL: "https://127.0.0.1:1" });
    await withoutOverride(async () => {
      for (const address of [
        "http://hooks.example/compute/TOKEN",
        "http://127.0.0.1:8080/x",
        "HTTP://hooks.example/x",
      ]) {
        await expect(subscribeWebhook(ctx(env), "abc-007", address, 60)).rejects.toThrow(
          RangeError,
        );
      }
      const err = await failure(() =>
        subscribeWebhook(ctx(env), "abc-007", "https://hooks.example/compute/TOKEN", 60),
      );
      expect(err.kind).toBe("unavailable");
    });
    expect(standin.log).toHaveLength(0);
  });

  test("with the test override installed, a loopback http receiver is accepted", async () => {
    const env = passwordEnv();
    const job = await submitJob(ctx(env), SUBMIT);
    const made = await subscribeWebhook(ctx(env), job.uuid, "http://127.0.0.1:9/hook", 60);
    expect(made.url).toEqual(expect.any(String));
  });
});

describe("bounds that the transport itself enforces", () => {
  test("send takes the 15-second ceiling, whatever a caller asked for", async () => {
    const env = passwordEnv();
    const timeouts = recordAbortTimeouts();
    try {
      const job = await submitJob(ctx(env, { timeoutMs: 60_000 }), SUBMIT);
      await getJob(ctx(env, { timeoutMs: 60_000 }), job.uuid);
      await tapisHealth(env, { timeoutMs: 60_000 });
      await mintTapisToken(env, { owner: OWNER, timeoutMs: 60_000 });
    } finally {
      timeouts.restore();
    }
    // The mint, the submit, the get, the health call and a second mint, each asked for 15 s at most.
    expect(timeouts.values.length).toBeGreaterThanOrEqual(5);
    expect(timeouts.values.every((ms) => ms === TAPIS_TIMEOUT_MS)).toBe(true);
    // And with no timeout asked for, the ceiling is the default.
    const defaults = recordAbortTimeouts();
    try {
      await tapisHealth(env);
    } finally {
      defaults.restore();
    }
    expect(defaults.values).toEqual([TAPIS_TIMEOUT_MS]);
  });

  test("a chunked body is accepted at exactly the bound and refused one byte over", async () => {
    const env = passwordEnv();
    const job = await submitJob(ctx(env), SUBMIT);
    standin.advance(job.uuid, "FINISHED");
    standin.respond("GET /v3/jobs/:uuid/output/download/*", 200, chunked(1000));
    const exact = await downloadOutput(ctx(env), job.uuid, "work/outputs/x.bin", 1000);
    expect(exact).toHaveLength(1000);
    standin.respond("GET /v3/jobs/:uuid/output/download/*", 200, chunked(1001));
    const over = await failure(() =>
      downloadOutput(ctx(env), job.uuid, "work/outputs/x.bin", 1000),
    );
    expect(over.kind).toBe("invalid_response");
    // The status the oversize answer came with is carried.
    expect(over.status).toBe(200);
    standin.respond("GET /v3/jobs/:uuid/output/download/*", 200, chunked(1));
    expect(await downloadOutput(ctx(env), job.uuid, "work/outputs/x.bin", 1)).toHaveLength(1);
  });

  test("headers followed by a body that never arrives are `unavailable`, and a read tries three times", async () => {
    const env = passwordEnv();
    const job = await submitJob(ctx(env), SUBMIT);
    // One byte, then silence, for each of the three attempts.
    standin.respond(
      "GET /v3/jobs/:uuid",
      200,
      () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([0x20]));
          },
        }),
      3,
      { "Content-Type": "application/json" },
    );
    const err = await failure(() => getJob(ctx(env, { timeoutMs: 200 }), job.uuid));
    expect(err.kind).toBe("unavailable");
    expect(jobCalls("GET /v3/jobs/:uuid")).toHaveLength(3);
  });

  test("a connection that closes in the middle of a body is `unavailable`, and a read tries again", async () => {
    const env = passwordEnv();
    const job = await submitJob(ctx(env), SUBMIT);
    // The headers and one byte are sent, and a moment later the stream breaks: the client has an
    // answer in hand and loses it while reading. (Breaking before the first byte is a reset that the
    // runtime retries by itself, which is not what is tested here.)
    const breaksMidBody = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([0x7b]));
          setTimeout(() => controller.error(new Error("the server went away")), 40);
        },
      });
    standin.respond("GET /v3/jobs/:uuid", 200, breaksMidBody, 3, {
      "Content-Type": "application/json",
    });
    const err = await failure(() => getJob(ctx(env, { timeoutMs: 2000 }), job.uuid));
    expect(err.kind).toBe("unavailable");
    expect(jobCalls("GET /v3/jobs/:uuid")).toHaveLength(3);
    // The same break on a submit is not retried, and its outcome is unknown.
    standin.respond("POST /v3/jobs/submit", 200, breaksMidBody, 3, {
      "Content-Type": "application/json",
    });
    const before = jobCalls("POST /v3/jobs/submit").length;
    const submit = await failure(() => submitJob(ctx(env, { timeoutMs: 2000 }), SUBMIT));
    expect([submit.kind, submit.outcomeUnknown]).toEqual(["unavailable", true]);
    expect(jobCalls("POST /v3/jobs/submit").length - before).toBe(1);
  });

  test("a body that is not valid UTF-8 is `invalid_response`, not repaired into something that parses", async () => {
    const env = passwordEnv();
    const job = await submitJob(ctx(env), SUBMIT);
    const head = new TextEncoder().encode(
      `{"status":"success","result":{"uuid":"${job.uuid}","status":"PENDING","lastMessage":"`,
    );
    const tail = new TextEncoder().encode('"}}');
    // A lone 0xFF byte inside a string: a lenient decoder turns it into U+FFFD and the JSON parses.
    const bytes = new Uint8Array([...head, 0xff, ...tail]);
    standin.respond("GET /v3/jobs/:uuid", 200, bytes);
    const err = await failure(() => getJob(ctx(env), job.uuid));
    expect(err.kind).toBe("invalid_response");
  });
});

describe("the stand-in is faithful to what the documentation says", () => {
  test("it knows the specification's thirteen job statuses, and NEMAR's list is the same", () => {
    expect([...SPEC_JOB_STATUSES]).toEqual([...TAPIS_JOB_STATUSES]);
  });

  test("ALL_JOBS is the caller's own jobs plus the jobs shared with the caller, never the whole tenant", async () => {
    const env = serviceEnv();
    const mine = await submitJob(ctx(env, { owner: OWNER }), SUBMIT);
    const theirs = await submitJob(ctx(env, { owner: OTHER_OWNER }), {
      ...SUBMIT,
      jobId: "job_cccccccccccccccccccccccc",
    });
    const page = { limit: 10, skip: 0 };
    const ids = async (listType: "MY_JOBS" | "SHARED_JOBS" | "ALL_JOBS") =>
      (await listJobs(ctx(env, { owner: OWNER }), { listType, ...page })).map((j) => j.uuid);
    expect(await ids("MY_JOBS")).toEqual([mine.uuid]);
    expect(await ids("SHARED_JOBS")).toEqual([]);
    expect(await ids("ALL_JOBS")).toEqual([mine.uuid]);
    // A job the other identity owns is found by tag only after it is shared with this one.
    expect(
      await searchJobsByTag(
        ctx(env, { owner: OWNER }),
        nemarJobTag("job_cccccccccccccccccccccccc"),
      ),
    ).toEqual([]);
    standin.shareJob(theirs.uuid, OWNER);
    expect((await ids("ALL_JOBS")).sort()).toEqual([mine.uuid, theirs.uuid].sort());
    expect(await ids("SHARED_JOBS")).toEqual([theirs.uuid]);
    expect(await ids("MY_JOBS")).toEqual([mine.uuid]);
    expect(
      (
        await searchJobsByTag(
          ctx(env, { owner: OWNER }),
          nemarJobTag("job_cccccccccccccccccccccccc"),
        )
      ).map((j) => j.uuid),
    ).toEqual([theirs.uuid]);
  });
});

describe("listJobs orderBy (phase A7, #2012; the spelling is UNVERIFIED against a real tenant)", () => {
  const listRequests = () => standin.log.filter((r) => r.route === "GET /v3/jobs/list");

  test("sends `orderBy=created(desc)` in the query when asked, and nothing when not", async () => {
    const env = passwordEnv();
    await listJobs(ctx(env), {
      listType: "ALL_JOBS",
      limit: 10,
      skip: 20,
      orderBy: "created(desc)",
    });
    await listJobs(ctx(env), { listType: "ALL_JOBS", limit: 10, skip: 0 });
    const [asked, plain] = listRequests();
    const query = new URL(`http://x${asked?.path}`).searchParams;
    expect(query.get("orderBy")).toBe("created(desc)");
    expect(query.get("listType")).toBe("ALL_JOBS");
    expect(query.get("limit")).toBe("10");
    expect(query.get("skip")).toBe("20");
    expect(new URL(`http://x${plain?.path}`).searchParams.has("orderBy")).toBe(false);
  });

  test("an orderBy that is not a field and a direction is refused before anything is sent (MUTATION: drop the check)", async () => {
    const env = passwordEnv();
    for (const orderBy of [
      "created",
      "created(sideways)",
      "a b(asc)",
      "x;y(desc)",
      "",
      "created(desc),name(asc)",
      "(desc)",
      `${"c".repeat(33)}(asc)`,
    ]) {
      let err: unknown;
      try {
        await listJobs(ctx(env), { listType: "ALL_JOBS", limit: 10, skip: 0, orderBy });
      } catch (e) {
        err = e;
      }
      expect([orderBy, err instanceof RangeError]).toEqual([orderBy, true]);
    }
    expect(listRequests()).toHaveLength(0);
    for (const ok of ["created(asc)", "lastUpdated(desc)"]) {
      await listJobs(ctx(env), { listType: "ALL_JOBS", limit: 10, skip: 0, orderBy: ok });
    }
    expect(listRequests()).toHaveLength(2);
  });
});
