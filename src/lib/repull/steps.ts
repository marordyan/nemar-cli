/**
 * What the steps of a re-pull past its open pull request share (ADR 0111; epic #1046 phase 6):
 * `resume.ts` walks them, `release.ts` holds the release and the lock, `patch-turn.ts` makes N.0.1.
 * The words a step records on the row begin with its own prefix (`[gates:`, `[release:`, `[lock:`,
 * `[patch:`), never `[prepare:`, which only a preparation clears (the Phase 6c amendment's rule).
 */

import type { RepullRow } from "../../../shared/repull-state.js";
import { ApiError } from "../api/errors.js";
import { repullErrorCode, transitionRepull } from "../api/repull.js";
import type { OriginScratch } from "./execute/origin.js";
import { ExecuteRefused } from "./execute/verify-plan.js";
import type { Env } from "./sources.js";

/** How a resume ended, which the command turns into its exit code. */
export type ResumeOutcome =
  /** `gates_clear`: the pull request may be merged now (exit 0). */
  | "ready"
  /** It waits for something (the screen, GitHub, a person), with what in `waitingFor` (exit 3). */
  | "waiting"
  /** The record ended (`abandoned`: the pull request was closed unmerged) (exit 1). */
  | "ended"
  /**
   * The release was recorded and the objects locked, and the record stays at `released` because it
   * does not say how many corrections and conflicts its plan has, so it is not completed (exit 0;
   * unknown is never zero). A wait for an administrator's decision on the plan's conflicts is
   * `waiting`.
   */
  | "released"
  /** The re-pull is complete (exit 0). */
  | "complete"
  /** No open record (exit 1). */
  | "nothing";

export interface ResumeResult {
  row: RepullRow | null;
  outcome: ResumeOutcome;
  waitingFor?: string;
  /**
   * `ready` over a failed BIDS validation: on a record an administrator opened, GitHub reports the
   * pull request `unstable` because BIDS validation fails and nothing else does, read when the
   * gates are recorded and again by each later resume at the gates, so it merges with
   * `--bids-failure-reason` (or without it once the validation passes). `resume --json` carries it
   * as `bids_failure`.
   */
  bidsFailure?: true;
}

export interface ResumeOptions {
  datasetId: string;
  /** How long to wait for the screen and GitHub's state; 0 reads once. */
  waitMinutes: number;
  /** The administrator's reason for a screen verdict that asks for a person (ADR 0086). */
  acknowledgment?: string;
  /**
   * The reviewed plan file, which N.0.1 is made from; the plan's default path
   * (`$NEMAR_CONFIG_DIR/repull/<id>/<to>.<digest8>.json`) when absent.
   */
  plan?: string;
  /**
   * Conflicts resolved to NEMAR's side in N.0.1 (`--take-ours`): a path the plan lists as a
   * conflict, or `dataset_description.json#<Key>`.
   */
  takeOurs?: string[];
  /** Every conflict the plan lists stays on upstream's side (`--keep-upstream`). */
  keepUpstream?: boolean;
  /**
   * The administrator's reason for recording N.0.1's release although its tag's tree is not its
   * gated head outside `.nemar/` and `.github/` (`--accept-tag-tree`): the one way past
   * `patch-tree-mismatch`, after reading the difference. Unread trees are never accepted.
   */
  acceptTagTree?: string;
  /**
   * The administrator's reason for accepting a merge whose squash commit does not carry the
   * re-pull's trailers (`--accept-merge-trailers`): the one way past `merge-trailers`, and only once
   * the merge is shown to be this re-pull's own squash merge or plain merge commit (`acceptance.ts`;
   * ADR 0111, the amendments of 2026-10-29 and 2026-11-09). Recorded by the Worker, never written to the ledger.
   */
  acceptMergeTrailers?: string;
  /**
   * Asked before the release branch is re-synthesized onto a moved `main` and force-pushed with a
   * lease; false stops with nothing pushed (`declined`). Absent: it proceeds (the command passes
   * one unless `--yes`).
   */
  confirm?: (question: string) => Promise<boolean>;
  /** The test bases, the token and the API overrides; the process's by default. */
  env?: Env;
  out: (line: string) => void;
  /** Tests only: how long a wait sleeps between reads. */
  pollMs?: number;
  /**
   * A dispatched finish (ADR 0111, decision 6): it takes up only the automatic re-pull its
   * dispatch names, and only once that re-pull has merged (`merged` or `released`), so a finish
   * never screens, gates or re-synthesizes anything. Absent for an administrator's run.
   */
  automaticFinish?: { repullId: number };
}

/** What every step of one resume shares. */
export interface ResumeContext {
  datasetId: string;
  token: string;
  base: string;
  env: Env;
  configDir: string;
  opts: ResumeOptions;
  /** The scratch repository that reads origin, opened on first use. */
  origin(): Promise<OriginScratch>;
  /** Heads this run replaced by a re-synthesis: GitHub may still name one for a moment. */
  replaced: Set<string>;
  /**
   * Set once this run read a merge commit's trailers (`release.ts`), which is the only place
   * `--accept-merge-trailers` is used: a run that never got there says the flag changed nothing.
   */
  mergeTrailersRead?: boolean;
  sleep(ms: number): Promise<void>;
}

/** One turn of the walk: go on with the row, wait for something, or stop. */
export type Turn =
  | { kind: "next"; row: RepullRow }
  | { kind: "wait"; row: RepullRow; waitingFor: string }
  | { kind: "done"; result: ResumeResult };

/** `[<step>:<code>] <message>`, the words a step past the open pull request records. */
export function resumeErrorWords(
  step: "gates" | "release" | "lock" | "patch",
  err: unknown,
): string {
  if (err instanceof ExecuteRefused) return `[${step}:${err.code}] ${err.message}`.slice(0, 2000);
  const why = err instanceof Error ? err.name : "unknown";
  return `[${step}:${step}-failed] The step failed (${why}).`;
}

/**
 * A refusal that leaves the record as it was, resumable (the command's exit 3). Named so the
 * dispatch-word scan reads its words (`refused("<word>"`).
 */
export function refused(code: string, message: string): ExecuteRefused {
  const err = new ExecuteRefused(code, message);
  err.resumable = true;
  return err;
}

/** An API refusal as the step's own refusal, its word kept. */
export function apiRefused(err: unknown, what: string): ExecuteRefused {
  const code =
    repullErrorCode(err) ?? (err instanceof ApiError ? "record-refused" : "github-failed");
  const msg = err instanceof Error ? err.message : String(err);
  return refused(code, `${what}: ${msg}`);
}

/**
 * The facts a self-edge of an open pull request's status sends again: an edge into `pr_open` or
 * `patch_synthesized` names its pull request whole, so an edge that records only why a step failed
 * carries the row's own values (which the Worker reads as writing nothing but the error).
 */
export function openFacts(row: RepullRow): Record<string, unknown> {
  if (row.status === "pr_open") {
    return { branch: row.branch, pr_number: row.pr_number, head_sha: row.head_sha };
  }
  if (row.status === "patch_synthesized") {
    return {
      patch_version: row.patch_version,
      patch_branch: row.patch_branch,
      patch_pr_number: row.patch_pr_number,
      patch_head_sha: row.patch_head_sha,
      patch_base_sha: row.patch_base_sha,
    };
  }
  return {};
}

/**
 * Record why a step failed on a row at `pr_open`, `patch_synthesized`, `merged`, `patch_merged` or
 * `released`, as the self-edge that carries the stage's stored facts and nothing else; the
 * operator is told when it cannot be recorded. The failure itself is still what the caller reports.
 */
export async function recordStepError(
  row: RepullRow,
  words: string,
  out: (line: string) => void,
): Promise<void> {
  const fields = openFacts(row);
  try {
    await transitionRepull(row.id, { from: row.status, to: row.status, fields, error: words });
  } catch (err) {
    out(
      `The failure could not be recorded on re-pull #${row.id} (${repullErrorCode(err) ?? (err instanceof ApiError ? `HTTP ${err.statusCode}` : "no answer")}); its record keeps the last error it had.`,
    );
  }
}
