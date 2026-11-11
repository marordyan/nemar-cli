/**
 * An administrator's acceptance of a re-pull's merge made without its trailers, a squash or a plain
 * merge commit of its pull request (epic #1046; ADR 0111, the amendments of 2026-10-29 and
 * 2026-11-09; issue #1996), and the one ledger line NEMAR writes for it.
 *
 *   POST /admin/repulls/:id/merge-trailers/accept   { pr, merge_sha, reason? }
 *
 * NEMAR's merge gate writes a re-pull's squash message so that its last paragraph is the re-pull
 * commit's trailers; the privacy ledger's fresh-clone proof (ADR 0085) reads the merge as the
 * re-pull's own commit only then. A merge made outside the gate (GitHub's merge button) has none,
 * `resume` refuses its release (`merge-trailers`), and rewriting `main` is no repair: the tag, a
 * minted DOI and public clones name the commit. So an administrator may accept the merge, and the
 * acceptance is earned by what the Worker reads on GitHub with its own credential, never by the
 * reason or by the caller's word. In this order, the first that does not hold refuses with its
 * word and writes nothing:
 *  1. The record at `merged` (`n0`) or `patch_merged` (`n1`) (`bad-transition`), its merge commit
 *     the one named (`merge-mismatch`); a record an administrator opened (`accept-automatic`: the
 *     automatic path's merges are the Worker's, written with the trailers), and opened by this
 *     administrator (`accept-not-yours`).
 *  2. The recorded pull request, read on GitHub: the record's number, its release branch into
 *     `main` of the dataset's own repository (`readRecordedPullRequest`, `pull-request-mismatch`),
 *     merged, with GitHub's merge commit the record's (`merge-mismatch`), at the recorded head or
 *     one GitHub's comparison shows moved from it only on paths enrichment writes
 *     (`merge-head-foreign`).
 *  3. The merge commit, read on GitHub: one parent, or two with the merged head second
 *     (`merge-not-squash`, `merge-second-parent-foreign`; ADR 0111, the amendment of 2026-11-09,
 *     which takes GitHub's plain merge of the pull request as well as a squash), the first or only
 *     parent being the record's base or a descendant of it moved only on paths enrichment writes
 *     (`merge-parent-foreign`).
 *  4. Its tree, the same as the record's commit outside `.nemar/**` and `.github/**`: N.0.0's
 *     synthesized tree, N.0.1's gated head (`merge-tree-mismatch`; `tree-anchor-missing` for an
 *     N.0.1 merged before its gates were recorded, which the release cannot compare either), the
 *     comparison the release makes for the tag, read from the two root trees.
 *  5. What it did to the privacy ledger: nothing, or appended scrub lines and edited none before
 *     them; and, when the proof needs the line, a `repull-scrubbed` line whose `scanner` a ledger
 *     line can carry (`merge-ledger-foreign` otherwise).
 *  6. `main` still holds the merge (`merge-not-on-main`); and, when the line is needed, a ledger
 *     on `main` (`ledger-missing-on-main`) that names the merge in no line yet, since NEMAR writes
 *     only after it records (`attestation-conflict`).
 * Then the acceptance is recorded with its reason (one row, `upstream_repull_merge_acceptances`,
 * and an audit row, `repull_merge_trailers_accepted`), once: a second request for the same merge
 * replays it and writes no second row, its reason not needed; for another merge it is refused.
 *
 * THE ATTESTATION. When the merge appended a `repull-scrubbed` line beside other files, the one
 * shape the proof needs it for, the Worker appends to the ledger on `main` one line naming the
 * merge commit (`shared/repull-merge-acceptance.ts`), in a commit of its own through the Contents
 * API (`upstream-repull-acceptance-github.ts`), leased on the ledger blob it read, so a line another
 * writer appended in between is never dropped: GitHub refuses the write and it is read again.
 * Every request, a replay included, reads `main`'s ledger first: a line already there is seen and
 * not written again; a missing one is written, once more, only while `main` still holds the merge.
 * The line is a function of the stored acceptance, so a write whose answer was lost is found, and
 * a line on `main` naming this merge that is not NEMAR's bytes is `attestation-conflict`, never
 * overwritten. The release is refused until the Worker reads the line on `main` itself
 * (`acceptance-unattested`, `upstream-repull-verified.ts`).
 *
 * Nothing here moves the record, merges, tags or mails anyone. The reason never leaves NEMAR's
 * database: the ledger refuses free text by design (ADR 0085, ADR 0036).
 */

import { z } from "zod";
import {
  ACKNOWLEDGMENT_MAX_LENGTH,
  ACKNOWLEDGMENT_MIN_LENGTH,
} from "../../../shared/publication-limits.js";
import {
  type LedgerWord,
  type TreeEntry,
  acceptedMergesOf,
  changesBesideLedger,
  classifyMergeParents,
  ledgerChange,
  ledgerLines,
  ledgerTimeOf,
  ledgerWordOf,
  mergeAcceptanceLine,
  nemarTreeOf,
  sameOutsideNemar,
} from "../../../shared/repull-merge-acceptance.js";
import {
  PULL_REQUEST_COLUMNS,
  REPULL_PULL_REQUESTS,
  type RepullPullRequest,
  type RepullRow,
  SHA_RE,
} from "../../../shared/repull-state.js";
import { AUDIT_IF_PREVIOUS_CHANGED_SQL, auditLogParams } from "../db/audit-log.js";
import type { Bindings } from "../types/bindings.js";
import {
  type Read,
  mergeOnMain,
  movedByEnrichmentOnly,
  putLedger,
  readCommit,
  readLedger,
  readTree,
} from "./upstream-repull-acceptance-github.js";
import { readRecordedPullRequest, unreadable } from "./upstream-repull-github.js";
import { type RepullRefusal, envFenceRefusal, getRepull } from "./upstream-repull.js";

export { ATTESTATION_MESSAGE } from "./upstream-repull-acceptance-github.js";

export const acceptMergeSchema = z
  .object({
    pr: z.enum(REPULL_PULL_REQUESTS),
    merge_sha: z.string().regex(SHA_RE, "merge_sha must be a 40-character lowercase hex id"),
    // The publication path's rule for a reason (ADR 0086); needed only for a first acceptance.
    reason: z
      .string()
      .trim()
      .min(
        ACKNOWLEDGMENT_MIN_LENGTH,
        `The reason needs at least ${ACKNOWLEDGMENT_MIN_LENGTH} characters`,
      )
      .max(
        ACKNOWLEDGMENT_MAX_LENGTH,
        `The reason is limited to ${ACKNOWLEDGMENT_MAX_LENGTH} characters`,
      )
      .optional(),
  })
  .strict();

export type AcceptMergeBody = z.infer<typeof acceptMergeSchema>;

/** The acceptance as the API shows it. */
export interface MergeAcceptance {
  repull_id: number;
  pr: RepullPullRequest;
  merge_sha: string;
  reason: string;
  accepted_by: number;
  accepted_at: string;
  attestation_needed: 0 | 1;
  scanner: string | null;
  attestation_sha: string | null;
  attested_at: string | null;
}

/** What the Worker read on GitHub before it accepted; the CLI prints it beside its own reading. */
export interface AcceptanceEvidence {
  pull_request: number;
  merged_head: string;
  head_moved_by_enrichment: boolean;
  parent: string;
  parent_moved_by_enrichment: boolean;
  tree: string;
  ledger: LedgerWord;
}

export interface AcceptResult {
  acceptance: MergeAcceptance;
  /** Null on a replay: this request read nothing new, and the first request's answer said it. */
  evidence: AcceptanceEvidence | null;
  /** The ledger line on `main`, when one is needed; null when the proof needs none. */
  attestation_line: string | null;
  replayed: boolean;
}

export const ACCEPTANCE_SQL =
  "SELECT * FROM upstream_repull_merge_acceptances WHERE repull_id = ? AND pr = ?";

/**
 * The acceptance, inserted only while the record is as it was read (`?1` repull, `?2` status,
 * `?3` revision, `?4` merge column's value), so a record that moved in between gets no row.
 */
const INSERT_ACCEPTANCE_SQL = (
  mergeColumn: string,
) => `INSERT INTO upstream_repull_merge_acceptances
   (repull_id, pr, merge_sha, reason, accepted_by, attestation_needed, scanner)
   SELECT ?1, ?5, ?4, ?6, ?7, ?8, ?9
    WHERE EXISTS (SELECT 1 FROM upstream_repulls
                   WHERE id = ?1 AND status = ?2 AND revision = ?3 AND ${mergeColumn} = ?4)
      AND NOT EXISTS (SELECT 1 FROM upstream_repull_merge_acceptances WHERE repull_id = ?1 AND pr = ?5)`;

/** The line was written now: its commit and the time. */
const MARK_WRITTEN_SQL = `UPDATE upstream_repull_merge_acceptances
   SET attestation_sha = ?3, attested_at = datetime('now')
 WHERE repull_id = ?1 AND pr = ?2 AND attestation_needed = 1`;

/** The line was found on `main`: the first time it was seen, the commit left as it was. */
const MARK_SEEN_SQL = `UPDATE upstream_repull_merge_acceptances
   SET attested_at = COALESCE(attested_at, datetime('now'))
 WHERE repull_id = ?1 AND pr = ?2 AND attestation_needed = 1`;

export async function readAcceptance(
  db: D1Database,
  repullId: number,
  pr: RepullPullRequest,
): Promise<MergeAcceptance | null> {
  return db.prepare(ACCEPTANCE_SQL).bind(repullId, pr).first<MergeAcceptance>();
}

function refusal(code: string, message: string, row?: RepullRow): RepullRefusal {
  return { status: 409, code, message, ...(row ? { row } : {}) };
}

/** A read's refusal, about this row. */
const unread = (r: { refusal: RepullRefusal }, row: RepullRow): RepullRefusal => ({
  ...r.refusal,
  row,
});

/**
 * A read's refusal once the acceptance is recorded: it says so, and that the line was not written
 * (a read's own words say nothing was recorded, which is no longer so).
 */
const unreadAfterRecord = (r: { refusal: RepullRefusal }, row: RepullRow): RepullRefusal => {
  const why = /\(([^)]*)\)/.exec(r.refusal.message)?.[1] ?? "no answer";
  return {
    ...r.refusal,
    row,
    message: `The acceptance is recorded, and GitHub could not be read (${why}), so its ledger line was not written; ask again, which writes it once.`,
  };
};

/**
 * Whether the merge changed any path but the ledger against its parent: the root trees outside
 * `.nemar`, then, when only `.nemar` differs, its entries but the ledger (a root without `.nemar`
 * has none).
 */
async function besideLedger(
  env: Bindings,
  row: RepullRow,
  parentRoot: TreeEntry[],
  mergeRoot: TreeEntry[],
): Promise<Read<boolean>> {
  const sub = async (root: TreeEntry[]): Promise<Read<TreeEntry[] | null>> => {
    const sha = nemarTreeOf(root);
    if (sha === null) return { ok: true, value: null };
    const t = await readTree(env, row, sha);
    if (!t.ok) return t;
    return t.value === null
      ? { ok: false, refusal: unreadable("the .nemar tree", "not found") }
      : t;
  };
  // Outside `.nemar` the roots decide alone; an equal `.nemar` object is no change in it.
  if (changesBesideLedger(parentRoot, mergeRoot, null, null)) return { ok: true, value: true };
  if (nemarTreeOf(parentRoot) === nemarTreeOf(mergeRoot)) return { ok: true, value: false };
  const a = await sub(parentRoot);
  if (!a.ok) return a;
  const b = await sub(mergeRoot);
  if (!b.ok) return b;
  return { ok: true, value: changesBesideLedger(parentRoot, mergeRoot, a.value, b.value) };
}

/** Accept the merge (see the module comment), or replay an acceptance already recorded. */
export async function acceptRepullMerge(
  env: Bindings,
  admin: { id: number },
  id: number,
  body: AcceptMergeBody,
): Promise<AcceptResult | RepullRefusal> {
  const db = env.DB;
  const row = await getRepull(db, id);
  if (!row) return { status: 404, code: "not-found", message: `No re-pull #${id}.` };
  const fence = envFenceRefusal(env, row.dataset_id);
  if (fence) return fence;
  const cols = PULL_REQUEST_COLUMNS[body.pr];

  const stored = await readAcceptance(db, id, body.pr);
  if (stored) {
    if (stored.merge_sha !== body.merge_sha) {
      return refusal(
        "merge-mismatch",
        `Re-pull #${id} accepted the merge ${stored.merge_sha.slice(0, 12)}, not ${body.merge_sha.slice(0, 12)}.`,
        row,
      );
    }
    return attest(env, row, body.pr, stored, null, true);
  }
  if (body.reason === undefined) {
    return refusal(
      "merge-trailers-not-accepted",
      `No acceptance of the merge of the ${body.pr} pull request is recorded for re-pull #${id}; accepting it needs a reason.`,
      row,
    );
  }

  // 1. The record.
  if (row.status !== cols.merged) {
    return refusal(
      "bad-transition",
      `A merge made without its trailers is accepted while the record is ${cols.merged}; re-pull #${id} is ${row.status}.`,
      row,
    );
  }
  if (row[cols.mergeSha] !== body.merge_sha) {
    return refusal(
      "merge-mismatch",
      `Re-pull #${id} records the merge ${String(row[cols.mergeSha]).slice(0, 12)}, not ${body.merge_sha.slice(0, 12)}.`,
      row,
    );
  }
  if (row.origin !== "administrator") {
    return refusal(
      "accept-automatic",
      `Re-pull #${id} was opened by the automatic path, whose merges the Worker sends with the trailers; a merge of it without them is not accepted.`,
      row,
    );
  }
  if (row.actor_user_id !== admin.id) {
    return refusal(
      "accept-not-yours",
      `Re-pull #${id} was opened by another administrator; only the administrator who opened a re-pull accepts its merge.`,
      row,
    );
  }

  // 2. The pull request, on GitHub.
  const pull = await readRecordedPullRequest(env, row, body.pr);
  if (!pull.ok) return { ...pull.refusal, row };
  const facts = pull.facts;
  const number = row[cols.number] as number;
  if (!facts.merged || facts.mergeCommitSha !== body.merge_sha) {
    return refusal(
      "merge-mismatch",
      facts.merged
        ? `GitHub says pull request #${number} merged as ${String(facts.mergeCommitSha).slice(0, 12)}, not ${body.merge_sha.slice(0, 12)}.`
        : `GitHub says pull request #${number} is not merged.`,
      row,
    );
  }
  const recordedHead = row[cols.head] as string;
  const head = await movedByEnrichmentOnly(env, row, recordedHead, facts.headSha);
  if (!head.ok) return unread(head, row);
  if (!head.value) {
    return refusal(
      "merge-head-foreign",
      `Pull request #${number} merged at ${facts.headSha.slice(0, 12)}, which is not the recorded head ${recordedHead.slice(0, 12)} or a commit enrichment moved it to.`,
      row,
    );
  }

  // 3. The merge commit: the base or an enrichment-moved descendant of it as its first or only parent.
  const merge = await readCommit(env, row, body.merge_sha);
  if (!merge.ok) return unread(merge, row);
  if (merge.value === null) {
    return { ...unreadable(`commit ${body.merge_sha.slice(0, 12)}`, "not found"), row };
  }
  // One parent (a squash) or two with the merged head second (GitHub's plain merge), and no other.
  const shaped = classifyMergeParents(
    merge.value.parents,
    facts.headSha,
    body.merge_sha.slice(0, 12),
  );
  if (!shaped.ok) return refusal(shaped.code, shaped.message, row);
  const parent = shaped.first;
  const base = (body.pr === "n0" ? row.base_sha : row.patch_base_sha) as string;
  const parentOk = await movedByEnrichmentOnly(env, row, base, parent);
  if (!parentOk.ok) return unread(parentOk, row);
  if (!parentOk.value) {
    return refusal(
      "merge-parent-foreign",
      `The merge commit's parent ${parent.slice(0, 12)} is not the record's base ${base.slice(0, 12)} or a commit enrichment moved it to.`,
      row,
    );
  }

  // 4. The tree, outside NEMAR's own paths.
  let anchorTree: string | null;
  if (body.pr === "n0") {
    anchorTree = row.synth_tree;
  } else if (row.patch_gates_sha === null) {
    anchorTree = null;
  } else {
    const gated = await readCommit(env, row, row.patch_gates_sha);
    if (!gated.ok) return unread(gated, row);
    anchorTree = gated.value?.tree ?? null;
  }
  if (anchorTree === null) {
    return refusal(
      "tree-anchor-missing",
      `Re-pull #${id} records no gated head of its N.0.1 pull request, so the merged tree has nothing to be compared with.`,
      row,
    );
  }
  const mergedTree = await readTree(env, row, merge.value.tree);
  if (!mergedTree.ok) return unread(mergedTree, row);
  const recordedTree = await readTree(env, row, anchorTree);
  if (!recordedTree.ok) return unread(recordedTree, row);
  if (mergedTree.value === null || recordedTree.value === null) {
    return { ...unreadable("a tree", "not found"), row };
  }
  if (!sameOutsideNemar(mergedTree.value, recordedTree.value)) {
    return refusal(
      "merge-tree-mismatch",
      `The merge commit's tree is not the re-pull's ${body.pr === "n0" ? "commit" : "gated N.0.1 head"} outside .nemar/ and .github/.`,
      row,
    );
  }

  // 5. The ledger: what the merge did to it decides whether the proof needs a line.
  const before = await readLedger(env, row, parent);
  if (!before.ok) return unread(before, row);
  const after = await readLedger(env, row, body.merge_sha);
  if (!after.ok) return unread(after, row);
  const change = ledgerChange(before.value?.text ?? null, after.value?.text ?? null);
  if (change.kind === "other") {
    return refusal(
      "merge-ledger-foreign",
      "The merge commit changes the privacy ledger other than by appending a scrub's lines, which the fresh-clone proof refuses whatever is accepted.",
      row,
    );
  }
  let needed = false;
  let scanner: string | null = null;
  if (change.kind === "scrub-append" && change.repull) {
    const parentCommit = await readCommit(env, row, parent);
    if (!parentCommit.ok) return unread(parentCommit, row);
    const parentRoot = parentCommit.value
      ? await readTree(env, row, parentCommit.value.tree)
      : ({ ok: true, value: null } as const);
    if (!parentRoot.ok) return unread(parentRoot, row);
    if (parentRoot.value === null) return { ...unreadable("the parent's tree", "not found"), row };
    const beside = await besideLedger(env, row, parentRoot.value, mergedTree.value);
    if (!beside.ok) return unread(beside, row);
    needed = beside.value;
    scanner = change.scanner;
  }
  // The line must be one the ledger takes before anything is recorded, or no request could ever
  // write it and the release would wait for it for good.
  if (needed) {
    try {
      mergeAcceptanceLine({
        dataset: row.dataset_id,
        version: row[cols.version] as string,
        mergeSha: body.merge_sha,
        planDigest: row.plan_digest,
        scanner: scanner ?? "",
        at: "2000-01-01T00:00:00.000Z",
      });
    } catch {
      return refusal(
        "merge-ledger-foreign",
        "The merge commit's repull-scrubbed line names no scanner a ledger line can carry, so no acceptance line could be written for it.",
        row,
      );
    }
  }

  // 6. `main`: it holds the merge, and, when a line is needed, a ledger that names it in no line.
  const onMain = await mergeOnMain(env, row, body.merge_sha);
  if (!onMain.ok) return unread(onMain, row);
  if (!onMain.value) {
    return refusal(
      "merge-not-on-main",
      `NEMAR's main no longer holds the merge commit ${body.merge_sha.slice(0, 12)} (rewritten or force-pushed past it), so nothing was accepted or written.`,
      row,
    );
  }
  if (needed) {
    const ledger = await readLedger(env, row, "main");
    if (!ledger.ok) return unread(ledger, row);
    if (ledger.value === null) {
      return refusal(
        "ledger-missing-on-main",
        "The privacy ledger is not on main, so an acceptance line would have no ledger to extend; nothing was accepted or written.",
        row,
      );
    }
    if (acceptedMergesOf(ledger.value.text).includes(body.merge_sha)) {
      return refusal(
        "attestation-conflict",
        "The ledger on main already names this merge in a line NEMAR did not write; nothing was accepted or written, and an administrator looks.",
        row,
      );
    }
  }

  const results = await db.batch([
    db
      .prepare(INSERT_ACCEPTANCE_SQL(cols.mergeSha))
      .bind(
        id,
        row.status,
        row.revision,
        body.merge_sha,
        body.pr,
        body.reason,
        admin.id,
        needed ? 1 : 0,
        needed ? scanner : null,
      ),
    db.prepare(AUDIT_IF_PREVIOUS_CHANGED_SQL).bind(
      ...auditLogParams({
        userId: admin.id,
        action: "repull_merge_trailers_accepted",
        resourceType: "upstream_repull",
        resourceId: String(id),
        details: JSON.stringify({
          dataset_id: row.dataset_id,
          pr: body.pr,
          merge_sha: body.merge_sha,
          merged_head: facts.headSha,
          parent,
          attestation_needed: needed,
          reason: body.reason,
        }),
      }),
    ),
  ]);
  const recorded = await readAcceptance(db, id, body.pr);
  if ((results[0]?.meta?.changes ?? 0) === 0 || !recorded) {
    if (recorded && recorded.merge_sha === body.merge_sha) {
      return attest(env, row, body.pr, recorded, null, true);
    }
    const now = (await getRepull(db, id)) ?? row;
    return refusal(
      "stale-status",
      `Re-pull #${id} moved before the acceptance was recorded; it is ${now.status}.`,
      now,
    );
  }
  return attest(
    env,
    row,
    body.pr,
    recorded,
    {
      pull_request: number,
      merged_head: facts.headSha,
      head_moved_by_enrichment: facts.headSha !== recordedHead,
      parent,
      parent_moved_by_enrichment: parent !== base,
      tree: merge.value.tree,
      ledger: ledgerWordOf(change),
    },
    false,
  );
}

// ----------------------------------------------------------------------------
// The attestation
// ----------------------------------------------------------------------------

/** The line the stored acceptance asks for, or null when the proof needs none. */
export function attestationLineOf(row: RepullRow, a: MergeAcceptance): string | null {
  if (a.attestation_needed !== 1 || a.scanner === null) return null;
  return mergeAcceptanceLine({
    dataset: row.dataset_id,
    version: row[PULL_REQUEST_COLUMNS[a.pr].version] as string,
    mergeSha: a.merge_sha,
    planDigest: row.plan_digest,
    scanner: a.scanner,
    at: ledgerTimeOf(a.accepted_at),
  });
}

/**
 * Whether the acceptance's line is on `main` now, read by the Worker: the release's own check
 * (`upstream-repull-verified.ts`), so a release never rests on a flag alone. True when none is
 * needed.
 */
export async function attestationOnMain(
  env: Bindings,
  row: RepullRow,
  a: MergeAcceptance,
): Promise<Read<boolean>> {
  const line = attestationLineOf(row, a);
  if (line === null) return { ok: true, value: true };
  const ledger = await readLedger(env, row, "main");
  if (!ledger.ok) return ledger;
  return {
    ok: true,
    value: ledger.value !== null && ledgerLines(ledger.value.text).includes(line),
  };
}

/**
 * The ledger line on `main`, read first and written when it is not there yet (see the module
 * comment); then the acceptance's answer.
 */
async function attest(
  env: Bindings,
  row: RepullRow,
  pr: RepullPullRequest,
  acceptance: MergeAcceptance,
  evidence: AcceptanceEvidence | null,
  replayed: boolean,
): Promise<AcceptResult | RepullRefusal> {
  const line = attestationLineOf(row, acceptance);
  const answer = async (): Promise<AcceptResult> => ({
    acceptance: (await readAcceptance(env.DB, row.id, pr)) ?? acceptance,
    evidence,
    attestation_line: line,
    replayed,
  });
  if (line === null) return answer();

  for (let attempt = 1; attempt <= 3; attempt++) {
    const current = await readLedger(env, row, "main");
    if (!current.ok) return unreadAfterRecord(current, row);
    if (current.value === null) {
      return refusal(
        "ledger-missing-on-main",
        "The acceptance is recorded, and the privacy ledger is not on main, so its line has no ledger to extend; nothing was written.",
        row,
      );
    }
    const { text, sha } = current.value;
    if (acceptedMergesOf(text).includes(acceptance.merge_sha)) {
      if (!ledgerLines(text).includes(line)) {
        return refusal(
          "attestation-conflict",
          "The acceptance is recorded, and the ledger on main names this merge in a line that is not NEMAR's acceptance as recorded; nothing was written, and an administrator looks.",
          row,
        );
      }
      await env.DB.prepare(MARK_SEEN_SQL).bind(row.id, pr).run();
      return answer();
    }
    // Written only while `main` still holds the merge, the first time and on every retry: a line
    // naming an id a rewritten history no longer holds would fail the proof on a clean dataset.
    const onMain = await mergeOnMain(env, row, acceptance.merge_sha);
    if (!onMain.ok) return unreadAfterRecord(onMain, row);
    if (!onMain.value) {
      return refusal(
        "merge-not-on-main",
        `The acceptance is recorded, and NEMAR's main no longer holds the merge commit ${acceptance.merge_sha.slice(0, 12)}, so its line is not written.`,
        row,
      );
    }
    const next = `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${line}\n`;
    const written = await putLedger(env, row, next, sha);
    if (written.kind === "written") {
      await env.DB.prepare(MARK_WRITTEN_SQL).bind(row.id, pr, written.commit).run();
      return answer();
    }
    if (written.kind === "conflict") continue;
    return {
      status: 502,
      code: "attestation-unwritten",
      message: `The acceptance is recorded, and its ledger line could not be written to main (${written.why}); ask again, which writes it once.`,
      row,
    };
  }
  return {
    status: 409,
    code: "attestation-unwritten",
    message:
      "The acceptance is recorded, and the ledger on main kept moving while its line was written; ask again, which writes it once.",
    row,
  };
}
