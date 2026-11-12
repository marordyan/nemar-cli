import { z } from "zod";
import { fetchRangeBytes } from "./fetch-range.js";
import type { CacheKey, Fetcher, JsonCache } from "./interfaces.js";
import {
  type ShardIndexEntry,
  footerByteLength,
  parseShardFooter,
  shardEntriesFromPairs,
  shardEntriesToPairs,
} from "./sharding.js";

/** Cached shard-footer payload shape: `[offset, nbytes]` pairs, `[-1, -1]`
 *  meaning absent (`sharding.ts`'s `shardEntriesToPairs`/`shardEntriesFromPairs`).
 *  A pair that is NEITHER `[-1, -1]` NOR both non-negative (e.g. a corrupt
 *  `[-1, 240]`) fails this schema outright -- the whole cache entry is then
 *  treated as a miss rather than handing `shardEntriesFromPairs` a value it
 *  would otherwise trust blindly (`subarray` clamps a negative index rather
 *  than throwing). */
const shardIndexPairSchema = z
  .tuple([z.number(), z.number()])
  .refine(([offset, nbytes]) => (offset === -1 && nbytes === -1) || (offset >= 0 && nbytes >= 0), {
    message: "a shard-index pair must be [-1, -1] (absent) or both non-negative (present)",
  });
const shardIndexProjectionSchema = z.array(shardIndexPairSchema);

export interface ShardFooterLoaded {
  entries: ShardIndexEntry[];
  cacheStatus: "hit" | "miss";
  bytes: number;
}

/**
 * Load one shard's footer: from `cache` when a valid entry with exactly
 * `nInner` pairs is there, else one `Range` read of the shard's last
 * `footerByteLength(nInner)` bytes, written back to `cache`. A fetch or
 * footer-parse failure is a typed `{ error }`, for the caller to turn into its
 * own text; reading the response body and a `JsonCache` that throws
 * synchronously are not caught and can still throw, as before this code moved.
 *
 * `key` carries the dataset identity; the projection string
 * (`shardidx/<zarr>/<group>/0/<shard>`) is added here. Its `convertedAt` is
 * load-bearing above all: this entry holds parsed BYTE OFFSETS, replayed as
 * Range reads against whatever object lives at that key today. A
 * re-conversion at an unchanged commit (an engine bump, ADR 0033) would have
 * this replaying stale offsets into a new shard, and every 206 and length
 * check still passes because the origin returns exactly the bytes asked for
 * -- just the wrong ones.
 */
export async function loadShardFooter(opts: {
  fetcher: Fetcher;
  cache: JsonCache;
  key: Omit<CacheKey, "projection">;
  dataBase: string;
  zarr: string;
  groupName: string;
  shardIndex: number;
  nInner: number;
}): Promise<ShardFooterLoaded | { error: string; cause: "fetch" | "decode" }> {
  const { fetcher, cache, key, dataBase, zarr, groupName, shardIndex, nInner } = opts;
  const cacheKey: CacheKey = {
    ...key,
    projection: `shardidx/${zarr}/${groupName}/0/${shardIndex}`,
  };
  const raw = await cache.get(cacheKey);
  if (raw !== undefined) {
    const parsed = shardIndexProjectionSchema.safeParse(raw);
    if (!parsed.success) {
      console.warn(
        "[mcp] projection cache hit failed schema validation, treated as a miss",
        cacheKey,
      );
    } else if (parsed.data.length === nInner) {
      // The entry count is a CONSTANT for a given geometry (shard_samples /
      // chunk_samples), so a hit that does not carry exactly `nInner` pairs came
      // from a different geometry than this call computed. Treated as a miss --
      // re-read the footer -- rather than handed on: `planShardReads` would throw
      // "local index N has no footer entry" out of a path that otherwise produces
      // only typed tool errors.
      return {
        entries: shardEntriesFromPairs(parsed.data),
        cacheStatus: "hit",
        bytes: 0,
      };
    } else {
      console.warn(
        `[read_window] ${key.datasetId} ${zarr}/${groupName} shard ${shardIndex}: cached footer has ` +
          `${parsed.data.length} entries, expected ${nInner}; re-reading`,
      );
    }
  }

  const footerLen = footerByteLength(nInner);
  const url = `${dataBase}${zarr}/${groupName}/0/c/0/${shardIndex}`;
  const fetched = await fetchRangeBytes(fetcher, url, `bytes=-${footerLen}`, footerLen);
  if ("error" in fetched) {
    return { error: fetched.error, cause: "fetch" };
  }
  let entries: ShardIndexEntry[];
  try {
    entries = parseShardFooter(fetched.buf, nInner);
  } catch (err) {
    return {
      error: `shard footer ${url} failed to parse: ${err instanceof Error ? err.message : String(err)}`,
      cause: "decode",
    };
  }
  cache.put(cacheKey, shardEntriesToPairs(entries));
  return { entries, cacheStatus: "miss", bytes: fetched.buf.length };
}
