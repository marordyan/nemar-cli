/**
 * Tapis tokens for the Worker (epic #2005 phase A4, #2009; ADR 0118). The template is
 * `services/github-auth.ts`: a module-scope cache, a refresh lead, ONE shared in-flight promise so
 * concurrent callers mint once, and a failed mint dropped so the next call tries afresh.
 *
 * Two strategies, chosen by configuration (`tapis/config.ts`), answer the same way
 * (`result.access_token.access_token` and `expires_in`, in seconds):
 *
 *   password  `POST /v3/oauth2/tokens` with `{ username, password, grant_type: "password" }` and no
 *             token. The token is the configured account's.
 *   service   `POST /v3/tokens` with the service credential in `X-Tapis-Token` and
 *             `{ account_type: "user", token_tenant_id, token_username, access_token_ttl }`. The token is
 *             the named user's, so each username has its own.
 *
 * The cache is keyed by strategy AND username: the configured account for `password`, the named
 * owner for `service`. A token is used until `REFRESH_LEAD_MS` before it ends (or a fifth of its
 * life, for a tenant that issues short tokens, so a short token is not refreshed on every call).
 * `invalidateTapisToken` drops one after a 401; the client then retries exactly once.
 *
 * A password, a service credential and a token are secrets: none is logged, none is in an error
 * message (errors.ts), and `mintTapisToken` is the only function that sees them besides the request.
 * Dev and production never share a credential: each Worker reads its own secrets.
 */

import { type TapisConfigured, type TapisEnv, tapisConfig } from "./config";
import { TapisError, invalidResponse } from "./errors";
import { parseJsonBody, send } from "./http";
import { TapisTokenResponseSchema } from "./schemas";

/** Refresh this long before a token ends: 5 minutes covers clock drift and a round trip. */
export const TOKEN_REFRESH_LEAD_MS = 5 * 60 * 1000;

/** The lifetime asked of a service strategy's token, in seconds. The tenant may issue less. */
export const SERVICE_TOKEN_TTL_SECONDS = 3600;

const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;

export interface TapisAuthOptions {
  /** The Tapis username a token is wanted for: used by the `service` strategy, and as the cache key. */
  owner: string;
  timeoutMs?: number;
  /** The clock, in epoch milliseconds. A test moves it; production never passes one. */
  now?: () => number;
}

export interface MintedToken {
  token: string;
  expiresInSeconds: number;
}

interface CacheEntry {
  token: string;
  /** When the token is no longer used, in epoch milliseconds (its end minus the lead). */
  refreshAt: number;
  refreshing?: Promise<string>;
}

const tokenCache: Map<string, CacheEntry> = new Map();

export function __resetTapisTokenCacheForTests(): void {
  tokenCache.clear();
}

/** The configuration, or the `unconfigured` error. Nothing is sent before this has passed. */
export function requireTapisConfig(env: TapisEnv): TapisConfigured {
  const config = tapisConfig(env);
  if (config.unconfigured) throw new TapisError("unconfigured", "configuration");
  return config;
}

/** The username a token is for: the configured account under `password`, the owner under `service`. */
function tokenUser(config: TapisConfigured, owner: string): string {
  return config.strategy === "password" ? config.username : owner;
}

function cacheKey(config: TapisConfigured, owner: string): string {
  return `${config.strategy}\u0000${tokenUser(config, owner)}`;
}

/** A token's life as the cache keeps it: its end less the lead, which is a fifth of a short life. */
function refreshAtFor(now: number, expiresInSeconds: number): number {
  const lifeMs = expiresInSeconds * 1000;
  return now + lifeMs - Math.min(TOKEN_REFRESH_LEAD_MS, Math.floor(lifeMs / 5));
}

/**
 * Ask Tapis for a token NOW, whatever the cache holds, and keep nothing. The status view uses it to
 * check the credential itself; `getTapisToken` is the cached way.
 */
export async function mintTapisToken(
  env: TapisEnv,
  options: Pick<TapisAuthOptions, "owner" | "timeoutMs">,
): Promise<MintedToken> {
  const config = requireTapisConfig(env);
  const what = "token request";
  const request: { url: string; headers: Record<string, string>; body: string } =
    config.strategy === "password"
      ? {
          url: `${config.baseUrl}/v3/oauth2/tokens`,
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            username: config.username,
            password: config.password,
            grant_type: "password",
          }),
        }
      : {
          url: `${config.baseUrl}/v3/tokens`,
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            "X-Tapis-Token": config.serviceToken,
          },
          body: JSON.stringify({
            account_type: "user",
            token_tenant_id: config.tenantId,
            token_username: options.owner,
            access_token_ttl: SERVICE_TOKEN_TTL_SECONDS,
          }),
        };
  const { status, bytes } = await send({
    ...request,
    method: "POST",
    what,
    timeoutMs: options.timeoutMs,
    maxBytes: MAX_TOKEN_RESPONSE_BYTES,
  });
  const parsed = TapisTokenResponseSchema.safeParse(parseJsonBody(bytes, what, status));
  // A token answer of the wrong shape is never turned into a token: an empty or missing one would be
  // sent, and cached, as the credential of every call that follows.
  if (!parsed.success) throw invalidResponse(what, status);
  const { access_token, expires_in } = parsed.data.result.access_token;
  return { token: access_token, expiresInSeconds: expires_in };
}

/**
 * A token for `options.owner` (or the configured account), from the cache when it is fresh. Callers
 * that arrive while one is being minted share that mint.
 */
export async function getTapisToken(env: TapisEnv, options: TapisAuthOptions): Promise<string> {
  const config = requireTapisConfig(env);
  const key = cacheKey(config, options.owner);
  const now = (options.now ?? Date.now)();
  const cached = tokenCache.get(key);
  if (cached) {
    if (cached.token !== "" && now < cached.refreshAt) return cached.token;
    if (cached.refreshing) return cached.refreshing;
  }

  const refreshing = (async () => {
    const minted = await mintTapisToken(env, options);
    tokenCache.set(key, {
      token: minted.token,
      refreshAt: refreshAtFor(now, minted.expiresInSeconds),
    });
    return minted.token;
  })();
  tokenCache.set(key, { token: "", refreshAt: 0, refreshing });
  try {
    return await refreshing;
  } catch (err) {
    // A failed mint is dropped, so the next call mints afresh and no caller is served an empty token.
    if (tokenCache.get(key)?.refreshing === refreshing) tokenCache.delete(key);
    throw err;
  }
}

/**
 * Drop the cached token for `owner`, so the next `getTapisToken` mints one, but ONLY when the cache
 * still holds the `refused` token (compare, then delete). Many callers can hold the same stale token
 * and each get a 401; the first drops it and starts a mint, and the others must find that mint (whose
 * entry has no token yet) or its fresh token, not delete them: otherwise every caller mints its own.
 */
export function invalidateTapisToken(env: TapisEnv, owner: string, refused: string): void {
  const config = tapisConfig(env);
  if (config.unconfigured) return;
  const key = cacheKey(config, owner);
  // An in-flight mint has no token yet (""), and no caller ever holds "": that is never a match.
  if (refused !== "" && tokenCache.get(key)?.token === refused) tokenCache.delete(key);
}
