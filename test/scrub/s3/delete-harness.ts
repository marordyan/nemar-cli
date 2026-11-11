/**
 * The state `delete.test.ts` and `delete-preconditions.test.ts` share: one dataset carried through
 * plan, hash, assemble and verify once per file, and the lanes that start from it. It is one
 * module so the two files, split only so that CI can run them on different runners, stay the same
 * fixture. Each test makes lanes of its own at that state (`makeLanes`), so nothing one test does
 * can reach another.
 */

import { afterAll, beforeAll, expect } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ZarrVerifiedFile } from "../../../scripts/scrub/contract";
import { type S3Standin, type Snapshot, startS3Standin } from "../helpers/s3-standin";
import type { Limiter } from "./concurrency";
import {
  type Assembled,
  BUCKET,
  DATASET,
  type PublicEndpoint,
  type RunResult,
  SLOW,
  buildAssembled,
  copyDir,
  deleteRequests,
  fixtureA,
  fixtureB,
  fixtureD,
  objectPath,
  readJson,
  runScrub,
  seedManifest,
  sha256,
  startPublicEndpoint,
  verifyArgs,
  writeGitVerified,
  writeJson,
} from "./support";

let standin: S3Standin;
export let snap: Snapshot;
export let built: Assembled;

export const [a, b, d] = [fixtureA(), fixtureB(), fixtureD()];

/** Every version id, and delete marker, of one old key as seeded. */
export let oldIds: Record<string, string[]>;

/** A store root with an identifier key in it: the zarr stage rewrites it before it proves it. */
export const dirtyStore = JSON.stringify({
  zarr_format: 3,
  node_type: "group",
  attributes: { recording_metadata: { patientcode: "P0042", startdate: "02.02.20" } },
});
export const cleanStore = JSON.stringify({
  zarr_format: 3,
  node_type: "group",
  attributes: { recording_metadata: { startdate: "02.02.20" } },
});

/** The new key the privacy probe asks about: the first of the assembled new keys, sorted. */
export const firstNewKey = () => [a.newKey as string, b.newKey as string].sort()[0] as string;

/**
 * A lane: a stand-in at the shared state, a public endpoint, and a pristine copy of the working
 * directory, with the helpers that read them.
 */
export interface Lane {
  standin: S3Standin;
  pub: PublicEndpoint;
  dir: string;
  /** A stage process in this lane's stand-in, counted against the file's limiter. */
  run(
    args: string[],
    env?: Record<string, string>,
    opts?: { anyPublicBase?: boolean },
  ): Promise<RunResult>;
  deleteArgs(extra?: string[], publicBase?: string): string[];
  executeArgs(extra?: string[]): string[];
  assembledSha(): string;
  /** Write both proofs for the assembled.json in `dir` as it is now. */
  writeProofs(count?: number): void;
  /**
   * The proof the `zarr` stage leaves, made by the REAL stage over this lane's stand-in, so the
   * binding it checks is the binding the stage writes. `over` then replaces fields of the proof,
   * to make it stale.
   */
  proveZarr(over?: Partial<ZarrVerifiedFile>): Promise<void>;
  versionIdsOf(key: string): string[];
  /** Nothing was deleted: every old version and marker is still there. */
  expectOldIntact(): void;
  /** A new lane that starts from this lane's stand-in and working directory as they are now. */
  fork(): Lane;
}

/**
 * The lanes of one test file. `limit` is the file's own limiter (`makeLimiter`), because module
 * state is cached once per Bun process and a limiter here would be shared by both files. With
 * `proofs`, every lane `scoped` hands out has both proofs written for its assembled.json.
 */
export function makeLanes(limit: Limiter, opts: { proofs?: boolean } = {}) {
  /** Run one stage process in `standin`, counted against the limiter. */
  const run = (
    standin: S3Standin,
    args: string[],
    env?: Record<string, string>,
    runOpts?: { anyPublicBase?: boolean },
  ): Promise<RunResult> => limit(() => runScrub(standin, args, env, runOpts));

  function makeLane(state: Snapshot, from: string, mine: Lane[]): Lane {
    const standin = startS3Standin();
    standin.restore(state);
    const pub = startPublicEndpoint();
    const dir = copyDir(from);
    const lane: Lane = {
      standin,
      pub,
      dir,
      run: (args, env, runOpts) => run(standin, args, env, runOpts),
      deleteArgs: (extra = [], publicBase = pub.url) => [
        "delete-old",
        "--dir",
        dir,
        "--confirm-dataset",
        DATASET,
        "--public-base",
        publicBase,
        "--concurrency",
        "8",
        ...extra,
      ],
      executeArgs: (extra = []) => lane.deleteArgs(["--execute", ...extra]),
      assembledSha: () => sha256(readFileSync(path.join(dir, "assembled.json"))),
      writeProofs(count = 2) {
        writeJson(dir, "verified.json", {
          version: 1,
          dataset: DATASET,
          verifiedAt: new Date().toISOString(),
          assembledSha256: lane.assembledSha(),
          counts: { keys: count, headersChecked: count, rangesCompared: 0 },
        });
        writeJson(dir, "new-hash-verified.json", {
          version: 1,
          dataset: DATASET,
          assembledSha256: lane.assembledSha(),
          count,
        });
      },
      async proveZarr(over = {}) {
        const r = await lane.run(["zarr", "--dir", dir, "--execute"]);
        if (r.exitCode !== 0) throw new Error(`the zarr stage failed: ${r.all}`);
        if (Object.keys(over).length > 0) {
          writeJson(dir, "zarr-verified.json", {
            ...readJson<ZarrVerifiedFile>(dir, "zarr-verified.json"),
            ...over,
          });
        }
      },
      versionIdsOf: (key) => standin.versions(BUCKET, objectPath(key)).map((v) => v.versionId),
      expectOldIntact() {
        expect(deleteRequests(standin)).toBe(0);
        for (const f of [a, b]) {
          expect(lane.versionIdsOf(f.oldKey).sort()).toEqual(
            [...(oldIds[f.oldKey] as string[])].sort(),
          );
        }
      },
      fork: () => makeLane(standin.snapshot(), dir, mine),
    };
    mine.push(lane);
    return lane;
  }

  /**
   * A test body that is given `lane`, which makes a lane at the shared state (with both proofs
   * written, when the file asked for them). Every lane the test made, and every fork of one, is
   * stopped when the body ends, whatever the outcome.
   */
  function scoped(fn: (lane: () => Lane) => Promise<void>): () => Promise<void> {
    return async () => {
      const mine: Lane[] = [];
      try {
        await fn(() => {
          const l = makeLane(snap, built.dir, mine);
          if (opts.proofs) l.writeProofs();
          return l;
        });
      } finally {
        for (const l of mine) {
          l.standin.stop();
          l.pub.stop();
        }
      }
    };
  }

  return { run, scoped };
}

/**
 * Register the file's hooks: build the dataset once (`beforeAll`). A hook registered at the top
 * level of an IMPORTED module binds to the first importing file only, so each test file calls
 * this itself.
 */
export function useDeleteHarness(): void {
  beforeAll(async () => {
    standin = startS3Standin();
    built = await buildAssembled(standin, [a, b, d], {
      // Older versions and a delete marker: more than one thing to delete per key.
      A: { olderVersions: 2, marker: true },
      B: { marker: true },
    });
    const idsOf = (key: string) =>
      standin.versions(BUCKET, objectPath(key)).map((v) => v.versionId);
    oldIds = {
      [a.oldKey]: idsOf(a.oldKey),
      [b.oldKey]: idsOf(b.oldKey),
    };
    const v = await runScrub(standin, verifyArgs(built.dir));
    if (v.exitCode !== 0) throw new Error(`verify failed: ${v.all}`);
    // Runbook step 12 has run: the manifest now names each scrubbed file by its new key. Its older
    // version (naming the old keys) is dropped here so the shared state has no history; the tests of
    // history put it back on purpose.
    const manifestKey = `${DATASET}/version/v1.0.0.json`;
    const original = standin.versions(BUCKET, manifestKey)[0]?.versionId as string;
    seedManifest(standin, "v1.0.0", [a, b, d], {}, DATASET, true);
    standin.dropVersion(BUCKET, manifestKey, original);
    const sha = sha256(readFileSync(path.join(built.dir, "assembled.json")));
    writeJson(built.dir, "new-hash-verified.json", {
      version: 1,
      dataset: DATASET,
      assembledSha256: sha,
      count: 2,
    });
    // Runbook step 14 has run: a fresh clone of the pushed repository verified.
    writeGitVerified(built.dir);
    snap = standin.snapshot();
  }, SLOW);

  afterAll(() => {
    standin?.stop();
  });
}
