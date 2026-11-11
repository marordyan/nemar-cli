/**
 * The unattended run of an automatic re-pull (ADR 0111, decision 6 and the Phase 7d amendment;
 * epic #1046 phase 7, #1913), driven through the real entry point as the central
 * `run-upstream-repull` workflow drives it: `plan`, `execute` and `resume` with
 * `--automatic-dispatch <id>`, the dispatch read from an event file, `GH_TOKEN` the App's token.
 *
 * Everything NEMAR's is real (`repull-pr-world.ts`): the mirror and its upstream are real git and
 * git-annex repositories served as bare `file://` origins; the NEMAR API is the REAL datasets,
 * admin and users routers and the REAL report callback (`POST /webhooks/repull-state`) over
 * bun:sqlite with every migration applied, as `production` with the open switch on, reached
 * through TEST_API_URL; the dispatch is claimed by the Worker's own `claimOpenDispatch` and its
 * payload built by the Worker's own `buildUpstreamRepullPayload`. S3 is the scrub's stand-in driven
 * by the real `aws` CLI; GitHub is the suites' stand-in, which records the token of every request.
 * No mocks. `nemarDatasets/on099999` answered 404 to an organization administrator on 2026-10-25,
 * so no stand-in here names a real repository, and every GitHub base is the loopback stand-in.
 *
 * The CLI is this checkout's source with a release version (`release-cli.ts`): an automatic run
 * refuses any CLI that is not the release its dispatch names, which a test below shows for the
 * checkout's own development version.
 *
 * The properties, each with a test that fails when its line is changed:
 *  - a clean plan reaches `pr_open` with the App's token, the record is the automatic path's, and
 *    the dispatch ends `opened` with its run's page; the run prints only the fixed lines, and none
 *    of the fixture's paths, keys, file names, subject labels or secrets;
 *  - a plan with a correction is refused before anything is written, by `plan` and by `execute`,
 *    and so is a record taken up past `prepared` whose plan has one;
 *  - `execute` plans nothing again: it takes the plan step's plan and clones, and refuses
 *    (`not-planned`) without them;
 *  - a copy the estimate puts past the App token's hour is refused at plan time; a run whose
 *    token has too little of its usable hour left is refused at the plan, at the execute before
 *    its record, and before a push, without writing what it could not finish; a run that outlived
 *    its token is reported `token-expired`, refused and final for the tag once its record exists;
 *  - the token on the command line is reported as itself, with no probe of the token first;
 *  - the quiet line says how long the token was held and how long each step took, in seconds;
 *  - the token on the command line (checked before the plan file is read), no App token, a
 *    development build, a finish dispatch fed to `plan`, another dataset and other tags are each
 *    refused and reported (the token's report ends the dispatch); a tenth key, no event file, an
 *    unknown option and an API that is not production's are refused and NOT reported by the CLI,
 *    which ends with the failed result line (the workflow's backstop may report a shape-valid one);
 *  - a rerun finds its dispatch started and goes on, and a resume of a record left at `prepared`
 *    before its copy plans to the record's digest and opens its pull request;
 *  - an administrator's record of the same plan is never taken up by a run, and a create that
 *    answers with an administrator's or another record is refused;
 *  - an enrichment-shaped commit on the release branch while the run settles is recorded, and any
 *    other is `head-foreign`, recorded on the row and reported `failed`; the settle waits for the
 *    branch to be quiet by what was read, and a branch that cannot be read is `head-unreadable`,
 *    whatever the token's state; the token's hour ends the settle, which is then `head-unreadable`;
 *  - a finish takes a merged re-pull to `complete` and reports `finished` (again, after it
 *    completed), and refuses one that has not merged, another record or an administrator's,
 *    without touching it.
 *
 * What only the first production runs can check: that GitHub answers the dispatch with 204 and the
 * runner masks the token as the workflow asks; that the App token GitHub mints opens and pushes as
 * the stand-in lets it, and how GitHub refuses a push with one past its hour (simulated here by a
 * hook that turns the push away while the stand-in answers the token 401); how soon enrichment
 * commits after a push; how long a real copy takes against the estimate; and that the anonymous
 * clones of OpenNeuroDatasets the plan makes hold up on a runner.
 *
 * CI TIER: integration, like the other CLI suites that start the binary against a local server.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { which } from "bun";
import { signRepullDispatchToken } from "../backend/src/services/github/callback-tokens";
import {
  type UpstreamRepullDispatchFields,
  buildUpstreamRepullPayload,
} from "../backend/src/services/github/dispatch";
import {
  claimFinishDispatch,
  claimOpenDispatch,
} from "../backend/src/services/upstream-repull-dispatch";
import { readCandidateBlockers } from "../backend/src/services/upstream-repull-scheduler";
import type { DispatchRow, RepullRow } from "../shared/repull-state";
import { getRepull } from "../src/lib/api/repull";
import {
  type PlanFile,
  defaultPlanPath,
  readPlanFile,
  writePlanFile,
} from "../src/lib/repull/digest";
import { AUTOMATIC_LINE_RE, RESULT_LINE_RE } from "../src/lib/repull/execute/automatic";
import { type OriginScratch, openOriginScratch } from "../src/lib/repull/execute/origin";
import {
  type SettleOptions,
  type Settled,
  settleReleaseHead,
} from "../src/lib/repull/execute/settle";
import { workPaths } from "../src/lib/repull/execute/workdir";
import { planRepull } from "../src/lib/repull/plan";
import { ADMIN_TOKEN, APP_TOKEN } from "./helpers/github-standin";
import { type ReleaseCli, releaseCli } from "./helpers/release-cli";
import {
  CONCEPT_DOI,
  PATHS,
  TAG_A,
  TAG_B,
  UPSTREAM_ID,
  gitIn,
  writeAnnexBranchFile,
} from "./helpers/repull-fixture";
import {
  ADMIN_KEY,
  type RepullWorld,
  type WorldPoint,
  enrichedMetadata,
  startRepullWorld,
} from "./helpers/repull-pr-world";
import { toolOrFail } from "./scrub/helpers/require-tools";

setDefaultTimeout(600_000);

const awsInstalled = toolOrFail("aws", which("aws") !== null);

const SOURCE_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const CALLBACK_SECRET = "repull-world-callback-secret";
const RUN_ID = "4242";
const RUN_URL = `https://github.com/nemarDatasets/.github/actions/runs/${RUN_ID}`;
const RELEASE_REF = "refs/heads/release/v2.0.0";

let release: ReleaseCli;
let w: RepullWorld;
/** The runner's own temp directory for the test: the event file, the plan, the marker. */
let runner: string;
const temps: string[] = [];

beforeAll(async () => {
  if (!awsInstalled) return;
  release = releaseCli();
  w = await startRepullWorld({
    fixture: { noContributorEdits: true },
    execute: false,
    cliEntry: release.entry,
  });
});

afterAll(() => {
  w?.stop();
  release?.cleanup();
  for (const d of temps) {
    // The kept copy of a world's annex directory holds read-only objects.
    Bun.spawnSync(["chmod", "-R", "u+w", d]);
    rmSync(d, { recursive: true, force: true });
  }
});

beforeEach(async () => {
  if (!awsInstalled) return;
  await w.restore();
  w.workerEnv.AUTO_REPULL_ENABLED = "1";
  Bun.spawnSync(["chmod", "-R", "u+w", join(w.configDir, "repull")]);
  rmSync(join(w.configDir, "repull"), { recursive: true, force: true });
  runner = mkdtempSync(join(tmpdir(), "nemar-repull-auto-runner-"));
  temps.push(runner);
});

interface Claim {
  id: number;
  token: string;
}

/** A first dispatch, claimed by the Worker's own claim. */
async function claimOpen(): Promise<Claim> {
  const r = await claimOpenDispatch(w.bindings(), {
    datasetId: w.fx.datasetId,
    upstreamDs: UPSTREAM_ID,
    fromTag: TAG_A,
    toTag: TAG_B,
  });
  if (!("id" in r)) throw new Error(`nothing was claimed: ${JSON.stringify(r)}`);
  return r;
}

/** The event GitHub delivers for a dispatch, as the Worker builds its payload. */
function writeEvent(
  c: Claim,
  over: Partial<UpstreamRepullDispatchFields> = {},
  extraKeys: Record<string, string> = {},
): string {
  const payload = buildUpstreamRepullPayload({
    mode: "open",
    datasetId: w.fx.datasetId,
    upstreamDs: UPSTREAM_ID,
    fromTag: TAG_A,
    toTag: TAG_B,
    dispatchId: c.id,
    repullId: null,
    token: c.token,
    cliVersion: release.version,
    ...over,
  }).client_payload;
  const path = join(runner, "event.json");
  writeFileSync(
    path,
    JSON.stringify({
      action: "run-upstream-repull",
      client_payload: { ...payload, ...extraKeys },
      repository: { full_name: "nemarDatasets/.github" },
    }),
  );
  return path;
}

/** A command of the run, with the runner's environment. */
function auto(args: string[], extra: Record<string, string | undefined> = {}, entry?: string) {
  return w.cli(
    ["repull", ...args],
    {
      GITHUB_EVENT_PATH: join(runner, "event.json"),
      RUNNER_TEMP: runner,
      GITHUB_RUN_ID: RUN_ID,
      GITHUB_REPOSITORY: "nemarDatasets/.github",
      GITHUB_SERVER_URL: "https://github.com",
      GH_TOKEN: APP_TOKEN,
      NEMAR_REPULL_POLL_MS: "100",
      // The workflow notes the mint just before it, as `date +%s`.
      NEMAR_REPULL_TOKEN_SINCE: mintedAgo(0),
      ...extra,
    },
    undefined,
    entry,
  );
}

/** The mint's time as the workflow notes it, `minutes` before now. */
function mintedAgo(minutes: number): string {
  return String(Math.floor(Date.now() / 1000) - minutes * 60);
}

const planArgs = (c: Claim, extra: string[] = []) => [
  "plan",
  w.fx.datasetId,
  "--to-tag",
  TAG_B,
  "--bucket-listing",
  "--out",
  join(runner, "plan.json"),
  "--automatic-dispatch",
  String(c.id),
  ...extra,
];

const executeArgs = (c: Claim, plan = join(runner, "plan.json")) => [
  "execute",
  plan,
  "--automatic-dispatch",
  String(c.id),
  "--settle-minutes",
  "0",
  "--yes",
];

const dispatchRow = (id: number) =>
  w.db().query("SELECT * FROM upstream_repull_dispatches WHERE id = ?").get(id) as DispatchRow;

interface RecordRow {
  id: number;
  status: string;
  origin: string;
  head_sha: string | null;
  last_error: string | null;
}

const repullRows = () =>
  w.db().query("SELECT * FROM upstream_repulls ORDER BY id").all() as RecordRow[];

/** The commit the release branch names on the bare origin. */
const releaseHead = async () => (await gitIn(w.fx.originRepo, ["rev-parse", RELEASE_REF])).trim();

/** What none of a run's output may hold: the fixture's names and every secret the run handles. */
function forbidden(c: Claim): string[] {
  const out = [
    c.token,
    APP_TOKEN,
    ADMIN_TOKEN,
    ADMIN_KEY,
    CALLBACK_SECRET,
    "dummySecretAccessKeyForRepullWorld",
    "dummy-session-token-for-repull-world",
    w.configDir,
    runner,
    "sub-01",
    "sub-02",
    "sub-03",
    "sub-04",
    "Qwfixturelast",
    "Zxfixturename",
  ];
  for (const p of Object.values(PATHS)) out.push(p, basename(p));
  for (const k of Object.values(w.fx.keys)) if (k) out.push(k);
  return out;
}

/** The run printed only the fixed lines, ending with its result, and none of `forbidden`. */
function expectQuiet(run: { all: string; stderr: string }, c: Claim, phase: string): void {
  const lines = run.all.split("\n").filter((l) => l !== "");
  expect(lines.length).toBeGreaterThan(1);
  for (const line of lines) expect([line, AUTOMATIC_LINE_RE.test(line)]).toEqual([line, true]);
  const last = lines.at(-1) ?? "";
  expect(last).toMatch(RESULT_LINE_RE);
  expect(RESULT_LINE_RE.exec(last)?.[1]).toBe(phase);
  expect(run.stderr).toBe("");
  for (const s of forbidden(c)) expect([s, run.all.includes(s)]).toEqual([s, false]);
}

/** The GitHub stand-in's requests that are not reads. */
const ghWrites = () => w.gh.seen.filter((s) => s.method !== "GET");
/** The S3 stand-in's requests that are not reads. */
const s3Writes = () =>
  w.s3.log.filter((e) => !["GetObject", "HeadObject", "ListObjectsV2"].includes(e.op));

/**
 * The world as the first real `opened()` left it, for the cases that only start from a record at
 * `pr_open` (the finish and the settle suites). The first caller drives the real plan and execute
 * through the CLI; every later caller is put back at that point (`restore(point)`, the world's own
 * mechanism for "a suite whose cases all start further on"), instead of driving the same two CLI
 * runs again. Besides the world's refs, bucket, database and pull requests, the point holds what
 * the runs leave on disk: the runner's files (the plan, the event, the marker) and the CLI's own
 * `repull` directory under the config directory.
 */
interface OpenedPoint {
  point: WorldPoint;
  claim: Claim;
  row: RecordRow;
  runnerDir: string;
  repullDir: string | null;
}
let openedPoint: OpenedPoint | null = null;

/** Make `to` a copy of `from`, permissions included (annex objects are read-only). */
function copyTree(from: string, to: string): void {
  Bun.spawnSync(["chmod", "-R", "u+w", to]);
  rmSync(to, { recursive: true, force: true });
  const r = Bun.spawnSync(["cp", "-a", from, to]);
  if (r.exitCode !== 0) throw new Error(`cp -a ${from} ${to}: ${r.stderr.toString()}`);
}

/** Plan and execute a first dispatch to `pr_open`. */
async function opened(): Promise<{ c: Claim; row: RecordRow }> {
  const saved = openedPoint;
  if (saved) {
    await w.restore(saved.point);
    w.workerEnv.AUTO_REPULL_ENABLED = "1";
    for (const name of readdirSync(saved.runnerDir)) {
      copyTree(join(saved.runnerDir, name), join(runner, name));
    }
    const repullDir = join(w.configDir, "repull");
    Bun.spawnSync(["chmod", "-R", "u+w", repullDir]);
    rmSync(repullDir, { recursive: true, force: true });
    if (saved.repullDir) copyTree(saved.repullDir, repullDir);
    return { c: saved.claim, row: saved.row };
  }
  const c = await claimOpen();
  writeEvent(c);
  const plan = await auto(planArgs(c));
  expect(plan.exitCode, plan.all).toBe(0);
  const exec = await auto(executeArgs(c));
  expect(exec.exitCode, exec.all).toBe(0);
  const row = repullRows()[0];
  if (!row) throw new Error("no record");
  const repullDir = join(w.configDir, "repull");
  const keep = mkdtempSync(join(tmpdir(), "nemar-repull-auto-opened-"));
  temps.push(keep);
  const runnerDir = join(keep, "runner");
  copyTree(runner, runnerDir);
  const repullCopy = existsSync(repullDir) ? join(keep, "repull") : null;
  if (repullCopy) copyTree(repullDir, repullCopy);
  openedPoint = { point: await w.save(), claim: c, row, runnerDir, repullDir: repullCopy };
  return { c, row };
}

/** A plan file made by the planner itself, as the automatic plan would not have written it. */
async function libraryPlan(): Promise<{ path: string; file: PlanFile }> {
  const scratch = mkdtempSync(join(tmpdir(), "nemar-repull-auto-plan-"));
  temps.push(scratch);
  const made = await planRepull({
    datasetId: w.fx.datasetId,
    toTag: TAG_B,
    catalog: {
      dataset: { source: "openneuro", source_id: UPSTREAM_ID, concept_doi: CONCEPT_DOI },
      versions: [{ version: "1.0.0", source_version: TAG_A, source_version_basis: "doi" }],
    },
    github: { token: APP_TOKEN, apiBase: w.gh.url },
    env: w.fx.env,
    environment: w.apiUrl,
    workRoot: scratch,
    openNeuroGraphqlUrl: w.openNeuro.url,
  });
  if (!made.planned || !made.file.executable) throw new Error("the plan was not made");
  const path = defaultPlanPath(w.configDir, w.fx.datasetId, TAG_B, made.file.digest);
  writePlanFile(path, made.file);
  return { path, file: made.file };
}

/** A dispatch no claim would make (a finish of an unmerged record, say), written as one. */
async function dispatchFor(kind: "open" | "finish", repullId: number | null): Promise<Claim> {
  const nonce = crypto.randomUUID();
  w.db().run(
    `INSERT INTO upstream_repull_dispatches (kind, dataset_id, upstream_ds, from_tag, to_tag, repull_id, nonce, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'dispatched')`,
    [kind, w.fx.datasetId, UPSTREAM_ID, TAG_A, TAG_B, repullId, nonce],
  );
  const { id } = w.db().query("SELECT last_insert_rowid() AS id").get() as { id: number };
  return {
    id,
    token: await signRepullDispatchToken(
      { dispatchId: id, datasetId: w.fx.datasetId, nonce },
      CALLBACK_SECRET,
    ),
  };
}

const finishArgs = (c: Claim) => [
  "resume",
  w.fx.datasetId,
  "--automatic-dispatch",
  String(c.id),
  "--wait-minutes",
  "1",
  "--yes",
];

describe.skipIf(!awsInstalled)("what a run checks before it acts", () => {
  test("an API that is not production's is refused before anything is sent, and not reported", async () => {
    const c = await claimOpen();
    writeEvent(c);
    const plan = await auto(planArgs(c), { TEST_API_URL: "https://api.nemar.org.evil.example" });
    expect(plan.exitCode, plan.all).toBe(1);
    expectQuiet(plan, c, "failed");
    expect(plan.all).toContain("code=auto-api-not-production");
    expect(dispatchRow(c.id)).toMatchObject({ status: "dispatched" });
    expect(w.apiWrites).toEqual([]);
  });

  test("the token on the command line is refused before a plan file that cannot be read", async () => {
    const c = await claimOpen();
    writeEvent(c);
    const exec = await auto([
      "execute",
      join(runner, `${c.token}.json`),
      "--automatic-dispatch",
      String(c.id),
      "--yes",
    ]);
    expect(exec.exitCode, exec.all).toBe(1);
    expectQuiet(exec, c, "refused");
    expect(dispatchRow(c.id)).toMatchObject({
      status: "refused",
      code: "auto-token-on-argv",
      nonce: null,
    });
  });

  test("an unknown option, or no event file, still ends with the failed result line", async () => {
    const c = await claimOpen();
    writeEvent(c);
    for (const run of [
      await auto([...planArgs(c), "--no-such-option"]),
      await auto(planArgs(c), { GITHUB_EVENT_PATH: join(runner, "absent.json") }),
    ]) {
      expect(run.exitCode, run.all).toBe(1);
      expectQuiet(run, c, "failed");
      expect(run.all.trim().split("\n").at(-1)).toBe(
        "repull-auto: result phase=failed code=runner-failed",
      );
    }
    expect(dispatchRow(c.id)).toMatchObject({ status: "dispatched" });
    expect(w.apiWrites).toEqual([]);
  });

  test("a finish dispatch fed to plan, or a plan of another dataset, is dispatch-mismatch", async () => {
    const c = await claimOpen();
    writeEvent(c, { mode: "finish", repullId: 1 });
    const finishFed = await auto(planArgs(c));
    expect(finishFed.exitCode, finishFed.all).toBe(1);
    expectQuiet(finishFed, c, "refused");
    expect(dispatchRow(c.id)).toMatchObject({ status: "refused", code: "dispatch-mismatch" });

    const other = await claimOpen();
    writeEvent(other);
    const args = planArgs(other);
    args[1] = "on004362";
    const otherDataset = await auto(args);
    expect(otherDataset.exitCode, otherDataset.all).toBe(1);
    expectQuiet(otherDataset, other, "refused");
    expect(dispatchRow(other.id)).toMatchObject({ status: "refused", code: "dispatch-mismatch" });
    expect(repullRows()).toEqual([]);
  });

  test("a --to-tag, or a plan file, for other tags than the dispatch's is dispatch-mismatch", async () => {
    const c = await claimOpen();
    writeEvent(c);
    const args = planArgs(c);
    args[3] = "1.2.0";
    const plan = await auto(args);
    expect(plan.exitCode, plan.all).toBe(1);
    expectQuiet(plan, c, "refused");
    expect(dispatchRow(c.id)).toMatchObject({ status: "refused", code: "dispatch-mismatch" });

    // A dispatch for upstream's 1.2.0, and a plan file for 1.1.0.
    const { path } = await libraryPlan();
    const later = await claimOpenDispatch(w.bindings(), {
      datasetId: w.fx.datasetId,
      upstreamDs: UPSTREAM_ID,
      fromTag: TAG_A,
      toTag: "1.2.0",
    });
    if (!("id" in later)) throw new Error(`nothing was claimed: ${JSON.stringify(later)}`);
    writeEvent(later, { toTag: "1.2.0" });
    const exec = await auto(executeArgs(later, path));
    expect(exec.exitCode, exec.all).toBe(1);
    expectQuiet(exec, later, "refused");
    expect(dispatchRow(later.id)).toMatchObject({ status: "refused", code: "dispatch-mismatch" });
    // The run refused it itself, before the create: the Worker was not asked.
    expect(w.apiWrites).not.toContain("POST /admin/repulls");
    expect(repullRows()).toEqual([]);
  });

  test("a rerun of the same run finds its dispatch started and goes on", async () => {
    const c = await claimOpen();
    writeEvent(c);
    expect((await auto(planArgs(c))).exitCode).toBe(0);
    const again = await auto(planArgs(c));
    expect(again.exitCode, again.all).toBe(0);
    expectQuiet(again, c, "planned");
    expect(again.all).toContain("repull-auto: report phase=started answer=already-started");
    expect(dispatchRow(c.id).status).toBe("started");
  });

  test("a create that answers with an administrator's record is not taken as the run's", async () => {
    // The Worker records the run's create as automatic; a create that answered otherwise (a
    // Worker at fault) must not be acted on as the run's.
    w.setApiAfter((req) => {
      if (req.method !== "POST" || new URL(req.url).pathname !== "/admin/repulls") return null;
      const row = w.db().query("SELECT * FROM upstream_repulls ORDER BY id DESC LIMIT 1").get() as
        | (Record<string, unknown> & { counts: string })
        | null;
      if (!row) return null;
      return Response.json({
        repull: { ...row, counts: JSON.parse(row.counts), origin: "administrator" },
        created: true,
        lineage_rows: 0,
      });
    });
    const c = await claimOpen();
    writeEvent(c);
    expect((await auto(planArgs(c))).exitCode).toBe(0);
    const exec = await auto(executeArgs(c));
    expect(exec.exitCode, exec.all).toBe(1);
    expectQuiet(exec, c, "refused");
    expect(dispatchRow(c.id)).toMatchObject({ status: "refused", code: "record-refused" });
    expect(repullRows()).toMatchObject([{ status: "planned" }]);
    expect(ghWrites()).toEqual([]);
  });

  test("a dispatch that continues one record and is answered with another is repull-mismatch", async () => {
    const c = await claimOpen();
    // The run is handed a dispatch that says it continues re-pull #4242.
    writeEvent(c, { repullId: 4242 });
    expect((await auto(planArgs(c))).exitCode).toBe(0);
    const exec = await auto(executeArgs(c));
    expect(exec.exitCode, exec.all).toBe(1);
    expectQuiet(exec, c, "refused");
    expect(dispatchRow(c.id)).toMatchObject({ status: "refused", code: "repull-mismatch" });
    expect(repullRows()).toMatchObject([{ status: "planned" }]);
    expect(ghWrites()).toEqual([]);
  });

  test("a record taken up past prepared is refused when its plan has a correction", async () => {
    await w.commitOnto("refs/heads/main", PATHS.sidecar, '{"TaskName":"rest","edited":true}\n');
    const { path, file } = await libraryPlan();
    expect(file.body.counts).toMatchObject({ corrections: 1 });
    // An administrator executes it through its copy; the record is then the automatic path's (no
    // create makes such a record, which is why the run reads the counts again).
    const admin = await w.cli(
      ["repull", "execute", path, "--until", "copied", "--yes"],
      {},
      undefined,
      SOURCE_ENTRY,
    );
    expect(admin.exitCode, admin.all).toBe(0);
    w.db().run("UPDATE upstream_repulls SET origin = 'automatic'");
    const [row] = repullRows();
    const c = await claimOpenDispatch(w.bindings(), {
      datasetId: w.fx.datasetId,
      upstreamDs: UPSTREAM_ID,
      fromTag: TAG_A,
      toTag: TAG_B,
      repullId: row?.id ?? 0,
    });
    if (!("id" in c)) throw new Error(`nothing was claimed: ${JSON.stringify(c)}`);
    writeEvent(c, { repullId: row?.id ?? 0 });
    const exec = await auto(executeArgs(c, path));
    expect(exec.exitCode, exec.all).toBe(1);
    expectQuiet(exec, c, "refused");
    expect(dispatchRow(c.id)).toMatchObject({ status: "refused", code: "auto-not-clean-plan" });
    expect(repullRows()).toMatchObject([{ status: "copied" }]);
    expect(ghWrites()).toEqual([]);
  });
});

describe.skipIf(!awsInstalled)("an automatic run opens its pull request", () => {
  test("a clean plan reaches pr_open as the App, recorded automatic, reported opened, printing only fixed lines", async () => {
    const c = await claimOpen();
    writeEvent(c);
    const plan = await auto(planArgs(c));
    expect(plan.exitCode, plan.all).toBe(0);
    expectQuiet(plan, c, "planned");
    expect(plan.all).toContain("repull-auto: report phase=started answer=stored");
    // How long the token was held when the command started, and each step, in seconds.
    expect(plan.all).toMatch(
      /^repull-auto: quiet suppressed=\d+ token_age_s=\d+ plan_s=\d+ run_s=\d+$/m,
    );
    expect(dispatchRow(c.id).status).toBe("started");
    // The planning scratch is gone; only the plan file and its handoff are left for the execute.
    expect(readdirSync(runner).filter((n) => n.startsWith(".planning-"))).toEqual([]);
    expect(existsSync(join(runner, "plan.json.planner", "upstream.git"))).toBe(true);
    // The plan never left the runner, and nothing was written but the report.
    expect(readFileSync(join(runner, "plan.json"), "utf8")).toContain('"dataset": "on099999"');
    expect(w.apiWrites).toEqual(["POST /webhooks/repull-state"]);
    expect(ghWrites()).toEqual([]);
    expect(s3Writes()).toEqual([]);

    const exec = await auto(executeArgs(c));
    expect(exec.exitCode, exec.all).toBe(0);
    expectQuiet(exec, c, "opened");
    expect(exec.all).toMatch(
      /^repull-auto: quiet suppressed=\d+ token_age_s=\d+ clone_s=\d+ prepare_s=\d+ copy_s=\d+ register_s=\d+ pr_s=\d+ settle_s=\d+ run_s=\d+$/m,
    );
    const [row] = repullRows();
    expect(row).toMatchObject({ status: "pr_open", origin: "automatic" });
    const d = dispatchRow(c.id);
    expect(d).toMatchObject({
      status: "opened",
      repull_id: row?.id,
      nonce: null,
      workflow_run_url: RUN_URL,
      code: null,
    });
    // The pull request was opened, and the branch pushed, with the App's token.
    const created = w.gh.seen.filter(
      (s) => s.method === "POST" && s.path === `/repos/nemarDatasets/${w.fx.datasetId}/pulls`,
    );
    expect(created.map((s) => s.token)).toEqual([APP_TOKEN]);
    // The token reached the Worker only in the create's body and the reports' header.
    expect(readFileSync(join(runner, "repull-reported"), "utf8")).toBe("opened\n");
  });

  test("a plan with one correction is refused by plan before anything is written", async () => {
    // A NEMAR edit of a path upstream did not change: a correction.
    await w.commitOnto("refs/heads/main", PATHS.sidecar, '{"TaskName":"rest","edited":true}\n');
    const c = await claimOpen();
    writeEvent(c);
    const plan = await auto(planArgs(c));
    expect(plan.exitCode, plan.all).toBe(3);
    expectQuiet(plan, c, "refused");
    expect(plan.all).toContain("code=auto-not-clean-plan");
    expect(dispatchRow(c.id)).toMatchObject({ status: "refused", code: "auto-not-clean-plan" });
    expect(repullRows()).toEqual([]);
    expect(w.apiWrites).toEqual(["POST /webhooks/repull-state", "POST /webhooks/repull-state"]);
    expect(ghWrites()).toEqual([]);
    expect(s3Writes()).toEqual([]);
    // A plan it does not take leaves no clones behind: no handoff, no planning scratch.
    expect(existsSync(join(runner, "plan.json.planner"))).toBe(false);
    expect(readdirSync(runner).filter((n) => n.startsWith(".planning-"))).toEqual([]);
  });

  test("a plan that is not executable is refused by plan and leaves no handoff", async () => {
    // A release branch of the target version is already on origin: the planner's release check
    // refuses, so the plan is not executable. The plan step is execute's only gate on this.
    const main = (await gitIn(w.fx.originRepo, ["rev-parse", "refs/heads/main"])).trim();
    await gitIn(w.fx.originRepo, ["update-ref", RELEASE_REF, main]);
    const c = await claimOpen();
    writeEvent(c);
    const plan = await auto(planArgs(c));
    expect(plan.exitCode, plan.all).toBe(3);
    expectQuiet(plan, c, "refused");
    expect(plan.all).toContain("plan executable=no");
    expect(dispatchRow(c.id)).toMatchObject({ status: "refused", code: "plan-refused" });
    expect(existsSync(join(runner, "plan.json.planner"))).toBe(false);
    expect(readdirSync(runner).filter((n) => n.startsWith(".planning-"))).toEqual([]);
    expect(repullRows()).toEqual([]);
    expect(ghWrites()).toEqual([]);
    expect(s3Writes()).toEqual([]);
  });

  test("a resume of a record left at prepared, before its copy, plans to its digest and opens", async () => {
    const c = await claimOpen();
    writeEvent(c);
    expect((await auto(planArgs(c))).exitCode).toBe(0);
    const first = JSON.parse(readFileSync(join(runner, "plan.json"), "utf8")).digest as string;
    // The run stopped after the preparation, its uploads in the bucket and nothing copied.
    const admin = await w.cli(
      ["repull", "execute", join(runner, "plan.json"), "--until", "prepared", "--yes"],
      {},
      undefined,
      SOURCE_ENTRY,
    );
    expect(admin.exitCode, admin.all).toBe(0);
    expect(s3Writes().length).toBeGreaterThan(0);
    w.db().run("UPDATE upstream_repulls SET origin = 'automatic'");
    w.db().run(
      "UPDATE upstream_repull_dispatches SET status = 'failed', code = 'runner-failed', nonce = NULL WHERE id = ?",
      [c.id],
    );
    const [row] = repullRows();
    expect(row?.status).toBe("prepared");
    const resume = await claimOpenDispatch(w.bindings(), {
      datasetId: w.fx.datasetId,
      upstreamDs: UPSTREAM_ID,
      fromTag: TAG_A,
      toTag: TAG_B,
      repullId: row?.id ?? 0,
    });
    if (!("id" in resume)) throw new Error(`nothing was claimed: ${JSON.stringify(resume)}`);
    writeEvent(resume, { repullId: row?.id ?? 0 });
    expect((await auto(planArgs(resume))).exitCode).toBe(0);
    expect(JSON.parse(readFileSync(join(runner, "plan.json"), "utf8")).digest).toBe(first);
    const exec = await auto(executeArgs(resume));
    expect(exec.exitCode, exec.all).toBe(0);
    expectQuiet(exec, resume, "opened");
    expect(repullRows()).toMatchObject([{ id: row?.id, status: "pr_open" }]);
    expect(dispatchRow(resume.id)).toMatchObject({ status: "opened", repull_id: row?.id });
  });

  test("execute plans nothing again: OpenNeuro unanswered, it opens from the plan step's plan and clones", async () => {
    const c = await claimOpen();
    writeEvent(c);
    expect((await auto(planArgs(c))).exitCode).toBe(0);
    expect(existsSync(join(runner, "plan.json.planner", "upstream.git"))).toBe(true);
    // Only the planner asks OpenNeuro (for the latest snapshot).
    const asked = w.openNeuro.requests;
    expect(asked).toBeGreaterThan(0);
    w.openNeuro.status = 503;
    try {
      const exec = await auto(executeArgs(c));
      expect(exec.exitCode, exec.all).toBe(0);
      expectQuiet(exec, c, "opened");
    } finally {
      w.openNeuro.status = null;
    }
    expect(w.openNeuro.requests).toBe(asked);
    expect(repullRows()).toMatchObject([{ status: "pr_open", origin: "automatic" }]);
    expect(existsSync(join(runner, "plan.json.planner"))).toBe(false);
  });

  test("execute without its plan step's clones is not-planned, before the record", async () => {
    const { path } = await libraryPlan();
    const c = await claimOpen();
    writeEvent(c);
    const exec = await auto(executeArgs(c, path));
    expect(exec.exitCode, exec.all).toBe(1);
    expectQuiet(exec, c, "refused");
    expect(dispatchRow(c.id)).toMatchObject({ status: "refused", code: "not-planned" });
    expect(repullRows()).toEqual([]);
    expect(ghWrites()).toEqual([]);
    expect(s3Writes()).toEqual([]);
  });

  test("a handoff without its clones is not-planned, before the record", async () => {
    const c = await claimOpen();
    writeEvent(c);
    expect((await auto(planArgs(c))).exitCode).toBe(0);
    rmSync(join(runner, "plan.json.planner", "upstream.git"), { recursive: true, force: true });
    const exec = await auto(executeArgs(c));
    expect(exec.exitCode, exec.all).toBe(1);
    expectQuiet(exec, c, "refused");
    expect(dispatchRow(c.id)).toMatchObject({ status: "refused", code: "not-planned" });
    expect(repullRows()).toEqual([]);
    expect(ghWrites()).toEqual([]);
    expect(s3Writes()).toEqual([]);
  });

  test("a handoff without its computed bytes is not-planned, before the record", async () => {
    const c = await claimOpen();
    writeEvent(c);
    expect((await auto(planArgs(c))).exitCode).toBe(0);
    rmSync(join(runner, "plan.json.planner", "computed"), { recursive: true, force: true });
    const exec = await auto(executeArgs(c));
    expect(exec.exitCode, exec.all).toBe(1);
    expectQuiet(exec, c, "refused");
    expect(dispatchRow(c.id)).toMatchObject({ status: "refused", code: "not-planned" });
    expect(repullRows()).toEqual([]);
    expect(ghWrites()).toEqual([]);
    expect(s3Writes()).toEqual([]);
  });

  test("execute never reads the file's executable: flipped on disk, the run opens all the same", async () => {
    const c = await claimOpen();
    writeEvent(c);
    expect((await auto(planArgs(c))).exitCode).toBe(0);
    const path = join(runner, "plan.json");
    const text = readFileSync(path, "utf8");
    expect(text).toContain('"executable": true');
    writeFileSync(path, text.replace('"executable": true', '"executable": false'));
    // The flag sits outside the digest, so the body still proves.
    const flipped = readFileSync(path, "utf8");
    expect(readPlanFile(flipped).digest).toBe(JSON.parse(flipped).digest);
    const exec = await auto(executeArgs(c));
    expect(exec.exitCode, exec.all).toBe(0);
    expectQuiet(exec, c, "opened");
  });

  /** A plan step's plan file, read back, edited by `edit`, and written again. */
  function editPlan(edit: (plan: Record<string, unknown>) => void): void {
    const path = join(runner, "plan.json");
    const plan = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    edit(plan);
    writeFileSync(path, `${JSON.stringify(plan, null, 2)}\n`);
  }

  /** Execute a dispatch's plan, which must be refused with `code` and write nothing. */
  async function refusedBeforeAnything(c: Claim, code: string): Promise<void> {
    const exec = await auto(executeArgs(c));
    expect(exec.exitCode, exec.all).toBe(1);
    expectQuiet(exec, c, "refused");
    expect(dispatchRow(c.id)).toMatchObject({ status: "refused", code });
    expect(w.apiWrites).not.toContain("POST /admin/repulls");
    expect(repullRows()).toEqual([]);
    expect(ghWrites()).toEqual([]);
    expect(s3Writes()).toEqual([]);
  }

  test("a plan edited after its plan step does not prove, and nothing is written", async () => {
    const c = await claimOpen();
    writeEvent(c);
    expect((await auto(planArgs(c))).exitCode).toBe(0);
    editPlan((plan) => {
      (plan.counts as Record<string, number>).delta_paths += 1;
    });
    await refusedBeforeAnything(c, "plan-refused");
  });

  test("a plan forged onto a git-annex commit that names a bucket S3 cannot have is refused at prepare: nemar-s3-invalid, nothing uploaded or pushed", async () => {
    const c = await claimOpen();
    writeEvent(c);
    expect((await auto(planArgs(c))).exitCode).toBe(0);
    // The automatic execute plans nothing again, so only the plan file and its handoff stand between
    // the run and origin. Origin's git-annex branch moves to a commit whose remote.log names the
    // bucket as a path (a live plan would refuse it), the plan is forged to name that commit and
    // digested again, and the handoff is made to name the new digest.
    const log = await gitIn(w.fx.originRepo, ["show", "refs/heads/git-annex:remote.log"]);
    const forgedLog = log.replace(/bucket=nemar\b/, "bucket=evil.example/x#");
    expect(forgedLog).not.toBe(log);
    await writeAnnexBranchFile(w.fx.originRepo, "remote.log", forgedLog);
    const head = (await gitIn(w.fx.originRepo, ["rev-parse", "refs/heads/git-annex"])).trim();
    editPlan((plan) => {
      (plan.nemar as Record<string, unknown>).annex_commit = head;
      plan.digest = readPlanFile(JSON.stringify(plan)).digest;
    });
    const digest = JSON.parse(readFileSync(join(runner, "plan.json"), "utf8")).digest as string;
    writeFileSync(join(runner, "plan.json.planner", "digest"), `${digest}\n`);

    const exec = await auto(executeArgs(c));
    // The record exists (the create came first) and stays planned, with why in the prepare step's
    // words; the dispatch is reported with the step's class, the word being the record's.
    expect(exec.exitCode, exec.all).toBe(3);
    expectQuiet(exec, c, "failed");
    expect(exec.all).not.toContain("evil.example");
    expect(dispatchRow(c.id)).toMatchObject({ status: "failed", code: "prepare-failed" });
    expect(repullRows()).toMatchObject([{ status: "planned", origin: "automatic" }]);
    expect(repullRows()[0]?.last_error).toStartWith("[prepare:nemar-s3-invalid]");
    // Nothing was uploaded, pushed or opened.
    expect(ghWrites()).toEqual([]);
    expect(s3Writes()).toEqual([]);
  });

  test("a plan edited and digested again is not its handoff's plan: not-planned, nothing written", async () => {
    const c = await claimOpen();
    writeEvent(c);
    expect((await auto(planArgs(c))).exitCode).toBe(0);
    editPlan((plan) => {
      (plan.counts as Record<string, number>).delta_paths += 1;
      plan.digest = readPlanFile(JSON.stringify(plan)).digest;
    });
    await refusedBeforeAnything(c, "not-planned");
  });

  test("a plan made against another API is refused on the automatic path too", async () => {
    const c = await claimOpen();
    writeEvent(c);
    expect((await auto(planArgs(c))).exitCode).toBe(0);
    editPlan((plan) => {
      plan.environment = "https://api.other.example";
    });
    await refusedBeforeAnything(c, "plan-refused");
  });

  test("a plan made from other remotes is refused on the automatic path too", async () => {
    const c = await claimOpen();
    writeEvent(c);
    expect((await auto(planArgs(c))).exitCode).toBe(0);
    editPlan((plan) => {
      expect(plan.sources).toBe("test-bases");
      plan.sources = "remotes";
    });
    await refusedBeforeAnything(c, "plan-refused");
  });

  test("a step's own word the list does not hold is reported as the step's class", async () => {
    const c = await claimOpen();
    writeEvent(c);
    expect((await auto(planArgs(c))).exitCode).toBe(0);
    // A precondition S3 refuses is the copy's `pin-changed`, which the list does not hold.
    w.s3.inject("CopyObject", { code: "PreconditionFailed", status: 412 });
    try {
      const exec = await auto(executeArgs(c));
      expect(exec.exitCode, exec.all).toBe(3);
      expectQuiet(exec, c, "failed");
    } finally {
      w.s3.clearFaults();
    }
    expect(dispatchRow(c.id)).toMatchObject({ status: "failed", code: "copy-failed" });
    // The exact word stays on the record, for an administrator.
    expect(repullRows()[0]?.last_error).toStartWith("[copy:pin-changed]");
  });

  /** The record's API refuses the first transition `matches` names, with `code`, as a 409. */
  function refuseTransition(matches: (from?: string, to?: string) => boolean, code: string): void {
    let refuse = false;
    let refused = false;
    w.setApiHook(async (req) => {
      refuse = false;
      if (refused || req.method !== "POST" || !/\/admin\/repulls\/\d+\/transition$/.test(req.url))
        return;
      const body = (await req.json()) as { from?: string; to?: string };
      refuse = matches(body.from, body.to);
      refused = refuse;
    });
    w.setApiOverride(() =>
      refuse ? Response.json({ error: "refused", code }, { status: 409 }) : null,
    );
  }

  test("a preparation the record refuses for a word the list does not hold is prepare-failed", async () => {
    refuseTransition((from, to) => from === "planned" && to === "prepared", "field-invalid");
    const c = await claimOpen();
    writeEvent(c);
    expect((await auto(planArgs(c))).exitCode).toBe(0);
    const exec = await auto(executeArgs(c));
    expect(exec.exitCode, exec.all).toBe(3);
    expectQuiet(exec, c, "failed");
    expect(dispatchRow(c.id)).toMatchObject({ status: "failed", code: "prepare-failed" });
  });

  test("a pull request GitHub did not answer for is the pull request step's class, pr-failed", async () => {
    const c = await claimOpen();
    writeEvent(c);
    expect((await auto(planArgs(c))).exitCode).toBe(0);
    // The step's own word is `pr-create-unknown`, which the list does not hold.
    w.gh.createPullFaults.push({ status: 500 });
    const exec = await auto(executeArgs(c));
    expect(exec.exitCode, exec.all).toBe(3);
    expectQuiet(exec, c, "failed");
    expect(dispatchRow(c.id)).toMatchObject({ status: "failed", code: "pr-failed" });
    expect(repullRows()[0]?.last_error).toStartWith("[pr:pr-create-unknown]");
  });

  test("a settle whose move the record refuses for a word the list does not hold is settle-failed", async () => {
    // Enrichment moves the release branch as the pull request opens, and the record refuses the
    // settle's self-edge that records the move with `stale-status`.
    let moved = false;
    let refuse = false;
    w.setApiHook(async (req) => {
      refuse = false;
      if (req.method !== "POST" || !/\/admin\/repulls\/\d+\/transition$/.test(req.url)) return;
      const body = (await req.json()) as { from?: string; to?: string };
      if (!moved && body.from === "registered" && body.to === "pr_open") {
        moved = true;
        await w.commitOnto(
          RELEASE_REF,
          ".nemar/metadata.json",
          await enrichedMetadata(w.fx.originRepo, RELEASE_REF),
        );
      }
      refuse = body.from === "pr_open" && body.to === "pr_open";
    });
    w.setApiOverride(() =>
      refuse ? Response.json({ error: "moved", code: "stale-status" }, { status: 409 }) : null,
    );
    const c = await claimOpen();
    writeEvent(c);
    expect((await auto(planArgs(c))).exitCode).toBe(0);
    const exec = await auto(executeArgs(c));
    expect(moved).toBe(true);
    expect(exec.exitCode, exec.all).toBe(3);
    expectQuiet(exec, c, "failed");
    expect(dispatchRow(c.id)).toMatchObject({ status: "failed", code: "settle-failed" });
  });

  test("execute refuses a plan with a correction, before the record", async () => {
    await w.commitOnto("refs/heads/main", PATHS.sidecar, '{"TaskName":"rest","edited":true}\n');
    // A plan file the automatic plan would have refused, made by the planner itself.
    const { path, file } = await libraryPlan();
    expect(file.body.counts).toMatchObject({ corrections: 1 });
    const c = await claimOpen();
    writeEvent(c);
    const exec = await auto(executeArgs(c, path));
    expect(exec.exitCode, exec.all).toBe(1);
    expectQuiet(exec, c, "refused");
    expect(dispatchRow(c.id)).toMatchObject({ status: "refused", code: "auto-not-clean-plan" });
    expect(w.apiWrites).toEqual(["POST /webhooks/repull-state"]);
    expect(repullRows()).toEqual([]);
    expect(ghWrites()).toEqual([]);
    expect(s3Writes()).toEqual([]);
  });

  test("the token on the command line is refused, and the report ends the dispatch so it is dead", async () => {
    // The token is reported as itself, even with the App token past its hour: no probe comes first.
    w.gh.expiredTokens.add(APP_TOKEN);
    const c = await claimOpen();
    writeEvent(c);
    const plan = await auto([
      ...planArgs(c).slice(0, 6),
      join(runner, `${c.token}.json`),
      ...planArgs(c).slice(7),
    ]);
    expect(plan.exitCode, plan.all).toBe(1);
    expectQuiet(plan, c, "refused");
    expect(dispatchRow(c.id)).toMatchObject({
      status: "refused",
      code: "auto-token-on-argv",
      nonce: null,
    });
    expect(w.apiWrites).toEqual(["POST /webhooks/repull-state"]);
    expect(w.gh.seen.filter((s) => s.path === `/repos/nemarDatasets/${w.fx.datasetId}`)).toEqual(
      [],
    );
  });

  test("a run with no App token is refused", async () => {
    const c = await claimOpen();
    writeEvent(c);
    const plan = await auto(planArgs(c), { GH_TOKEN: "" });
    expect(plan.exitCode, plan.all).toBe(1);
    expectQuiet(plan, c, "refused");
    expect(dispatchRow(c.id)).toMatchObject({ status: "refused", code: "auto-no-app-token" });
  });

  test("a tenth key is dispatch-invalid, and nothing is reported or written", async () => {
    const c = await claimOpen();
    writeEvent(c, {}, { callback_url: "https://example.org/hook" });
    const plan = await auto(planArgs(c));
    expect(plan.exitCode, plan.all).toBe(1);
    expectQuiet(plan, c, "failed");
    expect(plan.all).toContain("code=dispatch-invalid");
    expect(dispatchRow(c.id)).toMatchObject({ status: "dispatched" });
    expect(w.apiWrites).toEqual([]);
  });

  test("a development build is refused, and says so to the Worker", async () => {
    const c = await claimOpen();
    writeEvent(c);
    const plan = await auto(planArgs(c), {}, SOURCE_ENTRY);
    expect(plan.exitCode, plan.all).toBe(1);
    expectQuiet(plan, c, "refused");
    expect(dispatchRow(c.id)).toMatchObject({ status: "refused", code: "auto-cli-version" });
    expect(ghWrites()).toEqual([]);
  });

  test("an administrator's record of the same plan is never taken up by the run", async () => {
    const c = await claimOpen();
    writeEvent(c);
    expect((await auto(planArgs(c))).exitCode).toBe(0);
    // The administrator executes the very plan file, through its copy.
    const admin = await w.cli(
      ["repull", "execute", join(runner, "plan.json"), "--until", "copied", "--yes"],
      {},
      undefined,
      SOURCE_ENTRY,
    );
    expect(admin.exitCode, admin.all).toBe(0);
    expect(repullRows()).toMatchObject([{ status: "copied", origin: "administrator" }]);
    const exec = await auto(executeArgs(c));
    expect(exec.exitCode, exec.all).toBe(1);
    expectQuiet(exec, c, "refused");
    expect(dispatchRow(c.id)).toMatchObject({ status: "refused", code: "record-refused" });
    expect(repullRows()).toMatchObject([{ status: "copied", origin: "administrator" }]);
    expect(w.gh.seen.filter((s) => s.token === APP_TOKEN && s.method !== "GET")).toEqual([]);
  });

  test("an open record of another plan is the record's class, record-refused", async () => {
    const c = await claimOpen();
    writeEvent(c);
    expect((await auto(planArgs(c))).exitCode).toBe(0);
    // Then an administrator records another plan of the same tags (read from the location log,
    // not a listing) and leaves it at planned.
    const { path } = await libraryPlan();
    const admin = await w.cli(
      ["repull", "execute", path, "--until", "planned", "--yes"],
      {},
      undefined,
      SOURCE_ENTRY,
    );
    expect(admin.exitCode, admin.all).toBe(0);
    const [open] = repullRows();
    expect(JSON.parse(readFileSync(join(runner, "plan.json"), "utf8")).digest).not.toBe(
      open?.plan_digest,
    );
    const exec = await auto(executeArgs(c));
    expect(exec.exitCode, exec.all).toBe(1);
    expectQuiet(exec, c, "refused");
    expect(dispatchRow(c.id)).toMatchObject({ status: "refused", code: "record-refused" });
    expect(repullRows()).toMatchObject([{ id: open?.id, status: "planned" }]);
  });

  test("an execute refused at the plan's lock keeps the handoff for the execution that holds it", async () => {
    const c = await claimOpen();
    writeEvent(c);
    expect((await auto(planArgs(c))).exitCode).toBe(0);
    const digest = JSON.parse(readFileSync(join(runner, "plan.json"), "utf8")).digest as string;
    // Another execution of this plan holds its lock: a live process, this one.
    const lock = workPaths(w.configDir, w.fx.datasetId, digest).lock;
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, "pid"), `${process.pid}\n`);
    try {
      const exec = await auto(executeArgs(c));
      expect(exec.exitCode, exec.all).toBe(1);
      expectQuiet(exec, c, "refused");
      expect(dispatchRow(c.id)).toMatchObject({ status: "refused", code: "plan-refused" });
      expect(existsSync(join(runner, "plan.json.planner", "upstream.git"))).toBe(true);
      expect(repullRows()).toEqual([]);
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  });

  test("a record taken up past prepared leaves no handoff behind", async () => {
    const c = await claimOpen();
    writeEvent(c);
    expect((await auto(planArgs(c))).exitCode).toBe(0);
    // The record of this very plan is taken through its copy, and is the automatic path's; its
    // first run failed, and a resume dispatch names it.
    const admin = await w.cli(
      ["repull", "execute", join(runner, "plan.json"), "--until", "copied", "--yes"],
      {},
      undefined,
      SOURCE_ENTRY,
    );
    expect(admin.exitCode, admin.all).toBe(0);
    w.db().run("UPDATE upstream_repulls SET origin = 'automatic'");
    w.db().run(
      "UPDATE upstream_repull_dispatches SET status = 'failed', code = 'runner-failed', nonce = NULL WHERE id = ?",
      [c.id],
    );
    const [row] = repullRows();
    const resume = await claimOpenDispatch(w.bindings(), {
      datasetId: w.fx.datasetId,
      upstreamDs: UPSTREAM_ID,
      fromTag: TAG_A,
      toTag: TAG_B,
      repullId: row?.id ?? 0,
    });
    if (!("id" in resume)) throw new Error(`nothing was claimed: ${JSON.stringify(resume)}`);
    writeEvent(resume, { repullId: row?.id ?? 0 });
    expect(existsSync(join(runner, "plan.json.planner"))).toBe(true);
    const exec = await auto(executeArgs(resume));
    expect(exec.exitCode, exec.all).toBe(0);
    expectQuiet(exec, resume, "opened");
    expect(repullRows()).toMatchObject([{ id: row?.id, status: "pr_open" }]);
    expect(existsSync(join(runner, "plan.json.planner"))).toBe(false);
  });

  test("a copy the estimate puts past the App token's hour is refused at plan time", async () => {
    const c = await claimOpen();
    writeEvent(c);
    // The fixture's copy is small; the budget is shortened, which may only ever refuse more.
    const plan = await auto(planArgs(c), { NEMAR_REPULL_COPY_BUDGET_SECONDS: "1" });
    expect(plan.exitCode, plan.all).toBe(3);
    expectQuiet(plan, c, "refused");
    expect(dispatchRow(c.id)).toMatchObject({ status: "refused", code: "auto-copy-too-long" });
    expect(repullRows()).toEqual([]);
    expect(ghWrites()).toEqual([]);
    expect(s3Writes()).toEqual([]);
  });

  test("a run with too little of the token's hour left is refused at the plan, nothing written", async () => {
    const c = await claimOpen();
    writeEvent(c);
    const plan = await auto(planArgs(c), { NEMAR_REPULL_TOKEN_SINCE: mintedAgo(56) });
    expect(plan.exitCode, plan.all).toBe(1);
    expectQuiet(plan, c, "refused");
    expect(dispatchRow(c.id)).toMatchObject({ status: "refused", code: "auto-token-hour" });
    expect(repullRows()).toEqual([]);
    expect(ghWrites()).toEqual([]);
    expect(s3Writes()).toEqual([]);
    // A plan the step does not take leaves no handoff.
    expect(existsSync(join(runner, "plan.json.planner"))).toBe(false);
  });

  test("a run that cannot tell when its token was minted is refused before it reads anything", async () => {
    const c = await claimOpen();
    writeEvent(c);
    const plan = await auto(planArgs(c), { NEMAR_REPULL_TOKEN_SINCE: "" });
    expect(plan.exitCode, plan.all).toBe(1);
    expectQuiet(plan, c, "refused");
    expect(dispatchRow(c.id)).toMatchObject({ status: "refused", code: "auto-token-clock" });
    expect(w.apiWrites).toEqual(["POST /webhooks/repull-state"]);
  });

  test("an execute with too little of the token's hour left is refused before its record", async () => {
    const c = await claimOpen();
    writeEvent(c);
    expect((await auto(planArgs(c))).exitCode).toBe(0);
    const exec = await auto(executeArgs(c), { NEMAR_REPULL_TOKEN_SINCE: mintedAgo(50) });
    expect(exec.exitCode, exec.all).toBe(1);
    expectQuiet(exec, c, "refused");
    expect(dispatchRow(c.id)).toMatchObject({ status: "refused", code: "auto-token-hour" });
    expect(w.apiWrites).not.toContain("POST /admin/repulls");
    expect(repullRows()).toEqual([]);
    expect(ghWrites()).toEqual([]);
    expect(s3Writes()).toEqual([]);
    // The plan step's handoff is for this run only: gone however the execute ended.
    expect(existsSync(join(runner, "plan.json.planner"))).toBe(false);
  });

  /**
   * An automatic record an administrator took through `until`, and a resume dispatch of it run
   * with the token's hour nearly gone: the next push is refused before it starts.
   */
  async function lateResume(until: "copied" | "registered", step: string): Promise<void> {
    const { path } = await libraryPlan();
    const admin = await w.cli(
      ["repull", "execute", path, "--until", until, "--yes"],
      {},
      undefined,
      SOURCE_ENTRY,
    );
    expect(admin.exitCode, admin.all).toBe(0);
    w.db().run("UPDATE upstream_repulls SET origin = 'automatic'");
    const [row] = repullRows();
    const c = await claimOpenDispatch(w.bindings(), {
      datasetId: w.fx.datasetId,
      upstreamDs: UPSTREAM_ID,
      fromTag: TAG_A,
      toTag: TAG_B,
      repullId: row?.id ?? 0,
    });
    if (!("id" in c)) throw new Error(`nothing was claimed: ${JSON.stringify(c)}`);
    writeEvent(c, { repullId: row?.id ?? 0 });
    const head = (await gitIn(w.fx.originRepo, ["rev-parse", "refs/heads/git-annex"])).trim();
    w.gh.seen.length = 0;
    const exec = await auto(executeArgs(c, path), { NEMAR_REPULL_TOKEN_SINCE: mintedAgo(50) });
    expect(exec.exitCode, exec.all).toBe(3);
    expectQuiet(exec, c, "failed");
    expect(dispatchRow(c.id)).toMatchObject({ status: "failed", code: "auto-token-hour" });
    const [after] = repullRows();
    expect(after?.status).toBe(until);
    expect(after?.last_error).toStartWith(`[${step}:auto-token-hour]`);
    // Nothing was pushed: origin's git-annex branch did not move, and GitHub saw no write.
    expect((await gitIn(w.fx.originRepo, ["rev-parse", "refs/heads/git-annex"])).trim()).toBe(head);
    expect(ghWrites()).toEqual([]);
  }

  test("a resume with too little of the token's hour left is refused before the registration's push", async () => {
    await lateResume("copied", "register");
  });

  test("a resume with too little of the token's hour left is refused before the pull request", async () => {
    await lateResume("registered", "pr");
  });

  test("a run that outlived its App token is reported token-expired, whatever its step called it", async () => {
    // From the copy on, the token is past its hour: GitHub answers it 401, and the registration's
    // push to the origin is turned away as an expired token's would be.
    const hook = join(w.fx.originRepo, "hooks", "pre-receive");
    let armed = false;
    w.setApiHook(async (req) => {
      if (armed || req.method !== "POST" || !/\/admin\/repulls\/\d+\/transition$/.test(req.url))
        return;
      const body = (await req.json()) as { from?: string; to?: string };
      if (body.from !== "prepared" || body.to !== "copied") return;
      armed = true;
      writeFileSync(hook, "#!/bin/sh\necho 'Invalid username or token.' >&2\nexit 1\n");
      chmodSync(hook, 0o755);
      w.gh.expiredTokens.add(APP_TOKEN);
    });
    try {
      const c = await claimOpen();
      writeEvent(c);
      expect((await auto(planArgs(c))).exitCode).toBe(0);
      const exec = await auto(executeArgs(c));
      expect(armed).toBe(true);
      expect(exec.exitCode, exec.all).toBe(3);
      // Past its record, a run whose token GitHub stopped taking is a refusal: no later run can
      // take the record up, so the scheduler sends none for the tag again.
      expectQuiet(exec, c, "refused");
      expect(exec.all).toContain("code=token-expired");
      const [row] = repullRows();
      expect(dispatchRow(c.id)).toMatchObject({
        status: "refused",
        code: "token-expired",
        repull_id: row?.id,
      });
      expect(await readCandidateBlockers(w.bindings().DB, w.fx.datasetId, TAG_B)).toMatchObject({
        final_refusals: 1,
      });
      // The record stays where the step left it, with the step's own error on it.
      expect(row?.status).toBe("copied");
      expect(row?.last_error).toStartWith("[register:");
    } finally {
      rmSync(hook, { force: true });
    }
  });
});

describe.skipIf(!awsInstalled)("the release head settles before the run reports", () => {
  /** Move the release branch the moment the run records its pull request open. */
  function moveAtPrOpen(path: string, content: (head: string) => Promise<string>): void {
    let moved = false;
    w.setApiHook(async (req) => {
      if (moved || req.method !== "POST" || !/\/admin\/repulls\/\d+\/transition$/.test(req.url))
        return;
      const body = (await req.json()) as { from?: string; to?: string };
      if (body.from !== "registered" || body.to !== "pr_open") return;
      moved = true;
      await w.commitOnto(RELEASE_REF, path, await content(RELEASE_REF));
    });
  }

  test("an enrichment-shaped commit on the release branch during the settle is recorded", async () => {
    moveAtPrOpen(".nemar/metadata.json", (ref) => enrichedMetadata(w.fx.originRepo, ref));
    const c = await claimOpen();
    writeEvent(c);
    expect((await auto(planArgs(c))).exitCode).toBe(0);
    const exec = await auto(executeArgs(c));
    expect(exec.exitCode, exec.all).toBe(0);
    expectQuiet(exec, c, "opened");
    expect(exec.all).toContain("repull-auto: settle reads=1 moves=1 unreadable=0");
    expect(repullRows()).toMatchObject([
      { status: "pr_open", head_sha: await releaseHead(), last_error: null },
    ]);
    expect(dispatchRow(c.id).status).toBe("opened");
  });

  test("a commit enrichment does not make is head-foreign: recorded on the row, reported failed", async () => {
    moveAtPrOpen("README.md", async () => "A README someone else changed.\n");
    const c = await claimOpen();
    writeEvent(c);
    expect((await auto(planArgs(c))).exitCode).toBe(0);
    const exec = await auto(executeArgs(c));
    expect(exec.exitCode, exec.all).toBe(1);
    expectQuiet(exec, c, "failed");
    const [row] = repullRows();
    expect(row?.status).toBe("pr_open");
    expect(row?.last_error).toStartWith("[auto:head-foreign]");
    expect(row?.head_sha).not.toBe(await releaseHead());
    expect(dispatchRow(c.id)).toMatchObject({ status: "failed", code: "head-foreign" });
  });

  /**
   * The library's settle on the world's record, in this process, against the world's API as the
   * administrator, on a virtual clock: `sleep` advances it, and `onTick` may move the branch at a
   * virtual instant, so nothing here waits on the machine's clock.
   */
  async function withSettle(
    fn: (s: {
      live: RepullRow;
      scratch: OriginScratch;
      settle: (
        row: RepullRow,
        opts: SettleOptions,
        onTick?: (t: number) => Promise<void>,
        deadlineAfterMs?: number,
      ) => Promise<{ result: Settled; took: number }>;
    }) => Promise<void>,
    scratchEnv: Record<string, string> = w.fx.env,
  ): Promise<void> {
    const { row } = await opened();
    const saved = { url: process.env.TEST_API_URL, dir: process.env.NEMAR_CONFIG_DIR };
    process.env.TEST_API_URL = w.apiUrl;
    process.env.NEMAR_CONFIG_DIR = w.configDir;
    const digest = JSON.parse(readFileSync(join(runner, "plan.json"), "utf8")).digest as string;
    const scratch = await openOriginScratch({
      configDir: w.configDir,
      datasetId: w.fx.datasetId,
      digest,
      purpose: "settle",
      env: scratchEnv,
      token: null,
    });
    try {
      const live = (await getRepull(row.id)) as RepullRow;
      await fn({
        live,
        scratch,
        async settle(r, opts, onTick, deadlineAfterMs) {
          let t = 1_000_000;
          const start = t;
          const result = await settleReleaseHead({
            scratch,
            row: r,
            opts,
            out: () => {},
            ...(deadlineAfterMs === undefined ? {} : { deadlineMs: start + deadlineAfterMs }),
            now: () => t,
            sleep: async (ms) => {
              t += ms;
              await onTick?.(t - start);
            },
          });
          return { result, took: t - start };
        },
      });
    } finally {
      scratch.close();
      for (const [k, v] of [
        ["TEST_API_URL", saved.url],
        ["NEMAR_CONFIG_DIR", saved.dir],
      ] as const) {
        if (v === undefined) Reflect.deleteProperty(process.env, k);
        else process.env[k] = v;
      }
    }
  }

  const QUIET = 5 * 60_000;
  const POLL = 15_000;

  test("a branch quiet from the start settles after the quiet period, on the virtual clock", async () => {
    await withSettle(async ({ live, settle }) => {
      const { result, took } = await settle(live, {
        maxWaitMs: 30 * 60_000,
        quietMs: QUIET,
        pollMs: POLL,
      });
      expect(result).toMatchObject({ outcome: "settled", moves: 0, unreadable: 0, cause: null });
      expect(took).toBe(QUIET);
      expect(result.reads).toBe(QUIET / POLL + 1);
    });
  });

  test("a move that lands while it waits is recorded, and the quiet period counts again from it", async () => {
    await withSettle(async ({ live, settle }) => {
      let landedAt = -1;
      const { result, took } = await settle(
        live,
        { maxWaitMs: 30 * 60_000, quietMs: QUIET, pollMs: POLL },
        async (elapsed) => {
          if (landedAt >= 0 || elapsed < 2 * 60_000) return;
          landedAt = elapsed;
          await w.commitOnto(
            RELEASE_REF,
            ".nemar/metadata.json",
            await enrichedMetadata(w.fx.originRepo, RELEASE_REF, "2026-10-25T01:00:00Z"),
          );
        },
      );
      expect(result).toMatchObject({ outcome: "settled", moves: 1, unreadable: 0 });
      expect(landedAt).toBe(2 * 60_000);
      expect(took).toBe(landedAt + QUIET);
      expect(result.row.head_sha).toBe(await releaseHead());
      expect(repullRows()[0]?.head_sha).toBe(await releaseHead());
    });
  });

  test("a bound shorter than the quiet period ends the settle at the bound", async () => {
    await withSettle(async ({ live, settle }) => {
      const { result, took } = await settle(live, {
        maxWaitMs: 60_000,
        quietMs: QUIET,
        pollMs: POLL,
      });
      expect(result.outcome).toBe("settled");
      expect(took).toBe(60_000);
    });
  });

  test("a branch that cannot be read is never settled: head-unreadable, recorded with its cause", async () => {
    await withSettle(
      async ({ live, settle }) => {
        const { result, took } = await settle(live, {
          maxWaitMs: 10 * 60_000,
          quietMs: QUIET,
          pollMs: POLL,
        });
        expect(result).toMatchObject({ outcome: "unreadable", moves: 0 });
        expect(result.unreadable).toBe(result.reads);
        expect(result.cause).toBe("origin-unreadable");
        expect(took).toBe(10 * 60_000);
        const [row] = repullRows();
        expect(row?.status).toBe("pr_open");
        expect(row?.head_sha).toBe(live.head_sha);
        expect(row?.last_error).toStartWith("[auto:head-unreadable]");
        expect(row?.last_error).toContain("(origin-unreadable)");
        expect(row?.last_error).not.toContain("abandon a record is built");
        // No later run settles it: the record says who does.
        expect(row?.last_error).not.toContain("later run");
        expect(row?.last_error).toContain("an administrator's resume settles it");
      },
      { ...w.fx.env, NEMAR_REPULL_ORIGIN_BASE: join(runner, "no-such-origins") },
    );
  });

  test("the token's hour ends a settle before the branch is quiet: head-unreadable, never past it", async () => {
    await withSettle(async ({ live, settle }) => {
      const { result, took } = await settle(
        live,
        { maxWaitMs: 30 * 60_000, quietMs: QUIET, pollMs: POLL },
        undefined,
        2 * 60_000,
      );
      expect(result).toMatchObject({ outcome: "unreadable", cause: "token-hour", unreadable: 0 });
      expect(took).toBe(2 * 60_000);
      expect(result.reads).toBe((2 * 60_000) / POLL + 1);
      const [row] = repullRows();
      expect(row?.status).toBe("pr_open");
      expect(row?.last_error).toStartWith("[auto:head-unreadable]");
      expect(row?.last_error).toContain("(token-hour)");
    });
  });

  test("a token whose hour is over reads nothing, and a later end leaves the settle as it was", async () => {
    await withSettle(async ({ live, settle }) => {
      const opts = { maxWaitMs: 30 * 60_000, quietMs: QUIET, pollMs: POLL };
      const over = await settle(live, opts, undefined, 0);
      expect(over.result).toMatchObject({ outcome: "unreadable", cause: "token-hour", reads: 0 });
      expect(over.took).toBe(0);
      const later = await settle(live, opts, undefined, 10 * 60_000);
      expect(later.result).toMatchObject({ outcome: "settled", cause: null });
      expect(later.took).toBe(QUIET);
    });
  });

  test("through the CLI, the settle of a run past the token's hour reads nothing", async () => {
    // A run that takes up a record already at `pr_open` goes straight to the settle, so the
    // settle's own end at the token's hour is all that stands between it and an expired token.
    const { row } = await opened();
    const c = await dispatchFor("open", row.id);
    writeEvent(c, { repullId: row.id });
    const exec = await auto(executeArgs(c), { NEMAR_REPULL_TOKEN_SINCE: mintedAgo(56) });
    expect(exec.exitCode, exec.all).toBe(3);
    expectQuiet(exec, c, "failed");
    expect(exec.all).toContain("repull-auto: settle reads=0 moves=0 unreadable=0");
    expect(dispatchRow(c.id)).toMatchObject({ status: "failed", code: "head-unreadable" });
    expect(repullRows()[0]?.last_error).toContain("(token-hour)");
  });

  test("reads that stop succeeding for a whole quiet period do not settle the branch", async () => {
    await withSettle(async ({ live, settle, scratch }) => {
      let broken = false;
      const { result } = await settle(
        live,
        { maxWaitMs: 10 * 60_000, quietMs: QUIET, pollMs: POLL },
        async (elapsed) => {
          // From the second read on, origin's address is one that cannot be read.
          if (broken || elapsed < POLL) return;
          broken = true;
          await Bun.$`git -C ${scratch.dir} remote set-url origin ${join(runner, "gone")}`.quiet();
        },
      );
      expect(result.outcome).toBe("unreadable");
      expect(result.reads).toBeGreaterThan(result.unreadable);
    });
  });

  test("through the CLI, a release branch that cannot be read is reported head-unreadable, not opened", async () => {
    const moved = `${w.fx.originRepo}.away`;
    let away = false;
    w.setApiHook(async (req) => {
      if (away || req.method !== "POST" || !/\/admin\/repulls\/\d+\/transition$/.test(req.url))
        return;
      const body = (await req.json()) as { from?: string; to?: string };
      if (body.from !== "registered" || body.to !== "pr_open") return;
      away = true;
      renameSync(w.fx.originRepo, moved);
      // The App token is past its hour too: the settle's outcome is reported, not the token's.
      w.gh.expiredTokens.add(APP_TOKEN);
    });
    try {
      const c = await claimOpen();
      writeEvent(c);
      expect((await auto(planArgs(c))).exitCode).toBe(0);
      const exec = await auto(executeArgs(c));
      expect(away).toBe(true);
      expect(exec.exitCode, exec.all).toBe(3);
      expectQuiet(exec, c, "failed");
      expect(dispatchRow(c.id)).toMatchObject({ status: "failed", code: "head-unreadable" });
      expect(repullRows()[0]?.last_error).toStartWith("[auto:head-unreadable]");
    } finally {
      if (away) renameSync(moved, w.fx.originRepo);
    }
  });
});

describe.skipIf(!awsInstalled)("a finish", () => {
  test("at pr_open it is finish-not-merged, and nothing is touched", async () => {
    const { row } = await opened();
    const c = await dispatchFor("finish", row.id);
    writeEvent(c, { mode: "finish", repullId: row.id });
    w.apiWrites.length = 0;
    w.gh.seen.length = 0;
    const run = await auto(finishArgs(c));
    expect(run.exitCode, run.all).toBe(1);
    expectQuiet(run, c, "refused");
    expect(dispatchRow(c.id)).toMatchObject({ status: "refused", code: "finish-not-merged" });
    expect(repullRows()).toMatchObject([{ status: "pr_open" }]);
    expect(w.apiWrites).toEqual(["POST /webhooks/repull-state", "POST /webhooks/repull-state"]);
    expect(ghWrites()).toEqual([]);
  });

  test("a finish does not take --accept-merge-trailers: auto-option, and nothing is touched", async () => {
    const { row } = await opened();
    const c = await dispatchFor("finish", row.id);
    writeEvent(c, { mode: "finish", repullId: row.id });
    w.apiWrites.length = 0;
    w.gh.seen.length = 0;
    const run = await auto([
      ...finishArgs(c),
      "--accept-merge-trailers",
      "a finish is never given an administrator's reason",
    ]);
    expect(run.exitCode, run.all).toBe(1);
    expect(dispatchRow(c.id)).toMatchObject({ status: "refused", code: "auto-option" });
    expect(repullRows()).toMatchObject([{ status: "pr_open" }]);
    expect(ghWrites()).toEqual([]);
  });

  test("a finish that refuses for a word the list does not hold is finish-failed", async () => {
    const { row } = await opened();
    const c = await dispatchFor("finish", row.id);
    writeEvent(c, { mode: "finish", repullId: row.id });
    // The catalog no longer has the dataset: `dataset-missing`, before the record is read.
    w.setApiOverride((req) =>
      req.method === "GET" && new URL(req.url).pathname === `/datasets/${w.fx.datasetId}`
        ? Response.json({ error: "Dataset not found" }, { status: 404 })
        : null,
    );
    const run = await auto(finishArgs(c));
    expect(run.exitCode, run.all).toBe(1);
    expectQuiet(run, c, "refused");
    expect(dispatchRow(c.id)).toMatchObject({ status: "refused", code: "finish-failed" });
    expect(repullRows()).toMatchObject([{ status: "pr_open" }]);
  });

  test("a merged automatic re-pull is walked to complete and reported finished", async () => {
    const { row } = await opened();
    // An administrator merges it through the one gate, as the Worker's merge is not built yet.
    const resume = () =>
      w.cli(["repull", "resume", w.fx.datasetId, "--wait-minutes", "0", "--yes"]);
    expect((await resume()).exitCode).toBe(3);
    const head = repullRows()[0]?.head_sha as string;
    await w.reportScreen(head, "clean");
    expect((await resume()).exitCode).toBe(0);
    const merge = await w.cli(["repull", "merge", w.fx.datasetId, "--yes"]);
    expect(merge.exitCode, merge.all).toBe(0);
    expect(repullRows()[0]?.status).toBe("merged");
    // The dataset workflow tags the merge, and the DOI's callback writes the version row.
    await w.tagMain("2.0.0");
    w.insertVersionRow("2.0.0");

    const claimed = await claimFinishDispatch(
      w.bindings(),
      w.db().query("SELECT * FROM upstream_repulls WHERE id = ?").get(row.id) as RepullRow,
    );
    if (!("id" in claimed)) throw new Error(`no finish claim: ${JSON.stringify(claimed)}`);
    writeEvent(claimed, { mode: "finish", repullId: row.id });
    const run = await auto(finishArgs(claimed));
    expect(run.exitCode, run.all).toBe(0);
    expectQuiet(run, claimed, "finished");
    expect(repullRows()).toMatchObject([{ status: "complete", origin: "automatic" }]);
    expect(dispatchRow(claimed.id)).toMatchObject({
      status: "finished",
      nonce: null,
      workflow_run_url: RUN_URL,
    });

    // A finish of the same record after it completed (an earlier run whose report was lost):
    // there is no open record, the dataset's latest is the dispatch's and complete, so it is finished.
    const again = await dispatchFor("finish", row.id);
    writeEvent(again, { mode: "finish", repullId: row.id });
    const rerun = await auto(finishArgs(again));
    expect(rerun.exitCode, rerun.all).toBe(0);
    expectQuiet(rerun, again, "finished");
    expect(dispatchRow(again.id)).toMatchObject({ status: "finished" });
  });

  test("a finish naming another record, or an administrator's, is repull-mismatch and touches nothing", async () => {
    const { row } = await opened();
    w.apiWrites.length = 0;
    w.gh.seen.length = 0;
    const another = await dispatchFor("finish", row.id + 1);
    writeEvent(another, { mode: "finish", repullId: row.id + 1 });
    const r1 = await auto(finishArgs(another));
    expect(r1.exitCode, r1.all).toBe(1);
    expectQuiet(r1, another, "refused");
    expect(dispatchRow(another.id)).toMatchObject({ status: "refused", code: "repull-mismatch" });

    w.db().run("UPDATE upstream_repulls SET origin = 'administrator' WHERE id = ?", [row.id]);
    const admins = await dispatchFor("finish", row.id);
    writeEvent(admins, { mode: "finish", repullId: row.id });
    const r2 = await auto(finishArgs(admins));
    expect(r2.exitCode, r2.all).toBe(1);
    expectQuiet(r2, admins, "refused");
    expect(dispatchRow(admins.id)).toMatchObject({ status: "refused", code: "repull-mismatch" });

    expect(repullRows()).toMatchObject([{ status: "pr_open" }]);
    // Only the reports were written: no screen, no transition.
    expect(w.apiWrites.every((p) => p === "POST /webhooks/repull-state")).toBe(true);
    expect(ghWrites()).toEqual([]);
  });

  test("with no open record and none complete, a finish is finish-not-merged", async () => {
    const c = await dispatchFor("finish", 1);
    writeEvent(c, { mode: "finish", repullId: 1 });
    const run = await auto(finishArgs(c));
    expect(run.exitCode, run.all).toBe(1);
    expectQuiet(run, c, "refused");
    expect(dispatchRow(c.id)).toMatchObject({ status: "refused", code: "finish-not-merged" });
  });
});
