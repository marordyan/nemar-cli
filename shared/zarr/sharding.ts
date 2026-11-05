/**
 * Pure Zarr v3 `sharding_indexed` planning for `read_window` taste mode
 * (epic #1065 phase 4, issue #1296).
 *
 * Level 0 of every served store is a SHARDED array: shape `[n_channels,
 * n_samples]`, outer chunk (the "shard") `[n_channels, shard_samples]`,
 * inner chunk (the codec's own `sharding_indexed.configuration.chunk_shape`)
 * `[n_channels, chunk_samples]`, `index_location: "end"`. `shard_samples`/
 * `chunk_samples` are per-STORE properties (read from the specific store's
 * own group entry, `targetGroup.shard_samples` in `read-window.ts` -- never
 * hardcoded or assumed constant across a dataset or group name): verified
 * live on nm000329's `sub-1` store `eeg_250hz` group (shard 75000, chunk
 * 1000) and on003392's `sub-06` store `meg_250hz` group (shard 68000, chunk
 * 1000) -- see `test/fixtures/zarr-array-level0.zarr.json` and
 * `backend/test/fixtures/mcp/nm000329-shard-index-c-0-0.bin`/
 * `nm000329-shard-index-c-0-1.bin` (REAL captured footers, both stores'
 * own shards). A DIFFERENT on003392 store (`sub-01`, the one
 * `test/fixtures/zarr-index-on003392-meg-sss-slice.json` captures) reports
 * `shard_samples: 69000` for the identical group NAME at the identical
 * `source_commit` -- both numbers are real; they are simply two different
 * stores' own values, which is exactly why this code reads the figure per
 * store rather than assuming one number for a whole dataset or group name.
 *
 * **Those two stores are samples, not the shape of the archive.** Measured
 * across all 314 v3 indexes and 90,966 groups (`bun run zarr:geometry-check`,
 * `backend/scripts/zarr-geometry-conformance.ts`, 2026-09-09): `chunk_samples`
 * takes 33 distinct values (1000 on 76,775 groups, but also 4000, 800, 640,
 * 512, 400, 2048, 250, down to 10) and `shard_samples` takes 256, from 2000 to
 * 300,000; the widest store is 415 channels, not the 320 of the sample above.
 * Nothing here may treat any of those as a constant. The ONE geometric fact
 * that is universal is the divisibility invariant {@link nInnerForShard}
 * enforces, and it is universal because it was checked, not because it was
 * assumed: 0 violations in those 90,966 groups. Re-run that script rather than
 * trusting this paragraph if the converter's chunking ever changes.
 *
 * An inner chunk always spans every channel, so the chunk grid is always
 * `1 x ceil(n_samples / shard_samples)` and a shard's object key is always
 * `<zarr>/<group>/0/c/0/<j>` -- a taste of one channel still decodes every
 * channel of every inner chunk the window spans. Cost is driven by DURATION
 * (how many inner chunks) and the store's own channel count, never by how
 * many channels the caller asked for.
 *
 * **A shard's footer entry count is CONSTANT across every shard of the
 * array, including the final (boundary) one -- it is `shard_samples /
 * chunk_samples`, full stop, never a function of how many samples actually
 * fall inside that shard.** This was gotten wrong in an earlier version of
 * this file (`nInnerForShard` computed `ceil(min(shardSamples, remaining) /
 * chunkSamples)`, which is SMALLER for a boundary shard) and caught only by
 * checking the REAL captured footer for nm000329's shard 1 (`c/0/1`, not
 * just `c/0/0`): its `Content-Length` is 7,651,790; the real 1204-byte
 * footer parses to 75 entries -- the SAME 75 as the non-boundary shard 0 --
 * with local indices 0-63 present (offsets chaining contiguously from 0,
 * `sum(nbytes) == 7_650_586`) and 64-74 marked absent (`2^64 - 1` in both
 * fields, per the spec: a chunk entirely past the array's real extent is
 * absent, not omitted from the index). The old formula computed `nInner =
 * 64` for this shard, so it Range-read only the LAST 1028 bytes of the
 * footer (`footerByteLength(64)`) instead of the real 1204 -- a slice that
 * starts 176 bytes (11 entries) into the true footer, so every local index
 * it parsed was the WRONG entry, shifted by 11 chunks (44 s at 250 Hz).
 * Nothing errored: every misread entry still pointed at a real, full-size,
 * cleanly-decoding chunk, so the caller got plausible-looking signal from
 * the wrong point in the recording. `nInnerForShard` below computes the
 * constant directly from `shard_samples`/`chunk_samples` and does not take
 * `nSamples` (or even a shard index) as an argument at all -- there is
 * nothing about a specific shard that could change the answer.
 *
 * The shard footer is the last `n_inner * 16 + 4` bytes: `n_inner` pairs of
 * little-endian uint64 `(offset, nbytes)` (each pair's `offset` is a byte
 * offset INTO THE SHARD OBJECT, so PRESENT entries chain contiguously from
 * 0) plus a trailing crc32c word -- this module never verifies that
 * checksum, only strips it. An absent inner chunk is marked `2^64 - 1` in
 * BOTH fields (`SHARD_ABSENT_MARKER`) and contributes no bytes to the shard
 * at all -- the byte offsets of the entries around it simply do not advance
 * for it.
 *
 * A PRESENT boundary chunk (a chunk whose nominal span crosses the array's
 * real `n_samples`) is still stored FULL SIZE (`chunk_samples` columns wide)
 * and fill-padded past the array's real extent -- Zarr never emits a
 * narrower chunk. Verified against nm000329 shard 1's own final present
 * entry (local index 63, footer offset 7,560,477, nbytes 90,109, nominally
 * covering samples [138000, 139000) though only [138000, 138750) is real):
 * `decodeBloscZstdInt16` on those exact bytes returns 63,000 values (63 x
 * 1000), not 63 x 750. `chunkSampleSpan` below reports the chunk's VALID
 * span (truncated at `n_samples`) SEPARATELY from its decoded STRIDE
 * (always `chunk_samples`) for exactly this reason -- see `taste.ts`'s
 * `DecodedSegment` doc for the conflation this separation prevents.
 *
 * No I/O in this file -- `read-window.ts` does the fetching and decoding;
 * this file only computes which shards, which local chunk indices, and
 * which byte ranges to ask for.
 */

/** Both fields of an absent inner-chunk footer entry, per the Zarr v3
 *  `sharding_indexed` spec. `Number(SHARD_ABSENT_MARKER)` would lose
 *  precision (2^64 - 1 is far past `Number.MAX_SAFE_INTEGER`), so the
 *  comparison against a parsed `bigint` stays a `bigint` comparison; nothing
 *  downstream of {@link parseShardFooter} ever sees this value as a Number. */
export const SHARD_ABSENT_MARKER = 0xffffffffffffffffn;

/** A discriminated union rather than a flat `{ offset, nbytes, present }`
 *  shape: `{ offset: 500, nbytes: 200, present: false }` used to typecheck,
 *  which made "check `present` before trusting `offset`" a comment rather
 *  than a rule the compiler enforces. Reading `.offset` off an unnarrowed
 *  entry is now a compile error. */
export type ShardIndexEntry =
  | { present: true; offset: number; nbytes: number }
  | { present: false };

/** `n_inner * 16 + 4`: `n_inner` `(offset, nbytes)` uint64 pairs (16 bytes
 *  each) plus the trailing crc32c word. */
export function footerByteLength(nInner: number): number {
  if (!Number.isInteger(nInner) || nInner < 1) {
    throw new Error(`footerByteLength: nInner must be a positive integer, got ${nInner}`);
  }
  return nInner * 16 + 4;
}

/** How many inner-chunk entries a shard's footer carries -- CONSTANT across
 *  every shard of the array (`shard_samples / chunk_samples`), including
 *  the final (boundary) one. Deliberately takes neither a shard index nor
 *  `nSamples`: nothing about which shard, or the array's real extent,
 *  changes this count -- a chunk beyond the array's real data is still an
 *  ENTRY in the footer, just one marked absent. Throws if `shard_samples`
 *  is not an exact multiple of `chunk_samples`: every store measured
 *  divides evenly (75000/1000, 68000/1000, 69000/1000, 4000/1000), so a
 *  non-integer result means the index document misdescribes the array,
 *  which is worth raising loudly rather than silently flooring. */
export function nInnerForShard(opts: { shardSamples: number; chunkSamples: number }): number {
  const { shardSamples, chunkSamples } = opts;
  if (shardSamples % chunkSamples !== 0) {
    throw new Error(
      `nInnerForShard: shard_samples ${shardSamples} is not an exact multiple of chunk_samples ${chunkSamples} -- the index misdescribes the array`,
    );
  }
  return shardSamples / chunkSamples;
}

/**
 * Parse a shard's footer bytes (exactly {@link footerByteLength}`(nInner)`
 * long -- the tail of the shard object) into `nInner` entries in local
 * chunk-index order. The trailing 4-byte crc32c word is stripped, never
 * verified (per the module doc).
 */
export function parseShardFooter(bytes: Uint8Array, nInner: number): ShardIndexEntry[] {
  const expected = footerByteLength(nInner);
  if (bytes.length !== expected) {
    throw new Error(
      `parseShardFooter: expected exactly ${expected} bytes for nInner ${nInner}, got ${bytes.length}`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries: ShardIndexEntry[] = [];
  for (let i = 0; i < nInner; i++) {
    const offsetBig = view.getBigUint64(i * 16, true);
    const nbytesBig = view.getBigUint64(i * 16 + 8, true);
    const present = offsetBig !== SHARD_ABSENT_MARKER && nbytesBig !== SHARD_ABSENT_MARKER;
    entries.push(
      present
        ? { present: true, offset: Number(offsetBig), nbytes: Number(nbytesBig) }
        : { present: false },
    );
  }
  return entries;
}

/** Which shard (outer chunk) indices `[startSample, endSampleExclusive)`
 *  spans, ascending. Half-open: a window ending exactly on a shard boundary
 *  never includes the next shard. Named-object parameters -- three
 *  positional sample-index/length numbers is exactly the shape a future
 *  call site could transpose and still compile clean. */
export function shardsForWindow(opts: {
  startSample: number;
  endSampleExclusive: number;
  shardSamples: number;
}): number[] {
  const { startSample, endSampleExclusive, shardSamples } = opts;
  if (endSampleExclusive <= startSample) return [];
  const first = Math.floor(startSample / shardSamples);
  const last = Math.floor((endSampleExclusive - 1) / shardSamples);
  const out: number[] = [];
  for (let j = first; j <= last; j++) out.push(j);
  return out;
}

/** Which LOCAL inner-chunk indices (0-based within one shard) a window
 *  intersects, ascending. Half-open on both the window and each candidate
 *  chunk's own NOMINAL span (`chunkSamples` wide, regardless of whether the
 *  array's real extent truncates its valid data), so a window ending
 *  exactly on a chunk boundary never pulls in the next chunk, and a window
 *  reaching the array's real end correctly still selects a boundary chunk
 *  by its full nominal footprint. */
export function innerIndicesForWindowInShard(opts: {
  shardIndex: number;
  shardSamples: number;
  chunkSamples: number;
  nInnerThisShard: number;
  startSample: number;
  endSampleExclusive: number;
}): number[] {
  const {
    shardIndex,
    shardSamples,
    chunkSamples,
    nInnerThisShard,
    startSample,
    endSampleExclusive,
  } = opts;
  const shardStart = shardIndex * shardSamples;
  const out: number[] = [];
  for (let local = 0; local < nInnerThisShard; local++) {
    const chunkStart = shardStart + local * chunkSamples;
    const chunkEnd = chunkStart + chunkSamples; // nominal, always chunkSamples wide
    if (chunkStart < endSampleExclusive && chunkEnd > startSample) out.push(local);
  }
  return out;
}

/** The VALID sample span (global, half-open) one local inner-chunk index
 *  covers -- truncated at the array's actual `nSamples`, correct for a
 *  mid-array absent chunk (full `chunkSamples` nominal span) and a boundary
 *  chunk alike. This is NOT the same thing as the chunk's decoded STRIDE
 *  (always `chunkSamples` for a present chunk, per the module doc) -- a
 *  caller building a `DecodedSegment` (`taste.ts`) must set `stride`
 *  separately, never derive it from `end - start`. */
export function chunkSampleSpan(opts: {
  shardIndex: number;
  localIndex: number;
  shardSamples: number;
  chunkSamples: number;
  nSamples: number;
}): { start: number; end: number } {
  const { shardIndex, localIndex, shardSamples, chunkSamples, nSamples } = opts;
  const start = shardIndex * shardSamples + localIndex * chunkSamples;
  const end = Math.min(nSamples, start + chunkSamples);
  return { start, end };
}

/** A discriminated union, like {@link ShardIndexEntry}: `{ kind: "range",
 *  start: undefined, end: undefined }` used to typecheck, which is why
 *  `read-window.ts` needed an `as number` cast on `read.start`. The absent
 *  variant carries a SINGULAR `localIndex` (it is always constructed for
 *  exactly one local index, and was always read back as
 *  `localIndices[0]`) rather than a one-element array. */
export type ChunkRead =
  | { kind: "range"; localIndices: number[]; start: number; end: number }
  | { kind: "absent"; localIndex: number };

/**
 * Coalesce a shard's wanted local chunk indices into the fewest HTTP Range
 * reads: a run of indices that are both index-consecutive AND byte-adjacent
 * (`entries[i].offset + entries[i].nbytes === entries[i + 1].offset`)
 * becomes one `"range"` read; an absent entry is always its own `"absent"`
 * read (no bytes to fetch) and breaks any run around it. `wantedLocalIndices`
 * need not be sorted or deduplicated.
 */
export function planShardReads(
  entries: ShardIndexEntry[],
  wantedLocalIndices: number[],
): ChunkRead[] {
  const wanted = Array.from(new Set(wantedLocalIndices)).sort((a, b) => a - b);
  const reads: ChunkRead[] = [];
  let i = 0;
  while (i < wanted.length) {
    const idx = wanted[i];
    const entry = entries[idx];
    if (!entry) {
      throw new Error(
        `planShardReads: local index ${idx} has no footer entry (${entries.length} parsed)`,
      );
    }
    if (!entry.present) {
      reads.push({ kind: "absent", localIndex: idx });
      i++;
      continue;
    }
    const runIndices = [idx];
    const runStart = entry.offset;
    let runEnd = entry.offset + entry.nbytes; // exclusive
    let j = i + 1;
    while (j < wanted.length) {
      const nextIdx = wanted[j];
      const nextEntry = entries[nextIdx];
      if (nextIdx !== wanted[j - 1] + 1 || !nextEntry?.present || nextEntry.offset !== runEnd)
        break;
      runIndices.push(nextIdx);
      runEnd = nextEntry.offset + nextEntry.nbytes;
      j++;
    }
    reads.push({ kind: "range", localIndices: runIndices, start: runStart, end: runEnd - 1 });
    i = j;
  }
  return reads;
}

// ---------------------------------------------------------------------------
// Cache serialization for the `shardidx/<zarr>/<group>/0/<j>` projection kind
// (`read-window.ts`) -- a compact `[offset, nbytes]` pair per entry, `[-1,
// -1]` for an absent one (real offsets/nbytes are always non-negative, so
// this sentinel is unambiguous). The cache-entry SCHEMA
// (`shardIndexPairSchema`, `read-window.ts`) is what rejects a malformed
// pair (e.g. `[-1, 240]`) as a cache miss -- these two functions trust their
// input is already well-formed, which holds for anything that passed that
// schema or came straight from `parseShardFooter`.
// ---------------------------------------------------------------------------

export function shardEntriesToPairs(entries: ShardIndexEntry[]): Array<[number, number]> {
  return entries.map((e) => (e.present ? [e.offset, e.nbytes] : [-1, -1]));
}

export function shardEntriesFromPairs(pairs: Array<[number, number]>): ShardIndexEntry[] {
  return pairs.map(([offset, nbytes]) =>
    offset === -1 && nbytes === -1 ? { present: false } : { present: true, offset, nbytes },
  );
}
