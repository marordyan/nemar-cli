/**
 * How long a finished logout delivery is kept (epic #2014 phase #2019; ADR 0119 rule 15): the
 * production tick deletes `sent` and `fenced` rows older than 30 days and `failed` rows older than 180,
 * after its delivery work, at most 500 a tick, and never a `pending` row (which is also what an attempt
 * in flight is).
 *
 * The windows are DEFAULTS pending the owner's decision before the first client registers (a row holds the
 * pseudonymous `sub` of possibly deleted accounts, so this is also data minimisation); they are pinned
 * here as literals so changing one is a change to this test, which is where the owner's decision is
 * recorded. Time is moved in SQL, by editing the rows' own stamps, never by a clock.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import {
  OIDC_LOGOUT_FAILED_RETENTION_DAYS,
  OIDC_LOGOUT_FENCED_RETENTION_DAYS,
  OIDC_LOGOUT_PRUNE_PER_TICK,
  OIDC_LOGOUT_SENT_RETENTION_DAYS,
} from "../../shared/oidc";
import { logoutTickLogLine, runOidcLogoutRetryTick } from "../src/services/oidc-logout";
import { wrapD1 } from "./helpers/d1";
import {
  clientRowId,
  deliveries,
  registerLogoutClient,
  seedProvenAccount,
  signInAt,
  subjectOf,
} from "./helpers/oidc-cascade";
import { rotateKeys } from "./helpers/oidc-flow";
import { type OidcHarness, startOidcHarness } from "./helpers/oidc-harness";

let h: OidcHarness;
let clientRow: number;
let sub: string;

beforeEach(async () => {
  h = await startOidcHarness({ HOST_PREFIXED_SESSION_COOKIE: "1" });
  await rotateKeys(h);
  const client = await registerLogoutClient(h);
  const userId = seedProvenAccount(h);
  await signInAt(h, userId, client);
  await h.settle();
  h.db.query("DELETE FROM oidc_logout_deliveries").run();
  clientRow = clientRowId(h, client);
  sub = subjectOf(h, userId);
});

const production = () => ({ ...h.env, ENVIRONMENT: "production" }) as never;

type Status = "pending" | "sent" | "failed" | "fenced";

/** A delivery in `status` whose relevant stamp is `days` old (`created_at` is as old, unless `createdDays`). */
function put(status: Status, days: number, createdDays: number = days): number {
  const next = status === "pending" ? "datetime('now', '+1 hour')" : "NULL";
  const sentAt = status === "sent" ? `datetime('now', '-${days} days')` : "NULL";
  return h.db
    .query<{ id: number }, [number, string, string]>(
      `INSERT INTO oidc_logout_deliveries (client_id, sub, reason, status, next_attempt_at, sent_at, created_at)
       VALUES (?, ?, 'account_revoked', ?, ${next}, ${sentAt}, datetime('now', '-${createdDays} days'))
       RETURNING id`,
    )
    .get(clientRow, sub, status)?.id as number;
}

const ids = () => deliveries(h).map((d) => d.id);

describe("the windows", () => {
  test("are the defaults the ADR records: 30, 30 and 180 days, 500 a tick", () => {
    expect(OIDC_LOGOUT_SENT_RETENTION_DAYS).toBe(30);
    expect(OIDC_LOGOUT_FENCED_RETENTION_DAYS).toBe(30);
    expect(OIDC_LOGOUT_FAILED_RETENTION_DAYS).toBe(180);
    expect(OIDC_LOGOUT_PRUNE_PER_TICK).toBe(500);
  });
});

describe("the production tick prunes finished deliveries past their window", () => {
  test("sent after 30 days, fenced after 30, failed after 180, and not a day sooner", async () => {
    const keep = [
      put("sent", 29),
      put("fenced", 29),
      put("failed", 179),
      // A failed row is not pruned at 31 days: its window is the longer one.
      put("failed", 31),
    ];
    const drop = [put("sent", 31), put("fenced", 31), put("failed", 181)];

    const tally = await runOidcLogoutRetryTick(production());

    expect(tally?.pruned).toBe(3);
    expect(ids()).toEqual(keep);
    expect(drop.some((id) => ids().includes(id))).toBe(false);
  });

  test("a sent row is aged by when it was SENT, not by when it was queued", async () => {
    // Queued 100 days ago, sent yesterday (a retry that finally got through): kept.
    const late = put("sent", 1, 100);
    // Queued yesterday, sent 40 days ago is impossible; the mirror case: sent 40 days ago, queued 41.
    const old = put("sent", 40, 41);
    await runOidcLogoutRetryTick(production());
    expect(ids()).toEqual([late]);
    expect(ids().includes(old)).toBe(false);
  });

  test("a pending row is never pruned, however old, and neither is one an attempt holds", async () => {
    const waiting = put("pending", 400);
    const inFlight = put("pending", 400);
    h.db
      .query(
        "UPDATE oidc_logout_deliveries SET attempts = 2, jti = ?, next_attempt_at = datetime('now', '+2 minutes') WHERE id = ?",
      )
      .run("a".repeat(32), inFlight);
    const old = put("sent", 400);

    const tally = await runOidcLogoutRetryTick(production());

    expect(tally?.pruned).toBe(1);
    expect(ids()).toEqual([waiting, inFlight]);
    expect(ids().includes(old)).toBe(false);
  });

  test("at most 500 a tick, oldest first, and the next tick takes the rest", async () => {
    const inserted: number[] = [];
    for (let i = 0; i < 600; i++) inserted.push(put("sent", 31));

    const first = await runOidcLogoutRetryTick(production());
    expect(first?.pruned).toBe(500);
    // The oldest went first: what is left is the 100 newest of the ids that were inserted.
    expect(ids()).toEqual(inserted.slice(500));

    const second = await runOidcLogoutRetryTick(production());
    expect(second?.pruned).toBe(100);
    expect(deliveries(h)).toEqual([]);
  });

  test("it is production only: a tick outside production leaves old rows where they are", async () => {
    put("sent", 400);
    put("failed", 400);
    for (const environment of ["development", "staging", "test", "", undefined, "Production"]) {
      const result = await runOidcLogoutRetryTick({ ...h.env, ENVIRONMENT: environment } as never);
      expect({ environment, result }).toEqual({ environment, result: null });
    }
    expect(deliveries(h).length).toBe(2);
  });

  test("it comes AFTER the delivery work, and a prune that fails costs nothing else", async () => {
    // A due delivery whose client is gone: the tick finishes it (`failed`, no request) without a partner.
    h.db
      .query(
        "INSERT INTO oidc_logout_deliveries (client_id, sub, reason, next_attempt_at) VALUES (987654, ?, 'account_revoked', datetime('now', '-1 minutes'))",
      )
      .run(sub);
    put("sent", 400);
    const order: string[] = [];
    const faulty = wrapD1(h.env.DB, (sql) => {
      if (sql.includes("FROM oidc_logout_deliveries d")) order.push("due");
      if (sql.startsWith("DELETE FROM oidc_logout_deliveries")) {
        order.push("prune");
        throw new RangeError("prune fault with secret-text");
      }
    });

    const tally = await runOidcLogoutRetryTick({
      ...h.env,
      DB: faulty,
      ENVIRONMENT: "production",
    } as never);

    expect(order).toEqual(["due", "prune"]);
    expect(tally).toMatchObject({
      examined: 1,
      failed: 1,
      pruned: 0,
      errors: 1,
      errorClass: "RangeError",
    });
    expect(logoutTickLogLine(tally as never)?.line).not.toContain("secret-text");
    // The delivery work landed; the old row stays for the next tick.
    expect(
      deliveries(h)
        .map((d) => d.status)
        .sort(),
    ).toEqual(["failed", "sent"]);
  });

  test("the log line says how many were pruned, and a tick that only pruned is not silent", async () => {
    put("sent", 400);
    const tally = await runOidcLogoutRetryTick(production());
    expect(logoutTickLogLine(tally as never)).toEqual({
      level: "info",
      line: "[oidc-logout] examined=0 sent=0 retried=0 failed=0 fenced=0 lost=0 errors=0 pruned=1",
    });
    const nothing = await runOidcLogoutRetryTick(production());
    expect(logoutTickLogLine(nothing as never)).toBeNull();
  });
});
