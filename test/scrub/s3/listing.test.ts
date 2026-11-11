/**
 * Listings run as many `aws` calls, ONE S3 request each, so the per-call timeout bounds a page
 * rather than a whole prefix. Run through the real CLI against the stand-in, whose pages are as
 * small as the test asks.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
  type AwsRunner,
  listCurrentKeys,
  listKeyVersions,
  listPrefixVersions,
} from "../../../scripts/scrub/s3/s3-lib";
import { type S3Standin, startS3Standin } from "../helpers/s3-standin";
import { BUCKET, SLOW, removeTempDirs, withCtx } from "./support";

afterAll(removeTempDirs);

let standin: S3Standin;
afterEach(() => standin?.stop());

const one = new Uint8Array([1]);

/** The real runner, with every call counted: what the stage spends, not a stand-in for it. */
function counted(aws: AwsRunner): { aws: AwsRunner; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    aws: {
      api(op, args, opts) {
        calls.push(op);
        return aws.api(op, args, opts);
      },
    },
  };
}

/** Keys with older versions, markers, a space and a non-ASCII letter: what a prefix really holds. */
function seed(): void {
  for (let i = 0; i < 7; i++) {
    const key = `p/k${i}${i === 3 ? " café" : ""}.edf`;
    standin.putObject(BUCKET, key, one);
    if (i % 2 === 1) standin.putDeleteMarker(BUCKET, key);
    if (i % 3 === 0) standin.putObject(BUCKET, key, one);
  }
}

describe("listings", () => {
  test(
    "a listing of many pages is one aws call per page, and returns every entry exactly once",
    async () => {
      standin = startS3Standin();
      seed();
      await withCtx(standin, async (ctx) => {
        const c = counted(ctx.aws);
        const all = await listPrefixVersions({ ...ctx, aws: c.aws }, "p/", 2);
        const truth = standin
          .keys(BUCKET, "p/")
          .flatMap((k) =>
            standin.versions(BUCKET, k).map((v) => `${k} ${v.versionId} ${v.deleteMarker}`),
          );
        const got = all.map((e) => `${e.key} ${e.versionId} ${e.kind === "marker"}`);
        expect(got.sort()).toEqual(truth.sort());
        expect(new Set(got).size).toBe(got.length);
        // 7 keys: 10 versions and 3 markers, two per page: seven calls, seven requests.
        expect(truth.length).toBe(13);
        expect(c.calls.length).toBe(7);
        expect(standin.calls("ListObjectVersions").length).toBe(7);

        c.calls.length = 0;
        const current = await listCurrentKeys({ ...ctx, aws: c.aws }, "p/", 2);
        const expected = standin.keys(BUCKET, "p/").filter((k) => standin.current(BUCKET, k));
        expect(current.sort()).toEqual(expected.sort());
        expect(current.some((k) => k.includes(" café"))).toBe(true);
        expect(c.calls.length).toBe(Math.ceil(expected.length / 2));

        const one3 = await listKeyVersions(ctx, "p/k3 café.edf", 1);
        // k3: a version, a marker on it, and a version on top; a page of one entry each call.
        expect([one3.versions.length, one3.markers.length]).toEqual([2, 1]);
      });
    },
    SLOW,
  );

  test(
    "a truncated version listing with no next version id is refused, never resumed after the key",
    async () => {
      standin = startS3Standin();
      seed();
      await withCtx(standin, async (ctx) => {
        // The twin: with both markers the same listing is complete.
        const whole = await listPrefixVersions(ctx, "p/", 2);
        expect(whole.length).toBe(13);

        // A key marker alone resumes AFTER that key, so the rest of its versions would be
        // missing from the listing that decides whether a delete finished.
        standin.omitNextVersionIdMarker();
        await expect(listPrefixVersions(ctx, "p/", 2)).rejects.toMatchObject({
          code: "bad-output",
        });
        await expect(listKeyVersions(ctx, "p/k0.edf", 1)).rejects.toMatchObject({
          code: "bad-output",
        });
      });
    },
    SLOW,
  );

  test(
    "a listing longer than one call's timeout finishes when each page is quick enough",
    async () => {
      standin = startS3Standin();
      for (let i = 0; i < 8; i++) standin.putObject(BUCKET, `q/k${i}`, one);
      // Every listing request takes 1.5 s; four pages are 6 s, one call is allowed 5 s. The limit
      // was 4 s until the real aws CLI's startup under four test workers pushed one page past it
      // (the first dev push after sharding); a page is 1.5 s plus the CLI, so 5 s leaves 3.5 s.
      standin.stallNext("GET", 1500, 4);
      await withCtx(
        standin,
        async (ctx) => {
          const keys = await listCurrentKeys(ctx, "q/", 2);
          expect(keys.length).toBe(8);
        },
        BUCKET,
        5000,
      );
    },
    SLOW,
  );
});
