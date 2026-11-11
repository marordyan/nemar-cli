/**
 * Entry-point tests for the safety rules around the archive-rename sweep's
 * copy, verify and delete steps (#1491, #1518). Like
 * test/rename-archives-tagging.test.ts they run the REAL
 * `scripts/rename-archives.ts` as a subprocess with the REAL `aws` CLI against
 * a local S3/STS stand-in (`test/helpers/s3-rename-standin.ts`), and assert on
 * the requests the CLI actually sent.
 *
 * What this file adds over the tagging file:
 *
 *  - the MULTIPART copy path. `aws s3 cp` copies anything from 8 MiB up as
 *    CreateMultipartUpload + UploadPartCopy + CompleteMultipartUpload, and
 *    production archives run to hundreds of GiB, so the small-object path the
 *    tagging tests take is not the path that matters. The stand-in moves no
 *    bytes (a copy is metadata: sizes come from the copy-range headers), so a
 *    20 MiB "archive" costs no more than a 500-byte one and the CLI's default
 *    8 MiB threshold is used as it ships -- no config override is needed to
 *    keep these fast.
 *  - a copy that fails part-way, and one that "succeeds" one byte short;
 *  - keys with several versions and delete markers, and keys that are
 *    prefixes of other keys (`list-object-versions --prefix` is a PREFIX
 *    match);
 *  - the delete-time check that the legacy object is still the one that was
 *    verified;
 *  - a dropped connection whose error text embeds a key containing "404";
 *  - a failed version listing costing one item, not the run;
 *  - the region being handed to every call, the exit status on collisions.
 *
 * Skipped when `aws` is not on PATH.
 */

import { describe, expect, test } from "bun:test";
import { which } from "bun";
import { runRenameScript } from "./helpers/rename-archives-run";
import { type RenameS3Standin, startRenameS3Standin } from "./helpers/s3-rename-standin";

const B = "nemar";
const ID = "nm000132";
const MiB = 1024 * 1024;
const T1 = "2026-03-01T00:00:00.000Z";
const T2 = "2026-04-01T00:00:00.000Z";
const oldKey = (id: string, v: string) => `${id}/archives/v${v}.zip`;
const newKey = (id: string, v: string) => `${id}/archives/${id}_v${v}.zip`;
const apply = (id = ID) => ["--apply", "--dataset", id, "--bucket", B];

const awsInstalled = which("aws") !== null;

// Per-test timeout: see the note in test/rename-archives-tagging.test.ts (a
// describe-level option is ignored by Bun 1.4.2, and CI's `unit-pure` tier
// has the 5s default).
const TEST_TIMEOUT_MS = 60000;

// Every scenario owns its stand-in (ephemeral ports) and its private HOME and
// AWS config, so scenarios are independent and run in a small pool: the first
// test to run starts the pool, which works through the scenarios in order,
// MAX_CONCURRENT at a time (each spawns `bun` plus the real `aws` CLI several
// times, and CI runners have four cores shared with other files). Each test
// then waits for its own scenario and reports its failure, so the per-test
// timeout still bounds one scenario and not the queue ahead of it. A retried
// test runs its scenario again on its own.
const MAX_CONCURRENT = 3;

type Outcome = { error: unknown } | null;

interface Scenario {
  run: () => Promise<void>;
  outcome: Promise<Outcome>;
  settle: (o: Outcome) => void;
}

const scenarios: Scenario[] = [];
let poolStarted = false;

function startPool(): void {
  if (poolStarted) return;
  poolStarted = true;
  let next = 0;
  const lane = async (): Promise<void> => {
    for (let i = next++; i < scenarios.length; i = next++) {
      const sc = scenarios[i] as Scenario;
      try {
        await sc.run();
        sc.settle(null);
      } catch (error) {
        sc.settle({ error });
      }
    }
  };
  for (let n = 0; n < MAX_CONCURRENT; n++) void lane();
}

type Ops = (op: string) => RenameS3Standin["log"];

/** One scenario against a fresh stand-in, checked for the invariant below once it ends. */
function scenario(name: string, body: (s: RenameS3Standin, ops: Ops) => Promise<void>): void {
  const run = async (): Promise<void> => {
    const s = startRenameS3Standin();
    let bare: RenameS3Standin["log"] = [];
    let failed = false;
    let failure: unknown;
    try {
      await body(s, (op) => s.log.filter((e) => e.op === op));
    } catch (e) {
      failed = true;
      failure = e;
    } finally {
      // Invariant across every scenario: the script only ever deletes BY
      // VERSION ID. On this versioned bucket a bare DELETE just adds a
      // delete marker and frees nothing.
      bare = s.log.filter((e) => e.op === "DeleteObject" && e.versionId === null);
      s.stop();
    }
    // The invariant is judged even when the body failed, as the afterEach it replaced was: a
    // scenario that both fails and issues a bare DELETE reports both.
    if (failed && bare.length > 0) {
      throw new AggregateError(
        [failure, new Error(`bare DELETE requests: ${JSON.stringify(bare)}`)],
        "the scenario failed and the script also issued a bare DELETE",
      );
    }
    if (failed) throw failure;
    expect(bare).toEqual([]);
  };
  let settle: (o: Outcome) => void = () => {};
  const outcome = new Promise<Outcome>((resolve) => {
    settle = resolve;
  });
  scenarios.push({ run, outcome, settle });
  let attempts = 0;
  test(
    name,
    async () => {
      if (attempts++ > 0) return run();
      startPool();
      const result = await outcome;
      if (result) throw result.error;
    },
    TEST_TIMEOUT_MS,
  );
}

describe.skipIf(!awsInstalled)("rename-archives.ts safety (real aws CLI, stand-in S3)", () => {
  // ---- multipart ----------------------------------------------------------

  scenario(
    "multipart copy (20 MiB): parts copied, completed, verified, tagged, then the old version deleted by id",
    async (s, ops) => {
      const oldVersionId = s.putObject(B, oldKey(ID, "1.0.0"), {
        size: 20 * MiB,
        etag: '"aaaa-3"',
        lastModified: T1,
      });

      const run = await runRenameScript(s, apply());
      expect(run.exitCode).toBe(0);

      // It really was a multipart copy: no single-call CopyObject.
      expect(ops("CopyObject")).toEqual([]);
      expect(ops("CreateMultipartUpload")).toHaveLength(1);
      const parts = s.log.filter((e) => e.op === "UploadPartCopy");
      expect(parts.length).toBeGreaterThanOrEqual(2);
      const complete = s.log.find((e) => e.op === "CompleteMultipartUpload");
      expect(complete?.op === "CompleteMultipartUpload" && complete.size).toBe(20 * MiB);

      // The size is announced before the (silent) copy starts.
      expect(run.stdout).toContain("copying 20.0 MiB");

      const dest = s.getObject(B, newKey(ID, "1.0.0"));
      expect(dest?.size).toBe(20 * MiB);
      expect(dest?.tags["nemar-kind"]).toBe("archive");
      expect(s.has(B, oldKey(ID, "1.0.0"))).toBe(false);
      const del = s.log.find((e) => e.op === "DeleteObject");
      expect(del?.op === "DeleteObject" && del.versionId).toBe(oldVersionId);
    },
  );

  scenario(
    "a plain-MD5 source above the multipart threshold still verifies: its copy has a multipart ETag",
    async (s, ops) => {
      // Uploaded in a single PUT (plain MD5 ETag), but 20 MiB, so `aws s3 cp`
      // copies it multipart and the copy comes out with a `-<parts>` ETag.
      s.putObject(B, oldKey(ID, "1.0.0"), {
        size: 20 * MiB,
        etag: '"d41d8cd98f00b204e9800998ecf8427e"',
        lastModified: T1,
      });

      const run = await runRenameScript(s, apply());
      expect(run.exitCode).toBe(0);
      expect(run.stdout).toContain("an ETag is multipart-form, ETag comparison skipped");
      expect(s.has(B, oldKey(ID, "1.0.0"))).toBe(false);
      expect(s.getObject(B, newKey(ID, "1.0.0"))?.tags["nemar-kind"]).toBe("archive");
    },
  );

  scenario(
    "a part that fails mid-copy leaves the old object intact and no destination",
    async (s, ops) => {
      s.putObject(B, oldKey(ID, "1.0.0"), { size: 20 * MiB, etag: '"aaaa-3"', lastModified: T1 });
      s.inject("UploadPartCopy", { code: "AccessDenied", status: 403, after: 1 });

      const run = await runRenameScript(s, apply());
      expect(run.exitCode).not.toBe(0);
      expect(run.stderr).toContain("FAILED to copy");

      expect(s.has(B, oldKey(ID, "1.0.0"))).toBe(true);
      expect(s.has(B, newKey(ID, "1.0.0"))).toBe(false);
      expect(ops("CompleteMultipartUpload")).toEqual([]);
      // Nothing after the failed copy ran.
      expect(ops("PutObjectTagging")).toEqual([]);
      expect(ops("DeleteObject")).toEqual([]);
    },
  );

  scenario(
    "a destination one byte short after a 'successful' copy is refused: nothing tagged, nothing deleted",
    async (s, ops) => {
      s.putObject(B, oldKey(ID, "1.0.0"), { size: 20 * MiB, etag: '"aaaa-3"', lastModified: T1 });
      s.shortenNextMultipartCompleteBy(1);

      const run = await runRenameScript(s, apply());
      expect(run.exitCode).not.toBe(0);
      expect(run.stdout).toContain("verify: FAILED");
      expect(run.stdout).toContain(`size mismatch: source ${20 * MiB}, dest ${20 * MiB - 1}`);

      // The CLI reported success and the destination exists, one byte short...
      expect(s.getObject(B, newKey(ID, "1.0.0"))?.size).toBe(20 * MiB - 1);
      // ...and the script refused to build on it.
      expect(ops("PutObjectTagging")).toEqual([]);
      expect(ops("DeleteObject")).toEqual([]);
      expect(s.has(B, oldKey(ID, "1.0.0"))).toBe(true);
    },
  );

  scenario(
    "a re-run over that short destination is a collision, not a rename: nothing deleted, exit nonzero",
    async (s, ops) => {
      s.putObject(B, oldKey(ID, "1.0.0"), { size: 20 * MiB, etag: '"aaaa-3"', lastModified: T1 });
      // A destination already there and one byte short (an earlier run's
      // leftover), newer than the source.
      s.putObject(B, newKey(ID, "1.0.0"), {
        size: 20 * MiB - 1,
        etag: '"short-3"',
        lastModified: T2,
      });

      const run = await runRenameScript(s, apply());
      expect(run.exitCode).not.toBe(0);
      expect(run.stderr).toContain("SKIP (collision");
      expect(run.stderr).toContain("inspect the destination first");
      expect(run.stdout).toContain("collisions (left untouched): 1");

      expect(ops("CopyObject")).toEqual([]);
      expect(ops("CreateMultipartUpload")).toEqual([]);
      expect(ops("PutObjectTagging")).toEqual([]);
      expect(ops("DeleteObject")).toEqual([]);
      expect(s.getObject(B, newKey(ID, "1.0.0"))?.size).toBe(20 * MiB - 1);
    },
  );

  scenario(
    "a HEAD that errors after the copy is a failed verification, not a 'missing destination'; a re-run resumes",
    async (s, ops) => {
      s.putObject(B, oldKey(ID, "1.0.0"), { size: 500, etag: '"a"', lastModified: T1 });
      // The destination's first HEAD (the pre-check, before the copy) passes;
      // the second (the verification after it) hits an expired token.
      s.inject("HeadObject", {
        code: "ExpiredToken",
        status: 400,
        key: newKey(ID, "1.0.0"),
        after: 1,
      });

      const first = await runRenameScript(s, apply());
      expect(first.exitCode).not.toBe(0);
      expect(first.stderr).toContain("FAILED to verify copy");
      expect(first.stderr).not.toContain("destination object not found");
      expect(ops("PutObjectTagging")).toEqual([]);
      expect(ops("DeleteObject")).toEqual([]);
      expect(s.has(B, oldKey(ID, "1.0.0"))).toBe(true);
      // The copy did land.
      expect(s.has(B, newKey(ID, "1.0.0"))).toBe(true);

      s.clearFaults();
      const second = await runRenameScript(s, apply());
      expect(second.exitCode).toBe(0);
      expect(s.has(B, oldKey(ID, "1.0.0"))).toBe(false);
      expect(s.getObject(B, newKey(ID, "1.0.0"))?.tags["nemar-kind"]).toBe("archive");
    },
  );

  // ---- versions and prefixes ----------------------------------------------

  scenario(
    "a legacy key with an older version and a delete marker: warned, counted, never deleted",
    async (s, ops) => {
      const key = oldKey(ID, "1.0.0");
      const olderId = s.putObject(B, key, { size: 700, etag: '"old"', lastModified: T1 });
      const markerId = s.putDeleteMarker(B, key);
      const currentId = s.putObject(B, key, { size: 1000, etag: '"cur"', lastModified: T2 });

      const run = await runRenameScript(s, apply());
      // Renamed as planned, but the leftovers are reported. The rename itself
      // is not a failure, so the exit status stays 0.
      expect(run.exitCode).toBe(0);
      expect(s.getObject(B, newKey(ID, "1.0.0"))?.size).toBe(1000);

      expect(run.stderr).toContain("WARNING");
      expect(run.stderr).toContain(`version ${olderId}`);
      expect(run.stderr).toContain(`delete-marker ${markerId}`);
      expect(run.stdout).toContain("legacy keys with leftover versions: 1");

      // Exactly one delete, of exactly the current version, by id. The older
      // version and the marker are still there.
      const deletes = s.log.filter((e) => e.op === "DeleteObject");
      expect(deletes).toHaveLength(1);
      const del = deletes[0];
      expect(del.op === "DeleteObject" && del.versionId).toBe(currentId);
      expect(s.versions(B, key).map((v) => v.versionId)).toEqual([olderId, markerId]);
    },
  );

  scenario(
    "deleting the current version resurrects an older one: warned, and a re-run flags it as a collision",
    async (s, ops) => {
      const key = oldKey(ID, "1.0.0");
      const olderId = s.putObject(B, key, { size: 700, etag: '"old"', lastModified: T1 });
      s.putObject(B, key, { size: 1000, etag: '"cur"', lastModified: T2 });

      const first = await runRenameScript(s, apply());
      expect(first.exitCode).toBe(0);
      expect(first.stderr).toContain(`version ${olderId}`);
      // The legacy key is back, holding the OLD build.
      expect(s.getObject(B, key)?.size).toBe(700);

      const second = await runRenameScript(s, apply());
      // The resurrected object no longer matches the renamed one, so the
      // re-run refuses to touch it and says so.
      expect(second.exitCode).not.toBe(0);
      expect(second.stdout).toContain("collisions (left untouched): 1");
      expect(s.getObject(B, key)?.size).toBe(700);
      expect(s.log.filter((e) => e.op === "DeleteObject")).toHaveLength(1);
    },
  );

  scenario(
    "keys that are prefixes of each other: every version listing is filtered to the exact key",
    async (s, ops) => {
      // v1.0.1.zip and v1.0.10.zip are the pair a sloppy match confuses, and
      // v1.0.1.zip.bak is a real prefix neighbour: `list-object-versions
      // --prefix .../v1.0.1.zip` returns it too. It is not a .zip, so it is
      // never renamed, and it must neither be deleted nor counted as a
      // leftover of v1.0.1.zip.
      const v101 = s.putObject(B, oldKey(ID, "1.0.1"), {
        size: 1000,
        etag: '"a"',
        lastModified: T1,
      });
      const v1010 = s.putObject(B, oldKey(ID, "1.0.10"), {
        size: 2000,
        etag: '"b"',
        lastModified: T1,
      });
      const bak = `${oldKey(ID, "1.0.1")}.bak`;
      const bakId = s.putObject(B, bak, { size: 1000, etag: '"a"', lastModified: T1 });

      const run = await runRenameScript(s, apply());
      expect(run.exitCode).toBe(0);
      expect(run.stdout).toContain("legacy keys with leftover versions: 0");

      expect(s.getObject(B, newKey(ID, "1.0.1"))?.size).toBe(1000);
      expect(s.getObject(B, newKey(ID, "1.0.10"))?.size).toBe(2000);
      expect(s.has(B, oldKey(ID, "1.0.1"))).toBe(false);
      expect(s.has(B, oldKey(ID, "1.0.10"))).toBe(false);

      // Exactly two deletes, each the right version of the right key, and
      // never a bare (versionless) one.
      const deletes = s.log.flatMap((e) => (e.op === "DeleteObject" ? [e] : []));
      expect(deletes.map((d) => [d.key, d.versionId]).sort()).toEqual(
        [
          [oldKey(ID, "1.0.1"), v101],
          [oldKey(ID, "1.0.10"), v1010],
        ].sort(),
      );
      // The neighbour is untouched.
      expect(s.versions(B, bak).map((v) => v.versionId)).toEqual([bakId]);
    },
  );

  scenario(
    "a legacy object replaced between the copy and the delete is NOT deleted",
    async (s, ops) => {
      const key = oldKey(ID, "1.0.0");
      s.putObject(B, key, { size: 1000, etag: '"planned"', lastModified: T1 });
      // The first version listing happens just before the delete. Rebuild the
      // legacy key right then: a new current version, different content.
      s.beforeOp("ListObjectVersions", () => {
        s.putObject(B, key, { size: 4321, etag: '"rebuilt"', lastModified: T2 });
      });

      const run = await runRenameScript(s, apply());
      expect(run.exitCode).not.toBe(0);
      expect(run.stderr).toContain("not the object that was planned and verified");

      expect(ops("DeleteObject")).toEqual([]);
      // Both legacy versions survive, and the copy of the original is intact.
      expect(s.versions(B, key)).toHaveLength(2);
      expect(s.getObject(B, newKey(ID, "1.0.0"))?.size).toBe(1000);
    },
  );

  scenario("a delete that S3 refuses is a failed item, not a rename", async (s, ops) => {
    s.putObject(B, oldKey(ID, "1.0.0"), { size: 500, etag: '"a"', lastModified: T1 });
    s.inject("DeleteObject", { code: "AccessDenied", status: 403 });

    const run = await runRenameScript(s, apply());
    expect(run.exitCode).not.toBe(0);
    expect(run.stdout).toContain("Renamed: 0");
    expect(run.stdout).toContain("failed: 1");
    expect(run.stderr).toContain("FAILED to delete old version");
    expect(s.has(B, oldKey(ID, "1.0.0"))).toBe(true);
  });

  // ---- head errors, listing errors, region, exit status -------------------

  scenario(
    "a dropped connection whose URL contains 404 is not read as 'no destination': nothing is overwritten",
    async (s, ops) => {
      // nm000404's key embeds "404", and the CLI's connection-error text embeds
      // the request URL, so the error line contains "404" without being a 404.
      const id = "nm000404";
      s.putObject(B, oldKey(id, "1.0.0"), { size: 500, etag: '"abc123"', lastModified: T1 });
      // A destination that already exists, holds different content, and would
      // be overwritten by a copy.
      s.putObject(B, newKey(id, "1.0.0"), { size: 900, etag: '"fresh"', lastModified: T2 });
      s.hangNextHead(B, newKey(id, "1.0.0"));

      const run = await runRenameScript(s, apply(id));
      expect(run.exitCode).not.toBe(0);
      expect(run.stderr).toContain("Connection was closed");
      expect(run.stderr).toContain(newKey(id, "1.0.0"));
      expect(run.stderr).toContain("neither object touched");

      expect(ops("CopyObject")).toEqual([]);
      expect(ops("CreateMultipartUpload")).toEqual([]);
      expect(ops("DeleteObject")).toEqual([]);
      expect(s.getObject(B, newKey(id, "1.0.0"))?.etag).toBe('"fresh"');
      expect(s.getObject(B, newKey(id, "1.0.0"))?.size).toBe(900);
    },
  );

  scenario(
    "a failed version listing fails that ITEM, not the run, and a re-run resumes",
    async (s, ops) => {
      s.putObject(B, oldKey(ID, "1.0.0"), { size: 500, etag: '"a"', lastModified: T1 });
      s.putObject(B, oldKey(ID, "1.0.1"), { size: 600, etag: '"b"', lastModified: T1 });
      // Credentials expire between the tag and the delete.
      s.inject("ListObjectVersions", { code: "ExpiredToken", status: 400 });

      const first = await runRenameScript(s, apply());
      expect(first.exitCode).not.toBe(0);
      expect(first.stdout).toContain("failed: 2");
      expect(first.stderr).toContain("could not list the versions");
      // The run did not abort on the first item: the second was copied too.
      expect(s.has(B, newKey(ID, "1.0.0"))).toBe(true);
      expect(s.has(B, newKey(ID, "1.0.1"))).toBe(true);
      expect(ops("DeleteObject")).toEqual([]);
      expect(s.has(B, oldKey(ID, "1.0.0"))).toBe(true);
      expect(s.has(B, oldKey(ID, "1.0.1"))).toBe(true);

      // Credentials refreshed: the re-run finds both destinations verified
      // (already-renamed) and finishes the deletes.
      s.clearFaults();
      const second = await runRenameScript(s, apply());
      expect(second.exitCode).toBe(0);
      expect(s.has(B, oldKey(ID, "1.0.0"))).toBe(false);
      expect(s.has(B, oldKey(ID, "1.0.1"))).toBe(false);
    },
  );

  scenario(
    "the region is passed to every call, guard included, with no AWS_DEFAULT_REGION in the environment",
    async (s, ops) => {
      s.putObject(B, oldKey(ID, "1.0.0"), { size: 500, etag: '"a"', lastModified: T1 });

      const run = await runRenameScript(s, [
        "--dataset",
        ID,
        "--bucket",
        B,
        "--region",
        "eu-west-1",
      ]);
      expect(run.exitCode).toBe(0);
      // Signed for eu-west-1, on S3 AND on the STS probe in the guard.
      expect([...s.regions.s3]).toEqual(["eu-west-1"]);
      expect([...s.regions.sts]).toEqual(["eu-west-1"]);
    },
  );

  scenario("the region defaults to us-east-2, again without AWS_DEFAULT_REGION", async (s, ops) => {
    s.putObject(B, oldKey(ID, "1.0.0"), { size: 500, etag: '"a"', lastModified: T1 });

    const run = await runRenameScript(s, ["--dataset", ID, "--bucket", B]);
    expect(run.exitCode).toBe(0);
    expect([...s.regions.s3]).toEqual(["us-east-2"]);
    expect([...s.regions.sts]).toEqual(["us-east-2"]);
  });

  scenario(
    "a region that is not an AWS region name is refused before any request",
    async (s, ops) => {
      const run = await runRenameScript(s, ["--dataset", ID, "--region", "us-east-2; echo hi"]);
      expect(run.exitCode).not.toBe(0);
      expect(run.stderr).toContain("is not an AWS region name");
      expect(s.log).toEqual([]);
    },
  );

  scenario(
    "a collision exits nonzero, names the collision, and tells the operator to inspect first",
    async (s, ops) => {
      s.putObject(B, oldKey(ID, "1.0.0"), { size: 500, etag: '"a"', lastModified: T1 });
      s.putObject(B, newKey(ID, "1.0.0"), { size: 900, etag: '"different"', lastModified: T2 });

      const run = await runRenameScript(s, apply());
      expect(run.exitCode).not.toBe(0);
      expect(run.stdout).toContain("collisions (left untouched): 1");
      expect(run.stdout).toContain("inspect the destination first");
      expect(ops("DeleteObject")).toEqual([]);
      expect(ops("PutObjectTagging")).toEqual([]);
    },
  );

  scenario(
    "--delete-stale-legacy refuses a destination that is SMALLER than the legacy object",
    async (s, ops) => {
      // Newer and non-empty, but smaller: a truncated or partial destination,
      // not a fresh build. Deleting the legacy object here would destroy the
      // only intact copy.
      s.putObject(B, oldKey(ID, "1.0.0"), { size: 500, etag: '"a"', lastModified: T1 });
      s.putObject(B, newKey(ID, "1.0.0"), { size: 100, etag: '"partial"', lastModified: T2 });

      const run = await runRenameScript(s, [...apply(), "--delete-stale-legacy"]);
      expect(run.exitCode).not.toBe(0);
      expect(run.stderr).toContain("at least as large");
      expect(ops("DeleteObject")).toEqual([]);
      expect(ops("PutObjectTagging")).toEqual([]);
      expect(s.has(B, oldKey(ID, "1.0.0"))).toBe(true);
    },
  );
});
