/**
 * `decodeBloscZstdInt16` against the real committed chunk fixture (epic
 * #1065 phase 2, issue #1294) -- promoted from the phase 1 spike's
 * `decode_chunk` verification, but now driving the production module
 * (`shared/zarr/codecs/blosc.ts`) directly rather than the spike's
 * MCP tool wrapper.
 *
 * `chunk.bin` is one real inner chunk of nm000329's level-0 array (see
 * `chunk.expected.json`'s `source` field for exactly which shard/offset);
 * `chunk.expected.json` is the Python-derived ground truth (a real
 * `zstandard` decompress + manual unshuffle, cross-checked against
 * `numcodecs.Blosc().decode()`).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeBloscZstdInt16 } from "../../shared/zarr/codecs/blosc";

const FIXTURE_DIR = join(import.meta.dir, "fixtures/blosc");

const chunkBytes = new Uint8Array(readFileSync(join(FIXTURE_DIR, "chunk.bin")));
const expected = JSON.parse(readFileSync(join(FIXTURE_DIR, "chunk.expected.json"), "utf-8")) as {
  first_16_flat: number[];
  sum: number;
  weighted_checksum: number;
};

function checksum(values: Int16Array): { sum: number; weighted: number } {
  let sum = 0n;
  let weighted = 0n;
  for (let i = 0; i < values.length; i++) {
    const v = BigInt(values[i]);
    sum += v;
    weighted += v * BigInt(i + 1);
  }
  return { sum: Number(sum), weighted: Number(weighted) };
}

describe("decodeBloscZstdInt16", () => {
  test("decodes the fixture chunk and matches the Python-derived ground truth", () => {
    const decoded = decodeBloscZstdInt16(chunkBytes);
    expect(Array.from(decoded.slice(0, 16))).toEqual(expected.first_16_flat);
    const { sum, weighted } = checksum(decoded);
    expect(sum).toBe(expected.sum);
    expect(weighted).toBe(expected.weighted_checksum);
  });

  test("throws on a truncated buffer (shorter than the 16-byte header)", () => {
    expect(() => decodeBloscZstdInt16(chunkBytes.subarray(0, 8))).toThrow(
      /shorter than the 16-byte/,
    );
  });

  test("throws when typesize is mutated away from int16 (2)", () => {
    const mutated = chunkBytes.slice();
    mutated[3] = 4; // typesize byte
    expect(() => decodeBloscZstdInt16(mutated)).toThrow(/typesize 4 is not int16/);
  });

  test("throws when blocksize is mutated to 0", () => {
    const mutated = chunkBytes.slice();
    const view = new DataView(mutated.buffer);
    view.setUint32(8, 0, true); // blocksize field
    expect(() => decodeBloscZstdInt16(mutated)).toThrow(/invalid blosc2 header/);
  });

  test("throws when cbytes is mutated off by one from the real buffer length", () => {
    const mutated = chunkBytes.slice();
    const view = new DataView(mutated.buffer);
    const realCbytes = view.getUint32(12, true);
    view.setUint32(12, realCbytes + 1, true); // cbytes field
    expect(() => decodeBloscZstdInt16(mutated)).toThrow(/disagrees with the/);
  });

  test("throws when the buffer is truncated after the header (offset table does not fit)", () => {
    // The fixture is a single block (nbytes === blocksize), so its offset
    // table is exactly one 4-byte entry at bytes [16, 20). Truncating to 18
    // bytes -- and correcting cbytes to match, to isolate this guard from
    // the cbytes-length check above -- leaves the table one byte short.
    const truncated = chunkBytes.slice(0, 18);
    const view = new DataView(truncated.buffer);
    view.setUint32(12, truncated.length, true); // cbytes = the truncated length
    expect(() => decodeBloscZstdInt16(truncated)).toThrow(/offset table does not fit/);
  });

  // PR #1323 review item G.20: every remaining guard, triggered individually.
  // Real header field values for this fixture (verified against the file):
  // flags=0x91 (byte-shuffle set, memcpyed/bitshuffle clear), nbytes=126000,
  // blocksize=126000, cbytes=119327=bytes.length, one block whose offset
  // table entry (bytes [16,20)) is 20, whose 4-byte compressedLen field
  // (bytes [20,24)) is 119303, with the payload running to exactly
  // bytes.length (24 + 119303 === 119327).

  test("throws when the memcpyed flag (0x2) is set", () => {
    const mutated = chunkBytes.slice();
    mutated[2] = chunkBytes[2] | 0x2; // flags byte: add the memcpyed bit
    expect(() => decodeBloscZstdInt16(mutated)).toThrow(/memcpyed \(uncompressed\)/);
  });

  test("throws when the bit-shuffle flag (0x4) is set", () => {
    const mutated = chunkBytes.slice();
    mutated[2] = chunkBytes[2] | 0x4; // flags byte: add the bit-shuffle bit
    expect(() => decodeBloscZstdInt16(mutated)).toThrow(/bit-shuffle is not implemented/);
  });

  test("throws when nbytes is mutated to 0 (distinct from the blocksize=0 case above)", () => {
    const mutated = chunkBytes.slice();
    const view = new DataView(mutated.buffer);
    view.setUint32(4, 0, true); // nbytes field; blocksize stays real (126000 > 0)
    expect(() => decodeBloscZstdInt16(mutated)).toThrow(/invalid blosc2 header \(nbytes 0/);
  });

  test("throws when nbytes is not a multiple of typesize", () => {
    const mutated = chunkBytes.slice();
    const view = new DataView(mutated.buffer);
    view.setUint32(4, 126001, true); // nbytes: odd, not divisible by typesize 2
    expect(() => decodeBloscZstdInt16(mutated)).toThrow(/nbytes 126001 is not a multiple/);
  });

  test("throws when a block's offset table entry points past the end of the chunk", () => {
    const mutated = chunkBytes.slice();
    const view = new DataView(mutated.buffer);
    view.setUint32(16, 0xfffffffe, true); // the one offset-table entry, bytes [16, 20)
    expect(() => decodeBloscZstdInt16(mutated)).toThrow(/offset 4294967294 is past the end/);
  });

  test("throws when a block's compressedLen field is 0", () => {
    const mutated = chunkBytes.slice();
    const view = new DataView(mutated.buffer);
    view.setUint32(20, 0, true); // compressedLen field at the real block start (20)
    expect(() => decodeBloscZstdInt16(mutated)).toThrow(/claims 0 compressed bytes/);
  });

  test("throws when a block's compressedLen field claims more bytes than the chunk has", () => {
    const mutated = chunkBytes.slice();
    const view = new DataView(mutated.buffer);
    view.setUint32(20, 999_999, true); // compressedLen field, way past bytes.length
    expect(() => decodeBloscZstdInt16(mutated)).toThrow(/claims 999999 compressed bytes/);
  });

  test("throws on a decompressed-length mismatch (declared nbytes/blocksize disagree with the real payload)", () => {
    const mutated = chunkBytes.slice();
    const view = new DataView(mutated.buffer);
    // The real zstd payload is untouched -- it still decompresses to its
    // real 126000 bytes -- but the header now declares a single 1000-byte
    // block, so decodeBloscZstdInt16 expects 1000 and gets 126000.
    view.setUint32(4, 1000, true); // nbytes
    view.setUint32(8, 1000, true); // blocksize
    expect(() => decodeBloscZstdInt16(mutated)).toThrow(
      /block 0 decompressed to 126000 bytes, expected 1000/,
    );
  });
});
