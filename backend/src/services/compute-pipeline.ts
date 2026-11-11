/**
 * NEMAR's own pipeline dispatch (epic #2005 phase A6, #2011; ADR 0118; design section 10): run a
 * processing recipe over one version of one public EEG dataset through the compute gateway, leave one
 * stamp per dataset version, recipe, recipe version and engine so the queue knows what is current, and
 * read the stamps back to their end.
 *
 *   `dispatchPipelineJob`   claim the stamp, resolve the recipe into a complete job, make the job and
 *                           its hold (`createJob`), link the stamp, and submit (`submitComputeJob`)
 *   `syncPipelineStamps`    move `dispatched` stamps to `succeeded` or `failed` from their job's end
 *   `listPipelineStamps`    a page of stamps, filtered, after a sync
 *   `pipelineCandidates`    the eligible datasets a recipe has not been run over at their newest version
 *   `dispatchEligible`      a run over the next `limit` of them, each through `dispatchPipelineJob`
 *   `pipelineDryRun`        what a run would dispatch, the estimated SU, and what blocks the rest; reads only
 *
 * THE RULES, each one deliberate:
 *  - THE WORKER SUPPLIES THE FACTS, NEVER THE REQUEST. The dataset row (eligibility, ADR 0065: the
 *    stored `anonymous` column and nothing a caller says), the version row, the service account, the
 *    pool and the runtime image all come from the Worker's own tables and configuration. A request names
 *    a recipe, a dataset and optionally a version; it names nothing else.
 *  - THE RECIPE IS RESOLVED BEFORE `createJob` (the phase's amendment of 2026-11-04). The job is made
 *    from a complete specification: the recipe's name beside the runtime (`image`), NEMAR's own runtime
 *    image (`COMPUTE_RUNTIME_IMAGE`, a digest-pinned reference), the command, and the arguments with
 *    the image digest. So `spec.json`, `spec_digest` and `launch_spec_digest` describe what actually
 *    ran, and no recipe job ever exists in a form the launch-specification builder would refuse. The
 *    recipe is never run with an image other than the one its `--image-digest` names: the digest is
 *    taken from the same reference the job's `image` is, and the Worker compares it with the
 *    launcher's provenance before it accepts a result (`verifyResults`).
 *  - THE STAMP IS CLAIMED FIRST. A `dispatched` row for the tuple is inserted before anything else is
 *    written, and a partial unique index refuses a second live or succeeded row for one tuple, so two
 *    runs racing for a tuple produce one stamp and one job. A refused hold ends the stamp `refused`
 *    with the ledger's word; nothing else is left (the job's creation is atomic with its hold).
 *  - ONE KEY FOR ONE ATTEMPT. The job's idempotency key is made from the tuple and the attempt number,
 *    so a crash between the job's creation and the stamp's link is found again by the key: the sync
 *    links the job instead of failing the stamp.
 *  - THE STAMP SAYS WHAT RAN. It is claimed with the recipe table's version and engine and, when the
 *    job succeeds, rewritten from the recipe's own dataset record (`readRecipeRecord`). A record that
 *    is missing, unreadable, or names another recipe ends the stamp `failed`; the job is untouched.
 *  - NOTHING HERE TOUCHES GITHUB OR MAIL. A run reaches D1, the compute buckets and Tapis, all through
 *    the gateway's own services.
 */

import {
  type ComputeRecipe,
  findRecipe,
  readRecipeRecord,
  recipeArguments,
  recipeCommand,
  recipeRequiredOutputs,
} from "../../../shared/compute-recipes.js";
import { PLATFORM_FAILURE_CODES } from "../../../shared/compute-state.js";
import {
  COMPUTE_PIPELINE_RUN_PER_INVOCATION,
  type ComputePipelineLimitedBy,
} from "../../../shared/contract/compute-admin.js";
import { resultsOutputKey } from "../../../shared/contract/compute-launch.js";
import {
  type ComputePolicy,
  type ComputePool,
  JobSpecSchema,
  PARTITIONS,
  PIPELINES_TAPIS_OWNER,
  type PartitionName,
  dataTagForVersion,
  estimateSuMilli,
} from "../../../shared/contract/compute.js";
import type { Bindings } from "../types/bindings.js";
import {
  ComputeJobError,
  type ComputeJobRow,
  type CreateJobRefusal,
  JOB_BY_KEY_SQL,
  PIPELINE_LIVE_JOBS_SQL,
  createJob,
} from "./compute-jobs.js";
import { type SubmitOutcome, submitComputeJob } from "./compute-lifecycle.js";
import {
  NEWEST_VERSION_SQL,
  PIPELINE_ELIGIBLE_SQL,
  PIPELINE_ROW_COLUMNS,
  PIPELINE_TERMS,
  type PipelineRow,
  type PipelineTermId,
  type PipelineVersion,
  VERSIONS_OF_SQL,
  VERSION_TAG_SQL,
  failedPipelineTerms,
  isPipelineEligible,
  loadPipelineRow,
  pickVersion,
} from "./compute-pipeline-eligibility.js";
import { getPolicy } from "./compute-policy.js";
import { sha256Hex } from "./compute-records.js";
import { readRuntimeImage } from "./compute-runtime-image.js";
import { computeEnabled } from "./compute-switches.js";
import { tenantFacts, tenantRoom } from "./compute-tenant.js";

// --- Words ------------------------------------------------------------------------------------------

/** The username of the service account NEMAR's own jobs are made for: the same literal as the Tapis owner. */
export const PIPELINES_ACCOUNT_USERNAME = PIPELINES_TAPIS_OWNER;

/**
 * The most entries one dataset's manifest may hold for a launcher to stage it: the data plane's own
 * bound (`MAX_MANIFEST_JSON_ENTRIES` of routes/data.ts, which a test holds this to).
 */
export const PIPELINE_MANIFEST_MAX_ENTRIES = 38_000;

/** A stamp whose claim was never followed by a job is failed after this many minutes. */
export const STAMP_NO_JOB_MINUTES = 30;

/**
 * INITIAL values (the issue states none; the owner adjusts them with the pilot). A tuple whose stamp
 * failed is not a candidate of the queue for this many days, and not at all once it has failed this
 * many times, so a head of failing datasets cannot take every slot of every run.
 */
export const RETRY_COOLDOWN_DAYS = 7;
export const MAX_FAILED_ATTEMPTS = 3;

/**
 * Platform failure words that happen AFTER the run consumed service units: the job ran, then its results
 * could not be taken or checked. Re-dispatching on the next day would spend the pool again with no
 * cooldown, so these count toward the cooldown and the cap like a dataset's own failure (ADR 0118, review
 * fixes of 2026-11-06). A failed job that was charged anything counts the same whatever its word, which
 * the queue reads from the linked job row ({@link CHARGED_FAILURE_SQL}); a failure before any charge
 * (staging, `tapis_submit_failed`) stays an immediate candidate.
 */
export const CONSUMED_FAILURE_WORDS: readonly string[] = [
  "result_upload_failed",
  "result_verification_failed",
  // The job may have run for real; its record is gone and nothing was charged, so it cannot be told apart.
  "tapis_record_lost",
];

/**
 * The words of a `failed` stamp that are NOT the dataset's doing, so they never count toward the cooldown
 * or the cap: the platform's own failure codes (`PLATFORM_FAILURE_CODES`: Tapis, staging, launch, archive,
 * verification, records, and the launcher's fetch and upload codes, whose detail is not kept on the
 * stamp), a cancel, and the words this file writes for its own faults and the registry's: the claim never
 * followed by a job (`no_job`), a job row that is gone (`job_missing`), a creation that threw
 * (`create_failed`), a recipe the table no longer names (`recipe_unknown`), and the tuple words
 * (`tuple_mismatch`, a hold; `tuple_already_stamped` and `tuple_attempt_taken`, a run that was good). Three transient database errors
 * on three days must not shut a dataset out until its version changes. What remains counts: the
 * submitter-side launcher codes (`runtime_error`, `time_limit`, `out_of_memory`, `entry_not_found`), a
 * job that failed with no word we know (`job_failed`), and the recipe's own output faults
 * (`outputs_missing`, `record_unreadable`, `record_mismatch`).
 */
export const NON_DATASET_FAILURE_WORDS: readonly string[] = [
  ...PLATFORM_FAILURE_CODES.filter((w) => !CONSUMED_FAILURE_WORDS.includes(w)),
  "job_cancelled",
  "no_job",
  "job_missing",
  "create_failed",
  "recipe_unknown",
  "tuple_mismatch",
  "tuple_already_stamped",
  "tuple_attempt_taken",
];

/** The list as SQL: fixed words of this tree, never a caller's. */
const NON_DATASET_FAILURE_SQL = NON_DATASET_FAILURE_WORDS.map((w) => `'${w}'`).join(", ");

/**
 * A failed stamp counts (cooldown and cap) when its word is the dataset's, or when its linked job failed
 * after being charged. `x` is the stamp alias; the job is read by the stamp's `job_id`.
 */
const COUNTS_AS_FAILURE_SQL = (x: string): string =>
  `(${x}.refusal_code NOT IN (${NON_DATASET_FAILURE_SQL})
    OR EXISTS (SELECT 1 FROM compute_jobs cj
                WHERE cj.id = ${x}.job_id AND cj.state = 'failed' AND cj.charged_milli > 0))`;

/** Stamps one sync examines at most. */
export const SYNC_STAMPS_PER_CALL = 50;

/** The words a dispatch refuses with, before or after the claim. The first group is `COMPUTE_REFUSAL_CODES`. */
export type PipelineRefusal =
  | "compute_disabled"
  | "recipe_unknown"
  | "dataset_not_eligible"
  | "pipelines_account_missing"
  | "live_attempt_exists"
  | "runtime_unavailable"
  | "version_not_found"
  | "version_untagged"
  | "too_many_files"
  | "recipe_not_automatic"
  | "recipe_placeholder"
  | "registry_drift"
  | "daily_cap_reached"
  | "run_failed"
  | "create_failed"
  | CreateJobRefusal;

/** What the cron or an administrator is acting as. A cron may dispatch only an automatic recipe. */
export type PipelineActor = { kind: "admin"; userId: number } | { kind: "cron" };

export interface DispatchInput {
  recipe: string;
  datasetId: string;
  /** Any spelling the data plane takes (`1.0.2`, `v1.0.2`, `latest`); the newest version when absent. */
  version?: string;
  actor: PipelineActor;
}

export type DispatchResult =
  | {
      ok: true;
      stampId: number;
      jobId: string;
      datasetId: string;
      version: string;
      recipe: string;
      attempt: number;
      /** What the immediate submit said; a job that waits is submitted by the 30-minute tick. */
      submit: SubmitOutcome;
    }
  | {
      ok: false;
      code: PipelineRefusal;
      datasetId: string;
      version?: string;
      /** The terms of the eligibility predicate the dataset fails, for `dataset_not_eligible`. */
      blockedBy?: PipelineTermId[];
      /** The stamp the refusal ended, when one had been claimed. */
      stampId?: number;
      /** The field of the specification that was invalid, for `invalid_spec`. */
      field?: string;
    };

// --- Rows -------------------------------------------------------------------------------------------

export interface StampRow {
  id: number;
  dataset_id: string;
  version: string;
  recipe: string;
  recipe_version: string;
  engine: string;
  attempt: number;
  state: "dispatched" | "succeeded" | "failed" | "refused";
  job_id: string | null;
  refusal_code: string | null;
  created_at: string;
  updated_at: string;
}

export const STAMP_COLUMNS = `id, dataset_id, version, recipe, recipe_version, engine, attempt, state,
  job_id, refusal_code, created_at, updated_at`;

/**
 * Claim a tuple: `?1` dataset, `?2` version tag, `?3` recipe, `?4` recipe version, `?5` engine. The
 * attempt number is read INSIDE the statement, so it is atomic with the insert; a live or succeeded
 * stamp for the tuple makes the insert fail on the partial unique index.
 */
export const CLAIM_STAMP_SQL = `INSERT INTO compute_pipeline_stamps
  (dataset_id, version, recipe, recipe_version, engine, attempt, state)
  SELECT ?1, ?2, ?3, ?4, ?5,
         COALESCE((SELECT MAX(s.attempt) FROM compute_pipeline_stamps s
                    WHERE s.dataset_id = ?1 AND s.version = ?2 AND s.recipe = ?3
                      AND s.recipe_version = ?4 AND s.engine = ?5), 0) + 1,
         'dispatched'`;

const STAMP_BY_ID_SQL = `SELECT ${STAMP_COLUMNS} FROM compute_pipeline_stamps WHERE id = ?1`;

/** Link the job a claimed stamp made: only while the stamp is still open and has none. */
export const LINK_STAMP_SQL = `UPDATE compute_pipeline_stamps
   SET job_id = ?2, updated_at = datetime('now')
 WHERE id = ?1 AND state = 'dispatched' AND job_id IS NULL`;

/** End an open stamp `failed` or `refused` with a fixed word. `?2` the state, `?3` the word. */
export const END_STAMP_SQL = `UPDATE compute_pipeline_stamps
   SET state = ?2, refusal_code = ?3, updated_at = datetime('now')
 WHERE id = ?1 AND state = 'dispatched'`;

/**
 * End an open stamp `succeeded` with the recipe's own version and engine: `?2` version, `?3` engine.
 * May meet the partial unique index, which the caller handles.
 */
export const SUCCEED_STAMP_SQL = `UPDATE compute_pipeline_stamps
   SET state = 'succeeded', recipe_version = ?2, engine = ?3, refusal_code = NULL,
       updated_at = datetime('now')
 WHERE id = ?1 AND state = 'dispatched' AND job_id IS NOT NULL`;

const looksUnique = (err: unknown) => /UNIQUE constraint failed/i.test(String(err));

/** The stamp of an id. */
export async function getStamp(db: D1Database, id: number): Promise<StampRow | null> {
  return db.prepare(STAMP_BY_ID_SQL).bind(id).first<StampRow>();
}

/**
 * The one key of an attempt: `pl:` and 40 hex digits of the SHA-256 of the tuple and the attempt. A
 * pure function of the stamp, so the sync can find a job whose creation committed and whose link did not.
 */
export async function pipelineKey(
  stamp: Pick<
    StampRow,
    "dataset_id" | "version" | "recipe" | "recipe_version" | "engine" | "attempt"
  >,
): Promise<string> {
  const text = [
    stamp.dataset_id,
    stamp.version,
    stamp.recipe,
    stamp.recipe_version,
    stamp.engine,
    String(stamp.attempt),
  ].join("|");
  return `pl:${(await sha256Hex(new TextEncoder().encode(text))).slice(0, 40)}`;
}

/** The service account jobs are made for, or null: approved, not deleted, and explicitly a service. */
export const PIPELINES_ACCOUNT_SQL = `SELECT id FROM users
  WHERE username = ?1 AND account_kind = 'service' AND status = 'approved' AND deleted_at IS NULL`;

export async function pipelinesAccountId(db: D1Database): Promise<number | null> {
  const row = await db
    .prepare(PIPELINES_ACCOUNT_SQL)
    .bind(PIPELINES_ACCOUNT_USERNAME)
    .first<{ id: number }>();
  return row?.id ?? null;
}

// --- The job a recipe is ----------------------------------------------------------------------------

/** The partition of a recipe, as the type `JobSpecSchema` takes. */
const partitionOf = (recipe: ComputeRecipe) => recipe.partition as PartitionName;

/**
 * The complete job specification of a recipe over a dataset version, with NEMAR's runtime image: the
 * recipe's name beside an `image` runtime, the command and the arguments that carry the image digest.
 * Parsed with the strict schema, so a registry entry that is not a valid job is a programming error that
 * a test also catches.
 */
export function recipeJobSpec(
  recipe: ComputeRecipe,
  input: { datasetId: string; tag: string; image: { ref: string; digest: string } },
) {
  return JobSpecSchema.parse({
    name: `${recipe.name} ${input.datasetId} ${input.tag}`.slice(0, 80),
    runtime: "image",
    image: input.image.ref,
    recipe: recipe.name,
    command: recipeCommand(recipe),
    args: recipeArguments({
      datasetId: input.datasetId,
      tag: input.tag,
      imageDigest: input.image.digest,
    }),
    datasets: [{ id: input.datasetId, version: input.tag }],
    partition: recipe.partition,
    nodes: recipe.nodes,
    cores: recipe.cores,
    ...(recipe.memoryMb === undefined ? {} : { memory_mb: recipe.memoryMb }),
    gpus: recipe.gpus,
    minutes: recipe.minutes,
  });
}

/** What one job of a recipe is held for, in milli-SU: the hold `createJob` takes. */
export function recipeEstimateMilli(recipe: ComputeRecipe): number {
  return estimateSuMilli({
    partition: partitionOf(recipe),
    nodes: recipe.nodes,
    cores: recipe.cores,
    memory_mb: recipe.memoryMb,
    gpus: recipe.gpus,
    minutes: recipe.minutes,
  });
}

// --- What a run needs of the dataset ------------------------------------------------------------------

type ResolvedRun =
  | { ok: true; tag: string }
  | {
      ok: false;
      code: "dataset_not_eligible" | "version_not_found" | "version_untagged" | "too_many_files";
      extra: { version?: string; blockedBy?: PipelineTermId[] };
    };

/**
 * The part of a run that is decided from the dataset's own rows, in one place so the dry run and the
 * run cannot disagree: the eligibility predicate over the row (ADR 0065), the version row (the newest,
 * or the one named) with a data-plane tag, and the manifest bound.
 */
async function resolveRun(
  db: D1Database,
  datasetId: string,
  wanted: string | undefined,
): Promise<ResolvedRun> {
  const loaded = await loadPipelineRow(db, datasetId);
  if (!loaded.eligible) {
    return { ok: false, code: "dataset_not_eligible", extra: { blockedBy: loaded.blockedBy } };
  }
  const versions = (await db.prepare(VERSIONS_OF_SQL).bind(datasetId).all<PipelineVersion>())
    .results;
  const picked = pickVersion(versions, wanted);
  if (!picked.ok) return { ok: false, code: picked.code, extra: {} };
  if (
    picked.version.total_files !== null &&
    picked.version.total_files > PIPELINE_MANIFEST_MAX_ENTRIES
  ) {
    return { ok: false, code: "too_many_files", extra: { version: picked.tag } };
  }
  return { ok: true, tag: picked.tag };
}

// --- A result that is not the tuple that was claimed ------------------------------------------------

/** The word of the stamp that holds a registry tuple: a finished result named another tuple than its stamp claimed. */
export const TUPLE_MISMATCH_WORD = "tuple_mismatch";

/** Is a registry tuple (`?1` recipe, `?2` version, `?3` engine) held? A hold is a failed stamp with the mismatch word. */
export const TUPLE_HELD_SQL = `SELECT 1 FROM compute_pipeline_stamps
  WHERE recipe = ?1 AND recipe_version = ?2 AND engine = ?3
    AND state = 'failed' AND refusal_code = '${TUPLE_MISMATCH_WORD}' LIMIT 1`;

/**
 * Hold the tuple a stamp CLAIMED (`?1` dataset, `?2` version, `?3` recipe, `?4` claimed version, `?5`
 * claimed engine, `?6` the job). The hold is a `failed` stamp of the claimed tuple with the job that
 * showed the mismatch, and is written once per job. It does not clear by time. It clears when the registry
 * declares another tuple (a version bump), or when its rows are deleted, which deleting the dataset they
 * name does (the cascade is the rule); the next mismatch on any dataset holds the tuple again.
 */
export const HOLD_TUPLE_SQL = `INSERT INTO compute_pipeline_stamps
  (dataset_id, version, recipe, recipe_version, engine, attempt, state, job_id, refusal_code)
  SELECT ?1, ?2, ?3, ?4, ?5,
         COALESCE((SELECT MAX(s.attempt) FROM compute_pipeline_stamps s
                    WHERE s.dataset_id = ?1 AND s.version = ?2 AND s.recipe = ?3
                      AND s.recipe_version = ?4 AND s.engine = ?5), 0) + 1,
         'failed', ?6, '${TUPLE_MISMATCH_WORD}'
   WHERE NOT EXISTS (SELECT 1 FROM compute_pipeline_stamps h
                      WHERE h.job_id = ?6 AND h.refusal_code = '${TUPLE_MISMATCH_WORD}')`;

/** Whether the registry's tuple for a recipe is held. */
export async function tupleHeld(db: D1Database, recipe: ComputeRecipe): Promise<boolean> {
  const row = await db
    .prepare(TUPLE_HELD_SQL)
    .bind(recipe.name, recipe.version, recipe.engine)
    .first();
  return row !== null;
}

// --- dispatchPipelineJob ----------------------------------------------------------------------------

const fail = (
  code: PipelineRefusal,
  datasetId: string,
  extra: Partial<Extract<DispatchResult, { ok: false }>> = {},
): DispatchResult => ({ ok: false, code, datasetId, ...extra });

async function finishStamp(
  db: D1Database,
  stampId: number,
  state: "failed" | "refused",
  word: string,
): Promise<void> {
  await db.prepare(END_STAMP_SQL).bind(stampId, state, word).run();
}

/**
 * Run a recipe over one dataset version. Never throws for a refusal: every refusal is a word. See the
 * file's header for the rules.
 */
export async function dispatchPipelineJob(
  env: Bindings,
  input: DispatchInput,
): Promise<DispatchResult> {
  const { datasetId } = input;
  const db = env.DB;
  const recipe = findRecipe(input.recipe);
  if (recipe === null) return fail("recipe_unknown", datasetId);
  if (!computeEnabled(env)) return fail("compute_disabled", datasetId);
  if (input.actor.kind === "cron" && !recipe.autoDispatch) {
    return fail("recipe_not_automatic", datasetId);
  }
  // A placeholder is on no path: not an administrator's run, not the queue, not the cron.
  if (recipe.placeholder === true) return fail("recipe_placeholder", datasetId);
  // The registry names a tuple that a finished result has shown is not what runs: nothing is claimed.
  if (await tupleHeld(db, recipe)) return fail("registry_drift", datasetId);

  // The dataset and its version, decided from the rows (ADR 0065): nothing a caller said is read.
  const resolved = await resolveRun(db, datasetId, input.version);
  if (!resolved.ok) return fail(resolved.code, datasetId, resolved.extra);
  const { tag } = resolved;

  const image = readRuntimeImage(env);
  if (image.state !== "ok") return fail("runtime_unavailable", datasetId, { version: tag });
  const accountId = await pipelinesAccountId(db);
  if (accountId === null) return fail("pipelines_account_missing", datasetId, { version: tag });

  // The specification, BEFORE the claim: a registry entry or an image the job schema refuses is a word
  // (`invalid_spec`) with nothing written, never a throw that leaves a claimed stamp and aborts a run.
  let spec: ReturnType<typeof recipeJobSpec>;
  try {
    spec = recipeJobSpec(recipe, { datasetId, tag, image });
  } catch (err) {
    console.error(
      `[compute-pipeline] spec_unbuildable recipe=${recipe.name} error=${err instanceof Error ? err.name : "unknown"}`,
    );
    return fail("invalid_spec", datasetId, { version: tag });
  }

  // The claim, first: a live or succeeded stamp for the tuple refuses it.
  let stampId: number;
  try {
    const claimed = await db
      .prepare(CLAIM_STAMP_SQL)
      .bind(datasetId, tag, recipe.name, recipe.version, recipe.engine)
      .run();
    const id = claimed.meta?.last_row_id;
    if (typeof id !== "number") throw new Error("a stamp that was just claimed has no id");
    stampId = id;
  } catch (err) {
    if (looksUnique(err)) return fail("live_attempt_exists", datasetId, { version: tag });
    throw err;
  }
  const stamp = await getStamp(db, stampId);
  if (stamp === null) {
    // The stamp was claimed a moment ago and is gone: the dataset was deleted in between (the deletion
    // cascades its stamps). Nothing was created, no hold was taken, and there is no tuple left to hold.
    console.error(`[compute-pipeline] stamp_gone stamp=${stampId}`);
    return fail("dataset_not_eligible", datasetId, { version: tag });
  }
  const key = await pipelineKey(stamp);

  // The job, from the specification built above. The stamp is ended whatever happens next.
  let created: Awaited<ReturnType<typeof createJob>>;
  try {
    created = await createJob(env, {
      source: "pipeline",
      accountId,
      tapisOwner: PIPELINES_TAPIS_OWNER,
      idempotencyKey: key,
      appId: recipe.appId,
      appVersion: recipe.appVersion,
      spec,
    });
    // A job whose records did not land is finished by a replay of its key; one try.
    if (created.ok && !created.recordsWritten) {
      created = await createJob(env, {
        source: "pipeline",
        accountId,
        tapisOwner: PIPELINES_TAPIS_OWNER,
        idempotencyKey: key,
        appId: recipe.appId,
        appVersion: recipe.appVersion,
        spec,
      });
    }
  } catch (err) {
    // A throw may come after the batch committed (the read of the job it just wrote can fail), and then
    // the key finds the job: it is linked and left to the 30-minute tick, which submits a created job. A
    // key that was used for ANOTHER request (`idempotency_conflict`) names a job that is not this one's
    // and is never linked.
    const conflict = err instanceof ComputeJobError && err.code === "idempotency_conflict";
    let lookupFailed = false;
    let existing: ComputeJobRow | null = null;
    if (!conflict) {
      try {
        existing = await db.prepare(JOB_BY_KEY_SQL).bind(accountId, key).first<ComputeJobRow>();
      } catch {
        lookupFailed = true;
      }
    }
    const cause =
      err instanceof ComputeJobError ? err.code : err instanceof Error ? err.name : "unknown";
    if (lookupFailed) {
      // The job may exist and the database could not say: ending the stamp would let a later attempt
      // make a second job. It stays `dispatched`; the sync finds the job by its key, or fails the claim
      // after the grace period when there is none.
      console.error(
        `[compute-pipeline] create_threw stamp=${stampId} lookup_failed error=${cause}`,
      );
      return fail("create_failed", datasetId, { version: tag, stampId });
    }
    if (existing) {
      await db.prepare(LINK_STAMP_SQL).bind(stampId, existing.id).run();
      console.error(`[compute-pipeline] create_threw job=${existing.id} error=${cause}`);
      return {
        ok: true,
        stampId,
        jobId: existing.id,
        datasetId,
        version: tag,
        recipe: recipe.name,
        attempt: stamp.attempt,
        submit: "unavailable",
      };
    }
    await finishStamp(db, stampId, "failed", "create_failed");
    console.error(`[compute-pipeline] create_threw stamp=${stampId} error=${cause}`);
    return fail("create_failed", datasetId, { version: tag, stampId });
  }
  if (!created.ok) {
    await finishStamp(db, stampId, "refused", created.code);
    return fail(created.code, datasetId, {
      version: tag,
      stampId,
      ...(created.field === undefined ? {} : { field: created.field }),
    });
  }

  const job = created.job;
  await db.prepare(LINK_STAMP_SQL).bind(stampId, job.id).run();
  // The submit is the lifecycle's: one attempt now; the 30-minute tick covers a job that waits.
  let submit: SubmitOutcome = "unavailable";
  try {
    submit = (await submitComputeJob(env, job.id)).outcome;
  } catch (err) {
    console.error(
      `[compute-pipeline] submit_threw job=${job.id} error=${err instanceof Error ? err.name : "unknown"}`,
    );
  }
  return {
    ok: true,
    stampId,
    jobId: job.id,
    datasetId,
    version: tag,
    recipe: recipe.name,
    attempt: stamp.attempt,
    submit,
  };
}

// --- syncPipelineStamps ---------------------------------------------------------------------------------

export interface SyncResult {
  examined: number;
  succeeded: number;
  failed: number;
  /** Stamps with a job that was created but never linked, found again by its key. */
  linked: number;
  /** Stamps left open because what decides them could not be read yet (the next sync tries again). */
  later: number;
  /** Stamps whose sync threw (a database fault, say): left as they were, and counted so the line is not blind to them. */
  errored: number;
}

/** The open stamps, oldest update first: the partial index `compute_pipeline_stamps_open` serves it. */
export const OPEN_STAMPS_SQL = `SELECT ${STAMP_COLUMNS} FROM compute_pipeline_stamps
  WHERE state = 'dispatched' ORDER BY updated_at ASC, id ASC LIMIT ?1`;

interface JobEnd {
  id: string;
  state: string;
  failure_code: string | null;
}

const TOUCH_STAMP_SQL = `UPDATE compute_pipeline_stamps SET updated_at = datetime('now')
 WHERE id = ?1 AND state = 'dispatched'`;

const JOB_END_SQL = "SELECT id, state, failure_code FROM compute_jobs WHERE id = ?1";

/** A job's failure word, or `job_failed`; the shape is checked because the stamp's column is. */
function failureWord(job: JobEnd): string {
  if (job.state === "cancelled") return "job_cancelled";
  return job.failure_code !== null && /^[a-z0-9_]{1,64}$/.test(job.failure_code)
    ? job.failure_code
    : "job_failed";
}

/** The largest dataset record the sync reads: the recipe caps it at 256 KB. */
const RECORD_READ_MAX_BYTES = 512 * 1024;

type RecordRead =
  | { kind: "ok"; version: string; engine: string }
  | { kind: "failed"; word: "outputs_missing" | "record_unreadable" | "record_mismatch" }
  | { kind: "later"; reason: "results_unbound" | "read_failed" };

/**
 * Read the recipe's own record of a finished job, and check the files a run must have written. A results
 * bucket that is not bound, or a read that throws, is `later`: the stamp stays open and the next sync
 * asks again; nothing is decided from what could not be read.
 */
async function readFinishedRecord(
  env: Bindings,
  recipe: ComputeRecipe,
  jobId: string,
): Promise<RecordRead> {
  const bucket = env.COMPUTE_RESULTS;
  if (!bucket) return { kind: "later", reason: "results_unbound" };
  const wanted = recipeRequiredOutputs(recipe);
  try {
    const table = await bucket.head(resultsOutputKey(jobId, wanted.table));
    const head = await bucket.head(resultsOutputKey(jobId, wanted.record));
    if (!table || !head) return { kind: "failed", word: "outputs_missing" };
    if (head.size > RECORD_READ_MAX_BYTES) return { kind: "failed", word: "record_unreadable" };
    const object = await bucket.get(resultsOutputKey(jobId, wanted.record));
    if (!object) return { kind: "failed", word: "outputs_missing" };
    let value: unknown;
    try {
      value = JSON.parse(await object.text());
    } catch {
      return { kind: "failed", word: "record_unreadable" };
    }
    const record = readRecipeRecord(value);
    if (record === null) return { kind: "failed", word: "record_unreadable" };
    if (record.recipe !== recipe.name) return { kind: "failed", word: "record_mismatch" };
    return { kind: "ok", version: record.version, engine: record.engine };
  } catch {
    return { kind: "later", reason: "read_failed" };
  }
}

/** Whether a stamp is older than `minutes`, on SQLite's own clock (the column is `datetime('now')`). */
const OLDER_THAN_SQL = "SELECT (julianday('now') - julianday(?1)) * 1440 AS minutes";

async function ageMinutes(db: D1Database, timestamp: string): Promise<number> {
  const row = await db.prepare(OLDER_THAN_SQL).bind(timestamp).first<{ minutes: number | null }>();
  return row?.minutes ?? 0;
}

/**
 * Bring the open stamps up to date. A stamp with a job follows it: `finished` reads the recipe's own
 * record (the stamp then carries what ran), `failed` and `cancelled` end it; a stamp with no job yet
 * looks for one by its key and, after {@link STAMP_NO_JOB_MINUTES}, fails (a crash between the claim and
 * the job). At most {@link SYNC_STAMPS_PER_CALL} stamps a call, oldest first, each in its own try so one
 * bad row cannot hold the rest. Runs before every dispatch and every status read.
 */
export async function syncPipelineStamps(
  env: Bindings,
  limit: number = SYNC_STAMPS_PER_CALL,
): Promise<SyncResult> {
  const db = env.DB;
  const result: SyncResult = {
    examined: 0,
    succeeded: 0,
    failed: 0,
    linked: 0,
    later: 0,
    errored: 0,
  };
  const open = (await db.prepare(OPEN_STAMPS_SQL).bind(limit).all<StampRow>()).results;
  for (const stamp of open) {
    result.examined++;
    try {
      // Every stamp visited goes to the back of the line (the open list is ordered by `updated_at`), so
      // a stamp that cannot move on cannot starve the ones behind it. The state is not touched.
      await db.prepare(TOUCH_STAMP_SQL).bind(stamp.id).run();
      let jobId = stamp.job_id;
      if (jobId === null) {
        const account = await pipelinesAccountId(db);
        const key = await pipelineKey(stamp);
        const found =
          account === null
            ? null
            : await db.prepare(JOB_BY_KEY_SQL).bind(account, key).first<ComputeJobRow>();
        if (found) {
          await db.prepare(LINK_STAMP_SQL).bind(stamp.id, found.id).run();
          jobId = found.id;
          result.linked++;
        } else if ((await ageMinutes(db, stamp.created_at)) > STAMP_NO_JOB_MINUTES) {
          await finishStamp(db, stamp.id, "failed", "no_job");
          result.failed++;
          continue;
        } else {
          continue;
        }
      }
      const job = await db.prepare(JOB_END_SQL).bind(jobId).first<JobEnd>();
      if (!job) {
        await finishStamp(db, stamp.id, "failed", "job_missing");
        result.failed++;
        continue;
      }
      if (job.state === "failed" || job.state === "cancelled") {
        await finishStamp(db, stamp.id, "failed", failureWord(job));
        result.failed++;
        continue;
      }
      if (job.state !== "finished") continue;

      const recipe = findRecipe(stamp.recipe);
      if (recipe === null) {
        await finishStamp(db, stamp.id, "failed", "recipe_unknown");
        result.failed++;
        continue;
      }
      const read = await readFinishedRecord(env, recipe, job.id);
      if (read.kind === "later") {
        // Nothing is decided from what could not be read; say so, with ids and the reason only.
        console.error(
          `[compute-pipeline] sync_later stamp=${stamp.id} dataset=${stamp.dataset_id} reason=${read.reason}`,
        );
        result.later++;
        continue;
      }
      if (read.kind === "failed") {
        await finishStamp(db, stamp.id, "failed", read.word);
        result.failed++;
        continue;
      }
      if (read.version !== stamp.recipe_version || read.engine !== stamp.engine) {
        // The result carries a tuple other than the one claimed: hold the CLAIMED tuple (the registry is
        // out of date, or the image is), before the stamp is rewritten and the claim is lost.
        await db
          .prepare(HOLD_TUPLE_SQL)
          .bind(
            stamp.dataset_id,
            stamp.version,
            stamp.recipe,
            stamp.recipe_version,
            stamp.engine,
            job.id,
          )
          .run();
        console.error(
          `[compute-pipeline] tuple_mismatch stamp=${stamp.id} dataset=${stamp.dataset_id} job=${job.id}`,
        );
      }
      try {
        const moved = await db
          .prepare(SUCCEED_STAMP_SQL)
          .bind(stamp.id, read.version, read.engine)
          .run();
        if ((moved.meta?.changes ?? 0) > 0) result.succeeded++;
      } catch (err) {
        // The RUN may be good; this stamp cannot carry the tuple its record names, and the word says why.
        // Two unique indexes can refuse the rewrite, and they mean different things: the live index (the
        // tuple already holds a live or succeeded stamp) and the attempt index (the tuple has a row with
        // this attempt number, history only). The message names the columns of the one that refused, and
        // only the attempt index names the attempt column.
        if (!looksUnique(err)) throw err;
        const word = String(err).includes("compute_pipeline_stamps.attempt")
          ? "tuple_attempt_taken"
          : "tuple_already_stamped";
        console.error(
          `[compute-pipeline] ${word} stamp=${stamp.id} dataset=${stamp.dataset_id} job=${job.id}`,
        );
        await finishStamp(db, stamp.id, "failed", word);
        result.failed++;
      }
    } catch (err) {
      console.error(
        `[compute-pipeline] sync_failed stamp=${stamp.id} error=${err instanceof Error ? err.name : "unknown"}`,
      );
      result.errored++;
    }
  }
  return result;
}

// --- Reading ------------------------------------------------------------------------------------------

export interface StampFilter {
  recipe?: string;
  dataset?: string;
  state?: StampRow["state"];
  /** Rows with an id below this, for the next page of newest-first. */
  before?: number;
  limit: number;
}

/** A page of stamps, newest first. The filters are bound, never spliced. */
export async function listPipelineStamps(
  db: D1Database,
  filter: StampFilter,
): Promise<{ stamps: StampRow[]; nextBefore: number | null }> {
  const rows = (
    await db
      .prepare(
        `SELECT ${STAMP_COLUMNS} FROM compute_pipeline_stamps
          WHERE (?1 IS NULL OR recipe = ?1) AND (?2 IS NULL OR dataset_id = ?2)
            AND (?3 IS NULL OR state = ?3) AND (?4 IS NULL OR id < ?4)
          ORDER BY id DESC LIMIT ?5`,
      )
      .bind(
        filter.recipe ?? null,
        filter.dataset ?? null,
        filter.state ?? null,
        filter.before ?? null,
        filter.limit + 1,
      )
      .all<StampRow>()
  ).results;
  const more = rows.length > filter.limit;
  const stamps = more ? rows.slice(0, filter.limit) : rows;
  return { stamps, nextBefore: more ? (stamps[stamps.length - 1]?.id ?? null) : null };
}

// --- The queue and the dry run ----------------------------------------------------------------------------

/** A dataset that is eligible and whose newest version has no live or succeeded stamp for the recipe's tuple. */
export interface Candidate {
  dataset_id: string;
  version: string;
  tag: string;
}

/**
 * The eligible datasets a recipe has not been run over at the newest version, by id, at most `limit`.
 * The SQL selects (the predicate and the absence of a live or succeeded stamp); the TypeScript re-checks
 * every row it returns, and a version with no data-plane tag is skipped. A dataset the sync has not
 * caught up with is not a candidate: its open stamp holds the tuple. A tuple whose stamp FAILED is not a
 * candidate for {@link RETRY_COOLDOWN_DAYS} days after the failure, nor once it has failed
 * {@link MAX_FAILED_ATTEMPTS} times (a refusal is not a failure: the pool's word is not the dataset's),
 * decided in the SQL so that failing datasets at the head of the order do not fill the page.
 */
export async function pipelineCandidates(
  db: D1Database,
  recipe: ComputeRecipe,
  limit: number,
  after = "",
): Promise<Candidate[]> {
  const out: Candidate[] = [];
  let cursor = after;
  // A page may hold rows skipped for want of a tag; read on until the limit or the end.
  for (let page = 0; page < 20 && out.length < limit; page++) {
    const rows = (
      await db
        .prepare(
          `SELECT ${PIPELINE_ROW_COLUMNS},
                  (${NEWEST_VERSION_SQL("d")}) AS newest_version,
                  (${NEWEST_VERSION_SQL("d", "total_files")}) AS newest_total_files
             FROM datasets d
            WHERE d.dataset_id > ?1
              AND ${PIPELINE_ELIGIBLE_SQL}
              AND NOT EXISTS (
                SELECT 1 FROM compute_pipeline_stamps s
                 WHERE s.dataset_id = d.dataset_id AND s.recipe = ?2 AND s.recipe_version = ?3
                   AND s.engine = ?4 AND s.state IN ('dispatched', 'succeeded')
                   AND s.version = ${VERSION_TAG_SQL(`(${NEWEST_VERSION_SQL("s")})`)})
              AND NOT EXISTS (
                SELECT 1 FROM compute_pipeline_stamps f
                 WHERE f.dataset_id = d.dataset_id AND f.recipe = ?2 AND f.recipe_version = ?3
                   AND f.engine = ?4 AND f.state = 'failed'
                   AND ${COUNTS_AS_FAILURE_SQL("f")}
                   AND f.updated_at >= datetime('now', ?6)
                   AND f.version = ${VERSION_TAG_SQL(`(${NEWEST_VERSION_SQL("f")})`)})
              AND (
                SELECT COUNT(*) FROM compute_pipeline_stamps c
                 WHERE c.dataset_id = d.dataset_id AND c.recipe = ?2 AND c.recipe_version = ?3
                   AND c.engine = ?4 AND c.state = 'failed'
                   AND ${COUNTS_AS_FAILURE_SQL("c")}
                   AND c.version = ${VERSION_TAG_SQL(`(${NEWEST_VERSION_SQL("c")})`)}) < ?7
            ORDER BY d.dataset_id LIMIT ?5`,
        )
        .bind(
          cursor,
          recipe.name,
          recipe.version,
          recipe.engine,
          Math.max(limit, 25),
          `-${RETRY_COOLDOWN_DAYS} days`,
          MAX_FAILED_ATTEMPTS,
        )
        .all<PipelineRow & { newest_version: string | null; newest_total_files: number | null }>()
    ).results;
    if (rows.length === 0) break;
    for (const row of rows) {
      cursor = row.dataset_id;
      if (out.length >= limit) break;
      if (!isPipelineEligible(row) || row.newest_version === null) continue;
      // A version no launcher can stage (no data-plane tag, or a manifest over the bound) is never a
      // candidate: it would be refused again on every run and hold a place in the queue for good.
      const tag = dataTagForVersion(row.newest_version);
      if (tag === null) continue;
      if (
        row.newest_total_files !== null &&
        row.newest_total_files > PIPELINE_MANIFEST_MAX_ENTRIES
      ) {
        continue;
      }
      out.push({ dataset_id: row.dataset_id, version: row.newest_version, tag });
    }
    if (rows.length < Math.max(limit, 25)) break;
  }
  return out;
}

// --- The dry run ---------------------------------------------------------------------------------------------

export interface DryRunInput {
  recipe: string;
  /** One dataset (and optionally a version), or none for the queue. */
  datasetId?: string;
  version?: string;
  /** For the queue: how many datasets to list. */
  limit?: number;
}

export interface DryRunConfig {
  /** `computeEnabled`: a real run needs it. */
  compute_enabled: boolean;
  /** `COMPUTE_RUNTIME_IMAGE` is a digest-pinned reference. */
  runtime_image: boolean;
  /** The service account exists, is approved and is a service. */
  pipelines_account: boolean;
}

export type DryRunResult =
  | { ok: false; code: "recipe_unknown" | "recipe_placeholder" }
  | {
      ok: true;
      recipe: string;
      /** What the hold of one job is, in milli-SU. */
      estimate_milli_per_job: number;
      /** The same for every dataset listed. */
      estimate_milli_total: number;
      config: DryRunConfig;
      /** The datasets a run would dispatch (a named dataset that would be refused is not here). */
      would_dispatch: Array<{ dataset_id: string; version: string }>;
      /**
       * The room a run would have in the recipe's pool and what would bound it, as a live run reads it
       * (`clampRun`); `would_dispatch` of the queue is trimmed to it. Absent only when the recipe's tuple
       * is held (`registry_drift`), which stops a run before the caps are read.
       */
      room?: {
        daily_left: number;
        live_left: number;
        tenant_left: number;
        limited_by: ComputePipelineLimitedBy;
      };
      /**
       * Why a named dataset would be refused, or the count of the catalog's datasets that fail each term
       * of the predicate, over every dataset the queue read. A dataset fails every term it fails, so the
       * counts add up to more than the number of datasets.
       */
      blocked?: { code: string; blocked_by: PipelineTermId[]; version?: string };
      blocked_by_term?: Record<string, number>;
    };

/** The most dataset rows the dry run reads to count what blocks each term. */
const DRY_RUN_SCAN_ROWS = 5000;

/**
 * What a run would do, with nothing written: the eligible datasets (the queue trimmed to the room a live
 * run would have, `clampRun`), the estimated SU per job and in total, and what blocks the ineligible ones. It reads D1 and the configuration and nothing else, makes
 * no stamp, no job and no hold, calls neither Tapis nor a bucket, and works in every environment
 * (a non-production Worker answers from its own catalog). For one named dataset it gives the very
 * verdict a run would (`resolveRun`, and a live stamp for the tuple); for the queue it lists the next
 * candidates and, for the datasets that are not candidates, how many fail each term.
 */
export async function pipelineDryRun(env: Bindings, input: DryRunInput): Promise<DryRunResult> {
  const recipe = findRecipe(input.recipe);
  if (recipe === null) return { ok: false, code: "recipe_unknown" };
  if (recipe.placeholder === true) return { ok: false, code: "recipe_placeholder" };
  const db = env.DB;
  const perJob = recipeEstimateMilli(recipe);
  const config: DryRunConfig = {
    compute_enabled: computeEnabled(env),
    runtime_image: readRuntimeImage(env).state === "ok",
    pipelines_account: (await pipelinesAccountId(db)) !== null,
  };
  const base = { ok: true as const, recipe: recipe.name, estimate_milli_per_job: perJob, config };
  if (await tupleHeld(db, recipe)) {
    return {
      ...base,
      estimate_milli_total: 0,
      would_dispatch: [],
      blocked: { code: "registry_drift", blocked_by: [] },
    };
  }

  // The caps, read as a live run reads them.
  const policy = (await getPolicy(db)).policy;
  const caps = await pipelineRoom(db, policy, poolOfRecipe(recipe));

  if (input.datasetId !== undefined) {
    // A named dataset is bounded by the live cap and only counted by the daily one (see `dispatchEligible`).
    const named = {
      ...caps,
      limited_by:
        caps.live_left <= 0
          ? ("live_cap" as const)
          : caps.tenant_left <= 0
            ? ("tenant" as const)
            : ("limit" as const),
    };
    const resolved = await resolveRun(db, input.datasetId, input.version);
    if (!resolved.ok) {
      return {
        ...base,
        room: named,
        estimate_milli_total: 0,
        would_dispatch: [],
        blocked: {
          code: resolved.code,
          blocked_by: resolved.extra.blockedBy ?? [],
          ...(resolved.extra.version === undefined ? {} : { version: resolved.extra.version }),
        },
      };
    }
    const live = await db
      .prepare(
        `SELECT 1 FROM compute_pipeline_stamps
          WHERE dataset_id = ?1 AND version = ?2 AND recipe = ?3 AND recipe_version = ?4
            AND engine = ?5 AND state IN ('dispatched', 'succeeded')`,
      )
      .bind(input.datasetId, resolved.tag, recipe.name, recipe.version, recipe.engine)
      .first();
    if (live) {
      return {
        ...base,
        room: named,
        estimate_milli_total: 0,
        would_dispatch: [],
        blocked: { code: "live_attempt_exists", blocked_by: [], version: resolved.tag },
      };
    }
    if (caps.live_left <= 0) {
      return {
        ...base,
        room: named,
        estimate_milli_total: 0,
        would_dispatch: [],
        blocked: { code: "over_concurrency", blocked_by: [], version: resolved.tag },
      };
    }
    // The tenant ceiling, worded after the class cap as a refused hold is.
    if (caps.tenant_left <= 0) {
      return {
        ...base,
        room: named,
        estimate_milli_total: 0,
        would_dispatch: [],
        blocked: { code: "platform_busy", blocked_by: [], version: resolved.tag },
      };
    }
    return {
      ...base,
      room: named,
      estimate_milli_total: perJob,
      would_dispatch: [{ dataset_id: input.datasetId, version: resolved.tag }],
    };
  }

  const room = clampRun(input.limit ?? 20, caps);
  const candidates = room.attempts > 0 ? await pipelineCandidates(db, recipe, room.attempts) : [];
  // Everything else: what the datasets that are not eligible fail, counted per term.
  const rows = (
    await db
      .prepare(`SELECT ${PIPELINE_ROW_COLUMNS} FROM datasets d ORDER BY d.dataset_id LIMIT ?1`)
      .bind(DRY_RUN_SCAN_ROWS)
      .all<PipelineRow>()
  ).results;
  const blockedByTerm: Record<string, number> = Object.fromEntries(
    PIPELINE_TERMS.map((t) => [t.id, 0]),
  );
  for (const row of rows) {
    for (const term of failedPipelineTerms(row))
      blockedByTerm[term] = (blockedByTerm[term] ?? 0) + 1;
  }
  return {
    ...base,
    room: {
      daily_left: room.daily_left,
      live_left: room.live_left,
      tenant_left: room.tenant_left,
      limited_by: room.limited_by,
    },
    estimate_milli_total: perJob * candidates.length,
    would_dispatch: candidates.map((c) => ({ dataset_id: c.dataset_id, version: c.tag })),
    blocked_by_term: blockedByTerm,
  };
}

// --- The room a run has --------------------------------------------------------------------------------------

/** The pool a recipe's jobs are held in, from the partition its job asks for. */
export const poolOfRecipe = (recipe: ComputeRecipe): ComputePool =>
  PARTITIONS[recipe.partition as PartitionName].pool;

/** Pipeline jobs made today (UTC): `created_at` is `datetime('now')`, so a day starts at `date('now')`. */
export const PIPELINE_JOBS_TODAY_SQL = `SELECT COUNT(*) AS n FROM compute_jobs
  WHERE source = 'pipeline' AND created_at >= date('now')`;

const countOf = async (db: D1Database, sql: string, ...binds: unknown[]): Promise<number> =>
  (
    await db
      .prepare(sql)
      .bind(...binds)
      .first<{ n: number }>()
  )?.n ?? 0;

/** Pipeline jobs made today (UTC), across every recipe and every pool, whoever dispatched them. */
export const pipelineJobsToday = (db: D1Database): Promise<number> =>
  countOf(db, PIPELINE_JOBS_TODAY_SQL);

/** What is left of NEMAR's pipelines' two caps, read from the owner's policy, for one pool. */
export interface PipelineRoom {
  /** `pipelines.dailyJobCap` minus the pipeline jobs made today, never below 0. */
  daily_left: number;
  /** `pipelines.maxLiveJobs` of the pool minus the pipeline jobs live in it, never below 0. */
  live_left: number;
  /**
   * The slots the pipelines' class could take under the tenant ceiling (`tenantRoom`), never below 0: the
   * ceiling less everything occupied less the slots the other classes' floors are still owed.
   */
  tenant_left: number;
}

/**
 * The room the pipelines have in a pool right now: the one reading of both caps, used by the daily
 * dispatcher, an administrator's run and the dry run. The live count is the statement the hold guards on
 * (`PIPELINE_LIVE_JOBS_SQL`), so the room that is read is the room that is enforced; the daily count
 * is a read and nothing more (a clamp, never a guard: see {@link dispatchEligible}). The tenant room is
 * the guard's own arithmetic over one read of the tenant counts (`TENANT_COUNTS_SQL`, which scans the table
 * for orphans), read once per call.
 *
 * `PIPELINE_JOBS_TODAY_SQL` is a full scan of `compute_jobs` (no index serves a count by `created_at`
 * over every account), so a caller that has the day's count already passes it as `today` and the scan is
 * not made again: the daily dispatcher counts once per tick, and `dispatchEligible` is handed the room
 * it computed instead of reading its own.
 */
export async function pipelineRoom(
  db: D1Database,
  policy: ComputePolicy,
  pool: ComputePool,
  today?: number,
): Promise<PipelineRoom> {
  const madeToday = today ?? (await pipelineJobsToday(db));
  const live = await countOf(db, PIPELINE_LIVE_JOBS_SQL, pool);
  return {
    daily_left: Math.max(0, policy.pipelines.dailyJobCap - madeToday),
    live_left: Math.max(0, policy.pipelines.maxLiveJobs[pool] - live),
    tenant_left: tenantRoom(await tenantFacts(db, policy), "pipelines"),
  };
}

/** How many datasets one run may try, and what bounded it. */
export interface RunRoom extends PipelineRoom {
  /** `min(limit, per-invocation bound, daily_left, live_left, tenant_left)`. */
  attempts: number;
  limited_by: ComputePipelineLimitedBy;
}

/**
 * The number of datasets a run over the eligible ones may try: the smallest of what was asked for, the
 * per-invocation bound (`COMPUTE_PIPELINE_RUN_PER_INVOCATION`: a Worker request cannot carry 100
 * dispatches, about 25 subrequests each against an allowance of about 1,000), what is left of the daily
 * cap, what is left of the pool's live cap and what is left of the tenant ceiling for the pipelines' class.
 * The same clamp serves the live run and the dry run, so a preview is what a run would do (the hold's own
 * guard still decides what is made, so a run that races another is refused there). On a tie the first of
 * `COMPUTE_PIPELINE_LIMITED_BY` is named (limit, per_invocation, daily_cap, live_cap, tenant), so a run that
 * ends at exactly the number it was asked for was not "limited".
 */
export function clampRun(limit: number, room: PipelineRoom): RunRoom {
  const candidates: Array<[ComputePipelineLimitedBy, number]> = [
    ["limit", limit],
    ["per_invocation", COMPUTE_PIPELINE_RUN_PER_INVOCATION],
    ["daily_cap", room.daily_left],
    ["live_cap", room.live_left],
    ["tenant", room.tenant_left],
  ];
  let [limited_by, attempts] = candidates[0] as [ComputePipelineLimitedBy, number];
  for (const [by, n] of candidates) {
    if (n < attempts) {
      attempts = n;
      limited_by = by;
    }
  }
  return { ...room, attempts, limited_by };
}

/** The word a run stops with when a cap, and not its own limit, ended it; null for the bound or the limit. */
export const stopWordOf = (by: ComputePipelineLimitedBy): PipelineRefusal | null =>
  by === "live_cap"
    ? "over_concurrency"
    : by === "daily_cap"
      ? "daily_cap_reached"
      : by === "tenant"
        ? "platform_busy"
        : null;

// --- A run over the queue ---------------------------------------------------------------------------------------

/** The refusals that would repeat for the next dataset, so a run over the queue stops at the first. */
const STOPS_A_RUN: ReadonlySet<PipelineRefusal> = new Set<PipelineRefusal>([
  "compute_disabled",
  "runtime_unavailable",
  "pipelines_account_missing",
  "recipe_placeholder",
  "invalid_spec",
  "insufficient_balance",
  "platform_budget_exhausted",
  "suspended",
  "over_concurrency",
  // The tenant ceiling is full for the pipelines' class: the next dataset meets the same count.
  "platform_busy",
  "create_failed",
]);

export interface EligibleRun {
  results: DispatchResult[];
  dispatched: number;
  /** The refusal that stopped the run before the limit, if one did. */
  stoppedBy: PipelineRefusal | null;
  /** The room the run had and what bounded it; null when the run ended before it was read. */
  room: RunRoom | null;
}

/**
 * Dispatch a recipe over the next datasets it has not been run over: the stamps are synced first,
 * candidates are taken in dataset order, and every one goes through {@link dispatchPipelineJob}, so each
 * is checked again from its own row. A refusal that would repeat for the next dataset (a hold refused,
 * the switch off, no image, no account) stops the run; a refusal about one dataset does not.
 *
 * THE CAPS APPLY TO EVERY ACTOR. A run tries at most `min(limit, the per-invocation bound, daily_left,
 * live_left)` datasets (`clampRun`), read from the policy and the tables before it starts. When the
 * room is 0 nothing is tried and the run stops with `daily_cap_reached` or `over_concurrency`; when a
 * cap, and not the number asked for, ended a run that dispatched everything it tried, it stops with that
 * cap's word too (the per-invocation bound is no refusal: the run is asked again). The live cap is also a
 * guard inside every hold (`PIPELINE_LIVE_JOBS_GUARD_SQL`), so a run that raced another for the last slot
 * is refused there. The daily cap is only this read, a clamp and not a guard, for two reasons of P1:
 * `PIPELINE_JOBS_TODAY_SQL` is a full scan of `compute_jobs` (no index serves it), which a guard would
 * run inside every pipeline hold's write; and the ways around that (an account-bound count served by
 * `compute_jobs_account_created`, or a new index) need an account bind or a migration, which P1 has not.
 * So runs that race can together pass it: by up to (the number of racing runs minus 1) times
 * min(the per-invocation bound, the daily room, the live room), the bound of one run each time. The money
 * ceiling is a different fence: the pipelines pool's balance, enforced atomically by the same hold
 * (`HOLD_INSERT_SQL`; pipelines have no budget pool), though an overrun can push it below zero, so both
 * caps only pace spending. A single named dataset is bounded by the live guard and the pool's balance
 * and is only COUNTED by the daily cap, never refused by it (the owner ruled this for P1 and may override
 * later). An atomic daily guard, if wanted, belongs in P2 beside the tenant-ceiling guard, with an
 * account-bound count.
 */
export async function dispatchEligible(
  env: Bindings,
  input: {
    recipe: string;
    limit: number;
    actor: PipelineActor;
    after?: string;
    /** False when the caller has just synced the stamps itself (the cron, once for all its recipes). */
    sync?: boolean;
    /**
     * The room the caller has just read for this recipe's pool (`pipelineRoom`): used as it is, so the
     * day's count is not scanned a second time. Without it the run reads its own.
     */
    room?: PipelineRoom;
  },
): Promise<EligibleRun> {
  const run: EligibleRun = { results: [], dispatched: 0, stoppedBy: null, room: null };
  const recipe = findRecipe(input.recipe);
  if (recipe === null || recipe.placeholder === true) {
    const code = recipe === null ? "recipe_unknown" : "recipe_placeholder";
    run.results.push(fail(code, ""));
    run.stoppedBy = code;
    return run;
  }
  if (input.sync !== false) await syncPipelineStamps(env);
  if (await tupleHeld(env.DB, recipe)) {
    run.results.push(fail("registry_drift", ""));
    run.stoppedBy = "registry_drift";
    return run;
  }
  const caps =
    input.room ??
    (await pipelineRoom(env.DB, (await getPolicy(env.DB)).policy, poolOfRecipe(recipe)));
  const room = clampRun(input.limit, caps);
  run.room = room;
  if (room.attempts <= 0) {
    run.stoppedBy = stopWordOf(room.limited_by);
    return run;
  }
  try {
    for (const candidate of await pipelineCandidates(env.DB, recipe, room.attempts, input.after)) {
      if (run.dispatched >= room.attempts) break;
      const result = await dispatchPipelineJob(env, {
        recipe: recipe.name,
        datasetId: candidate.dataset_id,
        version: candidate.tag,
        actor: input.actor,
      });
      run.results.push(result);
      if (result.ok) {
        run.dispatched++;
      } else if (STOPS_A_RUN.has(result.code)) {
        run.stoppedBy = result.code;
        break;
      }
    }
    // A cap ended the run, not the number asked for and not a refusal: say which cap.
    if (run.stoppedBy === null && run.dispatched >= room.attempts) {
      run.stoppedBy = stopWordOf(room.limited_by);
    }
  } catch (err) {
    // What was dispatched before the throw is real (jobs exist, holds are taken): the run reports it
    // instead of losing the count to the exception, and says it was cut short.
    console.error(
      `[compute-pipeline] run_failed recipe=${recipe.name} dispatched=${run.dispatched} error=${err instanceof Error ? err.name : "unknown"}`,
    );
    run.stoppedBy = "run_failed";
  }
  return run;
}
