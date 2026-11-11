/**
 * The ORCID flow's two cookies are host-only and `__Host-` prefixed (epic #2014 phase #2015,
 * ADR 0119 decision 10).
 *
 * Every cookie the API trusts to authenticate or link a session is one a page on a sibling host
 * cannot set: the partner-host rule does not stop a sibling from setting a cookie for the parent
 * domain, and a `__Host-` cookie (Secure, Path=/, no Domain) is the one kind a browser accepts
 * from no other host. The state cookie (`__Host-nemar_oauth_state`) and the pending-signup cookie
 * (`__Host-nemar_orcid_pending`) are therefore renamed. The move does NOT depend on
 * `HOST_PREFIXED_SESSION_COOKIE`; it is read ONLY under the new name; the old names are only
 * cleared.
 *
 * Real engine throughout: the real routes over bun:sqlite with every migration applied, ORCID's
 * token endpoint and public record served by local `Bun.serve()` instances. Names and attribute
 * strings are literals: a test that imported the constants would agree with whatever they said.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Hono } from "hono";
import { authOrcidRoutes } from "../src/routes/auth-orcid";
import { encodeState, signPending } from "../src/services/orcid-auth";
import { issueSession } from "../src/services/web-session";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const APP = "https://app.nemar.org";
const ENCRYPTION_KEY = "oauth-cookie-test-encryption-key-0123456";
const CSRF = "csrf-oauth-cookies";
const LINKED_ORCID = "0000-0001-5109-353X";
const NEW_ORCID = "0000-0002-1825-0097";
const EMAIL = "cookie-owner@nemar.test";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let orcidToken: Server;
let orcidPub: Server;
let realFetch: typeof fetch;
/** Which iD ORCID's token endpoint answers with, reset per test. */
let tokenOrcid = LINKED_ORCID;

beforeAll(() => {
  orcidToken = Bun.serve({
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname === "/oauth/token") {
        return Response.json({ orcid: tokenOrcid, name: "Ada Lovelace", access_token: "x" });
      }
      return new Response("not found", { status: 404 });
    },
  });
  orcidPub = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json({
        name: { "given-names": { value: "Ada" }, "family-name": { value: "Lovelace" } },
      }),
  });
  realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    if (url.hostname.endsWith("orcid.org")) {
      const local = new URL(url.pathname + url.search, `http://127.0.0.1:${orcidPub.port}`);
      return realFetch(new Request(local, req));
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  orcidToken.stop(true);
  orcidPub.stop(true);
});

function env(domain = "app.nemar.org"): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "test",
    ENCRYPTION_KEY,
    WEB_SESSION_COOKIE_DOMAIN: domain,
    ORCID_CLIENT_ID: "APP-TEST",
    ORCID_CLIENT_SECRET: "test-secret",
    ORCID_API_BASE: `http://localhost:${orcidToken.port}`,
    APP_BASE_URL: APP,
  } as unknown as Bindings;
}

beforeEach(() => {
  db = freshDb();
  tokenOrcid = LINKED_ORCID;
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/auth", authOrcidRoutes);
});

function seedUser(email: string, orcid: string | null = null): number {
  db.run(
    `INSERT INTO users (email, status, signup_source, email_verified, given_name, family_name,
                        orcid, orcid_verified, service_access)
     VALUES (?, 'verified', 'web', 1, 'Ada', 'Lovelace', ?, ?, 0)`,
    [email, orcid, orcid ? 1 : 0],
  );
  return (
    db.query<{ id: number }, [string]>("SELECT id FROM users WHERE email = ?").get(email) as {
      id: number;
    }
  ).id;
}

function linkIdentity(userId: number, orcid: string): void {
  db.run(
    "INSERT INTO oauth_identities (user_id, provider, provider_subject, display_name) VALUES (?, 'orcid', ?, 'Ada')",
    [userId, orcid],
  );
}

function count(sql: string): number {
  return (db.query<{ n: number }, []>(sql).get() as { n: number }).n;
}

/** Everything a callback could change: accounts, identities and sessions, as one comparable value. */
function accountState(): string {
  return JSON.stringify({
    users: db.query("SELECT id, email, orcid, orcid_verified, status FROM users ORDER BY id").all(),
    identities: db.query("SELECT user_id, provider_subject FROM oauth_identities").all(),
    sessions: count("SELECT COUNT(*) AS n FROM web_sessions"),
  });
}

function stateValue(mode: "login" | "link" | "relink" = "login", next = "/dashboard"): string {
  return encodeState({ csrf: CSRF, mode, next });
}

function callbackUrl(base = APP): string {
  return `${base}/auth/orcid/callback?state=${CSRF}&code=fake-code`;
}

function callback(cookie: string, base = APP, domain = "app.nemar.org"): Promise<Response> {
  return Promise.resolve(
    app.request(
      new Request(callbackUrl(base), { headers: { Cookie: cookie } }),
      undefined,
      env(domain),
    ),
  );
}

function cookiesOf(res: Response, name: string): string[] {
  return res.headers.getSetCookie().filter((c) => c.startsWith(`${name}=`));
}

function location(res: Response): string {
  return res.headers.get("Location") ?? "";
}

describe("the state cookie is written under the new name", () => {
  test("start sets __Host-nemar_oauth_state: Secure, HttpOnly, Path=/, no Domain, 10 minutes", async () => {
    // A configured Domain is exactly what must NOT reach it: a `__Host-` cookie that carried one
    // would be refused by every browser.
    for (const domain of ["app.nemar.org", ""]) {
      const res = await app.request(`${APP}/auth/orcid/start`, {}, env(domain));
      expect(res.status).toBe(302);
      const [state, ...rest] = cookiesOf(res, "__Host-nemar_oauth_state");
      expect(rest).toEqual([]);
      expect(state).toMatch(
        /^__Host-nemar_oauth_state=[^;]+; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=600$/,
      );
      expect(state).not.toContain("Domain");
      expect(cookiesOf(res, "nemar_oauth_state")).toEqual([]);
    }
  });

  test("a start then a callback with that cookie signs a linked account in", async () => {
    const id = seedUser(EMAIL, LINKED_ORCID);
    linkIdentity(id, LINKED_ORCID);
    const start = await app.request(`${APP}/auth/orcid/start`, {}, env());
    const stateCookie = cookiesOf(start, "__Host-nemar_oauth_state")[0].split(";")[0];
    const csrf = new URL(location(start)).searchParams.get("state");
    const res = await app.request(
      new Request(`${APP}/auth/orcid/callback?state=${csrf}&code=fake-code`, {
        headers: { Cookie: stateCookie },
      }),
      undefined,
      env(),
    );
    expect(res.status).toBe(302);
    expect(location(res)).toBe(`${APP}/dashboard`);
    expect(count("SELECT COUNT(*) AS n FROM web_sessions")).toBe(1);
  });
});

describe("an old-name state cookie is not a state", () => {
  // Read ONLY under the new name, with no fallback: a state cookie under the old name, with a
  // matching `state` parameter and a valid code, gets the same refusal as no cookie at all.
  test("a matching state parameter and a valid code under the old name: orcid_state, nothing changes", async () => {
    const id = seedUser(EMAIL, LINKED_ORCID);
    linkIdentity(id, LINKED_ORCID);
    const before = accountState();
    const res = await callback(`nemar_oauth_state=${stateValue("login")}`);
    expect(res.status).toBe(302);
    expect(location(res)).toBe(`${APP}/login?error=orcid_state`);
    expect(res.headers.getSetCookie().some((c) => c.startsWith("nemar_session="))).toBe(false);
    expect(res.headers.getSetCookie().some((c) => c.startsWith("__Host-nemar_session="))).toBe(
      false,
    );
    expect(accountState()).toBe(before);
  });

  test("the same holds for a link: no identity is attached and the account's iD is unchanged", async () => {
    const id = seedUser(EMAIL);
    const { cookieIdRaw } = await issueSession(env(), id, false, null, null, "orcid");
    tokenOrcid = NEW_ORCID;
    const before = accountState();
    const refused = await callback(
      `nemar_session=${cookieIdRaw}; nemar_oauth_state=${stateValue("link", "/settings")}`,
    );
    expect(location(refused)).toContain("error=orcid_state");
    expect(accountState()).toBe(before);

    // The control: the same request under the new name does link, so the refusal above is the
    // name and not something else about the request.
    const linked = await callback(
      `nemar_session=${cookieIdRaw}; __Host-nemar_oauth_state=${stateValue("link", "/settings")}`,
    );
    expect(location(linked)).toBe(`${APP}/settings`);
    expect(count(`SELECT COUNT(*) AS n FROM oauth_identities WHERE user_id = ${id}`)).toBe(1);
    expect(accountState()).not.toBe(before);
  });

  test("both names on one request: only the new one counts", async () => {
    const id = seedUser(EMAIL, LINKED_ORCID);
    linkIdentity(id, LINKED_ORCID);
    const before = accountState();
    const other = encodeState({ csrf: "some-other-csrf", mode: "login", next: "/dashboard" });
    // New name carries a state that does not match the parameter; the old name's would.
    const res = await callback(
      `__Host-nemar_oauth_state=${other}; nemar_oauth_state=${stateValue()}`,
    );
    expect(location(res)).toContain("error=orcid_state");
    expect(accountState()).toBe(before);
  });
});

describe("a failed callback clears every name, and a successful one does too", () => {
  test("new name host-only, then the old name with the configured Domain and without", async () => {
    const res = await callback(`nemar_oauth_state=${stateValue()}`);
    expect(res.headers.getSetCookie()).toEqual([
      "__Host-nemar_oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0",
      "nemar_oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Domain=app.nemar.org; Max-Age=0",
      "nemar_oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0",
    ]);
  });

  test("with no Domain configured the old name is cleared once", async () => {
    const res = await callback(`nemar_oauth_state=${stateValue()}`, APP, "");
    expect(res.headers.getSetCookie()).toEqual([
      "__Host-nemar_oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0",
      "nemar_oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0",
    ]);
  });
});

describe("the pending-signup cookie", () => {
  async function pendingCookie(): Promise<string> {
    return signPending(
      { orcid: NEW_ORCID, name: "Ada Lovelace", exp: Date.now() + 60_000 },
      ENCRYPTION_KEY,
    );
  }

  function finalize(cookie: string, domain = "app.nemar.org"): Promise<Response> {
    return Promise.resolve(
      app.request(
        `${APP}/auth/orcid/finalize`,
        {
          method: "POST",
          headers: { Origin: APP, Cookie: cookie, "content-type": "application/json" },
          body: JSON.stringify({ email: EMAIL, city: "Cambridge", country: "GB" }),
        },
        env(domain),
      ),
    );
  }

  test("a brand-new iD's callback sets __Host-nemar_orcid_pending with no Domain, and finalize accepts it", async () => {
    tokenOrcid = NEW_ORCID;
    const res = await callback(`__Host-nemar_oauth_state=${stateValue("login", "/")}`);
    expect(res.status).toBe(302);
    expect(location(res)).toBe(`${APP}/auth/orcid/complete`);
    const [pending, ...rest] = cookiesOf(res, "__Host-nemar_orcid_pending");
    expect(rest).toEqual([]);
    expect(pending).toMatch(
      /^__Host-nemar_orcid_pending=[^;]+; HttpOnly; Secure; SameSite=Lax; Path=\/; Max-Age=900$/,
    );
    expect(pending).not.toContain("Domain");
    expect(cookiesOf(res, "nemar_orcid_pending")).toEqual([]);

    const done = await finalize(pending.split(";")[0]);
    expect(done.status).toBe(200);
    expect(count("SELECT COUNT(*) AS n FROM users WHERE orcid IS NOT NULL")).toBe(1);
    // The finalize response clears the pending cookie under every name.
    expect(done.headers.getSetCookie().filter((c) => c.includes("orcid_pending="))).toEqual([
      "__Host-nemar_orcid_pending=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0",
      "nemar_orcid_pending=; HttpOnly; Secure; SameSite=Lax; Path=/; Domain=app.nemar.org; Max-Age=0",
      "nemar_orcid_pending=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0",
    ]);
  });

  test("a pending cookie under the old name is not accepted by finalize, and creates no account", async () => {
    const before = accountState();
    const res = await finalize(`nemar_orcid_pending=${await pendingCookie()}`);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("orcid_pending_expired");
    expect(accountState()).toBe(before);

    // The control: the same blob under the new name creates the account.
    const ok = await finalize(`__Host-nemar_orcid_pending=${await pendingCookie()}`);
    expect(ok.status).toBe(200);
    expect(accountState()).not.toBe(before);
  });
});

describe("plain-http loopback (local development) keeps the unprefixed names", () => {
  // A `__Host-` cookie must be Secure and a browser on plain http may refuse it, so local
  // development keeps the old names, the way the website's dev login keeps the legacy session
  // cookie name. Anything that is not plain http on loopback gets the prefixed names.
  const LOOPBACK = ["http://localhost:8787", "http://127.0.0.1:8787", "http://localhost"];
  const NOT_LOOPBACK = ["https://localhost:8787", "http://app.nemar.org", "https://app.nemar.org"];

  test("start sets nemar_oauth_state, with the configured Domain as before", async () => {
    for (const base of LOOPBACK) {
      const res = await app.request(`${base}/auth/orcid/start`, {}, env());
      expect(cookiesOf(res, "__Host-nemar_oauth_state"), base).toEqual([]);
      expect(cookiesOf(res, "nemar_oauth_state")[0], base).toMatch(
        /^nemar_oauth_state=[^;]+; HttpOnly; Secure; SameSite=Lax; Path=\/; Domain=app\.nemar\.org; Max-Age=600$/,
      );
    }
  });

  test("a callback on loopback reads the old name and refuses the new one", async () => {
    const id = seedUser(EMAIL, LINKED_ORCID);
    linkIdentity(id, LINKED_ORCID);
    for (const base of LOOPBACK) {
      const bad = await callback(`__Host-nemar_oauth_state=${stateValue()}`, base);
      expect(location(bad), base).toContain("error=orcid_state");
    }
    const good = await callback(`nemar_oauth_state=${stateValue()}`, LOOPBACK[0]);
    expect(location(good)).toBe(`${APP}/dashboard`);
  });

  test("the pending cookie follows the same rule", async () => {
    tokenOrcid = NEW_ORCID;
    const res = await callback(`nemar_oauth_state=${stateValue()}`, LOOPBACK[0]);
    expect(cookiesOf(res, "nemar_orcid_pending")).toHaveLength(1);
    expect(cookiesOf(res, "__Host-nemar_orcid_pending")).toEqual([]);
  });

  test("off loopback, including https on localhost and http on a NEMAR host, the new names are used", async () => {
    for (const base of NOT_LOOPBACK) {
      const res = await app.request(`${base}/auth/orcid/start`, {}, env());
      expect(cookiesOf(res, "__Host-nemar_oauth_state"), base).toHaveLength(1);
      expect(cookiesOf(res, "nemar_oauth_state"), base).toEqual([]);
    }
  });
});
