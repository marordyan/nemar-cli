/**
 * The compute and webhook routers as the compute suites need them: the REAL `computeRoutes` and the REAL
 * `webhooks` router, mounted at `/compute` and `/webhooks` as `backend/src/index.ts` mounts them, over a
 * real migrated database and the real bindings of `compute-lifecycle-fixture.ts`. Nothing is stood in
 * for. `serveRoutes` puts the same handler on a real loopback port, so a Tapis stand-in that fires a
 * webhook reaches the very address the Worker subscribed.
 */

import { Hono } from "hono";
import { accessLogger } from "../../src/middleware/access-log";
import { maintenanceMode } from "../../src/middleware/maintenance";
import { computeRoutes } from "../../src/routes/compute";
import webhooks from "../../src/routes/webhooks";
import type { Bindings, Variables } from "../../src/types/bindings";

export type RoutesHandle = (req: Request, env: Bindings) => Response | Promise<Response>;

/**
 * `accessLog` and `maintenance` mount the Worker's REAL access logger and maintenance middleware first,
 * in the order `index.ts` does (logger, then maintenance), for a suite that asserts something about what
 * they do to these routes. They are off by default so the other suites' output stays quiet.
 */
export function makeRoutesApp(
  options: { accessLog?: boolean; maintenance?: boolean } = {},
): RoutesHandle {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  if (options.accessLog === true) app.use("*", accessLogger());
  if (options.maintenance === true) app.use("*", maintenanceMode);
  app.route("/compute", computeRoutes);
  app.route("/webhooks", webhooks);
  return (req, env) =>
    app.fetch(req, env, {
      waitUntil: () => {},
      passThroughOnException: () => {},
    } as unknown as ExecutionContext);
}

/** A real HTTP server for the routes; `env` is read at each request, so a test can change it. */
export function serveRoutes(handle: RoutesHandle, env: () => Bindings) {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => handle(req, env()),
  });
}
