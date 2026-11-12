/**
 * `rangeCeiling` (src/lib/zarr-engine/window.ts): the most bytes one `Range` read of a window
 * may ask for. The hostile side (a footer claiming more is refused) is proven in
 * zarr-engine-runtime.test.ts; these tests pin the LEGITIMATE side, which the runtime fixtures
 * cannot (they compress well, so a ceiling that is too tight would still pass there).
 */

import { describe, expect, test } from "bun:test";
import { rangeCeiling } from "../src/lib/zarr-engine/window.js";

/** The worst case for one stored chunk: the raw bytes plus at most 32 bytes of blosc2 overhead
 *  (BLOSC2_MAX_OVERHEAD), in a chunk that is still stored compressed (the decoder refuses a
 *  memcpyed frame). Independent of the engine's own constant. */
const BLOSC2_MAX_OVERHEAD = 32;

describe("rangeCeiling", () => {
  test("exact value: two chunks of every channel plus 64 bytes each", () => {
    // 2 channels, 100-sample chunks, a 100-sample window: ceil(100/100) + 1 = 2 chunks of
    // 2 * 100 * 2 = 400 bytes, each + 64.
    expect(rangeCeiling({ nChannels: 2, chunkSamples: 100, nInner: 10, nSamples: 100 })).toBe(
      2 * (400 + 64),
    );
  });

  test("exact value: a store with tiny chunks is floored at its footer length", () => {
    // 2 * (2 * 10 * 2 + 64) = 208 bytes of chunks, but the footer read is 200 * 16 + 4 bytes.
    expect(rangeCeiling({ nChannels: 2, chunkSamples: 10, nInner: 200, nSamples: 10 })).toBe(3204);
  });

  test("every window, at every alignment, fits incompressible chunks and its footer", () => {
    for (const nChannels of [1, 3, 129]) {
      for (const chunkSamples of [1, 7, 10, 100, 1000]) {
        for (const nInner of [1, 4, 200]) {
          const shardSamples = chunkSamples * nInner;
          for (let nSamples = 1; nSamples <= 3 * chunkSamples + 1; nSamples++) {
            const ceiling = rangeCeiling({ nChannels, chunkSamples, nInner, nSamples });
            const footer = nInner * 16 + 4;
            const where = JSON.stringify({ nChannels, chunkSamples, nInner, nSamples });
            expect(ceiling, `footer ${where}`).toBeGreaterThanOrEqual(footer);
            for (let start = 0; start < chunkSamples; start++) {
              const first = Math.floor(start / chunkSamples);
              const last = Math.floor((start + nSamples - 1) / chunkSamples);
              // One coalesced read never crosses a shard: count the most chunks of one shard.
              let most = 0;
              for (let c = first; c <= last; ) {
                const shardEnd = (Math.floor(c / nInner) + 1) * nInner - 1;
                const upTo = Math.min(last, shardEnd);
                most = Math.max(most, upTo - c + 1);
                c = upTo + 1;
              }
              const worst = most * (nChannels * chunkSamples * 2 + BLOSC2_MAX_OVERHEAD);
              expect(
                ceiling,
                `start ${start} ${where} (shard ${shardSamples})`,
              ).toBeGreaterThanOrEqual(worst);
            }
          }
        }
      }
    }
  });
});
