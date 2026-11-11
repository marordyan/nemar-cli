/**
 * The assemble stage, run as the real CLI with the real `aws` CLI against the S3 stand-in.
 *
 * The stand-in keeps real bytes, so what is asserted is the content an assembled object holds:
 * its sha256 is computed here from an independently built expected buffer and compared with the
 * hash the hashing stage promised in the key, and with the bytes the stand-in actually stored.
 */

import { afterAll, beforeAll, describe, expect } from "bun:test";
import { rmSync } from "node:fs";
import path from "node:path";
import {
  type AssembledFile,
  type HashesFile,
  type KeymapFile,
  parseAssembled,
  parseKey,
  parseKeymap,
} from "../../../scripts/scrub/contract";
import { type S3Standin, startS3Standin } from "../helpers/s3-standin";
import { makeJobPool, makeLimiter } from "./concurrency";
import { expectStopped } from "./refusal";
import {
  BUCKET,
  DATASET,
  type Fixture,
  MIB,
  SLOW,
  assembleArgs,
  centuryFromNow,
  deleteRequests,
  dirText,
  edfFile,
  edfHeader,
  fileSha256,
  fixtureA,
  fixtureB,
  fixtureC,
  fixtureD,
  fixtureE,
  has,
  leaksAName,
  makeFixture,
  objectPath,
  planArgs,
  readJson,
  rebindPatches,
  removeTempDirs,
  runScrub,
  seedManifest,
  seedObject,
  sha256,
  tempDir,
  withFields,
  writeHashes,
  writeJson,
} from "./support";

afterAll(removeTempDirs);

/**
 * The test bodies run in the background, at most three at a time and in the order the tests are
 * written, once `startJobs` opens the queue (`concurrency.ts`). Each test then waits for its own
 * job, so time spent queued is not counted against its timeout. `run` keeps at most three real
 * CLI runs going at once; CI runners have four cores and other files run beside this one.
 */
const { job, start: startJobs } = makeJobPool(3);
beforeAll(startJobs);
const limit = makeLimiter(3);
const run = (s: S3Standin, args: string[], env: Record<string, string> = {}) =>
  limit(() => runScrub(s, args, env));

/** A test with a stand-in of its own, stopped when it ends; its body runs as a background job. */
function lane(name: string, body: (standin: S3Standin) => Promise<void>, timeout: number) {
  job(
    name,
    async () => {
      const standin = startS3Standin();
      try {
        await body(standin);
      } finally {
        standin.stop();
      }
    },
    timeout,
  );
}

/** Seed, plan and hash through the real CLI; assemble is left for the test to run. */
async function planned(
  standin: S3Standin,
  fixtures: Fixture[],
  seed: Record<string, Parameters<typeof seedObject>[2]> = {},
) {
  for (const f of fixtures) seedObject(standin, f, seed[f.label] ?? {});
  seedManifest(standin, "v1.0.0", fixtures);
  const dir = tempDir("assemble");
  const plan = await run(standin, planArgs(dir));
  expect(plan.exitCode, plan.all).toBe(0);
  writeHashes(dir, fixtures);
  return dir;
}

const newObject = (standin: S3Standin, f: Fixture) =>
  standin.current(BUCKET, objectPath(f.newKey as string));

/** Offsets at which two equal-length buffers differ. */
function differing(a: Uint8Array, b: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) out.push(i);
  return out;
}

describe("assemble", () => {
  lane(
    "a dry run says what it would upload and copy, and touches nothing",
    async (standin) => {
      const [a, b, c, e] = [fixtureA(), fixtureB(), fixtureC(), fixtureE()];
      const dir = await planned(standin, [a, b, c, e]);
      const before = standin.log.length;

      const r = await run(standin, ["assemble", "--dir", dir]);
      expect(r.exitCode, r.all).toBe(0);
      expect(standin.log.length).toBe(before);
      expect(has(dir, "assembled.json")).toBe(false);
      expect(has(dir, "keymap.json")).toBe(false);

      const uploaded = a.bytes.length + b.bytes.length + 8 * MIB + e.bytes.length;
      const copied = c.bytes.length - 8 * MIB;
      expect(r.stdout).toContain("objects: 4 (single put 2, multipart 2, parts 3)");
      expect(r.stdout).toContain(
        `bytes uploaded: ${uploaded.toLocaleString("en-US")}; bytes copied server side: ${copied.toLocaleString("en-US")}`,
      );
      expect(r.stdout).toContain("put-object=2");
      expect(r.stdout).toContain("upload-part-copy=1");
      expect(r.stdout).toContain("create-multipart-upload=2");
    },
    SLOW,
  );

  lane(
    "builds each new object: bytes equal the old object except the header, and it is locked",
    async (standin) => {
      const [a, b, c, d, e] = [fixtureA(), fixtureB(), fixtureC(), fixtureD(), fixtureE()];
      const dir = await planned(standin, [a, b, c, d, e], {
        A: { contentType: "application/x-edf", sse: "AES256" },
        C: { contentType: "application/x-edf", sse: "AES256" },
      });
      standin.log.length = 0;

      const r = await run(standin, assembleArgs(dir));
      expect(r.exitCode, r.all).toBe(0);
      expect(r.stdout).toContain("assemble: objects=4 put=2 multipart=2 skipped=0");

      const assembled = parseAssembled(
        JSON.stringify(readJson<AssembledFile>(dir, "assembled.json")),
      );
      const keymap = parseKeymap(JSON.stringify(readJson<KeymapFile>(dir, "keymap.json")));
      expect(Object.keys(assembled.entries).sort()).toEqual(
        [a.oldKey, b.oldKey, c.oldKey, e.oldKey].sort(),
      );
      expect(assembled.bucket).toBe(BUCKET);
      expect(assembled.dataset).toBe(DATASET);

      const minRetain = Date.now() + 99 * 365 * 24 * 3600 * 1000;
      const maxRetain = Date.now() + 101 * 365 * 24 * 3600 * 1000;
      for (const f of [a, b, c, e]) {
        const made = newObject(standin, f);
        expect(made, f.label).toBeDefined();
        const data = (made as { data: Uint8Array }).data;
        // The bytes are exactly what the independent expectation says, and hash to the key.
        expect(data.length, f.label).toBe(f.bytes.length);
        expect(Buffer.compare(data, f.expected as Uint8Array), f.label).toBe(0);
        expect(sha256(data), f.label).toBe(parseKey(f.newKey as string).sha256);
        // It differs from the original only inside the two identification fields.
        const diff = differing(f.bytes, data);
        expect(diff.length, f.label).toBeGreaterThan(0);
        expect(Math.min(...diff), f.label).toBeGreaterThanOrEqual(8);
        expect(Math.max(...diff), f.label).toBeLessThan(168);
        // Locked at creation: GOVERNANCE, about a century out.
        const lock = (made as { lock?: { mode: string; until: Date } }).lock;
        expect(lock?.mode, f.label).toBe("GOVERNANCE");
        expect(lock?.until.getTime(), f.label).toBeGreaterThan(minRetain);
        expect(lock?.until.getTime(), f.label).toBeLessThan(maxRetain);
        // The record handed to the next stages matches what S3 holds.
        const entry = assembled.entries[f.oldKey];
        expect(entry?.newKey).toBe(f.newKey as string);
        expect(entry?.newVersionId).toBe((made as { versionId: string }).versionId);
        expect(Date.parse(entry?.retainUntil ?? "")).toBe(lock?.until.getTime() as number);
        expect(entry?.mode).toBe("GOVERNANCE");
        expect(keymap[f.oldKey]).toBe(f.newKey as string);
      }
      // Nothing was made for the clean file.
      expect(Object.keys(keymap)).not.toContain(d.oldKey);
      expect(standin.keys(BUCKET, `${DATASET}/objects/`).length).toBe(5 + 4);

      // Content type and encryption of the source carry over.
      for (const f of [a, c]) {
        const made = newObject(standin, f);
        expect(made?.contentType, f.label).toBe("application/x-edf");
        expect(made?.sse, f.label).toBe("AES256");
      }

      // It never deleted anything, and the old objects are untouched.
      expect(deleteRequests(standin)).toBe(0);
      for (const f of [a, b, c, e]) {
        const vs = standin.versions(BUCKET, objectPath(f.oldKey));
        expect(vs.length, f.label).toBe(1);
        expect(Buffer.compare((vs[0] as { data: Uint8Array }).data, f.bytes), f.label).toBe(0);
      }

      // How each was built, from what the real CLI sent.
      expect(standin.calls("PutObject").length).toBe(2);
      expect(standin.calls("CreateMultipartUpload").length).toBe(2);
      const parts = standin.calls("UploadPart");
      expect(parts.map((p) => p.size).sort()).toEqual([8 * MIB, e.bytes.length].sort());
      // A part carries a checksum header: real S3 refuses a part of a lock-created upload without one.
      for (const p of parts) expect(p.checksum, "part checksum header").toBe(true);
      const copies = standin.calls("UploadPartCopy");
      expect(copies.length).toBe(1);
      expect(copies[0]?.range).toBe(`bytes=${8 * MIB}-${c.bytes.length - 1}`);
      expect(copies[0]?.ifMatch).toBe(standin.current(BUCKET, objectPath(c.oldKey))?.etag);
      expect(standin.calls("CompleteMultipartUpload").length).toBe(2);
      expect(standin.openUploads()).toBe(0);

      expect(leaksAName(`${r.all}\n${dirText(dir)}`)).toBeNull();
    },
    SLOW,
  );

  lane(
    "copy parts tile the rest of the object with no gap and no overlap",
    async (standin) => {
      const c = fixtureC();
      const dir = await planned(standin, [c]);
      standin.log.length = 0;
      // 6 MiB parts: the 12 MiB and 123 bytes after the patched first part are three copies,
      // the last one the 123-byte remainder (a final part may be any size).
      const r = await run(standin, assembleArgs(dir, ["--max-part-bytes", String(6 * MIB)]));
      expect(r.exitCode, r.all).toBe(0);
      const copies = standin.calls("UploadPartCopy");
      expect(copies.map((x) => x.range)).toEqual([
        `bytes=${8 * MIB}-${14 * MIB - 1}`,
        `bytes=${14 * MIB}-${20 * MIB - 1}`,
        `bytes=${20 * MIB}-${c.bytes.length - 1}`,
      ]);
      expect(copies.map((x) => x.partNumber)).toEqual([2, 3, 4]);
      const made = newObject(standin, c);
      expect(Buffer.compare((made as { data: Uint8Array }).data, c.expected as Uint8Array)).toBe(0);
      expect(sha256((made as { data: Uint8Array }).data)).toBe(parseKey(c.newKey as string).sha256);
    },
    SLOW,
  );

  lane(
    "a second run changes nothing: existing objects are recognized and skipped",
    async (standin) => {
      const [a, c] = [fixtureA(), fixtureC()];
      const dir = await planned(standin, [a, c]);
      const first = await run(standin, assembleArgs(dir));
      expect(first.exitCode, first.all).toBe(0);
      const sha = fileSha256(dir, "assembled.json");
      const versionsBefore = [a, c].map(
        (f) => standin.versions(BUCKET, objectPath(f.newKey as string)).length,
      );

      standin.log.length = 0;
      const again = await run(standin, assembleArgs(dir));
      expect(again.exitCode, again.all).toBe(0);
      expect(again.stdout).toContain("put=0 multipart=0 skipped=2");
      for (const op of [
        "PutObject",
        "CreateMultipartUpload",
        "UploadPart",
        "UploadPartCopy",
        "CompleteMultipartUpload",
        "DeleteObject",
        "DeleteObjects",
      ] as const) {
        expect(standin.calls(op).length, op).toBe(0);
      }
      expect(fileSha256(dir, "assembled.json")).toBe(sha);
      expect(
        [a, c].map((f) => standin.versions(BUCKET, objectPath(f.newKey as string)).length),
      ).toEqual(versionsBefore);
    },
    SLOW,
  );

  lane(
    "a source that changes under a part copy fails the copy, aborts the upload and leaves no object",
    async (standin) => {
      const c = fixtureC();
      const dir = await planned(standin, [c]);
      standin.log.length = 0;
      // Just before the first UploadPartCopy, someone replaces the source with new content.
      const swapped = c.bytes.slice();
      swapped[5000] = (swapped[5000] as number) ^ 0xff;
      let swappedId = "";
      standin.beforeOp("UploadPartCopy", () => {
        swappedId = standin.putObject(BUCKET, objectPath(c.oldKey), swapped);
      });

      const r = await run(standin, assembleArgs(dir));
      expect(r.exitCode, r.all).toBe(1);
      expect(r.stdout).toContain("UploadPartCopy:precondition-failed");
      expect(standin.calls("UploadPartCopy")[0]?.status).toBe(412);
      expect(standin.calls("AbortMultipartUpload").length).toBe(1);
      expect(standin.calls("CompleteMultipartUpload").length).toBe(0);
      expect(standin.openUploads()).toBe(0);
      expect(standin.versions(BUCKET, objectPath(c.newKey as string)).length).toBe(0);
      expect(has(dir, "assembled.json")).toBe(false);
      expect(has(dir, "keymap.json")).toBe(false);

      // Put the source back as it was; a re-run resumes and finishes.
      standin.dropVersion(BUCKET, objectPath(c.oldKey), swappedId);
      const again = await run(standin, assembleArgs(dir));
      expect(again.exitCode, again.all).toBe(0);
      expect(
        Buffer.compare(
          (newObject(standin, c) as { data: Uint8Array }).data,
          c.expected as Uint8Array,
        ),
      ).toBe(0);
    },
    SLOW,
  );

  lane(
    "a failure at completion aborts the upload, writes nothing, and a re-run finishes",
    async (standin) => {
      const e = fixtureE();
      const dir = await planned(standin, [e]);
      standin.log.length = 0;
      standin.inject("CompleteMultipartUpload", { code: "InternalError", status: 500, times: 1 });

      const r = await run(standin, assembleArgs(dir));
      expect(r.exitCode, r.all).toBe(1);
      expect(r.stdout).toContain("CompleteMultipartUpload:failed");
      expect(standin.calls("AbortMultipartUpload").length).toBe(1);
      expect(standin.openUploads()).toBe(0);
      expect(standin.versions(BUCKET, objectPath(e.newKey as string)).length).toBe(0);
      expect(has(dir, "assembled.json")).toBe(false);

      standin.clearFaults();
      const again = await run(standin, assembleArgs(dir));
      expect(again.exitCode, again.all).toBe(0);
      expect(
        Buffer.compare(
          (newObject(standin, e) as { data: Uint8Array }).data,
          e.expected as Uint8Array,
        ),
      ).toBe(0);
    },
    SLOW,
  );

  lane(
    "an object already at the new key is kept unless it is exactly what assembly makes",
    async (standin) => {
      const a = fixtureA();
      const dir = await planned(standin, [a]);
      const at = objectPath(a.newKey as string);
      const decade = new Date(Date.now() + 10 * 365 * 24 * 3600 * 1000);
      const squatters: Array<[string, Uint8Array, Date | undefined]> = [
        ["unrelated bytes, no lock", new Uint8Array(a.bytes.length).fill(9), undefined],
        // The case that matters most: the unscrubbed original under the scrubbed key.
        ["the original bytes, locked", a.bytes, centuryFromNow()],
        ["the right bytes, no lock", a.expected as Uint8Array, undefined],
        ["the right bytes, a ten-year lock", a.expected as Uint8Array, decade],
      ];
      for (const [label, bytes, lockUntil] of squatters) {
        const id = standin.putObject(BUCKET, at, bytes, { lockUntil });
        const r = await run(standin, assembleArgs(dir));
        expect(r.exitCode, `${label}: ${r.all}`).toBe(1);
        expect(r.stdout, label).toContain("new-key-conflict");
        const vs = standin.versions(BUCKET, at);
        expect(vs.length, label).toBe(1);
        expect(Buffer.compare((vs[0] as { data: Uint8Array }).data, bytes), label).toBe(0);
        expect(standin.calls("PutObject").length, label).toBe(0);
        expect(has(dir, "assembled.json"), label).toBe(false);
        standin.dropVersion(BUCKET, at, id);
      }
    },
    SLOW,
  );

  lane(
    "refuses unless hashes and patches cover every key that needs a scrub",
    async (standin) => {
      const a = fixtureA();
      // Same size and extension as A, different content: a legal target for a bad mapping.
      const a2 = makeFixture(
        "A2",
        ".edf",
        "sub-08/eeg/sub-08_task-rest_eeg.edf",
        edfFile(
          edfHeader({
            patient: "P0043 F 04-AUG-1972 Persephone_Ashworth",
            recording: "Startdate 02-FEB-2020 X X X",
          }),
          a.bytes.length,
          12,
        ),
        { patient: "X X X X" },
      );
      const dir = await planned(standin, [a, a2]);
      type Hashes = {
        version: 1;
        dataset: string;
        entries: Record<string, { newKey: string; size: number; sourceSha256Verified: boolean }>;
      };
      const good = readJson<Hashes>(dir, "hashes.json");
      const before = standin.log.length;
      const refuse = async (word: string, hashes?: unknown) => {
        if (hashes === undefined) rmSync(path.join(dir, "hashes.json"), { force: true });
        else writeJson(dir, "hashes.json", hashes);
        const r = await run(standin, assembleArgs(dir));
        expectStopped(r, 3, word);
        expect(has(dir, "assembled.json"), word).toBe(false);
      };

      const missing = structuredClone(good);
      delete missing.entries[a2.oldKey];
      await refuse("hashes-incomplete", missing);

      const unverified = structuredClone(good);
      (unverified.entries[a.oldKey] as { sourceSha256Verified: boolean }).sourceSha256Verified =
        false;
      await refuse("source-not-verified", unverified);

      await refuse("hashes-wrong-dataset", { ...good, dataset: "xx090999" });

      // A replacement that is another key's original is a chain, never a scrub.
      const chained = structuredClone(good);
      (chained.entries[a.oldKey] as { newKey: string }).newKey = a2.oldKey;
      await refuse("new-key-is-an-old-key", chained);

      // Two originals cannot share a replacement.
      const shared = structuredClone(good);
      (shared.entries[a2.oldKey] as { newKey: string }).newKey = (
        shared.entries[a.oldKey] as { newKey: string }
      ).newKey;
      await refuse("duplicate-new-key", shared);

      // A replacement equal to its own original changed nothing: the contract refuses it.
      const same = structuredClone(good);
      (same.entries[a.oldKey] as { newKey: string }).newKey = a.oldKey;
      await refuse("hashes.json-invalid", same);

      await refuse("hashes.json-missing");

      writeJson(dir, "hashes.json", good);
      const patches = readJson<Record<string, string>>(dir, "patches.json");
      const { [a.oldKey]: _dropped, ...rest } = patches;
      writeJson(dir, "patches.json", rest);
      // A patches.json the plan does not name is refused before anything is read from it.
      expectStopped(await run(standin, assembleArgs(dir)), 3, "patches-stale");
      // Named by the plan, and still short of a key that needs a scrub.
      rebindPatches(dir);
      const noPatch = await run(standin, assembleArgs(dir));
      expectStopped(noPatch, 3, "patches-incomplete");

      // Every refusal happened before a single S3 call.
      expect(standin.log.length).toBe(before);
    },
    SLOW,
  );

  lane(
    "a source that has gone missing since the plan fails by name",
    async (standin) => {
      const a = fixtureA();
      const dir = await planned(standin, [a]);
      const [only] = standin.versions(BUCKET, objectPath(a.oldKey));
      standin.dropVersion(BUCKET, objectPath(a.oldKey), (only as { versionId: string }).versionId);
      const r = await run(standin, assembleArgs(dir));
      expect(r.exitCode, r.all).toBe(1);
      expect(r.stdout).toContain("source-missing");
      expect(standin.calls("PutObject").length).toBe(0);
    },
    SLOW,
  );
});

describe("assemble: a hash is good only for the patch it was computed for", () => {
  lane(
    "refuses hashes bound to another patch, in the dry run too, and a file with no binding",
    async (standin) => {
      const [a, b] = [fixtureA(), fixtureB()];
      const dir = await planned(standin, [a, b]);
      const patches = readJson<Record<string, string>>(dir, "patches.json");
      const hashes = readJson<HashesFile>(dir, "hashes.json");

      // patches.json now holds another scrub for A; hashes.json is still bound to the first.
      const other = Buffer.from(
        withFields(a.bytes, { patient: "X X X X", recording: "Startdate X X X X" }).subarray(
          0,
          256,
        ),
      );
      writeJson(dir, "patches.json", { ...patches, [a.oldKey]: other.toString("hex") });
      rebindPatches(dir); // as the re-plan that wrote it would have
      for (const flag of [[], ["--execute"]]) {
        const r = await run(standin, ["assemble", "--dir", dir, ...flag]);
        expectStopped(r, 3, "hashes-stale", flag.length ? "execute" : "dry run");
      }

      // The binding itself altered, with the right patch in place.
      writeJson(dir, "patches.json", patches);
      rebindPatches(dir);
      const altered = structuredClone(hashes);
      (altered.entries[b.oldKey] as { patchSha256: string }).patchSha256 = "0".repeat(64);
      writeJson(dir, "hashes.json", altered);
      expectStopped(await run(standin, assembleArgs(dir)), 3, "hashes-stale");

      // No binding at all is not a hashes.json this contract accepts.
      const unbound = structuredClone(hashes);
      for (const e of Object.values(unbound.entries)) {
        (e as { patchSha256?: string }).patchSha256 = undefined;
      }
      writeJson(dir, "hashes.json", unbound);
      expectStopped(await run(standin, assembleArgs(dir)), 3, "hashes.json-invalid");

      expect(standin.calls("PutObject").length).toBe(0);
      expect(standin.calls("CreateMultipartUpload").length).toBe(0);
      expect(has(dir, "assembled.json")).toBe(false);

      // The matching pair assembles.
      writeJson(dir, "hashes.json", hashes);
      const ok = await run(standin, assembleArgs(dir));
      expect(ok.exitCode, ok.all).toBe(0);
    },
    SLOW,
  );
});

describe("assemble: the checksum a locked write needs", () => {
  lane(
    "put-object and every part carry one whatever the operator's environment asks for",
    async (standin) => {
      const [a, c] = [fixtureA(), fixtureC()];
      const dir = await planned(standin, [a, c]);
      standin.log.length = 0;
      const r = await run(standin, assembleArgs(dir), {
        AWS_REQUEST_CHECKSUM_CALCULATION: "when_required",
      });
      expect(r.exitCode, r.all).toBe(0);
      const puts = standin.calls("PutObject");
      expect(puts.length).toBe(1);
      expect([puts[0]?.status, puts[0]?.checksum]).toEqual([200, true]);
      const parts = standin.calls("UploadPart");
      expect(parts.length).toBe(1);
      expect([parts[0]?.status, parts[0]?.checksum]).toEqual([200, true]);
    },
    SLOW,
  );
});

describe("assemble: what a failure leaves behind is said by key and upload id (S1, T6)", () => {
  lane(
    "an abort that fails after a part failed names the key and the upload id",
    async (standin) => {
      const e = fixtureE();
      const dir = await planned(standin, [e]);
      standin.inject("UploadPart", { code: "InternalError", status: 500 });
      standin.inject("AbortMultipartUpload", { code: "InternalError", status: 500 });
      const r = await run(standin, assembleArgs(dir));
      expect(r.exitCode, r.all).toBe(1);
      expect(r.stdout).toContain("UploadPart:failed+abort-failed=1");
      expect(r.stdout).toMatch(
        new RegExp(
          `abort-failed key=${(e.newKey as string).replace(/\./g, "\\.")} uploadId=upload-standin-v\\d+ \\(AbortMultipartUpload:failed\\)`,
        ),
      );
      expect(standin.openUploads()).toBe(1);
    },
    SLOW,
  );

  lane(
    "a create whose answer was lost leaves an upload that is found and reported",
    async (standin) => {
      const e = fixtureE();
      const dir = await planned(standin, [e]);
      // S3 created the upload; the answer never arrived.
      standin.inject("CreateMultipartUpload", {
        code: "InternalError",
        status: 500,
        applied: true,
        times: 1,
      });
      const r = await run(standin, assembleArgs(dir));
      expect(r.exitCode, r.all).toBe(1);
      expect(standin.openUploads()).toBe(1);
      expect(r.stdout).toContain("CreateMultipartUpload:failed+upload-may-be-open=1");
      expect(r.stdout).toMatch(
        new RegExp(
          `open upload left by a failed create: key=${(e.newKey as string).replace(/\./g, "\\.")} uploadId=upload-standin-v\\d+`,
        ),
      );
    },
    SLOW,
  );

  lane(
    "a single put reads its source pinned to the ETag it saw: a change in between fails it",
    async (standin) => {
      const a = fixtureA();
      const dir = await planned(standin, [a]);
      // Between the HEAD of the source and the read of its bytes, the source changes.
      standin.beforeOp(
        "GetObject",
        () => {
          const other = a.bytes.slice();
          other[1000] ^= 0xff;
          standin.putObject(BUCKET, objectPath(a.oldKey), other, { lockUntil: centuryFromNow() });
        },
        standin.opCount("GetObject") + 1,
      );
      const r = await run(standin, assembleArgs(dir));
      expect(r.exitCode, r.all).toBe(1);
      expect(r.stdout).toContain("GetObject:precondition-failed=1");
      expect(standin.calls("PutObject").length).toBe(0);
      expect(standin.versions(BUCKET, objectPath(a.newKey as string)).length).toBe(0);
    },
    SLOW,
  );
});
