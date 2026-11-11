-- Every account has an opaque, never-reused OpenID Connect subject (epic #2014 phase #2015;
-- ADR 0119, decision 5).
--
-- A subject is `nmu_` plus 32 lowercase hexadecimal characters (128 random bits). It is what a
-- client of the provider stores as the account's name, so it is fixed before any client exists:
-- it is not the row number, not the email address and not anything a person chose, and it never
-- changes. `nmu_` is a reserved username prefix (`validateUsernameFormat`), so no handle can
-- collide with one.
--
-- WHY THE COLUMN STAYS NULLABLE. SQLite cannot add a NOT NULL column without a default, and a
-- constant default would give every row the same value. The invariant is enforced instead by the
-- two triggers below and checked by the unique index: no row is ever left without a subject, no
-- subject is ever shared, and none is ever changed.
--
-- THE BACKFILL covers EVERY row, tombstones and the internal system account included. A
-- soft-deleted account keeps its row, so it keeps its subject, and a partner that stored one can
-- still be told which account it was (the tombstone mask, `USER_TOMBSTONE_MASK_SQL`, never names
-- the column). `randomblob(16)` is evaluated once per row, so no two rows share a value; the
-- unique index built after it would refuse a repeat and fail the migration loudly rather than
-- ship one (2^-128 per pair).
--
-- ORDER MATTERS. The backfill runs before the triggers exist, so the immutability trigger never
-- sees it, and the unique index is built after the backfill, so it never sees a NULL it would
-- have to treat specially (SQLite allows many NULLs in a unique index in any case).
--
-- D1 limits kept in mind: the GLOB patterns are far under the 50-character limit, and every
-- statement is a plain ALTER, UPDATE, CREATE INDEX or CREATE TRIGGER that D1 runs as written.
--
-- A later migration that REBUILDS `users` (a table rebuild, as 0026 did) must carry the column,
-- the CHECK, the index and both triggers across, or the invariant silently ends there.
--
-- TWO THINGS A READER OF THIS FILE WOULD OTHERWISE GET WRONG.
-- A restore of the database to a point before this migration, followed by a replay of it,
-- re-randomizes EVERY subject: the backfill cannot know what the rows held before, so every
-- subject a client stored in the meantime would name a different account or none. A restore has to
-- be to a point at or after this migration, or be followed by the partners being told.
-- And `INSERT ... RETURNING oidc_subject` returns NULL for a new row, because the insert trigger
-- fills the value after the row is returned: read it back with a SELECT.

ALTER TABLE users ADD COLUMN oidc_subject TEXT
  CHECK (
    oidc_subject IS NULL
    OR (
      length(oidc_subject) = 36
      AND oidc_subject GLOB 'nmu_*'
      AND substr(oidc_subject, 5) NOT GLOB '*[^0-9a-f]*'
    )
  );

UPDATE users
   SET oidc_subject = 'nmu_' || lower(hex(randomblob(16)))
 WHERE oidc_subject IS NULL;

CREATE UNIQUE INDEX idx_users_oidc_subject ON users(oidc_subject);

-- A row inserted without a subject gets one, whoever wrote it: every INSERT into `users` in the
-- code base, the seed scripts and the test fixtures name no subject, and none of them has to.
CREATE TRIGGER users_oidc_subject_fill_ai
AFTER INSERT ON users
WHEN NEW.oidc_subject IS NULL
BEGIN
  UPDATE users
     SET oidc_subject = 'nmu_' || lower(hex(randomblob(16)))
   WHERE id = NEW.id;
END;

-- A subject that is set never changes: not to another value, not to NULL. An UPDATE that names the
-- column and leaves it as it was is not a change, and an UPDATE that does not name it never fires
-- this, which is what lets the tombstone mask and every other writer of the row go on as before.
-- The first assignment (NULL to a value, the insert trigger's own UPDATE) is allowed.
CREATE TRIGGER users_oidc_subject_immutable_bu
BEFORE UPDATE OF oidc_subject ON users
WHEN OLD.oidc_subject IS NOT NULL
 AND NEW.oidc_subject IS NOT OLD.oidc_subject
BEGIN
  SELECT RAISE(ABORT, 'users.oidc_subject never changes once set (ADR 0119)');
END;
