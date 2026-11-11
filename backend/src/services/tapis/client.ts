/**
 * The Tapis client the compute gateway uses to talk to the tenant (epic #2005 phase A4, #2009; ADR
 * 0118). Typed calls over `/v3/jobs/...`, built from Tapis's published OpenAPI specifications and
 * tested against a local stand-in (`backend/test/helpers/tapis-standin.ts`). NOTHING HERE HAS BEEN
 * VERIFIED AGAINST A REAL TENANT; the pull request that added it lists what is unverified.
 *
 * THE OWNER IS A PARAMETER. Every call takes a context with `owner`, the Tapis username the call is
 * made for: under the `service` strategy a token is minted for it, and for `submitJob` it is the
 * request's `owner`. There is one NEMAR tenant and NEMAR owns every Tapis job (the repository owner's
 * decision, 2026-11-04), so a caller passes a NEMAR service identity from configuration, never a
 * constant of this module and never a person.
 *
 * WHO CAN READ A JOB'S `parameterSet`, and with it the job's token (from the Jobs specification and
 * documentation; ALL OF IT UNVERIFIED against a real tenant). The launch specification, which holds
 * `job_token`, travels in the environment variable `NEMAR_LAUNCH_SPEC` as base64url text (A1c; an
 * encoding for the shell, not a protection: the value holds the token), which Tapis keeps in the job
 * record's `parameterSet.envVariables`. The roles that can read it are: the job's owner, its creator
 * (`createdby`) and a tenant administrator, through `GET /v3/jobs/{uuid}` and the search with every
 * attribute; a user the job's `JOB_HISTORY` resource was shared with (the documentation says that
 * grantee can get the job's history, status and "job's detail information", and search the jobs
 * shared with them); a user its `JOB_RESUBMIT_REQUEST` resource was shared with, through
 * `GET /v3/jobs/{uuid}/resubmit_request`, which is the whole submission request; and a user its
 * `JOB_OUTPUT` resource was shared with, through the launch files Tapis archives with the output,
 * `tapisjob.env` and `tapisjob.sh`, which sit in the exec directory, unless
 * `parameterSet.archiveFilter.includeLaunchFiles` is false (every submit says so, and the Tapis
 * application definition is the second layer). The list endpoint (`JobListDTO`) has no such field,
 * and the status and history calls do not either. The client never returns `parameterSet` or
 * `subscriptions` (their addresses carry a token): see `withoutSecretFields`; and it refuses to
 * download or list `tapisjob.env` and `tapisjob.sh` (`assertOutputPath`).
 *
 * RULES, each pinned by a test:
 *  - every call has a 15-second timeout and a bounded body read (http.ts);
 *  - reads retry through `isRetryable` (up to three attempts); `submitJob`, `cancelJob` and
 *    `subscribeWebhook` NEVER retry inside the client, because a lost answer says nothing about
 *    whether the call took effect. For those three, `unavailable` and `invalid_response` mean THE
 *    OUTCOME IS UNKNOWN (`TapisError.outcomeUnknown`, and the message says so): a 2xx answer that fails
 *    its schema means the job MAY EXIST, so the caller searches by tag (`searchJobsByTag`) before any
 *    re-submit, or its sweep decides;
 *  - a 401 refreshes the token once and retries once, for every call: a refused credential did
 *    nothing, so repeating it is safe; a second 401 is `unauthorized`;
 *  - a response that fails its schema is `invalid_response`, never partly trusted;
 *  - no token, password, launch specification or webhook address is ever in an error or a log line.
 */

import {
  COMPUTE_JOB_ID_RE,
  type PartitionName,
  isSafeComputePath,
} from "../../../../shared/contract/compute";
import type { LaunchSpecEnvValue } from "../../../../shared/contract/compute-launch";
import { withRetry } from "../retry";
import { getTapisToken, invalidateTapisToken, requireTapisConfig } from "./auth";
import { type TapisEnv, overrideActive, tapisBaseOrProblem } from "./config";
import { TapisError, invalidResponse } from "./errors";
import {
  type SendResult,
  TAPIS_MAX_JSON_BYTES,
  TAPIS_TIMEOUT_MS,
  attemptsFor,
  effectiveTimeoutMs,
  parseJsonBody,
  retryDelayFor,
  send,
} from "./http";
import {
  LAUNCH_SPEC_ENV_KEY,
  SubmitJobRequestSchema,
  SubscribeRequestSchema,
  TAPIS_JOB_UUID_RE,
  TAPIS_OWNER_RE,
  TAPIS_TAG_RE,
  TapisCancelResponseSchema,
  type TapisFileInfo,
  TapisHealthResponseSchema,
  type TapisHistoryEvent,
  TapisHistoryResponseSchema,
  type TapisJob,
  TapisJobResponseSchema,
  TapisJobsResponseSchema,
  TapisOutputListResponseSchema,
  type TapisSubscription,
  TapisSubscriptionResponseSchema,
  withoutSecretFields,
} from "./schemas";

export { TAPIS_MAX_JSON_BYTES, TAPIS_TIMEOUT_MS, attemptsFor, effectiveTimeoutMs, retryDelayFor };
export type { TapisFileInfo, TapisHistoryEvent, TapisJob, TapisSubscription };

/** What every call is made with. */
export interface TapisContext {
  env: TapisEnv;
  /** The Tapis username the call is made for (see the header). */
  owner: string;
  /** At most 15 seconds, which is also the default. */
  timeoutMs?: number;
  /** The wait between the attempts of a read, 0 to 5000 ms; a value that is not a number is the default, 500. */
  retryDelayMs?: number;
  /** How many times a read is tried, 1 to 3; a value that is not a number is the default, 3. */
  maxAttempts?: number;
  /** The clock, for the token cache: a test moves it. */
  now?: () => number;
}

/** The `listType` values of Tapis's job list and search. */
export const TAPIS_LIST_TYPES = ["MY_JOBS", "SHARED_JOBS", "ALL_JOBS"] as const;
export type TapisListType = (typeof TAPIS_LIST_TYPES)[number];

const LIST_LIMIT_MAX = 1000;

/** The most bytes one download may ask for: 16 MiB (a larger request is refused, not clamped). */
export const TAPIS_MAX_DOWNLOAD_BYTES = 16 * 1024 * 1024;

/** The files Tapis writes in the exec directory that hold the launch specification. */
const LAUNCH_FILES: ReadonlySet<string> = new Set(["tapisjob.env", "tapisjob.sh"]);

/** The tag every NEMAR job carries, so a retried submission finds its job instead of making two. */
export const TAPIS_JOB_TAG_PREFIX = "nemar_job:";

export function nemarJobTag(jobId: string): string {
  if (typeof jobId !== "string" || !COMPUTE_JOB_ID_RE.test(jobId)) {
    throw new RangeError("a NEMAR job id is job_ and 24 lowercase hex digits");
  }
  return `${TAPIS_JOB_TAG_PREFIX}${jobId}`;
}

/**
 * The attributes a tag search asks for: what NEMAR reads of a job, and not `parameterSet`,
 * `subscriptions`, `fileInputs` or `notes`, so a search never carries a launch specification into
 * the Worker.
 */
const SEARCH_SELECT = [
  "uuid",
  "name",
  "owner",
  "createdby",
  "status",
  "condition",
  "lastMessage",
  "created",
  "ended",
  "lastUpdated",
  "tags",
  "appId",
  "appVersion",
  "remoteJobId",
  "remoteQueue",
  "remoteSubmitted",
  "remoteStarted",
  "remoteEnded",
  "execSystemLogicalQueue",
  "nodeCount",
  "coresPerNode",
  "memoryMB",
  "maxMinutes",
].join(",");

// --- Arguments ---------------------------------------------------------------------------------

function assertOwner(owner: string): void {
  if (typeof owner !== "string" || !TAPIS_OWNER_RE.test(owner)) {
    throw new RangeError("owner is not a Tapis username NEMAR will send");
  }
}

function assertUuid(uuid: string): void {
  if (typeof uuid !== "string" || !TAPIS_JOB_UUID_RE.test(uuid)) {
    throw new RangeError("not a Tapis job uuid");
  }
}

function assertPage(limit: number | undefined, skip: number | undefined): void {
  if (limit !== undefined && !(Number.isInteger(limit) && limit >= 1 && limit <= LIST_LIMIT_MAX)) {
    throw new RangeError(`limit is a whole number from 1 to ${LIST_LIMIT_MAX}`);
  }
  if (
    skip !== undefined &&
    !(Number.isInteger(skip) && skip >= 0 && skip <= Number.MAX_SAFE_INTEGER)
  ) {
    throw new RangeError("skip is a whole number from 0");
  }
}

function assertListType(listType: string): asserts listType is TapisListType {
  if (!(TAPIS_LIST_TYPES as readonly string[]).includes(listType)) {
    throw new RangeError("listType is MY_JOBS, SHARED_JOBS or ALL_JOBS");
  }
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const text = search.toString();
  return text === "" ? "" : `?${text}`;
}

/** A file path as URL segments, each encoded once. */
function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

// --- One call ----------------------------------------------------------------------------------

interface Call {
  /** A fixed phrase naming the call, for errors and the retry log. */
  what: string;
  method: "GET" | "POST";
  /** Below `/v3`, with its query. */
  path: string;
  /** A JSON text, sent as it is. */
  body?: string;
  /** Whether a failure that may clear is tried again. Never for a call that changes something. */
  retry: boolean;
  /** Whether the call changes something at Tapis, so that a failure with no clear answer is of unknown outcome. */
  mutates: boolean;
  maxBytes: number;
  /** The `Accept` header: JSON for a record, anything for a file's bytes. */
  accept: "application/json" | "*/*";
  /** Keep a prefix of a body over `maxBytes` and say so, rather than refuse it (a download only). */
  truncate?: boolean;
}

/**
 * Send one call with a token, refresh the token once on a 401 and retry once, and try a read again
 * when its failure may clear. Returns the status and bytes of the 2xx answer.
 */
async function perform(ctx: TapisContext, call: Call): Promise<SendResult> {
  assertOwner(ctx.owner);
  const config = requireTapisConfig(ctx.env);
  const authOptions = { owner: ctx.owner, timeoutMs: ctx.timeoutMs, now: ctx.now };
  const sendWith = async (token: string): Promise<SendResult> => {
    try {
      return await send({
        url: `${config.baseUrl}/v3${call.path}`,
        method: call.method,
        headers: {
          "X-Tapis-Token": token,
          Accept: call.accept,
          ...(call.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: call.body,
        what: call.what,
        timeoutMs: ctx.timeoutMs,
        maxBytes: call.maxBytes,
        ...(call.truncate === true ? { truncate: true } : {}),
      });
    } catch (err) {
      // The request may have been sent and acted on: say so, for a call that changes something.
      throw call.mutates && err instanceof TapisError ? err.withOutcomeUnknown() : err;
    }
  };

  const attempt = async (): Promise<SendResult> => {
    const token = await getTapisToken(ctx.env, authOptions);
    try {
      return await sendWith(token);
    } catch (err) {
      // Only a 401 is a token that stopped working; a 403 is a permission a new token would not change.
      if (!(err instanceof TapisError) || err.status !== 401) throw err;
      // Drop the token that was refused, and only that one: callers that held it share one new mint.
      invalidateTapisToken(ctx.env, ctx.owner, token);
      return await sendWith(await getTapisToken(ctx.env, authOptions));
    }
  };

  const { result } = await withRetry(attempt, `tapis ${call.what}`, {
    maxAttempts: call.retry ? attemptsFor(ctx.maxAttempts) : 1,
    delayMs: retryDelayFor(ctx.retryDelayMs),
    isRetryable: (err) => err instanceof TapisError && err.retryable,
  });
  return result;
}

/** One call whose answer is JSON: parse it and check it against `schema`, or `invalid_response`. */
async function performJson<T>(
  ctx: TapisContext,
  call: Omit<Call, "maxBytes" | "accept">,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
): Promise<T> {
  const { status, bytes } = await perform(ctx, {
    ...call,
    maxBytes: TAPIS_MAX_JSON_BYTES,
    accept: "application/json",
  });
  // A 2xx answer that is not what the specification says: for a call that changes something the job
  // MAY EXIST, so the error carries that, and the status the answer came with.
  const failed = (error: TapisError) => (call.mutates ? error.withOutcomeUnknown() : error);
  let body: unknown;
  try {
    body = parseJsonBody(bytes, call.what, status);
  } catch (err) {
    throw err instanceof TapisError ? failed(err) : err;
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw failed(invalidResponse(call.what, status));
  return parsed.data;
}

// --- Jobs --------------------------------------------------------------------------------------

/** What `submitJob` builds the request from. The owner is the context's. */
export interface SubmitJobInput {
  /** The NEMAR job id (`job_` and 24 hex digits): the job's name and, as a tag, how it is found again. */
  jobId: string;
  /** The Tapis application and its version (the launcher: `nemar-launch`). */
  appId: string;
  appVersion: string;
  /** The partition word, sent as the logical queue. */
  partition: PartitionName;
  nodes: number;
  coresPerNode: number;
  /** Per node, in MB; omitted, the application's own default applies. */
  memoryMb?: number;
  gpus: number;
  minutes: number;
  /**
   * The VALUE of `NEMAR_LAUNCH_SPEC`, as `encodeLaunchSpecEnv` returns it: the launch specification's
   * text in base64url, shell-inert characters only and within 87,382 of them. The type is branded, so
   * the text cannot be passed in its place; raw JSON, or anything else that is not such a value, is
   * refused before a request is built. It holds the job's token, so it is never logged or returned.
   */
  launchSpecEnv: LaunchSpecEnvValue;
}

/** Which part of a submit request NEMAR refused to send: the launch value, or another field of the job. */
export type SubmitRefusalReason = "launch_spec_env" | "job_field";

/**
 * A submit request NEMAR will not send because of the job's own data: the launch value, or a field that
 * comes from the job's row. Such a request is wrong the same way on every attempt, so a caller ends the
 * job instead of retrying it; `reason` is a fixed word saying which part. It is a RangeError, as a
 * refused request always was. The OWNER is not such a field: it is NEMAR's configuration, a bad one is
 * fixed there, and it stays a plain RangeError, so the job waits for the fix. The message names the
 * fields and never a value, because the launch value holds the job's token.
 */
export class SubmitRequestRefused extends RangeError {
  readonly reason: SubmitRefusalReason;

  constructor(reason: SubmitRefusalReason, fields: string[]) {
    super(`the job request is not one NEMAR sends: ${fields.join(", ")}`);
    this.name = "SubmitRequestRefused";
    this.reason = reason;
  }
}

/** The request `submitJob` sends, so a test and a reader see exactly what it is. */
export function buildSubmitRequest(owner: string, input: SubmitJobInput) {
  // The tag below is made from the job id, and refuses one that is not a job id by a plain RangeError:
  // refuse it first, as the job's own data.
  if (typeof input.jobId !== "string" || !COMPUTE_JOB_ID_RE.test(input.jobId)) {
    throw new SubmitRequestRefused("job_field", ["name"]);
  }
  const candidate = {
    name: input.jobId,
    appId: input.appId,
    appVersion: input.appVersion,
    owner,
    execSystemLogicalQueue: input.partition,
    nodeCount: input.nodes,
    coresPerNode: input.coresPerNode,
    ...(input.memoryMb === undefined ? {} : { memoryMB: input.memoryMb }),
    maxMinutes: input.minutes,
    parameterSet: {
      envVariables: [{ key: LAUNCH_SPEC_ENV_KEY, value: input.launchSpecEnv }],
      // Tapis archives `tapisjob.env` (which holds the launch specification, so the job's token) and
      // `tapisjob.sh` with the job's output unless told not to. The application definition says the
      // same, as a second layer. Whether Tapis takes this from the request is UNVERIFIED.
      archiveFilter: { includeLaunchFiles: false },
      // `ReqSubmitJob` has no field for GPUs, so they are a scheduler option, and the SPELLING
      // (`--gpus=N`, as Expanse's user guide writes it) is UNVERIFIED against a real tenant: a
      // system's scheduler profile may hide or rename it.
      ...(input.gpus > 0 ? { schedulerOptions: [{ arg: `--gpus=${input.gpus}` }] } : {}),
    },
    tags: [nemarJobTag(input.jobId)],
  };
  if (!Number.isInteger(input.gpus) || input.gpus < 0) {
    throw new SubmitRequestRefused("job_field", ["gpus"]);
  }
  const checked = SubmitJobRequestSchema.safeParse(candidate);
  if (!checked.success) {
    // The fields, never the values: a launch specification holds a token.
    const fields = [...new Set(checked.error.issues.map((i) => i.path.join(".") || "request"))];
    // The owner is configuration, not the job's data: a plain RangeError, and the job waits.
    if (fields.includes("owner")) {
      throw new RangeError(`the job request is not one NEMAR sends: ${fields.join(", ")}`);
    }
    const launchValue = fields.some((field) => field.startsWith("parameterSet.envVariables"));
    throw new SubmitRequestRefused(launchValue ? "launch_spec_env" : "job_field", fields);
  }
  return checked.data;
}

/**
 * `POST /v3/jobs/submit`. Never retried inside the client: Tapis has no idempotency key, so after a
 * lost answer the caller searches by tag (`searchJobsByTag`) before it submits again.
 */
export async function submitJob(ctx: TapisContext, input: SubmitJobInput): Promise<TapisJob> {
  assertOwner(ctx.owner);
  const request = buildSubmitRequest(ctx.owner, input);
  // Under the password strategy the token is always the configured account's, so a request that says
  // another owner would be a job the account does not own: refuse it, with a sentence that names no one.
  const config = requireTapisConfig(ctx.env);
  if (config.strategy === "password" && ctx.owner !== config.username) {
    throw new TapisError("unconfigured", "submit job", {
      detail: "the owner is not the configured account",
    });
  }
  const answer = await performJson(
    ctx,
    {
      what: "submit job",
      method: "POST",
      path: "/jobs/submit",
      body: JSON.stringify(request),
      retry: false,
      mutates: true,
    },
    TapisJobResponseSchema,
  );
  return withoutSecretFields(answer.result);
}

/** `GET /v3/jobs/{uuid}`. */
export async function getJob(ctx: TapisContext, uuid: string): Promise<TapisJob> {
  assertUuid(uuid);
  const answer = await performJson(
    ctx,
    {
      what: "get job",
      method: "GET",
      path: `/jobs/${encodeURIComponent(uuid)}`,
      retry: true,
      mutates: false,
    },
    TapisJobResponseSchema,
  );
  return withoutSecretFields(answer.result);
}

/** `GET /v3/jobs/{uuid}/history`: the events of a job, oldest first as Tapis lists them. */
export async function getJobHistory(
  ctx: TapisContext,
  uuid: string,
  page: { limit?: number; skip?: number } = {},
): Promise<TapisHistoryEvent[]> {
  assertUuid(uuid);
  assertPage(page.limit, page.skip);
  const answer = await performJson(
    ctx,
    {
      what: "get job history",
      method: "GET",
      path: `/jobs/${encodeURIComponent(uuid)}/history${query({ limit: page.limit, skip: page.skip })}`,
      retry: true,
      mutates: false,
    },
    TapisHistoryResponseSchema,
  );
  return answer.result;
}

/**
 * `POST /v3/jobs/{uuid}/cancel`. A job already terminal is a 409, which is `rejected` with status
 * 409. Not retried inside the client: whether a lost cancel took effect is for the caller's sweep.
 */
export async function cancelJob(
  ctx: TapisContext,
  uuid: string,
): Promise<{ message?: string | null }> {
  assertUuid(uuid);
  const answer = await performJson(
    ctx,
    {
      what: "cancel job",
      method: "POST",
      path: `/jobs/${encodeURIComponent(uuid)}/cancel`,
      retry: false,
      mutates: true,
    },
    TapisCancelResponseSchema,
  );
  return answer.result;
}

/**
 * `POST /v3/jobs/search` with the documented body, `{ "search": ["tags IN ('<tag>')"] }`. The shape
 * of that body is the Jobs documentation's example and UNVERIFIED against a real tenant. `listType`
 * defaults to `ALL_JOBS`, which the documentation says lists the caller's own jobs PLUS the jobs shared
 * with the caller, not every job in the tenant. A retried submission finds its job this way only
 * because NEMAR submits and searches under ONE identity (the owner's decision of 2026-11-04); if more
 * than one identity ever submits, the search must be made as the one that submitted.
 */
export async function searchJobsByTag(
  ctx: TapisContext,
  tag: string,
  options: { listType?: TapisListType; limit?: number; skip?: number } = {},
): Promise<TapisJob[]> {
  if (typeof tag !== "string" || !TAPIS_TAG_RE.test(tag)) {
    throw new RangeError("a tag to search is letters, digits and _ : . - only");
  }
  const listType = options.listType ?? "ALL_JOBS";
  assertListType(listType);
  assertPage(options.limit, options.skip);
  const answer = await performJson(
    ctx,
    {
      what: "search jobs",
      method: "POST",
      path: `/jobs/search${query({ listType, limit: options.limit, skip: options.skip, select: SEARCH_SELECT })}`,
      body: JSON.stringify({ search: [`tags IN ('${tag}')`] }),
      retry: true,
      mutates: false,
    },
    TapisJobsResponseSchema,
  );
  return answer.result.map(withoutSecretFields);
}

/** `GET /v3/jobs/list`: a page of jobs, without the fields a full record has. */
export async function listJobs(
  ctx: TapisContext,
  options: { listType: TapisListType; limit: number; skip: number; orderBy?: string },
): Promise<TapisJob[]> {
  assertListType(options.listType);
  assertPage(options.limit, options.skip);
  if (options.orderBy !== undefined && !/^[A-Za-z]{1,32}\((asc|desc)\)$/.test(options.orderBy)) {
    throw new RangeError("orderBy is a field and a direction, such as created(desc)");
  }
  const answer = await performJson(
    ctx,
    {
      what: "list jobs",
      method: "GET",
      path: `/jobs/list${query({ listType: options.listType, limit: options.limit, skip: options.skip, orderBy: options.orderBy })}`,
      retry: true,
      mutates: false,
    },
    TapisJobsResponseSchema,
  );
  return answer.result.map(withoutSecretFields);
}

/**
 * `POST /v3/jobs/subscribe/{uuid}`: a webhook for every status change of a job. The address carries a
 * token and goes to Tapis only; it is never in an error or a log line. `ttlMinutes` is 1 to 40,320
 * (four weeks, Tapis's own limit), sent as `ttlminutes`, the way the specification spells it.
 * Not retried inside the client (a lost answer would make a second subscription).
 */
export async function subscribeWebhook(
  ctx: TapisContext,
  uuid: string,
  address: string,
  ttlMinutes: number,
): Promise<TapisSubscription> {
  assertUuid(uuid);
  if (!Number.isInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 40_320) {
    throw new RangeError("ttlMinutes is a whole number from 1 to 40320");
  }
  let protocol: string;
  try {
    protocol = new URL(address).protocol;
  } catch {
    throw new RangeError("a webhook address is an absolute URL");
  }
  // The address carries a token, so it is https; plain http only where the test override of the
  // tenant's address is installed (a loopback receiver), as for the tenant's own address.
  const allowed = protocol === "https:" || (protocol === "http:" && overrideActive());
  if (!allowed || address.length > 2048) {
    throw new RangeError("a webhook address is an https URL of at most 2048 characters");
  }
  const body = SubscribeRequestSchema.parse({
    description: "NEMAR status hint",
    enabled: true,
    eventCategoryFilter: "JOB_NEW_STATUS",
    deliveryTargets: [{ deliveryMethod: "WEBHOOK", deliveryAddress: address }],
    ttlminutes: ttlMinutes,
  });
  const answer = await performJson(
    ctx,
    {
      what: "subscribe webhook",
      method: "POST",
      path: `/jobs/subscribe/${encodeURIComponent(uuid)}`,
      body: JSON.stringify(body),
      retry: false,
      mutates: true,
    },
    TapisSubscriptionResponseSchema,
  );
  return answer.result;
}

// --- Output ------------------------------------------------------------------------------------

/** A path below a job's output directory, or the `RangeError`; `allowRoot` lets it be empty. */
function assertOutputPath(path: string, allowRoot: boolean): void {
  if (typeof path !== "string") throw new RangeError("not an output path");
  if (allowRoot && path === "") return;
  if (!isSafeComputePath(path, 512)) throw new RangeError("not a path below the output directory");
  // The two files Tapis writes in the exec directory, which is the output root, hold the launch
  // specification (and so the job's token). Never read through this client, whatever their case.
  const basename = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (LAUNCH_FILES.has(basename)) throw new RangeError("not a file this client reads");
}

/**
 * `GET /v3/jobs/{uuid}/output/list/{path}`: the entries below `path` (`""` is the root). Tapis wants
 * a directory path to end in a slash, so one is added.
 */
export async function listOutputs(
  ctx: TapisContext,
  uuid: string,
  path: string,
): Promise<TapisFileInfo[]> {
  assertUuid(uuid);
  const directory = path.endsWith("/") ? path.slice(0, -1) : path;
  assertOutputPath(directory, true);
  const answer = await performJson(
    ctx,
    {
      what: "list outputs",
      method: "GET",
      path: `/jobs/${encodeURIComponent(uuid)}/output/list/${directory === "" ? "" : `${encodePath(directory)}/`}`,
      retry: true,
      mutates: false,
    },
    TapisOutputListResponseSchema,
  );
  return answer.result;
}

/** The one download: `truncate` keeps a prefix of a file over `maxBytes` instead of refusing it. */
async function fetchOutput(
  ctx: TapisContext,
  uuid: string,
  path: string,
  maxBytes: number,
  truncate: boolean,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  assertUuid(uuid);
  assertOutputPath(path, false);
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > TAPIS_MAX_DOWNLOAD_BYTES) {
    throw new RangeError(`maxBytes is a whole number from 1 to ${TAPIS_MAX_DOWNLOAD_BYTES}`);
  }
  const result = await perform(ctx, {
    what: "download output",
    method: "GET",
    path: `/jobs/${encodeURIComponent(uuid)}/output/download/${encodePath(path)}`,
    retry: true,
    mutates: false,
    maxBytes,
    accept: "*/*",
    ...(truncate ? { truncate: true } : {}),
  });
  return { bytes: result.bytes, truncated: result.truncated === true };
}

/**
 * `GET /v3/jobs/{uuid}/output/download/{path}`: one file's bytes, at most `maxBytes` (a larger one is
 * `invalid_response` and is not read to its end). `maxBytes` itself is at most 16 MiB: a larger request
 * is a `RangeError`, because the body is held in memory twice while it is read.
 */
export async function downloadOutput(
  ctx: TapisContext,
  uuid: string,
  path: string,
  maxBytes: number,
): Promise<Uint8Array> {
  return (await fetchOutput(ctx, uuid, path, maxBytes, false)).bytes;
}

/**
 * The same download, for a file a caller wants a PREFIX of (a log): the first `maxBytes` and whether
 * there was more, never `invalid_response` for a file that is merely long. The stream is read to the
 * bound and cancelled; no `Range` header is sent (no tenant has been shown to honour one, UNVERIFIED).
 * Additive: `downloadOutput` is unchanged.
 */
export async function downloadOutputPrefix(
  ctx: TapisContext,
  uuid: string,
  path: string,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  return fetchOutput(ctx, uuid, path, maxBytes, true);
}

// --- Health ------------------------------------------------------------------------------------

/**
 * `GET /v3/jobs/healthcheck`, which the specification says needs no authorization: it answers
 * whether the tenant's Jobs service can be reached, and says nothing about a credential. Throws
 * `unconfigured` when there is no usable address, and any other `TapisError` as the call failed.
 */
export async function tapisHealth(
  env: TapisEnv,
  options: { timeoutMs?: number; retryDelayMs?: number; maxAttempts?: number } = {},
): Promise<void> {
  const base = tapisBaseOrProblem(env);
  if ("problem" in base) throw new TapisError("unconfigured", "health check");
  const what = "health check";
  const { result } = await withRetry(
    () =>
      send({
        url: `${base.baseUrl}/v3/jobs/healthcheck`,
        method: "GET",
        headers: { Accept: "application/json" },
        what,
        timeoutMs: options.timeoutMs,
        maxBytes: TAPIS_MAX_JSON_BYTES,
      }),
    `tapis ${what}`,
    {
      maxAttempts: attemptsFor(options.maxAttempts),
      delayMs: retryDelayFor(options.retryDelayMs),
      isRetryable: (err) => err instanceof TapisError && err.retryable,
    },
  );
  if (
    !TapisHealthResponseSchema.safeParse(parseJsonBody(result.bytes, what, result.status)).success
  ) {
    throw invalidResponse(what, result.status);
  }
}
