/**
 * Maintenance-mode middleware
 *
 * Freezes the API during infrastructure migrations or incidents. Toggled via
 * the MAINTENANCE_MODE env var; add it to wrangler-sccn.toml [vars] (or
 * [env.dev.vars] for dev only) and redeploy to flip. Unset = "off".
 */

import type { Context, Next } from "hono";
import { COMPUTE_JOB_ID_RE } from "../../../shared/contract/compute";

import { OIDC_PUBLIC_DOCUMENT_PATHS } from "../../../shared/oidc.js";
import type { Bindings, Variables } from "../types/bindings";
import {
  type ActiveMaintenanceMode,
  type MaintenanceMode,
  isMaintenanceMode,
} from "../types/maintenance";
import { redactSecretPaths } from "./access-log";

type MaintenanceContext = Context<{ Bindings: Bindings; Variables: Variables }>;

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const ALWAYS_ALLOWED_PATHS = new Set(["/", "/health", "/notices"]);

// Discovery and the signing keys' public set live on the API host permanently (ADR 0119): a client that
// cannot fetch them during maintenance cannot validate a token it was already given. A READ of them:
// any other method of those paths is under the mode like everything else.
const PUBLIC_DOCUMENT_READS = new Set(["GET", "HEAD"]);

// Mutating routes that remain open in read-only so admins can still moderate
// (admin), GitHub webhooks can still deliver (webhooks), and a locked-out
// admin can re-authenticate (auth/login). Every other /auth mutation stays
// blocked.
const READ_ONLY_MUTATION_ALLOWLIST = ["/admin/", "/webhooks/"];
const READ_ONLY_EXACT_MUTATIONS = new Set(["/auth/login"]);

/**
 * The compute launcher's three callbacks (`POST /compute/jobs/<job id>/bundle`, `/outputs` and
 * `/outputs/complete`) stay open in read-only mode, by exact shape and for POST only: a job that is
 * already running on a cluster has no way to hold its results, and a launcher refused here would fail a
 * job that did nothing wrong and was already paid for. They write only that job's own prefix and its own
 * row, behind a per-job token. `full` still refuses them (it refuses everything), and the person's own
 * `cancel` and `links` stay blocked in read-only like any other write (round 1 of #2041).
 *
 * The pattern is anchored at `/compute` and so does not match the `/nemar/compute/...` spelling the API
 * is also mounted at (this middleware sees the full path). That is deliberate and safe: the launcher's
 * address comes from `API_BASE_URL`, which carries no prefix, so nothing calls the other spelling, and
 * a miss refuses and never opens. The `/admin/`, `/webhooks/` and `/auth/login` allowlists above have
 * the same property. If `API_BASE_URL` ever gains the prefix, widen them all together. What each mode
 * does to the rest of compute (webhooks, the observer, admin routes, crons) is in ADR 0118, item 11 of
 * the amendment of 2026-11-04 (#2010).
 */
const LAUNCHER_CALLBACK_RE = /^\/compute\/jobs\/([^/]+)\/(?:bundle|outputs|outputs\/complete)$/;

function isLauncherCallback(method: string, path: string): boolean {
  if (method !== "POST") return false;
  const match = LAUNCHER_CALLBACK_RE.exec(path);
  return match !== null && COMPUTE_JOB_ID_RE.test(match[1] ?? "");
}

// The two OpenID Connect endpoints that are POSTs and only read (ADR 0119 rule 14): userinfo, which
// a client may call by POST, and introspection, which a partner's resource server calls on every
// request it checks. Their handlers write nothing, so read-only serves them: exact paths, POST only
// (a GET already passes as a read; PUT, DELETE and PATCH are refused like any other write), and only
// in read-only (`full` refuses them like everything else). The token endpoint and revocation write
// and stay refused, so in read-only no partner can refresh and partner sessions lapse within the
// access token's 15 minutes.
const READ_ONLY_OIDC_READS = new Set(["/oauth/userinfo", "/oauth/introspect"]);

let warnedUnknownMode = false;

function parseMode(raw: string | undefined): MaintenanceMode {
  if (raw === undefined) return "off";
  if (isMaintenanceMode(raw)) return raw;
  if (!warnedUnknownMode) {
    warnedUnknownMode = true;
    console.error(
      `[maintenance] Unrecognized MAINTENANCE_MODE=${JSON.stringify(raw)}; treating as "off". Valid values: off, read-only, full.`,
    );
  }
  return "off";
}

function respond503(c: MaintenanceContext, mode: ActiveMaintenanceMode) {
  console.warn(
    `[maintenance] blocked ${c.req.method} ${redactSecretPaths(c.req.path)} (mode=${mode})`,
  );
  c.header("Retry-After", "3600");
  return c.json(
    {
      error: "Service Unavailable",
      message: "NEMAR is in maintenance mode. Please retry shortly.",
      mode,
      eta: null,
    },
    503,
  );
}

/**
 * The same rule for a caller this middleware never sees: the `NemarApiRpc`
 * service-binding entrypoint (ADR 0078), which bypasses the HTTP stack. It
 * has no paths to allowlist, so what remains of the rule is the rule itself:
 * `full` refuses everything, `read-only` refuses writes, `off` (or an
 * unrecognised value, parsed exactly as above) refuses nothing.
 */
export function maintenanceRefuses(raw: string | undefined, access: "read" | "write"): boolean {
  const mode = parseMode(raw);
  if (mode === "off") return false;
  return mode === "full" || access === "write";
}

export async function maintenanceMode(c: MaintenanceContext, next: Next) {
  const mode = parseMode(c.env.MAINTENANCE_MODE);

  if (mode === "off") {
    await next();
    return;
  }

  const path = c.req.path;

  if (
    ALWAYS_ALLOWED_PATHS.has(path) ||
    (OIDC_PUBLIC_DOCUMENT_PATHS.includes(path) && PUBLIC_DOCUMENT_READS.has(c.req.method))
  ) {
    await next();
    return;
  }

  if (mode === "full") {
    return respond503(c, mode);
  }

  if (READ_METHODS.has(c.req.method)) {
    await next();
    return;
  }

  if (
    READ_ONLY_EXACT_MUTATIONS.has(path) ||
    (c.req.method === "POST" && READ_ONLY_OIDC_READS.has(path))
  ) {
    await next();
    return;
  }

  if (READ_ONLY_MUTATION_ALLOWLIST.some((prefix) => path.startsWith(prefix))) {
    await next();
    return;
  }

  if (isLauncherCallback(c.req.method, path)) {
    await next();
    return;
  }

  return respond503(c, mode);
}
