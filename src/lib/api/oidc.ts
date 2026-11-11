/**
 * NEMAR API client: the OpenID Connect provider's client registry and signing keys (epic #2014
 * phase #2016; ADR 0119), `/admin/oidc/...`. Owner role, and only on a Worker whose provider is on
 * (`OIDC_SECRET` set) and whose host is the issuer's: anywhere else the routes do not exist.
 *
 * The wire shapes are `shared/contract/oidc-admin.ts`, parsed leniently. A refusal answers
 * `{ error: <sentence>, code: <word> }`: the sentence is `ApiError.message`, and the word is read
 * with {@link oidcErrorCode}, never from `ApiError.code` (which is the body's `error`, the sentence,
 * under this convention).
 */

import {
  type OidcAccountEndResponse,
  type OidcClientCreateRequest,
  type OidcClientCreateResponse,
  type OidcClientDisableResponse,
  type OidcClientListResponse,
  type OidcClientRotateResponse,
  type OidcClientShowResponse,
  type OidcKeyRevokeResponse,
  type OidcKeysResponse,
  type OidcKeysRotateResponse,
  type OidcLogoutDeliveriesResponse,
  oidcAccountEndResponseSchema,
  oidcClientCreateResponseSchema,
  oidcClientDisableResponseSchema,
  oidcClientListResponseSchema,
  oidcClientRotateResponseSchema,
  oidcClientShowResponseSchema,
  oidcKeyRevokeResponseSchema,
  oidcKeysResponseSchema,
  oidcKeysRotateResponseSchema,
  oidcLogoutDeliveriesResponseSchema,
} from "../../../shared/contract/oidc-admin.js";
import type { OidcAccountEndReason } from "../../../shared/oidc.js";
import { request } from "./client.js";
import { ApiError } from "./errors.js";

const BASE = "/admin/oidc";

/** `POST /admin/oidc/clients`: the client and its secret, which the Worker shows this once. */
export async function createOidcClient(
  body: OidcClientCreateRequest,
): Promise<OidcClientCreateResponse> {
  return request(
    `${BASE}/clients`,
    { method: "POST", body: JSON.stringify(body) },
    true,
    oidcClientCreateResponseSchema,
  );
}

/** `GET /admin/oidc/clients`: every client, oldest first. No secret, no hash. */
export async function listOidcClients(): Promise<OidcClientListResponse> {
  return request(`${BASE}/clients`, {}, true, oidcClientListResponseSchema);
}

/** `GET /admin/oidc/clients/:client_id`. */
export async function getOidcClient(clientId: string): Promise<OidcClientShowResponse> {
  return request(
    `${BASE}/clients/${encodeURIComponent(clientId)}`,
    {},
    true,
    oidcClientShowResponseSchema,
  );
}

/**
 * `POST /admin/oidc/clients/:client_id/rotate-secret`: a new secret, shown this once, and the old
 * one valid for `graceHours` (the Worker's default is 24; 0 ends it at once).
 */
export async function rotateOidcClientSecret(
  clientId: string,
  graceHours?: number,
): Promise<OidcClientRotateResponse> {
  return request(
    `${BASE}/clients/${encodeURIComponent(clientId)}/rotate-secret`,
    { method: "POST", body: JSON.stringify(graceHours === undefined ? {} : { graceHours }) },
    true,
    oidcClientRotateResponseSchema,
  );
}

/** `POST /admin/oidc/clients/:client_id/disable`: `changed` is false when it already was. */
export async function disableOidcClient(clientId: string): Promise<OidcClientDisableResponse> {
  return request(
    `${BASE}/clients/${encodeURIComponent(clientId)}/disable`,
    { method: "POST", body: "{}" },
    true,
    oidcClientDisableResponseSchema,
  );
}

/** `GET /admin/oidc/keys`: the signing keys and their states. Never the private half. */
export async function listOidcKeys(): Promise<OidcKeysResponse> {
  return request(`${BASE}/keys`, {}, true, oidcKeysResponseSchema);
}

/**
 * `POST /admin/oidc/keys/rotate`: make the first keys, or rotate them. `force` skips the 24 hours,
 * and `emergency` skips the floor under which a just-published key is not promoted. The Worker reads
 * `emergency` only together with `force`, so sending it alone does nothing.
 */
export async function rotateOidcKeys(
  options: { force?: boolean; emergency?: boolean } = {},
): Promise<OidcKeysRotateResponse> {
  const body: { force?: true; emergency?: true } = {};
  if (options.force) body.force = true;
  if (options.emergency) body.emergency = true;
  return request(
    `${BASE}/keys/rotate`,
    { method: "POST", body: JSON.stringify(body) },
    true,
    oidcKeysRotateResponseSchema,
  );
}

/** `POST /admin/oidc/keys/:kid/revoke`: withdraw a retired key; `changed` is false when it already was. */
export async function revokeOidcKey(kid: string): Promise<OidcKeyRevokeResponse> {
  return request(
    `${BASE}/keys/${encodeURIComponent(kid)}/revoke`,
    { method: "POST", body: "{}" },
    true,
    oidcKeyRevokeResponseSchema,
  );
}

/**
 * `POST /admin/oidc/accounts/:id/end`: end an account's grants at every client (the manual merge of
 * ADR 0043, and the incident tool). `reason` is `merged` or `revoked`; the answer counts what the one
 * batch ended and how many clients will be told. Idempotent: a second call finds nothing live.
 */
export async function endOidcAccount(
  userId: number,
  reason: OidcAccountEndReason,
): Promise<OidcAccountEndResponse> {
  return request(
    `${BASE}/accounts/${encodeURIComponent(String(userId))}/end`,
    { method: "POST", body: JSON.stringify({ reason }) },
    true,
    oidcAccountEndResponseSchema,
  );
}

/**
 * `GET /admin/oidc/logout-deliveries`: the back-channel logouts owed to clients, newest first, and a
 * count of every status. `status` narrows the list (not the counts); `limit` is 1 to 500.
 */
export async function listOidcLogoutDeliveries(
  options: { status?: string; limit?: number } = {},
): Promise<OidcLogoutDeliveriesResponse> {
  const query = new URLSearchParams();
  if (options.status !== undefined) query.set("status", options.status);
  if (options.limit !== undefined) query.set("limit", String(options.limit));
  const qs = query.toString();
  return request(
    `${BASE}/logout-deliveries${qs === "" ? "" : `?${qs}`}`,
    {},
    true,
    oidcLogoutDeliveriesResponseSchema,
  );
}

/**
 * The word an owner's 404 carries when the provider is off for want of a usable secret:
 * `unset` or `malformed` (`rawBody.oidc_secret`), never a value. Undefined for any other answer
 * and for a Worker that predates the word.
 */
export function oidcSecretWord(error: unknown): "unset" | "malformed" | undefined {
  if (!(error instanceof ApiError) || error.statusCode !== 404) return undefined;
  const word = (error.rawBody as { oidc_secret?: unknown } | undefined)?.oidc_secret;
  return word === "unset" || word === "malformed" ? word : undefined;
}

/** The closed word of a refusal (`rawBody.code`), when the Worker sent one. */
export function oidcErrorCode(error: unknown): string | undefined {
  if (!(error instanceof ApiError)) return undefined;
  const body = error.rawBody as { code?: unknown } | undefined;
  return typeof body?.code === "string" ? body.code : undefined;
}
