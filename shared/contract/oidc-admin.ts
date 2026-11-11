/**
 * The wire shapes of the OpenID Connect provider's owner routes (epic #2014 phase #2016; ADR 0119,
 * decision 8):
 *
 *   POST /admin/oidc/clients                          register a client; shows its secret once
 *   GET  /admin/oidc/clients                          every client
 *   GET  /admin/oidc/clients/:client_id               one client
 *   POST /admin/oidc/clients/:client_id/rotate-secret a new secret, the old one valid for a grace
 *   POST /admin/oidc/clients/:client_id/disable       cut a client off
 *   GET  /admin/oidc/keys                             the signing keys, never their private half
 *   POST /admin/oidc/keys/rotate                      make the first keys, or rotate them
 *   POST /admin/oidc/keys/:kid/revoke                 withdraw a retired key from the key set
 *   POST /admin/oidc/accounts/:id/end                 end an account's grants at every client (#2019)
 *   GET  /admin/oidc/logout-deliveries                the back-channel logouts owed to clients (#2019)
 *
 * Owner role, on the issuer's host only. A refusal is `{ error: <sentence>, code: <word> }`; the
 * words are {@link OIDC_ADMIN_ERROR_CODES} and are the API.
 *
 * LENIENT ON PURPOSE. A CLI that was released before a field existed parses these answers, so the
 * response shapes pass unknown keys through and no schema here is closed (the contract tests
 * refuse a closed one). The request shapes are lenient for the same reason, and the Worker refuses
 * an unknown request field at the route (`code: invalid_body`), which a zod schema would do by
 * being closed, and which the contract's no-closed-schema rule does not allow here.
 *
 * Words the Worker may add are plain `string`s in a response (a sign-in rule, a status), so a new
 * word is not a parse failure in an older CLI. The request shapes check the words the owner types,
 * against the same lists the Worker uses.
 */

import { z } from "zod";
import {
  OIDC_ACCOUNT_END_NAMES,
  OIDC_AUDIENCE_MAX_LENGTH,
  OIDC_CLIENT_NAME_MAX_LENGTH,
  OIDC_CONSENT_MODES,
  OIDC_GRANTS,
  OIDC_LOGOUT_STATUSES,
  OIDC_MAX_INTROSPECTION_AUDIENCES,
  OIDC_MAX_REDIRECT_URIS,
  OIDC_SCOPE_NAMES,
  OIDC_SECRET_GRACE_HOURS_MAX,
  OIDC_SIGN_IN_RULES,
  OIDC_URI_MAX_LENGTH,
  isOidcConsentMode,
  isOidcSignInRule,
} from "../oidc.js";

/** The words an owner route refuses with, in `code`. */
export const OIDC_ADMIN_ERROR_CODES = [
  "invalid_body",
  "invalid_client_id",
  "invalid_name",
  "invalid_redirect_uri",
  "duplicate_redirect_uri",
  "invalid_scope",
  "invalid_grant",
  "scope_grant_mismatch",
  "first_party_not_allowed",
  "invalid_logout_uri",
  "invalid_audience",
  "client_not_found",
  "client_disabled",
  "client_name_taken",
  "rotation_too_early",
  "rotation_next_too_new",
  "rotation_conflict",
  "key_unreadable",
  "invalid_kid",
  "key_not_found",
  "key_not_revocable",
  "invalid_user_id",
  "user_not_found",
  "invalid_status",
] as const;

export type OidcAdminErrorCode = (typeof OIDC_ADMIN_ERROR_CODES)[number];

/** A string that must be one of `words`, said without echoing what was sent. */
const oneOf = <T extends string>(
  words: readonly T[],
  guard: (v: unknown) => v is T,
  what: string,
) =>
  z.string().refine((v): v is T => guard(v), {
    message: `${what} must be one of: ${words.join(", ")}`,
  });

/** A cap: a whole number, zero or more, or null for none. */
const cap = z.number().int().min(0).nullable().optional();

/** The body of `POST /admin/oidc/clients`. */
export const oidcClientCreateRequestSchema = z.object({
  name: z.string().min(1).max(OIDC_CLIENT_NAME_MAX_LENGTH),
  redirect_uris: z
    .array(z.string().min(1).max(OIDC_URI_MAX_LENGTH))
    .min(1)
    .max(OIDC_MAX_REDIRECT_URIS),
  allowed_scopes: z.array(z.string()).min(1).max(OIDC_SCOPE_NAMES.length),
  allowed_grants: z.array(z.string()).min(1).max(OIDC_GRANTS.length),
  sign_in_rule: oneOf(OIDC_SIGN_IN_RULES, isOidcSignInRule, "sign_in_rule"),
  first_party: z.boolean().optional(),
  consent_mode: oneOf(OIDC_CONSENT_MODES, isOidcConsentMode, "consent_mode").optional(),
  backchannel_logout_uri: z.string().min(1).max(OIDC_URI_MAX_LENGTH).nullable().optional(),
  audience: z.string().min(1).max(OIDC_AUDIENCE_MAX_LENGTH),
  introspection_audiences: z
    .array(z.string().min(1).max(OIDC_AUDIENCE_MAX_LENGTH))
    .max(OIDC_MAX_INTROSPECTION_AUDIENCES)
    .optional(),
  cap_open_reservations: cap,
  cap_su_per_day: cap,
});
export type OidcClientCreateRequest = z.infer<typeof oidcClientCreateRequestSchema>;

/** The field names the create route accepts; anything else is refused by name. */
export const OIDC_CLIENT_CREATE_FIELDS: readonly string[] = Object.keys(
  oidcClientCreateRequestSchema.shape,
);

/** The body of `POST /admin/oidc/clients/:client_id/rotate-secret`; an empty body is the default. */
export const oidcClientRotateRequestSchema = z.object({
  graceHours: z.number().int().min(0).max(OIDC_SECRET_GRACE_HOURS_MAX).optional(),
});
export const OIDC_CLIENT_ROTATE_FIELDS: readonly string[] = Object.keys(
  oidcClientRotateRequestSchema.shape,
);

/** The body of `POST /admin/oidc/keys/rotate`; an empty body is not forced. */
export const oidcKeysRotateRequestSchema = z.object({
  force: z.boolean().optional(),
  /** With `force`: rotate even though the next key was published under 6 minutes ago. */
  emergency: z.boolean().optional(),
});
export const OIDC_KEYS_ROTATE_FIELDS: readonly string[] = Object.keys(
  oidcKeysRotateRequestSchema.shape,
);

/**
 * One client as the owner sees it. NO secret and NO hash: the secret is in the answer that creates
 * or rotates it and nowhere else, and a hash is returned by nothing.
 * `previous_secret_expires_at` is set only while a rotation's grace is still running.
 */
export const oidcClientViewSchema = z
  .object({
    client_id: z.string(),
    name: z.string(),
    redirect_uris: z.array(z.string()),
    allowed_scopes: z.array(z.string()),
    allowed_grants: z.array(z.string()),
    sign_in_rule: z.string(),
    first_party: z.boolean(),
    consent_mode: z.string(),
    backchannel_logout_uri: z.string().nullable(),
    audience: z.string(),
    introspection_audiences: z.array(z.string()),
    cap_open_reservations: z.number().nullable(),
    cap_su_per_day: z.number().nullable(),
    status: z.string(),
    disabled_at: z.string().nullable(),
    previous_secret_expires_at: z.string().nullable(),
    created_by: z.number(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .passthrough();
export type OidcClientView = z.infer<typeof oidcClientViewSchema>;

/** `POST /admin/oidc/clients`: 201, the client and its secret, shown this once. */
export const oidcClientCreateResponseSchema = z
  .object({ client: oidcClientViewSchema, client_secret: z.string() })
  .passthrough();
export type OidcClientCreateResponse = z.infer<typeof oidcClientCreateResponseSchema>;

/** `GET /admin/oidc/clients`. */
export const oidcClientListResponseSchema = z
  .object({ clients: z.array(oidcClientViewSchema) })
  .passthrough();
export type OidcClientListResponse = z.infer<typeof oidcClientListResponseSchema>;

/** `GET /admin/oidc/clients/:client_id`. */
export const oidcClientShowResponseSchema = z
  .object({ client: oidcClientViewSchema })
  .passthrough();
export type OidcClientShowResponse = z.infer<typeof oidcClientShowResponseSchema>;

/** `POST /admin/oidc/clients/:client_id/rotate-secret`: the new secret, shown this once. */
export const oidcClientRotateResponseSchema = z
  .object({
    client: oidcClientViewSchema,
    client_secret: z.string(),
    grace_hours: z.number(),
  })
  .passthrough();
export type OidcClientRotateResponse = z.infer<typeof oidcClientRotateResponseSchema>;

/**
 * `POST /admin/oidc/clients/:client_id/disable`: `changed` is false when it already was. `revoked`
 * counts what the same batch took from the client (its tokens, its grants and its unused codes); it
 * is optional, so a command line from before the revocation reads the answer of a Worker after it,
 * and the reverse.
 */
export const oidcClientDisableResponseSchema = z
  .object({
    client: oidcClientViewSchema,
    changed: z.boolean(),
    revoked: z
      .object({ tokens: z.number(), grants: z.number(), codes: z.number() })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type OidcClientDisableResponse = z.infer<typeof oidcClientDisableResponseSchema>;

/** One signing key. There is no private member on this shape, by construction. */
export const oidcKeyViewSchema = z
  .object({
    kid: z.string(),
    alg: z.string(),
    state: z.string(),
    created_at: z.string(),
    promoted_at: z.string().nullable(),
    retired_at: z.string().nullable(),
    // Optional: a Worker that predates the revoked state does not send it.
    revoked_at: z.string().nullable().optional(),
    promotable_at: z.string().nullable(),
  })
  .passthrough();
export type OidcKeyView = z.infer<typeof oidcKeyViewSchema>;

/** `GET /admin/oidc/keys`. */
export const oidcKeysResponseSchema = z.object({ keys: z.array(oidcKeyViewSchema) }).passthrough();
export type OidcKeysResponse = z.infer<typeof oidcKeysResponseSchema>;

/** `POST /admin/oidc/keys/rotate`: what happened, and the keys afterwards. */
export const oidcKeysRotateResponseSchema = z
  .object({ action: z.string(), keys: z.array(oidcKeyViewSchema) })
  .passthrough();
export type OidcKeysRotateResponse = z.infer<typeof oidcKeysRotateResponseSchema>;

/** `POST /admin/oidc/keys/:kid/revoke`: `changed` is false when the key already was revoked. */
export const oidcKeyRevokeResponseSchema = z
  .object({ key: oidcKeyViewSchema, changed: z.boolean() })
  .passthrough();
export type OidcKeyRevokeResponse = z.infer<typeof oidcKeyRevokeResponseSchema>;

/** The body of `POST /admin/oidc/accounts/:id/end`: why, as the owner names it. */
export const oidcAccountEndRequestSchema = z.object({
  // The message names the words and never the value sent: an unknown reason is not echoed back.
  reason: z.enum(OIDC_ACCOUNT_END_NAMES, {
    errorMap: () => ({ message: `reason must be one of: ${OIDC_ACCOUNT_END_NAMES.join(", ")}` }),
  }),
});
export const OIDC_ACCOUNT_END_FIELDS: readonly string[] = Object.keys(
  oidcAccountEndRequestSchema.shape,
);

/**
 * `POST /admin/oidc/accounts/:id/end`: what the one batch ended. `reason` is the word recorded on the
 * revoked tokens and the queued deliveries (`account_merged` or `account_revoked`), and `logouts_queued`
 * is the number of clients that will be told: the call to each is made after the batch commits, so
 * what became of it is in the delivery listing and not here.
 */
export const oidcAccountEndResponseSchema = z
  .object({
    user_id: z.number(),
    reason: z.string(),
    grants_ended: z.number(),
    tokens_ended: z.number(),
    codes_deleted: z.number(),
    logouts_queued: z.number(),
  })
  .passthrough();
export type OidcAccountEndResponse = z.infer<typeof oidcAccountEndResponseSchema>;

/**
 * One back-channel logout owed to a client, as the owner reads it. `client_id` is the PUBLIC `oc_...`
 * id, `sub` the account's opaque subject, and `last_error_class` a fixed word, never the text of an
 * error or of the partner's answer. No token and no address: the address is on the client.
 */
export const oidcLogoutDeliveryViewSchema = z
  .object({
    id: z.number(),
    client_id: z.string().nullable(),
    sub: z.string(),
    reason: z.string(),
    status: z.string(),
    attempts: z.number(),
    next_attempt_at: z.string().nullable(),
    last_status: z.number().nullable(),
    last_error_class: z.string().nullable(),
    jti: z.string().nullable(),
    created_at: z.string(),
    sent_at: z.string().nullable(),
  })
  .passthrough();
export type OidcLogoutDeliveryView = z.infer<typeof oidcLogoutDeliveryViewSchema>;

/** `GET /admin/oidc/logout-deliveries?status=&limit=`: newest first. */
export const oidcLogoutDeliveriesResponseSchema = z
  .object({
    deliveries: z.array(oidcLogoutDeliveryViewSchema),
    /** How many deliveries of each status exist, whatever the filter and the limit. */
    counts: z.record(z.number()),
  })
  .passthrough();
export type OidcLogoutDeliveriesResponse = z.infer<typeof oidcLogoutDeliveriesResponseSchema>;

/** The statuses `?status=` accepts, for a command line that offers them as choices. */
export const OIDC_LOGOUT_DELIVERY_STATUS_FILTERS: readonly string[] = OIDC_LOGOUT_STATUSES;
