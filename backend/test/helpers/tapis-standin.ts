/**
 * A real local HTTP server that stands in for a Tapis tenant (epic #2005 phase A4, #2009; ADR
 * 0118), installed through `globalThis.NEMAR_TAPIS_API_URL` the way the other backend suites install
 * theirs.
 *
 * NO RESPONSE IN THIS FILE WAS RECORDED FROM A REAL TENANT. There is no tenant yet. Every request
 * shape, response shape and status code below is built from Tapis's PUBLISHED documentation and
 * OpenAPI specifications: the Jobs API (`tapis-project/openapi-jobs`, `JobsAPI.yaml`), the Tokens API
 * (`tapis-project/tokens-api`), the Authenticator (`tapis-project/authenticator`) and the technical
 * documentation of the Jobs and Notifications services. Where the specification and the
 * documentation's examples spell a field differently (the Jobs specification calls a history event's
 * detail `eventDetail` and the documentation's example `jobStatus`; the specification types a job's
 * `parameterSet` as a string and the documentation shows an object; the specification's `FileInfo`
 * says `url` and the example says `uri`), this server answers with the documentation's example where
 * it differs, and the client under test accepts both. What a real tenant does stays UNVERIFIED until
 * the first real job; the pull request that added this file lists what.
 *
 * Nothing here stands in for NEMAR logic. The client under test (`services/tapis/*`) is the
 * production one; this server only answers HTTP.
 *
 * WHAT IT SPEAKS (paths are the specifications' `/jobs/...` under `/v3`):
 *  - `POST /v3/oauth2/tokens`: the password grant. It answers 201 with `result.access_token.
 *    access_token` and `expires_in`, or 401 for another password.
 *  - `POST /v3/tokens`: a user token minted by a service credential. It needs the service token in
 *    `X-Tapis-Token` (401 otherwise) and a body of `account_type`, `token_tenant_id`,
 *    `token_username` and `access_token_ttl`.
 *  - `GET /v3/jobs/healthcheck` and `/readycheck`: no token needed.
 *  - `POST /v3/jobs/submit`, `GET /v3/jobs/<uuid>`, `/history`, `/status`, `POST /v3/jobs/<uuid>/cancel`
 *    (409 for a job already terminal), `GET /v3/jobs/list`, `POST /v3/jobs/search` (the documented
 *    `{ "search": ["tags IN ('x')"] }` body, and `select`), `POST /v3/jobs/subscribe/<uuid>`, and
 *    `GET /v3/jobs/<uuid>/output/list/<path>` and `.../output/download/<path>`.
 *  - Every other call needs `X-Tapis-Token` to be a token this server minted and has not expired.
 *
 * WHAT IT DOES NOT DO: the real service decides who may see a job (the owner, the creator or a tenant
 * administrator). This server follows the documentation's `listType`: `MY_JOBS` is the jobs whose
 * owner or creator is the token's user, `SHARED_JOBS` the jobs shared with that user (`shareJob`), and
 * `ALL_JOBS` both, NOT every job in the tenant (the documentation says "all jobs including both shared
 * and owned"; whether a tenant's administrator sees more is UNVERIFIED). It does not run Slurm, stage a
 * file or retry a webhook.
 *
 * SIMULATING A JOB: `advance(uuid, status, condition?)` moves a job along, records the history event
 * and the notification event, and sets the timestamps the way the documentation says Tapis does.
 * `fireWebhook(uuid)` POSTs the newest event to the address a subscription recorded, as the
 * Notifications service does (a JSON body shaped like a notification, `User-Agent: Tapis/v3`, no
 * signature).
 *
 * FAILURE MODES, each for the next `times` matching requests (default 1), consumed in order:
 *  - `fail(route, status)`: that HTTP status with a JSON error body;
 *  - `hang(route)`: never answers until the client gives up;
 *  - `nonJson(route)`: a 200 whose body is HTML, as a proxy's error page is;
 *  - `respond(route, status, body, times, headers)`: that status, body and headers, as JSON text unless
 *    the body is a string, a `Uint8Array` (sent as bytes), a `ReadableStream` (sent chunked, with no
 *    Content-Length) or a function returning a stream (a new one for each request it answers);
 *  - `expireTokens()`: every token issued so far now answers 401, and a token minted afterwards works
 *    (a lifetime that ended, or a revocation);
 *  - `rejectAllTokens(true)`: every call that needs a token answers 401 even with a fresh one;
 *  - `fullRecords(true)`: the search ignores `select` and the list serves the FULL job record, the
 *    `parameterSet` with the launch specification and the `subscriptions` included, as a tenant that
 *    ignored the request's field list would; `fullRecordsServed` says which jobs it really did that for
 *    (noted only when the answer carries both fields);
 *  - `down()` and `up()`: the server stops listening, and starts again on the same port.
 *
 * Every request is logged with its method, path and query, headers (names lower case), body text and
 * the status it was answered with, so a test asserts on what was actually sent. The tokens and
 * passwords in the log are the stand-in's own, never a credential.
 *
 * Start it by hand with `bun backend/test/helpers/tapis-standin.ts` (PORT sets the port).
 */

import { randomUUID } from "node:crypto";
import type { Server } from "bun";

/** A route as a test names it; `*` stands for any path below it. */
export type StandinRoute =
  | "POST /v3/oauth2/tokens"
  | "POST /v3/tokens"
  | "GET /v3/jobs/healthcheck"
  | "GET /v3/jobs/readycheck"
  | "POST /v3/jobs/submit"
  | "GET /v3/jobs/list"
  | "POST /v3/jobs/search"
  | "GET /v3/jobs/:uuid"
  | "GET /v3/jobs/:uuid/history"
  | "GET /v3/jobs/:uuid/status"
  | "POST /v3/jobs/:uuid/cancel"
  | "POST /v3/jobs/subscribe/:uuid"
  | "GET /v3/jobs/:uuid/output/list/*"
  | "GET /v3/jobs/:uuid/output/download/*";

export interface StandinRequest {
  method: string;
  /** The path and the query, as the server received them. */
  path: string;
  route: StandinRoute | "unknown";
  /** Header names are lower case. */
  headers: Record<string, string>;
  body: string;
  status: number;
}

export interface StandinSubscription {
  jobUuid: string;
  address: string;
  ttlminutes: number | null;
  eventCategoryFilter: string | null;
  /** The request body as it was sent. */
  body: Record<string, unknown>;
}

export interface StandinJob {
  uuid: string;
  status: string;
  condition: string | null;
  tags: string[];
  owner: string;
  /** The whole record as `GET /v3/jobs/<uuid>` answers it. */
  record: Record<string, unknown>;
  history: Array<Record<string, unknown>>;
  /** The notification events `fireWebhook` sends, oldest first. */
  events: Array<{ type: string; data: Record<string, unknown>; seq: number; timestamp: string }>;
}

export interface TapisStandinOptions {
  port?: number;
  /** The tenant the server says it is. Default `standin`. */
  tenantId?: string;
  username?: string;
  password?: string;
  serviceToken?: string;
  /** Seconds a minted token lives, as `expires_in` says. Default 14400 (four hours). */
  expiresIn?: number;
}

export interface TapisStandin {
  /** `http://127.0.0.1:<port>`, no trailing slash. */
  url: string;
  tenantId: string;
  username: string;
  password: string;
  serviceToken: string;
  log: StandinRequest[];
  jobs: Map<string, StandinJob>;
  subscriptions: StandinSubscription[];
  /** Move a job to a status. Throws for a status the specification does not list. */
  advance(uuid: string, status: string, condition?: string | null): StandinJob;
  /** POST the job's newest event to its subscription's address; the answer of that address. */
  fireWebhook(uuid: string): Promise<{ status: number; body: string }>;
  /** A file the job's output listing and download serve. */
  setOutput(uuid: string, path: string, content: string | Uint8Array): void;
  fail(route: StandinRoute, status: number, times?: number): void;
  hang(route: StandinRoute, times?: number): void;
  nonJson(route: StandinRoute, times?: number): void;
  respond(
    route: StandinRoute,
    status: number,
    body: unknown,
    times?: number,
    headers?: Record<string, string>,
  ): void;
  expireTokens(): void;
  rejectAllTokens(on: boolean): void;
  /** Search ignores `select` and list serves whole records (see the header). */
  fullRecords(on: boolean): void;
  /** The uuids of the jobs `fullRecords` served whole, in order. */
  fullRecordsServed: string[];
  /** Share a job with a user, so `SHARED_JOBS` and `ALL_JOBS` list it for them. */
  shareJob(uuid: string, user: string): void;
  down(): void;
  up(): void;
  /** How many tokens it has minted, by route. */
  mints(): { password: number; service: number };
  /** Forget jobs, subscriptions, outputs, the log, tokens and every failure mode. */
  reset(): void;
  stop(): void;
}

type Behaviour =
  | { route: StandinRoute; kind: "fail"; status: number; left: number }
  | { route: StandinRoute; kind: "hang"; left: number }
  | { route: StandinRoute; kind: "nonJson"; left: number }
  | {
      route: StandinRoute;
      kind: "respond";
      status: number;
      body: unknown;
      left: number;
      headers: Record<string, string>;
    };

/**
 * The thirteen statuses of the Jobs specification's `Job.status` enum (`JobsAPI.yaml`), written out
 * here and not imported, so a drift of NEMAR's own list (`TAPIS_JOB_STATUSES`) from the specification is
 * a test failure and not an agreement of two copies of one mistake.
 */
export const SPEC_JOB_STATUSES = [
  "PENDING",
  "PROCESSING_INPUTS",
  "STAGING_INPUTS",
  "STAGING_JOB",
  "SUBMITTING_JOB",
  "QUEUED",
  "RUNNING",
  "ARCHIVING",
  "BLOCKED",
  "PAUSED",
  "FINISHED",
  "CANCELLED",
  "FAILED",
] as const;

const STATUS_SET: ReadonlySet<string> = new Set(SPEC_JOB_STATUSES);
const TERMINAL = new Set(["FINISHED", "FAILED", "CANCELLED"]);
const DEFAULT_CONDITION: Record<string, string> = {
  FINISHED: "NORMAL_COMPLETION",
  CANCELLED: "CANCELLED_BY_USER",
  FAILED: "JOB_INTERNAL_ERROR",
};

const ENVELOPE_VERSION = "1.0.0-standin";

function envelope(message: string, result: unknown, metadata: unknown = null) {
  return { result, status: "success", message, version: ENVELOPE_VERSION, metadata };
}

function errorBody(message: string) {
  return { result: null, status: "error", message, version: ENVELOPE_VERSION, metadata: null };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const nowIso = () => new Date().toISOString();

/** The route a request is, and the job uuid and path it carries. */
function classify(
  method: string,
  pathname: string,
): { route: StandinRoute | "unknown"; uuid?: string; rest?: string } {
  const exact: Record<string, StandinRoute> = {
    "POST /v3/oauth2/tokens": "POST /v3/oauth2/tokens",
    "POST /v3/tokens": "POST /v3/tokens",
    "GET /v3/jobs/healthcheck": "GET /v3/jobs/healthcheck",
    "GET /v3/jobs/readycheck": "GET /v3/jobs/readycheck",
    "POST /v3/jobs/submit": "POST /v3/jobs/submit",
    "GET /v3/jobs/list": "GET /v3/jobs/list",
    "POST /v3/jobs/search": "POST /v3/jobs/search",
  };
  const hit = exact[`${method} ${pathname}`];
  if (hit) return { route: hit };
  let m = /^\/v3\/jobs\/subscribe\/([^/]+)$/.exec(pathname);
  if (m && method === "POST") return { route: "POST /v3/jobs/subscribe/:uuid", uuid: m[1] };
  m = /^\/v3\/jobs\/([^/]+)\/output\/(list|download)\/(.*)$/.exec(pathname);
  if (m && method === "GET") {
    return {
      route:
        m[2] === "list"
          ? "GET /v3/jobs/:uuid/output/list/*"
          : "GET /v3/jobs/:uuid/output/download/*",
      uuid: m[1],
      rest: m[3],
    };
  }
  m = /^\/v3\/jobs\/([^/]+)\/(history|status|cancel)$/.exec(pathname);
  if (m) {
    if (m[2] === "history" && method === "GET")
      return { route: "GET /v3/jobs/:uuid/history", uuid: m[1] };
    if (m[2] === "status" && method === "GET")
      return { route: "GET /v3/jobs/:uuid/status", uuid: m[1] };
    if (m[2] === "cancel" && method === "POST")
      return { route: "POST /v3/jobs/:uuid/cancel", uuid: m[1] };
  }
  m = /^\/v3\/jobs\/([^/]+)$/.exec(pathname);
  if (m && method === "GET") return { route: "GET /v3/jobs/:uuid", uuid: m[1] };
  return { route: "unknown" };
}

export function startTapisStandin(options: TapisStandinOptions = {}): TapisStandin {
  const tenantId = options.tenantId ?? "standin";
  const username = options.username ?? "standin-service-user";
  const password = options.password ?? "standin-password";
  const serviceToken = options.serviceToken ?? "standin-service-token";
  const expiresIn = options.expiresIn ?? 14_400;

  const log: StandinRequest[] = [];
  const jobs = new Map<string, StandinJob>();
  const subscriptions: StandinSubscription[] = [];
  const outputs = new Map<string, Map<string, Uint8Array>>();
  const tokens = new Map<string, { username: string; expired: boolean }>();
  let behaviours: Behaviour[] = [];
  let rejectAll = false;
  let fullRecordsOn = false;
  const fullRecordsServed: string[] = [];
  const shares = new Map<string, Set<string>>();
  let mintCounts = { password: 0, service: 0 };
  let tokenSeq = 0;
  let eventSeq = 0;
  const releases = new Set<() => void>();

  const encoder = new TextEncoder();

  function issueToken(forUser: string) {
    tokenSeq += 1;
    const token = `standin-token-${tokenSeq}-${randomUUID().slice(0, 8)}`;
    tokens.set(token, { username: forUser, expired: false });
    return json(
      envelope("TOKEN_CREATED Token created.", {
        access_token: {
          access_token: token,
          expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
          expires_in: expiresIn,
          jti: randomUUID(),
        },
      }),
      201,
    );
  }

  /** The user a request's token was minted for, or a refusal. */
  function authenticate(req: Request): { username: string } | Response {
    const token = req.headers.get("x-tapis-token");
    if (rejectAll) return json(errorBody("TAPIS_SECURITY_AUTH Invalid token."), 401);
    const entry = token ? tokens.get(token) : undefined;
    if (!entry || entry.expired) {
      return json(errorBody("TAPIS_SECURITY_AUTH Missing or invalid token."), 401);
    }
    return { username: entry.username };
  }

  function nextBehaviour(route: StandinRoute): Behaviour | undefined {
    const index = behaviours.findIndex((b) => b.route === route && b.left > 0);
    if (index === -1) return undefined;
    const b = behaviours[index] as Behaviour;
    b.left -= 1;
    return b;
  }

  function jobSummary(job: StandinJob, select: string[] | null): Record<string, unknown> {
    const full = job.record;
    if (select === null) return full;
    const out: Record<string, unknown> = {};
    for (const key of select) if (key in full) out[key] = full[key];
    return out;
  }

  /**
   * What is about to be sent for a job; it is noted in `fullRecordsServed` only when it really is the
   * whole record, the `parameterSet` (with the launch specification) and the `subscriptions` in it, so
   * the note is a fact about the answer and not about the mode that was switched on.
   */
  function served<T extends Record<string, unknown>>(job: StandinJob, summary: T): T {
    if ("parameterSet" in summary && "subscriptions" in summary) fullRecordsServed.push(job.uuid);
    return summary;
  }

  function listDto(job: StandinJob) {
    const r = job.record;
    return {
      uuid: r.uuid,
      name: r.name,
      owner: r.owner,
      appId: r.appId,
      created: r.created,
      status: r.status,
      condition: r.condition,
      remoteStarted: r.remoteStarted,
      ended: r.ended,
      tenant: r.tenant,
      execSystemId: r.execSystemId,
      archiveSystemId: r.archiveSystemId,
      appVersion: r.appVersion,
      lastUpdated: r.lastUpdated,
    };
  }

  function pageOf<T>(all: T[], url: URL): { page: T[]; limit: number; skip: number } {
    const limit = Number(url.searchParams.get("limit") ?? 100);
    const skip = Number(url.searchParams.get("skip") ?? 0);
    return {
      page: all.slice(skip, skip + (Number.isFinite(limit) && limit > 0 ? limit : 100)),
      limit,
      skip,
    };
  }

  function sharedWith(user: string): StandinJob[] {
    return [...jobs.values()].filter((j) => shares.get(j.uuid)?.has(user));
  }

  /** The documentation's `listType`: own, shared, or both (not every job in the tenant). */
  function visibleTo(user: string, listType: string): StandinJob[] {
    const own = [...jobs.values()].filter(
      (j) => j.record.owner === user || j.record.createdby === user,
    );
    if (listType === "SHARED_JOBS") return sharedWith(user);
    if (listType === "ALL_JOBS")
      return [...own, ...sharedWith(user).filter((j) => !own.includes(j))];
    return own;
  }

  function submit(body: Record<string, unknown> | null, caller: string): Response {
    if (body === null) return json(errorBody("JOBS_INVALID_REQUEST Not a JSON object."), 400);
    for (const field of ["name", "appId", "appVersion"] as const) {
      if (typeof body[field] !== "string" || (body[field] as string) === "") {
        return json(errorBody(`JOBS_INVALID_REQUEST Missing required field ${field}.`), 400);
      }
    }
    const uuid = `${randomUUID()}-007`;
    const created = nowIso();
    const requestSet = (body.parameterSet ?? {}) as Record<string, unknown>;
    const envVariables = [
      { key: "_tapisJobUUID", value: uuid, include: null, description: null, notes: null },
      {
        key: "_tapisJobOwner",
        value: String(body.owner ?? caller),
        include: null,
        description: null,
        notes: null,
      },
      ...(Array.isArray(requestSet.envVariables) ? requestSet.envVariables : []),
    ];
    const record: Record<string, unknown> = {
      id: jobs.size + 1,
      name: body.name,
      owner: body.owner ?? caller,
      tenant: tenantId,
      description: body.description ?? null,
      status: "PENDING",
      condition: null,
      lastMessage: "Setting job status to PENDING.",
      created,
      ended: null,
      lastUpdated: created,
      uuid,
      appId: body.appId,
      appVersion: body.appVersion,
      archiveOnAppError: true,
      archiveMode: body.archiveMode ?? "ALWAYS",
      dynamicExecSystem: false,
      execSystemId: body.execSystemId ?? "standin-exec",
      execSystemExecDir: `/workdir/jobs/${uuid}`,
      execSystemInputDir: `/workdir/jobs/${uuid}`,
      execSystemOutputDir: `/workdir/jobs/${uuid}/output`,
      execSystemLogicalQueue: body.execSystemLogicalQueue ?? null,
      archiveSystemId: body.archiveSystemId ?? "standin-exec",
      archiveSystemDir: `/jobs/${uuid}/archive`,
      dtnSystemId: null,
      dtnSystemInputDir: null,
      dtnSystemOutputDir: null,
      nodeCount: body.nodeCount ?? 1,
      coresPerNode: body.coresPerNode ?? 1,
      memoryMB: body.memoryMB ?? 100,
      maxMinutes: body.maxMinutes ?? 10,
      fileInputs: [],
      parameterSet: {
        appArgs: [],
        logConfig: { stderrFilename: "tapisjob.out", stdoutFilename: "tapisjob.out" },
        envVariables,
        // Tapis's default is to archive the launch files; a request's `archiveFilter` is merged over
        // that default (ASSUMED, unverified: the documentation says the includes and excludes arrays
        // are merged and is silent on this flag).
        archiveFilter: {
          excludes: [],
          includes: [],
          includeLaunchFiles: true,
          ...((requestSet.archiveFilter as Record<string, unknown> | undefined) ?? {}),
        },
        containerArgs: [],
        schedulerOptions: Array.isArray(requestSet.schedulerOptions)
          ? requestSet.schedulerOptions
          : [],
      },
      subscriptions: [],
      blockedCount: 0,
      remoteJobId: null,
      remoteJobId2: null,
      remoteOutcome: null,
      remoteResultInfo: null,
      remoteQueue: null,
      remoteSubmitted: null,
      remoteStarted: null,
      remoteEnded: null,
      tapisQueue: "tapis.jobq.submit.DefaultQueue",
      visible: true,
      createdby: caller,
      createdbyTenant: tenantId,
      tags: Array.isArray(body.tags) ? body.tags : [],
      jobType: body.jobType ?? "BATCH",
      notes: body.notes ?? {},
    };
    const job: StandinJob = {
      uuid,
      status: "PENDING",
      condition: null,
      tags: record.tags as string[],
      owner: record.owner as string,
      record,
      history: [],
      events: [],
    };
    jobs.set(uuid, job);
    recordEvent(job, "PENDING", null);
    return json(envelope(`JOBS_SUBMITTED Job ${uuid} submitted.`, job.record));
  }

  function recordEvent(job: StandinJob, status: string, previous: string | null) {
    const created = nowIso();
    const message = previous
      ? `The job has transitioned to a new status: ${status}. The previous job status was ${previous}.`
      : `The job has transitioned to a new status: ${status}.`;
    job.history.push({
      event: "JOB_NEW_STATUS",
      created,
      jobStatus: status,
      description: message,
      transferTaskUuid: null,
      transferSummary: {},
    });
    eventSeq += 1;
    const data: Record<string, unknown> = {
      newJobStatus: status,
      oldJobStatus: previous,
      jobName: job.record.name,
      jobUuid: job.uuid,
      jobOwner: job.owner,
      message,
    };
    if (TERMINAL.has(status)) {
      Object.assign(data, {
        blockedCount: 0,
        condition: job.condition,
        remoteJobId: job.record.remoteJobId,
        remoteJobId2: null,
        remoteOutcome: status === "FINISHED" ? "FINISHED" : "FAILED",
        remoteResultInfo: status === "FINISHED" ? "0" : "1",
        remoteQueue: job.record.remoteQueue,
        remoteSubmitted: job.record.remoteSubmitted,
        remoteStarted: job.record.remoteStarted,
        remoteEnded: job.record.remoteEnded,
      });
    }
    job.events.push({
      type: `jobs.JOB_NEW_STATUS.${status}`,
      data,
      seq: eventSeq,
      timestamp: created,
    });
  }

  function advance(uuid: string, status: string, condition?: string | null): StandinJob {
    const job = jobs.get(uuid);
    if (!job) throw new Error(`no such job ${uuid}`);
    if (!STATUS_SET.has(status)) throw new Error(`${status} is not a Tapis job status`);
    const previous = job.status;
    const at = nowIso();
    job.status = status;
    job.condition = condition !== undefined ? condition : (DEFAULT_CONDITION[status] ?? null);
    job.record.status = status;
    job.record.condition = job.condition;
    job.record.lastMessage = `Setting job status to ${status}.`;
    job.record.lastUpdated = at;
    if (status === "QUEUED") {
      job.record.remoteSubmitted = at;
      job.record.remoteJobId = `${randomUUID().replaceAll("-", "")}`;
      job.record.remoteQueue = job.record.execSystemLogicalQueue;
    }
    if (status === "RUNNING") {
      job.record.remoteSubmitted ??= at;
      job.record.remoteStarted = at;
    }
    if (TERMINAL.has(status)) {
      job.record.ended = at;
      job.record.remoteEnded = job.record.remoteStarted ? at : null;
      job.record.remoteOutcome = status === "FINISHED" ? "FINISHED" : "FAILED";
      job.record.remoteResultInfo = status === "FINISHED" ? "0" : "1";
    }
    recordEvent(job, status, previous);
    return job;
  }

  function safeOutputPath(path: string): string {
    return path.replace(/^\/+/, "");
  }

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const bodyText = req.method === "GET" || req.method === "HEAD" ? "" : await req.text();
    const headers: Record<string, string> = {};
    req.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const { route, uuid, rest } = classify(req.method, url.pathname);
    const entry: StandinRequest = {
      method: req.method,
      path: url.pathname + url.search,
      route,
      headers,
      body: bodyText,
      status: 0,
    };
    log.push(entry);
    const answer = async (): Promise<Response> => {
      if (route === "unknown") return json(errorBody("No such route."), 404);
      const forced = nextBehaviour(route);
      if (forced) {
        if (forced.kind === "fail") {
          return json(errorBody(`Forced ${forced.status}.`), forced.status);
        }
        if (forced.kind === "nonJson") {
          return new Response("<html><body>Bad gateway page</body></html>", {
            status: 200,
            headers: { "Content-Type": "text/html" },
          });
        }
        if (forced.kind === "respond") {
          // A stream is sent chunked, with no Content-Length, as a server that never says how long it is.
          const body =
            typeof forced.body === "function" ? (forced.body as () => unknown)() : forced.body;
          return typeof body === "string" ||
            body instanceof ReadableStream ||
            body instanceof Uint8Array
            ? new Response(body as BodyInit, {
                status: forced.status,
                headers: forced.headers,
              })
            : new Response(JSON.stringify(body), {
                status: forced.status,
                headers: { "Content-Type": "application/json", ...forced.headers },
              });
        }
        await new Promise<void>((resolve) => {
          releases.add(resolve);
          req.signal.addEventListener("abort", () => resolve());
        });
        return new Response(null, { status: 499 });
      }

      if (route === "POST /v3/oauth2/tokens") {
        const body = parseJson(bodyText);
        if (body === null || body.grant_type !== "password") {
          return json(errorBody("AUTH_INVALID_GRANT Unsupported grant."), 400);
        }
        if (body.username !== username || body.password !== password) {
          return json(errorBody("AUTH_BAD_CREDENTIALS Invalid username or password."), 401);
        }
        mintCounts.password += 1;
        return issueToken(username);
      }
      if (route === "POST /v3/tokens") {
        if (req.headers.get("x-tapis-token") !== serviceToken) {
          return json(errorBody("TOKENS_UNAUTHORIZED Not a service token."), 401);
        }
        const body = parseJson(bodyText);
        if (
          body === null ||
          body.account_type !== "user" ||
          typeof body.token_username !== "string" ||
          body.token_tenant_id !== tenantId
        ) {
          return json(errorBody("TOKENS_INVALID_REQUEST Bad token request."), 400);
        }
        mintCounts.service += 1;
        return issueToken(body.token_username);
      }
      if (route === "GET /v3/jobs/healthcheck" || route === "GET /v3/jobs/readycheck") {
        return json(envelope("Jobs is ready.", { checkNum: 1, databaseAccess: true }));
      }

      const who = authenticate(req);
      if (who instanceof Response) return who;

      if (route === "POST /v3/jobs/submit") return submit(parseJson(bodyText), who.username);

      if (route === "GET /v3/jobs/list") {
        const listType = url.searchParams.get("listType") ?? "MY_JOBS";
        const visible = visibleTo(who.username, listType);
        const { page: jobsOnPage, limit, skip } = pageOf(visible, url);
        const page = jobsOnPage.map((j) => served(j, fullRecordsOn ? j.record : listDto(j)));
        return json(
          envelope("JOBS_LIST_RETRIEVED Jobs list retrieved.", page, {
            recordCount: page.length,
            recordLimit: limit,
            recordsSkipped: skip,
            orderBy: null,
            startAfter: null,
            totalCount: -1,
          }),
        );
      }

      if (route === "POST /v3/jobs/search") {
        const body = parseJson(bodyText);
        const clauses = body?.search;
        if (!Array.isArray(clauses) || clauses.some((c) => typeof c !== "string")) {
          return json(errorBody("JOBS_INVALID_SEARCH A search body is { search: [...] }."), 400);
        }
        const match = /^\s*\(?\s*tags\s+IN\s*\(\s*'([^']+)'\s*\)\s*\)?\s*$/i.exec(
          clauses.join(" "),
        );
        if (!match) return json(errorBody("JOBS_INVALID_SEARCH Unsupported condition."), 400);
        const tag = match[1] as string;
        const listType = url.searchParams.get("listType") ?? "MY_JOBS";
        const select = url.searchParams.get("select");
        // `fullRecords` makes this ignore the field list, as a tenant that did not honour it would.
        const fields = select && !fullRecordsOn ? select.split(",").map((s) => s.trim()) : null;
        const found = visibleTo(who.username, listType).filter((j) => j.tags.includes(tag));
        const { page, limit, skip } = pageOf(found, url);
        return json(
          envelope(
            "JOBS_SEARCH_RESULT_LIST_RETRIEVED Jobs search list retrieved.",
            page.map((j) => served(j, jobSummary(j, fields))),
            {
              recordCount: page.length,
              recordLimit: limit,
              recordsSkipped: skip,
              orderBy: null,
              startAfter: null,
              totalCount: found.length,
            },
          ),
        );
      }

      const job = uuid ? jobs.get(uuid) : undefined;
      if (!job) {
        return json(
          { ...errorBody("JOBS_JOB_NOT_FOUND No such job."), result: { name: "x" } },
          404,
        );
      }

      if (route === "GET /v3/jobs/:uuid")
        return json(envelope("JOBS_RETRIEVED Job retrieved.", job.record));
      if (route === "GET /v3/jobs/:uuid/status") {
        return json(
          envelope("JOBS_STATUS_RETRIEVED", { status: job.status, condition: job.condition }),
        );
      }
      if (route === "GET /v3/jobs/:uuid/history") {
        const { page, limit, skip } = pageOf(job.history, url);
        return json(
          envelope("JOBS_HISTORY_RETRIEVED Job history retrieved.", page, {
            recordCount: page.length,
            recordLimit: limit,
            recordsSkipped: skip,
            orderBy: null,
            startAfter: null,
            totalCount: -1,
          }),
        );
      }
      if (route === "POST /v3/jobs/:uuid/cancel") {
        if (TERMINAL.has(job.status)) {
          return json(
            {
              ...errorBody(`JOBS_JOB_STATE_CONFLICT Job is already ${job.status}.`),
              result: { name: "x" },
            },
            409,
          );
        }
        advance(job.uuid, "CANCELLED", "CANCELLED_BY_USER");
        return json(
          envelope(`JOBS_CANCEL_ACCEPTED Job ${job.uuid} cancellation initiated.`, {
            message: `Job ${job.uuid} cancellation initiated.`,
          }),
        );
      }
      if (route === "POST /v3/jobs/subscribe/:uuid") {
        const body = parseJson(bodyText);
        const targets = body?.deliveryTargets;
        const first = Array.isArray(targets) ? (targets[0] as Record<string, unknown>) : null;
        if (
          body === null ||
          first === null ||
          first?.deliveryMethod !== "WEBHOOK" ||
          typeof first.deliveryAddress !== "string"
        ) {
          return json(
            errorBody("JOBS_INVALID_SUBSCRIPTION A webhook delivery target is needed."),
            400,
          );
        }
        subscriptions.push({
          jobUuid: job.uuid,
          address: first.deliveryAddress,
          ttlminutes: typeof body.ttlminutes === "number" ? body.ttlminutes : null,
          eventCategoryFilter:
            typeof body.eventCategoryFilter === "string" ? body.eventCategoryFilter : null,
          body,
        });
        return json(
          envelope("JOBS_SUBSCRIPTION_CREATED Subscription created.", {
            url: `${base()}/v3/notifications/subscriptions/${randomUUID()}`,
          }),
        );
      }
      if (route === "GET /v3/jobs/:uuid/output/list/*") {
        if (!TERMINAL.has(job.status) && url.searchParams.get("allowIfRunning") !== "true") {
          return json(errorBody("JOBS_JOB_NOT_TERMINAL The job is not in a terminal state."), 400);
        }
        const prefix = safeOutputPath(decodeURIComponent(rest ?? ""));
        const files = outputs.get(job.uuid) ?? new Map<string, Uint8Array>();
        const listed = [...files.entries()]
          .filter(([path]) => path.startsWith(prefix))
          .map(([path, bytes]) => ({
            mimeType: null,
            type: "file",
            owner: "1003",
            group: "1003",
            nativePermissions: "rw-r--r--",
            uri: `tapis://standin-exec/jobs/${job.uuid}/archive/${path}`,
            lastModified: nowIso(),
            name: path.split("/").pop(),
            path,
            size: bytes.length,
          }));
        const { page, limit, skip } = pageOf(listed, url);
        return json(
          envelope("JOBS_OUTPUT_FILES_LIST_RETRIEVED Output files listed.", page, {
            recordCount: page.length,
            recordLimit: limit,
            recordsSkipped: skip,
            orderBy: null,
            startAfter: null,
            totalCount: 0,
          }),
        );
      }
      if (route === "GET /v3/jobs/:uuid/output/download/*") {
        const path = safeOutputPath(decodeURIComponent(rest ?? ""));
        const bytes = outputs.get(job.uuid)?.get(path);
        if (!bytes)
          return json(
            { ...errorBody("JOBS_OUTPUT_NOT_FOUND No such file."), result: { name: "x" } },
            404,
          );
        return new Response(bytes, {
          status: 200,
          headers: { "Content-Type": "application/octet-stream" },
        });
      }
      return json(errorBody("No such route."), 404);
    };

    let response: Response;
    try {
      response = await answer();
    } catch (err) {
      response = json(
        errorBody(`standin error: ${err instanceof Error ? err.message : "failed"}`),
        500,
      );
    }
    entry.status = response.status;
    return response;
  }

  let server: Server;
  let port = options.port ?? 0;

  function listen(): Server {
    return Bun.serve({ port, hostname: "127.0.0.1", fetch: handle });
  }

  server = listen();
  port = server.port as number;
  const base = () => `http://127.0.0.1:${port}`;

  function addBehaviour(b: Behaviour) {
    behaviours.push(b);
  }

  const standin: TapisStandin = {
    get url() {
      return base();
    },
    tenantId,
    username,
    password,
    serviceToken,
    log,
    jobs,
    subscriptions,
    advance,
    async fireWebhook(uuid) {
      const job = jobs.get(uuid);
      if (!job) throw new Error(`no such job ${uuid}`);
      const subscription = [...subscriptions].reverse().find((s) => s.jobUuid === uuid);
      if (!subscription) throw new Error(`job ${uuid} has no subscription`);
      const event = job.events[job.events.length - 1];
      if (!event) throw new Error(`job ${uuid} has no event`);
      const notification = {
        uuid: randomUUID(),
        tenant: tenantId,
        subscriptionName: `jobs~${job.owner}~${tenantId}~${uuid}~abcd`,
        eventUuid: randomUUID(),
        event: {
          source: "https://tapis.io/jobs",
          type: event.type,
          subject: uuid,
          data: JSON.stringify(event.data),
          seriesId: uuid,
          timestamp: event.timestamp,
          deleteSubscriptionsMatchingSubject: TERMINAL.has(job.status),
          tenant: tenantId,
          user: "jobs",
          received: event.timestamp,
          uuid: randomUUID(),
          seriesSeqCount: event.seq,
        },
        deliveryTarget: { deliveryMethod: "WEBHOOK", deliveryAddress: subscription.address },
        created: nowIso(),
      };
      const res = await fetch(subscription.address, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "Tapis/v3" },
        body: JSON.stringify(notification),
      });
      return { status: res.status, body: await res.text() };
    },
    setOutput(uuid, path, content) {
      const bytes = typeof content === "string" ? encoder.encode(content) : content;
      const files = outputs.get(uuid) ?? new Map<string, Uint8Array>();
      files.set(safeOutputPath(path), bytes);
      outputs.set(uuid, files);
    },
    fail: (route, status, times = 1) => addBehaviour({ route, kind: "fail", status, left: times }),
    hang: (route, times = 1) => addBehaviour({ route, kind: "hang", left: times }),
    nonJson: (route, times = 1) => addBehaviour({ route, kind: "nonJson", left: times }),
    respond: (route, status, body, times = 1, headers = {}) =>
      addBehaviour({ route, kind: "respond", status, body, left: times, headers }),
    expireTokens() {
      for (const entry of tokens.values()) entry.expired = true;
    },
    rejectAllTokens(on) {
      rejectAll = on;
    },
    fullRecords(on) {
      fullRecordsOn = on;
    },
    fullRecordsServed,
    shareJob(uuid, user) {
      const set = shares.get(uuid) ?? new Set<string>();
      set.add(user);
      shares.set(uuid, set);
    },
    down() {
      server.stop(true);
    },
    up() {
      server = listen();
    },
    mints: () => ({ ...mintCounts }),
    reset() {
      log.length = 0;
      jobs.clear();
      subscriptions.length = 0;
      outputs.clear();
      tokens.clear();
      behaviours = [];
      rejectAll = false;
      fullRecordsOn = false;
      fullRecordsServed.length = 0;
      shares.clear();
      mintCounts = { password: 0, service: 0 };
    },
    stop() {
      for (const release of releases) release();
      releases.clear();
      server.stop(true);
    },
  };
  return standin;
}

if (import.meta.main) {
  const standin = startTapisStandin({ port: Number(process.env.PORT ?? 0) });
  console.log(`Tapis stand-in on ${standin.url} (tenant ${standin.tenantId})`);
  console.log(`  password grant: ${standin.username} / ${standin.password}`);
  console.log(`  service token:  ${standin.serviceToken}`);
}
