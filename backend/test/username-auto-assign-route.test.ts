/**
 * Username assignment at web sign-in (#1268, ADR 0045).
 *
 * ADR 0042 built the batch path: an admin sweep names the accounts whose
 * `username IS NULL`. It has not been run yet, and when it is it closes the
 * accounts that exist at that moment and nothing after them — a web sign-up
 * whose owner abandons onboarding lands right back in that state.
 * Phase 8 adds the lazy path at the three doors a web account comes through,
 * and this file drives all three for real:
 *
 *   POST /auth/code/verify     the emailed-code sign-in (assignment batched
 *                              into the sign-in's own transaction)
 *   POST /auth/orcid/finalize  the ORCID sign-up
 *   GET  /auth/orcid/callback  the ORCID sign-in of an already-linked account
 *
 * The two ORCID paths assign AFTER the response, chained behind the ORCID name
 * refresh they depend on, so those tests wait for the row rather than for the
 * response — a real wait on real async work, not a mock of it.
 *
 * Real engine throughout: bun:sqlite behind realD1 with every migration
 * applied, real Hono dispatch, real session issuance, the production
 * `hashAuthCode`, and local `Bun.serve()` instances standing in for ORCID's
 * token endpoint and public record API. No mocks.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Hono } from "hono";
import { authOrcidRoutes } from "../src/routes/auth-orcid";
import { authWebRoutes } from "../src/routes/auth-web";
import { hashAuthCode } from "../src/services/auth-code";
import { PENDING_COOKIE_NAME, encodeState, signPending } from "../src/services/orcid-auth";
import { USERNAME_SUFFIX_LIMIT } from "../src/services/username";
import {
  REREAD_USERNAME_SQL,
  TAKEN_SQL,
  usernameClaimStatement,
} from "../src/services/username-assignment";
import { issueSession } from "../src/services/web-session";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const ORIGIN = "https://nemar.org";
const APP = "https://app.nemar.org";
const ENCRYPTION_KEY = "username-assign-test-encryption-key-012345";
const CSRF = "csrf-username-assign";
/** `@nemar.test` is the synthetic-target suffix the non-production email fence
 *  admits, so nothing here can reach a real inbox (AGENTS.md). */
const EMAIL = "abandoned@nemar.test";
const SIGNUP_EMAIL = "brandnew@nemar.test";
const CALLBACK_ORCID = "0000-0001-5109-353X";
const PENDING_ORCID = "0000-0002-1825-0097";

/** The name ORCID's public record reports, reset per test. Ada Lovelace unless
 *  a test needs a name the ADR 0042 suggestion cannot be built from. */
let publicRecordName = { given: "Ada", family: "Lovelace" };

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
        return Response.json({ orcid: CALLBACK_ORCID, name: "Ada Lovelace", access_token: "x" });
      }
      return new Response("not found", { status: 404 });
    },
  });
  // ORCID's PUBLIC record API, which `refreshUserName` reads and whose host is
  // derived from a fixed map rather than from ORCID_API_BASE -- so it is
  // redirected by moving fetch's destination, not by an env knob. What it
  // serves is `publicRecordName`, so a test can put a real record in front of
  // the real parser instead of describing one.
  orcidPub = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json({
        name: {
          "given-names": { value: publicRecordName.given },
          "family-name": { value: publicRecordName.family },
        },
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

/**
 * When set, the username scan is diverted to SQL the database refuses.
 *
 * The sibling of `blockUserWrites()` in web-email-verification.test.ts, which
 * makes every `UPDATE users` fail with a real SQLite trigger. A trigger cannot
 * fire on a SELECT, so the equivalent fault for a READ is to point that one
 * statement -- matched by the production constant, never a copy of it -- at a
 * column that does not exist. SQLite itself raises the error, at prepare time,
 * exactly where a transient D1 failure would surface; every other statement in
 * the request still runs against the real database.
 */
let breakUsernameScan = false;

/**
 * When set, the lost-claim re-read (`REREAD_USERNAME_SQL`) is diverted the
 * same way `breakUsernameScan` diverts `TAKEN_SQL` above: pointed at a column
 * that does not exist, so SQLite raises at prepare time instead of the
 * database quietly returning the row. Proves the re-read's own catch falls
 * back to the pre-race values rather than reaching the route's outer catch.
 */
let breakUsernameReread = false;

function env(): Bindings {
  const base = realD1(db);
  return {
    DB: {
      ...base,
      prepare(sql: string) {
        if (breakUsernameScan && sql === TAKEN_SQL) {
          return base.prepare("SELECT no_such_column FROM users");
        }
        if (breakUsernameReread && sql === REREAD_USERNAME_SQL) {
          return base.prepare("SELECT no_such_column FROM users");
        }
        return base.prepare(sql);
      },
    },
    ENVIRONMENT: "test",
    ENCRYPTION_KEY,
    WEB_SESSION_COOKIE_DOMAIN: "",
    ORCID_CLIENT_ID: "APP-TEST",
    ORCID_CLIENT_SECRET: "test-secret",
    ORCID_API_BASE: `http://localhost:${orcidToken.port}`,
    APP_BASE_URL: APP,
  } as unknown as Bindings;
}

/** A web/ORCID-shaped row: `username IS NULL`, which is the state this whole
 *  feature is about. `given`/`family` are what decide whether it can be fixed. */
function seedWebUser(
  email: string,
  { given = "Ada", family = "Lovelace", orcid = null as string | null } = {},
): number {
  db.run(
    `INSERT INTO users (email, status, signup_source, email_verified, given_name, family_name,
                        orcid, orcid_verified, service_access)
     VALUES (?, 'pending', 'web', 0, ?, ?, ?, ?, 0)`,
    [email, given, family, orcid, orcid ? 1 : 0],
  );
  const row = db.query<{ id: number }, [string]>("SELECT id FROM users WHERE email = ?").get(email);
  if (!row) throw new Error(`seed failed for ${email}`);
  return row.id;
}

/** An unrelated account already holding a username, to force a collision. */
function seedTakenUsername(username: string): void {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES (?, ?, 'x', 'approved', 'member', 1)`,
    [username, `${username}@nemar.test`],
  );
}

async function plantCode(email: string, code: string): Promise<void> {
  db.run(
    `INSERT INTO auth_codes (email, code_hash, expires_at, user_id)
     VALUES (?, ?, datetime('now', '+10 minutes'), NULL)`,
    [email, await hashAuthCode(code, env())],
  );
}

function codeVerify(email: string, code: string): Promise<Response> {
  return app.request(
    "/auth/code/verify",
    {
      method: "POST",
      headers: { Origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ email, code, remember: false }),
    },
    env(),
  );
}

function usernameOf(id: number): { username: string | null; auto: number } {
  const row = db
    .query<{ username: string | null; username_auto_assigned: number }, [number]>(
      "SELECT username, username_auto_assigned FROM users WHERE id = ?",
    )
    .get(id);
  if (!row) throw new Error(`no user ${id}`);
  return { username: row.username, auto: row.username_auto_assigned };
}

function auditRows(id: number): { action: string; details: string | null }[] {
  return db
    .query<{ action: string; details: string | null }, [number]>(
      "SELECT action, details FROM audit_log WHERE user_id = ? AND action = 'username_auto_assigned'",
    )
    .all(id);
}

/**
 * Wait for an after-response assignment to land.
 *
 * The two ORCID paths run the name refresh and the assignment behind the
 * response (`afterResponse`), so the row is written a few microtasks later.
 * This polls the real database rather than sleeping a fixed interval, and gives
 * up loudly instead of hanging.
 */
async function waitForUsername(id: number, attempts = 200): Promise<string | null> {
  for (let i = 0; i < attempts; i++) {
    const { username } = usernameOf(id);
    if (username) return username;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return null;
}

/** The same wait for the name the ORCID public record supplies, which
 *  `refreshUserName` writes immediately BEFORE the assignment is attempted —
 *  so it is the signal that the chain reached the assignment at all. */
async function waitForGivenName(id: number, attempts = 200): Promise<string | null> {
  for (let i = 0; i < attempts; i++) {
    const row = db
      .query<{ given_name: string | null }, [number]>("SELECT given_name FROM users WHERE id = ?")
      .get(id);
    if (row?.given_name) return row.given_name;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return null;
}

/** Everything the route logged during one test. Captured rather than muted so
 *  a test can assert that an operator would actually see the fact. */
let logs: string[];
const realWarn = console.warn;
const realError = console.error;

beforeEach(() => {
  db = freshDb();
  breakUsernameScan = false;
  breakUsernameReread = false;
  publicRecordName = { given: "Ada", family: "Lovelace" };
  logs = [];
  console.warn = (...a: unknown[]) => {
    logs.push(a.join(" "));
  };
  console.error = (...a: unknown[]) => {
    logs.push(a.join(" "));
  };
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/auth", authWebRoutes);
  app.route("/auth", authOrcidRoutes);
});

afterEach(() => {
  console.warn = realWarn;
  console.error = realError;
});

describe("POST /auth/code/verify", () => {
  test("names an abandoned account from its name, in the sign-in itself", async () => {
    const id = seedWebUser(EMAIL);
    await plantCode(EMAIL, "123456");

    const res = await codeVerify(EMAIL, "123456");
    expect(res.status).toBe(200);

    // Written by the time the response is built -- not after it.
    expect(usernameOf(id)).toEqual({ username: "alovelace", auto: 1 });
    // ...and REPORTED, so the dashboard does not have to re-fetch to learn it.
    const body = await res.json();
    expect(body.user.username).toBe("alovelace");
    expect(body.user.username_auto_assigned).toBe(true);
  });

  test("suffixes past a collision rather than failing the sign-in", async () => {
    seedTakenUsername("alovelace");
    const id = seedWebUser(EMAIL);
    await plantCode(EMAIL, "123456");

    const res = await codeVerify(EMAIL, "123456");
    expect(res.status).toBe(200);
    expect(usernameOf(id).username).toBe("alovelace-2");
  });

  test("no family name leaves the column NULL, and signs the user in anyway", async () => {
    // ADR 0042: nothing is invented from the email local part. Onboarding asks.
    const id = seedWebUser(EMAIL, { given: "Prince", family: null as unknown as string });
    await plantCode(EMAIL, "123456");

    const res = await codeVerify(EMAIL, "123456");
    expect(res.status).toBe(200);
    expect(usernameOf(id)).toEqual({ username: null, auto: 0 });
    expect((await res.json()).user.username).toBeNull();
    expect(auditRows(id)).toHaveLength(0);
  });

  test("a name that folds to nothing in ASCII is the same answer", async () => {
    const id = seedWebUser(EMAIL, { given: "美子", family: "山田" });
    await plantCode(EMAIL, "123456");
    expect((await codeVerify(EMAIL, "123456")).status).toBe(200);
    expect(usernameOf(id).username).toBeNull();
  });

  test("an account that already has a username keeps it, and is not re-marked", async () => {
    const id = seedWebUser(EMAIL);
    db.run("UPDATE users SET username = 'chosen' WHERE id = ?", [id]);
    await plantCode(EMAIL, "123456");

    expect((await codeVerify(EMAIL, "123456")).status).toBe(200);
    expect(usernameOf(id)).toEqual({ username: "chosen", auto: 0 });
    expect(auditRows(id)).toHaveLength(0);
  });

  test("a saturated base leaves the column NULL and says so in the log", async () => {
    // The other end of the suffix search: every variant up to the limit is
    // taken, so there is nothing to claim. The account still signs in, still
    // holds no handle, and -- because nothing else would ever surface it -- an
    // operator gets one line naming the saturated base.
    seedTakenUsername("alovelace");
    for (let n = 2; n <= USERNAME_SUFFIX_LIMIT; n++) seedTakenUsername(`alovelace-${n}`);
    const id = seedWebUser(EMAIL);
    await plantCode(EMAIL, "123456");

    const res = await codeVerify(EMAIL, "123456");

    expect(res.status).toBe(200);
    expect(usernameOf(id)).toEqual({ username: null, auto: 0 });
    expect(auditRows(id)).toHaveLength(0);
    expect((await res.json()).user.username).toBeNull();
    expect(logs.join("\n")).toContain(`every variant of "alovelace" is taken; user ${id}`);
  });

  test("a handle taken between the scan and the write is not stolen", async () => {
    // The claim's OTHER guard: `NOT EXISTS`, which is evaluated with the write
    // rather than before it. Staged the same way as the race above -- a trigger
    // on the session INSERT, the statement immediately before the claim in the
    // same batch -- except here the competing row is a DIFFERENT account taking
    // the exact handle this sign-in planned to use.
    const id = seedWebUser(EMAIL);
    db.run(
      `CREATE TRIGGER steal_the_handle AFTER INSERT ON web_sessions
       BEGIN
         INSERT INTO users (username, email, password_hash, status)
         VALUES ('alovelace', 'thief@nemar.test', 'x', 'approved');
       END`,
    );
    await plantCode(EMAIL, "123456");

    const res = await codeVerify(EMAIL, "123456");

    // No exception, no rollback: the sign-in landed whole, minus the username.
    expect(res.status).toBe(200);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM web_sessions").get()?.n).toBe(1);
    expect(usernameOf(id)).toEqual({ username: null, auto: 0 });
    expect(auditRows(id)).toHaveLength(0);
    // ...and the handle belongs to whoever got there first.
    expect(
      db
        .query<{ email: string }, [string]>("SELECT email FROM users WHERE username = ?")
        .get("alovelace")?.email,
    ).toBe("thief@nemar.test");
  });

  test("the claim reports a lost race rather than raising", async () => {
    // The statement's own contract, asserted directly because it is what makes
    // batching it inside a sign-in transaction safe: `CLAIM_USERNAME_SQL` is
    // ONE statement whose NOT EXISTS arm runs with the write, so a name taken
    // in between produces `changes = 0` and NOT a UNIQUE error that would roll
    // the whole sign-in back. The route test above proves the behaviour; this
    // proves the mechanism it rests on.
    const id = seedWebUser(EMAIL);
    seedTakenUsername("alovelace");

    const claim = await usernameClaimStatement(realD1(db), id, "alovelace").run();

    expect(claim.meta?.changes ?? 0).toBe(0);
    expect(usernameOf(id)).toEqual({ username: null, auto: 0 });
  });

  test("signing in twice assigns once", async () => {
    // Two real sign-ins, not one call and an assumption. The second must find
    // the username already set and do nothing at all: a second audit row would
    // tell an operator the handle was re-derived, and a second claim on an
    // account whose owner had since renamed it would undo their choice.
    const id = seedWebUser(EMAIL);
    await plantCode(EMAIL, "123456");
    expect((await codeVerify(EMAIL, "123456")).status).toBe(200);
    expect(usernameOf(id)).toEqual({ username: "alovelace", auto: 1 });

    await plantCode(EMAIL, "654321");
    const second = await codeVerify(EMAIL, "654321");

    expect(second.status).toBe(200);
    expect(usernameOf(id)).toEqual({ username: "alovelace", auto: 1 });
    expect(auditRows(id)).toHaveLength(1);
    expect((await second.json()).user.username).toBe("alovelace");
  });

  test("a failed username scan does not burn the code or the sign-in", async () => {
    // The scan runs AFTER the code has been consumed and BEFORE the batch whose
    // catch restores it, so an escaping error would answer a generic 500 and
    // spend a code the user typed correctly. The feature is a nudge; it may
    // never cost anybody a login.
    const id = seedWebUser(EMAIL);
    await plantCode(EMAIL, "123456");
    breakUsernameScan = true;

    const res = await codeVerify(EMAIL, "123456");

    expect(res.status).toBe(200);
    // A real session: the cookie is set and the row exists.
    expect(res.headers.getSetCookie().some((ck) => ck.startsWith("nemar_session="))).toBe(true);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM web_sessions").get()?.n).toBe(1);
    // ...and the sign-in did everything else it does, including promoting the
    // account off `pending` (the wire spells that "active"; the column is the
    // fact).
    expect((await res.json()).user.status).toBe("active");
    expect(
      db.query<{ status: string }, [number]>("SELECT status FROM users WHERE id = ?").get(id)
        ?.status,
    ).toBe("verified");

    // Nothing was assigned, nothing was claimed to have been.
    expect(usernameOf(id)).toEqual({ username: null, auto: 0 });
    expect(auditRows(id)).toHaveLength(0);
    // But an operator can see it happened, with the account it happened to.
    expect(logs.join("\n")).toContain(`could not pick a username for user id=${id}`);
  });

  test("a username set mid-sign-in is reported, not the NULL we read first", async () => {
    // The race: a `PATCH /auth/profile` names the account between this
    // request's SELECT and its claim. Staged with SQLite's own trigger
    // machinery rather than described -- the session INSERT is the statement
    // immediately before the claim in the same batch, so a trigger on it lands
    // the competing write in exactly the window the claim's `username IS NULL`
    // predicate guards. The claim then reports `changes = 0` (nothing is
    // stolen), and the row the response was built from is one revision stale.
    const id = seedWebUser(EMAIL);
    db.run(
      `CREATE TRIGGER name_the_row_mid_signin AFTER INSERT ON web_sessions
       BEGIN UPDATE users SET username = 'typed' WHERE id = NEW.user_id; END`,
    );
    await plantCode(EMAIL, "123456");

    const res = await codeVerify(EMAIL, "123456");
    expect(res.status).toBe(200);

    // The claim lost, so nothing was assigned and nothing was audited...
    expect(usernameOf(id)).toEqual({ username: "typed", auto: 0 });
    expect(auditRows(id)).toHaveLength(0);
    // ...and the response says what the account HAS, not what it had.
    const body = await res.json();
    expect(body.user.username).toBe("typed");
    expect(body.user.username_auto_assigned).toBe(false);
  });

  test("a failed lost-claim re-read still signs in with the pre-race row", async () => {
    // Same race as the test above, but the re-read that is meant to recover
    // from it is itself broken. The fallback has to hold: the sign-in already
    // committed by the time this runs, so a broken re-read may not fail the
    // login over a value that is a nudge's nudge -- it falls back to the
    // pre-race `userRow` the request already read at the top.
    const id = seedWebUser(EMAIL);
    db.run(
      `CREATE TRIGGER name_the_row_mid_signin_reread AFTER INSERT ON web_sessions
       BEGIN UPDATE users SET username = 'typed' WHERE id = NEW.user_id; END`,
    );
    await plantCode(EMAIL, "123456");
    breakUsernameReread = true;

    const res = await codeVerify(EMAIL, "123456");

    // Still a real session: a broken re-read must not cost anybody a login.
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().some((ck) => ck.startsWith("nemar_session="))).toBe(true);

    // The row already changed underneath this request...
    expect(usernameOf(id)).toEqual({ username: "typed", auto: 0 });
    // ...but the re-read that would have discovered that failed, so the
    // response reports the row exactly as it was read at the top: no handle.
    const body = await res.json();
    expect(body.user.username).toBeNull();
    expect(body.user.username_auto_assigned).toBe(false);
    // An operator can still see it happened, with the account it happened to.
    expect(logs.join("\n")).toContain(
      `could not re-read the username of user id=${id} after a lost claim`,
    );
  });

  test("the assignment is audited, with the door it came through", async () => {
    const id = seedWebUser(EMAIL);
    await plantCode(EMAIL, "123456");
    await codeVerify(EMAIL, "123456");

    const rows = auditRows(id);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].details ?? "{}")).toEqual({
      username: "alovelace",
      source: "code_signin",
    });
  });
});

describe("POST /auth/orcid/finalize", () => {
  async function finalize(): Promise<Response> {
    const pending = await signPending(
      { orcid: PENDING_ORCID, name: "Ada Lovelace", exp: Date.now() + 60_000 },
      ENCRYPTION_KEY,
    );
    return app.request(
      "https://app.nemar.org/auth/orcid/finalize",
      {
        method: "POST",
        headers: {
          Origin: ORIGIN,
          Cookie: `${PENDING_COOKIE_NAME}=${pending}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ email: SIGNUP_EMAIL, city: "Cambridge", country: "GB" }),
      },
      env(),
    );
  }

  test("a brand-new sign-up gets its name from ORCID and then a username", async () => {
    // The INSERT writes no name at all: both come from the public record, which
    // is why the assignment is chained BEHIND the refresh rather than beside it.
    const res = await finalize();
    expect(res.status).toBe(200);
    const id = (await res.json()).user.id as number;

    expect(await waitForUsername(id)).toBe("alovelace");
    expect(usernameOf(id).auto).toBe(1);
    expect(JSON.parse(auditRows(id)[0]?.details ?? "{}")).toEqual({
      username: "alovelace",
      source: "orcid_signup",
    });
  });

  test("a collision is suffixed here too", async () => {
    seedTakenUsername("alovelace");
    const res = await finalize();
    const id = (await res.json()).user.id as number;
    expect(await waitForUsername(id)).toBe("alovelace-2");
  });
});

describe("GET /auth/orcid/callback (sign-in)", () => {
  function callback(): Request {
    return new Request(`${APP}/auth/orcid/callback?state=${CSRF}&code=fake-code`, {
      method: "GET",
      headers: {
        Cookie: `__Host-nemar_oauth_state=${encodeState({ csrf: CSRF, mode: "login", next: "/dashboard" })}`,
      },
    });
  }

  test("an already-linked account with no username gets one at sign-in", async () => {
    // Deliberately seeded with NO name: the ORCID record supplies it on the way
    // through, which is the case a sweep-only design never reaches.
    const id = seedWebUser(EMAIL, {
      given: null as unknown as string,
      family: null as unknown as string,
      orcid: CALLBACK_ORCID,
    });
    db.run(
      "INSERT INTO oauth_identities (user_id, provider, provider_subject, display_name) VALUES (?, 'orcid', ?, 'Ada')",
      [id, CALLBACK_ORCID],
    );

    const res = await app.request(callback(), undefined, env());
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`${APP}/dashboard`);

    expect(await waitForUsername(id)).toBe("alovelace");
    expect(JSON.parse(auditRows(id)[0]?.details ?? "{}")).toEqual({
      username: "alovelace",
      source: "orcid_signin",
    });
  });

  test("a collision is suffixed on this door too", async () => {
    // Each door runs the scan itself; a suffix rule proved on one of them is
    // not proved on the others.
    seedTakenUsername("alovelace");
    const id = seedWebUser(EMAIL, {
      given: null as unknown as string,
      family: null as unknown as string,
      orcid: CALLBACK_ORCID,
    });
    db.run(
      "INSERT INTO oauth_identities (user_id, provider, provider_subject, display_name) VALUES (?, 'orcid', ?, 'Ada')",
      [id, CALLBACK_ORCID],
    );

    expect((await app.request(callback(), undefined, env())).status).toBe(302);
    expect(await waitForUsername(id)).toBe("alovelace-2");
  });

  test("a public-record name with no ASCII to fold to leaves the column NULL", async () => {
    // The no-usable-name case on the door where the name arrives LAST: the
    // record is read, written to the row, and only then is a handle attempted.
    // Nothing is invented from the email local part (ADR 0042), so onboarding
    // asks instead.
    publicRecordName = { given: "美子", family: "山田" };
    const id = seedWebUser(EMAIL, {
      given: null as unknown as string,
      family: null as unknown as string,
      orcid: CALLBACK_ORCID,
    });
    db.run(
      "INSERT INTO oauth_identities (user_id, provider, provider_subject, display_name) VALUES (?, 'orcid', ?, 'Ada')",
      [id, CALLBACK_ORCID],
    );

    expect((await app.request(callback(), undefined, env())).status).toBe(302);

    // The name landing is the proof the after-response chain actually ran --
    // `refreshUserName` writes it, and the assignment is the statement directly
    // after it. Only then is "no username" an answer rather than a not-yet.
    expect(await waitForGivenName(id)).toBe("美子");
    expect(await waitForUsername(id, 40)).toBeNull();
    expect(usernameOf(id)).toEqual({ username: null, auto: 0 });
    expect(auditRows(id)).toHaveLength(0);
  });
});

describe("PATCH /auth/profile clears the mark", () => {
  async function patch(id: number, body: unknown): Promise<Response> {
    const { cookieIdRaw } = await issueSession(env(), id, false, null, null, "orcid");
    return app.request(
      "/auth/profile",
      {
        method: "PATCH",
        headers: {
          Origin: ORIGIN,
          Cookie: `nemar_session=${cookieIdRaw}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
      env(),
    );
  }

  test("changing an auto-assigned username retires the offer", async () => {
    const id = seedWebUser(EMAIL);
    await plantCode(EMAIL, "123456");
    await codeVerify(EMAIL, "123456");
    expect(usernameOf(id).auto).toBe(1);

    const res = await patch(id, { username: "ada" });
    expect(res.status).toBe(200);
    expect(usernameOf(id)).toEqual({ username: "ada", auto: 0 });
    expect((await res.json()).user.username_auto_assigned).toBe(false);
  });

  test("re-saving the SAME username is not a change and keeps the offer", async () => {
    // The Settings form sends every field on every save; a routine save of the
    // city must not silently retire an offer the user has not answered.
    const id = seedWebUser(EMAIL);
    await plantCode(EMAIL, "123456");
    await codeVerify(EMAIL, "123456");

    const res = await patch(id, { username: "alovelace", city: "London" });
    expect(res.status).toBe(200);
    expect(usernameOf(id)).toEqual({ username: "alovelace", auto: 1 });
  });
});
