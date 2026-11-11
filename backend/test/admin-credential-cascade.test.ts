/**
 * Ending a credential has to reach EVERY credential class the account holds
 * (epic #1336 phase 0 review).
 *
 * Real engine throughout: bun:sqlite behind `realD1` with every migration
 * applied, real Hono dispatch through `authMiddleware` + `adminMiddleware` /
 * `ownerMiddleware` with a real hashed token, real docs sign-in through
 * `POST /auth/docs/grant` and `/exchange`. No mocks. The revoke harness (a
 * target with no `aws_iam_username`, no collaborations, no owned datasets, and
 * `RESEND_API_KEY` unset under `ENVIRONMENT: "test"`, so IAM, GitHub and email
 * all no-op without a network call) is the one `admin-revoke-route.test.ts`
 * established.
 *
 * WHAT WENT WRONG, AND WHY IT NEEDED ITS OWN FILE. `/auth/logout` was wired to
 * revoke docs sessions and purge docs grants, and the epic's tests covered that
 * path thoroughly. Review then asked the obvious next question -- what ELSE ends
 * a credential? -- and found nine such paths, of which exactly one had the
 * cascade. Admin revoke revoked `tokens` and wrote `users.status`, and nothing
 * else: the browser session row and any outstanding docs grant survived, so a
 * revoke followed by a re-approval inside eight hours handed the old docs cookie
 * back to whichever browser still held it. A role demotion had the same shape.
 *
 * Compute (epic #2005 phase A8, #2013) is the fourth thing a revocation has to end: revoke and the
 * tombstone cascade both run `computeReleaseStatements` in their batch, a demotion does not. The blocks
 * below pin that on the same routes; `compute-release-cascade.test.ts` drives the whole lifecycle
 * (real jobs, the Tapis stand-in and the retried sweep) and the mutations of each statement.
 *
 * So these tests are deliberately about the SECOND event. That a revoked account
 * is refused is easy and was already true (`status = 'revoked'` fails every
 * reader). What has to hold is that the credential is GONE, such that restoring
 * the account cannot restore it.
 */

import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { DOCS_SESSION_HEADER } from "../../shared/contract/docs-auth.js";
import { adminRoutes } from "../src/routes/admin";
import { authDocsRoutes } from "../src/routes/auth-docs";
import { placeHold, platformPool } from "../src/services/compute-ledger";
import { hashApiKey } from "../src/services/token";
import { issueSession } from "../src/services/web-session";
import type { Bindings, Variables } from "../src/types/bindings";
import { fundAccount, fundPlatform } from "./helpers/compute-seed";
import { freshDb, realD1 } from "./helpers/d1";

const OWNER_KEY = "cascade-owner-key-0123456789abcdef0123456789abcdef";
const APP = "https://app.nemar.org";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;

function env(): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "test",
    RESEND_API_KEY: "",
    APP_BASE_URL: APP,
    WEB_SESSION_COOKIE_DOMAIN: "",
  } as unknown as Bindings;
}

/** The acting account: owner, because the role route is owner-only and revoke
 *  needs admin, so one key covers both. */
async function seedOwner(): Promise<void> {
  db.run(
    `INSERT INTO users (username, email, password_hash, github_username, status, role, email_verified, account_kind)
     VALUES ('cascadeowner', 'cascadeowner@nemar.test', 'x', 'cascadeowner-gh', 'approved', 'owner', 1, 'service')`,
  );
  const u = db
    .query<{ id: number }, []>("SELECT id FROM users WHERE username='cascadeowner'")
    .get();
  if (!u) throw new Error("seed: owner insert failed");
  await db
    .query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)")
    .run(u.id, await hashApiKey(OWNER_KEY), OWNER_KEY.slice(0, 8));
}

/** The account whose credentials are ended. An admin, so it can hold a docs
 *  session in the first place; no IAM user, no datasets, so revoke touches
 *  neither AWS nor GitHub. */
function seedTarget(role: "admin" | "owner" = "admin"): number {
  db.run(
    `INSERT INTO users (username, email, password_hash, github_username, status, role, email_verified, account_kind)
     VALUES ('cascadetarget', 'cascadetarget@nemar.test', 'x', 'cascadetarget-gh', 'approved', ?, 1, 'person')`,
    [role],
  );
  const u = db
    .query<{ id: number }, []>("SELECT id FROM users WHERE username='cascadetarget'")
    .get();
  if (!u) throw new Error("seed: target insert failed");
  return u.id;
}

/** Sign the target into the docs host through the real routes, and hand back
 *  both the live session value and an unspent grant code -- the two things that
 *  have to stop working. */
async function signInToDocs(userId: number): Promise<{ session: string; unspentCode: string }> {
  const { cookieIdRaw } = await issueSession(
    env(),
    userId,
    false,
    "test-agent",
    "127.0.0.1",
    "orcid",
  );
  const grantOnce = async () => {
    const res = await app.request(
      "/auth/docs/grant",
      { method: "POST", headers: { Cookie: `nemar_session=${cookieIdRaw}`, Origin: APP } },
      env(),
    );
    expect(res.status).toBe(200);
    return ((await res.json()) as { code: string }).code;
  };
  const code = await grantOnce();
  const exchanged = await app.request(
    "/auth/docs/exchange",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    },
    env(),
  );
  expect(exchanged.status).toBe(200);
  const { session } = (await exchanged.json()) as { session: string };
  return { session, unspentCode: await grantOnce() };
}

function verify(session: string): Promise<Response> {
  return app.request("/auth/docs/verify", { headers: { [DOCS_SESSION_HEADER]: session } }, env());
}

function exchange(code: string): Promise<Response> {
  return app.request(
    "/auth/docs/exchange",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    },
    env(),
  );
}

function grantCount(userId: number): number {
  return (
    db
      .query<{ n: number }, [number]>("SELECT COUNT(*) AS n FROM docs_grants WHERE user_id = ?")
      .get(userId)?.n ?? 0
  );
}

function liveSessionCount(userId: number, scope?: "app" | "docs"): number {
  const sql = scope
    ? "SELECT COUNT(*) AS n FROM web_sessions WHERE user_id = ? AND revoked_at IS NULL AND scope = ?"
    : "SELECT COUNT(*) AS n FROM web_sessions WHERE user_id = ? AND revoked_at IS NULL";
  const row = scope
    ? db.query<{ n: number }, [number, string]>(sql).get(userId, scope)
    : db.query<{ n: number }, [number]>(sql).get(userId);
  return row?.n ?? 0;
}

let jobSeq = 0;

/**
 * An account's compute as the real services make it: a funded pool and, for each job asked for, a real
 * hold (`placeHold`) and a `compute_jobs` row. A job at Tapis has its uuid and is `running`; the other
 * never reached Tapis. (`createJob` needs the records bucket, which these tests do not carry; the row it
 * writes is this one.)
 */
async function seedCompute(
  userId: number,
  jobs: Array<"unsubmitted" | "at_tapis">,
): Promise<{ ids: string[] }> {
  const d1 = realD1(db);
  await fundPlatform(d1, "people", 1_000_000);
  const poolId = await fundAccount(d1, userId, 100_000, "cpu");
  const people = await platformPool(d1, "people", "cpu");
  const ids: string[] = [];
  for (const kind of jobs) {
    const id = `job_${(++jobSeq).toString(16).padStart(24, "0")}`;
    const held = await placeHold(d1, {
      poolId,
      budgetPoolId: people?.id ?? null,
      amountMilli: 4000,
      jobId: id,
    });
    expect(held.ok).toBe(true);
    db.run(
      `INSERT INTO compute_jobs (id, account_id, source, kind, app_id, app_version, spec_digest,
                                 partition, pool, nodes, cores_per_node, minutes, state, tapis_uuid,
                                 held_milli)
       VALUES (?, ?, 'cli', 'batch', 'nemar-launch', '1.0.0', ?, 'shared', 'cpu', 1, 4, 60, ?, ?, 4000)`,
      [
        id,
        userId,
        "d".repeat(64),
        kind === "at_tapis" ? "running" : "created",
        kind === "at_tapis" ? `tapis-${jobSeq}-007` : null,
      ],
    );
    ids.push(id);
  }
  return { ids };
}

interface ComputeSnapshot {
  state: string;
  cancel_reason: string | null;
  cancel_requested: number;
  ledger: string;
}

function computeOf(jobId: string): ComputeSnapshot {
  const row = db
    .query<
      { state: string; cancel_reason: string | null; cancel_requested_at: string | null },
      [string]
    >("SELECT state, cancel_reason, cancel_requested_at FROM compute_jobs WHERE id = ?")
    .get(jobId);
  if (!row) throw new Error("no such job");
  const kinds = db
    .query<{ kind: string }, [string]>(
      "SELECT kind FROM compute_ledger WHERE job_id = ? ORDER BY id",
    )
    .all(jobId)
    .map((r) => r.kind);
  return {
    state: row.state,
    cancel_reason: row.cancel_reason,
    cancel_requested: row.cancel_requested_at === null ? 0 : 1,
    ledger: kinds.join(","),
  };
}

const frozenPools = (userId: number): number[] =>
  db
    .query<{ frozen: number }, [string]>(
      "SELECT frozen FROM compute_pools WHERE holder_kind = 'account' AND holder_ref = ?",
    )
    .all(String(userId))
    .map((r) => r.frozen);

/** What ending an account must have done to its compute: the job that never reached Tapis cancelled and
 *  released, the one at Tapis live with the intent and the reason recorded (the retried sweep cancels it
 *  there; no Tapis call is made in a batch), and the pool frozen. */
function expectComputeEnded(userId: number, ids: string[]): void {
  const [unsubmitted, atTapis] = ids as [string, string];
  expect(computeOf(unsubmitted)).toEqual({
    state: "cancelled",
    cancel_reason: "account_ended",
    cancel_requested: 1,
    ledger: "hold,release",
  });
  expect(computeOf(atTapis)).toEqual({
    state: "running",
    cancel_reason: "account_ended",
    cancel_requested: 1,
    ledger: "hold",
  });
  expect(frozenPools(userId)).toEqual([1]);
}

function ownerPost(path: string, body?: unknown): Promise<Response> {
  return app.request(
    path,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OWNER_KEY}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
    env(),
  );
}

beforeEach(async () => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  app.route("/auth", authDocsRoutes);
  await seedOwner();
});

describe("POST /admin/revoke/:username cascades into browser credentials", () => {
  test("revokes every session of both scopes and destroys outstanding grants", async () => {
    const userId = seedTarget();
    const { session } = await signInToDocs(userId);
    expect((await verify(session)).status).toBe(200);
    expect(liveSessionCount(userId)).toBe(2); // one app, one docs
    expect(grantCount(userId)).toBe(1);

    expect((await ownerPost("/admin/revoke/cascadetarget")).status).toBe(200);

    expect(liveSessionCount(userId, "app")).toBe(0);
    expect(liveSessionCount(userId, "docs")).toBe(0);
    expect(grantCount(userId)).toBe(0);
    expect((await verify(session)).status).toBe(401);
  });

  test("re-approval does not hand the old docs cookie back", async () => {
    // THE case. Before the cascade, revoke left the docs row live and merely
    // suppressed by the `users.status` join, so restoring the status restored
    // the credential -- from whatever browser still had the cookie, without
    // anyone signing in again.
    //
    // The status is restored with an UPDATE rather than through
    // `POST /admin/approve/:username` on purpose: approval mints IAM
    // credentials, and the subject here is what REVOKE destroyed, not what
    // approve builds. The UPDATE is the strongest possible form of the
    // precondition -- it grants the account everything approve would, and the
    // credential still must not come back.
    const userId = seedTarget();
    const { session, unspentCode } = await signInToDocs(userId);

    expect((await ownerPost("/admin/revoke/cascadetarget")).status).toBe(200);
    db.run("UPDATE users SET status = 'approved', revoked_at = NULL WHERE id = ?", [userId]);

    expect((await verify(session)).status).toBe(401);
    expect((await exchange(unspentCode)).status).toBe(400);
  });

  test("another account's credentials are untouched", async () => {
    const target = seedTarget();
    db.run(
      `INSERT INTO users (username, email, password_hash, status, role, email_verified, account_kind)
       VALUES ('cascadebystander', 'bystander@nemar.test', 'x', 'approved', 'admin', 1, 'person')`,
    );
    const bystander = db
      .query<{ id: number }, []>("SELECT id FROM users WHERE username='cascadebystander'")
      .get();
    if (!bystander) throw new Error("seed: bystander insert failed");
    const other = await signInToDocs(bystander.id);
    await signInToDocs(target);

    expect((await ownerPost("/admin/revoke/cascadetarget")).status).toBe(200);

    expect((await verify(other.session)).status).toBe(200);
    expect(grantCount(bystander.id)).toBe(1);
  });
});

describe("POST /admin/revoke/:username ends the account's compute in the same batch", () => {
  test("a job that never reached Tapis is cancelled and released, one at Tapis records the intent, the pool is frozen (MUTATION: remove the statements from finalizeRevocation)", async () => {
    const userId = seedTarget();
    const { ids } = await seedCompute(userId, ["unsubmitted", "at_tapis"]);
    expect(frozenPools(userId)).toEqual([0]);

    expect((await ownerPost("/admin/revoke/cascadetarget")).status).toBe(200);

    expectComputeEnded(userId, ids);
  });

  test("another account's compute is untouched", async () => {
    const target = seedTarget();
    await seedCompute(target, ["unsubmitted", "at_tapis"]);
    db.run(
      `INSERT INTO users (username, email, password_hash, status, role, email_verified, account_kind)
       VALUES ('cascadebystander2', 'bystander2@nemar.test', 'x', 'approved', 'member', 1, 'person')`,
    );
    const bystander = db
      .query<{ id: number }, []>("SELECT id FROM users WHERE username='cascadebystander2'")
      .get();
    if (!bystander) throw new Error("seed: bystander insert failed");
    const other = await seedCompute(bystander.id, ["unsubmitted", "at_tapis"]);
    const before = other.ids.map(computeOf);

    expect((await ownerPost("/admin/revoke/cascadetarget")).status).toBe(200);

    expect(other.ids.map(computeOf)).toEqual(before);
    expect(frozenPools(bystander.id)).toEqual([0]);
  });
});

describe("POST /admin/users/:username/role cascades on demotion", () => {
  test("a demotion destroys the docs session row, so a re-promotion cannot revive it", async () => {
    // `verify` re-reads the role on every page view, so a demoted admin is
    // refused immediately -- that part always worked. What survived was the ROW,
    // and re-promotion inside its eight hours made it live again.
    const userId = seedTarget();
    const { session, unspentCode } = await signInToDocs(userId);
    expect((await verify(session)).status).toBe(200);

    const demote = await ownerPost("/admin/users/cascadetarget/role", { role: "member" });
    expect(demote.status).toBe(200);
    expect((await verify(session)).status).toBe(401);
    expect(liveSessionCount(userId, "docs")).toBe(0);
    expect(grantCount(userId)).toBe(0);

    db.run("UPDATE users SET role = 'admin' WHERE id = ?", [userId]);
    expect((await verify(session)).status).toBe(401);
    expect((await exchange(unspentCode)).status).toBe(400);
  });

  test("the app session survives a demotion, because a demoted account is still a user", async () => {
    // The deliberate asymmetry. `resolveCookieUser` re-reads the role per
    // request, so there is nothing to force out of a browser session; killing it
    // would sign someone out of the dashboard for being demoted.
    const userId = seedTarget();
    await signInToDocs(userId);
    expect((await ownerPost("/admin/users/cascadetarget/role", { role: "member" })).status).toBe(
      200,
    );
    expect(liveSessionCount(userId, "app")).toBe(1);
  });

  test("the audit row counts the two revocations in the right order", async () => {
    // Both counts come out of one `db.batch` by INDEX, so a reordered batch
    // would silently swap `tokens_revoked` and `docs_sessions_revoked` in the
    // security record of a demotion. Reviewed and found unasserted: swapping the
    // two indices passed the entire suite. Two tokens and one docs session, so
    // the numbers cannot be confused with each other.
    const userId = seedTarget();
    for (const key of ["tok-a", "tok-b"]) {
      db.run("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)", [
        userId,
        key,
        key.slice(0, 8),
      ]);
    }
    await signInToDocs(userId);

    expect((await ownerPost("/admin/users/cascadetarget/role", { role: "member" })).status).toBe(
      200,
    );

    const audit = db
      .query<{ details: string }, []>(
        "SELECT details FROM audit_log WHERE action = 'role_changed' ORDER BY id DESC LIMIT 1",
      )
      .get();
    if (!audit) throw new Error("no role_changed audit row");
    const details = JSON.parse(audit.details) as {
      tokens_revoked: number;
      docs_sessions_revoked: number;
    };
    expect(details.tokens_revoked).toBe(2);
    expect(details.docs_sessions_revoked).toBe(1);
  });

  test("a demotion does NOT end compute: a member still has an account, a grant and jobs", async () => {
    // Compute has nothing to do with an admin's standing (`compute-release.ts` says why), so the one
    // cascade that ends what exists only for admins leaves jobs and pools exactly as they were.
    const userId = seedTarget();
    const { ids } = await seedCompute(userId, ["unsubmitted", "at_tapis"]);
    const before = ids.map(computeOf);

    expect((await ownerPost("/admin/users/cascadetarget/role", { role: "member" })).status).toBe(
      200,
    );

    expect(ids.map(computeOf)).toEqual(before);
    expect(frozenPools(userId)).toEqual([0]);
  });

  test("a PROMOTION leaves the account's credentials alone", async () => {
    // The cascade is keyed on demotion, so this pins that an upgrade is not
    // quietly signing people out of the documentation.
    const userId = seedTarget();
    const { session } = await signInToDocs(userId);
    expect((await ownerPost("/admin/users/cascadetarget/role", { role: "owner" })).status).toBe(
      200,
    );
    expect((await verify(session)).status).toBe(200);
    expect(grantCount(userId)).toBe(1);
  });
});

describe("DELETE /admin/users/by-id/:id cascades too", () => {
  /** The tombstone is a caller of the grants purge, and the one the first version of this PR
   *  added without a test: deleting that statement from the batch left the whole suite green.
   *  The batch now lives in `tombstoneUserCascade`, which the scheduled test-account sweep runs
   *  as well; this drives it through the real route, and `test/user-soft-delete.unit.test.ts`
   *  drives the same function against the full migrated schema. */
  test("a tombstone revokes every session and destroys the grants", async () => {
    const userId = seedTarget();
    const { session, unspentCode } = await signInToDocs(userId);
    expect((await verify(session)).status).toBe(200);

    const res = await app.request(
      `/admin/users/by-id/${userId}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${OWNER_KEY}` } },
      env(),
    );
    expect(res.status).toBe(200);

    expect(liveSessionCount(userId)).toBe(0);
    expect(grantCount(userId)).toBe(0);
    expect((await verify(session)).status).toBe(401);
    expect((await exchange(unspentCode)).status).toBe(400);
  });

  test("a tombstone ends the account's compute in the same batch (MUTATION: remove the statements from tombstoneUserCascade)", async () => {
    const userId = seedTarget();
    const { ids } = await seedCompute(userId, ["unsubmitted", "at_tapis"]);

    const res = await app.request(
      `/admin/users/by-id/${userId}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${OWNER_KEY}` } },
      env(),
    );
    expect(res.status).toBe(200);

    expectComputeEnded(userId, ids);
  });

  test("the audit row's session count is the session count, not the grant count", async () => {
    // `sessions_revoked` is read out of the batch by index, and the new grants
    // purge went in one slot BEHIND it, at index 3. Nothing shifted, which is
    // the point of pinning it: the next statement added to that batch could go
    // either side, and only an assertion decides whether that is noticed. Two
    // sessions and one grant, so an
    // off-by-one in either direction shows up as a wrong number.
    const userId = seedTarget();
    await signInToDocs(userId);

    await app.request(
      `/admin/users/by-id/${userId}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${OWNER_KEY}` } },
      env(),
    );

    const audit = db
      .query<{ details: string }, []>(
        "SELECT details FROM audit_log WHERE action = 'user_deleted' ORDER BY id DESC LIMIT 1",
      )
      .get();
    if (!audit) throw new Error("no user_deleted audit row");
    const details = JSON.parse(audit.details) as { sessions_revoked: number };
    expect(details.sessions_revoked).toBe(2);
  });
});
