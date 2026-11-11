/**
 * Version Manifest Service
 *
 * Generates JSON manifests from git-annex state at a given tag.
 * Manifests map file paths to S3 annex keys for direct access
 * without requiring a git clone (used by web frontend).
 */

import { type TreeEntry, getBlobContent, getTreeAtRef } from "./github";
import { GITHUB_RAW_ORIGIN, rawContentUrl } from "./github/shared.js";

export interface ManifestFile {
  key: string;
  size: number;
  checksum: string;
}

export interface VersionManifest {
  dataset_id: string;
  version: string;
  doi: string | null;
  concept_doi: string | null;
  created: string;
  files: Record<string, ManifestFile>;
}

/**
 * Parse a git-annex pointer file content to extract the annex key.
 *
 * Annex pointer files have content like:
 *   /annex/objects/SHA256E-s12345--abc123def456.edf
 *
 * The key format is: BACKEND-sNNNN--HASH.ext
 * where BACKEND is SHA256E, MD5E, etc.
 */
export function parseAnnexPointer(content: string): string | null {
  const trimmed = content.trim();
  // Match git-annex pointer format
  const match = trimmed.match(/^\/annex\/objects\/(.+)$/);
  if (match) return match[1];

  // Also match the symlink target format used in locked mode
  // e.g., .git/annex/objects/XX/YY/SHA256E-s12345--abc123.edf/SHA256E-s12345--abc123.edf
  const symlinkMatch = trimmed.match(
    /\.git\/annex\/objects\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/([^/]+)\/\1$/,
  );
  if (symlinkMatch) return symlinkMatch[1];

  return null;
}

/**
 * Extract size from an annex key.
 * Key format: SHA256E-s12345--abc123.ext
 * The -sNNNN part indicates the file size in bytes.
 */
export function extractSizeFromKey(key: string): number {
  const match = key.match(/-s(\d+)--/);
  return match ? Number.parseInt(match[1], 10) : 0;
}

/**
 * Digest length in hex characters of every git-annex hash backend, keyed by the
 * lowercase backend name without its `E` (extension) suffix. Each length was read
 * from `git annex calckey` (git-annex 10.20261006) for every backend its
 * `git annex version` lists, `E` and non-`E` alike; the backends left out
 * (`WORM`, `URL`, `VURL`, `GITBUNDLE`, `GITMANIFEST`, `X*`) are not content digests.
 *
 * Why the length matters: some published datasets carry keys that were written
 * upstream (OpenNeuro tooling), not by git-annex, with the tail of a dotless file
 * name straight after the digest: `SHA256E-s65536--<64 hex>COR-001` for `COR-001`,
 * `SHA256E-s369273--<64 hex>01_brain_surface` for `01_brain_surface`
 * (nemarOrg/nemar-cli#2118). git-annex itself writes no such tail for those files
 * (`SHA256E-s65536--<64 hex>`) and refuses the tail form on verification, but the
 * manifest must still read the key as it is. A tail that starts with hex characters
 * (`C`, `01`) runs into the digest, and the length is the only thing that tells
 * them apart.
 */
export const ANNEX_DIGEST_HEX_LENGTH: Readonly<Record<string, number>> = {
  md5: 32,
  sha1: 40,
  sha224: 56,
  sha256: 64,
  sha384: 96,
  sha512: 128,
  sha3_224: 56,
  sha3_256: 64,
  sha3_384: 96,
  sha3_512: 128,
  skein256: 64,
  skein512: 128,
  blake2b160: 40,
  blake2b224: 56,
  blake2b256: 64,
  blake2b384: 96,
  blake2b512: 128,
  blake2bp512: 128,
  blake2s160: 40,
  blake2s224: 56,
  blake2s256: 64,
  blake2sp224: 56,
  blake2sp256: 64,
};

/** The table's length for a lowercase backend name, own properties only. */
function digestLengthOf(name: string): number | undefined {
  return Object.hasOwn(ANNEX_DIGEST_HEX_LENGTH, name) ? ANNEX_DIGEST_HEX_LENGTH[name] : undefined;
}

/** A backend positively identified from an annex key. */
export interface AnnexBackend {
  /** The backend as written in the key (`SHA256E`, `MD5`). */
  backend: string;
  /** Lowercase name without the `E` suffix, the key of {@link ANNEX_DIGEST_HEX_LENGTH}. */
  name: string;
  /** Digest length in hex characters. */
  length: number;
}

/**
 * Identify the hash backend of an annex key, or null. The backend is the token
 * before an optional `-s<size>` (and chunk fields such as `-S10-C3`) and the
 * `--` that opens the digest, so a size-less `MD5E--<hex>.edf` is identified
 * too. Only a backend in {@link ANNEX_DIGEST_HEX_LENGTH} counts: `WORM`, `URL`,
 * an unknown backend and a string that is not a key all return null, and no
 * length is ever applied to them.
 */
export function identifyAnnexBackend(key: string): AnnexBackend | null {
  const match = key.match(/^([A-Z0-9_]+?)(E?)(?:-s\d+)?(?:-[A-Za-z]\d+)*--/);
  if (!match) return null;
  const name = match[1].toLowerCase();
  // Own properties only: a backend named `constructor` or `__proto__` must not find
  // something on the object prototype.
  const length = digestLengthOf(name);
  if (length === undefined) return null;
  return { backend: `${match[1]}${match[2]}`, name, length };
}

/**
 * Extract the hash algorithm prefix from an annex key.
 * Key format: SHA256E-s12345--abc123.ext
 * Returns lowercase algorithm name (e.g., "sha256", "md5", "sha3_512"). A key whose
 * backend is not identified keeps the historic answer: the `-s`-anchored match
 * when there is one, else "sha256".
 */
export function extractHashAlgorithm(key: string): string {
  const identified = identifyAnnexBackend(key);
  if (identified) return identified.name;
  const match = key.match(/^([A-Z0-9]+?)E?-s/);
  return match ? match[1].toLowerCase() : "sha256";
}

/**
 * Extract the hash/checksum from an annex key.
 * Key format: SHA256E-s12345--abc123def456.ext
 * The hash is the hex run after `--`, cut to the backend's digest length ONLY when
 * the backend was identified from the key, so an extension that starts with hex
 * characters (`C`, `01`, `abc`) is not read as part of the digest. A run shorter
 * than the length is returned as found; {@link isWellFormedChecksum} reports it.
 * Any other key gets the historic greedy match, unchanged.
 */
export function extractChecksumFromKey(key: string): string {
  const match = key.match(/--([a-fA-F0-9]+)/);
  if (!match) return "";
  const length = identifyAnnexBackend(key)?.length;
  return length !== undefined && match[1].length > length ? match[1].slice(0, length) : match[1];
}

/**
 * True when `value` is a plausible digest for `algorithm`: lowercase hex of the
 * backend's length. An algorithm with no known length (`git`, `url`, anything
 * else) is not judged and counts as well formed.
 */
export function isWellFormedChecksum(algorithm: string, value: string): boolean {
  const length = digestLengthOf(algorithm);
  if (length === undefined) return true;
  return value.length === length && /^[0-9a-f]+$/.test(value);
}

/** What {@link repairStoredChecksum} decided about one stored checksum. */
export interface CheckedChecksum {
  value: string;
  /** `ok`: as stored, or not judged. `repaired`: re-derived from the key. `malformed`: wrong shape, no repair. */
  status: "ok" | "repaired" | "malformed";
}

/**
 * A manifest published before #2118 (and any a generator outside this repo
 * still writes) can store a digest with the key's extension attached. The key
 * is stored beside it, so the digest is re-derived from the key when, and only
 * when, the stored value has the wrong shape for its algorithm: a well-formed
 * value is returned untouched, so every valid entry is served byte for byte as
 * before. A value that cannot be repaired is returned as stored and reported
 * `malformed`; the caller decides how loudly.
 *
 * An entry whose key is present but names no known hash backend (`URL`, `WORM`,
 * an unknown one) is not judged at all: its stored label is a historic guess.
 */
export function repairStoredChecksum(
  algorithm: string,
  value: string,
  key: string | undefined,
): CheckedChecksum {
  if (isWellFormedChecksum(algorithm, value)) return { value, status: "ok" };
  if (typeof key === "string") {
    const identified = identifyAnnexBackend(key);
    if (identified === null) return { value, status: "ok" };
    if (identified.name === algorithm) {
      const derived = extractChecksumFromKey(key);
      if (isWellFormedChecksum(algorithm, derived)) return { value: derived, status: "repaired" };
    }
  }
  return { value, status: "malformed" };
}

/**
 * Optional behaviour switches for {@link generateManifest}. Kept optional and
 * defaulted so production callers don't change.
 */
export interface GenerateManifestOptions {
  /**
   * When true, suppress the post-build canary that HEAD-checks `git:`-keyed
   * paths against raw.githubusercontent.com (#503). Tests that mock the GitHub
   * tree + blob layer with synthetic data pass `true` here — without it the
   * canary would 404 against the real internet for fake repo/tag combinations
   * and surface as test failures unrelated to what the test is exercising.
   * Production callers (webhooks, admin publish flow) never set this.
   */
  skipGitBackedVerification?: boolean;
  /**
   * Raw content host for the canary. Defaults to {@link GITHUB_RAW_ORIGIN};
   * tests point it at a local server, the same override
   * `GitFileRequest.rawBase` carries for the broker. Production never sets it.
   */
  rawBase?: string;
}

/**
 * Generate a version manifest by traversing the git tree at a tag
 * and resolving annex pointer files to their S3 keys.
 */
export async function generateManifest(
  repo: string,
  version: string,
  pat: string,
  datasetId: string,
  doi: string | null,
  conceptDoi: string | null,
  options?: GenerateManifestOptions,
): Promise<VersionManifest> {
  const tag = version.startsWith("v") ? version : `v${version}`;

  // Get all blobs in the tree at this tag
  const entries = await getTreeAtRef(repo, tag, pat);

  // Internal git plumbing — we never expose these to the manifest.
  // The trailing `/` on `.git/` is intentional: a bare `.git` prefix would
  // also match `.gitattributes` and `.gitignore`, both of which are legit
  // BIDS-root files we DO want in the manifest. `.github/` is treated
  // separately (workflows for the dataset repo, not dataset content).
  function isInternal(entry: TreeEntry): boolean {
    return entry.path.startsWith(".git/") || entry.path.startsWith(".github/");
  }

  // Filter to potential annex pointer files (small blobs that could be pointers)
  // Annex pointers are typically < 500 bytes
  const pointerCandidates = entries.filter(
    (entry) =>
      entry.size !== undefined && entry.size < 500 && entry.size > 20 && !isInternal(entry),
  );

  const files: Record<string, ManifestFile> = {};
  const malformedChecksums: Array<{ path: string; backend: string }> = [];
  // Pointer candidates whose `parseAnnexPointer` returned null — they're
  // small regular git files (README, CHANGES, dataset_description.json on
  // OpenNeuro mirrors are commonly <500 bytes), NOT annex pointers. They
  // need to flow into the regular-files loop instead of being silently
  // dropped (see nemarOrg/nemar-cli#509).
  const nonAnnexCandidates: TreeEntry[] = [];

  // Resolve annex pointer candidates in parallel batches to avoid
  // sequential N+1 GitHub API calls (Cloudflare Workers have a
  // subrequest limit, so we cap concurrency)
  const CONCURRENCY = 10;
  for (let i = 0; i < pointerCandidates.length; i += CONCURRENCY) {
    const batch = pointerCandidates.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (entry) => {
        const content = await getBlobContent(repo, entry.sha, pat);
        const key = parseAnnexPointer(content);
        return { entry, key };
      }),
    );
    for (const { entry, key } of results) {
      if (key) {
        const algorithm = extractHashAlgorithm(key);
        const digest = extractChecksumFromKey(key);
        // Report (never refuse) a positively identified backend with a wrong-length digest;
        // a key this parser does not recognize is carried as before and never judged.
        const backend = identifyAnnexBackend(key);
        if (backend && !isWellFormedChecksum(algorithm, digest)) {
          malformedChecksums.push({ path: entry.path, backend: backend.backend });
        }
        files[entry.path] = {
          key,
          size: extractSizeFromKey(key),
          checksum: `${algorithm}:${digest}`,
        };
      } else {
        nonAnnexCandidates.push(entry);
      }
    }
  }

  // Every caller runs after the version's DOI is minted, so a manifest is never refused over
  // a digest: it is carried as found and reported once per build, as the data route does when
  // it serves a stored one. No checksum value is logged.
  if (malformedChecksums.length > 0) {
    const examples = malformedChecksums
      .slice(0, 3)
      .map((e) => `${e.path} [${e.backend}]`)
      .join(", ");
    console.warn(
      `[manifest] MALFORMED CHECKSUM dataset=${datasetId} version=${version} count=${malformedChecksums.length} examples=${examples}`,
    );
  }

  // Build the regular-files set: every git-tree entry that isn't internal
  // plumbing, isn't already in `files` (resolved as annex), and isn't a
  // size-range pointer candidate that actually WAS an annex pointer.
  // The `nonAnnexCandidates` we collected above are deliberately included.
  const pointerCandidatePaths = new Set(pointerCandidates.map((p) => p.path));
  const regularFiles: TreeEntry[] = [
    ...nonAnnexCandidates,
    ...entries.filter((entry) => !isInternal(entry) && !pointerCandidatePaths.has(entry.path)),
  ];

  for (const entry of regularFiles) {
    // Regular files stored in git (metadata, TSV, JSON, etc.)
    files[entry.path] = {
      key: `git:${entry.sha}`,
      size: entry.size ?? 0,
      checksum: `git:${entry.sha}`,
    };
  }

  // Publisher canary (#503): verify a small sample of git:-keyed entries is
  // actually readable at this tag, so a retag or a recovery script that
  // silently dropped blobs shows up at publish time rather than as a 404 on
  // someone's download. Throws on any non-200 — the caller surfaces the
  // message to the operator instead of writing a broken manifest.
  //
  // It no longer defends a redirect. Since #1403 the data plane streams
  // git-tracked bytes itself, so "the repo must be publicly readable" stopped
  // being a precondition for serving; what remains worth checking is that the
  // blobs exist at the tag at all. It reads the raw host WITH the installation
  // token for that reason (#1450): a private repo is a supported shape now that
  // an anonymous deposit is a public row over a private repository (ADR 0065),
  // and the credential is what makes the probe mean what the broker will do.
  // The earlier anonymous read told every private repo its blobs were gone, and
  // the carve-out it documented -- pass `skipGitBackedVerification` for a
  // private repo -- was never taken by any caller.
  if (!options?.skipGitBackedVerification) {
    await verifyGitBackedFiles({ repo, tag, files, pat, rawBase: options?.rawBase });
  }

  return {
    dataset_id: datasetId,
    version: version.replace(/^v/, ""),
    doi,
    concept_doi: conceptDoi,
    created: new Date().toISOString(),
    files,
  };
}

/**
 * Typed error so admin / webhook callers can surface a clear "your manifest
 * cannot resolve this file on GitHub" message without substring-matching.
 */
export class GitBackedFileMissingError extends Error {
  constructor(
    message: string,
    public readonly checks: GitBackedFileCheckResult[],
  ) {
    super(message);
    this.name = "GitBackedFileMissingError";
  }
}

/**
 * What one canary probe established.
 *
 * `absent` is the only verdict that refuses a manifest. The probe carries an
 * installation token, so a 404 means the path is not at that ref; a 401, a
 * throttle or a 5xx says nothing about the blob and must not be reported as
 * one missing (the broker's "a throttle is not an absence", one layer up).
 */
export type GitBackedFileVerdict = "present" | "absent" | "unchecked";

export interface GitBackedFileCheckResult {
  path: string;
  url: string;
  status: number;
  ok: boolean;
  verdict: GitBackedFileVerdict;
}

/**
 * HEAD a small sample of `git:`-keyed files to confirm the version tag is
 * visible to raw.githubusercontent.com and the manifested paths resolve.
 *
 * Sampling strategy: always check `dataset_description.json` if present
 * (the canonical BIDS root file the website hits first), plus up to four
 * additional `git:` entries chosen deterministically by path order. Total
 * worst case is five subrequests, well within the Worker 50-subrequest
 * budget shared with the rest of the publication pipeline.
 *
 * NOTE: when the manifest has zero `git:` entries (every file is annex-
 * keyed; rare but possible for a derivatives-only dataset) this is a no-op.
 *
 * Exported for unit-testing the path-selection logic; the live HEAD branch
 * is exercised end-to-end in test/publish-workflow.test.ts.
 */
export function selectGitBackedCanaries(
  files: Record<string, ManifestFile>,
  maxAdditional = 4,
): string[] {
  const gitPaths = Object.keys(files)
    .filter((path) => files[path].key.startsWith("git:"))
    .sort();
  if (gitPaths.length === 0) return [];
  const canaries: string[] = [];
  if (gitPaths.includes("dataset_description.json")) {
    canaries.push("dataset_description.json");
  }
  // Add up to `maxAdditional` more paths in deterministic order, excluding
  // any already-added canary so we don't double-check the same blob.
  for (const path of gitPaths) {
    if (canaries.length >= 1 + maxAdditional) break;
    if (!canaries.includes(path)) canaries.push(path);
  }
  return canaries;
}

/** A status the raw host answered with that decides nothing about the blob. */
function verdictFor(status: number): GitBackedFileVerdict {
  if (status >= 200 && status < 300) return "present";
  return status === 404 ? "absent" : "unchecked";
}

async function verifyGitBackedFiles(args: {
  repo: string;
  tag: string;
  files: Record<string, ManifestFile>;
  /** Installation token. Sent on every probe; a private repo needs it. */
  pat: string;
  rawBase?: string;
}): Promise<void> {
  const { repo, tag, files, pat, rawBase = GITHUB_RAW_ORIGIN } = args;
  const canaries = selectGitBackedCanaries(files);
  if (canaries.length === 0) return;

  const checks = await Promise.all(
    canaries.map(async (path): Promise<GitBackedFileCheckResult> => {
      const url = rawContentUrl(rawBase, repo, tag, path);
      // One retry with a 2-second backoff to absorb raw.githubusercontent.com
      // CDN propagation lag after a fresh tag push. The publish workflow that
      // calls generateManifest typically runs seconds after `git push --tags`,
      // so the first HEAD can race the propagation. A single short retry
      // catches that without inflating the Worker subrequest budget; a real
      // missing-blob failure stays failed across both attempts.
      //
      // The retry exists so a 404 can become a 200, and NOT so a 404 can be
      // forgotten. `present` returns immediately, an `absent` seen on either
      // attempt is kept even if the other attempt was inconclusive, and
      // `unchecked` is the verdict only when no attempt decided anything. Taking
      // the last attempt instead would let a 503 on the retry erase an
      // authenticated 404 from the first, and an erased absence writes a manifest
      // promising a blob the data plane cannot serve, which is the incident this
      // canary exists to prevent.
      let absent: GitBackedFileCheckResult | null = null;
      let last: GitBackedFileCheckResult = {
        path,
        url,
        status: 0,
        ok: false,
        verdict: "unchecked",
      };
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await fetch(url, {
            method: "HEAD",
            redirect: "follow",
            headers: { "User-Agent": "NEMAR-API", Authorization: `Bearer ${pat}` },
          });
          last = { path, url, status: res.status, ok: res.ok, verdict: verdictFor(res.status) };
          if (res.ok) return last;
          if (last.verdict === "absent") absent ??= last;
        } catch (err) {
          console.warn(
            `[manifest] canary HEAD threw dataset=${repo} tag=${tag} path=${path} attempt=${attempt + 1}:`,
            err instanceof Error ? err.message : String(err),
          );
          // A transport error is not an answer about the blob either.
          last = { path, url, status: 0, ok: false, verdict: "unchecked" };
        }
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
      return absent ?? last;
    }),
  );

  const missing = checks.filter((c) => c.verdict === "absent");
  const unchecked = checks.filter((c) => c.verdict === "unchecked");

  if (missing.length === 0) {
    // Said out loud rather than folded into the OK line: a run where the host
    // refused every probe writes a manifest nothing verified, and an operator
    // reading "canary OK" would believe otherwise (ADR 0053).
    if (unchecked.length > 0) {
      console.warn(
        `[manifest] git-backed canary UNCHECKED dataset=${repo} tag=${tag} ` +
          `checked=${canaries.length} undecided=${unchecked
            .map((u) => `${u.path} (HTTP ${u.status})`)
            .join(", ")}`,
      );
    } else {
      console.log(
        `[manifest] git-backed canary OK dataset=${repo} tag=${tag} checked=${canaries.length}`,
      );
    }
    return;
  }

  const summary = missing.map((f) => `${f.path} (HTTP ${f.status})`).join(", ");
  console.error(
    `[manifest] git-backed canary FAILED dataset=${repo} tag=${tag} failures=${summary}`,
  );
  throw new GitBackedFileMissingError(
    `Manifest canary failed: ${missing.length}/${checks.length} git:-keyed files do not resolve on raw.githubusercontent.com at tag ${tag}. Failing paths: ${summary}. The probe was authenticated, so a private repository is not the cause: the version tag may not exist on GitHub yet, or the blob may have been removed by a retag. Refusing to write a manifest that would 404 on data.nemar.org.`,
    checks,
  );
}
