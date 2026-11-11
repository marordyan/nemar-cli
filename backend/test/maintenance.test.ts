import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { maintenanceMode } from "../src/middleware/maintenance";
import type { Bindings, Variables } from "../src/types/bindings";

type AppEnv = { Bindings: Bindings; Variables: Variables };

function buildApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", maintenanceMode);
  app.get("/health", (c) => c.json({ status: "ok" }));
  app.get("/notices", (c) => c.json({ notices: [] }));
  app.get("/healthz", (c) => c.json({ fake: true }));
  app.get("/notices/123", (c) => c.json({ fake: true }));
  app.get("/datasets", (c) => c.json({ datasets: [] }));
  app.post("/datasets", (c) => c.json({ created: true }));
  app.put("/datasets/x", (c) => c.json({ updated: true }));
  app.patch("/datasets/x", (c) => c.json({ patched: true }));
  app.delete("/datasets/x", (c) => c.json({ deleted: true }));
  app.options("/datasets", (c) => c.json({ preflight: true }));
  app.post("/admin/approve", (c) => c.json({ approved: true }));
  app.post("/adminfoo", (c) => c.json({ sneaky: true }));
  app.post("/admin", (c) => c.json({ no_slash: true }));
  app.post("/webhooks/github", (c) => c.json({ received: true }));
  app.post("/auth/login", (c) => c.json({ logged_in: true }));
  app.post("/auth/resend-verification", (c) => c.json({ resent: true }));
  app.post("/compute/jobs/:id/bundle", (c) => c.json({ launcher: "bundle" }));
  app.post("/compute/jobs/:id/outputs", (c) => c.json({ launcher: "outputs" }));
  app.post("/compute/jobs/:id/outputs/complete", (c) => c.json({ launcher: "complete" }));
  app.put("/compute/jobs/:id/outputs", (c) => c.json({ sneaky: true }));
  app.post("/compute/jobs/:id/cancel", (c) => c.json({ cancelled: true }));
  app.post("/compute/jobs/:id/links", (c) => c.json({ links: [] }));
  app.post("/compute/jobs/:id/outputs/other", (c) => c.json({ sneaky: true }));
  app.get("/", (c) => c.json({ name: "NEMAR API" }));
  return app;
}

const BASE_ENV = {
  ENVIRONMENT: "test" as const,
  API_BASE_URL: "http://localhost",
  FRONTEND_URL: "http://localhost",
  AWS_REGION: "us-east-2",
  S3_BUCKET: "nemar",
  DB: undefined as unknown as D1Database,
  GITHUB_ADMIN_PAT: "",
  AWS_ACCESS_KEY_ID: "",
  AWS_SECRET_ACCESS_KEY: "",
  RESEND_API_KEY: "",
  ZENODO_API_KEY: "",
  EZID_USERNAME: "",
  EZID_PASSWORD: "",
} satisfies Partial<Bindings> as unknown as Bindings;

function envWith(mode: string | undefined): Bindings {
  if (mode === undefined) return BASE_ENV;
  // Cast covers the invalid-string test where we deliberately pass garbage.
  return { ...BASE_ENV, MAINTENANCE_MODE: mode as Bindings["MAINTENANCE_MODE"] };
}

async function hit(
  app: Hono<AppEnv>,
  mode: string | undefined,
  path: string,
  method = "GET",
): Promise<Response> {
  return await app.fetch(new Request(`http://localhost${path}`, { method }), envWith(mode));
}

describe("maintenanceMode: off (default)", () => {
  const app = buildApp();

  test("GET /health -> 200", async () => {
    const res = await hit(app, "off", "/health");
    expect(res.status).toBe(200);
  });

  test("POST /datasets -> 200", async () => {
    const res = await hit(app, "off", "/datasets", "POST");
    expect(res.status).toBe(200);
  });

  test("undefined env var behaves as off", async () => {
    const res = await hit(app, undefined, "/datasets", "POST");
    expect(res.status).toBe(200);
  });

  test("garbage MAINTENANCE_MODE value falls back to off", async () => {
    const res = await hit(app, "readonly", "/datasets", "POST");
    expect(res.status).toBe(200);
  });
});

describe("maintenanceMode: read-only", () => {
  const app = buildApp();

  test("GET /datasets -> 200", async () => {
    const res = await hit(app, "read-only", "/datasets", "GET");
    expect(res.status).toBe(200);
  });

  test("OPTIONS preflight -> 200", async () => {
    const res = await hit(app, "read-only", "/datasets", "OPTIONS");
    expect(res.status).toBe(200);
  });

  test.each([
    ["POST", "/datasets"],
    ["PUT", "/datasets/x"],
    ["PATCH", "/datasets/x"],
    ["DELETE", "/datasets/x"],
  ])("%s %s -> 503", async (method, path) => {
    const res = await hit(app, "read-only", path, method);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { mode: string; error: string };
    expect(body.mode).toBe("read-only");
    expect(body.error).toBe("Service Unavailable");
  });

  test("POST /datasets response carries Retry-After header", async () => {
    const res = await hit(app, "read-only", "/datasets", "POST");
    expect(res.headers.get("Retry-After")).toBe("3600");
  });

  test("POST /admin/approve -> 200 (admin allowed)", async () => {
    const res = await hit(app, "read-only", "/admin/approve", "POST");
    expect(res.status).toBe(200);
  });

  test("POST /webhooks/github -> 200 (webhook allowed)", async () => {
    const res = await hit(app, "read-only", "/webhooks/github", "POST");
    expect(res.status).toBe(200);
  });

  test("POST /auth/login -> 200 (admin can re-auth)", async () => {
    const res = await hit(app, "read-only", "/auth/login", "POST");
    expect(res.status).toBe(200);
  });

  test("POST /auth/resend-verification -> 503 (only /auth/login is exempt)", async () => {
    const res = await hit(app, "read-only", "/auth/resend-verification", "POST");
    expect(res.status).toBe(503);
  });

  test("POST /adminfoo -> 503 (prefix boundary not bypassed)", async () => {
    const res = await hit(app, "read-only", "/adminfoo", "POST");
    expect(res.status).toBe(503);
  });

  test("POST /admin (no trailing slash) -> 503", async () => {
    const res = await hit(app, "read-only", "/admin", "POST");
    expect(res.status).toBe(503);
  });
});

// Round 1 of #2041: a job already running on a cluster must be able to hand in its results while the
// API is read-only. The three launcher callbacks are open by EXACT shape (a real job id, POST); nothing
// else under /compute/jobs is.
describe("maintenanceMode: read-only and the compute launcher's callbacks", () => {
  const app = buildApp();
  const JOB = `job_${"0f".repeat(12)}`;

  test.each(["bundle", "outputs", "outputs/complete"])(
    "POST /compute/jobs/<job>/%s -> 200 (the launcher still delivers)",
    async (leaf) => {
      const res = await hit(app, "read-only", `/compute/jobs/${JOB}/${leaf}`, "POST");
      expect(res.status).toBe(200);
    },
  );

  test.each([
    ["POST", `/compute/jobs/${JOB}/cancel`],
    ["POST", `/compute/jobs/${JOB}/links`],
    ["POST", `/compute/jobs/${JOB}/outputs/other`],
    ["POST", "/compute/jobs/not-a-job-id/outputs"],
    ["POST", `/compute/jobs/${JOB.toUpperCase()}/outputs`],
    ["POST", `/compute/jobs/${JOB}x/outputs`],
    ["PUT", `/compute/jobs/${JOB}/outputs`],
  ])("%s %s -> 503 (only the three callbacks, by exact shape and POST)", async (method, path) => {
    const res = await hit(app, "read-only", path, method);
    expect(res.status).toBe(503);
  });
});

// The API is mounted at `/` and at `/nemar`, and this middleware sees the full path. The pattern is
// anchored at `/compute`, so the other spelling is refused in read-only: safe (it never opens), and
// unused (the launcher's address is `API_BASE_URL`, which has no prefix). This pins the documented
// behavior (ADR 0118, item 11 of the A5 amendment) so a change to it is a decision and not an accident.
describe("maintenanceMode: read-only and the /nemar spelling of the launcher's callbacks", () => {
  const app = buildApp();
  const JOB = `job_${"0f".repeat(12)}`;

  test.each(["bundle", "outputs", "outputs/complete"])(
    "POST /nemar/compute/jobs/<job>/%s -> 503 (not matched, so not opened)",
    async (leaf) => {
      const res = await hit(app, "read-only", `/nemar/compute/jobs/${JOB}/${leaf}`, "POST");
      expect(res.status).toBe(503);
    },
  );
});

describe("maintenanceMode: full", () => {
  const app = buildApp();

  test("GET /datasets -> 503 with Retry-After", async () => {
    const res = await hit(app, "full", "/datasets", "GET");
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("3600");
    const body = (await res.json()) as { mode: string; error: string };
    expect(body.mode).toBe("full");
    expect(body.error).toBe("Service Unavailable");
  });

  test("POST /datasets -> 503", async () => {
    const res = await hit(app, "full", "/datasets", "POST");
    expect(res.status).toBe(503);
  });

  test.each(["bundle", "outputs", "outputs/complete"])(
    "POST /compute/jobs/<job>/%s -> 503 (full refuses the launcher too)",
    async (leaf) => {
      const res = await hit(app, "full", `/compute/jobs/job_${"0f".repeat(12)}/${leaf}`, "POST");
      expect(res.status).toBe(503);
    },
  );

  test("POST /admin/approve -> 503 (admin blocked in full)", async () => {
    const res = await hit(app, "full", "/admin/approve", "POST");
    expect(res.status).toBe(503);
  });

  test("POST /auth/login -> 503 (login blocked in full)", async () => {
    const res = await hit(app, "full", "/auth/login", "POST");
    expect(res.status).toBe(503);
  });

  test("GET /health -> 200", async () => {
    const res = await hit(app, "full", "/health");
    expect(res.status).toBe(200);
  });

  test("GET /notices -> 200", async () => {
    const res = await hit(app, "full", "/notices");
    expect(res.status).toBe(200);
  });

  test("GET / -> 200", async () => {
    const res = await hit(app, "full", "/");
    expect(res.status).toBe(200);
  });

  test("GET /healthz -> 503 (exact match, not prefix)", async () => {
    const res = await hit(app, "full", "/healthz");
    expect(res.status).toBe(503);
  });

  test("GET /notices/123 -> 503 (exact match, not prefix)", async () => {
    const res = await hit(app, "full", "/notices/123");
    expect(res.status).toBe(503);
  });
});
