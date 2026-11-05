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

export interface AssembleWindowInput {
  /** The requested output channels, in the ORDER requested -- each is an
   *  index into the store's full channel axis (and into `scale`/`offset`). */
  channels: number[];
  /** Window start, global sample index (inclusive). */
  startSample: number;
  /** Window length in samples. */
  nSamples: number;
  /** Every segment touching `[startSample, startSample + nSamples)`, in
   *  ascending order, covering it with no gaps (segments may extend past
   *  either edge -- this function computes the overlap). */
  segments: DecodedSegment[];
  /** Per-FULL-STORE-channel scale/offset (`physical = digital * scale +
   *  offset`), each at least as long as the store's channel count. */
  scale: number[];
  offset: number[];
  /** The digital fill value for an absent chunk (always `0` today, per the
   *  Zarr `fill_value` every served level-0 array declares). */
  fillValue: number;
}

export interface AssembleWindowResult {
  /** One `Float64Array` per requested channel, `nSamples` long, physical
   *  units at FULL float64 precision (rounding is the caller's choice). */
  values: Float64Array[];
  /** GLOBAL sample ranges (clipped to the requested window) that were
   *  fill-substituted, ascending, adjacent ranges merged into one. */
  filledRanges: FilledRange[];
}

/**
 * Assemble `channels.length` rows of `nSamples` physical values each, plus
 * the fill-substituted ranges within the window. Throws if `segments` does
 * not fully cover `[startSample, startSample + nSamples)` -- a caller bug
 * (an incomplete chunk plan), not a data condition to degrade around
 * silently.
 */
export function assembleWindow(input: AssembleWindowInput): AssembleWindowResult {
  const { channels, startSample, nSamples, segments, scale, offset, fillValue } = input;

  const endSample = startSample + nSamples;
  const out: Float64Array[] = channels.map(() => new Float64Array(nSamples));
  const covered = new Uint8Array(nSamples);
  const filledRanges: FilledRange[] = [];

  for (const segment of segments) {
    const overlapStart = Math.max(segment.start, startSample);
    const overlapEnd = Math.min(segment.end, endSample);
    if (overlapEnd <= overlapStart) continue;

    if (!segment.data) {
      const last = filledRanges[filledRanges.length - 1];
      if (last && last.end === overlapStart) {
        last.end = overlapEnd;
      } else {
        filledRanges.push({ start: overlapStart, end: overlapEnd });
      }
    }

    for (let outIdx = 0; outIdx < channels.length; outIdx++) {
      const ch = channels[outIdx];
      const chScale = scale[ch];
      const chOffset = offset[ch];
      for (let globalSample = overlapStart; globalSample < overlapEnd; globalSample++) {
        const digital = segment.data
          ? segment.data[ch * segment.stride + (globalSample - segment.start)]
          : fillValue;
        out[outIdx][globalSample - startSample] = digital * chScale + chOffset;
      }
    }
    for (let s = overlapStart; s < overlapEnd; s++) covered[s - startSample] = 1;
  }

  for (let i = 0; i < nSamples; i++) {
    if (!covered[i]) {
      throw new Error(
        `assembleWindow: sample ${startSample + i} (window [${startSample}, ${endSample})) is not covered by any segment`,
      );
    }
  }

  return { values: out, filledRanges };
}
