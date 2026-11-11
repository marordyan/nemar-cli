/**
 * Seeds and steps for the pipeline-dispatch suites (epic #2005 phase A6, #2011; ADR 0118), on top of
 * the lifecycle fixture: the service account NEMAR's own jobs are made for, a funded platform
 * `pipelines` pool, public EEG dataset rows, and the Tapis and launcher steps that take a job to its end.
 *
 * Nothing here decides anything NEMAR decides. The rows are written with SQL the production tables
 * accept, the account is made through the same columns the owner's runbook sets, and the launcher's
 * end is `playLauncher`, whose scope and limits the lifecycle fixture states.
 */

import { COMPUTE_RECIPES, recipeRequiredOutputs } from "../../../shared/compute-recipes";
import { PIPELINES_TAPIS_OWNER } from "../../../shared/contract/compute";
import { advanceComputeJob } from "../../src/services/compute-lifecycle";
import type { Bindings } from "../../src/types/bindings";
import {
  type LifecycleFixture,
  MINUTE,
  playLauncher,
  reread,
  setTapisTimes,
} from "./compute-lifecycle-fixture";
import { fundPlatform, seedUser } from "./compute-seed";

/**
 * The service account `nemar-pipelines`, made the way the owner's runbook makes it (kind `service`).
 * With `reuse` an account that is already there (a database that is never reset) is returned.
 */
export async function seedPipelinesAccount(
  env: Bindings,
  over: { kind?: string; status?: string; deleted?: boolean; reuse?: boolean } = {},
): Promise<number> {
  if (over.reuse) {
    const there = await env.DB.prepare("SELECT id FROM users WHERE username = ?1")
      .bind(PIPELINES_TAPIS_OWNER)
      .first<{ id: number }>();
    if (there) return there.id;
  }
  const id = await seedUser(env.DB, {
    username: PIPELINES_TAPIS_OWNER,
    email: "nemar-pipelines@example.org",
    status: over.status ?? "approved",
    deleted_at: over.deleted ? "2026-01-01 00:00:00" : null,
  });
  await env.DB.prepare("UPDATE users SET account_kind = ?1 WHERE id = ?2")
    .bind(over.kind ?? "service", id)
    .run();
  return id;
}

/** A funded `pipelines` platform budget of the CPU pool and, optionally, the GPU pool. */
export async function fundPipelines(env: Bindings, milli = 10_000_000, gpu = false): Promise<void> {
  await fundPlatform(env.DB, "pipelines", milli, "cpu");
  if (gpu) await fundPlatform(env.DB, "pipelines", milli, "gpu");
}

export interface DatasetOver {
  /** The owning user's id; -1 (the catalog sentinel) is right only where foreign keys are not enforced. */
  owner?: number;
  status?: string;
  visibility?: string;
  anonymous?: number;
  firstPublishedAt?: string | null;
  withdrawnAt?: string | null;
  ezidStatus?: string | null;
  modalities?: string | null;
  versions?: Array<[version: string, createdAt: string, totalFiles?: number | null]>;
}

/** A public EEG dataset with one version `1.0.0` unless told otherwise. */
export async function seedEegDataset(
  env: Bindings,
  id: string,
  over: DatasetOver = {},
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, anonymous,
                           first_published_at, withdrawn_at, ezid_status, modalities)
     VALUES (?1, ?2, ?10, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  )
    .bind(
      id,
      `Dataset ${id}`,
      over.status ?? "active",
      over.visibility ?? "public",
      over.anonymous ?? 0,
      over.firstPublishedAt === undefined ? "2026-01-02 03:04:05" : over.firstPublishedAt,
      over.withdrawnAt ?? null,
      over.ezidStatus ?? null,
      over.modalities === undefined ? "eeg" : over.modalities,
      over.owner ?? -1,
    )
    .run();
  for (const [version, createdAt, totalFiles] of over.versions ?? [
    ["1.0.0", "2026-01-02 03:04:05", null],
  ]) {
    await env.DB.prepare(
      `INSERT INTO dataset_versions (dataset_id, version, doi, provider, created_at, total_files)
       VALUES (?1, ?2, ?3, 'ezid', ?4, ?5)`,
    )
      .bind(id, version, `10.82901/nemar.${id}.v${version}`, createdAt, totalFiles ?? null)
      .run();
  }
}

/** Move the Tapis job and let the Worker read it back, as the tick and the webhook both do. */
export async function drive(
  fx: LifecycleFixture,
  env: Bindings,
  jobId: string,
  uuid: string,
  status: string,
  cond?: string,
) {
  fx.tapis.advance(uuid, status, cond);
  return advanceComputeJob(env, jobId);
}

/** The exit code Tapis reports for the job (`remoteResultInfo`, as the lifecycle suites set it). */
export function setTapisExit(fx: LifecycleFixture, uuid: string, exit: number): void {
  const record = fx.tapis.jobs.get(uuid)?.record;
  if (record) record.remoteResultInfo = String(exit);
}

/** The record a `nemar-floor` run writes, in the shape `readRecipeRecord` reads. */
export function recipeRecord(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    extensions: {
      nemar: {
        recipe: { id: "nemar-floor", version: "1.0.0" },
        engine: { package: "eegprep", version: "0.5.0" },
        counts: { discovered: 2, succeeded: 2, failed: 0, skipped: 0 },
        ...over,
      },
    },
  });
}

/** The product a successful floor run uploads: the dataset record and the recordings table. */
export function floorOutputs(recordText: string = recipeRecord()): Array<{
  path: string;
  content: string;
}> {
  const floor = COMPUTE_RECIPES.find((r) => r.name === "nemar-floor");
  if (!floor) throw new Error("no nemar-floor");
  const wanted = recipeRequiredOutputs(floor);
  return [
    { path: wanted.record, content: recordText },
    { path: wanted.table, content: "path\tstatus\nsub-01/eeg/sub-01_eeg.edf\tsucceeded\n" },
  ];
}

/** Take a submitted job to Tapis `FINISHED` with a launcher that did what the plan says. */
export async function finishAtTapis(
  fx: LifecycleFixture,
  env: Bindings,
  jobId: string,
  plan: Parameters<typeof playLauncher>[4] = {},
  usedMs = 30 * MINUTE,
) {
  const uuid = (await reread(env, jobId)).tapis_uuid as string;
  await drive(fx, env, jobId, uuid, "RUNNING");
  await drive(fx, env, jobId, uuid, "ARCHIVING");
  await playLauncher(fx, env, await reread(env, jobId), uuid, plan);
  fx.tapis.advance(uuid, "FINISHED");
  setTapisTimes(fx, uuid, usedMs, 0);
  setTapisExit(fx, uuid, plan.exitNumber ?? 0);
  return advanceComputeJob(env, jobId);
}
