/**
 * The verify stage, run as the real CLI against the S3 stand-in. One dataset is carried through
 * plan, hash and assemble once; each test gets its own stand-in restored to that state and its own
 * copy of the working directory, damages one thing in the new objects the way a real fault
 * would, and expects verify to name it and to write no proof. The bodies run in the background
 * (`job`, three at a time), and `run` keeps at most three real CLI runs going at once.
 */

import { afterAll, beforeAll, describe, expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  type AssembledFile,
  type VerifiedFile,
  parseVerified,
} from "../../../scripts/scrub/contract";
import { sampleRanges } from "../../../scripts/scrub/s3/s3-lib";
import { type S3Standin, type Snapshot, startS3Standin } from "../helpers/s3-standin";
import { makeJobPool, makeLimiter } from "./concurrency";
import { expectStopped } from "./refusal";
import {
  type Assembled,
  BUCKET,
  DATASET,
  type Fixture,
  SLOW,
  addUnreadableKey,
  buildAssembled,
  centuryFromNow,
  copyDir,
  fileSha256,
  fixtureA,
  fixtureB,
  fixtureC,
  has,
  objectPath,
  readJson,
  rebindPatches,
  removeTempDirs,
  runScrub,
  sha256,
  verifyArgs,
  writeJson,
} from "./support";

afterAll(removeTempDirs);

let standin: S3Standin;
let snap: Snapshot;
let built: Assembled;

const [a, b, c] = [fixtureA(), fixtureB(), fixtureC()];

beforeAll(async () => {
  standin = startS3Standin();
  built = await buildAssembled(standin, [a, b, c]);
  snap = standin.snapshot();
  startJobs();
}, SLOW);

afterAll(() => standin?.stop());

/**
 * The test bodies run in the background, at most three at a time and in the order the tests are
 * written, once `startJobs` opens the queue (`concurrency.ts`). Each test then waits for its own
 * job, so time spent queued is not counted against its timeout. `run` keeps at most three real
 * CLI runs going at once; CI runners have four cores and other files run beside this one.
 */
const { job, start: startJobs } = makeJobPool(3);
const limit = makeLimiter(3);
const run = (s: S3Standin, args: string[], env: Record<string, string> = {}) =>
  limit(() => runScrub(s, args, env));

/**
 * A test with a stand-in of its own, restored to the assembled state, and its own copy of the
 * working directory: what the old `beforeEach` gave every test, without sharing it.
 */
function lane(
  name: string,
  body: (l: { standin: S3Standin; dir: string }) => Promise<void>,
  timeout: number,
) {
  job(
    name,
    async () => {
      const own = startS3Standin();
      try {
        own.restore(snap);
        await body({ standin: own, dir: copyDir(built.dir) });
      } finally {
        own.stop();
      }
    },
    timeout,
  );
}

const assembled = (dir: string) => readJson<AssembledFile>(dir, "assembled.json");
const newVersion = (dir: string, f: Fixture) =>
  (assembled(dir).entries[f.oldKey] as { newVersionId: string }).newVersionId;
const newKeyPath = (f: Fixture) => objectPath(f.newKey as string);

describe("verify", () => {
  lane(
    "a good assembly passes, and the proof names the exact bytes of assembled.json",
    async ({ standin, dir }) => {
      const r = await run(standin, verifyArgs(dir));
      expect(r.exitCode, r.all).toBe(0);
      const proof = parseVerified(JSON.stringify(readJson<VerifiedFile>(dir, "verified.json")));
      // The hash is computed here from the file's bytes, independently of the stage.
      expect(proof.assembledSha256).toBe(sha256(readFileSync(path.join(dir, "assembled.json"))));
      expect(proof.assembledSha256).toBe(fileSha256(dir, "assembled.json"));
      expect(proof.dataset).toBe(DATASET);
      expect(proof.counts.keys).toBe(3);
      expect(proof.counts.headersChecked).toBe(3);
      const windows = [a, b, c].reduce((n, f) => n + sampleRanges(f.bytes.length).length, 0);
      expect(proof.counts.rangesCompared).toBe(windows);
      expect(r.stdout).toContain("verify: ok keys=3 headersChecked=3");

      // Read-only, and it reached the final 64 KiB of the new 20 MiB object.
      for (const op of [
        "PutObject",
        "CreateMultipartUpload",
        "DeleteObject",
        "DeleteObjects",
      ] as const) {
        expect(standin.calls(op).length, op).toBe(0);
      }
      const last = `bytes=${c.bytes.length - 65536}-${c.bytes.length - 1}`;
      expect(
        standin.calls("GetObject").some((x) => x.key === newKeyPath(c) && x.range === last),
      ).toBe(true);
      // The header comparison and the retention read are made for each new object.
      expect(standin.calls("GetObjectRetention").length).toBe(3);
    },
    SLOW,
  );

  lane(
    "refuses a plan with a key nobody read, even when its totals agree",
    async ({ standin, dir }) => {
      addUnreadableKey(dir);
      const r = await run(standin, verifyArgs(dir));
      expectStopped(r, 3, "plan-has-unreadable");
      expect(has(dir, "verified.json")).toBe(false);
      expect(standin.log.length).toBe(0);
    },
    SLOW,
  );

  lane(
    "a corrupted byte inside a sampled window of the new object fails it and writes no proof",
    async ({ standin, dir }) => {
      // A stale proof from an earlier pass must not survive a failing one.
      writeFileSync(path.join(dir, "verified.json"), "{}");
      const windows = sampleRanges(c.bytes.length);
      const [start, end] = windows[Math.floor(windows.length / 2)] as [number, number];
      standin.corruptByte(BUCKET, newKeyPath(c), newVersion(dir, c), Math.floor((start + end) / 2));

      const r = await run(standin, verifyArgs(dir));
      expect(r.exitCode, r.all).toBe(1);
      expect(r.stdout).toContain("range-mismatch=1");
      expect(r.stdout).toContain("verified.json NOT written");
      expect(has(dir, "verified.json")).toBe(false);
    },
    SLOW,
  );

  lane(
    "corruption in the first window after the header and in the final window is also caught",
    async ({ standin, dir }) => {
      const windows = sampleRanges(c.bytes.length);
      const first = windows[0] as [number, number];
      const final = windows[windows.length - 1] as [number, number];
      expect(first[0]).toBe(256);
      for (const offset of [first[0], final[1]]) {
        standin.corruptByte(BUCKET, newKeyPath(c), newVersion(dir, c), offset);
        const r = await run(standin, verifyArgs(dir));
        expect(r.exitCode, `offset ${offset}: ${r.all}`).toBe(1);
        expect(r.stdout).toContain("range-mismatch=1");
        // XOR twice restores the byte.
        standin.corruptByte(BUCKET, newKeyPath(c), newVersion(dir, c), offset);
      }
      const ok = await run(standin, verifyArgs(dir));
      expect(ok.exitCode, ok.all).toBe(0);
    },
    SLOW,
  );

  lane(
    "a new header that is not the planned patch fails, in or out of the identification fields",
    async ({ standin, dir }) => {
      standin.corruptByte(BUCKET, newKeyPath(a), newVersion(dir, a), 10);
      const inField = await run(standin, verifyArgs(dir));
      expect(inField.exitCode, inField.all).toBe(1);
      expect(inField.stdout).toContain("header-not-patch=1");
      standin.corruptByte(BUCKET, newKeyPath(a), newVersion(dir, a), 10);

      standin.corruptByte(BUCKET, newKeyPath(a), newVersion(dir, a), 3);
      const outside = await run(standin, verifyArgs(dir));
      expect(outside.exitCode, outside.all).toBe(1);
      expect(outside.stdout).toContain("header-not-patch=1");
      expect(outside.stdout).toContain("scrub:bytes-before-patient-changed=1");
    },
    SLOW,
  );

  lane(
    "the scrub proof is checked on its own, not only the equality with the patch",
    async ({ standin, dir }) => {
      // Plant the SAME bad header in the new object and in patches.json: the equality holds,
      // so only verifyScrub(old, new) can refuse it.
      const v = standin
        .versions(BUCKET, newKeyPath(a))
        .find((x) => x.versionId === newVersion(dir, a));
      (v as { data: Uint8Array }).data[3] = (v as { data: Uint8Array }).data[3] ^ 0xff;
      const patches = readJson<Record<string, string>>(dir, "patches.json");
      patches[a.oldKey] = Buffer.from((v as { data: Uint8Array }).data.subarray(0, 256)).toString(
        "hex",
      );
      writeJson(dir, "patches.json", patches);
      rebindPatches(dir);

      const r = await run(standin, verifyArgs(dir));
      expect(r.exitCode, r.all).toBe(1);
      expect(r.stdout).toContain("scrub:bytes-before-patient-changed=1");
      expect(r.stdout).not.toContain("header-not-patch");
    },
    SLOW,
  );

  lane(
    "a missing lock, a short lock and a vanished object are each named",
    async ({ standin, dir }) => {
      standin.clearLock(BUCKET, newKeyPath(b), newVersion(dir, b));
      const noLock = await run(standin, verifyArgs(dir));
      expect(noLock.exitCode, noLock.all).toBe(1);
      expect(noLock.stdout).toContain("lock-missing=1");
      expect(noLock.stdout).toContain("retention-missing=1");

      standin.setLock(
        BUCKET,
        newKeyPath(b),
        newVersion(dir, b),
        "GOVERNANCE",
        new Date(Date.now() + 10 * 365 * 24 * 3600 * 1000),
      );
      const short = await run(standin, verifyArgs(dir));
      expect(short.exitCode, short.all).toBe(1);
      expect(short.stdout).toContain("retention-short=1");
      expect(short.stdout).not.toContain("lock-missing");

      standin.dropVersion(BUCKET, newKeyPath(b), newVersion(dir, b));
      const gone = await run(standin, verifyArgs(dir));
      expect(gone.exitCode, gone.all).toBe(1);
      expect(gone.stdout).toContain("new-missing=1");
      expect(has(dir, "verified.json")).toBe(false);
    },
    SLOW,
  );

  lane(
    "a new object of the wrong size, and an old object that cannot be read, fail",
    async ({ standin, dir }) => {
      const v = standin
        .versions(BUCKET, newKeyPath(a))
        .find((x) => x.versionId === newVersion(dir, a));
      (v as { data: Uint8Array }).data = (v as { data: Uint8Array }).data.slice(0, 1000);
      const short = await run(standin, verifyArgs(dir));
      expect(short.exitCode, short.all).toBe(1);
      expect(short.stdout).toContain("new-size-mismatch=1");
      standin.restore(snap);

      const [only] = standin.versions(BUCKET, objectPath(b.oldKey));
      standin.dropVersion(BUCKET, objectPath(b.oldKey), (only as { versionId: string }).versionId);
      const noOld = await run(standin, verifyArgs(dir));
      expect(noOld.exitCode, noOld.all).toBe(1);
      // The class stays: an old object that is gone is not one that could not be reached.
      expect(noOld.stdout).toContain("old-unreadable:GetObject:not-found=1");
    },
    SLOW,
  );

  lane(
    "refuses an assembly that does not cover the plan, or whose keymap disagrees",
    async ({ standin, dir }) => {
      const full = assembled(dir);
      const without = structuredClone(full);
      delete without.entries[a.oldKey];
      writeJson(dir, "assembled.json", without);
      const incomplete = await run(standin, verifyArgs(dir));
      expectStopped(incomplete, 3, "assembled-incomplete");

      const extra = structuredClone(full);
      extra.entries[`SHA256E-s9--${"d".repeat(64)}.edf`] = {
        ...(full.entries[a.oldKey] as object),
        newKey: `SHA256E-s9--${"e".repeat(64)}.edf`,
      } as never;
      writeJson(dir, "assembled.json", extra);
      const unplanned = await run(standin, verifyArgs(dir));
      expectStopped(unplanned, 3, "assembled-has-unplanned-key");

      writeJson(dir, "assembled.json", full);
      const keymap = readJson<Record<string, string>>(dir, "keymap.json");
      keymap[a.oldKey] = keymap[b.oldKey] as string;
      writeJson(dir, "keymap.json", keymap);
      const mismatch = await run(standin, verifyArgs(dir));
      expectStopped(mismatch, 3, "keymap-mismatch");
      expect(has(dir, "verified.json")).toBe(false);
    },
    SLOW,
  );
});

describe("verify: the version that was assembled (T6, T4)", () => {
  lane(
    "reads the recorded version of the new object, and refuses a newer one at the key",
    async ({ standin, dir }) => {
      // Someone writes the new key after assembly, with different bytes (a header and a body
      // that are both wrong). Reading the recorded version finds it good; the newer version is
      // named on its own, never as a header or range failure.
      const other = a.bytes.slice();
      other[20] ^= 0xff;
      other[other.length - 1] ^= 0xff;
      standin.putObject(BUCKET, newKeyPath(a), other, { lockUntil: centuryFromNow() });
      const r = await run(standin, verifyArgs(dir));
      expect(r.exitCode, r.all).toBe(1);
      expect(r.stdout).toContain("(new-not-current=1)");
      expect(has(dir, "verified.json")).toBe(false);
      // Every read of the new object named the recorded version.
      const reads = standin
        .calls("GetObject")
        .filter((x) => x.key === newKeyPath(a) && x.status === 206);
      expect(reads.length).toBeGreaterThan(1);
      const recorded = newVersion(dir, a);
      const current = standin.current(BUCKET, newKeyPath(a))?.versionId;
      expect(current).not.toBe(recorded);
      expect(
        reads.every((x) => x.versionId === recorded),
        JSON.stringify(reads),
      ).toBe(true);
    },
    SLOW,
  );

  lane(
    "an assembled.json of another dataset, or of another bucket, is refused, each on its own",
    async ({ standin, dir }) => {
      const good = assembled(dir);
      writeJson(dir, "assembled.json", { ...good, dataset: "xx090412" });
      expectStopped(await run(standin, verifyArgs(dir)), 3, "assembled-wrong-dataset");
      writeJson(dir, "assembled.json", { ...good, bucket: "other-bucket" });
      expectStopped(await run(standin, verifyArgs(dir)), 3, "assembled-wrong-bucket");
      expect(standin.log.length).toBe(0);
    },
    SLOW,
  );
});
