import { afterAll, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PlanFile, ZarrPlanFile, ZarrVerifiedFile } from "../../../scripts/scrub/contract";
import { StageError } from "../../../scripts/scrub/s3/s3-lib";
import {
  DEFAULT_PUBLIC_BASE,
  type DeletedFile,
  TEST_LOOPBACK_PUBLIC_BASE_ENV,
  checkPublicBase,
  publicObjectUrl,
} from "../../../scripts/scrub/s3/s3-stages";
import { BATCH_SLOW, makeLimiter, together } from "./concurrency";
import {
  type Lane,
  a,
  b,
  cleanStore,
  d,
  dirtyStore,
  firstNewKey,
  makeLanes,
  useDeleteHarness,
} from "./delete-harness";
import { expectStopped, expectUsage } from "./refusal";
import {
  BUCKET,
  DATASET,
  SLOW,
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
  writeGitVerified,
  writeJson,
} from "./support";

afterAll(removeTempDirs);
useDeleteHarness();

/**
 * Cases that do not depend on each other run at once, each in a lane of its own: a stand-in at
 * the shared state, a public endpoint, and a pristine copy of the working directory. A case that
 * used to follow `standin.restore(snap)` in one shared stand-in is now a lane, so nothing one case
 * does can reach another. At most four stage processes run at a time, whatever the number of
 * cases, because the machine has few cores and the files of the suite run in parallel.
 */
const { scoped } = makeLanes(makeLimiter(4), { proofs: true });

const body = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const zarrJson = `${DATASET}/zarr/sub-01/x.zarr/zarr.json`;
const [firstKey, secondKey] = [a.oldKey, b.oldKey].sort() as [string, string];

/**
 * The stage refuses with `word`, in the dry run and, when `execute` is set, with --execute too,
 * and nothing was deleted either way. The two modes run at once: a refusal writes nothing.
 */
async function refused(
  l: Lane,
  word: string,
  opts: { execute?: boolean; base?: string; intact?: boolean; extra?: string[] } = {},
) {
  const modes = opts.execute === false ? [[]] : [[], ["--execute"]];
  await together(
    modes.map((flag) => async () => {
      const r = await l.run(l.deleteArgs([...flag, ...(opts.extra ?? [])], opts.base));
      expectStopped(r, 3, word, `${flag.length ? "execute" : "dry run"}: ${word}`);
    }),
  );
  expect(deleteRequests(l.standin), word).toBe(0);
  expect(has(l.dir, "deleted.json"), word).toBe(false);
  if (opts.intact !== false) l.expectOldIntact();
}

// The tests of a `describe.concurrent` block run together, each in lanes of its own, so that the
// chain of runs one test makes does not leave the others waiting. Blocks that follow each other
// would run as one batch, and the timeout of a test is counted from the start of its batch, so a
// plain `describe` of tests that are cheap or have no lanes to share stands between the batches.
describe.concurrent(
  "delete-old: what must be true before an old key may go: manifests and privacy",
  () => {
    test(
      "--confirm-dataset is required and must equal the plan's dataset, before any S3 call",
      scoped(async (lane) => {
        const l = lane();
        const base = ["--dir", l.dir, "--public-base", l.pub.url];
        const cases: Array<() => Promise<void>> = [];
        for (const flag of [[], ["--execute"]]) {
          cases.push(async () => {
            const missing = await l.run(["delete-old", ...base, ...flag]);
            expect(missing.exitCode, missing.all).toBe(2);
            expect(missing.stderr).toContain("s3-scrub: missing-confirm-dataset");
          });
          for (const typed of ["xx090999", DATASET.toUpperCase(), `${DATASET} `, "nm099999"]) {
            cases.push(async () => {
              const wrong = await l.run([
                "delete-old",
                ...base,
                "--confirm-dataset",
                typed,
                ...flag,
              ]);
              expectStopped(wrong, 3, "confirm-dataset-mismatch", `typed ${JSON.stringify(typed)}`);
            });
          }
        }
        await together(cases);
        // Refused before the first request to S3 or to the public endpoint.
        expect(l.standin.log.length).toBe(0);
        expect(l.pub.requests.length).toBe(0);
      }),
      BATCH_SLOW,
    );

    test(
      "refuses while a current manifest, of any tag, still names an old key",
      scoped(async (lane) => {
        await together([
          async () => {
            // The manifest as it was before runbook step 12 regenerated it: it names the old keys.
            // The regenerated one becomes its history, named here so the manifest is the only refusal.
            const l = lane();
            seedManifest(l.standin, "v1.0.0", [a, b, d]);
            await refused(l, "manifest-names-old-key", {
              extra: ["--prune-noncurrent", `${DATASET}/version/`],
            });
          },
          async () => {
            // v1.0.0 is regenerated; a second tag, found by listing, is not.
            const l = lane();
            seedManifest(l.standin, "v1.0.1", [b]);
            await refused(l, "manifest-names-old-key");
          },
        ]);
      }),
      BATCH_SLOW,
    );

    test(
      "reads every current manifest, and refuses one it cannot read or cannot account for",
      scoped(async (lane) => {
        await together([
          async () => {
            // A second tag that is clean is read as well as the first, and passes.
            const l = lane();
            seedManifest(l.standin, "v1.0.1", [a, b, d], {}, DATASET, true);
            const ok = await l.run(l.deleteArgs());
            expect(ok.exitCode, ok.all).toBe(0);
            const fetched = l.standin.calls("GetObject").map((c) => c.key);
            expect(fetched).toContain(`${DATASET}/version/v1.0.0.json`);
            expect(fetched).toContain(`${DATASET}/version/v1.0.1.json`);
          },
          async () => {
            const l = lane();
            l.standin.putObject(BUCKET, `${DATASET}/version/v1.0.2.json`, body("not json at all"));
            await refused(l, "manifest-malformed", { execute: false });
          },
          async () => {
            const l = lane();
            l.standin.putObject(BUCKET, `${DATASET}/version/notes.json`, body("{}"));
            await refused(l, "version-dir-unknown-file", { execute: false });
          },
        ]);
      }),
      BATCH_SLOW,
    );

    test(
      "the dataset must be private: an anonymous HEAD of a new and an old object answers exactly 403",
      scoped(async (lane) => {
        const ok = lane();
        const isPublic = lane();
        isPublic.pub.status = 200;
        // Anything but 403 proves nothing: this bucket denies anonymous listing, so a 404 or a
        // redirect does not say the dataset is private, and an error says nothing at all.
        const unproven = [404, 500, 503, 301, 206, 204].map((status) => {
          const l = lane();
          l.pub.status = status;
          return l;
        });
        // Nothing listening is no answer either. Made last and stopped at once, so that no server
        // of this test can take its port.
        const dead = lane();
        const deadUrl = dead.pub.url;
        dead.pub.stop();

        await together([
          async () => {
            // 403 passes, in the dry run: two requests, HEADs, anonymous, a new key and an old key.
            const r = await ok.run(ok.deleteArgs());
            expect(r.exitCode, r.all).toBe(0);
            expect(ok.pub.requests.map((q) => [q.method, q.path])).toEqual([
              ["HEAD", `/${DATASET}/objects/${firstNewKey()}`],
              ["HEAD", `/${DATASET}/objects/${firstKey}`],
            ]);
            for (const req of ok.pub.requests) {
              expect(req.headers.authorization).toBeUndefined();
              expect(req.headers.cookie).toBeUndefined();
              expect(Object.keys(req.headers).filter((h) => h.startsWith("x-amz"))).toEqual([]);
            }
          },
          // 200 is a public dataset, in either mode.
          () => refused(isPublic, "dataset-is-public"),
          ...unproven.map((l) => () => refused(l, "privacy-unproven", { execute: false })),
          () => refused(dead, "privacy-unproven", { base: deadUrl }),
        ]);
      }),
      BATCH_SLOW,
    );

    test(
      "the probes are objects that exist: a key hidden by a delete marker is skipped",
      scoped(async (lane) => {
        const l = lane();
        // A marker on an old key, recorded by the plan (so the delete may remove it).
        const recordMarker = (key: string) => {
          const id = l.standin.putDeleteMarker(BUCKET, objectPath(key));
          const plan = readJson<PlanFile>(l.dir, "plan.json");
          (plan.keys.find((k) => k.oldKey === key) as PlanFile["keys"][number]).versionIds.push(id);
          writeFileSync(path.join(l.dir, "plan.json"), JSON.stringify(plan));
          writeGitVerified(l.dir); // the git proof names the plan's bytes
        };
        recordMarker(firstKey);
        const ok = await l.run(l.deleteArgs());
        expect(ok.exitCode, ok.all).toBe(0);
        expect(l.pub.requests.map((r) => r.path)).toEqual([
          `/${DATASET}/objects/${firstNewKey()}`,
          `/${DATASET}/objects/${secondKey}`,
        ]);

        // Every old key hidden: the new key alone proves it, as on a re-run after the delete.
        recordMarker(secondKey);
        l.pub.requests.length = 0;
        const newOnly = await l.run(l.deleteArgs());
        expect(newOnly.exitCode, newOnly.all).toBe(0);
        expect(l.pub.requests.map((r) => r.path)).toEqual([`/${DATASET}/objects/${firstNewKey()}`]);

        // And no new object current either: nothing to ask about, nothing proven, nothing asked.
        for (const f of [a, b]) l.standin.putDeleteMarker(BUCKET, objectPath(f.newKey as string));
        l.pub.requests.length = 0;
        await refused(l, "privacy-unproven", { execute: false, intact: false });
        expect(l.pub.requests.length).toBe(0);
      }),
      BATCH_SLOW,
    );

    test(
      "a delete that finished can be run again: the new keys prove privacy, and nothing is left",
      scoped(async (lane) => {
        const l = lane();
        const first = await l.run(l.executeArgs());
        expect(first.exitCode, first.all).toBe(0);
        rmSync(path.join(l.dir, "deleted.json"));
        // The three runs that follow each start from the state the delete left, and none changes it
        // for another (a re-run deletes nothing), so each has a lane of its own.
        const [dry, again, isPublic] = [l.fork(), l.fork(), l.fork()] as [Lane, Lane, Lane];
        // Reviewer probe T1: the old keys are gone, so a re-run used to stop at privacy-unproven.
        const rerun = (x: Lane, flag: string[]) => async () => {
          const r = await x.run(x.deleteArgs(flag));
          expect(r.exitCode, r.all).toBe(0);
          expect(r.stdout).toContain("keys=2 versions=0 markers=0");
          expect(x.pub.requests.map((q) => q.path)).toEqual([
            `/${DATASET}/objects/${firstNewKey()}`,
          ]);
        };
        await together([
          rerun(dry, []),
          rerun(again, ["--execute"]),
          async () => {
            // And the public answer still decides: a re-run against a public dataset is refused.
            isPublic.pub.status = 200;
            expectStopped(await isPublic.run(isPublic.deleteArgs()), 3, "dataset-is-public");
          },
        ]);
        expect(readJson<DeletedFile>(again.dir, "deleted.json").counts.versions).toBe(0);
      }),
      BATCH_SLOW,
    );
  },
);

describe("delete-old: what must be true before an old key may go: public base URLs", () => {
  test(
    "the default public base is the production bucket's anonymous URL",
    () => {
      expect(DEFAULT_PUBLIC_BASE).toBe("https://nemar.s3.us-east-2.amazonaws.com");
    },
    SLOW,
  );

  test("the anonymous URL of an object encodes each path segment, and only the segments", () => {
    const base = "https://nemar.s3.us-east-2.amazonaws.com";
    // The plain key: nothing to encode, and a trailing slash on the base makes no difference.
    const plain = "nm000001/objects/SHA256E-s7--0123abcd.edf";
    expect(publicObjectUrl(base, plain)).toBe(`${base}/${plain}`);
    expect(publicObjectUrl(`${base}//`, plain)).toBe(`${base}/${plain}`);
    // An annex key may carry `+` in its extension, which S3 reads as a space in a path; a space,
    // `%`, `&` and non-ASCII are encoded too. The slashes between segments stay slashes.
    expect(publicObjectUrl(base, "nm000001/objects/SHA256E-s7--0123abcd.ed+f")).toBe(
      `${base}/nm000001/objects/SHA256E-s7--0123abcd.ed%2Bf`,
    );
    expect(publicObjectUrl(base, "nm000001/zarr/sub 01/a&b%c/\u00e9.zarr/zarr.json")).toBe(
      `${base}/nm000001/zarr/sub%2001/a%26b%25c/%C3%A9.zarr/zarr.json`,
    );
  });
});

describe.concurrent(
  "delete-old: what must be true before an old key may go: archives and Zarr",
  () => {
    test(
      "refuses while the dataset has any archive version or marker, current or not",
      scoped(async (lane) => {
        const hidden = `${DATASET}/archives/${DATASET}_v1.0.1.zip`;
        await together([
          async () => {
            const l = lane();
            l.standin.putObject(BUCKET, `${DATASET}/archives/${DATASET}_v1.0.0.zip`, body("zip"));
            await refused(l, "archives-not-dropped");
          },
          async () => {
            // Reviewer probe T3: an archive hidden by a delete marker is not current, and it is
            // still the original recordings.
            const l = lane();
            l.standin.putObject(BUCKET, hidden, body("zip"));
            l.standin.putDeleteMarker(BUCKET, hidden);
            await refused(l, "archives-not-dropped");
          },
          async () => {
            // A marker alone, with nothing under it, is refused too: drop-archives leaves none.
            const l = lane();
            l.standin.putDeleteMarker(BUCKET, hidden);
            await refused(l, "archives-not-dropped", { execute: false });
          },
          async () => {
            // A sibling prefix that merely starts the same way is not the archive prefix.
            const l = lane();
            l.standin.putObject(BUCKET, `${DATASET}/archives-old/x.zip`, body("zip"));
            const ok = await l.run(l.deleteArgs());
            expect(ok.exitCode, ok.all).toBe(0);
          },
        ]);
      }),
      BATCH_SLOW,
    );

    test(
      "refuses a current Zarr object until the zarr stage has proven this plan",
      scoped(async (lane) => {
        const l = lane();
        l.standin.putObject(BUCKET, zarrJson, body(dirtyStore));
        await refused(l, "zarr-not-scrubbed");

        // The stage's own proof is what the check accepts, and it removed the identifier key first.
        // Its rewrite left the dirty version as history, which this run must be told to prune.
        await l.proveZarr();
        expect(JSON.parse(dec(l.standin.current(BUCKET, zarrJson)?.data as Uint8Array))).toEqual(
          JSON.parse(cleanStore),
        );

        // A proof for another dataset, another plan, another zarr plan, or of another shape. The
        // rewrite's history is named for the prune, so the Zarr proof is the only refusal. Each
        // starts from the state the first proof left (the runs here change nothing), in a lane
        // of its own.
        const prune = ["--prune-noncurrent", `${DATASET}/zarr/`];
        const only = { execute: false, extra: prune };
        const stale = (over: Partial<ZarrVerifiedFile>) => async () => {
          const f = l.fork();
          await f.proveZarr(over);
          await refused(f, "zarr-not-scrubbed", only);
        };
        await together([
          async () => {
            const ok = await l.run(l.deleteArgs(prune));
            expect(ok.exitCode, ok.all).toBe(0);
          },
          stale({ dataset: "xx090999" }),
          stale({ planSha256: "0".repeat(64) }),
          stale({ zarrPlanSha256: "0".repeat(64) }),
          stale({ counts: { stores: 5, docs: 5, rewritten: 1, untouched: 1 } }),
          // A well-formed proof that the prefix was empty says nothing about the objects there now.
          stale({
            found: "no-zarr",
            stores: [],
            counts: { stores: 0, docs: 0, rewritten: 0, untouched: 0 },
          }),
          async () => {
            const f = l.fork();
            writeJson(f.dir, "zarr-verified.json", { version: 1 });
            await refused(f, "zarr-not-scrubbed", only);
          },
          // The proof without the zarr-plan.json it names, and a zarr-plan.json that was changed.
          async () => {
            const f = l.fork();
            await f.proveZarr();
            writeJson(f.dir, "zarr-plan.json", {
              ...readJson<ZarrPlanFile>(f.dir, "zarr-plan.json"),
              executed: false,
            });
            await refused(f, "zarr-not-scrubbed", only);
          },
          async () => {
            const f = l.fork();
            await f.proveZarr();
            rmSync(path.join(f.dir, "zarr-plan.json"));
            await refused(f, "zarr-not-scrubbed", only);
          },
          // Without the prune the history is a second refusal, and both are reported.
          async () => {
            const f = l.fork();
            await f.proveZarr({ planSha256: "0".repeat(64) });
            await refused(f, "zarr-not-scrubbed+history-remains", { execute: false });
          },
        ]);
      }),
      BATCH_SLOW,
    );

    test(
      "a Zarr copy that is only history needs no proof, and is pruned",
      scoped(async (lane) => {
        const l = lane();
        l.standin.putObject(BUCKET, zarrJson, body("{}"));
        l.standin.putDeleteMarker(BUCKET, zarrJson);
        // Both are dry runs of one state, so they run at once.
        await together([
          async () => expectStopped(await l.run(l.deleteArgs()), 3, "history-remains"),
          async () => {
            const ok = await l.run(l.deleteArgs(["--prune-noncurrent", `${DATASET}/zarr/`]));
            expect(ok.exitCode, ok.all).toBe(0);
            expect(has(l.dir, "zarr-verified.json")).toBe(false);
          },
        ]);
      }),
      BATCH_SLOW,
    );
  },
);

describe("delete-old: what must be true before an old key may go: a plan that is not a dataset", () => {
  test(
    "refuses a plan whose dataset is not a dataset id, before any S3 call",
    scoped(async (lane) => {
      const l = lane();
      const plan = readJson<PlanFile>(l.dir, "plan.json");
      writeFileSync(path.join(l.dir, "plan.json"), JSON.stringify({ ...plan, dataset: "nm1" }));
      const r = await l.run([
        "delete-old",
        "--dir",
        l.dir,
        "--confirm-dataset",
        "nm1",
        "--public-base",
        l.pub.url,
      ]);
      expectUsage(r, "bad-dataset-id");
      expect(l.standin.log.length).toBe(0);
      expect(l.pub.requests.length).toBe(0);
    }),
    SLOW,
  );
});

describe.concurrent(
  "delete-old: what must be true before an old key may go: unplanned objects",
  () => {
    test(
      "refuses a recording under objects/ that the plan never read, in any letter case",
      scoped(async (lane) => {
        // An upload after the plan: an EDF the scrub never saw, so its header was never checked.
        const late = makeFixture(
          "L",
          ".EDF",
          "sub-09/eeg/late.EDF",
          edfFile(edfHeader({ patient: "Quillfeather", recording: "x" }), 4096, 99),
          null,
        );
        await together([
          async () => {
            const l = lane();
            l.standin.putObject(BUCKET, objectPath(late.oldKey), late.bytes, {
              lockUntil: centuryFromNow(),
            });
            await refused(l, "unplanned-recording");
          },
          async () => {
            // A name that looks like a recording but is not an annex key is not accounted for either.
            const l = lane();
            l.standin.putObject(BUCKET, `${DATASET}/objects/not-a-key.bdf`, body("x"));
            await refused(l, "unplanned-recording", { execute: false });
          },
          async () => {
            // A recording whose current entry is a delete marker is still bytes in a locked version:
            // the listing is of versions and markers, so it is seen too (C3).
            const l = lane();
            l.standin.putObject(BUCKET, objectPath(late.oldKey), late.bytes, {
              lockUntil: centuryFromNow(),
            });
            l.standin.putDeleteMarker(BUCKET, objectPath(late.oldKey));
            expect(l.standin.current(BUCKET, objectPath(late.oldKey))).toBeUndefined();
            await refused(l, "unplanned-recording");
          },
          async () => {
            // Not a recording: not this check's business.
            const l = lane();
            l.standin.putObject(
              BUCKET,
              `${DATASET}/objects/SHA256E-s1--${"9".repeat(64)}.json`,
              body("x"),
            );
            const ok = await l.run(l.deleteArgs());
            expect(ok.exitCode, ok.all).toBe(0);
          },
        ]);
      }),
      BATCH_SLOW,
    );

    test(
      "a plan without raw copies ignores annex-uuid and refuses any raw object written since",
      scoped(async (lane) => {
        const uuid = body("6a1b7c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d");
        await together([
          async () => {
            // The special remote's marker is in every dataset: never a raw copy, never deleted.
            const l = lane();
            l.standin.putObject(BUCKET, objectPath("annex-uuid"), uuid);
            const ok = await l.run(l.deleteArgs());
            expect(ok.exitCode, ok.all).toBe(0);
            // No raw line for a plan that has none.
            expect(ok.stdout).not.toContain("raw copies");
          },
          // A raw text object, and a zero-byte folder key, written after the plan.
          ...["participants.tsv", "code/"].map((name) => async () => {
            const l = lane();
            l.standin.putObject(BUCKET, objectPath(name), body(name === "code/" ? "" : "x\n"));
            await refused(l, "raw-copy-not-in-plan", { execute: name === "code/" });
          }),
          async () => {
            // One that appears while deleting is found by the final listing, and annex-uuid is kept.
            const l = lane();
            l.standin.putObject(BUCKET, objectPath("annex-uuid"), uuid);
            l.standin.beforeOp("DeleteObjects", () => {
              l.standin.putObject(BUCKET, objectPath("late.json"), body("{}"));
            });
            const r = await l.run(l.executeArgs());
            expect(r.exitCode, r.all).toBe(5);
            expect(r.stdout).toContain(
              "versions and markers remain: rawCopies=1 versions=1 markers=0",
            );
            expect(has(l.dir, "deleted.json")).toBe(false);
            expect(l.standin.versions(BUCKET, objectPath("annex-uuid")).length).toBe(1);
          },
        ]);
      }),
      BATCH_SLOW,
    );

    test(
      "refuses a current manifest that names a recording the scrub did not account for",
      scoped(async (lane) => {
        const unplanned = (name: string, entry: { key: string; size: number }) => ({
          [name]: entry,
        });
        const late = `SHA256E-s4096--${"7".repeat(64)}.edf`;
        const cases: Array<[Record<string, { key: string; size: number }>, boolean]> = [
          [unplanned("sub-09/eeg/late.edf", { key: late, size: 4096 }), true],
          // A recording kept inline in git, and a recording keyed by another backend.
          [unplanned("sub-09/eeg/inline.edf", { key: `git:${"c".repeat(40)}`, size: 10 }), false],
          [unplanned("sub-09/eeg/md5.bdf", { key: "MD5E-s10--abc.bdf", size: 10 }), false],
        ];
        await together(
          cases.map(([extra, both]) => async () => {
            const l = lane();
            seedManifest(l.standin, "v1.0.1", [a, b, d], extra, DATASET, true);
            await refused(l, "manifest-names-unplanned-key", both ? {} : { execute: false });
          }),
        );
      }),
      BATCH_SLOW,
    );
  },
);

describe("delete-old: what must be true before an old key may go: the public base", () => {
  test(
    "the public base must be the plan's bucket on S3 over https, outside a test",
    scoped(async (lane) => {
      const l = lane();
      // The variable that admits a loopback server is the tests' alone; unset, it is refused.
      // Through the CLI only hosts no request can reach, so a regression cannot send one to the
      // real bucket; the rest of the rule is checked on the function itself below.
      const outside = { [TEST_LOOPBACK_PUBLIC_BASE_ENV]: "" };
      await together(
        [
          l.pub.url,
          "https://evil.example",
          "https://nemar.s3.us-east-2.amazonaws.com.evil.example",
        ].map((base) => async () => {
          const r = await l.run(l.deleteArgs([], base), outside, { anyPublicBase: true });
          expectUsage(r, "bad-public-base", base);
        }),
      );
      expect(l.standin.log.length).toBe(0);
      expect(l.pub.requests.length).toBe(0);
      for (const base of [
        "http://nemar.s3.us-east-2.amazonaws.com",
        "https://xnemar.s3.us-east-2.amazonaws.com",
        "https://s3.us-east-2.amazonaws.com/other",
        "https://nemar.s3.us-east-2.amazonaws.com:8443",
        "https://nemar.s3.us-east-2.amazonaws.com/?x=1",
        "https://nemar.s3.us-east-2.amazonaws.com/sub",
        "https://user@nemar.s3.us-east-2.amazonaws.com",
      ]) {
        expect(() => checkPublicBase(base, "nemar"), base).toThrow(StageError);
      }
      // What is accepted, checked without a request to it.
      for (const base of [
        DEFAULT_PUBLIC_BASE,
        `${DEFAULT_PUBLIC_BASE}/`,
        "https://nemar.s3.amazonaws.com",
        "https://s3.us-east-2.amazonaws.com/nemar",
      ]) {
        expect(() => checkPublicBase(base, "nemar"), base).not.toThrow();
      }
      expect(() => checkPublicBase(DEFAULT_PUBLIC_BASE, "other")).toThrow(StageError);
    }),
    SLOW,
  );
});
