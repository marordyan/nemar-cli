-- The compute gateway's job index (epic #2005 phase A3, #2008; ADR 0118, decisions 2, 7 and 9).
--
-- WHAT THIS IS FOR. NEMAR is the record of every tenant job, whichever front door submitted it.
-- The full record (what was submitted, who submitted it, the logs, the results' manifest) lives in
-- the private records bucket; D1 holds one INDEX ROW per job: enough to count, to filter, to settle
-- and to find the record. Two tables carry that:
--   * `compute_jobs`: one row per job, written in the SAME BATCH as the job's hold (see below);
--   * `compute_gateway_users`: the pseudonym an account is reported to ACCESS under, made on the
--     account's first job.
--
-- SEPARATION: D1 JOB ROWS CARRY THE ACCOUNT ID AND FIXED WORDS ONLY. There is no column for a name,
-- an email, a country, an ORCID iD, an affiliation or an OIDC subject, and a test refuses one: those
-- live in `records/<job id>/identity.json` and nowhere else, so deleting an account never has to
-- reach this table and reading this table never reveals a person. `tapis_owner` is the Tapis
-- username a partner job ran under, which is an account name on Tapis and not a NEMAR identity.
--
-- A JOB AND ITS HOLD ARE ONE BATCH (services/compute-jobs.ts): the hold's conditional INSERT, then
-- this table's INSERT gated on that hold row existing, so a refused hold leaves no job row and a job
-- row always has its hold. The column `hold_ledger_id` is that entry's id. Nothing here is a foreign
-- key and none cascades: a job and its ledger entries follow the retention schedule (design section
-- 9, phase A7), never an account's deletion, and the ledger is append-only.
--
-- WORDS. A state, a source, a kind and a pool are enumerated, and a test compares each list with
-- `shared/compute-state.ts` and `shared/contract/compute.ts`. The words a LATER epic may add (a
-- failure code, a cancel reason, a failure detail, a partition) are checked by SHAPE
-- (`NOT GLOB '*[^a-z0-9_]*'`), never by a list, so a new word never forces a rebuild of the table;
-- a test holds every word declared today to the shape. `state = 'failed'` if and only if a failure
-- code is set. A CHECK passes on NULL, so a term over a column that may be NULL is written
-- `col IS NULL OR (...)`, and every column a term reads without that guard is NOT NULL: that includes
-- the primary keys, because SQLite lets a NULL into a primary key that is not declared NOT NULL (a rowid
-- table), and `INTEGER PRIMARY KEY` would turn a NULL into a fresh row number instead. So `id` is
-- `TEXT PRIMARY KEY NOT NULL`, and the pseudonym table's key is `INT NOT NULL PRIMARY KEY` (not a rowid
-- alias). Every CHECK is named, so that a test can say which one refused a row. D1 rejects SQL that
-- bun:sqlite accepts, so every GLOB below is at most 50 characters. A numeric column is checked with
-- `typeof(...) = 'integer'`: SQLite would otherwise keep 1.5 in an INTEGER column.
--
-- compute_jobs, column by column:
--   * `id`: `job_` and 24 lowercase hex digits (COMPUTE_JOB_ID_RE); the prefix of every key of the job.
--   * `account_id`: the NEMAR account the job is attributed to; NULL means no NEMAR account (a
--     partner's job whose owner maps to none, charged to the partner's pool).
--   * `tapis_owner`: the Tapis `owner` of a partner job; NULL for the others.
--   * `gateway_user`: the pseudonym ACCESS is told, copied from compute_gateway_users when the job
--     is made (`gw_` and 20 base32 characters), or `nemar-pipelines` for NEMAR's own jobs; NULL for a
--     job with no account.
--   * `idempotency_key`: the caller's key; the unique index below is per account and only when set.
--   * `source` (cli, web, partner, pipeline), `client_id` (a partner client), `kind` (batch,
--     interactive), `state` (the ten of COMPUTE_STATES, default `created`).
--   * `failure_code`, `failure_detail`, `cancel_reason`: fixed words; `cancel_requested_at`: when.
--   * `tapis_uuid` (unique), `tapis_status`, `slurm_job_id`: what Tapis and Slurm call the job.
--   * `app_id`, `app_version`, `image_digest`: what runs; `spec_digest`: the SHA-256 of the exact
--     bytes of `records/<id>/spec.json`, which is what was ASKED FOR (never the launch specification,
--     which carries a token: the launcher's own digest is a different column, phase A5's).
--   * `partition`, `pool`, `nodes`, `cores_per_node`, `memory_mb`, `gpus`, `minutes`: the resources
--     requested, per node.
--   * `created_at` (on D1's clock), `submitted_at` (NEMAR's submit to Tapis), `remote_submitted_at`,
--     `started_at`, `ended_at` (Tapis's own times), `tapis_synced_at` (the last read back),
--     `records_written_at` (the records have landed; the submit waits for it).
--   * `hold_ledger_id`, `held_milli`, `charged_milli`, `settled_provisional_at`, `settled_final_at`:
--     the ledger's entry, what the job holds and what it has been charged, in whole milli-SU.
--   * `flag_*`: what an administrator is told (COMPUTE_JOB_FLAGS).
--   * `retention_until`: the retention sweep honours it (phase A7). `legal_hold` is UNUSED and stays 0:
--     the hold that counts is a row of `compute_legal_holds` (migration 0118), not this column.
--   * `webhook_nonce`: the secret half of the job's webhook address, a random UUID.

CREATE TABLE compute_jobs (
  id TEXT PRIMARY KEY NOT NULL CONSTRAINT compute_jobs_id CHECK (
    length(id) = 28 AND substr(id, 1, 4) = 'job_' AND substr(id, 5) NOT GLOB '*[^0-9a-f]*'),
  account_id INTEGER CONSTRAINT compute_jobs_account CHECK (
    account_id IS NULL OR (typeof(account_id) = 'integer' AND account_id >= 1)),
  tapis_owner TEXT CONSTRAINT compute_jobs_tapis_owner CHECK (
    tapis_owner IS NULL OR (length(tapis_owner) BETWEEN 1 AND 128
      AND tapis_owner NOT GLOB '*[^A-Za-z0-9_.@+-]*')),
  gateway_user TEXT CONSTRAINT compute_jobs_gateway_user CHECK (
    gateway_user IS NULL OR gateway_user = 'nemar-pipelines'
    OR (length(gateway_user) = 23 AND substr(gateway_user, 1, 3) = 'gw_'
      AND substr(gateway_user, 4) NOT GLOB '*[^a-z2-7]*')),
  idempotency_key TEXT CONSTRAINT compute_jobs_idempotency_key CHECK (
    idempotency_key IS NULL OR (length(idempotency_key) BETWEEN 1 AND 128
      AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*')),
  source TEXT NOT NULL CONSTRAINT compute_jobs_source CHECK (
    source IN ('cli', 'web', 'partner', 'pipeline')),
  client_id TEXT CONSTRAINT compute_jobs_client_id CHECK (
    client_id IS NULL OR (length(client_id) BETWEEN 1 AND 64
      AND client_id NOT GLOB '*[^A-Za-z0-9_.-]*')),
  kind TEXT NOT NULL CONSTRAINT compute_jobs_kind CHECK (kind IN ('batch', 'interactive')),
  state TEXT NOT NULL DEFAULT 'created' CONSTRAINT compute_jobs_state CHECK (state IN
    ('created', 'uploading', 'submitted', 'queued', 'running', 'archiving', 'finished', 'failed',
     'cancelled', 'unreported')),
  failure_code TEXT CONSTRAINT compute_jobs_failure_code CHECK (
    failure_code IS NULL OR (length(failure_code) BETWEEN 1 AND 64
      AND failure_code NOT GLOB '*[^a-z0-9_]*')),
  failure_detail TEXT CONSTRAINT compute_jobs_failure_detail CHECK (
    failure_detail IS NULL OR (length(failure_detail) BETWEEN 1 AND 64
      AND failure_detail NOT GLOB '*[^a-z0-9_]*')),
  cancel_reason TEXT CONSTRAINT compute_jobs_cancel_reason CHECK (
    cancel_reason IS NULL OR (length(cancel_reason) BETWEEN 1 AND 64
      AND cancel_reason NOT GLOB '*[^a-z0-9_]*')),
  cancel_requested_at TEXT,
  tapis_uuid TEXT UNIQUE CONSTRAINT compute_jobs_tapis_uuid CHECK (
    tapis_uuid IS NULL OR (length(tapis_uuid) BETWEEN 1 AND 64
      AND tapis_uuid NOT GLOB '*[^A-Za-z0-9-]*')),
  tapis_status TEXT CONSTRAINT compute_jobs_tapis_status CHECK (
    tapis_status IS NULL OR (length(tapis_status) BETWEEN 1 AND 32
      AND tapis_status NOT GLOB '*[^A-Z_]*')),
  slurm_job_id TEXT CONSTRAINT compute_jobs_slurm_job_id CHECK (
    slurm_job_id IS NULL OR (length(slurm_job_id) BETWEEN 1 AND 64
      AND slurm_job_id NOT GLOB '*[^0-9A-Za-z_+.-]*')),
  app_id TEXT NOT NULL CONSTRAINT compute_jobs_app_id CHECK (
    length(app_id) BETWEEN 1 AND 80 AND app_id NOT GLOB '*[^A-Za-z0-9._-]*'),
  app_version TEXT NOT NULL CONSTRAINT compute_jobs_app_version CHECK (
    length(app_version) BETWEEN 1 AND 64 AND app_version NOT GLOB '*[^A-Za-z0-9._+-]*'),
  image_digest TEXT CONSTRAINT compute_jobs_image_digest CHECK (
    image_digest IS NULL OR (length(image_digest) = 71 AND substr(image_digest, 1, 7) = 'sha256:'
      AND substr(image_digest, 8) NOT GLOB '*[^0-9a-f]*')),
  spec_digest TEXT NOT NULL CONSTRAINT compute_jobs_spec_digest CHECK (
    length(spec_digest) = 64 AND spec_digest NOT GLOB '*[^0-9a-f]*'),
  partition TEXT NOT NULL CONSTRAINT compute_jobs_partition CHECK (
    length(partition) BETWEEN 1 AND 32 AND partition NOT GLOB '*[^a-z-]*'),
  pool TEXT NOT NULL CONSTRAINT compute_jobs_pool CHECK (pool IN ('cpu', 'gpu')),
  nodes INTEGER NOT NULL CONSTRAINT compute_jobs_nodes CHECK (
    typeof(nodes) = 'integer' AND nodes BETWEEN 1 AND 64),
  cores_per_node INTEGER NOT NULL CONSTRAINT compute_jobs_cores CHECK (
    typeof(cores_per_node) = 'integer' AND cores_per_node BETWEEN 0 AND 256),
  memory_mb INTEGER CONSTRAINT compute_jobs_memory CHECK (
    memory_mb IS NULL OR (typeof(memory_mb) = 'integer' AND memory_mb BETWEEN 1 AND 16777216)),
  gpus INTEGER NOT NULL DEFAULT 0 CONSTRAINT compute_jobs_gpus CHECK (
    typeof(gpus) = 'integer' AND gpus BETWEEN 0 AND 8),
  minutes INTEGER NOT NULL CONSTRAINT compute_jobs_minutes CHECK (
    typeof(minutes) = 'integer' AND minutes BETWEEN 1 AND 10080),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  submitted_at TEXT,
  remote_submitted_at TEXT,
  started_at TEXT,
  ended_at TEXT,
  tapis_synced_at TEXT,
  records_written_at TEXT,
  hold_ledger_id INTEGER CONSTRAINT compute_jobs_hold_ledger_id CHECK (
    hold_ledger_id IS NULL OR (typeof(hold_ledger_id) = 'integer' AND hold_ledger_id >= 1)),
  held_milli INTEGER NOT NULL DEFAULT 0 CONSTRAINT compute_jobs_held CHECK (
    typeof(held_milli) = 'integer' AND held_milli BETWEEN 0 AND 9007199254740991),
  charged_milli INTEGER NOT NULL DEFAULT 0 CONSTRAINT compute_jobs_charged CHECK (
    typeof(charged_milli) = 'integer' AND charged_milli BETWEEN 0 AND 9007199254740991),
  settled_provisional_at TEXT,
  settled_final_at TEXT,
  flag_unreserved INTEGER NOT NULL DEFAULT 0 CONSTRAINT compute_jobs_flag_unreserved CHECK (
    flag_unreserved IN (0, 1)),
  flag_unattributed INTEGER NOT NULL DEFAULT 0 CONSTRAINT compute_jobs_flag_unattributed CHECK (
    flag_unattributed IN (0, 1)),
  flag_mismatch INTEGER NOT NULL DEFAULT 0 CONSTRAINT compute_jobs_flag_mismatch CHECK (
    flag_mismatch IN (0, 1)),
  flag_overrun INTEGER NOT NULL DEFAULT 0 CONSTRAINT compute_jobs_flag_overrun CHECK (
    flag_overrun IN (0, 1)),
  retention_until TEXT,
  legal_hold INTEGER NOT NULL DEFAULT 0 CONSTRAINT compute_jobs_legal_hold CHECK (
    legal_hold IN (0, 1)),
  webhook_nonce TEXT CONSTRAINT compute_jobs_webhook_nonce CHECK (
    webhook_nonce IS NULL OR (length(webhook_nonce) = 36
      AND webhook_nonce NOT GLOB '*[^0-9a-f-]*')),
  CONSTRAINT compute_jobs_failed_iff_code CHECK ((state = 'failed') = (failure_code IS NOT NULL))
);

-- A retried request finds its job: one per account and key, and only for a job that has a key.
CREATE UNIQUE INDEX compute_jobs_idempotency ON compute_jobs (account_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- The jobs that may still end (every state of LIVE_COMPUTE_STATES, `unreported` included): a
-- person's live-job limit is a COUNT over this index inside the hold's own statement, and the poll
-- reads it. A query uses the index only if it states the same list.
CREATE INDEX compute_jobs_live ON compute_jobs (account_id, state)
  WHERE state IN ('created', 'uploading', 'submitted', 'queued', 'running', 'archiving',
                  'unreported');

-- A person's jobs, newest first.
CREATE INDEX compute_jobs_account_created ON compute_jobs (account_id, created_at);

-- ---------------------------------------------------------------------------------------------
-- compute_gateway_users
-- ---------------------------------------------------------------------------------------------
--
-- The pseudonym a person's jobs are reported to ACCESS under (design section 9): a RANDOM value that
-- NEMAR stores for each account on its first job, never rotated and never reused. It is a stored
-- random value and not a derivation from a key because a derived value would change if the key were
-- rotated, and it is deliberately not the OIDC subject, so ACCESS's unique-user counts do not depend
-- on the sign-in provider. `nemar-pipelines`, the pseudonym of NEMAR's own jobs, is a literal on the
-- job row and is not stored here.
--   * `account_id`: the account; one pseudonym each (it is the key). No foreign key, none cascades.
--   * `gateway_user`: `gw_` and 20 lowercase base32 characters (a-z, 2-7), unique.
--   * `created_at`: when, on D1's clock.
-- THE TRIGGERS, and what they do and do not cover. `compute_gateway_users_no_update` refuses every
-- UPDATE and `compute_gateway_users_no_delete` every DELETE, so a pseudonym is not changed or removed
-- by a statement that says so. `compute_gateway_users_keeps_first` ignores (RAISE IGNORE, which no
-- conflict clause overrides) an INSERT whose account or whose pseudonym is already stored: that keeps
-- `INSERT OR IGNORE` working, and it makes `INSERT OR REPLACE` and `REPLACE INTO` a no-op, which they
-- would otherwise not be: REPLACE deletes the conflicting row WITHOUT firing the DELETE trigger
-- (recursive triggers cannot be enabled on D1), so it could rewrite a pseudonym or hand one to
-- another account. NOT covered: `DROP TABLE` (it takes the triggers with it) and a rebuild of the
-- table, which must copy the rows and recreate the three triggers and the unique index. Their
-- retention, and the anonymisation of a deleted account's row, are phase A7's (#2012), which adds its
-- own narrowly scoped exception in its own migration. The job table has no trigger.

CREATE TABLE compute_gateway_users (
  account_id INT NOT NULL PRIMARY KEY CONSTRAINT compute_gateway_users_account CHECK (
    typeof(account_id) = 'integer' AND account_id >= 1),
  gateway_user TEXT NOT NULL UNIQUE CONSTRAINT compute_gateway_users_shape CHECK (
    length(gateway_user) = 23 AND substr(gateway_user, 1, 3) = 'gw_'
    AND substr(gateway_user, 4) NOT GLOB '*[^a-z2-7]*'),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TRIGGER compute_gateway_users_keeps_first BEFORE INSERT ON compute_gateway_users
WHEN EXISTS (SELECT 1 FROM compute_gateway_users
              WHERE account_id = NEW.account_id OR gateway_user = NEW.gateway_user)
BEGIN
  SELECT RAISE(IGNORE);
END;

CREATE TRIGGER compute_gateway_users_no_update BEFORE UPDATE ON compute_gateway_users
BEGIN
  SELECT RAISE(ABORT, 'compute_gateway_users is never rotated: a pseudonym is never changed');
END;

CREATE TRIGGER compute_gateway_users_no_delete BEFORE DELETE ON compute_gateway_users
BEGIN
  SELECT RAISE(ABORT, 'compute_gateway_users is never removed: a pseudonym is never reused');
END;
