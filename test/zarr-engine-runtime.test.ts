/**
 * Gate G4: the Zarr engine as a real child process. `bun run src/lib/zarr-engine/main.ts` is
 * spawned with `Bun.spawn`, its environment pointed at a `Bun.serve` stand-in on 127.0.0.1 that
 * serves the committed nm099500 synthetic sharded store (index, `zarr.json`, both shards), a
 * data-plane listing and a `records.json`, and counts every Range request. Frames go over its
 * stdin and come back over its stdout, exactly as a client would send them.
 *
 * Values are checked three ways: against the in-process read core (`readLevel0Window` +
 * `assembleWindow`), against `nm099500-expected.json`'s spot checks and against
 * `nm099500-zarr-python-int16.bin`, the whole array as zarr-python read it (G2), with zero
 * differences. Every response the engine sends is validated against both the zod mirror and
 * the JSON Schema's `$defs/Response` (Ajv), whatever the test is about.
 *
 * nm099500's store: 4 channels, 250 Hz, 6500 samples, chunk 1000, shard 4000. Shard 0's inner
 * chunk 2 (samples 2000-3000) is ABSENT; shard 1's last chunk is truncated to 500 samples; the
 * shard boundary is sample 4000. scale [0.5, 1, 1.5, 2], offset [10, 20, 30, 40].
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020";
import { buildReadRecipe } from "../shared/contract/mcp.js";
import {
  engineResponseSchema,
  openedSchema,
  windowSchema,
} from "../shared/contract/zarr-engine-protocol.js";
import { zarrIndexSchema } from "../shared/contract/zarr-index.js";
import protocolSchema from "../shared/zarr-engine-protocol.schema.json";
import { loadLevel0ArrayMetadata } from "../shared/zarr/array-metadata.js";
import { assembleWindow } from "../shared/zarr/assemble.js";
import { FRAME_PREFIX_BYTES, encodeFrame } from "../shared/zarr/protocol-frame.js";
import { readLevel0Window } from "../shared/zarr/read.js";
import { type FrameEvent, readFrames } from "../src/lib/zarr-engine/frame-stream.js";
import { MemoryJsonCache, createPublicFetcher } from "../src/lib/zarr-engine/http.js";
import realRecords from "./fixtures/neuroschema-records/nm000103-sample.json";

setDefaultTimeout(30_000);

const MCP = new URL("../backend/test/fixtures/mcp/", import.meta.url);
const json = (name: string) => JSON.parse(readFileSync(new URL(name, MCP), "utf8"));
const bytes = (name: string) => new Uint8Array(readFileSync(new URL(name, MCP)));
const MAIN = new URL("../src/lib/zarr-engine/main.ts", import.meta.url).pathname;
const ROOT = new URL("../", import.meta.url).pathname;

const expected = json("nm099500-expected.json");
const index = json("nm099500-index-v3.json");
const level0 = json("nm099500-level0-zarr.json");
const shard0 = bytes("nm099500-shard-0.bin");
const shard1 = bytes("nm099500-shard-1.bin");
const referenceDigital = new Int16Array(bytes("nm099500-zarr-python-int16.bin").slice().buffer);
const legacyIndex = json("nm000111-index-v1.json");

const BIDS = "sub-synth/eeg/sub-synth_task-shardtest_eeg.edf";
const ZARR = "sub-synth/eeg/sub-synth_task-shardtest_eeg.zarr";
const N = expected.n_samples as number;
const RATE = 250;
const SCALE = expected.scale as number[];
const OFFSET = expected.offset as number[];
const RECORD = { ...(realRecords as Record<string, unknown>[])[0], bids_relpath: BIDS };

// --- The stand-in ----------------------------------------------------------------------------

type Mode =
  | "good"
  | "5xx"
  | "5xx-chunk"
  | "bare200"
  | "bare200-chunk"
  | "short206"
  | "long206"
  | "streamed-long206"
  | "corrupt-chunk"
  | "huge-footer";
let mode: Mode = "good";
let rangeRequests: { path: string; range: string }[] = [];
/** The path of EVERY request the stand-in received, Range or not. */
let allRequests: string[] = [];
let server: ReturnType<typeof Bun.serve>;
/** A second origin that serves the same paths, for the disk-cache origin test. */
let alias: ReturnType<typeof Bun.serve>;
/** What the next index says: its `updated_utc` and the origin of its `data_base`. */
let updatedUtcOverride: string | null = null;
let dataOriginOverride: string | null = null;
const base = () => `http://127.0.0.1:${server.port}`;
const shardPath = (id: string, group: string, n: number) =>
  `/${id}/zarr/${ZARR}/${group}/0/c/0/${n}`;

/** A Range response, or the misbehaviour `mode` asks for (shard 0 of nm099500's first group only). */
function serveShard(req: Request, body: Uint8Array, misbehave: boolean): Response {
  const range = req.headers.get("range") ?? "";
  const m = /^bytes=(?:(\d+)-(\d+)|-(\d+))$/.exec(range);
  if (!m) return new Response(body, { status: 200 });
  const isFooter = m[3] !== undefined;
  const start = isFooter ? Math.max(0, body.length - Number(m[3])) : Number(m[1]);
  const end = isFooter ? body.length - 1 : Math.min(Number(m[2]), body.length - 1);
  if (misbehave) {
    if (mode === "5xx" || (mode === "5xx-chunk" && !isFooter)) {
      return new Response("boom", { status: 503 });
    }
    if (mode === "bare200" || (mode === "bare200-chunk" && !isFooter)) {
      return new Response(body, { status: 200 });
    }
    if (mode === "short206" && !isFooter) {
      return new Response(body.slice(start, end), { status: 206 });
    }
    if (mode === "long206" && !isFooter) {
      // Content-Length says one byte more than the Range asked for.
      return new Response(body.slice(start, end + 2), { status: 206 });
    }
    if (mode === "streamed-long206" && !isFooter) {
      // No Content-Length: the body just keeps coming past the asked length.
      const extra = new Uint8Array(1 << 20);
      const slice = body.slice(start, end + 1);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(slice);
            c.enqueue(extra);
            c.close();
          },
        }),
        { status: 206 },
      );
    }
    if (mode === "huge-footer" && isFooter) {
      // The footer claims inner chunk 0 is 1 GiB long (offset stays real).
      const footer = body.slice(start, end + 1);
      new DataView(footer.buffer).setBigUint64(8, 1n << 30n, true);
      return new Response(footer, { status: 206 });
    }
    if (mode === "corrupt-chunk" && !isFooter) {
      const slice = body.slice(start, end + 1);
      slice.fill(0xff, 0, Math.min(slice.length, 32));
      return new Response(slice, { status: 206 });
    }
  }
  return new Response(body.slice(start, end + 1), { status: 206 });
}

function indexFor(id: string, dataId: string, extraGroup = false) {
  const store = index.stores[0];
  const g1 = store.groups[0];
  const groups = extraGroup
    ? [g1, { ...g1, name: "eeg_500hz", rate: 500, n_samples: 3000, duration_s: 6 }]
    : [g1];
  return {
    ...index,
    dataset_id: id,
    ...(updatedUtcOverride === null ? {} : { updated_utc: updatedUtcOverride }),
    data_base: `${dataOriginOverride ?? base()}/${dataId}/zarr/`,
    contract_base: `${base()}/${dataId}/zarr/`,
    stores: [{ ...store, groups }],
  };
}

function emptyGroupNameIndex() {
  const base = indexFor("nm099503", "nm099503");
  const store = base.stores[0];
  return { ...base, stores: [{ ...store, groups: [{ ...store.groups[0], name: "" }] }] };
}

/** nm099505: the same store, but with 5000 extra groups, so its `opened` header is over the
 *  1 MiB frame limit and cannot be framed. The first group is the real one. */
/** nm099506: the index says the store has 3 channels (and zarr.json has 3 scales and offsets),
 *  but the shards hold 4: every chunk decodes to 4 x 1000 values where 3 x 1000 are expected. */
function threeChannelIndex() {
  const base = indexFor("nm099506", "nm099506");
  const store = base.stores[0];
  return { ...base, stores: [{ ...store, groups: [{ ...store.groups[0], n_channels: 3 }] }] };
}
const level0ThreeChannels = {
  ...level0,
  attributes: {
    ...level0.attributes,
    scale: level0.attributes.scale.slice(0, 3),
    offset: level0.attributes.offset.slice(0, 3),
  },
};

function hugeHeaderIndex() {
  const base = indexFor("nm099505", "nm099505");
  const store = base.stores[0];
  const g1 = store.groups[0];
  const extra = Array.from({ length: 5000 }, (_, i) => ({ ...g1, name: `extra_group_${i}` }));
  return { ...base, stores: [{ ...store, groups: [g1, ...extra] }] };
}

beforeAll(() => {
  alias = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => server.fetch(req) });
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      const range = req.headers.get("range");
      allRequests.push(path);
      if (range) rangeRequests.push({ path, range });
      const doc = (d: unknown) => Response.json(d);
      if (path === "/nm099500/zarr/index.json") return doc(indexFor("nm099500", "nm099500"));
      // Same bytes, no records.json and no listing.
      if (path === "/nm099501/zarr/index.json") return doc(indexFor("nm099501", "nm099500"));
      // A second group, served from the same shard bytes under its own group path.
      if (path === "/nm099502/zarr/index.json") return doc(indexFor("nm099502", "nm099502", true));
      // A group with an empty name: valid in the index, but it cannot be a protocol representation id.
      if (path === "/nm099503/zarr/index.json") return doc(emptyGroupNameIndex());
      if (path === "/nm099504/zarr/index.json") return doc(indexFor("nm099504", "nm099500"));
      if (path === "/nm099506/zarr/index.json") return doc(threeChannelIndex());
      if (path === `/nm099506/zarr/${ZARR}/eeg_250hz/0/zarr.json`) return doc(level0ThreeChannels);
      if (path === shardPath("nm099506", "eeg_250hz", 0)) return serveShard(req, shard0, false);
      if (path === shardPath("nm099506", "eeg_250hz", 1)) return serveShard(req, shard1, false);
      if (path === "/nm099505/zarr/index.json") return doc(hugeHeaderIndex());
      if (path === "/nm000111/zarr/index.json") return doc(legacyIndex);
      for (const id of ["nm099500", "nm099502", "nm099503", "nm099505"]) {
        for (const g of ["eeg_250hz", "eeg_500hz", ""]) {
          if (path === `/${id}/zarr/${ZARR}/${g}/0/zarr.json`) return doc(level0);
          if (path === shardPath(id, g, 0)) {
            return serveShard(req, shard0, id === "nm099500" && g === "eeg_250hz");
          }
          if (path === shardPath(id, g, 1)) return serveShard(req, shard1, false);
        }
      }
      if (path === "/data/nm099500") {
        return doc({ latest: "1.0.0", versions: [{ version: "0.5.0" }, { version: "1.0.0" }] });
      }
      if (path === "/data/nm099500/1.0.0/records.json") return doc([RECORD]);
      // A matching record over the 256 KiB cap.
      if (path === "/data/nm099504")
        return doc({ latest: "1.0.0", versions: [{ version: "1.0.0" }] });
      if (path === "/data/nm099504/1.0.0/records.json") {
        return doc([{ bids_relpath: BIDS, filler: "x".repeat(300 * 1024) }]);
      }
      return new Response(null, { status: 404 });
    },
  });
});
afterAll(() => {
  server.stop(true);
  alias.stop(true);
});
beforeEach(() => {
  mode = "good";
  updatedUtcOverride = null;
  dataOriginOverride = null;
  rangeRequests = [];
  allRequests = [];
});

// Every Engine child process is registered here and killed after the test, whatever it
// asserted, so a failing test cannot leak a process.
const engines: { proc: { kill(): void; exited: Promise<number> } }[] = [];
afterEach(async () => {
  for (const e of engines.splice(0)) {
    e.proc.kill();
    await e.proc.exited;
  }
});

// --- The client ------------------------------------------------------------------------------

const ajv = new Ajv2020({ strict: true, allErrors: true });
ajv.addSchema(protocolSchema as object);
const validateJsonResponse = ajv.getSchema(`${protocolSchema.$id}#/$defs/Response`);
if (!validateJsonResponse) throw new Error("the protocol schema has no $defs/Response");

type Msg = { header: Record<string, unknown>; payload: Uint8Array };

class Engine {
  readonly proc: ReturnType<typeof Bun.spawn>;
  private readonly frames: AsyncIterator<FrameEvent>;
  private id = 0;
  readonly responses: Msg[] = [];

  constructor(env: Record<string, string> = {}) {
    this.proc = Bun.spawn({
      cmd: [process.execPath, "run", MAIN],
      cwd: ROOT,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        NEMAR_ZARR_BASE: base(),
        NEMAR_ZARR_DATA_PLANE: `${base()}/data`,
        // Off unless a test turns it on with its own directory: nothing here may touch the
        // developer's real cache.
        NEMAR_ZARR_DISK_CACHE_BYTES: "0",
        ...env,
      },
    });
    engines.push(this);
    const stdout = this.proc.stdout as ReadableStream<Uint8Array>;
    this.frames = readFrames(stdout, { maxPayloadBytes: 1 << 28 })[Symbol.asyncIterator]();
  }

  private get stdin() {
    return this.proc.stdin as { write(b: Uint8Array): number; flush(): void; end(): void };
  }

  nextId(): number {
    return ++this.id;
  }

  sendBytes(b: Uint8Array) {
    this.stdin.write(b);
    this.stdin.flush();
  }

  send(header: Record<string, unknown>) {
    this.sendBytes(encodeFrame(header));
  }

  /** The next response; fails the test on anything that is not a valid response. */
  async recv(): Promise<Msg> {
    const next = await this.frames.next();
    if (next.done) throw new Error("the engine closed stdout before answering");
    const event = next.value;
    if (event.type !== "frame") throw new Error(`stdout carried a bad frame: ${event.message}`);
    const msg = { header: event.header, payload: event.payload };
    const zod = engineResponseSchema.safeParse(msg.header);
    expect(zod.success, `zod: ${JSON.stringify(zod.success ? null : zod.error.issues[0])}`).toBe(
      true,
    );
    const ok = validateJsonResponse?.(msg.header) as boolean;
    expect(ok, `ajv: ${JSON.stringify(validateJsonResponse?.errors)}`).toBe(true);
    this.responses.push(msg);
    return msg;
  }

  async call(header: Record<string, unknown>): Promise<Msg> {
    this.send({ id: this.nextId(), ...header });
    return this.recv();
  }

  async hello(): Promise<Msg> {
    return this.call({ type: "hello", protocol: "0.1", client: "g4-test" });
  }

  async open(
    recording = BIDS,
    extra: Record<string, unknown> = {},
    datasetId = "nm099500",
  ): Promise<Msg> {
    return this.call({ type: "open", dataset_id: datasetId, recording, ...extra });
  }

  /** hello + open; returns the handle. */
  async ready(datasetId = "nm099500", extra: Record<string, unknown> = {}): Promise<string> {
    await this.hello();
    const opened = await this.open(BIDS, extra, datasetId);
    expect(opened.header.type, JSON.stringify(opened.header)).toBe("opened");
    return opened.header.handle as string;
  }

  async read(handle: string, args: Record<string, unknown>): Promise<Msg> {
    return this.call({ type: "read_window", handle, ...args });
  }

  /** Close stdin and wait for the process; returns exit status and stderr. */
  async finish(): Promise<{ code: number; stderr: string }> {
    this.stdin.end();
    const code = await this.proc.exited;
    const stderr = await new Response(this.proc.stderr as ReadableStream).text();
    return { code, stderr };
  }

  async stop() {
    this.stdin.end();
    await this.proc.exited;
  }
}
async function withEngine<T>(
  fn: (e: Engine) => Promise<T>,
  env: Record<string, string> = {},
): Promise<T> {
  const engine = new Engine(env);
  try {
    return await fn(engine);
  } finally {
    await engine.stop();
  }
}

const code = (m: Msg) => (m.header.type === "error" ? (m.header.code as string) : m.header.type);

/** Rows of a window payload, whatever its dtype. */
function rowsOf(m: Msg): (Int16Array | Float64Array)[] {
  const h = m.header;
  const nCh = (h.channels as number[]).length;
  const n = h.n_samples as number;
  const buf = m.payload.slice().buffer; // a copy, so aligned
  const flat = h.dtype === "int16" ? new Int16Array(buf) : new Float64Array(buf);
  return Array.from({ length: nCh }, (_, i) => flat.subarray(i * n, (i + 1) * n));
}

// --- The in-process reference (the read core, no engine) --------------------------------------

async function coreWindow(startSample: number, n: number, channels: number[]) {
  const fetcher = createPublicFetcher();
  const cache = new MemoryJsonCache("public");
  const key = { datasetId: "nm099500", sourceCommit: index.source_commit, convertedAt: null };
  const dataBase = `${base()}/nm099500/zarr/`;
  const meta = await loadLevel0ArrayMetadata({
    fetcher,
    cache,
    ...key,
    dataBase,
    zarr: ZARR,
    group: "eeg_250hz",
  });
  if (!meta.ok) throw new Error(meta.detail);
  const read = await readLevel0Window({
    fetcher,
    cache,
    key,
    dataBase,
    zarr: ZARR,
    groupName: "eeg_250hz",
    shardSamples: expected.shard_samples,
    chunkSamples: expected.chunk_samples,
    nInner: expected.n_inner_per_shard,
    nChannelsInStore: expected.n_channels,
    nSamplesTotal: N,
    startSample,
    endSampleExclusive: startSample + n,
  });
  if (!read.ok) throw new Error(read.detail);
  const run = (scale: number[], offset: number[]) =>
    assembleWindow({
      channels,
      startSample,
      nSamples: n,
      segments: read.segments,
      scale,
      offset,
      fillValue: 0,
    });
  return {
    physical: run(meta.metadata.scale, meta.metadata.offset),
    digital: run([1, 1, 1, 1], [0, 0, 0, 0]),
  };
}

// --- Windows used below ----------------------------------------------------------------------
// start_s * 250 and duration_s * 250 are exact integers in each.

const WINDOWS = {
  /** 3750..4250: crosses the shard boundary at 4000. */
  crossShard: { start_s: 15, duration_s: 2, start: 3750, n: 500 },
  /** 1875..2125: the last 125 samples of present chunk 1 and the first 125 of absent chunk 2. */
  touchAbsent: { start_s: 7.5, duration_s: 1, start: 1875, n: 250 },
  /** 2000..3000: entirely the absent chunk. */
  allAbsent: { start_s: 8, duration_s: 4, start: 2000, n: 1000 },
  /** 6250..6500: inside the truncated final chunk, to the last sample. */
  tail: { start_s: 25, duration_s: 1, start: 6250, n: 250 },
  /** The whole array. */
  whole: { start_s: 0, duration_s: 26, start: 0, n: 6500 },
};

describe("read_window values", () => {
  for (const [name, w] of Object.entries(WINDOWS)) {
    test(`${name}: physical equals the core and zarr-python, zero differences`, async () => {
      const reference = await coreWindow(w.start, w.n, [0, 1, 2, 3]);
      await withEngine(async (e) => {
        const h = await e.ready();
        const win = await e.read(h, { start_s: w.start_s, duration_s: w.duration_s });
        expect(win.header).toMatchObject({
          type: "window",
          start_sample: w.start,
          n_samples: w.n,
          channels: [0, 1, 2, 3],
          dtype: "float64",
          layout: "channel-major",
          byte_order: "little",
        });
        expect(windowSchema.safeParse(win.header).success).toBe(true);
        const rows = rowsOf(win);
        let diffCore = 0;
        let diffPython = 0;
        for (let c = 0; c < 4; c++) {
          for (let s = 0; s < w.n; s++) {
            if (rows[c][s] !== reference.physical.values[c][s]) diffCore++;
            const want = referenceDigital[c * N + w.start + s] * SCALE[c] + OFFSET[c];
            if (rows[c][s] !== want) diffPython++;
          }
        }
        expect(diffCore).toBe(0);
        expect(diffPython).toBe(0);
        expect(win.header.filled_ranges).toEqual(
          reference.physical.filledRanges.map((r) => ({
            start_sample: r.start,
            end_sample: r.end,
          })),
        );
      });
    });

    test(`${name}: digital is the raw int16, equal to the core and zarr-python`, async () => {
      const reference = await coreWindow(w.start, w.n, [0, 1, 2, 3]);
      await withEngine(async (e) => {
        const h = await e.ready();
        const win = await e.read(h, {
          start_s: w.start_s,
          duration_s: w.duration_s,
          units: "digital",
        });
        expect(win.header.dtype).toBe("int16");
        expect(win.header.payload_bytes).toBe(4 * w.n * 2);
        const rows = rowsOf(win);
        let differences = 0;
        for (let c = 0; c < 4; c++) {
          for (let s = 0; s < w.n; s++) {
            if (rows[c][s] !== reference.digital.values[c][s]) differences++;
            if (rows[c][s] !== referenceDigital[c * N + w.start + s]) differences++;
          }
        }
        expect(differences).toBe(0);
      });
    });
  }

  test("filled_ranges mark the absent chunk, and the fill reads as offset[c] (physical) and 0 (digital)", async () => {
    await withEngine(async (e) => {
      const h = await e.ready();
      const touch = await e.read(h, { start_s: 7.5, duration_s: 1 });
      expect(touch.header.filled_ranges).toEqual([{ start_sample: 2000, end_sample: 2125 }]);
      const rows = rowsOf(touch);
      for (let c = 0; c < 4; c++) {
        for (let s = 2000 - 1875; s < 250; s++) expect(rows[c][s]).toBe(OFFSET[c]);
        // The last present sample before the gap is a real value, not the fill.
        expect(rows[c][2000 - 1875 - 1]).toBe(
          referenceDigital[c * N + 1999] * SCALE[c] + OFFSET[c],
        );
      }
      const all = await e.read(h, { start_s: 8, duration_s: 4, units: "digital" });
      expect(all.header.filled_ranges).toEqual([{ start_sample: 2000, end_sample: 3000 }]);
      for (const row of rowsOf(all)) expect(row.every((v) => v === 0)).toBe(true);
      const present = await e.read(h, { start_s: 0, duration_s: 4 });
      expect(present.header.filled_ranges).toEqual([]);
    });
  });

  test("the zarr-python spot checks of nm099500-expected.json hold", async () => {
    await withEngine(async (e) => {
      const h = await e.ready();
      let checked = 0;
      for (const spot of expected.spot_checks as {
        channel: number;
        global_sample: number;
        digital: number;
        physical: number;
        fill_value_substituted: boolean;
        addressable_via_read_window: boolean;
      }[]) {
        if (!spot.addressable_via_read_window) continue;
        checked++;
        const args = {
          start_s: spot.global_sample / RATE,
          duration_s: 1 / RATE,
          channels: [spot.channel],
        };
        const phys = await e.read(h, args);
        expect(rowsOf(phys)[0][0]).toBe(spot.physical);
        const dig = await e.read(h, { ...args, units: "digital" });
        expect(rowsOf(dig)[0][0]).toBe(spot.digital);
        expect((phys.header.filled_ranges as unknown[]).length > 0).toBe(
          spot.fill_value_substituted,
        );
      }
      // The loop must have checked something: all-skipped would pass vacuously.
      expect(checked).toBeGreaterThan(0);
    });
  });

  test("named channels come back in the request's order, and only those rows", async () => {
    await withEngine(async (e) => {
      const h = await e.ready();
      const win = await e.read(h, { start_s: 0, duration_s: 1, channels: [3, 1] });
      expect(win.header.channels).toEqual([3, 1]);
      const rows = rowsOf(win);
      expect(rows.length).toBe(2);
      for (let s = 0; s < 250; s++) {
        expect(rows[0][s]).toBe(referenceDigital[3 * N + s] * SCALE[3] + OFFSET[3]);
        expect(rows[1][s]).toBe(referenceDigital[1 * N + s] * SCALE[1] + OFFSET[1]);
      }
    });
  });

  test("an unordered 3-channel read across an absent chunk equals the core and zarr-python", async () => {
    const channels = [3, 0, 2];
    const w = WINDOWS.touchAbsent;
    const reference = await coreWindow(w.start, w.n, channels);
    await withEngine(async (e) => {
      const h = await e.ready();
      for (const units of ["physical", "digital"] as const) {
        const win = await e.read(h, {
          start_s: w.start_s,
          duration_s: w.duration_s,
          channels,
          units,
        });
        expect(win.header.channels).toEqual(channels);
        expect(win.header.filled_ranges).toEqual([{ start_sample: 2000, end_sample: 2125 }]);
        const rows = rowsOf(win);
        const ref = units === "physical" ? reference.physical : reference.digital;
        let differences = 0;
        channels.forEach((c, row) => {
          for (let s = 0; s < w.n; s++) {
            if (rows[row][s] !== ref.values[row][s]) differences++;
            const digital = s < 125 ? referenceDigital[c * N + w.start + s] : 0;
            const want =
              units === "digital" ? digital : s < 125 ? digital * SCALE[c] + OFFSET[c] : OFFSET[c];
            if (rows[row][s] !== want) differences++;
          }
        });
        expect(differences).toBe(0);
      }
    });
  });

  test("an unknown request field is ignored", async () => {
    await withEngine(async (e) => {
      const h = await e.ready();
      const win = await e.read(h, {
        start_s: 0,
        duration_s: 1,
        units: "digital",
        future_field: [1],
      });
      expect(win.header.type).toBe("window");
      expect(win.header.dtype).toBe("int16");
    });
  });
});

describe("the cache", () => {
  test("a second open of the same dataset sends no request at all", async () => {
    await withEngine(async (e) => {
      await e.hello();
      expect((await e.open()).header.type).toBe("opened");
      expect(allRequests.filter((p) => p === "/nm099500/zarr/index.json").length).toBe(1);
      const after = allRequests.length;
      expect(after).toBeGreaterThan(1);
      expect((await e.open()).header.type).toBe("opened");
      expect(allRequests.length).toBe(after);
    });
  });

  test("the same read_window again sends no range request", async () => {
    await withEngine(async (e) => {
      const h = await e.ready();
      const args = { start_s: 15, duration_s: 2 };
      rangeRequests = [];
      const first = await e.read(h, args);
      const afterFirst = rangeRequests.length;
      expect(afterFirst).toBeGreaterThan(0);
      const second = await e.read(h, args);
      expect(rangeRequests.length).toBe(afterFirst);
      expect(second.payload).toEqual(first.payload);
      expect(second.header).toEqual({ ...first.header, id: second.header.id });
    });
  });

  test("a different window in cached chunks still needs no new footer", async () => {
    await withEngine(async (e) => {
      const h = await e.ready();
      await e.read(h, { start_s: 0, duration_s: 1 });
      rangeRequests = [];
      await e.read(h, { start_s: 1, duration_s: 1 });
      // No footer (suffix) read again for shard 0.
      expect(rangeRequests.filter((r) => r.range.startsWith("bytes=-"))).toEqual([]);
    });
  });

  test("with a range cache too small to hold anything, the same read goes to the host again", async () => {
    await withEngine(
      async (e) => {
        const h = await e.ready();
        const args = { start_s: 0, duration_s: 1 };
        await e.read(h, args);
        rangeRequests = [];
        await e.read(h, args);
        expect(rangeRequests.length).toBeGreaterThan(0);
      },
      { NEMAR_ZARR_RANGE_CACHE_BYTES: "1" },
    );
  });
});

describe("the disk cache across engine restarts (G4)", () => {
  let cacheDir: string;
  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "nemar-engine-cache-"));
  });
  afterEach(() => rmSync(cacheDir, { recursive: true, force: true }));
  const cached = (extra: Record<string, string> = {}) => ({
    NEMAR_ZARR_DISK_CACHE_DIR: cacheDir,
    NEMAR_ZARR_DISK_CACHE_BYTES: String(64 * 1024 * 1024),
    ...extra,
  });
  const args = { start_s: 15, duration_s: 2 };

  async function firstRead(): Promise<Msg> {
    return withEngine(async (e) => {
      const h = await e.ready();
      rangeRequests = [];
      const win = await e.read(h, args);
      expect(win.header.type).toBe("window");
      expect(rangeRequests.length).toBeGreaterThan(0);
      return win;
    }, cached());
  }

  test("a second engine makes the same read with zero range requests and an identical payload", async () => {
    const first = await firstRead();
    // Engine 1 really wrote the array metadata (zarr.json) and a shard footer to disk, so the
    // assertions below about zarr.json are not vacuous.
    const stored = readdirSync(cacheDir)
      .filter((n) => /^[0-9a-f]{2}$/.test(n))
      .flatMap((sub) =>
        readdirSync(join(cacheDir, sub)).map((n) =>
          readFileSync(join(cacheDir, sub, n)).toString("latin1"),
        ),
      );
    expect(stored.some((t) => t.includes("json\n") && t.includes('"projection":"array/'))).toBe(
      true,
    );
    expect(stored.some((t) => t.includes("json\n") && t.includes('"projection":"shardidx/'))).toBe(
      true,
    );
    await withEngine(async (e) => {
      allRequests = [];
      const h = await e.ready();
      rangeRequests = [];
      const second = await e.read(h, args);
      expect(rangeRequests).toEqual([]);
      expect(second.payload).toEqual(first.payload);
      expect(second.header).toEqual({ ...first.header, id: second.header.id });
      // The index is never cached on disk: this engine read it again, which is how a
      // re-conversion is noticed. The array metadata came from disk.
      expect(allRequests.filter((p) => p === "/nm099500/zarr/index.json").length).toBe(1);
      expect(allRequests.filter((p) => p.endsWith("/zarr.json"))).toEqual([]);
    }, cached());
  });

  test("a changed updated_utc in the index sends the read back to the host", async () => {
    const first = await firstRead();
    updatedUtcOverride = "2099-01-01T00:00:00Z";
    await withEngine(async (e) => {
      const h = await e.ready();
      rangeRequests = [];
      const second = await e.read(h, args);
      expect(rangeRequests.length).toBeGreaterThan(0);
      // The store's bytes did not change here, so the values still match.
      expect(second.payload).toEqual(first.payload);
    }, cached());
  });

  test("an index whose data base moves to another origin is read from the new origin", async () => {
    await firstRead();
    dataOriginOverride = `http://127.0.0.1:${alias.port}`;
    await withEngine(async (e) => {
      const h = await e.ready();
      rangeRequests = [];
      await e.read(h, args);
      expect(rangeRequests.length).toBeGreaterThan(0);
    }, cached());
  });

  test("a cache limit of 0 writes nothing, so the next engine goes to the host", async () => {
    await withEngine(
      async (e) => {
        const h = await e.ready();
        await e.read(h, args);
      },
      cached({ NEMAR_ZARR_DISK_CACHE_BYTES: "0" }),
    );
    expect(existsSync(cacheDir) ? readdirSync(cacheDir) : []).toEqual([]);
    await withEngine(
      async (e) => {
        const h = await e.ready();
        rangeRequests = [];
        await e.read(h, args);
        expect(rangeRequests.length).toBeGreaterThan(0);
      },
      cached({ NEMAR_ZARR_DISK_CACHE_BYTES: "0" }),
    );
  });

  test("an unusable cache directory does not fail the read and says so once on stderr", async () => {
    const blocker = join(cacheDir, "a-file");
    await Bun.write(blocker, "x");
    const engine = new Engine(cached({ NEMAR_ZARR_DISK_CACHE_DIR: join(blocker, "cache") }));
    const h = await engine.ready();
    const win = await engine.read(h, args);
    expect(win.header.type).toBe("window");
    const { stderr } = await engine.finish();
    expect(stderr.split("\n").filter((l) => l.includes("disk cache")).length).toBe(1);
  });

  test("a corrupted cache file is a miss: the engine reads from the host and heals it", async () => {
    const first = await firstRead();
    // Corrupt every entry.
    for (const sub of readdirSync(cacheDir).filter((n) => /^[0-9a-f]{2}$/.test(n))) {
      for (const name of readdirSync(join(cacheDir, sub))) {
        await Bun.write(join(cacheDir, sub, name), "garbage");
      }
    }
    await withEngine(async (e) => {
      const h = await e.ready();
      rangeRequests = [];
      const second = await e.read(h, args);
      expect(rangeRequests.length).toBeGreaterThan(0);
      expect(second.payload).toEqual(first.payload);
    }, cached());
    await withEngine(async (e) => {
      const h = await e.ready();
      rangeRequests = [];
      await e.read(h, args);
      expect(rangeRequests).toEqual([]);
    }, cached());
  });
});

describe("refusals and limits", () => {
  test("a payload over the limit is too_large and sends no range request", async () => {
    await withEngine(
      async (e) => {
        const hello = await e.hello();
        expect(hello.header.max_payload_bytes).toBe(5000);
        const opened = await e.open();
        const h = opened.header.handle as string;
        rangeRequests = [];
        // 4 channels x 250 samples x 8 bytes = 8000 payload bytes, over 5000; the decode work
        // (4 x 250 x 2 = 2000) is within it, so this is the payload check alone.
        const r = await e.read(h, { start_s: 0, duration_s: 1 });
        expect(code(r)).toBe("too_large");
        expect(rangeRequests).toEqual([]);
        // A read within the limit still works afterwards: 1 channel x 100 digital samples = 200
        // payload bytes, decode 4 x 100 x 2 = 800.
        const ok = await e.read(h, {
          start_s: 0,
          duration_s: 0.4,
          channels: [0],
          units: "digital",
        });
        expect(ok.header.type).toBe("window");
      },
      { NEMAR_ZARR_MAX_PAYLOAD_BYTES: "5000" },
    );
  });

  test("a read of exactly max_payload_bytes is accepted, and one byte fewer allowed is too_large", async () => {
    // 4 channels x 250 samples x 8 bytes = 8000 payload bytes; the decode work is 2000.
    await withEngine(
      async (e) => {
        const h = await e.ready();
        const win = await e.read(h, { start_s: 0, duration_s: 1 });
        expect(win.header.type).toBe("window");
        expect(win.payload.length).toBe(8000);
      },
      { NEMAR_ZARR_MAX_PAYLOAD_BYTES: "8000" },
    );
    await withEngine(
      async (e) => {
        const h = await e.ready();
        rangeRequests = [];
        const r = await e.read(h, { start_s: 0, duration_s: 1 });
        expect(code(r)).toBe("too_large");
        expect(rangeRequests).toEqual([]);
      },
      { NEMAR_ZARR_MAX_PAYLOAD_BYTES: "7999" },
    );
  });

  test("a small payload from a wide store is refused on its decode work, before any fetch", async () => {
    await withEngine(
      async (e) => {
        const h = await e.ready();
        rangeRequests = [];
        // 1 channel x 1000 digital samples = 2000 payload bytes (fine), but a chunk holds all 4
        // channels: 4 x 1000 x 2 = 8000 decoded, over 6000.
        const r = await e.read(h, { start_s: 0, duration_s: 4, channels: [0], units: "digital" });
        expect(code(r)).toBe("too_large");
        expect(String(r.header.message)).toContain("decodes");
        expect(rangeRequests).toEqual([]);
      },
      { NEMAR_ZARR_MAX_PAYLOAD_BYTES: "6000" },
    );
  });

  test("a bad limit in the environment stops the engine with status 1 and a message on stderr", async () => {
    const e = new Engine({ NEMAR_ZARR_MAX_PAYLOAD_BYTES: "lots" });
    const { code: status, stderr } = await e.finish();
    expect(status).toBe(1);
    expect(stderr).toContain("NEMAR_ZARR_MAX_PAYLOAD_BYTES");
  });

  test("a zarr base that is plain http to a non-loopback host stops the engine with status 1", async () => {
    const e = new Engine({ NEMAR_ZARR_BASE: "http://zarr.nemar.org" });
    const { code: status, stderr } = await e.finish();
    expect(status).toBe(1);
    expect(stderr).toContain("NEMAR_ZARR_BASE");
  });
});

describe("host failures never produce a window", () => {
  const cases: { mode: Mode; code: string; retry: boolean }[] = [
    { mode: "5xx", code: "upstream_error", retry: true },
    { mode: "5xx-chunk", code: "upstream_error", retry: true },
    { mode: "bare200", code: "upstream_error", retry: true },
    { mode: "bare200-chunk", code: "upstream_error", retry: true },
    { mode: "short206", code: "upstream_error", retry: true },
    { mode: "long206", code: "upstream_error", retry: true },
    { mode: "streamed-long206", code: "upstream_error", retry: true },
    // Corrupt bytes arrive as a perfectly good 206, so they are cached; no retry claim.
    { mode: "corrupt-chunk", code: "decode_error", retry: false },
  ];
  for (const c of cases) {
    test(`${c.mode} -> ${c.code}`, async () => {
      await withEngine(async (e) => {
        const h = await e.ready();
        mode = c.mode;
        for (const units of ["physical", "digital"]) {
          const r = await e.read(h, { start_s: 0, duration_s: 1, units });
          expect(code(r), JSON.stringify(r.header)).toBe(c.code);
          expect(r.payload.length).toBe(0);
          expect(r.header.type).toBe("error");
        }
        if (c.retry) {
          // The failure was not cached: the same read succeeds once the host recovers.
          mode = "good";
          const ok = await e.read(h, { start_s: 0, duration_s: 1 });
          expect(ok.header.type).toBe("window");
        }
      });
    });
  }
});

describe("a hostile shard footer", () => {
  test("a footer claiming a 1 GiB chunk is upstream_error, and the range is never requested", async () => {
    await withEngine(async (e) => {
      const h = await e.ready();
      mode = "huge-footer";
      const r = await e.read(h, { start_s: 0, duration_s: 1 });
      expect(code(r), JSON.stringify(r.header)).toBe("upstream_error");
      expect(String(r.header.message)).toContain("one read of this window can need");
      expect(r.payload.length).toBe(0);
      // Only the footer (a suffix range) reached shard 0: no chunk range was sent at all.
      const shard0 = shardPath("nm099500", "eeg_250hz", 0);
      const sent = rangeRequests.filter((q) => q.path === shard0).map((q) => q.range);
      expect(sent.length).toBeGreaterThan(0);
      for (const range of sent) expect(range).toMatch(/^bytes=-\d+$/);
    });
  });
});

describe("a store that disagrees with its index", () => {
  test("chunks that decode to the wrong number of values are decode_error", async () => {
    await withEngine(async (e) => {
      const h = await e.ready("nm099506");
      const r = await e.read(h, { start_s: 0, duration_s: 1 });
      expect(code(r), JSON.stringify(r.header)).toBe("decode_error");
      expect(String(r.header.message)).toContain("decoded to");
      expect(r.payload.length).toBe(0);
    });
  });
});

describe("protocol rules", () => {
  test("a request before hello is invalid_message", async () => {
    await withEngine(async (e) => {
      const r = await e.open();
      expect(code(r)).toBe("invalid_message");
      expect(r.header.id).toBe(1);
      // The engine is still there and hello still works.
      expect((await e.hello()).header.type).toBe("hello");
    });
  });

  test('"9.0" is unsupported_version, after which "0.1" works', async () => {
    await withEngine(async (e) => {
      const bad = await e.call({ type: "hello", protocol: "9.0", client: "t" });
      expect(code(bad)).toBe("unsupported_version");
      const good = await e.call({ type: "hello", protocol: "0.1", client: "t" });
      expect(good.header).toMatchObject({ type: "hello", protocol: "0.1" });
      expect(good.header.max_payload_bytes).toBe(256 * 1024 * 1024);
      expect(String(good.header.engine)).toMatch(/^nemar-zarr-engine\//);
    });
  });

  test("an unsupported version wins over an otherwise invalid hello", async () => {
    await withEngine(async (e) => {
      const r = await e.call({ type: "hello", protocol: "9.0" }); // no client
      expect(code(r)).toBe("unsupported_version");
    });
  });

  test("a malformed protocol string is invalid_message", async () => {
    await withEngine(async (e) => {
      expect(code(await e.call({ type: "hello", protocol: "0.01", client: "t" }))).toBe(
        "invalid_message",
      );
      expect(code(await e.call({ type: "hello", protocol: 1, client: "t" }))).toBe(
        "invalid_message",
      );
    });
  });

  test("a second hello is invalid_message, and the engine still serves", async () => {
    await withEngine(async (e) => {
      await e.hello();
      expect(code(await e.hello())).toBe("invalid_message");
      expect((await e.open()).header.type).toBe("opened");
    });
  });

  test("a request with an unknown type or a missing field is invalid_message and keeps its id", async () => {
    await withEngine(async (e) => {
      await e.hello();
      const unknown = await e.call({ type: "frobnicate" });
      expect(code(unknown)).toBe("invalid_message");
      expect(unknown.header.id).toBe(2);
      const missing = await e.call({ type: "open", dataset_id: "nm099500" });
      expect(code(missing)).toBe("invalid_message");
    });
  });

  test("a request whose id cannot be read gets id null", async () => {
    await withEngine(async (e) => {
      await e.hello();
      e.send({ id: "x", type: "release", handle: "h1" });
      const r = await e.recv();
      expect(r.header).toMatchObject({ id: null, type: "error", code: "invalid_message" });
    });
  });

  test("a frame with bad JSON gets id null, and the engine carries on", async () => {
    await withEngine(async (e) => {
      await e.hello();
      const junk = new TextEncoder().encode("{not json}".padEnd(16, " "));
      const frame = new Uint8Array(8 + junk.length);
      frame.set(new TextEncoder().encode("NZE0"), 0);
      new DataView(frame.buffer).setUint32(4, junk.length, true);
      frame.set(junk, 8);
      e.sendBytes(frame);
      const r = await e.recv();
      expect(r.header).toMatchObject({ id: null, type: "error", code: "invalid_message" });
      expect((await e.open()).header.type).toBe("opened");
    });
  });

  test("a request that declares a payload is invalid_message", async () => {
    await withEngine(async (e) => {
      await e.hello();
      e.sendBytes(
        encodeFrame(
          { id: e.nextId(), type: "release", handle: "h1", payload_bytes: 8 },
          new Uint8Array(8),
        ),
      );
      const r = await e.recv();
      expect(code(r)).toBe("invalid_message");
      expect((await e.open()).header.type).toBe("opened");
    });
  });

  test("bad magic gets id null and the engine exits with status 2", async () => {
    const e = new Engine();
    await e.hello();
    e.sendBytes(new TextEncoder().encode("GET / HTTP/1.1\r\n\r\n"));
    const r = await e.recv();
    expect(r.header).toMatchObject({ id: null, type: "error", code: "invalid_message" });
    const { code: status } = await e.finish();
    expect(status).toBe(2);
  });

  test("an oversized header_len gets id null and status 2", async () => {
    const e = new Engine();
    const prefix = new Uint8Array(8);
    prefix.set(new TextEncoder().encode("NZE0"), 0);
    new DataView(prefix.buffer).setUint32(4, 2 * 1024 * 1024, true);
    e.sendBytes(prefix);
    const r = await e.recv();
    expect(r.header).toMatchObject({ id: null, code: "invalid_message" });
    expect((await e.finish()).code).toBe(2);
  });

  test("an unpadded prefix gets id null and status 2", async () => {
    const e = new Engine();
    const frame = new Uint8Array(8 + 3);
    frame.set(new TextEncoder().encode("NZE0"), 0);
    new DataView(frame.buffer).setUint32(4, 3, true);
    frame.set(new TextEncoder().encode("{} "), 8);
    e.sendBytes(frame);
    const r = await e.recv();
    expect(r.header).toMatchObject({ id: null, code: "invalid_message" });
    expect((await e.finish()).code).toBe(2);
  });

  test("end of input between frames is status 0, mid-frame is status 2", async () => {
    const clean = new Engine();
    await clean.hello();
    expect((await clean.finish()).code).toBe(0);

    const cut = new Engine();
    await cut.hello();
    const frame = encodeFrame({ id: 2, type: "release", handle: "h1" });
    cut.sendBytes(frame.subarray(0, FRAME_PREFIX_BYTES + 4));
    const status = (await cut.finish()).code;
    expect(status).toBe(2);
  });

  test("stdout carries only frames: logs go to stderr", async () => {
    // A missing record logs a warning; if it went to stdout the next recv() would see a bad frame.
    const e = new Engine();
    await e.hello();
    const opened = await e.open(BIDS, {}, "nm099501");
    expect(opened.header.record).toBeNull();
    expect((await e.call({ type: "release", handle: opened.header.handle })).header.type).toBe(
      "released",
    );
    const { code: status, stderr } = await e.finish();
    expect(status).toBe(0);
    expect(stderr).toContain("records for nm099501 unavailable");
  });

  test("handles: unknown, released, and ids that grow", async () => {
    await withEngine(async (e) => {
      await e.hello();
      expect(code(await e.read("h99", { start_s: 0, duration_s: 1 }))).toBe("unknown_handle");
      expect(code(await e.call({ type: "recipe", handle: "h99", start_s: 0, duration_s: 1 }))).toBe(
        "unknown_handle",
      );
      expect(code(await e.call({ type: "release", handle: "h99" }))).toBe("unknown_handle");
      const a = (await e.open()).header.handle as string;
      const b = (await e.open()).header.handle as string;
      expect([a, b]).toEqual(["h1", "h2"]);
      expect((await e.call({ type: "release", handle: a })).header.type).toBe("released");
      expect(code(await e.read(a, { start_s: 0, duration_s: 1 }))).toBe("unknown_handle");
      expect(code(await e.call({ type: "release", handle: a }))).toBe("unknown_handle");
      // The other handle is unaffected.
      expect((await e.read(b, { start_s: 0, duration_s: 1 })).header.type).toBe("window");
    });
  });

  test("windows and channels outside the data are out_of_range", async () => {
    await withEngine(async (e) => {
      const h = await e.ready();
      const cases: Record<string, unknown>[] = [
        { start_s: 26, duration_s: 1 }, // starts at the end
        { start_s: 25.5, duration_s: 1 }, // runs past it
        { start_s: 1000, duration_s: 1 },
        { start_s: 0, duration_s: 0.001 }, // rounds to 0 samples
        { start_s: 0, duration_s: 27 },
        { start_s: 0, duration_s: 1, channels: [4] },
        { start_s: 0, duration_s: 1, channels: [0, 1, 99] },
      ];
      rangeRequests = [];
      for (const args of cases) {
        const r = await e.read(h, args);
        expect(code(r), JSON.stringify(args)).toBe("out_of_range");
      }
      // The last whole window is accepted; one more sample is not.
      expect((await e.read(h, { start_s: 25, duration_s: 1 })).header.type).toBe("window");
      expect(rangeRequests.length).toBeGreaterThan(0);
      // Refusals before it sent nothing: only the accepted read produced range requests.
    });
  });

  test("an out-of-range window sends no range request", async () => {
    await withEngine(async (e) => {
      const h = await e.ready();
      rangeRequests = [];
      await e.read(h, { start_s: 26, duration_s: 1 });
      await e.read(h, { start_s: 0, duration_s: 1, channels: [4] });
      expect(rangeRequests).toEqual([]);
    });
  });

  test("invalid read_window arguments are invalid_message", async () => {
    await withEngine(async (e) => {
      const h = await e.ready();
      for (const args of [
        { start_s: -1, duration_s: 1 },
        { start_s: 0, duration_s: 0 },
        { start_s: 0, duration_s: 1, channels: [] },
        { start_s: 0, duration_s: 1, channels: [1, 1] },
        { start_s: 0, duration_s: 1, units: "volts" },
      ]) {
        expect(code(await e.read(h, args)), JSON.stringify(args)).toBe("invalid_message");
      }
    });
  });
});

describe("open", () => {
  test("the default representation, a named one, and the zarr path all open", async () => {
    await withEngine(async (e) => {
      await e.hello();
      const byBids = await e.open(BIDS);
      expect(openedSchema.safeParse(byBids.header).success).toBe(true);
      expect(byBids.header).toMatchObject({
        dataset_id: "nm099500",
        recording: BIDS,
        representation: "eeg_250hz",
        record: RECORD,
      });
      const byZarr = await e.open(ZARR);
      expect(byZarr.header.recording).toBe(BIDS);
      const named = await e.open(BIDS, { representation: "eeg_250hz" });
      expect(named.header.representation).toBe("eeg_250hz");
      expect(named.header.handle).not.toBe(byBids.header.handle);
    });
  });

  test("representations carry the group's values, and scale and offset only on the bound one", async () => {
    await withEngine(async (e) => {
      await e.hello();
      const opened = await e.open(BIDS, {}, "nm099502");
      const reps = opened.header.representations as Record<string, unknown>[];
      expect(reps.map((r) => r.id)).toEqual(["eeg_250hz", "eeg_500hz"]);
      expect(reps[0]).toMatchObject({
        kind: "zarr",
        store: ZARR,
        modality: "EEG",
        sampling_frequency: 250,
        source_sampling_frequency: 1000,
        nchans: 4,
        ntimes: 6500,
        recording_duration: 26,
        scale: SCALE,
        offset: OFFSET,
      });
      expect(reps[1]).toMatchObject({
        sampling_frequency: 500,
        ntimes: 3000,
        scale: null,
        offset: null,
      });
      // The record belongs to nm099500 only: nm099502 has none.
      expect(opened.header.record).toBeNull();
    });
  });

  test("a named second representation binds to its own rate and length", async () => {
    await withEngine(async (e) => {
      await e.hello();
      const opened = await e.open(BIDS, { representation: "eeg_500hz" }, "nm099502");
      expect(opened.header.representation).toBe("eeg_500hz");
      const h = opened.header.handle as string;
      // 0.5 s at 500 Hz is sample 250; 1 s is 500 samples. Same bytes as group 1, so the
      // digital values are those of zarr-python's reference at the same sample positions.
      const win = await e.read(h, { start_s: 0.5, duration_s: 1, units: "digital" });
      expect(win.header).toMatchObject({ start_sample: 250, n_samples: 500 });
      const rows = rowsOf(win);
      for (let c = 0; c < 4; c++) {
        for (let s = 0; s < 500; s++) {
          expect(rows[c][s]).toBe(referenceDigital[c * N + 250 + s]);
        }
      }
      // 3000 samples is the end of the second group: 6 s at 500 Hz is out of range from 5.5 s.
      expect(code(await e.read(h, { start_s: 5.5, duration_s: 1 }))).toBe("out_of_range");
      // The first group's rate would allow it; the bound rate decides.
      const first = await e.open(BIDS, {}, "nm099502");
      expect(
        (await e.read(first.header.handle as string, { start_s: 5.5, duration_s: 1 })).header.type,
      ).toBe("window");
    });
  });

  test("open failures: unknown dataset, recording or representation, and a legacy index", async () => {
    await withEngine(async (e) => {
      await e.hello();
      expect(code(await e.open(BIDS, {}, "nm000999"))).toBe("not_found");
      expect(code(await e.open("sub-x/eeg/missing.edf"))).toBe("not_found");
      expect(code(await e.open(BIDS, { representation: "nope" }))).toBe("not_found");
      expect(code(await e.open("sub-I003/eeg/sub-I003_task-sleep_eeg.edf", {}, "nm000111"))).toBe(
        "not_ready",
      );
    });
  });

  test("record is null when records.json is missing, and the open still succeeds", async () => {
    await withEngine(async (e) => {
      await e.hello();
      const opened = await e.open(BIDS, {}, "nm099501");
      expect(opened.header.type).toBe("opened");
      expect(opened.header.record).toBeNull();
      expect(opened.header.recording).toBe(BIDS);
    });
  });
});

describe("oversized replies", () => {
  test("a record over 256 KiB is sent as null with one stderr warning, and the open succeeds", async () => {
    const e = new Engine();
    await e.hello();
    const opened = await e.open(BIDS, {}, "nm099504");
    expect(opened.header.type).toBe("opened");
    expect(opened.header.record).toBeNull();
    const { code: status, stderr } = await e.finish();
    expect(status).toBe(0);
    expect(stderr.match(/is over 262144 bytes/g)?.length).toBe(1);
  });

  test("a reply too big to frame is an internal error for its id, and the engine keeps serving", async () => {
    const e = new Engine();
    await e.hello();
    const big = await e.open(BIDS, {}, "nm099505");
    expect(big.header).toMatchObject({ type: "error", code: "internal", id: 2 });
    // The unsent `opened` registered h1; it must not stay open, since no client knows it.
    const leaked = await e.call({ type: "release", handle: "h1" });
    expect(leaked.header).toMatchObject({ type: "error", code: "unknown_handle" });
    const next = await e.open();
    expect(next.header.type).toBe("opened");
    const { code: status, stderr } = await e.finish();
    expect(status).toBe(0);
    expect(stderr).toContain("could not be framed");
  });
});

describe("handle cap", () => {
  test("the 1025th open is too_large, and opens work again after a release", async () => {
    const e = new Engine();
    await e.hello();
    let first = "";
    for (let i = 0; i < 1024; i++) {
      const r = await e.open();
      expect(r.header.type, `open ${i + 1}`).toBe("opened");
      if (i === 0) first = r.header.handle as string;
    }
    const refused = await e.open();
    expect(refused.header).toMatchObject({ type: "error", code: "too_large" });
    expect(String(refused.header.message)).toContain("release");
    expect((await e.call({ type: "release", handle: first })).header.type).toBe("released");
    expect((await e.open()).header.type).toBe("opened");
    expect((await e.finish()).code).toBe(0);
  });
});

describe("the response self-check", () => {
  test("a response that fails its own schema goes out as internal, never malformed", async () => {
    const e = new Engine();
    await e.hello();
    // The index is valid, but a group named "" would be an `opened` with an empty representation id.
    const r = await e.open(BIDS, {}, "nm099503");
    expect(r.header).toMatchObject({ type: "error", code: "internal" });
    // The engine is still serving.
    expect((await e.open()).header.type).toBe("opened");
    const { code: status, stderr } = await e.finish();
    expect(status).toBe(0);
    expect(stderr).toContain("failed its schema");
  });
});

describe("recipe", () => {
  test("carries sample_slice always and channel_slice only when channels were named", async () => {
    await withEngine(async (e) => {
      const h = await e.ready();
      const all = await e.call({ type: "recipe", handle: h, start_s: 15, duration_s: 2 });
      const recipe = all.header.recipe as Record<string, unknown>;
      expect(recipe.sample_slice).toEqual({ start: 3750, end: 4250 });
      expect("channel_slice" in recipe).toBe(false);
      expect(recipe).toMatchObject({ zarr: ZARR, group: "eeg_250hz", level: "0", dtype: "int16" });

      const named = await e.call({
        type: "recipe",
        handle: h,
        start_s: 0,
        duration_s: 1,
        channels: [3, 1],
      });
      const r2 = named.header.recipe as Record<string, unknown>;
      // From the lowest requested channel to one past the highest, so it includes channel 2.
      expect(r2.channel_slice).toEqual({ start: 1, end: 4 });
      expect(r2.sample_slice).toEqual({ start: 0, end: 250 });
    });
  });

  test("equals the MCP's recipe for the same window, and reads nothing", async () => {
    // The shared schema wants https bases; the stand-in's are loopback http, so override after parsing.
    const parsedIndex = zarrIndexSchema.parse(index);
    const want = buildReadRecipe({
      index: {
        ...parsedIndex,
        data_base: `${base()}/nm099500/zarr/`,
        contract_base: `${base()}/nm099500/zarr/`,
      },
      store: parsedIndex.stores[0],
      groupName: "eeg_250hz",
      sampleSlice: { start: 3750, end: 4250 },
      arrayMetadata: { data_type: level0.data_type, codecs: level0.codecs },
    });
    await withEngine(async (e) => {
      const h = await e.ready();
      rangeRequests = [];
      const got = await e.call({ type: "recipe", handle: h, start_s: 15, duration_s: 2 });
      expect(got.header.recipe).toEqual(JSON.parse(JSON.stringify(want)));
      expect(rangeRequests).toEqual([]);
    });
  });

  test("an out-of-range window is out_of_range", async () => {
    await withEngine(async (e) => {
      const h = await e.ready();
      const r = await e.call({ type: "recipe", handle: h, start_s: 26, duration_s: 1 });
      expect(code(r)).toBe("out_of_range");
      const c = await e.call({
        type: "recipe",
        handle: h,
        start_s: 0,
        duration_s: 1,
        channels: [4],
      });
      expect(code(c)).toBe("out_of_range");
    });
  });
});
