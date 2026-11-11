/**
 * Tapis job status webhook: POST /tapis/:jobId/:token (epic #2005 phase A5, #2010; ADR 0118,
 * decision 6 of its Decision section, "Webhooks are hints"; design section 7, "Status updates").
 *
 * TAPIS DOES NOT SIGN WEBHOOKS, so a webhook is only a HINT. The address NEMAR subscribed carries a
 * token that is an HMAC (domain tag `compute-webhook`) over the job's id and its `webhook_nonce`;
 * the nonce must be non-null, and the sweep clears it one day after the job is terminal, so the
 * address stops working with it. The token is in a URL and so reaches Worker logs: that is why it is
 * bound to a nonce and expires, never why it is trusted.
 *
 * What the route does with a verified hint is the whole of the design: it IGNORES THE BODY, reads the
 * job back from Tapis itself (one attempt, a short ceiling) and gives it to `applyTapisJob`, the one
 * transition function the 30-minute tick and a cancel use too, which writes with `WHERE state =
 * <from>` and so makes a repeated, reordered or concurrent hint change nothing. A subscription cannot
 * be deduplicated, so a job may be hinted twice for one change; that is why advancing is idempotent.
 * The answer is `{ ok: true }` whether or not anything changed, and whether or not Tapis could be
 * read: Tapis's retry policy is undocumented, and the backstop poll carries a job whose read failed.
 *
 * EVERY REFUSAL IS ONE ANSWER: the same status and the same body for a wrong token, another job's
 * token, a cleared nonce, an unknown or malformed job id, a body over 16 KiB and a body that is not a
 * JSON object, so the door says nothing about which jobs exist or why it refused. The body is read
 * first, under its bound, so a refusal for it cannot be told from one for the token.
 *
 * The route reads no switch (a live job is never stranded by turning compute off) and no environment:
 * the development Worker advances its jobs by this route, and its jobs are its own.
 */

import { COMPUTE_JOB_ID_RE } from "../../../../shared/contract/compute.js";
import { REQUEST_READ, advanceComputeJob } from "../../services/compute-lifecycle.js";
import { NO_NONCE, verifyComputeToken } from "../../services/compute-tokens.js";
import type { WebhookContext, WebhookRouter } from "../webhooks/shared.js";
import { readBoundedJsonObject } from "./bounded-json.js";

/** A status hint is a few hundred bytes; anything larger is not one. */
const MAX_HINT_BYTES = 16 * 1024;

/** The one refusal: the same status and body whatever the reason. */
const refusal = (c: WebhookContext) => c.json({ error: "Not found.", code: "not_found" }, 404);

export function registerTapisCallbackRoutes(webhooks: WebhookRouter): void {
  webhooks.post("/tapis/:jobId/:token", async (c) => {
    const jobId = c.req.param("jobId");
    const token = c.req.param("token");
    // The body first: a refusal for it is the same answer as one for the token.
    const body = await readBoundedJsonObject(c, MAX_HINT_BYTES);
    const secret = c.env.PRESCREEN_CALLBACK_SECRET;
    if (!body.ok || !secret || !COMPUTE_JOB_ID_RE.test(jobId)) return refusal(c);

    const row = await c.env.DB.prepare("SELECT webhook_nonce FROM compute_jobs WHERE id = ?1")
      .bind(jobId)
      .first<{ webhook_nonce: string | null }>();
    const nonce = row?.webhook_nonce ?? null;
    const valid = await verifyComputeToken(
      "webhook",
      token,
      { jobId, nonce: nonce ?? NO_NONCE },
      secret,
    );
    if (!valid || nonce === null) return refusal(c);

    // A hint. Its body is never read; the job is read back from Tapis before anything is written.
    try {
      const answer = await advanceComputeJob(c.env, jobId, { read: REQUEST_READ });
      if (answer.outcome === "advanced" || answer.outcome === "terminal_committed") {
        console.log(`[compute-webhook] job=${jobId} ${answer.outcome}`);
      }
    } catch (err) {
      console.error(
        `[compute-webhook] job=${jobId} step failed (${err instanceof Error ? err.name : typeof err})`,
      );
    }
    return c.json({ ok: true });
  });
}
