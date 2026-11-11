/**
 * The engine's HTTP layer (`src/lib/zarr-engine/http.ts`) against a real `Bun.serve`
 * stand-in on 127.0.0.1: the host policy, the promise that no credential ever leaves
 * the process, the range cache (hits, eviction, what is never cached) and the source
 * kind in every cache key. No mocks: every request below is a real HTTP request, and the
 * stand-in records the headers it actually received.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  EngineConfigError,
  MemoryJsonCache,
  RangeCache,
  checkHost,
  createPublicFetcher,
  fetchJsonDocument,
  resolveBases,
  withRangeCache,
} from "../src/lib/zarr-engine/http.js";

interface Seen {
  method: string;
  path: string;
  headers: Record<string, string>;
}

const OBJECT = new Uint8Array(1000).map((_, i) => i % 251);
let seen: Seen[] = [];
let mode: "good" | "short206" | "bare200" | "5xx" = "good";
let server: ReturnType<typeof Bun.serve>;
const base = () => `http://127.0.0.1:${server.port}`;

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      seen.push({
        method: req.method,
        path: url.pathname,
        headers: Object.fromEntries(req.headers.entries()),
      });
      if (url.pathname === "/redirect-local") {
        return new Response(null, { status: 302, headers: { location: "/object" } });
      }
      if (url.pathname === "/redirect-away") {
        return new Response(null, {
          status: 302,
          headers: { location: "http://example.invalid/object" },
        });
      }
      if (url.pathname === "/loop") {
        return new Response(null, { status: 302, headers: { location: "/loop" } });
      }
      if (url.pathname === "/doc.json") return Response.json({ a: 1 });
      if (url.pathname === "/bad.json") return new Response("{nope");
      if (url.pathname === "/object") {
        const range = req.headers.get("range");
        const m = range ? /^bytes=(\d+)-(\d+)$/.exec(range) : null;
        if (!m) return new Response(OBJECT, { status: 200 });
        if (mode === "5xx") return new Response("boom", { status: 503 });
        if (mode === "bare200") return new Response(OBJECT, { status: 200 });
        const start = Number(m[1]);
        const end = Number(m[2]);
        const slice = OBJECT.slice(start, mode === "short206" ? end : end + 1);
        return new Response(slice, { status: 206 });
      }
      return new Response(null, { status: 404 });
    },
  });
});
afterAll(() => server.stop(true));
beforeEach(() => {
  seen = [];
  mode = "good";
});

const rangeInit = (range: string) => ({ headers: { Range: range } });

describe("host policy", () => {
  test.each([
    ["https://zarr.nemar.org", true],
    ["https://example.com:8443/x", true],
    ["http://127.0.0.1:1234", true],
    ["http://localhost:1234/x", true],
    ["http://[::1]:1234", true],
    ["http://zarr.nemar.org", false],
    ["http://example.com", false],
    ["http://127.0.0.1.evil.com", false],
    ["http://localhost.evil.com", false],
    ["ftp://127.0.0.1", false],
    ["file:///etc/passwd", false],
    ["https://user:pw@zarr.nemar.org", false],
    ["http://user@127.0.0.1", false],
    ["not a url", false],
  ])("%s -> %p", (value, ok) => {
    expect(checkHost(value).ok).toBe(ok);
  });

  test("the bases default to production and refuse a non-loopback http base", () => {
    expect(resolveBases({}).zarrBase).toBe("https://zarr.nemar.org");
    expect(
      resolveBases({
        NEMAR_ZARR_BASE: "http://127.0.0.1:9/",
        NEMAR_ZARR_DATA_PLANE: "http://localhost:9/data/",
      }),
    ).toEqual({
      zarrBase: "http://127.0.0.1:9",
      dataPlaneBase: "http://localhost:9/data",
    });
    expect(() => resolveBases({ NEMAR_ZARR_BASE: "http://zarr.nemar.org" })).toThrow(
      EngineConfigError,
    );
    expect(() => resolveBases({ NEMAR_ZARR_DATA_PLANE: "http://example.com/data" })).toThrow(
      EngineConfigError,
    );
  });

  test("the fetcher refuses a non-loopback http URL without sending anything", async () => {
    const f = createPublicFetcher();
    await expect(f("http://example.invalid/object")).rejects.toThrow("refused");
  });

  test("a redirect to a host the policy refuses is not followed", async () => {
    const f = createPublicFetcher();
    await expect(f(`${base()}/redirect-away`)).rejects.toThrow("refused");
    expect(seen.map((s) => s.path)).toEqual(["/redirect-away"]);
  });

  test("a redirect to an allowed host is followed, and a loop ends", async () => {
    const f = createPublicFetcher();
    const r = await f(`${base()}/redirect-local`);
    expect(r.status).toBe(200);
    await expect(f(`${base()}/loop`)).rejects.toThrow("too many redirects");
  });
});

describe("no credentials, by construction", () => {
  test("the stand-in never receives Authorization or Cookie, on any request", async () => {
    const f = createPublicFetcher();
    await f(`${base()}/object`, rangeInit("bytes=0-9"));
    await f(`${base()}/doc.json`);
    await f(`${base()}/redirect-local`);
    expect(seen.length).toBeGreaterThan(2);
    for (const s of seen) {
      expect(Object.keys(s.headers)).not.toContain("authorization");
      expect(Object.keys(s.headers)).not.toContain("cookie");
    }
  });

  test.each(["Authorization", "authorization", "Cookie", "Proxy-Authorization"])(
    "a request carrying %s is refused before it is sent",
    async (name) => {
      const f = createPublicFetcher();
      await expect(f(`${base()}/object`, { headers: { [name]: "secret" } })).rejects.toThrow(
        "refuses",
      );
      expect(seen).toEqual([]);
    },
  );

  test("a URL with a user name or password is refused before it is sent", async () => {
    const f = createPublicFetcher();
    await expect(f(`http://user:pw@127.0.0.1:${server.port}/object`)).rejects.toThrow("refused");
    expect(seen).toEqual([]);
  });

  test("the refusal holds through the range cache wrapper too", async () => {
    const f = withRangeCache(createPublicFetcher(), new RangeCache("public"));
    await expect(
      f(`${base()}/object`, { headers: { Range: "bytes=0-9", Authorization: "x" } }),
    ).rejects.toThrow("refuses");
    expect(seen).toEqual([]);
  });
});

describe("range cache", () => {
  test("a repeated Range is served from memory with no second request", async () => {
    const cache = new RangeCache("public");
    const f = withRangeCache(createPublicFetcher(), cache);
    const first = await f(`${base()}/object`, rangeInit("bytes=10-19"));
    expect(first.status).toBe(206);
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(OBJECT.slice(10, 20));
    const second = await f(`${base()}/object`, rangeInit("bytes=10-19"));
    expect(second.status).toBe(206);
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(OBJECT.slice(10, 20));
    expect(seen.length).toBe(1);
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1, entries: 1, bytes: 10 });
  });

  test("different ranges and different URLs are different entries", async () => {
    const f = withRangeCache(createPublicFetcher(), new RangeCache("public"));
    await f(`${base()}/object`, rangeInit("bytes=0-9"));
    await f(`${base()}/object`, rangeInit("bytes=0-10"));
    await f(`${base()}/object?other=1`, rangeInit("bytes=0-9"));
    expect(seen.length).toBe(3);
  });

  test("the least recently used entry is evicted when the byte bound is passed", async () => {
    const cache = new RangeCache("public", 25);
    const f = withRangeCache(createPublicFetcher(), cache);
    const get = (r: string) => f(`${base()}/object`, rangeInit(r)).then((x) => x.arrayBuffer());
    await get("bytes=0-9"); // A
    await get("bytes=10-19"); // B   (20 bytes)
    await get("bytes=0-9"); // touch A: B is now the oldest
    await get("bytes=20-29"); // C: 30 > 25, evicts B
    expect(cache.stats()).toMatchObject({ entries: 2, bytes: 20 });
    seen = [];
    await get("bytes=0-9"); // A still cached
    await get("bytes=20-29"); // C still cached
    expect(seen.length).toBe(0);
    await get("bytes=10-19"); // B was evicted: a real request
    expect(seen.length).toBe(1);
  });

  test("an entry larger than the whole bound is not stored", async () => {
    const cache = new RangeCache("public", 5);
    const f = withRangeCache(createPublicFetcher(), cache);
    await f(`${base()}/object`, rangeInit("bytes=0-9"));
    await f(`${base()}/object`, rangeInit("bytes=0-9"));
    expect(seen.length).toBe(2);
    expect(cache.stats().entries).toBe(0);
  });

  test("a bare 200 is never cached", async () => {
    mode = "bare200";
    const cache = new RangeCache("public");
    const f = withRangeCache(createPublicFetcher(), cache);
    expect((await f(`${base()}/object`, rangeInit("bytes=0-9"))).status).toBe(200);
    expect((await f(`${base()}/object`, rangeInit("bytes=0-9"))).status).toBe(200);
    expect(seen.length).toBe(2);
    expect(cache.stats().entries).toBe(0);
  });

  test("a 5xx is never cached", async () => {
    mode = "5xx";
    const cache = new RangeCache("public");
    const f = withRangeCache(createPublicFetcher(), cache);
    expect((await f(`${base()}/object`, rangeInit("bytes=0-9"))).status).toBe(503);
    mode = "good";
    expect((await f(`${base()}/object`, rangeInit("bytes=0-9"))).status).toBe(206);
    expect(cache.stats().entries).toBe(1);
  });

  test("a short 206 is passed on but never cached", async () => {
    mode = "short206";
    const cache = new RangeCache("public");
    const f = withRangeCache(createPublicFetcher(), cache);
    const r = await f(`${base()}/object`, rangeInit("bytes=0-9"));
    expect(new Uint8Array(await r.arrayBuffer()).length).toBe(9);
    expect(cache.stats().entries).toBe(0);
  });

  test("a request without Range bypasses the cache", async () => {
    const cache = new RangeCache("public");
    const f = withRangeCache(createPublicFetcher(), cache);
    await f(`${base()}/doc.json`);
    await f(`${base()}/doc.json`);
    expect(seen.length).toBe(2);
    expect(cache.stats()).toMatchObject({ entries: 0, hits: 0, misses: 0 });
  });
});

describe("the source kind is in every cache key", () => {
  test("range cache keys start with the kind", () => {
    const cache = new RangeCache("public");
    expect(cache.key("u", "bytes=0-1").startsWith("public\n")).toBe(true);
    // Another kind (a future private source) would write a different key for the same URL and Range.
    const other = new RangeCache("public");
    Object.defineProperty(other, "kind", { value: "private" });
    expect(other.key("u", "bytes=0-1")).not.toBe(cache.key("u", "bytes=0-1"));
  });

  test("json cache keys start with the kind, and the footer-shaped key round-trips", async () => {
    const cache = new MemoryJsonCache("public");
    const key = {
      datasetId: "nm099500",
      sourceCommit: "c".repeat(40),
      convertedAt: null,
      projection: "p",
    };
    expect(cache.key(key).startsWith("public\n")).toBe(true);
    expect(await cache.get(key)).toBeUndefined();
    cache.put(key, [1, 2]);
    expect(await cache.get(key)).toEqual([1, 2]);
    const other = new MemoryJsonCache("public");
    Object.defineProperty(other, "kind", { value: "private" });
    expect(other.key(key)).not.toBe(cache.key(key));
  });

  test("the json cache drops its oldest entry past the bound", async () => {
    const cache = new MemoryJsonCache("public", 2);
    const k = (n: number) => ({
      datasetId: "nm099500",
      sourceCommit: "",
      convertedAt: null,
      projection: String(n),
    });
    cache.put(k(1), 1);
    cache.put(k(2), 2);
    cache.put(k(3), 3);
    expect(cache.size).toBe(2);
    expect(await cache.get(k(1))).toBeUndefined();
    expect(await cache.get(k(3))).toBe(3);
  });
});

describe("fetchJsonDocument", () => {
  const f = createPublicFetcher();
  test("ok, not_found, error", async () => {
    expect(await fetchJsonDocument(f, `${base()}/doc.json`, 1000)).toEqual({
      status: "ok",
      doc: { a: 1 },
    });
    expect(await fetchJsonDocument(f, `${base()}/missing.json`, 1000)).toEqual({
      status: "not_found",
    });
    expect(await fetchJsonDocument(f, `${base()}/bad.json`, 1000)).toMatchObject({
      status: "error",
    });
    expect(await fetchJsonDocument(f, `${base()}/doc.json`, 3)).toMatchObject({ status: "error" });
    expect(await fetchJsonDocument(f, "http://example.invalid/x", 1000)).toMatchObject({
      status: "error",
    });
  });
});
