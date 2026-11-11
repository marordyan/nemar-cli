/**
 * The OpenID Connect provider's token, userinfo, revocation and introspection endpoints (epic #2014
 * phase #2018; ADR 0119 rules 1, 2, 4, 13 and 14), mounted at `/oauth`:
 *
 *   POST     /oauth/token        the authorization code, refresh token and client credentials grants
 *   GET|POST /oauth/userinfo     the claims of a live access token's scopes (OpenID Connect Core 5.3)
 *   POST     /oauth/revoke       end a token of the calling client (RFC 7009)
 *   POST     /oauth/introspect   whether a token is active, to a caller allowed to know (RFC 7662)
 *
 * The signing keys' public set, `/oauth/jwks`, is the discovery router's (`oidc-discovery.ts`).
 *
 * THE ORDER OF THE GUARDS, which a route cannot reorder (`test/oauth-route-inventory.test.ts`):
 *   1. `oidcAuthorizeSurface` (`auth-oidc.ts`): 404, as an unrouted path does, unless the provider is
 *      on, the request is on the issuer's host with no `/nemar` prefix (`onOidcSurface`, the test the
 *      discovery router's `oidcSurface` makes), AND `HOST_PREFIXED_SESSION_COOKIE` is `"1"`. The
 *      authorization routes' guard, imported rather than restated, so the provider's whole flow is
 *      dark (production today) or lit together; discovery and the key set need the surface only.
 *   2. {@link noStore}: every answer from here on, success or refusal, is `Cache-Control: no-store`
 *      and `Pragma: no-cache` (RFC 6749 section 5.1): it carries a token, a claim or a verdict.
 *   3. Userinfo only: `oidcBearer(["openid"])`, the one middleware that accepts an access token.
 *   4. The handler. The three client endpoints read a bounded form body, then authenticate the client
 *      with HTTP Basic and nothing else (`authenticateClient`), then read the parameters.
 *
 * Errors are RFC 6749 section 5.2: `{error, error_description}`, the description a fixed sentence
 * that never repeats what was sent; 400, or 401 with `WWW-Authenticate: Basic` for `invalid_client`.
 * A CLI key is not a client credential and is not an access token: it is `invalid_client` at the
 * three client endpoints and `invalid_token` at userinfo. Nothing here logs a token, a code, a
 * verifier, a secret or a body.
 */

import { type Context, Hono, type MiddlewareHandler } from "hono";
import { oidcBearer } from "../middleware/oidc-bearer";
import { claimsForScopes } from "../services/oidc-claims";
import { authenticateClient } from "../services/oidc-clients";
import {
  type GrantOutcome,
  type OAuthErrorCode,
  clientCredentials,
  introspectToken,
  isWellFormedVerifier,
  redeemAuthorizationCode,
  refreshTokens,
  revokeToken,
} from "../services/oidc-tokens";
import type { Bindings, Variables } from "../types/bindings";
import { oidcAuthorizeSurface } from "./auth-oidc";
import { readCapped } from "./callbacks/bounded-json";

type Env = { Bindings: Bindings; Variables: Variables };
type Ctx = Context<Env>;

/** The largest form body the three client endpoints read. A real one is well under a kilobyte. */
export const OAUTH_FORM_MAX_BYTES = 16 * 1024;

/** The realm of the Basic challenge an `invalid_client` answer carries. */
const BASIC_CHALLENGE = 'Basic realm="oauth", charset="UTF-8"';

/** Every answer behind the surface is `no-store`, whichever handler or middleware wrote it. */
export const noStore: MiddlewareHandler<Env> = async (c, next) => {
  await next();
  c.res.headers.set("Cache-Control", "no-store");
  c.res.headers.set("Pragma", "no-cache");
};

function oauthError(c: Ctx, error: OAuthErrorCode, description: string): Response {
  if (error === "invalid_client") {
    return c.json({ error, error_description: description }, 401, {
      "WWW-Authenticate": BASIC_CHALLENGE,
    });
  }
  return c.json({ error, error_description: description }, 400);
}

const invalidClient = (c: Ctx) =>
  oauthError(c, "invalid_client", "The client could not be authenticated.");

/**
 * The form body: `application/x-www-form-urlencoded` only, at most {@link OAUTH_FORM_MAX_BYTES}
 * (declared and counted), UTF-8, and no parameter more than once (RFC 6749 section 3.2). Null for
 * anything else.
 */
async function readForm(c: Ctx): Promise<URLSearchParams | null> {
  const type = (c.req.header("Content-Type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") return null;
  const declared = Number(c.req.header("Content-Length") ?? "0");
  if (Number.isFinite(declared) && declared > OAUTH_FORM_MAX_BYTES) return null;
  let text: string;
  try {
    const raw = await readCapped(c.req.raw, OAUTH_FORM_MAX_BYTES);
    if (raw === null) return null;
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(raw);
  } catch {
    return null;
  }
  const form = new URLSearchParams(text);
  const seen = new Set<string>();
  for (const name of form.keys()) {
    if (seen.has(name)) return null;
    seen.add(name);
  }
  return form;
}

/** A parameter's value, or null when it is absent or empty (RFC 6749 section 3.2: empty is omitted). */
function param(form: URLSearchParams, name: string): string | null {
  const value = form.get(name);
  return value === null || value === "" ? null : value;
}

const unreadable = (c: Ctx) =>
  oauthError(c, "invalid_request", "The body must be a form with each parameter at most once.");

function answer(c: Ctx, outcome: GrantOutcome): Response {
  return outcome.ok ? c.json(outcome.body, 200) : oauthError(c, outcome.error, outcome.description);
}

export const oauthRoutes = new Hono<Env>();

oauthRoutes.post("/token", oidcAuthorizeSurface, noStore, async (c) => {
  const form = await readForm(c);
  if (!form) return unreadable(c);
  const client = await authenticateClient(c.env.DB, c.req.header("Authorization"), form);
  if (!client) return invalidClient(c);
  const grantType = param(form, "grant_type");
  if (grantType === null) return oauthError(c, "invalid_request", "grant_type is required.");
  const notAllowed = () =>
    oauthError(c, "unauthorized_client", "This client may not use that grant type.");

  switch (grantType) {
    case "authorization_code": {
      if (!client.allowedGrants.includes("authorization_code")) return notAllowed();
      const code = param(form, "code");
      const redirectUri = param(form, "redirect_uri");
      const verifier = param(form, "code_verifier");
      if (code === null || redirectUri === null || verifier === null) {
        return oauthError(
          c,
          "invalid_request",
          "code, redirect_uri and code_verifier are required.",
        );
      }
      // RFC 7636 section 4.1: a verifier is 43 to 128 unreserved characters, or it is not one.
      if (!isWellFormedVerifier(verifier)) {
        return oauthError(c, "invalid_request", "code_verifier is not a PKCE verifier.");
      }
      return answer(
        c,
        await redeemAuthorizationCode(c.env, client, { code, redirectUri, verifier }),
      );
    }
    case "refresh_token": {
      if (!client.allowedGrants.includes("refresh_token")) return notAllowed();
      const refreshToken = param(form, "refresh_token");
      if (refreshToken === null) {
        return oauthError(c, "invalid_request", "refresh_token is required.");
      }
      return answer(
        c,
        await refreshTokens(c.env, client, { refreshToken, scope: param(form, "scope") }),
      );
    }
    case "client_credentials": {
      if (!client.allowedGrants.includes("client_credentials")) return notAllowed();
      return answer(c, await clientCredentials(c.env, client, { scope: param(form, "scope") }));
    }
    default:
      return oauthError(c, "unsupported_grant_type", "That grant type is not supported.");
  }
});

/** The claims of the token's scopes, read from the account in the same statement `oidcBearer` ran. */
async function userinfo(c: Ctx): Promise<Response> {
  const token = c.get("oidcToken");
  // `openid` is never a machine scope, so a token that reached here names an account.
  if (!token?.user) throw new Error("userinfo reached without an account's access token");
  return c.json(claimsForScopes(token.scopes, token.user), 200);
}

oauthRoutes.get("/userinfo", oidcAuthorizeSurface, noStore, oidcBearer(["openid"]), userinfo);
oauthRoutes.post("/userinfo", oidcAuthorizeSurface, noStore, oidcBearer(["openid"]), userinfo);

oauthRoutes.post("/revoke", oidcAuthorizeSurface, noStore, async (c) => {
  const form = await readForm(c);
  if (!form) return unreadable(c);
  const client = await authenticateClient(c.env.DB, c.req.header("Authorization"), form);
  if (!client) return invalidClient(c);
  const token = param(form, "token");
  if (token === null) return oauthError(c, "invalid_request", "token is required.");
  // 200 whatever the token was: unknown, another client's, or ended already (RFC 7009 section 2.2).
  await revokeToken(c.env.DB, client, token);
  return c.body(null, 200);
});

oauthRoutes.post("/introspect", oidcAuthorizeSurface, noStore, async (c) => {
  const form = await readForm(c);
  if (!form) return unreadable(c);
  const client = await authenticateClient(c.env.DB, c.req.header("Authorization"), form);
  if (!client) return invalidClient(c);
  const token = param(form, "token");
  if (token === null) return oauthError(c, "invalid_request", "token is required.");
  return c.json(await introspectToken(c.env, client, token), 200);
});
