/**
 * What a job left in the results bucket, and the verification that lets a Tapis `FINISHED` stand
 * (epic #2005 phase A5, #2010; ADR 0118; design section 7, "Results").
 *
 * The results bucket holds, for each job:
 *
 *   jobs/<id>/declared.json                   what the launcher DECLARED to the outputs route, written
 *                                             by the Worker through its binding and never by an address
 *                                             it signed (`declaredKey`)
 *   jobs/<id>/outputs/<path>                  one output, uploaded by a one-hour address the Worker signed
 *   jobs/<id>/launcher/{result,provenance,manifest}.json and launcher.log
 *                                             the launcher's own files, the same way
 *
 * NOTHING THE JOB WRITES IS TRUSTED FOR ACCOUNTING. `verifyResults` reads the launcher's documents
 * and checks them against what NEMAR itself knows (the job's id, the SHA-256 of the launch
 * specification it sent, the bundle's and the image's digests, the exit code Tapis reports), and every
 * declared output against the bucket: present, with the exact size. A SHA-256 is compared only where
 * R2 returns one (a presigned PUT without the checksum header stores none, and the header is deferred
 * until it is verified on the real R2), and the rest are counted as unverified, never as verified.
 *
 * LISTINGS, NOT HEADS. A job may declare thousands of outputs and a Worker invocation makes a bounded
 * number of subrequests, so the objects under a prefix are read with a paginated listing (1,000 to a
 * call) and compared by key and size. A listing carries what a head would, for this check.
 *
 * Every refusal is a fixed word (`VerifyReason`), stored as the job's `failure_detail` for a
 * verification failure so an administrator can see why; nothing a document or a path held is stored or
 * logged.
 */

import type { z } from "zod";
import { recipeImageDigestArg } from "../../../shared/compute-recipes.js";
import {
  type ComputeFailureCode,
  RECORDS_UNREADABLE,
  type VerifyReason,
} from "../../../shared/compute-state.js";
import { resultsLauncherKey, resultsOutputKey } from "../../../shared/contract/compute-launch.js";
import {
  COMPUTE_JOB_ID_RE,
  COMPUTE_SHA256_RE,
  type JobSpec,
  JobSpecSchema,
  LAUNCHER_FILES,
  LAUNCHER_FILE_NAMES,
  type LauncherFileName,
  LauncherProvenanceSchema,
  LauncherResultSchema,
  ResultManifestSchema,
  isSafeComputePath,
} from "../../../shared/contract/compute.js";
import type { ComputeJobRow } from "./compute-jobs.js";
import { OUTPUTS_BODY_CEILING_BYTES, recordKey, sha256Hex } from "./compute-records.js";
import type { TapisJob } from "./tapis/client.js";

// --- Keys and the declared file ------------------------------------------------------------------

/** The file the Worker keeps of what the launcher declared, under the job's prefix and outside the two prefixes it signs. */
export const DECLARED_FILE_NAME = "declared.json";

export function declaredKey(jobId: string): string {
  if (typeof jobId !== "string" || !COMPUTE_JOB_ID_RE.test(jobId)) {
    throw new RangeError("not a job id");
  }
  return `jobs/${jobId}/${DECLARED_FILE_NAME}`;
}

export interface DeclaredOutput {
  path: string;
  size: number;
  sha256: string;
}

export interface DeclaredLauncherFile {
  name: LauncherFileName;
  size: number;
}

export interface Declared {
  job_id: string;
  outputs: DeclaredOutput[];
  launcher: DeclaredLauncherFile[];
}

/**
 * The canonical text of what a request declares: outputs sorted by path and launcher files sorted by
 * name, so a replay of the same request (in any order) is the same bytes and is recognised as one.
 */
export function declaredText(
  jobId: string,
  outputs: readonly DeclaredOutput[],
  launcher: readonly DeclaredLauncherFile[],
): string {
  const byPath = [...outputs].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const byName = [...launcher].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return JSON.stringify({
    job_id: jobId,
    outputs: byPath.map((o) => ({ path: o.path, size: o.size, sha256: o.sha256 })),
    launcher: byName.map((f) => ({ name: f.name, size: f.size })),
  });
}

// --- Reading documents ---------------------------------------------------------------------------

/** A document of the results bucket: not there, there but not usable, or parsed. */
export type Doc<T> = { kind: "absent" } | { kind: "invalid" } | { kind: "ok"; value: T };

interface Parser<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

/**
 * Read one JSON object of a bucket, at most `maxBytes` (a larger object is `invalid`, and is not
 * read): its size is learned with a head first, so an object that is too large costs no memory.
 */
export async function readDoc<T>(
  bucket: R2Bucket,
  key: string,
  schema: Parser<T>,
  maxBytes: number,
): Promise<Doc<T>> {
  const head = await bucket.head(key);
  if (!head) return { kind: "absent" };
  if (head.size > maxBytes) return { kind: "invalid" };
  const object = await bucket.get(key);
  if (!object) return { kind: "absent" };
  let value: unknown;
  try {
    value = JSON.parse(await object.text());
  } catch {
    return { kind: "invalid" };
  }
  const parsed = schema.safeParse(value);
  return parsed.success ? { kind: "ok", value: parsed.data } : { kind: "invalid" };
}

/** The declared file, parsed and checked to be this job's. */
const declaredParser = (jobId: string): Parser<Declared> => ({
  safeParse(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { success: false };
    }
    const v = value as Record<string, unknown>;
    if (v.job_id !== jobId || !Array.isArray(v.outputs) || !Array.isArray(v.launcher)) {
      return { success: false };
    }
    for (const o of v.outputs as Array<Record<string, unknown>>) {
      if (
        typeof o !== "object" ||
        o === null ||
        typeof o.path !== "string" ||
        !isSafeComputePath(o.path, 512) ||
        typeof o.size !== "number" ||
        !Number.isSafeInteger(o.size) ||
        o.size < 0 ||
        typeof o.sha256 !== "string" ||
        !COMPUTE_SHA256_RE.test(o.sha256)
      ) {
        return { success: false };
      }
    }
    for (const f of v.launcher as Array<Record<string, unknown>>) {
      if (
        typeof f !== "object" ||
        f === null ||
        !(LAUNCHER_FILE_NAMES as readonly string[]).includes(f.name as string) ||
        typeof f.size !== "number" ||
        !Number.isSafeInteger(f.size) ||
        f.size < 0
      ) {
        return { success: false };
      }
    }
    return { success: true, data: value as Declared };
  },
});

/** The job's declared file: `absent` until the outputs route has accepted a request. */
export async function readDeclared(results: R2Bucket, jobId: string): Promise<Doc<Declared>> {
  return readDoc(results, declaredKey(jobId), declaredParser(jobId), OUTPUTS_BODY_CEILING_BYTES);
}

/** What a listing says of one object. */
export interface ListedObject {
  size: number;
  /** The SHA-256 R2 returned for the object, lowercase hex, only where it returned one. */
  sha256: string | null;
}

/** The objects under a prefix, by key (a listing is one subrequest for every 1,000 objects). */
export async function listObjects(
  bucket: R2Bucket,
  prefix: string,
): Promise<Map<string, ListedObject>> {
  const found = new Map<string, ListedObject>();
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, cursor });
    for (const object of listed.objects) {
      const checksum = (object as { checksums?: { sha256?: ArrayBuffer } }).checksums?.sha256;
      found.set(object.key, {
        size: object.size,
        sha256: checksum ? hexOf(new Uint8Array(checksum)) : null,
      });
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return found;
}

function hexOf(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += (bytes[i] as number).toString(16).padStart(2, "0");
  return out;
}

// --- What is missing -----------------------------------------------------------------------------

/**
 * The first declared object that is not in the bucket with its exact size, or null when every one is:
 * the outputs and the four launcher files. `missing` is for an object that is not there at all, and
 * `short` for one whose size is not the declared one. Listings only (see the header).
 */
export async function firstIncomplete(
  results: R2Bucket,
  declared: Declared,
): Promise<{ kind: "missing" | "short" } | null> {
  const outputs = await listObjects(results, `jobs/${declared.job_id}/outputs/`);
  for (const o of declared.outputs) {
    const there = outputs.get(resultsOutputKey(declared.job_id, o.path));
    if (!there) return { kind: "missing" };
    if (there.size !== o.size) return { kind: "short" };
  }
  const launcher = await listObjects(results, `jobs/${declared.job_id}/launcher/`);
  for (const f of declared.launcher) {
    const there = launcher.get(resultsLauncherKey(declared.job_id, f.name));
    if (!there) return { kind: "missing" };
    if (there.size !== f.size) return { kind: "short" };
  }
  return null;
}

// --- The launcher's documents --------------------------------------------------------------------

/** The bytes a launcher document may take: the outputs body's own bound, never below 1 MiB. */
export type LauncherDocumentLimit = number;

export interface LauncherDocs {
  result: Doc<z.infer<typeof LauncherResultSchema>>;
  provenance: Doc<z.infer<typeof LauncherProvenanceSchema>>;
  manifest: Doc<z.infer<typeof ResultManifestSchema>>;
}

/** The three launcher documents, parsed with the contract's own schemas. */
export async function readLauncherDocs(
  results: R2Bucket,
  jobId: string,
  limit: LauncherDocumentLimit,
): Promise<LauncherDocs> {
  const [result, provenance, manifest] = await Promise.all([
    readDoc(results, resultsLauncherKey(jobId, LAUNCHER_FILES.result), LauncherResultSchema, limit),
    readDoc(
      results,
      resultsLauncherKey(jobId, LAUNCHER_FILES.provenance),
      LauncherProvenanceSchema,
      limit,
    ),
    readDoc(
      results,
      resultsLauncherKey(jobId, LAUNCHER_FILES.manifest),
      ResultManifestSchema,
      limit,
    ),
  ]);
  return { result, provenance, manifest };
}

// --- The exit code Tapis reports ------------------------------------------------------------------

/**
 * The exit code Tapis reports for the job, from the job record's `remoteResultInfo` (the documentation
 * says it carries the exit code of the application; UNVERIFIED against a real tenant), or null when it
 * says none. The cross-check against the launcher's `exit_number` is defence in depth: a launcher that
 * wrote a result no run of its own produced is caught here as well as by the digests.
 */
export function tapisExitCode(rec: TapisJob): number | null {
  const raw = (rec as { remoteResultInfo?: unknown }).remoteResultInfo;
  if (typeof raw === "number" && Number.isInteger(raw)) return raw;
  if (typeof raw === "string" && /^-?[0-9]{1,4}$/.test(raw.trim())) return Number(raw.trim());
  return null;
}

// --- verifyResults --------------------------------------------------------------------------------

export type VerifyResult =
  | { ok: true }
  | {
      ok: false;
      /** `result_upload_failed` when the launcher never completed; the platform's own code otherwise. */
      code: Extract<
        ComputeFailureCode,
        "result_upload_failed" | "result_verification_failed" | "records_unavailable"
      >;
      reason: VerifyReason | typeof RECORDS_UNREADABLE;
      /** The launcher's documents disagreed with what NEMAR knows: an administrator looks. */
      mismatch: boolean;
    };

const fail = (
  code: "result_upload_failed" | "result_verification_failed" | "records_unavailable",
  reason: VerifyReason | typeof RECORDS_UNREADABLE,
  mismatch = false,
): VerifyResult => ({ ok: false, code, reason, mismatch });

/** The job's recorded specification, parsed, and only if it is the bytes whose digest the row holds. */
export async function readRecordedSpec(
  records: R2Bucket,
  job: Pick<ComputeJobRow, "id" | "spec_digest">,
): Promise<JobSpec | null> {
  const object = await records.get(recordKey(job.id, "spec.json"));
  if (!object) return null;
  const bytes = new Uint8Array(await object.arrayBuffer());
  if ((await sha256Hex(bytes)) !== job.spec_digest) return null;
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  const parsed = JobSpecSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Verify a job whose Tapis status is `FINISHED` before it may be `finished`. Never throws for what a
 * document holds: a refusal is a fixed word. `limit` is the byte bound for one launcher document.
 *
 * In order: the launcher completed (`outputs_completed_at`); the three documents exist and parse; each
 * carries this job's id; the provenance's `launch_spec_digest` is the one NEMAR stored before it
 * submitted (the launcher hashed the text it decoded from the value it received, so a launcher that
 * ran another specification differs); its `bundle_digest` is the specification's bundle (null when
 * there is none) and its image digest is the job's; the result reports no failure and its exit
 * number is the one Tapis reports (when Tapis reports one); the manifest is exactly what was
 * declared; every declared output is in the bucket with the exact size; and the four launcher files
 * are as declared. A job that names a recipe passes its image digest as an argument, and that value
 * (read from the recorded specification) must be the digest the provenance says the launcher ran.
 */
export async function verifyResults(
  results: R2Bucket,
  records: R2Bucket,
  job: ComputeJobRow,
  rec: TapisJob,
  limit: LauncherDocumentLimit,
): Promise<VerifyResult> {
  if (job.outputs_completed_at === null) return fail("result_upload_failed", "not_completed");

  const declared = await readDeclared(results, job.id);
  if (declared.kind !== "ok") return fail("result_verification_failed", "declared_missing");

  const docs = await readLauncherDocs(results, job.id, limit);
  if (docs.result.kind !== "ok") return fail("result_verification_failed", "result_missing");
  if (docs.provenance.kind !== "ok")
    return fail("result_verification_failed", "provenance_missing");
  if (docs.manifest.kind !== "ok") return fail("result_verification_failed", "manifest_missing");
  const result = docs.result.value;
  const provenance = docs.provenance.value;
  const manifest = docs.manifest.value;

  if (result.job_id !== job.id || provenance.job_id !== job.id || manifest.job_id !== job.id) {
    return fail("result_verification_failed", "job_id_mismatch", true);
  }
  if (job.launch_spec_digest === null || provenance.launch_spec_digest !== job.launch_spec_digest) {
    return fail("result_verification_failed", "launch_digest_mismatch", true);
  }

  const spec = await readRecordedSpec(records, job);
  if (spec === null) return fail("records_unavailable", RECORDS_UNREADABLE);
  if (provenance.bundle_digest !== (spec.bundle?.sha256 ?? null)) {
    return fail("result_verification_failed", "bundle_digest_mismatch", true);
  }
  if (job.image_digest !== null && provenance.image.digest !== job.image_digest) {
    return fail("result_verification_failed", "image_digest_mismatch", true);
  }
  // A recipe job passes its image digest as an ARGUMENT (the launch specification's environment has no
  // name for one), and the recipe cannot check that claim against the image it runs in. So the value the
  // job passed, read from the recorded specification, must be the digest the launcher says it ran; no
  // value, a malformed one, or two of them fail closed (nemar-process C3 review, 2026-11-05).
  if (spec.recipe !== undefined && recipeImageDigestArg(spec.args) !== provenance.image.digest) {
    return fail("result_verification_failed", "image_digest_mismatch", true);
  }

  if (result.failure_code !== null)
    return fail("result_verification_failed", "result_reports_failure");
  const tapisExit = tapisExitCode(rec);
  if (tapisExit !== null && tapisExit !== result.exit_number) {
    return fail("result_verification_failed", "exit_mismatch", true);
  }

  // The manifest the launcher uploaded is what it declared to the outputs route.
  const declaredByPath = new Map(declared.value.outputs.map((o) => [o.path, o]));
  if (manifest.files.length !== declaredByPath.size) {
    return fail("result_verification_failed", "manifest_mismatch", true);
  }
  for (const f of manifest.files) {
    const d = declaredByPath.get(f.path);
    if (!d || d.size !== f.size || d.sha256 !== f.sha256) {
      return fail("result_verification_failed", "manifest_mismatch", true);
    }
  }

  // Size always; the SHA-256 too, but ONLY where R2 returned one for the object. A presigned upload
  // carries no checksum unless the launcher sends one, so an output without one is verified by size
  // alone (UNVERIFIED in the ADR: whether R2 returns a SHA-256 on a listing for the launcher's uploads).
  // Nothing counts how many were size-only: a count nobody reads is not a record.
  const outputs = await listObjects(results, `jobs/${job.id}/outputs/`);
  for (const o of declared.value.outputs) {
    const there = outputs.get(resultsOutputKey(job.id, o.path));
    if (!there) return fail("result_verification_failed", "output_missing");
    if (there.size !== o.size) return fail("result_verification_failed", "output_size_mismatch");
    if (there.sha256 !== null && there.sha256 !== o.sha256) {
      return fail("result_verification_failed", "output_checksum_mismatch", true);
    }
  }

  const launcher = await listObjects(results, `jobs/${job.id}/launcher/`);
  for (const f of declared.value.launcher) {
    const there = launcher.get(resultsLauncherKey(job.id, f.name));
    if (!there || there.size !== f.size) {
      return fail("result_verification_failed", "launcher_file_missing");
    }
  }
  return { ok: true };
}
