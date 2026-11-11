/**
 * The two log lines of the compute crons (epic #2005 review fixes of 2026-11-06; ADR 0118): the 30-minute
 * tick's `computeAdvanceLogLine` and the cancel sweep's `cancellationsLogLine`. They are pure, and they are
 * the only thing an operator sees of a tick, so each rule below is pinned from both sides:
 *  - a tick that did nothing and found nothing wrong says nothing;
 *  - a tick where Tapis could not be read for a row is NOT silent (it was, when nothing else happened);
 *  - the level is `error` for a failed step or an abandoned copy, `warn` for a fault that waits, `info` for work;
 *  - every counter is in the line, with its own value (a dropped or transposed counter fails);
 *  - no line carries an identifier.
 */

import { describe, expect, test } from "bun:test";
import {
  type CancelSweepResult,
  type ComputeTickResult,
  cancellationsLogLine,
  computeAdvanceLogLine,
} from "../src/services/compute-advance";

const quiet = (): ComputeTickResult => ({
  examined: 0,
  submitted: 0,
  advanced: 0,
  waiting: 0,
  unreachable: 0,
  unknown_status: 0,
  repaired: 0,
  repair_attempted: 0,
  cleared: 0,
  copy_abandoned: 0,
  errors: [],
  errorClass: null,
});

const quietCancel = (): CancelSweepResult => ({
  examined: 0,
  cancel_failed: 0,
  cancel_pending_failed: 0,
  errors: [],
  errorClass: null,
});

describe("the 30-minute tick's line", () => {
  test("a tick that did nothing and found nothing wrong says nothing; waiting alone is not news", () => {
    expect(computeAdvanceLogLine(quiet())).toBeNull();
    expect(computeAdvanceLogLine({ ...quiet(), examined: 4, waiting: 4 })).toBeNull();
  });

  test("Tapis unreachable for every row is a warning, not silence (MUTATION: drop `unreachable` from the condition)", () => {
    const log = computeAdvanceLogLine({ ...quiet(), examined: 7, unreachable: 7 });
    expect(log?.level).toBe("warn");
    expect(log?.line).toContain("unreachable=7");
  });

  test("an unknown status and a repair that did not finish are warnings too", () => {
    expect(computeAdvanceLogLine({ ...quiet(), unknown_status: 1 })?.level).toBe("warn");
    expect(computeAdvanceLogLine({ ...quiet(), repair_attempted: 2 })?.level).toBe("warn");
  });

  test("a failed step and an abandoned copy are errors, and an error outranks a warning (MUTATION: drop the error level)", () => {
    const failed = computeAdvanceLogLine({
      ...quiet(),
      errors: ["row_failed"],
      errorClass: "Error",
    });
    expect(failed?.level).toBe("error");
    expect(failed?.line).toContain("errors=row_failed");
    expect(failed?.line).toContain("class=Error");
    expect(computeAdvanceLogLine({ ...quiet(), copy_abandoned: 1 })?.level).toBe("error");
    expect(
      computeAdvanceLogLine({ ...quiet(), unreachable: 3, errors: ["tick_failed"] })?.level,
    ).toBe("error");
  });

  test("work done is info, and a warning outranks it", () => {
    for (const field of ["submitted", "advanced", "repaired", "cleared"] as const) {
      expect(computeAdvanceLogLine({ ...quiet(), [field]: 1 })?.level, field).toBe("info");
    }
    expect(computeAdvanceLogLine({ ...quiet(), advanced: 2, unreachable: 1 })?.level).toBe("warn");
  });

  test("every counter is in the line with its own value, and nothing identifies a job (MUTATION: drop or transpose a counter)", () => {
    const log = computeAdvanceLogLine({
      examined: 11,
      submitted: 12,
      advanced: 13,
      waiting: 14,
      unreachable: 15,
      unknown_status: 16,
      repaired: 17,
      repair_attempted: 18,
      cleared: 19,
      copy_abandoned: 20,
      errors: ["row_failed", "tick_failed"],
      errorClass: "TypeError",
    });
    expect(log?.level).toBe("error");
    const line = log?.line ?? "";
    for (const part of [
      "examined=11",
      "submitted=12",
      "advanced=13",
      "waiting=14",
      "unreachable=15",
      "unknown_status=16",
      "repaired=17",
      "repair_attempted=18",
      "nonces_cleared=19",
      "copy_abandoned=20",
      "errors=row_failed,tick_failed",
      "class=TypeError",
    ]) {
      expect(line, part).toContain(part);
    }
    expect(line).not.toMatch(/job_[0-9a-f]{8}/);
  });
});

describe("the cancel sweep's line", () => {
  test("nothing to do and nothing wrong says nothing", () => {
    expect(cancellationsLogLine(quietCancel())).toBeNull();
  });

  test("work is info; a failed row, a cancel Tapis did not take, or a cancel stuck an hour is an error (MUTATION: drop one of the three)", () => {
    expect(cancellationsLogLine({ ...quietCancel(), examined: 3 })?.level).toBe("info");
    expect(
      cancellationsLogLine({ ...quietCancel(), examined: 1, errors: ["row_failed"] })?.level,
    ).toBe("error");
    expect(cancellationsLogLine({ ...quietCancel(), examined: 1, cancel_failed: 1 })?.level).toBe(
      "error",
    );
    // A stuck cancel is reported even on a tick that took no row.
    expect(cancellationsLogLine({ ...quietCancel(), cancel_pending_failed: 2 })?.level).toBe(
      "error",
    );
  });

  test("every counter is in the line with its own value", () => {
    const log = cancellationsLogLine({
      examined: 5,
      cancel_failed: 6,
      cancel_pending_failed: 7,
      errors: ["orphan_failed"],
      errorClass: "Error",
    });
    for (const part of [
      "examined=5",
      "cancel_failed=6",
      "cancel_pending_failed=7",
      "errors=orphan_failed",
      "class=Error",
    ]) {
      expect(log?.line, part).toContain(part);
    }
  });
});
