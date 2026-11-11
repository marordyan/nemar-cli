/**
 * Admin routes: the record of an upstream re-pull (epic #1046 phase 6, #1912; ADR 0111,
 * decision 3).
 *
 *   POST /admin/repulls                  create the record, or return the open one for the same plan
 *   GET  /admin/repulls                  list (`dataset`, `open`, `origin`, `after`, `limit` up
 *                                        to 50)
 *   GET  /admin/repulls/switches         what the Worker reads of the automatic re-pull's
 *                                        switches and both caps, and the scheduler's stamps
 *                                        (before `:id`, which would answer 400 for "switches")
 *   GET  /admin/repulls/dispatches       the automatic path's dispatches, newest first (`dataset`,
 *                                        `status`, `after`, `limit` up to 50; before `:id`, as
 *                                        above)
 *   GET  /admin/repulls/:id              one record
 *   POST /admin/repulls/:id/transition   move it along one allowed edge (the claim to merge is the
 *                                        gates-clear self-edge: screened head, dataset fences, a
 *                                        unit of REPULL_DAILY_MERGE_CAP; an administrator's claim
 *                                        may name a merge over a failed BIDS validation, whose
 *                                        facts it reads at the claimed head)
 *   GET  /admin/repulls/:id/screens      its identifier screens, newest first
 *   POST /admin/repulls/:id/screen       dispatch the screen of a pull request's recorded head
 *   POST /admin/repulls/:id/screen/acknowledge   record a reason on a screen that asks for one
 *   POST /admin/repulls/:id/merge-claim/release  clear a claim that was not sent, was refused, or
 *                                        is stuck (expired: its outcome unknown, long past)
 *   POST /admin/repulls/:id/merge-claim/check    whether a merge may be sent again under a held
 *                                        claim: the claim's age, the dataset fences, the screen
 *                                        for this administrator, the live head (writes nothing)
 *   POST /admin/repulls/:id/merged       record a merge, after reading it on GitHub
 *   POST /admin/repulls/:id/merge-trailers/accept   accept a squash or plain merge made without
 *                                        its trailers, after reading it on GitHub, and append the one
 *                                        ledger line that names it to `main`
 *   POST /admin/repulls/:id/released     record a release, after reading the version row and tag
 *
 * These routes record, verify and refuse. They copy nothing, open, merge or close no pull request
 * and send no mail: execution and the merge run on an administrator's machine and report here, the
 * Worker reads GitHub to verify what it records, and the dev database holds real addresses, so
 * nothing here is allowed to reach a person. The one write to a repository is the acceptance's
 * ledger line, a commit of NEMAR's own on `main` that touches the ledger only, as the scrub
 * runbook's ledger commit does (ADR 0111, the amendment of 2026-10-29). A refusal is
 * `{ error, code }`, a malformed request included (`invalid-body`, `invalid-query`, `invalid-id`);
 * the codes are the API. Admin role, as every `/admin` route.
 *
 * `lineage_recordable` on create is the administrator's assertion that the plan compared the
 * from-version's tree with upstream's. The Worker holds neither tree and cannot check it; it
 * records the assertion in the audit row and upgrades the version row only when that row names
 * the same tag (or none). An open record never expires by itself: a stuck claim is expired
 * through the claim's release (`expired`), which `nemar admin repull resume` sends.
 */

import { zValidator } from "@hono/zod-validator";
import {
  DISPATCH_STATUSES,
  type DispatchStatus,
  REPULL_ORIGINS,
  type RepullOrigin,
} from "../../../../shared/repull-state";
import { isValidDatasetId } from "../../services/datasetId";
import { repullSwitchesReport } from "../../services/repull-switches";
import {
  REPULL_PAGE_DEFAULT,
  REPULL_PAGE_MAX,
  type RepullRefusal,
  acknowledgeRepullScreen,
  acknowledgeScreenSchema,
  createRepull,
  createRepullSchema,
  dispatchRepullScreen,
  getRepull,
  isRefusal,
  listRepullScreens,
  listRepulls,
  screenTargetSchema,
  transitionRepull,
  transitionSchema,
} from "../../services/upstream-repull";
import { acceptMergeSchema, acceptRepullMerge } from "../../services/upstream-repull-acceptance";
import {
  DISPATCH_PAGE_DEFAULT,
  DISPATCH_PAGE_MAX,
  listDispatches,
} from "../../services/upstream-repull-dispatch";
import { bidsOverrideRefusal } from "../../services/upstream-repull-merge";
import { readSchedulerRow } from "../../services/upstream-repull-scheduler";
import {
  checkHeldClaim,
  claimCheckSchema,
  mergedSchema,
  recordRepullMerged,
  recordRepullReleased,
  releaseClaimSchema,
  releaseMergeClaim,
  releasedSchema,
} from "../../services/upstream-repull-verified";
import type { AdminRouter } from "./shared";

/** A refusal as the API speaks it: the code, the message, and what it is about when that helps. */
function refusalBody(r: RepullRefusal) {
  return {
    error: r.message,
    code: r.code,
    repull: r.row,
    ...(r.screen ? { screen: r.screen } : {}),
    ...(r.merge_cap ? { merge_cap: r.merge_cap } : {}),
  };
}

/**
 * Only a missing table or column suggests the migration is not applied; any other error is not
 * that. `migration` names the one that creates what the read needs: 0105 for the record, 0112 for
 * the automatic path's dispatches and scheduler.
 */
function failure(what: string, err: unknown, migration = "0105") {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[upstream-repulls] ${what} failed:`, msg);
  const hint = /no such (table|column)/i.test(msg) ? ` (is migration ${migration} applied?)` : "";
  return `Failed to ${what}${hint}: ${msg}`;
}

function parseId(raw: string): number | null {
  return /^[1-9]\d{0,14}$/.test(raw) ? Number(raw) : null;
}

/** A zod failure as `{ error, code }`, naming the fields and never echoing a value. */
const invalidBody = (
  result: { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } },
  c: { json: (body: unknown, status: 400) => Response },
) => {
  if (result.success) return undefined;
  const issues = (result.error?.issues ?? [])
    .slice(0, 5)
    .map((i) => `${i.path.map(String).join(".") || "body"}: ${i.message}`);
  return c.json(
    { error: `The request body is not valid: ${issues.join("; ")}`, code: "invalid-body" },
    400,
  );
};

export function registerUpstreamRepullRoutes(admin: AdminRouter): void {
  admin.post("/repulls", zValidator("json", createRepullSchema, invalidBody), async (c) => {
    const user = c.get("user");
    try {
      const result = await createRepull(c.env, { id: user.id }, c.req.valid("json"));
      if (isRefusal(result)) return c.json(refusalBody(result), result.status);
      return c.json(
        { repull: result.row, created: result.created, lineage_rows: result.lineage_rows },
        result.created ? 201 : 200,
      );
    } catch (err) {
      return c.json({ error: failure("record the re-pull", err) }, 500);
    }
  });

  admin.get("/repulls", async (c) => {
    const dataset = c.req.query("dataset");
    if (dataset !== undefined && !isValidDatasetId(dataset)) {
      return c.json({ error: "`dataset` must be a dataset id", code: "invalid-query" }, 400);
    }
    const openRaw = c.req.query("open");
    if (openRaw !== undefined && !["1", "true", "0", "false"].includes(openRaw)) {
      return c.json({ error: "`open` must be 1, true, 0 or false", code: "invalid-query" }, 400);
    }
    const origin = c.req.query("origin");
    if (origin !== undefined && !(REPULL_ORIGINS as readonly string[]).includes(origin)) {
      return c.json(
        { error: `\`origin\` must be one of ${REPULL_ORIGINS.join(", ")}`, code: "invalid-query" },
        400,
      );
    }
    const afterRaw = c.req.query("after");
    const after = afterRaw === undefined ? undefined : parseId(afterRaw);
    if (after === null)
      return c.json({ error: "`after` must be a re-pull id", code: "invalid-query" }, 400);
    const limitRaw = c.req.query("limit");
    const limit = limitRaw === undefined ? undefined : Number(limitRaw);
    if (
      limit !== undefined &&
      !(Number.isInteger(limit) && limit >= 1 && limit <= REPULL_PAGE_MAX)
    ) {
      return c.json(
        {
          error: `\`limit\` must be an integer from 1 to ${REPULL_PAGE_MAX}`,
          code: "invalid-query",
        },
        400,
      );
    }
    try {
      const repulls = await listRepulls(c.env.DB, {
        dataset,
        open: openRaw === "1" || openRaw === "true",
        after,
        origin: origin as RepullOrigin | undefined,
        limit,
      });
      return c.json({
        repulls,
        next_after:
          repulls.length === (limit ?? REPULL_PAGE_DEFAULT) ? (repulls.at(-1)?.id ?? null) : null,
      });
    } catch (err) {
      return c.json({ error: failure("read the re-pulls", err) }, 500);
    }
  });

  // Registered before `/repulls/:id`: Hono matches in registration order, and `:id` would answer
  // 400 `invalid-id` for "switches". It reads the bindings and the scheduler's one row and writes
  // nothing; the answer holds booleans, a cap reading and three stamps, never a binding's raw value,
  // a secret, or the scheduler's cursor (a dataset id).
  admin.get("/repulls/switches", async (c) => {
    try {
      return c.json({
        switches: repullSwitchesReport(c.env),
        scheduler: await readSchedulerRow(c.env.DB),
      });
    } catch (err) {
      return c.json({ error: failure("read the scheduler", err, "0112") }, 500);
    }
  });

  // The automatic path's dispatches, newest first, for an administrator: this route names the
  // dataset, which the weekly report never does. Also before `/repulls/:id`, for the same reason.
  // A keyset page: `after` is the id the page continues below, and `next_after` is set only when
  // the page is full. The nonce of a live dispatch is never selected (see `DISPATCH_LIST_SQL`).
  admin.get("/repulls/dispatches", async (c) => {
    const dataset = c.req.query("dataset");
    if (dataset !== undefined && !isValidDatasetId(dataset)) {
      return c.json({ error: "`dataset` must be a dataset id", code: "invalid-query" }, 400);
    }
    const status = c.req.query("status");
    if (status !== undefined && !(DISPATCH_STATUSES as readonly string[]).includes(status)) {
      return c.json(
        {
          error: `\`status\` must be one of ${DISPATCH_STATUSES.join(", ")}`,
          code: "invalid-query",
        },
        400,
      );
    }
    const afterRaw = c.req.query("after");
    const after = afterRaw === undefined ? undefined : parseId(afterRaw);
    if (after === null) {
      return c.json({ error: "`after` must be a dispatch id", code: "invalid-query" }, 400);
    }
    const limitRaw = c.req.query("limit");
    const limit = limitRaw === undefined ? undefined : Number(limitRaw);
    if (
      limit !== undefined &&
      !(Number.isInteger(limit) && limit >= 1 && limit <= DISPATCH_PAGE_MAX)
    ) {
      return c.json(
        {
          error: `\`limit\` must be an integer from 1 to ${DISPATCH_PAGE_MAX}`,
          code: "invalid-query",
        },
        400,
      );
    }
    try {
      const dispatches = await listDispatches(c.env.DB, {
        dataset,
        status: status as DispatchStatus | undefined,
        after,
        limit,
      });
      return c.json({
        dispatches,
        next_after:
          dispatches.length === (limit ?? DISPATCH_PAGE_DEFAULT)
            ? (dispatches.at(-1)?.id ?? null)
            : null,
      });
    } catch (err) {
      return c.json({ error: failure("read the dispatches", err, "0112") }, 500);
    }
  });

  admin.get("/repulls/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null)
      return c.json({ error: "the id must be a re-pull id", code: "invalid-id" }, 400);
    try {
      const row = await getRepull(c.env.DB, id);
      if (!row) return c.json({ error: `No re-pull #${id}.`, code: "not-found" }, 404);
      return c.json({ repull: row });
    } catch (err) {
      return c.json({ error: failure("read the re-pull", err) }, 500);
    }
  });

  admin.post(
    "/repulls/:id/transition",
    zValidator("json", transitionSchema, invalidBody),
    async (c) => {
      const id = parseId(c.req.param("id"));
      if (id === null)
        return c.json({ error: "the id must be a re-pull id", code: "invalid-id" }, 400);
      const user = c.get("user");
      try {
        // A claim to merge that names a merge over a failed BIDS validation has its facts read
        // here, at the claimed head; no other caller of the transition passes the reader.
        const result = await transitionRepull(c.env, { id: user.id }, id, c.req.valid("json"), {
          verifyBidsOverride: bidsOverrideRefusal,
        });
        if (isRefusal(result)) return c.json(refusalBody(result), result.status);
        return c.json({ repull: result.row });
      } catch (err) {
        return c.json({ error: failure("move the re-pull", err) }, 500);
      }
    },
  );

  admin.get("/repulls/:id/screens", async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null)
      return c.json({ error: "the id must be a re-pull id", code: "invalid-id" }, 400);
    try {
      const result = await listRepullScreens(c.env.DB, id);
      if (isRefusal(result)) return c.json(refusalBody(result), result.status);
      return c.json(result);
    } catch (err) {
      return c.json({ error: failure("read the re-pull's screens", err) }, 500);
    }
  });

  admin.post(
    "/repulls/:id/screen",
    zValidator("json", screenTargetSchema, invalidBody),
    async (c) => {
      const id = parseId(c.req.param("id"));
      if (id === null)
        return c.json({ error: "the id must be a re-pull id", code: "invalid-id" }, 400);
      const user = c.get("user");
      try {
        const result = await dispatchRepullScreen(c.env, { id: user.id }, id, c.req.valid("json"));
        if (isRefusal(result)) return c.json(refusalBody(result), result.status);
        const o = result.outcome;
        switch (o.kind) {
          case "exempt":
            return c.json({ exempt: true, dispatched: false, screen: null });
          case "dispatched":
            return c.json({ exempt: false, dispatched: true, screen: o.screen }, 202);
          case "exists":
            return c.json(
              {
                error: `A screen of this commit is ${o.screen.waiting ? "running" : "recorded"} (gate: ${o.screen.gate}); it is dispatched again only when it produced no verdict.`,
                code: "screen-exists",
                screen: o.screen,
              },
              409,
            );
          case "failed":
            return c.json(
              {
                error:
                  o.error === "dispatch-unconfigured"
                    ? "The screen could not be started: the Worker lacks the callback secret, the API base or a GitHub credential. It is recorded as an error, which no gate passes."
                    : "The screen could not be dispatched to GitHub. It is recorded as an error, which no gate passes; dispatch it again.",
                code: o.error,
                screen: o.screen,
              },
              o.error === "dispatch-unconfigured" ? 503 : 502,
            );
        }
      } catch (err) {
        return c.json({ error: failure("screen the re-pull", err) }, 500);
      }
    },
  );

  admin.post(
    "/repulls/:id/screen/acknowledge",
    zValidator("json", acknowledgeScreenSchema, invalidBody),
    async (c) => {
      const id = parseId(c.req.param("id"));
      if (id === null)
        return c.json({ error: "the id must be a re-pull id", code: "invalid-id" }, 400);
      const user = c.get("user");
      try {
        const result = await acknowledgeRepullScreen(
          c.env,
          { id: user.id },
          id,
          c.req.valid("json"),
        );
        if (isRefusal(result)) return c.json(refusalBody(result), result.status);
        return c.json({ screen: result.screen });
      } catch (err) {
        return c.json({ error: failure("acknowledge the screen", err) }, 500);
      }
    },
  );

  admin.post(
    "/repulls/:id/merge-claim/release",
    zValidator("json", releaseClaimSchema, invalidBody),
    async (c) => {
      const id = parseId(c.req.param("id"));
      if (id === null)
        return c.json({ error: "the id must be a re-pull id", code: "invalid-id" }, 400);
      const user = c.get("user");
      try {
        const result = await releaseMergeClaim(c.env, { id: user.id }, id, c.req.valid("json"));
        if (isRefusal(result)) return c.json(refusalBody(result), result.status);
        return c.json({ repull: result.row });
      } catch (err) {
        return c.json({ error: failure("release the claim", err) }, 500);
      }
    },
  );

  admin.post(
    "/repulls/:id/merge-claim/check",
    zValidator("json", claimCheckSchema, invalidBody),
    async (c) => {
      const id = parseId(c.req.param("id"));
      if (id === null)
        return c.json({ error: "the id must be a re-pull id", code: "invalid-id" }, 400);
      const user = c.get("user");
      try {
        const result = await checkHeldClaim(c.env, { id: user.id }, id, c.req.valid("json"));
        if (isRefusal(result)) return c.json(refusalBody(result), result.status);
        return c.json({ repull: result.row });
      } catch (err) {
        return c.json({ error: failure("check the claim", err) }, 500);
      }
    },
  );

  admin.post("/repulls/:id/merged", zValidator("json", mergedSchema, invalidBody), async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null)
      return c.json({ error: "the id must be a re-pull id", code: "invalid-id" }, 400);
    const user = c.get("user");
    try {
      const result = await recordRepullMerged(c.env, { id: user.id }, id, c.req.valid("json"));
      if (isRefusal(result)) return c.json(refusalBody(result), result.status);
      return c.json({
        repull: result.row,
        merged_outside_tool: result.merged_outside_tool,
        merged_unscreened_head: result.merged_unscreened_head,
        replayed: result.replayed,
      });
    } catch (err) {
      return c.json({ error: failure("record the merge", err) }, 500);
    }
  });

  admin.post(
    "/repulls/:id/merge-trailers/accept",
    zValidator("json", acceptMergeSchema, invalidBody),
    async (c) => {
      const id = parseId(c.req.param("id"));
      if (id === null)
        return c.json({ error: "the id must be a re-pull id", code: "invalid-id" }, 400);
      const user = c.get("user");
      try {
        const result = await acceptRepullMerge(c.env, { id: user.id }, id, c.req.valid("json"));
        if (isRefusal(result)) return c.json(refusalBody(result), result.status);
        return c.json(result);
      } catch (err) {
        return c.json({ error: failure("accept the merge", err, "0113") }, 500);
      }
    },
  );

  admin.post(
    "/repulls/:id/released",
    zValidator("json", releasedSchema, invalidBody),
    async (c) => {
      const id = parseId(c.req.param("id"));
      if (id === null)
        return c.json({ error: "the id must be a re-pull id", code: "invalid-id" }, 400);
      const user = c.get("user");
      try {
        const result = await recordRepullReleased(c.env, { id: user.id }, id, c.req.valid("json"));
        if (isRefusal(result)) return c.json(refusalBody(result), result.status);
        return c.json({
          repull: result.row,
          lineage_rows: result.lineage_rows,
          stamps_rearmed: result.stamps_rearmed,
          replayed: result.replayed,
        });
      } catch (err) {
        return c.json({ error: failure("record the release", err) }, 500);
      }
    },
  );
}
