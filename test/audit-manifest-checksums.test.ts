/**
 * The classification behind scripts/audit-manifest-checksums.ts (nemarOrg/nemar-cli#2118), run on
 * the checksum values that were actually served for on003104 at v1.0.0.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type AuditReport,
  auditEntries,
  checksumIsWellFormed,
  exitCodeFor,
  formatReport,
  runAudit,
} from "../scripts/audit-manifest-checksums";

const COR = "de2f256064a0af797747c2b97505dc0b9f3df0de4f489eac731c23ae9ca9cc31";
const BRAIN = "a61f15d4bcaf7ceafd6f07da5192495bfdeec4492a415e8d46577405caeb7897";
const MD5 = "9e107d9d372bb6826bd81d3542a419d6";

describe("checksumIsWellFormed", () => {
  test("the two served shapes from on003104 are refused", () => {
    expect(checksumIsWellFormed("sha256", `${COR}C`)).toBe(false);
    expect(checksumIsWellFormed("sha256", `${BRAIN}01`)).toBe(false);
  });

  test("real digests, git object ids and other algorithms pass", () => {
    expect(checksumIsWellFormed("sha256", COR)).toBe(true);
    expect(checksumIsWellFormed("md5", MD5)).toBe(true);
    expect(checksumIsWellFormed("git", "66fda97533307ffdbd0d7995ab97297aa16b54d4")).toBe(true);
    expect(checksumIsWellFormed("future256", "zz")).toBe(true);
  });

  test("uppercase, short, empty and non-string values are refused", () => {
    expect(checksumIsWellFormed("sha256", COR.toUpperCase())).toBe(false);
    expect(checksumIsWellFormed("md5", MD5.slice(1))).toBe(false);
    expect(checksumIsWellFormed("sha256", "")).toBe(false);
    expect(checksumIsWellFormed("sha256", undefined)).toBe(false);
  });
});

describe("auditEntries", () => {
  const rows = [
    { path: "a/COR-001", checksum_algorithm: "sha256", checksum: `${COR}C` },
    { path: "a/COR-002", checksum_algorithm: "sha256", checksum: `${COR}C` },
    { path: "a/01_brain_surface", checksum_algorithm: "sha256", checksum: `${BRAIN}01` },
    { path: "a/ok.edf", checksum_algorithm: "sha256", checksum: COR },
    { path: "a/ok.bdf", checksum_algorithm: "md5", checksum: MD5 },
    { path: "a/bad.bdf", checksum_algorithm: "md5", checksum: `${MD5}0` },
    {
      path: "README",
      checksum_algorithm: "git",
      checksum: "66fda97533307ffdbd0d7995ab97297aa16b54d4",
    },
  ];

  test("counts offenders by algorithm and length, and keeps a few examples", () => {
    const f = auditEntries("on003104", "v1.0.0", rows, 2);
    expect(f.entries).toBe(7);
    expect(f.bad).toBe(4);
    expect(f.shapes).toEqual({ "sha256:65": 2, "sha256:66": 1, "md5:33": 1 });
    expect(f.examples).toEqual([
      { path: "a/COR-001", algorithm: "sha256", length: 65 },
      { path: "a/COR-002", algorithm: "sha256", length: 65 },
    ]);
  });

  test("a clean manifest reports nothing", () => {
    expect(auditEntries("nm000104", "v2.0.0", rows.slice(3, 5)).bad).toBe(0);
  });

  test("a row that is not an object, so names no algorithm, is not judged and does not throw", () => {
    expect(auditEntries("x", "v1", [null, 3, "s"]).bad).toBe(0);
  });
});

// --- the whole run, against a local stand-in for the public data host ---------------------------

const entry = (path: string, checksum: string, algorithm = "sha256") => ({
  path,
  size: 1,
  checksum_algorithm: algorithm,
  checksum,
  bytes_url: "x",
  url: "x",
});

describe("runAudit against a local data host", () => {
  let host: ReturnType<typeof Bun.serve>;
  let other: ReturnType<typeof Bun.serve>;
  const otherHits: string[] = [];
  const hits = new Map<string, number>();
  const base = () => `http://127.0.0.1:${host.port}`;

  const manifests: Record<string, unknown> = {
    "/clean/v1.0.0/manifest.json": [entry("a.edf", COR), entry("README", "abc", "git")],
    "/bad/v1.0.0/manifest.json": [entry("COR-001", `${COR}C`), entry("ok.edf", COR)],
    "/bad/v2.0.0/manifest.json": [entry("ok.edf", COR)],
  };

  beforeAll(() => {
    other = Bun.serve({
      port: 0,
      fetch(req) {
        otherHits.push(new URL(req.url).pathname);
        return Response.json([]);
      },
    });
    host = Bun.serve({
      port: 0,
      fetch(req) {
        const { pathname } = new URL(req.url);
        hits.set(pathname, (hits.get(pathname) ?? 0) + 1);
        const v = (id: string, version: string, manifest_url?: string) => ({
          version,
          manifest_url: manifest_url ?? `/${id}/${version}/manifest.json`,
        });
        if (pathname === "/") {
          return Response.json({
            datasets: [
              "clean",
              "bad",
              "huge",
              "foreign",
              "flaky",
              "down",
              "garbled",
              "redirect",
            ].map((id) => ({ id })),
          });
        }
        if (pathname === "/clean/") return Response.json({ versions: [v("clean", "v1.0.0")] });
        if (pathname === "/bad/")
          return Response.json({ versions: [v("bad", "v1.0.0"), v("bad", "v2.0.0")] });
        if (pathname === "/huge/") return Response.json({ versions: [v("huge", "v1.0.0")] });
        if (pathname === "/foreign/")
          return Response.json({
            versions: [v("foreign", "v1.0.0", `http://127.0.0.1:${other.port}/x/manifest.json`)],
          });
        if (pathname === "/flaky/") return Response.json({ versions: [v("flaky", "v1.0.0")] });
        if (pathname === "/down/") return new Response("no", { status: 503 });
        if (pathname === "/garbled/") return new Response("{not json", { status: 200 });
        if (pathname === "/redirect/")
          return Response.json({ versions: [v("redirect", "v1.0.0")] });
        if (pathname === "/redirect/v1.0.0/manifest.json")
          return new Response(null, {
            status: 302,
            headers: { Location: `http://127.0.0.1:${other.port}/stolen.json` },
          });
        if (pathname === "/huge/v1.0.0/manifest.json")
          return new Response("too big", { status: 413 });
        if (pathname === "/flaky/v1.0.0/manifest.json") {
          // 503 on the first request, 429 on the second, the manifest on the third.
          const n = hits.get(pathname) ?? 0;
          if (n === 1) return new Response("x", { status: 503 });
          if (n === 2) return new Response("x", { status: 429 });
          return Response.json([entry("f.edf", COR)]);
        }
        if (pathname in manifests) return Response.json(manifests[pathname]);
        return new Response("not found", { status: 404 });
      },
    });
  });

  afterAll(() => {
    host.stop(true);
    other.stop(true);
  });

  const run = (extra: Parameters<typeof runAudit>[0] = {}) =>
    runAudit({ base: base(), retries: 2, backoffMs: 1, timeoutMs: 5_000, ...extra });

  let report: AuditReport;

  test("reads every manifest, reports the wrong digest and lists what it could not read", async () => {
    report = await run();
    expect(report.indexError).toBeNull();
    expect(report.datasets).toBe(8);
    expect(report.findings.map((f) => `${f.dataset}@${f.version}`)).toEqual(["bad@v1.0.0"]);
    expect(report.findings[0].shapes).toEqual({ "sha256:65": 1 });
    expect(report.findings[0].examples).toEqual([
      { path: "COR-001", algorithm: "sha256", length: 65 },
    ]);
    // clean, bad x2 and flaky (after its retries) were read.
    expect(report.manifestsRead).toBe(4);
    expect(report.tooLarge).toEqual(["huge@v1.0.0"]);
  });

  test("a 503 then a 429 is retried and the third answer is used", () => {
    expect(hits.get("/flaky/v1.0.0/manifest.json")).toBe(3);
    expect(report.unreadable.some((u) => u.startsWith("flaky@"))).toBe(false);
  });

  test("a failing or garbled version list, and a redirect, are listed as unreadable, not fatal", () => {
    expect(
      report.unreadable.some((u) => u.startsWith("down (version list: HTTP 503 after 3")),
    ).toBe(true);
    expect(report.unreadable.some((u) => u.startsWith("garbled (version list:"))).toBe(true);
    expect(report.unreadable).toContain("redirect@v1.0.0 (HTTP 302)");
    // 503 is retried: initial attempt plus two retries.
    expect(hits.get("/down/")).toBe(3);
  });

  test("a manifest_url on another origin is refused, reported and never requested", () => {
    expect(report.refused.length).toBe(1);
    expect(report.refused[0]).toContain("foreign@v1.0.0");
    expect(otherHits).toEqual([]);
  });

  test("the exit status is 1 on findings, unreadable or refused; --no-fail gives 0", () => {
    expect(exitCodeFor(report, false)).toBe(1);
    expect(exitCodeFor(report, true)).toBe(0);
    const clean: AuditReport = {
      ...report,
      findings: [],
      unreadable: [],
      refused: [],
    };
    expect(exitCodeFor(clean, false)).toBe(0);
    expect(exitCodeFor({ ...clean, tooLarge: ["x@v1"] }, false)).toBe(0);
    expect(exitCodeFor({ ...clean, unreadable: ["x"] }, false)).toBe(1);
  });

  test("the printed report carries the counts and no entry dump", () => {
    const text = formatReport(report);
    expect(text).toContain("bad@v1.0.0: 1 of 2 entries (sha256:65 x1)");
    expect(text).toContain("answered 413, not read (1): huge@v1.0.0");
    expect(text).not.toContain(COR);
  });

  test("an unreadable index yields a report and exit status 2, not a throw", async () => {
    const dead = await runAudit({
      base: "http://127.0.0.1:9",
      retries: 1,
      backoffMs: 1,
      timeoutMs: 500,
    });
    expect(dead.indexError).toContain("after 2 attempts");
    expect(exitCodeFor(dead, false)).toBe(2);
    expect(exitCodeFor(dead, true)).toBe(2);
    expect(formatReport(dead)).toContain("the index could not be read");
  });

  test("--only narrows the run", async () => {
    const r = await run({ only: new Set(["clean"]) });
    expect(r.datasets).toBe(1);
    expect(r.manifestsRead).toBe(1);
    expect(exitCodeFor(r, false)).toBe(0);
  });
});
