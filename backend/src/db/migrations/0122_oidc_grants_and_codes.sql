-- What a person let a client do, and the one-time codes the authorization endpoint hands out
-- (epic #2014 phase #2017; ADR 0119, decisions 3, 4 and 8).
--
-- WHAT THIS IS FOR. A registered client sends a signed-in person to the authorization endpoint;
-- the person is asked (or, for a first-party client, not asked), and the client gets a single-use
-- code it trades for tokens at the token endpoint (#2018). Two facts are stored: THE GRANT (which
-- scopes this account let this client have, and whether a person said so or the client was
-- first-party) and THE CODE (sixty seconds of permission to collect tokens, bound to everything
-- the token endpoint has to check again).
--
-- `client_id` IN BOTH TABLES IS THE `oidc_clients.id` ROW ID, NOT THE PUBLIC `oc_...` STRING. The
-- name is the column's; what it holds is the integer every reader joins on (`c.id = client_id`).
-- The public identifier lives only in `oidc_clients.client_id`.
--
-- NO FOREIGN KEYS, AS IN 0121. `user_id` and the two client and grant references are bare
-- integers. A cascade from `users` would let the deletion of an account silently delete what the
-- revocation cascades (#2019) must find and end; a restricting key would make a hard delete of an
-- account fail on a row it has no reason to know about. Every reader joins the live rows it needs
-- (`users`, `oidc_clients`, `web_sessions`) and so an orphan confers nothing. Every CHECK term is
-- TRUE or FALSE, never NULL, because a CHECK passes on NULL.
--
-- oidc_grants: AT MOST ONE LIVE ROW PER ACCOUNT AND CLIENT (the partial unique index below).
--   id            the row number; a code names its grant by it.
--   user_id       the account, `users.id`.
--   client_id     the client's ROW id, `oidc_clients.id`: an integer, NOT the public `oc_...`
--                 string.
--   scopes        a JSON array of 1 to 20 scope names, sorted, with no repeat. The table checks
--                 the shape and the characters (as 0121 does for `allowed_scopes`); that each is a
--                 scope of the catalogue is the service's rule.
--   consent_kind  `user` when the person allowed the scopes on the consent screen, `first_party`
--                 when the client was first-party and nobody was asked. Only a `user` grant counts
--                 as consent: a client that stops being first-party is asked again, whatever a
--                 `first_party` grant holds.
--   created_at    UTC `datetime('now')`, when the account first granted this client anything.
--   revoked_at    NULL while the grant is live. Set by the revocation phase (#2019); a revoked
--                 row stays for the record and a new grant is a new row.
--
-- oidc_codes: ONE ROW PER AUTHORIZATION CODE.
--   id              the row number: a stable reference to one code for what the token endpoint
--                   records about it (#2018), so nothing else has to carry the hash.
--   code_hash       the SHA-256 of the code, 64 lowercase hex characters, unique: a code is looked
--                   up by it. The code itself (256 random bits) is in the redirect to the client
--                   and stored nowhere.
--   client_id       the client's ROW id, `oidc_clients.id`: an integer, NOT the public `oc_...`
--                   string.
--   user_id         the account, `users.id`.
--   grant_id        the grant the code was minted under, `oidc_grants.id`.
--   redirect_uri    the exact redirect address the code was sent to, which the token request must
--                   repeat (RFC 6749 section 4.1.3).
--   scopes          the scopes the code carries: what was asked for, never more than the grant.
--   nonce           the request's `nonce`, copied into the identity token, or NULL.
--   code_challenge  the PKCE S256 challenge, 43 base64url characters (S256 is the only method,
--                   ADR 0119 rule 1, so the method is not stored).
--   auth_time       when the person signed in: the session's own `created_at`.
--   created_at      UTC `datetime('now')`.
--   expires_at      sixty seconds after `created_at`, written by D1's clock, and never later (the
--                   CHECK below, which also refuses a `created_at` or `expires_at` that is not a
--                   time: without that, its comparison would be NULL and a CHECK passes on NULL).
--   used_at         NULL until the token endpoint redeems the code (#2018). A used row is kept
--                   until an hour past its expiry, so a second redemption is recognized as a replay
--                   and not mistaken for an unknown code. What is older is pruned in the batch of
--                   the next mint, from either authorization route.
--
-- D1 limits kept in mind: every GLOB pattern is far under the 50-character limit, no CHECK needs a
-- subquery, and a JSON function in a CHECK is guarded by `json_valid` inside a CASE, because SQLite
-- raises on malformed JSON rather than returning NULL.

CREATE TABLE oidc_grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL CHECK (typeof(user_id) = 'integer' AND user_id >= 1),
  client_id INTEGER NOT NULL CHECK (typeof(client_id) = 'integer' AND client_id >= 1),
  scopes TEXT NOT NULL CHECK (CASE WHEN json_valid(scopes)
    THEN json_type(scopes) = 'array' AND json_array_length(scopes) BETWEEN 1 AND 20
      AND scopes NOT GLOB '*[^]0-9a-z_.",[]*'
    ELSE 0 END),
  consent_kind TEXT NOT NULL CHECK (consent_kind IN ('first_party', 'user')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT
);

-- One live grant per account and client. The authorization routes upsert against exactly this
-- index (`ON CONFLICT (user_id, client_id) WHERE revoked_at IS NULL`), so two consents that race
-- end in one row, not two.
CREATE UNIQUE INDEX oidc_grants_one_live ON oidc_grants (user_id, client_id)
  WHERE revoked_at IS NULL;

CREATE TABLE oidc_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code_hash TEXT NOT NULL UNIQUE CHECK (length(code_hash) = 64
    AND code_hash NOT GLOB '*[^0-9a-f]*'),
  client_id INTEGER NOT NULL CHECK (typeof(client_id) = 'integer' AND client_id >= 1),
  user_id INTEGER NOT NULL CHECK (typeof(user_id) = 'integer' AND user_id >= 1),
  grant_id INTEGER NOT NULL CHECK (typeof(grant_id) = 'integer' AND grant_id >= 1),
  redirect_uri TEXT NOT NULL CHECK (length(redirect_uri) BETWEEN 1 AND 2000),
  scopes TEXT NOT NULL CHECK (CASE WHEN json_valid(scopes)
    THEN json_type(scopes) = 'array' AND json_array_length(scopes) BETWEEN 1 AND 20
      AND scopes NOT GLOB '*[^]0-9a-z_.",[]*'
    ELSE 0 END),
  nonce TEXT CHECK (nonce IS NULL OR length(nonce) BETWEEN 1 AND 512),
  code_challenge TEXT NOT NULL CHECK (length(code_challenge) = 43
    AND code_challenge NOT GLOB '*[^A-Za-z0-9_-]*'),
  auth_time TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  CHECK (datetime(created_at) IS NOT NULL AND datetime(expires_at) IS NOT NULL
    AND expires_at > created_at AND expires_at <= datetime(created_at, '+60 seconds'))
);

-- The prune deletes by expiry; the token endpoint reads by hash (the UNIQUE constraint's index).
CREATE INDEX oidc_codes_expires_at ON oidc_codes (expires_at);
