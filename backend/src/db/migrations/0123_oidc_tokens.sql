-- The access and refresh tokens of NEMAR's OpenID Connect provider (epic #2014 phase #2018;
-- ADR 0119, decisions 4, 12, 13 and 14).
--
-- WHAT THIS IS FOR. The token endpoint trades a single-use authorization code (migration 0122) for
-- an opaque access token and, when the person granted `offline_access`, a refresh token; a refresh
-- token is traded for a new pair; a confidential client can get an access token for a machine-only
-- scope with the client credentials grant. Every token is OPAQUE: a client learns nothing from it,
-- and NEMAR answers a question about one (userinfo, introspection, a resource route) by looking its
-- row up and reading the account, the grant and the client LIVE. So ending a grant, a client or an
-- account ends its tokens at once, without waiting out a lifetime.
--
-- A TOKEN IS STORED ONLY AS ITS SHA-256. The value (`nmo_at_` or `nmo_rt_` plus 256 random bits) is
-- in the one response that issues it and nowhere else: not here, not in a log.
--
-- `client_id` IS THE `oidc_clients.id` ROW ID, NOT THE PUBLIC `oc_...` STRING, as in 0122.
--
-- NO FOREIGN KEYS, as in 0121 and 0122: every reader joins the live rows it needs (`oidc_clients`,
-- `users`, `oidc_grants`), so an orphan confers nothing, and the revocation cascades (#2019) must
-- find these rows rather than have a cascade from `users` delete them. Every CHECK term is TRUE or
-- FALSE, never NULL, because a CHECK passes on NULL.
--
-- oidc_tokens: ONE ROW PER TOKEN ISSUED.
--   id                   the row number; a child names its parent by it.
--   token_hash           the SHA-256 of the token, 64 lowercase hex characters, unique: a token is
--                        looked up by it.
--   kind                 `access` or `refresh`.
--   client_id            the client's ROW id, `oidc_clients.id`.
--   user_id              the account, `users.id`; NULL for a client credentials token, which names
--                        no account.
--   grant_id             the grant the token was issued under, `oidc_grants.id`; NULL exactly when
--                        `user_id` is.
--   code_id              the authorization code the token's family came from, `oidc_codes.id`,
--                        copied to every token of the family, so a second redemption of that code
--                        finds everything it issued; NULL exactly when `user_id` is.
--   family_id            32 lowercase hex characters, the same for every token issued from one
--                        code and its rotations, so a refresh token's reuse (or its revocation)
--                        ends the whole family, access tokens included; NULL exactly when
--                        `user_id` is.
--   parent_id            for a token issued by a refresh, the refresh token that was presented,
--                        `oidc_tokens.id`; NULL for one issued from a code or to a client. How many
--                        refresh children a parent has decides the 30-second retry (ADR 0119 rule 13).
--   audience             the client's `audience` when the token was issued, 1 to 200 characters:
--                        the resource it is bound to, and what introspection matches against a
--                        caller's `introspection_audiences`.
--   scopes               a JSON array of 1 to 20 scope names, sorted, with no repeat (the shape is
--                        checked here, the catalogue is the service's rule). An access token
--                        carries what was asked for (a refresh may narrow it); a refresh token
--                        keeps the scopes of the code its family came from.
--   created_at           UTC `datetime('now')`.
--   expires_at           an access token: 15 minutes after `created_at`. A refresh token: 30 days
--                        after it (idle), and never after `absolute_expires_at`.
--   absolute_expires_at  a refresh token only: 90 days after its FAMILY began, copied unchanged to
--                        every rotation, so no chain of refreshes outlives it. NULL for an access
--                        token.
--   used_at              a refresh token only: when it was rotated (spent). NULL until then, and
--                        always NULL for an access token.
--   revoked_at           NULL while the token is not revoked. Set with `revoked_reason`, together.
--   revoked_reason       a fixed word, never text a caller wrote: `code_replay` (its code was
--                        redeemed again), `refresh_reuse` (a spent or revoked refresh token of its
--                        family was presented), `client_revoked` (its client revoked it, RFC 7009),
--                        and the words the revocation cascades of #2019 add. Lowercase letters,
--                        digits and `_`, at most 40 characters.
--
-- KEPT FOR REUSE DETECTION, THEN PRUNED. A spent refresh token is what a reuse is detected by, so it
-- stays until a day past its family's absolute expiry; an access token stays a day past its own
-- expiry. The token endpoint prunes what is older at the head of every batch that mints.
--
-- D1 limits kept in mind: every GLOB pattern is far under the 50-character limit, no CHECK needs a
-- subquery, and a JSON function in a CHECK is guarded by `json_valid` inside a CASE, because SQLite
-- raises on malformed JSON rather than returning NULL.

CREATE TABLE oidc_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64
    AND token_hash NOT GLOB '*[^0-9a-f]*'),
  kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  client_id INTEGER NOT NULL CHECK (typeof(client_id) = 'integer' AND client_id >= 1),
  user_id INTEGER CHECK (user_id IS NULL OR (typeof(user_id) = 'integer' AND user_id >= 1)),
  grant_id INTEGER CHECK (grant_id IS NULL OR (typeof(grant_id) = 'integer' AND grant_id >= 1)),
  code_id INTEGER CHECK (code_id IS NULL OR (typeof(code_id) = 'integer' AND code_id >= 1)),
  family_id TEXT CHECK (family_id IS NULL OR (length(family_id) = 32
    AND family_id NOT GLOB '*[^0-9a-f]*')),
  parent_id INTEGER CHECK (parent_id IS NULL
    OR (typeof(parent_id) = 'integer' AND parent_id >= 1)),
  audience TEXT NOT NULL CHECK (length(audience) BETWEEN 1 AND 200),
  scopes TEXT NOT NULL CHECK (CASE WHEN json_valid(scopes)
    THEN json_type(scopes) = 'array' AND json_array_length(scopes) BETWEEN 1 AND 20
      AND scopes NOT GLOB '*[^]0-9a-z_.",[]*'
    ELSE 0 END),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  absolute_expires_at TEXT,
  used_at TEXT,
  revoked_at TEXT,
  revoked_reason TEXT CHECK (revoked_reason IS NULL OR (length(revoked_reason) BETWEEN 1 AND 40
    AND revoked_reason NOT GLOB '*[^a-z0-9_]*')),
  -- An account's token has a grant, a code and a family; a client's token has none of them.
  CHECK ((user_id IS NULL) = (grant_id IS NULL)
    AND (user_id IS NULL) = (code_id IS NULL)
    AND (user_id IS NULL) = (family_id IS NULL)),
  -- Revoked means a time and a reason, together.
  CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL)),
  -- Every time is in the form `datetime()` writes (`YYYY-MM-DD HH:MM:SS`), so comparing two of them
  -- as text compares them as times. `IS` and not `=`, so a value that does not parse is FALSE.
  CHECK (datetime(created_at) IS created_at AND datetime(expires_at) IS expires_at
    AND expires_at > created_at),
  CHECK (absolute_expires_at IS NULL OR datetime(absolute_expires_at) IS absolute_expires_at),
  CHECK (used_at IS NULL OR datetime(used_at) IS used_at),
  CHECK (revoked_at IS NULL OR datetime(revoked_at) IS revoked_at),
  -- Each kind lives no longer than its rule.
  CHECK (CASE kind
    WHEN 'access' THEN absolute_expires_at IS NULL AND used_at IS NULL
      AND expires_at <= datetime(created_at, '+900 seconds')
    ELSE user_id IS NOT NULL AND absolute_expires_at IS NOT NULL
      AND expires_at <= absolute_expires_at
      AND expires_at <= datetime(created_at, '+30 days')
      AND absolute_expires_at <= datetime(created_at, '+90 days')
    END)
);

-- A family is revoked as one; a code's replay finds what it issued; the cascades (#2019) find an
-- account's tokens; a parent's children decide the retry. The prune deletes by expiry, and runs at
-- the head of every batch that mints, so each of its two branches reads an index that holds only
-- its own kind: the access branch's index is PARTIAL on `kind = 'access'`, because one over every
-- row would make each prune walk every retained refresh row (a test pins the definition).
CREATE INDEX oidc_tokens_family ON oidc_tokens (family_id) WHERE family_id IS NOT NULL;
CREATE INDEX oidc_tokens_user ON oidc_tokens (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX oidc_tokens_code ON oidc_tokens (code_id) WHERE code_id IS NOT NULL;
CREATE INDEX oidc_tokens_parent ON oidc_tokens (parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX oidc_tokens_expires_at ON oidc_tokens (expires_at) WHERE kind = 'access';
CREATE INDEX oidc_tokens_absolute_expires_at ON oidc_tokens (absolute_expires_at)
  WHERE absolute_expires_at IS NOT NULL;
