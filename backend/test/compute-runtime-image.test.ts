/**
 * `COMPUTE_RUNTIME_IMAGE`, read (epic #2005 phase A5, #2010; ADR 0118, round 1 review): ONE digest-pinned
 * reference, from which the digest and the Singularity file name are derived. Pure, so the tests are
 * plain; the route that reports it and the builder that launches it have their own suites.
 */

import { describe, expect, test } from "bun:test";
import { imageFacts, readRuntimeImage } from "../src/services/compute-runtime-image";

const HEX = "0123456789abcdef".repeat(4);

describe("readRuntimeImage", () => {
  test("unset, empty and blank are `unset`", () => {
    for (const value of [undefined, "", "   ", "\n"]) {
      expect(readRuntimeImage({ COMPUTE_RUNTIME_IMAGE: value })).toEqual({ state: "unset" });
    }
  });

  test("a digest-pinned reference is `ok`, with its digest and file name derived (and written out here)", () => {
    expect(
      readRuntimeImage({ COMPUTE_RUNTIME_IMAGE: `ghcr.io/nemarorg/nemar-python@sha256:${HEX}` }),
    ).toEqual({
      state: "ok",
      ref: `ghcr.io/nemarorg/nemar-python@sha256:${HEX}`,
      digest: `sha256:${HEX}`,
      sif: `${HEX}.sif`,
    });
    // `docker://` is part of the reference; padding is not.
    expect(
      readRuntimeImage({
        COMPUTE_RUNTIME_IMAGE: ` docker://registry.test:5000/a/b@sha256:${HEX}\n`,
      }),
    ).toMatchObject({ state: "ok", ref: `docker://registry.test:5000/a/b@sha256:${HEX}` });
  });

  test("anything else is `invalid`: a tag, a short or upper-case digest, text around it, JSON", () => {
    for (const value of [
      "ghcr.io/nemarorg/nemar-python:latest",
      "ghcr.io/nemarorg/nemar-python",
      `ghcr.io/nemarorg/nemar-python@sha256:${HEX.slice(1)}`,
      `ghcr.io/nemarorg/nemar-python@sha256:${HEX.toUpperCase()}`,
      `ghcr.io/nemarorg/nemar-python@sha256:${HEX}\nand more`,
      `ghcr.io/nemarorg/nemar-python@sha256:${HEX}.sif`,
      `{"uri":"ghcr.io/nemarorg/nemar-python@sha256:${HEX}"}`,
      `@sha256:${HEX}`,
    ]) {
      expect([value, readRuntimeImage({ COMPUTE_RUNTIME_IMAGE: value })]).toEqual([
        value,
        { state: "invalid" },
      ]);
    }
  });
});

describe("imageFacts", () => {
  test("is null for what is not a pinned reference and the facts for what is", () => {
    expect(imageFacts("a/b:tag")).toBeNull();
    expect(imageFacts(`a/b@sha256:${HEX}`)).toEqual({
      ref: `a/b@sha256:${HEX}`,
      digest: `sha256:${HEX}`,
      sif: `${HEX}.sif`,
    });
  });
});
