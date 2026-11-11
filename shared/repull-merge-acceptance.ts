/**
 * A re-pull's squash merge, or plain merge commit of its pull request, made without its trailers,
 * accepted on evidence (ADR 0111, the amendments of 2026-10-29 and 2026-11-09). Pure, and the one definition of each rule below:
 *  - the ledger's words and fixed values a re-pull writes (`LEDGER_REPO_PATH`,
 *    `SCRUB_LEDGER_ACTIONS`, `MERGE_ACCEPTED_ACTION`, `MERGE_ACCEPTED_VERIFICATION`,
 *    `REPULL_LEDGER_ACTOR`), which the ledger's validator (`scripts/scrub/ledger.ts`), the delta
 *    scrub, the Worker and the CLI import;
 *  - the acceptance line (`mergeAcceptanceLine`), built by the Worker and validated by the ledger;
 *  - what a commit did to the ledger (`ledgerChange`) and which commits a ledger's acceptance lines
 *    name (`acceptedMergesOf`), read by the fresh-clone proof (`scripts/scrub/git/git-lib.ts`), the
 *    Worker and the CLI;
 *  - enrichment's bound of commits (`ENRICHMENT_MAX_COMMITS`), read by the CLI's shape check
 *    (`src/lib/repull/execute/head.ts`) and the Worker.
 * Two readings stay apart on purpose, because they read different things: the Worker compares two
 * root trees from GitHub's answers (`sameOutsideNemar`) and reads "moved by enrichment only" from
 * GitHub's comparison, which names paths (`isEnrichmentPath`), while the CLI reads git objects in a
 * clone, compares every entry (`outsideNemar` in `release.ts`) and reads each enrichment commit's
 * content (`isEnrichment` in `execute/head.ts`). Both must agree for `resume` to go on.
 *
 * The merge gate writes the squash message so that its last paragraph is the re-pull commit's
 * trailers, because the privacy ledger's fresh-clone proof (ADR 0085) reads a commit that appends
 * a `repull-scrubbed` line beside other files as the re-pull's own only when it carries them. A
 * merge made outside the gate (GitHub's merge button) carries GitHub's message instead, and the
 * proof would fail the dataset for good. Rewriting `main` is not a repair: the tag, a minted DOI
 * and public clones name the commit.
 *
 * So the acceptance is evidence in the repository itself: one ledger line, written by NEMAR in a
 * commit of its own on `main` after the merge, that names the accepted merge commit by its full
 * id. The proof accepts a commit that appends a `repull-scrubbed` line without the trailers only
 * when a branch tip whose first-parent history holds it carries such a line naming exactly it; a
 * line that names anything but a re-pull's merge in such a history fails the proof on its own.
 * The line holds fixed words and two hex ids, never the administrator's reason, which is free text
 * and stays in NEMAR's database: the ledger refuses free text by design (ADR 0085, ADR 0036).
 */

import { DIGEST_RE, SHA_RE } from "./repull-state.js";

/** The ledger's path in a dataset repository (ADR 0085). */
export const LEDGER_REPO_PATH = ".nemar/corrections.jsonl";

/**
 * The shape of a merge commit the acceptance takes (ADR 0111, the amendment of 2026-11-09):
 *  - `squash`: one parent, the base `main` was at, which is what the merge gate writes;
 *  - `merge-commit`: two parents, the base and the merged pull request's head, which is what
 *    GitHub's plain merge button writes.
 * Anything else is refused, and the one rule is here so that the CLI and the Worker cannot differ.
 */
export type MergeShape = "squash" | "merge-commit";

export type MergeParents =
  | { ok: true; shape: MergeShape; first: string }
  | {
      ok: false;
      /** `merge-not-squash`: no parent, or three or more; `merge-second-parent-foreign`: two, the second not the merged head. */
      code: "merge-not-squash" | "merge-second-parent-foreign";
      message: string;
    };

/**
 * Read a merge commit's parents against the head GitHub says the pull request merged at. The first
 * parent is what the caller then compares with the record's base; this decides only the shape, and
 * for two parents that the second is the merged head, so a merge that brought in anything else (a
 * branch of another history, a commit no gate screened) is not the re-pull's own.
 */
export function classifyMergeParents(
  parents: readonly string[],
  mergedHead: string,
  mergeShort: string,
): MergeParents {
  if (parents.length === 1) return { ok: true, shape: "squash", first: parents[0] as string };
  if (parents.length === 2) {
    if (parents[1] === mergedHead) {
      return { ok: true, shape: "merge-commit", first: parents[0] as string };
    }
    return {
      ok: false,
      code: "merge-second-parent-foreign",
      message: `The merge commit ${mergeShort} has two parents, and its second, ${(parents[1] as string).slice(0, 12)}, is not the head ${mergedHead.slice(0, 12)} the pull request merged at; only GitHub's plain merge of the pull request itself is accepted.`,
    };
  }
  return {
    ok: false,
    code: "merge-not-squash",
    message: `The merge commit ${mergeShort} has ${parents.length} parents; a squash merge has one and GitHub's merge of a pull request has two.`,
  };
}

/** The ledger word of an accepted merge: written by NEMAR's Worker only, never typed. */
export const MERGE_ACCEPTED_ACTION = "repull-merge-accepted";

/**
 * The verification word an acceptance line carries, and no other line may: the Worker read the
 * merge, its pull request, its tree and its parent on GitHub before it wrote the line. The word is
 * kept for a plain GitHub merge commit as well (the amendment of 2026-11-09, {@link MergeShape}),
 * because a ledger validator already deployed accepts this word and no other, and the line names
 * the merge commit by its full id, so which shape it has is read from the commit, not from the word.
 */
export const MERGE_ACCEPTED_VERIFICATION = "squash-merge-verified";

/** The fixed actor of every line a re-pull writes: the delta scrub's, and the acceptance's. */
export const REPULL_LEDGER_ACTOR = "nemar-repull";

/** The two words a scrub writes in the same commit as what it scrubbed (ADR 0089, ADR 0111). */
export const SCRUB_LEDGER_ACTIONS = ["import-scrubbed", "repull-scrubbed"] as const;

/** More commits than enrichment ever makes between two of NEMAR's own writes is not enrichment. */
export const ENRICHMENT_MAX_COMMITS = 20;

/** A scanner revision as a ledger line names it (`scripts/scrub/ledger.ts`). */
export const SCANNER_RE = /^identifier-scan@[0-9a-f]{7,40}$/;

const VERSION_RE = /^\d+\.\d+\.\d+$/;

/** What an acceptance line says. */
export interface MergeAcceptanceFacts {
  dataset: string;
  /** The version the merge released, bare (`2.0.0`); the line names it as a tag. */
  version: string;
  /** The accepted merge commit (a squash or a plain merge), in full. */
  mergeSha: string;
  /** The record's plan digest (`sha256:<64 hex>`): which reviewed plan the merge carried. */
  planDigest: string;
  /** The `scanner` of the `repull-scrubbed` line the merge appended, carried over unchanged. */
  scanner: string;
  /** When the acceptance was recorded, as an ISO 8601 time. */
  at: string;
}

/**
 * The acceptance line, without its newline, its keys in the ledger's order. A function of the
 * stored acceptance, so writing it again gives the same bytes, which is how a retried write finds
 * the line it already wrote. Throws on a value that is not of its shape.
 */
export function mergeAcceptanceLine(f: MergeAcceptanceFacts): string {
  if (!SHA_RE.test(f.mergeSha)) throw new Error("the merge commit is not a full commit id");
  if (!DIGEST_RE.test(f.planDigest)) throw new Error("the plan digest is not sha256: and 64 hex");
  if (!SCANNER_RE.test(f.scanner)) throw new Error("the scanner is not identifier-scan@<hex>");
  if (!VERSION_RE.test(f.version)) throw new Error("the version is not N.N.N");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(f.at)) {
    throw new Error("the time is not an ISO 8601 UTC time");
  }
  return JSON.stringify({
    version: 1,
    at: f.at,
    dataset: f.dataset,
    action: MERGE_ACCEPTED_ACTION,
    versions: [`v${f.version}`],
    counts: {},
    scanner: f.scanner,
    verification: MERGE_ACCEPTED_VERIFICATION,
    actor: REPULL_LEDGER_ACTOR,
    commit: f.mergeSha,
    plan: f.planDigest,
  });
}

/** D1's `datetime('now')` (`YYYY-MM-DD HH:MM:SS`, UTC) as the ISO time a ledger line carries. */
export function ledgerTimeOf(d1Time: string): string {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(d1Time);
  if (!m) throw new Error("not a D1 time");
  return `${m[1]}T${m[2]}.000Z`;
}

/** The non-blank lines of a ledger's text, as the proof splits them. */
export function ledgerLines(text: string): string[] {
  return text.split("\n").filter((l) => l.trim() !== "");
}

function parsed(line: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(line) as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * What a commit did to the ledger, from its parent's text and its own (null for no ledger):
 *  - `none`: the same lines;
 *  - `scrub-append`: lines appended after the parent's, every one a scrub's word, nothing before
 *    them edited, with whether one is `repull-scrubbed` and that line's `scanner`;
 *  - `other`: anything else (a removal, an edit, a line of another word or one that does not parse).
 * The proof's own rule for a scrub's commit (`scrubLedgerCommitKind` in `git-lib.ts`), read from two
 * texts.
 */
export type LedgerChange =
  | { kind: "none" }
  | { kind: "scrub-append"; repull: boolean; scanner: string | null }
  | { kind: "other" };

export function ledgerChange(before: string | null, after: string | null): LedgerChange {
  const was = ledgerLines(before ?? "");
  const now = ledgerLines(after ?? "");
  if (after === null && before === null) return { kind: "none" };
  if (after === null) return { kind: "other" };
  if (now.length === was.length && was.every((l, i) => l === now[i])) return { kind: "none" };
  if (now.length <= was.length || was.some((l, i) => l !== now[i])) return { kind: "other" };
  let repull = false;
  let scanner: string | null = null;
  const words: readonly string[] = SCRUB_LEDGER_ACTIONS;
  for (const line of now.slice(was.length)) {
    const entry = parsed(line);
    const action = entry?.action;
    if (typeof action !== "string" || !words.includes(action)) return { kind: "other" };
    if (action === "repull-scrubbed") {
      repull = true;
      scanner = typeof entry?.scanner === "string" ? entry.scanner : null;
    }
  }
  return { kind: "scrub-append", repull, scanner };
}

/** What a merge did to the ledger, in the words the acceptance's evidence and output use. */
export type LedgerWord = "untouched" | "scrub-lines" | "repull-scrub-lines";

/** The one mapping of a {@link LedgerChange} that is not `other` to its word. */
export function ledgerWordOf(change: Exclude<LedgerChange, { kind: "other" }>): LedgerWord {
  if (change.kind === "none") return "untouched";
  return change.repull ? "repull-scrub-lines" : "scrub-lines";
}

/**
 * The commits the acceptance lines of a ledger's text name, in order, each once. A line that does
 * not parse names nothing here; the ledger's own validation (`ledger-invalid`) refuses it.
 */
export function acceptedMergesOf(text: string): string[] {
  const out: string[] = [];
  for (const line of ledgerLines(text)) {
    const entry = parsed(line);
    if (entry?.action !== MERGE_ACCEPTED_ACTION) continue;
    if (typeof entry.commit === "string" && !out.includes(entry.commit)) out.push(entry.commit);
  }
  return out;
}

/** One entry of a git tree, as GitHub's trees API and `git ls-tree` name it. */
export interface TreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
}

/** The top-level directories NEMAR owns, which a re-pull's tree comparisons leave out. */
const NEMAR_OWNED = new Set([".nemar", ".github"]);

const entryKey = (e: TreeEntry) => `${e.mode} ${e.type} ${e.sha} ${e.path}`;

/** A tree's entries but those `skip` says to leave out, as sorted keys. */
function keysOf(t: readonly TreeEntry[], skip: (e: TreeEntry) => boolean): string[] {
  return t
    .filter((e) => !skip(e))
    .map(entryKey)
    .sort();
}

function sameKeys(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((k, i) => k === b[i]);
}

/**
 * Whether two root trees are the same outside `.nemar/**` and `.github/**`: every top-level entry
 * but those two directories has the same name, mode, type and object. Equal subtree objects are
 * equal contents, so the top level decides the whole tree, the comparison the release makes for
 * the tag (`release.ts`), read from two GitHub tree answers instead of a clone.
 */
export function sameOutsideNemar(a: readonly TreeEntry[], b: readonly TreeEntry[]): boolean {
  const skip = (e: TreeEntry) => e.type === "tree" && NEMAR_OWNED.has(e.path);
  return sameKeys(keysOf(a, skip), keysOf(b, skip));
}

/** The `.nemar` directory's object in a root tree, or null when the tree has none. */
export function nemarTreeOf(root: readonly TreeEntry[]): string | null {
  return root.find((e) => e.path === ".nemar" && e.type === "tree")?.sha ?? null;
}

/**
 * Whether a commit changed any path but the ledger, from its parent's root tree and its own, and
 * each one's `.nemar` entries (null for a root with no `.nemar` directory, which has none). The
 * caller reads the two `.nemar` trees only when the roots differ in `.nemar` alone.
 */
export function changesBesideLedger(
  parentRoot: readonly TreeEntry[],
  mergeRoot: readonly TreeEntry[],
  parentNemar: readonly TreeEntry[] | null,
  mergeNemar: readonly TreeEntry[] | null,
): boolean {
  const notNemar = (e: TreeEntry) => e.path === ".nemar" && e.type === "tree";
  if (!sameKeys(keysOf(parentRoot, notNemar), keysOf(mergeRoot, notNemar))) return true;
  const ledger = LEDGER_REPO_PATH.slice(".nemar/".length);
  const notLedger = (e: TreeEntry) => e.path === ledger;
  return !sameKeys(keysOf(parentNemar ?? [], notLedger), keysOf(mergeNemar ?? [], notLedger));
}

/**
 * A path enrichment writes, by its name: a file under `.nemar/` other than the ledger, `.bidsignore`
 * and a root `participants.tsv`. The Worker's reading of "moved by enrichment only", from GitHub's
 * comparison, which names paths; the CLI reads each commit's content too (`execute/head.ts`).
 */
export function isEnrichmentPath(path: string): boolean {
  if (path === LEDGER_REPO_PATH) return false;
  return path.startsWith(".nemar/") || path === ".bidsignore" || path === "participants.tsv";
}
