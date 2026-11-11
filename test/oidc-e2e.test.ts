/**
 * Sign in with NEMAR, end to end (epic #2014 phase #2020; ADR 0119): an unmodified third-party
 * relying-party library (`openid-client`, built on `oauth4webapi`, with `jose` for the checks neither
 * makes) completes the whole flow against the REAL Worker entry point over real SQLite carrying every
 * migration, served by `Bun.serve` on a loopback port whose address is the Worker's own issuer.
 *
 * Nothing here replaces NEMAR logic. The keys come from the owner's rotation route, the client from the
 * owner's creation route, the code from the authorization check and consent routes exactly as the
 * website's page calls them, every token from the token endpoint, and the logout from the Worker's own
 * sender. What is a stand-in is the PARTNER: its back-channel logout address is a real HTTPS server on
 * the loopback interface that records what it receives (`oidc-logout-standin.ts`).
 *
 * The library has no back-channel logout verifier, so the logout token is verified with `jose` by
 * `verifyLogoutToken` below, which is the check a partner must make. Its negative controls prove the
 * verifier itself rejects what it must (an unsigned token, a token signed by another key, a wrong
 * issuer, a wrong audience, a wrong type, an absent `events` member, an `events` member without the
 * logout event, an expired token, a nonce), so that "the logout token verified" in the end-to-end test
 * means something.
 *
 * The properties, each with a test of its own:
 *  - the whole flow: authorize and consent, redeem with PKCE, verify the identity token, userinfo,
 *    refresh, introspection, the refusal of the access token on the rest of the API, a replayed code,
 *    an administrator's revoke, and the logout the partner receives;
 *  - the verifier rejects alg none, a foreign signer, a wrong iss, a wrong aud, a wrong typ, an absent
 *    events member, events without the logout event, an expired token and a token carrying a nonce;
 *  - the loser of a manual merge keeps the merge as the reason when the owner ends it first, and records
 *    the revocation when the order is reversed.
 *
 * CI TIER: process. It serves the real Worker on a loopback port and its partner stand-in makes a
 * throwaway certificate with `openssl`, and a file that listens on a port or spawns a process does not belong
 * in a `unit-pure` shard. It holds none of the markers that route a file to the integration tier and needs
 * no live backend: the Worker, the partner stand-in and the library's calls all stay on loopback addresses.
 * The file sets no timeout of its own, so it runs under the default.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  type JWTVerifyGetKey,
  SignJWT,
  createLocalJWKSet,
  createRemoteJWKSet,
  decodeJwt,
  exportJWK,
  generateKeyPair,
  jwtVerify,
} from "jose";
import * as client from "openid-client";
import worker from "../backend/src/index";
import type { Bindings } from "../backend/src/types/bindings";
import {
  deliveries,
  registerLogoutClient,
  revokedReasons,
  seedProvenAccount,
  signInAt,
} from "../backend/test/helpers/oidc-cascade";
import {
  APP,
  THIRD_PARTY_REDIRECT,
  rotateKeys,
  s256,
  seedAccount,
  sessionCookie,
} from "../backend/test/helpers/oidc-flow";
import {
  OWNER_KEY,
  type OidcHarness,
  clientBody,
  startOidcHarness,
} from "../backend/test/helpers/oidc-harness";
import {
  type LogoutStandin,
  startLogoutStandin,
} from "../backend/test/helpers/oidc-logout-standin";
import {
  OIDC_AUTHORIZE_CALLER_HEADER,
  OIDC_AUTHORIZE_CALLER_VALUE,
  OIDC_AUTHORIZE_CHECK_PATH,
  OIDC_AUTHORIZE_CONSENT_PATH,
} from "../shared/contract/oidc-authorize";
import {
  OIDC_BACKCHANNEL_LOGOUT_EVENT,
  OIDC_LOGOUT_TOKEN_TTL_SECONDS,
  OIDC_SIGNING_ALG,
} from "../shared/oidc";

// ---------------------------------------------------------------------------------------------
// The verifier a partner must run on a logout token
// ---------------------------------------------------------------------------------------------

/**
 * OpenID Connect Back-Channel Logout 1.0, section 2.6, with the explicit type of RFC 8725: the signature
 * against the issuer's key set with only ES256 allowed (so `alg: none` is refused before anything
 * else), the `typ` header, `iss`, `aud` (this client's id), the expiry, the `events` member, no `nonce`,
 * and a `sub`. Returns the claims; throws what `jose` throws, which the controls assert.
 */
async function verifyLogoutToken(
  token: string,
  keys: JWTVerifyGetKey,
  expected: { issuer: string; clientId: string },
): Promise<Record<string, unknown>> {
  const { payload } = await jwtVerify(token, keys, {
    issuer: expected.issuer,
    audience: expected.clientId,
    typ: "logout+jwt",
    algorithms: [OIDC_SIGNING_ALG],
    requiredClaims: ["iss", "aud", "iat", "exp", "jti", "events", "sub"],
  });
  const events = payload.events as Record<string, unknown> | undefined;
  if (!events || typeof events !== "object" || !(OIDC_BACKCHANNEL_LOGOUT_EVENT in events)) {
    throw new Error("the logout token has no back-channel logout event");
  }
  if ("nonce" in payload) throw new Error("a logout token must not carry a nonce");
  return payload as Record<string, unknown>;
}

// ---------------------------------------------------------------------------------------------
// The negative controls: the verifier itself, with tokens made here
// ---------------------------------------------------------------------------------------------

const CONTROL_ISSUER = "https://issuer.example.org";
const CONTROL_CLIENT = "oc_000000000000000000000001";

const b64u = (s: string) => Buffer.from(s).toString("base64url");

describe("the logout token verifier rejects what it must", () => {
  let keys: JWTVerifyGetKey;
  let sign: (over?: {
    aud?: string;
    typ?: string;
    nonce?: string;
    iss?: string;
    /** `null` leaves the member out; an object replaces it. */
    events?: Record<string, unknown> | null;
    /** Seconds from now the token expires: negative for an expired one. */
    expiresIn?: number;
  }) => Promise<string>;

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair(OIDC_SIGNING_ALG);
    const jwk = { ...(await exportJWK(publicKey)), kid: "control-key", alg: OIDC_SIGNING_ALG };
    keys = createLocalJWKSet({ keys: [jwk] });
    sign = async (over = {}) => {
      const claims: Record<string, unknown> = {
        sub: "nmu_00000000000000000000000000000001",
        events: { [OIDC_BACKCHANNEL_LOGOUT_EVENT]: {} },
      };
      if (over.events === null) claims.events = undefined;
      else if (over.events !== undefined) claims.events = over.events;
      if (over.nonce !== undefined) claims.nonce = over.nonce;
      const now = Math.floor(Date.now() / 1000);
      const expiresIn = over.expiresIn ?? OIDC_LOGOUT_TOKEN_TTL_SECONDS;
      return new SignJWT(claims)
        .setProtectedHeader({
          alg: OIDC_SIGNING_ALG,
          kid: "control-key",
          typ: over.typ ?? "logout+jwt",
        })
        .setIssuer(over.iss ?? CONTROL_ISSUER)
        .setAudience(over.aud ?? CONTROL_CLIENT)
        .setIssuedAt(Math.min(now, now + expiresIn - 1))
        .setExpirationTime(now + expiresIn)
        .setJti(crypto.randomUUID())
        .sign(privateKey);
    };
  });

  const verify = (token: string) =>
    verifyLogoutToken(token, keys, { issuer: CONTROL_ISSUER, clientId: CONTROL_CLIENT });

  test("accepts a well-formed token (so every refusal below is about its own defect)", async () => {
    const claims = await verify(await sign());
    expect(claims.sub).toBe("nmu_00000000000000000000000000000001");
  });

  test("rejects alg none, with or without the rest being right", async () => {
    const header = b64u(JSON.stringify({ alg: "none", typ: "logout+jwt" }));
    const body = b64u(
      JSON.stringify({
        iss: CONTROL_ISSUER,
        aud: CONTROL_CLIENT,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 120,
        jti: "unsigned-1",
        sub: "nmu_00000000000000000000000000000001",
        events: { [OIDC_BACKCHANNEL_LOGOUT_EVENT]: {} },
      }),
    );
    for (const token of [`${header}.${body}.`, `${header}.${body}.AAAA`]) {
      await expect(verify(token)).rejects.toMatchObject({ code: "ERR_JOSE_ALG_NOT_ALLOWED" });
    }
  });

  test("rejects a token signed by another key", async () => {
    const other = await generateKeyPair(OIDC_SIGNING_ALG);
    const forged = await new SignJWT({
      sub: "nmu_00000000000000000000000000000001",
      events: { [OIDC_BACKCHANNEL_LOGOUT_EVENT]: {} },
    })
      .setProtectedHeader({ alg: OIDC_SIGNING_ALG, kid: "control-key", typ: "logout+jwt" })
      .setIssuer(CONTROL_ISSUER)
      .setAudience(CONTROL_CLIENT)
      .setIssuedAt()
      .setExpirationTime("2m")
      .setJti("forged-1")
      .sign(other.privateKey);
    await expect(verify(forged)).rejects.toMatchObject({
      code: "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
    });
  });

  test("rejects a wrong aud", async () => {
    await expect(verify(await sign({ aud: "oc_000000000000000000000002" }))).rejects.toMatchObject({
      code: "ERR_JWT_CLAIM_VALIDATION_FAILED",
      claim: "aud",
    });
  });

  test("rejects a wrong typ (an identity token is not a logout token)", async () => {
    await expect(verify(await sign({ typ: "JWT" }))).rejects.toMatchObject({
      code: "ERR_JWT_CLAIM_VALIDATION_FAILED",
      claim: "typ",
    });
  });

  test("rejects a wrong iss", async () => {
    await expect(verify(await sign({ iss: "https://other.example.org" }))).rejects.toMatchObject({
      code: "ERR_JWT_CLAIM_VALIDATION_FAILED",
      claim: "iss",
    });
  });

  test("rejects a token with no events member", async () => {
    await expect(verify(await sign({ events: null }))).rejects.toMatchObject({
      code: "ERR_JWT_CLAIM_VALIDATION_FAILED",
      claim: "events",
    });
  });

  test("rejects a token whose events lack the back-channel logout event", async () => {
    await expect(
      verify(await sign({ events: { "http://schemas.openid.net/event/other": {} } })),
    ).rejects.toThrow(/no back-channel logout event/);
    await expect(verify(await sign({ events: {} }))).rejects.toThrow(
      /no back-channel logout event/,
    );
  });

  test("rejects an expired token", async () => {
    await expect(verify(await sign({ expiresIn: -60 }))).rejects.toMatchObject({
      code: "ERR_JWT_EXPIRED",
    });
  });

  test("rejects a token that carries a nonce", async () => {
    await expect(verify(await sign({ nonce: "n-0S6_WzA2Mj" }))).rejects.toThrow(
      /must not carry a nonce/,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// The flow, against the real Worker over a loopback port
// ---------------------------------------------------------------------------------------------

const pending: Promise<unknown>[] = [];
/** What the work handed to `waitUntil` threw: a logout failure shows its cause instead of vanishing. */
const waitUntilFailures: unknown[] = [];
const ctx = {
  waitUntil: (p: Promise<unknown>) => {
    pending.push(
      p.catch((err) => {
        waitUntilFailures.push(err);
        console.error("[oidc-e2e] background work failed:", err);
      }),
    );
  },
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

/** Wait for the work the requests handed to `waitUntil` (a logout's first attempt). */
async function settle(): Promise<void> {
  while (pending.length > 0) await Promise.all(pending.splice(0, pending.length));
}

let h: OidcHarness;
let env: Bindings;
const server = Bun.serve({
  port: 0,
  fetch: (req) => worker.fetch(req, env, ctx),
});
const API = `http://127.0.0.1:${server.port}`;

afterAll(() => server.stop(true));

interface Reply {
  status: number;
  headers: Headers;
  text: string;
  json: Record<string, unknown> | null;
}

/** One request to the served Worker, over HTTP. */
async function api(
  method: string,
  path: string,
  opts: { key?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Reply> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.key) headers.Authorization = `Bearer ${opts.key}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    redirect: "manual",
  });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(text);
    json = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, text, json };
}

/** The headers the website's authorization page sends: its pinned Origin and the caller marker. */
const pageHeaders = (cookie: string) => ({
  Cookie: cookie,
  Origin: APP,
  [OIDC_AUTHORIZE_CALLER_HEADER]: OIDC_AUTHORIZE_CALLER_VALUE,
});

/**
 * Drive the authorization check, and the consent screen's "allow" if the check asks for consent, as the
 * page would. Returns the address the person is sent back to (the redirect carrying `code`).
 */
async function authorizeAsPage(
  authorizationUrl: URL,
  cookie: string,
): Promise<{ location: URL; consented: boolean }> {
  const request = authorizationUrl.searchParams.toString();
  const check = await api("POST", OIDC_AUTHORIZE_CHECK_PATH, {
    body: { request },
    headers: pageHeaders(cookie),
  });
  if (check.status !== 200) {
    throw new Error(`the authorization check answered ${check.status}: ${check.text}`);
  }
  let answer = check.json as Record<string, unknown>;
  let consented = false;
  if (answer.kind === "consent") {
    consented = true;
    const consent = await api("POST", OIDC_AUTHORIZE_CONSENT_PATH, {
      body: { request, consent_token: answer.consent_token, decision: "allow" },
      headers: pageHeaders(cookie),
    });
    if (consent.status !== 200) {
      throw new Error(`the consent decision answered ${consent.status}: ${consent.text}`);
    }
    answer = consent.json as Record<string, unknown>;
  }
  if (answer.kind !== "redirect") {
    throw new Error(`the authorization did not end in a redirect: ${JSON.stringify(answer)}`);
  }
  return { location: new URL(answer.location as string), consented };
}

/** The left half of the SHA-256 of the access token, base64url: the `at_hash` an identity token must carry. */
function atHash(accessToken: string): string {
  const digest = createHash("sha256").update(accessToken, "ascii").digest();
  return digest.subarray(0, 16).toString("base64url");
}

let partner: LogoutStandin;

describe("a relying-party library signs a person in, end to end", () => {
  // What THIS test started, so a failed setup is cleaned up for what it did start and never touches
  // a previous test's values.
  let startedPartner: LogoutStandin | undefined;
  let started = false;

  beforeEach(async () => {
    waitUntilFailures.length = 0;
    startedPartner = undefined;
    started = false;
    // The stand-in first: it sets the process-wide TLS setting that its `stop` restores.
    startedPartner = partner = startLogoutStandin();
    h = await startOidcHarness({
      ENVIRONMENT: "development",
      API_BASE_URL: API,
      HOST_PREFIXED_SESSION_COOKIE: "1",
    });
    env = h.env;
    started = true;
  });

  afterEach(async () => {
    try {
      if (started) await settle();
    } finally {
      await startedPartner?.stop();
    }
  });

  test("keys, client, authorize and consent, redeem, verify, userinfo, refresh, introspect, refusal, replay, revoke, logout", async () => {
    // 1. The owner makes the signing keys and registers the client, through the real admin routes.
    const rotated = await api("POST", "/admin/oidc/keys/rotate", { key: OWNER_KEY, body: {} });
    expect(rotated.status).toBe(200);

    const body = clientBody({
      redirect_uris: [THIRD_PARTY_REDIRECT],
      allowed_scopes: ["openid", "profile", "email", "orcid", "nemar.account", "offline_access"],
      allowed_grants: ["authorization_code", "refresh_token"],
      first_party: false,
      sign_in_rule: "person_proven_orcid",
      backchannel_logout_uri: partner.url,
    });
    const created = await api("POST", "/admin/oidc/clients", { key: OWNER_KEY, body });
    expect(created.status).toBe(201);
    const clientId = (created.json?.client as { client_id: string }).client_id;
    const secret = created.json?.client_secret as string;

    // 2. A person with an iD proven by signing in with ORCID, and a live app session.
    const orcid = "0000-0002-1825-0097";
    const userId = seedAccount(h, { orcid, identity: orcid, orcidVerified: true });
    const cookie = await sessionCookie(h, userId);
    const subject = h.db
      .query<{ oidc_subject: string }, [number]>("SELECT oidc_subject FROM users WHERE id = ?")
      .get(userId)?.oidc_subject as string;
    expect(subject).toMatch(/^nmu_[0-9a-f]{32}$/);

    // 3. The library discovers the provider, with the plain-http allowance for the loopback issuer.
    const config = await client.discovery(
      new URL(API),
      clientId,
      undefined,
      client.ClientSecretBasic(secret),
      { execute: [client.allowInsecureRequests] },
    );
    const metadata = config.serverMetadata();
    expect(metadata.issuer).toBe(API);
    expect(metadata.code_challenge_methods_supported).toEqual(["S256"]);

    // 4. Authorize and consent as the page would; the library builds the request, with PKCE.
    const verifier = client.randomPKCECodeVerifier();
    const challenge = await client.calculatePKCECodeChallenge(verifier);
    expect(challenge).toBe(await s256(verifier));
    const state = client.randomState();
    const nonce = client.randomNonce();
    const authorizationUrl = client.buildAuthorizationUrl(config, {
      redirect_uri: THIRD_PARTY_REDIRECT,
      scope: "openid profile email orcid nemar.account offline_access",
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    // A third-party client is asked: the consent screen is part of the flow.
    const first = await authorizeAsPage(authorizationUrl, cookie);
    expect(first.consented).toBe(true);
    expect(first.location.origin + first.location.pathname).toBe(THIRD_PARTY_REDIRECT);
    expect(first.location.searchParams.get("state")).toBe(state);
    expect(first.location.searchParams.get("iss")).toBe(API);

    // 5. Redeem with PKCE. The library checks iss, aud, nonce and expiry itself.
    const tokens = await client.authorizationCodeGrant(config, first.location, {
      pkceCodeVerifier: verifier,
      expectedState: state,
      expectedNonce: nonce,
      idTokenExpected: true,
    });
    expect(tokens.token_type.toLowerCase()).toBe("bearer");
    expect(tokens.refresh_token).toBeDefined();
    const access = tokens.access_token;
    const idToken = tokens.id_token as string;

    // 6. The library does not check the signature of a token that came from the token endpoint:
    // verify it with jose against the published key set.
    const jwks = createRemoteJWKSet(new URL(metadata.jwks_uri as string));
    const verified = await jwtVerify(idToken, jwks, {
      issuer: API,
      audience: clientId,
      algorithms: [OIDC_SIGNING_ALG],
    });
    expect(verified.protectedHeader.alg).toBe("ES256");
    expect(verified.protectedHeader.kid).toMatch(/^[0-9a-f]{16}$/);
    expect(verified.payload.sub).toBe(subject);
    expect(verified.payload.nonce).toBe(nonce);
    expect(verified.payload.orcid).toBe(`https://orcid.org/${orcid}`);
    expect(verified.payload.orcid_verified).toBe(true);
    expect(verified.payload.at_hash).toBe(atHash(access));
    expect(typeof verified.payload.auth_time).toBe("number");

    // 7. Userinfo, as the same person.
    const info = await client.fetchUserInfo(config, access, subject);
    expect(info.sub).toBe(subject);
    expect(info.orcid).toBe(`https://orcid.org/${orcid}`);

    // 8. Introspection, by the client that holds the token.
    const active = await client.tokenIntrospection(config, access);
    expect(active.active).toBe(true);
    expect(active.client_id).toBe(clientId);
    expect(active.sub).toBe(subject);

    // 9. The access token is for the client's own use at the OAuth routes and nowhere else.
    const me = await api("GET", "/users/me", { key: access });
    expect(me.status).toBe(401);
    expect(me.json?.code).toBe("oidc_token_not_accepted");

    // 10. A replayed code is invalid_grant, and what it issued stops working.
    const second = await authorizeAsPage(
      client.buildAuthorizationUrl(config, {
        redirect_uri: THIRD_PARTY_REDIRECT,
        scope: "openid profile",
        state,
        nonce,
        code_challenge: challenge,
        code_challenge_method: "S256",
      }),
      cookie,
    );
    const issued = await client.authorizationCodeGrant(config, second.location, {
      pkceCodeVerifier: verifier,
      expectedState: state,
      expectedNonce: nonce,
      idTokenExpected: true,
    });
    expect((await client.tokenIntrospection(config, issued.access_token)).active).toBe(true);
    await expect(
      client.authorizationCodeGrant(config, second.location, {
        pkceCodeVerifier: verifier,
        expectedState: state,
        expectedNonce: nonce,
        idTokenExpected: true,
      }),
    ).rejects.toMatchObject({ error: "invalid_grant" });
    expect((await client.tokenIntrospection(config, issued.access_token)).active).toBe(false);

    // 11. Refresh rotates: a new access token, a new refresh token.
    const refreshed = await client.refreshTokenGrant(config, tokens.refresh_token as string);
    expect(refreshed.access_token).not.toBe(access);
    expect(refreshed.refresh_token).not.toBe(tokens.refresh_token);
    expect((await client.tokenIntrospection(config, refreshed.access_token)).active).toBe(true);

    // 12. An administrator revokes the account. Nothing the person held works any more.
    expect(partner.requests.length).toBe(0);
    const revoked = await api("POST", `/admin/revoke/by-id/${userId}`, { key: OWNER_KEY });
    expect(revoked.status).toBe(200);
    await settle();
    expect(waitUntilFailures).toEqual([]);

    expect((await client.tokenIntrospection(config, refreshed.access_token)).active).toBe(false);
    expect((await client.tokenIntrospection(config, access)).active).toBe(false);
    await expect(
      client.refreshTokenGrant(config, refreshed.refresh_token as string),
    ).rejects.toMatchObject({ error: "invalid_grant" });

    // 13. The partner received exactly one logout token, and the verifier accepts it.
    expect(partner.requests.length).toBe(1);
    const request = partner.requests[0] as (typeof partner.requests)[number];
    expect(request.method).toBe("POST");
    expect(request.headers["content-type"]).toContain("application/x-www-form-urlencoded");
    expect(request.headers.authorization).toBeUndefined();
    expect([...request.form.keys()]).toEqual(["logout_token"]);
    const logoutToken = request.form.get("logout_token") as string;
    const claims = await verifyLogoutToken(logoutToken, jwks, { issuer: API, clientId });
    expect(claims.sub).toBe(subject);
    expect(claims.aud).toBe(clientId);
    expect(claims.iss).toBe(API);
    expect(claims.exp as number).toBe((claims.iat as number) + OIDC_LOGOUT_TOKEN_TTL_SECONDS);
    expect(decodeJwt(logoutToken)).not.toHaveProperty("nonce");
    expect(decodeJwt(logoutToken)).not.toHaveProperty("sid");
  });
});

// ---------------------------------------------------------------------------------------------
// The merge-loser order, through the real routes
// ---------------------------------------------------------------------------------------------

describe("the loser of a manual merge", () => {
  let m: OidcHarness;
  let told: LogoutStandin;
  // What THIS test started (see the flow describe's hooks).
  let startedM: OidcHarness | undefined;
  let startedTold: LogoutStandin | undefined;

  beforeEach(async () => {
    startedM = undefined;
    startedTold = undefined;
    startedTold = told = startLogoutStandin();
    startedM = m = await startOidcHarness({ HOST_PREFIXED_SESSION_COOKIE: "1" });
    await rotateKeys(m);
  });

  afterEach(async () => {
    try {
      await startedM?.settle();
    } finally {
      await startedTold?.stop();
    }
  });

  async function loser() {
    const registered = await registerLogoutClient(m, { backchannel_logout_uri: told.url });
    const userId = seedProvenAccount(m);
    await signInAt(m, userId, registered);
    return { userId, registered };
  }

  test("ended as merged first, then revoked: one logout, and its reason is the merge", async () => {
    const { userId, registered } = await loser();

    const ended = await m.call("POST", `/admin/oidc/accounts/${userId}/end`, {
      key: OWNER_KEY,
      body: { reason: "merged" },
    });
    expect(ended.status).toBe(200);
    const revoked = await m.call("POST", `/admin/revoke/by-id/${userId}`, { key: OWNER_KEY });
    expect(revoked.status).toBe(200);
    await m.settle();

    const queued = deliveries(m, userId);
    expect(queued.length).toBe(1);
    expect(queued[0]).toMatchObject({ reason: "account_merged", status: "sent" });
    expect(revokedReasons(m, userId)).toEqual(["account_merged"]);
    expect(told.requests.length).toBe(1);
    const claims = decodeJwt(told.requests[0]?.form.get("logout_token") as string);
    expect(claims.aud).toBe(registered.clientId);
  });

  test("revoked first, then ended as merged: one logout, and its reason is the revocation", async () => {
    const { userId } = await loser();

    const revoked = await m.call("POST", `/admin/revoke/by-id/${userId}`, { key: OWNER_KEY });
    expect(revoked.status).toBe(200);
    const ended = await m.call("POST", `/admin/oidc/accounts/${userId}/end`, {
      key: OWNER_KEY,
      body: { reason: "merged" },
    });
    expect(ended.status).toBe(200);
    await m.settle();

    const queued = deliveries(m, userId);
    expect(queued.length).toBe(1);
    expect(queued[0]?.reason).toBe("account_revoked");
    expect(revokedReasons(m, userId)).toEqual(["account_revoked"]);
    expect(told.requests.length).toBe(1);
  });
});
