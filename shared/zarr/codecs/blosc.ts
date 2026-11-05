/**
 * Blosc2/zstd/byte-shuffle inner-chunk decoder for a served Zarr array
 * (epic #1065 phase 2, issue #1294). Promoted verbatim from the phase 1
 * spike's decode path (b) (`backend/spike/mcp-transport/src/decode.ts`),
 * which the spike proved is the only path that runs under workerd: path (a)
 * (`numcodecs`' WASM `Blosc` codec) fails there outright --
 * `WebAssembly.instantiate(): Wasm code generation disallowed by embedder`,
 * because the package loads its WASM module via a runtime `fetch()` +
 * `WebAssembly.instantiate()` on the fetched bytes, which workerd's embedder
 * disallows by default, and it ships no `.wasm` file to statically import
 * instead. See `.context/mcp-server-design.md` section 10 for the full
 * measurement.
 *
 * Takes the RAW bytes of one Zarr v3 `sharding_indexed` inner chunk (a
 * single blosc2 frame) and returns the decoded `Int16Array`: every served
 * level-0 and view array in this catalog is int16 (typesize 2), so this
 * decoder refuses anything else rather than reinterpreting it.
 *
 * Byte-shuffle only (typesize-granularity byte transpose): every store this
 * codebase serves uses `shuffle: "shuffle"` in its `zarr.json`, never
 * `"bitshuffle"` (bit-granularity, typesize-independent), so a bit-shuffled
 * frame throws rather than being silently mis-decoded.
 */

import { decompress as fzstdDecompress } from "fzstd";

/** Blosc2 chunk header, byte-for-byte (16 bytes: version, versionlz, flags,
 *  typesize, then three little-endian uint32s -- nbytes, blocksize, cbytes). */
interface BloscHeader {
  version: number;
  versionlz: number;
  flags: number;
  typesize: number;
  nbytes: number;
  blocksize: number;
  cbytes: number;
  doShuffle: boolean;
  doBitShuffle: boolean;
  memcpyed: boolean;
}

function parseBloscHeader(bytes: Uint8Array): BloscHeader {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = view.getUint8(2);
  return {
    version: view.getUint8(0),
    versionlz: view.getUint8(1),
    flags,
    typesize: view.getUint8(3),
    nbytes: view.getUint32(4, true),
    blocksize: view.getUint32(8, true),
    cbytes: view.getUint32(12, true),
    doShuffle: (flags & 0x1) !== 0,
    doBitShuffle: (flags & 0x4) !== 0,
    memcpyed: (flags & 0x2) !== 0,
  };
}

/** Undo blosc's byte-level shuffle for one block: `shuffled[b*N + j]` is
 *  byte `b` of element `j`; reconstruct `unshuffled[j*T + b]`. */
function unshuffleBlock(shuffled: Uint8Array, typesize: number): Uint8Array {
  const n = shuffled.length / typesize;
  if (!Number.isInteger(n)) {
    throw new Error(
      `blosc-decode: block length ${shuffled.length} is not a multiple of typesize ${typesize}`,
    );
  }
  const out = new Uint8Array(shuffled.length);
  for (let b = 0; b < typesize; b++) {
    const rowStart = b * n;
    for (let j = 0; j < n; j++) {
      out[j * typesize + b] = shuffled[rowStart + j];
    }
  }
  return out;
}

/** `new Int16Array(buf, off, byteLength / 2)` silently floors an odd byte
 *  count and drops the last sample; refuse instead. */
function asInt16(bytes: Uint8Array): Int16Array {
  if (bytes.byteLength % 2 !== 0) {
    throw new Error(`blosc-decode: decoded ${bytes.byteLength} bytes, not a whole number of int16`);
  }
  return new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
}

/**
 * Decode one blosc2/zstd/byte-shuffle inner chunk (a served array's level-0
 * or view chunk) to an `Int16Array`. Pure JS, no WASM -- parses the blosc2
 * chunk header, iterates the per-block offset table, decompresses each
 * block's zstd payload with `fzstd`, and unshuffles. Throws on a header
 * shape this decoder does not handle (memcpyed frames, bit-shuffle, a
 * non-int16 typesize, or a truncated/corrupt buffer) rather than guessing.
 */
export function decodeBloscZstdInt16(bytes: Uint8Array): Int16Array {
  if (bytes.length < 16) {
    throw new Error(
      `blosc-decode: ${bytes.length} bytes is shorter than the 16-byte blosc2 header`,
    );
  }
  const header = parseBloscHeader(bytes);
  if (header.memcpyed) {
    throw new Error("blosc-decode: memcpyed (uncompressed) blosc frames are not implemented");
  }
  if (header.doBitShuffle) {
    throw new Error("blosc-decode: bit-shuffle is not implemented (only byte shuffle)");
  }
  // Every served level-0 and view array is int16 (typesize 2). A different
  // typesize is a store this decoder was not written for, never something to
  // reinterpret as int16 pairs.
  if (header.typesize !== 2) {
    throw new Error(
      `blosc-decode: typesize ${header.typesize} is not int16; refusing to reinterpret`,
    );
  }
  // blosc2 signals a single block with blocksize == nbytes, never 0; a zero
  // here is a corrupt header, and dividing by it would give Infinity blocks.
  if (header.blocksize <= 0 || header.nbytes <= 0) {
    throw new Error(
      `blosc-decode: invalid blosc2 header (nbytes ${header.nbytes}, blocksize ${header.blocksize})`,
    );
  }
  if (header.nbytes % header.typesize !== 0) {
    throw new Error(
      `blosc-decode: nbytes ${header.nbytes} is not a multiple of typesize ${header.typesize}`,
    );
  }
  if (header.cbytes !== bytes.length) {
    throw new Error(
      `blosc-decode: header cbytes ${header.cbytes} disagrees with the ${bytes.length} bytes supplied`,
    );
  }
  const nblocks = Math.ceil(header.nbytes / header.blocksize);
  if (16 + nblocks * 4 > bytes.length) {
    throw new Error(
      `blosc-decode: ${nblocks}-entry offset table does not fit in ${bytes.length} bytes`,
    );
  }
  const offsetsView = new DataView(bytes.buffer, bytes.byteOffset + 16, nblocks * 4);
  const offsets: number[] = [];
  for (let i = 0; i < nblocks; i++) offsets.push(offsetsView.getUint32(i * 4, true));

  const out = new Uint8Array(header.nbytes);
  let written = 0;
  for (let i = 0; i < nblocks; i++) {
    const blockStart = offsets[i];
    if (blockStart + 4 > bytes.length) {
      throw new Error(`blosc-decode: block ${i} offset ${blockStart} is past the end of the chunk`);
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset + blockStart, 4);
    const compressedLen = view.getUint32(0, true);
    const payloadStart = blockStart + 4;
    if (compressedLen === 0 || payloadStart + compressedLen > bytes.length) {
      throw new Error(
        `blosc-decode: block ${i} claims ${compressedLen} compressed bytes at ${payloadStart}, ` +
          `but the chunk is ${bytes.length} bytes`,
      );
    }
    const payload = bytes.subarray(payloadStart, payloadStart + compressedLen);
    const decompressed = fzstdDecompress(payload);
    const blockNbytes = Math.min(header.blocksize, header.nbytes - written);
    if (decompressed.length !== blockNbytes) {
      throw new Error(
        `blosc-decode: block ${i} decompressed to ${decompressed.length} bytes, expected ${blockNbytes}`,
      );
    }
    const unshuffled = header.doShuffle
      ? unshuffleBlock(decompressed, header.typesize)
      : decompressed;
    out.set(unshuffled, written);
    written += blockNbytes;
  }

  return asInt16(out);
}
