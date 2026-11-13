/**
 * The engine's disk cache (`src/lib/zarr-engine/disk-cache.ts`) on real files in a temporary
 * directory: the round trip, entries that fail verification, eviction, two instances sharing
 * one directory, the off switch, a directory that cannot be written, and the fetcher and JSON
 * wrappers over a real `Bun.serve` stand-in. No mocks.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CACHE_MARKER,
  DEFAULT_DISK_CACHE_BYTES,
  DiskCache,
  DiskCacheRefusal,
  TieredJsonCache,
  resolveDiskCache,
  withDiskRangeCache,
} from "../src/lib/zarr-engine/disk-cache.js";
import { EngineConfigError, MemoryJsonCache, resolveBases } from "../src/lib/zarr-engine/http.js";
import { publicSource } from "../src/lib/zarr-engine/source.js";

let root: string;
let logged: string[];
const log = (line: string) => logged.push(line);
const dir = () => join(root, "cache");
const make = (maxBytes = 1_000_000, d = dir()) => new DiskCache({ dir: d, maxBytes, log });
const body = (n: number, fill = 7) => new Uint8Array(n).fill(fill);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nemar-disk-cache-"));
  logged = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Where an entry for `key` lives: `<2 hex>/<sha256 of the key>`. */
function fileFor(key: string, d = dir()): string {
  const hash = createHash("sha256").update(key).digest("hex");
  return join(d, hash.slice(0, 2), hash);
}

/** Make `key`'s entry look `secondsAgo` old. */
function age(key: string, secondsAgo: number): void {
  const t = new Date(Date.now() - secondsAgo * 1000);
  utimesSync(fileFor(key), t, t);
}

/** Every entry file under the cache directory. */
function entryFiles(d = dir()): string[] {
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter((sub) => /^[0-9a-f]{2}$/.test(sub))
    .flatMap((sub) =>
      readdirSync(join(d, sub))
        .filter((n) => !n.startsWith("."))
        .map((n) => join(d, sub, n)),
    );
}

describe("the round trip", () => {
  test("a body comes back byte for byte, from this instance and from a new one", () => {
    const a = make();
    const data = new Uint8Array(1000).map((_, i) => i % 251);
    a.put("k1", data);
    expect(a.get("k1")).toEqual(data);
    expect(make().get("k1")).toEqual(data);
    expect(a.get("other")).toBeUndefined();
  });

  test("directories are 0700 and files 0600", () => {
    const a = make();
    a.put("k", body(10));
    expect(statSync(dir()).mode & 0o777).toBe(0o700);
    const [file] = entryFiles();
    expect(statSync(join(file, "..")).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("a put over an existing key replaces it", () => {
    const a = make();
    a.put("k", body(10, 1));
    a.put("k", body(20, 2));
    expect(a.get("k")).toEqual(body(20, 2));
    expect(a.stats().entries).toBe(1);
  });

  test("an empty body is stored and read back", () => {
    const a = make();
    a.put("empty", new Uint8Array(0));
    expect(a.get("empty")).toEqual(new Uint8Array(0));
  });
});

describe("an entry that fails verification is a miss and is deleted", () => {
  function onlyFile(): string {
    const files = entryFiles();
    expect(files.length).toBe(1);
    return files[0];
  }

  test("a truncated file", () => {
    const a = make();
    a.put("k", body(100));
    const file = onlyFile();
    writeFileSync(file, readFileSync(file).subarray(0, 60));
    expect(a.get("k")).toBeUndefined();
    expect(existsSync(file)).toBe(false);
  });

  test("a file with a flipped magic byte", () => {
    const a = make();
    a.put("k", body(100));
    const file = onlyFile();
    const bytes = readFileSync(file);
    bytes[0] ^= 0xff;
    writeFileSync(file, bytes);
    expect(a.get("k")).toBeUndefined();
    expect(existsSync(file)).toBe(false);
  });

  test("a file holding another key's entry (wrong key)", () => {
    const a = make();
    a.put("k", body(100));
    const file = onlyFile();
    // Same length key, different bytes: the file name says "k", the content says "j".
    const bytes = readFileSync(file);
    bytes[12] = "j".charCodeAt(0);
    writeFileSync(file, bytes);
    expect(a.get("k")).toBeUndefined();
    expect(existsSync(file)).toBe(false);
  });

  test("a file whose body is longer than its recorded length", () => {
    const a = make();
    a.put("k", body(100));
    const file = onlyFile();
    writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.from([1, 2, 3])]));
    expect(a.get("k")).toBeUndefined();
    expect(existsSync(file)).toBe(false);
  });

  test("garbage in the file", () => {
    const a = make();
    a.put("k", body(100));
    const file = onlyFile();
    writeFileSync(file, "not a cache entry at all");
    expect(a.get("k")).toBeUndefined();
    expect(existsSync(file)).toBe(false);
    // The slot is usable again.
    a.put("k", body(5));
    expect(a.get("k")).toEqual(body(5));
  });
});

describe("eviction", () => {
  // Each entry is 12 header bytes + a 2-byte key + a 100-byte body = 114 bytes.
  test("past the limit the oldest entries go first, down to 90% of the limit", () => {
    const a = make(500);
    for (const k of ["k0", "k1", "k2", "k3"]) a.put(k, body(100));
    expect(a.stats().entries).toBe(4);
    // k0 is the oldest, k3 the newest.
    age("k0", 400);
    age("k1", 300);
    age("k2", 200);
    age("k3", 100);
    a.put("k4", body(100)); // 570 > 500: evict oldest until <= 450
    expect(a.get("k0")).toBeUndefined();
    expect(a.get("k1")).toBeUndefined();
    expect(a.get("k2")).toBeDefined();
    expect(a.get("k3")).toBeDefined();
    expect(a.get("k4")).toBeDefined();
    expect(a.stats().bytes).toBeLessThanOrEqual(450);
  });

  test("a hit refreshes an entry, so it outlives an older one that was never read", () => {
    const a = make(500);
    for (const k of ["k0", "k1", "k2", "k3"]) a.put(k, body(100));
    age("k0", 400);
    age("k1", 300);
    age("k2", 200);
    age("k3", 100);
    expect(a.get("k0")).toBeDefined(); // touches k0: now the newest
    a.put("k4", body(100));
    expect(a.get("k0")).toBeDefined();
    expect(a.get("k1")).toBeUndefined();
    expect(a.get("k2")).toBeUndefined();
  });

  test("a body larger than the whole limit is not stored", () => {
    const a = make(100);
    a.put("big", body(500));
    expect(a.get("big")).toBeUndefined();
    expect(entryFiles()).toEqual([]);
  });

  test("a new instance counts what is already on disk", () => {
    const first = make(500);
    for (const k of ["k0", "k1", "k2", "k3"]) first.put(k, body(100));
    age("k0", 400);
    const second = make(500);
    second.put("k4", body(100)); // the scan finds 456 bytes, so this write passes the limit
    expect(second.stats().entries).toBeLessThan(5);
    expect(second.get("k0")).toBeUndefined();
    expect(second.get("k4")).toBeDefined();
  });
});

describe("two instances sharing one directory", () => {
  test("each reads what the other wrote", () => {
    const a = make();
    const b = make();
    a.put("from-a", body(10, 1));
    b.put("from-b", body(10, 2));
    expect(b.get("from-a")).toEqual(body(10, 1));
    expect(a.get("from-b")).toEqual(body(10, 2));
  });

  test("an entry the other instance evicted is a plain miss", () => {
    const a = make();
    const b = make();
    a.put("k", body(10));
    b.clear();
    expect(a.get("k")).toBeUndefined();
    expect(logged).toEqual([]);
    a.put("k", body(10));
    expect(a.get("k")).toEqual(body(10));
  });

  test("a stale temporary file is deleted by a scan, a fresh one is left alone", () => {
    const a = make();
    a.put("k", body(10));
    const sub = join(fileFor("k"), "..");
    const stale = join(sub, ".tmp-1-stale");
    const fresh = join(sub, ".tmp-2-fresh");
    writeFileSync(stale, "x");
    writeFileSync(fresh, "x");
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(stale, old, old);
    const stats = a.stats();
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    // Temporary files are never counted as entries.
    expect(stats.entries).toBe(1);
  });

  test("a write leaves no temporary file behind", () => {
    const a = make();
    for (let i = 0; i < 20; i++) a.put(`k${i}`, body(50));
    const temps = readdirSync(dir())
      .filter((sub) => /^[0-9a-f]{2}$/.test(sub))
      .flatMap((sub) => readdirSync(join(dir(), sub)).filter((n) => n.startsWith(".")));
    expect(temps).toEqual([]);
  });
});

describe("the off switch", () => {
  test("a limit of 0 stores nothing, returns nothing and creates no directory", () => {
    const a = make(0);
    expect(a.enabled).toBe(false);
    a.put("k", body(10));
    expect(a.get("k")).toBeUndefined();
    expect(existsSync(dir())).toBe(false);
  });

  test("resolveDiskCache reads the directory and the limit from the environment", () => {
    const env = { NEMAR_ZARR_DISK_CACHE_DIR: dir(), NEMAR_ZARR_DISK_CACHE_BYTES: "0" };
    const off = resolveDiskCache(env);
    expect(off.dir).toBe(dir());
    expect(off.enabled).toBe(false);
    const on = resolveDiskCache({ NEMAR_ZARR_DISK_CACHE_DIR: dir() });
    expect(on.maxBytes).toBe(DEFAULT_DISK_CACHE_BYTES);
    expect(resolveDiskCache({ ...env, NEMAR_ZARR_DISK_CACHE_BYTES: "123" }).maxBytes).toBe(123);
    expect(() => resolveDiskCache({ ...env, NEMAR_ZARR_DISK_CACHE_BYTES: "-1" })).toThrow(
      EngineConfigError,
    );
    expect(() => resolveDiskCache({ ...env, NEMAR_ZARR_DISK_CACHE_BYTES: "lots" })).toThrow(
      EngineConfigError,
    );
  });

  test("the default directory is under the config directory", () => {
    const before = process.env.NEMAR_CONFIG_DIR;
    process.env.NEMAR_CONFIG_DIR = join(root, "config");
    try {
      expect(resolveDiskCache({}).dir).toBe(join(root, "config", "zarr-cache", "public", "v1"));
    } finally {
      if (before === undefined) Reflect.deleteProperty(process.env, "NEMAR_CONFIG_DIR");
      else process.env.NEMAR_CONFIG_DIR = before;
    }
  });
});

describe("a directory that cannot be used never fails a read", () => {
  // The cache directory's parent is a regular file, so it can be neither created nor read.
  function blocked(): DiskCache {
    const file = join(root, "a-file");
    writeFileSync(file, "x");
    return make(1_000_000, join(file, "cache"));
  }

  test("get is a miss, put does nothing, and one stderr line says why", () => {
    const a = blocked();
    expect(a.get("k")).toBeUndefined();
    a.put("k", body(10));
    a.put("k2", body(10));
    expect(a.get("k")).toBeUndefined();
    expect(logged.length).toBe(1);
    expect(logged[0]).toContain("disk cache");
    expect(logged[0]).toContain("reads continue without it");
  });

  test("checkWritable says no, and yes for a usable directory", () => {
    expect(blocked().checkWritable().ok).toBe(false);
    expect(make().checkWritable()).toEqual({ ok: true });
  });

  test("a fetcher over an unusable cache still serves the response", async () => {
    const a = blocked();
    const f = withDiskRangeCache(async () => new Response(body(10), { status: 206 }), a, "s");
    const r = await f("http://127.0.0.1:1/x", { headers: { Range: "bytes=0-9" } });
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(body(10));
  });
});

describe("stats and clear", () => {
  test("stats counts entries and bytes; clear removes them and reports the bytes", () => {
    const a = make(10_000);
    a.put("k0", body(100));
    a.put("k1", body(200));
    expect(a.stats()).toEqual({
      dir: dir(),
      enabled: true,
      entries: 2,
      bytes: 114 + 214,
      limitBytes: 10_000,
    });
    expect(a.clear()).toEqual({ freedBytes: 328, failed: 0 });
    expect(existsSync(dir())).toBe(false);
    expect(a.stats().entries).toBe(0);
    a.put("k0", body(100));
    expect(a.get("k0")).toEqual(body(100));
  });

  test("clear removes only the cache's own subdirectories from a shared directory", () => {
    const a = make(10_000);
    a.put("k0", body(100));
    writeFileSync(join(dir(), "notes.txt"), "mine");
    mkdirSync(join(dir(), "photos"));
    writeFileSync(join(dir(), "photos", "a.jpg"), "mine");
    expect(a.clear()).toEqual({ freedBytes: 114, failed: 0 });
    expect(readdirSync(dir()).sort()).toEqual([CACHE_MARKER, "notes.txt", "photos"].sort());
    expect(readFileSync(join(dir(), "notes.txt"), "utf8")).toBe("mine");
    expect(readFileSync(join(dir(), "photos", "a.jpg"), "utf8")).toBe("mine");
  });

  test("stats of a directory that does not exist is zeros", () => {
    expect(make().stats()).toMatchObject({ entries: 0, bytes: 0 });
    expect(make().clear()).toEqual({ freedBytes: 0, failed: 0 });
  });
});

describe("withDiskRangeCache over a real server", () => {
  const OBJECT = new Uint8Array(1000).map((_, i) => i % 251);
  let server: ReturnType<typeof Bun.serve>;
  let requests: string[] = [];
  let mode: "good" | "short" | "bare200" = "good";
  beforeAll(() => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const range = req.headers.get("range") ?? "";
        requests.push(range);
        const m = /^bytes=(\d+)-(\d+)$/.exec(range);
        if (!m) return new Response(OBJECT, { status: 200 });
        const [a, b] = [Number(m[1]), Number(m[2])];
        if (mode === "bare200") return new Response(OBJECT, { status: 200 });
        if (mode === "short") return new Response(OBJECT.slice(a, b), { status: 206 });
        return new Response(OBJECT.slice(a, b + 1), { status: 206 });
      },
    });
  });
  afterAll(() => server.stop(true));
  beforeEach(() => {
    requests = [];
    mode = "good";
  });
  const url = () => `http://127.0.0.1:${server.port}/object`;
  const get = async (f: ReturnType<typeof withDiskRangeCache>, range: string) =>
    new Uint8Array(await (await f(url(), { headers: { Range: range } })).arrayBuffer());
  const net = (disk: DiskCache, scope = "s") =>
    withDiskRangeCache(async (u, i) => fetch(u, i), disk, scope);

  test("a second fetcher over the same directory sends no request", async () => {
    expect(await get(net(make()), "bytes=10-19")).toEqual(OBJECT.slice(10, 20));
    expect(requests.length).toBe(1);
    expect(await get(net(make()), "bytes=10-19")).toEqual(OBJECT.slice(10, 20));
    expect(requests.length).toBe(1);
  });

  test("another scope (store identity) does not share the entry", async () => {
    const disk = make();
    await get(net(disk, "store-a"), "bytes=10-19");
    await get(net(disk, "store-b"), "bytes=10-19");
    expect(requests.length).toBe(2);
  });

  test("a different range or URL is a different entry", async () => {
    const f = net(make());
    await get(f, "bytes=0-9");
    await get(f, "bytes=0-10");
    expect(requests.length).toBe(2);
  });

  test("a short 206 and a bare 200 are never written", async () => {
    const disk = make();
    mode = "short";
    await get(net(disk), "bytes=0-9");
    mode = "bare200";
    await get(net(disk), "bytes=0-9");
    expect(entryFiles()).toEqual([]);
  });

  test("a request without Range is not cached", async () => {
    const f = net(make());
    await f(url());
    await f(url());
    expect(requests.length).toBe(2);
    expect(entryFiles()).toEqual([]);
  });

  test("an entry whose length is not the asked length is not served", async () => {
    const disk = make();
    const f = net(disk);
    await get(f, "bytes=0-9");
    // Plant a wrong-length body under the very key the fetcher will look up.
    const key = `s\n${url()}\nbytes=0-9`;
    disk.put(key, body(3));
    expect(await get(f, "bytes=0-9")).toEqual(OBJECT.slice(0, 10));
    expect(requests.length).toBe(2);
  });
});

describe("TieredJsonCache", () => {
  const key = (projection = "p") => ({
    datasetId: "nm000001",
    sourceCommit: "c".repeat(40),
    convertedAt: "t",
    projection,
  });

  test("a value put through one cache is read by a fresh memory tier from disk", async () => {
    const disk = make();
    new TieredJsonCache(new MemoryJsonCache("public"), disk, "s").put(key(), {
      a: [1, 2, { b: 3 }],
    });
    const fresh = new TieredJsonCache(new MemoryJsonCache("public"), make(), "s");
    expect(await fresh.get(key())).toEqual({ a: [1, 2, { b: 3 }] });
    expect(await fresh.get(key("other"))).toBeUndefined();
  });

  test("another scope does not see the value", async () => {
    new TieredJsonCache(new MemoryJsonCache("public"), make(), "s1").put(key(), { a: 1 });
    expect(
      await new TieredJsonCache(new MemoryJsonCache("public"), make(), "s2").get(key()),
    ).toBeUndefined();
  });

  test("an entry that is not JSON is a miss", async () => {
    const disk = make();
    const scope = "s";
    disk.put(`json\n${scope}\n${JSON.stringify(key())}`, new TextEncoder().encode("{not json"));
    expect(
      await new TieredJsonCache(new MemoryJsonCache("public"), disk, scope).get(key()),
    ).toBeUndefined();
  });
});

describe("links and special files are never followed", () => {
  test("an entry replaced by a symbolic link is a miss, and the link (not its target) is removed", () => {
    const a = make();
    a.put("k", body(50, 3));
    const file = fileFor("k");
    const target = join(root, "elsewhere");
    writeFileSync(target, readFileSync(file));
    rmSync(file);
    symlinkSync(target, file);
    // Same bytes behind the link: a reader that followed it would hit.
    expect(a.get("k")).toBeUndefined();
    expect(existsSync(file)).toBe(false);
    expect(existsSync(target)).toBe(true);
  });

  test("a symbolic link is not counted by stats", () => {
    const a = make();
    a.put("k", body(50));
    const link = join(fileFor("k", dir()), "..", "a".repeat(64));
    symlinkSync(join(root, "nowhere"), link);
    expect(a.stats().entries).toBe(1);
  });

  test("an entry subdirectory that is a symbolic link gets no write and no chmod", () => {
    const a = make();
    a.put("seed", body(10));
    const outside = join(root, "outside");
    mkdirSync(outside, { mode: 0o755 });
    chmodSync(outside, 0o755);
    const sub = join(fileFor("victim"), "..");
    expect(existsSync(sub)).toBe(false);
    symlinkSync(outside, sub);
    a.put("victim", body(10));
    expect(readdirSync(outside)).toEqual([]);
    expect(statSync(outside).mode & 0o777).toBe(0o755);
    expect(a.get("victim")).toBeUndefined();
    expect(logged.length).toBe(1);
  });
});

describe("clear only removes what the cache made", () => {
  test("the cache writes a marker when it creates its root, and not into an existing non-empty one", () => {
    const a = make();
    a.put("k", body(10));
    expect(existsSync(join(dir(), CACHE_MARKER))).toBe(true);
    const other = join(root, "other");
    mkdirSync(other);
    writeFileSync(join(other, "mine.txt"), "mine");
    make(1_000_000, other).put("k", body(10));
    expect(existsSync(join(other, CACHE_MARKER))).toBe(false);
  });

  test("clear refuses a directory without the marker and removes nothing", () => {
    const unrelated = join(root, "unrelated");
    mkdirSync(join(unrelated, "ab"), { recursive: true });
    const lookalike = join(unrelated, "ab", "c".repeat(64));
    writeFileSync(lookalike, "not a cache entry");
    expect(() => make(1_000_000, unrelated).clear()).toThrow(DiskCacheRefusal);
    expect(readFileSync(lookalike, "utf8")).toBe("not a cache entry");
  });

  test("inside entry directories only entry-named files go, and a directory with other files stays", () => {
    const a = make();
    a.put("k", body(10));
    const sub = join(fileFor("k"), "..");
    writeFileSync(join(sub, "notes.txt"), "mine");
    writeFileSync(join(sub, "A".repeat(64)), "uppercase is not an entry name");
    a.clear();
    expect(existsSync(fileFor("k"))).toBe(false);
    expect(readFileSync(join(sub, "notes.txt"), "utf8")).toBe("mine");
    expect(existsSync(join(sub, "A".repeat(64)))).toBe(true);
    // The directory kept foreign files, so it is still the cache's: it can be cleared again.
    expect(existsSync(join(dir(), CACHE_MARKER))).toBe(true);
    expect(() => a.clear()).not.toThrow();
  });

  test("a cache that held only entries is gone entirely after clear", () => {
    const a = make();
    a.put("k", body(10));
    a.clear();
    expect(existsSync(dir())).toBe(false);
  });
});

describe("engines sharing one directory stay near one limit", () => {
  test("an instance that wrote little rescans and evicts what the others wrote", () => {
    // 114-byte entries, a 2000-byte limit: a rescan after ~200 own bytes.
    const a = make(2000);
    const b = make(2000);
    b.put("b0", body(100)); // b's total is now 114
    for (let i = 0; i < 17; i++) a.put(`a${i}`, body(100)); // a: 1938 bytes
    for (let i = 1; i < 6; i++) b.put(`b${i}`, body(100));
    expect(make(2000).stats().bytes).toBeLessThanOrEqual(2000);
  });
});

describe("the data origin is part of the store identity (same URL, same Range)", () => {
  const OBJECT = new Uint8Array(1000).map((_, i) => i % 251);
  let server: ReturnType<typeof Bun.serve>;
  let ranges: string[] = [];
  beforeAll(() => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.get("range") ?? "");
        if (!m) return new Response("no", { status: 400 });
        ranges.push(req.headers.get("range") ?? "");
        return new Response(OBJECT.slice(Number(m[1]), Number(m[2]) + 1), { status: 206 });
      },
    });
  });
  afterAll(() => server.stop(true));
  beforeEach(() => {
    ranges = [];
  });

  // Two stores that differ only in the origin of their data base. The request URL and Range are
  // the same for both, so only the identity can tell their bytes apart.
  const store = (origin: string) => ({
    dataBase: `${origin}/nm000001/zarr/`,
    datasetId: "nm000001",
    sourceCommit: "a".repeat(40),
    convertedAt: "2026-01-01T00:00:00Z",
  });
  const sourceOver = (disk?: DiskCache) =>
    publicSource({
      bases: resolveBases({
        NEMAR_ZARR_BASE: `http://127.0.0.1:${server.port}`,
        NEMAR_ZARR_DATA_PLANE: `http://127.0.0.1:${server.port}/data`,
      }),
      diskCache: disk,
    });
  const fetchRange = async (f: ReturnType<ReturnType<typeof sourceOver>["fetcherFor"]>) =>
    f(`http://127.0.0.1:${server.port}/chunk`, { headers: { Range: "bytes=10-19" } });

  test("in memory: another origin is another entry, the same origin is a hit", async () => {
    const source = sourceOver();
    await fetchRange(source.fetcherFor(store("https://data-a.example")));
    await fetchRange(source.fetcherFor(store("https://data-a.example")));
    expect(ranges.length).toBe(1);
    await fetchRange(source.fetcherFor(store("https://data-b.example")));
    expect(ranges.length).toBe(2);
  });

  test("on disk: a new process sharing the cache reuses the same origin's bytes and not another's", async () => {
    await fetchRange(sourceOver(make()).fetcherFor(store("https://data-a.example")));
    expect(ranges.length).toBe(1);
    await fetchRange(sourceOver(make()).fetcherFor(store("https://data-a.example")));
    expect(ranges.length).toBe(1);
    await fetchRange(sourceOver(make()).fetcherFor(store("https://data-b.example")));
    expect(ranges.length).toBe(2);
  });
});

describe("a named pipe where an entry belongs", () => {
  // A blocking open of a FIFO with no writer never returns, and a synchronous call cannot be
  // interrupted by a test timeout, so the read runs in a child process that is killed if it hangs.
  test.skipIf(process.platform === "win32")(
    "get is a miss at once and the pipe is removed",
    async () => {
      const a = make();
      a.put("k", body(10));
      const file = fileFor("k");
      rmSync(file);
      expect(Bun.spawnSync(["mkfifo", file]).exitCode).toBe(0);
      const script = `import { DiskCache } from ${JSON.stringify(join(import.meta.dir, "..", "src/lib/zarr-engine/disk-cache.ts"))};
      const c = new DiskCache({ dir: ${JSON.stringify(dir())}, maxBytes: 1000000, log: () => {} });
      console.log(c.get("k") === undefined ? "MISS" : "HIT");`;
      const proc = Bun.spawn({
        cmd: [process.execPath, "-e", script],
        stdout: "pipe",
        stderr: "pipe",
      });
      const timer = setTimeout(() => proc.kill("SIGKILL"), 4000);
      const out = await new Response(proc.stdout).text();
      clearTimeout(timer);
      expect(out.trim()).toBe("MISS");
      expect(await proc.exited).toBe(0);
      expect(existsSync(file)).toBe(false);
    },
  );
});

describe("the root is remembered, and made again when another engine removed it", () => {
  test("a put after another instance cleared the cache recreates the root and its marker", () => {
    const a = make();
    a.put("k0", body(10));
    make().clear();
    expect(existsSync(dir())).toBe(false);
    a.put("k1", body(10));
    expect(a.get("k1")).toEqual(body(10));
    expect(existsSync(join(dir(), CACHE_MARKER))).toBe(true);
    expect(logged).toEqual([]);
  });
});

describe("clear reports what it could not remove", () => {
  const unprivileged = typeof process.getuid === "function" && process.getuid() !== 0;
  test.skipIf(!unprivileged || process.platform === "win32")(
    "an entry in a read-only directory counts as failed and not as freed",
    () => {
      const a = make();
      // Two entries in two different subdirectories.
      const first = "k0";
      let second = "";
      for (let i = 1; i < 200 && !second; i++) {
        const key = `k${i}`;
        if (fileFor(key).split("/").at(-2) !== fileFor(first).split("/").at(-2)) second = key;
      }
      a.put(first, body(100));
      a.put(second, body(200));
      const lockedDir = join(fileFor(first), "..");
      chmodSync(lockedDir, 0o500);
      try {
        const result = a.clear();
        expect(result).toEqual({ freedBytes: 12 + second.length + 200, failed: 1 });
        expect(existsSync(fileFor(first))).toBe(true);
        expect(existsSync(fileFor(second))).toBe(false);
      } finally {
        chmodSync(lockedDir, 0o700);
      }
    },
  );
});

describe("clear counts a directory it cannot list", () => {
  const unprivileged = typeof process.getuid === "function" && process.getuid() !== 0;
  test.skipIf(!unprivileged || process.platform === "win32")(
    "a subdirectory with no permissions is a failure, not a silent skip",
    () => {
      const a = make();
      a.put("k0", body(100));
      const sub = join(fileFor("k0"), "..");
      chmodSync(sub, 0o000);
      try {
        const result = a.clear();
        expect(result.failed).toBeGreaterThan(0);
        expect(result.freedBytes).toBe(0);
      } finally {
        chmodSync(sub, 0o700);
      }
      expect(existsSync(fileFor("k0"))).toBe(true);
      // With the permissions back, the same clear succeeds.
      expect(a.clear()).toEqual({ freedBytes: 114, failed: 0 });
    },
  );
});
