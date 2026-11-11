-- NEMAR's own pipeline runs, one stamp per dataset version, recipe, recipe version and engine (epic
-- #2005 phase A6, #2011; ADR 0118; design section 10; the same idea as ADR 0033, which stamps what
-- converted a dataset so the queue knows what is current).
--
-- WHAT THIS IS FOR. A pipeline run is a job like any other (`compute_jobs`, source `pipeline`). This
-- table is the REGISTRY of those runs: which recipe, at which version, on which engine, has been run
-- over which version of which dataset. It answers one question, "is this dataset version current for
-- this recipe?", without reading a job's records, and it is what stops the same run being dispatched
-- twice.
--
-- THE CLAIM. A run claims its tuple FIRST, by inserting a `dispatched` row, and only then makes the
-- job. The partial unique index `compute_pipeline_stamps_live` refuses a second `dispatched` or
-- `succeeded` row for one tuple, so two requests racing for a tuple produce one stamp and one job; a
-- `failed` or `refused` row is not in the index, so history stays and a retry is allowed. Each retry
-- takes the next `attempt` number of its tuple (a full unique index keeps the numbers distinct).
--
-- STATES. `dispatched`: claimed, its job (once made) not yet over. `succeeded`: the job finished and
-- the recipe's own record was read. `failed`: the job failed or was canceled, or its record could not
-- be read, or the claim was never followed by a job; `refusal_code` says which, in a fixed word.
-- `refused`: the hold or the job's creation was refused after the claim; `refusal_code` is the word
-- and there is no job.
--
-- `recipe_version` and `engine` are written at the claim from the recipe registry
-- (shared/compute-recipes.ts) and, when the job succeeds, REWRITTEN from the recipe's own record, so
-- the stamp says what actually ran and not what the Worker expected. The rewrite can meet the unique
-- index (another run already stamped that tuple); the Worker then ends the stamp `failed`.
--
-- `updated_at` means "last examined" while a stamp is `dispatched`: the sync touches every open stamp it
-- visits, so a stamp that cannot move on goes to the back of the line, and the column says when the Worker
-- last looked and not when anything changed. On a `succeeded`, `failed` or `refused` stamp it is the time
-- of the end, which the retry cooldown reads.
--
-- NO FOREIGN KEY, and deleting a dataset deletes its stamps (services/deletion.ts) while the job rows
-- and the ledger stay, by design (design section 9). The table holds a dataset id, a version tag, fixed
-- words and a job id: no person, no path, no text a job wrote.
--
-- Every CHECK is named, a numeric column is checked with `typeof(...) = 'integer'`, every term is TRUE
-- or FALSE and never NULL, and every GLOB is at most 50 characters (D1 refuses longer).

CREATE TABLE compute_pipeline_stamps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset_id TEXT NOT NULL CONSTRAINT compute_pipeline_stamps_dataset CHECK (
    length(dataset_id) = 8 AND substr(dataset_id, 1, 2) NOT GLOB '*[^a-z]*'
    AND substr(dataset_id, 3) NOT GLOB '*[^0-9]*'),
  version TEXT NOT NULL CONSTRAINT compute_pipeline_stamps_version CHECK (
    length(version) BETWEEN 1 AND 64 AND version NOT GLOB '*[^0-9A-Za-z._+-]*'),
  recipe TEXT NOT NULL CONSTRAINT compute_pipeline_stamps_recipe CHECK (
    length(recipe) BETWEEN 1 AND 64 AND recipe NOT GLOB '*[^a-z0-9-]*'),
  recipe_version TEXT NOT NULL CONSTRAINT compute_pipeline_stamps_recipe_version CHECK (
    length(recipe_version) BETWEEN 1 AND 64 AND recipe_version NOT GLOB '*[^0-9A-Za-z._+-]*'),
  engine TEXT NOT NULL CONSTRAINT compute_pipeline_stamps_engine CHECK (
    length(engine) BETWEEN 1 AND 64 AND engine NOT GLOB '*[^0-9A-Za-z._+@-]*'),
  attempt INTEGER NOT NULL CONSTRAINT compute_pipeline_stamps_attempt CHECK (
    typeof(attempt) = 'integer' AND attempt BETWEEN 1 AND 1000000),
  state TEXT NOT NULL DEFAULT 'dispatched' CONSTRAINT compute_pipeline_stamps_state CHECK (
    state IN ('dispatched', 'succeeded', 'failed', 'refused')),
  job_id TEXT CONSTRAINT compute_pipeline_stamps_job CHECK (
    job_id IS NULL OR (length(job_id) = 28 AND substr(job_id, 1, 4) = 'job_'
      AND substr(job_id, 5) NOT GLOB '*[^0-9a-f]*')),
  refusal_code TEXT CONSTRAINT compute_pipeline_stamps_word CHECK (
    refusal_code IS NULL OR (length(refusal_code) BETWEEN 1 AND 64
      AND refusal_code NOT GLOB '*[^a-z0-9_]*')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- A stamp that did not end well says why, one that did not end or did carries no word, a success
  -- has its job, and a refusal has none.
  CONSTRAINT compute_pipeline_stamps_word_iff CHECK (
    (state IN ('failed', 'refused')) = (refusal_code IS NOT NULL)),
  CONSTRAINT compute_pipeline_stamps_succeeded_has_job CHECK (
    state <> 'succeeded' OR job_id IS NOT NULL),
  CONSTRAINT compute_pipeline_stamps_refused_has_no_job CHECK (
    state <> 'refused' OR job_id IS NULL)
);

-- THE RULE: one live or succeeded stamp per tuple. A query that relies on it states the same predicate.
CREATE UNIQUE INDEX compute_pipeline_stamps_live
  ON compute_pipeline_stamps (dataset_id, version, recipe, recipe_version, engine)
  WHERE state IN ('dispatched', 'succeeded');

-- Attempt numbers of one tuple are distinct, whatever became of the attempts before.
CREATE UNIQUE INDEX compute_pipeline_stamps_attempt
  ON compute_pipeline_stamps (dataset_id, version, recipe, recipe_version, engine, attempt);

-- The stamps the sync moves on: the open ones, oldest first.
CREATE INDEX compute_pipeline_stamps_open ON compute_pipeline_stamps (updated_at)
  WHERE state = 'dispatched';

-- A stamp from its job.
CREATE INDEX compute_pipeline_stamps_job ON compute_pipeline_stamps (job_id)
  WHERE job_id IS NOT NULL;
