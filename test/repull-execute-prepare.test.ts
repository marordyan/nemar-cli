/**
 * Executing a reviewed re-pull plan through `prepared` (ADR 0111, decisions 2, 3, 8 and 9; epic
 * #1046 phase 6, #1912): `executeRepull`, the library entry `nemar admin repull execute` will call.
 *
 * Everything NEMAR's is real. The mirror and its upstream are the real git and git-annex
 * repositories of `test/helpers/repull-fixture.ts`, made by the real import step, served as bare
 * `file://` origins and reached through the planner's absolute-path test bases. The NEMAR API is
 * the REAL datasets and `/admin/repulls` routers over bun:sqlite with every migration applied,
 * served on a local port; the API client reaches it through the API URL override, set to that port
 * for this file and restored after. S3 is the scrub's stand-in (`test/scrub/helpers/s3-standin.ts`)
 * driven by the REAL `aws` CLI for NEMAR's bucket and read over plain HTTP for upstream's pinned
 * objects. GitHub (the release-pr check's one listing) and OpenNeuro's snapshot query are the
 * suites' `Bun.serve()` stand-ins. No mocks.
 *
 * What only the canary or the production runs can check, because only stand-ins answer here: that
 * an anonymous ranged GET of `openneuro.org` at `?versionId=` answers as the stand-in does (measured
 * once for one object, ADR 0111's Phase 6 amendment), that `aws s3 sync` and `list-objects-v2`
 * against the real bucket behave as against the stand-in, and how GitHub lists open pull requests.
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
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { which } from "bun";
import { hashApiKey } from "../backend/src/services/token";
import type { Bindings } from "../backend/src/types/bindings";
import { freshDb, realD1 } from "../backend/test/helpers/d1";
import { makeRepullApp } from "../backend/test/helpers/repull-app";
import { hashDirLower, isDead } from "../scripts/scrub/git/git-lib";
import { EDF_HEADER_BYTES } from "../shared/identifier-scan";
import { PROVENANCE_NOTE_KEY } from "../shared/privacy-correction-text";
import { repullTrailerLines } from "../shared/repull-squash";
import { getApiUrl } from "../src/lib/api/client";
import { runCommand } from "../src/lib/git-annex/run-command";
import { listAnnexedKeys } from "../src/lib/git-annex/transfer";
import { OPENNEURO_UPSTREAM_MARKER } from "../src/lib/import-markers";
import { httpUpstreamReader } from "../src/lib/import-scrub";
import { awsCliUpload } from "../src/lib/normalize-dataset";
import { defaultPlanPath, readPlanFile, writePlanFile } from "../src/lib/repull/digest";
import { commitMaterialized, materializeDelta } from "../src/lib/repull/execute/materialize";
import {
  type ExecuteOptions,
  executeRepull,
  upstreamObjectsBase,
} from "../src/lib/repull/execute/run";
import { scrubDelta } from "../src/lib/repull/execute/scrub-delta";
import { ExecuteRefused, readExecutablePlan } from "../src/lib/repull/execute/verify-plan";
import { removeTree, workClone, workPaths } from "../src/lib/repull/execute/workdir";
import { type PlanOptions, planRepull } from "../src/lib/repull/plan";
import {
  ADMIN_TOKEN,
  type GitHubStandin,
  WORKER_TOKEN,
  startGitHubStandin,
} from "./helpers/github-standin";
import {
  CONCEPT_DOI,
  type LatestSnapshotStandin,
  NEMAR_ID,
  PATHS,
  type RepullFixture,
  TAG_A,
  TAG_B,
  UPSTREAM_ID,
  buildRepullFixture,
  gitIn,
  refsOf,
  startLatestSnapshotStandin,
  writeAnnexBranchFile,
} from "./helpers/repull-fixture";
import { toolOrFail } from "./scrub/helpers/require-tools";
import { type S3Standin, startS3Standin } from "./scrub/helpers/s3-standin";

setDefaultTimeout(300_000);

const awsInstalled = toolOrFail("aws", which("aws") !== null);

const ADMIN_KEY = "repull-execute-admin-key-0123456789abcdef0123456789ab";
const XX_A = "xx099991";
const XX_B = "xx099992";
const XX_C = "xx099993";
const XX_D = "xx099994";
const XX_E = "xx099995";
const XX_F = "xx099996";
const XX_G = "xx099997";
const XX_H = "xx099998";
const XX_I = "xx099990";
const REGION = "us-east-2";

let gh: GitHubStandin;
let openNeuro: LatestSnapshotStandin;
let s3: S3Standin;
let apiServer: ReturnType<typeof Bun.serve>;
let db: Database;
let configDir: string;
let environment = "test";
const handle = makeRepullApp();
/** Every request to the API that is not a GET, in order. */
const apiWrites: string[] = [];
/** When set, the API answers every transition 503, as a Worker that cannot be reached would. */
let failTransitions = false;
const saved: Record<string, string | undefined> = {};

function bindings(): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: environment,
    GITHUB_ADMIN_PAT: WORKER_TOKEN,
    API_BASE_URL: "https://api.test.nemar.org",
  } as Bindings;
}

/** Set a process variable for this file, remembering what it was. */
function setEnv(name: string, value: string): void {
  if (!(name in saved)) saved[name] = process.env[name];
  process.env[name] = value;
}

beforeAll(() => {
  gh = startGitHubStandin();
  openNeuro = startLatestSnapshotStandin(TAG_B);
  s3 = startS3Standin({ region: REGION });
  // The versions route reads the description through GitHub; the stand-in answers it 404.
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = gh.url;
  apiServer = Bun.serve({
    port: 0,
    fetch: (req) => {
      const path = new URL(req.url).pathname;
      apiWrites.push(...(req.method === "GET" ? [] : [`${req.method} ${path}`]));
      if (failTransitions && path.endsWith("/transition")) {
        return Response.json({ error: "Service Unavailable" }, { status: 503 });
      }
      return handle(req, bindings());
    },
  });
  configDir = mkdtempSync(join(tmpdir(), "nemar-repull-execute-"));
  // The API client and the config directory are read from the process environment.
  setEnv("TEST_API_URL", `http://127.0.0.1:${apiServer.port}`);
  setEnv("NEMAR_CONFIG_DIR", configDir);
  // The aws CLI reads the process environment too: the stand-in, and nothing of the host's setup.
  const home = join(configDir, "aws-home");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config"), `[profile repull-execute-test]\nregion = ${REGION}\n`);
  writeFileSync(join(home, "credentials"), "");
  for (const [k, v] of Object.entries({
    AWS_ACCESS_KEY_ID: "ASIATESTDUMMY000001",
    AWS_SECRET_ACCESS_KEY: "dummySecretAccessKeyForRepullExecuteTest",
    AWS_SESSION_TOKEN: "dummy-session-token-for-repull-execute-test",
    AWS_CONFIG_FILE: join(home, "config"),
    AWS_SHARED_CREDENTIALS_FILE: join(home, "credentials"),
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_MAX_ATTEMPTS: "1",
    AWS_ENDPOINT_URL_S3: s3.url,
    AWS_PROFILE: "repull-execute-test",
  })) {
    setEnv(k, v);
  }
});

afterAll(() => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) Reflect.deleteProperty(process.env, k);
    else process.env[k] = v;
  }
  apiServer?.stop(true);
  gh?.stop();
  openNeuro?.stop();
  s3?.stop();
  removeTree(configDir);
});

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
             ?, 'openneuro', ?, ?, ?)`,
    [
      id,
      `nemarDatasets/${id}`,
      // An anonymous deposit is never stamped first-published (ADR 0065).
      o.anonymous ? null : "2026-01-01 00:00:00",
      UPSTREAM_ID,
      CONCEPT_DOI,
      o.anonymous ? 1 : 0,
    ],
  );
  db.run(
    `INSERT INTO dataset_versions (dataset_id, version, doi, provider, created_at, source_version, source_version_basis)
     VALUES (?, '1.0.0', ?, 'ezid', '2026-01-01 00:00:00', ?, 'doi')`,
    [id, `10.82901/nemar.${id}.v1.0.0`, TAG_A],
  );
}

/** Every table's rows, for the "nothing changed" check (a token's last use is the API's bookkeeping). */
function dump(): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  const tables = db
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>;
  for (const { name } of tables) {
    const rows = db.query(`SELECT * FROM "${name}"`).all() as Array<Record<string, unknown>>;
    out[name] = name === "tokens" ? rows.map(({ last_used_at: _t, ...r }) => r) : rows;
  }
  return out;
}

type Row = Record<string, unknown> & { id: number; status: string; counts: string };

function repullRows(): Row[] {
  return db.query("SELECT * FROM upstream_repulls ORDER BY id").all() as Row[];
}

/** The plan as `nemar admin repull plan` makes it, written where it writes it. */
async function makePlan(fx: RepullFixture, over: Partial<PlanOptions> = {}): Promise<string> {
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
      environment: getApiUrl(),
      workRoot: scratch,
      openNeuroGraphqlUrl: openNeuro.url,
      ...over,
    });
    if (!out.planned) throw new Error(`not planned: ${out.reason}`);
    const path = defaultPlanPath(configDir, fx.datasetId, TAG_B, out.file.digest);
    writePlanFile(path, out.file);
    return path;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function execEnv(fx: RepullFixture): Record<string, string | undefined> {
  return {
    ...process.env,
    ...fx.env,
    GH_TOKEN: ADMIN_TOKEN,
    NEMAR_GITHUB_API_URL: gh.url,
    NEMAR_REPULL_OPENNEURO_URL: openNeuro.url,
    NEMAR_REPULL_UPSTREAM_OBJECTS_BASE: s3.url,
  };
}

async function execute(
  fx: RepullFixture,
  planPath: string,
  over: Partial<ExecuteOptions> = {},
): Promise<{ result: Awaited<ReturnType<typeof executeRepull>>; lines: string[] }> {
  const lines: string[] = [];
  // The prepare half: execution's own default goes on to the pull request (repull-execute-cli).
  const result = await executeRepull({
    planPath,
    env: execEnv(fx),
    out: (l) => lines.push(l),
    until: "prepared",
    ...over,
  });
  return { result, lines };
}

async function refusal(p: Promise<unknown>): Promise<ExecuteRefused> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ExecuteRefused) return err;
    throw err;
  }
  throw new Error("expected a refusal");
}

/** The S3 stand-in's requests that are not reads. */
function s3Writes(): number {
  return s3.log.filter((e) => !["GetObject", "HeadObject", "ListObjectsV2"].includes(e.op)).length;
}

/** Commit one file onto a bare repository's branch, by plumbing (a push to NEMAR's main). */
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
    return before;
  } finally {
    rmSync(index, { recursive: true, force: true });
  }
}

async function show(repo: string, spec: string): Promise<string> {
  return gitIn(repo, ["show", spec]);
}

/** A fresh database, no plan or work directory, and empty stand-in logs. */
async function reset(): Promise<void> {
  apiWrites.length = 0;
  failTransitions = false;
  db = freshDb();
  environment = "test";
  gh.reset();
  s3.log.length = 0;
  removeTree(join(configDir, "repull"));
  await seedAdmin();
}

// ---------------------------------------------------------------------------------------------
// S0: the plan file, proved and made again from live sources
// ---------------------------------------------------------------------------------------------

describe.skipIf(!awsInstalled)("the reviewed plan, before anything is written", () => {
  let fx: RepullFixture;
  beforeAll(async () => {
    fx = await buildRepullFixture({ datasetId: XX_A, s3 });
  });
  afterAll(() => fx?.cleanup());
  beforeEach(reset);

  async function nothingWritten(fn: () => Promise<unknown>): Promise<void> {
    const before = {
      db: dump(),
      origin: await refsOf(fx.originRepo),
      upstream: await refsOf(fx.upstreamRepo),
      s3: s3Writes(),
    };
    await fn();
    expect(dump()).toEqual(before.db);
    expect(await refsOf(fx.originRepo)).toBe(before.origin);
    expect(await refsOf(fx.upstreamRepo)).toBe(before.upstream);
    expect(s3Writes()).toBe(before.s3);
    expect(gh.seen.filter((s) => s.method !== "GET")).toEqual([]);
  }

  test("a body byte edited is plan-tampered, and nothing anywhere changes", async () => {
    seedMirror(XX_A);
    const path = await makePlan(fx);
    const text = readFileSync(path, "utf8");
    writeFileSync(path, text.replace('"unexplained": 3', '"unexplained": 0'));
    await nothingWritten(async () => {
      const err = await refusal(execute(fx, path));
      expect(err.code).toBe("plan-tampered");
    });
  });

  test("a plan of the previous planner is refused as made under other rules", async () => {
    seedMirror(XX_A);
    const path = await makePlan(fx);
    writeFileSync(path, readFileSync(path, "utf8").replace('"planner": 2', '"planner": 1'));
    const err = await refusal(execute(fx, path));
    expect(err.code).toBe("planner-version");
    expect(repullRows()).toEqual([]);
  });

  test("the file's executable is never read: the live answer decides, both ways", async () => {
    seedMirror(XX_A);
    const path = await makePlan(fx);
    // The file says no, the live plan says yes: it proceeds (to the record).
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace('"executable": true', '"executable": false'),
    );
    expect(readPlanFile(readFileSync(path, "utf8")).digest).toBe(
      JSON.parse(readFileSync(path, "utf8")).digest,
    );
    const { result } = await execute(fx, path, { until: "planned" });
    expect(result.stoppedAt).toBe("planned");
    expect(repullRows()).toHaveLength(1);

    // The file says yes, and the live release-pr check finds an open release pull request.
    db = freshDb();
    await seedAdmin();
    seedMirror(XX_A);
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace('"executable": false', '"executable": true'),
    );
    gh.pulls[`${XX_A}#7`] = { sha: "1".repeat(40), headRef: "release/v2.0.0" };
    await nothingWritten(async () => {
      const err = await refusal(execute(fx, path));
      expect(err.code).toBe("not-executable");
      expect(err.message).toContain("release-pr-open");
    });
  });

  test("a plan from test bases does not run against the real remotes, nor in another API", async () => {
    seedMirror(XX_A);
    const path = await makePlan(fx);
    // No test base: the plan's remotes would be the real ones. Refused before any read of them.
    const lines: string[] = [];
    const bare = Object.fromEntries(
      Object.entries(execEnv(fx)).filter(
        ([k]) => !(k in fx.env) && k !== "NEMAR_REPULL_OPENNEURO_URL",
      ),
    );
    const err = await refusal(
      executeRepull({ planPath: path, env: bare, out: (l) => lines.push(l) }),
    );
    expect(err.code).toBe("plan-sources");

    const other = await makePlan(fx, { environment: "https://api.other.example" });
    expect((await refusal(execute(fx, other))).code).toBe("plan-environment");
    expect(repullRows()).toEqual([]);

    // The pinned-read override is a test's, and only a loopback address is honored.
    const real = { ...execEnv(fx), NEMAR_REPULL_UPSTREAM_OBJECTS_BASE: "https://s3.amazonaws.com" };
    const refused = await refusal(executeRepull({ planPath: path, env: real, out: () => {} }));
    expect(refused.code).toBe("test-base-refused");
    expect(upstreamObjectsBase({ NEMAR_REPULL_UPSTREAM_OBJECTS_BASE: "http://127.0.0.1:9" })).toBe(
      "http://127.0.0.1:9",
    );
    expect(upstreamObjectsBase({})).toBeUndefined();
  });

  test("an anonymous dataset is refused before anything is cloned", async () => {
    seedMirror(XX_A, { anonymous: true });
    const path = await makePlan(fx);
    gh.reset();
    await nothingWritten(async () => {
      const err = await refusal(execute(fx, path));
      expect(err.code).toBe("anonymous-dataset");
    });
    // Refused by the CLI itself, before the planner ran (no pull-request listing) and before the
    // Worker, which refuses it too, was asked to record anything.
    expect(gh.seen.filter((s) => s.path.endsWith("/pulls"))).toEqual([]);
    expect(apiWrites).toEqual([]);
  });

  test("main moved: by README is plan-stale; by .nemar/metadata.json rebases; by the ledger is plan-stale", async () => {
    seedMirror(XX_A);
    const path = await makePlan(fx);
    const main = "refs/heads/main";

    const original = await commitOnto(fx.originRepo, main, "README.md", "Edited after the plan.\n");
    try {
      expect((await refusal(execute(fx, path))).code).toBe("plan-stale");
    } finally {
      await gitIn(fx.originRepo, ["update-ref", main, original]);
    }

    const ledger = await show(fx.originRepo, `${main}:.nemar/corrections.jsonl`);
    await commitOnto(
      fx.originRepo,
      main,
      ".nemar/corrections.jsonl",
      `${ledger}${ledger.trim().split("\n")[0]}\n`,
    );
    try {
      expect((await refusal(execute(fx, path))).code).toBe("plan-stale");
    } finally {
      await gitIn(fx.originRepo, ["update-ref", main, original]);
    }
    // A line edited in place leaves the plan's ledger facts (its line count, its corrections) as
    // they were, so only the path rule can refuse it: the ledger is never `.nemar/**`-only.
    const edited = ledger.replace(
      '"at":"2026-10-06T12:00:00.000Z"',
      '"at":"2026-10-07T12:00:00.000Z"',
    );
    expect(edited).not.toBe(ledger);
    await commitOnto(fx.originRepo, main, ".nemar/corrections.jsonl", edited);
    try {
      expect((await refusal(execute(fx, path))).code).toBe("plan-stale");
    } finally {
      await gitIn(fx.originRepo, ["update-ref", main, original]);
    }
    expect(repullRows()).toEqual([]);

    const meta = JSON.parse(await show(fx.originRepo, `${main}:.nemar/metadata.json`));
    meta.enriched_at = "2026-10-24";
    await commitOnto(
      fx.originRepo,
      main,
      ".nemar/metadata.json",
      `${JSON.stringify(meta, null, 2)}\n`,
    );
    const moved = (await gitIn(fx.originRepo, ["rev-parse", main])).trim();
    try {
      const { result, lines } = await execute(fx, path, { until: "planned" });
      expect(lines.join("\n")).toContain("moved by .nemar/** only");
      expect(result.row.base_sha).toBe(moved);
    } finally {
      await gitIn(fx.originRepo, ["update-ref", main, original]);
    }
  });

  test("a planned row whose main then moved by .nemar/** only is prepared on the live main", async () => {
    seedMirror(XX_A);
    const path = await makePlan(fx);
    const main = "refs/heads/main";
    const { result } = await execute(fx, path, { until: "planned" });
    const original = result.row.base_sha;
    const meta = JSON.parse(await show(fx.originRepo, `${main}:.nemar/metadata.json`));
    meta.enriched_at = "2026-10-24";
    await commitOnto(
      fx.originRepo,
      main,
      ".nemar/metadata.json",
      `${JSON.stringify(meta, null, 2)}\n`,
    );
    const moved = (await gitIn(fx.originRepo, ["rev-parse", main])).trim();
    try {
      const { result: prepared } = await execute(fx, path);
      expect(prepared.row.status).toBe("prepared");
      expect(prepared.row.base_sha).toBe(moved);
      const repo = workPaths(configDir, XX_A, prepared.row.plan_digest).repo;
      expect((await gitIn(repo, ["rev-parse", `${prepared.row.synth_sha}^`])).trim()).toBe(moved);
    } finally {
      await gitIn(fx.originRepo, ["update-ref", main, original]);
    }
  });

  test("a moved git-annex branch is plan-stale, and the refusal leaves no directory behind", async () => {
    seedMirror(XX_A);
    const path = await makePlan(fx);
    const paths = workPaths(configDir, XX_A, JSON.parse(readFileSync(path, "utf8")).digest);
    const before = (await gitIn(fx.originRepo, ["rev-parse", "refs/heads/git-annex"])).trim();
    await writeAnnexBranchFile(fx.originRepo, "trust.log", "");
    try {
      expect((await refusal(execute(fx, path))).code).toBe("plan-stale");
    } finally {
      await gitIn(fx.originRepo, ["update-ref", "refs/heads/git-annex", before]);
    }
    expect(repullRows()).toEqual([]);
    expect(existsSync(paths.root)).toBe(false);
    expect(existsSync(dirname(paths.root))).toBe(false);
    expect(existsSync(paths.lock)).toBe(false);
  });

  test("a status execution does not stop at is refused before anything", async () => {
    seedMirror(XX_A);
    const path = await makePlan(fx);
    await nothingWritten(async () => {
      // Execution never goes past the open pull request.
      expect((await refusal(execute(fx, path, { until: "gates_clear" }))).code).toBe(
        "until-not-allowed",
      );
    });
    expect(apiWrites).toEqual([]);
  });

  test("a dataset row that does not say whether it is anonymous is refused as unknown", async () => {
    seedMirror(XX_A);
    const path = await makePlan(fx);
    const root = mkdtempSync(join(tmpdir(), "nemar-repull-anon-"));
    try {
      const err = await refusal(
        readExecutablePlan(path, {
          catalog: {
            dataset: { source: "openneuro", source_id: UPSTREAM_ID, concept_doi: CONCEPT_DOI },
            versions: [{ version: "1.0.0", source_version: TAG_A, source_version_basis: "doi" }],
          },
          github: { token: ADMIN_TOKEN, apiBase: gh.url },
          environment: getApiUrl(),
          env: execEnv(fx),
          workRoot: root,
          collect: { computed: new Map() },
          openNeuroGraphqlUrl: openNeuro.url,
        }),
      );
      expect(err.code).toBe("anonymity-unknown");
      expect(readdirSync(root)).toEqual([]);
      const missing = await refusal(
        readExecutablePlan(path, {
          catalog: { dataset: null, versions: null },
          github: { token: ADMIN_TOKEN, apiBase: gh.url },
          environment: getApiUrl(),
          env: execEnv(fx),
          workRoot: root,
          collect: { computed: new Map() },
          openNeuroGraphqlUrl: openNeuro.url,
        }),
      );
      expect(missing.code).toBe("dataset-missing");
    } finally {
      removeTree(root);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// S1 and S2: the record, the preparation, the commit
// ---------------------------------------------------------------------------------------------

describe.skipIf(!awsInstalled)("preparing the default delta", () => {
  let fx: RepullFixture;
  let planPath: string;
  let first: Awaited<ReturnType<typeof execute>>;
  let paths: ReturnType<typeof workPaths>;
  beforeAll(async () => {
    fx = await buildRepullFixture({
      datasetId: XX_A,
      s3,
      crlfSidecarB: true,
      symlinkB: true,
      nestedGitattributesB: true,
    });
  });
  afterAll(() => {
    fx?.cleanup();
    if (kept) removeTree(kept.dir);
  });
  let originBefore: string;

  // Every case starts from the same finished preparation. It is made ONCE, by the real plan and
  // the real execute, and each case is put back at that point: the database, the CLI's `repull`
  // directory (permissions included), the bucket and the logs the cases read. The cases that
  // change something (a record edited, a clone removed, a lock) change their own copy.
  let kept: {
    dir: string;
    db: Uint8Array;
    s3: ReturnType<S3Standin["snapshot"]>;
    s3Log: S3Standin["log"];
    apiWrites: string[];
  } | null = null;

  beforeAll(async () => {
    await reset();
    seedMirror(XX_A);
    planPath = await makePlan(fx);
    originBefore = await refsOf(fx.originRepo);
    first = await execute(fx, planPath);
    const digest = JSON.parse(readFileSync(planPath, "utf8")).digest as string;
    paths = workPaths(configDir, XX_A, digest);
    const dir = mkdtempSync(join(tmpdir(), "nemar-repull-prepared-"));
    const copy = Bun.spawnSync(["cp", "-a", join(configDir, "repull"), join(dir, "repull")]);
    if (copy.exitCode !== 0) throw new Error(`cp -a: ${copy.stderr.toString()}`);
    kept = {
      dir,
      db: db.serialize(),
      s3: s3.snapshot(),
      s3Log: [...s3.log],
      apiWrites: [...apiWrites],
    };
  });

  beforeEach(async () => {
    if (!kept) throw new Error("the preparation did not run");
    failTransitions = false;
    environment = "test";
    db = Database.deserialize(kept.db);
    gh.reset();
    s3.restore(kept.s3);
    s3.log.length = 0;
    s3.log.push(...kept.s3Log);
    apiWrites.length = 0;
    apiWrites.push(...kept.apiWrites);
    removeTree(join(configDir, "repull"));
    const copy = Bun.spawnSync(["cp", "-a", join(kept.dir, "repull"), join(configDir, "repull")]);
    if (copy.exitCode !== 0) throw new Error(`cp -a: ${copy.stderr.toString()}`);
  });

  test("the row is prepared with the commit, its tree, the manifest's digest and counts", async () => {
    const [row] = repullRows();
    expect(first.result.stoppedAt).toBe("prepared");
    expect(row?.status).toBe("prepared");
    expect(row?.synth_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(row?.synth_tree).toMatch(/^[0-9a-f]{40}$/);
    expect(row?.manifest_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(row?.last_error).toBeNull();
    const counts = JSON.parse(row?.counts as string);
    expect(counts).toMatchObject({ annex_copy_items: 2, local_uploads: 2, scrubbed_recordings: 0 });
    // The plan's base is NEMAR's main, untouched.
    const main = (await gitIn(fx.originRepo, ["rev-parse", "refs/heads/main"])).trim();
    expect(row?.base_sha).toBe(main);
    // The working directory and the checkpoint are private, and so is every directory above them
    // up to repull/ (the config directory itself is the user's).
    for (const dir of [paths.root, dirname(paths.root), dirname(dirname(paths.root))]) {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
    expect(dirname(dirname(paths.root))).toBe(join(configDir, "repull", XX_A));
    expect(statSync(join(configDir, "repull")).mode & 0o777).toBe(0o700);
    expect(statSync(paths.bundle).mode & 0o777).toBe(0o600);
    // What the scrub could not read or prove is recorded, never left out as nothing; the NEMAR-owned
    // edit is counted.
    for (const key of [
      "json_files_unread",
      "json_files_annexed",
      "scans_tables_unread",
      "headers_dates_unproven",
      "headers_dates_left",
    ]) {
      expect(typeof counts[key]).toBe("number");
    }
    expect(counts).toMatchObject({ nemar_owned_edits: 1, nemar_owned_edits_left: 0 });
    // The lock is released.
    expect(existsSync(paths.lock)).toBe(false);
  });

  test("one commit onto the base, with both trailers, and the NEMAR-owned edit", async () => {
    const [row] = repullRows();
    const repo = paths.repo;
    const sha = row?.synth_sha as string;
    expect((await gitIn(repo, ["rev-parse", `${sha}^`])).trim()).toBe(row?.base_sha as string);
    expect((await gitIn(repo, ["rev-list", "--count", `${row?.base_sha}..${sha}`])).trim()).toBe(
      "1",
    );
    const trailers = await gitIn(repo, ["show", "-s", "--format=%(trailers:only,unfold)", sha]);
    const digest = JSON.parse(readFileSync(planPath, "utf8")).digest as string;
    expect(trailers).toContain(`Upstream-Snapshot: ${UPSTREAM_ID}@${TAG_B}`);
    expect(trailers).toContain(`Repull-Plan: ${digest}`);
    // And the message's last paragraph is exactly the shared builder's two lines, byte for byte
    // (#1972): the commit is written from the builder and not from a template of its own.
    const message = await gitIn(repo, ["show", "-s", "--format=%B", sha]);
    const expected = repullTrailerLines({
      upstream_ds: UPSTREAM_ID,
      to_tag: TAG_B,
      plan_digest: digest,
    });
    expect(message.trimEnd().split("\n\n").at(-1)).toBe(expected.join("\n"));
    const author = await gitIn(repo, ["show", "-s", "--format=%an <%ae> %at %cn %ct", sha]);
    expect(author.trim()).toMatch(/^NEMAR re-pull <noreply@nemar\.org> \d+ NEMAR re-pull \d+$/);
    const meta = JSON.parse(await show(repo, `${sha}:.nemar/metadata.json`));
    const hit = meta.related_identifiers.find(
      (r: { relation_type: string }) => r.relation_type === "IsIdenticalTo",
    );
    expect(hit.identifier).toBe(`10.18112/openneuro.${UPSTREAM_ID}.v${TAG_B}`);
    // Nothing was pushed: every ref of NEMAR's origin is where it was.
    expect(await refsOf(fx.originRepo)).toBe(originBefore);
  });

  test("the commit changes exactly the plan's paths, the NEMAR-owned edit and nothing else", async () => {
    const [row] = repullRows();
    const sha = row?.synth_sha as string;
    const plan = JSON.parse(readFileSync(planPath, "utf8"));
    const allowed = new Set<string>([".nemar/metadata.json"]);
    for (const p of plan.paths as Array<{ path: string; delta: boolean; deleted: boolean }>) {
      if (p.delta || p.deleted) allowed.add(p.path);
    }
    const changed = (
      await gitIn(paths.repo, ["diff", "--name-only", "--no-renames", row?.base_sha as string, sha])
    )
      .split("\n")
      .filter(Boolean);
    // This scrub changed nothing, so the ledger and the provenance files are NEMAR's as they were.
    expect(new Set(changed)).toEqual(allowed);
  });

  test("the tree is the plan's targets: the copied keys, the local uploads, the description", async () => {
    const [row] = repullRows();
    const repo = paths.repo;
    const sha = row?.synth_sha as string;
    const plan = JSON.parse(readFileSync(planPath, "utf8"));
    for (const p of plan.paths as Array<{
      path: string;
      target: Record<string, string>;
      delta: boolean;
      deleted: boolean;
    }>) {
      if (p.deleted) {
        const r = await runCommand(["git", "cat-file", "-e", `${sha}:${p.path}`], { cwd: repo });
        expect(r.exitCode).not.toBe(0);
        continue;
      }
      if (!p.delta) continue;
      const entry = (await gitIn(repo, ["ls-tree", sha, "--", p.path])).trim();
      if (p.target.kind === "git") expect(entry).toContain(`${p.target.mode} blob ${p.target.oid}`);
      if (p.target.kind === "annex") {
        expect(entry.startsWith("120000")).toBe(true);
        expect(await show(repo, `${sha}:${p.path}`)).toContain(p.target.key as string);
      }
      if (p.target.kind === "annex-from-git") expect(entry.startsWith("120000")).toBe(true);
      if (p.target.kind === "description") {
        expect(await show(repo, `${sha}:${p.path}`)).toBe(plan.description.merged_json);
      }
    }
    // A blob is staged by its id, never through `git add`: the CRLF sidecar is upstream's blob.
    const crlf = (plan.paths as Array<{ path: string; target: { oid?: string } }>).find(
      (p) => p.path === PATHS.crlfSidecar,
    );
    expect((await gitIn(repo, ["rev-parse", `${sha}:${PATHS.crlfSidecar}`])).trim()).toBe(
      crlf?.target.oid as string,
    );
    expect(await show(repo, `${sha}:${PATHS.crlfSidecar}`)).toContain("\r\n");
    // The script's mode change, the plain symlink and the nested .gitattributes, as upstream has them.
    expect(
      (await gitIn(repo, ["ls-tree", sha, "--", PATHS.script])).startsWith("100755 blob"),
    ).toBe(true);
    const link = (await gitIn(repo, ["ls-tree", sha, "--", PATHS.symlink])).trim();
    expect(link.startsWith("120000 blob")).toBe(true);
    expect(await show(repo, `${sha}:${PATHS.symlink}`)).toBe("run.sh");
    const attrs = (plan.paths as Array<{ path: string; target: Record<string, string> }>).find(
      (p) => p.path === PATHS.nestedGitattributes,
    );
    expect(attrs?.target.computed).toBe("gitattributes-stripped");
    expect(await show(repo, `${sha}:${PATHS.nestedGitattributes}`)).toBe("*.tsv text eol=lf\n");
    // The git-held motion recordings were annexed and uploaded from here, registered at nemar-s3.
    const motion = await show(repo, `${sha}:${PATHS.motion}`);
    const key = motion.trim().split("/").pop() as string;
    expect(s3.current("nemar", `${XX_A}/objects/${key}`)).toBeDefined();
    // Upstream's keys were not copied: a later step copies them, by version.
    expect(s3.current("nemar", `${XX_A}/objects/${fx.keys.setB}`)).toBeUndefined();
    expect(s3.log.some((e) => e.op === "UploadPartCopy")).toBe(false);
  });

  test("every upstream read names the pin's version, and the pinned header is the one judged", () => {
    const reads = s3.log.filter((e) => e.bucket === "openneuro.org");
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((e) => e.op === "GetObject" && e.versionId === fx.pins.addedEdf)).toBe(true);
    // The current object at the path is a flagged recording; the pinned one is clean, so nothing
    // was scrubbed: had the read dropped the version, the scrub would have re-keyed it.
    const [row] = repullRows();
    expect(JSON.parse(row?.counts as string).scrubbed_recordings).toBe(0);
  });

  test("a rerun of a prepared row leaves it as it is, and uploads nothing again", async () => {
    const before = repullRows();
    const writes = s3Writes();
    apiWrites.length = 0;
    // Directories that exist with a looser mode are made private again.
    for (const dir of [dirname(paths.root), dirname(dirname(paths.root))]) chmodSync(dir, 0o755);
    const again = await execute(fx, planPath);
    for (const dir of [dirname(paths.root), dirname(dirname(paths.root))]) {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
    expect(again.result.stoppedAt).toBe("prepared");
    expect(again.lines.join("\n")).toContain("its working clone holds its commit");
    expect(repullRows()).toEqual(before);
    expect(s3Writes()).toBe(writes);
    // The one write is the record's create, which answers the open row as it is.
    expect(apiWrites).toEqual(["POST /admin/repulls"]);
  });

  test("a stale error on a prepared row is cleared by a run that shows its facts hold", async () => {
    const recorded = repullRows()[0] as Row;
    db.run("UPDATE upstream_repulls SET synth_tree = ?", ["f".repeat(40)]);
    removeTree(paths.root);
    rmSync(paths.bundle, { force: true });
    expect((await refusal(execute(fx, planPath))).code).toBe("prepare-not-reproducible");
    expect(repullRows()[0]?.last_error).toContain("prepare-not-reproducible");
    // The record put right, the run finds its clone at the recorded commit and says so.
    db.run("UPDATE upstream_repulls SET synth_tree = ?", [recorded.synth_tree]);
    const again = await execute(fx, planPath);
    expect(again.lines.join("\n")).toContain("holds its commit");
    expect(repullRows()[0]?.last_error).toBeNull();
  });

  test("an error a later step recorded is not cleared by a preparation that holds", async () => {
    const later = "[copy:pin-absent] 1 pinned object is absent upstream.";
    db.run("UPDATE upstream_repulls SET last_error = ?", [later]);
    const before = repullRows();
    apiWrites.length = 0;
    const again = await execute(fx, planPath);
    expect(again.lines.join("\n")).toContain("holds its commit");
    expect(repullRows()).toEqual(before);
    expect(repullRows()[0]?.last_error).toBe(later);
    expect(apiWrites).toEqual(["POST /admin/repulls"]);
  });

  test("a working clone moved off the recorded commit is not taken for it", async () => {
    const before = repullRows();
    await gitIn(paths.repo, [
      "update-ref",
      "refs/heads/repull-work",
      before[0]?.base_sha as string,
    ]);
    const again = await execute(fx, planPath);
    expect(again.lines.join("\n")).not.toContain("holds its commit");
    expect(again.lines.join("\n")).toContain("(clone-at-another-commit)");
    expect(again.lines.join("\n")).toContain("restored from the checkpoint");
    expect((await gitIn(paths.repo, ["rev-parse", "HEAD"])).trim()).toBe(
      before[0]?.synth_sha as string,
    );
  });

  test("a lost working directory is restored from the checkpoint", async () => {
    const before = repullRows();
    removeTree(paths.root);
    const again = await execute(fx, planPath);
    expect(again.lines.join("\n")).toContain("(no-working-clone)");
    expect(again.lines.join("\n")).toContain("restored from the checkpoint");
    expect(repullRows()).toEqual(before);
    expect((await gitIn(paths.repo, ["rev-parse", "HEAD"])).trim()).toBe(
      before[0]?.synth_sha as string,
    );
  });

  test("a checkpoint that does not hold the recorded commit is not used", async () => {
    const before = repullRows();
    // Another commit on the work branch, bundled where the checkpoint is.
    const other = (
      await runCommand(
        [
          "git",
          "commit-tree",
          `${before[0]?.synth_sha}^{tree}`,
          "-p",
          before[0]?.base_sha as string,
          "-m",
          "x",
        ],
        { cwd: paths.repo },
      )
    ).stdout.trim();
    await gitIn(paths.repo, ["update-ref", "refs/heads/repull-work", other]);
    rmSync(paths.bundle, { force: true });
    await gitIn(paths.repo, [
      "bundle",
      "create",
      paths.bundle,
      "refs/heads/repull-work",
      "refs/heads/git-annex",
      `^${before[0]?.base_sha}`,
      "^refs/remotes/origin/git-annex",
    ]);
    removeTree(paths.root);
    const again = await execute(fx, planPath);
    expect(again.lines.join("\n")).not.toContain("restored from the checkpoint");
    expect(again.lines.join("\n")).toContain("(commit-not-in-checkpoint)");
    expect(again.lines.join("\n")).toContain("prepared again, to the same commit");
    expect(repullRows()).toEqual(before);
  });

  test("a preparation that does not reproduce the record refuses and leaves the row as it was", async () => {
    // A record whose tree is not what this plan and base give: the case a nondeterministic step
    // would make. The row stays prepared, with why; abandoning it is the way out.
    db.run("UPDATE upstream_repulls SET synth_tree = ?", ["f".repeat(40)]);
    removeTree(paths.root);
    rmSync(paths.bundle, { force: true });
    const err = await refusal(execute(fx, planPath));
    expect(err.code).toBe("prepare-not-reproducible");
    const [row] = repullRows();
    expect(row?.status).toBe("prepared");
    expect(row?.synth_tree).toBe("f".repeat(40));
    expect(row?.last_error).toContain("prepare-not-reproducible");
  });

  test("a recorded manifest digest the preparation does not reproduce refuses too", async () => {
    db.run("UPDATE upstream_repulls SET manifest_digest = ?", [`sha256:${"0".repeat(64)}`]);
    removeTree(paths.root);
    rmSync(paths.bundle, { force: true });
    expect((await refusal(execute(fx, planPath))).code).toBe("prepare-not-reproducible");
    expect(repullRows()[0]?.status).toBe("prepared");
  });

  test("a prepared row whose main then moved by .nemar/** only is prepared again onto it", async () => {
    const before = repullRows()[0] as Row;
    const main = "refs/heads/main";
    const original = (await gitIn(fx.originRepo, ["rev-parse", main])).trim();
    const meta = JSON.parse(await show(fx.originRepo, `${main}:.nemar/metadata.json`));
    meta.enriched_at = "2026-10-24";
    await commitOnto(
      fx.originRepo,
      main,
      ".nemar/metadata.json",
      `${JSON.stringify(meta, null, 2)}\n`,
    );
    const moved = (await gitIn(fx.originRepo, ["rev-parse", main])).trim();
    try {
      const again = await execute(fx, planPath);
      expect(again.lines.join("\n")).toContain("prepared again onto the live main");
      const [row] = repullRows();
      expect(row?.status).toBe("prepared");
      expect(row?.base_sha).toBe(moved);
      expect(row?.synth_sha).not.toBe(before.synth_sha);
      expect((await gitIn(paths.repo, ["rev-parse", `${row?.synth_sha}^`])).trim()).toBe(moved);
    } finally {
      await gitIn(fx.originRepo, ["update-ref", main, original]);
    }
  });

  test("the administrator's global git configuration changes nothing that is prepared", async () => {
    const before = repullRows();
    const hostile = join(configDir, "hostile-gitconfig");
    const attributes = join(configDir, "hostile-attributes");
    writeFileSync(attributes, "* annex.largefiles=anything\n*.json text eol=crlf\n");
    writeFileSync(
      hostile,
      `[annex]\n\taddunlocked = true\n\tbackend = MD5E\n[core]\n\tautocrlf = true\n\tattributesFile = ${attributes}\n[commit]\n\tgpgsign = true\n`,
    );
    // The default attributes and ignore files git reads with no global configuration at all.
    const xdg = join(configDir, "hostile-xdg");
    mkdirSync(join(xdg, "git"), { recursive: true });
    writeFileSync(
      join(xdg, "git", "attributes"),
      "* annex.largefiles=anything\n*.tsv text eol=crlf\n",
    );
    writeFileSync(join(xdg, "git", "ignore"), "*\n");
    removeTree(paths.root);
    rmSync(paths.bundle, { force: true });
    const saved = { global: process.env.GIT_CONFIG_GLOBAL, xdg: process.env.XDG_CONFIG_HOME };
    process.env.GIT_CONFIG_GLOBAL = hostile;
    process.env.XDG_CONFIG_HOME = xdg;
    try {
      const again = await execute(fx, planPath, {
        env: { ...execEnv(fx), GIT_CONFIG_GLOBAL: hostile, XDG_CONFIG_HOME: xdg },
      });
      expect(again.lines.join("\n")).toContain("prepared again, to the same commit");
    } finally {
      for (const [k, v] of [
        ["GIT_CONFIG_GLOBAL", saved.global],
        ["XDG_CONFIG_HOME", saved.xdg],
      ] as const) {
        if (v === undefined) Reflect.deleteProperty(process.env, k);
        else process.env[k] = v;
      }
    }
    expect(repullRows()).toEqual(before);
  });

  test("a second execution of the plan refuses while one runs, and takes over a crashed one's lock", async () => {
    // A live process holds the lock: this test's own.
    mkdirSync(paths.lock, { mode: 0o700 });
    writeFileSync(join(paths.lock, "pid"), `${process.pid}\n`);
    // What the running one is using: its planner's clones and its working clone.
    mkdirSync(paths.plan, { recursive: true });
    writeFileSync(join(paths.plan, "in-use"), "");
    try {
      const locked = await refusal(execute(fx, planPath));
      expect(locked.code).toBe("execution-locked");
      expect(locked.message).toContain(paths.lock);
      expect(locked.message).toContain(`process ${process.pid}`);
      expect(existsSync(join(paths.plan, "in-use"))).toBe(true);
      expect((await gitIn(paths.repo, ["rev-parse", "HEAD"])).trim()).toBe(
        repullRows()[0]?.synth_sha as string,
      );
    } finally {
      rmSync(paths.lock, { recursive: true, force: true });
      rmSync(paths.plan, { recursive: true, force: true });
    }
    // A crashed run's lock: its process is gone.
    const gone = Bun.spawnSync(["true"]).pid;
    mkdirSync(paths.lock, { mode: 0o700 });
    writeFileSync(join(paths.lock, "pid"), `${gone}\n`);
    const again = await execute(fx, planPath);
    expect(again.result.stoppedAt).toBe("prepared");
    expect(existsSync(paths.lock)).toBe(false);
  });

  test("a lock whose pid cannot be read yet is a live one, never taken over", async () => {
    // The moment between a lock's creation and its pid being written, which the atomic rename
    // means no execution of this build leaves, and a lock this build did not write.
    mkdirSync(paths.lock, { mode: 0o700 });
    writeFileSync(join(paths.lock, "pid"), "");
    try {
      const locked = await refusal(execute(fx, planPath));
      expect(locked.code).toBe("execution-locked");
      expect(locked.message).toContain("cannot be read");
      expect(locked.message).toContain(paths.lock);
      expect(readFileSync(join(paths.lock, "pid"), "utf8")).toBe("");
    } finally {
      rmSync(paths.lock, { recursive: true, force: true });
    }
    // No staged or moved-aside lock is left beside it.
    expect(readdirSync(dirname(paths.lock)).filter((f) => f.includes(".lock."))).toEqual([]);
  });

  test("with the checkpoint gone too, preparing again gives the same tree and commit", async () => {
    const before = repullRows();
    removeTree(paths.root);
    rmSync(paths.bundle, { force: true });
    const again = await execute(fx, planPath);
    expect(again.lines.join("\n")).toContain("prepared again, to the same commit");
    expect(repullRows()).toEqual(before);
    expect(existsSync(paths.bundle)).toBe(true);
  });
});

describe.skipIf(!awsInstalled)("the delta scrub (ADR 0089, ADR 0091) before any copy", () => {
  let fx: RepullFixture;
  let planPath: string;
  let row: Row;
  let repo: string;
  beforeAll(async () => {
    fx = await buildRepullFixture({
      datasetId: XX_B,
      s3,
      privacyEdits: true,
      flaggedAddedEdf: true,
      identifierJsonB: true,
    });
    await reset();
    seedMirror(XX_B);
    planPath = await makePlan(fx);
    originBefore = await refsOf(fx.originRepo);
    await execute(fx, planPath);
    row = repullRows()[0] as Row;
    repo = workPaths(configDir, XX_B, row.plan_digest as string).repo;
  });
  afterAll(() => fx?.cleanup());
  let originBefore: string;

  test("the commit changes the plan's paths, the NEMAR-owned edit, the ledger and the provenance files only", async () => {
    const sha = row.synth_sha as string;
    const plan = JSON.parse(readFileSync(planPath, "utf8"));
    const allowed = new Set<string>([
      ".nemar/metadata.json",
      ".nemar/corrections.jsonl",
      "sourcedata/sourcedata_provenance.json",
      "sourcedata/README_sourcedata_provenance.md",
    ]);
    for (const p of plan.paths as Array<{ path: string; delta: boolean; deleted: boolean }>) {
      if (p.delta || p.deleted) allowed.add(p.path);
    }
    const changed = (
      await gitIn(repo, ["diff", "--name-only", "--no-renames", row.base_sha as string, sha])
    )
      .split("\n")
      .filter(Boolean);
    expect(new Set(changed)).toEqual(allowed);
    // Modes: nothing NEMAR held changed mode; the blanked sidecar kept upstream's.
    const raw = await gitIn(repo, ["diff", "--raw", "--no-renames", row.base_sha as string, sha]);
    const blanked = raw.split("\n").find((l) => l.endsWith(PATHS.addedIdentifierJson)) ?? "";
    expect(blanked).toMatch(/^:000000 100644 /);
  });

  test("the added flagged EDF is re-keyed SHA256E, uploaded, dated 1 January, its upstream key dead", async () => {
    expect(row.status).toBe("prepared");
    const sha = row.synth_sha as string;
    const link = await show(repo, `${sha}:${PATHS.addedEdf}`);
    const key = link.trim().split("/").pop() as string;
    expect(key).not.toBe(fx.keys.addedEdf);
    expect(key.startsWith("SHA256E-")).toBe(true);
    const stored = s3.current("nemar", `${XX_B}/objects/${key}`);
    expect(stored).toBeDefined();
    const header = Buffer.from((stored?.data as Uint8Array).subarray(0, EDF_HEADER_BYTES)).toString(
      "latin1",
    );
    expect(header).not.toContain("Qwfixturelast");
    expect(header.slice(168, 176)).toBe("01.01.23");
    const log = await show(
      repo,
      `git-annex:${hashDirLower(fx.keys.addedEdf)}${fx.keys.addedEdf}.log`,
    );
    expect(isDead(log)).toBe(true);
    expect(JSON.parse(row.counts).scrubbed_recordings).toBe(1);
  });

  test("the pinned version was read and the newer, clean one was not judged", () => {
    const reads = s3.log.filter((e) => e.bucket === "openneuro.org");
    // One ranged header read and one download, both at the pin.
    expect(reads.map((e) => [e.op, e.status, e.versionId])).toEqual([
      ["GetObject", 206, fx.pins.addedEdf],
      ["GetObject", 200, fx.pins.addedEdf],
    ]);
    // The unchanged flagged EDF NEMAR already holds is not read at all.
    expect(s3.log.some((e) => e.key.endsWith(PATHS.flaggedEdf))).toBe(false);
  });

  test("the added identifier JSON is blanked, the unchanged one is not touched", async () => {
    const sha = row.synth_sha as string;
    const added = await show(repo, `${sha}:${PATHS.addedIdentifierJson}`);
    expect(added).not.toContain("Zxfixturename");
    const base = row.base_sha as string;
    expect((await gitIn(repo, ["rev-parse", `${sha}:${PATHS.blankedJson}`])).trim()).toBe(
      (await gitIn(repo, ["rev-parse", `${base}:${PATHS.blankedJson}`])).trim(),
    );
    // The original bytes are not reachable from the commit.
    const plan = JSON.parse(readFileSync(planPath, "utf8"));
    const target = (plan.paths as Array<{ path: string; target: { oid?: string } }>).find(
      (p) => p.path === PATHS.addedIdentifierJson,
    )?.target.oid as string;
    const objects = await gitIn(repo, ["rev-list", "--objects", sha]);
    expect(objects).not.toContain(target);
  });

  test("the ledger gains exactly one repull-scrubbed line, at the row's time", async () => {
    const sha = row.synth_sha as string;
    const before = (await show(repo, `${row.base_sha}:.nemar/corrections.jsonl`))
      .trim()
      .split("\n");
    const after = (await show(repo, `${sha}:.nemar/corrections.jsonl`)).trim().split("\n");
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after).toHaveLength(before.length + 1);
    const line = JSON.parse(after.at(-1) as string);
    expect(line.action).toBe("repull-scrubbed");
    expect(line.actor).toBe("nemar-repull");
    expect(line.at).toBe(`${(row.created_at as string).replace(" ", "T")}.000Z`);
    const provenance = JSON.parse(await show(repo, `${sha}:sourcedata/sourcedata_provenance.json`));
    expect(typeof provenance[PROVENANCE_NOTE_KEY]).toBe("string");
    // The scrub read the delta, not the dataset: its counts see the scope only (the delta paths,
    // the NEMAR-owned edit and the provenance files), never the recordings and sidecars upstream
    // did not change.
    const plan = JSON.parse(readFileSync(planPath, "utf8"));
    const delta = (plan.paths as Array<{ path: string; delta: boolean }>)
      .filter((p) => p.delta)
      .map((p) => p.path);
    const scopeJson = new Set([
      ...delta.filter((p) => /\.json$/i.test(p)),
      ".nemar/metadata.json",
      "sourcedata/sourcedata_provenance.json",
    ]);
    expect(line.counts.json_files_read).toBe(scopeJson.size);
    expect(line.counts.recordings).toBe(delta.filter((p) => /\.(edf|bdf)$/i.test(p)).length);
    expect(line.counts.headers_dates_normalized).toBe(1);
  });

  test("nothing was pushed and no upstream key was copied", async () => {
    expect(await refsOf(fx.originRepo)).toBe(originBefore);
    expect(s3.current("nemar", `${XX_B}/objects/${fx.keys.addedEdf}`)).toBeUndefined();
  });

  test("preparing it again from scratch, scrub and uploads included, gives the same commit", async () => {
    const paths = workPaths(configDir, XX_B, row.plan_digest as string);
    removeTree(paths.root);
    rmSync(paths.bundle, { force: true });
    const again = await execute(fx, planPath);
    expect(again.lines.join("\n")).toContain("prepared again, to the same commit");
    expect(repullRows()[0]?.synth_sha).toBe(row.synth_sha);
  });
});

describe.skipIf(!awsInstalled)("what the synthesis refuses", () => {
  let fx: RepullFixture;
  beforeAll(async () => {
    fx = await buildRepullFixture({
      datasetId: XX_B,
      s3,
      privacyEdits: true,
      flaggedAddedEdf: true,
      identifierJsonB: true,
    });
  });
  afterAll(() => fx?.cleanup());
  beforeEach(reset);

  test("an original the scrub replaced that NEMAR's history already reaches refuses the commit", async () => {
    // NEMAR's main holds, under another name, the very bytes of the sidecar upstream adds: the
    // scrub blanks the sidecar, and its original is then reachable from the commit's parent.
    const plain = await show(fx.upstreamRepo, `refs/tags/${TAG_B}:${PATHS.addedIdentifierJson}`);
    await commitOnto(fx.originRepo, "refs/heads/main", "code/kept-copy.txt", plain);
    seedMirror(XX_B);
    const path = await makePlan(fx);
    const err = await refusal(execute(fx, path));
    expect(err.code).toBe("synthesis-mismatch");
    expect(err.message).toContain("reachable");
    const [row] = repullRows();
    expect(row?.status).toBe("planned");
    expect(row?.last_error).toContain("synthesis-mismatch");
  });
});

describe.skipIf(!awsInstalled)("materializing proves every id", () => {
  let fx: RepullFixture;
  beforeAll(async () => {
    fx = await buildRepullFixture({ datasetId: XX_A, s3 });
  });
  afterAll(() => fx?.cleanup());
  beforeEach(reset);

  test("computed bytes that are not the target's id refuse the path", async () => {
    const root = mkdtempSync(join(tmpdir(), "nemar-repull-materialize-"));
    try {
      const collect = { computed: new Map<string, Buffer>() };
      const out = await planRepull({
        datasetId: fx.datasetId,
        catalog: {
          dataset: { source: "openneuro", source_id: UPSTREAM_ID, concept_doi: CONCEPT_DOI },
          versions: [{ version: "1.0.0", source_version: TAG_A, source_version_basis: "doi" }],
        },
        github: { token: ADMIN_TOKEN, apiBase: gh.url },
        env: fx.env,
        environment: getApiUrl(),
        workRoot: root,
        openNeuroGraphqlUrl: openNeuro.url,
        keepWorkdir: true,
        collect,
      });
      if (!out.planned || !out.workdir) throw new Error("not planned");
      const body = out.file.body;
      const readme = (body.paths as Array<{ path: string; target: { oid?: string } }>).find(
        (p) => p.path === "README.md",
      )?.target.oid as string;
      collect.computed.set(readme, Buffer.from("Bytes the planner never computed.\n"));
      const main = (await gitIn(fx.originRepo, ["rev-parse", "refs/heads/main"])).trim();
      const repo = await workClone({
        dir: join(root, "repo"),
        originUrl: `file://${fx.originRepo}`,
        baseSha: main,
        token: null,
        annexCommit: (await gitIn(fx.originRepo, ["rev-parse", "refs/heads/git-annex"])).trim(),
      });
      const scratch = join(root, "scratch");
      mkdirSync(scratch);
      const err = await refusal(
        materializeDelta({
          work: repo,
          body,
          upstreamBare: join(out.workdir, "upstream.git"),
          upstreamEnv: undefined,
          computed: collect.computed,
          reader: httpUpstreamReader({ baseUrl: s3.url, retryDelayMs: 1 }),
          scratch,
        }),
      );
      expect(err.code).toBe("target-mismatch");
    } finally {
      removeTree(root);
    }
  });

  test("a change outside the scope refuses before the scrub runs", async () => {
    const root = mkdtempSync(join(tmpdir(), "nemar-repull-materialize-"));
    try {
      const main = (await gitIn(fx.originRepo, ["rev-parse", "refs/heads/main"])).trim();
      const repo = await workClone({
        dir: join(root, "repo"),
        originUrl: `file://${fx.originRepo}`,
        baseSha: main,
        token: null,
        annexCommit: (await gitIn(fx.originRepo, ["rev-parse", "refs/heads/git-annex"])).trim(),
      });
      writeFileSync(join(repo, "stray.txt"), "Not a delta path.\n");
      const err = await refusal(commitMaterialized(repo, main, new Set(["README.md"]), new Date()));
      expect(err.code).toBe("scope-incomplete");
      // In the scope, the same change passes.
      await commitMaterialized(repo, main, new Set(["stray.txt"]), new Date());
    } finally {
      removeTree(root);
    }
  });

  test("a git-annex branch that moved since the plan refuses the clone", async () => {
    const root = mkdtempSync(join(tmpdir(), "nemar-repull-materialize-"));
    try {
      const main = (await gitIn(fx.originRepo, ["rev-parse", "refs/heads/main"])).trim();
      const err = await refusal(
        workClone({
          dir: join(root, "repo"),
          originUrl: `file://${fx.originRepo}`,
          baseSha: main,
          token: null,
          annexCommit: "0".repeat(40),
        }),
      );
      expect(err.code).toBe("plan-stale");
    } finally {
      removeTree(root);
    }
  });

  test("the closing check reads the copy items, the tree and the headers this run read", async () => {
    // A copy recording the scrub has no source for (its pin taken out of the plan, which a real
    // plan would refuse): the scrub counts it unread, and only the closing check can catch it.
    const root = mkdtempSync(join(tmpdir(), "nemar-repull-materialize-"));
    try {
      const collect = { computed: new Map<string, Buffer>() };
      const out = await planRepull({
        datasetId: fx.datasetId,
        catalog: {
          dataset: { source: "openneuro", source_id: UPSTREAM_ID, concept_doi: CONCEPT_DOI },
          versions: [{ version: "1.0.0", source_version: TAG_A, source_version_basis: "doi" }],
        },
        github: { token: ADMIN_TOKEN, apiBase: gh.url },
        env: fx.env,
        environment: getApiUrl(),
        workRoot: root,
        openNeuroGraphqlUrl: openNeuro.url,
        keepWorkdir: true,
        collect,
      });
      if (!out.planned || !out.workdir) throw new Error("not planned");
      const body = JSON.parse(JSON.stringify(out.file.body));
      for (const item of body.copy.items as Array<{ key: string; pin: unknown }>) {
        if (item.key === fx.keys.addedEdf) item.pin = null;
      }
      const main = (await gitIn(fx.originRepo, ["rev-parse", "refs/heads/main"])).trim();
      const annex = (await gitIn(fx.originRepo, ["rev-parse", "refs/heads/git-annex"])).trim();
      const repo = await workClone({
        dir: join(root, "repo"),
        originUrl: `file://${fx.originRepo}`,
        baseSha: main,
        token: null,
        annexCommit: annex,
      });
      const oursKeys = new Set((await listAnnexedKeys(repo)).values());
      const scratch = join(root, "scratch");
      mkdirSync(scratch);
      const reader = httpUpstreamReader({ baseUrl: s3.url, retryDelayMs: 1 });
      const mat = await materializeDelta({
        work: repo,
        body,
        upstreamBare: join(out.workdir, "upstream.git"),
        upstreamEnv: undefined,
        computed: collect.computed,
        reader,
        scratch,
      });
      const scope = new Set(mat.deltaPaths);
      await commitMaterialized(repo, main, scope, new Date("2026-10-24T00:00:00.000Z"));
      const err = await refusal(
        scrubDelta({
          work: repo,
          datasetId: fx.datasetId,
          scope,
          body,
          oursKeys,
          annexFromGit: mat.annexFromGit,
          reader,
          upload: awsCliUpload({
            bucket: "nemar",
            datasetId: fx.datasetId,
            region: REGION,
            remoteUuid: fx.nemarUuid,
            workDir: join(root, "upload"),
          }),
          bucket: "nemar",
          now: new Date("2026-10-24T00:00:00.000Z"),
          maxBytes: 5 * 1024 ** 3,
          upstreamBare: join(out.workdir, "upstream.git"),
        }),
      );
      expect(err.code).toBe("header-unreadable");
      expect(err.message).toContain("did not read");
    } finally {
      removeTree(root);
    }
  });
});

describe.skipIf(!awsInstalled)("root metadata upstream annexed", () => {
  let fx: RepullFixture;
  beforeAll(async () => {
    fx = await buildRepullFixture({ datasetId: XX_C, s3, annexedRootMetadata: true });
  });
  afterAll(() => fx?.cleanup());
  beforeEach(reset);

  test("is read at its pinned version, proved by its key, and kept in git", async () => {
    seedMirror(XX_C);
    const path = await makePlan(fx);
    const { result } = await execute(fx, path);
    expect(result.row.status).toBe("prepared");
    const repo = workPaths(configDir, XX_C, result.row.plan_digest).repo;
    const sha = result.row.synth_sha as string;
    const entry = (await gitIn(repo, ["ls-tree", sha, "--", PATHS.changes])).trim();
    expect(entry.startsWith("100644 blob")).toBe(true);
    // Upstream annexes CHANGES: N.0.0 holds, in git, the bytes of the version its git-annex
    // branch pins, which hash to the key; the newer version at the path is other bytes.
    const pinned = s3
      .versions("openneuro.org", `${UPSTREAM_ID}/${PATHS.changes}`)
      .find((v) => v.versionId === fx.pins.changesB);
    expect(await show(repo, `${sha}:${PATHS.changes}`)).toBe(
      Buffer.from(pinned?.data as Uint8Array).toString("utf8"),
    );
    expect(await show(repo, `${sha}:${PATHS.changes}`)).toContain("Added sub-03.");
    const reads = s3.log.filter(
      (e) => e.bucket === "openneuro.org" && e.key.endsWith(`/${PATHS.changes}`),
    );
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((e) => e.versionId === fx.pins.changesB)).toBe(true);
  });

  test("a pinned object that does not hash to its key refuses, and the row says why", async () => {
    seedMirror(XX_C);
    const path = await makePlan(fx);
    const object = `${UPSTREAM_ID}/${PATHS.changes}`;
    s3.corruptByte("openneuro.org", object, fx.pins.changesB as string, 0);
    try {
      const err = await refusal(execute(fx, path));
      expect(err.code).toBe("unannex-content-mismatch");
      const [row] = repullRows();
      expect(row?.status).toBe("planned");
      expect(row?.last_error).toContain("unannex-content-mismatch");
    } finally {
      s3.corruptByte("openneuro.org", object, fx.pins.changesB as string, 0);
    }
  });
});

describe.skipIf(!awsInstalled)("a failure is recorded, or said", () => {
  let fx: RepullFixture;
  beforeAll(async () => {
    fx = await buildRepullFixture({ datasetId: XX_D, s3 });
    // Upstream no longer serves the pinned version of the added recording; the newer one stays.
    s3.dropVersion("openneuro.org", `${UPSTREAM_ID}/${PATHS.addedEdf}`, fx.pins.addedEdf as string);
  });
  afterAll(() => fx?.cleanup());
  beforeEach(reset);

  test("a pinned object upstream stopped serving refuses with the upstream marker, and the row says why", async () => {
    seedMirror(XX_D);
    const path = await makePlan(fx);
    const err = await refusal(execute(fx, path));
    expect(err.code).toBe("header-unreadable");
    // The marker the Worker's classifier matches, kept in the message as the scrub wrote it.
    expect(err.message.startsWith(OPENNEURO_UPSTREAM_MARKER)).toBe(true);
    const [row] = repullRows();
    expect(row?.status).toBe("planned");
    expect(row?.last_error).toContain("header-unreadable");
    // It was never read at the path's newer version instead: the path has a current object, so
    // only a read that names the gone version is answered 404, and every read was.
    const reads = s3.log.filter((e) => e.bucket === "openneuro.org");
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((e) => e.status === 404)).toBe(true);
  });

  test("a record that cannot be written is said, and the refusal is still the step's", async () => {
    seedMirror(XX_D);
    const path = await makePlan(fx);
    await execute(fx, path, { until: "planned" });
    failTransitions = true;
    const lines: string[] = [];
    const err = await refusal(
      executeRepull({ planPath: path, env: execEnv(fx), out: (l) => lines.push(l) }),
    );
    expect(err.code).toBe("header-unreadable");
    expect(lines.join("\n")).toContain("could not be recorded");
    expect(repullRows()[0]?.last_error).toBeNull();
  });
});

describe.skipIf(!awsInstalled)("the destination prefix", () => {
  test("a nemar-s3 prefix other than <id>/objects/ refuses before anything is uploaded", async () => {
    await reset();
    const fx = await buildRepullFixture({ datasetId: XX_E, s3 });
    try {
      const prefix = `${XX_E}/elsewhere/`;
      await writeAnnexBranchFile(
        fx.originRepo,
        "remote.log",
        `${fx.nemarUuid} bucket=nemar datacenter=us-east-2 encryption=none fileprefix=${prefix} name=nemar-s3 type=S3 timestamp=1790000002s\n`,
      );
      mkdirSync(join(fx.bucketBase, prefix), { recursive: true });
      writeFileSync(join(fx.bucketBase, prefix, "annex-uuid"), fx.nemarUuid);
      seedMirror(XX_E);
      const path = await makePlan(fx);
      expect(JSON.parse(readFileSync(path, "utf8")).copy.destination_prefix).toBe(prefix);
      const writes = s3Writes();
      const err = await refusal(execute(fx, path));
      expect(err.code).toBe("destination-prefix");
      expect(s3Writes()).toBe(writes);
      expect(repullRows()[0]?.last_error).toContain("destination-prefix");
    } finally {
      fx.cleanup();
    }
  });
});

describe.skipIf(!awsInstalled)("the destination bucket", () => {
  test("a remote.log that names a bucket S3 cannot have refuses the copy: nemar-s3-invalid, nothing uploaded or pushed", async () => {
    // The guard of `advancePrepared`'s setup reads the working clone's own remote.log. A plan
    // cannot carry a bucket: it names a git-annex commit, and a plan forged onto another commit has
    // another digest, so it is another plan, which a prepared record does not take up. So it is the
    // clone that is forged: the line of nemar-s3 now names the bucket as a path, as a write to the
    // git-annex branch could have left it, and the real `executeRepull` walks the record on.
    await reset();
    const fx = await buildRepullFixture({ datasetId: XX_I, s3 });
    try {
      seedMirror(XX_I);
      const path = await makePlan(fx);
      const { result } = await execute(fx, path);
      expect(result.row.status).toBe("prepared");
      const repo = workPaths(configDir, XX_I, result.row.plan_digest).repo;
      const log = await gitIn(repo, ["show", "refs/heads/git-annex:remote.log"]);
      const forged = log.replace(/bucket=nemar\b/, "bucket=evil.example/x#");
      expect(forged).not.toBe(log);
      await writeAnnexBranchFile(repo, "remote.log", forged);

      const writes = s3Writes();
      const origin = await refsOf(fx.originRepo);
      const err = await refusal(execute(fx, path, { until: "pr_open" }));
      expect(err.code).toBe("nemar-s3-invalid");
      expect(err.message).not.toContain("evil.example");
      // Nothing was uploaded, pushed or opened: the S3 stand-in saw no write, origin's refs are
      // where they were, and GitHub saw no request that is not a read.
      expect(s3Writes()).toBe(writes);
      expect(await refsOf(fx.originRepo)).toBe(origin);
      expect(gh.seen.filter((s) => s.method !== "GET")).toEqual([]);
      // The record stays prepared and says why, in the copy step's words.
      expect(repullRows()).toMatchObject([{ status: "prepared" }]);
      expect(repullRows()[0]?.last_error).toStartWith("[copy:nemar-s3-invalid]");
    } finally {
      fx.cleanup();
    }
  });
});

describe.skipIf(!awsInstalled)("NEMAR-owned edits", () => {
  beforeEach(reset);

  test("a metadata file that begins with a byte-order mark is edited as the planner read it", async () => {
    const fx = await buildRepullFixture({ datasetId: XX_F, s3, bomNemarMetadata: true });
    try {
      seedMirror(XX_F);
      const path = await makePlan(fx);
      const { result } = await execute(fx, path);
      expect(result.row.status).toBe("prepared");
      const repo = workPaths(configDir, XX_F, result.row.plan_digest).repo;
      // Read as bytes: a text decoder would drop the mark it is asked about.
      const bytes = Bun.spawnSync(
        ["git", "cat-file", "blob", `${result.row.synth_sha}:.nemar/metadata.json`],
        { cwd: repo },
      ).stdout;
      expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      const meta = JSON.parse(Buffer.from(bytes.subarray(3)).toString("utf8"));
      const hit = meta.related_identifiers.find(
        (r: { relation_type: string }) => r.relation_type === "IsIdenticalTo",
      );
      expect(hit.identifier).toBe(`10.18112/openneuro.${UPSTREAM_ID}.v${TAG_B}`);
      expect(result.row.counts).toMatchObject({ nemar_owned_edits: 1, nemar_owned_edits_left: 0 });
    } finally {
      fx.cleanup();
    }
  });

  test("an edit the plan lists with another status is left as it is, said and counted", async () => {
    const fx = await buildRepullFixture({ datasetId: XX_G, s3, brokenNemarMetadata: true });
    try {
      seedMirror(XX_G);
      const path = await makePlan(fx);
      const { result, lines } = await execute(fx, path);
      expect(result.row.status).toBe("prepared");
      expect(lines.join("\n")).toContain("left as they are: 1 (unparseable)");
      expect(result.row.counts).toMatchObject({ nemar_owned_edits: 0, nemar_owned_edits_left: 1 });
      const repo = workPaths(configDir, XX_G, result.row.plan_digest).repo;
      expect(
        (await gitIn(repo, ["rev-parse", `${result.row.synth_sha}:.nemar/metadata.json`])).trim(),
      ).toBe(
        (await gitIn(repo, ["rev-parse", `${result.row.base_sha}:.nemar/metadata.json`])).trim(),
      );
    } finally {
      fx.cleanup();
    }
  });
});

describe.skipIf(!awsInstalled)("a dead recording N.0.0 would name", () => {
  test("refuses execution as the plan itself refuses it", async () => {
    await reset();
    const fx = await buildRepullFixture({
      datasetId: XX_H,
      s3,
      movedScrubbedEdf: true,
      noContributorEdits: true,
    });
    try {
      seedMirror(XX_H);
      const path = await makePlan(fx);
      const plan = JSON.parse(readFileSync(path, "utf8"));
      expect(plan.refusals.map((r: { code: string }) => r.code)).toContain(
        "dead-recording-unpinned",
      );
      const err = await refusal(execute(fx, path));
      expect(err.code).toBe("not-executable");
      expect(err.message).toContain("dead-recording-unpinned");
      expect(repullRows()).toEqual([]);
    } finally {
      fx.cleanup();
    }
  });
});

describe.skipIf(!awsInstalled)("the environment fence", () => {
  let fx: RepullFixture;
  beforeAll(async () => {
    fx = await buildRepullFixture();
  });
  afterAll(() => fx?.cleanup());
  beforeEach(reset);

  test("outside production an on dataset is refused at the record; in production it is recorded", async () => {
    seedMirror(NEMAR_ID);
    const path = await makePlan(fx);
    const err = await refusal(execute(fx, path, { until: "planned" }));
    expect(err.code).toBe("env-fence");
    expect(repullRows()).toEqual([]);
    environment = "production";
    const { result } = await execute(fx, path, { until: "planned" });
    expect(result.row.status).toBe("planned");
  });
});
