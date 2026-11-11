/**
 * The Tapis webhook, `POST /webhooks/tapis/:jobId/:token` (epic #2005 phase A5, #2010; ADR 0118,
 * decision 6), through the REAL webhooks router on a real loopback port, with the Tapis stand-in firing
 * the webhook at the very address the Worker subscribed (the stand-in recorded no response from a real
 * tenant). Real migrations, the real ledger, Miniflare's R2.
 *
 * What is pinned: a webhook is a HINT. The route ignores its body and reads the job back from Tapis
 * before it writes (MUTATION: take the status from the body and the test that sends a hint saying
 * FINISHED for a job Tapis says is RUNNING fails); every refusal is ONE answer (a wrong token, another
 * job's token, a cleared nonce, an unknown and a malformed job id, an oversize body and a body that is
 * not JSON), so the door says nothing about which jobs exist; a stale hint after the job ended, a
 * replay and a hint while Tapis is down change nothing; the token expires with the nonce one day after
 * the job is terminal; no switch is read; and nothing the route logs holds a token or a path.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { runComputeAdvanceCron } from "../src/services/compute-advance";
import { submitComputeJob } from "../src/services/compute-lifecycle";
import { signComputeToken } from "../src/services/compute-tokens";
import type { Bindings } from "../src/types/bindings";
import { recordAbortTimeouts } from "./helpers/abort-timeouts";
import {
  CALLBACK_SECRET,
  type LifecycleFixture,
  MINUTE,
  makeJob,
  playLauncher,
  reread,
  setTapisTimes,
  startLifecycleFixture,
} from "./helpers/compute-lifecycle-fixture";
import { type RoutesHandle, makeRoutesApp, serveRoutes } from "./helpers/compute-routes-app";
import { logged } from "./helpers/logs";

let fx: LifecycleFixture;
let handle: RoutesHandle;
let server: Server;
/** The Worker environment the served routes use; `API_BASE_URL` is the served address. */
let workerEnv: Bindings;

beforeAll(async () => {
  fx = await startLifecycleFixture();
  // The REAL access logger is mounted, as in the entry point: what a line holds is what production prints.
  handle = makeRoutesApp({ accessLog: true });
}, 120_000);

beforeEach(async () => {
  await fx.reset();
  server = serveRoutes(handle, () => workerEnv);
  workerEnv = fx.env({ API_BASE_URL: `http://127.0.0.1:${server.port}` });
});

afterEach(() => {
  server.stop(true);
});

afterAll(async () => {
  await fx?.dispose();
}, 30_000);

/** A job submitted through the Worker with its webhook subscribed to the served address. */
async function submitted() {
  const made = await makeJob(fx, { env: workerEnv });
  expect(await submitComputeJob(workerEnv, made.job.id)).toEqual({
    ok: true,
    outcome: "submitted",
  });
  const job = await reread(workerEnv, made.job.id);
  return { made, job, uuid: job.tapis_uuid as string };
}

const hookUrl = (jobId: string, token: string) =>
  `http://127.0.0.1:${server.port}/webhooks/tapis/${jobId}/${token}`;

async function post(url: string, body: BodyInit = JSON.stringify({ hint: "status" })) {
  const res = await fetch(url, {
    method: "POST",
    body,
    headers: { "Content-Type": "application/json" },
  });
  return { status: res.status, text: await res.text() };
}

async function webhookToken(jobId: string): Promise<string> {
  const job = await reread(workerEnv, jobId);
  return signComputeToken(
    "webhook",
    { jobId, nonce: job.webhook_nonce as string },
    CALLBACK_SECRET,
  );
}

async function ledgerKinds(jobId: string): Promise<string[]> {
  return (
    await workerEnv.DB.prepare("SELECT kind FROM compute_ledger WHERE job_id = ?1 ORDER BY id")
      .bind(jobId)
      .all<{ kind: string }>()
  ).results.map((r) => r.kind);
}

describe("a webhook is a hint, and the job is read back from Tapis", () => {
  test("the stand-in fires the address the Worker subscribed, and the job follows Tapis", async () => {
    const s = await submitted();
    fx.tapis.advance(s.uuid, "QUEUED");
    const fired = await fx.tapis.fireWebhook(s.uuid);
    expect(fired.status).toBe(200);
    expect(JSON.parse(fired.body)).toEqual({ ok: true });
    expect((await reread(workerEnv, s.job.id)).state).toBe("queued");
    fx.tapis.advance(s.uuid, "RUNNING");
    await fx.tapis.fireWebhook(s.uuid);
    expect((await reread(workerEnv, s.job.id)).state).toBe("running");
  });

  test("the body is ignored: a hint that says FINISHED moves nothing while Tapis says RUNNING (MUTATION: take the status from the body)", async () => {
    const s = await submitted();
    fx.tapis.advance(s.uuid, "RUNNING");
    const token = await webhookToken(s.job.id);
    const lying = JSON.stringify({
      type: "jobs.JOB_NEW_STATUS.FINISHED",
      data: { newJobStatus: "FINISHED", jobUuid: s.uuid },
    });
    const res = await post(hookUrl(s.job.id, token), lying);
    expect(res.status).toBe(200);
    const job = await reread(workerEnv, s.job.id);
    expect(job.state).toBe("running");
    expect(job.tapis_status).toBe("RUNNING");
    expect(await ledgerKinds(s.job.id)).toEqual(["hold"]);
    // And the read-back happened: the hint made the Worker ask Tapis.
    expect(
      fx.tapis.log.filter((r) => r.route === "GET /v3/jobs/:uuid").length,
    ).toBeGreaterThanOrEqual(1);
  });

  test("a hint repeated after the job FINISHED, and one the stand-in fires from its own event log, change nothing", async () => {
    const s = await submitted();
    fx.tapis.advance(s.uuid, "RUNNING");
    await playLauncher(fx, workerEnv, await reread(workerEnv, s.job.id), s.uuid, {});
    fx.tapis.advance(s.uuid, "FINISHED");
    setTapisTimes(fx, s.uuid, 30 * MINUTE, 0);
    const token = await webhookToken(s.job.id);
    expect((await post(hookUrl(s.job.id, token))).status).toBe(200);
    const finished = await reread(workerEnv, s.job.id);
    expect(finished.state).toBe("finished");
    expect(await ledgerKinds(s.job.id)).toEqual(["hold", "charge"]);
    const mails = fx.mail.mails.length;
    // The stale hint, the same hint again, and a hint from the stand-in's own event log.
    for (let i = 0; i < 3; i++) expect((await post(hookUrl(s.job.id, token))).status).toBe(200);
    expect((await fx.tapis.fireWebhook(s.uuid)).status).toBe(200);
    const after = await reread(workerEnv, s.job.id);
    expect(after.state).toBe("finished");
    expect(after.charged_milli).toBe(finished.charged_milli);
    expect(after.settled_provisional_at).toBe(finished.settled_provisional_at);
    expect(await ledgerKinds(s.job.id)).toEqual(["hold", "charge"]);
    expect(fx.mail.mails).toHaveLength(mails);
  });

  test("two webhooks at once (a subscription cannot be deduplicated) settle once", async () => {
    const s = await submitted();
    fx.tapis.advance(s.uuid, "RUNNING");
    setTapisTimes(fx, s.uuid, 30 * MINUTE, 0);
    fx.tapis.advance(s.uuid, "FAILED", "JOB_LAUNCH_FAILURE");
    setTapisTimes(fx, s.uuid, 30 * MINUTE, 0);
    const token = await webhookToken(s.job.id);
    const results = await Promise.all([1, 2, 3].map(() => post(hookUrl(s.job.id, token))));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    const job = await reread(workerEnv, s.job.id);
    expect(job.state).toBe("failed");
    expect(await ledgerKinds(s.job.id)).toEqual(["hold", "charge"]);
  });

  test("a hint while Tapis is down is answered ok, changes nothing, and the tick catches up", async () => {
    const s = await submitted();
    fx.tapis.advance(s.uuid, "RUNNING");
    const token = await webhookToken(s.job.id);
    fx.tapis.down();
    try {
      const started = Date.now();
      const res = await post(hookUrl(s.job.id, token));
      expect(res.status).toBe(200);
      // One attempt and a short ceiling: not the 46 seconds the client's defaults allow a read.
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      fx.tapis.up();
    }
    expect((await reread(workerEnv, s.job.id)).state).toBe("submitted");
    await runComputeAdvanceCron(workerEnv);
    expect((await reread(workerEnv, s.job.id)).state).toBe("running");
  });

  test("the route reads no switch: a live job advances with compute switched off", async () => {
    const s = await submitted();
    workerEnv = { ...workerEnv, COMPUTE_ENABLED: undefined } as Bindings;
    fx.tapis.advance(s.uuid, "RUNNING");
    expect((await post(hookUrl(s.job.id, await webhookToken(s.job.id)))).status).toBe(200);
    expect((await reread(workerEnv, s.job.id)).state).toBe("running");
  });
});

describe("every refusal is one answer", () => {
  test("a wrong token, another job's token, a cleared nonce, an unknown and a malformed id, an oversize body and a body that is not JSON", async () => {
    const a = await submitted();
    const b = await submitted();
    fx.tapis.advance(a.uuid, "RUNNING");
    const good = await webhookToken(a.job.id);
    const other = await webhookToken(b.job.id);
    const cleared = await submitted();
    await workerEnv.DB.prepare("UPDATE compute_jobs SET webhook_nonce = NULL WHERE id = ?")
      .bind(cleared.job.id)
      .run();
    const clearedToken = await signComputeToken(
      "webhook",
      { jobId: cleared.job.id, nonce: cleared.job.webhook_nonce as string },
      CALLBACK_SECRET,
    );
    const attempts: Array<[string, string, BodyInit | undefined]> = [
      ["a wrong token", hookUrl(a.job.id, "0".repeat(64)), undefined],
      ["an empty-looking token", hookUrl(a.job.id, "x"), undefined],
      ["another job's token", hookUrl(a.job.id, other), undefined],
      [
        "a job token in place of the webhook token",
        hookUrl(
          a.job.id,
          await signComputeToken(
            "job",
            { jobId: a.job.id, nonce: a.job.webhook_nonce as string },
            CALLBACK_SECRET,
          ),
        ),
        undefined,
      ],
      ["a cleared nonce", hookUrl(cleared.job.id, clearedToken), undefined],
      [
        "a token minted for the placeholder a missing nonce is checked against",
        hookUrl(
          cleared.job.id,
          await signComputeToken(
            "webhook",
            { jobId: cleared.job.id, nonce: "00000000-0000-0000-0000-000000000000" },
            CALLBACK_SECRET,
          ),
        ),
        undefined,
      ],
      ["an unknown job", hookUrl("job_000000000000000000000000", good), undefined],
      ["a malformed id", hookUrl("not-a-job", good), undefined],
      ["an oversize body", hookUrl(a.job.id, good), "x".repeat(16 * 1024 + 1)],
      ["a body that is not JSON", hookUrl(a.job.id, good), "this is not json"],
      ["a body that is a JSON array", hookUrl(a.job.id, good), "[1, 2]"],
    ];
    const answers: Array<{ status: number; text: string }> = [];
    for (const [, url, body] of attempts) answers.push(await post(url, body ?? JSON.stringify({})));
    const first = answers[0];
    for (const [i, answer] of answers.entries()) {
      expect([attempts[i]?.[0], answer]).toEqual([attempts[i]?.[0], first]);
    }
    expect(first?.status).toBe(404);
    // None of them moved anything: Tapis was never read for them.
    expect(fx.tapis.log.filter((r) => r.route === "GET /v3/jobs/:uuid")).toHaveLength(0);
    expect((await reread(workerEnv, a.job.id)).state).toBe("submitted");
    // The good token works: the answers were about the token and the body, not the route.
    expect((await post(hookUrl(a.job.id, good))).status).toBe(200);
    expect((await reread(workerEnv, a.job.id)).state).toBe("running");
  });

  test("a Worker with no callback secret refuses every hint the same way", async () => {
    const s = await submitted();
    const token = await webhookToken(s.job.id);
    workerEnv = { ...workerEnv, PRESCREEN_CALLBACK_SECRET: undefined } as Bindings;
    expect((await post(hookUrl(s.job.id, token))).status).toBe(404);
  });
});

describe("the address expires with the nonce", () => {
  test("a webhook still works the day the job ends, and stops once the sweep clears the nonce a day later", async () => {
    const s = await submitted();
    fx.tapis.advance(s.uuid, "RUNNING");
    fx.tapis.advance(s.uuid, "FAILED", "JOB_LAUNCH_FAILURE");
    setTapisTimes(fx, s.uuid, 5 * MINUTE, 0);
    const token = await webhookToken(s.job.id);
    expect((await post(hookUrl(s.job.id, token))).status).toBe(200);
    expect((await reread(workerEnv, s.job.id)).state).toBe("failed");
    // Tapis may resend a webhook after the end: still accepted, still a no-op.
    expect((await post(hookUrl(s.job.id, token))).status).toBe(200);
    await workerEnv.DB.prepare(
      "UPDATE compute_jobs SET ended_at = datetime('now', '-25 hours') WHERE id = ?",
    )
      .bind(s.job.id)
      .run();
    await runComputeAdvanceCron(workerEnv);
    expect((await reread(workerEnv, s.job.id)).webhook_nonce).toBeNull();
    expect((await post(hookUrl(s.job.id, token))).status).toBe(404);
  });
});

describe("logs", () => {
  // Round 1 of #2041: this test used to run on an app WITHOUT the Worker's access logger, so it proved
  // only what the route itself logs. The app now mounts the real logger, whose lines carry the path.
  test("with the Worker's own access logger mounted, no token or secret reaches a log line, and the line names the job and nothing after it", async () => {
    const s = await submitted();
    fx.tapis.advance(s.uuid, "RUNNING");
    const token = await webhookToken(s.job.id);
    const lines = await logged(async () => {
      await post(hookUrl(s.job.id, "f".repeat(64)));
      await post(hookUrl(s.job.id, token));
      await post(`http://127.0.0.1:${server.port}/webhooks/tapis/${"e".repeat(64)}`);
      fx.tapis.down();
      try {
        await post(hookUrl(s.job.id, token));
      } finally {
        fx.tapis.up();
      }
    });
    const joined = lines.join("\n");
    for (const word of [
      token,
      "f".repeat(64),
      "e".repeat(64),
      CALLBACK_SECRET,
      fx.tapis.password,
    ]) {
      expect([word, joined.includes(word)]).toEqual([word, false]);
    }
    // The access logger DID log these requests (a test that saw no line would prove nothing): the
    // incoming and outgoing line of each, with the job id and the token replaced.
    const hookLines = lines.filter((l) => l.includes("/webhooks/tapis/"));
    expect(hookLines.length).toBeGreaterThanOrEqual(8);
    for (const line of hookLines) {
      expect(line).toMatch(/\/webhooks\/tapis\/(job_[0-9a-f]{24}|\[redacted\])\/\[redacted\]/);
    }
  });
});

// Round 1 of #2041: the switch is read at submit and nowhere else. A job that is already on a cluster
// must settle when compute is turned off, or its hold stays open for good. The scan twin is
// `compute-source-scan.test.ts`; this is the behaviour.
describe("a job that ends while compute is switched OFF is still settled", () => {
  const ways = ["a webhook", "the tick"] as const;
  const endings = ["FAILED", "FINISHED"] as const;
  for (const way of ways) {
    for (const ending of endings) {
      test(`${ending} through ${way}`, async () => {
        const s = await submitted();
        fx.tapis.advance(s.uuid, "RUNNING");
        if (ending === "FINISHED") {
          await playLauncher(fx, workerEnv, await reread(workerEnv, s.job.id), s.uuid, {});
          fx.tapis.advance(s.uuid, "FINISHED");
        } else {
          fx.tapis.advance(s.uuid, "FAILED", "JOB_LAUNCH_FAILURE");
        }
        setTapisTimes(fx, s.uuid, 30 * MINUTE, 0);
        const off = { ...workerEnv, COMPUTE_ENABLED: undefined } as Bindings;
        if (way === "a webhook") {
          const saved = workerEnv;
          workerEnv = off;
          try {
            expect((await post(hookUrl(s.job.id, await webhookToken(s.job.id)))).status).toBe(200);
          } finally {
            workerEnv = saved;
          }
        } else {
          expect(await runComputeAdvanceCron(off)).not.toBeNull();
        }
        const job = await reread(workerEnv, s.job.id);
        expect([way, ending, job.state]).toEqual([way, ending, ending.toLowerCase()]);
        expect(job.settled_provisional_at).not.toBeNull();
        expect(await ledgerKinds(s.job.id)).toEqual(["hold", "charge"]);
        if (ending === "FINISHED") expect(job.results_verified_at).not.toBeNull();
      });
    }
  }
});

// Round 1 of #2041: the read-back a webhook makes has a short ceiling, and the tick a longer one. A
// constant changed from 8,000 to 40,000 milliseconds passed every test, so the time the client is
// ASKED for is asserted: what `AbortSignal.timeout` receives, written out here.
describe("the time a read-back may take", () => {
  test("a webhook's read of the job is asked to finish in 8 seconds, on one attempt", async () => {
    const s = await submitted();
    fx.tapis.advance(s.uuid, "RUNNING");
    const token = await webhookToken(s.job.id);
    const asked = recordAbortTimeouts();
    try {
      expect((await post(hookUrl(s.job.id, token))).status).toBe(200);
    } finally {
      asked.restore();
    }
    expect(asked.values.length).toBeGreaterThan(0);
    expect([...new Set(asked.values)]).toEqual([8000]);
    expect((await reread(workerEnv, s.job.id)).state).toBe("running");
  });

  test("the tick's read of a live job is asked to finish in 10 seconds", async () => {
    const s = await submitted();
    fx.tapis.advance(s.uuid, "RUNNING");
    const asked = recordAbortTimeouts();
    try {
      expect(await runComputeAdvanceCron(workerEnv)).not.toBeNull();
    } finally {
      asked.restore();
    }
    expect(asked.values.length).toBeGreaterThan(0);
    expect([...new Set(asked.values)]).toEqual([10000]);
    expect((await reread(workerEnv, s.job.id)).state).toBe("running");
  });
});
