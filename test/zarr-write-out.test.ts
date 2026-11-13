/**
 * `writeFileAtomic` (src/commands/zarr.ts), the writer behind `nemar zarr read --out`, on real
 * files in a temporary directory: the temporary name is not predictable and is created
 * exclusively, so a symbolic link planted at the old predictable name is not followed.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../src/commands/zarr.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nemar-write-out-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("writeFileAtomic", () => {
  test("writes the bytes and leaves no temporary file", () => {
    const out = join(tmp, "w.bin");
    writeFileAtomic(out, new Uint8Array([1, 2, 3]));
    expect(new Uint8Array(readFileSync(out))).toEqual(new Uint8Array([1, 2, 3]));
    expect(readdirSync(tmp)).toEqual(["w.bin"]);
  });

  test("replaces an existing file", () => {
    const out = join(tmp, "w.bin");
    writeFileSync(out, "old old old");
    writeFileAtomic(out, new Uint8Array([9]));
    expect(new Uint8Array(readFileSync(out))).toEqual(new Uint8Array([9]));
  });

  test("a symbolic link planted at the old predictable temporary name is not followed", () => {
    const out = join(tmp, "w.bin");
    const victim = join(tmp, "victim.txt");
    writeFileSync(victim, "precious");
    symlinkSync(victim, `${out}.tmp-${process.pid}`);
    writeFileAtomic(out, new Uint8Array([7, 7]));
    expect(readFileSync(victim, "utf8")).toBe("precious");
    expect(new Uint8Array(readFileSync(out))).toEqual(new Uint8Array([7, 7]));
  });

  test("a failed write removes its temporary file", () => {
    const out = join(tmp, "is-a-directory");
    mkdirSync(out);
    expect(() => writeFileAtomic(out, new Uint8Array([1]))).toThrow();
    expect(readdirSync(tmp)).toEqual(["is-a-directory"]);
    expect(existsSync(out)).toBe(true);
  });

  test("two writes use two different temporary names", () => {
    // Plant a regular file at every name a counter-based or pid-based scheme could pick: none
    // may be overwritten.
    const out = join(tmp, "w.bin");
    const planted = [`${out}.tmp-${process.pid}`, `${out}.tmp-0`, `${out}.tmp-1`];
    for (const p of planted) writeFileSync(p, "planted");
    writeFileAtomic(out, new Uint8Array([5]));
    for (const p of planted) expect(readFileSync(p, "utf8")).toBe("planted");
  });
});
