import type { ZarrIndex } from "../contract/zarr-index.js";

/** Narrows a parsed index document to the v3 shape. */
export function isV3Index(index: { format_version: number }): index is ZarrIndex {
  return index.format_version === 3;
}
