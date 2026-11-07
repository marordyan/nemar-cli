/**
 * `read_window` (epic #1065 phase 4, issue #1296; ADR 0049's recipe-first
 * posture). The last MCP tool, and the one that would move the most bytes
 * through the Worker if implemented naively: recipe mode (the default) hands
 * out a `zarr`/`zarrita`/`s3` read recipe with ZERO signal bytes touched;
 * taste mode decodes a small, capped window inline for a quick sanity check.
 *
 * **Recipe mode makes no reads beyond `index.json`.** Unlike
 * `list_recordings`/`get_events`/`render_overview`, this tool does NOT read
 * or write the `recordings` projection cache (`list-recordings.ts`) --
 * `buildReadRecipe` needs the FULL index document (`contract_base`,
 * `data_base`, `s3_uri`, `layout`, and each group's `chunk_samples`/
 * `shard_samples`), none of which the compact `RecordingsProjection` carries.
 * So this tool calls `readZarrIndex` directly (the same function
 * `loadRecordingsProjection` calls internally on its own cache miss),
 * relying on the zarr sub-app's OWN edge cache for `index.json` -- exactly
 * the design doc's "one index.json read (cached through the zarr sub-app, the
 * phase 3 readZarrIndex path) and nothing else." `buildReadRecipe` is called
 * WITHOUT `arrayMetadata` in recipe mode, so `dtype` is null and `codecs`
 * absent; the envelope's `dtype` is null too (nothing was read).
 *
 * **A v1/v2 index is a typed refusal**, not degraded service: no legacy
 * document carries `layout`/`data_base`/per-group `chunk_samples`/
 * `shard_samples`, so no recipe is computable at all.
 * `list_recordings`/`get_events` still work against that dataset's current
 * index; this tool cannot, until the ADR 0033 engine bump re-converts it.
 * Similarly, a v3 group missing `chunk_samples`/`shard_samples` on its OWN
 * entry answers a typed refusal when `taste` is requested (never a silent
 * downgrade to a recipe result -- the same "an error is impossible to
 * misread" reasoning the taste-cap rejection below uses); the error
 * text says a recipe IS computable for that group by retrying without
 * `taste`.
 *
 * **Taste mode reads inner chunks only, never a whole shard.** Level 0 is a
 * SHARDED array (`sharding.ts`'s module doc has the full geometry); a taste
 * fetches exactly the shard footers and inner-chunk byte ranges the
 * requested window spans, via `Range` requests straight to `index.data_base`
 * (the same path `render_overview`'s chunk fetches use, never through the
 * zarr sub-app). Adjacent, byte-contiguous chunks within one shard coalesce
 * into one `Range` request (`sharding.ts`'s `planShardReads`); an absent
 * inner chunk (the Zarr `2^64 - 1` marker) contributes the fill value with
 * no fetch at all, and its span is reported in the response's
 * `filled_ranges` (ADR 0005: partial data is reported, never silently
 * substituted). Two projection-cache kinds back this
 * (`array/<zarr>/<group>/0` for the level-0 `zarr.json`,
 * `shardidx/<zarr>/<group>/0/<j>` for one shard's parsed footer), both
 * immutable per `(dataset_id, source_commit)`; decoded WINDOWS are never
 * cached -- a taste is an inline decode of a specific window on demand.
 *
 * **Every `Range` fetch is validated, not just trusted.** `fetchRangeBytes`
 * (`shared/zarr/fetch-range.ts`) is the ONE call site both the footer read and the chunk read go through:
 * a response to a `Range` request MUST be `206` (a compliant origin never
 * answers `200` to one), and its body length must equal exactly what was
 * asked for. An origin that silently ignores `Range` and returns the whole
 * object would otherwise decode cleanly (the object's leading bytes are
 * still real, full-length chunks -- just the WRONG ones) and hand back
 * plausible signal from the wrong point in the recording; this is checked,
 * not assumed.
 *
 * **Three caps guard a taste**, none of them the phase 1 product-only check
 * alone (see `shared/contract/mcp.ts`'s `READ_WINDOW_TASTE_MAX_CHANNEL_SAMPLES`
 * doc for the measured reason): `READ_WINDOW_TASTE_MAX_DURATION_S` (60) and
 * `READ_WINDOW_TASTE_MAX_CHANNELS` (64) are schema-level hard caps
 * (`readWindowInputSchema`'s `superRefine`); `READ_WINDOW_TASTE_MAX_CHANNEL_SAMPLES`
 * (65,536) cannot be schema-enforced (the schema does not know a group's
 * rate) and is checked here, right after the group's rate is known
 * (`exceedsChannelSamplesCap`, `taste.ts`), naming the rate, the computed
 * `channels.length x n_samples`, the cap, and the two ways to get under it.
 *
 * **The taste response is not duplicated into `content`.** Every other tool
 * puts `JSON.stringify(output)` in both `content` and `structuredContent`;
 * for a taste at the cap that would put ~900 KB of numbers in `content`
 * twice. Taste mode's `content` is a compact one-line summary instead
 * (shape, rate, sample range, bytes/chunks read, filled-range count, the
 * first few values of the first channel); `structuredContent` still carries
 * the full object. Recipe mode keeps the both-places convention -- it is
 * small.
 */

import type { CallToolResult } from "@modelcontextprotocol/server";
import {
  READ_WINDOW_TASTE_MAX_CHANNEL_SAMPLES,
  type ReadWindowInput,
  type ReadWindowOutput,
  buildReadRecipe,
  readWindowOutputSchema,
} from "../../../../shared/contract/mcp.js";
import type { ZarrGroup, ZarrIndex, ZarrStore } from "../../../../shared/contract/zarr-index.js";
import { isV3Index } from "../../../../shared/zarr/index.js";
import { readLevel0Window } from "../../../../shared/zarr/read.js";
import { nInnerForShard } from "../../../../shared/zarr/sharding.js";
import { secondsToSampleWindow } from "../../../../shared/zarr/window-samples.js";
import { type Level0ArrayMetadata, loadLevel0ArrayMetadata } from "../array-metadata.js";
import {
  type PublicDatasetRow,
  datasetNotFoundResult,
  isZarrReady,
  loadPublicDatasetRow,
  zarrNotReadyResult,
} from "../catalog-row.js";
import { type EnvelopeIndexFacts, buildEnvelopeForStore } from "../envelope.js";
import { readZarrIndex } from "../index-reader.js";
import { mcpJsonCache } from "../projection-cache.js";
import {
  type FilledRange,
  MAX_TASTE_DECODE_SAMPLES,
  TASTE_SIGNIFICANT_DIGITS,
  assembleTasteValues,
  exceedsChannelSamplesCap,
  exceedsDecodeBudget,
  maxTasteDurationS,
} from "../taste.js";
import type { RecordingToolDeps, ToolOutcome } from "../tool-types.js";

function toolError(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

function v1RefusalResult(datasetId: string, formatVersion: number): CallToolResult {
  return toolError(
    `Dataset "${datasetId}" still publishes index format v${formatVersion}; read_window needs format_version 3 (no v1/v2 document carries the layout, data_base, or per-group chunk_samples/shard_samples fields a recipe or a taste read requires). Re-conversion under engine version 3 (ADR 0033's engine bump) is pending. list_recordings and get_events still work on this dataset's current index.`,
  );
}

function recordingNotFoundResult(
  datasetId: string,
  recording: string,
  stores: ZarrStore[],
): CallToolResult {
  const sample = stores.slice(0, 20).map((s) => s.zarr);
  const more = stores.length > 20 ? ` (and ${stores.length - 20} more)` : "";
  return toolError(
    `Recording "${recording}" was not found in dataset "${datasetId}" (matched against each ` +
      `recording's path or zarr field). Known recordings: ${sample.join(", ") || "(none)"}${more}.`,
  );
}

function groupNotFoundResult(
  datasetId: string,
  recording: string,
  wanted: string,
  available: string[],
): CallToolResult {
  return toolError(
    `Recording "${recording}" in dataset "${datasetId}" has no group named "${wanted}". ` +
      `Available groups: ${available.join(", ") || "(none)"}.`,
  );
}

function missingGeometryResult(
  datasetId: string,
  recording: string,
  groupName: string,
): CallToolResult {
  return toolError(
    `Group "${groupName}" of recording "${recording}" in dataset "${datasetId}" is missing the sample count, channel count, or sampling rate read_window needs to plan a read.`,
  );
}

function durationOutOfRangeResult(opts: {
  datasetId: string;
  recording: string;
  groupName: string;
  startS: number;
  durationS: number;
  nSamples: number;
  rate: number;
}): CallToolResult {
  const { datasetId, recording, groupName, startS, durationS, nSamples, rate } = opts;
  const recordingDurationS = nSamples / rate;
  const requestedEndS = startS + durationS;
  return toolError(
    `The requested window (start_s ${startS} + duration_s ${durationS} = ${requestedEndS} s) is ` +
      `past group "${groupName}" of recording "${recording}" in dataset "${datasetId}"'s duration ` +
      `(${recordingDurationS} s, ${nSamples} samples at ${rate} Hz). Shorten duration_s or lower start_s.`,
  );
}

function zeroSampleWindowResult(opts: {
  datasetId: string;
  recording: string;
  groupName: string;
  durationS: number;
  rate: number;
}): CallToolResult {
  const { datasetId, recording, groupName, durationS, rate } = opts;
  return toolError(
    `duration_s (${durationS} s) rounds to 0 samples at ${rate} Hz for group "${groupName}" of ` +
      `recording "${recording}" in dataset "${datasetId}". Use a longer duration_s.`,
  );
}

function channelOutOfRangeResult(opts: {
  datasetId: string;
  recording: string;
  groupName: string;
  channel: number;
  nChannels: number;
}): CallToolResult {
  const { datasetId, recording, groupName, channel, nChannels } = opts;
  return toolError(
    `Channel index ${channel} is at or past group "${groupName}" of recording "${recording}" in ` +
      `dataset "${datasetId}"'s n_channels (${nChannels}). list_recordings reports the actual channel count.`,
  );
}

function noShardingGeometryResult(
  datasetId: string,
  recording: string,
  groupName: string,
): CallToolResult {
  return toolError(
    `Group "${groupName}" of recording "${recording}" in dataset "${datasetId}" carries no chunk_samples/shard_samples on its v3 index entry, so read_window cannot plan a taste read for it. A recipe is still computable for this group (with those fields null) -- retry with taste omitted.`,
  );
}

function channelsRequiredResult(): CallToolResult {
  return toolError(
    "taste requires channels: name the channel indices you want (list_recordings reports each group's n_channels), or omit taste for a recipe",
  );
}

function channelSamplesCapResult(opts: {
  datasetId: string;
  recording: string;
  groupName: string;
  channelCount: number;
  windowSamples: number;
  rate: number;
}): CallToolResult {
  const { datasetId, recording, groupName, channelCount, windowSamples, rate } = opts;
  const product = channelCount * windowSamples;
  return toolError(
    `read_window taste for group "${groupName}" of recording "${recording}" in dataset "${datasetId}" would decode ${product} channel-samples (${channelCount} channels x ${windowSamples} samples at ${rate} Hz), over the ${READ_WINDOW_TASTE_MAX_CHANNEL_SAMPLES} cap. Ask for fewer channels or a shorter window, or omit taste for a recipe.`,
  );
}

/** The decode budget's refusal. Deliberately worded around the STORE's channel
 *  count, because that is the number the caller cannot see from its own request
 *  and would otherwise find inexplicable: asking for one channel does not make
 *  the read small, since a chunk holds every channel in the store. */
function decodeBudgetResult(opts: {
  datasetId: string;
  recording: string;
  groupName: string;
  storeChannelCount: number;
  windowSamples: number;
  rate: number;
}): CallToolResult {
  const { datasetId, recording, groupName, storeChannelCount, windowSamples, rate } = opts;
  const product = storeChannelCount * windowSamples;
  const maxDuration = maxTasteDurationS({
    storeChannelCount,
    rate,
    cap: MAX_TASTE_DECODE_SAMPLES,
  });
  return toolError(
    `read_window taste for group "${groupName}" of recording "${recording}" in dataset "${datasetId}" would DECODE ${product} samples (${storeChannelCount} channels in the store x ${windowSamples} samples at ${rate} Hz), over the ${MAX_TASTE_DECODE_SAMPLES} limit. A stored chunk holds every channel, so asking for fewer channels does not reduce this; shorten the window to about ${maxDuration} s or less, or omit taste for a recipe.`,
  );
}

function resolveIndexFacts(index: ZarrIndex): EnvelopeIndexFacts {
  return {
    datasetId: index.dataset_id,
    engineVersion: index.engine_version,
    doi: index.doi ?? null,
    license: index.license ?? null,
    citation: index.citation ?? null,
    isLegacy: false,
  };
}

function envelopeStoreInput(store: ZarrStore) {
  return {
    path: store.path,
    source_tree: store.source_tree,
    derived: store.derived,
    sss: store.sss,
    units_report: store.units_report,
  };
}

/** Accepts a minimal STRUCTURAL type (only the fields this function reads)
 *  rather than `ReadWindowOutput` (or a narrowed slice of it) -- there is
 *  then nothing to narrow or cast at the call site: the freshly-built taste
 *  object already has this shape before it is ever handed to
 *  `readWindowOutputSchema.parse`. */
function buildTasteSummary(output: {
  channels: number[];
  values: number[][];
  sample_rate_hz: number;
  start_s: number;
  duration_s: number;
  bytes_read: number;
  chunks_read: number;
  filled_ranges: unknown[];
}): string {
  const nSamples = output.values[0]?.length ?? 0;
  const head = output.values[0]?.slice(0, 5) ?? [];
  const filledNote =
    output.filled_ranges.length > 0 ? ` filled_ranges=${output.filled_ranges.length}` : "";
  return (
    `read_window taste: shape=[${output.channels.length},${nSamples}] rate_hz=${output.sample_rate_hz} ` +
    `start_s=${output.start_s} duration_s=${output.duration_s} bytes_read=${output.bytes_read} ` +
    `chunks_read=${output.chunks_read}${filledNote} first_channel_head=${JSON.stringify(head)}`
  );
}

function toWireFilledRanges(
  ranges: FilledRange[],
  rate: number,
): Array<{ start_sample: number; end_sample: number; start_s: number; end_s: number }> {
  return ranges.map((r) => ({
    start_sample: r.start,
    end_sample: r.end,
    start_s: r.start / rate,
    end_s: r.end / rate,
  }));
}

export async function readWindowTool(
  deps: RecordingToolDeps,
  args: ReadWindowInput,
): Promise<ToolOutcome> {
  const row: PublicDatasetRow | null = await loadPublicDatasetRow(deps.env.DB, args.dataset_id);
  if (!row) {
    return { result: datasetNotFoundResult(args.dataset_id) };
  }
  if (!isZarrReady(row)) {
    return { result: zarrNotReadyResult(args.dataset_id, row) };
  }

  const indexResult = await readZarrIndex(deps, deps.env, deps.executionCtx, args.dataset_id);
  if (indexResult.status === "not_found") {
    return {
      result: toolError(
        `Dataset "${args.dataset_id}" reports zarr_status "${row.zarr_status}" but its index.json could not be found -- this is a transient inconsistency; try again shortly.`,
      ),
    };
  }
  if (indexResult.status === "invalid") {
    return {
      result: toolError(
        `index.json for "${args.dataset_id}" could not be read: ${indexResult.detail}`,
      ),
    };
  }
  if (indexResult.status === "too_large") {
    return { result: toolError(`read_window declines: ${indexResult.detail}`) };
  }
  if (!isV3Index(indexResult.index)) {
    return { result: v1RefusalResult(args.dataset_id, indexResult.formatVersion) };
  }
  const index: ZarrIndex = indexResult.index;

  const store = index.stores.find((s) => s.path === args.recording || s.zarr === args.recording);
  if (!store) {
    return { result: recordingNotFoundResult(args.dataset_id, args.recording, index.stores) };
  }

  const groups: ZarrGroup[] = store.groups ?? [];
  const targetGroup = args.group ? groups.find((g) => g.name === args.group) : groups[0];
  if (!targetGroup) {
    return {
      result: groupNotFoundResult(
        args.dataset_id,
        args.recording,
        args.group ?? "(default: first group)",
        groups.map((g) => g.name),
      ),
    };
  }

  const rate = targetGroup.rate;
  const nSamplesGroup = targetGroup.n_samples;
  const nChannelsGroup = targetGroup.n_channels;
  if (
    !rate ||
    rate <= 0 ||
    !nSamplesGroup ||
    nSamplesGroup < 1 ||
    !nChannelsGroup ||
    nChannelsGroup < 1
  ) {
    return { result: missingGeometryResult(args.dataset_id, args.recording, targetGroup.name) };
  }

  // The converter's own sample_index_for rounding rule, shared with the local
  // engine protocol so both land on the same samples.
  const { startSample, nSamples: requestedSamples } = secondsToSampleWindow(
    args.start_s,
    args.duration_s,
    rate,
  );
  const endSample = startSample + requestedSamples;
  if (startSample >= nSamplesGroup || endSample > nSamplesGroup) {
    return {
      result: durationOutOfRangeResult({
        datasetId: args.dataset_id,
        recording: args.recording,
        groupName: targetGroup.name,
        startS: args.start_s,
        durationS: args.duration_s,
        nSamples: nSamplesGroup,
        rate,
      }),
    };
  }
  const windowSamples = endSample - startSample;
  if (windowSamples < 1) {
    return {
      result: zeroSampleWindowResult({
        datasetId: args.dataset_id,
        recording: args.recording,
        groupName: targetGroup.name,
        durationS: args.duration_s,
        rate,
      }),
    };
  }
  if (args.channels) {
    const badChannel = args.channels.find((c) => c >= nChannelsGroup);
    if (badChannel !== undefined) {
      return {
        result: channelOutOfRangeResult({
          datasetId: args.dataset_id,
          recording: args.recording,
          groupName: targetGroup.name,
          channel: badChannel,
          nChannels: nChannelsGroup,
        }),
      };
    }
  }

  const indexFacts = resolveIndexFacts(index);

  if (!args.taste) {
    const sampleSlice = { start: startSample, end: endSample };
    const channelSlice =
      args.channels && args.channels.length > 0
        ? { start: Math.min(...args.channels), end: Math.max(...args.channels) + 1 }
        : undefined;
    const recipe = buildReadRecipe({
      index,
      store,
      groupName: targetGroup.name,
      level: "0",
      sampleSlice,
      channelSlice,
    });
    const built = buildEnvelopeForStore({
      indexFacts,
      sourceCommit: index.source_commit,
      indexEtag: indexResult.etag,
      row,
      store: envelopeStoreInput(store),
      group: targetGroup,
      dtype: null,
    });
    if (!built.envelope) {
      return {
        result: toolError(
          `internal: dataset "${args.dataset_id}" has a v3 index but no usable source_commit for its envelope`,
        ),
      };
    }
    const output = readWindowOutputSchema.parse({
      mode: "recipe",
      recipe,
      envelope: built.envelope,
    } satisfies ReadWindowOutput);
    return {
      result: {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output,
      },
      metrics: { cacheStatus: "none", upstreamBytes: 0 },
    };
  }

  // Taste mode from here. The schema already requires a non-empty `channels`
  // when `taste` is true, but zod's `superRefine` does not narrow the
  // INFERRED type, so `args.channels` still types as optional here -- this
  // is a real, cheap guard (not a redundant cast) against ever reaching
  // `channels.length` on `undefined` if the SDK's own validation were ever
  // bypassed.
  if (!args.channels || args.channels.length === 0) {
    return { result: channelsRequiredResult() };
  }
  const channels = args.channels;

  if (!targetGroup.chunk_samples || !targetGroup.shard_samples) {
    return { result: noShardingGeometryResult(args.dataset_id, args.recording, targetGroup.name) };
  }
  const chunkSamples = targetGroup.chunk_samples;
  const shardSamples = targetGroup.shard_samples;

  if (
    exceedsChannelSamplesCap({
      channelCount: channels.length,
      windowSamples,
      cap: READ_WINDOW_TASTE_MAX_CHANNEL_SAMPLES,
    })
  ) {
    return {
      result: channelSamplesCapResult({
        datasetId: args.dataset_id,
        recording: args.recording,
        groupName: targetGroup.name,
        channelCount: channels.length,
        windowSamples,
        rate,
      }),
    };
  }

  // The decode budget, checked before any fetch. Distinct from the
  // channel-samples cap above: that one bounds the RESPONSE (the caller's
  // channels), this one bounds the WORK (the store's channels), and only the
  // second is what the isolate's memory actually sees.
  const storeChannelCount = targetGroup.n_channels ?? 0;
  if (
    exceedsDecodeBudget({
      storeChannelCount,
      windowSamples,
      cap: MAX_TASTE_DECODE_SAMPLES,
    })
  ) {
    return {
      result: decodeBudgetResult({
        datasetId: args.dataset_id,
        recording: args.recording,
        groupName: targetGroup.name,
        storeChannelCount,
        windowSamples,
        rate,
      }),
    };
  }

  // The footer entry count, computed once and BEFORE any fetch. It throws when a
  // v3 index reports a `shard_samples` that is not an exact multiple of
  // `chunk_samples`, which is a statement about someone else's published
  // geometry -- so it belongs in this file's typed-error vocabulary rather than
  // escaping as an opaque JSON-RPC internal error, and it is knowable from the
  // index alone, so it should not cost an array-metadata read first.
  let nInner: number;
  try {
    nInner = nInnerForShard({ shardSamples, chunkSamples });
  } catch (err) {
    return {
      result: toolError(
        `read_window cannot plan a read for group "${targetGroup.name}" of recording ` +
          `"${args.recording}" in dataset "${args.dataset_id}": ${err instanceof Error ? err.message : String(err)}`,
      ),
    };
  }

  const arrayMeta = await loadLevel0ArrayMetadata(
    deps,
    args.dataset_id,
    index.source_commit,
    row.zarr_converted_at,
    index.data_base,
    store.zarr,
    targetGroup.name,
  );
  if (!arrayMeta.ok) {
    return {
      result: toolError(
        `read_window could not read the level-0 array metadata for recording "${args.recording}" ` +
          `in dataset "${args.dataset_id}": ${arrayMeta.detail}`,
      ),
    };
  }
  const metadata: Level0ArrayMetadata = arrayMeta.metadata;
  if (metadata.scale.length < nChannelsGroup || metadata.offset.length < nChannelsGroup) {
    return {
      result: toolError(
        `level-0 array metadata for recording "${args.recording}" in dataset "${args.dataset_id}" carries scale[]/offset[] shorter than n_channels (${nChannelsGroup}); read_window cannot convert digital values to physical units.`,
      ),
    };
  }

  const read = await readLevel0Window({
    fetcher: deps.fetch,
    cache: mcpJsonCache(deps),
    key: {
      datasetId: args.dataset_id,
      sourceCommit: index.source_commit,
      convertedAt: row.zarr_converted_at,
    },
    dataBase: index.data_base,
    zarr: store.zarr,
    groupName: targetGroup.name,
    shardSamples,
    chunkSamples,
    nInner,
    nChannelsInStore: nChannelsGroup,
    nSamplesTotal: nSamplesGroup,
    startSample,
    endSampleExclusive: endSample,
  });
  if (!read.ok) {
    // The prefixes are the tool's own error texts; `mcp-read-window.test.ts` pins
    // `footer` and `chunk` (`plan` is unreachable from a route, see the test).
    const prefix = {
      footer: "could not read the shard index for recording",
      plan: "could not plan the shard read for recording",
      chunk: "could not read a chunk for recording",
    }[read.stage];
    return {
      result: toolError(
        `read_window ${prefix} "${args.recording}" in dataset ` +
          `"${args.dataset_id}": ${read.detail}`,
      ),
    };
  }
  const cacheHitEverywhere = arrayMeta.cacheStatus === "hit" && read.footersAllHit;
  const bytesRead = arrayMeta.upstreamBytes + read.bytes;
  const chunksRead = read.chunksRead;
  const segments = read.segments;

  let assembled: { values: number[][]; filledRanges: FilledRange[] };
  try {
    assembled = assembleTasteValues({
      channels,
      startSample,
      nSamples: windowSamples,
      segments,
      scale: metadata.scale,
      offset: metadata.offset,
      fillValue: 0,
      significantDigits: TASTE_SIGNIFICANT_DIGITS,
    });
  } catch (err) {
    return {
      result: toolError(
        `read_window failed to assemble the taste for recording "${args.recording}" in dataset ` +
          `"${args.dataset_id}": ${err instanceof Error ? err.message : String(err)}`,
      ),
    };
  }
  const { values, filledRanges } = assembled;
  const wireFilledRanges = toWireFilledRanges(filledRanges, rate);

  const channelSlice = { start: Math.min(...channels), end: Math.max(...channels) + 1 };
  const recipe = buildReadRecipe({
    index,
    store,
    groupName: targetGroup.name,
    level: "0",
    sampleSlice: { start: startSample, end: endSample },
    channelSlice,
    arrayMetadata: { data_type: metadata.dataType, codecs: metadata.codecs },
  });

  const built = buildEnvelopeForStore({
    indexFacts,
    sourceCommit: index.source_commit,
    indexEtag: indexResult.etag,
    row,
    store: envelopeStoreInput(store),
    group: targetGroup,
    dtype: metadata.dataType,
  });
  if (!built.envelope) {
    return {
      result: toolError(
        `internal: dataset "${args.dataset_id}" has a v3 index but no usable source_commit for its envelope`,
      ),
    };
  }

  const notes = [
    "values are rounded to six significant digits; see recipe for the exact byte-level read",
  ];
  if (wireFilledRanges.length > 0) {
    const totalFilled = filledRanges.reduce((sum, r) => sum + (r.end - r.start), 0);
    notes.push(
      `${wireFilledRanges.length} span(s) totalling ${totalFilled} sample(s) had no stored chunk and were filled with the channel's baseline offset rather than recorded signal -- see filled_ranges.`,
    );
  }

  const tasteOutput = {
    mode: "taste" as const,
    start_s: startSample / rate,
    duration_s: windowSamples / rate,
    channels,
    sample_rate_hz: rate,
    values,
    recipe,
    chunks_read: chunksRead,
    bytes_read: bytesRead,
    filled_ranges: wireFilledRanges,
    note: notes.join(" "),
    envelope: built.envelope,
  };
  const output = readWindowOutputSchema.parse(tasteOutput satisfies ReadWindowOutput);

  return {
    result: {
      content: [{ type: "text", text: buildTasteSummary(tasteOutput) }],
      structuredContent: output,
    },
    metrics: { cacheStatus: cacheHitEverywhere ? "hit" : "miss", upstreamBytes: bytesRead },
  };
}
