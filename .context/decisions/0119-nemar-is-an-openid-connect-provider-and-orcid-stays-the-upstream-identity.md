# ADR 0119: NEMAR is an OpenID Connect provider, and ORCID stays the upstream identity

**Status:** proposed
**Date:** 2026-11-03
**Owner:** Seyed Yahya Shirazi

Epic #2014, phase #2015.
Follows [ADR 0056](0056-the-admin-docs-are-gated-by-nemars-own-session.md) and [ADR 0079](0079-the-private-site-holds-a-session-scope-of-its-own.md) (a host-scoped credential is handed over, never a widened cookie), [ADR 0043](0043-one-person-one-account.md) (one person, one account), [ADR 0048](0048-account-kinds-are-explicit.md) (account kinds) and [ADR 0106](0106-an-owner-attests-an-orcid-id-that-the-person-has-not-proven.md) (an attestation is not a proof).
The design is the gated page `admin/design/compute-gateway`, section 3; where it and this ADR disagree, this ADR wins.

## Context

A partner-run site, `compute.nemar.org`, has to sign people in with their NEMAR account, and other services may follow.
NEMAR has no way to say who someone is to another host.
The app session cookie is scoped to `app.nemar.org` on purpose (ADR 0056), so it never reaches another host, and widening it would undo the reason for the scope.
ORCID (Open Researcher and Contributor ID) is the identity underneath every person's account (ADR 0047, ADR 0048), and NEMAR adds what it knows about the account.

Three things about the platform as it stands make a partner subdomain dangerous.
The application programming interface (API) trusts any `*.nemar.org` origin in its cross-origin allow-list, and in `isAllowedOrigin`, which is the origin check of the admin router's cookie-authenticated writes and of the authentication, profile, documentation and private-site routes.
Other cookie-authenticated writes (datasets, the upload-access request, sandbox) are not covered by that function: today they are covered by the website's own origin check and by the absence of a cross-origin preflight allowance for the app host.
The partner site serves pages whose JavaScript people write themselves, so a page on it could call the API with a visitor's cookie, or set a cookie for the whole `nemar.org` zone.
And the session cookie has no `__Host-` prefix, so nothing stops a sibling host from setting a cookie of that name for the zone.

A provider's issuer and subject format can never change once a client trusts them, so they are fixed here, before the first client registers and before any `/oauth` route exists.
The token prefixes are fixed here too, for secret scanning and so that the two token kinds cannot be confused, but tokens are opaque to clients: a prefix is a convention inside this Worker, and changing one is a coordinated change here and not a break for a client.
This phase builds none of the provider: it records the decisions and lands the three changes that must precede any client (the partner-host exclusion, the `__Host-` cookie and the subject).

## Decision

**NEMAR is a general OpenID Connect (OIDC) provider whose first client is `compute.nemar.org`; ORCID stays the identity underneath, and an account is the only thing a token ever names.**
Fifteen rules inside that, each of which reopens a hole if reversed.

1. **Authorization code with Proof Key for Code Exchange (PKCE), method S256 only, for every client.**
   No implicit grant, no password grant, no `plain` challenge.
   A confidential client authenticates at the token endpoint with a client secret (`client_secret_basic`).
   A confidential client may also use the client credentials grant, for machine-only scopes such as `compute.stats`, and for nothing a person's consent covers.
2. **The issuer is `https://api.nemar.org` in production, and every identity (ID) token carries exactly that `iss`.**
   Discovery is `https://api.nemar.org/.well-known/openid-configuration` and the signing keys are `https://api.nemar.org/oauth/jwks`.
   The token, userinfo, revocation and introspection endpoints are under `https://api.nemar.org/oauth/`, following Request for Comments (RFC) 7009 for revocation and RFC 7662 for introspection.
   The authorization endpoint is `https://app.nemar.org/oauth/authorize`, because the sign-in cookie lives only on the app host: the page that proves the session and asks for consent is there, it cannot be framed (`frame-ancestors 'none'`) and its consent form is protected against cross-site request forgery.
   Introspection tells a caller only about tokens issued to itself or to a resource server registered for that token's audience.
   NEMAR tells a client about a revoked, deleted or suspended account at the client's registered back-channel logout address.
   Each Worker's issuer is its own `API_BASE_URL` and nothing derived from a request: the staging Worker's is `https://api-test.nemar.org`, and a Worker reached under any other host answers 404 for discovery, the key set and every owner route.
   The signing keys are ES256 (ECDSA over the P-256 curve with SHA-256), and a key is `next`, `current`, `retired` or `revoked`.
   A `next` key is published at once and signs only when it is 24 hours old, unless the owner forces it, and a forced rotation refuses a key published under 6 minutes ago unless the owner says it is an emergency, because a client may not have it in the key set it cached.
   A `retired` key is published for 7 days (at most 5 of them), and a `revoked` key is a retired key the owner withdrew, never published again; only a retired key can be revoked, so the owner rotates first.
   The private half is encrypted under the Worker secret `OIDC_SECRET`, may be wiped from a retired or revoked key, and a rotation first proves it can decrypt the key it is about to promote, so a key encrypted under another secret is refused and nothing changes.
3. **Request handling.**
   `state` is returned unchanged and `nonce` is copied into the ID token.
   The authorization response carries `iss` (RFC 9207), so a client can tell which provider answered.
   `prompt=none` without a NEMAR session answers `login_required` and shows no page; `max_age` older than the session forces a fresh sign-in.
   Until the client and a redirect address that is exactly one it registered are known, an error is shown on NEMAR's page and the person is sent nowhere; after that, every error of the request is a redirect to that address carrying `error`, `state` and `iss`, a response type other than `code` being `unsupported_response_type`.
   A refusal by the client's sign-in rule is a page that links back to the client with `access_denied`, and a consent the page cannot prove was shown, or a mint that wrote nothing, is an error page.
   A sign-in the authorization page sent the person to satisfies `prompt=login`, `max_age` and an `id_token_hint` for another subject; it is recognized by a marker the API signs (the moment the person was sent and the client, good for ten minutes) and a session at least that new, and a marker that does not verify counts as absent (phase #2017).
   Front-channel freshness (`prompt=login`, `max_age`) is a courtesy: what a client relies on is the identity token's `auth_time`, the moment the session behind the code was signed in.
   `prompt=consent` asks a third-party client's person again; a first-party client ignores it.
   A refresh token is issued only when the client asks for `offline_access` and is allowed it.
   Redeeming an authorization code twice revokes every token already issued from it (RFC 6749, section 4.1.2).
4. **Tokens.**

   | Token | Form | Lifetime |
   |---|---|---|
   | Authorization code | random, stored hashed, single use | 60 seconds |
   | ID token | JSON Web Token, ES256, with a key id; the next key is published before it signs | 5 minutes |
   | Access token | opaque, prefix `nmo_at_`, bound to one client, its scopes and its audience | 15 minutes |
   | Refresh token | opaque, prefix `nmo_rt_`, rotated on every use with a 30-second grace for a retried request; reusing a spent one after the grace revokes the whole family | 30 days idle, 90 days absolute |

   API keys are `nm_`, and the OIDC prefixes are chosen so that neither can be read as the other: a prefix test for `nm_` does not match `nmo_at_`.
   A client secret is `nmo_cs_` plus 256 random bits in base64url, shown once and stored only as a hash, so that a secret scanner can find one; like the token prefixes it is a convention inside the Worker and nothing else depends on it.
   **An OIDC access token is accepted only by the routes that serve its scopes.**
   Every existing API route, `/users/me` included, refuses it, just as the OIDC routes refuse a command-line interface (CLI) key.
   A NEMAR API key has no scopes and carries its user's full authority, so the two token kinds must never be interchangeable.
5. **`sub` is `nmu_` plus 32 lowercase hexadecimal characters, 128 random bits, stored in `users.oidc_subject` (migration 0120).**
   It is assigned when the row is created and never changes, never reused, and is neither the row number nor the email address.
   The database enforces it: a format `CHECK`, a unique index, a trigger that fills a missing one on insert and a trigger that aborts any change to a value that is set.
   The tombstone mask keeps it, so a deleted account's subject is never handed to a different person.
   `nmu_` is a reserved username prefix (`validateUsernameFormat` refuses it with `username_reserved`), so no person, service or pipeline name can collide with a subject.
   The subject is on no existing response: not `/users/me`, not `/auth/me`, not an admin user detail or list.
   The only way to resolve one is the owner-only `GET /admin/users/by-oidc-subject/:sub`.
6. **Scopes and claims.**

   | Scope | Claims or access |
   |---|---|
   | `openid` | `sub` |
   | `profile` | `name`, `given_name`, `family_name` |
   | `email` | `email`, `email_verified` |
   | `orcid` | `orcid` (the iD as a URL), `orcid_verified`, true only when the iD was proven by an ORCID sign-in |
   | `nemar.account` | account kind, status and tier: `nemar_kind`, `nemar_status`, `nemar_tier` (rule 14) |
   | `compute.read` | the person's compute access, balances, usage and jobs, through the API |
   | `compute.reserve` | reserve time, report a job, release a reservation |
   | `compute.submit` | submit a job that NEMAR itself sends to Tapis; not granted to compute.nemar.org |
   | `compute.stats` | platform-wide aggregate usage; client credentials only |

   **The provider is general: compute facts are never put in the ID token.**
   They are read from the API with the access token, so they are current, and the provider stays usable by a client that has nothing to do with compute.
7. **Who may sign in is a rule on each client, and there are two.**
   `active_account`: the account is active (status `verified` or `approved`, ADR 0040), not revoked and not deleted.
   `person_proven_orcid`: `active_account`, account kind `person` (ADR 0048), and an ORCID iD the person proved by signing in with ORCID.
   "Proven" means an `oauth_identities` row for the ORCID provider whose iD matches `users.orcid`.
   An iD an owner attested (ADR 0106), or one filled in from a publication record, does not count: `orcid_verified = 1` no longer implies a sign-in record, and this rule is why the difference matters.
   `compute.nemar.org` uses `person_proven_orcid`, and does not require compute access to sign in, so a person can see why they cannot launch and follow a link to request access.
8. **Clients are registered by the owner, and by no one else.**
   A client carries a name, exact redirect addresses (no wildcards), allowed scopes and grants, its sign-in rule, its consent mode, its back-channel logout address, and caps on open reservations and on service units reserved per day.
   A client the owner marks first-party skips the consent screen; any other client is asked, once per set of scopes or every time as its consent mode says.
   **A client is first-party only when every one of its redirect addresses is a first-party origin.**
   A first-party origin is an `https` address on `nemar.org` or a subdomain of it, on the default port, whose host is not a partner host (rule 9); outside production a loopback address (any port, `http` or `https`) and a website preview (a Pages host of the website's two projects) count as well, and in production they never do.
   That is its own rule, not the cross-origin rule `isNemarWebOrigin`, which admits loopback and previews everywhere.
   First-party is refused at registration for a client with any other redirect address, and checked again at every authorization, so a partner or a third party can never skip the consent screen.
   At authorization, a client registered first-party whose redirect addresses no longer all qualify is treated as third-party and asked, and a grant recorded while it was first-party is never taken for the person's consent (phase #2017).
   A client that is not first-party is third-party: it never skips the consent screen, and follows its consent mode.
   `compute.nemar.org` is not first-party: its consent screen says: "If you sign in and run compute with this app, it counts against your NEMAR compute allocation."
9. **A partner subdomain is not trusted as a NEMAR origin.**
   `shared/partner-hosts.ts` lists the partner hosts (today `compute.nemar.org`) and `isPartnerHost` matches a host or any subdomain of one.
   `isNemarWebOrigin` (which the API's cross-origin rule, the zarr host and the Model Context Protocol (MCP) host all use) and `isAllowedOrigin` (the origin check of the admin router's cookie-authenticated writes and of the authentication, profile, documentation and private-site routes; other cookie-authenticated writes rely on the website's own origin check and the absence of a cross-origin preflight allowance for the app host, as the Context says) return false for a partner host before they test anything else.
   A partner reaches NEMAR only through OIDC and bearer tokens.
   A client is registered by an owner command, so a partner host is added to the list and released before the owner registers that partner's client.
   The exclusion is not enough on its own, because a partner host's page can still set a cookie for the parent domain: rule 10 is the other half.
10. **Every cookie the API or the website trusts to authenticate or link a session is host-only and `__Host-` prefixed.**
    The principle is that a page on a sibling host can set a cookie for the parent domain, and the partner-host rule (rule 9) does not stop that; a `__Host-` cookie (`Secure`, `Path=/`, no `Domain`) is the one kind a browser accepts from no other host.
    Three cookies are in scope.
    The session cookie moves from `nemar_session` to `__Host-nemar_session`, behind a flag and with a dual-read window, as below.
    The ORCID flow's state cookie (`nemar_oauth_state`) and pending-signup cookie (`nemar_orcid_pending`) move to `__Host-nemar_oauth_state` and `__Host-nemar_orcid_pending` at once, NOT behind the flag: nothing on the website reads the state cookie, and the website checks the pending cookie only for presence, under either name.
    The state cookie is read only under the new name, with no fallback, so a flow in flight at the deploy fails once with `orcid_state`; the old names are only cleared, with and without `Domain`.
    On a plain-http request to a loopback host (local development) the old unprefixed names are kept, because a `__Host-` cookie must be `Secure` and a browser on plain http may refuse it; the website's development login keeps the legacy session cookie name for the same reason.
    The session cookie's rules:
    - The reader tries the new name first and the legacy `nemar_session` second, and returns the name it read.
      A legacy cookie therefore never outranks a `__Host-` one, and an invalid, empty or revoked `__Host-` cookie is **not** rescued by a valid legacy one.
      A header that carries more than one `__Host-nemar_session` is no session.
    - A `__Host-` session cookie is minted only by a sign-in, never by a slide or by any read of a legacy value: with the flag on, the expiry slide re-issues the cookie only for a session read under the `__Host-` name.
    - The authorization and consent page of phase B3 treats a session read under the legacy name as no session, so a delegation is never granted on the cookie a sibling host can set.
      Its two routes answer 404 while `HOST_PREFIXED_SESSION_COOKIE` is off, because no session could approve a grant then and a person sent to sign in would come back to the same answer.
    - Every completed sign-in mints a fresh session: the ORCID callback's plain sign-in ignores any session cookie already in the browser and signs in the account the iD itself names (or starts a sign-up), and the email-code sign-in always mints one.
      So a person whose session was read under the legacy name, or who was asked to sign in again, comes back with a new `__Host-` session after one sign-in.
    - A sign-in never attaches the signing-in person's iD to whichever account a session cookie already in the browser names.
      An iD attaches to an existing session's account only in an explicit link flow (`link` or `relink` in the state cookie, or a signed CLI intent), and, while the flag is on, only to a session read under the `__Host-` name, the rule the authorization routes apply to a grant.
      Only the start route's POST, which checks Origin and requires a session, puts `link` or `relink` in the state cookie; a GET start is always a plain sign-in, so a cross-site navigation cannot arm a link.
      With the flag off that is a partial fix: a legacy session cookie set from a sibling host can still stand in for the person's own session in a link they start, and what closes it is turning the production flag on.
    - The legacy name stops being read no earlier than 31 days after the production flag is turned on, because every legacy cookie issued before the flag has then passed its 30-day maximum age.
      The date is a later decision (see the not-decided list).
    - Until then the window keeps an exposure open, and it is named here.
      A legacy cookie is still read for any browser that holds no `__Host-` cookie: signed-out visitors, sessions not yet moved to the new name, and every session until the flag is on in production.
      A page on a sibling host can set a legacy cookie for the parent domain, so for those visitors the legacy cookie is not a trustworthy credential.
      A sibling host can also fill a browser's cookie jar until the real `__Host-` cookie is evicted, after which the legacy one is read.
      Both end when the window closes; nothing inside the window removes them.
    The writer is behind `HOST_PREFIXED_SESSION_COOKIE`.
    Unset, and for a request that carried no `__Host-nemar_session`, it sends today's header byte for byte.
    Unset, and for a request that carried one, it also sends a clear of `__Host-nemar_session`, so the flag is reversible: a person who signs out and in again after the flag is turned off is not left behind a stale `__Host-` cookie that the reader prefers.
    Set to exactly `"1"`, it sends the new name with `Secure; HttpOnly; SameSite=Lax; Path=/` and no `Domain`, followed by clears of the legacy name with the configured `Domain`, host-only, and for the parent domain `nemar.org` (none is sent twice, so staging, which configures no `Domain`, gets two).
    The cookie stays host-only (ADR 0056); the new name never goes through `WEB_SESSION_COOKIE_DOMAIN`.
    Sign-out ends the session behind every session cookie the request carries, under either name.
    The order of release is fixed because a reader must exist before a writer: the website's reader first, then the API, then the flag in production, which is the owner's act.
    The flag is `"1"` in the dev Worker's vars, so the dev Worker issues `__Host-nemar_session` as soon as it deploys: the website's reader (nemarOrg/website#499) must already be live on the website's `staging` before this epic reaches `dev`.
11. **The partner uses the `sub`, or a fixed and reversible transform of it, as the username of a person's compute credential, and is never trusted to say who ran a job.**
    The design asks for the `sub` "in a form the job platform accepts as a username", and this ADR keeps that latitude: the partner may apply a fixed transform (for example a change of case or of separator) that NEMAR can undo, so that the credential's username maps to exactly one `sub`.
    If the answer to design question 13 is that no such transform can satisfy the platform's username rules, the `sub` format itself is wrong and the only path is to supersede this ADR before any client registers.
    It mints that credential only while `GET /compute/me` says the person is active.
    Because whoever controls the partner site can mint a credential for any username, the owner of an unreserved job is never taken as proof of who ran it.
    The compute design carries the consequences; they are recorded here only so that the subject's form and its use are read together.
12. **The credential-ending table.**
    Every path that ends or downgrades a credential says what it does to OIDC grants and tokens.
    A new path that ends a credential adds a line here and to `OIDC_END_CALLERS`, and a line to the callers named in `services/docs-auth.ts` and `services/private-auth.ts` only when it also runs their statements.
    Because a path can be missed, every token use also re-checks the account's status, kind and proof against the client's sign-in rule (rule 7), so a path not listed here still takes effect at the next use of a token, even if it did not end the grant.

    | Path | OIDC grants and tokens | Why |
    |---|---|---|
    | Admin revocation (`finalizeRevocation`) | Ends all, and sends back-channel logout | The account is cut off; a client must stop honoring it. In the same batch as the other cascades. |
    | Owner soft delete (`tombstoneUserCascade`) | Ends all, and sends back-channel logout | Same, and the subject stays on the row. |
    | Account merge (manual, ADR 0043), through an owner command | Ends all of the loser's, and sends back-channel logout | The loser stops being a person; the winner's grants are untouched. |
    | Compute suspension | Ends only grants that carry a `compute.` scope, and tells only those clients | The person stays signed in elsewhere. |
    | ORCID unlink or relink | Ends the grants of every client whose rule is `person_proven_orcid`, and sends back-channel logout to those clients | The proof they were granted on is gone, and a client that relied on it should stop honoring the session. |
    | Account kind changed away from `person` (the owner route that holds `KIND_CHANGE_GUARDED_UPDATE_SQL`) | Ends the grants of every client whose rule is `person_proven_orcid`, and sends back-channel logout to those clients | The account no longer meets that rule. A change to `person` ends nothing. |
    | Client disable | Revokes everything the client holds, and sends no logout | The owner has cut the client off; telling it is not owed. |
    | Role demotion | Leaves them alone | A token carries no role and no OIDC scope confers admin authority (rule 4), so there is nothing to downgrade. `PRIVATE_REVOKE_ALL_SQL` says the same of private sessions. |
    | API key revocation | Leaves them alone | A grant is not minted from a key and depends on none. |
    | Sign-out of the app session | Leaves them alone | See the departure below. |

    **What an ending is, in code (phase #2019).**
    One function, `oidcEndStatements` in `services/oidc-cascade.ts`, returns the four statements of an ending, in this order, and every path above adds them to the batch that ends its credential: queue a logout for each client the account has a live grant at that is active and has a back-channel logout address (read from the grants BEFORE they are revoked), revoke the account's live access and refresh tokens, revoke the grants, and delete the unused codes.
    A used code stays, because a second redemption is recognized by it and everything it issued is already revoked.
    Every table names a client by its `oidc_clients.id` row, never the public `oc_` string, so a statement written against the public string ends nothing.
    A revoked grant stays for the record, and a later sign-in is a NEW grant, so an account that is put back (an approval, a status written by hand) comes back with nothing.
    The reason of an ending is a closed word, recorded on the revoked tokens and the queued logouts and never sent to a client: `account_revoked`, `account_deleted`, `account_merged`, `compute_suspended`, `orcid_changed` and `kind_changed`.
    A filter narrows an ending to some of the account's grants, and what it selects is GRANTS: everything under a selected grant goes with it, its tokens whatever scopes they carry (a grant accumulates the scopes of every sign-in, and a token carries only those of its own code), its unused codes and its logout.
    `{rule}` selects the grants of the clients that sign people in by that rule (the ORCID unlink and relink and the kind change, with `person_proven_orcid`); `{scopePrefix}` selects the grants that carry a scope with that prefix (the compute suspension, with `compute.`).
    The compute suspension has no caller yet, because its state does not exist; the compute access phase adds the caller, and the filter is shipped and tested directly.
    The paths that call it, and their number, are `OIDC_END_CALLERS`, held to the code in both directions by a test that reads the syntax tree, as the docs and private-site counts are held: `finalizeRevocation` (revoke by username and by id), `tombstoneUserCascade` (the owner's soft delete, which runs the statements as they stand, and the sweep of the live tests' accounts, which runs each one conditional on the mask having applied to the row it chose), the ORCID unlink, the ORCID relink, the change of kind away from `person`, and the owner's `nemar admin oidc end-account`.
    That last command is how a manual merge ends the loser (`--reason merged`) and the tool for an incident (`--reason revoked`); it ends only the OIDC holdings and does not revoke the account.
    Ending the grants does not stop the account signing in again, because its app sessions and keys survive, so it can get a new first-party grant at once (a third-party client asks for consent again).
    For the loser of a merge the owner runs `end-account` and then revokes or deletes that account, which end every grant it holds and leave it unable to sign in; running `end-account` first is what makes the revoked tokens and the queued logouts record the merge and not the revocation, because the revocation or the deletion then finds nothing live to end.
    A change of the account's kind away from `person` is no substitute: it ends only the grants of the clients that sign people in by `person_proven_orcid`, and a non-person account still satisfies `active_account`, so it keeps its other grants and can sign in again at once.
    The owner uses `end-account` alone only for an incident that is about the grants and not the account.
    A client's disabling is a separate function keyed by the client, `oidcClientEndStatements`, in the batch that disables it: every token it holds (an account's and its own), every grant and every unused code, and no logout.
    It is not conditional on the status having changed, so disabling a client that was disabled before the revocation existed finishes the job.

    **Leaving grants alone on sign-out is a departure from the cascade the earlier ADRs describe.**
    ADR 0021, ADR 0056 decision 5 and ADR 0079 end whatever was minted from a credential when that credential ends, and an OIDC grant is minted from an app session.
    This ADR does not follow them here, because signing out of NEMAR is not withdrawing a third party's delegated access, and ending every partner session whenever someone closes their NEMAR tab would make the partner unusable.
    The consequence is that a person has no self-service way to withdraw a partner's access for up to 90 days (the refresh token's absolute lifetime) until a connected-apps page exists, which is in the not-decided list.
    This is a decision for the repository owner, who can reverse it before the first client registers, and it is marked as such so that acceptance of this ADR does not carry it unseen.
13. **The token endpoint decides in the statement that writes, and a second use of a code or of a spent refresh token ends what it issued (phase #2018).**
    A client authenticates with HTTP Basic only: the identifier and the secret are form-decoded (RFC 6749 section 2.3.1) and the secret is compared as a hash in constant time, the previous secret is accepted until its grace ends, a disabled client is refused, and a credential in the body is refused even beside a valid header (`invalid_client`, with a Basic challenge).
    A token request whose `code`, `redirect_uri` or `code_verifier` is missing, or whose verifier is not 43 to 128 unreserved characters, is `invalid_request` before the code is read.
    A code is then checked before anything is written: the verifier against its S256 challenge in constant time, and the redirect address exactly; a mismatch is `invalid_grant` and writes nothing, whether or not the code is used.
    Another client's code is refused and writes nothing, used or not, so one client can never end what another holds.
    One batch then mints and claims.
    The access token is inserted only while the code is unused, unexpired and this client's, and while its client, its grant and its account still pass, the account by the client's sign-in rule (rule 7) read at that moment; the refresh token only beside that access token; and the code is marked used only when that access token's row exists.
    So two redemptions in flight cannot both mint, and a redemption refused for any reason writes nothing.
    A used code its own client presents again with the right verifier and redirect address, or a redemption that lost the claim of a code used by now, is a second redemption: every token issued from the code, rotations included, is revoked (`code_replay`), and nothing else is written.
    The verifier comes first because whoever redeemed the code first held the right one: a second redemption by the legitimate client still matches and still revokes, while someone who captured a victim's code cannot have the legitimate client present it again with another verifier to end the victim's tokens.
    A second redemption is recognized until an hour past the code's expiry, when used codes are pruned.
    Tokens carry the code's scopes, never the grant's, which accumulate.
    The identity token carries `iss`, `sub`, `aud` (the client), `iat`, `exp` (5 minutes), `nonce` when the request had one, `auth_time` (the sign-in of the session behind the code) and `at_hash`, with the claims of the code's scopes (rule 14); a refresh returns no identity token.
    A refresh token is issued only when the code carries `offline_access` and the client is allowed the refresh token grant.
    A refresh rotates in one batch: the child is inserted only while the parent is live, unrevoked and this client's and its client, grant and account still pass, and only when the parent is either unspent with no child, or was spent under 30 seconds ago and has exactly one child that is itself untouched, neither rotated nor revoked.
    That second case is a retried request: it mints one more child, never two, so two requests that refresh together both succeed.
    The children of one parent are mutually exclusive: rotating one of them revokes its live siblings in the same batch (`refresh_superseded`), so whichever is rotated first wins and the other, presented later, is a revoked token that revokes the whole family.
    A retry that comes after the first child was rotated or revoked gets no second child: it is reuse, whatever the order the two holders acted in.
    The revoked siblings' access tokens stay valid for up to their 15 minutes, by design: one of them may be the one the session that rotated is still using.
    A session that refreshed twice at once keeps working with whichever answer it stored; two holders of one token inside the 30 seconds cannot both go on rotating, because the second of them to come back ends the family.
    The parent is marked spent once, so the 30 seconds run from the first rotation and a retry never stretches them.
    A parent presented when it is revoked, or spent and past the 30 seconds, or already retried once, or spent with a child that was rotated or revoked since, revokes its whole family, access tokens included (`refresh_reuse`), in a statement that checks that condition again, so a rotation refused for another reason (an inactive account, a revoked grant, an expired token) revokes nothing.
    A refresh token expires 30 days after it was minted and never after its family's end, 90 days after the code was redeemed, which every rotation copies unchanged; a spent one is kept until a day past that end, so its reuse can be recognized.
    A refresh may narrow the access token's scopes and never widen them, and the new refresh token keeps its own.
    A grant recorded while its client was first-party feeds a refresh only while every redirect address of the client still qualifies (rule 8).
    The client credentials grant gives one access token for the client's own machine-only scopes (`compute.stats`): no account, no identity token, no refresh token.
    Every answer is `Cache-Control: no-store`, every error is the two fields of RFC 6749 section 5.2 with a fixed sentence that repeats nothing the caller sent, and a token, a code, a verifier or a secret is stored only as a SHA-256 and logged nowhere.
14. **An access token is used only where its scopes are served, and what it says about an account is read at the moment it is used (phase #2018).**
    `oidcBearer` is the one middleware that lets an access token authenticate a request; today it is on `/oauth/userinfo` alone, and a test built from the Worker's whole route table fails when it appears on any other route.
    Without an `Authorization` header it answers the bare `Bearer` challenge with no error code and no body (RFC 6750 section 3.1).
    Every other route refuses an OpenID Connect credential by its `nmo_` prefix before any lookup: a route behind the API key check answers 401 `oidc_token_not_accepted`, and a route with an anonymous answer gives that answer, as it would for an unknown key.
    The token routes refuse a CLI key in turn: `invalid_token` at userinfo, `invalid_client` at the three client endpoints.
    Every use reads the token, its client, its grant and the account against the client's sign-in rule again, so the token of a suspended, revoked or deleted account is inactive while its row is live.
    An access token lives its 15 minutes whenever it was minted; the family's end bounds when one can be minted, not how long it lives.
    The claims are the token's scopes', and an absent value is left out rather than sent empty: `sub`; `name`, `given_name`, `family_name`; `email`, `email_verified`; `orcid` (`https://orcid.org/<iD>`) and `orcid_verified`, true only for an iD proven by an ORCID sign-in, neither for an account with no iD; and for `nemar.account`, `nemar_kind`, `nemar_status` and `nemar_tier` (`base` or `upload`, the tiers of ADR 0040).
    Revocation (RFC 7009) answers 200 whatever it is given and ends only the caller's own token: an access token alone, a refresh token with its family (`client_revoked`).
    Introspection (RFC 7662) answers `{active: false}` unless the token is active now and the caller is the client it was issued to, or the token is an access token whose audience the caller is registered to introspect; a refresh token is shown to its own client only, and with no `token_type`, which RFC 7662 defines for access tokens.
    A database fault is a server error, never `invalid_token`, `invalid_grant` or `{active: false}`.
    In the `read-only` maintenance mode, `POST /oauth/userinfo` and `POST /oauth/introspect` are served (exact paths, POST only; both only read; a GET is served as every read is, and PUT, DELETE and PATCH on them answer 503), and the token endpoint and revocation answer 503; in `full` all four answer 503.
    The three client endpoints have a rate-limit bucket of their own, keyed by address and generous, because a partner's server answers for every person signed in to it from one address.

15. **An ending queues its logouts in its own batch, and a sender tells the clients afterwards (phase #2019).**
    The batch writes the INTENT, one `oidc_logout_deliveries` row per client, and never touches the network: a partner's server must not be able to slow, fail or block a revocation, and a delivery that fails never undoes one.
    The call is made afterwards, once from `waitUntil` right after the commit (so the request that revoked is answered without waiting for any partner), and again from a retry tick every 30 minutes, in production only, which takes at most 20 deliveries a tick, each in its own try and catch.
    The tick is absent from the dev cron allowlist, returns before it reads anything outside exactly `production`, and its name avoids the word sweep because it is not one.
    The first attempt of the sweep of the live tests' accounts is made by the sweep itself, because no tick runs outside production.
    **The token** is a JSON Web Token signed ES256 with the current key, header `typ: logout+jwt`, and exactly these claims: `iss`, `aud` (the client's public id), `iat`, `exp` two minutes later, `jti`, `sub` and `events` holding `http://schemas.openid.net/event/backchannel-logout` with an empty object.
    It carries no `nonce` (OpenID Connect Back-Channel Logout 1.0 forbids one), no `sid` (NEMAR keeps no session id for a client to correlate) and no reason.
    The `jti` is new for every attempt, so a retry is a new token and never a replay of the old, and the row holds the `jti` of the last one so that a partner's complaint can be matched to it.
    **The request** is a `POST` of one form field, `logout_token`, to the registered address, with nothing else: no `Authorization`, no cookie, no client secret, no API key.
    It waits 5 seconds, never follows a redirect, and never reads the answer's body (it is cancelled), so a partner cannot make NEMAR wait or read without bound.
    A `200` or `204` is `sent`.
    A redirect, any other `4xx` (a `408` and a `429` are the exceptions, next) and any other answer that is not a `5xx` are `failed` at once, because repeating a refusal does not change it.
    A `5xx`, a `408`, a `429`, no answer in time and a connection that could not be made are retried at 1 minute, 5 minutes, 30 minutes, 2 hours and 12 hours (the first attempt and five retries), then `failed`.
    A `408` or a `429` is recorded `http_throttled`, and the `Retry-After` it may carry (a number of seconds, of any length, or an HTTP date; the header is read and the body still never is) is a LOWER bound for the next wait: the longer of it and the schedule's, at most 12 hours, so a partner can slow a delivery and can never add an attempt; a run of digits too long to be a finite number is the 12 hours, and is never read as no header at all.
    A `Retry-After` on any other answer is not read.
    A token that NEMAR could not sign (no key, a database fault) is retried too: it is NEMAR's fault and not the partner's.
    The wait is the EARLIEST time of the next attempt, and the tick runs every half hour, so a short wait is taken up at the next half hour; a faster cron for the short waits is not built, because the six attempts of the schedule alone span fifteen to eighteen hours and do not need one.
    A row records a status, an attempt count, a time and a fixed word for what went wrong (`timeout`, `network`, `redirect`, `http_4xx`, `http_5xx`, `http_throttled`, `http_other`, `sign_failed`, `address_refused`, `client_disabled`, `fenced`, `unreported`), and never the text of an error or of an answer.
    An attempt is claimed before it is made, in one conditional statement that counts it, holds the row for two minutes and stamps the `jti`, and its answer is recorded only by the attempt that holds the claim, so the first attempt and the tick, or two ticks, can never send one delivery twice at once, and an attempt that never records (the isolate was evicted) is taken up again when its claim lapses, with the retries still bounded.
    Once all six attempts are claimed, a delivery whose last attempt never recorded is not tried again: it is `failed` with `unreported`, because a seventh request would break the six-request bound while the partner may already hold the token.
    **The fence.**
    This is the Worker making an outbound request to an address somebody else chose, so the address is checked again at send time and not only at registration.
    Never, whatever the environment: an address that is not `https`, that carries user information or that does not parse.
    In production, which means `ENVIRONMENT` exactly `production`: a named `https` host, and not a loopback, `localhost`-named or IP-literal one.
    Anywhere else, an unset or mistyped value included: a loopback address (`localhost`, `127.0.0.1`, `[::1]`) or a host the owner listed in the optional var `OIDC_LOGOUT_DEV_HOSTS` (exact, case-insensitive; a listed host does not admit its subdomains), and every other address is recorded `fenced` and never sent.
    It fails closed the other way from `isNonProductionEnv`, because the harm here is a real call to a real partner from a Worker that shares real accounts.
    The var is absent from `wrangler-sccn.toml`, is ignored in production, and setting it is the owner's act; a test refuses it in the production tables of the file.
    The Worker has no route to a private network, and the sender refuses a literal address in production, but it does not resolve a name itself: a name a partner points at an address of its own is still requested, and that is the partner's own server by definition, receiving only a token that names it as its audience.
    A client disabled before its attempt is not told: the row is `failed` with `client_disabled` and nothing is sent.
    **The owner's view** is `GET /admin/oidc/logout-deliveries?status=&limit=` and `nemar admin oidc logout-deliveries`: the deliveries newest first, naming the client by its public id, with a count of every status, and no token, no address and no partner text.
    The owner routes (this one and `end-account`) take the owner role and the OIDC surface (`OIDC_SECRET` set and the issuer's own host), and deliberately NOT `HOST_PREFIXED_SESSION_COOKIE`: that flag guards who may approve a grant, and these routes act on the owner's own credential, which a cookie planted from a sibling host cannot stand in for (a planted cookie is the attacker's own non-owner session and fails the owner check), while requiring the flag would switch the incident tool off exactly when the flag is off.
    **Retention.**
    The production tick prunes finished deliveries after its delivery work, at most 500 a tick, oldest first: `sent` and `fenced` rows older than 30 days (by `sent_at` and by `created_at`) and `failed` rows older than 180 days (by `created_at`; the table has no last-update column, and a failed row's last attempt comes within three days of its creation, which does not matter against the window: the first attempt, at the next tick if the one after the commit did not run, and five waits of at most 12 hours, each taken up at the next half-hour tick, are 63 hours at the most), and never a `pending` row, which includes an attempt in flight.
    The windows are named constants in `shared/oidc.ts` and are DEFAULTS pending the owner, who sets them before the first client registers: a row holds the pseudonymous `sub` of possibly deleted accounts, so pruning is also data minimisation.
    A dev or staging Worker has no tick, so its table is not pruned and grows with the number of endings there, which is few.

### What this phase builds, and what it does not

This phase lands the ADR, the partner-host exclusion (rule 9), the cookie reader and writer (rule 10), and the subject with its reserved prefix (rule 5).
The client registry, the keys, discovery, authorization, tokens, the cascades and the logout are #2016 to #2019, and each builds against this text.

### Not decided here, and so not to be assumed by the phases that follow

- Public clients (PKCE with no secret).
- `private_key_jwt` client authentication.
- A connected-apps page where a person revokes a grant themselves, which is also what the sign-out departure in rule 12 waits for.
- The date the legacy session cookie name stops being read, which is when the exposure in rule 10 ends. Rule 10 sets only the earliest: 31 days after the production flag is turned on.
- The retention windows of finished deliveries (30, 30 and 180 days, rule 15) are defaults: the owner sets them before the first client registers.
- An owner command that re-sends a `failed` or `unreported` delivery as a NEW row, so that the six-request bound still holds for each row, is not built.
- A `backchannel_logout_session_required` setting and a `sid` claim, which would need a session id NEMAR keeps per client.
- Whether the sign-out of a session that has no grant should still tell a client; today it tells nobody (rule 12).
- Whether the `sub` format satisfies the username rules of the partner's job platform, which only the platform's operator can answer (design question 13).
  If the answer makes the format unusable, it is superseded here before any client registers, and not worked around.

## Consequences

- **Easier:** another service can sign people in without a copy of anyone's identity, and revoking an account ends its grants in the transaction that revokes its keys.
  A reader of an ID token learns an opaque subject, so a client that stores only `sub` stores nothing it could later regret.
- **Harder:** the subject and the issuer are forever.
  Every later phase builds against them, and a mistake in this ADR is not an amendment.
- **`OIDC_SECRET` is for good once a key exists.**
  Changing it after the first rotation makes every stored key unreadable.
  A rotation refuses to promote a key it cannot read, so the mistake is caught and nothing changes, but nothing re-encrypts the stored keys, and no re-encryption path exists; building one (with a version on each row) is not part of this epic.
  Losing or changing it leaves no CLI way back (a rotation refuses with `key_unreadable`, and revoke refuses the current and next keys), so recovery is by hand: delete the current and next rows of `oidc_signing_keys` (retired rows hold no private half and can stay), then run `keys rotate`, and the operations runbook (#2020) documents that procedure.
- **The cookie rename is a three-step release.**
  Until the website reads the new name, turning the flag on logs everyone out of the website: the API would set a cookie the website's middleware does not know.
  The flag is `"1"` in the dev Worker's vars, so the dev Worker issues `__Host-nemar_session` as soon as it deploys, and the website pull request that reads it (nemarOrg/website#499) must already be live on the website's `staging` before this epic reaches `dev`.
  Production's flag is the owner's, after both releases.
  The ORCID state and pending cookies are not behind the flag: the API deploy moves them, and the website must already accept either pending name.
- **The dual-read window is a cost, and rule 10 says what it keeps open.**
  A legacy cookie never outranks a `__Host-` one, but it is still read for any browser that holds no `__Host-` cookie, and a sibling host can set one for the parent domain or evict the real `__Host-` cookie by filling the jar.
  The window ends by a later decision, not by this one, and no earlier than 31 days after the production flag is on.
- **The flag is reversible.**
  Turned off again, a request that carries a `__Host-nemar_session` gets a clear of it with the legacy header, and a request that carries none gets today's bytes exactly, so nothing production can receive changes.
  The clear is what keeps a person who signs out and in again after the flag is turned off from being locked out behind a stale `__Host-` cookie that the reader prefers.
- **Account kinds matter more.**
  `person_proven_orcid` makes ADR 0048's kinds a gate on a third party's sign-in.
- **A username that starts `nmu_` is refused from now on.**
  The owner checks that no live username already does before the release, because a migration cannot rename a person's handle.
- **Spent refresh tokens are rows that stay (rule 13).**
  Every rotation writes two rows and keeps the spent one until a day past its family's end, up to 91 days, so the token table grows with the number of refreshes and not with the number of people.
  That is the price of recognizing the reuse of any spent token in a family.
  The prune runs at the head of every batch that mints and reads only what it may delete: the access tokens' expiry index is partial on their kind, so retained refresh rows cost the prune nothing.
  What to watch once a partner is live: row counts by kind, and how many are spent and how many revoked; the largest family by row count, and rotations per family per day; rows deleted per prune, and the token endpoint's latency; the size of the D1 database.
  Two levers exist if the size ever matters, noted here and not built: prune a revoked family about a day after it is revoked (nothing in it can be used, and its reuse needs no detecting), and a minimum interval between two rotations of one family.
  The prune shares the batch that mints, so a backlog of expired rows in the millions (an outage of the prune, or a burst of short-lived families) would slow, or fail, the token endpoint until it clears; the watch list above is what shows it coming.
- **A fault is never a verdict, and replay detection waits for the database (rules 13 and 14).**
  A database or signing-key fault is a server error, never `invalid_grant`, `invalid_token` or `{active: false}`.
  A matching second redemption whose signing-key read fails answers 5xx and revokes nothing yet; the next presentation when the database answers revokes, so a 4xx for a matching second redemption is never given without its revocation (except for a code whose account row no longer exists, whose tokens are inactive already).
  The tests prove an unreachable database and a failed key read; a batch that fails halfway relies on D1 running a batch as one transaction, which no test here can break.
- **A logout is a best effort, and the revocation is not (rules 12 and 15).**
  A client that was down for all six attempts is never told, and the row says so (`failed`, with the last answer and a fixed word); what ended its person's tokens at NEMAR is already done and is not undone.
  A partner that wants to be sure checks introspection or userinfo, which refuse an ended grant at once.
  A delivery is attempted at most six times, over roughly fifteen to eighteen hours on the schedule alone (the tick runs every half hour, so each wait can run up to half an hour longer), and over 63 hours at the most when a throttling partner asks for the longest wait every time, and is then left for the owner to read.
- **Outside production nothing retries.**
  The tick runs only in production, so a dev delivery to a listed host that fails stays `pending`, and the owner reads the row and tries again with a fresh ending.
  The first attempt after each ending, and the sweep's, are the only attempts a dev Worker makes.
- **Every ending is one batch with the other cascades, and a long batch is a cost.**
  An ending adds four statements, none of which loops over a client, so it grows with the number of the account's grants and not with the number of clients that exist.
- **In read-only maintenance no partner can refresh (rule 14).**
  The token endpoint writes, so it answers 503; userinfo and introspection keep answering, but every partner session lapses within the access token's 15 minutes and the person signs in again once the mode is off.
  A maintenance window that has to keep partners signed in is a `full` decision the owner makes knowing that.

## Alternatives considered

- **Use the app session cookie on `.nemar.org`.**
  Attaches a credential to `data.nemar.org` and to the partner host, which is exactly what ADR 0056 refused.
- **Widen the origin checks to an allow-list of NEMAR's own hosts instead of listing a partner.**
  Safer by default, and it would need every first-party host (the website, its preview and staging hosts, the docs and private hosts) enumerated at once, so that one omission breaks a working surface.
  A list of partners changes nothing else and fails open only for a host that is named; the list is short and in one file.
- **Make the subject the row number, the email address or the ORCID iD.**
  Each is guessable, reusable or a person's data, and an ORCID iD can change (ADR 0043 and the relink flow).
- **JSON Web Token access tokens.**
  Self-describing, but revocation would wait out the lifetime, which the revocation rule (ADR 0056, decision 5) forbids.
  An opaque token is looked up, so ending a grant ends its tokens at once.
- **An off-the-shelf provider.**
  It would bring a second user table and a second revocation path to keep in step with NEMAR's, and none of NEMAR's rules (kinds, ORCID proof, cascades) would be expressible in it.
- **Keep `nemar_session` and add a defensive check for a cookie that was set by another host.**
  There is no signal in a request that tells a cookie set by a sibling host from one the API issued.
  The `__Host-` prefix is enforced by the browser, which is the only party that can enforce it.
- **A different issuer than `https://api.nemar.org`.**
  The issuer cannot change once a client trusts it, so the choice is made once.
  `https://app.nemar.org` would put discovery and the signing keys on the website, a separate deployment that would have to proxy or duplicate them, and would tie the issuer to a host the API does not control.
  A dedicated host such as `auth.nemar.org` is cleaner and carries its own limits, at the cost of a new host, certificate and routing fork that nothing else on the platform needs.
  The API host already carries every other cross-host contract and the tokens, keys and revocation live there, so it is the issuer.
  The price is that discovery and the signing keys live on the API host for good and must be exempt from `maintenanceMode` and from the rate limiter: a client that cannot fetch them during maintenance or a burst cannot validate a token.
  Moving the issuer later means the old one keeps answering for as long as any client still trusts it.
- **A pairwise `sub` (a different subject per client) instead of one public subject.**
  Pairwise stops two clients from correlating an account, which matters for a general provider with unrelated clients.
  The first client needs a stable name that it and NEMAR's compute records share (rule 11), and there is one partner, so one public `sub` per account is the choice.
  Pairwise can be added per client later, as a client setting that derives a subject from the account's `sub` and the client's identifier, without changing the stored subject; a client switched to it would see a different value and is told first.

## Receipts

- Issue #2015 (this phase), epic #2014; design section 3 of `admin/design/compute-gateway`.
- `shared/partner-hosts.ts`, `backend/src/services/cors-origins.ts`, `backend/src/services/web-session.ts`.
- `shared/oidc-subject.ts`, `backend/src/services/oidc-subject.ts`, migration `0120_users_oidc_subject.sql`.
- ADR 0056 and ADR 0079 (host-scoped credentials, `__Host-` names), ADR 0043 and ADR 0048 (identity and kinds), ADR 0106 (an attestation is not a proof), ADR 0040 (the active statuses).
- OpenID Connect Core 1.0; RFC 6749 and 7636 (authorization code, PKCE), RFC 7009 (revocation), RFC 7662 (introspection), RFC 9207 (issuer in the authorization response).
- Rule 12's code and rule 15: issue #2019; migration `0124_oidc_logout_deliveries.sql`, `backend/src/services/oidc-cascade.ts`, `backend/src/services/oidc-logout.ts`, `backend/src/services/oidc-logout-store.ts`, `OIDC_END_CALLERS` and its test `backend/test/oidc-cascade-callers.test.ts`, the retry tick in `scheduled()` (`backend/src/index.ts`); OpenID Connect Back-Channel Logout 1.0; RFC 8725 (JWT best current practices, explicit typing).
- Rules 13 and 14: issue #2018; migration `0123_oidc_tokens.sql`, `backend/src/services/oidc-tokens.ts`, `backend/src/services/oidc-claims.ts`, `backend/src/routes/oauth.ts`, `backend/src/middleware/oidc-bearer.ts`, `resolveApiKeyUser` in `backend/src/middleware/auth.ts`, the `oauth-ip` bucket in `backend/src/middleware/rateLimit.ts`; RFC 6750 (bearer tokens).

## Addendum (2026-11-07): `OIDC_SECRET` has a form

The owner decided that a value in the wrong form must not be able to switch the provider on.
`OIDC_SECRET` is valid only when it starts with `nmsso-` (lowercase, exactly), is at least 32 characters in all, and has a body of letters, digits, underscore and hyphen.
Length alone no longer turns the provider on.
The rule checks form, not strength: `nmsso-` followed by 26 identical characters passes, and the strength comes from making the value with `openssl rand -hex 32`.

- **One test, one reader.**
  `isOidcSecret` in `shared/oidc.ts` is the only test of validity, and `oidcSecret` in `backend/src/services/oidc-config.ts` is the only code that reads the binding: it returns the value when the test passes and `null` otherwise.
  `oidcEnabled`, key creation and rotation, signing, and the authorization cookie MACs all take their secret from it, so a value that fails the test behaves exactly like an unset one: the surface answers 404, nothing is signed, encrypted or decrypted, and the bad value is never used as a fallback.
- **The family convention.**
  Any further secret the OpenID Connect handshake needs uses the same `nmsso-` prefix.
  A new one is a new constant beside `OIDC_SECRET_PREFIX` and a new pure check beside `isOidcSecret`, not a new format.
- **How to make one.**
  `nmsso-` followed by the output of `openssl rand -hex 32`, which is 70 characters.
  Dev and production use different values, and `OIDC_SECRET` still differs from `ENCRYPTION_KEY`.
  A value is made and set by the owner; an agent never reads, prints or sets it.
- **What the owner is told.**
  The owner routes (and so `nemar admin oidc`) answer a provider that is off for want of a usable secret with the same 404 plus one field, `oidc_secret`, whose value is `unset` (absent or empty) or `malformed` (set, but not in the form).
  The word is only ever one of those two, never the value or its length, and only an authenticated owner on the issuer's own host sees it; every public route stays the ordinary unrouted 404.
- **The retry tick waits.**
  While the secret is invalid, `attemptDueLogouts` (the retry tick, the first attempt after an ending and the test-account sweep all pass through it) claims nothing, reads nothing and writes nothing, and the tick does not prune either; it logs one fixed-word warning (`oidc_secret_unset` or `oidc_secret_malformed`, never a value).
  A claim costs an attempt and a token cannot be signed without a secret, so claiming would spend a pending back-channel logout's five attempts and end it as `failed`.
  The deliveries stay `pending` and are sent once the secret is valid again.
- **Unchanged.**
  The secret is for good once a key exists, changing it makes every stored key unreadable, a rotation under another secret is refused with `key_unreadable`, and recovery is the by-hand path in Consequences.
  A Worker whose existing secret does not have the form goes dark until it is replaced, and replacing it after a key exists is that same recovery; the real values already have the form, so no Worker is affected.
