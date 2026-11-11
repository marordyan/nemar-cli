/**
 * The Tapis connection, read from the Worker's bindings (epic #2005 phase A4, #2009; ADR 0118).
 *
 * Everything here is a Worker secret or an owner-set variable, never a line of `wrangler-sccn.toml`
 * (a tenant name is not public; `compute-switches-flag.test.ts` pins that). Dev and production
 * use SEPARATE credentials: each Worker reads its own, and the dev database shares real users.
 *
 * Which credential the tenant's operator grants is not known yet, so BOTH strategies are built and the
 * choice is configuration, with no code change:
 *
 *   `password`  the account TAPIS_USERNAME / TAPIS_PASSWORD signs in with the OAuth2 password grant.
 *               The token is that account's, whoever a call is made "as".
 *   `service`   TAPIS_SERVICE_TOKEN (a Tokens API service credential) mints a user token for a named
 *               username; each username has its own token. TAPIS_USERNAME is optional: it is the
 *               NEMAR service identity that `GET /admin/compute/status` probes with.
 *
 * A missing, misspelled or unusable setting makes the whole configuration `unconfigured`, with the
 * NAMES of what is wrong as fixed words (`TAPIS_PASSWORD:missing`), never a value: nothing falls back
 * to a default the owner did not choose. `TAPIS_BASE` is the one place an address is chosen: the
 * test override `globalThis.NEMAR_TAPIS_API_URL` first (a deployed Worker cannot set a global, as for
 * `GITHUB_API()`), else the variable.
 */

import type { Bindings } from "../../types/bindings";

/** What this module reads of the environment. */
export type TapisEnv = Partial<
  Pick<
    Bindings,
    | "TAPIS_BASE_URL"
    | "TAPIS_TENANT_ID"
    | "TAPIS_AUTH_STRATEGY"
    | "TAPIS_USERNAME"
    | "TAPIS_PASSWORD"
    | "TAPIS_SERVICE_TOKEN"
  >
>;

export const TAPIS_STRATEGIES = ["password", "service"] as const;
export type TapisStrategy = (typeof TAPIS_STRATEGIES)[number];

/** A closed set of words naming what is wrong with a configuration; never a value. */
export type TapisConfigProblem =
  | `${"TAPIS_AUTH_STRATEGY" | "TAPIS_BASE_URL" | "TAPIS_TENANT_ID" | "TAPIS_USERNAME" | "TAPIS_PASSWORD" | "TAPIS_SERVICE_TOKEN"}:missing`
  | "TAPIS_AUTH_STRATEGY:unknown"
  | "TAPIS_BASE_URL:not_https";

interface TapisConfigBase {
  unconfigured?: false;
  /** The tenant's base address, no trailing slash. A secret: never in an answer or a log. */
  baseUrl: string;
  tenantId: string;
}

export interface TapisPasswordConfig extends TapisConfigBase {
  strategy: "password";
  username: string;
  password: string;
}

export interface TapisServiceConfig extends TapisConfigBase {
  strategy: "service";
  serviceToken: string;
  /** The NEMAR service identity the status probe mints a token for, when one is configured. */
  username: string | undefined;
}

export type TapisConfigured = TapisPasswordConfig | TapisServiceConfig;

export interface TapisUnconfigured {
  unconfigured: true;
  problems: readonly TapisConfigProblem[];
}

export type TapisConfig = TapisConfigured | TapisUnconfigured;

const present = (value: string | undefined): value is string =>
  typeof value === "string" && value.trim() !== "";

/**
 * The tenant's base address: `globalThis.NEMAR_TAPIS_API_URL` when set (a test seam), else
 * `TAPIS_BASE_URL`, without trailing slashes; undefined when neither is set. Read at call time.
 */
export function TAPIS_BASE(env: TapisEnv): string | undefined {
  const override = (globalThis as { NEMAR_TAPIS_API_URL?: string }).NEMAR_TAPIS_API_URL;
  const raw = present(override) ? override : env.TAPIS_BASE_URL;
  return present(raw) ? raw.trim().replace(/\/+$/, "") : undefined;
}

/**
 * Whether the test override of the address is installed. It is, only in a test (a deployed Worker
 * cannot set a global), and then plain `http` on a loopback port is allowed where production allows
 * only `https`: the tenant's address and a webhook address alike.
 */
export function overrideActive(): boolean {
  return present((globalThis as { NEMAR_TAPIS_API_URL?: string }).NEMAR_TAPIS_API_URL);
}

/** An https address with no credentials in it; the test override is taken as it is. */
function isUsableBase(base: string): boolean {
  if (overrideActive()) return true;
  try {
    const url = new URL(base);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

/**
 * The base address, or the problem with it. The health call needs only this; a call that
 * authenticates needs the whole of `tapisConfig`.
 */
export function tapisBaseOrProblem(
  env: TapisEnv,
): { baseUrl: string } | { problem: "TAPIS_BASE_URL:missing" | "TAPIS_BASE_URL:not_https" } {
  const base = TAPIS_BASE(env);
  if (base === undefined) return { problem: "TAPIS_BASE_URL:missing" };
  return isUsableBase(base) ? { baseUrl: base } : { problem: "TAPIS_BASE_URL:not_https" };
}

export function tapisConfig(env: TapisEnv): TapisConfig {
  const problems: TapisConfigProblem[] = [];
  const strategy = env.TAPIS_AUTH_STRATEGY;
  let chosen: TapisStrategy | undefined;
  if (!present(strategy)) problems.push("TAPIS_AUTH_STRATEGY:missing");
  else if ((TAPIS_STRATEGIES as readonly string[]).includes(strategy)) {
    chosen = strategy as TapisStrategy;
  } else problems.push("TAPIS_AUTH_STRATEGY:unknown");

  const base = tapisBaseOrProblem(env);
  if ("problem" in base) problems.push(base.problem);
  if (!present(env.TAPIS_TENANT_ID)) problems.push("TAPIS_TENANT_ID:missing");

  if (chosen === "password") {
    if (!present(env.TAPIS_USERNAME)) problems.push("TAPIS_USERNAME:missing");
    if (!present(env.TAPIS_PASSWORD)) problems.push("TAPIS_PASSWORD:missing");
  } else if (chosen === "service") {
    if (!present(env.TAPIS_SERVICE_TOKEN)) problems.push("TAPIS_SERVICE_TOKEN:missing");
  }

  if (problems.length > 0 || "problem" in base) return { unconfigured: true, problems };
  const common = { baseUrl: base.baseUrl, tenantId: (env.TAPIS_TENANT_ID as string).trim() };
  if (chosen === "password") {
    return {
      strategy: "password",
      ...common,
      username: (env.TAPIS_USERNAME as string).trim(),
      password: env.TAPIS_PASSWORD as string,
    };
  }
  return {
    strategy: "service",
    ...common,
    serviceToken: env.TAPIS_SERVICE_TOKEN as string,
    username: present(env.TAPIS_USERNAME) ? env.TAPIS_USERNAME.trim() : undefined,
  };
}
