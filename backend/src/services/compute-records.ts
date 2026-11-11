/**
 * The per-job record and the records bucket (epic #2005 phase A3, #2008; ADR 0118 decision 7, design
 * sections 7 and 9).
 *
 * NEMAR is the record of every tenant job, whichever front door submitted it. D1 holds an index row
 * (`compute_jobs`, account id and fixed words only); everything else a job leaves is here, in the
 * private records bucket, reached through the Worker's binding:
 *
 *   records/<id>/identity.json            who submitted it (restricted: see `readRecordObject`)
 *   records/<id>/spec.json                what was asked for; its SHA-256 is the job row's spec_digest
 *   records/<id>/submitted/bundle.tar.gz  the code bundle (or submitted/<path> for each partner file)
 *   records/<id>/bundle-manifest.json     the files inside the archive, with its digest and size
 *   records/<id>/result-manifest.json     the launcher's manifest.json, kept under this name
 *   records/<id>/provenance.json          the launcher's provenance
 *   records/<id>/result.json              the launcher's result
 *   logs/<id>/tapisjob.out, launcher.log  the logs (a shorter retention)
 *   incoming/<id>/bundle.tar.gz           an upload in flight (or incoming/<id>/<path> per file)
 *
 * The node and the results bucket use `manifest.json`; the records bucket calls it
 * `result-manifest.json`; there is no `failure.json`. The results bucket's keys, `jobs/<id>/outputs/`
 * and `jobs/<id>/launcher/`, are the outputs routes' (#2010), and are built by the contract's
 * `resultsOutputKey` and `resultsLauncherKey`.
 *
 * THE RULES, each one deliberate:
 *  - A record is written once, and never rewritten. The records bucket is locked by prefix (bucket
 *    configuration, never code), so an overwrite is refused by the bucket; this module never asks for
 *    one. Every write is create-only (`putOnce`): a key that exists is left alone, and a write that
 *    finds one with other content says so rather than replacing it. An identity snapshot that exists is
 *    kept whatever the account says now: what was true at submission is the record.
 *  - NOTHING IS COPIED INTO `records/` BEFORE THE HOLD COMMITS. A record is written after the job's
 *    batch, never before it, and the bundle is copied only after the job's row (which exists only if
 *    its hold does) has been read: a bucket lock would make an orphan record for a refused job
 *    permanent. A bundle waits in `incoming/`, which a lifecycle rule empties after two days.
 *  - Identity is in the records bucket only. Reading it, or a submitted file, is OWNER-ONLY, needs a
 *    stated reason of 8 to 200 characters, and writes the `compute.record.read` audit row BEFORE any
 *    byte is read; if that write fails the read is refused. The row says who, what and why; the bucket's
 *    own access log is the other half.
 *  - The only presigned reads of a record are `presignBundleRead` (the launcher's address for the
 *    job's OWN bundle, 10 minutes, no other key) and the 5-minute address `readRecordObject` gives an
 *    owner for one submitted file or log.
 *  - Logs carry job ids and fixed words, never a path a person chose.
 *  - A bound the Worker relies on is read back through the binding: a presigned PUT can be checked by
 *    its checksum header only where R2 enforces it, which has not been verified, so the object's SIZE is
 *    what `finalizeBundle` compares.
 *  - A Worker invocation may make at most 1,000 subrequests, and a partner's per-file upload costs one
 *    `CopyObject` each, so it is bounded at `PARTNER_FILES_MAX` files whatever the owner's limit.
 */

import type { ComputeState } from "../../../shared/compute-state.js";
import {
  COMPUTE_DOT_SEGMENT_RE,
  COMPUTE_JOB_ID_RE,
  COMPUTE_MAX_OUTPUT_FILES,
  COMPUTE_SHA256_RE,
  type JobSpec,
  JobSpecSchema,
  RECORDS_RESULT_MANIFEST_FILE,
  computeIsWellFormed,
  isSafeComputePath,
} from "../../../shared/contract/compute.js";
import type { Bindings } from "../types/bindings.js";
import { ACTIVE_ACCOUNT_STATUSES } from "./account-tier.js";
import { getPolicy } from "./compute-policy.js";
import {
  COMPUTE_BUNDLE_READ_SECONDS,
  COMPUTE_RECORD_READ_SECONDS,
  COMPUTE_UPLOAD_SECONDS,
  COPY_OBJECT_MAX_BYTES,
  type ComputeS3,
  type ComputeS3Env,
  computeS3,
  copyObject,
  objectKeyProblem,
  presignGet,
  presignPut,
} from "./compute-s3.js";

// --- Keys ------------------------------------------------------------------------------------

/** The one archive of a job that uploads a code bundle, in `incoming/` and in `records/.../submitted/`. */
export const BUNDLE_ARCHIVE_NAME = "bundle.tar.gz";

/** The records a job keeps under `records/<id>/`, each by name. The launcher's manifest is renamed. */
export const RECORD_FILES = [
  "identity.json",
  "spec.json",
  "bundle-manifest.json",
  RECORDS_RESULT_MANIFEST_FILE,
  "provenance.json",
  "result.json",
] as const;

export type RecordFile = (typeof RECORD_FILES)[number];

/** The two logs of a job, under `logs/<id>/`. */
export const LOG_FILES = ["tapisjob.out", "launcher.log"] as const;

export type LogFile = (typeof LOG_FILES)[number];

/** The most files of one partner upload: one `CopyObject` each, and a Worker may make 1,000 subrequests. */
export const PARTNER_FILES_MAX = 500;

/** The longest path of a submitted file, as the contract's output path. */
const PATH_MAX = 512;

function jobIdOrThrow(jobId: string): string {
  if (typeof jobId !== "string" || !COMPUTE_JOB_ID_RE.test(jobId)) {
    throw new RangeError("not a job id");
  }
  return jobId;
}

/** Whether a text holds a control character or DEL (no path, and no reason, may). */
const hasControlCharacter = (text: string): boolean => {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x20 || unit === 0x7f) return true;
  }
  return false;
};

/**
 * Percent-decode every run of valid `%XX` escapes in a text and leave everything else as it is, so a
 * stray `%` (`100%.txt`, `%2e%2e/%`) never stops the escapes around it from being read. A run is
 * decoded byte by byte (an invalid byte becomes U+FFFD, which is no path separator, dot or control
 * character), so it cannot fail the way `decodeURIComponent` of the whole text does at its first
 * malformed escape.
 */
function decodeEscapes(text: string): string {
  return text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    const bytes = new Uint8Array(run.length / 3);
    for (let i = 0; i < bytes.length; i++)
      bytes[i] = Number.parseInt(run.slice(i * 3 + 1, i * 3 + 3), 16);
    return new TextDecoder().decode(bytes);
  });
}

/**
 * Why a submitted file's path may not be used, or null. The contract's own predicate first (no empty,
 * `.` or `..` segment, no backslash or control character, at most 512 characters), and then what a
 * single or double percent-decoding of it would be: a traversal in a form a later reader might decode
 * (`%2e%2e`, `%252e%252e`, `%2f..%2f`) is refused as a traversal, even beside a stray `%`
 * (`%2e%2e/%`), while a `%` that does not decode (`100%.txt`) is just a name. The refusals are fixed
 * words and hold no part of the path.
 *
 * This is the rule for a name. It is NOT the rule for a key: 512 characters can be 1,536 bytes, and a
 * lone surrogate cannot be encoded at all, so a caller that builds a key from the path also asks
 * `filePathProblem`.
 */
export function submittedPathProblem(path: unknown): string | null {
  if (typeof path !== "string" || path.length === 0) return "empty";
  if (!isSafeComputePath(path, PATH_MAX)) return "unsafe";
  let current = path;
  for (let layer = 0; layer < 2; layer++) {
    const decoded = decodeEscapes(current);
    if (decoded === current) break;
    if (
      decoded.startsWith("/") ||
      decoded.includes("\\") ||
      hasControlCharacter(decoded) ||
      COMPUTE_DOT_SEGMENT_RE.test(decoded)
    ) {
      return "encoded_traversal";
    }
    current = decoded;
  }
  return null;
}

/**
 * Why a path that passes `submittedPathProblem` still cannot be the tail of this job's keys, or null:
 * a lone surrogate (no text, and `encodeURIComponent` throws on it) or a key over the 1,024 bytes a
 * key may be, checked for BOTH keys the path becomes, `incoming/<id>/<path>` and
 * `records/<id>/submitted/<path>` (the second is 9 characters longer). The callers that build a key
 * ask this before they sign anything and answer the path, not a signing error.
 */
export function filePathProblem(jobId: string, path: string): string | null {
  const named = submittedPathProblem(path);
  if (named !== null) return named;
  if (!computeIsWellFormed(path)) return "not_text";
  // `incoming/<id>/` is shorter than `records/<id>/submitted/`, so the second check implies the first
  // for the length; both are asked because both are keys this path becomes, and so that a later change
  // to either prefix cannot silently loosen the rule.
  if (objectKeyProblem(incomingKey(jobId, path)) !== null) return "key_invalid";
  if (objectKeyProblem(submittedKey(jobId, path)) !== null) return "key_invalid";
  return null;
}

function pathOrThrow(path: string): string {
  if (submittedPathProblem(path) !== null) throw new RangeError("not a safe path");
  return path;
}

/** `records/<id>/<file>`: one of the records of a job. */
export function recordKey(jobId: string, file: RecordFile): string {
  jobIdOrThrow(jobId);
  if (!(RECORD_FILES as readonly string[]).includes(file)) throw new RangeError("not a record");
  return `records/${jobId}/${file}`;
}

/** `records/<id>/submitted/<path>`: what the person (or the partner) submitted. */
export function submittedKey(jobId: string, path: string): string {
  return `records/${jobIdOrThrow(jobId)}/submitted/${pathOrThrow(path)}`;
}

/** `logs/<id>/<file>`: one of the two logs. */
export function logKey(jobId: string, file: LogFile): string {
  jobIdOrThrow(jobId);
  if (!(LOG_FILES as readonly string[]).includes(file)) throw new RangeError("not a log");
  return `logs/${jobId}/${file}`;
}

/** `incoming/<id>/<path>`: an upload in flight, before the job's hold is known to have committed. */
export function incomingKey(jobId: string, path: string): string {
  return `incoming/${jobIdOrThrow(jobId)}/${pathOrThrow(path)}`;
}

// --- Environment and refusals ------------------------------------------------------------------

export type ComputeRecordsEnv = ComputeS3Env & Pick<Bindings, "DB" | "COMPUTE_RECORDS">;

/** The words a records function refuses with: the gateway's own (`shared/compute-state.ts`). */
export type RecordsRefusalCode =
  | "compute_disabled"
  | "job_not_found"
  | "bad_state"
  | "invalid_spec"
  | "bundle_too_large"
  | "bundle_too_many_files";

export interface RecordsRefusal {
  ok: false;
  code: RecordsRefusalCode;
  /** Where in the request the problem is, as `files.2.path`; never a value. */
  field?: string;
}

const refuse = (code: RecordsRefusalCode, field?: string): RecordsRefusal =>
  field === undefined ? { ok: false, code } : { ok: false, code, field };

export type RecordErrorCode = "record_conflict" | "copy_unverified";

/** A record that cannot be written as asked: it exists with other content, or a copy did not read back. */
export class ComputeRecordError extends Error {
  constructor(
    readonly code: RecordErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ComputeRecordError";
  }
}

const encoder = new TextEncoder();

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let out = "";
  for (let i = 0; i < digest.length; i++)
    out += (digest[i] as number).toString(16).padStart(2, "0");
  return out;
}

// --- Create-only writes -------------------------------------------------------------------------

type Written = "written" | "present" | "conflict";

/**
 * Write `bytes` at `key` only if nothing is there. Present is left alone: with `compare`, if its
 * bytes are the same it is `present` and if not it is a `conflict`; with `keep` it is `present`
 * whatever it holds. The head comes first so a bucket that does not honour the conditional write is
 * still not asked to overwrite; the conditional write is for the race between the head and the put.
 */
async function putOnce(
  bucket: R2Bucket,
  key: string,
  bytes: Uint8Array,
  contentType: string,
  existing: "compare" | "keep",
  customMetadata?: Record<string, string>,
): Promise<Written> {
  const settle = async (): Promise<Written> => {
    if (existing === "keep") return "present";
    const object = await bucket.get(key);
    if (!object) return "conflict";
    const stored = new Uint8Array(await object.arrayBuffer());
    if (stored.length !== bytes.length) return "conflict";
    for (let i = 0; i < stored.length; i++) if (stored[i] !== bytes[i]) return "conflict";
    return "present";
  };
  if ((await bucket.head(key)) !== null) return settle();
  const put = await bucket.put(key, bytes, {
    httpMetadata: { contentType },
    ...(customMetadata === undefined ? {} : { customMetadata }),
    onlyIf: { etagDoesNotMatch: "*" },
  });
  return put === null ? settle() : "written";
}

/**
 * Write one record or log of a job (`recordKey` or `logKey` builds the key) only if nothing is there:
 * an object that exists is left exactly as it is, whatever it holds (a copy is retried after a
 * failure, and a retry never rewrites what the locked bucket already took). True when it wrote.
 * Phase A5's copy of the launcher's files and the logs into the records. `customMetadata` is stored with
 * the object (a log that was cut at its bound says so there: `truncated`).
 */
export async function putRecordOnce(
  env: ComputeRecordsEnv,
  key: string,
  bytes: Uint8Array,
  contentType: string,
  customMetadata?: Record<string, string>,
): Promise<boolean> {
  const bucket = env.COMPUTE_RECORDS;
  if (!bucket) throw new Error("the records bucket is not bound");
  return (await putOnce(bucket, key, bytes, contentType, "keep", customMetadata)) === "written";
}

// --- The identity snapshot and the specification -------------------------------------------------

/** The columns of the `users` row an identity snapshot takes, and nothing else about the person. */
export const IDENTITY_USER_SQL = `SELECT orcid, given_name, family_name, email, country, affiliation
  FROM users WHERE id = ?1`;

interface IdentityRow {
  orcid: string | null;
  given_name: string | null;
  family_name: string | null;
  email: string | null;
  country: string | null;
  affiliation: string | null;
}

const nonBlank = (value: string | null | undefined): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

/**
 * Who submitted a job, as it was at submission: the ORCID iD, name, email, country, affiliation, the
 * account id, the OIDC subject (null until the sign-in epic gives accounts one) and when it was
 * captured, and nothing else. For an account that has no row, or no account at all, the fields are
 * null. Written once: an existing snapshot is kept, so a replay never replaces what was true then.
 */
export async function writeIdentitySnapshot(
  env: ComputeRecordsEnv,
  jobId: string,
  accountId: number | null,
): Promise<void> {
  const bucket = env.COMPUTE_RECORDS;
  if (!bucket) throw new Error("the records bucket is not bound");
  const row =
    accountId === null
      ? null
      : await env.DB.prepare(IDENTITY_USER_SQL).bind(accountId).first<IdentityRow>();
  const name = [nonBlank(row?.given_name), nonBlank(row?.family_name)].filter((p) => p !== null);
  const snapshot = {
    orcid: nonBlank(row?.orcid),
    name: name.length > 0 ? name.join(" ") : null,
    email: nonBlank(row?.email),
    country: nonBlank(row?.country),
    affiliation: nonBlank(row?.affiliation),
    account_id: accountId,
    sub: null,
    captured_at: new Date().toISOString(),
  };
  await putOnce(
    bucket,
    recordKey(jobId, "identity.json"),
    encoder.encode(JSON.stringify(snapshot)),
    "application/json",
    "keep",
  );
}

/**
 * The job's specification record, exactly `text` (the bytes whose SHA-256 the job row holds). Written
 * once; the same text again is no conflict, and another text for a job that has one throws
 * `record_conflict` and changes nothing.
 */
export async function writeSpec(
  env: ComputeRecordsEnv,
  jobId: string,
  text: string,
): Promise<void> {
  const bucket = env.COMPUTE_RECORDS;
  if (!bucket) throw new Error("the records bucket is not bound");
  const outcome = await putOnce(
    bucket,
    recordKey(jobId, "spec.json"),
    encoder.encode(text),
    "application/json",
    "compare",
  );
  if (outcome === "conflict") {
    throw new ComputeRecordError("record_conflict", "the job's specification was already recorded");
  }
}

// --- What the jobs table says about a job's records -----------------------------------------------

export const JOB_RECORDS_SQL = `SELECT id, source, state, account_id, records_written_at
  FROM compute_jobs WHERE id = ?1`;

interface JobRecordsRow {
  id: string;
  source: string;
  state: ComputeState;
  account_id: number | null;
  records_written_at: string | null;
}

/** The job's records are complete; only when this is set may a job be submitted (phase A5). */
export const RECORDS_WRITTEN_SQL = `UPDATE compute_jobs SET records_written_at = datetime('now')
  WHERE id = ?1 AND records_written_at IS NULL`;

/** The states in which a job's upload may still be asked for and finalized: it has not started. */
const UPLOAD_STATES: readonly ComputeState[] = ["created", "uploading"];

async function jobRow(env: ComputeRecordsEnv, jobId: string): Promise<JobRecordsRow | null> {
  return env.DB.prepare(JOB_RECORDS_SQL).bind(jobId).first<JobRecordsRow>();
}

// --- Files, limits and manifests ------------------------------------------------------------------

/** One declared file: its path and its size, and optionally its digest (for an upload address). */
export interface DeclaredFile {
  path: string;
  size: number;
  sha256?: string;
}

interface BundleLimits {
  maxTotalBytes: number;
  maxFiles: number;
  maxFileBytes: number;
}

type FilesCheck = { ok: true; files: DeclaredFile[] } | RecordsRefusal;

/**
 * The most files of a partner's own upload: the owner's bundle count or `PARTNER_FILES_MAX`, whichever
 * is fewer. THE PARTNER CAP SHADOWS THE OWNER'S `bundleLimits.maxFiles` with the same refusal word
 * (`bundle_too_many_files`), so the partner contract and the design's section 6 must say 500, not the
 * owner's number.
 */
function partnerFileCap(limits: BundleLimits): number {
  return Math.min(limits.maxFiles, PARTNER_FILES_MAX);
}

/**
 * The most bytes of one archive or one submitted file: the owner's limit, and never more than R2 copies
 * in one `CopyObject` request (5 GiB), which is also the most one presigned PUT takes. The contract's
 * limits are not bounded above, so this is where the bound is.
 */
export function copyableLimit(limit: number): number {
  return Math.min(limit, COPY_OBJECT_MAX_BYTES);
}

/**
 * A declared list of files, checked against the owner's limits and for traversal: a non-empty list of
 * at most `maxCount` entries, each exactly `{ path, size }` (and `sha256` when `digest` is allowed), a
 * safe unique path, a size that is a whole number within the file limit, and a total within the total
 * limit. Each refusal names its field, never a value.
 */
function checkFiles(
  files: unknown,
  limits: BundleLimits,
  options: { maxCount: number; digest: boolean; keysOf?: string },
): FilesCheck {
  if (!Array.isArray(files) || files.length === 0) return refuse("invalid_spec", "files");
  if (files.length > options.maxCount) return refuse("bundle_too_many_files");
  const seen = new Set<string>();
  const checked: DeclaredFile[] = [];
  let total = 0;
  for (let i = 0; i < files.length; i++) {
    const entry = files[i] as Record<string, unknown> | null;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return refuse("invalid_spec", `files.${i}`);
    }
    const allowed = options.digest ? ["path", "size", "sha256"] : ["path", "size"];
    if (Object.keys(entry).some((k) => !allowed.includes(k)))
      return refuse("invalid_spec", `files.${i}`);
    // A name is judged by the path rule; a path that becomes a key of this job is judged by the keys too.
    const problem =
      options.keysOf === undefined
        ? submittedPathProblem(entry.path)
        : typeof entry.path === "string"
          ? filePathProblem(options.keysOf, entry.path)
          : "empty";
    if (problem !== null) return refuse("invalid_spec", `files.${i}.path`);
    const path = entry.path as string;
    if (seen.has(path)) return refuse("invalid_spec", `files.${i}.path`);
    seen.add(path);
    const size = entry.size;
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
      return refuse("invalid_spec", `files.${i}.size`);
    }
    const digest = entry.sha256;
    if (digest !== undefined && (typeof digest !== "string" || !COMPUTE_SHA256_RE.test(digest))) {
      return refuse("invalid_spec", `files.${i}.sha256`);
    }
    if (size > copyableLimit(limits.maxFileBytes)) return refuse("bundle_too_large");
    total += size;
    if (total > limits.maxTotalBytes) return refuse("bundle_too_large");
    checked.push(digest === undefined ? { path, size } : { path, size, sha256: digest as string });
  }
  return { ok: true, files: checked };
}

/** The bytes of the manifest record: one canonical text, so a replay is compared byte for byte. */
function manifestText(
  jobId: string,
  archive: { sha256: string; size: number } | null,
  files: DeclaredFile[],
): string {
  return JSON.stringify({
    job_id: jobId,
    archive,
    files: files.map((f) => ({ path: f.path, size: f.size })),
  });
}

/** The size of every object under a prefix of a bucket, by key (a listing is one subrequest per 1,000). */
async function sizesUnder(bucket: R2Bucket, prefix: string): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, cursor });
    for (const o of listed.objects) sizes.set(o.key, o.size);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return sizes;
}

/** The job's recorded specification, parsed: null when it is not there or not a job specification. */
async function recordedSpec(bucket: R2Bucket, jobId: string): Promise<JobSpec | null> {
  const object = await bucket.get(recordKey(jobId, "spec.json"));
  if (!object) return null;
  let value: unknown;
  try {
    value = JSON.parse(await object.text());
  } catch {
    return null;
  }
  const parsed = JobSpecSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

// --- Upload addresses --------------------------------------------------------------------------------

export interface IncomingUpload {
  path: string;
  url: string;
  /** Headers to send with the PUT (the signed checksum), empty when none was asked for. */
  headers: Record<string, string>;
}

export type IncomingUploadsResult =
  | { ok: true; uploads: IncomingUpload[]; expires_at: string }
  | RecordsRefusal;

/**
 * One-hour PUT addresses into `incoming/<id>/` for a job's upload: ONE address for `bundle.tar.gz`
 * for a job that uploads a code bundle (its size must be the one the job was made with, within the
 * owner's total limit), or one for each declared file for a partner's own files (at most
 * `PARTNER_FILES_MAX`, each within the owner's file limit and all within the total limit; a path that
 * could escape is refused in any encoding). A digest, when given, is signed with the URL as
 * `x-amz-checksum-sha256` and returned as a header to send; whether R2 enforces it is not verified,
 * so the size read back at finalize is the bound.
 *
 * It is asked again after an address expires, and is refused for a job that has ended, one that was
 * never made, and one whose records are written: never after the job is complete. `options.now` is the
 * moment to sign as of, which only a test sets (to make an address that has already expired).
 */
// NOT CALLED YET: no route reaches this; Epic D's partner contract (the per-file upload) wires it.
export async function presignIncomingUploads(
  env: ComputeRecordsEnv,
  jobId: string,
  files: DeclaredFile[],
  options: { now?: Date } = {},
): Promise<IncomingUploadsResult> {
  const bucket = env.COMPUTE_RECORDS;
  const s3 = computeS3(env);
  if (!bucket || !s3) return refuse("compute_disabled");
  if (typeof jobId !== "string" || !COMPUTE_JOB_ID_RE.test(jobId)) return refuse("job_not_found");
  const job = await jobRow(env, jobId);
  if (!job) return refuse("job_not_found");
  if (job.records_written_at !== null || !UPLOAD_STATES.includes(job.state)) {
    return refuse("bad_state");
  }
  const { bundleLimits: limits } = (await getPolicy(env.DB)).policy;

  let declared: DeclaredFile[];
  if (job.source === "partner") {
    const checked = checkFiles(files, limits, {
      maxCount: partnerFileCap(limits),
      digest: true,
      keysOf: jobId,
    });
    if (!checked.ok) return checked;
    declared = checked.files;
  } else {
    if (!Array.isArray(files) || files.length !== 1) return refuse("invalid_spec", "files");
    const [file] = files as DeclaredFile[];
    if (file?.path !== BUNDLE_ARCHIVE_NAME) return refuse("invalid_spec", "files.0.path");
    const checked = checkFiles(
      files,
      // The archive is the one file: its limit is the total (`checkFiles` holds it to the copy bound).
      { ...limits, maxFileBytes: limits.maxTotalBytes },
      { maxCount: 1, digest: true },
    );
    if (!checked.ok) return checked;
    declared = checked.files;
    const size = (declared[0] as DeclaredFile).size;
    if (size < 1) return refuse("invalid_spec", "files.0.size");
    const spec = await recordedSpec(bucket, jobId);
    if (!spec?.bundle) return refuse("bad_state");
    if (spec.bundle.size !== size) return refuse("invalid_spec", "files.0.size");
    const digest = (declared[0] as DeclaredFile).sha256;
    if (digest !== undefined && digest !== spec.bundle.sha256)
      return refuse("invalid_spec", "files.0.sha256");
  }

  const uploads: IncomingUpload[] = [];
  let expiresAt = "";
  for (const file of declared) {
    const signed = await presignPut(s3, "records", incomingKey(jobId, file.path), {
      expiresIn: COMPUTE_UPLOAD_SECONDS,
      ...(file.sha256 === undefined ? {} : { sha256Hex: file.sha256 }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    uploads.push({ path: file.path, url: signed.url, headers: signed.headers });
    expiresAt = expiresAt === "" || signed.expires_at < expiresAt ? signed.expires_at : expiresAt;
  }
  return { ok: true, uploads, expires_at: expiresAt };
}

// --- Finalizing an upload: the copy into the locked records ------------------------------------------

export type FinalizeResult = { ok: true; replayed: boolean; files: number } | RecordsRefusal;

export interface BundleFinalizeInput {
  /** The archive's own SHA-256 and size, which must be those the job was made with. */
  archive: { sha256: string; size: number };
  /** The files inside the archive, as the packer lists them. */
  files: Array<{ path: string; size: number }>;
}

/** Whether the manifest already recorded is the one this request would write: a replay, or not. */
async function manifestStatus(
  bucket: R2Bucket,
  jobId: string,
  text: string,
): Promise<"same" | "different" | "none"> {
  const object = await bucket.get(recordKey(jobId, "bundle-manifest.json"));
  if (!object) return "none";
  return (await object.text()) === text ? "same" : "different";
}

/** Make sure the two records a job always has are there: a snapshot is written only if absent. */
async function healJobRecords(
  env: ComputeRecordsEnv,
  bucket: R2Bucket,
  job: JobRecordsRow,
): Promise<boolean> {
  if ((await bucket.head(recordKey(job.id, "spec.json"))) === null) return false;
  if ((await bucket.head(recordKey(job.id, "identity.json"))) === null) {
    await writeIdentitySnapshot(env, job.id, job.account_id);
  }
  return true;
}

/** The common tail: the manifest is written once and the job's records are marked written. */
async function completeRecords(
  env: ComputeRecordsEnv,
  bucket: R2Bucket,
  job: JobRecordsRow,
  text: string,
): Promise<RecordsRefusal | null> {
  if (!(await healJobRecords(env, bucket, job))) return refuse("bad_state");
  const written = await putOnce(
    bucket,
    recordKey(job.id, "bundle-manifest.json"),
    encoder.encode(text),
    "application/json",
    "compare",
  );
  if (written === "conflict") return refuse("bad_state");
  await env.DB.prepare(RECORDS_WRITTEN_SQL).bind(job.id).run();
  return null;
}

/**
 * Finalize a code bundle: the declared manifest is validated (the owner's limits, traversal in any
 * encoding), the archive's digest and size must be those the job was made with, the uploaded object's
 * size must equal the declared one (a mismatch refuses and deletes nothing), and only then, the job's
 * row (which exists only if its hold does) having been read back from D1, one `CopyObject` takes `incoming/<id>/bundle.tar.gz` into
 * `records/<id>/submitted/bundle.tar.gz`, whose size is read back; `bundle-manifest.json` is written
 * and `records_written_at` is set. It is idempotent: the same request again is `replayed` and copies
 * nothing, another manifest is `bad_state`, and a first attempt that died between the copy and the
 * manifest is resumed without copying again. An object already at the destination with another size is
 * never overwritten. A copy the store refuses throws `ComputeS3Error` (`copy_failed`): the caller
 * answers 503 and asks again.
 */
// NOT CALLED YET: no route reaches this; Epic D's partner contract (a code bundle's finalize) wires it.
export async function finalizeBundle(
  env: ComputeRecordsEnv,
  jobId: string,
  input: BundleFinalizeInput,
): Promise<FinalizeResult> {
  const bucket = env.COMPUTE_RECORDS;
  const s3 = computeS3(env);
  if (!bucket || !s3) return refuse("compute_disabled");
  if (typeof jobId !== "string" || !COMPUTE_JOB_ID_RE.test(jobId)) return refuse("job_not_found");
  // The job and its hold first: nothing is copied for a job that was never committed.
  const job = await jobRow(env, jobId);
  if (!job) return refuse("job_not_found");
  if (job.source === "partner") return refuse("bad_state");

  const { bundleLimits: limits } = (await getPolicy(env.DB)).policy;
  const archive = input?.archive;
  if (
    typeof archive !== "object" ||
    archive === null ||
    typeof archive.sha256 !== "string" ||
    !COMPUTE_SHA256_RE.test(archive.sha256) ||
    !Number.isSafeInteger(archive.size) ||
    archive.size < 1
  ) {
    return refuse("invalid_spec", "archive");
  }
  if (archive.size > copyableLimit(limits.maxTotalBytes)) return refuse("bundle_too_large");
  const checked = checkFiles(input.files, limits, { maxCount: limits.maxFiles, digest: false });
  if (!checked.ok) return checked;
  const text = manifestText(jobId, { sha256: archive.sha256, size: archive.size }, checked.files);

  if (job.records_written_at !== null) {
    return (await manifestStatus(bucket, jobId, text)) === "same"
      ? { ok: true, replayed: true, files: checked.files.length }
      : refuse("bad_state");
  }
  if (!UPLOAD_STATES.includes(job.state)) return refuse("bad_state");

  const spec = await recordedSpec(bucket, jobId);
  if (!spec?.bundle) return refuse("bad_state");
  if (spec.bundle.sha256 !== archive.sha256 || spec.bundle.size !== archive.size) {
    return refuse("invalid_spec", "archive");
  }

  const from = incomingKey(jobId, BUNDLE_ARCHIVE_NAME);
  const to = submittedKey(jobId, BUNDLE_ARCHIVE_NAME);
  const uploaded = await bucket.head(from);
  if (!uploaded) return refuse("bad_state");
  if (uploaded.size !== archive.size) return refuse("invalid_spec", "archive");

  const present = await bucket.head(to);
  if (present) {
    // A first attempt that died after its copy: the same size is that copy. Another is never replaced.
    if (present.size !== archive.size) return refuse("bad_state");
  } else {
    await copyObject(s3, { bucket: "records", key: from }, { bucket: "records", key: to });
    const copied = await bucket.head(to);
    if (!copied || copied.size !== archive.size) {
      throw new ComputeRecordError("copy_unverified", "the copied bundle did not read back");
    }
  }

  const tail = await completeRecords(env, bucket, job, text);
  if (tail) return tail;
  return { ok: true, replayed: false, files: checked.files.length };
}

/**
 * Finalize a partner's own files: the per-file form of `finalizeBundle`. Every declared file's
 * uploaded size is checked against one listing of `incoming/<id>/` BEFORE any is copied (so a file of
 * the wrong size, or one never uploaded, refuses the whole set and copies nothing), then each file not
 * already in `records/<id>/submitted/` is copied once, the copies are read back by one listing, and the
 * manifest (`archive: null`) is written and the records marked written. Idempotent as `finalizeBundle`
 * is.
 */
// NOT CALLED YET: no route reaches this; Epic D's partner contract (a partner's own files) wires it.
export async function finalizeSubmittedFiles(
  env: ComputeRecordsEnv,
  jobId: string,
  input: { files: Array<{ path: string; size: number }> },
): Promise<FinalizeResult> {
  const bucket = env.COMPUTE_RECORDS;
  const s3 = computeS3(env);
  if (!bucket || !s3) return refuse("compute_disabled");
  if (typeof jobId !== "string" || !COMPUTE_JOB_ID_RE.test(jobId)) return refuse("job_not_found");
  const job = await jobRow(env, jobId);
  if (!job) return refuse("job_not_found");
  if (job.source !== "partner") return refuse("bad_state");

  const { bundleLimits: limits } = (await getPolicy(env.DB)).policy;
  const checked = checkFiles(input?.files, limits, {
    maxCount: partnerFileCap(limits),
    digest: false,
    keysOf: jobId,
  });
  if (!checked.ok) return checked;
  const text = manifestText(jobId, null, checked.files);

  if (job.records_written_at !== null) {
    return (await manifestStatus(bucket, jobId, text)) === "same"
      ? { ok: true, replayed: true, files: checked.files.length }
      : refuse("bad_state");
  }
  if (!UPLOAD_STATES.includes(job.state)) return refuse("bad_state");

  const incoming = await sizesUnder(bucket, `incoming/${jobId}/`);
  const submitted = await sizesUnder(bucket, `records/${jobId}/submitted/`);
  const toCopy: DeclaredFile[] = [];
  for (let i = 0; i < checked.files.length; i++) {
    const file = checked.files[i] as DeclaredFile;
    const size = incoming.get(incomingKey(jobId, file.path));
    if (size === undefined) return refuse("bad_state", `files.${i}.path`);
    if (size !== file.size) return refuse("invalid_spec", `files.${i}.size`);
    const there = submitted.get(submittedKey(jobId, file.path));
    if (there === undefined) toCopy.push(file);
    else if (there !== file.size) return refuse("bad_state", `files.${i}.path`);
  }

  for (const file of toCopy) {
    await copyObject(
      s3,
      { bucket: "records", key: incomingKey(jobId, file.path) },
      { bucket: "records", key: submittedKey(jobId, file.path) },
    );
  }
  if (toCopy.length > 0) {
    const after = await sizesUnder(bucket, `records/${jobId}/submitted/`);
    for (const file of checked.files) {
      if (after.get(submittedKey(jobId, file.path)) !== file.size) {
        throw new ComputeRecordError("copy_unverified", "a copied file did not read back");
      }
    }
  }

  const tail = await completeRecords(env, bucket, job, text);
  if (tail) return tail;
  return { ok: true, replayed: false, files: checked.files.length };
}

// --- Reads ---------------------------------------------------------------------------------------------

export type BundleReadResult =
  | { ok: true; url: string; expires_at: string }
  | Pick<RecordsRefusal, "ok" | "code">;

/**
 * A 10-minute presigned GET of THAT JOB's own `records/<id>/submitted/bundle.tar.gz` and no other key,
 * for #2010's bundle route (the launcher, with its job token). The key is made here from the job id
 * and from nothing a caller supplies. A job that is not an id is `job_not_found`; one with no bundle
 * in the records is `bad_state`.
 */
export async function presignBundleRead(
  env: ComputeRecordsEnv,
  jobId: string,
): Promise<BundleReadResult> {
  const bucket = env.COMPUTE_RECORDS;
  const s3 = computeS3(env);
  if (!bucket || !s3) return { ok: false, code: "compute_disabled" };
  if (typeof jobId !== "string" || !COMPUTE_JOB_ID_RE.test(jobId)) {
    return { ok: false, code: "job_not_found" };
  }
  const key = submittedKey(jobId, BUNDLE_ARCHIVE_NAME);
  if ((await bucket.head(key)) === null) return { ok: false, code: "bad_state" };
  const signed = await presignGet(s3, "records", key, { expiresIn: COMPUTE_BUNDLE_READ_SECONDS });
  return { ok: true, url: signed.url, expires_at: signed.expires_at };
}

/** The shortest and longest reason an owner may give for reading a record. */
export const RECORD_READ_REASON_MIN = 8;
export const RECORD_READ_REASON_MAX = 200;

/** The audit action of a read; the audit row is written before any byte is read. */
export const RECORD_READ_ACTION = "compute.record.read";

/**
 * The audit row of a read: who (the owner), what (the job and the record's name) and why. It is
 * inserted only for an account that is an owner, not deleted and in an active status, in this
 * statement, so no caller that skipped a check can write one for anyone else: `meta.changes` of 0 is
 * `not_owner`. `?1` the actor, `?2` the job, `?3` the record's name, `?4` the reason.
 */
export const RECORD_READ_AUDIT_SQL = `INSERT INTO audit_log (user_id, action, resource_type, resource_id, details)
  SELECT u.id, '${RECORD_READ_ACTION}', 'compute_job', ?2, json_object('name', ?3, 'reason', ?4)
    FROM users u
   WHERE u.id = ?1 AND u.role = 'owner' AND u.deleted_at IS NULL
     AND u.status IN (${ACTIVE_ACCOUNT_STATUSES.map((s) => `'${s}'`).join(", ")})`;

export type RecordReadResult =
  | { ok: true; kind: "bytes"; name: string; contentType: string; bytes: Uint8Array }
  | { ok: true; kind: "url"; name: string; url: string; expires_at: string }
  | {
      ok: false;
      code:
        | "not_owner"
        | "invalid_reason"
        | "invalid_record"
        | "audit_failed"
        | "record_missing"
        | "compute_disabled";
    };

/** Which bucket key a record name stands for, and how it is read; null for a name that is no record. */
function recordTarget(jobId: string, name: string): { key: string; presigned: boolean } | null {
  if (typeof name !== "string") return null;
  if ((RECORD_FILES as readonly string[]).includes(name)) {
    return { key: recordKey(jobId, name as RecordFile), presigned: false };
  }
  if (name.startsWith("submitted/")) {
    const path = name.slice("submitted/".length);
    if (filePathProblem(jobId, path) !== null) return null;
    return { key: submittedKey(jobId, path), presigned: true };
  }
  if (name.startsWith("logs/")) {
    const file = name.slice("logs/".length);
    if (!(LOG_FILES as readonly string[]).includes(file)) return null;
    return { key: logKey(jobId, file as LogFile), presigned: true };
  }
  return null;
}

/**
 * Read one record of a job: OWNER-ONLY, with a stated reason, audited first. The role is read from the
 * database in the audit statement itself (a caller that says it is an owner is not believed). The
 * reason is 8 to 200 characters once trimmed, with no control character. The audit row
 * (`compute.record.read`: who, which job and record, why) is written BEFORE the bucket is touched, and
 * the read is refused if that write fails; a read that then finds nothing still leaves its row, because
 * the attempt is what is audited. A name that is no record, and a job id that is none, are refused
 * before any row is written.
 *
 * The JSON records come back as bytes through the binding. A submitted file and a log come back as a
 * 5-minute presigned GET of that one key (the only presigned read of a record besides
 * `presignBundleRead`).
 */
export async function readRecordObject(
  env: ComputeRecordsEnv,
  db: D1Database,
  input: { actor: { id: number; role?: string }; jobId: string; name: string; reason: string },
): Promise<RecordReadResult> {
  if (input.actor.role !== undefined && input.actor.role !== "owner") {
    return { ok: false, code: "not_owner" };
  }
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (
    reason.length < RECORD_READ_REASON_MIN ||
    reason.length > RECORD_READ_REASON_MAX ||
    hasControlCharacter(reason)
  ) {
    return { ok: false, code: "invalid_reason" };
  }
  if (typeof input.jobId !== "string" || !COMPUTE_JOB_ID_RE.test(input.jobId)) {
    return { ok: false, code: "invalid_record" };
  }
  const target = recordTarget(input.jobId, input.name);
  if (!target) return { ok: false, code: "invalid_record" };
  const bucket = env.COMPUTE_RECORDS;
  const s3: ComputeS3 | null = target.presigned ? computeS3(env) : null;
  if (!bucket || (target.presigned && !s3)) return { ok: false, code: "compute_disabled" };

  // The audit row, before anything is read; its failure refuses the read.
  let changes: number;
  try {
    const result = await db
      .prepare(RECORD_READ_AUDIT_SQL)
      .bind(input.actor.id, input.jobId, input.name, reason)
      .run();
    changes = result.meta?.changes ?? 0;
  } catch {
    return { ok: false, code: "audit_failed" };
  }
  if (changes === 0) return { ok: false, code: "not_owner" };

  if (target.presigned && s3) {
    if ((await bucket.head(target.key)) === null) return { ok: false, code: "record_missing" };
    const signed = await presignGet(s3, "records", target.key, {
      expiresIn: COMPUTE_RECORD_READ_SECONDS,
    });
    return {
      ok: true,
      kind: "url",
      name: input.name,
      url: signed.url,
      expires_at: signed.expires_at,
    };
  }
  const object = await bucket.get(target.key);
  if (!object) return { ok: false, code: "record_missing" };
  return {
    ok: true,
    kind: "bytes",
    name: input.name,
    contentType: "application/json",
    bytes: new Uint8Array(await object.arrayBuffer()),
  };
}

// --- The outputs request's cap -----------------------------------------------------------------------

/**
 * The most bytes one entry of an outputs request may take in JSON: `{"path":"` and its 512 characters
 * at up to 3 bytes of UTF-8, `","size":` and a 16-digit size, `,"sha256":"` and 64 digits, `"}` and a
 * comma. It is 1,648; 1,700 holds it with room.
 */
export const OUTPUT_ENTRY_BYTES_MAX = 1700;

/** The launcher part of a request (its four files) and the braces, with room. */
const OUTPUTS_BODY_BASE_BYTES = 8192;

/** The launcher's own cap on the request it sends, which the Worker never takes below. */
const OUTPUTS_BODY_FLOOR_BYTES = 1024 * 1024;

/** What a Worker can read and parse as one JSON body: 64 MiB, under the platform's request limit. */
export const OUTPUTS_BODY_CEILING_BYTES = 64 * 1024 * 1024;

/**
 * The largest body the outputs route reads, derived from the owner's `resultLimits.maxFiles`.
 *
 * THE RECONCILIATION. The owner's policy lets `maxFiles` reach 100,000 outputs, and the launcher
 * validates its own request against a 1 MiB cap (about 8,000 ordinary entries) and fails a job over it
 * with the detail `too_many_outputs`. So the Worker does not bound `maxFiles` (that is a contract the
 * launcher's repository also holds); it derives the cap its route reads from `maxFiles`, so a body the
 * policy allows is never refused for its size: the base, plus `maxFiles` entries of the largest size one
 * entry can take, never less than the launcher's 1 MiB and never more than 64 MiB (what a Worker can
 * parse). Above about 39,470 outputs (64 MiB less the base, over 1,700 bytes an entry) the worst-case entry no longer fits the ceiling, and a body over it
 * is refused `too_many_outputs`, a refusal the submitter caused and is charged for. The launcher's own
 * 1 MiB cap is the tighter bound today, and raising it is the launcher's change.
 */
export function outputsBodyLimitBytes(maxFiles: number): number {
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > COMPUTE_MAX_OUTPUT_FILES) {
    throw new RangeError("maxFiles is a whole number from 1 to 100000");
  }
  const wanted = OUTPUTS_BODY_BASE_BYTES + maxFiles * OUTPUT_ENTRY_BYTES_MAX;
  return Math.min(OUTPUTS_BODY_CEILING_BYTES, Math.max(OUTPUTS_BODY_FLOOR_BYTES, wanted));
}
