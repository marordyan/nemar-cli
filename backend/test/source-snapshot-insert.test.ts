/**
 * The upstream snapshot recorded when a `dataset_versions` row is inserted (epic #1046 phase 2,
 * #1908; ADR 0111, decision 4).
 *
 * Production runs the central manifest flow, so the row that matters is written by the
 * `/webhooks/manifest-ready` callback. It is driven here through the REAL worker with a real HMAC
 * token, real SQLite carrying every migration, and a local HTTP server standing in for the three
 * hosts the flow reaches (the raw content CDN, the GitHub API, S3), which logs every request so a
 * test asserts on what was sent. The admin manifest regeneration path (the other live site) is
 * driven through its real route.
 *
 * The three inline sites (the orchestrator's, the legacy EZID handler's and the Zenodo
 * handler's) are only reachable on the dev flow or not at all, so they are held by a source
 * scan: every INSERT into `dataset_versions` in `backend/src` is the one statement
 * `INSERT_DATASET_VERSION_SQL`, and the scan is proven to fire on a planted violation.
 *
 * What these tests are for, in one line: an insert records a tag only from a description it
 * READ, records `unknown` only for a description that names no single tag, and leaves NULL/NULL
 * whenever it could not read one, without ever failing the callback.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "bun";
import { Hono } from "hono";
import worker from "../src/index";
import { adminMiddleware, authMiddleware } from "../src/middleware/auth";
import { registerDatasetLifecycleRoutes } from "../src/routes/admin/datasets-lifecycle";
import { __resetInstallationTokenCacheForTests } from "../src/services/github-auth";
import { signManifestCallbackToken } from "../src/services/github/callback-tokens";
import { __resetRateLimitStateForTests } from "../src/services/github/transport";
import {
  INSERT_DATASET_VERSION_SQL,
  SNAPSHOT_LOOKUP_DEADLINE_MS,
  columnsFromDescription,
  snapshotColumnsForInsert,
  snapshotFromDescriptionText,
} from "../src/services/source-snapshot";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import { startStandin } from "./helpers/source-snapshot-standin";
import { SRC, createTree, foldedStrings, parse, rel } from "./helpers/ts-scan";

/** The cap on a description, written out so a changed constant cannot move the test with it. */
const ONE_MIB = 1024 * 1024;

const CALLBACK_SECRET = "manifest-callback-secret-0123456789abcdef";
const ADMIN_KEY = "snap-admin-key-0123456789abcdef0123456789abcdef01";
const API = "https://api.nemar.org";
const realFetch = globalThis.fetch;
const quiet = { error: console.error, warn: console.warn, log: console.log };

let standin: ReturnType<typeof startStandin>;
let db: Database;

beforeAll(() => {
  standin = startStandin();
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = standin.base;
});
afterAll(() => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  standin.stop();
});
beforeEach(() => {
  db = freshDb();
  standin.reset();
  // Process-wide state other test files in the same Bun process leave behind: a drained
  // GitHub rate-limit bucket makes the reads fail fast, and a stalled token mint stays cached.
  __resetRateLimitStateForTests();
  __resetInstallationTokenCacheForTests();
  // S3 lives on an amazonaws.com host the code builds itself; send it to the stand-in.
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "api.github.com" && url.pathname.includes("/access_tokens")) {
      // The App token mint (its host is not overridable): stall it on the stand-in.
      return realFetch(`${standin.base}/__token-stall`, { method: "POST" });
    }
    if (url.hostname.endsWith(".amazonaws.com")) {
      const headers = input instanceof Request ? input.headers : new Headers(init?.headers);
      return realFetch(`${standin.base}${url.pathname}`, {
        method: input instanceof Request ? input.method : (init?.method ?? "GET"),
        headers,
        body: input instanceof Request ? undefined : init?.body,
      });
    }
    return realFetch(input, init);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  console.error = quiet.error;
  console.warn = quiet.warn;
  console.log = quiet.log;
});

function env(over: Partial<Bindings> = {}): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "test",
    GITHUB_RAW_BASE: standin.base,
    GITHUB_ADMIN_PAT: "snap-test-pat",
    S3_BUCKET: "nemar",
    AWS_REGION: "us-east-2",
    AWS_ACCESS_KEY_ID: "AKIATEST",
    AWS_SECRET_ACCESS_KEY: "secret",
    MANIFEST_CALLBACK_SECRET: CALLBACK_SECRET,
    ...over,
  } as Bindings;
}

function seedDataset(id: string): void {
  db.query(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, github_repo, concept_doi, visibility)
     VALUES (?, ?, -1, ?, ?, 'public')`,
  ).run(id, `Dataset ${id}`, `nemarDatasets/${id}`, `10.82901/nemar.${id}`);
}

async function seedManifestJob(id: string, version: string, nonce: string): Promise<string> {
  db.query(
    `INSERT INTO manifest_jobs (dataset_id, version, nonce, doi, concept_doi, doi_provider, status, request_source)
     VALUES (?, ?, ?, ?, ?, 'ezid', 'dispatched', 'webhook')`,
  ).run(id, version, nonce, `10.82901/nemar.${id}.v${version}`, `10.82901/nemar.${id}`);
  return signManifestCallbackToken({ datasetId: id, version, nonce }, CALLBACK_SECRET);
}

function manifestReady(token: string, id: string, version: string, bindings: Bindings) {
  const work: Promise<unknown>[] = [];
  const response = worker.fetch(
    new Request(`${API}/webhooks/manifest-ready`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Webhook-Token": token },
      body: JSON.stringify({
        dataset_id: id,
        version,
        manifest_url: "https://example.invalid/m.json",
        summary_url: "https://example.invalid/s.json",
        totals: { files: 1, bytes: 1, annex: 0, git: 1 },
        workflow_run_id: "1",
      }),
    }),
    bindings,
    {
      waitUntil: (p: Promise<unknown>) => {
        work.push(p);
      },
      passThroughOnException: () => {},
    } as unknown as ExecutionContext,
  );
  return { response, settle: () => Promise.all(work) };
}

function snapshotOf(id: string, version: string) {
  return db
    .query<
      { source_version: string | null; source_version_basis: string | null },
      [string, string]
    >(
      "SELECT source_version, source_version_basis FROM dataset_versions WHERE dataset_id = ? AND version = ?",
    )
    .get(id, version);
}

const NOT_EXAMINED = { source_version: null, source_version_basis: null };

/** Run the callback to completion for a new `on` dataset and answer the stored snapshot. */
async function publish(id: string, bindings: Bindings = env()) {
  seedDataset(id);
  const token = await seedManifestJob(id, "1.0.0", `nonce-${id}`);
  const { response, settle } = manifestReady(token, id, "1.0.0", bindings);
  const res = await response;
  await settle();
  return { res, snapshot: snapshotOf(id, "1.0.0") };
}

// ----------------------------------------------------------------------------
// Site A: the manifest-ready callback, through the real worker
// ----------------------------------------------------------------------------

describe("the manifest-ready callback records the snapshot it reads", () => {
  test("a description whose own entry names a DOI gives that tag, basis doi", async () => {
    standin.describe("on000020", "1.0.0", {
      Name: "x",
      BIDSVersion: "1.9.0",
      Version: "1.0.0",
      SourceDatasets: [{ DOI: "doi:10.18112/openneuro.ds000020.v2.0.2" }],
    });
    const { res, snapshot } = await publish("on000020");
    expect(res.status).toBe(200);
    expect(snapshot).toEqual({ source_version: "2.0.2", source_version_basis: "doi" });
  });

  test("the read goes to the dataset's tagged file with the token, and only there", async () => {
    standin.describe("on000021", "1.0.0", {
      SourceDatasets: [{ DOI: "10.18112/openneuro.ds000021.v1.0.1" }],
    });
    await publish("on000021");
    const raw = standin.rawRequests();
    expect(raw).toHaveLength(1);
    expect(raw[0]).toMatchObject({
      method: "GET",
      path: "/nemarDatasets/on000021/v1.0.0/dataset_description.json",
      authorization: "Bearer snap-test-pat",
      userAgent: "NEMAR-API",
    });
  });

  test("an entry that disagrees with itself is unknown: examined, no tag", async () => {
    standin.describe("on000022", "1.0.0", {
      SourceDatasets: [{ DOI: "10.18112/openneuro.ds000022.v2.0.2", Version: "2.0.1" }],
    });
    const { res, snapshot } = await publish("on000022");
    expect(res.status).toBe(200);
    expect(snapshot).toEqual({ source_version: null, source_version_basis: "unknown" });
  });

  test("a description that names no upstream at all is unknown, and NEMAR's own Version is not read", async () => {
    standin.describe("on000023", "1.0.0", { Name: "x", Version: "1.0.0", BIDSVersion: "1.9.0" });
    const { snapshot } = await publish("on000023");
    expect(snapshot).toEqual({ source_version: null, source_version_basis: "unknown" });
  });

  test("a description that is not JSON is unknown", async () => {
    standin.describe("on000024", "1.0.0", "<<not json>>");
    const { res, snapshot } = await publish("on000024");
    expect(res.status).toBe(200);
    expect(snapshot).toEqual({ source_version: null, source_version_basis: "unknown" });
  });

  test("a raw host that answers 500 leaves NULL/NULL and the callback still succeeds", async () => {
    standin.describe("on000025", "1.0.0", "boom", 500);
    const { res, snapshot } = await publish("on000025");
    expect(res.status).toBe(200);
    expect(snapshot).toEqual(NOT_EXAMINED);
  });

  test("a 404 right after the tag is NOT examined: the insert never turns absent into unknown", async () => {
    const { res, snapshot } = await publish("on000026");
    expect(res.status).toBe(200);
    expect(snapshot).toEqual(NOT_EXAMINED);
    expect(standin.rawRequests()).toHaveLength(1);
  });

  test("a raw host that cannot be reached leaves NULL/NULL and the callback still succeeds", async () => {
    const { res, snapshot } = await publish(
      "on000027",
      env({ GITHUB_RAW_BASE: "http://127.0.0.1:1" }),
    );
    expect(res.status).toBe(200);
    expect(snapshot).toEqual(NOT_EXAMINED);
  });

  test("no GitHub credential at all leaves NULL/NULL, makes no raw request and succeeds", async () => {
    standin.describe("on000028", "1.0.0", {
      SourceDatasets: [{ DOI: "10.18112/openneuro.ds000028.v1.0.0" }],
    });
    const { res, snapshot } = await publish("on000028", env({ GITHUB_ADMIN_PAT: undefined }));
    expect(res.status).toBe(200);
    expect(snapshot).toEqual(NOT_EXAMINED);
    expect(standin.rawRequests()).toHaveLength(0);
  });

  test("a raw host that hangs is cut off at the fetch timeout and the callback still succeeds", async () => {
    standin.setHang(true);
    const started = Date.now();
    const { res, snapshot } = await publish("on000029");
    expect(res.status).toBe(200);
    expect(snapshot).toEqual(NOT_EXAMINED);
    expect(Date.now() - started).toBeLessThan(5500);
  }, 10_000);

  test("a dataset that is not an on###### mirror makes no raw request and stays NULL/NULL", async () => {
    standin.describe("nm000500", "1.0.0", {
      SourceDatasets: [{ DOI: "10.18112/openneuro.ds000500.v1.0.0" }],
    });
    const { res, snapshot } = await publish("nm000500");
    expect(res.status).toBe(200);
    expect(snapshot).toEqual(NOT_EXAMINED);
    expect(standin.rawRequests()).toHaveLength(0);
  });

  test("the failed-insert contract is unchanged: a DB failure still answers 500 and leaves the job dispatched", async () => {
    standin.describe("on000030", "1.0.0", {
      SourceDatasets: [{ DOI: "10.18112/openneuro.ds000030.v1.0.0" }],
    });
    seedDataset("on000030");
    const token = await seedManifestJob("on000030", "1.0.0", "nonce-30");
    // Remove the table the INSERT writes, so the statement itself fails.
    db.exec("DROP TABLE dataset_versions");
    const { response } = manifestReady(token, "on000030", "1.0.0", env());
    const res = await response;
    expect(res.status).toBe(500);
    expect(
      db.query("SELECT status FROM manifest_jobs WHERE dataset_id = 'on000030'").get(),
    ).toEqual({ status: "dispatched" });
  });
});

// ----------------------------------------------------------------------------
// Site B: admin manifest regeneration, through its real route
// ----------------------------------------------------------------------------

describe("admin manifest regeneration records the snapshot when it repairs a stranded row", () => {
  type App = Hono<{ Bindings: Bindings; Variables: Variables }>;

  async function adminApp(): Promise<App> {
    db.run(
      `INSERT INTO users (username, email, password_hash, status, role, email_verified)
       VALUES ('snapadmin', 'snapadmin@example.org', 'x', 'approved', 'admin', 1)`,
    );
    const admin = db
      .query<{ id: number }, []>("SELECT id FROM users WHERE username='snapadmin'")
      .get();
    db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
      admin?.id ?? 0,
      await hashApiKey(ADMIN_KEY),
      ADMIN_KEY.slice(0, 8),
    );
    const app: App = new Hono();
    app.use("*", authMiddleware);
    app.use("*", adminMiddleware);
    registerDatasetLifecycleRoutes(app);
    return app;
  }

  async function regenerate(id: string) {
    seedDataset(id);
    const app = await adminApp();
    const res = await app.request(
      `/datasets/${id}/manifest/1.0.0`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ doi: `10.82901/nemar.${id}.v1.0.0` }),
      },
      env(),
    );
    return { res, snapshot: snapshotOf(id, "1.0.0") };
  }

  test("a readable description gives its tag", async () => {
    standin.describe("on000040", "1.0.0", {
      SourceDatasets: [{ URL: "https://openneuro.org/datasets/ds000040/versions/1.2.3" }],
    });
    const { res, snapshot } = await regenerate("on000040");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ dataset_versions_backfilled: true });
    expect(snapshot).toEqual({ source_version: "1.2.3", source_version_basis: "doi" });
  });

  test("an unreadable description leaves NULL/NULL and still repairs the row", async () => {
    standin.describe("on000041", "1.0.0", "boom", 500);
    const { res, snapshot } = await regenerate("on000041");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ dataset_versions_backfilled: true });
    expect(snapshot).toEqual(NOT_EXAMINED);
  });

  test("it reads with the token the route already holds, from the repository the route resolved", async () => {
    standin.describe("on000042", "1.0.0", {
      SourceDatasets: [{ DOI: "10.18112/openneuro.ds000042.v1.0.0" }],
    });
    await regenerate("on000042");
    expect(standin.rawRequests()[0]).toMatchObject({
      path: "/nemarDatasets/on000042/v1.0.0/dataset_description.json",
      authorization: "Bearer snap-test-pat",
    });
  });
});

// ----------------------------------------------------------------------------
// The read itself: ref shape, byte order mark, size cap, warnings, deadline
// ----------------------------------------------------------------------------

describe("the tagged read", () => {
  const tagged = (id: string, tag: string) => ({
    SourceDatasets: [{ DOI: `10.18112/openneuro.ds${id.slice(2)}.v${tag}` }],
  });

  test("a stored version that already carries the v reads v1.0.0, never vv1.0.0", async () => {
    standin.describe("on000070", "1.0.0", tagged("on000070", "4.0.0"));
    const columns = await snapshotColumnsForInsert(env(), "on000070", "v1.0.0");
    expect(columns).toEqual({ source_version: "4.0.0", source_version_basis: "doi" });
    expect(standin.rawRequests().map((r) => r.path)).toEqual([
      "/nemarDatasets/on000070/v1.0.0/dataset_description.json",
    ]);
  });

  test("a description with a byte order mark is read, not called unparseable", () => {
    const text = `\uFEFF${JSON.stringify(tagged("on000071", "2.1.0"))}`;
    expect(snapshotFromDescriptionText("ds000071", text)).toEqual({
      columns: { source_version: "2.1.0", source_version_basis: "doi" },
      unparseable: false,
    });
  });

  /** A valid description of exactly `bytes` bytes. */
  const descriptionOfSize = (id: string, bytes: number) => {
    const base = JSON.stringify({ ...tagged(id, "2.1.0"), P: "" });
    return JSON.stringify({ ...tagged(id, "2.1.0"), P: "x".repeat(bytes - base.length) });
  };

  for (const chunked of [false, true]) {
    const how = chunked ? "streamed without a length" : "with a declared length";

    test(`a body one byte over the cap, ${how}, is a read error, not a verdict: NULL/NULL`, async () => {
      const id = chunked ? "on000077" : "on000072";
      const body = descriptionOfSize(id, ONE_MIB + 1);
      expect(new TextEncoder().encode(body).length).toBe(ONE_MIB + 1);
      standin.describe(id, "1.0.0", body, 200, chunked);
      const warnings: string[] = [];
      console.warn = (...args: unknown[]) => {
        warnings.push(args.join(" "));
      };
      const { res, snapshot } = await publish(id);
      expect(res.status).toBe(200);
      expect(snapshot).toEqual(NOT_EXAMINED);
      expect(warnings.some((w) => w.includes(`${id}@1.0.0`) && w.includes("over"))).toBe(true);
    });

    test(`a body of exactly the cap, ${how}, is read`, async () => {
      const id = chunked ? "on000078" : "on000073";
      const body = descriptionOfSize(id, ONE_MIB);
      expect(new TextEncoder().encode(body).length).toBe(ONE_MIB);
      standin.describe(id, "1.0.0", body, 200, chunked);
      const { snapshot } = await publish(id);
      expect(snapshot).toEqual({ source_version: "2.1.0", source_version_basis: "doi" });
    });
  }

  test("an absent file and a failed read each leave a warning naming the dataset and version", async () => {
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.join(" "));
    };
    await publish("on000074"); // 404
    standin.describe("on000075", "1.0.0", "boom", 500);
    await publish("on000075");
    expect(warnings.some((w) => w.includes("on000074@1.0.0") && w.includes("absent"))).toBe(true);
    expect(warnings.some((w) => w.includes("on000075@1.0.0") && w.includes("500"))).toBe(true);
    // No secret is logged.
    expect(warnings.join("\n")).not.toContain("snap-test-pat");
  });

  test("a token mint that stalls is cut off at the deadline: NULL/NULL, a 200, in about five seconds", async () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    standin.describe("on000076", "1.0.0", tagged("on000076", "2.1.0"));
    const bindings = env({
      GITHUB_ADMIN_PAT: undefined,
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: privateKey,
      // Its own installation id: the token cache is per process, and a stalled mint stays cached.
      GITHUB_APP_INSTALLATION_ID_NEMAR_DATASETS: "7600076",
    });
    seedDataset("on000076");
    const token = await seedManifestJob("on000076", "1.0.0", "nonce-76");
    const started = Date.now();
    // Not settled: the metadata refresh the callback starts in the background uses the same
    // stalled mint, and is not what is being timed.
    const res = await manifestReady(token, "on000076", "1.0.0", bindings).response;
    const elapsed = Date.now() - started;
    const snapshot = snapshotOf("on000076", "1.0.0");
    expect(res.status).toBe(200);
    expect(snapshot).toEqual(NOT_EXAMINED);
    expect(elapsed).toBeGreaterThanOrEqual(SNAPSHOT_LOOKUP_DEADLINE_MS - 200);
    expect(elapsed).toBeLessThan(SNAPSHOT_LOOKUP_DEADLINE_MS + 500);
    expect(standin.rawRequests()).toHaveLength(0);
  }, 15_000);
});

// ----------------------------------------------------------------------------
// The statement and the inline sites
// ----------------------------------------------------------------------------

describe("INSERT_DATASET_VERSION_SQL", () => {
  test("round-trips both columns on real SQLite and does not overwrite an existing row", () => {
    seedDataset("on000050");
    const insert = (tag: string | null, basis: string | null) =>
      db
        .prepare(INSERT_DATASET_VERSION_SQL)
        .run("on000050", "1.0.0", "10.82901/x", "ezid", tag, basis);
    insert("2.0.2", "doi");
    expect(snapshotOf("on000050", "1.0.0")).toEqual({
      source_version: "2.0.2",
      source_version_basis: "doi",
    });
    // A replayed insert for the same version is a silent no-op, in particular not NULL/NULL.
    expect(() => insert(null, null)).not.toThrow();
    expect(snapshotOf("on000050", "1.0.0")).toEqual({
      source_version: "2.0.2",
      source_version_basis: "doi",
    });
  });

  test("an inconsistent snapshot pair raises and drops no row silently", () => {
    seedDataset("on000051");
    const insert = (tag: string | null, basis: string | null) =>
      db
        .prepare(INSERT_DATASET_VERSION_SQL)
        .run("on000051", "1.0.0", "10.82901/y", "ezid", tag, basis);
    for (const [tag, basis] of [
      ["2.0.2", null],
      ["2.0.2", "unknown"],
      [null, "doi"],
      ["2.0.2", "guess"],
    ] as const) {
      expect(() => insert(tag, basis)).toThrow(/CHECK constraint failed/);
    }
    expect(snapshotOf("on000051")).toBeNull();
  });

  test("the callback answers 500 and leaves the job dispatched when the row is refused", async () => {
    // Make the insert's CHECK refuse every row, as an inconsistent pair would.
    db.exec("DROP TABLE dataset_versions");
    db.exec(
      `CREATE TABLE dataset_versions (
         id INTEGER PRIMARY KEY AUTOINCREMENT, dataset_id TEXT NOT NULL, version TEXT NOT NULL,
         doi TEXT NOT NULL, provider TEXT NOT NULL DEFAULT 'ezid',
         source_version TEXT, source_version_basis TEXT CHECK (source_version_basis = 'never'),
         UNIQUE (dataset_id, version))`,
    );
    standin.describe("on000052", "1.0.0", {
      SourceDatasets: [{ DOI: "10.18112/openneuro.ds000052.v1.0.0" }],
    });
    seedDataset("on000052");
    const token = await seedManifestJob("on000052", "1.0.0", "nonce-52");
    const { response } = manifestReady(token, "on000052", "1.0.0", env());
    expect((await response).status).toBe(500);
    expect(
      db.query("SELECT status FROM manifest_jobs WHERE dataset_id = 'on000052'").get(),
    ).toEqual({ status: "dispatched" });
  });
});

describe("columnsFromDescription (the inline sites)", () => {
  const withTag = {
    Name: "x",
    BIDSVersion: "1.9.0",
    SourceDatasets: [{ DOI: "10.18112/openneuro.ds000060.v3.1.0" }],
  };

  test("a description that was read gives its tag, or unknown when it names none", () => {
    expect(columnsFromDescription("on000060", withTag, [])).toEqual({
      source_version: "3.1.0",
      source_version_basis: "doi",
    });
    expect(columnsFromDescription("on000060", { Name: "x", BIDSVersion: "1.9.0" }, [])).toEqual({
      source_version: null,
      source_version_basis: "unknown",
    });
  });

  test("a failed read (the readRepoMetadata warning) is not examined, whatever it returned", () => {
    expect(
      columnsFromDescription("on000060", withTag, [
        "BIDS metadata unavailable: HTTP 502. DOI minted with minimal metadata.",
      ]),
    ).toEqual(NOT_EXAMINED);
  });

  test("the { Name } fallback of an absent file is not examined", () => {
    expect(columnsFromDescription("on000060", { Name: "fallback" }, [])).toEqual(NOT_EXAMINED);
    expect(columnsFromDescription("on000060", {}, [])).toEqual(NOT_EXAMINED);
  });

  test("a dataset that is not an on###### mirror is not examined", () => {
    expect(columnsFromDescription("nm000060", withTag, [])).toEqual(NOT_EXAMINED);
    expect(columnsFromDescription("xx000060", withTag, [])).toEqual(NOT_EXAMINED);
  });
});

describe("snapshotColumnsForInsert never throws", () => {
  test("a token that cannot be minted is NULL/NULL", async () => {
    const bindings = env({ GITHUB_ADMIN_PAT: undefined });
    console.warn = () => {};
    expect(await snapshotColumnsForInsert(bindings, "on000070", "1.0.0")).toEqual(NOT_EXAMINED);
  });
});

describe("every INSERT into dataset_versions is the one statement", () => {
  const INSERT_RE = /\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+dataset_versions\b/i;

  function offenders(tree = createTree()): string[] {
    const found: string[] = [];
    for (const file of tree.walk(SRC)) {
      if (file.endsWith("services/source-snapshot.ts")) continue;
      const sf = parse(tree, file);
      if (foldedStrings(sf).some((s) => INSERT_RE.test(s))) found.push(rel(file));
    }
    return found;
  }

  test("nothing in backend/src writes dataset_versions outside services/source-snapshot.ts", () => {
    expect(offenders()).toEqual([]);
  });

  test("the scan fires on a planted INSERT, including one split across a concatenation", () => {
    const planted = createTree({
      "services/planted.ts":
        'export const SQL = "INSERT INTO dataset_versions (dataset_id) VALUES (?)";',
      "services/planted-split.ts":
        'export const SQL = "INSERT INTO " + "dataset_versions (dataset_id) VALUES (?)";',
    });
    expect(offenders(planted).sort()).toEqual([
      expect.stringContaining("planted-split.ts"),
      expect.stringContaining("planted.ts"),
    ]);
  }, 60_000);

  test("exactly five prepare() calls bind the shared statement, in the files that hold the sites", () => {
    // A source count, not a behavior test: A and B and the legacy handler (D) are driven above,
    // the orchestrator (C) and the Zenodo handler (E) are not reachable in a test, so this pins
    // where their statements are. A sixth site, or one fewer, fails here.
    const perFile: Record<string, number> = {
      "routes/callbacks/manifest.ts": 1,
      "routes/admin/datasets-lifecycle.ts": 1,
      "services/publication-orchestrator.ts": 1,
      "routes/callbacks/version-doi.ts": 2,
    };
    const tree = createTree();
    const found: Record<string, number> = {};
    for (const file of tree.walk(SRC)) {
      const n = (
        readFileSync(file, "utf8").match(/\.prepare\(\s*INSERT_DATASET_VERSION_SQL\s*\)/g) ?? []
      ).length;
      if (n > 0) found[rel(file)] = n;
    }
    const expected = Object.fromEntries(
      Object.entries(perFile).map(([f, n]) => [rel(join(SRC, f)), n]),
    );
    expect(found).toEqual(expected);
  }, 60_000);
});
