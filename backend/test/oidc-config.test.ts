/**
 * The provider's configuration rules (epic #2014 phase #2016; ADR 0119, decision 2): what the
 * issuer is, when the provider is on, and which requests are on its surface. The routes that apply
 * them are `oidc-discovery.test.ts` and `oidc-admin-routes.test.ts`; this file is the table.
 */

import { describe, expect, test } from "bun:test";
import { OIDC_SECRET_PREFIX, isOidcSecret } from "../../shared/oidc";
import {
  buildDiscoveryDocument,
  oidcEnabled,
  oidcIssuer,
  oidcSecret,
  oidcSecretStatus,
  onOidcSurface,
} from "../src/services/oidc-config";
import { BAD_OIDC_SECRETS, GOOD_OIDC_SECRETS, fakeOidcSecret } from "./helpers/oidc-secret";

const SECRET_32 = fakeOidcSecret("config", 26);

describe("the issuer is API_BASE_URL without trailing slashes, and nothing else", () => {
  test.each([
    ["https://api.nemar.org", "https://api.nemar.org"],
    ["https://api.nemar.org/", "https://api.nemar.org"],
    ["https://api.nemar.org///", "https://api.nemar.org"],
    ["  https://api.nemar.org/  ", "https://api.nemar.org"],
    ["https://api-test.nemar.org", "https://api-test.nemar.org"],
    ["http://localhost:8787/", "http://localhost:8787"],
  ])("%j is %j", (given, issuer) => {
    expect(oidcIssuer({ API_BASE_URL: given })).toBe(issuer);
  });

  test("an unset binding is the empty issuer, never a guess", () => {
    expect(oidcIssuer({ API_BASE_URL: undefined as unknown as string })).toBe("");
  });
});

describe("the provider is on only with an nmsso- secret of at least 32 characters in all", () => {
  test.each(BAD_OIDC_SECRETS.map(([what, value]) => [what, value] as const))(
    "OIDC_SECRET %s: off",
    (_what, secret) => {
      expect(oidcEnabled({ OIDC_SECRET: secret as string })).toBe(false);
      expect(oidcSecret({ OIDC_SECRET: secret as string })).toBeNull();
      expect(isOidcSecret(secret)).toBe(false);
    },
  );

  test.each(GOOD_OIDC_SECRETS.map(([what, value]) => [what, value] as const))(
    "OIDC_SECRET of %s: on, and read back unchanged",
    (_what, secret) => {
      expect(oidcEnabled({ OIDC_SECRET: secret })).toBe(true);
      expect(oidcSecret({ OIDC_SECRET: secret })).toBe(secret);
    },
  );

  test("the old rule, length alone, no longer turns it on", () => {
    expect(oidcEnabled({ OIDC_SECRET: "s".repeat(32) })).toBe(false);
    expect(oidcEnabled({ OIDC_SECRET: "s".repeat(70) })).toBe(false);
  });

  test("the prefix alone is not enough: the body counts toward the 32", () => {
    expect(isOidcSecret(`${OIDC_SECRET_PREFIX}${"a".repeat(25)}`)).toBe(false);
    expect(isOidcSecret(`${OIDC_SECRET_PREFIX}${"a".repeat(26)}`)).toBe(true);
  });

  test("the status is a fixed word: unset for absent or empty, malformed for anything else", () => {
    expect(oidcSecretStatus({ OIDC_SECRET: undefined })).toBe("unset");
    expect(oidcSecretStatus({ OIDC_SECRET: "" })).toBe("unset");
    expect(oidcSecretStatus({ OIDC_SECRET: "s".repeat(70) })).toBe("malformed");
    expect(oidcSecretStatus({ OIDC_SECRET: 42 as unknown as string })).toBe("malformed");
    expect(oidcSecretStatus({ OIDC_SECRET: SECRET_32 })).toBe("ok");
  });
});

describe("a request is on the surface only on the issuer's host, off the legacy mount, with the provider on", () => {
  const env = { API_BASE_URL: "https://api.nemar.org/", OIDC_SECRET: SECRET_32 };

  test.each([
    ["https://api.nemar.org/.well-known/openid-configuration", true],
    ["https://api.nemar.org/oauth/jwks", true],
    ["https://api.nemar.org/admin/oidc/clients", true],
    ["https://API.NEMAR.ORG/oauth/jwks", true],
    // the legacy mount, however it is spelled
    ["https://api.nemar.org/nemar/.well-known/openid-configuration", false],
    ["https://api.nemar.org/nemar/oauth/jwks", false],
    ["https://api.nemar.org/nemar", false],
    ["https://api.nemar.org/nemar/", false],
    // another host
    ["https://data.nemar.org/.well-known/openid-configuration", false],
    ["https://api-test.nemar.org/oauth/jwks", false],
    ["https://nemar-api-dev.sccn-org.workers.dev/oauth/jwks", false],
    ["https://api.nemar.org.evil.example/oauth/jwks", false],
    ["https://evil.example/oauth/jwks", false],
    ["https://sub.api.nemar.org/oauth/jwks", false],
    // not a URL
    ["not a url", false],
    ["", false],
  ])("%s -> %j", (url, expected) => {
    expect(onOidcSurface(env, url)).toBe(expected);
  });

  test.each([
    "https://api.nemar.org/%6eemar/oauth/jwks",
    "https://api.nemar.org/%6Eemar/oauth/jwks",
    "https://api.nemar.org/n%65mar/.well-known/openid-configuration",
    "https://api.nemar.org/%256eemar/oauth/jwks",
    "https://api.nemar.org/%25256eemar/oauth/jwks",
    "https://api.nemar.org/%6eemar",
  ])("the legacy mount spelled with percent-encoding is off the surface: %s", (url) => {
    expect(onOidcSurface(env, url)).toBe(false);
  });

  test("the router's decoded path decides first, whatever the URL's own text is", () => {
    const url = "https://api.nemar.org/%6eemar/admin/oidc/clients/oc_x%ff";
    expect(onOidcSurface(env, url, "/nemar/admin/oidc/clients/oc_x%ff")).toBe(false);
    expect(onOidcSurface(env, url, "/nemar")).toBe(false);
    // A routed path that is not the legacy mount leaves the other test to decide.
    expect(onOidcSurface(env, "https://api.nemar.org/oauth/jwks", "/oauth/jwks")).toBe(true);
    expect(onOidcSurface(env, "https://api.nemar.org/oauth/jwks", "/nemarx/oauth/jwks")).toBe(true);
    expect(onOidcSurface(env, "https://api.nemar.org/%6eemar/oauth/jwks", "/oauth/jwks")).toBe(
      false,
    );
  });

  test("a path that only starts with the letters nemar is not the legacy mount", () => {
    expect(onOidcSurface(env, "https://api.nemar.org/nemarx/oauth/jwks")).toBe(true);
  });

  test("with no usable secret nothing is on the surface", () => {
    for (const [, secret] of BAD_OIDC_SECRETS) {
      expect(
        onOidcSurface(
          { ...env, OIDC_SECRET: secret as string },
          "https://api.nemar.org/oauth/jwks",
        ),
      ).toBe(false);
    }
  });

  test("an API_BASE_URL that is not a URL puts nothing on the surface", () => {
    for (const base of ["", "api.nemar.org", "not a url"]) {
      expect(
        onOidcSurface(
          { API_BASE_URL: base, OIDC_SECRET: SECRET_32 },
          "https://api.nemar.org/oauth/jwks",
        ),
      ).toBe(false);
    }
  });
});

describe("the discovery document is the ADR's", () => {
  const doc = buildDiscoveryDocument({
    API_BASE_URL: "https://api.nemar.org/",
    APP_BASE_URL: undefined,
  });

  test("the issuer and the endpoints, the authorization one on the app host", () => {
    expect(doc.issuer).toBe("https://api.nemar.org");
    expect(doc.authorization_endpoint).toBe("https://app.nemar.org/oauth/authorize");
    expect(doc.token_endpoint).toBe("https://api.nemar.org/oauth/token");
    expect(doc.userinfo_endpoint).toBe("https://api.nemar.org/oauth/userinfo");
    expect(doc.jwks_uri).toBe("https://api.nemar.org/oauth/jwks");
    expect(doc.revocation_endpoint).toBe("https://api.nemar.org/oauth/revoke");
    expect(doc.introspection_endpoint).toBe("https://api.nemar.org/oauth/introspect");
  });

  test("the authorization endpoint follows APP_BASE_URL, trailing slash trimmed", () => {
    const staging = buildDiscoveryDocument({
      API_BASE_URL: "https://api-test.nemar.org",
      APP_BASE_URL: "https://test.nemar.org/",
    });
    expect(staging.issuer).toBe("https://api-test.nemar.org");
    expect(staging.authorization_endpoint).toBe("https://test.nemar.org/oauth/authorize");
    expect(staging.token_endpoint).toBe("https://api-test.nemar.org/oauth/token");
  });

  test("what NEMAR supports", () => {
    expect(doc.response_types_supported).toEqual(["code"]);
    expect(doc.id_token_signing_alg_values_supported).toEqual(["ES256"]);
    expect(doc.token_endpoint_auth_methods_supported).toEqual(["client_secret_basic"]);
    expect(doc.code_challenge_methods_supported).toEqual(["S256"]);
    expect(doc.grant_types_supported).toEqual([
      "authorization_code",
      "refresh_token",
      "client_credentials",
    ]);
    expect(doc.subject_types_supported).toEqual(["public"]);
    expect(doc.authorization_response_iss_parameter_supported).toBe(true);
    expect(doc.backchannel_logout_supported).toBe(true);
    expect(doc.request_parameter_supported).toBe(false);
    expect(doc.request_uri_parameter_supported).toBe(false);
    expect(doc.response_modes_supported).toEqual(["query"]);
  });

  test("the scopes and claims are the catalogue's", () => {
    expect(doc.scopes_supported).toEqual([
      "openid",
      "profile",
      "email",
      "orcid",
      "nemar.account",
      "offline_access",
      "compute.read",
      "compute.reserve",
      "compute.submit",
      "compute.stats",
    ]);
    expect(doc.claims_supported).toContain("sub");
    expect(doc.claims_supported).toContain("orcid_verified");
  });

  test("there is no implicit, no password grant and no plain challenge to be found", () => {
    const text = JSON.stringify(doc);
    for (const word of [
      "implicit",
      "password",
      '"plain"',
      "id_token token",
      "client_secret_post",
    ]) {
      expect(text).not.toContain(word);
    }
  });
});
