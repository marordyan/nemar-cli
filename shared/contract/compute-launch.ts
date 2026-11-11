/**
 * The launch specification `nemar.launch-spec.v1` and the launcher's routes (epic #2005 phase A1,
 * #2006; ADR 0118): the one document NEMAR's Worker hands the launcher on the node, in the
 * environment variable `NEMAR_LAUNCH_SPEC` (as base64url text, see below), and the three shapes the
 * launcher exchanges with the Worker, distinct from the user-facing job specification in `./compute.ts`.
 *
 * THE JSON SCHEMA NEXT TO THIS FILE IS SHARED BYTE FOR BYTE with `nemarOrg/nemar-process`
 * (`launcher/schema/launch-spec.v1.json`), where the launcher is written. The launcher cannot
 * import this file, so `compute-launch.schema.json` is the contract both sides check against, and
 * `test/compute-contract.unit.test.ts` holds the two to each other: the schema's keys and
 * enumerations are read back against these constants, and a differential corpus is judged by both.
 * Whichever repository's phase merges first writes the file; the other copies it, never edits it.
 *
 * REQUESTS AND DOCUMENTS ARE CLOSED, RESPONSES ARE OPEN. Like `./compute.ts`, this file is strict
 * on purpose and exempted by name in `test/contract-schemas.test.ts`: the Worker writes the launch
 * specification and the launcher's own files, and the outputs request is validated as it arrives,
 * so an unknown key in any of them is a bug to refuse rather than strip. The two RESPONSES the
 * launcher reads (`BundleResponseSchema`, `OutputsResponseSchema`) are `.passthrough()`: a launcher
 * can run for 48 hours and must survive the Worker adding a key. Never parse a response with a
 * strict schema, and never build a response schema from one (`.extend()`, `.pick()`); the
 * classification test in `test/contract-schemas.test.ts` checks both by behaviour.
 *
 * ON THE WIRE THE DOCUMENT IS BASE64URL (A1c, #2043; ADR 0118). The document is canonical, compact,
 * printable-ASCII JSON text (`encodeLaunchSpec`: every byte 0x20 to 0x7e); it travels as the
 * environment value `NEMAR_LAUNCH_SPEC` in the shell-inert alphabet `A-Za-z0-9-_`: the text's bytes
 * in base64url (Request for Comments (RFC) 4648 section 5), no padding, no line break, and canonical,
 * which is one value per text (`encodeLaunchSpecEnv`, and `decodeLaunchSpecEnv`, whose rules and
 * order of checks the launcher's decoder must follow). Compact JSON is not shell-inert: its quotes,
 * braces and any `$`, backtick, `;` or `&` in a user string are special to a shell that sources an
 * environment file. The scheduler is read as writing an environment value into such a file and
 * quoting it only conditionally (that reading is UNVERIFIED; see the unverified lists in ADR 0118 and
 * the implementation notes), so the value carries no character a shell treats as special. The JSON
 * text, its 64 KiB cap and both digests (`spec_digest`, `launch_spec_digest`) are over the TEXT and
 * are unchanged: a digest is never over the encoded value. What a scheduler does with a value is not
 * part of this contract and is not claimed here; the alphabet is what makes the answer irrelevant.
 *
 * What the launch specification does NOT carry, on purpose: a URL for the code bundle (the
 * launcher asks the Worker for a presigned address with `job_token`), any storage credential, and
 * the user's identity. The token travels in a header, never a URL.
 *
 * THE LAUNCHER MUST RUN THE CONTAINER WITH A CLEAN ENVIRONMENT (`--cleanenv`, and only the job's
 * allowlisted names passed in), so that `NEMAR_LAUNCH_SPEC`, which holds `job_token`, and every
 * other variable of the launcher's own never reach the user's code. `nemar-process` requires it;
 * this records the requirement where the contract is.
 *
 * On the node, under Tapis's output directory: the container's one writable mount is `work/`, with
 * its outputs in `work/outputs/<path>`; the directory `launcher/` is never mounted into it and
 * holds `result.json`, `provenance.json`, `manifest.json` and `launcher.log`. In the results
 * bucket the launcher uploads, by presigned URL, to `jobs/<id>/outputs/<path>` and to
 * `jobs/<id>/launcher/<file>`. Exit numbers: 0, and 10 to 16 for the seven launcher failure codes
 * of `shared/compute-state.ts` in their order.
 */

import { z } from "zod";
import {
  COMPUTE_ARGS_DESCRIPTION,
  COMPUTE_COMMAND_DESCRIPTION,
  COMPUTE_DATASET_ID_RE,
  COMPUTE_DATA_TAG_MAX,
  COMPUTE_DATA_TAG_RE,
  COMPUTE_DOT_SEGMENT_RE,
  COMPUTE_ENTRY_DESCRIPTION,
  COMPUTE_IMAGE_DIGEST_RE,
  COMPUTE_IMAGE_REF_RE,
  COMPUTE_INCLUDE_DESCRIPTION,
  COMPUTE_JOB_ID_RE,
  COMPUTE_MAX_OUTPUT_FILES,
  COMPUTE_PATH_SEGMENT,
  COMPUTE_SHA256_RE,
  JOB_ENV_ALLOWLIST,
  type JobSpec,
  LAUNCHER_FILE_NAMES,
  type LauncherFileName,
  computeEnvValueSchema,
  computeGlobSchema,
  computePathSchema,
  computeSafeInt,
  dataTagForVersion,
  isSafeComputePath,
} from "./compute.js";

/** The name of the schema, and of the document's contract. */
export const LAUNCH_SPEC_VERSION = "nemar.launch-spec.v1";

/** The launcher reads at most this many bytes of the specification (the JSON text, decoded). */
export const LAUNCH_SPEC_MAX_BYTES = 64 * 1024;

/**
 * The longest `NEMAR_LAUNCH_SPEC` value: base64url without padding spends `ceil(n * 4 / 3)`
 * characters on `n` bytes, so the JSON cap above becomes 87,382 (65,536 bytes is 21,845 groups of
 * three plus one byte, which is 87,380 characters plus two). Declared once; it is also the longest
 * value `decodeLaunchSpecEnv` reads, and the decoded text of such a value is exactly
 * {@link LAUNCH_SPEC_MAX_BYTES}.
 */
export const LAUNCH_SPEC_ENV_MAX_CHARS = Math.ceil((LAUNCH_SPEC_MAX_BYTES * 4) / 3);

/**
 * The shell-inert alphabet of an environment value, in Request for Comments (RFC) 4648 section 5
 * order: the 64 base64url characters. A value made only of these holds none of the characters a
 * conditional quoter quotes for, and nothing a shell acts on: none is special to a shell, to a glob
 * or to a quoting rule. The one place the alphabet is written down in the code, and a WIRE CONTRACT
 * with the launcher in nemar-process: both repositories' tests pin this string.
 */
export const SHELL_INERT_ENV_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** The characters of {@link SHELL_INERT_ENV_ALPHABET}, for lookup: derived from it, not a second copy. */
const SHELL_INERT_ENV_CHARS: ReadonlySet<string> = new Set(SHELL_INERT_ENV_ALPHABET);

/**
 * Whether an environment value is non-empty and made only of the characters of
 * {@link SHELL_INERT_ENV_ALPHABET} (so an empty value, padding, a newline and every character of a JSON
 * document but letters, digits, `-` and `_` are false). Built from that constant, not from a second
 * copy of the alphabet. It says the value is safe for a shell; whether it is a launch specification
 * is {@link decodeLaunchSpecEnv}'s question. Pure; never throws.
 */
export function isShellInertEnvValue(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  for (const ch of value) {
    if (!SHELL_INERT_ENV_CHARS.has(ch)) return false;
  }
  return true;
}

/**
 * `python` runs NEMAR's runtime image and `image` runs the submitter's own. MATLAB is refused
 * before a launch specification is built; a document that names it is outside this schema, which
 * the launcher reports as `runtime_error` with the detail `unsupported_runtime`.
 */
export const LAUNCH_RUNTIMES = ["python", "image"] as const;

const safeInt = computeSafeInt;
const relativePath = computePathSchema;

const API_BASE_RE = /^https?:\/\/[^\s/?#][^\s?#]*$/;
const URL_RE = /^https?:\/\/[^\s]+$/;
const JOB_TOKEN_RE = /^[A-Za-z0-9_-]{16,256}$/;

/**
 * The header the launcher sends its per-job token in, to the bundle, outputs and complete routes (never a
 * URL). A WIRE CONTRACT with the launcher in nemar-process: changing the word breaks every launcher, so
 * it is declared once, here, and `compute-contract.unit.test.ts` pins its spelling.
 */
export const COMPUTE_JOB_TOKEN_HEADER = "X-Compute-Job-Token";
/**
 * The Singularity image file on the node: exactly `<64 lowercase hex>.sif`, a basename with no
 * directory, relative to `NEMAR_SIF_ROOT` (`LAUNCHER_ENV.SIF_ROOT`). It is the file name of the SIF
 * built from the image's digest, so it is also the digest's hex plus `.sif`: see
 * {@link sifFileNameForDigest}.
 */
const SIF_FILE_RE = /^[0-9a-f]{64}\.sif$/;
/** What the entry and command descriptions add in the launch specification. */
const EXACTLY_ONE = " Exactly one of entry and command is present.";
const SIF_FORM_MESSAGE = "the image file is not <64 lowercase hex>.sif";
const SIF_NAMED_MESSAGE = "the image file is not the one named for the image digest";
const IMAGE_REF_FORM_MESSAGE = "the image reference is not a digest-pinned reference";
const IMAGE_REF_NAMED_MESSAGE = "the image reference is not pinned to the image digest";
/** UTC, as the presigning calls write it; the shape is checked, not the calendar. */
const TIMESTAMP_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?Z$/;
/** Where an upload goes under `jobs/<id>/`: an output, or one of the four launcher files. */
const UPLOAD_PATH_RE = new RegExp(
  `^(?:outputs/(?:${COMPUTE_PATH_SEGMENT}/)*${COMPUTE_PATH_SEGMENT}|launcher/(?:${LAUNCHER_FILE_NAMES.map((n) => n.replace(".", "\\.")).join("|")}))$`,
);

const launchEnvSchema = z
  .object(
    Object.fromEntries(
      JOB_ENV_ALLOWLIST.map((name) => [name, computeEnvValueSchema.optional()]),
    ) as {
      [K in (typeof JOB_ENV_ALLOWLIST)[number]]: z.ZodOptional<typeof computeEnvValueSchema>;
    },
  )
  .strict();

/**
 * The launch specification. Every key but `entry`, `command` and `bundle` is required, so the
 * Worker writes an explicit document and the launcher never has to guess a default; exactly one of
 * `entry` and `command` is present, and an `entry` comes with the `bundle` that holds it. No
 * unknown key is accepted, at any level.
 */
export const LaunchSpecSchema = z
  .object({
    /** The NEMAR job id, which is also the prefix of the job's keys. */
    job_id: z.string().regex(COMPUTE_JOB_ID_RE),
    runtime: z.enum(LAUNCH_RUNTIMES),
    entry: relativePath(240)
      .optional()
      .describe(COMPUTE_ENTRY_DESCRIPTION + EXACTLY_ONE),
    command: z
      .array(z.string().min(1).max(1024))
      .min(1)
      .max(64)
      .optional()
      .describe(COMPUTE_COMMAND_DESCRIPTION + EXACTLY_ONE),
    args: z.array(z.string().max(1024)).max(64).describe(COMPUTE_ARGS_DESCRIPTION),
    /** The archive's own digest and size; the launcher is given no URL and asks the Worker. */
    bundle: z
      .object({ sha256: z.string().regex(COMPUTE_SHA256_RE), size: safeInt(1) })
      .strict()
      .optional(),
    datasets: z
      .array(
        z
          .object({
            id: z.string().regex(COMPUTE_DATASET_ID_RE),
            /**
             * The data-plane tag: `latest` or `v<major>.<minor>.<patch>`. A job names a version more
             * loosely (`1.0.2`); the Worker writes the tag with `dataTagForVersion` (`1.0.2` becomes
             * `v1.0.2`) and refuses a job whose version has none, naming `datasetVersionWithoutTag`'s
             * field, before the hold.
             */
            version: z.string().max(COMPUTE_DATA_TAG_MAX).regex(COMPUTE_DATA_TAG_RE),
            include: z
              .array(computeGlobSchema)
              .max(64)
              .optional()
              .describe(COMPUTE_INCLUDE_DESCRIPTION),
          })
          .strict(),
      )
      .max(20),
    /** The NEMAR API the launcher calls with `job_token`: no query, no fragment. */
    api_base: z.string().max(512).regex(API_BASE_RE),
    image: z
      .object({
        /**
         * A digest-pinned reference, as a job's own `image` is: no leading `-`, no control character.
         * The `@sha256:<hex>` it ends with is the one in `digest`: a rule the JSON Schema cannot
         * express and the refinement below enforces, because `digest` names the file that runs and
         * the provenance records it as the image's.
         */
        uri: z.string().max(512).regex(COMPUTE_IMAGE_REF_RE, IMAGE_REF_FORM_MESSAGE),
        digest: z.string().regex(COMPUTE_IMAGE_DIGEST_RE),
        /**
         * The Singularity image file the launcher runs: `<64 lowercase hex>.sif`, a basename relative
         * to `NEMAR_SIF_ROOT`, which the launcher requires (it has no fallback and ends
         * `image_missing` when it is unset). The hex is the one in `digest`: a rule the JSON Schema
         * cannot express and the refinement below enforces (NEMAR's encoder refuses a document that
         * breaks it, so every launch specification NEMAR hands the launcher satisfies it). The file's
         * content hash is NOT verified by the launcher: the name is all that ties the file to the
         * digest.
         */
        sif: z.string().regex(SIF_FILE_RE, SIF_FORM_MESSAGE),
      })
      .strict(),
    env: launchEnvSchema,
    resources: z.object({ gpus: safeInt(0, 8) }).strict(),
    limits: z.object({ max_files: safeInt(1, 1_000_000), max_total_bytes: safeInt(1) }).strict(),
    /** The per-job token, sent in `X-Compute-Job-Token` to the bundle, outputs and complete routes. */
    job_token: z.string().regex(JOB_TOKEN_RE),
  })
  .strict()
  .superRefine((spec, ctx) => {
    const refuse = (path: string, message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    if ((spec.entry === undefined) === (spec.command === undefined)) {
      refuse("entry", "exactly one of entry and command");
    }
    if (spec.entry !== undefined && spec.bundle === undefined) {
      refuse("bundle", "an entry needs the bundle that holds it");
    }
    // Each cross rule only when both its fields are well formed, so the field issues are not doubled.
    const named = sifFileNameForDigest(spec.image.digest);
    if (named !== null && SIF_FILE_RE.test(spec.image.sif) && spec.image.sif !== named) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["image", "sif"],
        message: SIF_NAMED_MESSAGE,
      });
    }
    if (
      named !== null &&
      COMPUTE_IMAGE_REF_RE.test(spec.image.uri) &&
      !spec.image.uri.endsWith(spec.image.digest)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["image", "uri"],
        message: IMAGE_REF_NAMED_MESSAGE,
      });
    }
  });

export type LaunchSpec = z.infer<typeof LaunchSpecSchema>;

/**
 * The file name of the SIF built from an image digest: `<the 64 hex of "sha256:<hex>">.sif`, or null
 * for anything that is not such a digest. It is the one rule that ties `image.sif` to
 * `image.digest`, which a JSON Schema cannot express: the Worker builds `image.sif` with it, and
 * `LaunchSpecSchema` refuses a document where the two disagree. Pure.
 */
export function sifFileNameForDigest(digest: string): string | null {
  if (typeof digest !== "string" || !COMPUTE_IMAGE_DIGEST_RE.test(digest)) return null;
  return `${digest.slice("sha256:".length)}.sif`;
}

/**
 * Every UTF-16 code unit at or above U+007F as a lowercase `\uXXXX` escape. JSON allows non-ASCII
 * only inside strings, so the result is the same document in plain ASCII; a character outside the
 * Basic Multilingual Plane becomes its two surrogate escapes.
 */
function asciiOnly(json: string): string {
  return json.replace(/[\u007f-\uffff]/g, (c) => {
    return `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}

/**
 * The text for `NEMAR_LAUNCH_SPEC`: the specification validated, as printable-ASCII JSON (JSON
 * escapes the control bytes and `asciiOnly` the rest, so every byte is 0x20 to 0x7e), within 64 KiB.
 * The size is checked AFTER escaping, because that is what the launcher reads and the digest
 * covers; a non-ASCII character costs six bytes. Keys follow the
 * schema's order and there is no whitespace, so one document is one text. Throws TypeError (naming
 * the failing keys, never a value, since the document holds a token) for a document that is not
 * valid and RangeError for one over the size the launcher reads.
 */
export function encodeLaunchSpec(spec: unknown): string {
  const parsed = LaunchSpecSchema.safeParse(spec);
  if (!parsed.success) {
    const keys = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(document)"))];
    throw new TypeError(`not a valid launch specification: ${keys.join(", ")}`);
  }
  const text = asciiOnly(JSON.stringify(parsed.data));
  if (text.length > LAUNCH_SPEC_MAX_BYTES) {
    throw new RangeError("the launch specification is over 64 KiB");
  }
  return text;
}

/**
 * Every UTF-16 unit of the text is a printable ASCII character: 0x20 (space) to 0x7e (tilde). No
 * control byte, not DEL (0x7f), nothing from 0x80 up. The launch specification's JSON text always is
 * (`encodeLaunchSpec` escapes the rest), and the decoded text of a value has to be.
 */
function isPrintable(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit < 0x20 || unit > 0x7e) return false;
  }
  return true;
}

/**
 * The value of `NEMAR_LAUNCH_SPEC`: what {@link encodeLaunchSpecEnv} returns and the only thing the Tapis
 * client is given to send. A branded string, so the launch specification's TEXT (which is hashed and
 * recorded, and holds the token in the clear) cannot be SENT AS THE VALUE: a plain string is not
 * assignable to this type, and the compiler says so.
 *
 * The brand works in ONE direction. The value is still a string, so the reverse mistake compiles: it
 * can be passed where the text belongs, encoded again or hashed in place of the text. The compiler
 * does not catch that; verification does. A digest over the value is not the launcher's digest of the
 * decoded text, so the job fails closed at verification, and the digest and verify tests fail. No
 * production code mixes them, and a second brand for the text was weighed and not added.
 */
export type LaunchSpecEnvValue = string & { readonly __brand: "LaunchSpecEnv" };

/** The base64url text, without padding, of a string of bytes (one per UTF-16 unit, each below 0x100). */
function toBase64Url(bytes: string): string {
  return btoa(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The `NEMAR_LAUNCH_SPEC` value for a launch specification's text (the string
 * {@link encodeLaunchSpec} returns): its bytes in base64url without padding, nothing but the
 * {@link SHELL_INERT_ENV_ALPHABET}, and so at most {@link LAUNCH_SPEC_ENV_MAX_CHARS} characters,
 * which is the 64 KiB cap's own arithmetic (a test pins it at both ends). This is what the Worker
 * puts in the scheduler request; the text, not this value, is what is hashed and recorded. The text
 * is taken as the one thing the digests are over, rather than the specification again, so the
 * Worker validates and escapes once and the bytes it hashes are the bytes it encodes.
 *
 * Every refusal is a fixed message that holds no part of the text, which holds a token. Throws
 * TypeError for text that is not a string, is empty, or has a byte outside 0x20 to 0x7e (a control
 * byte, DEL, or anything from 0x80 up), and RangeError for text over the 64 KiB cap. The inverse of
 * {@link decodeLaunchSpecEnv}.
 */
export function encodeLaunchSpecEnv(text: string): LaunchSpecEnvValue {
  if (typeof text !== "string" || text.length === 0) {
    throw new TypeError("the launch specification text is not a non-empty string");
  }
  if (text.length > LAUNCH_SPEC_MAX_BYTES) {
    throw new RangeError("the launch specification is over 64 KiB");
  }
  if (!isPrintable(text)) {
    throw new TypeError("the launch specification text is not printable ASCII");
  }
  // No second check of the length: `ceil(n * 4 / 3)` of a text within the cap is within the bound.
  return toBase64Url(text) as LaunchSpecEnvValue;
}

/** Why {@link decodeLaunchSpecEnv} refused a value: a fixed word, never a part of the value. */
export const LAUNCH_SPEC_ENV_REFUSALS = [
  "empty",
  "too_long",
  "not_base64url",
  "bad_length",
  "not_printable",
] as const;
export type LaunchSpecEnvRefusal = (typeof LAUNCH_SPEC_ENV_REFUSALS)[number];

/**
 * The text a `NEMAR_LAUNCH_SPEC` value carries, or the reason it is not one. STRICT, and one answer
 * for every value: the checks run in this order, and the first to fail names the refusal.
 *
 *  1. the value is a string, else `not_base64url` (an unset environment variable is not a string,
 *     and is refused the same way);
 *  2. it is not empty, else `empty`;
 *  3. it is at most {@link LAUNCH_SPEC_ENV_MAX_CHARS} characters, else `too_long` (the unit is
 *     characters of the value, UTF-16 code units in this reference; for every ACCEPTED value that is
 *     also its length in bytes, because an accepted value is ASCII);
 *  4. it is made only of the {@link SHELL_INERT_ENV_ALPHABET}, else `not_base64url` (so no padding,
 *     no `+` or `/`, no whitespace or line break; a raw JSON document, which starts with `{`, is
 *     refused here: nothing is registered with a tenant, so no earlier format is accepted);
 *  5. its length is not 1 modulo 4, else `bad_length`;
 *  6. the `=` padding is added back to a multiple of four (one sign for a length of 3 modulo 4, two
 *     for 2 modulo 4; a length of 1 modulo 4 was refused in step 5) and the value is decoded; the
 *     bytes are all printable ASCII, 0x20 to 0x7e (no control byte, not DEL, and nothing from 0x80
 *     up), else `not_printable`;
 *  7. it is CANONICAL, else `not_base64url`: encoding the decoded text again gives the value back,
 *     so the unused trailing bits of its last character are zero and there is one value per text.
 *
 * A value with a character outside ASCII can never be accepted, and languages count a length in
 * different units (UTF-16 code units, code points, bytes), so for such a value `too_long` and
 * `not_base64url` are BOTH conforming answers. A conformance comparison with the launcher checks
 * accept or refuse for every value, and the word only for ASCII values.
 *
 * The caller then parses the text as JSON; a launcher hashes the TEXT before it does. Pure; never
 * throws, and a refusal is a word that holds no part of the value.
 */
export function decodeLaunchSpecEnv(
  value: string,
): { ok: true; text: string } | { ok: false; reason: LaunchSpecEnvRefusal } {
  const refuse = (reason: LaunchSpecEnvRefusal) => ({ ok: false as const, reason });
  if (typeof value !== "string") return refuse("not_base64url");
  if (value.length === 0) return refuse("empty");
  if (value.length > LAUNCH_SPEC_ENV_MAX_CHARS) return refuse("too_long");
  if (!isShellInertEnvValue(value)) return refuse("not_base64url");
  if (value.length % 4 === 1) return refuse("bad_length");
  const standard = value.replace(/-/g, "+").replace(/_/g, "/");
  // The padding is restored as step 6 says. `atob` would take the value without it, but a decoder that
  // does not forgive (Python's `b64decode` says "Incorrect padding") needs it, so the rule is stated
  // and tested by its outcome, which the launcher has to reach.
  const binary = atob(standard.padEnd(standard.length + ((4 - (standard.length % 4)) % 4), "="));
  if (!isPrintable(binary)) return refuse("not_printable");
  if (toBase64Url(binary) !== value) return refuse("not_base64url");
  return { ok: true, text: binary };
}

/**
 * Whether a job specification, once a Worker has added everything it supplies, encodes within the
 * 64 KiB the launcher reads (and so within {@link LAUNCH_SPEC_ENV_MAX_CHARS} once it is the
 * environment value), with each dataset version written as its data-plane tag
 * ({@link dataTagForVersion}); a job whose dataset version has no tag is false. The Worker's fields
 * are taken at their worst case (a 512-character `api_base` and image reference, a 256-character
 * token, the 68-character image file name, the largest bundle and limits), so a true answer holds
 * whatever the Worker puts there.
 *
 * A valid job specification always fits the 64 KiB and is well formed; the dataset version tag is
 * the one launch rule JobSpecSchema does not enforce, so the Worker and the CLI must run
 * `launchSpecFits` (and refuse with `invalid_spec`, naming the field {@link datasetVersionWithoutTag}
 * finds) BEFORE the hold. It also catches a specification built some other way. Pure; never throws.
 */
export function launchSpecFits(job: JobSpec): boolean {
  const hex = "f".repeat(64);
  const uri = `docker://ghcr.io/${"a".repeat(512 - "docker://ghcr.io/".length - "@sha256:".length - 64)}@sha256:${hex}`;
  const worst: Record<string, unknown> = {
    job_id: `job_${"f".repeat(24)}`,
    runtime: job.runtime === "image" ? "image" : "python",
    args: job.args,
    bundle: { sha256: hex, size: Number.MAX_SAFE_INTEGER },
    // A version with no data-plane tag is null here, which the document refuses: not launchable.
    datasets: job.datasets.map((d) => ({
      id: d.id,
      version: dataTagForVersion(d.version),
      include: d.include,
    })),
    api_base: `https://${"a".repeat(504)}`,
    image: { uri, digest: `sha256:${hex}`, sif: `${hex}.sif` },
    env: job.env,
    resources: { gpus: job.gpus },
    limits: { max_files: 1_000_000, max_total_bytes: Number.MAX_SAFE_INTEGER },
    job_token: "t".repeat(256),
  };
  if (job.entry !== undefined) worst.entry = job.entry;
  else worst.command = job.command ?? ["x"];
  try {
    encodeLaunchSpec(worst);
    return true;
  } catch {
    return false;
  }
}

// --- The routes the launcher calls -------------------------------------------------------------

const urlSchema = z.string().max(4096).regex(URL_RE);
const timestampSchema = z.string().regex(TIMESTAMP_RE);

/**
 * `POST <api_base>/compute/jobs/<id>/bundle`: a short-lived presigned GET of the job's archive.
 * A response, so open: a reader ignores keys it does not know.
 */
export const BundleResponseSchema = z
  .object({ url: urlSchema, expires_at: timestampSchema })
  .passthrough();

/**
 * `POST <api_base>/compute/jobs/<id>/outputs`: every output with its size and checksum, and the
 * sizes of the four launcher files, each named once.
 */
export const OutputsRequestSchema = z
  .object({
    outputs: z
      .array(
        z
          .object({
            path: relativePath(512),
            size: safeInt(0),
            sha256: z.string().regex(COMPUTE_SHA256_RE),
          })
          .strict(),
      )
      .max(COMPUTE_MAX_OUTPUT_FILES),
    launcher: z
      .array(z.object({ name: z.enum(LAUNCHER_FILE_NAMES), size: safeInt(0) }).strict())
      .length(LAUNCHER_FILE_NAMES.length),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (new Set(request.launcher.map((f) => f.name)).size !== LAUNCHER_FILE_NAMES.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["launcher"],
        message: "each launcher file is named once",
      });
    }
  });

/**
 * The answer: one presigned PUT address per file, for the path under `jobs/<id>/` (`outputs/...`
 * or `launcher/...`), valid until `expires_at`. A response, so open at the top and in each upload:
 * a reader ignores keys it does not know.
 */
export const OutputsResponseSchema = z
  .object({
    uploads: z
      .array(
        z
          .object({
            path: z
              .string()
              .max(600)
              .regex(UPLOAD_PATH_RE)
              .refine((p) => !COMPUTE_DOT_SEGMENT_RE.test(p), { message: "no . or .. segments" }),
            url: urlSchema,
          })
          .passthrough(),
      )
      .max(COMPUTE_MAX_OUTPUT_FILES + LAUNCHER_FILE_NAMES.length),
    expires_at: timestampSchema,
  })
  .passthrough();

// --- Where the launcher's files live in the results bucket -------------------------------------

function assertJobId(jobId: string): void {
  if (!COMPUTE_JOB_ID_RE.test(jobId)) throw new RangeError("not a job id");
}

/** `jobs/<id>/outputs/<path>`: one output of one job. Throws for a path that could escape. */
export function resultsOutputKey(jobId: string, path: string): string {
  assertJobId(jobId);
  if (!isSafeComputePath(path, 512)) throw new RangeError("not a safe output path");
  return `jobs/${jobId}/outputs/${path}`;
}

/** `jobs/<id>/launcher/<file>`: one of the launcher's four files. */
export function resultsLauncherKey(jobId: string, name: LauncherFileName): string {
  assertJobId(jobId);
  if (!(LAUNCHER_FILE_NAMES as readonly string[]).includes(name)) {
    throw new RangeError("not a launcher file");
  }
  return `jobs/${jobId}/launcher/${name}`;
}
