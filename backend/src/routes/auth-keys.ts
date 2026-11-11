/**
 * Named API key routes (epic #1272 phase 1, #1281; ADR 0047), mounted under
 * the same `/auth` prefix as the other auth routes.
 *
 *   GET    /auth/keys          - list this account's live keys
 *   POST   /auth/keys          - mint a new named key (the paste-key
 *                                 fallback for a headless host that cannot
 *                                 run the device flow's browser half)
 *   DELETE /auth/keys/:id      - revoke a key by row id
 *   DELETE /auth/keys/current  - revoke the key presenting THIS request
 *                                (bearer path only)
 *
 * Every route accepts either credential `resolveActingAccount` accepts (the
 * CLI's bearer token, or the dashboard's session cookie, #1266, ADR
 * 0044) -- but goes one check further than that helper on the cookie half:
 * `resolveActingAccount` deliberately ADMITS a `pending` account on cookies,
 * because the email-change flow needs that (ADR 0044). A pending account
 * holds no API key and must not mint one here (ADR 0040), so this file adds
 * the active-status gate back for its own routes, `inactiveAccountBody`
 * shaped like the bearer path already refuses it.
 */

import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import type {
  ApiKeyCreateResponse,
  ApiKeyListResponse,
  ApiKeySummary,
} from "../../../shared/contract/device-auth.js";
import { auditLogStatement } from "../db/audit-log";
import { type ActingAccount, resolveActingAccount } from "../middleware/auth";
import { webSessionMiddleware } from "../middleware/webSession";
import { inactiveAccountBody, isActiveAccountStatus } from "../services/account-tier";
import {
  HTTP_STATUS_FOR_REFUSAL,
  KEY_BY_HASH_SQL,
  KEY_LIST_SQL,
  KEY_MINT_SQL,
  KEY_REVOKE_BY_HASH_SQL,
  KEY_REVOKE_BY_ID_SQL,
  KEY_ROW_BY_HASH_FOR_USER_SQL,
  KEY_ROW_BY_ID_FOR_USER_SQL,
  accountRefusal,
  buildApiKeySummary,
  deviceRefusal,
  normalizeMachineName,
  readDeviceAuthAccount,
} from "../services/device-auth";
import { revokeDocsCredentials } from "../services/docs-auth";
import { generateApiKey, hashApiKey } from "../services/token";
import type { Bindings, Variables } from "../types/bindings";

export const authKeysRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Every response here is account-scoped and can carry a freshly minted
// secret (POST) or the current set of live key rows (GET) -- never a
// document a shared HTTP cache should reuse across callers.
authKeysRoutes.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});

type KeysContext = Context<{ Bindings: Bindings; Variables: Variables }>;

/**
 * `resolveActingAccount` plus the active-status gate this file needs on the
 * cookie half (see header comment). The bearer half already carries this
 * gate inside `resolveBearerUser`, so re-checking it here would be a no-op
 * for that path -- but it costs nothing to express it once for both.
 */
async function resolveKeysActor(
  c: KeysContext,
): Promise<{ ok: true; actor: ActingAccount } | { ok: false; response: Response }> {
  const resolved = await resolveActingAccount(c);
  if (!resolved.ok) return resolved;
  if (resolved.actor.via === "cookie") {
    const status = c.var.webUser?.status;
    if (!status || !isActiveAccountStatus(status)) {
      return { ok: false, response: c.json(inactiveAccountBody(status ?? "pending"), 403) };
    }
  }
  return resolved;
}

/** SHA-256 of the presenting bearer token, or `null` on the cookie path (a
 *  cookie authenticates no key, so nothing can be "current" for it). */
async function currentKeyHash(c: KeysContext): Promise<string | null> {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const raw = authHeader.substring(7);
  if (!raw || raw.length < 32) return null;
  return hashApiKey(raw);
}

function keyNotFound(c: { json: (body: unknown, status: number) => Response }): Response {
  return c.json(deviceRefusal("key_not_found"), HTTP_STATUS_FOR_REFUSAL.key_not_found);
}

// --------------------------------------------------------------------------
// list
// --------------------------------------------------------------------------

authKeysRoutes.get("/keys", webSessionMiddleware, async (c) => {
  const resolved = await resolveKeysActor(c);
  if (!resolved.ok) return resolved.response;
  const actor = resolved.actor;

  const db = c.env.DB;
  const current = await currentKeyHash(c);
  const rows = await db.prepare(KEY_LIST_SQL).bind(actor.id).all<{
    id: number;
    name: string | null;
    prefix: string;
    created_at: string;
    last_used_at: string | null;
    api_key_hash: string;
  }>();

  const keys: ApiKeySummary[] = rows.results.map((r) =>
    // Never true on the cookie path: `current` is null there, so this
    // comparison can never match a stored hash.
    buildApiKeySummary(r, current !== null && current === r.api_key_hash),
  );
  const body: ApiKeyListResponse = { keys };
  return c.json(body);
});

// --------------------------------------------------------------------------
// mint
// --------------------------------------------------------------------------

const keyCreateSchema = z.object({ name: z.string().trim().min(1).max(200) });

authKeysRoutes.post(
  "/keys",
  webSessionMiddleware,
  zValidator("json", keyCreateSchema),
  async (c) => {
    const resolved = await resolveKeysActor(c);
    if (!resolved.ok) return resolved.response;
    const actor = resolved.actor;

    const db = c.env.DB;

    // `resolveKeysActor` already refused a non-active status AT CALL TIME.
    // This re-reads the account and runs the SAME `accountRefusal` the
    // device mint answers with, because it covers two gates that check does
    // not: `identity_conflict`, and (epic #1272 phase 4, #1284; ADR 0048)
    // `account_kind` -- a `service`/`test` account must self-mint no key
    // either, the same `service_account` reason the device flow refuses it
    // with. pending/revoked are refused above already, but routing them
    // through this same map (rather than a second, hand-written refusal)
    // means every refusal in this route answers with the status
    // `HTTP_STATUS_FOR_REFUSAL` names for it.
    const account = await readDeviceAuthAccount(db, actor.id);
    const accountIssue = accountRefusal(account);
    if (accountIssue) {
      return c.json(deviceRefusal(accountIssue), HTTP_STATUS_FOR_REFUSAL[accountIssue]);
    }

    // The schema already refused an empty-after-trim name with a 400
    // (`.trim().min(1)`), so this normalization is purely cosmetic from
    // here: strip control characters, collapse internal whitespace, and
    // cap at 64 chars -- never a silent "unnamed machine" substitution for
    // a name the caller actually supplied.
    const name = normalizeMachineName(c.req.valid("json").name);
    const { apiKey, apiKeyPrefix } = generateApiKey();
    const hash = await hashApiKey(apiKey);

    // The read-back runs INSIDE the same batch as the mint, for the same
    // reason `/auth/device/token` does (routes/auth-device.ts): D1 (and the
    // `realD1` test double) run a batch as one transaction, so if anything
    // after it throws, the mint was never committed -- there is no key the
    // caller was never told about.
    const results = await db.batch<Record<string, unknown>>([
      db.prepare(KEY_MINT_SQL).bind(actor.id, hash, apiKeyPrefix, name, actor.id),
      db.prepare(KEY_BY_HASH_SQL).bind(hash),
    ]);
    const mintResult = results[0];
    if ((mintResult?.meta?.changes ?? 0) === 0) {
      return c.json(deviceRefusal("too_many_keys"), HTTP_STATUS_FOR_REFUSAL.too_many_keys);
    }

    const keyRow = results[1]?.results?.[0] as
      | {
          id: number;
          name: string | null;
          prefix: string;
          created_at: string;
          last_used_at: string | null;
        }
      | undefined;
    if (!keyRow) {
      // Impossible inside one committed transaction: the INSERT just wrote
      // the row this SELECT reads back by the very hash it inserted.
      console.error(
        `[auth-keys] canary: KEY_MINT_SQL committed for user_id=${actor.id} but its read-back inside the same batch came back empty`,
      );
      throw new Error("key mint committed but its read-back was empty");
    }

    await auditLogStatement(db, {
      userId: actor.id,
      action: "api_key_created",
      resourceType: "token",
      resourceId: String(keyRow.id),
      details: JSON.stringify({ name, via: actor.via }),
    })
      .run()
      .catch((err) => console.error("[auth-keys] failed to write api_key_created audit row", err));

    const body: ApiKeyCreateResponse = {
      api_key: apiKey,
      // A key just minted is never the one that authenticated THIS request.
      key: buildApiKeySummary(keyRow, false),
    };
    return c.json(body);
  },
);

// --------------------------------------------------------------------------
// revoke
// --------------------------------------------------------------------------

authKeysRoutes.delete("/keys/:id", webSessionMiddleware, async (c) => {
  const resolved = await resolveKeysActor(c);
  if (!resolved.ok) return resolved.response;
  const actor = resolved.actor;

  const db = c.env.DB;
  const idParam = c.req.param("id");

  if (idParam === "current") {
    // Only meaningful on the bearer path: a cookie authenticates no key, so
    // there is nothing "current" to revoke.
    if (actor.via !== "token") {
      return keyNotFound(c);
    }
    const hash = await currentKeyHash(c);
    if (!hash) {
      return keyNotFound(c);
    }

    // Read BEFORE the UPDATE, not after: the pre-read is all the audit row
    // needs, so there is no read left after the write that could turn an
    // already-committed revoke into a 500.
    const preRow = await db.prepare(KEY_ROW_BY_HASH_FOR_USER_SQL).bind(hash, actor.id).first<{
      id: number;
      name: string | null;
      prefix: string;
    }>();
    if (!preRow) {
      return keyNotFound(c);
    }

    const result = await db.prepare(KEY_REVOKE_BY_HASH_SQL).bind(hash, actor.id).run();
    // The docs credential is minted FROM an API key, so revoking the key has to
    // end it too (see revokeDocsCredentials).
    await revokeDocsCredentials(db, actor.id);
    if ((result.meta?.changes ?? 0) === 0) {
      // Lost a race between the pre-read and this UPDATE (a concurrent
      // revoke of the same key landed in between) -- the caller's desired
      // end state already holds, but answer the same "not found" a repeat
      // call would get.
      return keyNotFound(c);
    }

    await auditLogStatement(db, {
      userId: actor.id,
      action: "api_key_revoked",
      resourceType: "token",
      resourceId: String(preRow.id),
      details: JSON.stringify({
        name: preRow.name,
        prefix: preRow.prefix,
        via: actor.via,
        self: true,
      }),
    })
      .run()
      .catch((err) => console.error("[auth-keys] failed to write api_key_revoked audit row", err));
    return c.json({ ok: true });
  }

  if (!/^\d+$/.test(idParam)) {
    return keyNotFound(c);
  }
  const id = Number(idParam);
  const currentHash = await currentKeyHash(c);

  const preRow = await db.prepare(KEY_ROW_BY_ID_FOR_USER_SQL).bind(id, actor.id).first<{
    id: number;
    name: string | null;
    prefix: string;
    api_key_hash: string;
  }>();
  if (!preRow) {
    return keyNotFound(c);
  }

  const result = await db.prepare(KEY_REVOKE_BY_ID_SQL).bind(id, actor.id).run();
  // The docs credential is minted FROM an API key, so revoking the key has to
  // end it too. Run on BOTH branches: when the UPDATE changed nothing, a
  // concurrent revoke of the same key won the race, and its cascade may be the
  // one that failed; the cascade is idempotent.
  await revokeDocsCredentials(db, actor.id);
  if ((result.meta?.changes ?? 0) === 0) {
    return keyNotFound(c);
  }

  const self = currentHash !== null && preRow.api_key_hash === currentHash;
  await auditLogStatement(db, {
    userId: actor.id,
    action: "api_key_revoked",
    resourceType: "token",
    resourceId: String(preRow.id),
    details: JSON.stringify({ name: preRow.name, prefix: preRow.prefix, via: actor.via, self }),
  })
    .run()
    .catch((err) => console.error("[auth-keys] failed to write api_key_revoked audit row", err));

  return c.json({ ok: true });
});
