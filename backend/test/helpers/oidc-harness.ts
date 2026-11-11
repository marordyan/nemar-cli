/**
 * The OpenID Connect provider as its suites need it: the REAL Worker entry point (the middleware
 * stack, the host and mount routing, the admin router behind its real authentication) over a real
 * SQLite database that carries every migration, with an owner, an administrator and a member whose
 * API keys are stored hashed, as the real ones are.
 *
 * Nothing here replaces NEMAR logic. The two things it supplies are the platform's: a
 * `waitUntil` that holds promises, and the documented test bypass of the rate limiter
 * (`X-Test-Bypass` against `TEST_BYPASS_TOKEN`), so a suite can choose ENVIRONMENT freely
 * (`production` for the rules that only production has) without the limiter needing a Cache API
 * that bun does not have.
 */

import type { Database } from "bun:sqlite";
import worker from "../../src/index";
import { hashApiKey } from "../../src/services/token";
import type { Bindings } from "../../src/types/bindings";
import { freshDb, realD1 } from "./d1";
import { fakeOidcSecret } from "./oidc-secret";

export const OIDC_TEST_SECRET = fakeOidcSecret("oidc-test");
export const ISSUER = "https://api.nemar.org";
export const OWNER_KEY = "oidc-owner-key-0123456789abcdef0123456789abcdef";
export const ADMIN_KEY = "oidc-admin-key-0123456789abcdef0123456789abcdef";
export const MEMBER_KEY = "oidc-member-key-0123456789abcdef0123456789abcd";
const BYPASS = "oidc-harness-bypass-token";

/**
 * The platform's `ExecutionContext`, per harness: `waitUntil` keeps the promise it is given, so a
 * suite can wait for the work a request handed to it (`settle`), as a Worker's runtime would let it
 * finish after the response. A rejection is swallowed here and nowhere else.
 */
function executionContext(): { ctx: ExecutionContext; settle(): Promise<void> } {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil: (p: Promise<unknown>) => {
        pending.push(p.catch(() => {}));
      },
      passThroughOnException: () => {},
    } as unknown as ExecutionContext,
    async settle() {
      // The work may hand more work to `waitUntil` (a retry), so drain until none is left.
      while (pending.length > 0) await Promise.all(pending.splice(0, pending.length));
    },
  };
}

export interface Answer {
  status: number;
  headers: Headers;
  text: string;
  /** The body parsed as JSON, or null when it is not JSON. */
  json: Record<string, unknown> | null;
}

export interface OidcHarness {
  db: Database;
  /** The bindings every call uses; `over` of the harness is already applied. */
  env: Bindings;
  ids: { owner: number; admin: number; member: number };
  /** Wait for everything the requests so far handed to `waitUntil` (a logout's first attempt). */
  settle(): Promise<void>;
  /** One request to the Worker. `base` defaults to the issuer's origin. */
  call(
    method: string,
    path: string,
    opts?: {
      key?: string | null;
      body?: unknown;
      rawBody?: string;
      base?: string;
      headers?: Record<string, string>;
      env?: Partial<Bindings>;
      /** False sends no `X-Test-Bypass`, so the rate limiter counts the request. Default true. */
      bypass?: boolean;
    },
  ): Promise<Answer>;
}

export async function seedUser(
  db: Database,
  username: string,
  role: string,
  apiKey: string,
): Promise<number> {
  db.query(
    `INSERT INTO users (username, email, password_hash, status, role, email_verified)
     VALUES (?, ?, 'x', 'approved', ?, 1)`,
  ).run(username, `${username}@example.org`, role);
  const row = db
    .query<{ id: number }, [string]>("SELECT id FROM users WHERE username = ?")
    .get(username);
  if (!row) throw new Error(`seed: ${username} was not inserted`);
  db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
    row.id,
    await hashApiKey(apiKey),
    apiKey.slice(0, 8),
  );
  return row.id;
}

/** A fresh database, three accounts, and a way to call the Worker as any of them. */
export async function startOidcHarness(over: Partial<Bindings> = {}): Promise<OidcHarness> {
  const db = freshDb();
  const ids = {
    owner: await seedUser(db, "oidcowner", "owner", OWNER_KEY),
    admin: await seedUser(db, "oidcadmin", "admin", ADMIN_KEY),
    member: await seedUser(db, "oidcmember", "member", MEMBER_KEY),
  };
  // One database object for the whole test, so what a service keeps per database object (the key
  // set) behaves as it does in a Worker.
  const d1 = realD1(db);
  const env = {
    DB: d1,
    ENVIRONMENT: "test",
    API_BASE_URL: ISSUER,
    APP_BASE_URL: "https://app.nemar.org",
    OIDC_SECRET: OIDC_TEST_SECRET,
    TEST_BYPASS_TOKEN: BYPASS,
    ...over,
  } as unknown as Bindings;

  const { ctx, settle } = executionContext();
  return {
    db,
    env,
    ids,
    settle,
    async call(method, path, opts = {}) {
      const headers: Record<string, string> = { ...(opts.headers ?? {}) };
      if (opts.bypass !== false) headers["X-Test-Bypass"] = BYPASS;
      if (opts.key) headers.Authorization = `Bearer ${opts.key}`;
      let body: string | undefined;
      if (opts.rawBody !== undefined) body = opts.rawBody;
      else if (opts.body !== undefined) body = JSON.stringify(opts.body);
      // JSON unless the caller named a type (the token endpoint reads a form).
      const typed = Object.keys(headers).some((k) => k.toLowerCase() === "content-type");
      if (body !== undefined && !typed) headers["Content-Type"] = "application/json";
      const res = await worker.fetch(
        new Request(`${opts.base ?? ISSUER}${path}`, { method, headers, body }),
        { ...env, ...(opts.env ?? {}) },
        ctx,
      );
      const text = await res.text();
      let json: Record<string, unknown> | null = null;
      try {
        const parsed = JSON.parse(text);
        json = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
      } catch {
        json = null;
      }
      return { status: res.status, headers: res.headers, text, json };
    },
  };
}

let bodyCounter = 0;

/**
 * A body the create route accepts, with any field overridden. The name is different on every call,
 * because two active clients may not share one.
 */
export function clientBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  bodyCounter += 1;
  return {
    name: `Example client ${bodyCounter}`,
    redirect_uris: ["https://client.example.org/callback"],
    allowed_scopes: ["openid", "profile", "email"],
    allowed_grants: ["authorization_code"],
    sign_in_rule: "active_account",
    audience: "https://api.example.org",
    ...over,
  };
}
