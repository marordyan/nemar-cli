/**
 * `nemar engine status` and `nemar engine cache clear`: look at the local Zarr engine and its
 * disk cache (ADR 0120).
 *
 * `status` starts the engine and says `hello`, so it proves the engine runs, and reports what the
 * engine would use: its version and protocol, the largest payload it sends, the Zarr host and
 * data plane (and where the Zarr host came from), and the disk cache's directory, size, entries
 * and limit. The cache numbers are read from the directory (lib/zarr-engine/disk-cache.ts); the
 * protocol has no message for them. `cache clear` removes the cache's entries.
 */

import chalk from "chalk";
import { Command } from "commander";
import { failMessage } from "../lib/admin-command.js";
import { plain } from "../lib/terminal-text.js";
import { EngineClient, EngineClientError } from "../lib/zarr-engine/client.js";
import { DiskCacheRefusal, resolveDiskCache } from "../lib/zarr-engine/disk-cache.js";
import { CONFIG_HINT, resolveEngineConfig } from "../lib/zarr-engine/engine-config.js";
import { EngineConfigError, type resolveBases, zarrBaseSource } from "../lib/zarr-engine/http.js";
import { failUnexpected } from "./zarr.js";

/** `1.5 GiB`, `12.3 MiB`, `512 B`. */
export function formatBytes(n: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${n} B` : `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

const BASE_SOURCE_TEXT = {
  env: "from NEMAR_ZARR_BASE",
  account: "for your account's API host",
  default: "the production default (your API host has no Zarr host of its own)",
} as const;

export interface EngineOptions {
  json?: boolean;
}

export async function engineStatusAction(options: EngineOptions = {}): Promise<void> {
  const json = options.json === true;
  let bases: ReturnType<typeof resolveBases>;
  let cache: ReturnType<typeof resolveDiskCache>;
  try {
    ({ bases, diskCache: cache } = resolveEngineConfig());
  } catch (err) {
    if (err instanceof EngineConfigError) {
      failMessage(plain(err.message), {
        json,
        answered: true,
        hint: CONFIG_HINT,
      });
      return;
    }
    failUnexpected(err, json);
    return;
  }
  const baseSource = zarrBaseSource();

  const client = EngineClient.start({ timeoutMs: 10_000 });
  try {
    const hello = await client.hello();
    const stats = cache.stats();
    if (json) {
      console.log(
        JSON.stringify(
          {
            engine: {
              name: hello.engine,
              protocol: hello.protocol,
              max_payload_bytes: hello.max_payload_bytes,
            },
            zarr_base: bases.zarrBase,
            zarr_base_source: baseSource,
            data_plane: bases.dataPlaneBase,
            cache: {
              dir: stats.dir,
              enabled: stats.enabled,
              bytes: stats.bytes,
              entries: stats.entries,
              limit_bytes: stats.limitBytes,
            },
          },
          null,
          2,
        ),
      );
      return;
    }
    const line = (label: string, value: string) =>
      console.log(`  ${chalk.bold(label.padEnd(13))}${value}`);
    console.log(chalk.bold("\nZarr engine\n"));
    line("Engine", `${plain(hello.engine)} (protocol ${hello.protocol})`);
    line("Max payload", formatBytes(hello.max_payload_bytes));
    line("Zarr host", `${bases.zarrBase} (${BASE_SOURCE_TEXT[baseSource]})`);
    line("Data plane", bases.dataPlaneBase);
    line(
      "Cache",
      stats.enabled
        ? `${stats.dir}\n${" ".repeat(15)}${formatBytes(stats.bytes)} of ${formatBytes(stats.limitBytes)}, ${stats.entries} ${stats.entries === 1 ? "entry" : "entries"}`
        : `off (NEMAR_ZARR_DISK_CACHE_BYTES=0); directory ${stats.dir}`,
    );
    console.log("");
  } catch (err) {
    if (!(err instanceof EngineClientError)) throw err;
    const last = err.stderr.split("\n").filter(Boolean).at(-1);
    failMessage(plain(last ? `${err.message}: ${last}` : err.message), {
      json,
      answered: false,
      hint: "The local Zarr engine did not start. Run again with --debug and attach the log to an issue.",
    });
  } finally {
    await client.close();
  }
}

export function engineCacheClearAction(options: EngineOptions = {}): void {
  const json = options.json === true;
  let cache: ReturnType<typeof resolveDiskCache>;
  try {
    cache = resolveDiskCache();
  } catch (err) {
    if (err instanceof EngineConfigError) {
      failMessage(plain(err.message), { json, answered: true });
      return;
    }
    throw err;
  }
  let result: { freedBytes: number; failed: number };
  try {
    result = cache.clear();
  } catch (err) {
    if (err instanceof DiskCacheRefusal) {
      failMessage(plain(err.message), {
        json,
        answered: true,
        hint: "NEMAR_ZARR_DISK_CACHE_DIR must name a directory the Zarr cache created (or a new one). Remove the files yourself if you are sure.",
      });
      return;
    }
    failMessage(`Could not clear ${cache.dir}: ${plain((err as Error).message)}`, {
      json,
      answered: false,
    });
    return;
  }
  if (json) {
    console.log(
      JSON.stringify(
        { dir: cache.dir, freed_bytes: result.freedBytes, failed: result.failed },
        null,
        2,
      ),
    );
  } else {
    console.log(`Cleared the Zarr cache at ${cache.dir}: ${formatBytes(result.freedBytes)} freed.`);
  }
  if (result.failed > 0) {
    failMessage(
      `${result.failed} ${result.failed === 1 ? "entry" : "entries"} could not be removed from ${cache.dir}.`,
      {
        json,
        answered: true,
        hint: "Check the permissions of the cache directory, then run the command again.",
      },
    );
  }
}

const STATUS_HELP = `
Starts the local Zarr engine and checks that it answers, then reports what it would use: the
engine's version and protocol, the largest window it sends, the Zarr host and data plane, and
the disk cache (directory, size, entries, limit).

The Zarr host follows your account's API host (zarr.nemar.org for api.nemar.org,
zarr-test.nemar.org for api-test.nemar.org); NEMAR_ZARR_BASE overrides it.

Examples:
  $ nemar engine status
  $ nemar engine status --json | jq .cache.bytes`;

const CLEAR_HELP = `
Removes every entry of the Zarr disk cache and says how many bytes that freed. The cache holds
public data only and is refilled by the next read. It is at <config dir>/zarr-cache/public/v1
unless NEMAR_ZARR_DISK_CACHE_DIR names another directory. The cache directory is made private (mode
0700). Only files the cache wrote are removed, and a directory the cache did not create (it has no
.nemar-zarr-cache file) is refused.

Examples:
  $ nemar engine cache clear
  $ nemar engine cache clear --json`;

export const engineCommand = new Command("engine").description(
  "Check the local Zarr engine and manage its cache",
);

engineCommand
  .command("status")
  .description("Start the engine and show its configuration and cache")
  .option("--json", "Print the status as JSON")
  .addHelpText("after", STATUS_HELP)
  .action(engineStatusAction);

const cacheCommand = engineCommand.command("cache").description("Manage the Zarr disk cache");
cacheCommand
  .command("clear")
  .description("Remove the Zarr disk cache's entries")
  .option("--json", "Print the result as JSON")
  .addHelpText("after", CLEAR_HELP)
  .action(engineCacheClearAction);
