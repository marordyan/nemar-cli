/**
 * Pure tests for `shared/zarr/sharding.ts` (epic #1065 phase 4, issue
 * #1296). No I/O -- these are footer arithmetic, footer parsing, and window
 * planning only.
 *
 * TWO real footers are committed and parsed here, both captured live and
 * unmodified from the same array (nm000329's `sub-1` store, `eeg_250hz`,
 * shape [63, 138750], shard_samples 75000, chunk_samples 1000):
 *
 *   BASE=https://nemar.s3.us-east-2.amazonaws.com/nm000329/zarr/sub-1/ses-0/eeg/sub-1_ses-0_task-imagery_acq-calibration_run-0_eeg.zarr/eeg_250hz/0
 *   for J in 0 1; do
 *     curl -s -A "nemar-cli/mcp-phase4" -H "Range: bytes=-1204" \
 *       -o backend/test/fixtures/mcp/nm000329-shard-index-c-0-$J.bin "$BASE/c/0/$J"
 *   done
 *
 * `c/0/0` is a FULL shard: 75 entries, all present, `Content-Length`
 * 8,970,760, confirmed below via `sum(nbytes) + 1204`.
 *
 * `c/0/1` is the BOUNDARY shard, and it is the one that matters most. It
 * covers nominal samples [75000, 150000) while the array really ends at
 * 138750, and it carries the SAME 75 entries -- 64 present, 11 absent --
 * because a shard's entry count is a property of the chunk grid, not of how
 * much real data lands in that shard. Its `Content-Length` is 7,651,790,
 * confirmed via `sum(nbytes) + 1204`. Reading it with an entry count derived
 * from the remaining extent (`ceil(63750/1000) = 64`) is the defect this
 * fixture exists to pin: the reader would take the last 1028 bytes instead of
 * 1204, beginning 11 entries into the true footer, and every chunk it served
 * from this shard would be 11,000 samples (44 s) later than asked for, with
 * nothing erroring.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  SHARD_ABSENT_MARKER,
  type ShardIndexEntry,
  chunkSampleSpan,
  footerByteLength,
  innerIndicesForWindowInShard,
  nInnerForShard,
  parseShardFooter,
  planShardReads,
  shardEntriesFromPairs,
  shardEntriesToPairs,
  shardsForWindow,
} from "../../shared/zarr/sharding.js";

describe("footerByteLength", () => {
  test("n_inner * 16 + 4", () => {
    expect(footerByteLength(75)).toBe(75 * 16 + 4);
    expect(footerByteLength(1)).toBe(20);
  });

  test("refuses a non-positive or non-integer nInner", () => {
    expect(() => footerByteLength(0)).toThrow();
    expect(() => footerByteLength(-1)).toThrow();
    expect(() => footerByteLength(1.5)).toThrow();
  });
});

describe("nInnerForShard", () => {
  // nm000329 eeg_250hz: shape [63, 138750], shard_samples 75000, chunk_samples 1000.
  const NM000329 = { shardSamples: 75000, chunkSamples: 1000 };

  test("shard_samples / chunk_samples, for every shard of the array", () => {
    expect(nInnerForShard(NM000329)).toBe(75);
  });

  test("takes no shard index and no nSamples: nothing about a shard can change it", () => {
    // A regression guard on the SIGNATURE, not just the arithmetic. The bug
    // this replaces computed ceil(min(shardSamples, nSamples - shardStart) /
    // chunkSamples), which returns 64 for nm000329's boundary shard 1 -- see
    // the real-shard-1 footer test below for what that misread does. Passing
    // extra keys is harmless at runtime; what matters is that the function
    // cannot consult them, so no caller can reintroduce a per-shard count.
    expect(nInnerForShard.length).toBe(1);
    const withNoise = { ...NM000329, shardIndex: 1, nSamples: 138750 } as Parameters<
      typeof nInnerForShard
    >[0];
    expect(nInnerForShard(withNoise)).toBe(75);
  });

  test("the synthetic fixture geometry: 4000/1000 = 4 entries per shard", () => {
    expect(nInnerForShard({ shardSamples: 4000, chunkSamples: 1000 })).toBe(4);
  });

  test("throws when shard_samples is not an exact multiple of chunk_samples", () => {
    // A non-integer result means the index document misdescribes the array,
    // which is worth raising loudly rather than silently flooring.
    expect(() => nInnerForShard({ shardSamples: 4500, chunkSamples: 1000 })).toThrow(
      /not an exact multiple/,
    );
  });
});

describe("parseShardFooter against the REAL captured nm000329 BOUNDARY shard footer", () => {
  // This is the test that pins the defect. `c/0/1` is the LAST shard of
  // nm000329's eeg_250hz level-0 array: it covers nominal samples [75000,
  // 150000) while the array really ends at 138750, so only 63750 samples of
  // it are real. Captured live and unmodified:
  //
  //   curl -s -A "nemar-cli/mcp-phase4" -H "Range: bytes=-1204" \
  //     -o backend/test/fixtures/mcp/nm000329-shard-index-c-0-1.bin \
  //     "https://nemar.s3.us-east-2.amazonaws.com/nm000329/zarr/sub-1/ses-0/eeg/sub-1_ses-0_task-imagery_acq-calibration_run-0_eeg.zarr/eeg_250hz/0/c/0/1"
  //
  // The shard's own Content-Length is 7,651,790 (captured 2026-09-08).
  const bytes = new Uint8Array(
    readFileSync(new URL("./fixtures/mcp/nm000329-shard-index-c-0-1.bin", import.meta.url)),
  );
  const N_INNER = nInnerForShard({ shardSamples: 75000, chunkSamples: 1000 });
  const SHARD_CONTENT_LENGTH = 7_651_790;

  test("the boundary shard's footer carries the SAME 75 entries as a full shard", () => {
    // The whole defect in one assertion: an entry count derived from the
    // remaining extent would be ceil(63750/1000) = 64, so the reader would
    // Range-read footerByteLength(64) = 1028 bytes instead of 1204. That
    // slice begins 176 bytes -- exactly 11 entries -- into the real footer,
    // so every local index it parsed was the wrong entry, shifted by 11
    // chunks (11,000 samples, 44 s at 250 Hz), and nothing errored because
    // every misread entry still pointed at a real, full-size, cleanly
    // decoding chunk.
    expect(N_INNER).toBe(75);
    expect(bytes.byteLength).toBe(footerByteLength(75));
    expect(bytes.byteLength).toBe(1204);
    expect(() => parseShardFooter(bytes, 64)).toThrow();
  });

  test("64 present entries, 11 absent, in that order", () => {
    const entries = parseShardFooter(bytes, N_INNER);
    expect(entries.length).toBe(75);
    const presentCount = entries.filter((e) => e.present).length;
    expect(presentCount).toBe(64);
    // 75000 + 64 * 1000 == 139000 > 138750: local index 63 is the last one
    // holding real data, and 64 through 74 lie wholly past the array's
    // extent, so the producer marks them absent rather than omitting them.
    expect(entries.slice(0, 64).every((e) => e.present)).toBe(true);
    expect(entries.slice(64).every((e) => !e.present)).toBe(true);
  });

  test("present offsets chain contiguously from 0 and sum to the real object size", () => {
    const entries = parseShardFooter(bytes, N_INNER);
    let expected = 0;
    let total = 0;
    for (const entry of entries) {
      if (!entry.present) continue;
      expect(entry.offset).toBe(expected);
      expected = entry.offset + entry.nbytes;
      total += entry.nbytes;
    }
    expect(total).toBe(7_650_586);
    expect(total + bytes.byteLength).toBe(SHARD_CONTENT_LENGTH);
  });

  test("the final present entry is the straddling boundary chunk, stored FULL SIZE", () => {
    const entries = parseShardFooter(bytes, N_INNER);
    const last = entries[63];
    if (!last.present) throw new Error("local index 63 must be present");
    expect(last.offset).toBe(7_560_477);
    expect(last.nbytes).toBe(90_109);
    // Nominally [138000, 139000), really only [138000, 138750) -- 750
    // samples. Fetching these exact bytes and decoding them returns 63,000
    // values (63 channels x 1000 columns), NOT 63 x 750: Zarr stores a
    // straddling chunk full size and fill-pads it. That is why a decoded
    // segment's STRIDE and its VALID SPAN are separate quantities in
    // `taste.ts`'s DecodedSegment.
    expect(
      chunkSampleSpan({
        shardIndex: 1,
        localIndex: 63,
        shardSamples: 75000,
        chunkSamples: 1000,
        nSamples: 138750,
      }),
    ).toEqual({ start: 138000, end: 138750 });
  });
});

describe("parseShardFooter against the REAL captured nm000329 footer", () => {
  const bytes = new Uint8Array(
    readFileSync(new URL("./fixtures/mcp/nm000329-shard-index-c-0-0.bin", import.meta.url)),
  );

  test("the fixture is exactly 1204 bytes (75 entries)", () => {
    expect(bytes.length).toBe(1204);
    expect(footerByteLength(75)).toBe(1204);
  });

  test("parses to exactly 75 entries, all present", () => {
    const entries = parseShardFooter(bytes, 75);
    expect(entries.length).toBe(75);
    expect(entries.every((e) => e.present)).toBe(true);
  });

  test("offsets chain contiguously from 0", () => {
    const entries = parseShardFooter(bytes, 75);
    expect(entries[0].offset).toBe(0);
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i].offset).toBe(entries[i - 1].offset + entries[i - 1].nbytes);
    }
  });

  test("sum(nbytes) + 1204 == 8_970_760, the shard's real Content-Length", () => {
    const entries = parseShardFooter(bytes, 75);
    const totalNbytes = entries.reduce((sum, e) => sum + e.nbytes, 0);
    expect(totalNbytes).toBe(8_969_556);
    expect(totalNbytes + 1204).toBe(8_970_760);
  });

  test("the first entry is offset 0, nbytes 119327 (the chunk render_overview's precedent decodes)", () => {
    const entries = parseShardFooter(bytes, 75);
    expect(entries[0]).toEqual({ present: true, offset: 0, nbytes: 119327 });
  });

  test("refuses a byte length that does not match footerByteLength(nInner)", () => {
    expect(() => parseShardFooter(bytes, 74)).toThrow();
    expect(() => parseShardFooter(bytes, 76)).toThrow();
    expect(() => parseShardFooter(bytes.slice(1), 75)).toThrow();
  });
});

describe("parseShardFooter: the 2^64 - 1 absent marker", () => {
  function buildFooter(entries: Array<{ offset: bigint; nbytes: bigint }>): Uint8Array {
    const out = new Uint8Array(entries.length * 16 + 4);
    const view = new DataView(out.buffer);
    entries.forEach((e, i) => {
      view.setBigUint64(i * 16, e.offset, true);
      view.setBigUint64(i * 16 + 8, e.nbytes, true);
    });
    return out; // trailing 4 bytes (crc32c) left as zero -- never verified
  }

  test("an entry marked 2^64 - 1 in both fields parses as absent", () => {
    const bytes = buildFooter([
      { offset: 0n, nbytes: 100n },
      { offset: SHARD_ABSENT_MARKER, nbytes: SHARD_ABSENT_MARKER },
      { offset: 100n, nbytes: 50n },
    ]);
    const entries = parseShardFooter(bytes, 3);
    expect(entries[0]).toEqual({ present: true, offset: 0, nbytes: 100 });
    expect(entries[1].present).toBe(false);
    expect(entries[2]).toEqual({ present: true, offset: 100, nbytes: 50 });
  });

  test("a marker in only ONE of the two fields is still treated as absent (defensive)", () => {
    const bytes = buildFooter([{ offset: SHARD_ABSENT_MARKER, nbytes: 0n }]);
    const entries = parseShardFooter(bytes, 1);
    expect(entries[0].present).toBe(false);
  });
});

describe("shardsForWindow", () => {
  const SHARD_SAMPLES = 75000;

  test("a window inside one shard", () => {
    expect(
      shardsForWindow({ startSample: 1000, endSampleExclusive: 2000, shardSamples: SHARD_SAMPLES }),
    ).toEqual([0]);
  });

  test("a window spanning two shards", () => {
    expect(
      shardsForWindow({
        startSample: 74000,
        endSampleExclusive: 76000,
        shardSamples: SHARD_SAMPLES,
      }),
    ).toEqual([0, 1]);
  });

  test("a window ending exactly on a shard boundary excludes the next shard", () => {
    expect(
      shardsForWindow({
        startSample: 70000,
        endSampleExclusive: 75000,
        shardSamples: SHARD_SAMPLES,
      }),
    ).toEqual([0]);
  });

  test("a window starting exactly on a shard boundary excludes the previous shard", () => {
    expect(
      shardsForWindow({
        startSample: 75000,
        endSampleExclusive: 76000,
        shardSamples: SHARD_SAMPLES,
      }),
    ).toEqual([1]);
  });

  test("an empty (end <= start) window spans no shards", () => {
    expect(
      shardsForWindow({ startSample: 1000, endSampleExclusive: 1000, shardSamples: SHARD_SAMPLES }),
    ).toEqual([]);
  });
});

describe("innerIndicesForWindowInShard", () => {
  const BASE = { shardIndex: 0, shardSamples: 75000, chunkSamples: 1000, nInnerThisShard: 75 };

  test("a window inside one chunk", () => {
    expect(
      innerIndicesForWindowInShard({ ...BASE, startSample: 1500, endSampleExclusive: 1800 }),
    ).toEqual([1]);
  });

  test("a window spanning two chunks", () => {
    expect(
      innerIndicesForWindowInShard({ ...BASE, startSample: 1500, endSampleExclusive: 2500 }),
    ).toEqual([1, 2]);
  });

  test("a window ending exactly on a chunk boundary does not pull in the next chunk", () => {
    expect(
      innerIndicesForWindowInShard({ ...BASE, startSample: 1000, endSampleExclusive: 2000 }),
    ).toEqual([1]);
  });

  test("a window starting exactly on a chunk boundary does not pull in the previous chunk", () => {
    expect(
      innerIndicesForWindowInShard({ ...BASE, startSample: 2000, endSampleExclusive: 2500 }),
    ).toEqual([2]);
  });

  test("a shard-relative window (shardIndex 1) offsets correctly", () => {
    expect(
      innerIndicesForWindowInShard({
        shardIndex: 1,
        shardSamples: 75000,
        chunkSamples: 1000,
        nInnerThisShard: 64,
        startSample: 75500,
        endSampleExclusive: 76500,
      }),
    ).toEqual([0, 1]);
  });
});

describe("chunkSampleSpan", () => {
  test("a mid-array chunk spans a full chunkSamples", () => {
    expect(
      chunkSampleSpan({
        shardIndex: 0,
        localIndex: 2,
        shardSamples: 75000,
        chunkSamples: 1000,
        nSamples: 138750,
      }),
    ).toEqual({ start: 2000, end: 3000 });
  });

  test("the boundary chunk of the boundary shard is truncated to the array's real extent", () => {
    // nm000329: shard 1 (starts at 75000) has 64 inner chunks; the last
    // (local index 63) covers [75000 + 63000, 138750) = [138000, 138750),
    // 750 samples -- not a full 1000.
    expect(
      chunkSampleSpan({
        shardIndex: 1,
        localIndex: 63,
        shardSamples: 75000,
        chunkSamples: 1000,
        nSamples: 138750,
      }),
    ).toEqual({ start: 138000, end: 138750 });
  });
});

describe("planShardReads: coalescing", () => {
  function present(offset: number, nbytes: number): ShardIndexEntry {
    return { offset, nbytes, present: true };
  }
  const absent: ShardIndexEntry = { present: false };

  test("a run of byte-adjacent, index-consecutive present entries coalesces into one range read", () => {
    const entries = [present(0, 100), present(100, 50), present(150, 75)];
    const reads = planShardReads(entries, [0, 1, 2]);
    expect(reads).toEqual([{ kind: "range", localIndices: [0, 1, 2], start: 0, end: 224 }]);
  });

  test("non-adjacent present entries (a gap in wanted indices) are NOT coalesced", () => {
    const entries = [present(0, 100), present(100, 50), present(150, 75), present(225, 40)];
    // Only local indices 0 and 3 are wanted -- not index-consecutive, so two reads.
    const reads = planShardReads(entries, [0, 3]);
    expect(reads).toEqual([
      { kind: "range", localIndices: [0], start: 0, end: 99 },
      { kind: "range", localIndices: [3], start: 225, end: 264 },
    ]);
  });

  test("an absent entry breaks a run and is its own kind: 'absent' read with no byte range", () => {
    const entries = [present(0, 100), absent, present(100, 50)];
    const reads = planShardReads(entries, [0, 1, 2]);
    expect(reads).toEqual([
      { kind: "range", localIndices: [0], start: 0, end: 99 },
      { kind: "absent", localIndex: 1 },
      { kind: "range", localIndices: [2], start: 100, end: 149 },
    ]);
  });

  test("index-consecutive but byte-NON-adjacent present entries do not coalesce (defensive)", () => {
    // Real shards chain contiguously (verified above), but the planner must
    // not assume it -- a gap in the byte offsets must still split the read.
    const entries = [present(0, 100), present(200, 50)];
    const reads = planShardReads(entries, [0, 1]);
    expect(reads).toEqual([
      { kind: "range", localIndices: [0], start: 0, end: 99 },
      { kind: "range", localIndices: [1], start: 200, end: 249 },
    ]);
  });

  test("wanted indices need not be sorted or deduplicated", () => {
    const entries = [present(0, 100), present(100, 50)];
    const reads = planShardReads(entries, [1, 0, 1, 0]);
    expect(reads).toEqual([{ kind: "range", localIndices: [0, 1], start: 0, end: 149 }]);
  });

  test("the real 75-entry nm000329 footer coalesces into ONE read end to end", () => {
    const bytes = new Uint8Array(
      readFileSync(new URL("./fixtures/mcp/nm000329-shard-index-c-0-0.bin", import.meta.url)),
    );
    const entries = parseShardFooter(bytes, 75);
    const reads = planShardReads(
      entries,
      Array.from({ length: 75 }, (_, i) => i),
    );
    expect(reads.length).toBe(1);
    expect(reads[0]).toEqual({
      kind: "range",
      localIndices: Array.from({ length: 75 }, (_, i) => i),
      start: 0,
      end: 8_969_555,
    });
  });

  test("throws when a wanted local index has no footer entry", () => {
    const entries = [present(0, 100)];
    expect(() => planShardReads(entries, [5])).toThrow();
  });
});

describe("shardEntriesToPairs / shardEntriesFromPairs (cache serialization)", () => {
  test("round-trips present and absent entries", () => {
    const entries: ShardIndexEntry[] = [
      { present: true, offset: 0, nbytes: 100 },
      { present: false },
      { present: true, offset: 100, nbytes: 50 },
    ];
    const pairs = shardEntriesToPairs(entries);
    expect(pairs).toEqual([
      [0, 100],
      [-1, -1],
      [100, 50],
    ]);
    expect(shardEntriesFromPairs(pairs)).toEqual(entries);
  });

  test("the real 75-entry nm000329 footer round-trips through pairs unchanged", () => {
    const bytes = new Uint8Array(
      readFileSync(new URL("./fixtures/mcp/nm000329-shard-index-c-0-0.bin", import.meta.url)),
    );
    const entries = parseShardFooter(bytes, 75);
    expect(shardEntriesFromPairs(shardEntriesToPairs(entries))).toEqual(entries);
  });
});
