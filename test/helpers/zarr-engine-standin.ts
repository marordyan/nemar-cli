/**
 * A real `Bun.serve` stand-in on 127.0.0.1 for the Zarr engine's CLI tests: it serves the
 * committed nm099500 synthetic sharded store (index, `zarr.json`, both shards), a data-plane
 * version listing and a `records.json`, and records every request. `env()` is what a spawned
 * `nemar` needs to read from it, with an isolated config directory and disk cache.
 *
 * nm099500: 4 channels, 250 Hz, 6500 samples, chunk 1000, shard 4000, scale [0.5, 1, 1.5, 2],
 * offset [10, 20, 30, 40]; shard 0's inner chunk 2 (samples 2000-3000) is ABSENT.
 */

import { readFileSync } from "node:fs";

const MCP = new URL("../../backend/test/fixtures/mcp/", import.meta.url);
const json = (name: string) => JSON.parse(readFileSync(new URL(name, MCP), "utf8"));
const bytes = (name: string) => new Uint8Array(readFileSync(new URL(name, MCP)));

export const ID = "nm099500";
export const BIDS = "sub-synth/eeg/sub-synth_task-shardtest_eeg.edf";
export const ZARR = "sub-synth/eeg/sub-synth_task-shardtest_eeg.zarr";
export const expected = json("nm099500-expected.json");
export const referenceDigital = new Int16Array(
  bytes("nm099500-zarr-python-int16.bin").slice().buffer,
);
const index = json("nm099500-index-v3.json");
const level0 = json("nm099500-level0-zarr.json");
const shard0 = bytes("nm099500-shard-0.bin");
const shard1 = bytes("nm099500-shard-1.bin");
const legacyIndex = json("nm000111-index-v1.json");

export interface Standin {
  url: string;
  /** Every request path the stand-in received. */
  requests: string[];
  /** The Range requests, as `path range`. */
  ranges: string[];
  /** What the index served next says: its `updated_utc`. */
  setUpdatedUtc(value: string | null): void;
  /** Serve a 503 for every request to the shards. */
  setShardsDown(down: boolean): void;
  stop(): void;
  /** The environment a spawned `nemar` needs: base, data plane, isolated cache and config. */
  env(dirs: { config: string; cache: string }): Record<string, string>;
}

function rangeResponse(req: Request, body: Uint8Array): Response {
  const range = req.headers.get("range") ?? "";
  const m = /^bytes=(?:(\d+)-(\d+)|-(\d+))$/.exec(range);
  if (!m) return new Response(body, { status: 200 });
  const isFooter = m[3] !== undefined;
  const start = isFooter ? Math.max(0, body.length - Number(m[3])) : Number(m[1]);
  const end = isFooter ? body.length - 1 : Math.min(Number(m[2]), body.length - 1);
  return new Response(body.slice(start, end + 1), { status: 206 });
}

export function startStandin(): Standin {
  let updatedUtc: string | null = null;
  let shardsDown = false;
  const requests: string[] = [];
  const ranges: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      requests.push(path);
      const range = req.headers.get("range");
      if (range) ranges.push(`${path} ${range}`);
      const doc = (d: unknown) => Response.json(d);
      const origin = `http://127.0.0.1:${server.port}`;
      if (path === `/${ID}/zarr/index.json`) {
        return doc({
          ...index,
          ...(updatedUtc === null ? {} : { updated_utc: updatedUtc }),
          dataset_id: ID,
          data_base: `${origin}/${ID}/zarr/`,
          contract_base: `${origin}/${ID}/zarr/`,
        });
      }
      if (path === "/nm000111/zarr/index.json") return doc(legacyIndex);
      if (path === `/${ID}/zarr/${ZARR}/eeg_250hz/0/zarr.json`) return doc(level0);
      const shard = `/${ID}/zarr/${ZARR}/eeg_250hz/0/c/0/`;
      if (path === `${shard}0` || path === `${shard}1`) {
        if (shardsDown) return new Response("down", { status: 503 });
        return rangeResponse(req, path.endsWith("0") ? shard0 : shard1);
      }
      if (path === `/data/${ID}`) {
        return doc({ latest: "1.0.0", versions: [{ version: "1.0.0" }] });
      }
      if (path === `/data/${ID}/1.0.0/records.json`) {
        return doc([{ bids_relpath: BIDS, task: "shardtest", subject: "synth" }]);
      }
      return new Response(null, { status: 404 });
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  return {
    url,
    requests,
    ranges,
    setUpdatedUtc: (v) => {
      updatedUtc = v;
    },
    setShardsDown: (d) => {
      shardsDown = d;
    },
    stop: () => server.stop(true),
    env: (dirs) => ({
      NEMAR_CONFIG_DIR: dirs.config,
      NEMAR_ZARR_BASE: url,
      NEMAR_ZARR_DATA_PLANE: `${url}/data`,
      NEMAR_ZARR_DISK_CACHE_DIR: dirs.cache,
      NEMAR_NO_UPDATE_CHECK: "1",
      NO_COLOR: "1",
      // The API is the stand-in too: a command must never reach a real host (the pre-action
      // notices call lands here and gets a 404).
      TEST_API_URL: url,
    }),
  };
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const CLI_ENTRY = new URL("../../src/index.ts", import.meta.url).pathname;
const REPO_ROOT = new URL("../../", import.meta.url).pathname;

/** Run the real `nemar` entry point as a subprocess, with `env` over the process's. */
export async function runNemar(
  args: string[],
  env: Record<string, string>,
  stdinIgnore = true,
): Promise<RunResult> {
  const proc = Bun.spawn({
    cmd: [process.execPath, "run", CLI_ENTRY, ...args],
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdin: stdinIgnore ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { stdout, stderr, exitCode: await proc.exited };
}
