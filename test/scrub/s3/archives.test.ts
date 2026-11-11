/**
 * The drop-archives stage, run as the real CLI against the S3 stand-in. It deletes, so most of
 * what is tested is what it must not do: touch anything outside the archive prefix, use the
 * governance bypass, name a delete without a version id, call itself done while a version
 * remains, or run before every proof of the scrub is in the working directory (runbook step 15a:
 * the archives hold the original recordings, and nothing can bring them back).
 *
 * One dataset is carried through plan, assemble, verify and the zarr stage once, by the real
 * stages, and the two proofs made elsewhere (the hash host's re-hash, the fresh-clone verify) are
 * written through the contract's parsers. Each test restores that state and a pristine copy of
 * the working directory, then seeds the archives.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ZarrVerifiedFile } from "../../../scripts/scrub/contract";
import type { ArchivesDroppedFile } from "../../../scripts/scrub/s3/archives-stage";
import { type S3Standin, type Snapshot, startS3Standin } from "../helpers/s3-standin";
import { settleAll } from "./concurrency";
import { expectStopped } from "./refusal";
import {
  BUCKET,
  DATASET,
  SLOW,
  addUnreadableKey,
  batchDeleted,
  buildAssembled,
  centuryFromNow,
  copyDir,
  deleteRequests,
  fixtureA,
  fixtureD,
  has,
  planArgs,
  readJson,
  removeTempDirs,
  runScrub,
  sha256,
  tempDir,
  verifyArgs,
  writeGitVerified,
  writeHashVerified,
  writeJson,
} from "./support";

afterAll(removeTempDirs);

let standin: S3Standin;
/**
 * The stand-ins the scenarios of one test spread over: `pool[0]` is `standin`. A scenario that is
 * independent of its siblings runs against its own, so up to POOL real CLI runs are in flight
 * at once and no more (the CI runners have four cores and other files run beside this one).
 */
const POOL = 3;
let pool: S3Standin[] = [];
let snap: Snapshot;
/** The working directory as runbook step 14 leaves it: every proof there, each for this plan. */
let proven: string;

const body = (s: string) => new TextEncoder().encode(s);
const arch = (name: string) => `${DATASET}/archives/${name}`;
const A = arch(`${DATASET}_v1.0.0.zip`);
const B = arch(`${DATASET}_v1.0.1.zip`);
const C = arch(`${DATASET}_v1.0.2.zip`);
const ZARR_ROOT = `${DATASET}/zarr/sub-01/x.zarr/zarr.json`;

const dropArgs = (dir: string, extra: string[] = []) => [
  "drop-archives",
  "--dir",
  dir,
  "--confirm-dataset",
  DATASET,
  "--concurrency",
  "4",
  ...extra,
];

/** Outside the archive prefix: it must all still be there, untouched, afterwards. */
const BYSTANDERS = [
  `${DATASET}/archives-old/${DATASET}_v0.zip`,
  `${DATASET}/archivesX`,
  `${DATASET}/version/v1.0.0.json`,
  "xx090999/archives/other.zip",
];

beforeAll(async () => {
  standin = startS3Standin();
  // Steps 1 to 5: plan, hash (written by the test, as the hash host would), assemble, verify.
  const built = await buildAssembled(standin, [fixtureA(), fixtureD()]);
  const verified = await runScrub(standin, verifyArgs(built.dir));
  if (verified.exitCode !== 0) throw new Error(`verify failed: ${verified.all}`);
  writeHashVerified(built.dir);
  // Step 10: a store root that mirrors a header member, scrubbed and proven by the real stage.
  standin.putObject(
    BUCKET,
    ZARR_ROOT,
    body(
      JSON.stringify({
        zarr_format: 3,
        node_type: "group",
        attributes: { recording_metadata: { patientcode: "P0042", startdate: "02.02.20" } },
      }),
    ),
  );
  const zarr = await runScrub(standin, ["zarr", "--dir", built.dir, "--execute"]);
  if (zarr.exitCode !== 0) throw new Error(`the zarr stage failed: ${zarr.all}`);
  // Step 14: a fresh clone of the pushed repository verified.
  writeGitVerified(built.dir);
  proven = built.dir;
  snap = standin.snapshot();
  pool = [standin, ...Array.from({ length: POOL - 1 }, () => startS3Standin())];
}, SLOW);

afterAll(() => {
  for (const s of pool) s.stop();
});

/**
 * Run independent scenarios, at most POOL at a time, each against a stand-in of its own that
 * `seeded(s)` restores. Every scenario of a round settles before the test fails, so no CLI run
 * outlives the test that started it; the first failure is the one reported.
 */
async function concurrently<T>(
  items: T[],
  run: (item: T, s: S3Standin) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < items.length; i += POOL) {
    await settleAll(items.slice(i, i + POOL).map((item, j) => run(item, pool[j] as S3Standin)));
  }
}

interface Seeded {
  dir: string;
  /** Every version id and marker under the archive prefix: A has 2 versions, B a version hidden
   * by a marker, C a version, a marker and a re-upload. */
  ids: string[];
  bystanders: Record<string, string[]>;
}

async function seeded(s: S3Standin = standin): Promise<Seeded> {
  s.restore(snap);
  const dir = copyDir(proven);
  const ids = [
    s.putObject(BUCKET, A, body("zip one")),
    s.putObject(BUCKET, A, body("zip two")),
    s.putObject(BUCKET, B, body("zip b")),
    s.putDeleteMarker(BUCKET, B),
    s.putObject(BUCKET, C, body("zip c1")),
    s.putDeleteMarker(BUCKET, C),
    s.putObject(BUCKET, C, body("zip c2")),
  ];
  for (const k of BYSTANDERS.slice(0, 2)) s.putObject(BUCKET, k, body("not an archive"));
  s.putObject(BUCKET, BYSTANDERS[3] as string, body("another dataset"));
  const bystanders: Record<string, string[]> = {};
  for (const k of BYSTANDERS) {
    bystanders[k] = s.versions(BUCKET, k).map((v) => v.versionId);
  }
  s.log.length = 0;
  return { dir, ids, bystanders };
}

const bystanderIds = (key: string) => standin.versions(BUCKET, key).map((v) => v.versionId);

/** Every archive version and marker is still there, and nothing was deleted. */
function expectArchivesIntact(ids: string[], s: S3Standin = standin) {
  expect(deleteRequests(s)).toBe(0);
  expect([A, B, C].flatMap((k) => s.versions(BUCKET, k).map((v) => v.versionId)).sort()).toEqual(
    [...ids].sort(),
  );
}

describe("drop-archives", () => {
  test(
    "needs the dataset id typed again, before any S3 call, in both modes",
    async () => {
      const { dir } = await seeded();
      for (const flag of [[], ["--execute"]]) {
        const missing = await runScrub(standin, ["drop-archives", "--dir", dir, ...flag]);
        expect(missing.exitCode, missing.all).toBe(2);
        expect(missing.stderr).toContain("missing-confirm-dataset");
        const wrong = await runScrub(standin, [
          "drop-archives",
          "--dir",
          dir,
          "--confirm-dataset",
          "xx090999",
          ...flag,
        ]);
        expectStopped(wrong, 3, "confirm-dataset-mismatch");
      }
      expect(standin.log.length).toBe(0);
      expect(has(dir, "archives-dropped.json")).toBe(false);
    },
    SLOW,
  );

  test(
    "refuses a plan with a key nobody read, before any S3 call",
    async () => {
      const { dir } = await seeded();
      addUnreadableKey(dir);
      for (const flag of [[], ["--execute"]]) {
        expectStopped(await runScrub(standin, dropArgs(dir, flag)), 3, "plan-has-unreadable");
      }
      expect(standin.log.length).toBe(0);
    },
    SLOW,
  );

  test(
    "a dry run counts what it would delete and deletes nothing",
    async () => {
      const { dir, ids } = await seeded();
      const r = await runScrub(standin, dropArgs(dir));
      expect(r.exitCode, r.all).toBe(0);
      // A: two versions. B: a version and a marker. C: two versions and a marker.
      expect(r.stdout).toContain("keys=3 versions=5 markers=2");
      expect(r.stdout).toContain("would delete versions=5 markers=2 across 3 keys");
      expect(r.stdout).not.toContain("refused");
      expectArchivesIntact(ids);
      expect(has(dir, "archives-dropped.json")).toBe(false);
    },
    SLOW,
  );

  test(
    "a git proof that names an allowed tag is a proof like any other",
    async () => {
      // `git-scrub verify --fresh-clone --allow-tag` records the names; the stage that reads the
      // proof binds it by hash and mode and asks nothing of the field.
      const { dir, ids } = await seeded();
      writeGitVerified(dir, { allowedTags: ["v1.1.1"] });
      const r = await runScrub(standin, dropArgs(dir));
      expect(r.exitCode, r.all).toBe(0);
      expect(r.stdout).toContain("would delete versions=5 markers=2 across 3 keys");
      expect(r.stdout).not.toContain("git-proof");
      expectArchivesIntact(ids);
    },
    SLOW,
  );

  test(
    "deletes every version and marker by id, never with the bypass, and nothing else",
    async () => {
      const { dir, ids, bystanders } = await seeded();
      const r = await runScrub(standin, dropArgs(dir, ["--execute"]));
      expect(r.exitCode, r.all).toBe(0);
      expect(r.stdout).toContain("zero versions and zero markers remain");

      // Seven versions: five versions and two markers, each by its own id, none with the
      // bypass, all in ONE request, and no single-object delete.
      const deletes = batchDeleted(standin);
      expect(deletes.length).toBe(7);
      expect(standin.calls("DeleteObjects").length).toBe(1);
      expect(standin.calls("DeleteObject").length).toBe(0);
      for (const d of deletes) {
        expect(d.versionId, "version id").toBeTruthy();
        expect(d.bypass, "bypass header").toBe(false);
      }
      expect(deletes.map((d) => d.versionId).sort()).toEqual([...ids].sort());
      // Gone from the stand-in, key by key, and the final listing was a fresh one.
      expect(standin.keys(BUCKET, `${DATASET}/archives/`)).toEqual([]);
      expect(standin.calls("ListObjectVersions").length).toBe(2);

      // Everything outside the prefix, including a sibling that merely starts alike, is as it was.
      for (const k of BYSTANDERS) expect(bystanderIds(k), k).toEqual(bystanders[k] as string[]);

      const done = readJson<ArchivesDroppedFile>(dir, "archives-dropped.json");
      expect(done.dataset).toBe(DATASET);
      expect(done.counts).toEqual({ keys: 3, versions: 5, markers: 2 });
      expect(JSON.stringify(done)).not.toContain(".zip");
      expect(statSync(path.join(dir, "archives-dropped.json")).mode & 0o777).toBe(0o600);

      // Run again: nothing left, and it says so.
      const again = await runScrub(standin, dropArgs(dir, ["--execute"]));
      expect(again.exitCode, again.all).toBe(0);
      expect(readJson<ArchivesDroppedFile>(dir, "archives-dropped.json").counts).toEqual({
        keys: 0,
        versions: 0,
        markers: 0,
      });
    },
    SLOW,
  );

  test(
    "a locked version is reported and fails the stage; the lock is never forced",
    async () => {
      const { dir } = await seeded();
      const locked = standin.putObject(BUCKET, arch("locked.zip"), body("locked"), {
        lockUntil: centuryFromNow(),
      });
      standin.log.length = 0;
      const r = await runScrub(standin, dropArgs(dir, ["--execute"]));
      expect(r.exitCode, r.all).toBe(5);
      expect(r.stdout).toContain("DeleteObjects:access-denied=1");
      expect(r.stdout).toContain("versions and markers remain: 1");
      expect(has(dir, "archives-dropped.json")).toBe(false);
      // Only the locked version stands, and every attempt, including that one, was without bypass.
      expect(standin.keys(BUCKET, `${DATASET}/archives/`)).toEqual([arch("locked.zip")]);
      expect(bystanderIds(arch("locked.zip"))).toEqual([locked]);
      expect(batchDeleted(standin).length).toBeGreaterThan(0);
      expect(batchDeleted(standin).every((d) => d.bypass === false)).toBe(true);
    },
    SLOW,
  );

  test(
    "an archive that appears while deleting is found by the final listing and fails the stage",
    async () => {
      const { dir } = await seeded();
      let newcomer = "";
      standin.beforeOp("DeleteObjects", () => {
        newcomer = standin.putObject(BUCKET, arch("late.zip"), body("a workflow rebuilt it"));
      });
      const r = await runScrub(standin, dropArgs(dir, ["--execute"]));
      expect(r.exitCode, r.all).toBe(5);
      expect(r.stdout).toContain("versions and markers remain: 1");
      expect(has(dir, "archives-dropped.json")).toBe(false);
      expect(bystanderIds(arch("late.zip"))).toEqual([newcomer]);
    },
    SLOW,
  );

  test(
    "a dataset with no archive is dropped vacuously",
    async () => {
      standin.restore(snap);
      const dir = copyDir(proven);
      const r = await runScrub(standin, dropArgs(dir, ["--execute"]));
      expect(r.exitCode, r.all).toBe(0);
      expect(readJson<ArchivesDroppedFile>(dir, "archives-dropped.json").counts).toEqual({
        keys: 0,
        versions: 0,
        markers: 0,
      });
      expect(deleteRequests(standin)).toBe(0);
    },
    SLOW,
  );
});

describe("drop-archives: every proof of the scrub must be there first (runbook step 15a)", () => {
  /** The four proofs, and the word that names each one's absence. */
  const PROOFS: Array<[string, string]> = [
    ["verified.json", "verified.json-missing"],
    ["new-hash-verified.json", "new-hash-verified.json-missing"],
    ["git-verified.json", "git-proof-missing"],
    ["zarr-verified.json", "zarr-not-scrubbed"],
  ];

  /** Refused with exactly `word` in both modes, the dry run still counting the archives. */
  async function refusedBoth(
    dir: string,
    ids: string[],
    word: string,
    label = word,
    s: S3Standin = standin,
  ) {
    const dry = await runScrub(s, dropArgs(dir));
    expectStopped(dry, 3, word, `dry run: ${label}`);
    expect(dry.stdout, label).toContain("would delete versions=5 markers=2 across 3 keys");
    const exec = await runScrub(s, dropArgs(dir, ["--execute"]));
    expectStopped(exec, 3, word, `execute: ${label}`);
    expectArchivesIntact(ids, s);
    expect(has(dir, "archives-dropped.json"), label).toBe(false);
    return dry;
  }

  test(
    "with no proof at all, it names every missing one, and a dry run still says what it would delete",
    async () => {
      const { dir, ids } = await seeded();
      for (const [file] of PROOFS) rmSync(path.join(dir, file));
      const dry = await refusedBoth(dir, ids, PROOFS.map(([, word]) => word).join("+"));
      // One line per refusal, in a fixed order, each saying what is missing.
      const refusedLines = dry.stdout.split("\n").filter((l) => l.includes(": refused "));
      expect(refusedLines).toEqual([
        "drop-archives: refused verified.json-missing",
        "drop-archives: refused new-hash-verified.json-missing",
        "drop-archives: refused git-proof-missing",
        "drop-archives: refused zarr-not-scrubbed: zarr-verified.json missing",
      ]);
    },
    SLOW,
  );

  test(
    "each proof is required on its own",
    async () => {
      // The files the proofs are bound to: the assembly both S3 proofs name, the keymap the git
      // proof names, and the zarr plan the Zarr proof names.
      const required: Array<readonly [string, string]> = [
        ...PROOFS,
        ["assembled.json", "assembled.json-missing"],
        ["keymap.json", "keymap.json-missing"],
        ["zarr-plan.json", "zarr-not-scrubbed"],
      ];
      await concurrently(required, async ([file, word], s) => {
        const { dir, ids } = await seeded(s);
        rmSync(path.join(dir, file));
        await refusedBoth(dir, ids, word, file, s);
      });
    },
    SLOW,
  );

  test(
    "a proof made for another plan, assembly, keymap or dataset is refused",
    async () => {
      // Another plan of the same dataset, with its own Zarr proof and git proof made by the same
      // means as the real ones: the proofs are well formed and name the wrong plan.json.
      const { dir, ids } = await seeded();
      const other = tempDir("other-plan");
      const replan = await runScrub(standin, planArgs(other));
      expect(replan.exitCode, replan.all).toBe(0);
      expect(sha256(readFileSync(path.join(other, "plan.json")))).not.toBe(
        sha256(readFileSync(path.join(dir, "plan.json"))),
      );
      const zarr = await runScrub(standin, ["zarr", "--dir", other, "--execute"]);
      expect(zarr.exitCode, zarr.all).toBe(0);
      cpSync(path.join(dir, "keymap.json"), path.join(other, "keymap.json"));
      writeGitVerified(other);

      const swap = (to: string, file: string) =>
        cpSync(path.join(other, file), path.join(to, file));
      swap(dir, "zarr-verified.json");
      swap(dir, "zarr-plan.json");
      const zarrDry = await refusedBoth(
        dir,
        ids,
        "zarr-not-scrubbed",
        "zarr proof of another plan",
      );
      expect(zarrDry.stdout).toContain("zarr-not-scrubbed: for another plan.json");

      // The S3 proofs name the bytes of another assembly.
      const otherAssembly = sha256(
        Buffer.from(`${readFileSync(path.join(proven, "assembled.json"), "utf8")}\n`),
      );
      // Each scenario starts from a fresh copy of the proven directory and breaks one proof.
      const scenarios: Array<{
        label: string;
        word: string;
        prepare: (dir: string) => void;
        expectDry?: string;
      }> = [
        {
          label: "git proof of another plan",
          word: "git-proof-stale",
          prepare: (d) => swap(d, "git-verified.json"),
          expectDry: "git-proof-stale: names another plan.json",
        },
        {
          // A verify of the local rewrite is not a verify of what was pushed.
          label: "local git proof",
          word: "git-proof-stale",
          prepare: (d) => writeGitVerified(d, { mode: "local" }),
        },
        {
          label: "git proof of another keymap",
          word: "git-proof-stale",
          prepare: (d) => writeGitVerified(d, { keymapSha256: "b".repeat(64) }),
        },
        {
          // Another git plan, when a git-plan.json is in the working directory.
          label: "git proof of another git plan",
          word: "git-proof-stale",
          prepare: (d) => writeFileSync(path.join(d, "git-plan.json"), '{"version":1}\n'),
          expectDry: "git-proof-stale: names another git-plan.json",
        },
        {
          label: "verified.json of another assembly",
          word: "verified-stale",
          prepare: (d) =>
            writeJson(d, "verified.json", {
              ...readJson<Record<string, unknown>>(d, "verified.json"),
              assembledSha256: otherAssembly,
            }),
        },
        {
          label: "re-hash of another assembly",
          word: "new-hash-verified-stale",
          prepare: (d) => writeHashVerified(d, { assembledSha256: otherAssembly }),
        },
        // Another dataset, proof by proof.
        {
          label: "re-hash of another dataset",
          word: "proof-wrong-dataset",
          prepare: (d) => writeHashVerified(d, { dataset: "xx090412" }),
        },
        {
          label: "git proof of another dataset",
          word: "proof-wrong-dataset",
          prepare: (d) => writeGitVerified(d, { dataset: "xx090412" }),
        },
        {
          label: "zarr proof of another dataset",
          word: "zarr-not-scrubbed",
          prepare: (d) =>
            writeJson(d, "zarr-verified.json", {
              ...readJson<ZarrVerifiedFile>(d, "zarr-verified.json"),
              dataset: "xx090412",
            }),
        },
      ];
      await concurrently(scenarios, async (sc, s) => {
        const fresh = await seeded(s);
        sc.prepare(fresh.dir);
        const dry = await refusedBoth(fresh.dir, fresh.ids, sc.word, sc.label, s);
        if (sc.expectDry) expect(dry.stdout, sc.label).toContain(sc.expectDry);
      });
    },
    SLOW,
  );

  test(
    "a proof is read by the contract's strict parser",
    async () => {
      const scenarios: Array<{
        label: string;
        word: string;
        prepare: (dir: string) => void;
        expectDry?: string;
      }> = [
        {
          // A field the contract does not name: not the file git-scrub writes.
          label: "git proof with an extra field",
          word: "git-proof-invalid",
          prepare: (d) =>
            writeJson(d, "git-verified.json", {
              ...readJson<Record<string, unknown>>(d, "git-verified.json"),
              more: 1,
            }),
        },
        {
          // A verify proof without its counts.
          label: "verified.json without counts",
          word: "verified.json-invalid",
          prepare: (d) => {
            const noCounts = Object.entries(readJson<Record<string, unknown>>(d, "verified.json"));
            writeJson(
              d,
              "verified.json",
              Object.fromEntries(noCounts.filter(([k]) => k !== "counts")),
            );
          },
        },
        {
          // Not JSON at all.
          label: "re-hash not JSON",
          word: "new-hash-verified.json-unparseable",
          prepare: (d) => writeFileSync(path.join(d, "new-hash-verified.json"), "{"),
        },
        {
          // A Zarr proof whose counts do not add up.
          label: "zarr counts",
          word: "zarr-not-scrubbed",
          prepare: (d) =>
            writeJson(d, "zarr-verified.json", {
              ...readJson<ZarrVerifiedFile>(d, "zarr-verified.json"),
              counts: { stores: 5, docs: 5, rewritten: 1, untouched: 1 },
            }),
          expectDry: "zarr-not-scrubbed: zarr-verified.json unreadable or invalid",
        },
      ];
      await concurrently(scenarios, async (sc, s) => {
        const { dir, ids } = await seeded(s);
        sc.prepare(dir);
        const dry = await refusedBoth(dir, ids, sc.word, sc.label, s);
        if (sc.expectDry) expect(dry.stdout, sc.label).toContain(sc.expectDry);
      });
    },
    SLOW,
  );

  test(
    "a no-zarr proof stands only while no Zarr object is current",
    async () => {
      await concurrently(["over-a-store", "empty-prefix"] as const, async (scenario, s) => {
        const { dir, ids } = await seeded(s);
        if (scenario === "over-a-store") {
          // The proof of an empty prefix, for this plan, while a store root is current: refused.
          writeJson(dir, "zarr-verified.json", {
            ...readJson<ZarrVerifiedFile>(dir, "zarr-verified.json"),
            found: "no-zarr",
            stores: [],
            counts: { stores: 0, docs: 0, rewritten: 0, untouched: 0 },
          });
          const dry = await refusedBoth(dir, ids, "zarr-not-scrubbed", "no-zarr over a store", s);
          expect(dry.stdout).toContain("says no-zarr while Zarr objects are current");
          return;
        }
        // A dataset with no Zarr copy: the zarr stage proves no-zarr, and that is enough.
        for (const v of [...s.versions(BUCKET, ZARR_ROOT)]) {
          s.dropVersion(BUCKET, ZARR_ROOT, v.versionId);
        }
        const zarr = await runScrub(s, ["zarr", "--dir", dir, "--execute"]);
        expect(zarr.exitCode, zarr.all).toBe(0);
        expect(readJson<ZarrVerifiedFile>(dir, "zarr-verified.json").found).toBe("no-zarr");
        s.log.length = 0;
        const r = await runScrub(s, dropArgs(dir, ["--execute"]));
        expect(r.exitCode, r.all).toBe(0);
        expect(batchDeleted(s).length).toBe(7);
      });
    },
    SLOW,
  );
});

describe("drop-archives: proofs and stage files (S2, S1)", () => {
  test(
    "an archives-dropped.json from an earlier run does not outlive a run that does not finish",
    async () => {
      const { dir } = await seeded();
      writeFileSync(path.join(dir, "archives-dropped.json"), '{"stale":true}');
      // A dry run proves nothing, so it leaves no proof, old or new.
      const dry = await runScrub(standin, dropArgs(dir));
      expect(dry.exitCode, dry.all).toBe(0);
      expect(has(dir, "archives-dropped.json")).toBe(false);
      // Nor does a refused run.
      writeFileSync(path.join(dir, "archives-dropped.json"), '{"stale":true}');
      rmSync(path.join(dir, "git-verified.json"));
      expectStopped(await runScrub(standin, dropArgs(dir, ["--execute"])), 3, "git-proof-missing");
      expect(has(dir, "archives-dropped.json")).toBe(false);
    },
    SLOW,
  );

  test(
    "a stage file that is there and cannot be read is a failure, not a missing file",
    async () => {
      const { dir } = await seeded();
      const planPath = path.join(dir, "plan.json");
      const text = readFileSync(planPath);
      rmSync(planPath);
      mkdirSync(planPath); // a directory where the file should be: EISDIR, not ENOENT
      const r = await runScrub(standin, dropArgs(dir));
      expectStopped(r, 1, "plan.json-unreadable");
      rmSync(planPath, { recursive: true });
      writeFileSync(planPath, text);
      rmSync(planPath);
      expectStopped(await runScrub(standin, dropArgs(dir)), 3, "plan.json-missing");
      expect(standin.log.length).toBe(0);

      // A proof that is there and cannot be read stops the stage as a failure too, not as a
      // refusal among others.
      writeFileSync(planPath, text);
      const proof = path.join(dir, "git-verified.json");
      rmSync(proof);
      mkdirSync(proof);
      expectStopped(await runScrub(standin, dropArgs(dir)), 1, "git-proof-unreadable");
      expect(deleteRequests(standin)).toBe(0);
    },
    SLOW,
  );
});
