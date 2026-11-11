-- The job lifecycle's columns (epic #2005 phase A5, #2010; ADR 0118 and its amendments of 2026-11-04).
--
-- WHAT THIS IS FOR. Phase A3's `compute_jobs` row says what a job IS (who, what was asked for, what
-- is held). Phase A5 moves it: NEMAR submits it to Tapis, follows it by webhook hint and a 30-minute
-- backstop, settles its charge, serves the launcher's three job callbacks, verifies the upload,
-- copies the launcher's files into the records and mails the person a link to a page. Six columns
-- record what those steps did, so each can be told "done" without reading a bucket:
--   * `launch_spec_digest`: the SHA-256, 64 lowercase hex digits, of the EXACT bytes of the launch
--     specification's JSON TEXT (ASCII-only JSON, which carries the per-job token), which is what the
--     `NEMAR_LAUNCH_SPEC` value the Worker put in the Tapis submit request decodes to: that value is the
--     text in base64url, and the digest is never over it (contract follow-up A1c, #2043). NULL until
--     submit. It is the launcher's digest (the launcher decodes the value and hashes the text before it
--     parses it, and writes it to `launcher/provenance.json`),
--     NOT the job row's `spec_digest`, which is the digest of `records/<id>/spec.json`: two digests,
--     named apart. The result verification compares them; a launcher that ran another specification
--     fails the job. The text of the specification itself is never stored.
--   * `results_verified_at`: when the Worker verified the upload (the manifest, the provenance, every
--     declared output present with its exact size) and let a Tapis `FINISHED` stand as `finished`.
--   * `outputs_completed_at`: when the launcher's `complete` call found every declared object in the
--     results bucket. NULL on a `FINISHED` job means the launcher never completed: `result_upload_failed`.
--   * `results_bytes`: the bytes the job DECLARED to the outputs route (outputs and the four launcher
--     files), claimed in one conditional UPDATE against the person's share and the platform's total of
--     the results budget. NULL until claimed. It counts toward both budgets until the job's results
--     have expired (the job ended longer ago than the policy's results retention).
--   * `result_records_at`: when the launcher's files and the logs were copied into the records bucket.
--     NULL for a terminal job means the copy is still owed; the 30-minute tick retries it.
--   * `platform_failure`: 1 when `isPlatformFailure(failure_code, failure_detail)` says NEMAR, the node,
--     the runtime or the contract caused the failure. AN INFORMATION FLAG ONLY (the owner's decision of
--     2026-11-04): no failure is refunded automatically, consumed service units stay consumed, and an
--     administrator compensates a NEMAR-caused failure by a manual grant. Nothing writes the ledger
--     from this column.
--
-- Three columns keep the lifecycle honest under concurrency and under failure:
--   * `examined_at`: the last time the 30-minute tick EXAMINED the row, successfully or not. The tick's
--     rotation orders by it, so a row Tapis cannot be read for, or that cannot be submitted, goes to the
--     back of the line like any other and never holds a slot for good (`tapis_synced_at` moves only on a
--     good read, and ordering by it let unreadable rows starve a healthy job).
--   * `submit_claimed_at`: the submitter's lease, taken in one conditional UPDATE before the tag search.
--     A submitter proceeds to Tapis only if it changed the row, so two submitters cannot both reach
--     Tapis; a lease older than five minutes (a submitter that died) may be taken again, and an attempt
--     releases its lease when it ends.
--   * `orphan_tapis_uuid`: a Tapis job NEMAR made that no row owns (the row ended while Tapis was
--     creating it, or is bound to another Tapis job). Its uuid is recorded before it is cancelled and
--     cleared when the cancel is known to have worked, so a cancel that failed is retried by the next
--     tick and never silently forgotten.
--
-- `failure_detail` and `webhook_nonce` already exist (0115): the detail is the launcher's fixed word
-- (or the result refusal the outputs route recorded, or the reason a result verification failed),
-- checked by shape, and the nonce is the secret half of both per-job tokens, cleared one day after the
-- job is terminal.
--
-- CHECKS are named, pass on NULL where the column may be NULL, and a numeric column is checked with
-- `typeof(...) = 'integer'`. Every GLOB is at most 50 characters (D1 refuses longer). No column here is
-- named for a person.
--
-- The first index serves the two sums the outputs route's claim reads (a person's rows, and every row), and
-- nothing else: a query uses it only if it says `results_bytes IS NOT NULL`.

ALTER TABLE compute_jobs ADD COLUMN launch_spec_digest TEXT
  CONSTRAINT compute_jobs_launch_spec_digest CHECK (
    launch_spec_digest IS NULL OR (length(launch_spec_digest) = 64
      AND launch_spec_digest NOT GLOB '*[^0-9a-f]*'));

ALTER TABLE compute_jobs ADD COLUMN results_verified_at TEXT;

ALTER TABLE compute_jobs ADD COLUMN outputs_completed_at TEXT;

ALTER TABLE compute_jobs ADD COLUMN results_bytes INTEGER
  CONSTRAINT compute_jobs_results_bytes CHECK (
    results_bytes IS NULL OR (typeof(results_bytes) = 'integer'
      AND results_bytes BETWEEN 0 AND 9007199254740991));

ALTER TABLE compute_jobs ADD COLUMN result_records_at TEXT;

ALTER TABLE compute_jobs ADD COLUMN platform_failure INTEGER NOT NULL DEFAULT 0
  CONSTRAINT compute_jobs_platform_failure CHECK (platform_failure IN (0, 1));

ALTER TABLE compute_jobs ADD COLUMN examined_at TEXT;

ALTER TABLE compute_jobs ADD COLUMN submit_claimed_at TEXT;

ALTER TABLE compute_jobs ADD COLUMN orphan_tapis_uuid TEXT
  CONSTRAINT compute_jobs_orphan_tapis_uuid CHECK (
    orphan_tapis_uuid IS NULL OR (length(orphan_tapis_uuid) BETWEEN 1 AND 64
      AND orphan_tapis_uuid NOT GLOB '*[^A-Za-z0-9-]*'));

CREATE INDEX compute_jobs_results ON compute_jobs (account_id, ended_at)
  WHERE results_bytes IS NOT NULL;

-- The tick's rotation: the live rows, least recently examined first.
CREATE INDEX compute_jobs_examined ON compute_jobs (examined_at)
  WHERE state IN ('created', 'uploading', 'submitted', 'queued', 'running', 'archiving',
                  'unreported');
