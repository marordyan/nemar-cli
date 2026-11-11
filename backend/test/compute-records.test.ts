/**
 * The per-job record and the records bucket (`services/compute-records.ts`; epic #2005 phase A3,
 * #2008; ADR 0118 decision 7, design section 9), on Miniflare's R2 through the Worker's own binding,
 * with the S3 interface a real local server over the same buckets (`compute-s3-standin.ts`).
 *
 * What is pinned: the identity snapshot holds exactly the listed fields and is written once;
 * reading a record is owner-only, needs a reason of 8 to 200 characters, writes its audit row BEFORE
 * the bucket is touched (a failing read still leaves the row), and is refused when that write fails;
 * a submitted file or a log is read by a 5-minute presigned GET and a bundle by a 10-minute one, for
 * that job's own key and no other; an incoming address lives one hour, is issued only for a live job
 * that has not been finalized, and refuses what `assertValidS3Key` refuses and what a manifest may not
 * hold (traversal in any encoding, a count or a size over the owner's limits); `finalizeBundle` and
 * `finalizeSubmittedFiles` copy into the locked records only after the job's row, which exists only if
 * its hold does, has been read back (one `CopyObject` per object, none for a refusal, none again for a replay), check each size, write
 * the manifest and mark the records written; a refusal deletes nothing.
 *
 * Miniflare does not enforce bucket lock, so what a lock refuses is not tested; the records are
 * written once and never overwritten by the code here, which is what lets the lock be on.
 *
 * MUTATIONS (proved by hand, see the pull request): taking the bundle key from the caller instead of
 * the job; copying before the job's row and hold are checked.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { DEFAULT_COMPUTE_POLICY } from "../../shared/contract/compute";
import { createJob } from "../src/services/compute-jobs";
import {
  BUNDLE_ARCHIVE_NAME,
  OUTPUT_ENTRY_BYTES_MAX,
  PARTNER_FILES_MAX,
  finalizeBundle,
  finalizeSubmittedFiles,
  incomingKey,
  logKey,
  outputsBodyLimitBytes,
  presignBundleRead,
  presignIncomingUploads,
  readRecordObject,
  recordKey,
  submittedKey,
  submittedPathProblem,
  writeIdentitySnapshot,
  writeSpec,
} from "../src/services/compute-records";
import { COPY_OBJECT_MAX_BYTES } from "../src/services/compute-s3";
import type { Bindings } from "../src/types/bindings";
import {
  type ComputeHarness,
  HARNESS_BUCKETS,
  startComputeHarness,
} from "./helpers/compute-harness";
import {
  bundleJobSpec,
  fundAccount,
  fundPlatform,
  holdBody,
  seedUser,
  setPolicy,
  sha256Hex,
  trace,
} from "./helpers/compute-seed";
import { interceptingD1 } from "./helpers/d1";

let h: ComputeHarness;
const MIB = 1024 * 1024;

beforeAll(async () => {
  h = await startComputeHarness();
}, 90_000);

beforeEach(async () => {
  await h.reset();
});

afterAll(async () => {
  await h?.dispose();
}, 30_000);

const bytes = (text: string) => new TextEncoder().encode(text);
const text = async (bucket: R2Bucket, key: string) =>
  (await (await bucket.get(key))?.text()) ?? null;
const cp = (kind: "CopyObject" | "PutObject") => h.standin.log.filter((r) => r.op === kind);

/** Everything a refused request must leave as it found it. */
async function recordsKeys() {
  return h.keys(h.records);
}

interface Made {
  accountId: number;
  id: string;
  archive: Uint8Array;
  sha256: string;
}

/** A person, a funded pool, and a job with a code bundle of `archive`'s size and digest. */
async function bundleJob(
  archive = bytes(`archive ${Math.random()}`),
  over: Partial<Bindings> = {},
): Promise<Made> {
  const env = h.env(over);
  const accountId = await seedUser(env.DB);
  await fundAccount(env.DB, accountId, 100_000);
  await fundPlatform(env.DB, "people", 1_000_000_000);
  const sha256 = await sha256Hex(archive);
  const r = await createJob(env, {
    source: "cli",
    accountId,
    appId: "nemar-launch",
    appVersion: "1.0.0",
    spec: bundleJobSpec({ size: archive.length, sha256 }),
  });
  if (!r.ok) throw new Error(`could not make a job: ${r.code}`);
  return { accountId, id: r.job.id, archive, sha256 };
}

/** A partner job: its submitted files are uploaded one by one. */
async function partnerJob(): Promise<{ accountId: number; id: string }> {
  const env = h.env();
  const accountId = await seedUser(env.DB);
  await fundAccount(env.DB, accountId, 100_000);
  await fundPlatform(env.DB, "people", 1_000_000_000);
  const r = await createJob(env, {
    source: "partner",
    accountId,
    clientId: "client.one",
    holdBody: holdBody(),
  });
  if (!r.ok) throw new Error(`could not make a job: ${r.code}`);
  return { accountId, id: r.job.id };
}

const upload = (made: Made, body = made.archive) =>
  h.records.put(incomingKey(made.id, BUNDLE_ARCHIVE_NAME), body);
const manifest = (...files: Array<[string, number]>) =>
  files.map(([path, size]) => ({ path, size }));

describe("the keys", () => {
  const ID = `job_${"0123456789ab".repeat(2)}`;

  test("are the layout of design section 9: records, logs, incoming, and the result manifest renamed", () => {
    expect(recordKey(ID, "identity.json")).toBe(`records/${ID}/identity.json`);
    expect(recordKey(ID, "spec.json")).toBe(`records/${ID}/spec.json`);
    expect(recordKey(ID, "bundle-manifest.json")).toBe(`records/${ID}/bundle-manifest.json`);
    expect(recordKey(ID, "provenance.json")).toBe(`records/${ID}/provenance.json`);
    expect(recordKey(ID, "result.json")).toBe(`records/${ID}/result.json`);
    // The launcher's manifest.json is kept as result-manifest.json; the node and the results bucket use manifest.json.
    expect(recordKey(ID, "result-manifest.json")).toBe(`records/${ID}/result-manifest.json`);
    expect(() => recordKey(ID, "manifest.json" as never)).toThrow();
    expect(() => recordKey(ID, "failure.json" as never)).toThrow();
    expect(submittedKey(ID, BUNDLE_ARCHIVE_NAME)).toBe(`records/${ID}/submitted/bundle.tar.gz`);
    expect(submittedKey(ID, "src/a.py")).toBe(`records/${ID}/submitted/src/a.py`);
    expect(logKey(ID, "tapisjob.out")).toBe(`logs/${ID}/tapisjob.out`);
    expect(logKey(ID, "launcher.log")).toBe(`logs/${ID}/launcher.log`);
    expect(incomingKey(ID, BUNDLE_ARCHIVE_NAME)).toBe(`incoming/${ID}/bundle.tar.gz`);
    expect(incomingKey(ID, "src/a.py")).toBe(`incoming/${ID}/src/a.py`);
  });

  test("refuse a job id that is not one, and a path that could escape", () => {
    for (const id of ["", "job_", `job_${"A".repeat(24)}`, `${ID}/../x`, `${ID}x`, "../job_x"]) {
      expect(() => recordKey(id, "spec.json")).toThrow();
      expect(() => incomingKey(id, "a")).toThrow();
    }
    for (const path of ["", "../a", "a/../b", "/a", "a\\b", "a//b", "a/./b"]) {
      expect(() => submittedKey(ID, path)).toThrow();
      expect(() => incomingKey(ID, path)).toThrow();
    }
    expect(submittedKey(ID, "a..b.csv")).toBe(`records/${ID}/submitted/a..b.csv`);
    expect(incomingKey(ID, "100%.txt")).toBe(`incoming/${ID}/100%.txt`);
  });
});

describe("the identity snapshot", () => {
  test("holds exactly the listed fields, and nothing else about the person", async () => {
    const env = h.env();
    const accountId = await seedUser(env.DB, {
      email: "ada@example.org",
      given_name: "Ada",
      family_name: "Lovelace",
      orcid: "0000-0002-1825-0097",
      country: "Freedonia",
      affiliation: "Institute of Analytical Engines",
      city: "Sylvania",
      username: "adal",
    });
    const id = `job_${"00".repeat(11)}01`;
    const before = Date.now();
    await writeIdentitySnapshot(env, id, accountId);
    const stored = JSON.parse((await text(h.records, `records/${id}/identity.json`)) ?? "{}");
    expect(Object.keys(stored).sort()).toEqual([
      "account_id",
      "affiliation",
      "captured_at",
      "country",
      "email",
      "name",
      "orcid",
      "sub",
    ]);
    expect(stored).toMatchObject({
      orcid: "0000-0002-1825-0097",
      name: "Ada Lovelace",
      email: "ada@example.org",
      country: "Freedonia",
      affiliation: "Institute of Analytical Engines",
      account_id: accountId,
      sub: null,
    });
    const at = Date.parse(stored.captured_at);
    expect(at).toBeGreaterThanOrEqual(before - 1000);
    expect(at).toBeLessThanOrEqual(Date.now() + 1000);
    expect(stored.captured_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // The city and the username are the person's too, and are not part of the snapshot.
    expect(JSON.stringify(stored)).not.toContain("Sylvania");
    expect(JSON.stringify(stored)).not.toContain("adal");
  });

  test("an account with no name has a null one, one with only a given name has that, and none has nulls", async () => {
    const env = h.env();
    const read = async (id: string) =>
      JSON.parse((await text(h.records, `records/${id}/identity.json`)) ?? "{}");
    const a = await seedUser(env.DB, {
      given_name: null,
      family_name: null,
      orcid: null,
      country: null,
      affiliation: null,
    });
    await writeIdentitySnapshot(env, `job_${"00".repeat(11)}02`, a);
    expect(await read(`job_${"00".repeat(11)}02`)).toMatchObject({
      name: null,
      orcid: null,
      country: null,
      affiliation: null,
    });
    const b = await seedUser(env.DB, { given_name: "Mono", family_name: null });
    await writeIdentitySnapshot(env, `job_${"00".repeat(11)}03`, b);
    expect((await read(`job_${"00".repeat(11)}03`)).name).toBe("Mono");
    await writeIdentitySnapshot(env, `job_${"00".repeat(11)}04`, null);
    expect(await read(`job_${"00".repeat(11)}04`)).toMatchObject({
      account_id: null,
      email: null,
      name: null,
      sub: null,
    });
    await writeIdentitySnapshot(env, `job_${"00".repeat(11)}05`, 999_999_999);
    expect(await read(`job_${"00".repeat(11)}05`)).toMatchObject({
      account_id: 999_999_999,
      email: null,
      name: null,
    });
  });

  test("an account that has since been deleted is still what was submitted", async () => {
    const env = h.env();
    const accountId = await seedUser(env.DB, {
      deleted_at: "2026-01-01 00:00:00",
      email: "gone@example.org",
    });
    await writeIdentitySnapshot(env, `job_${"00".repeat(11)}06`, accountId);
    expect(
      JSON.parse((await text(h.records, `records/job_${"00".repeat(11)}06/identity.json`)) ?? "{}")
        .email,
    ).toBe("gone@example.org");
  });

  test("is written once: a second write leaves the first, and says nothing is wrong", async () => {
    const env = h.env();
    const accountId = await seedUser(env.DB, { given_name: "First" });
    const id = `job_${"00".repeat(11)}07`;
    await writeIdentitySnapshot(env, id, accountId);
    const first = await text(h.records, `records/${id}/identity.json`);
    await new Promise((r) => setTimeout(r, 15));
    await env.DB.prepare("UPDATE users SET given_name = 'Second' WHERE id = ?")
      .bind(accountId)
      .run();
    await writeIdentitySnapshot(env, id, accountId);
    expect(await text(h.records, `records/${id}/identity.json`)).toBe(first);
  });
});

describe("the specification record", () => {
  test("is written once, and an identical write is no conflict", async () => {
    const env = h.env();
    const id = `job_${"00".repeat(11)}08`;
    await writeSpec(env, id, '{"a":1}');
    await writeSpec(env, id, '{"a":1}');
    expect(await text(h.records, `records/${id}/spec.json`)).toBe('{"a":1}');
  });

  test("a different specification for a job that has one is an error, and the record is untouched", async () => {
    const env = h.env();
    const id = `job_${"00".repeat(11)}09`;
    await writeSpec(env, id, '{"a":1}');
    await expect(writeSpec(env, id, '{"a":2}')).rejects.toMatchObject({ code: "record_conflict" });
    expect(await text(h.records, `records/${id}/spec.json`)).toBe('{"a":1}');
  });
});

describe("readRecordObject", () => {
  async function actors() {
    const env = h.env();
    return {
      env,
      owner: await seedUser(env.DB, { role: "owner" }),
      admin: await seedUser(env.DB, { role: "admin" }),
      member: await seedUser(env.DB, { role: "member" }),
    };
  }
  const REASON = "audit request 4711";
  const audits = async (env: Bindings) =>
    (
      await env.DB.prepare(
        "SELECT * FROM audit_log WHERE action = 'compute.record.read' ORDER BY id",
      ).all<{
        user_id: number;
        action: string;
        resource_type: string;
        resource_id: string;
        details: string;
      }>()
    ).results;

  test("gives an owner the bytes of a record, and writes who, what, when and why", async () => {
    const { env, owner } = await actors();
    const made = await bundleJob();
    const key = recordKey(made.id, "identity.json");
    const stored = await h.records.get(key);
    const r = await readRecordObject(env, env.DB, {
      actor: { id: owner },
      jobId: made.id,
      name: "identity.json",
      reason: REASON,
    });
    expect(r).toMatchObject({
      ok: true,
      kind: "bytes",
      name: "identity.json",
      contentType: "application/json",
    });
    if (!r.ok || r.kind !== "bytes") return;
    expect(new TextDecoder().decode(r.bytes)).toBe(await stored?.text());
    const rows = await audits(env);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      user_id: owner,
      action: "compute.record.read",
      resource_type: "compute_job",
      resource_id: made.id,
    });
    expect(JSON.parse(rows[0]?.details ?? "{}")).toEqual({ name: "identity.json", reason: REASON });
  });

  test("refuses an administrator, a member and an owner who is no longer one, and records nothing", async () => {
    const { env, owner, admin, member } = await actors();
    const made = await bundleJob();
    const gone = await seedUser(env.DB, { role: "owner", deleted_at: "2026-01-01 00:00:00" });
    const revoked = await seedUser(env.DB, { role: "owner", status: "revoked" });
    for (const actor of [admin, member, gone, revoked, 999_999_999]) {
      const before = await trace(env.DB);
      const r = await readRecordObject(env, env.DB, {
        actor: { id: actor },
        jobId: made.id,
        name: "identity.json",
        reason: REASON,
      });
      expect([actor, r]).toEqual([actor, { ok: false, code: "not_owner" }]);
      expect(await trace(env.DB)).toEqual(before);
    }
    // A caller that says it is an owner is not believed: the role is read from the database.
    const lying = await readRecordObject(env, env.DB, {
      actor: { id: admin, role: "owner" },
      jobId: made.id,
      name: "identity.json",
      reason: REASON,
    });
    expect(lying).toEqual({ ok: false, code: "not_owner" });
    expect((await audits(env)).length).toBe(0);
    expect(
      (
        await readRecordObject(env, env.DB, {
          actor: { id: owner },
          jobId: made.id,
          name: "identity.json",
          reason: REASON,
        })
      ).ok,
    ).toBe(true);
  });

  test("refuses a reason of fewer than 8 or more than 200 characters, or no real one", async () => {
    const { env, owner } = await actors();
    const made = await bundleJob();
    for (const reason of [
      "",
      "short",
      "1234567",
      "       ",
      "   pad   ",
      "x".repeat(201),
      "a\u0000bcdefgh",
      "line\nbreak is not a reason",
    ]) {
      const before = await trace(env.DB);
      const r = await readRecordObject(env, env.DB, {
        actor: { id: owner },
        jobId: made.id,
        name: "identity.json",
        reason,
      });
      expect([reason, r]).toEqual([reason, { ok: false, code: "invalid_reason" }]);
      expect(await trace(env.DB)).toEqual(before);
    }
    for (const reason of ["12345678", "x".repeat(200)]) {
      expect(
        (
          await readRecordObject(env, env.DB, {
            actor: { id: owner },
            jobId: made.id,
            name: "identity.json",
            reason,
          })
        ).ok,
      ).toBe(true);
    }
  });

  test("writes the audit row BEFORE the bucket is touched: the first read finds it already there", async () => {
    const { env, owner } = await actors();
    const made = await bundleJob();
    const seen: number[] = [];
    const watching = {
      put: (k: string, v: unknown, o?: unknown) =>
        h.records.put(k, v as ArrayBuffer, o as Parameters<R2Bucket["put"]>[2]),
      get: async (k: string) => {
        seen.push(
          (
            await env.DB.prepare(
              "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'compute.record.read'",
            ).first<{ n: number }>()
          )?.n ?? -1,
        );
        return h.records.get(k);
      },
      head: async (k: string) => {
        seen.push(
          (
            await env.DB.prepare(
              "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'compute.record.read'",
            ).first<{ n: number }>()
          )?.n ?? -1,
        );
        return h.records.head(k);
      },
      delete: (k: string) => h.records.delete(k),
      list: (o?: Parameters<R2Bucket["list"]>[0]) => h.records.list(o),
    } as unknown as R2Bucket;
    const e2 = { ...env, COMPUTE_RECORDS: watching };
    const r = await readRecordObject(e2, e2.DB, {
      actor: { id: owner },
      jobId: made.id,
      name: "identity.json",
      reason: REASON,
    });
    expect(r.ok).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    for (const n of seen) expect(n).toBe(1);
  });

  test("a read that fails still leaves its row: the attempt is what is audited", async () => {
    const { env, owner } = await actors();
    const made = await bundleJob();
    const r = await readRecordObject(env, env.DB, {
      actor: { id: owner },
      jobId: made.id,
      name: "provenance.json",
      reason: REASON,
    });
    expect(r).toEqual({ ok: false, code: "record_missing" });
    const rows = await audits(env);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]?.details ?? "{}")).toEqual({
      name: "provenance.json",
      reason: REASON,
    });
    const missingJob = await readRecordObject(env, env.DB, {
      actor: { id: owner },
      jobId: `job_${"ee".repeat(12)}`,
      name: "identity.json",
      reason: REASON,
    });
    expect(missingJob).toEqual({ ok: false, code: "record_missing" });
    expect((await audits(env)).length).toBe(2);
  });

  test("is refused when the audit row cannot be written, and the bucket is never read", async () => {
    const { env, owner } = await actors();
    const made = await bundleJob();
    let reads = 0;
    const counting = {
      put: (k: string, v: unknown, o?: unknown) =>
        h.records.put(k, v as ArrayBuffer, o as Parameters<R2Bucket["put"]>[2]),
      get: (k: string) => {
        reads++;
        return h.records.get(k);
      },
      head: (k: string) => {
        reads++;
        return h.records.head(k);
      },
      delete: (k: string) => h.records.delete(k),
      list: (o?: Parameters<R2Bucket["list"]>[0]) => h.records.list(o),
    } as unknown as R2Bucket;
    const failing = interceptingD1(env.DB, (sql) => {
      if (/INSERT\s+INTO\s+audit_log/i.test(sql)) throw new Error("the audit store is down");
    });
    const e2 = { ...env, DB: failing, COMPUTE_RECORDS: counting };
    const r = await readRecordObject(e2, failing, {
      actor: { id: owner },
      jobId: made.id,
      name: "identity.json",
      reason: REASON,
    });
    expect(r).toEqual({ ok: false, code: "audit_failed" });
    expect(reads).toBe(0);
    expect((await audits(env)).length).toBe(0);
    // Nothing of the record leaves with the refusal.
    expect(JSON.stringify(r)).not.toContain("example.org");
  });

  test("gives a 5-minute presigned GET for a submitted file and for a log, and bytes for nothing large", async () => {
    const { env, owner } = await actors();
    const made = await bundleJob();
    await h.records.put(submittedKey(made.id, BUNDLE_ARCHIVE_NAME), bytes("the submitted bundle"));
    await h.records.put(submittedKey(made.id, "src/run.py"), bytes("print(1)"));
    await h.records.put(logKey(made.id, "tapisjob.out"), bytes("stdout"));
    await h.records.put(logKey(made.id, "launcher.log"), bytes("launcher"));
    for (const [name, key, body] of [
      [BUNDLE_ARCHIVE_NAME, submittedKey(made.id, BUNDLE_ARCHIVE_NAME), "the submitted bundle"],
      ["src/run.py", submittedKey(made.id, "src/run.py"), "print(1)"],
      ["tapisjob.out", logKey(made.id, "tapisjob.out"), "stdout"],
      ["launcher.log", logKey(made.id, "launcher.log"), "launcher"],
    ] as const) {
      const full =
        name === BUNDLE_ARCHIVE_NAME || name === "src/run.py"
          ? `submitted/${name}`
          : `logs/${name}`;
      const r = await readRecordObject(env, env.DB, {
        actor: { id: owner },
        jobId: made.id,
        name: full,
        reason: REASON,
      });
      expect(r).toMatchObject({ ok: true, kind: "url" });
      if (!r.ok || r.kind !== "url") continue;
      const url = new URL(r.url);
      expect(url.pathname).toBe(`/${HARNESS_BUCKETS.records}/${key}`);
      expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
      expect(Date.parse(r.expires_at)).toBeGreaterThan(Date.now());
      expect(Date.parse(r.expires_at)).toBeLessThanOrEqual(Date.now() + 301_000);
      const res = await fetch(r.url);
      expect(await res.text()).toBe(body);
      expect(h.standin.log.at(-1)).toMatchObject({ op: "GetObject", expires: 300, key });
    }
    expect((await audits(env)).length).toBe(4);
  });

  test("a submitted file that is not there is `record_missing`, after its row", async () => {
    const { env, owner } = await actors();
    const made = await bundleJob();
    const r = await readRecordObject(env, env.DB, {
      actor: { id: owner },
      jobId: made.id,
      name: "submitted/nope.py",
      reason: REASON,
    });
    expect(r).toEqual({ ok: false, code: "record_missing" });
    expect((await audits(env)).length).toBe(1);
  });

  test("refuses a name that is not a record, and a malformed job id, before anything is written", async () => {
    const { env, owner } = await actors();
    const made = await bundleJob();
    for (const name of [
      "../identity.json",
      "submitted/../identity.json",
      "submitted/",
      "submitted",
      "identity.json/",
      "/identity.json",
      "manifest.json",
      "failure.json",
      "unknown.json",
      "logs/other.log",
      "logs/tapisjob.out/x",
      "logs/../records/x",
      "submitted/a//b",
      "submitted/a\\b",
      "",
    ]) {
      const before = await trace(env.DB);
      const r = await readRecordObject(env, env.DB, {
        actor: { id: owner },
        jobId: made.id,
        name,
        reason: REASON,
      });
      expect([name, r]).toEqual([name, { ok: false, code: "invalid_record" }]);
      expect(await trace(env.DB)).toEqual(before);
    }
    for (const jobId of ["", "job_x", `${made.id}/../${made.id}`, "../x"]) {
      const r = await readRecordObject(env, env.DB, {
        actor: { id: owner },
        jobId,
        name: "identity.json",
        reason: REASON,
      });
      expect([jobId, r]).toEqual([jobId, { ok: false, code: "invalid_record" }]);
    }
    expect((await audits(env)).length).toBe(0);
  });

  test("with no records bucket bound or no S3 settings, compute is disabled", async () => {
    const { env, owner } = await actors();
    const made = await bundleJob();
    expect(
      await readRecordObject({ ...env, COMPUTE_RECORDS: undefined }, env.DB, {
        actor: { id: owner },
        jobId: made.id,
        name: "identity.json",
        reason: REASON,
      }),
    ).toEqual({ ok: false, code: "compute_disabled" });
    await h.records.put(submittedKey(made.id, "a.py"), bytes("x"));
    expect(
      await readRecordObject({ ...env, COMPUTE_R2_SECRET_ACCESS_KEY: undefined }, env.DB, {
        actor: { id: owner },
        jobId: made.id,
        name: "submitted/a.py",
        reason: REASON,
      }),
    ).toEqual({ ok: false, code: "compute_disabled" });
  });
});

describe("presignBundleRead", () => {
  test("signs that job's own submitted bundle for ten minutes, and no other key", async () => {
    const made = await bundleJob();
    const other = await bundleJob();
    await h.records.put(submittedKey(made.id, BUNDLE_ARCHIVE_NAME), bytes("mine"));
    await h.records.put(submittedKey(other.id, BUNDLE_ARCHIVE_NAME), bytes("not mine"));
    // A key a caller names is not what is signed: the function takes the job and nothing else.
    const asked = (
      presignBundleRead as unknown as (
        e: Bindings,
        id: string,
        key: string,
      ) => ReturnType<typeof presignBundleRead>
    )(h.env(), made.id, submittedKey(other.id, BUNDLE_ARCHIVE_NAME));
    const r = await asked;
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const url = new URL(r.url);
    expect(url.pathname).toBe(
      `/${HARNESS_BUCKETS.records}/records/${made.id}/submitted/bundle.tar.gz`,
    );
    expect(url.searchParams.get("X-Amz-Expires")).toBe("600");
    expect(Date.parse(r.expires_at)).toBeLessThanOrEqual(Date.now() + 601_000);
    expect(Date.parse(r.expires_at)).toBeGreaterThan(Date.now() + 590_000);
    const res = await fetch(r.url);
    expect(await res.text()).toBe("mine");
    // The address cannot be turned into another job's bundle.
    const forged = r.url.replace(made.id, other.id);
    expect((await fetch(forged)).status).toBe(403);
  });

  test("is not an address for a job with no bundle, or one that is not a job id", async () => {
    const made = await bundleJob();
    expect(await presignBundleRead(h.env(), made.id)).toEqual({ ok: false, code: "bad_state" });
    for (const id of ["", "job_x", `${made.id}/../x`, "../x"]) {
      await expect(presignBundleRead(h.env(), id)).resolves.toEqual({
        ok: false,
        code: "job_not_found",
      });
    }
    expect(h.standin.log.length).toBe(0);
  });

  test("with no S3 settings, or no records bucket, is disabled", async () => {
    const made = await bundleJob();
    await h.records.put(submittedKey(made.id, BUNDLE_ARCHIVE_NAME), bytes("mine"));
    expect(
      await presignBundleRead(h.env({ COMPUTE_R2_S3_ENDPOINT: undefined, ...{} }), made.id),
    ).toMatchObject({ ok: true });
    (globalThis as { NEMAR_COMPUTE_S3_URL?: string }).NEMAR_COMPUTE_S3_URL = undefined;
    try {
      expect(
        await presignBundleRead(h.env({ COMPUTE_R2_S3_ENDPOINT: undefined }), made.id),
      ).toEqual({ ok: false, code: "compute_disabled" });
    } finally {
      (globalThis as { NEMAR_COMPUTE_S3_URL?: string }).NEMAR_COMPUTE_S3_URL = h.standin.url;
    }
    expect(await presignBundleRead(h.env({ COMPUTE_RECORDS: undefined }), made.id)).toEqual({
      ok: false,
      code: "compute_disabled",
    });
  });
});

describe("presignIncomingUploads", () => {
  test("gives a bundle job one one-hour address for bundle.tar.gz, which takes the archive", async () => {
    const made = await bundleJob();
    const r = await presignIncomingUploads(h.env(), made.id, [
      { path: BUNDLE_ARCHIVE_NAME, size: made.archive.length, sha256: made.sha256 },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.uploads).toHaveLength(1);
    const [u] = r.uploads;
    expect(u?.path).toBe(BUNDLE_ARCHIVE_NAME);
    const url = new URL(u?.url ?? "");
    expect(url.pathname).toBe(`/${HARNESS_BUCKETS.records}/incoming/${made.id}/bundle.tar.gz`);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("3600");
    expect(Date.parse(r.expires_at)).toBeLessThanOrEqual(Date.now() + 3601_000);
    expect(Date.parse(r.expires_at)).toBeGreaterThan(Date.now() + 3590_000);
    // The checksum is signed with the URL and the client sends it as a header.
    const base64 = createHash("sha256").update(made.archive).digest("base64");
    expect(u?.headers).toEqual({ "x-amz-checksum-sha256": base64 });
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host;x-amz-checksum-sha256");
    const put = await fetch(u?.url ?? "", {
      method: "PUT",
      headers: u?.headers,
      body: made.archive,
    });
    expect(put.status).toBe(200);
    expect(await h.records.head(incomingKey(made.id, BUNDLE_ARCHIVE_NAME))).toMatchObject({
      size: made.archive.length,
    });
    expect(h.standin.log.at(-1)).toMatchObject({ op: "PutObject", expires: 3600, presigned: true });
  });

  test("without a digest signs no header, and the bound is the size the finalize step checks", async () => {
    const made = await bundleJob();
    const r = await presignIncomingUploads(h.env(), made.id, [
      { path: BUNDLE_ARCHIVE_NAME, size: made.archive.length },
    ]);
    if (!r.ok) throw new Error(r.code);
    expect(r.uploads[0]?.headers).toEqual({});
    expect(new URL(r.uploads[0]?.url ?? "").searchParams.get("X-Amz-SignedHeaders")).toBe("host");
  });

  test("can be asked again after the address has expired, and the new one works", async () => {
    const made = await bundleJob();
    const files = [{ path: BUNDLE_ARCHIVE_NAME, size: made.archive.length }];
    // An address signed two hours ago has expired by now; the launcher or the CLI asks again.
    const stale = await presignIncomingUploads(h.env(), made.id, files, {
      now: new Date(Date.now() - 2 * 3600 * 1000),
    });
    if (!stale.ok) throw new Error(stale.code);
    const refused = await fetch(stale.uploads[0]?.url ?? "", { method: "PUT", body: made.archive });
    expect(refused.status).toBe(403);
    expect(h.standin.log.at(-1)?.code).toBe("AccessDenied");
    expect(await recordsKeys()).not.toContain(incomingKey(made.id, BUNDLE_ARCHIVE_NAME));
    const fresh = await presignIncomingUploads(h.env(), made.id, files);
    if (!fresh.ok) throw new Error(fresh.code);
    expect(fresh.uploads[0]?.url).not.toBe(stale.uploads[0]?.url);
    expect(
      (await fetch(fresh.uploads[0]?.url ?? "", { method: "PUT", body: made.archive })).status,
    ).toBe(200);
    expect(await h.records.head(incomingKey(made.id, BUNDLE_ARCHIVE_NAME))).toMatchObject({
      size: made.archive.length,
    });
  });

  test("a bundle job takes the archive and nothing else, and a size that fits the owner's limit", async () => {
    const made = await bundleJob();
    const ask = (files: Array<{ path: string; size: number; sha256?: string }>) =>
      presignIncomingUploads(h.env(), made.id, files);
    expect(await ask([{ path: "other.bin", size: 5 }])).toMatchObject({
      ok: false,
      code: "invalid_spec",
    });
    expect(
      await ask([
        { path: BUNDLE_ARCHIVE_NAME, size: 5 },
        { path: "x", size: 5 },
      ]),
    ).toMatchObject({ ok: false, code: "invalid_spec" });
    expect(await ask([])).toMatchObject({ ok: false, code: "invalid_spec" });
    for (const size of [0, -1, 1.5, Number.NaN]) {
      expect(await ask([{ path: BUNDLE_ARCHIVE_NAME, size }])).toMatchObject({
        ok: false,
        code: "invalid_spec",
      });
    }
    expect(
      await ask([
        { path: BUNDLE_ARCHIVE_NAME, size: DEFAULT_COMPUTE_POLICY.bundleLimits.maxTotalBytes + 1 },
      ]),
    ).toMatchObject({ ok: false, code: "bundle_too_large" });
    expect(await ask([{ path: BUNDLE_ARCHIVE_NAME, size: 5, sha256: "nothex" }])).toMatchObject({
      ok: false,
      code: "invalid_spec",
    });
    // The archive is the one the job was made with: another size or another digest gets no address.
    expect(await ask([{ path: BUNDLE_ARCHIVE_NAME, size: made.archive.length + 1 }])).toEqual({
      ok: false,
      code: "invalid_spec",
      field: "files.0.size",
    });
    expect(
      await ask([{ path: BUNDLE_ARCHIVE_NAME, size: made.archive.length, sha256: "0".repeat(64) }]),
    ).toEqual({ ok: false, code: "invalid_spec", field: "files.0.sha256" });
    expect(h.standin.log.length).toBe(0);
  });

  test("a partner job takes its declared files, each within the owner's limits", async () => {
    const made = await partnerJob();
    const files = [
      { path: "src/run.py", size: 10 },
      { path: "params.json", size: 20 },
      { path: "a..b.csv", size: 1 },
      { path: "100%.txt", size: 1 },
    ];
    const r = await presignIncomingUploads(h.env(), made.id, files);
    if (!r.ok) throw new Error(r.code);
    expect(r.uploads.map((u) => u.path)).toEqual(files.map((f) => f.path));
    for (const u of r.uploads) {
      const url = new URL(u.url);
      expect(decodeURIComponent(url.pathname)).toBe(
        `/${HARNESS_BUCKETS.records}/incoming/${made.id}/${u.path}`,
      );
      expect(url.searchParams.get("X-Amz-Expires")).toBe("3600");
      const put = await fetch(u.url, { method: "PUT", body: bytes(`body ${u.path}`) });
      expect(put.status).toBe(200);
    }
    expect((await h.keys(h.records)).filter((k) => k.startsWith("incoming/"))).toEqual(
      files.map((f) => `incoming/${made.id}/${f.path}`).sort(),
    );
  });

  test("refuses a path that could escape, in any encoding, before it signs anything", async () => {
    const made = await partnerJob();
    const before = h.standin.log.length;
    for (const path of [
      "",
      "../x",
      "a/../b",
      "a/..",
      "/abs",
      "a\\b",
      "a//b",
      "a/./b",
      "%2e%2e/x",
      "%2E%2E/x",
      "%252e%252e/x",
      "a/%2e%2e/b",
      "a%2f%2e%2e%2fb",
      // One stray `%` elsewhere must not switch the check off.
      "%2e%2e/%",
      "a/%2e%2e/b%",
      "%252e%252e/%",
      "100%/%2e%2e/x",
      "%2e%2e%ff/../x",
      "a\u0000b",
      "a\nb",
      "x".repeat(513),
    ]) {
      expect([path, await presignIncomingUploads(h.env(), made.id, [{ path, size: 1 }])]).toEqual([
        path,
        { ok: false, code: "invalid_spec", field: "files.0.path" },
      ]);
    }
    expect(h.standin.log.length).toBe(before);
  });

  test("refuses a duplicate path, too many files, a file over the file limit and a total over the limit", async () => {
    const made = await partnerJob();
    const limits = DEFAULT_COMPUTE_POLICY.bundleLimits;
    const ask = (files: Array<{ path: string; size: number }>) =>
      presignIncomingUploads(h.env(), made.id, files);
    expect(
      await ask([
        { path: "a", size: 1 },
        { path: "a", size: 2 },
      ]),
    ).toMatchObject({ ok: false, code: "invalid_spec", field: "files.1.path" });
    // Each file is one CopyObject, so a partner's own files are bounded below the owner's bundle count.
    expect(PARTNER_FILES_MAX).toBeLessThan(limits.maxFiles);
    expect(
      await ask(
        Array.from({ length: PARTNER_FILES_MAX + 1 }, (_, i) => ({ path: `f${i}`, size: 1 })),
      ),
    ).toMatchObject({ ok: false, code: "bundle_too_many_files" });
    expect(
      (await ask(Array.from({ length: PARTNER_FILES_MAX }, (_, i) => ({ path: `f${i}`, size: 1 }))))
        .ok,
    ).toBe(true);
    expect(await ask([{ path: "big", size: limits.maxFileBytes + 1 }])).toMatchObject({
      ok: false,
      code: "bundle_too_large",
    });
    expect((await ask([{ path: "big", size: limits.maxFileBytes }])).ok).toBe(true);
    const many = Array.from({ length: 5 }, (_, i) => ({
      path: `m${i}`,
      size: limits.maxFileBytes,
    }));
    expect(many.reduce((a, f) => a + f.size, 0)).toBeGreaterThan(limits.maxTotalBytes);
    expect(await ask(many)).toMatchObject({ ok: false, code: "bundle_too_large" });
  });

  test("follows the owner's limits, not constants", async () => {
    const owner = await seedUser(h.env().DB, { role: "owner" });
    await setPolicy(h.env().DB, owner, {
      bundleLimits: { maxTotalBytes: 100, maxFiles: 2, maxFileBytes: 60 },
    });
    const made = await partnerJob();
    const ask = (files: Array<{ path: string; size: number }>) =>
      presignIncomingUploads(h.env(), made.id, files);
    expect(
      (
        await ask([
          { path: "a", size: 60 },
          { path: "b", size: 40 },
        ])
      ).ok,
    ).toBe(true);
    expect(await ask([{ path: "a", size: 61 }])).toMatchObject({ code: "bundle_too_large" });
    expect(
      await ask([
        { path: "a", size: 60 },
        { path: "b", size: 41 },
      ]),
    ).toMatchObject({ code: "bundle_too_large" });
    expect(
      await ask([
        { path: "a", size: 1 },
        { path: "b", size: 1 },
        { path: "c", size: 1 },
      ]),
    ).toMatchObject({ code: "bundle_too_many_files" });
  });

  test("a job that is not there, one that has ended and one already finalized get no address", async () => {
    const env = h.env();
    const none = await presignIncomingUploads(env, `job_${"dd".repeat(12)}`, [
      { path: BUNDLE_ARCHIVE_NAME, size: 5 },
    ]);
    expect(none).toMatchObject({ ok: false, code: "job_not_found" });
    expect(
      await presignIncomingUploads(env, "job_x", [{ path: BUNDLE_ARCHIVE_NAME, size: 5 }]),
    ).toMatchObject({ ok: false, code: "job_not_found" });

    const ended = await bundleJob();
    await env.DB.prepare("UPDATE compute_jobs SET state = 'cancelled' WHERE id = ?")
      .bind(ended.id)
      .run();
    expect(
      await presignIncomingUploads(env, ended.id, [{ path: BUNDLE_ARCHIVE_NAME, size: 5 }]),
    ).toMatchObject({ ok: false, code: "bad_state" });

    // Never after the job is complete: once the records are written the addresses are not re-issued.
    const done = await bundleJob();
    await upload(done);
    const fin = await finalizeBundle(env, done.id, {
      archive: { sha256: done.sha256, size: done.archive.length },
      files: manifest(["run.py", 5]),
    });
    expect(fin.ok).toBe(true);
    expect(
      await presignIncomingUploads(env, done.id, [
        { path: BUNDLE_ARCHIVE_NAME, size: done.archive.length },
      ]),
    ).toMatchObject({ ok: false, code: "bad_state" });
  });

  test("with no S3 settings, or no records bucket, is disabled", async () => {
    const made = await bundleJob();
    const files = [{ path: BUNDLE_ARCHIVE_NAME, size: 5 }];
    expect(
      await presignIncomingUploads(h.env({ COMPUTE_R2_ACCESS_KEY_ID: undefined }), made.id, files),
    ).toEqual({ ok: false, code: "compute_disabled" });
    expect(
      await presignIncomingUploads(h.env({ COMPUTE_RECORDS: undefined }), made.id, files),
    ).toEqual({ ok: false, code: "compute_disabled" });
  });
});

describe("finalizeBundle", () => {
  const input = (made: Made, files = manifest(["run.py", 100], ["lib/util.py", 50])) => ({
    archive: { sha256: made.sha256, size: made.archive.length },
    files,
  });

  test("copies the archive into the records once, reads back, writes the manifest and marks the records written", async () => {
    const env = h.env();
    const made = await bundleJob();
    // The whole path a CLI takes: an address from the Worker, an upload to it, then finalize.
    const addr = await presignIncomingUploads(env, made.id, [
      { path: BUNDLE_ARCHIVE_NAME, size: made.archive.length, sha256: made.sha256 },
    ]);
    if (!addr.ok) throw new Error(addr.code);
    const put = await fetch(addr.uploads[0]?.url ?? "", {
      method: "PUT",
      headers: addr.uploads[0]?.headers,
      body: made.archive,
    });
    expect(put.status).toBe(200);
    expect(await recordsKeys()).not.toContain(submittedKey(made.id, BUNDLE_ARCHIVE_NAME));

    const r = await finalizeBundle(env, made.id, input(made));
    expect(r).toEqual({ ok: true, replayed: false, files: 2 });

    const copies = cp("CopyObject");
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({
      key: submittedKey(made.id, BUNDLE_ARCHIVE_NAME),
      copySource: `/${HARNESS_BUCKETS.records}/${incomingKey(made.id, BUNDLE_ARCHIVE_NAME)}`,
      status: 200,
      presigned: false,
    });
    const copied = await h.records.get(submittedKey(made.id, BUNDLE_ARCHIVE_NAME));
    expect(new Uint8Array((await copied?.arrayBuffer()) ?? new ArrayBuffer(0))).toEqual(
      made.archive,
    );
    expect(
      JSON.parse((await text(h.records, recordKey(made.id, "bundle-manifest.json"))) ?? "{}"),
    ).toEqual({
      job_id: made.id,
      archive: { sha256: made.sha256, size: made.archive.length },
      files: [
        { path: "run.py", size: 100 },
        { path: "lib/util.py", size: 50 },
      ],
    });
    const row = await env.DB.prepare("SELECT records_written_at FROM compute_jobs WHERE id = ?")
      .bind(made.id)
      .first<{ records_written_at: string | null }>();
    expect(row?.records_written_at).not.toBeNull();
    // The incoming copy is left to the bucket's own lifecycle rule.
    expect(await h.records.head(incomingKey(made.id, BUNDLE_ARCHIVE_NAME))).not.toBeNull();
  });

  test("a replay is ok, replayed, and copies nothing more", async () => {
    const env = h.env();
    const made = await bundleJob();
    await upload(made);
    expect((await finalizeBundle(env, made.id, input(made))).ok).toBe(true);
    const again = await finalizeBundle(env, made.id, input(made));
    expect(again).toEqual({ ok: true, replayed: true, files: 2 });
    expect(cp("CopyObject")).toHaveLength(1);
  });

  test("a replay that names other files is not a replay: the manifest that was recorded stands", async () => {
    const env = h.env();
    const made = await bundleJob();
    await upload(made);
    expect((await finalizeBundle(env, made.id, input(made))).ok).toBe(true);
    const recorded = await text(h.records, recordKey(made.id, "bundle-manifest.json"));
    expect(await finalizeBundle(env, made.id, input(made, manifest(["other.py", 1])))).toEqual({
      ok: false,
      code: "bad_state",
    });
    expect(await text(h.records, recordKey(made.id, "bundle-manifest.json"))).toBe(recorded);
    expect(cp("CopyObject")).toHaveLength(1);
  });

  const REFUSED: Array<[string, (made: Made) => ReturnType<typeof input>, string, string?]> = [
    [
      "a path with ../",
      (m) => input(m, manifest(["../etc/passwd", 1])),
      "invalid_spec",
      "files.0.path",
    ],
    [
      "a path with a ../ inside",
      (m) => input(m, manifest(["ok.py", 1], ["a/../b", 1])),
      "invalid_spec",
      "files.1.path",
    ],
    [
      "a double-encoded traversal",
      (m) => input(m, manifest(["%252e%252e/etc/passwd", 1])),
      "invalid_spec",
      "files.0.path",
    ],
    [
      "a single-encoded traversal",
      (m) => input(m, manifest(["%2e%2e/etc/passwd", 1])),
      "invalid_spec",
      "files.0.path",
    ],
    [
      "an encoded traversal and a stray percent sign",
      (m) => input(m, manifest(["%2e%2e/%", 1])),
      "invalid_spec",
      "files.0.path",
    ],
    [
      "an encoded traversal inside a path that ends in a stray percent sign",
      (m) => input(m, manifest(["ok.py", 1], ["a/%2e%2e/b%", 1])),
      "invalid_spec",
      "files.1.path",
    ],
    [
      "a double-encoded traversal and a stray percent sign",
      (m) => input(m, manifest(["ok.py", 1], ["%252e%252e/%", 1])),
      "invalid_spec",
      "files.1.path",
    ],
    [
      "an absolute path",
      (m) => input(m, manifest(["/etc/passwd", 1])),
      "invalid_spec",
      "files.0.path",
    ],
    ["a backslash", (m) => input(m, manifest(["a\\b", 1])), "invalid_spec", "files.0.path"],
    ["a NUL", (m) => input(m, manifest(["a\u0000b", 1])), "invalid_spec", "files.0.path"],
    ["an empty path", (m) => input(m, manifest(["", 1])), "invalid_spec", "files.0.path"],
    [
      "a duplicate path",
      (m) => input(m, manifest(["a.py", 1], ["a.py", 2])),
      "invalid_spec",
      "files.1.path",
    ],
    [
      "a size that is not a whole number",
      (m) => input(m, manifest(["a.py", 1.5])),
      "invalid_spec",
      "files.0.size",
    ],
    ["a negative size", (m) => input(m, manifest(["a.py", -1])), "invalid_spec", "files.0.size"],
    ["no file at all", (m) => input(m, []), "invalid_spec", "files"],
    [
      "too many files",
      (m) =>
        input(
          m,
          Array.from({ length: DEFAULT_COMPUTE_POLICY.bundleLimits.maxFiles + 1 }, (_, i) => ({
            path: `f${i}`,
            size: 1,
          })),
        ),
      "bundle_too_many_files",
    ],
    [
      "a file over the file limit",
      (m) => input(m, manifest(["big.bin", DEFAULT_COMPUTE_POLICY.bundleLimits.maxFileBytes + 1])),
      "bundle_too_large",
    ],
    [
      "an oversized total",
      (m) =>
        input(
          m,
          Array.from({ length: 5 }, (_, i) => ({
            path: `m${i}`,
            size: DEFAULT_COMPUTE_POLICY.bundleLimits.maxFileBytes,
          })),
        ),
      "bundle_too_large",
    ],
    [
      "another digest than the one the job was submitted with",
      (m) => ({ ...input(m), archive: { sha256: "0".repeat(64), size: m.archive.length } }),
      "invalid_spec",
      "archive",
    ],
    [
      "another size than the one the job was submitted with",
      (m) => ({ ...input(m), archive: { sha256: m.sha256, size: m.archive.length + 1 } }),
      "invalid_spec",
      "archive",
    ],
  ];

  for (const [name, build, code, field] of REFUSED) {
    test(`refuses ${name}: ${code}, with nothing copied, written or deleted`, async () => {
      const env = h.env();
      const made = await bundleJob();
      await upload(made);
      const keysBefore = await recordsKeys();
      const before = await trace(env.DB);
      const r = await finalizeBundle(env, made.id, build(made));
      expect(r).toEqual({ ok: false, code, ...(field ? { field } : {}) });
      expect(cp("CopyObject")).toHaveLength(0);
      expect(await recordsKeys()).toEqual(keysBefore);
      expect(await h.records.head(incomingKey(made.id, BUNDLE_ARCHIVE_NAME))).not.toBeNull();
      expect(await trace(env.DB)).toEqual(before);
      const row = await env.DB.prepare("SELECT records_written_at FROM compute_jobs WHERE id = ?")
        .bind(made.id)
        .first<{ records_written_at: string | null }>();
      expect(row?.records_written_at).toBeNull();
    });
  }

  test("refuses an archive whose size is not the declared one, and deletes nothing", async () => {
    const env = h.env();
    const made = await bundleJob();
    await h.records.put(
      incomingKey(made.id, BUNDLE_ARCHIVE_NAME),
      bytes("this is not the archive that was declared"),
    );
    const keysBefore = await recordsKeys();
    const r = await finalizeBundle(env, made.id, input(made));
    expect(r).toEqual({ ok: false, code: "invalid_spec", field: "archive" });
    expect(cp("CopyObject")).toHaveLength(0);
    expect(await recordsKeys()).toEqual(keysBefore);
    expect(await text(h.records, incomingKey(made.id, BUNDLE_ARCHIVE_NAME))).toBe(
      "this is not the archive that was declared",
    );
  });

  test("a job whose archive was never uploaded is not in a state to finalize", async () => {
    const made = await bundleJob();
    expect(await finalizeBundle(h.env(), made.id, input(made))).toEqual({
      ok: false,
      code: "bad_state",
    });
    expect(cp("CopyObject")).toHaveLength(0);
  });

  test("copies nothing for a job that was never committed: the archive waits in incoming, the records stay empty", async () => {
    const env = h.env();
    // A refused hold leaves no job, and a client that uploads anyway finds nothing to finalize.
    const ghost = `job_${"cc".repeat(12)}`;
    const archive = bytes("an archive for a job that does not exist");
    await h.records.put(incomingKey(ghost, BUNDLE_ARCHIVE_NAME), archive);
    const r = await finalizeBundle(env, ghost, {
      archive: { sha256: await sha256Hex(archive), size: archive.length },
      files: manifest(["run.py", 1]),
    });
    expect(r).toEqual({ ok: false, code: "job_not_found" });
    expect(cp("CopyObject")).toHaveLength(0);
    expect((await recordsKeys()).filter((k) => k.startsWith("records/"))).toEqual([]);
  });

  test("a job that has ended is not finalized", async () => {
    const env = h.env();
    const made = await bundleJob();
    await upload(made);
    await env.DB.prepare("UPDATE compute_jobs SET state = 'cancelled' WHERE id = ?")
      .bind(made.id)
      .run();
    expect(await finalizeBundle(env, made.id, input(made))).toEqual({
      ok: false,
      code: "bad_state",
    });
    expect(cp("CopyObject")).toHaveLength(0);
  });

  test("a job with no recorded specification (its records were never written) is not finalized", async () => {
    const env = h.env();
    const made = await bundleJob();
    await upload(made);
    await h.records.delete(recordKey(made.id, "spec.json"));
    expect(await finalizeBundle(env, made.id, input(made))).toEqual({
      ok: false,
      code: "bad_state",
    });
    expect(cp("CopyObject")).toHaveLength(0);
  });

  test("a copy that the store refuses is an error, writes nothing, and the retry after it works", async () => {
    const env = h.env();
    const made = await bundleJob();
    await upload(made);
    h.standin.failWith({ op: "CopyObject", status: 503, code: "SlowDown" });
    await expect(finalizeBundle(env, made.id, input(made))).rejects.toMatchObject({
      code: "copy_failed",
    });
    expect(
      (await recordsKeys()).filter(
        (k) => k.startsWith("records/") && !k.endsWith("identity.json") && !k.endsWith("spec.json"),
      ),
    ).toEqual([]);
    const row = await env.DB.prepare("SELECT records_written_at FROM compute_jobs WHERE id = ?")
      .bind(made.id)
      .first<{ records_written_at: string | null }>();
    expect(row?.records_written_at).toBeNull();
    expect((await finalizeBundle(env, made.id, input(made))).ok).toBe(true);
    expect(cp("CopyObject").filter((r) => r.status === 200)).toHaveLength(1);
  });

  test("resumes after a crash between the copy and the manifest, without copying again or rewriting", async () => {
    const env = h.env();
    const made = await bundleJob();
    await upload(made);
    // The copy is there, as a first attempt that died after it would have left it.
    await h.records.put(submittedKey(made.id, BUNDLE_ARCHIVE_NAME), made.archive);
    const r = await finalizeBundle(env, made.id, input(made));
    expect(r).toEqual({ ok: true, replayed: false, files: 2 });
    expect(cp("CopyObject")).toHaveLength(0);
    expect(await text(h.records, recordKey(made.id, "bundle-manifest.json"))).not.toBeNull();
    const row = await env.DB.prepare("SELECT records_written_at FROM compute_jobs WHERE id = ?")
      .bind(made.id)
      .first<{ records_written_at: string | null }>();
    expect(row?.records_written_at).not.toBeNull();
  });

  test("a different object already at the destination is never overwritten", async () => {
    const env = h.env();
    const made = await bundleJob();
    await upload(made);
    await h.records.put(
      submittedKey(made.id, BUNDLE_ARCHIVE_NAME),
      bytes("someone else's bytes, a different size"),
    );
    expect(await finalizeBundle(env, made.id, input(made))).toEqual({
      ok: false,
      code: "bad_state",
    });
    expect(cp("CopyObject")).toHaveLength(0);
    expect(await text(h.records, submittedKey(made.id, BUNDLE_ARCHIVE_NAME))).toBe(
      "someone else's bytes, a different size",
    );
  });

  test("a job made for partner files is not finalized as a bundle, and the reverse", async () => {
    const env = h.env();
    const partner = await partnerJob();
    expect(
      await finalizeBundle(env, partner.id, {
        archive: { sha256: "a".repeat(64), size: 5 },
        files: manifest(["a", 1]),
      }),
    ).toEqual({ ok: false, code: "bad_state" });
    const made = await bundleJob();
    expect(await finalizeSubmittedFiles(env, made.id, { files: manifest(["a", 1]) })).toEqual({
      ok: false,
      code: "bad_state",
    });
  });

  test("with no S3 settings or no records bucket, is disabled and copies nothing", async () => {
    const made = await bundleJob();
    await upload(made);
    expect(
      await finalizeBundle(
        h.env({ COMPUTE_R2_SECRET_ACCESS_KEY: undefined }),
        made.id,
        input(made),
      ),
    ).toEqual({ ok: false, code: "compute_disabled" });
    expect(
      await finalizeBundle(h.env({ COMPUTE_RECORDS: undefined }), made.id, input(made)),
    ).toEqual({ ok: false, code: "compute_disabled" });
    expect(cp("CopyObject")).toHaveLength(0);
  });
});

describe("finalizeSubmittedFiles (a partner's own files)", () => {
  const FILES = [
    ["src/run.py", "print('run')"],
    ["params.json", '{"a":1}'],
    ["a..b.csv", "1,2"],
  ] as const;

  async function uploaded() {
    const made = await partnerJob();
    for (const [path, body] of FILES) await h.records.put(incomingKey(made.id, path), bytes(body));
    return made;
  }
  const declared = () => FILES.map(([path, body]) => ({ path, size: bytes(body).length }));

  test("copies each file once, reads each back, writes the manifest and marks the records written", async () => {
    const env = h.env();
    const made = await uploaded();
    const r = await finalizeSubmittedFiles(env, made.id, { files: declared() });
    expect(r).toEqual({ ok: true, replayed: false, files: 3 });
    const copies = cp("CopyObject");
    expect(copies).toHaveLength(3);
    expect(copies.map((c) => c.key).sort()).toEqual(
      FILES.map(([p]) => submittedKey(made.id, p)).sort(),
    );
    for (const [path, body] of FILES)
      expect(await text(h.records, submittedKey(made.id, path))).toBe(body);
    expect(
      JSON.parse((await text(h.records, recordKey(made.id, "bundle-manifest.json"))) ?? "{}"),
    ).toEqual({
      job_id: made.id,
      archive: null,
      files: declared(),
    });
    const row = await env.DB.prepare("SELECT records_written_at FROM compute_jobs WHERE id = ?")
      .bind(made.id)
      .first<{ records_written_at: string | null }>();
    expect(row?.records_written_at).not.toBeNull();
  });

  test("a replay copies nothing more", async () => {
    const env = h.env();
    const made = await uploaded();
    await finalizeSubmittedFiles(env, made.id, { files: declared() });
    expect(await finalizeSubmittedFiles(env, made.id, { files: declared() })).toEqual({
      ok: true,
      replayed: true,
      files: 3,
    });
    expect(cp("CopyObject")).toHaveLength(3);
  });

  test("a file of the wrong size refuses the whole set before any is copied", async () => {
    const env = h.env();
    const made = await uploaded();
    const files = declared();
    (files[1] as { size: number }).size += 1;
    expect(await finalizeSubmittedFiles(env, made.id, { files })).toEqual({
      ok: false,
      code: "invalid_spec",
      field: "files.1.size",
    });
    expect(cp("CopyObject")).toHaveLength(0);
    expect((await recordsKeys()).filter((k) => k.includes("/submitted/"))).toEqual([]);
    expect((await recordsKeys()).filter((k) => k.startsWith("incoming/"))).toHaveLength(3);
  });

  test("a file that was never uploaded refuses the set", async () => {
    const env = h.env();
    const made = await uploaded();
    await h.records.delete(incomingKey(made.id, "params.json"));
    expect(await finalizeSubmittedFiles(env, made.id, { files: declared() })).toEqual({
      ok: false,
      code: "bad_state",
      field: "files.1.path",
    });
    expect(cp("CopyObject")).toHaveLength(0);
  });

  test("refuses traversal and the owner's limits as the addresses do, and a job that is not there", async () => {
    const env = h.env();
    const made = await uploaded();
    expect(await finalizeSubmittedFiles(env, made.id, { files: manifest(["../x", 1]) })).toEqual({
      ok: false,
      code: "invalid_spec",
      field: "files.0.path",
    });
    expect(
      await finalizeSubmittedFiles(env, made.id, { files: manifest(["%252e%252e/x", 1]) }),
    ).toEqual({ ok: false, code: "invalid_spec", field: "files.0.path" });
    expect(
      await finalizeSubmittedFiles(env, made.id, {
        files: manifest(["a", DEFAULT_COMPUTE_POLICY.bundleLimits.maxFileBytes + 1]),
      }),
    ).toMatchObject({ ok: false, code: "bundle_too_large" });
    expect(
      await finalizeSubmittedFiles(env, `job_${"bb".repeat(12)}`, { files: declared() }),
    ).toEqual({ ok: false, code: "job_not_found" });
    expect(cp("CopyObject")).toHaveLength(0);
  });
});

/** A bucket that delegates to the real one and records which methods were called. */
function spy(real: R2Bucket): { bucket: R2Bucket; calls: string[] } {
  const calls: string[] = [];
  const bucket = {
    put: (k: string, v: unknown, o?: unknown) => {
      calls.push("put");
      return real.put(k, v as ArrayBuffer, o as Parameters<R2Bucket["put"]>[2]);
    },
    get: (k: string) => {
      calls.push("get");
      return real.get(k);
    },
    head: (k: string) => {
      calls.push("head");
      return real.head(k);
    },
    delete: (k: string) => real.delete(k),
    list: (o?: Parameters<R2Bucket["list"]>[0]) => {
      calls.push("list");
      return real.list(o);
    },
  } as unknown as R2Bucket;
  return { bucket, calls };
}

const recordsWrittenAt = async (env: Bindings, id: string) =>
  (
    await env.DB.prepare("SELECT records_written_at FROM compute_jobs WHERE id = ?")
      .bind(id)
      .first<{ records_written_at: string | null }>()
  )?.records_written_at;

describe("a path that passes the path rule and cannot be a key", () => {
  // The path rule counts 512 UTF-16 characters; a key may be 1,024 BYTES, and 400 characters of 3 bytes
  // are 1,200. A lone surrogate is a valid string and is no text a key can carry (encodeURIComponent
  // throws a raw URIError on it). Both are found BEFORE anything is signed, and answered as the path.
  const WIDE = "\u3042".repeat(400);
  const LONE = ["\ud800", "a\udc00b", "ok/\ud83dx"];

  test("both pass the path rule on its own, which is the disagreement", () => {
    expect(submittedPathProblem(WIDE)).toBeNull();
    for (const p of LONE) expect([p, submittedPathProblem(p)]).toEqual([p, null]);
  });

  test("presignIncomingUploads refuses them as invalid_spec naming the path, and signs nothing", async () => {
    const made = await partnerJob();
    const before = h.standin.log.length;
    for (const bad of [WIDE, ...LONE]) {
      expect([
        bad.length,
        await presignIncomingUploads(h.env(), made.id, [
          { path: "fine.txt", size: 1 },
          { path: bad, size: 1 },
        ]),
      ]).toEqual([bad.length, { ok: false, code: "invalid_spec", field: "files.1.path" }]);
    }
    expect(h.standin.log.length).toBe(before);
  });

  test("the records key is longer than the incoming key, and counts too: 327 wide characters pass one and not the other", async () => {
    const made = await partnerJob();
    const path = "\u3042".repeat(327);
    const bytesOf = (k: string) => new TextEncoder().encode(k).length;
    expect(bytesOf(incomingKey(made.id, path))).toBeLessThanOrEqual(1024);
    expect(bytesOf(submittedKey(made.id, path))).toBeGreaterThan(1024);
    expect(await presignIncomingUploads(h.env(), made.id, [{ path, size: 1 }])).toEqual({
      ok: false,
      code: "invalid_spec",
      field: "files.0.path",
    });
    // One character fewer is a key on both sides.
    const shorter = "\u3042".repeat(325);
    expect((await presignIncomingUploads(h.env(), made.id, [{ path: shorter, size: 1 }])).ok).toBe(
      true,
    );
  });

  test("finalizeSubmittedFiles refuses them the same way, before any listing or copy", async () => {
    const made = await partnerJob();
    const { bucket, calls } = spy(h.records);
    const env = { ...h.env(), COMPUTE_RECORDS: bucket };
    for (const bad of [WIDE, ...LONE, "\u3042".repeat(327)]) {
      expect([
        bad.length,
        await finalizeSubmittedFiles(env, made.id, { files: [{ path: bad, size: 1 }] }),
      ]).toEqual([bad.length, { ok: false, code: "invalid_spec", field: "files.0.path" }]);
    }
    expect(calls).toEqual([]);
    expect(cp("CopyObject")).toHaveLength(0);
  });

  test("a bundle manifest path builds no key, so it keeps the 512-character rule", async () => {
    const env = h.env();
    const made = await bundleJob();
    await upload(made);
    const r = await finalizeBundle(env, made.id, {
      archive: { sha256: made.sha256, size: made.archive.length },
      files: [
        { path: WIDE, size: 1 },
        { path: "\ud800", size: 1 },
      ],
    });
    expect(r).toEqual({ ok: true, replayed: false, files: 2 });
  });

  test("an owner's read of a submitted file with such a name is no record, and writes no row", async () => {
    const env = h.env();
    const owner = await seedUser(env.DB, { role: "owner" });
    const made = await bundleJob();
    for (const path of [WIDE, ...LONE, "\u3042".repeat(327)]) {
      const before = await trace(env.DB);
      expect([
        path.length,
        await readRecordObject(env, env.DB, {
          actor: { id: owner },
          jobId: made.id,
          name: `submitted/${path}`,
          reason: "audit request 4711",
        }),
      ]).toEqual([path.length, { ok: false, code: "invalid_record" }]);
      expect(await trace(env.DB)).toEqual(before);
    }
  });
});

describe("the finalize guards of the partner form", () => {
  const FILES = [
    ["src/run.py", "print('run')"],
    ["params.json", '{"a":1}'],
    ["a..b.csv", "1,2"],
  ] as const;
  const declared = () => FILES.map(([path, body]) => ({ path, size: bytes(body).length }));
  async function uploaded() {
    const made = await partnerJob();
    for (const [path, body] of FILES) await h.records.put(incomingKey(made.id, path), bytes(body));
    return made;
  }

  test("more than the partner cap is bundle_too_many_files, with no listing and no copy", async () => {
    const made = await partnerJob();
    const { bucket, calls } = spy(h.records);
    const env = { ...h.env(), COMPUTE_RECORDS: bucket };
    expect(PARTNER_FILES_MAX).toBe(500);
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `f${i}`, size: 1 }));
    expect(
      await finalizeSubmittedFiles(env, made.id, { files: many(PARTNER_FILES_MAX + 1) }),
    ).toEqual({ ok: false, code: "bundle_too_many_files" });
    expect(calls).toEqual([]);
    expect(cp("CopyObject")).toHaveLength(0);
    // The cap itself is allowed past the count (these were never uploaded, so it stops at the first).
    expect(await finalizeSubmittedFiles(env, made.id, { files: many(PARTNER_FILES_MAX) })).toEqual({
      ok: false,
      code: "bad_state",
      field: "files.0.path",
    });
  });

  test("a destination that already holds another size is bad_state naming that file, and nothing is copied", async () => {
    const env = h.env();
    const made = await uploaded();
    await h.records.put(submittedKey(made.id, "params.json"), bytes("someone else's longer bytes"));
    expect(await finalizeSubmittedFiles(env, made.id, { files: declared() })).toEqual({
      ok: false,
      code: "bad_state",
      field: "files.1.path",
    });
    expect(cp("CopyObject")).toHaveLength(0);
    expect(await text(h.records, submittedKey(made.id, "params.json"))).toBe(
      "someone else's longer bytes",
    );
    expect((await recordsKeys()).filter((k) => k.endsWith("bundle-manifest.json"))).toEqual([]);
    expect(await recordsWrittenAt(env, made.id)).toBeNull();
  });

  test("a different manifest already recorded is bad_state and stays as it was", async () => {
    const env = h.env();
    const made = await uploaded();
    await h.records.put(
      recordKey(made.id, "bundle-manifest.json"),
      bytes('{"another":"manifest"}'),
    );
    expect(await finalizeSubmittedFiles(env, made.id, { files: declared() })).toEqual({
      ok: false,
      code: "bad_state",
    });
    expect(await text(h.records, recordKey(made.id, "bundle-manifest.json"))).toBe(
      '{"another":"manifest"}',
    );
    expect(await recordsWrittenAt(env, made.id)).toBeNull();
  });

  test("the same holds for a bundle: a different manifest already recorded stays, and the job is not written", async () => {
    const env = h.env();
    const made = await bundleJob();
    await upload(made);
    await h.records.put(
      recordKey(made.id, "bundle-manifest.json"),
      bytes('{"another":"manifest"}'),
    );
    expect(
      await finalizeBundle(env, made.id, {
        archive: { sha256: made.sha256, size: made.archive.length },
        files: manifest(["run.py", 1]),
      }),
    ).toEqual({ ok: false, code: "bad_state" });
    expect(await text(h.records, recordKey(made.id, "bundle-manifest.json"))).toBe(
      '{"another":"manifest"}',
    );
    expect(await recordsWrittenAt(env, made.id)).toBeNull();
  });
});

describe("the create-only conditional write", () => {
  /** A bucket whose `head` never finds anything: a stale view, as a race between the head and the put would be. */
  const stale = (real: R2Bucket): R2Bucket =>
    ({
      put: (k: string, v: unknown, o?: unknown) =>
        real.put(k, v as ArrayBuffer, o as Parameters<R2Bucket["put"]>[2]),
      get: (k: string) => real.get(k),
      head: async () => null,
      delete: (k: string) => real.delete(k),
      list: (o?: Parameters<R2Bucket["list"]>[0]) => real.list(o),
    }) as unknown as R2Bucket;

  test("refuses to replace a record the head did not see: a different specification is a conflict and the bytes stay", async () => {
    const id = `job_${"00".repeat(11)}a1`;
    await h.records.put(recordKey(id, "spec.json"), bytes('{"first":true}'));
    const env = { ...h.env(), COMPUTE_RECORDS: stale(h.records) };
    await expect(writeSpec(env, id, '{"second":true}')).rejects.toMatchObject({
      code: "record_conflict",
    });
    expect(await text(h.records, recordKey(id, "spec.json"))).toBe('{"first":true}');
    // The same text is no conflict, and still writes nothing over it.
    await writeSpec(env, id, '{"first":true}');
    expect(await text(h.records, recordKey(id, "spec.json"))).toBe('{"first":true}');
  });

  test("keeps the first identity snapshot whatever the head says", async () => {
    const e0 = h.env();
    const accountId = await seedUser(e0.DB, { given_name: "First" });
    const id = `job_${"00".repeat(11)}a2`;
    await h.records.put(recordKey(id, "identity.json"), bytes('{"first":"snapshot"}'));
    const env = { ...e0, COMPUTE_RECORDS: stale(h.records) };
    await writeIdentitySnapshot(env, id, accountId);
    expect(await text(h.records, recordKey(id, "identity.json"))).toBe('{"first":"snapshot"}');
  });
});

describe("a copy is bounded by what R2 copies in one request", () => {
  const GIB = 1024 ** 3;
  test("the bound is 5 GiB, whatever the owner's limits say", () => {
    expect(COPY_OBJECT_MAX_BYTES).toBe(5 * GIB);
  });

  test("an owner's limit above it does not lift it: the job, the address and the finalize all refuse", async () => {
    const env = h.env();
    const owner = await seedUser(env.DB, { role: "owner" });
    await setPolicy(env.DB, owner, {
      bundleLimits: { maxTotalBytes: 10 * GIB, maxFiles: 2000, maxFileBytes: 8 * GIB },
    });
    const sha = "a".repeat(64);
    const accountId = await seedUser(env.DB);
    await fundAccount(env.DB, accountId, 100_000);
    await fundPlatform(env.DB, "people", 1_000_000_000);
    const base = { source: "cli" as const, accountId, appId: "nemar-launch", appVersion: "1.0.0" };
    const refused = await createJob(env, {
      ...base,
      spec: bundleJobSpec({ size: COPY_OBJECT_MAX_BYTES + 1, sha256: sha }),
    });
    expect(refused).toEqual({ ok: false, code: "bundle_too_large" });
    const exact = await createJob(env, {
      ...base,
      spec: bundleJobSpec({ size: COPY_OBJECT_MAX_BYTES, sha256: sha }),
    });
    expect(exact.ok).toBe(true);
    if (!exact.ok) return;
    expect(
      await finalizeBundle(env, exact.job.id, {
        archive: { sha256: sha, size: COPY_OBJECT_MAX_BYTES + 1 },
        files: manifest(["run.py", 1]),
      }),
    ).toEqual({ ok: false, code: "bundle_too_large" });
    expect(cp("CopyObject")).toHaveLength(0);

    // The address for a bundle is held to the bound on its own, not only because the job was: a job
    // whose recorded specification names a larger archive (made under no such bound) gets no address.
    const small = await bundleJob();
    await h.records.put(
      recordKey(small.id, "spec.json"),
      JSON.stringify(bundleJobSpec({ size: COPY_OBJECT_MAX_BYTES + 1, sha256: small.sha256 })),
    );
    expect(
      await presignIncomingUploads(env, small.id, [
        { path: BUNDLE_ARCHIVE_NAME, size: COPY_OBJECT_MAX_BYTES + 1 },
      ]),
    ).toEqual({ ok: false, code: "bundle_too_large" });

    const partner = await partnerJob();
    for (const [size, ok] of [
      [COPY_OBJECT_MAX_BYTES + 1, false],
      [COPY_OBJECT_MAX_BYTES, true],
    ] as const) {
      const r = await presignIncomingUploads(env, partner.id, [{ path: "big.bin", size }]);
      expect([size, r.ok]).toEqual([size, ok]);
      if (!r.ok) expect(r.code).toBe("bundle_too_large");
    }
    expect(
      await finalizeSubmittedFiles(env, partner.id, {
        files: [{ path: "big.bin", size: COPY_OBJECT_MAX_BYTES + 1 }],
      }),
    ).toEqual({ ok: false, code: "bundle_too_large" });
  });
});

describe("the outputs request cap, derived from the owner's file limit", () => {
  test("is at least the launcher's own 1 MiB for the default limit, and grows with the limit", () => {
    expect(
      outputsBodyLimitBytes(DEFAULT_COMPUTE_POLICY.resultLimits.maxFiles),
    ).toBeGreaterThanOrEqual(MIB);
    expect(outputsBodyLimitBytes(10_000)).toBeGreaterThan(outputsBodyLimitBytes(1_000));
  });

  test("holds an entry of the contract's worst case: the longest path of the widest characters, the largest size", () => {
    // 512 characters of 3 UTF-8 bytes each, a 16-digit size, a 64-digit checksum, the keys and the comma.
    const worst = JSON.stringify({
      path: "☃".repeat(512),
      size: Number.MAX_SAFE_INTEGER,
      sha256: "f".repeat(64),
    });
    expect(OUTPUT_ENTRY_BYTES_MAX).toBeGreaterThanOrEqual(
      new TextEncoder().encode(worst).length + 1,
    );
    const request = JSON.stringify({
      outputs: Array.from({ length: 1000 }, () => ({
        path: "☃".repeat(512),
        size: Number.MAX_SAFE_INTEGER,
        sha256: "f".repeat(64),
      })),
      launcher: [
        { name: "result.json", size: 1 },
        { name: "provenance.json", size: 1 },
        { name: "manifest.json", size: 1 },
        { name: "launcher.log", size: 1 },
      ],
    });
    expect(outputsBodyLimitBytes(1000)).toBeGreaterThanOrEqual(
      new TextEncoder().encode(request).length,
    );
  });

  test("is bounded by what a Worker can read: never more than 64 MiB, whatever the limit", () => {
    expect(outputsBodyLimitBytes(100_000)).toBe(64 * MIB);
    expect(outputsBodyLimitBytes(1)).toBeGreaterThanOrEqual(MIB);
    for (const bad of [0, -1, 1.5, Number.NaN, 100_001]) {
      expect(() => outputsBodyLimitBytes(bad)).toThrow(RangeError);
    }
  });
});
