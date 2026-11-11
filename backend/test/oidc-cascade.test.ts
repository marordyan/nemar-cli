/**
 * Ending an account's credentials ends what it holds at every OpenID Connect client (epic #2014
 * phase #2019; ADR 0119 rule 12), through the REAL Worker: the paths that end a credential today are
 * driven through their own routes and the real tests' sweep, and what is asked afterwards is asked of
 * the real introspection, userinfo and token endpoints.
 *
 * The shape is `admin-credential-cascade.test.ts`'s, and so is the point: that a revoked account is
 * refused is easy and was always true (the live re-check at every use). What has to hold is that the
 * grant, its tokens and its codes are GONE, so that restoring the account restores nothing, and that
 * every client that registered a back-channel logout address is owed a logout, queued in the same
 * batch. Each path is its own test, because a path that lost its statement must fail ITS test and no
 * other: `oidc-cascade-callers.test.ts` holds the list of paths, and this file proves each one works.
 *
 * `client_id` in the grant, code and token tables is the client's ROW id, not the public string a
 * client is known by (migrations 0122 to 0124): a cascade written against the public string matches
 * nothing, so every assertion about a client here is made on the row id, through the real routes.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { tombstoneUserCascade } from "../src/db/user-tombstone";
import { sweepCiTestAccounts } from "../src/services/test-account-sweep";
import {
  type Held,
  clientRowId,
  countsOf,
  deliveries,
  registerLogoutClient,
  restoreAccount,
  revokedReasons,
  signInAt,
  stillWorks,
  subjectOf,
  usernameOf,
} from "./helpers/oidc-cascade";
import {
  type RegisteredClient,
  basic,
  formPost,
  registerClient,
  rotateKeys,
  seedAccount,
} from "./helpers/oidc-flow";
import { OWNER_KEY, type OidcHarness, startOidcHarness } from "./helpers/oidc-harness";

let h: OidcHarness;
let withLogout: RegisteredClient;
let withoutLogout: RegisteredClient;
let alsoWithLogout: RegisteredClient;

beforeEach(async () => {
  h = await startOidcHarness({ HOST_PREFIXED_SESSION_COOKIE: "1" });
  await rotateKeys(h);
  withLogout = await registerLogoutClient(h);
  // No address: nobody is told, and the grants still end.
  withoutLogout = await registerClient(h);
  alsoWithLogout = await registerLogoutClient(h);
});

interface Subject {
  userId: number;
  held: Held[];
}

/** An account with a grant, tokens and an unspent code at all three clients. */
async function subject(): Promise<Subject> {
  const userId = seedAccount(h);
  const held = [
    await signInAt(h, userId, withLogout),
    await signInAt(h, userId, withoutLogout),
    await signInAt(h, userId, alsoWithLogout),
  ];
  return { userId, held };
}

async function everythingStops(s: Subject): Promise<boolean[]> {
  return Promise.all(s.held.map((held) => stillWorks(h, held)));
}

/** The account as a sweep may take it: a generated address, a web sign-up, old enough. */
function makeSweepable(userId: number): void {
  h.db
    .query(
      `UPDATE users SET email = 'dcli-oidc-cascade-1760000000001-abc123@nemar.test',
              signup_source = 'web', created_at = datetime('now', '-30 days'),
              updated_at = datetime('now', '-30 days')
        WHERE id = ?`,
    )
    .run(userId);
}

const ownerCall = (method: string, path: string, body?: unknown) =>
  h.call(method, path, { key: OWNER_KEY, ...(body === undefined ? {} : { body }) });

interface Path {
  name: string;
  reason: string;
  run(userId: number): Promise<void>;
}

const PATHS: Path[] = [
  {
    name: "POST /admin/revoke/:username",
    reason: "account_revoked",
    async run(userId) {
      expect((await ownerCall("POST", `/admin/revoke/${usernameOf(h, userId)}`)).status).toBe(200);
    },
  },
  {
    name: "POST /admin/revoke/by-id/:id",
    reason: "account_revoked",
    async run(userId) {
      expect((await ownerCall("POST", `/admin/revoke/by-id/${userId}`)).status).toBe(200);
    },
  },
  {
    name: "DELETE /admin/users/by-id/:id (the owner's soft delete)",
    reason: "account_deleted",
    async run(userId) {
      expect((await ownerCall("DELETE", `/admin/users/by-id/${userId}`)).status).toBe(200);
    },
  },
  {
    name: "the sweep of the live tests' accounts",
    reason: "account_deleted",
    async run(userId) {
      makeSweepable(userId);
      const swept = await sweepCiTestAccounts(h.env);
      expect(swept.tombstoned).toBe(1);
    },
  },
];

describe.each(PATHS)("$name", (path) => {
  test("ends every token, grant and unspent code, and nothing the account held still works", async () => {
    const s = await subject();
    expect(countsOf(h, s.userId)).toEqual({
      grantsLive: 3,
      grantsRevoked: 0,
      tokensLive: 6,
      tokensRevoked: 0,
      codesUnused: 3,
    });
    expect(await everythingStops(s)).toEqual([true, true, true]);

    await path.run(s.userId);

    expect(countsOf(h, s.userId)).toEqual({
      grantsLive: 0,
      grantsRevoked: 3,
      tokensLive: 0,
      tokensRevoked: 6,
      codesUnused: 0,
    });
    expect(revokedReasons(h, s.userId)).toEqual([path.reason]);
    // The three codes that WERE redeemed stay: a second redemption is recognized by them (rule 13),
    // and everything they issued is revoked above. Only the unspent ones go.
    const kept = h.db
      .query<{ n: number; used: number }, [number]>(
        "SELECT COUNT(*) AS n, COUNT(used_at) AS used FROM oidc_codes WHERE user_id = ?",
      )
      .get(s.userId);
    expect(kept).toEqual({ n: 3, used: 3 });
    expect(await everythingStops(s)).toEqual([false, false, false]);
  });

  test("queues one logout for each client that registered an address, and none for one that did not", async () => {
    const s = await subject();
    await path.run(s.userId);

    const queued = deliveries(h, s.userId);
    expect(queued.map((d) => d.client_id).sort()).toEqual(
      [clientRowId(h, withLogout), clientRowId(h, alsoWithLogout)].sort(),
    );
    for (const d of queued) {
      expect(d.sub).toBe(subjectOf(h, s.userId));
      expect(d.reason).toBe(path.reason);
    }
    // The three clients' rows are not mixed up: the one with no address is queued nowhere.
    expect(deliveries(h).some((d) => d.client_id === clientRowId(h, withoutLogout))).toBe(false);
  });

  test("another account's grants, tokens, codes and logouts are untouched", async () => {
    const target = await subject();
    const bystander = await subject();
    const before = countsOf(h, bystander.userId);

    await path.run(target.userId);

    expect(countsOf(h, bystander.userId)).toEqual(before);
    expect(await everythingStops(bystander)).toEqual([true, true, true]);
    expect(deliveries(h, bystander.userId)).toEqual([]);
  });

  test("restoring the account restores nothing, and signing in again is a new grant", async () => {
    // The strongest form of the precondition, by an UPDATE and not a route: it puts back the status and
    // clears `deleted_at`, as an approval would for a revoked account. A tombstoned account has no
    // approval route and its PII stays erased, so for a soft delete or the sweep this is the account
    // coming back as far as it ever could: the credentials still must not.
    const s = await subject();
    await path.run(s.userId);
    restoreAccount(h, s.userId);

    // THE case: before the cascade, revocation left the rows live and merely suppressed by the
    // status check, so putting the status back put the credentials back.
    expect(await everythingStops(s)).toEqual([false, false, false]);
    expect(countsOf(h, s.userId).grantsLive).toBe(0);

    const again = await signInAt(h, s.userId, withLogout);
    expect(await stillWorks(h, again)).toBe(true);
    expect(countsOf(h, s.userId).grantsLive).toBe(1);
    // The old grant stays what it was: a new row, not a revived one.
    expect(countsOf(h, s.userId).grantsRevoked).toBe(3);
  });
});

describe("what the statements leave alone", () => {
  test("a client disabled by hand, whose grants are still live, is not queued", async () => {
    // A client disabled before the revocation existed can hold live grants (phase #2016 set only the
    // status). Telling it is not owed: the owner cut it off.
    const s = await subject();
    h.db
      .query(
        "UPDATE oidc_clients SET status = 'disabled', disabled_at = datetime('now') WHERE id = ?",
      )
      .run(clientRowId(h, withLogout));
    expect((await ownerCall("POST", `/admin/revoke/by-id/${s.userId}`)).status).toBe(200);
    expect(deliveries(h, s.userId).map((d) => d.client_id)).toEqual([
      clientRowId(h, alsoWithLogout),
    ]);
  });

  test("a token that was already revoked keeps the reason it was revoked with", async () => {
    const s = await subject();
    const own = s.held[1] as Held;
    const revoked = await formPost(
      h,
      "/oauth/revoke",
      { token: own.access },
      { authorization: basic(own.client.clientId, own.client.secret) },
    );
    expect(revoked.status).toBe(200);
    expect((await ownerCall("POST", `/admin/revoke/by-id/${s.userId}`)).status).toBe(200);
    expect(revokedReasons(h, s.userId)).toEqual(["account_revoked", "client_revoked"]);
  });
});

describe("the tombstone keeps the subject", () => {
  test("a deleted account is still named by the value its clients were told", async () => {
    const s = await subject();
    const before = subjectOf(h, s.userId);
    expect((await ownerCall("DELETE", `/admin/users/by-id/${s.userId}`)).status).toBe(200);
    expect(subjectOf(h, s.userId)).toBe(before);
    expect(deliveries(h, s.userId).length).toBe(2);
  });
});

describe("a guarded tombstone", () => {
  test("whose address changed since it was read ends nothing and queues nothing", async () => {
    // The sweep chooses a row by its address and passes it as `onlyIfEmail`; every statement but the
    // mask is conditional on the mask having applied. A row that changed in between must lose
    // nothing, and that has to hold for the OIDC statements too.
    const s = await subject();
    const row = h.db
      .query<{ email: string }, [number]>("SELECT email FROM users WHERE id = ?")
      .get(s.userId);
    const before = countsOf(h, s.userId);

    const result = await tombstoneUserCascade(
      h.env.DB,
      s.userId,
      row?.email ?? null,
      "someone-else@nemar.test",
    );

    expect(result.tombstoned).toBe(false);
    expect(countsOf(h, s.userId)).toEqual(before);
    expect(deliveries(h, s.userId)).toEqual([]);
    expect(await everythingStops(s)).toEqual([true, true, true]);
  });
});

describe("a path that was missed still takes effect at the next use", () => {
  test("an account that is revoked by hand, with no cascade, is refused at every endpoint", async () => {
    // ADR 0119 rule 12: the live re-check of status, kind and proof at every use is the backstop.
    // This is the difference between a grant that is ENDED (rows revoked, the logout queued) and one
    // that is merely REFUSED, and the reason the cascade test above is not redundant with this one.
    const s = await subject();
    h.db.query("UPDATE users SET status = 'revoked' WHERE id = ?").run(s.userId);
    expect(await everythingStops(s)).toEqual([false, false, false]);
    expect(countsOf(h, s.userId).grantsLive).toBe(3);
    expect(deliveries(h, s.userId)).toEqual([]);
  });
});
