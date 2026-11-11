/**
 * The paths that DELIBERATELY do not end an account's OpenID Connect grants (ADR 0119 rule 12), the
 * counterpart of `private-site-cascade.test.ts`'s non-membership half (epic #2014 phase #2019).
 *
 *   - a role demotion: a token carries no role and no OIDC scope confers admin authority, so there is
 *     nothing to downgrade;
 *   - revoking an API key: a grant is not minted from a key and depends on none;
 *   - signing out of the app session: signing out of NEMAR is not withdrawing a third party's
 *     delegated access. This one is a DEPARTURE from ADRs 0021, 0056 and 0079 and is marked in the ADR
 *     as the owner's decision, which is why it has a test of its own: a later reader who "fixes" it by
 *     adding the cascade makes a partner unusable whenever someone closes a NEMAR tab.
 *
 * Each is driven through its own real route, and what is asserted afterwards is the survival of the
 * ROWS (a surviving row is the thing a missing cascade would have written) and that the credentials
 * still work at the real endpoints: the access token introspects active, userinfo answers, the
 * refresh token rotates, the unspent code redeems. A refresh and a redemption spend what they use, so
 * the rows are counted first.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import {
  type Held,
  countsOf,
  deliveries,
  giveKey,
  registerLogoutClient,
  signInAt,
  stillWorks,
  usernameOf,
} from "./helpers/oidc-cascade";
import { rotateKeys, seedAccount, sessionCookie } from "./helpers/oidc-flow";
import { OWNER_KEY, type OidcHarness, startOidcHarness } from "./helpers/oidc-harness";

const APP = "https://app.nemar.org";
const KEY = "nm_oidc-nonmember-key-0123456789abcdef0123456789ab";

let h: OidcHarness;
let userId: number;
let held: Held;

beforeEach(async () => {
  h = await startOidcHarness({ HOST_PREFIXED_SESSION_COOKIE: "1" });
  await rotateKeys(h);
  const client = await registerLogoutClient(h);
  userId = seedAccount(h);
  // An approved admin (the role route changes only an approved account's role), so that a demotion
  // is one; a key, so that a revocation has something to revoke.
  h.db.query("UPDATE users SET role = 'admin', status = 'approved' WHERE id = ?").run(userId);
  await giveKey(h, userId, KEY);
  held = await signInAt(h, userId, client);
});

async function expectUntouched(): Promise<void> {
  expect(countsOf(h, userId)).toEqual({
    grantsLive: 1,
    grantsRevoked: 0,
    tokensLive: 2,
    tokensRevoked: 0,
    codesUnused: 1,
  });
  expect(deliveries(h, userId)).toEqual([]);
  expect(await stillWorks(h, held)).toBe(true);
}

function keyId(): number {
  const row = h.db
    .query<{ id: number }, [number]>("SELECT id FROM tokens WHERE user_id = ? LIMIT 1")
    .get(userId);
  if (!row) throw new Error("the account has no key");
  return row.id;
}

describe("a role demotion leaves the grants alone", () => {
  test("POST /admin/users/:username/role, admin to member", async () => {
    const res = await h.call("POST", `/admin/users/${usernameOf(h, userId)}/role`, {
      key: OWNER_KEY,
      body: { role: "member" },
    });
    expect(res.status).toBe(200);
    // The demotion DID happen, and did end what it is meant to end: the key.
    expect(
      h.db
        .query<{ n: number }, [number]>(
          "SELECT COUNT(*) AS n FROM tokens WHERE user_id = ? AND revoked_at IS NULL",
        )
        .get(userId)?.n,
    ).toBe(0);
    await expectUntouched();
  });
});

describe("revoking an API key leaves the grants alone", () => {
  test("DELETE /auth/keys/current, the key presented", async () => {
    const res = await h.call("DELETE", "/auth/keys/current", { key: KEY });
    expect(res.status).toBe(200);
    await expectUntouched();
  });

  test("DELETE /auth/keys/:id, by id", async () => {
    const res = await h.call("DELETE", `/auth/keys/${keyId()}`, { key: KEY });
    expect(res.status).toBe(200);
    await expectUntouched();
  });

  test("DELETE /admin/users/:username/keys/:id, the owner's", async () => {
    const res = await h.call("DELETE", `/admin/users/${usernameOf(h, userId)}/keys/${keyId()}`, {
      key: OWNER_KEY,
    });
    expect(res.status).toBe(200);
    await expectUntouched();
  });

  test("GET /auth/confirm-key-regeneration, which revokes every key", async () => {
    h.db
      .query(
        "UPDATE users SET verification_token = 'regen-token-for-the-oidc-suite', verification_expires_at = ? WHERE id = ?",
      )
      .run(new Date(Date.now() + 3_600_000).toISOString(), userId);
    const res = await h.call(
      "GET",
      "/auth/confirm-key-regeneration?token=regen-token-for-the-oidc-suite",
    );
    expect(res.status).toBe(200);
    await expectUntouched();
  });
});

describe("signing out leaves the grants alone", () => {
  test("POST /auth/logout ends the app session and nothing OpenID Connect", async () => {
    const live = () =>
      h.db
        .query<{ n: number }, [number]>(
          "SELECT COUNT(*) AS n FROM web_sessions WHERE user_id = ? AND revoked_at IS NULL",
        )
        .get(userId)?.n ?? 0;
    const cookie = await sessionCookie(h, userId);
    const before = live();
    const res = await h.call("POST", "/auth/logout", {
      base: APP,
      headers: { Cookie: cookie, Origin: APP },
    });
    expect(res.status).toBe(200);
    // The session DID end: the one the cookie names is revoked, and it is the only one.
    expect(live()).toBe(before - 1);
    await expectUntouched();
  });
});
