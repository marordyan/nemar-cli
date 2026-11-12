import type { DecodedSegment } from "./assemble.js";
import { decodeBloscZstdInt16 } from "./codecs/blosc.js";
import { fetchRangeBytes } from "./fetch-range.js";
import type { CacheKey, Fetcher, JsonCache } from "./interfaces.js";
import { loadShardFooter } from "./shard-footer.js";
import {
  type ChunkRead,
  type ShardIndexEntry,
  chunkSampleSpan,
  innerIndicesForWindowInShard,
  planShardReads,
  shardsForWindow,
} from "./sharding.js";

export type ReadLevel0WindowResult =
  | {
      ok: true;
      segments: DecodedSegment[];
      /** Bytes fetched from the origin (footers and chunks); cache hits cost 0. */
      bytes: number;
      chunksRead: number;
      /** True when every shard footer came from the cache. */
      footersAllHit: boolean;
    }
  | {
      ok: false;
      /** Which step failed: the shard footer, the read plan, or a chunk. */
      stage: "footer" | "plan" | "chunk";
      /** Why: the host could not be read as asked (a network error, a non-206 or a
       *  short body), the bytes read could not be decoded, or the footer disagrees
       *  with the geometry the index published (`plan`). Additive; the MCP ignores it. */
      cause: "fetch" | "decode" | "plan";
      detail: string;
    };

interface RangeReadResult {
  segments: DecodedSegment[];
  bytes: number;
}

/** Fetch and decode one coalesced `"range"` read -- one HTTP `Range` GET,
 *  possibly covering several inner chunks, sliced apart per {@link entries}'
 *  own recorded byte offsets and decoded individually. The decoded-length
 *  check asserts against `nChannelsInStore x chunkSamples` -- the NOMINAL
 *  stride every present chunk decodes to, never the chunk's truncated VALID
 *  span (`chunkSampleSpan`'s `end - start`), which is narrower than the
 *  stride for exactly one chunk per array (the final boundary one) and was
 *  the source of a real corruption bug (`sharding.ts`'s module doc). */
async function fetchAndDecodeRangeRead(opts: {
  fetcher: Fetcher;
  dataBase: string;
  zarr: string;
  groupName: string;
  shardIndex: number;
  read: Extract<ChunkRead, { kind: "range" }>;
  entries: ShardIndexEntry[];
  nChannelsInStore: number;
  shardSamples: number;
  chunkSamples: number;
  nSamplesTotal: number;
}): Promise<RangeReadResult | { error: string; cause: "fetch" | "decode" | "plan" }> {
  const {
    fetcher,
    dataBase,
    zarr,
    groupName,
    shardIndex,
    read,
    entries,
    nChannelsInStore,
    shardSamples,
    chunkSamples,
    nSamplesTotal,
  } = opts;
  const url = `${dataBase}${zarr}/${groupName}/0/c/0/${shardIndex}`;
  const expectedLength = read.end - read.start + 1;
  const fetched = await fetchRangeBytes(
    fetcher,
    url,
    `bytes=${read.start}-${read.end}`,
    expectedLength,
  );
  if ("error" in fetched) {
    return { error: fetched.error, cause: "fetch" };
  }
  const buf = fetched.buf;
  const runStart = read.start;
  const segments: DecodedSegment[] = [];
  for (const localIndex of read.localIndices) {
    const entry = entries[localIndex];
    if (!entry?.present) {
      // planShardReads only ever puts a PRESENT entry's local index into a
      // "range" read's localIndices -- reaching here with an absent one
      // would be a caller/planner bug, not a data condition.
      return {
        error: `shard ${shardIndex} chunk ${localIndex}: footer entry is not present`,
        cause: "plan",
      };
    }
    const relStart = entry.offset - runStart;
    const chunkBytes = buf.subarray(relStart, relStart + entry.nbytes);
    let decoded: Int16Array;
    try {
      decoded = decodeBloscZstdInt16(chunkBytes);
    } catch (err) {
      return {
        error: `shard ${shardIndex} chunk ${localIndex} failed to decode: ${err instanceof Error ? err.message : String(err)}`,
        cause: "decode",
      };
    }
    const expectedLen = nChannelsInStore * chunkSamples;
    if (decoded.length !== expectedLen) {
      return {
        error:
          `shard ${shardIndex} chunk ${localIndex} decoded to ${decoded.length} values, expected ` +
          `${expectedLen} (${nChannelsInStore} channels x ${chunkSamples} chunk_samples)`,
        cause: "decode",
      };
    }
    const span = chunkSampleSpan({
      shardIndex,
      localIndex,
      shardSamples,
      chunkSamples,
      nSamples: nSamplesTotal,
    });
    segments.push({ start: span.start, end: span.end, stride: chunkSamples, data: decoded });
  }
  return { segments, bytes: buf.length };
}

/**
 * Read every inner chunk of level 0 that `[startSample, endSampleExclusive)`
 * touches: per shard the footer (cached through `cache`), the read plan, and
 * one fetch-and-decode per coalesced range. Absent chunks become `data: null`
 * segments. A fetch, footer-parse, decode or plan failure is a typed
 * `{ ok: false, stage, detail }`, for the caller to turn into its own text;
 * what is not caught (reading a response body, the window helpers, a
 * `JsonCache` that throws synchronously) can still throw, as it did before
 * this code moved. Request order is the footer, then that shard's chunks,
 * shard by shard.
 */
export async function readLevel0Window(opts: {
  fetcher: Fetcher;
  cache: JsonCache;
  /** Dataset identity for the footer cache entries; the projection is added
   *  by {@link loadShardFooter}. */
  key: Omit<CacheKey, "projection">;
  dataBase: string;
  zarr: string;
  groupName: string;
  shardSamples: number;
  chunkSamples: number;
  /** Footer entries per shard, `nInnerForShard({ shardSamples, chunkSamples })`. */
  nInner: number;
  nChannelsInStore: number;
  /** The array's total sample count (bounds the final boundary chunk). */
  nSamplesTotal: number;
  startSample: number;
  endSampleExclusive: number;
}): Promise<ReadLevel0WindowResult> {
  const {
    fetcher,
    cache,
    key,
    dataBase,
    zarr,
    groupName,
    shardSamples,
    chunkSamples,
    nInner,
    nChannelsInStore,
    nSamplesTotal,
    startSample,
    endSampleExclusive,
  } = opts;
  let footersAllHit = true;
  let bytes = 0;
  let chunksRead = 0;
  const segments: DecodedSegment[] = [];

  const shardIndices = shardsForWindow({ startSample, endSampleExclusive, shardSamples });
  for (const shardIndex of shardIndices) {
    const footer = await loadShardFooter({
      fetcher,
      cache,
      key,
      dataBase,
      zarr,
      groupName,
      shardIndex,
      nInner,
    });
    if ("error" in footer) {
      return { ok: false, stage: "footer", cause: footer.cause, detail: footer.error };
    }
    footersAllHit = footersAllHit && footer.cacheStatus === "hit";
    bytes += footer.bytes;

    const localIndices = innerIndicesForWindowInShard({
      shardIndex,
      shardSamples,
      chunkSamples,
      nInnerThisShard: nInner,
      startSample,
      endSampleExclusive,
    });
    // Also wrapped: it throws when the footer has no entry for a planned local
    // index, which after the count check above means the footer disagrees with
    // the geometry the index published.
    let reads: ReturnType<typeof planShardReads>;
    try {
      reads = planShardReads(footer.entries, localIndices);
    } catch (err) {
      return {
        ok: false,
        stage: "plan",
        cause: "plan",
        detail: err instanceof Error ? err.message : String(err),
      };
    }
    for (const read of reads) {
      if (read.kind === "absent") {
        const span = chunkSampleSpan({
          shardIndex,
          localIndex: read.localIndex,
          shardSamples,
          chunkSamples,
          nSamples: nSamplesTotal,
        });
        segments.push({ start: span.start, end: span.end, stride: chunkSamples, data: null });
        continue;
      }
      const fetched = await fetchAndDecodeRangeRead({
        fetcher,
        dataBase,
        zarr,
        groupName,
        shardIndex,
        read,
        entries: footer.entries,
        nChannelsInStore,
        shardSamples,
        chunkSamples,
        nSamplesTotal,
      });
      if ("error" in fetched) {
        return { ok: false, stage: "chunk", cause: fetched.cause, detail: fetched.error };
      }
      segments.push(...fetched.segments);
      bytes += fetched.bytes;
      chunksRead += read.localIndices.length;
    }
  }
  return { ok: true, segments, bytes, chunksRead, footersAllHit };
}
