/**
 * The registry's rules that the review of phase #2016 tightened (epic #2014; ADR 0119 rules 1, 7 and
 * 8), driven through the owner route of the real Worker over a real database, with the first-party
 * predicate also asked directly because the authorization phase asks it again at every request.
 *
 *   - FIRST-PARTY is a rule of its own, not the cross-origin one: https, `nemar.org` or a subdomain,
 *     never a partner host, the default port; and a loopback address or a website preview only
 *     outside production. Every host class is asked in both environments.
 *   - ADDRESSES are stored as a browser would navigate to them (`new URL(raw).href === raw`), so a
 *     registered redirect can never be one thing to the registry and another to a browser.
 *   - SCOPES and GRANTS are consistent: a person's scope needs the authorization code grant, a
 *     refresh token needs it too, and `offline_access` and `refresh_token` come together.
 *   - NAMES are unique among active clients, and a back-channel logout address in production is a
 *     named host, never a loopback or an IP literal.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { isFirstPartyRedirect } from "../src/services/oidc-clients";
import type { Bindings } from "../src/types/bindings";
import { OWNER_KEY, type OidcHarness, clientBody, startOidcHarness } from "./helpers/oidc-harness";

let h: OidcHarness;
beforeEach(async () => {
  h = await startOidcHarness();
});

const create = (over: Record<string, unknown> = {}, hh: OidcHarness = h) =>
  hh.call("POST", "/admin/oidc/clients", { key: OWNER_KEY, body: clientBody(over) });

const PRODUCTION = { ENVIRONMENT: "production" } as Pick<Bindings, "ENVIRONMENT">;
const NON_PRODUCTION = [
  { ENVIRONMENT: "test" },
  { ENVIRONMENT: "development" },
  { ENVIRONMENT: "staging" },
] as Array<Pick<Bindings, "ENVIRONMENT">>;

// ---------------------------------------------------------------------------------------------

describe("the first-party predicate, in production and outside it", () => {
  /** `[address, first-party in production, first-party outside production]`. */
  const TABLE: Array<[string, boolean, boolean]> = [
    // NEMAR's own origins
    ["https://nemar.org/cb", true, true],
    ["https://app.nemar.org/oauth/callback", true, true],
    ["https://deep.sub.nemar.org/cb", true, true],
    ["https://test.nemar.org/cb", true, true],
    // never http, never another port, never user information
    ["http://app.nemar.org/cb", false, false],
    ["https://app.nemar.org:8443/cb", false, false],
    ["https://user@app.nemar.org/cb", false, false],
    ["https://user:secret@app.nemar.org/cb", false, false],
    // a partner host, and its subdomains
    ["https://compute.nemar.org/cb", false, false],
    ["https://jupyter.compute.nemar.org/cb", false, false],
    // lookalikes
    ["https://nemar.org.evil.example/cb", false, false],
    ["https://evilnemar.org/cb", false, false],
    ["https://app.nemar.org.evil.example/cb", false, false],
    ["https://app.nemar.org./cb", false, false],
    ["https://client.example.org/cb", false, false],
    ["https://nemar.com/cb", false, false],
    // loopback: a developer's machine, outside production only
    ["http://localhost:3000/cb", false, true],
    ["http://127.0.0.1:8080/cb", false, true],
    ["http://[::1]:8080/cb", false, true],
    ["https://localhost/cb", false, true],
    ["https://127.0.0.1:9443/cb", false, true],
    ["https://[::1]/cb", false, true],
    // a fully qualified name is the same host: the trailing dot changes nothing
    ["http://localhost.:3000/cb", false, true],
    ["https://localhost./cb", false, true],
    ["http://localhost..:3000/cb", false, false],
    ["http://localhost.evil.example/cb", false, false],
    ["http://127.0.0.1.evil.example/cb", false, false],
    // website previews: a Pages project NEMAR deploys, outside production only
    ["https://branch.nemar-website.pages.dev/cb", false, true],
    ["https://nemar-website.pages.dev/cb", false, true],
    ["https://abc123.nemar-website-test.pages.dev/cb", false, true],
    ["http://branch.nemar-website.pages.dev/cb", false, false],
    ["https://branch.nemar-website.pages.dev:8443/cb", false, false],
    ["https://evil-nemar-website.pages.dev/cb", false, false],
    ["https://nemar-website.pages.dev.evil.example/cb", false, false],
    // not addresses
    ["not a url", false, false],
    ["", false, false],
  ];

  test.each(TABLE)("%s: production %j", (address, inProduction) => {
    expect(isFirstPartyRedirect(address, PRODUCTION)).toBe(inProduction);
  });

  test.each(TABLE)("%s: outside production %j", (address, _inProduction, outside) => {
    for (const env of NON_PRODUCTION) {
      expect(isFirstPartyRedirect(address, env), env.ENVIRONMENT).toBe(outside);
    }
  });

  test("an unset or unknown environment is production: it fails closed", () => {
    for (const environment of [undefined, "", "prod", "Production"]) {
      const env = { ENVIRONMENT: environment } as unknown as Pick<Bindings, "ENVIRONMENT">;
      expect(isFirstPartyRedirect("http://localhost:3000/cb", env)).toBe(false);
      expect(isFirstPartyRedirect("https://branch.nemar-website.pages.dev/cb", env)).toBe(false);
      expect(isFirstPartyRedirect("https://app.nemar.org/cb", env)).toBe(true);
    }
  });
});

describe("registering a first-party client asks the predicate for every address", () => {
  test("in production a loopback or a preview address makes the client third-party only", async () => {
    const prod = await startOidcHarness({ ENVIRONMENT: "production" });
    for (const uri of ["https://localhost/cb", "https://branch.nemar-website.pages.dev/cb"]) {
      const res = await create({ first_party: true, redirect_uris: [uri] }, prod);
      expect(res.status, uri).toBe(400);
      expect(res.json?.code).toBe("first_party_not_allowed");
    }
    // The same two addresses, registered without first_party, are fine: it is third-party.
    for (const uri of ["https://localhost/cb", "https://branch.nemar-website.pages.dev/cb"]) {
      expect((await create({ redirect_uris: [uri] }, prod)).status, uri).toBe(201);
    }
    expect(
      (await create({ first_party: true, redirect_uris: ["https://app.nemar.org/cb"] }, prod))
        .status,
    ).toBe(201);
  });

  test("outside production the same two are first-party", async () => {
    for (const uri of ["https://localhost/cb", "https://branch.nemar-website.pages.dev/cb"]) {
      const res = await create({ first_party: true, redirect_uris: [uri] });
      expect(res.status, uri).toBe(201);
    }
  });

  test("a port other than the default is refused for a NEMAR host", async () => {
    const res = await create({
      first_party: true,
      redirect_uris: ["https://app.nemar.org:8443/cb"],
    });
    expect(res.status).toBe(400);
    expect(res.json?.code).toBe("first_party_not_allowed");
  });
});

// ---------------------------------------------------------------------------------------------

describe("addresses are stored as a browser navigates to them", () => {
  const BAD: Array<[string, string]> = [
    ["a scheme with no slashes", "https:app.nemar.org/cb"],
    ["an upper-case scheme", "HTTPS://app.nemar.org/cb"],
    ["an upper-case host", "https://APP.nemar.org/cb"],
    ["a dot segment spelled %2E", "https://app.nemar.org/%2E/cb"],
    ["a dot segment", "https://app.nemar.org/a/../cb"],
    ["a single-dot segment", "https://app.nemar.org/./cb"],
    ["the default port spelled out", "https://app.nemar.org:443/cb"],
    ["no path at all", "https://app.nemar.org"],
    ["an ideographic full stop in the host", "https://app。nemar。org/cb"],
    ["a look-alike letter in the host (Cyrillic a)", "https://аpp.nemar.org/cb"],
    ["a zero-width space in the path", "https://app.nemar.org/cb​"],
    ["a zero-width joiner in the host", "https://app.nemar‍.org/cb"],
    ["a soft hyphen in the host", "https://app.ne­mar.org/cb"],
    ["a right-to-left override in the path", "https://app.nemar.org/cb‮"],
    ["a space spelled as is", "https://app.nemar.org/a b"],
    ["an unescaped non-ASCII letter in the path", "https://app.nemar.org/café"],
  ];

  test.each(BAD)("a redirect address with %s is refused", async (_name, uri) => {
    const res = await create({ redirect_uris: [uri] });
    expect(res.status, uri).toBe(400);
    expect(res.json?.code).toBe("invalid_redirect_uri");
    // Not echoed: the sentence names the field and the rule, never what was typed.
    expect(res.text).not.toContain(uri);
  });

  test.each(BAD.filter(([, uri]) => uri !== "https://app.nemar.org/a b"))(
    "a logout address with %s is refused",
    async (_name, uri) => {
      const res = await create({ backchannel_logout_uri: uri });
      expect(res.status, uri).toBe(400);
      expect(res.json?.code).toBe("invalid_logout_uri");
    },
  );

  test("a canonical address passes, whatever it carries that is allowed", async () => {
    for (const uri of [
      "https://app.nemar.org/cb",
      "https://app.nemar.org/",
      "https://app.nemar.org/cb?x=1&y=2",
      "https://app.nemar.org/a%20b",
      "https://app.nemar.org/caf%C3%A9",
      "https://client.example.org:8443/cb",
      "http://localhost:3000/cb",
      "http://[::1]:8080/cb",
      "https://xn--caf-dma.example.org/cb",
    ]) {
      const res = await create({ redirect_uris: [uri] });
      expect(res.status, `${uri}: ${res.text}`).toBe(201);
    }
    expect(
      (await create({ backchannel_logout_uri: "https://client.example.org/logout" })).status,
    ).toBe(201);
  });

  test("an address whose query already names a parameter the response adds is refused", async () => {
    // The authorization response appends `code`, `state`, `iss` or `error` to the registered
    // address; a registered query naming one would give the client two values for it.
    for (const name of ["code", "state", "iss", "error"]) {
      for (const query of [`${name}=a`, `x=1&${name}=`, `x=1&${name}`]) {
        const uri = `https://client.example.org/callback?${query}`;
        const res = await create({ redirect_uris: ["https://client.example.org/ok", uri] });
        expect({ uri, status: res.status, code: res.json?.code, field: res.json?.field }).toEqual({
          uri,
          status: 400,
          code: "invalid_redirect_uri",
          field: "redirect_uris",
        });
      }
    }
    // A name that merely contains one is fine.
    expect(
      (await create({ redirect_uris: ["https://client.example.org/cb?stateful=1"] })).status,
    ).toBe(201);
  });

  test("the stored address is exactly what was sent", async () => {
    const uri = "https://client.example.org/callback?tenant=a";
    const res = await create({ redirect_uris: [uri] });
    const id = (res.json?.client as { client_id: string }).client_id;
    const row = h.db
      .query<{ redirect_uris: string }, [string]>(
        "SELECT redirect_uris FROM oidc_clients WHERE client_id = ?",
      )
      .get(id);
    expect(JSON.parse(row?.redirect_uris as string)).toEqual([uri]);
  });
});

// ---------------------------------------------------------------------------------------------

describe("scopes and grants are consistent", () => {
  const REFUSED: Array<[string, string[], string[], string]> = [
    // A refresh token grant with offline_access but no authorization code grant: the grant list is
    // what is wrong, and the answer says so (and not that a scope needs a grant).
    [
      "offline_access and refresh_token with only client credentials",
      ["openid", "offline_access"],
      ["client_credentials", "refresh_token"],
      "allowed_grants",
    ],
    [
      "a person's scope with only the client credentials grant",
      ["openid"],
      ["client_credentials"],
      "allowed_scopes",
    ],
    [
      "compute.read with only the client credentials grant",
      ["compute.read"],
      ["client_credentials"],
      "allowed_scopes",
    ],
    [
      "a machine scope beside a person's, with only client credentials",
      ["compute.stats", "profile"],
      ["client_credentials"],
      "allowed_scopes",
    ],
    [
      "a refresh token grant with no authorization code grant",
      ["compute.stats"],
      ["client_credentials", "refresh_token"],
      "allowed_grants",
    ],
    [
      "offline_access without the refresh_token grant",
      ["openid", "offline_access"],
      ["authorization_code"],
      "allowed_scopes",
    ],
    [
      "the refresh_token grant without offline_access",
      ["openid"],
      ["authorization_code", "refresh_token"],
      "allowed_grants",
    ],
  ];

  test.each(REFUSED)("%s is refused, naming the field", async (_name, scopes, grants, field) => {
    const res = await create({ allowed_scopes: scopes, allowed_grants: grants });
    expect(res.status, res.text).toBe(400);
    expect(res.json?.code).toBe("invalid_body");
    expect(res.json?.field).toBe(field);
    // The sentence names the thing that is wrong, which is the field.
    expect(String(res.json?.error)).toContain(
      field === "allowed_grants" ? "allowed_grants has" : "allowed_scopes",
    );
    expect(h.db.query("SELECT COUNT(*) AS n FROM oidc_clients").get()).toEqual({ n: 0 });
  });

  test("a refresh token grant with no authorization code grant says it needs that grant", async () => {
    const res = await create({
      allowed_scopes: ["compute.stats"],
      allowed_grants: ["client_credentials", "refresh_token"],
    });
    expect(String(res.json?.error)).toContain("needs the authorization_code grant");
  });

  const ACCEPTED: Array<[string, string[], string[]]> = [
    ["a person's client with the code grant", ["openid", "profile"], ["authorization_code"]],
    [
      "a person's client that asks for refresh tokens",
      ["openid", "offline_access"],
      ["authorization_code", "refresh_token"],
    ],
    ["a machine-only client", ["compute.stats"], ["client_credentials"]],
    [
      "a client that is both",
      ["openid", "compute.stats"],
      ["authorization_code", "client_credentials"],
    ],
    [
      "a client that is both, with refresh tokens",
      ["openid", "offline_access", "compute.stats"],
      ["authorization_code", "refresh_token", "client_credentials"],
    ],
  ];

  test.each(ACCEPTED)("%s is accepted", async (_name, scopes, grants) => {
    const res = await create({ allowed_scopes: scopes, allowed_grants: grants });
    expect(res.status, res.text).toBe(201);
  });
});

// ---------------------------------------------------------------------------------------------

describe("names are unique among active clients", () => {
  test("a second active client with the same name, in any case, is 409 client_name_taken", async () => {
    expect((await create({ name: "Compute portal" })).status).toBe(201);
    for (const name of ["Compute portal", "compute PORTAL", "  Compute portal  "]) {
      const res = await create({ name });
      expect(res.status, name).toBe(409);
      expect(res.json?.code).toBe("client_name_taken");
      expect(String(res.json?.error)).toMatch(/clients list/);
    }
    expect(h.db.query("SELECT COUNT(*) AS n FROM oidc_clients").get()).toEqual({ n: 1 });
  });

  test("a disabled client frees its name", async () => {
    const first = await create({ name: "Reused name" });
    const id = (first.json?.client as { client_id: string }).client_id;
    await h.call("POST", `/admin/oidc/clients/${id}/disable`, { key: OWNER_KEY });
    expect((await create({ name: "Reused name" })).status).toBe(201);
  });

  test("two registrations that overlap: the database's index refuses the second, as the same answer", async () => {
    // The pre-check finds the name free; a competing registration lands before the insert.
    const real = h.env.DB;
    let injected = false;
    const racing = {
      ...real,
      prepare(sql: string) {
        const stmt = real.prepare(sql) as unknown as {
          first(): Promise<unknown>;
          bind(...p: unknown[]): unknown;
        };
        if (!sql.includes("FROM oidc_clients WHERE name")) return stmt;
        const wrapper = {
          bind: (...p: unknown[]) => {
            stmt.bind(...p);
            return wrapper;
          },
          first: async () => {
            const result = await stmt.first();
            if (!injected) {
              injected = true;
              expect((await create({ name: "Raced name" })).status).toBe(201);
            }
            return result;
          },
        };
        return wrapper;
      },
    } as unknown as D1Database;
    const res = await h.call("POST", "/admin/oidc/clients", {
      key: OWNER_KEY,
      body: clientBody({ name: "Raced name" }),
      env: { DB: racing },
    });
    expect(injected).toBe(true);
    expect(res.status, res.text).toBe(409);
    expect(res.json?.code).toBe("client_name_taken");
    expect(h.db.query("SELECT COUNT(*) AS n FROM oidc_clients").get()).toEqual({ n: 1 });
  });
});

// ---------------------------------------------------------------------------------------------

describe("a back-channel logout address in production is a named host", () => {
  const HOSTS = [
    "https://localhost/logout",
    "https://127.0.0.1/logout",
    "https://127.0.0.1:8443/logout",
    "https://10.1.2.3/logout",
    "https://[::1]/logout",
    "https://[2001:db8::1]/logout",
    "https://192.168.0.1/logout",
    "https://app.localhost/logout",
    // The same hosts as fully qualified names: `URL` keeps the dot, and the registry must not.
    "https://localhost./logout",
    "https://app.localhost./logout",
  ];

  test.each(HOSTS)("%s is refused in production", async (uri) => {
    const prod = await startOidcHarness({ ENVIRONMENT: "production" });
    const res = await create({ backchannel_logout_uri: uri }, prod);
    expect(res.status, uri).toBe(400);
    expect(res.json?.code).toBe("invalid_logout_uri");
  });

  test.each(HOSTS)("%s is accepted outside production, which a developer needs", async (uri) => {
    const res = await create({ backchannel_logout_uri: uri });
    expect(res.status, `${uri}: ${res.text}`).toBe(201);
  });

  test("a named host is accepted in production, and an http address is refused with its own message", async () => {
    const prod = await startOidcHarness({ ENVIRONMENT: "production" });
    expect(
      (await create({ backchannel_logout_uri: "https://client.example.org/logout" }, prod)).status,
    ).toBe(201);
    const http = await create({ backchannel_logout_uri: "http://client.example.org/logout" }, prod);
    expect(http.status).toBe(400);
    expect(http.json?.code).toBe("invalid_logout_uri");
    expect(String(http.json?.error)).toMatch(/must be an https address/);
  });
});

// ---------------------------------------------------------------------------------------------

describe("the host tests fold a trailing dot, so registration and the sender agree", () => {
  test("a loopback or literal host is one with or without its dot", async () => {
    const { isLocalOrLiteral, isLoopbackHost } = await import("../src/services/oidc-clients");
    for (const host of ["localhost", "localhost.", "127.0.0.1", "127.0.0.1.", "[::1]"]) {
      expect(isLoopbackHost(host), host).toBe(true);
      expect(isLocalOrLiteral(host), host).toBe(true);
    }
    for (const host of [
      "app.localhost",
      "app.localhost.",
      "app.localhost..",
      "localhost..",
      "10.0.0.5",
      "[2001:db8::1]",
      "[2001:db8::1].",
    ]) {
      expect(isLocalOrLiteral(host), host).toBe(true);
    }
    // The refusing side folds every dot; the loopback test (a first-party address outside production)
    // folds one, the way a fully qualified name is written.
    expect(isLoopbackHost("localhost..")).toBe(false);
    for (const host of ["example.org", "example.org.", "localhost.example.org", "notlocalhost"]) {
      expect(isLocalOrLiteral(host), host).toBe(false);
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });
});

describe("the sign-in rule and the consent mode are checked in the registry too", () => {
  test("a direct caller of the registry gets a typed refusal, not a 500 from the table's CHECK", async () => {
    const { createClient } = await import("../src/services/oidc-clients");
    const input = {
      ...clientBody(),
      first_party: false,
    } as unknown as Parameters<typeof createClient>[1];
    for (const over of [{ sign_in_rule: "anyone" }, { consent_mode: "never" }]) {
      const result = await createClient(h.env, { ...input, ...over } as typeof input, h.ids.owner);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.refusal.code).toBe("invalid_body");
        expect(result.refusal.field).toBe(Object.keys(over)[0]);
      }
    }
    expect(h.db.query("SELECT COUNT(*) AS n FROM oidc_clients").get()).toEqual({ n: 0 });
  });
});
