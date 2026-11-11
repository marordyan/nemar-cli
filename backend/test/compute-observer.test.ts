/**
 * The observer, its token and the final settlement it makes possible (epic #2005 phase A7, #2012; ADR
 * 0118, decision 8). Real migrations (0118 included), the real ledger with its triggers, the real
 * compute router, Miniflare's R2 and the Tapis stand-in (nothing from which was recorded from a real
 * tenant). The observer itself is not stood in for: the tests are its client, and post the REAL
 * `nemar.observation.v1` documents it writes (the two it wrote are `test/fixtures/compute-observation/`,
 * compared byte for byte with nemar-process's copies by `test/compute-observation-contract.unit.test.ts`),
 * with `Authorization: Bearer <token>`. A test starts from one of them and changes the fields it is about.
 * No response of the real posting service was recorded.
 *
 * What is pinned, each with a test of its own:
 *  - A WRONG, AN EXPIRED, A REUSED AND AN UNKNOWN TOKEN get the same answer, byte for byte, and write
 *    nothing (MUTATION: answer a reused token differently);
 *  - an in-tolerance row settles silently; an out-of-tolerance row sets `flag_mismatch` and STILL settles
 *    to Expanse's figure (MUTATION: make the tolerance test always true; the mismatch case fails);
 *  - a row that matches no job is stored and listed; a row whose job has not ended waits and is settled
 *    by the next pass; a body that fails validation does not spend the run;
 *  - two posts racing on one token make one ingest (MUTATION: drop the `status = 'issued'` term);
 *  - the migration's checks, the mint route's audit row, and that a member cannot mint;
 *  - the wire: the old header and the old body are refused, an unknown field of the document is refused,
 *    an allocation string that cannot be read is refused and settles nothing, and the mapping from the
 *    document to the stored rows is a table (MUTATION: break the allocation parse; break the schema check).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { COMPUTE_REFUSAL_STATUS } from "../../shared/compute-state";
import { DEFAULT_COMPUTE_POLICY } from "../../shared/contract/compute";
import { SACCT_COLUMN_MAX, TRES_MAX } from "../../shared/contract/compute-observation";
import { ComputeObserverIngestResponseSchema } from "../../shared/contract/compute-responses";
import dailyFixture from "../../test/fixtures/compute-observation/daily.v1.json";
import quickFixture from "../../test/fixtures/compute-observation/quick.v1.json";
import { advanceComputeJob, submitComputeJob } from "../src/services/compute-lifecycle";
import {
  OBSERVER_ROWS_MAX,
  expanseFigureMilli,
  isRoutineDifference,
  mintObserverRun,
  observerBearerToken,
  settleObservedRows,
} from "../src/services/compute-observer";
import { listUnmatchedSacct } from "../src/services/compute-reporting";
import type { Bindings } from "../src/types/bindings";
import { COMPUTE_KEYS, makeComputeApp, seedComputeUsers } from "./helpers/compute-app";
import { endedJob as endedJobIn } from "./helpers/compute-ended";
import {
  type LifecycleFixture,
  MINUTE,
  makeJob,
  playLauncher,
  reread,
  setTapisTimes,
  startLifecycleFixture,
} from "./helpers/compute-lifecycle-fixture";
import { type RoutesHandle, makeRoutesApp } from "./helpers/compute-routes-app";

let fx: LifecycleFixture;
let routes: RoutesHandle;
const adminApp = makeComputeApp();
let slurmSeq = 40_000;

beforeAll(async () => {
  fx = await startLifecycleFixture();
  routes = makeRoutesApp();
}, 120_000);

beforeEach(async () => {
  await fx.reset();
});

afterAll(async () => {
  await fx?.dispose();
}, 30_000);

const env = (): Bindings => fx.env();
const nextSlurm = () => String(++slurmSeq);

/**
 * Slurm's job ids are numbers and the Tapis stand-in's are not (a random hex string), so a job that is to
 * be matched by the observer's document is given the number the document will carry. The only seam used:
 * the id is the one thing the document and the job must share.
 */
async function numberSlurm(e: Bindings, jobId: string): Promise<string> {
  const slurm = nextSlurm();
  await e.DB.prepare("UPDATE compute_jobs SET slurm_job_id = ?1 WHERE id = ?2")
    .bind(slurm, jobId)
    .run();
  return slurm;
}

const endedJob = async (minutes = 30, over: Parameters<typeof makeJob>[1] = {}) => {
  const j = await endedJobIn(fx, minutes, over);
  await numberSlurm(j.env, j.job.id);
  return { ...j, job: await reread(j.env, j.job.id) };
};

type Doc = Record<string, unknown>;
type Job = Record<string, unknown>;

/** What Slurm prints for four cores and 8,000 MB on one node: 1,800 seconds of it is 2 SU (2,000 milli-SU). */
const tres = (cpu = 4, over: Record<string, string> = {}) => ({
  billing: String(cpu),
  cpu: String(cpu),
  mem: "8000M",
  node: "1",
  ...over,
});

/** One `accounting.jobs` entry of the observer's document. */
const acct = (slurm: string, over: Job = {}): Job => ({
  job_id: slurm,
  partition: "shared",
  state: "COMPLETED",
  elapsed_seconds: 1800,
  alloc_tres: tres(),
  submit: "2026-11-05T10:00:00",
  start: "2026-11-05T10:01:00",
  end: "2026-11-05T10:31:00",
  ...over,
});

/** The observer's own daily document with its partitions and jobs replaced. */
const daily = (jobs: Job[], partitions: Doc = {}): Doc => ({
  ...dailyFixture,
  partitions,
  accounting: {
    ...dailyFixture.accounting,
    rows_total: jobs.length,
    rows_included: jobs.length,
    jobs,
  },
});

/** The observer's own quick document with its partitions replaced. */
const quick = (partitions: Doc): Doc => ({ ...quickFixture, partitions });

const queue = (pending: number, running: number): Doc => ({
  available: "up",
  nodes: {},
  jobs: {
    ...(pending ? { PENDING: { jobs: pending, nodes: pending, cpus: pending } } : {}),
    ...(running ? { RUNNING: { jobs: running, nodes: running, cpus: running } } : {}),
  },
  pending_reasons: {},
});

/** A name the Worker stores for partition number `i` (letters only, all different). */
const partitionName = (i: number) => {
  let name = "";
  let n = i;
  do {
    name = String.fromCharCode(97 + (n % 26)) + name;
    n = Math.floor(n / 26);
  } while (n > 0);
  return `p${name}`;
};

async function mint(): Promise<{ runId: string; token: string }> {
  const owner = fx.ownerId;
  const minted = await mintObserverRun(env(), owner);
  if (!minted.ok) throw new Error("could not mint");
  return { runId: minted.runId, token: minted.token };
}

/** Post as the observer does: `Authorization: Bearer <token>` (none when `token` is null). */
async function post(token: string | null, body: unknown, raw?: string) {
  return postHeaders(token === null ? {} : { Authorization: `Bearer ${token}` }, body, raw);
}

async function postHeaders(extra: Record<string, string>, body: unknown, raw?: string) {
  const res = await routes(
    new Request("http://worker.test/compute/observer", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...extra },
      body: raw ?? JSON.stringify(body),
    }),
    env(),
  );
  return { status: res.status, text: await res.text() };
}

/** A valid document that stores one snapshot per partition of the observer's quick fixture and no job. */
const empty = quickFixture;

/** The shortest valid job, so thousands of them fit in 1 MiB (the bound the route documents). */
const minimalRow = (slurm: string) => acct(slurm, { submit: null, start: null, end: null });

async function counts() {
  const one = async (sql: string) =>
    ((await env().DB.prepare(sql).first<{ n: number }>())?.n ?? 0) as number;
  return {
    rows: await one("SELECT COUNT(*) AS n FROM compute_sacct_rows"),
    snaps: await one("SELECT COUNT(*) AS n FROM compute_queue_snapshots"),
    ledger: await one("SELECT COUNT(*) AS n FROM compute_ledger"),
    audit: await one("SELECT COUNT(*) AS n FROM audit_log"),
  };
}

describe("the token", () => {
  test("a wrong, an expired, a reused, an unknown, a tampered and a missing token get the same answer, and nothing is written (MUTATION: answer a reused token differently)", async () => {
    const good = await mint();
    const expired = await mint();
    // An hour has passed: the run was created before its expiry, and its expiry is behind us.
    fx.harness.db.run(
      "UPDATE compute_observer_runs SET created_at = datetime('now', '-61 minutes'), expires_at = datetime('now', '-1 minute') WHERE id = ?",
      [expired.runId],
    );
    const spent = await mint();
    expect((await post(spent.token, empty)).status).toBe(200);

    const before = await counts();
    const [runId = "", digest = ""] = good.token.split(".");
    const flipped = `${digest.slice(0, -1)}${digest.endsWith("0") ? "1" : "0"}`;
    const attempts = [
      null,
      "",
      "garbage",
      good.token.replace(".", ":"),
      `${runId}.${flipped}`,
      `11111111-2222-3333-4444-555555555555.${digest}`,
      `${runId}.${digest}.extra`,
      expired.token,
      spent.token,
    ];
    const answers = [];
    for (const token of attempts) answers.push(await post(token, empty));
    for (const a of answers) expect(a).toEqual(answers[0] as never);
    expect(answers[0]?.status).toBe(403);
    expect(JSON.parse(answers[0]?.text ?? "{}")).toEqual({
      error: "Not accepted.",
      code: "observer_refused",
    });
    // The good token was never spent by those, and the refusals wrote nothing.
    expect(await counts()).toEqual(before);
    expect((await post(good.token, empty)).status).toBe(200);
  });

  test("the token is bound to the run: another run's digest does not answer", async () => {
    const a = await mint();
    const b = await mint();
    const swapped = `${a.runId}.${b.token.split(".")[1]}`;
    expect((await post(swapped, empty)).status).toBe(403);
    expect((await post(a.token, empty)).status).toBe(200);
  });

  test("a run is spent by its one post: the second is refused", async () => {
    const run = await mint();
    expect((await post(run.token, empty)).status).toBe(200);
    expect((await post(run.token, empty)).status).toBe(403);
    const row = fx.harness.db
      .query("SELECT status FROM compute_observer_runs WHERE id = ?")
      .get(run.runId) as {
      status: string;
    };
    expect(row.status).toBe("ingested");
  });

  test("the token is checked BEFORE the body is read: a wrong or spent token with a body over 1 MiB gets the refusal, not 413 (MUTATION: accept a spent run at the door)", async () => {
    const run = await mint();
    expect((await post(run.token, empty)).status).toBe(200);
    const huge = JSON.stringify({ ...quickFixture, pad: "x".repeat(1_100_000) });
    const spent = await post(run.token, null, huge);
    const wrong = await post("garbage", null, huge);
    expect(spent).toEqual(wrong);
    expect(spent.status).toBe(403);
  });

  test("two posts racing on one token make one ingest (MUTATION: drop the `status = 'issued'` term)", async () => {
    const run = await mint();
    const body = daily([acct(nextSlurm())]);
    const [a, b] = await Promise.all([post(run.token, body), post(run.token, body)]);
    expect([a.status, b.status].sort()).toEqual([200, 403]);
    // The loser gets the one refusal body, the same as a wrong token, and says nothing of the race.
    const loser = a.status === 403 ? a : b;
    expect(JSON.parse(loser.text)).toEqual({ error: "Not accepted.", code: "observer_refused" });
    expect(loser).toEqual(await post("garbage", empty));
    expect((await counts()).rows).toBe(1);
  });
});

describe("the wire", () => {
  test("the token is read from `Authorization: Bearer` only: the old header, other schemes and a bare token are the one refusal and spend nothing (MUTATION: read X-Compute-Observer-Token again)", async () => {
    const good = await mint();
    const refusal = await post("garbage", empty);
    expect(refusal.status).toBe(403);
    const before = await counts();
    const attempts: Array<Record<string, string>> = [
      { "X-Compute-Observer-Token": good.token },
      { "X-Compute-Observer-Token": good.token, Authorization: "Bearer garbage" },
      { Authorization: good.token },
      { Authorization: `Basic ${good.token}` },
      { Authorization: `Token ${good.token}` },
      { Authorization: `Bearer  ${good.token}` },
      { Authorization: `Bearer ${good.token} extra` },
      { Authorization: "Bearer " },
      { Authorization: "Bearer" },
    ];
    for (const headers of attempts) {
      expect([JSON.stringify(Object.keys(headers)), await postHeaders(headers, empty)]).toEqual([
        JSON.stringify(Object.keys(headers)),
        refusal,
      ]);
    }
    expect(await counts()).toEqual(before);
    // The scheme is not case sensitive (RFC 9110, 11.1), and the unspent token still posts.
    expect((await postHeaders({ Authorization: `bearer ${good.token}` }, empty)).status).toBe(200);
  });

  test("observerBearerToken takes `Bearer <one token>` and nothing else", () => {
    expect(observerBearerToken("Bearer abc.def")).toBe("abc.def");
    expect(observerBearerToken("bearer abc")).toBe("abc");
    for (const bad of [
      undefined,
      "",
      "Bearer",
      "Bearer ",
      "Bearer a b",
      "Basic abc",
      "abc",
      " Bearer abc",
    ]) {
      expect([bad, observerBearerToken(bad)]).toEqual([bad, ""]);
    }
    expect(observerBearerToken(`Bearer ${"a".repeat(201)}`)).toBe("");
    expect(observerBearerToken(`Bearer ${"a".repeat(200)}`)).toBe("a".repeat(200));
  });

  test("the old body, {snapshots, sacct}, is not the document: 400, the run is not spent", async () => {
    const run = await mint();
    const old = await post(run.token, { snapshots: [], sacct: [] });
    expect(old.status).toBe(400);
    expect(JSON.parse(old.text).code).toBe("invalid_post");
    expect((await post(run.token, empty)).status).toBe(200);
  });

  test("a document whose `schema` is not exactly nemar.observation.v1 is the refusal of any malformed body, and the run is not spent", async () => {
    const run = await mint();
    for (const word of [
      "nemar.observation.v2",
      "nemar.observation.v1 ",
      "NEMAR.observation.v1",
      "",
    ]) {
      const bad = await post(run.token, { ...daily([acct(nextSlurm())]), schema: word });
      expect([word, bad.status]).toEqual([word, 400]);
      const answer = JSON.parse(bad.text);
      expect(answer).toEqual({
        error: "The post is not valid.",
        code: "invalid_post",
        fields: ["schema: invalid_literal"],
      });
    }
    const { schema: _omitted, ...none } = daily([acct(nextSlurm())]);
    expect((await post(run.token, none)).status).toBe(400);
    expect((await counts()).rows).toBe(0);
    expect((await post(run.token, daily([acct(nextSlurm())]))).status).toBe(200);
  });

  test("a mode the observer does not define is refused (there is no dry run): quick and daily are both live", async () => {
    const run = await mint();
    for (const mode of ["dry_run", "Daily", "weekly", ""]) {
      expect([mode, (await post(run.token, { ...quickFixture, mode })).status]).toEqual([
        mode,
        400,
      ]);
    }
    expect((await counts()).snaps).toBe(0);
    const quickPost = await post(run.token, quickFixture);
    expect(quickPost.status).toBe(200);
    expect(JSON.parse(quickPost.text)).toMatchObject({ snapshots: 4, sacct_rows: 0 });
    expect((await counts()).snaps).toBe(4);
    const dailyPost = await post((await mint()).token, dailyFixture);
    expect(JSON.parse(dailyPost.text)).toMatchObject({ snapshots: 4, sacct_rows: 3 });
    // The answer is the contract's, in snake_case throughout (the observer drops the body; a reader that
    // does not must not meet `sacctRows`).
    const answer = JSON.parse(dailyPost.text);
    expect(ComputeObserverIngestResponseSchema.safeParse(answer).success).toBe(true);
    expect(Object.keys(answer).filter((k) => /[A-Z]/.test(k))).toEqual([]);
  });

  test("a v1 document with a field the observer does not write is refused, at every level, and names the path, never the value", async () => {
    const withExtra = (path: string[], value: unknown = "secret-value"): Doc => {
      const doc = structuredClone(dailyFixture) as Record<string, any>;
      let cur = doc;
      for (const key of path) cur = cur[key];
      cur.surprise = value;
      return doc;
    };
    const bad: Array<[string, Doc, string]> = [
      ["top", withExtra([]), "body: unrecognized_keys"],
      ["partition", withExtra(["partitions", "shared"]), "partitions.<key>: unrecognized_keys"],
      ["sources", withExtra(["sources"]), "sources: unrecognized_keys"],
      ["accounting", withExtra(["accounting"]), "accounting: unrecognized_keys"],
      ["job", withExtra(["accounting", "jobs", "0"]), "accounting.jobs.0: unrecognized_keys"],
      ["balance", withExtra(["balance", "expanse"]), "balance.expanse"],
    ];
    for (const [label, doc, field] of bad) {
      const run = await mint();
      const res = await post(run.token, doc);
      expect([label, res.status]).toEqual([label, 400]);
      expect(res.text).not.toContain("secret-value");
      expect(res.text).not.toContain("surprise");
      expect(JSON.parse(res.text).fields.join(" ")).toContain(field.split(":")[0] as string);
      expect((await post(run.token, daily([acct(nextSlurm())]))).status).toBe(200);
    }
    expect(
      JSON.parse((await post((await mint()).token, { ...dailyFixture, snapshots: [] })).text).code,
    ).toBe("invalid_post");
  });

  test("a wrong type, a negative number and a state with a trailing note are each refused", async () => {
    const jobs: Job[] = [
      acct(nextSlurm(), { elapsed_seconds: "600" }),
      acct(nextSlurm(), { elapsed_seconds: -1 }),
      acct(nextSlurm(), { elapsed_seconds: 1.5 }),
      acct(nextSlurm(), { state: "CANCELLED by 1234" }),
      acct(nextSlurm(), { state: "A".repeat(33) }),
      acct(nextSlurm(), { state: "RUNNING;DROP" }),
      acct(nextSlurm(), { state: "" }),
      acct(nextSlurm(), { job_id: "12;DROP" }),
      acct(nextSlurm(), { alloc_tres: { cpu: 4 } }),
      acct(nextSlurm(), { alloc_tres: "cpu=4,mem=8G" }),
      acct(nextSlurm(), { submit: "yesterday" }),
    ];
    for (const job of jobs) {
      const run = await mint();
      const res = await post(run.token, daily([job]));
      expect([JSON.stringify(job), res.status]).toEqual([JSON.stringify(job), 400]);
      expect(res.text).not.toContain("DROP");
    }
    expect((await counts()).rows).toBe(0);
  });

  test("a refusal never echoes a key the sender chose: partitions, states, reasons and allocation items are <key> (MUTATION: print the path as it is)", async () => {
    const secret = "SECRET-VALUE";
    const bad = (doc: Doc) => doc;
    const cases: Array<[string, Doc, string]> = [
      [
        "a partition name",
        bad({ ...quickFixture, partitions: { [`bad key ${secret}`]: queue(1, 1) } }),
        "partitions.<key>: invalid_string",
      ],
      [
        "a job state key",
        bad({
          ...quickFixture,
          partitions: {
            shared: { ...queue(1, 1), jobs: { [`bad ${secret}`]: { jobs: 1, nodes: 1, cpus: 1 } } },
          },
        }),
        "partitions.<key>.jobs.<key>",
      ],
      [
        "a node state key",
        bad({
          ...quickFixture,
          partitions: { shared: { ...queue(1, 1), nodes: { [`BAD ${secret}`]: 1 } } },
        }),
        "partitions.<key>.nodes.<key>",
      ],
      [
        "a pending reason",
        bad({
          ...quickFixture,
          partitions: { shared: { ...queue(1, 1), pending_reasons: { [`bad ${secret}`]: 1 } } },
        }),
        "partitions.<key>.pending_reasons.<key>",
      ],
      [
        "an allocation item",
        daily([acct(nextSlurm(), { alloc_tres: { [`k${secret}`]: 5 } })]),
        "accounting.jobs.0.alloc_tres.<key>: invalid_type",
      ],
      [
        "a key in an unknown place",
        bad({ ...quickFixture, [secret]: 1 }),
        "body: unrecognized_keys",
      ],
    ];
    for (const [label, doc, field] of cases) {
      const run = await mint();
      const res = await post(run.token, doc);
      expect([label, res.status]).toEqual([label, 400]);
      expect([label, res.text.includes(secret)]).toEqual([label, false]);
      expect([label, JSON.parse(res.text).fields.join(" ")]).toEqual([
        label,
        expect.stringContaining(field),
      ]);
      expect((await counts()).rows).toBe(0);
    }
  });

  test("at most five paths are listed in `fields`, from the document and from the mapping", async () => {
    const run = await mint();
    const many = await post(
      run.token,
      daily(Array.from({ length: 8 }, () => acct(nextSlurm(), { elapsed_seconds: "x" }))),
    );
    expect(many.status).toBe(400);
    expect(JSON.parse(many.text).fields).toHaveLength(5);
    const mapped = await post(
      run.token,
      daily(
        Array.from({ length: 8 }, () =>
          acct(nextSlurm(), { alloc_tres: tres(4, { cpu: "four" }) }),
        ),
      ),
    );
    expect(mapped.status).toBe(400);
    expect(JSON.parse(mapped.text).fields).toEqual(
      [0, 1, 2, 3, 4].map((i) => `accounting.jobs.${i}.alloc_tres: malformed_tres`),
    );
    expect((await post(run.token, daily([acct(nextSlurm())]))).status).toBe(200);
  });

  test("a body that fails validation does not spend the run, and names the field, never the value", async () => {
    const run = await mint();
    const bad = await post(run.token, daily([acct("12;DROP", { partition: "Shared!" })]));
    expect(bad.status).toBe(400);
    expect(bad.text).not.toContain("DROP");
    expect(JSON.parse(bad.text).code).toBe("invalid_post");
    expect((await counts()).rows).toBe(0);
    // Still unspent.
    expect((await post(run.token, daily([acct(nextSlurm())]))).status).toBe(200);
  });
});

describe("the allocation string", () => {
  const refusedFor = async (job: Job, field = "accounting.jobs.0.alloc_tres: malformed_tres") => {
    const run = await mint();
    const before = await counts();
    const res = await post(run.token, daily([job, acct(nextSlurm())]));
    expect([JSON.stringify(job.alloc_tres), res.status]).toEqual([
      JSON.stringify(job.alloc_tres),
      400,
    ]);
    expect(JSON.parse(res.text)).toEqual({
      error: "The post is not valid.",
      code: "invalid_post",
      fields: [field],
    });
    // Nothing of the post is stored, not the good job beside it either, and the run is unspent.
    expect(await counts()).toEqual(before);
    expect(
      (
        fx.harness.db
          .query("SELECT status FROM compute_observer_runs WHERE id = ?")
          .get(run.runId) as { status: string }
      ).status,
    ).toBe("issued");
    return res;
  };

  test("a malformed alloc_tres is refused, settles nothing, and does not spend the run (MUTATION: make parseAllocTres guess)", async () => {
    const j = await endedJob(30);
    const slurm = j.job.slurm_job_id as string;
    const before = await reread(j.env, j.job.id);
    for (const bad of [
      tres(4, { cpu: "four" }),
      tres(4, { cpu: "4.5" }),
      tres(4, { cpu: "-1" }),
      tres(4, { mem: "8000" }),
      tres(4, { mem: "8 GB" }),
      tres(4, { mem: "lots" }),
      tres(4, { node: "one" }),
      tres(4, { "gres/gpu": "x" }),
      tres(4, { cpu: "99999999999999" }),
    ]) {
      const res = await refusedFor(acct(slurm, { alloc_tres: bad, state: "COMPLETED" }));
      for (const text of Object.values(bad)) expect(res.text).not.toContain(`"${text}"`);
    }
    expect(await reread(j.env, j.job.id)).toEqual(before);
  });

  test("elapsed time with no cpu item or no node item is refused; no allocation at all with no elapsed time is stored", async () => {
    await refusedFor(
      acct(nextSlurm(), { alloc_tres: { billing: "4", mem: "8000M", node: "1" } }),
      "accounting.jobs.0.alloc_tres: missing_cpu",
    );
    await refusedFor(
      acct(nextSlurm(), { alloc_tres: {} }),
      "accounting.jobs.0.alloc_tres: missing_cpu",
    );
    // No node item with time is refused too (MUTATION: store it with nodes 0, which prices as one node).
    await refusedFor(
      acct(nextSlurm(), { alloc_tres: { cpu: "4", mem: "8000M", "gres/gpu": "1" } }),
      "accounting.jobs.0.alloc_tres: missing_node",
    );
    // No node item and no time is stored: a cancelled-before-start job with a cpu item and no node.
    const idle = nextSlurm();
    const idleRun = await mint();
    expect(
      (
        await post(
          idleRun.token,
          daily([acct(idle, { state: "CANCELLED", elapsed_seconds: 0, alloc_tres: { cpu: "4" } })]),
        )
      ).status,
    ).toBe(200);
    expect(
      fx.harness.db
        .query("SELECT alloc_nodes, alloc_cpus FROM compute_sacct_rows WHERE slurm_job_id = ?")
        .get(idle),
    ).toEqual({ alloc_nodes: 0, alloc_cpus: 4 });
    // A job that was cancelled before it started has no allocation and no time: Slurm's own empty string.
    const run = await mint();
    const slurm = nextSlurm();
    const res = await post(
      run.token,
      daily([acct(slurm, { state: "CANCELLED", elapsed_seconds: 0, alloc_tres: {} })]),
    );
    expect(res.status).toBe(200);
    expect(
      fx.harness.db
        .query(
          "SELECT alloc_cpus, alloc_mem_mb, alloc_gpus, alloc_nodes FROM compute_sacct_rows WHERE slurm_job_id = ?",
        )
        .get(slurm),
    ).toEqual({ alloc_cpus: 0, alloc_mem_mb: 0, alloc_gpus: 0, alloc_nodes: 0 });
  });

  test("only a row of ours is read: a malformed allocation on a row that is skipped anyway is not a refusal", async () => {
    const run = await mint();
    const res = await post(
      run.token,
      daily([acct("123_[1-5]", { alloc_tres: { cpu: "four" } }), acct(nextSlurm())]),
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toMatchObject({ sacct_rows: 1, skipped: 1 });
  });
});

describe("the mapping from the document to the rows", () => {
  test("the observer's own daily document is stored as this table says, and charged_milli is NULL", async () => {
    const run = await mint();
    const res = await post(run.token, dailyFixture);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toMatchObject({
      snapshots: 4,
      sacct_rows: 3,
      skipped: 0,
      unmatched: 3,
    });
    expect(
      fx.harness.db
        .query(
          `SELECT slurm_job_id, partition, state, elapsed_seconds, alloc_nodes, alloc_cpus, alloc_gpus,
                  alloc_mem_mb, submit_time, start_time, end_time, charged_milli
             FROM compute_sacct_rows ORDER BY slurm_job_id`,
        )
        .all(),
    ).toEqual([
      // cpu=8 mem=16G node=1; "5002" below is "CANCELLED by 1234" reduced to its first word by the observer
      {
        slurm_job_id: "5001",
        partition: "shared",
        state: "COMPLETED",
        elapsed_seconds: 3723,
        alloc_nodes: 1,
        alloc_cpus: 8,
        alloc_gpus: 0,
        alloc_mem_mb: 16384,
        submit_time: "2026-11-03T10:00:00",
        start_time: "2026-11-03T10:05:00",
        end_time: "2026-11-03T11:07:03",
        charged_milli: null,
      },
      // cpu=10 gres/gpu=1 mem=92G node=1
      {
        slurm_job_id: "5002",
        partition: "gpu",
        state: "CANCELLED",
        elapsed_seconds: 10,
        alloc_nodes: 1,
        alloc_cpus: 10,
        alloc_gpus: 1,
        alloc_mem_mb: 94208,
        submit_time: "2026-11-03T12:00:00",
        start_time: "2026-11-03T12:01:00",
        end_time: "2026-11-03T12:01:10",
        charged_milli: null,
      },
      // cpu=256 mem=500G node=2; Slurm printed Unknown for the start and the end
      {
        slurm_job_id: "5003",
        partition: "compute",
        state: "FAILED",
        elapsed_seconds: 93600,
        alloc_nodes: 2,
        alloc_cpus: 256,
        alloc_gpus: 0,
        alloc_mem_mb: 512000,
        submit_time: "2026-11-03T13:00:00",
        start_time: null,
        end_time: null,
        charged_milli: null,
      },
    ]);
    // The queue: the fixture's squeue gave shared 3 pending 2 running, gpu 1 pending, compute 1 running.
    expect(
      fx.harness.db
        .query("SELECT partition, pending, running FROM compute_queue_snapshots ORDER BY partition")
        .all(),
    ).toEqual([
      { partition: "compute", pending: 0, running: 1 },
      { partition: "debug", pending: 0, running: 0 },
      { partition: "gpu", pending: 1, running: 0 },
      { partition: "shared", pending: 3, running: 2 },
    ]);
  });

  test("queue snapshots are stored once per partition for the run: PENDING and RUNNING job counts, zero for a state that is absent", async () => {
    const run = await mint();
    const res = await post(
      run.token,
      quick({ shared: queue(3, 9), "gpu-shared": queue(0, 2), "large-shared": queue(0, 0) }),
    );
    expect(res.status).toBe(200);
    const rows = fx.harness.db
      .query("SELECT partition, pending, running FROM compute_queue_snapshots ORDER BY partition")
      .all();
    expect(rows).toEqual([
      { partition: "gpu-shared", pending: 0, running: 2 },
      { partition: "large-shared", pending: 0, running: 0 },
      { partition: "shared", pending: 3, running: 9 },
    ]);
    expect(JSON.parse(res.text)).toMatchObject({ snapshots: 3, skipped: 0 });
  });

  test("a partition whose queue was not read is skipped and counted, never stored as zero; so is a name the table cannot hold (MUTATION: store null as 0)", async () => {
    const run = await mint();
    const res = await post(
      run.token,
      quick({
        shared: queue(1, 1),
        gpu: { available: null, nodes: null, jobs: null, pending_reasons: null },
        Shared2: queue(1, 1),
        "a,b": queue(1, 1),
      }),
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toMatchObject({ snapshots: 1, skipped: 3 });
    expect(fx.harness.db.query("SELECT partition FROM compute_queue_snapshots").all()).toEqual([
      { partition: "shared" },
    ]);
  });

  test("a valid row that no table of ours can hold is skipped and counted, and the rest of the day still lands", async () => {
    const good = nextSlurm();
    const run = await mint();
    const res = await post(
      run.token,
      daily([
        acct("123_[1-5]"),
        acct("123_4", { state: "RUNNING", elapsed_seconds: 5 }),
        acct(nextSlurm(), { partition: null }),
        acct(nextSlurm(), { state: null }),
        acct(nextSlurm(), { elapsed_seconds: null }),
        acct(nextSlurm(), { state: "completed" }),
        acct(nextSlurm(), { partition: "Shared" }),
        acct(nextSlurm(), { elapsed_seconds: 31_536_001 }),
        acct(good),
      ]),
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toMatchObject({ sacct_rows: 2, skipped: 7 });
    expect(
      fx.harness.db
        .query("SELECT slurm_job_id FROM compute_sacct_rows ORDER BY slurm_job_id")
        .all(),
    ).toEqual([{ slurm_job_id: "123_4" }, { slurm_job_id: good }]);
  });

  test("a truncated export says so in the answer", async () => {
    const doc = daily([acct(nextSlurm())]) as { accounting: Record<string, unknown> };
    doc.accounting.truncated = true;
    doc.accounting.rows_total = 9000;
    const res = await post((await mint()).token, doc);
    expect(JSON.parse(res.text)).toMatchObject({ ok: true, truncated: true, sacct_rows: 1 });
    expect(ComputeObserverIngestResponseSchema.safeParse(JSON.parse(res.text)).success).toBe(true);
    const plain = await post((await mint()).token, daily([acct(nextSlurm())]));
    expect(JSON.parse(plain.text).truncated).toBeUndefined();
  });

  test("a daily document whose sacct was not read has no jobs and still stores the queue", async () => {
    const doc = {
      ...dailyFixture,
      accounting: null,
      sources: { ...dailyFixture.sources, sacct: { status: "failed", detail: "exit_1" } },
    };
    const res = await post((await mint()).token, doc);
    expect(JSON.parse(res.text)).toMatchObject({ snapshots: 4, sacct_rows: 0 });
  });

  test("nothing of the token or the document's text reaches the logs", async () => {
    const lines: string[] = [];
    const log = console.log;
    const error = console.error;
    const record = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    console.log = record;
    console.error = record;
    try {
      const run = await mint();
      await post(run.token, dailyFixture);
      await post(run.token, dailyFixture);
      await post("garbage", dailyFixture);
    } finally {
      console.log = log;
      console.error = error;
    }
    const all = lines.join("\n");
    expect(all).toContain("[compute-observer] ingested mode=daily");
    for (const secret of ["Bearer", "5001", "prj001", "shared"]) expect(all).not.toContain(secret);
  });
});

describe("the body", () => {
  test("more than 5,000 rows is refused, and so is a body over 1 MiB; neither spends the run", async () => {
    const run = await mint();
    const many = (n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [partitionName(i), queue(1, 1)]));
    const tooMany = await post(run.token, quick(many(OBSERVER_ROWS_MAX + 1)));
    expect(tooMany.status).toBe(400);
    expect(JSON.parse(tooMany.text).fields.join(" ")).toContain("partitions");
    // Partitions and jobs count together.
    const mixed = daily([minimalRow("1"), minimalRow("2")], many(OBSERVER_ROWS_MAX - 1));
    const together = await post(run.token, mixed);
    expect(together.status).toBe(400);
    expect(JSON.parse(together.text).fields).toEqual(["body: too_big"]);
    const huge = await post(
      run.token,
      null,
      JSON.stringify({ ...quickFixture, pad: "x".repeat(1_100_000) }),
    );
    expect(huge.status).toBe(413);
    expect((await counts()).rows).toBe(0);
    expect((await post(run.token, empty)).status).toBe(200);
  });

  test("exactly 5,000 rows is accepted; thousands of Slurm rows are stored; a repeated Slurm id keeps the first", async () => {
    const exact = await post(
      (await mint()).token,
      quick(
        Object.fromEntries(
          Array.from({ length: OBSERVER_ROWS_MAX }, (_, i) => [partitionName(i), queue(1, 1)]),
        ),
      ),
    );
    expect(exact.status).toBe(200);
    expect((await counts()).snaps).toBe(OBSERVER_ROWS_MAX);
    // 1 MiB admits about 5,000 of the shortest jobs, so 4,000 is the volume tested.
    const rows = Array.from({ length: 4000 }, (_, i) =>
      minimalRow(`9${String(i).padStart(7, "0")}`),
    );
    expect((await post((await mint()).token, daily(rows))).status).toBe(200);
    expect((await counts()).rows).toBe(4000);
    const again = await mint();
    await post(again.token, daily([acct("90000000", { elapsed_seconds: 5 })]));
    const kept = fx.harness.db
      .query("SELECT elapsed_seconds FROM compute_sacct_rows WHERE slurm_job_id = '90000000'")
      .get() as { elapsed_seconds: number };
    expect(kept.elapsed_seconds).toBe(1800);
  }, 60_000);
});

describe("final settlement", () => {
  test("a row within tolerance settles silently to Expanse's figure and sets no flag", async () => {
    const j = await endedJob(30);
    expect(j.job.charged_milli).toBe(2000);
    const run = await mint();
    // Four cores for 37.5 minutes is 2.5 SU: the document carries the allocation and the time, and the
    // Worker prices them.
    const res = await post(
      run.token,
      daily([acct(j.job.slurm_job_id as string, { elapsed_seconds: 2250 })]),
    );
    expect(res.status).toBe(200);
    const after = await reread(j.env, j.job.id);
    expect(after.settled_final_at).not.toBeNull();
    expect(after.charged_milli).toBe(2500);
    expect(after.flag_mismatch).toBe(0);
    const kinds = (
      await j.env.DB.prepare("SELECT kind, reason FROM compute_ledger WHERE job_id = ? ORDER BY id")
        .bind(j.job.id)
        .all<{ kind: string; reason: string | null }>()
    ).results;
    expect(kinds.map((k) => k.kind)).toEqual(["hold", "charge", "adjust"]);
    expect(kinds[2]?.reason).toBe("final_settlement");
    expect(JSON.parse(res.text)).toMatchObject({ settled: 1, mismatched: 0 });
  });

  test("a row beyond tolerance sets flag_mismatch and STILL settles to Expanse's figure (MUTATION: the tolerance test always true)", async () => {
    const j = await endedJob(30);
    const run = await mint();
    // Twelve cores for half an hour is 6 SU.
    await post(run.token, daily([acct(j.job.slurm_job_id as string, { alloc_tres: tres(12) })]));
    const after = await reread(j.env, j.job.id);
    expect(after.charged_milli).toBe(6000);
    expect(after.settled_final_at).not.toBeNull();
    expect(after.flag_mismatch).toBe(1);
  });

  test("the tolerance is the policy's: milli-SU or a percentage of the provisional charge", () => {
    const settle = DEFAULT_COMPUTE_POLICY.settle;
    expect(settle).toEqual({ toleranceMilli: 1000, tolerancePercent: 5 });
    expect(isRoutineDifference(2000, 2000, settle)).toBe(true);
    expect(isRoutineDifference(3000, 2000, settle)).toBe(true);
    expect(isRoutineDifference(3001, 2000, settle)).toBe(false);
    // 5% of 100,000 is 5,000: beyond 1,000 milli-SU but within the percentage.
    expect(isRoutineDifference(105_000, 100_000, settle)).toBe(true);
    expect(isRoutineDifference(105_001, 100_000, settle)).toBe(false);
    expect(isRoutineDifference(94_999, 100_000, settle)).toBe(false);
    expect(isRoutineDifference(0, 0, settle)).toBe(true);
    expect(isRoutineDifference(1001, 0, settle)).toBe(false);
  });

  test("the Worker prices the allocation the row reports, whatever Tapis said", async () => {
    const j = await endedJob(30);
    const run = await mint();
    // 8 cores for an hour is 8 SU.
    await post(
      run.token,
      daily([acct(j.job.slurm_job_id as string, { alloc_tres: tres(8), elapsed_seconds: 3600 })]),
    );
    const after = await reread(j.env, j.job.id);
    expect(after.charged_milli).toBe(8000);
    expect(after.flag_mismatch).toBe(1);
  });

  test("every state in which a job has ended settles it, and the first word of Slurm's state is all the document carries (MUTATION: drop a state from the ended list)", async () => {
    for (const state of [
      "COMPLETED",
      "FAILED",
      "CANCELLED",
      "TIMEOUT",
      "OUT_OF_MEMORY",
      "NODE_FAIL",
    ]) {
      await fx.reset();
      const j = await endedJob(30);
      const run = await mint();
      const res = await post(
        run.token,
        daily([acct(j.job.slurm_job_id as string, { state, elapsed_seconds: 2070 })]),
      );
      expect([state, res.status]).toEqual([state, 200]);
      const after = await reread(j.env, j.job.id);
      expect([state, after.settled_final_at !== null, after.charged_milli]).toEqual([
        state,
        true,
        2300,
      ]);
      const stored = fx.harness.db.query("SELECT state FROM compute_sacct_rows").get() as {
        state: string;
      };
      expect(stored.state).toBe(state);
    }
  }, 60_000);

  test("a multi-node allocation is priced per node: the row's totals are divided by its nodes (MUTATION: do not divide)", () => {
    const base = {
      slurm_job_id: "1",
      sacct_partition: "shared",
      elapsed_seconds: 3600,
      alloc_nodes: 2,
      alloc_cpus: 8,
      alloc_gpus: 0,
      alloc_mem_mb: 0,
      sacct_charged: null,
      job_id: "job_0123456789abcdef01234567",
      job_partition: "shared",
      provisional_milli: 0,
    };
    // Two nodes of four cores for an hour is eight core-hours.
    expect(expanseFigureMilli(base)).toBe(8000);
    // Three cores over two nodes round up to two a node, so four in all.
    expect(expanseFigureMilli({ ...base, alloc_cpus: 3 })).toBe(4000);
    // Memory is a total too: 2 x 92 GB nodes' worth over two nodes, priced per GPU unit on a GPU partition.
    expect(
      expanseFigureMilli({
        ...base,
        sacct_partition: "gpu-shared",
        alloc_cpus: 0,
        alloc_gpus: 4,
      }),
    ).toBe(4000);
    // The row's own figure wins, and an unknown partition falls back to the job's.
    expect(expanseFigureMilli({ ...base, sacct_charged: 123 })).toBe(123);
    expect(expanseFigureMilli({ ...base, sacct_partition: "weird" })).toBe(8000);
    expect(
      expanseFigureMilli({ ...base, sacct_partition: "weird", job_partition: "weird" }),
    ).toBeNull();
  });

  test("a final figure below the charge lowers the person's pool and the budget together, and the totals hold", async () => {
    const j = await endedJob(30);
    const before = await j.env.DB.prepare(
      "SELECT holder_kind, holder_ref, charged_milli FROM compute_pools ORDER BY id",
    ).all<{ holder_kind: string; holder_ref: string; charged_milli: number }>();
    const run = await mint();
    // Four cores for 22.5 minutes is 1.5 SU.
    await post(run.token, daily([acct(j.job.slurm_job_id as string, { elapsed_seconds: 1350 })]));
    const after = await j.env.DB.prepare(
      "SELECT holder_kind, holder_ref, charged_milli FROM compute_pools ORDER BY id",
    ).all<{ holder_kind: string; holder_ref: string; charged_milli: number }>();
    const delta = after.results.map(
      (p, i) => p.charged_milli - (before.results[i]?.charged_milli ?? 0),
    );
    // The person's pool and the people budget each fell by 500; nothing else moved.
    expect(delta.filter((d) => d !== 0).sort()).toEqual([-500, -500]);
    const sums = await j.env.DB.prepare(
      `SELECT p.id, p.charged_milli AS stored, COALESCE((SELECT SUM(l.charged_delta_milli) FROM compute_ledger l
          WHERE l.pool_id = p.id OR l.budget_pool_id = p.id), 0) AS summed FROM compute_pools p`,
    ).all<{ stored: number; summed: number }>();
    for (const s of sums.results) expect(s.stored).toBe(s.summed);
  });

  test("a row whose job has not ended waits, and the next pass settles it once the job ends", async () => {
    const made = await makeJob(fx);
    await submitComputeJob(made.env, made.job.id);
    const uuid = (await reread(made.env, made.job.id)).tapis_uuid as string;
    fx.tapis.advance(uuid, "QUEUED");
    fx.tapis.advance(uuid, "RUNNING");
    await advanceComputeJob(made.env, made.job.id);
    const slurm = await numberSlurm(made.env, made.job.id);
    const run = await mint();
    const res = await post(run.token, daily([acct(slurm)]));
    expect(JSON.parse(res.text)).toMatchObject({ matched: 1, settled: 0 });
    expect((await reread(made.env, made.job.id)).settled_final_at).toBeNull();
    // The job ends afterwards.
    await playLauncher(fx, made.env, await reread(made.env, made.job.id), uuid, {});
    fx.tapis.advance(uuid, "FINISHED");
    setTapisTimes(fx, uuid, 30 * MINUTE, 0);
    await advanceComputeJob(made.env, made.job.id);
    const pass = await settleObservedRows(made.env);
    expect(pass.settled).toBe(1);
    expect((await reread(made.env, made.job.id)).settled_final_at).not.toBeNull();
    // And it is judged once: a later pass settles nothing more.
    expect((await settleObservedRows(made.env)).settled).toBe(0);
  });

  test("a job first seen RUNNING is finalized when a later export says COMPLETED (MUTATION: keep the first row)", async () => {
    const j = await endedJob(30);
    const slurm = j.job.slurm_job_id as string;
    const first = await mint();
    await post(first.token, daily([acct(slurm, { state: "RUNNING", elapsed_seconds: 60 })]));
    expect((await reread(j.env, j.job.id)).settled_final_at).toBeNull();
    const second = await mint();
    const res = await post(
      second.token,
      daily([acct(slurm, { state: "COMPLETED", elapsed_seconds: 2070 })]),
    );
    expect(JSON.parse(res.text)).toMatchObject({ settled: 1 });
    const after = await reread(j.env, j.job.id);
    expect(after.settled_final_at).not.toBeNull();
    expect(after.charged_milli).toBe(2300);
    // And a later export does not rewrite a row that is ended and applied.
    const third = await mint();
    await post(third.token, daily([acct(slurm, { elapsed_seconds: 9000 })]));
    expect((await reread(j.env, j.job.id)).charged_milli).toBe(2300);
  });

  test("a row for a job still pending or running at Slurm is not Expanse's figure yet", async () => {
    const j = await endedJob(30);
    const run = await mint();
    await post(
      run.token,
      daily([acct(j.job.slurm_job_id as string, { state: "RUNNING", alloc_tres: tres(100) })]),
    );
    expect((await reread(j.env, j.job.id)).settled_final_at).toBeNull();
  });

  test("a job that skipped the reservation has no hold to correct: its row is matched and listed, never settled", async () => {
    const j = await endedJob(30);
    await j.env.DB.prepare("UPDATE compute_jobs SET flag_unreserved = 1 WHERE id = ?")
      .bind(j.job.id)
      .run();
    const run = await mint();
    await post(run.token, daily([acct(j.job.slurm_job_id as string, { alloc_tres: tres(18) })]));
    const after = await reread(j.env, j.job.id);
    expect(after.settled_final_at).toBeNull();
    const row = fx.harness.db
      .query("SELECT matched_job_id, applied_at FROM compute_sacct_rows WHERE slurm_job_id = ?")
      .get(j.job.slurm_job_id) as { matched_job_id: string | null; applied_at: string | null };
    expect(row.matched_job_id).toBe(j.job.id);
    expect(row.applied_at).toBeNull();
  });

  test("an unpriceable row is flagged once and judged, so it is not tried for ever", async () => {
    const j = await endedJob(30);
    const run = await mint();
    // An allocation of no cores and no memory: Slurm printed the items, and both are zero.
    await post(
      run.token,
      daily([
        acct(j.job.slurm_job_id as string, {
          partition: "weird",
          alloc_tres: { cpu: "0", mem: "0", node: "1" },
        }),
      ]),
    );
    // The job's own partition prices (shared) but with no cores or memory the rate needs one: unpriceable.
    const after = await reread(j.env, j.job.id);
    expect(after.flag_mismatch).toBe(1);
    expect(after.settled_final_at).toBeNull();
    const row = fx.harness.db
      .query("SELECT applied_at FROM compute_sacct_rows WHERE slurm_job_id = ?")
      .get(j.job.slurm_job_id) as { applied_at: string | null };
    expect(row.applied_at).not.toBeNull();
  });
});

describe("a failure partway through a post", () => {
  /** The database with its `batch` failing once (a store that dies after the run was spent). */
  function failingBatch(): Bindings {
    const real = env().DB;
    let failed = false;
    const db = new Proxy(real, {
      get(target, prop) {
        if (prop === "batch") {
          return async (statements: unknown[]) => {
            if (!failed) {
              failed = true;
              throw new Error("D1 went away");
            }
            return (target as unknown as { batch(s: unknown[]): Promise<unknown> }).batch(
              statements,
            );
          };
        }
        const value = (target as unknown as Record<string | symbol, unknown>)[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return fx.env({ DB: db });
  }

  const postWith = async (e: Bindings, token: string, body: unknown) => {
    const res = await routes(
      new Request("http://worker.test/compute/observer", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      }),
      e,
    );
    return { status: res.status, text: await res.text() };
  };

  test("a store that fails leaves the run re-postable, and the same token then posts once (MUTATION: leave the run spent)", async () => {
    const run = await mint();
    const body = daily([acct(nextSlurm()), acct(nextSlurm())]);
    const failed = await postWith(failingBatch(), run.token, body);
    expect(failed.status).toBe(500);
    const status = () =>
      (
        fx.harness.db
          .query("SELECT status FROM compute_observer_runs WHERE id = ?")
          .get(run.runId) as { status: string }
      ).status;
    expect(status()).toBe("issued");
    expect((await postWith(env(), run.token, body)).status).toBe(200);
    expect(status()).toBe("ingested");
    expect((await counts()).rows).toBe(2);
    // And it is spent now.
    expect((await postWith(env(), run.token, body)).status).toBe(403);
  });

  test("a settlement that fails after the rows are stored does not fail the post; the daily pass settles them", async () => {
    const j = await endedJob(30);
    const run = await mint();
    const real = env().DB;
    const db = new Proxy(real, {
      get(target, prop) {
        if (prop !== "prepare") {
          const value = (target as unknown as Record<string | symbol, unknown>)[prop];
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (sql: string) => {
          if (!sql.includes("FROM compute_sacct_rows s JOIN compute_jobs j"))
            return target.prepare(sql);
          const broken: Record<string, unknown> = {
            bind: () => broken,
            all: async () => {
              throw new Error("settlement store down");
            },
          };
          return broken;
        };
      },
    });
    // Four cores for 33 minutes is 2.2 SU.
    const res = await postWith(
      fx.env({ DB: db }),
      run.token,
      daily([acct(j.job.slurm_job_id as string, { elapsed_seconds: 1980 })]),
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text)).toMatchObject({
      settlement_failed: true,
      sacct_rows: 1,
      settled: 0,
    });
    expect(ComputeObserverIngestResponseSchema.safeParse(JSON.parse(res.text)).success).toBe(true);
    expect(res.text).not.toContain("store down");
    expect((await counts()).rows).toBe(1);
    expect((await reread(j.env, j.job.id)).settled_final_at).toBeNull();
    expect((await settleObservedRows(j.env)).settled).toBe(1);
  });
});

describe("rows that match no job", () => {
  test("are stored with no match and listed, with a total", async () => {
    const run = await mint();
    await post(run.token, daily([acct("77001"), acct("77002", { state: "FAILED" })]));
    const listed = await listUnmatchedSacct(env().DB, 50);
    expect(listed.total).toBe(2);
    expect(listed.rows.map((r) => r.slurm_job_id).sort()).toEqual(["77001", "77002"]);
    expect(JSON.parse((await post((await mint()).token, empty)).text)).toMatchObject({
      unmatched: 0,
    });
  });

  test("the admin list shows them through the route, to an administrator and to no member", async () => {
    await seedComputeUsers(fx.harness.db);
    const run = await mint();
    await post(run.token, daily([acct("77003")]));
    const ask = (key: string) =>
      adminApp(
        new Request("http://worker.test/admin/compute/jobs?unmatched=1", {
          headers: { Authorization: `Bearer ${key}` },
        }),
        env(),
      );
    const ok = await ask(COMPUTE_KEYS.admin);
    expect(ok.status).toBe(200);
    expect(
      ((await ok.json()) as { rows: Array<{ slurm_job_id: string }> }).rows[0]?.slurm_job_id,
    ).toBe("77003");
    expect((await ask(COMPUTE_KEYS.member)).status).toBe(403);
  });
});

describe("minting", () => {
  test("an administrator mints a one-hour run, audited, and the token is shown once", async () => {
    await seedComputeUsers(fx.harness.db);
    const res = await adminApp(
      new Request("http://worker.test/admin/compute/observer-runs", {
        method: "POST",
        headers: { Authorization: `Bearer ${COMPUTE_KEYS.admin}` },
      }),
      env(),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      run_id: string;
      token: string;
      expires_in_minutes: number;
    };
    expect(body.expires_in_minutes).toBe(60);
    expect(body.token.startsWith(`${body.run_id}.`)).toBe(true);
    // The token is not stored: only the run and its nonce are.
    const stored = JSON.stringify(fx.harness.db.query("SELECT * FROM compute_observer_runs").all());
    expect(stored).not.toContain(body.token.split(".")[1] as string);
    const audit = fx.harness.db
      .query("SELECT action, resource_id FROM audit_log WHERE action = 'compute.observer.mint'")
      .all() as Array<{ action: string; resource_id: string }>;
    expect(audit).toEqual([{ action: "compute.observer.mint", resource_id: body.run_id }]);
    // And the minted token posts.
    expect((await post(body.token, empty)).status).toBe(200);
  });

  test("a member cannot mint, and with no callback secret nothing is minted", async () => {
    await seedComputeUsers(fx.harness.db);
    const member = await adminApp(
      new Request("http://worker.test/admin/compute/observer-runs", {
        method: "POST",
        headers: { Authorization: `Bearer ${COMPUTE_KEYS.member}` },
      }),
      env(),
    );
    expect(member.status).toBe(403);
    const none = await mintObserverRun(
      fx.env({ PRESCREEN_CALLBACK_SECRET: undefined }),
      fx.ownerId,
    );
    expect(none).toEqual({ ok: false, code: "unconfigured" });
    expect(fx.harness.db.query("SELECT COUNT(*) AS n FROM compute_observer_runs").get()).toEqual({
      n: 0,
    });
  });
});

describe("migration 0118", () => {
  const run = (sql: string, ...params: unknown[]) => {
    try {
      fx.harness.db.run(sql, params as never);
      return null;
    } catch (err) {
      return String(err);
    }
  };

  test("the tables refuse what their words do not allow", () => {
    expect(
      run(
        "INSERT INTO compute_observer_runs (id, nonce, expires_at, status) VALUES (?, ?, datetime('now','+1 hour'), 'bogus')",
        "11111111-2222-3333-4444-555555555555",
        "11111111-2222-3333-4444-555555555556",
      ),
    ).toMatch(/CHECK constraint failed: compute_observer_runs_status/);
    expect(
      run(
        "INSERT INTO compute_legal_holds (scope, ref, reason, placed_by) VALUES ('job', 'job_zz', 'legal_request', 1)",
      ),
    ).toMatch(/CHECK constraint failed: compute_legal_holds_ref/);
    expect(
      run(
        "INSERT INTO compute_legal_holds (scope, ref, reason, placed_by) VALUES ('account', '012', 'legal_request', 1)",
      ),
    ).toMatch(/CHECK constraint failed: compute_legal_holds_ref/);
    expect(
      run(
        "INSERT INTO compute_legal_holds (scope, ref, reason, placed_by) VALUES ('team', '12', 'legal_request', 1)",
      ),
    ).toMatch(/CHECK constraint failed: compute_legal_holds_scope/);
    expect(
      run(
        "INSERT INTO compute_legal_holds (scope, ref, reason, placed_by) VALUES ('account', '12', 'Not A Word', 1)",
      ),
    ).toMatch(/CHECK constraint failed: compute_legal_holds_reason/);
  });

  test("there is at most one ACTIVE hold per target, and a released one makes room", () => {
    expect(
      run(
        "INSERT INTO compute_legal_holds (scope, ref, reason, placed_by) VALUES ('account', '12', 'legal_request', 1)",
      ),
    ).toBeNull();
    expect(
      run(
        "INSERT INTO compute_legal_holds (scope, ref, reason, placed_by) VALUES ('account', '12', 'other_reason', 1)",
      ),
    ).toMatch(/UNIQUE/);
    expect(
      run("UPDATE compute_legal_holds SET released_at = datetime('now') WHERE ref = '12'"),
    ).toBeNull();
    expect(
      run(
        "INSERT INTO compute_legal_holds (scope, ref, reason, placed_by) VALUES ('account', '12', 'other_reason', 1)",
      ),
    ).toBeNull();
  });

  test("a snapshot is one row per partition per run, and a Slurm id is one row", () => {
    const rid = "11111111-2222-3333-4444-555555555555";
    expect(
      run(
        "INSERT INTO compute_queue_snapshots (run_id, partition, pending, running) VALUES (?, 'shared', 1, 2)",
        rid,
      ),
    ).toBeNull();
    expect(
      run(
        "INSERT INTO compute_queue_snapshots (run_id, partition, pending, running) VALUES (?, 'shared', 3, 4)",
        rid,
      ),
    ).toMatch(/UNIQUE|PRIMARY/);
    expect(
      run(
        "INSERT INTO compute_queue_snapshots (run_id, partition, pending, running) VALUES (?, 'shared', -1, 4)",
        "11111111-2222-3333-4444-555555555556",
      ),
    ).toMatch(/compute_queue_snapshots_pending/);
  });

  test("the column bounds the Worker checks are the migration's own, and a row at every bound is stored while one past it is refused (MUTATION: change a bound in one place)", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const sql = readFileSync(
      join(import.meta.dir, "../src/db/migrations/0118_compute_observer.sql"),
      "utf-8",
    );
    const bound = (column: string) => {
      const found = new RegExp(`${column} BETWEEN 0 AND (\\d+)`).exec(sql);
      return Number(found?.[1]);
    };
    expect({
      elapsedSeconds: bound("elapsed_seconds"),
      nodes: bound("alloc_nodes"),
      cpus: bound("alloc_cpus"),
      gpus: bound("alloc_gpus"),
      memMb: bound("alloc_mem_mb"),
    }).toEqual(SACCT_COLUMN_MAX);
    expect(TRES_MAX).toEqual({
      nodes: SACCT_COLUMN_MAX.nodes,
      cpus: SACCT_COLUMN_MAX.cpus,
      gpus: SACCT_COLUMN_MAX.gpus,
      memMb: SACCT_COLUMN_MAX.memMb,
    });
    // At every bound the insert succeeds (a CHECK that threw would fail the post after the run was spent).
    const slurm = nextSlurm();
    const atBound = acct(slurm, {
      elapsed_seconds: SACCT_COLUMN_MAX.elapsedSeconds,
      alloc_tres: {
        node: String(SACCT_COLUMN_MAX.nodes),
        cpu: String(SACCT_COLUMN_MAX.cpus),
        "gres/gpu": String(SACCT_COLUMN_MAX.gpus),
        mem: `${SACCT_COLUMN_MAX.memMb}M`,
      },
    });
    expect((await post((await mint()).token, daily([atBound]))).status).toBe(200);
    expect(
      fx.harness.db
        .query(
          "SELECT elapsed_seconds, alloc_nodes, alloc_cpus, alloc_gpus, alloc_mem_mb FROM compute_sacct_rows WHERE slurm_job_id = ?",
        )
        .get(slurm),
    ).toEqual({
      elapsed_seconds: SACCT_COLUMN_MAX.elapsedSeconds,
      alloc_nodes: SACCT_COLUMN_MAX.nodes,
      alloc_cpus: SACCT_COLUMN_MAX.cpus,
      alloc_gpus: SACCT_COLUMN_MAX.gpus,
      alloc_mem_mb: SACCT_COLUMN_MAX.memMb,
    });
    // One past an allocation bound is refused (the post, not the row).
    for (const over of [
      { node: String(SACCT_COLUMN_MAX.nodes + 1), cpu: "4" },
      { node: "1", cpu: String(SACCT_COLUMN_MAX.cpus + 1) },
      { node: "1", cpu: "4", "gres/gpu": String(SACCT_COLUMN_MAX.gpus + 1) },
      { node: "1", cpu: "4", mem: `${SACCT_COLUMN_MAX.memMb + 1}M` },
    ]) {
      const run = await mint();
      const res = await post(run.token, daily([acct(nextSlurm(), { alloc_tres: over })]));
      expect([JSON.stringify(over), res.status]).toEqual([JSON.stringify(over), 400]);
    }
  });

  test("the file's GLOB patterns are within D1's 50 characters, and no table names a person", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const sql = readFileSync(
      join(import.meta.dir, "../src/db/migrations/0118_compute_observer.sql"),
      "utf-8",
    );
    for (const m of sql.matchAll(/GLOB '([^']*)'/g))
      expect((m[1] ?? "").length).toBeLessThanOrEqual(50);
    for (const word of ["email", "name", "orcid", "country", "affiliation"]) {
      const tables = sql.split("CREATE TABLE").slice(1).join(" ");
      expect(new RegExp(`\\b${word}\\b`, "i").test(tables.replace(/--[^\n]*/g, ""))).toBe(false);
    }
  });
});

test("the refusal is the contract's job-not-found status family (a sanity check of the shared table)", () => {
  expect(COMPUTE_REFUSAL_STATUS.job_not_found).toBe(404);
});
