/**
 * Every path that ends an account's grants tells the clients AFTER its batch has committed, and never
 * waits for a partner to answer (epic #2014 phase #2019; ADR 0119 rule 15).
 *
 * `oidc-cascade.test.ts` proves each path QUEUES the logouts in its batch, and `oidc-logout-sender.test.ts`
 * proves what the sender does with a queued row. This file is the seam between them, per path: the
 * request that ended the grants is answered while a slow partner is still thinking (the call is handed to
 * `waitUntil`, so the response does not wait for it), and the partner then receives its logout. A path
 * that forgot to hand the first attempt on would pass the first file and the second and leave its
 * deliveries to the half-hourly tick, which this file also notices: the partner would be told a half hour
 * late at best, and in dev, where the tick does not run, never.
 *
 * The partner is a real HTTPS server (`helpers/oidc-logout-standin.ts`) that answers after 1.5 seconds;
 * "does not wait" is the response arriving in under one.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { encodeState } from "../src/services/orcid-auth";
import { sweepCiTestAccounts } from "../src/services/test-account-sweep";
import {
  deliveries,
  giveKey,
  registerLogoutClient,
  seedProvenAccount,
  signInAt,
  subjectOf,
  usernameOf,
} from "./helpers/oidc-cascade";
import { decodeJwt, rotateKeys, sessionCookie } from "./helpers/oidc-flow";
import { OWNER_KEY, type OidcHarness, startOidcHarness } from "./helpers/oidc-harness";
import { type LogoutStandin, startLogoutStandin } from "./helpers/oidc-logout-standin";

const APP = "https://app.nemar.org";
const NEW_ID = "0000-0001-5109-353X";
const CSRF = "csrf-oidc-logout-callers";
const KEY = "nm_oidc-logout-callers-key-0123456789abcdef0123456";
const SLOW_MS = 1500;

let h: OidcHarness;
let partner: LogoutStandin;
let orcid: Server;

beforeAll(() => {
  orcid = Bun.serve({
    port: 0,
    fetch(req) {
      return new URL(req.url).pathname === "/oauth/token"
        ? Response.json({ orcid: NEW_ID, name: "New Name", access_token: "unused" })
        : new Response("not found", { status: 404 });
    },
  });
});

afterAll(() => {
  orcid.stop(true);
});

beforeEach(async () => {
  h = await startOidcHarness({ HOST_PREFIXED_SESSION_COOKIE: "1" });
  await rotateKeys(h);
  partner = startLogoutStandin(async () => {
    await new Promise((r) => setTimeout(r, SLOW_MS));
    return new Response(null, { status: 200 });
  });
});

afterEach(async () => {
  await h.settle();
  await partner.stop();
});

/** An account with a proven iD, signed in at a `person_proven_orcid` client that has the partner's address. */
async function holder() {
  const client = await registerLogoutClient(h, {
    backchannel_logout_uri: partner.url,
    sign_in_rule: "person_proven_orcid",
  });
  const userId = seedProvenAccount(h);
  await signInAt(h, userId, client);
  return { client, userId };
}

interface Path {
  name: string;
  run(userId: number): Promise<Response | { status: number }>;
}

const PATHS: Path[] = [
  {
    name: "admin revoke",
    run: (id) => h.call("POST", `/admin/revoke/by-id/${id}`, { key: OWNER_KEY }),
  },
  {
    name: "the owner's soft delete",
    run: (id) => h.call("DELETE", `/admin/users/by-id/${id}`, { key: OWNER_KEY }),
  },
  {
    name: "the owner's end-account",
    run: (id) =>
      h.call("POST", `/admin/oidc/accounts/${id}/end`, {
        key: OWNER_KEY,
        body: { reason: "merged" },
      }),
  },
  {
    name: "an ORCID unlink",
    async run(id) {
      await giveKey(h, id, KEY);
      return h.call("POST", "/auth/orcid/unlink", { key: KEY });
    },
  },
  {
    name: "an ORCID relink",
    async run(id) {
      const cookies = [
        `__Host-nemar_oauth_state=${encodeState({ csrf: CSRF, mode: "relink", next: "/settings" })}`,
        await sessionCookie(h, id),
      ];
      return h.call("GET", `/auth/orcid/callback?state=${CSRF}&code=fake-code`, {
        base: APP,
        headers: { Cookie: cookies.join("; ") },
        env: {
          ORCID_CLIENT_ID: "APP-TEST",
          ORCID_CLIENT_SECRET: "test-secret",
          ORCID_API_BASE: `http://localhost:${orcid.port}`,
          ENCRYPTION_KEY: "route-test-encryption-key-0123456789",
        },
      });
    },
  },
  {
    name: "a change of kind away from person",
    run(id) {
      h.db.query("UPDATE users SET orcid_verified = 0 WHERE id = ?").run(id);
      return h.call("POST", `/admin/users/${usernameOf(h, id)}/kind`, {
        key: OWNER_KEY,
        body: { kind: "service" },
      });
    },
  },
];

describe.each(PATHS)("$name", (path) => {
  test("answers while the partner is still thinking, and the partner is then told", async () => {
    const { client, userId } = await holder();

    const started = Date.now();
    const res = await path.run(userId);
    const answered = Date.now() - started;

    expect([200, 302]).toContain(res.status);
    // The partner takes 1.5 seconds; the answer to the person who ended the grants does not wait.
    expect(answered).toBeLessThan(SLOW_MS - 500);
    expect(deliveries(h, userId).length).toBe(1);

    await h.settle();

    expect(partner.requests.length).toBe(1);
    const claims = decodeJwt(partner.requests[0]?.form.get("logout_token") as string).claims;
    expect(claims.sub).toBe(subjectOf(h, userId));
    expect(claims.aud).toBe(client.clientId);
    expect(deliveries(h, userId)[0]).toMatchObject({
      status: "sent",
      attempts: 1,
      last_status: 200,
    });
  });
});

describe("the sweep of the live tests' accounts", () => {
  test("makes the first attempt itself: a swept account's logouts are not left for a tick that dev never runs", async () => {
    const { userId } = await holder();
    h.db
      .query(
        `UPDATE users SET email = 'dcli-oidc-logout-1760000000001-abc123@nemar.test',
                signup_source = 'web', created_at = datetime('now', '-30 days'),
                updated_at = datetime('now', '-30 days') WHERE id = ?`,
      )
      .run(userId);

    const swept = await sweepCiTestAccounts(h.env);

    expect(swept.tombstoned).toBe(1);
    expect(partner.requests.length).toBe(1);
    expect(deliveries(h, userId)[0]).toMatchObject({ status: "sent", reason: "account_deleted" });
  });
});
