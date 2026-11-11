/**
 * An administrator's two job commands, `POST /admin/compute/jobs/:id/cancel` and `.../advance` (epic
 * #2005 phase A5, #2010; ADR 0118), through the REAL admin router with its real authentication, admin
 * and cookie-origin middleware, over real migrated SQLite with real API keys, Miniflare's R2 and the
 * Tapis stand-in (no response of which was recorded from a real tenant).
 *
 * What is pinned: a member and a signed-out caller are refused; `advance` submits a `created` job (the
 * way a job advances in development, where no compute cron runs), follows a submitted one through every
 * Tapis status and settles it, and repairs nothing it should not; `cancel` ends a job that never started
 * and cancels a running one at Tapis; an unknown job and a malformed id are `job_not_found`; and what an
 * administrator is shown is fixed words, numbers and times, `platform_failure` as an information flag,
 * and never an identity, a specification, a token, an address or a log.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ComputeJobAdminResponseSchema } from "../../shared/contract/compute-admin";
import type { Bindings } from "../src/types/bindings";
import {
  COMPUTE_KEYS,
  type ComputeWho,
  makeComputeApp,
  seedComputeUsers,
} from "./helpers/compute-app";
import {
  type LifecycleFixture,
  MINUTE,
  jobTokenSeenByTapis,
  launchSpecEnvSeenByTapis,
  makeJob,
  playLauncher,
  reread,
  setTapisTimes,
  startLifecycleFixture,
} from "./helpers/compute-lifecycle-fixture";
import { launchSecretForms } from "./helpers/launch-secret-forms";

let fx: LifecycleFixture;
const handle = makeComputeApp();

beforeAll(async () => {
  fx = await startLifecycleFixture();
}, 120_000);

beforeEach(async () => {
  await fx.reset();
  await seedComputeUsers(fx.harness.db);
});

afterAll(async () => {
  await fx?.dispose();
}, 30_000);

interface Reply {
  status: number;
  text: string;
  body: Record<string, any>;
}

async function post(path: string, who: ComputeWho | null): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (who) headers.Authorization = `Bearer ${COMPUTE_KEYS[who]}`;
  const res = await handle(
    new Request(`http://api.test/admin${path}`, { method: "POST", headers }),
    fx.env() as Bindings,
  );
  const text = await res.text();
  let body: Record<string, any> = {};
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, text, body };
}

describe("who may", () => {
  test("an administrator and an owner may, a member and a stranger may not", async () => {
    const made = await makeJob(fx);
    for (const route of ["cancel", "advance"]) {
      const path = `/compute/jobs/${made.job.id}/${route}`;
      expect((await post(path, "member")).status).toBe(403);
      expect((await post(path, null)).status).toBe(401);
    }
    expect((await post(`/compute/jobs/${made.job.id}/advance`, "admin")).status).toBe(200);
    expect((await post(`/compute/jobs/${made.job.id}/cancel`, "owner")).status).toBe(200);
  });

  test("an unknown job and a malformed id are `job_not_found`", async () => {
    for (const route of ["cancel", "advance"]) {
      for (const id of ["job_000000000000000000000000", "nope", "job_XYZ"]) {
        const res = await post(`/compute/jobs/${id}/${route}`, "admin");
        expect([id, route, res.status, res.body.code]).toEqual([id, route, 404, "job_not_found"]);
      }
    }
  });
});

describe("advance", () => {
  test("it submits a created job, follows it, and settles it, one step a call", async () => {
    const made = await makeJob(fx);
    const id = made.job.id;
    const first = await post(`/compute/jobs/${id}/advance`, "admin");
    expect(first.status).toBe(200);
    expect(ComputeJobAdminResponseSchema.safeParse(first.body).success).toBe(true);
    expect(first.body).toMatchObject({ ok: true, outcome: "submitted", submit: "submitted" });
    expect(first.body.job).toMatchObject({ id, state: "submitted", tapis_status: "PENDING" });

    const uuid = (await reread(made.env, id)).tapis_uuid as string;
    fx.tapis.advance(uuid, "RUNNING");
    const second = await post(`/compute/jobs/${id}/advance`, "admin");
    expect(second.body).toMatchObject({ outcome: "advanced", job: { state: "running" } });
    // Again, with nothing new: a refresh, never a second submit or a second charge.
    expect((await post(`/compute/jobs/${id}/advance`, "admin")).body.outcome).toBe("refreshed");

    await playLauncher(fx, made.env, await reread(made.env, id), uuid, {});
    fx.tapis.advance(uuid, "FINISHED");
    setTapisTimes(fx, uuid, 30 * MINUTE, 0);
    const done = await post(`/compute/jobs/${id}/advance`, "admin");
    expect(done.body.job).toMatchObject({
      state: "finished",
      charged_milli: 2000,
      settled: true,
      platform_failure: false,
      results_verified: true,
      records_copied: true,
    });
    expect((await post(`/compute/jobs/${id}/advance`, "admin")).body.outcome).toBe("terminal");
    expect(fx.tapis.log.filter((r) => r.route === "POST /v3/jobs/submit")).toHaveLength(1);
  });

  test("a job that cannot be submitted says why in a fixed word", async () => {
    const made = await makeJob(fx);
    const off = { ...fx.env(), COMPUTE_ENABLED: undefined } as Bindings;
    const res = await handle(
      new Request(`http://api.test/admin/compute/jobs/${made.job.id}/advance`, {
        method: "POST",
        headers: { Authorization: `Bearer ${COMPUTE_KEYS.admin}` },
      }),
      off,
    );
    const body = (await res.json()) as Record<string, any>;
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, outcome: "waiting", submit: "compute_disabled" });
    expect(body.job.state).toBe("created");
  });
});

describe("cancel", () => {
  test("a job that never started is ended and released; a running one is cancelled at Tapis", async () => {
    const waiting = await makeJob(fx);
    const a = await post(`/compute/jobs/${waiting.job.id}/cancel`, "admin");
    expect(a.body).toMatchObject({
      ok: true,
      outcome: "cancel_requested",
      job: { state: "cancelled", cancel_reason: "admin" },
    });

    const running = await makeJob(fx);
    await post(`/compute/jobs/${running.job.id}/advance`, "admin");
    const uuid = (await reread(running.env, running.job.id)).tapis_uuid as string;
    fx.tapis.advance(uuid, "RUNNING");
    await post(`/compute/jobs/${running.job.id}/advance`, "admin");
    const b = await post(`/compute/jobs/${running.job.id}/cancel`, "owner");
    expect(b.body.job).toMatchObject({ state: "cancelled", cancel_reason: "admin" });
    expect(fx.tapis.log.some((r) => r.route === "POST /v3/jobs/:uuid/cancel")).toBe(true);
  });

  test("a job that has ended otherwise is refused with `bad_state`", async () => {
    const made = await makeJob(fx);
    await post(`/compute/jobs/${made.job.id}/advance`, "admin");
    const uuid = (await reread(made.env, made.job.id)).tapis_uuid as string;
    fx.tapis.advance(uuid, "FAILED", "JOB_LAUNCH_FAILURE");
    await post(`/compute/jobs/${made.job.id}/advance`, "admin");
    const res = await post(`/compute/jobs/${made.job.id}/cancel`, "admin");
    expect([res.status, res.body.code]).toEqual([409, "bad_state"]);
  });
});

describe("what an administrator is shown", () => {
  test("fixed words and numbers, `platform_failure` as an information flag, and no identity, specification, token, address or log", async () => {
    const made = await makeJob(fx);
    await post(`/compute/jobs/${made.job.id}/advance`, "admin");
    const uuid = (await reread(made.env, made.job.id)).tapis_uuid as string;
    const token = jobTokenSeenByTapis(fx, uuid);
    // The value Tapis holds carries the token, and the plain token is not a substring of it.
    const launchValue = launchSpecEnvSeenByTapis(fx, uuid);
    fx.tapis.setOutput(uuid, "tapisjob.out", "A LINE THE USER'S CODE PRINTED");
    fx.tapis.advance(uuid, "RUNNING");
    await post(`/compute/jobs/${made.job.id}/advance`, "admin");
    fx.tapis.advance(uuid, "FAILED", "JOB_LAUNCH_FAILURE");
    setTapisTimes(fx, uuid, 30 * MINUTE, 0);
    const res = await post(`/compute/jobs/${made.job.id}/advance`, "admin");
    expect(res.body.job).toMatchObject({
      state: "failed",
      failure_code: "launch_failed",
      platform_failure: true,
      charged_milli: 2000,
    });
    const text = res.text;
    const user = fx.harness.db
      .query("SELECT username, email, given_name, orcid FROM users WHERE id = ?")
      .get(made.accountId) as Record<string, string | null>;
    for (const word of [
      ...launchSecretForms(token, launchValue),
      "NEMAR_LAUNCH_SPEC",
      "A LINE THE USER'S CODE PRINTED",
      fx.tapis.url,
      "X-Amz",
      "analyse",
      "nm000104",
      user.email ?? "@@",
      user.username ?? "@@",
      user.orcid ?? "@@",
    ]) {
      expect([word, text.includes(word)]).toEqual([word, false]);
    }
  });
});
