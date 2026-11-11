/**
 * The token endpoint's error words are declared once, in `shared/oidc.ts` as `OIDC_TOKEN_ERROR_CODES`
 * (epic #2014 phase #2020), so the public page, its drift test and the Worker read one list.
 *
 * Held here: the list is exactly the six words of RFC 6749 section 5.2 that NEMAR's endpoint can
 * answer; the Worker's own type is derived from it; every word the endpoint's source can write is in it
 * (a new word that is not declared fails this file); and each word is really answered by the REAL token
 * endpoint, so the list names nothing the endpoint never says.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OIDC_TOKEN_ERROR_CODES } from "../../shared/oidc";
import type { OAuthErrorCode } from "../src/services/oidc-tokens";
import {
  RFC_VERIFIER,
  authorize,
  basic,
  formPost,
  redeem,
  registerClient,
  rotateKeys,
  seedAccount,
  sessionCookie,
  tokenRequest,
} from "./helpers/oidc-flow";
import { type OidcHarness, startOidcHarness } from "./helpers/oidc-harness";

let h: OidcHarness;

beforeEach(async () => {
  h = await startOidcHarness({ HOST_PREFIXED_SESSION_COOKIE: "1" });
  await rotateKeys(h);
});

describe("OIDC_TOKEN_ERROR_CODES", () => {
  test("is the six words of RFC 6749 section 5.2 the endpoint answers", () => {
    expect([...OIDC_TOKEN_ERROR_CODES]).toEqual([
      "invalid_request",
      "invalid_client",
      "invalid_grant",
      "unauthorized_client",
      "unsupported_grant_type",
      "invalid_scope",
    ]);
  });

  test("is what the Worker's error type is built from (the compile-time half is in oidc-tokens.ts)", () => {
    // Runtime only: every declared word is assignable to the Worker's type. The converse, that the type
    // admits no other word, is `OAuthErrorCodesAreDeclared` in `services/oidc-tokens.ts`, which
    // `tsc -p backend` enforces; this file is not in a typecheck include list.
    const every: OAuthErrorCode[] = [...OIDC_TOKEN_ERROR_CODES];
    expect(every).toHaveLength(OIDC_TOKEN_ERROR_CODES.length);
  });

  test("holds every word the endpoint's source writes", () => {
    const root = join(import.meta.dir, "..", "src");
    const sources = [
      readFileSync(join(root, "routes", "oauth.ts"), "utf8"),
      readFileSync(join(root, "services", "oidc-tokens.ts"), "utf8"),
    ].join("\n");
    const written = new Set<string>();
    for (const m of sources.matchAll(/(?:oauthError\(\s*c,|fail\()\s*"([a-z_]+)"/g)) {
      written.add(m[1] as string);
    }
    expect(written.size).toBeGreaterThan(0);
    // A call split over lines (`oauthError(\n c,\n "invalid_request", ...`) is a call site too: the scan
    // finds as many literal-word call sites as the source has, so none is skipped for its layout.
    const sites = sources.match(/\boauthError\(\s*c,\s*"[a-z_]+"/g) ?? [];
    const scanned = [...sources.matchAll(/oauthError\(\s*c,\s*"[a-z_]+"/g)];
    expect(scanned.length).toBe(sites.length);
    expect(sources.match(/\boauthError\(\s*\n/g)?.length ?? 0).toBeGreaterThan(0);
    for (const word of written) {
      expect(OIDC_TOKEN_ERROR_CODES as readonly string[]).toContain(word);
    }
  });

  test("each word is answered by the real endpoint", async () => {
    const client = await registerClient(h, { first_party: true });
    const answered = new Set<unknown>();

    // invalid_request: no grant_type.
    answered.add(
      (
        await formPost(
          h,
          "/oauth/token",
          {},
          { authorization: basic(client.clientId, client.secret) },
        )
      ).json?.error,
    );
    // invalid_client: a wrong secret.
    answered.add(
      (
        await formPost(
          h,
          "/oauth/token",
          { grant_type: "authorization_code" },
          { authorization: basic(client.clientId, "nmo_cs_wrong") },
        )
      ).json?.error,
    );
    // unsupported_grant_type: a grant NEMAR does not offer.
    answered.add(
      (await tokenRequest(h, client, { grant_type: "password", username: "a", password: "b" })).json
        ?.error,
    );
    // invalid_grant: a code that was never issued.
    answered.add((await redeem(h, client, "x".repeat(43))).json?.error);
    // unauthorized_client: a client that is not allowed the grant it asks for.
    const machine = await registerClient(h, {
      allowed_scopes: ["compute.stats"],
      allowed_grants: ["client_credentials"],
      first_party: false,
    });
    answered.add(
      (
        await tokenRequest(h, machine, {
          grant_type: "authorization_code",
          code: "x".repeat(43),
          redirect_uri: machine.redirect,
          code_verifier: RFC_VERIFIER,
        })
      ).json?.error,
    );
    // invalid_scope: a refresh that asks for more than the grant holds.
    const userId = seedAccount(h);
    const cookie = await sessionCookie(h, userId);
    const first = await redeem(
      h,
      client,
      await authorize(h, client, cookie, { scope: "openid offline_access" }),
    );
    answered.add(
      (
        await tokenRequest(h, client, {
          grant_type: "refresh_token",
          refresh_token: (first.json as { refresh_token: string }).refresh_token,
          scope: "openid profile",
        })
      ).json?.error,
    );

    expect([...answered].sort()).toEqual([...OIDC_TOKEN_ERROR_CODES].sort());
  });
});
