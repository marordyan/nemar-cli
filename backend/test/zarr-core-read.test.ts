/**
 * Gate G2 for the shared Zarr read core (`shared/zarr/read.ts`,
 * `assemble.ts`, `array-metadata.ts`): its decoded values must agree with an
 * independent reader. `nm099500-zarr-python-int16.bin` is the whole `[4, 6500]`
 * level-0 array as zarr-python read it
 * (`scripts/zarr/zarr_python_reference.py` regenerates it and records the
 * zarr/numpy versions in the sibling .json).
 *
 * No mocks: a real `Bun.serve` fixture server serves the committed shard
 * objects, and the JSON cache is a real in-memory `Map` behind the
 * `JsonCache` interface.
 *
 * The third and fourth tests are not about zarr-python: a second read must
 * not repeat the `zarr.json` or shard-footer requests (only chunk ranges,
 * which are deliberately not cached).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { loadLevel0ArrayMetadata } from "../../shared/zarr/array-metadata.js";
import { assembleWindow } from "../../shared/zarr/assemble.js";
import type { CacheKey, JsonCache } from "../../shared/zarr/interfaces.js";
import { readLevel0Window } from "../../shared/zarr/read.js";
import expected from "./fixtures/mcp/nm099500-expected.json";
import { type FixtureServer, startFixtureServer } from "./helpers/fixture-server.js";

const FIXTURES = new URL("./fixtures/mcp/", import.meta.url);
const SOURCE_COMMIT = "c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1";
const ZARR = "sub-synth/eeg/sub-synth_task-shardtest_eeg.zarr";
const GROUP = "eeg_250hz";
const ARRAY_PREFIX = `nm099500/zarr/${ZARR}/${GROUP}/0`;

function fixtureBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(name, FIXTURES)));
}

/** A real in-memory JsonCache: whatever is put is what get returns. */
class MapJsonCache implements JsonCache {
  readonly store = new Map<string, unknown>();
  private keyOf(key: CacheKey): string {
    return JSON.stringify(key);
  }
  async get(key: CacheKey): Promise<unknown | undefined> {
    return this.store.get(this.keyOf(key));
  }
  put(key: CacheKey, value: unknown): void {
    this.store.set(this.keyOf(key), value);
  }
}

let server: FixtureServer;
const cache = new MapJsonCache();

beforeAll(() => {
  server = startFixtureServer({
    [`${ARRAY_PREFIX}/zarr.json`]: fixtureBytes("nm099500-level0-zarr.json"),
    [`${ARRAY_PREFIX}/c/0/0`]: fixtureBytes("nm099500-shard-0.bin"),
    [`${ARRAY_PREFIX}/c/0/1`]: fixtureBytes("nm099500-shard-1.bin"),
  });
});

afterAll(() => {
  server.stop();
});

const fetcher = (url: string, init?: { headers?: Record<string, string> }) => fetch(url, init);

async function readWholeArray() {
  const dataBase = `${server.url}/nm099500/zarr/`;
  const key = { datasetId: "nm099500", sourceCommit: SOURCE_COMMIT, convertedAt: "2026-09-08" };
  const meta = await loadLevel0ArrayMetadata({
    fetcher,
    cache,
    ...key,
    dataBase,
    zarr: ZARR,
    group: GROUP,
  });
  if (!meta.ok) throw new Error(meta.detail);
  const read = await readLevel0Window({
    fetcher,
    cache,
    key,
    dataBase,
    zarr: ZARR,
    groupName: GROUP,
    shardSamples: expected.shard_samples,
    chunkSamples: expected.chunk_samples,
    nInner: expected.n_inner_per_shard,
    nChannelsInStore: expected.n_channels,
    nSamplesTotal: expected.n_samples,
    startSample: 0,
    endSampleExclusive: expected.n_samples,
  });
  if (!read.ok) throw new Error(`${read.stage}: ${read.detail}`);
  const channels = [0, 1, 2, 3];
  const assembled = assembleWindow({
    channels,
    startSample: 0,
    nSamples: expected.n_samples,
    segments: read.segments,
    scale: meta.metadata.scale,
    offset: meta.metadata.offset,
    fillValue: 0,
  });
  return { meta: meta.metadata, assembled, segments: read.segments };
}

describe("shared/zarr read core against zarr-python (G2)", () => {
  const reference = new Int16Array(fixtureBytes("nm099500-zarr-python-int16.bin").slice().buffer);
  const nSamples = expected.n_samples;

  test("reference file is the whole [4, 6500] int16 array", () => {
    expect(reference.length).toBe(4 * nSamples);
  });

  test("decoded int16 values equal zarr-python's, zero differences", async () => {
    const { segments } = await readWholeArray();
    let differences = 0;
    for (const seg of segments) {
      for (let ch = 0; ch < 4; ch++) {
        for (let s = seg.start; s < seg.end; s++) {
          // An absent chunk has no data: the array's fill_value (0) stands in.
          const got = seg.data ? seg.data[ch * seg.stride + (s - seg.start)] : 0;
          if (got !== reference[ch * nSamples + s]) differences++;
        }
      }
    }
    expect(differences).toBe(0);
  });

  test("physical values equal digital * scale + offset in float64, zero differences", async () => {
    const { meta, assembled } = await readWholeArray();
    let differences = 0;
    for (let ch = 0; ch < 4; ch++) {
      for (let s = 0; s < nSamples; s++) {
        const want = reference[ch * nSamples + s] * meta.scale[ch] + meta.offset[ch];
        if (assembled.values[ch][s] !== want) differences++;
      }
    }
    expect(differences).toBe(0);
  });

  test("filledRanges is the one absent chunk", async () => {
    const { assembled } = await readWholeArray();
    expect(assembled.filledRanges).toEqual([{ start: 2000, end: 3000 }]);
  });

  test("a second read repeats no zarr.json or footer request (the cache is used)", async () => {
    await readWholeArray();
    const before = server.requestLog.length;
    await readWholeArray();
    const second = server.requestLog.slice(before);
    // Footer reads are suffix ranges (`bytes=-N`); chunk reads are explicit
    // `bytes=a-b` ranges and are not cached.
    expect(second.filter((r) => r.url.endsWith("/zarr.json"))).toEqual([]);
    expect(second.filter((r) => r.range.startsWith("bytes=-"))).toEqual([]);
    expect(second.length).toBeGreaterThan(0);
  });
});
