/**
 * The authorization endpoint's two routes (epic #2014 phase #2017; ADR 0119), through the REAL
 * Worker entry point: `POST /auth/oidc/authorize` (check) and `POST /auth/oidc/consent` (decide).
 *
 * Real throughout: every migration on bun:sqlite behind `realD1`, the real middleware stack, a real
 * app session from `issueSession` presented under the `__Host-` cookie name, clients registered
 * through the owner's own route, signing keys made by the owner's rotation, and the real HMAC and
 * SHA-256. Nothing here stands in for NEMAR logic. The harness's documented rate-limiter bypass is
 * used everywhere except the block that tests the per-account budget, which runs the real limiter
 * over the shared in-memory Cache API double (bun has no Cache API).
 *
 * The suite is organized by the order every request walks (`services/oidc-authorize.ts`): the
 * client and redirect (an error page, never a redirect), the request (a redirect carrying `error`,
 * `state` and `iss`), the session, freshness, the sign-in rule, consent, and the code.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  OIDC_AUTHORIZE_CALLER_HEADER,
  OIDC_AUTHORIZE_CALLER_VALUE,
  OIDC_AUTHORIZE_CHECK_PATH,
  OIDC_AUTHORIZE_CONSENT_PATH,
  OIDC_AUTH_AFTER_PARAM,
  OIDC_AUTH_AFTER_TTL_SECONDS,
  OIDC_CONSENT_TOKEN_TTL_SECONDS,
} from "../../shared/contract/oidc-authorize";
import { __limits, __selectBucket } from "../src/middleware/rateLimit";
import { hashGrantCode } from "../src/services/docs-auth";
import { mintAuthAfterMarker, mintConsentToken } from "../src/services/oidc-authorize";
import { signJwt } from "../src/services/oidc-keys";
import { issueSession } from "../src/services/web-session";
import { InMemoryCache } from "./helpers/cache";
import {
  ISSUER,
  OIDC_TEST_SECRET,
  OWNER_KEY,
  type OidcHarness,
  clientBody,
  startOidcHarness,
} from "./helpers/oidc-harness";

const APP = "https://app.nemar.org";
const REDIRECT = "https://client.example.org/callback";
/** The RFC 7636 appendix B challenge: 43 base64url characters. */
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const STATE = "st-123 & a=b";
const ORCID = "0000-0002-1825-0097";

let h: OidcHarness;

beforeEach(async () => {
  h = await startOidcHarness({ HOST_PREFIXED_SESSION_COOKIE: "1" });
});

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

let userCounter = 0;

/** An account as the authorization endpoint sees one. */
function seedAccount(
  opts: {
    status?: string;
    kind?: "person" | "service" | "test";
    orcid?: string | null;
    orcidVerified?: boolean;
    /** An `oauth_identities` row for this iD (defaults to `orcid`). */
    identity?: string | null;
  } = {},
): number {
  userCounter += 1;
  const name = `oidcperson${userCounter}`;
  h.db
    .query(
      `INSERT INTO users (username, email, password_hash, status, role, email_verified, account_kind,
                          orcid, orcid_verified)
       VALUES (?, ?, 'x', ?, 'member', 1, ?, ?, ?)`,
    )
    .run(
      name,
      `${name}@example.org`,
      opts.status ?? "verified",
      opts.kind ?? "person",
      opts.orcid ?? null,
      opts.orcidVerified ? 1 : 0,
    );
  const id = h.db
    .query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?")
    .get(name)?.id as number;
  const identity = opts.identity === undefined ? null : opts.identity;
  if (identity !== null) {
    h.db
      .query(
        "INSERT INTO oauth_identities (user_id, provider, provider_subject) VALUES (?, 'orcid', ?)",
      )
      .run(id, identity);
  }
  return id;
}

/** A live app session for the account, as the `Cookie` header a browser would send. */
async function sessionCookie(userId: number, name = "__Host-nemar_session"): Promise<string> {
  const { cookieIdRaw } = await issueSession(h.env, userId, false, "test-agent", null, "orcid");
  return `${name}=${cookieIdRaw}`;
}

function sessionIdOf(userId: number): number {
  return h.db
    .query<{ id: number }, [number]>(
      "SELECT id FROM web_sessions WHERE user_id = ? ORDER BY id DESC LIMIT 1",
    )
    .get(userId)?.id as number;
}

/** Register a client through the owner's route and return its public id. */
async function registerClient(over: Record<string, unknown> = {}): Promise<string> {
  const res = await h.call("POST", "/admin/oidc/clients", {
    key: OWNER_KEY,
    body: clientBody({ redirect_uris: [REDIRECT], ...over }),
  });
  expect(res.status).toBe(201);
  return ((res.json as { client: { client_id: string } }).client as { client_id: string })
    .client_id;
}

/** An authorization request's query string. `null` leaves a parameter out. */
function request(
  clientId: string,
  over: Record<string, string | null> = {},
  extra: Array<[string, string]> = [],
): string {
  const values: Record<string, string | null> = {
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: "openid profile",
    state: STATE,
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    ...over,
  };
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(values)) if (v !== null) params.append(k, v);
  for (const [k, v] of extra) params.append(k, v);
  return params.toString();
}

interface Answer {
  status: number;
  headers: Headers;
  body: Record<string, unknown>;
}

/** The headers the website's page sends: its pinned Origin and the caller marker. */
function pageHeaders(opts: { cookie?: string; origin?: string | null; caller?: boolean }) {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.Cookie = opts.cookie;
  if (opts.origin !== null) headers.Origin = opts.origin ?? APP;
  if (opts.caller !== false) headers[OIDC_AUTHORIZE_CALLER_HEADER] = OIDC_AUTHORIZE_CALLER_VALUE;
  return headers;
}

async function check(
  req: string,
  opts: {
    cookie?: string;
    origin?: string | null;
    caller?: boolean;
    env?: Record<string, unknown>;
  } = {},
): Promise<Answer> {
  const headers = pageHeaders(opts);
  const res = await h.call("POST", OIDC_AUTHORIZE_CHECK_PATH, {
    body: { request: req },
    headers,
    env: opts.env as never,
  });
  return {
    status: res.status,
    headers: res.headers,
    body: (res.json ?? {}) as Record<string, unknown>,
  };
}

async function consent(
  req: string,
  token: string,
  decision: "allow" | "deny",
  opts: { cookie?: string; origin?: string | null; caller?: boolean } = {},
): Promise<Answer> {
  const headers = pageHeaders(opts);
  const res = await h.call("POST", OIDC_AUTHORIZE_CONSENT_PATH, {
    body: { request: req, consent_token: token, decision },
    headers,
  });
  return {
    status: res.status,
    headers: res.headers,
    body: (res.json ?? {}) as Record<string, unknown>,
  };
}

/** The parameters of a redirect answer's location, and the address before them. */
function redirectOf(answer: Answer): { base: string; params: URLSearchParams } {
  expect(answer.body.kind).toBe("redirect");
  const location = answer.body.location as string;
  const at = location.indexOf("?");
  return { base: location.slice(0, at), params: new URLSearchParams(location.slice(at + 1)) };
}

function expectErrorRedirect(answer: Answer, error: string, state: string | null = STATE): void {
  expect(answer.status).toBe(200);
  const { base, params } = redirectOf(answer);
  expect(base).toBe(REDIRECT);
  expect(params.get("error")).toBe(error);
  expect(params.get("state")).toBe(state);
  expect(params.get("iss")).toBe(ISSUER);
  expect(params.has("code")).toBe(false);
}

function codeCount(): number {
  return h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM oidc_codes").get()?.n ?? 0;
}

function grantsOf(userId: number) {
  return h.db
    .query<{ scopes: string; consent_kind: string; revoked_at: string | null }, [number]>(
      "SELECT scopes, consent_kind, revoked_at FROM oidc_grants WHERE user_id = ? ORDER BY id",
    )
    .all(userId);
}

// ---------------------------------------------------------------------------------------------
// Step 1: the client and the redirect address. An error page, never a redirect.
// ---------------------------------------------------------------------------------------------

describe("step 1: an unknown client or an unregistered redirect address is an error page", () => {
  test("an unknown, malformed or missing client is invalid_client, with or without a session", async () => {
    const clientId = await registerClient();
    const cookie = await sessionCookie(seedAccount());
    const unknown = `oc_${"0".repeat(24)}`;
    for (const req of [
      request(unknown),
      request("not-a-client-id"),
      request(clientId, { client_id: null }),
      request(clientId, { client_id: "" }),
    ]) {
      for (const opts of [{}, { cookie }]) {
        const answer = await check(req, opts);
        expect(answer.status).toBe(200);
        expect(answer.body).toEqual({ kind: "error_page", code: "invalid_client" });
      }
    }
  });

  test("a disabled client answers exactly as an unknown one", async () => {
    const clientId = await registerClient();
    const off = await h.call("POST", `/admin/oidc/clients/${clientId}/disable`, { key: OWNER_KEY });
    expect(off.status).toBe(200);
    const answer = await check(request(clientId), { cookie: await sessionCookie(seedAccount()) });
    expect(answer.body).toEqual({ kind: "error_page", code: "invalid_client" });
  });

  test("a redirect address that is not exactly a registered one is an error page", async () => {
    const clientId = await registerClient();
    const cookie = await sessionCookie(seedAccount());
    for (const redirect of [
      `${REDIRECT}/`, // a trailing slash
      "https://client.example.org/callback?x=1",
      "https://Client.example.org/callback",
      "https://client.example.org/Callback",
      "https://client.example.org:443/callback",
      "https://evil.example/callback",
      "http://client.example.org/callback",
    ]) {
      const answer = await check(request(clientId, { redirect_uri: redirect }), { cookie });
      expect({ redirect, body: answer.body }).toEqual({
        redirect,
        body: { kind: "error_page", code: "invalid_redirect_uri" },
      });
    }
    expect(codeCount()).toBe(0);
  });

  test("a missing or empty redirect address is an error page", async () => {
    const clientId = await registerClient();
    for (const req of [
      request(clientId, { redirect_uri: null }),
      request(clientId, { redirect_uri: "" }),
    ]) {
      expect((await check(req)).body).toEqual({ kind: "error_page", code: "invalid_redirect_uri" });
    }
  });

  test("a repeated client_id or redirect_uri is an error page, not a redirect to either", async () => {
    const clientId = await registerClient();
    const twiceClient = request(clientId, {}, [["client_id", clientId]]);
    const twiceRedirect = request(clientId, {}, [["redirect_uri", REDIRECT]]);
    for (const req of [twiceClient, twiceRedirect]) {
      expect((await check(req)).body).toEqual({ kind: "error_page", code: "invalid_request" });
    }
  });

  test("a request longer than the limit is an error page, unread", async () => {
    const clientId = await registerClient();
    const long = request(clientId, { state: "s".repeat(9000) });
    expect((await check(long)).body).toEqual({ kind: "error_page", code: "invalid_request" });
  });

  test("an error page is answered before the request's other errors are looked at", async () => {
    // A bad response type AND a bad redirect: the redirect decides, so nothing is sent anywhere.
    const clientId = await registerClient();
    const answer = await check(
      request(clientId, { redirect_uri: "https://evil.example/cb", response_type: "token" }),
    );
    expect(answer.body).toEqual({ kind: "error_page", code: "invalid_redirect_uri" });
  });
});

// ---------------------------------------------------------------------------------------------
// Step 2: the request. A redirect to the registered address with error, state and iss.
// ---------------------------------------------------------------------------------------------

describe("step 2: a bad request redirects with error, state and iss", () => {
  const cases: Array<[string, Record<string, string | null>, Array<[string, string]>, string]> = [
    ["response_type token", { response_type: "token" }, [], "unsupported_response_type"],
    ["no response_type", { response_type: null }, [], "invalid_request"],
    ["response_mode fragment", {}, [["response_mode", "fragment"]], "invalid_request"],
    ["code_challenge_method plain", { code_challenge_method: "plain" }, [], "invalid_request"],
    ["no code_challenge_method", { code_challenge_method: null }, [], "invalid_request"],
    ["no code_challenge", { code_challenge: null }, [], "invalid_request"],
    ["a short code_challenge", { code_challenge: CHALLENGE.slice(1) }, [], "invalid_request"],
    ["prompt none with login", {}, [["prompt", "none login"]], "invalid_request"],
    ["an unknown prompt", {}, [["prompt", "whenever"]], "invalid_request"],
    ["max_age that is not a number", {}, [["max_age", "soon"]], "invalid_request"],
    ["a nonce over 512 characters", {}, [["nonce", "n".repeat(513)]], "invalid_request"],
    ["a repeated scope", {}, [["scope", "openid"]], "invalid_request"],
    ["a request object", {}, [["request", "eyJ.e30."]], "request_not_supported"],
    ["a request_uri", {}, [["request_uri", "https://x.example/r"]], "request_uri_not_supported"],
    ["no openid scope", { scope: "profile" }, [], "invalid_scope"],
    ["no scope at all", { scope: null }, [], "invalid_scope"],
    ["a scope the client may not have", { scope: "openid email" }, [], "invalid_scope"],
  ];

  for (const [what, over, extra, error] of cases) {
    test(`${what}: ${error}`, async () => {
      const clientId = await registerClient({ allowed_scopes: ["openid", "profile"] });
      const answer = await check(request(clientId, over, extra), {
        cookie: await sessionCookie(seedAccount()),
      });
      expectErrorRedirect(answer, error);
    });
  }

  test("a repeated state is refused and not echoed: which value was meant is unknowable", async () => {
    const clientId = await registerClient();
    const answer = await check(request(clientId, {}, [["state", "other"]]));
    expectErrorRedirect(answer, "invalid_request", null);
  });

  test("the same refusals reach a visitor with no session", async () => {
    const clientId = await registerClient();
    expectErrorRedirect(
      await check(request(clientId, { response_type: "token" })),
      "unsupported_response_type",
    );
  });

  test("a machine-only scope is refused even to a client allowed it", async () => {
    const clientId = await registerClient({
      allowed_scopes: ["openid", "compute.stats"],
      allowed_grants: ["authorization_code", "client_credentials"],
    });
    const answer = await check(request(clientId, { scope: "openid compute.stats" }), {
      cookie: await sessionCookie(seedAccount()),
    });
    expectErrorRedirect(answer, "invalid_scope");
  });

  test("a client with only the client credentials grant can never be authorized here", async () => {
    // Registration lets such a client hold machine scopes only, so `openid` is never its to ask for.
    const clientId = await registerClient({
      allowed_scopes: ["compute.stats"],
      allowed_grants: ["client_credentials"],
    });
    const answer = await check(request(clientId), { cookie: await sessionCookie(seedAccount()) });
    expectErrorRedirect(answer, "invalid_scope");
  });

  test("a scope outside the catalogue is dropped, not refused", async () => {
    const clientId = await registerClient({ first_party: false, redirect_uris: [REDIRECT] });
    const answer = await check(request(clientId, { scope: "openid profile made.up" }), {
      cookie: await sessionCookie(seedAccount()),
    });
    expect(answer.body.kind).toBe("consent");
    expect(answer.body.scopes).toEqual(["openid", "profile"]);
  });

  test("a parameter sent with no value is treated as omitted (OpenID Connect Core 3.1.2.1)", async () => {
    const clientId = await registerClient();
    const answer = await check(
      request(clientId, {}, [
        ["request", ""],
        ["request_uri", ""],
        ["prompt", ""],
        ["max_age", ""],
        ["nonce", ""],
      ]),
      { cookie: await sessionCookie(seedAccount()) },
    );
    expect(answer.body.kind).toBe("consent");
  });

  test("a registered address with a query keeps it, and the answer is appended after it", async () => {
    const withQuery = "https://client.example.org/callback?tenant=a%20b";
    const clientId = await registerClient({ redirect_uris: [withQuery] });
    const answer = await check(request(clientId, { redirect_uri: withQuery, response_type: "x" }));
    const location = answer.body.location as string;
    expect(location.startsWith(`${withQuery}&`)).toBe(true);
    const params = new URL(location).searchParams;
    expect(params.get("tenant")).toBe("a b");
    expect(params.get("error")).toBe("unsupported_response_type");
    expect(params.get("state")).toBe(STATE);
    expect(params.get("iss")).toBe(ISSUER);
  });

  test("nothing of the request but state is echoed into the location", async () => {
    const clientId = await registerClient();
    const answer = await check(
      request(clientId, { response_type: "token" }, [["nonce", "secret-nonce-value"]]),
    );
    const location = answer.body.location as string;
    expect(location).not.toContain("secret-nonce-value");
    expect(location).not.toContain(CHALLENGE);
    expect([...redirectOf(answer).params.keys()].sort()).toEqual(["error", "iss", "state"]);
  });
});

// ---------------------------------------------------------------------------------------------
// Steps 3 and 4: the session and its freshness.
// ---------------------------------------------------------------------------------------------

describe("steps 3 and 4: the session and its freshness", () => {
  test("no session: prompt=none answers login_required, shows no page", async () => {
    const clientId = await registerClient();
    expectErrorRedirect(await check(request(clientId, {}, [["prompt", "none"]])), "login_required");
  });

  test("no session: sign in, and come back with the same request", async () => {
    const clientId = await registerClient();
    const req = request(clientId);
    expect((await check(req)).body).toEqual({ kind: "login", request: req });
  });

  test("a session read under the legacy cookie name is no session", async () => {
    const clientId = await registerClient({
      first_party: true,
      redirect_uris: ["https://app.nemar.org/cb"],
    });
    const userId = seedAccount();
    const legacy = await sessionCookie(userId, "nemar_session");
    const req = request(clientId, { redirect_uri: "https://app.nemar.org/cb" });
    expect((await check(req, { cookie: legacy })).body.kind).toBe("login");
    const none = await check(
      request(clientId, { redirect_uri: "https://app.nemar.org/cb" }, [["prompt", "none"]]),
      { cookie: legacy },
    );
    expect(redirectOf(none).params.get("error")).toBe("login_required");
    expect(codeCount()).toBe(0);
    // The same session under the __Host- name is accepted, so the name is what decided.
    const hostCookie = legacy.replace("nemar_session=", "__Host-nemar_session=");
    expect((await check(req, { cookie: hostCookie })).body.kind).toBe("redirect");
  });

  test("a revoked or expired session is no session", async () => {
    const clientId = await registerClient();
    const userId = seedAccount();
    const cookie = await sessionCookie(userId);
    h.db.run("UPDATE web_sessions SET revoked_at = datetime('now') WHERE user_id = ?", [userId]);
    expect((await check(request(clientId), { cookie })).body.kind).toBe("login");
  });

  test("prompt=login answers reauth, and the request it returns asks for a newer session", async () => {
    const clientId = await registerClient();
    const userId = seedAccount();
    const cookie = await sessionCookie(userId);
    const first = await check(request(clientId, {}, [["prompt", "login consent"]]), { cookie });
    expect(first.body.kind).toBe("reauth");
    const back = new URLSearchParams(first.body.request as string);
    expect(back.get("prompt")).toBe("consent");
    // The marker is the moment the person was sent, signed: `<unix seconds>.<mac>`.
    const [after, mac] = (back.get(OIDC_AUTH_AFTER_PARAM) as string).split(".");
    expect(Number.isInteger(Number(after)) && Number(after) > 0).toBe(true);
    expect(mac).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(back.get("state")).toBe(STATE);

    // Back with the same session, made before the marker: still too old.
    h.db.run(
      "UPDATE web_sessions SET created_at = datetime('now', '-1 minute') WHERE user_id = ?",
      [userId],
    );
    expect((await check(first.body.request as string, { cookie })).body.kind).toBe("reauth");

    // Back with a session made since: the sign-in this flow asked for is the fresh one.
    const fresh = await sessionCookie(userId);
    expect((await check(first.body.request as string, { cookie: fresh })).body.kind).toBe(
      "consent",
    );
  });

  test("no session and prompt=login: one sign-in, and the request back no longer asks for another", async () => {
    const clientId = await registerClient();
    const answer = await check(request(clientId, {}, [["prompt", "login"]]));
    expect(answer.body.kind).toBe("login");
    const back = new URLSearchParams(answer.body.request as string);
    expect(back.has("prompt")).toBe(false);
    expect(back.has(OIDC_AUTH_AFTER_PARAM)).toBe(true);
    const userId = seedAccount();
    const cookie = await sessionCookie(userId);
    expect((await check(answer.body.request as string, { cookie })).body.kind).toBe("consent");
  });

  test("a max_age older than the session answers reauth; a fresh one does not", async () => {
    const clientId = await registerClient();
    const userId = seedAccount();
    const cookie = await sessionCookie(userId);
    h.db.run(
      "UPDATE web_sessions SET created_at = datetime('now', '-10 minutes') WHERE user_id = ?",
      [userId],
    );
    const stale = await check(request(clientId, {}, [["max_age", "300"]]), { cookie });
    expect(stale.body.kind).toBe("reauth");
    const fine = await check(request(clientId, {}, [["max_age", "3600"]]), { cookie });
    expect(fine.body.kind).toBe("consent");

    // max_age=0 after the sign-in it asked for does not send the person round again.
    const zero = await check(request(clientId, {}, [["max_age", "0"]]), { cookie });
    expect(zero.body.kind).toBe("reauth");
    const fresh = await sessionCookie(userId);
    expect((await check(zero.body.request as string, { cookie: fresh })).body.kind).toBe("consent");
  });

  test("prompt=none with a stale max_age or prompt=login answers login_required", async () => {
    const clientId = await registerClient();
    const userId = seedAccount();
    const cookie = await sessionCookie(userId);
    h.db.run(
      "UPDATE web_sessions SET created_at = datetime('now', '-10 minutes') WHERE user_id = ?",
      [userId],
    );
    const answer = await check(
      request(clientId, {}, [
        ["prompt", "none"],
        ["max_age", "60"],
      ]),
      {
        cookie,
      },
    );
    expectErrorRedirect(answer, "login_required");
  });

  test("a sign-in marker the API did not sign is treated as absent, so freshness still bites", async () => {
    const clientId = await registerClient();
    const otherClient = await registerClient();
    const userId = seedAccount();
    const cookie = await sessionCookie(userId);
    h.db.run(
      "UPDATE web_sessions SET created_at = datetime('now', '-10 minutes') WHERE user_id = ?",
      [userId],
    );
    const now = Math.floor(Date.now() / 1000);
    const forged = [
      "1",
      "0",
      String(now - 5),
      `${now - 5}.${"A".repeat(43)}`,
      await mintAuthAfterMarker(OIDC_TEST_SECRET, otherClient, now - 5),
      await mintAuthAfterMarker(OIDC_TEST_SECRET, clientId, now - OIDC_AUTH_AFTER_TTL_SECONDS - 5),
      await mintAuthAfterMarker("another-secret-0123456789abcdef0123456789", clientId, now - 5),
      String(now + 3600),
    ];
    for (const marker of forged) {
      for (const freshness of [
        ["prompt", "login"],
        ["max_age", "60"],
      ] as Array<[string, string]>) {
        const answer = await check(
          request(clientId, {}, [freshness, [OIDC_AUTH_AFTER_PARAM, marker]]),
          { cookie },
        );
        expect({ marker, freshness, kind: answer.body.kind }).toEqual({
          marker,
          freshness,
          kind: "reauth",
        });
      }
      // Absent, not an error: without a freshness demand the request goes on.
      const plain = await check(request(clientId, {}, [[OIDC_AUTH_AFTER_PARAM, marker]]), {
        cookie,
      });
      expect({ marker, kind: plain.body.kind }).toEqual({ marker, kind: "consent" });
    }
  });

  test("the marker the API signed in a reauth answer satisfies it once a newer session exists", async () => {
    const clientId = await registerClient();
    const userId = seedAccount();
    const cookie = await sessionCookie(userId);
    const asked = await check(request(clientId, {}, [["prompt", "login"]]), { cookie });
    const marker = new URLSearchParams(asked.body.request as string).get(OIDC_AUTH_AFTER_PARAM);
    expect(marker).toMatch(/^\d+\.[A-Za-z0-9_-]{43}$/);
    // Signed for this client: the same marker on another client's request is not honoured.
    const otherClient = await registerClient();
    h.db.run(
      "UPDATE web_sessions SET created_at = datetime('now', '-10 minutes') WHERE user_id = ?",
      [userId],
    );
    const fresh = await sessionCookie(userId);
    expect(
      (
        await check(
          request(otherClient, {}, [
            ["prompt", "login"],
            [OIDC_AUTH_AFTER_PARAM, marker as string],
          ]),
          {
            cookie: fresh,
          },
        )
      ).body.kind,
    ).toBe("reauth");
    expect((await check(asked.body.request as string, { cookie: fresh })).body.kind).toBe(
      "consent",
    );
  });

  test("a valid id_token_hint for another subject forces a sign-in; its own does not", async () => {
    expect(
      (await h.call("POST", "/admin/oidc/keys/rotate", { key: OWNER_KEY, body: {} })).status,
    ).toBe(200);
    const clientId = await registerClient();
    const userId = seedAccount();
    const other = seedAccount();
    const cookie = await sessionCookie(userId);
    const subjectOf = (id: number) =>
      h.db
        .query<{ s: string }, [number]>("SELECT oidc_subject AS s FROM users WHERE id = ?")
        .get(id)?.s as string;

    const foreign = await signJwt(h.env, { iss: ISSUER, sub: subjectOf(other), aud: clientId });
    const own = await signJwt(h.env, { iss: ISSUER, sub: subjectOf(userId), aud: clientId });
    expect(
      (await check(request(clientId, {}, [["id_token_hint", foreign]]), { cookie })).body.kind,
    ).toBe("reauth");
    expect(
      (await check(request(clientId, {}, [["id_token_hint", own]]), { cookie })).body.kind,
    ).toBe("consent");
    const none = await check(
      request(clientId, {}, [
        ["id_token_hint", foreign],
        ["prompt", "none"],
      ]),
      {
        cookie,
      },
    );
    expectErrorRedirect(none, "login_required");
  });

  test("an id_token_hint that is not this provider's is ignored", async () => {
    expect(
      (await h.call("POST", "/admin/oidc/keys/rotate", { key: OWNER_KEY, body: {} })).status,
    ).toBe(200);
    const clientId = await registerClient();
    const cookie = await sessionCookie(seedAccount());
    const other = seedAccount();
    const sub = h.db
      .query<{ s: string }, [number]>("SELECT oidc_subject AS s FROM users WHERE id = ?")
      .get(other)?.s as string;
    const real = await signJwt(h.env, { iss: ISSUER, sub });
    const [header, payload, signature] = real.split(".");
    // The same claims under a signature that does not verify, another issuer, and garbage.
    const flipped = `${signature.slice(0, -2)}${signature.endsWith("AA") ? "BB" : "AA"}`;
    const otherIssuer = await signJwt(h.env, { iss: "https://elsewhere.example", sub });
    for (const hint of [`${header}.${payload}.${flipped}`, otherIssuer, "not.a.token", "x"]) {
      expect(
        (await check(request(clientId, {}, [["id_token_hint", hint]]), { cookie })).body.kind,
      ).toBe("consent");
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Step 5: who may sign in.
// ---------------------------------------------------------------------------------------------

describe("step 5: the client's sign-in rule", () => {
  async function orcidClient(): Promise<string> {
    return registerClient({ sign_in_rule: "person_proven_orcid" });
  }

  test("an ORCID iD an owner attested is not proven, and is refused", async () => {
    const clientId = await orcidClient();
    // ADR 0106: `orcid_verified` set by an owner, with no ORCID sign-in behind it.
    const attested = seedAccount({ orcid: ORCID, orcidVerified: true, identity: null });
    const answer = await check(request(clientId), { cookie: await sessionCookie(attested) });
    expect(answer.body.kind).toBe("rule_refused");
    expect(answer.body.reason).toBe("orcid_not_proven");
    expect(typeof answer.body.client_name).toBe("string");
    const location = new URL(answer.body.location as string);
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("state")).toBe(STATE);
    expect(location.searchParams.get("iss")).toBe(ISSUER);
    expect(codeCount()).toBe(0);
  });

  test("an iD proven by an ORCID sign-in passes", async () => {
    const clientId = await orcidClient();
    const proven = seedAccount({ orcid: ORCID, orcidVerified: true, identity: ORCID });
    expect(
      (await check(request(clientId), { cookie: await sessionCookie(proven) })).body.kind,
    ).toBe("consent");
  });

  test("a sign-in record for a different iD than the account's is not a proof of it", async () => {
    const clientId = await orcidClient();
    const mismatched = seedAccount({
      orcid: ORCID,
      orcidVerified: true,
      identity: "0000-0001-5109-3700",
    });
    const answer = await check(request(clientId), { cookie: await sessionCookie(mismatched) });
    expect(answer.body.reason).toBe("orcid_not_proven");
  });

  test("an account that is not a person is refused, even with a proven iD", async () => {
    const clientId = await orcidClient();
    const service = seedAccount({ kind: "service", orcid: ORCID, identity: ORCID });
    expect(
      (await check(request(clientId), { cookie: await sessionCookie(service) })).body.reason,
    ).toBe("account_not_person");
  });

  test("an account that is not active is refused under either rule", async () => {
    const pending = seedAccount({ status: "pending", orcid: ORCID, identity: ORCID });
    const cookie = await sessionCookie(pending);
    for (const rule of ["active_account", "person_proven_orcid"]) {
      const clientId = await registerClient({ sign_in_rule: rule });
      expect((await check(request(clientId), { cookie })).body.reason).toBe("account_inactive");
    }
  });

  test("active_account admits an active account with no iD", async () => {
    const clientId = await registerClient({ sign_in_rule: "active_account" });
    expect(
      (await check(request(clientId), { cookie: await sessionCookie(seedAccount()) })).body.kind,
    ).toBe("consent");
  });

  test("prompt=none and a refused account answers access_denied, shows no page", async () => {
    const clientId = await orcidClient();
    const attested = seedAccount({ orcid: ORCID, orcidVerified: true });
    const answer = await check(request(clientId, {}, [["prompt", "none"]]), {
      cookie: await sessionCookie(attested),
    });
    expectErrorRedirect(answer, "access_denied");
  });
});

// ---------------------------------------------------------------------------------------------
// Step 6: consent.
// ---------------------------------------------------------------------------------------------

describe("step 6: consent", () => {
  const FIRST_PARTY_REDIRECT = "https://app.nemar.org/oidc/callback";

  test("a first-party client skips consent and records a first_party grant", async () => {
    const clientId = await registerClient({
      first_party: true,
      redirect_uris: [FIRST_PARTY_REDIRECT],
    });
    const userId = seedAccount();
    const answer = await check(request(clientId, { redirect_uri: FIRST_PARTY_REDIRECT }), {
      cookie: await sessionCookie(userId),
    });
    const { base, params } = redirectOf(answer);
    expect(base).toBe(FIRST_PARTY_REDIRECT);
    expect(params.get("code")?.length).toBe(43);
    expect(params.get("state")).toBe(STATE);
    expect(params.get("iss")).toBe(ISSUER);
    expect(grantsOf(userId)).toEqual([
      { scopes: '["openid","profile"]', consent_kind: "first_party", revoked_at: null },
    ]);
  });

  test("a client registered first-party whose address no longer qualifies is treated as third-party and asked", async () => {
    // A partner host added to the list after the client was registered: the row says first-party,
    // the rule as it stands says otherwise. Written directly, because registration would refuse it.
    const partnerRedirect = "https://compute.nemar.org/oidc/callback";
    const clientId = await registerClient({ redirect_uris: [partnerRedirect] });
    h.db.run("UPDATE oidc_clients SET first_party = 1 WHERE client_id = ?", [clientId]);
    const userId = seedAccount();
    const answer = await check(request(clientId, { redirect_uri: partnerRedirect }), {
      cookie: await sessionCookie(userId),
    });
    expect(answer.body.kind).toBe("consent");
    expect(codeCount()).toBe(0);
  });

  test("every registered address is re-asked, not only the one in use", async () => {
    const clientId = await registerClient({
      redirect_uris: [FIRST_PARTY_REDIRECT, "https://compute.nemar.org/cb"],
    });
    h.db.run("UPDATE oidc_clients SET first_party = 1 WHERE client_id = ?", [clientId]);
    const answer = await check(request(clientId, { redirect_uri: FIRST_PARTY_REDIRECT }), {
      cookie: await sessionCookie(seedAccount()),
    });
    expect(answer.body.kind).toBe("consent");
  });

  test("a first_party grant is not consent once the client stops being first-party", async () => {
    const clientId = await registerClient({
      first_party: true,
      redirect_uris: [FIRST_PARTY_REDIRECT],
    });
    const userId = seedAccount();
    const cookie = await sessionCookie(userId);
    const req = request(clientId, { redirect_uri: FIRST_PARTY_REDIRECT });
    expect((await check(req, { cookie })).body.kind).toBe("redirect");
    h.db.run("UPDATE oidc_clients SET first_party = 0 WHERE client_id = ?", [clientId]);
    expect((await check(req, { cookie })).body.kind).toBe("consent");
  });

  test("ask_once: asked once, then not for the same or a narrower set, and again for a wider one", async () => {
    const clientId = await registerClient({ allowed_scopes: ["openid", "profile", "email"] });
    const userId = seedAccount();
    const cookie = await sessionCookie(userId);
    const req = request(clientId, { scope: "openid profile" });
    const asked = await check(req, { cookie });
    expect(asked.body.kind).toBe("consent");
    const allowed = await consent(req, asked.body.consent_token as string, "allow", { cookie });
    expect(redirectOf(allowed).params.get("code")?.length).toBe(43);
    expect(grantsOf(userId)).toEqual([
      { scopes: '["openid","profile"]', consent_kind: "user", revoked_at: null },
    ]);

    expect((await check(req, { cookie })).body.kind).toBe("redirect");
    expect((await check(request(clientId, { scope: "openid" }), { cookie })).body.kind).toBe(
      "redirect",
    );

    const wider = request(clientId, { scope: "openid email" });
    const again = await check(wider, { cookie });
    expect(again.body.kind).toBe("consent");
    expect(again.body.scopes).toEqual(["openid", "email"]);
    await consent(wider, again.body.consent_token as string, "allow", { cookie });
    // The grant widens; it never narrows to what was asked last.
    expect(grantsOf(userId)).toEqual([
      { scopes: '["email","openid","profile"]', consent_kind: "user", revoked_at: null },
    ]);
  });

  test("always: asked every time", async () => {
    const clientId = await registerClient({ consent_mode: "always" });
    const cookie = await sessionCookie(seedAccount());
    const req = request(clientId);
    const first = await check(req, { cookie });
    await consent(req, first.body.consent_token as string, "allow", { cookie });
    expect((await check(req, { cookie })).body.kind).toBe("consent");
  });

  test("prompt=consent asks even when a grant covers the scopes", async () => {
    const clientId = await registerClient();
    const cookie = await sessionCookie(seedAccount());
    const req = request(clientId);
    const first = await check(req, { cookie });
    await consent(req, first.body.consent_token as string, "allow", { cookie });
    expect(
      (await check(request(clientId, {}, [["prompt", "consent"]]), { cookie })).body.kind,
    ).toBe("consent");
  });

  test("prompt=none when consent is needed answers consent_required", async () => {
    const clientId = await registerClient();
    expectErrorRedirect(
      await check(request(clientId, {}, [["prompt", "none"]]), {
        cookie: await sessionCookie(seedAccount()),
      }),
      "consent_required",
    );
  });

  test("the consent screen names the client, lists the scopes in catalogue order, and says when it spends compute", async () => {
    const clientId = await registerClient({
      name: "Compute portal",
      allowed_scopes: ["openid", "profile", "compute.read", "compute.reserve"],
    });
    const cookie = await sessionCookie(seedAccount());
    const plain = await check(request(clientId, { scope: "profile openid compute.read" }), {
      cookie,
    });
    expect(plain.body).toMatchObject({
      kind: "consent",
      client_name: "Compute portal",
      scopes: ["openid", "profile", "compute.read"],
      compute_spend: false,
      redirect_origin: "https://client.example.org",
    });
    const spends = await check(request(clientId, { scope: "openid compute.reserve" }), { cookie });
    expect(spends.body.compute_spend).toBe(true);
  });

  test("deny returns the person with access_denied, and records and mints nothing", async () => {
    const clientId = await registerClient();
    const userId = seedAccount();
    const cookie = await sessionCookie(userId);
    const req = request(clientId);
    const asked = await check(req, { cookie });
    expectErrorRedirect(
      await consent(req, asked.body.consent_token as string, "deny", { cookie }),
      "access_denied",
    );
    expect(codeCount()).toBe(0);
    expect(grantsOf(userId)).toEqual([]);
  });

  test("a forged, expired, other-session or other-request consent token is refused", async () => {
    const clientId = await registerClient();
    const userId = seedAccount();
    const cookie = await sessionCookie(userId);
    const req = request(clientId);
    const asked = await check(req, { cookie });
    const token = asked.body.consent_token as string;

    const [expiry, mac] = token.split(".");
    const forged = `${expiry}.${mac.slice(0, -1)}${mac.endsWith("A") ? "B" : "A"}`;
    const now = Math.floor(Date.now() / 1000);
    const binding = {
      sessionId: sessionIdOf(userId),
      clientId,
      redirectUri: REDIRECT,
      scopes: ["openid", "profile"],
      state: STATE,
      codeChallenge: CHALLENGE,
      nonce: null,
    };
    const expired = await mintConsentToken(
      OIDC_TEST_SECRET,
      binding,
      now - OIDC_CONSENT_TOKEN_TTL_SECONDS - 5,
    );
    const wrongKey = await mintConsentToken(
      "another-secret-0123456789abcdef0123456789",
      binding,
      now,
    );
    const otherSession = await sessionCookie(seedAccount());
    const otherRequest = request(clientId, { state: "a different state" });

    for (const [what, body, opts] of [
      ["forged", { req, token: forged }, { cookie }],
      ["expired", { req, token: expired }, { cookie }],
      ["another key", { req, token: wrongKey }, { cookie }],
      ["another session", { req, token }, { cookie: otherSession }],
      ["another request", { req: otherRequest, token }, { cookie }],
      ["no token", { req, token: "" }, { cookie }],
    ] as const) {
      const answer = await consent(body.req, body.token, "allow", opts);
      expect({ what, body: answer.body }).toEqual({
        what,
        body: { kind: "error_page", code: "consent_invalid" },
      });
    }
    expect(codeCount()).toBe(0);
    // The genuine token, for the genuine session and request, is still good.
    expect((await consent(req, token, "allow", { cookie })).body.kind).toBe("redirect");
  });

  test("a consent token minted at the check is good for ten minutes and not after", async () => {
    const clientId = await registerClient();
    const userId = seedAccount();
    const cookie = await sessionCookie(userId);
    const binding = {
      sessionId: sessionIdOf(userId),
      clientId,
      redirectUri: REDIRECT,
      scopes: ["openid", "profile"],
      state: STATE,
      codeChallenge: CHALLENGE,
      nonce: null,
    };
    const now = Math.floor(Date.now() / 1000);
    const nearlyStale = await mintConsentToken(
      OIDC_TEST_SECRET,
      binding,
      now - OIDC_CONSENT_TOKEN_TTL_SECONDS + 30,
    );
    expect((await consent(request(clientId), nearlyStale, "allow", { cookie })).body.kind).toBe(
      "redirect",
    );
  });

  test("consent with no session sends the person to sign in with the request", async () => {
    const clientId = await registerClient();
    const req = request(clientId);
    expect((await consent(req, "1.x", "allow")).body).toEqual({ kind: "login", request: req });
  });
});

// ---------------------------------------------------------------------------------------------
// Step 7: the code.
// ---------------------------------------------------------------------------------------------

describe("step 7: the code", () => {
  async function codeFor(userId: number, nonce: string | null = "n-0S6_WzA2Mj") {
    const clientId = await registerClient();
    const cookie = await sessionCookie(userId);
    const req = request(clientId, nonce === null ? {} : { nonce });
    const asked = await check(req, { cookie });
    const answer = await consent(req, asked.body.consent_token as string, "allow", { cookie });
    return { clientId, code: redirectOf(answer).params.get("code") as string };
  }

  test("is stored only as its hash, for sixty seconds by D1's clock", async () => {
    const userId = seedAccount();
    const { code } = await codeFor(userId);
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = h.db
      .query<{ ttl: number; live: number }, [string]>(
        `SELECT CAST(ROUND((julianday(expires_at) - julianday(created_at)) * 86400) AS INTEGER) AS ttl,
                expires_at > datetime('now') AS live
           FROM oidc_codes WHERE code_hash = ?`,
      )
      .get(await hashGrantCode(code));
    expect(row).toEqual({ ttl: 60, live: 1 });
    const inClear = h.db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM oidc_codes WHERE code_hash = ?")
      .get(code);
    expect(inClear?.n).toBe(0);
  });

  test("is bound to the session's account and carries what the token endpoint re-checks", async () => {
    const userId = seedAccount();
    const { clientId, code } = await codeFor(userId);
    const row = h.db
      .query<Record<string, unknown>, [string]>(
        `SELECT oc.user_id, oc.redirect_uri, oc.scopes, oc.nonce, oc.code_challenge, oc.used_at,
                oc.auth_time = ws.created_at AS auth_time_is_sign_in,
                c.client_id AS client, g.user_id AS grant_user
           FROM oidc_codes oc
           JOIN oidc_clients c ON c.id = oc.client_id
           JOIN oidc_grants g ON g.id = oc.grant_id
           JOIN web_sessions ws ON ws.user_id = oc.user_id
          WHERE oc.code_hash = ?`,
      )
      .get(await hashGrantCode(code));
    expect(row).toEqual({
      user_id: userId,
      redirect_uri: REDIRECT,
      scopes: '["openid","profile"]',
      nonce: "n-0S6_WzA2Mj",
      code_challenge: CHALLENGE,
      used_at: null,
      auth_time_is_sign_in: 1,
      client: clientId,
      grant_user: userId,
    });
  });

  test("an account revoked between the check and the consent gets no code", async () => {
    const clientId = await registerClient();
    const userId = seedAccount();
    const cookie = await sessionCookie(userId);
    const req = request(clientId);
    const asked = await check(req, { cookie });
    h.db.run("UPDATE users SET status = 'revoked' WHERE id = ?", [userId]);
    const answer = await consent(req, asked.body.consent_token as string, "allow", { cookie });
    expect(answer.body.kind).toBe("login");
    expect(codeCount()).toBe(0);
    expect(grantsOf(userId)).toEqual([]);
  });

  test("a client disabled between the check and the consent gets no code and no redirect", async () => {
    const clientId = await registerClient();
    const userId = seedAccount();
    const cookie = await sessionCookie(userId);
    const req = request(clientId);
    const asked = await check(req, { cookie });
    await h.call("POST", `/admin/oidc/clients/${clientId}/disable`, { key: OWNER_KEY });
    const answer = await consent(req, asked.body.consent_token as string, "allow", { cookie });
    expect(answer.body).toEqual({ kind: "error_page", code: "invalid_client" });
    expect(codeCount()).toBe(0);
  });

  test("a mint prunes codes more than an hour past expiry, used or not, and keeps the rest", async () => {
    const userId = seedAccount();
    const insert = (hash: string, expires: string, used: string | null) =>
      h.db.run(
        `INSERT INTO oidc_codes (code_hash, client_id, user_id, grant_id, redirect_uri, scopes,
                                 code_challenge, auth_time, created_at, expires_at, used_at)
         VALUES (?, 1, ?, 1, 'https://x.example/cb', '["openid"]', ?, datetime('now'),
                 datetime(${expires}, '-60 seconds'), ${expires}, ${used})`,
        [hash, userId, CHALLENGE],
      );
    insert("a".repeat(64), "datetime('now', '-2 hours')", "datetime('now', '-2 hours')");
    insert("b".repeat(64), "datetime('now', '-2 hours')", "NULL");
    insert("c".repeat(64), "datetime('now', '-30 minutes')", "datetime('now', '-31 minutes')");
    await codeFor(userId);
    const left = h.db
      .query<{ code_hash: string }, [string, string, string]>(
        "SELECT code_hash FROM oidc_codes WHERE code_hash IN (?, ?, ?) ORDER BY code_hash",
      )
      .all("a".repeat(64), "b".repeat(64), "c".repeat(64));
    expect(left).toEqual([{ code_hash: "c".repeat(64) }]);
  });
});

// ---------------------------------------------------------------------------------------------
// The routes themselves.
// ---------------------------------------------------------------------------------------------

describe("the routes", () => {
  test("Origin is checked before the session: missing, foreign and partner origins are 403", async () => {
    const clientId = await registerClient();
    const cookie = await sessionCookie(seedAccount());
    for (const origin of [null, "https://evil.example", "https://compute.nemar.org"]) {
      const answer = await check(request(clientId), { cookie, origin });
      expect({ origin, status: answer.status }).toEqual({ origin, status: 403 });
      expect(answer.headers.get("Cache-Control")).toBe("no-store");
      const decided = await consent(request(clientId), "1.x", "allow", { cookie, origin });
      expect(decided.status).toBe(403);
    }
  });

  test("every answer is no-store", async () => {
    const clientId = await registerClient();
    const cookie = await sessionCookie(seedAccount());
    for (const answer of [
      await check(request(clientId), { cookie }),
      await check(request("oc_bad")),
      await check(request(clientId)),
      await consent(request(clientId), "1.x", "allow", { cookie }),
    ]) {
      expect(answer.status).toBe(200);
      expect(answer.headers.get("Cache-Control")).toBe("no-store");
    }
  });

  test("a body that is not the contract's shape is 400", async () => {
    const cookie = await sessionCookie(seedAccount());
    for (const [path, body] of [
      [OIDC_AUTHORIZE_CHECK_PATH, {}],
      [OIDC_AUTHORIZE_CHECK_PATH, { request: 5 }],
      [OIDC_AUTHORIZE_CONSENT_PATH, { request: "a=b", consent_token: "1.x", decision: "maybe" }],
      [OIDC_AUTHORIZE_CONSENT_PATH, { request: "a=b", decision: "allow" }],
    ] as const) {
      const res = await h.call("POST", path, { body, headers: pageHeaders({ cookie }) });
      expect({ path, status: res.status }).toEqual({ path, status: 400 });
      expect(res.json?.error).toBe("invalid_body");
      expect(res.headers.get("Cache-Control")).toBe("no-store");
    }
  });

  test("404 while the provider is off, under the legacy mount, on another host, or with the cookie flag off", async () => {
    const clientId = await registerClient();
    const cookie = await sessionCookie(seedAccount());
    const variants: Array<
      [string, { base?: string; path?: string; env?: Record<string, unknown> }]
    > = [
      ["no secret", { env: { OIDC_SECRET: undefined } }],
      ["a secret not in the nmsso- form", { env: { OIDC_SECRET: "s".repeat(70) } }],
      ["legacy mount", { path: `/nemar${OIDC_AUTHORIZE_CHECK_PATH}` }],
      ["another host", { base: "https://data.nemar.org" }],
      ["cookie flag off", { env: { HOST_PREFIXED_SESSION_COOKIE: undefined } }],
    ];
    for (const [what, v] of variants) {
      const res = await h.call("POST", v.path ?? OIDC_AUTHORIZE_CHECK_PATH, {
        base: v.base,
        body: { request: request(clientId) },
        headers: pageHeaders({ cookie }),
        env: v.env as never,
      });
      expect({ what, status: res.status }).toEqual({ what, status: 404 });
    }
  });

  test("neither route is in the strict per-address bucket, under either mount spelling", () => {
    for (const path of [OIDC_AUTHORIZE_CHECK_PATH, OIDC_AUTHORIZE_CONSENT_PATH]) {
      for (const spelled of [path, `/nemar${path}`]) {
        expect(__selectBucket(spelled, undefined, "203.0.113.7").keyKind).toBe("ip");
      }
    }
  });
});

describe("the per-account budget", () => {
  let saved: unknown;
  beforeAll(() => {
    saved = (globalThis as { caches?: unknown }).caches;
  });
  beforeEach(() => {
    (globalThis as { caches?: unknown }).caches = { default: new InMemoryCache() };
  });
  afterAll(() => {
    (globalThis as { caches?: unknown }).caches = saved;
  });

  async function counted(req: string, cookie?: string): Promise<number> {
    const headers = { ...pageHeaders({ cookie }), "CF-Connecting-IP": "203.0.113.9" };
    const res = await h.call("POST", OIDC_AUTHORIZE_CHECK_PATH, {
      body: { request: req },
      headers,
      bypass: false,
    });
    return res.status;
  }

  test("the thirty-first call in a minute from one account is 429, and another account is untouched", async () => {
    expect(__limits.OIDC_AUTHORIZE_MAX_REQUESTS).toBe(30);
    const clientId = await registerClient();
    const cookie = await sessionCookie(seedAccount());
    const statuses: number[] = [];
    for (let i = 0; i <= 30; i++) statuses.push(await counted(request(clientId), cookie));
    expect(statuses.slice(0, 30)).toEqual(Array(30).fill(200));
    expect(statuses[30]).toBe(429);
    // The consent route spends the same budget.
    const refused = await h.call("POST", OIDC_AUTHORIZE_CONSENT_PATH, {
      body: { request: request(clientId), consent_token: "1.x", decision: "allow" },
      headers: { ...pageHeaders({ cookie }), "CF-Connecting-IP": "203.0.113.9" },
      bypass: false,
    });
    expect(refused.status).toBe(429);
    // The Worker's own limiter stamps its bucket's headers on every answer on the way out, so the
    // refusal is recognized by its body, which only the per-account budget wrote here.
    expect(refused.json?.error).toBe("Rate limit exceeded");
    expect(refused.headers.get("Cache-Control")).toBe("no-store");
    expect(await counted(request(clientId), await sessionCookie(seedAccount()))).toBe(200);
  });

  test("a visitor with no session spends no account's budget", async () => {
    const clientId = await registerClient();
    for (let i = 0; i < 40; i++) expect(await counted(request(clientId))).toBe(200);
    expect(await counted(request(clientId), await sessionCookie(seedAccount()))).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------
// Round 1 of the phase review.
// ---------------------------------------------------------------------------------------------

describe("only the authorization page's server reaches the routes", () => {
  test("a call without the caller marker is 403 on both routes, before anything is read", async () => {
    const clientId = await registerClient({
      first_party: true,
      redirect_uris: ["https://app.nemar.org/cb"],
    });
    const userId = seedAccount();
    const cookie = await sessionCookie(userId);
    const req = request(clientId, { redirect_uri: "https://app.nemar.org/cb" });
    for (const answer of [
      await check(req, { cookie, caller: false }),
      await consent(req, "1.x", "allow", { cookie, caller: false }),
    ]) {
      expect(answer.status).toBe(403);
      expect(answer.headers.get("Cache-Control")).toBe("no-store");
      expect(answer.body.kind).toBeUndefined();
    }
    const wrong = await h.call("POST", OIDC_AUTHORIZE_CHECK_PATH, {
      body: { request: req },
      headers: { ...pageHeaders({ cookie, caller: false }), [OIDC_AUTHORIZE_CALLER_HEADER]: "1" },
    });
    expect(wrong.status).toBe(403);
    expect(codeCount()).toBe(0);
    expect(grantsOf(userId)).toEqual([]);
  });
});

describe("response_type", () => {
  for (const value of ["token", "id_token", "code id_token", "code token"]) {
    test(`a present type other than code (${value}) is unsupported_response_type`, async () => {
      const clientId = await registerClient();
      expectErrorRedirect(
        await check(request(clientId, { response_type: value }), {
          cookie: await sessionCookie(seedAccount()),
        }),
        "unsupported_response_type",
      );
    });
  }

  test("a missing or empty response_type is invalid_request", async () => {
    const clientId = await registerClient();
    for (const value of [null, ""]) {
      expectErrorRedirect(
        await check(request(clientId, { response_type: value })),
        "invalid_request",
      );
    }
  });
});

describe("what a grant and a code store about the client", () => {
  test("both hold the client's row id, oidc_clients.id, never the public string", async () => {
    const clientId = await registerClient();
    const userId = seedAccount();
    const cookie = await sessionCookie(userId);
    const req = request(clientId);
    const asked = await check(req, { cookie });
    expect(
      (await consent(req, asked.body.consent_token as string, "allow", { cookie })).body.kind,
    ).toBe("redirect");
    const row = h.db
      .query<{ g: string; c: string; gt: string; ct: string }, [string]>(
        `SELECT cg.client_id AS g, cc.client_id AS c, typeof(g.client_id) AS gt, typeof(oc.client_id) AS ct
           FROM oidc_grants g
           JOIN oidc_codes oc ON oc.grant_id = g.id
           JOIN oidc_clients cg ON cg.id = g.client_id
           JOIN oidc_clients cc ON cc.id = oc.client_id
          WHERE cg.client_id = ?`,
      )
      .get(clientId);
    expect(row).toEqual({ g: clientId, c: clientId, gt: "integer", ct: "integer" });
  });
});

describe("consent belongs to one account", () => {
  test("another account on the same client is asked, whatever the first allowed", async () => {
    const clientId = await registerClient();
    const a = await sessionCookie(seedAccount());
    const b = await sessionCookie(seedAccount());
    const req = request(clientId);
    const asked = await check(req, { cookie: a });
    await consent(req, asked.body.consent_token as string, "allow", { cookie: a });
    expect((await check(req, { cookie: a })).body.kind).toBe("redirect");
    expect((await check(req, { cookie: b })).body.kind).toBe("consent");
  });
});

describe("the consent token is bound to every value it covers", () => {
  const SECOND = "https://client.example.org/second";

  test("one genuine token, against requests that differ in exactly one value", async () => {
    const clientId = await registerClient({
      redirect_uris: [REDIRECT, SECOND],
      allowed_scopes: ["openid", "profile"],
    });
    const twin = await registerClient({
      redirect_uris: [REDIRECT, SECOND],
      allowed_scopes: ["openid", "profile"],
    });
    const cookie = await sessionCookie(seedAccount());
    const genuine = request(clientId, {}, [["nonce", "nonce-one"]]);
    const token = (await check(genuine, { cookie })).body.consent_token as string;
    const otherChallenge = `${CHALLENGE.slice(0, 42)}${CHALLENGE.endsWith("A") ? "B" : "A"}`;
    for (const [what, req] of [
      ["scope", request(clientId, { scope: "openid" }, [["nonce", "nonce-one"]])],
      ["redirect_uri", request(clientId, { redirect_uri: SECOND }, [["nonce", "nonce-one"]])],
      ["client_id", request(twin, {}, [["nonce", "nonce-one"]])],
      [
        "code_challenge",
        request(clientId, { code_challenge: otherChallenge }, [["nonce", "nonce-one"]]),
      ],
      ["nonce", request(clientId, {}, [["nonce", "nonce-two"]])],
      ["no nonce", request(clientId)],
    ] as const) {
      const answer = await consent(req, token, "allow", { cookie });
      expect({ what, body: answer.body }).toEqual({
        what,
        body: { kind: "error_page", code: "consent_invalid" },
      });
    }
    expect(codeCount()).toBe(0);
    expect((await consent(genuine, token, "allow", { cookie })).body.kind).toBe("redirect");
  });

  test("a genuinely signed token that claims a longer life, or has just expired, is refused", async () => {
    const clientId = await registerClient();
    const userId = seedAccount();
    const cookie = await sessionCookie(userId);
    const binding = {
      sessionId: sessionIdOf(userId),
      clientId,
      redirectUri: REDIRECT,
      scopes: ["openid", "profile"],
      state: STATE,
      codeChallenge: CHALLENGE,
      nonce: null,
    };
    const now = Math.floor(Date.now() / 1000);
    const tooLong = await mintConsentToken(OIDC_TEST_SECRET, binding, now + 100);
    const atExpiry = await mintConsentToken(
      OIDC_TEST_SECRET,
      binding,
      now - OIDC_CONSENT_TOKEN_TTL_SECONDS,
    );
    for (const token of [tooLong, atExpiry]) {
      expect((await consent(request(clientId), token, "allow", { cookie })).body).toEqual({
        kind: "error_page",
        code: "consent_invalid",
      });
    }
    const live = await mintConsentToken(
      OIDC_TEST_SECRET,
      binding,
      now - OIDC_CONSENT_TOKEN_TTL_SECONDS + 30,
    );
    expect((await consent(request(clientId), live, "allow", { cookie })).body.kind).toBe(
      "redirect",
    );
  });

  test("a token used under the legacy cookie name is answered as no session, and mints nothing", async () => {
    const clientId = await registerClient();
    const userId = seedAccount();
    const cookie = await sessionCookie(userId);
    const req = request(clientId);
    const token = (await check(req, { cookie })).body.consent_token as string;
    const legacy = cookie.replace("__Host-nemar_session=", "nemar_session=");
    expect((await consent(req, token, "allow", { cookie: legacy })).body).toEqual({
      kind: "login",
      request: req,
    });
    expect(codeCount()).toBe(0);
    expect(grantsOf(userId)).toEqual([]);
  });
});

describe("the code, round 1", () => {
  test("auth_time is the session's sign-in, not the moment of the code", async () => {
    const clientId = await registerClient();
    const userId = seedAccount();
    const cookie = await sessionCookie(userId);
    h.db.run(
      "UPDATE web_sessions SET created_at = datetime('now', '-10 minutes') WHERE user_id = ?",
      [userId],
    );
    const signedIn = h.db
      .query<{ c: string }, [number]>("SELECT created_at AS c FROM web_sessions WHERE user_id = ?")
      .get(userId)?.c;
    const req = request(clientId);
    const token = (await check(req, { cookie })).body.consent_token as string;
    const code = redirectOf(await consent(req, token, "allow", { cookie })).params.get(
      "code",
    ) as string;
    const row = h.db
      .query<{ auth_time: string }, [string]>(
        "SELECT auth_time FROM oidc_codes WHERE code_hash = ?",
      )
      .get(await hashGrantCode(code));
    expect(row?.auth_time).toBe(signedIn as string);
  });

  test("a mint whose code insert wrote nothing answers an error page, never a redirect", async () => {
    // A row three hours past expiry, so the prune at the head of the mint's batch deletes it, and a
    // test-only trigger that disables the client when it does: everything after the prune in the
    // same batch then meets a disabled client and writes nothing.
    const clientId = await registerClient();
    const userId = seedAccount();
    const cookie = await sessionCookie(userId);
    h.db.run(
      `INSERT INTO oidc_codes (code_hash, client_id, user_id, grant_id, redirect_uri, scopes,
                               code_challenge, auth_time, created_at, expires_at)
       VALUES (?, 1, 1, 1, 'https://x.example/cb', '["openid"]', ?, datetime('now'),
               datetime('now', '-3 hours', '-60 seconds'), datetime('now', '-3 hours'))`,
      ["e".repeat(64), CHALLENGE],
    );
    h.db.run(
      `CREATE TRIGGER test_disable_client_on_prune AFTER DELETE ON oidc_codes
       BEGIN UPDATE oidc_clients SET status = 'disabled', disabled_at = datetime('now')
             WHERE client_id = '${clientId}'; END`,
    );
    const req = request(clientId);
    const token = (await check(req, { cookie })).body.consent_token as string;
    const answer = await consent(req, token, "allow", { cookie });
    expect(answer.body).toEqual({ kind: "error_page", code: "unavailable" });
    expect(codeCount()).toBe(0);
    expect(grantsOf(userId)).toEqual([]);
  });
});

describe("what the consent screen is told", () => {
  test("compute.submit alone says the client can spend compute time", async () => {
    const clientId = await registerClient({ allowed_scopes: ["openid", "compute.submit"] });
    const answer = await check(request(clientId, { scope: "openid compute.submit" }), {
      cookie: await sessionCookie(seedAccount()),
    });
    expect(answer.body.compute_spend).toBe(true);
  });

  test("the redirect origin is the requested address's, among several registered", async () => {
    const clientId = await registerClient({
      redirect_uris: [REDIRECT, "https://other.example.net/cb"],
    });
    const cookie = await sessionCookie(seedAccount());
    expect(
      (await check(request(clientId, { redirect_uri: "https://other.example.net/cb" }), { cookie }))
        .body.redirect_origin,
    ).toBe("https://other.example.net");
    expect((await check(request(clientId), { cookie })).body.redirect_origin).toBe(
      "https://client.example.org",
    );
  });
});
