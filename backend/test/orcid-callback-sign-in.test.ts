/**
 * What the ORCID callback does with a session cookie that is already in the browser (ADR 0119
 * rule 10; epic #2014 phase #2017 round 1).
 *
 * Real route tests in the shape of `orcid-relink-route.test.ts`: bun:sqlite behind `realD1` with
 * every migration, real sessions from `issueSession`, real state cookies from `encodeState`, the real
 * routes through `app.request`, and a real local server standing in for ORCID's token endpoint (the
 * only external boundary). Nothing here depends on the authorization endpoint, so the rules can ship
 * on their own; `oidc-authorize-sign-in-loop.test.ts` drives the same callback from the check route.
 *
 *   1. A plain sign-in (`mode=login`) never attaches the finished iD to the account a cookie already
 *      in the browser names, under either cookie name and whether `HOST_PREFIXED_SESSION_COOKIE` is
 *      on or off. The account is the one the iD itself names (signed in with a FRESH session,
 *      whatever session the browser held) or a new sign-up.
 *   2. A link is armed only by the POST start, which checks Origin and requires a session; a GET
 *      start with `mode=link` or `mode=relink` starts a plain sign-in, with the flag on or off.
 *   3. An explicit link (`link` or `relink` in the state cookie) attaches the iD to the session's
 *      account; while the flag is on, only to a session read under the `__Host-` name. With the flag
 *      off a legacy-name session still decides, for a link the POST started: that residual closes
 *      only when the production flag is on (ADR 0119 rule 10), and a test below states it.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Hono } from "hono";
import { authOrcidRoutes } from "../src/routes/auth-orcid";
import { decodeState, encodeState } from "../src/services/orcid-auth";
import { hashCookieId, issueSession } from "../src/services/web-session";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const APP = "https://app.nemar.org";
const CSRF = "csrf-callback-sign-in-test";
const PERSON_ID = "0000-0002-1825-0097";
const OTHER_ID = "0000-0001-5109-3700";

/** The iD the stand-in's token endpoint returns for the next exchange. */
let returnedOrcid = PERSON_ID;
let orcid: Server;
let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let flag: string | undefined;

beforeAll(() => {
  orcid = Bun.serve({
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname === "/oauth/token") {
        return Response.json({ orcid: returnedOrcid, name: "Ada Lovelace", access_token: "x" });
      }
      return new Response("not found", { status: 404 });
    },
  });
});

afterAll(() => {
  orcid.stop(true);
});

beforeEach(() => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/auth", authOrcidRoutes);
  returnedOrcid = PERSON_ID;
  flag = "1";
});

function env(): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "test",
    ORCID_CLIENT_ID: "APP-TEST",
    ORCID_CLIENT_SECRET: "test-secret",
    ORCID_API_BASE: `http://localhost:${orcid.port}`,
    ORCID_PUB_API_BASE: `http://localhost:${orcid.port}`,
    APP_BASE_URL: APP,
    WEB_SESSION_COOKIE_DOMAIN: "",
    HOST_PREFIXED_SESSION_COOKIE: flag,
    ENCRYPTION_KEY: "callback-test-encryption-key-0123456789",
  } as unknown as Bindings;
}

let counter = 0;

/** An active person, holding `identity` as a proven ORCID iD when one is given. */
function seedPerson(identity: string | null = null): number {
  counter += 1;
  const email = `cbperson${counter}@example.org`;
  db.run(
    `INSERT INTO users (email, status, signup_source, email_verified, account_kind, orcid, orcid_verified)
     VALUES (?, 'verified', 'web', 1, 'person', ?, ?)`,
    [email, identity, identity ? 1 : 0],
  );
  const id = db.query<{ id: number }, [string]>("SELECT id FROM users WHERE email = ?").get(email)
    ?.id as number;
  if (identity) {
    db.run(
      "INSERT INTO oauth_identities (user_id, provider, provider_subject) VALUES (?, 'orcid', ?)",
      [id, identity],
    );
  }
  return id;
}

async function session(userId: number, name = "__Host-nemar_session"): Promise<string> {
  const { cookieIdRaw } = await issueSession(env(), userId, false, "test-agent", null, "orcid");
  return `${name}=${cookieIdRaw}`;
}

/** The ORCID callback, as the browser reaches it after ORCID, with the state cookie start set. */
function callback(
  mode: "login" | "link" | "relink",
  next: string,
  cookies: string[] = [],
): Promise<Response> {
  const state = `__Host-nemar_oauth_state=${encodeState({ csrf: CSRF, mode, next })}`;
  return app.request(
    `${APP}/auth/orcid/callback?state=${CSRF}&code=authcode`,
    { headers: { Cookie: [state, ...cookies].join("; ") } },
    env(),
  );
}

/** The session cookie the response set (under either name), as `name=value`, or null. */
function mintedSession(res: Response): string | null {
  for (const raw of res.headers.getSetCookie()) {
    const [pair] = raw.split(";");
    const eq = pair.indexOf("=");
    const name = pair.slice(0, eq);
    if ((name === "__Host-nemar_session" || name === "nemar_session") && eq < pair.length - 1) {
      return pair;
    }
  }
  return null;
}

async function accountOf(cookie: string): Promise<number | null> {
  const value = cookie.slice(cookie.indexOf("=") + 1);
  return (
    db
      .query<{ user_id: number }, [string]>(
        "SELECT user_id FROM web_sessions WHERE cookie_id_hash = ?",
      )
      .get(await hashCookieId(value))?.user_id ?? null
  );
}

function errorOf(res: Response): string | null {
  const location = res.headers.get("Location");
  return location ? new URL(location).searchParams.get("error") : null;
}

function identitiesOf(userId: number): string[] {
  return db
    .query<{ s: string }, [number]>(
      "SELECT provider_subject AS s FROM oauth_identities WHERE user_id = ? ORDER BY id",
    )
    .all(userId)
    .map((r) => r.s);
}

function orcidOf(userId: number): string | null {
  return (
    db
      .query<{ o: string | null }, [number]>("SELECT orcid AS o FROM users WHERE id = ?")
      .get(userId)?.o ?? null
  );
}

/** The start route, as the browser reaches it from Settings. */
function start(
  method: "GET" | "POST",
  mode: "link" | "relink",
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.request(
    `${APP}/auth/orcid/start?mode=${mode}&next=%2Fsettings`,
    { method, headers },
    env(),
  );
}

interface Armed {
  /** The state cookie as the browser sends it back, `name=value`. */
  cookie: string;
  state: NonNullable<ReturnType<typeof decodeState>>;
}

/** The state cookie a start response set, decoded, or null when it set none. */
function armedState(res: Response): Armed | null {
  for (const raw of res.headers.getSetCookie()) {
    const [pair] = raw.split(";");
    const eq = pair.indexOf("=");
    const name = pair.slice(0, eq);
    if (name !== "__Host-nemar_oauth_state" && name !== "nemar_oauth_state") continue;
    const state = decodeState(pair.slice(eq + 1));
    if (state) return { cookie: pair, state };
  }
  return null;
}

/** The callback, carrying the state cookie a real start response set. */
function callbackFrom(armed: Armed, cookies: string[] = []): Promise<Response> {
  return app.request(
    `${APP}/auth/orcid/callback?state=${encodeURIComponent(armed.state.csrf)}&code=authcode`,
    { headers: { Cookie: [armed.cookie, ...cookies].join("; ") } },
    env(),
  );
}

/** The session cookie name sessions are issued under for a flag value. */
function sessionNameFor(flagValue: string | undefined): string {
  return flagValue === "1" ? "__Host-nemar_session" : "nemar_session";
}

const FLAG_STATES = [
  { flagValue: "1", label: "on" },
  { flagValue: undefined, label: "off" },
] as const;

for (const { flagValue, label } of FLAG_STATES) {
  describe(`a plain sign-in ignores a session cookie already in the browser (flag ${label})`, () => {
    beforeEach(() => {
      flag = flagValue;
    });

    for (const name of ["nemar_session", "__Host-nemar_session"]) {
      test(`an unclaimed iD is not attached to the account a ${name} cookie names`, async () => {
        const cookieOwner = seedPerson();
        returnedOrcid = OTHER_ID;
        const res = await callback("login", "/dashboard", [await session(cookieOwner, name)]);
        expect(identitiesOf(cookieOwner)).toEqual([]);
        expect(orcidOf(cookieOwner)).toBeNull();
        // The iD belongs to nobody yet, so this is a new sign-up: the email step, and no session.
        expect(res.headers.get("Location")).toStartWith(`${APP}/auth/orcid/complete`);
        expect(mintedSession(res)).toBeNull();
      });

      test(`an iD that backs another account signs that account in, whatever a ${name} cookie names`, async () => {
        const cookieOwner = seedPerson();
        const holder = seedPerson(PERSON_ID);
        const res = await callback("login", "/dashboard", [await session(cookieOwner, name)]);
        expect(identitiesOf(cookieOwner)).toEqual([]);
        const fresh = mintedSession(res);
        expect(fresh).not.toBeNull();
        expect(await accountOf(fresh as string)).toBe(holder);
      });
    }

    test("signing in again with a live session for the same account mints a new session", async () => {
      // What the authorization endpoint waits for when it asks for a fresh sign-in.
      const person = seedPerson(PERSON_ID);
      const old = await session(person, sessionNameFor(flagValue));
      const res = await callback("login", "/oauth/authorize?client_id=x", [old]);
      expect(res.headers.get("Location")).toBe(`${APP}/oauth/authorize?client_id=x`);
      const fresh = mintedSession(res);
      expect(fresh).not.toBeNull();
      expect(fresh).not.toBe(old);
      expect(await accountOf(fresh as string)).toBe(person);
    });
  });

  describe(`only the POST start arms a link (flag ${label})`, () => {
    beforeEach(() => {
      flag = flagValue;
    });

    test("a GET with mode=link or mode=relink starts a plain sign-in, with or without a session", async () => {
      const person = seedPerson();
      const cookie = await session(person, sessionNameFor(flagValue));
      for (const mode of ["link", "relink"] as const) {
        for (const headers of [{}, { Cookie: cookie }]) {
          const res = await start("GET", mode, headers);
          expect(res.status).toBe(302);
          expect(res.headers.get("Location")).toContain("/oauth/authorize");
          expect(armedState(res)?.state.mode).toBe("login");
        }
      }
    });

    test("a POST with this site's Origin and a session arms the link", async () => {
      const person = seedPerson();
      const res = await start("POST", "link", {
        Origin: APP,
        Cookie: await session(person, sessionNameFor(flagValue)),
      });
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toContain("/oauth/authorize");
      expect(armedState(res)?.state.mode).toBe("link");
      expect(armedState(res)?.state.next).toBe("/settings");
    });

    test("a POST from another origin, or with no Origin, is refused and arms nothing", async () => {
      const person = seedPerson();
      const cookie = await session(person, sessionNameFor(flagValue));
      for (const origin of ["https://elsewhere.example", null]) {
        const headers: Record<string, string> = { Cookie: cookie };
        if (origin !== null) headers.Origin = origin;
        const res = await start("POST", "link", headers);
        expect(res.status).toBe(403);
        expect(armedState(res)).toBeNull();
      }
    });

    test("a POST with no session sends the person to sign in and arms nothing", async () => {
      const res = await start("POST", "link", { Origin: APP });
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toContain("/login?error=session_required");
      expect(armedState(res)).toBeNull();
    });
  });
}

describe("an explicit link attaches the iD to the session's account", () => {
  test("with a __Host- session, the iD is attached", async () => {
    const person = seedPerson();
    const res = await callback("link", "/settings", [await session(person)]);
    expect(errorOf(res)).toBeNull();
    expect(identitiesOf(person)).toEqual([PERSON_ID]);
    expect(orcidOf(person)).toBe(PERSON_ID);
  });

  test("with only a legacy-name session while the flag is on, nothing is attached", async () => {
    // The legacy name is one a sibling host can set, so it never decides whose account gains an iD
    // while sessions are issued under the __Host- name: the person signs in again first.
    const person = seedPerson();
    for (const mode of ["link", "relink"] as const) {
      const res = await callback(mode, "/settings", [await session(person, "nemar_session")]);
      expect(errorOf(res)).toBe("session_required");
      expect(new URL(res.headers.get("Location") as string).searchParams.get("next")).toBe(
        "/settings",
      );
      expect(identitiesOf(person)).toEqual([]);
      expect(orcidOf(person)).toBeNull();
      expect(mintedSession(res)).toBeNull();
    }
  });
});

describe("start to callback with the flag on", () => {
  test("a link the POST started attaches for a __Host- session and is refused for a legacy one", async () => {
    const person = seedPerson();
    const hostCookie = await session(person);
    const armed = armedState(await start("POST", "link", { Origin: APP, Cookie: hostCookie }));
    expect(armed?.state.mode).toBe("link");
    expect(errorOf(await callbackFrom(armed as Armed, [hostCookie]))).toBeNull();
    expect(identitiesOf(person)).toEqual([PERSON_ID]);

    const other = seedPerson();
    returnedOrcid = OTHER_ID;
    const legacy = await session(other, "nemar_session");
    const legacyArmed = armedState(await start("POST", "link", { Origin: APP, Cookie: legacy }));
    const res = await callbackFrom(legacyArmed as Armed, [legacy]);
    expect(errorOf(res)).toBe("session_required");
    expect(identitiesOf(other)).toEqual([]);
  });
});

describe("start to callback with the flag off", () => {
  beforeEach(() => {
    flag = undefined;
  });

  test("a link a GET tried to start signs in instead: the iD is not attached to the account a legacy session names", async () => {
    const cookieOwner = seedPerson();
    const cookie = await session(cookieOwner, "nemar_session");
    const armed = armedState(await start("GET", "link", { Cookie: cookie }));
    expect(armed?.state.mode).toBe("login");
    const res = await callbackFrom(armed as Armed, [cookie]);
    expect(identitiesOf(cookieOwner)).toEqual([]);
    expect(orcidOf(cookieOwner)).toBeNull();
    // The iD belongs to nobody yet, so this is a new sign-up, not a link.
    expect(res.headers.get("Location")).toStartWith(`${APP}/auth/orcid/complete`);
  });

  test("a link the POST started still attaches to the account a legacy session names: the residual the production flag closes", async () => {
    // ADR 0119 rule 10. With the flag off the legacy name is the only session name there is, so it
    // decides whose account gains the iD. A cross-site navigation can no longer arm the link, but
    // nothing at this layer tells the person's own legacy cookie from one another host set; turning
    // the production flag on is what closes that.
    const person = seedPerson();
    const cookie = await session(person, "nemar_session");
    const armed = armedState(await start("POST", "link", { Origin: APP, Cookie: cookie }));
    expect(armed?.state.mode).toBe("link");
    const res = await callbackFrom(armed as Armed, [cookie]);
    expect(errorOf(res)).toBeNull();
    expect(identitiesOf(person)).toEqual([PERSON_ID]);
    expect(orcidOf(person)).toBe(PERSON_ID);
  });
});
