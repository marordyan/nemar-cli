/**
 * Migration 0122_oidc_grants_and_codes.sql and the authorization endpoint's own statements (epic #2014
 * phase #2017; ADR 0119), on two engines: bun:sqlite, which every other suite uses, and Miniflare's
 * D1, the implementation `wrangler --local` runs. bun:sqlite is more permissive than the SQLite D1
 * ships, and two constructs here are newer than most of this schema (an upsert against a PARTIAL
 * unique index, and an aggregate with its own ORDER BY), so each is run on both.
 *
 * Pinned:
 *   - what the tables refuse with the services out of the way: the scope arrays, the closed
 *     `consent_kind`, one LIVE grant per account and client, the code's hash and challenge formats,
 *     the nonce bound, and a code that would outlive sixty seconds;
 *   - `GRANT_UPSERT_SQL`: a first grant, a person's consent widening their own grant, a person's
 *     consent replacing a first-party grant, and a first-party authorization marking what it widens;
 *   - `CODE_INSERT_SQL`, run DIRECTLY, gate by gate. Through the routes most of these gates are
 *     shadowed by an earlier check (the session middleware, the client read, the rule), so removing
 *     one would leave every route test green; this is where each is proved on its own, the way
 *     `private-grant-route.test.ts` proves `PRIVATE_GRANT_INSERT_SQL`'s;
 *   - `CODES_PRUNE_SQL`.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { CODES_PRUNE_SQL, CODE_INSERT_SQL, GRANT_UPSERT_SQL } from "../src/services/oidc-authorize";
import { freshDb } from "./helpers/d1";
import { applyMigrations, migrationFiles } from "./helpers/miniflare-d1";

interface Engine {
  name: string;
  /** Run one statement: the engine's error text, or the rows it changed. */
  run(sql: string, ...binds: unknown[]): Promise<{ error: string | null; changes: number }>;
  all<T>(sql: string, ...binds: unknown[]): Promise<T[]>;
}

const engines: Engine[] = [];
let mf: Miniflare;
let sqlite: Database;

beforeAll(async () => {
  sqlite = freshDb();
  engines.push({
    name: "bun:sqlite",
    async run(sql, ...binds) {
      try {
        const r = sqlite.prepare(sql).run(...(binds as never[]));
        return { error: null, changes: r.changes };
      } catch (err) {
        return { error: String(err), changes: 0 };
      }
    },
    async all<T>(sql: string, ...binds: unknown[]) {
      return sqlite.prepare(sql).all(...(binds as never[])) as T[];
    },
  });

  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response(null, { status: 204 }); } };",
    compatibilityDate: "2024-12-01",
    d1Databases: ["DB"],
  });
  const d1 = await mf.getD1Database("DB");
  await applyMigrations(d1, migrationFiles());
  engines.push({
    name: "Miniflare D1",
    async run(sql, ...binds) {
      try {
        const r = await d1
          .prepare(sql)
          .bind(...binds)
          .run();
        return { error: null, changes: r.meta.changes ?? 0 };
      } catch (err) {
        return { error: String(err), changes: 0 };
      }
    },
    async all<T>(sql: string, ...binds: unknown[]) {
      return (
        await d1
          .prepare(sql)
          .bind(...binds)
          .all<T>()
      ).results;
    },
  });
}, 180_000);

afterAll(async () => {
  await mf?.dispose();
});

function onEveryEngine(name: string, body: (e: Engine) => Promise<void>) {
  test(name, async () => {
    expect(engines.length).toBe(2);
    for (const e of engines) {
      try {
        await body(e);
      } catch (err) {
        throw new Error(`on ${e.name}: ${err instanceof Error ? err.message : err}`);
      }
    }
  });
}

async function ok(e: Engine, sql: string, ...binds: unknown[]): Promise<number> {
  const r = await e.run(sql, ...binds);
  if (r.error) throw new Error(r.error);
  return r.changes;
}

async function one<T>(e: Engine, sql: string, ...binds: unknown[]): Promise<T> {
  const rows = await e.all<T>(sql, ...binds);
  if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`);
  return rows[0];
}

const HASH = (n: number) => n.toString(16).padStart(64, "0");
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const REDIRECT = "https://client.example.org/callback";
const ORCID = "0000-0002-1825-0097";

let counter = 0;

interface World {
  userId: number;
  sessionId: number;
  clientRow: number;
  clientId: string;
}

/**
 * One account with a live app session, and one active client, with what a test overrides. The
 * account has a proven ORCID iD unless told otherwise.
 */
async function world(
  e: Engine,
  over: {
    status?: string;
    kind?: string;
    proven?: boolean;
    rule?: string;
    allowed?: string[];
    clientStatus?: "active" | "disabled";
  } = {},
): Promise<World> {
  counter += 1;
  const name = `oidcmig${counter}`;
  await ok(
    e,
    `INSERT INTO users (username, email, password_hash, status, role, email_verified, account_kind,
                        orcid, orcid_verified)
     VALUES (?, ?, 'x', ?, 'member', 1, ?, ?, 1)`,
    name,
    `${name}@example.org`,
    over.status ?? "verified",
    over.kind ?? "person",
    // A distinct iD per account: an iD backs one account (ADR 0043).
    `${ORCID.slice(0, 15)}${String(counter).padStart(4, "0")}`,
  );
  const user = await one<{ id: number; orcid: string }>(
    e,
    "SELECT id, orcid FROM users WHERE username = ?",
    name,
  );
  if (over.proven !== false) {
    await ok(
      e,
      "INSERT INTO oauth_identities (user_id, provider, provider_subject) VALUES (?, 'orcid', ?)",
      user.id,
      user.orcid,
    );
  }
  await ok(
    e,
    `INSERT INTO web_sessions (user_id, cookie_id_hash, expires_at, scope)
     VALUES (?, ?, datetime('now', '+1 hour'), 'app')`,
    user.id,
    `mig-session-${counter}`,
  );
  const session = await one<{ id: number }>(
    e,
    "SELECT id FROM web_sessions WHERE cookie_id_hash = ?",
    `mig-session-${counter}`,
  );
  const clientId = `oc_${counter.toString(16).padStart(24, "a")}`;
  const disabled = over.clientStatus === "disabled";
  await ok(
    e,
    `INSERT INTO oidc_clients (client_id, name, secret_hash, redirect_uris, allowed_scopes,
       allowed_grants, sign_in_rule, first_party, consent_mode, audience, status, disabled_at,
       created_by)
     VALUES (?, ?, ?, ?, ?, '["authorization_code"]', ?, 0, 'ask_once', 'https://api.example.org',
             ?, ${disabled ? "datetime('now')" : "NULL"}, 1)`,
    clientId,
    `Migration client ${counter}`,
    HASH(counter),
    JSON.stringify([REDIRECT]),
    JSON.stringify(over.allowed ?? ["openid", "profile", "email"]),
    over.rule ?? "person_proven_orcid",
    disabled ? "disabled" : "active",
  );
  const client = await one<{ id: number }>(
    e,
    "SELECT id FROM oidc_clients WHERE client_id = ?",
    clientId,
  );
  return { userId: user.id, sessionId: session.id, clientRow: client.id, clientId };
}

/** A second account, with a proven iD and a live session, on the client of `w`. */
async function anotherAccount(e: Engine, w: World): Promise<World> {
  const other = await world(e);
  return { ...other, clientRow: w.clientRow, clientId: w.clientId };
}

/** Run the real grant upsert. Binds as the service does. */
function upsertGrant(e: Engine, w: World, scopes: string[], kind: "user" | "first_party") {
  return e.run(GRANT_UPSERT_SQL, JSON.stringify(scopes), kind, w.clientId, w.sessionId);
}

/** Run the real code insert. Binds as the service does. */
function mintCode(
  e: Engine,
  w: World,
  over: { scopes?: string[]; redirect?: string; hash?: string; nonce?: string | null } = {},
) {
  const scopes = JSON.stringify(over.scopes ?? ["openid", "profile"]);
  const redirect = over.redirect ?? REDIRECT;
  counter += 1;
  return e.run(
    CODE_INSERT_SQL,
    over.hash ?? HASH(1_000_000 + counter),
    redirect,
    scopes,
    over.nonce === undefined ? "n" : over.nonce,
    CHALLENGE,
    60,
    w.clientId,
    w.sessionId,
    scopes,
    redirect,
  );
}

async function grantOf(e: Engine, w: World) {
  return e.all<{ scopes: string; consent_kind: string }>(
    "SELECT scopes, consent_kind FROM oidc_grants WHERE user_id = ? AND revoked_at IS NULL",
    w.userId,
  );
}

// ---------------------------------------------------------------------------------------------
// The tables
// ---------------------------------------------------------------------------------------------

describe("oidc_grants", () => {
  onEveryEngine("refuses a malformed scope array and an unknown consent kind", async (e) => {
    const insert = (scopes: string, kind: string) =>
      e.run(
        "INSERT INTO oidc_grants (user_id, client_id, scopes, consent_kind) VALUES (?, ?, ?, ?)",
        900_000 + counter++,
        1,
        scopes,
        kind,
      );
    expect((await insert('["openid"]', "user")).error).toBeNull();
    for (const bad of ["[]", "not json", '{"a":1}', '["OpenID"]', '["openid;drop"]']) {
      expect((await insert(bad, "user")).error).toContain("CHECK");
    }
    expect((await insert('["openid"]', "admin")).error).toContain("CHECK");
  });

  onEveryEngine(
    "holds one live grant per account and client, and any number revoked",
    async (e) => {
      const user = 800_000 + counter++;
      const insert = () =>
        e.run(
          "INSERT INTO oidc_grants (user_id, client_id, scopes, consent_kind) VALUES (?, 7, '[\"openid\"]', 'user')",
          user,
        );
      expect((await insert()).error).toBeNull();
      expect((await insert()).error).toContain("UNIQUE");
      await ok(e, "UPDATE oidc_grants SET revoked_at = datetime('now') WHERE user_id = ?", user);
      expect((await insert()).error).toBeNull();
      await ok(
        e,
        "UPDATE oidc_grants SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL",
        user,
      );
      expect((await insert()).error).toBeNull();
    },
  );
});

describe("oidc_codes", () => {
  function insertCode(e: Engine, over: Record<string, string> = {}) {
    counter += 1;
    const cols: Record<string, string> = {
      code_hash: `'${HASH(2_000_000 + counter)}'`,
      client_id: "1",
      user_id: "1",
      grant_id: "1",
      redirect_uri: `'${REDIRECT}'`,
      scopes: `'["openid"]'`,
      nonce: "NULL",
      code_challenge: `'${CHALLENGE}'`,
      auth_time: "datetime('now')",
      expires_at: "datetime('now', '+60 seconds')",
      ...over,
    };
    return e.run(
      `INSERT INTO oidc_codes (${Object.keys(cols).join(", ")}) VALUES (${Object.values(cols).join(", ")})`,
    );
  }

  onEveryEngine("accepts a well-formed code", async (e) => {
    expect((await insertCode(e)).error).toBeNull();
    expect((await insertCode(e, { nonce: `'${"n".repeat(512)}'` })).error).toBeNull();
  });

  onEveryEngine("refuses a code that would outlive sixty seconds, or none", async (e) => {
    expect((await insertCode(e, { expires_at: "datetime('now', '+61 seconds')" })).error).toContain(
      "CHECK",
    );
    expect((await insertCode(e, { expires_at: "datetime('now')" })).error).toContain("CHECK");
  });

  onEveryEngine("refuses a code hash that is not 64 lowercase hex characters", async (e) => {
    for (const bad of [`'${"A".repeat(64)}'`, `'${"a".repeat(63)}'`, `'${"g".repeat(64)}'`]) {
      expect((await insertCode(e, { code_hash: bad })).error).toContain("CHECK");
    }
  });

  onEveryEngine("refuses a challenge that is not 43 base64url characters", async (e) => {
    for (const bad of [
      `'${CHALLENGE.slice(1)}'`,
      `'${CHALLENGE.slice(1)}+'`,
      `'${CHALLENGE.slice(1)}='`,
    ]) {
      expect((await insertCode(e, { code_challenge: bad })).error).toContain("CHECK");
    }
  });

  onEveryEngine("refuses a nonce over 512 characters, and an empty one", async (e) => {
    expect((await insertCode(e, { nonce: `'${"n".repeat(513)}'` })).error).toContain("CHECK");
    expect((await insertCode(e, { nonce: "''" })).error).toContain("CHECK");
  });

  onEveryEngine("refuses a created_at or expires_at that is not a time", async (e) => {
    // Without the IS NOT NULL terms the 60-second CHECK is NULL for a malformed time, and a CHECK
    // passes on NULL: the bound would hold for every row but these.
    expect((await insertCode(e, { created_at: "'garbage'", expires_at: "'zzz'" })).error).toContain(
      "CHECK",
    );
    expect(
      (await insertCode(e, { created_at: "datetime('now')", expires_at: "'zzz-later'" })).error,
    ).toContain("CHECK");
  });

  onEveryEngine("gives every code a stable row id, and keeps its hash unique", async (e) => {
    const hash = HASH(5_000_000 + counter++);
    expect((await insertCode(e, { code_hash: `'${hash}'` })).error).toBeNull();
    expect((await insertCode(e, { code_hash: `'${hash}'` })).error).toContain("UNIQUE");
    const row = await one<{ id: number; t: string }>(
      e,
      "SELECT id, typeof(id) AS t FROM oidc_codes WHERE code_hash = ?",
      hash,
    );
    expect(row.t).toBe("integer");
    expect(row.id).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------------------------
// The grant upsert
// ---------------------------------------------------------------------------------------------

describe("GRANT_UPSERT_SQL", () => {
  onEveryEngine(
    "records a first grant, and a person's consent only ever widens their own",
    async (e) => {
      const w = await world(e);
      expect((await upsertGrant(e, w, ["openid", "profile"], "user")).changes).toBe(1);
      expect(await grantOf(e, w)).toEqual([
        { scopes: '["openid","profile"]', consent_kind: "user" },
      ]);
      await upsertGrant(e, w, ["email", "openid"], "user");
      expect(await grantOf(e, w)).toEqual([
        { scopes: '["email","openid","profile"]', consent_kind: "user" },
      ]);
    },
  );

  onEveryEngine(
    "a person's consent replaces a first-party grant, which nobody consented to",
    async (e) => {
      const w = await world(e);
      await upsertGrant(e, w, ["email", "openid", "profile"], "first_party");
      await upsertGrant(e, w, ["openid"], "user");
      expect(await grantOf(e, w)).toEqual([{ scopes: '["openid"]', consent_kind: "user" }]);
    },
  );

  onEveryEngine(
    "a first-party authorization widens a grant and marks it first_party",
    async (e) => {
      const w = await world(e);
      await upsertGrant(e, w, ["openid"], "user");
      await upsertGrant(e, w, ["openid", "profile"], "first_party");
      expect(await grantOf(e, w)).toEqual([
        { scopes: '["openid","profile"]', consent_kind: "first_party" },
      ]);
    },
  );

  onEveryEngine(
    "writes nothing for a dead session, a refused account or a disabled client",
    async (e) => {
      const dead = await world(e);
      await ok(
        e,
        "UPDATE web_sessions SET revoked_at = datetime('now') WHERE id = ?",
        dead.sessionId,
      );
      const unproven = await world(e, { proven: false });
      const disabled = await world(e, { clientStatus: "disabled" });
      for (const w of [dead, unproven, disabled]) {
        expect((await upsertGrant(e, w, ["openid"], "user")).changes).toBe(0);
        expect(await grantOf(e, w)).toEqual([]);
      }
    },
  );
});

// ---------------------------------------------------------------------------------------------
// The code insert, gate by gate
// ---------------------------------------------------------------------------------------------

describe("CODE_INSERT_SQL on its own", () => {
  async function granted(
    e: Engine,
    over: Parameters<typeof world>[1] = {},
    scopes = ["openid", "profile"],
  ): Promise<World> {
    const w = await world(e, over);
    // The grant is written directly, so the code's own gates are what is tested.
    await ok(
      e,
      "INSERT INTO oidc_grants (user_id, client_id, scopes, consent_kind) VALUES (?, ?, ?, 'user')",
      w.userId,
      w.clientRow,
      JSON.stringify(scopes),
    );
    return w;
  }

  onEveryEngine(
    "mints for a live session, an account that passes the rule, an active client and a covering grant",
    async (e) => {
      const w = await granted(e);
      const hash = HASH(3_000_000 + counter);
      expect(await mintCode(e, w, { hash })).toEqual({ error: null, changes: 1 });
      const row = await one<{ live: number; auth_is_sign_in: number; user_id: number }>(
        e,
        `SELECT oc.expires_at > datetime('now') AS live, oc.user_id,
              oc.auth_time = ws.created_at AS auth_is_sign_in
         FROM oidc_codes oc JOIN web_sessions ws ON ws.id = ?
        WHERE oc.code_hash = ?`,
        w.sessionId,
        hash,
      );
      expect(row).toEqual({ live: 1, auth_is_sign_in: 1, user_id: w.userId });
    },
  );

  onEveryEngine("mints nothing once the session is revoked or expired", async (e) => {
    const revoked = await granted(e);
    await ok(
      e,
      "UPDATE web_sessions SET revoked_at = datetime('now') WHERE id = ?",
      revoked.sessionId,
    );
    const expired = await granted(e);
    await ok(
      e,
      "UPDATE web_sessions SET expires_at = datetime('now', '-1 second') WHERE id = ?",
      expired.sessionId,
    );
    expect((await mintCode(e, revoked)).changes).toBe(0);
    expect((await mintCode(e, expired)).changes).toBe(0);
  });

  onEveryEngine("mints nothing from a docs or private session", async (e) => {
    const w = await granted(e);
    await ok(e, "UPDATE web_sessions SET scope = 'docs' WHERE id = ?", w.sessionId);
    expect((await mintCode(e, w)).changes).toBe(0);
  });

  onEveryEngine("mints nothing for an account that is revoked, pending or deleted", async (e) => {
    const revoked = await granted(e);
    await ok(e, "UPDATE users SET status = 'revoked' WHERE id = ?", revoked.userId);
    const pending = await granted(e, { status: "pending" });
    const deleted = await granted(e);
    await ok(e, "UPDATE users SET deleted_at = datetime('now') WHERE id = ?", deleted.userId);
    for (const w of [revoked, pending, deleted]) expect((await mintCode(e, w)).changes).toBe(0);
  });

  onEveryEngine("mints nothing for a disabled client", async (e) => {
    const w = await granted(e, { clientStatus: "disabled" });
    expect((await mintCode(e, w)).changes).toBe(0);
  });

  onEveryEngine(
    "applies the client's sign-in rule: an unproven iD or a non-person mints nothing",
    async (e) => {
      const unproven = await granted(e, { proven: false });
      const service = await granted(e, { kind: "service" });
      for (const w of [unproven, service]) expect((await mintCode(e, w)).changes).toBe(0);
      const anyActive = await granted(e, {
        proven: false,
        kind: "service",
        rule: "active_account",
      });
      expect((await mintCode(e, anyActive)).changes).toBe(1);
    },
  );

  onEveryEngine(
    "an owner-attested iD is not proven: orcid_verified alone mints nothing",
    async (e) => {
      // `world` sets orcid_verified = 1 on every account; with no sign-in record it is not a proof.
      const attested = await granted(e, { proven: false });
      const flag = await one<{ orcid_verified: number }>(
        e,
        "SELECT orcid_verified FROM users WHERE id = ?",
        attested.userId,
      );
      expect(flag.orcid_verified).toBe(1);
      expect((await mintCode(e, attested)).changes).toBe(0);
    },
  );

  onEveryEngine("mints nothing beyond the grant or beyond what the client may have", async (e) => {
    const narrowGrant = await granted(e, {}, ["openid"]);
    expect((await mintCode(e, narrowGrant, { scopes: ["openid", "profile"] })).changes).toBe(0);
    const narrowClient = await granted(e, { allowed: ["openid"] }, ["openid", "profile"]);
    expect((await mintCode(e, narrowClient, { scopes: ["openid", "profile"] })).changes).toBe(0);
  });

  onEveryEngine("mints nothing for a redirect address the client did not register", async (e) => {
    const w = await granted(e);
    expect((await mintCode(e, w, { redirect: `${REDIRECT}/` })).changes).toBe(0);
  });

  onEveryEngine("mints nothing on another account's grant to the same client", async (e) => {
    // A and C hold live grants on one client; B, on the same client, holds none. The grant the
    // code is minted under must be B's own.
    const a = await granted(e);
    const b = await anotherAccount(e, a);
    const c = await anotherAccount(e, a);
    await ok(
      e,
      "INSERT INTO oidc_grants (user_id, client_id, scopes, consent_kind) VALUES (?, ?, ?, 'user')",
      c.userId,
      c.clientRow,
      '["openid","profile"]',
    );
    expect((await mintCode(e, b)).changes).toBe(0);
    expect((await mintCode(e, a)).changes).toBe(1);
  });

  onEveryEngine("records the session's own sign-in time as auth_time", async (e) => {
    const w = await granted(e);
    await ok(
      e,
      "UPDATE web_sessions SET created_at = datetime('now', '-10 minutes') WHERE id = ?",
      w.sessionId,
    );
    const hash = HASH(6_000_000 + counter);
    expect((await mintCode(e, w, { hash })).changes).toBe(1);
    const row = await one<{ same: number; tenAgo: number }>(
      e,
      `SELECT oc.auth_time = ws.created_at AS same,
              oc.auth_time <= datetime('now', '-9 minutes') AS tenAgo
         FROM oidc_codes oc JOIN web_sessions ws ON ws.id = ? WHERE oc.code_hash = ?`,
      w.sessionId,
      hash,
    );
    expect(row).toEqual({ same: 1, tenAgo: 1 });
  });

  onEveryEngine("mints nothing without a live grant", async (e) => {
    const none = await world(e);
    expect((await mintCode(e, none)).changes).toBe(0);
    const revoked = await granted(e);
    await ok(
      e,
      "UPDATE oidc_grants SET revoked_at = datetime('now') WHERE user_id = ?",
      revoked.userId,
    );
    expect((await mintCode(e, revoked)).changes).toBe(0);
  });
});

describe("CODES_PRUNE_SQL", () => {
  onEveryEngine(
    "deletes codes more than an hour past expiry, used or not, and nothing newer",
    async (e) => {
      const base = 4_000_000 + counter++ * 10;
      const insert = (n: number, expires: string, used: string) =>
        ok(
          e,
          `INSERT INTO oidc_codes (code_hash, client_id, user_id, grant_id, redirect_uri, scopes,
                                 code_challenge, auth_time, created_at, expires_at, used_at)
         VALUES (?, 1, 1, 1, ?, '["openid"]', ?, datetime('now'), datetime(${expires}, '-60 seconds'),
                 ${expires}, ${used})`,
          HASH(base + n),
          REDIRECT,
          CHALLENGE,
        );
      await insert(1, "datetime('now', '-61 minutes')", "datetime('now', '-62 minutes')");
      await insert(2, "datetime('now', '-61 minutes')", "NULL");
      await insert(3, "datetime('now', '-59 minutes')", "datetime('now', '-60 minutes')");
      await insert(4, "datetime('now', '+30 seconds')", "NULL");
      await ok(e, CODES_PRUNE_SQL);
      const left = await e.all<{ code_hash: string }>(
        "SELECT code_hash FROM oidc_codes WHERE code_hash IN (?, ?, ?, ?) ORDER BY code_hash",
        HASH(base + 1),
        HASH(base + 2),
        HASH(base + 3),
        HASH(base + 4),
      );
      expect(left.map((r) => r.code_hash)).toEqual([HASH(base + 3), HASH(base + 4)]);
    },
  );
});
