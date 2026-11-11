/**
 * Migration 0121_oidc_clients_and_keys.sql (epic #2014 phase #2016; ADR 0119), on two engines:
 * bun:sqlite, which every other suite uses, and Miniflare's D1, the implementation
 * `wrangler --local` runs. bun:sqlite is more permissive than the SQLite D1 ships (a GLOB it calls
 * too complex, a construct it compiles differently), so a CHECK, an index or a trigger proven only
 * on the first is not proven.
 *
 * What is pinned is what the table itself refuses, with the services out of the way, because the
 * database is the last line: a row the service would never write must still not be able to exist.
 *
 *   - `oidc_clients`: the id format and its uniqueness, the bounds of every JSON array, the closed
 *     vocabularies (grants, sign-in rules, consent modes, status), the pairing of the previous
 *     secret and its expiry, the pairing of a disabled client and its `disabled_at`, HTTPS-only
 *     logout addresses, and non-negative caps; no foreign key to `users`;
 *   - `oidc_signing_keys`: the key id format, the one algorithm, the states and the stamps each
 *     state requires, and the two partial unique indexes (one `next`, one `current`, any number
 *     of `retired`).
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { OIDC_MAX_ALLOWED_SCOPES, OIDC_SCOPE_NAMES } from "../../shared/oidc";
import { freshDb } from "./helpers/d1";
import { applyMigrations, migrationFiles } from "./helpers/miniflare-d1";

interface Engine {
  name: string;
  /** Run one statement; the error text when the engine refused it, else null. */
  run(sql: string, ...binds: unknown[]): Promise<string | null>;
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
        sqlite.prepare(sql).run(...(binds as never[]));
        return null;
      } catch (err) {
        return String(err);
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
        await d1
          .prepare(sql)
          .bind(...binds)
          .run();
        return null;
      } catch (err) {
        return String(err);
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

// ---------------------------------------------------------------------------------------------
// oidc_clients
// ---------------------------------------------------------------------------------------------

const HEX64 = "0123456789abcdef".repeat(4);
let clientCounter = 0;

/** A row the table accepts, with any column overridden. A column set to `undefined` is omitted. */
function clientRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  clientCounter += 1;
  const id = `oc_${clientCounter.toString(16).padStart(24, "0")}`;
  return {
    client_id: id,
    name: `A client ${clientCounter}`,
    secret_hash: HEX64,
    redirect_uris: '["https://example.org/cb"]',
    allowed_scopes: '["openid","profile"]',
    allowed_grants: '["authorization_code"]',
    sign_in_rule: "active_account",
    first_party: 0,
    consent_mode: "ask_once",
    audience: "https://api.example.org",
    introspection_audiences: "[]",
    status: "active",
    created_by: 1,
    ...over,
  };
}

async function insertClient(e: Engine, over: Record<string, unknown> = {}) {
  const row = clientRow(over);
  const cols = Object.keys(row).filter((c) => row[c] !== undefined);
  const error = await e.run(
    `INSERT INTO oidc_clients (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    ...cols.map((c) => row[c]),
  );
  return { error, id: row.client_id as string };
}

async function refuses(e: Engine, over: Record<string, unknown>, why: string): Promise<void> {
  const { error, id } = await insertClient(e, over);
  expect(error, why).not.toBeNull();
  const rows = await e.all("SELECT 1 FROM oidc_clients WHERE client_id = ?", id);
  expect(rows, `${why}: the row must not exist`).toHaveLength(0);
}

describe("oidc_clients: a good row, and the id", () => {
  onEveryEngine("accepts a complete row, with the defaults the table supplies", async (e) => {
    const { error, id } = await insertClient(e);
    expect(error).toBeNull();
    const [row] = await e.all<Record<string, unknown>>(
      "SELECT * FROM oidc_clients WHERE client_id = ?",
      id,
    );
    expect(row.status).toBe("active");
    expect(row.disabled_at).toBeNull();
    expect(row.previous_secret_hash).toBeNull();
    expect(row.backchannel_logout_uri).toBeNull();
    expect(row.cap_open_reservations).toBeNull();
    expect(row.cap_su_per_day).toBeNull();
    expect(typeof row.created_at).toBe("string");
    expect(typeof row.updated_at).toBe("string");
    expect(typeof row.id).toBe("number");
  });

  onEveryEngine("the client id is oc_ plus 24 lowercase hex, and unique", async (e) => {
    const ok = await insertClient(e);
    expect(ok.error).toBeNull();
    const dup = await insertClient(e, { client_id: ok.id });
    expect(dup.error).not.toBeNull();
    for (const bad of [
      `oc_${"A".repeat(24)}`,
      `oc_${"0".repeat(23)}`,
      `oc_${"0".repeat(25)}`,
      `ox_${"0".repeat(24)}`,
      `oc_${"g".repeat(24)}`,
      "",
    ]) {
      await refuses(e, { client_id: bad }, `client_id ${JSON.stringify(bad)}`);
    }
  });

  onEveryEngine("the name is 1 to 100 characters", async (e) => {
    expect((await insertClient(e, { name: "x".repeat(100) })).error).toBeNull();
    await refuses(e, { name: "" }, "empty name");
    await refuses(e, { name: "x".repeat(101) }, "a 101-character name");
    await refuses(e, { name: undefined }, "no name");
  });

  onEveryEngine("no foreign key: created_by names no row of users", async (e) => {
    const { error } = await insertClient(e, { created_by: 999_999_999 });
    expect(error).toBeNull();
    await refuses(e, { created_by: 0 }, "created_by 0");
  });
});

describe("oidc_clients: secrets", () => {
  onEveryEngine("a secret hash is 64 lowercase hex characters", async (e) => {
    for (const bad of [
      "",
      "abc",
      HEX64.toUpperCase(),
      `${HEX64}0`,
      HEX64.slice(0, 63),
      "g".repeat(64),
    ]) {
      await refuses(e, { secret_hash: bad }, `secret_hash ${bad.length} chars`);
    }
    await refuses(e, { secret_hash: undefined }, "no secret hash");
  });

  onEveryEngine("the previous secret and its expiry are set together or not at all", async (e) => {
    const ok = await insertClient(e, {
      previous_secret_hash: HEX64,
      previous_secret_expires_at: "2030-01-01 00:00:00",
    });
    expect(ok.error).toBeNull();
    await refuses(e, { previous_secret_hash: HEX64 }, "a previous hash with no expiry");
    await refuses(
      e,
      { previous_secret_expires_at: "2030-01-01 00:00:00" },
      "an expiry with no previous hash",
    );
    await refuses(
      e,
      { previous_secret_hash: "nothex", previous_secret_expires_at: "2030-01-01 00:00:00" },
      "a malformed previous hash",
    );
  });
});

describe("oidc_clients: the JSON columns", () => {
  onEveryEngine("redirect_uris is an array of 1 to 10", async (e) => {
    const ten = JSON.stringify(Array.from({ length: 10 }, (_, i) => `https://e.org/${i}`));
    const eleven = JSON.stringify(Array.from({ length: 11 }, (_, i) => `https://e.org/${i}`));
    expect((await insertClient(e, { redirect_uris: ten })).error).toBeNull();
    await refuses(e, { redirect_uris: eleven }, "11 redirect uris");
    await refuses(e, { redirect_uris: "[]" }, "no redirect uri");
    await refuses(e, { redirect_uris: "not json" }, "text that is not JSON");
    await refuses(e, { redirect_uris: "{}" }, "an object");
    await refuses(e, { redirect_uris: '"https://e.org"' }, "a bare string");
    await refuses(e, { redirect_uris: undefined }, "none");
  });

  onEveryEngine("allowed_scopes is an array of 1 to 20 scope-shaped names", async (e) => {
    expect(
      (
        await insertClient(e, {
          allowed_scopes: '["nemar.account","compute.read","offline_access"]',
        })
      ).error,
    ).toBeNull();
    await refuses(e, { allowed_scopes: "[]" }, "no scope");
    await refuses(e, { allowed_scopes: "not json" }, "not JSON");
    await refuses(e, { allowed_scopes: "{}" }, "an object");
    await refuses(e, { allowed_scopes: '["OpenID"]' }, "an uppercase scope");
    await refuses(e, { allowed_scopes: '["open id"]' }, "a scope with a space");
    await refuses(e, { allowed_scopes: '["a;b"]' }, "a scope with punctuation");
    const atCap = JSON.stringify(
      Array.from({ length: OIDC_MAX_ALLOWED_SCOPES }, (_, i) => `scope${i}`),
    );
    const overCap = JSON.stringify(
      Array.from({ length: OIDC_MAX_ALLOWED_SCOPES + 1 }, (_, i) => `scope${i}`),
    );
    expect((await insertClient(e, { allowed_scopes: atCap })).error).toBeNull();
    await refuses(e, { allowed_scopes: overCap }, "one scope over the cap");
  });

  onEveryEngine("the whole catalogue fits, so a new scope needs no migration", async (e) => {
    expect(OIDC_SCOPE_NAMES.length).toBeLessThanOrEqual(OIDC_MAX_ALLOWED_SCOPES);
    const all = JSON.stringify([...OIDC_SCOPE_NAMES]);
    expect((await insertClient(e, { allowed_scopes: all })).error).toBeNull();
  });

  onEveryEngine(
    "an active client's name is unique, ignoring case; a disabled one frees it",
    async (e) => {
      const first = await insertClient(e, { name: "Unique Portal" });
      expect(first.error).toBeNull();
      await refuses(e, { name: "Unique Portal" }, "the same active name");
      await refuses(e, { name: "UNIQUE portal" }, "the same active name in another case");
      // A disabled client does not hold the name, and two disabled clients may share one.
      expect(
        await e.run(
          "UPDATE oidc_clients SET status = 'disabled', disabled_at = datetime('now') WHERE client_id = ?",
          first.id,
        ),
      ).toBeNull();
      expect((await insertClient(e, { name: "Unique Portal" })).error).toBeNull();
      expect(
        (
          await insertClient(e, {
            name: "Unique Portal",
            status: "disabled",
            disabled_at: "2030-01-01 00:00:00",
          })
        ).error,
      ).toBeNull();
    },
  );

  onEveryEngine("allowed_grants is a subset of the three grants, 1 to 3 of them", async (e) => {
    for (const ok of [
      '["authorization_code"]',
      '["client_credentials"]',
      '["authorization_code","refresh_token"]',
      '["authorization_code","refresh_token","client_credentials"]',
    ]) {
      expect((await insertClient(e, { allowed_grants: ok })).error, ok).toBeNull();
    }
    for (const bad of [
      "[]",
      '["implicit"]',
      '["password"]',
      '["authorization_code","password"]',
      '["authorization_code","refresh_token","client_credentials","implicit"]',
      '["authorization_code","refresh_token","implicit"]',
      "[1]",
      "[null]",
      '{"authorization_code":true}',
      "not json",
    ]) {
      await refuses(e, { allowed_grants: bad }, `allowed_grants ${bad}`);
    }
  });

  onEveryEngine("introspection_audiences is an array of at most 10", async (e) => {
    expect((await insertClient(e, { introspection_audiences: '["a","b"]' })).error).toBeNull();
    const eleven = JSON.stringify(Array.from({ length: 11 }, (_, i) => `aud${i}`));
    await refuses(e, { introspection_audiences: eleven }, "11 audiences");
    await refuses(e, { introspection_audiences: "{}" }, "an object");
    await refuses(e, { introspection_audiences: "not json" }, "not JSON");
  });
});

describe("oidc_clients: the closed words, the logout address, the caps and the status", () => {
  onEveryEngine("sign_in_rule, consent_mode and first_party are closed", async (e) => {
    expect((await insertClient(e, { sign_in_rule: "person_proven_orcid" })).error).toBeNull();
    expect((await insertClient(e, { consent_mode: "always", first_party: 1 })).error).toBeNull();
    await refuses(e, { sign_in_rule: "anyone" }, "an unknown sign-in rule");
    await refuses(e, { sign_in_rule: undefined }, "no sign-in rule");
    await refuses(e, { consent_mode: "never" }, "an unknown consent mode");
    await refuses(e, { first_party: 2 }, "first_party 2");
    await refuses(e, { first_party: "yes" }, "first_party text");
    await refuses(e, { first_party: undefined }, "no first_party");
  });

  onEveryEngine("the audience is 1 to 200 characters", async (e) => {
    expect((await insertClient(e, { audience: "a".repeat(200) })).error).toBeNull();
    await refuses(e, { audience: "" }, "empty audience");
    await refuses(e, { audience: "a".repeat(201) }, "201-character audience");
    await refuses(e, { audience: undefined }, "no audience");
  });

  onEveryEngine("a back-channel logout address is HTTPS or absent", async (e) => {
    expect(
      (await insertClient(e, { backchannel_logout_uri: "https://example.org/logout" })).error,
    ).toBeNull();
    await refuses(e, { backchannel_logout_uri: "http://example.org/logout" }, "http logout");
    await refuses(e, { backchannel_logout_uri: "ftp://example.org/x" }, "ftp logout");
    await refuses(e, { backchannel_logout_uri: "" }, "an empty logout address");
    await refuses(
      e,
      { backchannel_logout_uri: `https://example.org/${"x".repeat(2000)}` },
      "an over-long logout address",
    );
  });

  onEveryEngine("a cap is a non-negative integer or NULL", async (e) => {
    expect(
      (await insertClient(e, { cap_open_reservations: 0, cap_su_per_day: 1000 })).error,
    ).toBeNull();
    await refuses(e, { cap_open_reservations: -1 }, "a negative cap");
    await refuses(e, { cap_su_per_day: -5 }, "a negative day cap");
    await refuses(e, { cap_su_per_day: "lots" }, "a text cap");
    await refuses(e, { cap_open_reservations: 1.5 }, "a fractional cap");
  });

  onEveryEngine("status is active or disabled, and disabled_at says which", async (e) => {
    expect(
      (await insertClient(e, { status: "disabled", disabled_at: "2030-01-01 00:00:00" })).error,
    ).toBeNull();
    await refuses(e, { status: "disabled" }, "disabled with no disabled_at");
    await refuses(e, { disabled_at: "2030-01-01 00:00:00" }, "active with a disabled_at");
    await refuses(e, { status: "suspended" }, "an unknown status");
  });
});

// ---------------------------------------------------------------------------------------------
// oidc_signing_keys
// ---------------------------------------------------------------------------------------------

let keyCounter = 0;
function keyRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  keyCounter += 1;
  return {
    kid: keyCounter.toString(16).padStart(16, "0"),
    alg: "ES256",
    state: "retired",
    public_jwk: '{"kty":"EC","crv":"P-256","x":"x","y":"y"}',
    private_jwk_encrypted: "ciphertext",
    promoted_at: "2030-01-01 00:00:00",
    retired_at: "2030-01-02 00:00:00",
    ...over,
  };
}

async function insertKey(e: Engine, over: Record<string, unknown> = {}) {
  const row = keyRow(over);
  const cols = Object.keys(row).filter((c) => row[c] !== undefined);
  const error = await e.run(
    `INSERT INTO oidc_signing_keys (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    ...cols.map((c) => row[c]),
  );
  return { error, kid: row.kid as string };
}

const NEXT = { state: "next", promoted_at: undefined, retired_at: undefined };
const CURRENT = { state: "current", retired_at: undefined };
const REVOKED = { state: "revoked", revoked_at: "2030-01-03 00:00:00" };

async function clearKeys(e: Engine) {
  expect(await e.run("DELETE FROM oidc_signing_keys")).toBeNull();
}

async function keyRefuses(e: Engine, over: Record<string, unknown>, why: string) {
  const { error, kid } = await insertKey(e, over);
  expect(error, why).not.toBeNull();
  expect(await e.all("SELECT 1 FROM oidc_signing_keys WHERE kid = ?", kid), why).toHaveLength(0);
}

describe("oidc_signing_keys: a row and its columns", () => {
  onEveryEngine(
    "accepts a retired, a current and a next key, with a created_at default",
    async (e) => {
      await clearKeys(e);
      expect((await insertKey(e)).error).toBeNull();
      expect((await insertKey(e, CURRENT)).error).toBeNull();
      const next = await insertKey(e, NEXT);
      expect(next.error).toBeNull();
      const [row] = await e.all<{ created_at: string; promoted_at: string | null }>(
        "SELECT created_at, promoted_at FROM oidc_signing_keys WHERE kid = ?",
        next.kid,
      );
      expect(typeof row.created_at).toBe("string");
      expect(row.promoted_at).toBeNull();
    },
  );

  onEveryEngine("the kid is 16 lowercase hex and is the primary key", async (e) => {
    await clearKeys(e);
    const ok = await insertKey(e);
    expect(ok.error).toBeNull();
    expect((await insertKey(e, { kid: ok.kid })).error).not.toBeNull();
    for (const bad of ["", "0".repeat(15), "0".repeat(17), "A".repeat(16), "g".repeat(16)]) {
      await keyRefuses(e, { kid: bad }, `kid ${JSON.stringify(bad)}`);
    }
  });

  onEveryEngine("the algorithm is ES256 and nothing else", async (e) => {
    await clearKeys(e);
    for (const bad of ["RS256", "none", "es256", ""]) {
      await keyRefuses(e, { alg: bad }, `alg ${JSON.stringify(bad)}`);
    }
  });

  onEveryEngine("the state is next, current, retired or revoked", async (e) => {
    await clearKeys(e);
    expect((await insertKey(e, REVOKED)).error).toBeNull();
    // Stamped like a current key, so the stamp CHECKs pass and only the vocabulary can refuse it.
    await keyRefuses(e, { state: "burned", retired_at: undefined }, "an unknown state");
    await keyRefuses(e, { state: "", retired_at: undefined }, "an empty state");
  });

  onEveryEngine("the public key is JSON and the private key is not empty", async (e) => {
    await clearKeys(e);
    await keyRefuses(e, { public_jwk: "not json" }, "a public key that is not JSON");
    await keyRefuses(e, { public_jwk: "[]" }, "a public key that is an array");
    await keyRefuses(e, { public_jwk: '"x"' }, "a public key that is a string");
    await keyRefuses(e, { private_jwk_encrypted: "" }, "an empty private key");
  });

  onEveryEngine("only a retired or revoked key may have lost its private half", async (e) => {
    await clearKeys(e);
    expect((await insertKey(e, { private_jwk_encrypted: null })).error).toBeNull();
    expect((await insertKey(e, { ...REVOKED, private_jwk_encrypted: null })).error).toBeNull();
    await keyRefuses(
      e,
      { ...CURRENT, private_jwk_encrypted: null },
      "a current key with no private half",
    );
    await keyRefuses(
      e,
      { ...NEXT, private_jwk_encrypted: null },
      "a next key with no private half",
    );
    await keyRefuses(
      e,
      { ...CURRENT, private_jwk_encrypted: undefined },
      "a current key with the column omitted",
    );
    // A key that still has one may not have it empty, whatever its state.
    await keyRefuses(
      e,
      { ...REVOKED, private_jwk_encrypted: "" },
      "a revoked key with an empty private half",
    );
  });

  onEveryEngine("each state carries the stamps it requires and no others", async (e) => {
    await clearKeys(e);
    await keyRefuses(
      e,
      { ...NEXT, promoted_at: "2030-01-01 00:00:00" },
      "a next key that was promoted",
    );
    await keyRefuses(
      e,
      { ...NEXT, retired_at: "2030-01-02 00:00:00" },
      "a next key that was retired",
    );
    await keyRefuses(e, { ...CURRENT, promoted_at: undefined }, "a current key never promoted");
    await keyRefuses(e, { ...CURRENT, retired_at: "2030-01-02 00:00:00" }, "a current key retired");
    await keyRefuses(e, { retired_at: undefined }, "a retired key with no retired_at");
    await keyRefuses(e, { promoted_at: undefined }, "a retired key never promoted");
    // A revoked key was retired first, and says when it was revoked.
    await keyRefuses(e, { ...REVOKED, revoked_at: undefined }, "a revoked key with no revoked_at");
    await keyRefuses(
      e,
      { ...REVOKED, retired_at: undefined },
      "a revoked key that was never retired",
    );
    await keyRefuses(e, { revoked_at: "2030-01-03 00:00:00" }, "a retired key with a revoked_at");
    await keyRefuses(
      e,
      { ...CURRENT, revoked_at: "2030-01-03 00:00:00" },
      "a current key with a revoked_at",
    );
  });
});

describe("oidc_signing_keys: one next, one current, any number retired", () => {
  onEveryEngine("a second next key is refused", async (e) => {
    await clearKeys(e);
    expect((await insertKey(e, NEXT)).error).toBeNull();
    const second = await insertKey(e, NEXT);
    expect(second.error).not.toBeNull();
    expect(await e.all("SELECT 1 FROM oidc_signing_keys WHERE state = 'next'")).toHaveLength(1);
  });

  onEveryEngine("a second current key is refused", async (e) => {
    await clearKeys(e);
    expect((await insertKey(e, CURRENT)).error).toBeNull();
    const second = await insertKey(e, CURRENT);
    expect(second.error).not.toBeNull();
    expect(await e.all("SELECT 1 FROM oidc_signing_keys WHERE state = 'current'")).toHaveLength(1);
  });

  onEveryEngine(
    "retired keys are unlimited, and a next and a current coexist with them",
    async (e) => {
      await clearKeys(e);
      for (let i = 0; i < 5; i++) expect((await insertKey(e)).error).toBeNull();
      expect((await insertKey(e, CURRENT)).error).toBeNull();
      expect((await insertKey(e, NEXT)).error).toBeNull();
      expect(await e.all("SELECT 1 FROM oidc_signing_keys")).toHaveLength(7);
    },
  );

  onEveryEngine("promotion needs the old current out of the way first", async (e) => {
    await clearKeys(e);
    const cur = await insertKey(e, CURRENT);
    const next = await insertKey(e, NEXT);
    // Promoting next while a current exists breaks the index, and changes nothing.
    const early = await e.run(
      "UPDATE oidc_signing_keys SET state = 'current', promoted_at = '2031-01-01 00:00:00' WHERE kid = ?",
      next.kid,
    );
    expect(early).not.toBeNull();
    // Retire first, then promote: the order rotation uses.
    expect(
      await e.run(
        "UPDATE oidc_signing_keys SET state = 'retired', retired_at = '2031-01-01 00:00:00' WHERE kid = ?",
        cur.kid,
      ),
    ).toBeNull();
    expect(
      await e.run(
        "UPDATE oidc_signing_keys SET state = 'current', promoted_at = '2031-01-01 00:00:00' WHERE kid = ?",
        next.kid,
      ),
    ).toBeNull();
  });
});

describe("the migration is applied by both engines, once", () => {
  test("the tables and both partial indexes exist in the catalogue", async () => {
    for (const e of engines) {
      const names = (
        await e.all<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE name LIKE 'oidc_%' ORDER BY name",
        )
      ).map((r) => r.name);
      expect(names, e.name).toContain("oidc_clients");
      expect(names, e.name).toContain("oidc_signing_keys");
      const unique = (
        await e.all<{ sql: string }>(
          "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'oidc_signing_keys' AND sql IS NOT NULL",
        )
      ).map((r) => r.sql);
      expect(
        unique.filter((s) => /UNIQUE/i.test(s) && /WHERE/i.test(s)),
        e.name,
      ).toHaveLength(2);
    }
  });
});
