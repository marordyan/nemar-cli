/**
 * Update check unit tests (epic #1225 phase 6, site 4 of the semver
 * migration brief).
 *
 * This file replaces one that could never have caught the #1163 bug it
 * exists to guard: it hand-copied normalizeVersion()'s body into the test
 * file and then asserted against its own copy (`compareVersions()` called
 * directly, never `isNewerVersion()` or `initUpdateCheck()`), which is
 * exactly the smell .rules/testing.md names -- "re-implements production
 * logic locally and then asserts on its own arithmetic." Its "dev version
 * detects update to next patch" case even asserted the bug as CORRECT
 * behavior, with a comment explaining that "0.7.17 is not newer than
 * 0.7.17-dev." That the old file's own expectations encoded the bug is the
 * clearest possible evidence it could not have caught it.
 *
 * This file drives the real entry points instead:
 * - `initUpdateCheck()` (wired into src/index.ts) via a real cache file
 *   under NEMAR_CONFIG_DIR, which is the primary coverage -- the entry
 *   point, not a supplement.
 * - `isNewerVersion()` directly, as a supplement, since it is exported
 *   specifically for this.
 *
 * All five precedence rows are computed relative to the REAL running
 * currentVersion (src/lib/version.ts) rather than hardcoded, so this file
 * does not silently stop testing what it claims to once package.json's
 * -devN suffix advances.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import semver from "semver";
import { initUpdateCheck, isNewerVersion } from "../src/lib/update-check";
import { version as currentVersion } from "../src/lib/version";

const currentParsed = semver.parse(currentVersion);
if (!currentParsed) {
  throw new Error(`test setup: package.json version "${currentVersion}" is not valid semver`);
}
// Release pipeline page (https://docs.nemar.org/develop/release-pipeline/): `dev` always
// carries an X.Y.Z-devN suffix, so on dev this is
// always true and the #1163 rows below exercise the real bug. It is NOT true
// on main: auto-tag.yml strips the suffix and pushes that commit back without
// [skip ci], so test.yml runs against a stable X.Y.Z there. Skipping those
// rows is the only correct response -- an earlier version of this file threw
// at module scope instead, which turned the whole required unit-pure tier red
// on every release strip commit (#1225 review).
const HAS_PRERELEASE = currentParsed.prerelease.length > 0;

/** The stable release currentVersion is a prerelease of, e.g. "0.9.15-dev4" -> "0.9.15". */
const CURRENT_STABLE = `${currentParsed.major}.${currentParsed.minor}.${currentParsed.patch}`;
const NEXT_PATCH = semver.inc(CURRENT_STABLE, "patch");
if (!NEXT_PATCH) {
  throw new Error(`test setup: could not compute next patch of "${CURRENT_STABLE}"`);
}
const RC_OF_CURRENT_STABLE = `${CURRENT_STABLE}-rc1`;
// Any definitely-older stable release. Not meant to model "the previous
// patch" precisely -- the row only needs a version that is unambiguously
// older than currentVersion, and every real nemar-cli version is >= 0.x.
const DEFINITELY_OLDER = "0.0.1";

function freshConfigDir(): string {
  return mkdtempSync(join(tmpdir(), "nemar-update-check-"));
}

function cacheFile(dir: string): string {
  return join(dir, "update-check.json");
}

function writeFreshCache(dir: string, latestVersion: string): void {
  // checkedAt: Date.now() keeps the cache "fresh" (within the 24h TTL), so
  // initUpdateCheck() takes the read-cache branch and never attempts a
  // network fetch -- deterministic and offline-safe.
  writeFileSync(cacheFile(dir), JSON.stringify({ checkedAt: Date.now(), latestVersion }));
}

describe("initUpdateCheck (entry point): precedence via a real cache file", () => {
  const originalConfigDir = process.env.NEMAR_CONFIG_DIR;
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    if (originalConfigDir === undefined) {
      // biome-ignore lint/performance/noDelete: env var cleanup, matches test/completion-cache-degradation.unit.test.ts's convention
      delete process.env.NEMAR_CONFIG_DIR;
    } else {
      process.env.NEMAR_CONFIG_DIR = originalConfigDir;
    }
  });

  // Depends on the running version carrying a prerelease suffix (see
  // HAS_PRERELEASE above): on main, after auto-tag strips it, there is no
  // -devN build for a stable release to be newer than.
  test.skipIf(!HAS_PRERELEASE)(
    `#1163 regression: a released ${CURRENT_STABLE} IS an update over a running ${currentVersion}`,
    async () => {
      // This is the bug this phase fixes, exercised end-to-end. The deleted
      // normalizeVersion() stripped the ENTIRE prerelease suffix off
      // currentVersion before comparing, so a cached latestVersion equal to
      // the stable release the running -devN build is a prerelease OF
      // compared as merely EQUAL -- no banner ever fired for a dev build user,
      // even once the real release shipped.
      dir = freshConfigDir();
      process.env.NEMAR_CONFIG_DIR = dir;
      writeFreshCache(dir, CURRENT_STABLE);
      await expect(initUpdateCheck()).resolves.toBe(CURRENT_STABLE);
    },
  );

  test("no update: cached latestVersion equals the running version", async () => {
    dir = freshConfigDir();
    process.env.NEMAR_CONFIG_DIR = dir;
    writeFreshCache(dir, currentVersion);
    await expect(initUpdateCheck()).resolves.toBeNull();
  });

  test(`update available: a genuinely newer patch (${NEXT_PATCH})`, async () => {
    dir = freshConfigDir();
    process.env.NEMAR_CONFIG_DIR = dir;
    writeFreshCache(dir, NEXT_PATCH);
    await expect(initUpdateCheck()).resolves.toBe(NEXT_PATCH);
  });

  // Depends on the running version carrying a prerelease suffix (see
  // HAS_PRERELEASE above): on main, after auto-tag strips it, there is no
  // -devN build for a stable release to be newer than.
  test.skipIf(!HAS_PRERELEASE)(
    `update available: a prerelease of the same stable release (${RC_OF_CURRENT_STABLE})`,
    async () => {
      // "rc1" sorts after "dev4" (or whatever the running -devN suffix is)
      // under semver's prerelease identifier comparison, so this is still an
      // update, not merely a lateral move.
      dir = freshConfigDir();
      process.env.NEMAR_CONFIG_DIR = dir;
      writeFreshCache(dir, RC_OF_CURRENT_STABLE);
      await expect(initUpdateCheck()).resolves.toBe(RC_OF_CURRENT_STABLE);
    },
  );

  test(`no update: cached latestVersion (${DEFINITELY_OLDER}) is older than the running version`, async () => {
    dir = freshConfigDir();
    process.env.NEMAR_CONFIG_DIR = dir;
    writeFreshCache(dir, DEFINITELY_OLDER);
    await expect(initUpdateCheck()).resolves.toBeNull();
  });

  test("a corrupt cached latestVersion produces no banner and no throw", async () => {
    // readCache() only checks that latestVersion is typeof "string"; a
    // string that isn't a valid version passes that check and used to reach
    // compareVersions(), which threw "Invalid version(s): ..." out of
    // initUpdateCheck(). The semver.valid() guard in isNewerVersion() now
    // degrades this to "no update available" -- src/index.ts only calls
    // printUpdateBanner() when initUpdateCheck() resolves truthy, so a null
    // return here is precisely "no banner."
    dir = freshConfigDir();
    process.env.NEMAR_CONFIG_DIR = dir;
    writeFreshCache(dir, "not-a-version");
    await expect(initUpdateCheck()).resolves.toBeNull();
  });
});

describe("isNewerVersion (direct: supplement to the initUpdateCheck entry-point tests above)", () => {
  // Depends on the running version carrying a prerelease suffix (see
  // HAS_PRERELEASE above): on main, after auto-tag strips it, there is no
  // -devN build for a stable release to be newer than.
  test.skipIf(!HAS_PRERELEASE)(
    `the #1163 regression, at the comparator level: ${CURRENT_STABLE} is newer than ${currentVersion}`,
    () => {
      expect(isNewerVersion(CURRENT_STABLE)).toBe(true);
    },
  );

  test("the running version is not newer than itself", () => {
    expect(isNewerVersion(currentVersion)).toBe(false);
  });

  test("an unparseable version string reads as no update, not a throw", () => {
    expect(isNewerVersion("not-a-version")).toBe(false);
    expect(isNewerVersion("")).toBe(false);
  });
});
