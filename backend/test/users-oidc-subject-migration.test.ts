/**
 * Migration 0120_users_oidc_subject.sql (epic #2014 phase #2015; ADR 0119, decision 5), on two
 * engines: bun:sqlite, which every other suite uses, and Miniflare's D1, the implementation
 * `wrangler --local` runs. bun:sqlite is more permissive than the SQLite D1 ships (a GLOB that D1
 * calls too complex, a construct it compiles differently), so a CHECK, an index or a trigger
 * proven only on the first is not proven.
 *
 * The scenario is the one a deploy faces: every migration BEFORE 0120 is applied, accounts are
 * seeded at that schema (live rows, a soft-deleted row, the internal system account the migrations
 * themselves create), and only then is 0120 applied. What is pinned:
 *
 *   - the backfill gives EVERY row a subject, tombstones included, each well formed and distinct;
 *   - the format CHECK refuses what the format forbids, and the unique index refuses a duplicate;
 *   - a new row gets a subject without its writer saying so, and two rows never get the same one;
 *   - a subject that is set can be neither changed nor cleared, by any UPDATE that names it;
 *   - the tombstone mask, the one statement that rewrites a person's row on deletion, keeps it.
 */

import type { Database } from "bun:sqlite";
import { Database as SqliteDatabase } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { OIDC_SUBJECT_PREFIX, isOidcSubject } from "../../shared/oidc-subject";
import { USER_TOMBSTONE_MASK_SQL, maskedDeletedEmail } from "../src/db/user-tombstone";
import { MIGRATIONS_DIR, applyMigrations, migrationFiles } from "./helpers/miniflare-d1";

const TARGET = "0120_users_oidc_subject.sql";
const TARGET_SQL = readFileSync(join(MIGRATIONS_DIR, TARGET), "utf-8");

const WELL_FORMED = /^nmu_[0-9a-f]{32}$/;
const KNOWN = "nmu_0123456789abcdef0123456789abcdef";
const OTHER = "nmu_fedcba9876543210fedcba9876543210";

interface Engine {
  name: string;
  /** Run one statement; the error text when the engine refused it, else null. */
  run(sql: string, ...binds: unknown[]): Promise<string | null>;
  all<T>(sql: string, ...binds: unknown[]): Promise<T[]>;
}

/** What the backfill did to the rows seeded before the migration. */
interface Backfill {
  /** `email -> subject` after the migration, for every row that existed before it. */
  subjects: Record<string, string | null>;
  /** How many rows existed before it, the internal system account included. */
  rowCount: number;
}

interface Scenario {
  engine: Engine;
  backfill: Backfill;
}

const SEED_EMAILS = ["live-a@example.org", "live-b@example.org", "live-c@example.org"];
const TOMBSTONE_EMAIL = "deleted+777@deleted.invalid";

const SEED_SQL = `INSERT INTO users (email, status, signup_source, email_verified)
                  VALUES (?, 'verified', 'web', 1)`;
const TOMBSTONE_SQL = `INSERT INTO users (email, status, signup_source, email_verified, deleted_at)
                       VALUES (?, 'revoked', 'web', 0, datetime('now'))`;

const scenarios: Scenario[] = [];
let mf: Miniflare;

/** Every migration before the target, the seed, then the target. Returns what the backfill did. */
async function runScenario(engine: Engine, applyTarget: () => Promise<string | null>) {
  for (const email of SEED_EMAILS) expect(await engine.run(SEED_SQL, email)).toBeNull();
  expect(await engine.run(TOMBSTONE_SQL, TOMBSTONE_EMAIL)).toBeNull();
  const before = await engine.all<{ n: number }>("SELECT COUNT(*) AS n FROM users");
  expect(await applyTarget()).toBeNull();
  const rows = await engine.all<{ email: string; oidc_subject: string | null }>(
    "SELECT email, oidc_subject FROM users",
  );
  return {
    engine,
    backfill: {
      subjects: Object.fromEntries(rows.map((r) => [r.email, r.oidc_subject])),
      rowCount: before[0].n,
    },
  } satisfies Scenario;
}

function preTargetFiles(): string[] {
  return migrationFiles().filter((f) => f < TARGET);
}

beforeAll(async () => {
  // bun:sqlite
  const db: Database = new SqliteDatabase(":memory:");
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql") && f < TARGET)
    .sort()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf-8"));
  }
  const sqlite: Engine = {
    name: "bun:sqlite",
    async run(sql, ...binds) {
      try {
        db.prepare(sql).run(...(binds as never[]));
        return null;
      } catch (err) {
        return String(err);
      }
    },
    async all<T>(sql: string, ...binds: unknown[]) {
      return db.prepare(sql).all(...(binds as never[])) as T[];
    },
  };
  scenarios.push(
    await runScenario(sqlite, async () => {
      try {
        db.exec(TARGET_SQL);
        return null;
      } catch (err) {
        return String(err);
      }
    }),
  );

  // Miniflare D1
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response(null, { status: 204 }); } };",
    compatibilityDate: "2024-12-01",
    d1Databases: ["DB"],
  });
  const d1 = await mf.getD1Database("DB");
  await applyMigrations(d1, preTargetFiles());
  const miniflare: Engine = {
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
  };
  scenarios.push(
    await runScenario(miniflare, async () => {
      try {
        await applyMigrations(d1, [TARGET]);
        return null;
      } catch (err) {
        return String(err);
      }
    }),
  );
}, 120_000);

afterAll(async () => {
  await mf?.dispose();
});

function onEveryEngine(name: string, body: (s: Scenario) => Promise<void>) {
  test(name, async () => {
    expect(scenarios.length).toBe(2);
    for (const s of scenarios) {
      try {
        await body(s);
      } catch (err) {
        throw new Error(`on ${s.engine.name}: ${err instanceof Error ? err.message : err}`);
      }
    }
  });
}

let counter = 0;
/** A live row inserted AFTER the migration, so the insert trigger is what gives it a subject. */
async function insertUser(
  e: Engine,
  subject?: string,
): Promise<{ id: number; error: string | null }> {
  counter += 1;
  const email = `after-${counter}-${Math.random().toString(36).slice(2)}@example.org`;
  const error =
    subject === undefined
      ? await e.run(SEED_SQL, email)
      : await e.run(
          `INSERT INTO users (email, status, signup_source, email_verified, oidc_subject)
           VALUES (?, 'verified', 'web', 1, ?)`,
          email,
          subject,
        );
  const row = (await e.all<{ id: number }>("SELECT id FROM users WHERE email = ?", email))[0];
  return { id: row?.id ?? 0, error };
}

async function subjectOf(e: Engine, id: number): Promise<string | null> {
  return (
    (await e.all<{ s: string | null }>("SELECT oidc_subject AS s FROM users WHERE id = ?", id))[0]
      ?.s ?? null
  );
}

describe("the format helper agrees with the file", () => {
  test("the prefix is nmu_ and a subject is that plus 32 lowercase hex", () => {
    expect(OIDC_SUBJECT_PREFIX).toBe("nmu_");
    expect(isOidcSubject(KNOWN)).toBe(true);
    expect(isOidcSubject(KNOWN.toUpperCase())).toBe(false);
    expect(isOidcSubject(`${KNOWN}0`)).toBe(false);
    expect(isOidcSubject(KNOWN.slice(0, -1))).toBe(false);
    expect(isOidcSubject(`nmx_${KNOWN.slice(4)}`)).toBe(false);
    expect(isOidcSubject(`nmu_${"g".repeat(32)}`)).toBe(false);
    expect(isOidcSubject(null)).toBe(false);
    expect(isOidcSubject(42)).toBe(false);
  });
});

describe("migration 0120: the backfill", () => {
  onEveryEngine(
    "gives every pre-existing row a well-formed subject, tombstones included",
    async (s) => {
      const { subjects, rowCount } = s.backfill;
      // The seed rows, plus whatever the migrations themselves created (the system account).
      expect(rowCount).toBeGreaterThanOrEqual(SEED_EMAILS.length + 1);
      expect(Object.keys(subjects)).toHaveLength(rowCount);
      for (const [email, subject] of Object.entries(subjects)) {
        expect(subject, email).toMatch(WELL_FORMED);
      }
      expect(subjects[TOMBSTONE_EMAIL]).toMatch(WELL_FORMED);
    },
  );

  onEveryEngine("gives every row a different subject", async (s) => {
    const all = Object.values(s.backfill.subjects);
    expect(new Set(all).size).toBe(all.length);
  });

  onEveryEngine("the shape is exactly what the format helper says", async (s) => {
    for (const subject of Object.values(s.backfill.subjects)) {
      expect(isOidcSubject(subject)).toBe(true);
    }
  });
});

describe("migration 0120: the column's own refusals", () => {
  onEveryEngine("an insert with no subject gets one, and no two inserts share one", async (s) => {
    const a = await insertUser(s.engine);
    const b = await insertUser(s.engine);
    expect(a.error).toBeNull();
    expect(b.error).toBeNull();
    const [sa, sb] = [await subjectOf(s.engine, a.id), await subjectOf(s.engine, b.id)];
    expect(sa).toMatch(WELL_FORMED);
    expect(sb).toMatch(WELL_FORMED);
    expect(sa).not.toBe(sb);
  });

  onEveryEngine("an insert that names a well-formed subject keeps it", async (s) => {
    const subject = `nmu_${(counter + 1).toString(16).padStart(32, "a")}`;
    const r = await insertUser(s.engine, subject);
    expect(r.error).toBeNull();
    expect(await subjectOf(s.engine, r.id)).toBe(subject);
  });

  onEveryEngine("a duplicate subject is refused by the unique index", async (s) => {
    const taken = Object.values(s.backfill.subjects)[0] as string;
    const r = await insertUser(s.engine, taken);
    expect(r.error).toContain("UNIQUE constraint failed");
    expect(r.error).toContain("oidc_subject");
    expect(r.id).toBe(0);
  });

  onEveryEngine("the index exists and is unique", async (s) => {
    const rows = await s.engine.all<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_users_oidc_subject'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].sql).toMatch(/UNIQUE/i);
  });

  onEveryEngine("a malformed subject is refused by the format check", async (s) => {
    const malformed = [
      `nmx_${KNOWN.slice(4)}`, // wrong prefix
      KNOWN.slice(4), // no prefix
      KNOWN.toUpperCase(), // uppercase, prefix included
      `nmu_${KNOWN.slice(4).toUpperCase()}`, // uppercase hex
      `${KNOWN}0`, // too long
      KNOWN.slice(0, -1), // too short
      `nmu_${"g".repeat(32)}`, // not hex
      `nmu_${"0123456789abcdef".repeat(2).slice(0, 31)}-`, // a stray character
      "",
      "nmu_",
    ];
    for (const subject of malformed) {
      const r = await insertUser(s.engine, subject);
      expect(r.error, JSON.stringify(subject)).toContain("CHECK constraint failed");
      expect(r.id, JSON.stringify(subject)).toBe(0);
    }
  });
});

describe("migration 0120: a subject that is set never changes", () => {
  onEveryEngine(
    "an UPDATE to another well-formed value aborts and leaves the row alone",
    async (s) => {
      const r = await insertUser(s.engine);
      const before = await subjectOf(s.engine, r.id);
      const error = await s.engine.run(
        "UPDATE users SET oidc_subject = ? WHERE id = ?",
        OTHER,
        r.id,
      );
      expect(error).toContain("never changes");
      expect(await subjectOf(s.engine, r.id)).toBe(before);
    },
  );

  onEveryEngine("an UPDATE to NULL aborts too", async (s) => {
    const r = await insertUser(s.engine);
    const before = await subjectOf(s.engine, r.id);
    const error = await s.engine.run("UPDATE users SET oidc_subject = NULL WHERE id = ?", r.id);
    expect(error).toContain("never changes");
    expect(await subjectOf(s.engine, r.id)).toBe(before);
  });

  onEveryEngine("a backfilled row is held to the same rule", async (s) => {
    const email = SEED_EMAILS[0];
    const before = s.backfill.subjects[email];
    const error = await s.engine.run(
      "UPDATE users SET oidc_subject = ? WHERE email = ?",
      OTHER,
      email,
    );
    expect(error).toContain("never changes");
    expect(
      (
        await s.engine.all<{ s: string }>(
          "SELECT oidc_subject AS s FROM users WHERE email = ?",
          email,
        )
      )[0].s,
    ).toBe(before);
  });

  onEveryEngine(
    "an UPDATE that names the column and changes nothing is not a change",
    async (s) => {
      const r = await insertUser(s.engine);
      const before = await subjectOf(s.engine, r.id);
      const error = await s.engine.run(
        "UPDATE users SET oidc_subject = oidc_subject, city = 'x' WHERE id = ?",
        r.id,
      );
      expect(error).toBeNull();
      expect(await subjectOf(s.engine, r.id)).toBe(before);
    },
  );

  onEveryEngine("an UPDATE of any other column leaves it alone", async (s) => {
    const r = await insertUser(s.engine);
    const before = await subjectOf(s.engine, r.id);
    expect(
      await s.engine.run(
        "UPDATE users SET city = 'Cambridge', affiliation = 'x' WHERE id = ?",
        r.id,
      ),
    ).toBeNull();
    expect(await subjectOf(s.engine, r.id)).toBe(before);
  });

  onEveryEngine("the tombstone mask keeps the subject", async (s) => {
    // The one statement that rewrites a person's row on deletion (db/user-tombstone.ts). It is
    // imported, never copied: a hand-copied mask passes whatever the real one becomes.
    const r = await insertUser(s.engine);
    const before = await subjectOf(s.engine, r.id);
    const error = await s.engine.run(USER_TOMBSTONE_MASK_SQL, maskedDeletedEmail(r.id), r.id);
    expect(error).toBeNull();
    const row = (
      await s.engine.all<{ email: string; deleted_at: string | null; s: string | null }>(
        "SELECT email, deleted_at, oidc_subject AS s FROM users WHERE id = ?",
        r.id,
      )
    )[0];
    expect(row.email).toBe(maskedDeletedEmail(r.id));
    expect(row.deleted_at).not.toBeNull();
    expect(row.s).toBe(before);
    expect(row.s).toMatch(WELL_FORMED);
  });
});
