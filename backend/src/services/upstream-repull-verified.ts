/**
 * What only GitHub and the version row can say about a re-pull: that its pull request merged, that
 * its version was released, and that a claim to merge was never sent (epic #1046 phase 6, #1912;
 * ADR 0111, decisions 2, 3 and 6).
 *
 * `merged`, `released` and their N.0.1 twins are facts, not steps a caller reports, so the
 * transition route refuses them (`use-verified-route`) and these functions write them after
 * reading the facts themselves, with the Worker's own GitHub credential:
 *  - merged: GitHub says the recorded pull request (its number, its release branch, aimed at
 *    `main`) is merged. The merge commit is GitHub's. A merge for which no NEMAR tool held a claim
 *    (`merged_outside_tool`), and one at a head other than the screened one
 *    (`merged_unscreened_head`), is still recorded, because it happened and a second major would
 *    be a second DOI; each is counted on its own so the record says which. The cap binds NEMAR's
 *    tools only (ADR 0111, Consequences). It is recorded from the open status too, for a pull
 *    request merged before its gates were (both counts then say so).
 *  - released: the version row exists with a DOI, the tag `v<version>` names the commit the
 *    caller reports, and that commit contains the merge; a merge an administrator accepted without
 *    its trailers also needs the ledger line that names it, read on `main` now by the Worker
 *    (`acceptance-unattested`, `upstream-repull-acceptance.ts`). In the same batch, and only when the
 *    edge applies: the version's lineage when the caller verified the tagged tree (N.0.0 only,
 *    decision 4), and the dataset's hed, channel-montage, data and availability stamps are
 *    re-armed (decision 2), so each sweep reads the new version again.
 *  - a claim is released only when the caller says the merge was not sent or was refused, the
 *    claim is at least five minutes old, and GitHub says the pull request is not merged: an
 *    unknown outcome keeps the claim, so a lost answer is resolved from GitHub and never repeated
 *    blind. A caller that does not know what became of the merge (`expired`, how a stuck claim
 *    ends) needs the claim thirty minutes old, long past any merge a tool can have in flight, and
 *    the same answer from GitHub. That is one read and an age, not proof: a merge that lands
 *    between the read and the release is recorded later, by `merged`, as one no tool held a claim
 *    for.
 *
 * A retried `merged` or `released` that finds its fact already recorded, for the same commit,
 * answers with the stored row (`replayed`), so a caller whose answer was lost can ask again; a
 * different commit is refused.
 *
 * Every write here goes through the transition's own checks and compare-and-set
 * (`prepareTransition`, `commitTransition`), and nothing here mails anyone.
 */

import { z } from "zod";
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
  AVAILABILITY_REPORT_AT_PATH,
  CHANNEL_MONTAGE_CHECKED_AT_PATH,
  DATA_CHECKED_AT_PATH,
  HED_CHECKED_AT_PATH,
} from "./sweep-stamps.js";
import { attestationOnMain, readAcceptance } from "./upstream-repull-acceptance.js";
import {
  githubRead,
  isObject,
  liveHeadRefusal,
  readRecordedPullRequest,
  unreadable,
} from "./upstream-repull-github.js";
import { repullScreenGate } from "./upstream-repull-screen.js";
import {
  LINEAGE_WRITE_SQL,
  type RepullRefusal,
  commitTransition,
  datasetFenceRefusal,
  envFenceRefusal,
  getRepull,
  isRefusal,
  prepareTransition,
} from "./upstream-repull.js";

/** How old a claim to merge must be before it may be released: a merge sent just now may still land. */
export const CLAIM_RELEASE_MIN_AGE_MINUTES = 5;

/**
 * How old a claim must be before a caller that does not know what became of its merge may expire
 * it (`expired`): long past any merge a NEMAR tool can have in flight (each request is bounded in
 * seconds), so GitHub's answer, read again, is the whole truth of whether it merged.
 */
export const CLAIM_EXPIRE_MIN_AGE_MINUTES = 30;

/**
 * The oldest a claim may be when a merge is sent under it again, by the Worker's own stamp: below
 * {@link CLAIM_EXPIRE_MIN_AGE_MINUTES}, with room for the merge itself, so a merge is never sent
 * under a claim the expiry may already be freeing. An older claim is released through `resume`.
 */
export const HELD_CLAIM_MAX_AGE_MINUTES = 25;

// ----------------------------------------------------------------------------
// SQL
// ----------------------------------------------------------------------------

/** The row as it was read, numbered after the statement's own parameters. */
const ROW_AS_READ = (first: number) =>
  `EXISTS (SELECT 1 FROM upstream_repulls WHERE id = ?${first} AND status = ?${first + 1} AND revision = ?${first + 2})`;

/**
 * {@link LINEAGE_WRITE_SQL} (`?1` tag, `?2` dataset, `?3` version), applied only while the re-pull
 * row is as it was read (`?4` id, `?5` status, `?6` revision): it runs in the release's batch
 * before the transition, which is the only statement there that moves the row, so it applies
 * exactly when the transition does.
 */
export const LINEAGE_AT_RELEASE_SQL = `${LINEAGE_WRITE_SQL}
   AND ${ROW_AS_READ(4)}`;

/**
 * Re-arm the four sweeps of the one dataset a release changed (`?1` dataset; `?2` to `?4` the
 * row as it was read). Removing a marker is the whole of re-queueing: each sweep's candidates are
 * the datasets without it. The values the sweeps wrote stay until each sweep overwrites them.
 */
export const STAMPS_REARM_SQL = `UPDATE datasets
   SET sweep_stamps = json_remove(sweep_stamps, '${HED_CHECKED_AT_PATH}',
     '${CHANNEL_MONTAGE_CHECKED_AT_PATH}', '${DATA_CHECKED_AT_PATH}', '${AVAILABILITY_REPORT_AT_PATH}')
 WHERE dataset_id = ?1 AND sweep_stamps IS NOT NULL AND ${ROW_AS_READ(2)}`;

/**
 * Whether the version was minted: a version row with a DOI, in either spelling of the version.
 * Only that it exists is read; the identifier itself goes into no response and no audit row.
 */
export const RELEASED_VERSION_SQL = `SELECT 1 AS minted FROM dataset_versions
  WHERE dataset_id = ? AND version IN (?, 'v' || ?) AND doi IS NOT NULL AND doi <> '' LIMIT 1`;

/**
 * Whether a claim's Worker-stamped time is old enough to release (`?` id), `minutes` one of the two
 * constants above. Column and bound from constants, never a request.
 */
const claimOldEnoughSql = (claimedAt: string, minutes: number) =>
  `SELECT CASE WHEN ${claimedAt} <= datetime('now', '-${minutes} minutes') THEN 1 ELSE 0 END AS old
     FROM upstream_repulls WHERE id = ?`;

/** The age a release needs: a caller that knows what became of its merge, or one that does not. */
function releaseAgeMinutes(outcome: ReleaseOutcome): number {
  return outcome === "expired" ? CLAIM_EXPIRE_MIN_AGE_MINUTES : CLAIM_RELEASE_MIN_AGE_MINUTES;
}

// ----------------------------------------------------------------------------
// Request bodies
// ----------------------------------------------------------------------------

const sha = z.string().regex(SHA_RE, "must be a 40-character lowercase hex id");

/**
 * What the caller knows of the merge its claim was for: `not_sent` (it decided not to send it) and
 * `refused` (GitHub answered that it did not merge), or `expired`, a claim whose outcome the caller
 * does not know (a lost answer, a run that stopped between the claim and the merge), released
 * only once it is {@link CLAIM_EXPIRE_MIN_AGE_MINUTES} minutes old, which is how a stuck claim is
 * expired. `unknown` is not here on purpose: a merge whose answer was just lost may have happened,
 * and only GitHub, read after the merge could still be in flight, says it did not.
 */
export const RELEASE_OUTCOMES = ["not_sent", "refused", "expired"] as const;
export type ReleaseOutcome = (typeof RELEASE_OUTCOMES)[number];

export const releaseClaimSchema = z
  .object({
    pr: z.enum(REPULL_PULL_REQUESTS),
    sha,
    outcome: z.enum(RELEASE_OUTCOMES),
  })
  .strict();

export const mergedSchema = z.object({ pr: z.enum(REPULL_PULL_REQUESTS) }).strict();

export const claimCheckSchema = z.object({ pr: z.enum(REPULL_PULL_REQUESTS), sha }).strict();

export const releasedSchema = z
  .object({
    pr: z.enum(REPULL_PULL_REQUESTS),
    tag_sha: sha,
    /** The caller compared the tagged tree with the synthesized one outside NEMAR's paths. */
    tree_verified: z.boolean(),
  })
  .strict();

// ----------------------------------------------------------------------------
// The claim, released
// ----------------------------------------------------------------------------

/**
 * Clear a claim to merge so its unit of the day's cap is free again: one whose merge was never
 * sent or that GitHub refused (`not_sent`, `refused`), once the claim is
 * {@link CLAIM_RELEASE_MIN_AGE_MINUTES} minutes old by the Worker's own stamp, or one whose outcome
 * the caller does not know (`expired`, how `resume` ends a stuck claim), once it is
 * {@link CLAIM_EXPIRE_MIN_AGE_MINUTES} minutes old. Either way only while the row is still at its
 * gates-clear status with the claim naming `sha` and no merge recorded (in the statement that
 * clears it), and only when GitHub says the pull request is not merged: a merged one is recorded
 * with `merged`. The age and the one read are a guard, not proof that no merge is in flight; the
 * merge gate never sends a merge under a claim older than
 * {@link HELD_CLAIM_MAX_AGE_MINUTES} minutes, and holds the record's lock while it sends, which a
 * resume takes too.
 */
export async function releaseMergeClaim(
  env: Bindings,
  admin: { id: number },
  id: number,
  body: z.infer<typeof releaseClaimSchema>,
): Promise<{ row: RepullRow } | RepullRefusal> {
  const db = env.DB;
  const row = await getRepull(db, id);
  if (!row) return { status: 404, code: "not-found", message: `No re-pull #${id}.` };
  const fence = envFenceRefusal(env, row.dataset_id);
  if (fence) return fence;
  const cols = PULL_REQUEST_COLUMNS[body.pr];
  if (row.status !== cols.gatesClear || row[cols.claimSha] === null) {
    return {
      status: 409,
      code: "no-claim",
      message: `Re-pull #${id} holds no claim to merge its ${body.pr} pull request (it is ${row.status}).`,
      row,
    };
  }
  if (row[cols.claimSha] !== body.sha) {
    return {
      status: 409,
      code: "claim-mismatch",
      message: `The claim names ${String(row[cols.claimSha]).slice(0, 12)}, not ${body.sha.slice(0, 12)}.`,
      row,
    };
  }
  const minutes = releaseAgeMinutes(body.outcome);
  const age = await db
    .prepare(claimOldEnoughSql(cols.claimedAt, minutes))
    .bind(id)
    .first<{ old: number }>();
  if (age?.old !== 1) {
    return {
      status: 409,
      code: "claim-too-recent",
      message:
        body.outcome === "expired"
          ? `The claim was made less than ${minutes} minutes ago and what became of its merge is not known, so it expires only once it is older.`
          : `The claim was made less than ${minutes} minutes ago; a merge sent just now may still land, so it is released only once it is older.`,
      row,
    };
  }
  const read = await readRecordedPullRequest(env, row, body.pr);
  if (!read.ok) return read.refusal;
  if (read.facts.merged) {
    return {
      status: 409,
      code: "pull-request-merged",
      message: `GitHub says pull request #${row[cols.number]} is merged, so the claim stands; record the merge instead.`,
      row,
    };
  }
  // Column names are this module's constants, never a request's.
  const results = await db.batch([
    db
      .prepare(
        `UPDATE upstream_repulls
            SET ${cols.claimedAt} = NULL, ${cols.claimSha} = NULL,
                revision = revision + 1, updated_at = datetime('now')
          WHERE id = ? AND status = ? AND revision = ? AND ${cols.claimSha} = ?
            AND ${cols.mergeSha} IS NULL
            AND ${cols.claimedAt} <= datetime('now', '-${minutes} minutes')`,
      )
      .bind(id, row.status, row.revision, body.sha),
    db.prepare(AUDIT_IF_PREVIOUS_CHANGED_SQL).bind(
      ...auditLogParams({
        userId: admin.id,
        action: "repull_merge_claim_released",
        resourceType: "upstream_repull",
        resourceId: String(id),
        details: JSON.stringify({
          dataset_id: row.dataset_id,
          pr: body.pr,
          sha: body.sha,
          outcome: body.outcome,
          claimed_at: row[cols.claimedAt],
        }),
      }),
    ),
  ]);
  const after = await getRepull(db, id);
  if (!after) return { status: 404, code: "not-found", message: `Re-pull #${id} was deleted.` };
  if ((results[0]?.meta?.changes ?? 0) === 0) {
    return {
      status: 409,
      code: "stale-status",
      message: `Re-pull #${id} moved before the claim was released; it is ${after.status}.`,
      row: after,
    };
  }
  return { row: after };
}

// ----------------------------------------------------------------------------
// A held claim, checked before a merge is sent under it again
// ----------------------------------------------------------------------------

/** Whether a claim's stamp is young enough to send a merge under it again (`?` id). */
const claimFreshSql = (claimedAt: string) =>
  `SELECT CASE WHEN ${claimedAt} > datetime('now', '-${HELD_CLAIM_MAX_AGE_MINUTES} minutes') THEN 1 ELSE 0 END AS fresh
     FROM upstream_repulls WHERE id = ?`;

/**
 * Whether a merge may be sent again under a claim already held (ADR 0111, decisions 6 and 7):
 * the same fences the claim's own statement holds, read again now, because a claim made earlier
 * says nothing of what changed since. The record at its gates-clear status with the claim naming
 * `sha` and no merge recorded; the claim younger than {@link HELD_CLAIM_MAX_AGE_MINUTES} minutes
 * (`claim-too-old` otherwise: release it through resume); the dataset fences (a mirror of its `ds`,
 * not anonymous, not withdrawn, no import in flight); the identifier screen passing for `sha` for
 * THIS administrator, so one administrator does not merge under another's acknowledgment (ADR
 * 0086); and GitHub's live head at `sha`. Writes nothing.
 */
export async function checkHeldClaim(
  env: Bindings,
  admin: { id: number },
  id: number,
  body: z.infer<typeof claimCheckSchema>,
): Promise<{ row: RepullRow } | RepullRefusal> {
  const db = env.DB;
  const row = await getRepull(db, id);
  if (!row) return { status: 404, code: "not-found", message: `No re-pull #${id}.` };
  const fence = envFenceRefusal(env, row.dataset_id);
  if (fence) return fence;
  const cols = PULL_REQUEST_COLUMNS[body.pr];
  if (
    row.status !== cols.gatesClear ||
    row[cols.claimSha] === null ||
    row[cols.mergeSha] !== null
  ) {
    return {
      status: 409,
      code: "no-claim",
      message: `Re-pull #${id} holds no open claim to merge its ${body.pr} pull request (it is ${row.status}).`,
      row,
    };
  }
  if (row[cols.claimSha] !== body.sha) {
    return {
      status: 409,
      code: "claim-mismatch",
      message: `The claim names ${String(row[cols.claimSha]).slice(0, 12)}, not ${body.sha.slice(0, 12)}.`,
      row,
    };
  }
  const fresh = await db.prepare(claimFreshSql(cols.claimedAt)).bind(id).first<{ fresh: number }>();
  if (fresh?.fresh !== 1) {
    return {
      status: 409,
      code: "claim-too-old",
      message: `The claim was made ${HELD_CLAIM_MAX_AGE_MINUTES} or more minutes ago, so no merge is sent under it: nemar admin repull resume reads GitHub and records the merge, or expires the claim once it is ${CLAIM_EXPIRE_MIN_AGE_MINUTES} minutes old.`,
      row,
    };
  }
  const fenced = await datasetFenceRefusal(db, row);
  if (fenced) return { ...fenced, row };
  const gate = await repullScreenGate(db, {
    datasetId: row.dataset_id,
    repullId: id,
    pr: body.pr,
    sha: body.sha,
    actorId: admin.id,
  });
  if (!gate.ok) {
    return {
      status: 409,
      code: "screen-not-clear",
      message: `${gate.message} (gate: ${gate.gate})`,
      row,
    };
  }
  const moved = await liveHeadRefusal(env, row, body.pr, body.sha);
  if (moved) return moved;
  return { row };
}

// ----------------------------------------------------------------------------
// Merged
// ----------------------------------------------------------------------------

export interface MergedResult {
  row: RepullRow;
  merged_outside_tool: boolean;
  merged_unscreened_head: boolean;
  /** The merge was already recorded with this merge commit; nothing was written. */
  replayed: boolean;
}

/**
 * Record that the recorded pull request merged, from GitHub's own answer: `gates_clear` to
 * `merged` (or the N.0.1 twin) with GitHub's merge commit. From `pr_open` too (or
 * `patch_synthesized`): a pull request merged before its gates were recorded, on GitHub's page or
 * by any other hand, held no claim and was merged at no screened head, so both counts say so;
 * without this edge the row would stay open with a minted DOI behind it.
 */
export async function recordRepullMerged(
  env: Bindings,
  admin: { id: number },
  id: number,
  body: z.infer<typeof mergedSchema>,
): Promise<MergedResult | RepullRefusal> {
  const db = env.DB;
  const row = await getRepull(db, id);
  if (!row) return { status: 404, code: "not-found", message: `No re-pull #${id}.` };
  const fence = envFenceRefusal(env, row.dataset_id);
  if (fence) return fence;
  const cols = PULL_REQUEST_COLUMNS[body.pr];
  const recorded = row[cols.mergeSha];
  if (row.status !== cols.gatesClear && row.status !== cols.open && recorded === null) {
    return {
      status: 409,
      code: "bad-transition",
      message: `A merge of the ${body.pr} pull request is recorded from ${cols.open} or ${cols.gatesClear}; re-pull #${id} is ${row.status}.`,
      row,
    };
  }
  const read = await readRecordedPullRequest(env, row, body.pr);
  if (!read.ok) return read.refusal;
  const { facts } = read;
  if (recorded !== null) {
    // A retry after a lost answer: the stored merge stands when GitHub names the same commit.
    // The flags are this pull request's own facts (its claim, its screened head), never the
    // row's counts, which N.0.0's and N.0.1's merges share.
    if (facts.merged && facts.mergeCommitSha === recorded) {
      return {
        row,
        merged_outside_tool: row[cols.claimSha] === null,
        merged_unscreened_head: facts.headSha !== row[cols.gates],
        replayed: true,
      };
    }
    return {
      status: 409,
      code: "already-merged",
      message: `Re-pull #${id} already records the merge ${recorded.slice(0, 12)}, and GitHub does not name that commit now.`,
      row,
    };
  }
  if (!facts.merged) {
    return {
      status: 409,
      code: "not-merged",
      message: `GitHub says pull request #${row[cols.number]} is not merged.`,
      row,
    };
  }
  if (facts.mergeCommitSha === null) {
    return unreadable(`pull request #${row[cols.number]}`, "a merge with no merge commit");
  }
  // Two facts, counted apart: no NEMAR tool held a claim, and the merged head is not the screened
  // one. A claim that is held means a tool sent (or was about to send) the merge.
  const outsideTool = row[cols.claimSha] === null;
  const unscreenedHead = facts.headSha !== row[cols.gates];
  const counts: Record<string, number> = {};
  if (outsideTool) counts.merged_outside_tool = 1;
  if (unscreenedHead) counts.merged_unscreened_head = 1;
  const prepared = await prepareTransition(
    env,
    admin,
    row,
    {
      from: row.status,
      to: cols.merged,
      fields: {
        [cols.mergeSha]: facts.mergeCommitSha,
        ...(Object.keys(counts).length > 0 ? { counts } : {}),
      },
    },
    {
      verified: true,
      auditDetails: {
        merged_head: facts.headSha,
        merged_outside_tool: outsideTool,
        merged_unscreened_head: unscreenedHead,
      },
    },
  );
  if (isRefusal(prepared)) return prepared;
  const done = await commitTransition(db, prepared);
  if (isRefusal(done)) return done;
  if (outsideTool || unscreenedHead) {
    console.warn(
      `[upstream-repull] ${row.dataset_id} re-pull ${id} ${body.pr}: merged${outsideTool ? " with no claim held" : ""}${unscreenedHead ? " at a head other than the screened one" : ""}`,
    );
  }
  return {
    row: done.row,
    merged_outside_tool: outsideTool,
    merged_unscreened_head: unscreenedHead,
    replayed: false,
  };
}

// ----------------------------------------------------------------------------
// Released
// ----------------------------------------------------------------------------

export interface ReleasedResult {
  row: RepullRow;
  /**
   * Version rows the lineage write upgraded: 0 unless N.0.0's tagged tree was verified. Null on a
   * replay: this request wrote nothing, and the first request's answer and audit row say what it
   * wrote (unknown is not zero).
   */
  lineage_rows: number | null;
  /**
   * 1 when the statement that re-arms the dataset's four sweep stamps ran on its row (it reports a
   * change even when none of the four was there to remove); 0 only when the dataset has no stamps
   * object at all. Null on a replay, as `lineage_rows`.
   */
  stamps_rearmed: number | null;
  /** The release was already recorded with this tag commit; nothing was written. */
  replayed: boolean;
}

/**
 * Record that the merged version was released: `merged` to `released` (or the N.0.1 twin) once
 * the version row exists with a DOI and the tag names the reported commit, which contains the
 * merge. The lineage write (N.0.0, tree verified) and the stamp re-arm ride in the same batch and
 * apply exactly when the transition does.
 */
export async function recordRepullReleased(
  env: Bindings,
  admin: { id: number },
  id: number,
  body: z.infer<typeof releasedSchema>,
): Promise<ReleasedResult | RepullRefusal> {
  const db = env.DB;
  const row = await getRepull(db, id);
  if (!row) return { status: 404, code: "not-found", message: `No re-pull #${id}.` };
  const fence = envFenceRefusal(env, row.dataset_id);
  if (fence) return fence;
  const cols = PULL_REQUEST_COLUMNS[body.pr];
  const recorded = row[cols.tagSha];
  if (recorded !== null) {
    // A retry after a lost answer: the stored release stands for the same tag commit.
    if (recorded === body.tag_sha) {
      return { row, lineage_rows: null, stamps_rearmed: null, replayed: true };
    }
    return {
      status: 409,
      code: "already-released",
      message: `Re-pull #${id} already records the release at ${recorded.slice(0, 12)}, not ${body.tag_sha.slice(0, 12)}.`,
      row,
    };
  }
  if (row.status !== cols.merged) {
    return {
      status: 409,
      code: "bad-transition",
      message: `A release of the ${body.pr} pull request is recorded from ${cols.merged}; re-pull #${id} is ${row.status}.`,
      row,
    };
  }
  const version = row[cols.version] as string;
  const mergeSha = row[cols.mergeSha] as string;
  // A merge accepted without its trailers is released only once the Worker itself reads, on
  // `main`, the ledger line that names it (ADR 0111, the amendment of 2026-10-29): the line is what
  // lets a fresh clone pass the privacy ledger's proof, so a release without it would leave the
  // dataset failing that proof. Read now, never taken from the acceptance's stored flag.
  const acceptance = await readAcceptance(db, id, body.pr);
  if (acceptance) {
    const seen = await attestationOnMain(env, row, acceptance);
    if (!seen.ok) return { ...seen.refusal, row };
    if (!seen.value) {
      return {
        status: 409,
        code: "acceptance-unattested",
        message: `The merge of re-pull #${id} was accepted without its trailers, and the ledger line that names it is not on main; resume writes it first.`,
        row,
      };
    }
  }
  const versionRow = await db
    .prepare(RELEASED_VERSION_SQL)
    .bind(row.dataset_id, version, version)
    .first<{ minted: number }>();
  if (!versionRow) {
    return {
      status: 409,
      code: "not-released",
      message: `${row.dataset_id} has no version ${version} with a DOI yet; the release is recorded once the version is minted.`,
      row,
    };
  }
  const tag = `v${version}`;
  // The commit the tag names, as its bare id: an annotated tag is peeled to its commit. The ref is
  // spelled in full: GitHub answers 422 ("No commit found for SHA: tags/v2.0.0") to the short
  // `tags/<tag>` form, which the first two production re-pulls met (2026-11-08). The full form was
  // checked by hand against nemarDatasets/on003645 and on004362, whose tags answer their merge commits.
  const tagRead = await githubRead(
    env,
    row.dataset_id,
    `/commits/refs/tags/${encodeURIComponent(tag)}`,
    "application/vnd.github.sha",
  );
  if (!tagRead.ok) return tagRead.refusal;
  const tagged = tagRead.text;
  if (tagRead.status !== 200 || typeof tagged !== "string" || !SHA_RE.test(tagged)) {
    return {
      status: 409,
      code: "tag-missing",
      message: `${row.dataset_id} has no tag ${tag} that GitHub resolves to a commit.`,
      row,
    };
  }
  if (tagged !== body.tag_sha) {
    return {
      status: 409,
      code: "tag-mismatch",
      message: `Tag ${tag} names ${tagged.slice(0, 12)}, not ${body.tag_sha.slice(0, 12)}.`,
      row,
    };
  }
  const compare = await githubRead(env, row.dataset_id, `/compare/${mergeSha}...${tagged}`);
  if (!compare.ok) return compare.refusal;
  if (compare.status !== 200) {
    return {
      status: 409,
      code: "compare-unresolved",
      message: "GitHub could not compare the tag with the merge.",
      row,
    };
  }
  const relation = isObject(compare.body) ? compare.body.status : null;
  // `diverged` and `behind` say the tag does not contain the merge; anything else is not an answer.
  if (relation !== "identical" && relation !== "ahead") {
    return {
      status: 409,
      code: "tag-mismatch",
      message: `Tag ${tag} (${tagged.slice(0, 12)}) does not contain the merge ${mergeSha.slice(0, 12)}.`,
      row,
    };
  }

  const prepared = await prepareTransition(
    env,
    admin,
    row,
    { from: cols.merged, to: cols.released, fields: { [cols.tagSha]: tagged } },
    {
      verified: true,
      auditDetails: { version, tag_sha: tagged, tree_verified: body.tree_verified },
    },
  );
  if (isRefusal(prepared)) return prepared;
  const asRead = [row.id, row.status, row.revision];
  // Lineage is N.0.0's only: N.0.1 carries NEMAR's corrections, so its tree is not upstream's.
  const lineage = body.pr === "n0" && body.tree_verified;
  const before = [
    ...(lineage
      ? [db.prepare(LINEAGE_AT_RELEASE_SQL).bind(row.to_tag, row.dataset_id, version, ...asRead)]
      : []),
    db.prepare(STAMPS_REARM_SQL).bind(row.dataset_id, ...asRead),
  ];
  const done = await commitTransition(db, prepared, before);
  if (isRefusal(done)) return done;
  return {
    row: done.row,
    lineage_rows: lineage ? (done.results[0]?.meta?.changes ?? 0) : 0,
    stamps_rearmed: done.results[lineage ? 1 : 0]?.meta?.changes ?? 0,
    replayed: false,
  };
}
