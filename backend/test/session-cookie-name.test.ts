/**
 * The app session cookie's name (epic #2014 phase #2015, ADR 0119 decision 10).
 *
 * Every cookie the API trusts to authenticate or link a session is host-only and `__Host-`
 * prefixed, because a page on a sibling host can set a cookie for the parent domain and cannot
 * set a `__Host-` one. `nemar_session` is scoped to `app.nemar.org` by a `Domain` attribute, so
 * the session moves to `__Host-nemar_session`. The move is a window, not a switch: the writer is
 * behind `HOST_PREFIXED_SESSION_COOKIE` and the readers accept both names, so a session minted
 * before the flag is still a session after it, and the flag can be turned back off.
 *
 * Everything here goes through the real routes and the real middleware over a real database.
 * Names and attribute strings are literals on purpose: a test that imported the constants would
 * agree with whatever they said.
 *
 *   WRITERS (five): `POST /auth/code/verify`, `POST /auth/logout`, the `GET /auth/me` slide,
 *   `GET /auth/orcid/callback` and `POST /auth/orcid/finalize`. With the flag off each sends
 *   today's header byte for byte (plus a clear of a `__Host-` cookie only when the request
 *   carried one); with it on each sends the new name with no `Domain`, then the legacy clears.
 *
 *   READERS (two): `webSessionMiddleware` (`/auth/me`) and `resolveCookieUser` inside
 *   `authMiddleware` (`/users/me`). Both take the new name first, fall back to the legacy one only
 *   when the new one is ABSENT, never rescue an invalid new cookie with a valid legacy one, and
 *   treat a header with more than one `__Host-nemar_session` as no session.
 *
 *   A `__Host-` cookie is minted only by a sign-in: the expiry slide never mints one from a value
 *   that was read under the legacy name.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "bun";
import { Hono } from "hono";
import { authOrcidRoutes } from "../src/routes/auth-orcid";
import { authWebRoutes } from "../src/routes/auth-web";
import { userRoutes } from "../src/routes/users";
import { hashAuthCode } from "../src/services/auth-code";
import { PENDING_COOKIE_NAME, encodeState, signPending } from "../src/services/orcid-auth";
import { issueSession } from "../src/services/web-session";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const APP = "https://app.nemar.org";
const ENCRYPTION_KEY = "session-cookie-test-encryption-key-0123456";
const CSRF = "csrf-session-cookie";
const SIGN_IN_EMAIL = "cookie-signin@nemar.test";
const SIGNUP_EMAIL = "cookie-signup@nemar.test";
const LINKED_ORCID = "0000-0001-5109-353X";
const NEW_ORCID = "0000-0002-1825-0097";
const PROD_DOMAIN = "app.nemar.org";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let orcidToken: Server;
let orcidPub: Server;
let realFetch: typeof fetch;

beforeAll(() => {
  orcidToken = Bun.serve({
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname === "/oauth/token") {
        return Response.json({ orcid: LINKED_ORCID, name: "Ada Lovelace", access_token: "x" });
      }
      return new Response("not found", { status: 404 });
    },
  });
  // ORCID's public record API, read behind the response by the name refresh. Served locally so
  // nothing leaves the machine.
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

interface Mode {
  /** The value of `HOST_PREFIXED_SESSION_COOKIE`; `undefined` leaves it unset. */
  flag: string | undefined;
  /** The value of `WEB_SESSION_COOKIE_DOMAIN`. */
  domain: string;
}

function env(mode: Mode): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "test",
    ENCRYPTION_KEY,
    WEB_SESSION_COOKIE_DOMAIN: mode.domain,
    HOST_PREFIXED_SESSION_COOKIE: mode.flag,
    ORCID_CLIENT_ID: "APP-TEST",
    ORCID_CLIENT_SECRET: "test-secret",
    ORCID_API_BASE: `http://localhost:${orcidToken.port}`,
    APP_BASE_URL: APP,
  } as unknown as Bindings;
}

beforeEach(() => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/auth", authWebRoutes);
  app.route("/auth", authOrcidRoutes);
  app.route("/users", userRoutes);
});

// ---------------------------------------------------------------------------------------------
// The header strings. Written out, not built from the production constants.
// ---------------------------------------------------------------------------------------------

const VALUE = "[A-Za-z0-9_-]{43}";

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Today's header, which the flag-off writers must still send byte for byte. */
function legacyIssued(domain: string, maxAge?: number): RegExp {
  const parts = [`nemar_session=${VALUE}`, "HttpOnly", "Secure", "SameSite=Lax", "Path=/"];
  if (domain) parts.push(`Domain=${escapeRe(domain)}`);
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  return new RegExp(`^${parts.join("; ")}$`);
}

/** The new name: no `Domain`, ever. */
function hostIssued(maxAge?: number): RegExp {
  const parts = [`__Host-nemar_session=${VALUE}`, "HttpOnly", "Secure", "SameSite=Lax", "Path=/"];
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  return new RegExp(`^${parts.join("; ")}$`);
}

function legacyCleared(domain: string): string {
  const parts = ["nemar_session=", "HttpOnly", "Secure", "SameSite=Lax", "Path=/"];
  if (domain) parts.push(`Domain=${domain}`);
  parts.push("Max-Age=0");
  return parts.join("; ");
}

const HOST_CLEARED = "__Host-nemar_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0";

/** The zone's parent domain, which the flag-on writers also clear the legacy cookie for. */
const PARENT_DOMAIN = "nemar.org";

/** The legacy clears the flag-on writers send, in order, none twice: the configured Domain (when
 *  there is one), host-only, and the parent domain. */
function legacyClears(domain: string): string[] {
  const domains = [...new Set([domain, "", PARENT_DOMAIN])];
  return domains.map((d) => legacyCleared(d));
}

/** A `__Host-nemar_session` cookie from before the flag was turned back off. */
const STALE_HOST_COOKIE = "__Host-nemar_session=a-cookie-from-before-the-flag-went-off";

/** The session cookie a request carries for a given mode: under the new name once the flag is
 *  on (that is what a browser holds then), under the legacy name otherwise. */
function sessionCookieFor(mode: Mode, value: string, carry: boolean): string {
  return carry || mode.flag === "1" ? `__Host-nemar_session=${value}` : `nemar_session=${value}`;
}

/** Append the stale `__Host-` cookie to a `Cookie` header when the case carries one. */
function withCarried(carry: boolean, ...parts: string[]): string {
  return [...parts, ...(carry ? [STALE_HOST_COOKIE] : [])].join("; ");
}

/** The session cookies of one response, in the order they were sent. Other cookies (the ORCID
 *  state and pending cookies) are not the subject of this file. */
function sessionCookies(res: Response): string[] {
  return res.headers
    .getSetCookie()
    .filter((c) => c.startsWith("nemar_session=") || c.startsWith("__Host-nemar_session="));
}

// ---------------------------------------------------------------------------------------------
// The five writers, each as a function of the environment it runs under.
// ---------------------------------------------------------------------------------------------

function seedWebUser(email: string, orcid: string | null = null): number {
  db.run(
    `INSERT INTO users (email, status, signup_source, email_verified, given_name, family_name,
                        orcid, orcid_verified, service_access)
     VALUES (?, 'verified', 'web', 1, 'Ada', 'Lovelace', ?, ?, 0)`,
    [email, orcid, orcid ? 1 : 0],
  );
  const row = db.query<{ id: number }, [string]>("SELECT id FROM users WHERE email = ?").get(email);
  if (!row) throw new Error(`seed failed for ${email}`);
  return row.id;
}

async function plantCode(mode: Mode, email: string, code: string): Promise<void> {
  db.run(
    `INSERT INTO auth_codes (email, code_hash, expires_at, user_id)
     VALUES (?, ?, datetime('now', '+10 minutes'), NULL)`,
    [email, await hashAuthCode(code, env(mode))],
  );
}

interface Writer {
  name: string;
  /** The `Max-Age` its issued cookie carries, or undefined for a browser-session cookie. */
  maxAge: number | undefined;
  /** True when the response clears the session instead of issuing one. */
  clears: boolean;
  /** `carry`: the request also carries a `__Host-nemar_session` cookie, as a browser does that
   *  was signed in while the flag was on. */
  run(mode: Mode, carry?: boolean): Promise<Response>;
}

const THIRTY_DAYS = 30 * 24 * 60 * 60;

const WRITERS: Writer[] = [
  {
    name: "POST /auth/code/verify",
    maxAge: undefined,
    clears: false,
    async run(mode, carry = false) {
      seedWebUser(SIGN_IN_EMAIL);
      await plantCode(mode, SIGN_IN_EMAIL, "123456");
      return app.request(
        "/auth/code/verify",
        {
          method: "POST",
          headers: {
            Origin: APP,
            "content-type": "application/json",
            ...(carry ? { Cookie: STALE_HOST_COOKIE } : {}),
          },
          body: JSON.stringify({ email: SIGN_IN_EMAIL, code: "123456", remember: false }),
        },
        env(mode),
      );
    },
  },
  {
    name: "POST /auth/logout",
    maxAge: 0,
    clears: true,
    async run(mode, carry = false) {
      const id = seedWebUser(SIGN_IN_EMAIL);
      const { cookieIdRaw } = await issueSession(env(mode), id, false, null, null, "orcid");
      return app.request(
        "/auth/logout",
        {
          method: "POST",
          headers: {
            Origin: APP,
            Cookie: withCarried(carry, sessionCookieFor(mode, cookieIdRaw, false)),
          },
        },
        env(mode),
      );
    },
  },
  {
    name: "GET /auth/me (the expiry slide)",
    maxAge: THIRTY_DAYS,
    clears: false,
    async run(mode, carry = false) {
      const id = seedWebUser(SIGN_IN_EMAIL);
      const { cookieIdRaw } = await issueSession(env(mode), id, true, null, null, "orcid");
      // A remember-me session in the last week of its life is the one the slide re-issues. Under
      // the new name when the flag is on (the slide re-issues only from a `__Host-` value) or when
      // the case carries a `__Host-` cookie, under the legacy name otherwise.
      db.run("UPDATE web_sessions SET expires_at = datetime('now', '+1 day')");
      return app.request(
        "/auth/me",
        { headers: { Cookie: sessionCookieFor(mode, cookieIdRaw, carry) } },
        env(mode),
      );
    },
  },
  {
    name: "GET /auth/orcid/callback (sign-in)",
    maxAge: undefined,
    clears: false,
    async run(mode, carry = false) {
      const id = seedWebUser(SIGN_IN_EMAIL, LINKED_ORCID);
      db.run(
        "INSERT INTO oauth_identities (user_id, provider, provider_subject, display_name) VALUES (?, 'orcid', ?, 'Ada')",
        [id, LINKED_ORCID],
      );
      return app.request(
        new Request(`${APP}/auth/orcid/callback?state=${CSRF}&code=fake-code`, {
          headers: {
            Cookie: withCarried(
              carry,
              `__Host-nemar_oauth_state=${encodeState({ csrf: CSRF, mode: "login", next: "/dashboard" })}`,
            ),
          },
        }),
        undefined,
        env(mode),
      );
    },
  },
  {
    name: "POST /auth/orcid/finalize (sign-up)",
    maxAge: undefined,
    clears: false,
    async run(mode, carry = false) {
      const pending = await signPending(
        { orcid: NEW_ORCID, name: "Ada Lovelace", exp: Date.now() + 60_000 },
        ENCRYPTION_KEY,
      );
      return app.request(
        "https://app.nemar.org/auth/orcid/finalize",
        {
          method: "POST",
          headers: {
            Origin: APP,
            Cookie: withCarried(carry, `${PENDING_COOKIE_NAME}=${pending}`),
            "content-type": "application/json",
          },
          body: JSON.stringify({ email: SIGNUP_EMAIL, city: "Cambridge", country: "GB" }),
        },
        env(mode),
      );
    },
  },
];

describe("the writers, with the flag off", () => {
  // Unset is production today. Every other spelling is also "off": only the exact string "1"
  // turns the new name on, so a flag typed as "true" or "0" cannot move anyone's cookie by mistake.
  const OFF_FLAGS: Array<string | undefined> = [undefined, "", "0", "true", "yes", "1 "];

  for (const writer of WRITERS) {
    for (const flag of OFF_FLAGS) {
      for (const domain of [PROD_DOMAIN, ""]) {
        test(`${writer.name} sends today's header byte for byte (flag ${JSON.stringify(flag)}, Domain ${JSON.stringify(domain)})`, async () => {
          const res = await writer.run({ flag, domain });
          expect(res.status === 200 || res.status === 302).toBe(true);
          const cookies = sessionCookies(res);
          if (writer.clears) {
            expect(cookies).toEqual([legacyCleared(domain)]);
          } else {
            expect(cookies).toHaveLength(1);
            expect(cookies[0]).toMatch(legacyIssued(domain, writer.maxAge));
          }
        });
      }
    }
  }
});

describe("the writers, with the flag off and a `__Host-` cookie on the request", () => {
  // Turned back off, the writers would otherwise leave a cookie behind that nothing removes and
  // that the reader prefers. Only a request that CARRIED one gets the clear; every case in the
  // describe above carries none and is byte for byte what it was.
  for (const writer of WRITERS) {
    for (const domain of [PROD_DOMAIN, ""]) {
      test(`${writer.name} also clears the \`__Host-\` cookie (Domain ${JSON.stringify(domain)})`, async () => {
        const res = await writer.run({ flag: undefined, domain }, true);
        expect(res.status === 200 || res.status === 302).toBe(true);
        const cookies = sessionCookies(res);
        if (writer.clears) {
          expect(cookies).toEqual([legacyCleared(domain), HOST_CLEARED]);
        } else {
          expect(cookies).toHaveLength(2);
          expect(cookies[0]).toMatch(legacyIssued(domain, writer.maxAge));
          expect(cookies[1]).toBe(HOST_CLEARED);
        }
      });
    }
  }
});

describe("the writers, with the flag on", () => {
  for (const writer of WRITERS) {
    test(`${writer.name} sets the new name with no Domain, then clears the legacy name for every Domain it could carry`, async () => {
      const res = await writer.run({ flag: "1", domain: PROD_DOMAIN });
      expect(res.status === 200 || res.status === 302).toBe(true);
      const cookies = sessionCookies(res);
      if (writer.clears) {
        expect(cookies).toEqual([HOST_CLEARED, ...legacyClears(PROD_DOMAIN)]);
      } else {
        expect(cookies).toHaveLength(4);
        expect(cookies[0]).toMatch(hostIssued(writer.maxAge));
        expect(cookies[0]).not.toContain("Domain");
        expect(cookies.slice(1)).toEqual(legacyClears(PROD_DOMAIN));
      }
    });

    test(`${writer.name} never routes the new name through the configured Domain`, async () => {
      // Another Domain, so a leak of the setting into the new cookie cannot hide behind the
      // value the cases above use.
      const res = await writer.run({ flag: "1", domain: "elsewhere.example" });
      const [first] = sessionCookies(res);
      expect(first.startsWith("__Host-nemar_session=")).toBe(true);
      expect(first).not.toContain("Domain");
      expect(first).not.toContain("elsewhere.example");
    });

    for (const domain of ["", PARENT_DOMAIN]) {
      test(`${writer.name} sends no clear twice (Domain ${JSON.stringify(domain)})`, async () => {
        // Staging keeps `WEB_SESSION_COOKIE_DOMAIN` empty, so the configured-Domain clear and the
        // host-only one are the same cookie; a Domain equal to the parent domain is the third.
        const res = await writer.run({ flag: "1", domain });
        const cookies = sessionCookies(res);
        const expectedClears = legacyClears(domain);
        expect(expectedClears).toHaveLength(2);
        if (writer.clears) {
          expect(cookies).toEqual([HOST_CLEARED, ...expectedClears]);
        } else {
          expect(cookies).toHaveLength(3);
          expect(cookies[0]).toMatch(hostIssued(writer.maxAge));
          expect(cookies.slice(1)).toEqual(expectedClears);
        }
      });
    }
  }

  test("a sign-in sets a cookie that signs the same person in on the next request", async () => {
    const mode: Mode = { flag: "1", domain: PROD_DOMAIN };
    const id = seedWebUser(SIGN_IN_EMAIL);
    await plantCode(mode, SIGN_IN_EMAIL, "123456");
    const signIn = await app.request(
      "/auth/code/verify",
      {
        method: "POST",
        headers: { Origin: APP, "content-type": "application/json" },
        body: JSON.stringify({ email: SIGN_IN_EMAIL, code: "123456", remember: false }),
      },
      env(mode),
    );
    const issued = sessionCookies(signIn)[0].split(";")[0];
    expect(issued.startsWith("__Host-nemar_session=")).toBe(true);

    const me = await app.request("/auth/me", { headers: { Cookie: issued } }, env(mode));
    expect(((await me.json()) as { user: { id: number } }).user.id).toBe(id);
  });

  test("the expiry slide sends no cookie for a session read under the legacy name", async () => {
    // A `__Host-` cookie is minted only by a sign-in. Re-issuing one from a value that arrived
    // under the legacy name would turn a value read from the cookie a sibling host can set into
    // the cookie it cannot.
    const mode: Mode = { flag: "1", domain: PROD_DOMAIN };
    const id = seedWebUser(SIGN_IN_EMAIL);
    const { cookieIdRaw } = await issueSession(env(mode), id, true, null, null, "orcid");
    db.run("UPDATE web_sessions SET expires_at = datetime('now', '+1 day')");
    const res = await app.request(
      "/auth/me",
      { headers: { Cookie: `nemar_session=${cookieIdRaw}` } },
      env(mode),
    );
    expect(((await res.json()) as { user: { id: number } }).user.id).toBe(id);
    expect(sessionCookies(res)).toEqual([]);
    expect(res.headers.getSetCookie()).toEqual([]);
    // The row still slid: only the cookie is withheld.
    const row = db
      .query<{ later: number }, []>(
        "SELECT expires_at > datetime('now', '+10 days') AS later FROM web_sessions",
      )
      .get();
    expect(row?.later).toBe(1);
  });

  test("with a legacy cookie and a `__Host-` one the slide uses the `__Host-` one", async () => {
    const mode: Mode = { flag: "1", domain: PROD_DOMAIN };
    const aliceId = seedWebUser("alice@nemar.test");
    const bobId = seedWebUser("bob@nemar.test");
    const alice = await issueSession(env(mode), aliceId, true, null, null, "orcid");
    const bob = await issueSession(env(mode), bobId, true, null, null, "orcid");
    db.run("UPDATE web_sessions SET expires_at = datetime('now', '+1 day')");
    for (const header of [
      `__Host-nemar_session=${alice.cookieIdRaw}; nemar_session=${bob.cookieIdRaw}`,
      `nemar_session=${bob.cookieIdRaw}; __Host-nemar_session=${alice.cookieIdRaw}`,
    ]) {
      db.run("UPDATE web_sessions SET expires_at = datetime('now', '+1 day')");
      const res = await app.request("/auth/me", { headers: { Cookie: header } }, env(mode));
      expect(((await res.json()) as { user: { id: number } }).user.id).toBe(aliceId);
      expect(sessionCookies(res)[0].split(";")[0]).toBe(
        `__Host-nemar_session=${alice.cookieIdRaw}`,
      );
    }
  });

  test("with the flag off a legacy-read slide re-issues the legacy cookie as it always did", async () => {
    // No `__Host-` cookie is minted, so nothing about the flag-off bytes changes (the matrix
    // above pins them); this is the same fact stated as a rule.
    const mode: Mode = { flag: undefined, domain: PROD_DOMAIN };
    const id = seedWebUser(SIGN_IN_EMAIL);
    const { cookieIdRaw } = await issueSession(env(mode), id, true, null, null, "orcid");
    db.run("UPDATE web_sessions SET expires_at = datetime('now', '+1 day')");
    const res = await app.request(
      "/auth/me",
      { headers: { Cookie: `nemar_session=${cookieIdRaw}` } },
      env(mode),
    );
    expect(sessionCookies(res)).toHaveLength(1);
    expect(sessionCookies(res)[0]).toMatch(legacyIssued(PROD_DOMAIN, THIRTY_DAYS));
  });
});

describe("the readers", () => {
  const MODE: Mode = { flag: undefined, domain: "" };

  /** Two live accounts with a session each, so a response says which cookie was honoured. */
  async function twoSessions(): Promise<{
    alice: { id: number; cookie: string };
    bob: { id: number; cookie: string };
  }> {
    const aliceId = seedWebUser("alice@nemar.test");
    const bobId = seedWebUser("bob@nemar.test");
    const a = await issueSession(env(MODE), aliceId, false, null, null, "orcid");
    const b = await issueSession(env(MODE), bobId, false, null, null, "orcid");
    return {
      alice: { id: aliceId, cookie: a.cookieIdRaw },
      bob: { id: bobId, cookie: b.cookieIdRaw },
    };
  }

  /** What each of the two readers makes of one `Cookie` header: the id it signed in, or null. */
  async function whoAmI(cookieHeader: string): Promise<{ web: number | null; api: number | null }> {
    const web = await app.request("/auth/me", { headers: { Cookie: cookieHeader } }, env(MODE));
    const webBody = (await web.json()) as { user: { id: number } | null };
    const api = await app.request("/users/me", { headers: { Cookie: cookieHeader } }, env(MODE));
    const apiBody = api.status === 200 ? ((await api.json()) as { user: { id: number } }) : null;
    return { web: webBody.user?.id ?? null, api: apiBody?.user.id ?? null };
  }

  test("a request carrying only the legacy name is authenticated by both readers", async () => {
    const { alice } = await twoSessions();
    expect(await whoAmI(`nemar_session=${alice.cookie}`)).toEqual({
      web: alice.id,
      api: alice.id,
    });
  });

  test("a request carrying only the new name is authenticated by both readers", async () => {
    const { alice } = await twoSessions();
    expect(await whoAmI(`__Host-nemar_session=${alice.cookie}`)).toEqual({
      web: alice.id,
      api: alice.id,
    });
  });

  test("with both names, the new one wins, in either order on the wire", async () => {
    const { alice, bob } = await twoSessions();
    const expected = { web: alice.id, api: alice.id };
    expect(
      await whoAmI(`__Host-nemar_session=${alice.cookie}; nemar_session=${bob.cookie}`),
    ).toEqual(expected);
    expect(
      await whoAmI(`nemar_session=${bob.cookie}; __Host-nemar_session=${alice.cookie}`),
    ).toEqual(expected);
  });

  test("an invalid new cookie is not rescued by a valid legacy one", async () => {
    // A legacy cookie never outranks a `__Host-` one: a browser that holds a `__Host-` cookie
    // never has it displaced by a legacy one, whatever state the `__Host-` cookie is in.
    const { alice } = await twoSessions();
    expect(
      await whoAmI(`__Host-nemar_session=not-a-live-session; nemar_session=${alice.cookie}`),
    ).toEqual({ web: null, api: null });
    expect(
      await whoAmI(`nemar_session=${alice.cookie}; __Host-nemar_session=not-a-live-session`),
    ).toEqual({ web: null, api: null });
  });

  test("an empty new cookie is invalid too, and does not fall through to the legacy one", async () => {
    const { alice } = await twoSessions();
    expect(await whoAmI(`__Host-nemar_session=; nemar_session=${alice.cookie}`)).toEqual({
      web: null,
      api: null,
    });
  });

  test("a header with more than one `__Host-` cookie is no session, and no legacy cookie rescues it", async () => {
    const { alice, bob } = await twoSessions();
    const none = { web: null, api: null };
    expect(
      await whoAmI(`__Host-nemar_session=${alice.cookie}; __Host-nemar_session=${alice.cookie}`),
    ).toEqual(none);
    expect(
      await whoAmI(`__Host-nemar_session=${alice.cookie}; __Host-nemar_session=${bob.cookie}`),
    ).toEqual(none);
    expect(
      await whoAmI(
        `__Host-nemar_session=${alice.cookie}; nemar_session=${bob.cookie}; __Host-nemar_session=${alice.cookie}`,
      ),
    ).toEqual(none);
  });

  test("a revoked session behind the new name stays revoked, whatever the legacy cookie holds", async () => {
    const { alice, bob } = await twoSessions();
    db.run("UPDATE web_sessions SET revoked_at = datetime('now') WHERE user_id = ?", [alice.id]);
    expect(
      await whoAmI(`__Host-nemar_session=${alice.cookie}; nemar_session=${bob.cookie}`),
    ).toEqual({
      web: null,
      api: null,
    });
  });
});

/** A browser's cookie jar, reduced to what the sign-in and sign-out responses ask of it: a
 *  cookie is kept by name and `Domain`, a `Max-Age=0` removes it, and every cookie it holds is sent
 *  back. `keepHostCookies` models a deployment that never clears a `__Host-` cookie. */
class Jar {
  private cookies = new Map<string, { name: string; value: string }>();
  constructor(private keepHostCookies = false) {}

  absorb(res: Response): void {
    for (const raw of res.headers.getSetCookie()) {
      const [pair, ...attrs] = raw.split(";").map((p) => p.trim());
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      const domain = attrs.find((a) => a.startsWith("Domain="))?.slice("Domain=".length) ?? "";
      const key = `${name}|${domain}`;
      if (attrs.includes("Max-Age=0")) {
        if (!(this.keepHostCookies && name.startsWith("__Host-"))) this.cookies.delete(key);
      } else {
        this.cookies.set(key, { name, value });
      }
    }
  }

  header(): string {
    return [...this.cookies.values()].map((c) => `${c.name}=${c.value}`).join("; ");
  }
}

describe("turning the flag back off", () => {
  const ON: Mode = { flag: "1", domain: PROD_DOMAIN };
  const OFF: Mode = { flag: undefined, domain: PROD_DOMAIN };

  async function signIn(mode: Mode, jar: Jar, code: string): Promise<void> {
    await plantCode(mode, SIGN_IN_EMAIL, code);
    const res = await app.request(
      "/auth/code/verify",
      {
        method: "POST",
        headers: { Origin: APP, "content-type": "application/json", Cookie: jar.header() },
        body: JSON.stringify({ email: SIGN_IN_EMAIL, code, remember: false }),
      },
      env(mode),
    );
    expect(res.status).toBe(200);
    jar.absorb(res);
  }

  async function signOut(mode: Mode, jar: Jar): Promise<void> {
    const res = await app.request(
      "/auth/logout",
      { method: "POST", headers: { Origin: APP, Cookie: jar.header() } },
      env(mode),
    );
    expect(res.status).toBe(200);
    jar.absorb(res);
  }

  async function whoAmI(mode: Mode, jar: Jar): Promise<number | null> {
    const res = await app.request("/auth/me", { headers: { Cookie: jar.header() } }, env(mode));
    return ((await res.json()) as { user: { id: number } | null }).user?.id ?? null;
  }

  test("flag on, sign in, flag off, sign out, sign in again: the person is authenticated", async () => {
    const id = seedWebUser(SIGN_IN_EMAIL);
    const jar = new Jar();

    await signIn(ON, jar, "111111");
    expect(jar.header()).toContain("__Host-nemar_session=");
    expect(await whoAmI(ON, jar)).toBe(id);

    // The flag goes back off. The browser still holds the `__Host-` cookie, and the sign-out
    // that follows must remove it.
    await signOut(OFF, jar);
    expect(jar.header()).toBe("");

    await signIn(OFF, jar, "222222");
    expect(jar.header()).toMatch(/^nemar_session=/);
    expect(jar.header()).not.toContain("__Host-");
    expect(await whoAmI(OFF, jar)).toBe(id);
  });

  test("a browser that is signed in again with the flag off sheds the `__Host-` cookie at sign-in too", async () => {
    // No sign-out in between: the first response of the flag-off Worker that carries the cookie
    // removes it, and the new session is the one the reader sees.
    const id = seedWebUser(SIGN_IN_EMAIL);
    const jar = new Jar();
    await signIn(ON, jar, "111111");
    await signIn(OFF, jar, "222222");
    expect(jar.header()).not.toContain("__Host-");
    expect(await whoAmI(OFF, jar)).toBe(id);
  });

  test("without the clear the same sequence would lock the person out until the cookie expires", async () => {
    // The control: a jar that never drops a `__Host-` cookie. The stale cookie names a session
    // the sign-out revoked, the reader prefers it, and the new legacy session is never looked at.
    seedWebUser(SIGN_IN_EMAIL);
    const jar = new Jar(true);
    await signIn(ON, jar, "111111");
    await signOut(OFF, jar);
    await signIn(OFF, jar, "222222");
    expect(jar.header()).toContain("__Host-nemar_session=");
    expect(jar.header()).toContain("nemar_session=");
    expect(await whoAmI(OFF, jar)).toBeNull();
  });
});

describe("signing out ends every session the request carries", () => {
  test("a legacy cookie and a `__Host-` cookie for different sessions are both revoked", async () => {
    const mode: Mode = { flag: "1", domain: PROD_DOMAIN };
    const id = seedWebUser(SIGN_IN_EMAIL);
    const a = await issueSession(env(mode), id, false, null, null, "orcid");
    const b = await issueSession(env(mode), id, false, null, null, "orcid");
    const res = await app.request(
      "/auth/logout",
      {
        method: "POST",
        headers: {
          Origin: APP,
          Cookie: `__Host-nemar_session=${a.cookieIdRaw}; nemar_session=${b.cookieIdRaw}`,
        },
      },
      env(mode),
    );
    expect(res.status).toBe(200);
    const live = db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM web_sessions WHERE revoked_at IS NULL")
      .get();
    expect(live?.n).toBe(0);
    // ...and neither cookie signs anyone in afterwards.
    for (const header of [
      `__Host-nemar_session=${a.cookieIdRaw}`,
      `nemar_session=${b.cookieIdRaw}`,
    ]) {
      const me = await app.request("/auth/me", { headers: { Cookie: header } }, env(mode));
      expect(((await me.json()) as { user: unknown }).user).toBeNull();
    }
  });

  test("a header that carries the same cookie twice still revokes its session", async () => {
    const mode: Mode = { flag: undefined, domain: PROD_DOMAIN };
    const id = seedWebUser(SIGN_IN_EMAIL);
    const a = await issueSession(env(mode), id, false, null, null, "orcid");
    await app.request(
      "/auth/logout",
      {
        method: "POST",
        headers: {
          Origin: APP,
          Cookie: `__Host-nemar_session=${a.cookieIdRaw}; __Host-nemar_session=${a.cookieIdRaw}`,
        },
      },
      env(mode),
    );
    const live = db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM web_sessions WHERE revoked_at IS NULL")
      .get();
    expect(live?.n).toBe(0);
  });
});

describe("the flag in the Worker configuration", () => {
  const config = Bun.TOML.parse(
    readFileSync(join(import.meta.dir, "../wrangler-sccn.toml"), "utf-8"),
  ) as {
    vars?: Record<string, unknown>;
    env?: Record<string, { vars?: Record<string, unknown> }>;
  };

  test("it is on in the dev Worker's vars and nowhere in production's", () => {
    // Production turns it on only after the website reads the new name and the API has
    // released, which is the owner's act and not a line in this file (ADR 0119 decision 10).
    expect(config.env?.dev?.vars?.HOST_PREFIXED_SESSION_COOKIE).toBe("1");
    expect(config.vars).toBeDefined();
    expect(Object.keys(config.vars ?? {})).not.toContain("HOST_PREFIXED_SESSION_COOKIE");
  });

  test("it is the only table that names it", () => {
    const named: string[] = [];
    (function walk(node: unknown, path: string) {
      if (typeof node !== "object" || node === null) return;
      for (const [key, value] of Object.entries(node)) {
        const here = path === "" ? key : `${path}.${key}`;
        if (key === "HOST_PREFIXED_SESSION_COOKIE") named.push(here);
        walk(value, here);
      }
    })(config, "");
    expect(named).toEqual(["env.dev.vars.HOST_PREFIXED_SESSION_COOKIE"]);
  });
});
