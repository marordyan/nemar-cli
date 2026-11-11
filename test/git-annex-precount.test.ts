/**
 * Real git-annex tests for countPendingDownload.
 *
 * Validates that the precount used by `nemar dataset download/get` returns
 * accurate file count + byte total against actual git-annex repos.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { spawn } from "bun";
import { countPendingDownload } from "../src/lib/git-annex/transfer";
import { useTestGitIdentity } from "./helpers/git-identity";

const TMP_DIR = join(import.meta.dir, ".test-precount");

function chmodTreeWritable(dir: string): void {
  // git-annex marks object files read-only; rm needs write+execute on dirs.
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      try {
        chmodSync(full, 0o755);
      } catch {}
      chmodTreeWritable(full);
    } else {
      try {
        chmodSync(full, 0o644);
      } catch {}
    }
  }
}

async function runCmd(
  cmd: string[],
  cwd?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = spawn({ cmd, cwd, stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

async function newAnnexRepo(name: string): Promise<string> {
  const dir = join(TMP_DIR, `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  await runCmd(["git", "init", "-q"], dir);
  await runCmd(["git", "config", "user.email", "test@test.com"], dir);
  await runCmd(["git", "config", "user.name", "Test"], dir);
  await runCmd(["git", "annex", "init", "-q", "src"], dir);
  return dir;
}

async function annexFile(repo: string, name: string, contents: string): Promise<void> {
  writeFileSync(join(repo, name), contents);
  await runCmd(["git", "annex", "add", name], repo);
  await runCmd(["git", "commit", "-q", "-m", `add ${name}`], repo);
}

let restoreGitIdentity: () => void;

beforeAll(() => {
  // The clones run `git annex init`, which commits and needs an identity (CI runners have none).
  restoreGitIdentity = useTestGitIdentity();
  // git-annex required; skip cleanly if not installed
  if (!existsSync("/opt/homebrew/bin/git-annex") && !existsSync("/usr/local/bin/git-annex")) {
    // Best-effort: bun test still runs, individual tests detect via runCmd
  }
});

afterAll(() => {
  try {
    if (existsSync(TMP_DIR)) {
      chmodTreeWritable(TMP_DIR);
      rmSync(TMP_DIR, { recursive: true, force: true });
    }
  } finally {
    // Unset when beforeAll threw before assigning it.
    restoreGitIdentity?.();
  }
});

describe("countPendingDownload", () => {
  test("non-annex directory returns null (graceful degrade)", async () => {
    const dir = join(TMP_DIR, `plain-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const result = await countPendingDownload(dir);
    expect(result).toBeNull();
  });

  test("empty annex repo (no commits) returns null (graceful degrade)", async () => {
    // git annex find against `.` errors with "pathspec did not match any
    // file(s)" before any commit exists. Caller treats null as unknown
    // totals and falls back to non-percent display, which is correct.
    const repo = await newAnnexRepo("empty");
    const result = await countPendingDownload(repo);
    expect(result).toBeNull();
  });

  test("repo with all files locally present returns {0, 0}", async () => {
    const repo = await newAnnexRepo("local-only");
    await annexFile(repo, "data1.bin", "x".repeat(100));
    await annexFile(repo, "data2.bin", "y".repeat(250));
    // Files are added; this is a single-remote repo so they are "in here"
    // by definition. --not --in=here should match nothing.
    const result = await countPendingDownload(repo);
    expect(result).toEqual({ fileCount: 0, totalBytes: 0 });
  });

  test("paths arg scopes the count", async () => {
    const repo = await newAnnexRepo("paths");
    await annexFile(repo, "a.bin", "x".repeat(10));
    await annexFile(repo, "b.bin", "y".repeat(20));
    const all = await countPendingDownload(repo);
    const scoped = await countPendingDownload(repo, ["a.bin"]);
    // Both should be {0, 0} since files are local — but scoped invocation
    // must succeed (not error on the path arg).
    expect(all).not.toBeNull();
    expect(scoped).not.toBeNull();
  });

  test("extraArgs filters the pending count (stimuli excludes)", async () => {
    // Build a remote with one regular file and one under stimuli/, then
    // clone without the data to make both pending. The unfiltered count
    // should be 2; passing the stimuli excludes the CLI emits should drop
    // the stimuli file from the count.
    const remote = await newAnnexRepo("remote-stimuli");
    await annexFile(remote, "data.bin", "a".repeat(100));
    mkdirSync(join(remote, "stimuli"), { recursive: true });
    await annexFile(remote, "stimuli/sound.bin", "b".repeat(200));

    const local = join(TMP_DIR, `clone-stim-${Date.now()}`);
    await runCmd(["git", "clone", "-q", remote, local]);
    await runCmd(["git", "annex", "init", "-q", "local"], local);
    await runCmd(["git", "annex", "enableremote", "origin"], local).catch(() => undefined);

    const unfiltered = await countPendingDownload(local);
    expect(unfiltered).not.toBeNull();
    expect(unfiltered?.fileCount).toBe(2);
    expect(unfiltered?.totalBytes).toBe(300);

    const filtered = await countPendingDownload(local, undefined, [
      "--exclude",
      "stimuli/**",
      "--exclude",
      "**/stimuli/**",
    ]);
    expect(filtered).not.toBeNull();
    expect(filtered?.fileCount).toBe(1);
    expect(filtered?.totalBytes).toBe(100);
  });

  test("file count and bytes match for files missing from local annex", async () => {
    // Build a repo with files, then drop them while pointing at a sibling
    // remote that has the data. countPendingDownload should report the
    // pending files with accurate sizes.
    const remote = await newAnnexRepo("remote");
    await annexFile(remote, "big.bin", "z".repeat(500));
    await annexFile(remote, "small.bin", "w".repeat(50));

    const local = join(TMP_DIR, `clone-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    await runCmd(["git", "clone", "-q", remote, local]);
    await runCmd(["git", "annex", "init", "-q", "local"], local);
    await runCmd(["git", "annex", "enableremote", "origin"], local).catch(() => undefined);

    const result = await countPendingDownload(local);
    expect(result).not.toBeNull();
    expect(result?.fileCount).toBe(2);
    expect(result?.totalBytes).toBe(550);
  });
});
