-- The back-channel logout deliveries of NEMAR's OpenID Connect provider (epic #2014 phase #2019;
-- ADR 0119, decisions 12 and 15).
--
-- WHAT THIS IS FOR. When a path ends an account's grants (revocation, deletion, a merge, an ORCID
-- change, a compute suspension), each client that registered a back-channel logout address has to be
-- TOLD, or its own session for the person lives on after NEMAR stopped honouring it. The telling is a
-- request to a partner's server, and a request to somebody else's server never belongs inside the
-- database batch that ends the grants: the batch must commit whatever the partner does. So the batch
-- writes only the INTENT, one row here per client, and a sender does the call afterwards (the first
-- attempt right after the commit, the retries from a tick). A row is the record that a client was owed
-- a logout and what became of it; it is never the reason a revocation did or did not happen.
--
-- `client_id` IS THE `oidc_clients.id` ROW ID, NOT THE PUBLIC `oc_...` STRING, as in 0122 and 0123.
-- The sender joins the client it needs, which is also how it sees a client that was disabled since.
--
-- NO FOREIGN KEYS, as in 0121 to 0123. A row outlives the client and the account it names; the sender
-- reads the client live and records `client_disabled` for one that is no longer active, and `sub` is
-- the account's opaque `users.oidc_subject`, which the tombstone keeps, so a deleted account is still
-- named by the same value its partner knew it by. Every CHECK term is TRUE or FALSE, never NULL,
-- because a CHECK passes on NULL.
--
-- oidc_logout_deliveries: ONE ROW PER CLIENT TOLD ABOUT ONE ENDING.
--   id                 the row number.
--   client_id          the client's ROW id, `oidc_clients.id`: an integer, NOT the public string.
--   sub                the account's `users.oidc_subject` when the row was queued: `nmu_` plus 32
--                      lowercase hexadecimal characters. It is the logout token's `sub`.
--   reason             why the grants ended: a fixed word, `OIDC_END_REASONS` in `shared/oidc.ts`
--                      (the list below is that list, and a test holds the two equal as sets). It is NOT
--                      sent to the partner: a logout token carries no reason.
--   status             `pending` (to be attempted, or retried), `sent` (the partner answered 200 or
--                      204), `failed` (refused by the partner with a 4xx other than 408 and 429, or
--                      every attempt used),
--                      `fenced` (outside production, an address that is neither loopback nor listed:
--                      recorded and never sent). A row that is not `pending` is never attempted again.
--   attempts           how many attempts were claimed, 0 to 6: the first and at most five retries.
--   next_attempt_at    UTC `datetime('now')` form. Set exactly while the row is `pending` (CHECK): the
--                      earliest time of its next attempt, and, while an attempt is in flight, the end
--                      of that attempt's claim. NULL once the row is terminal.
--   last_status        the HTTP status of the last attempt that got an answer, else NULL.
--   last_error_class   a fixed word for what went wrong on the last attempt (`timeout`, `network`,
--                      `redirect`, `http_4xx`, `http_5xx`, `http_throttled`, ...: the closed list
--                      below, which is `OIDC_LOGOUT_ERROR_CLASSES` in `shared/oidc.ts` and which a test
--                      holds equal as a SET), NEVER the text of an error or of the partner's answer.
--   jti                the `jti` of the logout token the LAST attempt sent: 32 lowercase hexadecimal
--                      characters, unique, so a partner's complaint can be matched to a row. A token
--                      is made per attempt, so a retry is a new token and not a replay of the old.
--   created_at         UTC `datetime('now')`: when the ending was committed.
--   sent_at            set exactly when `status` is `sent` (CHECK).
--
-- D1 limits kept in mind: every GLOB pattern is far under the 50-character limit, no CHECK needs a
-- subquery, and nothing here compounds more than a few terms.

CREATE TABLE oidc_logout_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL CHECK (typeof(client_id) = 'integer' AND client_id >= 1),
  sub TEXT NOT NULL CHECK (length(sub) = 36 AND sub GLOB 'nmu_*'
    AND substr(sub, 5) NOT GLOB '*[^0-9a-f]*'),
  reason TEXT NOT NULL CHECK (reason IN ('account_revoked', 'account_deleted', 'account_merged',
    'compute_suspended', 'orcid_changed', 'kind_changed')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'fenced')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (typeof(attempts) = 'integer'
    AND attempts BETWEEN 0 AND 6),
  next_attempt_at TEXT,
  last_status INTEGER CHECK (last_status IS NULL
    OR (typeof(last_status) = 'integer' AND last_status BETWEEN 100 AND 599)),
  last_error_class TEXT CHECK (last_error_class IS NULL OR last_error_class IN ('timeout', 'network',
    'redirect', 'http_4xx', 'http_5xx', 'http_throttled', 'http_other', 'sign_failed',
    'address_refused', 'client_disabled', 'fenced', 'unreported')),
  jti TEXT CHECK (jti IS NULL OR (length(jti) = 32 AND jti NOT GLOB '*[^0-9a-f]*')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT,
  -- A pending row has a time to be attempted at, and a terminal row has none: the tick can read
  -- "due" from the index alone, and a finished row is never picked up again.
  CHECK ((status = 'pending') = (next_attempt_at IS NOT NULL)),
  CHECK ((status = 'sent') = (sent_at IS NOT NULL)),
  -- Every time is in the form `datetime()` writes, so comparing two as text compares them as times.
  -- `IS` and not `=`, so a value that does not parse is FALSE.
  CHECK (datetime(created_at) IS created_at),
  CHECK (next_attempt_at IS NULL OR datetime(next_attempt_at) IS next_attempt_at),
  CHECK (sent_at IS NULL OR datetime(sent_at) IS sent_at)
);

-- The retry tick reads the pending rows that are due, oldest first; the first attempt after a commit
-- reads the pending rows of one subject. Both indexes hold only pending rows, which is a handful at
-- any time, so the table can grow with the number of endings and these never do.
CREATE INDEX oidc_logout_deliveries_due ON oidc_logout_deliveries (next_attempt_at, id)
  WHERE status = 'pending';
CREATE INDEX oidc_logout_deliveries_sub ON oidc_logout_deliveries (sub)
  WHERE status = 'pending';
-- The owner's view lists by status, newest first.
CREATE INDEX oidc_logout_deliveries_status ON oidc_logout_deliveries (status, id);
-- One token, one row.
CREATE UNIQUE INDEX oidc_logout_deliveries_jti ON oidc_logout_deliveries (jti)
  WHERE jti IS NOT NULL;
