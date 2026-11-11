/**
 * Migration 0124_oidc_logout_deliveries.sql (epic #2014 phase #2019; ADR 0119 rules 12 and 15), on
 * two engines: bun:sqlite, which every other suite uses, and Miniflare's D1, the implementation
 * `wrangler --local` runs, because bun:sqlite is more permissive than the SQLite D1 ships.
 *
 * Pinned, with the services out of the way:
 *   - a delivery's `reason`, `status`, `last_error_class` and `sub` are closed shapes, and each list the
 *     table's CHECK holds is EQUAL, as a set, to the TypeScript vocabulary (`OIDC_END_REASONS`,
 *     `OIDC_LOGOUT_STATUSES`, `OIDC_LOGOUT_ERROR_CLASSES`): read from the table's own definition, so a
 *     word added to one side only fails here, in either direction;
 *   - `next_attempt_at` is set exactly while a delivery is `pending`, and `sent_at` exactly when it
 *     is `sent`, so a terminal row is never picked up again and a pending row always has a time;
 *   - the attempt count is bounded by `OIDC_LOGOUT_MAX_ATTEMPTS`, the last answer is a real HTTP
 *     status, and `last_error_class` is a fixed word's shape, never free text;
 *   - `jti` is unique where set, so two tokens never share one;
 *   - the indexes the retry tick and the first attempt read by exist, and only over pending rows.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import {
  OIDC_END_REASONS,
  OIDC_LOGOUT_ERROR_CLASSES,
  OIDC_LOGOUT_MAX_ATTEMPTS,
  OIDC_LOGOUT_STATUSES,
} from "../../shared/oidc";
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

const SUB = `nmu_${"a".repeat(32)}`;
const JTI = (n: number) => n.toString(16).padStart(32, "0");

/** Insert a delivery with a column or two overridden; the engine's error text, or null. */
async function insert(
  e: Engine,
  over: Record<string, unknown> = {},
): Promise<{ error: string | null; changes: number }> {
  const row: Record<string, unknown> = {
    client_id: 1,
    sub: SUB,
    reason: "account_revoked",
    status: "pending",
    next_attempt_at: "2030-01-01 00:00:00",
    ...over,
  };
  const columns = Object.keys(row);
  return e.run(
    `INSERT INTO oidc_logout_deliveries (${columns.join(", ")})
     VALUES (${columns.map(() => "?").join(", ")})`,
    ...columns.map((c) => row[c]),
  );
}

describe("oidc_logout_deliveries", () => {
  onEveryEngine(
    "a pending delivery is accepted, with the defaults the sender relies on",
    async (e) => {
      const r = await insert(e);
      expect(r.error).toBeNull();
      const [row] = await e.all<Record<string, unknown>>(
        "SELECT status, attempts, last_status, last_error_class, jti, sent_at FROM oidc_logout_deliveries ORDER BY id DESC LIMIT 1",
      );
      expect(row).toEqual({
        status: "pending",
        attempts: 0,
        last_status: null,
        last_error_class: null,
        jti: null,
        sent_at: null,
      });
      const [created] = await e.all<{ created_at: string }>(
        "SELECT created_at FROM oidc_logout_deliveries ORDER BY id DESC LIMIT 1",
      );
      expect(created?.created_at).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
    },
  );

  /** The words of `<column> IN (...)` in the table's own definition, as the engine stores it. */
  async function checkWords(e: Engine, column: string): Promise<string[]> {
    const [row] = await e.all<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'oidc_logout_deliveries'",
    );
    const lists = [...(row?.sql ?? "").matchAll(new RegExp(`\\b${column} IN \\(([^)]*)\\)`, "g"))];
    // Exactly one `IN` list for the column, so a second one cannot hide an extra word.
    expect(lists.length, `${column} IN (...) lists`).toBe(1);
    return [...(lists[0]?.[1] ?? "").matchAll(/'([^']*)'/g)].map((m) => m[1] as string);
  }

  onEveryEngine(
    "each closed list in the table's CHECKs equals its vocabulary, as a set",
    async (e) => {
      for (const [column, vocabulary] of [
        ["reason", OIDC_END_REASONS],
        ["status", OIDC_LOGOUT_STATUSES],
        ["last_error_class", OIDC_LOGOUT_ERROR_CLASSES],
      ] as const) {
        const words = await checkWords(e, column);
        expect(new Set(words).size, `${column} repeats a word`).toBe(words.length);
        expect([...words].sort(), column).toEqual([...vocabulary].sort());
      }
    },
  );

  onEveryEngine("every reason of the vocabulary is accepted, and no other word", async (e) => {
    for (const reason of OIDC_END_REASONS) {
      expect((await insert(e, { reason })).error).toBeNull();
    }
    for (const reason of ["", "account", "ACCOUNT_REVOKED", "compute_suspended ", "sweep"]) {
      expect((await insert(e, { reason })).error).not.toBeNull();
    }
  });

  onEveryEngine("every status of the vocabulary is accepted, and no other word", async (e) => {
    const shape: Record<string, Record<string, unknown>> = {
      pending: { next_attempt_at: "2030-01-01 00:00:00" },
      sent: { next_attempt_at: null, sent_at: "2030-01-01 00:00:00" },
      failed: { next_attempt_at: null },
      fenced: { next_attempt_at: null },
    };
    for (const status of OIDC_LOGOUT_STATUSES) {
      expect((await insert(e, { status, ...shape[status] })).error).toBeNull();
    }
    expect((await insert(e, { status: "queued", next_attempt_at: null })).error).not.toBeNull();
  });

  onEveryEngine("a subject has the format of users.oidc_subject", async (e) => {
    for (const sub of [
      "",
      SUB.toUpperCase(),
      `nmu_${"a".repeat(31)}`,
      `nmu_${"a".repeat(33)}`,
      `xyz_${"a".repeat(32)}`,
      `nmu_${"g".repeat(32)}`,
    ]) {
      expect((await insert(e, { sub })).error).not.toBeNull();
    }
  });

  onEveryEngine("the client is a row id, an integer of at least 1", async (e) => {
    for (const client_id of [0, -1, "oc_000000000000000000000000", 1.5]) {
      expect((await insert(e, { client_id })).error).not.toBeNull();
    }
  });

  onEveryEngine("next_attempt_at is set exactly while the delivery is pending", async (e) => {
    expect((await insert(e, { status: "pending", next_attempt_at: null })).error).not.toBeNull();
    for (const status of ["failed", "fenced"]) {
      expect(
        (await insert(e, { status, next_attempt_at: "2030-01-01 00:00:00" })).error,
      ).not.toBeNull();
    }
    expect((await insert(e, { next_attempt_at: "tomorrow" })).error).not.toBeNull();
    // `datetime()` writes this form; a JavaScript ISO string compares wrongly against it.
    expect((await insert(e, { next_attempt_at: "2030-01-01T00:00:00.000Z" })).error).not.toBeNull();
  });

  onEveryEngine("sent_at is set exactly when the delivery is sent", async (e) => {
    expect(
      (await insert(e, { status: "sent", next_attempt_at: null, sent_at: null })).error,
    ).not.toBeNull();
    expect(
      (await insert(e, { status: "failed", next_attempt_at: null, sent_at: "2030-01-01 00:00:00" }))
        .error,
    ).not.toBeNull();
  });

  onEveryEngine("attempts are bounded by the retry schedule", async (e) => {
    expect((await insert(e, { attempts: OIDC_LOGOUT_MAX_ATTEMPTS })).error).toBeNull();
    // A numeric string is not tried: INTEGER affinity turns "3" into 3 before the CHECK reads it.
    for (const attempts of [-1, OIDC_LOGOUT_MAX_ATTEMPTS + 1, 1.5, "three"]) {
      expect((await insert(e, { attempts })).error).not.toBeNull();
    }
  });

  onEveryEngine(
    "the last answer is an HTTP status and the error class one of the closed words",
    async (e) => {
      expect((await insert(e, { last_status: 503 })).error).toBeNull();
      for (const last_status of [0, 99, 600, 503.5, "ok"]) {
        expect((await insert(e, { last_status })).error).not.toBeNull();
      }
      for (const word of OIDC_LOGOUT_ERROR_CLASSES) {
        expect((await insert(e, { last_error_class: word })).error).toBeNull();
      }
      // A word of the right SHAPE that is not on the list is refused too: the column is closed.
      for (const bad of [
        "",
        "Timeout",
        "connect ECONNREFUSED 127.0.0.1",
        "a".repeat(41),
        "tls-error",
        "tls_error",
        "http_418",
      ]) {
        expect((await insert(e, { last_error_class: bad })).error).not.toBeNull();
      }
    },
  );

  onEveryEngine("a jti is 32 lowercase hex characters, and unique where set", async (e) => {
    expect((await insert(e, { jti: JTI(7001) })).error).toBeNull();
    expect((await insert(e, { jti: JTI(7001) })).error).not.toBeNull();
    expect((await insert(e, { jti: null })).error).toBeNull();
    expect((await insert(e, { jti: null })).error).toBeNull();
    for (const jti of ["", "A".repeat(32), "a".repeat(31), "g".repeat(32)]) {
      expect((await insert(e, { jti })).error).not.toBeNull();
    }
  });

  onEveryEngine(
    "no foreign key: a delivery outlives the client and the account it names",
    async (e) => {
      // Client row 987654 and the subject exist nowhere, and the insert is still accepted; the
      // sender joins the client it needs and records `client_disabled` for one that is gone.
      expect((await insert(e, { client_id: 987654 })).error).toBeNull();
    },
  );

  onEveryEngine(
    "the indexes the sender reads by exist, and the due one covers only pending rows",
    async (e) => {
      const rows = await e.all<{ name: string; sql: string | null }>(
        "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'oidc_logout_deliveries'",
      );
      const byName = new Map(rows.map((r) => [r.name, r.sql ?? ""]));
      expect(byName.get("oidc_logout_deliveries_due")).toMatch(/WHERE status = 'pending'/);
      expect(byName.get("oidc_logout_deliveries_sub")).toMatch(/WHERE status = 'pending'/);
      expect(byName.has("oidc_logout_deliveries_status")).toBe(true);
      expect(byName.get("oidc_logout_deliveries_jti")).toMatch(/UNIQUE/);
    },
  );
});
