/**
 * Manifest Tests
 *
 * Tests for: manifest parsing utilities, CLI manifest command.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "bun";
import { useTestGitIdentity } from "./helpers/git-identity";
import { sleep } from "./setup";

const TMP_DIR = join(import.meta.dir, ".test-manifest");

function createTestContext() {
  const uniqueId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const configDir = join(import.meta.dir, ".test-configs", uniqueId);
  mkdirSync(configDir, { recursive: true });
  const configFile = join(configDir, "config.json");
  return { configDir, configFile };
}

function setTestConfig(
  ctx: { configDir: string; configFile: string },
  config: Record<string, unknown>,
) {
  writeFileSync(ctx.configFile, JSON.stringify(config));
}

async function runCli(
  args: string[],
  options: { cwd?: string; configDir?: string; testApiUrl?: string } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = spawn({
    cmd: ["bun", "run", join(import.meta.dir, "..", "src", "index.ts"), ...args],
    cwd: options.cwd || join(import.meta.dir, ".."),
    env: {
      ...process.env,
      // Clear TEST_API_URL by default so the CLI uses the config's apiUrl.
      // Only set it when explicitly passed via testApiUrl option.
      TEST_API_URL: options.testApiUrl || "",
      ...(options.configDir ? { NEMAR_CONFIG_DIR: options.configDir } : {}),
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return { stdout, stderr, exitCode };
}

async function runCmd(
  cmd: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = spawn({
    cmd,
    cwd,
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return { stdout, stderr, exitCode };
}

let restoreGitIdentity: () => void;

// `git annex init` commits, so the repositories this file creates need an identity (CI runners have none).
beforeAll(() => {
  restoreGitIdentity = useTestGitIdentity();
});

beforeEach(async () => {
  await sleep(100);
});

afterAll(() => {
  try {
    if (existsSync(TMP_DIR)) {
      rmSync(TMP_DIR, { recursive: true, force: true });
    }
  } finally {
    restoreGitIdentity?.();
  }
});

// ============================================================================
// Unit tests for manifest parsing (imported from backend)
// ============================================================================

describe("manifest - annex pointer parsing", () => {
  // Import the parsing functions directly for unit testing
  const {
    parseAnnexPointer,
    extractSizeFromKey,
    extractChecksumFromKey,
    extractHashAlgorithm,
  } = require("../backend/src/services/manifest");

  test("parseAnnexPointer handles standard pointer format", () => {
    const content = "/annex/objects/SHA256E-s12345--abc123def456.edf\n";
    expect(parseAnnexPointer(content)).toBe("SHA256E-s12345--abc123def456.edf");
  });

  test("parseAnnexPointer handles pointer without trailing newline", () => {
    const content = "/annex/objects/MD5E-s9876--fedcba987654.bdf";
    expect(parseAnnexPointer(content)).toBe("MD5E-s9876--fedcba987654.bdf");
  });

  test("parseAnnexPointer handles symlink target format", () => {
    const content =
      ".git/annex/objects/Xk/ZW/SHA256E-s12345--abc123.edf/SHA256E-s12345--abc123.edf";
    expect(parseAnnexPointer(content)).toBe("SHA256E-s12345--abc123.edf");
  });

  test("parseAnnexPointer returns null for non-pointer content", () => {
    expect(parseAnnexPointer("regular file content")).toBeNull();
    expect(parseAnnexPointer("")).toBeNull();
    expect(parseAnnexPointer("{}")).toBeNull();
  });

  test("extractSizeFromKey extracts size correctly", () => {
    expect(extractSizeFromKey("SHA256E-s12345--abc123.edf")).toBe(12345);
    expect(extractSizeFromKey("MD5E-s0--empty.txt")).toBe(0);
    expect(extractSizeFromKey("SHA256E-s999999999--big.dat")).toBe(999999999);
  });

  test("extractSizeFromKey returns 0 for invalid keys", () => {
    expect(extractSizeFromKey("invalid-key")).toBe(0);
    expect(extractSizeFromKey("")).toBe(0);
  });

  test("extractChecksumFromKey extracts hash correctly", () => {
    expect(extractChecksumFromKey("SHA256E-s12345--abc123def456.edf")).toBe("abc123def456");
    expect(extractChecksumFromKey("MD5E-s100--fedcba.txt")).toBe("fedcba");
  });

  test("extractChecksumFromKey handles uppercase hex", () => {
    expect(extractChecksumFromKey("SHA256E-s100--ABCDEF012345.dat")).toBe("ABCDEF012345");
    expect(extractChecksumFromKey("SHA256E-s100--aAbBcC.dat")).toBe("aAbBcC");
  });

  test("extractChecksumFromKey returns empty for invalid keys", () => {
    expect(extractChecksumFromKey("invalid")).toBe("");
    expect(extractChecksumFromKey("")).toBe("");
  });

  test("extractHashAlgorithm extracts algorithm from key", () => {
    expect(extractHashAlgorithm("SHA256E-s12345--abc123.edf")).toBe("sha256");
    expect(extractHashAlgorithm("MD5E-s100--fedcba.txt")).toBe("md5");
    expect(extractHashAlgorithm("SHA512E-s999--hash.bin")).toBe("sha512");
  });

  test("extractHashAlgorithm handles non-extension backends", () => {
    expect(extractHashAlgorithm("SHA256-s100--abc123")).toBe("sha256");
  });

  test("extractHashAlgorithm defaults to sha256 for invalid keys", () => {
    expect(extractHashAlgorithm("invalid")).toBe("sha256");
    expect(extractHashAlgorithm("")).toBe("sha256");
  });
});

// ============================================================================
// Unit tests for the publisher canary helper (#503)
// ============================================================================

describe("manifest - selectGitBackedCanaries (#503)", () => {
  const { selectGitBackedCanaries } = require("../backend/src/services/manifest");

  function fixture(
    paths: string[],
  ): Record<string, { key: string; size: number; checksum: string }> {
    const files: Record<string, { key: string; size: number; checksum: string }> = {};
    for (const p of paths) {
      files[p] = { key: `git:${p}-sha`, size: 100, checksum: `git:${p}-sha` };
    }
    return files;
  }

  test("empty manifest returns no canaries (no-op short-circuit)", () => {
    expect(selectGitBackedCanaries({})).toEqual([]);
  });

  test("manifest with only annex keys returns no canaries", () => {
    expect(
      selectGitBackedCanaries({
        "sub-01/eeg/x.edf": {
          key: "SHA256E-s12345--abc.edf",
          size: 12345,
          checksum: "sha256:abc",
        },
      }),
    ).toEqual([]);
  });

  test("dataset_description.json is always included when present", () => {
    const out = selectGitBackedCanaries(
      fixture(["README", "CHANGES", "dataset_description.json", "participants.tsv"]),
    );
    expect(out).toContain("dataset_description.json");
  });

  test("sample is capped at 5 total (1 canonical + 4 additional)", () => {
    const paths = [
      "dataset_description.json",
      "README",
      "CHANGES",
      "participants.tsv",
      "sub-01_task-rest_events.tsv",
      "sub-02_task-rest_events.tsv",
      "sub-03_task-rest_events.tsv",
      "sub-04_task-rest_events.tsv",
    ];
    const out = selectGitBackedCanaries(fixture(paths));
    expect(out.length).toBeLessThanOrEqual(5);
    expect(out).toContain("dataset_description.json");
  });

  test("selection is deterministic across multiple calls", () => {
    const paths = [
      "dataset_description.json",
      "z-last.tsv",
      "a-first.tsv",
      "m-middle.tsv",
      "README",
      "CHANGES",
    ];
    const a = selectGitBackedCanaries(fixture(paths));
    const b = selectGitBackedCanaries(fixture(paths));
    expect(a).toEqual(b);
  });

  test("paths are sampled in sorted order so a tiny git: set is fully covered", () => {
    const out = selectGitBackedCanaries(fixture(["b.json", "a.json", "c.json"]));
    expect(out).toEqual(["a.json", "b.json", "c.json"]);
  });

  test("does not include annex-keyed entries even when there are few git: ones", () => {
    const files: Record<string, { key: string; size: number; checksum: string }> = {
      "dataset_description.json": {
        key: "git:abc",
        size: 100,
        checksum: "git:abc",
      },
      "sub-01/eeg/x.edf": {
        key: "SHA256E-s12345--abc.edf",
        size: 12345,
        checksum: "sha256:abc",
      },
      "sub-01/eeg/y.edf": {
        key: "SHA256E-s23456--def.edf",
        size: 23456,
        checksum: "sha256:def",
      },
    };
    expect(selectGitBackedCanaries(files)).toEqual(["dataset_description.json"]);
  });

  test("respects custom maxAdditional cap", () => {
    const paths = ["a.json", "b.json", "c.json", "d.json", "e.json"];
    expect(selectGitBackedCanaries(fixture(paths), 2)).toHaveLength(3);
    expect(selectGitBackedCanaries(fixture(paths), 0)).toHaveLength(1);
  });
});

// ============================================================================
// CLI tests - help output
// ============================================================================

describe("manifest - help output", () => {
  test("dataset --help lists manifest command", async () => {
    const { stdout, exitCode } = await runCli(["dataset", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("manifest");
  });

  test("dataset manifest --help shows usage", async () => {
    const { stdout, exitCode } = await runCli(["dataset", "manifest", "--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("version manifests");
    expect(stdout).toContain("--json");
    expect(stdout).toContain("--dataset");
  });
});

// ============================================================================
// CLI tests - auth and detection
// ============================================================================

describe("manifest - auth and detection", () => {
  test("dataset manifest requires auth", async () => {
    const ctx = createTestContext();
    const { stdout, exitCode } = await runCli(["dataset", "manifest"], {
      configDir: ctx.configDir,
    });
    expect(exitCode).toBe(1);
    expect(stdout).toContain("Not authenticated");
  });

  test("dataset manifest without dataset-id fails outside dataset dir", async () => {
    const ctx = createTestContext();
    setTestConfig(ctx, {
      apiKey: "fake-key",
      apiUrl: "https://example.com",
      username: "test",
    });

    const tmpDir = join(TMP_DIR, "non-dataset-dir");
    mkdirSync(tmpDir, { recursive: true });

    const { stdout, exitCode } = await runCli(["dataset", "manifest"], {
      cwd: tmpDir,
      configDir: ctx.configDir,
    });
    expect(exitCode).toBe(1);
    expect(stdout).toContain("Could not detect dataset ID");
  });

  test("dataset manifest with -d flag attempts API call", async () => {
    const ctx = createTestContext();
    setTestConfig(ctx, {
      apiKey: "fake-key",
      apiUrl: "http://127.0.0.1:1",
      username: "test",
    });

    const { exitCode } = await runCli(["dataset", "manifest", "-d", "nm000104"], {
      configDir: ctx.configDir,
      testApiUrl: "http://127.0.0.1:1",
    });
    // Will fail at API call (connection refused) but should not fail at detection.
    // Uses TEST_API_URL env var because bun test shares module cache with spawned
    // subprocesses, making NEMAR_CONFIG_DIR unreliable for isolating the Conf instance.
    expect(exitCode).toBe(1);
  });

  test("dataset manifest auto-detects from git remote", async () => {
    const ctx = createTestContext();
    setTestConfig(ctx, {
      apiKey: "fake-key",
      apiUrl: "https://example.com",
      username: "test",
    });

    const repoDir = join(TMP_DIR, `repo-${Date.now()}`);
    mkdirSync(repoDir, { recursive: true });
    await runCmd(["git", "init"], repoDir);
    await runCmd(["git", "annex", "init", "test"], repoDir);
    await runCmd(
      ["git", "remote", "add", "origin", "https://github.com/nemarDatasets/nm099999.git"],
      repoDir,
    );

    const { stdout, exitCode } = await runCli(["dataset", "manifest"], {
      cwd: repoDir,
      configDir: ctx.configDir,
    });
    // Should detect nm099999 and attempt API (which fails)
    expect(exitCode).toBe(1);
    expect(stdout).not.toContain("Could not detect dataset ID");
  });
});
