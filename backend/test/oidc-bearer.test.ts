/**
 * `oidcBearer(scopes)` on a route that is not userinfo (epic #2014 phase #2018; ADR 0119 rules 4 and
 * 14). The compute routes that will serve `compute.*` belong to the compute epics, so this suite
 * mounts the REAL middleware on a test-only app over the same database the REAL Worker issued the
 * tokens into (through the real authorization routes and token endpoint), and proves what such a
 * route gets: the client, the account, the scopes and the audience of a live token carrying the
 * scope it names; 403 `insufficient_scope` for a live token without it; 401 for anything else, a
 * CLI key included; and a client credentials token reaching a machine-scope route with no account.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { oidcBearer } from "../src/middleware/oidc-bearer";
import { lookupToken } from "../src/services/oidc-tokens";
import { hashApiKey } from "../src/services/token";
import type { Bindings, Variables } from "../src/types/bindings";
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
import { MEMBER_KEY, type OidcHarness, startOidcHarness } from "./helpers/oidc-harness";

let h: OidcHarness;

beforeEach(async () => {
  h = await startOidcHarness({ HOST_PREFIXED_SESSION_COOKIE: "1" });
  await rotateKeys(h);
});

/** A test-only resource server: one route per scope it serves, answering what `oidcBearer` set. */
function resourceApp(): Hono<{ Bindings: Bindings; Variables: Variables }> {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.get("/compute/me", oidcBearer(["compute.read"]), (c) => {
    const t = c.get("oidcToken");
    return c.json({
      client: t?.client.clientId,
      user: t?.user?.id ?? null,
      subject: t?.user?.oidc_subject ?? null,
      scopes: t?.scopes,
      audience: t?.audience,
    });
  });
  app.get("/compute/stats", oidcBearer(["compute.stats"]), (c) =>
    c.json({ client: c.get("oidcToken")?.client.clientId, user: c.get("oidcToken")?.user }),
  );
  return app;
}

async function call(path: string, authorization?: string) {
  const res = await resourceApp().fetch(
    new Request(`https://api.nemar.org${path}`, {
      headers: authorization ? { Authorization: authorization } : {},
    }),
    h.env,
  );
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
}

describe("oidcBearer on a compute-scope route", () => {
  test("a live token with the scope reaches the handler with its client, account, scopes and audience", async () => {
    const client = await registerClient(h, {
      allowed_scopes: ["openid", "compute.read"],
      allowed_grants: ["authorization_code"],
      audience: "https://api.nemar.org/compute",
    });
    const userId = seedAccount(h);
    const code = await authorize(h, client, await sessionCookie(h, userId), {
      scope: "openid compute.read",
    });
    const token = ((await redeem(h, client, code)).json as { access_token: string }).access_token;
    const res = await call("/compute/me", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const subject = h.db
      .query<{ oidc_subject: string }, [number]>("SELECT oidc_subject FROM users WHERE id = ?")
      .get(userId)?.oidc_subject;
    expect(res.json).toEqual({
      client: client.clientId,
      user: userId,
      subject,
      scopes: ["compute.read", "openid"],
      audience: "https://api.nemar.org/compute",
    });
    // The account is read live: suspended, the same token is refused.
    h.db.query("UPDATE users SET status = 'revoked' WHERE id = ?").run(userId);
    const after = await call("/compute/me", `Bearer ${token}`);
    expect(after.status).toBe(401);
    expect(after.headers.get("WWW-Authenticate")).toBe('Bearer error="invalid_token"');
  });

  test("a live token without the scope is 403 insufficient_scope naming the scope", async () => {
    const client = await registerClient(h);
    const code = await authorize(h, client, await sessionCookie(h, seedAccount(h)), {
      scope: "openid profile",
    });
    const token = ((await redeem(h, client, code)).json as { access_token: string }).access_token;
    const res = await call("/compute/me", `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.headers.get("WWW-Authenticate")).toBe(
      'Bearer error="insufficient_scope", scope="compute.read"',
    );
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  test("no token is 401 with a bare challenge; a CLI key or garbage is 401 invalid_token", async () => {
    const none = await call("/compute/me");
    expect(none.status).toBe(401);
    expect(none.headers.get("WWW-Authenticate")).toBe("Bearer");
    expect(none.json).toBeNull();
    for (const authorization of [
      `Bearer ${MEMBER_KEY}`,
      "Bearer ",
      "Basic abc",
      "Bearer nmo_at_x",
    ]) {
      const res = await call("/compute/me", authorization);
      expect({ authorization, status: res.status }).toEqual({ authorization, status: 401 });
      expect(res.headers.get("WWW-Authenticate")).toBe('Bearer error="invalid_token"');
    }
  });

  test("only an access token's row and only an access token's prefix are accepted", async () => {
    // Rows written here by hand, which is the point: no route writes either. A REFRESH row stored
    // under the hash of an `nmo_at_` value, and an ACCESS row stored under the hash of a value without
    // the prefix. Each is refused by its own check, so neither check is the other's only cover.
    const client = await registerClient(h, {
      allowed_scopes: ["openid", "compute.read"],
      allowed_grants: ["authorization_code"],
    });
    const userId = seedAccount(h);
    const code = await authorize(h, client, await sessionCookie(h, userId), {
      scope: "openid compute.read",
    });
    expect((await redeem(h, client, code)).status).toBe(200);
    const issued = h.db
      .query<Record<string, unknown>, []>("SELECT * FROM oidc_tokens WHERE kind = 'access'")
      .get() as Record<string, unknown>;
    const asRefresh = `nmo_at_${"R".repeat(43)}`;
    const unprefixed = `plain_${"P".repeat(43)}`;
    h.db
      .query(
        `INSERT INTO oidc_tokens (token_hash, kind, client_id, user_id, grant_id, code_id, family_id,
           audience, scopes, expires_at, absolute_expires_at)
         VALUES (?, 'refresh', ?, ?, ?, ?, ?, ?, ?, datetime('now', '+1 day'), datetime('now', '+2 days'))`,
      )
      .run(
        await hashApiKey(asRefresh),
        issued.client_id as number,
        issued.user_id as number,
        issued.grant_id as number,
        issued.code_id as number,
        issued.family_id as string,
        issued.audience as string,
        issued.scopes as string,
      );
    h.db
      .query(
        `INSERT INTO oidc_tokens (token_hash, kind, client_id, user_id, grant_id, code_id, family_id,
           audience, scopes, expires_at)
         VALUES (?, 'access', ?, ?, ?, ?, ?, ?, ?, datetime('now', '+600 seconds'))`,
      )
      .run(
        await hashApiKey(unprefixed),
        issued.client_id as number,
        issued.user_id as number,
        issued.grant_id as number,
        issued.code_id as number,
        issued.family_id as string,
        issued.audience as string,
        issued.scopes as string,
      );
    for (const token of [asRefresh, unprefixed]) {
      const res = await call("/compute/me", `Bearer ${token}`);
      expect({ token: token.slice(0, 7), status: res.status }).toEqual({
        token: token.slice(0, 7),
        status: 401,
      });
    }
  });

  test("a client credentials token reaches a machine-scope route, naming no account", async () => {
    const machine = await registerClient(h, {
      allowed_scopes: ["compute.stats"],
      allowed_grants: ["client_credentials"],
      first_party: false,
    });
    const res = await formPost(
      h,
      "/oauth/token",
      { grant_type: "client_credentials" },
      { authorization: basic(machine.clientId, machine.secret) },
    );
    const token = (res.json as { access_token: string }).access_token;
    const stats = await call("/compute/stats", `Bearer ${token}`);
    expect(stats.status).toBe(200);
    expect(stats.json).toEqual({ client: machine.clientId, user: null });
    // The lookup names no account for a machine token, rather than an account of NULL columns.
    const looked = await lookupToken(h.env.DB, token);
    expect(looked?.user).toBeNull();
    expect(looked?.active).toBe(1);
    // And it does not reach a route serving a person's scope.
    expect((await call("/compute/me", `Bearer ${token}`)).status).toBe(403);
  });
});
