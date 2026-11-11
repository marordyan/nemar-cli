/**
 * `scripts/ci/sync-dev-merge.sh` merges main back into dev after a release, and resolves the one
 * conflict a hotfix always causes.
 *
 * A hotfix released from main carries the released version in `package.json` and
 * `backend/package.json`, while dev carries a -devN one, so the merge back conflicted on those two
 * files every time (0.10.28 to 0.10.30 sessions) and a person resolved it by hand. These tests run
 * the real script against real git repositories: a version-only conflict is resolved to main's
 * side, and any conflict touching another file is aborted and left alone.
 *
 * CI TIER: process. It spawns git and a shell script against temporary repositories, and a file
 * that spawns processes does not belong in a `unit-pure` shard. It holds none of the markers that
 * route a file to the integration tier.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = new URL("../scripts/ci/sync-dev-merge.sh", import.meta.url).pathname;

const IDENTITY = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];

let root: string;
let clone: string;

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...IDENTITY, ...args], { cwd });
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
  }
  return r.stdout.toString().trim();
}

function write(rel: string, text: string): void {
  const p = join(clone, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
}

function read(rel: string): string {
  return readFileSync(join(clone, rel), "utf8");
}

function pkg(version: string): string {
  return `${JSON.stringify({ name: "x", version }, null, 2)}\n`;
}

/**
 * A package.json with enough lines between the version and the dependencies that a change to each
 * falls in its own hunk, as the real file's does.
 */
function pkgFull(version: string, deps: Record<string, string>): string {
  return `${JSON.stringify(
    {
      name: "x",
      version,
      description: "fixture",
      type: "module",
      main: "dist/index.js",
      scripts: { a: "a", b: "b", c: "c", d: "d" },
      dependencies: deps,
    },
    null,
    2,
  )}\n`;
}

function commitAll(message: string): void {
  git(clone, "add", "-A");
  git(clone, "commit", "-m", message);
}

/** Run the script from the repository root with the clone as cwd. */
function runScript(message = "chore: sync dev with main after v0.10.30") {
  const r = Bun.spawnSync(["bash", SCRIPT, message], {
    cwd: clone,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function mergeInProgress(): boolean {
  return (
    Bun.spawnSync(["git", "rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd: clone }).exitCode ===
    0
  );
}

/**
 * Build origin plus a clone on dev with origin/main fetched. Both branches start from a common
 * commit holding the version files and a changelog; the caller then adds one commit to each.
 */
function setup(): void {
  root = mkdtempSync(join(tmpdir(), "sync-dev-merge-"));
  const origin = join(root, "origin.git");
  clone = join(root, "clone");
  git(root, "init", "--bare", "-b", "main", origin);
  git(root, "clone", origin, clone);
  git(clone, "checkout", "-b", "main");
  write("package.json", pkg("0.10.28"));
  write("backend/package.json", pkg("0.10.28"));
  write("CHANGELOG.md", "# Changelog\n\nbase\n");
  write("other.txt", "base\n");
  commitAll("base");
  git(clone, "push", "origin", "main");
  git(clone, "checkout", "-b", "dev");
  git(clone, "push", "origin", "dev");
}

/** Commit on main in the clone, push it, and return to dev with origin/main fetched. */
function advanceMain(edit: () => void, message: string): void {
  git(clone, "checkout", "main");
  edit();
  commitAll(message);
  git(clone, "push", "origin", "main");
  git(clone, "checkout", "dev");
  git(clone, "fetch", "origin", "main");
}

function advanceDev(edit: () => void, message: string): void {
  edit();
  commitAll(message);
}

beforeEach(setup);

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("sync-dev-merge.sh", () => {
  test("a clean merge exits 0 and makes a merge commit", () => {
    advanceMain(() => write("other.txt", "main\n"), "main change");
    advanceDev(() => write("CHANGELOG.md", "# Changelog\n\ndev\n"), "dev change");

    const r = runScript();

    expect(r.code).toBe(0);
    expect(git(clone, "rev-list", "--parents", "-n", "1", "HEAD").split(" ")).toHaveLength(3);
    expect(git(clone, "log", "-1", "--format=%s")).toBe("chore: sync dev with main after v0.10.30");
    expect(read("other.txt")).toBe("main\n");
    expect(mergeInProgress()).toBe(false);
  });

  test("a conflict only in the two version files is resolved to main's side", () => {
    advanceMain(() => {
      write("package.json", pkg("0.10.30"));
      write("backend/package.json", pkg("0.10.30"));
    }, "hotfix 0.10.30");
    advanceDev(() => {
      write("package.json", pkg("0.10.28-dev14"));
      write("backend/package.json", pkg("0.10.28-dev14"));
    }, "dev bump");

    const r = runScript();

    expect(r.code).toBe(0);
    expect(r.out).toContain("package.json");
    expect(r.out).toContain("backend/package.json");
    expect(JSON.parse(read("package.json")).version).toBe("0.10.30");
    expect(JSON.parse(read("backend/package.json")).version).toBe("0.10.30");
    expect(mergeInProgress()).toBe(false);
    expect(git(clone, "status", "--porcelain")).toBe("");
    const parents = git(clone, "rev-list", "--parents", "-n", "1", "HEAD").split(" ");
    expect(parents).toHaveLength(3);
    expect(parents[2]).toBe(git(clone, "rev-parse", "origin/main"));
    expect(git(clone, "log", "-1", "--format=%s")).toContain("chore: sync dev with main after");
  });

  test("a version conflict plus a conflict in another file is aborted and left alone", () => {
    advanceMain(() => {
      write("package.json", pkg("0.10.30"));
      write("CHANGELOG.md", "# Changelog\n\nmain\n");
    }, "hotfix 0.10.30");
    advanceDev(() => {
      write("package.json", pkg("0.10.28-dev14"));
      write("CHANGELOG.md", "# Changelog\n\ndev\n");
    }, "dev change");
    const before = git(clone, "rev-parse", "HEAD");

    const r = runScript();

    expect(r.code).toBe(1);
    expect(r.err).toContain("CHANGELOG.md");
    expect(r.err).toContain("package.json");
    expect(mergeInProgress()).toBe(false);
    expect(git(clone, "status", "--porcelain")).toBe("");
    expect(git(clone, "rev-parse", "HEAD")).toBe(before);
    expect(JSON.parse(read("package.json")).version).toBe("0.10.28-dev14");
  });

  test("a conflict only in some other file is aborted and left alone", () => {
    advanceMain(() => write("CHANGELOG.md", "# Changelog\n\nmain\n"), "main change");
    advanceDev(() => write("CHANGELOG.md", "# Changelog\n\ndev\n"), "dev change");
    const before = git(clone, "rev-parse", "HEAD");

    const r = runScript();

    expect(r.code).toBe(1);
    expect(r.err).toContain("CHANGELOG.md");
    expect(mergeInProgress()).toBe(false);
    expect(git(clone, "status", "--porcelain")).toBe("");
    expect(git(clone, "rev-parse", "HEAD")).toBe(before);
  });

  test("a dependency dev added elsewhere in package.json survives the version resolution", () => {
    // Base: both sides carry 0.10.28 and one dependency. Main (the hotfix) bumps only the version;
    // dev bumps its own version AND adds a dependency in another hunk.
    git(clone, "checkout", "dev");
    write("package.json", pkgFull("0.10.28", { left: "1.0.0" }));
    commitAll("base package");
    git(clone, "push", "origin", "dev");
    git(clone, "checkout", "main");
    git(clone, "merge", "dev");
    git(clone, "push", "origin", "main");
    git(clone, "checkout", "dev");
    advanceMain(
      () => write("package.json", pkgFull("0.10.30", { left: "1.0.0" })),
      "hotfix 0.10.30",
    );
    advanceDev(
      () => write("package.json", pkgFull("0.10.28-dev14", { left: "1.0.0", jose: "6.2.12" })),
      "dev bump and dependency",
    );

    const r = runScript();

    expect(r.code).toBe(0);
    const merged = JSON.parse(read("package.json"));
    expect(merged.version).toBe("0.10.30");
    expect(merged.dependencies).toEqual({ left: "1.0.0", jose: "6.2.12" });
    expect(mergeInProgress()).toBe(false);
    expect(git(clone, "status", "--porcelain")).toBe("");
  });

  test("a version conflict plus a conflict on the same dependency line is aborted and left alone", () => {
    git(clone, "checkout", "dev");
    write("package.json", pkgFull("0.10.28", { left: "1.0.0" }));
    commitAll("base package");
    git(clone, "push", "origin", "dev");
    git(clone, "checkout", "main");
    git(clone, "merge", "dev");
    git(clone, "push", "origin", "main");
    git(clone, "checkout", "dev");
    advanceMain(
      () => write("package.json", pkgFull("0.10.30", { left: "2.0.0" })),
      "hotfix 0.10.30",
    );
    advanceDev(
      () => write("package.json", pkgFull("0.10.28-dev14", { left: "1.5.0" })),
      "dev bump and dependency",
    );
    const before = git(clone, "rev-parse", "HEAD");

    const r = runScript();

    expect(r.code).toBe(1);
    expect(r.err).toContain("package.json");
    expect(mergeInProgress()).toBe(false);
    expect(git(clone, "status", "--porcelain")).toBe("");
    expect(git(clone, "rev-parse", "HEAD")).toBe(before);
    expect(JSON.parse(read("package.json")).dependencies).toEqual({ left: "1.5.0" });
  });
});
