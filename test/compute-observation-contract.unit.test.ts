/**
 * The observation document `nemar.observation.v1` (epic #2005 phase A7, #2012; ADR 0118, decision 8):
 * the JSON Schema shared byte for byte with `nemarOrg/nemar-process`, the zod schema that mirrors it,
 * and the reading of Slurm's allocation text.
 *
 * What is pinned, each with a test of its own:
 *  - the JSON Schema compiles in strict mode, and Ajv and zod give the same verdict, each with its
 *    expected verdict written beside it, on a corpus of valid and invalid documents (so two schemas that
 *    agree on a wrong answer still fail);
 *  - the two documents the observer itself wrote (`test/fixtures/compute-observation/`) are valid;
 *  - the DRIFT TEST: when `NEMAR_PROCESS_OBSERVATION_DIR` names a nemar-process checkout, the schema and the two
 *    fixtures are compared with that checkout's copies byte for byte. Without one the comparison skips
 *    with its reason; with `NEMAR_REQUIRE_PROCESS_OBSERVATION_DRIFT=1` a missing checkout is a failure. CI
 *    (`.github/workflows/test.yml`, the unit-pure shards) checks out nemar-process's integration branch
 *    `feature/issue-1-epic-process` (public, sparse, no token) and sets both variables, so the
 *    comparison runs there against that branch's HEAD, not against a pinned commit. What CI does NOT
 *    check: that nemar-process's CI is green, or that its pin names this repository's current commit
 *    (that is nemar-process's own test and advisory job). nemar-process runs the mirror of this test
 *    against nemar-cli's files at a pinned commit (`tests/observer/test_observation_schema.py` there);
 *  - `parseAllocTres` reads what Slurm prints and fails closed on anything else.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020";
import {
  OBSERVATION_SCHEMA,
  ObservationDocumentSchema,
  parseAllocTres,
} from "../shared/contract/compute-observation";
import observationSchema from "../shared/contract/compute-observation.schema.json";

const ROOT = join(import.meta.dir, "..");
const SCHEMA_PATH = "shared/contract/compute-observation.schema.json";
const FIXTURE_DIR = "test/fixtures/compute-observation";
const FIXTURES = ["quick.v1.json", "daily.v1.json"] as const;
const PROCESS_SCHEMA_PATH = "observer/schema/observation-v1.schema.json";
const PROCESS_FIXTURE_DIR = "tests/observer/fixtures";

const readJson = (path: string): Record<string, any> =>
  JSON.parse(readFileSync(join(ROOT, path), "utf8"));
const QUICK = readJson(`${FIXTURE_DIR}/quick.v1.json`);
const DAILY = readJson(`${FIXTURE_DIR}/daily.v1.json`);

/** A copy of `doc` with the value at a dotted path replaced (`undefined` deletes the key). */
function set<T>(doc: T, path: string, value: unknown): T {
  const copy = structuredClone(doc) as Record<string, unknown>;
  const parts = path.split(".");
  let cur = copy as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) cur = cur[part] as Record<string, unknown>;
  const last = parts[parts.length - 1] as string;
  if (value === undefined) delete cur[last];
  else cur[last] = value;
  return copy;
}

// Strict, so a mistyped keyword in the schema throws when it compiles instead of being ignored.
const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
const validateAjv = ajv.compile(observationSchema as object);
const validateZod = (doc: unknown) => ObservationDocumentSchema.safeParse(doc).success;

type Case = readonly [label: string, doc: unknown, valid: boolean];

const manyTres = (n: number) =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`item${i}`, "1"]));

const CASES: readonly Case[] = [
  ["the observer's quick document", QUICK, true],
  ["the observer's daily document", DAILY, true],
  [
    "a daily document whose sacct could not be read",
    set(set(DAILY, "accounting", null), "sources.sacct", { status: "failed", detail: "exit_1" }),
    true,
  ],
  [
    "a truncated export",
    set(set(DAILY, "accounting.truncated", true), "accounting.rows_total", 20000),
    true,
  ],
  ["job ids dropped", set(QUICK, "job_ids_dropped", 3), true],
  ["no pending starts read", set(QUICK, "pending_starts", null), true],
  ["no pending starts asked", set(QUICK, "pending_starts", []), true],
  [
    "a partition no source read",
    set(QUICK, "partitions.ghost", {
      available: null,
      nodes: null,
      jobs: null,
      pending_reasons: null,
    }),
    true,
  ],
  ["a partition whose queue is empty", set(QUICK, "partitions.shared.jobs", {}), true],
  [
    "an unparsed balance",
    set(QUICK, "balance.expanse", { status: "unparsed", raw_lines: ["Usage: x"] }),
    true,
  ],
  [
    "an unavailable balance",
    set(QUICK, "balance.expanse_gpu", { status: "unavailable", detail: "not_found" }),
    true,
  ],
  ["a source that timed out", set(QUICK, "sources.sinfo", { status: "timeout" }), true],
  [
    "a source that was skipped",
    set(QUICK, "sources.squeue_start", { status: "skipped", detail: "no_job_ids" }),
    true,
  ],
  [
    "a source that could not be parsed",
    set(QUICK, "sources.sinfo", { status: "unparsed", malformed_rows: 2 }),
    true,
  ],
  [
    "a job with nothing read but its id",
    set(DAILY, "accounting.jobs.0", {
      job_id: "7",
      partition: null,
      state: null,
      elapsed_seconds: null,
      alloc_tres: {},
      submit: null,
      start: null,
      end: null,
    }),
    true,
  ],
  ["a pending array task id", set(DAILY, "accounting.jobs.0.job_id", "123_[1-5]"), true],
  ["32 allocation items", set(DAILY, "accounting.jobs.0.alloc_tres", manyTres(32)), true],
  ["a typed gpu item", set(DAILY, "accounting.jobs.1.alloc_tres", { "gres/gpu:a100": "1" }), true],

  ["the schema word of another version", set(QUICK, "schema", "nemar.observation.v2"), false],
  ["no schema word", set(QUICK, "schema", undefined), false],
  ["a mode that is a dry run", set(QUICK, "mode", "dry_run"), false],
  ["no mode", set(QUICK, "mode", undefined), false],
  ["an unknown top-level key", { ...QUICK, extra: 1 }, false],
  ["the old wire's snapshots", { ...QUICK, snapshots: [] }, false],
  ["an unknown key in a partition", set(QUICK, "partitions.shared.extra", 1), false],
  [
    "an unknown key in the sources",
    set(QUICK, "sources.extra", { status: "ok", malformed_rows: 0 }),
    false,
  ],
  ["an unknown key in a source", set(QUICK, "sources.sinfo.extra", 1), false],
  [
    "an unknown key in the balance",
    set(QUICK, "balance.extra", { status: "unparsed", raw_lines: [] }),
    false,
  ],
  ["an unknown key in a balance project", set(QUICK, "balance.expanse.projects.0.extra", 1), false],
  ["an unknown key in a pending start", set(QUICK, "pending_starts.0.extra", 1), false],
  ["an unknown key in the accounting", set(DAILY, "accounting.extra", 1), false],
  ["an unknown key in an accounting job", set(DAILY, "accounting.jobs.0.extra", 1), false],
  ["an unknown key in job totals", set(QUICK, "partitions.shared.jobs.PENDING.extra", 1), false],
  ["a quick document with accounting", { ...QUICK, accounting: DAILY.accounting }, false],
  [
    "a quick document with sources.sacct",
    set(QUICK, "sources.sacct", { status: "ok", malformed_rows: 0 }),
    false,
  ],
  ["a daily document with no accounting", set(DAILY, "accounting", undefined), false],
  ["a daily document with no sources.sacct", set(DAILY, "sources.sacct", undefined), false],
  ["no balance", set(QUICK, "balance", undefined), false],
  ["no expanse_gpu balance", set(QUICK, "balance.expanse_gpu", undefined), false],
  ["no pending_starts", set(QUICK, "pending_starts", undefined), false],
  ["observed_at with no Z", set(QUICK, "observed_at", "2026-11-04T12:00:00"), false],
  [
    "observed_at with a trailing newline",
    set(QUICK, "observed_at", "2026-11-04T12:00:00Z\n"),
    false,
  ],
  ["an observer version with a space", set(QUICK, "observer_version", "0.1 0"), false],
  ["job_ids_dropped of zero", set(QUICK, "job_ids_dropped", 0), false],
  ["a negative count", set(QUICK, "partitions.shared.jobs.PENDING.jobs", -1), false],
  ["a fractional count", set(QUICK, "partitions.shared.jobs.PENDING.cpus", 1.5), false],
  ["a count as text", set(QUICK, "partitions.shared.jobs.PENDING.jobs", "3"), false],
  [
    "a partition name with a space",
    set(QUICK, "partitions.shared queue", {
      available: null,
      nodes: null,
      jobs: null,
      pending_reasons: null,
    }),
    false,
  ],
  [
    "a partition name of 129 characters",
    set(QUICK, `partitions.${"p".repeat(129)}`, {
      available: null,
      nodes: null,
      jobs: null,
      pending_reasons: null,
    }),
    false,
  ],
  ["an upper-case node state", set(QUICK, "partitions.shared.nodes", { IDLE: 1 }), false],
  [
    "a lower-case job state",
    set(QUICK, "partitions.shared.jobs", { pending: { jobs: 1, nodes: 1, cpus: 1 } }),
    false,
  ],
  ["a partition with no jobs key", set(QUICK, "partitions.shared.jobs", undefined), false],
  ["a source ok with no row count", set(QUICK, "sources.sinfo", { status: "ok" }), false],
  [
    "a source failed with a row count",
    set(QUICK, "sources.sinfo", { status: "failed", malformed_rows: 0 }),
    false,
  ],
  ["a source with an unknown status", set(QUICK, "sources.sinfo", { status: "fine" }), false],
  [
    "a source detail with a capital",
    set(QUICK, "sources.sinfo", { status: "failed", detail: "Exit_1" }),
    false,
  ],
  ["a balance with an unknown status", set(QUICK, "balance.expanse", { status: "maybe" }), false],
  [
    "an unparsed balance with 51 lines",
    set(QUICK, "balance.expanse", { status: "unparsed", raw_lines: Array(51).fill("x") }),
    false,
  ],
  [
    "an unparsed balance line of 201 characters",
    set(QUICK, "balance.expanse", { status: "unparsed", raw_lines: ["x".repeat(201)] }),
    false,
  ],
  [
    "a pending start time with a space",
    set(QUICK, "pending_starts.0.expected_start", "2026-11-05 09:15:00"),
    false,
  ],
  ["a pending start id with letters", set(QUICK, "pending_starts.0.job_id", "12a"), false],
  ["a truncated flag that is text", set(DAILY, "accounting.truncated", "false"), false],
  [
    "an accounting day with a trailing newline",
    set(DAILY, "accounting.day", "2026-11-03\n"),
    false,
  ],
  ["a job id with letters", set(DAILY, "accounting.jobs.0.job_id", "12ab"), false],
  ["a job id with a trailing newline", set(DAILY, "accounting.jobs.0.job_id", "5001\n"), false],
  [
    "a job id that starts with an underscore",
    set(DAILY, "accounting.jobs.0.job_id", "_5001"),
    false,
  ],
  ["a job state with a digit", set(DAILY, "accounting.jobs.0.state", "FAILED2"), false],
  [
    "a job state with a trailing note",
    set(DAILY, "accounting.jobs.0.state", "CANCELLED by 1234"),
    false,
  ],
  ["negative elapsed time", set(DAILY, "accounting.jobs.0.elapsed_seconds", -1), false],
  ["elapsed time as text", set(DAILY, "accounting.jobs.0.elapsed_seconds", "3723"), false],
  ["33 allocation items", set(DAILY, "accounting.jobs.0.alloc_tres", manyTres(33)), false],
  [
    "an allocation value that is a number",
    set(DAILY, "accounting.jobs.0.alloc_tres", { cpu: 8 }),
    false,
  ],
  [
    "an allocation value of 65 characters",
    set(DAILY, "accounting.jobs.0.alloc_tres", { cpu: "1".repeat(65) }),
    false,
  ],
  [
    "an allocation item name of 65 characters",
    set(DAILY, "accounting.jobs.0.alloc_tres", { ["k".repeat(65)]: "1" }),
    false,
  ],
  [
    "an allocation that is a string",
    set(DAILY, "accounting.jobs.0.alloc_tres", "cpu=8,mem=16G"),
    false,
  ],
  ["no allocation key on a job", set(DAILY, "accounting.jobs.0.alloc_tres", undefined), false],
  ["a job time without a T", set(DAILY, "accounting.jobs.0.start", "2026-11-03 10:05:00"), false],
  ["jobs that are not a list", set(DAILY, "accounting.jobs", {}), false],
  ["a document that is a list", [], false],
  ["a document that is null", null, false],
];

// --- the bounds, each at the limit and one past it ----------------------------------------------------
// A bound changed in one schema only (a `.max(6000)` in zod, a `maxItems` in the JSON Schema) must fail
// here: the corpus holds every bound at its limit (valid) and at limit + 1 (invalid).

const times = <T>(n: number, make: (i: number) => T): T[] =>
  Array.from({ length: n }, (_, i) => make(i));
const EMPTY_PARTITION = { available: null, nodes: null, jobs: null, pending_reasons: null };
const manyPartitions = (n: number) =>
  Object.fromEntries(times(n, (i) => [`p${i}`, EMPTY_PARTITION]));
const dailyJobs = (n: number) =>
  set(
    set(
      DAILY,
      "accounting.jobs",
      times(n, (i) => ({ ...DAILY.accounting.jobs[0], job_id: String(i + 1) })),
    ),
    "accounting.rows_total",
    n,
  );
const pendingStarts = (n: number) =>
  times(n, (i) => ({
    job_id: String(i + 1),
    partition: "shared",
    state: "PENDING",
    expected_start: null,
  }));
const projects = (n: number) =>
  times(n, (i) => ({ project: `prj${i}`, used: 0, available: 0, used_by_project: 0 }));
const MAX_COUNT = 999_999_999_999;

const BOUND_CASES: readonly Case[] = [
  ["5000 accounting jobs", dailyJobs(5000), true],
  ["5001 accounting jobs", dailyJobs(5001), false],
  ["5000 partitions", set(QUICK, "partitions", manyPartitions(5000)), true],
  ["5001 partitions", set(QUICK, "partitions", manyPartitions(5001)), false],
  ["5000 pending starts", set(QUICK, "pending_starts", pendingStarts(5000)), true],
  ["5001 pending starts", set(QUICK, "pending_starts", pendingStarts(5001)), false],
  [
    "1000 balance projects",
    set(QUICK, "balance.expanse", { status: "parsed", projects: projects(1000) }),
    true,
  ],
  [
    "1001 balance projects",
    set(QUICK, "balance.expanse", { status: "parsed", projects: projects(1001) }),
    false,
  ],
  [
    "50 raw balance lines of 200 characters",
    set(QUICK, "balance.expanse", {
      status: "unparsed",
      raw_lines: times(50, () => "x".repeat(200)),
    }),
    true,
  ],
  ["an observer version of 32 characters", set(QUICK, "observer_version", "v".repeat(32)), true],
  ["an observer version of 33 characters", set(QUICK, "observer_version", "v".repeat(33)), false],
  [
    "a pending start state of 32 characters",
    set(QUICK, "pending_starts.0.state", "S".repeat(32)),
    true,
  ],
  [
    "a pending start state of 33 characters",
    set(QUICK, "pending_starts.0.state", "S".repeat(33)),
    false,
  ],
  [
    "an availability word of 32 characters",
    set(QUICK, "partitions.shared.available", "a".repeat(32)),
    true,
  ],
  [
    "an availability word of 33 characters",
    set(QUICK, "partitions.shared.available", "a".repeat(33)),
    false,
  ],
  [
    "a partition name of 128 characters",
    set(QUICK, `partitions.${"p".repeat(128)}`, EMPTY_PARTITION),
    true,
  ],
  ["a job id of 64 characters", set(DAILY, "accounting.jobs.0.job_id", "1".repeat(64)), true],
  ["a job id of 65 characters", set(DAILY, "accounting.jobs.0.job_id", "1".repeat(65)), false],
  [
    "an allocation value of 64 characters",
    set(DAILY, "accounting.jobs.0.alloc_tres", { cpu: "1".repeat(64) }),
    true,
  ],
  ["a count at the largest", set(QUICK, "partitions.shared.jobs.PENDING.jobs", MAX_COUNT), true],
  [
    "a count past the largest",
    set(QUICK, "partitions.shared.jobs.PENDING.jobs", MAX_COUNT + 1),
    false,
  ],
  [
    "a malformed-row count past the largest",
    set(QUICK, "sources.sinfo.malformed_rows", MAX_COUNT + 1),
    false,
  ],
  [
    "a balance amount past the largest",
    set(QUICK, "balance.expanse.projects.0.used", MAX_COUNT + 1),
    false,
  ],
  ["a quick document with accounting null", set(QUICK, "accounting", null), false],
];

describe("the JSON Schema and the zod schema agree", () => {
  test("the schema is draft 2020-12, has the schema word as a constant, and compiles in strict mode", () => {
    expect((observationSchema as { $schema: string }).$schema).toBe(
      "https://json-schema.org/draft/2020-12/schema",
    );
    expect(
      (observationSchema as { properties: { schema: { const: string } } }).properties.schema.const,
    ).toBe(OBSERVATION_SCHEMA);
    expect(OBSERVATION_SCHEMA).toBe("nemar.observation.v1");
  });

  test("every object the observer writes is closed", () => {
    const open: string[] = [];
    const walk = (node: unknown, path: string) => {
      if (Array.isArray(node)) {
        node.forEach((n, i) => walk(n, `${path}[${i}]`));
        return;
      }
      if (node === null || typeof node !== "object") return;
      const o = node as Record<string, unknown>;
      if (o.type === "object" && o.properties !== undefined && o.additionalProperties !== false) {
        open.push(path);
      }
      for (const [k, v] of Object.entries(o)) walk(v, `${path}.${k}`);
    };
    walk(observationSchema, "$");
    expect(open).toEqual([]);
  });

  test("Ajv and zod give every bound the same verdict at its limit and one past it (MUTATION: change a bound in one schema)", () => {
    expect(BOUND_CASES.filter(([, , valid]) => valid).length).toBeGreaterThan(8);
    expect(BOUND_CASES.filter(([, , valid]) => !valid).length).toBeGreaterThan(8);
    for (const [label, doc, valid] of BOUND_CASES) {
      expect(validateAjv(doc), `JSON Schema: ${label}`).toBe(valid);
      expect(validateZod(doc), `zod: ${label}`).toBe(valid);
    }
  });

  test("Ajv and zod give every document the verdict written beside it", () => {
    expect(CASES.some(([, , valid]) => valid)).toBe(true);
    expect(CASES.some(([, , valid]) => !valid)).toBe(true);
    for (const [label, doc, valid] of CASES) {
      expect(validateAjv(doc), `JSON Schema: ${label}`).toBe(valid);
      expect(validateZod(doc), `zod: ${label}`).toBe(valid);
    }
  });

  test("the fixtures are what the observer wrote: both modes, with pending starts and a typed gpu row", () => {
    expect(QUICK.mode).toBe("quick");
    expect(DAILY.mode).toBe("daily");
    expect(QUICK.pending_starts.length).toBe(2);
    expect(DAILY.accounting.jobs.map((j: { job_id: string }) => j.job_id)).toEqual([
      "5001",
      "5002",
      "5003",
    ]);
    expect(DAILY.accounting.jobs[1].alloc_tres["gres/gpu"]).toBe("1");
    expect(DAILY.accounting.jobs[2].start).toBeNull();
  });
});

describe("drift against nemar-process", () => {
  const dir = process.env.NEMAR_PROCESS_OBSERVATION_DIR;
  const required = process.env.NEMAR_REQUIRE_PROCESS_OBSERVATION_DRIFT === "1";
  const checkout = dir && existsSync(join(dir, PROCESS_SCHEMA_PATH)) ? dir : null;

  test.skipIf(checkout !== null || !required)(
    "NEMAR_REQUIRE_PROCESS_OBSERVATION_DRIFT=1 needs NEMAR_PROCESS_OBSERVATION_DIR to name a nemar-process checkout",
    () => {
      throw new Error(`no ${PROCESS_SCHEMA_PATH} under NEMAR_PROCESS_OBSERVATION_DIR=${dir ?? "(unset)"}`);
    },
  );

  test.skipIf(checkout === null)("the schema is nemar-process's copy, byte for byte", () => {
    const ours = readFileSync(join(ROOT, SCHEMA_PATH));
    const theirs = readFileSync(join(checkout as string, PROCESS_SCHEMA_PATH));
    expect(Buffer.compare(ours, theirs)).toBe(0);
  });

  for (const name of FIXTURES) {
    test.skipIf(checkout === null)(`the fixture ${name} is the observer's, byte for byte`, () => {
      const ours = readFileSync(join(ROOT, FIXTURE_DIR, name));
      const theirs = readFileSync(
        join(checkout as string, PROCESS_FIXTURE_DIR, `observation-${name}`),
      );
      expect(Buffer.compare(ours, theirs)).toBe(0);
    });
  }
});

describe("parseAllocTres", () => {
  const ok = (tres: Record<string, string>) => {
    const r = parseAllocTres(tres);
    if (!r.ok) throw new Error(`refused ${r.item}`);
    return r.value;
  };

  test("reads the items Slurm prints for a CPU job and a GPU job", () => {
    expect(ok({ billing: "8", cpu: "8", mem: "16G", node: "1" })).toEqual({
      nodes: 1,
      cpus: 8,
      gpus: null,
      memMb: 16384,
    });
    expect(ok({ billing: "10", cpu: "10", "gres/gpu": "1", mem: "92G", node: "1" })).toEqual({
      nodes: 1,
      cpus: 10,
      gpus: 1,
      memMb: 94208,
    });
  });

  test("an empty allocation is nothing read, never zero", () => {
    expect(ok({})).toEqual({ nodes: null, cpus: null, gpus: null, memMb: null });
  });

  test("memory in every unit is MB, rounded up (MUTATION: floor, or 1000 for 1024)", () => {
    const mem = (m: string) => ok({ mem: m }).memMb;
    expect(mem("0")).toBe(0);
    expect(mem("512K")).toBe(1);
    expect(mem("1024K")).toBe(1);
    expect(mem("1025K")).toBe(2);
    expect(mem("1M")).toBe(1);
    expect(mem("8000M")).toBe(8000);
    expect(mem("1G")).toBe(1024);
    expect(mem("1.50G")).toBe(1536);
    expect(mem("0.001G")).toBe(2);
    expect(mem("2T")).toBe(2_097_152);
    expect(mem("500G")).toBe(512_000);
  });

  test("GPUs: the plain item, or the typed ones added up, and a typed one beside the plain one is not counted twice", () => {
    expect(ok({ "gres/gpu": "4", "gres/gpu:a100": "4" }).gpus).toBe(4);
    expect(ok({ "gres/gpu:a100": "2", "gres/gpu:v100": "1" }).gpus).toBe(3);
    expect(ok({ "gres/gpumem": "80G" }).gpus).toBeNull();
    expect(ok({ "gres/gpu": "0" }).gpus).toBe(0);
  });

  test("items it does not read are ignored, whatever they say", () => {
    expect(ok({ billing: "x", energy: "?", "fs/disk": "-", cpu: "2" }).cpus).toBe(2);
  });

  test("a value it cannot read is a failure naming the item, never a guess (MUTATION: accept a malformed string)", () => {
    const bad: Array<[Record<string, string>, string]> = [
      [{ cpu: "" }, "cpu"],
      [{ cpu: "four" }, "cpu"],
      [{ cpu: "-1" }, "cpu"],
      [{ cpu: "1.5" }, "cpu"],
      [{ cpu: "08" }, "cpu"],
      [{ cpu: "4 " }, "cpu"],
      [{ cpu: "4\n" }, "cpu"],
      [{ cpu: "1e3" }, "cpu"],
      [{ cpu: "0x10" }, "cpu"],
      [{ cpu: "10000001" }, "cpu"],
      [{ cpu: "9999999999999" }, "cpu"],
      [{ cpu: "4G" }, "cpu"],
      [{ node: "x" }, "node"],
      [{ node: "100001" }, "node"],
      [{ mem: "16" }, "mem"],
      [{ mem: "G" }, "mem"],
      [{ mem: "16g" }, "mem"],
      [{ mem: "16GB" }, "mem"],
      [{ mem: "1.5" }, "mem"],
      [{ mem: "1.5555G" }, "mem"],
      [{ mem: "-1G" }, "mem"],
      [{ mem: "16G\n" }, "mem"],
      [{ mem: "1P" }, "mem"],
      [{ "gres/gpu": "one" }, "gpu"],
      [{ "gres/gpu": "-1" }, "gpu"],
      [{ "gres/gpu": "1000001" }, "gpu"],
      [{ "gres/gpu:a100": "x" }, "gpu"],
      [{ "gres/gpu:a100": "1000000", "gres/gpu:v100": "1" }, "gpu"],
    ];
    for (const [tres, item] of bad) {
      expect([JSON.stringify(tres), parseAllocTres(tres)]).toEqual([
        JSON.stringify(tres),
        { ok: false, item },
      ]);
    }
  });

  test("one bad item fails the whole string, even beside good ones", () => {
    expect(parseAllocTres({ cpu: "4", mem: "lots", node: "1" })).toEqual({
      ok: false,
      item: "mem",
    });
  });

  test("a key that is only inherited is not an item (__proto__, constructor)", () => {
    expect(ok({}).cpus).toBeNull();
    const withProto = JSON.parse('{"__proto__": "7", "cpu": "1"}');
    expect(ok(withProto).cpus).toBe(1);
  });
});
