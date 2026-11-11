/**
 * nemarOrg/nemar-cli#2118: 260 `sha256` entries in the published manifest of
 * on003104 at v1.0.0 carried the annex key's file name after the digest
 * (`...cc31C`, `...789701`).
 *
 * The keys below are the real ones read from nemarDatasets/on003104 at v1.0.0.
 * They were written upstream (OpenNeuro tooling), not by git-annex, with the tail
 * of a dotless file name straight after the digest (git-annex itself writes the
 * bare digest for those files and refuses the tail form on verification), so the
 * greedy hex match in `extractChecksumFromKey` took the leading hex digits of
 * `COR-001` (`C`) and `01_brain_surface` (`01`) as part of the digest.
 *
 * Two layers are covered: the key parser, and the real `dataRoutes` app serving
 * `manifest.json` from a stored manifest that already holds the wrong values
 * (every manifest published before the fix does), over a real D1 and a real
 * local HTTP server standing in for S3.
 */

import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { dataRoutes } from "../src/routes/data";
import {
  ANNEX_DIGEST_HEX_LENGTH,
  extractChecksumFromKey,
  extractHashAlgorithm,
  identifyAnnexBackend,
  isWellFormedChecksum,
  repairStoredChecksum,
} from "../src/services/manifest";
import { manifestJsonCacheKey } from "../src/services/manifest-json-cache";
import { resetManifestAnswerMemo } from "../src/services/manifest-source";
import type { Bindings, Variables } from "../src/types/bindings";
import { DrainingCache } from "./helpers/cache";
import { freshDb, realD1 } from "./helpers/d1";
import { type S3ManifestStandin, startS3ManifestStandin } from "./helpers/s3-manifest-standin";

const COR = "de2f256064a0af797747c2b97505dc0b9f3df0de4f489eac731c23ae9ca9cc31";
const BRAIN = "a61f15d4bcaf7ceafd6f07da5192495bfdeec4492a415e8d46577405caeb7897";
const MD5 = "9e107d9d372bb6826bd81d3542a419d6";

describe("extractChecksumFromKey on real annex key shapes", () => {
  test("a dotless name starting with a hex digit does not leak into the digest", () => {
    expect(extractChecksumFromKey(`SHA256E-s65536--${COR}COR-001`)).toBe(COR);
    expect(extractChecksumFromKey(`SHA256E-s369273--${BRAIN}01_brain_surface`)).toBe(BRAIN);
  });

  test("an extension made only of hex characters is not part of the digest", () => {
    // `.abc` and a whole hex name (`deadbeef`): both look like the end of a digest.
    expect(extractChecksumFromKey(`SHA256E-s9--${COR}.abc`)).toBe(COR);
    expect(extractChecksumFromKey(`SHA256E-s9--${COR}deadbeef`)).toBe(COR);
    expect(extractChecksumFromKey(`SHA256E-s9--${COR}0123456789`)).toBe(COR);
  });

  test("MD5E keys are cut at 32 characters", () => {
    expect(extractChecksumFromKey(`MD5E-s10--${MD5}face`)).toBe(MD5);
    expect(extractChecksumFromKey(`MD5E-s10--${MD5}.bdf`)).toBe(MD5);
  });

  test("keys that were right stay byte for byte the same", () => {
    for (const tail of ["", ".edf", ".nii.gz", ".tar.gz", ".C", ".01", "README", ".m3z"]) {
      expect(extractChecksumFromKey(`SHA256E-s1--${COR}${tail}`)).toBe(COR);
    }
    // Non-E backend: the digest is the whole tail.
    expect(extractChecksumFromKey(`SHA256-s65536--${COR}`)).toBe(COR);
    expect(extractChecksumFromKey(`MD5-s10--${MD5}`)).toBe(MD5);
    // Chunked key: the size/chunk fields use single dashes, so `--` is still the digest delimiter.
    expect(extractChecksumFromKey(`SHA256E-s100-S10-C3--${COR}.edf`)).toBe(COR);
  });

  test("a digest shorter than its backend's length is returned as found, for the checker to flag", () => {
    expect(extractChecksumFromKey("SHA256E-s12345--abc123def456.edf")).toBe("abc123def456");
    expect(isWellFormedChecksum("sha256", "abc123def456")).toBe(false);
  });

  test("a backend this parser does not know keeps the old greedy match, unchanged", () => {
    const hex = "a".repeat(70);
    expect(extractChecksumFromKey(`FUTURE256E-s1--${hex}.edf`)).toBe(hex);
    expect(identifyAnnexBackend(`FUTURE256E-s1--${hex}.edf`)).toBeNull();
    expect(extractHashAlgorithm(`FUTURE256E-s1--${hex}.edf`)).toBe("future256");
  });

  test("SHA1 and SHA512 are cut at 40 and 128", () => {
    const sha1 = "11f6ad8ec52a2984abaafd7c3b516503785c2072";
    const sha512 =
      "a4abd4448c49562d828115d13a1fccea927f52b4d5459297f8b43e42da89238bc13626e43dcb38ddb082488927ec904fb42057443983e88585179d50551afe62";
    expect(extractChecksumFromKey(`SHA1E-s1--${sha1}face`)).toBe(sha1);
    expect(extractChecksumFromKey(`SHA512E-s1--${sha512}0123`)).toBe(sha512);
    expect(extractChecksumFromKey(`SHA512-s1--${sha512}`)).toBe(sha512);
  });

  test("SHA3 backends keep their whole digest and are cut at their own length, not at 64", () => {
    // Real `git annex calckey` output. Before the backend name allowed `_`, SHA3_512E read as
    // sha256 and its 128-character digest was cut to 64 characters: a valid-looking wrong value.
    const sha3_512 =
      "0fdb27960308c51467edd49a0f5e0c434c9cca721f4c35bff005feabaf6010e777a1137ee8187c5288af57578d18d502a0bbe4c022f5587541961e10132d9834";
    const sha3_384 =
      "5abfc7bc2a09a612f87987ce070634a0932d31891a61a0ec598e81e6ec616c9f00f05ff627070cbf6cb0499b1c334d4d";
    expect(extractHashAlgorithm(`SHA3_512E-s1--${sha3_512}.edf`)).toBe("sha3_512");
    expect(extractChecksumFromKey(`SHA3_512E-s1--${sha3_512}.edf`)).toBe(sha3_512);
    expect(extractChecksumFromKey(`SHA3_512E-s1--${sha3_512}face`)).toBe(sha3_512);
    expect(extractChecksumFromKey(`SHA3_384E-s1--${sha3_384}01_name`)).toBe(sha3_384);
    expect(isWellFormedChecksum("sha3_512", sha3_512)).toBe(true);
  });

  test("a size-less MD5E key is identified as md5", () => {
    expect(identifyAnnexBackend(`MD5E--${MD5}.edf`)?.name).toBe("md5");
    expect(extractHashAlgorithm(`MD5E--${MD5}.edf`)).toBe("md5");
    expect(extractChecksumFromKey(`MD5E--${MD5}face`)).toBe(MD5);
  });

  test("URL and WORM keys identify no backend and are read exactly as before", () => {
    const url = "URL--https&c%%example.org%data%file.edf";
    const worm = "WORM-s1-m1794343621--g_WORM";
    for (const key of [url, worm, "git:abcdef", "not a key", ""]) {
      expect(identifyAnnexBackend(key)).toBeNull();
    }
    // Historic answers, kept: no label but "sha256", and the greedy hex match (none here).
    expect(extractHashAlgorithm(url)).toBe("sha256");
    expect(extractChecksumFromKey(url)).toBe("");
    expect(extractHashAlgorithm(worm)).toBe("worm");
    expect(extractChecksumFromKey(worm)).toBe("");
    // A hex-looking run in a URL key is not cut either.
    expect(extractChecksumFromKey(`URL--${"b".repeat(90)}`)).toBe("b".repeat(90));
  });

  test("the digest length table matches git-annex itself, for every backend, E or not", () => {
    // Real git-annex, when installed. On a machine without it the key shapes above are the
    // evidence; the table was produced from this very loop.
    const probe = spawnSync("git", ["annex", "version", "--raw"], { encoding: "utf8" });
    if (probe.status !== 0) return;
    const dir = mkdtempSync(join(tmpdir(), "annex-lengths-"));
    try {
      spawnSync("git", ["init", "-q", dir]);
      spawnSync("git", ["-C", dir, "annex", "init", "-q"]);
      writeFileSync(join(dir, "f.edf"), "x");
      for (const name of Object.keys(ANNEX_DIGEST_HEX_LENGTH)) {
        for (const suffix of ["", "E"]) {
          const backend = `${name.toUpperCase()}${suffix}`;
          const r = spawnSync(
            "git",
            ["-C", dir, "annex", "calckey", "--backend", backend, "f.edf"],
            {
              encoding: "utf8",
            },
          );
          expect(r.status).toBe(0);
          const key = r.stdout.trim();
          expect(identifyAnnexBackend(key)?.backend).toBe(backend);
          const digest = key.match(/--([0-9a-f]+)/)?.[1] ?? "";
          expect(digest.length).toBe(ANNEX_DIGEST_HEX_LENGTH[name]);
          expect(extractChecksumFromKey(`${key}face`)).toBe(digest);
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a backend named like an Object.prototype property is unknown, not a table hit", () => {
    // `constructor` and `__proto__` used to be found on the prototype of the lookup table:
    // `identifyAnnexBackend` returned a function as the length and generateManifest threw.
    expect(identifyAnnexBackend("CONSTRUCTOR-s1--abc.edf")).toBeNull();
    expect(extractHashAlgorithm("CONSTRUCTOR-s1--abc.edf")).toBe("constructor");
    expect(extractChecksumFromKey("CONSTRUCTOR-s1--abc.edf")).toBe("abc");
    expect(identifyAnnexBackend("__PROTO__-s1--abc.edf")).toBeNull();
    expect(extractHashAlgorithm("__PROTO__-s1--abc.edf")).toBe("sha256");
    expect(extractChecksumFromKey("__PROTO__-s1--abc.edf")).toBe("abc");
    expect(isWellFormedChecksum("constructor", "abc")).toBe(true);
    expect(isWellFormedChecksum("__proto__", "abc")).toBe(true);
    expect(isWellFormedChecksum("toString", "abc")).toBe(true);
  });

  test("no digest at all", () => {
    expect(extractChecksumFromKey("git:abcd")).toBe("");
    expect(extractChecksumFromKey("")).toBe("");
  });
});

/**
 * `fixtures/annex-key-vectors.json` is shared byte for byte with the central manifest generator's own
 * test (`emit_manifest.py` in the dataset organization's `.github` repository), which has the same
 * parse. A live parity pin against the central copy is a follow-up that can land only after the
 * central change merges; until then the two copies are kept identical by hand.
 */
describe("the shared annex key vectors", () => {
  const vectors = (
    JSON.parse(readFileSync(join(import.meta.dir, "fixtures/annex-key-vectors.json"), "utf8")) as {
      vectors: Array<{ key: string; algorithm: string; digest: string; why: string }>;
    }
  ).vectors;

  test("the file holds the 26 vectors", () => {
    expect(vectors.length).toBe(26);
  });

  for (const v of vectors) {
    test(`${v.why}: ${v.key.slice(0, 40)}`, () => {
      expect(extractHashAlgorithm(v.key)).toBe(v.algorithm);
      expect(extractChecksumFromKey(v.key)).toBe(v.digest);
    });
  }
});

describe("isWellFormedChecksum", () => {
  test("sha256 is 64 lowercase hex, md5 is 32", () => {
    expect(isWellFormedChecksum("sha256", COR)).toBe(true);
    expect(isWellFormedChecksum("sha256", `${COR}C`)).toBe(false);
    expect(isWellFormedChecksum("sha256", `${COR}01`)).toBe(false);
    expect(isWellFormedChecksum("sha256", COR.toUpperCase())).toBe(false);
    expect(isWellFormedChecksum("sha256", COR.slice(1))).toBe(false);
    expect(isWellFormedChecksum("sha256", "")).toBe(false);
    expect(isWellFormedChecksum("md5", MD5)).toBe(true);
    expect(isWellFormedChecksum("md5", `${MD5}f`)).toBe(false);
  });

  test("git and unknown algorithms are not judged", () => {
    expect(isWellFormedChecksum("git", "66fda97533307ffdbd0d7995ab97297aa16b54d4")).toBe(true);
    expect(isWellFormedChecksum("unknown", "x")).toBe(true);
  });
});

describe("repairStoredChecksum", () => {
  test("a well-formed value is returned untouched, whatever the key says", () => {
    expect(repairStoredChecksum("sha256", COR, "SHA256E-s1--other.edf")).toEqual({
      value: COR,
      status: "ok",
    });
  });

  test("a stored value with the extension attached is re-derived from the key", () => {
    expect(repairStoredChecksum("sha256", `${COR}C`, `SHA256E-s65536--${COR}COR-001`)).toEqual({
      value: COR,
      status: "repaired",
    });
  });

  test("an uppercase stored value is re-derived in lowercase", () => {
    expect(repairStoredChecksum("sha256", COR.toUpperCase(), `SHA256E-s1--${COR}.edf`)).toEqual({
      value: COR,
      status: "repaired",
    });
  });

  test("a key that names no hash backend is not judged: its stored label is a historic guess", () => {
    expect(repairStoredChecksum("sha256", "", "URL--https&c%%example.org%x")).toEqual({
      value: "",
      status: "ok",
    });
    expect(repairStoredChecksum("sha256", "xyz", "WORM-s1-m2--name")).toEqual({
      value: "xyz",
      status: "ok",
    });
  });

  test("a value that cannot be repaired is reported, not invented", () => {
    // No key.
    expect(repairStoredChecksum("sha256", `${COR}C`, undefined).status).toBe("malformed");
    // The key is for another algorithm.
    expect(repairStoredChecksum("sha256", `${COR}C`, `MD5E-s1--${MD5}.edf`).status).toBe(
      "malformed",
    );
    // The key itself is short.
    expect(repairStoredChecksum("sha256", "abc123", "SHA256E-s1--abc123.edf")).toEqual({
      value: "abc123",
      status: "malformed",
    });
  });
});

// --- the served manifest.json, over the real route -------------------------------------------

const ID = "nm000904";
const VERSION_KEY = `/${ID}/version/v1.0.0.json`;
const BASE = "derivatives/freesurfer/subjects/01/bem/watershed";

const STORED = {
  dataset_id: ID,
  version: "1.0.0",
  doi: null,
  concept_doi: null,
  created: "2026-01-01T00:00:00.000Z",
  files: {
    [`${BASE}/01_brain_surface`]: {
      key: `SHA256E-s369273--${BRAIN}01_brain_surface`,
      size: 369273,
      checksum: `sha256:${BRAIN}01`,
    },
    [`${BASE}/ws/COR-001`]: {
      key: `SHA256E-s65536--${COR}COR-001`,
      size: 65536,
      checksum: `sha256:${COR}C`,
    },
    "sub-01/eeg/valid.edf": {
      key: `SHA256E-s10--${COR}.edf`,
      size: 10,
      checksum: `sha256:${COR}`,
    },
    "sub-01/eeg/valid_md5.bdf": {
      key: `MD5E-s10--${MD5}.bdf`,
      size: 10,
      checksum: `md5:${MD5}`,
    },
    "sub-01/eeg/broken.edf": {
      key: "SHA256E-s10--abc123.edf",
      size: 10,
      checksum: "sha256:abc123",
    },
    "sub-01/eeg/upper.edf": {
      key: `SHA256E-s10--${COR}.edf`,
      size: 10,
      checksum: `sha256:${COR.toUpperCase()}`,
    },
    // Valid for md5, not for the sha256 it says: served as stored and reported.
    "sub-01/eeg/half.edf": {
      key: `SHA256E-s10--${MD5}.edf`,
      size: 10,
      checksum: `sha256:${MD5}`,
    },
    // A key that names no hash backend is carried as written by older code and never reported.
    "sub-01/eeg/remote.dat": {
      key: "URL--https&c%%example.org%remote.dat",
      size: 10,
      checksum: "sha256:",
    },
    "participants.tsv": {
      key: "git:66fda97533307ffdbd0d7995ab97297aa16b54d4",
      size: 8,
      checksum: "git:66fda97533307ffdbd0d7995ab97297aa16b54d4",
    },
  },
};

let s3: S3ManifestStandin;
let db: Database;
const logged: string[] = [];
const realError = console.error;

beforeAll(() => {
  s3 = startS3ManifestStandin();
});

afterAll(() => {
  s3.stop();
});

beforeEach(() => {
  db = freshDb();
  db.prepare(
    `INSERT INTO datasets (dataset_id, name, owner_user_id, status, visibility, is_sandbox)
     VALUES (?, ?, 1, 'active', 'public', 0)`,
  ).run(ID, ID);
  db.prepare(
    `INSERT INTO dataset_versions (dataset_id, version, doi, provider, created_at)
     VALUES (?, '1.0.0', ?, 'ezid', '2026-01-01 00:00:00')`,
  ).run(ID, `10.5072/FK2${ID}`);
  s3.put(VERSION_KEY, JSON.stringify(STORED));
  s3.setBucketPolicy(null);
  resetManifestAnswerMemo();
  logged.length = 0;
  // Capture only; every message still reaches the real console.
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
    realError(...args);
  };
});

afterEach(() => {
  console.error = realError;
});

async function manifestJson(): Promise<Array<Record<string, string | number>>> {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.route("/", dataRoutes);
  const env = {
    DB: realD1(db),
    ENVIRONMENT: "test",
    DATA_BASE_URL: "https://data.nemar.org",
    S3_ENDPOINT_URL: s3.url,
    S3_BUCKET: "nemar",
    AWS_REGION: "us-east-2",
    AWS_ACCESS_KEY_ID: "AKIATEST",
    AWS_SECRET_ACCESS_KEY: "secret",
  } as Bindings;
  const res = await app.request(`https://data.nemar.org/${ID}/v1.0.0/manifest.json`, {}, env);
  expect(res.status).toBe(200);
  return (await res.json()) as Array<Record<string, string | number>>;
}

describe("manifest.json over a stored manifest written before the fix (#2118)", () => {
  test("entries stored with the key's extension attached are served with the real digest", async () => {
    const byPath = new Map((await manifestJson()).map((e) => [e.path, e]));
    expect(byPath.get(`${BASE}/ws/COR-001`)).toMatchObject({
      checksum_algorithm: "sha256",
      checksum: COR,
      size: 65536,
    });
    expect(byPath.get(`${BASE}/01_brain_surface`)).toMatchObject({
      checksum_algorithm: "sha256",
      checksum: BRAIN,
    });
  });

  test("an uppercase stored value is served in lowercase", async () => {
    const byPath = new Map((await manifestJson()).map((e) => [e.path, e]));
    expect(byPath.get("sub-01/eeg/upper.edf")?.checksum).toBe(COR);
  });

  test("valid sha256, md5 and git entries are served exactly as stored", async () => {
    const byPath = new Map((await manifestJson()).map((e) => [e.path, e]));
    expect(byPath.get("sub-01/eeg/valid.edf")).toMatchObject({
      checksum_algorithm: "sha256",
      checksum: COR,
    });
    expect(byPath.get("sub-01/eeg/valid_md5.bdf")).toMatchObject({
      checksum_algorithm: "md5",
      checksum: MD5,
    });
    expect(byPath.get("participants.tsv")).toMatchObject({
      checksum_algorithm: "git",
      checksum: "66fda97533307ffdbd0d7995ab97297aa16b54d4",
    });
  });

  test("no served sha256 or md5 value has the wrong length except the ones nothing can repair or judge", async () => {
    const wrong = (await manifestJson()).filter(
      (e) =>
        (e.checksum_algorithm === "sha256" && String(e.checksum).length !== 64) ||
        (e.checksum_algorithm === "md5" && String(e.checksum).length !== 32),
    );
    expect(wrong.map((e) => e.path).sort()).toEqual([
      "sub-01/eeg/broken.edf",
      "sub-01/eeg/half.edf",
      "sub-01/eeg/remote.dat",
    ]);
    // Served as stored, not invented.
    const half = wrong.find((e) => e.path === "sub-01/eeg/half.edf");
    expect(half?.checksum).toBe(MD5);
  });

  test("the repair and the unrepairable entry are reported, not silent", async () => {
    await manifestJson();
    const line = logged.find((l) => l.includes("[data] MANIFEST CHECKSUM"));
    expect(line).toBeDefined();
    expect(line).toContain(`dataset=${ID}`);
    expect(line).toContain("repaired=3");
    expect(line).toContain("malformed=2");
    expect(line).toContain("first_malformed=sub-01/eeg/broken.edf");
  });
});

describe("a manifest.json document cached under the old v2 key is not served (#2118)", () => {
  let cache: DrainingCache;
  let original: unknown;
  const KEY = (v: string) =>
    manifestJsonCacheKey("https://data.nemar.org", ID, "v1.0.0").replace("/v3/", `/${v}/`);

  beforeEach(() => {
    original = (globalThis as { caches?: unknown }).caches;
    cache = new DrainingCache();
    (globalThis as { caches?: unknown }).caches = { default: cache };
  });

  afterEach(() => {
    (globalThis as { caches?: unknown }).caches = original;
  });

  /** The document the old code built and cached for the source manifest's current ETag. */
  async function plantStale(version: "v2" | "v3"): Promise<string> {
    await manifestJson(); // builds and stores the v3 document, whose headers carry the live ETag
    const live = cache.store.get(KEY("v3"));
    if (!live) throw new Error("the v3 document was not stored");
    const stale = JSON.stringify([
      { path: "stale/COR-001", size: 1, checksum_algorithm: "sha256", checksum: `${COR}C` },
    ]);
    cache.store.delete(KEY("v3"));
    cache.store.set(KEY(version), {
      body: new TextEncoder().encode(stale),
      status: 200,
      headers: live.headers,
      storedAtMs: Date.now(),
    });
    resetManifestAnswerMemo();
    return stale;
  }

  test("a v2 document with the live ETag is ignored and the repaired one is built", async () => {
    await plantStale("v2");
    const served = await manifestJson();
    expect(served.map((e) => e.path)).not.toContain("stale/COR-001");
    expect(served.find((e) => e.path === `${BASE}/ws/COR-001`)?.checksum).toBe(COR);
    expect(cache.store.has(KEY("v3"))).toBe(true);
  });

  // Control: the same stale document under the v3 key IS served, so the test above fails
  // for the right reason (only the key version protects, the ETag matches).
  test("control: the same stale document under the v3 key would be served", async () => {
    await plantStale("v3");
    const served = await manifestJson();
    expect(served.map((e) => e.path)).toEqual(["stale/COR-001"]);
  });
});
