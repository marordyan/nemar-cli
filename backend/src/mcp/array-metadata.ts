/**
 * Level-0 Zarr array metadata (`zarr.json`) for `read_window` taste mode: the
 * Worker's thin wrapper over `shared/zarr/array-metadata.ts`, which holds the
 * fetch, parse, validation and cache logic (and the module doc explaining why
 * taste mode needs this document and recipe mode does not).
 */

import {
  type LoadLevel0ArrayMetadataResult,
  loadLevel0ArrayMetadata as loadLevel0ArrayMetadataCore,
} from "../../../shared/zarr/array-metadata.js";
import { mcpJsonCache } from "./projection-cache.js";
import type { RecordingToolDeps } from "./tool-types.js";

export {
  type Level0ArrayMetadata,
  type LoadLevel0ArrayMetadataResult,
  level0ArrayMetadataKey,
} from "../../../shared/zarr/array-metadata.js";

/** The Worker's call into the shared loader: `deps.fetch` as the fetcher and
 *  the Cache API (through `mcpJsonCache`) as the cache. The loader's own doc
 *  covers the behavior. */
export function loadLevel0ArrayMetadata(
  deps: RecordingToolDeps,
  datasetId: string,
  sourceCommit: string,
  /** D1's `zarr_converted_at`, part of the cache key: this entry holds the
   *  `scale[]`/`offset[]` a taste multiplies by, and a re-conversion can
   *  re-quantize at an unchanged commit. See projection-cache.ts. */
  convertedAt: string | null,
  dataBase: string,
  zarr: string,
  group: string,
): Promise<LoadLevel0ArrayMetadataResult> {
  return loadLevel0ArrayMetadataCore({
    fetcher: deps.fetch,
    cache: mcpJsonCache(deps),
    datasetId,
    sourceCommit,
    convertedAt,
    dataBase,
    zarr,
    group,
  });
}
