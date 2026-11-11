-- The one change the compute ledger allows to an existing row: anonymizing a deleted account's
-- identifiers (epic #2005 phase A7, #2012; ADR 0118, amendment of 2026-11-04 on retention).
--
-- Numbered 0130 because 0114 to 0119 (this epic's reserved range) are used and 0120 to 0124 belong to
-- the OIDC provider. The third-party compute epic's range starts at 0131, above this one, so no
-- migration is numbered below an applied higher one.
--
-- WHY. Design sections 5 and 9 say a deleted account's records are reduced to anonymous usage counts at
-- the end of the retention period. The ledger and the pools are append-only, and the triggers of
-- migration 0114 abort every UPDATE. This migration replaces the two that stand in the way with the
-- same trigger plus a narrow exception, and removes nothing else:
--
--   * a POOL of a deleted account may have its `holder_ref` replaced by an anonymous token, and
--     nothing else about it may change: `compute_pools_identity_fixed` still aborts any change of the
--     id, the holder kind or the word, and now also aborts a change of a total or of `frozen` made in
--     the same statement. The token is `9` followed by the pool's own id padded to 15 digits (for
--     example `9000000000000042`): it is derived from the pool and not from the account, so it
--     identifies nobody, it is unique per pool (the table's UNIQUE key still holds), it passes the
--     account kind's shape check (digits, no leading zero) and no real account number is that large.
--     A pool with an open hold (`held_milli` above 0) is refused: its account is not finished.
--   * a LEDGER ENTRY whose `actor_user_id` is a deleted account may have the actor replaced by the
--     anonymous actor `9007199254740991` (2^53 - 1, no account has that number), and nothing else
--     about it may change: every other column must be equal, so an amount, a kind, a pool, a job, a
--     hold reference, a reason, a key and a time cannot be touched. An open hold's own entry is
--     refused until the hold is closed. `compute_ledger_no_delete` is NOT replaced: no row is ever
--     removed.
--
-- Every term of both conditions is TRUE or FALSE, never NULL (a NULL term would make NOT(...) NULL and the
-- trigger would not fire), which is why a nullable column is compared with IS.
--
-- THE TOTALS INVARIANT (a pool's totals equal the sums of the ledger's deltas) therefore holds by
-- construction: the exception cannot change a delta, a total, a kind or a hold, and removes no row,
-- so every sum is what it was. `compute_ledger_apply` is the one writer of a total and fires on
-- INSERT only; the anonymizing UPDATE neither fires it nor moves a total. A test sums every pool
-- before and after.
--
-- WHAT IS NOT CHANGED. An administrator's idempotency key embeds the actor's number
-- (`grant:<actor>:<key>`); rewriting a key would change the identity a replay is judged by, and the
-- number is a pseudonymous internal one that the audit log also holds, so the key is kept. Account
-- deletion itself still never cascades into the ledger (design section 5).

DROP TRIGGER compute_pools_identity_fixed;

CREATE TRIGGER compute_pools_identity_fixed BEFORE UPDATE OF id, holder_kind, holder_ref, pool
  ON compute_pools
WHEN NOT (
  NEW.id = OLD.id AND NEW.holder_kind = OLD.holder_kind AND NEW.pool = OLD.pool
  AND OLD.holder_kind = 'account'
  AND NEW.holder_ref = '9' || printf('%015d', OLD.id)
  AND OLD.holder_ref <> NEW.holder_ref
  AND NEW.granted_milli = OLD.granted_milli AND NEW.held_milli = OLD.held_milli
  AND NEW.charged_milli = OLD.charged_milli AND NEW.frozen = OLD.frozen
  AND NEW.created_at = OLD.created_at AND NEW.updated_at = OLD.updated_at
  AND OLD.held_milli = 0
  AND EXISTS (SELECT 1 FROM users u
               WHERE u.id = CAST(OLD.holder_ref AS INTEGER) AND u.deleted_at IS NOT NULL))
BEGIN
  SELECT RAISE(ABORT, 'a compute pool''s identity never changes, except a deleted account''s holder_ref, anonymized');
END;

DROP TRIGGER compute_ledger_no_update;

CREATE TRIGGER compute_ledger_no_update BEFORE UPDATE ON compute_ledger
WHEN NOT (
  NEW.id = OLD.id AND NEW.kind = OLD.kind AND NEW.pool_id = OLD.pool_id
  AND NEW.budget_pool_id IS OLD.budget_pool_id
  AND NEW.granted_delta_milli = OLD.granted_delta_milli
  AND NEW.held_delta_milli = OLD.held_delta_milli
  AND NEW.charged_delta_milli = OLD.charged_delta_milli
  AND NEW.job_id IS OLD.job_id AND NEW.hold_ref IS OLD.hold_ref AND NEW.reason IS OLD.reason
  AND NEW.idempotency_key = OLD.idempotency_key AND NEW.created_at = OLD.created_at
  AND OLD.actor_user_id IS NOT NULL AND OLD.actor_user_id <> 9007199254740991
  AND NEW.actor_user_id IS 9007199254740991
  AND EXISTS (SELECT 1 FROM users u WHERE u.id = OLD.actor_user_id AND u.deleted_at IS NOT NULL)
  AND (OLD.kind <> 'hold' OR EXISTS (SELECT 1 FROM compute_ledger c
                                      WHERE c.hold_ref = OLD.id AND c.kind IN ('release', 'charge'))))
BEGIN
  SELECT RAISE(ABORT, 'compute_ledger is append-only: an entry is never changed, except a deleted account''s actor, anonymized');
END;

-- The retention sweep finds a deleted account's ledger entries by the actor, so the actor needs an index
-- (the ledger grows for as long as the program runs, and the daily sweep must not scan it).
CREATE INDEX compute_ledger_actor ON compute_ledger (actor_user_id) WHERE actor_user_id IS NOT NULL;
