/**
 * Pieces of `nemar zarr read` (src/commands/zarr.ts) that the end-to-end tests cannot reach:
 * the summary decodes only its preview, and a failure that is neither an engine answer nor a write
 * error is reported as an unexpected error (in a subprocess, because it sets the exit status).
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { previewRows } from "../src/commands/zarr.js";
import type { WindowReply } from "../src/lib/zarr-engine/client.js";

const ZARR_COMMAND = join(import.meta.dir, "..", "src", "commands", "zarr.ts");

function windowOf(channels: number[], n: number, dtype: "int16" | "float64", bytes: number) {
  const payload = new Uint8Array(bytes);
  const view = new DataView(payload.buffer);
  const size = dtype === "int16" ? 2 : 8;
  // Value (i, j) is i * 1000 + j.
  for (let i = 0; i < channels.length; i++) {
    for (let j = 0; j < n; j++) {
      const at = (i * n + j) * size;
      if (at + size > bytes) continue;
      if (dtype === "int16") view.setInt16(at, i * 1000 + j, true);
      else view.setFloat64(at, i * 1000 + j, true);
    }
  }
  return {
    header: {
      start_sample: 0,
      n_samples: n,
      channels,
      dtype,
      filled_ranges: [],
      payload_bytes: channels.length * n * size,
    },
    payload,
  } as WindowReply;
}

describe("previewRows", () => {
  test("gives the first 6 values of the first 4 channels", () => {
    const w = windowOf([0, 1, 2, 3, 4, 5], 100, "int16", 6 * 100 * 2);
    const rows = previewRows(w);
    expect(rows.length).toBe(4);
    expect(rows[3]).toEqual([3000, 3001, 3002, 3003, 3004, 3005]);
  });

  test("a short window gives fewer values, and float64 reads little-endian", () => {
    const w = windowOf([7, 9], 3, "float64", 2 * 3 * 8);
    expect(previewRows(w)).toEqual([
      [0, 1, 2],
      [1000, 1001, 1002],
    ]);
  });

  test("decodes only the preview: a payload cut right after it is not read past", () => {
    // 4 channels x 1,000,000 samples of float64 would be 32 MB; the payload here ends at the last
    // preview value, so decoding anything further would throw a RangeError.
    const n = 1_000_000;
    const lastPreviewEnd = (3 * n + 6) * 8;
    const w = windowOf([0, 1, 2, 3], n, "float64", lastPreviewEnd);
    const rows = previewRows(w);
    expect(rows[3]).toEqual([3000, 3001, 3002, 3003, 3004, 3005]);
  });
});

describe("failUnexpected", () => {
  async function run(json: boolean) {
    const script = `import { failUnexpected } from ${JSON.stringify(ZARR_COMMAND)};
      failUnexpected(new Error("boom"), ${json});
      process.exit(process.exitCode ?? 0);`;
    const proc = Bun.spawn({
      cmd: [process.execPath, "-e", script],
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { stdout, stderr, exitCode: await proc.exited };
  }

  test("says it is unexpected, never claims a failed write, and points at --debug", async () => {
    const r = await run(false);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("Unexpected error: boom");
    expect(r.stdout).toContain("--debug");
    expect(r.stdout).not.toContain("Could not write");
    expect(r.stdout).not.toContain("null");
  });

  test("under --json it goes to stderr", async () => {
    const r = await run(true);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("Unexpected error: boom");
  });
});

describe("a configuration file that cannot be read", () => {
  // The CLI entry already fails on such a file before any command runs, so the command's own
  // preflight is exercised by calling the action in a process whose config directory holds one.
  test("zarr read reports an unexpected error, not a crash and not a setting to fix", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nemar-bad-config-"));
    try {
      writeFileSync(join(dir, "config.json"), "{garbage");
      const script = `import { zarrReadAction } from ${JSON.stringify(ZARR_COMMAND)};
        await zarrReadAction("nm099500", "a.edf", { start: "0", duration: "1" });
        process.exit(process.exitCode ?? 0);`;
      const env = { ...process.env, NEMAR_CONFIG_DIR: dir, TEST_API_URL: "" };
      const proc = Bun.spawn({
        cmd: [process.execPath, "-e", script],
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      expect(await proc.exited).toBe(1);
      expect(stdout).toContain("Unexpected error");
      expect(stdout).not.toContain("Fix or unset");
      expect(stderr).not.toContain("at ");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
