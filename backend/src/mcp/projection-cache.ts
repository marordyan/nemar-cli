/**
 * Derived-projection cache for the recording-level MCP tools (epic #1065
 * phase 3, issue #1295; design doc section 7).
 *
 * `index.json` is fetched through the real zarr sub-app and its own edge
 * cache (`index-reader.ts`); the compact PROJECTIONS this file caches --
 * `list_recordings`' full recording list, `get_events`' per-store row
 * groups, and `render_overview`'s rendered PNG bytes -- are a SEPARATE
 * cache layer keyed on synthetic `https://mcp.nemar.org/_cache/...` URLs.
 * `mcp.nemar.org` here is a constant key NAMESPACE, never a real route the
 * MCP sub-app answers -- these keys exist only inside the Cache API.
 *
 * THE KEY CARRIES A CONVERSION IDENTITY, NOT JUST A COMMIT, and that is the
 * correctness of this whole layer. An earlier version keyed on
 * `(dataset_id, source_commit)` alone and asserted "a re-conversion mints a new
 * `source_commit`, so the OLD key never again resolves to different bytes".
 * That is false. `source_commit` is the DATASET REPO's HEAD
 * (`generate_zarr.py` publishes `head_commit`), not an identity of the
 * conversion, and the documented back-catalog mechanism re-converts at an
 * UNCHANGED HEAD: an engine bump re-queues a `done` row and bumps no dataset
 * version (ADR 0033), and an ADR 0023 `--clean` rebuild and a retry after an
 * infra failure are the same shape. So the old key resolved to stale bytes for
 * a full 7 days while `index.json` itself refreshed in 5 minutes, and nothing
 * purges these synthetic keys. For `array/` that meant serving a stale
 * `scale[]`/`offset[]` against re-quantized data -- silently wrong PHYSICAL
 * VALUES, with no error and nothing in `filled_ranges`; for `shardidx/` it
 * meant replaying stale byte offsets as Range reads against a new object,
 * where every 206 and length check passes by construction because the origin
 * returns exactly the bytes asked for, just the wrong ones.
 *
 * `zarr_converted_at` is that identity: a plain `datasets` column, set to
 * `datetime('now')` by every conversion, and available from the D1 row the
 * tools already load BEFORE any fetch -- which is the constraint that rules out
 * the index's own ETag or `updated_utc`, since the point of the `recordings`
 * entry is to answer without fetching `index.json` at all. A re-conversion that
 * republishes byte-identical output does needlessly invalidate, which is the
 * safe direction to err in.
 *
 * The namespace is ENVIRONMENT-SCOPED for the same class of reason. It used to
 * be the literal `https://mcp.nemar.org/_cache`, but `caches.default` is
 * zone-scoped and both `mcp.nemar.org` and `mcp-test.nemar.org` are custom
 * domains on the nemar.org zone, so prod and staging read and wrote each
 * other's entries for the same `(dataset_id, commit)` while their `data_base`
 * pointed at different buckets. Every other cache key in this worker is already
 * environment-derived (`zarr-data.ts` uses the request origin, `index-reader.ts`
 * uses `zarrCacheBaseUrl(env)`); this now matches.
 *
 * Given a key that changes on every conversion, the 7-day TTL is sound.
 * Contrast `zarr-data.ts`'s `cacheControlFor`: ITS tokened/untokened split
 * applies to `zarr.json` and the dataset-level documents (`index.json`,
 * `manifest.json`, `events.parquet`), which get a SHORT untokened TTL so a
 * re-conversion surfaces quickly there; a chunk object there gets the flat
 * 24h case regardless of tokening, because a chunk key does not change on
 * re-conversion.
 *
 * `put()` always goes through `ctx.waitUntil` and is never awaited on the
 * response path -- the same `safeCachePut` discipline `zarr-data.ts` uses:
 * a `CacheLike.put` that throws (synchronously OR as a rejected promise) is
 * caught, logged once, and treated as though the write never happened,
 * never as a request failure.
 */

import type { CacheKey, JsonCache } from "../../../shared/zarr/interfaces.js";
import type { CacheLike } from "../routes/zarr-data.js";
import type { RecordingToolDeps } from "./tool-types.js";

/** 7 days: sound because the key carries a conversion identity (see module
 *  doc), not because a commit is immutable -- it is not. */
export const PROJECTION_CACHE_CONTROL = "public, max-age=604800";

/** Fallback namespace host when `MCP_HOSTNAME` is unset (a local `wrangler dev`
 *  or a test env). Distinct from any real hostname on purpose: an unconfigured
 *  environment must not land in prod's or staging's namespace by default. */
const PROJECTION_HOST_FALLBACK = "mcp.invalid";

/** Bumped whenever a cached payload's SHAPE changes (a field renamed, an
 *  invariant tightened, a new required field). The last path segment of
 *  every `projectionUrl`, so a deploy that changes a payload shape can
 *  never read an entry a previous deploy wrote for it -- the entry simply
 *  lives at a different key and the old one ages out on its own 7-day TTL,
 *  never mixing an old and a new shape under one key. Bump this alongside
 *  any change to `RecordingsProjection` or the cached events payload (bumped to
 *  2 when the per-store entry became `{rows, invalidRowCount}` rather than a
 *  bare row array). */
export const PROJECTION_SCHEMA_VERSION = 2;

/** Synthetic cache key for a projection:
 *  `https://<mcp host>/_cache/<id>/<identity>/<projection>/v<schema version>`,
 *  where `<identity>` is `<commit>.<conversion id>` (see the module doc for why
 *  the commit alone is not enough, and why the host is environment-derived).
 *  `projection` is one of `"recordings"`, `` `events/${zarr}` ``,
 *  `` `shardidx/${zarr}/${group}/0/${j}` ``, or
 *  `` `overview/${zarr}/${group}/${level}/${widthBucket}` `` -- see the tool
 *  files for how each builds its own string. */
export function projectionUrl(input: {
  /** Read for `MCP_HOSTNAME`, so prod and staging never share an entry. */
  env: { MCP_HOSTNAME?: string };
  datasetId: string;
  sourceCommit: string;
  /** D1's `datasets.zarr_converted_at`. Null is tolerated and keyed
   *  explicitly rather than dropped, so a row that has somehow never been
   *  stamped cannot silently collide with a row that has. */
  convertedAt: string | null;
  projection: string;
}): string {
  const host = input.env.MCP_HOSTNAME?.trim() || PROJECTION_HOST_FALLBACK;
  const identity = `${input.sourceCommit}.${input.convertedAt ?? "unconverted"}`;
  return `https://${host}/_cache/${encodeURIComponent(input.datasetId)}/${encodeURIComponent(identity)}/${input.projection}/v${PROJECTION_SCHEMA_VERSION}`;
}

async function safeCacheMatch(cache: CacheLike, url: string): Promise<Response | undefined> {
  try {
    return await cache.match(new Request(url, { method: "GET" }));
  } catch (err) {
    console.error("[mcp] projection cache.match failed", { url }, err);
    return undefined;
  }
}

/** Mirrors `zarr-data.ts`'s `safeCachePut`: a plain (non-async) `put` can
 *  throw SYNCHRONOUSLY, so the call is wrapped in try/catch rather than
 *  `.catch()`, which only ever observes a rejected promise. */
async function safeCachePutEntry(cache: CacheLike, url: string, entry: Response): Promise<void> {
  try {
    await cache.put(new Request(url, { method: "GET" }), entry);
  } catch (err) {
    console.error("[mcp] projection cache.put failed", { url }, err);
  }
}

export type ProjectionReadResult<T> = { status: "hit"; value: T } | { status: "miss" };

/** The minimal Standard-Schema-shaped validator every payload schema this
 *  file accepts must implement -- zod's own `.safeParse` already is one, so
 *  callers pass a real zod schema (`recordingsProjectionSchema`,
 *  `eventRowsProjectionSchema`) with no adapter. (The shard-footer and
 *  level-0 array schemas moved into `shared/zarr/`, which validates the
 *  values the `JsonCache` adapter hands back.) */
export interface ProjectionPayloadSchema<T> {
  safeParse: (input: unknown) => { success: boolean; data?: T };
}

/** Read a JSON projection, validated against `schema` (decision: every
 *  cached payload has a declared shape, checked on every hit, not just
 *  trusted because it round-tripped through `JSON.parse`). A cache miss, a
 *  `match()` throw, a stored entry that fails to parse as JSON, AND a
 *  stored entry that fails `schema` validation all answer the same
 *  `{status:"miss"}` -- a corrupt or stale-shaped cache entry is exactly as
 *  actionable as no entry at all: a fresh write on this call, at the
 *  CURRENT `PROJECTION_SCHEMA_VERSION` key. A schema mismatch is logged
 *  once with `console.warn` (not `console.error`: an expected, recoverable
 *  event across a deploy that changed a shape without also bumping
 *  `PROJECTION_SCHEMA_VERSION`, not an operational failure). */
export async function readJsonProjection<T>(
  cache: CacheLike,
  url: string,
  schema: ProjectionPayloadSchema<T>,
): Promise<ProjectionReadResult<T>> {
  const hit = await safeCacheMatch(cache, url);
  if (!hit) return { status: "miss" };
  let json: unknown;
  try {
    json = await hit.json();
  } catch (err) {
    console.error("[mcp] projection cache hit did not parse as JSON", { url }, err);
    return { status: "miss" };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    console.warn("[mcp] projection cache hit failed schema validation, treated as a miss", { url });
    return { status: "miss" };
  }
  return { status: "hit", value: parsed.data as T };
}

/** Write a JSON projection via `ctx.waitUntil` -- never awaited on the
 *  response path, per the module doc. */
export function writeJsonProjection(
  executionCtx: ExecutionContext,
  cache: CacheLike,
  url: string,
  value: unknown,
): void {
  const entry = new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": PROJECTION_CACHE_CONTROL },
  });
  executionCtx.waitUntil(safeCachePutEntry(cache, url, entry));
}

/** The Worker's {@link JsonCache} for the shared Zarr read core: keys go
 *  through {@link projectionUrl} (so cache URLs are exactly what the tools
 *  wrote before the core existed) and entries through the Cache API. Values
 *  come back UNVALIDATED -- the core owns the schemas and treats an invalid
 *  entry as a miss. */
export function mcpJsonCache(deps: RecordingToolDeps): JsonCache {
  return {
    async get(key: CacheKey): Promise<unknown | undefined> {
      const url = projectionUrl({ env: deps.env, ...key });
      const hit = await safeCacheMatch(deps.cache(), url);
      if (!hit) return undefined;
      try {
        return await hit.json();
      } catch (err) {
        console.error("[mcp] projection cache hit did not parse as JSON", { url }, err);
        return undefined;
      }
    },
    put(key: CacheKey, value: unknown): void {
      const url = projectionUrl({ env: deps.env, ...key });
      writeJsonProjection(deps.executionCtx, deps.cache(), url, value);
    },
  };
}

export type BinaryProjectionReadResult =
  | { status: "hit"; bytes: Uint8Array; contentType: string | null }
  | { status: "miss" };

/** Read a binary projection (the `render_overview` PNG). */
export async function readBinaryProjection(
  cache: CacheLike,
  url: string,
): Promise<BinaryProjectionReadResult> {
  const hit = await safeCacheMatch(cache, url);
  if (!hit) return { status: "miss" };
  try {
    return {
      status: "hit",
      bytes: new Uint8Array(await hit.arrayBuffer()),
      contentType: hit.headers.get("content-type"),
    };
  } catch (err) {
    console.error("[mcp] projection cache hit did not read as bytes", { url }, err);
    return { status: "miss" };
  }
}

/** Write a binary projection via `ctx.waitUntil`. */
export function writeBinaryProjection(
  executionCtx: ExecutionContext,
  cache: CacheLike,
  url: string,
  bytes: Uint8Array,
  contentType: string,
): void {
  const entry = new Response(bytes, {
    status: 200,
    headers: { "Content-Type": contentType, "Cache-Control": PROJECTION_CACHE_CONTROL },
  });
  executionCtx.waitUntil(safeCachePutEntry(cache, url, entry));
}
