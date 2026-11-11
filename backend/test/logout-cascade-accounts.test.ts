/**
 * Sign-out ends the host-scoped sessions of EVERY account whose app session it ends (epic #2014
 * phase #2015; ADR 0119 decision 10; ADR 0056 decision 5; ADR 0079).
 *
 * A request can carry more than one session cookie during the cookie-name window (a `__Host-`
 * one and a legacy one, or two legacy ones), and they can belong to different accounts. Sign-out
 * revokes the app session behind each of them, so it has to end the docs session, the private-site
 * session and every outstanding grant of each of those accounts too: revoking the app session
 * alone leaves the rest of that account's credentials live, the half-done state the rule that
 * revocation cascades to every linked credential exists to prevent.
 *
 * Real engine throughout: bun:sqlite behind `realD1` with every migration applied, the real
 * routes behind their real middleware, real sign-ins through the real grant routes and exchanges.
 * Names and cookie strings are literals.
 *
 * What each test below pins, and the mutation that proves it: each of the four statements the
 * route adds per account (`DOCS_REVOKE_ALL_SQL`, `DOCS_GRANTS_PURGE_SQL`, `PRIVATE_REVOKE_ALL_SQL`
 * and `PRIVATE_GRANTS_PURGE_SQL`) is asserted by the state it leaves, so removing any one of them
 * fails the two-account test.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { DOCS_SESSION_HEADER } from "../../shared/contract/docs-auth.js";
import { authDocsRoutes } from "../src/routes/auth-docs";
import { authPrivateRoutes } from "../src/routes/auth-private";
import { authWebRoutes } from "../src/routes/auth-web";
import { resolvePrincipal } from "../src/rpc/principal";
import { exchangePrivateGrant } from "../src/rpc/private-session";
import { DOCS_GRANTS_PURGE_SQL, DOCS_REVOKE_ALL_SQL } from "../src/services/docs-auth";
import { PRIVATE_GRANTS_PURGE_SQL, PRIVATE_REVOKE_ALL_SQL } from "../src/services/private-auth";
import { issueSession } from "../src/services/web-session";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const APP = "https://app.nemar.org";
const STATE = "LogoutCascadeBrowserState-0123456789_abcdefg";

type Scope = "docs" | "private";
const SCOPES: readonly Scope[] = ["docs", "private"];

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
/** Every statement the route bound, in order, when a test asks for the record. */
let recorded: Array<{ sql: string; binds: unknown[] }> = [];

function env(): Bindings {
  const base = realD1(db);
  return {
    DB: {
      ...base,
      prepare(sql: string) {
        const statement = base.prepare(sql);
        const bind = statement.bind.bind(statement);
        statement.bind = ((...binds: unknown[]) => {
          recorded.push({ sql, binds });
          return bind(...binds);
        }) as typeof statement.bind;
        return statement;
      },
    },
    ENVIRONMENT: "test",
    APP_BASE_URL: APP,
    WEB_SESSION_COOKIE_DOMAIN: "",
  } as unknown as Bindings;
}

interface Account {
  id: number;
  /** The app session cookie value. */
  app: string;
  docs: string;
  private: string;
}

async function seedAdmin(username: string): Promise<number> {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES (?, ?, 'x', 'approved', 'admin', 1)`,
    [username, `${username}@nemar.test`],
  );
  return (
    db.query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?").get(username) as {
      id: number;
    }
  ).id;
}

async function grant(scope: Scope, appCookie: string): Promise<string> {
  const res = await app.request(
    `/auth/${scope}/grant`,
    {
      method: "POST",
      headers: {
        Cookie: `nemar_session=${appCookie}`,
        Origin: APP,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(scope === "private" ? { state: STATE } : {}),
    },
    env(),
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { code: string }).code;
}

async function spend(scope: Scope, code: string): Promise<string | null> {
  if (scope === "private") {
    const r = await exchangePrivateGrant(env(), {
      code,
      state: STATE,
      userAgent: null,
      clientIp: null,
    });
    return r.ok ? r.session : null;
  }
  const res = await app.request(
    "/auth/docs/exchange",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    },
    env(),
  );
  return res.status === 200 ? ((await res.json()) as { session: string }).session : null;
}

async function works(scope: Scope, session: string): Promise<boolean> {
  if (scope === "private") {
    return (await resolvePrincipal(env(), { kind: "session", value: session })).ok;
  }
  const res = await app.request(
    "/auth/docs/verify",
    { headers: { [DOCS_SESSION_HEADER]: session } },
    env(),
  );
  return res.status === 200;
}

/** An account with an app session, a docs session and a private session, and one unspent grant of
 *  each scope: every credential sign-out could leave behind. */
async function signedInAccount(username: string): Promise<Account> {
  const id = await seedAdmin(username);
  const { cookieIdRaw } = await issueSession(env(), id, false, "ua", "127.0.0.1", "orcid");
  const sessions: Record<Scope, string> = { docs: "", private: "" };
  for (const scope of SCOPES) {
    const session = await spend(scope, await grant(scope, cookieIdRaw));
    if (!session) throw new Error(`could not sign ${username} in to ${scope}`);
    sessions[scope] = session;
    await grant(scope, cookieIdRaw); // a second code, left unspent
  }
  return { id, app: cookieIdRaw, docs: sessions.docs, private: sessions.private };
}

function grantRows(scope: Scope, userId: number): number {
  const table = scope === "private" ? "private_grants" : "docs_grants";
  return (
    db
      .query<{ n: number }, [number]>(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`)
      .get(userId)?.n ?? 0
  );
}

function appSessionLive(account: Account): boolean {
  return (
    (db
      .query<{ n: number }, [number]>(
        "SELECT COUNT(*) AS n FROM web_sessions WHERE user_id = ? AND scope = 'app' AND revoked_at IS NULL",
      )
      .get(account.id)?.n ?? 0) > 0
  );
}

function signOut(cookieHeader: string): Promise<Response> {
  return Promise.resolve(
    app.request(
      "/auth/logout",
      { method: "POST", headers: { Origin: APP, Cookie: cookieHeader } },
      env(),
    ),
  );
}

/** Everything that could still be live for an account: its app session, its sessions on the two
 *  other hosts, and the grants that can mint more of them. */
async function liveCredentials(account: Account): Promise<string[]> {
  const live: string[] = [];
  if (appSessionLive(account)) live.push("app session");
  if (await works("docs", account.docs)) live.push("docs session");
  if (await works("private", account.private)) live.push("private session");
  if (grantRows("docs", account.id) > 0) live.push("docs grant");
  if (grantRows("private", account.id) > 0) live.push("private grant");
  return live;
}

const ALL = ["app session", "docs session", "private session", "docs grant", "private grant"];

beforeEach(() => {
  db = freshDb();
  recorded = [];
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/auth", authWebRoutes);
  app.route("/auth", authDocsRoutes);
  app.route("/auth", authPrivateRoutes);
});

describe("a request that carries one account's session cookie", () => {
  test("ends that account's every credential, and touches no other account's", async () => {
    const a = await signedInAccount("cascadea");
    const bystander = await signedInAccount("cascadec");
    expect(await liveCredentials(a)).toEqual(ALL);

    expect((await signOut(`nemar_session=${a.app}`)).status).toBe(200);

    expect(await liveCredentials(a)).toEqual([]);
    expect(await liveCredentials(bystander)).toEqual(ALL);
  });

  test("the same holds under the new name", async () => {
    const a = await signedInAccount("cascadea");
    await signOut(`__Host-nemar_session=${a.app}`);
    expect(await liveCredentials(a)).toEqual([]);
  });
});

describe("a request that carries the session cookies of two accounts", () => {
  // Whichever cookie the reader prefers names the account the route used to follow, and the
  // other account's app session was revoked without its docs and private sessions.
  const ORDERS: Array<{ label: string; header: (a: Account, b: Account) => string }> = [
    {
      label: "two legacy cookies, B first and A second",
      header: (a, b) => `nemar_session=${b.app}; nemar_session=${a.app}`,
    },
    {
      label: "two legacy cookies, A first and B second",
      header: (a, b) => `nemar_session=${a.app}; nemar_session=${b.app}`,
    },
    {
      label: "A under the new name, B under the legacy one",
      header: (a, b) => `__Host-nemar_session=${a.app}; nemar_session=${b.app}`,
    },
    {
      label: "B under the legacy name, A under the new one",
      header: (a, b) => `nemar_session=${b.app}; __Host-nemar_session=${a.app}`,
    },
  ];

  for (const { label, header } of ORDERS) {
    test(`ends both accounts' every credential (${label})`, async () => {
      const a = await signedInAccount("cascadea");
      const b = await signedInAccount("cascadeb");
      const bystander = await signedInAccount("cascadec");

      expect((await signOut(header(a, b))).status).toBe(200);

      expect(await liveCredentials(a)).toEqual([]);
      expect(await liveCredentials(b)).toEqual([]);
      expect(await liveCredentials(bystander)).toEqual(ALL);
    });
  }

  test("runs each of the four statements once per distinct account, never twice for one", async () => {
    const a = await signedInAccount("cascadea");
    const b = await signedInAccount("cascadeb");
    // A second app session of A, so the request names A twice under two different cookies.
    const a2 = (await issueSession(env(), a.id, false, "ua", "127.0.0.1", "orcid")).cookieIdRaw;
    recorded = [];

    await signOut(`nemar_session=${b.app}; nemar_session=${a.app}; __Host-nemar_session=${a2}`);

    const byStatement = (sql: string) =>
      recorded.filter((r) => r.sql === sql).map((r) => r.binds[0]);
    for (const sql of [
      DOCS_REVOKE_ALL_SQL,
      DOCS_GRANTS_PURGE_SQL,
      PRIVATE_REVOKE_ALL_SQL,
      PRIVATE_GRANTS_PURGE_SQL,
    ]) {
      expect(byStatement(sql).sort(), sql).toEqual([a.id, b.id].sort());
    }
  });
});

describe("a request that carries a value that names no account", () => {
  test("the accounts behind the other cookies still lose every credential", async () => {
    const a = await signedInAccount("cascadea");
    const b = await signedInAccount("cascadeb");
    const header = `nemar_session=not-a-session-anyone-holds; nemar_session=${b.app}; __Host-nemar_session=${a.app}`;

    expect((await signOut(header)).status).toBe(200);

    expect(await liveCredentials(a)).toEqual([]);
    expect(await liveCredentials(b)).toEqual([]);
  });

  test("an unknown value alone ends nothing and still answers ok", async () => {
    const a = await signedInAccount("cascadea");
    expect((await signOut("nemar_session=not-a-session-anyone-holds")).status).toBe(200);
    expect(await liveCredentials(a)).toEqual(ALL);
  });
});

describe("a sign-out whose batch fails", () => {
  test("is still 200, and the log line names every account whose credentials were left live", async () => {
    const a = await signedInAccount("cascadea");
    const b = await signedInAccount("cascadeb");
    db.run("ALTER TABLE private_grants RENAME TO private_grants_broken");
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await signOut(`nemar_session=${b.app}; nemar_session=${a.app}`);
      expect(res.status).toBe(200);
      const lines = errors.mock.calls.map((args) => String(args[0]));
      const line = lines.find((l) => l.includes("/logout: revoke failed for"));
      expect(line).toBeDefined();
      expect(line).toContain(`users ${[b.id, a.id].join(", ")}`);
    } finally {
      errors.mockRestore();
      db.run("ALTER TABLE private_grants_broken RENAME TO private_grants");
    }
  });
});

describe("a request that carries no session cookie", () => {
  test("revokes nothing and answers ok", async () => {
    const a = await signedInAccount("cascadea");
    expect((await signOut("analytics=reject")).status).toBe(200);
    expect(await liveCredentials(a)).toEqual(ALL);
  });
});
