/**
 * The engine's HTTP: a credential-free public fetcher, the host policy, and the in-memory
 * caches the read core is wired to.
 *
 * **Public data only, and no credentials, by construction.** Phase 4 serves public Zarr.
 * The fetcher built here never sends an `Authorization` or `Cookie` header, sends no
 * `fetch` credentials, and refuses a request whose headers carry either (or whose URL
 * carries a user name or password), so a later change that hands it a key fails loudly
 * instead of leaking one.
 *
 * **Host policy.** Every URL the engine requests, redirect targets included, must be
 * `https`, or `http` to a loopback address only (the exception ADR 0114 makes for
 * `NEMAR_DATA_HOSTS`, so a test can stand a plain-HTTP origin up on its own machine).
 * Loopback means the literal addresses `127.0.0.1` and `[::1]`: unlike ADR 0114's list, the
 * name `localhost` is refused, because the hosts file decides where a name resolves.
 * The bases come from `NEMAR_ZARR_BASE` and `NEMAR_ZARR_DATA_PLANE`. **Those settings are
 * not ADR 0114's list**: they are never added to `NEMAR_DATA_HOSTS` and never decide where
 * a credential may go. `src/lib/data-hosts.ts` stays the only list a credential follows.
 *
 * **Caches.** The read core caches footers and `zarr.json` through a `JsonCache` but not chunk
 * bytes, so the engine wraps its fetcher in an LRU of `206` responses keyed by URL and Range
 * (a repeated window then plans the same ranges and sends none). Only a `206` whose body is
 * exactly the length the Range asked for is stored; anything else passes through uncached.
 * Every key starts with the source kind (`public` today), so an entry of one kind can never
 * be served for another when a private source is added.
 */

import type { CacheKey, Fetcher, JsonCache } from "../../../shared/zarr/interfaces.js";
import { getApiUrl } from "../api/client.js";

/** Which kind of source an entry or fetcher belongs to. Phase 4 has only `public`. */
export type SourceKind = "public";

export const DEFAULT_ZARR_BASE = "https://zarr.nemar.org";
export const ZARR_BASE_ENV = "NEMAR_ZARR_BASE";
export const ZARR_DATA_PLANE_ENV = "NEMAR_ZARR_DATA_PLANE";
/** 256 MiB, the engine's default for both the range cache and `max_payload_bytes`. */
export const DEFAULT_RANGE_CACHE_BYTES = 256 * 1024 * 1024;
/** Redirects followed by hand, each re-checked against the host policy. */
const MAX_REDIRECTS = 3;

// ---------------------------------------------------------------------------
// Host policy
// ---------------------------------------------------------------------------

/** The loopback addresses plain `http` may reach. Addresses, never names: see the header. */
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "[::1]"]);

export type HostCheck = { ok: true; url: URL } | { ok: false; reason: string };

/** Does `value` name an origin the engine may request: `https`, or `http` to loopback, with
 *  no embedded credentials? */
export function checkHost(value: string): HostCheck {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: `${value} is not a URL` };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: `${url.origin} carries credentials in the URL` };
  }
  if (url.protocol === "https:") return { ok: true, url };
  if (url.protocol === "http:" && LOOPBACK_ADDRESSES.has(url.hostname)) return { ok: true, url };
  return {
    ok: false,
    reason: `${url.origin} is not https, and plain http is allowed only to 127.0.0.1 or [::1]`,
  };
}

export class EngineConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineConfigError";
  }
}

export interface EngineBases {
  /** Where `<id>/zarr/index.json` is read, no trailing slash. */
  zarrBase: string;
  /** The data plane's `/data` mount, no trailing slash. */
  dataPlaneBase: string;
}

function validBase(name: string, value: string): string {
  const check = checkHost(value);
  if (!check.ok) throw new EngineConfigError(`${name}: ${check.reason}`);
  return value.replace(/\/+$/, "");
}

/** The two bases from the environment, defaults applied and the host policy enforced. */
export function resolveBases(env: Record<string, string | undefined> = process.env): EngineBases {
  const zarr = env[ZARR_BASE_ENV]?.trim() || DEFAULT_ZARR_BASE;
  const plane = env[ZARR_DATA_PLANE_ENV]?.trim() || `${getApiUrl().replace(/\/+$/, "")}/data`;
  return {
    zarrBase: validBase(ZARR_BASE_ENV, zarr),
    dataPlaneBase: validBase(ZARR_DATA_PLANE_ENV, plane),
  };
}

// ---------------------------------------------------------------------------
// The credential-free fetcher
// ---------------------------------------------------------------------------

const FORBIDDEN_HEADERS = ["authorization", "cookie", "proxy-authorization"];

/** The underlying `fetch`, injectable for a test that needs a different transport. */
type BaseFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * A `Fetcher` for public data. Throws (which the read core reports as a fetch failure) when
 * the URL breaks the host policy or the request carries a credential header.
 */
export function createPublicFetcher(baseFetch: BaseFetch = (u, i) => fetch(u, i)): Fetcher {
  return async (url, init) => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(init?.headers ?? {})) {
      if (FORBIDDEN_HEADERS.includes(name.toLowerCase())) {
        throw new Error(`the public fetcher refuses a request carrying ${name}`);
      }
      headers[name] = value;
    }
    let target = url;
    for (let hop = 0; ; hop++) {
      const check = checkHost(target);
      if (!check.ok) throw new Error(`refused ${target}: ${check.reason}`);
      const response = await baseFetch(target, {
        headers,
        credentials: "omit",
        redirect: "manual",
      });
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        if (hop >= MAX_REDIRECTS) throw new Error(`too many redirects fetching ${url}`);
        await response.arrayBuffer().catch(() => undefined);
        target = new URL(location, target).toString();
        continue;
      }
      return response;
    }
  };
}

// ---------------------------------------------------------------------------
// The range cache
// ---------------------------------------------------------------------------

export interface RangeCacheStats {
  hits: number;
  misses: number;
  entries: number;
  bytes: number;
}

/** What a `Range` header asks for, as a body length: `bytes=a-b` is b-a+1 and `bytes=-N`
 *  is N (the cached footers are always shorter than their shard). Null for any other form. */
function expectedRangeLength(range: string): number | null {
  const m = /^bytes=(?:(\d+)-(\d+)|-(\d+))$/.exec(range);
  if (!m) return null;
  if (m[3] !== undefined) return Number(m[3]);
  const length = Number(m[2]) - Number(m[1]) + 1;
  return length > 0 ? length : null;
}

/** An in-memory LRU of `206` bodies, bounded by total bytes. */
export class RangeCache {
  private readonly entries = new Map<string, Uint8Array>();
  private bytes = 0;
  private hits = 0;
  private misses = 0;

  constructor(
    readonly kind: SourceKind,
    private readonly maxBytes: number = DEFAULT_RANGE_CACHE_BYTES,
  ) {}

  /** The key an entry is stored under: the source kind first. */
  key(url: string, range: string): string {
    return `${this.kind}\n${url}\n${range}`;
  }

  get(url: string, range: string): Uint8Array | undefined {
    const k = this.key(url, range);
    const hit = this.entries.get(k);
    if (hit === undefined) {
      this.misses++;
      return undefined;
    }
    // Re-insert so the entry is the most recently used.
    this.entries.delete(k);
    this.entries.set(k, hit);
    this.hits++;
    return hit;
  }

  put(url: string, range: string, body: Uint8Array): void {
    if (body.length > this.maxBytes) return;
    const k = this.key(url, range);
    const old = this.entries.get(k);
    if (old) {
      this.bytes -= old.length;
      this.entries.delete(k);
    }
    this.entries.set(k, body);
    this.bytes += body.length;
    while (this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      const evicted = this.entries.get(oldest.value);
      this.entries.delete(oldest.value);
      if (evicted) this.bytes -= evicted.length;
    }
  }

  stats(): RangeCacheStats {
    return { hits: this.hits, misses: this.misses, entries: this.entries.size, bytes: this.bytes };
  }
}

/** Wrap `fetcher` so a `Range` request answered with a complete `206` is served from
 *  `cache` next time. Requests without a Range, and any response that is not a `206` of
 *  exactly the asked length, pass through and are never stored. */
export function withRangeCache(fetcher: Fetcher, cache: RangeCache): Fetcher {
  return async (url, init) => {
    const range = init?.headers?.Range;
    if (range === undefined) return fetcher(url, init);
    const cached = cache.get(url, range);
    if (cached) return new Response(cached, { status: 206 });
    const response = await fetcher(url, init);
    if (response.status !== 206) return response;
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.length === expectedRangeLength(range)) cache.put(url, range, body);
    return new Response(body, { status: 206, headers: response.headers });
  };
}

// ---------------------------------------------------------------------------
// The JSON cache
// ---------------------------------------------------------------------------

/** An in-memory `JsonCache` for footers and `zarr.json`, with the source kind in every key
 *  and the oldest entry dropped past `maxEntries`. */
export class MemoryJsonCache implements JsonCache {
  private readonly entries = new Map<string, unknown>();

  constructor(
    readonly kind: SourceKind,
    private readonly maxEntries = 4096,
  ) {}

  key(key: CacheKey): string {
    return `${this.kind}\n${JSON.stringify(key)}`;
  }

  async get(key: CacheKey): Promise<unknown | undefined> {
    return this.entries.get(this.key(key));
  }

  put(key: CacheKey, value: unknown): void {
    const k = this.key(key);
    this.entries.delete(k);
    this.entries.set(k, value);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

// ---------------------------------------------------------------------------
// JSON documents (index, version listing, records)
// ---------------------------------------------------------------------------

export type JsonFetchResult =
  | { status: "ok"; doc: unknown }
  | { status: "not_found" }
  | { status: "error"; detail: string };

/** GET a JSON document. A 404 is `not_found`; a network failure, any other non-2xx, a body
 *  past `maxBytes` and unparseable JSON are `error`. Never throws. */
export async function fetchJsonDocument(
  fetcher: Fetcher,
  url: string,
  maxBytes: number,
): Promise<JsonFetchResult> {
  let response: Response;
  try {
    response = await fetcher(url);
  } catch (err) {
    return {
      status: "error",
      detail: `network error fetching ${url}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (response.status === 404) return { status: "not_found" };
  if (!response.ok) return { status: "error", detail: `HTTP ${response.status} fetching ${url}` };
  let text: string;
  try {
    text = await response.text();
  } catch (err) {
    return {
      status: "error",
      detail: `${url} could not be read: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (text.length > maxBytes) {
    return { status: "error", detail: `${url} is larger than ${maxBytes} bytes` };
  }
  try {
    return { status: "ok", doc: JSON.parse(text) };
  } catch (err) {
    return {
      status: "error",
      detail: `${url} did not parse as JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
