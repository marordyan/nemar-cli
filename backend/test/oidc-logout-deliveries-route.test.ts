/**
 * `GET /admin/oidc/logout-deliveries`, the owner's read view of the back-channel logouts (epic #2014
 * phase #2019; ADR 0119 rule 15), through the REAL Worker.
 *
 * Held: the owner's role and the OIDC surface, as for every route under `/admin/oidc/` (the generic
 * walks in `oidc-admin-routes.test.ts` reach this route too); the listing, newest first, naming the
 * client by its PUBLIC id and never by the row id the table stores; the `status` filter and the `limit`;
 * a count of every status whatever the filter; and that the view carries no token, no address and no
 * partner text, and writes nothing.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { oidcLogoutDeliveriesResponseSchema } from "../../shared/contract/oidc-admin";
import { OIDC_LOGOUT_STATUSES } from "../../shared/oidc";
import {
  clientRowId,
  registerLogoutClient,
  seedProvenAccount,
  signInAt,
  subjectOf,
} from "./helpers/oidc-cascade";
import { type RegisteredClient, rotateKeys } from "./helpers/oidc-flow";
import {
  ADMIN_KEY,
  MEMBER_KEY,
  OWNER_KEY,
  type OidcHarness,
  startOidcHarness,
} from "./helpers/oidc-harness";

let h: OidcHarness;
let client: RegisteredClient;
let sub: string;

beforeEach(async () => {
  h = await startOidcHarness({ HOST_PREFIXED_SESSION_COOKIE: "1" });
  await rotateKeys(h);
  client = await registerLogoutClient(h);
  const userId = seedProvenAccount(h);
  await signInAt(h, userId, client);
  await h.settle();
  sub = subjectOf(h, userId);
});

const PATH = "/admin/oidc/logout-deliveries";
const list = (query = "", key: string | null = OWNER_KEY) =>
  h.call("GET", `${PATH}${query}`, { key });

/** Queue a delivery in the state a sender would have left it in. */
function put(
  status: "pending" | "sent" | "failed" | "fenced",
  over: {
    client_id?: number;
    attempts?: number;
    last_status?: number | null;
    last_error_class?: string | null;
    jti?: string | null;
  } = {},
): number {
  const next = status === "pending" ? "datetime('now', '+1 hour')" : "NULL";
  const sentAt = status === "sent" ? "datetime('now')" : "NULL";
  const row = h.db
    .query<{ id: number }, Array<string | number | null>>(
      `INSERT INTO oidc_logout_deliveries
         (client_id, sub, reason, status, attempts, next_attempt_at, sent_at, last_status, last_error_class, jti)
       VALUES (?, ?, 'account_revoked', ?, ?, ${next}, ${sentAt}, ?, ?, ?) RETURNING id`,
    )
    .get(
      over.client_id ?? clientRowId(h, client),
      sub,
      status,
      over.attempts ?? 1,
      over.last_status ?? null,
      over.last_error_class ?? null,
      over.jti ?? null,
    );
  return row?.id as number;
}

describe("who may read it", () => {
  test("only the owner: 401 with no key, 403 for an administrator and a member", async () => {
    put("sent");
    expect((await list("", null)).status).toBe(401);
    expect((await list("", ADMIN_KEY)).status).toBe(403);
    expect((await list("", MEMBER_KEY)).status).toBe(403);
    expect((await list()).status).toBe(200);
  });

  test("404 off the issuer's host", async () => {
    const res = await h.call("GET", PATH, { key: OWNER_KEY, base: "https://app.nemar.org" });
    expect(res.status).toBe(404);
  });
});

describe("the listing", () => {
  test("is newest first, names the client by its public id, and fits the contract", async () => {
    const first = put("sent");
    const second = put("failed", { last_status: 400, last_error_class: "http_4xx" });
    const third = put("pending", { last_status: 503, last_error_class: "http_5xx", attempts: 2 });

    const res = await list();

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = oidcLogoutDeliveriesResponseSchema.parse(res.json);
    expect(body.deliveries.map((d) => d.id)).toEqual([third, second, first]);
    expect(body.deliveries[0]).toMatchObject({
      client_id: client.clientId,
      sub,
      reason: "account_revoked",
      status: "pending",
      attempts: 2,
      last_status: 503,
      last_error_class: "http_5xx",
    });
    expect(body.counts).toEqual({ pending: 1, sent: 1, failed: 1, fenced: 0 });
  });

  test("carries nothing but the view: no address, no token, no secret, no row id of a client", async () => {
    put("sent", { jti: "a".repeat(32) });
    const res = await list();
    const row = (res.json?.deliveries as Array<Record<string, unknown>>)[0] as Record<
      string,
      unknown
    >;
    expect(Object.keys(row).sort()).toEqual([
      "attempts",
      "client_id",
      "created_at",
      "id",
      "jti",
      "last_error_class",
      "last_status",
      "next_attempt_at",
      "reason",
      "sent_at",
      "status",
      "sub",
    ]);
    expect(res.text).not.toContain("partner.example.org");
    expect(res.text).not.toContain("logout_token");
    expect(typeof row.client_id).toBe("string");
  });

  test("a delivery whose client is gone shows no client, and is still listed", async () => {
    put("failed", { client_id: 987654, last_error_class: "client_disabled" });
    const res = await list();
    expect((res.json?.deliveries as Array<{ client_id: unknown }>)[0]?.client_id).toBeNull();
  });

  test("an empty table is an empty list and four zero counts", async () => {
    const res = await list();
    expect(res.json).toEqual({
      deliveries: [],
      counts: { pending: 0, sent: 0, failed: 0, fenced: 0 },
    });
  });

  test("it writes nothing", async () => {
    put("sent");
    const audit = () =>
      h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM audit_log").get()?.n;
    const before = {
      audit: audit(),
      rows: h.db.query("SELECT * FROM oidc_logout_deliveries").all(),
    };
    await list();
    await list("?status=sent");
    expect({
      audit: audit(),
      rows: h.db.query("SELECT * FROM oidc_logout_deliveries").all(),
    }).toEqual(before);
  });
});

describe("the filter and the limit", () => {
  test("?status= lists one status, and the counts still say how many there are of every one", async () => {
    put("sent");
    put("sent");
    put("failed");
    put("fenced");
    for (const status of OIDC_LOGOUT_STATUSES) {
      const res = await list(`?status=${status}`);
      const rows = res.json?.deliveries as Array<{ status: string }>;
      expect(new Set(rows.map((r) => r.status)).size).toBeLessThanOrEqual(1);
      expect(rows.every((r) => r.status === status)).toBe(true);
      expect(res.json?.counts).toEqual({ pending: 0, sent: 2, failed: 1, fenced: 1 });
    }
    expect(((await list("?status=sent")).json?.deliveries as unknown[]).length).toBe(2);
  });

  test("a status that is not one is 400 invalid_status, and nothing is listed", async () => {
    put("sent");
    for (const bad of ["queued", "SENT", "sent,failed", "", "%27"]) {
      const res = await list(`?status=${bad}`);
      expect({ bad, status: res.status, code: res.json?.code }).toEqual({
        bad,
        status: 400,
        code: "invalid_status",
      });
    }
  });

  test("?limit= bounds the listing, from 1 to 500, and anything else is 400", async () => {
    for (let i = 0; i < 3; i++) put("sent");
    expect(((await list("?limit=2")).json?.deliveries as unknown[]).length).toBe(2);
    expect(((await list("?limit=500")).json?.deliveries as unknown[]).length).toBe(3);
    for (const bad of ["0", "501", "-1", "1.5", "abc", "", "007"]) {
      const res = await list(`?limit=${bad}`);
      expect({ bad, status: res.status, code: res.json?.code }).toEqual({
        bad,
        status: 400,
        code: "invalid_body",
      });
    }
  });
});
