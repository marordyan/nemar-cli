/**
 * The zarr stage, run as the real CLI with the real `aws` CLI against the S3 stand-in.
 *
 * Every store, key and value is invented. The stores carry identifier keys with content on
 * purpose, so a test can look for them in whatever the stage printed or wrote and fail if one
 * appears, and can compare what the stage left in S3 with an expectation built independently, by
 * structure, from the same document.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  type PlanFile,
  type ZarrPlanFile,
  type ZarrVerifiedFile,
  parseZarrVerified,
} from "../../../scripts/scrub/contract";
import { TEST_LOOPBACK_PUBLIC_BASE_ENV } from "../../../scripts/scrub/s3/s3-stages";
import { type S3Standin, type Snapshot, startS3Standin } from "../helpers/s3-standin";
import { BATCH_SLOW, makeLimiter, settleAll } from "./concurrency";
import { expectStopped, expectUsage } from "./refusal";
import {
  BUCKET,
  DATASET,
  MIB,
  type PublicEndpoint,
  SLOW,
  addUnreadableKey,
  copyDir,
  deleteRequests,
  dirText,
  fileSha256,
  fixtureD,
  has,
  leaksAName,
  planArgs,
  readJson,
  removeTempDirs,
  runScrub as runScrubUnbounded,
  seedManifest,
  seedObject,
  sha256,
  startPublicEndpoint,
  tempDir,
  writeJson,
} from "./support";

afterAll(removeTempDirs);

/**
 * Every test makes a stand-in (and, for zarr-public, a public endpoint) of its own and takes it
 * from here, so the tests that are declared `test.concurrent` share nothing. Bun runs a run of
 * adjacent concurrent tests together, and `runScrub` lets at most SLOTS real CLI runs be in
 * flight at once, in a group or inside a test, so the four-core CI runner is never given more.
 */
const opened: S3Standin[] = [];
const endpoints: PublicEndpoint[] = [];
function open(): S3Standin {
  const s = startS3Standin();
  opened.push(s);
  return s;
}
function openPublic(): PublicEndpoint {
  const e = startPublicEndpoint();
  endpoints.push(e);
  return e;
}
afterAll(() => {
  for (const s of opened) s.stop();
  for (const e of endpoints) e.stop();
});

const SLOTS = 3;
const limit = makeLimiter(SLOTS);
const runScrub = (...args: Parameters<typeof runScrubUnbounded>) =>
  limit(() => runScrubUnbounded(...args));

/**
 * The working directory the plan stage leaves for the dataset every test below uses (one clean
 * recording). The zarr stage reads plan.json for the dataset, the bucket and the digest its
 * proof is bound to, and nothing else of the plan, so each test gets a copy of this one real
 * plan instead of running the plan stage again.
 */
let planned: string;
beforeAll(async () => {
  const s = startS3Standin();
  try {
    const d = fixtureD();
    seedObject(s, d);
    seedManifest(s, "v1.0.0", [d]);
    planned = tempDir("zarr-planned");
    const plan = await runScrub(s, planArgs(planned));
    expect(plan.exitCode, plan.all).toBe(0);
  } finally {
    s.stop();
  }
}, SLOW);

/** A fresh stand-in holding the dataset's recording, and a copy of its plan's working directory. */
function withPlan(): { standin: S3Standin; dir: string } {
  const standin = open();
  const d = fixtureD();
  seedObject(standin, d);
  seedManifest(standin, "v1.0.0", [d]);
  return { standin, dir: copyDir(planned) };
}

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

const ROOT = `${DATASET}/zarr/sub-01/eeg`;
const storeKey = (name: string) => `${ROOT}/${name}.zarr/zarr.json`;
const A = storeKey("a-pretty");
const B = storeKey("b-compact");
const C = storeKey("c-clean");

/** Values that must appear nowhere the stage prints or writes. */
const VALUES = [
  "P0042",
  "Marigold",
  "Thistlewood",
  "03-JUL-1971",
  "1971-07-03",
  "A-9981",
  "A-7731",
  "Wilhelmina",
  "BioSemi",
  "P9999",
];

/**
 * What biosigio's EDF importer writes into `recording_metadata` (every identification field it
 * reads from the header), plus scanner keys elsewhere in the attributes.
 */
const dirtyAttributes = () => ({
  recording_metadata: {
    patientcode: "P0042 Marigold",
    birthdate: "03-JUL-1971",
    startdate: "02.02.20",
    gender: "F",
    equipment: "BioSemi",
    patientname: "Thistlewood",
    patient_additional: "Hieronymus",
    admincode: "A-7731",
    technician: "Wilhelmina Fairweather",
    recording_additional: "Bellweather lab",
  },
  channels: [{ name: "Fz", dob: "1971-07-03" }],
  history: { mrn: "A-9981", note: "kept" },
});

/**
 * The same attributes with the eleven identifier and subject members dropped, written out by
 * hand: `gender` goes too (a store says nothing about the subject; participants.tsv keeps sex).
 */
const cleanedAttributes = () => ({
  recording_metadata: { startdate: "02.02.20" },
  channels: [{ name: "Fz" }],
  history: { note: "kept" },
});

const wrap = (attributes: unknown) => ({ zarr_format: 3, node_type: "group", attributes });

const prettyDirty = `${JSON.stringify(wrap(dirtyAttributes()), null, 2)}\n`;
const prettyCleaned = `${JSON.stringify(wrap(cleanedAttributes()), null, 2)}\n`;
const compactDirty = JSON.stringify(
  wrap({
    recording_metadata: { patientcode: "P0043 Marigold", birthdate: "04-AUG-1972", gender: "M" },
  }),
);
const compactCleaned = JSON.stringify(wrap({ recording_metadata: {} }));
// A review-severity key (an email) is a key the scanner knows: neither removed nor refused.
const cleanDoc = JSON.stringify(
  wrap({ recording_metadata: { startdate: "02.02.20", email: "a@b.test" } }),
);
/** An array's own metadata inside store A: read, cleaned and re-read like a root. */
const N = `${ROOT}/a-pretty.zarr/data/zarr.json`;
const nestedDirty = JSON.stringify({
  zarr_format: 3,
  node_type: "array",
  attributes: { patientcode: "P9999" },
});
const nestedCleaned = JSON.stringify({ zarr_format: 3, node_type: "array", attributes: {} });

interface Seeded {
  standin: S3Standin;
  dir: string;
  /** The other objects of the Zarr copy, which the stage must never touch. */
  others: Record<string, Uint8Array>;
}

/** A dataset with a plan, and a Zarr copy: two dirty store roots, one clean, and other objects. */
async function seeded(): Promise<Seeded> {
  const { standin, dir } = withPlan();

  standin.putObject(BUCKET, A, enc(prettyDirty), {
    contentType: "application/json",
    cacheControl: "max-age=60",
    sse: "AES256",
  });
  standin.putObject(BUCKET, B, enc(compactDirty), { contentType: "application/json" });
  standin.putObject(BUCKET, C, enc(cleanDoc), { contentType: "application/json" });
  standin.putObject(BUCKET, N, enc(nestedDirty), { contentType: "application/json" });
  const others: Record<string, Uint8Array> = {
    // A chunk and the index: never read or rewritten.
    [`${ROOT}/a-pretty.zarr/data/c/0/0`]: new Uint8Array([1, 2, 3, 4]),
    [`${DATASET}/zarr/index.json`]: enc(JSON.stringify({ stores: 3 })),
  };
  for (const [k, v] of Object.entries(others)) standin.putObject(BUCKET, k, v);
  standin.log.length = 0;
  return { standin, dir, others };
}

const zarrArgs = (dir: string, extra: string[] = []) => [
  "zarr",
  "--dir",
  dir,
  "--concurrency",
  "1",
  ...extra,
];

const text = (standin: S3Standin, key: string) =>
  dec((standin.current(BUCKET, key) as { data: Uint8Array }).data);
const versionsOf = (standin: S3Standin, key: string) => standin.versions(BUCKET, key);
const mode = (dir: string, name: string) => statSync(path.join(dir, name)).mode & 0o777;

function expectNoValue(output: string, dir: string) {
  const everything = `${output}\n${dirText(dir)}`;
  expect(leaksAName(everything)).toBeNull();
  for (const v of VALUES) expect(everything, v).not.toContain(v);
}

describe("zarr: a dry run", () => {
  test(
    "reads, reports what it would remove, writes a private plan, and changes nothing",
    async () => {
      const { dir, standin } = await seeded();
      // A proof from an earlier run is not left standing by a run that did not re-prove.
      writeFileSync(path.join(dir, "zarr-verified.json"), "{}");

      const r = await runScrub(standin, zarrArgs(dir));
      expect(r.exitCode, r.all).toBe(0);
      expect(r.stdout).toContain("zarr dry run (nothing written to S3)");
      expect(r.stdout).toContain(
        "stores=3 docs=4 clean=1 needScrub=3 unreadable=0 unknownMembers=0 failed=0",
      );

      // Only reads: a listing, a HEAD and a GET per store, never a write.
      expect([...new Set<string>(standin.log.map((x) => x.op))].sort()).toEqual(
        ["GetObject", "HeadObject", "ListObjectsV2"].sort(),
      );
      // Every store root, then every zarr.json inside a store.
      expect(standin.calls("GetObject").map((c) => c.key)).toEqual([A, B, C, N]);
      for (const k of [A, B, C, N]) expect(versionsOf(standin, k).length).toBe(1);

      const plan = readJson<ZarrPlanFile>(dir, "zarr-plan.json");
      expect(plan.executed).toBe(false);
      expect(plan.dataset).toBe(DATASET);
      expect(plan.planSha256).toBe(fileSha256(dir, "plan.json"));
      expect(plan.found).toBe("stores");
      expect(plan.outcomes).toEqual({ "needs-scrub": 3, clean: 1 });
      // A: nine mirrored members, a dob and an mrn; B: three; N: one.
      expect(plan.removedMembers).toBe(15);
      // The set of keys examined is named by a digest computed here; no key is stored.
      expect(plan.keysSha256).toBe(sha256(enc([A, B, C, N].sort().join("\n"))));
      const planText = readFileSync(path.join(dir, "zarr-plan.json"), "utf8");
      for (const k of [A, B, C]) expect(planText).not.toContain(k);
      expect(planText).not.toContain("zarr.json");
      expect(planText).not.toContain("sub-01");
      expect(plan.totals).toEqual({
        stores: 3,
        docs: 4,
        clean: 1,
        needScrub: 3,
        scrubbed: 0,
        unreadable: 0,
        unknownMembers: 0,
        failed: 0,
      });
      expect(has(dir, "zarr-verified.json")).toBe(false);
      expect(mode(dir, "zarr-plan.json")).toBe(0o600);
      expectNoValue(r.all, dir);
    },
    SLOW,
  );
});

describe("zarr: --execute", () => {
  test.concurrent(
    "removes exactly the identifier keys, conditionally, and leaves every other object alone",
    async () => {
      const { dir, others, standin } = await seeded();
      const before = {
        a: versionsOf(standin, A)[0]?.etag as string,
        b: versionsOf(standin, B)[0]?.etag as string,
        c: versionsOf(standin, C)[0]?.etag as string,
        n: versionsOf(standin, N)[0]?.etag as string,
      };

      const r = await runScrub(standin, zarrArgs(dir, ["--execute"]));
      expect(r.exitCode, r.all).toBe(0);
      expect(r.stdout).toContain(
        "stores=3 docs=4 clean=1 scrubbed=3 unreadable=0 unknownMembers=0 failed=0",
      );
      expect(r.stdout).toContain("zarr: ok");

      // The rewritten roots are the original minus the identifier members, in the original layout.
      expect(text(standin, A)).toBe(prettyCleaned);
      expect(text(standin, B)).toBe(compactCleaned);
      expect(text(standin, N)).toBe(nestedCleaned);
      for (const v of VALUES) {
        expect(text(standin, A), v).not.toContain(v);
        expect(text(standin, B), v).not.toContain(v);
        expect(text(standin, N), v).not.toContain(v);
      }
      // The fields that stay are the ones that were not identifiers or about the subject.
      expect(JSON.parse(text(standin, A)).attributes.recording_metadata).toEqual({
        startdate: "02.02.20",
      });

      // A new version each; the original is still there, noncurrent, for the prune to remove.
      for (const k of [A, B]) {
        expect(versionsOf(standin, k).length, k).toBe(2);
        expect(versionsOf(standin, k)[1]?.deleteMarker).toBe(false);
      }
      expect(dec((versionsOf(standin, A)[0] as { data: Uint8Array }).data)).toBe(prettyDirty);

      // Each write named the ETag it read, so a writer in between would have been refused.
      const puts = standin.calls("PutObject");
      expect(puts.map((p) => [p.key, p.status, p.ifMatch])).toEqual([
        [A, 200, before.a],
        [B, 200, before.b],
        [N, 200, before.n],
      ]);
      // The metadata the object had is the metadata it keeps.
      const rewritten = standin.current(BUCKET, A);
      expect(rewritten?.contentType).toBe("application/json");
      expect(rewritten?.cacheControl).toBe("max-age=60");
      expect(rewritten?.sse).toBe("AES256");

      // The clean root and every other object of the Zarr copy: no new version, same bytes.
      expect(versionsOf(standin, C).length).toBe(1);
      expect(versionsOf(standin, C)[0]?.etag).toBe(before.c);
      for (const [k, v] of Object.entries(others)) {
        expect(versionsOf(standin, k).length, k).toBe(1);
        expect(Buffer.compare(standin.current(BUCKET, k)?.data as Uint8Array, v), k).toBe(0);
      }
      expect(deleteRequests(standin)).toBe(0);

      // The record of the run, and the proof bound to it.
      const plan = readJson<ZarrPlanFile>(dir, "zarr-plan.json");
      expect(plan.executed).toBe(true);
      expect(plan.outcomes).toEqual({ scrubbed: 3, clean: 1 });
      const proof = parseZarrVerified(readFileSync(path.join(dir, "zarr-verified.json"), "utf8"));
      expect(proof.dataset).toBe(DATASET);
      expect(proof.planSha256).toBe(fileSha256(dir, "plan.json"));
      expect(proof.zarrPlanSha256).toBe(fileSha256(dir, "zarr-plan.json"));
      expect(proof.counts).toEqual({ stores: 3, docs: 4, rewritten: 3, untouched: 1 });
      // The store roots it proved, as index.json spells them, for zarr-public's union.
      expect(proof.stores).toEqual([
        "sub-01/eeg/a-pretty.zarr",
        "sub-01/eeg/b-compact.zarr",
        "sub-01/eeg/c-clean.zarr",
      ]);
      expect(proof.allowedMembers).toEqual([]);
      expect(mode(dir, "zarr-plan.json")).toBe(0o600);
      expect(mode(dir, "zarr-verified.json")).toBe(0o600);
      expectNoValue(r.all, dir);

      // Run again: nothing is left to remove, so nothing is written, and the proof is renewed.
      standin.log.length = 0;
      const again = await runScrub(standin, zarrArgs(dir, ["--execute"]));
      expect(again.exitCode, again.all).toBe(0);
      expect(standin.calls("PutObject").length).toBe(0);
      for (const k of [A, B, C]) expect(versionsOf(standin, k).length).toBe(k === C ? 1 : 2);
      const renewed = readJson<ZarrVerifiedFile>(dir, "zarr-verified.json");
      expect(renewed.counts).toEqual({ stores: 3, docs: 4, rewritten: 0, untouched: 4 });
    },
    BATCH_SLOW,
  );

  test.concurrent(
    "a store root changed since it was read is never overwritten, and a re-run finishes the job",
    async () => {
      const { dir, standin } = await seeded();
      // Just as the first write begins, another writer replaces A with a newer version that still
      // has identifiers (and a key of its own).
      const newer = JSON.stringify(
        wrap({ ...dirtyAttributes(), later: { added: "by another writer" } }),
      );
      standin.beforeOp("PutObject", () => {
        standin.putObject(BUCKET, A, enc(newer), { contentType: "application/json" });
      });

      const r = await runScrub(standin, zarrArgs(dir, ["--execute"]));
      expect(r.exitCode, r.all).toBe(1);
      expect(r.stdout).toContain("changed-concurrently=1");
      expect(r.stdout).toContain("zarr-verified.json NOT written");
      expect(has(dir, "zarr-verified.json")).toBe(false);

      // The other writer's version stands: our stale write was refused, not applied on top.
      expect(text(standin, A)).toBe(newer);
      expect(versionsOf(standin, A).length).toBe(2);
      expect(standin.calls("PutObject").find((p) => p.key === A)?.status).toBe(412);
      // The other store was independent of it and was scrubbed.
      expect(text(standin, B)).toBe(compactCleaned);

      // Nothing blocks a second run: it reads what is there now, removes the keys, keeps theirs.
      const again = await runScrub(standin, zarrArgs(dir, ["--execute"]));
      expect(again.exitCode, again.all).toBe(0);
      const finalA = JSON.parse(text(standin, A));
      expect(finalA.attributes.later).toEqual({ added: "by another writer" });
      expect(finalA.attributes.recording_metadata).toEqual({ startdate: "02.02.20" });
      expect(versionsOf(standin, A).length).toBe(3);
      expect(has(dir, "zarr-verified.json")).toBe(true);
    },
    BATCH_SLOW,
  );

  test.concurrent(
    "a conflicting-write refusal (409) is a store changed concurrently, never a rewrite",
    async () => {
      const { dir, standin } = await seeded();
      standin.inject("PutObject", { code: "ConditionalRequestConflict", status: 409, key: A });
      const r = await runScrub(standin, zarrArgs(dir, ["--execute"]));
      expect(r.exitCode, r.all).toBe(1);
      expect(r.stdout).toContain("changed-concurrently=1");
      expect(has(dir, "zarr-verified.json")).toBe(false);
      expect(text(standin, A)).toBe(prettyDirty);
    },
    BATCH_SLOW,
  );

  test(
    "a store that is dirty again when read back is not clean, and nothing is proven",
    async () => {
      const { dir, standin } = await seeded();
      // Reads, in order with one worker: A, then A again after its write. Just before that second
      // read, a writer puts a dirty version back.
      // The stand-in counts every GET since it started (the plan's too), so the hook is armed
      // for each of the next few and fires on the second of the ones the stage makes.
      let reads = 0;
      for (let nth = 1; nth <= 40; nth++) {
        standin.beforeOp(
          "GetObject",
          () => {
            reads += 1;
            if (reads === 2) standin.putObject(BUCKET, A, enc(prettyDirty));
          },
          nth,
        );
      }
      const r = await runScrub(standin, zarrArgs(dir, ["--execute"]));
      expect(r.exitCode, r.all).toBe(1);
      expect(r.stdout).toContain("verify-failed=1");
      expect(has(dir, "zarr-verified.json")).toBe(false);
      expect(text(standin, A)).toBe(prettyDirty);
      expect(readJson<ZarrPlanFile>(dir, "zarr-plan.json").outcomes).toEqual({
        "verify-failed": 1,
        scrubbed: 2,
        clean: 1,
      });
    },
    SLOW,
  );

  test.concurrent(
    "a store that cannot be read or cleaned is counted, the plan is incomplete, and nothing is proven",
    async () => {
      const { dir, standin } = await seeded();
      const D = storeKey("d-malformed");
      const E = storeKey("e-not-utf8");
      const F = storeKey("f-too-large");
      const G = storeKey("g-outside");
      const V2 = `${DATASET}/zarr/sub-02/old.zarr/.zattrs`;
      standin.putObject(BUCKET, D, enc("Marigold Thistlewood is not json"));
      standin.putObject(BUCKET, E, new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]));
      // A zarr.json is a few KiB; this one is not metadata and is never read.
      const huge = new Uint8Array(17 * MIB).fill(0x20);
      huge.set(enc('{"attributes":{}}'), 0);
      standin.putObject(BUCKET, F, huge);
      // An identifier key outside `attributes`, which the stage does not reach, beside one inside.
      const outside = JSON.stringify({
        zarr_format: 3,
        patientcode: "P0044",
        attributes: { mrn: "A-9981" },
      });
      standin.putObject(BUCKET, G, enc(outside));
      standin.putObject(BUCKET, V2, enc("{}"));
      standin.log.length = 0;

      for (const flag of [[], ["--execute"]]) {
        const r = await runScrub(standin, zarrArgs(dir, flag));
        expect(r.exitCode, r.all).toBe(4);
        expect(r.stdout).toContain("incomplete");
        expect(r.stdout).toContain("zarr-json-malformed=2");
        expect(r.stdout).toContain("zarr-json-too-large=1");
        expect(r.stdout).toContain("identifier-outside-attributes=1");
        expect(r.stdout).toContain("zarr-v2-metadata=1");
        // The v2 store has no zarr.json at its root, so it is also a store without a root.
        expect(r.stdout).toContain("store-root-missing=1");
        expect(has(dir, "zarr-verified.json")).toBe(false);
        expect(leaksAName(r.all)).toBeNull();
        expect(r.all).not.toContain("P0044");
      }
      // The ones it could not clean are exactly as they were; the one it could was cleaned.
      for (const k of [D, E, F, G, V2]) expect(versionsOf(standin, k).length, k).toBe(1);
      expect(text(standin, G)).toBe(outside);
      expect(text(standin, A)).toBe(prettyCleaned);
      const plan = readJson<ZarrPlanFile>(dir, "zarr-plan.json");
      expect(plan.totals.unreadable).toBe(6);
      expect(plan.totals.failed).toBe(0);
    },
    BATCH_SLOW,
  );

  test.concurrent(
    "a store that cannot be read at all is a failure, not a clean store",
    async () => {
      const { dir, standin } = await seeded();
      standin.inject("GetObject", { code: "InternalError", status: 500, key: B });
      const r = await runScrub(standin, zarrArgs(dir, ["--execute"]));
      expect(r.exitCode, r.all).toBe(1);
      expect(r.stdout).toContain("GetObject:failed=1");
      expect(has(dir, "zarr-verified.json")).toBe(false);
      expect(versionsOf(standin, B).length).toBe(1);
    },
    BATCH_SLOW,
  );
});

describe("zarr: the EDF identification fields the converter mirrors", () => {
  test(
    "a store whose only identifier is a mirrored field the scanner does not know is not clean",
    async () => {
      const { dir, standin } = await seeded();
      // Reviewer probe T6: a technician's name and free text from the patient field, and nothing
      // the scanner calls an identifier. Before the mirror list this store was "clean".
      const T = storeKey("t-technician");
      const doc = JSON.stringify(
        wrap({
          recording_metadata: {
            gender: "F",
            startdate: "02.02.20",
            technician: "Wilhelmina Fairweather",
            patient_additional: "Hieronymus",
            admincode: "A-7731",
            recording_additional: "Bellweather lab",
            equipment: "BioSemi",
          },
        }),
      );
      standin.putObject(BUCKET, T, enc(doc), { contentType: "application/json" });

      const dry = await runScrub(standin, zarrArgs(dir));
      expect(dry.exitCode, dry.all).toBe(0);
      expect(dry.stdout).toContain("stores=4 docs=5 clean=1 needScrub=4");

      const r = await runScrub(standin, zarrArgs(dir, ["--execute"]));
      expect(r.exitCode, r.all).toBe(0);
      expect(JSON.parse(text(standin, T))).toEqual(
        wrap({ recording_metadata: { startdate: "02.02.20" } }),
      );
      for (const v of ["Wilhelmina", "Fairweather", "Hieronymus", "A-7731", "Bellweather"]) {
        expect(text(standin, T), v).not.toContain(v);
      }
      expect(readJson<ZarrVerifiedFile>(dir, "zarr-verified.json").counts.rewritten).toBe(4);
      expectNoValue(r.all, dir);
    },
    SLOW,
  );
});

describe("zarr-public: the check from outside after publication", () => {
  const index = (stores: string[]) =>
    enc(JSON.stringify({ dataset_id: DATASET, stores: stores.map((zarr) => ({ zarr })) }));
  const rel = (key: string) => key.slice(`${DATASET}/zarr/`.length, -"/zarr.json".length);

  /**
   * The zarr stage has run (its proof names A, B, C), the dataset's index names A, B, C, and a
   * public reader serves the stand-in's current objects.
   */
  let publishedSnap: Snapshot;
  let publishedDir: string;
  beforeAll(async () => {
    // The zarr stage runs for real, once, and every test below starts from what it left: the
    // stand-in's contents and the working directory with its proof. None of them changes the
    // proof, and each gets a stand-in and a copy of its own.
    const built = await seeded();
    const scrub = await runScrub(built.standin, zarrArgs(built.dir, ["--execute"]));
    expect(scrub.exitCode, scrub.all).toBe(0);
    built.standin.putObject(BUCKET, `${DATASET}/zarr/index.json`, index([A, B, C].map(rel)));
    publishedSnap = built.standin.snapshot();
    publishedDir = built.dir;
  }, SLOW);

  async function published(): Promise<{ dir: string; standin: S3Standin; pub: PublicEndpoint }> {
    const standin = open();
    standin.restore(publishedSnap);
    const pub = openPublic();
    pub.serve = (key) => standin.current(BUCKET, key)?.data;
    return { dir: copyDir(publishedDir), standin, pub };
  }
  const publicArgs = (dir: string, pub: PublicEndpoint) => [
    "zarr-public",
    "--dataset",
    DATASET,
    "--zarr-verified",
    path.join(dir, "zarr-verified.json"),
    "--public-base",
    pub.url,
  ];

  test.concurrent(
    "asks the zarr stage's own question of every store, anonymously",
    async () => {
      const { dir, standin, pub } = await published();
      const after = await runScrub(standin, publicArgs(dir, pub));
      expect(after.exitCode, after.all).toBe(0);
      expect(after.stdout).toContain("stores=3 clean=3 identifier=0 unknownMembers=0 unreadable=0");
      // Anonymous GETs only: the index, then each store root.
      for (const req of pub.requests) {
        expect(req.method).toBe("GET");
        expect(req.headers.authorization).toBeUndefined();
      }
      expect(pub.requests.map((q) => q.path).sort()).toEqual(
        [`/${DATASET}/zarr/index.json`, ...[A, B, C].map((k) => `/${k}`)].sort(),
      );

      // Dirty again after publication: found from outside.
      standin.putObject(BUCKET, A, enc(prettyDirty));
      standin.putObject(BUCKET, B, enc(compactDirty));
      const before = await runScrub(standin, publicArgs(dir, pub));
      expect(before.exitCode, before.all).toBe(1);
      expect(before.stdout).toContain("stores=3 clean=1 identifier=2 unknownMembers=0");
      expectNoValue(before.all, dir);
    },
    BATCH_SLOW,
  );

  test.concurrent(
    "a mirrored field the scanner does not know, and a member no list names, fail it too",
    async () => {
      const { dir, standin, pub } = await published();
      standin.putObject(
        BUCKET,
        A,
        enc(JSON.stringify(wrap({ recording_metadata: { technician: "Wilhelmina" } }))),
      );
      standin.putObject(
        BUCKET,
        B,
        enc(JSON.stringify(wrap({ recording_metadata: { subject_note: "Hieronymus" } }))),
      );
      const r = await runScrub(standin, publicArgs(dir, pub));
      expect(r.exitCode, r.all).toBe(1);
      expect(r.stdout).toContain("stores=3 clean=1 identifier=1 unknownMembers=1 unreadable=0");
      expect(r.all).not.toContain("Wilhelmina");
      expect(r.all).not.toContain("Hieronymus");
    },
    BATCH_SLOW,
  );

  test.concurrent(
    "the stores checked are the UNION of the index and the proof; a proved store the index lacks is refused (C2)",
    async () => {
      const { dir, standin, pub } = await published();
      // An index that forgot C: the proof says C exists.
      standin.putObject(BUCKET, `${DATASET}/zarr/index.json`, index([A, B].map(rel)));
      const r = await runScrub(standin, publicArgs(dir, pub));
      expectStopped(r, 3, "store-not-in-index");
      expect(r.stdout).toContain("1 store(s) the zarr stage proved are not in index.json");
      // An index of nothing at all, beside a proof of three stores.
      standin.putObject(BUCKET, `${DATASET}/zarr/index.json`, enc('{"stores": []}'));
      expectStopped(await runScrub(standin, publicArgs(dir, pub)), 3, "store-not-in-index");
      // A store the index names that the proof does not: checked too, and found dirty.
      const D = storeKey("d-late");
      standin.putObject(BUCKET, D, enc(compactDirty));
      standin.putObject(BUCKET, `${DATASET}/zarr/index.json`, index([A, B, C, D].map(rel)));
      const late = await runScrub(standin, publicArgs(dir, pub));
      expect(late.exitCode, late.all).toBe(1);
      expect(late.stdout).toContain("stores=4 clean=3 identifier=1");
    },
    BATCH_SLOW,
  );

  test.concurrent(
    "no store at all passes only when the zarr stage recorded no-zarr (C2)",
    async () => {
      const { dir, standin } = withPlan();
      expect((await runScrub(standin, zarrArgs(dir, ["--execute"]))).exitCode).toBe(0);
      expect(readJson<ZarrVerifiedFile>(dir, "zarr-verified.json").found).toBe("no-zarr");
      const pub = openPublic();
      pub.serve = (key) => standin.current(BUCKET, key)?.data;
      // No index (403) and no store: the proof says there is none, so that is the answer.
      const none = await runScrub(standin, publicArgs(dir, pub));
      expect(none.exitCode, none.all).toBe(0);
      expect(none.stdout).toContain("no Zarr copy");
      // A proof that says stores but names none is not a proof the contract accepts.
      const proof = readJson<ZarrVerifiedFile>(dir, "zarr-verified.json");
      writeJson(dir, "zarr-verified.json", { ...proof, found: "stores" });
      expectStopped(await runScrub(standin, publicArgs(dir, pub)), 3, "zarr-verified.json-invalid");
      // Another dataset's proof.
      writeJson(dir, "zarr-verified.json", { ...proof, dataset: "xx090412" });
      expectStopped(
        await runScrub(standin, publicArgs(dir, pub)),
        3,
        "zarr-verified-wrong-dataset",
      );
      rmSync(path.join(dir, "zarr-verified.json"));
      expectStopped(await runScrub(standin, publicArgs(dir, pub)), 3, "zarr-verified.json-missing");
    },
    BATCH_SLOW,
  );

  test.concurrent(
    "the public base must be the bucket's https S3 endpoint outside a test, before any request",
    async () => {
      const { dir, standin, pub } = await published();
      const outside = { [TEST_LOOPBACK_PUBLIC_BASE_ENV]: "" };
      // Only hosts no request can reach: a regression here must not send one to the real bucket.
      await settleAll(
        [pub.url, "https://evil.example"].map(async (base) => {
          const args = publicArgs(dir, pub);
          args[args.length - 1] = base;
          const r = await runScrub(standin, args, outside, { anyPublicBase: true });
          expectUsage(r, "bad-public-base", base);
        }),
      );
      expect(pub.requests.length).toBe(0);
    },
    BATCH_SLOW,
  );

  test.concurrent(
    "a store or an index it cannot read proves nothing",
    async () => {
      const { dir, standin, pub } = await published();
      // C is named by the index and not served: 403, as for a missing key.
      standin.putDeleteMarker(BUCKET, C);
      const r = await runScrub(standin, publicArgs(dir, pub));
      expect(r.exitCode, r.all).toBe(4);
      expect(r.stdout).toContain("http-403=1");

      standin.putDeleteMarker(BUCKET, `${DATASET}/zarr/index.json`);
      expectStopped(await runScrub(standin, publicArgs(dir, pub)), 4, "index-unreadable");

      standin.putObject(BUCKET, `${DATASET}/zarr/index.json`, index(["../../objects/x.zarr"]));
      expectStopped(await runScrub(standin, publicArgs(dir, pub)), 4, "index-malformed");
    },
    BATCH_SLOW,
  );
});

describe("zarr: a proof is never vacuous", () => {
  test.concurrent(
    "objects under the prefix and no store root: unreadable, and no proof is written",
    async () => {
      const { dir, others, standin } = await seeded();
      // Reviewer probe T7: only a dirty zarr.json under a directory without the .zarr suffix, and
      // an index. Before, that was "every one of 0 store roots is clean" and a proof.
      for (const k of [A, B, C]) standin.putDeleteMarker(BUCKET, k);
      const stray = `${DATASET}/zarr/sub-01/eeg/store-without-suffix/zarr.json`;
      standin.putObject(BUCKET, stray, enc(prettyDirty));
      for (const flag of [[], ["--execute"]]) {
        const r = await runScrub(standin, zarrArgs(dir, flag));
        expect(r.exitCode, r.all).toBe(4);
        expect(r.stdout).toContain("stores=0");
        expect(r.stdout).toContain("no-store-root=1");
        expect(r.stdout).toContain("zarr-json-outside-store=1");
        expect(has(dir, "zarr-verified.json")).toBe(false);
      }
      expect(text(standin, stray)).toBe(prettyDirty);

      // Nothing but the index: no zarr.json anywhere, and still not a prefix with nothing in it.
      standin.putDeleteMarker(BUCKET, stray);
      for (const k of Object.keys(others)) {
        if (!k.endsWith("index.json")) standin.putDeleteMarker(BUCKET, k);
      }
      const r = await runScrub(standin, zarrArgs(dir, ["--execute"]));
      expect(r.exitCode, r.all).toBe(4);
      expect(r.stdout).toContain("not clean, by reason: no-store-root=1");
      expect(has(dir, "zarr-verified.json")).toBe(false);
    },
    BATCH_SLOW,
  );

  test.concurrent(
    "a zarr.json outside any store, or a store with no root, fails a run that has good stores",
    async () => {
      const { dir, standin } = await seeded();
      standin.putObject(BUCKET, `${DATASET}/zarr/zarr.json`, enc(compactDirty));
      let r = await runScrub(standin, zarrArgs(dir, ["--execute"]));
      expect(r.exitCode, r.all).toBe(4);
      expect(r.stdout).toContain("zarr-json-outside-store=1");
      expect(has(dir, "zarr-verified.json")).toBe(false);

      standin.putDeleteMarker(BUCKET, `${DATASET}/zarr/zarr.json`);
      // Chunks of a store whose root metadata is gone: nothing says what its attributes were.
      standin.putObject(BUCKET, `${ROOT}/rootless.zarr/data/c/0/0`, new Uint8Array([1]));
      r = await runScrub(standin, zarrArgs(dir, ["--execute"]));
      expect(r.exitCode, r.all).toBe(4);
      expect(r.stdout).toContain("store-root-missing=1");
      expect(has(dir, "zarr-verified.json")).toBe(false);
    },
    BATCH_SLOW,
  );

  test.concurrent(
    "a store root that starts with a byte order mark is refused, not rewritten without it",
    async () => {
      const { dir, standin } = await seeded();
      const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...enc(compactDirty)]);
      standin.putObject(BUCKET, B, bom);
      const r = await runScrub(standin, zarrArgs(dir, ["--execute"]));
      expect(r.exitCode, r.all).toBe(4);
      expect(r.stdout).toContain("zarr-json-bom=1");
      expect(versionsOf(standin, B).length).toBe(2);
      expect(Buffer.compare(standin.current(BUCKET, B)?.data as Uint8Array, bom)).toBe(0);
      expect(has(dir, "zarr-verified.json")).toBe(false);
    },
    BATCH_SLOW,
  );
});

describe("zarr: preconditions", () => {
  test(
    "needs a plan to name the dataset and the bucket",
    async () => {
      const standin = open();
      const empty = tempDir("zarr-empty");
      expectStopped(await runScrub(standin, zarrArgs(empty)), 3, "plan.json-missing");

      const bad = tempDir("zarr-badplan");
      const plan = {
        version: 1,
        dataset: "nm1",
        bucket: BUCKET,
        keys: [],
        totals: { keys: 0, needScrub: 0, bytesToHash: 0, unreadable: 0 },
      };
      writeJson(bad, "plan.json", plan);
      const r = await runScrub(standin, zarrArgs(bad));
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("bad-dataset-id");
      // A plan that names no bucket would send every S3 call to `--bucket undefined`.
      writeJson(bad, "plan.json", { ...plan, dataset: DATASET, bucket: undefined });
      expectStopped(await runScrub(standin, zarrArgs(bad)), 3, "plan.json-invalid");
      expect(standin.log.length).toBe(0);
    },
    SLOW,
  );

  test(
    "refuses a plan with a key nobody read, before any S3 call",
    async () => {
      const { dir, standin } = await seeded();
      addUnreadableKey(dir);
      for (const flag of [[], ["--execute"]]) {
        expectStopped(await runScrub(standin, zarrArgs(dir, flag)), 3, "plan-has-unreadable");
      }
      expect(standin.log.length).toBe(0);
      expect(has(dir, "zarr-verified.json")).toBe(false);
    },
    SLOW,
  );

  test(
    "a dataset with no Zarr copy is recorded as no-zarr, and the plan it made is the one named",
    async () => {
      const { dir, standin } = withPlan();
      const r = await runScrub(standin, zarrArgs(dir, ["--execute"]));
      expect(r.exitCode, r.all).toBe(0);
      const proof = readJson<ZarrVerifiedFile>(dir, "zarr-verified.json");
      expect(proof.found).toBe("no-zarr");
      expect(proof.counts).toEqual({ stores: 0, docs: 0, rewritten: 0, untouched: 0 });
      expect(proof.stores).toEqual([]);
      expect(r.stdout).toContain("no Zarr copy");
      expect(proof.planSha256).toBe(fileSha256(dir, "plan.json"));
      const plan = readJson<PlanFile>(dir, "plan.json");
      expect(plan.dataset).toBe(DATASET);
      expect(sha256(readFileSync(path.join(dir, "zarr-plan.json")))).toBe(proof.zarrPlanSha256);
    },
    SLOW,
  );
});

describe("zarr: what a store may keep (I10, T8)", () => {
  /**
   * nm000186's store roots, member for member (census of 2026-10-05, names only, all 88 stores):
   * the four subject and free-text fields, non-empty, beside the technical ones. The values are
   * invented, and `relabelled` below is biosigio's own (British) spelling of a member of its units
   * report, kept as the converter writes it. The converter that wrote the real ones is biosigio 1.2.10
   * (scripts/zarr/requirements.txt); this store is built by hand because the converter cannot be
   * installed here without the network.
   */
  const nm000186Root = (i: number) =>
    JSON.stringify(
      wrap({
        recording_metadata: {
          birthdate: `0${(i % 9) + 1}-JUL-1971`,
          patientcode: `P${1000 + i}`,
          gender: i % 2 ? "F" : "M",
          equipment: "BioSemi ActiveTwo",
          startdate: { __biosigio_type__: "datetime", value: "2020-02-02T10:30:00" },
          source_file: `sub-${i}_task-rest_eeg.bdf`,
          source_format: "bdf",
          number_of_signals: 72,
          filetype: "",
          file_duration: "",
          datarecord_duration: "",
          channels_tsv_units: {
            converted: [],
            kept_importer_unit: [],
            relabelled: [],
            units_column_present: true,
          },
        },
      }),
    );
  const KEPT_186 = [
    "channels_tsv_units",
    "datarecord_duration",
    "file_duration",
    "filetype",
    "number_of_signals",
    "source_file",
    "source_format",
    "startdate",
  ];

  function withStores(docs: Record<string, string>): { standin: S3Standin; dir: string } {
    const { standin, dir } = withPlan();
    for (const [k, v] of Object.entries(docs)) {
      standin.putObject(BUCKET, k, enc(v), { contentType: "application/json" });
    }
    return { standin, dir };
  }

  test(
    "88 stores shaped like nm000186's: exactly patientcode, birthdate, gender and equipment go from each",
    async () => {
      const keys = Array.from({ length: 88 }, (_, i) =>
        storeKey(`sub-${String(i).padStart(3, "0")}_eeg`),
      );
      const { dir, standin } = withStores(
        Object.fromEntries(keys.map((k, i) => [k, nm000186Root(i)])),
      );
      const r = await runScrub(standin, zarrArgs(dir, ["--execute", "--concurrency", "8"]));
      expect(r.exitCode, r.all).toBe(0);
      expect(r.stdout).toContain("stores=88 docs=88 clean=0 scrubbed=88");
      const plan = readJson<ZarrPlanFile>(dir, "zarr-plan.json");
      expect(plan.removedMembers).toBe(88 * 4);
      for (const k of keys) {
        const meta = JSON.parse(text(standin, k)).attributes.recording_metadata as Record<
          string,
          unknown
        >;
        expect(Object.keys(meta).sort(), k).toEqual(KEPT_186);
      }
      // Proven by re-reading every one of the 88.
      const proof = readJson<ZarrVerifiedFile>(dir, "zarr-verified.json");
      expect(proof.counts).toEqual({ stores: 88, docs: 88, rewritten: 88, untouched: 0 });
      expect(proof.stores.length).toBe(88);
    },
    SLOW,
  );

  test.concurrent(
    "stores shaped like nm000348's hold nothing to remove, and that is a clean proof, not a failure",
    async () => {
      const keys = [storeKey("x-1"), storeKey("x-2")];
      const doc = JSON.stringify(
        wrap({
          recording_metadata: {
            channels_tsv_units: { converted: [], units_column_present: false },
            number_of_signals: 23,
            source_file: "sub-1_eeg.edf",
            streamed: true,
          },
        }),
      );
      const { dir, standin } = withStores(Object.fromEntries(keys.map((k) => [k, doc])));
      const r = await runScrub(standin, zarrArgs(dir, ["--execute"]));
      expect(r.exitCode, r.all).toBe(0);
      expect(standin.calls("PutObject").length).toBe(0);
      const proof = readJson<ZarrVerifiedFile>(dir, "zarr-verified.json");
      expect(proof.found).toBe("stores");
      expect(proof.counts).toEqual({ stores: 2, docs: 2, rewritten: 0, untouched: 2 });
    },
    BATCH_SLOW,
  );

  test.concurrent(
    "a member no list names refuses the run, its name (never its value) goes to a private file, and --allow-member accepts it",
    async () => {
      const K = storeKey("k-unknown");
      const doc = JSON.stringify(
        wrap({
          recording_metadata: {
            patientcode: "P0042",
            startdate: "02.02.20",
            subject_note: "Marigold Thistlewood",
          },
        }),
      );
      const { dir, standin } = withStores({ [K]: doc });
      for (const flag of [[], ["--execute"]]) {
        const r = await runScrub(standin, zarrArgs(dir, flag));
        expectStopped(r, 3, "unknown-recording-member");
        expect(r.stdout).toContain("unknown-recording-member in 1 document(s), 1 distinct name(s)");
        expect(has(dir, "zarr-verified.json")).toBe(false);
        expect(readJson<{ names: string[] }>(dir, "zarr-unknown-members.json").names).toEqual([
          "subject_note",
        ]);
        expect(mode(dir, "zarr-unknown-members.json")).toBe(0o600);
        expectNoValue(r.all, dir);
      }
      // Nothing was written to a store it refused.
      expect(versionsOf(standin, K).length).toBe(1);

      const ok = await runScrub(
        standin,
        zarrArgs(dir, ["--execute", "--allow-member", "Subject-Note"]),
      );
      expect(ok.exitCode, ok.all).toBe(0);
      expect(has(dir, "zarr-unknown-members.json")).toBe(false);
      const proof = readJson<ZarrVerifiedFile>(dir, "zarr-verified.json");
      expect(proof.allowedMembers).toEqual(["subjectnote"]);
      // The accepted member stays; the identifier does not.
      expect(JSON.parse(text(standin, K)).attributes.recording_metadata).toEqual({
        startdate: "02.02.20",
        subject_note: "Marigold Thistlewood",
      });
    },
    BATCH_SLOW,
  );

  test(
    "more zarr.json documents than --max-zarr-json is refused before any is read",
    async () => {
      const docs: Record<string, string> = {};
      for (const name of ["m-1", "m-2"]) {
        docs[storeKey(name)] = compactDirty;
        docs[`${ROOT}/${name}.zarr/data/zarr.json`] = nestedDirty;
      }
      const { dir, standin } = withStores(docs);
      standin.log.length = 0;
      const r = await runScrub(standin, zarrArgs(dir, ["--execute", "--max-zarr-json", "3"]));
      expectStopped(r, 3, "too-many-zarr-json");
      expect(r.stdout).toContain("4 zarr.json documents, more than --max-zarr-json 3");
      expect(standin.calls("GetObject").length).toBe(0);
      expect(standin.calls("PutObject").length).toBe(0);
    },
    SLOW,
  );

  test.concurrent(
    "a rewrite keeps the object's SSE-KMS settings (T8)",
    async () => {
      const { dir, standin } = withPlan();
      const kms = "arn:aws:kms:us-east-2:000000000000:key/test-key";
      standin.putObject(BUCKET, B, enc(compactDirty), {
        contentType: "application/json",
        sse: "aws:kms",
        kmsKeyId: kms,
      });
      const r = await runScrub(standin, zarrArgs(dir, ["--execute"]));
      expect(r.exitCode, r.all).toBe(0);
      const now = standin.current(BUCKET, B);
      expect(now?.sse).toBe("aws:kms");
      expect(now?.kmsKeyId).toBe(kms);
      expect(text(standin, B)).toBe(compactCleaned);
    },
    BATCH_SLOW,
  );

  test.concurrent(
    "a store that vanishes between the listing and its read is not counted clean (T8)",
    async () => {
      const { dir, standin } = await seeded();
      // Just before the stage's first HEAD of a store root, C goes away.
      standin.beforeOp(
        "HeadObject",
        () => {
          standin.putDeleteMarker(BUCKET, C);
        },
        standin.opCount("HeadObject") + 1,
      );
      const r = await runScrub(standin, zarrArgs(dir, ["--execute"]));
      expect(r.exitCode, r.all).toBe(1);
      expect(r.stdout).toContain("HeadObject:not-found=1");
      expect(has(dir, "zarr-verified.json")).toBe(false);
      expect(readJson<ZarrPlanFile>(dir, "zarr-plan.json").totals.clean).toBe(0);
    },
    BATCH_SLOW,
  );
});
