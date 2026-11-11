/**
 * The delete-old stage, run as the real CLI against the S3 stand-in. It is the one irreversible
 * stage, so most of what is tested here is the ways it must refuse, and that when it does run it
 * removes every version AND delete marker by id with the governance bypass, leaves the new keys
 * alone, and proves the result with a fresh listing.
 *
 * One dataset is carried through plan, hash, assemble and verify once. Each test restores that
 * state and a pristine working directory (`delete-harness.ts`). What must be true before an old
 * key may go is in `delete-preconditions.test.ts`: the two files are one suite, split so CI can
 * run them on different runners.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type AssembledFile, type PlanFile, parseKey } from "../../../scripts/scrub/contract";
import { AwsCliError, deleteVersion } from "../../../scripts/scrub/s3/s3-lib";
import type { DeletedFile } from "../../../scripts/scrub/s3/s3-stages";
import { BATCH_SLOW, makeLimiter, together } from "./concurrency";
import {
  a,
  b,
  cleanStore,
  d,
  dirtyStore,
  firstNewKey,
  makeLanes,
  oldIds,
  useDeleteHarness,
} from "./delete-harness";
import { expectStopped } from "./refusal";
import {
  BUCKET,
  DATASET,
  SLOW,
  addUnreadableKey,
  batchDeleted,
  centuryFromNow,
  deleteRequests,
  edfFile,
  edfHeader,
  has,
  makeFixture,
  objectPath,
  readJson,
  removeTempDirs,
  seedManifest,
  sha256,
  withCtx,
  writeGitVerified,
  writeJson,
} from "./support";

afterAll(removeTempDirs);
useDeleteHarness();

/**
 * The tests of a describe block run together, each in lanes of its own: a stand-in at the shared
 * state, a public endpoint, and a pristine copy of the working directory. Nothing one test does
 * can reach another. At most four stage processes run at a time, whatever the number of
 * tests, because the machine has few cores and the files of the suite run in parallel.
 */
const { run: runScrub, scoped } = makeLanes(makeLimiter(4));

// The tests of a `describe.concurrent` block run together, each in lanes of its own. Blocks that
// follow each other would run as one batch, and the timeout of a test is counted from the start
// of its batch, so a plain `describe` of a test that refuses before any S3 call stands between
// the batches.
describe.concurrent("delete-old: refusals", () => {
  test(
    "refuses a proof that vouches for other bytes than the current assembled.json",
    scoped(async (lane) => {
      const { standin, dir, writeProofs, executeArgs, expectOldIntact } = lane();
      // One byte of whitespace changes the file; both proofs now describe a different file, and
      // both are reported.
      writeFileSync(
        path.join(dir, "assembled.json"),
        `${readFileSync(path.join(dir, "assembled.json"), "utf8")}\n`,
      );
      const stale = await runScrub(standin, executeArgs());
      expectStopped(stale, 3, "verified-stale+new-hash-verified-stale");
      expectOldIntact();

      // The re-hash proof current, verified.json alone stale.
      writeProofs();
      const staleVerified = readJson<{ assembledSha256: string }>(dir, "verified.json");
      staleVerified.assembledSha256 = "0".repeat(64);
      writeJson(dir, "verified.json", staleVerified);
      expectStopped(await runScrub(standin, executeArgs()), 3, "verified-stale", "verified alone");

      // verified.json current, the re-hash proof stale.
      writeProofs();
      const hv = readJson<{ assembledSha256: string }>(dir, "new-hash-verified.json");
      hv.assembledSha256 = "0".repeat(64);
      writeJson(dir, "new-hash-verified.json", hv);
      const staleHash = await runScrub(standin, executeArgs());
      expectStopped(staleHash, 3, "new-hash-verified-stale");

      // Right bytes, wrong dataset; right bytes, wrong count.
      writeProofs();
      const wrongDataset = readJson<Record<string, unknown>>(dir, "verified.json");
      wrongDataset.dataset = "xx090999";
      writeJson(dir, "verified.json", wrongDataset);
      const dataset = await runScrub(standin, executeArgs());
      expectStopped(dataset, 3, "proof-wrong-dataset");

      writeProofs(5);
      const count = await runScrub(standin, executeArgs());
      expectStopped(count, 3, "proof-count-mismatch");
      expectOldIntact();
    }),
    BATCH_SLOW,
  );

  test(
    "refuses when more would be deleted than --max-delete allows",
    scoped(async (lane) => {
      const { standin, dir, writeProofs, executeArgs, expectOldIntact } = lane();
      writeProofs();
      const tight = await runScrub(standin, executeArgs(["--max-delete", "3"]));
      expectStopped(tight, 3, "over-max-delete");
      expectOldIntact();
      expect(has(dir, "deleted.json")).toBe(false);
    }),
    BATCH_SLOW,
  );

  test(
    "a version written to an old key after the plan is refused, and no --max-delete waives it",
    scoped(async (lane) => {
      await together([
        async () => {
          const { standin, dir, writeProofs, deleteArgs, versionIdsOf } = lane();
          writeProofs();
          // A version appeared on an old key after the plan recorded its ids: bytes nobody read.
          const extra = standin.putObject(BUCKET, objectPath(a.oldKey), a.bytes, {
            lockUntil: centuryFromNow(),
          });
          // The plan recorded the ids of the two keys being replaced (D, the clean file, is not
          // one).
          const recorded = readJson<PlanFile>(dir, "plan.json")
            .keys.filter((k) => k.oldKey === a.oldKey || k.oldKey === b.oldKey)
            .reduce((n, k) => n + k.versionIds.length, 0);
          expect(recorded).toBe(6);
          // The extra version also takes the count past the plan's own, so the cap refuses as
          // well. Every run refuses and changes nothing, so the four run at once.
          const both = "version-not-in-plan+over-max-delete";
          await together(
            [[], ["--execute"]].flatMap((flag) => [
              async () => expectStopped(await runScrub(standin, deleteArgs(flag)), 3, both),
              async () => {
                // Naming a larger number used to be the way past this; it is only a cap now.
                const raised = await runScrub(
                  standin,
                  deleteArgs([...flag, "--max-delete", String(recorded + 100)]),
                );
                expectStopped(raised, 3, both, "with --max-delete raised");
                expect(raised.stdout).toContain(
                  "1 versions or markers of old keys are not in the plan",
                );
                expect(raised.stdout).toContain(
                  "refused over-max-delete: versions+markers=7 over limit=6",
                );
              },
            ]),
          );
          expect(deleteRequests(standin)).toBe(0);
          expect(versionIdsOf(a.oldKey)).toContain(extra);
        },
        async () => {
          // Swapping a recorded id for an unrecorded one keeps the count and is refused all the
          // same.
          const { standin, dir, writeProofs, deleteArgs, expectOldIntact } = lane();
          writeProofs();
          const plan = readJson<PlanFile>(dir, "plan.json");
          const entry = plan.keys.find((k) => k.oldKey === a.oldKey) as PlanFile["keys"][number];
          entry.versionIds = [...entry.versionIds.slice(1), "standin-v-not-a-real-id"];
          writeFileSync(path.join(dir, "plan.json"), JSON.stringify(plan));
          writeGitVerified(dir); // the git proof names the plan's bytes
          expectStopped(await runScrub(standin, deleteArgs()), 3, "version-not-in-plan", "swapped");
          expectOldIntact();
        },
      ]);
    }),
    BATCH_SLOW,
  );

  test(
    "refuses an assembly in which an old key is, or becomes, a new key",
    scoped(async (lane) => {
      const { standin, dir, writeProofs, executeArgs, expectOldIntact } = lane();
      const full = readJson<AssembledFile>(dir, "assembled.json");
      const withEntries = (mutate: (e: AssembledFile["entries"]) => void, count = 2) => {
        const copy = structuredClone(full);
        mutate(copy.entries);
        writeJson(dir, "assembled.json", copy);
        writeProofs(count);
      };
      const entryOf = (newKey: string) => ({
        ...(full.entries[a.oldKey] as AssembledFile["entries"][string]),
        newKey,
      });

      // An entry whose replacement is itself, or another entry's original of another size: the
      // contract refuses both before the stage looks at the set.
      withEntries((e) => {
        (e[a.oldKey] as { newKey: string }).newKey = a.oldKey;
      });
      expectStopped(await runScrub(standin, executeArgs()), 3, "assembled.json-invalid");
      withEntries((e) => {
        (e[a.oldKey] as { newKey: string }).newKey = b.oldKey;
      });
      expectStopped(await runScrub(standin, executeArgs()), 3, "assembled.json-invalid");

      // Keys of one size and extension, so each entry is well formed and only the set is wrong.
      // The two added entries are also outside the plan and the keymap, which is reported too.
      const k = (c: string) => `SHA256E-s500--${c.repeat(64)}.edf`;
      // One entry's replacement is another entry's original.
      withEntries((e) => {
        e[k("1")] = entryOf(k("2"));
        e[k("2")] = entryOf(k("3"));
      }, 4);
      const chained = await runScrub(standin, executeArgs());
      expectStopped(chained, 3, "old-key-is-a-new-key+assembled-not-in-plan+keymap-mismatch");

      // Two originals share one replacement.
      withEntries((e) => {
        e[k("1")] = entryOf(k("3"));
        e[k("2")] = entryOf(k("3"));
      }, 4);
      const shared = await runScrub(standin, executeArgs());
      expectStopped(shared, 3, "duplicate-new-key+assembled-not-in-plan+keymap-mismatch");
      expectOldIntact();
    }),
    BATCH_SLOW,
  );

  test(
    "refuses when a replacement object is no longer there",
    scoped(async (lane) => {
      const { standin, dir, writeProofs, executeArgs, expectOldIntact } = lane();
      writeProofs();
      const entry = (
        readJson<AssembledFile>(dir, "assembled.json").entries[a.oldKey] as {
          newVersionId: string;
        }
      ).newVersionId;
      standin.dropVersion(BUCKET, objectPath(a.newKey as string), entry);
      const r = await runScrub(standin, executeArgs());
      expectStopped(r, 3, "new-object-missing");
      expectOldIntact();
    }),
    BATCH_SLOW,
  );

  test(
    "refuses a key outside the plan, and a prune prefix that is not a dataset's own",
    scoped(async (lane) => {
      const { standin, dir, writeProofs, executeArgs, expectOldIntact } = lane();
      writeProofs();
      const planPath = path.join(dir, "plan.json");
      const plan = readJson<PlanFile>(dir, "plan.json");
      const entry = plan.keys.find((k) => k.oldKey === a.oldKey) as PlanFile["keys"][number];
      // The plan's totals must keep agreeing with its keys, or the plan is refused on its own
      // account and the guard under test is never reached.
      const setNeedsScrub = (on: boolean) => {
        entry.needsScrub = on;
        plan.totals.needScrub = plan.keys.filter((k) => k.needsScrub).length;
        plan.totals.bytesToHash = plan.keys
          .filter((k) => k.needsScrub)
          .reduce((n, k) => n + k.size, 0);
        writeFileSync(planPath, JSON.stringify(plan));
        writeGitVerified(dir); // the git proof names the plan's bytes
      };
      setNeedsScrub(false);
      const notPlanned = await runScrub(standin, executeArgs());
      expectStopped(notPlanned, 3, "assembled-not-in-plan");

      setNeedsScrub(true);
      for (const prefix of [
        `${DATASET}/objects/`,
        // The dataset root covers objects/, and an empty segment is not a safe spelling of it.
        `${DATASET}/`,
        `${DATASET}//objects/`,
        `${DATASET}//`,
        "xx090999/version/",
        `${DATASET}/version`,
        `${DATASET}/../x/`,
      ]) {
        const r = await runScrub(standin, executeArgs(["--prune-noncurrent", prefix]));
        expectStopped(r, 3, "bad-prune-prefix");
      }
      expectOldIntact();
    }),
    BATCH_SLOW,
  );
});

describe("delete-old: refusals before any S3 call (proofs)", () => {
  test(
    "refuses unless both proofs exist",
    scoped(async (lane) => {
      const { standin, dir, writeProofs, executeArgs, expectOldIntact } = lane();
      rmSync(path.join(dir, "verified.json"));
      const noVerified = await runScrub(standin, executeArgs());
      expectStopped(noVerified, 3, "verified.json-missing");
      expectOldIntact();

      writeProofs();
      rmSync(path.join(dir, "new-hash-verified.json"));
      const noHash = await runScrub(standin, executeArgs());
      expectStopped(noHash, 3, "new-hash-verified.json-missing");
      expectOldIntact();
      expect(has(dir, "deleted.json")).toBe(false);
    }),
    SLOW,
  );
});

describe.concurrent("delete-old: deleting", () => {
  test(
    "the stand-in enforces the lock, so a delete without the bypass is refused",
    scoped(async (lane) => {
      const { standin, versionIdsOf } = lane();
      // This is what makes the tests below meaningful: if the stand-in let this through, a
      // stage that forgot the bypass header would pass them all.
      const id = (oldIds[b.oldKey] as string[])[1] as string;
      let refused: unknown;
      await withCtx(standin, (ctx) =>
        deleteVersion(ctx, objectPath(b.oldKey), id, false).catch((e) => {
          refused = e;
        }),
      );
      expect(refused).toBeInstanceOf(AwsCliError);
      expect((refused as AwsCliError).code).toBe("access-denied");
      expect(versionIdsOf(b.oldKey)).toContain(id);
    }),
    BATCH_SLOW,
  );

  test(
    "a dry run reports what it would delete and deletes nothing",
    scoped(async (lane) => {
      const { standin, dir, writeProofs, deleteArgs, expectOldIntact } = lane();
      writeProofs();
      const r = await runScrub(standin, deleteArgs());
      expect(r.exitCode, r.all).toBe(0);
      // A: two older versions and the current one, plus a marker. B: current plus a marker.
      expect(r.stdout).toContain("keys=2 versions=4 markers=2");
      expect(r.stdout).toContain("would delete versions=4 markers=2 across 2 keys");
      expectOldIntact();
      expect(has(dir, "deleted.json")).toBe(false);
    }),
    BATCH_SLOW,
  );

  test(
    "a git proof that names an allowed tag is a proof like any other",
    scoped(async (lane) => {
      const { standin, dir, writeProofs, deleteArgs, expectOldIntact } = lane();
      // `git-scrub verify --fresh-clone --allow-tag` records the names; the stage that reads the
      // proof binds it by hash and mode and asks nothing of the field.
      writeProofs();
      writeGitVerified(dir, { allowedTags: ["v1.1.1"] });
      const r = await runScrub(standin, deleteArgs());
      expect(r.exitCode, r.all).toBe(0);
      expect(r.stdout).toContain("would delete versions=4 markers=2 across 2 keys");
      expect(r.stdout).not.toContain("git-proof");
      expectOldIntact();
    }),
    BATCH_SLOW,
  );

  test(
    "removes every version and delete marker by id with the bypass, leaves the new keys alone",
    scoped(async (lane) => {
      const { standin, dir, writeProofs, executeArgs, versionIdsOf, assembledSha } = lane();
      writeProofs();
      const newBefore = [a, b].map((f) => ({
        key: f.newKey as string,
        versions: standin.versions(BUCKET, objectPath(f.newKey as string)).map((v) => v.versionId),
        data: sha256(
          (standin.current(BUCKET, objectPath(f.newKey as string)) as { data: Uint8Array }).data,
        ),
      }));
      const cleanBefore = versionIdsOf(d.oldKey);

      const r = await runScrub(standin, executeArgs());
      expect(r.exitCode, r.all).toBe(0);
      expect(r.stdout).toContain("zero versions and zero markers remain for 2 keys");

      // Every old version and marker is gone, authoritatively: nothing under either old key.
      for (const f of [a, b]) {
        expect(standin.versions(BUCKET, objectPath(f.oldKey)).length, f.label).toBe(0);
      }
      // Each version was named by id in a batch that carried the bypass; none was a bare delete,
      // and the six went in ONE request (no single-object delete at all).
      const deletes = batchDeleted(standin);
      expect(deletes.length).toBe(6);
      expect(standin.calls("DeleteObjects").length).toBe(1);
      expect(standin.calls("DeleteObject").length).toBe(0);
      for (const del of deletes) {
        expect(del.versionId, "version id").toBeTruthy();
        expect(del.bypass, "bypass header").toBe(true);
      }
      // Counts only on the progress line: no key, no version id anywhere in what it printed.
      expect(r.stdout).toContain("delete-old: deleted 6 of 6 in this group");
      expect(r.stdout).not.toContain("SHA256E");
      for (const del of deletes) expect(r.stdout).not.toContain(del.versionId as string);
      const deletedIds = deletes.map((x) => x.versionId).sort();
      expect(deletedIds).toEqual(
        [...(oldIds[a.oldKey] as string[]), ...(oldIds[b.oldKey] as string[])].sort(),
      );

      // The new keys and the untouched clean file are exactly as they were.
      for (const n of newBefore) {
        const at = objectPath(n.key);
        expect(standin.versions(BUCKET, at).map((v) => v.versionId)).toEqual(n.versions);
        expect(sha256((standin.current(BUCKET, at) as { data: Uint8Array }).data)).toBe(n.data);
        expect(parseKey(n.key).size).toBeGreaterThan(0);
      }
      expect(versionIdsOf(d.oldKey)).toEqual(cleanBefore);

      const done = readJson<DeletedFile>(dir, "deleted.json");
      expect(done.counts).toEqual({
        keys: 2,
        versions: 4,
        markers: 2,
        prunedVersions: 0,
        prunedMarkers: 0,
      });
      expect(done.assembledSha256).toBe(assembledSha());
      // Counts only: no key and no name in the record of what was done.
      expect(JSON.stringify(done)).not.toContain("SHA256E");
    }),
    BATCH_SLOW,
  );

  test(
    "a version that appears while deleting is found by the final listing and fails the stage",
    scoped(async (lane) => {
      const { standin, dir, writeProofs, executeArgs, versionIdsOf } = lane();
      writeProofs();
      let newcomer = "";
      standin.beforeOp("DeleteObjects", () => {
        // A writer re-adds the original to B just as the deletes begin.
        newcomer = standin.putObject(BUCKET, objectPath(b.oldKey), b.bytes, {
          lockUntil: centuryFromNow(),
        });
      });
      const r = await runScrub(standin, executeArgs());
      expect(r.exitCode, r.all).toBe(5);
      expect(r.stdout).toContain("versions and markers remain: oldKeys=1");
      expect(has(dir, "deleted.json")).toBe(false);
      expect(versionIdsOf(b.oldKey)).toEqual([newcomer]);
      expect(standin.versions(BUCKET, objectPath(a.oldKey)).length).toBe(0);
    }),
    BATCH_SLOW,
  );

  test(
    "a delete the operator may not make is not reported as done",
    scoped(async (lane) => {
      const { standin, dir, writeProofs, executeArgs } = lane();
      writeProofs();
      // The operator lacks s3:BypassGovernanceRetention: S3 refuses the bypass header too.
      standin.setDenyBypass(true);
      const r = await runScrub(standin, executeArgs());
      expect(r.exitCode, r.all).toBe(5);
      expect(r.stdout).toContain("DeleteObjects:access-denied");
      expect(has(dir, "deleted.json")).toBe(false);
      // Delete markers are not locked, so those went; the locked versions stayed.
      for (const f of [a, b]) {
        expect(standin.versions(BUCKET, objectPath(f.oldKey)).every((v) => !v.deleteMarker)).toBe(
          true,
        );
        expect(standin.versions(BUCKET, objectPath(f.oldKey)).length).toBeGreaterThan(0);
      }
    }),
    BATCH_SLOW,
  );
});

describe("delete-old: refusals before any S3 call (the working directory)", () => {
  test(
    "a deleted.json from an earlier run does not outlive a run that refuses",
    scoped(async (lane) => {
      const { standin, dir, writeProofs, executeArgs } = lane();
      writeProofs();
      writeJson(dir, "deleted.json", { stale: true });
      rmSync(path.join(dir, "verified.json"));
      expectStopped(await runScrub(standin, executeArgs()), 3, "verified.json-missing");
      expect(has(dir, "deleted.json")).toBe(false);
    }),
    SLOW,
  );
});

describe.concurrent("delete-old: pruning noncurrent versions", () => {
  const manifest = `${DATASET}/version/v1.0.0.json`;
  const zarrJson = `${DATASET}/zarr/sub-01/x.zarr/zarr.json`;
  const body = (s: string) => new TextEncoder().encode(s);
  /** A manifest that names no EDF file: the preflight reads the current one, so it must parse. */
  const manifestBody = () =>
    body(JSON.stringify({ dataset_id: DATASET, version: "v1.0.0", files: {} }));

  test(
    "deletes only noncurrent versions and markers, by id, without the bypass; never a current one",
    scoped(async (lane) => {
      const { standin, dir, writeProofs, executeArgs, proveZarr } = lane();
      writeProofs();
      // Manifest: seeded, regenerated, then one more version and a marker below the newest.
      standin.putObject(BUCKET, manifest, manifestBody());
      standin.putDeleteMarker(BUCKET, manifest);
      standin.putObject(BUCKET, manifest, manifestBody());
      // A Zarr store root: an older version and a current one, which the zarr stage has proven.
      standin.putObject(BUCKET, zarrJson, body("an older zarr.json"));
      standin.putObject(BUCKET, zarrJson, body(cleanStore));
      await proveZarr();
      const currentManifest = standin.current(BUCKET, manifest)?.versionId as string;
      const currentZarr = standin.current(BUCKET, zarrJson)?.versionId as string;

      const r = await runScrub(
        standin,
        executeArgs([
          "--prune-noncurrent",
          `${DATASET}/version/`,
          "--prune-noncurrent",
          `${DATASET}/zarr/`,
        ]),
      );
      expect(r.exitCode, r.all).toBe(0);
      // Manifest: the regenerated version and one more below the newest, and a marker; Zarr: one.
      expect(r.stdout).toContain("prune noncurrent versions=3 markers=1");

      expect(standin.versions(BUCKET, manifest).map((v) => v.versionId)).toEqual([currentManifest]);
      expect(standin.versions(BUCKET, zarrJson).map((v) => v.versionId)).toEqual([currentZarr]);
      expect(standin.current(BUCKET, manifest)?.deleteMarker).toBe(false);

      // The pruning deletes are by id and never carry the bypass.
      const prunes = batchDeleted(standin).filter((x) => !x.key.startsWith(`${DATASET}/objects/`));
      expect(prunes.length).toBe(4);
      for (const p of prunes) {
        expect(p.versionId).toBeTruthy();
        expect(p.bypass).toBe(false);
      }
      const done = readJson<DeletedFile>(dir, "deleted.json");
      expect(done.counts.prunedVersions).toBe(3);
      expect(done.counts.prunedMarkers).toBe(1);
      expect(r.stdout).toContain("no history under archives/, version/, zarr/");
    }),
    BATCH_SLOW,
  );

  test(
    "never forces a lock: a locked noncurrent version stays and the stage fails",
    scoped(async (lane) => {
      const { standin, dir, writeProofs, executeArgs, proveZarr } = lane();
      writeProofs();
      standin.putObject(BUCKET, zarrJson, body("locked"), { lockUntil: centuryFromNow() });
      standin.putObject(BUCKET, zarrJson, body(cleanStore));
      await proveZarr();
      const r = await runScrub(standin, executeArgs(["--prune-noncurrent", `${DATASET}/zarr/`]));
      expect(r.exitCode, r.all).toBe(5);
      expect(r.stdout).toContain("DeleteObjects:access-denied");
      expect(standin.versions(BUCKET, zarrJson).length).toBe(2);
      expect(has(dir, "deleted.json")).toBe(false);
    }),
    BATCH_SLOW,
  );

  test(
    "refuses history it was not told to prune, before the first delete, and counts it per prefix",
    scoped(async (lane) => {
      const { standin, dir, writeProofs, deleteArgs, proveZarr, expectOldIntact } = lane();
      writeProofs();
      // Probe T3's shape: the manifests were regenerated and the Zarr roots rewritten, so both
      // prefixes hold old versions naming old keys and old metadata.
      standin.putObject(BUCKET, manifest, manifestBody());
      standin.putObject(BUCKET, manifest, manifestBody());
      standin.putObject(BUCKET, zarrJson, body(dirtyStore));
      await proveZarr();
      // Every run refuses and changes nothing, so the four run at once.
      await together(
        [[], ["--execute"]].flatMap((flag) => [
          async () => {
            const none = await runScrub(standin, deleteArgs(flag));
            expectStopped(none, 3, "history-remains");
            expect(none.stdout).toContain(
              "refused history-remains: version=2 zarr=1 not named by --prune-noncurrent",
            );
          },
          async () => {
            const half = await runScrub(
              standin,
              deleteArgs([...flag, "--prune-noncurrent", `${DATASET}/version/`]),
            );
            expectStopped(half, 3, "history-remains", "version/ only");
            expect(half.stdout).toContain(
              "refused history-remains: zarr=1 not named by --prune-noncurrent",
            );
          },
        ]),
      );
      expectOldIntact();
      expect(has(dir, "deleted.json")).toBe(false);
    }),
    BATCH_SLOW,
  );

  test(
    "history that appears during the run fails it with no deleted.json, and a re-run finishes",
    scoped(async (lane) => {
      const { standin, dir, pub, writeProofs, executeArgs } = lane();
      writeProofs();
      // The first delete is when a writer regenerates the manifest once more: the version that
      // was current becomes history after the preflight has looked.
      standin.beforeOp("DeleteObjects", () => {
        standin.putObject(BUCKET, manifest, manifestBody());
      });
      const pruneVersion = ["--prune-noncurrent", `${DATASET}/version/`];
      const r = await runScrub(standin, executeArgs(pruneVersion));
      expectStopped(r, 5, "history-remains");
      expect(r.stdout).toContain("history-remains archives=0 version=1 zarr=0");
      expect(has(dir, "deleted.json")).toBe(false);
      // The old keys did go; only the history is left.
      for (const f of [a, b]) expect(standin.versions(BUCKET, objectPath(f.oldKey)).length).toBe(0);

      // A re-run has no old object left to ask about, so it asks about a new one, and finishes.
      pub.requests.length = 0;
      const again = await runScrub(standin, executeArgs(pruneVersion));
      expect(again.exitCode, again.all).toBe(0);
      expect(pub.requests.map((q) => q.path)).toEqual([`/${DATASET}/objects/${firstNewKey()}`]);
      expect(standin.versions(BUCKET, manifest).length).toBe(1);
      const done = readJson<DeletedFile>(dir, "deleted.json");
      expect(done.counts).toEqual({
        keys: 2,
        versions: 0,
        markers: 0,
        prunedVersions: 1,
        prunedMarkers: 0,
      });
    }),
    BATCH_SLOW,
  );

  test(
    "a key that is only history, a version under a delete marker, is pruned whole",
    scoped(async (lane) => {
      const { standin, writeProofs, executeArgs } = lane();
      writeProofs();
      const oldVersion = standin.putObject(BUCKET, zarrJson, body(dirtyStore));
      const oldMarker = standin.putDeleteMarker(BUCKET, zarrJson);
      const r = await runScrub(standin, executeArgs(["--prune-noncurrent", `${DATASET}/zarr/`]));
      expect(r.exitCode, r.all).toBe(0);
      expect(r.stdout).toContain("prune noncurrent versions=1 markers=1");
      expect(standin.versions(BUCKET, zarrJson)).toEqual([]);
      // The version went first; the marker only once nothing was left under it: the marker is in
      // a LATER request than the version, never beside it.
      const requestOf = (id: string) =>
        standin.calls("DeleteObjects").findIndex((c) => c.items?.some((i) => i.versionId === id));
      const [version, marker] = [oldVersion, oldMarker].map(requestOf) as [number, number];
      expect(version).toBeGreaterThanOrEqual(0);
      expect(marker).toBeGreaterThan(version);
    }),
    BATCH_SLOW,
  );

  test(
    "a delete marker over a version that cannot go is kept, so no old version becomes current",
    scoped(async (lane) => {
      const { standin, dir, writeProofs, executeArgs } = lane();
      writeProofs();
      standin.putObject(BUCKET, zarrJson, body(dirtyStore), { lockUntil: centuryFromNow() });
      standin.putDeleteMarker(BUCKET, zarrJson);
      const r = await runScrub(standin, executeArgs(["--prune-noncurrent", `${DATASET}/zarr/`]));
      expectStopped(r, 5, "history-remains");
      expect(r.stdout).toContain("DeleteObjects:access-denied");
      expect(standin.current(BUCKET, zarrJson)).toBeUndefined();
      expect(standin.versions(BUCKET, zarrJson).map((v) => v.deleteMarker)).toEqual([false, true]);
      expect(has(dir, "deleted.json")).toBe(false);
    }),
    BATCH_SLOW,
  );

  test(
    "refuses to prune more than --max-prune",
    scoped(async (lane) => {
      const { standin, writeProofs, executeArgs, expectOldIntact } = lane();
      writeProofs();
      standin.putObject(BUCKET, manifest, manifestBody());
      standin.putObject(BUCKET, manifest, manifestBody());
      const r = await runScrub(
        standin,
        executeArgs(["--prune-noncurrent", `${DATASET}/version/`, "--max-prune", "1"]),
      );
      expectStopped(r, 3, "over-max-prune");
      expectOldIntact();
    }),
    BATCH_SLOW,
  );
});

describe("delete-old: refusals before any S3 call (the assembly)", () => {
  test(
    "refuses an entry that names no new version, in both modes, before any S3 call",
    scoped(async (lane) => {
      const { standin, dir, writeProofs, deleteArgs, expectOldIntact } = lane();
      // Reviewer probe T4: without a version id the HEAD would check whatever is current.
      const copy = readJson<AssembledFile>(dir, "assembled.json");
      (copy.entries[a.oldKey] as { newVersionId?: string }).newVersionId = undefined;
      writeJson(dir, "assembled.json", copy);
      writeProofs();
      for (const flag of [[], ["--execute"]]) {
        expectStopped(await runScrub(standin, deleteArgs(flag)), 3, "assembled.json-invalid");
      }
      expect(standin.log.length).toBe(0);
      expectOldIntact();
    }),
    SLOW,
  );
});

describe.concurrent(
  "delete-old: every file names the same dataset, bucket and bytes (I11, T4)",
  () => {
    const body = (text: string) => new TextEncoder().encode(text);

    test(
      "refuses without a git proof of a fresh clone, or with one that is stale",
      scoped(async (lane) => {
        const { standin, dir, writeProofs, executeArgs, expectOldIntact } = lane();
        writeProofs();
        rmSync(path.join(dir, "git-verified.json"));
        expectStopped(await runScrub(standin, executeArgs()), 3, "git-proof-missing");
        // Strict parser: an extra field is not the file git-scrub writes.
        writeGitVerified(dir);
        const extra = { ...readJson<Record<string, unknown>>(dir, "git-verified.json"), more: 1 };
        writeJson(dir, "git-verified.json", extra);
        expectStopped(await runScrub(standin, executeArgs()), 3, "git-proof-invalid");
        // A local verify is not a verify of what was pushed.
        writeGitVerified(dir, { mode: "local" });
        expectStopped(await runScrub(standin, executeArgs()), 3, "git-proof-stale");
        // Another keymap, another plan.
        writeGitVerified(dir, { keymapSha256: "b".repeat(64) });
        expectStopped(await runScrub(standin, executeArgs()), 3, "git-proof-stale", "keymap");
        writeGitVerified(dir, { s3PlanSha256: "c".repeat(64) });
        expectStopped(await runScrub(standin, executeArgs()), 3, "git-proof-stale", "plan");
        writeGitVerified(dir, { dataset: "xx090412" });
        expectStopped(await runScrub(standin, executeArgs()), 3, "proof-wrong-dataset", "dataset");
        // Another git plan, when one is in the working directory (none is anywhere above).
        const gitPlan = path.join(dir, "git-plan.json");
        writeFileSync(gitPlan, '{"version":1}\n');
        writeGitVerified(dir);
        const otherGitPlan = await runScrub(standin, executeArgs());
        expectStopped(otherGitPlan, 3, "git-proof-stale", "git plan");
        expect(otherGitPlan.stdout).toContain("names another git-plan.json");
        // The keymap the proof names must be this assembly's.
        const keymap = readJson<Record<string, string>>(dir, "keymap.json");
        writeJson(dir, "keymap.json", { ...keymap, [a.oldKey]: b.newKey });
        // ...with the git plan the proof names in the directory, which is no refusal of its own.
        writeGitVerified(dir, { gitPlanSha256: sha256(readFileSync(gitPlan)) });
        const sameGitPlan = await runScrub(standin, executeArgs());
        expectStopped(sameGitPlan, 3, "keymap-mismatch");
        expect(sameGitPlan.all).not.toContain("git-proof-stale");
        rmSync(gitPlan);
        expectOldIntact();
        expect(standin.log.length).toBe(0);
      }),
      BATCH_SLOW,
    );

    test(
      "the plan's dataset and bucket are compared with assembled.json and each proof, pair by pair",
      scoped(async (lane) => {
        const { standin, dir, writeProofs, executeArgs, expectOldIntact } = lane();
        const assembled = readJson<AssembledFile>(dir, "assembled.json");
        const refuse = async (word: string, label: string) => {
          writeProofs();
          writeGitVerified(dir);
          expectStopped(await runScrub(standin, executeArgs()), 3, word, label);
          writeJson(dir, "assembled.json", assembled);
        };
        writeJson(dir, "assembled.json", { ...assembled, dataset: "xx090412" });
        await refuse("assembled-wrong-dataset", "assembled dataset");
        writeJson(dir, "assembled.json", { ...assembled, bucket: "other-bucket" });
        await refuse("assembled-wrong-bucket", "assembled bucket");
        // Each proof's dataset on its own, with everything else right.
        writeProofs();
        writeJson(dir, "verified.json", {
          ...readJson<Record<string, unknown>>(dir, "verified.json"),
          dataset: "xx090412",
        });
        expectStopped(await runScrub(standin, executeArgs()), 3, "proof-wrong-dataset", "verified");
        writeProofs();
        writeJson(dir, "new-hash-verified.json", {
          ...readJson<Record<string, unknown>>(dir, "new-hash-verified.json"),
          dataset: "xx090412",
        });
        expectStopped(await runScrub(standin, executeArgs()), 3, "proof-wrong-dataset", "hash");
        expectOldIntact();
        expect(standin.log.length).toBe(0);
      }),
      BATCH_SLOW,
    );

    test(
      "a current manifest that cannot be read, and no manifest at all, are refusals (T1)",
      scoped(async (lane) => {
        const manifest = `${DATASET}/version/v1.0.0.json`;
        await together([
          async () => {
            const { standin, writeProofs, deleteArgs, expectOldIntact } = lane();
            writeProofs();
            standin.inject("GetObject", { code: "InternalError", status: 500, key: manifest });
            expectStopped(await runScrub(standin, deleteArgs()), 3, "manifest-unreadable");
            expectOldIntact();
          },
          async () => {
            const { standin, writeProofs, deleteArgs, expectOldIntact } = lane();
            writeProofs();
            standin.putDeleteMarker(BUCKET, manifest);
            // Both are dry runs of one state, so they run at once.
            await together([
              async () => {
                // The hidden manifest is history too, and both refusals are reported.
                const r = await runScrub(standin, deleteArgs());
                expectStopped(r, 3, "no-manifests+history-remains");
              },
              async () => {
                const named = await runScrub(
                  standin,
                  deleteArgs(["--prune-noncurrent", `${DATASET}/version/`]),
                );
                expectStopped(named, 3, "no-manifests");
              },
            ]);
            expectOldIntact();
          },
        ]);
      }),
      BATCH_SLOW,
    );

    test(
      "an older version of an old key that is not the key's size is refused (T10)",
      scoped(async (lane) => {
        const { standin, dir, writeProofs, executeArgs } = lane();
        writeProofs();
        // Recorded by the plan (so version-not-in-plan does not fire first), and the wrong size.
        const odd = standin.putObject(BUCKET, objectPath(a.oldKey), new Uint8Array(1234), {
          lockUntil: centuryFromNow(),
        });
        const plan = readJson<PlanFile>(dir, "plan.json");
        (plan.keys.find((k) => k.oldKey === a.oldKey) as PlanFile["keys"][number]).versionIds.push(
          odd,
        );
        writeJson(dir, "plan.json", plan);
        writeGitVerified(dir);
        // The odd version is now current; put a right-sized one on top so only an OLDER one is odd.
        standin.putObject(BUCKET, objectPath(a.oldKey), a.bytes, { lockUntil: centuryFromNow() });
        const top = standin.versions(BUCKET, objectPath(a.oldKey)).at(-1)?.versionId as string;
        const plan2 = readJson<PlanFile>(dir, "plan.json");
        (plan2.keys.find((k) => k.oldKey === a.oldKey) as PlanFile["keys"][number]).versionIds.push(
          top,
        );
        writeJson(dir, "plan.json", plan2);
        writeGitVerified(dir);
        const r = await runScrub(standin, executeArgs());
        expectStopped(r, 3, "version-size-differs");
        expect(r.stdout).toContain("1 versions of old keys are not the size their key declares");
        expect(deleteRequests(standin)).toBe(0);
      }),
      BATCH_SLOW,
    );

    test(
      "an archive that appears during the run is found by the final listing: no deleted.json (T5)",
      scoped(async (lane) => {
        const { standin, dir, writeProofs, executeArgs } = lane();
        writeProofs();
        // Between the last precondition and the final listing: while the deletes run.
        standin.beforeOp("DeleteObjects", () => {
          standin.putObject(BUCKET, `${DATASET}/archives/${DATASET}.zip`, body("zip"));
        });
        const r = await runScrub(standin, executeArgs());
        expect(r.exitCode, r.all).toBe(5);
        expect(r.stdout).toContain("history-remains");
        expect(r.stdout).toContain("archives=1");
        expect(has(dir, "deleted.json")).toBe(false);
      }),
      BATCH_SLOW,
    );
  },
);

describe("delete-old: refusals before any S3 call (the plan)", () => {
  test(
    "refuses a plan with a key nobody read, even when its totals agree, in both modes",
    scoped(async (lane) => {
      const { standin, dir, writeProofs, deleteArgs, expectOldIntact } = lane();
      writeProofs();
      addUnreadableKey(dir);
      for (const flag of [[], ["--execute"]]) {
        expectStopped(await runScrub(standin, deleteArgs(flag)), 3, "plan-has-unreadable");
      }
      expect(standin.log.length).toBe(0);
      expectOldIntact();
      expect(has(dir, "deleted.json")).toBe(false);
    }),
    SLOW,
  );
});

describe.concurrent("delete-old: every refusal is evaluated, and all are reported together", () => {
  const body = (s: string) => new TextEncoder().encode(s);
  const manifest = `${DATASET}/version/v1.0.0.json`;
  const zarrJson = `${DATASET}/zarr/sub-01/x.zarr/zarr.json`;
  const manifestBody = () =>
    body(JSON.stringify({ dataset_id: DATASET, version: "v1.0.0", files: {} }));
  const refusedLines = (stdout: string) =>
    stdout.split("\n").filter((l) => l.startsWith("delete-old: refused "));

  test(
    "before step 15a the dry run shows what else refuses, not only archives-not-dropped",
    scoped(async (lane) => {
      const { standin, dir, writeProofs, deleteArgs, expectOldIntact } = lane();
      writeProofs();
      // The archives are there (step 15a has not run), and the operator forgot to name the
      // manifests' history: both are reported by the one dry run.
      standin.putObject(BUCKET, `${DATASET}/archives/${DATASET}_v1.0.0.zip`, body("zip"));
      standin.putObject(BUCKET, manifest, manifestBody());
      standin.putObject(BUCKET, manifest, manifestBody());
      // Both are dry runs of one state, so they run at once.
      await together([
        async () => {
          const r = await runScrub(standin, deleteArgs());
          expectStopped(r, 3, "archives-not-dropped+history-remains");
          expect(refusedLines(r.stdout)).toEqual([
            "delete-old: refused archives-not-dropped: versions and markers=1 under archives/",
            "delete-old: refused history-remains: version=2 not named by --prune-noncurrent",
          ]);
          // The counts the operator needs for --max-delete are printed before the archives go.
          expect(r.stdout).toContain(
            "delete-old: keys=2 versions=4 markers=2 planRecorded=6 limit=6",
          );
        },
        async () => {
          // Named, the history is counted for --max-prune, and only the archives are left.
          const named = await runScrub(
            standin,
            deleteArgs(["--prune-noncurrent", `${DATASET}/version/`]),
          );
          expectStopped(named, 3, "archives-not-dropped");
          expect(named.stdout).toContain("delete-old: prune noncurrent versions=2 markers=0");
        },
      ]);
      expectOldIntact();
      expect(has(dir, "deleted.json")).toBe(false);
    }),
    BATCH_SLOW,
  );

  test(
    "every refusal at once, in a fixed order, each with what triggered it, and nothing deleted",
    scoped(async (lane) => {
      const { standin, dir, pub, writeProofs, deleteArgs } = lane();
      writeProofs();
      // new-object-missing: one replacement is gone.
      const newVersion = (
        readJson<AssembledFile>(dir, "assembled.json").entries[a.oldKey] as {
          newVersionId: string;
        }
      ).newVersionId;
      standin.dropVersion(BUCKET, objectPath(a.newKey as string), newVersion);
      // manifest-names-old-key: a second tag whose manifest was never regenerated.
      seedManifest(standin, "v1.0.1", [b]);
      // unplanned-recording: an EDF uploaded after the plan.
      const late = makeFixture(
        "L",
        ".EDF",
        "sub-09/eeg/late.EDF",
        edfFile(edfHeader({ patient: "Quillfeather", recording: "x" }), 4096, 99),
        null,
      );
      standin.putObject(BUCKET, objectPath(late.oldKey), late.bytes, {
        lockUntil: centuryFromNow(),
      });
      // archives-not-dropped.
      standin.putObject(BUCKET, `${DATASET}/archives/${DATASET}_v1.0.0.zip`, body("zip"));
      // zarr-not-scrubbed, and its older version is history nobody named (history-remains).
      standin.putObject(BUCKET, zarrJson, body(dirtyStore));
      standin.putObject(BUCKET, zarrJson, body(dirtyStore));
      // privacy-unproven: the public endpoint answers neither 403 nor 200.
      pub.status = 404;
      // version-size-differs, version-not-in-plan and over-max-delete: one version of an old key,
      // of the wrong size, written after the plan.
      standin.putObject(BUCKET, objectPath(a.oldKey), new Uint8Array(1234), {
        lockUntil: centuryFromNow(),
      });
      // over-max-prune: the manifests' history is named, with a cap below it.
      standin.putObject(BUCKET, manifest, manifestBody());
      standin.putObject(BUCKET, manifest, manifestBody());
      const extra = ["--prune-noncurrent", `${DATASET}/version/`, "--max-prune", "1"];

      const words = [
        "new-object-missing",
        "manifest-names-old-key",
        "unplanned-recording",
        "archives-not-dropped",
        "zarr-not-scrubbed",
        "privacy-unproven",
        "version-size-differs",
        "version-not-in-plan",
        "over-max-delete",
        "history-remains",
        "over-max-prune",
      ];
      // Both modes refuse and change nothing, so they run at once.
      await together(
        [[], ["--execute"]].map((flag) => async () => {
          const r = await runScrub(standin, deleteArgs([...flag, ...extra]));
          expectStopped(r, 3, words.join("+"), flag.length ? "execute" : "dry run");
          expect(refusedLines(r.stdout)).toEqual([
            "delete-old: refused new-object-missing: 1 of 2 new objects are not at the version assembly recorded",
            "delete-old: refused manifest-names-old-key: v1.0.1 names 1",
            "delete-old: refused unplanned-recording: 1 recordings under objects/ are not in the plan or the assembly",
            "delete-old: refused archives-not-dropped: versions and markers=1 under archives/",
            "delete-old: refused zarr-not-scrubbed: zarr-verified.json missing",
            "delete-old: refused privacy-unproven: a new object answered 404; an old object answered 404",
            "delete-old: refused version-size-differs: 1 versions of old keys are not the size their key declares",
            "delete-old: refused version-not-in-plan: 1 versions or markers of old keys are not in the plan",
            "delete-old: refused over-max-delete: versions+markers=7 over limit=6",
            "delete-old: refused history-remains: zarr=1 not named by --prune-noncurrent",
            "delete-old: refused over-max-prune: noncurrent versions and markers=2 over --max-prune 1",
          ]);
          expect(r.stdout).toContain(
            "delete-old: keys=2 versions=5 markers=2 planRecorded=6 limit=6",
          );
          expect(r.stdout).toContain("delete-old: prune noncurrent versions=2 markers=0");
          expect(deleteRequests(standin)).toBe(0);
          expect(has(dir, "deleted.json")).toBe(false);
        }),
      );
    }),
    BATCH_SLOW,
  );

  test(
    "working files that disagree are all reported, and the bucket is not read on their account",
    scoped(async (lane) => {
      const { standin, dir, pub, writeProofs, deleteArgs, expectOldIntact } = lane();
      writeProofs();
      rmSync(path.join(dir, "verified.json"));
      writeGitVerified(dir, { mode: "local" });
      for (const flag of [[], ["--execute"]]) {
        const r = await runScrub(
          standin,
          deleteArgs([...flag, "--prune-noncurrent", `${DATASET}/objects/`]),
        );
        expectStopped(r, 3, "verified.json-missing+git-proof-stale+bad-prune-prefix");
        expect(refusedLines(r.stdout)).toEqual([
          "delete-old: refused verified.json-missing",
          "delete-old: refused git-proof-stale: mode local, not fresh-clone",
          "delete-old: refused bad-prune-prefix: a --prune-noncurrent prefix is not <id>/version/, <id>/archives/ or <id>/zarr/",
        ]);
        expect(r.stdout).toContain("the bucket was not read");
      }
      expect(standin.log.length).toBe(0);
      expect(pub.requests.length).toBe(0);
      expectOldIntact();
    }),
    BATCH_SLOW,
  );
});
