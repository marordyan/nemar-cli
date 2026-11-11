/**
 * The compute gateway's routes, mounted at `/compute` (epic #2005 phase A5, #2010; ADR 0118).
 *
 *   POST /compute/jobs/:id/bundle             the launcher, with its job token (no session)
 *   POST /compute/jobs/:id/outputs            the launcher, with its job token (no session)
 *   POST /compute/jobs/:id/outputs/complete   the launcher, with its job token (no session)
 *   POST /compute/jobs/:id/cancel             the job's owner, signed in: cancel it
 *   POST /compute/jobs/:id/links              the job's owner, signed in: 7-day links to the results,
 *                                             1,000 at a time (an optional `{ "after": path }` body pages on)
 *   POST /compute/observer                    the observer, with a token for one run (phase A7, #2012;
 *                                             no session: see `routes/callbacks/compute-observer.ts`)
 *
 * The callbacks are registered FIRST and carry no middleware of their own beyond the Worker's global
 * ones: the launcher has no account. Every route that has a person behind it declares its own
 * authentication ON THE ROUTE (`authMiddleware`, then `cookieOriginGuard`, which a write made with a
 * session cookie must pass): there is no `use("*")` here, which would put a session in front of a
 * launcher. `backend/test/compute-route-inventory.test.ts` pins every entry of this router.
 *
 * THE ANSWERS ARE CONTRACTS. `shared/contract/compute-responses.ts` declares the answers of `cancel`,
 * `links` and the observer as open schemas, and `backend/test/compute-person-responses.test.ts` parses the
 * real output against them. The wire is snake_case throughout.
 *
 * NO CLI COMMAND FOR `cancel` AND `links` YET. They are a person's routes, and a person's front doors are
 * the website's job page and `nemar compute submit`, both Epic D (#2024 is the submit command; the job
 * page is nemarOrg/website#495). An administrator cancels with `nemar admin compute jobs cancel`. A
 * command added here belongs to that epic, built on the contract above.
 *
 * THE OWNER ONLY. A job is the person's own: any other signed-in account, an administrator included
 * (an administrator has `/admin/compute/jobs/:id/cancel`), is answered `job_not_found`, which never
 * says whether the job exists for someone else. Neither route reads the compute switch: a person can
 * always cancel what is running and fetch what they have been given.
 */

import { Hono } from "hono";
import {
  COMPUTE_REFUSAL_STATUS,
  COMPUTE_ROUTE_SENTENCES,
  type ComputeRouteSentenceCode,
} from "../../../shared/compute-state.js";
import { COMPUTE_JOB_ID_RE, isSafeComputePath } from "../../../shared/contract/compute.js";
import { authMiddleware, cookieOriginGuard } from "../middleware/auth.js";
import { getJob } from "../services/compute-jobs.js";
import { requestComputeCancel } from "../services/compute-lifecycle.js";
import { mintResultLinks } from "../services/compute-results.js";
import type { Bindings, Variables } from "../types/bindings.js";
import { readBoundedJsonObject } from "./callbacks/bounded-json.js";
import { registerComputeJobCallbackRoutes } from "./callbacks/compute-job-callbacks.js";
import { registerComputeObserverRoute } from "./callbacks/compute-observer.js";

/** The most bytes the links route reads: a cursor is at most 512 characters, which is 2 KiB at four bytes each. */
export const LINKS_BODY_MAX_BYTES = 4096;

export const computeRoutes = new Hono<{ Bindings: Bindings; Variables: Variables }>();

registerComputeJobCallbackRoutes(computeRoutes);
registerComputeObserverRoute(computeRoutes);

const refuse = (
  c: { json: (body: unknown, status: number) => Response },
  code: ComputeRouteSentenceCode,
) => c.json({ error: COMPUTE_ROUTE_SENTENCES[code], code }, COMPUTE_REFUSAL_STATUS[code]);

/** The job a signed-in person owns, or null for any other reason (never says which). */
async function ownJob(env: Bindings, id: string, userId: number) {
  if (!COMPUTE_JOB_ID_RE.test(id)) return null;
  const job = await getJob(env.DB, id);
  return job && job.account_id === userId ? job : null;
}

computeRoutes.post("/jobs/:id/cancel", authMiddleware, cookieOriginGuard, async (c) => {
  const job = await ownJob(c.env, c.req.param("id"), c.get("user").id);
  if (!job) return refuse(c, "job_not_found");
  const result = await requestComputeCancel(c.env, job.id, "user");
  if (!result.ok)
    return refuse(c, result.outcome === "job_not_found" ? "job_not_found" : "bad_state");
  return c.json({ ok: true, state: result.state, outcome: result.outcome });
});

computeRoutes.post("/jobs/:id/links", authMiddleware, cookieOriginGuard, async (c) => {
  const job = await ownJob(c.env, c.req.param("id"), c.get("user").id);
  if (!job) return refuse(c, "job_not_found");
  // An optional JSON body `{ "after": "<an output path>" }` asks for the page that starts after it. Read
  // under a small bound like every other compute route's body: a cursor is at most 512 characters.
  let after: string | null = null;
  const hasBody = c.req.raw.body !== null && c.req.header("Content-Length") !== "0";
  if (hasBody) {
    const read = await readBoundedJsonObject(c, LINKS_BODY_MAX_BYTES);
    if (!read.ok) {
      return c.json(
        { error: COMPUTE_ROUTE_SENTENCES.invalid_spec, code: "invalid_spec" },
        read.status,
      );
    }
    const cursor = read.body.after;
    if (cursor !== undefined && cursor !== null) {
      if (typeof cursor !== "string" || !isSafeComputePath(cursor, 512)) {
        return refuse(c, "invalid_spec");
      }
      after = cursor;
    }
  }
  const result = await mintResultLinks(c.env, job, after);
  if (!result.ok) return refuse(c, result.code);
  // Bearer links: returned to the owner in this answer and nowhere else, never logged.
  return c.json({
    links: result.links,
    expires_at: result.expires_at,
    total: result.total,
    truncated: result.truncated,
    next_after: result.next_after,
  });
});
