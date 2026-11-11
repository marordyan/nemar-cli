/**
 * E2E tests for the passwordless email-code auth flow (#569, #572, #595).
 *
 * Targets a deployed backend (set TEST_API_URL; defaults to api.nemar.org).
 * In development environments the /auth/code/request endpoint echoes the
 * generated code back in the response body as `dev_code` so live tests
 * can finish the flow without an email inbox. Production responses do
 * NOT include `dev_code`; a dedicated assertion below pins that
 * boundary so a misconfigured deploy can't quietly leak the code.
 *
 * Prod-traffic safeguard: if TEST_API_URL points at api.nemar.org or
 * data.nemar.org, the suite skips itself unless TEST_ALLOW_PROD=1.
 * Although the tests only touch ephemeral email addresses and the
 * passwordless surface, the cookie endpoints set real sessions and
 * the per-email rate-limit table would accumulate junk rows.
 *
 * Seeding: #595 made /auth/code/request a no-op for emails without a
 * users row. To keep the flow tests deterministic, each test that needs
 * a registered email POSTs to `/admin/test-fixtures/seed-web-user` (an
 * admin-token-gated, non-prod-only fixture endpoint) before requesting
 * the code. The seed creates a `signup_source='web'`, `status='pending'`
 * row that exactly mirrors what the legacy INSERT-OR-IGNORE path used
 * to produce, so the rest of the assertions are unchanged.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import "./setup";
import { deleteSeededAccounts, rememberSeededAccount } from "./helpers/seeded-account-teardown";
import { sessionCookiePair } from "./helpers/session-cookie";
import { LIVE_TARGET_BLOCKED, TEST_CONFIG } from "./setup";

const API = TEST_CONFIG.apiUrl;
const ORIGIN = "https://app.nemar.org";
const POINTS_AT_PROD = API.includes("api.nemar.org") || API.includes("data.nemar.org");
// `LIVE_TARGET_BLOCKED` rather than a local `!process.env.TEST_ALLOW_PROD`: raw
// truthiness disarms this guard for `TEST_ALLOW_PROD=0`, which is someone saying NO
// and used to send MORE traffic to production than leaving it unset. The shared flag
// is the strict opt-in (test/live-target.ts), so the two halves cannot disagree.
const PROD_GUARD_ACTIVE = LIVE_TARGET_BLOCKED;

const baseHeaders: Record<string, string> = TEST_CONFIG.bypassToken
  ? { "X-Test-Bypass": TEST_CONFIG.bypassToken }
  : {};

async function seedWebUser(
  email: string,
  status?: "pending" | "verified" | "approved" | "revoked",
  profile?: Partial<PublicUserProfile>,
): Promise<void> {
  const body: Record<string, unknown> = { email };
  if (status) body.status = status;
  if (profile) body.profile = profile;
  const r = await fetch(`${API}/admin/test-fixtures/seed-web-user`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TEST_CONFIG.adminApiKey}`,
      ...baseHeaders,
    },
    body: JSON.stringify(body),
  });
  if (r.status !== 200) {
    throw new Error(`seedWebUser failed (${r.status}): ${await r.text()}`);
  }
  rememberSeededAccount(await r.json());
}

// Best effort: tombstone this run's seeded accounts; the daily sweep is the backstop.
afterAll(async () => {
  if (PROD_GUARD_ACTIVE) return;
  await deleteSeededAccounts(API, baseHeaders);
});

function freshEmail(label: string): string {
  // Unique per run so per-email rate limits and code rotation can't
  // leak between tests. The `.test` TLD stays out of the real email
  // reachable space; the dev Workers' Resend config delivers test
  // addresses through Resend's test mode. NOTE: `/code/request` does
  // propagate Resend failures — on a hard send error it rolls back
  // the `auth_codes` row and returns 503, so tests against a
  // mis-configured RESEND_API_KEY will see 503 here, not silent ok.
  return `pl-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@nemar.test`;
}

/** A format-valid, NOT real, ORCID iD (shared/contract/publication.ts's
 *  orcidIdSchema checks only the `\d{4}-\d{4}-\d{4}-\d{3}[\dX]` shape, never
 *  the checksum), unique per call. Migration 0077's
 *  `idx_users_orcid_live_unique` is a real UNIQUE index on live rows, so a
 *  hardcoded literal like "0000-0002-1825-0097" is only good for the FIRST
 *  run ever: every later run collides with the row a previous run left
 *  behind and `seedWebUser` 500s with "Failed to seed user" (UNIQUE
 *  constraint failed: users.orcid). Mirrors auth-device-cli-live.test.ts's
 *  helper of the same name (#1301), which documents this exact file as one
 *  of the fixtures that used to leave the shared literal behind. */
function freshOrcid(): string {
  const digits = (Date.now().toString() + Math.random().toString().slice(2)).slice(-16);
  return `${digits.slice(0, 4)}-${digits.slice(4, 8)}-${digits.slice(8, 12)}-${digits.slice(12, 15)}${digits[15]}`;
}

async function postJson(path: string, body: unknown, extra: Record<string, string> = {}) {
  return fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...baseHeaders, ...extra },
    body: JSON.stringify(body),
  });
}

interface RequestResponse {
  ok: boolean;
  masked_email: string;
  dev_code?: string;
  dev_skip?: string;
  error?: string;
}

/** Nullable profile fields exposed on /verify and /me since #910. */
interface PublicUserProfile {
  given_name: string | null;
  family_name: string | null;
  orcid: string | null;
  orcid_verified: boolean;
  github_username: string | null;
  city: string | null;
  country: string | null;
  affiliation: string | null;
}

interface VerifyResponse {
  user?: { id: number; email: string; role: string; status: string } & Partial<PublicUserProfile>;
  error?: string;
}

interface MeResponse {
  user:
    | ({ id: number; email: string; role: string; status: string } & Partial<PublicUserProfile>)
    | null;
}

async function requestCode(email: string): Promise<{ status: number; body: RequestResponse }> {
  const r = await postJson("/auth/code/request", { email });
  const body = (await r.json()) as RequestResponse;
  return { status: r.status, body };
}

async function verifyCode(
  email: string,
  code: string,
  remember: boolean,
  origin = ORIGIN,
): Promise<{ status: number; body: VerifyResponse; setCookie: string | null }> {
  const r = await postJson("/auth/code/verify", { email, code, remember }, { Origin: origin });
  const body = (await r.json()) as VerifyResponse;
  return { status: r.status, body, setCookie: r.headers.get("Set-Cookie") };
}

describe.skipIf(PROD_GUARD_ACTIVE)("passwordless email-code auth (#569)", () => {
  test("happy path: request -> verify -> /me -> logout -> /me null", async () => {
    const email = freshEmail("happy");
    await seedWebUser(email);

    const req = await requestCode(email);
    expect(req.status).toBe(200);
    expect(req.body.ok).toBe(true);
    expect(req.body.masked_email).toMatch(/^[a-z]\*+@nemar\.test$/);
    // Live dev env should echo the code so we can finish the flow.
    expect(typeof req.body.dev_code).toBe("string");
    expect(req.body.dev_code).toMatch(/^\d{6}$/);

    const code = req.body.dev_code as string;
    const v = await verifyCode(email, code, true);
    expect(v.status).toBe(200);
    expect(v.body.user).toBeTruthy();
    expect(v.body.user?.email).toBe(email);
    // ADR 0040 phase 2: redeeming a code IS proof of the inbox, so
    // /code/verify promotes a first-time `pending` row to `verified` in the
    // same transaction that mints the session (applyEmailVerification,
    // backend/src/services/email-verification.ts) -- a web session can never
    // observe the DB's `pending` status through this path. The wire value
    // is the dashboard's two-state mapping on top of that, not the raw DB
    // status: `userStatusForDashboard` in auth-web.ts folds both `verified`
    // and `approved` to "active", so a freshly-verified account reads
    // "active" here, never "verified".
    expect(v.body.user?.status).toBe("active");
    expect(v.setCookie).toBeTruthy();

    const cookieAttrs = v.setCookie?.toLowerCase() ?? "";
    expect(cookieAttrs).toContain("httponly");
    expect(cookieAttrs).toContain("secure");
    expect(cookieAttrs).toContain("samesite=lax");
    expect(cookieAttrs).toContain("path=/");

    // Extract the cookie value for subsequent requests.
    const m = sessionCookiePair(v.setCookie);
    expect(m).toBeTruthy();
    const cookieValue = m as string;

    const me = await fetch(`${API}/auth/me`, {
      headers: { ...baseHeaders, Cookie: cookieValue },
    });
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as MeResponse;
    expect(meBody.user?.email).toBe(email);

    // #910: profile fields ride along on /me. A fresh fixture user has
    // no profile, so every field is null and orcid_verified is a real
    // boolean false (not the 0/1 D1 stores).
    const profile = meBody.user as MeResponse["user"] & PublicUserProfile;
    expect(profile.orcid_verified).toBe(false);
    for (const key of [
      "given_name",
      "family_name",
      "orcid",
      "github_username",
      "city",
      "country",
      "affiliation",
    ] as const) {
      expect(profile[key]).toBeNull();
    }

    const logout = await fetch(`${API}/auth/logout`, {
      method: "POST",
      headers: { ...baseHeaders, Origin: ORIGIN, Cookie: cookieValue },
    });
    expect(logout.status).toBe(200);

    const meAfter = await fetch(`${API}/auth/me`, {
      headers: { ...baseHeaders, Cookie: cookieValue },
    });
    const meAfterBody = (await meAfter.json()) as MeResponse;
    expect(meAfterBody.user).toBeNull();
  });

  test("non-allowlisted member gets silent-ok without dev_code (#1008)", async () => {
    // A registered member whose email is NOT synthetic (@nemar.test /
    // test@nemar.org) models the mirrored production users in the dev
    // D1. The gate must refuse to issue a code — same 200 shape as an
    // unregistered address, no dev_code, dev_skip explains why.
    const email = `pl-gate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    await seedWebUser(email);
    const req = await requestCode(email);
    expect(req.status).toBe(200);
    expect(req.body.ok).toBe(true);
    expect(req.body.dev_code).toBeUndefined();
    expect(req.body.dev_skip).toBe("not_allowlisted");
  });

  test("populated profile fields pass through /verify and /me (#910)", async () => {
    const email = freshEmail("profile");
    // github_username is case-insensitively UNIQUE (0012) and orcid is now
    // UNIQUE on live rows too (migration 0077); derive a per-run value for
    // both so reruns (which mint a fresh email each time) don't collide with
    // an earlier run's fixture row.
    const profile = {
      given_name: "Grace",
      family_name: "Hopper",
      orcid: freshOrcid(),
      orcid_verified: true,
      github_username: `gh-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      city: "Arlington",
      country: "United States",
      affiliation: "United States Navy",
    };
    await seedWebUser(email, "approved", profile);

    const req = await requestCode(email);
    expect(req.status).toBe(200);
    const code = req.body.dev_code as string;
    const v = await verifyCode(email, code, false);
    expect(v.status).toBe(200);

    // /verify carries the profile (same publicUser shaping as /me).
    const vUser = v.body.user as NonNullable<VerifyResponse["user"]> & PublicUserProfile;
    expect(vUser.orcid_verified).toBe(true);
    for (const key of [
      "given_name",
      "family_name",
      "orcid",
      "github_username",
      "city",
      "country",
      "affiliation",
    ] as const) {
      expect(vUser[key]).toBe(profile[key]);
    }

    // /me returns the same populated payload.
    const m = sessionCookiePair(v.setCookie);
    expect(m).toBeTruthy();
    const me = await fetch(`${API}/auth/me`, {
      headers: { ...baseHeaders, Cookie: m as string },
    });
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as MeResponse;
    const meUser = meBody.user as NonNullable<MeResponse["user"]> & PublicUserProfile;
    expect(meUser.orcid_verified).toBe(true);
    for (const key of [
      "given_name",
      "family_name",
      "orcid",
      "github_username",
      "city",
      "country",
      "affiliation",
    ] as const) {
      expect(meUser[key]).toBe(profile[key]);
    }
  });

  test("re-request rotates: first code stops working, second works", async () => {
    const email = freshEmail("rotate");
    await seedWebUser(email);
    const first = await requestCode(email);
    expect(first.status).toBe(200);
    const firstCode = first.body.dev_code as string;

    // The per-email rate limit is 1/min, so wait briefly past the
    // 60-second window. To avoid a 60s sleep in CI, exploit the fact
    // that the rate-limit window is measured in datetime('now','-1
    // minute') — a SLEEP-free way is to just expect 429 on the
    // immediate re-request and rely on a dedicated test for rotation
    // semantics by using a different email.
    //
    // Instead of waiting, verify rotation semantics by:
    //   1) confirming the first code verifies (happy path coverage)
    //   2) confirming an in-flight code is rotated when /code/request
    //      runs against the same email after passing the rate gate.
    // We sleep for 61s only when explicitly opted in to avoid slow CI.
    if (!process.env.TEST_PASSWORDLESS_ROTATION) {
      // Fast-path coverage: confirm the first code DOES verify.
      const v = await verifyCode(email, firstCode, false);
      expect(v.status).toBe(200);
      return;
    }

    await new Promise((r) => setTimeout(r, 61_000));
    const second = await requestCode(email);
    expect(second.status).toBe(200);
    const secondCode = second.body.dev_code as string;
    expect(secondCode).not.toBe(firstCode);

    // First code is now invalidated.
    const vOld = await verifyCode(email, firstCode, false);
    expect(vOld.status).toBe(401);

    const vNew = await verifyCode(email, secondCode, false);
    expect(vNew.status).toBe(200);
  });

  test("5 wrong attempts invalidates the code", async () => {
    const email = freshEmail("attempts");
    await seedWebUser(email);
    const req = await requestCode(email);
    expect(req.status).toBe(200);
    const realCode = req.body.dev_code as string;

    // Five wrong codes — keep them syntactically valid (6 digits) but
    // guaranteed not to match.
    const wrong = realCode === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) {
      const r = await verifyCode(email, wrong, false);
      expect(r.status).toBe(401);
    }

    // Sixth attempt with the right code is still rejected because
    // the row was marked used_at on attempt 5.
    const r = await verifyCode(email, realCode, false);
    expect(r.status).toBe(401);
  });

  test("verify rejects disallowed Origin", async () => {
    const email = freshEmail("origin");
    await seedWebUser(email);
    const req = await requestCode(email);
    const code = req.body.dev_code as string;
    const r = await verifyCode(email, code, false, "https://evil.example");
    expect(r.status).toBe(403);
  });

  test("verify rejects missing Origin", async () => {
    const email = freshEmail("noorigin");
    await seedWebUser(email);
    const req = await requestCode(email);
    const code = req.body.dev_code as string;
    const r = await fetch(`${API}/auth/code/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...baseHeaders },
      body: JSON.stringify({ email, code, remember: false }),
    });
    expect(r.status).toBe(403);
  });

  test("per-email rate limit: 2 requests within 60s returns 429", async () => {
    const email = freshEmail("ratelimit");
    await seedWebUser(email);
    const first = await requestCode(email);
    expect(first.status).toBe(200);
    const second = await requestCode(email);
    expect(second.status).toBe(429);
  });

  test("/me without cookie returns { user: null }", async () => {
    const r = await fetch(`${API}/auth/me`, { headers: baseHeaders });
    expect(r.status).toBe(200);
    const body = (await r.json()) as MeResponse;
    expect(body.user).toBeNull();
  });

  test("/logout without cookie is idempotent", async () => {
    const r = await fetch(`${API}/auth/logout`, {
      method: "POST",
      headers: { ...baseHeaders, Origin: ORIGIN },
    });
    expect(r.status).toBe(200);
  });

  test("masked email format: first char + N-1 stars + @domain", async () => {
    // Synthetic address — avoids creating live test rows against any
    // real account. Five-char local part exercises the >1-char branch
    // of maskEmail. Doubles as coverage for the #595 unregistered-skip
    // path: this email is never seeded, so the response must still
    // shape-match the success contract even though no row was created.
    const email = `mask-${Date.now()}@example.test`; // local part > 1
    const r = await requestCode(email);
    expect(r.status).toBe(200);
    const masked = r.body.masked_email;
    // First char preserved, rest replaced by stars, domain verbatim.
    expect(masked.startsWith("m")).toBe(true);
    expect(masked).toMatch(/^m\*+@example\.test$/);
    expect(masked.length).toBe(email.length); // same total length
  });

  // -----------------------------------------------------------------
  // #595 — /code/request must not create a phantom user or send an
  // email when the address is not already registered.
  // -----------------------------------------------------------------
  test("unregistered email: 200 + masked, no dev_code, no users row", async () => {
    const email = freshEmail("unreg");

    const r = await requestCode(email);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.masked_email).toMatch(/^[a-z]\*+@nemar\.test$/);
    // Dev-only signal that the gate fired (production response omits
    // dev_skip entirely; dev_code must NEVER be present here).
    expect(r.body.dev_code).toBeUndefined();
    expect(r.body.dev_skip).toBe("unregistered");

    // The verify endpoint should refuse — no code was ever issued.
    const v = await verifyCode(email, "000000", false);
    expect(v.status).toBe(401);

    // Admin-side proof that no row was created. /admin/users supports a
    // status filter; the unregistered email shouldn't appear in ANY
    // status bucket. Scan all four ('pending', 'verified', 'approved',
    // 'revoked') so a future regression that inserts with a different
    // default status would still be caught — the original #595
    // acceptance criterion is `SELECT COUNT(*) WHERE email = ?` = 0,
    // not "no pending row".
    for (const bucket of ["pending", "verified", "approved", "revoked"] as const) {
      const r = await fetch(`${API}/admin/users?status=${bucket}`, {
        headers: { Authorization: `Bearer ${TEST_CONFIG.adminApiKey}`, ...baseHeaders },
      });
      expect(r.status).toBe(200);
      const body = (await r.json()) as { users: Array<{ email: string }> };
      expect(body.users.find((u) => u.email === email)).toBeUndefined();
    }
  });

  // -----------------------------------------------------------------
  // #572 — cookie auth on user-scoped routes.
  // -----------------------------------------------------------------
  test("cookie auth: /datasets?mine=true accepts nemar_session", async () => {
    const email = freshEmail("cookie572");
    // Seed directly as 'approved' so the cookie path in authMiddleware
    // (status='approved' gate) accepts it. The fixture is dev-only so
    // this can't be used to short-circuit production approval.
    await seedWebUser(email, "approved");

    const req = await requestCode(email);
    expect(req.status).toBe(200);
    const code = req.body.dev_code as string;
    expect(typeof code).toBe("string");
    const v = await verifyCode(email, code, true);
    expect(v.status).toBe(200);
    const m = sessionCookiePair(v.setCookie);
    expect(m).toBeTruthy();
    const cookieValue = m as string;

    // GET /datasets?mine=true with cookie only (no Authorization
    // header). Pre-#572 this returned 401 "Authentication required to
    // view your datasets" because the bearer-only middleware never saw
    // the cookie.
    const mine = await fetch(`${API}/datasets?mine=true`, {
      headers: { ...baseHeaders, Cookie: cookieValue },
    });
    expect(mine.status).toBe(200);
    const mineBody = (await mine.json()) as { datasets: unknown[] };
    expect(Array.isArray(mineBody.datasets)).toBe(true);
  });

  test("cookie auth: no cookie + no bearer still 401s /datasets?mine=true", async () => {
    // Negative control for the #572 change: removing the cookie path
    // must not loosen the bearer-only behaviour for completely
    // unauthenticated requests.
    const r = await fetch(`${API}/datasets?mine=true`, { headers: baseHeaders });
    expect(r.status).toBe(401);
  });

  test("cookie auth: pending cookie is rejected on /datasets?mine=true", async () => {
    // The cookie path in `resolveCookieUser` (backend/src/middleware/auth.ts)
    // hard-gates on `isActiveAccountStatus`, which is `verified`/`approved`
    // only (ACTIVE_ACCOUNT_STATUSES, services/account-tier.ts) — `pending`
    // must NOT be accepted on user-mutating routes. Without this test, a
    // future refactor that relaxes the gate to also accept 'pending' would
    // land silently.
    //
    // Getting there via /code/verify no longer reaches a `pending` row: ADR
    // 0040 phase 2 made redeeming a code itself the proof of the inbox, so
    // applyEmailVerification (services/email-verification.ts) promotes a
    // first-time `pending` row to `verified` in the SAME transaction that
    // mints the session — a web session can never observe `status='pending'`
    // through that path any more (confirmed by the "active" status assertion
    // in the happy-path test above). So this seeds 'approved' (never
    // re-tiered by that promotion) to mint a normal, valid cookie, then
    // demotes the SAME row back to 'pending' via the fixture endpoint — a
    // plain UPDATE that never touches the already-minted session row — to
    // exercise the gate itself: does a live session whose account is
    // CURRENTLY pending get refused, regardless of how it got that way.
    const email = freshEmail("cookie572-pending");
    await seedWebUser(email, "approved");

    const req = await requestCode(email);
    expect(req.status).toBe(200);
    const code = req.body.dev_code as string;
    expect(typeof code).toBe("string");
    const v = await verifyCode(email, code, true);
    expect(v.status).toBe(200);
    const m = sessionCookiePair(v.setCookie);
    expect(m).toBeTruthy();
    const cookieValue = m as string;

    // Demote the account out from under the already-issued session.
    await seedWebUser(email, "pending");

    const mine = await fetch(`${API}/datasets?mine=true`, {
      headers: { ...baseHeaders, Cookie: cookieValue },
    });
    expect(mine.status).toBe(401);
  });

  test("cookie auth: bearer wins when both bearer and cookie are sent", async () => {
    // The middleware's documented order is "Bearer first, cookie
    // second". Send a valid cookie for user A alongside the existing
    // TEST_USER_API_KEY bearer (user B). The /users/me response must
    // identify user B, NOT user A — proving bearer short-circuits the
    // cookie path. Without this test, a future refactor that falls
    // through to cookie on bearer failure would be undetectable.
    if (!TEST_CONFIG.userApiKey) {
      console.warn("[#572 bearer-wins] TEST_USER_API_KEY unset; skipping bearer-wins assertion");
      return;
    }

    const cookieEmail = freshEmail("cookie572-bearerwins");
    await seedWebUser(cookieEmail, "approved");
    const req = await requestCode(cookieEmail);
    const code = req.body.dev_code as string;
    const v = await verifyCode(cookieEmail, code, true);
    const m = sessionCookiePair(v.setCookie);
    expect(m).toBeTruthy();
    const cookieValue = m as string;

    // /users/me uses `authMiddleware` and returns the resolved user's
    // email — perfect identity probe.
    const me = await fetch(`${API}/users/me`, {
      headers: {
        ...baseHeaders,
        Authorization: `Bearer ${TEST_CONFIG.userApiKey}`,
        Cookie: cookieValue,
      },
    });
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as { user: { email: string } };
    // Bearer must win — the returned email must NOT be the
    // cookie holder's seeded address.
    expect(meBody.user.email).not.toBe(cookieEmail);
  });
});

describe.skipIf(PROD_GUARD_ACTIVE)("PATCH /auth/profile (#912)", () => {
  interface PatchResponse {
    ok?: boolean;
    user?: { id: number; email: string } & Partial<PublicUserProfile>;
    error?: string;
  }

  async function patchProfile(
    cookieValue: string | null,
    body: unknown,
    origin: string | null = ORIGIN,
  ): Promise<{ status: number; body: PatchResponse }> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...baseHeaders,
    };
    if (origin) headers.Origin = origin;
    if (cookieValue) headers.Cookie = cookieValue;
    const r = await fetch(`${API}/auth/profile`, {
      method: "PATCH",
      headers,
      body: JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as PatchResponse };
  }

  async function signIn(email: string): Promise<string> {
    const req = await requestCode(email);
    expect(req.status).toBe(200);
    const code = req.body.dev_code as string;
    const v = await verifyCode(email, code, false);
    expect(v.status).toBe(200);
    const m = sessionCookiePair(v.setCookie);
    expect(m).toBeTruthy();
    return m as string;
  }

  // FIXED email, deliberately not freshEmail(): the GitHub-handle test below
  // stores a real handle ("octocat"), and github_username is unique across
  // users (COLLATE NOCASE dedup). With a fresh email each run, run N's row
  // would keep the handle and 409 every later run. A fixed email means the
  // handle only ever lives on this one row, and the dedup check excludes
  // self — so the suite is rerun-safe with no cleanup step. Costs one
  // /code/request per run on this address (per-email limit is 5/hour, so
  // more than ~5 local runs in an hour will see a 429 here).
  const PROFILE_EMAIL = "pl-profile-patch@nemar.test";
  let cookie: string;

  beforeAll(async () => {
    await seedWebUser(PROFILE_EMAIL, "approved");
    cookie = await signIn(PROFILE_EMAIL);
  });

  test("happy path: city/country/affiliation land and ride /auth/me", async () => {
    const r = await patchProfile(cookie, {
      city: " San Diego ",
      country: "USA",
      affiliation: "UCSD",
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.user?.city).toBe("San Diego"); // trimmed
    expect(r.body.user?.country).toBe("USA");
    expect(r.body.user?.affiliation).toBe("UCSD");

    const me = await fetch(`${API}/auth/me`, {
      headers: { ...baseHeaders, Cookie: cookie },
    });
    const meBody = (await me.json()) as MeResponse;
    expect(meBody.user?.city).toBe("San Diego");
    expect(meBody.user?.country).toBe("USA");
    expect(meBody.user?.affiliation).toBe("UCSD");

    // The write and its audit row land in one batch; read the row back via
    // the admin surface to prove the batch really carried both.
    const audit = await fetch(`${API}/admin/audit?limit=10`, {
      headers: {
        ...baseHeaders,
        Authorization: `Bearer ${TEST_CONFIG.adminApiKey}`,
      },
    });
    expect(audit.status).toBe(200);
    const auditBody = (await audit.json()) as {
      logs: { action: string; details: string | null }[];
    };
    const row = auditBody.logs.find(
      (l) =>
        l.action === "profile_updated" &&
        l.details != null &&
        l.details.includes('"San Diego"') &&
        l.details.includes('"UCSD"'),
    );
    expect(row).toBeTruthy();
    expect(JSON.parse(row?.details ?? "{}")).toEqual({
      city: "San Diego",
      country: "USA",
      affiliation: "UCSD",
    });
  });

  test("empty affiliation clears to null; city/country untouched", async () => {
    const r = await patchProfile(cookie, { affiliation: "" });
    expect(r.status).toBe(200);
    expect(r.body.user?.affiliation).toBeNull();
    expect(r.body.user?.city).toBe("San Diego");
    expect(r.body.user?.country).toBe("USA");
  });

  test("github handle: clear, then set a real handle via the live GitHub check", async () => {
    // Clear first so the set below is a *changed* handle every run — a
    // same-handle re-save deliberately skips the GitHub existence call,
    // and rerun N+1 would otherwise test nothing.
    //
    // NOT "octocat": test/api.test.ts asserts /auth/check-github reports
    // octocat as UNregistered, so parking it on this fixture row turns the
    // api-test CI job red. "mojombo" is equally real and unasserted-on.
    const cleared = await patchProfile(cookie, { github_username: "" });
    expect(cleared.status).toBe(200);
    expect(cleared.body.user?.github_username).toBeNull();

    const set = await patchProfile(cookie, { github_username: "@Mojombo" });
    expect(set.status).toBe(200);
    // "@" stripped, and GitHub's canonical casing stored, not what was typed.
    expect(set.body.user?.github_username).toBe("mojombo");

    // Re-saving the stored handle takes the unchanged-skip path (no GitHub
    // call, no dedup) and must still 200 with the value intact.
    const resave = await patchProfile(cookie, { github_username: "mojombo" });
    expect(resave.status).toBe(200);
    expect(resave.body.user?.github_username).toBe("mojombo");

    // Leave the fixture row with no handle: a real handle parked on a
    // persistent dev-DB row is exactly how the octocat incident broke CI.
    const teardown = await patchProfile(cookie, { github_username: "" });
    expect(teardown.status).toBe(200);
    expect(teardown.body.user?.github_username).toBeNull();
  });

  test("nonexistent github handle is a 400 from the live existence check", async () => {
    const nope = `nemar-e2e-nope-${Date.now().toString(36)}`;
    const r = await patchProfile(cookie, { github_username: nope });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid_github_username");
  });

  test("github handle held by another user is a 409, case-insensitively", async () => {
    // The victim is seeded with a per-run unique handle (fixture write, no
    // GitHub call) and never signs in.
    const otherEmail = freshEmail("profile-dup");
    const handle = `gh-dup-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    await seedWebUser(otherEmail, "approved", { github_username: handle });

    const exact = await patchProfile(cookie, { github_username: handle });
    expect(exact.status).toBe(409);
    expect(exact.body.error).toBe("github_in_use");

    const upper = await patchProfile(cookie, { github_username: handle.toUpperCase() });
    expect(upper.status).toBe(409);
    expect(upper.body.error).toBe("github_in_use");
  });

  test("validation errors: bad handle, empty city, empty country, empty body", async () => {
    const badHandle = await patchProfile(cookie, { github_username: "-bad-" });
    expect(badHandle.status).toBe(400);
    expect(badHandle.body.error).toBe("invalid_github_username");

    const emptyCity = await patchProfile(cookie, { city: "  ", country: "USA" });
    expect(emptyCity.status).toBe(400);
    expect(emptyCity.body.error).toBe("city_required");

    const emptyCountry = await patchProfile(cookie, { city: "San Diego", country: "" });
    expect(emptyCountry.status).toBe(400);
    expect(emptyCountry.body.error).toBe("country_required");

    const empty = await patchProfile(cookie, {});
    expect(empty.status).toBe(400);
    expect(empty.body.error).toBe("empty_patch");

    // Over the zod bound (affiliation max 200): rejected at the schema
    // layer. That 400 is zod-shaped, not {error, message} — the website
    // shows its generic copy for it, which is the accepted contract.
    const oversize = await patchProfile(cookie, { affiliation: "x".repeat(201) });
    expect(oversize.status).toBe(400);
  });

  test("no session is 401; wrong Origin is 403", async () => {
    const anon = await patchProfile(null, { city: "San Diego", country: "USA" });
    expect(anon.status).toBe(401);

    const badOrigin = await patchProfile(
      cookie,
      { city: "San Diego", country: "USA" },
      "https://evil.example",
    );
    expect(badOrigin.status).toBe(403);
  });

  // ADR 0042 ("Names stay ORCID-canonical when, and only when, a verified
  // ORCID is linked"): given_name/family_name are NOT unknown keys — since
  // fa0b1b33 (epic #1250 phase #1253) they're part of profilePatchSchema and
  // normalizeProfilePatch (services/profile.ts) — the ORCID-canonical rule
  // is enforced by the route itself (auth-web.ts), keyed on orcid_verified,
  // and only for the account that ORCID actually speaks for. Both tests use
  // a fresh account rather than the shared PROFILE_EMAIL fixture above:
  // unlike affiliation/github_username, given_name/family_name have no
  // "clear to null" input (an empty string is refused as *_required, not
  // treated as a clear), so there is no teardown path to leave the shared
  // row as it was.
  test("no verified ORCID: given_name/family_name are editable (#1253)", async () => {
    const email = freshEmail("profile-name-noorcid");
    await seedWebUser(email, "approved");
    const noOrcidCookie = await signIn(email);

    const r = await patchProfile(noOrcidCookie, { given_name: "Ada", family_name: "Lovelace" });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.user?.given_name).toBe("Ada");
    expect(r.body.user?.family_name).toBe("Lovelace");
  });

  test("verified ORCID: given_name/family_name refused 409 name_is_orcid_canonical", async () => {
    const email = freshEmail("profile-name-orcid");
    await seedWebUser(email, "approved", { orcid: freshOrcid(), orcid_verified: true });
    const orcidCookie = await signIn(email);

    const r = await patchProfile(orcidCookie, { given_name: "X", family_name: "Y" });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("name_is_orcid_canonical");
  });
});

describe.skipIf(PROD_GUARD_ACTIVE)("email change flow (#911)", () => {
  async function post(
    path: string,
    cookieValue: string | null,
    body: unknown,
    origin: string | null = ORIGIN,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...baseHeaders,
    };
    if (origin) headers.Origin = origin;
    if (cookieValue) headers.Cookie = cookieValue;
    const r = await fetch(`${API}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  }

  async function signIn(email: string): Promise<string> {
    const req = await requestCode(email);
    expect(req.status).toBe(200);
    const v = await verifyCode(email, req.body.dev_code as string, false);
    expect(v.status).toBe(200);
    const m = sessionCookiePair(v.setCookie);
    expect(m).toBeTruthy();
    return m as string;
  }

  const originalEmail = freshEmail("emailchange");
  const newEmail = freshEmail("emailchange-new");
  let cookie: string;

  beforeAll(async () => {
    await seedWebUser(originalEmail, "approved");
    cookie = await signIn(originalEmail);
  });

  test("request guards: same email 409, taken email 409, anon 401, bad origin 403", async () => {
    const same = await post("/auth/email/change/request", cookie, { email: originalEmail });
    expect(same.status).toBe(409);
    expect(same.body.error).toBe("same_email");

    const takenEmail = freshEmail("emailchange-taken");
    await seedWebUser(takenEmail);
    const taken = await post("/auth/email/change/request", cookie, { email: takenEmail });
    expect(taken.status).toBe(409);
    expect(taken.body.error).toBe("email_in_use");

    const anon = await post("/auth/email/change/request", null, { email: newEmail });
    expect(anon.status).toBe(401);

    const badOrigin = await post(
      "/auth/email/change/request",
      cookie,
      { email: newEmail },
      "https://evil.example",
    );
    expect(badOrigin.status).toBe(403);
  });

  test("non-synthetic target from a plain member is silently skipped off-prod (#1008)", async () => {
    // The dev D1 mirrors real production users; a QA session must not be
    // able to mail an arbitrary real address from staging.
    const r = await post("/auth/email/change/request", cookie, {
      email: `ec-real-${Date.now().toString(36)}@example.com`,
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.dev_code).toBeUndefined();
    expect(r.body.dev_skip).toBe("not_allowlisted");
  });

  test("happy path: request -> wrong code -> cross-user attempt -> verify -> email moved", async () => {
    const req = await post("/auth/email/change/request", cookie, { email: newEmail });
    expect(req.status).toBe(200);
    expect(req.body.ok).toBe(true);
    const code = req.body.dev_code as string;
    expect(code).toMatch(/^\d{6}$/);

    const wrong = await post("/auth/email/change/verify", cookie, {
      email: newEmail,
      code: code === "000000" ? "000001" : "000000",
    });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toBe("code_incorrect");

    // Session binding (migration 0066): a DIFFERENT signed-in user holding
    // the correct code — the shared-inbox scenario — cannot redeem it. The
    // per-user lookup (USER_BOUND_CODE_LOOKUP_SQL, bound to the bystander's
    // own id) finds no row at all for them — the row exists but is bound to
    // the legitimate requester's id, so it is invisible to this lookup — and
    // auth-web.ts's `!row` branch answers the same CODE_EXPIRED_BODY it
    // would for a truly expired or already-used code, not `code_incorrect`
    // (that code is reserved for a row that WAS found but whose hash didn't
    // match, e.g. the `wrong` case just above). The code itself stays live
    // for the legitimate requester below.
    const bystanderEmail = freshEmail("emailchange-bystander");
    await seedWebUser(bystanderEmail, "approved");
    const bystanderCookie = await signIn(bystanderEmail);
    const hijack = await post("/auth/email/change/verify", bystanderCookie, {
      email: newEmail,
      code,
    });
    expect(hijack.status).toBe(401);
    expect(hijack.body.error).toBe("code_expired");

    const ok = await post("/auth/email/change/verify", cookie, { email: newEmail, code });
    expect(ok.status).toBe(200);
    const user = ok.body.user as { email: string };
    expect(user.email).toBe(newEmail);

    // The session cookie survives the change (sessions key on user id).
    const me = await fetch(`${API}/auth/me`, {
      headers: { ...baseHeaders, Cookie: cookie },
    });
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as MeResponse;
    expect(meBody.user?.email).toBe(newEmail);

    // A repeat submit is short-circuited by the same_email guard (the
    // session user's email now IS the target) — this asserts the guard
    // ordering, NOT single-use consumption. The consume-once conditional
    // UPDATE mirrors /code/verify verbatim and only matters for concurrent
    // double-submits, which an E2E suite can't force deterministically; the
    // cross-user attempt above covers the security-relevant redemption path.
    const replay = await post("/auth/email/change/verify", cookie, { email: newEmail, code });
    expect(replay.status).toBe(409);
    expect(replay.body.error).toBe("same_email");
  });

  test("the old address no longer backs an account (sign-in code is a silent skip)", async () => {
    const req = await requestCode(originalEmail);
    expect(req.status).toBe(200);
    expect(req.body.dev_code).toBeUndefined();
    expect(req.body.dev_skip).toBe("unregistered");
  });
});
