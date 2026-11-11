/**
 * The revocation cascade and the delivery store's statements on Miniflare's D1, the implementation
 * `wrangler dev` and `wrangler d1 ... --local` run (epic #2014 phase #2019).
 *
 * Every other suite runs these statements on bun:sqlite, which accepts SQL that D1 refuses (a GLOB over
 * 50 bytes, a compound select over six terms, a construct newer than D1's SQLite). The cascade uses an
 * `INSERT ... SELECT` over a three-way join, `json_each` in a correlated subquery, `IN` subqueries
 * inside an `UPDATE` and a `DELETE`, a `RETURNING`-free conditional claim and a `CASE` in a record,
 * and the first version of `test-account-sweep.ts` shows what happens when only bun:sqlite sees them
 * (every test green, the real statement refused). So each real statement, as the real functions build
 * it, is run here on D1 itself.
 *
 * The rows are written straight into the tables (the flow that makes them is proven through the real
 * routes elsewhere); what is asserted is what each statement does to them.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { oidcClientEndStatements, oidcEndStatements } from "../src/services/oidc-cascade";
import {
  CLAIM_DELIVERY_SQL,
  COUNT_DELIVERIES_SQL,
  DUE_DELIVERIES_FOR_USER_SQL,
  DUE_DELIVERIES_SQL,
  FINISH_WITHOUT_SEND_SQL,
  LIST_DELIVERIES_SQL,
  RECORD_ATTEMPT_SQL,
  claimDelivery,
  dueDeliveries,
  finishWithoutSend,
  pruneDeliveries,
  recordAttempt,
} from "../src/services/oidc-logout-store";
import { applyMigrations, migrationFiles } from "./helpers/miniflare-d1";

let mf: Miniflare;
let d1: D1Database;
let counter = 0;

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response(null, { status: 204 }); } };",
    compatibilityDate: "2024-12-01",
    d1Databases: ["DB"],
  });
  d1 = (await mf.getD1Database("DB")) as unknown as D1Database;
  await applyMigrations(d1, migrationFiles());
}, 180_000);

afterAll(async () => {
  await mf?.dispose();
});

const HASH = (n: number) => n.toString(16).padStart(64, "0");
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

async function run(sql: string, ...binds: unknown[]): Promise<number> {
  const r = await d1
    .prepare(sql)
    .bind(...binds)
    .run();
  return r.meta.changes ?? 0;
}

async function one<T>(sql: string, ...binds: unknown[]): Promise<T> {
  const row = await d1
    .prepare(sql)
    .bind(...binds)
    .first<T>();
  if (!row) throw new Error("expected a row");
  return row;
}

async function all<T>(sql: string, ...binds: unknown[]): Promise<T[]> {
  return (
    await d1
      .prepare(sql)
      .bind(...binds)
      .all<T>()
  ).results;
}

/** An account, and a client with or without a logout address, each with a live grant, two tokens and a code. */
async function seed(
  opts: { rule?: string; logout?: boolean; scopes?: string[]; clientStatus?: string } = {},
): Promise<{ userId: number; clientRow: number; sub: string }> {
  counter += 1;
  const name = `d1cascade${counter}`;
  await run(
    "INSERT INTO users (username, email, password_hash, status, role, email_verified) VALUES (?, ?, 'x', 'verified', 'member', 1)",
    name,
    `${name}@example.org`,
  );
  const user = await one<{ id: number; oidc_subject: string }>(
    "SELECT id, oidc_subject FROM users WHERE username = ?",
    name,
  );
  const disabled = opts.clientStatus === "disabled";
  await run(
    `INSERT INTO oidc_clients (client_id, name, secret_hash, redirect_uris, allowed_scopes, allowed_grants,
       sign_in_rule, first_party, consent_mode, backchannel_logout_uri, audience, status, disabled_at, created_by)
     VALUES (?, ?, ?, '["https://client.example.org/callback"]', '["openid","compute.read"]',
       '["authorization_code"]', ?, 0, 'ask_once', ?, 'https://api.example.org', ?, ${disabled ? "datetime('now')" : "NULL"}, 1)`,
    `oc_${counter.toString(16).padStart(24, "d")}`,
    `D1 client ${counter}`,
    HASH(counter),
    opts.rule ?? "active_account",
    opts.logout === false ? null : "https://partner.example.org/logout",
    disabled ? "disabled" : "active",
  );
  const client = await one<{ id: number }>(
    "SELECT id FROM oidc_clients WHERE name = ?",
    `D1 client ${counter}`,
  );
  await run(
    "INSERT INTO oidc_grants (user_id, client_id, scopes, consent_kind) VALUES (?, ?, ?, 'user')",
    user.id,
    client.id,
    JSON.stringify(opts.scopes ?? ["openid"]),
  );
  const grant = await one<{ id: number }>(
    "SELECT id FROM oidc_grants WHERE user_id = ? AND client_id = ?",
    user.id,
    client.id,
  );
  await run(
    `INSERT INTO oidc_codes (code_hash, client_id, user_id, grant_id, redirect_uri, scopes, code_challenge, auth_time, expires_at)
     VALUES (?, ?, ?, ?, 'https://client.example.org/callback', '["openid"]', ?, datetime('now'), datetime('now', '+60 seconds'))`,
    HASH(100_000 + counter),
    client.id,
    user.id,
    grant.id,
    CHALLENGE,
  );
  const code = await one<{ id: number }>(
    "SELECT id FROM oidc_codes WHERE code_hash = ?",
    HASH(100_000 + counter),
  );
  for (const kind of ["access", "refresh"] as const) {
    await run(
      `INSERT INTO oidc_tokens (token_hash, kind, client_id, user_id, grant_id, code_id, family_id, audience, scopes,
         expires_at, absolute_expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'https://api.example.org', '["openid"]', datetime('now', '+10 minutes'),
         CASE WHEN ? = 'refresh' THEN datetime('now', '+90 days') END)`,
      HASH(200_000 + counter * 10 + (kind === "access" ? 1 : 2)),
      kind,
      client.id,
      user.id,
      grant.id,
      code.id,
      "e".repeat(32),
      kind,
    );
  }
  return { userId: user.id, clientRow: client.id, sub: user.oidc_subject };
}

async function batch(statements: Array<{ sql: string; binds: unknown[] }>) {
  return d1.batch(statements.map((s) => d1.prepare(s.sql).bind(...s.binds)));
}

const live = (userId: number) =>
  one<{ grants: number; tokens: number; codes: number }>(
    `SELECT (SELECT COUNT(*) FROM oidc_grants WHERE user_id = ?1 AND revoked_at IS NULL) AS grants,
            (SELECT COUNT(*) FROM oidc_tokens WHERE user_id = ?1 AND revoked_at IS NULL) AS tokens,
            (SELECT COUNT(*) FROM oidc_codes WHERE user_id = ?1 AND used_at IS NULL) AS codes`,
    userId,
  );

describe("the cascade on D1", () => {
  test("the unfiltered statements end everything and queue only for an active client with an address", async () => {
    const withAddress = await seed();
    const noAddress = await seed({ logout: false });
    // Two clients for ONE account: give the first account a second grant at the second client.
    await run(
      "INSERT INTO oidc_grants (user_id, client_id, scopes, consent_kind) VALUES (?, ?, '[\"openid\"]', 'user')",
      withAddress.userId,
      noAddress.clientRow,
    );
    const results = await batch(oidcEndStatements(withAddress.userId, "account_revoked"));
    expect(results.map((r) => r.meta.changes)).toEqual([1, 2, 2, 1]);
    expect(await live(withAddress.userId)).toEqual({ grants: 0, tokens: 0, codes: 0 });
    const queued = await all<{ client_id: number; sub: string; reason: string; status: string }>(
      "SELECT client_id, sub, reason, status FROM oidc_logout_deliveries WHERE sub = ?",
      withAddress.sub,
    );
    expect(queued).toEqual([
      {
        client_id: withAddress.clientRow,
        sub: withAddress.sub,
        reason: "account_revoked",
        status: "pending",
      },
    ]);
    // Another account at the clients that have nothing queued is untouched.
    expect(await live(noAddress.userId)).toEqual({ grants: 1, tokens: 2, codes: 1 });
  });

  test("a client disabled by hand is not queued, on D1, and its grants still end", async () => {
    const disabled = await seed({ clientStatus: "disabled" });
    const results = await batch(oidcEndStatements(disabled.userId, "account_revoked"));
    expect(results.map((r) => r.meta.changes)).toEqual([0, 2, 1, 1]);
    expect(await live(disabled.userId)).toEqual({ grants: 0, tokens: 0, codes: 0 });
  });

  test("the rule filter ends only the grants of that rule, on D1", async () => {
    const proven = await seed({ rule: "person_proven_orcid" });
    const open = await seed({ rule: "active_account" });
    // The same account holds both: a grant at the other account's client.
    await run(
      "INSERT INTO oidc_grants (user_id, client_id, scopes, consent_kind) VALUES (?, ?, '[\"openid\"]', 'user')",
      proven.userId,
      open.clientRow,
    );
    const results = await batch(
      oidcEndStatements(proven.userId, "orcid_changed", { rule: "person_proven_orcid" }),
    );
    expect(results.map((r) => r.meta.changes)).toEqual([1, 2, 1, 1]);
    expect(await live(proven.userId)).toEqual({ grants: 1, tokens: 0, codes: 0 });
    expect(await live(open.userId)).toEqual({ grants: 1, tokens: 2, codes: 1 });
  });

  test("the scope filter reads a JSON array with json_each, on D1", async () => {
    const compute = await seed({ scopes: ["openid", "compute.read"] });
    const plain = await seed({ scopes: ["openid"] });
    await run(
      "INSERT INTO oidc_grants (user_id, client_id, scopes, consent_kind) VALUES (?, ?, '[\"openid\"]', 'user')",
      compute.userId,
      plain.clientRow,
    );
    const results = await batch(
      oidcEndStatements(compute.userId, "compute_suspended", { scopePrefix: "compute." }),
    );
    expect(results.map((r) => r.meta.changes)).toEqual([1, 2, 1, 1]);
    expect(await live(compute.userId)).toEqual({ grants: 1, tokens: 0, codes: 0 });
    expect(await live(plain.userId)).toEqual({ grants: 1, tokens: 2, codes: 1 });
  });

  test("a predicate appended to every statement is honoured, as a guard appends one", async () => {
    const a = await seed();
    for (const s of oidcEndStatements(a.userId, "account_deleted")) {
      expect(await run(`${s.sql} AND ? = 0`, ...s.binds, 1)).toBe(0);
    }
    expect(await live(a.userId)).toEqual({ grants: 1, tokens: 2, codes: 1 });
  });

  test("the client's ending revokes what it holds by its public id, and queues nothing", async () => {
    const a = await seed();
    const before = await one<{ n: number }>("SELECT COUNT(*) AS n FROM oidc_logout_deliveries");
    const clientId = (
      await one<{ client_id: string }>(
        "SELECT client_id FROM oidc_clients WHERE id = ?",
        a.clientRow,
      )
    ).client_id;
    const results = await batch(oidcClientEndStatements(clientId));
    expect(results.map((r) => r.meta.changes)).toEqual([2, 1, 1]);
    expect(await live(a.userId)).toEqual({ grants: 0, tokens: 0, codes: 0 });
    expect(await one<{ n: number }>("SELECT COUNT(*) AS n FROM oidc_logout_deliveries")).toEqual(
      before,
    );
  });
});

describe("the delivery store on D1", () => {
  async function queueOne(over = "datetime('now', '-1 minutes')") {
    const a = await seed();
    await run(
      `INSERT INTO oidc_logout_deliveries (client_id, sub, reason, next_attempt_at) VALUES (?, ?, 'account_revoked', ${over})`,
      a.clientRow,
      a.sub,
    );
    const row = await one<{ id: number }>(
      "SELECT id FROM oidc_logout_deliveries WHERE sub = ? ORDER BY id DESC LIMIT 1",
      a.sub,
    );
    return { ...a, id: row.id };
  }

  test("what is due is read with its client, for all accounts and for one", async () => {
    const due = await queueOne();
    const later = await queueOne("datetime('now', '+1 hour')");
    const everything = await dueDeliveries(d1, 50);
    expect(everything.map((r) => r.id)).toContain(due.id);
    expect(everything.map((r) => r.id)).not.toContain(later.id);
    expect(everything.find((r) => r.id === due.id)).toMatchObject({
      attempts: 0,
      sub: due.sub,
      client_status: "active",
      uri: "https://partner.example.org/logout",
    });
    expect((await dueDeliveries(d1, 50, due.userId)).map((r) => r.id)).toEqual([due.id]);
    expect(DUE_DELIVERIES_SQL).toContain("LIMIT ?");
    expect(DUE_DELIVERIES_FOR_USER_SQL).toContain("oidc_subject");
  });

  test("the claim is won once, and the record needs the claim's jti", async () => {
    const a = await queueOne();
    expect(await claimDelivery(d1, a.id, 0, "1".repeat(32))).toBe(true);
    expect(await claimDelivery(d1, a.id, 0, "2".repeat(32))).toBe(false);
    // The claim holds the row: it is not due again until the lease lapses.
    expect((await dueDeliveries(d1, 50, a.userId)).length).toBe(0);
    // A record that names another attempt's jti changes nothing.
    expect(
      await recordAttempt(d1, a.id, "2".repeat(32), {
        status: "sent",
        retryDelaySeconds: 0,
        lastStatus: 200,
        errorClass: null,
      }),
    ).toBe(false);
    expect(
      await recordAttempt(d1, a.id, "1".repeat(32), {
        status: "pending",
        retryDelaySeconds: 60,
        lastStatus: 503,
        errorClass: "http_5xx",
      }),
    ).toBe(true);
    const row = await one<{
      status: string;
      attempts: number;
      last_status: number;
      sent_at: string | null;
      delay: number;
    }>(
      `SELECT status, attempts, last_status, sent_at,
              CAST(strftime('%s', next_attempt_at) AS INTEGER) - CAST(strftime('%s', 'now') AS INTEGER) AS delay
         FROM oidc_logout_deliveries WHERE id = ?`,
      a.id,
    );
    expect(row).toMatchObject({ status: "pending", attempts: 1, last_status: 503, sent_at: null });
    expect(Math.abs(row.delay - 60)).toBeLessThanOrEqual(5);
    // Sent: `sent_at` set and `next_attempt_at` cleared, as the table's CHECKs require.
    await run(
      "UPDATE oidc_logout_deliveries SET next_attempt_at = datetime('now', '-1 seconds') WHERE id = ?",
      a.id,
    );
    expect(await claimDelivery(d1, a.id, 1, "3".repeat(32))).toBe(true);
    expect(
      await recordAttempt(d1, a.id, "3".repeat(32), {
        status: "sent",
        retryDelaySeconds: 0,
        lastStatus: 204,
        errorClass: null,
      }),
    ).toBe(true);
    expect(
      await one(
        "SELECT status, attempts, next_attempt_at, sent_at IS NOT NULL AS sent FROM oidc_logout_deliveries WHERE id = ?",
        a.id,
      ),
    ).toEqual({ status: "sent", attempts: 2, next_attempt_at: null, sent: 1 });
  });

  test("a delivery that is not to be sent is finished without a claim, and only while it is due", async () => {
    const a = await queueOne();
    const later = await queueOne("datetime('now', '+1 hour')");
    expect(await finishWithoutSend(d1, later.id, { status: "fenced", errorClass: "fenced" })).toBe(
      false,
    );
    expect(await finishWithoutSend(d1, a.id, { status: "fenced", errorClass: "fenced" })).toBe(
      true,
    );
    expect(await finishWithoutSend(d1, a.id, { status: "fenced", errorClass: "fenced" })).toBe(
      false,
    );
    expect(
      await one(
        "SELECT status, attempts, next_attempt_at, last_error_class FROM oidc_logout_deliveries WHERE id = ?",
        a.id,
      ),
    ).toEqual({
      status: "fenced",
      attempts: 0,
      next_attempt_at: null,
      last_error_class: "fenced",
    });
    expect(CLAIM_DELIVERY_SQL).toContain("attempts = attempts + 1");
    expect(RECORD_ATTEMPT_SQL).toContain("jti = ?");
    expect(FINISH_WITHOUT_SEND_SQL).toContain("next_attempt_at <= datetime('now')");
  });

  test("the prune deletes finished rows past their window and never a pending one, on D1", async () => {
    const old = await queueOne("datetime('now', '-1 minutes')");
    await run(
      "UPDATE oidc_logout_deliveries SET status = 'sent', next_attempt_at = NULL, sent_at = datetime('now', '-40 days') WHERE id = ?",
      old.id,
    );
    const waiting = await queueOne("datetime('now', '+1 hour')");
    await run(
      "UPDATE oidc_logout_deliveries SET created_at = datetime('now', '-400 days') WHERE id = ?",
      waiting.id,
    );
    expect(await pruneDeliveries(d1)).toBeGreaterThanOrEqual(1);
    expect(await all("SELECT id FROM oidc_logout_deliveries WHERE id = ?", old.id)).toEqual([]);
    expect(await all("SELECT id FROM oidc_logout_deliveries WHERE id = ?", waiting.id)).toEqual([
      { id: waiting.id },
    ]);
  });

  test("the owner's view lists newest first with the public client id, and counts every status", async () => {
    const a = await queueOne();
    const rows = await all<{ id: number; client_id: string | null; status: string }>(
      LIST_DELIVERIES_SQL,
      null,
      null,
      5,
    );
    expect(rows[0]?.id).toBeGreaterThanOrEqual(a.id);
    expect(typeof rows[0]?.client_id).toBe("string");
    expect(rows[0]?.client_id?.startsWith("oc_")).toBe(true);
    const filtered = await all<{ status: string }>(LIST_DELIVERIES_SQL, "fenced", "fenced", 500);
    expect(filtered.every((r) => r.status === "fenced")).toBe(true);
    const counts = await all<{ status: string; n: number }>(COUNT_DELIVERIES_SQL);
    expect(counts.map((c) => c.status).sort()).toEqual(
      expect.arrayContaining(["pending", "sent", "fenced"]),
    );
  });
});
