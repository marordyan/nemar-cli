/**
 * `POST /admin/oidc/accounts/:id/end`, the owner's command for the manual merge of ADR 0043 and the
 * incident tool (epic #2014 phase #2019; ADR 0119 rule 12), through the REAL Worker.
 *
 * Held: owner role and the OIDC surface (the same gates every route under `/admin/oidc/` has); a
 * closed, validated body; the loser's grants, tokens and unused codes end and its clients are queued
 * to be told, with the reason the owner named; the winner of a merge is untouched; it ends ONLY the
 * OpenID Connect holdings (the account, its keys and its sessions are other paths'); it is
 * idempotent; and the audit row records the reason and the account and nothing else.
 *
 * The merge procedure the help and ADR 0119 rule 12 give is held here too: the loser of a merge is ended
 * with this command and then REVOKED or DELETED, in that order, which ends every grant it holds, leaves it
 * unable to get another, and keeps the merge (not the revocation) as the reason on its tokens and logouts.
 * A change of kind is no substitute for either, and that is held where the kind route is
 * (`oidc-cascade-filters.test.ts`).
 */

import { beforeEach, describe, expect, test } from "bun:test";
import {
  authorizeAnswer,
  clientRowId,
  countsOf,
  deliveries,
  registerLogoutClient,
  revokedReasons,
  signInAt,
  stillWorks,
  subjectOf,
} from "./helpers/oidc-cascade";
import {
  type RegisteredClient,
  registerClient,
  rotateKeys,
  seedAccount,
} from "./helpers/oidc-flow";
import {
  ADMIN_KEY,
  ISSUER,
  MEMBER_KEY,
  OWNER_KEY,
  type OidcHarness,
  startOidcHarness,
} from "./helpers/oidc-harness";

let h: OidcHarness;
let told: RegisteredClient;
let quiet: RegisteredClient;

beforeEach(async () => {
  h = await startOidcHarness({ HOST_PREFIXED_SESSION_COOKIE: "1" });
  await rotateKeys(h);
  told = await registerLogoutClient(h);
  quiet = await registerClient(h);
});

const end = (id: number | string, body: unknown, key: string | null = OWNER_KEY) =>
  h.call("POST", `/admin/oidc/accounts/${id}/end`, { key, body });

async function holder() {
  const userId = seedAccount(h);
  return {
    userId,
    held: [await signInAt(h, userId, told), await signInAt(h, userId, quiet)],
  };
}

describe("who may call it, and where", () => {
  test("only the owner: an anonymous caller is 401, an administrator and a member 403", async () => {
    const { userId } = await holder();
    expect((await end(userId, { reason: "merged" }, null)).status).toBe(401);
    expect((await end(userId, { reason: "merged" }, ADMIN_KEY)).status).toBe(403);
    expect((await end(userId, { reason: "merged" }, MEMBER_KEY)).status).toBe(403);
    expect(countsOf(h, userId).grantsRevoked).toBe(0);
  });

  test("404 off the issuer's host and with the provider off, like every route under /admin/oidc/", async () => {
    const { userId } = await holder();
    const wrongHost = await h.call("POST", `/admin/oidc/accounts/${userId}/end`, {
      key: OWNER_KEY,
      body: { reason: "merged" },
      base: "https://app.nemar.org",
    });
    expect(wrongHost.status).toBe(404);
    const off = await h.call("POST", `/admin/oidc/accounts/${userId}/end`, {
      key: OWNER_KEY,
      body: { reason: "merged" },
      env: { OIDC_SECRET: undefined } as never,
    });
    expect(off.status).toBe(404);
    expect(countsOf(h, userId).grantsRevoked).toBe(0);
    expect(ISSUER).toBe("https://api.nemar.org");
  });
});

describe("the request", () => {
  test("an id that is not an account id is 400 invalid_user_id, and an unknown account 404 user_not_found", async () => {
    for (const bad of ["0", "-1", "abc", "1.5", "007", "99999999999999999"]) {
      const res = await end(bad, { reason: "merged" });
      expect({ status: res.status, code: res.json?.code }).toEqual({
        status: 400,
        code: "invalid_user_id",
      });
    }
    const missing = await end(987654, { reason: "merged" });
    expect({ status: missing.status, code: missing.json?.code }).toEqual({
      status: 404,
      code: "user_not_found",
    });
  });

  test("a refusal names the words and never echoes what was sent", async () => {
    const { userId } = await holder();
    const res = await end(userId, { reason: "zzz-secret-value" });
    expect(res.status).toBe(400);
    expect(res.text).toContain("merged, revoked");
    expect(res.text).not.toContain("zzz-secret-value");
  });

  test("the reason is merged or revoked, required, and no other field is accepted", async () => {
    const { userId } = await holder();
    for (const body of [
      {},
      { reason: "bogus" },
      { reason: "account_merged" },
      { reason: 1 },
      { reason: "merged", extra: 1 },
    ]) {
      const res = await end(userId, body);
      expect({ status: res.status, code: res.json?.code }).toEqual({
        status: 400,
        code: "invalid_body",
      });
    }
    expect(
      (
        await h.call("POST", `/admin/oidc/accounts/${userId}/end`, {
          key: OWNER_KEY,
          rawBody: "not json",
        })
      ).status,
    ).toBe(400);
    expect(countsOf(h, userId).grantsRevoked).toBe(0);
  });
});

describe("ending an account", () => {
  test("merged: the loser's grants, tokens and codes end, its clients are queued, and the winner's stay", async () => {
    const loser = await holder();
    const winner = await holder();

    const res = await end(loser.userId, { reason: "merged" });

    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.json).toEqual({
      user_id: loser.userId,
      reason: "account_merged",
      logouts_queued: 1,
      tokens_ended: 4,
      grants_ended: 2,
      codes_deleted: 2,
    });
    expect(countsOf(h, loser.userId)).toEqual({
      grantsLive: 0,
      grantsRevoked: 2,
      tokensLive: 0,
      tokensRevoked: 4,
      codesUnused: 0,
    });
    expect(revokedReasons(h, loser.userId)).toEqual(["account_merged"]);
    expect(deliveries(h, loser.userId).map((d) => [d.client_id, d.sub, d.reason])).toEqual([
      [clientRowId(h, told), subjectOf(h, loser.userId), "account_merged"],
    ]);
    for (const held of loser.held) expect(await stillWorks(h, held)).toBe(false);

    // The winner of the merge is untouched, in every table and at every endpoint.
    expect(countsOf(h, winner.userId).grantsLive).toBe(2);
    expect(deliveries(h, winner.userId)).toEqual([]);
    for (const held of winner.held) expect(await stillWorks(h, held)).toBe(true);
  });

  test("revoked is the other word an owner may name", async () => {
    const { userId } = await holder();
    const res = await end(userId, { reason: "revoked" });
    expect(res.json?.reason).toBe("account_revoked");
    expect(revokedReasons(h, userId)).toEqual(["account_revoked"]);
    expect(deliveries(h, userId)[0]?.reason).toBe("account_revoked");
  });

  test("it ends the OpenID Connect holdings and nothing else of the account", async () => {
    const { userId } = await holder();
    const row = () =>
      h.db
        .query<{ status: string; deleted_at: string | null }, [number]>(
          "SELECT status, deleted_at FROM users WHERE id = ?",
        )
        .get(userId);
    const keys = () =>
      h.db
        .query<{ n: number }, [number]>(
          "SELECT COUNT(*) AS n FROM web_sessions WHERE user_id = ? AND revoked_at IS NULL",
        )
        .get(userId)?.n;
    const before = { row: row(), sessions: keys() };
    await end(userId, { reason: "merged" });
    expect({ row: row(), sessions: keys() }).toEqual(before);
  });

  test("it is idempotent: a second call finds nothing live and queues nothing more", async () => {
    const { userId } = await holder();
    await end(userId, { reason: "merged" });
    const again = await end(userId, { reason: "merged" });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({
      logouts_queued: 0,
      tokens_ended: 0,
      grants_ended: 0,
      codes_deleted: 0,
    });
    expect(deliveries(h, userId).length).toBe(1);
  });

  test("an account with nothing at any client answers zeros", async () => {
    const userId = seedAccount(h);
    const res = await end(userId, { reason: "merged" });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      logouts_queued: 0,
      tokens_ended: 0,
      grants_ended: 0,
      codes_deleted: 0,
    });
  });

  test("a tombstoned account can still be ended: its subject is kept", async () => {
    const { userId } = await holder();
    h.db.query("UPDATE users SET deleted_at = datetime('now') WHERE id = ?").run(userId);
    expect((await end(userId, { reason: "merged" })).status).toBe(200);
    expect(countsOf(h, userId).grantsLive).toBe(0);
  });

  test("the audit row names the act, the owner and the account, with the reason and no more", async () => {
    const { userId } = await holder();
    await end(userId, { reason: "merged" });
    const rows = h.db
      .query<{ user_id: number; resource_type: string; resource_id: string; details: string }, []>(
        "SELECT user_id, resource_type, resource_id, details FROM audit_log WHERE action = 'oidc.account.end'",
      )
      .all();
    expect(rows).toEqual([
      {
        user_id: h.ids.owner,
        resource_type: "user",
        resource_id: String(userId),
        details: JSON.stringify({ reason: "account_merged" }),
      },
    ]);
  });
});

describe("the merge procedure: end the loser with this command, then revoke or delete it", () => {
  const FINISHES: Array<[string, (id: number) => ReturnType<typeof h.call>]> = [
    ["revoke", (id) => h.call("POST", `/admin/revoke/by-id/${id}`, { key: OWNER_KEY })],
    ["delete", (id) => h.call("DELETE", `/admin/users/by-id/${id}`, { key: OWNER_KEY })],
  ];

  for (const [name, finish] of FINISHES) {
    test(`${name}: the tokens and the logouts record the merge, nothing is queued twice, and the loser gets no new grant`, async () => {
      const loser = await holder();
      const winner = await holder();
      // Before: the account can get a grant at both clients.
      expect((await authorizeAnswer(h, loser.userId, told)).kind).toBe("redirect");
      expect((await authorizeAnswer(h, loser.userId, quiet)).kind).toBe("redirect");

      expect((await end(loser.userId, { reason: "merged" })).status).toBe(200);
      await h.settle();
      const queued = deliveries(h, loser.userId).map((d) => [d.client_id, d.reason]);
      expect(queued).toEqual([[clientRowId(h, told), "account_merged"]]);

      const done = await finish(loser.userId);
      expect(done.status).toBe(200);
      await h.settle();

      // The merge stays the reason: the revocation or deletion found nothing live to end.
      expect(revokedReasons(h, loser.userId)).toEqual(["account_merged"]);
      expect(deliveries(h, loser.userId).map((d) => [d.client_id, d.reason])).toEqual(queued);
      expect(countsOf(h, loser.userId)).toEqual({
        grantsLive: 0,
        grantsRevoked: 2,
        tokensLive: 0,
        tokensRevoked: 4,
        codesUnused: 0,
      });
      // And it can no longer get a grant at ANY client: the real authorization check refuses it, so
      // neither an app session it may still hold nor a key gets it back into a partner.
      for (const client of [told, quiet]) {
        expect((await authorizeAnswer(h, loser.userId, client)).kind, name).not.toBe("redirect");
      }
      // The winner is untouched.
      for (const held of winner.held) expect(await stillWorks(h, held)).toBe(true);
    });

    test(`${name} FIRST records the revocation as the reason, and this command then finds nothing`, async () => {
      // The order matters, which is why the help says to run this command first.
      const loser = await holder();
      expect((await finish(loser.userId)).status).toBe(200);
      await h.settle();
      expect(revokedReasons(h, loser.userId)).toEqual([
        name === "revoke" ? "account_revoked" : "account_deleted",
      ]);

      const after = await end(loser.userId, { reason: "merged" });
      expect(after.status).toBe(200);
      expect(after.json).toMatchObject({
        logouts_queued: 0,
        tokens_ended: 0,
        grants_ended: 0,
        codes_deleted: 0,
      });
      expect(revokedReasons(h, loser.userId)).toEqual([
        name === "revoke" ? "account_revoked" : "account_deleted",
      ]);
    });
  }
});
