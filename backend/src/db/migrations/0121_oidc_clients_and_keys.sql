-- The client registry and the signing keys of NEMAR's OpenID Connect provider (epic #2014 phase
-- #2016; ADR 0119, decisions 2, 4 and 8).
--
-- WHAT THIS IS FOR. A partner-run site, and any later service, signs people in with their NEMAR
-- account. Two facts have to be stored before any sign-in exists: WHO MAY ASK (a client the owner
-- registered, with the rules it was registered under) and WHAT NEMAR SIGNS WITH (the keys behind
-- the identity token's signature, published as a key set so a client can verify it). Nothing in
-- this migration signs anyone in; it holds the registry and the keys, and the owner routes and the
-- command line manage them.
--
-- THE TWO TABLES CARRY NO FOREIGN KEY. `created_by` names the owner who registered a client, as a
-- bare integer, because a cascade from `users` would let the deletion of an account silently
-- delete a client that other sites depend on (the soft delete keeps the row, but nothing here
-- should depend on that). Every CHECK term is TRUE or FALSE, never NULL: a CHECK passes on NULL, so
-- a term that could be NULL would let the row in.
--
-- oidc_clients: ONE ROW PER REGISTERED CLIENT.
--   id                          the row number, for ordering only; no one outside the table
--                               reads it, and a client is named by `client_id`.
--   client_id                   `oc_` plus 24 lowercase hexadecimal characters (96 random bits).
--                               Public, unique, never reused (a row is disabled, never deleted).
--   name                        what the consent screen and the owner's listing call the client,
--                               1 to 100 characters. Unique among ACTIVE clients, ignoring case
--                               (the partial index below), so a retried registration that did reach
--                               the server is refused and not registered a second time with a
--                               secret nobody holds; a disabled client frees its name.
--   secret_hash                 the SHA-256 of the client secret, 64 lowercase hex characters. The
--                               secret itself is shown once, in the response that creates or
--                               rotates it, and is stored nowhere.
--   previous_secret_hash        after a rotation, the hash of the secret that was replaced, so a
--   previous_secret_expires_at  client that has not yet been given the new one keeps working
--                               until the grace ends. Set together or not at all (CHECK), and
--                               NULL when there is no grace. The expiry is a UTC `datetime('now')`
--                               string, as every timestamp of this schema.
--   redirect_uris               a JSON array of 1 to 10 exact addresses; matched as strings at
--                               authorization, never by pattern. The service refuses wildcards,
--                               fragments, user information and plain http (a loopback address
--                               outside production excepted); the table keeps the shape.
--   allowed_scopes              a JSON array of 1 to 20 scope names. The table checks the shape and
--                               that nothing but lowercase letters, digits, `_` and `.` is in it;
--                               that each is a scope of the catalogue is the service's rule
--                               (`shared/oidc.ts`), so a new scope needs no migration while the
--                               catalogue stays within 20 (`OIDC_MAX_ALLOWED_SCOPES`, and a test
--                               holds the catalogue to it).
--   allowed_grants              a JSON array: 1 to 3 of `authorization_code`, `refresh_token` and
--                               `client_credentials`, checked here because the set is closed by the
--                               ADR (no implicit grant, no password grant).
--   sign_in_rule                `active_account` or `person_proven_orcid` (ADR 0119 rule 7).
--   first_party                 1 when the owner marked the client first-party, which skips the
--                               consent screen. Never 1 for a client with a partner-host redirect
--                               address or any redirect address that is not a NEMAR web origin; the
--                               service refuses that at registration and again at every
--                               authorization (ADR 0119 rule 8), which a CHECK cannot (it would
--                               need the partner list).
--   consent_mode                `ask_once` (once per set of scopes) or `always`.
--   backchannel_logout_uri      NULL, or an https address NEMAR tells when an account is revoked,
--                               deleted or suspended from compute.
--   audience                    the resource an access token issued to the client is bound to, 1
--                               to 200 characters.
--   introspection_audiences     a JSON array of at most 10 audiences whose resource servers may
--                               introspect this client's tokens; `[]` for none.
--   cap_open_reservations       NULL, or a non-negative integer: the client's cap on open
--   cap_su_per_day              reservations and on service units reserved per day. Declared here
--                               and enforced by the compute program, which is why they are
--                               nullable: NULL means the client has none yet, never zero.
--   status                      `active`, or `disabled` once the owner cut the client off.
--   disabled_at                 set exactly when `status` is `disabled` (CHECK).
--   created_by                  the owner's user id, a bare integer (see above).
--   created_at, updated_at      UTC `datetime('now')` strings.
--
-- oidc_signing_keys: ONE ROW PER KEY, EVER (a retired key's row stays for the audit trail).
--   kid                     16 lowercase hex characters (64 random bits): the `kid` header of every
--                           token the key signs, and the primary key. NOT NULL, because a SQLite
--                           primary key that is not an INTEGER accepts NULL otherwise.
--   alg                     `ES256` (ECDSA over P-256 with SHA-256), the only algorithm.
--   state                   `next` (published, not yet signing: a client has time to fetch it
--                           before it is used), `current` (signs), `retired` (published a while
--                           longer so a token signed just before the rotation still verifies), or
--                           `revoked` (a retired key the owner withdrew: never published, so it can
--                           verify nothing). Only a retired key is ever revoked. The state is here
--                           from the first release because a CHECK cannot be changed in place: a new
--                           state would be a rebuild of the table.
--   public_jwk              the public half as a JSON object (kty, crv, x, y, kid, use, alg), the
--                           member of the published key set.
--   private_jwk_encrypted   the private half as a JSON Web Key, encrypted with AES-GCM under the
--                           `OIDC_SECRET` binding (`services/encryption.ts`). Never returned by any
--                           route and never logged. NULL only for a `retired` or `revoked` key, so
--                           the private half of a key that no longer signs can be wiped later
--                           without a migration; a `next` or `current` key always has one.
--   created_at              when the key was made and, for a `next` key, when it was first
--                           published: a `next` key becomes `current` only once it is 24 hours
--                           old, unless the owner forces it.
--   promoted_at             when the key became `current`. NULL exactly while it is `next` (CHECK).
--   retired_at              when the key stopped signing. Set exactly when `state` is `retired` or
--                           `revoked` (CHECK); a retired key is published for 7 days after it, and
--                           at most 5 retired keys are published.
--   revoked_at              when the owner revoked the key. Set exactly when `state` is `revoked`.
--
-- ONE `next` AND ONE `current`, ANY NUMBER `retired`: the two partial unique indexes below. They
-- are the guard against two rotations racing: the second one's insert of a new `next` key (or of a
-- first `current` key) breaks the index, and the whole batch that carried it is refused. A
-- promotion needs the old `current` retired first, which is the order rotation uses.
--
-- D1 limits kept in mind: every GLOB pattern is far under the 50-character limit, no CHECK needs a
-- subquery (D1 refuses one), and nothing here compounds more than a few terms. A JSON function in
-- a CHECK is guarded by `json_valid` inside a CASE, because SQLite raises on malformed JSON rather
-- than returning NULL.

CREATE TABLE oidc_clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL UNIQUE CHECK (length(client_id) = 27 AND client_id GLOB 'oc_*'
    AND substr(client_id, 4) NOT GLOB '*[^0-9a-f]*'),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  secret_hash TEXT NOT NULL CHECK (length(secret_hash) = 64 AND secret_hash NOT GLOB '*[^0-9a-f]*'),
  previous_secret_hash TEXT CHECK (previous_secret_hash IS NULL
    OR (length(previous_secret_hash) = 64 AND previous_secret_hash NOT GLOB '*[^0-9a-f]*')),
  previous_secret_expires_at TEXT,
  redirect_uris TEXT NOT NULL CHECK (CASE WHEN json_valid(redirect_uris)
    THEN json_type(redirect_uris) = 'array' AND json_array_length(redirect_uris) BETWEEN 1 AND 10
    ELSE 0 END),
  allowed_scopes TEXT NOT NULL CHECK (CASE WHEN json_valid(allowed_scopes)
    THEN json_type(allowed_scopes) = 'array' AND json_array_length(allowed_scopes) BETWEEN 1 AND 20
      AND allowed_scopes NOT GLOB '*[^]0-9a-z_.",[]*'
    ELSE 0 END),
  allowed_grants TEXT NOT NULL CHECK (CASE WHEN json_valid(allowed_grants)
    THEN json_type(allowed_grants) = 'array' AND json_array_length(allowed_grants) BETWEEN 1 AND 3
      AND coalesce(json_extract(allowed_grants, '$[0]')
        IN ('authorization_code', 'refresh_token', 'client_credentials'), 0)
      AND coalesce(json_extract(allowed_grants, '$[1]')
        IN ('authorization_code', 'refresh_token', 'client_credentials'),
        json_array_length(allowed_grants) < 2)
      AND coalesce(json_extract(allowed_grants, '$[2]')
        IN ('authorization_code', 'refresh_token', 'client_credentials'),
        json_array_length(allowed_grants) < 3)
    ELSE 0 END),
  sign_in_rule TEXT NOT NULL CHECK (sign_in_rule IN ('active_account', 'person_proven_orcid')),
  first_party INTEGER NOT NULL CHECK (first_party IN (0, 1)),
  consent_mode TEXT NOT NULL CHECK (consent_mode IN ('ask_once', 'always')),
  backchannel_logout_uri TEXT CHECK (backchannel_logout_uri IS NULL
    OR (substr(backchannel_logout_uri, 1, 8) = 'https://'
      AND length(backchannel_logout_uri) BETWEEN 9 AND 2000)),
  audience TEXT NOT NULL CHECK (length(audience) BETWEEN 1 AND 200),
  introspection_audiences TEXT NOT NULL DEFAULT '[]' CHECK (CASE WHEN json_valid(introspection_audiences)
    THEN json_type(introspection_audiences) = 'array' AND json_array_length(introspection_audiences) <= 10
    ELSE 0 END),
  cap_open_reservations INTEGER CHECK (cap_open_reservations IS NULL
    OR (typeof(cap_open_reservations) = 'integer' AND cap_open_reservations >= 0)),
  cap_su_per_day INTEGER CHECK (cap_su_per_day IS NULL
    OR (typeof(cap_su_per_day) = 'integer' AND cap_su_per_day >= 0)),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  disabled_at TEXT,
  created_by INTEGER NOT NULL CHECK (created_by >= 1),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((previous_secret_hash IS NULL) = (previous_secret_expires_at IS NULL)),
  CHECK ((status = 'disabled') = (disabled_at IS NOT NULL))
);

-- Two ACTIVE clients may not share a name, in any case; a disabled client does not hold one.
CREATE UNIQUE INDEX oidc_clients_active_name ON oidc_clients (name COLLATE NOCASE)
  WHERE status = 'active';

CREATE TABLE oidc_signing_keys (
  kid TEXT NOT NULL PRIMARY KEY CHECK (length(kid) = 16 AND kid NOT GLOB '*[^0-9a-f]*'),
  alg TEXT NOT NULL CHECK (alg = 'ES256'),
  state TEXT NOT NULL CHECK (state IN ('next', 'current', 'retired', 'revoked')),
  public_jwk TEXT NOT NULL CHECK (CASE WHEN json_valid(public_jwk)
    THEN json_type(public_jwk) = 'object' ELSE 0 END),
  private_jwk_encrypted TEXT CHECK (CASE WHEN private_jwk_encrypted IS NULL
    THEN state IN ('retired', 'revoked') ELSE length(private_jwk_encrypted) >= 1 END),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  promoted_at TEXT,
  retired_at TEXT,
  revoked_at TEXT,
  CHECK ((state = 'next') = (promoted_at IS NULL)),
  CHECK ((state IN ('retired', 'revoked')) = (retired_at IS NOT NULL)),
  CHECK ((state = 'revoked') = (revoked_at IS NOT NULL))
);

CREATE UNIQUE INDEX oidc_signing_keys_one_next ON oidc_signing_keys (state) WHERE state = 'next';

CREATE UNIQUE INDEX oidc_signing_keys_one_current ON oidc_signing_keys (state)
  WHERE state = 'current';
