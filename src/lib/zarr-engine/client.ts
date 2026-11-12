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
import { type FrameEvent, readFrames } from "./frame-stream.js";

/** The hidden subcommand that runs the engine. */
export const ZARR_ENGINE_COMMAND = "__zarr-engine";

/** The default time one request may take. A window read over a slow link can be long. */
export const DEFAULT_CALL_TIMEOUT_MS = 120_000;
const STDERR_KEEP_BYTES = 8 * 1024;
/** The largest payload the client accepts in a reply (the engine's own cap is lower). */
const MAX_CLIENT_PAYLOAD_BYTES = 1 << 30;

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

  private constructor(options: ClientOptions) {
    const cmd = options.cmd ?? defaultEngineCommand();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.child = spawn(cmd[0], cmd.slice(1), {
      env: { ...process.env, ...options.env } as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrText = (this.stderrText + chunk.toString("utf8")).slice(-STDERR_KEEP_BYTES);
    });
    // A write to a child that already exited is reported by the pending call, not here.
    this.child.stdin.on("error", () => undefined);
    this.exited = new Promise((resolve) => {
      this.child.once("exit", (code) => resolve(code));
      this.child.once("error", (err) => {
        this.stderrText += `${err.message}\n`;
        resolve(null);
      });
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
    if (this.closed) throw this.fail("exited", "the engine is closed");
    const id = this.nextId++;
    try {
      this.child.stdin.write(encodeFrame({ id, ...header }));
    } catch (err) {
      throw this.fail("exited", `could not write to the engine: ${(err as Error).message}`);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(this.fail("timeout", `the engine did not answer within ${this.timeoutMs} ms`)),
        this.timeoutMs,
      );
    });
    const died = this.exited.then((code): never => {
      throw this.fail("exited", `the engine exited (status ${code ?? "unknown"}) before answering`);
    });
    try {
      const next = await Promise.race([this.frames.next(), timeout, died]);
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

  /** End the engine: close its stdin and wait for it to exit (killing it after 3 s). Safe to
   *  call twice. Resolves with its exit status. */
  async close(): Promise<number | null> {
    if (!this.closed) {
      this.closed = true;
      this.child.stdin.end();
    }
    const kill = setTimeout(() => this.child.kill(), 3000);
    try {
      return await this.exited;
    } finally {
      clearTimeout(kill);
    }
  }
}
