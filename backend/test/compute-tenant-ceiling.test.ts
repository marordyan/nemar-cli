/**
 * NEMAR's tenant-wide ceiling on live jobs (issue #2121, phase P2; ADR 0118, amendment of 2026-11-10).
 *
 * The rule, in the hold's own statement: a job of class K is admitted when
 * `occupied + 1 + SUM over the other classes L of max(0, floor[L] - occupied[L]) <= ceiling`. Every guard
 * is proven on BOTH engines, bun:sqlite and Miniflare's D1 (the one `wrangler --local` runs), because a
 * statement proven only on bun:sqlite "is not proven": the races put a round trip on both sides of every
 * statement, and the plans are read from each engine's own planner.
 *
 * What is pinned:
 *  (a) the whole path (a pipeline run through the real admin route): with the ceiling full of jobs of
 *      other kinds a CPU run makes no job, takes no hold, stops with `platform_busy` and the stamp is
 *      `refused`; the same run with one slot more dispatches (the control), and the cron stops with the
 *      word too;
 *  (b) a floor is unconditional: ceiling 4 with a people floor of 2 stops the pipelines at 2 although
 *      their own cap says 10, and a person is still admitted into the slots they could not take;
 *  (c) two requests racing for the last slot make one job; six for two slots make two; a mixed crowd
 *      never exceeds the ceiling or a floor;
 *  (d) a ceiling of 0 admits nothing; a floor equal to the ceiling leaves nothing for the other classes;
 *      the classes are counted independently (a person's rows are not the pipelines'), a `created` job
 *      counts, and the web and the CLI are one class;
 *  (e) a terminal row that still records an orphaned platform job holds a slot until it is cleared;
 *  (f) the counting statement's plan: the live rows are read through a partial index, and the orphan term
 *      is the one scan of the table (the documented cost);
 *  (g) a floor above the ceiling is refused by `PUT /admin/compute/policy`, a stored policy WITHOUT the key
 *      still parses and falls back to the shipped default, never to "no limit";
 *  (h) the status route shows the tenant block and the attention count;
 *  (i) with the default policy NEMAR's own pipelines burst to 12 under the 20 ceiling and a people floor
 *      of 8, and the 13th is refused.
 *
 * Mutations (each proved by hand, see the pull request): the comparison `<=` of the guard, the floor term,
 * the orphan term and the fallback of `tenantPolicyOf`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  COMPUTE_REFUSAL_CODES,
  COMPUTE_REFUSAL_STATUS,
  type ComputeSource,
} from "../../shared/compute-state";
import {
  type ComputeTenantPolicy,
  DEFAULT_COMPUTE_POLICY,
  TENANT_POLICY_DEFAULT,
  tenantPolicyOf,
} from "../../shared/contract/compute";
import {
  COMPUTE_PIPELINE_REFUSAL_STATUS,
  ComputePipelineRunResponseSchema,
  ComputeStatusResponseSchema,
} from "../../shared/contract/compute-admin";
import { createJob } from "../src/services/compute-jobs";
import { runComputePipelineDispatchCron } from "../src/services/compute-pipeline-dispatch";
import { getPolicy } from "../src/services/compute-policy";
import {
  TENANT_CLASSES,
  TENANT_COUNTS_SQL,
  type TenantClass,
  tenantClassOf,
  tenantFacts,
  tenantGuard,
} from "../src/services/compute-tenant";
import type { Bindings } from "../src/types/bindings";
import {
  COMPUTE_KEYS,
  type ComputeWho,
  makeComputeApp,
  seedComputeUsers,
} from "./helpers/compute-app";
import { type ComputeHarness, startComputeHarness } from "./helpers/compute-harness";
import {
  type LifecycleFixture,
  makeJob,
  startLifecycleFixture,
} from "./helpers/compute-lifecycle-fixture";
import {
  fundPipelines,
  seedEegDataset,
  seedPipelinesAccount,
} from "./helpers/compute-pipeline-fixture";
import {
  fundAccount,
  fundPartner,
  fundPlatform,
  holdBody,
  jobSpec,
  roundTripD1,
  seedUser,
  setPolicy,
  trace,
} from "./helpers/compute-seed";

// --- The two engines -----------------------------------------------------------------------------

let h: ComputeHarness;

beforeAll(async () => {
  h = await startComputeHarness({ withD1: true });
}, 90_000);

beforeEach(async () => {
  await h.reset();
  // Miniflare's D1 is never reset; the jobs of an earlier case would count, so this file empties the table
  // (nothing references a job row) and every case reads absolute numbers. The ledger's holds stay, and the
  // pools they are taken from are funded generously.
  await (h.d1 as D1Database).prepare("DELETE FROM compute_jobs").run();
});

afterAll(async () => {
  await h?.dispose();
}, 30_000);

interface World {
  name: string;
  d1: D1Database;
  env(over?: Partial<Bindings>): Bindings;
}
const worlds = (): World[] => [
  { name: "bun:sqlite", d1: h.env().DB, env: (over) => h.env(over) },
  { name: "Miniflare D1", d1: h.d1 as D1Database, env: (over) => h.env({ DB: h.d1, ...over }) },
];

/** Run a case on both engines; `h.reset()` has already given bun:sqlite a new database. */
function onBoth(name: string, body: (w: World) => Promise<void>) {
  for (const which of [0, 1]) {
    test(`${name} [${which === 0 ? "bun:sqlite" : "Miniflare D1"}]`, async () => {
      await body(worlds()[which] as World);
    });
  }
}

/** Requests that overlap: bun:sqlite answers at once, so each statement takes a round trip, as D1's does. */
const racing = (w: World): Bindings =>
  w.name === "bun:sqlite" ? w.env({ DB: roundTripD1(w.d1) }) : w.env();

const NO_FLOORS = { people: 0, pipelines: 0, partner: 0 };

/**
 * The owner's policy for a case: the tenant ceiling and floors it names, and every OTHER limit lifted, so
 * the case sees only the tenant guard. Funds the pools every source draws on, generously.
 */
async function tenant(w: World, policy: ComputeTenantPolicy, over: Record<string, unknown> = {}) {
  const owner = await seedUser(w.d1, { role: "owner" });
  await setPolicy(w.d1, owner, {
    maxLiveJobsPerPerson: 1000,
    pipelines: {
      ...DEFAULT_COMPUTE_POLICY.pipelines,
      dailyJobCap: 100_000,
      maxLiveJobs: { cpu: 1000, gpu: 1000 },
    },
    tenant: policy,
    ...over,
  });
  await fundPlatform(w.d1, "people", 1_000_000_000);
  await fundPlatform(w.d1, "pipelines", 1_000_000_000, "cpu");
  await fundPlatform(w.d1, "pipelines", 1_000_000_000, "gpu");
}

const ceilingOf = (maxLiveJobs: number, reserved = NO_FLOORS): ComputeTenantPolicy => ({
  maxLiveJobs,
  reserved,
});

// --- Jobs of each class ----------------------------------------------------------------------------

const pipelineJob = (env: Bindings, pool: "cpu" | "gpu" = "cpu") =>
  createJob(env, {
    source: "pipeline",
    accountId: null,
    appId: "nemar-launch",
    appVersion: "1.0.0",
    spec:
      pool === "cpu"
        ? jobSpec({ partition: "large-shared" })
        : jobSpec({ partition: "gpu-shared", gpus: 1 }),
  });

/** A person with a pool that does not bind. */
async function person(w: World): Promise<number> {
  const accountId = await seedUser(w.d1);
  await fundAccount(w.d1, accountId, 1_000_000_000);
  return accountId;
}

const personJob = (env: Bindings, accountId: number, source: "cli" | "web" = "cli") =>
  createJob(env, {
    source,
    accountId,
    appId: "nemar-launch",
    appVersion: "1.0.0",
    spec: jobSpec(),
  });

/** A partner's job: no NEMAR account, a client's own pool. */
async function partnerJob(w: World, env: Bindings, client: string) {
  await fundPartner(w.d1, client, 1_000_000_000);
  return createJob(env, {
    source: "partner",
    accountId: null,
    clientId: client,
    tapisOwner: "some.tapis-user",
    holdBody: holdBody(),
  });
}

const word = (r: Awaited<ReturnType<typeof createJob>>) => (r.ok ? "ok" : r.code);

/** What the tenant counts say, by the statement the guard reads. */
const counts = async (w: { d1: D1Database }) =>
  (await w.d1
    .prepare(TENANT_COUNTS_SQL)
    .first<Record<TenantClass | "occupied", number>>()) as Record<TenantClass | "occupied", number>;

// --- (c) the race -----------------------------------------------------------------------------------

describe("(c) requests racing for the last slots", () => {
  onBoth("two requests racing for the last slot: exactly one wins", async (w) => {
    await tenant(w, ceilingOf(1));
    const env = racing(w);
    const before = await trace(w.d1);
    const results = await Promise.all([pipelineJob(env), pipelineJob(env)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.code === "platform_busy")).toHaveLength(1);
    const after = await trace(w.d1);
    expect([after.jobs - before.jobs, after.holds - before.holds]).toEqual([1, 1]);
  });

  onBoth("six requests racing for two slots make exactly two jobs and two holds", async (w) => {
    await tenant(w, ceilingOf(2));
    const env = racing(w);
    const before = await trace(w.d1);
    const results = await Promise.all(Array.from({ length: 6 }, () => pipelineJob(env)));
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    expect(results.filter((r) => !r.ok && r.code === "platform_busy")).toHaveLength(4);
    const after = await trace(w.d1);
    expect([after.jobs - before.jobs, after.holds - before.holds]).toEqual([2, 2]);
    expect((await counts(w)).occupied).toBe(2);
  });

  onBoth(
    "a crowd of two classes under a floor never passes the ceiling or the other's floor",
    async (w) => {
      // Ceiling 4, the people floor 2: the pipelines may hold 2 whatever the order, and the 4 slots fill.
      await tenant(w, ceilingOf(4, { people: 2, pipelines: 0, partner: 0 }));
      const accounts = await Promise.all(Array.from({ length: 6 }, () => person(w)));
      const env = racing(w);
      const results = await Promise.all([
        ...Array.from({ length: 6 }, () => pipelineJob(env)),
        ...accounts.map((a) => personJob(env, a)),
      ]);
      const c = await counts(w);
      expect(c.occupied).toBe(4);
      expect(c.pipelines).toBeLessThanOrEqual(2);
      expect(c.people + c.pipelines).toBe(4);
      expect(results.filter((r) => r.ok)).toHaveLength(4);
      expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.code === "platform_busy")).toBe(
        true,
      );
    },
  );
});

// --- (b) and (d) the floors, the edges ---------------------------------------------------------------

describe("(b) a floor is unconditional", () => {
  onBoth(
    "ceiling 4 with a people floor of 2: the pipelines stop at 2 though their own cap is 10",
    async (w) => {
      await tenant(w, ceilingOf(4, { people: 2, pipelines: 0, partner: 0 }), {
        pipelines: {
          ...DEFAULT_COMPUTE_POLICY.pipelines,
          dailyJobCap: 100_000,
          maxLiveJobs: { cpu: 10, gpu: 10 },
        },
      });
      const env = w.env();
      expect([word(await pipelineJob(env)), word(await pipelineJob(env))]).toEqual(["ok", "ok"]);
      expect(word(await pipelineJob(env))).toBe("platform_busy");
      // The two slots they could not take are people's, and a person is admitted into them.
      const a = await person(w);
      expect([word(await personJob(env, a)), word(await personJob(env, a))]).toEqual(["ok", "ok"]);
      expect(word(await personJob(env, a))).toBe("platform_busy");
      expect(await counts(w)).toMatchObject({ people: 2, pipelines: 2, occupied: 4 });
    },
  );

  onBoth("a refusal leaves no trace: no job, no hold, no pseudonym", async (w) => {
    await tenant(w, ceilingOf(0));
    const a = await person(w);
    const before = await trace(w.d1);
    expect(word(await personJob(w.env(), a))).toBe("platform_busy");
    expect(word(await pipelineJob(w.env()))).toBe("platform_busy");
    expect(await trace(w.d1)).toEqual(before);
  });
});

describe("(d) the edges", () => {
  onBoth("a ceiling of 0 admits nothing, whatever the class", async (w) => {
    await tenant(w, ceilingOf(0));
    const a = await person(w);
    const env = w.env();
    expect([
      word(await personJob(env, a, "cli")),
      word(await personJob(env, a, "web")),
      word(await pipelineJob(env, "cpu")),
      word(await pipelineJob(env, "gpu")),
      word(await partnerJob(w, env, "client.zero")),
    ]).toEqual(Array(5).fill("platform_busy"));
    expect((await counts(w)).occupied).toBe(0);
  });

  onBoth("a floor equal to the ceiling leaves nothing for the other classes", async (w) => {
    await tenant(w, ceilingOf(3, { people: 3, pipelines: 0, partner: 0 }));
    const env = w.env();
    expect(word(await pipelineJob(env))).toBe("platform_busy");
    expect(word(await partnerJob(w, env, "client.floor"))).toBe("platform_busy");
    const a = await person(w);
    expect([
      word(await personJob(env, a)),
      word(await personJob(env, a)),
      word(await personJob(env, a)),
    ]).toEqual(["ok", "ok", "ok"]);
    expect(word(await personJob(env, a))).toBe("platform_busy");
  });

  onBoth(
    "the classes are counted independently: a person's rows are not the pipelines'",
    async (w) => {
      // Ceiling 4, the pipelines' floor 2, two people's jobs live. A person's third would leave the pipelines
      // fewer than their 2: refused. If a person's rows counted toward the pipelines' floor it would be admitted.
      await tenant(w, ceilingOf(4, { people: 0, pipelines: 2, partner: 0 }));
      const env = w.env();
      const a = await person(w);
      expect([word(await personJob(env, a)), word(await personJob(env, a))]).toEqual(["ok", "ok"]);
      expect(await counts(w)).toMatchObject({ people: 2, pipelines: 0, partner: 0, other: 0 });
      expect(word(await personJob(env, a))).toBe("platform_busy");
      // ... and the pipelines' own two are admitted.
      expect([word(await pipelineJob(env)), word(await pipelineJob(env))]).toEqual(["ok", "ok"]);
      expect(await counts(w)).toMatchObject({ people: 2, pipelines: 2, occupied: 4 });
    },
  );

  onBoth("a `created` job counts, and the web and the CLI are one class", async (w) => {
    await tenant(w, ceilingOf(2, { people: 0, pipelines: 0, partner: 0 }));
    const env = w.env();
    const a = await person(w);
    const first = await personJob(env, a, "cli");
    expect(first.ok && first.job.state).toBe("created");
    const second = await personJob(env, a, "web");
    expect(second.ok && second.job.state).toBe("created");
    expect(await counts(w)).toMatchObject({ people: 2, occupied: 2 });
    expect(word(await pipelineJob(env))).toBe("platform_busy");
  });

  onBoth("the partner is a class of its own, and a swept row is `other`", async (w) => {
    await tenant(w, ceilingOf(10, { people: 0, pipelines: 0, partner: 2 }));
    const env = w.env();
    const kept = await partnerJob(w, env, "client.kept");
    if (!kept.ok) throw new Error(`refused: ${kept.code}`);
    expect(await counts(w)).toMatchObject({ partner: 1, other: 0, occupied: 1 });
    // The same row, found by the sweep to have skipped the reservation, is not a partner's any more.
    await w.d1
      .prepare("UPDATE compute_jobs SET flag_unreserved = 1 WHERE id = ?")
      .bind(kept.job.id)
      .run();
    expect(await counts(w)).toMatchObject({ partner: 0, other: 1, occupied: 1 });
  });

  test("every class is declared once: the classes, the sources and the refusal word agree", () => {
    const sources: ComputeSource[] = ["cli", "web", "partner", "pipeline"];
    expect(sources.map(tenantClassOf)).toEqual(["people", "people", "partner", "pipelines"]);
    expect(TENANT_CLASSES).toEqual(["people", "pipelines", "partner", "other"]);
    expect(COMPUTE_REFUSAL_CODES).toContain("platform_busy");
    expect(COMPUTE_REFUSAL_STATUS.platform_busy).toBe(409);
    // A pipeline run inherits the status; nothing declares it twice.
    expect(COMPUTE_PIPELINE_REFUSAL_STATUS.platform_busy).toBe(
      COMPUTE_REFUSAL_STATUS.platform_busy,
    );
  });
});

// --- (e) the orphan term -----------------------------------------------------------------------------

describe("(e) an orphaned platform job holds a slot", () => {
  onBoth("a terminal row with an orphan counts until it is cleared", async (w) => {
    await tenant(w, ceilingOf(1));
    const env = w.env();
    const first = await pipelineJob(env);
    if (!first.ok) throw new Error(`refused: ${first.code}`);
    // The job ended while its platform job could not be cancelled: the row is terminal and records the orphan.
    await w.d1
      .prepare(
        "UPDATE compute_jobs SET state = 'cancelled', ended_at = datetime('now'), orphan_tapis_uuid = 'orphan-1' WHERE id = ?",
      )
      .bind(first.job.id)
      .run();
    // Terminal, so not a pipeline's live job any more; but the platform job still holds a cluster slot.
    expect(await counts(w)).toMatchObject({ pipelines: 0, other: 1, occupied: 1 });
    expect(word(await pipelineJob(env))).toBe("platform_busy");
    // The sweep cancelled it: the slot is free.
    await w.d1
      .prepare("UPDATE compute_jobs SET orphan_tapis_uuid = NULL WHERE id = ?")
      .bind(first.job.id)
      .run();
    expect((await counts(w)).occupied).toBe(0);
    expect(word(await pipelineJob(env))).toBe("ok");
  });

  onBoth(
    "a terminal row without one holds nothing, and a live row with one is counted once",
    async (w) => {
      await tenant(w, ceilingOf(5));
      const env = w.env();
      const done = await pipelineJob(env);
      const live = await pipelineJob(env);
      if (!done.ok || !live.ok) throw new Error("refused");
      await w.d1
        .prepare(
          "UPDATE compute_jobs SET state = 'cancelled', ended_at = datetime('now') WHERE id = ?",
        )
        .bind(done.job.id)
        .run();
      await w.d1
        .prepare("UPDATE compute_jobs SET orphan_tapis_uuid = 'orphan-2' WHERE id = ?")
        .bind(live.job.id)
        .run();
      expect(await counts(w)).toMatchObject({ pipelines: 1, other: 0, occupied: 1 });
    },
  );
});

// --- (f) the plan --------------------------------------------------------------------------------------

describe("(f) the counting statement's plan", () => {
  for (const which of [0, 1]) {
    test(`reads the live rows through a partial index and the orphans by one scan [${which === 0 ? "bun:sqlite" : "Miniflare D1"}]`, async () => {
      const d1 = (worlds()[which] as World).d1;
      const plan = async (sql: string) =>
        (
          await d1
            .prepare(`EXPLAIN QUERY PLAN ${sql.replace(/\?\d*/g, "1")}`)
            .all<{ detail: string }>()
        ).results.map((p) => p.detail);
      for (const [name, sql] of [
        ["the counts", TENANT_COUNTS_SQL],
        ["the guard", `SELECT ${tenantGuard("pipelines", TENANT_POLICY_DEFAULT).sql}`],
      ] as const) {
        const detail = await plan(sql);
        // The live leg: a partial index of the live rows, never the whole table.
        expect([
          name,
          detail.some((d) => /USING (COVERING )?INDEX compute_jobs_(live|examined)\b/.test(d)),
        ]).toEqual([name, true]);
        // The orphan leg has no index (a partial one needs a migration): it is the ONE scan of the table.
        const scans = detail.filter(
          (d) => /\bSCAN\b/.test(d) && /compute_jobs\b/.test(d) && !/INDEX/.test(d),
        );
        expect([name, scans.length]).toEqual([name, 1]);
      }
    });
  }

  test("the live states are written literally, so the partial index serves the count", () => {
    expect(TENANT_COUNTS_SQL).toContain("state IN ('created', 'uploading', 'submitted', 'queued'");
    expect(TENANT_COUNTS_SQL).not.toMatch(/state IN \(\?/);
  });
});

// --- (g) the policy ---------------------------------------------------------------------------------

describe("(g) the policy", () => {
  test("the fallback IS the shipped default: one object, never unlimited", () => {
    expect(TENANT_POLICY_DEFAULT).toEqual({
      maxLiveJobs: 20,
      reserved: { people: 8, pipelines: 2, partner: 0 },
    });
    expect(DEFAULT_COMPUTE_POLICY.tenant).toBe(TENANT_POLICY_DEFAULT);
    const { tenant: _omitted, ...without } = DEFAULT_COMPUTE_POLICY;
    expect(tenantPolicyOf(without)).toEqual(DEFAULT_COMPUTE_POLICY.tenant as ComputeTenantPolicy);
    expect(tenantPolicyOf(without).maxLiveJobs).toBe(20);
  });

  for (const which of [0, 1]) {
    test(`a stored policy WITHOUT the key parses, and the ceiling in force is the default [${which === 0 ? "bun:sqlite" : "Miniflare D1"}]`, async () => {
      const w = worlds()[which] as World;
      const owner = await seedUser(w.d1, { role: "owner" });
      const { tenant: _omitted, ...without } = DEFAULT_COMPUTE_POLICY;
      await w.d1
        .prepare("INSERT INTO compute_policy (policy_json, set_by) VALUES (?, ?)")
        .bind(JSON.stringify(without), owner)
        .run();
      const got = await getPolicy(w.d1);
      expect(got.is_default).toBe(false);
      expect(got.policy.tenant).toBeUndefined();
      const facts = await tenantFacts(w.d1, got.policy);
      expect([facts.ceiling, facts.reserved]).toEqual([
        20,
        { people: 8, pipelines: 2, partner: 0 },
      ]);
      // And it is enforced as the default is: with the pipelines' own caps lifted, the 13th is refused.
      await fundPlatform(w.d1, "pipelines", 1_000_000_000, "cpu");
      await fundPlatform(w.d1, "people", 1_000_000_000);
      await w.d1
        .prepare("INSERT INTO compute_policy (policy_json, set_by) VALUES (?, ?)")
        .bind(
          JSON.stringify({
            ...without,
            pipelines: { dailyJobCap: 100_000, maxLiveJobs: { cpu: 1000, gpu: 1000 } },
          }),
          owner,
        )
        .run();
      const env = w.env();
      const results: string[] = [];
      for (let i = 0; i < 13; i++) results.push(word(await pipelineJob(env)));
      expect(results).toEqual([...Array(12).fill("ok"), "platform_busy"]);
    });
  }
});

// --- Routes: the policy route, the pipeline run, the status ---------------------------------------------

let fx: LifecycleFixture;
const handle = makeComputeApp();

describe("the routes", () => {
  beforeAll(async () => {
    fx = await startLifecycleFixture();
  }, 120_000);

  beforeEach(async () => {
    await fx.reset();
    await seedComputeUsers(fx.harness.db);
  });

  afterAll(async () => {
    await fx?.dispose();
  }, 30_000);

  const ids = (n: number, from = 104) =>
    Array.from({ length: n }, (_, i) => `nm${String(from + i).padStart(6, "0")}`);

  async function call(
    who: ComputeWho,
    method: string,
    path: string,
    env: Bindings,
    body?: unknown,
  ) {
    const res = await handle(
      new Request(`http://api.test/admin/compute/${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${COMPUTE_KEYS[who]}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      env,
    );
    const text = await res.text();
    let json: Record<string, any> = {};
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, body: json, text };
  }

  const count = async (env: Bindings, sql: string) =>
    (await env.DB.prepare(sql).first<{ n: number }>())?.n ?? 0;
  const HOLDS = "SELECT COUNT(*) AS n FROM compute_ledger WHERE kind = 'hold'";
  const LIVE_JOBS = "SELECT COUNT(*) AS n FROM compute_jobs";

  async function world(datasets: string[]) {
    const env = fx.env({ COMPUTE_PIPELINES_DISPATCH_ENABLED: "1" });
    await seedPipelinesAccount(env);
    await fundPipelines(env, 10_000_000, true);
    for (const id of datasets) await seedEegDataset(env, id);
    return env;
  }

  /** The three jobs of other kinds: a swept unreserved row and two GPU pipeline jobs, all live. */
  async function fillWithOthers(env: Bindings) {
    const swept = await makeJob(fx, { env });
    await env.DB.prepare("UPDATE compute_jobs SET flag_unreserved = 1 WHERE id = ?")
      .bind(swept.job.id)
      .run();
    for (let i = 0; i < 2; i++) {
      const gpu = await createJob(env, {
        source: "pipeline",
        accountId: null,
        appId: "nemar-launch",
        appVersion: "1.0.0",
        spec: jobSpec({ partition: "gpu-shared", gpus: 1 }),
      });
      if (!gpu.ok) throw new Error(`could not make a GPU job: ${gpu.code}`);
    }
  }

  const tenantPolicy = (policy: ComputeTenantPolicy) =>
    setPolicy(fx.env().DB, fx.ownerId, { tenant: policy });

  test("(a) a CPU run over a full ceiling makes nothing, takes no hold, and the stamp is refused", async () => {
    await tenantPolicy(ceilingOf(3));
    const env = await world(ids(5));
    await fillWithOthers(env);
    expect(await counts({ d1: env.DB })).toMatchObject({ other: 1, pipelines: 2, occupied: 3 });
    const holds = await count(env, HOLDS);
    const jobs = await count(env, LIVE_JOBS);
    const res = await call("admin", "POST", "pipeline/run", env, {
      recipe: "nemar-floor",
      eligible: true,
      limit: 10,
    });
    expect(ComputePipelineRunResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body).toMatchObject({ dispatched: 0, stopped_by: "platform_busy" });
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0]).toMatchObject({ ok: false, code: "platform_busy" });
    expect(await count(env, HOLDS)).toBe(holds);
    expect(await count(env, LIVE_JOBS)).toBe(jobs);
    const stamp = await env.DB.prepare(
      "SELECT state, refusal_code, job_id FROM compute_pipeline_stamps",
    ).all<{ state: string; refusal_code: string; job_id: string | null }>();
    expect(stamp.results).toEqual([
      { state: "refused", refusal_code: "platform_busy", job_id: null },
    ]);
    // The control: one slot more and the same run dispatches (a refusal by anything else would not move).
    await tenantPolicy(ceilingOf(4));
    const again = await call("admin", "POST", "pipeline/run", env, {
      recipe: "nemar-floor",
      eligible: true,
      limit: 10,
    });
    expect(again.body).toMatchObject({ dispatched: 1, stopped_by: "platform_busy" });
  });

  test("a single named dataset is refused 409 platform_busy, with the sentence, and the cron stops with the word", async () => {
    await tenantPolicy(ceilingOf(3));
    const env = await world(ids(5));
    await fillWithOthers(env);
    const named = await call("admin", "POST", "pipeline/run", env, {
      recipe: "nemar-floor",
      dataset: "nm000104",
    });
    expect([named.status, named.body.code]).toEqual([409, "platform_busy"]);
    expect(named.body.error).toBe(
      "NEMAR's share of the cluster is full right now; try again shortly.",
    );
    // The daily cron: the ceiling does not depend on the pool, so it ends the whole run at the first refusal.
    const cron = await runComputePipelineDispatchCron(env);
    expect(cron).toMatchObject({ outcome: "ran", dispatched: 0 });
    expect(cron?.recipes[0]?.stopped_by).toBe("platform_busy");
    expect(cron?.recipes.slice(1).every((r) => r.skipped === "run_ended")).toBe(true);
  });

  test("(g) PUT /admin/compute/policy refuses floors above the ceiling, names the field, and writes nothing", async () => {
    const env = fx.env();
    const bad = {
      ...DEFAULT_COMPUTE_POLICY,
      tenant: { maxLiveJobs: 5, reserved: { people: 3, pipelines: 2, partner: 1 } },
    };
    const refused = await call("owner", "PUT", "policy", env, { policy: bad });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe("invalid_body");
    expect(refused.body.fields.map((f: { path: string }) => f.path)).toEqual([
      "policy.tenant.reserved",
    ]);
    expect(await count(env, "SELECT COUNT(*) AS n FROM compute_policy")).toBe(0);
    // Equal is allowed, and so is a ceiling of 0 with no floors; a floor past the schema's bound is not.
    for (const tenantPolicy of [
      { maxLiveJobs: 6, reserved: { people: 3, pipelines: 2, partner: 1 } },
      { maxLiveJobs: 0, reserved: NO_FLOORS },
    ]) {
      const ok = await call("owner", "PUT", "policy", env, {
        policy: { ...DEFAULT_COMPUTE_POLICY, tenant: tenantPolicy },
      });
      expect([ok.status, tenantPolicy]).toEqual([200, tenantPolicy]);
    }
    const big = await call("owner", "PUT", "policy", env, {
      policy: { ...DEFAULT_COMPUTE_POLICY, tenant: { maxLiveJobs: 1001, reserved: NO_FLOORS } },
    });
    expect(big.status).toBe(400);
    const unknown = await call("owner", "PUT", "policy", env, {
      policy: {
        ...DEFAULT_COMPUTE_POLICY,
        tenant: { maxLiveJobs: 5, reserved: { ...NO_FLOORS, nobody: 1 } },
      },
    });
    expect(unknown.status).toBe(400);
  });

  test("(h) the status route shows the tenant block and counts what is above the ceiling", async () => {
    await tenantPolicy(ceilingOf(5, { people: 2, pipelines: 1, partner: 0 }));
    const env = await world([]);
    await fillWithOthers(env);
    const res = await call("admin", "GET", "status", env);
    expect(ComputeStatusResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.tenant).toEqual({
      ceiling: 5,
      occupied: 3,
      by_class: { people: 0, pipelines: 2, partner: 0, other: 1 },
      reserved: { people: 2, pipelines: 1, partner: 0 },
    });
    expect(res.body.attention.tenant_over_ceiling).toBe(0);
    // Occupancy NEMAR did not admit can pass the ceiling; the count says by how much.
    await tenantPolicy(ceilingOf(2));
    const over = await call("admin", "GET", "status", env);
    expect(over.body.attention.tenant_over_ceiling).toBe(1);
    expect(over.body.tenant).toMatchObject({ ceiling: 2, occupied: 3 });
  });

  test("(i) the default policy lets NEMAR's own pipelines burst to 12, and the 13th meets the ceiling", async () => {
    // The pipelines' own caps are what the default says (8 CPU and 4 GPU: 12), so the first 12 pass both
    // and the tenant ceiling would be the first to refuse a 13th; with the CPU cap raised to see it.
    await setPolicy(fx.env().DB, fx.ownerId, {
      pipelines: { ...DEFAULT_COMPUTE_POLICY.pipelines, maxLiveJobs: { cpu: 20, gpu: 4 } },
    });
    const env = await world(ids(15));
    const res = await call("admin", "POST", "pipeline/run", env, {
      recipe: "nemar-floor",
      eligible: true,
      limit: 10,
    });
    expect(res.body).toMatchObject({ dispatched: 10, stopped_by: null });
    const more = await call("admin", "POST", "pipeline/run", env, {
      recipe: "nemar-floor",
      eligible: true,
      limit: 10,
    });
    expect(more.body).toMatchObject({ dispatched: 2, stopped_by: "platform_busy" });
    expect(await count(env, LIVE_JOBS)).toBe(12);
  });
});
