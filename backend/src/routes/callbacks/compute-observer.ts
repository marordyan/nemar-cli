/**
 * The observer's post (epic #2005 phase A7, #2012; ADR 0118, decision 8; design section 8):
 *
 *   POST /compute/observer     Expanse's queue summary and `sacct` export, with a token for ONE run
 *
 * The observer runs on the cluster and holds no account: it is an UNSIGNED SENDER with a token an
 * administrator minted for one run (`mintObserverRun`), sent as `Authorization: Bearer <token>` (never in
 * a URL, which reaches logs). What it posts is its own `nemar.observation.v1` document, which the Worker
 * adopted as it is (owner decision of 2026-11-06; `shared/contract/compute-observation.ts`) and maps to
 * the rows it stores (`services/compute-observation.ts`). The route follows `routes/callbacks/repull-state.ts`: a bounded
 * body, a token checked in constant time against the run row, and ONE refusal for every reason the token
 * is not accepted (a wrong token, a spent run, an expired run, an unknown run, no header), the same
 * status and body, so the door says nothing about which runs exist or why it refused.
 *
 * Order: the token is checked FIRST, before a byte of the body is read (a door open to anyone must not
 * spend memory on a stranger's payload), then the body is read under 1 MiB, validated as the document
 * and mapped to rows, and only then is the run spent. A body that fails validation or mapping (a wrong
 * `schema`, an unknown key, an allocation that cannot be read) does not spend the run, and is one answer:
 * 400 `invalid_post` with the paths and fixed words of what is wrong. Nothing is logged but counts: no
 * token, no job id, no body.
 */

import type { Hono } from "hono";
import { ObservationDocumentSchema } from "../../../../shared/contract/compute-observation.js";
import { mapObservation, observationIssueFields } from "../../services/compute-observation.js";
import {
  OBSERVER_BODY_MAX_BYTES,
  authorizeObserverRun,
  ingestObserverPost,
  observerBearerToken,
} from "../../services/compute-observer.js";
import type { Bindings, Variables } from "../../types/bindings.js";
import { readBoundedJsonObject } from "./bounded-json.js";

type Router = Hono<{ Bindings: Bindings; Variables: Variables }>;

/** The one refusal of a token: never says why. */
export const OBSERVER_REFUSAL = { error: "Not accepted.", code: "observer_refused" } as const;

export function registerComputeObserverRoute(router: Router): void {
  router.post("/observer", async (c) => {
    const run = await authorizeObserverRun(
      c.env,
      observerBearerToken(c.req.header("Authorization")),
    );
    if (run === null) return c.json(OBSERVER_REFUSAL, 403);
    const read = await readBoundedJsonObject(c, OBSERVER_BODY_MAX_BYTES);
    if (!read.ok) {
      return c.json(
        { error: "The post is not valid.", code: "invalid_post" },
        read.status === 413 ? 413 : 400,
      );
    }
    const parsed = ObservationDocumentSchema.safeParse(read.body);
    if (!parsed.success) {
      // The paths and codes of what is wrong, never a value or a key the sender wrote.
      const fields = observationIssueFields(parsed.error.issues);
      return c.json({ error: "The post is not valid.", code: "invalid_post", fields }, 400);
    }
    const mapped = mapObservation(parsed.data);
    if (!mapped.ok) {
      return c.json(
        { error: "The post is not valid.", code: "invalid_post", fields: mapped.fields },
        400,
      );
    }
    const result = await ingestObserverPost(c.env, run.id, mapped.mapped.body);
    if (result === null) return c.json(OBSERVER_REFUSAL, 403);
    const { skipped, truncated } = mapped.mapped;
    console.log(
      `[compute-observer] ingested mode=${parsed.data.mode} snapshots=${result.snapshots} rows=${result.sacctRows} skipped=${skipped.partitions + skipped.jobs} matched=${result.matched} settled=${result.settled} mismatched=${result.mismatched} unmatched=${result.unmatched}`,
    );
    // The wire is snake_case (`ComputeObserverIngestResponseSchema`); the service's result keeps its
    // camelCase names, so the two keys are renamed HERE and not spread, which would put them on the wire.
    const { sacctRows, settlementFailed, ...counts } = result;
    return c.json({
      ok: true,
      ...counts,
      sacct_rows: sacctRows,
      skipped: skipped.partitions + skipped.jobs,
      ...(settlementFailed ? { settlement_failed: true } : {}),
      ...(truncated ? { truncated: true } : {}),
    });
  });
}
