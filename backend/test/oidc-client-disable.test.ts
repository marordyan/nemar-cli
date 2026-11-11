/**
 * Disabling a client revokes everything it holds, in the batch that disables it (epic #2014 phase
 * #2019; ADR 0119 rule 12), through the REAL owner route and the real endpoints.
 *
 * Held: the client's tokens (an account's and the client's own), grants and unused codes end and the
 * status is written in ONE batch; another client's rows, and the account's grants there, are
 * untouched; NO logout is queued, though the client has an address (the owner cut it off, and telling
 * it is not owed); a second disable changes no status and writes no second audit row but still sweeps
 * what a client disabled before the revocation existed may hold; a disabled client can no longer
 * authenticate to any endpoint.
 *
 * `client_id` in the grant, code and token tables is the client's ROW id; the route is called with
 * the public id, so a statement that matched the public string would revoke nothing, and the
 * assertions are made on the rows of the client that was disabled and of the one that was not.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import {
  clientRowId,
  countsOf,
  deliveries,
  introspectActive,
  registerLogoutClient,
  revokedReasons,
  signInAt,
  stillWorks,
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

beforeEach(async () => {
  h = await startOidcHarness({ HOST_PREFIXED_SESSION_COOKIE: "1" });
  await rotateKeys(h);
});

const disable = (client: RegisteredClient) =>
  h.call("POST", `/admin/oidc/clients/${client.clientId}/disable`, { key: OWNER_KEY });

/** Rows of every OIDC table that belong to the client, by its ROW id. */
function holdings(client: RegisteredClient) {
  const row = clientRowId(h, client);
  const n = (sql: string) => h.db.query<{ n: number }, [number]>(sql).get(row)?.n ?? 0;
  return {
    grantsLive: n(
      "SELECT COUNT(*) AS n FROM oidc_grants WHERE client_id = ? AND revoked_at IS NULL",
    ),
    tokensLive: n(
      "SELECT COUNT(*) AS n FROM oidc_tokens WHERE client_id = ? AND revoked_at IS NULL",
    ),
    codesUnused: n("SELECT COUNT(*) AS n FROM oidc_codes WHERE client_id = ? AND used_at IS NULL"),
  };
}

describe("disabling a client", () => {
  test("revokes its tokens, grants and unused codes and no other client's, and says how many", async () => {
    const doomed = await registerLogoutClient(h);
    const kept = await registerLogoutClient(h);
    const a = seedAccount(h);
    const b = seedAccount(h);
    const held = {
      doomedA: await signInAt(h, a, doomed),
      keptA: await signInAt(h, a, kept),
      doomedB: await signInAt(h, b, doomed),
      keptB: await signInAt(h, b, kept),
    };
    expect(holdings(doomed)).toEqual({ grantsLive: 2, tokensLive: 4, codesUnused: 2 });

    const res = await disable(doomed);

    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      changed: true,
      revoked: { tokens: 4, grants: 2, codes: 2 },
    });
    expect((res.json?.client as { status: string }).status).toBe("disabled");
    expect(holdings(doomed)).toEqual({ grantsLive: 0, tokensLive: 0, codesUnused: 0 });
    // The other client, and the same accounts' grants at it, are exactly as they were.
    expect(holdings(kept)).toEqual({ grantsLive: 2, tokensLive: 4, codesUnused: 2 });
    expect(await stillWorks(h, held.keptA)).toBe(true);
    expect(await stillWorks(h, held.keptB)).toBe(true);
    expect(revokedReasons(h, a)).toEqual(["client_disabled"]);
    expect(countsOf(h, a).grantsRevoked).toBe(1);
  });

  test("nothing the client was handed still works, at any endpoint it can be asked", async () => {
    const doomed = await registerLogoutClient(h);
    const a = seedAccount(h);
    const held = await signInAt(h, a, doomed);
    await disable(doomed);
    // Introspection needs the client to authenticate, and a disabled one cannot; userinfo, the
    // refresh and the code are the endpoints a stolen credential would be presented to.
    expect(await stillWorks(h, held)).toBe(false);
  });

  test("queues NO logout, though the client has an address", async () => {
    const doomed = await registerLogoutClient(h);
    await signInAt(h, seedAccount(h), doomed);
    await disable(doomed);
    expect(deliveries(h)).toEqual([]);
  });

  test("the client's own tokens (client credentials, no account) are revoked too", async () => {
    const machine = await registerClient(h, {
      first_party: false,
      allowed_scopes: ["compute.stats"],
      allowed_grants: ["client_credentials"],
    });
    const res = await formPost(
      h,
      "/oauth/token",
      { grant_type: "client_credentials", scope: "compute.stats" },
      { authorization: basic(machine.clientId, machine.secret) },
    );
    expect(res.status).toBe(200);
    expect(await introspectActive(h, machine, res.json?.access_token as string)).toBe(true);
    expect(holdings(machine).tokensLive).toBe(1);

    expect((await disable(machine)).json).toMatchObject({
      revoked: { tokens: 1, grants: 0, codes: 0 },
    });
    expect(holdings(machine).tokensLive).toBe(0);
  });
});

describe("disabling a client that is already disabled", () => {
  test("changes no status and writes no second audit row, and reports nothing to revoke", async () => {
    const doomed = await registerLogoutClient(h);
    await signInAt(h, seedAccount(h), doomed);
    await disable(doomed);
    const again = await disable(doomed);
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({
      changed: false,
      revoked: { tokens: 0, grants: 0, codes: 0 },
    });
    const audit = h.db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'oidc.client.disable'",
      )
      .get();
    expect(audit?.n).toBe(1);
  });

  test("still sweeps what a client disabled BEFORE the revocation existed holds", async () => {
    // Phase #2016 disabled a client by its status alone. A client in that state may hold live rows,
    // and disabling it again must finish the job: the statements are keyed by the client, not by
    // this request having changed the status.
    const stale = await registerLogoutClient(h);
    await signInAt(h, seedAccount(h), stale);
    h.db
      .query(
        "UPDATE oidc_clients SET status = 'disabled', disabled_at = datetime('now') WHERE id = ?",
      )
      .run(clientRowId(h, stale));
    expect(holdings(stale)).toEqual({ grantsLive: 1, tokensLive: 2, codesUnused: 1 });

    const res = await disable(stale);

    expect(res.json).toMatchObject({ changed: false, revoked: { tokens: 2, grants: 1, codes: 1 } });
    expect(holdings(stale)).toEqual({ grantsLive: 0, tokensLive: 0, codesUnused: 0 });
  });
});

describe("what a disabled client can no longer do", () => {
  test("authenticate at the token, revocation and introspection endpoints", async () => {
    const doomed = await registerLogoutClient(h);
    const held = await signInAt(h, seedAccount(h), doomed);
    await disable(doomed);
    for (const path of ["/oauth/token", "/oauth/revoke", "/oauth/introspect"]) {
      const res = await formPost(
        h,
        path,
        path === "/oauth/token"
          ? { grant_type: "refresh_token", refresh_token: held.refresh }
          : { token: held.access },
        { authorization: basic(doomed.clientId, doomed.secret) },
      );
      expect({ path, status: res.status, error: res.json?.error }).toEqual({
        path,
        status: 401,
        error: "invalid_client",
      });
    }
  });
});
