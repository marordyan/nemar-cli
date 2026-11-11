/**
 * `nemar admin repull execute <plan-file>` through its pull request (ADR 0111, decisions 2, 3 and 8;
 * epic #1046 phase 6, #1912), driven through the real entry point
 * (`bun run src/index.ts admin repull execute ...`) as a subprocess.
 *
 * Everything NEMAR's is real. The mirror and its upstream are the real git and git-annex
 * repositories of `test/helpers/repull-fixture.ts`, made by the real import step and served as
 * bare `file://` origins through the planner's test bases; the NEMAR API is the REAL datasets and
 * `/admin/repulls` routers over bun:sqlite with every migration applied, reached through
 * TEST_API_URL in the child's environment. S3 is the scrub's stand-in driven by the REAL `aws` CLI
 * (versioning, cross-bucket CopyObject and UploadPartCopy at a version id). GitHub is the suites'
 * `Bun.serve()` stand-in, which opens a pull request on a branch it reads from the bare origin.
 * No mocks.
 *
 * What only the canary (`scripts/repull-canary.ts`) and the first production runs can check,
 * because only stand-ins answer here: that real S3 answers a signed cross-account CopyObject of a
 * public versioned object with `?versionId=` as the stand-in does, that a multipart copy over
 * 5 GiB and the CLI's retries behave as they do here, how GitHub opens, lists and answers for a
 * pull request, and that its default squash message would drop the trailers mid-message.
 *
 * CI TIER: integration, like the other CLI suites that start the binary against a local server.
 */

import { Database } from "bun:sqlite";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, which } from "bun";
import { hashApiKey } from "../backend/src/services/token";
import type { Bindings } from "../backend/src/types/bindings";
import { freshDb, realD1 } from "../backend/test/helpers/d1";
import { makeRepullApp } from "../backend/test/helpers/repull-app";
import { hashDirLower, isDead, presentIn, readLocationLogsAt } from "../scripts/scrub/git/git-lib";
import { runCommand } from "../src/lib/git-annex/run-command";
import { defaultPlanPath, writePlanFile } from "../src/lib/repull/digest";
import { workPaths } from "../src/lib/repull/execute/workdir";
import { planRepull } from "../src/lib/repull/plan";
import { useTestGitIdentity } from "./helpers/git-identity";
import {
  ADMIN_TOKEN,
  type GitHubStandin,
  WORKER_TOKEN,
  startGitHubStandin,
} from "./helpers/github-standin";
import {
  CONCEPT_DOI,
  type LatestSnapshotStandin,
  PATHS,
  type RepullFixture,
  TAG_A,
  TAG_B,
  UPSTREAM_ID,
  buildRepullFixture,
  gitIn,
  refsOf,
  startLatestSnapshotStandin,
} from "./helpers/repull-fixture";
import { toolOrFail } from "./scrub/helpers/require-tools";
import { type S3Standin, type Snapshot, startS3Standin } from "./scrub/helpers/s3-standin";

setDefaultTimeout(600_000);

const awsInstalled = toolOrFail("aws", which("aws") !== null);

const CLI_ENTRY = join(import.meta.dir, "..", "src", "index.ts");
const REPO_ROOT = join(import.meta.dir, "..");
const ADMIN_KEY = "repull-execute-cli-admin-key-0123456789abcdef0123456789";
const REGION = "us-east-2";

let gh: GitHubStandin;
let openNeuro: LatestSnapshotStandin;
let s3: S3Standin;
let apiServer: ReturnType<typeof Bun.serve>;
let db: Database;
let configDir: string;
const handle = makeRepullApp();
/** Every request to the API that is not a GET, in order. */
const apiWrites: string[] = [];
/** The bare origin of each dataset, for the GitHub stand-in's branch reads. */
const origins = new Map<string, string>();
/** Runs before the API handles a request: a test's way to move the world at an exact point. */
let apiHook: ((req: Request) => Promise<void>) | null = null;

function bindings(): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "test",
    GITHUB_ADMIN_PAT: WORKER_TOKEN,
    API_BASE_URL: "https://api.test.nemar.org",
  } as Bindings;
}

beforeAll(() => {
  gh = startGitHubStandin();
  gh.resolveHead = async (dataset, ref) => {
    const origin = origins.get(dataset);
    if (!origin) return null;
    const r = await runCommand(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${ref}`], {
      cwd: origin,
    });
    return r.exitCode === 0 ? r.stdout.trim() : null;
  };
  openNeuro = startLatestSnapshotStandin(TAG_B);
  s3 = startS3Standin({ region: REGION });
  // The versions route reads the description through GitHub; the stand-in answers it 404.
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = gh.url;
  apiServer = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/notices") return Response.json({ notices: [] });
      if (req.method !== "GET") apiWrites.push(`${req.method} ${url.pathname}`);
      if (apiHook) await apiHook(req.clone());
      return handle(req, bindings());
    },
  });
  configDir = mkdtempSync(join(tmpdir(), "nemar-repull-execute-cli-"));
  const home = join(configDir, "aws-home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config"), `[profile repull-execute-cli]\nregion = ${REGION}\n`);
  writeFileSync(join(home, "credentials"), "");
});

afterAll(() => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  apiServer?.stop(true);
  gh?.stop();
  openNeuro?.stop();
  s3?.stop();
  Bun.spawnSync(["chmod", "-R", "u+w", configDir]);
  rmSync(configDir, { recursive: true, force: true });
});

function apiUrl(): string {
  return `http://127.0.0.1:${apiServer.port}`;
}

/** The child's whole environment: the stand-ins, the test bases, and nothing of the host's AWS. */
function childEnv(fx: RepullFixture): Record<string, string | undefined> {
  const home = join(configDir, "aws-home");
  const env: Record<string, string | undefined> = {
    ...process.env,
    ...fx.env,
    NEMAR_CONFIG_DIR: configDir,
    TEST_API_URL: apiUrl(),
    NEMAR_NO_UPDATE_CHECK: "1",
    NO_COLOR: "1",
    GH_TOKEN: ADMIN_TOKEN,
    NEMAR_GITHUB_API_URL: gh.url,
    NEMAR_REPULL_OPENNEURO_URL: openNeuro.url,
    NEMAR_REPULL_UPSTREAM_OBJECTS_BASE: s3.url,
    AWS_ACCESS_KEY_ID: "ASIATESTDUMMY000001",
    AWS_SECRET_ACCESS_KEY: "dummySecretAccessKeyForRepullExecuteCli",
    AWS_SESSION_TOKEN: "dummy-session-token-for-repull-execute-cli",
    AWS_CONFIG_FILE: join(home, "config"),
    AWS_SHARED_CREDENTIALS_FILE: join(home, "credentials"),
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_MAX_ATTEMPTS: "1",
    AWS_ENDPOINT_URL_S3: s3.url,
    AWS_PROFILE: "repull-execute-cli",
  };
  env.FORCE_COLOR = undefined;
  env.CLICOLOR_FORCE = undefined;
  return env;
}

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
  all: string;
}

function startCli(fx: RepullFixture, args: string[]) {
  return spawn({
    cmd: ["bun", "run", CLI_ENTRY, "admin", "repull", ...args],
    cwd: REPO_ROOT,
    env: childEnv(fx),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function runCli(fx: RepullFixture, args: string[]): Promise<Run> {
  const proc = startCli(fx, args);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr, all: `${stdout}\n${stderr}` };
}

async function execute(fx: RepullFixture, plan: string, extra: string[] = []): Promise<Run> {
  return runCli(fx, ["execute", plan, "--yes", ...extra]);
}

async function seedAdmin(): Promise<void> {
  db.run(
    `INSERT INTO users (id, username, email, password_hash, status, role, email_verified)
     VALUES (1, 'owner', 'owner@example.org', 'x', 'approved', 'member', 1)`,
  );
  db.run(
    `INSERT INTO users (id, username, email, password_hash, github_username, status, role,
                        signup_source, email_verified, service_access)
     VALUES (2, 'repulladmin', 'repulladmin@example.org', 'x', 'repulladmin-gh', 'approved', 'admin',
             'cli', 1, 1)`,
  );
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    2,
    await hashApiKey(ADMIN_KEY),
    ADMIN_KEY.slice(0, 8),
  );
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      activeAccount: "repulladmin",
      accounts: { repulladmin: { apiKey: ADMIN_KEY } },
    }),
  );
}

/** The mirror's dataset row and its one version row, as production records an imported mirror. */
function seedMirror(id: string, o: { anonymous?: boolean } = {}): void {
  db.run(
    `INSERT INTO datasets
       (dataset_id, name, owner_user_id, status, visibility, is_sandbox, github_repo,
        first_published_at, source, source_id, concept_doi, anonymous)
     VALUES (?, 'A sufficiently descriptive fixture title', 1, 'active', 'public', 0, ?,
             '2026-01-01 00:00:00', 'openneuro', ?, ?, ?)`,
    [id, `nemarDatasets/${id}`, UPSTREAM_ID, CONCEPT_DOI, o.anonymous ? 1 : 0],
  );
  db.run(
    `INSERT INTO dataset_versions (dataset_id, version, doi, provider, created_at, source_version, source_version_basis)
     VALUES (?, '1.0.0', ?, 'ezid', '2026-01-01 00:00:00', ?, 'doi')`,
    [id, `10.82901/nemar.${id}.v1.0.0`, TAG_A],
  );
}

type Row = Record<string, unknown> & {
  id: number;
  status: string;
  counts: string;
  last_error: string | null;
  synth_sha: string | null;
  base_sha: string;
  head_sha: string | null;
  pr_number: number | null;
  manifest_digest: string | null;
};

function repullRows(): Row[] {
  return db.query("SELECT * FROM upstream_repulls ORDER BY id").all() as Row[];
}

/** The plan as `nemar admin repull plan` makes it, written where it writes it. */
async function makePlan(fx: RepullFixture): Promise<string> {
  const scratch = mkdtempSync(join(tmpdir(), "nemar-repull-plan-"));
  try {
    const out = await planRepull({
      datasetId: fx.datasetId,
      catalog: {
        dataset: { source: "openneuro", source_id: UPSTREAM_ID, concept_doi: CONCEPT_DOI },
        versions: [{ version: "1.0.0", source_version: TAG_A, source_version_basis: "doi" }],
      },
      github: { token: ADMIN_TOKEN, apiBase: gh.url },
      env: fx.env,
      environment: apiUrl(),
      workRoot: scratch,
      openNeuroGraphqlUrl: openNeuro.url,
    });
    if (!out.planned) throw new Error(`not planned: ${out.reason}`);
    if (!out.file.executable) throw new Error("the fixture's plan is not executable");
    const path = defaultPlanPath(configDir, fx.datasetId, TAG_B, out.file.digest);
    writePlanFile(path, out.file);
    return path;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The S3 stand-in's requests that are not reads. */
function s3Writes(): string[] {
  return s3.log
    .filter((e) => !["GetObject", "HeadObject", "ListObjectsV2"].includes(e.op))
    .map((e) => `${e.op} ${e.key}`);
}

/** Everything a test can change, as the fixture left it, so each test starts from it. */
interface World {
  origin: string;
  upstream: string;
  s3: Snapshot;
}

async function snapshotWorld(fx: RepullFixture): Promise<World> {
  return {
    origin: await refsOf(fx.originRepo),
    upstream: await refsOf(fx.upstreamRepo),
    s3: s3.snapshot(),
  };
}

async function restoreRefs(repo: string, refs: string): Promise<void> {
  const want = new Map(
    refs
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split(" ") as [string, string]),
  );
  for (const line of (await refsOf(repo)).split("\n").filter(Boolean)) {
    const [name] = line.split(" ");
    if (name && !want.has(name)) await gitIn(repo, ["update-ref", "-d", name]);
  }
  for (const [name, oid] of want) await gitIn(repo, ["update-ref", name, oid]);
}

async function restoreWorld(fx: RepullFixture, w: World): Promise<void> {
  await restoreRefs(fx.originRepo, w.origin);
  await restoreRefs(fx.upstreamRepo, w.upstream);
  s3.restore(w.s3);
  apiWrites.length = 0;
  apiHook = null;
  db = freshDb();
  gh.reset();
  Bun.spawnSync(["chmod", "-R", "u+w", join(configDir, "repull")]);
  rmSync(join(configDir, "repull"), { recursive: true, force: true });
  await seedAdmin();
  seedMirror(fx.datasetId);
}

/** Origin's refs other than the git-annex branch and the release branches. */
async function protectedRefs(repo: string): Promise<string> {
  return (await refsOf(repo))
    .split("\n")
    .filter((l) => l && !/^refs\/heads\/(git-annex|release\/)/.test(l))
    .join("\n");
}

/** The keys a commit's tree names at annexed paths (its symlink targets). */
async function annexedKeys(repo: string, commit: string): Promise<Map<string, string>> {
  const listed = await gitIn(repo, ["ls-tree", "-r", "-z", commit]);
  const out = new Map<string, string>();
  for (const entry of listed.split("\0").filter(Boolean)) {
    const m = /^120000 blob ([0-9a-f]{40})\t(.+)$/.exec(entry);
    if (!m) continue;
    const target = (await gitIn(repo, ["cat-file", "blob", m[1] as string])).trim();
    if (target.includes(".git/annex/objects/"))
      out.set(m[2] as string, target.split("/").pop() as string);
  }
  return out;
}

/** Every location-log line the registration added, with the uuids the parent's log named. */
async function addedLogLines(
  repo: string,
  from: string,
  to: string,
): Promise<{ paths: string[]; added: Array<{ path: string; line: string; before: Set<string> }> }> {
  const changed = (await gitIn(repo, ["diff", "--name-only", from, to]))
    .split("\n")
    .filter(Boolean);
  const added: Array<{ path: string; line: string; before: Set<string> }> = [];
  for (const path of changed) {
    const read = async (rev: string) => {
      const r = await runCommand(["git", "cat-file", "blob", `${rev}:${path}`], { cwd: repo });
      return r.exitCode === 0 ? r.stdout : "";
    };
    const old = await read(from);
    const now = await read(to);
    const before = new Set(
      old
        .split("\n")
        .filter(Boolean)
        .map((l) => l.split(" ")[2] as string),
    );
    const oldLines = new Set(old.split("\n"));
    for (const line of now.split("\n").filter(Boolean)) {
      if (!oldLines.has(line)) added.push({ path, line, before });
    }
  }
  return { paths: changed, added };
}

/** The upstream key at a path of tag B, and upstream's own location log for it. */
async function upstreamLog(fx: RepullFixture, key: string): Promise<string> {
  return (await readLocationLogsAt(fx.upstreamRepo, "refs/heads/git-annex", [key]))[0] ?? "";
}

/** Commit one file onto a bare repository's branch, by plumbing (a push someone else made). */
async function commitOnto(
  repo: string,
  ref: string,
  path: string,
  content: string,
): Promise<string> {
  const before = (await gitIn(repo, ["rev-parse", ref])).trim();
  const blob = (
    await runCommand(["git", "hash-object", "-w", "--stdin"], { cwd: repo, stdin: content })
  ).stdout.trim();
  const index = mkdtempSync(join(tmpdir(), "nemar-repull-index-"));
  const env = { GIT_INDEX_FILE: join(index, "index") };
  try {
    await runCommand(["git", "read-tree", ref], { cwd: repo, env });
    await runCommand(["git", "update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], {
      cwd: repo,
      env,
    });
    const tree = (await runCommand(["git", "write-tree"], { cwd: repo, env })).stdout.trim();
    const commit = (
      await runCommand(["git", "commit-tree", tree, "-p", before, "-m", "a later commit"], {
        cwd: repo,
        env: {
          ...env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@t",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@t",
        },
      })
    ).stdout.trim();
    await gitIn(repo, ["update-ref", ref, commit]);
    return commit;
  } finally {
    rmSync(index, { recursive: true, force: true });
  }
}

/** `.nemar/metadata.json` at a commit, with one more key, as an enrichment run rewrites it. */
async function enrichedMetadata(repo: string, rev: string): Promise<string> {
  const meta = JSON.parse(await gitIn(repo, ["show", `${rev}:.nemar/metadata.json`]));
  return `${JSON.stringify({ ...meta, enriched_at: "2026-10-24T00:00:00Z" }, null, 2)}\n`;
}

function digestOf(plan: string): string {
  return JSON.parse(readFileSync(plan, "utf8")).digest as string;
}

/** Rewrite `remote.log` on the working clone's own git-annex branch (a hostile or stale record). */
async function rewriteRemoteLog(repo: string, from: string, to: string): Promise<void> {
  const env = {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
  const run = async (args: string[], extra: Record<string, string> = {}, stdin?: string) => {
    const r = await runCommand(["git", ...args], {
      cwd: repo,
      env: { ...env, ...extra },
      ...(stdin !== undefined ? { stdin } : {}),
    });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const log = await run(["show", "refs/heads/git-annex:remote.log"]);
  if (!log.includes(from)) throw new Error("remote.log does not hold the text to replace");
  const blob = await run(["hash-object", "-w", "--stdin"], {}, `${log.replace(from, to)}\n`);
  const index = mkdtempSync(join(tmpdir(), "nemar-repull-remotelog-"));
  try {
    const extra = { GIT_INDEX_FILE: join(index, "index") };
    await run(["read-tree", "refs/heads/git-annex"], extra);
    await run(["update-index", "--cacheinfo", `100644,${blob},remote.log`], extra);
    const tree = await run(["write-tree"], extra);
    const parent = await run(["rev-parse", "refs/heads/git-annex"]);
    const commit = await run(["commit-tree", tree, "-p", parent, "-m", "hostile remote.log"]);
    await run(["update-ref", "refs/heads/git-annex", commit]);
  } finally {
    rmSync(index, { recursive: true, force: true });
  }
}

/** Where a test's race hooks for one plan's working clone live. */
function raceDir(plan: string): string {
  return join(configDir, `race-${digestOf(plan).slice(7, 15)}`);
}

/**
 * A `pre-push` hook in the working clone that, on the first `times` pushes of the git-annex branch,
 * moves origin's branch after git has read it and before the push is sent: another writer's commit
 * landing under the registration. Returns the file counting the pushes it saw.
 */
async function installAnnexRace(fx: RepullFixture, plan: string, times: number): Promise<string> {
  const dir = raceDir(plan);
  mkdirSync(dir, { recursive: true });
  const counter = join(dir, "pushes");
  writeFileSync(counter, "0\n");
  const script = `#!/bin/sh
ORIGIN="${fx.originRepo}"
while read local_ref local_sha remote_ref remote_sha; do
  [ "$remote_ref" = refs/heads/git-annex ] || exit 0
done
n=$(cat "${counter}")
n=$((n+1))
echo "$n" > "${counter}"
if [ "$n" -le ${times} ]; then
  parent=$(git --git-dir="$ORIGIN" rev-parse refs/heads/git-annex)
  tree=$(git --git-dir="$ORIGIN" rev-parse "$parent^{tree}")
  c=$(GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t \\
      git --git-dir="$ORIGIN" commit-tree "$tree" -p "$parent" -m "another writer $n")
  git --git-dir="$ORIGIN" update-ref refs/heads/git-annex "$c"
fi
exit 0
`;
  writeFileSync(join(dir, "pre-push"), script);
  Bun.spawnSync(["chmod", "755", join(dir, "pre-push")]);
  const repo = workPaths(configDir, XX_RACE, digestOf(plan)).repo;
  const r = await runCommand(["git", "config", "core.hooksPath", dir], { cwd: repo });
  if (r.exitCode !== 0) throw new Error(`git config: ${r.stderr}`);
  return counter;
}

async function removeAnnexRace(plan: string): Promise<void> {
  const repo = workPaths(configDir, XX_RACE, digestOf(plan)).repo;
  await runCommand(["git", "config", "core.hooksPath", "/dev/null"], { cwd: repo });
}

function nonGetGitHub(): string[] {
  return gh.seen.filter((x) => x.method !== "GET").map((x) => `${x.method} ${x.path}`);
}

const XX_RACE = "xx099971";

/** The step a case starts from: the record as `--until <stage>` leaves it. */
type Stage = "prepared" | "copied" | "registered";

/**
 * The world at the end of one `--until` run: the refs, the bucket and its log, the database, the
 * CLI's `repull` directory (the plan, the working clone; permissions kept), and the API writes.
 */
interface StagePoint {
  plan: string;
  world: World;
  db: Uint8Array;
  repull: string;
  s3Log: S3Standin["log"];
  apiWrites: string[];
  /** The keys under the dataset's prefix before the run, for the case that diffs against them. */
  keysBefore: Set<string>;
}

/** Make `to` a copy of `from`, permissions included (annex objects are read-only). */
function copyRepullTree(from: string, to: string): void {
  Bun.spawnSync(["chmod", "-R", "u+w", to]);
  rmSync(to, { recursive: true, force: true });
  const r = Bun.spawnSync(["cp", "-a", from, to]);
  if (r.exitCode !== 0) throw new Error(`cp -a ${from} ${to}: ${r.stderr.toString()}`);
}

describe.skipIf(!awsInstalled)("execute through the pull request", () => {
  const XX = XX_RACE;
  let fx: RepullFixture;
  let world: World;
  // The cases that start from a record already at prepared, copied or registered do not each drive
  // the CLI up to it: each stage is reached once, from the fixture, by the real plan and the real
  // `execute --until <stage>` (the same single run those cases used to make), and a case is put
  // back at that point. The `--until` cases below still drive the CLI from the start themselves.
  const stages = new Map<Stage, StagePoint>();
  let stageDir = "";
  beforeAll(async () => {
    fx = await buildRepullFixture({ datasetId: XX, s3 });
    origins.set(XX, fx.originRepo);
    world = await snapshotWorld(fx);
    stageDir = mkdtempSync(join(tmpdir(), "nemar-repull-stages-"));
    for (const stage of ["prepared", "copied", "registered"] as const) {
      await restoreWorld(fx, world);
      const keysBefore = new Set(s3.keys("nemar", `${XX}/objects/`));
      const plan = await makePlan(fx);
      const run = await execute(fx, plan, ["--until", stage]);
      expect(run.exitCode, run.all).toBe(0);
      expect(repullRows()[0]?.status).toBe(stage);
      const repull = join(stageDir, `${stage}-repull`);
      copyRepullTree(join(configDir, "repull"), repull);
      stages.set(stage, {
        plan,
        world: await snapshotWorld(fx),
        db: db.serialize(),
        repull,
        s3Log: [...s3.log],
        apiWrites: [...apiWrites],
        keysBefore,
      });
    }
  });
  afterAll(() => {
    fx?.cleanup();
    if (stageDir) {
      Bun.spawnSync(["chmod", "-R", "u+w", stageDir]);
      rmSync(stageDir, { recursive: true, force: true });
    }
  });
  beforeEach(async () => restoreWorld(fx, world));

  /** Put the world where `execute --until <stage>` left it, and name the plan it ran. */
  async function atStage(stage: Stage): Promise<StagePoint> {
    const point = stages.get(stage);
    if (!point) throw new Error(`stage ${stage} was not reached`);
    await restoreRefs(fx.originRepo, point.world.origin);
    await restoreRefs(fx.upstreamRepo, point.world.upstream);
    s3.restore(point.world.s3);
    s3.log.push(...point.s3Log);
    apiWrites.length = 0;
    apiWrites.push(...point.apiWrites);
    apiHook = null;
    db = Database.deserialize(point.db);
    gh.reset();
    copyRepullTree(point.repull, join(configDir, "repull"));
    return point;
  }

  test("a full run reaches pr_open: copied by version, registered at nemar-s3 only, branch pushed, pull request opened", async () => {
    const plan = await makePlan(fx);
    const mainBefore = (await gitIn(fx.originRepo, ["rev-parse", "refs/heads/main"])).trim();
    const annexBefore = (await gitIn(fx.originRepo, ["rev-parse", "refs/heads/git-annex"])).trim();
    const protectedBefore = await protectedRefs(fx.originRepo);
    const run = await execute(fx, plan);
    expect(run.exitCode, run.all).toBe(0);

    const [row] = repullRows();
    expect(row).toMatchObject({ status: "pr_open", branch: "release/v2.0.0", last_error: null });
    const synth = row?.synth_sha as string;
    expect(row?.head_sha).toBe(synth);

    // release/v2.0.0 is the synthesized commit, whose only parent is main; main and every tag
    // are as they were.
    expect((await gitIn(fx.originRepo, ["rev-parse", "refs/heads/release/v2.0.0"])).trim()).toBe(
      synth,
    );
    expect((await gitIn(fx.originRepo, ["rev-parse", `${synth}^@`])).trim()).toBe(mainBefore);
    expect(await protectedRefs(fx.originRepo)).toBe(protectedBefore);

    // Every key the N.0.0 tree names is in the bucket at its declared size.
    const tree = await annexedKeys(fx.originRepo, synth);
    expect(tree.size).toBeGreaterThan(0);
    for (const key of tree.values()) {
      const size = Number(/-s(\d+)--/.exec(key)?.[1]);
      expect(s3.current("nemar", `${XX}/objects/${key}`)?.data.length).toBe(size);
    }
    // The added recording was copied at its pin: the stand-in's newer version has another header.
    const added = tree.get(PATHS.addedEdf) as string;
    expect(added).toBe(fx.keys.addedEdf);
    const pinned = s3
      .versions("openneuro.org", `${UPSTREAM_ID}/${PATHS.addedEdf}`)
      .find((v) => v.versionId === fx.pins.addedEdf);
    expect(
      Buffer.from(s3.current("nemar", `${XX}/objects/${added}`)?.data as Uint8Array).equals(
        Buffer.from(pinned?.data as Uint8Array),
      ),
    ).toBe(true);
    const copies = s3.calls("CopyObject");
    expect(copies.length).toBeGreaterThan(0);
    for (const c of copies) expect(c.copySource).toContain("?versionId=");

    // Origin's git-annex branch records nemar-s3 for every tree key.
    const annexAfter = (await gitIn(fx.originRepo, ["rev-parse", "refs/heads/git-annex"])).trim();
    const keys = [...new Set(tree.values())];
    const logs = await readLocationLogsAt(fx.originRepo, "refs/heads/git-annex", keys);
    keys.forEach((_k, i) => expect(presentIn(logs[i] ?? "").has(fx.nemarUuid)).toBe(true));

    // The registration published no presence for a repository NEMAR does not control: the holders
    // the working clone adopted from upstream's log for the copied recording are not on origin,
    // and every line it added names nemar-s3, or retires a repository the log already named.
    expect(
      (await gitIn(fx.originRepo, ["rev-list", "--count", `${annexBefore}..${annexAfter}`])).trim(),
    ).toBe("1");
    const foreign = presentIn(await upstreamLog(fx, added));
    expect(foreign.size).toBeGreaterThan(0);
    const addedLog = logs[keys.indexOf(added)] ?? "";
    for (const uuid of foreign) expect(addedLog).not.toContain(uuid);
    const { paths, added: lines } = await addedLogLines(fx.originRepo, annexBefore, annexAfter);
    expect(paths.every((p) => p.endsWith(".log") && p !== "uuid.log")).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
    for (const { line, before } of lines) {
      const [, status, uuid] = line.split(" ");
      expect(uuid === fx.nemarUuid || (status === "X" && before.has(uuid as string))).toBe(true);
    }

    // git-annex itself reads the registration: a fresh clone finds the copied recording at nemar-s3.
    const clone = join(mkdtempSync(join(tmpdir(), "nemar-repull-whereis-")), "c");
    // `git annex init` commits to the git-annex branch, so it needs an identity; a CI runner has
    // none, so the test brings its own through the environment, never a global config.
    const restoreIdentity = useTestGitIdentity();
    try {
      await runCommand(
        ["git", "clone", "-q", "--branch", "release/v2.0.0", fx.originRepo, clone],
        {},
      );
      const init = await runCommand(["git", "annex", "init", "-q", "check"], { cwd: clone });
      expect(init.exitCode, `git annex init in the fresh clone: ${init.stderr.trim()}`).toBe(0);
      // The precondition, whatever git-annex's version prints: the clone's own git-annex branch
      // (merged from origin's at init) holds the registration for the key.
      const [seen] = await readLocationLogsAt(clone, "refs/heads/git-annex", [added]);
      expect(
        presentIn(seen ?? "").has(fx.nemarUuid),
        `the fresh clone's git-annex branch does not record ${added} at nemar-s3 after init`,
      ).toBe(true);
      const where = await runCommand(["git", "annex", "whereis", "--json", "--key", added], {
        cwd: clone,
      });
      const said = where.stdout.trim();
      expect(
        where.exitCode === 0 && said !== "",
        `git annex whereis --json --key ${added} exited ${where.exitCode} and printed ${said === "" ? "nothing" : "output"}; stderr: ${where.stderr.trim()}`,
      ).toBe(true);
      let holders: { whereis: Array<{ uuid: string }> };
      try {
        holders = JSON.parse(said.split("\n")[0] as string);
      } catch {
        throw new Error(
          `git annex whereis --json --key ${added} printed unparseable output: ${said}`,
        );
      }
      expect(holders.whereis.map((w) => w.uuid)).toEqual([fx.nemarUuid]);
    } finally {
      restoreIdentity();
      Bun.spawnSync(["chmod", "-R", "u+w", join(clone, "..")]);
      rmSync(join(clone, ".."), { recursive: true, force: true });
    }

    // The pull request was opened with the administrator's token, never the Worker's, into main,
    // and its body names counts and the digest, never a path or a key.
    const opened = gh.seen.filter((s) => s.method === "POST" && s.path.endsWith("/pulls"));
    expect(opened).toHaveLength(1);
    expect(opened[0]?.token).toBe(ADMIN_TOKEN);
    expect(gh.seen.some((s) => s.token === WORKER_TOKEN && s.method !== "GET")).toBe(false);
    const body = String(opened[0]?.body?.body);
    expect(opened[0]?.body).toMatchObject({
      head: "release/v2.0.0",
      base: "main",
      title: "Release v2.0.0",
    });
    expect(body).toContain(`Upstream-Snapshot: ${UPSTREAM_ID}@${TAG_B}`);
    expect(body).toContain("Repull-Plan: sha256:");
    expect(body).toContain("never merges");
    expect(body).toContain(`nemar admin repull merge ${XX}`);
    // The two trailer lines the body tells the merger to end the squash message with are, line
    // for line, the trailers of the commit the pull request carries.
    const fenced = (body.split("```")[1] ?? "").trim().split("\n");
    const trailers = (
      await gitIn(fx.originRepo, ["log", "-1", "--format=%(trailers:only,unfold)", synth])
    )
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(fenced).toHaveLength(2);
    expect(fenced).toEqual(trailers);
    expect(body).toContain("The squash commit message must end with both trailers");
    for (const p of Object.values(PATHS)) expect(body).not.toContain(p);
    for (const k of keys) expect(body).not.toContain(k);
    expect(row?.pr_number).toBe(1);

    // The working directory, which held the unscrubbed originals, is gone; the plan file stays.
    const paths6 = workPaths(configDir, XX, JSON.parse(readFileSync(plan, "utf8")).digest);
    expect(existsSync(paths6.root)).toBe(false);
    expect(existsSync(paths6.lock)).toBe(false);
    expect(existsSync(plan)).toBe(true);
    // Merging is not execute's: nothing was merged.
    expect(gh.seen.some((s) => s.method === "PUT")).toBe(false);
  });
  for (const until of ["prepared", "copied", "registered"] as const) {
    test(`--until ${until} stops there, the next run reaches pr_open, and a third writes nothing`, async () => {
      const plan = await makePlan(fx);
      const annexBefore = (
        await gitIn(fx.originRepo, ["rev-parse", "refs/heads/git-annex"])
      ).trim();
      const first = await execute(fx, plan, ["--until", until]);
      expect(first.exitCode, first.all).toBe(0);
      expect(repullRows()[0]?.status).toBe(until);
      const annexNow = (await gitIn(fx.originRepo, ["rev-parse", "refs/heads/git-annex"])).trim();
      // Nothing of a later step happened: no copy before copied, no registration before
      // registered, and never a branch or a pull request before pr_open.
      expect(s3.calls("CopyObject").length > 0).toBe(until !== "prepared");
      expect(annexNow !== annexBefore).toBe(until === "registered");
      expect(await refsOf(fx.originRepo)).not.toContain("release/");
      expect(nonGetGitHub()).toEqual([]);

      const second = await execute(fx, plan);
      expect(second.exitCode, second.all).toBe(0);
      expect(repullRows()[0]?.status).toBe("pr_open");

      const before = {
        api: apiWrites.length,
        s3: s3Writes().length,
        gh: nonGetGitHub().length,
        origin: await refsOf(fx.originRepo),
      };
      const third = await execute(fx, plan);
      expect(third.exitCode, third.all).toBe(0);
      expect(third.stdout).toContain("pr_open");
      expect(apiWrites.length).toBe(before.api);
      expect(s3Writes().length).toBe(before.s3);
      expect(nonGetGitHub().length).toBe(before.gh);
      expect(await refsOf(fx.originRepo)).toBe(before.origin);
      expect(repullRows()).toHaveLength(1);
    });
  }

  test("killed while a copy hangs, the next run takes the lock over and completes", async () => {
    const plan = await makePlan(fx);
    // Held until this test ends the hold, below; its bound is a backstop no passing run reaches.
    // An 8-second hold used to end on its own, and the test sat out whatever was left of it.
    s3.holdNext("CopyObject", 120_000);
    const proc = startCli(fx, ["execute", plan, "--yes"]);
    const settled = () =>
      s3.holding() === 0 && s3.calls("CopyObject").length === s3.opCount("CopyObject");
    try {
      const deadline = Date.now() + 240_000;
      while (s3.holding() === 0 && Date.now() < deadline) await Bun.sleep(50);
      expect(s3.holding()).toBe(1);
      proc.kill("SIGKILL");
      await proc.exited;
      expect(repullRows()[0]?.status).toBe("prepared");
      const run = await execute(fx, plan);
      expect(run.exitCode, run.all).toBe(0);
      expect(repullRows()[0]).toMatchObject({ status: "pr_open", last_error: null });
    } finally {
      // The killed run's copy is still held: the CLI's aws child outlives the kill and keeps its
      // connection open, so the stand-in never sees its client go. End the hold, then wait for
      // that observable end, every call the stand-in counted being logged, so it cannot land
      // after the next test restores the stand-in.
      s3.releaseHolds();
      const until = Date.now() + 15_000;
      while (!settled() && Date.now() < until) await Bun.sleep(50);
    }
    expect(settled()).toBe(true);
  });

  test("a pull request GitHub answered 500 for is opened by the next run", async () => {
    const plan = await makePlan(fx);
    gh.createPullFaults.push({ status: 500 });
    const first = await execute(fx, plan);
    expect(first.exitCode, first.all).toBe(3);
    const [row] = repullRows();
    expect(row?.status).toBe("registered");
    expect(row?.last_error).toStartWith("[pr:pr-create-unknown]");
    expect((await gitIn(fx.originRepo, ["rev-parse", "refs/heads/release/v2.0.0"])).trim()).toBe(
      row?.synth_sha as string,
    );
    const second = await execute(fx, plan);
    expect(second.exitCode, second.all).toBe(0);
    expect(repullRows()[0]).toMatchObject({ status: "pr_open", pr_number: 1, last_error: null });
    expect(Object.keys(gh.pulls)).toEqual([`${XX}#1`]);
  });

  test("a pull request opened while its answer was lost is found by the next run, not opened twice", async () => {
    const plan = await makePlan(fx);
    gh.createPullFaults.push({ status: 502, applied: true });
    const first = await execute(fx, plan);
    expect(first.exitCode, first.all).toBe(3);
    expect(Object.keys(gh.pulls)).toEqual([`${XX}#1`]);
    const second = await execute(fx, plan);
    expect(second.exitCode, second.all).toBe(0);
    expect(second.all).toContain("Found pull request #1");
    expect(repullRows()[0]).toMatchObject({ status: "pr_open", pr_number: 1 });
    expect(gh.seen.filter((x) => x.method === "POST" && x.path.endsWith("/pulls"))).toHaveLength(1);
  });

  test("another release pull request open refuses release-pr-open, and opens nothing", async () => {
    const { plan } = await atStage("registered");
    gh.pulls[`${XX}#9`] = { sha: "1".repeat(40), headRef: "release/v1.1.0" };
    const run = await execute(fx, plan);
    expect(run.exitCode, run.all).toBe(3);
    expect(repullRows()[0]?.last_error).toStartWith("[pr:release-pr-open]");
    expect(gh.seen.filter((x) => x.method === "POST")).toEqual([]);
  });

  test("a release branch enrichment moved is reused; one holding another commit is branch-foreign", async () => {
    const { plan } = await atStage("registered");
    const synth = repullRows()[0]?.synth_sha as string;
    const work = workPaths(configDir, XX, digestOf(plan)).repo;
    const ref = "refs/heads/release/v2.0.0";
    // The branch as a push of the synthesized commit leaves it, then a commit of someone else's.
    await runCommand(["git", "push", "-q", fx.originRepo, `${synth}:${ref}`], { cwd: work });
    await commitOnto(fx.originRepo, ref, "README.md", "A change made on the release branch.\n");
    const foreign = await execute(fx, plan);
    expect(foreign.exitCode, foreign.all).toBe(3);
    expect(repullRows()[0]).toMatchObject({ status: "registered" });
    expect(repullRows()[0]?.last_error).toStartWith("[pr:branch-foreign]");
    expect(gh.seen.filter((x) => x.method === "POST")).toEqual([]);

    // Back at the synthesized commit, then the commit enrichment makes on every release push.
    await gitIn(fx.originRepo, ["update-ref", ref, synth]);
    const enriched = await commitOnto(
      fx.originRepo,
      ref,
      ".nemar/metadata.json",
      await enrichedMetadata(fx.originRepo, synth),
    );
    const run = await execute(fx, plan);
    expect(run.exitCode, run.all).toBe(0);
    expect(run.all).toContain("moved by enrichment");
    expect(repullRows()[0]).toMatchObject({
      status: "pr_open",
      head_sha: enriched,
      last_error: null,
    });
    expect((await gitIn(fx.originRepo, ["rev-parse", ref])).trim()).toBe(enriched);
  });

  test("main moved by a README commit is main-moved before the push; by an enrichment commit it is not", async () => {
    const { plan } = await atStage("copied");
    const main = (await gitIn(fx.originRepo, ["rev-parse", "refs/heads/main"])).trim();
    await commitOnto(fx.originRepo, "refs/heads/main", "README.md", "Edited after the copy.\n");
    const moved = await execute(fx, plan);
    expect(moved.exitCode, moved.all).toBe(3);
    expect(repullRows()[0]?.status).toBe("registered");
    expect(repullRows()[0]?.last_error).toStartWith("[pr:main-moved]");
    expect(await refsOf(fx.originRepo)).not.toContain("release/");
    expect(gh.seen.filter((x) => x.method === "POST")).toEqual([]);

    await gitIn(fx.originRepo, ["update-ref", "refs/heads/main", main]);
    await commitOnto(
      fx.originRepo,
      "refs/heads/main",
      ".nemar/metadata.json",
      await enrichedMetadata(fx.originRepo, main),
    );
    const run = await execute(fx, plan);
    expect(run.exitCode, run.all).toBe(0);
    expect(repullRows()[0]?.status).toBe("pr_open");
  });

  test("a key the tree names that the bucket lacks refuses held-key-absent before anything is pushed", async () => {
    const { plan } = await atStage("copied");
    const annex = (await gitIn(fx.originRepo, ["rev-parse", "refs/heads/git-annex"])).trim();
    // The location log says nemar-s3 holds it; the bucket does not (#1396).
    s3.putDeleteMarker("nemar", `${XX}/objects/${fx.keys.flaggedNemar}`);
    const run = await execute(fx, plan);
    expect(run.exitCode, run.all).toBe(3);
    expect(repullRows()[0]?.status).toBe("copied");
    expect(repullRows()[0]?.last_error).toStartWith("[register:held-key-absent]");
    expect((await gitIn(fx.originRepo, ["rev-parse", "refs/heads/git-annex"])).trim()).toBe(annex);
    expect(await refsOf(fx.originRepo)).not.toContain("release/");
    expect(gh.seen.filter((x) => x.method === "POST")).toEqual([]);
  });

  test("a pinned version upstream stopped serving refuses pin-absent and leaves the record prepared with why", async () => {
    const { plan } = await atStage("prepared");
    s3.dropVersion("openneuro.org", `${UPSTREAM_ID}/${PATHS.addedEdf}`, fx.pins.addedEdf as string);
    const run = await execute(fx, plan);
    expect(run.exitCode, run.all).toBe(3);
    const [row] = repullRows();
    expect(row?.status).toBe("prepared");
    expect(row?.last_error).toStartWith("[copy:pin-absent]");
    expect(await refsOf(fx.originRepo)).not.toContain("release/");
  });

  test("an object prepare uploaded that is gone by the copy refuses copy-unverified, and nothing is registered", async () => {
    const prefix = `${XX}/objects/`;
    const { plan, keysBefore: before } = await atStage("prepared");
    const uploaded = s3.keys("nemar", prefix).filter((k) => !before.has(k));
    expect(uploaded.length).toBeGreaterThan(0);
    s3.putDeleteMarker("nemar", uploaded[0] as string);
    const annex = (await gitIn(fx.originRepo, ["rev-parse", "refs/heads/git-annex"])).trim();
    const run = await execute(fx, plan);
    expect(run.exitCode, run.all).toBe(3);
    expect(repullRows()[0]?.status).toBe("prepared");
    expect(repullRows()[0]?.last_error).toStartWith("[copy:copy-unverified]");
    expect((await gitIn(fx.originRepo, ["rev-parse", "refs/heads/git-annex"])).trim()).toBe(annex);
  });

  test("an upstream tag that moved since the plan refuses upstream-tag-moved", async () => {
    const { plan } = await atStage("copied");
    await gitIn(fx.upstreamRepo, ["tag", "-f", TAG_B, TAG_A]);
    const run = await execute(fx, plan);
    expect(run.exitCode, run.all).toBe(3);
    expect(repullRows()[0]?.last_error).toStartWith("[register:upstream-tag-moved]");
  });

  test("an upstream tag that moves after the plan was checked refuses at the copy, before anything is written to S3", async () => {
    const plan = await makePlan(fx);
    // The tag moves just after the record reaches prepared, which is when the copy step begins.
    apiHook = async (req) => {
      if (req.method === "POST" && new URL(req.url).pathname.endsWith("/transition")) {
        if ((await req.text()).includes('"to":"prepared"')) {
          await gitIn(fx.upstreamRepo, ["tag", "-f", TAG_B, TAG_A]);
        }
      }
    };
    const run = await execute(fx, plan);
    expect(run.exitCode, run.all).toBe(3);
    expect(repullRows()[0]?.status).toBe("prepared");
    expect(repullRows()[0]?.last_error).toStartWith("[copy:upstream-tag-moved]");
    expect(s3.calls("CopyObject")).toEqual([]);
    expect(s3.keys("nemar", `${XX}/staging/`)).toEqual([]);
  });

  test("an upstream tag that moved before the pull request step refuses there, with no branch pushed and no pull request", async () => {
    const { plan } = await atStage("registered");
    await gitIn(fx.upstreamRepo, ["tag", "-f", TAG_B, TAG_A]);
    const run = await execute(fx, plan);
    expect(run.exitCode, run.all).toBe(3);
    expect(repullRows()[0]?.status).toBe("registered");
    expect(repullRows()[0]?.last_error).toStartWith("[pr:upstream-tag-moved]");
    expect(await refsOf(fx.originRepo)).not.toContain("release/");
    expect(gh.seen.filter((x) => x.method === "POST")).toEqual([]);
  });

  test("a copy manifest that is not the one recorded at prepared refuses manifest-mismatch before any copy", async () => {
    const { plan } = await atStage("prepared");
    db.run("UPDATE upstream_repulls SET manifest_digest = ?", [`sha256:${"0".repeat(64)}`]);
    const run = await execute(fx, plan);
    expect(run.exitCode, run.all).toBe(3);
    expect(repullRows()[0]?.status).toBe("prepared");
    expect(repullRows()[0]?.last_error).toStartWith("[copy:manifest-mismatch]");
    expect(s3.calls("CopyObject")).toEqual([]);
    expect(s3.keys("nemar", `${XX}/staging/`)).toEqual([]);
  });

  test("a remote.log that names another prefix than <id>/objects/ cannot move the write boundary", async () => {
    const { plan } = await atStage("prepared");
    const work = workPaths(configDir, XX, digestOf(plan)).repo;
    await rewriteRemoteLog(work, `fileprefix=${XX}/objects/`, "fileprefix=nm000103/objects/");
    s3.log.length = 0;
    const run = await execute(fx, plan);
    expect(run.exitCode, run.all).toBe(3);
    expect(repullRows()[0]?.last_error).toStartWith("[copy:destination-prefix]");
    // Refused before any write, and nothing was ever aimed at the other dataset.
    expect(s3Writes()).toEqual([]);
    expect(s3.log.some((e) => e.key.startsWith("nm000103/"))).toBe(false);
  });

  test("a git-annex branch that moves between the registration's fetch and its push is written again on top, and proved", async () => {
    const { plan } = await atStage("copied");
    const before = (await gitIn(fx.originRepo, ["rev-parse", "refs/heads/git-annex"])).trim();
    const counter = await installAnnexRace(fx, plan, 1);
    const run = await execute(fx, plan, ["--until", "registered"]);
    expect(run.exitCode, run.all).toBe(0);
    expect(readFileSync(counter, "utf8").trim()).toBe("2");
    expect(repullRows()[0]).toMatchObject({ status: "registered", last_error: null });
    // The racing commit is in origin's history, with the registration on top of it.
    expect(
      (
        await gitIn(fx.originRepo, ["rev-list", "--count", `${before}..refs/heads/git-annex`])
      ).trim(),
    ).toBe("2");
    const tree = await annexedKeys(
      workPaths(configDir, XX, digestOf(plan)).repo,
      repullRows()[0]?.synth_sha as string,
    );
    const keys = [...new Set(tree.values())];
    const logs = await readLocationLogsAt(fx.originRepo, "refs/heads/git-annex", keys);
    keys.forEach((_k, i) => expect(presentIn(logs[i] ?? "").has(fx.nemarUuid)).toBe(true));
  });

  test("a git-annex branch that moves under every registration push stops at the cap, leaves the record copied, and a later run completes", async () => {
    const { plan } = await atStage("copied");
    const counter = await installAnnexRace(fx, plan, 100);
    const run = await execute(fx, plan, ["--until", "registered"]);
    expect(run.exitCode, run.all).toBe(3);
    // Exactly three pushes were tried: the cap.
    expect(readFileSync(counter, "utf8").trim()).toBe("3");
    expect(repullRows()[0]?.status).toBe("copied");
    expect(repullRows()[0]?.last_error).toStartWith("[register:registration-push-rejected]");
    await removeAnnexRace(plan);
    const again = await execute(fx, plan, ["--until", "registered"]);
    expect(again.exitCode, again.all).toBe(0);
    expect(repullRows()[0]).toMatchObject({ status: "registered", last_error: null });
  });

  test("a registration origin undoes after accepting it is caught by the proof, not reported as done", async () => {
    const { plan } = await atStage("copied");
    // Origin accepts the push, then puts its git-annex branch back where it was.
    const hookFile = join(fx.originRepo, "hooks", "post-receive");
    mkdirSync(join(fx.originRepo, "hooks"), { recursive: true });
    writeFileSync(
      hookFile,
      `#!/bin/sh\nwhile read old new ref; do\n  if [ "$ref" = refs/heads/git-annex ]; then git update-ref refs/heads/git-annex "$old"; fi\ndone\n`,
    );
    Bun.spawnSync(["chmod", "755", hookFile]);
    try {
      const run = await execute(fx, plan, ["--until", "registered"]);
      expect(run.exitCode, run.all).toBe(3);
      expect(repullRows()[0]?.status).toBe("copied");
      expect(repullRows()[0]?.last_error).toStartWith("[register:registration-unproven]");
    } finally {
      rmSync(hookFile, { force: true });
    }
    const again = await execute(fx, plan, ["--until", "registered"]);
    expect(again.exitCode, again.all).toBe(0);
  });

  test("a run that finds the record already at pr_open removes the working clone a killed run left behind", async () => {
    const plan = await makePlan(fx);
    const paths = workPaths(configDir, XX, digestOf(plan));
    const kept = await execute(fx, plan, ["--keep-workdir"]);
    expect(kept.exitCode, kept.all).toBe(0);
    expect(existsSync(paths.repo)).toBe(true);
    const writes = { api: apiWrites.length, s3: s3Writes().length, gh: nonGetGitHub().length };
    // The early return at pr_open: nothing is written, and the clone goes.
    const later = await execute(fx, plan);
    expect(later.exitCode, later.all).toBe(0);
    expect(existsSync(paths.root)).toBe(false);
    expect(apiWrites.length).toBe(writes.api);
    expect(s3Writes().length).toBe(writes.s3);
    expect(nonGetGitHub().length).toBe(writes.gh);
    // Asked to keep it, a run that finds pr_open leaves it where it is.
    mkdirSync(paths.repo, { recursive: true });
    const keep = await execute(fx, plan, ["--keep-workdir"]);
    expect(keep.exitCode, keep.all).toBe(0);
    expect(existsSync(paths.repo)).toBe(true);
  });

  test("a dataset that became anonymous is refused before anything, on a record past prepared too", async () => {
    const { plan } = await atStage("copied");
    // An unpublished row may be made anonymous (ADR 0065); the record is past prepared already.
    db.run("UPDATE datasets SET first_published_at = NULL, anonymous = 1 WHERE dataset_id = ?", [
      XX,
    ]);
    apiWrites.length = 0;
    s3.log.length = 0;
    const run = await execute(fx, plan);
    expect(run.exitCode, run.all).toBe(1);
    expect(run.all).toContain("anonymous-dataset");
    expect(apiWrites).toEqual([]);
    expect(s3Writes()).toEqual([]);
    expect(repullRows()[0]).toMatchObject({ status: "copied", last_error: null });
  });

  test("without --yes and no terminal it asks, cannot, and writes nothing; --until past pr_open is a usage error", async () => {
    const plan = await makePlan(fx);
    const asked = await runCli(fx, ["execute", plan]);
    expect(asked.exitCode, asked.all).toBe(1);
    expect(asked.all).toContain("declined");
    expect(repullRows()).toEqual([]);
    expect(apiWrites).toEqual([]);
    const usage = await runCli(fx, ["execute", plan, "--until", "gates_clear", "--yes"]);
    expect(usage.exitCode).toBe(1);
    expect(usage.all).toContain("--until");
    expect(repullRows()).toEqual([]);
  });
});

describe.skipIf(!awsInstalled)("what a scrubbed delta pushes", () => {
  const XX = "xx099972";
  let fx: RepullFixture;
  beforeAll(async () => {
    fx = await buildRepullFixture({
      datasetId: XX,
      s3,
      flaggedAddedEdf: true,
      identifierJsonB: true,
    });
    origins.set(XX, fx.originRepo);
    await restoreWorld(fx, await snapshotWorld(fx));
  });
  afterAll(() => fx?.cleanup());

  test("the pushed objects and the checkpoint hold none of the original bytes; the replaced key is dead", async () => {
    const plan = await makePlan(fx);
    const original = (
      await gitIn(fx.upstreamRepo, ["rev-parse", `${TAG_B}:${PATHS.addedIdentifierJson}`])
    ).trim();
    const run = await execute(fx, plan);
    expect(run.exitCode, run.all).toBe(0);
    const [row] = repullRows();
    const synth = row?.synth_sha as string;

    // The sidecar was blanked before the commit, and its original blob never reached origin.
    const pushed = (
      await gitIn(fx.originRepo, ["rev-parse", `${synth}:${PATHS.addedIdentifierJson}`])
    ).trim();
    expect(pushed).not.toBe(original);
    const has = await runCommand(["git", "cat-file", "-e", original], { cwd: fx.originRepo });
    expect(has.exitCode).not.toBe(0);

    // Nor is it in the checkpoint bundle: fetched into a clone of origin, it brings no such object.
    const bundle = workPaths(configDir, XX, digestOf(plan)).bundle;
    expect(existsSync(bundle)).toBe(true);
    const scratch = mkdtempSync(join(tmpdir(), "nemar-repull-bundle-"));
    try {
      const clone = join(scratch, "c.git");
      await runCommand(["git", "clone", "-q", "--bare", fx.originRepo, clone], {});
      const fetched = await runCommand(
        ["git", "fetch", "-q", bundle, "+refs/heads/*:refs/bundle/*"],
        { cwd: clone },
      );
      expect(fetched.exitCode, fetched.stderr).toBe(0);
      expect(
        (await runCommand(["git", "cat-file", "-e", original], { cwd: clone })).exitCode,
      ).not.toBe(0);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }

    // The flagged recording was re-keyed: upstream's key was never copied, it is dead on origin,
    // and the new key is in the bucket and at nemar-s3.
    const upstreamKey = fx.keys.addedEdf;
    expect(s3.calls("CopyObject").some((c) => c.key.endsWith(upstreamKey))).toBe(false);
    expect(s3.current("nemar", `${XX}/objects/${upstreamKey}`)).toBeUndefined();
    const tree = await annexedKeys(fx.originRepo, synth);
    const rekeyed = tree.get(PATHS.addedEdf) as string;
    expect(rekeyed).not.toBe(upstreamKey);
    const [deadLog, newLog] = await readLocationLogsAt(fx.originRepo, "refs/heads/git-annex", [
      upstreamKey,
      rekeyed,
    ]);
    expect(isDead(deadLog ?? "")).toBe(true);
    expect(presentIn(deadLog ?? "").size).toBe(0);
    expect(presentIn(newLog ?? "").has(fx.nemarUuid)).toBe(true);
    expect(s3.current("nemar", `${XX}/objects/${rekeyed}`)).toBeDefined();
    // Every repository the dead mark names is nemar-s3: origin's log never knew this upstream key.
    for (const line of (deadLog ?? "").split("\n").filter(Boolean)) {
      expect(line.split(" ")[2]).toBe(fx.nemarUuid);
    }
    expect(hashDirLower(upstreamKey)).toMatch(/^[0-9a-f]{3}\/[0-9a-f]{3}\/$/);
  });
});
