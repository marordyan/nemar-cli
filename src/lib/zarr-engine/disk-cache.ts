/**
 * The engine's disk cache (ADR 0120 decision 11): `206` range bodies and the read core's JSON
 * (shard footers, array metadata), kept across engine restarts so a repeated read sends no
 * range request.
 *
 * **Public bytes only, one cache per host.** Only the public source writes it. It lives at
 * `<config dir>/zarr-cache/public/v1/`, created at mode 0700. `index.json` is never stored
 * here: it is read again at each engine start, which is how a re-conversion is noticed.
 *
 * **The key carries the store's identity** (`storeIdentity` in `http.ts`: source kind, data
 * origin, dataset, `source_commit`, `updated_utc`), then the URL and the Range. Chunk URLs
 * survive a re-conversion, so a key of URL and Range alone would serve old bytes.
 *
 * **An entry is one file**, `<2 hex>/<sha256 of the key>`: the magic `NZC1`, the key's length
 * and the body's length (u32 little-endian each), the key, then the body. A read checks all
 * of it (magic, key length, key bytes, body length equal to what is left of the file); an
 * entry that fails is a miss and is deleted. A write goes to a temporary file in the same
 * directory and is renamed into place, so a crash or a second engine never leaves a torn entry.
 *
 * **The cache never fails a read.** Any disk error is a miss, with one line on stderr per
 * cache instance. A `get` touches the file's mtime (the LRU order). The total size comes from
 * one scan; when a write pushes it over the limit the oldest entries are deleted until it is
 * at 90%. `ENOENT` is tolerated everywhere because two engines may share the directory.
 *
 * Environment: `NEMAR_ZARR_DISK_CACHE_DIR` (the directory) and `NEMAR_ZARR_DISK_CACHE_BYTES`
 * (the limit, default 2 GiB; 0 turns the cache off).
 */

import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { CacheKey, Fetcher, JsonCache } from "../../../shared/zarr/interfaces.js";
import { getConfigDir } from "../config.js";
import { privateDir } from "../repull/execute/workdir.js";
import { EngineConfigError, expectedRangeLength } from "./http.js";

export const DISK_CACHE_DIR_ENV = "NEMAR_ZARR_DISK_CACHE_DIR";
export const DISK_CACHE_BYTES_ENV = "NEMAR_ZARR_DISK_CACHE_BYTES";
/** 2 GiB. */
export const DEFAULT_DISK_CACHE_BYTES = 2 * 1024 * 1024 * 1024;
/** An eviction stops at this share of the limit. */
const EVICT_TO = 0.9;
const MAGIC = Buffer.from("NZC1", "ascii");
const HEADER_BYTES = 12;
/** A temporary file older than this is a crashed writer's; a scan deletes it. */
const STALE_TEMP_MS = 60 * 60 * 1000;

/** The default directory: `<config dir>/zarr-cache/public/v1`. */
export function defaultDiskCacheDir(): string {
  return join(getConfigDir(), "zarr-cache", "public", "v1");
}

export interface DiskCacheStats {
  dir: string;
  enabled: boolean;
  bytes: number;
  entries: number;
  limitBytes: number;
}

interface Found {
  path: string;
  size: number;
  mtimeMs: number;
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

export class DiskCache {
  readonly dir: string;
  readonly maxBytes: number;
  private readonly log: (line: string) => void;
  private readonly top: string;
  private total: number | null = null;
  private reported = false;

  /** `top` is the highest directory `privateDir` sets to 0700 (the directory itself unless
   *  the default location under the config directory is used). */
  constructor(options: {
    dir: string;
    maxBytes: number;
    log?: (line: string) => void;
    top?: string;
  }) {
    this.dir = options.dir;
    this.maxBytes = options.maxBytes;
    this.top = options.top ?? options.dir;
    this.log = options.log ?? ((line) => console.error(line));
  }

  get enabled(): boolean {
    return this.maxBytes > 0;
  }

  private degrade(what: string, err: unknown): void {
    if (this.reported) return;
    this.reported = true;
    this.log(
      `[zarr-engine] disk cache ${this.dir}: ${what}: ${err instanceof Error ? err.message : String(err)}; reads continue without it`,
    );
  }

  private paths(key: string): { dir: string; file: string } {
    const hash = createHash("sha256").update(key).digest("hex");
    const dir = join(this.dir, hash.slice(0, 2));
    return { dir, file: join(dir, hash) };
  }

  /** The cached body for `key`, or undefined (a miss, a bad entry or a disk error). */
  get(key: string): Uint8Array | undefined {
    if (!this.enabled) return undefined;
    const { file } = this.paths(key);
    let data: Buffer;
    try {
      data = readFileSync(file);
    } catch (err) {
      if (!isEnoent(err)) this.degrade("read failed", err);
      return undefined;
    }
    const keyBytes = Buffer.from(key, "utf8");
    const valid =
      data.length >= HEADER_BYTES &&
      data.subarray(0, 4).equals(MAGIC) &&
      data.readUInt32LE(4) === keyBytes.length &&
      data.readUInt32LE(8) === data.length - HEADER_BYTES - keyBytes.length &&
      data.subarray(HEADER_BYTES, HEADER_BYTES + keyBytes.length).equals(keyBytes);
    if (!valid) {
      this.remove(file, data.length);
      return undefined;
    }
    try {
      const now = new Date();
      utimesSync(file, now, now);
    } catch (err) {
      if (!isEnoent(err)) this.degrade("touch failed", err);
    }
    return new Uint8Array(
      data.buffer,
      data.byteOffset + HEADER_BYTES + keyBytes.length,
      data.length - HEADER_BYTES - keyBytes.length,
    );
  }

  /** Store `body` under `key`. Best effort: a failure is logged once and otherwise ignored. */
  put(key: string, body: Uint8Array): void {
    if (!this.enabled) return;
    const keyBytes = Buffer.from(key, "utf8");
    const size = HEADER_BYTES + keyBytes.length + body.length;
    if (size > this.maxBytes || body.length > 0xffffffff) return;
    const { dir, file } = this.paths(key);
    const tmp = join(dir, `.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
    try {
      this.ensureTotal();
      privateDir(dir, this.top);
      const head = Buffer.alloc(HEADER_BYTES);
      MAGIC.copy(head, 0);
      head.writeUInt32LE(keyBytes.length, 4);
      head.writeUInt32LE(body.length, 8);
      writeFileSync(tmp, Buffer.concat([head, keyBytes, body]), { mode: 0o600 });
      let replaced = 0;
      try {
        replaced = statSync(file).size;
      } catch {
        // no earlier entry
      }
      renameSync(tmp, file);
      this.total = (this.total ?? 0) - replaced + size;
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        // nothing to clean up
      }
      this.degrade("write failed", err);
      return;
    }
    if ((this.total ?? 0) > this.maxBytes) this.evict();
  }

  private remove(file: string, size: number): void {
    try {
      unlinkSync(file);
      if (this.total !== null) this.total = Math.max(0, this.total - size);
    } catch (err) {
      if (!isEnoent(err)) this.degrade("delete failed", err);
    }
  }

  private ensureTotal(): void {
    if (this.total === null) this.total = this.scan().reduce((n, f) => n + f.size, 0);
  }

  /** Every entry file, one directory listing deep. Stale temporary files are deleted. */
  private scan(): Found[] {
    const found: Found[] = [];
    let subdirs: string[];
    try {
      subdirs = readdirSync(this.dir);
    } catch (err) {
      if (!isEnoent(err)) this.degrade("scan failed", err);
      return found;
    }
    const now = Date.now();
    for (const sub of subdirs) {
      if (!/^[0-9a-f]{2}$/.test(sub)) continue;
      let names: string[];
      try {
        names = readdirSync(join(this.dir, sub));
      } catch {
        continue;
      }
      for (const name of names) {
        const path = join(this.dir, sub, name);
        try {
          const st = statSync(path);
          if (name.startsWith(".")) {
            if (name.startsWith(".tmp-") && now - st.mtimeMs > STALE_TEMP_MS) unlinkSync(path);
            continue;
          }
          found.push({ path, size: st.size, mtimeMs: st.mtimeMs });
        } catch {
          // gone since the listing: another engine removed it
        }
      }
    }
    return found;
  }

  /** Delete the oldest entries until the cache is at 90% of its limit. */
  private evict(): void {
    const entries = this.scan().sort((a, b) => a.mtimeMs - b.mtimeMs);
    let total = entries.reduce((n, f) => n + f.size, 0);
    const target = this.maxBytes * EVICT_TO;
    for (const entry of entries) {
      if (total <= target) break;
      try {
        unlinkSync(entry.path);
      } catch (err) {
        if (!isEnoent(err)) this.degrade("delete failed", err);
      }
      total -= entry.size;
    }
    this.total = total;
  }

  /** What is on disk now, from a fresh scan (it does not create the directory). */
  stats(): DiskCacheStats {
    const entries = this.scan();
    return {
      dir: this.dir,
      enabled: this.enabled,
      bytes: entries.reduce((n, f) => n + f.size, 0),
      entries: entries.length,
      limitBytes: this.maxBytes,
    };
  }

  /** Remove the whole cache directory; the bytes it held. */
  clear(): number {
    const { bytes } = this.stats();
    rmSync(this.dir, { recursive: true, force: true });
    this.total = 0;
    return bytes;
  }

  /** Is the directory usable (created at 0700 and written to)? For `nemar doctor`. */
  checkWritable(): { ok: true } | { ok: false; reason: string } {
    try {
      privateDir(this.dir, this.top);
      const probe = join(this.dir, `.probe-${process.pid}-${randomBytes(4).toString("hex")}`);
      writeFileSync(probe, "x", { mode: 0o600 });
      unlinkSync(probe);
      chmodSync(this.dir, 0o700);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }
}

/** The disk cache the environment asks for: its directory (default under the config
 *  directory) and limit (default 2 GiB, 0 turns it off). */
export function resolveDiskCache(
  env: Record<string, string | undefined> = process.env,
  log?: (line: string) => void,
): DiskCache {
  const rawBytes = env[DISK_CACHE_BYTES_ENV]?.trim();
  let maxBytes = DEFAULT_DISK_CACHE_BYTES;
  if (rawBytes) {
    const n = Number(rawBytes);
    if (!Number.isSafeInteger(n) || n < 0) {
      throw new EngineConfigError(
        `${DISK_CACHE_BYTES_ENV} must be a non-negative integer, got ${rawBytes}`,
      );
    }
    maxBytes = n;
  }
  const override = env[DISK_CACHE_DIR_ENV]?.trim();
  if (override) return new DiskCache({ dir: override, maxBytes, log });
  return new DiskCache({ dir: defaultDiskCacheDir(), maxBytes, log, top: getConfigDir() });
}

/**
 * Wrap `fetcher` so a `Range` request is served from disk when the entry is there, and a
 * complete `206` is written to disk when it is not. `scope` is the store identity. Only a
 * body of exactly the asked length is stored or served; everything else passes through.
 */
export function withDiskRangeCache(fetcher: Fetcher, disk: DiskCache, scope: string): Fetcher {
  return async (url, init) => {
    const range = init?.headers?.Range;
    if (range === undefined || !disk.enabled) return fetcher(url, init);
    const want = expectedRangeLength(range);
    const key = `${scope}\n${url}\n${range}`;
    const hit = disk.get(key);
    if (hit && hit.length === want) return new Response(hit, { status: 206 });
    const response = await fetcher(url, init);
    if (response.status !== 206) return response;
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.length === want) disk.put(key, body);
    return new Response(body, { status: 206, headers: response.headers });
  };
}

/** A `JsonCache` with memory in front of `disk`: a hit on disk is promoted to memory. Keys
 *  carry `scope` (the store identity) on disk; the memory tier keeps its own key. */
export class TieredJsonCache implements JsonCache {
  constructor(
    private readonly memory: JsonCache,
    private readonly disk: DiskCache,
    private readonly scope: string,
  ) {}

  private diskKey(key: CacheKey): string {
    return `json\n${this.scope}\n${JSON.stringify(key)}`;
  }

  async get(key: CacheKey): Promise<unknown | undefined> {
    const inMemory = await this.memory.get(key);
    if (inMemory !== undefined) return inMemory;
    const stored = this.disk.get(this.diskKey(key));
    if (stored === undefined) return undefined;
    try {
      const value: unknown = JSON.parse(new TextDecoder().decode(stored));
      this.memory.put(key, value);
      return value;
    } catch {
      return undefined;
    }
  }

  put(key: CacheKey, value: unknown): void {
    this.memory.put(key, value);
    if (!this.disk.enabled) return;
    let text: string | undefined;
    try {
      text = JSON.stringify(value);
    } catch {
      return;
    }
    if (text !== undefined) this.disk.put(this.diskKey(key), new TextEncoder().encode(text));
  }
}
