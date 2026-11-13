/**
 * The CLI's client for the Zarr engine: it starts `nemar __zarr-engine` as a child process
 * and speaks protocol v0 to it over stdio, with `encodeFrame` and `readFrames` (the engine's
 * own framing). `nemar zarr read`, `nemar engine status` and `nemar doctor` all use it.
 *
 * The child is `[process.execPath, process.argv[1], "__zarr-engine"]`, which is the same CLI
 * entry the user ran, so it works from the source tree (`bun run src/index.ts`) and from
 * `dist/index.js`. One request is in flight at a time, as the engine serves them in order.
 * Every call has a timeout; a child that dies or goes silent is an {@link EngineClientError}
 * that carries what it wrote on stderr.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import pkg from "../../../package.json" with { type: "json" };
import {
  ENGINE_PROTOCOL_VERSION,
  type EngineErrorCode,
  type HelloResponse,
  type Opened,
  engineResponseSchema,
  helloResponseSchema,
  normalizeErrorCode,
  openedSchema,
  windowSchema,
} from "../../../shared/contract/zarr-engine-protocol.js";
import { encodeFrame } from "../../../shared/zarr/protocol-frame.js";
import { type FrameEvent, MAX_CLIENT_PAYLOAD_BYTES, readFrames } from "./frame-stream.js";

/** The hidden subcommand that runs the engine. */
export const ZARR_ENGINE_COMMAND = "__zarr-engine";

/** The default time one request may take. A window read over a slow link can be long. */
export const DEFAULT_CALL_TIMEOUT_MS = 120_000;
const STDERR_KEEP_BYTES = 8 * 1024;

/** Exact names of the environment variables the engine child receives, besides the prefixes in
 *  {@link ENGINE_ENV_PREFIXES}: what Bun and the CLI's own config and network code need (where the
 *  home and temporary directories are, the locale, the proxy and certificate settings). The
 *  engine sends no credential, so it is not handed one: `NEMAR_API_KEY`, `GITHUB_TOKEN`, cloud
 *  keys and the rest of the parent's environment stay behind. */
const ENGINE_ENV_NAMES = new Set([
  "PATH",
  "PATHEXT",
  "COMSPEC",
  "WINDIR",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "SYSTEMROOT",
  "SystemRoot",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LANGUAGE",
  "TZ",
  "TERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "NEMAR_CONFIG_DIR",
  "NEMAR_NO_UPDATE_CHECK",
  "TEST_API_URL",
]);
/** Variables of these families pass too: the locale (`LC_*`), XDG directories, Bun's own settings,
 *  and every engine setting (`NEMAR_ZARR_*`). */
const ENGINE_ENV_PREFIXES = ["LC_", "XDG_", "BUN_", "NEMAR_ZARR_"];

/** The part of `source` the engine child is started with. On Windows environment names are
 *  case-insensitive (`Path` is `PATH`), so they are matched that way there; `platform` is a
 *  parameter so both rules can be tested anywhere. */
export function engineEnvironment(
  source: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
): Record<string, string> {
  const fold = platform === "win32";
  const names = fold
    ? new Set([...ENGINE_ENV_NAMES].map((n) => n.toUpperCase()))
    : ENGINE_ENV_NAMES;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const key = fold ? name.toUpperCase() : name;
    if (names.has(key) || ENGINE_ENV_PREFIXES.some((p) => key.startsWith(p))) out[name] = value;
  }
  return out;
}

/** After the child exits, how long its stdio may take to finish (so stderr is complete). */
const STDIO_SETTLE_MS = 1000;

export type ClientErrorCode = EngineErrorCode | "timeout" | "exited" | "protocol";

export class EngineClientError extends Error {
  constructor(
    readonly code: ClientErrorCode,
    message: string,
    /** What the engine wrote on stderr, the last few KiB. */
    readonly stderr: string,
  ) {
    super(message);
    this.name = "EngineClientError";
  }
}

export interface ClientOptions {
  /** The command that starts the engine; the CLI's own entry plus `__zarr-engine` by default. */
  cmd?: string[];
  env?: Record<string, string | undefined>;
  /** Per-request timeout, milliseconds. */
  timeoutMs?: number;
  /** How long {@link EngineClient.close} waits for the engine to end before SIGTERM, and then
   *  again before SIGKILL. */
  closeGraceMs?: number;
}

export interface WindowReply {
  header: {
    start_sample: number;
    n_samples: number;
    channels: number[];
    dtype: "float64" | "int16";
    filled_ranges: { start_sample: number; end_sample: number }[];
    payload_bytes: number;
  } & Record<string, unknown>;
  payload: Uint8Array;
}

export interface ReadWindowArgs {
  handle: string;
  startS: number;
  durationS: number;
  channels?: number[];
  units?: "physical" | "digital";
}

/** The command line that starts the engine from this process's own CLI entry. */
export function defaultEngineCommand(): string[] {
  return [process.execPath, process.argv[1], ZARR_ENGINE_COMMAND];
}

export class EngineClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly frames: AsyncIterator<FrameEvent>;
  private readonly timeoutMs: number;
  private stderrText = "";
  private exited: Promise<number | null>;
  private nextId = 1;
  private closed = false;
  private readonly closeGraceMs: number;
  /** Set once a request timed out: the engine may still answer it, so no later answer can be
   *  matched to a later request. */
  private unusable: EngineClientError | null = null;

  private constructor(options: ClientOptions) {
    const cmd = options.cmd ?? defaultEngineCommand();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.closeGraceMs = options.closeGraceMs ?? 3000;
    this.child = spawn(cmd[0], cmd.slice(1), {
      env: { ...engineEnvironment(), ...options.env } as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrText = (this.stderrText + chunk.toString("utf8")).slice(-STDERR_KEEP_BYTES);
    });
    // A write to a child that already exited is reported by the pending call, not here.
    this.child.stdin.on("error", () => undefined);
    // The status comes from "exit"; "close" (after the stdio streams end) is then awaited for a
    // moment so stderr is complete. A process that inherited the child's stdio can keep "close"
    // from ever coming, so that wait is bounded and the streams are destroyed after it.
    const exitOnly = new Promise<number | null>((resolve) => {
      this.child.once("exit", (code) => resolve(code));
      this.child.once("error", (err) => {
        this.stderrText += `${err.message}\n`;
        resolve(null);
      });
    });
    const streamsClosed = new Promise<void>((resolve) => this.child.once("close", () => resolve()));
    this.exited = exitOnly.then(async (code) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        streamsClosed,
        new Promise<void>((r) => {
          timer = setTimeout(r, STDIO_SETTLE_MS);
        }),
      ]);
      clearTimeout(timer);
      this.child.stdout.destroy();
      this.child.stderr.destroy();
      this.child.stdin.destroy();
      return code;
    });
    this.frames = readFrames(this.child.stdout, {
      maxPayloadBytes: MAX_CLIENT_PAYLOAD_BYTES,
    })[Symbol.asyncIterator]();
  }

  /** Start the engine. Send {@link hello} first, as the protocol requires. */
  static start(options: ClientOptions = {}): EngineClient {
    return new EngineClient(options);
  }

  /** What the engine has written on stderr so far (the last few KiB). */
  get stderr(): string {
    return this.stderrText.trim();
  }

  private fail(code: ClientErrorCode, message: string): EngineClientError {
    return new EngineClientError(code, message, this.stderr);
  }

  private async call(
    header: Record<string, unknown>,
  ): Promise<{ header: Record<string, unknown>; payload: Uint8Array }> {
    if (this.unusable) throw this.unusable;
    if (this.closed) throw this.fail("exited", "the engine is closed");
    const id = this.nextId++;
    try {
      this.child.stdin.write(encodeFrame({ id, ...header }));
    } catch (err) {
      throw this.fail("exited", `could not write to the engine: ${(err as Error).message}`);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = this.fail("timeout", `the engine did not answer within ${this.timeoutMs} ms`);
        // A late answer to this request must never be taken for the next one's.
        this.unusable = this.fail(
          "timeout",
          "an earlier request timed out, so this engine client can no longer be used",
        );
        reject(err);
      }, this.timeoutMs);
    });
    const died = this.exited.then((code): never => {
      throw this.fail("exited", `the engine exited (status ${code ?? "unknown"}) before answering`);
    });
    try {
      // A stream destroyed after the child's exit ends the iteration with an error: that is the
      // child being gone, the same as its output closing.
      const frame = this.frames
        .next()
        .catch(() => ({ done: true, value: undefined }) as IteratorReturnResult<undefined>);
      const next = await Promise.race([frame, timeout, died]);
      if (next.done) {
        // Its output closed: it is exiting, so say with what status when it has.
        const code = await Promise.race([
          this.exited,
          new Promise<"pending">((r) => setTimeout(() => r("pending"), 1000)),
        ]);
        throw this.fail(
          "exited",
          code === "pending"
            ? "the engine closed its output before answering"
            : `the engine exited (status ${code ?? "unknown"}) before answering`,
        );
      }
      const event = next.value;
      if (event.type !== "frame") {
        throw this.fail("protocol", `the engine sent a bad frame: ${event.message}`);
      }
      const parsed = engineResponseSchema.safeParse(event.header);
      if (!parsed.success) throw this.fail("protocol", "the engine sent an invalid response");
      if (event.header.id !== id && event.header.type !== "error") {
        throw this.fail("protocol", `the engine answered request ${event.header.id}, not ${id}`);
      }
      if (event.header.type === "error") {
        const code = normalizeErrorCode(String(event.header.code));
        throw this.fail(code, String(event.header.message));
      }
      return { header: event.header, payload: event.payload };
    } finally {
      clearTimeout(timer);
      // The race's losers must not become unhandled rejections.
      died.catch(() => undefined);
      timeout.catch(() => undefined);
    }
  }

  async hello(): Promise<HelloResponse> {
    const { header } = await this.call({
      type: "hello",
      protocol: ENGINE_PROTOCOL_VERSION,
      client: `nemar-cli/${pkg.version}`,
    });
    const parsed = helloResponseSchema.safeParse(header);
    if (!parsed.success) throw this.fail("protocol", "the engine sent an invalid hello");
    return parsed.data;
  }

  async open(args: {
    datasetId: string;
    recording: string;
    representation?: string;
  }): Promise<Opened> {
    const { header } = await this.call({
      type: "open",
      dataset_id: args.datasetId,
      recording: args.recording,
      ...(args.representation === undefined ? {} : { representation: args.representation }),
    });
    const parsed = openedSchema.safeParse(header);
    if (!parsed.success) throw this.fail("protocol", "the engine sent an invalid opened reply");
    return parsed.data;
  }

  async readWindow(args: ReadWindowArgs): Promise<WindowReply> {
    const { header, payload } = await this.call({
      type: "read_window",
      handle: args.handle,
      start_s: args.startS,
      duration_s: args.durationS,
      ...(args.channels === undefined ? {} : { channels: args.channels }),
      ...(args.units === undefined ? {} : { units: args.units }),
    });
    const parsed = windowSchema.safeParse(header);
    if (!parsed.success || payload.length !== parsed.data.payload_bytes) {
      throw this.fail("protocol", "the engine sent an invalid window");
    }
    // A plain Uint8Array over the same bytes: the stream hands over a Node Buffer, whose
    // `slice` is a view and whose `.buffer` can be a pool far larger than the payload.
    const plain = new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
    return { header: parsed.data as WindowReply["header"], payload: plain };
  }

  async release(handle: string): Promise<void> {
    await this.call({ type: "release", handle });
  }

  /** End the engine: close its stdin and wait for it to exit, asking with SIGTERM after the grace
   *  period and forcing it with SIGKILL after another. Safe to call twice. Resolves with its exit
   *  status (null when a signal ended it). */
  async close(): Promise<number | null> {
    if (!this.closed) {
      this.closed = true;
      this.child.stdin.end();
    }
    const term = setTimeout(() => this.child.kill("SIGTERM"), this.closeGraceMs);
    const kill = setTimeout(() => this.child.kill("SIGKILL"), this.closeGraceMs * 2);
    try {
      return await this.exited;
    } finally {
      clearTimeout(term);
      clearTimeout(kill);
    }
  }
}
