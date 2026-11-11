/**
 * The four information flags of a compute job and the columns that hold them, in one place (epic
 * #2005, ADR 0118). `compute_jobs` stores each as `flag_<word>` (0 or 1); a view of a job lists the
 * words whose column is 1. The map is typed against `ComputeJobFlag`, so a flag added to
 * `COMPUTE_JOB_FLAGS` without a column does not compile.
 */

import { COMPUTE_JOB_FLAGS, type ComputeJobFlag } from "../../../shared/compute-state.js";

export type FlagColumn = `flag_${ComputeJobFlag}`;

export const FLAG_COLUMN: Record<ComputeJobFlag, FlagColumn> = {
  unreserved: "flag_unreserved",
  unattributed: "flag_unattributed",
  mismatch: "flag_mismatch",
  overrun: "flag_overrun",
};

/** The columns of a job row that carry the flags: what a query must select to call `flagsOf`. */
export type FlagColumns = Record<FlagColumn, number>;

/** The flags a row has set, in the declared order of `COMPUTE_JOB_FLAGS`. */
export function flagsOf(row: FlagColumns): ComputeJobFlag[] {
  return COMPUTE_JOB_FLAGS.filter((f) => row[FLAG_COLUMN[f]] === 1);
}
