/**
 * The two seams the Zarr read core talks through, so the same code runs in
 * the Worker (MCP) and in a CLI engine without either host's APIs leaking in.
 */

/** A subset of fetch: the Worker's deps.fetch and Bun's fetch satisfy it as-is. */
export type Fetcher = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<Response>;

/** What a cache entry belongs to. The host turns this into its own storage key. */
export interface CacheKey {
  datasetId: string;
  sourceCommit: string;
  convertedAt: string | null;
  projection: string;
}

/** JSON values only. An implementation should answer `get` with undefined on a
 *  miss or an unreadable entry, and make `put` best-effort (a failed write is
 *  its own to log, not the caller's to handle). The core does not guard against
 *  an implementation that throws. */
export interface JsonCache {
  get(key: CacheKey): Promise<unknown | undefined>;
  put(key: CacheKey, value: unknown): void;
}
