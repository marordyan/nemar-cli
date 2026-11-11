/**
 * Reading an identity token this provider signed (epic #2014 phase #2017; ADR 0119 rule 2).
 *
 * The authorization endpoint reads one as an `id_token_hint`: the client says which account it last
 * saw, and a valid hint for another subject asks for a fresh sign-in. The token and userinfo phases
 * (#2018) sign them with `signJwt` in `oidc-keys.ts`; this is the other half, kept apart from the
 * signing keys' lifecycle.
 *
 * A token is this provider's when it is ES256, names a key of the published key set (current, next,
 * or retired inside its window: `jwksDocument`), verifies under that key, and carries exactly this
 * Worker's issuer. Anything else is null and never an error, which is what a hint calls for (OpenID
 * Connect Core 3.1.2.1). An expired token is still a valid hint.
 */

import { OIDC_SIGNING_ALG, isOidcKid } from "../../../shared/oidc.js";
import type { Bindings } from "../types/bindings.js";
import { oidcIssuer } from "./oidc-config.js";
import { fromBase64Url } from "./oidc-encoding.js";
import { jwksDocument } from "./oidc-keys.js";

/** Longer than any token this provider signs; a longer hint is not read. */
const ID_TOKEN_MAX_LENGTH = 4096;

/** The claims of `token` when this provider signed it, as the module comment says, or null. */
export async function verifiedIdTokenClaims(
  env: Pick<Bindings, "DB" | "API_BASE_URL">,
  token: string,
): Promise<Record<string, unknown> | null> {
  if (token.length > ID_TOKEN_MAX_LENGTH) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[0]))) as {
      alg?: unknown;
      kid?: unknown;
    };
    if (header.alg !== OIDC_SIGNING_ALG || !isOidcKid(header.kid)) return null;
    const keys = (JSON.parse(await jwksDocument(env.DB)) as { keys: Array<Record<string, string>> })
      .keys;
    const jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y },
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const verified = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      fromBase64Url(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
    if (!verified) return null;
    const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[1]))) as Record<
      string,
      unknown
    >;
    if (claims === null || typeof claims !== "object" || claims.iss !== oidcIssuer(env)) {
      return null;
    }
    return claims;
  } catch {
    return null;
  }
}

/** The `sub` of an `id_token_hint` this provider signed, or null for anything else. */
export async function idTokenHintSubject(
  env: Pick<Bindings, "DB" | "API_BASE_URL">,
  hint: string,
): Promise<string | null> {
  const claims = await verifiedIdTokenClaims(env, hint);
  return claims && typeof claims.sub === "string" ? claims.sub : null;
}
