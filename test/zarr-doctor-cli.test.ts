/**
 * The "Zarr engine" section of `nemar doctor`, as a real subprocess that starts the real engine.
 * Isolated config directory and disk cache, NEMAR_NO_UPDATE_CHECK=1, NO_COLOR=1, and the API URL
 * is a local stand-in, so nothing reaches a real host. `doctor` always exits 0.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctorSummary } from "../src/commands/doctor.js";
import { type Standin, runNemar, startStandin } from "./helpers/zarr-engine-standin.js";

// `doctor` itself probes five external tools; give it the budget other doctor tests use.
setDefaultTimeout(90_000);

let standin: Standin;
let tmp: string;
beforeAll(() => {
  standin = startStandin();
});
afterAll(() => standin.stop());
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nemar-zarr-doctor-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const cacheDir = () => join(tmp, "cache");
const doctor = (extra: Record<string, string> = {}) =>
  runNemar(["doctor"], {
    ...standin.env({ config: join(tmp, "config"), cache: cacheDir() }),
    ...extra,
  });

/** The "Zarr engine" section's lines, trimmed. */
function section(stdout: string): string[] {
  const at = stdout.indexOf("Zarr engine");
  expect(at, stdout).toBeGreaterThan(-1);
  return stdout
    .slice(at)
    .split("\n")
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("✓") || l.startsWith("✗"));
}

describe("nemar doctor: Zarr engine", () => {
  test("a working engine and a writable cache directory are two checkmarks", async () => {
    const r = await doctor();
    expect(r.exitCode).toBe(0);
    const lines = section(r.stdout);
    expect(lines.length).toBe(2);
    expect(lines[0]).toMatch(/^✓ engine starts\s+nemar-zarr-engine\/\S+ answered in \d+\.\d s$/);
    expect(lines[1]).toMatch(new RegExp(`^✓ cache directory\\s+${cacheDir()} is writable$`));
    expect(r.stdout).not.toMatch(/needs attention/);
    // The directory exists and is private.
    expect(statSync(cacheDir()).mode & 0o777).toBe(0o700);
  });

  test("an engine that cannot start is a cross with the engine's own message, and the exit code is still 0", async () => {
    const r = await doctor({ NEMAR_ZARR_BASE: "http://example.com" });
    expect(r.exitCode).toBe(0);
    const [engine, cache] = section(r.stdout);
    expect(engine).toMatch(/^✗ engine starts/);
    expect(engine).toContain("NEMAR_ZARR_BASE");
    expect(cache).toMatch(/^✓ cache directory/);
    // The closing summary does not call this all well.
    expect(r.stdout).toContain("Zarr engine");
    expect(r.stdout).toMatch(/needs attention/);
  });

  test("a cache directory that cannot be created is a cross naming it, and the exit code is still 0", async () => {
    const file = join(tmp, "a-file");
    writeFileSync(file, "x");
    const blocked = join(file, "cache");
    const r = await doctor({ NEMAR_ZARR_DISK_CACHE_DIR: blocked });
    expect(r.exitCode).toBe(0);
    const [engine, cache] = section(r.stdout);
    expect(engine).toMatch(/^✓ engine starts/);
    expect(cache).toMatch(/^✗ cache directory/);
    expect(cache).toContain(blocked);
    expect(existsSync(blocked)).toBe(false);
  });

  test("a limit of 0 says the disk cache is off and checks nothing on disk", async () => {
    const r = await doctor({ NEMAR_ZARR_DISK_CACHE_BYTES: "0" });
    expect(r.exitCode).toBe(0);
    const [, cache] = section(r.stdout);
    expect(cache).toMatch(/^✓ cache directory\s+disk cache is off/);
    expect(existsSync(cacheDir())).toBe(false);
  });

  test("a malformed cache limit is a cross, not a crash", async () => {
    const r = await doctor({ NEMAR_ZARR_DISK_CACHE_BYTES: "lots" });
    expect(r.exitCode).toBe(0);
    const lines = section(r.stdout);
    expect(lines.at(-1)).toMatch(/^✗ cache directory.*NEMAR_ZARR_DISK_CACHE_BYTES/);
  });

  test("the tool checks are still there", async () => {
    const r = await doctor();
    expect(r.stdout).toContain("NEMAR environment check");
    expect(r.stdout).toMatch(/✓|✗/);
    expect(r.stdout.indexOf("NEMAR environment check")).toBeLessThan(
      r.stdout.indexOf("Zarr engine"),
    );
  });
});

describe("doctorSummary", () => {
  const ok = { available: true, required: true };
  const missing = { available: false, required: true };
  const strip = (lines: string[]) =>
    lines.join("\n").replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");

  test("all tools and a working engine is the plain all-clear", () => {
    expect(strip(doctorSummary([ok, ok], [{ ok: true }, { ok: true }]))).toContain(
      "All 2 required tools are installed.",
    );
  });

  test("a failed engine is never summarised as all well", () => {
    const text = strip(doctorSummary([ok, ok], [{ ok: true }, { ok: false }]));
    expect(text).not.toContain("installed.\n");
    expect(text).toContain("but the Zarr engine needs attention");
  });

  test("missing tools keep their own summary, and a failed engine is added to it", () => {
    const text = strip(doctorSummary([ok, missing], [{ ok: false }]));
    expect(text).toContain("1/2 tools installed");
    expect(text).toContain("The Zarr engine also needs attention");
    expect(strip(doctorSummary([ok, missing], [{ ok: true }]))).not.toContain("Zarr engine");
  });
});
