/**
 * Real POST /admin/doctor/fix route tests (issue #1135).
 *
 * The 2026-08-23 nm000225 incident (see .memory/manifest-healing-dispatch-over-rest.md)
 * hit exactly this shape: an UN-NARROWED doctor/fix call re-scans the whole
 * catalog and then fixes every finding in one Worker invocation, which
 * starves the GitHub App rate limit / Workers subrequest budget well
 * before it finishes. This suite pins the fix: an un-narrowed call caps how
 * many findings it fixes per invocation (DOCTOR_FIX_DEFAULT_LIMIT / MAX)
 * and reports `remaining` so a caller iterates; a dataset_id-narrowed call
 * is unaffected.
 *
 * Real engine throughout: bun:sqlite behind realD1 (every migration
 * applied), real Hono dispatch through authMiddleware + adminMiddleware
 * with a real hashed token, and the real `missing-manifest` check (the one
 * registered DoctorCheck) driving the real route -- not a hand-copied
 * re-implementation of the cap logic.
 *
 * `missing-manifest`'s scan() and fix() both call services/s3.ts's
 * getManifest(), which issues a REAL fetch to
 * `https://<bucket>.s3.<region>.amazonaws.com/...` with no local-test seam
 * (the same structural constraint data-integrity-sweep-route.test.ts
 * documents). Rather than mock that boundary, `withFakeS3` below redirects
 * any `*.amazonaws.com` host to a local Bun.serve() instance, mirroring
 * zarr-index-v3.test.ts's `getZarrIndex` redirect pattern -- fetch itself
 * stays real. The fake server answers 404 on a key's FIRST request (so scan
 * treats it as a missing manifest -> a finding) and 200 on every
 * subsequent request to that same key (so fix()'s own re-check-before-write
 * immediately returns `status: "skipped"` with no GitHub call at all) --
 * this proves the CAP counts real fix() invocations while staying
 * network-free beyond localhost.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { adminRoutes } from "../src/routes/admin";
import {
  DOCTOR_FIX_DEFAULT_LIMIT,
  DOCTOR_FIX_MAX_LIMIT,
} from "../src/routes/admin/datasets-lifecycle";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const ADMIN_KEY = "doctor-admin-key-0123456789abcdef0123456789abcdef";
const S3_BUCKET = "nemar-doctor-fix-test";
const AWS_REGION = "us-east-1";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;

async function seedAdmin(): Promise<void> {
  db.run(
    `INSERT INTO users (username, email, password_hash, github_username, status, role, email_verified)
     VALUES ('doctoradmin', 'doctoradmin@example.org', 'x', 'doctoradmin-gh', 'approved', 'admin', 1)`,
  );
  const u = db.query<{ id: number }, []>("SELECT id FROM users WHERE username='doctoradmin'").get();
  if (!u) throw new Error("seed: admin insert failed");
  await db
    .query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)")
    .run(u.id, await hashApiKey(ADMIN_KEY), ADMIN_KEY.slice(0, 8));
}

/** Seed one published (active/public/github_repo set) dataset + a single
 *  dataset_versions row -- one missing-manifest candidate. */
function seedPublishedDataset(datasetId: string): void {
  db.run(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, github_repo)
     VALUES (?, ?, 1, 'active', 'public', ?)`,
    [datasetId, datasetId, `nemarDatasets/${datasetId}`],
  );
  db.run(
    `INSERT INTO dataset_versions (dataset_id, version, doi, created_at)
     VALUES (?, 'v1.0.0', ?, datetime('now'))`,
    [datasetId, `10.82901/nemar.${datasetId}.v1.0.0`],
  );
}

function env(): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "test",
    S3_BUCKET,
    AWS_REGION,
    AWS_ACCESS_KEY_ID: "test-access-key",
    AWS_SECRET_ACCESS_KEY: "test-secret-key",
    GITHUB_ADMIN_PAT: "test-pat-never-used-on-these-paths",
  } as Bindings;
}

function post(body: unknown): Promise<Response> {
  return app.request(
    "/admin/doctor/fix",
    {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    env(),
  );
}

/** Redirects any `*.amazonaws.com` fetch to a local Bun.serve() instance
 *  for the duration of `fn`. First request to a given path -> 404 (no
 *  manifest -> a missing-manifest finding); every later request to that
 *  SAME path -> 200 (manifest "exists" -> fix()'s own re-check skips
 *  before ever reaching GitHub). Always restores the real `fetch` and
 *  stops the server, even if `fn` throws. */
async function withFakeS3<T>(fn: () => Promise<T>): Promise<T> {
  const hitsByPath = new Map<string, number>();
  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const path = new URL(req.url).pathname;
      const hits = (hitsByPath.get(path) ?? 0) + 1;
      hitsByPath.set(path, hits);
      if (hits === 1) return new Response("not found", { status: 404 });
      return new Response("existing manifest", { status: 200 });
    },
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    if (url.hostname.endsWith("amazonaws.com")) {
      const local = new URL(url.pathname + url.search, `http://127.0.0.1:${server.port}`);
      return realFetch(new Request(local, req));
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
    server.stop(true);
  }
}

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  await seedAdmin();
});

describe("POST /admin/doctor/fix (un-narrowed): the per-invocation cap (#1135)", () => {
  test("with no explicit limit, caps at DOCTOR_FIX_DEFAULT_LIMIT and reports the rest as remaining", async () => {
    const seeded = DOCTOR_FIX_DEFAULT_LIMIT + 5;
    for (let i = 0; i < seeded; i++) {
      seedPublishedDataset(`nm${String(300000 + i).padStart(6, "0")}`);
    }

    await withFakeS3(async () => {
      const res = await post({ check: "missing-manifest" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(seeded);
      expect(body.results.length).toBe(DOCTOR_FIX_DEFAULT_LIMIT);
      expect(body.fixed + body.skipped + body.failed).toBe(DOCTOR_FIX_DEFAULT_LIMIT);
      expect(body.remaining).toBe(seeded - DOCTOR_FIX_DEFAULT_LIMIT);
    });
  });

  test("an explicit limit below the default is honored", async () => {
    for (let i = 0; i < 10; i++) {
      seedPublishedDataset(`nm${String(310000 + i).padStart(6, "0")}`);
    }

    await withFakeS3(async () => {
      const res = await post({ check: "missing-manifest", limit: 3 });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(10);
      expect(body.results.length).toBe(3);
      expect(body.remaining).toBe(7);
    });
  });

  test("a huge explicit limit is clamped to DOCTOR_FIX_MAX_LIMIT, not left unbounded", async () => {
    const seeded = DOCTOR_FIX_MAX_LIMIT + 5;
    for (let i = 0; i < seeded; i++) {
      seedPublishedDataset(`nm${String(320000 + i).padStart(6, "0")}`);
    }

    await withFakeS3(async () => {
      const res = await post({ check: "missing-manifest", limit: 999_999 });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(seeded);
      expect(body.results.length).toBe(DOCTOR_FIX_MAX_LIMIT);
      expect(body.remaining).toBe(seeded - DOCTOR_FIX_MAX_LIMIT);
    });
  });

  test("fewer findings than the limit: no truncation, remaining is 0", async () => {
    for (let i = 0; i < 3; i++) {
      seedPublishedDataset(`nm${String(330000 + i).padStart(6, "0")}`);
    }

    await withFakeS3(async () => {
      const res = await post({ check: "missing-manifest", limit: 25 });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(3);
      expect(body.results.length).toBe(3);
      expect(body.remaining).toBe(0);
    });
  });

  test("?dry_run=true is unaffected by the cap -- it never reaches the fix loop", async () => {
    const seeded = DOCTOR_FIX_DEFAULT_LIMIT + 5;
    for (let i = 0; i < seeded; i++) {
      seedPublishedDataset(`nm${String(340000 + i).padStart(6, "0")}`);
    }

    await withFakeS3(async () => {
      const res = await post({ check: "missing-manifest", dry_run: true });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.dry_run).toBe(true);
      expect(body.would_fix).toBe(seeded);
      expect(body.findings.length).toBe(seeded);
    });
  });
});

describe("POST /admin/doctor/fix (dataset_id-narrowed): unaffected by the cap", () => {
  test("processes every finding for the one dataset regardless of the default limit, remaining always 0", async () => {
    const datasetId = "nm350000";
    db.run(
      `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, github_repo)
       VALUES (?, ?, 1, 'active', 'public', ?)`,
      [datasetId, datasetId, `nemarDatasets/${datasetId}`],
    );
    // Multiple versions of the SAME dataset -- still narrowed by dataset_id.
    for (const version of ["v1.0.0", "v1.0.1", "v1.0.2"]) {
      db.run(
        `INSERT INTO dataset_versions (dataset_id, version, doi, created_at) VALUES (?, ?, ?, datetime('now'))`,
        [datasetId, version, `10.82901/nemar.${datasetId}.${version}`],
      );
    }

    await withFakeS3(async () => {
      const res = await post({ check: "missing-manifest", dataset_id: datasetId });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(3);
      expect(body.results.length).toBe(3);
      expect(body.remaining).toBe(0);
    });
  });
});

describe("POST /admin/doctor/fix: validation unchanged", () => {
  test("missing check -> 400", async () => {
    const res = await post({});
    expect(res.status).toBe(400);
  });

  test("unknown check -> 400", async () => {
    const res = await post({ check: "not-a-real-check" });
    expect(res.status).toBe(400);
  });
});
