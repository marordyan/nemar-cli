/**
 * The shapes of what NEMAR sends to Tapis and what Tapis answers (epic #2005 phase A4, #2009; ADR
 * 0118), written from Tapis's published OpenAPI specifications (`JobsAPI.yaml` of
 * `tapis-project/openapi-jobs`, `service/resources/openapi_v3.yml` of `tapis-project/tokens-api` and
 * of `tapis-project/authenticator`) and checked against the documentation's examples. NOTHING HERE
 * WAS CHECKED AGAINST A REAL TENANT.
 *
 * What NEMAR SENDS is closed (`.strict()`): a key the builder did not mean is a bug, and it is
 * refused before anything leaves. What Tapis ANSWERS is open (`.passthrough()`), so a field a newer
 * Tapis adds does not break the Worker, and it is validated only as far as NEMAR depends on it: a
 * response that fails its schema is `invalid_response`, never partly trusted.
 *
 * Where the specification and the documentation's examples disagree, both are accepted (a job's
 * `parameterSet` is a string in the specification and an object in the examples; a history event's
 * detail is `eventDetail` in one and `jobStatus` in the other; a file's address is `url` or `uri`).
 *
 * SECURITY, from the Jobs specification and documentation (all of it UNVERIFIED against a real
 * tenant): the launch specification, which holds a job's `job_token`, travels in the environment
 * variable `NEMAR_LAUNCH_SPEC` as base64url text (`encodeLaunchSpecEnv`, A1c), so it is part of the
 * job record's `parameterSet.envVariables`. The encoding is for the shell, not for secrecy: the
 * value holds the token and is the secret it always was, so it is never logged or returned. Tapis
 * returns `parameterSet` (and `subscriptions`, whose webhook address carries a token) in a job record
 * to whoever may read the record: the job's owner, its creator and a tenant administrator
 * (`GET /v3/jobs/{uuid}`, and the search with every attribute); a user the job's `JOB_HISTORY`
 * resource was shared with (the documentation says that grantee can get the job's history, status and
 * "job's detail information", and search the jobs shared with them); a user its
 * `JOB_RESUBMIT_REQUEST` resource was shared with (`.../resubmit_request` serves the whole submission
 * request); and a user its `JOB_OUTPUT` resource was shared with, through the launch files Tapis
 * archives with the output (`tapisjob.env`, and `tapisjob.sh`, which sit in the exec directory) unless
 * `parameterSet.archiveFilter.includeLaunchFiles` is false, which every submit says. `JobListDTO`
 * (`GET /v3/jobs/list`) has no such field. This client therefore drops both fields from every record
 * it returns (`withoutSecretFields`), so a caller that stores or logs a record never holds the token,
 * and it refuses to download or list the two launch files (client.ts).
 */

import { z } from "zod";
import {
  COMPUTE_JOB_ID_RE,
  LAUNCHER_ENV,
  PARTITION_NAMES,
} from "../../../../shared/contract/compute";
import {
  LAUNCH_SPEC_ENV_MAX_CHARS,
  decodeLaunchSpecEnv,
} from "../../../../shared/contract/compute-launch";

/** The environment variable that carries the launch specification: the contract's own word. */
export const LAUNCH_SPEC_ENV_KEY = LAUNCHER_ENV.SPEC;

/** A Tapis username as NEMAR will put it in a request: the characters of a handle, up to 128. */
export const TAPIS_OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9._~@+-]{0,127}$/;

/** A job uuid as a path segment: Tapis's own look (`<uuid>-007`), and nothing that could change a path. */
export const TAPIS_JOB_UUID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** A tag as the search will quote it: no quote, no space, no parenthesis. */
export const TAPIS_TAG_RE = /^[A-Za-z0-9_:.-]{1,128}$/;

// --- Responses (open) --------------------------------------------------------------------------

/** `{ status, message, version, result }`, with `result` as the call says. */
export function envelope<T extends z.ZodTypeAny>(result: T) {
  return z
    .object({
      status: z.string(),
      message: z.string().nullish(),
      version: z.string().nullish(),
      result,
    })
    .passthrough();
}

const text = z.string().nullish();

/** A job record (`Job`): what NEMAR depends on is typed, the rest is kept as it came. */
export const TapisJobSchema = z
  .object({
    uuid: z.string().min(1),
    status: z.string().min(1),
    owner: text,
    createdby: text,
    name: text,
    condition: text,
    lastMessage: text,
    created: text,
    ended: text,
    lastUpdated: text,
    remoteJobId: text,
    remoteQueue: text,
    remoteSubmitted: text,
    remoteStarted: text,
    remoteEnded: text,
    appId: text,
    appVersion: text,
    execSystemLogicalQueue: text,
    tags: z.array(z.string()).nullish(),
    nodeCount: z.number().nullish(),
    coresPerNode: z.number().nullish(),
    memoryMB: z.number().nullish(),
    maxMinutes: z.number().nullish(),
    // Typed only to be dropped: a string in the specification, an object in its examples.
    parameterSet: z.unknown().optional(),
    subscriptions: z.unknown().optional(),
  })
  .passthrough();

/**
 * The record without the two fields that can hold a secret, as a schema and as the type the client
 * returns. It is derived from the schema (not `Omit` of an inferred passthrough type, which collapses
 * to a bare index signature and leaves every field `unknown`): the named fields keep their types, and
 * a key Tapis adds is `unknown`.
 */
const TapisJobPublicSchema = TapisJobSchema.omit({ parameterSet: true, subscriptions: true });
export type TapisJob = z.infer<typeof TapisJobPublicSchema>;

/** Drop the fields of a job record that can hold the launch specification or a webhook address. */
export function withoutSecretFields(job: z.infer<typeof TapisJobSchema>): TapisJob {
  const { parameterSet: _parameterSet, subscriptions: _subscriptions, ...rest } = job;
  return rest;
}

// Compile-time checks, in a file `tsc -p backend` covers (the tests are outside that project): they
// fail the typecheck if `TapisJob` ever collapses again, or if a secret field becomes a named key.
type Assert<T extends true> = T;
type NamedKeys<T> = keyof {
  [K in keyof T as string extends K ? never : number extends K ? never : K]: T[K];
};
export type TapisJobTypeChecks = [
  Assert<TapisJob["uuid"] extends string ? true : false>,
  Assert<TapisJob["status"] extends string ? true : false>,
  Assert<string extends TapisJob["status"] ? true : false>,
  Assert<"uuid" extends NamedKeys<TapisJob> ? true : false>,
  Assert<"status" extends NamedKeys<TapisJob> ? true : false>,
  Assert<"parameterSet" extends NamedKeys<TapisJob> ? false : true>,
  Assert<"subscriptions" extends NamedKeys<TapisJob> ? false : true>,
];

export const TapisJobResponseSchema = envelope(TapisJobSchema);
export const TapisJobsResponseSchema = envelope(z.array(TapisJobSchema));

/** One event of a job's history. */
export const TapisHistoryEventSchema = z
  .object({ event: z.string(), created: z.string() })
  .passthrough();
export type TapisHistoryEvent = z.infer<typeof TapisHistoryEventSchema>;
export const TapisHistoryResponseSchema = envelope(z.array(TapisHistoryEventSchema));

/** One entry of an output listing (`FileInfo`). */
export const TapisFileInfoSchema = z
  .object({
    path: z.string(),
    type: z.string(),
    size: z.number(),
    name: text,
    lastModified: text,
  })
  .passthrough();
export type TapisFileInfo = z.infer<typeof TapisFileInfoSchema>;
export const TapisOutputListResponseSchema = envelope(z.array(TapisFileInfoSchema));

export const TapisCancelResponseSchema = envelope(
  z.object({ message: z.string().nullish() }).passthrough(),
);

export const TapisSubscriptionResponseSchema = envelope(
  z.object({ url: z.string() }).passthrough(),
);
export type TapisSubscription = { url: string; [key: string]: unknown };

/** `GET /v3/jobs/healthcheck`: a probe answer, whose `result` NEMAR does not read. */
export const TapisHealthResponseSchema = z
  .object({ status: z.string(), message: z.string().nullish() })
  .passthrough();

/** Both token endpoints answer `result.access_token.access_token` and its `expires_in` (seconds). */
export const TapisTokenResponseSchema = envelope(
  z
    .object({
      access_token: z
        .object({
          access_token: z.string().min(1),
          expires_in: z.number().int().min(1),
        })
        .passthrough(),
    })
    .passthrough(),
);

// --- Requests (closed) -------------------------------------------------------------------------

const positiveInt = z.number().int().safe().min(1);

/**
 * `ReqSubmitJob`, as NEMAR sends it. NO archive system field (`archiveSystemId`, `archiveSystemDir`,
 * `archiveMode`) and no execution system: the application definition carries those, and the launcher
 * uploads the results itself, so Tapis holds only its own archive on the cluster. GPUs have no field
 * on `ReqSubmitJob`, so they are a scheduler option (`parameterSet.schedulerOptions`), and the
 * partition is the logical queue.
 */
export const SubmitJobRequestSchema = z
  .object({
    name: z.string().regex(COMPUTE_JOB_ID_RE),
    appId: z.string().min(1).max(256),
    appVersion: z.string().min(1).max(64),
    owner: z.string().regex(TAPIS_OWNER_RE),
    execSystemLogicalQueue: z.enum(PARTITION_NAMES),
    nodeCount: positiveInt,
    coresPerNode: positiveInt,
    memoryMB: positiveInt.optional(),
    maxMinutes: positiveInt,
    parameterSet: z
      .object({
        envVariables: z
          .array(
            z
              .object({
                key: z.literal(LAUNCH_SPEC_ENV_KEY),
                // The launch specification's text in base64url (`encodeLaunchSpecEnv`), and nothing
                // else: the value must be one the contract's own strict decoder accepts (only the
                // shell-inert alphabet `A-Za-z0-9-_`, within the encoded bound, a good length, printable
                // ASCII once decoded, and canonical). Raw JSON is refused here, before anything is sent
                // (A1c, #2043). One rule, shared with the launcher's decoder, and not a copy of it.
                value: z
                  .string()
                  .max(LAUNCH_SPEC_ENV_MAX_CHARS)
                  .refine((value) => decodeLaunchSpecEnv(value).ok),
              })
              .strict(),
          )
          .length(1),
        // Tapis archives the launch files (`tapisjob.env`, which holds the launch specification, and
        // `tapisjob.sh`) with the job's output unless told not to. Exactly this one key and value.
        archiveFilter: z.object({ includeLaunchFiles: z.literal(false) }).strict(),
        schedulerOptions: z
          .array(z.object({ arg: z.string().min(1) }).strict())
          .min(1)
          .optional(),
      })
      .strict(),
    tags: z.array(z.string().regex(TAPIS_TAG_RE)).length(1),
  })
  .strict();

export type SubmitJobRequest = z.infer<typeof SubmitJobRequestSchema>;

/** The subscription NEMAR creates: webhook delivery of every status change of one job. */
export const SubscribeRequestSchema = z
  .object({
    description: z.string(),
    enabled: z.literal(true),
    eventCategoryFilter: z.literal("JOB_NEW_STATUS"),
    deliveryTargets: z
      .array(
        z
          .object({
            deliveryMethod: z.literal("WEBHOOK"),
            deliveryAddress: z.string().min(1).max(2048),
          })
          .strict(),
      )
      .length(1),
    // Spelled as the specification's `ReqSubscribe` and the Jobs documentation spell it.
    ttlminutes: z.number().int().min(1).max(40_320),
  })
  .strict();
