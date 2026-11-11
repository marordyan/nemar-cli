/**
 * Execution past `prepared` (ADR 0111, decisions 2 and 8; epic #1046 phase 6): the copy, the
 * registration, the release branch and its pull request.
 *
 *   S3  `prepared -> copied`: the copy manifest rebuilt from the synthesized commit and the plan,
 *       and its digest compared with the recorded one; the staging manifest written; every key it
 *       copies copied from upstream at its pinned version (`copy.ts`); then every key of the
 *       manifest, copied or uploaded, present at its declared size in a fresh listing;
 *   S4  `copied -> registered`: the tree gate and one registration commit on origin's git-annex
 *       branch, proved from origin (`register.ts`);
 *   S5  `registered -> pr_open`: `main` checked, the release branch pushed or found, the pull
 *       request found or opened with the administrator's token (`pull-request.ts`).
 *
 * Each step runs on the synthesized commit in a working clone that holds it: the one preparation
 * left, or one restored from the checkpoint. Before each, upstream's tag must still be the commit
 * the plan read (`upstream-tag-moved`), because the commit's trailers name it. A step that fails
 * records why on the row with the error prefix of its step (`[copy:`, `[register:`, `[pr:`, never
 * `[prepare:`, which only a preparation clears) and refuses; nothing it did is undone, and the next
 * run checks what is already there before it acts. At `pr_open`, and on any later run that finds
 * the record there, the working directory, which holds the delta's unscrubbed originals in a local
 * commit, is removed unless `--keep-workdir`.
 *
 * Every push and S3 call goes through the write guard (`write-guard.ts`). Execution never merges.
 */

import { dirname } from "node:path";
import {
  AwsCliError,
  DEFAULT_TIMEOUT_MS,
  cliCredentialSource,
  createAwsRunner,
  failureWord,
} from "../../../../scripts/scrub/s3/s3-lib.js";
import type { RepullRow, RepullStatus } from "../../../../shared/repull-state.js";
import { UPSTREAM_BUCKET } from "../../fleet-content-recovery.js";
import { fleetCloneEnv } from "../../fleet-key-registration.js";
import { verifyManifestObjects } from "../../import-finalize-gate.js";
import { describeError } from "../../import-scrub.js";
import type { ImportManifestItem } from "../../s3-server-copy.js";
import type { PlanBody } from "../digest.js";
import { isNemarOwnedPath } from "../overlay.js";
import { nemarRemoteOf } from "../plan.js";
import { type Env, originUrl, readRemoteLog, upstreamUrl } from "../sources.js";
import { type AwsGuardContext, RepullWriteRefused, guardedAws } from "../write-guard.js";
import { planCounts, planFacts } from "./body.js";
import {
  type CopyRunners,
  UPSTREAM_REGION,
  copyPinned,
  listPrefixSizes,
  stagingManifestKey,
  writeStagingManifest,
} from "./copy.js";
import {
  acceptsHead,
  checkMain,
  openRelease,
  pushRelease,
  releaseBody,
  releaseRefOf,
} from "./pull-request.js";
import { annexedKeysAt, registerCopied } from "./register.js";
import { heldKeys } from "./scrub-delta.js";
import { type CopyManifest, buildCopyManifest, manifestDigest } from "./synthesize.js";
import { ExecuteRefused, inStep } from "./verify-plan.js";
import { type WorkPaths, git, privateDir, removeTree, restoreCheckpoint } from "./workdir.js";

/** The statuses execution can stop at, in order: it never goes past the open pull request. */
export const EXECUTE_STATUSES = ["planned", "prepared", "copied", "registered", "pr_open"] as const;

/** Whether `status` has reached `until` (a status past `pr_open` has reached every one). */
export function reached(status: RepullStatus, until: RepullStatus): boolean {
  const order = EXECUTE_STATUSES as readonly RepullStatus[];
  const at = order.indexOf(status);
  return at < 0 || at >= order.indexOf(until);
}

/** What the steps past `prepared` share. */
export interface AdvanceContext {
  env: Env;
  token: string | null;
  datasetId: string;
  digest: string;
  body: PlanBody;
  paths: WorkPaths;
  /** GitHub's API origin (a loopback stand-in in tests). */
  apiBase: string;
  keepWorkdir: boolean;
  out: (line: string) => void;
  /** Tests only: the copy's single-copy bound and part size. */
  copy?: { singleCopyMax?: number; partBytes?: number };
  /**
   * A dispatched run's check at the start of the copy, the registration and the pull request
   * (`automatic.ts`, `tokenHourRefusal`): it throws to refuse the step, which is recorded as the
   * step's error like any other. Absent for an administrator's run.
   */
  beforeStep?: (step: StepName) => void;
  /** Where a dispatched run's step durations go, in milliseconds, whether the step held or not. */
  timed?: (step: StepName, ms: number) => void;
}

/** The steps past `prepared`. */
export type StepName = "copy" | "register" | "pr";

/** How the steps write the record: one allowed edge, or why a step failed (a self-edge). */
export interface Recorder {
  transition(row: RepullRow, to: RepullStatus, fields: Record<string, unknown>): Promise<RepullRow>;
  recordError(row: RepullRow, words: string): Promise<void>;
}

/** `[<step>:<code>] <message>`, the words a step's failure records. */
export function stepErrorWords(step: "copy" | "register" | "pr", err: unknown): string {
  if (err instanceof ExecuteRefused) return `[${step}:${err.code}] ${err.message}`;
  if (err instanceof RepullWriteRefused) return `[${step}:write-refused] ${err.message}`;
  if (err instanceof AwsCliError) {
    return `[${step}:s3-failed] An S3 call failed (${failureWord(err)}).`;
  }
  return `[${step}:${step}-failed] The step failed: ${describeError(err)}.`;
}

/** A failure as the step's refusal (its code kept), for the caller to report. */
function asRefusal(step: StepName, err: unknown): ExecuteRefused {
  if (err instanceof ExecuteRefused) return err;
  const words = stepErrorWords(step, err);
  const code = /^\[[a-z]+:([a-z0-9-]+)\]/.exec(words)?.[1] ?? `${step}-failed`;
  return new ExecuteRefused(code, words.replace(/^\[[^\]]+\] /, ""));
}

/** NEMAR's remote as the working clone's git-annex branch names it, and the one prefix it allows. */
async function nemarRemote(work: string, datasetId: string) {
  const remote = nemarRemoteOf(await readRemoteLog(work), datasetId);
  // The bucket becomes the write guard's one destination and the region a host: refused unless S3
  // can have both.
  if (remote.problem !== null) throw new ExecuteRefused("nemar-s3-invalid", remote.problem);
  const bucket = remote.record?.bucket;
  const prefix = `${datasetId}/objects/`;
  if (!remote.uuid || !bucket) {
    throw new ExecuteRefused("no-nemar-s3", "NEMAR's remote.log names no single nemar-s3 bucket.");
  }
  if (remote.prefix !== prefix) {
    throw new ExecuteRefused(
      "destination-prefix",
      `NEMAR's nemar-s3 is not at ${prefix}, the only prefix a re-pull writes to.`,
    );
  }
  return { uuid: remote.uuid, bucket, region: remote.region, prefix };
}

/** The upstream tag must still be the commit the plan read: the commit's trailers name it. */
async function assertUpstreamTag(work: string, ctx: AdvanceContext): Promise<void> {
  const facts = planFacts(ctx.body);
  const url = upstreamUrl(facts.ds, ctx.env);
  const env = fleetCloneEnv(url, null);
  // The peeled line is asked for by name: for an exact ref `git ls-remote` shows it only then.
  const r = await git(
    work,
    ["ls-remote", url, `refs/tags/${facts.toTag}`, `refs/tags/${facts.toTag}^{}`],
    {
      ...(env ? { env } : {}),
      ok: true,
    },
  );
  const lines = new Map(
    r.stdout
      .split("\n")
      .map((l) => l.split("\t"))
      .filter((f) => f.length === 2)
      .map(([oid, name]) => [name as string, oid as string]),
  );
  const commit =
    lines.get(`refs/tags/${facts.toTag}^{}`) ?? lines.get(`refs/tags/${facts.toTag}`) ?? null;
  if (r.exitCode !== 0 || commit === null) {
    throw new ExecuteRefused(
      "upstream-unreadable",
      `Upstream's tag ${facts.toTag} could not be read.`,
    );
  }
  if (commit !== facts.toCommit) {
    throw new ExecuteRefused(
      "upstream-tag-moved",
      `Upstream's tag ${facts.toTag} names another commit than the one the plan read: OpenNeuro re-created the snapshot. This re-pull cannot continue: its record has to be ended (nemar admin repull abandon <id>) and the dataset planned again.`,
    );
  }
}

/**
 * The working clone at the recorded synthesized commit: as preparation left it, or restored from
 * the checkpoint (`checkpoint-lost` when neither holds it; `nemar admin repull abandon` is the way out).
 */
async function holdSynthesized(ctx: AdvanceContext, row: RepullRow): Promise<string> {
  const synthSha = row.synth_sha as string;
  const synthTree = row.synth_tree as string;
  const repo = ctx.paths.repo;
  const rev = async (spec: string) =>
    (await git(repo, ["rev-parse", "--verify", "--quiet", spec], { ok: true })).stdout.trim();
  try {
    if ((await rev("HEAD")) === synthSha && (await rev("HEAD^{tree}")) === synthTree) return repo;
  } catch {
    // no working clone: restored below
  }
  privateDir(ctx.paths.root, dirname(dirname(ctx.paths.lock)));
  const annexCommit = planFacts(ctx.body).annexCommit;
  const restored = await restoreCheckpoint({
    dir: repo,
    bundle: ctx.paths.bundle,
    originUrl: originUrl(ctx.datasetId, ctx.env),
    baseSha: row.base_sha,
    token: ctx.token,
    // Before the registration origin's git-annex branch is where the plan read it; after, it moved.
    annexCommit: row.status === "prepared" ? annexCommit : null,
    bundleAnnex: annexCommit,
    synthSha,
    synthTree,
  });
  if (restored !== null) {
    throw new ExecuteRefused(
      "checkpoint-lost",
      `Re-pull #${row.id}'s working clone and its checkpoint do not hold the recorded commit (${restored}); this re-pull cannot continue: its record has to be ended (nemar admin repull abandon <id>) and the dataset planned again.`,
    );
  }
  ctx.out(`Re-pull #${row.id}'s working clone was restored from the checkpoint.`);
  return repo;
}

/**
 * The copy manifest, rebuilt from the synthesized commit and the plan (it is a function of both),
 * and refused unless its digest is the recorded one.
 */
async function rebuildManifest(
  work: string,
  ctx: AdvanceContext,
  row: RepullRow,
): Promise<CopyManifest> {
  const named = new Set<string>();
  for (const [p, k] of await annexedKeysAt(work, row.synth_sha as string)) {
    if (!isNemarOwnedPath(p)) named.add(k);
  }
  const ours = new Set((await annexedKeysAt(work, row.base_sha)).values());
  const manifest = buildCopyManifest({
    named,
    body: ctx.body,
    digest: ctx.digest,
    held: heldKeys(ctx.body, ours),
  });
  if (manifestDigest(manifest) !== row.manifest_digest) {
    throw new ExecuteRefused(
      "manifest-mismatch",
      "The copy manifest rebuilt from the synthesized commit is not the one recorded at prepared.",
    );
  }
  return manifest;
}

/** The two guarded runners of one execution, with the ambient short-lived AWS credentials. */
function runners(ctx: AdvanceContext, region: string, guard: AwsGuardContext): CopyRunners {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(ctx.env)) if (v !== undefined) env[k] = v;
  const credentials = cliCredentialSource({ commandEnv: env });
  const make = (r: string) =>
    guardedAws(
      createAwsRunner({ region: r, timeoutMs: DEFAULT_TIMEOUT_MS, env, credentials }),
      guard,
    );
  return { source: make(UPSTREAM_REGION), dest: make(region) };
}

function manifestItems(
  manifest: CopyManifest,
  bucket: string,
  prefix: string,
): ImportManifestItem[] {
  return [
    ...manifest.items.map((i) => ({
      key: i.key,
      sourceUrl: null,
      source: null,
      destUri: `s3://${bucket}/${prefix}${i.key}`,
    })),
    ...manifest.local.map((i) => ({
      key: i.key,
      sourceUrl: null,
      source: null,
      destUri: `s3://${bucket}/${prefix}${i.key}`,
      origin: "local" as const,
    })),
  ];
}

/**
 * Remove the working directory, which holds the delta's unscrubbed originals in a local commit
 * (never pushed, never in the checkpoint), unless `keep`. Called wherever a run finds the pull
 * request open: when it opens it, and when a later run finds a record already at `pr_open` or past
 * it (a run that was killed between the transition and the removal leaves one behind).
 */
export function removeWorkdir(paths: WorkPaths, keep: boolean, out: (line: string) => void): void {
  if (keep) {
    out(`Working directory kept at ${paths.root}; it holds the delta's unscrubbed originals.`);
    return;
  }
  try {
    removeTree(paths.root);
  } catch (err) {
    out(
      `The working directory ${paths.root} could not be removed (${err instanceof ExecuteRefused ? err.code : describeError(err)}); remove it by hand: it holds the delta's unscrubbed originals.`,
    );
  }
}

/**
 * Run one step; on failure record why on the row and refuse with the step's code. Given hooks,
 * the step is checked by them first and timed, whether it held or not.
 */
async function step<T>(
  name: StepName,
  row: RepullRow,
  rec: Recorder,
  hooks: Pick<AdvanceContext, "beforeStep" | "timed"> | null,
  fn: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  try {
    hooks?.beforeStep?.(name);
    return await fn();
  } catch (err) {
    await rec.recordError(row, stepErrorWords(name, err).slice(0, 2000));
    throw inStep(asRefusal(name, err), name);
  } finally {
    hooks?.timed?.(name, Date.now() - started);
  }
}

/**
 * Walk a `prepared`, `copied` or `registered` row to `until` (at most `pr_open`). Returns the row as
 * the last step left it.
 */
export async function advancePrepared(
  ctx: AdvanceContext,
  start: RepullRow,
  until: RepullStatus,
  rec: Recorder,
): Promise<RepullRow> {
  let row = start;
  if (reached(row.status, until)) return row;
  const facts = planFacts(ctx.body);
  const push = { versions: [facts.toVersion] };
  const pushEnv = fleetCloneEnv(originUrl(ctx.datasetId, ctx.env), ctx.token);

  const setup = await step(
    row.status === "prepared" ? "copy" : row.status === "copied" ? "register" : "pr",
    row,
    rec,
    null,
    async () => {
      const work = await holdSynthesized(ctx, row);
      const remote = await nemarRemote(work, ctx.datasetId);
      const manifest = await rebuildManifest(work, ctx, row);
      const guard: AwsGuardContext = {
        destBucket: remote.bucket,
        prefix: remote.prefix,
        stagingKey: stagingManifestKey(ctx.datasetId, facts.toTag),
        sourceBucket: UPSTREAM_BUCKET,
        sourcePrefix: `${facts.ds}/`,
      };
      return { work, remote, manifest, guard, aws: runners(ctx, remote.region, guard) };
    },
  );
  const { work, remote, manifest, guard, aws } = setup;

  // S3: the copy.
  if (row.status === "prepared") {
    const result = await step("copy", row, rec, ctx, async () => {
      await assertUpstreamTag(work, ctx);
      if (manifest.items.some((i) => i.bucket !== UPSTREAM_BUCKET)) {
        throw new ExecuteRefused(
          "copy-source",
          "A copy item names another bucket than upstream's.",
        );
      }
      // Before the first copy: what an abandoned attempt's orphans are read from (decision 8).
      await writeStagingManifest({
        aws: aws.dest,
        bucket: remote.bucket,
        key: guard.stagingKey,
        manifest,
        dir: ctx.paths.root,
      });
      const existing = await listPrefixSizes(aws.dest, remote.bucket, remote.prefix);
      const copied = await copyPinned({
        aws,
        manifest,
        destBucket: remote.bucket,
        prefix: remote.prefix,
        existing,
        ...(ctx.copy ?? {}),
      });
      const after = await listPrefixSizes(aws.dest, remote.bucket, remote.prefix);
      const verified = verifyManifestObjects(
        manifestItems(manifest, remote.bucket, remote.prefix),
        after,
      );
      if (verified.message !== null) {
        throw new ExecuteRefused(
          "copy-unverified",
          `${verified.missing.length} of ${manifest.items.length + manifest.local.length} manifest object(s) are not at their declared size in NEMAR's bucket after the copy (${verified.missingUpstream} copied from upstream, ${verified.missingLocal} uploaded at prepare).`,
        );
      }
      return copied;
    });
    row = await rec.transition(row, "copied", {
      counts: { copied: result.copied, skipped: result.skipped, bytes: result.bytes },
    });
    ctx.out(
      `Copied re-pull #${row.id}: ${result.copied} object(s) copied by version, ${result.skipped} already present.`,
    );
    if (reached(row.status, until)) return row;
  }

  // S4: the registration, before anything a clone reads names the keys.
  if (row.status === "copied") {
    const reg = await step("register", row, rec, ctx, async () => {
      if (!ctx.token) {
        throw new ExecuteRefused(
          "no-github-token",
          "No GitHub token: the registration and the release branch are pushed with the administrator's own (GH_TOKEN, or gh auth login).",
        );
      }
      await assertUpstreamTag(work, ctx);
      const listing = await listPrefixSizes(aws.dest, remote.bucket, remote.prefix);
      return registerCopied({
        work,
        synthSha: row.synth_sha as string,
        body: ctx.body,
        manifest,
        nemarUuid: remote.uuid,
        listing,
        bucket: remote.bucket,
        datasetId: ctx.datasetId,
        push,
        env: pushEnv,
      });
    });
    row = await rec.transition(row, "registered", { counts: { registered: reg.treeKeys } });
    ctx.out(
      `Registered re-pull #${row.id}: ${reg.treeKeys} key(s) at nemar-s3 (${reg.registered} recorded now, ${reg.retired} replaced key(s) retired).`,
    );
    if (reached(row.status, until)) return row;
  }

  // S5: the release branch and its pull request.
  if (row.status === "registered") {
    const synthSha = row.synth_sha as string;
    const ref = releaseRefOf(facts.toVersion);
    const pr = await step("pr", row, rec, ctx, async () => {
      const token = ctx.token;
      if (!token) {
        throw new ExecuteRefused(
          "no-github-token",
          "No GitHub token: the pull request is opened with the administrator's own (GH_TOKEN, or gh auth login).",
        );
      }
      await assertUpstreamTag(work, ctx);
      await checkMain({ work, baseSha: row.base_sha, env: pushEnv });
      const branch = await pushRelease({
        work,
        synthSha,
        version: facts.toVersion,
        push,
        env: pushEnv,
      });
      ctx.out(
        branch.pushed
          ? `Pushed release/v${facts.toVersion}.`
          : `release/v${facts.toVersion} is already this re-pull's commit${branch.head === synthSha ? "" : " (moved by enrichment)"}.`,
      );
      return openRelease({
        token,
        base: ctx.apiBase,
        datasetId: ctx.datasetId,
        version: facts.toVersion,
        body: releaseBody({
          datasetId: ctx.datasetId,
          repullId: row.id,
          ds: facts.ds,
          fromTag: facts.fromTag,
          toTag: facts.toTag,
          toVersion: facts.toVersion,
          patchVersion: facts.patchVersion,
          digest: ctx.digest,
          doiCount: planCounts(ctx.body).doi_count ?? 1,
          counts: row.counts,
        }),
        acceptHead: (sha) => acceptsHead({ work, from: synthSha, head: sha, ref, env: pushEnv }),
      });
    });
    row = await rec.transition(row, "pr_open", {
      branch: `release/v${facts.toVersion}`,
      pr_number: pr.number,
      head_sha: pr.head,
    });
    ctx.out(
      `${pr.reused ? "Found" : "Opened"} pull request #${pr.number} of release/v${facts.toVersion}; re-pull #${row.id} is pr_open. Execute never merges.`,
    );
    // The working clone holds the delta's unscrubbed originals in a local commit: it goes now.
    removeWorkdir(ctx.paths, ctx.keepWorkdir, ctx.out);
  }
  return row;
}
