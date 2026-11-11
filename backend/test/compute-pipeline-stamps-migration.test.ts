/**
 * Migration 0117_compute_pipeline_stamps.sql (epic #2005 phase A6, #2011; ADR 0118), on two engines:
 * bun:sqlite and Miniflare's D1, the implementation `wrangler --local` runs. bun:sqlite is more
 * permissive than the SQLite D1 ships, so a CHECK or an index proven only on the first is not proven.
 *
 * What is pinned: the states in the file are the shared words; every CHECK refuses its violating row by
 * name and accepts its valid one; the live index lets exactly one `dispatched` or `succeeded` row hold a
 * tuple while a `failed` or `refused` row never blocks a retry; attempt numbers of a tuple are distinct;
 * a failed or refused stamp always says why and the other two never carry a word; a success has its job
 * and a refusal has none; no column is named for a person; and the file's GLOB patterns are within D1's
 * 50 characters.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PIPELINE_LIVE_STAMP_STATES, PIPELINE_STAMP_STATES } from "../../shared/compute-recipes";
import { type Engine, startEngines } from "./helpers/compute-engines";
import { MIGRATIONS_DIR } from "./helpers/miniflare-d1";

const FILE = "0117_compute_pipeline_stamps.sql";
const SQL = readFileSync(join(MIGRATIONS_DIR, FILE), "utf-8");

type Row = Record<string, unknown>;

let seq = 100;
const next = () => ++seq;
const jobId = () => `job_${next().toString(16).padStart(24, "0")}`;

const ENGINES: Engine[] = [];
let dispose: () => Promise<void>;

beforeAll(async () => {
  const started = await startEngines();
  ENGINES.push(...started.engines);
  dispose = started.dispose;
}, 60_000);

afterAll(async () => {
  await dispose?.();
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

/** A valid `dispatched` row of a tuple of its own (each case makes its own dataset id). */
function stamp(over: Row = {}): Row {
  return {
    dataset_id: `nm${String(next()).padStart(6, "0")}`,
    version: "v1.0.0",
    recipe: "nemar-floor",
    recipe_version: "1.0.0",
    engine: "eegprep@0.5.0",
    attempt: 1,
    ...over,
  };
}

async function insertStamp(e: Engine, row: Row): Promise<string | null> {
  const cols = Object.keys(row);
  return e.run(
    `INSERT INTO compute_pipeline_stamps (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    ...cols.map((c) => row[c]),
  );
}

const NAMED = (name: string) => new RegExp(`CHECK constraint failed: ${name}\\b`);
const UNIQUE = /UNIQUE constraint failed/;

describe("the file says the shared words", () => {
  test("the states are PIPELINE_STAMP_STATES, in its order", () => {
    const m = /CONSTRAINT compute_pipeline_stamps_state CHECK \(\s*state IN\s*\(([^)]*)\)/.exec(
      SQL,
    );
    expect([...(m?.[1] ?? "").matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1])).toEqual([
      ...PIPELINE_STAMP_STATES,
    ]);
  });

  test("the live index holds exactly the live states", () => {
    const m = /compute_pipeline_stamps_live[\s\S]*?WHERE state IN \(([^)]*)\)/.exec(SQL);
    expect([...(m?.[1] ?? "").matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1])).toEqual([
      ...PIPELINE_LIVE_STAMP_STATES,
    ]);
  });

  test("no GLOB pattern is longer than D1 takes (50 characters)", () => {
    const patterns = [...SQL.matchAll(/GLOB\s+'([^']*)'/g)].map((m) => m[1] as string);
    expect(patterns.length).toBeGreaterThan(5);
    for (const p of patterns) expect([p, p.length <= 50]).toEqual([p, true]);
  });

  test("the table has no foreign key and nothing cascades into it", () => {
    expect(SQL).not.toMatch(/REFERENCES/i);
    expect(SQL).not.toMatch(/ON DELETE/i);
  });
});

describe("the table", () => {
  onEveryEngine("the tuple alone is a valid row, with the defaults the design names", async (e) => {
    const row = stamp();
    expect(await insertStamp(e, row)).toBeNull();
    const [got] = await e.all<Row>(
      "SELECT * FROM compute_pipeline_stamps WHERE dataset_id = ?",
      row.dataset_id,
    );
    expect(got).toMatchObject({
      state: "dispatched",
      job_id: null,
      refusal_code: null,
      attempt: 1,
    });
    expect(String(got?.created_at)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(String(got?.updated_at)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  onEveryEngine("each tuple column is checked by shape and refuses what it is not", async (e) => {
    const cases: Array<[string, string, unknown[]]> = [
      [
        "compute_pipeline_stamps_dataset",
        "dataset_id",
        ["", "nm00001", "NM000001", "nm00000a", "nm0000011"],
      ],
      ["compute_pipeline_stamps_version", "version", ["", "v 1", "v1/0", "x".repeat(65)]],
      [
        "compute_pipeline_stamps_recipe",
        "recipe",
        ["", "Nemar-Floor", "nemar_floor", "x".repeat(65)],
      ],
      ["compute_pipeline_stamps_recipe_version", "recipe_version", ["", "1 0", "1/0"]],
      ["compute_pipeline_stamps_engine", "engine", ["", "eegprep 0.5", "eeg/prep", "x".repeat(65)]],
    ];
    for (const [name, column, values] of cases) {
      for (const value of values) {
        expect([column, value, await insertStamp(e, stamp({ [column]: value }))]).toEqual([
          column,
          value,
          expect.stringMatching(NAMED(name)),
        ]);
      }
    }
    // The engine takes an `@`, the version does not.
    expect(await insertStamp(e, stamp({ engine: "eegprep@0.5.0" }))).toBeNull();
    expect(await insertStamp(e, stamp({ version: "v1@0" }))).toMatch(
      NAMED("compute_pipeline_stamps_version"),
    );
  });

  onEveryEngine("the attempt is a whole number from 1", async (e) => {
    for (const attempt of [0, -1, 1.5, "x", 1_000_001]) {
      expect([attempt, await insertStamp(e, stamp({ attempt }))]).toEqual([
        attempt,
        expect.stringMatching(NAMED("compute_pipeline_stamps_attempt")),
      ]);
    }
  });

  onEveryEngine("the state is one of the four words", async (e) => {
    for (const state of ["done", "SUCCEEDED", "", "queued"]) {
      expect([state, await insertStamp(e, stamp({ state }))]).toEqual([
        state,
        expect.stringMatching(NAMED("compute_pipeline_stamps_state")),
      ]);
    }
  });

  onEveryEngine("the job id is job_ and 24 lowercase hex digits, or none", async (e) => {
    for (const job_id of [
      "",
      "job_",
      `job_${"a".repeat(23)}`,
      `JOB_${"a".repeat(24)}`,
      `job_${"g".repeat(24)}`,
    ]) {
      expect([job_id, await insertStamp(e, stamp({ job_id }))]).toEqual([
        job_id,
        expect.stringMatching(NAMED("compute_pipeline_stamps_job")),
      ]);
    }
    expect(await insertStamp(e, stamp({ job_id: jobId() }))).toBeNull();
  });

  onEveryEngine("the word is a fixed word: lowercase, digits and underscore", async (e) => {
    for (const refusal_code of ["", "Bad Word", "a-b", "a.b", "x".repeat(65), "é"]) {
      expect([
        refusal_code,
        await insertStamp(e, stamp({ state: "failed", refusal_code })),
      ]).toEqual([refusal_code, expect.stringMatching(NAMED("compute_pipeline_stamps_word"))]);
    }
  });

  onEveryEngine("a failed or refused stamp says why, and no other carries a word", async (e) => {
    const named = expect.stringMatching(NAMED("compute_pipeline_stamps_word_iff"));
    expect(await insertStamp(e, stamp({ state: "failed" }))).toEqual(named);
    expect(await insertStamp(e, stamp({ state: "refused" }))).toEqual(named);
    expect(await insertStamp(e, stamp({ state: "dispatched", refusal_code: "oops" }))).toEqual(
      named,
    );
    expect(
      await insertStamp(e, stamp({ state: "succeeded", job_id: jobId(), refusal_code: "oops" })),
    ).toEqual(named);
    expect(await insertStamp(e, stamp({ state: "failed", refusal_code: "no_job" }))).toBeNull();
    expect(
      await insertStamp(e, stamp({ state: "refused", refusal_code: "insufficient_balance" })),
    ).toBeNull();
  });

  onEveryEngine("a success has its job, and a refusal has none", async (e) => {
    expect(await insertStamp(e, stamp({ state: "succeeded" }))).toMatch(
      NAMED("compute_pipeline_stamps_succeeded_has_job"),
    );
    expect(await insertStamp(e, stamp({ state: "succeeded", job_id: jobId() }))).toBeNull();
    expect(
      await insertStamp(e, stamp({ state: "refused", refusal_code: "suspended", job_id: jobId() })),
    ).toMatch(NAMED("compute_pipeline_stamps_refused_has_no_job"));
    // A failed stamp may have a job (the job failed) or none (the claim was never followed).
    expect(
      await insertStamp(
        e,
        stamp({ state: "failed", refusal_code: "tapis_error", job_id: jobId() }),
      ),
    ).toBeNull();
  });
});

describe("the rule: one live or succeeded stamp per tuple", () => {
  onEveryEngine("a second dispatched or succeeded row for a tuple is refused", async (e) => {
    const t = stamp();
    expect(await insertStamp(e, t)).toBeNull();
    expect(await insertStamp(e, { ...t, attempt: 2 })).toMatch(UNIQUE);
    expect(await insertStamp(e, { ...t, attempt: 3, state: "succeeded", job_id: jobId() })).toMatch(
      UNIQUE,
    );
  });

  onEveryEngine(
    "a failed or refused attempt never blocks a retry, and history stays",
    async (e) => {
      const t = stamp();
      expect(await insertStamp(e, { ...t, state: "failed", refusal_code: "no_job" })).toBeNull();
      expect(
        await insertStamp(e, { ...t, attempt: 2, state: "refused", refusal_code: "suspended" }),
      ).toBeNull();
      expect(await insertStamp(e, { ...t, attempt: 3 })).toBeNull();
      expect(
        (await e.all("SELECT 1 FROM compute_pipeline_stamps WHERE dataset_id = ?", t.dataset_id))
          .length,
      ).toBe(3);
      // Succeeded holds the tuple as well.
      const u = stamp();
      expect(await insertStamp(e, { ...u, state: "succeeded", job_id: jobId() })).toBeNull();
      expect(await insertStamp(e, { ...u, attempt: 2 })).toMatch(UNIQUE);
    },
  );

  onEveryEngine("the rule is per tuple: any one column differing is another tuple", async (e) => {
    const t = stamp();
    expect(await insertStamp(e, t)).toBeNull();
    for (const over of [
      { version: "v1.0.1" },
      { recipe: "nemar-ica" },
      { recipe_version: "1.0.1" },
      { engine: "eegprep@0.6.0" },
    ]) {
      expect([over, await insertStamp(e, { ...t, ...over })]).toEqual([over, null]);
    }
  });

  onEveryEngine("an attempt number of a tuple is used once, whatever became of it", async (e) => {
    const t = stamp();
    expect(await insertStamp(e, { ...t, state: "failed", refusal_code: "no_job" })).toBeNull();
    expect(await insertStamp(e, { ...t, state: "failed", refusal_code: "no_job" })).toMatch(UNIQUE);
  });

  onEveryEngine(
    "a stamp moving to succeeded meets the live index like an insert does",
    async (e) => {
      const t = stamp();
      expect(await insertStamp(e, { ...t, state: "succeeded", job_id: jobId() })).toBeNull();
      expect(
        await insertStamp(e, { ...t, attempt: 2, state: "failed", refusal_code: "x" }),
      ).toBeNull();
      expect(
        await e.run(
          "UPDATE compute_pipeline_stamps SET state = 'dispatched', refusal_code = NULL WHERE dataset_id = ? AND attempt = 2",
          t.dataset_id,
        ),
      ).toMatch(UNIQUE);
    },
  );

  onEveryEngine("the open stamps are served by a partial index", async (e) => {
    const plan = await e.all<{ detail: string }>(
      "EXPLAIN QUERY PLAN SELECT id FROM compute_pipeline_stamps WHERE state = 'dispatched' ORDER BY updated_at LIMIT 10",
    );
    expect(plan.map((p) => p.detail).join("\n")).toContain("compute_pipeline_stamps_open");
    const partial = await e.all<{ name: string; partial: number }>(
      "SELECT name, partial FROM pragma_index_list('compute_pipeline_stamps') WHERE name IN ('compute_pipeline_stamps_open', 'compute_pipeline_stamps_live', 'compute_pipeline_stamps_job')",
    );
    expect(partial.map((p) => p.partial)).toEqual([1, 1, 1]);
  });

  onEveryEngine("no column is named for a person", async (e) => {
    const cols = (
      await e.all<{ name: string }>("SELECT name FROM pragma_table_info('compute_pipeline_stamps')")
    ).map((c) => c.name);
    expect(cols.sort()).toEqual(
      [
        "attempt",
        "created_at",
        "dataset_id",
        "engine",
        "id",
        "job_id",
        "recipe",
        "recipe_version",
        "refusal_code",
        "state",
        "updated_at",
        "version",
      ].sort(),
    );
    for (const c of cols) expect(c).not.toMatch(/name|email|orcid|country|affiliation|user/i);
  });
});
