/**
 * The OpenID Connect endpoints under the maintenance mode (epic #2014 phase #2018; ADR 0119 rule 14),
 * through the REAL Worker. In `read-only`, the two endpoints that only read are served by GET (as every
 * read is) and by POST, `POST /oauth/userinfo` and `POST /oauth/introspect` (exact paths, and POST
 * only: PUT, DELETE and PATCH on them are refused like any other write), and the two that write,
 * `POST /oauth/token` and `POST /oauth/revoke`, are refused with 503 (RFC 7009 names 503 for a
 * revocation the server cannot take now). In `full` all four are refused; only discovery and the key
 * set stay readable, as before.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import {
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
let accessToken: string;
let refreshToken: string;
let auth: string;

beforeEach(async () => {
  h = await startOidcHarness({ HOST_PREFIXED_SESSION_COOKIE: "1" });
  await rotateKeys(h);
  const client = await registerClient(h);
  const code = await authorize(h, client, await sessionCookie(h, seedAccount(h)), {
    scope: "openid offline_access",
  });
  const issued = (await redeem(h, client, code)).json as {
    access_token: string;
    refresh_token: string;
  };
  accessToken = issued.access_token;
  refreshToken = issued.refresh_token;
  auth = basic(client.clientId, client.secret);
});

type Mode = "read-only" | "full";

function userinfo(method: "GET" | "POST", mode: Mode, path = "/oauth/userinfo") {
  return h.call(method, path, {
    headers: { Authorization: `Bearer ${accessToken}` },
    env: { MAINTENANCE_MODE: mode },
  });
}

function client(path: string, form: Record<string, string>, mode: Mode) {
  return formPost(h, path, form, { authorization: auth, env: { MAINTENANCE_MODE: mode } });
}

describe("read-only: the endpoints that only read are served, the ones that write are not", () => {
  test("userinfo by GET and by POST, and introspection, answer as usual", async () => {
    expect((await userinfo("GET", "read-only")).status).toBe(200);
    expect((await userinfo("POST", "read-only")).status).toBe(200);
    const intro = await client("/oauth/introspect", { token: accessToken }, "read-only");
    expect(intro.status).toBe(200);
    expect(intro.json).toMatchObject({ active: true });
  });

  test("the token endpoint and revocation are 503, and nothing is written", async () => {
    const token = await client(
      "/oauth/token",
      { grant_type: "refresh_token", refresh_token: refreshToken },
      "read-only",
    );
    expect(token.status).toBe(503);
    const revoke = await client("/oauth/revoke", { token: accessToken }, "read-only");
    expect(revoke.status).toBe(503);
    const written = h.db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM oidc_tokens WHERE used_at IS NOT NULL OR revoked_at IS NOT NULL",
      )
      .get()?.n;
    expect(written).toBe(0);
  });

  test("the exemption is POST only: PUT, DELETE and PATCH on the two paths are 503", async () => {
    for (const path of ["/oauth/userinfo", "/oauth/introspect"]) {
      for (const method of ["PUT", "DELETE", "PATCH"]) {
        const res = await h.call(method, path, {
          headers: { Authorization: `Bearer ${accessToken}` },
          env: { MAINTENANCE_MODE: "read-only" },
        });
        expect({ path, method, status: res.status }).toEqual({ path, method, status: 503 });
      }
    }
  });

  test("the exemption is the exact path: the legacy mount and a longer path are refused", async () => {
    expect((await userinfo("POST", "read-only", "/nemar/oauth/userinfo")).status).toBe(503);
    expect((await userinfo("POST", "read-only", "/oauth/userinfo/x")).status).toBe(503);
    expect((await userinfo("POST", "read-only", "/oauth/introspection")).status).toBe(503);
  });
});

describe("full: all four are refused", () => {
  test("userinfo by either method, introspection, the token endpoint and revocation are 503", async () => {
    expect((await userinfo("GET", "full")).status).toBe(503);
    expect((await userinfo("POST", "full")).status).toBe(503);
    expect((await client("/oauth/introspect", { token: accessToken }, "full")).status).toBe(503);
    expect(
      (
        await client(
          "/oauth/token",
          { grant_type: "refresh_token", refresh_token: refreshToken },
          "full",
        )
      ).status,
    ).toBe(503);
    expect((await client("/oauth/revoke", { token: accessToken }, "full")).status).toBe(503);
  });
});
