/**
 * What each queue can schedule (epic #2005 phase A5, #2010; ADR 0118, round 2 of the review of PR #2041).
 * The submit's memory is the memory the charge pays for, clamped to the queue's maximum, because a whole
 * node's nominal memory is more than Slurm will ever hand a job and Tapis refuses a request over the
 * queue's declared limit. Pure: no database, no Tapis.
 *
 * The figures are UNVERIFIED with the site (they come from the public user guide through the program's
 * Tapis execution system). They are pinned below as literals written out, and when a nemar-process
 * checkout is named in `NEMAR_PROCESS_DIR` they are compared with that file's `maxMemoryMB` for each
 * queue; without it that comparison SKIPS VISIBLY, except that `NEMAR_REQUIRE_PROCESS_QUEUES=1` (set by
 * the CI workflow, with the template in its sparse checkout) makes a missing checkout or file FAIL. THE LITERALS MUST MATCH
 * `deploy/tapis/systems/exec.json.tmpl` in nemarOrg/nemar-process (`batchLogicalQueues[].maxMemoryMB`).
 * MUTATION: drop the clamp and the cases below that name a 262,144 fail.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PARTITIONS, type PartitionName, submitMemoryMb } from "../../shared/contract/compute";
import { QUEUE_MAX_MEMORY_MB, submitMemoryForQueue } from "../src/services/compute-queues";

/** Written out, not read from the code under test; must match the nemar-process definition. */
const LITERALS: Record<PartitionName, number> = {
  shared: 249208,
  compute: 249208,
  debug: 249208,
  "large-shared": 2048000,
  preempt: 249208,
  gpu: 377308,
  "gpu-shared": 377308,
  "gpu-debug": 377308,
  "gpu-preempt": 377308,
};

describe("the queue maximums", () => {
  test("are the figures the Tapis execution system declares, for exactly the contract's partitions", () => {
    expect({ ...QUEUE_MAX_MEMORY_MB }).toEqual(LITERALS);
    expect(Object.keys(QUEUE_MAX_MEMORY_MB).sort()).toEqual(Object.keys(PARTITIONS).sort());
  });

  test("the table cannot be changed at run time", () => {
    expect(Object.isFrozen(QUEUE_MAX_MEMORY_MB)).toBe(true);
  });

  // A checkout is optional on a developer machine (the comparison skips VISIBLY) and REQUIRED in CI:
  // `NEMAR_REQUIRE_PROCESS_QUEUES=1` turns a missing directory or template into a failure, because the
  // workflow sets NEMAR_PROCESS_DIR and a checkout that quietly lacked the file disabled this check once.
  const DIR = process.env.NEMAR_PROCESS_DIR;
  const required = process.env.NEMAR_REQUIRE_PROCESS_QUEUES === "1";
  const template = DIR ? join(DIR, "deploy/tapis/systems/exec.json.tmpl") : null;
  test.skipIf(template === null && !required)(
    "NEMAR_PROCESS_DIR names a checkout that holds the execution-system template",
    () => {
      expect(
        template,
        "NEMAR_REQUIRE_PROCESS_QUEUES=1 needs NEMAR_PROCESS_DIR to name a nemar-process checkout",
      ).not.toBeNull();
      expect(existsSync(template ?? ""), `${template} is not there`).toBe(true);
    },
  );
  test.skipIf(!required && (template === null || !existsSync(template)))(
    "match the maxMemoryMB of every logical queue in the nemar-process execution-system template",
    () => {
      expect(template, "no template to compare with").not.toBeNull();
      const system = JSON.parse(readFileSync(template as string, "utf8")) as {
        batchLogicalQueues: Array<{ name: string; maxMemoryMB: number }>;
      };
      const declared = Object.fromEntries(
        system.batchLogicalQueues.map((q) => [q.name, q.maxMemoryMB]),
      );
      expect(declared).toEqual(LITERALS);
    },
  );
});

describe("submitMemoryForQueue", () => {
  test("a whole compute node, and a 128-core debug or preempt job with no memory, are clamped to the queue", () => {
    // The charge pays for 262,144 MB (the contract's own derivation, unchanged)...
    expect(submitMemoryMb("compute", {})).toBe(262144);
    expect(submitMemoryMb("debug", { cores: 128 })).toBe(262144);
    // ...and the queue schedules 249,208.
    expect(submitMemoryForQueue("compute", {})).toBe(249208);
    expect(submitMemoryForQueue("compute", { cores: 128, memory_mb: 1000 })).toBe(249208);
    expect(submitMemoryForQueue("debug", { cores: 128 })).toBe(249208);
    expect(submitMemoryForQueue("preempt", { cores: 128 })).toBe(249208);
    // 121 cores is 247,808 MB: under the maximum, so it is not clamped; 122 is 249,856, which is.
    expect(submitMemoryForQueue("debug", { cores: 121 })).toBe(247808);
    expect(submitMemoryForQueue("debug", { cores: 122 })).toBe(249208);
  });

  test("a job's own memory over its queue's maximum is sent the maximum, and one under it is sent as it is", () => {
    expect(submitMemoryForQueue("shared", { cores: 4, memory_mb: 300000 })).toBe(249208);
    expect(submitMemoryForQueue("shared", { cores: 4, memory_mb: 20000 })).toBe(20000);
    expect(submitMemoryForQueue("large-shared", { cores: 4, memory_mb: 1500000 })).toBe(1500000);
    expect(submitMemoryForQueue("large-shared", { cores: 4, memory_mb: 3000000 })).toBe(2048000);
  });

  test("the GPU partitions fit: a whole GPU node is 376,832 MB, under the 377,308 of the queue", () => {
    expect(submitMemoryForQueue("gpu", {})).toBe(376832);
    expect(submitMemoryForQueue("gpu-shared", { gpus: 3 })).toBe(282624);
    expect(submitMemoryForQueue("gpu-debug", { gpus: 4 })).toBe(376832);
    expect(submitMemoryForQueue("gpu-preempt", { gpus: 1 })).toBe(94208);
  });

  test("on every partition, for the largest shape its ceiling allows and for the derived share, the figure is within its queue", () => {
    for (const name of Object.keys(PARTITIONS) as PartitionName[]) {
      const ceiling = PARTITIONS[name].ceiling;
      const cores = ceiling?.maxCoresPerNode ?? 128;
      const gpus = ceiling?.maxGpusPerNode ?? (PARTITIONS[name].pool === "gpu" ? 4 : 0);
      for (const resources of [
        { cores, gpus },
        { cores: 1, gpus: Math.max(gpus, 1) },
        { cores, gpus, memory_mb: 5_000_000 },
      ]) {
        const asked = submitMemoryForQueue(name, resources);
        expect(asked, `${name} ${JSON.stringify(resources)}`).toBeLessThanOrEqual(LITERALS[name]);
        expect(asked).toBeGreaterThan(0);
      }
    }
  });

  test("it still refuses what submitMemoryMb refuses: nothing to ask for, and a partition that is not one", () => {
    expect(() => submitMemoryForQueue("shared", {})).toThrow(RangeError);
    expect(() => submitMemoryForQueue("toString" as never, { cores: 1 })).toThrow(RangeError);
  });
});
