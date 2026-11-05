/**
 * `render_overview` (epic #1065 phase 3, issue #1295).
 *
 * Reads the `view/*` min-max pyramid, never level 0 and never `zarr.json`
 * -- every fact needed (level count, level-0 sample count, channel count,
 * chunk size) comes off the recording's group entry in the shared
 * `recordings` projection (`list-recordings.ts`), which is itself cached
 * per `(dataset_id, source_commit)`, so a `render_overview` call on a warm
 * dataset costs one D1 read, one `recordings` cache match, and (on an
 * `overview/*` cache MISS) exactly `chunks_read` chunk fetches -- nothing
 * else. `pickViewLevel` (`overview.ts`) always returns the COARSEST level
 * satisfying `width_px`, so the Worker never decodes more samples than the
 * image needs.
 *
 * The rendered PNG is cached whole under
 * `overview/<zarr>/<group>/<level>/<served width>`, where the served width is
 * the request's `width_px` rounded UP to the next render bucket
 * (`quantizeWidthPx`). Keyed on the raw `width_px` instead, a caller walking
 * 1..4000 forced up to 4000 distinct renders and cache writes per
 * (recording, group), each one re-fetching the same view chunks straight from
 * S3 with no edge cache in front. A cache HIT skips the chunk fetch,
 * the blosc decode, and the PNG encode entirely -- `level`/`width_px`/
 * `height_px` are still recomputed (cheap, no I/O: pure functions of
 * already-cached group metadata) so the response metadata is always
 * present, but `columns_read`/`chunks_read`/`bytes_read` are all `0` on a
 * hit, since nothing was actually read this call.
 */

import type { CallToolResult } from "@modelcontextprotocol/server";
import {
  type RenderOverviewInput,
  type RenderOverviewOutput,
  renderOverviewOutputSchema,
} from "../../../../shared/contract/mcp.js";
import type { RecordingGroupSummary } from "../../../../shared/contract/mcp.js";
import { decodeBloscZstdInt16 } from "../../../../shared/zarr/codecs/blosc.js";
import {
  type PublicDatasetRow,
  datasetNotFoundResult,
  isZarrReady,
  loadPublicDatasetRow,
  zarrNotReadyResult,
} from "../catalog-row.js";
import { buildEnvelopeForStore } from "../envelope.js";
import {
  MAX_OVERVIEW_CHUNKS,
  buildChunkPlan,
  computeRowPx,
  computeViewLevelColumns,
  pickViewLevel,
  quantizeWidthPx,
  reassembleViewChunks,
  renderOverviewPng,
} from "../overview.js";
import { projectionUrl, readBinaryProjection, writeBinaryProjection } from "../projection-cache.js";
import type { RecordingToolDeps, ToolOutcome } from "../tool-types.js";
import {
  type RecordingsProjection,
  groupNotFoundResult,
  loadRecordingsProjection,
  recordingNotFoundResult,
  resolveRecording,
} from "./list-recordings.js";

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function toolError(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

/** Distinct from "group not found": the group exists but was converted
 *  before biosigio 1.2.6 (or came from a legacy index), so it has no
 *  `view/*` pyramid to read at all. */
function noPyramidResult(datasetId: string, recording: string, groupName: string): CallToolResult {
  return toolError(
    `Group "${groupName}" of recording "${recording}" in dataset "${datasetId}" has no view/* pyramid published (a legacy index, or a store converted before biosigio 1.2.6). render_overview needs a pyramid; list_recordings reports each group's n_view_levels.`,
  );
}

function missingGeometryResult(
  datasetId: string,
  recording: string,
  groupName: string,
): CallToolResult {
  return toolError(
    `Group "${groupName}" of recording "${recording}" in dataset "${datasetId}" is missing the sample count or channel count render_overview needs to plan a pyramid read.`,
  );
}

function missingIndexFactsResult(datasetId: string): CallToolResult {
  return toolError(
    `Dataset "${datasetId}"'s index.json carries no usable source_commit or data_base; render_overview cannot fetch pyramid chunks for it.`,
  );
}

/** The plan would fan out past {@link MAX_OVERVIEW_CHUNKS}. Names the pyramid
 *  rather than the request, because a shallow pyramid is not something a smaller
 *  `width_px` can work around: `pickViewLevel` returns level 1 regardless when
 *  that is the only level published. */
function chunkPlanTooLargeResult(
  datasetId: string,
  recording: string,
  groupName: string,
  chunkCount: number,
  level: number,
): CallToolResult {
  return toolError(
    `render_overview declines recording "${recording}" group "${groupName}" in dataset "${datasetId}": the chosen view level ${level} would need ${chunkCount} chunk reads, over the ${MAX_OVERVIEW_CHUNKS}-chunk limit. This group's pyramid is too shallow for a recording this long, so a smaller width_px does not reduce the read (level ${level} is the only candidate); the store needs re-converting with more view levels.`,
  );
}

function chunkFetchFailedResult(
  datasetId: string,
  recording: string,
  detail: string,
): CallToolResult {
  return toolError(
    `render_overview could not read the view pyramid for recording "${recording}" in dataset ` +
      `"${datasetId}": ${detail}`,
  );
}

export async function renderOverviewTool(
  deps: RecordingToolDeps,
  args: RenderOverviewInput,
): Promise<ToolOutcome> {
  const row: PublicDatasetRow | null = await loadPublicDatasetRow(deps.env.DB, args.dataset_id);
  if (!row) {
    return { result: datasetNotFoundResult(args.dataset_id) };
  }
  if (!isZarrReady(row)) {
    return { result: zarrNotReadyResult(args.dataset_id, row) };
  }

  const loaded = await loadRecordingsProjection(deps, row, args.dataset_id);
  if (!loaded.ok) {
    return { result: loaded.result };
  }
  const { projection, upstreamBytes: recordingsBytes } = loaded;

  const matched = resolveRecording(projection, args.recording);
  if (!matched) {
    return { result: recordingNotFoundResult(args.dataset_id, args.recording, projection) };
  }

  const groups: RecordingGroupSummary[] = matched.groups ?? [];
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

  const nViewLevels = targetGroup.n_view_levels ?? 0;
  if (nViewLevels < 1) {
    return { result: noPyramidResult(args.dataset_id, args.recording, targetGroup.name) };
  }
  const nSamples = targetGroup.n_samples;
  const nChannels = targetGroup.n_channels;
  if (!nSamples || nSamples < 1 || !nChannels || nChannels < 1) {
    return { result: missingGeometryResult(args.dataset_id, args.recording, targetGroup.name) };
  }

  const sourceCommitFinal = projection.sourceCommit || null;
  const dataBase = projection.dataBase;
  if (!sourceCommitFinal || !dataBase) {
    return { result: missingIndexFactsResult(args.dataset_id) };
  }

  // Level selection uses the caller's RAW width, deliberately. Choosing the
  // level from the rounded-up width would read a FINER level than asked for --
  // width_px 100 on nm000329 would jump from level 5 (135 columns) to level 4
  // (541), quadrupling the read to satisfy a request that got smaller. The
  // rounding exists to bound cache keys, not to change what gets read.
  const level = pickViewLevel(nSamples, nViewLevels, args.width_px);
  const levelColumns = computeViewLevelColumns(nSamples, nViewLevels)[level - 1];
  // ...and the served width is floored at the level's own column count, so it
  // is always a pure downsample of what was read, never an upscale, and two
  // requests that resolve to the same level and bucket share one entry.
  const servedWidthPx = Math.min(quantizeWidthPx(args.width_px), levelColumns);

  // The key carries the LEVEL and a QUANTIZED width, not the caller's raw
  // `width_px`. Keyed on the raw value, a caller walking width_px 1..4000
  // forced up to 4000 distinct renders and 4000 Cache API writes per
  // (recording, group), each re-fetching the identical view chunks straight
  // from S3 with no edge cache in front -- a write amplifier and an S3
  // amplifier over the same bytes. The ladder bounds that to one entry per
  // (level, bucket). The level belongs in the key too: it is what determines
  // which chunks were read.
  const cacheKey = projectionUrl({
    env: deps.env,
    datasetId: args.dataset_id,
    sourceCommit: sourceCommitFinal,
    convertedAt: row.zarr_converted_at,
    projection: `overview/${matched.zarr}/${targetGroup.name}/${level}/${servedWidthPx}`,
  });
  const cached = await readBinaryProjection(deps.cache(), cacheKey);

  const rowPx = computeRowPx(nChannels);
  const heightPx = nChannels * rowPx + Math.max(0, nChannels - 1);

  let pngBytes: Uint8Array;
  let cacheStatus: "hit" | "miss";
  let columnsRead = 0;
  let chunksRead = 0;
  let bytesRead = 0;

  if (cached.status === "hit") {
    pngBytes = cached.bytes;
    cacheStatus = "hit";
  } else {
    const chunkPlan = buildChunkPlan({
      level,
      levelColumns,
      viewChunkColumns: targetGroup.view_chunk_columns,
    });

    if (chunkPlan.chunkKeys.length > MAX_OVERVIEW_CHUNKS) {
      return {
        result: chunkPlanTooLargeResult(
          args.dataset_id,
          args.recording,
          targetGroup.name,
          chunkPlan.chunkKeys.length,
          level,
        ),
      };
    }

    let decodedChunks: Int16Array[];
    try {
      decodedChunks = await Promise.all(
        chunkPlan.chunkKeys.map(async (key) => {
          const url = `${dataBase}${matched.zarr}/${targetGroup.name}/${key}`;
          const response = await deps.fetch(url);
          if (!response.ok) {
            throw new Error(`HTTP ${response.status} fetching ${url}`);
          }
          const buf = new Uint8Array(await response.arrayBuffer());
          bytesRead += buf.byteLength;
          return decodeBloscZstdInt16(buf);
        }),
      );
    } catch (err) {
      return {
        result: chunkFetchFailedResult(
          args.dataset_id,
          args.recording,
          err instanceof Error ? err.message : String(err),
        ),
      };
    }

    // Inside the try, not after it. `reassembleViewChunks` throws when a store's
    // real geometry disagrees with what the index reported, and that is a
    // fidelity problem about someone else's data, not a bug in this request --
    // so it has to come back as this file's typed tool error like every other
    // failure here. Left outside, it escaped as an opaque JSON-RPC internal
    // error, which is how the padded-boundary-chunk defect presented.
    let rendered: { png: Uint8Array };
    try {
      const reassembled = reassembleViewChunks({
        nChannels,
        totalColumns: levelColumns,
        chunkColumns: chunkPlan.chunkColumns,
        chunks: decodedChunks,
      });
      rendered = renderOverviewPng({
        nChannels,
        totalColumns: levelColumns,
        widthPx: servedWidthPx,
        data: reassembled,
      });
    } catch (err) {
      return {
        result: chunkFetchFailedResult(
          args.dataset_id,
          args.recording,
          err instanceof Error ? err.message : String(err),
        ),
      };
    }
    pngBytes = rendered.png;
    columnsRead = levelColumns;
    chunksRead = chunkPlan.chunkKeys.length;
    cacheStatus = "miss";

    writeBinaryProjection(deps.executionCtx, deps.cache(), cacheKey, pngBytes, "image/png");
  }

  const built = buildEnvelopeForStore({
    indexFacts: projection.indexFacts,
    sourceCommit: sourceCommitFinal,
    indexEtag: projection.indexEtag,
    row,
    store: {
      path: matched.path,
      source_tree: matched.source_tree,
      derived: matched.derived,
      sss: matched.sss,
      units_report: matched.units_report,
    },
    group: targetGroup,
    // ALWAYS null. `dtype` is the LEVEL-0 array's dtype as read from its own
    // zarr.json, and this tool reads the view/* pyramid and never zarr.json --
    // its own module doc says so. The view arrays it decodes are int16, but
    // reporting that here would answer a different question under the same
    // field name, and it made the field mean one thing on a cache miss, another
    // on a hit, and a third in read_window. Only read_window can populate it.
    dtype: null,
  });

  const metadata = renderOverviewOutputSchema.parse({
    dataset_id: args.dataset_id,
    recording: args.recording,
    group: targetGroup.name,
    level,
    // The SERVED width, which is the requested one rounded UP to the next
    // render bucket -- always >= what was asked for, and always the PNG's real
    // width, which is what this field has always meant.
    width_px: servedWidthPx,
    height_px: heightPx,
    mime_type: "image/png",
    columns_read: columnsRead,
    chunks_read: chunksRead,
    bytes_read: bytesRead,
    envelope: built.envelope ?? undefined,
  } satisfies RenderOverviewOutput);

  return {
    result: {
      content: [
        { type: "image", data: bytesToBase64(pngBytes), mimeType: "image/png" },
        { type: "text", text: JSON.stringify(metadata) },
      ],
      structuredContent: metadata,
    },
    metrics: { cacheStatus, upstreamBytes: bytesRead + recordingsBytes },
  };
}

/** Re-exported for `mcp-overview.test.ts`, which drives `render_overview`
 *  through the real route and needs the projection type to build fixtures
 *  in the same shape this tool reads. */
export type { RecordingsProjection };
