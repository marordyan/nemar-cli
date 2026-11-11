/**
 * Regression test for nemarOrg/nemar-cli#509:
 *
 * Small regular git-tracked files at the dataset root (README.md, CHANGES,
 * dataset_description.json, .gitattributes) were silently dropped from the
 * manifest because they fell into the "annex pointer candidate" size band
 * (20-500 bytes), failed parseAnnexPointer, then got filtered OUT of the
 * regular-files loop as well.
 *
 * This test asserts that:
 *   1. Small regular files at root are present in the manifest as git:* keys
 *   2. Real annex pointers in the same size band still resolve correctly
 *   3. `.gitattributes` is NOT excluded by an accidental `.git` substring match
 *   4. `.git/` and `.github/` plumbing IS still excluded
 */

import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { spawn } from "bun";

/**
 * WHY THESE TESTS RUN IN A PROCESS OF THEIR OWN. `mock.module` cannot be undone, and `test/` and
 * `backend/test/` share one Bun process. Installed in a shared run, this file's mock of the GitHub
 * service would stand for every later test: `getTreeAtRef` would keep returning this file's last
 * fake tree, and the manifest canary read a file list that was never its own. So the mock and the
 * assertions live in the first describe, which runs only when `MANIFEST_SMALL_ISOLATED=1`, and the
 * second describe spawns this file in a child process with that variable set and requires every test
 * to pass there. The assertions therefore always run, and always in a process no mock has touched.
 */
const ISOLATED = process.env.MANIFEST_SMALL_ISOLATED === "1";
/** How many tests the isolated describe holds; the wrapper requires the child to run them all. */
const ISOLATED_TESTS = 7;

const fakeTree: Array<{
  path: string;
  mode: string;
  type: "blob" | "tree";
  sha: string;
  size?: number;
}> = [];
const fakeBlobs: Record<string, string> = {};

let generateManifest: typeof import("../src/services/manifest").generateManifest;

/** Full-length digests: the builder refuses a key whose digest is not one (#2118). */
const X_DIGEST = "abc123def4567890abc123def4567890abc123def4567890abc123def4567890";
const MD5_DIGEST = "cafebabecafebabecafebabecafebabe";

function blob(path: string, sha: string, size: number, content = ""): void {
  fakeTree.push({ path, mode: "100644", type: "blob", sha, size });
  fakeBlobs[sha] = content;
}

describe.skipIf(!ISOLATED)("generateManifest — small root file handling (issue #509)", () => {
  beforeAll(async () => {
    // Never install the mock in a shared run, whatever the runner does with a skipped describe.
    if (!ISOLATED) return;
    // Preserve the real module and override only the two functions generateManifest calls. Other
    // tests in the suite transitively import the github service (webhooks, datasets routes pull
    // ensureMainBranch etc.), so we must not replace the entire module export shape.
    const realGithub = await import("../src/services/github");
    mock.module("../src/services/github", () => ({
      ...realGithub,
      getTreeAtRef: async () => fakeTree,
      getBlobContent: async (_repo: string, sha: string) => fakeBlobs[sha] ?? "",
    }));
    ({ generateManifest } = await import("../src/services/manifest"));
  });

  beforeEach(() => {
    fakeTree.length = 0;
    for (const k of Object.keys(fakeBlobs)) delete fakeBlobs[k];
  });

  test("includes small regular root files that are not annex pointers", async () => {
    // Shape mirrors nemarDatasets/on005262 at v1.0.0 (real sizes from gh api).
    blob(".gitattributes", "sha-gitattrs", 427, "*.edf annex.largefiles=anything");
    blob("CHANGES", "sha-changes", 66, "v1.0.0\nInitial import from OpenNeuro\n");
    blob("README.md", "sha-readme", 432, "# ArEEG: Arabic EEG Dataset\n\nInner speech EEG...");
    blob("dataset_description.json", "sha-dd", 461, '{"Name":"ArEEG","BIDSVersion":"1.9.0"}');
    // A real annex pointer in the same size band:
    blob("sub-0/eeg/x.edf", "sha-ptr", 180, `/annex/objects/SHA256E-s12345--${X_DIGEST}.edf\n`);

    // skipGitBackedVerification: the canary added in #503 HEADs
    // raw.githubusercontent.com for git:-keyed paths. The mocked tree above
    // uses synthetic SHAs / tags that don't exist on real GitHub, so the
    // canary would 404 unrelated to what this test exercises. Skip it.
    const m = await generateManifest(
      "nemarDatasets/on005262",
      "v1.0.0",
      "fake-pat",
      "on005262",
      null,
      null,
      { skipGitBackedVerification: true },
    );

    expect(Object.keys(m.files).sort()).toEqual(
      [
        ".gitattributes",
        "CHANGES",
        "README.md",
        "dataset_description.json",
        "sub-0/eeg/x.edf",
      ].sort(),
    );

    // Regular files use git:<sha> keys
    expect(m.files["README.md"]).toEqual({
      key: "git:sha-readme",
      size: 432,
      checksum: "git:sha-readme",
    });
    expect(m.files.CHANGES.key).toBe("git:sha-changes");
    expect(m.files[".gitattributes"].key).toBe("git:sha-gitattrs");

    // Annex pointer resolves to its parsed key
    expect(m.files["sub-0/eeg/x.edf"].key).toBe(`SHA256E-s12345--${X_DIGEST}.edf`);
    expect(m.files["sub-0/eeg/x.edf"].size).toBe(12345);
  });

  test("excludes .git/ plumbing but keeps .gitattributes", async () => {
    blob(".git/config", "sha-gitconfig", 200, "[core]");
    blob(".github/workflows/ci.yml", "sha-ci", 300, "name: CI");
    blob(".gitattributes", "sha-gitattrs", 100, "* text=auto");
    blob("README.md", "sha-readme", 50, "# hi");

    const m = await generateManifest("test/repo", "v1.0.0", "fake-pat", "test", null, null, {
      skipGitBackedVerification: true,
    });

    expect(m.files[".gitattributes"]).toBeDefined();
    expect(m.files["README.md"]).toBeDefined();
    expect(m.files[".git/config"]).toBeUndefined();
    expect(m.files[".github/workflows/ci.yml"]).toBeUndefined();
  });

  test("large root files still flow through the regular-files path (regression for nm*)", async () => {
    // nm000104 shape: README.md is 9763 bytes — above the 500-byte pointer
    // candidate threshold, so it never enters the candidate loop.
    blob("README.md", "sha-readme-big", 9763, "# Dataset\n\n...lots of text...");
    blob("participants.tsv", "sha-participants", 2291, "subject_id\tage\n");

    const m = await generateManifest("test/repo", "v1.0.0", "fake-pat", "test", null, null, {
      skipGitBackedVerification: true,
    });

    expect(m.files["README.md"].key).toBe("git:sha-readme-big");
    expect(m.files["README.md"].size).toBe(9763);
    expect(m.files["participants.tsv"].key).toBe("git:sha-participants");
  });

  test("annex pointer candidates that resolve still take precedence over the regular-files fallback", async () => {
    // A 200-byte blob whose CONTENT is a valid annex pointer should be recorded
    // as an annex entry (with the parsed key), NOT as a git:<sha> entry.
    blob("sub-1/eeg/data.bdf", "sha-ptr", 200, `/annex/objects/MD5E-s987654--${MD5_DIGEST}.bdf`);

    const m = await generateManifest("test/repo", "v1.0.0", "fake-pat", "test", null, null, {
      skipGitBackedVerification: true,
    });

    expect(m.files["sub-1/eeg/data.bdf"]).toEqual({
      key: `MD5E-s987654--${MD5_DIGEST}.bdf`,
      size: 987654,
      checksum: `md5:${MD5_DIGEST}`,
    });
  });

  // nemarOrg/nemar-cli#2118. The keys are the real ones of nemarDatasets/on003104 at v1.0.0,
  // read through the GitHub contents API: a locked-mode symlink target whose file name has no
  // dot. The key was written upstream with the name's tail after the digest (git-annex itself
  // writes the bare digest for such a file), and the tail runs into the digest.
  // `C` (from COR-001) and `01` (from 01_brain_surface) are hex digits, which is why the old
  // parse took them for part of a 64-character digest.
  test("a name with no dot, whose tail starts with hex digits, does not leak into the digest (#2118)", async () => {
    const cor = "de2f256064a0af797747c2b97505dc0b9f3df0de4f489eac731c23ae9ca9cc31";
    const brain = "a61f15d4bcaf7ceafd6f07da5192495bfdeec4492a415e8d46577405caeb7897";
    const target = (key: string) => `../../../.git/annex/objects/mg/MZ/${key}/${key}`;
    blob(
      "derivatives/freesurfer/subjects/01/bem/watershed/ws/COR-001",
      "sha-cor",
      221,
      target(`SHA256E-s65536--${cor}COR-001`),
    );
    blob(
      "derivatives/freesurfer/subjects/01/bem/watershed/01_brain_surface",
      "sha-brain",
      221,
      target(`SHA256E-s369273--${brain}01_brain_surface`),
    );

    const m = await generateManifest("test/repo", "v1.0.0", "fake-pat", "test", null, null, {
      skipGitBackedVerification: true,
    });

    expect(m.files["derivatives/freesurfer/subjects/01/bem/watershed/ws/COR-001"]).toEqual({
      key: `SHA256E-s65536--${cor}COR-001`,
      size: 65536,
      checksum: `sha256:${cor}`,
    });
    expect(m.files["derivatives/freesurfer/subjects/01/bem/watershed/01_brain_surface"]).toEqual({
      key: `SHA256E-s369273--${brain}01_brain_surface`,
      size: 369273,
      checksum: `sha256:${brain}`,
    });
  });

  test("a key whose digest has the wrong length is carried and reported once, never refused (#2118)", async () => {
    blob("sub-1/eeg/short.edf", "sha-short", 200, "/annex/objects/SHA256E-s10--abc123.edf");
    blob("sub-1/eeg/ok.edf", "sha-ok", 200, `/annex/objects/SHA256E-s10--${X_DIGEST}.edf`);

    const warned: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warned.push(args.map(String).join(" "));
    };
    let m: Awaited<ReturnType<typeof generateManifest>>;
    try {
      m = await generateManifest("test/repo", "v1.0.0", "fake-pat", "test", null, null, {
        skipGitBackedVerification: true,
      });
    } finally {
      console.warn = realWarn;
    }

    // Carried as found: the version still gets its manifest.
    expect(m.files["sub-1/eeg/short.edf"].checksum).toBe("sha256:abc123");
    expect(m.files["sub-1/eeg/ok.edf"].checksum).toBe(`sha256:${X_DIGEST}`);
    // Reported once, with the dataset, version, path and backend, and no checksum value.
    expect(warned).toEqual([
      "[manifest] MALFORMED CHECKSUM dataset=test version=v1.0.0 count=1 examples=sub-1/eeg/short.edf [SHA256E]",
    ]);
  });

  test("keys of no known hash backend, and size-less or SHA3 keys, are carried and never refused (#2118)", async () => {
    const sha3 =
      "0fdb27960308c51467edd49a0f5e0c434c9cca721f4c35bff005feabaf6010e777a1137ee8187c5288af57578d18d502a0bbe4c022f5587541961e10132d9834";
    blob("remote/a.dat", "sha-url", 200, "/annex/objects/URL--https&c%%example.org%a.dat");
    blob("remote/b.dat", "sha-worm", 200, "/annex/objects/WORM-s5-m1794343621--b.dat");
    blob("remote/c.dat", "sha-future", 200, "/annex/objects/FUTURE256E-s5--abc123.dat");
    blob("sub-1/eeg/size-less.edf", "sha-md5", 200, `/annex/objects/MD5E--${MD5_DIGEST}.edf`);
    blob("sub-1/eeg/sha3.edf", "sha-sha3", 200, `/annex/objects/SHA3_512E-s7--${sha3}face`);

    const m = await generateManifest("test/repo", "v1.0.0", "fake-pat", "test", null, null, {
      skipGitBackedVerification: true,
    });

    expect(Object.keys(m.files).sort()).toEqual([
      "remote/a.dat",
      "remote/b.dat",
      "remote/c.dat",
      "sub-1/eeg/sha3.edf",
      "sub-1/eeg/size-less.edf",
    ]);
    expect(m.files["sub-1/eeg/size-less.edf"].checksum).toBe(`md5:${MD5_DIGEST}`);
    expect(m.files["sub-1/eeg/sha3.edf"].checksum).toBe(`sha3_512:${sha3}`);
    expect(m.files["remote/c.dat"].checksum).toBe("future256:abc123");
  });
});

describe.skipIf(ISOLATED)("generateManifest small root files, in a process of their own", () => {
  test("pass when this file runs alone with the isolation switch on", async () => {
    const proc = spawn({
      cmd: [
        process.execPath,
        "test",
        `./${import.meta.path.slice(import.meta.path.indexOf("backend/test/"))}`,
      ],
      cwd: `${import.meta.dir}/../..`,
      env: { ...process.env, MANIFEST_SMALL_ISOLATED: "1", NO_COLOR: "1", FORCE_COLOR: "0" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = `${await new Response(proc.stdout).text()}${await new Response(proc.stderr).text()}`;
    const exitCode = await proc.exited;
    expect(out).toMatch(new RegExp(`\\b${ISOLATED_TESTS} pass\\b`));
    expect(out).toMatch(/\b0 fail\b/);
    expect(exitCode).toBe(0);
  }, 60_000);
});
