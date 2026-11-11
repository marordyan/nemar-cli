/**
 * Real route tests for the dormant email-code sign-in: POST /auth/code/request
 * and POST /auth/code/verify refuse outside development and test.
 *
 * The website hides the form in production (`WEB_SIGNIN_ENABLED`), but a hidden
 * form is not a closed route, so the Worker fails closed too: only an
 * ENVIRONMENT that is exactly "development" or "test" opens it, and a missing
 * value is closed. A code issued in development must not be redeemable by the
 * production path, which is what the verify test proves with a real code.
 *
 * Real engine throughout: bun:sqlite behind realD1 (every migration applied)
 * and real Hono dispatch via app.request().
 */

import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { authWebRoutes } from "../src/routes/auth-web";
import type { Bindings, Variables } from "../src/types/bindings";
import { freshDb, realD1 } from "./helpers/d1";

const APP_ORIGIN = "https://app.nemar.org";
const EMAIL = "test-user@nemar.test";

let db: Database;
let app: Hono<{ Bindings: Bindings; Variables: Variables }>;
let fetchCalls: string[];
const realFetch = globalThis.fetch;

function envFor(environment: string | undefined): Bindings {
  const env: Record<string, unknown> = {
    DB: realD1(db),
    ENCRYPTION_KEY: "route-test-encryption-key-0123456789",
    RESEND_API_KEY: "fake-key-should-never-be-used",
    FROM_EMAIL: "NEMAR Archive <noreply@nemar.org>",
    APP_BASE_URL: APP_ORIGIN,
    WEB_SESSION_COOKIE_DOMAIN: "",
  };
  if (environment !== undefined) env.ENVIRONMENT = environment;
  return env as unknown as Bindings;
}

function requestCode(env: Bindings): Promise<Response> {
  return Promise.resolve(
    app.request(
      "/auth/code/request",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: EMAIL }),
      },
      env,
    ),
  );
}

function verifyCode(env: Bindings, code: string): Promise<Response> {
  return Promise.resolve(
    app.request(
      "/auth/code/verify",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: APP_ORIGIN },
        body: JSON.stringify({ email: EMAIL, code, remember: false }),
      },
      env,
    ),
  );
}

function countRows(table: string): number {
  return db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? -1;
}

beforeEach(() => {
  db = freshDb();
  db.run(
    `INSERT INTO users (username, email, password_hash, github_username, status, role, email_verified)
     VALUES ('test-user', ?, 'x', 'test-user-gh', 'approved', 'member', 1)`,
    [EMAIL],
  );
  app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/auth", authWebRoutes);
  fetchCalls = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    fetchCalls.push(url);
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("POST /auth/code/request is closed outside development and test", () => {
  for (const environment of ["production", "staging", "", undefined]) {
    test(`ENVIRONMENT=${JSON.stringify(environment)}: masked 200, no code row, no send`, async () => {
      const res = await requestCode(envFor(environment));
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.ok).toBe(true);
      expect(typeof body.masked_email).toBe("string");
      expect("dev_code" in body).toBe(false);
      expect("dev_skip" in body).toBe(false);
      expect(countRows("auth_codes")).toBe(0);
      expect(fetchCalls).toEqual([]);
    });
  }

  test("a registered and an unknown address answer with the same shape in production", async () => {
    const registered = await requestCode(envFor("production"));
    const unknown = await app.request(
      "/auth/code/request",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "nobody-here@nemar.test" }),
      },
      envFor("production"),
    );
    expect(registered.status).toBe(unknown.status);
    expect(Object.keys((await registered.json()) as object).sort()).toEqual(
      Object.keys((await unknown.json()) as object).sort(),
    );
  });
});

describe("POST /auth/code/verify is closed outside development and test", () => {
  test("a code issued in development is not redeemable in production, and no session is written", async () => {
    const issued = await requestCode(envFor("development"));
    const body = (await issued.json()) as { dev_code?: string };
    expect(body.dev_code).toMatch(/^\d{6}$/);
    const sessionsBefore = countRows("web_sessions");

    const res = await verifyCode(envFor("production"), body.dev_code as string);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("Invalid or expired code");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(countRows("web_sessions")).toBe(sessionsBefore);
  });

  test("with ENVIRONMENT missing the same code is refused", async () => {
    const issued = await requestCode(envFor("development"));
    const { dev_code } = (await issued.json()) as { dev_code: string };
    const res = await verifyCode(envFor(undefined), dev_code);
    expect(res.status).toBe(401);
  });
});

describe("development and test keep the flow", () => {
  for (const environment of ["development", "test"]) {
    test(`ENVIRONMENT=${environment}: request echoes a code and verify signs in`, async () => {
      const env = envFor(environment);
      const issued = await requestCode(env);
      expect(issued.status).toBe(200);
      const { dev_code } = (await issued.json()) as { dev_code?: string };
      expect(dev_code).toMatch(/^\d{6}$/);

      const res = await verifyCode(env, dev_code as string);
      expect(res.status).toBe(200);
      expect(res.headers.get("set-cookie")).toContain("session");
    });
  }
});
