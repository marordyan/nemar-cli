/**
 * The engine's incremental frame reader and backpressured writer
 * (`src/lib/zarr-engine/frame-stream.ts`). The frames are the committed
 * cross-language fixtures plus frames built with the real `encodeFrame`; the
 * writer test uses a real `node:stream` Writable with a slow consumer.
 *
 * What matters here: a pipe may split a frame anywhere, so the reader must
 * give the same frames for every split; and after a bad frame the reader must
 * recover only when it still knows where the next frame starts.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Writable } from "node:stream";
import { encodeFrame } from "../shared/zarr/protocol-frame.js";
import {
  FrameReader,
  MAX_REQUEST_PAYLOAD_BYTES,
  readFrames,
  writeFrame,
} from "../src/lib/zarr-engine/frame-stream.js";

const DIR = new URL("./fixtures/engine-frames/", import.meta.url);
const fixture = (name: string) => new Uint8Array(readFileSync(new URL(name, DIR)));

const hello = encodeFrame({ id: 1, type: "hello", protocol: "0.1", client: "t" });
const release = encodeFrame({ id: 2, type: "release", handle: "h1" });
const windowFrame = fixture("window-float64.bin");

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Hand-built prefix, for malformed frames: magic, header_len, header, payload. */
function raw(opts: { magic?: string; headerLen?: number; header?: string; payload?: Uint8Array }) {
  const header = new TextEncoder().encode(opts.header ?? "{}");
  const headerLen = opts.headerLen ?? header.length;
  const prefix = new Uint8Array(8);
  prefix.set(new TextEncoder().encode(opts.magic ?? "NZE0"), 0);
  new DataView(prefix.buffer).setUint32(4, headerLen, true);
  return concat(prefix, header, opts.payload ?? new Uint8Array(0));
}

/** Header padded with spaces so 8 + header_len is a multiple of 8. */
function paddedHeader(json: string): string {
  const pad = (8 - ((8 + json.length) % 8)) % 8;
  return json + " ".repeat(pad);
}

describe("FrameReader", () => {
  test("a frame split at every byte boundary reads the same frame", () => {
    const whole = concat(hello, windowFrame, release);
    for (let cut = 0; cut <= whole.length; cut++) {
      const reader = new FrameReader();
      const events = [...reader.push(whole.subarray(0, cut)), ...reader.push(whole.subarray(cut))];
      expect(events.map((e) => e.type)).toEqual(["frame", "frame", "frame"]);
      const headers = events.map((e) => (e.type === "frame" ? e.header.type : null));
      expect(headers).toEqual(["hello", "window", "release"]);
      const win = events[1];
      if (win.type !== "frame") throw new Error("expected a frame");
      expect(win.payload.length).toBe(win.header.payload_bytes as number);
      expect(reader.end()).toEqual([]);
    }
  });

  test("one byte at a time reads every frame", () => {
    const whole = concat(hello, windowFrame);
    const reader = new FrameReader();
    const events = [];
    for (const b of whole) events.push(...reader.push(Uint8Array.of(b)));
    expect(events.map((e) => e.type)).toEqual(["frame", "frame"]);
  });

  test("two frames in one chunk both come out, in order", () => {
    const events = new FrameReader().push(concat(hello, release));
    expect(events.map((e) => (e.type === "frame" ? e.header.type : e.type))).toEqual([
      "hello",
      "release",
    ]);
  });

  test("a payload is passed through bit for bit", () => {
    const [event] = new FrameReader().push(windowFrame);
    if (event.type !== "frame") throw new Error("expected a frame");
    expect(event.payload).toEqual(windowFrame.subarray(windowFrame.length - event.payload.length));
  });

  test("end of input between frames is clean", () => {
    const reader = new FrameReader();
    reader.push(hello);
    expect(reader.end()).toEqual([]);
  });

  test("end of input mid-frame is fatal truncated", () => {
    const reader = new FrameReader();
    expect(reader.push(hello.subarray(0, hello.length - 1))).toEqual([]);
    const [event] = reader.end();
    expect(event).toMatchObject({ type: "fatal", kind: "truncated" });
  });

  test("a header that is not JSON is invalid, and the next frame still reads", () => {
    const bad = raw({ header: paddedHeader("not json") });
    const events = new FrameReader().push(concat(bad, hello));
    expect(events[0]).toMatchObject({ type: "invalid", kind: "bad_header" });
    expect(events[1]).toMatchObject({ type: "frame" });
  });

  test("a header that is a JSON array is invalid, and the next frame still reads", () => {
    const events = new FrameReader().push(concat(raw({ header: paddedHeader("[1]") }), hello));
    expect(events[0]).toMatchObject({ type: "invalid", kind: "bad_header" });
    expect(events[1]).toMatchObject({ type: "frame" });
  });

  test("a non-integer payload_bytes is invalid, and the next frame still reads", () => {
    const bad = raw({ header: paddedHeader('{"payload_bytes":1.5}') });
    const events = new FrameReader().push(concat(bad, hello));
    expect(events[0]).toMatchObject({ type: "invalid", kind: "bad_header" });
    expect(events[1]).toMatchObject({ type: "frame" });
  });

  test("a small request payload is read and handed on (validation refuses it later)", () => {
    const withPayload = encodeFrame(
      { id: 1, type: "release", handle: "h1", payload_bytes: 8 },
      new Uint8Array(8),
    );
    const events = new FrameReader().push(concat(withPayload, hello));
    expect(events.map((e) => e.type)).toEqual(["frame", "frame"]);
  });

  test("bad magic is fatal and stops the reader", () => {
    const reader = new FrameReader();
    const events = reader.push(concat(raw({ magic: "XXXX" }), hello));
    expect(events).toEqual([
      { type: "fatal", kind: "bad_magic", message: expect.any(String) as string },
    ]);
    expect(reader.push(hello)).toEqual([]);
    expect(reader.end()).toEqual([]);
  });

  test("bad magic is reported as soon as 4 bytes arrive, before the prefix is whole", () => {
    const [event] = new FrameReader().push(new TextEncoder().encode("GET "));
    expect(event).toMatchObject({ type: "fatal", kind: "bad_magic" });
  });

  test("an oversized header_len is fatal without waiting for the header", () => {
    const prefix = raw({ headerLen: 1024 * 1024 + 8, header: "" });
    const [event] = new FrameReader().push(prefix);
    expect(event).toMatchObject({ type: "fatal", kind: "header_too_large" });
  });

  test("an unpadded prefix is fatal", () => {
    const [event] = new FrameReader().push(raw({ headerLen: 3, header: "{} " }));
    expect(event).toMatchObject({ type: "fatal", kind: "unpadded" });
  });

  test("a request payload past the limit is fatal and is not buffered", () => {
    const header = paddedHeader(`{"payload_bytes":${MAX_REQUEST_PAYLOAD_BYTES + 1}}`);
    const [event] = new FrameReader().push(raw({ header }));
    expect(event).toMatchObject({ type: "fatal", kind: "payload_too_large" });
  });
});

describe("readFrames", () => {
  async function* chunks(...parts: Uint8Array[]) {
    for (const p of parts) yield p;
  }
  async function collect(source: AsyncIterable<Uint8Array>) {
    const out = [];
    for await (const e of readFrames(source)) out.push(e);
    return out;
  }

  test("yields frames and ends cleanly", async () => {
    const events = await collect(chunks(hello.subarray(0, 5), hello.subarray(5), release));
    expect(events.map((e) => e.type)).toEqual(["frame", "frame"]);
  });

  test("a cut-off final frame ends the stream with fatal truncated", async () => {
    const events = await collect(chunks(hello, release.subarray(0, 10)));
    expect(events.map((e) => e.type)).toEqual(["frame", "fatal"]);
    expect(events[1]).toMatchObject({ kind: "truncated" });
  });

  test("stops at a fatal event and ignores what follows", async () => {
    const events = await collect(chunks(raw({ magic: "XXXX" }), hello));
    expect(events.map((e) => e.type)).toEqual(["fatal"]);
  });
});

describe("writeFrame", () => {
  test("waits for a slow consumer, and every byte arrives in order", async () => {
    const received: Uint8Array[] = [];
    let pending = 0;
    let maxPending = 0;
    const sink = new Writable({
      highWaterMark: 16,
      write(chunk, _enc, done) {
        pending++;
        maxPending = Math.max(maxPending, pending);
        setTimeout(() => {
          received.push(new Uint8Array(chunk));
          pending--;
          done();
        }, 5);
      },
    });
    const frames = [hello, windowFrame, release];
    for (const f of frames) await writeFrame(sink, f);
    // Awaiting each write means the sink never holds more than one.
    expect(maxPending).toBe(1);
    expect(concat(...received)).toEqual(concat(...frames));
  });

  test("rejects when the sink fails", async () => {
    const sink = new Writable({
      write(_chunk, _enc, done) {
        done(new Error("pipe closed"));
      },
    });
    sink.on("error", () => {}); // the stream also emits the error; writeFrame reports it via the callback
    await expect(writeFrame(sink, hello)).rejects.toThrow("pipe closed");
  });
});
