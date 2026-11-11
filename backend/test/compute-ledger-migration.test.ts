/**
 * Migration 0114_compute_ledger.sql (epic #2005 phase A2, #2007; ADR 0118), on two engines:
 * bun:sqlite, which every other suite uses, and Miniflare's D1, the implementation `wrangler
 * --local` runs. bun:sqlite is more permissive than the SQLite D1 ships (a GLOB that D1 calls too
 * complex, a construct it compiles differently), so a CHECK, a trigger or an index proven only on
 * the first is not proven.
 *
 * What is pinned: the words in the file are the words of `shared/compute-state.ts` and
 * `shared/contract/compute.ts`; every CHECK of the three tables refuses its violating row, by name,
 * and accepts its valid one; the ledger and the policy are append-only and a pool is never deleted;
 * the AFTER INSERT trigger is the one writer of a pool's totals (the entry and the totals are one
 * statement, so an entry the totals refuse is not written either); the entry's pool and its budget
 * are checked to exist; a hold closes once and a job has one hold; and the stored totals equal the
 * sums of the ledger after a mixed sequence.
 *
 * The ledger is append-only, so nothing can be cleaned up between tests: every test makes its own
 * account, pools, jobs and keys, and reads only what it made.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMPUTE_WORD_RE, LEDGER_ENTRY_KINDS } from "../../shared/compute-state";
import { COMPUTE_JOB_ID_RE, COMPUTE_POOLS } from "../../shared/contract/compute";
import {
  COMPUTE_PLATFORM_KEYS,
  COMPUTE_POOL_HOLDER_KINDS,
} from "../../shared/contract/compute-admin";
import {
  type MiniflareD1,
  jobId,
  miniflareD1,
  platformPoolId,
  totalsDisagreements,
} from "./helpers/compute-ledger";
import { freshDb, realD1 } from "./helpers/d1";
import { MIGRATIONS_DIR } from "./helpers/miniflare-d1";

const FILE = "0114_compute_ledger.sql";
const SQL = readFileSync(join(MIGRATIONS_DIR, FILE), "utf-8");

type Row = Record<string, unknown>;

interface Engine {
  name: string;
  d1: D1Database;
  run(sql: string, ...binds: unknown[]): Promise<string | null>;
  all<T>(sql: string, ...binds: unknown[]): Promise<T[]>;
}

let seq = 1000;
const next = () => ++seq;
const key = () => `k-${next()}-${Math.random().toString(36).slice(2, 8)}`;

const ENGINES: Engine[] = [];
let mf: MiniflareD1;

beforeAll(async () => {
  const db = freshDb();
  const sqlite = realD1(db);
  ENGINES.push({
    name: "bun:sqlite",
    d1: sqlite,
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
  });
  mf = await miniflareD1();
  ENGINES.push({
    name: "Miniflare D1",
    d1: mf.d1,
    async run(sql, ...binds) {
      try {
        await mf.d1
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
        await mf.d1
          .prepare(sql)
          .bind(...binds)
          .all<T>()
      ).results;
    },
  });
}, 60_000);

afterAll(async () => {
  await mf?.dispose();
}, 30_000);

function onEveryEngine(name: string, body: (e: Engine) => Promise<void>) {
  test(name, async () => {
    expect(ENGINES).toHaveLength(2);
    for (const e of ENGINES) {
      try {
        await body(e);
      } catch (err) {
        throw new Error(`${e.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });
}

async function insertRow(e: Engine, table: string, row: Row): Promise<string | null> {
  const cols = Object.keys(row);
  return e.run(
    `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    ...cols.map((c) => row[c]),
  );
}

/** A new account's pool of one word; the account number is unique per call. */
async function accountPool(
  e: Engine,
  pool: "cpu" | "gpu" = "cpu",
  over: Row = {},
): Promise<number> {
  const ref = String(100000 + next());
  const err = await insertRow(e, "compute_pools", {
    holder_kind: "account",
    holder_ref: ref,
    pool,
    ...over,
  });
  if (err) throw new Error(`could not make a pool: ${err}`);
  const row = (
    await e.all<{ id: number }>(
      "SELECT id FROM compute_pools WHERE holder_kind = 'account' AND holder_ref = ? AND pool = ?",
      ref,
      pool,
    )
  )[0];
  return row?.id ?? 0;
}

async function entry(e: Engine, row: Row): Promise<string | null> {
  return insertRow(e, "compute_ledger", { idempotency_key: key(), ...row });
}

/** What a pool holds. */
async function totals(e: Engine, id: number) {
  const rows = await e.all<{ granted_milli: number; held_milli: number; charged_milli: number }>(
    "SELECT granted_milli, held_milli, charged_milli FROM compute_pools WHERE id = ?",
    id,
  );
  const r = rows[0];
  return [r?.granted_milli, r?.held_milli, r?.charged_milli];
}

/**
 * The platform `people` budget of one word, funded once per engine so that no test is bound by its
 * size: every spend on an account or partner pool is counted against it (the table says so).
 */
const funded = new Set<string>();
async function budgetOf(e: Engine, word: "cpu" | "gpu"): Promise<number> {
  const id = await platformPoolId(e.d1, "people", word);
  const k = `${e.name}:${word}`;
  if (!funded.has(k)) {
    funded.add(k);
    expect(
      await entry(e, { kind: "grant", pool_id: id, granted_delta_milli: 1_000_000_000_000 }),
    ).toBeNull();
  }
  return id;
}

/** The platform pipelines pool of one word, funded once per engine, so a refusal is never for want of balance. */
async function pipelinesOf(e: Engine, word: "cpu" | "gpu"): Promise<number> {
  const id = await platformPoolId(e.d1, "pipelines", word);
  const k = `${e.name}:pipelines:${word}`;
  if (!funded.has(k)) {
    funded.add(k);
    expect(
      await entry(e, { kind: "grant", pool_id: id, granted_delta_milli: 1_000_000_000 }),
    ).toBeNull();
  }
  return id;
}

/** An open hold of `amount` on `pool`, counted against the budget of its word; its job and entry id. */
async function openHold(
  e: Engine,
  pool: number,
  word: "cpu" | "gpu",
  amount = 2000,
): Promise<{ job: string; hold: number }> {
  const job = jobId(next());
  const budget = await budgetOf(e, word);
  expect(
    await entry(e, {
      kind: "hold",
      pool_id: pool,
      budget_pool_id: budget,
      held_delta_milli: amount,
      job_id: job,
    }),
  ).toBeNull();
  const row = (
    await e.all<{ id: number }>(
      "SELECT id FROM compute_ledger WHERE job_id = ? AND kind = 'hold'",
      job,
    )
  )[0];
  return { job, hold: row?.id ?? 0 };
}

/** A pool with 100000 granted, 5000 held and 10000 charged, the last two counted against the budget. */
async function richPool(e: Engine, word: "cpu" | "gpu" = "cpu"): Promise<number> {
  const id = await accountPool(e, word);
  const budget = await budgetOf(e, word);
  expect(await entry(e, { kind: "grant", pool_id: id, granted_delta_milli: 100000 })).toBeNull();
  await openHold(e, id, word, 5000);
  expect(
    await entry(e, {
      kind: "overrun",
      pool_id: id,
      budget_pool_id: budget,
      charged_delta_milli: 10000,
      job_id: jobId(next()),
    }),
  ).toBeNull();
  return id;
}

/** What one case of the ledger tests works on: a rich pool, its budget and one open hold of it. */
interface Ctx {
  pool: number;
  budget: number;
  job: string;
  hold: number;
  pipelines: number;
}

async function ctxFor(e: Engine, word: "cpu" | "gpu" = "cpu"): Promise<Ctx> {
  const pool = await richPool(e, word);
  const { job, hold } = await openHold(e, pool, word);
  return {
    pool,
    budget: await budgetOf(e, word),
    job,
    hold,
    pipelines: await pipelinesOf(e, word),
  };
}

const RANGE = /outside 0 to 9007199254740991/;
const IS_PEOPLE = /platform people pool of the same word/;

const NAMED = (name: string) => new RegExp(`CHECK constraint failed: ${name}\\b`);
const UNIQUE = /UNIQUE constraint failed/;
const APPEND_ONLY = /append-only/;

describe("the file says the shared words", () => {
  test("the kinds are the ledger kinds of shared/compute-state.ts, in its order", () => {
    const m = /CONSTRAINT compute_ledger_kind CHECK \(kind IN\s*\(([^)]*)\)\)/.exec(SQL);
    const words = [...(m?.[1] ?? "").matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]);
    expect(words).toEqual([...LEDGER_ENTRY_KINDS]);
  });

  test("the pool words are the pools of shared/contract/compute.ts", () => {
    const m = /CONSTRAINT compute_pools_pool CHECK \(pool IN \(([^)]*)\)\)/.exec(SQL);
    const words = [...(m?.[1] ?? "").matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]);
    expect(words).toEqual([...COMPUTE_POOLS]);
  });

  test("the holder kinds are COMPUTE_POOL_HOLDER_KINDS, in its order", () => {
    const m = /CONSTRAINT compute_pools_holder_kind CHECK \(\s*holder_kind IN\s*\(([^)]*)\)\)/.exec(
      SQL,
    );
    const words = [...(m?.[1] ?? "").matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]);
    expect(words).toEqual([...COMPUTE_POOL_HOLDER_KINDS]);
  });

  test("the platform pools the file seeds are COMPUTE_PLATFORM_KEYS, each of every pool word", () => {
    const seeded = [...SQL.matchAll(/VALUES \('platform', '([a-z0-9_]+)', '([a-z]+)'\)/g)].map(
      (m) => `${m[1]}/${m[2]}`,
    );
    const expected = COMPUTE_PLATFORM_KEYS.flatMap((k) => COMPUTE_POOLS.map((w) => `${k}/${w}`));
    expect([...seeded].sort()).toEqual([...expected].sort());
  });

  onEveryEngine(
    "the platform pools in the table are COMPUTE_PLATFORM_KEYS, each of every pool word",
    async (e) => {
      const rows = await e.all<{ holder_ref: string; pool: string }>(
        "SELECT holder_ref, pool FROM compute_pools WHERE holder_kind = 'platform'",
      );
      const have = rows.map((r) => `${r.holder_ref}/${r.pool}`).sort();
      const expected = COMPUTE_PLATFORM_KEYS.flatMap((k) => COMPUTE_POOLS.map((w) => `${k}/${w}`));
      expect(have).toEqual([...expected].sort());
    },
  );

  test("no GLOB pattern is longer than D1 takes (50 characters)", () => {
    const patterns = [...SQL.matchAll(/GLOB\s+'([^']*)'/g)].map((m) => m[1] as string);
    expect(patterns.length).toBeGreaterThan(3);
    for (const p of patterns) expect([p, p.length <= 50]).toEqual([p, true]);
  });

  onEveryEngine("a reason takes what COMPUTE_WORD_RE takes", async (e) => {
    const samples = [
      "a",
      "top_up",
      "9lives",
      "A",
      "a-b",
      "a b",
      "",
      "é",
      "a.b",
      "x".repeat(64),
      "x".repeat(65),
    ];
    const pool = await accountPool(e);
    for (const reason of samples) {
      // Only the reason varies; a grant is valid otherwise, so a refusal here is the reason's.
      const err = await entry(e, {
        kind: "grant",
        pool_id: pool,
        granted_delta_milli: 1,
        reason,
      });
      expect([reason, err === null]).toEqual([reason, COMPUTE_WORD_RE.test(reason)]);
    }
  });

  onEveryEngine("a job id takes what COMPUTE_JOB_ID_RE takes", async (e) => {
    const good = jobId(next());
    const samples = [
      good,
      good.toUpperCase(),
      `JOB_${good.slice(4)}`,
      good.slice(0, -1),
      `${good}0`,
      `job_${"g".repeat(24)}`,
      `job-${good.slice(4)}`,
      "",
    ];
    const pool = await richPool(e);
    const budget = await budgetOf(e, "cpu");
    for (const job of samples) {
      const err = await entry(e, {
        kind: "overrun",
        pool_id: pool,
        budget_pool_id: budget,
        charged_delta_milli: 1,
        job_id: job,
      });
      expect([job, err === null]).toEqual([job, COMPUTE_JOB_ID_RE.test(job)]);
    }
  });
});

describe("compute_policy", () => {
  const policy = (over: Row = {}) => ({
    policy_json: '{"a":1}',
    set_by: 7,
    note: "first",
    ...over,
  });

  onEveryEngine(
    "a valid version is accepted, and the highest version is the current one",
    async (e) => {
      expect(await insertRow(e, "compute_policy", policy())).toBeNull();
      expect(
        await insertRow(e, "compute_policy", policy({ policy_json: '{"b":2}', note: null })),
      ).toBeNull();
      const rows = await e.all<{ version: number; policy_json: string; created_at: string }>(
        "SELECT version, policy_json, created_at FROM compute_policy ORDER BY version DESC LIMIT 1",
      );
      expect(rows[0]?.policy_json).toBe('{"b":2}');
      expect(rows[0]?.created_at).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
      const versions = (
        await e.all<{ version: number }>("SELECT version FROM compute_policy ORDER BY version")
      ).map((r) => r.version);
      expect(versions[versions.length - 1]).toBeGreaterThan(versions[0] as number);
    },
  );

  const refused: Array<[string, Row]> = [
    ["text that is not JSON", { policy_json: "{not json" }],
    ["an empty string", { policy_json: "" }],
    ["JSON that is an array", { policy_json: "[]" }],
    ["JSON that is a number", { policy_json: "1" }],
    ["JSON that is null", { policy_json: "null" }],
    ["a document over 64 KiB", { policy_json: `{"a":"${"x".repeat(65536)}"}` }],
    ["no document", { policy_json: null }],
    ["an author of 0", { set_by: 0 }],
    ["no author", { set_by: null }],
    ["an empty note", { note: "" }],
    ["a note of 501 characters", { note: "n".repeat(501) }],
  ];
  for (const [name, over] of refused) {
    onEveryEngine(`${name} is refused`, async (e) => {
      expect(await insertRow(e, "compute_policy", policy(over))).toMatch(
        /CHECK constraint failed|NOT NULL constraint failed/,
      );
    });
  }

  onEveryEngine("a note of 500 characters and a document of 64 KiB are accepted", async (e) => {
    const pad = 65536 - '{"a":""}'.length;
    expect(
      await insertRow(
        e,
        "compute_policy",
        policy({ note: "n".repeat(500), policy_json: `{"a":"${"x".repeat(pad)}"}` }),
      ),
    ).toBeNull();
  });

  onEveryEngine("a version cannot be changed or removed", async (e) => {
    expect(await insertRow(e, "compute_policy", policy())).toBeNull();
    const v = (
      await e.all<{ version: number }>("SELECT MAX(version) AS version FROM compute_policy")
    )[0]?.version;
    expect(await e.run("UPDATE compute_policy SET note = 'changed' WHERE version = ?", v)).toMatch(
      APPEND_ONLY,
    );
    expect(
      await e.run("UPDATE compute_policy SET policy_json = '{}' WHERE version = ?", v),
    ).toMatch(APPEND_ONLY);
    expect(await e.run("DELETE FROM compute_policy WHERE version = ?", v)).toMatch(APPEND_ONLY);
    expect(await e.run("DELETE FROM compute_policy")).toMatch(APPEND_ONLY);
    const kept = await e.all<{ note: string | null }>(
      "SELECT note FROM compute_policy WHERE version = ?",
      v,
    );
    expect(kept[0]?.note).toBe("first");
  });
});

describe("compute_pools", () => {
  onEveryEngine("the four platform pools are seeded", async (e) => {
    const rows = await e.all<{ holder_ref: string; pool: string }>(
      "SELECT holder_ref, pool FROM compute_pools WHERE holder_kind = 'platform' ORDER BY holder_ref, pool",
    );
    expect(rows).toEqual([
      { holder_ref: "people", pool: "cpu" },
      { holder_ref: "people", pool: "gpu" },
      { holder_ref: "pipelines", pool: "cpu" },
      { holder_ref: "pipelines", pool: "gpu" },
    ]);
  });

  onEveryEngine(
    "an account, a partner and a platform pool are accepted, with zero totals",
    async (e) => {
      const n = next();
      for (const row of [
        { holder_kind: "account", holder_ref: String(n), pool: "cpu" },
        { holder_kind: "account", holder_ref: String(n), pool: "gpu" },
        { holder_kind: "partner", holder_ref: `client-${n}.v_2`, pool: "cpu" },
        { holder_kind: "platform", holder_ref: `extra${n}`, pool: "gpu" },
      ]) {
        expect(await insertRow(e, "compute_pools", row)).toBeNull();
      }
      expect(await totals(e, await accountPool(e))).toEqual([0, 0, 0]);
    },
  );

  const base = () => ({ holder_kind: "account", holder_ref: String(500000 + next()), pool: "cpu" });
  const refused: Array<[string, string, Row]> = [
    ["a holder kind outside the three", "compute_pools_holder_kind", { holder_kind: "tenant" }],
    ["an empty holder", "compute_pools_holder_ref", { holder_ref: "" }],
    [
      "a holder of 65 characters",
      "compute_pools_holder_ref",
      { holder_kind: "partner", holder_ref: "p".repeat(65) },
    ],
    [
      "a holder with a space",
      "compute_pools_holder_ref",
      { holder_kind: "partner", holder_ref: "a b" },
    ],
    [
      "a holder with a slash",
      "compute_pools_holder_ref",
      { holder_kind: "partner", holder_ref: "a/b" },
    ],
    ["an account that is not a number", "compute_pools_holder_ref", { holder_ref: "abc" }],
    [
      "an account that starts with a digit and goes on",
      "compute_pools_holder_ref",
      { holder_ref: "1a" },
    ],
    ["an account with a dot", "compute_pools_holder_ref", { holder_ref: "1.5" }],
    ["an account with a leading zero", "compute_pools_holder_ref", { holder_ref: "012" }],
    ["an account of 0", "compute_pools_holder_ref", { holder_ref: "0" }],
    ["a pool outside the two", "compute_pools_pool", { pool: "tpu" }],
    ["a negative grant", "compute_pools_granted", { granted_milli: -1 }],
    ["a negative hold", "compute_pools_held", { held_milli: -1 }],
    ["a negative charge", "compute_pools_charged", { charged_milli: -1 }],
    ["a fractional grant", "compute_pools_granted", { granted_milli: 1.5 }],
    ["a fractional hold", "compute_pools_held", { held_milli: 0.5 }],
    ["a fractional charge", "compute_pools_charged", { charged_milli: 2.25 }],
    ["a grant that is text", "compute_pools_granted", { granted_milli: "lots" }],
    [
      "a grant beyond what a double holds exactly",
      "compute_pools_granted",
      { granted_milli: "9007199254740992" },
    ],
    ["a frozen flag of 2", "compute_pools_frozen", { frozen: 2 }],
  ];
  for (const [name, constraint, over] of refused) {
    onEveryEngine(`${name} is refused`, async (e) => {
      expect(await insertRow(e, "compute_pools", { ...base(), ...over })).toMatch(
        NAMED(constraint),
      );
    });
  }

  onEveryEngine("the same holder and pool twice is refused, the other word is not", async (e) => {
    const row = base();
    expect(await insertRow(e, "compute_pools", row)).toBeNull();
    expect(await insertRow(e, "compute_pools", row)).toMatch(UNIQUE);
    expect(await insertRow(e, "compute_pools", { ...row, pool: "gpu" })).toBeNull();
  });

  onEveryEngine("a pool is never deleted and its identity never changes", async (e) => {
    const id = await accountPool(e);
    expect(await e.run("DELETE FROM compute_pools WHERE id = ?", id)).toMatch(/never deleted/);
    expect(await e.run("UPDATE compute_pools SET pool = 'gpu' WHERE id = ?", id)).toMatch(
      /identity/,
    );
    expect(await e.run("UPDATE compute_pools SET holder_ref = '999' WHERE id = ?", id)).toMatch(
      /identity/,
    );
    expect(
      await e.run("UPDATE compute_pools SET holder_kind = 'partner' WHERE id = ?", id),
    ).toMatch(/identity/);
    expect(await e.run("UPDATE compute_pools SET id = id + 90000000 WHERE id = ?", id)).toMatch(
      /identity/,
    );
    // The flag is the one thing that is not the ledger's, and an operator may set it.
    expect(await e.run("UPDATE compute_pools SET frozen = 1 WHERE id = ?", id)).toBeNull();
    expect(await e.run("UPDATE compute_pools SET frozen = 0 WHERE id = ?", id)).toBeNull();
  });
});

describe("compute_ledger: what each kind may carry", () => {
  type Over = Row | ((c: Ctx) => Row);

  /** A valid entry of each kind on the context's pool, laid over with `over`. */
  function valid(kind: string, c: Ctx, over: Row = {}): Row {
    const other = jobId(next());
    const base: Record<string, Row> = {
      grant: { granted_delta_milli: 5000 },
      hold: { held_delta_milli: 2000, job_id: other, budget_pool_id: c.budget },
      release: {
        held_delta_milli: -2000,
        job_id: c.job,
        hold_ref: c.hold,
        budget_pool_id: c.budget,
      },
      charge: {
        held_delta_milli: -2000,
        charged_delta_milli: 1500,
        job_id: c.job,
        hold_ref: c.hold,
        budget_pool_id: c.budget,
      },
      refund: { charged_delta_milli: -500, job_id: other, budget_pool_id: c.budget },
      adjust: { charged_delta_milli: 100, budget_pool_id: c.budget },
      overrun: { charged_delta_milli: 300, job_id: other, budget_pool_id: c.budget },
      expire: { granted_delta_milli: -100 },
    };
    return { kind, pool_id: c.pool, ...base[kind], ...over };
  }

  onEveryEngine("a valid entry of every kind is accepted", async (e) => {
    for (const kind of LEDGER_ENTRY_KINDS) {
      const c = await ctxFor(e);
      expect([kind, await entry(e, valid(kind, c))]).toEqual([kind, null]);
    }
    // Both ways of an adjustment, an adjustment of the grant, and a job's final settlement, which
    // may be of nothing (the key `job:<id>:final` is what records that it happened).
    const c = await ctxFor(e);
    expect(await entry(e, valid("adjust", c, { charged_delta_milli: -100 }))).toBeNull();
    expect(
      await entry(
        e,
        valid("adjust", c, {
          charged_delta_milli: 0,
          granted_delta_milli: 100,
          budget_pool_id: null,
        }),
      ),
    ).toBeNull();
    expect(
      await entry(
        e,
        valid("adjust", c, {
          charged_delta_milli: 0,
          granted_delta_milli: -100,
          budget_pool_id: null,
        }),
      ),
    ).toBeNull();
    for (const delta of [0, 250, -250]) {
      expect([
        delta,
        await entry(e, valid("adjust", c, { charged_delta_milli: delta, job_id: c.job })),
      ]).toEqual([delta, null]);
    }
    expect(await totalsDisagreements(e.d1)).toEqual([]);
  });

  const D = "compute_ledger_deltas";
  const CLOSES = /closes the hold it names/;
  const BEYOND = /compute_ledger_(granted|charged)_int|outside 0 to 9007199254740991/;
  // The refusals below name the constraint that refused them. Where a trigger runs first (SQLite
  // runs BEFORE triggers ahead of the CHECKs), the trigger's own words are the expectation, and
  // the CHECK behind it is the second layer for the same row.
  const cases: Array<[string, string, Over, string | RegExp]> = [
    ["a grant that holds", "grant", { held_delta_milli: 1 }, D],
    ["a grant of nothing", "grant", { granted_delta_milli: 0 }, D],
    ["a grant that takes away", "grant", { granted_delta_milli: -1 }, D],
    ["a grant that charges", "grant", { charged_delta_milli: 1 }, D],
    ["a hold that grants", "hold", { granted_delta_milli: 1 }, D],
    ["a hold of nothing", "hold", { held_delta_milli: 0 }, D],
    ["a hold that gives back", "hold", { held_delta_milli: -1 }, D],
    ["a hold that charges", "hold", { charged_delta_milli: 1 }, D],
    ["a release that holds", "release", { held_delta_milli: 1 }, CLOSES],
    ["a release of nothing", "release", { held_delta_milli: 0 }, CLOSES],
    ["a release that charges", "release", { charged_delta_milli: 1 }, D],
    ["a release that grants", "release", { granted_delta_milli: 1 }, D],
    ["a charge that holds more", "charge", { held_delta_milli: 1 }, CLOSES],
    ["a charge that refunds", "charge", { charged_delta_milli: -1 }, D],
    ["a charge that grants", "charge", { granted_delta_milli: 1 }, D],
    ["a refund of nothing", "refund", { charged_delta_milli: 0 }, D],
    ["a refund that charges", "refund", { charged_delta_milli: 1 }, D],
    ["a refund that holds", "refund", { held_delta_milli: 1 }, D],
    ["a refund that grants", "refund", { granted_delta_milli: 1 }, D],
    ["an adjustment of nothing", "adjust", { charged_delta_milli: 0 }, D],
    [
      "an adjustment of both the grant and the charge",
      "adjust",
      { granted_delta_milli: 1, charged_delta_milli: 1 },
      D,
    ],
    ["an adjustment that holds", "adjust", { held_delta_milli: 1 }, D],
    [
      "a job's adjustment of the grant",
      "adjust",
      (c) => ({ granted_delta_milli: 1, charged_delta_milli: 0, job_id: c.job }),
      D,
    ],
    [
      "a job's adjustment of the grant and the charge",
      "adjust",
      (c) => ({ granted_delta_milli: 1, charged_delta_milli: 5, job_id: c.job }),
      D,
    ],
    ["an overrun of nothing", "overrun", { charged_delta_milli: 0 }, D],
    ["an overrun that refunds", "overrun", { charged_delta_milli: -1 }, D],
    ["an overrun that holds", "overrun", { held_delta_milli: 1 }, D],
    ["an overrun that grants", "overrun", { granted_delta_milli: 1 }, D],
    ["an expiry of nothing", "expire", { granted_delta_milli: 0 }, D],
    ["an expiry that grants", "expire", { granted_delta_milli: 1 }, D],
    ["an expiry that holds", "expire", { held_delta_milli: 1 }, D],
    ["an expiry that charges", "expire", { charged_delta_milli: 1 }, D],
    ["a kind outside the eight", "close", {}, "compute_ledger_kind"],
    ["a hold with no job", "hold", { job_id: null }, "compute_ledger_job_required"],
    ["a release with no job", "release", { job_id: null }, CLOSES],
    ["a charge with no job", "charge", { job_id: null }, CLOSES],
    ["a refund with no job", "refund", { job_id: null }, "compute_ledger_job_required"],
    ["an overrun with no job", "overrun", { job_id: null }, "compute_ledger_job_required"],
    ["a release with no hold", "release", { hold_ref: null }, CLOSES],
    ["a charge with no hold", "charge", { hold_ref: null }, CLOSES],
    [
      "a grant that names a hold",
      "grant",
      (c) => ({ hold_ref: c.hold }),
      "compute_ledger_hold_ref_kinds",
    ],
    [
      "a hold that names a hold",
      "hold",
      (c) => ({ hold_ref: c.hold }),
      "compute_ledger_hold_ref_kinds",
    ],
    [
      "a refund that names a hold",
      "refund",
      (c) => ({ hold_ref: c.hold }),
      "compute_ledger_hold_ref_kinds",
    ],
    [
      "an adjustment that names a hold",
      "adjust",
      (c) => ({ hold_ref: c.hold }),
      "compute_ledger_hold_ref_kinds",
    ],
    [
      "an expiry that names a hold",
      "expire",
      (c) => ({ hold_ref: c.hold }),
      "compute_ledger_hold_ref_kinds",
    ],
    ["a hold reference of 0", "overrun", { hold_ref: 0 }, "compute_ledger_hold_ref"],
    [
      "a budget on a grant",
      "grant",
      (c) => ({ budget_pool_id: c.budget }),
      "compute_ledger_budget_kinds",
    ],
    [
      "a budget on an expiry",
      "expire",
      (c) => ({ budget_pool_id: c.budget }),
      "compute_ledger_budget_kinds",
    ],
    [
      "a budget on an adjustment of the grant",
      "adjust",
      (c) => ({ charged_delta_milli: 0, granted_delta_milli: 1, budget_pool_id: c.budget }),
      "compute_ledger_budget_kinds",
    ],
    ["a fractional grant", "grant", { granted_delta_milli: 1.5 }, "compute_ledger_granted_int"],
    ["a fractional hold", "hold", { held_delta_milli: 0.5 }, "compute_ledger_held_int"],
    ["a fractional charge", "overrun", { charged_delta_milli: 2.5 }, "compute_ledger_charged_int"],
    [
      "a grant that is text",
      "grant",
      { granted_delta_milli: "lots" },
      "compute_ledger_granted_int",
    ],
    [
      "a grant beyond what a double holds exactly",
      "grant",
      { granted_delta_milli: "9007199254740992" },
      BEYOND,
    ],
    [
      "a charge beyond what a double holds exactly",
      "overrun",
      { charged_delta_milli: "9007199254740992" },
      BEYOND,
    ],
    ["a job id in capitals", "hold", { job_id: `job_${"A".repeat(24)}` }, "compute_ledger_job_id"],
    ["a job id one short", "hold", { job_id: `job_${"a".repeat(23)}` }, "compute_ledger_job_id"],
    ["a reason in capitals", "grant", { reason: "Top_Up" }, "compute_ledger_reason"],
    ["an empty reason", "grant", { reason: "" }, "compute_ledger_reason"],
    ["a reason with a hyphen", "grant", { reason: "top-up" }, "compute_ledger_reason"],
    ["a reason of 65 characters", "grant", { reason: "r".repeat(65) }, "compute_ledger_reason"],
    ["an actor of 0", "grant", { actor_user_id: 0 }, "compute_ledger_actor"],
    ["an empty key", "grant", { idempotency_key: "" }, "compute_ledger_key"],
    ["a key with a space", "grant", { idempotency_key: "a b" }, "compute_ledger_key"],
    ["a key with a slash", "grant", { idempotency_key: "a/b" }, "compute_ledger_key"],
    [
      "a key of 129 characters",
      "grant",
      { idempotency_key: "k".repeat(129) },
      "compute_ledger_key",
    ],
  ];
  for (const [name, kind, over, expected] of cases) {
    onEveryEngine(`${name} is refused`, async (e) => {
      const c = await ctxFor(e);
      const extra = typeof over === "function" ? over(c) : over;
      expect(await entry(e, valid(kind, c, extra))).toMatch(
        typeof expected === "string" ? NAMED(expected) : expected,
      );
    });
  }

  onEveryEngine("a reason, an actor and a key at their limits are accepted", async (e) => {
    const pool = await accountPool(e);
    expect(
      await entry(e, {
        kind: "grant",
        pool_id: pool,
        granted_delta_milli: 9007199254740991,
        reason: "r".repeat(64),
        actor_user_id: 1,
        idempotency_key: `a${"k".repeat(126)}z`,
      }),
    ).toBeNull();
    expect(await totals(e, pool)).toEqual([9007199254740991, 0, 0]);
    expect(
      await entry(e, {
        kind: "grant",
        pool_id: await accountPool(e),
        granted_delta_milli: 1,
        idempotency_key: "grant:Ab9._:-x",
      }),
    ).toBeNull();
  });

  onEveryEngine(
    "a total beyond what a double holds exactly is refused, with its entry",
    async (e) => {
      const pool = await accountPool(e);
      const big = { kind: "grant", pool_id: pool, granted_delta_milli: 9007199254740991 };
      expect(await entry(e, big)).toBeNull();
      expect(await entry(e, { kind: "grant", pool_id: pool, granted_delta_milli: 1 })).toMatch(
        RANGE,
      );
      expect(
        (
          await e.all<{ n: number }>(
            "SELECT COUNT(*) AS n FROM compute_ledger WHERE pool_id = ?",
            pool,
          )
        )[0]?.n,
      ).toBe(1);
      expect(await totals(e, pool)).toEqual([9007199254740991, 0, 0]);
    },
  );
});

describe("compute_ledger: the budget an entry names", () => {
  const NAMES_BUDGET = /names the platform people budget/;
  const CLOSES = /closes the hold it names/;

  onEveryEngine(
    "a spend on an account pool names the people budget of its word, and no other",
    async (e) => {
      const c = await ctxFor(e);
      const hold = (over: Row) =>
        entry(e, {
          kind: "hold",
          pool_id: c.pool,
          held_delta_milli: 1,
          job_id: jobId(next()),
          budget_pool_id: c.budget,
          ...over,
        });
      const before = await totals(e, c.pool);
      expect(await hold({ budget_pool_id: null })).toMatch(NAMES_BUDGET);
      expect(await hold({ budget_pool_id: c.pipelines })).toMatch(IS_PEOPLE);
      expect(await hold({ budget_pool_id: await budgetOf(e, "gpu") })).toMatch(IS_PEOPLE);
      const acct = await accountPool(e, "cpu");
      expect(
        await entry(e, { kind: "grant", pool_id: acct, granted_delta_milli: 1000 }),
      ).toBeNull();
      expect(await hold({ budget_pool_id: acct })).toMatch(IS_PEOPLE);
      expect(await hold({ budget_pool_id: 90000000 + next() })).toMatch(IS_PEOPLE);
      expect(await totals(e, c.pool)).toEqual(before);
      expect(await hold({})).toBeNull();
    },
  );

  onEveryEngine(
    "a platform pool names no budget, itself and the people budget included",
    async (e) => {
      const pipelines = await platformPoolId(e.d1, "pipelines", "gpu");
      expect(
        await entry(e, { kind: "grant", pool_id: pipelines, granted_delta_milli: 50000 }),
      ).toBeNull();
      const hold = (over: Row) =>
        entry(e, {
          kind: "hold",
          pool_id: pipelines,
          held_delta_milli: 1,
          job_id: jobId(next()),
          ...over,
        });
      expect(await hold({ budget_pool_id: await budgetOf(e, "gpu") })).toMatch(IS_PEOPLE);
      expect(await hold({ budget_pool_id: pipelines })).toMatch(IS_PEOPLE);
      expect(await hold({ budget_pool_id: await platformPoolId(e.d1, "people", "cpu") })).toMatch(
        IS_PEOPLE,
      );
      expect(await hold({})).toBeNull();
    },
  );

  onEveryEngine("a partner pool is held to the same rule as an account's", async (e) => {
    const ref = `client-${next()}`;
    expect(
      await insertRow(e, "compute_pools", { holder_kind: "partner", holder_ref: ref, pool: "cpu" }),
    ).toBeNull();
    const partner = (
      await e.all<{ id: number }>("SELECT id FROM compute_pools WHERE holder_ref = ?", ref)
    )[0]?.id as number;
    const budget = await budgetOf(e, "cpu");
    expect(
      await entry(e, { kind: "grant", pool_id: partner, granted_delta_milli: 10000 }),
    ).toBeNull();
    const hold = (over: Row) =>
      entry(e, {
        kind: "hold",
        pool_id: partner,
        held_delta_milli: 1,
        job_id: jobId(next()),
        budget_pool_id: budget,
        ...over,
      });
    expect(await hold({ budget_pool_id: null })).toMatch(NAMES_BUDGET);
    expect(await hold({ budget_pool_id: await pipelinesOf(e, "cpu") })).toMatch(IS_PEOPLE);
    // A partner pool that is merely CALLED people is not the platform's people budget.
    expect(
      await insertRow(e, "compute_pools", {
        holder_kind: "partner",
        holder_ref: "people",
        pool: "cpu",
      }),
    ).toBeNull();
    const namesake = (
      await e.all<{ id: number }>(
        "SELECT id FROM compute_pools WHERE holder_kind = 'partner' AND holder_ref = 'people' AND pool = 'cpu'",
      )
    )[0]?.id as number;
    expect(
      await entry(e, { kind: "grant", pool_id: namesake, granted_delta_milli: 1000 }),
    ).toBeNull();
    expect(await hold({ budget_pool_id: namesake })).toMatch(IS_PEOPLE);
    expect(await hold({})).toBeNull();
  });

  onEveryEngine(
    "a hold, a release, a charge, an overrun and a job's final settlement name the budget",
    async (e) => {
      const c = await ctxFor(e);
      const without = { budget_pool_id: null };
      const spending: Array<[string, Row, RegExp]> = [
        ["hold", { kind: "hold", held_delta_milli: 1, job_id: jobId(next()) }, NAMES_BUDGET],
        [
          "overrun",
          { kind: "overrun", charged_delta_milli: 1, job_id: jobId(next()) },
          NAMES_BUDGET,
        ],
        [
          "a job's final settlement of nothing",
          { kind: "adjust", charged_delta_milli: 0, job_id: c.job },
          NAMES_BUDGET,
        ],
        [
          "a job's final settlement upward",
          { kind: "adjust", charged_delta_milli: 1, job_id: c.job },
          NAMES_BUDGET,
        ],
        [
          "a job's final settlement downward",
          { kind: "adjust", charged_delta_milli: -1, job_id: c.job },
          NAMES_BUDGET,
        ],
        [
          "release",
          { kind: "release", held_delta_milli: -2000, job_id: c.job, hold_ref: c.hold },
          new RegExp(`${NAMES_BUDGET.source}|${CLOSES.source}`),
        ],
        [
          "charge",
          {
            kind: "charge",
            held_delta_milli: -2000,
            charged_delta_milli: 1,
            job_id: c.job,
            hold_ref: c.hold,
          },
          new RegExp(`${NAMES_BUDGET.source}|${CLOSES.source}`),
        ],
      ];
      const before = [await totals(e, c.pool), await totals(e, c.budget)];
      for (const [name, row, expected] of spending) {
        expect([name, await entry(e, { pool_id: c.pool, ...row, ...without })]).toEqual([
          name,
          expect.stringMatching(expected),
        ]);
      }
      expect([await totals(e, c.pool), await totals(e, c.budget)]).toEqual(before);
      // Every one of them is accepted when it names the budget (the two that close a hold are the
      // ones a hold of another job is not needed for: the entry itself is the same shape).
      expect(
        await entry(e, {
          pool_id: c.pool,
          kind: "overrun",
          charged_delta_milli: 1,
          job_id: jobId(next()),
          budget_pool_id: c.budget,
        }),
      ).toBeNull();
      expect(
        await entry(e, {
          pool_id: c.pool,
          kind: "adjust",
          charged_delta_milli: 0,
          job_id: jobId(next()),
          budget_pool_id: c.budget,
        }),
      ).toBeNull();
    },
  );

  onEveryEngine(
    "a refund and a correction of a charge may name the people budget or none, and the table does not choose",
    async (e) => {
      const c = await ctxFor(e);
      const cases: Array<[string, () => Row]> = [
        ["a refund", () => ({ kind: "refund", charged_delta_milli: -1, job_id: jobId(next()) })],
        ["a correction downward", () => ({ kind: "adjust", charged_delta_milli: -1 })],
        ["a correction upward", () => ({ kind: "adjust", charged_delta_milli: 1 })],
      ];
      for (const [name, row] of cases) {
        const delta = Number(row().charged_delta_milli);
        // Naming the people budget credits it (or charges it); naming none moves the pool alone. The
        // table takes both; the service's rule (option A: a lowering never names it) is the budget file's.
        const named = [await totals(e, c.pool), await totals(e, c.budget)];
        expect(
          [name, await entry(e, { pool_id: c.pool, ...row(), budget_pool_id: c.budget })],
          `${name} naming the budget`,
        ).toEqual([name, null]);
        expect([await totals(e, c.pool), await totals(e, c.budget)]).toEqual([
          [named[0]?.[0], named[0]?.[1], Number(named[0]?.[2]) + delta],
          [named[1]?.[0], named[1]?.[1], Number(named[1]?.[2]) + delta],
        ]);
        const none = [await totals(e, c.pool), await totals(e, c.budget)];
        expect(
          [name, await entry(e, { pool_id: c.pool, ...row(), budget_pool_id: null })],
          `${name} naming none`,
        ).toEqual([name, null]);
        expect([await totals(e, c.pool), await totals(e, c.budget)]).toEqual([
          [none[0]?.[0], none[0]?.[1], Number(none[0]?.[2]) + delta],
          none[1],
        ]);
        // A budget that is named is still the people budget of the same word, and no other. A
        // credit to a budget that was never charged is also out of range, and which trigger answers
        // first is SQLite's; the upward correction has no such second reason.
        const refused = delta < 0 ? new RegExp(`${IS_PEOPLE.source}|${RANGE.source}`) : IS_PEOPLE;
        for (const wrong of [c.pipelines, await budgetOf(e, "gpu"), 90000000 + next()]) {
          expect(
            [name, await entry(e, { pool_id: c.pool, ...row(), budget_pool_id: wrong })],
            `${name} naming another budget`,
          ).toEqual([name, expect.stringMatching(refused)]);
        }
      }
    },
  );

  onEveryEngine("a grant, an expiry and an adjustment of the grant name no budget", async (e) => {
    const c = await ctxFor(e);
    expect(await entry(e, { kind: "grant", pool_id: c.pool, granted_delta_milli: 1 })).toBeNull();
    expect(await entry(e, { kind: "expire", pool_id: c.pool, granted_delta_milli: -1 })).toBeNull();
    expect(await entry(e, { kind: "adjust", pool_id: c.pool, granted_delta_milli: 1 })).toBeNull();
    for (const row of [
      { kind: "grant", granted_delta_milli: 1 },
      { kind: "expire", granted_delta_milli: -1 },
      { kind: "adjust", granted_delta_milli: 1 },
    ]) {
      expect(
        await entry(e, { pool_id: c.pool, ...row, budget_pool_id: c.budget }),
        `${row.kind} naming a budget`,
      ).toMatch(/CHECK constraint failed: compute_ledger_budget_kinds/);
    }
  });

  onEveryEngine("an entry for a pool that does not exist is refused", async (e) => {
    for (const id of [90000000 + next(), 0, -1]) {
      expect(await entry(e, { kind: "grant", pool_id: id, granted_delta_milli: 1 })).toMatch(
        /names a pool that exists/,
      );
    }
  });
});

describe("compute_ledger: the table refuses what the statement refuses", () => {
  const VERBS = ["INSERT", "INSERT OR IGNORE", "INSERT OR FAIL", "INSERT OR REPLACE"];
  const RANGE_OR_FITS = /outside 0 to 9007199254740991|available below zero/;

  async function insertWith(e: Engine, verb: string, row: Row): Promise<string | null> {
    const cols = Object.keys(row);
    return e.run(
      `${verb} INTO compute_ledger (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
      ...cols.map((c) => row[c]),
    );
  }

  const written = async (e: Engine, k: string) =>
    (
      await e.all<{ n: number }>(
        "SELECT COUNT(*) AS n FROM compute_ledger WHERE idempotency_key = ?",
        k,
      )
    )[0]?.n;

  onEveryEngine(
    "an entry that would take a total outside 0 to 2^53-1 is refused under every conflict clause, and writes nothing",
    async (e) => {
      for (const verb of VERBS) {
        const c = await ctxFor(e);
        const refusals: Array<[string, Row]> = [
          [
            "a refund of more than was charged",
            {
              kind: "refund",
              charged_delta_milli: -10001,
              job_id: jobId(next()),
              budget_pool_id: c.budget,
            },
          ],
          ["an expiry of more than was granted", { kind: "expire", granted_delta_milli: -100001 }],
          [
            "an adjustment of the grant below zero",
            { kind: "adjust", granted_delta_milli: -100001 },
          ],
          [
            "an adjustment of the charge below zero",
            { kind: "adjust", charged_delta_milli: -10001, budget_pool_id: c.budget },
          ],
          ["a grant above 2^53-1", { kind: "grant", granted_delta_milli: 9007199254740991 }],
          [
            "a charge above 2^53-1",
            {
              kind: "overrun",
              charged_delta_milli: 9007199254740991,
              job_id: jobId(next()),
              budget_pool_id: c.budget,
            },
          ],
        ];
        for (const [name, row] of refusals) {
          const k = key();
          const before = await totals(e, c.pool);
          const err = await insertWith(e, verb, { pool_id: c.pool, idempotency_key: k, ...row });
          expect([verb, name, err]).toEqual([verb, name, expect.stringMatching(RANGE_OR_FITS)]);
          expect([verb, name, await written(e, k)]).toEqual([verb, name, 0]);
          expect(await totals(e, c.pool)).toEqual(before);
        }
      }
      expect(await totalsDisagreements(e.d1)).toEqual([]);
    },
  );

  onEveryEngine(
    "a release the pool could not take is refused too (it names no hold that fits)",
    async (e) => {
      for (const verb of VERBS) {
        const c = await ctxFor(e);
        const k = key();
        const err = await insertWith(e, verb, {
          kind: "release",
          pool_id: c.pool,
          held_delta_milli: -5000000,
          job_id: c.job,
          hold_ref: c.hold,
          budget_pool_id: c.budget,
          idempotency_key: k,
        });
        expect([verb, err]).toEqual([
          verb,
          expect.stringMatching(/closes the hold it names|outside 0 to/),
        ]);
        expect(await written(e, k)).toBe(0);
      }
    },
  );

  onEveryEngine("the budget's totals are held to the same range", async (e) => {
    for (const verb of VERBS) {
      const c = await ctxFor(e);
      const [, , budgetCharged] = (await totals(e, c.budget)) as number[];
      // The person could take it; the budget could not: one statement, so neither is written.
      const k = key();
      const before = await totals(e, c.pool);
      const beforeBudget = await totals(e, c.budget);
      const err = await insertWith(e, verb, {
        kind: "adjust",
        pool_id: c.pool,
        budget_pool_id: c.budget,
        charged_delta_milli: 9007199254740991 - (budgetCharged as number) + 1,
        idempotency_key: k,
      });
      expect([verb, err]).toEqual([verb, expect.stringMatching(RANGE)]);
      expect(await written(e, k)).toBe(0);
      expect(await totals(e, c.pool)).toEqual(before);
      expect(await totals(e, c.budget)).toEqual(beforeBudget);
    }
  });

  onEveryEngine("a budget that holds less charge than the refund is refused", async (e) => {
    // The people gpu budget is corrected down by the owner, so the person holds more than it does.
    const person = await accountPool(e, "gpu");
    const budget = await budgetOf(e, "gpu");
    expect(
      await entry(e, { kind: "grant", pool_id: person, granted_delta_milli: 10000 }),
    ).toBeNull();
    expect(
      await entry(e, {
        kind: "adjust",
        pool_id: person,
        budget_pool_id: budget,
        charged_delta_milli: 500,
      }),
    ).toBeNull();
    const [, , charged] = (await totals(e, budget)) as number[];
    expect(
      await entry(e, {
        kind: "adjust",
        pool_id: budget,
        charged_delta_milli: -(charged as number),
      }),
    ).toBeNull();
    for (const verb of VERBS) {
      const k = key();
      const err = await insertWith(e, verb, {
        kind: "refund",
        pool_id: person,
        budget_pool_id: budget,
        charged_delta_milli: -500,
        job_id: jobId(next()),
        idempotency_key: k,
      });
      expect([verb, err]).toEqual([verb, expect.stringMatching(RANGE)]);
      expect(await written(e, k)).toBe(0);
    }
    expect(await totals(e, person)).toEqual([10000, 0, 500]);
    expect(await totalsDisagreements(e.d1)).toEqual([]);
  });

  onEveryEngine(
    "a hold that would take available below zero is refused under every conflict clause",
    async (e) => {
      for (const verb of VERBS) {
        const c = await ctxFor(e);
        const [granted, held, charged] = (await totals(e, c.pool)) as number[];
        const available = (granted as number) - (held as number) - (charged as number);
        const k = key();
        const err = await insertWith(e, verb, {
          kind: "hold",
          pool_id: c.pool,
          budget_pool_id: c.budget,
          held_delta_milli: available + 1,
          job_id: jobId(next()),
          idempotency_key: k,
        });
        expect([verb, err]).toEqual([verb, expect.stringMatching(/available below zero/)]);
        expect(await written(e, k)).toBe(0);
        // Exactly the available is a hold.
        const fits = await insertWith(e, verb, {
          kind: "hold",
          pool_id: c.pool,
          budget_pool_id: c.budget,
          held_delta_milli: available,
          job_id: jobId(next()),
          idempotency_key: key(),
        });
        expect([verb, fits]).toEqual([verb, null]);
      }
      expect(await totalsDisagreements(e.d1)).toEqual([]);
    },
  );

  onEveryEngine(
    "a hold the budget could not cover is refused though the person could",
    async (e) => {
      const person = await accountPool(e, "cpu");
      const budget = await budgetOf(e, "cpu");
      const [bg, bh, bc] = (await totals(e, budget)) as number[];
      const need = (bg as number) - (bh as number) - (bc as number) + 1;
      expect(
        await entry(e, { kind: "grant", pool_id: person, granted_delta_milli: need }),
      ).toBeNull();
      for (const verb of VERBS) {
        const k = key();
        const err = await insertWith(e, verb, {
          kind: "hold",
          pool_id: person,
          budget_pool_id: budget,
          held_delta_milli: need,
          job_id: jobId(next()),
          idempotency_key: k,
        });
        expect([verb, err]).toEqual([verb, expect.stringMatching(/available below zero/)]);
        expect(await written(e, k)).toBe(0);
      }
      expect(await totals(e, person)).toEqual([need, 0, 0]);
    },
  );

  onEveryEngine(
    "a multi-row INSERT ... SELECT whose second row is refused writes no second row",
    async (e) => {
      for (const verb of VERBS) {
        const c = await ctxFor(e);
        const [granted, held, charged] = (await totals(e, c.pool)) as number[];
        const available = (granted as number) - (held as number) - (charged as number);
        const [k1, k2] = [key(), key()];
        const [j1, j2] = [jobId(next()), jobId(next())];
        // Each hold fits alone; together they do not.
        const err = await e.run(
          `${verb} INTO compute_ledger (kind, pool_id, budget_pool_id, held_delta_milli, job_id, idempotency_key)
         SELECT 'hold', ?1, ?2, ?3, ?4, ?5 UNION ALL SELECT 'hold', ?1, ?2, ?3, ?6, ?7`,
          c.pool,
          c.budget,
          available,
          j1,
          k1,
          j2,
          k2,
        );
        expect([verb, err]).toEqual([verb, expect.stringMatching(/available below zero/)]);
        expect([verb, await written(e, k2)]).toEqual([verb, 0]);
        // Whatever the clause kept of the first, its totals went with it.
        expect(await totalsDisagreements(e.d1)).toEqual([]);
        if (verb !== "INSERT OR FAIL") expect([verb, await written(e, k1)]).toEqual([verb, 0]);
      }
    },
  );
});

describe("compute_ledger: a pool whose available is negative", () => {
  onEveryEngine(
    "takes an overrun, a refund, an adjustment and a closing, and refuses only a hold",
    async (e) => {
      const person = await accountPool(e, "cpu");
      const budget = await budgetOf(e, "cpu");
      expect(
        await entry(e, { kind: "grant", pool_id: person, granted_delta_milli: 1000 }),
      ).toBeNull();
      const { job, hold } = await openHold(e, person, "cpu", 400);
      // The job used more than it held: an overrun, and available is below zero (1000 - 400 - 5000).
      const overrun = (n: number) =>
        entry(e, {
          kind: "overrun",
          pool_id: person,
          budget_pool_id: budget,
          charged_delta_milli: n,
          job_id: jobId(next()),
        });
      expect(await overrun(5000)).toBeNull();
      expect((await totals(e, person)) as number[]).toEqual([1000, 400, 5000]);
      // Only a hold is refused for it; everything else still happens.
      expect(await overrun(7)).toBeNull();
      expect(
        await entry(e, {
          kind: "hold",
          pool_id: person,
          budget_pool_id: budget,
          held_delta_milli: 1,
          job_id: jobId(next()),
        }),
      ).toMatch(/available below zero/);
      expect(
        await entry(e, {
          kind: "adjust",
          pool_id: person,
          budget_pool_id: budget,
          charged_delta_milli: -7,
        }),
      ).toBeNull();
      expect(
        await entry(e, {
          kind: "release",
          pool_id: person,
          budget_pool_id: budget,
          held_delta_milli: -400,
          job_id: job,
          hold_ref: hold,
        }),
      ).toBeNull();
      expect(
        await entry(e, {
          kind: "refund",
          pool_id: person,
          budget_pool_id: budget,
          charged_delta_milli: -100,
          job_id: jobId(next()),
        }),
      ).toBeNull();
      expect(await totalsDisagreements(e.d1)).toEqual([]);
    },
  );
});

describe("compute_ledger: a release or a charge closes the hold it names", () => {
  onEveryEngine("it must name a hold of the same job, pool, budget and held amount", async (e) => {
    const c = await ctxFor(e);
    const other = await ctxFor(e);
    const release = (over: Row) =>
      entry(e, {
        kind: "release",
        pool_id: c.pool,
        held_delta_milli: -2000,
        job_id: c.job,
        hold_ref: c.hold,
        budget_pool_id: c.budget,
        ...over,
      });
    const CLOSES = /closes the hold it names/;
    expect(await release({ hold_ref: 90000000 + next() })).toMatch(CLOSES);
    expect(await release({ hold_ref: other.hold })).toMatch(CLOSES); // another job's hold
    expect(await release({ job_id: other.job })).toMatch(CLOSES); // this hold, another job
    expect(await release({ held_delta_milli: -1999 })).toMatch(CLOSES); // another amount
    expect(await release({ pool_id: other.pool })).toMatch(CLOSES); // another pool
    // The hold's own budget, and none, are two things: a hold counted against the budget is
    // closed against it.
    expect(await release({ budget_pool_id: await budgetOf(e, "gpu") })).toMatch(
      /closes the hold it names|platform people pool/,
    );
    // What is not a hold cannot be closed: a grant's id is not a hold's.
    const grantId = (
      await e.all<{ id: number }>(
        "SELECT id FROM compute_ledger WHERE pool_id = ? AND kind = 'grant' ORDER BY id LIMIT 1",
        c.pool,
      )
    )[0]?.id as number;
    expect(await release({ hold_ref: grantId })).toMatch(CLOSES);
    // Nor can any other entry of the same job, pool and budget whose held delta is 0 (a charge of
    // nothing held names an overrun): only a hold is closed.
    expect(
      await entry(e, {
        kind: "overrun",
        pool_id: c.pool,
        budget_pool_id: c.budget,
        charged_delta_milli: 5,
        job_id: c.job,
      }),
    ).toBeNull();
    const overrunId = (
      await e.all<{ id: number }>(
        "SELECT id FROM compute_ledger WHERE job_id = ? AND kind = 'overrun'",
        c.job,
      )
    )[0]?.id as number;
    expect(
      await release({
        kind: "charge",
        held_delta_milli: 0,
        charged_delta_milli: 1,
        hold_ref: overrunId,
      }),
    ).toMatch(CLOSES);
    expect(await release({})).toBeNull();
  });

  onEveryEngine(
    "a charge is closed against its hold the same way, and a hold of no budget by none",
    async (e) => {
      const c = await ctxFor(e);
      const charge = (over: Row) =>
        entry(e, {
          kind: "charge",
          pool_id: c.pool,
          held_delta_milli: -2000,
          charged_delta_milli: 700,
          job_id: c.job,
          hold_ref: c.hold,
          budget_pool_id: c.budget,
          ...over,
        });
      const CLOSES = /closes the hold it names/;
      expect(await charge({ held_delta_milli: -2001 })).toMatch(CLOSES);
      expect(await charge({ job_id: jobId(next()) })).toMatch(CLOSES);
      expect(await charge({})).toBeNull();
      // A pipelines hold names no budget, and its charge names none.
      const pipelines = await platformPoolId(e.d1, "pipelines", "cpu");
      expect(
        await entry(e, { kind: "grant", pool_id: pipelines, granted_delta_milli: 100000 }),
      ).toBeNull();
      const job = jobId(next());
      expect(
        await entry(e, { kind: "hold", pool_id: pipelines, held_delta_milli: 300, job_id: job }),
      ).toBeNull();
      const holdId = (
        await e.all<{ id: number }>(
          "SELECT id FROM compute_ledger WHERE job_id = ? AND kind = 'hold'",
          job,
        )
      )[0]?.id as number;
      expect(
        await entry(e, {
          kind: "charge",
          pool_id: pipelines,
          held_delta_milli: -300,
          charged_delta_milli: 300,
          job_id: job,
          hold_ref: holdId,
        }),
      ).toBeNull();
    },
  );
});

describe("compute_ledger: append-only, and one close per hold", () => {
  onEveryEngine("an entry cannot be changed or removed", async (e) => {
    const pool = await accountPool(e);
    const k = key();
    expect(
      await entry(e, { kind: "grant", pool_id: pool, granted_delta_milli: 10, idempotency_key: k }),
    ).toBeNull();
    for (const sql of [
      "UPDATE compute_ledger SET granted_delta_milli = 999 WHERE idempotency_key = ?",
      "UPDATE compute_ledger SET reason = 'edited' WHERE idempotency_key = ?",
      "UPDATE compute_ledger SET pool_id = 1 WHERE idempotency_key = ?",
      "DELETE FROM compute_ledger WHERE idempotency_key = ?",
    ]) {
      expect([sql, await e.run(sql, k)]).toEqual([sql, expect.stringMatching(APPEND_ONLY)]);
    }
    expect(await e.run("DELETE FROM compute_ledger")).toMatch(APPEND_ONLY);
    expect(await totals(e, pool)).toEqual([10, 0, 0]);
  });

  onEveryEngine("a key is used once", async (e) => {
    const pool = await accountPool(e);
    const k = key();
    const grant = { kind: "grant", pool_id: pool, granted_delta_milli: 10, idempotency_key: k };
    expect(await entry(e, grant)).toBeNull();
    expect(await entry(e, grant)).toMatch(UNIQUE);
    expect(await totals(e, pool)).toEqual([10, 0, 0]);
  });

  onEveryEngine(
    "a hold closes once, by a release or a charge, and a job has one hold",
    async (e) => {
      const c = await ctxFor(e);
      const release = {
        kind: "release",
        pool_id: c.pool,
        held_delta_milli: -2000,
        job_id: c.job,
        hold_ref: c.hold,
        budget_pool_id: c.budget,
      };
      const charge = {
        kind: "charge",
        pool_id: c.pool,
        held_delta_milli: -2000,
        charged_delta_milli: 1500,
        job_id: c.job,
        hold_ref: c.hold,
        budget_pool_id: c.budget,
      };
      // A second hold of the job, under another key.
      expect(
        await entry(e, {
          kind: "hold",
          pool_id: c.pool,
          held_delta_milli: 100,
          job_id: c.job,
          budget_pool_id: c.budget,
        }),
      ).toMatch(UNIQUE);
      expect(await entry(e, release)).toBeNull();
      expect(await entry(e, release)).toMatch(UNIQUE);
      expect(await entry(e, charge)).toMatch(UNIQUE);
      // An overrun and the entries of other holds are not closes.
      expect(
        await entry(e, {
          kind: "overrun",
          pool_id: c.pool,
          charged_delta_milli: 5,
          job_id: c.job,
          hold_ref: c.hold,
          budget_pool_id: c.budget,
        }),
      ).toBeNull();
      const second = await openHold(e, c.pool, "cpu");
      expect(await entry(e, { ...charge, job_id: second.job, hold_ref: second.hold })).toBeNull();
    },
  );
});

describe("the trigger is the one writer of a pool's totals", () => {
  onEveryEngine(
    "each kind moves the totals of its pool, and a budget's held and charged",
    async (e) => {
      const person = await accountPool(e, "gpu");
      const budget = await budgetOf(e, "gpu");
      const base = (await totals(e, budget)) as number[];
      const job = jobId(next());
      const step = async (row: Row, pool: number[], bud: number[]) => {
        expect(await entry(e, row)).toBeNull();
        expect(await totals(e, person)).toEqual(pool);
        const now = (await totals(e, budget)) as number[];
        expect(now.map((v, i) => v - (base[i] as number))).toEqual(bud);
      };
      await step(
        { kind: "grant", pool_id: person, granted_delta_milli: 10000 },
        [10000, 0, 0],
        [0, 0, 0],
      );
      await step(
        {
          kind: "hold",
          pool_id: person,
          budget_pool_id: budget,
          held_delta_milli: 4000,
          job_id: job,
        },
        [10000, 4000, 0],
        [0, 4000, 0],
      );
      const holdId = (
        await e.all<{ id: number }>(
          "SELECT id FROM compute_ledger WHERE job_id = ? AND kind = 'hold'",
          job,
        )
      )[0]?.id as number;
      await step(
        {
          kind: "charge",
          pool_id: person,
          budget_pool_id: budget,
          held_delta_milli: -4000,
          charged_delta_milli: 2500,
          job_id: job,
          hold_ref: holdId,
        },
        [10000, 0, 2500],
        [0, 0, 2500],
      );
      await step(
        {
          kind: "overrun",
          pool_id: person,
          budget_pool_id: budget,
          charged_delta_milli: 700,
          job_id: job,
        },
        [10000, 0, 3200],
        [0, 0, 3200],
      );
      await step(
        { kind: "adjust", pool_id: person, budget_pool_id: budget, charged_delta_milli: -200 },
        [10000, 0, 3000],
        [0, 0, 3000],
      );
      await step(
        {
          kind: "adjust",
          pool_id: person,
          budget_pool_id: budget,
          charged_delta_milli: 0,
          job_id: job,
        },
        [10000, 0, 3000],
        [0, 0, 3000],
      );
      await step(
        {
          kind: "refund",
          pool_id: person,
          budget_pool_id: budget,
          charged_delta_milli: -3000,
          job_id: job,
        },
        [10000, 0, 0],
        [0, 0, 0],
      );
      await step(
        { kind: "adjust", pool_id: person, granted_delta_milli: -1000 },
        [9000, 0, 0],
        [0, 0, 0],
      );
      await step(
        { kind: "expire", pool_id: person, granted_delta_milli: -9000 },
        [0, 0, 0],
        [0, 0, 0],
      );
      expect(await totalsDisagreements(e.d1)).toEqual([]);
    },
  );

  onEveryEngine("a refused statement of several entries leaves none of them", async (e) => {
    // The settle statement writes a charge and an overrun in one INSERT; if the second is refused
    // the first must not stay, because the statement is the unit.
    const pool = await accountPool(e);
    expect(await entry(e, { kind: "grant", pool_id: pool, granted_delta_milli: 100 })).toBeNull();
    const k = key();
    const err = await e.run(
      `INSERT INTO compute_ledger (kind, pool_id, granted_delta_milli, idempotency_key)
       SELECT 'grant', ?1, 5, ?2 UNION ALL SELECT 'grant', ?1, 0, ?3`,
      pool,
      k,
      key(),
    );
    expect(err).toMatch(NAMED("compute_ledger_deltas"));
    expect(
      (
        await e.all<{ n: number }>(
          "SELECT COUNT(*) AS n FROM compute_ledger WHERE idempotency_key = ?",
          k,
        )
      )[0]?.n,
    ).toBe(0);
    expect(await totals(e, pool)).toEqual([100, 0, 0]);
  });
});

describe("the tables and indexes", () => {
  onEveryEngine("the indexes exist", async (e) => {
    const names = (
      await e.all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'compute_ledger'",
      )
    ).map((r) => r.name);
    for (const n of [
      "compute_ledger_closes_once",
      "compute_ledger_one_hold_per_job",
      "compute_ledger_pool",
      "compute_ledger_job",
    ]) {
      expect(names).toContain(n);
    }
  });

  onEveryEngine("the triggers exist", async (e) => {
    const names = (
      await e.all<{ name: string }>(
        // The triggers of migration 0114's three tables: a later migration (0115's pseudonym table) has its own.
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN ('compute_ledger', 'compute_policy', 'compute_pools') ORDER BY name",
      )
    ).map((r) => r.name);
    expect(names).toEqual([
      "compute_ledger_apply",
      "compute_ledger_budget_is_people",
      "compute_ledger_budget_required",
      "compute_ledger_closes_its_hold",
      "compute_ledger_hold_fits",
      "compute_ledger_no_delete",
      "compute_ledger_no_update",
      "compute_ledger_pool_exists",
      "compute_ledger_totals_in_range",
      "compute_policy_no_delete",
      "compute_policy_no_update",
      "compute_pools_identity_fixed",
      "compute_pools_no_delete",
    ]);
  });

  test("the constraints that are left are the ones the file names", () => {
    const named = [...SQL.matchAll(/CONSTRAINT (\w+) CHECK/g)].map((m) => m[1]);
    // `compute_ledger_closing_hold` and `compute_ledger_budget_distinct` are gone: a trigger
    // answers first for each, so neither could ever be the one that refused a row.
    expect(named).not.toContain("compute_ledger_closing_hold");
    expect(named).not.toContain("compute_ledger_budget_distinct");
    expect(named).toContain("compute_ledger_deltas");
    expect(named).toContain("compute_ledger_budget_kinds");
  });
});

describe("compute_ledger: a hold of exactly what the budget has is a hold (last: it empties the cpu budget)", () => {
  onEveryEngine("fits to the milli-SU, and one more does not", async (e) => {
    const budget = await budgetOf(e, "cpu");
    const [bg, bh, bc] = (await totals(e, budget)) as number[];
    const available = (bg as number) - (bh as number) - (bc as number);
    const person = await accountPool(e, "cpu");
    expect(
      await entry(e, { kind: "grant", pool_id: person, granted_delta_milli: available + 1 }),
    ).toBeNull();
    const hold = (n: number) =>
      entry(e, {
        kind: "hold",
        pool_id: person,
        budget_pool_id: budget,
        held_delta_milli: n,
        job_id: jobId(next()),
      });
    expect(await hold(available + 1)).toMatch(/available below zero/);
    expect(await hold(available)).toBeNull();
    expect(await hold(1)).toMatch(/available below zero/);
  });
});
