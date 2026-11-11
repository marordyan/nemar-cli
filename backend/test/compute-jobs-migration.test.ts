/**
 * Migration 0115_compute_jobs.sql (epic #2005 phase A3, #2008; ADR 0118), on two engines: bun:sqlite
 * and Miniflare's D1, the implementation `wrangler --local` runs. bun:sqlite is more permissive than
 * the SQLite D1 ships, so a CHECK or an index proven only on the first is not proven.
 *
 * What is pinned: the words in the file are the words of `shared/compute-state.ts` and
 * `shared/contract/compute.ts` (states, sources, kinds, pools, the live states of the partial index,
 * the four flag columns); the words a LATER epic may add (a failure code, a cancel reason, a failure
 * detail) are checked by SHAPE and not by a list, so a new word never forces a rebuild of the table,
 * and every word declared today passes the shape; every CHECK refuses its violating row, by name, and
 * accepts its valid one; `state = 'failed'` if and only if a failure code is set; the idempotency key
 * is unique per account and only when set; a Tapis job id is unique; no column is named for a name,
 * an email, a country, an ORCID iD or an affiliation (identity lives only in the records bucket); the
 * gateway pseudonym is `gw_` and 20 lowercase base32 characters, and is never changed or removed.
 *
 * The jobs are never removed by a test either: every case makes its own row and reads only it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import {
  COMPUTE_CANCEL_REASONS,
  COMPUTE_FAILURE_CODES,
  COMPUTE_JOB_FLAGS,
  COMPUTE_KINDS,
  COMPUTE_SOURCES,
  COMPUTE_STATES,
  LAUNCHER_DETAILS,
  LIVE_COMPUTE_STATES,
  PLATFORM_LAUNCHER_DETAILS,
  RESULT_REFUSAL_DETAILS,
} from "../../shared/compute-state";
import {
  COMPUTE_POOLS,
  PARTITION_NAMES,
  PIPELINES_TAPIS_OWNER,
} from "../../shared/contract/compute";
import { PIPELINE_LIVE_JOBS_SQL } from "../src/services/compute-jobs";
import { type Engine, startEngines } from "./helpers/compute-engines";
import { MIGRATIONS_DIR } from "./helpers/miniflare-d1";

const FILE = "0115_compute_jobs.sql";
const SQL = readFileSync(join(MIGRATIONS_DIR, FILE), "utf-8");

type Row = Record<string, unknown>;

let seq = 4000;
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

/** A valid job row; a test overrides what it is about. */
function job(over: Row = {}): Row {
  const id = jobId();
  return {
    id,
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

async function insertRow(e: Engine, table: string, row: Row): Promise<string | null> {
  const cols = Object.keys(row);
  return e.run(
    `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    ...cols.map((c) => row[c]),
  );
}

const insertJob = (e: Engine, over: Row = {}) => insertRow(e, "compute_jobs", job(over));

const NAMED = (name: string) => new RegExp(`CHECK constraint failed: ${name}\\b`);
const UNIQUE = /UNIQUE constraint failed/;
const NOT_NULL = /NOT NULL constraint failed/;

/** Words quoted in a CHECK's `IN (...)` list, or an index's, in the file's order. */
function quoted(pattern: RegExp): string[] {
  const m = pattern.exec(SQL);
  return [...(m?.[1] ?? "").matchAll(/'([a-z0-9_-]+)'/g)].map((x) => x[1] as string);
}

describe("the file says the shared words", () => {
  test("the states are COMPUTE_STATES, in its order", () => {
    expect(quoted(/CONSTRAINT compute_jobs_state CHECK \(\s*state IN\s*\(([^)]*)\)/)).toEqual([
      ...COMPUTE_STATES,
    ]);
  });

  test("the sources are COMPUTE_SOURCES and the kinds are COMPUTE_KINDS", () => {
    expect(quoted(/CONSTRAINT compute_jobs_source CHECK \(\s*source IN\s*\(([^)]*)\)/)).toEqual([
      ...COMPUTE_SOURCES,
    ]);
    expect(quoted(/CONSTRAINT compute_jobs_kind CHECK \(\s*kind IN\s*\(([^)]*)\)/)).toEqual([
      ...COMPUTE_KINDS,
    ]);
  });

  test("the pools are the pools of shared/contract/compute.ts", () => {
    expect(quoted(/CONSTRAINT compute_jobs_pool CHECK \(\s*pool IN\s*\(([^)]*)\)/)).toEqual([
      ...COMPUTE_POOLS,
    ]);
  });

  test("the live states of the partial index are LIVE_COMPUTE_STATES, in its order", () => {
    expect(quoted(/CREATE INDEX compute_jobs_live[^;]*?WHERE\s+state IN\s*\(([^)]*)\)/)).toEqual([
      ...LIVE_COMPUTE_STATES,
    ]);
  });

  onEveryEngine(
    "the flag columns are the job flags, one each, and nothing else is a flag",
    async (e) => {
      const cols = (
        await e.all<{ name: string }>("SELECT name FROM pragma_table_info('compute_jobs')")
      ).map((c) => c.name);
      expect(cols.filter((c) => c.startsWith("flag_")).sort()).toEqual(
        COMPUTE_JOB_FLAGS.map((f) => `flag_${f}`).sort(),
      );
    },
  );

  test("the pipelines' gateway literal is the one of the contract", () => {
    expect(SQL).toContain(`'${PIPELINES_TAPIS_OWNER}'`);
  });

  test("no GLOB pattern is longer than D1 takes (50 characters)", () => {
    const patterns = [...SQL.matchAll(/GLOB\s+'([^']*)'/g)].map((m) => m[1] as string);
    expect(patterns.length).toBeGreaterThan(10);
    for (const p of patterns) expect([p, p.length <= 50]).toEqual([p, true]);
  });

  test("the words a later epic may add are checked by shape, never by a list", () => {
    for (const column of ["failure_code", "failure_detail", "cancel_reason"]) {
      const m = new RegExp(`CONSTRAINT compute_jobs_${column} CHECK \\(([^;]*?)\\),?\\n`).exec(SQL);
      expect(m?.[1]).toBeDefined();
      expect(m?.[1]).toContain("NOT GLOB '*[^a-z0-9_]*'");
      expect(m?.[1]).not.toMatch(/\bIN\s*\(/);
    }
  });
});

describe("the table", () => {
  onEveryEngine("a valid row is accepted, with the defaults the design names", async (e) => {
    const id = jobId();
    expect(await insertJob(e, { id })).toBeNull();
    const row = (await e.all<Row>("SELECT * FROM compute_jobs WHERE id = ?", id))[0] as Row;
    expect(row).toMatchObject({
      state: "created",
      gpus: 0,
      held_milli: 0,
      charged_milli: 0,
      flag_unreserved: 0,
      flag_unattributed: 0,
      flag_mismatch: 0,
      flag_overrun: 0,
      legal_hold: 0,
      account_id: null,
      gateway_user: null,
      idempotency_key: null,
      failure_code: null,
      cancel_reason: null,
      tapis_uuid: null,
      records_written_at: null,
      hold_ledger_id: null,
      retention_until: null,
      webhook_nonce: null,
    });
    expect(String(row.created_at)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  onEveryEngine("a row with every column filled is accepted", async (e) => {
    expect(
      await insertJob(e, {
        account_id: 77,
        tapis_owner: "someone.example-1",
        gateway_user: "gw_abcdefghijklmnopqrst",
        idempotency_key: "key-0123456789",
        source: "partner",
        client_id: "partner.client-1",
        kind: "interactive",
        state: "failed",
        failure_code: "result_upload_failed",
        failure_detail: "results_too_large",
        cancel_reason: "user",
        cancel_requested_at: "2026-11-04 08:00:00",
        tapis_uuid: `uuid-${next()}-007`,
        tapis_status: "FAILED",
        slurm_job_id: "1234567_1+2.x-y",
        image_digest: `sha256:${"ab".repeat(32)}`,
        partition: "large-shared",
        pool: "cpu",
        nodes: 64,
        cores_per_node: 256,
        memory_mb: 16_777_216,
        gpus: 0,
        minutes: 10_080,
        hold_ledger_id: 5,
        held_milli: Number.MAX_SAFE_INTEGER,
        charged_milli: Number.MAX_SAFE_INTEGER,
        flag_unreserved: 1,
        flag_unattributed: 1,
        flag_mismatch: 1,
        flag_overrun: 1,
        legal_hold: 1,
        retention_until: "2033-11-04 08:00:00",
        webhook_nonce: crypto.randomUUID(),
      }),
    ).toBeNull();
  });

  onEveryEngine("the id is job_ and 24 lowercase hex digits", async (e) => {
    const bad = [
      "",
      "job_",
      `job_${"a".repeat(23)}`,
      `job_${"a".repeat(25)}`,
      `JOB_${"a".repeat(24)}`,
      `job_${"A".repeat(24)}`,
      `job_${"g".repeat(24)}`,
      `jab_${"a".repeat(24)}`,
      `job-${"a".repeat(24)}`,
      ` job_${"a".repeat(23)}`,
    ];
    for (const id of bad)
      expect([id, await insertJob(e, { id })]).toEqual([
        id,
        expect.stringMatching(NAMED("compute_jobs_id")),
      ]);
    expect(
      await insertJob(e, { id: `job_${"0123456789abcdef0123456789abcdef".slice(0, 24)}` }),
    ).toBeNull();
  });

  // `id TEXT PRIMARY KEY` alone lets SQLite keep a NULL id (a primary key is not NOT NULL in a rowid
  // table), and `length(NULL) = 28` is NULL, which a CHECK accepts: a NULL must be refused by NOT NULL.
  onEveryEngine("a NULL id is refused, and the refusal is the NOT NULL one", async (e) => {
    expect(await insertJob(e, { id: null })).toMatch(NOT_NULL);
    const { id: _omitted, ...withoutId } = job();
    expect(await insertRow(e, "compute_jobs", withoutId)).toMatch(NOT_NULL);
    expect((await e.all("SELECT 1 FROM compute_jobs WHERE id IS NULL")).length).toBe(0);
  });

  onEveryEngine("a second row with the same id is refused", async (e) => {
    const id = jobId();
    expect(await insertJob(e, { id })).toBeNull();
    expect(await insertJob(e, { id })).toMatch(UNIQUE);
  });

  onEveryEngine("an account is a positive whole number, or none", async (e) => {
    for (const account_id of [0, -1, 1.5, "x"]) {
      expect([account_id, await insertJob(e, { account_id })]).toEqual([
        account_id,
        expect.stringMatching(NAMED("compute_jobs_account")),
      ]);
    }
    expect(await insertJob(e, { account_id: null })).toBeNull();
    expect(await insertJob(e, { account_id: 1 })).toBeNull();
  });

  onEveryEngine("source, kind, state and pool are the shared words", async (e) => {
    for (const [column, word] of [
      ["source", "mail"],
      ["source", ""],
      ["source", "CLI"],
      ["kind", "session"],
      ["state", "done"],
      ["state", "FINISHED"],
      ["pool", "tpu"],
      ["pool", "CPU"],
    ] as const) {
      expect([column, word, await insertJob(e, { [column]: word })]).toEqual([
        column,
        word,
        expect.stringMatching(NAMED(`compute_jobs_${column}`)),
      ]);
    }
    for (const source of COMPUTE_SOURCES) expect(await insertJob(e, { source })).toBeNull();
    for (const kind of COMPUTE_KINDS) expect(await insertJob(e, { kind })).toBeNull();
    for (const pool of COMPUTE_POOLS) expect(await insertJob(e, { pool })).toBeNull();
    // `failed` carries its code (next test), so it is listed here with one.
    for (const state of COMPUTE_STATES) {
      const failing = state === "failed" ? { failure_code: "launch_failed" } : {};
      expect([state, await insertJob(e, { state, ...failing })]).toEqual([state, null]);
    }
  });

  onEveryEngine("state is `failed` if and only if a failure code is set, both ways", async (e) => {
    const named = expect.stringMatching(NAMED("compute_jobs_failed_iff_code"));
    expect(await insertJob(e, { state: "failed" })).toEqual(named);
    for (const state of COMPUTE_STATES.filter((s) => s !== "failed")) {
      expect([state, await insertJob(e, { state, failure_code: "launch_failed" })]).toEqual([
        state,
        named,
      ]);
    }
    expect(await insertJob(e, { state: "failed", failure_code: "launch_failed" })).toBeNull();
    expect(await insertJob(e, { state: "running" })).toBeNull();
  });

  const SHAPE_REFUSED = ["", "A", "Launch", "a-b", "a b", "a.b", "é", "a\n", "x".repeat(65)];

  for (const column of ["failure_code", "failure_detail", "cancel_reason"] as const) {
    onEveryEngine(
      `${column} is a fixed word by shape, so a new word needs no rebuild`,
      async (e) => {
        // `failed` needs a failure code and a code needs `failed`; the others are free.
        const base = (word: string): Row =>
          column === "failure_code" ? { state: "failed", failure_code: word } : { [column]: word };
        for (const word of SHAPE_REFUSED) {
          expect([column, word, await insertJob(e, base(word))]).toEqual([
            column,
            word,
            expect.stringMatching(NAMED(`compute_jobs_${column}`)),
          ]);
        }
        // A word no list of today holds is accepted: the shape is the rule.
        for (const word of ["a_new_word_2027", "x", "x".repeat(64), "9lives"]) {
          expect([column, word, await insertJob(e, base(word))]).toEqual([column, word, null]);
        }
      },
    );
  }

  onEveryEngine(
    "every failure code, detail and cancel reason declared today passes its shape",
    async (e) => {
      for (const code of COMPUTE_FAILURE_CODES) {
        expect([code, await insertJob(e, { state: "failed", failure_code: code })]).toEqual([
          code,
          null,
        ]);
      }
      const details = new Set<string>([
        ...Object.values(LAUNCHER_DETAILS).flat(),
        ...PLATFORM_LAUNCHER_DETAILS,
        ...RESULT_REFUSAL_DETAILS,
      ]);
      expect(details.size).toBeGreaterThan(30);
      for (const detail of details) {
        expect([detail, await insertJob(e, { failure_detail: detail })]).toEqual([detail, null]);
      }
      for (const reason of COMPUTE_CANCEL_REASONS) {
        expect([reason, await insertJob(e, { cancel_reason: reason })]).toEqual([reason, null]);
      }
    },
  );

  onEveryEngine(
    "a partition is a lowercase word with hyphens, and every partition passes",
    async (e) => {
      for (const partition of PARTITION_NAMES) expect(await insertJob(e, { partition })).toBeNull();
      for (const partition of [
        "",
        "Shared",
        "gpu_shared",
        "gpu shared",
        "shared1",
        "x".repeat(33),
      ]) {
        expect([partition, await insertJob(e, { partition })]).toEqual([
          partition,
          expect.stringMatching(NAMED("compute_jobs_partition")),
        ]);
      }
    },
  );

  onEveryEngine("resources are whole numbers within the specification's ranges", async (e) => {
    const cases: Array<[string, string, unknown[], unknown[]]> = [
      ["nodes", "compute_jobs_nodes", [0, 65, 1.5, "two", -1], [1, 64]],
      ["cores_per_node", "compute_jobs_cores", [-1, 257, 2.5, "four"], [0, 1, 256]],
      [
        "memory_mb",
        "compute_jobs_memory",
        [0, -5, 16_777_217, 1.5, "eight"],
        [1, 16_777_216, null],
      ],
      ["gpus", "compute_jobs_gpus", [-1, 9, 0.5, "one"], [0, 8]],
      ["minutes", "compute_jobs_minutes", [0, 10_081, 59.5, "sixty"], [1, 10_080]],
    ];
    for (const [column, name, bad, good] of cases) {
      for (const value of bad) {
        expect([column, value, await insertJob(e, { [column]: value })]).toEqual([
          column,
          value,
          expect.stringMatching(NAMED(name)),
        ]);
      }
      for (const value of good)
        expect([column, value, await insertJob(e, { [column]: value })]).toEqual([
          column,
          value,
          null,
        ]);
    }
  });

  onEveryEngine("a missing required column is refused", async (e) => {
    for (const column of [
      "id",
      "source",
      "kind",
      "app_id",
      "app_version",
      "spec_digest",
      "partition",
      "pool",
      "nodes",
      "cores_per_node",
      "minutes",
    ]) {
      const row = job();
      delete row[column];
      expect([column, await insertRow(e, "compute_jobs", row)]).toEqual([
        column,
        expect.stringMatching(NOT_NULL),
      ]);
    }
  });

  onEveryEngine("the spec digest is 64 lowercase hex digits", async (e) => {
    for (const spec_digest of [
      "",
      "a".repeat(63),
      "a".repeat(65),
      "A".repeat(64),
      "g".repeat(64),
      `sha256:${"a".repeat(57)}`,
    ]) {
      expect([spec_digest, await insertJob(e, { spec_digest })]).toEqual([
        spec_digest,
        expect.stringMatching(NAMED("compute_jobs_spec_digest")),
      ]);
    }
    expect(await insertJob(e, { spec_digest: "0123456789abcdef".repeat(4) })).toBeNull();
  });

  onEveryEngine("an image digest is sha256: and 64 lowercase hex digits, or none", async (e) => {
    for (const image_digest of [
      "",
      `sha256:${"a".repeat(63)}`,
      `sha512:${"a".repeat(64)}`,
      `sha256:${"A".repeat(64)}`,
      "a".repeat(64),
      `SHA256:${"a".repeat(64)}`,
    ]) {
      expect([image_digest, await insertJob(e, { image_digest })]).toEqual([
        image_digest,
        expect.stringMatching(NAMED("compute_jobs_image_digest")),
      ]);
    }
    expect(await insertJob(e, { image_digest: `sha256:${"0f".repeat(32)}` })).toBeNull();
  });

  onEveryEngine(
    "the gateway user is gw_ and 20 base32 characters, or the pipelines' literal, or none",
    async (e) => {
      for (const gateway_user of [
        "",
        "gw_",
        `gw_${"a".repeat(19)}`,
        `gw_${"a".repeat(21)}`,
        `GW_${"a".repeat(20)}`,
        `gw_${"A".repeat(20)}`,
        `gw_${"1".repeat(20)}`,
        `gw_${"8".repeat(20)}`,
        `gw_${"a".repeat(19)}-`,
        `xx_${"a".repeat(20)}`,
        "nemar-pipeline",
        "Nemar-Pipelines",
      ]) {
        expect([gateway_user, await insertJob(e, { gateway_user })]).toEqual([
          gateway_user,
          expect.stringMatching(NAMED("compute_jobs_gateway_user")),
        ]);
      }
      for (const gateway_user of [
        `gw_${"a2b3c4d5e6f7g7z2a3b4"}`,
        `gw_${"abcdefghijklmnopqrst"}`,
        PIPELINES_TAPIS_OWNER,
        null,
      ]) {
        expect([gateway_user, await insertJob(e, { gateway_user })]).toEqual([gateway_user, null]);
      }
    },
  );

  onEveryEngine(
    "an idempotency key, a client, a Tapis owner, a Tapis job and a Slurm job are fixed shapes",
    async (e) => {
      const cases: Array<[string, string, string[], string[]]> = [
        [
          "idempotency_key",
          "compute_jobs_idempotency_key",
          ["", "a b", "a/b", "é", "x".repeat(129)],
          ["a", "k-1_2.3:4", "x".repeat(128)],
        ],
        [
          "client_id",
          "compute_jobs_client_id",
          ["", "a b", "a:b", "x".repeat(65)],
          ["a", "p.c-1_2", "x".repeat(64)],
        ],
        [
          "tapis_owner",
          "compute_jobs_tapis_owner",
          ["", "a b", "a/b", "é", "x".repeat(129)],
          ["a", "n.b-1_2@x+y", "x".repeat(128)],
        ],
        [
          "tapis_uuid",
          "compute_jobs_tapis_uuid",
          ["", "a b", "a_b", "x".repeat(65)],
          ["a-b-1", "x".repeat(64)],
        ],
        [
          "tapis_status",
          "compute_jobs_tapis_status",
          ["", "running", "A B", "A1", "X".repeat(33)],
          ["RUNNING", "PROCESSING_INPUTS"],
        ],
        [
          "slurm_job_id",
          "compute_jobs_slurm_job_id",
          ["", "a b", "a/b", "x".repeat(65)],
          ["1", "1234_5+6.7-a", "x".repeat(64)],
        ],
        [
          "app_id",
          "compute_jobs_app_id",
          ["", "a b", "a/b", "x".repeat(81)],
          ["nemar-launch", "a.b_c-1", "x".repeat(80)],
        ],
        [
          "app_version",
          "compute_jobs_app_version",
          ["", "a b", "a/b", "x".repeat(65)],
          ["1.0.0", "1.0.0+x", "x".repeat(64)],
        ],
      ];
      for (const [column, name, bad, good] of cases) {
        for (const value of bad) {
          expect([column, value, await insertJob(e, { [column]: value })]).toEqual([
            column,
            value,
            expect.stringMatching(NAMED(name)),
          ]);
        }
        for (const value of good) {
          const unique =
            column === "tapis_uuid" || column === "idempotency_key" ? { account_id: next() } : {};
          const v = column === "tapis_uuid" ? `${value}-${next()}`.slice(0, 64) : value;
          expect([column, value, await insertJob(e, { [column]: v, ...unique })]).toEqual([
            column,
            value,
            null,
          ]);
        }
      }
    },
  );

  onEveryEngine(
    "held and charged are whole milli-SU from 0 to 2^53 - 1, and the hold link is a positive id",
    async (e) => {
      for (const column of ["held_milli", "charged_milli"]) {
        for (const value of [-1, 1.5, "five", Number.MAX_SAFE_INTEGER + 2]) {
          expect([column, value, await insertJob(e, { [column]: value })]).toEqual([
            column,
            value,
            expect.stringMatching(
              NAMED(`compute_jobs_${column === "held_milli" ? "held" : "charged"}`),
            ),
          ]);
        }
        for (const value of [0, 1, Number.MAX_SAFE_INTEGER]) {
          expect(await insertJob(e, { [column]: value })).toBeNull();
        }
      }
      for (const hold_ledger_id of [0, -1, 1.5, "three"]) {
        expect([hold_ledger_id, await insertJob(e, { hold_ledger_id })]).toEqual([
          hold_ledger_id,
          expect.stringMatching(NAMED("compute_jobs_hold_ledger_id")),
        ]);
      }
    },
  );

  onEveryEngine("a flag and the legal hold are 0 or 1", async (e) => {
    for (const column of [...COMPUTE_JOB_FLAGS.map((f) => `flag_${f}`), "legal_hold"]) {
      for (const value of [2, -1, 0.5, "yes"]) {
        expect([column, value, await insertJob(e, { [column]: value })]).toEqual([
          column,
          value,
          expect.stringMatching(NAMED(`compute_jobs_${column}`)),
        ]);
      }
      for (const value of [0, 1]) expect(await insertJob(e, { [column]: value })).toBeNull();
    }
  });

  onEveryEngine("the webhook nonce is a 36-character lowercase UUID, or none", async (e) => {
    for (const webhook_nonce of [
      "",
      "x",
      crypto.randomUUID().toUpperCase(),
      `${crypto.randomUUID()}0`,
      "g".repeat(36),
    ]) {
      expect([webhook_nonce, await insertJob(e, { webhook_nonce })]).toEqual([
        webhook_nonce,
        expect.stringMatching(NAMED("compute_jobs_webhook_nonce")),
      ]);
    }
    expect(await insertJob(e, { webhook_nonce: crypto.randomUUID() })).toBeNull();
  });
});

describe("uniqueness", () => {
  onEveryEngine("an idempotency key is unique per account, and only when it is set", async (e) => {
    const account = next();
    const key = `key-${next()}`;
    expect(await insertJob(e, { account_id: account, idempotency_key: key })).toBeNull();
    expect(await insertJob(e, { account_id: account, idempotency_key: key })).toMatch(UNIQUE);
    // Another account may use the same key; the same account may use another.
    expect(await insertJob(e, { account_id: next(), idempotency_key: key })).toBeNull();
    expect(await insertJob(e, { account_id: account, idempotency_key: `${key}-2` })).toBeNull();
    // No key is no constraint, for an account and for none.
    expect(await insertJob(e, { account_id: account })).toBeNull();
    expect(await insertJob(e, { account_id: account })).toBeNull();
    expect(await insertJob(e, { account_id: null })).toBeNull();
    expect(await insertJob(e, { account_id: null })).toBeNull();
  });

  onEveryEngine("a Tapis job id is unique, and many rows may have none", async (e) => {
    const uuid = `tapis-${next()}`;
    expect(await insertJob(e, { tapis_uuid: uuid })).toBeNull();
    expect(await insertJob(e, { tapis_uuid: uuid })).toMatch(UNIQUE);
    expect(await insertJob(e, {})).toBeNull();
    expect(await insertJob(e, {})).toBeNull();
  });
});

describe("no identity in a job row", () => {
  onEveryEngine(
    "no column of the job or the gateway-user table is named for a person",
    async (e) => {
      // The columns an identity snapshot holds, and the ones that would tie a row to a human by name.
      const PERSONAL =
        /(^|_)(name|email|mail|country|orcid|affiliation|city|given|family|username|login|phone|address|ip|sub|description|github)(_|$)/;
      for (const table of ["compute_jobs", "compute_gateway_users"]) {
        const cols = (
          await e.all<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`)
        ).map((c) => c.name);
        expect(cols.length).toBeGreaterThan(2);
        for (const c of cols) expect([table, c, PERSONAL.test(c)]).toEqual([table, c, false]);
      }
      // The pattern is not vacuous: it sees what it is meant to.
      for (const c of [
        "email",
        "user_email",
        "name",
        "given_name",
        "country",
        "orcid",
        "affiliation",
        "sub",
        "ip",
      ]) {
        expect(PERSONAL.test(c)).toBe(true);
      }
    },
  );

  onEveryEngine(
    "the job table has no foreign key, so an account's deletion never reaches a job",
    async (e) => {
      for (const table of ["compute_jobs", "compute_gateway_users"]) {
        expect(await e.all(`SELECT * FROM pragma_foreign_key_list('${table}')`)).toEqual([]);
      }
    },
  );
});

describe("compute_gateway_users", () => {
  const pseudonym = () => {
    const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
    let n = next();
    let out = "";
    for (let i = 0; i < 20; i++) {
      out += alphabet[(n + i * 7) % 32];
      n = Math.floor(n / 3) + i;
    }
    return `gw_${out}`;
  };

  onEveryEngine(
    "holds one pseudonym per account, gw_ and 20 lowercase base32 characters",
    async (e) => {
      const account = next();
      const gateway_user = pseudonym();
      expect(
        await insertRow(e, "compute_gateway_users", { account_id: account, gateway_user }),
      ).toBeNull();
      // An account has one, and a pseudonym is never given to two accounts: the second row is ignored
      // whole (the trigger `compute_gateway_users_keeps_first`), and the first stays as it was.
      const other = next();
      expect(
        await insertRow(e, "compute_gateway_users", {
          account_id: account,
          gateway_user: pseudonym(),
        }),
      ).toBeNull();
      expect(
        await insertRow(e, "compute_gateway_users", { account_id: other, gateway_user }),
      ).toBeNull();
      expect(
        await e.all(
          "SELECT * FROM compute_gateway_users WHERE account_id IN (?, ?)",
          account,
          other,
        ),
      ).toEqual([expect.objectContaining({ account_id: account, gateway_user })]);
      for (const bad of [
        "",
        "gw_",
        `gw_${"a".repeat(19)}`,
        `gw_${"a".repeat(21)}`,
        `GW_${"a".repeat(20)}`,
        `gw_${"1".repeat(20)}`,
        `gw_${"A".repeat(20)}`,
        PIPELINES_TAPIS_OWNER,
      ]) {
        expect([
          bad,
          await insertRow(e, "compute_gateway_users", { account_id: next(), gateway_user: bad }),
        ]).toEqual([bad, expect.stringMatching(NAMED("compute_gateway_users_shape"))]);
      }
      for (const account_id of [0, -3, 1.5, "x"]) {
        expect([
          account_id,
          await insertRow(e, "compute_gateway_users", { account_id, gateway_user: pseudonym() }),
        ]).toEqual([account_id, expect.stringMatching(NAMED("compute_gateway_users_account"))]);
      }
      // A NULL account is refused: it would otherwise be given a row number as its id.
      expect(
        await insertRow(e, "compute_gateway_users", {
          account_id: null,
          gateway_user: pseudonym(),
        }),
      ).toMatch(NOT_NULL);
      const stored = (
        await e.all<Row>("SELECT * FROM compute_gateway_users WHERE account_id = ?", account)
      )[0];
      expect(String(stored?.created_at)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    },
  );

  onEveryEngine("is never rotated and never removed", async (e) => {
    const account = next();
    expect(
      await insertRow(e, "compute_gateway_users", {
        account_id: account,
        gateway_user: pseudonym(),
      }),
    ).toBeNull();
    expect(
      await e.run(
        "UPDATE compute_gateway_users SET gateway_user = ? WHERE account_id = ?",
        pseudonym(),
        account,
      ),
    ).toMatch(/never rotated/);
    expect(
      await e.run(
        "UPDATE compute_gateway_users SET account_id = ? WHERE account_id = ?",
        next(),
        account,
      ),
    ).toMatch(/never rotated/);
    expect(await e.run("DELETE FROM compute_gateway_users WHERE account_id = ?", account)).toMatch(
      /never removed/,
    );
    expect(
      (await e.all("SELECT 1 FROM compute_gateway_users WHERE account_id = ?", account)).length,
    ).toBe(1);
  });

  // The delete trigger does not fire for the delete a REPLACE does (recursive triggers are off on D1),
  // so a REPLACE would rewrite a pseudonym while "never rotated" stayed true on paper.
  onEveryEngine("INSERT OR REPLACE and REPLACE INTO change nothing", async (e) => {
    const account = next();
    const first = pseudonym();
    expect(
      await insertRow(e, "compute_gateway_users", { account_id: account, gateway_user: first }),
    ).toBeNull();
    const other = next();
    for (const verb of ["INSERT OR REPLACE INTO", "REPLACE INTO"]) {
      // The same account again, and another account taking this account's pseudonym.
      for (const [id, pseud] of [
        [account, pseudonym()],
        [other, first],
      ] as const) {
        expect([
          verb,
          await e.run(
            `${verb} compute_gateway_users (account_id, gateway_user) VALUES (?, ?)`,
            id,
            pseud,
          ),
        ]).toEqual([verb, null]);
      }
    }
    expect(
      await e.all<Row>(
        "SELECT account_id, gateway_user FROM compute_gateway_users WHERE account_id IN (?, ?)",
        account,
        other,
      ),
    ).toEqual([{ account_id: account, gateway_user: first }]);
  });

  onEveryEngine("INSERT OR IGNORE keeps the first pseudonym of an account", async (e) => {
    const account = next();
    const first = pseudonym();
    expect(
      await insertRow(e, "compute_gateway_users", { account_id: account, gateway_user: first }),
    ).toBeNull();
    expect(
      await e.run(
        "INSERT OR IGNORE INTO compute_gateway_users (account_id, gateway_user) VALUES (?, ?)",
        account,
        pseudonym(),
      ),
    ).toBeNull();
    const stored = (
      await e.all<Row>(
        "SELECT gateway_user FROM compute_gateway_users WHERE account_id = ?",
        account,
      )
    )[0];
    expect(stored?.gateway_user).toBe(first);
  });
});

describe("the triggers", () => {
  // The A2 test of migration 0114's triggers is scoped to its own three tables, so this is what says
  // which triggers 0115's tables have: none on the jobs, exactly three on the pseudonyms.
  onEveryEngine(
    "compute_jobs has none, and compute_gateway_users has exactly its three",
    async (e) => {
      const of = async (table: string) =>
        (
          await e.all<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? ORDER BY name",
            table,
          )
        ).map((r) => r.name);
      expect(await of("compute_jobs")).toEqual([]);
      expect(await of("compute_gateway_users")).toEqual([
        "compute_gateway_users_keeps_first",
        "compute_gateway_users_no_delete",
        "compute_gateway_users_no_update",
      ]);
    },
  );
});

describe("the indexes", () => {
  onEveryEngine("the file creates the idempotency, live and per-account indexes", async (e) => {
    const names = (
      await e.all<{ name: string }>("SELECT name FROM pragma_index_list('compute_jobs')")
    ).map((r) => r.name);
    for (const n of [
      "compute_jobs_idempotency",
      "compute_jobs_live",
      "compute_jobs_account_created",
    ]) {
      expect(names).toContain(n);
    }
    const partial = new Map(
      (
        await e.all<{ name: string; partial: number }>(
          "SELECT name, \"partial\" AS partial FROM pragma_index_list('compute_jobs')",
        )
      ).map((r) => [r.name, r.partial]),
    );
    expect(partial.get("compute_jobs_idempotency")).toBe(1);
    expect(partial.get("compute_jobs_live")).toBe(1);
    expect(partial.get("compute_jobs_account_created")).toBe(0);
  });

  test("a person's live-job count is answered from the partial index, on bun:sqlite", async () => {
    const live = (LIVE_COMPUTE_STATES as readonly string[]).map((s) => `'${s}'`).join(", ");
    const plan = await ENGINES[0]?.all<{ detail: string }>(
      `EXPLAIN QUERY PLAN SELECT COUNT(*) FROM compute_jobs WHERE account_id = ? AND state IN (${live})`,
      1,
    );
    expect(plan?.map((p) => p.detail).join(" | ")).toMatch(
      /USING (COVERING )?INDEX compute_jobs_live/,
    );
  });
});

describe("the pipelines' live count", () => {
  onEveryEngine(
    "is answered from a partial index of the live states, never the whole table, on both engines",
    async (e) => {
      // The statement the hold guards on. It names no account (the cap is NEMAR's pipelines in total), so
      // the planner scans a partial index of the live rows: `compute_jobs_live` or `compute_jobs_examined`,
      // both partial on the same list of states, so the scan is over live jobs only.
      const plan = await e.all<{ detail: string }>(
        `EXPLAIN QUERY PLAN ${PIPELINE_LIVE_JOBS_SQL}`,
        "cpu",
      );
      expect(plan.map((p) => p.detail).join(" | ")).toMatch(
        /USING (COVERING )?INDEX compute_jobs_(live|examined)\b/,
      );
      const partial = new Map(
        (
          await e.all<{ name: string; partial: number }>(
            "SELECT name, \"partial\" AS partial FROM pragma_index_list('compute_jobs')",
          )
        ).map((r) => [r.name, r.partial]),
      );
      expect(partial.get("compute_jobs_live")).toBe(1);
      expect(partial.get("compute_jobs_examined")).toBe(1);
    },
  );
});

describe("the pseudonym table is written in one place", () => {
  const ROOT = join(import.meta.dir, "../..");
  // The table in any spelling: schema-qualified, quoted, bracketed.
  const TABLE = "(?:[\\w\"'`\\[\\]]+\\s*\\.\\s*)?[\"'`\\[]*compute_gateway_users\\b";
  /** Every statement of a text that writes the table: an insert (with any conflict clause), a replace, an update, a delete. */
  const writes = (text: string): string[] =>
    [
      ...text.matchAll(
        new RegExp(
          `(?:INSERT(?:\\s+OR\\s+\\w+)?\\s+INTO|REPLACE\\s+INTO|UPDATE(?:\\s+OR\\s+\\w+)?|DELETE\\s+FROM)\\s+${TABLE}`,
          "gi",
        ),
      ),
    ].map((m) => m[0].replace(/\s+/g, " "));

  test("the scan sees every spelling of a write", () => {
    for (const sql of [
      "INSERT INTO compute_gateway_users (a) VALUES (1)",
      "insert or replace into compute_gateway_users (a) VALUES (1)",
      "INSERT OR IGNORE INTO main.compute_gateway_users (a) VALUES (1)",
      'INSERT OR IGNORE INTO "compute_gateway_users" (a) VALUES (1)',
      "REPLACE INTO compute_gateway_users (a) VALUES (1)",
      "UPDATE compute_gateway_users SET gateway_user = 'x'",
      "UPDATE OR REPLACE compute_gateway_users SET gateway_user = 'x'",
      "DELETE FROM compute_gateway_users",
    ]) {
      expect([sql, writes(sql).length]).toEqual([sql, 1]);
    }
    expect(writes("SELECT gateway_user FROM compute_gateway_users WHERE account_id = 1")).toEqual(
      [],
    );
  });

  test("only the job service's INSERT OR IGNORE, gated on the hold, writes it", () => {
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === ".wrangler") continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|js|mjs|sql)$/.test(entry.name) && !full.endsWith(FILE)) {
          for (const w of writes(readFileSync(full, "utf8")))
            found.push(`${relative(ROOT, full)}: ${w}`);
        }
      }
    };
    for (const dir of ["backend/src", "src", "shared", "scripts"]) {
      if (existsSync(join(ROOT, dir))) walk(join(ROOT, dir));
    }
    expect(found).toEqual([
      "backend/src/services/compute-jobs.ts: INSERT OR IGNORE INTO compute_gateway_users",
    ]);
  });
});
