/**
 * A job taken through the real lifecycle to the end, for the suites that need a settled job to report on
 * or to correct (epic #2005 phase A7, #2012): made by `createJob` with its hold, submitted to the Tapis
 * stand-in, run, given the launcher's files, finished and read back by `advanceComputeJob`. Nothing here
 * decides anything the Worker decides.
 */

import { advanceComputeJob, submitComputeJob } from "../../src/services/compute-lifecycle";
import {
  type LifecycleFixture,
  MINUTE,
  type MadeJob,
  makeJob,
  playLauncher,
  reread,
  setTapisTimes,
} from "./compute-lifecycle-fixture";

/** A job that ran four cores for `minutes` and ended `finished`: provisionally charged `minutes / 15` SU. */
export async function endedJob(
  fx: LifecycleFixture,
  minutes = 30,
  over: Parameters<typeof makeJob>[1] = {},
): Promise<MadeJob & { uuid: string }> {
  const made = await makeJob(fx, over);
  const submitted = await submitComputeJob(made.env, made.job.id);
  if (!submitted.ok) throw new Error(`could not submit: ${submitted.outcome}`);
  const uuid = (await reread(made.env, made.job.id)).tapis_uuid as string;
  fx.tapis.advance(uuid, "QUEUED");
  fx.tapis.advance(uuid, "RUNNING");
  await advanceComputeJob(made.env, made.job.id);
  await playLauncher(fx, made.env, await reread(made.env, made.job.id), uuid, {});
  fx.tapis.advance(uuid, "FINISHED");
  setTapisTimes(fx, uuid, minutes * MINUTE, 0);
  await advanceComputeJob(made.env, made.job.id);
  const job = await reread(made.env, made.job.id);
  if (job.state !== "finished") throw new Error(`the job is ${job.state}, not finished`);
  return { ...made, job, uuid };
}
