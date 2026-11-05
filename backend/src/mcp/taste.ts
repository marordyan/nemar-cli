/**
 * Pure assembly for `read_window` taste mode (epic #1065 phase 4, issue
 * #1296): turn decoded (or fill-valued) inner-chunk segments into a
 * `[channel][sample]` physical-unit array. No I/O -- `shared/zarr/read.ts`
 * does the fetching, footer parsing, and blosc decode, and
 * `shared/zarr/assemble.ts` the assembly; this file only rounds what it is
 * handed and holds the taste caps.
 */

import {
  type DecodedSegment,
  type FilledRange,
  assembleWindow,
} from "../../../shared/zarr/assemble.js";

export type { DecodedSegment, FilledRange };

/** Round `value` to `digits` significant figures. `0` stays `0` (no
 *  `log10(0)`); everything else uses the standard
 *  `10 ** (digits - 1 - floor(log10(|value|)))` scaling. Deliberately not a
 *  fixed-decimal round: a scale factor around `1e-8` (the real nm000329
 *  fixture's own per-channel `scale[]`) needs many more than six decimal
 *  places to keep six SIGNIFICANT digits. */
export function roundToSignificantDigits(value: number, digits: number): number {
  if (value === 0 || !Number.isFinite(value)) return value;
  const magnitude = Math.floor(Math.log10(Math.abs(value)));
  const factor = 10 ** (digits - 1 - magnitude);
  return Math.round(value * factor) / factor;
}

export const TASTE_SIGNIFICANT_DIGITS = 6;

export interface AssembleTasteValuesInput {
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
  significantDigits?: number;
}

export interface AssembleTasteValuesResult {
  /** `[channel][sample]`, physical units, rounded. */
  values: number[][];
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
export function assembleTasteValues(input: AssembleTasteValuesInput): AssembleTasteValuesResult {
  const { significantDigits = TASTE_SIGNIFICANT_DIGITS, ...rest } = input;
  let assembled: ReturnType<typeof assembleWindow>;
  try {
    assembled = assembleWindow(rest);
  } catch (err) {
    // Keep the tool's pinned error text: the core names itself, this tool names
    // its own entry point.
    if (err instanceof Error) {
      err.message = err.message.replace(/^assembleWindow:/, "assembleTasteValues:");
    }
    throw err;
  }
  const values = assembled.values.map((row) =>
    Array.from(row, (physical) => roundToSignificantDigits(physical, significantDigits)),
  );
  return { values, filledRanges: assembled.filledRanges };
}

/** Whether `channelCount x windowSamples` exceeds `cap` -- `read_window`'s
 *  ONE runtime (non-schema) taste bound, the actual response-size limit
 *  (`READ_WINDOW_TASTE_MAX_CHANNEL_SAMPLES`, `shared/contract/mcp.ts`).
 *  Extracted as its own pure, exported predicate (mirroring this
 *  package's `sharding.ts` precedent of keeping planning arithmetic pure
 *  and directly boundary-testable) so "exactly at the cap" and "one past
 *  it" can be asserted directly, rather than only through a much larger
 *  end-to-end tool call -- this is the one cap nothing else in the schema
 *  enforces. */
export function exceedsChannelSamplesCap(opts: {
  channelCount: number;
  windowSamples: number;
  cap: number;
}): boolean {
  return opts.channelCount * opts.windowSamples > opts.cap;
}

/**
 * Budget on DECODED samples, expressed in the store's own channel count rather
 * than the caller's.
 *
 * Every cap up to this point bounds the RESPONSE: `duration_s <= 60`,
 * `channels.length <= 64`, their product `<= 3840` channel-seconds, and
 * `channels.length * windowSamples <= 65536`. None of them bounds the DECODE,
 * because a chunk holds every channel in the store: cost is
 * `n_channels(store) * windowSamples` regardless of how few channels were asked
 * for. `sharding.ts` says exactly this in prose ("Cost is driven by DURATION ...
 * and the store's own channel count, never by how many channels the caller
 * asked for") and no guard was added for it.
 *
 * The worst legal request in the catalog as of 2026-09-09, found by scanning all
 * 108 meg/ieeg/emg indexes: on004696 group `ieeg_1000hz`, 256 channels at
 * 1000 Hz with `chunk_samples` 4000. `{taste: true, channels: [0],
 * duration_s: 60}` passes all four caps (60 <= 60, 1 <= 64, 60 <= 3840,
 * 60000 <= 65536) and then decodes 15 chunks of 256 x 4000 = 15.4 M int16
 * samples, about 31 MB retained until assembly, plus the compressed bytes
 * fetched, to return roughly 500 KB of JSON. The 415-channel store in the
 * archive would make it about 50 MB. The 128 MB limit is per ISOLATE, not per
 * request, so two concurrent tastes take out every unrelated request in flight
 * with them.
 *
 * 4 M samples is about 8 MB of int16 and is far more than a "taste" needs. Both
 * inputs are known before any fetch, so this refuses rather than truncating,
 * which is the same posture as every other cap here.
 */
export const MAX_TASTE_DECODE_SAMPLES = 4_000_000;

export function exceedsDecodeBudget(opts: {
  /** The STORE's channel count, not `channels.length`. */
  storeChannelCount: number;
  windowSamples: number;
  cap: number;
}): boolean {
  return opts.storeChannelCount * opts.windowSamples > opts.cap;
}

/** The largest `duration_s` that would fit the decode budget for this store, so
 *  a refusal can name a number the caller can actually use. Floored at 0. */
export function maxTasteDurationS(opts: {
  storeChannelCount: number;
  rate: number;
  cap: number;
}): number {
  if (opts.storeChannelCount <= 0 || opts.rate <= 0) return 0;
  const samples = Math.floor(opts.cap / opts.storeChannelCount);
  return Math.max(0, Math.floor((samples / opts.rate) * 10) / 10);
}
