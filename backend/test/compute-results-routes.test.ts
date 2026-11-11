/**
 * A person's own compute routes, `POST /compute/jobs/:id/cancel` and `POST /compute/jobs/:id/links`
 * (epic #2005 phase A5, #2010; ADR 0118), through the REAL compute router with its real authentication
 * middleware, over real migrated SQLite with real API keys (hashed as production hashes them),
 * Miniflare's R2 through the Worker's own bindings and the real local S3 interface. The Tapis stand-in
 * (no response of which was recorded from a real tenant) answers the cancel.
 *
 * What is pinned: only the job's OWNER may cancel or ask for links, and every other account (an
 * administrator included), a job that does not exist and a malformed id are answered the SAME
 * `job_not_found`, so the route never says whether a job exists for someone else; a signed-out call is
 * 401; links are 7-day presigned GETs of the declared outputs of a finished, verified job and nothing
 * else, bounded in number, renewable while the objects exist and `results_expired` (410) once a head
 * finds them gone; a job that is not finished is `bad_state`; a link is a bearer link and is never
 * logged; a cancel of a running job reaches Tapis, a cancel of one that never started ends it here and
 * releases the hold, and a cancel of an ended job is refused.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { resultsOutputKey } from "../../shared/contract/compute-launch";
import { advanceComputeJob, submitComputeJob } from "../src/services/compute-lifecycle";
import { declaredKey, declaredText } from "../src/services/compute-verify";
import { hashApiKey } from "../src/services/token";
import type { Bindings } from "../src/types/bindings";
import {
  type LifecycleFixture,
  MINUTE,
  type MadeJob,
  makeJob,
  playLauncher,
  reread,
  setTapisTimes,
  startLifecycleFixture,
} from "./helpers/compute-lifecycle-fixture";
import { type RoutesHandle, makeRoutesApp } from "./helpers/compute-routes-app";
import { logged } from "./helpers/logs";

let fx: LifecycleFixture;
let handle: RoutesHandle;

beforeAll(async () => {
  fx = await startLifecycleFixture();
  handle = makeRoutesApp();
}, 120_000);

beforeEach(async () => {
  await fx.reset();
});

afterAll(async () => {
  await fx?.dispose();
}, 30_000);

const env = (): Bindings => fx.env();

let keySeq = 0;

/** Give an account a real API key, hashed as production hashes it; the key. */
async function keyFor(accountId: number): Promise<string> {
  const key = `cmp-results-key-${++keySeq}-0123456789abcdef0123456789abcdef`;
  fx.harness.db
    .query("INSERT INTO tokens (user_id, api_key_hash, api_key_prefix) VALUES (?, ?, ?)")
    .run(accountId, await hashApiKey(key), key.slice(0, 8));
  return key;
}

interface Reply {
  status: number;
  text: string;
  body: Record<string, any>;
}

async function post(path: string, key: string | null, jsonBody?: string): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  if (jsonBody !== undefined) headers["content-type"] = "application/json";
  const res = await handle(
    new Request(`http://api.test${path}`, {
      method: "POST",
      headers,
      ...(jsonBody === undefined ? {} : { body: jsonBody }),
    }),
    env(),
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

interface Owned extends MadeJob {
  key: string;
}

async function owned(over: Parameters<typeof makeJob>[1] = {}): Promise<Owned> {
  const made = await makeJob(fx, over);
  return { ...made, key: await keyFor(made.accountId) };
}

/** A job that ran, uploaded and finished, verified: what links are for. */
async function finished(files = [{ path: "report.txt", content: "the report" }]) {
  const j = await owned();
  await submitComputeJob(j.env, j.job.id);
  const uuid = (await reread(j.env, j.job.id)).tapis_uuid as string;
  fx.tapis.advance(uuid, "RUNNING");
  await advanceComputeJob(j.env, j.job.id);
  await playLauncher(fx, j.env, await reread(j.env, j.job.id), uuid, { outputs: files });
  fx.tapis.advance(uuid, "FINISHED");
  setTapisTimes(fx, uuid, 30 * MINUTE, 0);
  await advanceComputeJob(j.env, j.job.id);
  expect((await reread(j.env, j.job.id)).state).toBe("finished");
  return { ...j, uuid };
}

describe("who may ask", () => {
  test("only the owner: another person, an administrator, a missing job and a malformed id are one answer", async () => {
    const mine = await owned();
    const theirs = await owned();
    const adminId = (
      fx.harness.db
        .query(
          `INSERT INTO users (username, email, password_hash, status, role, signup_source, email_verified, service_access, account_kind)
           VALUES ('cmp-admin-x', 'cmp-admin-x@example.org', 'x', 'approved', 'admin', 'cli', 1, 0, 'person') RETURNING id`,
        )
        .get() as { id: number }
    ).id;
    const adminKey = await keyFor(adminId);
    for (const route of ["cancel", "links"] as const) {
      const none = await post(`/compute/jobs/job_000000000000000000000000/${route}`, mine.key);
      const attempts = [
        await post(`/compute/jobs/${theirs.job.id}/${route}`, mine.key),
        await post(`/compute/jobs/${mine.job.id}/${route}`, adminKey),
        await post(`/compute/jobs/nope/${route}`, mine.key),
        none,
      ];
      for (const a of attempts) expect([route, a.status, a.text]).toEqual([route, 404, none.text]);
      expect(none.body.code).toBe("job_not_found");
      expect((await post(`/compute/jobs/${mine.job.id}/${route}`, null)).status).toBe(401);
      expect((await post(`/compute/jobs/${mine.job.id}/${route}`, "not-a-key")).status).toBe(401);
    }
    // Nothing of theirs moved.
    expect((await reread(env(), theirs.job.id)).cancel_requested_at).toBeNull();
  });
});

describe("cancel", () => {
  test("the owner cancels a job that never started: it ends cancelled and the hold is released", async () => {
    const j = await owned();
    const res = await post(`/compute/jobs/${j.job.id}/cancel`, j.key);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, state: "cancelled", outcome: "cancel_requested" });
    const row = await reread(env(), j.job.id);
    expect([row.state, row.cancel_reason, row.charged_milli]).toEqual(["cancelled", "user", 0]);
    const kinds = (
      await env()
        .DB.prepare("SELECT kind FROM compute_ledger WHERE job_id = ? ORDER BY id")
        .bind(j.job.id)
        .all<{ kind: string }>()
    ).results.map((r) => r.kind);
    expect(kinds).toEqual(["hold", "release"]);
    // A replay is the same answer and writes nothing.
    const again = await post(`/compute/jobs/${j.job.id}/cancel`, j.key);
    expect([again.status, again.body.outcome]).toEqual([200, "already_cancelled"]);
  });

  test("a running job is cancelled at Tapis, and charged what it used", async () => {
    const j = await owned();
    await submitComputeJob(j.env, j.job.id);
    const uuid = (await reread(j.env, j.job.id)).tapis_uuid as string;
    fx.tapis.advance(uuid, "RUNNING");
    await advanceComputeJob(j.env, j.job.id);
    setTapisTimes(fx, uuid, 30 * MINUTE, null);
    const res = await post(`/compute/jobs/${j.job.id}/cancel`, j.key);
    expect(res.status).toBe(200);
    expect(fx.tapis.log.some((r) => r.route === "POST /v3/jobs/:uuid/cancel")).toBe(true);
    const row = await reread(env(), j.job.id);
    expect(row.state).toBe("cancelled");
    expect(row.charged_milli).toBeGreaterThanOrEqual(2000);
  });

  test("a job that has ended is refused with `bad_state`", async () => {
    const f = await finished();
    const res = await post(`/compute/jobs/${f.job.id}/cancel`, f.key);
    expect([res.status, res.body.code]).toEqual([409, "bad_state"]);
    expect((await reread(env(), f.job.id)).state).toBe("finished");
  });

  test("cancel reads no switch: a person can always stop what is running", async () => {
    const j = await owned();
    const off = { ...env(), COMPUTE_ENABLED: undefined } as Bindings;
    const res = await handle(
      new Request(`http://api.test/compute/jobs/${j.job.id}/cancel`, {
        method: "POST",
        headers: { Authorization: `Bearer ${j.key}` },
      }),
      off,
    );
    expect(res.status).toBe(200);
  });
});

describe("links", () => {
  test("a finished job's owner gets 7-day presigned links to the declared outputs, and the bytes are the outputs", async () => {
    const files = [
      { path: "report.txt", content: "the report" },
      { path: "deep/a..b.csv", content: "dots" },
      { path: "100%.txt", content: "percent" },
    ];
    const f = await finished(files);
    const res = await post(`/compute/jobs/${f.job.id}/links`, f.key);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 3, truncated: false });
    const links = res.body.links as Array<{ path: string; size: number; url: string }>;
    expect(links.map((l) => l.path)).toEqual(files.map((x) => x.path).sort());
    for (const l of links) {
      const url = new URL(l.url);
      // Seven days, written out here and not imported: a link is valid 7 days (design section 7).
      expect(url.searchParams.get("X-Amz-Expires")).toBe("604800");
      expect(decodeURIComponent(url.pathname)).toBe(
        `/nemar-compute-results/jobs/${f.job.id}/outputs/${l.path}`,
      );
      const expected = files.find((x) => x.path === l.path)?.content;
      expect(await (await fetch(l.url)).text()).toBe(expected as string);
      expect(l.size).toBe(new TextEncoder().encode(expected as string).length);
    }
    // Seven days, written out in milliseconds: at least 6.9 days remain.
    expect(Date.parse(res.body.expires_at) - Date.now()).toBeGreaterThan(6.9 * 24 * 60 * 60 * 1000);
    // Nothing else is reachable: the launcher's files and the declared file have no link.
    expect(res.text).not.toContain("launcher");
    expect(res.text).not.toContain("declared.json");
  });

  test("renewal gives fresh links while the objects exist, and `results_expired` (410) once they are gone", async () => {
    const f = await finished();
    expect((await post(`/compute/jobs/${f.job.id}/links`, f.key)).status).toBe(200);
    expect((await post(`/compute/jobs/${f.job.id}/links`, f.key)).status).toBe(200);
    await fx.harness.results.delete(resultsOutputKey(f.job.id, "report.txt"));
    const gone = await post(`/compute/jobs/${f.job.id}/links`, f.key);
    expect([gone.status, gone.body.code]).toEqual([410, "results_expired"]);
    // The bucket rule that deletes everything takes the declared file too.
    const g = await finished();
    await fx.harness.results.delete(declaredKey(g.job.id));
    expect((await post(`/compute/jobs/${g.job.id}/links`, g.key)).body.code).toBe(
      "results_expired",
    );
  });

  test("a job that has not finished, or finished unverified, is `bad_state`", async () => {
    const j = await owned();
    const early = await post(`/compute/jobs/${j.job.id}/links`, j.key);
    expect([early.status, early.body.code]).toEqual([409, "bad_state"]);
    const f = await finished();
    await env()
      .DB.prepare("UPDATE compute_jobs SET results_verified_at = NULL WHERE id = ?")
      .bind(f.job.id)
      .run();
    expect((await post(`/compute/jobs/${f.job.id}/links`, f.key)).body.code).toBe("bad_state");
  });

  // Round 1 of #2041: the first 1,000 outputs alone left the rest of a larger job unreachable, so the
  // route pages with a cursor. The sizes are the boundaries: one under, at, one over, and several pages.
  async function declareMany(f: Awaited<ReturnType<typeof finished>>, count: number) {
    const many = Array.from({ length: count }, (_, i) => ({
      path: `f${String(i).padStart(5, "0")}.txt`,
      size: 1,
      sha256: "a".repeat(64),
    }));
    for (const m of many) {
      await fx.harness.results.put(resultsOutputKey(f.job.id, m.path), new Uint8Array([1]));
    }
    await fx.harness.results.put(
      declaredKey(f.job.id),
      new TextEncoder().encode(declaredText(f.job.id, many, [{ name: "result.json", size: 1 }])),
    );
    return many;
  }

  for (const count of [999, 1000, 1001, 2500]) {
    test(`${count} outputs are all reachable in pages of at most 1,000, each exactly once, in order`, async () => {
      const f = await finished();
      const many = await declareMany(f, count);
      const seen: string[] = [];
      let after: string | null = null;
      let pages = 0;
      do {
        const res: Reply = await post(
          `/compute/jobs/${f.job.id}/links`,
          f.key,
          JSON.stringify(after === null ? {} : { after }),
        );
        expect(res.status).toBe(200);
        expect(res.body.total).toBe(count);
        expect(res.body.links.length).toBeLessThanOrEqual(1000);
        for (const l of res.body.links) seen.push(l.path);
        // The last page says so, and only the last page.
        expect(res.body.truncated).toBe(res.body.next_after !== null);
        after = res.body.next_after;
        pages++;
      } while (after !== null && pages < 10);
      expect(pages).toBe(Math.ceil(count / 1000));
      expect(seen).toEqual(many.map((m) => m.path));
      // Putting thousands of objects takes seconds on a shared runner. The 5 s default
      // killed the test, and the timeout then took the Miniflare worker down with it.
    }, 60_000);
  }

  test("a cursor past the last output is an empty last page, and a cursor that is not a path is refused as invalid_spec", async () => {
    const f = await finished();
    const path = `/compute/jobs/${f.job.id}/links`;
    const past = await post(path, f.key, JSON.stringify({ after: "zzzz.txt" }));
    expect(past.status).toBe(200);
    expect(past.body).toMatchObject({ links: [], truncated: false, next_after: null });
    for (const bad of [
      JSON.stringify({ after: "../etc/passwd" }),
      JSON.stringify({ after: "/absolute" }),
      JSON.stringify({ after: 7 }),
      JSON.stringify({ after: "a".repeat(513) }),
      JSON.stringify(["after"]),
      JSON.stringify("after"),
      "{not json",
    ]) {
      const res = await post(path, f.key, bad);
      expect([res.status, res.body.code]).toEqual([400, "invalid_spec"]);
      expect(res.text).not.toContain("X-Amz");
    }
    // No body at all is the first page, as before.
    expect((await post(path, f.key)).status).toBe(200);
  });

  // Round 2 of #2041: the links route read its body unbounded, where every other compute route bounds it.
  test("a body over 4 KiB is refused as invalid_spec (413) whether or not its length is declared, and a body within it is read as before", async () => {
    const f = await finished();
    const path = `/compute/jobs/${f.job.id}/links`;
    // A cursor is at most 512 characters: this body is valid JSON and far too large.
    const big = JSON.stringify({ after: "a".repeat(5000) });
    const undeclared = await post(path, f.key, big);
    expect([undeclared.status, undeclared.body.code]).toEqual([413, "invalid_spec"]);
    const huge = await post(path, f.key, JSON.stringify({ pad: "x".repeat(2 * 1024 * 1024) }));
    expect([huge.status, huge.body.code]).toEqual([413, "invalid_spec"]);
    // A declared length over the bound is refused before the body is read.
    const declared = await handle(
      new Request(`http://api.test${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${f.key}`,
          "content-type": "application/json",
          "content-length": "999999",
        },
        body: "{}",
      }),
      env(),
    );
    expect(declared.status).toBe(413);
    // Within the bound: an empty object, an explicit empty body and the longest cursor are all read.
    expect((await post(path, f.key, "{}")).status).toBe(200);
    expect((await post(path, f.key, JSON.stringify({ after: "a".repeat(512) }))).status).toBe(200);
    const emptyDeclared = await handle(
      new Request(`http://api.test${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${f.key}`, "content-length": "0" },
      }),
      env(),
    );
    expect(emptyDeclared.status).toBe(200);
  });

  test("a job with no outputs gets no links, and no error", async () => {
    const f = await finished([]);
    const res = await post(`/compute/jobs/${f.job.id}/links`, f.key);
    expect(res.status).toBe(200);
    expect(res.body.links).toEqual([]);
  });

  test("with no signing configuration it is `compute_disabled`", async () => {
    const f = await finished();
    const off = { ...env(), COMPUTE_R2_ACCESS_KEY_ID: undefined } as Bindings;
    const res = await handle(
      new Request(`http://api.test/compute/jobs/${f.job.id}/links`, {
        method: "POST",
        headers: { Authorization: `Bearer ${f.key}` },
      }),
      off,
    );
    expect([res.status, ((await res.json()) as { code: string }).code]).toEqual([
      503,
      "compute_disabled",
    ]);
  });

  test("a link is a bearer link and is never logged", async () => {
    const f = await finished();
    let url = "";
    const lines = await logged(async () => {
      const res = await post(`/compute/jobs/${f.job.id}/links`, f.key);
      url = (res.body.links as Array<{ url: string }>)[0]?.url ?? "";
      await post(`/compute/jobs/${f.job.id}/links`, "wrong-key");
    });
    expect(url).toContain("X-Amz-Signature");
    const signature = new URL(url).searchParams.get("X-Amz-Signature") as string;
    const joined = lines.join("\n");
    for (const word of [signature, "X-Amz", "report.txt", f.key]) {
      expect([word, joined.includes(word)]).toEqual([word, false]);
    }
  });
});
