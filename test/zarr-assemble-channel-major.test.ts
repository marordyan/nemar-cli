/**
 * `assembleChannelMajor` (shared/zarr/assemble.ts): one channel-major array in the requested
 * units, from the same loop as `assembleWindow`. Digital output is the stored int16 with no
 * scale or offset; physical output matches `assembleWindow` value for value.
 */

import { describe, expect, test } from "bun:test";
import {
  type AssembleWindowInput,
  type DecodedSegment,
  assembleChannelMajor,
  assembleWindow,
} from "../shared/zarr/assemble.js";

// Two store channels. Samples [0, 4) are a stored chunk (stride 4: channel 0 then channel 1);
// samples [4, 8) are an absent chunk, filled with `fillValue`.
const stored: DecodedSegment = {
  start: 0,
  end: 4,
  stride: 4,
  data: Int16Array.from([10, 11, 12, -32768, 20, 21, 22, 32767]),
};
const absent: DecodedSegment = { start: 4, end: 8, stride: 4, data: null };

// A window of samples [2, 6) over channels [1, 0] (request order, not store order), with a
// scale and offset that change every value, so a digital output that applied them would differ.
const input: AssembleWindowInput = {
  channels: [1, 0],
  startSample: 2,
  nSamples: 4,
  segments: [stored, absent],
  scale: [0.5, 3],
  offset: [100, -7],
  fillValue: 0,
};

describe("assembleChannelMajor", () => {
  test("digital is the stored int16, channel-major in request order, no scale or offset", () => {
    const { values, filledRanges } = assembleChannelMajor({ ...input, units: "digital" });
    expect(values).toBeInstanceOf(Int16Array);
    // Row 0 is channel 1, row 1 is channel 0; samples 2, 3 stored, 4, 5 filled.
    expect(Array.from(values)).toEqual([22, 32767, 0, 0, 12, -32768, 0, 0]);
    expect(filledRanges).toEqual([{ start: 4, end: 6 }]);
  });

  test("physical is float64 and equals assembleWindow's rows, value for value", () => {
    const { values, filledRanges } = assembleChannelMajor({ ...input, units: "physical" });
    expect(values).toBeInstanceOf(Float64Array);
    const rows = assembleWindow(input);
    expect(Array.from(values)).toEqual([...rows.values[0], ...rows.values[1]]);
    expect(filledRanges).toEqual(rows.filledRanges);
    // Channel 1 at sample 2: 22 * 3 - 7; a filled sample reads as the channel's offset.
    expect(values[0]).toBe(59);
    expect(values[2]).toBe(-7);
    expect(values[4]).toBe(12 * 0.5 + 100);
  });

  test("assembleWindow still returns one nSamples-long Float64Array row per channel", () => {
    const { values } = assembleWindow(input);
    expect(values).toHaveLength(2);
    for (const row of values) {
      expect(row).toBeInstanceOf(Float64Array);
      expect(row).toHaveLength(4);
    }
    expect(Array.from(values[1])).toEqual([12 * 0.5 + 100, -32768 * 0.5 + 100, 100, 100]);
  });

  test("a window the segments do not cover throws, in either units", () => {
    const short = { ...input, segments: [stored] };
    expect(() => assembleChannelMajor({ ...short, units: "digital" })).toThrow(/not covered/);
    expect(() => assembleChannelMajor({ ...short, units: "physical" })).toThrow(/not covered/);
  });
});
