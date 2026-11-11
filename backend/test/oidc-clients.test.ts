/**
 * The OpenID Connect client registry (epic #2014 phase #2016; ADR 0119, decision 8), driven
 * through the owner routes of the real Worker over a real SQLite database that carries every
 * migration: what registration refuses, what the secret is and where it is shown, what rotation
 * keeps valid and for how long, what disabling does, and what the audit trail holds.
 *
 * Each refusal is one request and one expected word, so a rule that stops being enforced fails by
 * name. The rules that exist to keep a partner from skipping consent have a case for each way
 * around them: a partner host, a partner's subdomain, a host NEMAR does not run, a lookalike of a
 * NEMAR host, and a client with one good address and one bad one.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import {
  oidcClientCreateResponseSchema,
  oidcClientDisableResponseSchema,
  oidcClientListResponseSchema,
  oidcClientRotateResponseSchema,
  oidcClientShowResponseSchema,
} from "../../shared/contract/oidc-admin";
import { OIDC_SECRET_GRACE_HOURS_DEFAULT, isOidcClientId } from "../../shared/oidc";
import { getClientAuthRow, verifyClientSecret } from "../src/services/oidc-clients";
import { OWNER_KEY, type OidcHarness, clientBody, startOidcHarness } from "./helpers/oidc-harness";

let h: OidcHarness;

beforeEach(async () => {
  h = await startOidcHarness();
});

const create = (over: Record<string, unknown> = {}, hh: OidcHarness = h) =>
  hh.call("POST", "/admin/oidc/clients", { key: OWNER_KEY, body: clientBody(over) });

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

interface Created {
  clientId: string;
  secret: string;
}

async function register(over: Record<string, unknown> = {}, hh: OidcHarness = h): Promise<Created> {
  const res = await create(over, hh);
  expect(res.status, res.text).toBe(201);
  const body = res.json as { client: { client_id: string }; client_secret: string };
  return { clientId: body.client.client_id, secret: body.client_secret };
}

const clientRow = (id: string) =>
  h.db
    .query<Record<string, unknown>, [string]>("SELECT * FROM oidc_clients WHERE client_id = ?")
    .get(id);
const clientCount = () =>
  (h.db.query("SELECT COUNT(*) AS n FROM oidc_clients").get() as { n: number }).n;

// ---------------------------------------------------------------------------------------------

describe("registering a client", () => {
  test("answers 201 with the client and its secret, in the shape the contract names", async () => {
    const res = await create({
      name: "Compute portal",
      redirect_uris: ["https://client.example.org/callback", "https://client.example.org/other"],
      allowed_scopes: ["openid", "profile", "email", "orcid", "offline_access"],
      allowed_grants: ["authorization_code", "refresh_token"],
      sign_in_rule: "person_proven_orcid",
      consent_mode: "always",
      backchannel_logout_uri: "https://client.example.org/logout",
      audience: "https://api.example.org",
      introspection_audiences: ["https://rs.example.org"],
      cap_open_reservations: 4,
      cap_su_per_day: 1000,
    });
    expect(res.status, res.text).toBe(201);
    const body = oidcClientCreateResponseSchema.parse(res.json);
    expect(isOidcClientId(body.client.client_id)).toBe(true);
    expect(body.client).toMatchObject({
      name: "Compute portal",
      redirect_uris: ["https://client.example.org/callback", "https://client.example.org/other"],
      allowed_scopes: ["openid", "profile", "email", "orcid", "offline_access"],
      allowed_grants: ["authorization_code", "refresh_token"],
      sign_in_rule: "person_proven_orcid",
      first_party: false,
      consent_mode: "always",
      backchannel_logout_uri: "https://client.example.org/logout",
      audience: "https://api.example.org",
      introspection_audiences: ["https://rs.example.org"],
      cap_open_reservations: 4,
      cap_su_per_day: 1000,
      status: "active",
      disabled_at: null,
      previous_secret_expires_at: null,
      created_by: h.ids.owner,
    });
    expect(typeof body.client.created_at).toBe("string");
  });

  test("the defaults: consent once, not first-party, no logout address, no caps, no introspection", async () => {
    const { clientId } = await register();
    const row = clientRow(clientId);
    expect(row).toMatchObject({
      consent_mode: "ask_once",
      first_party: 0,
      backchannel_logout_uri: null,
      cap_open_reservations: null,
      cap_su_per_day: null,
      introspection_audiences: "[]",
      status: "active",
    });
  });

  test("the secret is 256 random bits, is shown here, and the database holds only its hash", async () => {
    const { clientId, secret } = await register();
    // The prefix a secret scanner looks for, then 32 bytes as unpadded base64url (43 characters).
    expect(secret).toMatch(/^nmo_cs_[A-Za-z0-9_-]{43}$/);
    const row = clientRow(clientId) as Record<string, unknown>;
    expect(row.secret_hash).toBe(await sha256Hex(secret));
    expect(row.previous_secret_hash).toBeNull();
    // The secret is in no column of the row, in any form.
    for (const value of Object.values(row)) expect(String(value)).not.toContain(secret);
  });

  test("the name is stored without the spaces around it", async () => {
    const res = await create({ name: "  Padded name  " });
    expect(res.status, res.text).toBe(201);
    expect((res.json?.client as { name: string }).name).toBe("Padded name");
  });

  test("two clients never share a secret or an id", async () => {
    const a = await register();
    const b = await register();
    expect(a.secret).not.toBe(b.secret);
    expect(a.clientId).not.toBe(b.clientId);
  });

  test("every answer of the owner routes is for no shared cache", async () => {
    const created = await create();
    expect(created.headers.get("Cache-Control")).toBe("no-store");
    const id = (created.json?.client as { client_id: string }).client_id;
    for (const [method, path] of [
      ["GET", "/admin/oidc/clients"],
      ["GET", `/admin/oidc/clients/${id}`],
      ["POST", `/admin/oidc/clients/${id}/rotate-secret`],
      ["POST", `/admin/oidc/clients/${id}/disable`],
      ["GET", "/admin/oidc/keys"],
    ] as const) {
      const res = await h.call(method, path, { key: OWNER_KEY });
      expect(res.headers.get("Cache-Control"), `${method} ${path}`).toBe("no-store");
    }
  });

  test("the secret and its hash are in no later response", async () => {
    const { clientId, secret } = await register();
    const hash = await sha256Hex(secret);
    for (const res of [
      await h.call("GET", "/admin/oidc/clients", { key: OWNER_KEY }),
      await h.call("GET", `/admin/oidc/clients/${clientId}`, { key: OWNER_KEY }),
    ]) {
      expect(res.status).toBe(200);
      expect(res.text).not.toContain(secret);
      expect(res.text).not.toContain(hash);
      expect(res.text).not.toContain("secret_hash");
      expect(res.text).not.toContain("client_secret");
    }
  });

  test("the audit row holds the shape of the registration and none of its content", async () => {
    const { clientId, secret } = await register({
      name: "A very identifiable name",
      redirect_uris: ["https://identifiable.example.org/callback"],
      audience: "https://identifiable-audience.example.org",
    });
    const rows = h.db
      .query(
        "SELECT user_id, action, resource_type, resource_id, details FROM audit_log WHERE action = 'oidc.client.create'",
      )
      .all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: h.ids.owner,
      resource_type: "oidc_client",
      resource_id: clientId,
    });
    const text = JSON.stringify(rows);
    for (const secretish of [
      secret,
      await sha256Hex(secret),
      "identifiable",
      "https://",
      "A very identifiable name",
    ]) {
      expect(text).not.toContain(secretish);
    }
    expect(JSON.parse(rows[0]?.details as string)).toMatchObject({
      first_party: false,
      sign_in_rule: "active_account",
      redirects: 1,
    });
  });

  test("a refused registration writes no row and no audit row", async () => {
    const res = await create({ redirect_uris: ["http://example.org/cb"] });
    expect(res.status).toBe(400);
    expect(clientCount()).toBe(0);
    expect(
      (
        h.db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'oidc.%'").get() as {
          n: number;
        }
      ).n,
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------

/** Every way a registration is refused, one request each, with the word the owner is given. */
const REFUSALS: Array<[string, Record<string, unknown>, string]> = [
  // Redirect addresses
  ["a wildcard host", { redirect_uris: ["https://*.example.org/cb"] }, "invalid_redirect_uri"],
  ["a wildcard path", { redirect_uris: ["https://example.org/*"] }, "invalid_redirect_uri"],
  ["a fragment", { redirect_uris: ["https://example.org/cb#frag"] }, "invalid_redirect_uri"],
  ["an empty fragment", { redirect_uris: ["https://example.org/cb#"] }, "invalid_redirect_uri"],
  ["plain http", { redirect_uris: ["http://example.org/cb"] }, "invalid_redirect_uri"],
  [
    "user information with a password",
    { redirect_uris: ["https://user:pw@example.org/cb"] },
    "invalid_redirect_uri",
  ],
  [
    "user information that names another host after it",
    { redirect_uris: ["https://example.org@evil.example/cb"] },
    "invalid_redirect_uri",
  ],
  ["a relative address", { redirect_uris: ["/callback"] }, "invalid_redirect_uri"],
  ["no scheme", { redirect_uris: ["example.org/cb"] }, "invalid_redirect_uri"],
  ["a script address", { redirect_uris: ["javascript:alert(1)"] }, "invalid_redirect_uri"],
  ["ftp", { redirect_uris: ["ftp://example.org/cb"] }, "invalid_redirect_uri"],
  [
    "a backslash",
    { redirect_uris: ["https://example.org\\@evil.example/cb"] },
    "invalid_redirect_uri",
  ],
  ["whitespace", { redirect_uris: ["https://example.org/a b"] }, "invalid_redirect_uri"],
  [
    "a control character",
    { redirect_uris: ["https://example.org/a\u0001b"] },
    "invalid_redirect_uri",
  ],
  [
    "an address over 2000 characters",
    { redirect_uris: [`https://example.org/${"a".repeat(2000)}`] },
    "invalid_body",
  ],
  [
    "the same address twice",
    { redirect_uris: ["https://example.org/cb", "https://example.org/cb"] },
    "duplicate_redirect_uri",
  ],
  ["no redirect address", { redirect_uris: [] }, "invalid_body"],
  [
    "eleven redirect addresses",
    { redirect_uris: Array.from({ length: 11 }, (_, i) => `https://example.org/${i}`) },
    "invalid_body",
  ],
  // Scopes and grants
  ["a scope outside the catalogue", { allowed_scopes: ["openid", "admin"] }, "invalid_scope"],
  ["a scope in the wrong case", { allowed_scopes: ["OpenID"] }, "invalid_scope"],
  ["a scope listed twice", { allowed_scopes: ["openid", "openid"] }, "invalid_scope"],
  ["no scope", { allowed_scopes: [] }, "invalid_body"],
  [
    "compute.stats without the client credentials grant",
    { allowed_scopes: ["compute.stats"], allowed_grants: ["authorization_code"] },
    "scope_grant_mismatch",
  ],
  ["the implicit grant", { allowed_grants: ["implicit"] }, "invalid_grant"],
  ["the password grant", { allowed_grants: ["authorization_code", "password"] }, "invalid_grant"],
  [
    "a grant listed twice",
    { allowed_grants: ["authorization_code", "authorization_code"] },
    "invalid_grant",
  ],
  ["no grant", { allowed_grants: [] }, "invalid_body"],
  // Words
  ["an unknown sign-in rule", { sign_in_rule: "anyone" }, "invalid_body"],
  ["no sign-in rule", { sign_in_rule: undefined }, "invalid_body"],
  ["an unknown consent mode", { consent_mode: "never" }, "invalid_body"],
  // Back-channel logout
  [
    "an http logout address",
    { backchannel_logout_uri: "http://client.example.org/logout" },
    "invalid_logout_uri",
  ],
  [
    "a logout address with a fragment",
    { backchannel_logout_uri: "https://client.example.org/logout#x" },
    "invalid_logout_uri",
  ],
  [
    "a logout address with user information",
    { backchannel_logout_uri: "https://u:p@client.example.org/logout" },
    "invalid_logout_uri",
  ],
  [
    "a logout address with a wildcard",
    { backchannel_logout_uri: "https://*.example.org/logout" },
    "invalid_logout_uri",
  ],
  // Name, audience, caps
  ["an empty name", { name: "" }, "invalid_body"],
  ["a name of spaces", { name: "   " }, "invalid_name"],
  ["a name over 100 characters", { name: "n".repeat(101) }, "invalid_body"],
  ["a control character in the name", { name: "a\u0000b" }, "invalid_name"],
  ["no audience", { audience: undefined }, "invalid_body"],
  ["an audience with a space", { audience: "two words" }, "invalid_audience"],
  [
    "an introspection audience with a space",
    { introspection_audiences: ["two words"] },
    "invalid_audience",
  ],
  [
    "eleven introspection audiences",
    { introspection_audiences: Array.from({ length: 11 }, (_, i) => `aud-${i}`) },
    "invalid_body",
  ],
  ["a negative cap", { cap_open_reservations: -1 }, "invalid_body"],
  ["a fractional cap", { cap_su_per_day: 1.5 }, "invalid_body"],
  ["a text cap", { cap_su_per_day: "lots" }, "invalid_body"],
  // Fields that are not the owner's to set at registration
  ["a client secret of the owner's choosing", { client_secret: "mine" }, "invalid_body"],
  ["a status", { status: "disabled" }, "invalid_body"],
  ["a client id", { client_id: "oc_000000000000000000000000" }, "invalid_body"],
  ["a misspelled field", { first_partee: true }, "invalid_body"],
];

describe("registration refuses", () => {
  test.each(REFUSALS)("%s", async (_name, over, code) => {
    const res = await create(over);
    expect(res.status, res.text).toBe(400);
    expect(res.json?.code).toBe(code);
    expect(typeof res.json?.error).toBe("string");
    expect(clientCount()).toBe(0);
  });

  test("a body that is not an object, not JSON, or missing", async () => {
    for (const rawBody of ["[]", "null", '"text"', "not json", "{"]) {
      const res = await h.call("POST", "/admin/oidc/clients", { key: OWNER_KEY, rawBody });
      expect(res.status, rawBody).toBe(400);
      expect(res.json?.code, rawBody).toBe("invalid_body");
    }
    const none = await h.call("POST", "/admin/oidc/clients", { key: OWNER_KEY });
    expect(none.status).toBe(400);
    expect(none.json?.code).toBe("invalid_body");
    expect(clientCount()).toBe(0);
  });

  test("a refusal names the field and never echoes the value", async () => {
    const res = await create({ client_secret: "VALUE-THAT-MUST-NOT-COME-BACK" });
    expect(res.text).not.toContain("VALUE-THAT-MUST-NOT-COME-BACK");
    expect(res.text).toContain("client_secret");
    const bad = await create({ name: `${"n".repeat(101)}` });
    expect(bad.text).not.toContain("n".repeat(101));
  });

  test("what the owner types is accepted at the edges: 10 addresses, 100 characters, a zero cap", async () => {
    const res = await create({
      name: "n".repeat(100),
      redirect_uris: Array.from({ length: 10 }, (_, i) => `https://example.org/${i}`),
      cap_open_reservations: 0,
      cap_su_per_day: null,
      audience: "a".repeat(200),
    });
    expect(res.status, res.text).toBe(201);
  });
});

describe("loopback addresses", () => {
  test("outside production a loopback http address is accepted, and an http address elsewhere is not", async () => {
    for (const uri of [
      "http://localhost:3000/cb",
      "http://127.0.0.1:8080/cb",
      "http://[::1]:8080/cb",
    ]) {
      const res = await create({ redirect_uris: [uri] });
      expect(res.status, `${uri}: ${res.text}`).toBe(201);
    }
    const res = await create({ redirect_uris: ["http://example.org/cb"] });
    expect(res.status).toBe(400);
  });

  test("in production no http address is accepted, a loopback one included", async () => {
    const prod = await startOidcHarness({ ENVIRONMENT: "production" });
    for (const uri of [
      "http://localhost:3000/cb",
      "http://127.0.0.1:8080/cb",
      "http://[::1]:8080/cb",
    ]) {
      const res = await create({ redirect_uris: [uri] }, prod);
      expect(res.status, uri).toBe(400);
      expect(res.json?.code).toBe("invalid_redirect_uri");
    }
    expect((await create({}, prod)).status).toBe(201);
  });

  test("a loopback host that merely looks like one is not one", async () => {
    for (const uri of ["http://localhost.evil.example/cb", "http://127.0.0.1.evil.example/cb"]) {
      const res = await create({ redirect_uris: [uri] });
      expect(res.status, uri).toBe(400);
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe("first-party: only when every redirect address is on a NEMAR web origin", () => {
  test.each([
    ["a partner host", ["https://compute.nemar.org/callback"]],
    ["a partner host's subdomain", ["https://jupyter.compute.nemar.org/callback"]],
    ["a host that is neither a partner nor NEMAR's", ["https://client.example.org/callback"]],
    ["a lookalike with NEMAR's name as a prefix", ["https://nemar.org.evil.example/callback"]],
    ["a lookalike with NEMAR's name as a suffix", ["https://evilnemar.org/callback"]],
    ["a lookalike Pages project", ["https://evil-nemar-website.pages.dev/callback"]],
    [
      "one NEMAR address and one that is not",
      ["https://app.nemar.org/callback", "https://client.example.org/callback"],
    ],
    [
      "one NEMAR address and one on a partner host",
      ["https://app.nemar.org/callback", "https://compute.nemar.org/callback"],
    ],
  ])("is refused for %s", async (_name, redirect_uris) => {
    const res = await create({ first_party: true, redirect_uris });
    expect(res.status, res.text).toBe(400);
    expect(res.json?.code).toBe("first_party_not_allowed");
    expect(clientCount()).toBe(0);
  });

  test.each([
    ["the app host", ["https://app.nemar.org/oauth/callback"]],
    ["two NEMAR hosts", ["https://nemar.org/callback", "https://test.nemar.org/callback"]],
    // `isNemarWebOrigin` is the rule, so a website preview (a Pages project NEMAR deploys) counts.
    ["a website preview", ["https://branch.nemar-website.pages.dev/callback"]],
  ])("is accepted for %s", async (_name, redirect_uris) => {
    const res = await create({ first_party: true, redirect_uris });
    expect(res.status, res.text).toBe(201);
    expect((res.json?.client as { first_party: boolean }).first_party).toBe(true);
  });

  test("a client on a partner host is accepted as third-party, and says so", async () => {
    const res = await create({
      first_party: false,
      redirect_uris: ["https://compute.nemar.org/callback"],
    });
    expect(res.status, res.text).toBe(201);
    expect((res.json?.client as { first_party: boolean }).first_party).toBe(false);
    // Left out, it is the same.
    const omitted = await create({ redirect_uris: ["https://compute.nemar.org/callback"] });
    expect(omitted.status).toBe(201);
    expect((omitted.json?.client as { first_party: boolean }).first_party).toBe(false);
  });

  test("the answer for a first-party refusal says why, in words an owner can act on", async () => {
    const res = await create({
      first_party: true,
      redirect_uris: ["https://compute.nemar.org/cb"],
    });
    expect(String(res.json?.error)).toMatch(/first-party/i);
    expect(String(res.json?.error)).toMatch(/partner/i);
    expect(String(res.json?.error)).toMatch(/third-party client/);
    const other = await create({
      first_party: true,
      redirect_uris: ["https://client.example.org/cb"],
    });
    expect(String(other.json?.error)).toMatch(/nemar\.org/);
    expect(String(other.json?.error)).toMatch(/third-party client/);
    // It says what to do, and does not claim the client will always be asked: a third-party client
    // follows its consent mode and never skips the screen.
    expect(String(other.json?.error)).not.toMatch(/always/i);
    expect(String(other.json?.error)).toMatch(/consent_mode/);
  });
});

// ---------------------------------------------------------------------------------------------

describe("compute.stats is a machine scope", () => {
  test("accepted with the client credentials grant", async () => {
    const res = await create({
      allowed_scopes: ["compute.stats"],
      allowed_grants: ["client_credentials"],
    });
    expect(res.status, res.text).toBe(201);
  });

  test("accepted beside a person's scopes when the client credentials grant is allowed too", async () => {
    const res = await create({
      allowed_scopes: ["openid", "compute.stats"],
      allowed_grants: ["authorization_code", "client_credentials"],
    });
    expect(res.status, res.text).toBe(201);
  });
});

// ---------------------------------------------------------------------------------------------

describe("rotating a secret", () => {
  const rotate = (id: string, body?: unknown) =>
    h.call("POST", `/admin/oidc/clients/${id}/rotate-secret`, { key: OWNER_KEY, body });

  /** The previous secret's validity, in milliseconds from now, read from the row. */
  const previousExpiresInMs = (id: string): number | null => {
    const row = clientRow(id) as { previous_secret_expires_at: string | null };
    return row.previous_secret_expires_at === null
      ? null
      : Date.parse(`${row.previous_secret_expires_at.replace(" ", "T")}Z`) - Date.now();
  };

  async function verdict(id: string, secret: string, at: Date = new Date()) {
    const row = getClientAuthRow(h.env.DB, id);
    return verifyClientSecret((await row) as NonNullable<Awaited<typeof row>>, secret, at);
  }

  test("the default grace is 24 hours: the old secret works until then, the new one at once", async () => {
    const { clientId, secret: oldSecret } = await register();
    const res = await rotate(clientId);
    expect(res.status, res.text).toBe(200);
    const body = oidcClientRotateResponseSchema.parse(res.json);
    expect(body.grace_hours).toBe(OIDC_SECRET_GRACE_HOURS_DEFAULT);
    expect(body.client_secret).not.toBe(oldSecret);
    expect(body.client_secret).toMatch(/^nmo_cs_[A-Za-z0-9_-]{43}$/);

    const row = clientRow(clientId) as Record<string, unknown>;
    expect(row.secret_hash).toBe(await sha256Hex(body.client_secret));
    expect(row.previous_secret_hash).toBe(await sha256Hex(oldSecret));
    const ms = previousExpiresInMs(clientId) as number;
    expect(ms).toBeGreaterThan(23.9 * 3_600_000);
    expect(ms).toBeLessThan(24.1 * 3_600_000);

    const now = new Date();
    expect(await verdict(clientId, body.client_secret, now)).toBe("current");
    expect(await verdict(clientId, oldSecret, now)).toBe("previous");
    expect(await verdict(clientId, "not-the-secret", now)).toBeNull();
    // The grace ends: after 24 hours and a minute the old secret is dead, the new one is not.
    const later = new Date(now.getTime() + 24 * 3_600_000 + 60_000);
    expect(await verdict(clientId, oldSecret, later)).toBeNull();
    expect(await verdict(clientId, body.client_secret, later)).toBe("current");
    // And just before it ends it still works.
    const before = new Date(now.getTime() + 23 * 3_600_000);
    expect(await verdict(clientId, oldSecret, before)).toBe("previous");
  });

  test("graceHours sets the window, to the hour", async () => {
    const { clientId, secret: oldSecret } = await register();
    const res = await rotate(clientId, { graceHours: 2 });
    expect(res.status, res.text).toBe(200);
    expect(res.json?.grace_hours).toBe(2);
    const now = new Date();
    expect(await verdict(clientId, oldSecret, new Date(now.getTime() + 119 * 60_000))).toBe(
      "previous",
    );
    expect(await verdict(clientId, oldSecret, new Date(now.getTime() + 121 * 60_000))).toBeNull();
  });

  test("graceHours of 0 ends the old secret at once and records no previous secret", async () => {
    const { clientId, secret: oldSecret } = await register();
    const res = await rotate(clientId, { graceHours: 0 });
    expect(res.status, res.text).toBe(200);
    const row = clientRow(clientId) as Record<string, unknown>;
    expect(row.previous_secret_hash).toBeNull();
    expect(row.previous_secret_expires_at).toBeNull();
    expect(await verdict(clientId, oldSecret)).toBeNull();
    expect(await verdict(clientId, (res.json as { client_secret: string }).client_secret)).toBe(
      "current",
    );
  });

  test("the longest grace is a week", async () => {
    const { clientId } = await register();
    expect((await rotate(clientId, { graceHours: 168 })).status).toBe(200);
    expect((await rotate(clientId, { graceHours: 169 })).status).toBe(400);
  });

  test.each([[-1], [1.5], ["2"], [null], [169], [Number.NaN]])(
    "graceHours %j is refused and changes nothing",
    async (graceHours) => {
      const { clientId } = await register();
      const before = JSON.stringify(clientRow(clientId));
      const res = await rotate(clientId, { graceHours });
      expect(res.status, res.text).toBe(400);
      expect(res.json?.code).toBe("invalid_body");
      expect(JSON.stringify(clientRow(clientId))).toBe(before);
    },
  );

  test("an unknown field is refused", async () => {
    const { clientId } = await register();
    const res = await rotate(clientId, { grace_hours: 2 });
    expect(res.status).toBe(400);
    expect(res.json?.code).toBe("invalid_body");
  });

  test("a second rotation inside the grace ends the first secret and keeps the one before it", async () => {
    const { clientId, secret: s0 } = await register();
    const s1 = ((await rotate(clientId)).json as { client_secret: string }).client_secret;
    const s2 = ((await rotate(clientId)).json as { client_secret: string }).client_secret;
    expect(await verdict(clientId, s2)).toBe("current");
    expect(await verdict(clientId, s1)).toBe("previous");
    expect(await verdict(clientId, s0)).toBeNull();
  });

  test("the response and every later one hold the new secret once and no hash", async () => {
    const { clientId, secret: oldSecret } = await register();
    const res = await rotate(clientId);
    const fresh = (res.json as { client_secret: string }).client_secret;
    expect(res.text).not.toContain(oldSecret);
    expect(res.text).not.toContain(await sha256Hex(fresh));
    expect(res.text).not.toContain(await sha256Hex(oldSecret));
    const shown = await h.call("GET", `/admin/oidc/clients/${clientId}`, { key: OWNER_KEY });
    expect(shown.text).not.toContain(fresh);
    expect(shown.text).not.toContain(oldSecret);
    const view = oidcClientShowResponseSchema.parse(shown.json);
    expect(typeof view.client.previous_secret_expires_at).toBe("string");
  });

  test("an ended grace is no longer shown as one", async () => {
    const { clientId } = await register();
    await rotate(clientId, { graceHours: 1 });
    h.db.run(
      "UPDATE oidc_clients SET previous_secret_expires_at = datetime('now', '-1 minutes') WHERE client_id = ?",
      [clientId],
    );
    const shown = await h.call("GET", `/admin/oidc/clients/${clientId}`, { key: OWNER_KEY });
    expect(
      (shown.json?.client as { previous_secret_expires_at: unknown }).previous_secret_expires_at,
    ).toBeNull();
  });

  test("the audit row names the grace and holds no secret or hash", async () => {
    const { clientId, secret } = await register();
    const fresh = ((await rotate(clientId, { graceHours: 3 })).json as { client_secret: string })
      .client_secret;
    const rows = h.db
      .query(
        "SELECT user_id, resource_id, details FROM audit_log WHERE action = 'oidc.client.rotate_secret'",
      )
      .all() as Array<{ user_id: number; resource_id: string; details: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: h.ids.owner, resource_id: clientId });
    expect(JSON.parse(rows[0]?.details as string)).toEqual({ grace_hours: 3 });
    const text = JSON.stringify(rows);
    for (const x of [secret, fresh, await sha256Hex(secret), await sha256Hex(fresh)]) {
      expect(text).not.toContain(x);
    }
  });

  test("a client that does not exist, or is not an id, is refused", async () => {
    const missing = await rotate("oc_000000000000000000000000");
    expect(missing.status).toBe(404);
    expect(missing.json?.code).toBe("client_not_found");
    const bad = await rotate("not-a-client-id");
    expect(bad.status).toBe(400);
    expect(bad.json?.code).toBe("invalid_client_id");
  });

  test("a disabled client's secret cannot be rotated", async () => {
    const { clientId } = await register();
    await h.call("POST", `/admin/oidc/clients/${clientId}/disable`, { key: OWNER_KEY });
    const before = JSON.stringify(clientRow(clientId));
    const res = await rotate(clientId);
    expect(res.status).toBe(409);
    expect(res.json?.code).toBe("client_disabled");
    expect(JSON.stringify(clientRow(clientId))).toBe(before);
  });
});

// ---------------------------------------------------------------------------------------------

describe("disabling a client", () => {
  const disable = (id: string) =>
    h.call("POST", `/admin/oidc/clients/${id}/disable`, { key: OWNER_KEY });

  test("sets the status and the time, changes nothing else, and no secret works afterwards", async () => {
    const { clientId, secret } = await register();
    const fresh = (
      (await h.call("POST", `/admin/oidc/clients/${clientId}/rotate-secret`, { key: OWNER_KEY }))
        .json as { client_secret: string }
    ).client_secret;
    const before = clientRow(clientId) as Record<string, unknown>;
    const res = await disable(clientId);
    expect(res.status, res.text).toBe(200);
    const body = oidcClientDisableResponseSchema.parse(res.json);
    expect(body.changed).toBe(true);
    expect(body.client.status).toBe("disabled");
    expect(typeof body.client.disabled_at).toBe("string");
    const after = clientRow(clientId) as Record<string, unknown>;
    expect(after.status).toBe("disabled");
    for (const col of [
      "client_id",
      "name",
      "secret_hash",
      "redirect_uris",
      "allowed_scopes",
      "allowed_grants",
      "first_party",
    ]) {
      expect(after[col], col).toBe(before[col]);
    }
    // Neither the current secret nor the previous one authenticates a disabled client.
    expect(
      await verifyClientSecret((await getClientAuthRow(h.env.DB, clientId)) as never, fresh),
    ).toBeNull();
    expect(
      await verifyClientSecret((await getClientAuthRow(h.env.DB, clientId)) as never, secret),
    ).toBeNull();
  });

  test("disabling twice is the same answer, with changed false, and one audit row", async () => {
    const { clientId } = await register();
    expect((await disable(clientId)).json?.changed).toBe(true);
    const again = await disable(clientId);
    expect(again.status).toBe(200);
    expect(again.json?.changed).toBe(false);
    expect(
      (
        h.db
          .query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'oidc.client.disable'")
          .get() as { n: number }
      ).n,
    ).toBe(1);
  });

  test("an unknown client is 404 and an id that is not one is 400", async () => {
    expect((await disable("oc_000000000000000000000000")).status).toBe(404);
    expect((await disable("nope")).status).toBe(400);
  });

  test("a disabled client is still listed and shown, as disabled", async () => {
    const { clientId } = await register();
    await disable(clientId);
    const list = oidcClientListResponseSchema.parse(
      (await h.call("GET", "/admin/oidc/clients", { key: OWNER_KEY })).json,
    );
    expect(list.clients.map((c) => [c.client_id, c.status])).toEqual([[clientId, "disabled"]]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("listing and showing", () => {
  test("every client, oldest first, and one by id", async () => {
    const a = await register({ name: "First" });
    const b = await register({ name: "Second" });
    const list = oidcClientListResponseSchema.parse(
      (await h.call("GET", "/admin/oidc/clients", { key: OWNER_KEY })).json,
    );
    expect(list.clients.map((c) => c.client_id)).toEqual([a.clientId, b.clientId]);
    const shown = oidcClientShowResponseSchema.parse(
      (await h.call("GET", `/admin/oidc/clients/${b.clientId}`, { key: OWNER_KEY })).json,
    );
    expect(shown.client.name).toBe("Second");
  });

  test("an empty registry is an empty list", async () => {
    const res = await h.call("GET", "/admin/oidc/clients", { key: OWNER_KEY });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ clients: [] });
  });

  test("a missing client is 404 with a word, and a malformed id is 400 and reaches no query", async () => {
    const missing = await h.call("GET", "/admin/oidc/clients/oc_000000000000000000000000", {
      key: OWNER_KEY,
    });
    expect(missing.status).toBe(404);
    expect(missing.json?.code).toBe("client_not_found");
    for (const id of [
      "x",
      "oc_short",
      "OC_000000000000000000000000",
      "oc_0000000000000000000000000",
    ]) {
      const bad = await h.call("GET", `/admin/oidc/clients/${id}`, { key: OWNER_KEY });
      expect(bad.status, id).toBe(400);
      expect(bad.json?.code).toBe("invalid_client_id");
    }
  });
});

describe("verifying a secret with no database in the way", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    status: "active",
    secret_hash: "a".repeat(64),
    previous_secret_hash: null as string | null,
    previous_secret_expires_at: null as string | null,
    ...over,
  });

  test("an unexpired previous hash is accepted, an expired or unparseable one is not", async () => {
    const hash = await sha256Hex("old");
    const future = "2099-01-01 00:00:00";
    const past = "2000-01-01 00:00:00";
    const base = { previous_secret_hash: hash };
    expect(
      await verifyClientSecret(row({ ...base, previous_secret_expires_at: future }), "old"),
    ).toBe("previous");
    expect(
      await verifyClientSecret(row({ ...base, previous_secret_expires_at: past }), "old"),
    ).toBeNull();
    expect(
      await verifyClientSecret(row({ ...base, previous_secret_expires_at: "garbage" }), "old"),
    ).toBeNull();
    expect(
      await verifyClientSecret(row({ ...base, previous_secret_expires_at: null }), "old"),
    ).toBeNull();
  });

  test("a hash that is the right length but wrong never matches, and an empty secret matches nothing", async () => {
    expect(await verifyClientSecret(row(), "")).toBeNull();
    expect(await verifyClientSecret(row({ secret_hash: await sha256Hex("s") }), "s")).toBe(
      "current",
    );
    expect(await verifyClientSecret(row({ secret_hash: await sha256Hex("s") }), "S")).toBeNull();
    expect(
      await verifyClientSecret(row({ status: "disabled", secret_hash: await sha256Hex("s") }), "s"),
    ).toBeNull();
  });
});
