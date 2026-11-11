/**
 * Seeding for the compute job and record suites (epic #2005 phase A3, #2008). Everything goes through
 * the real ledger service and real SQL on a real migrated database; nothing stands in for a service.
 *
 * The ledger is append-only, so a database that cannot be reset (Miniflare's D1) is shared by every
 * case of a file: each case makes its own accounts and reads only what it made.
 */

import { type JobSpec, JobSpecSchema } from "../../../shared/contract/compute";
import { DEFAULT_COMPUTE_POLICY } from "../../../shared/contract/compute";
import { ensurePool, grantPool, platformPool } from "../../src/services/compute-ledger";
import { putPolicy } from "../../src/services/compute-policy";

let seq = 0;
export const nextSeq = () => ++seq + Math.floor(Math.random() * 1_000_000) * 1000;

export interface PersonSeed {
  role?: "member" | "admin" | "owner";
  status?: string;
  email?: string;
  username?: string;
  given_name?: string | null;
  family_name?: string | null;
  orcid?: string | null;
  country?: string | null;
  affiliation?: string | null;
  city?: string | null;
  deleted_at?: string | null;
}

/** A user row, with the identity fields a snapshot takes and some it must not. Its id. */
export async function seedUser(d1: D1Database, over: PersonSeed = {}): Promise<number> {
  const n = nextSeq();
  const row = {
    username: over.username ?? `cmp-user-${n}`,
    email: over.email ?? `cmp-user-${n}@example.org`,
    status: over.status ?? "approved",
    role: over.role ?? "member",
    given_name: over.given_name === undefined ? "Ada" : over.given_name,
    family_name: over.family_name === undefined ? "Lovelace" : over.family_name,
    orcid: over.orcid === undefined ? `0000-0002-${n}` : over.orcid,
    country: over.country === undefined ? "Freedonia" : over.country,
    affiliation:
      over.affiliation === undefined ? "Institute of Analytical Engines" : over.affiliation,
    city: over.city === undefined ? "Sylvania" : over.city,
    deleted_at: over.deleted_at ?? null,
  };
  const result = await d1
    .prepare(
      `INSERT INTO users (username, email, password_hash, status, role, signup_source, email_verified,
                          service_access, account_kind, given_name, family_name, orcid, country,
                          affiliation, city, deleted_at)
       VALUES (?1, ?2, 'x', ?3, ?4, 'cli', 1, 0, 'person', ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
    )
    .bind(
      row.username,
      row.email,
      row.status,
      row.role,
      row.given_name,
      row.family_name,
      row.orcid,
      row.country,
      row.affiliation,
      row.city,
      row.deleted_at,
    )
    .run();
  const id = result.meta?.last_row_id;
  if (typeof id !== "number") throw new Error("a seeded user has no id");
  return id;
}

let grants = 0;

/** Grant an account's pool, making the pool if it is not there; the pool's id. */
export async function fundAccount(
  d1: D1Database,
  accountId: number,
  milli: number,
  pool: "cpu" | "gpu" = "cpu",
): Promise<number> {
  const row = await ensurePool(d1, "account", String(accountId), pool);
  if (milli > 0) {
    const r = await grantPool(d1, {
      poolId: row.id,
      amountMilli: milli,
      actorUserId: 1,
      idempotencyKey: `seed-grant-${nextSeq()}-${++grants}`,
    });
    if (!r.ok) throw new Error(`could not grant: ${JSON.stringify(r)}`);
  }
  return row.id;
}

/** Grant a platform budget (`people` or `pipelines`) of one word. */
export async function fundPlatform(
  d1: D1Database,
  key: "people" | "pipelines",
  milli: number,
  pool: "cpu" | "gpu" = "cpu",
): Promise<number> {
  const row = await platformPool(d1, key, pool);
  if (!row) throw new Error(`no platform pool ${key}/${pool}`);
  const r = await grantPool(d1, {
    poolId: row.id,
    amountMilli: milli,
    actorUserId: 1,
    idempotencyKey: `seed-platform-${nextSeq()}-${++grants}`,
  });
  if (!r.ok) throw new Error(`could not grant: ${JSON.stringify(r)}`);
  return row.id;
}

/** A partner client's pool of one word, granted. */
export async function fundPartner(
  d1: D1Database,
  clientId: string,
  milli: number,
  pool: "cpu" | "gpu" = "cpu",
): Promise<number> {
  const row = await ensurePool(d1, "partner", clientId, pool);
  const r = await grantPool(d1, {
    poolId: row.id,
    amountMilli: milli,
    actorUserId: 1,
    idempotencyKey: `seed-partner-${nextSeq()}-${++grants}`,
  });
  if (!r.ok) throw new Error(`could not grant: ${JSON.stringify(r)}`);
  return row.id;
}

/** Set the owner policy (as `ownerId`, an owner) to the default with `over` applied. */
export async function setPolicy(
  d1: D1Database,
  ownerId: number,
  over: Record<string, unknown>,
): Promise<void> {
  const r = await putPolicy(d1, ownerId, { ...DEFAULT_COMPUTE_POLICY, ...over }, "test");
  if (!r.ok) throw new Error(`could not set the policy: ${JSON.stringify(r)}`);
}

/** Four cores for an hour on `shared`: 4 SU, which is 4000 milli-SU. A recipe job, so it needs no bundle. */
export const FOUR_SU = 4000;

export function jobSpec(over: Record<string, unknown> = {}): JobSpec {
  return JobSpecSchema.parse({
    name: "four cores for an hour",
    runtime: "python",
    recipe: "nemar-floor",
    partition: "shared",
    cores: 4,
    minutes: 60,
    ...over,
  });
}

/**
 * A partner's hold body as text, indented on purpose so that it is NOT what `JSON.stringify` of the
 * parsed body would write: `spec_digest` is the digest of the exact bytes the partner sent.
 */
export function holdBody(over: Record<string, unknown> = {}): string {
  return JSON.stringify(
    {
      app_id: "partner-app",
      app_version: "2.1.0",
      kind: "batch",
      partition: "shared",
      nodes: 1,
      cores: 4,
      gpus: 0,
      minutes: 60,
      ...over,
    },
    null,
    2,
  );
}

export const hex = (n: number) => n.toString(16).padStart(64, "0");

/** A script job with its code bundle: it is uploaded after the job exists. */
export function bundleJobSpec(
  bundle: { size: number; sha256: string },
  over: Record<string, unknown> = {},
): JobSpec {
  return JobSpecSchema.parse({
    name: "a script with its bundle",
    runtime: "python",
    entry: "run.py",
    bundle,
    partition: "shared",
    cores: 4,
    minutes: 60,
    ...over,
  });
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Row counts that a refused request must leave exactly as they were. */
export async function trace(d1: D1Database): Promise<Record<string, number>> {
  const count = async (sql: string) =>
    ((await d1.prepare(sql).first<{ n: number }>())?.n ?? 0) as number;
  return {
    jobs: await count("SELECT COUNT(*) AS n FROM compute_jobs"),
    ledger: await count("SELECT COUNT(*) AS n FROM compute_ledger"),
    holds: await count("SELECT COUNT(*) AS n FROM compute_ledger WHERE kind = 'hold'"),
    gateway: await count("SELECT COUNT(*) AS n FROM compute_gateway_users"),
    pools: await count("SELECT COUNT(*) AS n FROM compute_pools"),
    audit: await count("SELECT COUNT(*) AS n FROM audit_log"),
  };
}

const macrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * A D1 whose every statement takes a round trip: it waits a macrotask before it runs AND before its
 * result comes back. `yieldingD1` waits only before, so a read-then-write that is not atomic still runs
 * in one piece (the read's result is back before any other request's statement starts); real D1's
 * latency is on both sides, and with both, two requests that each read a count before either writes
 * both see the old count. A batch is passed through whole, as D1 runs it: one transaction.
 */
export function roundTripD1(d1: D1Database): D1Database {
  return {
    prepare(sql: string) {
      const inner = d1.prepare(sql) as unknown as {
        bind(...p: unknown[]): unknown;
        run(): Promise<unknown>;
        first(): Promise<unknown>;
        all(): Promise<unknown>;
        __execForBatch(): unknown;
      };
      const api = {
        bind(...p: unknown[]) {
          inner.bind(...p);
          return api;
        },
        async run() {
          await macrotask();
          const result = await inner.run();
          await macrotask();
          return result;
        },
        async first() {
          await macrotask();
          const result = await inner.first();
          await macrotask();
          return result;
        },
        async all() {
          await macrotask();
          const result = await inner.all();
          await macrotask();
          return result;
        },
        __execForBatch() {
          return inner.__execForBatch();
        },
      };
      return api;
    },
    batch: (stmts: unknown[]) => (d1 as unknown as { batch(s: unknown[]): unknown }).batch(stmts),
  } as unknown as D1Database;
}
