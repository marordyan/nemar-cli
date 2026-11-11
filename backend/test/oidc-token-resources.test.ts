/**
 * What a token reads and how it ends (epic #2014 phase #2018; ADR 0119 rules 4, 6, 12 and 14),
 * through the REAL Worker: the claims of the identity token and of `GET|POST /oauth/userinfo`, scope
 * by scope; `POST /oauth/revoke` (RFC 7009); and `POST /oauth/introspect` (RFC 7662).
 *
 * The rules held here: claims are exactly the granted scopes' claims, read from the account at the
 * moment of the call; `sub` is the stored subject; `orcid_verified` is true only for an iD proven by
 * an ORCID sign-in (an attestation gives false); a suspended or revoked account's token is inactive
 * and unreadable even while its row is live; revocation answers 200 for anything, and ends only the
 * caller's own token (a refresh token's whole family); introspection is blind to other clients'
 * tokens unless the token's audience is one the caller is registered to introspect, and never shows
 * a refresh token to anyone but its client; and a CLI key is refused by all three routes.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { accountTier } from "../src/services/account-tier";
import { hashApiKey } from "../src/services/token";
import {
  type RegisteredClient,
  authorize,
  basic,
  decodeJwt,
  formPost,
  redeem,
  registerClient,
  rotateKeys,
  seedAccount,
  sessionCookie,
} from "./helpers/oidc-flow";
import {
  ISSUER,
  MEMBER_KEY,
  OWNER_KEY,
  type OidcHarness,
  startOidcHarness,
} from "./helpers/oidc-harness";

let h: OidcHarness;

beforeEach(async () => {
  h = await startOidcHarness({ HOST_PREFIXED_SESSION_COOKIE: "1" });
  await rotateKeys(h);
});

const ORCID = "0000-0002-1825-0097";

let orcidCounter = 0;
/** A distinct iD of the ORCID form for every account (`users.orcid` is unique). */
function nextOrcid(): string {
  orcidCounter += 1;
  return `0000-0003-${String(1000 + orcidCounter).padStart(4, "0")}-000X`;
}

interface Issued {
  access_token: string;
  refresh_token?: string;
  id_token: string;
  scope: string;
}

async function issue(
  opts: {
    scope: string;
    account?: Parameters<typeof seedAccount>[1];
    clientOver?: Record<string, unknown>;
    client?: RegisteredClient;
  } = { scope: "openid" },
): Promise<{ client: RegisteredClient; userId: number; issued: Issued }> {
  const client = opts.client ?? (await registerClient(h, opts.clientOver));
  const userId = seedAccount(h, opts.account);
  const cookie = await sessionCookie(h, userId);
  const code = await authorize(h, client, cookie, { scope: opts.scope });
  const res = await redeem(h, client, code);
  expect(res.status).toBe(200);
  return { client, userId, issued: res.json as unknown as Issued };
}

function orcidOf(userId: number): string {
  return h.db.query<{ orcid: string }, [number]>("SELECT orcid FROM users WHERE id = ?").get(userId)
    ?.orcid as string;
}

function subjectOf(userId: number): string {
  return h.db
    .query<{ oidc_subject: string }, [number]>("SELECT oidc_subject FROM users WHERE id = ?")
    .get(userId)?.oidc_subject as string;
}

async function userinfo(token: string, method: "GET" | "POST" = "GET") {
  return h.call(method, "/oauth/userinfo", { headers: { Authorization: `Bearer ${token}` } });
}

/** The claims an identity token carries beyond the token's own (iss, aud, iat, ...). */
function scopeClaimsOf(idToken: string): Record<string, unknown> {
  const { claims } = decodeJwt(idToken);
  const own = ["iss", "aud", "exp", "iat", "nonce", "auth_time", "at_hash"];
  return Object.fromEntries(Object.entries(claims).filter(([k]) => !own.includes(k)));
}

// ---------------------------------------------------------------------------------------------
// Test 3: claims per scope
// ---------------------------------------------------------------------------------------------

describe("claims are exactly the granted scopes', in the identity token and at userinfo", () => {
  test("scope by scope", async () => {
    const account = () => {
      const orcid = nextOrcid();
      return { orcid, identity: orcid, ...named };
    };
    const named = {
      givenName: "Ada",
      familyName: "Lovelace",
      serviceAccess: true,
      status: "approved",
    };
    const cases: Array<[string, (userId: number) => Record<string, unknown>]> = [
      ["openid", (u) => ({ sub: subjectOf(u) })],
      [
        "openid profile",
        (u) => ({
          sub: subjectOf(u),
          name: "Ada Lovelace",
          given_name: "Ada",
          family_name: "Lovelace",
        }),
      ],
      [
        "openid email",
        (u) => ({
          sub: subjectOf(u),
          email: `${h.db.query<{ username: string }, [number]>("SELECT username FROM users WHERE id = ?").get(u)?.username}@example.org`,
          email_verified: true,
        }),
      ],
      [
        "openid orcid",
        (u) => ({
          sub: subjectOf(u),
          orcid: `https://orcid.org/${orcidOf(u)}`,
          orcid_verified: true,
        }),
      ],
      [
        "nemar.account openid",
        (u) => ({
          sub: subjectOf(u),
          nemar_kind: "person",
          nemar_status: "approved",
          nemar_tier: "upload",
        }),
      ],
      ["offline_access openid", (u) => ({ sub: subjectOf(u) })],
    ];
    for (const [scope, expected] of cases) {
      const { userId, issued } = await issue({ scope, account: account() });
      const want = expected(userId);
      expect({ scope, claims: scopeClaimsOf(issued.id_token) }).toEqual({ scope, claims: want });
      for (const method of ["GET", "POST"] as const) {
        const info = await userinfo(issued.access_token, method);
        expect(info.status).toBe(200);
        expect(info.headers.get("Cache-Control")).toBe("no-store");
        expect({ scope, method, claims: info.json }).toEqual({ scope, method, claims: want });
      }
    }
  });

  test("an attested ORCID iD gives orcid_verified false; no iD gives neither claim", async () => {
    const attested = await issue({
      scope: "openid orcid",
      account: { orcid: ORCID, orcidVerified: true, identity: null },
    });
    const claims = scopeClaimsOf(attested.issued.id_token);
    expect(claims).toMatchObject({ orcid: `https://orcid.org/${ORCID}`, orcid_verified: false });
    expect((await userinfo(attested.issued.access_token)).json).toMatchObject({
      orcid_verified: false,
    });
    // An oauth_identities row for ANOTHER iD is no proof of this one.
    const mismatched = await issue({
      scope: "openid orcid",
      account: { orcid: nextOrcid(), orcidVerified: true, identity: "0000-0001-5109-3700" },
    });
    expect(scopeClaimsOf(mismatched.issued.id_token)).toMatchObject({ orcid_verified: false });
    const none = await issue({ scope: "openid orcid", account: { orcid: null } });
    expect(scopeClaimsOf(none.issued.id_token)).toEqual({ sub: subjectOf(none.userId) });
  });

  test("names: a missing part is left out, never sent as null; an unverified email says so", async () => {
    const onlyGiven = await issue({
      scope: "openid profile email",
      account: { givenName: "Ada", familyName: null, emailVerified: false },
    });
    const claims = scopeClaimsOf(onlyGiven.issued.id_token);
    expect(claims).toMatchObject({ name: "Ada", given_name: "Ada", email_verified: false });
    expect("family_name" in claims).toBe(false);
    const noName = await issue({
      scope: "openid profile",
      account: { givenName: null, familyName: null },
    });
    expect(scopeClaimsOf(noName.issued.id_token)).toEqual({ sub: subjectOf(noName.userId) });
  });

  test("names are trimmed: surrounding spaces are not part of a name", async () => {
    const { issued } = await issue({
      scope: "openid profile",
      account: { givenName: "  Ada  ", familyName: " Lovelace " },
    });
    expect(scopeClaimsOf(issued.id_token)).toMatchObject({
      name: "Ada Lovelace",
      given_name: "Ada",
      family_name: "Lovelace",
    });
  });

  test("accountTier, for every caller: the provider serves only its active branches", () => {
    // The provider reads it only for an active account (base or upload). The other branches mirror
    // the website's `deriveAccountTier` for any other caller, and are held here rather than deleted.
    expect(accountTier("verified", false)).toBe("base");
    expect(accountTier("approved", true)).toBe("upload");
    expect(accountTier("verified", true)).toBe("upload");
    expect(accountTier("pending", true)).toBe("unverified");
    expect(accountTier("revoked", true)).toBeNull();
    expect(accountTier("unknown", false)).toBeNull();
  });

  test("the tier: an active account without upload access is base", async () => {
    const { issued } = await issue({
      scope: "openid nemar.account",
      account: { status: "verified", kind: "test" },
    });
    expect(scopeClaimsOf(issued.id_token)).toMatchObject({
      nemar_kind: "test",
      nemar_status: "verified",
      nemar_tier: "base",
    });
  });

  test("userinfo reads the account live: a change shows at the next call", async () => {
    const { userId, issued } = await issue({ scope: "openid profile" });
    h.db.query("UPDATE users SET given_name = 'Augusta' WHERE id = ?").run(userId);
    expect((await userinfo(issued.access_token)).json).toMatchObject({
      given_name: "Augusta",
      name: "Augusta Lovelace",
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Userinfo refusals
// ---------------------------------------------------------------------------------------------

describe("userinfo refuses what is not a live access token with openid", () => {
  test("no token, a CLI key, a refresh token, a client secret or garbage is 401, by GET and by POST", async () => {
    const { client, issued } = await issue({ scope: "openid offline_access" });
    for (const method of ["GET", "POST"] as const) {
      // No credential: the bare challenge, with no error code in it or in a body (RFC 6750 3.1).
      const none = await h.call(method, "/oauth/userinfo");
      expect({ method, status: none.status }).toEqual({ method, status: 401 });
      expect(none.headers.get("WWW-Authenticate")).toBe("Bearer");
      expect(none.headers.get("Cache-Control")).toBe("no-store");
      expect(none.text).toBe("");
      for (const token of [
        MEMBER_KEY,
        OWNER_KEY,
        issued.refresh_token as string,
        client.secret,
        `nmo_at_${"A".repeat(43)}`,
        "garbage",
      ]) {
        const res = await userinfo(token, method);
        expect({ method, token: token.slice(0, 8), status: res.status }).toEqual({
          method,
          token: token.slice(0, 8),
          status: 401,
        });
        expect(res.headers.get("WWW-Authenticate")).toBe('Bearer error="invalid_token"');
        expect(res.json?.error).toBe("invalid_token");
      }
    }
  });

  test("an expired or revoked token, a suspended or deleted account, a revoked grant or a disabled client is 401", async () => {
    const changes: Array<[string, (u: number, c: string, t: string) => Promise<void> | void]> = [
      [
        "expired",
        async (_u, _c, t) => {
          h.db
            .query(
              `UPDATE oidc_tokens SET created_at = datetime(created_at, '-16 minutes'),
                      expires_at = datetime(expires_at, '-16 minutes') WHERE token_hash = ?`,
            )
            .run(await hashApiKey(t));
        },
      ],
      [
        "revoked token",
        async (_u, _c, t) => {
          h.db
            .query(
              "UPDATE oidc_tokens SET revoked_at = datetime('now'), revoked_reason = 'test' WHERE token_hash = ?",
            )
            .run(await hashApiKey(t));
        },
      ],
      [
        "suspended",
        (u) => void h.db.query("UPDATE users SET status = 'revoked' WHERE id = ?").run(u),
      ],
      [
        "pending",
        (u) =>
          void h.db
            .query("UPDATE users SET status = 'pending', email_verified = 0 WHERE id = ?")
            .run(u),
      ],
      [
        "deleted",
        (u) => void h.db.query("UPDATE users SET deleted_at = datetime('now') WHERE id = ?").run(u),
      ],
      [
        "grant",
        (u) =>
          void h.db
            .query("UPDATE oidc_grants SET revoked_at = datetime('now') WHERE user_id = ?")
            .run(u),
      ],
      [
        "client",
        async (_u, c) => {
          const off = await h.call("POST", `/admin/oidc/clients/${c}/disable`, { key: OWNER_KEY });
          expect(off.status).toBe(200);
        },
      ],
    ];
    for (const [label, change] of changes) {
      const { client, userId, issued } = await issue({ scope: "openid" });
      expect((await userinfo(issued.access_token)).status).toBe(200);
      await change(userId, client.clientId, issued.access_token);
      const res = await userinfo(issued.access_token);
      expect({ label, status: res.status }).toEqual({ label, status: 401 });
      // The row itself was not touched by the read.
      const row = h.db
        .query<{ revoked_at: string | null }, [string]>(
          "SELECT revoked_at FROM oidc_tokens WHERE token_hash = ?",
        )
        .get(await hashApiKey(issued.access_token));
      // Disabling a client revokes what it holds (phase #2019), so that row is revoked by the disable
      // and not by the read; every other change leaves the row as it was.
      if (label === "client") expect(row?.revoked_at).not.toBeNull();
      else if (label !== "revoked token") expect(row?.revoked_at).toBeNull();
    }
  });

  test("a person_proven_orcid client's token stops reading once the proof is gone", async () => {
    const { userId, issued } = await issue({
      scope: "openid",
      clientOver: { sign_in_rule: "person_proven_orcid" },
      account: { orcid: ORCID, identity: ORCID },
    });
    expect((await userinfo(issued.access_token)).status).toBe(200);
    h.db.query("UPDATE users SET account_kind = 'service' WHERE id = ?").run(userId);
    expect((await userinfo(issued.access_token)).status).toBe(401);
  });

  test("a token without openid is 403 insufficient_scope", async () => {
    const machine = await registerClient(h, {
      allowed_scopes: ["compute.stats"],
      allowed_grants: ["client_credentials"],
      first_party: false,
    });
    const res = await formPost(
      h,
      "/oauth/token",
      { grant_type: "client_credentials" },
      { authorization: basic(machine.clientId, machine.secret) },
    );
    for (const method of ["GET", "POST"] as const) {
      const info = await userinfo((res.json as { access_token: string }).access_token, method);
      expect({ method, status: info.status }).toEqual({ method, status: 403 });
      expect(info.headers.get("WWW-Authenticate")).toBe(
        'Bearer error="insufficient_scope", scope="openid"',
      );
    }
    // A person's token that carries openid but was narrowed away from it by a refresh is the same.
    const narrowed = await issue({ scope: "openid profile offline_access" });
    const refreshed = await formPost(
      h,
      "/oauth/token",
      {
        grant_type: "refresh_token",
        refresh_token: narrowed.issued.refresh_token as string,
        scope: "profile",
      },
      { authorization: basic(narrowed.client.clientId, narrowed.client.secret) },
    );
    expect(refreshed.status).toBe(200);
    for (const method of ["GET", "POST"] as const) {
      const info = await userinfo(
        (refreshed.json as { access_token: string }).access_token,
        method,
      );
      expect({ method, status: info.status }).toEqual({ method, status: 403 });
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Revocation (RFC 7009)
// ---------------------------------------------------------------------------------------------

describe("revocation", () => {
  async function revoke(client: RegisteredClient, token: string, hint?: string) {
    return formPost(h, "/oauth/revoke", hint ? { token, token_type_hint: hint } : { token }, {
      authorization: basic(client.clientId, client.secret),
    });
  }

  test("revoking an access token ends it alone", async () => {
    const { client, issued } = await issue({ scope: "openid offline_access" });
    const res = await revoke(client, issued.access_token);
    expect(res.status).toBe(200);
    expect(res.text).toBe("");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect((await userinfo(issued.access_token)).status).toBe(401);
    // The refresh token still works.
    const refreshed = await formPost(
      h,
      "/oauth/token",
      { grant_type: "refresh_token", refresh_token: issued.refresh_token as string },
      { authorization: basic(client.clientId, client.secret) },
    );
    expect(refreshed.status).toBe(200);
  });

  test("revoking a refresh token ends its family, access tokens included, whatever the hint", async () => {
    const { client, issued } = await issue({ scope: "openid offline_access" });
    const res = await revoke(client, issued.refresh_token as string, "access_token");
    expect(res.status).toBe(200);
    expect((await userinfo(issued.access_token)).status).toBe(401);
    const rows = h.db
      .query<{ revoked_reason: string | null }, []>("SELECT revoked_reason FROM oidc_tokens")
      .all();
    expect(rows.map((r) => r.revoked_reason)).toEqual(["client_revoked", "client_revoked"]);
  });

  test("an unknown token, another client's token and a CLI key as the token all answer 200 and end nothing", async () => {
    const mine = await issue({ scope: "openid offline_access" });
    const other = await registerClient(h);
    for (const token of [
      `nmo_at_${"B".repeat(43)}`,
      "garbage",
      MEMBER_KEY,
      mine.issued.access_token,
      mine.issued.refresh_token as string,
    ]) {
      const res = await revoke(other, token);
      expect(res.status).toBe(200);
    }
    expect((await userinfo(mine.issued.access_token)).status).toBe(200);
    const revoked = h.db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM oidc_tokens WHERE revoked_at IS NOT NULL",
      )
      .get()?.n;
    expect(revoked).toBe(0);
  });

  test("the caller must authenticate as a client: a CLI key or no credentials is invalid_client", async () => {
    const { issued } = await issue({ scope: "openid" });
    for (const authorization of [`Bearer ${MEMBER_KEY}`, `Bearer ${OWNER_KEY}`, null]) {
      const res = await formPost(
        h,
        "/oauth/revoke",
        { token: issued.access_token },
        { authorization },
      );
      expect(res.status).toBe(401);
      expect(res.json?.error).toBe("invalid_client");
      expect(res.headers.get("WWW-Authenticate")).toMatch(/^Basic realm="/);
    }
    expect((await userinfo(issued.access_token)).status).toBe(200);
  });

  test("a request with no token is invalid_request", async () => {
    const { client } = await issue({ scope: "openid" });
    const res = await formPost(
      h,
      "/oauth/revoke",
      {},
      {
        authorization: basic(client.clientId, client.secret),
      },
    );
    expect({ status: res.status, error: res.json?.error }).toEqual({
      status: 400,
      error: "invalid_request",
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Introspection (RFC 7662)
// ---------------------------------------------------------------------------------------------

describe("introspection", () => {
  async function introspect(caller: RegisteredClient, token: string) {
    return formPost(
      h,
      "/oauth/introspect",
      { token },
      {
        authorization: basic(caller.clientId, caller.secret),
      },
    );
  }

  test("the issuing client sees its own live access token", async () => {
    const { client, userId, issued } = await issue({ scope: "openid profile" });
    const res = await introspect(client, issued.access_token);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = res.json as Record<string, unknown>;
    expect(body).toMatchObject({
      active: true,
      scope: "openid profile",
      client_id: client.clientId,
      token_type: "Bearer",
      sub: subjectOf(userId),
      aud: "https://api.example.org",
      iss: ISSUER,
    });
    expect((body.exp as number) - (body.iat as number)).toBe(900);
  });

  test("another client is told nothing, unless the token's audience is one it introspects", async () => {
    const { issued } = await issue({ scope: "openid offline_access" });
    const stranger = await registerClient(h);
    expect((await introspect(stranger, issued.access_token)).json).toEqual({ active: false });
    const resourceServer = await registerClient(h, {
      introspection_audiences: ["https://api.example.org"],
    });
    expect((await introspect(resourceServer, issued.access_token)).json).toMatchObject({
      active: true,
    });
    // A refresh token is shown to its own client only, whatever the audience.
    expect((await introspect(resourceServer, issued.refresh_token as string)).json).toEqual({
      active: false,
    });
    const otherAudience = await registerClient(h, {
      introspection_audiences: ["https://api.example.org/other"],
    });
    expect((await introspect(otherAudience, issued.access_token)).json).toEqual({ active: false });
  });

  test("a suspended or revoked account's token is inactive even though its row is live", async () => {
    for (const status of ["revoked", "pending"]) {
      const { client, userId, issued } = await issue({ scope: "openid" });
      // A pending account has no verified email (a trigger holds that).
      h.db
        .query("UPDATE users SET status = ?, email_verified = 0 WHERE id = ?")
        .run(status, userId);
      expect((await introspect(client, issued.access_token)).json).toEqual({ active: false });
      const row = h.db
        .query<{ revoked_at: string | null }, [string]>(
          "SELECT revoked_at FROM oidc_tokens WHERE token_hash = ?",
        )
        .get(await hashApiKey(issued.access_token));
      expect(row?.revoked_at).toBeNull();
    }
  });

  test("a spent, expired or revoked token, a CLI key and garbage are inactive", async () => {
    const { client, issued } = await issue({ scope: "openid offline_access" });
    // Spent: the refresh token after one rotation.
    const rotated = await formPost(
      h,
      "/oauth/token",
      { grant_type: "refresh_token", refresh_token: issued.refresh_token as string },
      { authorization: basic(client.clientId, client.secret) },
    );
    expect(rotated.status).toBe(200);
    expect((await introspect(client, issued.refresh_token as string)).json).toEqual({
      active: false,
    });
    const next = rotated.json as { refresh_token: string; access_token: string };
    const live = (await introspect(client, next.refresh_token)).json as Record<string, unknown>;
    expect(live).toMatchObject({ active: true, client_id: client.clientId });
    // RFC 7662's token_type names an access token's type; a refresh token gets none.
    expect("token_type" in live).toBe(false);
    for (const token of [MEMBER_KEY, "garbage", `nmo_rt_${"C".repeat(43)}`]) {
      expect((await introspect(client, token)).json).toEqual({ active: false });
    }
  });

  test("the caller must authenticate as a client; a CLI key is invalid_client", async () => {
    const { issued } = await issue({ scope: "openid" });
    for (const authorization of [`Bearer ${MEMBER_KEY}`, `Bearer ${issued.access_token}`, null]) {
      const res = await formPost(
        h,
        "/oauth/introspect",
        { token: issued.access_token },
        {
          authorization,
        },
      );
      expect(res.status).toBe(401);
      expect(res.json?.error).toBe("invalid_client");
    }
  });
});
