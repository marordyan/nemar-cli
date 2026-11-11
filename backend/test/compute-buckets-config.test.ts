/**
 * The compute gateway's two private R2 buckets and how the Worker reaches them (epic #2005 phase
 * A3, #2008; ADR 0118 decision 7): the committed configuration, and the S3-API signer's fences.
 *
 * What is pinned: `backend/wrangler-sccn.toml` binds `COMPUTE_RECORDS` and `COMPUTE_RESULTS` in the
 * production table and in the dev table (each environment has its own two buckets, never shared),
 * and both `*_BUCKET_NAME` variables, which a binding hides and the S3 API needs, are set in both
 * variable tables to the same four names; the three Worker secrets are NAMED in the comment block
 * and never given a value, and no R2 account endpoint is written in this public file. The signer
 * (`computeS3`) is null when anything is missing, a production environment ignores
 * `S3_ENDPOINT_URL` (that seam is a test hook for a different purpose) but honours the global
 * `NEMAR_COMPUTE_S3_URL`, which a deployed Worker cannot set, and an expiry above seven days is
 * refused.
 *
 * The switches `COMPUTE_ENABLED` and `COMPUTE_PIPELINES_DISPATCH_ENABLED` are not pinned here: their
 * phase (A4, #2009) adds them and the test that pins them.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import {
  COMPUTE_PRESIGN_MAX_SECONDS,
  ComputeS3Error,
  computeS3,
  computeS3Endpoint,
  presignGet,
  presignPut,
} from "../src/services/compute-s3";
import type { Bindings } from "../src/types/bindings";

const TOML_PATH = join(import.meta.dir, "../wrangler-sccn.toml");
const TEXT = readFileSync(TOML_PATH, "utf-8");

type Table = Record<string, unknown>;
type Buckets = Array<{ binding: string; bucket_name: string }>;
const config = Bun.TOML.parse(TEXT) as {
  vars?: Table;
  r2_buckets?: Buckets;
  env?: { dev?: { vars?: Table; r2_buckets?: Buckets } };
};

const PROD = { records: "nemar-compute-records", results: "nemar-compute-results" };
const DEV = { records: "nemar-compute-records-dev", results: "nemar-compute-results-dev" };
const SECRETS = [
  "COMPUTE_R2_ACCESS_KEY_ID",
  "COMPUTE_R2_SECRET_ACCESS_KEY",
  "COMPUTE_R2_S3_ENDPOINT",
] as const;

describe("backend/wrangler-sccn.toml", () => {
  test("the production table binds both buckets, by their exact names", () => {
    const find = (binding: string) => config.r2_buckets?.find((b) => b.binding === binding);
    expect(find("COMPUTE_RECORDS")?.bucket_name).toBe(PROD.records);
    expect(find("COMPUTE_RESULTS")?.bucket_name).toBe(PROD.results);
  });

  test("the dev table binds both buckets, by their exact names", () => {
    const find = (binding: string) =>
      config.env?.dev?.r2_buckets?.find((b) => b.binding === binding);
    expect(find("COMPUTE_RECORDS")?.bucket_name).toBe(DEV.records);
    expect(find("COMPUTE_RESULTS")?.bucket_name).toBe(DEV.results);
  });

  test("each binding is declared once per table, and no environment shares a bucket", () => {
    for (const buckets of [config.r2_buckets, config.env?.dev?.r2_buckets]) {
      for (const binding of ["COMPUTE_RECORDS", "COMPUTE_RESULTS"]) {
        expect(buckets?.filter((b) => b.binding === binding)).toHaveLength(1);
      }
    }
    const names = [PROD.records, PROD.results, DEV.records, DEV.results];
    expect(new Set(names).size).toBe(4);
  });

  test("both bucket-name variables are set, to the same four names, in both variable tables", () => {
    expect(config.vars?.COMPUTE_RECORDS_BUCKET_NAME).toBe(PROD.records);
    expect(config.vars?.COMPUTE_RESULTS_BUCKET_NAME).toBe(PROD.results);
    expect(config.env?.dev?.vars?.COMPUTE_RECORDS_BUCKET_NAME).toBe(DEV.records);
    expect(config.env?.dev?.vars?.COMPUTE_RESULTS_BUCKET_NAME).toBe(DEV.results);
  });

  test("the variable names equal the bindings' buckets, so the S3 API and the binding name one bucket", () => {
    const prod = (binding: string) => config.r2_buckets?.find((b) => b.binding === binding);
    expect(config.vars?.COMPUTE_RECORDS_BUCKET_NAME).toBe(prod("COMPUTE_RECORDS")?.bucket_name);
    expect(config.vars?.COMPUTE_RESULTS_BUCKET_NAME).toBe(prod("COMPUTE_RESULTS")?.bucket_name);
  });

  test("the three secrets are named in the comment block and given no value anywhere", () => {
    for (const name of SECRETS) {
      expect(TEXT).toMatch(new RegExp(`^#\\s*-\\s*${name}\\b`, "m"));
      expect(TEXT).not.toMatch(new RegExp(`^\\s*${name}\\s*=`, "m"));
      expect(config.vars?.[name]).toBeUndefined();
      expect(config.env?.dev?.vars?.[name]).toBeUndefined();
    }
  });

  test("no R2 account endpoint is written in this public file", () => {
    expect(TEXT).not.toMatch(/r2\.cloudflarestorage\.com/i);
    expect(TEXT).not.toMatch(/cloudflarestorage/i);
  });
});

// ---------------------------------------------------------------------------------------------

type SignerEnv = Partial<Bindings>;

const COMPLETE: SignerEnv = {
  ENVIRONMENT: "production",
  COMPUTE_R2_ACCESS_KEY_ID: "AKTESTKEY",
  COMPUTE_R2_SECRET_ACCESS_KEY: "test-secret",
  COMPUTE_R2_S3_ENDPOINT: "https://account.example.invalid",
  COMPUTE_RECORDS_BUCKET_NAME: PROD.records,
  COMPUTE_RESULTS_BUCKET_NAME: PROD.results,
};

const global = globalThis as { NEMAR_COMPUTE_S3_URL?: string };
const originalOverride = global.NEMAR_COMPUTE_S3_URL;

afterEach(() => {
  global.NEMAR_COMPUTE_S3_URL = originalOverride;
});

describe("computeS3", () => {
  test("is a client with an endpoint and both bucket names when everything is set", () => {
    const s3 = computeS3(COMPLETE);
    expect(s3).not.toBeNull();
    expect(s3?.endpoint).toBe("https://account.example.invalid");
    expect(s3?.records).toBe(PROD.records);
    expect(s3?.results).toBe(PROD.results);
  });

  for (const missing of [
    "COMPUTE_R2_ACCESS_KEY_ID",
    "COMPUTE_R2_SECRET_ACCESS_KEY",
    "COMPUTE_R2_S3_ENDPOINT",
    "COMPUTE_RECORDS_BUCKET_NAME",
    "COMPUTE_RESULTS_BUCKET_NAME",
  ] as const) {
    test(`is null when ${missing} is missing, and when it is blank`, () => {
      expect(computeS3({ ...COMPLETE, [missing]: undefined })).toBeNull();
      expect(computeS3({ ...COMPLETE, [missing]: "" })).toBeNull();
      expect(computeS3({ ...COMPLETE, [missing]: "   " })).toBeNull();
    });
  }

  test("a trailing slash on the endpoint is dropped", () => {
    expect(
      computeS3({ ...COMPLETE, COMPUTE_R2_S3_ENDPOINT: "https://a.example.invalid//" })?.endpoint,
    ).toBe("https://a.example.invalid");
  });
});

describe("the endpoint", () => {
  test("is the secret, with no override set", () => {
    global.NEMAR_COMPUTE_S3_URL = undefined;
    expect(computeS3Endpoint(COMPLETE)).toBe("https://account.example.invalid");
  });

  test("a production environment IGNORES S3_ENDPOINT_URL: that seam is for other reads", () => {
    global.NEMAR_COMPUTE_S3_URL = undefined;
    const env = {
      ...COMPLETE,
      ENVIRONMENT: "production" as const,
      S3_ENDPOINT_URL: "http://127.0.0.1:9",
    };
    expect(computeS3Endpoint(env)).toBe("https://account.example.invalid");
    expect(computeS3(env)?.endpoint).toBe("https://account.example.invalid");
    // ... and so does every other environment: the compute signer never reads it.
    expect(computeS3({ ...env, ENVIRONMENT: "development" })?.endpoint).toBe(
      "https://account.example.invalid",
    );
  });

  test("a production environment HONOURS the global, which a deployed Worker cannot set", () => {
    global.NEMAR_COMPUTE_S3_URL = "http://127.0.0.1:4321";
    expect(computeS3Endpoint({ ...COMPLETE, ENVIRONMENT: "production" })).toBe(
      "http://127.0.0.1:4321",
    );
    expect(computeS3({ ...COMPLETE, ENVIRONMENT: "production" })?.endpoint).toBe(
      "http://127.0.0.1:4321",
    );
  });

  test("the global alone is not enough: the credentials and the bucket names are still needed", () => {
    global.NEMAR_COMPUTE_S3_URL = "http://127.0.0.1:4321";
    expect(computeS3({ ...COMPLETE, COMPUTE_R2_S3_ENDPOINT: undefined })?.endpoint).toBe(
      "http://127.0.0.1:4321",
    );
    expect(computeS3({ ...COMPLETE, COMPUTE_R2_ACCESS_KEY_ID: undefined })).toBeNull();
    expect(computeS3({ ...COMPLETE, COMPUTE_RECORDS_BUCKET_NAME: undefined })).toBeNull();
  });
});

describe("an expiry", () => {
  const s3 = () => {
    const client = computeS3(COMPLETE);
    if (!client) throw new Error("no client");
    return client;
  };

  test("above seven days is refused, for a PUT and for a GET, and seven days is not", async () => {
    expect(COMPUTE_PRESIGN_MAX_SECONDS).toBe(7 * 24 * 3600);
    await expect(
      presignPut(s3(), "records", "records/x", { expiresIn: COMPUTE_PRESIGN_MAX_SECONDS + 1 }),
    ).rejects.toBeInstanceOf(ComputeS3Error);
    await expect(
      presignGet(s3(), "records", "records/x", { expiresIn: COMPUTE_PRESIGN_MAX_SECONDS + 1 }),
    ).rejects.toMatchObject({ code: "expiry_invalid" });
    const put = await presignPut(s3(), "records", "records/x", {
      expiresIn: COMPUTE_PRESIGN_MAX_SECONDS,
    });
    expect(new URL(put.url).searchParams.get("X-Amz-Expires")).toBe("604800");
    const get = await presignGet(s3(), "results", "jobs/x", {
      expiresIn: COMPUTE_PRESIGN_MAX_SECONDS,
    });
    expect(new URL(get.url).searchParams.get("X-Amz-Expires")).toBe("604800");
  });

  test("that is not a whole number of seconds of at least one is refused", async () => {
    for (const expiresIn of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "3600" as never]) {
      await expect(presignPut(s3(), "records", "records/x", { expiresIn })).rejects.toMatchObject({
        code: "expiry_invalid",
      });
    }
  });

  test("a signed address names the endpoint, the bucket and the key, path style", async () => {
    const put = await presignPut(s3(), "records", "records/job_0/spec.json", { expiresIn: 3600 });
    const url = new URL(put.url);
    expect(url.origin).toBe("https://account.example.invalid");
    expect(url.pathname).toBe(`/${PROD.records}/records/job_0/spec.json`);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("3600");
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Credential")).toMatch(
      /^AKTESTKEY\/\d{8}\/auto\/s3\/aws4_request$/,
    );
    expect(put.expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe("the test override of the compute endpoint", () => {
  // A deployed Worker must never set the global that redirects compute's signed requests: it is read
  // (services/compute-s3.ts) and set only by a test. Like the S3_ENDPOINT_URL fence, what a stray
  // assignment in the product would do is send every presigned address somewhere else.
  const ROOT = join(import.meta.dir, "../..");
  const ASSIGNMENT = /NEMAR_COMPUTE_S3_URL["'\]]*\s*(?:=(?!=)|:)/;

  test("the scan sees each way of setting it, and not a read or a type", () => {
    for (const text of [
      'globalThis.NEMAR_COMPUTE_S3_URL = "http://x"',
      "(globalThis as { NEMAR_COMPUTE_S3_URL?: string }).NEMAR_COMPUTE_S3_URL = url",
      'globalThis["NEMAR_COMPUTE_S3_URL"] = url',
      "NEMAR_COMPUTE_S3_URL=url",
      "Object.assign(globalThis, { NEMAR_COMPUTE_S3_URL: url })",
      "Object.defineProperty(globalThis, 'NEMAR_COMPUTE_S3_URL', { value: 1 }); const o = { 'NEMAR_COMPUTE_S3_URL': 1 }",
    ]) {
      expect([text, ASSIGNMENT.test(text)]).toEqual([text, true]);
    }
    for (const text of [
      "const o = (globalThis as { NEMAR_COMPUTE_S3_URL?: string }).NEMAR_COMPUTE_S3_URL;",
      "if (globalThis.NEMAR_COMPUTE_S3_URL === undefined) {}",
      "if (globalThis.NEMAR_COMPUTE_S3_URL == null) {}",
    ]) {
      expect([text, ASSIGNMENT.test(text)]).toEqual([text, false]);
    }
  });

  test("no file the product ships sets it", () => {
    const offences: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === ".wrangler") continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) {
          readFileSync(full, "utf8")
            .split("\n")
            .forEach((line, i) => {
              if (ASSIGNMENT.test(line)) offences.push(`${relative(ROOT, full)}:${i + 1}`);
            });
        }
      }
    };
    let walked = 0;
    for (const dir of ["backend/src", "src", "shared", "scripts"]) {
      if (existsSync(join(ROOT, dir))) {
        walk(join(ROOT, dir));
        walked++;
      }
    }
    expect(walked).toBeGreaterThanOrEqual(3);
    // ... and the file that reads it is among those walked, so the scan is not vacuous.
    expect(readFileSync(join(ROOT, "backend/src/services/compute-s3.ts"), "utf8")).toContain(
      "NEMAR_COMPUTE_S3_URL",
    );
    expect(offences).toEqual([]);
  });
});
