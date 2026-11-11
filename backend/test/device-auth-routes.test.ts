/**
 * Real route tests for the device authorization grant (RFC 8628; epic #1272
 * phase 1, #1281; ADR 0047).
 *
 * Real engine throughout: bun:sqlite behind `realD1` with every migration
 * applied, real Hono dispatch via `app.request()`, real zod validation, real
 * session issuance via `issueSession()`, real API-key hashing via
 * `hashApiKey`, and a local `Bun.serve()` standing in for ORCID (only the
 * "brand-new ORCID account" case needs it). No mocks.
 *
 * `authKeysRoutes` is mounted for parity with the app's real routing, even
 * though nothing in this file exercises `/auth/keys` -- that surface has
 * its own real-route coverage in api-keys-routes.test.ts.
 *
 * THREE THINGS THIS FILE CANNOT EXERCISE, BY CONSTRUCTION, NOT BY OMISSION
 * (`.rules/testing.md`: say so when real data cannot falsify a rule).
 * First, the actual concurrent RACE every conditional UPDATE here closes
 * (two pollers, or a poll racing a confirm) -- bun:sqlite is a single
 * writer with no interleaving hook, so every "changes 1 then 0" assertion
 * in this file proves the SQL's own mutual exclusion, not that two
 * simultaneous callers cannot both win. Second, `POST /device/start`'s
 * `user_code` collision retry loop (`MAX_USER_CODE_MINT_ATTEMPTS`,
 * routes/auth-device.ts): `generateUserCode` draws from `crypto
 * .getRandomValues` with no seam to force a collision on demand, so the
 * retry path is read-reviewed, not driven end to end here. Third, and for
 * the same single-writer reason as the first: `/device/token` step 6's
 * `freshRow.status === "confirmed"` canary branch (routes/auth-device.ts)
 * answers `slow_down` for a mint that passed every gate yet inserted no
 * row -- the shape only a genuine concurrent racer produces. Verified by
 * hand (mutate the branch to a terminal error, run this file plus
 * device-codes-migration.test.ts and api-keys-routes.test.ts, confirm
 * nothing goes red, revert) rather than by a red test, because nothing
 * in a single-threaded suite can put the code in that state.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Hono } from "hono";
import {
  DEVICE_CODE_TTL_SECONDS,
  MACHINE_NAME_MAX_CHARS,
  MAX_LIVE_API_KEYS,
  deviceConfirmResponseSchema,
  deviceLookupResponseSchema,
  deviceRefusalResponseSchema,
  deviceStartResponseSchema,
  deviceTokenErrorSchema,
  deviceTokenSuccessSchema,
  normalizeUserCode,
} from "../../shared/contract/device-auth.js";
import { authRoutes } from "../src/routes/auth";
import { authDeviceRoutes } from "../src/routes/auth-device";
import { authKeysRoutes } from "../src/routes/auth-keys";
import { authOrcidRoutes } from "../src/routes/auth-orcid";
import { authWebRoutes } from "../src/routes/auth-web";
import { userRoutes } from "../src/routes/users";
import { hashDeviceCode } from "../src/services/device-auth";
import { PENDING_COOKIE_NAME, STATE_COOKIE_NAME, encodeState } from "../src/services/orcid-auth";
import { issueSession } from "../src/services/web-session";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const APP = "https://app.nemar.org";
const ORIGIN = "https://app.nemar.org";
const ENCRYPTION_KEY = "device-auth-route-test-encryption-key-0123";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let external: Server;
let externalBase: string;
/** Which iD the local ORCID token endpoint hands back for the next callback. */
let tokenOrcid = "0000-0002-8888-9999";

beforeAll(() => {
  external = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/oauth/token") {
        return Response.json({ orcid: tokenOrcid, name: "New Person", access_token: "unused" });
      }
      if (url.pathname.endsWith("/personal-details")) {
        return Response.json({
          name: { "given-names": { value: "New" }, "family-name": { value: "Person" } },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  externalBase = `http://localhost:${external.port}`;
});

afterAll(() => {
  external.stop(true);
});

function env(): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "test",
    ENCRYPTION_KEY,
    ORCID_CLIENT_ID: "APP-TEST",
    ORCID_CLIENT_SECRET: "test-secret",
    ORCID_API_BASE: externalBase,
    ORCID_PUB_API_BASE: externalBase,
    APP_BASE_URL: APP,
    WEB_SESSION_COOKIE_DOMAIN: "",
    RESEND_API_KEY: "test-resend-key",
    FROM_EMAIL: "NEMAR <noreply@nemar.test>",
    DEV_EMAIL_ALLOWLIST: "@nemar.test",
    GITHUB_ADMIN_PAT: "test-pat-not-used-against-a-real-host",
    API_BASE_URL: "http://localhost:8787",
  } as unknown as Bindings;
}

beforeEach(() => {
  db = freshDb();
  tokenOrcid = "0000-0002-8888-9999";
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/auth", authRoutes);
  app.route("/auth", authWebRoutes);
  app.route("/auth", authOrcidRoutes);
  app.route("/auth", authDeviceRoutes);
  app.route("/auth", authKeysRoutes);
  app.route("/users", userRoutes);
});

// --------------------------------------------------------------------------
// Seeding + low-level helpers
// --------------------------------------------------------------------------

interface SeedOpts {
  status?: "pending" | "verified" | "approved" | "revoked";
  identityConflict?: boolean;
  /** `person` by default (epic #1272 phase 4, #1284; ADR 0048). */
  accountKind?: "person" | "service" | "test";
}

function seedUser(email: string, opts: SeedOpts = {}): number {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, signup_source, email_verified, identity_conflict, account_kind)
     VALUES (?, ?, 'x', ?, 'member', 'web', 1, ?, ?)`,
    [
      email.split("@")[0],
      email,
      opts.status ?? "verified",
      opts.identityConflict ? 1 : 0,
      opts.accountKind ?? "person",
    ],
  );
  const row = db.query<{ id: number }, [string]>("SELECT id FROM users WHERE email = ?").get(email);
  if (!row) throw new Error("seed failed");
  return row.id;
}

async function sessionCookie(userId: number): Promise<string> {
  const { cookieIdRaw } = await issueSession(
    env(),
    userId,
    false,
    "test-agent",
    "127.0.0.1",
    "email_code",
  );
  return `nemar_session=${cookieIdRaw}`;
}

function deviceCodeRowByRawUserCode(userCode: string) {
  return db
    .query<
      {
        device_code_hash: string;
        user_code: string;
        machine_name: string;
        status: string;
        user_id: number | null;
        token_id: number | null;
        poll_count: number;
        last_polled_at: string | null;
      },
      [string]
    >("SELECT * FROM device_codes WHERE user_code = ?")
    .get(userCode);
}

function auditRows(action: string, resourceId?: string) {
  return db
    .query<
      {
        user_id: number | null;
        action: string;
        resource_id: string | null;
        details: string | null;
      },
      [string]
    >("SELECT user_id, action, resource_id, details FROM audit_log WHERE action = ? ORDER BY id")
    .all(action)
    .filter((r) => resourceId === undefined || r.resource_id === resourceId);
}

// --------------------------------------------------------------------------
// Route helpers
// --------------------------------------------------------------------------

async function start(machineName?: string): Promise<Response> {
  return app.request(
    "/auth/device/start",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(machineName === undefined ? {} : { machine_name: machineName }),
    },
    env(),
  );
}

async function startNoBody(): Promise<Response> {
  return app.request("/auth/device/start", { method: "POST" }, env());
}

async function pollToken(deviceCode: string): Promise<Response> {
  return app.request(
    "/auth/device/token",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_code: deviceCode }),
    },
    env(),
  );
}

async function lookup(userCodeRaw: string, cookie: string | null): Promise<Response> {
  return app.request(
    `/auth/device/lookup?code=${encodeURIComponent(userCodeRaw)}`,
    { headers: cookie ? { Cookie: cookie } : {} },
    env(),
  );
}

async function confirm(
  userCodeRaw: string,
  cookie: string | null,
  origin: string | null = ORIGIN,
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.Cookie = cookie;
  if (origin) headers.Origin = origin;
  return app.request(
    "/auth/device/confirm",
    { method: "POST", headers, body: JSON.stringify({ code: userCodeRaw }) },
    env(),
  );
}

async function deny(
  userCodeRaw: string,
  cookie: string | null,
  origin: string | null = ORIGIN,
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers.Cookie = cookie;
  if (origin) headers.Origin = origin;
  return app.request(
    "/auth/device/deny",
    { method: "POST", headers, body: JSON.stringify({ code: userCodeRaw }) },
    env(),
  );
}

/** Start a code and return its raw fields (device_code + raw 8-char user
 *  code, unformatted -- confirm/deny/lookup all accept the formatted OR the
 *  raw form via `normalizeUserCode`). */
async function startCode(machineName = "test machine"): Promise<{
  deviceCode: string;
  userCode: string;
}> {
  const res = await start(machineName);
  const body = (await res.json()) as { device_code: string; user_code: string };
  const raw = normalizeUserCode(body.user_code);
  if (!raw) throw new Error("start did not return a well-formed user_code");
  return { deviceCode: body.device_code, userCode: raw };
}

// --------------------------------------------------------------------------
// start
// --------------------------------------------------------------------------

describe("POST /auth/device/start", () => {
  test("returns the RFC 8628 fields", async () => {
    const res = await start("adas-laptop");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      verification_uri_complete: string;
      expires_in: number;
      interval: number;
    };
    expect(typeof body.device_code).toBe("string");
    expect(body.device_code.length).toBeGreaterThanOrEqual(32);
    expect(body.user_code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(body.verification_uri).toBe(`${APP}/cli/authorize`);
    expect(body.verification_uri_complete).toBe(
      `${APP}/cli/authorize?code=${encodeURIComponent(body.user_code)}`,
    );
    expect(body.expires_in).toBe(DEVICE_CODE_TTL_SECONDS);
    expect(body.interval).toBe(5);
  });

  test("trims and collapses extra whitespace in a machine_name", async () => {
    const { userCode } = await startCode("  ada's   laptop  ");
    const row = deviceCodeRowByRawUserCode(userCode);
    expect(row?.machine_name).toBe("ada's laptop");
  });

  test("strips control characters from a machine_name (removed, not spaced)", async () => {
    const { userCode } = await startCode("bad\x00name\x07");
    const row = deviceCodeRowByRawUserCode(userCode);
    expect(row?.machine_name).toBe("badname");
  });

  test("defaults an absent machine_name", async () => {
    const res = await startNoBody();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user_code: string };
    const raw = normalizeUserCode(body.user_code);
    if (!raw) throw new Error("bad user_code");
    const row = deviceCodeRowByRawUserCode(raw);
    expect(row?.machine_name).toBe("unnamed machine");
  });

  test("cuts a long machine_name to the 64-char cap", async () => {
    const { userCode } = await startCode("x".repeat(200));
    const row = deviceCodeRowByRawUserCode(userCode);
    expect(row?.machine_name.length).toBe(MACHINE_NAME_MAX_CHARS);
  });

  test("a whitespace-only machine_name defaults to unnamed machine", async () => {
    const { userCode } = await startCode("   ");
    const row = deviceCodeRowByRawUserCode(userCode);
    expect(row?.machine_name).toBe("unnamed machine");
  });

  test("a control-characters-only machine_name defaults to unnamed machine", async () => {
    const { userCode } = await startCode("\x00\x01\x02");
    const row = deviceCodeRowByRawUserCode(userCode);
    expect(row?.machine_name).toBe("unnamed machine");
  });

  test("a 201-char machine_name answers 400", async () => {
    const res = await start("x".repeat(201));
    expect(res.status).toBe(400);
  });

  test("a malformed non-empty JSON body answers 400", async () => {
    const res = await app.request(
      "/auth/device/start",
      { method: "POST", headers: { "content-type": "application/json" }, body: "{not valid json" },
      env(),
    );
    expect(res.status).toBe(400);
  });

  test("two starts coexist as two distinct rows", async () => {
    const a = await startCode("machine-a");
    const b = await startCode("machine-b");
    expect(a.userCode).not.toBe(b.userCode);
    expect(a.deviceCode).not.toBe(b.deviceCode);
    expect(deviceCodeRowByRawUserCode(a.userCode)?.status).toBe("pending");
    expect(deviceCodeRowByRawUserCode(b.userCode)?.status).toBe("pending");
  });

  test("writes a device_auth_started audit row", async () => {
    const { userCode } = await startCode("audited-machine");
    const rows = auditRows("device_auth_started", userCode);
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBeNull();
    const details = JSON.parse(rows[0].details ?? "{}");
    expect(details.machine_name).toBe("audited-machine");
  });

  test("prunes a stale (>24h past expiry) row", async () => {
    db.run(
      `INSERT INTO device_codes (device_code_hash, user_code, machine_name, expires_at)
       VALUES ('stale-hash', 'STALEUSR', 'old', datetime('now', '-25 hours'))`,
    );
    await start("fresh-machine");
    const stale = db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM device_codes WHERE user_code = 'STALEUSR'",
      )
      .get();
    expect(stale?.n).toBe(0);
  });
});

// --------------------------------------------------------------------------
// token
// --------------------------------------------------------------------------

describe("POST /auth/device/token", () => {
  test("Cache-Control: no-store on every response", async () => {
    const res = await pollToken("x".repeat(40));
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  test("an unknown device_code answers invalid_grant/device_code_unknown", async () => {
    const res = await pollToken("z".repeat(40));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; reason?: string };
    expect(body.error).toBe("invalid_grant");
    expect(body.reason).toBe("device_code_unknown");
  });

  test("a fresh pending code answers authorization_pending, then slow_down without moving poll_count", async () => {
    const { deviceCode, userCode } = await startCode();

    const first = await pollToken(deviceCode);
    expect(first.status).toBe(400);
    expect((await first.json()).error).toBe("authorization_pending");
    expect(deviceCodeRowByRawUserCode(userCode)?.poll_count).toBe(1);

    const second = await pollToken(deviceCode);
    expect(second.status).toBe(400);
    const secondBody = (await second.json()) as { error: string; reason?: string };
    expect(secondBody.error).toBe("slow_down");
    expect(secondBody.reason).toBeUndefined();
    expect(deviceCodeRowByRawUserCode(userCode)?.poll_count).toBe(1);
  });

  test("pending again once the poll floor has passed", async () => {
    const { deviceCode, userCode } = await startCode();
    await pollToken(deviceCode);
    db.run(
      "UPDATE device_codes SET last_polled_at = datetime('now', '-6 seconds') WHERE user_code = ?",
      [userCode],
    );
    const third = await pollToken(deviceCode);
    expect((await third.json()).error).toBe("authorization_pending");
    expect(deviceCodeRowByRawUserCode(userCode)?.poll_count).toBe(2);
  });

  test("an expired pending code answers expired_token exactly once in the audit log across two polls", async () => {
    const { deviceCode, userCode } = await startCode();
    db.run(
      "UPDATE device_codes SET expires_at = datetime('now', '-1 seconds') WHERE user_code = ?",
      [userCode],
    );

    const first = await pollToken(deviceCode);
    expect(first.status).toBe(400);
    const firstBody = (await first.json()) as { error: string; reason?: string };
    expect(firstBody.error).toBe("expired_token");
    expect(firstBody.reason).toBe("device_code_expired");

    const second = await pollToken(deviceCode);
    const secondBody = (await second.json()) as { error: string; reason?: string };
    expect(secondBody.error).toBe("expired_token");
    expect(secondBody.reason).toBe("device_code_expired");

    expect(auditRows("device_auth_expired", userCode)).toHaveLength(1);
  });

  test("poll_count stays unchanged when polling an expired code", async () => {
    const { deviceCode, userCode } = await startCode();
    db.run(
      "UPDATE device_codes SET expires_at = datetime('now', '-1 seconds') WHERE user_code = ?",
      [userCode],
    );
    await pollToken(deviceCode);
    const row = deviceCodeRowByRawUserCode(userCode);
    expect(row?.poll_count).toBe(0);
  });

  test("poll_count stays unchanged when polling a denied code", async () => {
    const bob = seedUser("bob-poll-denied@nemar.test");
    const { deviceCode, userCode } = await startCode();
    await deny(userCode, await sessionCookie(bob));
    await pollToken(deviceCode);
    const row = deviceCodeRowByRawUserCode(userCode);
    expect(row?.poll_count).toBe(0);
  });
});

// --------------------------------------------------------------------------
// lookup
// --------------------------------------------------------------------------

describe("GET /auth/device/lookup", () => {
  test("Cache-Control: no-store", async () => {
    const res = await lookup("BCDFGHJK", null);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  test("401 without a session", async () => {
    const res = await lookup("BCDFGHJK", null);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Authentication required");
  });

  test("accepts a hyphenated, lowercase code", async () => {
    const ada = seedUser("ada-lookup@nemar.test");
    const { userCode } = await startCode("adas-laptop");
    const formatted = `${userCode.slice(0, 4)}-${userCode.slice(4)}`.toLowerCase();
    const res = await lookup(formatted, await sessionCookie(ada));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user_code: string; machine_name: string };
    expect(normalizeUserCode(body.user_code)).toBe(userCode);
    expect(body.machine_name).toBe("adas-laptop");
  });

  test("404 for a garbage code", async () => {
    const ada = seedUser("ada-garbage@nemar.test");
    const res = await lookup("not-a-code", await sessionCookie(ada));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("device_code_unknown");
  });

  test("a pending-status session sees refusal.code account_pending, still 200", async () => {
    const pendingUser = seedUser("ada-pending-lookup@nemar.test", { status: "pending" });
    const { userCode } = await startCode();
    const res = await lookup(userCode, await sessionCookie(pendingUser));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { refusal: { code: string; message: string } | null };
    expect(body.refusal?.code).toBe("account_pending");
  });

  test("an identity_conflict session sees refusal.code identity_conflict", async () => {
    const flagged = seedUser("ada-flagged-lookup@nemar.test", { identityConflict: true });
    const { userCode } = await startCode();
    const res = await lookup(userCode, await sessionCookie(flagged));
    const body = (await res.json()) as { refusal: { code: string } | null };
    expect(body.refusal?.code).toBe("identity_conflict");
  });

  test("a service-kind session sees refusal.code service_account", async () => {
    // Epic #1272 phase 4 (ADR 0048): one code covers both non-person kinds.
    const service = seedUser("service-lookup@nemar.test", { accountKind: "service" });
    const { userCode } = await startCode();
    const res = await lookup(userCode, await sessionCookie(service));
    const body = (await res.json()) as { refusal: { code: string } | null };
    expect(body.refusal?.code).toBe("service_account");
  });

  test("a test-kind session also sees refusal.code service_account", async () => {
    const test = seedUser("test-persona-lookup@nemar.test", { accountKind: "test" });
    const { userCode } = await startCode();
    const res = await lookup(userCode, await sessionCookie(test));
    const body = (await res.json()) as { refusal: { code: string } | null };
    expect(body.refusal?.code).toBe("service_account");
  });

  test("410 for an expired code", async () => {
    const ada = seedUser("ada-expired-lookup@nemar.test");
    const { userCode } = await startCode();
    db.run(
      "UPDATE device_codes SET expires_at = datetime('now', '-1 seconds') WHERE user_code = ?",
      [userCode],
    );
    const res = await lookup(userCode, await sessionCookie(ada));
    expect(res.status).toBe(410);
    expect((await res.json()).error).toBe("device_code_expired");
  });

  test("409 for a denied code, 409 for a consumed code", async () => {
    const ada = seedUser("ada-denied-lookup@nemar.test");
    const bob = seedUser("bob-consumed-lookup@nemar.test");
    const deniedCode = await startCode();
    await deny(deniedCode.userCode, await sessionCookie(ada));
    const deniedRes = await lookup(deniedCode.userCode, await sessionCookie(ada));
    expect(deniedRes.status).toBe(409);
    expect((await deniedRes.json()).error).toBe("device_code_denied");

    const consumedCode = await startCode();
    await confirm(consumedCode.userCode, await sessionCookie(bob));
    await pollToken(consumedCode.deviceCode);
    const consumedRes = await lookup(consumedCode.userCode, await sessionCookie(bob));
    expect(consumedRes.status).toBe(409);
    expect((await consumedRes.json()).error).toBe("device_code_used");
  });
});

// --------------------------------------------------------------------------
// confirm
// --------------------------------------------------------------------------

describe("POST /auth/device/confirm", () => {
  test("403 without an Origin header", async () => {
    const ada = seedUser("ada-confirm-noorigin@nemar.test");
    const res = await confirm("BCDFGHJK", await sessionCookie(ada), null);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Origin not allowed");
  });

  test("403 with a foreign Origin", async () => {
    const ada = seedUser("ada-confirm-foreign@nemar.test");
    const res = await confirm("BCDFGHJK", await sessionCookie(ada), "https://evil.example");
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("Origin not allowed");
  });

  test("401 without a session", async () => {
    const res = await confirm("BCDFGHJK", null);
    expect(res.status).toBe(401);
  });

  test("403 typed for a pending account, and the row stays pending", async () => {
    const pendingUser = seedUser("ada-pending-confirm@nemar.test", { status: "pending" });
    const { userCode } = await startCode();
    const res = await confirm(userCode, await sessionCookie(pendingUser));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("account_pending");
    expect(deviceCodeRowByRawUserCode(userCode)?.status).toBe("pending");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  test("403 typed for an identity_conflict account, and the row stays pending", async () => {
    const flagged = seedUser("ada-flagged-confirm@nemar.test", { identityConflict: true });
    const { userCode } = await startCode();
    const res = await confirm(userCode, await sessionCookie(flagged));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("identity_conflict");
    expect(deviceCodeRowByRawUserCode(userCode)?.status).toBe("pending");
  });

  test("403 service_account for a service-kind account, and the row stays pending", async () => {
    const service = seedUser("service-confirm@nemar.test", { accountKind: "service" });
    const { userCode } = await startCode();
    const res = await confirm(userCode, await sessionCookie(service));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("service_account");
    expect(deviceCodeRowByRawUserCode(userCode)?.status).toBe("pending");
  });

  test("403 service_account for a test-kind account, and the row stays pending", async () => {
    const test = seedUser("test-persona-confirm@nemar.test", { accountKind: "test" });
    const { userCode } = await startCode();
    const res = await confirm(userCode, await sessionCookie(test));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("service_account");
    expect(deviceCodeRowByRawUserCode(userCode)?.status).toBe("pending");
  });

  test("success flips the row, writes the audit row, and never carries a key", async () => {
    const ada = seedUser("ada-confirm-success@nemar.test");
    const { userCode } = await startCode("adas-laptop");
    const res = await confirm(userCode, await sessionCookie(ada));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; machine_name: string };
    expect(body.ok).toBe(true);
    expect(body.machine_name).toBe("adas-laptop");
    expect("api_key" in body).toBe(false);

    const row = deviceCodeRowByRawUserCode(userCode);
    expect(row?.status).toBe("confirmed");
    expect(row?.user_id).toBe(ada);

    const rows = auditRows("device_auth_confirmed", userCode);
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(ada);
  });

  test("a second confirm answers 409 device_code_used", async () => {
    const ada = seedUser("ada-confirm-twice@nemar.test");
    const { userCode } = await startCode();
    await confirm(userCode, await sessionCookie(ada));
    const res = await confirm(userCode, await sessionCookie(ada));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("device_code_used");
  });

  test("confirm after deny answers 409 device_code_denied", async () => {
    const ada = seedUser("ada-confirm-after-deny@nemar.test");
    const { userCode } = await startCode();
    await deny(userCode, await sessionCookie(ada));
    const res = await confirm(userCode, await sessionCookie(ada));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("device_code_denied");
  });

  test("confirm after expiry answers 410", async () => {
    const ada = seedUser("ada-confirm-expired@nemar.test");
    const { userCode } = await startCode();
    db.run(
      "UPDATE device_codes SET expires_at = datetime('now', '-1 seconds') WHERE user_code = ?",
      [userCode],
    );
    const res = await confirm(userCode, await sessionCookie(ada));
    expect(res.status).toBe(410);
    expect((await res.json()).error).toBe("device_code_expired");
  });

  test("confirm for an unknown code answers 404", async () => {
    const ada = seedUser("ada-confirm-unknown@nemar.test");
    const res = await confirm("ZZZZZZZZ", await sessionCookie(ada));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("device_code_unknown");
  });
});

// --------------------------------------------------------------------------
// deny
// --------------------------------------------------------------------------

describe("POST /auth/device/deny", () => {
  test("any signed-in account may deny; the row records no user_id", async () => {
    const bob = seedUser("bob-deny@nemar.test");
    const { userCode } = await startCode();
    const res = await deny(userCode, await sessionCookie(bob));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);

    const row = deviceCodeRowByRawUserCode(userCode);
    expect(row?.status).toBe("denied");
    expect(row?.user_id).toBeNull();
  });

  test("deny stays ungated: a service-kind account may still deny (200)", async () => {
    // ADR 0047: `deny` records no `user_id` on the row, so it never runs
    // `accountRefusal` at all -- unlike lookup/confirm, a service/test kind
    // is not refused here (epic #1272 phase 4, #1284; ADR 0048).
    const service = seedUser("service-deny@nemar.test", { accountKind: "service" });
    const { userCode } = await startCode();
    const res = await deny(userCode, await sessionCookie(service));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  test("writes a device_auth_denied audit row naming the denier", async () => {
    const bob = seedUser("bob-deny-audit@nemar.test");
    const { userCode } = await startCode();
    await deny(userCode, await sessionCookie(bob));
    const rows = auditRows("device_auth_denied", userCode);
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(bob);
  });

  test("Cache-Control: no-store on a 409 (deny on an already-confirmed code)", async () => {
    const bob = seedUser("bob-deny-cache@nemar.test");
    const { userCode } = await startCode();
    await confirm(userCode, await sessionCookie(bob));
    const res = await deny(userCode, await sessionCookie(bob));
    expect(res.status).toBe(409);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  test("a denied code then polls access_denied/device_code_denied", async () => {
    const bob = seedUser("bob-deny-poll@nemar.test");
    const { deviceCode, userCode } = await startCode();
    await deny(userCode, await sessionCookie(bob));
    const res = await pollToken(deviceCode);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; reason?: string };
    expect(body.error).toBe("access_denied");
    expect(body.reason).toBe("device_code_denied");
  });

  test("deny on an already-confirmed code answers 409", async () => {
    const bob = seedUser("bob-deny-confirmed@nemar.test");
    const { userCode } = await startCode();
    await confirm(userCode, await sessionCookie(bob));
    const res = await deny(userCode, await sessionCookie(bob));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("device_code_used");
  });
});

// --------------------------------------------------------------------------
// token after confirm: the mint
// --------------------------------------------------------------------------

describe("POST /auth/device/token after confirm", () => {
  async function seedExistingKey(userId: number): Promise<string> {
    const apiKey = "nm_preexisting0123456789abcdefghijklmno";
    const { hashApiKey } = await import("../src/services/token");
    const hash = await hashApiKey(apiKey);
    db.run("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix, name) VALUES (?, ?, ?, ?)", [
      userId,
      hash,
      apiKey.slice(0, 11),
      "old-machine",
    ]);
    return apiKey;
  }

  test("mints a named nm_ key, consumes the row, and the key authenticates /users/me", async () => {
    const ada = seedUser("ada-mint@nemar.test");
    const preexistingKey = await seedExistingKey(ada);
    const { deviceCode, userCode } = await startCode("adas-laptop");
    await confirm(userCode, await sessionCookie(ada));

    const res = await pollToken(deviceCode);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      api_key: string;
      key: { id: number; name: string | null; prefix: string; current: boolean };
      user: { email: string; role: string };
    };
    expect(body.api_key.startsWith("nm_")).toBe(true);
    expect(body.key.name).toBe("adas-laptop");
    expect(body.key.current).toBe(true);
    expect(body.user.email).toBe("ada-mint@nemar.test");
    expect(body.user.role).toBe("member");

    const tokenRow = db
      .query<{ api_key_prefix: string }, [number]>("SELECT api_key_prefix FROM tokens WHERE id = ?")
      .get(body.key.id);
    expect(tokenRow?.api_key_prefix).toBe(body.key.prefix);

    const row = deviceCodeRowByRawUserCode(userCode);
    expect(row?.status).toBe("consumed");
    expect(row?.token_id).toBe(body.key.id);

    expect(auditRows("device_auth_key_issued", userCode)).toHaveLength(1);

    const meNew = await app.request(
      "/users/me",
      { headers: { Authorization: `Bearer ${body.api_key}` } },
      env(),
    );
    expect(meNew.status).toBe(200);

    const meOld = await app.request(
      "/users/me",
      { headers: { Authorization: `Bearer ${preexistingKey}` } },
      env(),
    );
    expect(meOld.status).toBe(200);

    const second = await pollToken(deviceCode);
    expect(second.status).toBe(400);
    const secondBody = (await second.json()) as { error: string; reason?: string };
    expect(secondBody.error).toBe("invalid_grant");
    expect(secondBody.reason).toBe("device_code_used");
  });

  test("wrong account: Bob confirms a code nobody else has touched, and the key is Bob's", async () => {
    const bob = seedUser("bob-wrong-account@nemar.test");
    const { deviceCode, userCode } = await startCode();
    await confirm(userCode, await sessionCookie(bob));
    const res = await pollToken(deviceCode);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { email: string } };
    expect(body.user.email).toBe("bob-wrong-account@nemar.test");
  });
});

// --------------------------------------------------------------------------
// account change between confirm and collect
// --------------------------------------------------------------------------

describe("account state changes between confirm and collect", () => {
  test("a revoked account answers account_revoked and mints no token row", async () => {
    const ada = seedUser("ada-revoke-between@nemar.test");
    const { deviceCode, userCode } = await startCode();
    await confirm(userCode, await sessionCookie(ada));
    db.run("UPDATE users SET status = 'revoked' WHERE id = ?", [ada]);

    const before = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tokens").get()?.n ?? 0;
    const res = await pollToken(deviceCode);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; reason?: string };
    expect(body.error).toBe("access_denied");
    expect(body.reason).toBe("account_revoked");
    const after = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tokens").get()?.n ?? 0;
    expect(after).toBe(before);
  });

  test("a soft-deleted account answers account_revoked and mints no token row", async () => {
    const ada = seedUser("ada-delete-between@nemar.test");
    const { deviceCode, userCode } = await startCode();
    await confirm(userCode, await sessionCookie(ada));
    // Soft-delete, status untouched: `deleted_at` alone is what the mint
    // gate checks (`u.deleted_at IS NULL`), independent of `status`.
    db.run("UPDATE users SET deleted_at = datetime('now') WHERE id = ?", [ada]);

    const before = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tokens").get()?.n ?? 0;
    const res = await pollToken(deviceCode);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; reason?: string };
    expect(body.error).toBe("access_denied");
    expect(body.reason).toBe("account_revoked");
    const after = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tokens").get()?.n ?? 0;
    expect(after).toBe(before);
  });

  test("a flagged account answers identity_conflict", async () => {
    const ada = seedUser("ada-flag-between@nemar.test");
    const { deviceCode, userCode } = await startCode();
    await confirm(userCode, await sessionCookie(ada));
    db.run("UPDATE users SET identity_conflict = 1 WHERE id = ?", [ada]);

    const res = await pollToken(deviceCode);
    const body = (await res.json()) as { error: string; reason?: string };
    expect(body.reason).toBe("identity_conflict");
  });

  test("a kind change to service between confirm and collect answers service_account and mints no token row", async () => {
    // Epic #1272 phase 4 (ADR 0048): `DEVICE_MINT_INSERT_SQL`'s own
    // `account_kind = 'person'` predicate refuses the mint outright; this is
    // the diagnosis path (services/device-auth.ts step 6) explaining why.
    const ada = seedUser("ada-kind-change-between@nemar.test");
    const { deviceCode, userCode } = await startCode();
    await confirm(userCode, await sessionCookie(ada));
    db.run("UPDATE users SET account_kind = 'service' WHERE id = ?", [ada]);

    const before = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tokens").get()?.n ?? 0;
    const res = await pollToken(deviceCode);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; reason?: string };
    expect(body.error).toBe("access_denied");
    expect(body.reason).toBe("service_account");
    const after = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tokens").get()?.n ?? 0;
    expect(after).toBe(before);
  });

  test("a kind change to test between confirm and collect answers service_account and mints no token row", async () => {
    // Same diagnosis path as the service-kind case above, exercised for the
    // OTHER non-person kind (#1284 review): ADR 0048 has `accountRefusal`
    // answer the same `service_account` code for either `service` or `test`
    // -- from the CLI's side of `nemar auth login`, the two are the same
    // fact ("a human is not meant to sign in this way"), so this is proof
    // the diagnosis path was not accidentally written to special-case only
    // `service`.
    const ada = seedUser("ada-kind-change-test-between@nemar.test");
    const { deviceCode, userCode } = await startCode();
    await confirm(userCode, await sessionCookie(ada));
    db.run("UPDATE users SET account_kind = 'test' WHERE id = ?", [ada]);

    const before = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tokens").get()?.n ?? 0;
    const res = await pollToken(deviceCode);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; reason?: string };
    expect(body.error).toBe("access_denied");
    expect(body.reason).toBe("service_account");
    const after = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tokens").get()?.n ?? 0;
    expect(after).toBe(before);
  });

  test("an account already at 25 live keys answers too_many_keys", async () => {
    const ada = seedUser("ada-cap-between@nemar.test");
    const { deviceCode, userCode } = await startCode();
    await confirm(userCode, await sessionCookie(ada));
    for (let i = 0; i < MAX_LIVE_API_KEYS; i++) {
      db.run(
        "INSERT INTO tokens (user_id, api_key_hash, api_key_prefix, name) VALUES (?, ?, ?, ?)",
        [ada, `cap-hash-${i}`, "nm_xxx...", `key-${i}`],
      );
    }
    const res = await pollToken(deviceCode);
    const body = (await res.json()) as { error: string; reason?: string };
    expect(body.reason).toBe("too_many_keys");
  });

  test("expiry between confirm and collect answers expired_token", async () => {
    const ada = seedUser("ada-expire-between@nemar.test");
    const { deviceCode, userCode } = await startCode();
    await confirm(userCode, await sessionCookie(ada));
    db.run(
      "UPDATE device_codes SET expires_at = datetime('now', '-1 seconds') WHERE user_code = ?",
      [userCode],
    );
    const res = await pollToken(deviceCode);
    const body = (await res.json()) as { error: string; reason?: string };
    expect(body.error).toBe("expired_token");
    expect(body.reason).toBe("device_code_expired");
  });
});

// --------------------------------------------------------------------------
// the ORCID new-iD path: sign-in-through-ORCID during a device flow
// --------------------------------------------------------------------------

describe("device flow reached through a brand-new ORCID sign-in", () => {
  test("pending -> verify -> confirm -> token", async () => {
    // A person who clicks verification_uri_complete but is not signed in is
    // sent through ORCID sign-in first; `next` carries them back to
    // /cli/authorize?code=... once the website (phase 2) exists. The
    // backend does not consume `next` itself -- it is carried purely so the
    // website knows where to return the browser -- so this test drives the
    // callback/finalize pair directly and then the device routes with the
    // session finalize issues.
    const csrf = "csrf-device-new-id";
    const callbackRes = await app.request(
      new Request(`${APP}/auth/orcid/callback?state=${csrf}&code=fake-code`, {
        method: "GET",
        headers: {
          Cookie: `${STATE_COOKIE_NAME}=${encodeState({
            csrf,
            mode: "login",
            next: "/cli/authorize?code=XXXX-XXXX",
          })}`,
        },
      }),
      undefined,
      env(),
    );
    expect(callbackRes.status).toBe(302);
    const pendingCookieHeader = callbackRes.headers
      .getSetCookie()
      .find((ck) => ck.startsWith(`${PENDING_COOKIE_NAME}=`));
    if (!pendingCookieHeader) throw new Error("callback did not set a pending cookie");
    const pendingCookie = pendingCookieHeader.split(";")[0];

    const finalizeRes = await app.request(
      "https://app.nemar.org/auth/orcid/finalize",
      {
        method: "POST",
        headers: { Origin: ORIGIN, "content-type": "application/json", Cookie: pendingCookie },
        body: JSON.stringify({ email: "device-new-id@nemar.test", city: "City", country: "US" }),
      },
      env(),
    );
    expect(finalizeRes.status).toBe(200);
    const finalizeBody = (await finalizeRes.json()) as {
      dev_code?: string;
      user: { status: string };
    };
    expect(finalizeBody.user.status).toBe("pending");
    if (!finalizeBody.dev_code) throw new Error("finalize did not echo dev_code");

    const sessionCookieHeader = finalizeRes.headers
      .getSetCookie()
      .find((ck) => ck.startsWith("nemar_session="));
    if (!sessionCookieHeader) throw new Error("finalize did not set a session cookie");
    const newSessionCookie = sessionCookieHeader.split(";")[0];

    const { deviceCode, userCode } = await startCode("new-persons-laptop");

    const lookupRes = await lookup(userCode, newSessionCookie);
    expect(lookupRes.status).toBe(200);
    expect(((await lookupRes.json()) as { refusal: { code: string } | null }).refusal?.code).toBe(
      "account_pending",
    );

    const confirmBeforeVerify = await confirm(userCode, newSessionCookie);
    expect(confirmBeforeVerify.status).toBe(403);

    const verifyRes = await app.request(
      "/auth/email/verify",
      {
        method: "POST",
        headers: { Origin: ORIGIN, "content-type": "application/json", Cookie: newSessionCookie },
        body: JSON.stringify({ code: finalizeBody.dev_code }),
      },
      env(),
    );
    expect(verifyRes.status).toBe(200);

    const confirmAfterVerify = await confirm(userCode, newSessionCookie);
    expect(confirmAfterVerify.status).toBe(200);

    const tokenRes = await pollToken(deviceCode);
    expect(tokenRes.status).toBe(200);
    const tokenBody = (await tokenRes.json()) as {
      user: { email: string; username: string | null };
    };
    expect(tokenBody.user.email).toBe("device-new-id@nemar.test");
    // Deliberately no assertion on `username`: ADR 0047 -- `username` is
    // nullable because assignment runs best-effort behind the response,
    // so it is not guaranteed to have landed by the time this request
    // returns.
  });

  test("the /auth/orcid/complete redirect carries the device-flow next", async () => {
    // Phase 3's one backend fix (nemarOrg/website#316): a brand-new ORCID
    // account started from the CLI's confirm page must not lose its way back
    // there. Drives only the callback -- the pending cookie's contents and
    // the finalize step are already covered by the test above.
    const csrf = "csrf-device-next";
    const callbackRes = await app.request(
      new Request(`${APP}/auth/orcid/callback?state=${csrf}&code=fake-code`, {
        method: "GET",
        headers: {
          Cookie: `${STATE_COOKIE_NAME}=${encodeState({
            csrf,
            mode: "login",
            next: "/cli/authorize?code=XXXX-XXXX",
          })}`,
        },
      }),
      undefined,
      env(),
    );
    expect(callbackRes.status).toBe(302);
    expect(callbackRes.headers.get("Location")).toBe(
      `${APP}/auth/orcid/complete?next=${encodeURIComponent("/cli/authorize?code=XXXX-XXXX")}`,
    );
  });

  test("an ordinary signup's next ('/') is not appended", async () => {
    // The unqualified case (a plain click on the public /signup page) must
    // render exactly as it did before this change -- no bare `?next=%2F`.
    const csrf = "csrf-device-next-default";
    const callbackRes = await app.request(
      new Request(`${APP}/auth/orcid/callback?state=${csrf}&code=fake-code`, {
        method: "GET",
        headers: {
          Cookie: `${STATE_COOKIE_NAME}=${encodeState({ csrf, mode: "login", next: "/" })}`,
        },
      }),
      undefined,
      env(),
    );
    expect(callbackRes.status).toBe(302);
    expect(callbackRes.headers.get("Location")).toBe(`${APP}/auth/orcid/complete`);
  });
});

// --------------------------------------------------------------------------
// contract compliance: every response shape matches its published schema
// --------------------------------------------------------------------------

/** Named issue paths on failure, rather than a bare "expected true" --
 *  matches the pattern in backend/test/auth-me-payload-route.test.ts. */
function schemaIssues(parsed: {
  success: boolean;
  error?: { issues: { path: (string | number)[] }[] };
}): string[] {
  return parsed.success ? [] : (parsed.error?.issues ?? []).map((i) => i.path.join("."));
}

describe("responses match their published contract schemas", () => {
  test("POST /auth/device/start", async () => {
    const res = await start("schema-check-machine");
    const parsed = deviceStartResponseSchema.safeParse(await res.json());
    expect(schemaIssues(parsed)).toEqual([]);
  });

  test("POST /auth/device/token: authorization_pending carries no reason", async () => {
    const { deviceCode } = await startCode();
    const res = await pollToken(deviceCode);
    const parsed = deviceTokenErrorSchema.safeParse(await res.json());
    expect(schemaIssues(parsed)).toEqual([]);
  });

  test("POST /auth/device/token: a terminal error carries reason", async () => {
    const res = await pollToken("z".repeat(40));
    const parsed = deviceTokenErrorSchema.safeParse(await res.json());
    expect(schemaIssues(parsed)).toEqual([]);
  });

  test("POST /auth/device/token: success", async () => {
    const ada = seedUser("ada-schema-token@nemar.test");
    const { deviceCode, userCode } = await startCode();
    await confirm(userCode, await sessionCookie(ada));
    const res = await pollToken(deviceCode);
    const parsed = deviceTokenSuccessSchema.safeParse(await res.json());
    expect(schemaIssues(parsed)).toEqual([]);
  });

  test("GET /auth/device/lookup", async () => {
    const ada = seedUser("ada-schema-lookup@nemar.test");
    const { userCode } = await startCode();
    const res = await lookup(userCode, await sessionCookie(ada));
    const parsed = deviceLookupResponseSchema.safeParse(await res.json());
    expect(schemaIssues(parsed)).toEqual([]);
  });

  test("POST /auth/device/confirm: success", async () => {
    const ada = seedUser("ada-schema-confirm@nemar.test");
    const { userCode } = await startCode();
    const res = await confirm(userCode, await sessionCookie(ada));
    const parsed = deviceConfirmResponseSchema.safeParse(await res.json());
    expect(schemaIssues(parsed)).toEqual([]);
  });

  test("a top-level refusal body (e.g. an unknown code at lookup)", async () => {
    const ada = seedUser("ada-schema-refusal@nemar.test");
    const res = await lookup("not-a-code", await sessionCookie(ada));
    const parsed = deviceRefusalResponseSchema.safeParse(await res.json());
    expect(schemaIssues(parsed)).toEqual([]);
  });
});
