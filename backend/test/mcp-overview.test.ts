/**
 * `render_overview` and its pure helpers (`overview.ts`) -- epic #1065
 * phase 3, issue #1295.
 *
 * Pure-function tests (`pickViewLevel`, `buildChunkPlan`,
 * `reassembleViewChunks`, `renderOverviewPng`) run against nm000329's REAL
 * live geometry (138750 samples, 5 view levels, `view/5` 135 columns in one
 * chunk of `chunk_columns: 135`) and the REAL decoded level-5 chunk bytes
 * (`test/fixtures/mcp/nm000329-view5-c-0-0-0.bin`, `curl -sL -A
 * "nemar-cli/mcp-phase3"` against the live S3 object).
 *
 * The route-level tests drive `render_overview` through `createMcpRoutes`
 * exactly like `mcp-recording-tools.test.ts`: real D1, a real
 * `Bun.serve()` fixture upstream, a real `InMemoryCache`. The request log
 * is the evidence the PR's definition of done asks for: only `view/<L>/`
 * keys are ever read, never `/0/c/` (level 0) and never `zarr.json`.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { decode as decodePng } from "fast-png";
import type { Hono } from "hono";
import { decodeBloscZstdInt16 } from "../../shared/zarr/codecs/blosc.js";
import on003392MegSssSliceRaw from "../../test/fixtures/zarr-index-on003392-meg-sss-slice.json";
import {
  buildChunkPlan,
  computeRowPx,
  computeViewLevelColumns,
  pickViewLevel,
  reassembleViewChunks,
  renderOverviewPng,
} from "../src/mcp/overview.js";
import { type McpRoutesDeps, createMcpRoutes } from "../src/routes/mcp.js";
import { createZarrDataRoutes } from "../src/routes/zarr-data.js";
import type { Bindings } from "../src/types/bindings.js";
import nm000111IndexV1Raw from "./fixtures/mcp/nm000111-index-v1.json";
import nm000329IndexRaw from "./fixtures/mcp/nm000329-index.json";
import { InMemoryCache } from "./helpers/cache.js";
import { freshDb, realD1 } from "./helpers/d1.js";
import { type FixtureServer, startFixtureServer } from "./helpers/fixture-server.js";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const NM000329_N_SAMPLES = 138750;
const NM000329_N_VIEW_LEVELS = 5;

describe("pickViewLevel (nm000329 eeg_250hz: 138750 samples, 5 levels)", () => {
  const cases: Array<[number, number]> = [
    [100, 5],
    [800, 3],
    [4000, 2],
    [40000, 1],
    // Exact-boundary cases (PR review item 14): width_px equal to a
    // level's own column count must still pick that level (the ">="
    // comparison, not ">"), the coarsest level with enough columns.
    [135, 5],
    [2167, 3],
  ];
  for (const [widthPx, expected] of cases) {
    test(`width_px ${widthPx} picks level ${expected}`, () => {
      expect(pickViewLevel(NM000329_N_SAMPLES, NM000329_N_VIEW_LEVELS, widthPx)).toBe(expected);
    });
  }

  test("computeViewLevelColumns matches the live geometry", () => {
    const cols = computeViewLevelColumns(NM000329_N_SAMPLES, NM000329_N_VIEW_LEVELS);
    expect(cols).toEqual([34687, 8671, 2167, 541, 135]);
  });

  test("level 0 is never a candidate; nViewLevels < 1 throws", () => {
    expect(() => pickViewLevel(1000, 0, 100)).toThrow();
  });
});

describe("buildChunkPlan", () => {
  test("the last level (135 columns) is one chunk whose stride is CLAMPED to 135", () => {
    // Read from the real store: `view/5/zarr.json` declares
    // `shape [2, 63, 135]` with `chunk [2, 63, 135]`, and `view/4` likewise
    // clamps to 541. So the producer's `view_chunk_columns: 1024` is an upper
    // bound, not the chunk shape, and reporting 1024 here would make
    // reassembleViewChunks reject a perfectly good single-chunk level.
    const plan = buildChunkPlan({ level: 5, levelColumns: 135, viewChunkColumns: 1024 });
    expect(plan.chunkColumns).toBe(135);
    expect(plan.chunkKeys).toEqual(["view/5/c/0/0/0"]);
  });

  test("a level ABOVE the configured width keeps the configured stride", () => {
    // `view/3/zarr.json`: shape [2, 63, 2167], chunk [2, 63, 1024]. Unclamped.
    const plan = buildChunkPlan({ level: 3, levelColumns: 2167, viewChunkColumns: 1024 });
    expect(plan.chunkColumns).toBe(1024);
  });

  test("a middle level (2167 columns, chunk 1024) spans three chunks", () => {
    const plan = buildChunkPlan({ level: 3, levelColumns: 2167, viewChunkColumns: 1024 });
    expect(plan.chunkKeys).toEqual(["view/3/c/0/0/0", "view/3/c/0/0/1", "view/3/c/0/0/2"]);
  });

  test("missing view_chunk_columns defaults to 1024", () => {
    const plan = buildChunkPlan({ level: 1, levelColumns: 34687, viewChunkColumns: null });
    expect(plan.chunkColumns).toBe(1024);
    expect(plan.chunkKeys.length).toBe(Math.ceil(34687 / 1024));
  });
});

describe("reassembleViewChunks with a FILL-PADDED boundary chunk (the real Zarr shape)", () => {
  // 2 channels, three chunks of nominal stride 400, and a level of 967 columns.
  // So the third chunk carries 400 columns of which only 167 are real and 233
  // are padding -- which is what Zarr actually writes. The previous version of
  // this test used widths 400 + 400 + 167, a genuinely truncated tail that no
  // store contains, and that is why the suite stayed green while
  // render_overview threw a RangeError on nm000329's default width.
  //
  // Every value is `axis0 * 1000 + channel * 100 + (globalColumn % 100)`, and
  // the padding is a sentinel that appears nowhere in the valid range, so a
  // wrong offset shows up as a wrong number rather than a plausible one, and
  // copied padding is unmistakable.
  const N_CHANNELS = 2;
  const CHUNK_COLUMNS = 400;
  const TOTAL_COLUMNS = 967;
  const PAD = 31337 - 65536; // a distinctive negative int16, never a valid value

  /** A full-stride chunk: `validColumns` real values then fill padding. */
  function buildChunk(startColumn: number, validColumns: number): Int16Array {
    const chunk = new Int16Array(2 * N_CHANNELS * CHUNK_COLUMNS);
    for (let axis0 = 0; axis0 < 2; axis0++) {
      for (let ch = 0; ch < N_CHANNELS; ch++) {
        for (let col = 0; col < CHUNK_COLUMNS; col++) {
          const at = (axis0 * N_CHANNELS + ch) * CHUNK_COLUMNS + col;
          if (col < validColumns) {
            const globalCol = startColumn + col;
            chunk[at] = axis0 * 1000 + ch * 100 + (globalCol % 100);
          } else {
            chunk[at] = PAD;
          }
        }
      }
    }
    return chunk;
  }

  function realChunks(): Int16Array[] {
    const chunks: Int16Array[] = [];
    for (let start = 0; start < TOTAL_COLUMNS; start += CHUNK_COLUMNS) {
      chunks.push(buildChunk(start, Math.min(CHUNK_COLUMNS, TOTAL_COLUMNS - start)));
    }
    return chunks;
  }

  test("every value lands in its correct global column, and no padding is copied", () => {
    const chunks = realChunks();
    expect(chunks.length).toBe(3);
    expect(chunks[2].length).toBe(2 * N_CHANNELS * CHUNK_COLUMNS); // full size, padded

    const reassembled = reassembleViewChunks({
      nChannels: N_CHANNELS,
      totalColumns: TOTAL_COLUMNS,
      chunkColumns: CHUNK_COLUMNS,
      chunks,
    });
    expect(reassembled.length).toBe(2 * N_CHANNELS * TOTAL_COLUMNS);

    // Columns at and around every boundary, plus the first and last overall.
    const checkColumns = [0, 399, 400, 799, 800, TOTAL_COLUMNS - 1];
    for (const globalCol of checkColumns) {
      for (let axis0 = 0; axis0 < 2; axis0++) {
        for (let ch = 0; ch < N_CHANNELS; ch++) {
          const expected = axis0 * 1000 + ch * 100 + (globalCol % 100);
          const actual = reassembled[(axis0 * N_CHANNELS + ch) * TOTAL_COLUMNS + globalCol];
          expect(actual).toBe(expected);
        }
      }
    }
    // The whole point: not one padding value survived into the output. Before
    // the fix, the third chunk's padding was written over channel 1's columns.
    expect(Array.from(reassembled).includes(PAD)).toBe(false);
  });

  test("the exact production shape that used to throw RangeError", () => {
    // nm000329 eeg_250hz level 3: 63 channels, 2167 columns, chunk 1024, three
    // real objects all carrying blosc nbytes 258048 = 2 x 63 x 1024 int16. This
    // is the `width_px: 800` default for that recording, so it was the ordinary
    // path. The old code advanced colOffset by 1024 three times (3072 > 2167)
    // and ran off the end of the output buffer.
    const chunks = [0, 1, 2].map(() => new Int16Array(2 * 63 * 1024));
    const reassembled = reassembleViewChunks({
      nChannels: 63,
      totalColumns: 2167,
      chunkColumns: 1024,
      chunks,
    });
    expect(reassembled.length).toBe(2 * 63 * 2167);
  });

  test("a SHORT chunk is refused, naming both lengths", () => {
    // The old code inferred a width from a short chunk. Now a store whose real
    // geometry disagrees with the index is surfaced instead of silently
    // reassembled at the wrong offsets.
    const chunks = realChunks();
    chunks[2] = chunks[2].subarray(0, 2 * N_CHANNELS * 167);
    expect(() =>
      reassembleViewChunks({
        nChannels: N_CHANNELS,
        totalColumns: TOTAL_COLUMNS,
        chunkColumns: CHUNK_COLUMNS,
        chunks,
      }),
    ).toThrow(/chunk 2 decoded to 668 values, expected 1600/);
  });
});

describe("renderOverviewPng on the real decoded level-5 chunk", () => {
  const chunkBytes = new Uint8Array(
    readFileSync(new URL("./fixtures/mcp/nm000329-view5-c-0-0-0.bin", import.meta.url)),
  );
  const decoded = decodeBloscZstdInt16(chunkBytes);
  const N_CHANNELS = 63;
  const TOTAL_COLUMNS = 135;

  test("the decoded chunk has the expected [2, 63, 135] length", () => {
    expect(decoded.length).toBe(2 * N_CHANNELS * TOTAL_COLUMNS);
  });

  test("reassembleViewChunks accepts a single chunk unchanged", () => {
    // The real chunk shape for this level IS the level (chunk [2, 63, 135]),
    // which is what buildChunkPlan's clamp reports, so nothing is padded here.
    const reassembled = reassembleViewChunks({
      nChannels: N_CHANNELS,
      totalColumns: TOTAL_COLUMNS,
      chunkColumns: TOTAL_COLUMNS,
      chunks: [decoded],
    });
    expect(reassembled.length).toBe(decoded.length);
    expect(Array.from(reassembled)).toEqual(Array.from(decoded));
  });

  test("computeRowPx: 63 channels gives 19px rows; 320 channels gives 3px rows", () => {
    expect(computeRowPx(63)).toBe(19);
    expect(computeRowPx(320)).toBe(3);
  });

  test("produces a PNG with the expected geometry, decodable, with dark pixels in every band", () => {
    const widthPx = 100;
    const rendered = renderOverviewPng({
      nChannels: N_CHANNELS,
      totalColumns: TOTAL_COLUMNS,
      widthPx,
      data: decoded,
    });
    const rowPx = computeRowPx(N_CHANNELS);
    const expectedHeight = N_CHANNELS * rowPx + (N_CHANNELS - 1);
    expect(rendered.widthPx).toBe(widthPx);
    expect(rendered.heightPx).toBe(expectedHeight);

    const image = decodePng(rendered.png);
    expect(image.width).toBe(widthPx);
    expect(image.height).toBe(expectedHeight);
    expect(image.channels).toBe(1);
    expect(image.depth).toBe(8);

    // Every channel band has at least one dark (bar) pixel.
    const bandStride = rowPx + 1;
    for (let ch = 0; ch < N_CHANNELS; ch++) {
      const bandTop = ch * bandStride;
      let sawDark = false;
      for (let r = 0; r < rowPx && !sawDark; r++) {
        for (let x = 0; x < widthPx; x++) {
          if (image.data[(bandTop + r) * widthPx + x] < 128) {
            sawDark = true;
            break;
          }
        }
      }
      expect(sawDark).toBe(true);
    }
  });

  test("a constant channel (min === max everywhere) renders without NaN, one stable band (item 20)", () => {
    const nChannels = 1;
    const totalColumns = 50;
    const widthPx = 20;
    const constantValue = 1234;
    const data = new Int16Array(2 * nChannels * totalColumns).fill(constantValue);

    const rendered = renderOverviewPng({ nChannels, totalColumns, widthPx, data });
    const image = decodePng(rendered.png);
    expect(image.width).toBe(widthPx);

    // No NaN/undefined pixel anywhere -- the span-is-zero guard
    // (`channelMax > channelMin ? ... : 1`) must have kicked in rather than
    // dividing by zero.
    for (let i = 0; i < image.data.length; i++) {
      expect(Number.isFinite(image.data[i])).toBe(true);
    }

    // A stable band: every column's bar lands on the SAME row (the
    // constant value always scales to the same position), so the set of
    // dark rows used across all columns has exactly one member.
    const rowPx = computeRowPx(nChannels);
    const darkRows = new Set<number>();
    for (let r = 0; r < rowPx; r++) {
      for (let x = 0; x < widthPx; x++) {
        if (image.data[r * widthPx + x] < 128) darkRows.add(r);
      }
    }
    expect(darkRows.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Route-level tests
// ---------------------------------------------------------------------------

type App = Hono<{ Bindings: Bindings }>;

const V3_ID = "nm000329";
const V3_COMMIT = "7172d2d492dad63650f80cdb83352a0e9d4420f7";
const V1_ID = "nm000111";
const V1_COMMIT = "510a05377459cf857e60b861ab377bc53b5b5b29";
const ZERO_STORE_ID = "nm500603";
const FIRST_STORE_ZARR = "sub-1/ses-0/eeg/sub-1_ses-0_task-imagery_acq-calibration_run-0_eeg.zarr";

// A synthetic extra store appended to nm000329's index (item 15, route
// level): 4 channels, 117 columns in one view level, chunked at 50 columns
// -- three chunks (50 + 50 + 17, a short last one). nm000329's own real
// `view/3` (the smallest level genuinely needing 3 chunks) is ~490 KB
// across its three chunks -- over budget for a committed fixture -- so
// this store's geometry and chunk bytes are synthetic instead
// (`scripts/zarr/generate_mcp_test_fixture.py`), same codec configuration.
const MULTI_CHUNK_STORE_ZARR = "synthetic/multichunk_test_store.zarr";
const MULTI_CHUNK_GROUP = "synthetic_group";
const MULTI_CHUNK_N_CHANNELS = 4;
const MULTI_CHUNK_N_SAMPLES = 468; // floor(468/4) = 117 columns, one level
const MULTI_CHUNK_VIEW_CHUNK_COLUMNS = 50;

// The MEG SSS derived-store fixture (PR review item 1) -- same synthetic
// geometry mcp-recording-tools.test.ts uses.
const MEG_ID = "on003392";
const MEG_STORE_ZARR = "sub-01/meg/sub-01_task-localizer_meg.zarr";
const MEG_GROUP = "meg_250hz";
const MEG_SYNTHETIC_N_CHANNELS = 8;
const MEG_SYNTHETIC_N_SAMPLES = 8500;
const MEG_SYNTHETIC_N_VIEW_LEVELS = 3;
const MEG_SYNTHETIC_VIEW_LEVEL = 3;

const ctx = {
  waitUntil: (p: Promise<unknown>) => {
    p.catch(() => {});
  },
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

function encode(doc: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(doc));
}

const FIXTURE_PUBLIC_ORIGIN = "https://fixture.nemar.test";

function translatingFetch(real: typeof fetch, fixtureBase: string): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith(FIXTURE_PUBLIC_ORIGIN)) {
      return real(fixtureBase + url.slice(FIXTURE_PUBLIC_ORIGIN.length), init);
    }
    return real(input, init);
  }) as typeof fetch;
}

const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
};

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

async function parseBody(res: Response): Promise<JsonRpcResponse> {
  const text = await res.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
  return JSON.parse(dataLine ? dataLine.slice("data:".length).trim() : text);
}

async function callTool(
  app: App,
  database: Bindings,
  id: number,
  name: string,
  args: Record<string, unknown>,
): Promise<{ res: Response; body: JsonRpcResponse }> {
  const res = await app.request(
    "/mcp",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "Mcp-Method": "tools/call", "Mcp-Name": name },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: args, _meta: MODERN_META },
      }),
    },
    database,
    ctx,
  );
  return { res, body: await parseBody(res) };
}

function errorTextOf(body: JsonRpcResponse): string {
  expect(body.error).toBeUndefined();
  const result = body.result as { isError?: boolean; content: Array<{ text: string }> };
  expect(result.isError).toBe(true);
  return result.content[0]?.text ?? "";
}

interface ImageContentBlock {
  type: "image";
  data: string;
  mimeType: string;
}
interface TextContentBlock {
  type: "text";
  text: string;
}

function contentOf(body: JsonRpcResponse): { isError?: boolean; content: unknown[] } {
  expect(body.error).toBeUndefined();
  const result = body.result as { isError?: boolean; content: unknown[] };
  expect(result.isError).not.toBe(true);
  return result;
}

describe("render_overview (route)", () => {
  let db: Database;
  let app: App;
  let fixtureServer: FixtureServer;
  let cache: InMemoryCache;

  beforeAll(() => {
    fixtureServer = startFixtureServer();

    const multiChunkStore = {
      path: "synthetic/multichunk_test_store_eeg.edf",
      zarr: MULTI_CHUNK_STORE_ZARR,
      source_tree: "raw",
      derived: false,
      modalities: ["eeg"],
      groups: [
        {
          name: MULTI_CHUNK_GROUP,
          modality: "EEG",
          rate: 250,
          n_channels: MULTI_CHUNK_N_CHANNELS,
          n_samples: MULTI_CHUNK_N_SAMPLES,
          duration_s: MULTI_CHUNK_N_SAMPLES / 250,
          n_view_levels: 1,
          view_chunk_columns: MULTI_CHUNK_VIEW_CHUNK_COLUMNS,
        },
      ],
    };
    const rewrittenV3Index = {
      ...nm000329IndexRaw,
      data_base: `${FIXTURE_PUBLIC_ORIGIN}/${V3_ID}/zarr/`,
      contract_base: `${FIXTURE_PUBLIC_ORIGIN}/${V3_ID}/zarr/`,
      events_parquet: `${FIXTURE_PUBLIC_ORIGIN}/${V3_ID}/zarr/events.parquet`,
      stores: [...nm000329IndexRaw.stores, multiChunkStore],
    };
    fixtureServer.files.set(`${V3_ID}/zarr/index.json`, encode(rewrittenV3Index));
    fixtureServer.files.set(`${V1_ID}/zarr/index.json`, encode(nm000111IndexV1Raw));

    const view5Chunk = new Uint8Array(
      readFileSync(new URL("./fixtures/mcp/nm000329-view5-c-0-0-0.bin", import.meta.url)),
    );
    fixtureServer.files.set(
      `${V3_ID}/zarr/${FIRST_STORE_ZARR}/eeg_250hz/view/5/c/0/0/0`,
      view5Chunk,
    );
    const view4Chunk = new Uint8Array(
      readFileSync(new URL("./fixtures/mcp/nm000329-view4-c-0-0-0.bin", import.meta.url)),
    );
    fixtureServer.files.set(
      `${V3_ID}/zarr/${FIRST_STORE_ZARR}/eeg_250hz/view/4/c/0/0/0`,
      view4Chunk,
    );

    for (let k = 0; k < 3; k++) {
      const chunkBytes = new Uint8Array(
        readFileSync(
          new URL(
            `./fixtures/mcp/nm000329-synthetic-multichunk-view1-c-0-0-${k}.bin`,
            import.meta.url,
          ),
        ),
      );
      fixtureServer.files.set(
        `${V3_ID}/zarr/${MULTI_CHUNK_STORE_ZARR}/${MULTI_CHUNK_GROUP}/view/1/c/0/0/${k}`,
        chunkBytes,
      );
    }

    const megStoreRaw = (
      on003392MegSssSliceRaw as {
        stores: Array<{ groups: Array<Record<string, unknown>> } & Record<string, unknown>>;
      }
    ).stores[0];
    const megGroup = {
      ...megStoreRaw.groups[0],
      n_channels: MEG_SYNTHETIC_N_CHANNELS,
      n_samples: MEG_SYNTHETIC_N_SAMPLES,
      n_view_levels: MEG_SYNTHETIC_N_VIEW_LEVELS,
      view_chunk_columns: 1024,
    };
    const megStore = { ...megStoreRaw, groups: [megGroup] };
    const rewrittenMegIndex = {
      ...on003392MegSssSliceRaw,
      data_base: `${FIXTURE_PUBLIC_ORIGIN}/${MEG_ID}/zarr/`,
      contract_base: `${FIXTURE_PUBLIC_ORIGIN}/${MEG_ID}/zarr/`,
      events_parquet: undefined,
      stores: [megStore],
    };
    fixtureServer.files.set(`${MEG_ID}/zarr/index.json`, encode(rewrittenMegIndex));
    const megChunk = new Uint8Array(
      readFileSync(
        new URL("./fixtures/mcp/on003392-synthetic-meg-view3-c-0-0-0.bin", import.meta.url),
      ),
    );
    fixtureServer.files.set(
      `${MEG_ID}/zarr/${MEG_STORE_ZARR}/${MEG_GROUP}/view/${MEG_SYNTHETIC_VIEW_LEVEL}/c/0/0/0`,
      megChunk,
    );

    cache = new InMemoryCache();
    const zarrRoutes = createZarrDataRoutes({
      cache: () => cache,
      fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
      s3Base: fixtureServer.url,
    });
    const deps: McpRoutesDeps = {
      onerror: (err) => console.error("[mcp overview test] transport error", err),
      cache: () => cache,
      fetch: translatingFetch(fetch, fixtureServer.url),
      zarrRoutes,
      rawGithubBase: fixtureServer.url,
    };
    app = createMcpRoutes(deps);
  });

  afterAll(() => {
    fixtureServer.stop();
  });

  function insertDataset(
    datasetId: string,
    cols: Record<string, string | number | null> = {},
  ): void {
    const merged: Record<string, string | number | null> = {
      owner_user_id: -1,
      name: datasetId,
      visibility: "public",
      status: "active",
      is_sandbox: 0,
      ...cols,
    };
    const keys = Object.keys(merged);
    db.query(
      `INSERT INTO datasets (dataset_id, ${keys.join(", ")}) VALUES (?, ${keys.map(() => "?").join(", ")})`,
    ).run(datasetId, ...(keys.map((k) => merged[k]) as never[]));
  }

  beforeEach(() => {
    db = freshDb();
    cache = new InMemoryCache();
    fixtureServer.requestLog.length = 0;
    insertDataset(V3_ID, {
      zarr_status: "ready",
      zarr_store_count: (nm000329IndexRaw as { store_count: number }).store_count,
      zarr_source_commit: V3_COMMIT,
    });
    insertDataset(V1_ID, {
      zarr_status: "ready",
      zarr_store_count: 6,
      zarr_source_commit: V1_COMMIT,
    });
    insertDataset(ZERO_STORE_ID, { zarr_status: "ready", zarr_store_count: 0 });
    insertDataset(MEG_ID, {
      zarr_status: "ready",
      zarr_store_count: 1,
      zarr_source_commit: (on003392MegSssSliceRaw as { source_commit: string }).source_commit,
      concept_doi: (on003392MegSssSliceRaw as { doi: string }).doi,
      license: (on003392MegSssSliceRaw as { license: string }).license,
    });
  });

  function env(database: Database): Bindings {
    return { DB: realD1(database), ENVIRONMENT: "development" } as unknown as Bindings;
  }

  test("width_px 100 picks level 5, reads only view/5/ keys, never /0/c/ or zarr.json", async () => {
    const { body } = await callTool(app, env(db), 1, "render_overview", {
      dataset_id: V3_ID,
      recording: FIRST_STORE_ZARR,
      width_px: 100,
    });
    const result = contentOf(body);
    const content = result.content as Array<ImageContentBlock | TextContentBlock>;
    const image = content.find((c): c is ImageContentBlock => c.type === "image");
    const text = content.find((c): c is TextContentBlock => c.type === "text");
    expect(image).toBeDefined();
    expect(image?.mimeType).toBe("image/png");
    expect(image?.data.length).toBeGreaterThan(0);

    const metadata = JSON.parse(text?.text ?? "{}");
    // Level selection still uses the RAW width, so asking for 100px reads level
    // 5 and one chunk exactly as before -- the render-cache bucketing must not
    // pull in a finer level.
    expect(metadata.level).toBe(5);
    expect(metadata.chunks_read).toBe(1);
    // `width_px` is the SERVED width: 100 rounds up to the 200 bucket, then
    // floors at level 5's own 135 columns, so it is a pure downsample of what
    // was read and never an upscale. Rounding is what bounds the render cache to
    // one entry per (level, bucket) instead of one per distinct integer width.
    expect(metadata.width_px).toBe(135);
    // Null, always. `dtype` is the LEVEL-0 array's dtype from its own zarr.json,
    // and this tool reads the view pyramid and never zarr.json. It used to send
    // "int16" on a cache miss and null on a hit, which made one field mean three
    // different things across the three tools that carry it.
    expect(metadata.envelope?.dtype).toBeNull();

    const objectRequests = fixtureServer.requestLog.filter((r) => r.url.includes(`${V3_ID}/zarr/`));
    const chunkOrMetaRequests = objectRequests.filter((r) => r.url !== `${V3_ID}/zarr/index.json`);
    expect(chunkOrMetaRequests.length).toBeGreaterThan(0);
    for (const r of chunkOrMetaRequests) {
      expect(r.url).toContain("view/5/");
    }
    expect(fixtureServer.requestLog.some((r) => r.url.includes("zarr.json"))).toBe(false);
    expect(fixtureServer.requestLog.some((r) => /\/0\/c\//.test(r.url))).toBe(false);
  });

  test("a second call at the same width is a cache hit with an empty request log", async () => {
    await callTool(app, env(db), 1, "render_overview", {
      dataset_id: V3_ID,
      recording: FIRST_STORE_ZARR,
      width_px: 100,
    });
    fixtureServer.requestLog.length = 0;

    const { body } = await callTool(app, env(db), 2, "render_overview", {
      dataset_id: V3_ID,
      recording: FIRST_STORE_ZARR,
      width_px: 100,
    });
    const result = contentOf(body);
    const text = (result.content as TextContentBlock[]).find((c) => c.type === "text");
    const metadata = JSON.parse(text?.text ?? "{}");
    expect(metadata.chunks_read).toBe(0);
    expect(metadata.bytes_read).toBe(0);
    expect(fixtureServer.requestLog.length).toBe(0);
    // item 8: dtype is "int16" only when this call actually decoded a view
    // array. A cache hit decoded nothing -- the envelope's dtype must be
    // null, not a stale "int16" carried over from the first (miss) call.
    expect(metadata.envelope?.dtype).toBeNull();
  });

  test("a v1 (legacy) group with no pyramid answers a distinct 'no pyramid' error", async () => {
    const { body } = await callTool(app, env(db), 1, "render_overview", {
      dataset_id: V1_ID,
      recording: "sub-I003/eeg/sub-I003_task-sleep_eeg.zarr",
    });
    const text = errorTextOf(body);
    expect(text).toContain("no view/* pyramid");
  });

  test("an unknown group name answers a group-not-found error listing the real groups", async () => {
    const { body } = await callTool(app, env(db), 1, "render_overview", {
      dataset_id: V3_ID,
      recording: FIRST_STORE_ZARR,
      group: "not-a-real-group",
    });
    const text = errorTextOf(body);
    expect(text).toContain("no group named");
    expect(text).toContain("eeg_250hz");
  });

  test("width_px 300 picks level 4, chunks_read: 1 (the already-committed view4 fixture, item 15)", async () => {
    const { body } = await callTool(app, env(db), 1, "render_overview", {
      dataset_id: V3_ID,
      recording: FIRST_STORE_ZARR,
      width_px: 300,
    });
    const result = contentOf(body);
    const text = (result.content as TextContentBlock[]).find((c) => c.type === "text");
    const metadata = JSON.parse(text?.text ?? "{}");
    expect(metadata.level).toBe(4);
    expect(metadata.chunks_read).toBe(1);
    expect(fixtureServer.requestLog.some((r) => r.url.includes("view/4/c/0/0/0"))).toBe(true);
  });

  test("a multi-chunk level (3 chunks, short last one) reads exactly those keys (item 15)", async () => {
    const { body } = await callTool(app, env(db), 1, "render_overview", {
      dataset_id: V3_ID,
      recording: MULTI_CHUNK_STORE_ZARR,
      group: MULTI_CHUNK_GROUP,
      width_px: 20,
    });
    const result = contentOf(body);
    const text = (result.content as TextContentBlock[]).find((c) => c.type === "text");
    const metadata = JSON.parse(text?.text ?? "{}");
    expect(metadata.level).toBe(1);
    expect(metadata.chunks_read).toBe(3);

    const chunkRequests = fixtureServer.requestLog.filter((r) =>
      r.url.includes(`${MULTI_CHUNK_STORE_ZARR}/${MULTI_CHUNK_GROUP}/view/1/c/0/0/`),
    );
    expect(chunkRequests.map((r) => r.url).sort()).toEqual(
      [0, 1, 2].map(
        (k) => `${V3_ID}/zarr/${MULTI_CHUNK_STORE_ZARR}/${MULTI_CHUNK_GROUP}/view/1/c/0/0/${k}`,
      ),
    );
  });

  test("zarr_store_count 0 answers the not-ready error, never a pyramid attempt (item 19)", async () => {
    const { body } = await callTool(app, env(db), 1, "render_overview", {
      dataset_id: ZERO_STORE_ID,
      recording: "x.zarr",
    });
    const text = errorTextOf(body);
    expect(text).toContain("zarr_status");
  });

  describe("MEG SSS derived store (PR review item 1)", () => {
    test("renders successfully with envelope.derived and envelope.sss populated", async () => {
      const { body } = await callTool(app, env(db), 1, "render_overview", {
        dataset_id: MEG_ID,
        recording: MEG_STORE_ZARR,
        width_px: 50,
      });
      const result = contentOf(body);
      const content = result.content as Array<ImageContentBlock | TextContentBlock>;
      const image = content.find((c): c is ImageContentBlock => c.type === "image");
      const text = content.find((c): c is TextContentBlock => c.type === "text");
      expect(image).toBeDefined();
      const metadata = JSON.parse(text?.text ?? "{}");
      expect(metadata.level).toBe(MEG_SYNTHETIC_VIEW_LEVEL);
      expect(metadata.chunks_read).toBe(1);
      expect(metadata.envelope?.derived).toBe(true);
      expect(metadata.envelope?.sss?.method).toBe("maxwell_filter");
      // Null, always. `dtype` is the LEVEL-0 array's dtype from its own zarr.json,
      // and this tool reads the view pyramid and never zarr.json. It used to send
      // "int16" on a cache miss and null on a hit, which made one field mean three
      // different things across the three tools that carry it.
      expect(metadata.envelope?.dtype).toBeNull();
    });
  });
});
