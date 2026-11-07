/**
 * The seconds-to-samples rule shared by the MCP read_window tool and the
 * local engine protocol (shared/zarr/window-samples.ts). These cases pin the
 * rule itself; the MCP's use of it at fractional seconds is pinned by the
 * "recipe mode" rounding tests in mcp-read-window.test.ts (the golden test
 * uses whole seconds only, where rounding never matters).
 */

import { describe, expect, test } from "bun:test";
import { secondsToSampleWindow } from "../../shared/zarr/window-samples.js";

describe("secondsToSampleWindow", () => {
  test("a tie rounds up, for the start and for the duration", () => {
    // 0.25 s at 2 Hz is 0.5 samples, 1.25 s is 2.5 samples.
    expect(secondsToSampleWindow(0.25, 1.25, 2)).toEqual({ startSample: 1, nSamples: 3 });
  });

  test("below a tie rounds down, above rounds up (not floor, not ceil)", () => {
    // 0.2 s at 2 Hz = 0.4 (ceil would give 1); 0.75 s = 1.5 (floor would give 1).
    expect(secondsToSampleWindow(0.2, 0.75, 2)).toEqual({ startSample: 0, nSamples: 2 });
  });

  test("the duration is rounded on its own, not as end minus start", () => {
    // start 0.3 s -> 0.6 -> 1; duration 0.3 s -> 1; end-time rounding would
    // give round(1.2) - round(0.6) = 0.
    expect(secondsToSampleWindow(0.3, 0.3, 2)).toEqual({ startSample: 1, nSamples: 1 });
  });

  test("whole seconds at a real rate are exact", () => {
    expect(secondsToSampleWindow(10, 2, 250)).toEqual({ startSample: 2500, nSamples: 500 });
  });

  test("a zero duration is zero samples (the caller decides it is an error)", () => {
    expect(secondsToSampleWindow(1, 0, 250).nSamples).toBe(0);
    // Under half a sample also rounds to zero: 0.001 s at 250 Hz = 0.25.
    expect(secondsToSampleWindow(1, 0.001, 250).nSamples).toBe(0);
  });
});
