/**
 * Index format v3 on the CONSUMER side (issues #1059, #1197; epic #1181 phase 7).
 *
 * Three things have to hold at once:
 *
 * 1. `aggregateRecordingStats` reads v1 and v3. v3 is additive for everything
 *    this backend reads, so the same code path must produce the old answer on an
 *    old index and the fuller answer on a new one -- no version branch, no
 *    regression for the ~800 datasets whose published index is still v1.
 * 2. Pending recordings COUNT. on008083 published 43 raw recordings as 2 stores
 *    and 36 failures, with five in no list at all; every number derived from that
 *    index was quietly short by five, and nothing anywhere said so (#1197).
 * 3. The two new counts reach D1 inside the existing bounded summary object and
 *    NOT as new columns (ADR 0034/0036), including in the case that motivated
 *    them: pending recordings with no failures at all, which used to leave
 *    `zarr_data_failures` NULL.
 *
 * The handler tests drive the REAL Hono route against a real D1 (bun:sqlite plus
 * the actual migrations), like zarr-pool-breaks.test.ts -- not a copy of its SQL,
 * which could not catch a divergence between the copy and the handler.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import v3Fixture from "../../test/fixtures/zarr-index-v3.json";
import {
  parseZarrReadyBody,
  registerZarrReadyRoutes,
  zarrFailureColumns,
} from "../src/routes/callbacks/zarr-ready";
import { SCHEMA_NAMES, schemaRoutes } from "../src/routes/schemas";
import { type ZarrIndexJson, aggregateRecordingStats, getZarrIndex } from "../src/services/s3";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import { installWorkersTimingSafeEqual } from "./helpers/workers-crypto";

// Real constant-time comparison for the Workers-only
// `crypto.subtle.timingSafeEqual` the zarr-ready handler's token check needs
// (bun's runtime lacks it). See helpers/workers-crypto.ts for why this isn't
// a mock and why it's still installed now that lib/constant-time.ts feature-
// detects this itself: it keeps this suite exercising the native branch.
installWorkersTimingSafeEqual();

const TOKEN = "zarr-index-v3-webhook-token";
const DATASET = "on008083";

/** A group as the converter writes it, with the v3 geometry fields. */
const group = (overrides: Record<string, unknown> = {}) => ({
  name: "eeg_250hz",
  modality: "EEG",
  rate: 250,
  n_channels: 129,
  n_samples: 43_000,
  duration_s: 172,
  n_view_levels: 4,
  view_chunk_columns: 1024,
  source_rate_hz: 500,
  chunk_samples: 1000,
  shard_samples: 75_000,
  ...overrides,
});

/** A v1 index: no `pending`, no `discovered_count`, per-store `source_key`. */
const v1Index = (): ZarrIndexJson =>
  ({
    dataset_id: DATASET,
    format: "nemar-zarr-index",
    format_version: 1,
    source_commit: "a".repeat(40),
    store_count: 2,
    stores: [
      {
        path: "sub-01/eeg/a_eeg.edf",
        zarr: "sub-01/eeg/a_eeg.zarr",
        source_key: "SHA256E-s1--a",
        groups: [group()],
      },
      {
        path: "sub-02/eeg/b_eeg.edf",
        zarr: "sub-02/eeg/b_eeg.zarr",
        source_key: "SHA256E-s2--b",
        groups: [group({ duration_s: 200, n_channels: 64 })],
      },
    ],
    failure_count: 1,
    failures: [{ path: "sub-03/eeg/c_eeg.edf", code: "file_read_error", reason: "..." }],
  }) as unknown as ZarrIndexJson;

/**
 * The same dataset in v3: the five silent recordings are now `pending`.
 *
 * Read from the CHECKED-IN fixture rather than written inline, because the
 * inline one was not a document the producer could ever have published: it
 * inherited v1's per-store `source_key` (removed in v3) and carried neither
 * `layout` nor `updated_utc`, both of which the schema requires. Every
 * assertion below about what a consumer derives from "a v3 index" was
 * therefore made against a shape that would have been refused at upload.
 * `test/zarr-schema-contract.test.ts` validates this exact file against
 * `shared/zarr-index.schema.json`, so it cannot drift back out of contract.
 */
const v3Index = (overrides: Partial<Record<string, unknown>> = {}): ZarrIndexJson =>
  ({ ...v3Fixture, ...overrides }) as unknown as ZarrIndexJson;

describe("aggregateRecordingStats spans index v1 and v3", () => {
  test("a v1 index yields exactly what it always did", () => {
    const stats = aggregateRecordingStats(v1Index());
    expect(stats.recordingCount).toBe(3); // 2 stores + 1 failure
    expect(stats.recordingsUnavailable).toBe(1);
    expect(stats.recordingsMeasured).toBe(2);
    expect(stats.totalRecordingDuration).toBe(372);
    expect(stats.recordingDurationMin).toBe(172);
    expect(stats.recordingDurationMax).toBe(200);
    expect(stats.channelCountMin).toBe(64);
    expect(stats.channelCountMax).toBe(129);
  });

  test("a v3 index counts pending recordings as existing and unavailable", () => {
    const stats = aggregateRecordingStats(v3Index());
    // 5 discovered, not 3: the two pending recordings exist in the dataset and
    // have no viewer. Reporting 3 is what made on008083 look complete.
    expect(stats.recordingCount).toBe(5);
    expect(stats.recordingsUnavailable).toBe(3); // 1 failed + 2 pending
    // Durations are untouched by coverage accounting -- only stores are measured.
    expect(stats.recordingsMeasured).toBe(2);
    expect(stats.totalRecordingDuration).toBe(372);
  });

  test("discovered_count is used as the denominator when it checks out", () => {
    // 2 stores + 1 failure + 2 pending = 5, which is what the fixture declares.
    const stats = aggregateRecordingStats(v3Index());
    expect(stats.recordingCount).toBe(5);
  });

  test("a discovered_count that disagrees with the sum is not believed", () => {
    // The producer enforces `discovered == store + failure + pending` before it
    // publishes, so a disagreement means one of the two is wrong -- and the sum
    // is the one derived from data this function can actually see. A stale
    // single integer (a partially rewritten index) would otherwise silently
    // become the denominator of every coverage number downstream.
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      const stats = aggregateRecordingStats(v3Index({ discovered_count: 43 }));
      expect(stats.recordingCount).toBe(5);
    } finally {
      console.warn = realWarn;
    }
    // And it says so: a fallback nobody can see is how the disagreement would
    // persist unnoticed.
    expect(warnings.join(" ")).toContain("coverage disagrees");
    expect(warnings.join(" ")).toContain("43");
  });

  test("the counts fall back to the arrays when the fields are missing", () => {
    const stats = aggregateRecordingStats(
      v3Index({
        discovered_count: undefined,
        pending_count: undefined,
        store_count: undefined,
        failure_count: undefined,
      }),
    );
    expect(stats.recordingCount).toBe(5); // 2 stores + 1 failure + 2 pending
    expect(stats.recordingsUnavailable).toBe(3);
  });

  test("a garbage pending_count is rejected, not clamped into the total", () => {
    for (const bad of [-4, Number.NaN, Number.POSITIVE_INFINITY, "7", null]) {
      const stats = aggregateRecordingStats(
        v3Index({ pending_count: bad, discovered_count: undefined }),
      );
      // Falls back to pending.length (2), never to a negative or NaN total.
      expect(stats.recordingCount).toBe(5);
    }
  });

  test("v3 geometry fields do not disturb the aggregation", () => {
    // `source_rate_hz` is the ACQUISITION rate and `rate` the serving cap; a
    // reader that confused them would report the wrong durations here.
    const stats = aggregateRecordingStats(v3Index());
    expect(stats.recordingDurationMax).toBe(200);
  });

  test("an empty index is zero recordings, not null durations of one", () => {
    const stats = aggregateRecordingStats({} as ZarrIndexJson);
    expect(stats.recordingCount).toBe(0);
    expect(stats.recordingsUnavailable).toBe(0);
    expect(stats.totalRecordingDuration).toBeNull();
  });
});

describe("zarrFailureColumns carries the coverage counts", () => {
  test("pending and discovered ride in the bounded summary", () => {
    const f = zarrFailureColumns({
      errors: 41,
      failure_count: 36,
      deterministic: false,
      data_failures: Array.from({ length: 36 }, (_, i) => ({ path: `p${i}` })),
      pending_count: 5,
      discovered_count: 43,
    });
    expect(JSON.parse(f.dataFailuresJson as string)).toEqual({
      count: 36,
      detail_ref: "zarr/index.json",
      pending: 5,
      discovered: 43,
    });
  });

  test("pending alone is enough to write the summary", () => {
    // The case the old shape lost entirely: no typed failures, five recordings
    // outstanding, column NULL, recordings invisible (#1197).
    const f = zarrFailureColumns({ errors: 5, pending_count: 5, discovered_count: 43 });
    const parsed = JSON.parse(f.dataFailuresJson as string);
    expect(parsed.count).toBe(0);
    expect(parsed.pending).toBe(5);
    expect(parsed.discovered).toBe(43);
  });

  test("a clean run still writes no summary at all", () => {
    const f = zarrFailureColumns({ errors: 0, pending_count: 0, discovered_count: 41 });
    expect(f.dataFailuresJson).toBeNull();
    expect(f.hadErrors).toBe(false);
  });

  test("an old converter sending neither count keeps the #1191 shape", () => {
    const f = zarrFailureColumns({ errors: 1, data_failures: [{ path: "a" }] });
    expect(JSON.parse(f.dataFailuresJson as string)).toEqual({
      count: 1,
      detail_ref: "zarr/index.json",
    });
  });

  test("garbage counts are omitted rather than persisted", () => {
    const f = zarrFailureColumns({
      errors: 1,
      data_failures: [{ path: "a" }],
      pending_count: -3,
      discovered_count: Number.NaN,
    });
    const parsed = JSON.parse(f.dataFailuresJson as string);
    expect(parsed).not.toHaveProperty("pending");
    expect(parsed).not.toHaveProperty("discovered");
  });

  test("the summary stays bounded no matter how many recordings failed", () => {
    // #1188/#1189: an 877-entry array was 178 KB in one row and made the D1
    // backup unrestorable. Row size must not scale with the failure count.
    const big = zarrFailureColumns({
      errors: 900,
      failure_count: 877,
      data_failures: Array.from({ length: 877 }, (_, i) => ({ path: `p${i}`, code: "x" })),
      pending_count: 23,
      discovered_count: 900,
    });
    expect((big.dataFailuresJson as string).length).toBeLessThan(120);
  });
});

describe("POST /webhooks/zarr-ready persists the coverage counts", () => {
  let db: Database;
  let app: Hono<{ Bindings: Bindings }>;

  const post = (body: Record<string, unknown>) =>
    app.request(
      "/zarr-ready",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Webhook-Token": TOKEN },
        body: JSON.stringify(body),
      },
      { DB: realD1(db), NEMAR_WEBHOOK_TOKEN: TOKEN, ENVIRONMENT: "test" } as Bindings,
    );

  const row = () =>
    db.query("SELECT * FROM datasets WHERE dataset_id = ?").get(DATASET) as Record<string, unknown>;

  beforeEach(() => {
    db = freshDb();
    app = new Hono<{ Bindings: Bindings }>();
    registerZarrReadyRoutes(app);
    db.query(
      `INSERT INTO users (username, email, password_hash, status, role, email_verified)
       VALUES ('covowner', 'covowner@example.org', 'x', 'approved', 'user', 1)`,
    ).run();
    const owner = db
      .query<{ id: number }, []>("SELECT id FROM users WHERE username='covowner'")
      .get();
    if (!owner) throw new Error("seed: owner insert failed");
    db.query(
      `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility)
       VALUES (?, 'Coverage fixture', ?, 'active', 'public')`,
    ).run(DATASET, owner.id);
  });

  test("a ready run records pending and discovered without a new column", async () => {
    const res = await post({
      dataset_id: DATASET,
      status: "ready",
      store_count: 2,
      errors: 41,
      failure_count: 36,
      data_failures: [{ path: "sub-03/eeg/c_eeg.edf", code: "file_read_error" }],
      pending_count: 5,
      discovered_count: 43,
    });
    expect(res.status).toBe(200);
    const r = row();
    expect(r.zarr_status).toBe("ready");
    expect(r.zarr_store_count).toBe(2);
    const summary = JSON.parse(r.zarr_data_failures as string);
    expect(summary.pending).toBe(5);
    expect(summary.discovered).toBe(43);
    expect(summary.detail_ref).toBe("zarr/index.json");
    // No column was added for either count (ADR 0034).
    expect(Object.keys(r)).not.toContain("zarr_pending_count");
    expect(Object.keys(r)).not.toContain("zarr_discovered_count");
  });

  test("the summary log names the sibling documents, and warns when one is missing", async () => {
    // The only place these are visible to anyone not tailing the conversion
    // node's cron log: neither has a column (ADR 0034) and neither fails the
    // run, so an unpublished sibling would otherwise be silent.
    const lines: string[] = [];
    const warnings: string[] = [];
    const realLog = console.log;
    const realWarn = console.warn;
    console.log = (...args: unknown[]) => lines.push(args.join(" "));
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
    try {
      await post({
        dataset_id: DATASET,
        status: "ready",
        store_count: 2,
        events_row_count: 5120,
        events_upload_failed: false,
        manifest_upload_failed: false,
        events_stores_without_rows: 0,
      });
      await post({
        dataset_id: DATASET,
        status: "ready",
        store_count: 2,
        events_row_count: null,
        events_upload_failed: true,
        manifest_upload_failed: true,
        events_stores_without_rows: 3,
      });
    } finally {
      console.log = realLog;
      console.warn = realWarn;
    }
    const summaries = lines.filter((l) => l.includes("[zarr-ready] dataset="));
    expect(summaries[0]).toContain("events_rows=5120");
    // Validated and then never read is the same as not validated: these three
    // have no column and no other consumer, so the log line is where they exist.
    expect(summaries[0]).toContain("not_attempted=?");
    expect(summaries[0]).toContain("non_raw_dropped=?");
    expect(summaries[0]).toContain("provenance_fetch_failed=?");
    expect(summaries[0]).toContain("events_upload_failed=false");
    expect(summaries[0]).toContain("manifest_upload_failed=false");
    expect(summaries[0]).toContain("events_stores_without_rows=0");
    // The per-store signal has no column either; the count is the only
    // off-node trace of a store whose events.tsv yielded nothing.
    expect(summaries[1]).toContain("events_stores_without_rows=3");
    const rowless = warnings.filter((w) => w.includes("produced no event rows"));
    expect(rowless).toHaveLength(1);
    expect(rowless[0]).toContain("3 store(s)");
    // A healthy run says so and warns about nothing.
    expect(warnings.some((w) => w.includes("WITHOUT"))).toBe(true);
    const missing = warnings.filter((w) => w.includes("WITHOUT"));
    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain("events.parquet + manifest.json");
    expect(summaries[1]).toContain("events_rows=none");
  });

  test("the operational counts with no column reach the summary log", async () => {
    // `not_attempted_count`, `non_raw_dropped` and `provenance_fetch_failed` are
    // validated by the schema and persisted by nothing: a subset of `pending`
    // the bounded summary does not break out, a per-run fact about carried-over
    // stores (ADR 0027), and the reason this wave's provenance fields are null.
    // If they are not on this line they are nowhere off-node.
    const lines: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]) => lines.push(args.join(" "));
    try {
      await post({
        dataset_id: DATASET,
        status: "ready",
        store_count: 2,
        pending_count: 5,
        discovered_count: 43,
        not_attempted_count: 3,
        non_raw_dropped: 92,
        provenance_fetch_failed: true,
      });
    } finally {
      console.log = realLog;
    }
    const summary = lines.find((l) => l.includes("[zarr-ready] dataset="));
    expect(summary).toContain("not_attempted=3");
    expect(summary).toContain("non_raw_dropped=92");
    // The stores in this wave carry null doi/license/citation/hed_version
    // because the CATALOG READ failed, not because the data lacks them. Without
    // this on the line, "nothing to publish" and "we could not find out" are
    // the same row to anyone off the node.
    expect(summary).toContain("provenance_fetch_failed=true");
  });

  test("a fractional store_count is dropped, never bound into D1", async () => {
    // The column is INTEGER but D1 binds what it is given, and SQLite keeps a
    // REAL in an INTEGER column as-is. Before `.int()` a converter bug reporting
    // 2.7 stores persisted 2.7 and every consumer downstream inherited a count no
    // counting could produce. The rest of the body must still land, which is the
    // whole point of per-field `.catch(undefined)`.
    const realWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
    let res: Response;
    try {
      res = await post({
        dataset_id: DATASET,
        status: "ready",
        store_count: 2.7,
        commit: "b".repeat(40),
        errors: 0,
      });
    } finally {
      console.warn = realWarn;
    }
    expect(res.status).toBe(200);
    const r = row();
    expect(r.zarr_store_count).toBeNull();
    expect(Number.isInteger(r.zarr_store_count ?? 0)).toBe(true);
    // The neighbouring fields survived the one bad one.
    expect(r.zarr_source_commit).toBe("b".repeat(40));
    expect(r.zarr_status).toBe("ready");
    expect(warnings.join(" ")).toContain("store_count");
  });

  test("every count field rejects a fractional value", () => {
    // One primitive covers them all, so the guard is asserted once across the
    // list rather than per field: a future count declared with a bare
    // `z.number()` would show up here.
    const realWarn = console.warn;
    console.warn = () => {};
    try {
      for (const field of [
        "store_count",
        "errors",
        "failure_count",
        "pool_breaks",
        "measured_count",
        "pending_count",
        "discovered_count",
        "not_attempted_count",
        "non_raw_dropped",
        "events_row_count",
        "events_stores_without_rows",
      ]) {
        const body = parseZarrReadyBody({
          dataset_id: DATASET,
          status: "ready",
          [field]: 1.5,
        }) as Record<string, unknown> | null;
        expect(body).not.toBeNull();
        expect(body?.[field]).toBeUndefined();
      }
    } finally {
      console.warn = realWarn;
    }
  });

  test("a failed run records them too", async () => {
    // A total failure is exactly when coverage matters most, and it is the
    // branch that historically dropped fields (see zarr-pool-breaks.test.ts).
    const res = await post({
      dataset_id: DATASET,
      status: "failed",
      errors: 43,
      pending_count: 43,
      discovered_count: 43,
    });
    expect(res.status).toBe(200);
    const summary = JSON.parse(row().zarr_data_failures as string);
    expect(summary.pending).toBe(43);
    expect(summary.discovered).toBe(43);
  });

  test("a clean run clears a prior coverage summary", async () => {
    await post({
      dataset_id: DATASET,
      status: "ready",
      store_count: 2,
      errors: 5,
      pending_count: 5,
      discovered_count: 43,
    });
    expect(row().zarr_data_failures).not.toBeNull();

    await post({
      dataset_id: DATASET,
      status: "ready",
      store_count: 43,
      errors: 0,
      pending_count: 0,
      discovered_count: 43,
    });
    expect(row().zarr_data_failures).toBeNull();
    expect(row().zarr_failed_at).toBeNull();
  });

  test("an old converter that sends neither count still succeeds", async () => {
    const res = await post({ dataset_id: DATASET, status: "ready", store_count: 7 });
    expect(res.status).toBe(200);
    expect(row().zarr_store_count).toBe(7);
  });

  test("rejects a wrong token", async () => {
    const res = await app.request(
      "/zarr-ready",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Webhook-Token": "nope" },
        body: JSON.stringify({ dataset_id: DATASET, status: "ready" }),
      },
      { DB: realD1(db), NEMAR_WEBHOOK_TOKEN: TOKEN, ENVIRONMENT: "test" } as Bindings,
    );
    expect(res.status).toBe(401);
  });
});

describe("the callback body is validated, never trusted", () => {
  test("a malformed field is dropped and logged, not 500'd", () => {
    // The body is JSON from a cron on another host. Before validation a wrong
    // type reached D1 as-is or threw inside the handler -- and a 500 here is the
    // worst outcome available, because the driver's POST is fire-and-forget, so
    // the state is simply lost.
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    let body: ReturnType<typeof parseZarrReadyBody>;
    try {
      body = parseZarrReadyBody({
        dataset_id: DATASET,
        status: "ready",
        store_count: 7,
        pool_breaks: "three", // wrong type
        pending_count: -1, // out of range
      });
    } finally {
      console.warn = realWarn;
    }
    expect(body).not.toBeNull();
    // The one bad field goes; everything else in the body survives, which is the
    // whole point of per-field `.catch`.
    expect(body?.store_count).toBe(7);
    expect(body?.status).toBe("ready");
    expect(body?.pool_breaks).toBeUndefined();
    expect(body?.pending_count).toBeUndefined();
    expect(warnings.join(" ")).toContain("pool_breaks");
    expect(warnings.join(" ")).toContain("pending_count");
  });

  test("unknown fields pass through rather than failing the callback", () => {
    // A newer converter that sends a field this backend has not learned yet must
    // still get its known fields persisted.
    const body = parseZarrReadyBody({
      dataset_id: DATASET,
      status: "ready",
      store_count: 3,
      some_future_field: { nested: true },
    });
    expect(body?.store_count).toBe(3);
  });

  test("the coverage fields survive validation", () => {
    const body = parseZarrReadyBody({
      dataset_id: DATASET,
      status: "ready",
      pending_count: 5,
      discovered_count: 43,
      not_attempted_count: 2,
      non_raw_dropped: 92,
      provenance_fetch_failed: true,
      manifest_upload_failed: false,
    });
    expect(body?.pending_count).toBe(5);
    expect(body?.discovered_count).toBe(43);
    expect(body?.not_attempted_count).toBe(2);
    expect(body?.non_raw_dropped).toBe(92);
    expect(body?.provenance_fetch_failed).toBe(true);
    expect(body?.manifest_upload_failed).toBe(false);
  });

  test("the events.parquet fields survive validation, null included", () => {
    // Null is the converter's way of saying it published no events file, and
    // `events_upload_failed` is what separates "no events" from "we could not
    // say what the events are" (#1060). A schema that dropped the null would
    // make the two indistinguishable here.
    const published = parseZarrReadyBody({
      dataset_id: DATASET,
      status: "ready",
      events_row_count: 5120,
      events_upload_failed: false,
    });
    expect(published?.events_row_count).toBe(5120);
    expect(published?.events_upload_failed).toBe(false);

    const none = parseZarrReadyBody({
      dataset_id: DATASET,
      status: "ready",
      events_row_count: null,
      events_upload_failed: true,
    });
    expect(none?.events_row_count).toBeNull();
    expect(none?.events_upload_failed).toBe(true);
  });

  test("a body with no usable dataset_id is rejected", () => {
    // The one field with no sensible default: it is what the UPDATE keys on.
    const realWarn = console.warn;
    console.warn = () => {};
    try {
      expect(parseZarrReadyBody({ status: "ready" })).toBeNull();
      expect(parseZarrReadyBody({ dataset_id: 42 })).toBeNull();
      expect(parseZarrReadyBody(null)).toBeNull();
      expect(parseZarrReadyBody("nope")).toBeNull();
    } finally {
      console.warn = realWarn;
    }
  });

  test("a garbage body reaches the handler as a 400, never a 500", async () => {
    // Driven through the REAL route, because the handler is where a throw would
    // have become a 500.
    const db = freshDb();
    const app = new Hono<{ Bindings: Bindings }>();
    registerZarrReadyRoutes(app);
    const realWarn = console.warn;
    console.warn = () => {};
    try {
      const res = await app.request(
        "/zarr-ready",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Webhook-Token": TOKEN },
          body: JSON.stringify({ status: "ready", store_count: "lots" }),
        },
        { DB: realD1(db), NEMAR_WEBHOOK_TOKEN: TOKEN, ENVIRONMENT: "test" } as Bindings,
      );
      expect(res.status).toBe(400);
    } finally {
      console.warn = realWarn;
    }
  });
});

describe("getZarrIndex reads raw v1 and v3 JSON off the wire", () => {
  /**
   * Drives the REAL `getZarrIndex` against a REAL server on a real socket, so
   * the request signing, the HTTP round trip, the JSON parse, the ETag read and
   * the aggregation all execute. Every other test of this area hands
   * `aggregateRecordingStats` a literal, so nothing covered how the response is
   * actually read -- `engine_version` could have been pulled off the wrong field
   * and every test would still pass.
   *
   * The only substitution is the HOSTNAME: `getZarrIndex` builds an
   * `https://<bucket>.s3.<region>.amazonaws.com/...` URL, so the wrapper below
   * redirects that one host to the loopback server and delegates to the real
   * `fetch`. That is what a DNS override would do; no business logic is replaced,
   * and the assertions are about what the function returns from a real response.
   */
  const options = {
    bucket: "nemar",
    region: "us-east-2",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  };

  async function readIndex(body: unknown) {
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json", ETag: '"abc123"' },
        }),
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      const url = new URL(req.url);
      if (url.hostname.endsWith("amazonaws.com")) {
        const local = new URL(url.pathname + url.search, `http://127.0.0.1:${server.port}`);
        return realFetch(new Request(local, req));
      }
      return realFetch(input as RequestInfo, init);
    }) as typeof fetch;
    try {
      return await getZarrIndex(options, DATASET);
    } finally {
      globalThis.fetch = realFetch;
      server.stop(true);
    }
  }

  test("a v1 index parses and aggregates", async () => {
    const info = await readIndex(v1Index());
    expect(info).not.toBeNull();
    expect(info?.storeCount).toBe(2);
    expect(info?.sourceCommit).toBe("a".repeat(40));
    expect(info?.etag).toBe('"abc123"');
    // v1 predates the engine stamp: null, not a guess.
    expect(info?.engineVersion).toBeNull();
    expect(info?.recordingStats.recordingCount).toBe(3);
    expect(info?.recordingStats.recordingsUnavailable).toBe(1);
  });

  test("a v3 index parses, aggregates and reports the engine", async () => {
    const info = await readIndex(v3Index());
    expect(info?.storeCount).toBe(2);
    expect(info?.sourceCommit).toBe("a".repeat(40));
    // The stamp a re-conversion wave is tracked by (ADR 0033).
    expect(info?.engineVersion).toBe("2");
    // Pending recordings counted: 2 stores + 1 failure + 2 pending.
    expect(info?.recordingStats.recordingCount).toBe(5);
    expect(info?.recordingStats.recordingsUnavailable).toBe(3);
    expect(info?.recordingStats.totalRecordingDuration).toBe(372);
  });

  test("a non-string engine_version is rejected rather than coerced", async () => {
    const info = await readIndex(v3Index({ engine_version: 3 }));
    expect(info?.engineVersion).toBeNull();
  });
});

describe("GET /schemas/:name serves the published contracts", () => {
  const app = new Hono<{ Bindings: Bindings }>();
  app.route("/schemas", schemaRoutes);

  test("serves the v3 index schema as a JSON Schema document", async () => {
    const res = await app.request("/schemas/zarr-index-v3.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/schema+json");
    expect(res.headers.get("cache-control")).toContain("max-age=");
    const schema = (await res.json()) as Record<string, unknown>;
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    // The served bytes ARE the file the converter validates against before
    // upload, so the fields it enforces have to be here.
    const props = schema.properties as Record<string, unknown>;
    for (const key of [
      "contract_base",
      "data_base",
      "s3_uri",
      "discovered_count",
      "pending_count",
      "engine_version",
      "source_commit",
    ]) {
      expect(props).toHaveProperty(key);
    }
    expect((schema.properties as Record<string, { const?: unknown }>).format_version.const).toBe(3);
  });

  test("serves the manifest schema", async () => {
    const res = await app.request("/schemas/zarr-manifest-v1.json");
    expect(res.status).toBe(200);
    const schema = (await res.json()) as Record<string, unknown>;
    expect((schema.properties as Record<string, { const?: unknown }>).format.const).toBe(
      "nemar-zarr-manifest",
    );
  });

  test("serves the engine protocol schema, v0, under its own $id", async () => {
    const res = await app.request("/schemas/zarr-engine-protocol-v0.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/schema+json");
    const schema = (await res.json()) as { $id: string; $schema: string; description: string };
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.$id).toBe("https://api.nemar.org/schemas/zarr-engine-protocol-v0.json");
    // The served bytes are the committed file, and v0 says it is unstable.
    const onDisk = JSON.parse(
      readFileSync(
        new URL("../../shared/zarr-engine-protocol.schema.json", import.meta.url),
        "utf8",
      ),
    );
    expect(schema).toEqual(onDisk);
    expect(schema.description).toContain("UNSTABLE");
  });

  test("it is reachable on the REAL app, at the real path", async () => {
    /**
     * The mount, not just the sub-app. A route that works in isolation and was
     * never wired into `backend/src/index.ts` serves 404 in production while its
     * own tests pass -- and `index.ts` mounts the api sub-app twice (at `/` and
     * `/nemar`), so "mounted" is not one fact.
     *
     * Imported lazily: `index.ts` pulls in the whole worker (crons, every
     * service), so importing it at module scope would tie this file's other
     * describes to that graph.
     */
    const { default: worker } = (await import("../src/index")) as {
      default: { fetch: (req: Request, env: Bindings) => Promise<Response> };
    };
    const env = { DB: realD1(freshDb()), ENVIRONMENT: "test" } as Bindings;
    for (const path of [
      "https://api.nemar.org/schemas/zarr-index-v3.json",
      "https://api.nemar.org/nemar/schemas/zarr-index-v3.json",
    ]) {
      const res = await worker.fetch(new Request(path), env);
      expect(res.status).toBe(200);
      const schema = (await res.json()) as Record<string, unknown>;
      expect((schema.properties as Record<string, { const?: unknown }>).format_version.const).toBe(
        3,
      );
    }
  });

  test("an unknown schema 404s and names what is available", async () => {
    const res = await app.request("/schemas/nope.json");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { available: string[] };
    expect(body.available).toEqual(SCHEMA_NAMES);
    expect(body.available).toContain("zarr-index-v3.json");
    expect(body.available).toContain("zarr-engine-protocol-v0.json");
  });
});
