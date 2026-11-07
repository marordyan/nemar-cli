/**
 * The one rule that turns a window given in seconds into sample positions.
 *
 * Both the MCP `read_window` tool and the local engine protocol
 * (`shared/zarr-engine-protocol.schema.json`, `ReadWindowRequest`) address a
 * window by `start_s` and `duration_s`, and both must land on the same
 * samples. This is the converter's own `sample_index_for` rounding
 * (scripts/zarr/generate_zarr.py): `floor(x * rate + 0.5)`, so a tie rounds
 * UP. It is applied to the start and the duration separately, never to the
 * end time, so a window's length does not depend on where it starts.
 *
 * Pure: no range check. Callers compare the result with the group's sample
 * count (`n_samples` in the Zarr index, `ntimes` in the engine protocol) and
 * decide what an out-of-range or empty window means.
 */
export interface SampleWindow {
  /** First sample of the window (0-based). */
  startSample: number;
  /** Number of samples requested; `startSample + nSamples` is end-exclusive. */
  nSamples: number;
}

export function secondsToSampleWindow(
  startS: number,
  durationS: number,
  rateHz: number,
): SampleWindow {
  return {
    startSample: Math.floor(startS * rateHz + 0.5),
    nSamples: Math.floor(durationS * rateHz + 0.5),
  };
}
