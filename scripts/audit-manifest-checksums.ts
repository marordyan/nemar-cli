#!/usr/bin/env bun
/**
 * Read-only audit of the public data plane (nemarOrg/nemar-cli#2118): every manifest entry whose
 * checksum is not a digest of the shape its algorithm names (sha256 is 64 lowercase hex digits,
 * md5 32, and the other git-annex backends their own length), per dataset and version.
 *
 * It only issues GET requests to the public data host (index at `/`, a dataset's versions at
 * `/<id>/`, each version's `manifest_url`). It writes nothing anywhere but standard output, and it
 * needs no credential.
 *
 * - Every fetched URL must have the same origin as `--base`; a `manifest_url` that points
 *   elsewhere is refused and reported, and a redirect is never followed.
 * - Every request has a timeout and a bounded retry with backoff on 429, 5xx and network errors.
 * - A manifest that answers 413 (too many files for `manifest.json`) is listed, not read.
 * - A failed fetch never aborts the run: it is listed as unreadable and the report is printed.
 *
 * Exit status: 0 when every manifest was read (or answered 413) and none has a finding; 1 when
 * there is a finding, an unreadable version or a refused URL (`--no-fail` always exits 0, for
 * report-only use); 2 for a usage error or an unreadable index.
 *
 * Usage:
 *   bun scripts/audit-manifest-checksums.ts [--base https://data.nemar.org] [--concurrency 6]
 *     [--only <dataset id>[,<id>...]] [--timeout-ms 30000] [--retries 3] [--json] [--no-fail]
 */

import { isWellFormedChecksum } from "../backend/src/services/manifest";

export interface ManifestRow {
  path?: unknown;
  checksum_algorithm?: unknown;
  checksum?: unknown;
}

export interface VersionFinding {
  dataset: string;
  version: string;
  entries: number;
  bad: number;
  /** Count by `<algorithm>:<length>` of the offending values, for example `sha256:65`. */
  shapes: Record<string, number>;
  examples: Array<{ path: string; algorithm: string; length: number }>;
}

/**
 * True when the value is a digest of the shape its algorithm names, by the one rule the data plane
 * itself applies (`isWellFormedChecksum`). An algorithm with no known length (`git`, ...) passes.
 */
export function checksumIsWellFormed(algorithm: unknown, value: unknown): boolean {
  if (typeof algorithm !== "string") return true;
  return typeof value === "string" && isWellFormedChecksum(algorithm, value);
}

/** Classify one manifest's rows. Never throws on a malformed row. */
export function auditEntries(
  dataset: string,
  version: string,
  rows: unknown[],
  maxExamples = 3,
): VersionFinding {
  const finding: VersionFinding = {
    dataset,
    version,
    entries: rows.length,
    bad: 0,
    shapes: {},
    examples: [],
  };
  for (const raw of rows) {
    const row = (raw && typeof raw === "object" ? raw : {}) as ManifestRow;
    if (checksumIsWellFormed(row.checksum_algorithm, row.checksum)) continue;
    const algorithm = String(row.checksum_algorithm);
    const length = typeof row.checksum === "string" ? row.checksum.length : -1;
    finding.bad++;
    const shape = `${algorithm}:${length}`;
    finding.shapes[shape] = (finding.shapes[shape] ?? 0) + 1;
    if (finding.examples.length < maxExamples) {
      finding.examples.push({ path: String(row.path), algorithm, length });
    }
  }
  return finding;
}

export interface AuditOptions {
  base: string;
  concurrency: number;
  only: Set<string> | null;
  timeoutMs: number;
  retries: number;
  /** First backoff in milliseconds; doubles per retry. */
  backoffMs: number;
}

export interface AuditReport {
  base: string;
  datasets: number;
  versionsListed: number;
  manifestsRead: number;
  findings: VersionFinding[];
  /** `<dataset>@<version>` whose manifest answered 413. */
  tooLarge: string[];
  /** Fetches that failed after their retries, with the reason. */
  unreadable: string[];
  /** URLs refused because their origin is not the base's. */
  refused: string[];
  /** Set when the index itself could not be read; nothing else was audited. */
  indexError: string | null;
}

export const DEFAULT_OPTIONS: AuditOptions = {
  base: "https://data.nemar.org",
  concurrency: 6,
  only: null,
  timeoutMs: 30_000,
  retries: 3,
  backoffMs: 500,
};

class RefusedOriginError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * GET one JSON document. Retries 429, 5xx and network errors with doubling backoff, up to
 * `retries` extra attempts; any other status is returned as it is. Throws `RefusedOriginError`
 * for a URL outside the base's origin and an `Error` once the attempts are used up.
 */
async function getJson(
  url: string,
  opts: AuditOptions,
): Promise<{ status: number; body: unknown }> {
  if (new URL(url).origin !== new URL(opts.base).origin) {
    throw new RefusedOriginError(`${url} is not on the origin of ${opts.base}`);
  }
  let lastError = "";
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    if (attempt > 0) await sleep(opts.backoffMs * 2 ** (attempt - 1));
    try {
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
      if (res.status === 429 || res.status >= 500) {
        await res.body?.cancel();
        lastError = `HTTP ${res.status}`;
        continue;
      }
      if (res.status !== 200) {
        await res.body?.cancel();
        return { status: res.status, body: null };
      }
      return { status: 200, body: await res.json() };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  throw new Error(`${lastError} after ${opts.retries + 1} attempts`);
}

/** Run `fn` over `items` with at most `limit` in flight. */
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
}

/** Audit every published manifest reachable from the base. Never throws for a fetch failure. */
export async function runAudit(options: Partial<AuditOptions> = {}): Promise<AuditReport> {
  const opts: AuditOptions = { ...DEFAULT_OPTIONS, ...options };
  const base = opts.base.replace(/\/+$/, "");
  opts.base = base;
  const report: AuditReport = {
    base,
    datasets: 0,
    versionsListed: 0,
    manifestsRead: 0,
    findings: [],
    tooLarge: [],
    unreadable: [],
    refused: [],
    indexError: null,
  };

  let ids: string[];
  try {
    const index = await getJson(`${base}/`, opts);
    if (index.status !== 200) throw new Error(`HTTP ${index.status}`);
    const list = (index.body as { datasets?: Array<{ id?: unknown }> } | null)?.datasets;
    if (!Array.isArray(list)) throw new Error("the index has no datasets list");
    ids = list
      .map((d) => d.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0)
      .filter((id) => !opts.only || opts.only.has(id));
  } catch (err) {
    report.indexError = err instanceof Error ? err.message : String(err);
    return report;
  }
  report.datasets = ids.length;

  const jobs: Array<{ dataset: string; version: string; url: string }> = [];
  await pool(ids, opts.concurrency, async (dataset) => {
    try {
      const res = await getJson(`${base}/${encodeURIComponent(dataset)}/`, opts);
      if (res.status !== 200) {
        report.unreadable.push(`${dataset} (version list HTTP ${res.status})`);
        return;
      }
      const versions = (res.body as { versions?: unknown } | null)?.versions;
      if (!Array.isArray(versions)) {
        report.unreadable.push(`${dataset} (version list has no versions array)`);
        return;
      }
      for (const v of versions as Array<{ version?: unknown; manifest_url?: unknown }>) {
        if (typeof v.version !== "string" || typeof v.manifest_url !== "string") continue;
        const url = new URL(v.manifest_url, `${base}/`).href;
        if (new URL(url).origin !== new URL(base).origin) {
          report.refused.push(`${dataset}@${v.version} (${url})`);
          continue;
        }
        jobs.push({ dataset, version: v.version, url });
      }
    } catch (err) {
      report.unreadable.push(`${dataset} (version list: ${(err as Error).message})`);
    }
  });
  report.versionsListed = jobs.length + report.refused.length;

  await pool(jobs, opts.concurrency, async (job) => {
    const label = `${job.dataset}@${job.version}`;
    try {
      const res = await getJson(job.url, opts);
      if (res.status === 413) {
        report.tooLarge.push(label);
      } else if (res.status !== 200 || !Array.isArray(res.body)) {
        report.unreadable.push(`${label} (HTTP ${res.status})`);
      } else {
        report.manifestsRead++;
        const finding = auditEntries(job.dataset, job.version, res.body);
        if (finding.bad > 0) report.findings.push(finding);
      }
    } catch (err) {
      report.unreadable.push(`${label} (${(err as Error).message})`);
    }
  });

  const key = (f: { dataset: string; version: string }) => `${f.dataset}@${f.version}`;
  report.findings.sort((a, b) => (key(a) < key(b) ? -1 : 1));
  report.tooLarge.sort();
  report.unreadable.sort();
  report.refused.sort();
  return report;
}

/** 0 clean, 1 findings or unreadable or refused, 2 unreadable index; `noFail` forces 0 except 2. */
export function exitCodeFor(report: AuditReport, noFail: boolean): number {
  if (report.indexError !== null) return 2;
  if (noFail) return 0;
  return report.findings.length > 0 || report.unreadable.length > 0 || report.refused.length > 0
    ? 1
    : 0;
}

export function formatReport(report: AuditReport): string {
  const lines: string[] = [];
  if (report.indexError !== null) {
    lines.push(`base ${report.base}: the index could not be read (${report.indexError})`);
    return lines.join("\n");
  }
  lines.push(
    `base ${report.base}: ${report.datasets} datasets, ${report.versionsListed} versions listed, ${report.manifestsRead} manifests read`,
  );
  lines.push("rule: sha256 = 64 lowercase hex, md5 = 32, other annex backends their own length");
  lines.push(`\nversions with a wrong-shaped checksum: ${report.findings.length}`);
  for (const f of report.findings) {
    const shapes = Object.entries(f.shapes)
      .map(([s, n]) => `${s} x${n}`)
      .join(", ");
    lines.push(`  ${f.dataset}@${f.version}: ${f.bad} of ${f.entries} entries (${shapes})`);
    for (const e of f.examples)
      lines.push(`    e.g. ${e.path} (${e.algorithm}, length ${e.length})`);
  }
  lines.push(
    `\nanswered 413, not read (${report.tooLarge.length}): ${report.tooLarge.join(", ") || "none"}`,
  );
  lines.push(`unreadable (${report.unreadable.length}): ${report.unreadable.join("; ") || "none"}`);
  lines.push(
    `refused, other origin (${report.refused.length}): ${report.refused.join("; ") || "none"}`,
  );
  return lines.join("\n");
}

function parseArgs(argv: string[]): {
  opts: Partial<AuditOptions>;
  json: boolean;
  noFail: boolean;
} {
  const opts: Partial<AuditOptions> = {};
  let json = false;
  let noFail = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base") opts.base = argv[++i] ?? "";
    else if (a === "--concurrency") opts.concurrency = Math.max(1, Number(argv[++i]) || 6);
    else if (a === "--timeout-ms") opts.timeoutMs = Math.max(1, Number(argv[++i]) || 30_000);
    else if (a === "--retries") opts.retries = Math.max(0, Number(argv[++i]) || 0);
    else if (a === "--only") opts.only = new Set((argv[++i] ?? "").split(",").filter(Boolean));
    else if (a === "--json") json = true;
    else if (a === "--no-fail") noFail = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return { opts, json, noFail };
}

async function main(): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    return 2;
  }
  const report = await runAudit(parsed.opts);
  console.log(parsed.json ? JSON.stringify(report, null, 2) : formatReport(report));
  return exitCodeFor(report, parsed.noFail);
}

if (import.meta.main) {
  process.exit(await main());
}
