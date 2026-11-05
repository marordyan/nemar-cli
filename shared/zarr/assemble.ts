/** One inner chunk's contribution to the requested window, in GLOBAL sample
 *  coordinates. Two DELIBERATELY SEPARATE quantities live here, never
 *  conflated (a real production bug, caught against nm000329's live shard 1:
 *  a boundary chunk decodes to a FULL `chunk_samples`-wide buffer, fill-
 *  padded past the array's real extent -- Zarr never emits a narrower
 *  chunk, even for an array's final boundary chunk):
 *
 *   - `start`/`end`: the chunk's VALID sample span -- how much of it is
 *     real, in-array data, truncated at the array's `n_samples` for a
 *     boundary chunk. This is what {@link assembleWindow} uses to
 *     decide which GLOBAL sample positions this segment actually answers
 *     for.
 *   - `stride`: the decoded buffer's actual per-channel COLUMN COUNT --
 *     always the group's nominal `chunk_samples` for a present chunk,
 *     regardless of how much of that is "valid" per `start`/`end`. This is
 *     what indexes INTO `data` (`data[ch * stride + localCol]`). Using
 *     `end - start` (the valid width) as the stride instead is exactly the
 *     bug: it works by coincidence for channel 0 (offset 0 either way) and
 *     silently reads every other channel's samples from the wrong byte
 *     offset.
 *
 *  `data` is `null` for an absent (fill-value) chunk -- `stride` is still
 *  set (to `chunk_samples`) for shape symmetry, but unused. */
export interface DecodedSegment {
  start: number;
  end: number;
  stride: number;
  data: Int16Array | null;
}

/** A GLOBAL sample range, half-open, that was fill-substituted (no stored
 *  inner chunk) rather than read from a real recorded chunk -- ADR 0005's
 *  "partial data is reported, never silently substituted" applied to a
 *  taste's per-sample gaps, which are otherwise indistinguishable from real
 *  near-flat signal (a fill value is exactly the channel's own baseline
 *  `offset[ch]`). */
export interface FilledRange {
  start: number;
  end: number;
}
