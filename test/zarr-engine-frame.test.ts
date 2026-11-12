/**
 * Cross-language check of the engine frame codec (phase 3 of the Zarr reader
 * epic). The golden frames under `test/fixtures/engine-frames/` are written by
 * `scripts/zarr/engine_frame_fixtures.py`, an independent Python implementation
 * of the framing. Here the TypeScript codec must (1) decode every one of them
 * to exactly what `expected.json` says, bit for bit, and (2) encode the same
 * header and payload to the very same bytes. A format both languages get wrong
 * the same way is still possible, which is why the layout is also pinned byte
 * by byte in the hand-built malformed-frame tests below.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { engineMessageSchema } from "../shared/contract/zarr-engine-protocol.js";
import {
  FRAME_PREFIX_BYTES,
  FrameError,
  type FrameErrorKind,
  MAX_HEADER_BYTES,
  decodeFrame,
  encodeFrame,
  encodeFrameParts,
} from "../shared/zarr/protocol-frame.js";
import {
  compileNeuroschemaRecordValidator,
  formatAjvErrors,
} from "./contract/neuroschema-validator.js";
import realRecords from "./fixtures/neuroschema-records/nm000103-sample.json";

const DIR = new URL("./fixtures/engine-frames/", import.meta.url);

interface Expected {
  file: string;
  header: Record<string, unknown>;
  payload: { dtype: "float64" | "int16"; values: number[][] } | null;
}

const expected = JSON.parse(readFileSync(new URL("expected.json", DIR), "utf8")) as Expected[];
const fileBytes = (name: string) => new Uint8Array(readFileSync(new URL(name, DIR)));

/** Channel-major little-endian bytes for the given values, written with DataView
 *  so the result does not depend on the host's byte order. */
function packPayload(dtype: "float64" | "int16", values: number[][]): Uint8Array {
  const size = dtype === "float64" ? 8 : 2;
  const flat = values.flat();
  const out = new Uint8Array(flat.length * size);
  const view = new DataView(out.buffer);
  flat.forEach((v, i) => {
    if (dtype === "float64") view.setFloat64(i * 8, v, true);
    else view.setInt16(i * 2, v, true);
  });
  return out;
}

/** Read a payload back as channel-major arrays, through a copied (so aligned) buffer. */
function readPayload(
  dtype: "float64" | "int16",
  payload: Uint8Array,
  nChannels: number,
): (Float64Array | Int16Array)[] {
  const copy = payload.slice().buffer;
  const all = dtype === "float64" ? new Float64Array(copy) : new Int16Array(copy);
  const per = all.length / nChannels;
  return Array.from({ length: nChannels }, (_, c) => all.slice(c * per, (c + 1) * per));
}

/** Bits of a float64, so -0 vs 0 and NaN payloads cannot hide behind `==`. */
const bits = (n: number) => {
  const b = new DataView(new ArrayBuffer(8));
  b.setFloat64(0, n);
  return b.getBigUint64(0);
};

function expectFrameError(kind: FrameErrorKind, fn: () => unknown) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(FrameError);
    expect((e as FrameError).kind).toBe(kind);
    return;
  }
  throw new Error(`expected a FrameError of kind ${kind}, nothing was thrown`);
}

describe("golden frames written by Python", () => {
  test("the fixture set covers hello, opened, both window dtypes and an error", () => {
    expect(expected.map((e) => e.file).sort()).toEqual([
      "error-null-id.bin",
      "error.bin",
      "hello-request.bin",
      "opened.bin",
      "window-float64.bin",
      "window-int16-filled.bin",
    ]);
  });

  test("the opened frame carries the published neuroschema record unchanged, and it validates", () => {
    const { header } = decodeFrame(fileBytes("opened.bin"));
    expect(header.record).toEqual(realRecords[0]);
    const validate = compileNeuroschemaRecordValidator();
    const ok = validate(header.record);
    if (!ok) throw new Error(formatAjvErrors(validate));
  });

  for (const exp of expected) {
    describe(exp.file, () => {
      const bytes = fileBytes(exp.file);

      test("decodes to the expected header and payload, bit-exact", () => {
        const { header, payload } = decodeFrame(bytes);
        expect(header).toEqual(exp.header);
        if (exp.payload === null) {
          expect(payload.length).toBe(0);
          return;
        }
        const channels = header.channels as number[];
        const got = readPayload(exp.payload.dtype, payload, channels.length);
        expect(got.length).toBe(exp.payload.values.length);
        got.forEach((arr, c) => {
          const want = exp.payload?.values[c] ?? [];
          expect(arr.length).toBe(want.length);
          arr.forEach((v, i) => {
            if (exp.payload?.dtype === "float64") expect(bits(v)).toBe(bits(want[i]));
            else expect(v).toBe(want[i]);
          });
        });
      });

      test("TypeScript encoding is byte-identical to the Python file", () => {
        const payload = exp.payload
          ? packPayload(exp.payload.dtype, exp.payload.values)
          : undefined;
        const ours = encodeFrame(exp.header, payload);
        expect(Buffer.from(ours).equals(Buffer.from(bytes))).toBe(true);
      });

      test("encodeFrameParts: head then payload is the same bytes, and the payload is not copied", () => {
        const payload = exp.payload
          ? packPayload(exp.payload.dtype, exp.payload.values)
          : undefined;
        const parts = encodeFrameParts(exp.header, payload);
        const joined = new Uint8Array(parts.head.length + parts.payload.length);
        joined.set(parts.head, 0);
        joined.set(parts.payload, parts.head.length);
        expect(Buffer.from(joined).equals(Buffer.from(bytes))).toBe(true);
        expect(
          Buffer.from(parts.head).equals(Buffer.from(bytes.subarray(0, parts.head.length))),
        ).toBe(true);
        if (payload) expect(parts.payload).toBe(payload);
        else expect(parts.payload.length).toBe(0);
      });

      test("the header validates as a protocol message", () => {
        const parsed = engineMessageSchema.safeParse(decodeFrame(bytes).header);
        expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(
          true,
        );
      });

      test("a float64 payload starts 8-byte aligned", () => {
        const { payload } = decodeFrame(bytes);
        expect((bytes.length - payload.length) % 8).toBe(0);
      });
    });
  }

  test("the float64 window really holds a negative and a non-integer", () => {
    const f = expected.find((e) => e.file === "window-float64.bin");
    const flat = f?.payload?.values.flat() ?? [];
    expect(flat.some((v) => v < 0)).toBe(true);
    expect(flat.some((v) => !Number.isInteger(v))).toBe(true);
  });
});

describe("malformed frames fail with a typed error", () => {
  const good = fileBytes("hello-request.bin");
  const windowFrame = fileBytes("window-float64.bin");

  test("bad magic", () => {
    const bad = good.slice();
    bad[0] = 0x58; // "X"
    expectFrameError("bad_magic", () => decodeFrame(bad));
  });

  test("shorter than the 8-byte prefix", () => {
    expectFrameError("truncated", () => decodeFrame(good.subarray(0, 7)));
  });

  test("header cut short", () => {
    expectFrameError("truncated", () => decodeFrame(good.subarray(0, 20)));
  });

  test("payload cut short", () => {
    expectFrameError("truncated", () =>
      decodeFrame(windowFrame.subarray(0, windowFrame.length - 1)),
    );
  });

  test("extra bytes after the payload", () => {
    const longer = new Uint8Array(windowFrame.length + 1);
    longer.set(windowFrame);
    expectFrameError("payload_mismatch", () => decodeFrame(longer));
  });

  test("header_len that leaves 8 + header_len off a multiple of 8", () => {
    const bad = good.slice();
    new DataView(bad.buffer).setUint32(4, new DataView(bad.buffer).getUint32(4, true) - 1, true);
    expectFrameError("unpadded", () => decodeFrame(bad));
  });

  test("header_len above the 1 MiB limit", () => {
    const bad = good.slice();
    new DataView(bad.buffer).setUint32(4, MAX_HEADER_BYTES + 8, true);
    expectFrameError("header_too_large", () => decodeFrame(bad));
  });

  test("padding that is not JSON whitespace", () => {
    const bad = windowFrame.slice();
    const headerEnd = FRAME_PREFIX_BYTES + new DataView(bad.buffer).getUint32(4, true);
    // The last header byte is padding or the closing brace; make it garbage either way.
    bad[headerEnd - 1] = 0x00;
    expectFrameError("bad_header", () => decodeFrame(bad));
  });

  test("a header that is JSON but not an object", () => {
    const text = new TextEncoder().encode("[1,2,3]         ");
    const bytes = new Uint8Array(8 + text.length);
    bytes.set(new TextEncoder().encode("NZE0"));
    new DataView(bytes.buffer).setUint32(4, text.length, true);
    bytes.set(text, 8);
    expectFrameError("bad_header", () => decodeFrame(bytes));
  });

  test("payload_bytes larger than the payload", () => {
    const bad = windowFrame.slice(0, windowFrame.length - 8);
    expectFrameError("truncated", () => decodeFrame(bad));
  });

  test("payload_bytes smaller than the payload", () => {
    const { header } = decodeFrame(windowFrame);
    const smaller = encodeFrame({ ...header, payload_bytes: 40 }, new Uint8Array(40));
    const glued = new Uint8Array(smaller.length + 8);
    glued.set(smaller);
    expectFrameError("payload_mismatch", () => decodeFrame(glued));
  });

  test("encodeFrame refuses a payload that disagrees with payload_bytes", () => {
    const { header } = decodeFrame(windowFrame);
    expectFrameError("payload_mismatch", () => encodeFrame(header, new Uint8Array(47)));
    expectFrameError("payload_mismatch", () =>
      encodeFrame({ id: 1, type: "released" }, new Uint8Array(1)),
    );
  });

  test("encodeFrameParts refuses what encodeFrame refuses", () => {
    const { header } = decodeFrame(windowFrame);
    expectFrameError("payload_mismatch", () => encodeFrameParts(header, new Uint8Array(47)));
    expectFrameError("header_too_large", () =>
      encodeFrameParts({ id: 1, type: "error", message: "x".repeat(MAX_HEADER_BYTES) }),
    );
  });

  test("encodeFrame refuses a header over the limit", () => {
    expectFrameError("header_too_large", () =>
      encodeFrame({ id: 1, type: "error", message: "x".repeat(MAX_HEADER_BYTES) }),
    );
  });
});

/** A frame built by hand: `headerBytes` padded with spaces to an 8-byte boundary, then `payload`. */
function rawFrame(headerBytes: Uint8Array, payload = new Uint8Array(0)): Uint8Array {
  const pad = (8 - ((8 + headerBytes.length) % 8)) % 8;
  const headerLen = headerBytes.length + pad;
  const out = new Uint8Array(8 + headerLen + payload.length);
  out.set(new TextEncoder().encode("NZE0"));
  new DataView(out.buffer).setUint32(4, headerLen, true);
  out.set(headerBytes, 8);
  out.fill(0x20, 8 + headerBytes.length, 8 + headerLen);
  out.set(payload, 8 + headerLen);
  return out;
}
const text = (t: string) => new TextEncoder().encode(t);

describe("hand-built hostile frames", () => {
  const BAD_PAYLOAD_BYTES: [string, string][] = [
    ["negative", '{"id":1,"type":"released","payload_bytes":-1}'],
    ["fractional", '{"id":1,"type":"released","payload_bytes":1.5}'],
    ["null", '{"id":1,"type":"released","payload_bytes":null}'],
    ["a string", '{"id":1,"type":"released","payload_bytes":"0"}'],
  ];
  for (const [what, json] of BAD_PAYLOAD_BYTES) {
    test(`payload_bytes ${what} is a bad_header`, () => {
      expectFrameError("bad_header", () => decodeFrame(rawFrame(text(json))));
    });
  }

  test("the same header with a valid payload_bytes decodes (the rows above test that value)", () => {
    const ok = decodeFrame(rawFrame(text('{"id":1,"type":"released","payload_bytes":0}')));
    expect(ok.header.payload_bytes).toBe(0);
  });

  test("header_len 0xFFFFFFFF is header_too_large", () => {
    const bad = rawFrame(text('{"id":1,"type":"released"}'));
    new DataView(bad.buffer).setUint32(4, 0xffffffff, true);
    expectFrameError("header_too_large", () => decodeFrame(bad));
  });

  test("invalid UTF-8 in the header is a bad_header", () => {
    const json = text('{"id":1,"type":"released","message":"_"}');
    const at = json.indexOf(0x5f);
    json[at] = 0xff; // never valid in UTF-8
    expectFrameError("bad_header", () => decodeFrame(rawFrame(json)));
  });

  test("a UTF-8 BOM before the header is rejected, not skipped", () => {
    const json = text('{"id":1,"type":"released"}');
    const withBom = new Uint8Array(3 + json.length);
    withBom.set([0xef, 0xbb, 0xbf]);
    withBom.set(json, 3);
    expectFrameError("bad_header", () => decodeFrame(rawFrame(withBom)));
    // Without the BOM the same header is fine.
    expect(decodeFrame(rawFrame(json)).header).toEqual({ id: 1, type: "released" });
  });
});

describe("frame layout, pinned independently of the fixtures", () => {
  test("a frame with no payload_bytes: magic, LE length, padded header, nothing after", () => {
    const out = encodeFrame({ id: 1, type: "released" });
    expect(new TextDecoder().decode(out.subarray(0, 4))).toBe("NZE0");
    const headerLen = new DataView(out.buffer).getUint32(4, true);
    expect(out.length).toBe(8 + headerLen);
    expect(out.length % 8).toBe(0);
    const text = new TextDecoder().decode(out.subarray(8));
    expect(text.trimEnd()).toBe('{"id":1,"type":"released"}');
    expect(text.slice(text.trimEnd().length)).toBe(" ".repeat(text.length - text.trimEnd().length));
  });

  test("a header that already ends on a boundary gets no padding, others get 1 to 7 spaces", () => {
    for (let n = 1; n <= 8; n++) {
      const header = { id: 1, type: "hello", protocol: "0.1", client: "c".repeat(n) };
      const json = JSON.stringify(header);
      const out = encodeFrame(header);
      const headerLen = new DataView(out.buffer).getUint32(4, true);
      const text = new TextDecoder().decode(out.subarray(8, 8 + headerLen));
      expect(text.startsWith(json), `client length ${n}`).toBe(true);
      expect(text.slice(json.length)).toBe(" ".repeat(headerLen - json.length));
      expect(headerLen - json.length, `client length ${n}`).toBeLessThan(8);
      expect(out.length % 8).toBe(0);
    }
  });
});
