/**
 * The OpenID Connect provider's configuration and its discovery document (epic #2014 phase
 * #2016; ADR 0119, decision 2).
 *
 * THE ISSUER IS `API_BASE_URL`, TRIMMED OF TRAILING SLASHES, AND NOTHING DERIVED FROM A REQUEST.
 * An identity token carries exactly that `iss`, a client trusts it for as long as it exists, and a
 * value read from the request's `Host` or from a forwarded header would let a caller choose it.
 * Each Worker's issuer is therefore its own `API_BASE_URL`: the production Worker's is the API
 * host's origin, the staging Worker's is its own, and a Worker that is reached under another name
 * answers 404 (`onOidcSurface`) rather than a document naming an issuer it is not.
 *
 * THE PROVIDER IS ON ONLY WITH A SECRET. `OIDC_SECRET` encrypts the private signing keys at rest,
 * so with none (or one that is not `nmsso-` and a body, 32 characters or more: `isOidcSecret`) there is nothing safe to sign with and every OIDC
 * surface answers 404, indistinguishable from a route that does not exist.
 *
 * Pure functions of the bindings and a URL: no I/O, so the tables here are unit-testable without
 * instantiating the Worker, as `cors-origins.ts` is.
 */

import {
  OIDC_AUTHORIZE_PATH,
  OIDC_GRANTS,
  OIDC_INTROSPECT_PATH,
  OIDC_JWKS_PATH,
  OIDC_REVOKE_PATH,
  OIDC_SCOPE_NAMES,
  OIDC_SIGNING_ALG,
  OIDC_TOKEN_PATH,
  OIDC_USERINFO_PATH,
  type OidcSecretState,
  isOidcSecret,
  oidcClaimsSupported,
  oidcSecretState,
} from "../../../shared/oidc.js";
import type { Bindings } from "../types/bindings.js";
import { appBase } from "./environment.js";

/** The legacy mount the Worker also answers under (`api.osc.earth/nemar`). Never an OIDC surface. */
const LEGACY_MOUNT = "/nemar";

/** The issuer: `API_BASE_URL` without trailing slashes. Empty only when the binding is unset. */
export function oidcIssuer(env: Pick<Bindings, "API_BASE_URL">): string {
  return (env.API_BASE_URL ?? "").trim().replace(/\/+$/, "");
}

/**
 * THE ONE READER OF `OIDC_SECRET`. The secret when it passes `isOidcSecret` (`nmsso-` and a body, 32
 * characters or more), otherwise null: a value in any other form behaves exactly like an unset one,
 * and is never used, not even as a fallback. Everything that signs, encrypts, decrypts or MACs for
 * the provider takes its secret from here, so no code path can use a value that fails the check.
 */
export function oidcSecret(env: Pick<Bindings, "OIDC_SECRET">): string | null {
  return isOidcSecret(env.OIDC_SECRET) ? env.OIDC_SECRET : null;
}

/** True only when `OIDC_SECRET` is valid (`oidcSecret` is not null). */
export function oidcEnabled(env: Pick<Bindings, "OIDC_SECRET">): boolean {
  return oidcSecret(env) !== null;
}

/**
 * `ok`, `unset` or `malformed`: a fixed word for the owner, never the value or its length. Only the
 * owner routes say it (`routes/admin/oidc.ts`); every public surface stays an ordinary 404.
 */
export function oidcSecretStatus(env: Pick<Bindings, "OIDC_SECRET">): OidcSecretState {
  return oidcSecretState(env.OIDC_SECRET);
}

/** The issuer's hostname, or null when `API_BASE_URL` is not a URL. */
function issuerHostname(env: Pick<Bindings, "API_BASE_URL">): string | null {
  try {
    const host = new URL(oidcIssuer(env)).hostname;
    return host === "" ? null : host;
  } catch {
    return null;
  }
}

/**
 * Whether a request is on the OIDC surface: the provider is enabled, the request's own URL names
 * the issuer's host, and its path is not under the legacy `/nemar` mount, however that is spelled.
 * The router's own decoded path (`routedPath`, Hono's `c.req.path`) is the primary test, because it is
 * the path the handlers are chosen by; the decoded forms of the URL's own path are a second one.
 *
 * The host is read from the request URL, which the platform builds from the route that matched,
 * never from a `Host` header a caller could forge, and it is compared with the host of the issuer
 * (`API_BASE_URL`), not with anything the request says. The data, zarr and MCP hosts are forked
 * before the API app is reached (`resolveHostRoute`), and the legacy mount reaches the same
 * handlers under a prefix: both are refused here, so each OIDC route and each owner route behind
 * `oidcSurface` exists on one host and one path only.
 */
export function onOidcSurface(
  env: Pick<Bindings, "API_BASE_URL" | "OIDC_SECRET">,
  requestUrl: string,
  routedPath?: string,
): boolean {
  return oidcEnabled(env) && onIssuerHost(env, requestUrl, routedPath);
}

/**
 * The host and mount half of {@link onOidcSurface}: the request names the issuer's host and is not
 * under the legacy mount. The owner routes use it alone to tell a request that WOULD be on the
 * surface (so the secret is what is missing) from one that never could be.
 */
export function onIssuerHost(
  env: Pick<Bindings, "API_BASE_URL">,
  requestUrl: string,
  routedPath?: string,
): boolean {
  const issuerHost = issuerHostname(env);
  if (issuerHost === null) return false;
  let request: URL;
  try {
    request = new URL(requestUrl);
  } catch {
    return false;
  }
  // Check the router's decoded path first: it is the one that picks the handlers. The URL's own path,
  // as written and percent-decoded, is tested as well.
  if (routedPath !== undefined && isLegacyMount(routedPath)) return false;
  if (decodedForms(request.pathname).some(isLegacyMount)) return false;
  return request.hostname === issuerHost;
}

const isLegacyMount = (path: string): boolean =>
  path === LEGACY_MOUNT || path.startsWith(`${LEGACY_MOUNT}/`);

/**
 * A path as written and then percent-decoded, up to three times, so a mount spelled `%6eemar`,
 * `%6Eemar` or double or triple encoded is seen as the mount it is. Refusing a path that only a
 * decoder would read as `/nemar` costs nothing: no OIDC route is ever under it.
 */
function decodedForms(path: string): string[] {
  const forms = [path];
  let current = path;
  for (let i = 0; i < 3; i++) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      break;
    }
    if (next === current) break;
    forms.push(next);
    current = next;
  }
  return forms;
}

/**
 * The discovery document (OpenID Connect Discovery 1.0): what a client reads to find the
 * endpoints, the keys and what NEMAR supports. The authorization endpoint is on the APP host,
 * because the sign-in cookie lives only there (ADR 0119 rule 2); every other endpoint is under the
 * issuer.
 *
 * `claims_supported` lists the claims ADR 0119 names (`oidcClaimsSupported`), `nemar.account`'s
 * included since the token phase (#2018) named them.
 * `request_parameter_supported` and `request_uri_parameter_supported` are false: the OpenID Connect
 * default for the second is TRUE, so leaving it out would tell a client it may send a request
 * object by reference.
 */
export function buildDiscoveryDocument(
  env: Pick<Bindings, "API_BASE_URL" | "APP_BASE_URL">,
): Record<string, unknown> {
  const issuer = oidcIssuer(env);
  return {
    issuer,
    authorization_endpoint: `${appBase(env)}${OIDC_AUTHORIZE_PATH}`,
    token_endpoint: `${issuer}${OIDC_TOKEN_PATH}`,
    userinfo_endpoint: `${issuer}${OIDC_USERINFO_PATH}`,
    jwks_uri: `${issuer}${OIDC_JWKS_PATH}`,
    revocation_endpoint: `${issuer}${OIDC_REVOKE_PATH}`,
    introspection_endpoint: `${issuer}${OIDC_INTROSPECT_PATH}`,
    response_types_supported: ["code"],
    grant_types_supported: [...OIDC_GRANTS],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: [OIDC_SIGNING_ALG],
    token_endpoint_auth_methods_supported: ["client_secret_basic"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: [...OIDC_SCOPE_NAMES],
    claims_supported: oidcClaimsSupported(),
    authorization_response_iss_parameter_supported: true,
    backchannel_logout_supported: true,
    request_parameter_supported: false,
    request_uri_parameter_supported: false,
    response_modes_supported: ["query"],
  };
}
