/**
 * Real route tests for the ORCID relink flow (#913): GET/POST /auth/orcid/start
 * minting rules and the /auth/orcid/callback branch ordering.
 *
 * Real engine throughout — bun:sqlite behind realD1 (every migration applied),
 * real session issuance via issueSession(), real state cookies via
 * encodeState(), real Hono dispatch via app.request(), and a real local
 * Bun.serve standing in for ORCID's /oauth/token (the only external boundary;
 * same approach as test/orcid-auth.test.ts's exchange tests). No mocks.
 *
 * These pin the properties the pure-helper tests cannot: that the callback
 * consults decideLinkOutcome (conflict) BEFORE the relink mode is ever
 * honored, that relinkIdentity receives (fromOrcid, toOrcid) from the real
 * DB reads in the right argument order, and that relink intent can only be
 * minted by the Origin-checked, session-required POST — never by a GET.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Hono } from "hono";
import { authOrcidRoutes } from "../src/routes/auth-orcid";
import { decodeState, encodeState } from "../src/services/orcid-auth";
import { issueSession } from "../src/services/web-session";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const OLD_ID = "0000-0002-1825-0097";
const NEW_ID = "0000-0001-5109-353X";
const CSRF = "csrf-route-test-value";
const APP = "https://app.nemar.org";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let orcidServer: Server;

beforeAll(() => {
  // Local stand-in for ORCID's token endpoint: always exchanges the code
  // for NEW_ID. Listens on an ephemeral port.
  orcidServer = Bun.serve({
    port: 0,
    fetch(req) {
      if (new URL(req.url).pathname === "/oauth/token") {
        return Response.json({ orcid: NEW_ID, name: "New Name", access_token: "unused" });
      }
      return new Response("not found", { status: 404 });
    },
  });
});

afterAll(() => {
  orcidServer.stop(true);
});

function env(): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "test",
    ORCID_CLIENT_ID: "APP-TEST",
    ORCID_CLIENT_SECRET: "test-secret",
    ORCID_API_BASE: `http://localhost:${orcidServer.port}`,
    APP_BASE_URL: APP,
    WEB_SESSION_COOKIE_DOMAIN: "",
    ENCRYPTION_KEY: "route-test-encryption-key-0123456789",
  } as unknown as Bindings;
}

interface SeededUser {
  id: number;
}

function seedUser(email: string, orcid: string | null): SeededUser {
  db.run(
    `INSERT INTO users (email, status, signup_source, email_verified, orcid, orcid_verified)
     VALUES (?, 'approved', 'web', 1, ?, ?)`,
    [email, orcid, orcid ? 1 : 0],
  );
  const row = db.query<{ id: number }, [string]>("SELECT id FROM users WHERE email = ?").get(email);
  if (!row) throw new Error(`seed failed for ${email}`);
  return { id: row.id };
}

function linkIdentity(userId: number, orcid: string): void {
  db.run(
    "INSERT INTO oauth_identities (user_id, provider, provider_subject, display_name) VALUES (?, 'orcid', ?, 'Old Name')",
    [userId, orcid],
  );
}

async function sessionCookie(userId: number): Promise<string> {
  const { cookieIdRaw } = await issueSession(env(), userId, false, null, null, "orcid");
  return `nemar_session=${cookieIdRaw}`;
}

function stateCookie(mode: string, next = "/settings"): string {
  return `__Host-nemar_oauth_state=${encodeState({ csrf: CSRF, mode: mode as "login", next })}`;
}

function stateFromSetCookie(res: Response): ReturnType<typeof decodeState> {
  const setCookies = res.headers.getSetCookie();
  const state = setCookies.find((c) => c.startsWith("__Host-nemar_oauth_state="));
  if (!state) return null;
  const value = state.split(";")[0].slice("__Host-nemar_oauth_state=".length);
  return value ? decodeState(value) : null;
}

beforeEach(() => {
  db = freshDb();
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/auth", authOrcidRoutes);
});

describe("relink intent minting (#913)", () => {
  test("GET /orcid/start?mode=relink degrades to login — a link can never arm a swap", async () => {
    const res = await app.request(
      "https://app.nemar.org/auth/orcid/start?mode=relink&next=/settings",
      { method: "GET" },
      env(),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("/oauth/authorize");
    const state = stateFromSetCookie(res);
    expect(state?.mode).toBe("login");
  });

  test("POST /orcid/start?mode=relink mints relink for a same-origin, authenticated request", async () => {
    const user = seedUser("relink-mint@nemar.test", OLD_ID);
    const res = await app.request(
      "https://app.nemar.org/auth/orcid/start?mode=relink&next=/settings",
      {
        method: "POST",
        headers: { Origin: APP, Cookie: await sessionCookie(user.id) },
      },
      env(),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("/oauth/authorize");
    const state = stateFromSetCookie(res);
    expect(state?.mode).toBe("relink");
    expect(state?.next).toBe("/settings");
  });

  test("POST without a session redirects to login; cross-site Origin is refused outright", async () => {
    const anon = await app.request(
      "https://app.nemar.org/auth/orcid/start?mode=relink",
      { method: "POST", headers: { Origin: APP } },
      env(),
    );
    expect(anon.status).toBe(302);
    expect(anon.headers.get("Location")).toContain("/login?error=session_required");

    const user = seedUser("relink-origin@nemar.test", OLD_ID);
    const forged = await app.request(
      "https://app.nemar.org/auth/orcid/start?mode=relink",
      {
        method: "POST",
        headers: { Origin: "https://evil.example", Cookie: await sessionCookie(user.id) },
      },
      env(),
    );
    expect(forged.status).toBe(403);
  });
});

describe("callback relink wiring (#913)", () => {
  function callbackReq(cookies: string[]): Request {
    return new Request(`${APP}/auth/orcid/callback?state=${CSRF}&code=fake-code`, {
      method: "GET",
      headers: { Cookie: cookies.join("; ") },
    });
  }

  test("relink swaps the identity end-to-end: DB reads feed relinkIdentity in the right order", async () => {
    const user = seedUser("relink-happy@nemar.test", OLD_ID);
    linkIdentity(user.id, OLD_ID);

    const res = await app.request(
      callbackReq([stateCookie("relink"), await sessionCookie(user.id)]),
      undefined,
      env(),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`${APP}/settings`);

    const ident = db
      .query<{ provider_subject: string }, [number]>(
        "SELECT provider_subject FROM oauth_identities WHERE user_id = ?",
      )
      .get(user.id);
    expect(ident?.provider_subject).toBe(NEW_ID);
    const u = db
      .query<{ orcid: string; orcid_verified: number }, [number]>(
        "SELECT orcid, orcid_verified FROM users WHERE id = ?",
      )
      .get(user.id);
    expect(u?.orcid).toBe(NEW_ID);
    expect(u?.orcid_verified).toBe(1);
    // The audit row's from/to must come from the real DB read + token
    // exchange, in that argument order.
    const audit = db
      .query<{ details: string }, [number]>(
        "SELECT details FROM audit_log WHERE action = 'orcid_relinked' AND user_id = ?",
      )
      .get(user.id);
    expect(JSON.parse(audit?.details ?? "{}")).toEqual({ from: OLD_ID, to: NEW_ID });
  });

  test("conflict beats relink: an iD backing another account is refused in every mode", async () => {
    const victim = seedUser("relink-victim@nemar.test", NEW_ID);
    linkIdentity(victim.id, NEW_ID);
    const attacker = seedUser("relink-attacker@nemar.test", OLD_ID);
    linkIdentity(attacker.id, OLD_ID);

    const res = await app.request(
      callbackReq([stateCookie("relink"), await sessionCookie(attacker.id)]),
      undefined,
      env(),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("error=orcid_linked_other");

    // Nothing moved, for either account.
    const victimIdent = db
      .query<{ user_id: number }, [string]>(
        "SELECT user_id FROM oauth_identities WHERE provider_subject = ?",
      )
      .get(NEW_ID);
    expect(victimIdent?.user_id).toBe(victim.id);
    const attackerRow = db
      .query<{ orcid: string }, [number]>("SELECT orcid FROM users WHERE id = ?")
      .get(attacker.id);
    expect(attackerRow?.orcid).toBe(OLD_ID);
  });

  test("a second iD without relink mode keeps the historical refusal", async () => {
    const user = seedUser("relink-refuse@nemar.test", OLD_ID);
    linkIdentity(user.id, OLD_ID);

    const res = await app.request(
      callbackReq([stateCookie("link"), await sessionCookie(user.id)]),
      undefined,
      env(),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("error=orcid_already_have");

    // A plain sign-in never touches the session's account (ADR 0119 rule 10): the finished iD
    // belongs to nobody, so it is a new sign-up and the account keeps its own iD.
    const signIn = await app.request(
      callbackReq([stateCookie("login"), await sessionCookie(user.id)]),
      undefined,
      env(),
    );
    expect(signIn.status).toBe(302);
    expect(signIn.headers.get("Location")).toContain("/auth/orcid/complete");
    const ident = db
      .query<{ provider_subject: string }, [number]>(
        "SELECT provider_subject FROM oauth_identities WHERE user_id = ?",
      )
      .get(user.id);
    expect(ident?.provider_subject).toBe(OLD_ID);
  });

  test("relink with an expired session refuses loudly instead of signing into another account", async () => {
    // The finished iD belongs to someone else; without the guard the
    // no-session branch would silently sign the browser in as them.
    const other = seedUser("relink-other@nemar.test", NEW_ID);
    linkIdentity(other.id, NEW_ID);

    const res = await app.request(callbackReq([stateCookie("relink")]), undefined, env());
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("error=orcid_relink_session");
    // And no session was issued.
    const setCookies = res.headers.getSetCookie();
    expect(setCookies.some((c) => c.startsWith("nemar_session="))).toBe(false);
  });
});
