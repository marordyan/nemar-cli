/**
 * The CLI's engine client (`src/lib/zarr-engine/client.ts`) against the real engine, started
 * the way the commands start it: `nemar __zarr-engine`, here as `bun run src/index.ts
 * __zarr-engine` (the hidden subcommand dispatched early in `main()`), reading from a
 * `Bun.serve` stand-in on 127.0.0.1. Plus the client's failure paths with children that go
 * silent or die. No mocks.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineClient, EngineClientError } from "../src/lib/zarr-engine/client.js";
import {
  BIDS,
  ID,
  type Standin,
  expected,
  referenceDigital,
  startStandin,
} from "./helpers/zarr-engine-standin.js";

setDefaultTimeout(30_000);

const CLI = join(import.meta.dir, "..", "src", "index.ts");
const ROOT = join(import.meta.dir, "..");
let standin: Standin;
let tmp: string;
const clients: EngineClient[] = [];

beforeAll(() => {
  standin = startStandin();
});
afterAll(() => standin.stop());
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nemar-engine-client-"));
});
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  rmSync(tmp, { recursive: true, force: true });
});

function engine(extra: Record<string, string> = {}, timeoutMs?: number): EngineClient {
  const c = EngineClient.start({
    cmd: [process.execPath, "run", CLI, "__zarr-engine"],
    env: { ...standin.env({ config: join(tmp, "config"), cache: join(tmp, "cache") }), ...extra },
    timeoutMs,
  });
  clients.push(c);
  return c;
}

describe("the real engine through the hidden subcommand", () => {
  test("hello, open, read_window, release and close", async () => {
    const c = engine();
    const hello = await c.hello();
    expect(hello.protocol).toBe("0.1");
    expect(hello.engine).toStartWith("nemar-zarr-engine/");
    const opened = await c.open({ datasetId: ID, recording: BIDS });
    expect(opened.dataset_id).toBe(ID);
    const win = await c.readWindow({
      handle: opened.handle,
      startS: 1,
      durationS: 1,
      units: "digital",
    });
    expect(win.header.dtype).toBe("int16");
    expect(win.header.n_samples).toBe(250);
    const got = new Int16Array(win.payload.slice().buffer);
    // Channel-major: row c is channel c; the reference is the whole array, channel-major.
    const nSamples = expected.n_samples as number;
    for (let ch = 0; ch < 4; ch++) {
      expect(Array.from(got.subarray(ch * 250, (ch + 1) * 250))).toEqual(
        Array.from(referenceDigital.subarray(ch * nSamples + 250, ch * nSamples + 500)),
      );
    }
    // A plain Uint8Array, not the stream's Node Buffer (whose slice() is a view over a pool).
    expect(win.payload.constructor).toBe(Uint8Array);
    await c.release(opened.handle);
    expect(await c.close()).toBe(0);
  });

  test("an engine error comes back as an EngineClientError with its code", async () => {
    const c = engine();
    await c.hello();
    const err = await c.open({ datasetId: "nm099999", recording: BIDS }).catch((e) => e);
    expect(err).toBeInstanceOf(EngineClientError);
    expect(err.code).toBe("not_found");
    // The engine is still usable after an error reply.
    const opened = await c.open({ datasetId: ID, recording: BIDS });
    expect(opened.dataset_id).toBe(ID);
  });

  test("a bad configuration exits 1 and the client reports it with the engine's stderr", async () => {
    const c = engine({ NEMAR_ZARR_BASE: "http://example.com" });
    const err = await c.hello().catch((e) => e);
    expect(err).toBeInstanceOf(EngineClientError);
    expect(err.code).toBe("exited");
    expect(err.stderr).toContain("NEMAR_ZARR_BASE");
    // The engine prints no bug-report hint and no banner.
    expect(err.stderr).not.toContain("--debug");
  });

  test("the engine writes nothing to stderr on a clean run", async () => {
    const c = engine();
    await c.hello();
    const opened = await c.open({ datasetId: ID, recording: BIDS });
    await c.readWindow({ handle: opened.handle, startS: 0, durationS: 1 });
    expect(await c.close()).toBe(0);
    expect(c.stderr).toBe("");
  });
});

describe("the hidden subcommand", () => {
  test("is not in the help, and the help does not start an engine", async () => {
    const proc = Bun.spawn({
      cmd: [process.execPath, "run", CLI, "--help"],
      cwd: ROOT,
      env: {
        ...process.env,
        ...standin.env({ config: join(tmp, "config"), cache: join(tmp, "cache") }),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    expect(out).toContain("Usage: nemar");
    expect(out).not.toContain("__zarr-engine");
  });
});

describe("a child that misbehaves", () => {
  test("a child that never answers times out, and keeps its stderr", async () => {
    const c = EngineClient.start({
      cmd: [process.execPath, "-e", 'console.error("starting up"); setInterval(() => {}, 1000)'],
      timeoutMs: 400,
    });
    clients.push(c);
    const err = await c.hello().catch((e) => e);
    expect(err).toBeInstanceOf(EngineClientError);
    expect(err.code).toBe("timeout");
    expect(err.stderr).toContain("starting up");
  });

  test("a child that dies says so, with its stderr", async () => {
    const c = EngineClient.start({
      cmd: [process.execPath, "-e", 'console.error("boom"); process.exit(3)'],
    });
    clients.push(c);
    const err = await c.hello().catch((e) => e);
    expect(err).toBeInstanceOf(EngineClientError);
    expect(err.code).toBe("exited");
    expect(err.message).toContain("status 3");
    expect(err.stderr).toContain("boom");
  });

  test("a command that cannot be started is an exited error naming the problem", async () => {
    const c = EngineClient.start({ cmd: [join(tmp, "no-such-program")] });
    clients.push(c);
    const err = await c.hello().catch((e) => e);
    expect(err).toBeInstanceOf(EngineClientError);
    expect(err.stderr).toContain("ENOENT");
  });

  test("a child that sends garbage on stdout is a protocol error", async () => {
    const c = EngineClient.start({
      cmd: [
        process.execPath,
        "-e",
        'process.stdout.write("not a frame at all, sorry"); setInterval(() => {}, 1000)',
      ],
      timeoutMs: 5000,
    });
    clients.push(c);
    const err = await c.hello().catch((e) => e);
    expect(err).toBeInstanceOf(EngineClientError);
    expect(err.code).toBe("protocol");
  });
});
