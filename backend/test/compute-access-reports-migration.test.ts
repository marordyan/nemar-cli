/**
 * Migration 0119_compute_access_reports.sql (epic #2005 phase A8, #2013; ADR 0118 decision 9), on two
 * engines: bun:sqlite and Miniflare's D1, the implementation `wrangler --local` runs. bun:sqlite is
 * more permissive than the SQLite D1 ships, so a CHECK or an index proven only on the first is not
 * proven.
 *
 * What is pinned: the words in the file are the words of `shared/compute-state.ts` (the four states);
 * the error word is checked by SHAPE and not by a list, so a new word never rebuilds the table, and
 * every word declared today passes the shape; every CHECK refuses its violating row by name and
 * accepts its valid one; a job has ONE report row (a second plain INSERT is refused, and an
 * `INSERT OR IGNORE` leaves the first row exactly as it was, whatever state it reached); a sent row
 * carries its time and only a sent row does, an attempting row carries its lease and only an attempting
 * row does, and a failed row always says why; no column is named for a person (the report carries a
 * job id and fixed words, and the pseudonym is read from the job row when it is sent).
 *
 * Rows are never removed by a test: every case makes its own and reads only it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  COMPUTE_ACCESS_REPORT_ERRORS,
  COMPUTE_ACCESS_REPORT_STATES,
  COMPUTE_WORD_RE,
} from "../../shared/compute-state";
import { type Engine, startEngines } from "./helpers/compute-engines";
import { MIGRATIONS_DIR } from "./helpers/miniflare-d1";

const FILE = "0119_compute_access_reports.sql";
const SQL = readFileSync(join(MIGRATIONS_DIR, FILE), "utf-8");

type Row = Record<string, unknown>;

let seq = 9000;
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

async function insertReport(e: Engine, row: Row, verb = "INSERT"): Promise<string | null> {
  const cols = Object.keys(row);
  return e.run(
    `${verb} INTO compute_access_reports (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    ...cols.map((c) => row[c]),
  );
}

const NAMED = (name: string) => new RegExp(`CHECK constraint failed: ${name}\\b`);
const UNIQUE = /UNIQUE constraint failed/;
const NOT_NULL = /NOT NULL constraint failed/;

const read = async (e: Engine, id: string): Promise<Row> =>
  (await e.all<Row>("SELECT * FROM compute_access_reports WHERE job_id = ?", id))[0] as Row;

describe("the file says the shared words", () => {
  test("the states are COMPUTE_ACCESS_REPORT_STATES, in its order", () => {
    const m = /CONSTRAINT compute_access_reports_state CHECK \(\s*state IN\s*\(([^)]*)\)/.exec(SQL);
    expect([...(m?.[1] ?? "").matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1])).toEqual([
      ...COMPUTE_ACCESS_REPORT_STATES,
    ]);
  });

  test("the error word is checked by shape and not by a list, and every word declared passes it", () => {
    const m = /CONSTRAINT compute_access_reports_error CHECK \(([^;]*?)\),?\n/.exec(SQL);
    expect(m?.[1]).toBeDefined();
    expect(m?.[1]).toContain("NOT GLOB '*[^a-z0-9_]*'");
    expect(m?.[1]).not.toMatch(/\bIN\s*\(/);
    for (const w of COMPUTE_ACCESS_REPORT_ERRORS) expect(COMPUTE_WORD_RE.test(w), w).toBe(true);
  });

  test("no GLOB pattern is longer than D1 takes (50 characters)", () => {
    const patterns = [...SQL.matchAll(/GLOB\s+'([^']*)'/g)].map((m) => m[1] as string);
    expect(patterns.length).toBeGreaterThan(1);
    for (const p of patterns) expect([p, p.length <= 50]).toEqual([p, true]);
  });
});

describe("the table", () => {
  onEveryEngine("a job id alone is a valid row, with the defaults the design names", async (e) => {
    const id = jobId();
    expect(await insertReport(e, { job_id: id })).toBeNull();
    expect(await read(e, id)).toMatchObject({
      job_id: id,
      state: "pending",
      attempts: 0,
      claimed_at: null,
      last_error_code: null,
      sent_at: null,
    });
    const row = await read(e, id);
    expect(String(row.next_attempt_at)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(String(row.created_at)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  onEveryEngine("the job id is job_ and 24 lowercase hex digits, and never NULL", async (e) => {
    for (const job_id of [
      "",
      "job_",
      `job_${"a".repeat(23)}`,
      `JOB_${"a".repeat(24)}`,
      `job_${"g".repeat(24)}`,
    ]) {
      expect([job_id, await insertReport(e, { job_id })]).toEqual([
        job_id,
        expect.stringMatching(NAMED("compute_access_reports_job_id")),
      ]);
    }
    expect(await insertReport(e, { job_id: null })).toMatch(NOT_NULL);
    expect(
      await insertReport(e, { job_id: `job_${"0123456789abcdef0123456789abcdef".slice(0, 24)}` }),
    ).toBeNull();
  });

  onEveryEngine(
    "a job has one row: a second INSERT is refused, and OR IGNORE changes nothing",
    async (e) => {
      const id = jobId();
      expect(await insertReport(e, { job_id: id })).toBeNull();
      expect(await insertReport(e, { job_id: id })).toMatch(UNIQUE);
      // The row moves on; a replayed `OR IGNORE` must not put it back to the start.
      expect(
        await e.run(
          "UPDATE compute_access_reports SET state = 'sent', sent_at = datetime('now'), attempts = 3 WHERE job_id = ?",
          id,
        ),
      ).toBeNull();
      expect(await insertReport(e, { job_id: id }, "INSERT OR IGNORE")).toBeNull();
      expect(await read(e, id)).toMatchObject({ state: "sent", attempts: 3 });
      expect(
        (await e.all("SELECT 1 FROM compute_access_reports WHERE job_id = ?", id)).length,
      ).toBe(1);
    },
  );

  onEveryEngine("the state is one of the four words", async (e) => {
    for (const state of ["done", "SENT", "", "queued"]) {
      expect([state, await insertReport(e, { job_id: jobId(), state })]).toEqual([
        state,
        expect.stringMatching(NAMED("compute_access_reports_state")),
      ]);
    }
    expect(await insertReport(e, { job_id: jobId(), state: "pending" })).toBeNull();
    expect(
      await insertReport(e, {
        job_id: jobId(),
        state: "attempting",
        claimed_at: "2026-11-04 08:00:00.123",
      }),
    ).toBeNull();
    expect(
      await insertReport(e, { job_id: jobId(), state: "sent", sent_at: "2026-11-04 08:00:00" }),
    ).toBeNull();
    expect(
      await insertReport(e, {
        job_id: jobId(),
        state: "failed",
        last_error_code: "outcome_unknown",
      }),
    ).toBeNull();
  });

  onEveryEngine("attempts is a whole number from 0, and a fraction is refused", async (e) => {
    for (const attempts of [-1, 1.5, "x", 1001]) {
      expect([attempts, await insertReport(e, { job_id: jobId(), attempts })]).toEqual([
        attempts,
        expect.stringMatching(NAMED("compute_access_reports_attempts")),
      ]);
    }
    expect(await insertReport(e, { job_id: jobId(), attempts: 8 })).toBeNull();
  });

  onEveryEngine("the error word is a fixed word: lowercase, digits and underscore", async (e) => {
    for (const last_error_code of ["", "Bad Word", "a-b", "a.b", "x".repeat(65), "é"]) {
      expect([
        last_error_code,
        await insertReport(e, { job_id: jobId(), last_error_code }),
      ]).toEqual([last_error_code, expect.stringMatching(NAMED("compute_access_reports_error"))]);
    }
    for (const last_error_code of COMPUTE_ACCESS_REPORT_ERRORS) {
      expect(await insertReport(e, { job_id: jobId(), last_error_code })).toBeNull();
    }
  });

  onEveryEngine("a sent row carries its time and only a sent row does, both ways", async (e) => {
    const named = expect.stringMatching(NAMED("compute_access_reports_sent_iff"));
    expect(await insertReport(e, { job_id: jobId(), state: "sent" })).toEqual(named);
    for (const state of ["pending", "failed"]) {
      expect([
        state,
        await insertReport(e, {
          job_id: jobId(),
          state,
          sent_at: "2026-11-04 08:00:00",
          last_error_code: "refused",
        }),
      ]).toEqual([state, named]);
    }
  });

  onEveryEngine(
    "an attempting row carries its lease and only an attempting row does, both ways",
    async (e) => {
      const named = expect.stringMatching(NAMED("compute_access_reports_claim_iff"));
      expect(await insertReport(e, { job_id: jobId(), state: "attempting" })).toEqual(named);
      expect(
        await insertReport(e, {
          job_id: jobId(),
          state: "pending",
          claimed_at: "2026-11-04 08:00:00.001",
        }),
      ).toEqual(named);
    },
  );

  onEveryEngine("a failed row always says why", async (e) => {
    expect(await insertReport(e, { job_id: jobId(), state: "failed" })).toMatch(
      NAMED("compute_access_reports_failed_says_why"),
    );
  });

  onEveryEngine("the due list is served by a partial index on the pending rows", async (e) => {
    const plan = await e.all<{ detail: string }>(
      "EXPLAIN QUERY PLAN SELECT job_id FROM compute_access_reports WHERE state = 'pending' AND next_attempt_at <= datetime('now') ORDER BY next_attempt_at LIMIT 10",
    );
    expect(plan.map((p) => p.detail).join("\n")).toContain("compute_access_reports_due");
    // Partial: a query that does not state the predicate cannot use it, which is what keeps the
    // index small (a `sent` or `failed` row, the bulk of the table, is not in it).
    const partial = await e.all<{ partial: number }>(
      "SELECT partial FROM pragma_index_list('compute_access_reports') WHERE name = 'compute_access_reports_due'",
    );
    expect(partial).toEqual([{ partial: 1 }]);
    const without = await e.all<{ detail: string }>(
      "EXPLAIN QUERY PLAN SELECT job_id FROM compute_access_reports WHERE next_attempt_at <= datetime('now')",
    );
    expect(without.map((p) => p.detail).join("\n")).not.toContain("compute_access_reports_due");
  });

  onEveryEngine(
    "no column is named for a person: a report carries a job id and fixed words",
    async (e) => {
      const cols = (
        await e.all<{ name: string }>(
          "SELECT name FROM pragma_table_info('compute_access_reports')",
        )
      ).map((c) => c.name);
      expect(cols.sort()).toEqual(
        [
          "attempts",
          "claimed_at",
          "created_at",
          "job_id",
          "last_error_code",
          "next_attempt_at",
          "sent_at",
          "state",
        ].sort(),
      );
      for (const c of cols)
        expect(c).not.toMatch(/name|email|orcid|country|affiliation|subject|user/i);
    },
  );

  test("the table has no foreign key and nothing cascades from an account or a job into it", () => {
    expect(SQL).not.toMatch(/REFERENCES/i);
    expect(SQL).not.toMatch(/ON DELETE/i);
  });
});
