/**
 * Where the engine's data comes from, and how a dataset becomes a bound recording.
 *
 * {@link DataSource} is the seam: it resolves a dataset to its Zarr index, a fetcher for the
 * bytes, a cache for the read core's JSON, and the dataset's records. Phase 4 has one
 * implementation, {@link publicSource}, which serves public Zarr from `NEMAR_ZARR_BASE`
 * and never sends a credential. `server.ts` and `window.ts` see only the interface, so a
 * private source can be added without rewriting them. The rule for credentials when one is
 * added is in ADR 0120: per request, only to an origin `src/lib/data-hosts.ts` admits, never
 * because "this dataset is private", never across a redirect, and never from the index's
 * `data_base`, which is a published document.
 *
 * {@link openRecording} turns a dataset id and a recording into a {@link Binding}: the
 * `opened` fields (the BIDS path, the neuroschema `record`, the representations) and what
 * the window reader needs (the index, store, group and geometry). Failures are
 * {@link SourceFailure}s that carry the protocol error code (ADR 0120 decisions 4 and 5):
 *
 *   index 404, unknown recording or representation, no zarr group  -> not_found
 *   a legacy index (format_version other than 3)                   -> not_ready
 *   index 5xx, network failure, unparseable index, a group the
 *   index does not describe well enough, bad array metadata        -> upstream_error
 *
 * The record is best effort (ADR 0005, ADR 0077): a missing, unreadable or malformed
 * `records.json` gives `record: null` and one warning line, never a failed open.
 */

import { z } from "zod";
import { dataPlaneVersionListingSchema } from "../../../shared/contract/data-plane.js";
import type {
  BoundZarrRepresentation,
  EngineErrorCode,
  ZarrRepresentation,
} from "../../../shared/contract/zarr-engine-protocol.js";
import {
  DATASET_ID_RE,
  type ZarrGroup,
  type ZarrStore,
  zarrIndexLegacySchema,
  zarrIndexSchema,
} from "../../../shared/contract/zarr-index.js";
import { loadLevel0ArrayMetadata } from "../../../shared/zarr/array-metadata.js";
import type { CacheKey, Fetcher, JsonCache } from "../../../shared/zarr/interfaces.js";
import { nInnerForShard } from "../../../shared/zarr/sharding.js";
import {
  DEFAULT_RANGE_CACHE_BYTES,
  type EngineBases,
  MemoryJsonCache,
  RangeCache,
  type SourceKind,
  checkHost,
  createPublicFetcher,
  fetchJsonDocument,
  resolveBases,
  withRangeCache,
} from "./http.js";

/** The most `index.json` the engine parses: the MCP's bound (`MAX_INDEX_BYTES`), which clears
 *  the largest index in the catalog (12.8 MB) with headroom. */
export const MAX_INDEX_BYTES = 24 * 1024 * 1024;
const MAX_LISTING_BYTES = 1024 * 1024;
const MAX_RECORDS_BYTES = 64 * 1024 * 1024;

/**
 * The v3 index schema with the two base URLs relaxed from "https" to "any string". The shared
 * schema is the producer's contract and stays untouched; the engine applies its own host rule
 * (`checkHost`: https, or http to loopback) to `data_base` instead, so a test can stand an
 * origin up on 127.0.0.1 and nothing else changes.
 */
const engineIndexSchema = zarrIndexSchema.extend({
  contract_base: z.string(),
  data_base: z.string(),
});
export type EngineIndex = z.infer<typeof engineIndexSchema>;

export interface SourceFailure {
  ok: false;
  code: EngineErrorCode;
  message: string;
}
export type SourceResult<T> = { ok: true; value: T } | SourceFailure;

function fail(code: EngineErrorCode, message: string): SourceFailure {
  return { ok: false, code, message };
}

export type IndexOutcome =
  | { status: "ok"; index: EngineIndex }
  | { status: "legacy"; formatVersion: number }
  | { status: "not_found" }
  | { status: "error"; detail: string };

export type RecordsOutcome =
  | { status: "ok"; records: unknown[] }
  | { status: "unavailable"; detail: string };

/** Everything the engine needs from a place that holds datasets. */
export interface DataSource {
  readonly kind: SourceKind;
  /** Fetches the data bytes and `zarr.json` for the read core. */
  readonly fetcher: Fetcher;
  /** Caches the read core's footers and array metadata. */
  readonly jsonCache: JsonCache;
  /** The dataset's Zarr index, parsed; kept for the life of the process once read. */
  readIndex(datasetId: string): Promise<IndexOutcome>;
  /** The dataset's latest published `records.json`. */
  readRecords(datasetId: string): Promise<RecordsOutcome>;
}

/** Parse an index document: v3 against the engine schema, any other format_version as legacy. */
export function parseIndexDocument(doc: unknown, datasetId: string): IndexOutcome {
  const claimsV3 =
    typeof doc === "object" &&
    doc !== null &&
    (doc as { format_version?: unknown }).format_version === 3;
  if (claimsV3) {
    const parsed = engineIndexSchema.safeParse(doc);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return {
        status: "error",
        detail: `index.json for ${datasetId} is not a valid v3 index: ${issue?.path.join(".")} ${issue?.message}`,
      };
    }
    if (parsed.data.dataset_id !== datasetId) {
      return {
        status: "error",
        detail: `index.json for ${datasetId} names dataset ${parsed.data.dataset_id}`,
      };
    }
    const dataBase = checkHost(parsed.data.data_base);
    if (!dataBase.ok) {
      return { status: "error", detail: `index.json data_base is not allowed: ${dataBase.reason}` };
    }
    return { status: "ok", index: parsed.data };
  }
  const legacy = zarrIndexLegacySchema.safeParse(doc);
  if (legacy.success) return { status: "legacy", formatVersion: legacy.data.format_version };
  return { status: "error", detail: `index.json for ${datasetId} is not a Zarr index` };
}

export interface PublicSourceOptions {
  bases?: EngineBases;
  /** Bound on cached `206` bodies, in bytes. */
  rangeCacheBytes?: number;
}

/** The public source: Zarr from `NEMAR_ZARR_BASE`, records from the data plane, no credentials. */
export function publicSource(options: PublicSourceOptions = {}): DataSource {
  const bases = options.bases ?? resolveBases();
  const rangeCache = new RangeCache("public", options.rangeCacheBytes ?? DEFAULT_RANGE_CACHE_BYTES);
  const fetcher = withRangeCache(createPublicFetcher(), rangeCache);
  const jsonCache = new MemoryJsonCache("public");
  const indexes = new Map<string, EngineIndex>();
  const records = new Map<string, unknown[]>();

  return {
    kind: "public",
    fetcher,
    jsonCache,

    async readIndex(datasetId) {
      const cached = indexes.get(datasetId);
      if (cached) return { status: "ok", index: cached };
      const url = `${bases.zarrBase}/${datasetId}/zarr/index.json`;
      const fetched = await fetchJsonDocument(fetcher, url, MAX_INDEX_BYTES);
      if (fetched.status === "not_found") return { status: "not_found" };
      if (fetched.status === "error") return { status: "error", detail: fetched.detail };
      const outcome = parseIndexDocument(fetched.doc, datasetId);
      if (outcome.status === "ok") indexes.set(datasetId, outcome.index);
      return outcome;
    },

    async readRecords(datasetId) {
      const cached = records.get(datasetId);
      if (cached) return { status: "ok", records: cached };
      const listingUrl = `${bases.dataPlaneBase}/${datasetId}`;
      const listing = await fetchJsonDocument(fetcher, listingUrl, MAX_LISTING_BYTES);
      if (listing.status !== "ok") {
        return {
          status: "unavailable",
          detail: listing.status === "error" ? listing.detail : `${listingUrl} not found`,
        };
      }
      const parsed = dataPlaneVersionListingSchema.safeParse(listing.doc);
      if (!parsed.success) {
        return { status: "unavailable", detail: `${listingUrl} is not a version listing` };
      }
      const latest = parsed.data.latest || parsed.data.versions[0]?.version;
      if (!latest) return { status: "unavailable", detail: `${listingUrl} lists no version` };
      const url = `${listingUrl}/${encodeURIComponent(latest)}/records.json`;
      const doc = await fetchJsonDocument(fetcher, url, MAX_RECORDS_BYTES);
      if (doc.status !== "ok") {
        return {
          status: "unavailable",
          detail: doc.status === "error" ? doc.detail : `${url} not found`,
        };
      }
      if (!Array.isArray(doc.doc)) {
        return { status: "unavailable", detail: `${url} is not an array of records` };
      }
      records.set(datasetId, doc.doc);
      return { status: "ok", records: doc.doc };
    },
  };
}

/** The read geometry of a bound group, checked once at open. */
export interface GroupGeometry {
  rate: number;
  nChannels: number;
  nSamples: number;
  chunkSamples: number;
  shardSamples: number;
  nInner: number;
}

/** What an `open` produced: the `opened` fields and what the window reader reads from. */
export interface Binding {
  datasetId: string;
  /** The BIDS path, even when `open` named the store's zarr path. */
  recording: string;
  representationId: string;
  record: Record<string, unknown> | null;
  representations: ZarrRepresentation[];
  bound: BoundZarrRepresentation;
  index: EngineIndex;
  store: ZarrStore;
  group: ZarrGroup;
  geometry: GroupGeometry;
  /** `index.data_base` with a trailing slash, as the read core joins it. */
  dataBase: string;
  /** Dataset identity for the read core's cache entries. */
  cacheKey: Omit<CacheKey, "projection">;
}

const positive = (n: number | null | undefined): number | null =>
  typeof n === "number" && n > 0 ? n : null;
const atLeastOne = (n: number | null | undefined): number | null =>
  typeof n === "number" && n >= 1 ? n : null;

/** One `zarr` representation per group, with null where the index has no usable value.
 *  `scale` and `offset` are null here; only the bound representation gets them. */
export function representationsFor(store: ZarrStore): ZarrRepresentation[] {
  return (store.groups ?? []).map((g) => ({
    kind: "zarr" as const,
    id: g.name,
    store: store.zarr,
    modality: g.modality ?? null,
    sampling_frequency: positive(g.rate),
    source_sampling_frequency: positive(g.source_rate_hz),
    nchans: atLeastOne(g.n_channels),
    ntimes: atLeastOne(g.n_samples),
    recording_duration: g.duration_s ?? null,
    scale: null,
    offset: null,
  }));
}

/** The record whose `bids_relpath` is the recording, passed through as published. */
function pickRecord(records: unknown[], bidsPath: string): Record<string, unknown> | null {
  for (const r of records) {
    if (
      typeof r === "object" &&
      r !== null &&
      !Array.isArray(r) &&
      (r as { bids_relpath?: unknown }).bids_relpath === bidsPath
    ) {
      return r as Record<string, unknown>;
    }
  }
  return null;
}

export async function openRecording(
  source: DataSource,
  request: { datasetId: string; recording: string; representation?: string },
  warn: (line: string) => void = (line) => console.error(line),
): Promise<SourceResult<Binding>> {
  const { datasetId, recording } = request;
  if (!DATASET_ID_RE.test(datasetId)) return fail("not_found", `no dataset ${datasetId}`);

  const outcome = await source.readIndex(datasetId);
  if (outcome.status === "not_found") {
    return fail(
      "not_found",
      `dataset ${datasetId} has no Zarr index (unknown, private or unpublished)`,
    );
  }
  if (outcome.status === "error") return fail("upstream_error", outcome.detail);
  if (outcome.status === "legacy") {
    return fail(
      "not_ready",
      `dataset ${datasetId} still publishes index format ${outcome.formatVersion}; it is waiting for re-conversion`,
    );
  }
  const index = outcome.index;

  const store = index.stores.find((s) => s.path === recording || s.zarr === recording);
  if (!store) return fail("not_found", `recording ${recording} is not in dataset ${datasetId}`);

  const representations = representationsFor(store);
  if (representations.length === 0) {
    return fail("not_found", `recording ${store.path} has no zarr representation`);
  }
  const wanted = request.representation;
  const chosen =
    wanted === undefined ? representations[0] : representations.find((r) => r.id === wanted);
  if (!chosen) {
    const ids = representations.map((r) => r.id).join(", ");
    return fail(
      "not_found",
      `recording ${store.path} has no representation ${wanted} (has: ${ids})`,
    );
  }
  const group = (store.groups ?? []).find((g) => g.name === chosen.id);
  if (!group) return fail("not_found", `recording ${store.path} has no group ${chosen.id}`);

  // A group the index does not describe well enough to read is a host problem (decision 5).
  const { sampling_frequency: rate, nchans, ntimes } = chosen;
  if (rate === null || nchans === null || ntimes === null) {
    return fail(
      "upstream_error",
      `group ${group.name} of ${store.path} lacks a usable sampling rate, channel count or sample count`,
    );
  }
  if (!group.chunk_samples || !group.shard_samples) {
    return fail(
      "upstream_error",
      `group ${group.name} of ${store.path} carries no chunk_samples/shard_samples`,
    );
  }
  let nInner: number;
  try {
    nInner = nInnerForShard({
      shardSamples: group.shard_samples,
      chunkSamples: group.chunk_samples,
    });
  } catch (err) {
    return fail("upstream_error", err instanceof Error ? err.message : String(err));
  }

  const dataBase = index.data_base.endsWith("/") ? index.data_base : `${index.data_base}/`;
  const cacheKey = {
    datasetId,
    sourceCommit: index.source_commit,
    // The index's own timestamp changes with a re-conversion; it stands in for the Worker's D1
    // `zarr_converted_at`, which keeps cached byte offsets from outliving the object they index.
    convertedAt: index.updated_utc,
  };
  const meta = await loadLevel0ArrayMetadata({
    fetcher: source.fetcher,
    cache: source.jsonCache,
    ...cacheKey,
    dataBase,
    zarr: store.zarr,
    group: group.name,
  });
  if (!meta.ok) return fail("upstream_error", meta.detail);
  const { scale, offset, dataType } = meta.metadata;
  if (dataType !== "int16") {
    return fail(
      "upstream_error",
      `group ${group.name} of ${store.path} stores ${dataType}, not int16`,
    );
  }
  if (scale.length !== nchans || offset.length !== nchans) {
    return fail(
      "upstream_error",
      `group ${group.name} of ${store.path} has ${nchans} channels but ${scale.length} scale and ${offset.length} offset entries`,
    );
  }

  const bound: BoundZarrRepresentation = {
    ...chosen,
    sampling_frequency: rate,
    nchans,
    ntimes,
    scale,
    offset,
  };
  const listed = representations.map((r) => (r.id === bound.id ? bound : r));

  const recordsOutcome = await source.readRecords(datasetId);
  let record: Record<string, unknown> | null = null;
  if (recordsOutcome.status === "ok") {
    record = pickRecord(recordsOutcome.records, store.path);
    if (!record) warn(`[zarr-engine] no record for ${store.path} in ${datasetId} records.json`);
  } else {
    warn(`[zarr-engine] records for ${datasetId} unavailable: ${recordsOutcome.detail}`);
  }

  return {
    ok: true,
    value: {
      datasetId,
      recording: store.path,
      representationId: bound.id,
      record,
      representations: listed,
      bound,
      index,
      store,
      group,
      geometry: {
        rate,
        nChannels: nchans,
        nSamples: ntimes,
        chunkSamples: group.chunk_samples,
        shardSamples: group.shard_samples,
        nInner,
      },
      dataBase,
      cacheKey,
    },
  };
}
