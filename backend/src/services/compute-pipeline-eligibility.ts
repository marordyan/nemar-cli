/**
 * Which datasets NEMAR's own pipelines may process (epic #2005 phase A6, #2011; ADR 0065; ADR 0118).
 *
 * ONE predicate, written once as a list of named terms, each with its SQL and its TypeScript form side
 * by side, so the query that selects candidates and the check that re-confirms a row cannot drift
 * apart: a test drives the same generated rows through both and fails on any disagreement. The shape is
 * `neurobagel-eligibility.ts`'s, deliberately; the two predicates are separate because what federates
 * and what is processed are different decisions.
 *
 * DECIDED FROM THE D1 ROW on every dispatch, never from the request and never from a value a caller
 * supplied (ADR 0065): the anonymity term reads the stored `anonymous` column and nothing else. A
 * dataset is eligible when it is:
 *   - active (`status`), public (`visibility`), and NOT anonymous (`anonymous = 0`; NULL is unknown,
 *     and unknown is not false);
 *   - first published (`first_published_at`), not withdrawn (`withdrawn_at`), and its concept DOI not
 *     tombstoned (`ezid_status` is not `unavailable`);
 *   - holding at least one `dataset_versions` row;
 *   - an EEG dataset: `eeg` is a WHOLE token of its comma-separated `modalities` (the whole-token clause
 *     of `dataset-filters.ts`, so `ieeg` is not `eeg`);
 *   - a real dataset: an `nm` id below the reserved fixture band (ADR 0068) or an `on` OpenNeuro
 *     mirror, and neither a sandbox nor an exemplar row.
 *
 * "Deleted" is not a separate term: deleting a dataset removes its row, and a row with
 * `status = 'deleted'` fails the `active` term.
 *
 * The SQL names a term's literals inline and binds nothing, so a statement that embeds the predicate
 * binds only its own parameters. Embed it; never copy it.
 */

import { dataTagForVersion } from "../../../shared/contract/compute.js";
import { MODALITY_TOKENS_SQL, parseTokenList } from "./dataset-filters.js";
import { RESERVED_FIXTURE_FLOOR, formatDatasetId } from "./datasetId.js";

/** The first reserved `nm` id: real datasets are strictly below it (ADR 0068). */
export const PIPELINE_REAL_NM_CEILING = formatDatasetId("nm", RESERVED_FIXTURE_FLOOR);

const NM_ID = /^nm\d{6}$/;
const ON_ID = /^on\d{6}$/;
const NM_GLOB = "nm[0-9][0-9][0-9][0-9][0-9][0-9]";
const ON_GLOB = "on[0-9][0-9][0-9][0-9][0-9][0-9]";

/** The modality a recipe is eligible on today. */
export const PIPELINE_MODALITY = "eeg";

/** A `datasets` row as the eligibility query projects it. `has_version` is 0 or 1. */
export interface PipelineRow {
  dataset_id: string;
  status: string | null;
  visibility: string | null;
  anonymous: number | null;
  first_published_at: string | null;
  withdrawn_at: string | null;
  /** The concept DOI's EZID status; `unavailable` is a tombstone. */
  ezid_status: string | null;
  is_sandbox: number | null;
  is_exemplar: number | null;
  /** The comma-separated list as stored. */
  modalities: string | null;
  has_version: number | null;
}

export type PipelineTermId =
  | "active"
  | "public"
  | "not_anonymous"
  | "first_published"
  | "not_withdrawn"
  | "not_tombstoned"
  | "has_version"
  | "eeg"
  | "real_dataset";

export interface PipelineTerm {
  id: PipelineTermId;
  /** SQL over the `datasets d` alias. No term binds a parameter. */
  sql: string;
  /** The same term over a row. */
  holds(row: PipelineRow): boolean;
}

/** Order is the order the terms appear in {@link PIPELINE_ELIGIBLE_SQL}. */
export const PIPELINE_TERMS: readonly PipelineTerm[] = [
  { id: "active", sql: "d.status = 'active'", holds: (row) => row.status === "active" },
  { id: "public", sql: "d.visibility = 'public'", holds: (row) => row.visibility === "public" },
  {
    id: "not_anonymous",
    // `= 0`, not `<> 1`: NULL is unknown, and unknown is not false.
    sql: "d.anonymous = 0",
    holds: (row) => row.anonymous === 0,
  },
  {
    id: "first_published",
    sql: "d.first_published_at IS NOT NULL",
    holds: (row) => row.first_published_at !== null && row.first_published_at !== undefined,
  },
  {
    id: "not_withdrawn",
    sql: "d.withdrawn_at IS NULL",
    holds: (row) => row.withdrawn_at === null || row.withdrawn_at === undefined,
  },
  {
    id: "not_tombstoned",
    // NULL is "never classified", which most datasets are, and is not a tombstone.
    sql: "COALESCE(d.ezid_status, '') <> 'unavailable'",
    holds: (row) => row.ezid_status !== "unavailable",
  },
  {
    id: "has_version",
    sql: "EXISTS (SELECT 1 FROM dataset_versions dv WHERE dv.dataset_id = d.dataset_id)",
    holds: (row) => row.has_version === 1,
  },
  {
    id: "eeg",
    // A WHOLE token of the stored list: the tokenizer of the catalog's own modality filter.
    sql: `EXISTS (${MODALITY_TOKENS_SQL} SELECT 1 FROM modality_tokens WHERE tok = '${PIPELINE_MODALITY}')`,
    holds: (row) => parseTokenList(row.modalities ?? "").includes(PIPELINE_MODALITY),
  },
  {
    id: "real_dataset",
    sql: `(
        ((d.dataset_id GLOB '${NM_GLOB}' AND d.dataset_id < '${PIPELINE_REAL_NM_CEILING}')
          OR d.dataset_id GLOB '${ON_GLOB}')
        AND COALESCE(d.is_sandbox, 0) = 0 AND COALESCE(d.is_exemplar, 0) = 0
      )`,
    // An id with an embedded NUL can pass SQLite's GLOB (it stops at the NUL) while this anchored
    // pattern refuses it: the fail-safe direction, and unreachable, since ids are validated at creation.
    holds: (row) =>
      ((NM_ID.test(row.dataset_id) && row.dataset_id < PIPELINE_REAL_NM_CEILING) ||
        ON_ID.test(row.dataset_id)) &&
      (row.is_sandbox ?? 0) === 0 &&
      (row.is_exemplar ?? 0) === 0,
  },
];

/** The predicate as one SQL fragment over `datasets d`: every term, ANDed. It binds no parameter. */
export const PIPELINE_ELIGIBLE_SQL = PIPELINE_TERMS.map((t) => t.sql).join("\n    AND ");

/**
 * The columns {@link isPipelineEligible} reads, with `has_version` computed. `FROM datasets d` is the
 * caller's. Projects no identity column and no DOI: eligibility is a decision, not a document.
 */
export const PIPELINE_ROW_COLUMNS = `d.dataset_id, d.status, d.visibility, d.anonymous,
    d.first_published_at, d.withdrawn_at, d.ezid_status, d.is_sandbox, d.is_exemplar, d.modalities,
    EXISTS (SELECT 1 FROM dataset_versions dv WHERE dv.dataset_id = d.dataset_id) AS has_version`;

/** One dataset's row regardless of eligibility, for the re-check. */
export const PIPELINE_ROW_BY_ID_SQL = `SELECT ${PIPELINE_ROW_COLUMNS} FROM datasets d WHERE d.dataset_id = ?`;

/** The pure re-check over a row. True only when every term holds. */
export function isPipelineEligible(row: PipelineRow | null | undefined): boolean {
  return !!row && PIPELINE_TERMS.every((t) => t.holds(row));
}

/**
 * The ids of the terms a row fails. Empty means eligible. A row that is not there fails every term:
 * a dataset that does not exist is blocked by all of them, and `active` is the first the answer names.
 */
export function failedPipelineTerms(row: PipelineRow | null | undefined): PipelineTermId[] {
  if (!row) return PIPELINE_TERMS.map((t) => t.id);
  return PIPELINE_TERMS.filter((t) => !t.holds(row)).map((t) => t.id);
}

/** Load one row and re-check it: the SQL selects, the TypeScript confirms. */
export async function loadPipelineRow(
  db: D1Database,
  datasetId: string,
): Promise<{ row: PipelineRow | null; eligible: boolean; blockedBy: PipelineTermId[] }> {
  const row =
    (await db.prepare(PIPELINE_ROW_BY_ID_SQL).bind(datasetId).first<PipelineRow>()) ?? null;
  return { row, eligible: isPipelineEligible(row), blockedBy: failedPipelineTerms(row) };
}

// --- The version a run reads ----------------------------------------------------------------------------

/**
 * A stored version as the data plane's tag, in SQL: a version that starts with a digit gets a `v`;
 * anything else is as stored. The TypeScript form is `dataTagForVersion`, which also refuses a
 * version that is not a tag at all (`1.0`, `abc`); this expression only makes the stored form
 * comparable with a stamp's `version`, and a test holds the two to each other over generated
 * versions. The argument is a column or expression of the caller's, never a value.
 */
export const VERSION_TAG_SQL = (column: string): string =>
  `(CASE WHEN substr(${column}, 1, 1) BETWEEN '0' AND '9' THEN 'v' || ${column} ELSE ${column} END)`;

/** A version row as the dispatch reads it. */
export interface PipelineVersion {
  version: string;
  total_files: number | null;
}

/**
 * A column (`version` or `total_files`) of the newest version row of a dataset, as a scalar subquery
 * over the alias `alias` (`d` or `s`): the order the data plane's `latest` uses, `created_at` with the
 * row id as the tie.
 */
export const NEWEST_VERSION_SQL = (alias: string, column: "version" | "total_files" = "version") =>
  `SELECT dv.${column} FROM dataset_versions dv WHERE dv.dataset_id = ${alias}.dataset_id
     ORDER BY dv.created_at DESC, dv.id DESC LIMIT 1`;

/**
 * All the version rows of a dataset, newest first: the order the data plane's `latest` uses
 * (`created_at`, with the row id as the tie).
 */
export const VERSIONS_OF_SQL = `SELECT dv.version, dv.total_files FROM dataset_versions dv
   WHERE dv.dataset_id = ?1 ORDER BY dv.created_at DESC, dv.id DESC`;

/**
 * The version row a run reads, or why there is none. With no `wanted` it is the newest row; with one
 * (any spelling `dataTagForVersion` accepts: `1.0.2`, `v1.0.2`, `latest`) it is the row whose tag is
 * the same, and `latest` is the newest. A row whose version has no data-plane tag cannot be read by a
 * launcher and is `version_untagged`.
 */
export function pickVersion(
  rows: readonly PipelineVersion[],
  wanted: string | undefined,
):
  | { ok: true; version: PipelineVersion; tag: string }
  | { ok: false; code: "version_not_found" | "version_untagged" } {
  const newest = rows[0];
  if (newest === undefined) return { ok: false, code: "version_not_found" };
  let row: PipelineVersion | undefined = newest;
  if (wanted !== undefined && wanted !== "latest") {
    const want = dataTagForVersion(wanted);
    if (want === null) return { ok: false, code: "version_not_found" };
    row = rows.find((r) => dataTagForVersion(r.version) === want);
    if (row === undefined) return { ok: false, code: "version_not_found" };
  }
  const tag = dataTagForVersion(row.version);
  return tag === null ? { ok: false, code: "version_untagged" } : { ok: true, version: row, tag };
}
