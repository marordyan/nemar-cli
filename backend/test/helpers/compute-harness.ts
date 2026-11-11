/**
 * A real environment for the compute gateway's storage and job suites (epic #2005 phase A3, #2008).
 *
 * Nothing here replaces business logic:
 *  - the database is bun:sqlite carrying EVERY production migration (`freshDb`), and, when asked
 *    for, a Miniflare D1 carrying the same migrations (the implementation `wrangler --local` runs);
 *  - the two private buckets are Miniflare's R2, the implementation `wrangler dev` runs, reached
 *    through the very bindings the Worker uses (`COMPUTE_RECORDS`, `COMPUTE_RESULTS`);
 *  - the S3 interface the signer addresses is one real local HTTP server over those same two
 *    buckets (`startComputeS3Standin`), reached through `globalThis.NEMAR_COMPUTE_S3_URL`, the
 *    override the production code honours, so the bindings are tested in a PRODUCTION-flagged
 *    environment and a presigned PUT lands in the bucket a binding then reads.
 *
 * `COMPUTE_R2_S3_ENDPOINT` is set to an address nothing listens on: if the override ever stopped
 * applying, a signed request would fail loudly instead of reaching anything.
 *
 * Under bun, reading `.body` of an object that Miniflare's Node-side proxy returns throws
 * `DataCloneError`; read `arrayBuffer()` or `text()`, as the code under test does.
 */

import type { Database } from "bun:sqlite";
import { Miniflare } from "miniflare";
import type { Bindings } from "../../src/types/bindings";
import { type ComputeS3Standin, startComputeS3Standin } from "./compute-s3-standin";
import { freshDb, realD1 } from "./d1";
import { applyMigrations, migrationFiles } from "./miniflare-d1";
import { retryInfrastructure } from "./neurobagel-harness";

export const HARNESS_BUCKETS = {
  records: "nemar-compute-records",
  results: "nemar-compute-results",
} as const;

export interface ComputeHarness {
  mf: Miniflare;
  records: R2Bucket;
  results: R2Bucket;
  standin: ComputeS3Standin;
  db: Database;
  /** Only with `withD1`: a Miniflare D1 with every migration applied (it is never reset). */
  d1?: D1Database;
  /** Bindings: production-shaped (`ENVIRONMENT` is `production`) unless overridden. */
  env(over?: Partial<Bindings>): Bindings;
  /** Every key of a bucket. */
  keys(bucket: R2Bucket): Promise<string[]>;
  /** Empty both buckets, start a new database, and clear the stand-in's log and failures. */
  reset(): Promise<void>;
  dispose(): Promise<void>;
}

async function emptyBucket(bucket: R2Bucket): Promise<void> {
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ cursor });
    // One call per 1000 keys (the R2 bound), not one per object: a bucket holding the 2500-output
    // test's records otherwise outlasts the hook timeout and takes the workerd process with it.
    const keys = listed.objects.map((o) => o.key);
    for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

async function listKeys(bucket: R2Bucket): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ cursor });
    for (const o of listed.objects) out.push(o.key);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return out.sort();
}

export async function startComputeHarness(
  opts: { withD1?: boolean } = {},
): Promise<ComputeHarness> {
  const infra = await retryInfrastructure("miniflare", async () => {
    const mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok') } }",
      compatibilityDate: "2024-12-01",
      r2Buckets: ["COMPUTE_RECORDS", "COMPUTE_RESULTS"],
      ...(opts.withD1 ? { d1Databases: ["DB"] } : {}),
    });
    try {
      const records = (await mf.getR2Bucket("COMPUTE_RECORDS")) as unknown as R2Bucket;
      const results = (await mf.getR2Bucket("COMPUTE_RESULTS")) as unknown as R2Bucket;
      await records.list({ limit: 1 });
      await results.list({ limit: 1 });
      let d1: D1Database | undefined;
      if (opts.withD1) {
        d1 = (await mf.getD1Database("DB")) as unknown as D1Database;
        await applyMigrations(d1, migrationFiles());
      }
      return { mf, records, results, d1 };
    } catch (err) {
      await mf.dispose().catch(() => {});
      throw err;
    }
  });

  const standin = startComputeS3Standin({
    buckets: { [HARNESS_BUCKETS.records]: infra.records, [HARNESS_BUCKETS.results]: infra.results },
  });
  const previous = (globalThis as { NEMAR_COMPUTE_S3_URL?: string }).NEMAR_COMPUTE_S3_URL;
  (globalThis as { NEMAR_COMPUTE_S3_URL?: string }).NEMAR_COMPUTE_S3_URL = standin.url;

  const harness: ComputeHarness = {
    mf: infra.mf,
    records: infra.records,
    results: infra.results,
    standin,
    db: freshDb(),
    d1: infra.d1,
    env(over = {}) {
      return {
        DB: realD1(harness.db),
        ENVIRONMENT: "production",
        COMPUTE_RECORDS: harness.records,
        COMPUTE_RESULTS: harness.results,
        COMPUTE_RECORDS_BUCKET_NAME: HARNESS_BUCKETS.records,
        COMPUTE_RESULTS_BUCKET_NAME: HARNESS_BUCKETS.results,
        COMPUTE_R2_ACCESS_KEY_ID: standin.accessKeyId,
        COMPUTE_R2_SECRET_ACCESS_KEY: standin.secretAccessKey,
        // Nothing listens here: the global override must be what the signer addresses.
        COMPUTE_R2_S3_ENDPOINT: "http://127.0.0.1:1",
        ...over,
      } as Bindings;
    },
    keys: listKeys,
    async reset() {
      await emptyBucket(harness.records);
      await emptyBucket(harness.results);
      harness.db.close();
      harness.db = freshDb();
      harness.standin.log.length = 0;
      harness.standin.clearFailures();
      harness.standin.clock.now = () => Date.now();
    },
    async dispose() {
      (globalThis as { NEMAR_COMPUTE_S3_URL?: string }).NEMAR_COMPUTE_S3_URL = previous;
      await harness.mf.dispose();
      harness.standin.stop();
    },
  };
  return harness;
}
