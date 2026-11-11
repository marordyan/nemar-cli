/**
 * Migration 0123_oidc_tokens.sql and the token endpoint's own statements (epic #2014 phase #2018; ADR
 * 0119), on two engines: bun:sqlite, which every other suite uses, and Miniflare's D1, the
 * implementation `wrangler --local` runs, because D1's SQLite is stricter than bun's and several
 * statements here lean on newer constructs (a scalar `min()` over two times, correlated subqueries
 * inside an UPDATE, `json_each` over a bound array).
 *
 * Pinned:
 *   - what the table refuses with the services out of the way: the kind, the hash, the scope array,
 *     an account's token without its grant, code or family (and a client's token with one), each
 *     kind's lifetime, a time not in `datetime()`'s form, and a revocation without its reason;
 *   - each statement run DIRECTLY, gate by gate. Through the routes most of these gates are shadowed
 *     by an earlier check (client authentication, the pre-read of a code or a token, a rule applied
 *     in TypeScript), so removing one would leave every route test green; this is where each is
 *     proved on its own, as `oidc-authorize-migration.test.ts` does for `CODE_INSERT_SQL`.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { oidcClientEndStatements, oidcEndStatements } from "../src/services/oidc-cascade";
import {
  ACCESS_FROM_CODE_SQL,
  CLIENT_CREDENTIALS_SQL,
  CODE_REPLAY_REVOKE_SQL,
  CODE_SPEND_SQL,
  REFRESH_CHILD_SQL,
  REFRESH_FROM_CODE_SQL,
  REFRESH_REUSE_REVOKE_SQL,
  REFRESH_SIBLINGS_REVOKE_SQL,
  REFRESH_SPEND_SQL,
  TOKENS_PRUNE_SQL,
  TOKEN_LOOKUP_SQL,
} from "../src/services/oidc-tokens";
import * as tokenStore from "../src/services/oidc-tokens";
import { freshDb } from "./helpers/d1";
import { applyMigrations, migrationFiles } from "./helpers/miniflare-d1";

interface Engine {
  name: string;
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
  return rows[0] as T;
}

let counter = 0;
const HASH = () => {
  counter += 1;
  return counter.toString(16).padStart(64, "0");
};
const FAMILY = () => {
  counter += 1;
  return counter.toString(16).padStart(32, "0");
};
const MACHINE = JSON.stringify(["compute.stats"]);
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

interface World {
  userId: number;
  clientRow: number;
  grantId: number;
  codeId: number;
  codeHash: string;
}

/**
 * An account, an active client allowed every grant, a live grant and a fresh unused code, with what a
 * test overrides. The client's rule is `active_account` unless told otherwise.
 */
async function world(
  e: Engine,
  over: {
    status?: string;
    clientStatus?: "active" | "disabled";
    grants?: string[];
    allowed?: string[];
    grantScopes?: string[];
    codeScopes?: string[];
    rule?: string;
  } = {},
): Promise<World> {
  counter += 1;
  const name = `oidcstore${counter}`;
  await ok(
    e,
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES (?, ?, 'x', ?, 'member', ?)`,
    name,
    `${name}@example.org`,
    over.status ?? "verified",
    over.status === "pending" ? 0 : 1,
  );
  const user = await one<{ id: number }>(e, "SELECT id FROM users WHERE username = ?", name);
  const clientId = `oc_${counter.toString(16).padStart(24, "b")}`;
  const disabled = over.clientStatus === "disabled";
  await ok(
    e,
    `INSERT INTO oidc_clients (client_id, name, secret_hash, redirect_uris, allowed_scopes,
       allowed_grants, sign_in_rule, first_party, consent_mode, audience, status, disabled_at,
       created_by)
     VALUES (?, ?, ?, '["https://client.example.org/cb"]', ?, ?, ?, 0, 'ask_once',
             'https://api.example.org', ?, ${disabled ? "datetime('now')" : "NULL"}, 1)`,
    clientId,
    `Store client ${counter}`,
    HASH(),
    JSON.stringify(over.allowed ?? ["openid", "profile", "offline_access", "compute.stats"]),
    JSON.stringify(over.grants ?? ["authorization_code", "refresh_token", "client_credentials"]),
    over.rule ?? "active_account",
    disabled ? "disabled" : "active",
  );
  const client = await one<{ id: number }>(
    e,
    "SELECT id FROM oidc_clients WHERE client_id = ?",
    clientId,
  );
  await ok(
    e,
    "INSERT INTO oidc_grants (user_id, client_id, scopes, consent_kind) VALUES (?, ?, ?, 'user')",
    user.id,
    client.id,
    JSON.stringify(over.grantScopes ?? ["offline_access", "openid", "profile"]),
  );
  const grant = await one<{ id: number }>(
    e,
    "SELECT id FROM oidc_grants WHERE user_id = ? AND client_id = ?",
    user.id,
    client.id,
  );
  const codeHash = HASH();
  await ok(
    e,
    `INSERT INTO oidc_codes (code_hash, client_id, user_id, grant_id, redirect_uri, scopes,
       code_challenge, auth_time, expires_at)
     VALUES (?, ?, ?, ?, 'https://client.example.org/cb', ?, ?, datetime('now'),
             datetime('now', '+60 seconds'))`,
    codeHash,
    client.id,
    user.id,
    grant.id,
    JSON.stringify(over.codeScopes ?? ["offline_access", "openid"]),
    CHALLENGE,
  );
  const code = await one<{ id: number }>(
    e,
    "SELECT id FROM oidc_codes WHERE code_hash = ?",
    codeHash,
  );
  return {
    userId: user.id,
    clientRow: client.id,
    grantId: grant.id,
    codeId: code.id,
    codeHash,
  };
}

/** Run the real access-token-from-code insert, bound as the service binds it. */
function mintFromCode(e: Engine, w: World, over: { client?: number } = {}) {
  const hash = HASH();
  return e
    .run(ACCESS_FROM_CODE_SQL, hash, FAMILY(), 900, w.codeHash, over.client ?? w.clientRow, MACHINE)
    .then((r) => ({ ...r, hash }));
}

/** A refresh token row of `w`'s family, inserted directly; returns its id and hash. */
async function refreshRow(
  e: Engine,
  w: World,
  over: { family?: string; usedAgo?: number | null; revoked?: boolean; parent?: number } = {},
): Promise<{ id: number; hash: string; family: string }> {
  const hash = HASH();
  const family = over.family ?? FAMILY();
  await ok(
    e,
    `INSERT INTO oidc_tokens (token_hash, kind, client_id, user_id, grant_id, code_id, family_id,
       parent_id, audience, scopes, expires_at, absolute_expires_at, used_at, revoked_at,
       revoked_reason)
     VALUES (?, 'refresh', ?, ?, ?, ?, ?, ?, 'https://api.example.org', '["offline_access","openid"]',
             datetime('now', '+30 days'), datetime('now', '+90 days'),
             CASE WHEN ? IS NULL THEN NULL ELSE datetime('now', '-' || ? || ' seconds') END,
             ${over.revoked ? "datetime('now'), 'test'" : "NULL, NULL"})`,
    hash,
    w.clientRow,
    w.userId,
    w.grantId,
    w.codeId,
    family,
    over.parent ?? null,
    over.usedAgo ?? null,
    over.usedAgo ?? null,
  );
  const row = await one<{ id: number }>(e, "SELECT id FROM oidc_tokens WHERE token_hash = ?", hash);
  return { id: row.id, hash, family };
}

/** Run the real rotation insert, bound as the service binds it. */
function rotate(
  e: Engine,
  w: World,
  parentId: number,
  over: { client?: number; kind?: string; scopes?: string[] } = {},
) {
  return e.run(
    REFRESH_CHILD_SQL,
    HASH(),
    2_592_000,
    parentId,
    over.client ?? w.clientRow,
    over.kind ?? "user",
    JSON.stringify(over.scopes ?? ["openid"]),
    30,
  );
}

const TOKEN_COLUMNS = `(token_hash, kind, client_id, user_id, grant_id, code_id, family_id, audience,
   scopes, created_at, expires_at, absolute_expires_at, used_at, revoked_at, revoked_reason)`;

/** Insert a token row with every column given, for the table's own refusals. */
function insertToken(e: Engine, over: Record<string, unknown>) {
  const row: Record<string, unknown> = {
    token_hash: HASH(),
    kind: "access",
    client_id: 1,
    user_id: 1,
    grant_id: 1,
    code_id: 1,
    family_id: FAMILY(),
    audience: "https://api.example.org",
    scopes: '["openid"]',
    created_at: "2026-11-04 10:00:00",
    expires_at: "2026-11-04 10:15:00",
    absolute_expires_at: null,
    used_at: null,
    revoked_at: null,
    revoked_reason: null,
    ...over,
  };
  return e.run(
    `INSERT INTO oidc_tokens ${TOKEN_COLUMNS} VALUES (${Array(15).fill("?").join(", ")})`,
    row.token_hash,
    row.kind,
    row.client_id,
    row.user_id,
    row.grant_id,
    row.code_id,
    row.family_id,
    row.audience,
    row.scopes,
    row.created_at,
    row.expires_at,
    row.absolute_expires_at,
    row.used_at,
    row.revoked_at,
    row.revoked_reason,
  );
}

// ---------------------------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------------------------

describe("oidc_tokens refuses what no rule writes", () => {
  onEveryEngine("a well-formed access and refresh token are accepted", async (e) => {
    expect((await insertToken(e, {})).error).toBeNull();
    expect(
      (
        await insertToken(e, {
          kind: "refresh",
          expires_at: "2026-12-04 10:00:00",
          absolute_expires_at: "2027-02-02 10:00:00",
          used_at: "2026-11-05 10:00:00",
        })
      ).error,
    ).toBeNull();
    // A client credentials token names no account, grant, code or family.
    expect(
      (await insertToken(e, { user_id: null, grant_id: null, code_id: null, family_id: null }))
        .error,
    ).toBeNull();
  });

  onEveryEngine("the shape of each column", async (e) => {
    for (const over of [
      { kind: "id" },
      { token_hash: "ABC".padEnd(64, "0") },
      { token_hash: "0".repeat(63) },
      { scopes: "[]" },
      { scopes: '["Openid"]' },
      { scopes: "openid" },
      { family_id: "x".repeat(32) },
      { audience: "" },
      { revoked_reason: "Code Replay", revoked_at: "2026-11-04 10:01:00" },
      { revoked_at: "2026-11-04 10:01:00" },
      { revoked_reason: "code_replay" },
      { client_id: 0 },
      { user_id: "one" },
    ]) {
      expect({ over, refused: (await insertToken(e, over)).error !== null }).toEqual({
        over,
        refused: true,
      });
    }
    const hash = HASH();
    expect((await insertToken(e, { token_hash: hash })).error).toBeNull();
    expect((await insertToken(e, { token_hash: hash })).error).not.toBeNull();
  });

  onEveryEngine(
    "an account's token has a grant, a code and a family; a client's has none",
    async (e) => {
      for (const over of [
        { grant_id: null },
        { code_id: null },
        { family_id: null },
        { user_id: null },
        { user_id: null, grant_id: null, code_id: null },
      ]) {
        expect({ over, refused: (await insertToken(e, over)).error !== null }).toEqual({
          over,
          refused: true,
        });
      }
    },
  );

  onEveryEngine("each kind lives no longer than its rule, in datetime()'s own form", async (e) => {
    for (const over of [
      { expires_at: "2026-11-04 10:15:01" },
      { expires_at: "2026-11-04 10:00:00" },
      { expires_at: "2026-11-04T10:10:00Z" },
      { created_at: "yesterday" },
      { used_at: "2026-11-04 10:01:00" },
      { absolute_expires_at: "2026-11-05 10:00:00" },
      // A refresh token: idle over 30 days, absolute over 90, past its own absolute, without one.
      {
        kind: "refresh",
        expires_at: "2026-12-04 10:00:01",
        absolute_expires_at: "2027-01-04 10:00:00",
      },
      {
        kind: "refresh",
        expires_at: "2026-12-04 10:00:00",
        absolute_expires_at: "2027-02-02 10:00:01",
      },
      {
        kind: "refresh",
        expires_at: "2026-11-20 10:00:00",
        absolute_expires_at: "2026-11-10 10:00:00",
      },
      { kind: "refresh", expires_at: "2026-11-20 10:00:00" },
      {
        kind: "refresh",
        user_id: null,
        grant_id: null,
        code_id: null,
        family_id: null,
        expires_at: "2026-11-20 10:00:00",
        absolute_expires_at: "2026-11-30 10:00:00",
      },
    ]) {
      expect({ over, refused: (await insertToken(e, over)).error !== null }).toEqual({
        over,
        refused: true,
      });
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The code's statements
// ---------------------------------------------------------------------------------------------

describe("ACCESS_FROM_CODE_SQL on its own: the claim predicate and the gates", () => {
  onEveryEngine(
    "mints for an unused, live code of this client whose account and grant pass",
    async (e) => {
      const w = await world(e);
      const r = await mintFromCode(e, w);
      expect(r).toMatchObject({ error: null, changes: 1 });
      const row = await one<Record<string, unknown>>(
        e,
        `SELECT kind, user_id, grant_id, code_id, scopes, audience,
              CAST(strftime('%s', expires_at) AS INTEGER) - CAST(strftime('%s', created_at) AS INTEGER) AS life
         FROM oidc_tokens WHERE token_hash = ?`,
        r.hash,
      );
      expect(row).toEqual({
        kind: "access",
        user_id: w.userId,
        grant_id: w.grantId,
        code_id: w.codeId,
        scopes: '["offline_access","openid"]',
        audience: "https://api.example.org",
        life: 900,
      });
    },
  );

  onEveryEngine("mints nothing for a used code, an expired one, or another client's", async (e) => {
    const used = await world(e);
    await ok(e, "UPDATE oidc_codes SET used_at = datetime('now') WHERE id = ?", used.codeId);
    const expired = await world(e);
    await ok(
      e,
      `UPDATE oidc_codes SET created_at = datetime('now', '-70 seconds'),
              expires_at = datetime('now', '-10 seconds') WHERE id = ?`,
      expired.codeId,
    );
    const other = await world(e);
    const mine = await world(e);
    expect((await mintFromCode(e, used)).changes).toBe(0);
    expect((await mintFromCode(e, expired)).changes).toBe(0);
    expect((await mintFromCode(e, mine, { client: other.clientRow })).changes).toBe(0);
  });

  onEveryEngine(
    "mints nothing once the client, the account or the grant stopped passing",
    async (e) => {
      const disabled = await world(e, { clientStatus: "disabled" });
      const noGrantType = await world(e, {
        grants: ["client_credentials"],
        allowed: ["compute.stats", "openid", "offline_access"],
      });
      const revokedAccount = await world(e);
      await ok(e, "UPDATE users SET status = 'revoked' WHERE id = ?", revokedAccount.userId);
      const deleted = await world(e);
      await ok(e, "UPDATE users SET deleted_at = datetime('now') WHERE id = ?", deleted.userId);
      const unproven = await world(e, { rule: "person_proven_orcid" });
      const revokedGrant = await world(e);
      await ok(
        e,
        "UPDATE oidc_grants SET revoked_at = datetime('now') WHERE id = ?",
        revokedGrant.grantId,
      );
      const narrowGrant = await world(e, { grantScopes: ["openid"] });
      const narrowClient = await world(e, { allowed: ["openid", "profile"] });
      const machine = await world(e, {
        grantScopes: ["compute.stats", "openid"],
        codeScopes: ["compute.stats", "openid"],
      });
      for (const [label, w] of [
        ["disabled client", disabled],
        ["grant type", noGrantType],
        ["revoked account", revokedAccount],
        ["deleted account", deleted],
        ["unproven iD", unproven],
        ["revoked grant", revokedGrant],
        ["grant narrower than the code", narrowGrant],
        ["client narrower than the code", narrowClient],
        ["machine scope", machine],
      ] as const) {
        expect({ label, changes: (await mintFromCode(e, w)).changes }).toEqual({
          label,
          changes: 0,
        });
      }
    },
  );

  onEveryEngine(
    "a code whose grant is another account's, or this account's to another client, mints nothing",
    async (e) => {
      // `g.id = k.grant_id` alone would accept these rows; the grant must also be THIS account's to
      // THIS client. No route writes such a code (the code's insert joins the session's own grant),
      // so the rows are made by hand: the guard is defence in depth, held here.
      // Another account's grant to THIS client: only the account differs.
      const mine = await world(e);
      const other = await world(e);
      await ok(
        e,
        "INSERT INTO oidc_grants (user_id, client_id, scopes, consent_kind) VALUES (?, ?, ?, 'user')",
        other.userId,
        mine.clientRow,
        JSON.stringify(["offline_access", "openid", "profile"]),
      );
      const theirs = await one<{ id: number }>(
        e,
        "SELECT id FROM oidc_grants WHERE user_id = ? AND client_id = ?",
        other.userId,
        mine.clientRow,
      );
      await ok(e, "UPDATE oidc_codes SET grant_id = ? WHERE id = ?", theirs.id, mine.codeId);
      expect((await mintFromCode(e, mine)).changes).toBe(0);
      // This account's grant to ANOTHER client: only the client differs.
      const w = await world(e);
      const elsewhere = await world(e);
      await ok(
        e,
        "INSERT INTO oidc_grants (user_id, client_id, scopes, consent_kind) VALUES (?, ?, ?, 'user')",
        w.userId,
        elsewhere.clientRow,
        JSON.stringify(["offline_access", "openid", "profile"]),
      );
      const foreign = await one<{ id: number }>(
        e,
        "SELECT id FROM oidc_grants WHERE user_id = ? AND client_id = ?",
        w.userId,
        elsewhere.clientRow,
      );
      await ok(e, "UPDATE oidc_codes SET grant_id = ? WHERE id = ?", foreign.id, w.codeId);
      expect((await mintFromCode(e, w)).changes).toBe(0);
    },
  );

  onEveryEngine(
    "CODE_SPEND_SQL marks the code used only beside this request's own token",
    async (e) => {
      const w = await world(e);
      expect(await ok(e, CODE_SPEND_SQL, w.codeId, HASH())).toBe(0);
      const r = await mintFromCode(e, w);
      expect(await ok(e, CODE_SPEND_SQL, w.codeId, r.hash)).toBe(1);
      // Another code's token does not spend this one.
      const other = await world(e);
      expect(await ok(e, CODE_SPEND_SQL, other.codeId, r.hash)).toBe(0);
    },
  );

  onEveryEngine(
    "CODE_REPLAY_REVOKE_SQL ends the code's tokens only when it is this client's and used",
    async (e) => {
      const w = await world(e);
      const r = await mintFromCode(e, w);
      await refreshRow(e, w);
      expect(await ok(e, CODE_REPLAY_REVOKE_SQL, w.codeHash, w.clientRow)).toBe(0);
      await ok(e, "UPDATE oidc_codes SET used_at = datetime('now') WHERE id = ?", w.codeId);
      const other = await world(e);
      expect(await ok(e, CODE_REPLAY_REVOKE_SQL, w.codeHash, other.clientRow)).toBe(0);
      expect(await ok(e, CODE_REPLAY_REVOKE_SQL, w.codeHash, w.clientRow)).toBe(2);
      const reasons = await e.all<{ revoked_reason: string }>(
        "SELECT revoked_reason FROM oidc_tokens WHERE code_id = ?",
        w.codeId,
      );
      expect(reasons.map((x) => x.revoked_reason)).toEqual(["code_replay", "code_replay"]);
      expect(r.hash.length).toBe(64);
    },
  );
});

// ---------------------------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------------------------

describe("REFRESH_FROM_CODE_SQL on its own", () => {
  const refreshFor = (e: Engine, accessHash: string) =>
    e.run(REFRESH_FROM_CODE_SQL, HASH(), 2_592_000, 7_776_000, accessHash);

  onEveryEngine(
    "mints beside the access token only with offline_access and the refresh grant",
    async (e) => {
      const w = await world(e);
      expect((await refreshFor(e, (await mintFromCode(e, w)).hash)).changes).toBe(1);
      const noOffline = await world(e, { codeScopes: ["openid"] });
      expect((await refreshFor(e, (await mintFromCode(e, noOffline)).hash)).changes).toBe(0);
      const noGrant = await world(e, { grants: ["authorization_code"] });
      expect((await refreshFor(e, (await mintFromCode(e, noGrant)).hash)).changes).toBe(0);
      // Beside nothing: no access token of that hash.
      expect((await refreshFor(e, HASH())).changes).toBe(0);
    },
  );
});

describe("REFRESH_CHILD_SQL on its own: first use, one retry, nothing else", () => {
  onEveryEngine(
    "an unspent parent with no child mints one; a second is refused while it is unspent",
    async (e) => {
      const w = await world(e);
      const p = await refreshRow(e, w);
      expect((await rotate(e, w, p.id)).changes).toBe(1);
      expect((await rotate(e, w, p.id)).changes).toBe(0);
    },
  );

  onEveryEngine(
    "a parent spent inside the grace with one child mints one more, never a third",
    async (e) => {
      const w = await world(e);
      const p = await refreshRow(e, w, { usedAgo: 5 });
      await refreshRow(e, w, { family: p.family, parent: p.id });
      expect((await rotate(e, w, p.id)).changes).toBe(1);
      expect((await rotate(e, w, p.id)).changes).toBe(0);
    },
  );

  onEveryEngine(
    "inside the grace, a parent whose only child was rotated or revoked mints nothing",
    async (e) => {
      const w = await world(e);
      const rotated = await refreshRow(e, w, { usedAgo: 5 });
      await refreshRow(e, w, { family: rotated.family, parent: rotated.id, usedAgo: 2 });
      expect((await rotate(e, w, rotated.id)).changes).toBe(0);
      const revoked = await refreshRow(e, w, { usedAgo: 5 });
      await refreshRow(e, w, { family: revoked.family, parent: revoked.id, revoked: true });
      expect((await rotate(e, w, revoked.id)).changes).toBe(0);
    },
  );

  onEveryEngine(
    "a parent spent past the grace, or spent with no child, mints nothing",
    async (e) => {
      const w = await world(e);
      const late = await refreshRow(e, w, { usedAgo: 31 });
      await refreshRow(e, w, { family: late.family, parent: late.id });
      expect((await rotate(e, w, late.id)).changes).toBe(0);
      const orphan = await refreshRow(e, w, { usedAgo: 1 });
      expect((await rotate(e, w, orphan.id)).changes).toBe(0);
    },
  );

  onEveryEngine(
    "a revoked, expired or other client's parent, or one of another consent kind, mints nothing",
    async (e) => {
      const w = await world(e);
      const revoked = await refreshRow(e, w, { revoked: true });
      const expired = await refreshRow(e, w);
      await ok(
        e,
        `UPDATE oidc_tokens SET created_at = datetime('now', '-31 days'),
              expires_at = datetime('now', '-1 day'),
              absolute_expires_at = datetime('now', '+59 days') WHERE id = ?`,
        expired.id,
      );
      const mine = await refreshRow(e, w);
      const other = await world(e);
      expect((await rotate(e, w, revoked.id)).changes).toBe(0);
      expect((await rotate(e, w, expired.id)).changes).toBe(0);
      expect((await rotate(e, w, mine.id, { client: other.clientRow })).changes).toBe(0);
      expect((await rotate(e, w, mine.id, { kind: "first_party" })).changes).toBe(0);
      expect((await rotate(e, w, mine.id, { scopes: ["openid", "profile"] })).changes).toBe(0);
      expect((await rotate(e, w, mine.id)).changes).toBe(1);
    },
  );

  onEveryEngine(
    "an inactive account, a revoked grant or a disabled client mints nothing",
    async (e) => {
      for (const change of [
        "UPDATE users SET status = 'revoked' WHERE id = (SELECT user_id FROM oidc_grants WHERE id = ?)",
        "UPDATE oidc_grants SET revoked_at = datetime('now') WHERE id = ?",
        "UPDATE oidc_clients SET status = 'disabled', disabled_at = datetime('now') WHERE id = (SELECT client_id FROM oidc_grants WHERE id = ?)",
      ]) {
        const w = await world(e);
        const p = await refreshRow(e, w);
        await ok(e, change, w.grantId);
        expect({ change, changes: (await rotate(e, w, p.id)).changes }).toEqual({
          change,
          changes: 0,
        });
      }
    },
  );

  onEveryEngine("the child keeps the family's absolute expiry and expires no later", async (e) => {
    const w = await world(e);
    const p = await refreshRow(e, w);
    await ok(
      e,
      `UPDATE oidc_tokens SET absolute_expires_at = datetime('now', '+1 hour'),
              expires_at = datetime('now', '+1 hour') WHERE id = ?`,
      p.id,
    );
    expect((await rotate(e, w, p.id)).changes).toBe(1);
    const child = await one<{ same: number; capped: number }>(
      e,
      `SELECT c.absolute_expires_at = p.absolute_expires_at AS same,
              c.expires_at = c.absolute_expires_at AS capped
         FROM oidc_tokens c JOIN oidc_tokens p ON p.id = c.parent_id WHERE p.id = ?`,
      p.id,
    );
    expect(child).toEqual({ same: 1, capped: 1 });
  });

  onEveryEngine(
    "REFRESH_SPEND_SQL spends the parent once, beside its own child only",
    async (e) => {
      const w = await world(e);
      const p = await refreshRow(e, w);
      const stranger = await refreshRow(e, w);
      expect(await ok(e, REFRESH_SPEND_SQL, p.id, stranger.hash)).toBe(0);
      const child = await refreshRow(e, w, { family: p.family, parent: p.id });
      expect(await ok(e, REFRESH_SPEND_SQL, p.id, child.hash)).toBe(1);
      expect(await ok(e, REFRESH_SPEND_SQL, p.id, child.hash)).toBe(0);
    },
  );
});

describe("REFRESH_REUSE_REVOKE_SQL re-checks why it runs", () => {
  async function familyOf(e: Engine, w: World, usedAgo: number | null, children: number) {
    const p = await refreshRow(e, w, { usedAgo });
    for (let i = 0; i < children; i++) await refreshRow(e, w, { family: p.family, parent: p.id });
    return p;
  }
  const revoke = (e: Engine, id: number, client: number) =>
    ok(e, REFRESH_REUSE_REVOKE_SQL, id, client, 30);

  onEveryEngine(
    "an unspent token, or one spent inside the grace with one child, ends nothing",
    async (e) => {
      const w = await world(e);
      expect(await revoke(e, (await familyOf(e, w, null, 0)).id, w.clientRow)).toBe(0);
      expect(await revoke(e, (await familyOf(e, w, 5, 1)).id, w.clientRow)).toBe(0);
    },
  );

  onEveryEngine(
    "spent past the grace, retried already, or revoked: the whole family ends",
    async (e) => {
      const w = await world(e);
      expect(await revoke(e, (await familyOf(e, w, 31, 1)).id, w.clientRow)).toBe(2);
      expect(await revoke(e, (await familyOf(e, w, 5, 2)).id, w.clientRow)).toBe(3);
      // Spent inside the grace, its only child rotated since (or revoked): the retry's refusal, mirrored.
      const late = await refreshRow(e, w, { usedAgo: 5 });
      await refreshRow(e, w, { family: late.family, parent: late.id, usedAgo: 2 });
      expect(await revoke(e, late.id, w.clientRow)).toBe(2);
      const cut = await refreshRow(e, w, { usedAgo: 5 });
      const cutChild = await refreshRow(e, w, { family: cut.family, parent: cut.id });
      await ok(
        e,
        "UPDATE oidc_tokens SET revoked_at = datetime('now'), revoked_reason = 'client_revoked' WHERE id = ?",
        cutChild.id,
      );
      expect(await revoke(e, cut.id, w.clientRow)).toBe(1);
      const revoked = await refreshRow(e, w, { revoked: true });
      await refreshRow(e, w, { family: revoked.family });
      expect(await revoke(e, revoked.id, w.clientRow)).toBe(1);
    },
  );

  onEveryEngine("another client cannot end a family by presenting its token", async (e) => {
    const w = await world(e);
    const other = await world(e);
    expect(await revoke(e, (await familyOf(e, w, 31, 1)).id, other.clientRow)).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Client credentials, the lookup and the prune
// ---------------------------------------------------------------------------------------------

describe("CLIENT_CREDENTIALS_SQL and TOKEN_LOOKUP_SQL", () => {
  const mintMachine = (e: Engine, client: number, scopes = ["compute.stats"]) =>
    e.run(
      CLIENT_CREDENTIALS_SQL,
      HASH(),
      JSON.stringify(scopes),
      900,
      client,
      JSON.stringify(scopes),
    );

  onEveryEngine(
    "a client credentials token needs an active client allowed the grant and the scope",
    async (e) => {
      const w = await world(e);
      expect((await mintMachine(e, w.clientRow)).changes).toBe(1);
      const noGrant = await world(e, { grants: ["authorization_code"] });
      const disabled = await world(e, { clientStatus: "disabled" });
      const noScope = await world(e, { allowed: ["openid"] });
      for (const client of [noGrant.clientRow, disabled.clientRow, noScope.clientRow]) {
        expect((await mintMachine(e, client)).changes).toBe(0);
      }
    },
  );

  onEveryEngine("the lookup's verdict reads the account and grant live", async (e) => {
    const w = await world(e);
    const r = await mintFromCode(e, w);
    const active = async () => (await one<{ active: number }>(e, TOKEN_LOOKUP_SQL, r.hash)).active;
    expect(await active()).toBe(1);
    await ok(e, "UPDATE users SET status = 'revoked' WHERE id = ?", w.userId);
    expect(await active()).toBe(0);
    await ok(e, "UPDATE users SET status = 'approved' WHERE id = ?", w.userId);
    expect(await active()).toBe(1);
    await ok(e, "UPDATE oidc_grants SET revoked_at = datetime('now') WHERE id = ?", w.grantId);
    expect(await active()).toBe(0);
  });
});

describe("TOKENS_PRUNE_SQL", () => {
  onEveryEngine(
    "deletes a day past expiry; a spent refresh token stays until a day past its family's end",
    async (e) => {
      const w = await world(e);
      const old = HASH();
      await insertToken(e, {
        token_hash: old,
        client_id: w.clientRow,
        created_at: "2020-01-01 00:00:00",
        expires_at: "2020-01-01 00:15:00",
      });
      const spent = await refreshRow(e, w, { usedAgo: 40 * 86_400 });
      await ok(
        e,
        `UPDATE oidc_tokens SET created_at = datetime('now', '-45 days'),
              expires_at = datetime('now', '-15 days'),
              absolute_expires_at = datetime('now', '+45 days') WHERE id = ?`,
        spent.id,
      );
      const ended = await refreshRow(e, w);
      await ok(
        e,
        `UPDATE oidc_tokens SET created_at = datetime('now', '-92 days'),
              expires_at = datetime('now', '-62 days'),
              absolute_expires_at = datetime('now', '-2 days') WHERE id = ?`,
        ended.id,
      );
      await ok(e, TOKENS_PRUNE_SQL);
      const left = await e.all<{ token_hash: string }>(
        "SELECT token_hash FROM oidc_tokens WHERE token_hash IN (?, ?, ?)",
        old,
        spent.hash,
        ended.hash,
      );
      expect(left.map((x) => x.token_hash)).toEqual([spent.hash]);
    },
  );
});

describe("the prune reads only what it may delete", () => {
  // The prune runs at the head of every batch that mints. Its access branch is answered from the
  // expiry index; were that index over every row, each prune would also walk every retained refresh
  // row (measured in review: 43 ms with 200,000 of them, 0.06 ms with the partial index). Pinned by
  // the index's own definition, since the plan names the same index either way.
  onEveryEngine("the access expiry index is partial on kind = 'access'", async (e) => {
    const index = await one<{ sql: string }>(
      e,
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'oidc_tokens_expires_at'",
    );
    expect(index.sql.replace(/\s+/g, " ")).toMatch(/\(expires_at\) WHERE kind = 'access'$/);
    const absolute = await one<{ sql: string }>(
      e,
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'oidc_tokens_absolute_expires_at'",
    );
    expect(absolute.sql.replace(/\s+/g, " ")).toMatch(/WHERE absolute_expires_at IS NOT NULL$/);
  });

  test("the prune's plan searches both expiry indexes and scans no table", () => {
    const plan = sqlite
      .query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${TOKENS_PRUNE_SQL}`)
      .all()
      .map((r) => r.detail);
    expect(plan.some((d) => /USING INDEX oidc_tokens_expires_at\b/.test(d))).toBe(true);
    expect(plan.some((d) => /USING INDEX oidc_tokens_absolute_expires_at\b/.test(d))).toBe(true);
    expect(plan.some((d) => /^SCAN oidc_tokens\b/.test(d))).toBe(false);
  });
});

describe("REFRESH_SIBLINGS_REVOKE_SQL: the children of one parent are mutually exclusive", () => {
  onEveryEngine(
    "rotating one child revokes its live refresh siblings, spent or not, and nothing else",
    async (e) => {
      const w = await world(e);
      const root = await refreshRow(e, w, { usedAgo: 5 });
      const presented = await refreshRow(e, w, { family: root.family, parent: root.id });
      const sibling = await refreshRow(e, w, { family: root.family, parent: root.id });
      // A spent sibling cannot arise through the routes any more (the retry is refused once the first
      // child is rotated); written here by hand, it is revoked like any other live sibling, so no
      // branch survives by being spent.
      const spentSibling = await refreshRow(e, w, {
        family: root.family,
        parent: root.id,
        usedAgo: 2,
      });
      const accessHash = HASH();
      await ok(
        e,
        `INSERT INTO oidc_tokens (token_hash, kind, client_id, user_id, grant_id, code_id, family_id,
         parent_id, audience, scopes, expires_at)
       VALUES (?, 'access', ?, ?, ?, ?, ?, ?, 'https://api.example.org', '["openid"]',
               datetime('now', '+900 seconds'))`,
        accessHash,
        w.clientRow,
        w.userId,
        w.grantId,
        w.codeId,
        root.family,
        root.id,
      );
      const revokeSiblings = (childHash: string) =>
        ok(e, REFRESH_SIBLINGS_REVOKE_SQL, presented.id, presented.id, childHash, presented.id);
      // Not before this request's child of the presented token exists.
      expect(await revokeSiblings(HASH())).toBe(0);
      const child = await refreshRow(e, w, { family: root.family, parent: presented.id });
      expect(await revokeSiblings(child.hash)).toBe(2);
      const rows = await e.all<{ token_hash: string; revoked_reason: string | null }>(
        "SELECT token_hash, revoked_reason FROM oidc_tokens WHERE family_id = ?",
        root.family,
      );
      const reasonOf = (hash: string) => rows.find((r) => r.token_hash === hash)?.revoked_reason;
      expect(reasonOf(sibling.hash)).toBe("refresh_superseded");
      expect(reasonOf(spentSibling.hash)).toBe("refresh_superseded");
      for (const hash of [presented.hash, root.hash, child.hash, accessHash]) {
        expect(reasonOf(hash)).toBeNull();
      }
    },
  );

  onEveryEngine("a family's first token has no parent, so no sibling", async (e) => {
    const w = await world(e);
    const first = await refreshRow(e, w);
    const other = await refreshRow(e, w);
    const child = await refreshRow(e, w, { family: first.family, parent: first.id });
    expect(await ok(e, REFRESH_SIBLINGS_REVOKE_SQL, first.id, first.id, child.hash, first.id)).toBe(
      0,
    );
    expect(other.hash.length).toBe(64);
  });
});

describe("the revoke reasons are one closed list", () => {
  /** The words, as literals: a word added, renamed or dropped is a change to this test. */
  const WORDS = [
    "account_deleted",
    "account_merged",
    "account_revoked",
    "client_disabled",
    "client_revoked",
    "code_replay",
    "compute_suspended",
    "kind_changed",
    "orcid_changed",
    "refresh_reuse",
    "refresh_superseded",
  ];

  test("OIDC_TOKEN_REVOKE_REASONS is exactly these words, and each token-store statement writes one of them", () => {
    expect([...tokenStore.OIDC_TOKEN_REVOKE_REASONS].sort()).toEqual(WORDS);
    const written = new Set<string>();
    // The token store's own statements write theirs as literals.
    for (const [name, value] of Object.entries(tokenStore)) {
      if (!name.endsWith("_SQL") || typeof value !== "string") continue;
      for (const m of value.matchAll(/revoked_reason = '([a-z_]+)'/g)) written.add(m[1] as string);
    }
    expect([...written].sort()).toEqual([
      "client_revoked",
      "code_replay",
      "refresh_reuse",
      "refresh_superseded",
    ]);
  });

  test("the cascades bind a reason of the list: the second statement of an ending, and a client's first", () => {
    // Statement 1 is the token revoke (0 queues the logouts, 2 revokes the grants): its first bind is
    // the reason, and a client's disabling binds `client_disabled`.
    const ending = oidcEndStatements(1, "account_revoked")[1];
    expect(ending?.sql).toMatch(/^UPDATE oidc_tokens/);
    expect(ending?.sql).toMatch(/revoked_reason = \?/);
    expect(ending?.binds).toEqual(["account_revoked", 1]);
    const client = oidcClientEndStatements("oc_000000000000000000000000")[0];
    expect(client?.sql).toMatch(/^UPDATE oidc_tokens/);
    expect(client?.sql).toMatch(/revoked_reason = \?/);
    expect(client?.binds).toEqual(["client_disabled", "oc_000000000000000000000000"]);
  });
});
