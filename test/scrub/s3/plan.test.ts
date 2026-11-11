/**
 * The plan stage, run as the real CLI against the S3 stand-in: which keys it finds, what it
 * reads, what it writes, and that it stops (exit 4) rather than plan over data it could not read.
 */

import { afterAll, beforeAll, describe, expect } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { parsePatches, parsePlan } from "../../../scripts/scrub/contract";
import { buildKey } from "../../../scripts/scrub/contract";
import type { PlanFile } from "../../../scripts/scrub/contract";
import { type S3Standin, startS3Standin } from "../helpers/s3-standin";
import { makeJobPool, makeLimiter, settleAll } from "./concurrency";
import { expectStopped } from "./refusal";
import {
  BUCKET,
  DATASET,
  SLOW,
  assembleArgs,
  deleteRequests,
  dirText,
  edfFile,
  edfHeader,
  fileSha256,
  fixtureA,
  fixtureB,
  fixtureD,
  fixtureE,
  has,
  leaksAName,
  makeFixture,
  objectPath,
  planArgs,
  readJson,
  removeTempDirs,
  runScrub,
  seedManifest,
  seedObject,
  sha256,
  tempDir,
  verifyArgs,
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

const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

describe("plan", () => {
  lane(
    "finds only the EDF and BDF keys of the manifests, reads headers, writes no value",
    async (standin) => {
      // Two entries per page: the CLI must follow every page of every listing.
      standin.setPageSize(2);
      const a = fixtureA();
      const b = fixtureB();
      const d = fixtureD();
      const e = fixtureE();
      // A has an older version, a delete marker and a current version: three ids to record.
      const aIds = seedObject(standin, a, { olderVersions: 1, marker: true });
      seedObject(standin, b);
      seedObject(standin, d);
      seedManifest(standin, "v1.0.0", [a, d], {
        // A file the scrub does not read.
        "sub-01/eeg/sub-01_photo.fif": { key: `SHA256E-s10--${"a".repeat(64)}.fif`, size: 10 },
      });
      seedManifest(standin, "v1.0.1", [a, b]);
      // The summary file is not a manifest: its key must never reach the plan.
      seedManifest(standin, "v1.0.0-summary", [e]);
      // So is the records file the enrichment job writes: a JSON array, which parses as no manifest.
      standin.putObject(
        BUCKET,
        `${DATASET}/version/v1.0.0-records.json`,
        new TextEncoder().encode(JSON.stringify([{ doc_type: "recording" }])),
      );

      const dir = tempDir("plan");
      const r = await run(standin, planArgs(dir));
      expect(r.exitCode, r.all).toBe(0);

      const plan = parsePlan(JSON.stringify(readJson(dir, "plan.json")));
      expect(plan.tags).toEqual(["v1.0.0", "v1.0.1"]);
      expect(plan.partial).toBeUndefined();
      expect(plan.dataset).toBe(DATASET);
      expect(plan.bucket).toBe(BUCKET);
      expect(plan.keys.map((k) => k.oldKey).sort()).toEqual([a.oldKey, b.oldKey, d.oldKey].sort());
      expect(plan.keys.map((k) => k.oldKey)).not.toContain(e.oldKey);

      const byKey = Object.fromEntries(plan.keys.map((k) => [k.oldKey, k]));
      const pa = byKey[a.oldKey];
      const pb = byKey[b.oldKey];
      const pd = byKey[d.oldKey];
      expect(pa?.needsScrub).toBe(true);
      expect(pb?.needsScrub).toBe(true);
      expect(pd?.needsScrub).toBe(false);
      expect(pd?.reasons).toEqual([]);
      expect([pa?.status, pb?.status, pd?.status]).toEqual(["read", "read", "read"]);
      // Reasons are fixed finding kinds, never text from a header.
      for (const k of [pa, pb]) {
        expect(k?.reasons.length).toBeGreaterThan(0);
        for (const reason of k?.reasons ?? []) expect(reason).toMatch(/^[a-z]+(-[a-z]+)+$/);
      }
      // Every version id and the marker, for the delete stage.
      expect([...(pa?.versionIds ?? [])].sort()).toEqual([...aIds].sort());
      expect(pb?.versionIds.length).toBe(1);
      expect(pa?.size).toBe(a.bytes.length);

      expect(plan.totals).toEqual({
        keys: 3,
        needScrub: 2,
        bytesToHash: a.bytes.length + b.bytes.length,
        unreadable: 0,
      });
      // The raw counts are on the line when there is none, so a plan says "none" rather than nothing.
      expect(r.stdout.trim()).toBe(
        `plan: tags=2 keys=3 needScrub=2 bytesToHash=${a.bytes.length + b.bytes.length} unreadable=0 rawCopies=0 versions=0 markers=0`,
      );
      // And a plan without raw copies is the file it was: no rawCopies, no raw totals.
      expect(Object.keys(readJson<Record<string, unknown>>(dir, "plan.json"))).not.toContain(
        "rawCopies",
      );

      // Patches: the scrubbed header as hex, only for the keys that need one.
      const patches = parsePatches(JSON.stringify(readJson(dir, "patches.json")));
      expect(Object.keys(patches).sort()).toEqual([a.oldKey, b.oldKey].sort());
      expect(patches[a.oldKey]).toBe(toHex((a.expected as Uint8Array).subarray(0, 256)));
      expect(patches[b.oldKey]).toBe(toHex((b.expected as Uint8Array).subarray(0, 256)));

      // No participant value anywhere it could have been printed or written.
      expect(leaksAName(`${r.all}\n${dirText(dir)}`)).toBeNull();

      // Read-only: lists, heads and reads, and each header read asked for exactly 8192 bytes.
      const ops = new Set<string>(standin.log.map((x) => x.op));
      expect([...ops].sort()).toEqual(
        ["GetObject", "HeadObject", "ListObjectVersions", "ListObjectsV2"].sort(),
      );
      const ranged = standin.calls("GetObject").filter((x) => x.range !== undefined);
      expect(ranged.length).toBe(3);
      for (const c of ranged) expect(c.range).toBe("bytes=0-8191");
      // Neither sibling was ever fetched.
      for (const sibling of ["v1.0.0-summary.json", "v1.0.0-records.json"]) {
        expect(
          standin.calls("GetObject").some((x) => x.key === `${DATASET}/version/${sibling}`),
          sibling,
        ).toBe(false);
      }
    },
    SLOW,
  );

  lane(
    "--tags reads only the manifests named, marks the plan partial, and no later stage runs on it",
    async (standin) => {
      const a = fixtureA();
      const b = fixtureB();
      const d = fixtureD();
      for (const f of [a, b, d]) seedObject(standin, f);
      seedManifest(standin, "v1.0.0", [a, d]);
      seedManifest(standin, "v1.0.1", [a, b]);
      const dir = tempDir("plan-tags");
      const r = await run(standin, planArgs(dir, ["--tags", "v1.0.1"]));
      expect(r.exitCode, r.all).toBe(0);
      const plan = readJson<PlanFile>(dir, "plan.json");
      expect(plan.tags).toEqual(["v1.0.1"]);
      expect(plan.partial).toBe(true);
      expect(r.stdout).toContain("partial");
      // D is in no manifest that was read, but it is in the bucket: the objects are listed too.
      expect(plan.keys.map((k) => k.oldKey).sort()).toEqual([a.oldKey, b.oldKey, d.oldKey].sort());
      // Naming tags skips discovery: version/ is never listed; objects/ is listed, versions and
      // markers included (a recording masked by a delete marker still holds its bytes).
      expect(standin.calls("ListObjectsV2")).toEqual([]);
      expect(
        standin.calls("ListObjectVersions").filter((c) => c.key === `${DATASET}/objects/`).length,
      ).toBe(1);
      expect(
        standin.calls("GetObject").some((c) => c.key === `${DATASET}/version/v1.0.0.json`),
      ).toBe(false);

      // A partial plan is never carried further, however complete the rest looks.
      writeHashes(dir, [a, b, d]);
      for (const extra of [[], ["--execute"]]) {
        expectStopped(await run(standin, ["assemble", "--dir", dir, ...extra]), 3, "plan-partial");
      }
      expect(has(dir, "assembled.json")).toBe(false);
      expectStopped(await run(standin, verifyArgs(dir)), 3, "plan-partial");
      const del = await run(standin, [
        "delete-old",
        "--dir",
        dir,
        "--confirm-dataset",
        DATASET,
        "--public-base",
        "http://127.0.0.1:9",
      ]);
      expectStopped(del, 3, "plan-partial");
      expect(standin.calls("PutObject").length).toBe(0);
      expect(deleteRequests(standin)).toBe(0);
    },
    SLOW,
  );

  lane(
    "also plans every EDF or BDF under objects/ that no manifest names, in any letter case",
    async (standin) => {
      standin.setPageSize(2);
      const named = fixtureA();
      // On the bucket and in no manifest: a file a later version dropped.
      const dropped = fixtureB();
      const upper = makeFixture(
        "U",
        ".EDF",
        "sub-07/eeg/sub-07_eeg.EDF",
        edfFile(
          edfHeader({ patient: "P0007 F 01-JAN-1970 Thistlewood_Marigold", recording: "X" }),
          3000,
          7,
        ),
        { patient: "X X X X" },
      );
      const mixed = makeFixture(
        "M",
        ".Bdf",
        "sub-08/eeg/sub-08_eeg.Bdf",
        edfFile(
          edfHeader({
            family: "bdf",
            patient: "P0008 M 02-FEB-1971 Bellweather_Hieronymus",
            recording: "X",
          }),
          3100,
          8,
        ),
        { patient: "X X X X" },
      );
      for (const f of [named, dropped, upper, mixed]) seedObject(standin, f);
      // Objects that are not recordings are not planned.
      standin.putObject(BUCKET, objectPath(`SHA256E-s5--${"a".repeat(64)}.fif`), new Uint8Array(5));
      standin.putObject(
        BUCKET,
        objectPath(`SHA256E-s5--${"b".repeat(64)}.edf.gz`),
        new Uint8Array(5),
      );
      standin.putObject(BUCKET, objectPath(`SHA256E-s5--${"c".repeat(64)}`), new Uint8Array(5));
      seedManifest(standin, "v1.0.0", [named]);

      const dir = tempDir("plan-objects");
      const r = await run(standin, planArgs(dir));
      expect(r.exitCode, r.all).toBe(0);
      const plan = readJson<PlanFile>(dir, "plan.json");
      expect(plan.keys.map((k) => k.oldKey).sort()).toEqual(
        [named, dropped, upper, mixed].map((f) => f.oldKey).sort(),
      );
      expect(plan.keys.every((k) => k.status === "read" && k.needsScrub)).toBe(true);
      expect(Object.keys(readJson(dir, "patches.json")).sort()).toEqual(
        [named, dropped, upper, mixed].map((f) => f.oldKey).sort(),
      );
      expect(plan.totals.keys).toBe(4);
      // The listing of objects/ followed every page of a two-entry page size.
      expect(
        standin.calls("ListObjectVersions").filter((c) => c.key === `${DATASET}/objects/`).length,
      ).toBeGreaterThan(2);
      expect(leaksAName(`${r.all}\n${dirText(dir)}`)).toBeNull();
    },
    SLOW,
  );

  job(
    "an object named in the annex key space that is not an annex key stops the plan, any extension",
    async () => {
      // A raw recording stored by its path (`notes.EDF`) is a raw copy now, planned and recorded
      // (raw-copies.test.ts); a name that claims to be an annex key and is not one is still
      // a stop, because nothing can say what it holds.
      const names = [
        `SHA256E-s5--${"a".repeat(63)}.edf`,
        `SHA256E-s5--${"A".repeat(64)}.bdf`,
        `SHA256E-sx--${"a".repeat(64)}.json`,
        "SHA256E-",
      ];
      // Each name has its own stand-in and directory, so they run side by side (`run` bounds them).
      await settleAll(
        names.map(async (name) => {
          const standin = startS3Standin();
          try {
            const a = fixtureA();
            seedObject(standin, a);
            seedManifest(standin, "v1.0.0", [a]);
            standin.putObject(BUCKET, objectPath(name), new Uint8Array(5));
            const dir = tempDir("plan-objects-bad");
            const r = await run(standin, planArgs(dir));
            expectStopped(r, 4, "objects-bad-key", name);
            expect(has(dir, "plan.json"), name).toBe(false);
          } finally {
            standin.stop();
          }
        }),
      );
    },
    SLOW,
  );

  lane(
    "a recording kept inline in git is recorded as unreadable, once, and the plan is incomplete",
    async (standin) => {
      const a = fixtureA();
      seedObject(standin, a);
      const inline = `git:${"b".repeat(40)}`;
      const inline2 = `git:${"c".repeat(64)}`;
      seedManifest(standin, "v1.0.0", [a], {
        "sub-06/eeg/sub-06_task-rest_eeg.edf": { key: inline, size: 5 },
        // The same blob under a second name, and a non-recording kept in git: neither adds an entry.
        "sub-06/eeg/sub-06_copy_eeg.EDF": { key: inline, size: 5 },
        "sub-06/sub-06_notes.txt": { key: `git:${"d".repeat(40)}`, size: 5 },
      });
      seedManifest(standin, "v1.0.1", [a], {
        "sub-06/eeg/sub-06_task-rest_eeg.edf": { key: inline, size: 5 },
        "sub-10/eeg/sub-10_eeg.bdf": { key: inline2, size: 5 },
      });
      const dir = tempDir("plan-inline");
      const r = await run(standin, planArgs(dir));
      expect(r.exitCode, r.all).toBe(4);
      const plan = parsePlan(JSON.stringify(readJson(dir, "plan.json")));
      const inlineEntries = plan.keys.filter((k) => k.oldKey.startsWith("git:"));
      expect(inlineEntries.map((k) => k.oldKey).sort()).toEqual([inline, inline2].sort());
      for (const k of inlineEntries) {
        expect(k.status).toBe("unreadable");
        expect(k.reasons).toEqual(["git-inline-recording"]);
        expect(k.needsScrub).toBe(false);
      }
      expect(plan.totals.unreadable).toBe(2);
      expect(plan.totals.keys).toBe(3);
      expect(r.stdout).toContain("git-inline-recording=2");
      expect(r.stdout).toContain("incomplete");

      // No later stage runs on this plan.
      writeHashes(dir, [a]);
      expectStopped(await run(standin, assembleArgs(dir)), 3, "plan-has-unreadable");

      // A git: key that is not a blob sha is a manifest the plan cannot account for.
      seedManifest(standin, "v1.0.2", [a], {
        "sub-11/eeg/sub-11_eeg.edf": { key: "git:not-a-sha", size: 5 },
      });
      const dirBad = tempDir("plan-inline-bad");
      expectStopped(await run(standin, planArgs(dirBad)), 4, "manifest-bad-key");
    },
    SLOW,
  );

  job(
    "a file under version/ that is neither a manifest nor a known sibling stops the plan, never skipped",
    async () => {
      const names = ["v1.0.0-final.json", "notes.json", "v1.0.0.json.bak", "v1.0.0-beta.1.json"];
      // Each name has its own stand-in and directory, so they run side by side (`run` bounds them).
      await settleAll(
        names.map(async (name) => {
          const standin = startS3Standin();
          try {
            const a = fixtureA();
            seedObject(standin, a);
            seedManifest(standin, "v1.0.0", [a]);
            standin.putObject(BUCKET, `${DATASET}/version/${name}`, new TextEncoder().encode("{}"));
            const dir = tempDir("plan-unknown");
            const r = await run(standin, planArgs(dir));
            expectStopped(r, 4, "version-dir-unknown-file");
            // Stopped before reading any object, so no header was read and no plan was written.
            expect(standin.calls("GetObject").length, name).toBe(0);
            expect(existsSync(`${dir}/plan.json`), name).toBe(false);
          } finally {
            standin.stop();
          }
        }),
      );
    },
    SLOW,
  );

  lane(
    "a key that cannot be read, or whose size disagrees, exits 4 and is counted, never skipped",
    async (standin) => {
      const good = fixtureA();
      seedObject(standin, good);

      // Listed in a manifest, no object at all.
      const missing = fixtureD();
      // The object is one byte longer than its key says.
      const wrongSize = fixtureB();
      const longer = new Uint8Array(wrongSize.bytes.length + 1);
      longer.set(wrongSize.bytes);
      standin.putObject(BUCKET, objectPath(wrongSize.oldKey), longer);
      // A file named .edf whose header is not an EDF header.
      const junk = new Uint8Array(2000).fill(0x41);
      const junkKey = buildKey(junk.length, sha256(junk), ".edf");
      standin.putObject(BUCKET, objectPath(junkKey), junk);

      seedManifest(standin, "v1.0.0", [good, missing, wrongSize], {
        "sub-09/eeg/sub-09_task-rest_eeg.edf": { key: junkKey, size: junk.length },
      });
      const dir = tempDir("plan-unreadable");
      const r = await run(standin, planArgs(dir));
      expect(r.exitCode, r.all).toBe(4);

      const plan = readJson<PlanFile>(dir, "plan.json");
      expect(plan.totals.unreadable).toBe(3);
      expect(plan.totals.keys).toBe(4);
      expect(plan.totals.needScrub).toBe(1);
      const status = Object.fromEntries(plan.keys.map((k) => [k.oldKey, k]));
      expect(status[missing.oldKey]?.status).toBe("unreadable");
      expect(status[missing.oldKey]?.reasons).toEqual(["HeadObject:not-found"]);
      expect(status[wrongSize.oldKey]?.status).toBe("unreadable");
      expect(status[wrongSize.oldKey]?.reasons).toEqual(["size-mismatch"]);
      expect(status[junkKey]?.status).toBe("unreadable");
      expect(status[junkKey]?.reasons).toEqual(["not-edf"]);
      expect(status[good.oldKey]?.status).toBe("read");
      expect(r.stdout).toContain("unreadable=3");
      expect(r.stdout).toContain("incomplete");
      expect(leaksAName(`${r.all}\n${dirText(dir)}`)).toBeNull();

      // No later stage runs on this plan, even with hashes supplied.
      writeHashes(dir, [good]);
      const asm = await run(standin, assembleArgs(dir));
      expectStopped(asm, 3, "plan-has-unreadable");
    },
    SLOW,
  );

  lane(
    "refuses to plan from a manifest it cannot account for",
    async (standin) => {
      const a = fixtureA();
      seedObject(standin, a);

      // A key the contract cannot carry.
      seedManifest(standin, "v1.0.0", [a], {
        "sub-07/eeg/sub-07_task-rest_eeg.edf": { key: "MD5E-s5--abcdef.edf", size: 5 },
      });
      const dirBad = tempDir("plan-badkey");
      const bad = await run(standin, planArgs(dirBad));
      expectStopped(bad, 4, "manifest-bad-key");
      expect(has(dirBad, "plan.json")).toBe(false);

      // A tag that was asked for and does not exist.
      const dirMissing = tempDir("plan-missing");
      const missing = await run(standin, planArgs(dirMissing, ["--tags", "v9.9.9"]));
      expectStopped(missing, 4, "manifest-missing");

      // A dataset with no manifests at all.
      const dirNone = tempDir("plan-none");
      const none = await run(standin, ["plan", "--dataset", "xx090412", "--out", dirNone]);
      expectStopped(none, 4, "no-manifests");

      // A manifest that is not JSON must not echo what it holds.
      standin.putObject(
        BUCKET,
        `${DATASET}/version/v2.0.0.json`,
        new TextEncoder().encode("Marigold Thistlewood is not json"),
      );
      const dirJunk = tempDir("plan-junk");
      const junk = await run(standin, planArgs(dirJunk, ["--tags", "v2.0.0"]));
      expectStopped(junk, 4, "manifest-malformed");
      expect(leaksAName(junk.all)).toBeNull();
    },
    SLOW,
  );

  lane(
    "a manifest of another dataset, and an existing assembly, are refused",
    async (standin) => {
      const a = fixtureA();
      seedObject(standin, a);
      standin.putObject(
        BUCKET,
        `${DATASET}/version/v1.0.0.json`,
        new TextEncoder().encode(JSON.stringify({ dataset_id: "xx090999", files: {} })),
      );
      const dir = tempDir("plan-wrong");
      const wrong = await run(standin, planArgs(dir));
      expectStopped(wrong, 4, "manifest-wrong-dataset");

      seedManifest(standin, "v1.0.0", [a]);
      writeJson(dir, "assembled.json", {
        version: 1,
        dataset: DATASET,
        bucket: BUCKET,
        entries: {},
      });
      const again = await run(standin, planArgs(dir));
      expectStopped(again, 3, "assembled-exists");
      expect(has(dir, "plan.json")).toBe(false);
    },
    SLOW,
  );

  lane(
    "usage errors and a long-lived key in the environment are refused before any S3 call",
    async (standin) => {
      const dir = tempDir("plan-usage");
      const noDataset = await run(standin, ["plan", "--out", dir]);
      expect(noDataset.exitCode).toBe(2);
      const badId = await run(standin, ["plan", "--dataset", "nm1", "--out", dir]);
      expect(badId.exitCode).toBe(2);
      const unknown = await run(standin, ["frobnicate"]);
      expect(unknown.exitCode).toBe(2);
      const akia = await run(standin, planArgs(dir), {
        AWS_ACCESS_KEY_ID: "AKIAFAKEFAKEFAKE0001",
      });
      expectStopped(akia, 3, "long-lived-key-in-environment");
      expect(standin.log.length).toBe(0);
    },
    SLOW,
  );

  lane(
    "an aws failure no stage accounted for prints its operation and fixed class, never a message",
    async (standin) => {
      // The listing that discovers the manifests is refused: nothing in the plan stage counts it.
      standin.inject("ListObjectsV2", { code: "AccessDenied", status: 403 });
      const r = await run(standin, planArgs(tempDir("plan-aws-escape")));
      expect(r.exitCode, r.all).toBe(1);
      expect(r.stderr.trim()).toBe("s3-scrub: failed ListObjectsV2:access-denied");
    },
    SLOW,
  );

  lane(
    "an unexpected error names its class only, and SCRUB_S3_DEBUG=1 adds no message or stack",
    async (standin) => {
      const d = fixtureD();
      seedObject(standin, d);
      seedManifest(standin, "v1.0.0", [d]);
      // A working directory it cannot write: the file error's message names the path, and the
      // path carries an invented name, as a real one could.
      const out = path.join(tempDir("plan-debug"), "Marigold-Thistlewood");
      mkdirSync(out, { mode: 0o500 });
      try {
        const r = await run(standin, planArgs(out), { SCRUB_S3_DEBUG: "1" });
        expect(r.exitCode, r.all).toBe(1);
        expect(r.stderr).toContain("s3-scrub: unexpected");
        expect(r.stderr).toContain("message and stack withheld");
        expect(leaksAName(r.all)).toBeNull();
        expect(r.all).not.toContain("EACCES");
        expect(r.all).not.toContain(" at ");
      } finally {
        chmodSync(out, 0o700);
      }
    },
    SLOW,
  );
});

describe("plan: a recording masked by a delete marker (C3)", () => {
  lane(
    "a clean masked recording is planned, read at its newest version, with every version and marker",
    async (standin) => {
      const [a, d] = [fixtureA(), fixtureD()];
      seedObject(standin, a);
      // D: no manifest names it and its current entry is a delete marker.
      const ids = seedObject(standin, d);
      const marker = standin.putDeleteMarker(BUCKET, objectPath(d.oldKey));
      seedManifest(standin, "v1.0.0", [a]);
      const dir = tempDir("plan-masked-clean");
      const r = await run(standin, planArgs(dir));
      expect(r.exitCode, r.all).toBe(0);
      const plan = readJson<PlanFile>(dir, "plan.json");
      const entry = plan.keys.find((k) => k.oldKey === d.oldKey);
      expect(entry, "the masked recording is in the plan").toBeDefined();
      expect(entry?.status).toBe("read");
      expect(entry?.needsScrub).toBe(false);
      expect([...(entry?.versionIds ?? [])].sort()).toEqual([...ids, marker].sort());
      // Its header was read by version id: the current entry is a marker.
      expect(
        standin.calls("GetObject").some((c) => c.key === objectPath(d.oldKey) && c.status === 206),
      ).toBe(true);
    },
    SLOW,
  );

  lane(
    "a masked recording that needs a scrub stops the plan with a word a person acts on",
    async (standin) => {
      const [a, b] = [fixtureA(), fixtureB()];
      seedObject(standin, a);
      const ids = seedObject(standin, b);
      const marker = standin.putDeleteMarker(BUCKET, objectPath(b.oldKey));
      seedManifest(standin, "v1.0.0", [a]);
      const dir = tempDir("plan-masked-dirty");
      const r = await run(standin, planArgs(dir));
      expect(r.exitCode, r.all).toBe(4);
      expect(r.stdout).toContain("masked-needs-scrub=1");
      const plan = readJson<PlanFile>(dir, "plan.json");
      const entry = plan.keys.find((k) => k.oldKey === b.oldKey);
      expect(entry?.status).toBe("unreadable");
      expect(entry?.reasons).toEqual(["masked-needs-scrub"]);
      expect([...(entry?.versionIds ?? [])].sort()).toEqual([...ids, marker].sort());
      expect(leaksAName(`${r.all}\n${dirText(dir)}`)).toBeNull();
    },
    SLOW,
  );

  lane(
    "plan.json names the exact bytes of the patches.json written with it, and leaves no temp file",
    async (standin) => {
      const a = fixtureA();
      seedObject(standin, a);
      seedManifest(standin, "v1.0.0", [a]);
      const dir = tempDir("plan-bound");
      const r = await run(standin, planArgs(dir));
      expect(r.exitCode, r.all).toBe(0);
      expect(readJson<PlanFile>(dir, "plan.json").patchesSha256).toBe(
        fileSha256(dir, "patches.json"),
      );
      expect(readdirSync(dir).sort()).toEqual(["patches.json", "plan.json"]);
    },
    SLOW,
  );
});

describe("plan: a working directory it cannot read is not an empty one (S1)", () => {
  lane(
    "an assembled.json that cannot be checked for is a failure, not a missing file",
    async (standin) => {
      const a = fixtureA();
      seedObject(standin, a);
      seedManifest(standin, "v1.0.0", [a]);
      const dir = tempDir("plan-unreadable-dir");
      chmodSync(dir, 0o000);
      try {
        const r = await run(standin, planArgs(dir));
        expectStopped(r, 1, "assembled.json-unreadable");
        expect(standin.log.length).toBe(0);
      } finally {
        chmodSync(dir, 0o700);
      }
    },
    SLOW,
  );
});
