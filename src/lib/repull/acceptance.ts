/**
 * `nemar admin repull resume <id> --accept-merge-trailers "<reason>"`: the acceptance of a re-pull's
 * squash merge, or plain merge commit of its pull request, made without its trailers (epic #1046;
 * ADR 0111, the amendments of 2026-10-29 and 2026-11-09; issue #1996), as the release step takes it on from `merged` or `patch_merged` (`release.ts`).
 *
 * The merge gate writes the squash message so that its last paragraph is the re-pull commit's
 * trailers, which the privacy ledger's fresh-clone proof (ADR 0085) reads; a merge made with
 * GitHub's own button carries GitHub's message instead, and the release refuses it
 * (`merge-trailers`). Rewriting `main` is no repair, so an administrator may accept the merge, on
 * evidence and never on the reason alone. The release first waits for the tag and the version row,
 * as for any merge, so NEMAR's ledger line never lands on `main` before the tag. Then, before
 * anything is sent, this reads, with the administrator's own token and from NEMAR's origin, in this
 * order; the first that does not hold refuses with its word and nothing is written, not even the
 * step's error:
 *  - the record an administrator opened (`accept-automatic`: the automatic path's merges are the
 *    Worker's, sent with the trailers);
 *  - its pull request on GitHub: from the record's release branch into `main` of the dataset's own
 *    repository (`pr-foreign`), merged, with the record's merge commit (`merge-mismatch`);
 *  - the merge commit: one parent, or two with the merged head second (`merge-not-squash`,
 *    `merge-second-parent-foreign`; ADR 0111, the amendment of 2026-11-09, which takes GitHub's
 *    plain merge of the pull request as well as a squash); the first or only parent being the
 *    record's base or an enrichment-shaped descendant of it (`merge-parent-foreign`); the merged
 *    head, the recorded head or an enrichment-shaped descendant of it (`merge-head-foreign`);
 *  - its tree, the record's commit outside `.nemar/**` and `.github/**` (`merge-tree-mismatch`),
 *    the comparison the release makes for the tag (`tagTreeVersus`); N.0.1 needs its gated head
 *    (`tree-anchor-missing`);
 *  - what it did to the privacy ledger: nothing, or scrub lines appended (`merge-ledger-foreign`).
 * It prints what it verified, then the Worker reads all of it again with its own credential, checks
 * that the record is this administrator's, records the acceptance with the reason, and, when the
 * merge appended a `repull-scrubbed` line beside other files, appends the one ledger line that names
 * it to `main`. This reads that line back from origin before the release goes on
 * (`attestation-unseen` otherwise, which the next run takes up: the Worker reads `main` again and
 * writes the line once more when it is not there). A later run finds the acceptance recorded, says
 * so, and goes on with no flag.
 *
 * Exit codes, one rule for the first acceptance and for a later run: a refusal on the evidence, or
 * on what `main` holds, exits 1 (running again changes nothing); a GitHub, a NEMAR API or an origin
 * that could not be read, or a line not yet written or not yet seen, exits 3 (run resume again).
 */

import { NEMAR_DATASETS_ORG, isOwnDatasetRepo } from "../../../shared/nemar-app.js";
import {
  LEDGER_REPO_PATH,
  type LedgerWord,
  type MergeShape,
  acceptedMergesOf,
  classifyMergeParents,
  ledgerChange,
  ledgerLines,
  ledgerWordOf,
} from "../../../shared/repull-merge-acceptance.js";
import {
  PULL_REQUEST_COLUMNS,
  type RepullPullRequest,
  type RepullRow,
} from "../../../shared/repull-state.js";
import { ApiError } from "../api/errors.js";
import {
  type RepullAcceptanceEvidence,
  type RepullMergeAcceptance,
  acceptRepullMergeTrailers,
  repullErrorCode,
} from "../api/repull.js";
import { fetchPullRequest } from "../pr-review-approve.js";
import { MOVED_REF_FETCH_DEPTH, enrichmentOnlySince } from "./execute/head.js";
import { type OriginScratch, fetchInto } from "./execute/origin.js";
import { releaseRefOf } from "./execute/pull-request.js";
import { ExecuteRefused } from "./execute/verify-plan.js";
import { git } from "./execute/workdir.js";
import { tagTreeVersus } from "./release.js";
import { type ResumeContext, refused } from "./steps.js";

/** A refusal on the evidence: nothing was written, and running again will not change it (exit 1). */
function denied(code: string, message: string): ExecuteRefused {
  return new ExecuteRefused(code, `${message} Nothing was accepted or written.`);
}

/**
 * The Worker's words that a later run may clear: GitHub or the API could not be read, or the line
 * could not be written yet. Any other word is the Worker's refusal on the evidence or on what
 * `main` holds, which running again does not change.
 */
const TRANSIENT_WORDS = new Set(["github-unreadable", "attestation-unwritten"]);

/**
 * HTTP statuses of an answer that carries no word of the Worker's and that a later run may see
 * differently: 0, the API client's status for a connection or an answer lost on the way (`client.ts`),
 * a timeout and a rate limit. Any 5xx is such an answer too.
 */
const TRANSIENT_STATUSES = new Set([0, 408, 429]);

/**
 * The Worker's answer to an acceptance request as this step's refusal, one rule for every path:
 * its word kept, its message kept whole after `prefix`, resumable (exit 3) when a later run may
 * clear it: a transient word, or no word and an API that could not be read.
 */
export function acceptanceRefusal(err: unknown, prefix: string): ExecuteRefused {
  const code = repullErrorCode(err);
  // A 404 or 405 with none of the Worker's words is a Worker that has no acceptance route at all
  // (one older than this release), not a record it could not find; running again changes nothing.
  if (code === undefined && err instanceof ApiError && [404, 405].includes(err.statusCode)) {
    const failure = new ExecuteRefused(
      "accept-route-missing",
      `${prefix}: this Worker has no acceptance route (it is older than the CLI), so nothing was sent that acts.`,
    );
    failure.resumable = false;
    return failure;
  }
  const msg = err instanceof Error ? err.message : String(err);
  const transient =
    code === undefined
      ? !(err instanceof ApiError) ||
        TRANSIENT_STATUSES.has(err.statusCode) ||
        err.statusCode >= 500
      : TRANSIENT_WORDS.has(code);
  const failure = new ExecuteRefused(
    code ?? (err instanceof ApiError ? "record-refused" : "api-unreadable"),
    `${prefix}: ${msg}`,
  );
  failure.resumable = transient;
  return failure;
}

const short = (sha: string) => sha.slice(0, 12);

/** The ledger's text at `rev` in the scratch repository, or null when it has none there. */
async function ledgerAt(scratch: OriginScratch, rev: string): Promise<string | null> {
  const r = await git(scratch.dir, ["cat-file", "blob", `${rev}:${LEDGER_REPO_PATH}`], {
    ok: true,
  });
  return r.exitCode === 0 ? r.stdout : null;
}

/** The commit's parents, or null when it cannot be read. */
async function parentsOf(scratch: OriginScratch, sha: string): Promise<string[] | null> {
  const r = await git(scratch.dir, ["rev-list", "--parents", "-n", "1", sha], { ok: true });
  if (r.exitCode !== 0) return null;
  return r.stdout.trim().split(" ").slice(1);
}

/** `to` fetched deep enough for `enrichmentOnlySince` to read the commits beneath it. */
async function fetchSpan(scratch: OriginScratch, to: string, refs: string[]): Promise<boolean> {
  for (const what of [to, ...refs]) {
    if (await fetchInto(scratch, what, MOVED_REF_FETCH_DEPTH + 1)) {
      const has = await git(scratch.dir, ["cat-file", "-e", `${to}^{commit}`], { ok: true });
      if (has.exitCode === 0) return true;
    }
  }
  return false;
}

/** What this run verified, said before the Worker is asked. */
interface Verified {
  shape: MergeShape;
  number: number;
  branch: string;
  mergedHead: string;
  headMoved: boolean;
  parent: string;
  parentMoved: boolean;
  anchor: string;
  ledger: RepullAcceptanceEvidence["ledger"];
}

/** The evidence, read here before anything is sent (see the module comment). */
async function verifyLocally(
  ctx: ResumeContext,
  scratch: OriginScratch,
  row: RepullRow,
  pr: RepullPullRequest,
): Promise<Verified> {
  const c = PULL_REQUEST_COLUMNS[pr];
  const merge = row[c.mergeSha] as string;
  const number = row[c.number] as number;
  const branch = row[c.branch] as string;
  if (row.origin !== "administrator") {
    throw denied(
      "accept-automatic",
      `Re-pull #${row.id} was opened by the automatic path, whose merges the Worker sends with the trailers; its merge is not accepted without them.`,
    );
  }
  const live = await fetchPullRequest(ctx.token, ctx.datasetId, number, ctx.base);
  if (!live.ok) {
    throw refused(
      "github-unreadable",
      `Pull request #${number} could not be read on GitHub (${live.reason}); nothing was accepted.`,
    );
  }
  const p = live.value;
  if (
    p.baseRef !== "main" ||
    p.headRef !== branch ||
    !isOwnDatasetRepo(p.headRepo, row.dataset_id) ||
    !isOwnDatasetRepo(p.baseRepo, row.dataset_id)
  ) {
    throw denied(
      "pr-foreign",
      `Pull request #${number} is not ${branch} into main of ${NEMAR_DATASETS_ORG}/${row.dataset_id} itself.`,
    );
  }
  if (p.state !== "merged" || p.mergeCommitSha !== merge) {
    throw denied(
      "merge-mismatch",
      p.state === "merged"
        ? `GitHub says pull request #${number} merged as ${p.mergeCommitSha ? short(p.mergeCommitSha) : "no commit it names"}, not the recorded ${short(merge)}.`
        : `GitHub says pull request #${number} is not merged.`,
    );
  }

  // The merge commit and enough of what is beneath it, from origin.
  if (!(await fetchSpan(scratch, merge, ["refs/heads/main"]))) {
    throw refused(
      "merge-unreadable",
      `The merge commit ${short(merge)} could not be fetched from NEMAR's repository; nothing was accepted.`,
    );
  }
  const parents = await parentsOf(scratch, merge);
  if (parents === null) {
    throw refused("merge-unreadable", `The merge commit ${short(merge)} could not be read.`);
  }
  // One parent (a squash) or two with the merged head second (GitHub's plain merge), and no other.
  const shaped = classifyMergeParents(parents, p.headSha, short(merge));
  if (!shaped.ok) throw denied(shaped.code, shaped.message);
  const parent = shaped.first;
  const base = (pr === "n0" ? row.base_sha : row.patch_base_sha) as string;
  if (parent !== base) {
    const verdict = await enrichmentOnlySince(scratch.dir, base, parent);
    if (!verdict.ok) {
      if (verdict.code === "unreadable") {
        throw refused(
          "main-unreadable",
          `Whether the merge commit's parent ${short(parent)} moved from the record's base ${short(base)} by enrichment only could not be read; nothing was accepted.`,
        );
      }
      throw denied(
        "merge-parent-foreign",
        `The merge commit's parent ${short(parent)} is not the record's base ${short(base)} or a commit enrichment moved it to.`,
      );
    }
  }

  // The head it merged: the recorded one, or an enrichment-shaped descendant of it.
  const recordedHead = row[c.head] as string;
  if (p.headSha !== recordedHead) {
    const fetched = await fetchSpan(scratch, p.headSha, [
      releaseRefOf(row[c.version] as string),
      `refs/pull/${number}/head`,
    ]);
    const verdict = fetched
      ? await enrichmentOnlySince(scratch.dir, recordedHead, p.headSha)
      : ({ ok: false, code: "unreadable" } as const);
    if (!verdict.ok) {
      if (verdict.code === "unreadable") {
        throw refused(
          "branch-unreadable",
          `Whether the merged head ${short(p.headSha)} is the recorded head ${short(recordedHead)} moved by enrichment could not be read; nothing was accepted.`,
        );
      }
      throw denied(
        "merge-head-foreign",
        `Pull request #${number} merged at ${short(p.headSha)}, which is not the recorded head ${short(recordedHead)} or a commit enrichment moved it to.`,
      );
    }
  }

  // The tree, outside NEMAR's own paths: the release's comparison, made on the merge commit.
  const anchor = (pr === "n0" ? row.synth_sha : row.patch_gates_sha) as string | null;
  if (anchor === null) {
    throw denied(
      "tree-anchor-missing",
      `Re-pull #${row.id} records no gated head of its N.0.1 pull request, so the merged tree has nothing to be compared with.`,
    );
  }
  const tree = await tagTreeVersus(scratch, row, merge, pr);
  if (tree !== "same") {
    if (tree === "differs") {
      throw denied(
        "merge-tree-mismatch",
        `The merge commit's tree is not the re-pull's ${pr === "n0" ? "commit" : "gated N.0.1 head"} ${short(anchor)} outside .nemar/ and .github/.`,
      );
    }
    throw refused(
      "origin-unreadable",
      "The merge commit or the re-pull's commit could not be read from NEMAR's repository, so the trees were not compared; nothing was accepted.",
    );
  }

  // The privacy ledger: what the merge did to it, as the fresh-clone proof will read it.
  const change = ledgerChange(await ledgerAt(scratch, parent), await ledgerAt(scratch, merge));
  if (change.kind === "other") {
    throw denied(
      "merge-ledger-foreign",
      "The merge commit changes the privacy ledger other than by appending a scrub's lines, which the fresh-clone proof refuses whatever is accepted.",
    );
  }
  return {
    shape: shaped.shape,
    number,
    branch,
    mergedHead: p.headSha,
    headMoved: p.headSha !== recordedHead,
    parent,
    parentMoved: parent !== base,
    anchor,
    ledger: ledgerWordOf(change),
  };
}

/** The lines that say what this run verified, before the Worker is asked. */
function verifiedLines(row: RepullRow, pr: RepullPullRequest, v: Verified): string[] {
  const c = PULL_REQUEST_COLUMNS[pr];
  const recordedHead = row[c.head] as string;
  const base = (pr === "n0" ? row.base_sha : row.patch_base_sha) as string;
  return [
    "Verified by this run, with your GitHub token and NEMAR's repository:",
    `  - it is ${v.shape === "squash" ? "GitHub's squash merge" : "a plain merge commit"} of pull request #${v.number} (${v.branch} into main of ${NEMAR_DATASETS_ORG}/${row.dataset_id}), merged at ${short(v.mergedHead)}, ${v.headMoved ? `which enrichment moved the recorded head ${short(recordedHead)} to` : "the recorded head"};`,
    `  - its ${v.shape === "squash" ? "one parent" : `first parent (its second is the merged head ${short(v.mergedHead)})`} ${short(v.parent)} is ${v.parentMoved ? `the record's base ${short(base)} moved by enrichment only` : "the record's base"};`,
    `  - its tree is the re-pull's ${pr === "n0" ? "commit" : "gated N.0.1 head"} ${short(v.anchor)} outside .nemar/ and .github/;`,
    `  - it ${ledgerPhrase(v.ledger)};`,
    "  - the re-pull is one an administrator opened.",
    "Asking the Worker to read it again on GitHub and to record your acceptance.",
  ];
}

/** What a merge did to the privacy ledger, in the words this run and the Worker's line both use. */
function ledgerPhrase(word: LedgerWord): string {
  return word === "untouched"
    ? "does not touch the privacy ledger"
    : word === "scrub-lines"
      ? "appends only a scrub's lines to the privacy ledger"
      : "appends the delta scrub's repull-scrubbed line to the privacy ledger and edits no line before it";
}

/** What the Worker read on GitHub, every field of its evidence, in one line. */
function workerLine(e: RepullAcceptanceEvidence): string {
  return `The Worker read on GitHub with its own credential: pull request #${e.pull_request} merged at ${short(e.merged_head)}${e.head_moved_by_enrichment ? " (moved by enrichment)" : ""}, parent ${short(e.parent)}${e.parent_moved_by_enrichment ? " (moved by enrichment)" : ""}, tree ${short(e.tree)}, the re-pull's outside .nemar/ and .github/; the merge ${ledgerPhrase(e.ledger)}; and the re-pull is yours.`;
}

/** The acceptance's ledger line, read back from `main` on NEMAR's origin. */
async function assertLineOnMain(
  scratch: OriginScratch,
  merge: string,
  line: string,
): Promise<void> {
  if (!(await fetchInto(scratch, "refs/heads/main", 1))) {
    throw refused(
      "origin-unreadable",
      "NEMAR's main could not be fetched to read the acceptance's ledger line back; run resume again.",
    );
  }
  const text = await ledgerAt(scratch, "refs/remotes/origin/heads/main");
  if (
    text === null ||
    !acceptedMergesOf(text).includes(merge) ||
    !ledgerLines(text).includes(line)
  ) {
    throw refused(
      "attestation-unseen",
      `The Worker answered that the ledger line naming ${short(merge)} is on main, and NEMAR's repository does not show it; run resume again, which reads main again and writes the line once more if it is not there.`,
    );
  }
}

/** What the acceptance's ledger line came to, in one sentence. */
function lineSentence(merge: string, a: RepullMergeAcceptance, line: string | null): string {
  return line === null
    ? `The merge appends no repull-scrubbed line beside other files, so the privacy ledger's fresh-clone proof needs no line for it, and none was written.`
    : `The line that names ${short(merge)} is on main in ${LEDGER_REPO_PATH}${a.attestation_sha ? ` (commit ${short(a.attestation_sha)})` : ""}, so the privacy ledger's fresh-clone proof reads the merge as the re-pull's own.`;
}

/**
 * An acceptance recorded by an earlier run, replayed by the Worker (which reads `main` and writes
 * the line once more when it is not there), its line read back; true when there is one. False when
 * none is recorded.
 */
export async function recordedAcceptance(
  ctx: ResumeContext,
  scratch: OriginScratch,
  row: RepullRow,
  pr: RepullPullRequest,
  problem: string,
): Promise<boolean> {
  const merge = row[PULL_REQUEST_COLUMNS[pr].mergeSha] as string;
  let replay: Awaited<ReturnType<typeof acceptRepullMergeTrailers>>;
  try {
    replay = await acceptRepullMergeTrailers(row.id, { pr, merge_sha: merge });
  } catch (err) {
    if (repullErrorCode(err) === "merge-trailers-not-accepted") return false;
    // Whether an acceptance is recorded is the Worker's to say: its own words say so when one is
    // (they begin "The acceptance is recorded"), and an answer that was lost says nothing.
    throw acceptanceRefusal(
      err,
      `The merge commit ${short(merge)} carries no trailers (${problem}); asked for an acceptance recorded earlier, the Worker answered`,
    );
  }
  const a = replay.acceptance;
  if (replay.attestation_line !== null) {
    await assertLineOnMain(scratch, merge, replay.attestation_line);
  }
  ctx.opts.out(
    `The merge commit ${short(merge)} on main carries no trailers (${problem}); it was accepted earlier, by administrator #${a.accepted_by} at ${a.accepted_at}, on the reason: ${a.reason}`,
  );
  ctx.opts.out(lineSentence(merge, a, replay.attestation_line));
  if (ctx.opts.acceptMergeTrailers) {
    ctx.opts.out("It is accepted once; --accept-merge-trailers changes nothing now.");
  }
  return true;
}

/**
 * Accept the merge now, on the administrator's reason: this run's reading, said, then the Worker's,
 * then the line read back from `main`.
 */
export async function acceptMergeNow(
  ctx: ResumeContext,
  scratch: OriginScratch,
  row: RepullRow,
  pr: RepullPullRequest,
  problem: string,
  reason: string,
): Promise<void> {
  const merge = row[PULL_REQUEST_COLUMNS[pr].mergeSha] as string;
  const out = ctx.opts.out;
  out(
    `The merge commit ${short(merge)} on main does not end with the re-pull commit's two trailers (${problem}).`,
  );
  const verified = await verifyLocally(ctx, scratch, row, pr);
  for (const line of verifiedLines(row, pr, verified)) out(line);
  let answer: Awaited<ReturnType<typeof acceptRepullMergeTrailers>>;
  try {
    answer = await acceptRepullMergeTrailers(row.id, { pr, merge_sha: merge, reason });
  } catch (err) {
    throw acceptanceRefusal(err, "The Worker answered");
  }
  if (answer.evidence) out(workerLine(answer.evidence));
  out(`Accepted on your reason, and recorded on re-pull #${row.id}: ${answer.acceptance.reason}`);
  if (answer.attestation_line !== null) {
    await assertLineOnMain(scratch, merge, answer.attestation_line);
  }
  out(lineSentence(merge, answer.acceptance, answer.attestation_line));
}
