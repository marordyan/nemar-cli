/**
 * Entry point of the Zarr engine: `bun run src/lib/zarr-engine/main.ts`.
 *
 * Reads request frames on stdin, writes response frames on stdout, and logs only to stderr
 * (stdout is the protocol; a stray line on it would corrupt a frame). It opens no port.
 * There is no CLI command yet (phase 5).
 *
 * Environment:
 *   NEMAR_ZARR_BASE              where `<id>/zarr/index.json` is read (default https://zarr.nemar.org)
 *   NEMAR_ZARR_DATA_PLANE        the data plane's `/data` mount (default: the API origin + /data)
 *   NEMAR_ZARR_MAX_PAYLOAD_BYTES the largest window payload, and bound on a read's decode work
 *                                (default 256 MiB)
 *   NEMAR_ZARR_RANGE_CACHE_BYTES bound of the in-memory range cache (default 256 MiB)
 *   NEMAR_ZARR_DISK_CACHE_DIR    the disk cache's directory (default <config dir>/zarr-cache/public/v1)
 *   NEMAR_ZARR_DISK_CACHE_BYTES  bound of the disk cache (default 2 GiB; 0 turns it off)
 * The two bases must be https, or http to a loopback address; they are NOT ADR 0114's
 * `NEMAR_DATA_HOSTS` and never decide where a credential goes (the engine sends none).
 *
 * Exit status: 0 at end of input, 2 after an unrecoverable framing error, 1 for a bad
 * configuration or an unwritable stdout.
 */

import pkg from "../../../package.json" with { type: "json" };
import { resolveDiskCache } from "./disk-cache.js";
import { DEFAULT_RANGE_CACHE_BYTES, EngineConfigError, resolveBases } from "./http.js";
import { EngineServer, serve } from "./server.js";
import { publicSource } from "./source.js";

/** 256 MiB, the default for `max_payload_bytes` (its own constant, not the range cache's). */
export const DEFAULT_MAX_PAYLOAD_BYTES = 256 * 1024 * 1024;
export const MAX_PAYLOAD_ENV = "NEMAR_ZARR_MAX_PAYLOAD_BYTES";
export const RANGE_CACHE_ENV = "NEMAR_ZARR_RANGE_CACHE_BYTES";

function envBytes(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new EngineConfigError(`${name} must be a positive integer, got ${raw}`);
  }
  return n;
}

export async function main(env: Record<string, string | undefined> = process.env): Promise<number> {
  let server: EngineServer;
  try {
    const source = publicSource({
      bases: resolveBases(env),
      rangeCacheBytes: envBytes(env, RANGE_CACHE_ENV, DEFAULT_RANGE_CACHE_BYTES),
      diskCache: resolveDiskCache(env),
    });
    server = new EngineServer({
      source,
      maxPayloadBytes: envBytes(env, MAX_PAYLOAD_ENV, DEFAULT_MAX_PAYLOAD_BYTES),
      engineName: `nemar-zarr-engine/${pkg.version}`,
    });
  } catch (err) {
    if (err instanceof EngineConfigError) {
      console.error(`[zarr-engine] ${err.message}`);
      return 1;
    }
    throw err;
  }
  return serve(server, process.stdin, process.stdout);
}

if (import.meta.main) {
  const code = await main();
  // Every reply was written before serve resolved; exit now rather than wait for stdin.
  process.exit(code);
}
