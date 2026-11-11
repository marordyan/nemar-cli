/**
 * The image digest a recipe job passes is checked against the launcher's provenance before a result is
 * accepted (epic #2005 phase A6, #2011; the C3 review amendment of 2026-11-05; ADR 0118).
 *
 * `nemar-recipe run --image-digest` is the CALLER'S CLAIM: the recipe records what it is told and cannot
 * check it against the image it runs in. So the Worker compares the value it passed, read back from the
 * job's recorded specification, with the digest the launcher's `provenance.json` says it ran, and fails
 * the job (`result_verification_failed`, `image_digest_mismatch`, flagged for an administrator) when
 * they differ, when the flag is absent, or when it is given twice. A job with no recipe is unaffected.
 *
 * Real migrations, the real ledger, Miniflare's R2 and the Tapis stand-in; the launcher's end is played.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  RECIPE_IMAGE_DIGEST_FLAG,
  recipeArguments,
  recipeCommand,
} from "../../shared/compute-recipes";
import { submitComputeJob } from "../src/services/compute-lifecycle";
import {
  type LifecycleFixture,
  RUNTIME_IMAGE_DIGEST,
  makeJob,
  reread,
  startLifecycleFixture,
} from "./helpers/compute-lifecycle-fixture";
import { finishAtTapis, floorOutputs } from "./helpers/compute-pipeline-fixture";

let fx: LifecycleFixture;

beforeAll(async () => {
  fx = await startLifecycleFixture();
}, 120_000);

beforeEach(async () => {
  await fx.reset();
});

afterAll(async () => {
  await fx?.dispose();
}, 30_000);

const OTHER = `sha256:${"a".repeat(64)}`;

const recipeSpec = (args: string[]) => ({
  recipe: "nemar-floor",
  command: recipeCommand({ name: "nemar-floor" }),
  args,
});

async function run(
  args: string[],
  plan: Parameters<typeof finishAtTapis>[3] = {},
  opts: { withoutRowDigest?: boolean } = {},
) {
  const made = await makeJob(fx, { spec: recipeSpec(args) });
  expect(await submitComputeJob(made.env, made.job.id)).toEqual({ ok: true, outcome: "submitted" });
  if (opts.withoutRowDigest) {
    // The submit records the image digest on the job row, and `verifyResults` compares the provenance
    // with THAT first. Take it away, so the only check left to refuse a provenance that names another
    // image than the argument is the recipe's own.
    expect((await reread(made.env, made.job.id)).image_digest).toBe(RUNTIME_IMAGE_DIGEST);
    await made.env.DB.prepare("UPDATE compute_jobs SET image_digest = NULL WHERE id = ?1")
      .bind(made.job.id)
      .run();
  }
  await finishAtTapis(fx, made.env, made.job.id, { outputs: floorOutputs(), ...plan });
  return reread(made.env, made.job.id);
}

const goodArgs = recipeArguments({
  datasetId: "nm000104",
  tag: "v1.0.2",
  imageDigest: RUNTIME_IMAGE_DIGEST,
});

describe("a recipe job's image digest argument against the launcher's provenance", () => {
  test("the digest the job passed is the digest the launcher ran: the job is finished", async () => {
    const job = await run(goodArgs);
    expect(job.state).toBe("finished");
    expect(job.results_verified_at).not.toBeNull();
  });

  test("another digest fails the job as image_digest_mismatch, flagged, and nothing is refunded", async () => {
    const job = await run(
      recipeArguments({ datasetId: "nm000104", tag: "v1.0.2", imageDigest: OTHER }),
    );
    expect(job.state).toBe("failed");
    expect(job.failure_code).toBe("result_verification_failed");
    expect(job.failure_detail).toBe("image_digest_mismatch");
    expect(job.flag_mismatch).toBe(1);
    expect(job.charged_milli).toBeGreaterThan(0);
  });

  test("a provenance that names another image than the argument fails too", async () => {
    const job = await run(goodArgs, { imageDigest: OTHER }, { withoutRowDigest: true });
    expect(job.image_digest).toBeNull();
    expect(job.state).toBe("failed");
    expect(job.failure_detail).toBe("image_digest_mismatch");
  });

  test("no digest argument, a malformed one and two of them all fail closed", async () => {
    for (const args of [
      goodArgs.filter((a) => a !== RUNTIME_IMAGE_DIGEST && a !== RECIPE_IMAGE_DIGEST_FLAG),
      [...goodArgs.slice(0, -1), "sha256:short"],
      [...goodArgs, RECIPE_IMAGE_DIGEST_FLAG, RUNTIME_IMAGE_DIGEST],
    ]) {
      const job = await run(args);
      expect([args.join(" "), job.state, job.failure_detail]).toEqual([
        args.join(" "),
        "failed",
        "image_digest_mismatch",
      ]);
    }
  });

  test("a job that names no recipe is not held to the flag", async () => {
    const made = await makeJob(fx);
    await submitComputeJob(made.env, made.job.id);
    await finishAtTapis(fx, made.env, made.job.id);
    expect((await reread(made.env, made.job.id)).state).toBe("finished");
  });
});
