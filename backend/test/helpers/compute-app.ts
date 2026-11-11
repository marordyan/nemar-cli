/**
 * The NEMAR admin router as the compute suites need it: the REAL `adminRoutes`, with its real
 * authentication, admin and cookie-origin middleware, mounted at `/admin` as `backend/src/index.ts`
 * mounts it, over a real migrated database. Users carry real API keys (hashed as production hashes
 * them). Nothing is stood in for.
 *
 * Lives in backend/test/helpers so `hono` resolves from the backend's own dependencies; the root
 * CLI suite imports this, not Hono, as the other CLI suites reach the backend.
 */

import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { adminRoutes } from "../../src/routes/admin";
import { hashApiKey } from "../../src/services/token";
import type { Bindings, Variables } from "../../src/types/bindings";
import { realD1 } from "./d1";

export const COMPUTE_KEYS = {
  owner: "cmp-owner-key-0123456789abcdef0123456789abcdef01",
  owner2: "cmp-owner2-key-0123456789abcdef0123456789abcdef0",
  admin: "cmp-admin-key-0123456789abcdef0123456789abcdef01",
  admin2: "cmp-admin2-key-0123456789abcdef0123456789abcdef0",
  member: "cmp-member-key-0123456789abcdef0123456789abcdef0",
};

export type ComputeWho = keyof typeof COMPUTE_KEYS;

/** Seed an owner, a second owner, two admins and a member, each with a key; their user ids. */
export async function seedComputeUsers(db: Database): Promise<Record<ComputeWho, number>> {
  const ids = {} as Record<ComputeWho, number>;
  const roles: Record<ComputeWho, "owner" | "admin" | "member"> = {
    owner: "owner",
    owner2: "owner",
    admin: "admin",
    admin2: "admin",
    member: "member",
  };
  for (const who of Object.keys(COMPUTE_KEYS) as ComputeWho[]) {
    const role = roles[who];
    db.run(
      `INSERT INTO users (username, email, password_hash, status, role, signup_source,
                          email_verified, service_access, account_kind)
       VALUES (?, ?, 'x', ?, ?, 'cli', 1, 0, 'person')`,
      [`cmp-${who}`, `cmp-${who}@example.org`, role === "member" ? "verified" : "approved", role],
    );
    const row = db.query("SELECT id FROM users WHERE username = ?").get(`cmp-${who}`) as {
      id: number;
    };
    db.query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)").run(
      row.id,
      await hashApiKey(COMPUTE_KEYS[who]),
      COMPUTE_KEYS[who].slice(0, 8),
    );
    ids[who] = row.id;
  }
  return ids;
}

/** Bindings for a request: the database, and nothing else the compute routes read. */
export function computeEnv(db: Database, over: Partial<Bindings> = {}): Bindings {
  return { DB: realD1(db), ENVIRONMENT: "production", ...over } as Bindings;
}

/** `(request, bindings) => response` over the real admin router mounted at `/admin`. */
export function makeComputeApp(): (req: Request, env: Bindings) => Response | Promise<Response> {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/admin", adminRoutes);
  return (req, env) =>
    app.fetch(req, env, {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as unknown as ExecutionContext);
}
