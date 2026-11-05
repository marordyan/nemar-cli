import type { ZarrIndex, ZarrIndexAny } from "../contract/zarr-index.js";

/** Narrows a parsed index document to the v3 shape. */
export function isV3Index(index: ZarrIndexAny): index is ZarrIndex {
  return index.format_version === 3;
}
