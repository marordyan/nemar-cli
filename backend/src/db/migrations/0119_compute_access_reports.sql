-- The ACCESS gateway-attributes report of every Slurm job (epic #2005 phase A8, #2013; ADR 0118
-- decision 9, design section 9).
--
-- WHAT THIS IS FOR. ACCESS requires a community-account gateway to report the end user of every job:
-- the Slurm job id, the submission time, the resource name and the gateway user, which is the
-- pseudonym NEMAR stores for the account (`compute_gateway_users`, `nemar-pipelines` for its own
-- jobs). One row here per Slurm job says whether that report has been made. The row is made in the
-- SAME BATCH as the job row first showing its Slurm id (the live transition and the terminal
-- transition of services/compute-lifecycle.ts), by an `INSERT OR IGNORE`, so a replayed read of the
-- same record adds no second row and never puts a row that has moved on back to the start.
--
-- A REPORT IS NEVER SENT TWICE, and this table is how. The sender (services/access-attributes.ts)
-- takes the row with ONE conditional UPDATE (`pending` to `attempting`, which also writes the lease
-- stamp and counts the attempt) BEFORE it makes the POST, so two overlapping runs cannot both send;
-- it writes the outcome WHERE the row is still `attempting` under its own lease stamp. What it does
-- not do is retry what it cannot judge: a POST that may have been recorded (a lost connection, a
-- timeout, a sender that died holding the lease) leaves the row `failed` with `outcome_unknown` for a
-- person to look at, and is never sent again by code. A report may therefore be LOST (never doubled)
-- in that case; a refusal that ACCESS answered (a status, so nothing was recorded) is retried with
-- an exponential delay, and the row is `failed` only when the attempts run out. `sent` and `failed`
-- are final.
--
-- Columns:
--   * `job_id`: the job (`job_` and 24 lowercase hex digits), the primary key. It is NOT NULL on its
--     own line because SQLite lets a NULL into a primary key that is not declared NOT NULL.
--   * `state`: `pending` (owed, due at `next_attempt_at`), `attempting` (claimed for the length of a
--     lease), `sent`, `failed`. The words are COMPUTE_ACCESS_REPORT_STATES of shared/compute-state.ts
--     and a test compares them.
--   * `attempts`: how many times a sender claimed the row; a claim counts, whatever came of it.
--   * `next_attempt_at`: when a `pending` row is next due, on D1's clock.
--   * `claimed_at`: the lease stamp, with milliseconds, set only while `attempting`; the sender writes
--     its outcome only under its own stamp, and a stamp older than the lease is a sender that died.
--   * `last_error_code`: the fixed word of the last thing that kept the report from being made
--     (COMPUTE_ACCESS_REPORT_ERRORS), checked by SHAPE and not by a list, so a new word never
--     rebuilds the table. A `failed` row always has one.
--   * `sent_at`: when ACCESS accepted it; set if and only if `state = 'sent'`.
--   * `created_at`: when the Slurm id first showed.
--
-- NO FOREIGN KEY, and nothing cascades from a job or an account into this table (the same rule as
-- the job and ledger tables: they follow the retention schedule of design section 9, phase A7).
-- D1 JOB ROWS CARRY THE ACCOUNT ID AND FIXED WORDS ONLY, and so does this table: no column is named for
-- a person; the pseudonym is read from the job row at the moment of sending. Every CHECK is named, a
-- numeric column is checked with `typeof(...) = 'integer'`, every term is TRUE or FALSE and never NULL,
-- and every GLOB is at most 50 characters (D1 refuses longer).

CREATE TABLE compute_access_reports (
  job_id TEXT PRIMARY KEY NOT NULL CONSTRAINT compute_access_reports_job_id CHECK (
    length(job_id) = 28 AND substr(job_id, 1, 4) = 'job_' AND substr(job_id, 5) NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL DEFAULT 'pending' CONSTRAINT compute_access_reports_state CHECK (
    state IN ('pending', 'attempting', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CONSTRAINT compute_access_reports_attempts CHECK (
    typeof(attempts) = 'integer' AND attempts BETWEEN 0 AND 1000),
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  claimed_at TEXT,
  last_error_code TEXT CONSTRAINT compute_access_reports_error CHECK (
    last_error_code IS NULL OR (length(last_error_code) BETWEEN 1 AND 64
      AND last_error_code NOT GLOB '*[^a-z0-9_]*')),
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CONSTRAINT compute_access_reports_sent_iff CHECK ((state = 'sent') = (sent_at IS NOT NULL)),
  CONSTRAINT compute_access_reports_claim_iff CHECK (
    (state = 'attempting') = (claimed_at IS NOT NULL)),
  CONSTRAINT compute_access_reports_failed_says_why CHECK (
    state <> 'failed' OR last_error_code IS NOT NULL)
);

-- The rows a tick takes: the pending ones that are due, soonest first. A query uses the index only if
-- it states the same predicate.
CREATE INDEX compute_access_reports_due ON compute_access_reports (next_attempt_at)
  WHERE state = 'pending';
