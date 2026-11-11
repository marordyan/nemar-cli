-- The compute gateway's observer, legal holds and retention bookkeeping (epic #2005 phase A7, #2012;
-- ADR 0118, decisions 8 and 9).
--
-- WHAT THIS IS FOR. Expanse's own accounting arrives by a small posting service (the observer, design
-- section 8) that is an UNSIGNED SENDER: it carries a token valid for one run, minted by an administrator,
-- and what it posts is data to be bounded and compared, never trusted. Four tables carry that and the
-- legal holds the retention sweep honors; five columns of `compute_jobs` carry the sweeps' own
-- bookkeeping. No foreign key, and nothing here names a person: a table of this migration holds
-- fixed words, numbers, times and pseudonymous account ids only.
--
--   * `compute_observer_runs`: one row per token an administrator minted. The token itself is never
--     stored: it is an HMAC (domain tag `compute-observer`) over the run id and the `nonce`, so a
--     dump of this table cannot post. `status` is `issued` until the one post it may make is taken
--     (`ingested`, by a conditional UPDATE, so two posts racing make one) or the hour passes
--     (`expired`, written by the daily sweep; a refusal itself writes nothing).
--   * `compute_queue_snapshots`: the pending and running counts per partition the observer saw in a
--     run; `(run_id, partition)` is the key, so a run states each partition once.
--   * `compute_sacct_rows`: Expanse's own record of a Slurm job, one row per Slurm job id (the
--     daily export repeats jobs, `INSERT OR IGNORE` keeps the first). `charged_milli` is NULL when
--     the observer did not compute a charge, and the Worker then prices the allocation fields itself.
--     `matched_job_id` is the NEMAR job whose `slurm_job_id` this is; NULL while no job claims it,
--     and those rows are listed to the administrators (`nemar admin compute jobs list --unmatched`).
--     `applied_at` is when the row was applied to the ledger (a final settlement) or judged not to
--     apply (a figure that cannot be priced, a correction the pools cannot take); NULL while it waits
--     for its job to end. A row that is judged is never tried again, so one that can never settle
--     cannot hold a place in the daily pass for ever.
--   * `compute_legal_holds`: a hold on one job or on every job of one account. The retention sweep
--     deletes nothing under a hold. A hold is released, never removed (`released_at`), and there is at
--     most one ACTIVE hold per (scope, ref) (the partial unique index), so a second placement is a
--     conflict and not a second row. `reason` is a fixed word, never free text.
--
-- THE FIVE COLUMNS OF `compute_jobs` are the sweeps' own state, all NULL until a sweep sets them:
--   * `cancel_attempted_at`: the last time the cancel sweep took the row, so a cancel that cannot
--     complete goes to the back of the line and ten of them no longer starve every newer one;
--   * `retention_attempted_at`: the same rotation for the retention sweep, so a row whose objects the
--     bucket's lock refuses is tried again tomorrow behind the rows that can be deleted;
--   * `records_deleted_at`: `records/<id>/` is gone and the index row has been reduced to anonymous
--     counts; `logs_deleted_at`: `logs/<id>/` is gone; `results_reconciled_at`: the results bucket was
--     checked once, a day after the retention window, and nothing of the job was left in it.
--
-- THE INDEXES. `compute_jobs_slurm` serves the observer's match by Slurm id and the `record` command;
-- the two partial indexes serve the repair lists of the 30-minute tick, which now rotate by the row's
-- last examination (`examined_at`) the way the live lists do, so a copy or a settlement that fails on
-- every attempt no longer holds one of the ten slots for ever.

CREATE TABLE compute_observer_runs (
  id TEXT PRIMARY KEY NOT NULL CONSTRAINT compute_observer_runs_id CHECK (
    length(id) = 36 AND id NOT GLOB '*[^0-9a-f-]*'),
  nonce TEXT NOT NULL CONSTRAINT compute_observer_runs_nonce CHECK (
    length(nonce) = 36 AND nonce NOT GLOB '*[^0-9a-f-]*'),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'issued' CONSTRAINT compute_observer_runs_status CHECK (
    status IN ('issued', 'ingested', 'expired')),
  CONSTRAINT compute_observer_runs_window CHECK (expires_at > created_at)
);

CREATE INDEX compute_observer_runs_open ON compute_observer_runs (expires_at)
  WHERE status = 'issued';

CREATE TABLE compute_queue_snapshots (
  run_id TEXT NOT NULL CONSTRAINT compute_queue_snapshots_run CHECK (
    length(run_id) = 36 AND run_id NOT GLOB '*[^0-9a-f-]*'),
  partition TEXT NOT NULL CONSTRAINT compute_queue_snapshots_partition CHECK (
    length(partition) BETWEEN 1 AND 32 AND partition NOT GLOB '*[^a-z-]*'),
  pending INTEGER NOT NULL CONSTRAINT compute_queue_snapshots_pending CHECK (
    typeof(pending) = 'integer' AND pending BETWEEN 0 AND 1000000000),
  running INTEGER NOT NULL CONSTRAINT compute_queue_snapshots_running CHECK (
    typeof(running) = 'integer' AND running BETWEEN 0 AND 1000000000),
  captured_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (run_id, partition)
);

CREATE INDEX compute_queue_snapshots_captured ON compute_queue_snapshots (captured_at);

CREATE TABLE compute_sacct_rows (
  slurm_job_id TEXT PRIMARY KEY NOT NULL CONSTRAINT compute_sacct_rows_slurm CHECK (
    length(slurm_job_id) BETWEEN 1 AND 64 AND slurm_job_id NOT GLOB '*[^0-9A-Za-z_+.-]*'),
  run_id TEXT NOT NULL CONSTRAINT compute_sacct_rows_run CHECK (
    length(run_id) = 36 AND run_id NOT GLOB '*[^0-9a-f-]*'),
  partition TEXT NOT NULL CONSTRAINT compute_sacct_rows_partition CHECK (
    length(partition) BETWEEN 1 AND 32 AND partition NOT GLOB '*[^a-z-]*'),
  state TEXT NOT NULL CONSTRAINT compute_sacct_rows_state CHECK (
    length(state) BETWEEN 1 AND 32 AND state NOT GLOB '*[^A-Z_]*'),
  elapsed_seconds INTEGER NOT NULL CONSTRAINT compute_sacct_rows_elapsed CHECK (
    typeof(elapsed_seconds) = 'integer' AND elapsed_seconds BETWEEN 0 AND 31536000),
  alloc_nodes INTEGER NOT NULL CONSTRAINT compute_sacct_rows_nodes CHECK (
    typeof(alloc_nodes) = 'integer' AND alloc_nodes BETWEEN 0 AND 100000),
  alloc_cpus INTEGER NOT NULL CONSTRAINT compute_sacct_rows_cpus CHECK (
    typeof(alloc_cpus) = 'integer' AND alloc_cpus BETWEEN 0 AND 10000000),
  alloc_gpus INTEGER NOT NULL CONSTRAINT compute_sacct_rows_gpus CHECK (
    typeof(alloc_gpus) = 'integer' AND alloc_gpus BETWEEN 0 AND 1000000),
  alloc_mem_mb INTEGER NOT NULL CONSTRAINT compute_sacct_rows_mem CHECK (
    typeof(alloc_mem_mb) = 'integer' AND alloc_mem_mb BETWEEN 0 AND 1000000000),
  submit_time TEXT CONSTRAINT compute_sacct_rows_submit CHECK (
    submit_time IS NULL OR length(submit_time) BETWEEN 10 AND 40),
  start_time TEXT CONSTRAINT compute_sacct_rows_start CHECK (
    start_time IS NULL OR length(start_time) BETWEEN 10 AND 40),
  end_time TEXT CONSTRAINT compute_sacct_rows_end CHECK (
    end_time IS NULL OR length(end_time) BETWEEN 10 AND 40),
  charged_milli INTEGER CONSTRAINT compute_sacct_rows_charged CHECK (
    charged_milli IS NULL OR (typeof(charged_milli) = 'integer'
      AND charged_milli BETWEEN 0 AND 9007199254740991)),
  matched_job_id TEXT CONSTRAINT compute_sacct_rows_matched CHECK (
    matched_job_id IS NULL OR (length(matched_job_id) = 28 AND substr(matched_job_id, 1, 4) = 'job_'
      AND substr(matched_job_id, 5) NOT GLOB '*[^0-9a-f]*')),
  ingested_at TEXT NOT NULL DEFAULT (datetime('now')),
  applied_at TEXT
);

CREATE INDEX compute_sacct_rows_unmatched ON compute_sacct_rows (ingested_at)
  WHERE matched_job_id IS NULL;

CREATE INDEX compute_sacct_rows_pending ON compute_sacct_rows (ingested_at)
  WHERE applied_at IS NULL;

CREATE TABLE compute_legal_holds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL CONSTRAINT compute_legal_holds_scope CHECK (scope IN ('job', 'account')),
  ref TEXT NOT NULL CONSTRAINT compute_legal_holds_ref CHECK (
    (scope = 'job' AND length(ref) = 28 AND substr(ref, 1, 4) = 'job_'
      AND substr(ref, 5) NOT GLOB '*[^0-9a-f]*')
    OR (scope = 'account' AND length(ref) BETWEEN 1 AND 15 AND ref NOT GLOB '*[^0-9]*'
      AND ref GLOB '[1-9]*')),
  reason TEXT NOT NULL CONSTRAINT compute_legal_holds_reason CHECK (
    length(reason) BETWEEN 1 AND 64 AND reason NOT GLOB '*[^a-z0-9_]*'),
  placed_by INTEGER NOT NULL CONSTRAINT compute_legal_holds_placed_by CHECK (
    typeof(placed_by) = 'integer' AND placed_by >= 1),
  placed_at TEXT NOT NULL DEFAULT (datetime('now')),
  released_at TEXT
);

CREATE UNIQUE INDEX compute_legal_holds_active ON compute_legal_holds (scope, ref)
  WHERE released_at IS NULL;

ALTER TABLE compute_jobs ADD COLUMN cancel_attempted_at TEXT;

ALTER TABLE compute_jobs ADD COLUMN retention_attempted_at TEXT;

ALTER TABLE compute_jobs ADD COLUMN records_deleted_at TEXT;

ALTER TABLE compute_jobs ADD COLUMN logs_deleted_at TEXT;

ALTER TABLE compute_jobs ADD COLUMN results_reconciled_at TEXT;

CREATE INDEX compute_jobs_slurm ON compute_jobs (slurm_job_id) WHERE slurm_job_id IS NOT NULL;

CREATE INDEX compute_jobs_unsettled ON compute_jobs (examined_at)
  WHERE state IN ('finished', 'failed', 'cancelled') AND settled_provisional_at IS NULL;

CREATE INDEX compute_jobs_uncopied ON compute_jobs (examined_at)
  WHERE state IN ('finished', 'failed', 'cancelled') AND result_records_at IS NULL
    AND settled_provisional_at IS NOT NULL;

CREATE INDEX compute_jobs_cancelling ON compute_jobs (cancel_attempted_at)
  WHERE cancel_requested_at IS NOT NULL
    AND state IN ('created', 'uploading', 'submitted', 'queued', 'running', 'archiving',
                  'unreported');

CREATE INDEX compute_jobs_retention ON compute_jobs (retention_attempted_at)
  WHERE state IN ('finished', 'failed', 'cancelled') AND records_deleted_at IS NULL;
