/**
 * Frame codec for the Zarr engine protocol (v0, unstable). Pure TypeScript:
 * `DataView`, `TextEncoder` and `TextDecoder` only, so it is safe in a Worker,
 * Bun or a browser, and imports nothing from `backend/`, `node:` or `bun:`.
 *
 * One frame is one message, in either direction:
 *
 *   offset 0            4 bytes  magic "NZE0" (ASCII)
 *   offset 4            4 bytes  header_len, u32 little-endian
 *   offset 8            header_len bytes: a UTF-8 JSON object, right-padded
 *                       with spaces (0x20) so that 8 + header_len is a
 *                       multiple of 8
 *   offset 8+header_len header.payload_bytes bytes of payload (absent = 0)
 *
 * The padding is what lets a float64 payload start 8-byte aligned, so numpy
 * `frombuffer` and MATLAB `typecast` read it without copying. JSON allows
 * trailing whitespace, so a reader needs no special handling for it.
 *
 * This codec checks FRAMING only: the magic, the lengths, the padding, that the
 * header is a JSON object, and that `payload_bytes` matches the payload. That
 * the header is a valid MESSAGE is `shared/contract/zarr-engine-protocol.ts`.
 * The payload size limit is engine policy and lives with the engine, not here.
 */

export const FRAME_MAGIC = "NZE0";
/** Largest header the codec accepts (1 MiB). A larger one is an `invalid_message`. */
export const MAX_HEADER_BYTES = 1024 * 1024;
/** Bytes before the header: magic (4) + header_len (4). */
export const FRAME_PREFIX_BYTES = 8;

export type FrameErrorKind =
  | "bad_magic"
  | "truncated"
  | "unpadded"
  | "header_too_large"
  | "bad_header"
  | "payload_mismatch";

/** A malformed frame. `kind` says which rule it broke. */
export class FrameError extends Error {
  readonly kind: FrameErrorKind;
  constructor(kind: FrameErrorKind, message: string) {
    super(message);
    this.name = "FrameError";
    this.kind = kind;
  }
}

export interface DecodedFrame {
  header: Record<string, unknown>;
  /** A view into the input bytes, not a copy. Empty when the frame has no payload. */
  payload: Uint8Array;
}

const encoder = new TextEncoder();
// ignoreBOM keeps a leading U+FEFF in the decoded text, so JSON.parse rejects it;
// by default the decoder would strip it silently and a BOM-prefixed header would
// be accepted. Invalid UTF-8 throws (fatal) and becomes a bad_header.
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** The `payload_bytes` a header declares: absent means 0. */
function declaredPayloadBytes(header: Record<string, unknown>): number {
  const n = header.payload_bytes;
  if (n === undefined) return 0;
  // The typeof is for the type checker; Number.isInteger alone rejects every non-number.
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
    throw new FrameError("bad_header", "payload_bytes must be a non-negative integer");
  }
  return n;
}

/**
 * Encode one frame as two pieces that are NOT joined: `head` (the 8-byte prefix and the padded
 * header) and `payload` (the caller's own bytes, not copied). Writing `head` then `payload` puts
 * exactly the bytes {@link encodeFrame} returns on the wire, without a second copy of a large
 * payload. Header serialization and errors are those of {@link encodeFrame}.
 */
export function encodeFrameParts(
  header: Record<string, unknown>,
  payload?: Uint8Array,
): { head: Uint8Array; payload: Uint8Array } {
  const body = payload ?? new Uint8Array(0);
  if (declaredPayloadBytes(header) !== body.length) {
    throw new FrameError(
      "payload_mismatch",
      `header declares ${declaredPayloadBytes(header)} payload bytes, payload has ${body.length}`,
    );
  }
  const json = encoder.encode(JSON.stringify(header));
  const pad = (8 - ((FRAME_PREFIX_BYTES + json.length) % 8)) % 8;
  const headerLen = json.length + pad;
  if (headerLen > MAX_HEADER_BYTES) {
    throw new FrameError(
      "header_too_large",
      `header is ${headerLen} bytes, limit ${MAX_HEADER_BYTES}`,
    );
  }
  const head = new Uint8Array(FRAME_PREFIX_BYTES + headerLen);
  head.set(encoder.encode(FRAME_MAGIC), 0);
  new DataView(head.buffer).setUint32(4, headerLen, true);
  head.set(json, FRAME_PREFIX_BYTES);
  head.fill(0x20, FRAME_PREFIX_BYTES + json.length, FRAME_PREFIX_BYTES + headerLen);
  return { head, payload: body };
}

/**
 * Encode one frame. The header is serialized with `JSON.stringify` in the
 * object's own key order (compact, no spaces). Decoders must accept any valid
 * JSON header; byte-identical output across languages is only claimed for the
 * fixtures' headers (integers, ASCII strings, a fixed key order), not for
 * arbitrary JSON (float formatting and non-ASCII escaping differ by language).
 * Throws a `FrameError` if `payload_bytes` disagrees with `payload`.
 */
export function encodeFrame(header: Record<string, unknown>, payload?: Uint8Array): Uint8Array {
  const { head, payload: body } = encodeFrameParts(header, payload);
  const out = new Uint8Array(head.length + body.length);
  out.set(head, 0);
  out.set(body, head.length);
  return out;
}

/**
 * Decode exactly one frame from `bytes`. Anything left over, or anything
 * missing, is a `payload_mismatch` or `truncated` `FrameError`.
 */
export function decodeFrame(bytes: Uint8Array): DecodedFrame {
  if (bytes.length < FRAME_PREFIX_BYTES) {
    throw new FrameError("truncated", `frame is ${bytes.length} bytes, prefix needs 8`);
  }
  for (let i = 0; i < 4; i++) {
    if (bytes[i] !== FRAME_MAGIC.charCodeAt(i)) {
      throw new FrameError("bad_magic", "frame does not start with NZE0");
    }
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLen = view.getUint32(4, true);
  if (headerLen > MAX_HEADER_BYTES) {
    throw new FrameError("header_too_large", `header_len ${headerLen} exceeds ${MAX_HEADER_BYTES}`);
  }
  if ((FRAME_PREFIX_BYTES + headerLen) % 8 !== 0) {
    throw new FrameError("unpadded", `8 + header_len (${headerLen}) is not a multiple of 8`);
  }
  const payloadStart = FRAME_PREFIX_BYTES + headerLen;
  if (bytes.length < payloadStart) {
    throw new FrameError(
      "truncated",
      `header_len ${headerLen} runs past the ${bytes.length} bytes`,
    );
  }
  let header: unknown;
  try {
    header = JSON.parse(decoder.decode(bytes.subarray(FRAME_PREFIX_BYTES, payloadStart)));
  } catch {
    throw new FrameError("bad_header", "header is not valid UTF-8 JSON");
  }
  if (typeof header !== "object" || header === null || Array.isArray(header)) {
    throw new FrameError("bad_header", "header is not a JSON object");
  }
  const record = header as Record<string, unknown>;
  const declared = declaredPayloadBytes(record);
  const actual = bytes.length - payloadStart;
  if (actual < declared) {
    throw new FrameError("truncated", `payload has ${actual} bytes, header declares ${declared}`);
  }
  if (actual > declared) {
    throw new FrameError(
      "payload_mismatch",
      `payload has ${actual} bytes, header declares ${declared}`,
    );
  }
  return { header: record, payload: bytes.subarray(payloadStart) };
}
