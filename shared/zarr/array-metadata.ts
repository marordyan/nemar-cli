/**
 * Level-0 Zarr array metadata (`zarr.json`) fetch + cache, for `read_window`
 * taste mode only (epic #1065 phase 4, issue #1296). Host-neutral: it talks
 * through `Fetcher` and `JsonCache` (`interfaces.ts`).
 *
 * Recipe mode never calls this: `buildReadRecipe` is called WITHOUT
 * `arrayMetadata` there (design doc section 5.6), so `dtype` is
 * null and `codecs` absent -- the whole point of the recipe path is that it
 * makes no reads beyond `index.json`. Taste mode DOES need this document: the
 * per-channel `scale[]`/`offset[]` arrays that turn a digital sample into a
 * physical value (`layout.scale_offset`: `physical = digital * scale +
 * offset`) live only here, on the level-0 array's own `attributes` --
 * confirmed against the real, committed `test/fixtures/zarr-array-level0.zarr.json`
 * (nm000329's `eeg_250hz` level-0 array), whose `attributes.scale`/
 * `attributes.offset` are each a 63-element array, one entry per channel.
 * `data_type`/`codecs` come along for free from the same fetch, which is why
 * a taste response's embedded recipe is always fully populated
 * where a bare recipe-mode response is not.
 *
 * Cached as a projection (the host's `JsonCache`) under
 * `array/<zarr>/<group>/0`, immutable per `(dataset_id, source_commit)` like
 * every other projection kind -- bypassed (read fresh, never written) when
 * the commit is not a usable 40-hex SHA, mirroring every other cache-bypass
 * rule in this package.
 */

import { z } from "zod";
import {
  SOURCE_COMMIT_RE,
  type ZarrArrayMetadata,
  zarrArrayMetadataSchema,
} from "../contract/zarr-index.js";
import type { CacheKey, Fetcher, JsonCache } from "./interfaces.js";

export interface Level0ArrayMetadata {
  dataType: string;
  codecs: ZarrArrayMetadata["codecs"];
  /** One entry per channel -- the MCP `read_window` tool
   *  (`backend/src/mcp/tools/read-window.ts`) cross-checks the length
   *  against the group's own `n_channels` before trusting either array. */
  scale: number[];
  offset: number[];
}

/** Cached payload shape, validated on every cache hit -- `codecs` stays `z.array(z.unknown())` here
 *  (rather than re-importing `zarrCodecSchema`) since this cache entry only
 *  ever round-trips what `zarrArrayMetadataSchema` already validated once,
 *  on the write side. */
const level0ArrayProjectionSchema = z.object({
  dataType: z.string(),
  codecs: z.array(z.unknown()),
  scale: z.array(z.number()),
  offset: z.array(z.number()),
});

export type LoadLevel0ArrayMetadataResult =
  | { ok: true; metadata: Level0ArrayMetadata; cacheStatus: "hit" | "miss"; upstreamBytes: number }
  | { ok: false; detail: string };

/** The level-0 array's own `zarr.json` key, relative to `data_base` --
 *  `layout.level0` (`<zarr>/<group>/0`) plus the document's own name. */
export function level0ArrayMetadataKey(zarr: string, group: string): string {
  return `${zarr}/${group}/0/zarr.json`;
}

/**
 * Validate a parsed level-0 `zarr.json` document and pull out what taste mode
 * needs. Pure: `url` only names the document in the error text. Never throws:
 * a document that fails `zarrArrayMetadataSchema`, or whose `attributes` carry
 * no usable `scale[]`/`offset[]`, is `{ ok: false, detail }`.
 */
export function parseLevel0ArrayMetadata(
  doc: unknown,
  url: string,
): { ok: true; metadata: Level0ArrayMetadata } | { ok: false; detail: string } {
  const parsed = zarrArrayMetadataSchema.safeParse(doc);
  if (!parsed.success) {
    return {
      ok: false,
      detail: `${url} failed zarrArrayMetadataSchema: ${parsed.error.issues[0]?.message ?? "unknown"}`,
    };
  }
  const attributes = parsed.data.attributes ?? {};
  const scaleParsed = z.array(z.number()).safeParse(attributes.scale);
  const offsetParsed = z.array(z.number()).safeParse(attributes.offset);
  if (!scaleParsed.success || !offsetParsed.success) {
    return {
      ok: false,
      detail: `${url} attributes carry no usable scale[]/offset[] number arrays`,
    };
  }
  return {
    ok: true,
    metadata: {
      dataType: parsed.data.data_type,
      codecs: parsed.data.codecs,
      scale: scaleParsed.data,
      offset: offsetParsed.data,
    },
  };
}

/**
 * Fetch (or read from cache) the level-0 array's `zarr.json` for one store
 * group. `dataBase` is the index's own `data_base` (never `contract_base` --
 * this goes straight to the origin the same way `render_overview`'s chunk
 * fetches do, not through the zarr sub-app). Every failure of the read itself
 * (network error, non-2xx, unreadable body, invalid JSON, a document that
 * fails `zarrArrayMetadataSchema`, or `attributes` missing a usable
 * `scale[]`/`offset[]`) is a typed `{ ok: false, detail }`, for the caller to
 * turn into its own tool error text. A `JsonCache` that throws is not caught
 * and can still throw, as before this code moved.
 */
export async function loadLevel0ArrayMetadata(opts: {
  fetcher: Fetcher;
  cache: JsonCache;
  datasetId: string;
  sourceCommit: string;
  /** D1's `zarr_converted_at`, part of the cache key: this entry holds the
   *  `scale[]`/`offset[]` a taste multiplies by, and a re-conversion can
   *  re-quantize at an unchanged commit. See `backend/src/mcp/projection-cache.ts`. */
  convertedAt: string | null;
  dataBase: string;
  zarr: string;
  group: string;
}): Promise<LoadLevel0ArrayMetadataResult> {
  const { fetcher, cache, datasetId, sourceCommit, convertedAt, dataBase, zarr, group } = opts;
  const commitUsable = SOURCE_COMMIT_RE.test(sourceCommit);
  const cacheKey: CacheKey | null = commitUsable
    ? { datasetId, sourceCommit, convertedAt, projection: `array/${zarr}/${group}/0` }
    : null;

  if (cacheKey) {
    const raw = await cache.get(cacheKey);
    if (raw !== undefined) {
      const cached = level0ArrayProjectionSchema.safeParse(raw);
      if (!cached.success) {
        console.warn(
          "[mcp] projection cache hit failed schema validation, treated as a miss",
          cacheKey,
        );
      } else {
        return {
          ok: true,
          metadata: {
            dataType: cached.data.dataType,
            // Safe: `zarrArrayMetadataSchema` already validated `codecs` once,
            // on the WRITE side, below; this cache entry is immutable per
            // `source_commit`, so nothing between here and there can have
            // changed its shape.
            codecs: cached.data.codecs as ZarrArrayMetadata["codecs"],
            scale: cached.data.scale,
            offset: cached.data.offset,
          },
          cacheStatus: "hit",
          upstreamBytes: 0,
        };
      }
    }
  }

  const url = `${dataBase}${level0ArrayMetadataKey(zarr, group)}`;
  let response: Response;
  try {
    response = await fetcher(url);
  } catch (err) {
    return {
      ok: false,
      detail: `network error fetching ${url}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!response.ok) {
    return { ok: false, detail: `HTTP ${response.status} fetching ${url}` };
  }
  // Prefer Content-Length when present, but never let its absence under-
  // report a real fetch as 0 bytes -- fall back to the actual decoded body
  // length, the same pattern `get-events.ts`'s tsv fallback already uses.
  const contentLengthHeader = response.headers.get("content-length");
  let text: string;
  try {
    text = await response.text();
  } catch (err) {
    return {
      ok: false,
      detail: `${url} could not be read as text: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const bytes = contentLengthHeader
    ? Number(contentLengthHeader)
    : new TextEncoder().encode(text).length;
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      detail: `${url} did not parse as JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const result = parseLevel0ArrayMetadata(doc, url);
  if (!result.ok) return result;
  const metadata = result.metadata;

  if (cacheKey) {
    cache.put(cacheKey, {
      dataType: metadata.dataType,
      codecs: metadata.codecs,
      scale: metadata.scale,
      offset: metadata.offset,
    });
  }

  return { ok: true, metadata, cacheStatus: "miss", upstreamBytes: bytes };
}
