/**
 * A database or signing fault is a server error, never a verdict (epic #2014 phase #2018; ADR 0119
 * rule 13), through the REAL Worker over real D1 behind `wrapD1`, which runs a hook before a chosen
 * statement, and a batch that throws. Nothing here stands in for NEMAR logic: the fault is the
 * platform's (D1 unreachable), and what is held is NEMAR's answer to it.
 *
 *   - The identity token is signed BEFORE the batch, so a signing-key read that fails mints nothing
 *     and spends nothing: 5xx, `no-store`, the code unused and redeemable afterwards.
 *   - A batch that fails writes nothing (D1 runs a batch as one transaction): the same.
 *   - A refresh whose batch fails neither rotates nor counts as reuse.
 *   - A lookup that fails at userinfo or introspection is 5xx, never `invalid_token` or
 *     `{active: false}`: a fault must not read as a verdict about the token.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { CURRENT_KEY_SQL } from "../src/services/oidc-keys";
import { TOKEN_LOOKUP_SQL } from "../src/services/oidc-tokens";
import { realD1, wrapD1 } from "./helpers/d1";
import {
  type RegisteredClient,
  authorize,
  basic,
  formPost,
  redeem,
  registerClient,
  rotateKeys,
  seedAccount,
  sessionCookie,
} from "./helpers/oidc-flow";
import { type OidcHarness, startOidcHarness } from "./helpers/oidc-harness";

let h: OidcHarness;
let client: RegisteredClient;
let code: string;

beforeEach(async () => {
  h = await startOidcHarness({ HOST_PREFIXED_SESSION_COOKIE: "1" });
  await rotateKeys(h);
  client = await registerClient(h);
  code = await authorize(h, client, await sessionCookie(h, seedAccount(h)), {
    scope: "openid offline_access",
  });
});

/** D1 that throws before one statement runs. */
function failingOn(sql: string): D1Database {
  return wrapD1(realD1(h.db), (s) => {
    if (s === sql) throw new Error("D1 is unavailable");
  });
}

/** D1 whose every batch throws, as an unreachable database does. */
function failingBatch(): D1Database {
  const d1 = realD1(h.db);
  return {
    prepare: d1.prepare.bind(d1),
    batch: async () => {
      throw new Error("D1 is unavailable");
    },
  } as unknown as D1Database;
}

function writes(): { used: number; tokens: number } {
  const used =
    h.db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM oidc_codes WHERE used_at IS NOT NULL")
      .get()?.n ?? 0;
  const tokens =
    h.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM oidc_tokens").get()?.n ?? 0;
  return { used, tokens };
}

function expectServerError(res: { status: number; headers: Headers; json: unknown }): void {
  expect(res.status).toBeGreaterThanOrEqual(500);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect((res.json as { error?: string } | null)?.error).not.toBe("invalid_grant");
}

describe("a fault while a code is redeemed mints and spends nothing", () => {
  test("the signing key cannot be read: 5xx, no-store, and the code still redeems afterwards", async () => {
    const res = await redeem(h, client, code, {}, { env: { DB: failingOn(CURRENT_KEY_SQL) } });
    expectServerError(res);
    expect(writes()).toEqual({ used: 0, tokens: 0 });
    expect((await redeem(h, client, code)).status).toBe(200);
  });

  test("the batch fails: 5xx, no-store, and the code still redeems afterwards", async () => {
    const res = await redeem(h, client, code, {}, { env: { DB: failingBatch() } });
    expectServerError(res);
    expect(writes()).toEqual({ used: 0, tokens: 0 });
    expect((await redeem(h, client, code)).status).toBe(200);
  });
});

describe("a fault after a code was redeemed is never a verdict about its tokens", () => {
  test("a refresh whose batch fails neither rotates nor revokes", async () => {
    const issued = (await redeem(h, client, code)).json as { refresh_token: string };
    const res = await formPost(
      h,
      "/oauth/token",
      { grant_type: "refresh_token", refresh_token: issued.refresh_token },
      { authorization: basic(client.clientId, client.secret), env: { DB: failingBatch() } },
    );
    expectServerError(res);
    const spentOrRevoked = h.db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM oidc_tokens WHERE used_at IS NOT NULL OR revoked_at IS NOT NULL",
      )
      .get()?.n;
    expect(spentOrRevoked).toBe(0);
    const again = await formPost(
      h,
      "/oauth/token",
      { grant_type: "refresh_token", refresh_token: issued.refresh_token },
      { authorization: basic(client.clientId, client.secret) },
    );
    expect(again.status).toBe(200);
  });

  test("userinfo and introspection answer 5xx, not invalid_token or inactive, when the lookup fails", async () => {
    const issued = (await redeem(h, client, code)).json as { access_token: string };
    const broken = { DB: failingOn(TOKEN_LOOKUP_SQL) };
    for (const method of ["GET", "POST"] as const) {
      const info = await h.call(method, "/oauth/userinfo", {
        headers: { Authorization: `Bearer ${issued.access_token}` },
        env: broken,
      });
      expectServerError(info);
      expect(info.headers.get("WWW-Authenticate")).toBeNull();
    }
    const intro = await formPost(
      h,
      "/oauth/introspect",
      { token: issued.access_token },
      { authorization: basic(client.clientId, client.secret), env: broken },
    );
    expectServerError(intro);
    expect((intro.json as { active?: unknown } | null)?.active).toBeUndefined();
  });
});
