/**
 * Dev/staging cron safety tests (epic #923, Phase 7 / #930).
 *
 * Phase 7 enables a daily cron on the dev/staging worker for the first time.
 * That worker's D1 is a partial PRODUCTION MIRROR (real nm* dataset rows, real
 * user email addresses) and the worker holds a live RESEND_API_KEY, so the
 * daily job set has to be narrowed before the trigger is safe to add.
 *
 * These tests pin the two guarantees that keep it safe:
 *   1. Outside production the sandbox cleanup only ever selects ids in the dev
 *      EPHEMERAL band (xx090001-xx099899), never the curated exemplar fleet
 *      (xx099900+), never prod's sandbox band, never a real nm/on/ds row. This
 *      matters because deleteDatasetCascade's GitHub half is NOT env-scoped: a
 *      stray match deletes a real nemarDatasets repository.
 *   2. archiveRetrySweep and reconcileReservedVersionDois refuse to run outside
 *      production even when called directly, so the guarantee does not depend on
 *      the cron's allowlist being the only caller.
 *   3. The blocked-publication sweep is SCOPED rather than disabled outside
 *      production: staging needs it (an exemplar published while its BIDS
 *      validation is still running lands in 'blocked' and would otherwise stay
 *      stuck), so it narrows to the dev range instead of skipping.
 *
 * The band test runs the ACTUAL cleanup SQL from index.ts against real
 * in-memory SQLite with the full migrated schema (no mocks): if the query in
 * index.ts changes, this test has to change with it.
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
// The queries are imported from the production module, NOT retyped here, so a
// change to the real SQL cannot silently leave this test asserting stale text.
import {
  NON_PROD_SANDBOX_CLEANUP_QUERY as NON_PROD_SANDBOX_QUERY,
  PROD_SANDBOX_CLEANUP_QUERY as PROD_SANDBOX_QUERY,
} from "../src/index";
import { runAccessReportCron } from "../src/services/access-attributes";
import { archiveRetrySweep } from "../src/services/archive-retry";
import { runComputeAdvanceCron, sweepComputeCancellations } from "../src/services/compute-advance";
import {
  DEV_EPHEMERAL_BAND_END,
  DEV_EPHEMERAL_BAND_START,
  isDevEphemeralSandboxId,
  isDevOwnedDatasetId,
} from "../src/services/datasetId";
import { deleteDatasetCascade } from "../src/services/deletion";
import { reconcileReservedVersionDois } from "../src/services/doi-reconcile";
import { blockedCandidateQuery } from "../src/services/publication-sweep";
import { runRepullAdvanceCron } from "../src/services/upstream-repull-advance";
import { sweepUnreportedDispatches } from "../src/services/upstream-repull-dispatch";
import { runRepullSchedulerCron } from "../src/services/upstream-repull-scheduler";
import type { Bindings } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

/** Seed an aged, active dataset row (old enough to be a cleanup candidate). */
function seedAged(db: Database, ids: string[], isExemplar = 0): void {
  const stmt = db.query(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, status, is_exemplar, created_at)
     VALUES (?, 'test', 1, 'active', ?, datetime('now', '-30 days'))`,
  );
  for (const id of ids) stmt.run(id, isExemplar);
}

describe("isDevEphemeralSandboxId", () => {
  test("accepts the ephemeral band only", () => {
    expect(isDevEphemeralSandboxId("xx090001")).toBe(true); // floor
    expect(isDevEphemeralSandboxId("xx095000")).toBe(true);
    expect(isDevEphemeralSandboxId("xx099899")).toBe(true); // last before exemplars
  });

  test("rejects the exemplar fleet band", () => {
    expect(isDevEphemeralSandboxId("xx099900")).toBe(false); // first exemplar
    expect(isDevEphemeralSandboxId("xx099950")).toBe(false);
    expect(isDevEphemeralSandboxId("xx099999")).toBe(false); // last exemplar
  });

  test("rejects prod's sandbox band and the dev floor boundary", () => {
    expect(isDevEphemeralSandboxId("xx090000")).toBe(false); // below floor
    expect(isDevEphemeralSandboxId("xx089999")).toBe(false); // prod ceiling
    expect(isDevEphemeralSandboxId("xx000001")).toBe(false);
  });

  test("rejects non-sandbox prefixes", () => {
    expect(isDevEphemeralSandboxId("nm090001")).toBe(false);
    expect(isDevEphemeralSandboxId("on090001")).toBe(false);
    expect(isDevEphemeralSandboxId("ds090001")).toBe(false);
  });

  test("band constants are half-open and ordered", () => {
    expect(DEV_EPHEMERAL_BAND_START < DEV_EPHEMERAL_BAND_END).toBe(true);
    expect(isDevEphemeralSandboxId(DEV_EPHEMERAL_BAND_START)).toBe(true);
    expect(isDevEphemeralSandboxId(DEV_EPHEMERAL_BAND_END)).toBe(false);
  });
});

describe("non-production sandbox cleanup query", () => {
  test("selects only ephemeral-band ids, sparing exemplars and real datasets", async () => {
    const db = freshDb();
    seedAged(db, [
      "xx090001", // ephemeral, deletable
      "xx095555", // ephemeral, deletable
      "xx099899", // ephemeral, deletable (last)
      "xx089999", // prod sandbox band, must survive
      "xx000042", // prod sandbox band, must survive
    ]);
    seedAged(db, ["xx099900", "xx099906"], 1); // exemplar fleet, must survive
    // The rows that make the dev D1 dangerous: real production datasets.
    seedAged(db, ["nm000155", "on003805", "ds000117"]);

    const rows = await realD1(db)
      .prepare(NON_PROD_SANDBOX_QUERY)
      .bind(DEV_EPHEMERAL_BAND_START, DEV_EPHEMERAL_BAND_END, 10)
      .all<{ dataset_id: string }>();

    expect(rows.results.map((r) => r.dataset_id).sort()).toEqual([
      "xx090001",
      "xx095555",
      "xx099899",
    ]);
  });

  test("spares an exemplar even if its is_exemplar flag were cleared", async () => {
    // Belt and suspenders: the band alone must exclude the fleet, so a bad
    // is_exemplar write cannot make a curated exemplar deletable.
    const db = freshDb();
    seedAged(db, ["xx099900", "xx099999"], 0);

    const rows = await realD1(db)
      .prepare(NON_PROD_SANDBOX_QUERY)
      .bind(DEV_EPHEMERAL_BAND_START, DEV_EPHEMERAL_BAND_END, 10)
      .all<{ dataset_id: string }>();

    expect(rows.results).toEqual([]);
  });

  test("production query still sweeps the whole xx space", async () => {
    // The narrowing must be non-production only; prod keeps its 14-day sweep
    // across xx000001-xx089999 (prod never has exemplar rows).
    const db = freshDb();
    seedAged(db, ["xx000042", "xx089999"]);

    const rows = await realD1(db)
      .prepare(PROD_SANDBOX_QUERY)
      .bind(10)
      .all<{ dataset_id: string }>();

    expect(rows.results.map((r) => r.dataset_id).sort()).toEqual(["xx000042", "xx089999"]);
  });
});

describe("production-only daily jobs are environment-gated", () => {
  // Both jobs swallow their own query errors, so "resolved without throwing" is
  // NOT evidence the guard fired. Observe whether D1 was reached at all.
  function probe(): { db: D1Database; touched: () => boolean } {
    let reached = false;
    const db = {
      prepare() {
        reached = true;
        throw new Error("probe: candidate query reached");
      },
    } as unknown as D1Database;
    return { db, touched: () => reached };
  }

  // Recognized non-production values: the job must not touch D1 at all.
  for (const environment of ["development", "staging", "test"]) {
    test(`archiveRetrySweep never queries D1 when ENVIRONMENT=${environment}`, async () => {
      const p = probe();
      await archiveRetrySweep({ ENVIRONMENT: environment, DB: p.db } as unknown as Bindings);
      expect(p.touched()).toBe(false);
    });

    test(`reconcileReservedVersionDois never queries D1 when ENVIRONMENT=${environment}`, async () => {
      const p = probe();
      await reconcileReservedVersionDois({
        ENVIRONMENT: environment,
        DB: p.db,
      } as unknown as Bindings);
      expect(p.touched()).toBe(false);
    });
  }

  // isNonProductionEnv is an allow-list and fails CLOSED: production, and any
  // unset/unrecognized value, are treated as production so these backstops keep
  // running rather than silently disabling themselves on a config typo.
  for (const environment of ["production", "", undefined, "prod", "Production"]) {
    test(`archiveRetrySweep still runs when ENVIRONMENT=${JSON.stringify(environment)}`, async () => {
      const p = probe();
      await archiveRetrySweep({ ENVIRONMENT: environment, DB: p.db } as unknown as Bindings);
      expect(p.touched()).toBe(true);
    });

    test(`reconcileReservedVersionDois still runs when ENVIRONMENT=${JSON.stringify(environment)}`, async () => {
      const p = probe();
      await reconcileReservedVersionDois({
        ENVIRONMENT: environment,
        DB: p.db,
      } as unknown as Bindings);
      expect(p.touched()).toBe(true);
    });
  }
});

describe("prod-safety gates use the fail-closed helper, not a literal comparison", () => {
  // `ENVIRONMENT === "production"` is true ONLY for that exact string, so an
  // unset/blank/typo'd binding silently turns the gate off. `isNonProductionEnv`
  // is an allow-list that treats anything unrecognized AS production, so the
  // same drift leaves the gate on. Both files below guard something that must
  // still happen when the env var goes missing: the exemplar-leak alarm (the
  // only environment-aware backstop behind the env-blind visibility carve-outs)
  // and the prod webhook dev-range short-circuit. A structural pin, matching
  // this repo's admin-route-inventory / api-export-surface convention.
  // Extended in #1167: the three sweep services gained their own
  // isNonProductionEnv guards (issue #1166), so they are now exactly the
  // kind of file this pin exists for. They were clean when added; this
  // keeps them that way.
  const FILES = [
    "../src/index.ts",
    "../src/routes/webhooks/github.ts",
    "../src/services/availability-report.ts",
    "../src/services/recording-stats-sweep.ts",
    "../src/services/signal-defaults-sweep.ts",
  ];

  for (const rel of FILES) {
    test(`${rel} has no raw ENVIRONMENT === "production" gate`, async () => {
      const src = await Bun.file(new URL(rel, import.meta.url)).text();
      const offenders = src
        .split("\n")
        .map((line, i) => ({ line: line.trim(), n: i + 1 }))
        // Skip comments: the fixed sites deliberately NAME the rejected pattern
        // in a comment explaining why the helper is used instead.
        .filter(({ line }) => !line.startsWith("//") && !line.startsWith("*"))
        .filter(({ line }) => /ENVIRONMENT\s*===\s*["']production["']/.test(line));
      expect(offenders).toEqual([]);
    });
  }
});

describe("deleteDatasetCascade prod-repo fence", () => {
  // The cascade's GitHub half is NOT environment-scoped: it always deletes
  // nemarDatasets/<id>. The manual delete endpoints (admin delete-dataset,
  // bulk-delete, draft delete, import rollback) all funnel through here, and
  // dev's D1 is a prod mirror, so without this fence deleting a real id from
  // the dev worker would destroy the real repository.
  const env = (environment: string) =>
    ({ ENVIRONMENT: environment, DB: {}, S3_BUCKET: "nemar-dev" }) as unknown as Bindings;

  // nm099999 is in this list deliberately: it is a RESERVED fixture id, but it
  // exists in production's catalog too and is maintained through its own reset
  // endpoint, so dev must not cascade-delete the repository production uses.
  // "reserved" does not imply "dev-owned" (#1440).
  for (const id of ["nm000103", "nm000155", "on003805", "xx000042", "xx089999", "nm099999"]) {
    test(`refuses ${id} on a non-production worker`, async () => {
      await expect(deleteDatasetCascade({} as D1Database, env("development"), id)).rejects.toThrow(
        /non-production worker/,
      );
    });
  }

  test("allows the dev-owned reserved fixture off-prod (#1440)", async () => {
    // The failure this fixes: the fence keyed on the id SHAPE (xx09NNNN), so a
    // reserved `nm` fixture was refused on the only worker that could rebuild
    // it -- which made the documented recovery for a failed fixture build,
    // delete then recreate, impossible on dev. It must NOT throw the fence
    // error; failing later on the stub D1 is the "let through" signal.
    const explodes = {
      prepare() {
        throw new Error("reached-d1");
      },
    } as unknown as D1Database;
    await expect(
      deleteDatasetCascade(explodes, env("development"), "nm099998"),
    ).rejects.not.toThrow(/non-production worker/);
  });

  test("production is unaffected: the fence is non-production only", async () => {
    const explodes = {
      prepare() {
        throw new Error("reached-d1");
      },
    } as unknown as D1Database;
    await expect(deleteDatasetCascade(explodes, env("production"), "nm000103")).rejects.not.toThrow(
      /non-production worker/,
    );
  });

  test("refuses before touching GitHub, S3 or D1", async () => {
    // The throw must precede every side effect; a D1 that explodes on use
    // proves nothing ran before the guard.
    const explodes = {
      prepare() {
        throw new Error("must not be reached");
      },
    } as unknown as D1Database;
    await expect(deleteDatasetCascade(explodes, env("development"), "nm000103")).rejects.toThrow(
      /non-production worker/,
    );
  });

  test("allows dev-range ids off-prod (the exemplar reset path)", async () => {
    // Must NOT throw the fence error. It fails later on the stub D1/GitHub,
    // which is fine: we only assert the fence let it through.
    const explodes = {
      prepare() {
        throw new Error("reached-d1");
      },
    } as unknown as D1Database;
    await expect(
      deleteDatasetCascade(explodes, env("development"), "xx099900"),
    ).rejects.not.toThrow(/non-production worker/);
  });
});

describe("blocked publication sweep scopes by dataset range, not by skipping", () => {
  // This sweep must keep working on staging (an exemplar published while its
  // BIDS validation is still running lands in 'blocked' and would otherwise
  // stay stuck), while never touching the real datasets in the prod-mirror D1.
  function seedBlocked(db: Database, ids: string[]): void {
    const ds = db.query(
      "INSERT INTO datasets (dataset_id, name, owner_user_id, github_repo) VALUES (?, 'test', 1, ?)",
    );
    const pr = db.query(
      "INSERT INTO publication_requests (dataset_id, status, block_reason, requested_by) VALUES (?, 'blocked', 'bids_validation_pending', 1)",
    );
    for (const id of ids) {
      ds.run(id, `nemarDatasets/${id}`);
      pr.run(id);
    }
  }

  // The candidate query is imported WHOLE (sql + binds) from publication-sweep.ts.
  // Importing only the scope clause was not enough: this file then rebuilt the
  // surrounding SELECT by hand, so its placeholder layout was not production's,
  // and transposing the declared ids with the limit in the real `.bind()` left
  // the suite green. `.rules/testing.md` forbids hand-copied SQL for exactly
  // this reason, and a half-imported query has the same defect as a copied one.

  test("non-production sees dev-range requests AND its declared fixtures", async () => {
    // nm099998 is the case this exists for. An anonymous release IS a
    // publication request, so the standing anonymous deposit is the single most
    // likely dataset on staging to land in 'blocked' while BIDS validation runs
    // -- and it was inside `LIKE 'xx09%'` at xx099907 and dropped out of it at
    // nm099998. Without the ownership term it would stay stuck forever, which
    // is the state this sweep exists to clear.
    const db = freshDb();
    seedBlocked(db, ["xx099900", "xx090001", "nm099998", "nm000155", "on003805", "nm099999"]);

    const { sql, binds } = blockedCandidateQuery(true, 100);
    const rows = await realD1(db)
      .prepare(sql)
      .bind(...binds)
      .all<{ dataset_id: string }>();

    // nm099999 is absent deliberately: reserved, but production's, not dev's.
    expect(rows.results.map((r) => r.dataset_id).sort()).toEqual([
      "nm099998",
      "xx090001",
      "xx099900",
    ]);
  });

  test("production still sees every blocked request", async () => {
    const db = freshDb();
    seedBlocked(db, ["xx099900", "nm000155", "on003805"]);

    const { sql, binds } = blockedCandidateQuery(false, 100);
    const rows = await realD1(db)
      .prepare(sql)
      .bind(...binds)
      .all<{ dataset_id: string }>();

    expect(rows.results.map((r) => r.dataset_id).sort()).toEqual([
      "nm000155",
      "on003805",
      "xx099900",
    ]);
  });
});

describe("the dev cleanup cron never selects a reserved fixture (#1440)", () => {
  // Dev OWNING nm099998 must not make the cleanup cron a way to lose it. The
  // cron bounds itself by a SQL string range over the dev EPHEMERAL band, which
  // is a different question from ownership: dev owns the fixture and may delete
  // it deliberately, but nothing automated may.
  test("the ephemeral band excludes the reserved fixtures, by construction", () => {
    const db = freshDb();
    seedAged(db, ["xx090001", "xx099899", "xx099900", "nm099998", "nm099999"]);
    const picked = (
      db
        .query(NON_PROD_SANDBOX_QUERY)
        .all(DEV_EPHEMERAL_BAND_START, DEV_EPHEMERAL_BAND_END, 100) as { dataset_id: string }[]
    ).map((r) => r.dataset_id);
    expect(picked).toEqual(["xx090001", "xx099899"]);
    expect(picked).not.toContain("nm099998");
    db.close();
  });

  test("isDevOwnedDatasetId and isDevEphemeralSandboxId answer different questions", () => {
    // Conflating them is the bug #1440 fixed; this pins that they are not the
    // same predicate wearing two names.
    expect(isDevOwnedDatasetId("nm099998")).toBe(true);
    expect(isDevEphemeralSandboxId("nm099998")).toBe(false);
    expect(isDevOwnedDatasetId("xx090001")).toBe(true);
    expect(isDevEphemeralSandboxId("xx090001")).toBe(true);
    expect(isDevOwnedDatasetId("xx099900")).toBe(true); // exemplar fleet: dev's
    expect(isDevEphemeralSandboxId("xx099900")).toBe(false); // but never auto-deleted
    expect(isDevOwnedDatasetId("nm099999")).toBe(false); // production has it too
    expect(isDevOwnedDatasetId("nm000104")).toBe(false);
  });
});

describe("the automatic re-pull's cron jobs refuse outside exact production (#1913)", () => {
  // The scheduler dispatches against the shared nemarDatasets org, the advance tick reads and acts
  // on pull requests there, and the watchdog writes the dispatch table, which only the production
  // Worker fills. Each tests `ENVIRONMENT` for the exact
  // string `production`, the REVERSE of isNonProductionEnv's fail-closed reading: here the danger
  // is acting, so an unset or misspelled binding must leave them off (ADR 0111, the Phase 7a
  // slice). A D1 that throws on first use proves nothing was read or written.
  const untouched = () => {
    let touched = false;
    const db = {
      prepare() {
        touched = true;
        throw new Error("reached-d1");
      },
      batch() {
        touched = true;
        throw new Error("reached-d1");
      },
    } as unknown as D1Database;
    return { db, touched: () => touched };
  };

  for (const environment of [
    "development",
    "staging",
    "test",
    "",
    undefined,
    "prod",
    "Production",
    " production",
  ]) {
    test(`ENVIRONMENT=${JSON.stringify(environment)}: each returns null with D1 untouched`, async () => {
      const p = untouched();
      const e = {
        ENVIRONMENT: environment,
        DB: p.db,
        AUTO_REPULL_ENABLED: "1",
        AUTO_REPULL_MERGE_ENABLED: "1",
        PRESCREEN_CALLBACK_SECRET: "s",
      } as unknown as Bindings;
      expect(await runRepullSchedulerCron(e, { cliVersion: "1.2.3" })).toBeNull();
      expect(await sweepUnreportedDispatches(e)).toBeNull();
      expect(await runRepullAdvanceCron(e)).toBeNull();
      expect(p.touched()).toBe(false);
    });
  }

  test("in production each reaches D1, so the probe above is not vacuous", async () => {
    const db = realD1(freshDb());
    const e = { ENVIRONMENT: "production", DB: db } as unknown as Bindings;
    // The open switch is off: the scheduler only stamps its row.
    expect((await runRepullSchedulerCron(e, { cliVersion: "1.2.3" }))?.outcome).toBe("switch-off");
    expect(await sweepUnreportedDispatches(e)).toEqual({ marked: 0 });
    // The advance tick finds no automatic re-pull and stamps that it ran.
    expect((await runRepullAdvanceCron(e))?.examined).toBe(0);
    const p = untouched();
    const reached = { ENVIRONMENT: "production", DB: p.db } as unknown as Bindings;
    await runRepullSchedulerCron(reached, { cliVersion: "1.2.3" });
    expect(p.touched()).toBe(true);
    const q = untouched();
    await runRepullAdvanceCron({ ENVIRONMENT: "production", DB: q.db } as unknown as Bindings);
    expect(q.touched()).toBe(true);
  });
});

describe("the compute gateway's cron jobs refuse outside exact production (#2010)", () => {
  // The advance tick acts on a Tapis tenant and moves the allocation ledger, and the cancel sweep calls
  // Tapis: the development database shares real users and the organization, and development advances a
  // job by its webhook, by a read and by an administrator's command. Each tests `ENVIRONMENT` for the
  // exact string `production`, so an unset or misspelled binding leaves them off. A D1 that throws on
  // first use proves nothing was read or written.
  const untouched = () => {
    let touched = false;
    const db = {
      prepare() {
        touched = true;
        throw new Error("reached-d1");
      },
      batch() {
        touched = true;
        throw new Error("reached-d1");
      },
    } as unknown as D1Database;
    return { db, touched: () => touched };
  };

  for (const environment of [
    "development",
    "staging",
    "test",
    "",
    undefined,
    "prod",
    "Production",
    " production",
  ]) {
    test(`ENVIRONMENT=${JSON.stringify(environment)}: each returns null with D1 untouched`, async () => {
      const p = untouched();
      const e = {
        ENVIRONMENT: environment,
        DB: p.db,
        COMPUTE_ENABLED: "1",
      } as unknown as Bindings;
      expect(await runComputeAdvanceCron(e)).toBeNull();
      expect(await sweepComputeCancellations(e)).toBeNull();
      expect(p.touched()).toBe(false);
    });
  }

  test("in production each reaches D1, so the probe above is not vacuous", async () => {
    const db = realD1(freshDb());
    const e = { ENVIRONMENT: "production", DB: db } as unknown as Bindings;
    // No jobs: each finds nothing to do, with the Tapis tenant unconfigured and compute switched off.
    expect(await runComputeAdvanceCron(e)).toMatchObject({ examined: 0, errors: [] });
    expect(await sweepComputeCancellations(e)).toMatchObject({ examined: 0, errors: [] });
    const p = untouched();
    const reached = { ENVIRONMENT: "production", DB: p.db } as unknown as Bindings;
    await runComputeAdvanceCron(reached);
    expect(p.touched()).toBe(true);
    const q = untouched();
    await sweepComputeCancellations({ ENVIRONMENT: "production", DB: q.db } as unknown as Bindings);
    expect(q.touched()).toBe(true);
  });
});

describe("the ACCESS reporter refuses outside exact production (#2013)", () => {
  // The reporter POSTs to a third party with an owner-set key, and the development database shares real
  // users. It tests `ENVIRONMENT` for the exact string `production`, so an unset or misspelled binding
  // leaves it off. A D1 that throws on first use proves nothing was read or written.
  const untouched = () => {
    let touched = false;
    const db = {
      prepare() {
        touched = true;
        throw new Error("reached-d1");
      },
      batch() {
        touched = true;
        throw new Error("reached-d1");
      },
    } as unknown as D1Database;
    return { db, touched: () => touched };
  };

  for (const environment of [
    "development",
    "staging",
    "test",
    "",
    undefined,
    "prod",
    "Production",
    " production",
  ]) {
    test(`ENVIRONMENT=${JSON.stringify(environment)}: it returns null with D1 untouched`, async () => {
      const p = untouched();
      const e = {
        ENVIRONMENT: environment,
        DB: p.db,
        ACCESS_GATEWAY_ATTRIBUTES_KEY: "a-key",
        ACCESS_RESOURCE_NAME: "a-resource",
      } as unknown as Bindings;
      expect(await runAccessReportCron(e)).toBeNull();
      expect(p.touched()).toBe(false);
    });
  }

  test("in production it reaches D1, so the probe above is not vacuous", async () => {
    const db = realD1(freshDb());
    expect(
      await runAccessReportCron({ ENVIRONMENT: "production", DB: db } as unknown as Bindings),
    ).toMatchObject({ examined: 0, errors: [] });
    const p = untouched();
    await runAccessReportCron({ ENVIRONMENT: "production", DB: p.db } as unknown as Bindings);
    expect(p.touched()).toBe(true);
  });
});
