/**
 * The retention sweep, legal holds and the anonymizing update (epic #2005 phase A7, #2012; ADR 0118, the
 * amendment of 2026-11-04; design section 9). Real migrations (0118 and 0130 included), the real ledger
 * with its triggers, and Miniflare's R2 reached through the Worker's own bindings.
 *
 * THE ONE BOUNDARY FAKE. Miniflare does not enforce a bucket lock, so a records bucket whose `delete`
 * refuses the keys the lock still covers is a thin wrapper around the real bucket (`lockedBucket`): it
 * throws, with whatever text, when asked to delete a locked key and otherwise does what the real bucket
 * does. Everything else, the listing included, is the real bucket. The refusal text of a real R2 lock was
 * not recorded, which is why the sweep counts ANY throw from `delete` as `locked`.
 *
 * What is pinned, each with a test of its own:
 *  - records and logs past retention are deleted and the index row reduced to anonymous counts; a LIVE job
 *    is never touched; a job hold and an account hold each keep a job's records; a released hold lets the
 *    next run delete (MUTATION: do not read the hold before deleting);
 *  - any refusal of a locked key is counted `locked` whatever its text, leaves the job whole, and is tried
 *    again the next day (MUTATION: count only a refusal whose text names a lock);
 *  - logs go early for an unflagged, unheld job, and a flagged job keeps them with its records;
 *  - a results object still present a day after the window is deleted and counted `late`, and a hold
 *    never keeps a result;
 *  - a deleted account's pools and ledger actors are anonymized through migration 0130's one exception
 *    and nothing else is: a total does not move, a live account's rows are refused, an open hold waits;
 *  - only exact production runs it, the audit row is one row of counts, and the log line has counts only.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { COMPUTE_ANONYMOUS_ACTOR_ID, anonymousPoolRef } from "../../shared/compute-state";
import { placeHold, releaseHold } from "../src/services/compute-legal-holds";
import {
  ACTORS_DUE_SQL,
  RETENTION_AUDIT_ACTION,
  RETENTION_JOBS_PER_STAGE,
  deletePrefix,
  retentionLogLine,
  runComputeRetentionSweep,
} from "../src/services/compute-retention";
import type { Bindings } from "../src/types/bindings";
import { type Engine, startEngines } from "./helpers/compute-engines";
import {
  type LifecycleFixture,
  type MadeJob,
  makeJob,
  startLifecycleFixture,
} from "./helpers/compute-lifecycle-fixture";
import { fundAccount, fundPlatform, seedUser } from "./helpers/compute-seed";
import { logged } from "./helpers/logs";

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

const sql = fx_sql();
function fx_sql() {
  return {
    one: <T>(q: string, ...p: unknown[]) => fx.harness.db.query(q).get(...(p as never[])) as T,
    all: <T>(q: string, ...p: unknown[]) => fx.harness.db.query(q).all(...(p as never[])) as T[],
    run: (q: string, ...p: unknown[]) => fx.harness.db.run(q, p as never[]),
  };
}

/** The records bucket with `locked` keys that refuse to be deleted (a lock Miniflare does not enforce). */
function lockedBucket(real: R2Bucket, locked: (key: string) => boolean, text: string): R2Bucket {
  return new Proxy(real, {
    get(target, prop) {
      if (prop === "delete") {
        return async (keys: string | string[]) => {
          const list = Array.isArray(keys) ? keys : [keys];
          if (list.some(locked)) throw new Error(text);
          return target.delete(keys as never);
        };
      }
      const value = (target as unknown as Record<string | symbol, unknown>)[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const env = (over: Partial<Bindings> = {}): Bindings => fx.env(over);
const ownerId = () => fx.ownerId;

interface OldJob extends MadeJob {
  id: string;
}

/**
 * A job made through `createJob` (its records written), then moved to the end of its life: terminal, ended
 * `endedDaysAgo` days ago, with `retention_until` `retentionDaysFromNow` days away (negative: past).
 */
async function oldJob(
  over: {
    endedDaysAgo?: number;
    retentionDaysFromNow?: number;
    state?: string;
    flags?: Partial<Record<"mismatch" | "unreserved" | "overrun", number>>;
    resultsObject?: boolean;
  } = {},
): Promise<OldJob> {
  const made = await makeJob(fx);
  const id = made.job.id;
  const state = over.state ?? "finished";
  sql.run(
    `UPDATE compute_jobs SET state = ?, ended_at = datetime('now', ?), retention_until = datetime('now', ?),
            settled_provisional_at = datetime('now'),
            flag_mismatch = ?, flag_unreserved = ?, flag_overrun = ?,
            failure_code = CASE WHEN ? = 'failed' THEN 'tapis_error' ELSE NULL END
      WHERE id = ?`,
    state,
    `-${over.endedDaysAgo ?? 3000} days`,
    `${over.retentionDaysFromNow ?? -1} days`,
    over.flags?.mismatch ?? 0,
    over.flags?.unreserved ?? 0,
    over.flags?.overrun ?? 0,
    state,
    id,
  );
  await fx.harness.records.put(`logs/${id}/launcher.log`, "log");
  await fx.harness.records.put(`logs/${id}/tapisjob.out`, "out");
  if (over.resultsObject !== false) {
    await fx.harness.results.put(`jobs/${id}/outputs/a.txt`, "result");
    await fx.harness.results.put(`jobs/${id}/launcher/result.json`, "{}");
  }
  return { ...made, id };
}

const keysUnder = async (bucket: R2Bucket, prefix: string) =>
  (await bucket.list({ prefix })).objects.map((o) => o.key).sort();
const jobRow = (id: string) =>
  sql.one<Record<string, unknown>>("SELECT * FROM compute_jobs WHERE id = ?", id);

describe("records and logs past retention", () => {
  test("are deleted, and the index row is reduced to anonymous counts that keep the figures", async () => {
    const job = await oldJob();
    expect(await keysUnder(fx.harness.records, `records/${job.id}/`)).not.toEqual([]);
    const before = jobRow(job.id);
    expect(before.account_id).toBe(job.accountId);
    expect(before.gateway_user).not.toBeNull();

    const result = await runComputeRetentionSweep(env());
    expect(result).toMatchObject({ recordsDeleted: 1, locked: 0 });
    expect(await keysUnder(fx.harness.records, `records/${job.id}/`)).toEqual([]);
    expect(await keysUnder(fx.harness.records, `logs/${job.id}/`)).toEqual([]);

    const after = jobRow(job.id);
    expect([
      after.account_id,
      after.tapis_owner,
      after.gateway_user,
      after.idempotency_key,
    ]).toEqual([null, null, null, null]);
    expect(after.records_deleted_at).not.toBeNull();
    // The counts a report needs are still there.
    for (const column of [
      "state",
      "partition",
      "pool",
      "source",
      "charged_milli",
      "held_milli",
      "created_at",
      "ended_at",
      "spec_digest",
    ]) {
      expect([column, after[column]]).toEqual([column, before[column]]);
    }
    // Run again: nothing more to delete.
    expect(await runComputeRetentionSweep(env())).toMatchObject({ recordsDeleted: 0 });
  });

  test("a job still inside its retention is untouched", async () => {
    const job = await oldJob({ retentionDaysFromNow: 30, endedDaysAgo: 10 });
    const result = await runComputeRetentionSweep(env());
    expect(result?.recordsDeleted).toBe(0);
    expect(await keysUnder(fx.harness.records, `records/${job.id}/`)).not.toEqual([]);
    expect(jobRow(job.id).account_id).toBe(job.accountId);
  });

  test("a LIVE job is never touched, whatever its dates say (MUTATION: list every state)", async () => {
    const live = await oldJob({ state: "running" });
    sql.run("UPDATE compute_jobs SET ended_at = NULL WHERE id = ?", live.id);
    for (const state of ["created", "submitted", "queued", "archiving", "unreported"]) {
      const other = await oldJob({ state });
      sql.run("UPDATE compute_jobs SET ended_at = NULL WHERE id = ?", other.id);
    }
    const result = await runComputeRetentionSweep(env());
    expect(result).toMatchObject({ recordsDeleted: 0, logsDeleted: 0 });
    expect(
      sql.one<{ n: number }>(
        "SELECT COUNT(*) AS n FROM compute_jobs WHERE records_deleted_at IS NOT NULL",
      ).n,
    ).toBe(0);
    expect((await keysUnder(fx.harness.records, "records/")).length).toBeGreaterThan(0);
  });

  test("a job that failed or was cancelled is a terminal job too", async () => {
    const failed = await oldJob({ state: "failed" });
    const cancelled = await oldJob({ state: "cancelled" });
    const result = await runComputeRetentionSweep(env());
    expect(result?.recordsDeleted).toBe(2);
    expect(jobRow(failed.id).records_deleted_at).not.toBeNull();
    expect(jobRow(cancelled.id).records_deleted_at).not.toBeNull();
  });
});

describe("legal holds", () => {
  test("a job hold keeps that job's records and no other's; releasing it lets the next run delete (MUTATION: do not read the hold)", async () => {
    const held = await oldJob();
    const free = await oldJob();
    const placed = await placeHold(env().DB, {
      scope: "job",
      ref: held.id,
      reason: "legal_request",
      ownerId: ownerId(),
    });
    expect(placed.ok).toBe(true);
    const first = await runComputeRetentionSweep(env());
    expect(first?.recordsDeleted).toBe(1);
    expect(await keysUnder(fx.harness.records, `records/${held.id}/`)).not.toEqual([]);
    expect(await keysUnder(fx.harness.records, `records/${free.id}/`)).toEqual([]);
    expect(jobRow(held.id).account_id).toBe(held.accountId);
    // The candidate list leaves a held job out altogether: it is not even taken (not stamped).
    expect(jobRow(held.id).retention_attempted_at).toBeNull();

    if (!placed.ok) throw new Error("no hold");
    expect((await releaseHold(env().DB, { id: placed.hold.id, ownerId: ownerId() })).ok).toBe(true);
    const second = await runComputeRetentionSweep(env());
    expect(second?.recordsDeleted).toBe(1);
    expect(await keysUnder(fx.harness.records, `records/${held.id}/`)).toEqual([]);
  });

  test("an account hold keeps every job of that account, and nobody else's", async () => {
    const a1 = await oldJob();
    const a2 = await oldJob();
    const other = await oldJob();
    sql.run("UPDATE compute_jobs SET account_id = ? WHERE id = ?", a1.accountId, a2.id);
    const placed = await placeHold(env().DB, {
      scope: "account",
      ref: String(a1.accountId),
      reason: "legal_request",
      ownerId: ownerId(),
    });
    expect(placed.ok).toBe(true);
    const result = await runComputeRetentionSweep(env());
    expect(result?.recordsDeleted).toBe(1);
    for (const j of [a1, a2]) {
      expect(await keysUnder(fx.harness.records, `records/${j.id}/`)).not.toEqual([]);
    }
    expect(await keysUnder(fx.harness.records, `records/${other.id}/`)).toEqual([]);
  });

  test("a hold placed after the candidate list was read still stops the delete: the sweep reads the hold again before it deletes (MUTATION: drop the second read)", async () => {
    const job = await oldJob();
    const real = env().DB;
    // A hold appears right after the sweep reads its list of due jobs and before it works on the first.
    const racing = new Proxy(real, {
      get(target, prop) {
        if (prop !== "prepare") {
          const value = (target as unknown as Record<string | symbol, unknown>)[prop];
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (query: string) => {
          const statement = target.prepare(query) as unknown as {
            bind(...a: unknown[]): unknown;
            all(): Promise<unknown>;
          };
          if (!query.includes("ORDER BY j.retention_attempted_at ASC, j.retention_until ASC")) {
            return statement;
          }
          const wrapped: Record<string, unknown> = {
            bind: (...a: unknown[]) => {
              statement.bind(...a);
              return wrapped;
            },
            all: async () => {
              const result = await statement.all();
              await placeHold(real, {
                scope: "job",
                ref: job.id,
                reason: "legal_request",
                ownerId: ownerId(),
              });
              return result;
            },
          };
          return wrapped;
        };
      },
    });
    const result = await runComputeRetentionSweep(env({ DB: racing }));
    expect(result?.recordsDeleted).toBe(0);
    expect(await keysUnder(fx.harness.records, `records/${job.id}/`)).not.toEqual([]);
    expect(jobRow(job.id).account_id).toBe(job.accountId);
  });

  test("a hold placed between the records and the logs still keeps the logs: the hold is read again between the two prefixes (MUTATION: drop the second read)", async () => {
    const job = await oldJob();
    const real = fx.harness.records;
    // The hold appears once the records prefix is deleted and before the logs prefix is touched.
    const racing = new Proxy(real, {
      get(target, prop) {
        if (prop === "delete") {
          return async (keys: string | string[]) => {
            const done = await target.delete(keys as never);
            if ((Array.isArray(keys) ? keys : [keys]).some((k) => k.startsWith("records/"))) {
              await placeHold(env().DB, {
                scope: "job",
                ref: job.id,
                reason: "legal_request",
                ownerId: ownerId(),
              });
            }
            return done;
          };
        }
        const value = (target as unknown as Record<string | symbol, unknown>)[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const result = await runComputeRetentionSweep(env({ COMPUTE_RECORDS: racing }));
    expect(result?.recordsDeleted).toBe(0);
    expect(await keysUnder(fx.harness.records, `logs/${job.id}/`)).not.toEqual([]);
    expect(jobRow(job.id).records_deleted_at).toBeNull();
  });

  test("a hold placed after the delete began still stops the reduction of the row (MUTATION: drop the hold term of the reducing statement)", async () => {
    const job = await oldJob();
    const real = fx.harness.records;
    // The hold appears once the logs are deleted, which is after the sweep's last read of the hold and
    // before it reduces the row: the reducing statement itself must refuse.
    const racing = new Proxy(real, {
      get(target, prop) {
        if (prop === "delete") {
          return async (keys: string | string[]) => {
            const done = await target.delete(keys as never);
            if ((Array.isArray(keys) ? keys : [keys]).some((k) => k.startsWith("logs/"))) {
              await placeHold(env().DB, {
                scope: "job",
                ref: job.id,
                reason: "legal_request",
                ownerId: ownerId(),
              });
            }
            return done;
          };
        }
        const value = (target as unknown as Record<string | symbol, unknown>)[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const result = await runComputeRetentionSweep(env({ COMPUTE_RECORDS: racing }));
    expect(result?.recordsDeleted).toBe(0);
    expect(jobRow(job.id).account_id).toBe(job.accountId);
    expect(jobRow(job.id).records_deleted_at).toBeNull();
  });

  test("a suspended or deleted owner is `not_owner`, not `target_not_found` (MUTATION: classify by role alone)", async () => {
    const job = await oldJob();
    const suspended = await seedUser(env().DB, { role: "owner", status: "revoked" });
    const deleted = await seedUser(env().DB, { role: "owner", deleted_at: "2026-01-01 00:00:00" });
    for (const ownerId of [suspended, deleted]) {
      expect(
        await placeHold(env().DB, { scope: "job", ref: job.id, reason: "legal_request", ownerId }),
      ).toEqual({ ok: false, code: "not_owner" });
      expect(await releaseHold(env().DB, { id: 1, ownerId })).toEqual({
        ok: false,
        code: "not_owner",
      });
    }
    // A live owner naming a target that is not there is still target_not_found.
    expect(
      await placeHold(env().DB, {
        scope: "job",
        ref: "job_ffffffffffffffffffffffff",
        reason: "legal_request",
        ownerId: ownerId(),
      }),
    ).toEqual({ ok: false, code: "target_not_found" });
  });

  test("a hold is placed and released by the owner only, with an audit row each, and a second hold on the same target is a conflict", async () => {
    const job = await oldJob();
    const admin = await seedUser(env().DB, { role: "admin" });
    expect(
      await placeHold(env().DB, {
        scope: "job",
        ref: job.id,
        reason: "legal_request",
        ownerId: admin,
      }),
    ).toEqual({ ok: false, code: "not_owner" });
    const nothing = await placeHold(env().DB, {
      scope: "job",
      ref: "job_ffffffffffffffffffffffff",
      reason: "legal_request",
      ownerId: ownerId(),
    });
    expect(nothing).toEqual({ ok: false, code: "target_not_found" });
    const placed = await placeHold(env().DB, {
      scope: "job",
      ref: job.id,
      reason: "legal_request",
      ownerId: ownerId(),
    });
    expect(placed.ok).toBe(true);
    expect(
      await placeHold(env().DB, {
        scope: "job",
        ref: job.id,
        reason: "other_reason",
        ownerId: ownerId(),
      }),
    ).toEqual({
      ok: false,
      code: "hold_exists",
    });
    if (!placed.ok) throw new Error("no hold");
    expect(await releaseHold(env().DB, { id: placed.hold.id, ownerId: admin })).toEqual({
      ok: false,
      code: "not_owner",
    });
    expect((await releaseHold(env().DB, { id: placed.hold.id, ownerId: ownerId() })).ok).toBe(true);
    expect(await releaseHold(env().DB, { id: placed.hold.id, ownerId: ownerId() })).toEqual({
      ok: false,
      code: "hold_not_found",
    });
    const audit = sql.all<{ action: string; user_id: number }>(
      "SELECT action, user_id FROM audit_log WHERE action LIKE 'compute.hold.%' ORDER BY id",
    );
    expect(audit).toEqual([
      { action: "compute.hold.place", user_id: ownerId() },
      { action: "compute.hold.release", user_id: ownerId() },
    ]);
  });
});

describe("a bucket lock", () => {
  test("any refusal of a key is counted `locked` whatever its text, leaves the job whole, and the next day asks again (MUTATION: count only a refusal that names a lock)", async () => {
    const job = await oldJob();
    for (const text of ["ObjectLockedByBucketPolicy", "some other words", ""]) {
      const bound = env({
        COMPUTE_RECORDS: lockedBucket(fx.harness.records, (k) => k.startsWith("records/"), text),
      });
      const result = await runComputeRetentionSweep(bound);
      expect([text, result?.locked, result?.recordsDeleted]).toEqual([text, 1, 0]);
      expect(await keysUnder(fx.harness.records, `records/${job.id}/`)).not.toEqual([]);
      expect(jobRow(job.id).account_id).toBe(job.accountId);
      expect(jobRow(job.id).retention_attempted_at).not.toBeNull();
    }
    // The lock lapses; the next day deletes.
    const tomorrow = await runComputeRetentionSweep(env());
    expect(tomorrow).toMatchObject({ recordsDeleted: 1, locked: 0 });
    expect(await keysUnder(fx.harness.records, `records/${job.id}/`)).toEqual([]);
  });

  test("logs still under their lock are retried while the records go: a locked log keeps its job whole", async () => {
    const job = await oldJob();
    const bound = env({
      COMPUTE_RECORDS: lockedBucket(fx.harness.records, (k) => k.startsWith("logs/"), "locked"),
    });
    const result = await runComputeRetentionSweep(bound);
    expect(result?.locked).toBeGreaterThanOrEqual(1);
    // The records were deleted before the logs refused; the row is not reduced until nothing refuses.
    expect(await keysUnder(fx.harness.records, `records/${job.id}/`)).toEqual([]);
    expect(jobRow(job.id).records_deleted_at).toBeNull();
    expect(jobRow(job.id).account_id).toBe(job.accountId);
    expect((await runComputeRetentionSweep(env()))?.recordsDeleted).toBe(1);
  });

  test("jobs the bucket refused go behind the others: twenty-one locked jobs do not hold a slot for good (MUTATION: do not stamp a job that was taken)", async () => {
    const stuck: OldJob[] = [];
    for (let i = 0; i < RETENTION_JOBS_PER_STAGE + 1; i++) {
      const j = await oldJob({ endedDaysAgo: 100 });
      sql.run(
        "UPDATE compute_jobs SET retention_until = datetime('now', ?) WHERE id = ?",
        `-${10 + i} days`,
        j.id,
      );
      stuck.push(j);
    }
    const fine = await oldJob({ endedDaysAgo: 100 });
    const ids = new Set(stuck.map((j) => j.id));
    const bound = env({
      COMPUTE_RECORDS: lockedBucket(
        fx.harness.records,
        (k) => [...ids].some((id) => k.includes(id)),
        "locked",
      ),
    });
    const first = await runComputeRetentionSweep(bound);
    expect(first).toMatchObject({ locked: RETENTION_JOBS_PER_STAGE, recordsDeleted: 0 });
    expect(await keysUnder(fx.harness.records, `records/${fine.id}/`)).not.toEqual([]);
    // The next day the lock still holds on those, and the job that was never reached is deleted.
    const second = await runComputeRetentionSweep(bound);
    expect(second?.recordsDeleted).toBe(1);
    expect(await keysUnder(fx.harness.records, `records/${fine.id}/`)).toEqual([]);
  }, 60_000);

  test("a prefix bigger than the page bound is left whole: the row is not reduced and the job is `incomplete`, until a run finishes it (MUTATION: report a cut-off prefix as complete)", async () => {
    const job = await oldJob();
    for (let i = 0; i < 25; i++)
      await fx.harness.records.put(`records/${job.id}/extra/${i}.bin`, "x");
    // A bucket whose list returns one object a page: 25 objects take more than the 20 pages of a run.
    const paged = new Proxy(fx.harness.records, {
      get(target, prop) {
        if (prop === "list") {
          return (options: Record<string, unknown> = {}) =>
            target.list({ ...options, limit: 1 } as never);
        }
        const value = (target as unknown as Record<string | symbol, unknown>)[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const first = await runComputeRetentionSweep(env({ COMPUTE_RECORDS: paged }));
    expect(first).toMatchObject({ incomplete: 1, recordsDeleted: 0, locked: 0 });
    expect(jobRow(job.id).account_id).toBe(job.accountId);
    expect(jobRow(job.id).records_deleted_at).toBeNull();
    expect((await keysUnder(fx.harness.records, `records/${job.id}/`)).length).toBeGreaterThan(0);
    // The next run finishes it.
    const second = await runComputeRetentionSweep(env({ COMPUTE_RECORDS: paged }));
    expect(second).toMatchObject({ recordsDeleted: 1, incomplete: 0 });
    expect(await keysUnder(fx.harness.records, `records/${job.id}/`)).toEqual([]);
  });

  test("deletePrefix says a cut-off prefix is not complete, and a result is not marked reconciled", async () => {
    for (let i = 0; i < 5; i++) await fx.harness.records.put(`p/${i}`, "x");
    expect(await deletePrefix(fx.harness.records, "p/", { maxPages: 2, pageSize: 2 })).toEqual({
      deleted: 4,
      locked: false,
      complete: false,
    });
    expect(await deletePrefix(fx.harness.records, "p/", { maxPages: 2, pageSize: 2 })).toEqual({
      deleted: 1,
      locked: false,
      complete: true,
    });
    const late = await oldJob({ endedDaysAgo: 32, retentionDaysFromNow: 2000 });
    for (let i = 0; i < 25; i++)
      await fx.harness.results.put(`jobs/${late.id}/outputs/${i}.bin`, "x");
    const pagedResults = new Proxy(fx.harness.results, {
      get(target, prop) {
        if (prop === "list")
          return (options: Record<string, unknown> = {}) =>
            target.list({ ...options, limit: 1 } as never);
        const value = (target as unknown as Record<string | symbol, unknown>)[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await runComputeRetentionSweep(env({ COMPUTE_RESULTS: pagedResults }));
    expect(jobRow(late.id).results_reconciled_at).toBeNull();
    await runComputeRetentionSweep(env({ COMPUTE_RESULTS: pagedResults }));
    expect(jobRow(late.id).results_reconciled_at).not.toBeNull();
  });

  test("a programming error from delete is a failed stage, not a lock (MUTATION: catch everything as a lock)", async () => {
    const job = await oldJob();
    const broken = new Proxy(fx.harness.records, {
      get(target, prop) {
        if (prop === "delete") {
          return async () => {
            throw new TypeError("keys.map is not a function");
          };
        }
        const value = (target as unknown as Record<string | symbol, unknown>)[prop];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const result = await runComputeRetentionSweep(env({ COMPUTE_RECORDS: broken }));
    expect(result?.locked).toBe(0);
    expect(result?.errors).toContain("records_failed");
    expect(result?.errorClass).toBe("TypeError");
    expect(JSON.stringify(result)).not.toContain("keys.map");
    expect(jobRow(job.id).account_id).toBe(job.accountId);
  });

  test("the class of the first refusal is kept, and a job more than a day past retention that is still refused logs at error level", async () => {
    const overdue = await oldJob({ endedDaysAgo: 100, retentionDaysFromNow: -3 });
    const bound = env({
      COMPUTE_RECORDS: lockedBucket(fx.harness.records, (k) => k.includes(overdue.id), "locked"),
    });
    const result = await runComputeRetentionSweep(bound);
    expect(result).toMatchObject({ locked: 1, overdueLocked: 1, lockClass: "Error" });
    const log = result ? retentionLogLine(result) : null;
    expect(log?.level).toBe("error");
    expect(log?.line).toContain("overdue_locked=1");
    expect(log?.line).toContain("lock_class=Error");
    expect(log?.line).not.toContain("locked,");
  });

  test("a refusal inside its first day past retention is a lock that is expected to lapse: info, not an alarm", async () => {
    const fresh = await oldJob({ endedDaysAgo: 100, retentionDaysFromNow: -0.5 });
    const bound = env({
      COMPUTE_RECORDS: lockedBucket(fx.harness.records, (k) => k.includes(fresh.id), "locked"),
    });
    const result = await runComputeRetentionSweep(bound);
    expect(result).toMatchObject({ locked: 1, overdueLocked: 0 });
    expect(result && retentionLogLine(result)?.level).toBe("info");
  });

  test("deletePrefix reports the refusal and the count, and deletes nothing it was not asked to", async () => {
    await fx.harness.records.put("p/one", "1");
    await fx.harness.records.put("p/two", "2");
    await fx.harness.records.put("q/three", "3");
    const refused = await deletePrefix(
      lockedBucket(fx.harness.records, (k) => k === "p/two", "locked"),
      "p/",
    );
    expect(refused).toEqual({ deleted: 0, locked: true, complete: false, lockClass: "Error" });
    expect(await deletePrefix(fx.harness.records, "p/")).toEqual({
      deleted: 2,
      locked: false,
      complete: true,
    });
    expect(await keysUnder(fx.harness.records, "q/")).toEqual(["q/three"]);
  });
});

describe("a backlog", () => {
  test("a run that hits the cap counts the due rows it left, and logs at error level while any is left (MUTATION: do not count)", async () => {
    for (let i = 0; i < RETENTION_JOBS_PER_STAGE + 3; i++) await oldJob({ endedDaysAgo: 100 });
    const first = await runComputeRetentionSweep(env());
    expect(first?.recordsDeleted).toBe(RETENTION_JOBS_PER_STAGE);
    expect(first?.backlog.records).toBe(3);
    const log = first ? retentionLogLine(first) : null;
    expect(log?.level).toBe("error");
    expect(log?.line).toContain("backlog_records=3");
    // The next run takes the three, and has no backlog.
    const second = await runComputeRetentionSweep(env());
    expect(second).toMatchObject({ recordsDeleted: 3, backlog: { records: 0 } });
    expect(second && retentionLogLine(second)?.level).toBe("info");
  }, 60_000);

  test("a run under the cap has none", async () => {
    await oldJob({ endedDaysAgo: 100 });
    const result = await runComputeRetentionSweep(env());
    expect(result?.backlog).toEqual({ records: 0, logs: 0, results: 0 });
  });
});

describe("logs early, results late", () => {
  test("an unflagged, unheld job loses its logs after logsDays and keeps its records; a flagged job keeps its logs", async () => {
    const plain = await oldJob({ endedDaysAgo: 400, retentionDaysFromNow: 2000 });
    const flagged = await oldJob({
      endedDaysAgo: 400,
      retentionDaysFromNow: 2000,
      flags: { mismatch: 1 },
    });
    const held = await oldJob({ endedDaysAgo: 400, retentionDaysFromNow: 2000 });
    await placeHold(env().DB, {
      scope: "job",
      ref: held.id,
      reason: "legal_request",
      ownerId: ownerId(),
    });
    const young = await oldJob({ endedDaysAgo: 100, retentionDaysFromNow: 2000 });
    const result = await runComputeRetentionSweep(env());
    expect(result).toMatchObject({ logsDeleted: 1, recordsDeleted: 0 });
    expect(await keysUnder(fx.harness.records, `logs/${plain.id}/`)).toEqual([]);
    expect(await keysUnder(fx.harness.records, `records/${plain.id}/`)).not.toEqual([]);
    for (const j of [flagged, held, young]) {
      expect(await keysUnder(fx.harness.records, `logs/${j.id}/`)).not.toEqual([]);
    }
    expect(jobRow(plain.id).logs_deleted_at).not.toBeNull();
    expect(jobRow(plain.id).account_id).toBe(plain.accountId);
  });

  test("a results object still there a day after the window is deleted and counted late; a hold never keeps a result", async () => {
    const late = await oldJob({ endedDaysAgo: 32, retentionDaysFromNow: 2000 });
    const withinWindow = await oldJob({ endedDaysAgo: 29, retentionDaysFromNow: 2000 });
    const held = await oldJob({ endedDaysAgo: 40, retentionDaysFromNow: 2000 });
    await placeHold(env().DB, {
      scope: "job",
      ref: held.id,
      reason: "legal_request",
      ownerId: ownerId(),
    });
    const gone = await oldJob({
      endedDaysAgo: 50,
      retentionDaysFromNow: 2000,
      resultsObject: false,
    });
    const result = await runComputeRetentionSweep(env());
    expect(result?.late).toBe(2);
    expect(await keysUnder(fx.harness.results, `jobs/${late.id}/`)).toEqual([]);
    expect(await keysUnder(fx.harness.results, `jobs/${held.id}/`)).toEqual([]);
    expect(await keysUnder(fx.harness.results, `jobs/${withinWindow.id}/`)).not.toEqual([]);
    // The lifecycle rule had taken one already: reconciled, not late.
    expect(jobRow(gone.id).results_reconciled_at).not.toBeNull();
    // And once reconciled it is not listed again.
    expect((await runComputeRetentionSweep(env()))?.late).toBe(0);
  });
});

describe("a deleted account", () => {
  test("its pool's holder is anonymized and no total moves; a live account's pool is not touched", async () => {
    const gone = await seedUser(env().DB, { deleted_at: "2026-01-01 00:00:00" });
    const live = await seedUser(env().DB);
    const gonePool = await fundAccount(env().DB, gone, 5000);
    const livePool = await fundAccount(env().DB, live, 5000);
    const totals = () =>
      sql.all<{
        id: number;
        granted_milli: number;
        held_milli: number;
        charged_milli: number;
        frozen: number;
      }>(
        "SELECT id, granted_milli, held_milli, charged_milli, frozen FROM compute_pools ORDER BY id",
      );
    const before = totals();
    const result = await runComputeRetentionSweep(env());
    expect(result?.poolsAnonymised).toBe(1);
    expect(totals()).toEqual(before);
    expect(
      sql.one<{ holder_ref: string }>("SELECT holder_ref FROM compute_pools WHERE id = ?", gonePool)
        .holder_ref,
    ).toBe(anonymousPoolRef(gonePool));
    expect(
      sql.one<{ holder_ref: string }>("SELECT holder_ref FROM compute_pools WHERE id = ?", livePool)
        .holder_ref,
    ).toBe(String(live));
    // The pools' totals are still the sums of the ledger's deltas.
    const sums = sql.all<{ stored: number; summed: number }>(
      `SELECT p.granted_milli AS stored, COALESCE((SELECT SUM(l.granted_delta_milli) FROM compute_ledger l WHERE l.pool_id = p.id), 0) AS summed
         FROM compute_pools p`,
    );
    for (const s of sums) expect(s.stored).toBe(s.summed);
    // And it happens once.
    expect((await runComputeRetentionSweep(env()))?.poolsAnonymised).toBe(0);
  });

  test("a pool waits while the account still has a job, an open hold, or a legal hold", async () => {
    const gone = await seedUser(env().DB, { deleted_at: "2026-01-01 00:00:00" });
    const poolId = await fundAccount(env().DB, gone, 5000);
    // A job that carries the number.
    sql.run(
      `INSERT INTO compute_jobs (id, account_id, source, kind, app_id, app_version, spec_digest, partition, pool, nodes, cores_per_node, minutes)
       VALUES ('job_0000000000000000000000aa', ?, 'cli', 'batch', 'a', '1', ?, 'shared', 'cpu', 1, 1, 1)`,
      gone,
      "a".repeat(64),
    );
    expect((await runComputeRetentionSweep(env()))?.poolsAnonymised).toBe(0);
    sql.run("UPDATE compute_jobs SET account_id = NULL WHERE id = 'job_0000000000000000000000aa'");
    // A legal hold on the account.
    const placed = await placeHold(env().DB, {
      scope: "account",
      ref: String(gone),
      reason: "legal_request",
      ownerId: ownerId(),
    });
    if (!placed.ok) throw new Error("no hold");
    expect((await runComputeRetentionSweep(env()))?.poolsAnonymised).toBe(0);
    await releaseHold(env().DB, { id: placed.hold.id, ownerId: ownerId() });
    // An open hold on the pool.
    sql.run("UPDATE compute_pools SET held_milli = 0 WHERE id = ?", poolId);
    expect((await runComputeRetentionSweep(env()))?.poolsAnonymised).toBe(1);
  });

  test("the entries a deleted account acted on carry the anonymous actor, and nothing else about them changed", async () => {
    const gone = await seedUser(env().DB, { deleted_at: "2026-01-01 00:00:00" });
    const live = await seedUser(env().DB);
    const pool = await fundAccount(env().DB, live, 1000);
    // Two grants made by the account that is now gone and one by a live account.
    for (const [actor, key] of [
      [gone, "by-gone-1"],
      [gone, "by-gone-2"],
      [live, "by-live-1"],
    ] as const) {
      sql.run(
        "INSERT INTO compute_ledger (kind, pool_id, granted_delta_milli, actor_user_id, reason, idempotency_key) VALUES ('grant', ?, 7, ?, 'admin_grant', ?)",
        pool,
        actor,
        key,
      );
    }
    const snapshot = () =>
      sql.all<Record<string, unknown>>(
        "SELECT id, kind, pool_id, granted_delta_milli, held_delta_milli, charged_delta_milli, reason, idempotency_key, created_at FROM compute_ledger ORDER BY id",
      );
    const before = snapshot();
    const result = await runComputeRetentionSweep(env());
    expect(result?.entriesAnonymised).toBe(2);
    expect(snapshot()).toEqual(before);
    const actors = sql.all<{ idempotency_key: string; actor_user_id: number }>(
      "SELECT idempotency_key, actor_user_id FROM compute_ledger WHERE idempotency_key LIKE 'by-%' ORDER BY idempotency_key",
    );
    expect(actors).toEqual([
      { idempotency_key: "by-gone-1", actor_user_id: COMPUTE_ANONYMOUS_ACTOR_ID },
      { idempotency_key: "by-gone-2", actor_user_id: COMPUTE_ANONYMOUS_ACTOR_ID },
      { idempotency_key: "by-live-1", actor_user_id: live },
    ]);
  });
});

describe("the window of deleted accounts' ledger actors", () => {
  test("an account whose only entry is a hold still open is not listed, so it cannot starve the rest (MUTATION: list every actor)", async () => {
    const stuck = await seedUser(env().DB, { deleted_at: "2026-01-01 00:00:00" });
    const ready = await seedUser(env().DB, { deleted_at: "2026-01-01 00:00:00" });
    const holder = await seedUser(env().DB);
    const pool = await fundAccount(env().DB, holder, 5000);
    await fundPlatform(env().DB, "people", 5000);
    const budget = sql.one<{ id: number }>(
      "SELECT id FROM compute_pools WHERE holder_kind = 'platform' AND holder_ref = 'people' AND pool = 'cpu'",
    ).id;
    // An open hold made by the account that is now gone, and a grant by the other.
    sql.run(
      "INSERT INTO compute_ledger (kind, pool_id, budget_pool_id, held_delta_milli, job_id, actor_user_id, idempotency_key) VALUES ('hold', ?, ?, 100, 'job_0000000000000000000000f1', ?, 'job:job_0000000000000000000000f1:hold')",
      pool,
      budget,
      stuck,
    );
    sql.run(
      "INSERT INTO compute_ledger (kind, pool_id, granted_delta_milli, actor_user_id, reason, idempotency_key) VALUES ('grant', ?, 7, ?, 'grant', 'by-ready')",
      pool,
      ready,
    );
    const listed = sql.all<{ id: number }>(ACTORS_DUE_SQL.replace("?1", "50")).map((u) => u.id);
    expect(listed).toEqual([ready]);
    // Once the hold is closed the account is listed too.
    sql.run(
      "INSERT INTO compute_ledger (kind, pool_id, budget_pool_id, held_delta_milli, job_id, hold_ref, idempotency_key) SELECT 'release', pool_id, budget_pool_id, -held_delta_milli, job_id, id, 'hold:' || id || ':release' FROM compute_ledger WHERE kind = 'hold' AND job_id = 'job_0000000000000000000000f1'",
    );
    expect(
      sql
        .all<{ id: number }>(ACTORS_DUE_SQL.replace("?1", "50"))
        .map((u) => u.id)
        .sort(),
    ).toEqual([stuck, ready].sort());
  });
});

describe("migration 0130, on both engines", () => {
  let engines: Engine[] = [];
  let dispose: () => Promise<void>;
  beforeAll(async () => {
    const started = await startEngines();
    engines = started.engines;
    dispose = started.dispose;
  }, 60_000);
  afterAll(async () => {
    await dispose?.();
  }, 30_000);

  let n = 0;
  async function user(e: Engine, deleted: boolean): Promise<number> {
    n += 1;
    const name = `anon-${Date.now()}-${n}-${Math.floor(Math.random() * 1e9)}`;
    const err = await e.run(
      `INSERT INTO users (username, email, password_hash, status, role, signup_source, email_verified, service_access, account_kind, deleted_at)
       VALUES (?, ?, 'x', 'approved', 'member', 'cli', 1, 0, 'person', ?)`,
      name,
      `${name}@example.org`,
      deleted ? "2026-01-01 00:00:00" : null,
    );
    if (err) throw new Error(err);
    return (await e.all<{ id: number }>("SELECT id FROM users WHERE username = ?", name))[0]
      ?.id as number;
  }
  async function pool(e: Engine, holder: number): Promise<number> {
    const err = await e.run(
      "INSERT INTO compute_pools (holder_kind, holder_ref, pool) VALUES ('account', ?, 'cpu')",
      String(holder),
    );
    if (err) throw new Error(err);
    return (
      await e.all<{ id: number }>(
        "SELECT id FROM compute_pools WHERE holder_ref = ?",
        String(holder),
      )
    )[0]?.id as number;
  }
  const each = (name: string, body: (e: Engine) => Promise<void>) =>
    test(name, async () => {
      expect(engines).toHaveLength(2);
      for (const e of engines) {
        try {
          await body(e);
        } catch (err) {
          throw new Error(`${e.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    });

  each("a deleted account's pool may take the anonymous holder, and only that", async (e) => {
    const gone = await user(e, true);
    const p = await pool(e, gone);
    expect(
      await e.run("UPDATE compute_pools SET holder_ref = ? WHERE id = ?", anonymousPoolRef(p), p),
    ).toBeNull();
    expect(
      (
        await e.all<{ holder_ref: string }>("SELECT holder_ref FROM compute_pools WHERE id = ?", p)
      )[0]?.holder_ref,
    ).toBe(anonymousPoolRef(p));
  });

  each(
    "every other change to a pool's identity is still refused: a live account, another token, a total, the word, the kind",
    async (e) => {
      const live = await user(e, false);
      const gone = await user(e, true);
      const lp = await pool(e, live);
      const gp = await pool(e, gone);
      const refused = /identity never changes/;
      expect(
        await e.run(
          "UPDATE compute_pools SET holder_ref = ? WHERE id = ?",
          anonymousPoolRef(lp),
          lp,
        ),
      ).toMatch(refused);
      expect(await e.run("UPDATE compute_pools SET holder_ref = '99999' WHERE id = ?", gp)).toMatch(
        refused,
      );
      expect(
        await e.run(
          "UPDATE compute_pools SET holder_ref = ?, granted_milli = 5 WHERE id = ?",
          anonymousPoolRef(gp),
          gp,
        ),
      ).toMatch(refused);
      expect(
        await e.run(
          "UPDATE compute_pools SET holder_ref = ?, frozen = 1 WHERE id = ?",
          anonymousPoolRef(gp),
          gp,
        ),
      ).toMatch(refused);
      expect(await e.run("UPDATE compute_pools SET pool = 'gpu' WHERE id = ?", gp)).toMatch(
        refused,
      );
      expect(
        await e.run(
          "UPDATE compute_pools SET holder_kind = 'partner', holder_ref = 'x' WHERE id = ?",
          gp,
        ),
      ).toMatch(refused);
      expect(await e.run("UPDATE compute_pools SET id = 999999 WHERE id = ?", gp)).toMatch(refused);
      expect(await e.run("DELETE FROM compute_pools WHERE id = ?", gp)).toMatch(/never deleted/);
    },
  );

  // Each column changed ALONE, in the same statement as the anonymizing change: every one is refused, so
  // a single term of the trigger cannot be dropped without one of these failing.
  each("changing any ONE column of a pool beside the holder reference is refused", async (e) => {
    const columns: Array<[string, string, unknown]> = [
      ["id", "id", 987_654_321],
      ["holder_kind", "holder_kind", "partner"],
      ["pool", "pool", "gpu"],
      ["granted_milli", "granted_milli", 1],
      ["held_milli", "held_milli", 1],
      ["charged_milli", "charged_milli", 1],
      ["frozen", "frozen", 1],
      ["created_at", "created_at", "2000-01-01 00:00:00"],
      ["updated_at", "updated_at", "2000-01-01 00:00:00"],
    ];
    for (const [name, column, value] of columns) {
      const gone = await user(e, true);
      const p = await pool(e, gone);
      const err = await e.run(
        `UPDATE compute_pools SET holder_ref = ?, ${column} = ? WHERE id = ?`,
        anonymousPoolRef(p),
        value,
        p,
      );
      expect([name, err]).toEqual([name, expect.stringMatching(/identity never changes/)]);
      const stored = (
        await e.all<{ holder_ref: string }>("SELECT holder_ref FROM compute_pools WHERE id = ?", p)
      )[0];
      expect([name, stored?.holder_ref]).toEqual([name, String(gone)]);
    }
  });

  each("changing any ONE column of a ledger entry beside the actor is refused", async (e) => {
    const holder = await user(e, false);
    const p = await pool(e, holder);
    const other = await pool(e, await user(e, false));
    const columns: Array<[string, unknown]> = [
      ["id", 987_654_321],
      ["kind", "expire"],
      ["pool_id", other],
      ["budget_pool_id", other],
      ["granted_delta_milli", 8],
      ["held_delta_milli", 1],
      ["charged_delta_milli", 1],
      ["job_id", "job_0000000000000000000000e1"],
      ["hold_ref", 1],
      ["reason", "other_reason"],
      ["idempotency_key", "renamed-key"],
      ["created_at", "2000-01-01 00:00:00"],
    ];
    for (const [column, value] of columns) {
      const gone = await user(e, true);
      const key = `col-${column}-${Date.now()}-${Math.random()}`;
      expect(
        await e.run(
          "INSERT INTO compute_ledger (kind, pool_id, granted_delta_milli, actor_user_id, reason, idempotency_key) VALUES ('grant', ?, 9, ?, 'grant', ?)",
          p,
          gone,
          key,
        ),
      ).toBeNull();
      const err = await e.run(
        `UPDATE compute_ledger SET actor_user_id = ?, ${column} = ? WHERE idempotency_key = ?`,
        COMPUTE_ANONYMOUS_ACTOR_ID,
        value,
        key,
      );
      expect([column, err]).toEqual([column, expect.stringMatching(/append-only/)]);
      const stored = (
        await e.all<{ actor_user_id: number }>(
          "SELECT actor_user_id FROM compute_ledger WHERE idempotency_key = ?",
          key,
        )
      )[0];
      expect([column, stored?.actor_user_id]).toEqual([column, gone]);
    }
  });

  each(
    "the entry of a hold that is still open keeps its actor, and the closed one gives it up",
    async (e) => {
      const gone = await user(e, true);
      const holder = await user(e, false);
      const p = await pool(e, holder);
      const budget = (
        await e.all<{ id: number }>(
          "SELECT id FROM compute_pools WHERE holder_kind = 'platform' AND holder_ref = 'people' AND pool = 'cpu'",
        )
      )[0]?.id as number;
      for (const target of [p, budget]) {
        expect(
          await e.run(
            "INSERT INTO compute_ledger (kind, pool_id, granted_delta_milli, reason, idempotency_key) VALUES ('grant', ?, 5000, 'grant', ?)",
            target,
            `og-${target}-${Math.random()}`,
          ),
        ).toBeNull();
      }
      const job = `job_${Math.floor(Math.random() * 1e12)
        .toString(16)
        .padStart(12, "0")}${Math.floor(Math.random() * 1e12)
        .toString(16)
        .padStart(12, "0")}`.slice(0, 28);
      expect(
        await e.run(
          "INSERT INTO compute_ledger (kind, pool_id, budget_pool_id, held_delta_milli, job_id, actor_user_id, idempotency_key) VALUES ('hold', ?, ?, 100, ?, ?, ?)",
          p,
          budget,
          job,
          gone,
          `job:${job}:hold`,
        ),
      ).toBeNull();
      const anonymise = () =>
        e.run(
          "UPDATE compute_ledger SET actor_user_id = ? WHERE idempotency_key = ?",
          COMPUTE_ANONYMOUS_ACTOR_ID,
          `job:${job}:hold`,
        );
      expect(await anonymise()).toMatch(/append-only/);
      expect(
        await e.run(
          "INSERT INTO compute_ledger (kind, pool_id, budget_pool_id, held_delta_milli, job_id, hold_ref, idempotency_key) SELECT 'release', pool_id, budget_pool_id, -held_delta_milli, job_id, id, 'hold:' || id || ':release' FROM compute_ledger WHERE idempotency_key = ?",
          `job:${job}:hold`,
        ),
      ).toBeNull();
      expect(await anonymise()).toBeNull();
    },
  );

  each("a pool with an open hold is refused", async (e) => {
    const gone = await user(e, true);
    const p = await pool(e, gone);
    // The ledger's own entries put SU in the pool and a hold on it.
    expect(
      await e.run(
        "INSERT INTO compute_ledger (kind, pool_id, granted_delta_milli, reason, idempotency_key) VALUES ('grant', ?, 5000, 'grant', ?)",
        p,
        `g-${p}-${Math.random()}`,
      ),
    ).toBeNull();
    const budget = (
      await e.all<{ id: number }>(
        "SELECT id FROM compute_pools WHERE holder_kind = 'platform' AND holder_ref = 'people' AND pool = 'cpu'",
      )
    )[0]?.id as number;
    expect(
      await e.run(
        "INSERT INTO compute_ledger (kind, pool_id, granted_delta_milli, reason, idempotency_key) VALUES ('grant', ?, 5000, 'grant', ?)",
        budget,
        `g-${budget}-${Math.random()}`,
      ),
    ).toBeNull();
    const jobId = `job_${(Date.now() % 1e12).toString(16).padStart(12, "0")}${Math.floor(
      Math.random() * 1e12,
    )
      .toString(16)
      .padStart(12, "0")}`.slice(0, 28);
    expect(
      await e.run(
        "INSERT INTO compute_ledger (kind, pool_id, budget_pool_id, held_delta_milli, job_id, idempotency_key) VALUES ('hold', ?, ?, 1000, ?, ?)",
        p,
        budget,
        jobId,
        `job:${jobId}:hold`,
      ),
    ).toBeNull();
    expect(
      await e.run("UPDATE compute_pools SET holder_ref = ? WHERE id = ?", anonymousPoolRef(p), p),
    ).toMatch(/identity never changes/);
  });

  each(
    "a ledger entry's actor may be anonymized for a deleted account, and nothing else about the entry",
    async (e) => {
      const gone = await user(e, true);
      const live = await user(e, false);
      const holder = await user(e, false);
      const p = await pool(e, holder);
      const key = (s: string) => `${s}-${Date.now()}-${Math.random()}`;
      const goneKey = key("a");
      const liveKey = key("b");
      expect(
        await e.run(
          "INSERT INTO compute_ledger (kind, pool_id, granted_delta_milli, actor_user_id, reason, idempotency_key) VALUES ('grant', ?, 9, ?, 'grant', ?)",
          p,
          gone,
          goneKey,
        ),
      ).toBeNull();
      expect(
        await e.run(
          "INSERT INTO compute_ledger (kind, pool_id, granted_delta_milli, actor_user_id, reason, idempotency_key) VALUES ('grant', ?, 9, ?, 'grant', ?)",
          p,
          live,
          liveKey,
        ),
      ).toBeNull();
      const append = /append-only/;
      expect(
        await e.run(
          "UPDATE compute_ledger SET actor_user_id = ? WHERE idempotency_key = ?",
          COMPUTE_ANONYMOUS_ACTOR_ID,
          liveKey,
        ),
      ).toMatch(append);
      expect(
        await e.run(
          "UPDATE compute_ledger SET actor_user_id = NULL WHERE idempotency_key = ?",
          goneKey,
        ),
      ).toMatch(append);
      expect(
        await e.run(
          "UPDATE compute_ledger SET actor_user_id = 12345 WHERE idempotency_key = ?",
          goneKey,
        ),
      ).toMatch(append);
      expect(
        await e.run(
          "UPDATE compute_ledger SET actor_user_id = ?, granted_delta_milli = 10 WHERE idempotency_key = ?",
          COMPUTE_ANONYMOUS_ACTOR_ID,
          goneKey,
        ),
      ).toMatch(append);
      expect(
        await e.run(
          "UPDATE compute_ledger SET actor_user_id = ?, reason = 'other' WHERE idempotency_key = ?",
          COMPUTE_ANONYMOUS_ACTOR_ID,
          goneKey,
        ),
      ).toMatch(append);
      expect(
        await e.run(
          "UPDATE compute_ledger SET actor_user_id = ?, idempotency_key = 'renamed' WHERE idempotency_key = ?",
          COMPUTE_ANONYMOUS_ACTOR_ID,
          goneKey,
        ),
      ).toMatch(append);
      expect(
        await e.run("UPDATE compute_ledger SET kind = 'expire' WHERE idempotency_key = ?", goneKey),
      ).toMatch(append);
      expect(await e.run("DELETE FROM compute_ledger WHERE idempotency_key = ?", goneKey)).toMatch(
        append,
      );
      expect(
        await e.run(
          "UPDATE compute_ledger SET actor_user_id = ? WHERE idempotency_key = ?",
          COMPUTE_ANONYMOUS_ACTOR_ID,
          goneKey,
        ),
      ).toBeNull();
      // Once anonymized it is not "a deleted account's" any more: a second change is refused.
      expect(
        await e.run(
          "UPDATE compute_ledger SET actor_user_id = ? WHERE idempotency_key = ?",
          gone,
          goneKey,
        ),
      ).toMatch(append);
      // The pool's total is still the sum of its deltas.
      const [totals] = await e.all<{ granted_milli: number }>(
        "SELECT granted_milli FROM compute_pools WHERE id = ?",
        p,
      );
      const [summed] = await e.all<{ s: number }>(
        "SELECT SUM(granted_delta_milli) AS s FROM compute_ledger WHERE pool_id = ?",
        p,
      );
      expect(totals?.granted_milli).toBe(summed?.s as number);
    },
  );
});

describe("the sweep itself", () => {
  test("runs only in exact production, and reads nothing elsewhere", async () => {
    await oldJob();
    expect(await runComputeRetentionSweep(env({ ENVIRONMENT: "development" }))).toBeNull();
    expect(await runComputeRetentionSweep(env({ ENVIRONMENT: "staging" }))).toBeNull();
    expect(await keysUnder(fx.harness.records, "records/")).not.toEqual([]);
  });

  test("it reads no compute switch: a record that is due goes with compute off", async () => {
    const job = await oldJob();
    const result = await runComputeRetentionSweep(env({ COMPUTE_ENABLED: undefined }));
    expect(result?.recordsDeleted).toBe(1);
    expect(jobRow(job.id).records_deleted_at).not.toBeNull();
  });

  test("it writes ONE audit row of counts, only when something happened, and the log line names no job, account or key", async () => {
    const job = await oldJob();
    await runComputeRetentionSweep(env());
    const audit = sql.all<{ details: string; resource_id: string | null; user_id: number | null }>(
      `SELECT details, resource_id, user_id FROM audit_log WHERE action = '${RETENTION_AUDIT_ACTION}'`,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.user_id).toBeNull();
    expect(JSON.parse(audit[0]?.details ?? "{}")).toMatchObject({ records_deleted: 1 });
    expect(audit[0]?.details).not.toContain(job.id);
    // A run that has nothing to do writes nothing.
    await runComputeRetentionSweep(env());
    expect(
      sql.one<{ n: number }>(
        `SELECT COUNT(*) AS n FROM audit_log WHERE action = '${RETENTION_AUDIT_ACTION}'`,
      ).n,
    ).toBe(1);

    const quiet = await runComputeRetentionSweep(env());
    expect(quiet && retentionLogLine(quiet)).toBeNull();
    const lines = await logged(async () => {
      await oldJob();
      const r = await runComputeRetentionSweep(env());
      const log = r ? retentionLogLine(r) : null;
      if (log) console.log(log.line);
    });
    const joined = lines.join("\n");
    expect(joined).toContain("[compute-retention] records=1");
    expect(joined).not.toMatch(/job_[0-9a-f]{24}/);
  });

  test("a run with a failing stage reports a fixed word and still runs the others", async () => {
    await oldJob();
    const broken = env({
      COMPUTE_RESULTS: new Proxy(fx.harness.results, {
        get(target, prop) {
          if (prop === "list")
            return async () => {
              throw new Error("results store down");
            };
          const v = (target as unknown as Record<string | symbol, unknown>)[prop];
          return typeof v === "function" ? v.bind(target) : v;
        },
      }),
    });
    const result = await runComputeRetentionSweep(broken);
    expect(result?.errors).toContain("results_failed");
    expect(result?.recordsDeleted).toBe(1);
    expect(JSON.stringify(result)).not.toContain("results store down");
    expect(result && retentionLogLine(result)?.level).toBe("error");
  });
});
