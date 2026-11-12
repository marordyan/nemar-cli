/**
 * `readLevel0Window` says WHY a read failed, not only at which stage: `cause`
 * is `fetch` when the host could not be read as asked (a 5xx, a short 206, a
 * bare 200 that ignored Range, a network error), and `decode` when the bytes
 * arrived but are not a valid footer or chunk. The local engine maps the two to
 * different protocol errors (`upstream_error` is retryable, `decode_error` is
 * not), so a regression that swaps them would tell a client to retry a corrupt
 * store or to give up on a flaky host.
 *
 * No mocks: a real `Bun.serve` stand-in serves the committed nm099500 shards and
 * misbehaves per key on purpose.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { CacheKey, JsonCache } from "../../shared/zarr/interfaces.js";
import { readLevel0Window } from "../../shared/zarr/read.js";
import expected from "./fixtures/mcp/nm099500-expected.json";

const FIXTURES = new URL("./fixtures/mcp/", import.meta.url);
const ZARR = "sub-synth/eeg/sub-synth_task-shardtest_eeg.zarr";
const GROUP = "eeg_250hz";
const SHARD0_KEY = `/nm099500/zarr/${ZARR}/${GROUP}/0/c/0/0`;
const SHARD1_KEY = `/nm099500/zarr/${ZARR}/${GROUP}/0/c/0/1`;

function fixtureBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(name, FIXTURES)));
}

class MapJsonCache implements JsonCache {
  readonly store = new Map<string, unknown>();
  async get(key: CacheKey): Promise<unknown | undefined> {
    return this.store.get(JSON.stringify(key));
  }
  put(key: CacheKey, value: unknown): void {
    this.store.set(JSON.stringify(key), value);
  }
}

type Behaviour = "good" | "5xx" | "short206" | "bare200" | "corrupt-chunk";
const shard0 = fixtureBytes("nm099500-shard-0.bin");
const shard1 = fixtureBytes("nm099500-shard-1.bin");
let behaviour: Behaviour = "good";

/** Serve `bytes` for a Range request, or misbehave as `behaviour` says (shard 0 only). */
function serveRange(req: Request, bytes: Uint8Array, misbehave: boolean): Response {
  const range = req.headers.get("range") ?? "";
  const m = /^bytes=(?:(\d+)-(\d+)|-(\d+))$/.exec(range);
  if (!m) return new Response(bytes, { status: 200 });
  let start: number;
  let end: number;
  if (m[3] !== undefined) {
    start = Math.max(0, bytes.length - Number(m[3]));
    end = bytes.length - 1;
  } else {
    start = Number(m[1]);
    end = Math.min(Number(m[2]), bytes.length - 1);
  }
  const isFooter = m[3] !== undefined;
  if (misbehave) {
    if (behaviour === "5xx") return new Response("boom", { status: 503 });
    if (behaviour === "bare200") return new Response(bytes, { status: 200 });
    // A short 206 on the chunk read only, so the footer read (which comes first) succeeds.
    if (behaviour === "short206" && !isFooter) {
      return new Response(bytes.slice(start, end), { status: 206 });
    }
    if (behaviour === "corrupt-chunk" && !isFooter) {
      const slice = bytes.slice(start, end + 1);
      slice.fill(0xff, 0, Math.min(slice.length, 32));
      return new Response(slice, { status: 206 });
    }
  }
  return new Response(bytes.slice(start, end + 1), { status: 206 });
}

let server: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === SHARD0_KEY) return serveRange(req, shard0, true);
      if (path === SHARD1_KEY) return serveRange(req, shard1, false);
      return new Response(null, { status: 404 });
    },
  });
});
afterAll(() => {
  server.stop(true);
});

async function read(startSample: number, endSampleExclusive: number, nChannels?: number) {
  return readLevel0Window({
    fetcher: (url, init) => fetch(url, init),
    cache: new MapJsonCache(),
    key: { datasetId: "nm099500", sourceCommit: "c".repeat(40), convertedAt: null },
    dataBase: `http://127.0.0.1:${server.port}/nm099500/zarr/`,
    zarr: ZARR,
    groupName: GROUP,
    shardSamples: expected.shard_samples,
    chunkSamples: expected.chunk_samples,
    nInner: expected.n_inner_per_shard,
    nChannelsInStore: nChannels ?? expected.n_channels,
    nSamplesTotal: expected.n_samples,
    startSample,
    endSampleExclusive,
  });
}

describe("readLevel0Window failure cause", () => {
  test("a good read has no failure", async () => {
    behaviour = "good";
    const r = await read(0, 1000);
    expect(r.ok).toBe(true);
  });

  test("a 5xx on the footer is fetch", async () => {
    behaviour = "5xx";
    const r = await read(0, 1000);
    expect(r).toMatchObject({ ok: false, stage: "footer", cause: "fetch" });
  });

  test("a bare 200 on the footer is fetch", async () => {
    behaviour = "bare200";
    const r = await read(0, 1000);
    expect(r).toMatchObject({ ok: false, stage: "footer", cause: "fetch" });
  });

  test("a short 206 on a chunk is fetch", async () => {
    behaviour = "short206";
    const r = await read(0, 1000);
    expect(r).toMatchObject({ ok: false, stage: "chunk", cause: "fetch" });
  });

  test("a corrupt chunk is decode", async () => {
    behaviour = "corrupt-chunk";
    const r = await read(0, 1000);
    expect(r).toMatchObject({ ok: false, stage: "chunk", cause: "decode" });
  });

  test("chunks that decode to another length than the channel count says are decode", async () => {
    behaviour = "good";
    // The shards hold 4 channels; claiming 3 makes every decoded chunk 1000 values too long.
    const r = await read(0, 1000, 3);
    expect(r).toMatchObject({ ok: false, stage: "chunk", cause: "decode" });
    expect(r.ok ? "" : r.detail).toContain("decoded to 4000 values, expected 3000");
  });

  // `cause: "plan"` (read.ts) has no real path to test: the footer is always read as exactly
  // `nInner` entries and the window's local indices are always below `nInner`, so a missing or
  // absent entry in a planned read cannot be produced through `readLevel0Window`. It is a
  // guard against a future planner bug, and the engine maps it to upstream_error like `fetch`.

  test("an unreachable host is fetch", async () => {
    behaviour = "good";
    const r = await readLevel0Window({
      fetcher: async () => {
        throw new Error("connection refused");
      },
      cache: new MapJsonCache(),
      key: { datasetId: "nm099500", sourceCommit: "c".repeat(40), convertedAt: null },
      dataBase: "http://127.0.0.1:1/nm099500/zarr/",
      zarr: ZARR,
      groupName: GROUP,
      shardSamples: expected.shard_samples,
      chunkSamples: expected.chunk_samples,
      nInner: expected.n_inner_per_shard,
      nChannelsInStore: expected.n_channels,
      nSamplesTotal: expected.n_samples,
      startSample: 0,
      endSampleExclusive: 1000,
    });
    expect(r).toMatchObject({ ok: false, cause: "fetch" });
  });
});
