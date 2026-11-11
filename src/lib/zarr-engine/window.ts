/**
 * `read_window` and `recipe`: the two requests that address samples of a bound recording.
 *
 * Both apply the protocol's time rule through the one helper the MCP uses
 * (`secondsToSampleWindow`) and refuse, with `out_of_range`, a window that is empty, starts at
 * or past `ntimes`, ends past it, or names a channel the store does not have. A window is never
 * truncated.
 *
 * `read_window` then applies the engine's memory policy before it fetches anything
 * (`too_large`): the payload (`channels x samples x bytes per sample`) and the DECODE work
 * (every store channel x samples x 2 bytes, because a stored chunk holds every channel, so
 * naming one channel of a wide store does not make the read small) must each stay within
 * `maxPayloadBytes`. It reads with `readLevel0Window`, assembles with `assembleWindow`, and
 * lays the result out channel-major, little-endian. `digital` is the raw int16: assembling
 * with scale 1 and offset 0 is exact for int16 values, so no new core code is needed.
 *
 * A failed read maps by the core's `cause` (ADR 0120): `fetch` and `plan` are `upstream_error`,
 * `decode` is `decode_error`. Nothing that failed ever becomes a window.
 */

import { buildReadRecipe } from "../../../shared/contract/mcp.js";
import {
  ENGINE_DTYPE_BYTES,
  type ReadWindowRequest,
  type RecipeRequest,
} from "../../../shared/contract/zarr-engine-protocol.js";
import { assembleWindow } from "../../../shared/zarr/assemble.js";
import { readLevel0Window } from "../../../shared/zarr/read.js";
import { secondsToSampleWindow } from "../../../shared/zarr/window-samples.js";
import type { Binding, DataSource, SourceFailure, SourceResult } from "./source.js";

/** Bytes per digital (int16) sample in a store, for the decode-work check. */
const STORE_SAMPLE_BYTES = 2;

export interface WindowPlan {
  startSample: number;
  nSamples: number;
  /** Store channel indices: the request's, in its order, or all ascending. */
  channels: number[];
  /** True when the request named channels (a recipe then carries `channel_slice`). */
  channelsNamed: boolean;
}

function failure(code: SourceFailure["code"], message: string): SourceFailure {
  return { ok: false, code, message };
}

/** The window a request asks for, or `out_of_range`. Shared by `read_window` and `recipe`. */
export function planWindow(
  binding: Binding,
  request: Pick<ReadWindowRequest, "start_s" | "duration_s" | "channels">,
): SourceResult<WindowPlan> {
  const { rate, nSamples: ntimes, nChannels } = binding.geometry;
  const { startSample, nSamples } = secondsToSampleWindow(
    request.start_s,
    request.duration_s,
    rate,
  );
  if (nSamples < 1) {
    return failure(
      "out_of_range",
      `duration_s ${request.duration_s} rounds to 0 samples at ${rate} Hz`,
    );
  }
  if (startSample >= ntimes || startSample + nSamples > ntimes) {
    return failure(
      "out_of_range",
      `the window [${startSample}, ${startSample + nSamples}) is outside the recording's ${ntimes} samples at ${rate} Hz`,
    );
  }
  const channelsNamed = request.channels !== undefined;
  const channels = request.channels ?? Array.from({ length: nChannels }, (_, i) => i);
  const bad = channels.find((c) => c >= nChannels);
  if (bad !== undefined) {
    return failure(
      "out_of_range",
      `channel ${bad} is outside the recording's ${nChannels} channels`,
    );
  }
  return { ok: true, value: { startSample, nSamples, channels, channelsNamed } };
}

export interface WindowReply {
  header: Record<string, unknown>;
  payload: Uint8Array;
}

const littleEndianHost = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** Channel-major little-endian bytes of `rows`, `dtype` wide. */
function pack(rows: Float64Array[] | Int16Array[], dtype: "float64" | "int16"): Uint8Array {
  const size = ENGINE_DTYPE_BYTES[dtype];
  const nSamples = rows[0]?.length ?? 0;
  const out = new Uint8Array(rows.length * nSamples * size);
  if (littleEndianHost) {
    // Typed arrays share the host's byte order, which is the wire's.
    rows.forEach((row, i) => {
      out.set(new Uint8Array(row.buffer, row.byteOffset, row.byteLength), i * nSamples * size);
    });
    return out;
  }
  const view = new DataView(out.buffer);
  rows.forEach((row, i) => {
    for (let j = 0; j < nSamples; j++) {
      const at = (i * nSamples + j) * size;
      if (dtype === "float64") view.setFloat64(at, row[j], true);
      else view.setInt16(at, row[j], true);
    }
  });
  return out;
}

/** The `window` header (without `id`) and its payload, or a failure. */
export async function readWindow(
  source: DataSource,
  binding: Binding,
  request: ReadWindowRequest,
  limits: { maxPayloadBytes: number },
): Promise<SourceResult<WindowReply>> {
  const planned = planWindow(binding, request);
  if (!planned.ok) return planned;
  const { startSample, nSamples, channels } = planned.value;
  const dtype = request.units === "digital" ? "int16" : "float64";

  const payloadBytes = channels.length * nSamples * ENGINE_DTYPE_BYTES[dtype];
  if (payloadBytes > limits.maxPayloadBytes) {
    return failure(
      "too_large",
      `the window's payload is ${payloadBytes} bytes, over the engine's ${limits.maxPayloadBytes}; ask for fewer channels or a shorter window`,
    );
  }
  const { nChannels: storeChannels, chunkSamples, shardSamples, nInner } = binding.geometry;
  const decodeBytes = storeChannels * nSamples * STORE_SAMPLE_BYTES;
  if (decodeBytes > limits.maxPayloadBytes) {
    return failure(
      "too_large",
      `reading the window decodes ${decodeBytes} bytes (${storeChannels} channels in the store x ${nSamples} samples; a stored chunk holds every channel), over the engine's ${limits.maxPayloadBytes}; shorten the window`,
    );
  }

  const read = await readLevel0Window({
    fetcher: source.fetcher,
    cache: source.jsonCache,
    key: binding.cacheKey,
    dataBase: binding.dataBase,
    zarr: binding.store.zarr,
    groupName: binding.group.name,
    shardSamples,
    chunkSamples,
    nInner,
    nChannelsInStore: storeChannels,
    nSamplesTotal: binding.geometry.nSamples,
    startSample,
    endSampleExclusive: startSample + nSamples,
  });
  if (!read.ok) {
    return failure(
      read.cause === "decode" ? "decode_error" : "upstream_error",
      `reading the ${read.stage} failed: ${read.detail}`,
    );
  }

  const physical = dtype === "float64";
  const assembled = assembleWindow({
    channels,
    startSample,
    nSamples,
    segments: read.segments,
    scale: physical ? binding.bound.scale : new Array<number>(storeChannels).fill(1),
    offset: physical ? binding.bound.offset : new Array<number>(storeChannels).fill(0),
    fillValue: 0,
  });
  const rows = physical ? assembled.values : assembled.values.map((r) => Int16Array.from(r));
  const payload = pack(rows, dtype);

  return {
    ok: true,
    value: {
      header: {
        type: "window",
        start_sample: startSample,
        n_samples: nSamples,
        channels,
        dtype,
        layout: "channel-major",
        byte_order: "little",
        filled_ranges: assembled.filledRanges.map((r) => ({
          start_sample: r.start,
          end_sample: r.end,
        })),
        payload_bytes: payload.length,
      },
      payload,
    },
  };
}

/** The `recipe` response body (without `id`): the MCP read-recipe object for the window. */
export function recipeFor(
  binding: Binding,
  request: RecipeRequest,
): SourceResult<{ recipe: ReturnType<typeof buildReadRecipe> }> {
  const planned = planWindow(binding, request);
  if (!planned.ok) return planned;
  const { startSample, nSamples, channels, channelsNamed } = planned.value;
  const recipe = buildReadRecipe({
    index: binding.index,
    store: binding.store,
    groupName: binding.group.name,
    sampleSlice: { start: startSample, end: startSample + nSamples },
    // The half-open range from the lowest to one past the highest requested channel, and
    // absent when the request named none.
    channelSlice: channelsNamed
      ? { start: Math.min(...channels), end: Math.max(...channels) + 1 }
      : undefined,
    arrayMetadata: binding.arrayMetadata,
  });
  return { ok: true, value: { recipe } };
}
