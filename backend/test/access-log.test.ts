/**
 * The Worker's access log (epic #2005 phase A5, #2010; ADR 0118, round 1 review): Hono's `logger()` prints
 * every request's path, and the Tapis webhook address carries a bearer token in its path.
 * `redactSecretPaths` takes the token out and `accessLogger` is the logger the entry point mounts.
 *
 * Real Hono, the real middleware, the real console capture. MUTATIONS (each makes a test below fail):
 * return the line unchanged from `redactSecretPaths`; mount Hono's own `logger()` in `index.ts` again;
 * stop redacting the path in the maintenance middleware's refusal line.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { accessLogger, redactSecretPaths } from "../src/middleware/access-log";
import { maintenanceMode } from "../src/middleware/maintenance";
import type { Bindings, Variables } from "../src/types/bindings";
import { logged } from "./helpers/logs";

const JOB = `job_${"a1".repeat(12)}`;
const TOKEN = "0123456789abcdef".repeat(4);
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

describe("redactSecretPaths", () => {
  test("keeps the job id and replaces the token, in an incoming and an outgoing line", () => {
    expect(redactSecretPaths(`<-- POST /webhooks/tapis/${JOB}/${TOKEN}`)).toBe(
      `<-- POST /webhooks/tapis/${JOB}/[redacted]`,
    );
    expect(redactSecretPaths(`--> POST /webhooks/tapis/${JOB}/${TOKEN} 200 5ms`)).toBe(
      `--> POST /webhooks/tapis/${JOB}/[redacted] 200 5ms`,
    );
  });

  test("a first segment that is not a job id is replaced too, and a prefix before the route is kept", () => {
    expect(redactSecretPaths(`<-- POST /webhooks/tapis/${TOKEN}`)).toBe(
      "<-- POST /webhooks/tapis/[redacted]/[redacted]",
    );
    expect(redactSecretPaths(`<-- POST /nemar/webhooks/tapis/${JOB}/${TOKEN}/extra`)).toBe(
      `<-- POST /nemar/webhooks/tapis/${JOB}/[redacted]`,
    );
  });

  test("every other line is returned exactly as it came", () => {
    for (const line of [
      "<-- GET /datasets",
      "--> POST /webhooks/github 200 3ms",
      `<-- POST /compute/jobs/${JOB}/outputs`,
      "",
    ]) {
      expect(redactSecretPaths(line)).toBe(line);
    }
  });
});

describe("accessLogger and the maintenance refusal line", () => {
  function app() {
    const a = new Hono<{ Bindings: Bindings; Variables: Variables }>();
    a.use("*", accessLogger());
    a.use("*", maintenanceMode);
    a.post("/webhooks/tapis/:jobId/:token", (c) => c.json({ ok: true }));
    a.get("/datasets", (c) => c.json({ datasets: [] }));
    return a;
  }
  const call = (a: ReturnType<typeof app>, path: string, method: string, mode?: string) =>
    a.fetch(
      new Request(`http://localhost${path}`, { method }),
      (mode === undefined ? {} : { MAINTENANCE_MODE: mode }) as unknown as Bindings,
    );

  test("a webhook request is logged with its token replaced, and an ordinary one as it is", async () => {
    const a = app();
    const lines = await logged(async () => {
      expect((await call(a, `/webhooks/tapis/${JOB}/${TOKEN}`, "POST")).status).toBe(200);
      expect((await call(a, "/datasets", "GET")).status).toBe(200);
    });
    expect(lines.join("\n")).not.toContain(TOKEN);
    expect(lines.some((l) => l.startsWith(`<-- POST /webhooks/tapis/${JOB}/[redacted]`))).toBe(
      true,
    );
    // The outgoing line carries the status, coloured: strip the colour before reading it.
    const plain = lines.map((l) => l.replace(ANSI, ""));
    expect(plain.some((l) => l.startsWith(`--> POST /webhooks/tapis/${JOB}/[redacted] 200`))).toBe(
      true,
    );
    expect(lines).toContain("<-- GET /datasets");
  });

  test("the maintenance middleware's refusal line does not hold the token either (full mode refuses the route)", async () => {
    const a = app();
    const lines = await logged(async () => {
      expect((await call(a, `/webhooks/tapis/${JOB}/${TOKEN}`, "POST", "full")).status).toBe(503);
    });
    expect(lines.join("\n")).not.toContain(TOKEN);
    expect(lines.some((l) => l.startsWith("[maintenance] blocked POST /webhooks/tapis/"))).toBe(
      true,
    );
  });
});

describe("the entry point mounts this logger", () => {
  const source = readFileSync(join(import.meta.dir, "../src/index.ts"), "utf8");

  test("`index.ts` uses `accessLogger()` and never Hono's own `logger`", () => {
    expect(source).toContain('api.use("*", accessLogger());');
    expect(source).not.toMatch(/from "hono\/logger"/);
    expect(source).not.toMatch(/(^|[^A-Za-z])logger\(\)/m);
  });
});
