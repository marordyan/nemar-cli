/**
 * Migration 0116_compute_lifecycle.sql (epic #2005 phase A5, #2010; ADR 0118), on two engines:
 * bun:sqlite, which every other suite uses, and Miniflare's D1, the implementation `wrangler --local`
 * runs. bun:sqlite is more permissive than the SQLite D1 ships, so a CHECK or an index proven only on
 * the first is not proven. Both carry every real migration; nothing is stood in for.
 *
 * What is pinned: the six columns exist with the shapes the lifecycle writes (a launch specification
 * digest is 64 lowercase hex digits or NULL, the declared bytes are a whole number in range or NULL,
 * the platform-failure flag is 0 or 1 and defaults to 0, and the three timestamps are NULL until their
 * step has happened); a row of the previous shape is still a valid row; the partial index serves the
 * two sums the outputs route's claim reads and only those; no column is named for a person; and the
 * file's GLOB patterns are within D1's 50 characters.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Engine, startEngines } from "./helpers/compute-engines";
import { MIGRATIONS_DIR } from "./helpers/miniflare-d1";

const FILE = "0116_compute_lifecycle.sql";
const SQL = readFileSync(join(MIGRATIONS_DIR, FILE), "utf-8");

type Row = Record<string, unknown>;

let seq = 9000;
const next = () => ++seq;
const jobId = () => `job_${next().toString(16).padStart(24, "0")}`;
const hex64 = (n: number) => n.toString(16).padStart(64, "0");

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

function job(over: Row = {}): Row {
  return {
    id: jobId(),
    source: "cli",
    kind: "batch",
    app_id: "nemar-launch",
    app_version: "1.0.0",
    spec_digest: hex64(next()),
    partition: "shared",
    pool: "cpu",
    nodes: 1,
    cores_per_node: 4,
    minutes: 60,
    ...over,
  };
}

async function insertJob(e: Engine, over: Row = {}): Promise<string | null> {
  const row = job(over);
  const cols = Object.keys(row);
  return e.run(
    `INSERT INTO compute_jobs (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    ...cols.map((c) => row[c]),
  );
}

const NAMED = (name: string) => new RegExp(`CHECK constraint failed: ${name}\\b`);

const NEW_COLUMNS = [
  "launch_spec_digest",
  "results_verified_at",
  "outputs_completed_at",
  "results_bytes",
  "result_records_at",
  "platform_failure",
  // Round 1 of the review (concurrency and starvation): the rotation's key, the submitter's lease and
  // the record of a Tapis job no row owns.
  "examined_at",
  "submit_claimed_at",
  "orphan_tapis_uuid",
] as const;

describe("the columns", () => {
  onEveryEngine("the nine columns exist, and `failure_detail` was never added twice", async (e) => {
    const cols = (
      await e.all<{ name: string }>("SELECT name FROM pragma_table_info('compute_jobs')")
    ).map((c) => c.name);
    for (const c of NEW_COLUMNS) expect([c, cols.includes(c)]).toEqual([c, true]);
    // Phase A3 made `failure_detail`; this migration only adds what A3 left to A5.
    expect(cols.filter((c) => c === "failure_detail")).toHaveLength(1);
    expect(SQL).not.toMatch(/ADD COLUMN failure_detail/);
  });

  onEveryEngine(
    "a row of the previous shape is still a valid row, with the new columns empty",
    async (e) => {
      const id = jobId();
      expect(await insertJob(e, { id })).toBeNull();
      const [row] = await e.all<Row>("SELECT * FROM compute_jobs WHERE id = ?", id);
      for (const c of NEW_COLUMNS.filter((c) => c !== "platform_failure")) {
        expect([c, row?.[c]]).toEqual([c, null]);
      }
      expect(row?.platform_failure).toBe(0);
    },
  );

  onEveryEngine("a launch specification digest is 64 lowercase hex digits, or NULL", async (e) => {
    expect(await insertJob(e, { launch_spec_digest: hex64(next()) })).toBeNull();
    for (const bad of ["abc", hex64(1).toUpperCase().replace("0", "G"), `${hex64(2)}0`, ""]) {
      expect([bad, await insertJob(e, { launch_spec_digest: bad })]).toEqual([
        bad,
        expect.stringMatching(NAMED("compute_jobs_launch_spec_digest")),
      ]);
    }
  });

  onEveryEngine("the declared bytes are a whole number in range, or NULL", async (e) => {
    for (const ok of [0, 1, 20 * 1024 ** 3, Number.MAX_SAFE_INTEGER, null]) {
      expect([ok, await insertJob(e, { results_bytes: ok })]).toEqual([ok, null]);
    }
    // (A numeric string is converted by the column's integer affinity, so it is a number here.)
    for (const bad of [-1, 1.5, Number.MAX_SAFE_INTEGER + 2]) {
      expect([bad, await insertJob(e, { results_bytes: bad })]).toEqual([
        bad,
        expect.stringMatching(NAMED("compute_jobs_results_bytes")),
      ]);
    }
  });

  onEveryEngine("an orphaned Tapis job's uuid is the shape of a uuid, or NULL", async (e) => {
    for (const ok of ["abc-007", "0f8fad5b-d9cb-469f-a165-70867728950e-007", null]) {
      expect([ok, await insertJob(e, { orphan_tapis_uuid: ok })]).toEqual([ok, null]);
    }
    for (const bad of ["", "a b", "x;y", "a".repeat(65), "naïve"]) {
      expect([bad, await insertJob(e, { orphan_tapis_uuid: bad })]).toEqual([
        bad,
        expect.stringMatching(NAMED("compute_jobs_orphan_tapis_uuid")),
      ]);
    }
  });

  onEveryEngine(
    "the platform-failure flag is 0 or 1 and nothing else, and defaults to 0",
    async (e) => {
      for (const ok of [0, 1]) expect(await insertJob(e, { platform_failure: ok })).toBeNull();
      for (const bad of [2, -1, null]) {
        expect(await insertJob(e, { platform_failure: bad })).not.toBeNull();
      }
      const id = jobId();
      await insertJob(e, { id });
      expect(
        (await e.all<Row>("SELECT platform_failure FROM compute_jobs WHERE id = ?", id))[0],
      ).toEqual({
        platform_failure: 0,
      });
    },
  );
});

describe("the index and the file", () => {
  onEveryEngine(
    "the partial index answers the two quota sums, and only a query that names the predicate uses it",
    async (e) => {
      const person = await e.all<{ detail: string }>(
        `EXPLAIN QUERY PLAN SELECT COALESCE(SUM(results_bytes), 0) FROM compute_jobs
        WHERE account_id = 7 AND results_bytes IS NOT NULL`,
      );
      expect(person.map((r) => r.detail).join(" ")).toContain("compute_jobs_results");
      const without = await e.all<{ detail: string }>(
        "EXPLAIN QUERY PLAN SELECT COALESCE(SUM(results_bytes), 0) FROM compute_jobs WHERE account_id = 7",
      );
      expect(without.map((r) => r.detail).join(" ")).not.toContain("compute_jobs_results");
    },
  );

  onEveryEngine(
    "no column of the job table is named for a person (the new ones included)",
    async (e) => {
      const PERSONAL =
        /(^|_)(name|email|mail|country|orcid|affiliation|city|given|family|username|login|phone|address|ip|sub|description|github)(_|$)/;
      const cols = (
        await e.all<{ name: string }>("SELECT name FROM pragma_table_info('compute_jobs')")
      ).map((c) => c.name);
      for (const c of NEW_COLUMNS)
        expect([c, PERSONAL.test(c), cols.includes(c)]).toEqual([c, false, true]);
    },
  );

  test("no GLOB pattern is longer than D1 takes (50 characters)", () => {
    const patterns = [...SQL.matchAll(/GLOB\s+'([^']*)'/g)].map((m) => m[1] as string);
    expect(patterns.length).toBeGreaterThanOrEqual(1);
    for (const p of patterns) expect([p, p.length <= 50]).toEqual([p, true]);
  });

  test("the file adds only what it says: nine columns and two indexes, and touches nothing else", () => {
    expect(
      [...SQL.matchAll(/ALTER TABLE compute_jobs ADD COLUMN (\w+)/g)].map((m) => m[1]),
    ).toEqual([...NEW_COLUMNS]);
    expect([...SQL.matchAll(/CREATE (?:UNIQUE )?INDEX (\w+)/g)].map((m) => m[1])).toEqual([
      "compute_jobs_results",
      "compute_jobs_examined",
    ]);
    const code = SQL.split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    expect(code).not.toMatch(/DROP |DELETE FROM|INSERT INTO|UPDATE /);
  });
});
