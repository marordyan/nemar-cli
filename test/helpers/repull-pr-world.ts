/**
 * A re-pull with its pull request open, built once per suite the way production builds it, for the
 * suites of what follows `pr_open` (epic #1046 phase 6, #1912; ADR 0111): `resume`, the merge gate,
 * `pr-reviews` and the release.
 *
 * Everything NEMAR's is real. The mirror and its upstream are `repull-fixture.ts`'s real git and
 * git-annex repositories, served as bare `file://` origins; the NEMAR API is the REAL datasets,
 * admin and users routers over bun:sqlite with every migration applied (`repull-full-app.ts`),
 * reached through TEST_API_URL; S3 is the scrub's stand-in driven by the REAL `aws` CLI for the
 * copy and by the Worker's own signed requests for the lock; GitHub is the suites' `Bun.serve()`
 * stand-in, with live heads read from the bare origin, a merge that squash-commits onto the origin's
 * `main` the way GitHub does with the message it is sent, and the tag and comparison reads the
 * Worker's release route makes. No mocks. The Worker runs as `production` against stand-ins only,
 * because an `on` dataset is re-pulled only there and its identifier screen is bound to the row;
 * nothing it reaches is a real service. Production ignores `S3_ENDPOINT_URL` (the fence in
 * `testS3EndpointOverride`), so the Worker addresses the AWS host as it does there, and the world
 * sends that request to the S3 stand-in at the fetch boundary (`withS3Standin`).
 *
 * The world is made once (`execute` to `pr_open`, about thirty seconds) and every test starts from a
 * snapshot of it: the origin's and upstream's refs, the bucket, the database, GitHub's pull requests.
 */

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "bun";
import { hashApiKey } from "../../backend/src/services/token";
import { storeRepullScreenResult } from "../../backend/src/services/upstream-repull-screen";
import type { Bindings } from "../../backend/src/types/bindings";
import { freshDb, realD1 } from "../../backend/test/helpers/d1";
import { makeRepullFullApp } from "../../backend/test/helpers/repull-full-app";
import { parseScreenReport } from "../../shared/identifier-screen-report";
import { runCommand } from "../../src/lib/git-annex/run-command";
import { defaultPlanPath, writePlanFile } from "../../src/lib/repull/digest";
import { planRepull } from "../../src/lib/repull/plan";
import { type S3Standin, type Snapshot, startS3Standin } from "../scrub/helpers/s3-standin";
import {
  ADMIN_TOKEN,
  type GitHubStandin,
  WORKER_TOKEN,
  startGitHubStandin,
} from "./github-standin";
import {
  CONCEPT_DOI,
  type FixtureOptions,
  type LatestSnapshotStandin,
  type RepullFixture,
  TAG_A,
  TAG_B,
  UPSTREAM_ID,
  buildRepullFixture,
  gitIn,
  refsOf,
  startLatestSnapshotStandin,
} from "./repull-fixture";

const CLI_ENTRY = join(import.meta.dir, "..", "..", "src", "index.ts");
/** The privacy ledger's path in a dataset repository (ADR 0085). */
const LEDGER = ".nemar/corrections.jsonl";

/**
 * Commit `content` at `path` onto `ref` of the bare repository `repo`, as a writer's push does: one
 * commit whose parent is the ref's commit, the rest of the tree as it was. Returns the commit and
 * the blob it wrote.
 */
async function commitFile(
  repo: string,
  ref: string,
  path: string,
  content: string,
  message: string,
  who = "t",
): Promise<{ commit: string; blob: string }> {
  const before = (await gitIn(repo, ["rev-parse", ref])).trim();
  const blob = (
    await runCommand(["git", "hash-object", "-w", "--stdin"], { cwd: repo, stdin: content })
  ).stdout.trim();
  const index = mkdtempSync(join(tmpdir(), "nemar-repull-world-index-"));
  const env = { GIT_INDEX_FILE: join(index, "index") };
  try {
    await runCommand(["git", "read-tree", ref], { cwd: repo, env });
    await runCommand(["git", "update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], {
      cwd: repo,
      env,
    });
    const tree = (await runCommand(["git", "write-tree"], { cwd: repo, env })).stdout.trim();
    const commit = (
      await runCommand(["git", "commit-tree", tree, "-p", before, "-m", message], {
        cwd: repo,
        env: {
          ...env,
          GIT_AUTHOR_NAME: who,
          GIT_AUTHOR_EMAIL: `${who}@t`,
          GIT_COMMITTER_NAME: who,
          GIT_COMMITTER_EMAIL: `${who}@t`,
        },
      })
    ).stdout.trim();
    await gitIn(repo, ["update-ref", ref, commit, before]);
    return { commit, blob };
  } finally {
    rmSync(index, { recursive: true, force: true });
  }
}
const REPO_ROOT = join(import.meta.dir, "..", "..");
const REGION = "us-east-2";
export const ADMIN_KEY = "repull-world-admin-key-0123456789abcdef0123456789ab";
/** The administrator the API seeds: their linked GitHub login is the stand-in's ADMIN_TOKEN's. */
export const ADMIN_ID = 2;

export interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
  all: string;
}

export type RepullDbRow = Record<string, unknown> & {
  id: number;
  status: string;
  counts: string;
  last_error: string | null;
  synth_sha: string;
  synth_tree: string;
  base_sha: string;
  head_sha: string | null;
  gates_sha: string | null;
  pr_number: number | null;
  merge_sha: string | null;
  merge_claim_sha: string | null;
  merge_claimed_at: string | null;
  tag_sha: string | null;
};

export interface RepullWorld {
  fx: RepullFixture;
  gh: GitHubStandin;
  s3: S3Standin;
  openNeuro: LatestSnapshotStandin;
  configDir: string;
  db(): Database;
  /** Every request to the API that is not a GET, `METHOD /path`, in order since the last restore. */
  apiWrites: string[];
  /** Runs before the API handles a request: a test's way to move the world at an exact point. */
  setApiHook(hook: ((req: Request) => Promise<void>) | null): void;
  /** Answers a request itself, ahead of the real routes: a NEMAR API that is down, say. */
  setApiOverride(override: ((req: Request) => Response | null) | null): void;
  /**
   * Replaces the answer to a request the real routes HANDLED: an answer lost on the way back after
   * the Worker wrote (a gateway's 502, say).
   */
  setApiAfter(after: ((req: Request) => Response | null) | null): void;
  /**
   * Appended to the message of the squash commit GitHub's merge writes: a host that adds a
   * paragraph of its own (a `Co-authored-by:` line, say).
   */
  setMergeMessageSuffix(suffix: string): void;
  /** The Worker's bindings, which a test may override for the rest of the test. */
  workerEnv: Partial<Bindings>;
  /** The bindings the Worker's routes run with now (the overrides included). */
  bindings(): Bindings;
  /** The NEMAR API's address, as the CLI reaches it (`TEST_API_URL`). */
  apiUrl: string;
  /**
   * `bun run <entry> admin <args>`, with the world's environment and `extra`, and `input` on
   * stdin when given (closed otherwise). The entry is the world's (`opts.cliEntry`, else this
   * checkout's `src/index.ts`) unless `entry` names another.
   */
  cli(
    args: string[],
    extra?: Record<string, string | undefined>,
    input?: string,
    entry?: string,
  ): Promise<Run>;
  /** The re-pull row, as the database holds it. */
  row(): RepullDbRow;
  /** The plan file the world was executed from. */
  plan: string;
  /**
   * Put the world back as it was at `pr_open`, or at a point `save()` took: a suite whose cases all
   * start further on (N.0.0 merged, say) reaches that point once and starts each case there,
   * instead of driving every case through the same CLI runs again.
   */
  restore(to?: WorldPoint): Promise<void>;
  /** The world as it is now, for `restore(point)`: the refs, the bucket, the database, the pulls. */
  save(): Promise<WorldPoint>;
  /**
   * Store the identifier screen's report of `sha` as the workflow's callback would, through the
   * Worker's own store (`storeRepullScreenResult`), on the screen that waits for it.
   */
  reportScreen(sha: string, status?: string): Promise<void>;
  /** Commit one file onto a ref of the bare origin, as another writer's push. */
  commitOnto(ref: string, path: string, content: string, message?: string): Promise<string>;
  /**
   * Merge one of the world's pull requests the way GitHub's own merge button does, outside
   * NEMAR's gate: a squash with GitHub's message (`title`, and `message` as its body, empty by
   * default), so the squash commit carries none of the re-pull's trailers. N.0.0's pull request
   * unless `pr` says N.0.1's. With `method: "merge"` it is GitHub's plain merge instead: a commit
   * of two parents, `main`'s tip and the pull request's head, titled `Merge pull request #N from
   * <owner>/<branch>`. Returns the merge commit.
   */
  mergeOnGitHub(opts?: {
    pr?: "n0" | "n1";
    title?: string;
    message?: string;
    method?: "squash" | "merge";
  }): Promise<string>;
  /** How many writes of the privacy ledger GitHub's Contents API took since the last restore. */
  ledgerWrites(): number;
  /** Answer reads of the ledger on `main` with this instead, until set to null. */
  setLedgerReadFault(fault: (() => Response) | null): void;
  /** Answer GitHub's comparisons of a commit with `main` with this HTTP status, until set to null. */
  setMainCompareFault(status: number | null): void;
  /**
   * Answer the writes of the ledger with this instead of making them, until set to null (or until
   * the fault returns null, when the write is made as GitHub makes it).
   */
  setLedgerWriteFault(fault: (() => Response | null | Promise<Response | null>) | null): void;
  /** What the dataset workflow does on a merge to `main`: tag `v<version>` at `main`'s head. */
  tagMain(version: string): Promise<string>;
  /** What the version DOI's callback writes: the version row, with a DOI and its upstream tag. */
  insertVersionRow(version: string): void;
  stop(): void;
}

/**
 * What `restore` puts back: origin's and upstream's refs, NEMAR's bucket, the database and the
 * GitHub stand-in's pull requests. The rest of the stand-in, the hooks and the overrides are reset
 * to how the world starts, and the record's resume, merge and settle directories are removed.
 */
export interface WorldPoint {
  origin: string;
  upstream: string;
  s3: Snapshot;
  db: Uint8Array;
  pulls: string;
}

/** The pull request the world opened, as the GitHub stand-in keys it. */
export function prKey(w: RepullWorld): string {
  return `${w.fx.datasetId}#${w.row().pr_number}`;
}

/**
 * workerd's WebCrypto digests MD5, which the s3-lock route needs for PutObjectRetention's
 * `Content-MD5`; Bun's does not ("Unrecognized algorithm name"). The world runs the Worker's routes
 * in this process, so it gives Bun's `crypto.subtle.digest` that one algorithm, through
 * `node:crypto`, for as long as the world runs: the runtime the Worker has, not a stand-in for any
 * NEMAR code. Every other algorithm is Bun's own.
 */
function withWorkerdMd5(): () => void {
  const subtle = crypto.subtle as { digest: SubtleCrypto["digest"] };
  const real = subtle.digest.bind(crypto.subtle);
  subtle.digest = (async (algorithm: AlgorithmIdentifier, data: BufferSource) => {
    const name = typeof algorithm === "string" ? algorithm : algorithm.name;
    if (name.toUpperCase() !== "MD5") return real(algorithm, data);
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const out = createHash("md5").update(bytes).digest();
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
  }) as SubtleCrypto["digest"];
  return () => {
    subtle.digest = real;
  };
}

/** `<bucket>.s3[.<region>].amazonaws.com`: the bucket is the host's leading labels. */
const AWS_S3_VIRTUAL_HOSTED = /^(.+)\.s3(?:\.[a-z0-9-]+)?\.amazonaws\.com$/;
/** `s3[.<region>].amazonaws.com`: the bucket is the first segment of the path. */
const AWS_S3_PATH_STYLE = /^s3(?:\.[a-z0-9-]+)?\.amazonaws\.com$/;

/**
 * Where a request to `href` goes in the world: the stand-in's own address (`/<bucket>/<key>`) for
 * a request to an AWS S3 host in either form, `null` for a host that is not AWS's, and a throw for
 * an AWS host that is not S3, because the world has no stand-in for any other AWS service and a
 * request there would be a real one.
 */
function s3StandinAddress(href: string, standin: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (!host.endsWith(".amazonaws.com")) return null;
  const bucket = AWS_S3_VIRTUAL_HOSTED.exec(host)?.[1];
  if (bucket) return `${standin}/${bucket}${url.pathname}${url.search}`;
  if (AWS_S3_PATH_STYLE.test(host)) return `${standin}${url.pathname}${url.search}`;
  throw new Error(`the re-pull world has a stand-in for S3 only, and ${host} is not S3`);
}

/**
 * The Worker reaches S3 at `<bucket>.s3.<region>.amazonaws.com`, as it does in production: its
 * `S3_ENDPOINT_URL` override is honored only outside production (`testS3EndpointOverride`), and
 * this world runs it as `production`, so no binding can point it at the stand-in. The world
 * reaches the stand-in where the network begins instead, the way
 * backend/test/availability-report-never-creates-main.test.ts does: a request this process makes
 * to an AWS S3 host is sent to the stand-in with the headers and body the Worker signed, one to
 * any other AWS host is refused, and every other request passes on untouched. Only the network is
 * replaced; the Worker builds, signs and reads each request itself, and the stand-in answers.
 * The returned function puts the real `fetch` back, so no other test in the process sees this.
 */
function withS3Standin(standin: string): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const address = s3StandinAddress(href, standin);
    if (address === null) return real(input, init);
    return real(new Request(address, new Request(input, init)));
  }) as typeof fetch;
  return () => {
    globalThis.fetch = real;
  };
}

export async function startRepullWorld(
  opts: {
    datasetId?: string;
    fixture?: FixtureOptions;
    /**
     * Run the administrator's `execute` to `pr_open` before the world is saved (the default);
     * false saves it with the plan made and nothing recorded, for a suite that opens the pull
     * request itself (the automatic run's).
     */
    execute?: boolean;
    /** The CLI entry `cli()` runs (a release build's, say); this checkout's `src/index.ts` by default. */
    cliEntry?: string;
  } = {},
): Promise<RepullWorld> {
  const restoreDigest = withWorkerdMd5();
  const gh = startGitHubStandin();
  const openNeuro = startLatestSnapshotStandin(TAG_B);
  const s3 = startS3Standin({ region: REGION });
  const handle = makeRepullFullApp();
  const origins = new Map<string, string>();
  let db = freshDb();
  const apiWrites: string[] = [];
  let apiHook: ((req: Request) => Promise<void>) | null = null;
  let apiOverride: ((req: Request) => Response | null) | null = null;
  let apiAfter: ((req: Request) => Response | null) | null = null;
  let mergeMessageSuffix = "";
  let ledgerWrites = 0;
  let ledgerWriteFault: (() => Response | null | Promise<Response | null>) | null = null;
  let ledgerReadFault: (() => Response) | null = null;
  let mainCompareFault: number | null = null;
  const workerEnv: Partial<Bindings> = {};
  const configDir = mkdtempSync(join(tmpdir(), "nemar-repull-world-"));

  const rev = async (repo: string, spec: string): Promise<string | null> => {
    const r = await runCommand(["git", "rev-parse", "--verify", "--quiet", spec], { cwd: repo });
    return r.exitCode === 0 ? r.stdout.trim() : null;
  };
  gh.liveHeads = true;
  gh.resolveHead = async (dataset, ref) => {
    const origin = origins.get(dataset);
    return origin ? rev(origin, `refs/heads/${ref}`) : null;
  };
  gh.resolveTag = async (dataset, tag) => {
    const origin = origins.get(dataset);
    return origin ? rev(origin, `refs/tags/${tag}^{commit}`) : null;
  };
  // GitHub's comparison of `base...head` (`head` may be `main`): its word, the commits each side
  // has, and the files changed from the merge base. Two commits with no common history are what
  // GitHub answers 404 for ("No common ancestor"), and so does this.
  gh.compareCommits = async (dataset, base, rawHead) => {
    const origin = origins.get(dataset);
    if (!origin) return null;
    if (rawHead === "main" && mainCompareFault !== null) return mainCompareFault;
    const head = rawHead === "main" ? await rev(origin, "refs/heads/main") : rawHead;
    if (
      !head ||
      !(await rev(origin, `${base}^{commit}`)) ||
      !(await rev(origin, `${head}^{commit}`))
    ) {
      return null;
    }
    const common = await runCommand(["git", "merge-base", base, head], { cwd: origin });
    if (common.exitCode !== 0) return null;
    const isAncestor = async (a: string, b: string) =>
      (await runCommand(["git", "merge-base", "--is-ancestor", a, b], { cwd: origin })).exitCode ===
      0;
    const status =
      base === head
        ? "identical"
        : (await isAncestor(base, head))
          ? "ahead"
          : (await isAncestor(head, base))
            ? "behind"
            : "diverged";
    // GitHub's own fields: the commits each side has, and the files changed from the merge base.
    const count = async (range: string) =>
      Number((await gitIn(origin, ["rev-list", "--count", range])).trim());
    const mergeBase = common.stdout.trim();
    const words: Record<string, string> = { A: "added", M: "modified", D: "removed" };
    const files = (
      await gitIn(origin, ["diff", "--no-renames", "--name-status", "-z", mergeBase, head])
    )
      .split("\0")
      .filter(Boolean)
      .reduce<Array<{ filename: string; status: string }>>((out, field, i, all) => {
        if (i % 2 === 0) {
          out.push({ filename: all[i + 1] as string, status: words[field] ?? "changed" });
        }
        return out;
      }, []);
    return {
      status,
      ahead_by: await count(`${base}..${head}`),
      behind_by: await count(`${head}..${base}`),
      files,
    };
  };
  // The Git Data reads and the Contents read and write of the privacy ledger, as GitHub answers
  // them, from and to the bare origin: what the Worker's acceptance of a merge made without its
  // trailers reads and writes (ADR 0111, the amendment of 2026-10-29). Any other path falls through.
  gh.gitData = async (dataset, r) => {
    const origin = origins.get(dataset);
    if (!origin) return null;
    const commit = /^git\/commits\/([0-9a-f]{40})$/.exec(r.path);
    if (r.method === "GET" && commit) {
      const sha = commit[1] as string;
      if ((await rev(origin, `${sha}^{commit}`)) !== sha) {
        return Response.json({ message: "Not Found" }, { status: 404 });
      }
      const [, ...parents] = (await gitIn(origin, ["rev-list", "--parents", "-n", "1", sha]))
        .trim()
        .split(" ");
      return Response.json({
        sha,
        tree: { sha: (await gitIn(origin, ["rev-parse", `${sha}^{tree}`])).trim() },
        parents: parents.map((p) => ({ sha: p })),
        message: await gitIn(origin, ["log", "-1", "--format=%B", sha]),
      });
    }
    const tree = /^git\/trees\/([0-9a-f]{40})$/.exec(r.path);
    if (r.method === "GET" && tree) {
      const sha = tree[1] as string;
      const listed = await runCommand(["git", "ls-tree", "-z", sha], { cwd: origin });
      if (listed.exitCode !== 0) return Response.json({ message: "Not Found" }, { status: 404 });
      return Response.json({
        sha,
        truncated: false,
        tree: listed.stdout
          .split("\0")
          .filter(Boolean)
          .map((e) => {
            const [meta, path] = e.split("\t") as [string, string];
            const [mode, type, oid] = meta.split(" ") as [string, string, string];
            return { path, mode, type, sha: oid };
          }),
      });
    }
    if (r.path !== `contents/${LEDGER}`) return null;
    if (r.method === "GET") {
      const ref = r.query.get("ref") ?? "main";
      if (ref === "main" && ledgerReadFault) return ledgerReadFault();
      const at = /^[0-9a-f]{40}$/.test(ref) ? ref : `refs/heads/${ref}`;
      const blob = await rev(origin, `${at}:${LEDGER}`);
      if (!blob) return Response.json({ message: "Not Found" }, { status: 404 });
      const bytes = (await runCommand(["git", "cat-file", "blob", blob], { cwd: origin })).stdout;
      return Response.json({
        type: "file",
        path: LEDGER,
        sha: blob,
        encoding: "base64",
        content: Buffer.from(bytes, "utf8").toString("base64"),
      });
    }
    if (r.method === "PUT") {
      ledgerWrites += 1;
      const faulted = ledgerWriteFault ? await ledgerWriteFault() : null;
      if (faulted) return faulted;
      const b = r.body as { content?: string; sha?: string; branch?: string; message?: string };
      const branch = `refs/heads/${b.branch ?? "main"}`;
      const head = await rev(origin, branch);
      const current = head ? await rev(origin, `${head}:${LEDGER}`) : null;
      if (!head || (current ?? undefined) !== b.sha) {
        return Response.json({ message: `${LEDGER} does not match ${b.sha}` }, { status: 409 });
      }
      const text = Buffer.from(b.content ?? "", "base64").toString("utf8");
      const made = await commitFile(origin, branch, LEDGER, text, b.message ?? "", "nemarAdmin");
      return Response.json({ content: { sha: made.blob }, commit: { sha: made.commit } });
    }
    return null;
  };
  // GitHub's squash merge: one commit on `main` holding the head's tree, with the title and the
  // message the merge was sent (GitHub's own default lists the commits as bullets instead). A
  // simplification: GitHub's squash is a three-way merge of the head onto `main`, which is the
  // head's tree only while `main` is the pull request's base; a suite that moves `main` first and
  // needs the three-way result builds it itself.
  gh.onMerge = async (dataset, number, body) => {
    const origin = origins.get(dataset);
    const p = gh.pulls[`${dataset}#${number}`];
    if (!origin || !p) return null;
    const head = await rev(origin, `refs/heads/${p.headRef}`);
    const main = await rev(origin, "refs/heads/main");
    if (!head || !main) return null;
    // GitHub's plain merge: a merge commit of `main` and the head, and the head's tree under the
    // same simplification as the squash's.
    if (body.merge_method === "merge") {
      const made = await runCommand(
        [
          "git",
          "commit-tree",
          `${head}^{tree}`,
          "-p",
          main,
          "-p",
          head,
          "-m",
          `Merge pull request #${number} from nemarDatasets/${p.headRef}`,
        ],
        {
          cwd: origin,
          env: {
            GIT_AUTHOR_NAME: "GitHub",
            GIT_AUTHOR_EMAIL: "noreply@github.com",
            GIT_COMMITTER_NAME: "GitHub",
            GIT_COMMITTER_EMAIL: "noreply@github.com",
          },
        },
      );
      if (made.exitCode !== 0) return null;
      const merged = made.stdout.trim();
      await gitIn(origin, ["update-ref", "refs/heads/main", merged, main]);
      return merged;
    }
    const title =
      typeof body.commit_title === "string" ? body.commit_title : `${p.title} (#${number})`;
    const message =
      typeof body.commit_message === "string"
        ? body.commit_message
        : `* ${(await gitIn(origin, ["log", "-1", "--format=%B", head])).trim().replace(/\n/g, "\n  ")}`;
    const r = await runCommand(["git", "commit-tree", `${head}^{tree}`, "-p", main, "-F", "-"], {
      cwd: origin,
      stdin: `${title}\n\n${message}${mergeMessageSuffix}\n`,
      env: {
        GIT_AUTHOR_NAME: "GitHub",
        GIT_AUTHOR_EMAIL: "noreply@github.com",
        GIT_COMMITTER_NAME: "GitHub",
        GIT_COMMITTER_EMAIL: "noreply@github.com",
      },
    });
    if (r.exitCode !== 0) return null;
    const merge = r.stdout.trim();
    await gitIn(origin, ["update-ref", "refs/heads/main", merge, main]);
    return merge;
  };
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = gh.url;

  const bindings = (): Bindings =>
    ({
      DB: realD1(db),
      ENVIRONMENT: "production",
      GITHUB_ADMIN_PAT: WORKER_TOKEN,
      API_BASE_URL: "https://api.test.nemar.org",
      PRESCREEN_CALLBACK_SECRET: "repull-world-callback-secret",
      S3_BUCKET: "nemar",
      AWS_REGION: REGION,
      AWS_ACCESS_KEY_ID: "AKIAREPULLWORLD00001",
      AWS_SECRET_ACCESS_KEY: "repull-world-worker-secret",
      ...workerEnv,
    }) as Bindings;
  const apiServer = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/notices") return Response.json({ notices: [] });
      if (req.method !== "GET") apiWrites.push(`${req.method} ${url.pathname}`);
      if (apiHook) await apiHook(req.clone());
      const overridden = apiOverride?.(req);
      if (overridden) return overridden;
      const answered = await handle(req, bindings());
      return apiAfter?.(req) ?? answered;
    },
  });
  const apiUrl = `http://127.0.0.1:${apiServer.port}`;
  const awsHome = join(configDir, "aws-home");
  mkdirSync(awsHome, { recursive: true });
  writeFileSync(join(awsHome, "config"), `[profile repull-world]\nregion = ${REGION}\n`);
  writeFileSync(join(awsHome, "credentials"), "");

  const fx = await buildRepullFixture({ ...opts.fixture, datasetId: opts.datasetId, s3 });
  origins.set(fx.datasetId, fx.originRepo);

  const seed = async (d: Database) => {
    d.run(
      `INSERT INTO users (id, username, email, password_hash, status, role, email_verified)
       VALUES (1, 'owner', 'owner@example.org', 'x', 'approved', 'member', 1)`,
    );
    d.run(
      `INSERT INTO users (id, username, email, password_hash, github_username, status, role,
                          signup_source, email_verified, service_access)
       VALUES (?, 'repulladmin', 'repulladmin@example.org', 'x', 'queueadmin-gh', 'approved',
               'admin', 'cli', 1, 1)`,
      [ADMIN_ID],
    );
    d.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
      ADMIN_ID,
      await hashApiKey(ADMIN_KEY),
      ADMIN_KEY.slice(0, 8),
    );
    d.run(
      `INSERT INTO datasets
         (dataset_id, name, owner_user_id, status, visibility, is_sandbox, github_repo,
          first_published_at, source, source_id, concept_doi, anonymous)
       VALUES (?, 'A sufficiently descriptive fixture title', 1, 'active', 'public', 0, ?,
               '2026-01-01 00:00:00', 'openneuro', ?, ?, 0)`,
      [fx.datasetId, `nemarDatasets/${fx.datasetId}`, UPSTREAM_ID, CONCEPT_DOI],
    );
    d.run(
      `INSERT INTO dataset_versions (dataset_id, version, doi, provider, created_at, source_version, source_version_basis)
       VALUES (?, '1.0.0', ?, 'ezid', '2026-01-01 00:00:00', ?, 'doi')`,
      [fx.datasetId, `10.82901/nemar.${fx.datasetId}.v1.0.0`, TAG_A],
    );
  };
  await seed(db);
  writeFileSync(
    join(configDir, "config.json"),
    JSON.stringify({
      activeAccount: "repulladmin",
      accounts: { repulladmin: { apiKey: ADMIN_KEY } },
    }),
  );

  const childEnv = (extra: Record<string, string | undefined> = {}): Record<string, string> => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      ...fx.env,
      NEMAR_CONFIG_DIR: configDir,
      TEST_API_URL: apiUrl,
      NEMAR_NO_UPDATE_CHECK: "1",
      NO_COLOR: "1",
      GH_TOKEN: ADMIN_TOKEN,
      NEMAR_GITHUB_API_URL: gh.url,
      NEMAR_REPULL_OPENNEURO_URL: openNeuro.url,
      NEMAR_REPULL_UPSTREAM_OBJECTS_BASE: s3.url,
      NEMAR_REPULL_POLL_MS: "200",
      AWS_ACCESS_KEY_ID: "ASIATESTDUMMY000002",
      AWS_SECRET_ACCESS_KEY: "dummySecretAccessKeyForRepullWorld",
      AWS_SESSION_TOKEN: "dummy-session-token-for-repull-world",
      AWS_CONFIG_FILE: join(awsHome, "config"),
      AWS_SHARED_CREDENTIALS_FILE: join(awsHome, "credentials"),
      AWS_EC2_METADATA_DISABLED: "true",
      AWS_MAX_ATTEMPTS: "1",
      AWS_ENDPOINT_URL_S3: s3.url,
      AWS_PROFILE: "repull-world",
      FORCE_COLOR: undefined,
      CLICOLOR_FORCE: undefined,
      ...extra,
    };
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) if (v !== undefined) clean[k] = v;
    return clean;
  };
  const cli = async (
    args: string[],
    extra: Record<string, string | undefined> = {},
    input?: string,
    entry: string = opts.cliEntry ?? CLI_ENTRY,
  ) => {
    const proc = spawn({
      cmd: ["bun", "run", entry, "admin", ...args],
      cwd: REPO_ROOT,
      env: childEnv(extra),
      stdin: input === undefined ? "ignore" : new Blob([input]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr, all: `${stdout}\n${stderr}` };
  };

  // The plan, as `nemar admin repull plan` makes it and writes it.
  const scratch = mkdtempSync(join(tmpdir(), "nemar-repull-world-plan-"));
  let plan: string;
  try {
    const out = await planRepull({
      datasetId: fx.datasetId,
      catalog: {
        dataset: { source: "openneuro", source_id: UPSTREAM_ID, concept_doi: CONCEPT_DOI },
        versions: [{ version: "1.0.0", source_version: TAG_A, source_version_basis: "doi" }],
      },
      github: { token: ADMIN_TOKEN, apiBase: gh.url },
      env: fx.env,
      environment: apiUrl,
      workRoot: scratch,
      openNeuroGraphqlUrl: openNeuro.url,
    });
    if (!out.planned) throw new Error(`not planned: ${out.reason}`);
    if (!out.file.executable) throw new Error("the world's plan is not executable");
    plan = defaultPlanPath(configDir, fx.datasetId, TAG_B, out.file.digest);
    writePlanFile(plan, out.file);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  if (opts.execute !== false) {
    const run = await cli(["repull", "execute", plan, "--yes"], {}, undefined, CLI_ENTRY);
    const opened = db.query("SELECT status FROM upstream_repulls").get() as {
      status: string;
    } | null;
    if (run.exitCode !== 0 || opened?.status !== "pr_open") {
      throw new Error(`the world did not reach pr_open (exit ${run.exitCode}):\n${run.all}`);
    }
  }

  const point = async (): Promise<WorldPoint> => ({
    origin: await refsOf(fx.originRepo),
    upstream: await refsOf(fx.upstreamRepo),
    s3: s3.snapshot() as Snapshot,
    db: db.serialize(),
    pulls: JSON.stringify(gh.pulls),
  });
  const saved = await point();
  const restoreRefs = async (repo: string, refs: string) => {
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
  };

  const world: RepullWorld = {
    fx,
    gh,
    s3,
    openNeuro,
    configDir,
    db: () => db,
    apiWrites,
    setApiHook: (h) => {
      apiHook = h;
    },
    setApiOverride: (o) => {
      apiOverride = o;
    },
    setApiAfter: (a) => {
      apiAfter = a;
    },
    setMergeMessageSuffix: (suffix) => {
      mergeMessageSuffix = suffix;
    },
    workerEnv,
    bindings,
    apiUrl,
    cli,
    plan,
    row: () =>
      db.query("SELECT * FROM upstream_repulls ORDER BY id DESC LIMIT 1").get() as RepullDbRow,
    save: point,
    async restore(to = saved) {
      await restoreRefs(fx.originRepo, to.origin);
      await restoreRefs(fx.upstreamRepo, to.upstream);
      s3.restore(to.s3);
      db = Database.deserialize(to.db);
      gh.reset();
      Object.assign(gh.pulls, JSON.parse(to.pulls));
      apiWrites.length = 0;
      apiHook = null;
      apiOverride = null;
      apiAfter = null;
      mergeMessageSuffix = "";
      ledgerWrites = 0;
      ledgerWriteFault = null;
      ledgerReadFault = null;
      mainCompareFault = null;
      for (const k of Object.keys(workerEnv)) delete (workerEnv as Record<string, unknown>)[k];
      for (const purpose of ["resume", "merge", "settle"]) {
        rmSync(join(configDir, "repull", fx.datasetId, purpose), { recursive: true, force: true });
      }
    },
    async reportScreen(sha, status = "clean") {
      const waiting = db
        .query(
          "SELECT s.id AS id, s.nonce AS nonce FROM upstream_repull_screens s WHERE s.sha = ? AND s.nonce IS NOT NULL",
        )
        .get(sha) as { id: number; nonce: string } | null;
      if (!waiting) throw new Error(`no screen of ${sha} waits for its report`);
      const report = parseScreenReport({
        version: 1,
        scanner: "identifier-scan@abcdef1",
        head: sha,
        scan: {
          id: fx.datasetId,
          version: null,
          scanned_at: "2026-10-25T12:00:00.000Z",
          manifest_source: "clone",
          status,
          incomplete: false,
          incomplete_reasons: [],
          files: { total: 10, edf_bdf: 2, header_read: 2, header_read_failed: 0 },
        },
      });
      const stored = await storeRepullScreenResult(realD1(db), {
        datasetId: fx.datasetId,
        screenId: waiting.id,
        sha,
        nonce: waiting.nonce,
        body: report,
      });
      if (!stored.stored) throw new Error("the screen's report was not stored");
    },
    async commitOnto(ref, path, content, message = "a later commit") {
      return (await commitFile(fx.originRepo, ref, path, content, message)).commit;
    },
    async mergeOnGitHub(o = {}) {
      const row = db
        .query(
          "SELECT pr_number, patch_pr_number, to_version, patch_version FROM upstream_repulls ORDER BY id DESC LIMIT 1",
        )
        .get() as {
        pr_number: number;
        patch_pr_number: number | null;
        to_version: string;
        patch_version: string | null;
      };
      const n1 = o.pr === "n1";
      const number = n1 ? (row.patch_pr_number as number) : row.pr_number;
      const version = n1 ? row.patch_version : row.to_version;
      const res = await fetch(
        `${gh.url}/repos/nemarDatasets/${fx.datasetId}/pulls/${number}/merge`,
        {
          method: "PUT",
          headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            merge_method: o.method ?? "squash",
            commit_title: o.title ?? `Release v${version} (#${number})`,
            commit_message: o.message ?? "",
          }),
        },
      );
      const answer = (await res.json()) as { merged?: boolean; sha?: string };
      if (!answer.merged || !answer.sha)
        throw new Error(`GitHub's merge did not merge: ${res.status}`);
      return answer.sha;
    },
    ledgerWrites: () => ledgerWrites,
    setLedgerReadFault: (fault) => {
      ledgerReadFault = fault;
    },
    setMainCompareFault: (status) => {
      mainCompareFault = status;
    },
    setLedgerWriteFault: (fault) => {
      ledgerWriteFault = fault;
    },
    async tagMain(version) {
      const repo = fx.originRepo;
      // Annotated, as the dataset workflow's tags are: `git ls-remote` then lists the tag object
      // and, only when asked for by name, the commit it names (the peeled line).
      await gitIn(repo, [
        "-c",
        "user.name=nemar-bot",
        "-c",
        "user.email=nemar-bot@users.noreply.github.com",
        "tag",
        "-a",
        "-m",
        `Release v${version}`,
        `v${version}`,
        "refs/heads/main",
      ]);
      return (await gitIn(repo, ["rev-parse", `refs/tags/v${version}^{commit}`])).trim();
    },
    insertVersionRow(version) {
      db.run(
        `INSERT INTO dataset_versions (dataset_id, version, doi, provider, created_at, source_version, source_version_basis)
         VALUES (?, ?, ?, 'ezid', datetime('now'), ?, 'doi')`,
        [fx.datasetId, version, `10.82901/nemar.${fx.datasetId}.v${version}`, TAG_B],
      );
    },
    stop() {
      restoreFetch();
      restoreDigest();
      (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
      apiServer.stop(true);
      gh.stop();
      openNeuro.stop();
      s3.stop();
      fx.cleanup();
      Bun.spawnSync(["chmod", "-R", "u+w", configDir]);
      rmSync(configDir, { recursive: true, force: true });
    },
  };
  // The fetch rewrite goes in last, after everything that can throw, so a world that fails to
  // start never leaves it installed for the rest of the process; `stop()` puts the real fetch
  // back. Setup makes the Worker call no S3: the one S3 route these suites use is s3-lock, which
  // a test reaches through the finished world.
  const restoreFetch = withS3Standin(s3.url);
  return world;
}

/** `.nemar/metadata.json` at `rev` with one key more, as an enrichment run rewrites it. */
export async function enrichedMetadata(repo: string, rev: string, stamp = "2026-10-25T00:00:00Z") {
  const meta = JSON.parse(await gitIn(repo, ["show", `${rev}:.nemar/metadata.json`]));
  return `${JSON.stringify({ ...meta, enriched_at: stamp }, null, 2)}\n`;
}

/** The plan file's digest. */
export function digestOf(plan: string): string {
  return JSON.parse(readFileSync(plan, "utf8")).digest as string;
}
