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
import {
  FRAME_PREFIX_BYTES,
  MAX_HEADER_BYTES,
  encodeFrame,
} from "../shared/zarr/protocol-frame.js";
import {
  EngineClient,
  EngineClientError,
  MAX_QUEUED_OUTPUT_BYTES,
  engineEnvironment,
} from "../src/lib/zarr-engine/client.js";
import { MAX_CLIENT_PAYLOAD_BYTES } from "../src/lib/zarr-engine/frame-stream.js";
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

const b64 = (header: Record<string, unknown>, payload?: Uint8Array) =>
  Buffer.from(encodeFrame(header, payload)).toString("base64");
/** A child that writes `frameB64` to stdout after `delayMs`, then idles. */
const replying = (frameB64: string, delayMs = 0) => [
  process.execPath,
  "-e",
  `setTimeout(() => process.stdout.write(Buffer.from("${frameB64}", "base64")), ${delayMs}); setInterval(() => {}, 1000)`,
];

describe("the engine's environment", () => {
  test("engineEnvironment keeps what the engine needs and drops credentials", () => {
    const env = engineEnvironment({
      PATH: "/bin",
      HOME: "/home/x",
      LC_ALL: "C",
      XDG_CONFIG_HOME: "/x",
      NEMAR_ZARR_BASE: "http://127.0.0.1:1",
      NEMAR_CONFIG_DIR: "/c",
      TEST_API_URL: "http://127.0.0.1:2",
      HTTPS_PROXY: "http://proxy",
      NEMAR_API_KEY: "secret",
      GITHUB_TOKEN: "secret",
      AWS_SECRET_ACCESS_KEY: "secret",
      NEMAR_DEBUG: "1",
    });
    expect(Object.keys(env).sort()).toEqual(
      [
        "HOME",
        "HTTPS_PROXY",
        "LC_ALL",
        "NEMAR_CONFIG_DIR",
        "NEMAR_ZARR_BASE",
        "PATH",
        "TEST_API_URL",
        "XDG_CONFIG_HOME",
      ].sort(),
    );
  });

  test("a child started by the client does not receive NEMAR_API_KEY or other secrets", async () => {
    const saved = { ...process.env };
    process.env.NEMAR_API_KEY = "nemar-secret";
    process.env.GITHUB_TOKEN = "gh-secret";
    process.env.NEMAR_ZARR_BASE = "http://127.0.0.1:9";
    try {
      const c = EngineClient.start({
        cmd: [
          process.execPath,
          "-e",
          "console.error(JSON.stringify(Object.keys(process.env))); setInterval(() => {}, 1000)",
        ],
        timeoutMs: 1500,
      });
      clients.push(c);
      await c.hello().catch(() => undefined);
      const keys = JSON.parse(c.stderr.split("\n")[0]) as string[];
      expect(keys).not.toContain("NEMAR_API_KEY");
      expect(keys).not.toContain("GITHUB_TOKEN");
      expect(keys).toContain("PATH");
      expect(keys).toContain("NEMAR_ZARR_BASE");
    } finally {
      for (const k of ["NEMAR_API_KEY", "GITHUB_TOKEN", "NEMAR_ZARR_BASE"]) {
        if (saved[k] === undefined) Reflect.deleteProperty(process.env, k);
        else process.env[k] = saved[k];
      }
    }
  });
});

describe("closing and failing", () => {
  test("the stderr a child wrote just before exiting is complete", async () => {
    for (let i = 0; i < 15; i++) {
      const c = EngineClient.start({
        cmd: [
          process.execPath,
          "-e",
          `console.error("x".repeat(20000)); console.error("LAST-LINE-${i}"); process.exit(3)`,
        ],
      });
      clients.push(c);
      const err = await c.hello().catch((e) => e);
      expect(err.code).toBe("exited");
      expect(err.stderr).toContain(`LAST-LINE-${i}`);
    }
  });

  test("stderr written after the child process exited, by a process that inherited it, is still captured", async () => {
    // "exit" would resolve while the grandchild still holds stderr; "close" waits for it.
    const c = EngineClient.start({
      cmd: [
        process.execPath,
        "-e",
        'Bun.spawn(["sh", "-c", "sleep 0.4; echo LATE-LINE >&2"], { stderr: "inherit" }); process.exit(3)',
      ],
      // Generous, so a loaded machine cannot make the 0.4 s late line miss the window; the line
      // is still lost if `exited` resolves on the bare exit (stdioSettleMs 0 below).
      stdioSettleMs: 5000,
    });
    clients.push(c);
    const err = await c.hello().catch((e) => e);
    expect(err.code).toBe("exited");
    expect(err.stderr).toContain("LATE-LINE");
  });

  test("without any settle the late line is lost (the settle is what captures it)", async () => {
    const c = EngineClient.start({
      cmd: [
        process.execPath,
        "-e",
        'Bun.spawn(["sh", "-c", "sleep 0.4; echo LATE-LINE >&2"], { stderr: "inherit" }); process.exit(3)',
      ],
      stdioSettleMs: 0,
    });
    clients.push(c);
    const err = await c.hello().catch((e) => e);
    expect(err.stderr).not.toContain("LATE-LINE");
  });

  test("close() kills a child that ignores SIGTERM and never ends", async () => {
    const c = EngineClient.start({
      cmd: [process.execPath, "-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
      closeGraceMs: 300,
    });
    const started = Date.now();
    const status = await c.close();
    expect(status).toBeNull();
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test("after a timeout the client is unusable, and a late reply cannot answer the next request", async () => {
    const hello = b64({
      id: 1,
      type: "hello",
      protocol: "0.1",
      engine: "late/1",
      max_payload_bytes: 1000,
    });
    const c = EngineClient.start({ cmd: replying(hello, 700), timeoutMs: 250 });
    clients.push(c);
    const first = await c.hello().catch((e) => e);
    expect(first.code).toBe("timeout");
    const started = Date.now();
    const second = await c.hello().catch((e) => e);
    expect(Date.now() - started).toBeLessThan(200);
    expect(second).toBeInstanceOf(EngineClientError);
    expect(second.message).toContain("can no longer be used");
  });
});

describe("a window that does not match its header", () => {
  test("a payload that is not channels x samples x dtype size is a protocol error", async () => {
    const bad = b64(
      {
        id: 1,
        type: "window",
        start_sample: 0,
        n_samples: 1,
        channels: [0],
        dtype: "float64",
        layout: "channel-major",
        byte_order: "little",
        filled_ranges: [],
        payload_bytes: 16,
      },
      new Uint8Array(16),
    );
    const c = EngineClient.start({ cmd: replying(bad), timeoutMs: 5000 });
    clients.push(c);
    const err = await c.readWindow({ handle: "h1", startS: 0, durationS: 1 }).catch((e) => e);
    expect(err.code).toBe("protocol");
    expect(err.message).toContain("invalid");
  });
});

describe("the payload limit", () => {
  test("a setting above the client's 1 GiB limit is a configuration error", async () => {
    const c = engine({ NEMAR_ZARR_MAX_PAYLOAD_BYTES: String(2 ** 30 + 1) });
    const err = await c.hello().catch((e) => e);
    expect(err.code).toBe("exited");
    expect(err.stderr).toContain("NEMAR_ZARR_MAX_PAYLOAD_BYTES must be at most");
  });

  test("1 GiB itself is accepted and reported by hello", async () => {
    const c = engine({ NEMAR_ZARR_MAX_PAYLOAD_BYTES: String(2 ** 30) });
    expect((await c.hello()).max_payload_bytes).toBe(2 ** 30);
  });
});

describe("engineEnvironment by platform", () => {
  const env = {
    Path: "C:\\bin",
    comspec: "cmd.exe",
    SystemRoot: "C:\\Windows",
    PATHEXT: ".EXE",
    WinDir: "C:\\Windows",
    lc_all: "C",
    Nemar_Zarr_Base: "http://127.0.0.1:1",
    NEMAR_API_KEY: "secret",
  };

  test("on Windows names match case-insensitively and COMSPEC, WINDIR and PATHEXT pass", () => {
    const out = engineEnvironment(env, "win32");
    expect(Object.keys(out).sort()).toEqual(
      ["Nemar_Zarr_Base", "Path", "PATHEXT", "SystemRoot", "WinDir", "comspec", "lc_all"].sort(),
    );
  });

  test("elsewhere names are exact, so Path is not PATH", () => {
    const out = engineEnvironment({ ...env, PATH: "/bin" }, "linux");
    expect(Object.keys(out).sort()).toEqual(["PATH", "PATHEXT", "SystemRoot"].sort());
  });
});

describe("a process that holds the child's stdio open", () => {
  test("close() is bounded even though the stdio never closes", async () => {
    // The child starts `sleep 5` with the same stdout and stderr and idles; after SIGKILL the
    // sleeper still holds both, so "close" would not come for 5 s.
    const c = EngineClient.start({
      cmd: [
        process.execPath,
        "-e",
        'Bun.spawn(["sleep", "5"], { stdout: "inherit", stderr: "inherit" }); setInterval(() => {}, 1000)',
      ],
      closeGraceMs: 200,
    });
    const started = Date.now();
    await c.close();
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test("a child that exits while a grandchild holds its stdio still answers the call with its exit", async () => {
    const c = EngineClient.start({
      cmd: [
        process.execPath,
        "-e",
        'Bun.spawn(["sleep", "5"], { stdout: "inherit", stderr: "inherit" }); process.exit(3)',
      ],
    });
    clients.push(c);
    const started = Date.now();
    const err = await c.hello().catch((e) => e);
    expect(err.code).toBe("exited");
    expect(Date.now() - started).toBeLessThan(4000);
  });
});

describe("a reply the engine wrote before the client asked", () => {
  test("a large reply written just before exiting survives a parent that reads a second late", async () => {
    const n = 40000;
    const reply = b64(
      {
        id: 1,
        type: "window",
        start_sample: 0,
        n_samples: n,
        channels: [0],
        dtype: "float64",
        layout: "channel-major",
        byte_order: "little",
        filled_ranges: [],
        payload_bytes: n * 8,
      },
      new Uint8Array(n * 8).fill(7),
    );
    const c = EngineClient.start({
      cmd: [
        process.execPath,
        "-e",
        `process.stdout.write(Buffer.from("${reply}", "base64"), () => process.exit(0))`,
      ],
    });
    clients.push(c);
    // The child has written everything and exited long before the first request.
    await new Promise((r) => setTimeout(r, 1500));
    const win = await c.readWindow({ handle: "h1", startS: 0, durationS: 1 });
    expect(win.header.n_samples).toBe(n);
    expect(win.payload.length).toBe(n * 8);
    expect(win.payload[0]).toBe(7);
  });
});

describe("an engine that has already exited when its reply is read", () => {
  test("the reply wins over the exit, even with no settle time at all", async () => {
    const reply = b64({
      id: 1,
      type: "hello",
      protocol: "0.1",
      engine: "fast/1",
      max_payload_bytes: 1000,
    });
    const c = EngineClient.start({
      cmd: [
        process.execPath,
        "-e",
        `process.stdout.write(Buffer.from("${reply}", "base64"), () => process.exit(0))`,
      ],
      stdioSettleMs: 0,
    });
    clients.push(c);
    await new Promise((r) => setTimeout(r, 500));
    expect((await c.hello()).engine).toBe("fast/1");
  });
});

describe("a stream that fails is not a stream that ended", () => {
  test("the stream's own error is in the message", async () => {
    const c = EngineClient.start({
      cmd: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      timeoutMs: 5000,
    });
    clients.push(c);
    (c as unknown as { child: { stdout: { destroy(e: Error): void } } }).child.stdout.destroy(
      new Error("EIO: input/output error"),
    );
    const err = await c.hello().catch((e) => e);
    expect(err).toBeInstanceOf(EngineClientError);
    expect(err.message).toContain("reading the engine's output failed: EIO: input/output error");
    expect(err.message).not.toContain("closed its output");
  });

  test("the engine is killed and the client unusable, even when it ignores SIGTERM and stays alive", async () => {
    const c = EngineClient.start({
      cmd: [process.execPath, "-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
      timeoutMs: 5000,
      closeGraceMs: 5000,
    });
    clients.push(c);
    (c as unknown as { child: { stdout: { destroy(e: Error): void } } }).child.stdout.destroy(
      new Error("EIO: input/output error"),
    );
    const started = Date.now();
    const err = await c.hello().catch((e) => e);
    expect(err.message).toContain("reading the engine's output failed: EIO: input/output error");
    const again = await c.hello().catch((e) => e);
    expect(again.message).toContain("can no longer be used");
    expect(await c.close()).toBeNull();
    expect(Date.now() - started).toBeLessThan(3000);
  });

  // The queue's own overflow callback already kills the engine; this guards the client being
  // marked unusable after an overflow.
  test("an output overflow also leaves the client unusable", async () => {
    const c = EngineClient.start({
      cmd: [
        process.execPath,
        "-e",
        "const b = Buffer.alloc(65536, 0x41); setInterval(() => process.stdout.write(b), 1);",
      ],
      maxQueuedBytes: 200_000,
      timeoutMs: 20_000,
    });
    clients.push(c);
    await new Promise((r) => setTimeout(r, 800));
    const err = await c.hello().catch((e) => e);
    expect(err.message).toContain("without being read");
    const again = await c.hello().catch((e) => e);
    expect(again.message).toContain("can no longer be used");
  });

  test("a clean end of output is still reported as closed", async () => {
    const c = EngineClient.start({
      cmd: [process.execPath, "-e", "require('fs').closeSync(1); setInterval(() => {}, 1000)"],
      timeoutMs: 5000,
    });
    clients.push(c);
    const err = await c.hello().catch((e) => e);
    expect(err.code).toBe("exited");
    expect(err.message).toContain("closed its output");
  });
});

describe("the cap on unread engine output", () => {
  test("is above the largest legal reply (payload, header and prefix)", () => {
    expect(MAX_QUEUED_OUTPUT_BYTES).toBeGreaterThan(
      MAX_CLIENT_PAYLOAD_BYTES + MAX_HEADER_BYTES + FRAME_PREFIX_BYTES,
    );
  });

  test("a reply below the cap is accepted even when it waited unread", async () => {
    const n = 40000;
    const reply = b64(
      {
        id: 1,
        type: "window",
        start_sample: 0,
        n_samples: n,
        channels: [0],
        dtype: "float64",
        layout: "channel-major",
        byte_order: "little",
        filled_ranges: [],
        payload_bytes: n * 8,
      },
      new Uint8Array(n * 8),
    );
    const c = EngineClient.start({ cmd: replying(reply), maxQueuedBytes: 400_000 });
    clients.push(c);
    await new Promise((r) => setTimeout(r, 500));
    expect((await c.readWindow({ handle: "h1", startS: 0, durationS: 1 })).payload.length).toBe(
      n * 8,
    );
  });

  test("an engine that floods stdout is a protocol error, dropped and killed", async () => {
    const c = EngineClient.start({
      cmd: [
        process.execPath,
        "-e",
        'const b = Buffer.alloc(65536, 0x41); const t = setInterval(() => process.stdout.write(b), 1); process.on("SIGTERM", () => {});',
      ],
      maxQueuedBytes: 200_000,
      timeoutMs: 20_000,
      closeGraceMs: 5000,
    });
    clients.push(c);
    // Nobody reads for a moment, so the flood piles up past the cap.
    await new Promise((r) => setTimeout(r, 800));
    const started = Date.now();
    const err = await c.hello().catch((e) => e);
    expect(err).toBeInstanceOf(EngineClientError);
    expect(err.code).toBe("protocol");
    expect(err.message).toContain("more than 200000 bytes without being read");
    expect(Date.now() - started).toBeLessThan(3000);
    // SIGKILL, not SIGTERM (which the child ignores): it is gone well before the grace period.
    const status = await c.close();
    expect(status).toBeNull();
    expect(Date.now() - started).toBeLessThan(4000);
  });
});

describe("a fatal frame", () => {
  test("kills the engine at once, long before the output cap, and the client is unusable", async () => {
    const flood =
      'process.stdout.write("XXXXXXXX"); const b = Buffer.alloc(65536, 0x41); setInterval(() => process.stdout.write(b), 1); process.on("SIGTERM", () => {});';
    const c = EngineClient.start({
      cmd: [process.execPath, "-e", flood],
      // Far above what the test lets the child write, so only the fatal frame can stop it.
      maxQueuedBytes: 2 ** 31,
      timeoutMs: 20_000,
      closeGraceMs: 5000,
    });
    clients.push(c);
    const started = Date.now();
    const err = await c.hello().catch((e) => e);
    expect(err.code).toBe("protocol");
    expect(err.message).toContain("bad frame");
    // The child ignores SIGTERM: it is gone because of SIGKILL, promptly.
    expect(await c.close()).toBeNull();
    expect(Date.now() - started).toBeLessThan(3000);
    const again = await c.hello().catch((e) => e);
    expect(again.message).toContain("can no longer be used");
  });
});

describe("a reply to the wrong request", () => {
  const errorFrame = (id: number | null) =>
    b64({ id, type: "error", code: "not_found", message: "no such thing" });
  const staying = (frame: string) => [
    process.execPath,
    "-e",
    `process.on("SIGTERM", () => {}); process.stdout.write(Buffer.from("${frame}", "base64")); setInterval(() => {}, 1000)`,
  ];

  test("an error for another request is the same desync: engine killed, client unusable", async () => {
    const c = EngineClient.start({
      cmd: staying(errorFrame(99)),
      timeoutMs: 5000,
      closeGraceMs: 5000,
    });
    clients.push(c);
    const started = Date.now();
    const err = await c.hello().catch((e) => e);
    expect(err.code).toBe("protocol");
    expect(err.message).toContain("answered request 99, not 1");
    const again = await c.hello().catch((e) => e);
    expect(again.message).toContain("can no longer be used");
    expect(await c.close()).toBeNull();
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test("an error with id null is still an ordinary engine error, and the client stays usable", async () => {
    const c = EngineClient.start({
      cmd: staying(errorFrame(null)),
      timeoutMs: 5000,
      closeGraceMs: 300,
    });
    clients.push(c);
    const err = await c.hello().catch((e) => e);
    expect(err).toBeInstanceOf(EngineClientError);
    expect(err.code).toBe("not_found");
    expect(err.message).toContain("no such thing");
    // Not unusable: the next call waits for an answer (and times out), instead of failing fast.
    const second = c.hello().catch((e) => e);
    const result = await Promise.race([
      second,
      new Promise((r) => setTimeout(() => r("waiting"), 500)),
    ]);
    expect(result).toBe("waiting");
  });

  test("kills the engine and leaves the client unusable", async () => {
    const wrong = b64({
      id: 99,
      type: "hello",
      protocol: "0.1",
      engine: "wrong/1",
      max_payload_bytes: 1000,
    });
    const c = EngineClient.start({
      cmd: [
        process.execPath,
        "-e",
        `process.on("SIGTERM", () => {}); process.stdout.write(Buffer.from("${wrong}", "base64")); setInterval(() => {}, 1000)`,
      ],
      timeoutMs: 5000,
      closeGraceMs: 5000,
    });
    clients.push(c);
    const started = Date.now();
    const err = await c.hello().catch((e) => e);
    expect(err.code).toBe("protocol");
    expect(err.message).toContain("answered request 99, not 1");
    const again = await c.hello().catch((e) => e);
    expect(again.message).toContain("can no longer be used");
    expect(await c.close()).toBeNull();
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
