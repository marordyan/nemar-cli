import type { Fetcher } from "./interfaces.js";

/**
 * Fetch and validate ONE `Range` response -- the single call site the shard
 * footer loader and the chunk reader both go through, so they cannot drift
 * apart on what "a valid Range response" means. A compliant origin ALWAYS
 * answers `206` to a `Range` request; a bare `200` means the origin ignored
 * `Range` and returned the whole object, which would silently misalign every
 * downstream byte offset (see the module doc of `backend/src/mcp/tools/read-window.ts`). The body length
 * is asserted against `expectedLength` too -- a `206` with the wrong slice is
 * just as wrong as a `200`.
 */
export async function fetchRangeBytes(
  fetcher: Fetcher,
  url: string,
  rangeHeader: string,
  expectedLength: number,
): Promise<{ buf: Uint8Array } | { error: string }> {
  let response: Response;
  try {
    response = await fetcher(url, { headers: { Range: rangeHeader } });
  } catch (err) {
    return {
      error: `network error fetching ${url}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (response.status !== 206) {
    return {
      error: `HTTP ${response.status} fetching ${url} with Range ${rangeHeader} (expected 206; a bare 200 means the origin ignored Range and would misalign every byte offset)`,
    };
  }
  const buf = new Uint8Array(await response.arrayBuffer());
  if (buf.length !== expectedLength) {
    return {
      error: `${url} (Range ${rangeHeader}) returned ${buf.length} bytes, expected exactly ${expectedLength}`,
    };
  }
  return { buf };
}
