/**
 * Contract tests for the cache logic that moved into `shared/zarr/` (shard
 * footers, level-0 array metadata) and for the Worker's `mcpJsonCache` adapter.
 * The core owns validation: whatever a `JsonCache.get` hands back is checked
 * against the zod schema, and an invalid entry is a miss, never trusted.
 *
 * No mocks: a real `Bun.serve` fixture server serves the committed nm099500
 * objects, the core's cache is a real `Map`-backed `JsonCache`, and the adapter
 * runs over the real in-memory Cache API double (`helpers/cache.ts`). The only
 * stand-in is `console.warn`/`console.error`, swapped for a recorder so a test
 * can assert the log fired.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { loadLevel0ArrayMetadata } from "../../shared/zarr/array-metadata.js";
import type { CacheKey, JsonCache } from "../../shared/zarr/interfaces.js";
import { loadShardFooter } from "../../shared/zarr/shard-footer.js";
import { shardEntriesToPairs } from "../../shared/zarr/sharding.js";
import { mcpJsonCache, projectionUrl } from "../src/mcp/projection-cache.js";
import type { RecordingToolDeps } from "../src/mcp/tool-types.js";
import expected from "./fixtures/mcp/nm099500-expected.json";
import { InMemoryCache } from "./helpers/cache.js";
import { type FixtureServer, startFixtureServer } from "./helpers/fixture-server.js";

const FIXTURES = new URL("./fixtures/mcp/", import.meta.url);
const SHA = "c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1";
const ZARR = "sub-synth/eeg/sub-synth_task-shardtest_eeg.zarr";
const GROUP = "eeg_250hz";
const ARRAY_PREFIX = `nm099500/zarr/${ZARR}/${GROUP}/0`;
const SCHEMA_WARNING = "[mcp] projection cache hit failed schema validation, treated as a miss";

function fixtureBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(name, FIXTURES)));
}

/** A real in-memory JsonCache that also records every put. */
class MapJsonCache implements JsonCache {
  readonly store = new Map<string, unknown>();
  puts = 0;
  keyOf(key: CacheKey): string {
    return JSON.stringify(key);
  }
  async get(key: CacheKey): Promise<unknown | undefined> {
    return this.store.get(this.keyOf(key));
  }
  put(key: CacheKey, value: unknown): void {
    this.puts++;
    this.store.set(this.keyOf(key), value);
  }
}

let server: FixtureServer;
const fetcher = (url: string, init?: { headers?: Record<string, string> }) => fetch(url, init);

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

let logged: { level: "warn" | "error"; args: unknown[] }[] = [];
const realWarn = console.warn;
const realError = console.error;
beforeEach(() => {
  logged = [];
  server.requestLog.length = 0;
  console.warn = (...args: unknown[]) => {
    logged.push({ level: "warn", args });
  };
  console.error = (...args: unknown[]) => {
    logged.push({ level: "error", args });
  };
});
afterEach(() => {
  console.warn = realWarn;
  console.error = realError;
});

const dataBase = () => `${server.url}/nm099500/zarr/`;
const ident = { datasetId: "nm099500", sourceCommit: SHA, convertedAt: "2026-09-08" };
const footerKey = (shard: number): CacheKey => ({
  ...ident,
  projection: `shardidx/${ZARR}/${GROUP}/0/${shard}`,
});
const arrayKey = (): CacheKey => ({ ...ident, projection: `array/${ZARR}/${GROUP}/0` });

function loadFooter(cache: JsonCache) {
  return loadShardFooter({
    fetcher,
    cache,
    key: ident,
    dataBase: dataBase(),
    zarr: ZARR,
    groupName: GROUP,
    shardIndex: 0,
    nInner: expected.n_inner_per_shard,
  });
}

function loadArray(cache: JsonCache, sourceCommit = SHA) {
  return loadLevel0ArrayMetadata({
    fetcher,
    cache,
    ...ident,
    sourceCommit,
    dataBase: dataBase(),
    zarr: ZARR,
    group: GROUP,
  });
}

const footerRequests = () => server.requestLog.filter((r) => r.range.startsWith("bytes=-"));
const arrayRequests = () => server.requestLog.filter((r) => r.url.endsWith("/zarr.json"));

describe("shard footer cache (shared/zarr/shard-footer.ts)", () => {
  test("a valid cached footer is a hit and sends no request", async () => {
    const cache = new MapJsonCache();
    const cold = await loadFooter(cache);
    if ("error" in cold) throw new Error(cold.error);
    expect(cold.cacheStatus).toBe("miss");
    server.requestLog.length = 0;
    const warm = await loadFooter(cache);
    if ("error" in warm) throw new Error(warm.error);
    expect(warm.cacheStatus).toBe("hit");
    expect(server.requestLog).toEqual([]);
  });

  test("an invalid cached value (wrong shape) is a miss, re-read, and warns", async () => {
    const cache = new MapJsonCache();
    // [-1, 240] is neither absent ([-1, -1]) nor present (both non-negative).
    cache.put(footerKey(0), [
      [-1, 240],
      [0, 10],
      [10, 10],
      [20, 10],
    ]);
    const out = await loadFooter(cache);
    if ("error" in out) throw new Error(out.error);
    expect(out.cacheStatus).toBe("miss");
    expect(footerRequests()).toHaveLength(1);
    expect(logged.some((l) => l.level === "warn" && l.args[0] === SCHEMA_WARNING)).toBe(true);
    // The bad entry was overwritten with the freshly parsed footer: compare with
    // the real footer from a cold load, not merely "something other than bad".
    const reference = await loadFooter(new MapJsonCache());
    if ("error" in reference) throw new Error(reference.error);
    expect(cache.store.get(cache.keyOf(footerKey(0)))).toEqual(
      shardEntriesToPairs(reference.entries),
    );
  });

  test("a cached footer with the wrong entry count is re-read", async () => {
    const cache = new MapJsonCache();
    cache.put(footerKey(0), [
      [0, 10],
      [10, 10],
    ]); // valid shape, 2 entries not 4
    const out = await loadFooter(cache);
    if ("error" in out) throw new Error(out.error);
    expect(out.cacheStatus).toBe("miss");
    expect(out.entries).toHaveLength(expected.n_inner_per_shard);
    expect(footerRequests()).toHaveLength(1);
    expect(
      logged.some(
        (l) =>
          l.level === "warn" &&
          String(l.args[0]).includes("cached footer has 2 entries, expected 4; re-reading"),
      ),
    ).toBe(true);
  });
});

describe("array metadata cache (shared/zarr/array-metadata.ts)", () => {
  test("an invalid cached value is a miss: the document is fetched and parsed", async () => {
    const cache = new MapJsonCache();
    cache.put(arrayKey(), { dataType: 5, codecs: "nope", scale: [], offset: [] });
    const out = await loadArray(cache);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.cacheStatus).toBe("miss");
    expect(out.metadata.scale).toEqual(expected.scale);
    expect(arrayRequests()).toHaveLength(1);
    expect(logged.some((l) => l.level === "warn" && l.args[0] === SCHEMA_WARNING)).toBe(true);
  });

  test("it is cached when source_commit is a 40-hex SHA, and the second load is a hit", async () => {
    const cache = new MapJsonCache();
    await loadArray(cache);
    expect(cache.puts).toBe(1);
    server.requestLog.length = 0;
    const again = await loadArray(cache);
    expect(again.ok && again.cacheStatus).toBe("hit");
    expect(arrayRequests()).toEqual([]);
  });

  test("it is NOT cached (no get, no put) when source_commit is not a 40-hex SHA", async () => {
    const cache = new MapJsonCache();
    for (const bad of ["main", "c1c1c1", SHA.toUpperCase(), ""]) {
      const out = await loadArray(cache, bad);
      expect(out.ok).toBe(true);
      expect(out.ok && out.cacheStatus).toBe("miss");
    }
    expect(cache.puts).toBe(0);
    expect(cache.store.size).toBe(0);
    expect(arrayRequests()).toHaveLength(4); // every load went to the origin
  });
});

describe("mcpJsonCache (the Worker adapter)", () => {
  const env = { MCP_HOSTNAME: "mcp.nemar.org" };
  const key: CacheKey = {
    datasetId: "nm099500",
    sourceCommit: SHA,
    convertedAt: "2026-09-08 01:02:03",
    projection: "shardidx/z/g/0/0",
  };

  function makeDeps() {
    const cache = new InMemoryCache();
    const waited: Promise<unknown>[] = [];
    const deps = {
      env,
      cache: () => cache,
      executionCtx: {
        waitUntil: (p: Promise<unknown>) => {
          waited.push(p);
        },
        passThroughOnException: () => {},
      },
    } as unknown as RecordingToolDeps;
    return { cache, waited, deps };
  }

  test("put stores at exactly projectionUrl({env, ...key}), through waitUntil", async () => {
    const { cache, waited, deps } = makeDeps();
    const adapter = mcpJsonCache(deps);
    adapter.put(key, [[1, 2]]);
    expect(waited).toHaveLength(1); // the write is handed to waitUntil, not awaited inline
    await Promise.all(waited);
    const url = projectionUrl({ env, ...key });
    const stored = await cache.match(new Request(url, { method: "GET" }));
    expect(await stored?.json()).toEqual([[1, 2]]);
  });

  test("get reads exactly projectionUrl({env, ...key}) and returns the JSON", async () => {
    const { cache, deps } = makeDeps();
    const url = projectionUrl({ env, ...key });
    await cache.put(new Request(url, { method: "GET" }), Response.json({ a: 1 }));
    const adapter = mcpJsonCache(deps);
    expect(await adapter.get(key)).toEqual({ a: 1 });
    // A different identity is a different entry.
    expect(await adapter.get({ ...key, sourceCommit: "d".repeat(40) })).toBeUndefined();
  });

  test("a non-JSON cache entry makes get return undefined, without throwing", async () => {
    const { cache, deps } = makeDeps();
    const url = projectionUrl({ env, ...key });
    await cache.put(new Request(url, { method: "GET" }), new Response("not json {"));
    expect(await mcpJsonCache(deps).get(key)).toBeUndefined();
    expect(logged.some((l) => l.level === "error")).toBe(true);
  });
});
