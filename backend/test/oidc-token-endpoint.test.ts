/**
 * The token endpoint (epic #2014 phase #2018; ADR 0119 rules 1, 3, 4 and 13), through the REAL Worker:
 * `POST /oauth/token` for the authorization code and client credentials grants, with HTTP Basic
 * client authentication. Refresh has its own suite (`oidc-token-refresh.test.ts`).
 *
 * Real throughout: every migration on bun:sqlite behind `realD1`, the real middleware stack, codes
 * minted by the real authorization routes from a real `__Host-` app session, clients from the owner's
 * route, keys from the owner's rotation, real SHA-256 for PKCE and the stored hashes, and the
 * identity token verified against the published key set. Time is advanced by editing rows, never by
 * a fake clock. One test forces two redemptions to interleave with `wrapD1`, a D1 that runs a hook
 * before a chosen statement, so the race the atomic claim exists for is real and deterministic.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import {
  OIDC_AUTHORIZE_CALLER_HEADER,
  OIDC_AUTHORIZE_CALLER_VALUE,
} from "../../shared/contract/oidc-authorize";
import { readBasicCredentials } from "../src/services/oidc-clients";
import { verifiedIdTokenClaims } from "../src/services/oidc-id-token";
import { CURRENT_KEY_SQL } from "../src/services/oidc-keys";
import { hashApiKey } from "../src/services/token";
import { realD1, wrapD1 } from "./helpers/d1";
import {
  FIRST_PARTY_REDIRECT,
  RFC_CHALLENGE,
  RFC_VERIFIER,
  type RegisteredClient,
  authorize,
  basic,
  decodeJwt,
  formPost,
  redeem,
  registerClient,
  rotateKeys,
  s256,
  seedAccount,
  sessionCookie,
  tokenRequest,
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

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

interface Flow {
  client: RegisteredClient;
  userId: number;
  cookie: string;
  code: string;
}

async function flow(
  opts: {
    clientOver?: Record<string, unknown>;
    account?: Parameters<typeof seedAccount>[1];
    scope?: string;
    challenge?: string;
  } = {},
): Promise<Flow> {
  const client = await registerClient(h, opts.clientOver);
  const userId = seedAccount(h, opts.account);
  const cookie = await sessionCookie(h, userId);
  const code = await authorize(h, client, cookie, {
    scope: opts.scope,
    challenge: opts.challenge,
  });
  return { client, userId, cookie, code };
}

function tokenRows(): Array<Record<string, unknown>> {
  return h.db.query("SELECT * FROM oidc_tokens ORDER BY id").all() as Array<
    Record<string, unknown>
  >;
}

/** The stored row of a code, found by its SHA-256 as the authorization routes store it. */
function codeRow(code: string): Record<string, unknown> | null {
  const hash = new Bun.CryptoHasher("sha256").update(code).digest("hex");
  return h.db.query("SELECT * FROM oidc_codes WHERE code_hash = ?").get(hash) as Record<
    string,
    unknown
  > | null;
}

/** A RFC 6749 section 5.2 error: the status, the code, no-store, and nothing but the two fields. */
function expectOauthError(
  res: { status: number; headers: Headers; json: Record<string, unknown> | null },
  status: number,
  error: string,
): void {
  expect({ status: res.status, error: res.json?.error }).toEqual({ status, error });
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect(res.headers.get("Pragma")).toBe("no-cache");
  expect(Object.keys(res.json ?? {}).sort()).toEqual(["error", "error_description"]);
  expect(typeof res.json?.error_description).toBe("string");
}

async function userinfoStatus(accessToken: string): Promise<number> {
  const res = await h.call("GET", "/oauth/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return res.status;
}

// ---------------------------------------------------------------------------------------------
// The surface
// ---------------------------------------------------------------------------------------------

describe("the token endpoint exists only on the OIDC surface with the __Host- flag on", () => {
  test("404 without the flag, without the secret, on another host, and under /nemar", async () => {
    const f = await flow();
    const form = {
      grant_type: "authorization_code",
      code: f.code,
      redirect_uri: f.client.redirect,
      code_verifier: RFC_VERIFIER,
    };
    const auth = basic(f.client.clientId, f.client.secret);
    for (const [label, path, env] of [
      ["flag off", "/oauth/token", { HOST_PREFIXED_SESSION_COOKIE: undefined }],
      ["flag not exactly 1", "/oauth/token", { HOST_PREFIXED_SESSION_COOKIE: "true" }],
      ["no secret", "/oauth/token", { OIDC_SECRET: undefined }],
      ["a secret not in the nmsso- form", "/oauth/token", { OIDC_SECRET: "s".repeat(70) }],
      ["legacy mount", "/nemar/oauth/token", {}],
    ] as const) {
      const res = await formPost(h, path, form, { authorization: auth, env });
      expect({ label, status: res.status }).toEqual({ label, status: 404 });
    }
    // Nothing above redeemed the code: it still works on the surface.
    expect((await redeem(h, f.client, f.code)).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------
// Client authentication: client_secret_basic only
// ---------------------------------------------------------------------------------------------

describe("client authentication is client_secret_basic, and nothing else", () => {
  test("no Authorization header is invalid_client with WWW-Authenticate: Basic", async () => {
    const f = await flow();
    const res = await formPost(h, "/oauth/token", {
      grant_type: "authorization_code",
      code: f.code,
      redirect_uri: f.client.redirect,
      code_verifier: RFC_VERIFIER,
    });
    expectOauthError(res, 401, "invalid_client");
    expect(res.headers.get("WWW-Authenticate")).toMatch(/^Basic realm="/);
  });

  test("a wrong secret, an unknown client, a malformed header and a CLI key are invalid_client", async () => {
    const f = await flow();
    const form = {
      grant_type: "authorization_code",
      code: f.code,
      redirect_uri: f.client.redirect,
      code_verifier: RFC_VERIFIER,
    };
    for (const authorization of [
      basic(f.client.clientId, `${f.client.secret.slice(0, -1)}x`),
      basic(`oc_${"0".repeat(24)}`, f.client.secret),
      basic(f.client.clientId, ""),
      `Basic ${btoa(f.client.clientId)}`, // no colon
      "Basic !!!not-base64!!!",
      `Bearer ${MEMBER_KEY}`,
      `Bearer ${OWNER_KEY}`,
      `basic ${btoa(`${f.client.clientId}:${f.client.secret}`)}`.replace("basic", "Digest"),
    ]) {
      const res = await formPost(h, "/oauth/token", form, { authorization });
      expectOauthError(res, 401, "invalid_client");
      expect(res.headers.get("WWW-Authenticate")).toMatch(/^Basic realm="/);
    }
    // None of them spent the code.
    expect(codeRow(f.code)?.used_at).toBeNull();
    expect((await redeem(h, f.client, f.code)).status).toBe(200);
  });

  test("form decoding reads `+` as a space and %2B as a plus (RFC 6749 2.3.1)", () => {
    // No NEMAR client id or secret holds a space or a plus, so this is held on the reader itself.
    expect(readBasicCredentials(basic("a b", "c+d"))).toEqual({ id: "a b", secret: "c+d" });
    expect(readBasicCredentials(`Basic ${btoa("a+b:c%2Bd")}`)).toEqual({
      id: "a b",
      secret: "c+d",
    });
    expect(readBasicCredentials(`Basic ${btoa("a%zz:c")}`)).toBeNull();
  });

  test("the id and secret are form-decoded before they are compared (RFC 6749 2.3.1)", async () => {
    const f = await flow();
    // Percent-encode every character of both halves: the decoded pair is the real one.
    const encodeAll = (s: string) =>
      Array.from(new TextEncoder().encode(s), (b) => `%${b.toString(16).padStart(2, "0")}`).join(
        "",
      );
    const res = await formPost(
      h,
      "/oauth/token",
      {
        grant_type: "authorization_code",
        code: f.code,
        redirect_uri: f.client.redirect,
        code_verifier: RFC_VERIFIER,
      },
      {
        authorization: `Basic ${btoa(`${encodeAll(f.client.clientId)}:${encodeAll(f.client.secret)}`)}`,
      },
    );
    expect(res.status).toBe(200);
  });

  test("a secret in the body is invalid_client, even beside a valid Basic header", async () => {
    const f = await flow();
    const base = {
      grant_type: "authorization_code",
      code: f.code,
      redirect_uri: f.client.redirect,
      code_verifier: RFC_VERIFIER,
    };
    for (const extra of [
      { client_secret: f.client.secret },
      { client_id: f.client.clientId, client_secret: f.client.secret },
      { client_assertion: "x", client_assertion_type: "y" },
      { client_id: `oc_${"1".repeat(24)}` },
    ]) {
      const withBasic = await formPost(
        h,
        "/oauth/token",
        { ...base, ...extra },
        { authorization: basic(f.client.clientId, f.client.secret) },
      );
      expectOauthError(withBasic, 401, "invalid_client");
      const withoutBasic = await formPost(h, "/oauth/token", { ...base, ...extra });
      expectOauthError(withoutBasic, 401, "invalid_client");
    }
    // The client's own id beside its Basic header is allowed (RFC 6749 3.2.1).
    const same = await formPost(
      h,
      "/oauth/token",
      { ...base, client_id: f.client.clientId },
      { authorization: basic(f.client.clientId, f.client.secret) },
    );
    expect(same.status).toBe(200);
  });

  test("a disabled client authenticates with neither secret", async () => {
    const f = await flow();
    const off = await h.call("POST", `/admin/oidc/clients/${f.client.clientId}/disable`, {
      key: OWNER_KEY,
    });
    expect(off.status).toBe(200);
    expectOauthError(await redeem(h, f.client, f.code), 401, "invalid_client");
  });

  test("the previous secret works until its grace ends, and not after", async () => {
    const f = await flow();
    const rotated = await h.call("POST", `/admin/oidc/clients/${f.client.clientId}/rotate-secret`, {
      key: OWNER_KEY,
      body: { graceHours: 1 },
    });
    expect(rotated.status).toBe(200);
    const fresh = (rotated.json as { client_secret: string }).client_secret;
    const old = f.client;
    const next = { ...f.client, secret: fresh };
    // The old secret inside the grace.
    expect((await redeem(h, old, f.code)).status).toBe(200);
    // The grace ends: only the new one is accepted.
    h.db
      .query(
        "UPDATE oidc_clients SET previous_secret_expires_at = datetime('now', '-1 second') WHERE client_id = ?",
      )
      .run(f.client.clientId);
    const code2 = await authorize(h, f.client, f.cookie);
    expectOauthError(await redeem(h, old, code2), 401, "invalid_client");
    expect((await redeem(h, next, code2)).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------
// The request's shape (RFC 6749 sections 3.2 and 5.2)
// ---------------------------------------------------------------------------------------------

describe("a malformed token request is refused before anything is read", () => {
  test("form encoding only; a repeated parameter; an unknown or missing grant type", async () => {
    const f = await flow();
    const auth = basic(f.client.clientId, f.client.secret);
    const good = `grant_type=authorization_code&code=${f.code}&redirect_uri=${encodeURIComponent(f.client.redirect)}&code_verifier=${RFC_VERIFIER}`;

    const json = await h.call("POST", "/oauth/token", {
      body: { grant_type: "authorization_code", code: f.code },
      headers: { Authorization: auth },
    });
    expectOauthError(json, 400, "invalid_request");
    // A body that IS a valid form, sent under another type (or none), is refused as well: the type
    // is checked, not only the shape the body happens to have.
    for (const type of ["application/json", "text/plain", "multipart/form-data; boundary=x", ""]) {
      const res = await h.call("POST", "/oauth/token", {
        rawBody: good,
        headers: { Authorization: auth, "Content-Type": type },
      });
      expect({ type, status: res.status, error: res.json?.error }).toEqual({
        type,
        status: 400,
        error: "invalid_request",
      });
    }
    expectOauthError(
      await formPost(h, "/oauth/token", `${good}&code=${f.code}`, { authorization: auth }),
      400,
      "invalid_request",
    );
    expectOauthError(
      await formPost(h, "/oauth/token", `${good}&grant_type=authorization_code`, {
        authorization: auth,
      }),
      400,
      "invalid_request",
    );
    expectOauthError(
      await formPost(
        h,
        "/oauth/token",
        { grant_type: "password", username: "a", password: "b" },
        {
          authorization: auth,
        },
      ),
      400,
      "unsupported_grant_type",
    );
    expectOauthError(
      await formPost(h, "/oauth/token", { code: f.code }, { authorization: auth }),
      400,
      "invalid_request",
    );
    // A body over the bound is refused unread.
    expectOauthError(
      await formPost(h, "/oauth/token", `${good}&pad=${"x".repeat(20_000)}`, {
        authorization: auth,
      }),
      400,
      "invalid_request",
    );
    // None of these spent the code.
    expect(codeRow(f.code)?.used_at).toBeNull();
    // The same form under the right type with a charset parameter is read, and redeems the code.
    const charset = await h.call("POST", "/oauth/token", {
      rawBody: good,
      headers: {
        Authorization: auth,
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      },
    });
    expect(charset.status).toBe(200);
  });

  test("a missing code, redirect_uri or code_verifier is invalid_request and spends nothing", async () => {
    const f = await flow();
    const full = {
      grant_type: "authorization_code",
      code: f.code,
      redirect_uri: f.client.redirect,
      code_verifier: RFC_VERIFIER,
    };
    for (const drop of ["code", "redirect_uri", "code_verifier"] as const) {
      const form: Record<string, string> = { ...full };
      delete form[drop];
      expectOauthError(await tokenRequest(h, f.client, form), 400, "invalid_request");
    }
    expect(codeRow(f.code)?.used_at).toBeNull();
  });

  test("a grant the client is not allowed is unauthorized_client", async () => {
    const client = await registerClient(h, {
      allowed_scopes: ["compute.stats"],
      allowed_grants: ["client_credentials"],
      first_party: false,
    });
    const res = await tokenRequest(h, client, {
      grant_type: "authorization_code",
      code: "x".repeat(43),
      redirect_uri: client.redirect,
      code_verifier: RFC_VERIFIER,
    });
    expectOauthError(res, 400, "unauthorized_client");
  });
});

// ---------------------------------------------------------------------------------------------
// Test 1: the authorization code grant
// ---------------------------------------------------------------------------------------------

describe("redeeming a code with PKCE", () => {
  test("answers an identity token, an access token and no-store; the tokens are stored only hashed", async () => {
    const f = await flow({ scope: "openid profile" });
    const res = await redeem(h, f.client, f.code);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Pragma")).toBe("no-cache");
    const body = res.json as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "access_token",
      "expires_in",
      "id_token",
      "scope",
      "token_type",
    ]);
    expect(body.token_type).toBe("Bearer");
    expect(body.expires_in).toBe(900);
    expect(body.scope).toBe("openid profile");
    expect(body.access_token as string).toMatch(/^nmo_at_[A-Za-z0-9_-]{43}$/);

    // Stored hashed: the SHA-256 is there, the value is nowhere in the table.
    const rows = tokenRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).toBe(await hashApiKey(body.access_token as string));
    expect(JSON.stringify(rows)).not.toContain((body.access_token as string).slice(7));
    expect(rows[0]).toMatchObject({ kind: "access", user_id: f.userId, revoked_at: null });

    // The identity token verifies against the published keys and names this provider.
    const claims = await verifiedIdTokenClaims(h.env, body.id_token as string);
    expect(claims).not.toBeNull();
    const subject = h.db
      .query<{ oidc_subject: string }, [number]>("SELECT oidc_subject FROM users WHERE id = ?")
      .get(f.userId)?.oidc_subject;
    expect(claims).toMatchObject({
      iss: ISSUER,
      sub: subject,
      aud: f.client.clientId,
      nonce: "n-0S6_WzA2Mj",
    });
    const iat = claims?.iat as number;
    expect(claims?.exp).toBe(iat + 300);
    expect(Math.abs(iat - Date.now() / 1000)).toBeLessThan(5);
    expect(decodeJwt(body.id_token as string).header).toMatchObject({ alg: "ES256", typ: "JWT" });

    // at_hash: the left half of SHA-256 of the access token, base64url (OpenID Connect Core 3.1.3.6).
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.access_token as string)),
    );
    const left = btoa(String.fromCharCode(...digest.slice(0, 16)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(claims?.at_hash).toBe(left);

    // The access token works at userinfo.
    expect(await userinfoStatus(body.access_token as string)).toBe(200);
  });

  test("auth_time is the session's sign-in, copied from the code; no nonce means no nonce claim", async () => {
    const client = await registerClient(h);
    const userId = seedAccount(h);
    const cookie = await sessionCookie(h, userId);
    // The session was signed in an hour ago.
    h.db
      .query(
        "UPDATE web_sessions SET created_at = datetime('now', '-3600 seconds') WHERE user_id = ?",
      )
      .run(userId);
    const code = await authorize(h, client, cookie, { nonce: null });
    const res = await redeem(h, client, code);
    const claims = decodeJwt((res.json as { id_token: string }).id_token).claims;
    const sessionUnix = h.db
      .query<{ t: number }, [number]>(
        "SELECT CAST(strftime('%s', created_at) AS INTEGER) AS t FROM web_sessions WHERE user_id = ?",
      )
      .get(userId)?.t as number;
    expect(claims.auth_time).toBe(sessionUnix);
    expect((claims.iat as number) - (claims.auth_time as number)).toBeGreaterThanOrEqual(3599);
    expect("nonce" in claims).toBe(false);
  });

  test("a wrong verifier is invalid_grant and writes nothing; the right one still redeems", async () => {
    const f = await flow();
    const other = "a".repeat(43);
    expectOauthError(
      await redeem(h, f.client, f.code, { code_verifier: other }),
      400,
      "invalid_grant",
    );
    expect(codeRow(f.code)?.used_at).toBeNull();
    expect(tokenRows()).toHaveLength(0);
    expect((await redeem(h, f.client, f.code)).status).toBe(200);
  });

  test("the verifier must be 43 to 128 unreserved characters (RFC 7636 4.1)", async () => {
    for (const [verifier, status] of [
      ["a".repeat(42), 400],
      ["a".repeat(129), 400],
      ["a".repeat(43), 200],
      [`${"A1-._~".repeat(21)}zz`, 200], // 128 characters, every unreserved class
      [`${"a".repeat(42)}+`, 400],
      [`${"a".repeat(42)} `, 400],
    ] as const) {
      const challenge = await s256(verifier);
      const f = await flow({ challenge });
      const res = await redeem(h, f.client, f.code, { code_verifier: verifier });
      expect({ len: verifier.length, verifier: verifier.slice(-2), status: res.status }).toEqual({
        len: verifier.length,
        verifier: verifier.slice(-2),
        status,
      });
      if (status === 400) {
        expectOauthError(res, 400, "invalid_request");
        expect(codeRow(f.code)?.used_at).toBeNull();
      }
    }
  });

  test("a wrong redirect_uri is invalid_grant and writes nothing", async () => {
    const f = await flow();
    for (const redirect of [`${FIRST_PARTY_REDIRECT}/`, "https://tools.nemar.org/other"]) {
      expectOauthError(
        await redeem(h, f.client, f.code, { redirect_uri: redirect }),
        400,
        "invalid_grant",
      );
    }
    expect(codeRow(f.code)?.used_at).toBeNull();
    expect((await redeem(h, f.client, f.code)).status).toBe(200);
  });

  test("another client's code is invalid_grant and writes nothing, used or not", async () => {
    const f = await flow();
    const other = await registerClient(h);
    expectOauthError(await redeem(h, other, f.code), 400, "invalid_grant");
    expect(codeRow(f.code)?.used_at).toBeNull();
    const first = await redeem(h, f.client, f.code);
    expect(first.status).toBe(200);
    // A used code presented by ANOTHER client is not a replay of the owner's: nothing is revoked.
    expectOauthError(await redeem(h, other, f.code), 400, "invalid_grant");
    expect(tokenRows().every((r) => r.revoked_at === null)).toBe(true);
    expect(await userinfoStatus((first.json as { access_token: string }).access_token)).toBe(200);
  });

  test("an unknown or expired code is invalid_grant and writes nothing", async () => {
    const f = await flow();
    expectOauthError(await redeem(h, f.client, f.client.secret.slice(7)), 400, "invalid_grant");
    h.db
      .query(
        `UPDATE oidc_codes SET created_at = datetime('now', '-61 seconds'),
                expires_at = datetime('now', '-1 second') WHERE code_hash = ?`,
      )
      .run(await hashApiKey(f.code));
    expectOauthError(await redeem(h, f.client, f.code), 400, "invalid_grant");
    expect(codeRow(f.code)?.used_at).toBeNull();
    expect(tokenRows()).toHaveLength(0);
  });

  test("a second redemption fails and revokes every token the first one issued (code_replay)", async () => {
    const f = await flow({ scope: "openid offline_access" });
    const first = await redeem(h, f.client, f.code);
    expect(first.status).toBe(200);
    const issued = first.json as { access_token: string; refresh_token: string };
    expect(issued.refresh_token).toMatch(/^nmo_rt_/);
    expect(await userinfoStatus(issued.access_token)).toBe(200);

    const second = await redeem(h, f.client, f.code);
    expectOauthError(second, 400, "invalid_grant");

    const rows = tokenRows();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({ revoked_reason: "code_replay" });
      expect(row.revoked_at).not.toBeNull();
    }
    expect(await userinfoStatus(issued.access_token)).toBe(401);
    // The refresh token it issued is dead too.
    const refresh = await tokenRequest(h, f.client, {
      grant_type: "refresh_token",
      refresh_token: issued.refresh_token,
    });
    expectOauthError(refresh, 400, "invalid_grant");
    // Nothing but the revocation was written: no new token, and the code row is as the first left it.
    expect(tokenRows()).toHaveLength(2);
  });

  test("a used code presented with a wrong verifier or redirect is refused and writes nothing", async () => {
    // Revoking on such a presentation would let someone who captured a victim's code have the
    // legitimate client present it again with another verifier and end the victim's tokens. Detection
    // is not lost: whoever redeemed first held the right verifier, so a real second redemption by the
    // legitimate client still matches, and still revokes (the test above).
    for (const over of [
      { code_verifier: "b".repeat(43) },
      { redirect_uri: "https://tools.nemar.org/x" },
    ]) {
      const f = await flow();
      const first = await redeem(h, f.client, f.code);
      expect(first.status).toBe(200);
      expectOauthError(await redeem(h, f.client, f.code, over), 400, "invalid_grant");
      const rows = tokenRows().filter((r) => r.user_id === f.userId);
      expect(rows.map((r) => r.revoked_at)).toEqual([null]);
      expect(await userinfoStatus((first.json as { access_token: string }).access_token)).toBe(200);
    }
  });

  test("a used code presented with a missing or malformed verifier, or no redirect, revokes nothing", async () => {
    const f = await flow();
    const first = await redeem(h, f.client, f.code);
    expect(first.status).toBe(200);
    for (const form of [
      { grant_type: "authorization_code", code: f.code, redirect_uri: f.client.redirect },
      {
        grant_type: "authorization_code",
        code: f.code,
        redirect_uri: f.client.redirect,
        code_verifier: "short",
      },
      { grant_type: "authorization_code", code: f.code, code_verifier: RFC_VERIFIER },
    ]) {
      expectOauthError(await tokenRequest(h, f.client, form), 400, "invalid_request");
    }
    expect(tokenRows().map((r) => r.revoked_at)).toEqual([null]);
  });

  test("a second redemption after a rotation revokes the rotated tokens too: they carry the code", async () => {
    const f = await flow({ scope: "openid offline_access" });
    const first = (await redeem(h, f.client, f.code)).json as { refresh_token: string };
    const rotated = await tokenRequest(h, f.client, {
      grant_type: "refresh_token",
      refresh_token: first.refresh_token,
    });
    expect(rotated.status).toBe(200);
    const child = rotated.json as { access_token: string; refresh_token: string };
    expect(tokenRows()).toHaveLength(4);
    expectOauthError(await redeem(h, f.client, f.code), 400, "invalid_grant");
    for (const row of tokenRows()) expect(row.revoked_at).not.toBeNull();
    expect(await userinfoStatus(child.access_token)).toBe(401);
  });

  test("two redemptions in flight together: one claim wins, one set is minted, and it is revoked", async () => {
    const f = await flow({ scope: "openid offline_access" });
    // Hold the first request just after it has read the code and before its batch (it reads the
    // signing key to sign the identity token), and run the second redemption to completion there.
    let raced = false;
    let inner: Awaited<ReturnType<typeof redeem>> | null = null;
    const racing = wrapD1(realD1(h.db), async (sql) => {
      if (sql === CURRENT_KEY_SQL && !raced) {
        raced = true;
        inner = await redeem(h, f.client, f.code);
      }
    });
    const outer = await redeem(h, f.client, f.code, {}, { env: { DB: racing } });
    expect(raced).toBe(true);
    // The inner request ran to completion first: it won the claim.
    expect((inner as unknown as { status: number }).status).toBe(200);
    // The outer one lost it, and its loss is a second redemption of the code.
    expectOauthError(outer, 400, "invalid_grant");
    const rows = tokenRows();
    expect(rows.map((r) => r.kind).sort()).toEqual(["access", "refresh"]);
    expect(rows.every((r) => r.revoked_reason === "code_replay")).toBe(true);
  });

  test("the account's sign-in rule is applied again at redemption", async () => {
    for (const change of [
      "UPDATE users SET status = 'revoked' WHERE id = ?",
      "UPDATE users SET status = 'pending', email_verified = 0 WHERE id = ?",
      "UPDATE users SET deleted_at = datetime('now') WHERE id = ?",
    ]) {
      const f = await flow();
      h.db.query(change).run(f.userId);
      expectOauthError(await redeem(h, f.client, f.code), 400, "invalid_grant");
      expect(codeRow(f.code)?.used_at).toBeNull();
    }
    // person_proven_orcid: the proof is read again too.
    const orcid = "0000-0002-1825-0097";
    const f = await flow({
      clientOver: { sign_in_rule: "person_proven_orcid" },
      account: { orcid, identity: orcid },
    });
    h.db.query("DELETE FROM oauth_identities WHERE user_id = ?").run(f.userId);
    expectOauthError(await redeem(h, f.client, f.code), 400, "invalid_grant");
    expect(tokenRows()).toHaveLength(0);
  });

  test("a revoked grant mints nothing", async () => {
    const f = await flow();
    h.db
      .query("UPDATE oidc_grants SET revoked_at = datetime('now') WHERE user_id = ?")
      .run(f.userId);
    expectOauthError(await redeem(h, f.client, f.code), 400, "invalid_grant");
    expect(codeRow(f.code)?.used_at).toBeNull();
    expect(tokenRows()).toHaveLength(0);
  });

  test("tokens carry the CODE's scopes, never the grant's wider union", async () => {
    const client = await registerClient(h);
    const userId = seedAccount(h);
    const cookie = await sessionCookie(h, userId);
    // A first authorization widens the grant to profile and email ...
    const wide = await authorize(h, client, cookie, { scope: "openid profile email" });
    expect((await redeem(h, client, wide)).status).toBe(200);
    // ... a second asks only for openid.
    const narrow = await authorize(h, client, cookie, { scope: "openid" });
    const res = await redeem(h, client, narrow);
    expect((res.json as { scope: string }).scope).toBe("openid");
    const claims = decodeJwt((res.json as { id_token: string }).id_token).claims;
    expect("email" in claims || "name" in claims).toBe(false);
    expect(JSON.parse(tokenRows().at(-1)?.scopes as string)).toEqual(["openid"]);
  });

  test("no refresh token without offline_access", async () => {
    const f = await flow({ scope: "openid profile" });
    const res = await redeem(h, f.client, f.code);
    expect(res.status).toBe(200);
    expect("refresh_token" in (res.json as object)).toBe(false);
    expect(tokenRows().map((r) => r.kind)).toEqual(["access"]);
  });

  test("with offline_access a refresh token of the same family is issued", async () => {
    const f = await flow({ scope: "openid offline_access" });
    const res = await redeem(h, f.client, f.code);
    const body = res.json as { refresh_token: string; scope: string };
    expect(body.refresh_token).toMatch(/^nmo_rt_[A-Za-z0-9_-]{43}$/);
    expect(body.scope).toBe("offline_access openid");
    const [access, refresh] = tokenRows();
    expect(refresh).toMatchObject({ kind: "refresh", family_id: access?.family_id });
    expect(refresh?.code_id).toBe(access?.code_id);
    expect(refresh?.token_hash).toBe(await hashApiKey(body.refresh_token));
  });

  test("a code that carries a machine-only scope is never redeemed (compute.stats)", async () => {
    // The authorization routes refuse compute.stats outright ...
    const client = await registerClient(h, {
      allowed_scopes: ["openid", "compute.stats"],
      allowed_grants: ["authorization_code", "client_credentials"],
    });
    const userId = seedAccount(h);
    const cookie = await sessionCookie(h, userId);
    const check = await h.call("POST", "/auth/oidc/authorize", {
      body: {
        request: new URLSearchParams({
          client_id: client.clientId,
          redirect_uri: client.redirect,
          response_type: "code",
          scope: "openid compute.stats",
          code_challenge: RFC_CHALLENGE,
          code_challenge_method: "S256",
        }).toString(),
      },
      headers: {
        Cookie: cookie,
        Origin: "https://app.nemar.org",
        [OIDC_AUTHORIZE_CALLER_HEADER]: OIDC_AUTHORIZE_CALLER_VALUE,
      },
    });
    expect(new URL((check.json as { location: string }).location).searchParams.get("error")).toBe(
      "invalid_scope",
    );
    // ... and a code row that carries it anyway (written here by hand, which is the point: no route
    // can write one) is refused by the token endpoint.
    const code = await authorize(h, client, cookie, { scope: "openid" });
    h.db
      .query(`UPDATE oidc_codes SET scopes = '["compute.stats","openid"]' WHERE code_hash = ?`)
      .run(await hashApiKey(code));
    h.db
      .query(`UPDATE oidc_grants SET scopes = '["compute.stats","openid"]' WHERE user_id = ?`)
      .run(userId);
    expectOauthError(await redeem(h, client, code), 400, "invalid_grant");
    expect(tokenRows()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Test 6: client credentials
// ---------------------------------------------------------------------------------------------

describe("the client credentials grant", () => {
  async function machineClient(over: Record<string, unknown> = {}): Promise<RegisteredClient> {
    return registerClient(h, {
      allowed_scopes: ["compute.stats"],
      allowed_grants: ["client_credentials"],
      first_party: false,
      ...over,
    });
  }

  test("a machine-only scope gets one access token: no identity token, no refresh token, no account", async () => {
    const client = await machineClient();
    for (const form of [
      { grant_type: "client_credentials", scope: "compute.stats" },
      { grant_type: "client_credentials" }, // the client's machine scopes by default
    ]) {
      const res = await tokenRequest(h, client, form);
      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      const body = res.json as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual([
        "access_token",
        "expires_in",
        "scope",
        "token_type",
      ]);
      expect(body.scope).toBe("compute.stats");
    }
    const rows = tokenRows();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({
        kind: "access",
        user_id: null,
        grant_id: null,
        code_id: null,
        family_id: null,
        parent_id: null,
      });
    }
  });

  test("a client without the grant is unauthorized_client", async () => {
    const f = await flow();
    expectOauthError(
      await tokenRequest(h, f.client, { grant_type: "client_credentials", scope: "openid" }),
      400,
      "unauthorized_client",
    );
    expect(tokenRows()).toHaveLength(0);
  });

  test("a scope a person grants, an unknown scope or one the client may not have is invalid_scope", async () => {
    const client = await machineClient({
      allowed_scopes: ["openid", "compute.stats"],
      allowed_grants: ["authorization_code", "client_credentials"],
      first_party: true,
    });
    for (const scope of [
      "openid",
      "compute.stats openid",
      "compute.read",
      "nonsense",
      "compute.stats nonsense",
    ]) {
      expectOauthError(
        await tokenRequest(h, client, { grant_type: "client_credentials", scope }),
        400,
        "invalid_scope",
      );
    }
    expect(tokenRows()).toHaveLength(0);
  });

  test("a client-credentials token never reaches userinfo, and introspects with no subject", async () => {
    const client = await machineClient();
    const res = await tokenRequest(h, client, { grant_type: "client_credentials" });
    const token = (res.json as { access_token: string }).access_token;
    const info = await h.call("GET", "/oauth/userinfo", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(info.status).toBe(403);
    expect(info.headers.get("WWW-Authenticate")).toContain('error="insufficient_scope"');
    const intro = await formPost(
      h,
      "/oauth/introspect",
      { token },
      {
        authorization: basic(client.clientId, client.secret),
      },
    );
    expect(intro.status).toBe(200);
    expect(intro.json).toMatchObject({
      active: true,
      client_id: client.clientId,
      scope: "compute.stats",
    });
    expect("sub" in (intro.json as object)).toBe(false);
  });
});
