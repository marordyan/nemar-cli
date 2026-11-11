/**
 * OpenID Connect discovery and the signing keys' public set (epic #2014 phase #2016; ADR 0119,
 * decision 2):
 *
 *   GET /.well-known/openid-configuration    the discovery document
 *   GET /oauth/jwks                          the public keys, as a JSON Web Key Set
 *
 * Both live on the API host PERMANENTLY, because that is the issuer, and a client that cannot
 * fetch them cannot validate a token. So both are exempt from the maintenance mode
 * (`middleware/maintenance.ts`) and from the rate limiter (`middleware/rateLimit.ts`), by the one
 * list of paths in `shared/oidc.ts`; what that costs (a key-set read per request) is bounded by the
 * short per-database cache in `services/oidc-keys.ts`.
 *
 * Both answer 404, as the API's own unrouted 404, unless the request is on the OIDC surface
 * ({@link oidcSurface}): the provider is enabled (`OIDC_SECRET`), the request names the issuer's
 * host, and the path has no `/nemar` prefix. The Worker mounts the API at both `/` and `/nemar`,
 * and forks the data, zarr and MCP hosts before the API app is reached; a document served on any of
 * those would name an issuer the host is not.
 *
 * {@link oidcSurface} is the middleware the owner routes reuse, so the rule is one function and a
 * route cannot forget it. The authorization routes (`auth-oidc.ts`) and the token, userinfo,
 * revocation and introspection endpoints (`oauth.ts`) use `oidcAuthorizeSurface` instead, which is
 * this same test (`onOidcSurface`) AND `HOST_PREFIXED_SESSION_COOKIE` being `"1"`: the provider's
 * whole flow is lit or dark together, while discovery and the key set answer on the surface alone.
 */

import { Hono, type MiddlewareHandler } from "hono";
import {
  OIDC_DISCOVERY_PATH,
  OIDC_JWKS_PATH,
  OIDC_PUBLIC_DOCUMENT_MAX_AGE_SECONDS,
} from "../../../shared/oidc.js";
import { notFoundResponse } from "../lib/not-found.js";
import { buildDiscoveryDocument, onOidcSurface } from "../services/oidc-config.js";
import { jwksDocument } from "../services/oidc-keys.js";
import type { Bindings, Variables } from "../types/bindings.js";

type Env = { Bindings: Bindings; Variables: Variables };

/**
 * 404, exactly like a route that does not exist, unless the request is on the OIDC surface. Place
 * it AFTER whatever authenticates the caller on a route that has callers, so a caller is told what
 * they are before they are told whether the surface exists.
 */
export const oidcSurface: MiddlewareHandler<Env> = async (c, next) => {
  if (!onOidcSurface(c.env, c.req.url, c.req.path)) return notFoundResponse(c);
  await next();
};

/**
 * What a public document carries, set AFTER the handler because the API's global CORS middleware
 * has already put the caller's origin and `Allow-Credentials` on the response, and a handler's own
 * headers are merged under those. A public document is open to every origin and carries no
 * credentials, so a page on any host, a partner's included, can read it.
 */
const publicDocument: MiddlewareHandler<Env> = async (c, next) => {
  await next();
  // Only the document itself is public and cacheable: an error from the handler (a key set that could
  // not be read or built) must never be stored by a cache for five minutes as if it were the answer.
  if (c.res.status !== 200) return;
  c.res.headers.set("Access-Control-Allow-Origin", "*");
  c.res.headers.set("Cache-Control", `public, max-age=${OIDC_PUBLIC_DOCUMENT_MAX_AGE_SECONDS}`);
  c.res.headers.delete("Access-Control-Allow-Credentials");
  c.res.headers.delete("Access-Control-Expose-Headers");
};

export const oidcDiscoveryRoutes = new Hono<Env>();

oidcDiscoveryRoutes.get(OIDC_DISCOVERY_PATH, oidcSurface, publicDocument, (c) =>
  c.json(buildDiscoveryDocument(c.env)),
);

oidcDiscoveryRoutes.get(OIDC_JWKS_PATH, oidcSurface, publicDocument, async (c) =>
  c.body(await jwksDocument(c.env.DB), 200, { "Content-Type": "application/json; charset=UTF-8" }),
);
