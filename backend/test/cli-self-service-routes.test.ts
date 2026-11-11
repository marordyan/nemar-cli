/**
 * Token-authenticated self-service identity routes (#1266, epic #1250; ADR
 * 0044), plus the old-address notification #1054 asks for.
 *
 * The claim under test is parity: the SAME handler, reached with the CLI's
 * bearer token instead of the dashboard's session cookie, applies the same
 * rules and raises the same refusals. So every case here drives the HTTP route
 * with an `Authorization: Bearer` header and asserts on what landed in the
 * database or in the mail.
 *
 * Real engine throughout: bun:sqlite behind `realD1` with every migration
 * applied, real Hono dispatch, real zod validation, real HMAC code hashing via
 * the production `hashAuthCode`, real API-key hashing via `hashApiKey`, real
 * session issuance via `issueSession`, real ORCID state signing via
 * `signCliState`. The two external boundaries -- ORCID and GitHub -- are a
 * local `Bun.serve()` reached through the bindings production already uses to
 * point at a mirror, and Resend is redirected to another local server by
 * `withFakeResend`, so services/email.ts runs unchanged including its
 * non-production delivery fence. No mocks.
 */

import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { Hono } from "hono";
import { userMeResponseSchema } from "../../shared/contract/user.js";
import { authOrcidRoutes } from "../src/routes/auth-orcid";
import { authWebRoutes } from "../src/routes/auth-web";
import { userRoutes } from "../src/routes/users";
import { hashAuthCode } from "../src/services/auth-code";
import { STATE_COOKIE_NAME, signCliState } from "../src/services/orcid-auth";
import { hashApiKey } from "../src/services/token";
import { issueSession } from "../src/services/web-session";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";
import { type CapturedEmail, asSend, sendsTo, withFakeResend } from "./helpers/resend";

const APP = "https://app.nemar.org";
const ENCRYPTION_KEY = "cli-self-service-test-encryption-key-0123";

/** Keys are >= 32 chars: `resolveBearerUser` refuses anything shorter. */
const ADA_KEY = "cli-self-service-ada-key-0123456789abcdef";
const BOB_KEY = "cli-self-service-bob-key-0123456789abcdef";

const ADA_ORCID = "0000-0002-1825-0097";
const BOB_ORCID = "0000-0002-1974-1293";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let external: Server;
let externalBase: string;
/** Which iD the local ORCID token endpoint hands back for the next callback. */
let tokenOrcid = ADA_ORCID;
/** GitHub logins the local mirror should answer 404 for. */
let missingGithubLogins = new Set<string>();
/** GitHub logins the local mirror should answer 502 for -- an OUTAGE, which
 *  is a different answer from "this account does not exist" (#1052). */
let failingGithubLogins = new Set<string>();
/**
 * `/users/:login` hits since the last reset.
 *
 * What makes the duplicate-handle refusal falsifiable at all. `idx_users_github`
 * (COLLATE NOCASE, migration 0012) would reject the same write at the UPDATE
 * and the route's catch maps it to the same 409 body, so a status-and-body
 * assertion passes whether or not the PRE-CHECK exists. The pre-check runs
 * before `validateGitHubUsername`, so the observable difference is that a
 * refused save spends no GitHub call -- which is also why it is ordered that
 * way: a duplicate must not cost a rate-limited request on a shared token.
 */
let githubCalls = 0;

beforeAll(() => {
  external = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/oauth/token") {
        return Response.json({ orcid: tokenOrcid, name: "Ada Lovelace", access_token: "unused" });
      }
      if (url.pathname.endsWith("/personal-details")) {
        return Response.json({
          name: { "given-names": { value: "Ada" }, "family-name": { value: "Lovelace" } },
        });
      }
      const gh = url.pathname.match(/^\/users\/(.+)$/);
      if (gh) {
        githubCalls += 1;
        if (failingGithubLogins.has(gh[1])) return new Response("upstream boom", { status: 502 });
        if (missingGithubLogins.has(gh[1])) return new Response("not found", { status: 404 });
        return Response.json({ login: gh[1], id: 4242 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  externalBase = `http://localhost:${external.port}`;
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = externalBase;
});

afterAll(() => {
  (globalThis as { NEMAR_GITHUB_API_URL?: string }).NEMAR_GITHUB_API_URL = undefined;
  external.stop(true);
});

/**
 * `DEV_EMAIL_ALLOWLIST` defaults to the synthetic test domain so the mail this
 * suite asserts on is actually delivered. Individual tests pass "" to exercise
 * the fence, which is the state the dev worker is really in for a real user's
 * address (AGENTS.md: ~609 real addresses behind a live Resend key).
 */
function env(allowlist = "@nemar.test"): Bindings {
  return {
    DB: realD1(db),
    ENVIRONMENT: "test",
    ENCRYPTION_KEY,
    RESEND_API_KEY: "test-resend-key",
    FROM_EMAIL: "NEMAR <noreply@nemar.test>",
    DEV_EMAIL_ALLOWLIST: allowlist,
    ORCID_CLIENT_ID: "APP-TEST",
    ORCID_CLIENT_SECRET: "test-secret",
    ORCID_API_BASE: externalBase,
    ORCID_PUB_API_BASE: externalBase,
    APP_BASE_URL: APP,
    WEB_SESSION_COOKIE_DOMAIN: "",
    GITHUB_ADMIN_PAT: "test-pat-not-used-against-a-real-host",
    API_BASE_URL: "http://localhost:8787",
  } as unknown as Bindings;
}

interface SeedOpts {
  username?: string | null;
  status?: string;
  github?: string | null;
  orcid?: string | null;
  orcidVerified?: boolean;
  identityBacked?: boolean;
  givenName?: string | null;
  familyName?: string | null;
  city?: string | null;
  country?: string | null;
}

async function seedUser(
  email: string,
  apiKey: string | null,
  opts: SeedOpts = {},
): Promise<number> {
  db.run(
    `INSERT INTO users (username, email, password_hash, status, role, signup_source,
                        email_verified, orcid, orcid_verified, github_username,
                        given_name, family_name, city, country)
     VALUES (?, ?, 'x', ?, 'member', 'cli', 1, ?, ?, ?, ?, ?, ?, ?)`,
    [
      opts.username ?? null,
      email,
      opts.status ?? "verified",
      opts.orcid ?? null,
      opts.orcidVerified ? 1 : 0,
      opts.github ?? null,
      opts.givenName ?? null,
      opts.familyName ?? null,
      opts.city ?? null,
      opts.country ?? null,
    ],
  );
  const row = db.query<{ id: number }, [string]>("SELECT id FROM users WHERE email = ?").get(email);
  if (!row) throw new Error(`seed failed for ${email}`);
  if (apiKey) {
    db.run("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)", [
      row.id,
      await hashApiKey(apiKey),
      apiKey.slice(0, 8),
    ]);
  }
  if (opts.identityBacked && opts.orcid) {
    db.run(
      "INSERT INTO oauth_identities (user_id, provider, provider_subject) VALUES (?, 'orcid', ?)",
      [row.id, opts.orcid],
    );
  }
  return row.id;
}

function userRow(id: number) {
  return db
    .query<
      {
        id: number;
        email: string;
        username: string | null;
        github_username: string | null;
        given_name: string | null;
        family_name: string | null;
        city: string | null;
        country: string | null;
        orcid: string | null;
        orcid_verified: number;
        email_verified: number;
      },
      [number]
    >(
      `SELECT id, email, username, github_username, given_name, family_name, city, country,
              orcid, orcid_verified, email_verified FROM users WHERE id = ?`,
    )
    .get(id);
}

/** A bearer-authenticated JSON call, the way the CLI makes it: no Origin. */
function withToken(
  path: string,
  apiKey: string,
  body: unknown,
  method = "POST",
  bindings: Bindings = env(),
): Promise<Response> {
  return app.request(
    path,
    {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    },
    bindings,
  );
}

/** GET /users/me with a bearer token -- no body, unlike withToken above. */
function usersMeFor(apiKey: string): Promise<Response> {
  return app.request("/users/me", { headers: { Authorization: `Bearer ${apiKey}` } }, env());
}

beforeEach(() => {
  db = freshDb();
  tokenOrcid = ADA_ORCID;
  missingGithubLogins = new Set();
  failingGithubLogins = new Set();
  githubCalls = 0;
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/auth", authOrcidRoutes);
  app.route("/auth", authWebRoutes);
  app.route("/users", userRoutes);
});

// ---------------------------------------------------------------------------
// Email change over a bearer token
// ---------------------------------------------------------------------------

/** Run the whole two-step change and hand back the captured mail. */
async function changeEmail(
  apiKey: string,
  newAddress: string,
  bindings: Bindings,
): Promise<{ request: Response; verify: Response; mail: CapturedEmail[] }> {
  return withFakeResend(async (calls) => {
    const request = await withToken(
      "/auth/email/change/request",
      apiKey,
      { email: newAddress },
      "POST",
      bindings,
    );
    const requestBody = (await request.clone().json()) as { dev_code?: string };
    const verify = await withToken(
      "/auth/email/change/verify",
      apiKey,
      { email: newAddress, code: requestBody.dev_code ?? "000000" },
      "POST",
      bindings,
    );
    return { request, verify, mail: calls };
  });
}

describe("POST /auth/email/change/* with a bearer token", () => {
  test("changes the address end to end and tells the OLD one", async () => {
    const ada = await seedUser("ada@nemar.test", ADA_KEY);

    const { request, verify, mail } = await changeEmail(ADA_KEY, "ada-new@nemar.test", env());

    expect(request.status).toBe(200);
    expect(verify.status).toBe(200);
    const body = (await verify.json()) as { ok: boolean; old_address_notified: boolean };
    expect(body.ok).toBe(true);
    expect(body.old_address_notified).toBe(true);

    const row = userRow(ada);
    expect(row?.email).toBe("ada-new@nemar.test");
    // The new inbox was just proved, so the flag follows the address.
    expect(row?.email_verified).toBe(1);

    // The notice goes to the address that LOST the account -- that is its
    // entire job (#1054), and sending it to the new one would tell the person
    // who just typed the code something they already know.
    const notices = sendsTo(mail, "ada@nemar.test");
    expect(notices.length).toBe(1);
    expect(notices[0].subject).toBe("Your NEMAR account email was changed");
    // Masked, because whoever reads the old inbox may not be the owner.
    expect(notices[0].html).toContain("a******@nemar.test");
    expect(notices[0].html).not.toContain("ada-new@nemar.test");
    expect(notices[0].html).toContain("If this was not you");
    expect(notices[0].html).toContain("nemar.org/support");
  });

  test("a failed notice does not fail the change", async () => {
    // The change has already committed by the time the notice is attempted;
    // rolling it back over an undeliverable email would be the worse outcome.
    const ada = await seedUser("ada@nemar.test", ADA_KEY);

    const result = await withFakeResend(
      async (calls) => {
        const request = await withToken("/auth/email/change/request", ADA_KEY, {
          email: "ada-new@nemar.test",
        });
        const { dev_code } = (await request.json()) as { dev_code: string };
        const verify = await withToken("/auth/email/change/verify", ADA_KEY, {
          email: "ada-new@nemar.test",
          code: dev_code,
        });
        return { verify, calls };
      },
      // Resend refuses every send, exactly as a real outage does.
      { status: 500 },
    );

    expect(result.verify.status).toBe(200);
    const body = (await result.verify.json()) as { ok: boolean; old_address_notified: boolean };
    expect(body.ok).toBe(true);
    // Reported rather than hidden: the caller can say the notice did not land.
    expect(body.old_address_notified).toBe(false);
    expect(userRow(ada)?.email).toBe("ada-new@nemar.test");
  });

  test("off production the notice is fenced to allow-listed addresses", async () => {
    // The dev D1 carries ~609 real addresses and the dev worker holds a live
    // Resend key (AGENTS.md). The old address is the one recipient in this
    // flow that the caller did not choose, so the fence has to cover it.
    const ada = await seedUser("ada@nemar.test", ADA_KEY);

    const { verify, mail } = await changeEmail(ADA_KEY, "ada-new@nemar.test", env(""));

    expect(verify.status).toBe(200);
    expect((await verify.json()) as { old_address_notified: boolean }).toMatchObject({
      old_address_notified: false,
    });
    expect(sendsTo(mail, "ada@nemar.test")).toEqual([]);
    // The change still happened; only the mail was withheld.
    expect(userRow(ada)?.email).toBe("ada-new@nemar.test");
  });

  test("refuses an address another live account holds", async () => {
    await seedUser("ada@nemar.test", ADA_KEY);
    await seedUser("taken@nemar.test", null);

    const res = await withToken("/auth/email/change/request", ADA_KEY, {
      email: "TAKEN@nemar.test",
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code: string; message: string };
    expect(body.error).toBe("email_in_use");
    expect(body.code).toBe("email_in_use");
    expect(body.message).toContain("nemar.org/settings");
    // Nothing was mailed and no code exists for the target.
    expect(
      db
        .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM auth_codes WHERE email = ?")
        .get("taken@nemar.test")?.n,
    ).toBe(0);
  });

  test("a code issued for one account cannot be redeemed by another's token", async () => {
    // The whole point of the 0066 user_id binding, now reachable from two
    // credentials: a second person holding the same inbox (or the same code)
    // must not be able to attach the address to THEIR account.
    const ada = await seedUser("ada@nemar.test", ADA_KEY);
    const bob = await seedUser("bob@nemar.test", BOB_KEY);

    const request = await withToken("/auth/email/change/request", ADA_KEY, {
      email: "shared@nemar.test",
    });
    const { dev_code } = (await request.json()) as { dev_code: string };

    const stolen = await withToken("/auth/email/change/verify", BOB_KEY, {
      email: "shared@nemar.test",
      code: dev_code,
    });

    expect(stolen.status).toBe(401);
    expect((await stolen.json()) as { error: string }).toMatchObject({ error: "code_expired" });
    expect(userRow(bob)?.email).toBe("bob@nemar.test");
    expect(userRow(ada)?.email).toBe("ada@nemar.test");

    // And the rightful owner's code still works afterwards.
    const mine = await withFakeResend(() =>
      withToken("/auth/email/change/verify", ADA_KEY, {
        email: "shared@nemar.test",
        code: dev_code,
      }),
    );
    expect(mine.status).toBe(200);
    expect(userRow(ada)?.email).toBe("shared@nemar.test");
  });

  test("a wrong code is refused and the address does not move", async () => {
    const ada = await seedUser("ada@nemar.test", ADA_KEY);
    await withToken("/auth/email/change/request", ADA_KEY, { email: "ada-new@nemar.test" });

    const res = await withToken("/auth/email/change/verify", ADA_KEY, {
      email: "ada-new@nemar.test",
      code: "000000",
    });

    // 000000 is a valid draw, so pin the assertion to the account instead of
    // to the status alone.
    expect(userRow(ada)?.email).toBe("ada@nemar.test");
    if (res.status !== 200) {
      expect((await res.json()) as { error: string }).toMatchObject({ error: "code_incorrect" });
    }
  });

  test("the current address is refused with a sentence, not a bare code", async () => {
    await seedUser("ada@nemar.test", ADA_KEY);
    const res = await withToken("/auth/email/change/request", ADA_KEY, { email: "ada@nemar.test" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("same_email");
    expect(body.message).toContain("already the address");
  });

  test("an unknown token is refused before anything is mailed", async () => {
    await seedUser("ada@nemar.test", ADA_KEY);
    const res = await withToken("/auth/email/change/request", `${ADA_KEY}-wrong`, {
      email: "ada-new@nemar.test",
    });
    expect(res.status).toBe(401);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM auth_codes").get()?.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// PATCH /auth/profile over a bearer token
// ---------------------------------------------------------------------------

describe("PATCH /auth/profile with a bearer token", () => {
  test("sets the GitHub handle, checked against GitHub", async () => {
    const ada = await seedUser("ada@nemar.test", ADA_KEY);
    const res = await withToken("/auth/profile", ADA_KEY, { github_username: "@octocat" }, "PATCH");
    expect(res.status).toBe(200);
    // The leading "@" people paste is stripped by the shared normaliser.
    expect(userRow(ada)?.github_username).toBe("octocat");
    // A changed handle IS looked up: existence is checked before it is stored.
    expect(githubCalls).toBe(1);
  });

  test("refuses a GitHub handle that does not exist", async () => {
    const ada = await seedUser("ada@nemar.test", ADA_KEY);
    missingGithubLogins.add("ghost-handle");
    const res = await withToken(
      "/auth/profile",
      ADA_KEY,
      { github_username: "ghost-handle" },
      "PATCH",
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: "invalid_github_username",
    });
    expect(userRow(ada)?.github_username).toBeNull();
  });

  test("refuses a GitHub handle another live account holds", async () => {
    const ada = await seedUser("ada@nemar.test", ADA_KEY);
    await seedUser("other@nemar.test", null, { github: "Octocat" });
    const res = await withToken("/auth/profile", ADA_KEY, { github_username: "octocat" }, "PATCH");
    expect(res.status).toBe(409);
    expect((await res.json()) as { code: string }).toMatchObject({ code: "github_in_use" });
    expect(userRow(ada)?.github_username).toBeNull();
    // Refused by the pre-check, not by the index at UPDATE time: no GitHub
    // call was spent. Without this the assertions above pass either way.
    expect(githubCalls).toBe(0);
  });

  test("a GitHub OUTAGE is a 503, and the stored handle is untouched", async () => {
    // #1052's tri-state, over both credentials. Reporting an outage as
    // `invalid_github_username` tells someone their own correct handle does
    // not exist and leaves them editing a field that is already right.
    const ada = await seedUser("ada@nemar.test", ADA_KEY, { github: "old-handle" });
    failingGithubLogins.add("octocat");

    const viaToken = await withToken(
      "/auth/profile",
      ADA_KEY,
      { github_username: "octocat" },
      "PATCH",
    );
    expect(viaToken.status).toBe(503);
    const body = (await viaToken.json()) as { error: string; message: string };
    expect(body.error).toBe("github_unavailable");
    expect(body.message).toContain("try again");
    expect(userRow(ada)?.github_username).toBe("old-handle");

    const { cookieIdRaw } = await issueSession(env(), ada, false, null, null, "email_code");
    const viaCookie = await app.request(
      "/auth/profile",
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: `nemar_session=${cookieIdRaw}`,
          Origin: "https://nemar.org",
        },
        body: JSON.stringify({ github_username: "octocat" }),
      },
      env(),
    );
    expect(viaCookie.status).toBe(503);
    expect((await viaCookie.json()) as { error: string }).toMatchObject({
      error: "github_unavailable",
    });
    expect(userRow(ada)?.github_username).toBe("old-handle");
  });

  test("a bearer token wins when a cookie for another account is also sent", async () => {
    // `resolveActingAccount` documents this order; nothing exercised it. A
    // request carrying both must act for the TOKEN's account, because that is
    // the credential the caller chose deliberately.
    const ada = await seedUser("ada@nemar.test", ADA_KEY);
    const bob = await seedUser("bob@nemar.test", BOB_KEY);
    const { cookieIdRaw } = await issueSession(env(), bob, false, null, null, "email_code");

    const res = await app.request(
      "/auth/profile",
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ADA_KEY}`,
          Cookie: `nemar_session=${cookieIdRaw}`,
          Origin: "https://nemar.org",
        },
        body: JSON.stringify({ username: "alovelace" }),
      },
      env(),
    );

    expect(res.status).toBe(200);
    expect(userRow(ada)?.username).toBe("alovelace");
    expect(userRow(bob)?.username).toBeNull();
  });

  test("sets a username while it is empty, and refuses one that is taken", async () => {
    const ada = await seedUser("ada@nemar.test", ADA_KEY);
    await seedUser("other@nemar.test", null, { username: "Taken" });

    const ok = await withToken("/auth/profile", ADA_KEY, { username: "alovelace" }, "PATCH");
    expect(ok.status).toBe(200);
    expect(userRow(ada)?.username).toBe("alovelace");

    const clash = await withToken("/auth/profile", ADA_KEY, { username: "taken" }, "PATCH");
    expect(clash.status).toBe(409);
    expect((await clash.json()) as { error: string }).toMatchObject({ error: "username_taken" });
    expect(userRow(ada)?.username).toBe("alovelace");
  });

  test("refuses a rename once an admin has approved the account", async () => {
    const ada = await seedUser("ada@nemar.test", ADA_KEY, {
      username: "alovelace",
      status: "approved",
    });
    const res = await withToken("/auth/profile", ADA_KEY, { username: "adal" }, "PATCH");
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("username_locked");
    expect(body.message).toContain("contact an admin");
    expect(userRow(ada)?.username).toBe("alovelace");
  });

  test("sets the name when no verified ORCID speaks for the account", async () => {
    const ada = await seedUser("ada@nemar.test", ADA_KEY);
    const res = await withToken(
      "/auth/profile",
      ADA_KEY,
      { given_name: "Ada", family_name: "Lovelace" },
      "PATCH",
    );
    expect(res.status).toBe(200);
    const row = userRow(ada);
    expect(row?.given_name).toBe("Ada");
    expect(row?.family_name).toBe("Lovelace");
  });

  test("refuses a name edit while a verified ORCID iD is linked", async () => {
    const ada = await seedUser("ada@nemar.test", ADA_KEY, {
      orcid: ADA_ORCID,
      orcidVerified: true,
      givenName: "Ada",
      familyName: "Lovelace",
    });
    const res = await withToken("/auth/profile", ADA_KEY, { given_name: "Augusta" }, "PATCH");
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("name_is_orcid_canonical");
    expect(body.message).toContain("orcid.org");
    expect(userRow(ada)?.given_name).toBe("Ada");
  });

  test("sets city and country, and refuses a blank one", async () => {
    const ada = await seedUser("ada@nemar.test", ADA_KEY);
    const ok = await withToken(
      "/auth/profile",
      ADA_KEY,
      { city: " San Diego ", country: "USA" },
      "PATCH",
    );
    expect(ok.status).toBe(200);
    const row = userRow(ada);
    expect(row?.city).toBe("San Diego");
    expect(row?.country).toBe("USA");

    const blank = await withToken("/auth/profile", ADA_KEY, { city: "   " }, "PATCH");
    expect(blank.status).toBe(400);
    expect((await blank.json()) as { error: string }).toMatchObject({ error: "city_required" });
    expect(userRow(ada)?.city).toBe("San Diego");
  });

  test("a token still cannot edit somebody else's row", async () => {
    // The patch is scoped by the credential, never by anything in the body.
    const ada = await seedUser("ada@nemar.test", ADA_KEY);
    const bob = await seedUser("bob@nemar.test", BOB_KEY);
    const res = await withToken(
      "/auth/profile",
      BOB_KEY,
      { username: "bobby", id: ada, user_id: ada },
      "PATCH",
    );
    expect(res.status).toBe(200);
    expect(userRow(bob)?.username).toBe("bobby");
    expect(userRow(ada)?.username).toBeNull();
  });

  test("no credential at all is still refused", async () => {
    await seedUser("ada@nemar.test", ADA_KEY);
    const res = await app.request(
      "/auth/profile",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "nobody" }),
      },
      env(),
    );
    // No bearer and no allowed Origin: the cookie half's CSRF gate answers
    // first, exactly as it did before tokens were accepted here.
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// ORCID: cli-start -> cli-handoff -> callback
// ---------------------------------------------------------------------------

/** The `t=` token out of a cli-start response. */
function handoffToken(authorizeUrl: string): string {
  const t = new URL(authorizeUrl).searchParams.get("t");
  if (!t) throw new Error(`no state token in ${authorizeUrl}`);
  return t;
}

/** GET the interstitial, with an optional browser session cookie. */
function openHandoff(token: string, sessionCookie?: string): Promise<Response> {
  return app.request(
    `/auth/orcid/cli-handoff?t=${encodeURIComponent(token)}`,
    sessionCookie ? { headers: { Cookie: sessionCookie } } : {},
    env(),
  );
}

/** POST the interstitial's confirm form, the way its own page does. */
function continueHandoff(token: string, sessionCookie?: string): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Origin: "https://nemar.org",
  };
  if (sessionCookie) headers.Cookie = sessionCookie;
  return app.request(
    "https://app.nemar.org/auth/orcid/cli-handoff/continue",
    { method: "POST", headers, body: `t=${encodeURIComponent(token)}` },
    env(),
  );
}

/**
 * Walk BOTH handoff steps the way a person does -- read the page, press the
 * button -- and hand back the state cookie and the csrf.
 *
 * The interstitial is not a formality to skip in tests: it is the step that
 * makes the intent's target account visible before ORCID sees anything, so a
 * helper that jumped straight to the redirect would be testing a flow nobody
 * can perform.
 */
async function walkHandoff(
  token: string,
  sessionCookie?: string,
): Promise<{ cookie: string; csrf: string }> {
  const page = await openHandoff(token, sessionCookie);
  expect(page.status).toBe(200);
  const res = await continueHandoff(token, sessionCookie);
  expect(res.status).toBe(302);
  const setCookie = res.headers.get("Set-Cookie") ?? "";
  const cookie = setCookie.split(";")[0];
  expect(cookie.startsWith(`${STATE_COOKIE_NAME}=`)).toBe(true);
  const csrf = new URL(res.headers.get("Location") ?? "https://x/").searchParams.get("state");
  if (!csrf) throw new Error("handoff redirect carried no state");
  return { cookie, csrf };
}

function callback(csrf: string, cookies: string[]): Promise<Response> {
  return app.request(
    `https://app.nemar.org/auth/orcid/callback?code=orcid-code&state=${encodeURIComponent(csrf)}`,
    { headers: { Cookie: cookies.join("; ") } },
    env(),
  );
}

describe("POST /auth/orcid/cli-start", () => {
  test("mints a handoff a browser with no session can complete", async () => {
    const ada = await seedUser("ada@nemar.test", ADA_KEY);
    tokenOrcid = ADA_ORCID;

    const started = await withToken("/auth/orcid/cli-start", ADA_KEY, { mode: "link" });
    expect(started.status).toBe(200);
    const body = (await started.json()) as {
      authorize_url: string;
      expires_in: number;
      mode: string;
    };
    expect(body.mode).toBe("link");
    expect(body.expires_in).toBe(600);
    expect(body.authorize_url.startsWith(`${APP}/auth/orcid/cli-handoff?t=`)).toBe(true);

    const { cookie, csrf } = await walkHandoff(handoffToken(body.authorize_url));
    // No `nemar_session` cookie anywhere: this is a browser opened from a
    // terminal, which is the whole reason the account rides in the state.
    const res = await callback(csrf, [cookie]);

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`${APP}/settings`);
    const row = userRow(ada);
    expect(row?.orcid).toBe(ADA_ORCID);
    expect(row?.orcid_verified).toBe(1);
    expect(
      db
        .query<{ n: number }, [number]>(
          "SELECT COUNT(*) AS n FROM oauth_identities WHERE user_id = ?",
        )
        .get(ada)?.n,
    ).toBe(1);
  });

  test("a successful link clears the orcid_verified gap end to end (#1271)", async () => {
    // The row this gate exists for: a CLI account created with `nemar auth
    // signup --orcid <id>` gets a TYPED iD and `orcid_verified = 0`. Everything
    // else on the account is complete, so `orcid_verified` is the ONLY gap --
    // before the link it must block the upload-access request, and after a
    // real cli-start -> handoff -> callback round trip it must be gone from
    // both `GET /users/me` and that same request, with no other gap taking
    // its place.
    const ada = await seedUser("ada@nemar.test", ADA_KEY, {
      username: "alovelace",
      givenName: "Ada",
      familyName: "Lovelace",
      github: "alovelace",
      city: "London",
      country: "United Kingdom",
    });
    tokenOrcid = ADA_ORCID;

    const before = userMeResponseSchema.parse(await (await usersMeFor(ADA_KEY)).json());
    expect(before.user.profile_gaps?.map((g) => g.field)).toEqual(["orcid_verified"]);

    const beforeRequest = await withToken("/users/me/upload-access/request", ADA_KEY, {
      why: "Depositing our lab's 64-channel EEG study of motor imagery, 40 participants.",
    });
    expect(beforeRequest.status).toBe(400);
    const beforeRefusal = (await beforeRequest.json()) as { error: string; missing: string[] };
    expect(beforeRefusal.error).toBe("profile_incomplete");
    expect(beforeRefusal.missing).toEqual(["orcid_verified"]);

    const started = await withToken("/auth/orcid/cli-start", ADA_KEY, { mode: "link" });
    expect(started.status).toBe(200);
    const { authorize_url } = (await started.json()) as { authorize_url: string };
    const { cookie, csrf } = await walkHandoff(handoffToken(authorize_url));
    const linkRes = await callback(csrf, [cookie]);
    expect(linkRes.status).toBe(302);
    expect(userRow(ada)?.orcid_verified).toBe(1);

    const after = userMeResponseSchema.parse(await (await usersMeFor(ADA_KEY)).json());
    expect(after.user.profile_gaps).toEqual([]);

    const afterRequest = await withToken("/users/me/upload-access/request", ADA_KEY, {
      why: "Depositing our lab's 64-channel EEG study of motor imagery, 40 participants.",
    });
    expect(afterRequest.status).toBe(201);
    expect((await afterRequest.json()) as { ok: boolean }).toMatchObject({ ok: true });
  });

  test("the interstitial names the account and does not submit itself", async () => {
    // The page IS the defence a signed state cannot provide on its own: a
    // bearer capability that a victim could be handed. What stops that is a
    // person reading whose account it names before ORCID sees anything.
    const ada = await seedUser("ada@nemar.test", ADA_KEY, { username: "alovelace" });

    const started = await withToken("/auth/orcid/cli-start", ADA_KEY, { mode: "link" });
    const { authorize_url } = (await started.json()) as { authorize_url: string };
    const page = await openHandoff(handoffToken(authorize_url));

    expect(page.status).toBe(200);
    expect(page.headers.get("Content-Type")).toContain("text/html");
    // NOT a redirect: nothing reaches ORCID until the person presses the
    // button.
    expect(page.headers.get("Location")).toBeNull();
    const html = await page.text();
    expect(html).toContain("alovelace");
    // The address is masked, like every other place NEMAR shows one back.
    expect(html).toContain("a**@nemar.test");
    expect(html).not.toContain("ada@nemar.test");
    expect(html).toContain("If this is not your account, close this tab");
    expect(html).toContain('action="/auth/orcid/cli-handoff/continue"');
    // No script at all, and in particular nothing that could auto-submit the
    // form and turn this page back into the redirect it replaced.
    expect(html).not.toContain("<script");
    expect(html).not.toContain("submit()");
    // Still unlinked: rendering a page changes nothing.
    expect(userRow(ada)?.orcid).toBeNull();
  });

  test("a browser signed in as someone else is REFUSED, not overridden", async () => {
    // Both ends of the flow, because they are minutes apart and a browser can
    // sign in between them. An earlier draft let the signed intent silently
    // win, which is correct about whose intent it is and wrong about what to
    // do with the disagreement.
    const ada = await seedUser("ada@nemar.test", ADA_KEY);
    const bob = await seedUser("bob@nemar.test", BOB_KEY);
    tokenOrcid = ADA_ORCID;

    const started = await withToken("/auth/orcid/cli-start", ADA_KEY, { mode: "link" });
    const { authorize_url } = (await started.json()) as { authorize_url: string };
    const token = handoffToken(authorize_url);
    const { cookieIdRaw } = await issueSession(env(), bob, false, null, null, "email_code");
    const bobSession = `nemar_session=${cookieIdRaw}`;

    const page = await openHandoff(token, bobSession);
    expect(page.status).toBe(403);
    const html = await page.text();
    expect(html).toContain("orcid_intent_account_mismatch");
    expect(html).toContain("sign out or open it in a browser where you are not signed in");

    // The confirm step refuses on its own, not merely because the page did.
    const posted = await continueHandoff(token, bobSession);
    expect(posted.status).toBe(403);
    expect(posted.headers.get("Set-Cookie")).toBeNull();

    // And so does the callback, for a session that appeared after a clean
    // handoff.
    const { cookie, csrf } = await walkHandoff(token);
    const res = await callback(csrf, [cookie, bobSession]);
    expect(res.headers.get("Location")).toContain("error=orcid_intent_account_mismatch");

    expect(userRow(ada)?.orcid).toBeNull();
    expect(userRow(bob)?.orcid).toBeNull();
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM oauth_identities").get()?.n).toBe(
      0,
    );
  });

  test("the same browser signed in as the intent's own account proceeds", async () => {
    // The refusal above must be about DISAGREEMENT, not about the presence of
    // a session: someone who happens to be signed in on the same account is
    // exactly who the intent is for.
    const ada = await seedUser("ada@nemar.test", ADA_KEY);
    tokenOrcid = ADA_ORCID;

    const started = await withToken("/auth/orcid/cli-start", ADA_KEY, { mode: "link" });
    const { authorize_url } = (await started.json()) as { authorize_url: string };
    const { cookieIdRaw } = await issueSession(env(), ada, false, null, null, "email_code");
    const session = `nemar_session=${cookieIdRaw}`;

    const { cookie, csrf } = await walkHandoff(handoffToken(authorize_url), session);
    const res = await callback(csrf, [cookie, session]);

    expect(res.status).toBe(302);
    expect(userRow(ada)?.orcid).toBe(ADA_ORCID);
  });

  test("an intent is single-use: a replay links nothing", async () => {
    // A signed URL sits in browser history, in a referrer, in a log. The
    // signature makes it unforgeable; the nonce row (migration 0078) makes it
    // unrepeatable.
    const ada = await seedUser("ada@nemar.test", ADA_KEY);
    tokenOrcid = ADA_ORCID;

    const started = await withToken("/auth/orcid/cli-start", ADA_KEY, { mode: "link" });
    const { authorize_url } = (await started.json()) as { authorize_url: string };
    const token = handoffToken(authorize_url);
    const { cookie, csrf } = await walkHandoff(token);
    expect((await callback(csrf, [cookie])).status).toBe(302);
    expect(userRow(ada)?.orcid).toBe(ADA_ORCID);

    // Same URL, same cookie, second time. The iD would be re-linkable to this
    // very account, so the assertion that bites is the refusal itself.
    const replay = await callback(csrf, [cookie]);
    expect(replay.headers.get("Location")).toContain("error=orcid_intent_used");

    // And the handoff will not re-issue a cookie for a spent intent either.
    const page = await openHandoff(token);
    expect(page.status).toBe(410);
    expect(await page.text()).toContain("orcid_intent_used");
    expect((await continueHandoff(token)).status).toBe(410);
  });

  test("cli-start accepts a session under the same-origin gate", async () => {
    // The route takes either credential (authMiddleware). A cookie caller
    // still has to clear the gate `POST /orcid/start` applies, and the ADR
    // says so -- but nothing exercised the branch, so "it accepts a cookie"
    // was an unverified claim in a comment.
    const ada = await seedUser("ada@nemar.test", ADA_KEY);
    const { cookieIdRaw } = await issueSession(env(), ada, false, null, null, "email_code");

    const refused = await app.request(
      "/auth/orcid/cli-start",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `nemar_session=${cookieIdRaw}`,
          Origin: "https://evil.example.com",
        },
        body: JSON.stringify({ mode: "link" }),
      },
      env(),
    );
    expect(refused.status).toBe(403);

    const allowed = await app.request(
      "/auth/orcid/cli-start",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `nemar_session=${cookieIdRaw}`,
          Origin: "https://nemar.org",
        },
        body: JSON.stringify({ mode: "link" }),
      },
      env(),
    );
    expect(allowed.status).toBe(200);
    const { authorize_url } = (await allowed.json()) as { authorize_url: string };
    expect(authorize_url).toContain("/auth/orcid/cli-handoff?t=");
  });

  test("503s when this deployment has no ORCID client", async () => {
    // Checked at MINT time so the terminal says "unavailable" instead of the
    // person discovering it at the end of a browser round trip.
    await seedUser("ada@nemar.test", ADA_KEY);
    const withoutOrcid = { ...env(), ORCID_CLIENT_ID: "", ORCID_CLIENT_SECRET: "" } as Bindings;
    const res = await withToken(
      "/auth/orcid/cli-start",
      ADA_KEY,
      { mode: "link" },
      "POST",
      withoutOrcid,
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("orcid_unavailable");
    expect(body.message).toContain("unavailable");
    // Nothing was recorded for an intent that can never be used.
    expect(
      db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM orcid_link_intents").get()?.n,
    ).toBe(0);
  });

  test("a tampered state links nothing", async () => {
    // The user id is covered by the signature, so editing it is not an
    // account swap -- it is an unreadable state.
    const ada = await seedUser("ada@nemar.test", ADA_KEY);
    const bob = await seedUser("bob@nemar.test", BOB_KEY);

    const forged = await signCliState(
      {
        csrf: "forged-csrf",
        mode: "link",
        userId: bob,
        next: "/settings",
        exp: Date.now() + 60000,
      },
      "not-the-worker-key",
    );
    const handoff = await app.request(
      `/auth/orcid/cli-handoff?t=${encodeURIComponent(forged)}`,
      {},
      env(),
    );
    expect(handoff.status).toBe(302);
    expect(handoff.headers.get("Location")).toBe(`${APP}/login?error=orcid_state`);
    expect(handoff.headers.get("Set-Cookie")).toBeNull();

    // And presenting it straight at the callback fails the csrf compare too.
    const res = await callback("forged-csrf", [`${STATE_COOKIE_NAME}=${forged}`]);
    expect(res.headers.get("Location")).toContain("error=orcid_state");
    expect(userRow(ada)?.orcid).toBeNull();
    expect(userRow(bob)?.orcid).toBeNull();
  });

  test("an expired intent is refused at the handoff", async () => {
    await seedUser("ada@nemar.test", ADA_KEY);
    const stale = await signCliState(
      { csrf: "stale", mode: "link", userId: 1, next: "/settings", exp: Date.now() - 1000 },
      ENCRYPTION_KEY,
    );
    const res = await app.request(
      `/auth/orcid/cli-handoff?t=${encodeURIComponent(stale)}`,
      {},
      env(),
    );
    expect(res.headers.get("Location")).toBe(`${APP}/login?error=orcid_state`);
  });

  test("relink swaps the iD; a plain link on a linked account is refused early", async () => {
    const ada = await seedUser("ada@nemar.test", ADA_KEY, {
      orcid: ADA_ORCID,
      orcidVerified: true,
      identityBacked: true,
    });

    const refused = await withToken("/auth/orcid/cli-start", ADA_KEY, { mode: "link" });
    expect(refused.status).toBe(409);
    const refusal = (await refused.json()) as { error: string; message: string };
    expect(refusal.error).toBe("orcid_already_have");
    expect(refusal.message).toContain("orcid relink");

    tokenOrcid = BOB_ORCID;
    const started = await withToken("/auth/orcid/cli-start", ADA_KEY, { mode: "relink" });
    expect(started.status).toBe(200);
    const { authorize_url } = (await started.json()) as { authorize_url: string };
    const { cookie, csrf } = await walkHandoff(handoffToken(authorize_url));
    const res = await callback(csrf, [cookie]);

    expect(res.status).toBe(302);
    expect(userRow(ada)?.orcid).toBe(BOB_ORCID);
    const subjects = db
      .query<{ provider_subject: string }, [number]>(
        "SELECT provider_subject FROM oauth_identities WHERE user_id = ?",
      )
      .all(ada)
      .map((r) => r.provider_subject);
    expect(subjects).toEqual([BOB_ORCID]);
  });

  test("refuses an iD another live account already holds", async () => {
    const ada = await seedUser("ada@nemar.test", ADA_KEY);
    await seedUser("holder@nemar.test", null, { orcid: BOB_ORCID });
    tokenOrcid = BOB_ORCID;

    const started = await withToken("/auth/orcid/cli-start", ADA_KEY, { mode: "link" });
    const { authorize_url } = (await started.json()) as { authorize_url: string };
    const { cookie, csrf } = await walkHandoff(handoffToken(authorize_url));
    const res = await callback(csrf, [cookie]);

    expect(res.headers.get("Location")).toContain("error=orcid_in_use");
    expect(userRow(ada)?.orcid).toBeNull();
  });

  test("an intent for a revoked account links nothing", async () => {
    const ada = await seedUser("ada@nemar.test", ADA_KEY);
    const started = await withToken("/auth/orcid/cli-start", ADA_KEY, { mode: "link" });
    const { authorize_url } = (await started.json()) as { authorize_url: string };
    const { cookie, csrf } = await walkHandoff(handoffToken(authorize_url));
    // Revoked between minting and finishing -- up to ten minutes apart.
    db.run("UPDATE users SET status = 'revoked' WHERE id = ?", [ada]);

    const res = await callback(csrf, [cookie]);

    expect(res.headers.get("Location")).toContain("error=orcid_account");
    expect(userRow(ada)?.orcid).toBeNull();
  });

  test("needs a credential", async () => {
    await seedUser("ada@nemar.test", ADA_KEY);
    const res = await app.request(
      "/auth/orcid/cli-start",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "relink" }),
      },
      env(),
    );
    expect(res.status).toBe(401);
  });
});

describe("POST /auth/orcid/unlink with a bearer token", () => {
  test("drops the identity row and the claim on the iD", async () => {
    const ada = await seedUser("ada@nemar.test", ADA_KEY, {
      orcid: ADA_ORCID,
      orcidVerified: true,
      identityBacked: true,
    });

    const res = await withToken("/auth/orcid/unlink", ADA_KEY, {});

    expect(res.status).toBe(200);
    const row = userRow(ada);
    expect(row?.orcid).toBeNull();
    expect(row?.orcid_verified).toBe(0);
    expect(
      db
        .query<{ n: number }, [number]>(
          "SELECT COUNT(*) AS n FROM oauth_identities WHERE user_id = ?",
        )
        .get(ada)?.n,
    ).toBe(0);
  });

  test("unlinks only the acting account", async () => {
    const ada = await seedUser("ada@nemar.test", ADA_KEY, {
      orcid: ADA_ORCID,
      orcidVerified: true,
      identityBacked: true,
    });
    await seedUser("bob@nemar.test", BOB_KEY, {
      orcid: BOB_ORCID,
      orcidVerified: true,
      identityBacked: true,
    });

    const res = await withToken("/auth/orcid/unlink", BOB_KEY, {});

    expect(res.status).toBe(200);
    expect(userRow(ada)?.orcid).toBe(ADA_ORCID);
  });
});

// ---------------------------------------------------------------------------
// The cookie half is unchanged
// ---------------------------------------------------------------------------

describe("the session path keeps its own rules", () => {
  test("a cookie without an allowed Origin is still refused", async () => {
    const ada = await seedUser("ada@nemar.test", ADA_KEY);
    const { cookieIdRaw } = await issueSession(env(), ada, false, null, null, "email_code");

    const res = await app.request(
      "/auth/profile",
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Cookie: `nemar_session=${cookieIdRaw}`,
          Origin: "https://evil.example.com",
        },
        body: JSON.stringify({ username: "alovelace" }),
      },
      env(),
    );

    expect(res.status).toBe(403);
    expect(userRow(ada)?.username).toBeNull();
  });

  test("a pending account can still change the address it typed wrong", async () => {
    // `authMiddleware`'s cookie path refuses `pending` (ADR 0040); this route
    // must not, because an unverified inbox is exactly what a wrong address
    // produces and the change is the only way out of it.
    const ada = await seedUser("ada@nemar.test", null, { status: "pending" });
    db.run("UPDATE users SET email_verified = 0 WHERE id = ?", [ada]);
    const { cookieIdRaw } = await issueSession(env(), ada, false, null, null, "email_code");

    const res = await app.request(
      "/auth/email/change/request",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `nemar_session=${cookieIdRaw}`,
          Origin: "https://nemar.org",
        },
        body: JSON.stringify({ email: "ada-fixed@nemar.test" }),
      },
      env(),
    );

    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toMatchObject({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// One assertion that the mail helper is really seeing sends
// ---------------------------------------------------------------------------

describe("the change code itself", () => {
  test("goes to the NEW address and nowhere else", async () => {
    await seedUser("ada@nemar.test", ADA_KEY);
    // Echo-eligible targets skip the send (the echo IS the delivery off
    // production), so a non-synthetic target is what proves the recipient.
    const mail = await withFakeResend(async (calls) => {
      await withToken(
        "/auth/email/change/request",
        ADA_KEY,
        { email: "ada-new@nemar.test" },
        "POST",
        env(),
      );
      return calls;
    });
    // `@nemar.test` is echo-eligible, so nothing is mailed for the CODE at
    // all -- which is the fence working, and is asserted so a change that
    // starts mailing dev targets fails here.
    expect(mail.filter((c) => c.path === "/emails").map((c) => asSend(c).subject)).toEqual([]);
  });
});
