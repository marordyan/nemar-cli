# PR 1 spec: rebuild `datasets` as an 87-column table (issue #1182)

Worktree `<repo root>/../column-budget`, branch
`feature/issue-reclaim-column-budget`, based on `origin/dev`.

## Why a rebuild (not ALTER)

SQLite refuses `DROP COLUMN` on a CHECK-bound column. Four of the six attestation
columns carry CHECKs, so the collapse cannot be done incrementally. Verified.

## Verified facts (re-derived over all 789 prod rows; do NOT restate without re-checking)

- prod 89 cols @0069, 789 rows; dev 98 cols @0070, 9 rows; 0071 applied nowhere.
- `ezid_identifier = 'doi:' || UPPER(concept_doi)` in 768/768; 0 rows have either without the other.
- `doi_provider='ezid'` 789/789. `num_citations = num_dataset_citations + num_datapaper_citations` 789/789.
- 0 non-null: `zenodo_latest_version_id`, `metadata_columns_error`, `uploader`,
  `attestation_no_duplicate`, `attestation_upstream_source`. `zenodo_concept_id` 150.
- `sqlite_sequence.seq = 61277 = MAX(id)`, `MIN(id)=48` -> ids are SPARSE, copy them explicitly.
- `PRAGMA foreign_keys` = 1 on prod (always-on; D1 cannot disable it).
- THREE FK children (two written `REFERENCES "datasets"`, easy to miss):
  `access_requests.dataset_id -> datasets(id) ON DELETE CASCADE` (1 row);
  `dataset_collaborators.dataset_id -> datasets(id) ON DELETE CASCADE` (13 rows);
  `dataset_versions.dataset_id -> datasets(dataset_id)` NO ACTION (1118 rows).
  `publication_requests` (804) has NO FK to datasets.
- `datasets_fts` = 789 rows; 4 triggers key FTS rowid to `datasets.id`.
- 25 indexes; recreate 23 (drop `idx_datasets_ezid`, `idx_datasets_num_citations`).

## Target: 87 columns

DROP 6: `zenodo_latest_version_id`, `uploader`, `ezid_identifier`, `doi_provider`,
`num_citations`, `file_size_formatted`.
COLLAPSE 6 -> 1: the `attestation_*` columns become `attestation TEXT
CHECK (attestation IS NULL OR json_valid(attestation))` holding keys
`deposit_type, key_status, deidentified, no_duplicate, upstream_source, accepted_at`
(0/1 integers for the two booleans). NULL column = "no attestation on record" (ADR 0024).
KEEP explicitly: `zenodo_concept_id` (doomsday backup, user direction, keep its index),
`metadata_columns_error` (LIVE failure channel: written on error in
`services/enrich-dataset.ts` and `services/dataset-reindex.ts`; 0 rows means no recent
failures, NOT dead), `staleness_*`, all `zarr_*`/`archive_*`/`records_*`, all 12 sweep stamps
(PR 2 handles those).

98 - 6 - 5 = 87. Then 0072 adds 5 -> 92.

## Migration sequencing

1. `git mv backend/src/db/migrations/0071_signal_defaults.sql 0072_signal_defaults.sql`
   CONTENT UNTOUCHED. It is applied nowhere, so renaming is bookkeeping-safe.
2. New `backend/src/db/migrations/0071_reclaim_column_budget.sql`.

Apply order becomes prod: 0070, 0071, 0072. dev: 0071, 0072.

## The migration body (ordering is load-bearing)

Correctness must NOT depend on whole-file atomicity (unverified on remote D1).
`DROP TABLE` with FKs on fires ON DELETE CASCADE and `defer_foreign_keys` does NOT
suppress the ACTION (it only defers violation REPORTING). So: empty the children first,
then the implicit DELETE inside DROP TABLE has nothing to cascade and nothing to violate.

```
PRAGMA defer_foreign_keys = on;                 -- insurance only
CREATE TABLE _rebuild_guard (ok INTEGER NOT NULL CHECK (ok = 1));
CREATE TABLE datasets_new ( ...87 cols, id INTEGER PRIMARY KEY AUTOINCREMENT, dataset_id TEXT NOT NULL UNIQUE, ... );
INSERT INTO datasets_new (id, ...) SELECT id, ..., CASE WHEN <all six attestation cols NULL>
  THEN NULL ELSE json_object('deposit_type',...,'accepted_at',attestation_accepted_at) END, ... FROM datasets;
-- guards (a false comparison violates CHECK(ok=1) and aborts BEFORE anything destructive)
INSERT INTO _rebuild_guard SELECT (SELECT COUNT(*) FROM datasets_new)=(SELECT COUNT(*) FROM datasets);
INSERT INTO _rebuild_guard SELECT (SELECT COALESCE(SUM(id),0)||'/'||COALESCE(MIN(id),0)||'/'||COALESCE(MAX(id),0) FROM datasets_new)
                                = (SELECT COALESCE(SUM(id),0)||'/'||COALESCE(MIN(id),0)||'/'||COALESCE(MAX(id),0) FROM datasets);
CREATE TABLE _rescue_access_requests       AS SELECT * FROM access_requests;
CREATE TABLE _rescue_dataset_collaborators AS SELECT * FROM dataset_collaborators;
CREATE TABLE _rescue_dataset_versions      AS SELECT * FROM dataset_versions;
INSERT INTO _rebuild_guard SELECT (SELECT COUNT(*) FROM _rescue_dataset_versions)=(SELECT COUNT(*) FROM dataset_versions);  -- and the other two
DELETE FROM access_requests; DELETE FROM dataset_collaborators; DELETE FROM dataset_versions;
DROP TABLE datasets;                            -- drops its 4 triggers too
ALTER TABLE datasets_new RENAME TO datasets;    -- nothing references datasets_new, so no FK rewriting hazard
INSERT INTO dataset_versions      SELECT * FROM _rescue_dataset_versions;
INSERT INTO access_requests       SELECT * FROM _rescue_access_requests;
INSERT INTO dataset_collaborators SELECT * FROM _rescue_dataset_collaborators;
INSERT INTO _rebuild_guard SELECT (SELECT COUNT(*) FROM dataset_versions)=(SELECT COUNT(*) FROM _rescue_dataset_versions);  -- and the other two
DROP TABLE _rescue_dataset_versions; DROP TABLE _rescue_access_requests; DROP TABLE _rescue_dataset_collaborators;
-- 23 CREATE INDEX  (re-derive verbatim from live sqlite_master at implementation time)
-- 4  CREATE TRIGGER (re-derive verbatim; they reference only surviving columns)
INSERT INTO datasets_fts(datasets_fts, rank) VALUES('integrity-check', 1);   -- fails migration if FTS desynced
DROP TABLE _rebuild_guard;
```

NO `IF NOT EXISTS` anywhere: a blind re-run after partial failure must fail loudly.

## Code changes (contract rule: dropping a COLUMN is fine, dropping a SERVED FIELD is not)

`shared/contract/dataset.ts` gets NO shape change. All six attestation fields ARE declared
there (`datasetDetailSchema`), plus `file_size_formatted` and `num_citations`. All eight must
still be served.

- `num_citations`: stop writing (`services/citation-counts-sync.ts:93`); serve as SQL
  `(d.num_dataset_citations + d.num_datapaper_citations) AS num_citations` in list/detail
  projections and ORDER BY (`routes/datasets/catalog.ts:218,539,648,930`); rebind the facet
  (`services/dataset-facets.ts:169`) to the same expression.
- `file_size_formatted`: stop writing (`routes/datasets/upload.ts:349,469`,
  `services/dataset-metadata-columns.ts:285`); derive at read time with **`formatFileSize`**
  (`services/dataset-metadata-columns.ts:602`) which is BINARY/1024 and is today's actual
  writer. Do NOT use `formatBytes` from `services/s3.ts` (decimal) — that would shift every
  displayed size. Only stale rows change, and they change to correct values.
- `ezid_identifier`: add a helper beside `ensureDoiScheme` (`services/ezid.ts`) composing
  `'doi:' + UPPER(concept_doi)`; replace reads in `services/withdraw.ts` (~12 sites),
  `routes/admin/doi.ts`, `routes/admin/exemplar.ts`, `services/publication-orchestrator.ts`,
  `routes/admin/datasets-lifecycle.ts:1344`.
- `doi_provider`: reads collapse to the constant `'ezid'`; remove from writes; the admin
  concept-DOI mint route must REJECT `provider !== 'ezid'` with 400 (ADR 0007), because the
  zenodo mint branch cannot behave correctly without the column. Leave the now-unreachable
  zenodo branches in place; file a follow-up. Also `scripts/seed-dev-db.sql:40`.
- `uploader`: `routes/datasets/catalog.ts:639` and `services/dataset-filters.ts:202`
  `COALESCE(d.uploader, u.username)` -> `u.username`.
- `zenodo_latest_version_id`: remove writes (`routes/callbacks/version-doi.ts:886`,
  `routes/admin/doi.ts:527`, lifecycle:1344) and the admin `zenodo_latest_version_url`
  payload field (`routes/admin/doi.ts:613`).
- Attestation: `routes/datasets/upload.ts` writes one JSON value in both the resume UPDATE
  (~:311) and the create INSERT (~:469); the detail handler explodes the JSON back into the
  six flat contract field names. Wire shape unchanged, so the CLI is unaffected.
- Update row-type interfaces naming removed columns (compile-gated).

## Tests (.rules/testing.md: no mocks, entry points, EVERY test mutation-proved)

Use the real-engine helpers in `backend/test/helpers/d1.ts` (`freshDb()` applies all
migrations to real bun:sqlite; `realD1()` is a passthrough the repo documents as not-a-mock).

1. `backend/test/reclaim-column-budget-migration.test.ts` — set `PRAGMA foreign_keys = ON`
   explicitly (bun:sqlite defaults it OFF; D1 is always-on, so without this the cascade
   scenario is not modelled and the test is worthless). Apply through 0070, seed rows covering
   every fate class plus rows in ALL THREE FK children and FTS content, apply 0071+0072, assert:
   ids identical; all three child tables intact (THIS is the cascade regression test);
   attestation JSON field-exact; column count; `sqlite_sequence` preserved and a fresh INSERT
   takes max+1; FTS `integrity-check` rank=1 passes and MATCH returns identical rowids;
   an UPDATE of `name` post-rebuild is reflected in search and sets `embedding_dirty`
   (proves the recreated triggers).
   Mutation proofs, one line at a time: drop `id` from the copy list; delete one rescue-restore
   INSERT; move a DELETE above its rescue CREATE; misspell one `json_object` key; delete one
   CREATE TRIGGER.
2. `backend/test/datasets-column-budget.test.ts` — pin `pragma_table_info('datasets')` count
   === 92 exactly, plus `<= 97` as the budget ceiling, plus the index (23) and trigger (4) name
   sets. Local SQLite allows 2000 columns so it will NEVER reproduce D1's cap: this numeric pin
   IS the tripwire that makes the next over-budget migration fail in CI instead of at deploy.
   Mutation proof: append a scratch ADD COLUMN to 0072 -> fails.
3. `backend/test/dataset-detail-contract.test.ts` — entry point, not helper: mount the real
   routes over `realD1(freshDb())`, create a dataset THROUGH the upload route with an
   attestation, GET `/datasets/:id` and the list route, parse with
   `datasetDetailSchema`/`catalogItemSchema`, assert all six attestation fields plus
   `num_citations` and `file_size_formatted` present with contract types.
   Mutation proofs: remove the JSON-explode; drop one addend from the sum; swap
   `formatFileSize` for `formatBytes`.
4. Extend `backend/test/facet-filters-route.test.ts` for the citations facet expression.
5. Update the ~16 existing tests that name removed columns.

## ADR

**ADR 0034**, NOT 0033 — open PR #1184 claims 0033. RE-VERIFY the next free number against
`.context/decisions/` AND all open PRs immediately before creating the file; collisions merge
silently because different filenames never conflict in git (it already happened once with 0031).
Record: the cap incident and the 100-column budget; one-table reaffirmed (ADR 0003/0024);
each drop with its derivation; the attestation JSON shape and that it AMENDS ADR 0024's storage
without changing its decision; single zenodo column; `formatFileSize` as canonical formatter and
the user-visible stale-row corrections; the cascade-safe rebuild ordering.

`.context/decisions/README.md` and `AGENTS.md` will conflict with #1184 — expected and good.
Rebase on `dev` after #1184 merges; resolve by appending, never blind.

## Gates

`bun test`, `bun run lint`, `bun run typecheck`. Report pre-existing vs added failure counts
separately. Never background a test run. Never `git stash` in this worktree.
