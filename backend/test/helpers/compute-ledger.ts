/**
 * Helpers for the compute ledger suites (epic #2005 phase A2, #2007; ADR 0118).
 *
 * Nothing here stands in for NEMAR logic. A Miniflare D1 is the implementation `wrangler --local`
 * runs, carrying every real migration; the totals check reads the real tables and compares what the
 * trigger wrote with what the ledger says, which is the property the design rests on.
 */

import { Miniflare } from "miniflare";
import { applyMigrations, migrationFiles } from "./miniflare-d1";

/** A well-formed job id (`job_` and 24 lowercase hex digits), the same number giving the same id. */
export function jobId(n: number): string {
  return `job_${n.toString(16).padStart(24, "0")}`;
}

export interface MiniflareD1 {
  d1: D1Database;
  dispose(): Promise<void>;
}

/** A Miniflare D1 with every migration applied, as the race and engine-parity suites need. */
export async function miniflareD1(): Promise<MiniflareD1> {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response(null, { status: 204 }); } };",
    compatibilityDate: "2024-12-01",
    d1Databases: ["DB"],
  });
  const d1 = await mf.getD1Database("DB");
  await applyMigrations(d1, migrationFiles());
  return { d1, dispose: () => mf.dispose() };
}

interface TotalsRow {
  id: number;
  granted_milli: number;
  held_milli: number;
  charged_milli: number;
  g: number;
  h: number;
  c: number;
}

/**
 * Every place a pool's stored totals disagree with the sums of its ledger deltas, as sentences
 * (empty when none do). A pool's row takes all three deltas of the entries made on it, and the
 * held and charged deltas of the entries that name it as the budget: that is the whole definition,
 * and it is computed here from the ledger alone, not from the code that writes the totals.
 */
export async function totalsDisagreements(d1: D1Database): Promise<string[]> {
  const { results } = await d1
    .prepare(
      `SELECT p.id, p.granted_milli, p.held_milli, p.charged_milli,
        COALESCE((SELECT SUM(granted_delta_milli) FROM compute_ledger WHERE pool_id = p.id), 0) AS g,
        COALESCE((SELECT SUM(held_delta_milli) FROM compute_ledger
                   WHERE pool_id = p.id OR budget_pool_id = p.id), 0) AS h,
        COALESCE((SELECT SUM(charged_delta_milli) FROM compute_ledger
                   WHERE pool_id = p.id OR budget_pool_id = p.id), 0) AS c
       FROM compute_pools p ORDER BY p.id`,
    )
    .all<TotalsRow>();
  const problems: string[] = [];
  for (const r of results) {
    if (r.granted_milli !== r.g) problems.push(`pool ${r.id} granted ${r.granted_milli} != ${r.g}`);
    if (r.held_milli !== r.h) problems.push(`pool ${r.id} held ${r.held_milli} != ${r.h}`);
    if (r.charged_milli !== r.c) problems.push(`pool ${r.id} charged ${r.charged_milli} != ${r.c}`);
  }
  return problems;
}

/** The id of a platform pool, which the migration seeds. */
export async function platformPoolId(
  d1: D1Database,
  key: "pipelines" | "people",
  pool: "cpu" | "gpu",
): Promise<number> {
  const row = await d1
    .prepare(
      "SELECT id FROM compute_pools WHERE holder_kind = 'platform' AND holder_ref = ? AND pool = ?",
    )
    .bind(key, pool)
    .first<{ id: number }>();
  if (!row) throw new Error(`no platform pool ${key}/${pool}`);
  return row.id;
}

export interface PoolTotals {
  granted_milli: number;
  held_milli: number;
  charged_milli: number;
  frozen: number;
}

export async function poolTotals(d1: D1Database, id: number): Promise<PoolTotals> {
  const row = await d1
    .prepare(
      "SELECT granted_milli, held_milli, charged_milli, frozen FROM compute_pools WHERE id = ?",
    )
    .bind(id)
    .first<PoolTotals>();
  if (!row) throw new Error(`no pool ${id}`);
  return row;
}

/** How many ledger rows there are, optionally of one pool. */
export async function ledgerCount(d1: D1Database, poolId?: number): Promise<number> {
  const row =
    poolId === undefined
      ? await d1.prepare("SELECT COUNT(*) AS n FROM compute_ledger").first<{ n: number }>()
      : await d1
          .prepare("SELECT COUNT(*) AS n FROM compute_ledger WHERE pool_id = ?")
          .bind(poolId)
          .first<{ n: number }>();
  return row?.n ?? 0;
}

/** A small seeded generator (mulberry32), so a failing random sequence replays exactly. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
