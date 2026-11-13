/**
 * Everything the engine reads from its environment, checked in one place: the two bases, the
 * range cache and payload limits, and the disk cache. `runEngine` uses it to start, and the
 * commands use it BEFORE starting an engine, so a bad setting is reported as the configuration
 * error it is (with the setting's name) instead of as an engine that crashed.
 */

import { type DiskCache, resolveDiskCache } from "./disk-cache.js";
import { MAX_CLIENT_PAYLOAD_BYTES } from "./frame-stream.js";
import {
  DEFAULT_RANGE_CACHE_BYTES,
  type EngineBases,
  EngineConfigError,
  resolveBases,
} from "./http.js";

/** 256 MiB, the default for `max_payload_bytes` (its own constant, not the range cache's). */
export const DEFAULT_MAX_PAYLOAD_BYTES = 256 * 1024 * 1024;
export const MAX_PAYLOAD_ENV = "NEMAR_ZARR_MAX_PAYLOAD_BYTES";
export const RANGE_CACHE_ENV = "NEMAR_ZARR_RANGE_CACHE_BYTES";

/** The hint under a configuration error, in every command that reports one. */
export const CONFIG_HINT = "Fix or unset that environment variable.";

export interface EngineConfig {
  bases: EngineBases;
  rangeCacheBytes: number;
  maxPayloadBytes: number;
  diskCache: DiskCache;
}

function envBytes(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new EngineConfigError(`${name} must be a positive integer, got ${raw}`);
  }
  if (n > max) throw new EngineConfigError(`${name} must be at most ${max} bytes, got ${raw}`);
  return n;
}

/** The engine's configuration from `env`; throws {@link EngineConfigError} naming the setting. */
export function resolveEngineConfig(
  env: Record<string, string | undefined> = process.env,
): EngineConfig {
  return {
    bases: resolveBases(env),
    rangeCacheBytes: envBytes(env, RANGE_CACHE_ENV, DEFAULT_RANGE_CACHE_BYTES),
    maxPayloadBytes: envBytes(
      env,
      MAX_PAYLOAD_ENV,
      DEFAULT_MAX_PAYLOAD_BYTES,
      MAX_CLIENT_PAYLOAD_BYTES,
    ),
    diskCache: resolveDiskCache(env),
  };
}
