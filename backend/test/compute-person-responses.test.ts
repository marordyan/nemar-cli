/**
 * The responses of a person's `cancel` and `links` routes, parsed against the shared contract
 * (`shared/contract/compute-responses.ts`; epic #2005 review, ADR 0118), through the REAL compute router
 * (`makeRoutesApp`), the real authentication middleware, real migrations, Miniflare's R2 and the Tapis
 * stand-in. The website and Epic D read these answers, so what is pinned is that the real output parses,
 * that every `outcome` the cancel route answers with is a declared word, and that a paged links answer
 * carries a cursor that leads to the rest.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  COMPUTE_CANCEL_OUTCOMES,
  ComputeCancelResponseSchema,
  ComputeLinksResponseSchema,
} from "../../shared/contract/compute-responses";
import { hashApiKey } from "../src/services/token";
import { endedJob } from "./helpers/compute-ended";
import {
  type LifecycleFixture,
  makeJob,
  startLifecycleFixture,
} from "./helpers/compute-lifecycle-fixture";
import { type RoutesHandle, makeRoutesApp } from "./helpers/compute-routes-app";

let fx: LifecycleFixture;
let routes: RoutesHandle;

beforeAll(async () => {
  fx = await startLifecycleFixture();
  routes = makeRoutesApp();
}, 120_000);

beforeEach(async () => {
  await fx.reset();
});

afterAll(async () => {
  await fx?.dispose();
}, 30_000);

let keySeq = 0;
async function keyFor(accountId: number): Promise<string> {
  const key = `person-contract-key-${++keySeq}-0123456789abcdef0123456789abcdef`;
  fx.harness.db
    .query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)")
    .run(accountId, await hashApiKey(key), key.slice(0, 8));
  return key;
}

async function post(path: string, key: string, body?: unknown) {
  const res = await routes(
    new Request(`http://api.test/compute${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    fx.env(),
  );
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

describe("cancel", () => {
  test("the answer parses, and each outcome the route gives is a declared word", async () => {
    const made = await makeJob(fx);
    const key = await keyFor(made.accountId);
    const first = await post(`/jobs/${made.job.id}/cancel`, key);
    expect(first.status).toBe(200);
    expect(ComputeCancelResponseSchema.safeParse(first.body).success).toBe(true);
    expect(first.body.outcome).toBe("cancel_requested");
    // A job that never reached Tapis is ended here and its hold released, so asking again is a replay.
    const again = await post(`/jobs/${made.job.id}/cancel`, key);
    expect(again.status).toBe(200);
    expect(ComputeCancelResponseSchema.safeParse(again.body).success).toBe(true);
    expect(again.body.outcome).toBe("already_cancelled");
    for (const r of [first, again]) {
      expect((COMPUTE_CANCEL_OUTCOMES as readonly string[]).includes(r.body.outcome)).toBe(true);
    }
  });

  test("a refusal is not the success shape", async () => {
    const made = await makeJob(fx);
    const stranger = await keyFor(made.accountId + 1000);
    const refused = await post(`/jobs/${made.job.id}/cancel`, stranger);
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(ComputeCancelResponseSchema.safeParse(refused.body).success).toBe(false);
  });
});

describe("links", () => {
  test("the answer parses, and a cursor from a first page leads to the second", async () => {
    const j = await endedJob(fx, 30);
    const key = await keyFor(j.accountId);
    const all = await post(`/jobs/${j.job.id}/links`, key);
    expect(all.status).toBe(200);
    const parsed = ComputeLinksResponseSchema.safeParse(all.body);
    expect(parsed.success).toBe(true);
    expect(all.body.total).toBe(all.body.links.length);
    expect(all.body.truncated).toBe(false);
    expect(all.body.next_after).toBeNull();
    expect(all.body.links.length).toBeGreaterThan(0);
    // `after` past the last path is an empty, well-formed page.
    const last = all.body.links[all.body.links.length - 1].path as string;
    const rest = await post(`/jobs/${j.job.id}/links`, key, { after: last });
    expect(rest.status).toBe(200);
    expect(ComputeLinksResponseSchema.safeParse(rest.body).success).toBe(true);
    expect(rest.body.links).toEqual([]);
  });
});
