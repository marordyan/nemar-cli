/**
 * Admin routes: the OpenID Connect provider's client registry and signing keys (epic #2014 phase
 * #2016; ADR 0119, decision 8). Owner role, behind `oidcSurface`.
 *
 *   POST /admin/oidc/clients                           register a client; its secret is shown once
 *   GET  /admin/oidc/clients                           every client
 *   GET  /admin/oidc/clients/:client_id                one client
 *   POST /admin/oidc/clients/:client_id/rotate-secret  a new secret; `graceHours` (default 24)
 *                                                      keeps the old one valid for that long
 *   POST /admin/oidc/clients/:client_id/disable        cut a client off: the status, and in the same
 *                                                      batch every token, grant and unused code it holds
 *   GET  /admin/oidc/keys                              the signing keys, never their private half
 *   POST /admin/oidc/keys/rotate                       make the first keys, or rotate them
 *   POST /admin/oidc/keys/:kid/revoke                  withdraw a retired key from the key set
 *   POST /admin/oidc/accounts/:id/end                  end an account's grants at every client and queue
 *                                                      the logouts (the manual merge of ADR 0043, and the
 *                                                      incident tool)
 *   GET  /admin/oidc/logout-deliveries                 the back-channel logouts owed to clients and what
 *                                                      became of each; `?status=` and `?limit=`
 *
 * WHO AND WHERE. `ownerMiddleware` first, so a caller is told what they are (401, 403) whether or not
 * the surface exists; then `ownerOidcSurface` (`oidcSurface`, plus the word that says whether
 * `OIDC_SECRET` is `unset` or `malformed`), which makes every route 404 unless the provider is on
 * (`OIDC_SECRET` in the `nmsso-` form), the request is on the issuer's host and the path is not under the legacy `/nemar`
 * mount. Both are one `use` for the whole prefix, so a route added under `/oidc/` cannot forget
 * either; `test/oidc-admin-routes.test.ts` walks the router's own table to hold it to that.
 *
 * WHAT IS RETURNED. A secret appears once, in the answer that creates or rotates it, with
 * `Cache-Control: no-store`; no hash, no private JSON Web Key and no ciphertext is returned by any
 * route. A refusal is `{ error, code }` (the words are `OIDC_ADMIN_ERROR_CODES`) and names the field
 * and never echoes what was sent. The audit rows hold the shape of an act and none of its content.
 * Nothing here sends mail, calls GitHub or reaches a person.
 *
 * REQUEST BODIES are checked by the contract's lenient zod shapes, and an unknown field is refused by
 * name here, because a closed schema is not allowed under `shared/contract/` (a released CLI parses
 * those files).
 */

import type { Context, MiddlewareHandler } from "hono";
import type { ZodTypeAny, z } from "zod";
import {
  OIDC_ACCOUNT_END_FIELDS,
  OIDC_CLIENT_CREATE_FIELDS,
  OIDC_CLIENT_ROTATE_FIELDS,
  OIDC_KEYS_ROTATE_FIELDS,
  type OidcAdminErrorCode,
  oidcAccountEndRequestSchema,
  oidcClientCreateRequestSchema,
  oidcClientRotateRequestSchema,
  oidcKeysRotateRequestSchema,
} from "../../../../shared/contract/oidc-admin";
import {
  OIDC_ACCOUNT_END_REASONS,
  OIDC_CLIENT_ID_HEX_LENGTH,
  OIDC_CLIENT_ID_PREFIX,
  OIDC_FORCE_MIN_NEXT_AGE_MINUTES,
  OIDC_KEY_MIN_NEXT_AGE_HOURS,
  OIDC_KID_HEX_LENGTH,
  OIDC_LOGOUT_STATUSES,
  type OidcEndReason,
  isOidcClientId,
  isOidcKid,
  isOidcLogoutStatus,
} from "../../../../shared/oidc";
import { auditLogStatement } from "../../db/audit-log";
import { notFoundBody } from "../../lib/not-found";
import { ownerMiddleware } from "../../middleware/auth";
import { oidcEndStatements } from "../../services/oidc-cascade";
import {
  createClient,
  disableClient,
  getClient,
  listClients,
  rotateClientSecret,
} from "../../services/oidc-clients";
import { oidcSecretStatus, onIssuerHost } from "../../services/oidc-config";
import { listSigningKeys, revokeSigningKey, rotateSigningKeys } from "../../services/oidc-keys";
import { backgroundOf, deferLogoutDelivery } from "../../services/oidc-logout";
import { COUNT_DELIVERIES_SQL, LIST_DELIVERIES_SQL } from "../../services/oidc-logout-store";
import type { Bindings, Variables } from "../../types/bindings";
import { oidcSurface } from "../oidc-discovery";
import type { AdminRouter } from "./shared";

type Ctx = Context<{ Bindings: Bindings; Variables: Variables }>;

function refusal(
  c: Ctx,
  status: 400 | 404 | 409,
  code: OidcAdminErrorCode,
  message: string,
  extra: Record<string, unknown> = {},
) {
  return c.json({ error: message, code, ...extra }, status);
}

/** A field name that is safe to say back: short and plain. Anything else is "?". */
const sayable = (key: string): string => (/^[A-Za-z0-9_.-]{1,40}$/.test(key) ? key : "?");

type Parsed<S extends ZodTypeAny> =
  | { ok: true; value: z.infer<S> }
  | { ok: false; response: Response };

/**
 * Read a JSON object body, refuse an unknown field by name, and check the rest against the
 * contract's shape. An empty body is `{}`, so a route whose fields are all optional takes none, and
 * one with required fields refuses by naming them. The refusal names fields and never echoes a value.
 */
async function parseBody<S extends ZodTypeAny>(
  c: Ctx,
  schema: S,
  fields: readonly string[],
): Promise<Parsed<S>> {
  const bad = (message: string): Parsed<S> => ({
    ok: false,
    response: refusal(c, 400, "invalid_body", `The request body is not valid: ${message}`),
  });
  const text = await c.req.text();
  let body: unknown;
  if (text.trim() === "") {
    body = {};
  } else {
    try {
      body = JSON.parse(text);
    } catch {
      return bad("it is not JSON.");
    }
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return bad("a JSON object is required.");
  }
  const unknown = Object.keys(body).filter((k) => !fields.includes(k));
  if (unknown.length > 0) {
    return bad(`this route does not take: ${unknown.slice(0, 5).map(sayable).join(", ")}.`);
  }
  const result = schema.safeParse(body);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.map(String).join(".") || "body"}: ${i.message}`);
    return bad(issues.join("; "));
  }
  return { ok: true, value: result.data };
}

/** The client id of the path, or the refusal for one that is not an id. */
function clientIdParam(c: Ctx): { id: string } | { response: Response } {
  const id = c.req.param("client_id") ?? "";
  if (!isOidcClientId(id)) {
    return {
      response: refusal(
        c,
        400,
        "invalid_client_id",
        `That is not a client id (${OIDC_CLIENT_ID_PREFIX} and ${OIDC_CLIENT_ID_HEX_LENGTH} lowercase hex characters).`,
      ),
    };
  }
  return { id };
}

/**
 * End an account's grants at every client, for `reason`: the owner's command for the manual merge of
 * ADR 0043 (the loser of a merge stops being a person, and its grants end; the winner's are
 * untouched) and the tool for an incident. One batch: the logouts are queued from the live grants,
 * then the tokens and grants end and the unused codes go, and one audit row records the act, by the
 * reason and the account id and nothing else.
 *
 * It ends ONLY the OpenID Connect holdings: it does not revoke the account, its keys or its sessions,
 * which are other paths' (`finalizeRevocation`, the soft delete). It does not need the account to be
 * active, and an account with nothing to end answers zeros: ending is idempotent. The counts are the
 * rows each statement changed, read by the position `oidcEndStatements` promises.
 */
async function endAccount(c: Ctx, userId: number, reason: OidcEndReason): Promise<Response> {
  const db = c.env.DB;
  const account = await db.prepare("SELECT id FROM users WHERE id = ?").bind(userId).first();
  if (!account) return refusal(c, 404, "user_not_found", "There is no account with that id.");
  const results = await db.batch([
    ...oidcEndStatements(userId, reason).map((s) => db.prepare(s.sql).bind(...s.binds)),
    auditLogStatement(db, {
      userId: c.get("user").id,
      action: "oidc.account.end",
      resourceType: "user",
      resourceId: String(userId),
      details: JSON.stringify({ reason }),
    }),
  ]);
  deferLogoutDelivery(c.env, userId, backgroundOf(c));
  return c.json({
    user_id: userId,
    reason,
    logouts_queued: results[0]?.meta?.changes ?? 0,
    tokens_ended: results[1]?.meta?.changes ?? 0,
    grants_ended: results[2]?.meta?.changes ?? 0,
    codes_deleted: results[3]?.meta?.changes ?? 0,
  });
}

/**
 * `oidcSurface` for a caller who has already proved they are the owner. The answer is the same 404
 * with ONE extra field, `oidc_secret`, set to `unset` or `malformed` (`OIDC_SECRET` is absent, or
 * is set but is not an `nmsso-` secret of 32 characters or more), and only when the request is
 * otherwise on the surface (the issuer's host, off the legacy mount), so the owner is told which
 * word to fix and the other 404s stay byte for byte the unrouted one. It never carries the value,
 * its length or any part of it. `Not Found` and `message` are still there, so an older CLI treats
 * it as it always did.
 */
const ownerOidcSurface: MiddlewareHandler = async (c, next) => {
  const state = oidcSecretStatus(c.env);
  if (state !== "ok" && onIssuerHost(c.env, c.req.url, c.req.path)) {
    return c.json({ ...notFoundBody(c.req.method, c.req.path), oidc_secret: state }, 404, {
      "Cache-Control": "no-store",
    });
  }
  return oidcSurface(c, next);
};

export function registerOidcAdminRoutes(admin: AdminRouter): void {
  admin.use("/oidc/*", ownerMiddleware, ownerOidcSurface, async (c, next) => {
    await next();
    // A secret is in some of these answers; none of them is for a shared cache.
    c.res.headers.set("Cache-Control", "no-store");
  });

  admin.post("/oidc/clients", async (c) => {
    const parsed = await parseBody(c, oidcClientCreateRequestSchema, OIDC_CLIENT_CREATE_FIELDS);
    if (!parsed.ok) return parsed.response;
    const result = await createClient(c.env, parsed.value, c.get("user").id);
    if (!result.ok) {
      // A name that is taken is a conflict with what exists, not a malformed request.
      const status = result.refusal.code === "client_name_taken" ? 409 : 400;
      return refusal(c, status, result.refusal.code, result.refusal.message, {
        ...(result.refusal.field ? { field: result.refusal.field } : {}),
      });
    }
    return c.json({ client: result.client, client_secret: result.secret }, 201);
  });

  admin.get("/oidc/clients", async (c) => {
    return c.json({ clients: await listClients(c.env.DB) });
  });

  admin.get("/oidc/clients/:client_id", async (c) => {
    const id = clientIdParam(c);
    if ("response" in id) return id.response;
    const client = await getClient(c.env.DB, id.id);
    if (!client) return refusal(c, 404, "client_not_found", "There is no client with that id.");
    return c.json({ client });
  });

  admin.post("/oidc/clients/:client_id/rotate-secret", async (c) => {
    const id = clientIdParam(c);
    if ("response" in id) return id.response;
    const parsed = await parseBody(c, oidcClientRotateRequestSchema, OIDC_CLIENT_ROTATE_FIELDS);
    if (!parsed.ok) return parsed.response;
    const result = await rotateClientSecret(
      c.env,
      id.id,
      parsed.value.graceHours,
      c.get("user").id,
    );
    if (!result.ok) {
      return result.code === "client_not_found"
        ? refusal(c, 404, "client_not_found", "There is no client with that id.")
        : refusal(
            c,
            409,
            "client_disabled",
            "That client is disabled; its secret cannot be rotated.",
          );
    }
    return c.json({
      client: result.client,
      client_secret: result.secret,
      grace_hours: result.graceHours,
    });
  });

  admin.post("/oidc/clients/:client_id/disable", async (c) => {
    const id = clientIdParam(c);
    if ("response" in id) return id.response;
    const result = await disableClient(c.env, id.id, c.get("user").id);
    if (!result.ok) return refusal(c, 404, "client_not_found", "There is no client with that id.");
    return c.json({ client: result.client, changed: result.changed, revoked: result.revoked });
  });

  admin.get("/oidc/logout-deliveries", async (c) => {
    const status = c.req.query("status");
    if (status !== undefined && !isOidcLogoutStatus(status)) {
      return refusal(
        c,
        400,
        "invalid_status",
        `status must be one of: ${OIDC_LOGOUT_STATUSES.join(", ")}.`,
      );
    }
    const limitText = c.req.query("limit");
    if (limitText !== undefined && !/^[1-9][0-9]{0,2}$/.test(limitText)) {
      return refusal(c, 400, "invalid_body", "limit must be a whole number from 1 to 500.");
    }
    const limit = limitText === undefined ? 100 : Number(limitText);
    if (limit > 500) {
      return refusal(c, 400, "invalid_body", "limit must be a whole number from 1 to 500.");
    }
    const db = c.env.DB;
    const [rows, tallies] = await Promise.all([
      db
        .prepare(LIST_DELIVERIES_SQL)
        .bind(status ?? null, status ?? null, limit)
        .all(),
      db.prepare(COUNT_DELIVERIES_SQL).all<{ status: string; n: number }>(),
    ]);
    // Every status is present, so a reader never has to tell "none" from "not reported".
    const counts: Record<string, number> = Object.fromEntries(
      OIDC_LOGOUT_STATUSES.map((s) => [s, 0]),
    );
    for (const t of tallies.results ?? []) counts[t.status] = t.n;
    return c.json({ deliveries: rows.results ?? [], counts });
  });

  admin.post("/oidc/accounts/:id/end", async (c) => {
    const raw = c.req.param("id") ?? "";
    if (!/^[1-9][0-9]{0,15}$/.test(raw)) {
      return refusal(
        c,
        400,
        "invalid_user_id",
        "That is not an account id (a whole number from 1).",
      );
    }
    const parsed = await parseBody(c, oidcAccountEndRequestSchema, OIDC_ACCOUNT_END_FIELDS);
    if (!parsed.ok) return parsed.response;
    const reason = OIDC_ACCOUNT_END_REASONS[parsed.value.reason];
    return endAccount(c, Number(raw), reason);
  });

  admin.get("/oidc/keys", async (c) => {
    return c.json({ keys: await listSigningKeys(c.env.DB) });
  });

  admin.post("/oidc/keys/rotate", async (c) => {
    const parsed = await parseBody(c, oidcKeysRotateRequestSchema, OIDC_KEYS_ROTATE_FIELDS);
    if (!parsed.ok) return parsed.response;
    const result = await rotateSigningKeys(c.env, {
      force: parsed.value.force === true,
      emergency: parsed.value.emergency === true,
      actorId: c.get("user").id,
    });
    if (result.ok) return c.json({ action: result.action, keys: result.keys });
    if (result.code === "forced_too_early") {
      return refusal(
        c,
        409,
        "rotation_next_too_new",
        `The next key was published under ${OIDC_FORCE_MIN_NEXT_AGE_MINUTES} minutes ago. A client may not have it in the key set it cached, so tokens signed with it can fail verification there for about five minutes. Wait, or say it is an emergency.`,
      );
    }
    if (result.code === "key_unreadable") {
      return refusal(
        c,
        409,
        "key_unreadable",
        "The key about to sign cannot be read: it was encrypted under a different OIDC_SECRET, so the rotation was not done.",
      );
    }
    if (result.code === "too_early") {
      return refusal(
        c,
        409,
        "rotation_too_early",
        `The next key is not ${OIDC_KEY_MIN_NEXT_AGE_HOURS} hours old yet; it may become current at ${result.promotable_at} UTC. Use --force to rotate now.`,
        { promotable_at: result.promotable_at },
      );
    }
    return refusal(
      c,
      409,
      "rotation_conflict",
      "The keys changed while this rotation ran; read them again.",
    );
  });

  admin.post("/oidc/keys/:kid/revoke", async (c) => {
    const kid = c.req.param("kid") ?? "";
    if (!isOidcKid(kid)) {
      return refusal(
        c,
        400,
        "invalid_kid",
        `That is not a key id (${OIDC_KID_HEX_LENGTH} lowercase hex characters).`,
      );
    }
    const result = await revokeSigningKey(c.env, kid, c.get("user").id);
    if (result.ok) return c.json({ key: result.key, changed: result.changed });
    if (result.code === "key_not_found") {
      return refusal(c, 404, "key_not_found", "There is no signing key with that id.");
    }
    return refusal(
      c,
      409,
      "key_not_revocable",
      "Only a retired key can be revoked. Rotate the keys first, then revoke the key once it is retired.",
    );
  });
}
