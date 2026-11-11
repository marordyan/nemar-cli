/**
 * `nemar admin compute pipeline run|status` (epic #2005 phase A6, #2011; ADR 0118), driven through the
 * real entry point against the REAL routes: the Worker's admin router behind its real authentication and
 * admin middleware, over real SQLite carrying every migration, Miniflare's R2 through the Worker's own
 * bindings and the Tapis stand-in behind it (which recorded nothing from a real tenant), served on a
 * loopback port and reached through TEST_API_URL. What the command prints is what the route answers.
 *
 * The properties, each with a test of its own: `--eligible --limit 2` dispatches two; one dataset, with and
 * without a version, is dispatched; a dry run WRITES NOTHING, against a Worker that is not production and
 * has compute off; a live run against a Worker with compute off exits 1 with its word; a refused dataset
 * exits 1 with the word and the terms that block it; `--json` prints the Worker's answer and nothing else on
 * standard output; wrong arguments are refused before anything is sent; a member's key and no key exit 1;
 * `status` prints, filters and pages; an answer with keys the CLI does not know is shown, not refused; and
 * no token, address or identity is printed.
 *
 * CI TIER: integration, like the other CLI suites that start the binary against a local server.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import type { Bindings } from "../backend/src/types/bindings";
import {
  COMPUTE_KEYS,
  type ComputeWho,
  makeComputeApp,
  seedComputeUsers,
} from "../backend/test/helpers/compute-app";
import {
  type LifecycleFixture,
  startLifecycleFixture,
} from "../backend/test/helpers/compute-lifecycle-fixture";
import {
  drive,
  finishAtTapis,
  floorOutputs,
  fundPipelines,
  seedEegDataset,
  seedPipelinesAccount,
} from "../backend/test/helpers/compute-pipeline-fixture";
import { setPolicy } from "../backend/test/helpers/compute-seed";
import { DEFAULT_COMPUTE_POLICY } from "../shared/contract/compute";
import {
  ComputePipelineRunResponseSchema,
  ComputePipelineStatusResponseSchema,
} from "../shared/contract/compute-admin";

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");
const handle = makeComputeApp();

let fx: LifecycleFixture;
let configDir: string;
/** Requests the server saw (the `/notices` call of the CLI is not counted). */
let seen: string[] = [];
let augment = false;
/** What the Worker's environment is for a request: production with compute on, unless a test says. */
let workerEnv: Partial<Bindings> = {};

const server = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/notices") return Response.json({ notices: [] });
    seen.push(`${req.method} ${url.pathname}${url.search}`);
    const res = await handle(req, fx.env(workerEnv));
    if (augment && res.ok) {
      const body = (await res.json()) as Record<string, any>;
      body.future_top_level = { added: "by a newer worker" };
      for (const r of body.results ?? []) r.future_nested = 7;
      for (const s of body.stamps ?? []) s.future_nested = 7;
      return Response.json(body, { status: res.status });
    }
    return res;
  },
});
const API = `http://127.0.0.1:${server.port}`;

beforeAll(async () => {
  fx = await startLifecycleFixture();
}, 120_000);

afterAll(async () => {
  server.stop(true);
  await fx?.dispose();
}, 30_000);

beforeEach(async () => {
  await fx.reset();
  await seedComputeUsers(fx.harness.db);
  seen = [];
  augment = false;
  workerEnv = {};
  configDir = mkdtempSync(join(tmpdir(), "nemar-compute-pipeline-cli-"));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

interface Ran {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCli(who: ComputeWho | null, args: string[]): Promise<Ran> {
  if (who === null) {
    rmSync(join(configDir, "config.json"), { force: true });
  } else {
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        activeAccount: "computecli",
        accounts: { computecli: { apiKey: COMPUTE_KEYS[who] } },
      }),
    );
  }
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({
    ...process.env,
    NEMAR_CONFIG_DIR: configDir,
    TEST_API_URL: API,
    NEMAR_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
    FORCE_COLOR: undefined,
    CLICOLOR_FORCE: undefined,
  })) {
    if (v !== undefined) env[k] = v;
  }
  const proc = spawn({
    cmd: ["bun", "run", CLI_ENTRY, "admin", "compute", "pipeline", ...args],
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

async function world(ids = ["nm000104", "nm000105", "nm000106"]) {
  const env = fx.env();
  await seedPipelinesAccount(env);
  await fundPipelines(env);
  for (const id of ids) await seedEegDataset(env, id);
  return env;
}

const count = async (env: Bindings, table: string) =>
  (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())?.n ?? 0;

describe("run --eligible", () => {
  test("its help says what is eligible, the dry run, and that a live run needs compute", async () => {
    const r = await runCli("admin", ["run", "--help-all"]);
    expect(r.exitCode).toBe(0);
    for (const text of ["--dry-run", "--eligible", "live_attempt_exists", "compute_disabled"]) {
      expect(r.stdout).toContain(text);
    }
  });

  test("its help says the run is bounded by the live cap, the daily cap and 10 per invocation", async () => {
    const r = await runCli("admin", ["run", "--help-all"]);
    expect(r.exitCode).toBe(0);
    const text = r.stdout.replace(/\s+/g, " ");
    for (const phrase of [
      "bounded by the live cap of the pool, the daily cap and at most 10 per invocation",
      "over_concurrency or daily_cap_reached",
      "counts toward the daily cap and is not refused by it",
    ]) {
      expect(text).toContain(phrase);
    }
  });

  test("a pool with room for 2 dispatches 2 of 5, stops by over_concurrency, and prints the room", async () => {
    await setPolicy(fx.env().DB, fx.ownerId, {
      pipelines: {
        ...DEFAULT_COMPUTE_POLICY.pipelines,
        maxLiveJobs: { cpu: 2, gpu: 4 },
      },
    });
    const env = await world(["nm000104", "nm000105", "nm000106", "nm000107", "nm000108"]);
    const r = await runCli("admin", ["run", "nemar-floor", "--eligible", "--limit", "5"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("nemar-floor: dispatched 2 of 2 tried");
    expect(r.stdout).toContain("stopped by over_concurrency");
    expect(r.stdout).toContain(
      "room before the run: 50 left of the daily cap, 2 left of the live cap; bounded by the live cap of the pool",
    );
    expect(await count(env, "compute_jobs")).toBe(2);
    const again = await runCli("admin", ["run", "nemar-floor", "--eligible", "--limit", "5"]);
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain("dispatched 0 of 0 tried");
    expect(again.stdout).toContain("stopped by over_concurrency");
    expect(await count(env, "compute_jobs")).toBe(2);
  });

  test("a named dataset on a full pool exits 1 with over_concurrency and its sentence", async () => {
    await setPolicy(fx.env().DB, fx.ownerId, {
      pipelines: { ...DEFAULT_COMPUTE_POLICY.pipelines, maxLiveJobs: { cpu: 1, gpu: 4 } },
    });
    await world();
    expect((await runCli("admin", ["run", "nemar-floor", "--dataset", "nm000104"])).exitCode).toBe(
      0,
    );
    const r = await runCli("admin", ["run", "nemar-floor", "--dataset", "nm000105"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr + r.stdout).toContain("over_concurrency");
    expect(r.stderr + r.stdout).toContain(
      "NEMAR's pipelines already have as many live jobs as the owner allows.",
    );
  });

  test("--eligible --limit 2 dispatches two of three and says which", async () => {
    const env = await world();
    const r = await runCli("admin", ["run", "nemar-floor", "--eligible", "--limit", "2"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("nemar-floor: dispatched 2 of 2 tried");
    expect(r.stdout).toContain("nm000104 v1.0.0: dispatched (attempt 1, job job_");
    expect(r.stdout).toContain("nm000105 v1.0.0: dispatched");
    expect(r.stdout).not.toContain("nm000106");
    expect(await count(env, "compute_pipeline_stamps")).toBe(2);
    expect(await count(env, "compute_jobs")).toBe(2);
    expect(seen).toEqual(["POST /admin/compute/pipeline/run"]);
  });

  test("a pool that refuses is said: stopped by insufficient_balance, exit 0", async () => {
    const env = fx.env();
    await seedPipelinesAccount(env);
    await seedEegDataset(env, "nm000104");
    const r = await runCli("owner", ["run", "nemar-floor", "--eligible"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("dispatched 0 of 1 tried");
    expect(r.stdout).toContain("refused, insufficient_balance");
    expect(r.stdout).toContain("stopped by insufficient_balance");
  });
});

describe("run --dataset", () => {
  test("one dataset is dispatched at its newest version, and a version can be named", async () => {
    const env = fx.env();
    await seedPipelinesAccount(env);
    await fundPipelines(env);
    await seedEegDataset(env, "nm000104", {
      versions: [
        ["1.0.0", "2026-01-01 00:00:00"],
        ["1.1.0", "2026-02-01 00:00:00"],
      ],
    });
    const newest = await runCli("admin", ["run", "nemar-floor", "--dataset", "nm000104"]);
    expect(newest.exitCode).toBe(0);
    expect(newest.stdout).toContain("nm000104 v1.1.0: dispatched");
    const named = await runCli("admin", ["run", "nemar-floor", "--dataset", "nm000104@1.0.0"]);
    expect(named.exitCode).toBe(0);
    expect(named.stdout).toContain("nm000104 v1.0.0: dispatched");
  });

  test("a refused dataset exits 1 with the Worker's word and the terms that block it", async () => {
    const env = await world(["nm000104"]);
    await seedEegDataset(env, "nm000105", { visibility: "private", modalities: "meg" });
    const r = await runCli("admin", ["run", "nemar-floor", "--dataset", "nm000105"]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain("dataset_not_eligible, blocked by public, eeg");
    expect(await count(env, "compute_pipeline_stamps")).toBe(0);
    await runCli("admin", ["run", "nemar-floor", "--dataset", "nm000104"]);
    const again = await runCli("admin", ["run", "nemar-floor", "--dataset", "nm000104"]);
    expect(again.exitCode).toBe(1);
    expect(again.stdout + again.stderr).toContain("live_attempt_exists");
  });

  test("a live run against a Worker with compute off exits 1 with compute_disabled and writes nothing", async () => {
    const env = await world(["nm000104"]);
    workerEnv = { COMPUTE_ENABLED: undefined };
    const r = await runCli("admin", ["run", "nemar-floor", "--dataset", "nm000104"]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain("compute_disabled");
    expect(await count(env, "compute_pipeline_stamps")).toBe(0);
  });
});

describe("--dry-run", () => {
  test("against a Worker that is not production and has compute off, it answers and writes nothing", async () => {
    const env = await world();
    workerEnv = {
      ENVIRONMENT: "development",
      COMPUTE_ENABLED: undefined,
      COMPUTE_RUNTIME_IMAGE: undefined,
    };
    const before = [
      await count(env, "compute_pipeline_stamps"),
      await count(env, "compute_jobs"),
      await count(env, "compute_ledger"),
      await count(env, "audit_log"),
      fx.tapis.log.length,
    ];
    const r = await runCli("admin", [
      "run",
      "nemar-floor",
      "--eligible",
      "--limit",
      "2",
      "--dry-run",
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("dry run of nemar-floor: nothing was written");
    expect(r.stdout).toContain("estimated hold per job: 48 SU, in total 96 SU");
    expect(r.stdout).toContain("compute OFF, runtime image NOT SET, pipelines account present");
    expect(r.stdout).toContain("would dispatch 2:");
    expect(r.stdout).toContain("nm000104 v1.0.0");
    expect(r.stdout).toContain(
      "room now: 50 left of the daily cap, 8 left of the live cap; bounded by the limit asked for",
    );
    expect([
      await count(env, "compute_pipeline_stamps"),
      await count(env, "compute_jobs"),
      await count(env, "compute_ledger"),
      await count(env, "audit_log"),
      fx.tapis.log.length,
    ]).toEqual(before);
  });

  test("the queue's dry run is trimmed to 10 per invocation, and says so", async () => {
    await setPolicy(fx.env().DB, fx.ownerId, {
      pipelines: {
        ...DEFAULT_COMPUTE_POLICY.pipelines,
        dailyJobCap: 100,
        maxLiveJobs: { cpu: 100, gpu: 4 },
      },
    });
    await world(Array.from({ length: 12 }, (_, i) => `nm${String(104 + i).padStart(6, "0")}`));
    const r = await runCli("admin", [
      "run",
      "nemar-floor",
      "--eligible",
      "--limit",
      "100",
      "--dry-run",
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("would dispatch 10:");
    expect(r.stdout).toContain("bounded by the bound of 10 per invocation, run it again for more");
  });

  test("for one dataset it says what blocks it", async () => {
    await world(["nm000104"]);
    const env = fx.env();
    await seedEegDataset(env, "nm000105", { withdrawnAt: "2026-02-01 00:00:00" });
    const r = await runCli("admin", ["run", "nemar-floor", "--dataset", "nm000105", "--dry-run"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("would dispatch 0:");
    expect(r.stdout).toContain("blocked: dataset_not_eligible [not_withdrawn]");
  });

  test("the queue's dry run counts what fails each term", async () => {
    const env = await world(["nm000104"]);
    await seedEegDataset(env, "nm000105", { visibility: "private" });
    const r = await runCli("admin", ["run", "nemar-floor", "--eligible", "--dry-run"]);
    expect(r.stdout).toContain("datasets failing each term: public 1");
    expect(await count(env, "compute_pipeline_stamps")).toBe(0);
  });

  test("--json prints the Worker's answer, and only that, on standard output", async () => {
    await world();
    const r = await runCli("admin", [
      "run",
      "nemar-floor",
      "--eligible",
      "--limit",
      "1",
      "--dry-run",
      "--json",
    ]);
    expect(r.exitCode).toBe(0);
    const body = JSON.parse(r.stdout);
    expect(ComputePipelineRunResponseSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      ok: true,
      dry_run: true,
      would_dispatch: [{ dataset_id: "nm000104" }],
    });
    expect(r.stderr.trim()).toBe("");
  });
});

describe("refusals before anything is sent", () => {
  const bad: Array<[string, string[]]> = [
    ["neither a dataset nor --eligible", ["run", "nemar-floor"]],
    [
      "both a dataset and --eligible",
      ["run", "nemar-floor", "--dataset", "nm000104", "--eligible"],
    ],
    ["a malformed recipe", ["run", "Nemar_Floor", "--eligible"]],
    ["a malformed dataset", ["run", "nemar-floor", "--dataset", "../etc/passwd"]],
    ["a dataset with two versions", ["run", "nemar-floor", "--dataset", "nm000104@1@2"]],
    ["a malformed version", ["run", "nemar-floor", "--dataset", "nm000104@1 0"]],
    ["a limit with a dataset", ["run", "nemar-floor", "--dataset", "nm000104", "--limit", "2"]],
    ["a limit of 0", ["run", "nemar-floor", "--eligible", "--limit", "0"]],
    ["a limit over the maximum", ["run", "nemar-floor", "--eligible", "--limit", "101"]],
    ["a fractional limit", ["run", "nemar-floor", "--eligible", "--limit", "1.5"]],
    ["a status state that is not one", ["status", "--state", "done"]],
    ["a status dataset that is not one", ["status", "--dataset", "nope"]],
    ["a status limit over the maximum", ["status", "--limit", "201"]],
    ["a status cursor that is not a number", ["status", "--before", "x"]],
    ["a status recipe that is not one", ["status", "--recipe", "A B"]],
  ];
  for (const [name, args] of bad) {
    test(`${name}: exit 1, and nothing is sent`, async () => {
      const r = await runCli("admin", args);
      expect([name, r.exitCode]).toEqual([name, 1]);
      expect(seen).toEqual([]);
    });
  }

  test("a member's key and no key at all exit 1", async () => {
    await world(["nm000104"]);
    for (const args of [["run", "nemar-floor", "--eligible", "--dry-run"], ["status"]]) {
      expect((await runCli("member", args)).exitCode).toBe(1);
      expect((await runCli(null, args)).exitCode).toBe(1);
    }
  });

  test("an unknown recipe exits 1 with recipe_unknown", async () => {
    await world(["nm000104"]);
    const r = await runCli("admin", ["run", "nemar-nope", "--dataset", "nm000104"]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain("recipe_unknown");
  });
});

describe("status", () => {
  async function stamped() {
    const env = await world();
    await runCli("admin", ["run", "nemar-floor", "--eligible", "--limit", "3"]);
    seen = [];
    return env;
  }

  test("prints each stamp on a line, newest first, with its state and job", async () => {
    await stamped();
    const r = await runCli("admin", ["status"]);
    expect(r.exitCode).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(
      /nm000106 v1\.0\.0\s+nemar-floor 1\.0\.0 eegprep@0\.5\.0 attempt 1\s+dispatched job job_[0-9a-f]{24}/,
    );
    expect(lines[2]).toContain("nm000104");
  });

  test("filters are sent and applied, and a page says how to continue", async () => {
    await stamped();
    const one = await runCli("admin", ["status", "--dataset", "nm000105"]);
    expect(one.stdout.trim().split("\n")).toHaveLength(1);
    expect(seen.at(-1)).toBe("GET /admin/compute/pipeline/status?dataset=nm000105");
    expect((await runCli("admin", ["status", "--state", "succeeded"])).stdout).toContain(
      "no stamps",
    );
    const page = await runCli("admin", ["status", "--limit", "2"]);
    expect(page.stdout).toMatch(/more: --before \d+/);
    const next = await runCli("admin", [
      "status",
      "--limit",
      "2",
      "--before",
      page.stdout.match(/--before (\d+)/)?.[1] as string,
    ]);
    expect(next.stdout.trim().split("\n")).toHaveLength(1);
  });

  test("a finished job shows as succeeded, and a failure shows its word", async () => {
    const env = await world(["nm000104", "nm000105"]);
    await runCli("admin", ["run", "nemar-floor", "--eligible", "--limit", "2"]);
    const jobOf = async (dataset: string) =>
      (
        await env.DB.prepare(
          `SELECT j.id, j.tapis_uuid FROM compute_pipeline_stamps s JOIN compute_jobs j ON j.id = s.job_id
            WHERE s.dataset_id = ?1`,
        )
          .bind(dataset)
          .first<{ id: string; tapis_uuid: string }>()
      )?.id as string;
    await finishAtTapis(fx, env, await jobOf("nm000104"), { outputs: floorOutputs() });
    const failing = await jobOf("nm000105");
    const uuid = (
      await env.DB.prepare("SELECT tapis_uuid FROM compute_jobs WHERE id = ?1")
        .bind(failing)
        .first<{ tapis_uuid: string }>()
    )?.tapis_uuid as string;
    await drive(fx, env, failing, uuid, "FAILED", "JOB_LAUNCH_FAILURE");
    const r = await runCli("admin", ["status"]);
    expect(r.stdout).toMatch(/nm000104 .*succeeded job job_/);
    expect(r.stdout).toMatch(/nm000105 .*failed launch_failed job job_/);
  });

  test("--json prints the Worker's answer, and only that", async () => {
    await stamped();
    const r = await runCli("admin", ["status", "--json"]);
    expect(r.exitCode).toBe(0);
    const body = JSON.parse(r.stdout);
    expect(ComputePipelineStatusResponseSchema.safeParse(body).success).toBe(true);
    expect(body.stamps).toHaveLength(3);
    expect(r.stderr.trim()).toBe("");
  });
});

describe("what is printed", () => {
  test("an answer with keys the CLI does not know is shown, not refused", async () => {
    await world(["nm000104"]);
    augment = true;
    const run = await runCli("admin", ["run", "nemar-floor", "--eligible"]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("dispatched 1");
    const status = await runCli("admin", ["status"]);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain("nm000104");
  });

  test("no token, address, specification or identity is on standard output or standard error", async () => {
    await world(["nm000104"]);
    const outs = [
      await runCli("admin", ["run", "nemar-floor", "--eligible"]),
      await runCli("admin", ["status", "--json"]),
    ];
    const user = fx.harness.db
      .query("SELECT username, email FROM users WHERE username = 'nemar-pipelines'")
      .get() as {
      username: string;
      email: string;
    };
    for (const out of outs) {
      const all = out.stdout + out.stderr;
      for (const word of [
        fx.tapis.url,
        "NEMAR_LAUNCH_SPEC",
        "job_token",
        "ghcr.io",
        "sha256:",
        "/data/nm000104",
        user.email,
      ]) {
        expect([word, all.includes(word)]).toEqual([word, false]);
      }
    }
  });
});
