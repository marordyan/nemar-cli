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
 * **The directory is the cache's own, and is made private.** It and each directory above it up
 * to the top (the config directory, or the directory itself when `NEMAR_ZARR_DISK_CACHE_DIR` names
 * it) are set to mode 0700. A symbolic link is never followed below the root: an entry that is
 * not a regular file, and an entry subdirectory that is not a real directory, are refused. When
 * the cache creates its root it writes a marker file there; `clear` refuses a directory without
 * one, and removes only files named like entries, so pointing the setting at a folder with other
 * things in it cannot lose them.
 *
 * **Several engines may share the directory.** Each instance rescans the directory total when its
 * own writes since the last scan pass a tenth of the limit, so the cache stays near its limit
 * instead of growing to one limit per engine.
 *
 * Environment: `NEMAR_ZARR_DISK_CACHE_DIR` (the directory) and `NEMAR_ZARR_DISK_CACHE_BYTES`
 * (the limit, default 2 GiB; 0 turns the cache off).
 */

import { createHash, randomBytes } from "node:crypto";
import {
  constants,
  chmodSync,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
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
/** The file `clear` requires at the root: the proof that the cache made the directory. */
export const CACHE_MARKER = ".nemar-zarr-cache";
/** Own writes since the last scan, as a share of the limit, that make an instance rescan. */
const RESCAN_SHARE = 0.1;
const ENTRY_NAME_RE = /^[0-9a-f]{64}$/;
const SUBDIR_RE = /^[0-9a-f]{2}$/;
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

/** Make `dir` (an entry subdirectory) at mode 0700 if it is not there, and refuse one that is not
 *  a real directory: a link there would send entries, and a chmod, somewhere else. */
function ensureRealDirectory(dir: string): void {
  let st: ReturnType<typeof lstatSync> | undefined;
  try {
    st = lstatSync(dir);
  } catch {
    st = undefined;
  }
  if (st === undefined) {
    mkdirSync(dir, { mode: 0o700 });
    return;
  }
  if (!st.isDirectory()) throw new Error(`${dir} is not a directory (a link is never followed)`);
}

/** `clear` was refused because the directory is not one the cache made. */
export class DiskCacheRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiskCacheRefusal";
  }
}

/** Open `file` for reading without following a link or blocking on a pipe, and read it whole
 *  only when it is a regular file no larger than `maxSize`. Undefined when it is not. */
function readRegularFile(file: string, maxSize: number): Buffer | undefined | "not-regular" {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  let fd: number;
  try {
    fd = openSync(file, flags);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    // ELOOP (a symbolic link under O_NOFOLLOW) or ENXIO: not a regular entry.
    if (code === "ELOOP" || code === "ENXIO") return "not-regular";
    throw err;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > maxSize) return "not-regular";
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

export class DiskCache {
  readonly dir: string;
  readonly maxBytes: number;
  private readonly log: (line: string) => void;
  private readonly top: string;
  private total: number | null = null;
  private reported = false;
  private writtenSinceScan = 0;
  private rootReady = false;

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
      const read = readRegularFile(file, this.maxBytes);
      if (read === undefined) return undefined;
      if (read === "not-regular") {
        // A link, a pipe or an over-size file where an entry belongs: never read, and the name is
        // freed (unlink removes a link itself, not what it points to).
        this.removeName(file);
        return undefined;
      }
      data = read;
    } catch (err) {
      this.degrade("read failed", err);
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
      this.ensureRoot();
      this.ensureTotal();
      ensureRealDirectory(dir);
      const head = Buffer.alloc(HEADER_BYTES);
      MAGIC.copy(head, 0);
      head.writeUInt32LE(keyBytes.length, 4);
      head.writeUInt32LE(body.length, 8);
      writeFileSync(tmp, Buffer.concat([head, keyBytes, body]), { mode: 0o600 });
      let replaced = 0;
      try {
        const old = lstatSync(file);
        if (old.isFile()) replaced = old.size;
      } catch {
        // no earlier entry
      }
      renameSync(tmp, file);
      this.total = (this.total ?? 0) - replaced + size;
      this.writtenSinceScan += size;
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        // nothing to clean up
      }
      this.degrade("write failed", err);
      return;
    }
    // Other engines may have written to the directory: look again at what is there once this
    // instance has written enough that the difference could matter.
    if (this.writtenSinceScan > this.maxBytes * RESCAN_SHARE) {
      this.total = this.scan().reduce((n, f) => n + f.size, 0);
      this.writtenSinceScan = 0;
    }
    if ((this.total ?? 0) > this.maxBytes) this.evict();
  }

  /** The root directory, private, and marked as the cache's own when this call made it. */
  private ensureRoot(): void {
    if (this.rootReady) {
      // Made and marked already by this instance: one stat that it is still there (another
      // engine's `clear` may have removed it), not a directory listing on every write.
      try {
        if (lstatSync(this.dir).isDirectory()) return;
      } catch {
        // gone: make it again below
      }
      this.rootReady = false;
    }
    let existed = true;
    try {
      lstatSync(this.dir);
    } catch {
      existed = false;
    }
    privateDir(this.dir, this.top);
    if (!existed || this.isEmptyRoot()) this.writeMarker();
    this.rootReady = true;
  }

  private isEmptyRoot(): boolean {
    try {
      return readdirSync(this.dir).length === 0;
    } catch {
      return false;
    }
  }

  private writeMarker(): void {
    try {
      writeFileSync(join(this.dir, CACHE_MARKER), "nemar zarr cache\n", {
        mode: 0o600,
        flag: "wx",
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }

  private removeName(file: string): void {
    try {
      const st = lstatSync(file);
      if (st.isDirectory()) return;
      unlinkSync(file);
      if (st.isFile() && this.total !== null) this.total = Math.max(0, this.total - st.size);
    } catch (err) {
      if (!isEnoent(err)) this.degrade("delete failed", err);
    }
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

  /** Every entry file, one directory listing deep. Links and anything that is not a regular
   *  file or a real directory are skipped, never followed. Stale temporary files are deleted. */
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
      if (!SUBDIR_RE.test(sub)) continue;
      const subPath = join(this.dir, sub);
      let names: string[];
      try {
        if (!lstatSync(subPath).isDirectory()) continue;
        names = readdirSync(subPath);
      } catch {
        continue;
      }
      for (const name of names) {
        const path = join(subPath, name);
        try {
          const st = lstatSync(path);
          if (!st.isFile()) continue;
          if (name.startsWith(".")) {
            if (name.startsWith(".tmp-") && now - st.mtimeMs > STALE_TEMP_MS) unlinkSync(path);
            continue;
          }
          if (!ENTRY_NAME_RE.test(name)) continue;
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

  /** Remove the cache's entries. Refuses (DiskCacheRefusal) a directory that does not carry the
   *  marker the cache writes when it creates its root, so a setting that names an unrelated folder
   *  cannot cost it anything. Inside the two-hex-digit subdirectories only files named like entries
   *  (and temporary files) are removed, then a subdirectory that is empty; the marker and the root
   *  go last when nothing else is in them. `freedBytes` counts only entries actually removed, and
   *  `failed` how many could not be (a permission error, say). */
  clear(): { freedBytes: number; failed: number } {
    let root: string[];
    try {
      root = readdirSync(this.dir);
    } catch (err) {
      if (isEnoent(err)) return { freedBytes: 0, failed: 0 };
      throw err;
    }
    if (!root.includes(CACHE_MARKER)) {
      throw new DiskCacheRefusal(
        `${this.dir} has no ${CACHE_MARKER} file, so the cache did not create it and nothing was removed`,
      );
    }
    let freedBytes = 0;
    let failed = 0;
    for (const sub of root) {
      if (!SUBDIR_RE.test(sub)) continue;
      const subPath = join(this.dir, sub);
      let names: string[];
      try {
        if (!lstatSync(subPath).isDirectory()) continue;
        names = readdirSync(subPath);
      } catch (err) {
        // A directory that cannot be listed (a permission error) may hold entries: not cleared.
        if (!isEnoent(err)) failed++;
        continue;
      }
      for (const name of names) {
        if (!ENTRY_NAME_RE.test(name) && !name.startsWith(".tmp-")) continue;
        const path = join(subPath, name);
        try {
          const st = lstatSync(path);
          if (!st.isFile()) continue;
          unlinkSync(path);
          if (ENTRY_NAME_RE.test(name)) freedBytes += st.size;
        } catch (err) {
          if (!isEnoent(err)) failed++;
        }
      }
      try {
        rmdirSync(subPath);
      } catch {
        // not empty (a foreign file or an entry that could not be removed), or gone
      }
    }
    try {
      unlinkSync(join(this.dir, CACHE_MARKER));
      rmdirSync(this.dir);
    } catch (err) {
      // ENOTEMPTY / EEXIST: other files remain, so the directory stays, by design. Anything else
      // (a permission error) leaves the cache standing when nothing else says so.
      const code = (err as NodeJS.ErrnoException).code;
      if (failed === 0 && code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "ENOENT") failed++;
    }
    // A directory that still holds anything keeps working as a cache: put the marker back.
    try {
      if (readdirSync(this.dir).length > 0) this.writeMarker();
    } catch {
      // the directory is gone
    }
    this.rootReady = false;
    this.total = null;
    this.writtenSinceScan = 0;
    return { freedBytes, failed };
  }

  /** Is the directory usable (created at 0700 and written to)? For `nemar doctor`. */
  checkWritable(): { ok: true } | { ok: false; reason: string } {
    try {
      this.ensureRoot();
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
