/**
 * The engine's HTTP: a credential-free public fetcher, the host policy, and the in-memory
 * caches the read core is wired to.
 *
 * **Public data only, and no credentials, by construction.** Phase 4 serves public Zarr.
 * The fetcher built here never sends an `Authorization`, `Cookie` or `Proxy-Authorization`
 * header, sends no `fetch` credentials, and refuses a request whose headers carry any of them
 * (or whose URL carries a user name or password), so a later change that hands it a key fails
 * loudly instead of leaking one. Bun honours `HTTP_PROXY` and `HTTPS_PROXY`; the
 * no-credentials guarantee does not cover the userinfo of a proxy URL the environment names,
 * which is the user's own configuration.
 *
 * **Host policy.** Every URL the engine requests, redirect targets included, must be
 * `https`, or `http` to a loopback address only (the exception ADR 0114 makes for
 * `NEMAR_DATA_HOSTS`, so a test can stand a plain-HTTP origin up on its own machine).
 * A redirect from an `https` URL to an `http` one is refused even to loopback (a downgrade).
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
/** The Zarr host that goes with each NEMAR API host. Any other API host (a self-hosted or
 *  development backend) has no entry and falls back to {@link DEFAULT_ZARR_BASE}. */
const ZARR_BASE_BY_API_HOST: Record<string, string> = {
  "api.nemar.org": DEFAULT_ZARR_BASE,
  "api-test.nemar.org": "https://zarr-test.nemar.org",
};
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

/** Is `value` a plain-`http` base (which {@link checkHost} admits only on loopback)? */
export function isPlainHttpBase(value: string): boolean {
  try {
    return new URL(value).protocol === "http:";
  } catch {
    return false;
  }
}

/** Does moving from `from` to `to` step down from `https` to `http`? A redirect that does
 *  is refused: a transfer that began encrypted must not continue in the clear. */
export function isHttpsDowngrade(from: string, to: string): boolean {
  return new URL(from).protocol === "https:" && new URL(to).protocol === "http:";
}

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

/** Where the zarr base came from: the environment, the signed-in account's API host, or the
 *  production default (an API host with no Zarr host of its own). */
export type ZarrBaseSource = "env" | "account" | "default";

/** The Zarr base that goes with an API URL, and whether the account chose it. */
export function zarrBaseForApi(apiUrl: string): { base: string; source: "account" | "default" } {
  try {
    const known = ZARR_BASE_BY_API_HOST[new URL(apiUrl).hostname];
    if (known) return { base: known, source: "account" };
  } catch {
    // not a URL: the default
  }
  return { base: DEFAULT_ZARR_BASE, source: "default" };
}

/** Where {@link resolveBases} takes the zarr base from, for `nemar engine status`. */
export function zarrBaseSource(
  env: Record<string, string | undefined> = process.env,
  apiUrl: string = getApiUrl(),
): ZarrBaseSource {
  return env[ZARR_BASE_ENV]?.trim() ? "env" : zarrBaseForApi(apiUrl).source;
}

/**
 * The two bases, defaults applied and the host policy enforced. The zarr base is
 * `NEMAR_ZARR_BASE`, else the one that goes with the active account's API host
 * (`api.nemar.org` gives `zarr.nemar.org`, `api-test.nemar.org` gives `zarr-test.nemar.org`),
 * else production. The data plane follows the API URL.
 */
export function resolveBases(
  env: Record<string, string | undefined> = process.env,
  apiUrl: string = getApiUrl(),
): EngineBases {
  const zarr = env[ZARR_BASE_ENV]?.trim() || zarrBaseForApi(apiUrl).base;
  const plane = env[ZARR_DATA_PLANE_ENV]?.trim() || `${apiUrl.replace(/\/+$/, "")}/data`;
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
export type BaseFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * A `Fetcher` for public data. Throws (which the read core reports as a fetch failure) when
 * the URL breaks the host policy or the request carries a credential header.
 */
export function createPublicFetcher(baseFetch: BaseFetch = (u, i) => fetch(u, i)): Fetcher {
  return async (url, init) => {
    // Normalised through `Headers`, so a plain record, a `Headers` instance and an array of
    // pairs are all inspected, never skipped (`Object.entries` of a `Headers` is empty).
    const headers: Record<string, string> = {};
    new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]).forEach(
      (value, name) => {
        if (FORBIDDEN_HEADERS.includes(name.toLowerCase())) {
          throw new Error(`the public fetcher refuses a request carrying ${name}`);
        }
        headers[name] = value;
      },
    );
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
        const next = new URL(location, target).toString();
        if (isHttpsDowngrade(target, next)) {
          throw new Error(`refused redirect from ${target} to ${next}: https to http`);
        }
        target = next;
        continue;
      }
      return response;
    }
  };
}

// ---------------------------------------------------------------------------
// Bounded bodies
// ---------------------------------------------------------------------------

/** The most a request without a `Range` may return through {@link withBodyCaps}: the read
 *  core's own `zarr.json` fetch, which it reads whole. Far above any real array metadata. */
export const MAX_PLAIN_BODY_BYTES = 8 * 1024 * 1024;

export type CappedBody =
  | { exceeded: false; bytes: Uint8Array }
  /** `bytes` holds what was read before the read stopped: at most `cap` bytes, none when
   *  `Content-Length` already said the body was too big. */
  | { exceeded: true; bytes: Uint8Array };

/** `Content-Length` as a count, or null when absent, not a number, or the body is encoded
 *  (then it counts the encoded bytes, not the ones this code reads). */
function declaredLength(response: Response): number | null {
  const encoding = response.headers.get("content-encoding");
  if (encoding && encoding.toLowerCase() !== "identity") return null;
  const raw = response.headers.get("content-length");
  if (raw === null || !/^\d+$/.test(raw)) return null;
  return Number(raw);
}

/**
 * Read a response body of at most `cap` bytes. A `Content-Length` over the cap fails without
 * reading anything; otherwise the stream is read and cancelled as soon as the total passes the
 * cap, so a hostile or broken origin cannot make the engine buffer more than `cap` (plus one
 * chunk). The caller decides what an exceeded body means.
 */
export async function readBodyCapped(response: Response, cap: number): Promise<CappedBody> {
  const declared = declaredLength(response);
  const stream = response.body;
  if (declared !== null && declared > cap) {
    await stream?.cancel().catch(() => undefined);
    return { exceeded: true, bytes: new Uint8Array(0) };
  }
  if (!stream) return { exceeded: false, bytes: new Uint8Array(0) };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.length > cap) {
      chunks.push(value.subarray(0, cap - total));
      total = cap;
      await reader.cancel().catch(() => undefined);
      return { exceeded: true, bytes: concat(chunks, total) };
    }
    chunks.push(value);
    total += value.length;
  }
  return { exceeded: false, bytes: concat(chunks, total) };
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** The headers of `response` without the ones that described the body as it was sent. */
function bodylessHeaders(response: Response): Headers {
  const headers = new Headers(response.headers);
  for (const name of ["content-length", "content-encoding", "transfer-encoding"]) {
    headers.delete(name);
  }
  return headers;
}

/**
 * Wrap `fetcher` so no response body is read past a bound, and the bodies the read core reads
 * (`shared/zarr/fetch-range.ts` and `array-metadata.ts` read them whole) are bounded data.
 *
 *   - A `Range` request is bounded by the length the header asks for (`bytes=a-b` is b-a+1,
 *     `bytes=-N` is N; the core sends only those two). Any other Range form is refused.
 *   - A `206` whose `Content-Length` differs from that length, or whose body is longer, is a
 *     failure (the fetcher throws, which the core reports as a fetch failure). A shorter body
 *     is passed on; the core refuses it.
 *   - Any other status is passed on with its status kept and its body cut at that length (the
 *     core rejects a non-206 anyway; a bare `200` of a whole object is never read whole).
 *   - A request without `Range` is bounded by `plainCap`; a body over it is a failure.
 *
 * Each response is returned as a fresh `Response` built from the bytes read.
 */
export function withBodyCaps(fetcher: Fetcher, plainCap: number = MAX_PLAIN_BODY_BYTES): Fetcher {
  return async (url, init) => {
    const range = init?.headers?.Range;
    const response = await fetcher(url, init);
    if (range === undefined) {
      const body = await readBodyCapped(response, plainCap);
      if (body.exceeded) throw new Error(`${url} returned more than ${plainCap} bytes`);
      return new Response(body.bytes, {
        status: response.status,
        headers: bodylessHeaders(response),
      });
    }
    const length = expectedRangeLength(range);
    if (length === null) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`refused Range ${range} for ${url}: not bytes=a-b or bytes=-N`);
    }
    if (response.status === 206) {
      const declared = declaredLength(response);
      if (declared !== null && declared !== length) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(
          `${url} (Range ${range}) answered 206 with Content-Length ${declared}, expected ${length}`,
        );
      }
      const body = await readBodyCapped(response, length);
      if (body.exceeded) {
        throw new Error(`${url} (Range ${range}) answered 206 with more than ${length} bytes`);
      }
      return new Response(body.bytes, { status: 206, headers: bodylessHeaders(response) });
    }
    const body = await readBodyCapped(response, length);
    return new Response(body.bytes, {
      status: response.status,
      headers: bodylessHeaders(response),
    });
  };
}

/**
 * Wrap `fetcher` so a `Range` request asking for more than `ceiling` bytes is refused before
 * anything is sent (the fetcher throws, which the core reports as a fetch failure).
 *
 * {@link withBodyCaps} bounds a body by the length its `Range` asks for, but that length comes
 * from the shard footer, which the data host serves: a hostile footer could claim a chunk of
 * any size. The caller sets `ceiling` from the store's own geometry (the most bytes one read
 * of the window can legitimately need), so the footer cannot raise it.
 */
export function withRangeCeiling(fetcher: Fetcher, ceiling: number): Fetcher {
  return async (url, init) => {
    const range = init?.headers?.Range;
    if (range !== undefined) {
      const length = expectedRangeLength(range);
      if (length !== null && length > ceiling) {
        throw new Error(
          `refused Range ${range} for ${url}: ${length} bytes is over the ${ceiling} one read of this window can need`,
        );
      }
    }
    return fetcher(url, init);
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
export function expectedRangeLength(range: string): number | null {
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

  /** The key an entry is stored under: the source kind first, then the store identity
   *  (`scope`, see {@link storeIdentity}), then the URL and Range. An empty scope leaves the
   *  key as kind, URL, Range. */
  key(url: string, range: string, scope = ""): string {
    return scope === ""
      ? `${this.kind}\n${url}\n${range}`
      : `${this.kind}\n${scope}\n${url}\n${range}`;
  }

  get(url: string, range: string, scope = ""): Uint8Array | undefined {
    const k = this.key(url, range, scope);
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

  put(url: string, range: string, body: Uint8Array, scope = ""): void {
    if (body.length > this.maxBytes) return;
    const k = this.key(url, range, scope);
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

/** The identity of one converted store, as a string for a cache key. Chunk URLs do not change
 *  when a store is re-converted (`data_base` is `<id>/zarr/`), so a key of kind, URL and Range
 *  alone would serve the old bytes for the new store. The identity adds what does change: the
 *  data origin, the dataset, `source_commit` and `updated_utc` (the same `convertedAt` the JSON
 *  cache uses). */
export function storeIdentity(
  kind: SourceKind,
  store: { dataBase: string; datasetId: string; sourceCommit: string; convertedAt: string | null },
): string {
  let origin: string;
  try {
    origin = new URL(store.dataBase).origin;
  } catch {
    origin = store.dataBase;
  }
  return JSON.stringify([kind, origin, store.datasetId, store.sourceCommit, store.convertedAt]);
}

/** Wrap `fetcher` so a `Range` request answered with a complete `206` is served from
 *  `cache` next time, under `scope` (the store identity). Requests without a Range, and any
 *  response that is not a `206` of exactly the asked length, pass through and are never stored. */
export function withRangeCache(fetcher: Fetcher, cache: RangeCache, scope = ""): Fetcher {
  return async (url, init) => {
    const range = init?.headers?.Range;
    if (range === undefined) return fetcher(url, init);
    const cached = cache.get(url, range, scope);
    if (cached) return new Response(cached, { status: 206 });
    const response = await fetcher(url, init);
    if (response.status !== 206) return response;
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.length === expectedRangeLength(range)) cache.put(url, range, body, scope);
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
    const body = await readBodyCapped(response, maxBytes);
    if (body.exceeded) {
      return { status: "error", detail: `${url} is larger than ${maxBytes} bytes` };
    }
    text = new TextDecoder().decode(body.bytes);
  } catch (err) {
    return {
      status: "error",
      detail: `${url} could not be read: ${err instanceof Error ? err.message : String(err)}`,
    };
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
