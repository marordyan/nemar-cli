/**
 * The Zarr engine, as a function: {@link runEngine}. `nemar __zarr-engine` (src/index.ts) calls it,
 * and `main.ts` is the development entry point (`bun run src/lib/zarr-engine/main.ts`).
 *
 * It lives apart from `main.ts` because that file's `import.meta.main` block must never be
 * bundled into the CLI.
 *
 * Reads request frames on stdin, writes response frames on stdout, and logs only to stderr
 * (stdout is the protocol; a stray line on it would corrupt a frame). It opens no port.
 * The CLI commands (`nemar zarr read`, `nemar engine status`, `nemar doctor`) start it as
 * `nemar __zarr-engine`, a hidden subcommand, through `client.ts`.
 *
 * Environment:
 *   NEMAR_ZARR_BASE              where `<id>/zarr/index.json` is read (default: the host of the active account:
 *                                https://zarr.nemar.org for api.nemar.org, https://zarr-test.nemar.org for
 *                                api-test.nemar.org, production for any other API host)
 *   NEMAR_ZARR_DATA_PLANE        the data plane's `/data` mount (default: the API origin + /data)
 *   NEMAR_ZARR_MAX_PAYLOAD_BYTES the largest window payload, and bound on a read's decode work
 *                                (default 256 MiB, at most 1 GiB: the CLI client's limit)
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
import { type EngineConfig, resolveEngineConfig } from "./engine-config.js";
import type { FrameSink } from "./frame-stream.js";
import { EngineConfigError } from "./http.js";
import { EngineServer, serve } from "./server.js";
import { publicSource } from "./source.js";

/** Serve the protocol on `input` and `output` (stdin and stdout) until end of input; resolves
 *  with the exit status. */
export async function runEngine(
  env: Record<string, string | undefined> = process.env,
  input: AsyncIterable<Uint8Array> = process.stdin,
  output: FrameSink = process.stdout,
): Promise<number> {
  let server: EngineServer;
  try {
    const config = resolveEngineConfig(env);
    const source = publicSource({
      bases: config.bases,
      rangeCacheBytes: config.rangeCacheBytes,
      diskCache: config.diskCache,
    });
    server = new EngineServer({
      source,
      maxPayloadBytes: config.maxPayloadBytes,
      engineName: `nemar-zarr-engine/${pkg.version}`,
    });
  } catch (err) {
    if (err instanceof EngineConfigError) {
      console.error(`[zarr-engine] ${err.message}`);
      return 1;
    }
    throw err;
  }
  return serve(server, input, output);
}
