-- The compute gateway's allocation ledger and owner policy (epic #2005 phase A2, #2007; ADR 0118,
-- decision 3).
--
-- WHAT THIS IS FOR. NEMAR says how many Expanse service units (SU) a holder may spend and refuses a
-- spend that would exceed it, atomically. Three tables carry that:
--   * `compute_policy`: the owner's policy, one immutable row per version (the current policy is
--     the highest version, and no row means DEFAULT_COMPUTE_POLICY of shared/contract/compute.ts);
--   * `compute_pools`: one row per holder and pool (cpu, gpu) with three running totals;
--   * `compute_ledger`: the append-only entries, whose deltas the totals are the sum of.
--
-- AMOUNTS ARE WHOLE THOUSANDTHS OF AN SU (milli-SU), never floating point. Every amount column
-- refuses a value that is not an INTEGER (`typeof`) and one beyond 2^53 - 1 (9007199254740991), the
-- largest number a JavaScript double holds exactly, so a total read back in the Worker is exact. A
-- sum of two such values stays far below the 2^63 at which SQLite would turn an integer into a
-- float, so no statement here can.
--
-- THE LEDGER IS THE ONLY WRITER OF A POOL'S TOTALS. `compute_ledger_apply` (AFTER INSERT) adds an
-- entry's three deltas to `pool_id`'s row and its held and charged deltas to `budget_pool_id`'s row.
-- So a total can never disagree with the ledger, "only if the entry was inserted" holds by
-- construction (there is no second statement to forget). No code path updates `granted_milli`,
-- `held_milli` or `charged_milli`; a test reads every source file and every migration for one.
--
-- THE TABLE REFUSES WHAT THE STATEMENT REFUSES, BEFORE THE ENTRY EXISTS. A pool's CHECKs would
-- refuse a total out of range when the trigger above updates it, but a conflict clause on the OUTER
-- statement (`INSERT OR IGNORE`, `OR FAIL`, `OR REPLACE`) overrides the one that applies inside a
-- trigger, so the entry would stay and the totals would not move. The BEFORE INSERT triggers below
-- raise ABORT, which no conflict clause overrides, so the entry is refused whole under every one:
--   * `compute_ledger_totals_in_range`: no total of the pool, or of the budget it names, may leave
--     0 to 2^53 - 1 (so a refund of more than was charged, an expiry of more than was granted and a
--     total past the largest exact one are refused);
--   * `compute_ledger_hold_fits`: a hold may not take the pool's or the budget's available below 0;
--   * `compute_ledger_closes_its_hold`: a release or a charge names a hold of the same job, pool,
--     budget and held amount.
-- A hold is therefore an entry the table itself would refuse unless it fits, and the statement of
-- services/compute-ledger.ts (`HOLD_INSERT_SQL`) is the same rule, written as a WHERE so that a
-- refused hold writes nothing and raises nothing (ADR 0099; the claim of upstream-repull-dispatch.ts
-- is the precedent). A job has one hold. A hold is closed once, by a release or a charge, and the
-- unique index on `hold_ref` is what says so.
--
-- THE BUDGET RULE THE TABLE ENFORCES, AND THE ONE IT LEAVES TO CODE. Two triggers, and only these:
--   * `compute_ledger_budget_is_people`: a budget an entry names is the platform `people` pool of
--     the same cpu or gpu word as its pool, and an entry on a platform pool names none. This holds
--     for every kind, a refund and a correction of a charge included, whenever a budget is named.
--   * `compute_ledger_budget_required`: a hold, a release, a charge, an overrun and a job's
--     final-settlement adjustment on an account or partner pool MUST name that budget, because the
--     budget records what people consumed and each of them moves it.
-- A refund, and an adjustment of a charge that names no job, may name the people budget or none,
-- and the table does not say which: that is a rule of the code and not of the table. The owner
-- decided on 2026-11-04 (ADR 0118, amendment 2026-11-04, item 5: option A) that the people budget
-- records consumption only, so nothing a person or an administrator does to a person's pool credits
-- it back. services/compute-ledger.ts follows it: it writes no refund, it names NO budget for a
-- correction that lowers a charge (a person's pool falls and the budget stays), and a job's final
-- settlement is the only entry that names the budget and lowers it, because it corrects a figure
-- that was recorded as consumption. The table would take the other choice, which is why the code's
-- tests, and not a trigger, hold the rule.
--
-- WHAT THE DATABASE CANNOT PREVENT, which only a reader and the source scan guard:
--   * `INSERT OR REPLACE` and `REPLACE INTO` rewrite a conflicting row without firing the
--     append-only DELETE trigger (recursive triggers, which would fire it, cannot be enabled on
--     D1). Nothing in the source may use either on these tables; a test scans for them.
--   * `DROP TABLE` removes the append-only triggers with the table. A rebuild of `compute_ledger`
--     must COPY THE ROWS BEFORE it creates `compute_ledger_apply`, or the copy fires the trigger and
--     every total doubles; recreate every trigger and index named here afterwards.
--
-- NO FOREIGN KEY, to `users` or between these tables, and none that cascades: ledger entries are
-- never removed by a cascade from the account row (design section 5), so an account's deletion
-- leaves its pools and entries as they are. The ledger and the policy are append-only; their
-- retention, and the anonymisation of `holder_ref` and `actor_user_id`, are the job of phase A7
-- (#2012), which adds its own narrowly scoped exception in its own migration. The triggers that
-- stand where a foreign key would (the pool exists; the budget is the platform people pool of the
-- same word) are named below. Every CHECK term is TRUE or FALSE, never NULL: a CHECK passes on
-- NULL, so a term that could be NULL would let the row in. Every CHECK is named, so a test can say
-- which one refused a row.
--
-- SQLite runs BEFORE triggers ahead of the CHECKs, so an entry for a pool that does not exist is
-- refused by the trigger's message and not by a CHECK: that is why `pool_id` has no CHECK of its
-- own, and why a trigger's words, not a CHECK's, are what a refusal of a budget, a total or a
-- closing hold carries. D1 rejects SQL that bun:sqlite accepts, so every GLOB below is at most 50
-- characters.

-- ---------------------------------------------------------------------------------------------
-- compute_policy
-- ---------------------------------------------------------------------------------------------
--
--   * `version`: 1, 2, 3 ... in the order they were set; the highest is the current policy.
--   * `policy_json`: the whole policy, a JSON object of at most 64 KiB, validated by the strict
--     ComputePolicySchema before it is written (services/compute-policy.ts). The CASE is load-bearing:
--     json_type() throws on malformed JSON and SQLite does not promise left-to-right evaluation of
--     AND, so the CASE guarantees json_valid runs first (migration 0074 says the same).
--   * `set_by`: the owner's user id. No foreign key; the writer checks the account is an owner in
--     the same statement that inserts the row.
--   * `note`: why, in at most 500 characters; optional.
--   * `created_at`: when, on D1's clock.

CREATE TABLE compute_policy (
  version INTEGER PRIMARY KEY AUTOINCREMENT,
  policy_json TEXT NOT NULL CONSTRAINT compute_policy_json CHECK (
    CASE WHEN json_valid(policy_json) THEN json_type(policy_json) = 'object' ELSE 0 END
    AND length(policy_json) <= 65536),
  set_by INTEGER NOT NULL CONSTRAINT compute_policy_set_by CHECK (set_by >= 1),
  note TEXT CONSTRAINT compute_policy_note CHECK (note IS NULL OR length(note) BETWEEN 1 AND 500),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TRIGGER compute_policy_no_update BEFORE UPDATE ON compute_policy
BEGIN
  SELECT RAISE(ABORT, 'compute_policy is append-only: a version is never changed');
END;

CREATE TRIGGER compute_policy_no_delete BEFORE DELETE ON compute_policy
BEGIN
  SELECT RAISE(ABORT, 'compute_policy is append-only: a version is never removed');
END;

-- ---------------------------------------------------------------------------------------------
-- compute_pools
-- ---------------------------------------------------------------------------------------------
--
--   * `id`: the pool's number, which an entry names.
--   * `holder_kind`: `account` (a person; `holder_ref` is the user id), `platform` (NEMAR's own two
--     budgets; the keys are `pipelines` and `people`, seeded below) or `partner` (a partner client's
--     own pool; `holder_ref` is its client id).
--   * `holder_ref`: 1 to 64 characters of letters, digits and `_ . -`; an account's is a number
--     without a leading zero.
--   * `pool`: `cpu` or `gpu`; Expanse's two resources are separate ACCESS resources
--     (COMPUTE_POOLS in shared/contract/compute.ts, and a test compares the two).
--   * `granted_milli`: SU the holder may spend, in all. Only the ledger changes it.
--   * `held_milli`: SU set aside by open holds. Only the ledger changes it.
--   * `charged_milli`: SU spent. Only the ledger changes it.
--     Available is granted - held - charged and MAY BE NEGATIVE (an `overrun`, or an adjustment of
--     the grant below what is used, is a fact that already happened); a stored TOTAL never is.
--   * `frozen`: 1 while the pool may not place a hold (a suspended account). Not a total and not the
--     ledger's; an operator sets it.
--   * `created_at`, `updated_at`: on D1's clock; the trigger moves `updated_at`.
--
-- The platform pools are seeded here because a hold for a person's job checks the platform budget
-- in the same statement, and a budget that does not exist is a refusal nobody can clear.

CREATE TABLE compute_pools (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  holder_kind TEXT NOT NULL CONSTRAINT compute_pools_holder_kind CHECK (
    holder_kind IN ('account', 'platform', 'partner')),
  holder_ref TEXT NOT NULL CONSTRAINT compute_pools_holder_ref CHECK (
    length(holder_ref) BETWEEN 1 AND 64
    AND holder_ref NOT GLOB '*[^A-Za-z0-9_.-]*'
    AND (holder_kind <> 'account' OR (holder_ref NOT GLOB '*[^0-9]*' AND holder_ref GLOB '[1-9]*'))),
  pool TEXT NOT NULL CONSTRAINT compute_pools_pool CHECK (pool IN ('cpu', 'gpu')),
  granted_milli INTEGER NOT NULL DEFAULT 0 CONSTRAINT compute_pools_granted CHECK (
    typeof(granted_milli) = 'integer' AND granted_milli BETWEEN 0 AND 9007199254740991),
  held_milli INTEGER NOT NULL DEFAULT 0 CONSTRAINT compute_pools_held CHECK (
    typeof(held_milli) = 'integer' AND held_milli BETWEEN 0 AND 9007199254740991),
  charged_milli INTEGER NOT NULL DEFAULT 0 CONSTRAINT compute_pools_charged CHECK (
    typeof(charged_milli) = 'integer' AND charged_milli BETWEEN 0 AND 9007199254740991),
  frozen INTEGER NOT NULL DEFAULT 0 CONSTRAINT compute_pools_frozen CHECK (frozen IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (holder_kind, holder_ref, pool)
);

-- A pool is permanent: the ledger names it, and the ledger is never removed.
CREATE TRIGGER compute_pools_no_delete BEFORE DELETE ON compute_pools
BEGIN
  SELECT RAISE(ABORT, 'a compute pool is never deleted: the ledger names it');
END;

-- What a pool IS (its number, holder and word) never changes: an entry's budget is judged by it.
CREATE TRIGGER compute_pools_identity_fixed BEFORE UPDATE OF id, holder_kind, holder_ref, pool
  ON compute_pools
BEGIN
  SELECT RAISE(ABORT, 'a compute pool''s identity never changes');
END;

INSERT INTO compute_pools (holder_kind, holder_ref, pool) VALUES ('platform', 'pipelines', 'cpu');
INSERT INTO compute_pools (holder_kind, holder_ref, pool) VALUES ('platform', 'pipelines', 'gpu');
INSERT INTO compute_pools (holder_kind, holder_ref, pool) VALUES ('platform', 'people', 'cpu');
INSERT INTO compute_pools (holder_kind, holder_ref, pool) VALUES ('platform', 'people', 'gpu');

-- ---------------------------------------------------------------------------------------------
-- compute_ledger
-- ---------------------------------------------------------------------------------------------
--
--   * `id`: the entry's number, in the order they were written.
--   * `kind`: what the entry does to a pool, one of LEDGER_ENTRY_KINDS of shared/compute-state.ts
--     (a test compares the two). Which deltas a kind may carry is `compute_ledger_deltas`:
--     grant  granted+                       an admin, the owner or a renewal gives SU
--     hold   held+                          SU set aside before a submit
--     release held-                         a hold given back in full (a job that never started)
--     charge held <= 0, charged >= 0        a hold settled: the hold leaves `held`, what the job
--                                           used (never more than the hold) enters `charged`
--     refund charged-                       a charge returned; no code writes one (nothing is refunded
--                                           automatically), and the kind stays in this vocabulary
--     adjust exactly one of granted/charged, with no job: an admin's correction, either way
--            granted 0 and any charged, with a job: that job's FINAL SETTLEMENT (Expanse's own
--            figure), which may be of nothing, because its key `job:<id>:final` is what records
--            that the final settlement happened, once
--     overrun charged+                      use beyond the hold; available may go negative
--     expire granted-                       unused SU that lapse (a renewal)
--   * `pool_id`: the pool the entry is about; the trigger takes the three deltas into its row. No
--     CHECK here: `compute_ledger_pool_exists` refuses a pool that does not exist, and runs first.
--   * `budget_pool_id`: the platform people pool of the same word a spend on an account or partner
--     pool is also counted against; NULL on a platform pool's own entries. Only a kind that spends
--     may name one (a grant and an expiry may not, nor may an adjustment of the grant). The
--     trigger takes the held and charged deltas into its row, never granted.
--   * `granted_delta_milli`, `held_delta_milli`, `charged_delta_milli`: the change to each total,
--     whole milli-SU within +- (2^53 - 1), 0 when the kind does not move it.
--   * `job_id`: the job (`job_` and 24 lowercase hex digits, COMPUTE_JOB_ID_RE) a hold, release,
--     charge, refund or overrun is about, and the job whose final settlement an adjustment is
--     (that adjustment carries one); NULL for a grant, an expiry and an admin's adjustment. A job
--     has one hold (`compute_ledger_one_hold_per_job`). A job's charge is the sum of
--     `charged_delta_milli` by `job_id` over its charge, overrun, refund and final-settlement
--     adjustment entries.
--   * `hold_ref`: the id of the hold a release or a charge closes (required for both, and checked
--     by `compute_ledger_closes_its_hold`) and an overrun belongs to; NULL otherwise. A hold is
--     closed once (`compute_ledger_closes_once`).
--   * `reason`: a fixed word, 1 to 64 characters of lowercase letters, digits and `_`
--     (COMPUTE_WORD_RE, and a test compares the two), never free text.
--   * `actor_user_id`: the person who did it, or NULL for the Worker's own entries.
--   * `idempotency_key`: unique over the whole ledger, 1 to 128 characters of letters, digits and
--     `. _ : -`. A retry with the key of an entry that was written finds that entry.
--   * `created_at`: when, on D1's clock.

CREATE TABLE compute_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CONSTRAINT compute_ledger_kind CHECK (kind IN
    ('grant', 'hold', 'release', 'charge', 'refund', 'adjust', 'overrun', 'expire')),
  pool_id INTEGER NOT NULL,
  budget_pool_id INTEGER,
  granted_delta_milli INTEGER NOT NULL DEFAULT 0 CONSTRAINT compute_ledger_granted_int CHECK (
    typeof(granted_delta_milli) = 'integer'
    AND granted_delta_milli BETWEEN -9007199254740991 AND 9007199254740991),
  held_delta_milli INTEGER NOT NULL DEFAULT 0 CONSTRAINT compute_ledger_held_int CHECK (
    typeof(held_delta_milli) = 'integer'
    AND held_delta_milli BETWEEN -9007199254740991 AND 9007199254740991),
  charged_delta_milli INTEGER NOT NULL DEFAULT 0 CONSTRAINT compute_ledger_charged_int CHECK (
    typeof(charged_delta_milli) = 'integer'
    AND charged_delta_milli BETWEEN -9007199254740991 AND 9007199254740991),
  job_id TEXT CONSTRAINT compute_ledger_job_id CHECK (job_id IS NULL OR (
    length(job_id) = 28 AND substr(job_id, 1, 4) = 'job_'
    AND substr(job_id, 5) NOT GLOB '*[^0-9a-f]*')),
  hold_ref INTEGER CONSTRAINT compute_ledger_hold_ref CHECK (hold_ref IS NULL OR hold_ref >= 1),
  reason TEXT CONSTRAINT compute_ledger_reason CHECK (reason IS NULL OR (
    length(reason) BETWEEN 1 AND 64 AND reason NOT GLOB '*[^a-z0-9_]*')),
  actor_user_id INTEGER CONSTRAINT compute_ledger_actor CHECK (
    actor_user_id IS NULL OR actor_user_id >= 1),
  idempotency_key TEXT NOT NULL UNIQUE CONSTRAINT compute_ledger_key CHECK (
    length(idempotency_key) BETWEEN 1 AND 128 AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CONSTRAINT compute_ledger_deltas CHECK (CASE kind
    WHEN 'grant' THEN granted_delta_milli > 0 AND held_delta_milli = 0 AND charged_delta_milli = 0
    WHEN 'hold' THEN held_delta_milli > 0 AND granted_delta_milli = 0 AND charged_delta_milli = 0
    WHEN 'release' THEN held_delta_milli < 0 AND granted_delta_milli = 0 AND charged_delta_milli = 0
    WHEN 'charge' THEN held_delta_milli <= 0 AND charged_delta_milli >= 0 AND granted_delta_milli = 0
    WHEN 'refund' THEN charged_delta_milli < 0 AND granted_delta_milli = 0 AND held_delta_milli = 0
    WHEN 'adjust' THEN held_delta_milli = 0 AND CASE
      WHEN job_id IS NULL THEN (granted_delta_milli <> 0) + (charged_delta_milli <> 0) = 1
      ELSE granted_delta_milli = 0 END
    WHEN 'overrun' THEN charged_delta_milli > 0 AND granted_delta_milli = 0 AND held_delta_milli = 0
    WHEN 'expire' THEN granted_delta_milli < 0 AND held_delta_milli = 0 AND charged_delta_milli = 0
    ELSE 0 END),
  CONSTRAINT compute_ledger_job_required CHECK (
    kind NOT IN ('hold', 'release', 'charge', 'refund', 'overrun') OR job_id IS NOT NULL),
  CONSTRAINT compute_ledger_hold_ref_kinds CHECK (
    hold_ref IS NULL OR kind IN ('release', 'charge', 'overrun')),
  CONSTRAINT compute_ledger_budget_kinds CHECK (budget_pool_id IS NULL
    OR kind IN ('hold', 'release', 'charge', 'refund', 'overrun')
    OR (kind = 'adjust' AND (charged_delta_milli <> 0 OR job_id IS NOT NULL)))
);

-- A hold is closed once, by one release or one charge; the entry that finds it closed writes nothing.
CREATE UNIQUE INDEX compute_ledger_closes_once ON compute_ledger (hold_ref)
  WHERE kind IN ('release', 'charge');

-- A job has one hold, so settling a job names one hold and a retried submit cannot hold twice.
CREATE UNIQUE INDEX compute_ledger_one_hold_per_job ON compute_ledger (job_id)
  WHERE kind = 'hold';

CREATE INDEX compute_ledger_pool ON compute_ledger (pool_id, id);

CREATE INDEX compute_ledger_job ON compute_ledger (job_id, id) WHERE job_id IS NOT NULL;

CREATE TRIGGER compute_ledger_no_update BEFORE UPDATE ON compute_ledger
BEGIN
  SELECT RAISE(ABORT, 'compute_ledger is append-only: an entry is never changed');
END;

CREATE TRIGGER compute_ledger_no_delete BEFORE DELETE ON compute_ledger
BEGIN
  SELECT RAISE(ABORT, 'compute_ledger is append-only: an entry is never removed');
END;

-- Where a foreign key would stand: the pool an entry is about must exist, or its deltas would land
-- nowhere and the totals would disagree with the ledger.
CREATE TRIGGER compute_ledger_pool_exists BEFORE INSERT ON compute_ledger
WHEN NOT EXISTS (SELECT 1 FROM compute_pools WHERE id = NEW.pool_id)
BEGIN
  SELECT RAISE(ABORT, 'a ledger entry names a pool that exists');
END;

-- The budget an entry is counted against is the platform people pool of the same word as the
-- entry's pool, and an entry on a platform pool names none: a cpu job is never counted against a
-- gpu budget, a person's spend never against another person or against the pipelines' own budget,
-- and a pipelines entry never against the people.
CREATE TRIGGER compute_ledger_budget_is_people BEFORE INSERT ON compute_ledger
WHEN NEW.budget_pool_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM compute_pools b, compute_pools p
   WHERE b.id = NEW.budget_pool_id AND p.id = NEW.pool_id
     AND b.holder_kind = 'platform' AND b.holder_ref = 'people' AND b.pool = p.pool
     AND p.holder_kind <> 'platform')
BEGIN
  SELECT RAISE(ABORT, 'a ledger entry''s budget is the platform people pool of the same word as its account or partner pool, and a platform pool names none');
END;

-- The other half, for the entries that always move the budget: a hold, a release, a charge, an
-- overrun and a job's final-settlement adjustment on an account or partner pool MUST name that
-- budget, so a caller that forgot it is refused and the budget's totals cannot fall behind the
-- people's. A refund and an adjustment of a charge with no job are NOT listed: they may name the
-- budget or none, because never crediting the budget back is the code's rule (the owner's option
-- A), not the table's (the header says which).
CREATE TRIGGER compute_ledger_budget_required BEFORE INSERT ON compute_ledger
WHEN NEW.budget_pool_id IS NULL
  AND (NEW.kind IN ('hold', 'release', 'charge', 'overrun')
       OR (NEW.kind = 'adjust' AND NEW.job_id IS NOT NULL))
  AND EXISTS (SELECT 1 FROM compute_pools p WHERE p.id = NEW.pool_id AND p.holder_kind <> 'platform')
BEGIN
  SELECT RAISE(ABORT, 'a spend on an account or partner pool names the platform people budget');
END;

-- No total of the pool, or of its budget, leaves 0 to 2^53 - 1. This is the pool's own CHECK said
-- ahead of the update, as ABORT, so that no conflict clause of the outer statement keeps the entry
-- while the totals refuse it. A sum that overflows 64 bits becomes a float in SQLite and is out of
-- range too.
CREATE TRIGGER compute_ledger_totals_in_range BEFORE INSERT ON compute_ledger
WHEN EXISTS (
    SELECT 1 FROM compute_pools p WHERE p.id = NEW.pool_id
       AND (p.granted_milli + NEW.granted_delta_milli NOT BETWEEN 0 AND 9007199254740991
            OR p.held_milli + NEW.held_delta_milli NOT BETWEEN 0 AND 9007199254740991
            OR p.charged_milli + NEW.charged_delta_milli NOT BETWEEN 0 AND 9007199254740991))
  OR (NEW.budget_pool_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM compute_pools b WHERE b.id = NEW.budget_pool_id
       AND (b.held_milli + NEW.held_delta_milli NOT BETWEEN 0 AND 9007199254740991
            OR b.charged_milli + NEW.charged_delta_milli NOT BETWEEN 0 AND 9007199254740991)))
BEGIN
  SELECT RAISE(ABORT, 'a ledger entry would take a total outside 0 to 9007199254740991');
END;

-- A hold fits: neither the pool's nor the budget's available (granted - held - charged) goes below
-- 0 by it. Available may be negative for other reasons (an overrun, a grant adjusted down), and
-- then no hold fits.
CREATE TRIGGER compute_ledger_hold_fits BEFORE INSERT ON compute_ledger
WHEN NEW.kind = 'hold' AND (
    EXISTS (SELECT 1 FROM compute_pools p WHERE p.id = NEW.pool_id
              AND p.granted_milli - p.held_milli - p.charged_milli < NEW.held_delta_milli)
    OR (NEW.budget_pool_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM compute_pools b WHERE b.id = NEW.budget_pool_id
              AND b.granted_milli - b.held_milli - b.charged_milli < NEW.held_delta_milli)))
BEGIN
  SELECT RAISE(ABORT, 'a hold would take available below zero');
END;

-- A release or a charge closes the hold it names: the same job, pool and budget and the same held
-- amount (the closing entry's held delta is the hold's, negated). `IS` makes two NULL budgets (a
-- pipelines hold) equal.
CREATE TRIGGER compute_ledger_closes_its_hold BEFORE INSERT ON compute_ledger
WHEN NEW.kind IN ('release', 'charge') AND NOT EXISTS (
  SELECT 1 FROM compute_ledger h
   WHERE h.id = NEW.hold_ref AND h.kind = 'hold' AND h.job_id = NEW.job_id
     AND h.pool_id = NEW.pool_id AND h.budget_pool_id IS NEW.budget_pool_id
     AND h.held_delta_milli = -NEW.held_delta_milli)
BEGIN
  SELECT RAISE(ABORT, 'a release or a charge closes the hold it names: the same job, pool, budget and held amount');
END;

-- THE ONE WRITER OF A POOL'S TOTALS. A budget pool that is NULL matches no row.
CREATE TRIGGER compute_ledger_apply AFTER INSERT ON compute_ledger
BEGIN
  UPDATE compute_pools
     SET granted_milli = granted_milli + NEW.granted_delta_milli,
         held_milli = held_milli + NEW.held_delta_milli,
         charged_milli = charged_milli + NEW.charged_delta_milli,
         updated_at = datetime('now')
   WHERE id = NEW.pool_id;
  UPDATE compute_pools
     SET held_milli = held_milli + NEW.held_delta_milli,
         charged_milli = charged_milli + NEW.charged_delta_milli,
         updated_at = datetime('now')
   WHERE id = NEW.budget_pool_id;
END;
