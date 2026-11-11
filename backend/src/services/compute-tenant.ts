/**
 * NEMAR's tenant-wide ceiling on live jobs (issue #2121, phase P2; ADR 0118, amendment of 2026-11-10).
 *
 * The cluster account has a fixed number of slots and NEMAR shares them among everything it runs. The
 * owner's policy (`tenant`, `shared/contract/compute.ts`) names a ceiling below that number and a floor
 * for each class of occupant; this file is the one place that counts the occupants, decides a job's
 * admission and reads the facts for a refusal and for the administrator's view.
 *
 * THE RULE. A job of class K is admitted when
 *
 *     occupied + 1 + SUM over the classes L other than K of max(0, floor[L] - occupied[L])  <=  ceiling
 *
 * That is: the job takes one slot, and the slots still owed to the OTHER classes' floors are not
 * available to it. A floor is unconditional (a floor slot is never lent to another class) and is only
 * what a class is owed, not what it is limited to: with the defaults (ceiling 20, floors 8 and 2 and 0)
 * the pipelines can burst to 12 and people to 18. The rule is the guard of the hold's own statement
 * (`tenantGuard`), counted in the same statement that writes the hold, so two requests racing for the
 * last slot cannot both win; it is a guard and not a clamp.
 *
 * THE CLASSES, by the job's `source` (the front doors that submit are on other branches of the
 * gateway; the function is by the word so each works when it lands):
 *   people     `cli` and `web`
 *   pipelines  `pipeline`
 *   partner    `partner`, reserved through the gateway (`flag_unreserved = 0`)
 *   other      everything else: a job the tenant sweep found that skipped the reservation
 *              (`flag_unreserved = 1`), and an orphan (below). No floor and no way to be admitted: NEMAR
 *              did not admit them, it only counts them.
 *
 * WHAT OCCUPIES A SLOT. Every row in a live state (`created` included: it is about to hold one), and
 * one slot more for each row that is no longer live and still records a Tapis job NEMAR made that no row
 * owns (`orphan_tapis_uuid`): the platform job is still running until the sweep cancels it. NEMAR's own
 * counting errs toward too many, never too few. It is NEMAR's view: a job that nothing has told NEMAR
 * about is not in it, which is why the ceiling sits below the cluster's own number.
 *
 * COST. The live count is answered from a partial index of the live rows, as the person's and the
 * pipelines' counts are. The orphan term is a scan of `compute_jobs`: no index serves it (a partial
 * index on `orphan_tapis_uuid` needs a migration, which P2 does not have), so every hold pays one scan
 * of the table; the table holds one row per job and is small, and a migration is the answer when it is
 * not.
 */

import type { ComputeSource } from "../../../shared/compute-state.js";
import {
  type ComputePolicy,
  type ComputeTenantPolicy,
  tenantPolicyOf,
} from "../../../shared/contract/compute.js";
import type { HoldGuard } from "./compute-ledger.js";
import { LIVE_STATES_SQL } from "./compute-state-sql.js";

/** The classes a slot is counted in, the first three with a floor. */
export const TENANT_CLASSES = ["people", "pipelines", "partner", "other"] as const;
export type TenantClass = (typeof TENANT_CLASSES)[number];

/** The classes the owner reserves a floor for (the rest has none). */
export const TENANT_FLOOR_CLASSES = ["people", "pipelines", "partner"] as const;
export type TenantFloorClass = (typeof TENANT_FLOOR_CLASSES)[number];

/** The class a job of this source is admitted as: the one place a source is mapped to a class. */
export function tenantClassOf(source: ComputeSource): TenantFloorClass {
  switch (source) {
    case "cli":
    case "web":
      return "people";
    case "pipeline":
      return "pipelines";
    case "partner":
      return "partner";
  }
}

/**
 * The slots each class holds and the total, one row, every column a number (an empty table is zeros).
 * The class of a row is decided once, in the inner CASE, so a row is counted in exactly one class:
 * a row the sweep flagged as having skipped the reservation is `other` whatever its source says.
 * The first leg is the live rows (the states written LITERALLY so the partial index serves it); the
 * second is the orphan term.
 */
export const TENANT_COUNTS_SQL = `SELECT
    COALESCE(SUM(c = 'people'), 0) AS people,
    COALESCE(SUM(c = 'pipelines'), 0) AS pipelines,
    COALESCE(SUM(c = 'partner'), 0) AS partner,
    COALESCE(SUM(c = 'other'), 0) AS other,
    COALESCE(COUNT(c), 0) AS occupied
  FROM (
    SELECT CASE
             WHEN flag_unreserved = 1 THEN 'other'
             WHEN source IN ('cli', 'web') THEN 'people'
             WHEN source = 'pipeline' THEN 'pipelines'
             WHEN source = 'partner' THEN 'partner'
             ELSE 'other'
           END AS c
      FROM compute_jobs WHERE state IN (${LIVE_STATES_SQL})
    UNION ALL
    SELECT 'other' FROM compute_jobs
     WHERE orphan_tapis_uuid IS NOT NULL AND state NOT IN (${LIVE_STATES_SQL})
  )`;

/**
 * The guard of the hold for a job of `cls`: the rule above as a boolean expression with plain `?`
 * placeholders (the ledger's `HoldGuard`). The statement differs by class only in which floors it owes,
 * so a class never owes its own; the binds are the other classes' floors in the order of
 * {@link TENANT_FLOOR_CLASSES}, then the ceiling. The job being admitted is not counted yet (its row is
 * written after the hold, in the same batch), hence the `+ 1`.
 */
export function tenantGuard(cls: TenantFloorClass, tenant: ComputeTenantPolicy): HoldGuard {
  const others = TENANT_FLOOR_CLASSES.filter((l) => l !== cls);
  const owed = others.map((l) => ` + MAX(0, ? - t.${l})`).join("");
  return {
    sql: `(SELECT t.occupied + 1${owed} <= ? FROM (${TENANT_COUNTS_SQL}) t)`,
    binds: [...others.map((l) => tenant.reserved[l]), tenant.maxLiveJobs],
  };
}

/** What the tenant ceiling looks like right now: the owner's numbers and the counts. */
export type TenantFacts = {
  ceiling: number;
  occupied: number;
  by_class: Record<TenantClass, number>;
  reserved: Record<TenantFloorClass, number>;
};

interface CountsRow {
  people: number;
  pipelines: number;
  partner: number;
  other: number;
  occupied: number;
}

/** Read the counts once, under the policy's ceiling (or the default when the policy has none). */
export async function tenantFacts(db: D1Database, policy: ComputePolicy): Promise<TenantFacts> {
  const tenant = tenantPolicyOf(policy);
  const row = await db.prepare(TENANT_COUNTS_SQL).first<CountsRow>();
  const by_class: Record<TenantClass, number> = {
    people: row?.people ?? 0,
    pipelines: row?.pipelines ?? 0,
    partner: row?.partner ?? 0,
    other: row?.other ?? 0,
  };
  return {
    ceiling: tenant.maxLiveJobs,
    occupied: row?.occupied ?? 0,
    by_class,
    reserved: { ...tenant.reserved },
  };
}

/** Slots occupied beyond the ceiling: only what NEMAR did not admit can cause it (0 when within). */
export const tenantOverCeiling = (facts: TenantFacts): number =>
  Math.max(0, facts.occupied - facts.ceiling);
