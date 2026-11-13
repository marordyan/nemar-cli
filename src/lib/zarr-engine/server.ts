/**
 * The engine's protocol state machine and its stdio loop (ADR 0120).
 *
 * {@link EngineServer.handle} takes one decoded request header and returns the one reply to
 * send. It tracks the hello state, validates every request with `engineRequestSchema`, keeps
 * the table of handles (`h1`, `h2`, ...), and checks each response against
 * `engineResponseSchema` before it leaves: a response that fails its own schema is a bug in
 * the engine and goes out as `internal`, never as a malformed message.
 *
 * Requests are handled one at a time, in the order they arrive ({@link serve}).
 *
 *   - hello: the protocol version is read before the rest of the hello is validated, so a
 *     well-formed version the engine does not speak is `unsupported_version` whatever else is
 *     wrong with the message, and the engine keeps running. Any other request before a
 *     successful hello, and a second hello after one, is `invalid_message`.
 *   - A frame that cannot be a request (bad JSON, a bad header) is `invalid_message` with
 *     `id: null`; the engine keeps reading. A frame the reader cannot resynchronize after
 *     (bad magic, an oversized or unpadded header, input ending inside a frame) is answered
 *     the same way and then the engine stops with status 2.
 *   - End of input between frames is a normal exit, status 0.
 */

import {
  ENGINE_PROTOCOL_VERSION,
  type EngineErrorCode,
  MAX_MESSAGE_ID,
  engineRequestSchema,
  engineResponseSchema,
} from "../../../shared/contract/zarr-engine-protocol.js";
import { FrameError, encodeFrameParts } from "../../../shared/zarr/protocol-frame.js";
import { type FrameSink, readFrames, writeFrame } from "./frame-stream.js";
import { type Binding, type DataSource, openRecording } from "./source.js";
import { readWindow, recipeFor } from "./window.js";

export interface Reply {
  header: Record<string, unknown>;
  payload?: Uint8Array;
}

export interface ServerOptions {
  source: DataSource;
  /** The largest payload the engine sends; also bounds the decode work of a read. */
  maxPayloadBytes: number;
  /** The `engine` string of the hello response. */
  engineName: string;
  /** Where a warning or an internal error is logged (stderr in the engine). */
  log?: (line: string) => void;
}

/** The most handles open at once. Each holds a parsed index and its geometry, and nothing but
 *  `release` frees one, so a client that never releases is told to rather than allowed to
 *  grow the engine without bound. */
export const MAX_OPEN_HANDLES = 1024;

const VERSION_RE = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

/** The request id when the header carries a usable one, else null. */
function readId(header: Record<string, unknown>): number | null {
  const id = header.id;
  return typeof id === "number" && Number.isInteger(id) && id >= 1 && id <= MAX_MESSAGE_ID
    ? id
    : null;
}

export function errorReply(id: number | null, code: EngineErrorCode, message: string): Reply {
  return { header: { id, type: "error", code, message } };
}

export class EngineServer {
  private helloDone = false;
  private nextHandle = 1;
  private readonly handles = new Map<string, Binding>();
  private readonly log: (line: string) => void;

  constructor(private readonly options: ServerOptions) {
    this.log = options.log ?? ((line) => console.error(line));
  }

  /** The one reply to one request header. Never throws. */
  async handle(header: Record<string, unknown>): Promise<Reply> {
    const id = readId(header);
    let reply: Reply;
    try {
      reply = await this.dispatch(header, id);
    } catch (err) {
      this.log(
        `[zarr-engine] internal error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      );
      return errorReply(id, "internal", "the engine failed to handle the request");
    }
    // Self-check: what leaves must be a valid response.
    const checked = engineResponseSchema.safeParse(reply.header);
    if (!checked.success) {
      this.log(
        `[zarr-engine] internal error: response failed its schema: ${checked.error.issues[0]?.path.join(".")} ${checked.error.issues[0]?.message}`,
      );
      return errorReply(id, "internal", "the engine built a malformed response");
    }
    // A reply that cannot be framed (a header over the limit) is never sent, so an `opened`
    // one must not leave its handle open: the client never learns the handle's name.
    if (!canFrame(reply)) {
      if (reply.header.type === "opened") this.handles.delete(String(reply.header.handle));
      this.log("[zarr-engine] internal error: a reply could not be framed");
      return errorReply(id, "internal", "the engine could not frame its reply");
    }
    return reply;
  }

  private async dispatch(header: Record<string, unknown>, id: number | null): Promise<Reply> {
    if (header.type === "hello") {
      if (this.helloDone) return errorReply(id, "invalid_message", "hello was already received");
      // Read the version before validating the rest (ADR 0120 decision 4).
      const version = header.protocol;
      if (
        typeof version === "string" &&
        VERSION_RE.test(version) &&
        version !== ENGINE_PROTOCOL_VERSION
      ) {
        return errorReply(
          id,
          "unsupported_version",
          `this engine speaks protocol ${ENGINE_PROTOCOL_VERSION}, not ${version}`,
        );
      }
    }

    const parsed = engineRequestSchema.safeParse(header);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue?.path.length ? ` (${issue.path.join(".")})` : "";
      return errorReply(
        id,
        "invalid_message",
        `not a valid request${where}: ${issue?.message ?? "invalid"}`,
      );
    }
    const request = parsed.data;
    // A request that parsed has a usable id of its own.
    const rid = request.id;

    if (request.type === "hello") {
      this.helloDone = true;
      return {
        header: {
          id: rid,
          type: "hello",
          protocol: ENGINE_PROTOCOL_VERSION,
          engine: this.options.engineName,
          max_payload_bytes: this.options.maxPayloadBytes,
        },
      };
    }
    if (!this.helloDone) {
      return errorReply(rid, "invalid_message", "the first request must be hello");
    }

    switch (request.type) {
      case "open": {
        if (this.handles.size >= MAX_OPEN_HANDLES) {
          return errorReply(
            rid,
            "too_large",
            `${MAX_OPEN_HANDLES} handles are open; release handles you no longer need before opening another`,
          );
        }
        const opened = await openRecording(
          this.options.source,
          {
            datasetId: request.dataset_id,
            recording: request.recording,
            representation: request.representation,
          },
          this.log,
        );
        if (!opened.ok) return errorReply(rid, opened.code, opened.message);
        const binding = opened.value;
        const handle = `h${this.nextHandle++}`;
        this.handles.set(handle, binding);
        return {
          header: {
            id: rid,
            type: "opened",
            handle,
            dataset_id: binding.datasetId,
            recording: binding.recording,
            representation: binding.representationId,
            record: binding.record,
            representations: binding.representations,
          },
        };
      }
      case "read_window": {
        const binding = this.handles.get(request.handle);
        if (!binding) return errorReply(rid, "unknown_handle", `no open handle ${request.handle}`);
        const read = await readWindow(this.options.source, binding, request, {
          maxPayloadBytes: this.options.maxPayloadBytes,
        });
        if (!read.ok) return errorReply(rid, read.code, read.message);
        return { header: { id: rid, ...read.value.header }, payload: read.value.payload };
      }
      case "recipe": {
        const binding = this.handles.get(request.handle);
        if (!binding) return errorReply(rid, "unknown_handle", `no open handle ${request.handle}`);
        const recipe = recipeFor(binding, request);
        if (!recipe.ok) return errorReply(rid, recipe.code, recipe.message);
        return { header: { id: rid, type: "recipe", recipe: recipe.value.recipe } };
      }
      case "release": {
        if (!this.handles.delete(request.handle)) {
          return errorReply(rid, "unknown_handle", `no open handle ${request.handle}`);
        }
        return { header: { id: rid, type: "released" } };
      }
    }
  }
}

/** Whether `reply` fits in a frame (its header within the frame header limit). */
function canFrame(reply: Reply): boolean {
  try {
    encodeFrameParts(reply.header, reply.payload);
    return true;
  } catch (err) {
    if (err instanceof FrameError) return false;
    throw err;
  }
}

/** Encode and write one reply. A reply that cannot be framed (a header over the limit) goes out
 *  as an `internal` error for the same request instead; only a failed write is thrown. */
async function send(
  sink: FrameSink,
  reply: Reply,
  log: (line: string) => void = (line) => console.error(line),
): Promise<void> {
  let parts: { head: Uint8Array; payload: Uint8Array };
  try {
    parts = encodeFrameParts(reply.header, reply.payload);
  } catch (err) {
    if (!(err instanceof FrameError)) throw err;
    log(`[zarr-engine] internal error: a reply could not be framed: ${err.message}`);
    const id = readId(reply.header);
    parts = encodeFrameParts(
      errorReply(id, "internal", "the engine could not frame its reply").header,
    );
  }
  // The head and the payload are written one after the other, so a large payload is never
  // copied into a frame buffer next to itself.
  await writeFrame(sink, parts.head);
  if (parts.payload.length > 0) await writeFrame(sink, parts.payload);
}

/**
 * Serve the protocol: read frames from `input`, write replies to `output`, one request at a
 * time. Resolves with the exit status: 0 at a clean end of input, 2 after a framing error the
 * reader cannot recover from, 1 when `output` cannot be written to.
 */
export async function serve(
  server: EngineServer,
  input: AsyncIterable<Uint8Array>,
  output: FrameSink,
  log: (line: string) => void = (line) => console.error(line),
): Promise<number> {
  try {
    for await (const event of readFrames(input)) {
      if (event.type === "frame") {
        await send(output, await server.handle(event.header), log);
      } else if (event.type === "invalid") {
        log(`[zarr-engine] invalid frame: ${event.message}`);
        await send(output, errorReply(null, "invalid_message", event.message), log);
      } else {
        log(`[zarr-engine] unrecoverable framing error (${event.kind}): ${event.message}`);
        await send(output, errorReply(null, "invalid_message", event.message), log);
        return 2;
      }
    }
    return 0;
  } catch (err) {
    if (err instanceof FrameError) log(`[zarr-engine] ${err.message}`);
    else log(`[zarr-engine] output failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
