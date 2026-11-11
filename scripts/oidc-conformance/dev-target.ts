/**
 * The deployed development system a conformance run may point at (epic #2014 phase #2020, slice S7),
 * and the refusals that keep a run from pointing anywhere else.
 *
 * The workflow takes the issuer, the authorization page's origin and the client's id as inputs. They are
 * checked here, not trusted: the issuer and the page must be exactly the development system's two hosts
 * (never production, never an arbitrary address), and the client id must have the shape of a NEMAR client
 * id, which is public. No secret is read or held anywhere on this path.
 */

import { isOidcClientId } from "../../shared/oidc";

/** The development API, which is the issuer there. */
export const DEV_ISSUER = "https://api-test.nemar.org";

/** The staging website, which serves the authorization page there. */
export const DEV_AUTHORIZATION_BASE = "https://test.nemar.org";

export interface DevTarget {
  readonly issuer: string;
  readonly authorizationBase: string;
  readonly clientId: string;
}

/** The checked target, or an Error whose message says what to change. */
export function resolveDevTarget(input: {
  issuer?: string;
  authorizationBase?: string;
  clientId?: string;
}): DevTarget {
  const issuer = (input.issuer ?? "").trim();
  const authorizationBase = (input.authorizationBase ?? "").trim();
  const clientId = (input.clientId ?? "").trim();
  if (issuer !== DEV_ISSUER) {
    throw new Error(
      `the issuer must be exactly ${DEV_ISSUER} (the development API), not "${issuer}": a conformance run never targets production or any other address`,
    );
  }
  if (authorizationBase !== DEV_AUTHORIZATION_BASE) {
    throw new Error(
      `the authorization base must be exactly ${DEV_AUTHORIZATION_BASE} (the staging website), not "${authorizationBase}"`,
    );
  }
  if (!isOidcClientId(clientId)) {
    throw new Error(
      "dev_client_id is not a NEMAR client id: register the conformance client on the development system first and pass its public id",
    );
  }
  return { issuer, authorizationBase, clientId };
}
