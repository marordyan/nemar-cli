/**
 * The two encoders the OpenID Connect services share (epic #2014 phase #2016): random lowercase
 * hexadecimal for key and client ids, and unpadded base64url for tokens, secrets and the parts of a
 * JSON Web Token. One module serves the key service and the client registry, so a client id and a key
 * id are made the same way and a secret and a signature are encoded the same way.
 */

import { describe, expect, test } from "bun:test";
import { randomHex, toBase64Url } from "../src/services/oidc-encoding";

describe("randomHex", () => {
  test("is twice as many lowercase hex characters as bytes, and never repeats", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const h = randomHex(12);
      expect(h).toMatch(/^[0-9a-f]{24}$/);
      seen.add(h);
    }
    expect(seen.size).toBe(200);
    expect(randomHex(8)).toMatch(/^[0-9a-f]{16}$/);
    expect(randomHex(0)).toBe("");
  });
});

describe("toBase64Url", () => {
  test("is the url-safe alphabet with no padding", () => {
    // 0xfb 0xff 0xfe is "+//+" in plain base64, "-__-" in the url-safe alphabet.
    expect(toBase64Url(new Uint8Array([0xfb, 0xff, 0xfe]))).toBe("-__-");
    expect(toBase64Url(new Uint8Array([1]))).toBe("AQ");
    expect(toBase64Url(new Uint8Array([1, 2]))).toBe("AQI");
    expect(toBase64Url(new Uint8Array([]))).toBe("");
  });

  test("32 bytes are 43 characters", () => {
    expect(toBase64Url(crypto.getRandomValues(new Uint8Array(32)))).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
