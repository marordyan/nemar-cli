/**
 * `list_recordings` (epic #1065 phase 3, issue #1295), plus the shared
 * recordings-projection machinery `get-events.ts` and `render-overview.ts`
 * reuse: `recordings` is one projection shared by every recording-level
 * tool, not `list_recordings`' alone -- a `list_recordings` call primes the
 * same cache entry `get_events`/`render_overview` read, and vice versa.
 *
 * Every call starts with the shared public-catalog row (`catalog-row.ts`):
 * unknown/private/sandboxed answers the shared not-found error, and a
 * dataset whose `zarr_status` is not `"ready"` (or whose `zarr_store_count`
 * is 0) answers the shared "not ready" error naming the actual status --
 * never an empty recordings list.
 *
 * The compact, UNFILTERED recording projection ({@link loadRecordingsProjection})
 * is built once per `(dataset_id, source_commit)` and cached
 * (`projection-cache.ts`); every filter (`modality`, `min_duration_s`,
 * `include_derived`) and pagination (`limit`/`offset`) is applied AFTER the
 * cache read, never baked into the cache key -- so two different filtered
 * views of the same commit share one cache entry. When the row's
 * `zarr_source_commit` is missing or not 40-hex, the projection cache is
 * bypassed entirely for this call (every such call is a `"miss"`, reported
 * as such) rather than keyed on a guess.
 *
 * A v1/v2 (legacy) index has no `source_tree`/`derived` at all; this tool
 * infers `source_tree: "raw"` and `derived: false` for every legacy store
 * EXCEPT one whose `path` falls under `derivatives/`, `sourcedata/`, or
 * `code/` (ADR 0027's raw-only rule, which a legacy index predates) --
 * those are excluded outright and counted in `excluded_legacy_non_raw_count`,
 * since the envelope builder (`envelope.ts`) refuses to describe one.
 */

import { z } from "zod";
import {
  type ListRecordingsInput,
  type ListRecordingsOutput,
  type RecordingGroupSummary,
  type RecordingSummary,
  listRecordingsOutputSchema,
  recordingSummarySchema,
} from "../../../../shared/contract/mcp.js";
import { SOURCE_COMMIT_RE, type ZarrGroup } from "../../../../shared/contract/zarr-index.js";
import { isV3Index } from "../../../../shared/zarr/index.js";
import {
  type PublicDatasetRow,
  datasetNotFoundResult,
  isZarrReady,
  loadPublicDatasetRow,
  zarrNotReadyResult,
} from "../catalog-row.js";
import {
  type EnvelopeIndexFacts,
  LEGACY_ENVELOPE_NOTE,
  NO_COMMIT_NOTE,
  buildEnvelopeForStore,
  isLegacyNonRawPath,
} from "../envelope.js";
import { type ZarrIndexDocument, readZarrIndex } from "../index-reader.js";
import { projectionUrl, readJsonProjection, writeJsonProjection } from "../projection-cache.js";
import type { RecordingToolDeps, ToolOutcome } from "../tool-types.js";

/** Zod mirror of {@link EnvelopeIndexFacts} (`envelope.ts`) -- kept here
 *  rather than importing a schema from `envelope.ts` (which stays a plain
 *  TS interface, read by every tool's call site) because this is the ONE
 *  place that needs it as a validator, for the cached `recordings`
 *  projection below. Must be kept in sync with `EnvelopeIndexFacts` by
 *  hand; both are small and change together in practice (a new index-level
 *  fact the envelope needs). */
const envelopeIndexFactsSchema = z.object({
  datasetId: z.string(),
  engineVersion: z.string(),
  doi: z.string().nullable(),
  license: z.string().nullable(),
  citation: z.string().nullable(),
  isLegacy: z.boolean(),
}) satisfies z.ZodType<EnvelopeIndexFacts>;

/** The cached `recordings` projection's payload shape, validated on every
 *  cache HIT (`projection-cache.ts`'s `readJsonProjection`) -- a mismatch
 *  (e.g. a deploy changed this shape without bumping
 *  `PROJECTION_SCHEMA_VERSION`) is a miss, not a crash. The FULL, unfiltered
 *  recording list is what gets cached, keyed by `(dataset_id,
 *  source_commit)`. Carries the index-level facts (`indexFacts`) alongside
 *  the per-store rows so a cache HIT can still build a dataset-level
 *  envelope without a second `index.json` fetch -- see `envelope.ts`'s
 *  module doc. */
export const recordingsProjectionSchema = z.object({
  formatVersion: z.number().int(),
  sourceCommit: z.string(),
  indexEtag: z.string().nullable(),
  discoveredCount: z.number().int().nullable(),
  failureCount: z.number().int().nullable(),
  pendingCount: z.number().int().nullable(),
  excludedLegacyNonRawCount: z.number().int(),
  note: z.string().nullable(),
  indexFacts: envelopeIndexFactsSchema,
  /** `index.events_parquet` verbatim (v3 only; `null` for a legacy index,
   *  which never has one) -- `get-events.ts`'s primary-path gate, cached
   *  here so a cache HIT never has to re-derive it from a fresh index read. */
  eventsParquetUrl: z.string().nullable(),
  /** `index.data_base` verbatim (v3 only; `null` for legacy) --
   *  `render_overview`'s chunk-fetch base, cached here for the same
   *  cache-hit-avoids-index.json reason as `eventsParquetUrl`. */
  dataBase: z.string().nullable(),
  recordings: z.array(recordingSummarySchema),
});
export type RecordingsProjection = z.infer<typeof recordingsProjectionSchema>;

function projectGroup(
  g: Pick<
    ZarrGroup,
    | "name"
    | "modality"
    | "rate"
    | "n_channels"
    | "duration_s"
    | "n_view_levels"
    | "n_samples"
    | "view_chunk_columns"
  >,
): RecordingGroupSummary {
  return {
    name: g.name,
    modality: g.modality ?? null,
    rate: g.rate ?? null,
    n_channels: g.n_channels ?? null,
    duration_s: g.duration_s ?? null,
    n_view_levels: g.n_view_levels ?? null,
    n_samples: g.n_samples ?? null,
    view_chunk_columns: g.view_chunk_columns ?? null,
  };
}

function buildProjection(
  index: ZarrIndexDocument,
  formatVersion: number,
  indexEtag: string | null,
  sourceCommit: string,
): RecordingsProjection {
  if (isV3Index(index)) {
    const recordings: RecordingSummary[] = index.stores.map((store) => ({
      path: store.path,
      zarr: store.zarr,
      source_tree: "raw",
      derived: store.derived,
      groups: store.groups?.map(projectGroup),
      n_events: store.n_events,
      modalities: store.modalities,
      // ADR 0028: present exactly when derived is true. Carried through so
      // the envelope builder can describe a derived (SSS-filtered MEG)
      // store from this cached projection alone -- dropping these here
      // made computeProvenanceEnvelope's sss-iff-derived refinement throw
      // for every derived store's envelope (found in PR review).
      sss: store.sss,
      units_report: store.units_report,
    }));
    return {
      formatVersion,
      sourceCommit,
      indexEtag,
      discoveredCount: index.discovered_count,
      failureCount: index.failure_count,
      pendingCount: index.pending_count,
      excludedLegacyNonRawCount: 0,
      note: null,
      indexFacts: {
        datasetId: index.dataset_id,
        engineVersion: index.engine_version,
        doi: index.doi ?? null,
        license: index.license ?? null,
        citation: index.citation ?? null,
        isLegacy: false,
      },
      eventsParquetUrl: index.events_parquet ?? null,
      dataBase: index.data_base,
      recordings,
    };
  }

  let excludedLegacyNonRawCount = 0;
  const recordings: RecordingSummary[] = [];
  for (const store of index.stores) {
    if (isLegacyNonRawPath(store.path)) {
      excludedLegacyNonRawCount++;
      continue;
    }
    recordings.push({
      path: store.path,
      zarr: store.zarr,
      source_tree: "raw",
      derived: false,
      groups: store.groups?.map(projectGroup),
      modalities: store.modalities,
    });
  }
  return {
    formatVersion,
    sourceCommit,
    indexEtag,
    discoveredCount: null,
    failureCount: null,
    pendingCount: null,
    excludedLegacyNonRawCount,
    note: LEGACY_ENVELOPE_NOTE,
    indexFacts: {
      datasetId: index.dataset_id,
      engineVersion: String(formatVersion),
      doi: null,
      license: null,
      citation: null,
      isLegacy: true,
    },
    eventsParquetUrl: null,
    dataBase: null,
    recordings,
  };
}

/** Case-insensitive equality against any group's `modality`, or against any
 *  entry of the store's own `modalities` array (both v3 and legacy stores
 *  carry it; see the projection entry's passthrough `modalities` field). */
function matchesModality(recording: RecordingSummary, modality: string): boolean {
  const wanted = modality.toLowerCase();
  const groupHit = (recording.groups ?? []).some(
    (g) => (g.modality ?? "").toLowerCase() === wanted,
  );
  if (groupHit) return true;
  const storeModalities = (recording as { modalities?: string[] }).modalities ?? [];
  return storeModalities.some((m) => m.toLowerCase() === wanted);
}

function maxGroupDuration(recording: RecordingSummary): number {
  return (recording.groups ?? []).reduce((max, g) => Math.max(max, g.duration_s ?? 0), 0);
}

/** The distinct modality vocabulary a dataset's recordings actually report
 *  (group `modality` plus each store's own `modalities` array) -- surfaced
 *  in `note` when a `modality` filter matches nothing, the same
 *  "a count of 0 is not an error, here is the real vocabulary" teaching
 *  `search_datasets` already gives a caller. */
function collectKnownModalities(recordings: RecordingSummary[]): string[] {
  const known = new Set<string>();
  for (const recording of recordings) {
    for (const group of recording.groups ?? []) {
      if (group.modality) known.add(group.modality);
    }
    for (const modality of (recording as { modalities?: string[] }).modalities ?? []) {
      known.add(modality);
    }
  }
  return Array.from(known).sort();
}

function indexMissingResult(datasetId: string, row: PublicDatasetRow): ToolOutcome["result"] {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `Dataset "${datasetId}" reports zarr_status "${row.zarr_status}" but its index.json could not be found -- this is a transient inconsistency; try again shortly.`,
      },
    ],
  };
}

export type LoadRecordingsProjectionResult =
  | {
      ok: true;
      projection: RecordingsProjection;
      cacheStatus: "hit" | "miss";
      upstreamBytes: number;
    }
  | { ok: false; result: ToolOutcome["result"] };

/**
 * Shared by all three recording-level tools: try the `recordings` cache
 * entry first (skipped entirely when the D1 row's `zarr_source_commit` is
 * missing or not 40-hex); on a miss, read+parse `index.json` and build the
 * projection, writing it back to the cache when the commit is usable.
 *
 * Does NOT check `isZarrReady`/not-found -- callers do that first (they all
 * need the row for other reasons too, e.g. the envelope's catalog facts),
 * so this only ever runs against a row already known public and converted.
 */
export async function loadRecordingsProjection(
  deps: RecordingToolDeps,
  row: PublicDatasetRow,
  datasetId: string,
): Promise<LoadRecordingsProjectionResult> {
  const commitUsable = Boolean(
    row.zarr_source_commit && SOURCE_COMMIT_RE.test(row.zarr_source_commit),
  );

  if (commitUsable) {
    const cacheKey = projectionUrl({
      env: deps.env,
      datasetId,
      sourceCommit: row.zarr_source_commit as string,
      convertedAt: row.zarr_converted_at,
      projection: "recordings",
    });
    const cached = await readJsonProjection(deps.cache(), cacheKey, recordingsProjectionSchema);
    if (cached.status === "hit") {
      return { ok: true, projection: cached.value, cacheStatus: "hit", upstreamBytes: 0 };
    }
  }

  const indexResult = await readZarrIndex(deps, deps.env, deps.executionCtx, datasetId);
  if (indexResult.status === "not_found") {
    return { ok: false, result: indexMissingResult(datasetId, row) };
  }
  if (indexResult.status === "invalid") {
    return {
      ok: false,
      result: {
        isError: true,
        content: [
          {
            type: "text",
            text: `index.json for "${datasetId}" could not be read: ${indexResult.detail}`,
          },
        ],
      },
    };
  }
  if (indexResult.status === "too_large") {
    // A deliberate decline with the public URL in it, not a read failure -- the
    // document is fine, this server just will not parse it inline.
    return {
      ok: false,
      result: {
        isError: true,
        content: [{ type: "text", text: `list_recordings declines: ${indexResult.detail}` }],
      },
    };
  }

  const projection = buildProjection(
    indexResult.index,
    indexResult.formatVersion,
    indexResult.etag,
    indexResult.sourceCommit ?? "",
  );
  if (commitUsable && indexResult.sourceCommit) {
    const cacheKey = projectionUrl({
      env: deps.env,
      datasetId,
      sourceCommit: indexResult.sourceCommit,
      convertedAt: row.zarr_converted_at,
      projection: "recordings",
    });
    writeJsonProjection(deps.executionCtx, deps.cache(), cacheKey, projection);
  }
  return { ok: true, projection, cacheStatus: "miss", upstreamBytes: indexResult.bytes };
}

/** Resolve a `recording` argument (a store's `path` or `zarr`) against the
 *  projection. Shared verbatim by `get_events` and `render_overview`. */
export function resolveRecording(
  projection: RecordingsProjection,
  recording: string,
): RecordingSummary | undefined {
  return projection.recordings.find((r) => r.path === recording || r.zarr === recording);
}

/** The identical "unknown group" tool error `get_events` and
 *  `render_overview` both answer: the group name the caller asked for does
 *  not exist on this recording, alongside the recording's actual group
 *  names -- shared here so the wording, and the resolution rule it
 *  describes (an explicit `group` must match a real group name; omitted
 *  means the first group), cannot drift between the two tools. */
export function groupNotFoundResult(
  datasetId: string,
  recording: string,
  wanted: string,
  available: string[],
): ToolOutcome["result"] {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text:
          `Recording "${recording}" in dataset "${datasetId}" has no group named "${wanted}". ` +
          `Available groups: ${available.join(", ") || "(none)"}.`,
      },
    ],
  };
}

/** The identical "unknown recording" tool error `get_events` and
 *  `render_overview` both answer: up to 20 of the dataset's actual `zarr`
 *  identifiers, so a caller can retry with a real one instead of guessing
 *  again blind. */
export function recordingNotFoundResult(
  datasetId: string,
  recording: string,
  projection: RecordingsProjection,
): ToolOutcome["result"] {
  const sample = projection.recordings.slice(0, 20).map((r) => r.zarr);
  const more =
    projection.recordings.length > 20 ? ` (and ${projection.recordings.length - 20} more)` : "";
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `Recording "${recording}" was not found in dataset "${datasetId}" (matched against each recording's path or zarr field). Known recordings: ${sample.join(", ") || "(none)"}${more}.`,
      },
    ],
  };
}

export async function listRecordingsTool(
  deps: RecordingToolDeps,
  args: ListRecordingsInput,
): Promise<ToolOutcome> {
  const row = await loadPublicDatasetRow(deps.env.DB, args.dataset_id);
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
  const { projection, cacheStatus, upstreamBytes } = loaded;
  const sourceCommitFinal = projection.sourceCommit || null;

  let filtered = projection.recordings;
  let excludedDerivedCount = 0;
  if (!args.include_derived) {
    const before = filtered.length;
    filtered = filtered.filter((r) => !r.derived);
    excludedDerivedCount = before - filtered.length;
  }
  if (args.modality) {
    filtered = filtered.filter((r) => matchesModality(r, args.modality as string));
  }
  if (args.min_duration_s !== undefined) {
    const minDuration = args.min_duration_s;
    filtered = filtered.filter((r) => maxGroupDuration(r) >= minDuration);
  }

  const totalCount = filtered.length;
  const page = filtered.slice(args.offset, args.offset + args.limit);

  let note = projection.note;
  if (!sourceCommitFinal) {
    note = note ? `${note} ${NO_COMMIT_NOTE}` : NO_COMMIT_NOTE;
  }
  if (args.modality && totalCount === 0) {
    const known = collectKnownModalities(projection.recordings);
    const modalityNote = `no recording matched modality "${args.modality}"; this dataset's groups report: ${known.join(", ") || "(none)"}.`;
    note = note ? `${note} ${modalityNote}` : modalityNote;
  }

  let envelope: ListRecordingsOutput["envelope"];
  if (page.length > 0 && sourceCommitFinal) {
    const first = page[0];
    const built = buildEnvelopeForStore({
      indexFacts: projection.indexFacts,
      sourceCommit: sourceCommitFinal,
      indexEtag: projection.indexEtag,
      row,
      store: {
        path: first.path,
        source_tree: first.source_tree,
        derived: first.derived,
        sss: first.sss,
        units_report: first.units_report,
      },
      group: first.groups?.[0],
      dtype: null,
    });
    envelope = built.envelope ?? undefined;
  }

  const output = listRecordingsOutputSchema.parse({
    dataset_id: args.dataset_id,
    source_commit: sourceCommitFinal,
    recordings: page,
    total_count: totalCount,
    excluded_derived_count: excludedDerivedCount,
    limit: args.limit,
    offset: args.offset,
    index_format_version: projection.formatVersion,
    discovered_count: projection.discoveredCount,
    failure_count: projection.failureCount,
    pending_count: projection.pendingCount,
    excluded_legacy_non_raw_count: projection.excludedLegacyNonRawCount,
    note,
    envelope,
  } satisfies ListRecordingsOutput);

  return {
    result: {
      content: [{ type: "text", text: JSON.stringify(output) }],
      structuredContent: output,
    },
    metrics: { cacheStatus, upstreamBytes },
  };
}
