/**
 * The narrower endings of ADR 0119 rule 12: a path that ends only SOME of an account's grants, and
 * tells only the clients whose grants it ended (epic #2014 phase #2019).
 *
 *   - an ORCID unlink or relink, and a change of the account's kind away from `person`, end the
 *     grants of the clients that sign people in by `person_proven_orcid` (the proof they were granted
 *     on is gone), through their real routes;
 *   - a compute suspension ends only the grants that carry a `compute.` scope. Its state does not
 *     exist yet (the compute access phase adds the caller), so the filter is tested DIRECTLY here, as
 *     the issue says: the real statements the real function returns, run against the real tables,
 *     with the grants, tokens and clients made through the real routes.
 *
 * Also the shape of `oidcEndStatements` itself: four statements in the order that matters (the
 * delivery is queued from the live grants BEFORE they are revoked), each ending in a predicate a
 * caller can extend, which is what `tombstoneUserCascade`'s guarded call does.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { OIDC_COMPUTE_SCOPE_PREFIX } from "../../shared/oidc";
import { oidcEndStatements } from "../src/services/oidc-cascade";
import { encodeState } from "../src/services/orcid-auth";
import {
  type Held,
  authorizeAnswer,
  clientRowId,
  countsOf,
  deliveries,
  giveKey,
  registerLogoutClient,
  revokedReasons,
  seedProvenAccount,
  signInAt,
  stillWorks,
  usernameOf,
} from "./helpers/oidc-cascade";
import {
  type RegisteredClient,
  registerClient,
  rotateKeys,
  sessionCookie,
} from "./helpers/oidc-flow";
import { OWNER_KEY, type OidcHarness, startOidcHarness } from "./helpers/oidc-harness";

const APP = "https://app.nemar.org";
const NEW_ID = "0000-0001-5109-353X";
const CSRF = "csrf-oidc-cascade-test-value";
const COMPUTE_SCOPES = [
  "openid",
  "profile",
  "offline_access",
  "compute.read",
  "compute.reserve",
] as const;

let h: OidcHarness;
let orcidServer: Server;

beforeAll(() => {
  // The one external boundary of the relink: ORCID's token endpoint, as `orcid-relink-route.test.ts`
  // stands it in. It exchanges any code for NEW_ID.
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

beforeEach(async () => {
  h = await startOidcHarness({ HOST_PREFIXED_SESSION_COOKIE: "1" });
  await rotateKeys(h);
});

/** Two clients that tell the partner on a loss of proof, and one that does not care about it. */
interface Clients {
  proven: RegisteredClient;
  provenSecond: RegisteredClient;
  open: RegisteredClient;
  openNoLogout: RegisteredClient;
}

async function clients(): Promise<Clients> {
  return {
    proven: await registerLogoutClient(h, { sign_in_rule: "person_proven_orcid" }),
    provenSecond: await registerClient(h, { sign_in_rule: "person_proven_orcid" }),
    open: await registerLogoutClient(h, { sign_in_rule: "active_account" }),
    openNoLogout: await registerClient(h, { sign_in_rule: "active_account" }),
  };
}

interface Account {
  userId: number;
  held: { proven: Held; provenSecond: Held; open: Held; openNoLogout: Held };
}

async function account(c: Clients): Promise<Account> {
  const userId = seedProvenAccount(h);
  return {
    userId,
    held: {
      proven: await signInAt(h, userId, c.proven),
      provenSecond: await signInAt(h, userId, c.provenSecond),
      open: await signInAt(h, userId, c.open),
      openNoLogout: await signInAt(h, userId, c.openNoLogout),
    },
  };
}

describe("the clients that sign in by a proven ORCID iD lose the grant when the proof goes", () => {
  type Mutation = {
    name: string;
    reason: string;
    run(a: Account): Promise<void>;
  };

  const KEY = "nm_oidc-cascade-unlink-key-0123456789abcdef0123456";

  const MUTATIONS: Mutation[] = [
    {
      name: "POST /auth/orcid/unlink",
      reason: "orcid_changed",
      async run(a) {
        await giveKey(h, a.userId, KEY);
        const res = await h.call("POST", "/auth/orcid/unlink", { key: KEY });
        expect(res.status).toBe(200);
      },
    },
    {
      name: "the ORCID callback's relink",
      reason: "orcid_changed",
      async run(a) {
        const cookies = [
          `__Host-nemar_oauth_state=${encodeState({ csrf: CSRF, mode: "relink", next: "/settings" })}`,
          await sessionCookie(h, a.userId),
        ];
        const res = await h.call("GET", `/auth/orcid/callback?state=${CSRF}&code=fake-code`, {
          base: APP,
          headers: { Cookie: cookies.join("; ") },
          env: {
            ORCID_CLIENT_ID: "APP-TEST",
            ORCID_CLIENT_SECRET: "test-secret",
            ORCID_API_BASE: `http://localhost:${orcidServer.port}`,
            ENCRYPTION_KEY: "route-test-encryption-key-0123456789",
          },
        });
        expect(res.status).toBe(302);
        expect(res.headers.get("Location")).toBe(`${APP}/settings`);
        // The swap itself happened: the proof now names another iD.
        const identity = h.db
          .query<{ provider_subject: string }, [number]>(
            "SELECT provider_subject FROM oauth_identities WHERE user_id = ? AND provider = 'orcid'",
          )
          .get(a.userId);
        expect(identity?.provider_subject).toBe(NEW_ID);
      },
    },
    {
      name: "POST /admin/users/:username/kind, person to service",
      reason: "kind_changed",
      async run(a) {
        // An iD the person proved by signing in is `orcid_verified`, and the route refuses to lend
        // such an account a persona; clearing the flag leaves the proof (the identity row) intact,
        // which is what the rule reads.
        h.db.query("UPDATE users SET orcid_verified = 0 WHERE id = ?").run(a.userId);
        const res = await h.call("POST", `/admin/users/${usernameOf(h, a.userId)}/kind`, {
          key: OWNER_KEY,
          body: { kind: "service" },
        });
        expect(res.status).toBe(200);
      },
    },
  ];

  describe.each(MUTATIONS)("$name", (m) => {
    test("ends the grants, tokens and unspent codes of the person_proven_orcid clients and no others", async () => {
      const c = await clients();
      const a = await account(c);

      await m.run(a);

      // Counted before anything is asked of the endpoints: a refresh rotates, and a redemption
      // spends the code, so asking changes what there is to count.
      expect(countsOf(h, a.userId)).toEqual({
        grantsLive: 2,
        grantsRevoked: 2,
        tokensLive: 4,
        tokensRevoked: 4,
        codesUnused: 2,
      });

      expect(await stillWorks(h, a.held.proven)).toBe(false);
      expect(await stillWorks(h, a.held.provenSecond)).toBe(false);
      // The clients that ask only for an active account do not depend on the proof, and keep it.
      expect(await stillWorks(h, a.held.open)).toBe(true);
      expect(await stillWorks(h, a.held.openNoLogout)).toBe(true);
    });

    test("tells the person_proven_orcid clients that have an address, and only those", async () => {
      const c = await clients();
      const a = await account(c);

      await m.run(a);

      const queued = deliveries(h, a.userId);
      expect(queued.map((d) => d.client_id)).toEqual([clientRowId(h, c.proven)]);
      expect(queued[0]?.reason).toBe(m.reason);
      expect(revokedReasons(h, a.userId)).toContain(m.reason);
    });
  });

  test("a change TO person ends nothing", async () => {
    const c = await clients();
    const a = await account(c);
    h.db
      .query("UPDATE users SET account_kind = 'test', orcid_verified = 0 WHERE id = ?")
      .run(a.userId);
    const res = await h.call("POST", `/admin/users/${usernameOf(h, a.userId)}/kind`, {
      key: OWNER_KEY,
      body: { kind: "person" },
    });
    expect(res.status).toBe(200);
    expect(countsOf(h, a.userId).grantsRevoked).toBe(0);
    expect(deliveries(h, a.userId)).toEqual([]);
  });

  test("a kind change that the route refuses ends nothing", async () => {
    const c = await clients();
    const a = await account(c);
    // The iD is `orcid_verified` (as a proven one is), so a persona may not be lent to the account.
    const res = await h.call("POST", `/admin/users/${usernameOf(h, a.userId)}/kind`, {
      key: OWNER_KEY,
      body: { kind: "service" },
    });
    expect(res.status).toBe(409);
    expect(countsOf(h, a.userId).grantsRevoked).toBe(0);
    expect(deliveries(h, a.userId)).toEqual([]);
  });
});

describe("a change of kind away from person is no way to cut an account off", () => {
  // The help of `nemar admin oidc end-account` and ADR 0119 rule 12 say so, and a merge loser is ended by
  // a revocation or a deletion and not by this: a non-person account still satisfies `active_account`.
  test("it keeps its grants at the active_account clients, and signs in at one again at once", async () => {
    const c = await clients();
    const a = await account(c);
    h.db.query("UPDATE users SET orcid_verified = 0 WHERE id = ?").run(a.userId);
    const res = await h.call("POST", `/admin/users/${usernameOf(h, a.userId)}/kind`, {
      key: OWNER_KEY,
      body: { kind: "service" },
    });
    expect(res.status).toBe(200);

    // What it loses is what its proof gave: the grants at the person_proven_orcid clients.
    expect(await stillWorks(h, a.held.proven)).toBe(false);
    expect(await stillWorks(h, a.held.provenSecond)).toBe(false);
    // Everything at the active_account clients is untouched, tokens included...
    expect(await stillWorks(h, a.held.open)).toBe(true);
    expect(await stillWorks(h, a.held.openNoLogout)).toBe(true);
    // ...the real authorization check still gives it a grant there, and a new sign-in works...
    expect((await authorizeAnswer(h, a.userId, c.open)).kind).toBe("redirect");
    expect(await stillWorks(h, await signInAt(h, a.userId, c.open))).toBe(true);
    // ...and refuses it only at the clients whose rule it no longer meets.
    expect(await authorizeAnswer(h, a.userId, c.proven)).toMatchObject({
      kind: "rule_refused",
      reason: "account_not_person",
    });
  });
});

describe("a compute suspension ends only the grants that carry a compute scope", () => {
  async function suspend(userId: number): Promise<void> {
    const statements = oidcEndStatements(userId, "compute_suspended", {
      scopePrefix: OIDC_COMPUTE_SCOPE_PREFIX,
    });
    await h.env.DB.batch(statements.map((s) => h.env.DB.prepare(s.sql).bind(...s.binds)));
  }

  test("notifies and ends the compute clients, and leaves the others signed in", async () => {
    const compute = await registerLogoutClient(h, { allowed_scopes: [...COMPUTE_SCOPES] });
    const computeQuiet = await registerClient(h, { allowed_scopes: [...COMPUTE_SCOPES] });
    const other = await registerLogoutClient(h);
    const userId = seedProvenAccount(h);
    const held = {
      compute: await signInAt(h, userId, compute, { scope: COMPUTE_SCOPES.join(" ") }),
      computeQuiet: await signInAt(h, userId, computeQuiet, { scope: COMPUTE_SCOPES.join(" ") }),
      other: await signInAt(h, userId, other),
    };

    await suspend(userId);

    expect(await stillWorks(h, held.compute)).toBe(false);
    expect(await stillWorks(h, held.computeQuiet)).toBe(false);
    expect(await stillWorks(h, held.other)).toBe(true);
    // Only the compute client that has an address is told; the one that is not a compute client at
    // all is not, though it has an address, and the quiet one has none.
    expect(deliveries(h, userId).map((d) => [d.client_id, d.reason])).toEqual([
      [clientRowId(h, compute), "compute_suspended"],
    ]);
    expect(revokedReasons(h, userId)).toEqual(["compute_suspended"]);
  });

  test("a grant counts by its scopes, not by its client's allowance or its tokens' scopes", async () => {
    // The client MAY be asked for compute, but this person granted it only identity: not a compute
    // grant, so a suspension leaves it alone and tells nobody.
    const compute = await registerLogoutClient(h, { allowed_scopes: [...COMPUTE_SCOPES] });
    const userId = seedProvenAccount(h);
    const held = await signInAt(h, userId, compute, { scope: "openid profile offline_access" });

    await suspend(userId);

    expect(await stillWorks(h, held)).toBe(true);
    expect(deliveries(h, userId)).toEqual([]);
  });

  test("a grant that ACCUMULATED a compute scope is a compute grant, whatever a token carries", async () => {
    // Grants accumulate (ADR 0119 rule 13: tokens carry the code's scopes, never the grant's), so a
    // later identity-only sign-in holds tokens with no compute scope under a grant that has one.
    const compute = await registerLogoutClient(h, { allowed_scopes: [...COMPUTE_SCOPES] });
    const userId = seedProvenAccount(h);
    await signInAt(h, userId, compute, { scope: COMPUTE_SCOPES.join(" ") });
    const later = await signInAt(h, userId, compute, { scope: "openid profile offline_access" });

    await suspend(userId);

    expect(await stillWorks(h, later)).toBe(false);
    expect(countsOf(h, userId).tokensLive).toBe(0);
  });

  test("a prefix is matched as a prefix, not as a pattern", async () => {
    // The match is `substr`, so the dot is not a wildcard and neither is `%` or `_`: only the exact
    // beginning of a scope counts.
    const userId = seedProvenAccount(h);
    const compute = await registerLogoutClient(h, { allowed_scopes: [...COMPUTE_SCOPES] });
    await signInAt(h, userId, compute, { scope: "openid compute.read" });
    const end = (prefix: string) =>
      h.env.DB.batch(
        oidcEndStatements(userId, "compute_suspended", { scopePrefix: prefix }).map((s) =>
          h.env.DB.prepare(s.sql).bind(...s.binds),
        ),
      );
    for (const wrong of [
      "computer.",
      "compute..",
      "Compute.",
      "ompute.",
      "compute.read.x",
      "%",
      "_",
    ]) {
      await end(wrong);
      expect(countsOf(h, userId).grantsLive).toBe(1);
    }
    await end("compute.");
    expect(countsOf(h, userId).grantsLive).toBe(0);
  });
});

describe("oidcEndStatements", () => {
  test("returns the delivery, the tokens, the grants and the codes, in that order", () => {
    const statements = oidcEndStatements(7, "account_revoked");
    expect(statements.map((s) => s.sql.trim().split(/\s+/).slice(0, 3).join(" "))).toEqual([
      "INSERT INTO oidc_logout_deliveries",
      "UPDATE oidc_tokens SET",
      "UPDATE oidc_grants SET",
      "DELETE FROM oidc_codes",
    ]);
    for (const s of statements) {
      expect((s.sql.match(/\?/g) ?? []).length).toBe(s.binds.length);
    }
    // The reason is bound, never spliced: it is the one value a caller chooses.
    expect(statements.every((s) => !s.sql.includes("account_revoked"))).toBe(true);
    expect(statements[0]?.binds).toContain("account_revoked");
    expect(statements[1]?.binds).toContain("account_revoked");
  });

  test("a refused reason or filter throws before any statement is built", () => {
    expect(() => oidcEndStatements(7, "bogus" as never)).toThrow();
    expect(() => oidcEndStatements(0, "account_revoked")).toThrow();
    expect(() => oidcEndStatements(7, "account_revoked", { scopePrefix: "" })).toThrow();
    expect(() => oidcEndStatements(7, "account_revoked", { rule: "bogus" as never })).toThrow();
    expect(() =>
      oidcEndStatements(7, "account_revoked", {
        rule: "person_proven_orcid",
        scopePrefix: "compute.",
      } as never),
    ).toThrow();
  });

  test("every statement still reads as a statement with a predicate appended, as a guard does", async () => {
    // `tombstoneUserCascade` runs each statement with ` AND EXISTS (...)` appended and its own binds
    // after the statement's. Appending a predicate that is never true must therefore change nothing,
    // for the unfiltered form and for both filters: a statement that could not take one would break
    // the guarded sweep.
    const userId = seedProvenAccount(h);
    const c = await registerLogoutClient(h, { allowed_scopes: [...COMPUTE_SCOPES] });
    await signInAt(h, userId, c, { scope: COMPUTE_SCOPES.join(" ") });
    const before = countsOf(h, userId);
    for (const filter of [
      undefined,
      { rule: "active_account" as const },
      { scopePrefix: "compute." },
    ]) {
      for (const s of oidcEndStatements(userId, "account_revoked", filter)) {
        const result = await h.env.DB.prepare(`${s.sql} AND ? = 0`)
          .bind(...s.binds, 1)
          .run();
        expect(result.meta?.changes ?? 0).toBe(0);
      }
    }
    expect(countsOf(h, userId)).toEqual(before);
    expect(deliveries(h, userId)).toEqual([]);
  });

  test("the unfiltered statements end every grant of the account whatever its client", async () => {
    const a = await registerLogoutClient(h);
    const b = await registerClient(h, { sign_in_rule: "person_proven_orcid" });
    const userId = seedProvenAccount(h);
    await signInAt(h, userId, a);
    await signInAt(h, userId, b);
    const statements = oidcEndStatements(userId, "account_merged");
    const results = await h.env.DB.batch(
      statements.map((s) => h.env.DB.prepare(s.sql).bind(...s.binds)),
    );
    // The counts a caller reports, by the position the order promises: delivery, tokens, grants, codes.
    expect(results.map((r) => r.meta?.changes)).toEqual([1, 4, 2, 2]);
  });
});
