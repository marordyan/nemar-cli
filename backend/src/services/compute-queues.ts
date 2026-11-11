/**
 * What each Slurm queue can schedule, as far as a submit's memory is concerned (epic #2005 phase A5,
 * #2010; ADR 0118, round 2 of the review of PR #2041).
 *
 * `submitMemoryMb` (the contract) derives the memory a job is CHARGED for: a whole `compute` node is 128
 * core-units of 2,048 MB, which is 262,144 MB, the node's nominal physical memory. A node can never
 * schedule all of that (the operating system and the scheduler keep some), and the execution system the
 * program registers with Tapis (nemarOrg/nemar-process, `deploy/tapis/systems/exec.json.tmpl`, the
 * `maxMemoryMB` of each logical queue) declares the most a job may ask each queue for. A submit that asks
 * for more is refused by Tapis's queue-limit check or by Slurm, so the job would end `tapis_submit_failed`
 * as a platform failure having done nothing wrong. The memory a submit carries is therefore the derived
 * figure CLAMPED to its queue's maximum.
 *
 * THE FIGURES come from the public Expanse user guide through that definition, which marks them
 * "unverified": they need confirming with the site (an owner item). They are declared ONCE, here, in the
 * backend (the frozen contract has no slot for them and its schema and checksum stay as they are), and
 * `compute-queues.test.ts` pins them as literals and, when a nemar-process checkout is named in the
 * environment variable `NEMAR_PROCESS_DIR`, compares them with that file. A change to the definition
 * must change this table in the same breath.
 *
 * A job whose own `memory_mb` is above its queue's maximum is sent the maximum, not refused here: the
 * hold was priced at what it asked for, so it is charged for memory it is not given. Refusing such a
 * request when the job is created (a per-queue memory ceiling in the policy) belongs to a later phase.
 */

import { type PartitionName, submitMemoryMb } from "../../../shared/contract/compute.js";

/** The most memory per node, in MB, a submit may ask each queue for. UNVERIFIED with the site. */
export const QUEUE_MAX_MEMORY_MB: Readonly<Record<PartitionName, number>> = Object.freeze({
  shared: 249_208,
  compute: 249_208,
  debug: 249_208,
  "large-shared": 2_048_000,
  preempt: 249_208,
  gpu: 377_308,
  "gpu-shared": 377_308,
  "gpu-debug": 377_308,
  "gpu-preempt": 377_308,
});

/**
 * The memory per node a submit asks for on `partition`: what the charge pays for (`submitMemoryMb`), at
 * most what the queue can schedule. Throws RangeError as `submitMemoryMb` does.
 */
export function submitMemoryForQueue(
  partition: PartitionName,
  resources: { cores?: number; memory_mb?: number | null; gpus?: number },
): number {
  return Math.min(submitMemoryMb(partition, resources), QUEUE_MAX_MEMORY_MB[partition]);
}
