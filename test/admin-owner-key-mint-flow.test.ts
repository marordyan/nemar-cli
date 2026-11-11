/**
 * E2E tests for the owner-only account-kind key mint (epic #1272 phase 4,
 * #1284; ADR 0048): `POST /admin/users/:username/keys`.
 *
 * Targets a deployed backend (set TEST_API_URL; defaults to api.nemar.org).
 * The dev worker deploys only from `dev` (.github/workflows/deploy-backend.yml), so
 * this phase's routes are not guaranteed to be live on whatever backend
 * TEST_API_URL points at until the epic branch reaches dev. This file
 * probes the route first; a non-404 proves it is deployed (ownerMiddleware
 * refuses the admin credential before the route ever looks a username up,
 * so the probe itself never needs to resolve to a real account), and every
 * case below skips itself with a loud console message rather than failing
 * when it is not -- the same pattern test/auth-device-flow.test.ts uses.
 *
 * Prod-traffic safeguard: matches test/auth-passwordless.test.ts and
 * test/auth-device-flow.test.ts -- if TEST_API_URL points at api.nemar.org
 * or data.nemar.org, the suite skips itself unless TEST_ALLOW_PROD=1.
 *
 * Targets are the seeded dev-D1 fixtures (scripts/seed-dev-db.sql), whose
 * account kinds migration 0082 and that script both set: `test-owner` is
 * `service`, `test-web` stays `person`. Using stable, already-username-ed
 * fixtures avoids seeding-and-resolving a fresh username-less web row just
 * to address this username-keyed route.
 *
 * TEST_ADMIN_API_KEY is an admin, not an owner, and MUST get 403 -- that
 * case needs no owner credential and always runs. The owner-path cases
 * (a real mint against `test-owner`) need TEST_OWNER_API_KEY, which is
 * optional; they probe-skip when it is unset rather than failing the run.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import "./setup";
import { LIVE_TARGET_BLOCKED, TEST_CONFIG } from "./setup";

const API = TEST_CONFIG.apiUrl;
const POINTS_AT_PROD = API.includes("api.nemar.org") || API.includes("data.nemar.org");
// `LIVE_TARGET_BLOCKED` rather than a local `!process.env.TEST_ALLOW_PROD`: raw
// truthiness disarms this guard for `TEST_ALLOW_PROD=0`, which is someone saying NO
// and used to send MORE traffic to production than leaving it unset. The shared flag
// is the strict opt-in (test/live-target.ts), so the two halves cannot disagree.
const PROD_GUARD_ACTIVE = LIVE_TARGET_BLOCKED;

const baseHeaders: Record<string, string> = TEST_CONFIG.bypassToken
  ? { "X-Test-Bypass": TEST_CONFIG.bypassToken }
  : {};

let routeDeployed = false;

beforeAll(async () => {
  if (PROD_GUARD_ACTIVE) return;
  if (!TEST_CONFIG.adminApiKey) {
    console.warn("[admin-owner-key-mint-flow] SKIPPING every case: TEST_ADMIN_API_KEY is unset.");
    return;
  }
  const probe = await fetch(`${API}/admin/users/nonexistent-probe-account/keys`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TEST_CONFIG.adminApiKey}`,
      ...baseHeaders,
    },
    body: JSON.stringify({ name: "probe" }),
  });
  // An admin (non-owner) credential is refused with 403 before the route
  // ever looks the username up, so a live route answers 403 here, never
  // 404 -- an unmatched path (route not deployed) 404s instead.
  routeDeployed = probe.status !== 404;
  if (!routeDeployed) {
    console.warn(
      "[admin-owner-key-mint-flow] SKIPPING every case: POST /admin/users/:username/keys " +
        "answered 404. The dev worker deploys only from `dev` (AGENTS.md release pipeline), " +
        "so this phase's routes are not live on the backend TEST_API_URL points at yet -- " +
        "expected until the epic branch reaches dev, or until the branch is deployed by hand.",
    );
  }
});

describe.skipIf(PROD_GUARD_ACTIVE)("POST /admin/users/:username/keys (#1284, ADR 0048)", () => {
  test("an admin (not an owner) is refused with 403", async () => {
    if (!routeDeployed || !TEST_CONFIG.adminApiKey) return;
    const res = await fetch(`${API}/admin/users/test-owner/keys`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_CONFIG.adminApiKey}`,
        ...baseHeaders,
      },
      body: JSON.stringify({ name: "should-not-mint" }),
    });
    expect(res.status).toBe(403);
  });

  test("an owner mints a key for the service-kind test-owner fixture, and it authenticates", async () => {
    if (!routeDeployed) return;
    if (!TEST_CONFIG.ownerApiKey) {
      console.warn(
        "[admin-owner-key-mint-flow] SKIPPING the owner-path case: TEST_OWNER_API_KEY is unset.",
      );
      return;
    }

    const mintRes = await fetch(`${API}/admin/users/test-owner/keys`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_CONFIG.ownerApiKey}`,
        ...baseHeaders,
      },
      body: JSON.stringify({ name: "e2e-owner-mint" }),
    });
    if (mintRes.status === 404) {
      console.warn(
        "[admin-owner-key-mint-flow] SKIPPING: no 'test-owner' fixture on this backend.",
      );
      return;
    }
    expect(mintRes.status).toBe(200);
    const mintBody = (await mintRes.json()) as { api_key: string; key: { id: number } };
    expect(mintBody.api_key.startsWith("nm_")).toBe(true);

    const me = await fetch(`${API}/users/me`, {
      headers: { Authorization: `Bearer ${mintBody.api_key}`, ...baseHeaders },
    });
    expect(me.status).toBe(200);

    // Clean up: this fixture is shared across the whole live suite, so the
    // minted key must not outlive this test.
    const revokeRes = await fetch(`${API}/admin/users/test-owner/keys/${mintBody.key.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${TEST_CONFIG.ownerApiKey}`, ...baseHeaders },
    });
    expect(revokeRes.status).toBe(200);
  });

  test("the person-kind test-web fixture is refused with 403 person_account", async () => {
    if (!routeDeployed) return;
    if (!TEST_CONFIG.ownerApiKey) {
      console.warn(
        "[admin-owner-key-mint-flow] SKIPPING the owner-path case: TEST_OWNER_API_KEY is unset.",
      );
      return;
    }
    // test-web is the shared web-QA account and stays `person` by design
    // (ADR 0048) -- a stable, always-present person target for this case.
    const res = await fetch(`${API}/admin/users/test-web/keys`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_CONFIG.ownerApiKey}`,
        ...baseHeaders,
      },
      body: JSON.stringify({ name: "should-not-mint" }),
    });
    if (res.status === 404) {
      console.warn("[admin-owner-key-mint-flow] SKIPPING: no 'test-web' fixture on this backend.");
      return;
    }
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("person_account");
  });
});
