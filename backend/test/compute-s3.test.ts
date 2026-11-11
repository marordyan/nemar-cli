/**
 * The compute gateway's S3-API signer (`services/compute-s3.ts`), against a real local server that
 * verifies SigV4 and serves the same Miniflare R2 buckets the bindings read (epic #2005 phase A3,
 * #2008; ADR 0118 decision 7).
 *
 * WHAT NO TEST HERE CAN SHOW is how Cloudflare R2 itself canonicalises a path or treats the
 * `x-amz-checksum-sha256` header on a presigned PUT: there is no real response to record yet, and the
 * R2 API token is the owner's. The stand-in recomputes the signature with the same library over the
 * request as it arrived, so what is proven is that the address the Worker hands out is the address
 * that was signed, for every kind of name a job's output may carry.
 *
 * What is pinned: a presigned PUT lands in the bucket a binding then reads, under the DECODED key,
 * for names that a stricter key predicate refuses (`a..b.csv`) or throws on (`100%.txt`) and for
 * every character a path may hold; a changed key, expiry or secret is refused by the signature; an
 * address is refused past its expiry and an expiry above seven days is refused by both sides; the
 * checksum header is signed with the URL and a body that does not match it is refused; `CopyObject`
 * is one request, copies the bytes, and a copy that fails, or that answers 200 with an error body,
 * is an error; a path that could escape (an empty, `.` or `..` segment, a backslash, a control
 * character, a leading slash) is refused before anything is signed.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { COMPUTE_PATH_RE, isSafeComputePath } from "../../shared/contract/compute";
import { resultsOutputKey } from "../../shared/contract/compute-launch";
import {
  COMPUTE_PRESIGN_MAX_SECONDS,
  type ComputeS3,
  ComputeS3Error,
  computeS3,
  copyObject,
  objectKeyProblem,
  presignGet,
  presignPut,
} from "../src/services/compute-s3";
import {
  type ComputeHarness,
  HARNESS_BUCKETS,
  startComputeHarness,
} from "./helpers/compute-harness";

let h: ComputeHarness;
const JOB = `job_${"ab12".repeat(6)}`;

function client(over: Parameters<ComputeHarness["env"]>[0] = {}): ComputeS3 {
  const s3 = computeS3(h.env(over));
  if (!s3) throw new Error("the harness environment has no S3 settings");
  return s3;
}

const bytes = (text: string) => new TextEncoder().encode(text);
const text = async (bucket: R2Bucket, key: string) =>
  (await (await bucket.get(key))?.text()) ?? null;

beforeAll(async () => {
  h = await startComputeHarness();
}, 60_000);

beforeEach(async () => {
  await h.reset();
});

afterAll(async () => {
  await h?.dispose();
}, 30_000);

describe("a presigned PUT", () => {
  test("lands in the bucket under the key, readable through the binding, and is logged once", async () => {
    const put = await presignPut(client(), "records", `records/${JOB}/spec.json`, {
      expiresIn: 3600,
    });
    const res = await fetch(put.url, { method: "PUT", body: bytes('{"a":1}') });
    expect(res.status).toBe(200);
    expect(await text(h.records, `records/${JOB}/spec.json`)).toBe('{"a":1}');
    expect(h.standin.log).toHaveLength(1);
    expect(h.standin.log[0]).toMatchObject({
      op: "PutObject",
      bucket: HARNESS_BUCKETS.records,
      key: `records/${JOB}/spec.json`,
      presigned: true,
      expires: 3600,
      status: 200,
    });
  });

  test("goes to the bucket it names: the results bucket is not the records bucket", async () => {
    const put = await presignPut(client(), "results", `jobs/${JOB}/outputs/x.csv`, {
      expiresIn: 3600,
    });
    expect((await fetch(put.url, { method: "PUT", body: bytes("1,2") })).status).toBe(200);
    expect(await h.keys(h.results)).toEqual([`jobs/${JOB}/outputs/x.csv`]);
    expect(await h.keys(h.records)).toEqual([]);
  });

  // Names an output may carry. The first two are the ones a key predicate built for annex keys
  // (`assertValidS3Key`) gets wrong: it refuses a `..` INSIDE a name, and it throws on a stray `%`,
  // either of which would fail the upload with a code that refunds the job.
  const NAMES = [
    "a..b.csv",
    "100%.txt",
    "50%25.txt",
    "a+b.txt",
    "sp ace.txt",
    "tab\there.txt".replace("\t", "_"),
    "é-ü.txt",
    "emoji-\u{1F9E0}.txt",
    "q?uery#frag.txt",
    "paren(1)[2]{3}.txt",
    "quote'single\"double.txt",
    "star*bang!tilde~.txt",
    "amp&eq=semi;colon:at@dollar$comma,.txt",
    "dir with space/inner..name/100%/f.bin",
    "...dots",
    "a.b.c",
    ".hidden",
  ];

  for (const name of NAMES) {
    test(`an output named ${JSON.stringify(name)} round-trips under the decoded key`, async () => {
      expect(COMPUTE_PATH_RE.test(name)).toBe(true);
      expect(isSafeComputePath(name)).toBe(true);
      const key = resultsOutputKey(JOB, name);
      expect(objectKeyProblem(key)).toBeNull();
      const put = await presignPut(client(), "results", key, { expiresIn: 3600 });
      const res = await fetch(put.url, { method: "PUT", body: bytes(`body of ${name}`) });
      expect(res.status).toBe(200);
      expect(h.standin.log.at(-1)).toMatchObject({ key, status: 200 });
      expect(await h.keys(h.results)).toEqual([key]);
      expect(await text(h.results, key)).toBe(`body of ${name}`);
      // And a GET address for the same key reads it back.
      const get = await presignGet(client(), "results", key, { expiresIn: 600 });
      const back = await fetch(get.url);
      expect(back.status).toBe(200);
      expect(await back.text()).toBe(`body of ${name}`);
    });
  }

  test("a changed key is refused by the signature, and nothing is written", async () => {
    const put = await presignPut(client(), "records", `records/${JOB}/spec.json`, {
      expiresIn: 3600,
    });
    const forged = put.url.replace("spec.json", "identity.json");
    const res = await fetch(forged, { method: "PUT", body: bytes("{}") });
    expect(res.status).toBe(403);
    expect(h.standin.log.at(-1)?.code).toBe("SignatureDoesNotMatch");
    expect(await h.keys(h.records)).toEqual([]);
  });

  test("a changed expiry is refused by the signature", async () => {
    const put = await presignPut(client(), "records", `records/${JOB}/spec.json`, {
      expiresIn: 3600,
    });
    const url = new URL(put.url);
    url.searchParams.set("X-Amz-Expires", "604800");
    const res = await fetch(url, { method: "PUT", body: bytes("{}") });
    expect(res.status).toBe(403);
    expect(h.standin.log.at(-1)?.code).toBe("SignatureDoesNotMatch");
  });

  test("an address signed with another secret is refused", async () => {
    const put = await presignPut(
      client({ COMPUTE_R2_SECRET_ACCESS_KEY: "not-the-secret" }),
      "records",
      `records/${JOB}/spec.json`,
      { expiresIn: 3600 },
    );
    const res = await fetch(put.url, { method: "PUT", body: bytes("{}") });
    expect(res.status).toBe(403);
    expect(h.standin.log.at(-1)?.code).toBe("SignatureDoesNotMatch");
    expect(await h.keys(h.records)).toEqual([]);
  });

  test("a different method is not what was signed", async () => {
    const put = await presignPut(client(), "records", `records/${JOB}/spec.json`, {
      expiresIn: 3600,
    });
    expect((await fetch(put.url, { method: "DELETE" })).status).toBe(403);
    expect((await fetch(put.url)).status).toBe(403);
  });

  test("is refused past its one-hour expiry, and the same key re-signed works", async () => {
    const key = `jobs/${JOB}/outputs/late.csv`;
    const put = await presignPut(client(), "results", key, { expiresIn: 3600 });
    h.standin.clock.now = () => Date.now() + 2 * 3600 * 1000;
    const late = await fetch(put.url, { method: "PUT", body: bytes("x") });
    expect(late.status).toBe(403);
    expect(h.standin.log.at(-1)?.code).toBe("AccessDenied");
    expect(await h.keys(h.results)).toEqual([]);
    // A launcher re-requests an address after expiry: a fresh one, signed now, is good.
    h.standin.clock.now = () => Date.now() + 2 * 3600 * 1000;
    const again = await presignPut(client(), "results", key, {
      expiresIn: 3600,
      now: new Date(h.standin.clock.now()),
    });
    expect((await fetch(again.url, { method: "PUT", body: bytes("x") })).status).toBe(200);
  });

  test("a seven-day address is good for a week and the stand-in refuses more than that itself", async () => {
    const key = `records/${JOB}/week.bin`;
    const week = await presignPut(client(), "records", key, {
      expiresIn: COMPUTE_PRESIGN_MAX_SECONDS,
    });
    h.standin.clock.now = () => Date.now() + 6 * 24 * 3600 * 1000;
    expect((await fetch(week.url, { method: "PUT", body: bytes("w") })).status).toBe(200);
    // The signer refuses an eighth day before it signs; hand-craft one to prove the SERVER does too.
    const { AwsClient } = await import("aws4fetch");
    const raw = new AwsClient({
      accessKeyId: h.standin.accessKeyId,
      secretAccessKey: h.standin.secretAccessKey,
      service: "s3",
      region: "auto",
    });
    const url = `${h.standin.url}/${HARNESS_BUCKETS.records}/records/${JOB}/eight.bin?X-Amz-Expires=${COMPUTE_PRESIGN_MAX_SECONDS + 1}`;
    const signed = await raw.sign(url, { method: "PUT", aws: { signQuery: true } });
    const res = await fetch(signed.url, { method: "PUT", body: bytes("8") });
    expect(res.status).toBe(400);
    expect(h.standin.log.at(-1)?.code).toBe("AuthorizationQueryParametersError");
  });

  test("signs the checksum header with the URL, and a body that does not match it is refused", async () => {
    const body = bytes("the bundle bytes");
    const hex = createHash("sha256").update(body).digest("hex");
    const key = `incoming/${JOB}/bundle.tar.gz`;
    const put = await presignPut(client(), "records", key, { expiresIn: 3600, sha256Hex: hex });
    expect(put.headers["x-amz-checksum-sha256"]).toBe(
      createHash("sha256").update(body).digest("base64"),
    );
    expect(new URL(put.url).searchParams.get("X-Amz-SignedHeaders")).toBe(
      "host;x-amz-checksum-sha256",
    );

    const wrong = await fetch(put.url, {
      method: "PUT",
      headers: put.headers,
      body: bytes("another body altogether"),
    });
    expect(wrong.status).toBe(400);
    expect(h.standin.log.at(-1)?.code).toBe("BadDigest");
    expect(await h.keys(h.records)).toEqual([]);

    // The header is part of the signature: a client that leaves it out is refused, not trusted.
    const missing = await fetch(put.url, { method: "PUT", body });
    expect(missing.status).toBe(403);
    expect(h.standin.log.at(-1)?.code).toBe("SignatureDoesNotMatch");

    const ok = await fetch(put.url, { method: "PUT", headers: put.headers, body });
    expect(ok.status).toBe(200);
    expect(await text(h.records, key)).toBe("the bundle bytes");
  });

  test("a digest that is not 64 lowercase hex digits is refused before anything is signed", async () => {
    for (const sha256Hex of ["", "abc", "A".repeat(64), "g".repeat(64), "a".repeat(63)]) {
      await expect(
        presignPut(client(), "records", `incoming/${JOB}/bundle.tar.gz`, {
          expiresIn: 3600,
          sha256Hex,
        }),
      ).rejects.toMatchObject({ code: "digest_invalid" });
    }
  });
});

describe("a presigned GET", () => {
  test("reads the object, with the expiry it was signed for, and is refused when the object is absent", async () => {
    const key = `records/${JOB}/submitted/bundle.tar.gz`;
    await h.records.put(key, bytes("archive"));
    const get = await presignGet(client(), "records", key, { expiresIn: 600 });
    const res = await fetch(get.url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("archive");
    expect(h.standin.log.at(-1)).toMatchObject({ op: "GetObject", expires: 600, presigned: true });
    const missing = await presignGet(client(), "records", `records/${JOB}/nope`, {
      expiresIn: 600,
    });
    expect((await fetch(missing.url)).status).toBe(404);
  });

  test("is refused past its expiry", async () => {
    const key = `records/${JOB}/x`;
    await h.records.put(key, bytes("x"));
    const get = await presignGet(client(), "records", key, { expiresIn: 300 });
    h.standin.clock.now = () => Date.now() + 10 * 60 * 1000;
    expect((await fetch(get.url)).status).toBe(403);
  });
});

describe("copyObject", () => {
  const src = `incoming/${JOB}/bundle.tar.gz`;
  const dst = `records/${JOB}/submitted/bundle.tar.gz`;

  test("is one CopyObject request, signed by header, and copies the bytes", async () => {
    await h.records.put(src, bytes("the archive"));
    await copyObject(client(), { bucket: "records", key: src }, { bucket: "records", key: dst });
    expect(await text(h.records, dst)).toBe("the archive");
    expect(await text(h.records, src)).toBe("the archive");
    const copies = h.standin.log.filter((r) => r.op === "CopyObject");
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({
      bucket: HARNESS_BUCKETS.records,
      key: dst,
      presigned: false,
      copySource: `/${HARNESS_BUCKETS.records}/${src}`,
      status: 200,
    });
    expect(copies[0]?.signedHeaders).toContain("x-amz-copy-source");
  });

  test("copies a key whose name needs encoding, between buckets", async () => {
    const from = `incoming/${JOB}/100%/a..b+c d.txt`;
    const to = `jobs/${JOB}/outputs/100%/a..b+c d.txt`;
    await h.records.put(from, bytes("odd"));
    await copyObject(client(), { bucket: "records", key: from }, { bucket: "results", key: to });
    expect(await text(h.results, to)).toBe("odd");
  });

  test("an error status is an error with a fixed code that holds no key", async () => {
    await h.records.put(src, bytes("x"));
    h.standin.failWith({ op: "CopyObject", status: 503, code: "SlowDown" });
    const err = await copyObject(
      client(),
      { bucket: "records", key: src },
      { bucket: "records", key: dst },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ComputeS3Error);
    expect(err.code).toBe("copy_failed");
    expect(String(err.message)).not.toContain(JOB);
    expect(await h.keys(h.records)).toEqual([src]);
  });

  test("a 200 whose body is an error is an error too (S3 can fail a copy after it has answered)", async () => {
    await h.records.put(src, bytes("x"));
    h.standin.failWith({ op: "CopyObject", status: 200, code: "InternalError" });
    await expect(
      copyObject(client(), { bucket: "records", key: src }, { bucket: "records", key: dst }),
    ).rejects.toMatchObject({ code: "copy_failed" });
    expect(await h.keys(h.records)).toEqual([src]);
  });

  test("a source that is not there is an error", async () => {
    await expect(
      copyObject(client(), { bucket: "records", key: src }, { bucket: "records", key: dst }),
    ).rejects.toMatchObject({ code: "copy_failed" });
  });

  test("an address signed with another secret cannot copy", async () => {
    await h.records.put(src, bytes("x"));
    await expect(
      copyObject(
        client({ COMPUTE_R2_SECRET_ACCESS_KEY: "wrong" }),
        { bucket: "records", key: src },
        { bucket: "records", key: dst },
      ),
    ).rejects.toMatchObject({ code: "copy_failed" });
    expect(await h.keys(h.records)).toEqual([src]);
  });
});

describe("a key that could escape is refused before anything is signed", () => {
  const BAD = [
    "",
    "/abs",
    "a//b",
    "a/",
    "a/./b",
    "a/../b",
    "../a",
    "a/..",
    "a\\b",
    "a\u0000b",
    "a\nb",
    "a\u007fb",
    `${"x".repeat(1025)}`,
    // 4 bytes each: under the character limit and over S3's 1,024-byte one.
    "\u{1F9E0}".repeat(300),
  ];
  for (const key of BAD) {
    test(`${JSON.stringify(key.length > 40 ? `${key.slice(0, 20)}...(${key.length})` : key)}`, async () => {
      expect(objectKeyProblem(key)).not.toBeNull();
      await expect(presignPut(client(), "records", key, { expiresIn: 3600 })).rejects.toMatchObject(
        { code: "key_invalid" },
      );
      await expect(presignGet(client(), "records", key, { expiresIn: 3600 })).rejects.toMatchObject(
        { code: "key_invalid" },
      );
      await expect(
        copyObject(client(), { bucket: "records", key: "ok" }, { bucket: "records", key }),
      ).rejects.toMatchObject({ code: "key_invalid" });
      expect(h.standin.log).toHaveLength(0);
    });
  }

  test("an acceptable key has no problem", () => {
    for (const key of [
      "a",
      "a/b",
      "a..b",
      "100%",
      "records/job_x/identity.json",
      "x".repeat(1024),
    ]) {
      expect(objectKeyProblem(key)).toBeNull();
    }
  });
});

describe("the stand-in's listing and its failure modes", () => {
  test("a signed listing returns the keys under a prefix", async () => {
    await h.records.put(`records/${JOB}/a`, bytes("1"));
    await h.records.put(`records/${JOB}/b`, bytes("22"));
    await h.records.put(`logs/${JOB}/c`, bytes("333"));
    const s3 = client();
    const url = `${h.standin.url}/${HARNESS_BUCKETS.records}?list-type=2&prefix=${encodeURIComponent(`records/${JOB}/`)}`;
    const res = await s3.client.fetch(url);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect([...body.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1])).toEqual([
      `records/${JOB}/a`,
      `records/${JOB}/b`,
    ]);
    expect(h.standin.log.at(-1)?.op).toBe("ListObjectsV2");
  });

  test("an injected failure answers once, then the server is itself again", async () => {
    const key = `records/${JOB}/f`;
    h.standin.failWith({ op: "PutObject", keyIncludes: "/f", status: 500, code: "InternalError" });
    const put = await presignPut(client(), "records", key, { expiresIn: 3600 });
    expect((await fetch(put.url, { method: "PUT", body: bytes("x") })).status).toBe(500);
    expect((await fetch(put.url, { method: "PUT", body: bytes("x") })).status).toBe(200);
  });

  test("an unsigned request is refused, and so is an unknown bucket", async () => {
    await h.records.put(`records/${JOB}/a`, bytes("1"));
    expect(
      (await fetch(`${h.standin.url}/${HARNESS_BUCKETS.records}/records/${JOB}/a`)).status,
    ).toBe(403);
    const s3 = client();
    const res = await s3.client.fetch(`${h.standin.url}/no-such-bucket/x`);
    expect(res.status).toBe(404);
  });
});
