/**
 * `src/lib/zarr-engine/source.ts` against a real `Bun.serve` stand-in on 127.0.0.1 that
 * serves the committed nm099500 index and level-0 `zarr.json`, a data-plane version
 * listing and a `records.json`. Covers how a dataset becomes representations and a bound
 * recording, every open failure and its protocol error code, and the best-effort record.
 *
 * `nm099500` has one group, which cannot tell "first group" from "named group" or show a
 * null mapping, so the multigroup test derives a SYNTHETIC second group from it; the
 * derivation is in the test and says so. The legacy case is the real nm000111 index
 * (`format_version` 1).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { openedSchema, zarrRepresentationSchema } from "../shared/contract/zarr-engine-protocol.js";
import { resolveBases } from "../src/lib/zarr-engine/http.js";
import {
  type DataSource,
  openRecording,
  parseIndexDocument,
  publicSource,
} from "../src/lib/zarr-engine/source.js";
import realRecords from "./fixtures/neuroschema-records/nm000103-sample.json";

const MCP = new URL("../backend/test/fixtures/mcp/", import.meta.url);
const json = (name: string) => JSON.parse(readFileSync(new URL(name, MCP), "utf8"));
const bytes = (name: string) => new Uint8Array(readFileSync(new URL(name, MCP)));

const ID = "nm099500";
const BIDS = "sub-synth/eeg/sub-synth_task-shardtest_eeg.edf";
const ZARR = "sub-synth/eeg/sub-synth_task-shardtest_eeg.zarr";
const nm099500Index = json("nm099500-index-v3.json");
const level0 = json("nm099500-level0-zarr.json");
const legacyIndex = json("nm000111-index-v1.json");

/** The record the stand-in publishes for BIDS: a real nm000103 record with its path set to ours. */
const RECORD = { ...(realRecords as Record<string, unknown>[])[0], bids_relpath: BIDS };
const OTHER_RECORD = { ...(realRecords as Record<string, unknown>[])[1], bids_relpath: "x.edf" };

interface Seen {
  path: string;
  headers: Record<string, string>;
}
let seen: Seen[] = [];
let files: Map<string, { status?: number; body: string | Uint8Array }>;
let server: ReturnType<typeof Bun.serve>;
const base = () => `http://127.0.0.1:${server.port}`;
const warnings: string[] = [];
const warn = (line: string) => warnings.push(line);

function indexWithBase(index: Record<string, unknown>) {
  return {
    ...index,
    data_base: `${base()}/${index.dataset_id}/zarr/`,
    contract_base: `${base()}/${index.dataset_id}/zarr/`,
  };
}

function resetFiles() {
  files = new Map();
  files.set(`/${ID}/zarr/index.json`, { body: JSON.stringify(indexWithBase(nm099500Index)) });
  files.set(`/${ID}/zarr/${ZARR}/eeg_250hz/0/zarr.json`, { body: JSON.stringify(level0) });
  files.set(`/data/${ID}`, {
    body: JSON.stringify({
      dataset_id: ID,
      latest: "1.0.0",
      versions: [{ version: "0.5.0" }, { version: "1.0.0" }],
    }),
  });
  files.set(`/data/${ID}/1.0.0/records.json`, { body: JSON.stringify([OTHER_RECORD, RECORD]) });
  files.set("/nm000111/zarr/index.json", { body: JSON.stringify(legacyIndex) });
}

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      seen.push({ path, headers: Object.fromEntries(req.headers.entries()) });
      const f = files.get(path);
      if (!f) return new Response(null, { status: 404 });
      return new Response(f.body, { status: f.status ?? 200 });
    },
  });
});
afterAll(() => server.stop(true));
beforeEach(() => {
  seen = [];
  warnings.length = 0;
  resetFiles();
});

function source(): DataSource {
  return publicSource({
    bases: resolveBases({ NEMAR_ZARR_BASE: base(), NEMAR_ZARR_DATA_PLANE: `${base()}/data` }),
  });
}
const open = (s: DataSource, recording = BIDS, representation?: string, id = ID) =>
  openRecording(s, { datasetId: id, recording, representation }, warn);

async function opened(s: DataSource, recording = BIDS, representation?: string) {
  const r = await open(s, recording, representation);
  if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
  return r.value;
}

describe("the per-process caches are bounded", () => {
  const ids = ["nm099510", "nm099511", "nm099512", "nm099513", "nm099514"];
  const count = (path: string) => seen.filter((s) => s.path === path).length;
  const indexPath = (id: string) => `/${id}/zarr/index.json`;
  const recordsPath = (id: string) => `/data/${id}/1.0.0/records.json`;

  function addDatasets() {
    for (const id of ids) {
      files.set(indexPath(id), {
        body: JSON.stringify(indexWithBase({ ...nm099500Index, dataset_id: id })),
      });
      files.set(`/data/${id}`, {
        body: JSON.stringify({ dataset_id: id, latest: "1.0.0", versions: [{ version: "1.0.0" }] }),
      });
      files.set(recordsPath(id), { body: JSON.stringify([RECORD]) });
    }
  }

  test("a 5th dataset evicts the least recently used index, which is then fetched again", async () => {
    addDatasets();
    const s = source();
    for (const id of ids.slice(0, 4)) expect((await s.readIndex(id)).status).toBe("ok");
    await s.readIndex(ids[0]); // refresh: ids[1] is now the oldest
    expect(count(indexPath(ids[0]))).toBe(1);
    await s.readIndex(ids[4]); // evicts ids[1]
    await s.readIndex(ids[0]);
    await s.readIndex(ids[2]);
    expect(count(indexPath(ids[0]))).toBe(1);
    expect(count(indexPath(ids[2]))).toBe(1);
    await s.readIndex(ids[1]);
    expect(count(indexPath(ids[1]))).toBe(2);
  });

  test("a 5th dataset evicts the least recently used records, which are then fetched again", async () => {
    addDatasets();
    const s = source();
    for (const id of ids.slice(0, 4)) expect((await s.readRecords(id)).status).toBe("ok");
    await s.readRecords(ids[0]);
    await s.readRecords(ids[4]); // evicts ids[1]
    await s.readRecords(ids[0]);
    expect(count(recordsPath(ids[0]))).toBe(1);
    await s.readRecords(ids[1]);
    expect(count(recordsPath(ids[1]))).toBe(2);
  });
});

describe("index paths and logged strings", () => {
  const withStore = (
    patch: (store: Record<string, unknown>, group: Record<string, unknown>) => void,
  ) => {
    const store = structuredClone(nm099500Index.stores[0]) as Record<string, unknown>;
    const group = (store.groups as Record<string, unknown>[])[0];
    patch(store, group);
    files.set(`/${ID}/zarr/index.json`, {
      body: JSON.stringify(indexWithBase({ ...nm099500Index, stores: [store] })),
    });
  };

  for (const bad of [
    "../x.zarr",
    "a/../x.zarr",
    "/abs.zarr",
    "a?b.zarr",
    "a#b.zarr",
    "a\\b.zarr",
    "a\u0001b.zarr",
    "%2e%2e/x.zarr",
    "a/%2E%2e/x.zarr",
    ".%2e/x.zarr",
  ]) {
    test(`a zarr path of ${JSON.stringify(bad)} is upstream_error`, async () => {
      withStore((store) => {
        store.zarr = bad;
      });
      const r = await open(source());
      expect(r).toMatchObject({ ok: false, code: "upstream_error" });
      expect(r.ok ? "" : r.message).toContain("zarr path");
    });
  }

  test("a group name with a .. segment is upstream_error", async () => {
    withStore((_store, group) => {
      group.name = "../eeg_250hz";
    });
    const r = await open(source());
    expect(r).toMatchObject({ ok: false, code: "upstream_error" });
    expect(r.ok ? "" : r.message).toContain("group name");
  });

  test("a group name with a percent-encoded .. segment is upstream_error", async () => {
    withStore((_store, group) => {
      group.name = "%2e%2e";
    });
    const r = await open(source());
    expect(r).toMatchObject({ ok: false, code: "upstream_error" });
    expect(r.ok ? "" : r.message).toContain("group name");
  });

  test("the store.path in the no-record warning is JSON-quoted, so a newline cannot forge a line", async () => {
    const path = "sub-synth/eeg/x\nFORGED: line.edf";
    withStore((store) => {
      store.path = path;
    });
    const r = await open(source(), path);
    expect(r.ok).toBe(true);
    const line = warnings.find((w) => w.includes("no record for"));
    expect(line).toBeDefined();
    expect(line).not.toContain("\n");
    expect(line).toContain(JSON.stringify(path));
  });
});

describe("nm099500: representations and the bound recording", () => {
  test("opens by BIDS path and by zarr path, and recording is the BIDS path both times", async () => {
    const s = source();
    expect((await opened(s, BIDS)).recording).toBe(BIDS);
    expect((await opened(s, ZARR)).recording).toBe(BIDS);
  });

  test("the representation carries the group's own values, and scale and offset only when bound", async () => {
    const b = await opened(source());
    expect(b.representationId).toBe("eeg_250hz");
    expect(b.representations).toEqual([
      {
        kind: "zarr",
        id: "eeg_250hz",
        store: ZARR,
        modality: "EEG",
        sampling_frequency: 250,
        source_sampling_frequency: 1000,
        nchans: 4,
        ntimes: 6500,
        recording_duration: 26,
        scale: [0.5, 1.0, 1.5, 2.0],
        offset: [10.0, 20.0, 30.0, 40.0],
      },
    ]);
    expect(b.geometry).toEqual({
      rate: 250,
      nChannels: 4,
      nSamples: 6500,
      chunkSamples: 1000,
      shardSamples: 4000,
      nInner: 4,
    });
    expect(b.dataBase).toBe(`${base()}/${ID}/zarr/`);
  });

  test("an opened message built from the binding passes the protocol schema", async () => {
    const b = await opened(source());
    const message = {
      id: 1,
      type: "opened",
      handle: "h1",
      dataset_id: b.datasetId,
      recording: b.recording,
      representation: b.representationId,
      record: b.record,
      representations: b.representations,
    };
    expect(openedSchema.safeParse(message).success).toBe(true);
  });

  test("the record is the one whose bids_relpath matches, exactly as published", async () => {
    const b = await opened(source());
    expect(b.record).toEqual(RECORD);
    expect(warnings).toEqual([]);
  });

  test("records come from the version the listing calls latest, at the data plane path", async () => {
    await opened(source());
    expect(seen.map((s) => s.path)).toContain(`/data/${ID}/1.0.0/records.json`);
    expect(seen.map((s) => s.path)).not.toContain(`/data/${ID}/0.5.0/records.json`);
  });

  test("the index is read once per process, and zarr.json once per source", async () => {
    const s = source();
    await opened(s);
    seen = [];
    await opened(s);
    expect(seen).toEqual([]);
  });

  test("cached footers and array metadata are keyed by the index's own timestamp", async () => {
    const s = source();
    const b = await opened(s);
    const key = {
      datasetId: ID,
      sourceCommit: b.index.source_commit,
      convertedAt: b.index.updated_utc,
      projection: `array/${ZARR}/eeg_250hz/0`,
    };
    expect(await s.jsonCache.get(key)).toBeDefined();
    expect(await s.jsonCache.get({ ...key, convertedAt: null })).toBeUndefined();
  });

  test("no request carries Authorization or Cookie", async () => {
    const s = source();
    await opened(s);
    await open(s, "nope");
    expect(seen.length).toBeGreaterThan(3);
    for (const r of seen) {
      expect(Object.keys(r.headers)).not.toContain("authorization");
      expect(Object.keys(r.headers)).not.toContain("cookie");
    }
  });
});

describe("a recording with several groups (SYNTHETIC extra groups derived from nm099500)", () => {
  /** Group 2: 500 Hz, 4 channels (so nm099500's scale/offset fit), 3000 samples, no source rate
   *  and no modality; group 3: no rate at all; group 4: no samples (0). */
  function multigroup() {
    const store = nm099500Index.stores[0];
    const g1 = store.groups[0];
    const g2 = {
      ...g1,
      name: "eeg_500hz",
      rate: 500,
      n_samples: 3000,
      source_rate_hz: null,
      modality: null,
    };
    const g3 = { ...g1, name: "eeg_norate", rate: null };
    const g4 = { ...g1, name: "eeg_nosamples", n_samples: 0 };
    const g5 = { ...g1, name: "eeg_zerorate", rate: 0 };
    const index = { ...nm099500Index, stores: [{ ...store, groups: [g1, g2, g3, g4, g5] }] };
    files.set(`/${ID}/zarr/index.json`, { body: JSON.stringify(indexWithBase(index)) });
    for (const g of ["eeg_500hz", "eeg_norate", "eeg_nosamples", "eeg_zerorate"]) {
      files.set(`/${ID}/zarr/${ZARR}/${g}/0/zarr.json`, { body: JSON.stringify(level0) });
    }
  }

  test("every group is a representation, nulls where the index has no value", async () => {
    multigroup();
    const b = await opened(source());
    expect(b.representations.map((r) => r.id)).toEqual([
      "eeg_250hz",
      "eeg_500hz",
      "eeg_norate",
      "eeg_nosamples",
      "eeg_zerorate",
    ]);
    const [, g2, g3, g4, g5] = b.representations;
    expect(g2).toMatchObject({
      sampling_frequency: 500,
      source_sampling_frequency: null,
      ntimes: 3000,
      modality: null,
      scale: null,
      offset: null,
    });
    expect(g3.sampling_frequency).toBeNull();
    expect(g4.ntimes).toBeNull();
    expect(g5.sampling_frequency).toBeNull(); // 0 Hz is "no rate", and the schema needs > 0
    for (const r of b.representations) {
      expect(zarrRepresentationSchema.safeParse(r).success).toBe(true);
    }
  });

  test("with no representation named, the first group is bound", async () => {
    multigroup();
    expect((await opened(source())).representationId).toBe("eeg_250hz");
  });

  test("a named representation is bound, and only it has scale and offset", async () => {
    multigroup();
    const b = await opened(source(), BIDS, "eeg_500hz");
    expect(b.representationId).toBe("eeg_500hz");
    expect(b.geometry.rate).toBe(500);
    expect(b.geometry.nSamples).toBe(3000);
    expect(b.representations.filter((x) => x.scale !== null).map((x) => x.id)).toEqual([
      "eeg_500hz",
    ]);
  });

  test("a group with no usable rate or no samples cannot be bound: upstream_error", async () => {
    multigroup();
    const s = source();
    expect(await open(s, BIDS, "eeg_norate")).toMatchObject({ ok: false, code: "upstream_error" });
    expect(await open(s, BIDS, "eeg_nosamples")).toMatchObject({
      ok: false,
      code: "upstream_error",
    });
  });

  test("an unknown representation id is not_found", async () => {
    multigroup();
    expect(await open(source(), BIDS, "nope")).toMatchObject({ ok: false, code: "not_found" });
  });
});

describe("open failures and their codes", () => {
  test("an unknown dataset (index 404) is not_found", async () => {
    expect(await open(source(), BIDS, undefined, "nm000999")).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });

  test("a malformed dataset id is not_found and sends no request", async () => {
    expect(await open(source(), BIDS, undefined, "../etc")).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(seen).toEqual([]);
  });

  test("an unknown recording is not_found", async () => {
    expect(await open(source(), "sub-x/eeg/missing.edf")).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });

  test("a recording whose store has no groups has no zarr representation: not_found", async () => {
    const store = { ...nm099500Index.stores[0], groups: [] };
    files.set(`/${ID}/zarr/index.json`, {
      body: JSON.stringify(indexWithBase({ ...nm099500Index, stores: [store] })),
    });
    expect(await open(source())).toMatchObject({ ok: false, code: "not_found" });
  });

  test("a legacy index (the real nm000111, format_version 1) is not_ready", async () => {
    const r = await open(
      source(),
      "sub-I003/eeg/sub-I003_task-sleep_eeg.edf",
      undefined,
      "nm000111",
    );
    expect(r).toMatchObject({ ok: false, code: "not_ready" });
  });

  test("an index answered with 5xx is upstream_error", async () => {
    files.set(`/${ID}/zarr/index.json`, { status: 503, body: "down" });
    expect(await open(source())).toMatchObject({ ok: false, code: "upstream_error" });
  });

  test("an unparseable index is upstream_error", async () => {
    files.set(`/${ID}/zarr/index.json`, { body: "{not json" });
    expect(await open(source())).toMatchObject({ ok: false, code: "upstream_error" });
  });

  test("a v3 index that fails the schema is upstream_error", async () => {
    files.set(`/${ID}/zarr/index.json`, {
      body: JSON.stringify({ ...indexWithBase(nm099500Index), stores: "no" }),
    });
    expect(await open(source())).toMatchObject({ ok: false, code: "upstream_error" });
  });

  test("an index that names another dataset is upstream_error", async () => {
    files.set(`/${ID}/zarr/index.json`, {
      body: JSON.stringify({ ...indexWithBase(nm099500Index), dataset_id: "nm099501" }),
    });
    expect(await open(source())).toMatchObject({ ok: false, code: "upstream_error" });
  });

  test("an index whose data_base is plain http to a non-loopback host is upstream_error", () => {
    const doc = { ...nm099500Index, data_base: "http://example.com/nm099500/zarr/" };
    expect(parseIndexDocument(doc, ID, true)).toMatchObject({ status: "error" });
    const ok = { ...nm099500Index, data_base: "https://example.com/nm099500/zarr/" };
    expect(parseIndexDocument(ok, ID, false).status).toBe("ok");
  });

  test("an index whose contract_base is plain http to a non-loopback host is upstream_error", () => {
    const doc = { ...nm099500Index, contract_base: "http://example.com/nm099500/zarr/" };
    expect(parseIndexDocument(doc, ID, true)).toMatchObject({
      status: "error",
      detail: expect.stringContaining("contract_base"),
    });
    const loopback = { ...nm099500Index, contract_base: "http://127.0.0.1:9/nm099500/zarr/" };
    expect(parseIndexDocument(loopback, ID, true).status).toBe("ok");
  });

  test("a loopback http base in the index is accepted only when the engine's zarr base is loopback http", async () => {
    // The stand-in serves a loopback index (base()); the engine thinks it is talking to
    // https://zarr.test, whose requests are carried to the stand-in by a custom transport.
    const carried = (url: string, init: RequestInit) =>
      fetch(url.replace("https://zarr.test", base()), init);
    const httpsSource = publicSource({
      bases: resolveBases({
        NEMAR_ZARR_BASE: "https://zarr.test",
        NEMAR_ZARR_DATA_PLANE: `${base()}/data`,
      }),
      baseFetch: carried,
    });
    const refused = await open(httpsSource);
    expect(refused).toMatchObject({ ok: false, code: "upstream_error" });
    expect(refused.ok ? "" : refused.message).toContain("plain http");
    // The same index with https bases passes the check (it then fails to read: no such host).
    files.set(`/${ID}/zarr/index.json`, { body: JSON.stringify(nm099500Index) });
    const httpsIndex = await httpsSource.readIndex(ID);
    expect(httpsIndex.status).toBe("ok");
    // And with a loopback http zarr base the loopback index opens.
    files.set(`/${ID}/zarr/index.json`, { body: JSON.stringify(indexWithBase(nm099500Index)) });
    expect((await open(source())).ok).toBe(true);
  });

  test("parseIndexDocument refuses a loopback http base unless allowed", () => {
    const loopback = {
      ...nm099500Index,
      data_base: "http://127.0.0.1:9/nm099500/zarr/",
      contract_base: "http://127.0.0.1:9/nm099500/zarr/",
    };
    expect(parseIndexDocument(loopback, ID, false)).toMatchObject({ status: "error" });
    expect(parseIndexDocument(loopback, ID, true).status).toBe("ok");
  });

  test("a group without shard geometry is upstream_error", async () => {
    const store = nm099500Index.stores[0];
    const { shard_samples: _drop, ...group } = store.groups[0];
    files.set(`/${ID}/zarr/index.json`, {
      body: JSON.stringify(
        indexWithBase({ ...nm099500Index, stores: [{ ...store, groups: [group] }] }),
      ),
    });
    const r = await open(source());
    expect(r).toMatchObject({ ok: false, code: "upstream_error" });
    expect(r.ok ? "" : r.message).toContain("carries no");
  });

  test("a missing level-0 zarr.json is upstream_error", async () => {
    files.delete(`/${ID}/zarr/${ZARR}/eeg_250hz/0/zarr.json`);
    expect(await open(source())).toMatchObject({ ok: false, code: "upstream_error" });
  });

  test("scale and offset that do not match the channel count are upstream_error", async () => {
    const bad = {
      ...level0,
      attributes: { ...level0.attributes, scale: [1, 2], offset: [0, 0] },
    };
    files.set(`/${ID}/zarr/${ZARR}/eeg_250hz/0/zarr.json`, { body: JSON.stringify(bad) });
    expect(await open(source())).toMatchObject({ ok: false, code: "upstream_error" });
  });

  test("a store that is not int16 is upstream_error", async () => {
    files.set(`/${ID}/zarr/${ZARR}/eeg_250hz/0/zarr.json`, {
      body: JSON.stringify({ ...level0, data_type: "float32" }),
    });
    expect(await open(source())).toMatchObject({ ok: false, code: "upstream_error" });
  });
});

describe("the record is best effort (ADR 0005)", () => {
  async function openedWithNullRecord(expectWarning: RegExp) {
    const b = await opened(source());
    expect(b.record).toBeNull();
    expect(b.recording).toBe(BIDS);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(expectWarning);
  }

  test("records.json missing: record null and one warning, the open succeeds", async () => {
    files.delete(`/data/${ID}/1.0.0/records.json`);
    await openedWithNullRecord(/unavailable/);
  });

  test("records.json malformed JSON: record null and one warning", async () => {
    files.set(`/data/${ID}/1.0.0/records.json`, { body: "{nope" });
    await openedWithNullRecord(/unavailable/);
  });

  test("records.json that is not an array: record null and one warning", async () => {
    files.set(`/data/${ID}/1.0.0/records.json`, { body: JSON.stringify({ a: 1 }) });
    await openedWithNullRecord(/not an array/);
  });

  test("the version listing missing or failing: record null and one warning", async () => {
    files.delete(`/data/${ID}`);
    await openedWithNullRecord(/unavailable/);
    warnings.length = 0;
    files.set(`/data/${ID}`, { status: 500, body: "x" });
    await openedWithNullRecord(/unavailable/);
  });

  test("a listing that is not a version listing: record null and one warning", async () => {
    files.set(`/data/${ID}`, { body: JSON.stringify({ versions: "no" }) });
    await openedWithNullRecord(/not a version listing/);
  });

  test("records.json with no record for this recording: record null and one warning", async () => {
    files.set(`/data/${ID}/1.0.0/records.json`, { body: JSON.stringify([OTHER_RECORD]) });
    await openedWithNullRecord(/no record for/);
  });
});
