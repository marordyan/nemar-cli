/**
 * The daily merge cap, the claim to merge, and the facts only GitHub and the version row can state
 * (epic #1046 phase 6, #1912; ADR 0111, decisions 2, 3, 4 and 6), through their real entry points:
 * the transition route's gates and claim edges, `POST /admin/repulls/:id/merge-claim/release`,
 * `.../merged` and `.../released`.
 *
 * Real engine only: bun:sqlite behind realD1 with every migration applied, the real auth and admin
 * middleware, the real routes and services, and the shared `Bun.serve()` stand-in for
 * api.github.com (`helpers/repull-github-standin.ts`) that answers the reads the Worker makes (the
 * live pull request, a tag's commit, a comparison) and records each request. The cap's UTC day is
 * D1's own clock, so the day's edges are claims seeded at times computed by SQLite, never a mocked
 * clock. Writes that race are staged by running the competing write just before the Worker
 * prepares its own UPDATE, because the D1 stand-in runs statements one at a time.
 *
 * The properties, each with a test that fails when its line is changed:
 *  - every claim, N.0.0's and N.0.1's alike, takes one unit of the day's cap; a refusal writes
 *    nothing; a claim landing between the read and the write takes the last unit; an unreadable
 *    cap reads 0;
 *  - the gates and the claim need GitHub's live head to be the sha they name, on an open pull
 *    request from and into `nemarDatasets/<dataset_id>` (a fork's head or base is refused, the
 *    name compared without case); the claim's statement also holds the screen, the cap and two
 *    dataset fences;
 *  - a claim is released only after five minutes, only when GitHub says the pull request did not
 *    merge, and never for an unknown outcome;
 *  - `merged` is written from GitHub's answer; a merge with no claim held and one at a head other
 *    than the screened one are each counted on their own, never hidden; a retry is answered from
 *    the stored row;
 *  - `released` needs the version row with a DOI and a tag on a commit that contains the merge;
 *    it writes N.0.0's lineage only when the caller verified the tree, and re-arms the four sweep
 *    stamps of that dataset only, in the same batch, and only when the transition applies.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { parseScreenReport } from "../../shared/identifier-screen-report";
import type { RepullStatus } from "../../shared/repull-state";
import { adminMiddleware, authMiddleware } from "../src/middleware/auth";
import { registerUpstreamRepullRoutes } from "../src/routes/admin/upstream-repulls";
import {
  __resetRateLimitStateForTests,
  __seedRateLimitStateForTests,
} from "../src/services/github/transport";
import {
  REPULL_CAP_MAX,
  REPULL_MERGE_CAP_DEFAULT,
  readCap,
  repullMergeCap,
} from "../src/services/repull-switches";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import {
  type PullAnswer,
  type RepullGitHub,
  STANDIN_MERGE_SHA,
  startRepullGitHub,
} from "./helpers/repull-github-standin";
import { type Row, rowAt } from "./helpers/repull-rows";
import { type CapturedEmail, withFakeResend } from "./helpers/resend";
import { insideOneUtcDay } from "./helpers/utc-day";

const ADMIN_KEY = "rpm-admin-key-0123456789abcdef0123456789abcdef012";
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const OTHER = "89abcdef0123456789abcdef0123456789abcdef";
const MERGE = STANDIN_MERGE_SHA;
const TAG = "2222222222222222222222222222222222222222";

// biome-ignore lint/suspicious/noExplicitAny: a response body read field by field in assertions
type Json = Record<string, any>;

let gh: RepullGitHub;
let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let adminId = 0;
let mail: CapturedEmail[] = [];
let releaseMail: (() => void) | null = null;
let mailDone: Promise<void> | null = null;

beforeAll(() => {
  gh = startRepullGitHub({ defaultHead: HEAD });
});

afterAll(() => gh.stop());

beforeEach(async () => {
  db = freshDb();
  // The day caps count a UTC day on the database's clock, and no claim takes a clock.
  await insideOneUtcDay(db);
  app = new Hono();
  app.use("*", authMiddleware);
  app.use("*", adminMiddleware);
  registerUpstreamRepullRoutes(app);
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES ('rpmadmin', 'rpmadmin@example.org', 'x', 'approved', 'admin', 1)`,
  );
  adminId = (db.query("SELECT id FROM users WHERE username = 'rpmadmin'").get() as Row)
    .id as number;
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    adminId,
    await hashApiKey(ADMIN_KEY),
    ADMIN_KEY.slice(0, 8),
  );
  await new Promise<void>((armed) => {
    mailDone = withFakeResend(
      (calls) =>
        new Promise<void>((done) => {
          mail = calls;
          releaseMail = done;
          armed();
        }),
    );
  });
});

afterEach(async () => {
  releaseMail?.();
  await mailDone;
  expect(mail).toEqual([]);
  gh.reset();
  __resetRateLimitStateForTests();
});

function env(over: Partial<Bindings> = {}): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "production",
    GITHUB_ADMIN_PAT: "ghp_repull_merge_test",
    RESEND_API_KEY: "re_test",
    FROM_EMAIL: "NEMAR <noreply@nemar.org>",
    ...over,
  } as Bindings;
}

async function call(
  path: string,
  body?: unknown,
  o: { env?: Partial<Bindings>; db?: D1Database } = {},
) {
  const res = await app.request(
    path,
    body === undefined
      ? { headers: { Authorization: `Bearer ${ADMIN_KEY}` } }
      : {
          method: "POST",
          headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
    { ...env(o.env), ...(o.db ? { DB: o.db } : {}) },
  );
  return { status: res.status, body: (await res.json()) as Json };
}

/** A D1 that runs `action` once, just before the Worker prepares the statement starting `prefix`. */
function racing(prefix: string, action: () => void): D1Database {
  const real = realD1(db);
  let done = false;
  return {
    ...real,
    prepare(sql: string) {
      if (!done && sql.startsWith(prefix)) {
        done = true;
        action();
      }
      return real.prepare(sql);
    },
    batch: real.batch.bind(real),
  } as unknown as D1Database;
}

function seedMirror(id: string, o: { anonymous?: boolean; stamps?: Record<string, string> } = {}) {
  db.run(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, source, source_id, anonymous, sweep_stamps)
     VALUES (?, ?, ?, 'openneuro', 'ds099999', ?, ?)`,
    [id, id, adminId, o.anonymous ? 1 : 0, o.stamps ? JSON.stringify(o.stamps) : null],
  );
}

function seedRepull(status: RepullStatus, over: Row = {}): number {
  const row = rowAt(status, {
    dataset_id: "on099999",
    upstream_ds: "ds099999",
    actor_user_id: adminId,
    head_sha: HEAD,
    ...(status === "gates_clear" ? { gates_sha: HEAD } : {}),
    ...over,
  });
  const cols = Object.keys(row);
  return Number(
    db
      .query(
        `INSERT INTO upstream_repulls (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
      )
      .run(...(cols.map((c) => row[c]) as never[])).lastInsertRowid,
  );
}

/** A stored screen verdict of `sha`, as the callback leaves it. */
function markScreen(repullId: number, status: string, o: { pr?: string; sha?: string } = {}) {
  const sha = o.sha ?? HEAD;
  const report = parseScreenReport({
    version: 1,
    scanner: "identifier-scan@abcdef1",
    head: sha,
    scan: {
      id: "on099999",
      version: null,
      scanned_at: "2026-10-24T12:00:00.000Z",
      manifest_source: "clone",
      status,
      incomplete: false,
      incomplete_reasons: [],
      files: { total: 10, edf_bdf: 4, header_read: 4, header_read_failed: 0 },
    },
  });
  db.run(
    `INSERT INTO upstream_repull_screens (repull_id, pr, sha, status, report, reported_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    [repullId, o.pr ?? "n0", sha, status, JSON.stringify(report)],
  );
}

/** A mirror with a gates_clear row and a clear screen of its head: ready to claim. */
function ready(datasetId = "on099999", status: RepullStatus = "gates_clear"): number {
  if (!db.query("SELECT 1 FROM datasets WHERE dataset_id = ?").get(datasetId)) {
    seedMirror(datasetId);
  }
  const patch = status === "patch_gates_clear";
  const id = seedRepull(status, {
    dataset_id: datasetId,
    ...(patch ? { patch_head_sha: HEAD, patch_gates_sha: HEAD } : {}),
  });
  markScreen(id, "clean", { pr: patch ? "n1" : "n0" });
  return id;
}

const CLAIM_BODY = { from: "gates_clear", to: "gates_clear", fields: { merge_claim_sha: HEAD } };

const claim = (id: number, o: Parameters<typeof call>[2] = {}) =>
  call(`/repulls/${id}/transition`, CLAIM_BODY, o);

const patchClaim = (id: number, o: Parameters<typeof call>[2] = {}) =>
  call(
    `/repulls/${id}/transition`,
    {
      from: "patch_gates_clear",
      to: "patch_gates_clear",
      fields: { patch_merge_claim_sha: HEAD },
    },
    o,
  );

/** Put a claim on `id` at a time SQLite computes from `when` (a datetime() modifier list). */
function claimAt(id: number, when: string, column = "merge_claimed_at") {
  const sha = column === "merge_claimed_at" ? "merge_claim_sha" : "patch_merge_claim_sha";
  db.run(`UPDATE upstream_repulls SET ${column} = datetime(${when}), ${sha} = ? WHERE id = ?`, [
    HEAD,
    id,
  ]);
}

const rowOf = (id: number) =>
  db.query("SELECT * FROM upstream_repulls WHERE id = ?").get(id) as Row;

/** The id of a dataset's one re-pull row. */
const rowsOf = (datasetId: string) =>
  (db.query("SELECT id FROM upstream_repulls WHERE dataset_id = ?").get(datasetId) as Row)
    .id as number;

const auditCount = () =>
  (db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'repull_%'").get() as Row).n;

// ----------------------------------------------------------------------------
// The cap's reading
// ----------------------------------------------------------------------------

describe("REPULL_DAILY_MERGE_CAP", () => {
  test("absent takes the default; one or two digits up to the maximum are read; anything else is 0", () => {
    expect(readCap(undefined, REPULL_MERGE_CAP_DEFAULT)).toEqual({
      value: 5,
      source: "default",
    });
    expect(REPULL_MERGE_CAP_DEFAULT).toBe(5);
    for (const [raw, value] of [
      ["0", 0],
      ["1", 1],
      ["5", 5],
      [String(REPULL_CAP_MAX), REPULL_CAP_MAX],
    ] as const) {
      expect([raw, readCap(raw, 5)]).toEqual([raw, { value, source: "set" }]);
    }
    for (const raw of [
      String(REPULL_CAP_MAX + 1),
      "100",
      "2.5",
      "-1",
      "",
      " 2",
      "2 ",
      "x",
      "1e1",
    ]) {
      expect([raw, readCap(raw, 5)]).toEqual([raw, { value: 0, source: "unreadable" }]);
    }
    expect(repullMergeCap({ REPULL_DAILY_MERGE_CAP: "3" })).toEqual({ value: 3, source: "set" });
  });
});

// ----------------------------------------------------------------------------
// The claim
// ----------------------------------------------------------------------------

describe("the claim takes a unit of the day's cap", () => {
  const capped = (n: string) => ({ env: { REPULL_DAILY_MERGE_CAP: n } });

  test("with a cap of 1 the second claim of the UTC day is refused, and writes nothing", async () => {
    const a = ready("on099999");
    const b = ready("on099998");
    expect((await claim(a, capped("1"))).status).toBe(200);
    const before = rowOf(b);
    const audits = auditCount();
    const refused = await claim(b, capped("1"));
    expect([refused.status, refused.body.code]).toEqual([429, "merge-cap"]);
    expect(refused.body.merge_cap).toEqual({ value: 1, source: "set", used: 1 });
    expect(rowOf(b)).toEqual(before);
    expect(auditCount()).toBe(audits);
  });

  test("the day is the UTC day: a claim one second before midnight does not count, one at midnight does", async () => {
    const earlier = ready("on099997");
    const a = ready("on099998");
    const b = ready("on099999");
    claimAt(earlier, "'now', 'start of day', '-1 second'");
    expect((await claim(a, capped("1"))).status).toBe(200);
    db.run(
      "UPDATE upstream_repulls SET merge_claimed_at = NULL, merge_claim_sha = NULL WHERE id = ?",
      [a],
    );
    claimAt(earlier, "'now', 'start of day'");
    expect((await claim(b, capped("1"))).body.code).toBe("merge-cap");
  });

  test("N.0.1's claims keep the same day", async () => {
    const patch = ready("on099998", "patch_gates_clear");
    const n0 = ready("on099999");
    claimAt(patch, "'now', 'start of day', '-1 second'", "patch_merge_claimed_at");
    expect((await claim(n0, capped("1"))).status).toBe(200);
    db.run("UPDATE upstream_repulls SET merge_claimed_at = NULL, merge_claim_sha = NULL");
    claimAt(patch, "'now', 'start of day'", "patch_merge_claimed_at");
    expect((await claim(n0, capped("1"))).body.code).toBe("merge-cap");
  });

  test("an N.0.1 claim takes a unit too, and an N.0.0 claim takes N.0.1's", async () => {
    const patch = ready("on099998", "patch_gates_clear");
    const n0 = ready("on099999");
    expect((await patchClaim(patch, capped("1"))).status).toBe(200);
    expect((await claim(n0, capped("1"))).body.code).toBe("merge-cap");
    db.run(
      "UPDATE upstream_repulls SET patch_merge_claimed_at = NULL, patch_merge_claim_sha = NULL",
    );
    expect((await claim(n0, capped("1"))).status).toBe(200);
    expect((await patchClaim(patch, capped("1"))).body.code).toBe("merge-cap");
  });

  test("the cap is the number of claims: two of two pass, the third does not", async () => {
    const ids = [ready("on099997"), ready("on099998"), ready("on099999")];
    expect((await claim(ids[0] as number, capped("2"))).status).toBe(200);
    expect((await claim(ids[1] as number, capped("2"))).status).toBe(200);
    const third = await claim(ids[2] as number, capped("2"));
    expect([third.status, third.body.code, third.body.merge_cap.used]).toEqual([
      429,
      "merge-cap",
      2,
    ]);
  });

  test("a claim that lands between the read and the write takes the last unit", async () => {
    const used = ready("on099997");
    const competing = ready("on099998");
    const mine = ready("on099999");
    expect((await claim(used, capped("2"))).status).toBe(200);
    const res = await claim(mine, {
      ...capped("2"),
      db: racing("UPDATE upstream_repulls SET", () => claimAt(competing, "'now'")),
    });
    expect([res.status, res.body.code]).toEqual([429, "merge-cap"]);
    expect(rowOf(mine).merge_claimed_at).toBeNull();
    expect(rowOf(competing).merge_claim_sha).toBe(HEAD);
  });

  test("absent, the cap is 5; set to 0, or set but unreadable, nothing is claimed", async () => {
    const ids = ["on099990", "on099991", "on099992", "on099993", "on099994", "on099995"].map((d) =>
      ready(d),
    );
    for (const id of ids.slice(0, 5)) expect((await claim(id)).status).toBe(200);
    expect((await claim(ids[5] as number)).body.code).toBe("merge-cap");

    const fresh = ready("on099999");
    const zero = await claim(fresh, capped("0"));
    expect([zero.status, zero.body.code]).toEqual([429, "merge-cap"]);
    for (const raw of ["x", "21", ""]) {
      const res = await claim(fresh, capped(raw));
      expect([raw, res.status, res.body.code, res.body.merge_cap?.source]).toEqual([
        raw,
        429,
        "merge-cap-unreadable",
        "unreadable",
      ]);
    }
    expect(rowOf(fresh).merge_claimed_at).toBeNull();
  });

  test("a claim needs the screen to pass for the claimed head, and the dataset fences", async () => {
    seedMirror("on099999");
    const id = seedRepull("gates_clear");
    const none = await claim(id);
    expect([none.status, none.body.code]).toEqual([409, "screen-not-clear"]);
    markScreen(id, "review");
    expect((await claim(id)).body.code).toBe("screen-not-clear");
    db.run("DELETE FROM upstream_repull_screens");
    markScreen(id, "clean");
    db.run("UPDATE datasets SET anonymous = 1");
    expect((await claim(id)).body.code).toBe("anonymous-dataset");
    db.run("UPDATE datasets SET anonymous = 0");
    expect((await claim(id)).status).toBe(200);
  });

  test("a screen that changes between the read and the claim is not relied on", async () => {
    const id = ready("on099999");
    const res = await claim(id, {
      db: racing("UPDATE upstream_repulls SET", () =>
        db.run("UPDATE upstream_repull_screens SET status = 'direct-identifiers'"),
      ),
    });
    expect([res.status, res.body.code]).toEqual([409, "screen-changed"]);
    expect(rowOf(id).merge_claimed_at).toBeNull();
  });

  test("an acknowledgment that changes hands, or is removed, between the read and the claim is not relied on", async () => {
    for (const change of [
      "UPDATE upstream_repull_screens SET ack_by = ack_by + 1000",
      "UPDATE upstream_repull_screens SET ack_by = NULL, ack_reason = NULL, ack_at = NULL",
    ]) {
      db.run("DELETE FROM upstream_repull_screens");
      db.run("DELETE FROM upstream_repulls");
      if (!db.query("SELECT 1 FROM datasets").get()) seedMirror("on099999");
      const id = seedRepull("gates_clear");
      markScreen(id, "review");
      db.run(
        "UPDATE upstream_repull_screens SET ack_by = ?, ack_reason = 'read it', ack_at = datetime('now')",
        [adminId],
      );
      const res = await claim(id, {
        db: racing("UPDATE upstream_repulls SET", () => db.run(change)),
      });
      expect([change, res.status, res.body.code]).toEqual([change, 409, "screen-changed"]);
      expect(rowOf(id).merge_claimed_at).toBeNull();
    }
  });

  test("a dataset made anonymous or withdrawn between the read and the claim is not claimed for", async () => {
    for (const [change, code] of [
      ["UPDATE datasets SET anonymous = 1", "anonymous-dataset"],
      ["UPDATE datasets SET withdrawn_at = datetime('now')", "withdrawn"],
    ] as const) {
      db.run("DELETE FROM upstream_repull_screens");
      db.run("DELETE FROM upstream_repulls");
      db.run("DELETE FROM datasets");
      const id = ready("on099999");
      const res = await claim(id, {
        db: racing("UPDATE upstream_repulls SET", () => db.run(change)),
      });
      expect([code, res.status, res.body.code]).toEqual([code, 409, code]);
      expect(rowOf(id).merge_claimed_at).toBeNull();
    }
  });
});

// ----------------------------------------------------------------------------
// The live head
// ----------------------------------------------------------------------------

describe("the gates and the claim read the live pull request", () => {
  const gates = (id: number) =>
    call(`/repulls/${id}/transition`, {
      from: "pr_open",
      to: "gates_clear",
      fields: { gates_sha: HEAD },
    });

  test("a head that moved, a closed or merged pull request, or another base refuses both, and nothing is written", async () => {
    const cases: Array<[string, PullAnswer]> = [
      ["moved", { head: { sha: OTHER, ref: "release/v2.0.0" } }],
      ["closed", { state: "closed" }],
      ["merged", { merged: true }],
      ["another base", { base: { ref: "dev" } }],
      ["missing", { status: 404 }],
    ];
    const draft: PullAnswer = { draft: true };
    for (const [what, answer] of cases) {
      db.run("DELETE FROM upstream_repull_screens");
      db.run("DELETE FROM upstream_repulls");
      db.run("DELETE FROM datasets");
      const claiming = ready("on099999");
      seedMirror("on099998");
      const opening = seedRepull("pr_open", { dataset_id: "on099998" });
      markScreen(opening, "clean");
      gh.pulls = { "on099999#7": answer, "on099998#7": answer };
      const c = await claim(claiming);
      const g = await gates(opening);
      expect([what, c.status, c.body.code, g.status, g.body.code]).toEqual([
        what,
        409,
        "head-moved",
        409,
        "head-moved",
      ]);
      expect(rowOf(claiming).merge_claimed_at).toBeNull();
      expect(rowOf(opening).status).toBe("pr_open");
    }
    // A draft is refused by its own word, and takes no unit of the cap.
    gh.pulls = { "on099999#7": draft, "on099998#7": draft };
    const c = await claim(rowsOf("on099999"));
    const g = await gates(rowsOf("on099998"));
    expect([c.status, c.body.code, g.status, g.body.code]).toEqual([
      409,
      "pr-draft",
      409,
      "pr-draft",
    ]);
    expect(
      (
        db
          .query("SELECT COUNT(*) AS n FROM upstream_repulls WHERE merge_claimed_at IS NOT NULL")
          .get() as Row
      ).n,
    ).toBe(0);
  });

  test("a fork's head, a deleted fork's, or a base in another repository refuses both, and nothing is claimed or sent", async () => {
    const own = (ds: string) => ({ full_name: `nemarDatasets/${ds}` });
    // Each answer, and the words the refusal names it by.
    const cases: Array<[string, (ds: string) => PullAnswer, (ds: string) => string]> = [
      [
        "a fork's head",
        (ds) => ({
          head: { sha: HEAD, ref: "release/v2.0.0", repo: { full_name: `someone/${ds}` } },
        }),
        (ds) => `its head is someone/${ds}, its base nemarDatasets/${ds}`,
      ],
      [
        "a deleted fork's head",
        () => ({ head: { sha: HEAD, ref: "release/v2.0.0", repo: null } }),
        (ds) => `its head is a repository GitHub no longer names, its base nemarDatasets/${ds}`,
      ],
      [
        "a base in another repository",
        (ds) => ({
          head: { sha: HEAD, ref: "release/v2.0.0", repo: own(ds) },
          base: { ref: "main", repo: { full_name: `someone/${ds}` } },
        }),
        (ds) => `its head is nemarDatasets/${ds}, its base someone/${ds}`,
      ],
    ];
    for (const [what, answer, words] of cases) {
      db.run("DELETE FROM upstream_repull_screens");
      db.run("DELETE FROM upstream_repulls");
      db.run("DELETE FROM datasets");
      db.run("DELETE FROM audit_log");
      const claiming = ready("on099999");
      seedMirror("on099998");
      const opening = seedRepull("pr_open", { dataset_id: "on099998" });
      markScreen(opening, "clean");
      // The branch is the recorded one at the screened head: only the repository is not.
      gh.pulls = { "on099999#7": answer("on099999"), "on099998#7": answer("on099998") };
      const c = await claim(claiming);
      const g = await gates(opening);
      expect([what, c.status, c.body.code, g.status, g.body.code]).toEqual([
        what,
        409,
        "head-moved",
        409,
        "head-moved",
      ]);
      expect(c.body.error).toContain("is not from and into nemarDatasets/on099999 itself");
      expect(c.body.error).toContain(words("on099999"));
      expect(c.body.error).toContain("a fork's pull request is never the re-pull's");
      expect(g.body.error).toContain(words("on099998"));
      expect(rowOf(claiming)).toMatchObject({ merge_claim_sha: null, merge_claimed_at: null });
      expect(rowOf(opening).status).toBe("pr_open");
      // No edge was written.
      expect(db.query("SELECT COUNT(*) AS n FROM audit_log").get()).toEqual({ n: 0 });
    }
  });

  // GitHub always names both repositories; an answer that does not, or not as a name, is not read
  // as the record's pull request.
  const unreadableRepositories: Array<[string, PullAnswer]> = [
    ["no head repository", { head: { sha: HEAD, ref: "release/v2.0.0", repo: undefined } }],
    [
      "a head repository with no name",
      { head: { sha: HEAD, ref: "release/v2.0.0", repo: {} as never } },
    ],
    ["no base repository", { base: { ref: "main", repo: undefined } }],
    [
      "a base repository named by a number",
      { base: { ref: "main", repo: { full_name: 5 as never } } },
    ],
  ];
  for (const [what, answer] of unreadableRepositories) {
    test(`${what}: unreadable, 502 for the claim and the gates, and nothing is claimed`, async () => {
      const claiming = ready("on099999");
      seedMirror("on099998");
      const opening = seedRepull("pr_open", { dataset_id: "on099998" });
      markScreen(opening, "clean");
      gh.pulls = { "on099999#7": answer, "on099998#7": answer };
      const c = await claim(claiming);
      const g = await gates(opening);
      expect([c.status, c.body.code, g.status, g.body.code]).toEqual([
        502,
        "github-unreadable",
        502,
        "github-unreadable",
      ]);
      expect(rowOf(claiming)).toMatchObject({ merge_claim_sha: null, merge_claimed_at: null });
      expect(rowOf(opening).status).toBe("pr_open");
    });
  }

  test("the dataset's own repository named in another case is its own, and is claimed", async () => {
    const id = ready("on099999");
    gh.pulls = {
      "on099999#7": {
        head: { sha: HEAD, ref: "release/v2.0.0", repo: { full_name: "NemarDatasets/ON099999" } },
        base: { ref: "main", repo: { full_name: "NEMARDATASETS/on099999" } },
      },
    };
    const res = await claim(id);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(rowOf(id).merge_claim_sha).toBe(HEAD);
  });

  test("a GitHub that cannot be read refuses with 502, and the transport's retry time is passed on", async () => {
    const id = ready("on099999");
    gh.down = true;
    const down = await claim(id);
    expect([down.status, down.body.code]).toEqual([502, "github-unreadable"]);
    gh.down = false;
    __seedRateLimitStateForTests({
      resource: "core",
      remaining: 0,
      resetEpoch: Math.floor(Date.now() / 1000) + 120,
    });
    const throttled = await claim(id);
    expect([throttled.status, throttled.body.code]).toEqual([502, "github-unreadable"]);
    expect(throttled.body.error).toMatch(/HTTP 503, retry in \d+s/);
    expect(rowOf(id).merge_claimed_at).toBeNull();
  });

  test("the live read is GitHub's, made for the claimed pull request", async () => {
    const id = ready("on099999");
    expect((await claim(id)).status).toBe(200);
    expect(gh.requests).toEqual(["GET /repos/nemarDatasets/on099999/pulls/7"]);
  });
});

// ----------------------------------------------------------------------------
// Releasing a claim
// ----------------------------------------------------------------------------

describe("releasing a claim", () => {
  const release = (id: number, outcome: string, sha = HEAD, o: Parameters<typeof call>[2] = {}) =>
    call(`/repulls/${id}/merge-claim/release`, { pr: "n0", sha, outcome }, o);
  /** Claim through the API, then age the Worker's stamp by `minutes`. */
  const agedClaim = async (id: number, minutes = 10) => {
    expect((await claim(id)).status).toBe(200);
    db.run(
      `UPDATE upstream_repulls SET merge_claimed_at = datetime(merge_claimed_at, '-${minutes} minutes') WHERE id = ?`,
      [id],
    );
  };

  test("a merge not sent, or refused, frees the unit once GitHub says it did not merge", async () => {
    const a = ready("on099998");
    const b = ready("on099999");
    await agedClaim(a);
    gh.pulls["on099998#7"] = { merged: false };
    const res = await release(a, "refused");
    expect(res.status).toBe(200);
    expect(res.body.repull).toMatchObject({ merge_claimed_at: null, merge_claim_sha: null });
    expect(gh.requests.filter((r) => r.endsWith("/on099998/pulls/7"))).toHaveLength(2);
    const audit = db
      .query("SELECT details FROM audit_log WHERE action = 'repull_merge_claim_released'")
      .get() as Row;
    expect(JSON.parse(audit.details as string)).toMatchObject({ outcome: "refused" });
    expect((await claim(b, { env: { REPULL_DAILY_MERGE_CAP: "1" } })).status).toBe(200);
  });

  test("a claim younger than five minutes is not released, and GitHub is not read for it", async () => {
    const id = ready("on099999");
    await agedClaim(id, 4);
    gh.requests = [];
    const recent = await release(id, "not_sent");
    expect([recent.status, recent.body.code]).toEqual([409, "claim-too-recent"]);
    expect(gh.requests).toEqual([]);
    db.run(
      "UPDATE upstream_repulls SET merge_claimed_at = datetime(merge_claimed_at, '-2 minutes')",
    );
    expect((await release(id, "not_sent")).status).toBe(200);
  });

  test("a claim made again between the age check and the release is not released", async () => {
    const id = ready("on099999");
    await agedClaim(id);
    const res = await release(id, "not_sent", HEAD, {
      db: racing("UPDATE upstream_repulls\n            SET merge_claimed_at = NULL", () =>
        db.run("UPDATE upstream_repulls SET merge_claimed_at = datetime('now') WHERE id = ?", [id]),
      ),
    });
    expect([res.status, res.body.code]).toEqual([409, "stale-status"]);
    expect(rowOf(id).merge_claim_sha).toBe(HEAD);
  });

  test("an unknown outcome cannot release, and neither can a merged pull request or an unread GitHub", async () => {
    const id = ready("on099999");
    await agedClaim(id);
    const unknown = await release(id, "unknown");
    expect(unknown.status).toBe(400);
    gh.pulls["on099999#7"] = { merged: true };
    const merged = await release(id, "not_sent");
    expect([merged.status, merged.body.code]).toEqual([409, "pull-request-merged"]);
    gh.down = true;
    const down = await release(id, "not_sent");
    expect([down.status, down.body.code]).toEqual([502, "github-unreadable"]);
    expect(rowOf(id).merge_claim_sha).toBe(HEAD);
  });

  test("no claim, another sha, or another pull request is refused", async () => {
    const id = ready("on099999");
    expect((await release(id, "not_sent")).body.code).toBe("no-claim");
    await agedClaim(id);
    expect((await release(id, "not_sent", OTHER)).body.code).toBe("claim-mismatch");
    gh.pulls["on099999#7"] = { merged: false, head: { sha: HEAD, ref: "release/v3.0.0" } };
    expect((await release(id, "not_sent")).body.code).toBe("pull-request-mismatch");
    expect(rowOf(id).merge_claim_sha).toBe(HEAD);
  });

  test("outside production an on dataset's claim is not released, and GitHub is not read", async () => {
    const id = ready("on099999");
    await agedClaim(id);
    gh.requests = [];
    const res = await release(id, "not_sent", HEAD, { env: { ENVIRONMENT: "test" } });
    expect([res.status, res.body.code]).toEqual([403, "env-fence"]);
    expect(gh.requests).toEqual([]);
    expect(rowOf(id).merge_claim_sha).toBe(HEAD);
  });
});

// ----------------------------------------------------------------------------
// Merged
// ----------------------------------------------------------------------------

describe("recording the merge", () => {
  const merged = (id: number, pr = "n0", o: Parameters<typeof call>[2] = {}) =>
    call(`/repulls/${id}/merged`, { pr }, o);

  test("a merge at the claimed head is recorded with GitHub's merge commit", async () => {
    const id = ready("on099999");
    await claim(id);
    gh.requests = [];
    gh.pulls["on099999#7"] = { merged: true, merge_commit_sha: MERGE };
    const res = await merged(id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      merged_outside_tool: false,
      merged_unscreened_head: false,
      replayed: false,
    });
    expect(res.body.repull).toMatchObject({ status: "merged", merge_sha: MERGE, counts: {} });
    expect(gh.requests).toEqual(["GET /repos/nemarDatasets/on099999/pulls/7"]);
  });

  test("an open pull request is not recorded as merged", async () => {
    const id = ready("on099999");
    await claim(id);
    gh.pulls["on099999#7"] = { merged: false };
    const before = rowOf(id);
    const res = await merged(id);
    expect([res.status, res.body.code]).toEqual([409, "not-merged"]);
    expect(rowOf(id)).toEqual(before);
  });

  test("a merge with no claim held is counted as outside NEMAR's tools, and only that", async () => {
    const id = ready("on099999");
    gh.pulls["on099999#7"] = { merged: true };
    const res = await merged(id);
    expect(res.status).toBe(200);
    expect(res.body.repull.counts).toEqual({ merged_outside_tool: 1 });
    expect(res.body.merged_outside_tool).toBe(true);
  });

  test("with a claim held, a merge at another head is counted as unscreened, and only that", async () => {
    const id = ready("on099999");
    await claim(id);
    gh.pulls["on099999#7"] = { merged: true, head: { sha: OTHER, ref: "release/v2.0.0" } };
    const res = await merged(id);
    expect(res.status).toBe(200);
    expect(res.body.repull.counts).toEqual({ merged_unscreened_head: 1 });
    expect(res.body).toMatchObject({ merged_outside_tool: false, merged_unscreened_head: true });
  });

  test("with no claim and another head, both are counted, each on its own", async () => {
    const id = ready("on099999");
    gh.pulls["on099999#7"] = { merged: true, head: { sha: OTHER, ref: "release/v2.0.0" } };
    const res = await merged(id);
    expect(res.body.repull.counts).toEqual({ merged_outside_tool: 1, merged_unscreened_head: 1 });
  });

  test("the administrator sees the counts in the list of re-pulls", async () => {
    const id = ready("on099999");
    gh.pulls["on099999#7"] = { merged: true, head: { sha: OTHER, ref: "release/v2.0.0" } };
    expect((await merged(id)).status).toBe(200);
    const list = await call("/repulls?dataset=on099999");
    expect(list.status).toBe(200);
    expect(list.body.repulls[0].counts).toEqual({
      merged_outside_tool: 1,
      merged_unscreened_head: 1,
    });
  });

  test("a merge GitHub cannot name, a malformed answer, a missing pull request and a moved one are refused", async () => {
    const id = ready("on099999");
    for (const [answer, code] of [
      [{ merged: true, merge_commit_sha: null }, "github-unreadable"],
      [{ merged: "true" }, "github-unreadable"],
      [{ merged: true, omit: ["merged"] }, "github-unreadable"],
      // GitHub always names both repositories; an answer that does not, or not as a name, is not
      // read as the record's pull request.
      [
        { merged: true, head: { sha: HEAD, ref: "release/v2.0.0", repo: undefined } },
        "github-unreadable",
      ],
      [
        { merged: true, head: { sha: HEAD, ref: "release/v2.0.0", repo: {} as never } },
        "github-unreadable",
      ],
      [{ merged: true, base: { ref: "main", repo: undefined } }, "github-unreadable"],
      [
        { merged: true, base: { ref: "main", repo: { full_name: 5 as never } } },
        "github-unreadable",
      ],
      [{ status: 404 }, "pull-request-missing"],
      [{ merged: true, base: { ref: "dev" } }, "pull-request-mismatch"],
    ] as const) {
      gh.pulls = { "on099999#7": answer as PullAnswer };
      const res = await merged(id);
      expect([JSON.stringify(answer), res.body.code]).toEqual([JSON.stringify(answer), code]);
    }
    expect(rowOf(id).status).toBe("gates_clear");
  });

  test("a retried merge is answered from the stored row; another merge commit is refused", async () => {
    const id = ready("on099999");
    await claim(id);
    gh.pulls["on099999#7"] = { merged: true };
    expect((await merged(id)).status).toBe(200);
    const stored = rowOf(id);
    const again = await merged(id);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ replayed: true, repull: { merge_sha: MERGE } });
    expect(rowOf(id)).toEqual(stored);
    gh.pulls["on099999#7"] = { merged: true, merge_commit_sha: OTHER };
    const other = await merged(id);
    expect([other.status, other.body.code]).toEqual([409, "already-merged"]);
    expect(rowOf(id)).toEqual(stored);
  });

  test("only from pr_open or gates_clear, only in production for an on dataset, and the transition route cannot state it", async () => {
    seedMirror("on099999");
    // A pull request merged while the row is pr_open is recorded too (upstream-repull-resume-routes
    // test); one that is not yet open has no pull request to have merged.
    const registered = seedRepull("registered");
    expect((await merged(registered)).body.code).toBe("bad-transition");
    db.run("DELETE FROM upstream_repulls");
    const id = ready("on099999");
    gh.requests = [];
    gh.pulls["on099999#7"] = { merged: true };
    const fenced = await merged(id, "n0", { env: { ENVIRONMENT: "test" } });
    expect([fenced.status, fenced.body.code]).toEqual([403, "env-fence"]);
    expect(gh.requests).toEqual([]);
    const stated = await call(`/repulls/${id}/transition`, {
      from: "gates_clear",
      to: "merged",
      fields: { merge_sha: MERGE },
    });
    expect(stated.body.code).toBe("use-verified-route");
  });

  test("the counts only the Worker writes cannot be stated by a request", async () => {
    seedMirror("on099999");
    const id = seedRepull("released");
    const res = await call(`/repulls/${id}/transition`, {
      from: "released",
      to: "released",
      fields: { counts: { merged_outside_tool: 0 } },
    });
    expect([res.status, res.body.code]).toEqual([400, "field-not-allowed"]);
    const create = await call("/repulls", {
      dataset_id: "on099999",
      upstream_ds: "ds099999",
      from_tag: "1.0.0",
      to_tag: "1.0.1",
      from_version: "1.0.0",
      to_version: "2.0.0",
      plan_digest: `sha256:${"0".repeat(64)}`,
      planner: 2,
      base_sha: HEAD,
      lineage_recordable: false,
      counts: { merged_unscreened_head: 0 },
    });
    expect([create.status, create.body.code]).toEqual([400, "invalid-body"]);
  });

  test("an N.0.1 replay reports N.0.1's own facts, not N.0.0's counts", async () => {
    seedMirror("on099999");
    // N.0.0 merged with no claim held, at an unscreened head: the row counts both.
    const id = seedRepull("patch_gates_clear", {
      patch_head_sha: HEAD,
      patch_gates_sha: HEAD,
      counts: '{"merged_outside_tool":1,"merged_unscreened_head":1}',
    });
    markScreen(id, "clean", { pr: "n1" });
    expect((await patchClaim(id)).status).toBe(200);
    gh.pulls["on099999#8"] = { merged: true, head: { sha: HEAD, ref: "release/v2.0.1" } };
    const first = await merged(id, "n1");
    expect(first.body).toMatchObject({ merged_outside_tool: false, replayed: false });
    const again = await merged(id, "n1");
    expect(again.body).toMatchObject({
      replayed: true,
      merged_outside_tool: false,
      merged_unscreened_head: false,
    });
  });

  test("N.0.1's merge is recorded the same way", async () => {
    const id = ready("on099999", "patch_gates_clear");
    expect((await patchClaim(id)).status).toBe(200);
    gh.pulls["on099999#8"] = { merged: true, head: { sha: HEAD, ref: "release/v2.0.1" } };
    const res = await merged(id, "n1");
    expect(res.status).toBe(200);
    expect(res.body.repull).toMatchObject({ status: "patch_merged", patch_merge_sha: MERGE });
  });
});

// ----------------------------------------------------------------------------
// Released
// ----------------------------------------------------------------------------

describe("recording the release", () => {
  const STAMPS = {
    hed_checked_at: "2026-10-01 00:00:00",
    channel_montage_checked_at: "2026-10-01 00:00:00",
    data_checked_at: "2026-10-01 00:00:00",
    availability_report_at: "2026-10-01 00:00:00",
    zarr_checked_at: "2026-10-01 00:00:00",
  };

  function releasedFixture(version = "2.0.0", basis: string | null = "doi") {
    seedMirror("on099999", { stamps: STAMPS });
    seedMirror("on099998", { stamps: STAMPS });
    db.run(
      `INSERT INTO dataset_versions (dataset_id, version, doi, source_version, source_version_basis)
       VALUES ('on099999', ?, '10.82901/on099999.v2.0.0', ?, ?)`,
      [version, basis === "unknown" ? null : "1.0.1", basis],
    );
    gh.tags["on099999@v2.0.0"] = TAG;
    return seedRepull("merged", { merge_sha: MERGE });
  }

  const released = (id: number, body: Record<string, unknown> = {}, o = {}) =>
    call(`/repulls/${id}/released`, { pr: "n0", tag_sha: TAG, tree_verified: true, ...body }, o);

  const stampsOf = (id: string) =>
    JSON.parse(
      (db.query("SELECT sweep_stamps FROM datasets WHERE dataset_id = ?").get(id) as Row)
        .sweep_stamps as string,
    );

  const basisOf = () =>
    db
      .query(
        "SELECT source_version, source_version_basis FROM dataset_versions WHERE dataset_id = 'on099999'",
      )
      .get();

  test("writes the tag, N.0.0's lineage and re-arms that dataset's four stamps, in one batch", async () => {
    const id = releasedFixture();
    const res = await released(id);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ lineage_rows: 1, stamps_rearmed: 1, replayed: false });
    expect(res.body.repull).toMatchObject({ status: "released", tag_sha: TAG });
    expect(basisOf()).toEqual({ source_version: "1.0.1", source_version_basis: "lineage" });
    expect(stampsOf("on099999")).toEqual({ zarr_checked_at: "2026-10-01 00:00:00" });
    // Every other dataset's stamps and values are as they were.
    expect(stampsOf("on099998")).toEqual(STAMPS);
    expect(gh.requests).toEqual([
      "GET /repos/nemarDatasets/on099999/commits/refs/tags/v2.0.0",
      `GET /repos/nemarDatasets/on099999/compare/${MERGE}...${TAG}`,
    ]);
    const audit = db
      .query("SELECT details FROM audit_log WHERE action = 'repull_transition'")
      .get() as Row;
    expect(JSON.parse(audit.details as string)).toMatchObject({
      to: "released",
      tree_verified: true,
    });
  });

  test("without a verified tree the lineage is not written, and the stamps are still re-armed", async () => {
    const id = releasedFixture();
    const res = await released(id, { tree_verified: false });
    expect(res.status).toBe(200);
    expect(res.body.lineage_rows).toBe(0);
    expect(basisOf()).toEqual({ source_version: "1.0.1", source_version_basis: "doi" });
    expect(stampsOf("on099999")).toEqual({ zarr_checked_at: "2026-10-01 00:00:00" });
  });

  test("a version row recorded unknown is never overwritten, and the v spelling is found", async () => {
    const id = releasedFixture("v2.0.0", "unknown");
    const res = await released(id);
    expect(res.status).toBe(200);
    expect(res.body.lineage_rows).toBe(0);
    expect(basisOf()).toEqual({ source_version: null, source_version_basis: "unknown" });
  });

  test("no version row, no tag, a tag on another commit, or one without the merge: nothing is written", async () => {
    seedMirror("on099999", { stamps: STAMPS });
    const id = seedRepull("merged", { merge_sha: MERGE });
    expect((await released(id)).body.code).toBe("not-released");
    expect(gh.requests).toEqual([]);
    db.run(
      "INSERT INTO dataset_versions (dataset_id, version, doi) VALUES ('on099999', '2.0.0', '10.82901/x')",
    );
    expect((await released(id)).body.code).toBe("tag-missing");
    gh.tags["on099999@v2.0.0"] = OTHER;
    expect((await released(id)).body.code).toBe("tag-mismatch");
    gh.tags["on099999@v2.0.0"] = TAG;
    for (const relation of ["diverged", "behind"]) {
      gh.compares[`on099999:${MERGE}...${TAG}`] = relation;
      expect([relation, (await released(id)).body.code]).toEqual([relation, "tag-mismatch"]);
    }
    for (const status of [404, 422]) {
      gh.compares[`on099999:${MERGE}...${TAG}`] = status;
      const res = await released(id);
      expect([status, res.status, res.body.code, res.body.error]).toEqual([
        status,
        409,
        "compare-unresolved",
        "GitHub could not compare the tag with the merge.",
      ]);
    }
    expect(rowOf(id).status).toBe("merged");
    expect(stampsOf("on099999")).toEqual(STAMPS);
  });

  test("a tag at a descendant of the merge (enrichment after it) is accepted", async () => {
    const id = releasedFixture();
    gh.compares[`on099999:${MERGE}...${TAG}`] = "ahead";
    expect((await released(id)).status).toBe(200);
    db.run("DELETE FROM upstream_repulls");
    db.run("DELETE FROM datasets");
    db.run("DELETE FROM dataset_versions");
    const same = releasedFixture();
    gh.tags["on099999@v2.0.0"] = MERGE;
    gh.compares[`on099999:${MERGE}...${MERGE}`] = "identical";
    expect((await released(same, { tag_sha: MERGE })).status).toBe(200);
  });

  test("a retried release is answered from the stored row; another tag commit is refused", async () => {
    const id = releasedFixture();
    expect((await released(id)).status).toBe(200);
    const stored = rowOf(id);
    gh.requests = [];
    const again = await released(id);
    expect(again.status).toBe(200);
    // Unknown is not zero: the replay wrote nothing and says so.
    expect(again.body).toMatchObject({ replayed: true, stamps_rearmed: null, lineage_rows: null });
    expect(rowOf(id)).toEqual(stored);
    const other = await released(id, { tag_sha: OTHER });
    expect([other.status, other.body.code]).toEqual([409, "already-released"]);
    expect(rowOf(id)).toEqual(stored);
  });

  test("outside production an on dataset's release is not recorded, and GitHub is not read", async () => {
    const id = releasedFixture();
    const res = await released(id, {}, { env: { ENVIRONMENT: "test" } });
    expect([res.status, res.body.code]).toEqual([403, "env-fence"]);
    expect(gh.requests).toEqual([]);
    expect(rowOf(id).status).toBe("merged");
  });

  test("when the row moves before the batch runs, neither the lineage nor the stamps are written", async () => {
    const id = releasedFixture();
    const res = await released(
      id,
      {},
      {
        db: racing("UPDATE upstream_repulls SET", () =>
          // Another writer moves the row (a count recorded) after this request read it.
          db.run("UPDATE upstream_repulls SET revision = revision + 1 WHERE id = ?", [id]),
        ),
      },
    );
    expect([res.status, res.body.code]).toEqual([409, "stale-status"]);
    expect(basisOf()).toEqual({ source_version: "1.0.1", source_version_basis: "doi" });
    expect(stampsOf("on099999")).toEqual(STAMPS);
    expect(rowOf(id).status).toBe("merged");
  });

  test("N.0.1's release re-arms the stamps and never writes lineage", async () => {
    seedMirror("on099999", { stamps: STAMPS });
    db.run(
      `INSERT INTO dataset_versions (dataset_id, version, doi, source_version, source_version_basis)
       VALUES ('on099999', '2.0.0', '10.82901/a', '1.0.1', 'doi'), ('on099999', '2.0.1', '10.82901/b', NULL, NULL)`,
    );
    gh.tags["on099999@v2.0.1"] = TAG;
    const id = seedRepull("patch_merged", { patch_merge_sha: MERGE });
    const res = await call(`/repulls/${id}/released`, {
      pr: "n1",
      tag_sha: TAG,
      tree_verified: true,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ lineage_rows: 0, stamps_rearmed: 1 });
    expect(res.body.repull).toMatchObject({ status: "patch_released", patch_tag_sha: TAG });
    expect(
      db.query("SELECT version, source_version_basis FROM dataset_versions ORDER BY version").all(),
    ).toEqual([
      { version: "2.0.0", source_version_basis: "doi" },
      { version: "2.0.1", source_version_basis: null },
    ]);
  });
});
