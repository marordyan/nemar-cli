/**
 * Back-channel logout: telling a client that an account's grants ended (epic #2014 phase #2019; ADR
 * 0119 rule 15; OpenID Connect Back-Channel Logout 1.0).
 *
 * THE INTENT IS A ROW, THE CALL IS HERE. The cascade (`services/oidc-cascade.ts`) writes one
 * `oidc_logout_deliveries` row per client that registered an address, inside the batch that ends the
 * grants. Nothing in that batch touches the network: a partner's server must never be able to slow,
 * fail or block a revocation, and a delivery that fails never undoes one. This file sends what the
 * rows say, afterwards: once from `waitUntil` right after the commit
 * ({@link deferLogoutDelivery}), and again from the production-only retry tick every half hour
 * ({@link runOidcLogoutRetryTick}), on the schedule in `OIDC_LOGOUT_RETRY_DELAYS_SECONDS`.
 *
 * THE MAIN RISK SURFACE is that this is the Worker making an OUTBOUND request to an address somebody
 * else chose, so every rule below is a fence:
 *   - ONLY THE ADDRESS THE REGISTRY VALIDATED. The owner registers it (`validateClientInput`: https,
 *     canonical, no user information, and in production a named host and not a loopback or an IP
 *     literal), the table CHECKs `https://`, and {@link logoutAddressVerdict} asks again at send time,
 *     because a row is read at send time and not at registration. An address that fails is recorded
 *     `failed` (`address_refused`) and never requested.
 *   - OUTSIDE PRODUCTION NOTHING REACHES A REAL HOST. The dev Worker shares real accounts and a
 *     partner's address may be a real host, so a delivery is sent only to a loopback address or a host
 *     the owner listed in `OIDC_LOGOUT_DEV_HOSTS`, and is otherwise recorded `fenced`. The fence fails
 *     closed the other way from `isNonProductionEnv`: only ENVIRONMENT exactly `production` sends to an
 *     arbitrary https host, so an unset or mistyped value is fenced.
 *   - NEVER FOLLOW A REDIRECT. `redirect: "manual"`: a 3xx is the answer, recorded `failed`
 *     (`redirect`), because the signed token is for the registered address and for no other.
 *   - BOUNDED TIME AND SIZE. {@link OIDC_LOGOUT_TIMEOUT_MS} for the whole exchange, an answer's body is
 *     never read (it is cancelled), and what is sent is one short form field.
 *   - NOTHING BUT THE SIGNED TOKEN GOES OUT: no `Authorization`, no cookie, no client secret, no API
 *     key. A logout token proves itself by its signature, which the partner checks against the key set.
 *   - ATTEMPTS ARE BOUNDED AND RECORDED: one, and five retries (1 minute, 5 minutes, 30 minutes, 2
 *     hours, 12 hours), then `failed`. A 5xx, a 408, a 429, a timeout and a network failure are
 *     retried; any other 4xx, a redirect and any other answer are not (retrying a refusal does not
 *     change it). A 408 or 429 may carry a `Retry-After`, which is read as a LOWER bound for the wait
 *     (the longer of it and the schedule's, at most 12 hours), so a partner can slow a delivery and can
 *     never add an attempt. What is recorded is a status and a fixed word
 *     (`OIDC_LOGOUT_ERROR_CLASSES`), never the text of an error or of an answer.
 *
 * WHAT THIS DOES NOT GUARANTEE, said plainly: the sender does not resolve a name itself, so a registered
 * name that a partner points at an address of its own choosing is still requested. That is the partner's
 * own server by definition, and the request carries nothing but a token that names that partner as its
 * audience. A Worker has no route to a private network, and an IP literal is refused in production.
 *
 * THE TOKEN is a JWT, ES256 under the current key (the one the identity tokens use), header `typ:
 * logout+jwt` (RFC 8725 explicit typing), claims `iss`, `aud` (the client's public id), `iat`, `exp` (two
 * minutes), a `jti` that is new for every attempt (so a retry is a new token and never a replay of the
 * old), `sub`, and `events` holding the back-channel logout event with an empty object. No `nonce` (the
 * specification forbids one) and no `sid` (NEMAR keeps no session id for a client to correlate).
 */

import {
  OIDC_BACKCHANNEL_LOGOUT_EVENT,
  OIDC_LOGOUT_MAX_ATTEMPTS,
  OIDC_LOGOUT_RETRY_AFTER_MAX_SECONDS,
  OIDC_LOGOUT_RETRY_DELAYS_SECONDS,
  OIDC_LOGOUT_TIMEOUT_MS,
  OIDC_LOGOUT_TOKEN_TTL_SECONDS,
  OIDC_LOGOUT_TOKEN_TYP,
  type OidcLogoutErrorClass,
} from "../../../shared/oidc.js";
import type { Bindings } from "../types/bindings.js";
import { errorClassName } from "./github/dispatch.js";
import { isLocalOrLiteral, isLoopbackHost } from "./oidc-clients.js";
import { oidcIssuer, oidcSecret, oidcSecretStatus } from "./oidc-config.js";
import { randomHex } from "./oidc-encoding.js";
import { signJwt } from "./oidc-keys.js";
import {
  type AttemptRecord,
  type DueDelivery,
  claimDelivery,
  dueDeliveries,
  finishWithoutSend,
  pruneDeliveries,
  recordAttempt,
} from "./oidc-logout-store.js";
import { isExactProduction } from "./repull-switches.js";

type LogoutEnv = Pick<
  Bindings,
  "DB" | "ENVIRONMENT" | "API_BASE_URL" | "OIDC_SECRET" | "OIDC_LOGOUT_DEV_HOSTS"
>;

/** What a caller may change of an attempt: the transport (a test's, or a Worker's own) and the time allowed. */
export interface LogoutOptions {
  /** Defaults to the global `fetch`; a test that must reach a loopback stand-in from a production environment passes its own. */
  fetchImpl?: typeof fetch;
  /** Defaults to {@link OIDC_LOGOUT_TIMEOUT_MS}. */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------------------------
// The address
// ---------------------------------------------------------------------------------------------

/** Whether to request an address, and if not what to record (`fenced`, or `failed` with `address_refused`). */
export type AddressVerdict =
  | { send: true }
  | { send: false; status: "fenced"; errorClass: "fenced" }
  | { send: false; status: "failed"; errorClass: "address_refused" };

const SEND: AddressVerdict = { send: true };
const REFUSED: AddressVerdict = { send: false, status: "failed", errorClass: "address_refused" };
const FENCED: AddressVerdict = { send: false, status: "fenced", errorClass: "fenced" };

/** The hostnames of `OIDC_LOGOUT_DEV_HOSTS`: exact, lower-cased, trimmed, empties dropped. */
function devHosts(env: Pick<Bindings, "OIDC_LOGOUT_DEV_HOSTS">): string[] {
  return (env.OIDC_LOGOUT_DEV_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h !== "");
}

/**
 * May this address be requested, by this Worker? Pure.
 *
 * Never, whatever the environment: an address that is not https, that carries user information, that has
 * no host or that does not parse. In PRODUCTION (exactly `production`): a named https host, and not a
 * loopback, `localhost`-named or IP-literal one (the registry refuses those at registration; this asks
 * again). Anywhere else, including an unset or unrecognised ENVIRONMENT: a loopback address or a host
 * listed in `OIDC_LOGOUT_DEV_HOSTS`, and any other is FENCED, which is recorded and never sent.
 */
export function logoutAddressVerdict(
  env: Pick<Bindings, "ENVIRONMENT" | "OIDC_LOGOUT_DEV_HOSTS">,
  uri: string,
): AddressVerdict {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return REFUSED;
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hostname === ""
  ) {
    return REFUSED;
  }
  // A trailing dot names the same host (`localhost.` is `localhost`), so it must not slip past the tests.
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (isExactProduction(env)) return isLocalOrLiteral(host) ? REFUSED : SEND;
  if (isLoopbackHost(host)) return SEND;
  return devHosts(env).includes(host) ? SEND : FENCED;
}

// ---------------------------------------------------------------------------------------------
// The token and the request
// ---------------------------------------------------------------------------------------------

/**
 * The signed logout token for one attempt. `clientId` is the client's PUBLIC id (the `aud`), `sub` the
 * account's subject, `jti` this attempt's. `nowSeconds` is the issue time, for a test that must know it.
 * Throws what `signJwt` throws (no secret, no current key, an unreadable key): the caller records that as
 * `sign_failed` and retries.
 */
export async function buildLogoutToken(
  env: Pick<Bindings, "DB" | "API_BASE_URL" | "OIDC_SECRET">,
  input: { clientId: string; sub: string; jti: string },
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  return signJwt(
    env,
    {
      iss: oidcIssuer(env),
      aud: input.clientId,
      iat: nowSeconds,
      exp: nowSeconds + OIDC_LOGOUT_TOKEN_TTL_SECONDS,
      jti: input.jti,
      sub: input.sub,
      events: { [OIDC_BACKCHANNEL_LOGOUT_EVENT]: {} },
    },
    { typ: OIDC_LOGOUT_TOKEN_TYP },
  );
}

/** What the partner's answer means for the delivery. */
export type SendOutcome =
  | { kind: "sent"; status: number }
  | { kind: "failed"; status: number | null; errorClass: OidcLogoutErrorClass }
  | {
      kind: "retry";
      status: number | null;
      errorClass: OidcLogoutErrorClass;
      /**
       * A throttled partner's `Retry-After` in seconds, a lower bound for the wait, at most
       * {@link OIDC_LOGOUT_RETRY_AFTER_MAX_SECONDS} (`parseRetryAfter` bounds it); absent otherwise.
       */
      retryAfterSeconds?: number;
    };

/**
 * A `Retry-After` header as seconds from now (RFC 9110 section 10.2.3: a whole number of seconds, or an
 * HTTP date), or null for an absent, empty, negative or unparseable value. A date in the past is 0.
 *
 * NEVER MORE THAN {@link OIDC_LOGOUT_RETRY_AFTER_MAX_SECONDS}: this is where a partner's number enters, so
 * this is where it is bounded, and the value returned is the wait it can ask for and not the number it
 * wrote. A run of digits of ANY length is a whole number of seconds: one too long to be a finite number is
 * still longer than the cap, and is the cap. (It was once read as no header at all past ten digits, which
 * gave the partner that asked for the longest wait the shortest one.) Anything that is not one of the two
 * forms is no `Retry-After`, whatever `Number` or `Date.parse` would make of it.
 *
 * Pure: `nowMs` is the clock.
 */
export function parseRetryAfter(value: string | null, nowMs: number = Date.now()): number | null {
  if (value === null) return null;
  const text = value.trim();
  if (/^[0-9]+$/.test(text)) {
    return Math.min(Number(text), OIDC_LOGOUT_RETRY_AFTER_MAX_SECONDS);
  }
  // A date has letters and a year; a bare sign or a word is not one, whatever `Date.parse` makes of it.
  if (!/^[A-Za-z]{3,9},? /.test(text)) return null;
  const at = Date.parse(text);
  if (!Number.isFinite(at)) return null;
  return Math.min(Math.max(0, Math.ceil((at - nowMs) / 1000)), OIDC_LOGOUT_RETRY_AFTER_MAX_SECONDS);
}

/**
 * POST the token to the partner and say what came of it. Never throws. `200` and `204` are `sent`; a 5xx,
 * a 408 and a 429 are a `retry` (the last two, `http_throttled`, with the answer's `Retry-After` if it sent
 * one: the header is read, the body never is); a redirect (never followed), any other 4xx and any other
 * status are `failed`; no answer inside the time is a `retry` (`timeout`) and so is a connection that
 * could not be made or that broke (`network`). The body of the answer is cancelled and never read.
 */
export async function postLogoutToken(
  uri: string,
  token: string,
  options: LogoutOptions = {},
): Promise<SendOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const signal = AbortSignal.timeout(options.timeoutMs ?? OIDC_LOGOUT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(uri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ logout_token: token }).toString(),
      redirect: "manual",
      signal,
    });
  } catch {
    // The signal is the only thing that aborts this request, so an aborted one is the timeout.
    return { kind: "retry", status: null, errorClass: signal.aborted ? "timeout" : "network" };
  }
  const status = response.status;
  // The one header read, and only for a throttled answer; the body is not read, ever: a partner's
  // answer is a status to this code, and `Retry-After` when it says to slow down.
  const retryAfter = response.headers.get("Retry-After");
  await response.body?.cancel().catch(() => {});
  if (status === 200 || status === 204) return { kind: "sent", status };
  if (status >= 300 && status < 400) return { kind: "failed", status, errorClass: "redirect" };
  if (status === 408 || status === 429) {
    const seconds = parseRetryAfter(retryAfter);
    return {
      kind: "retry",
      status,
      errorClass: "http_throttled",
      ...(seconds === null ? {} : { retryAfterSeconds: seconds }),
    };
  }
  if (status >= 400 && status < 500) return { kind: "failed", status, errorClass: "http_4xx" };
  if (status >= 500 && status < 600) return { kind: "retry", status, errorClass: "http_5xx" };
  return { kind: "failed", status, errorClass: "http_other" };
}

// ---------------------------------------------------------------------------------------------
// One delivery, and a batch of them
// ---------------------------------------------------------------------------------------------

/** What happened to one delivery in one run. */
type Disposition = "sent" | "retried" | "failed" | "fenced" | "lost";

/** The record of an attempt that found `outcome`, given how many attempts the delivery has now had. */
function recordOf(outcome: SendOutcome, attempts: number): AttemptRecord {
  if (outcome.kind === "sent") {
    return { status: "sent", retryDelaySeconds: 0, lastStatus: outcome.status, errorClass: null };
  }
  const base = { lastStatus: outcome.status, errorClass: outcome.errorClass };
  if (outcome.kind === "failed" || attempts >= OIDC_LOGOUT_MAX_ATTEMPTS) {
    return { status: "failed", retryDelaySeconds: 0, ...base };
  }
  const scheduled = OIDC_LOGOUT_RETRY_DELAYS_SECONDS[attempts - 1] as number;
  // A partner's `Retry-After` can only lengthen the wait; `parseRetryAfter` has already bounded it by the
  // schedule's longest, so a partner can slow a delivery and can never add an attempt or park one.
  return {
    status: "pending",
    retryDelaySeconds: Math.max(scheduled, outcome.retryAfterSeconds ?? 0),
    ...base,
  };
}

/** Make one delivery's attempt, or record why it is not made. Throws only on a database fault. */
async function attemptOne(
  env: LogoutEnv,
  row: DueDelivery,
  options: LogoutOptions,
): Promise<Disposition> {
  const db = env.DB;
  // A client that is gone or disabled is owed nothing: the owner cut it off.
  if (row.client_public === null || row.client_status !== "active") {
    return (await finishWithoutSend(db, row.id, {
      status: "failed",
      errorClass: "client_disabled",
    }))
      ? "failed"
      : "lost";
  }
  if (row.uri === null) {
    return (await finishWithoutSend(db, row.id, {
      status: "failed",
      errorClass: "address_refused",
    }))
      ? "failed"
      : "lost";
  }
  const verdict = logoutAddressVerdict(env, row.uri);
  if (!verdict.send) {
    const done = await finishWithoutSend(db, row.id, verdict);
    return done ? (verdict.status === "fenced" ? "fenced" : "failed") : "lost";
  }
  // Every attempt is spent: a claim that never recorded (an evicted isolate) has none left to make.
  if (row.attempts >= OIDC_LOGOUT_MAX_ATTEMPTS) {
    return (await finishWithoutSend(db, row.id, { status: "failed", errorClass: "unreported" }))
      ? "failed"
      : "lost";
  }

  const jti = randomHex(16);
  if (!(await claimDelivery(db, row.id, row.attempts, jti))) return "lost";
  const attempts = row.attempts + 1;

  let outcome: SendOutcome;
  try {
    const token = await buildLogoutToken(env, { clientId: row.client_public, sub: row.sub, jti });
    outcome = await postLogoutToken(row.uri, token, options);
  } catch {
    // The token could not be made: NEMAR's fault and not the partner's, so it is retried.
    outcome = { kind: "retry", status: null, errorClass: "sign_failed" };
  }
  const record = recordOf(outcome, attempts);
  await recordAttempt(db, row.id, jti, record);
  if (record.status === "sent") return "sent";
  return record.status === "pending" ? "retried" : "failed";
}

/** What a run did, in counts. */
export interface LogoutTally {
  examined: number;
  sent: number;
  /** Failed with attempts left: waiting for the next one. */
  retried: number;
  /** Not to be tried again: refused by the partner, every attempt used, or never sendable. */
  failed: number;
  fenced: number;
  /** Another runner claimed it first, or it changed meanwhile. */
  lost: number;
  /** Finished deliveries deleted past their retention window (the production tick only; else 0). */
  pruned: number;
  /** Deliveries whose attempt threw (a database fault), and a prune that threw: left as they were. */
  errors: number;
  /** The class of the last error, a fixed word, or null. */
  errorClass: string | null;
  /**
   * Set only when the run was skipped whole because `OIDC_SECRET` is not usable (`unset` or
   * `malformed`): nothing was read, claimed or written. Absent on every other run.
   */
  skipped?: "oidc_secret_unset" | "oidc_secret_malformed";
}

/** The most deliveries one run takes: a run is bounded, and the next tick takes the rest. */
export const LOGOUT_ROWS_PER_RUN = 20;

/** How many of a run's attempts are in flight at once: each may wait its whole timeout. */
const LOGOUT_CONCURRENCY = 5;

/**
 * Attempt the deliveries that are due (all of them, oldest first, at most `limit` or
 * {@link LOGOUT_ROWS_PER_RUN}), or those of one account (the first attempt after a commit). A few at a
 * time, each in its own try and catch: one that throws is counted and left as it was, and the others go
 * on. Never throws.
 */
export async function attemptDueLogouts(
  env: LogoutEnv,
  options: LogoutOptions & { userId?: number; limit?: number } = {},
): Promise<LogoutTally> {
  const tally: LogoutTally = {
    examined: 0,
    sent: 0,
    retried: 0,
    failed: 0,
    fenced: 0,
    lost: 0,
    pruned: 0,
    errors: 0,
    errorClass: null,
  };
  // With no usable secret no logout token can be signed, and a claim costs an attempt: five claims
  // that each fail to sign would end a pending delivery for good. So nothing is claimed, read or
  // written until the secret is valid again (ADR 0119 addendum). Every caller passes through here:
  // the retry tick, the first attempt after an ending and the test-account sweep.
  if (oidcSecret(env) === null) {
    const state = oidcSecretStatus(env);
    tally.skipped = state === "unset" ? "oidc_secret_unset" : "oidc_secret_malformed";
    // An absent secret is the provider dark by design (ADR 0119): silent, or the production tick
    // would log about 48 lines a day for nothing. A secret set in the wrong form is a mistake the
    // owner has to hear about, so that one warns on every tick.
    if (tally.skipped === "oidc_secret_malformed") {
      console.warn(`[oidc-logout] skipped reason=${tally.skipped}`);
    }
    return tally;
  }
  let rows: DueDelivery[];
  try {
    rows = await dueDeliveries(env.DB, options.limit ?? LOGOUT_ROWS_PER_RUN, options.userId);
  } catch (err) {
    tally.errors++;
    tally.errorClass = errorClassName(err);
    return tally;
  }
  tally.examined = rows.length;
  for (let i = 0; i < rows.length; i += LOGOUT_CONCURRENCY) {
    const batch = rows.slice(i, i + LOGOUT_CONCURRENCY);
    const settled = await Promise.allSettled(batch.map((row) => attemptOne(env, row, options)));
    for (const result of settled) {
      if (result.status === "fulfilled") {
        tally[result.value]++;
      } else {
        tally.errors++;
        tally.errorClass = errorClassName(result.reason);
      }
    }
  }
  return tally;
}

// ---------------------------------------------------------------------------------------------
// When
// ---------------------------------------------------------------------------------------------

/**
 * The one line a first attempt logs when it met a fault, or null when it met none. `attemptDueLogouts`
 * never throws, so its tally is the only place a database fault of a first attempt shows: a delivery hit
 * by one stays `pending`, or is claimed and sent again when its claim lapses, and without this line there
 * is no trace of why. Counts and a fixed word only (the class of the error), never an address, a token or a
 * subject, as the tick's line is.
 */
export function firstAttemptLogLine(t: Pick<LogoutTally, "errors" | "errorClass">): string | null {
  if (t.errors === 0) return null;
  return `[oidc-logout] first attempt errors=${t.errors} errorClass=${t.errorClass ?? "unknown"}`;
}

/** Log a first attempt's fault line, if it has one. */
export function logFirstAttempt(t: Pick<LogoutTally, "errors" | "errorClass">): void {
  const line = firstAttemptLogLine(t);
  if (line) console.error(line);
}

/**
 * The first attempt, after the batch that ended the grants has committed: handed to `waitUntil`, so the
 * request that revoked is answered without waiting for any partner, and so nothing a partner does can
 * fail it (the sender never throws; what went wrong is in the tally, and a fault is logged by
 * {@link logFirstAttempt}). Pass the request's `waitUntil`, or none (outside a Worker invocation, where
 * Hono's getter throws): then the attempt is simply started and the tick takes up whatever it leaves.
 */
export function deferLogoutDelivery(
  env: LogoutEnv,
  userId: number,
  defer: ((work: Promise<unknown>) => void) | undefined,
): void {
  const work = attemptDueLogouts(env, { userId }).then(logFirstAttempt);
  if (defer) defer(work);
}

/** The request's `waitUntil`, or undefined where there is no execution context (Hono throws on the getter then). */
export function backgroundOf(c: {
  executionCtx: ExecutionContext;
}): ((work: Promise<unknown>) => void) | undefined {
  try {
    const ctx = c.executionCtx;
    return (work) => ctx.waitUntil(work);
  } catch {
    return undefined;
  }
}

/**
 * The retry tick (every 30 minutes, production only; template `runRepullAdvanceCron`): attempt the deliveries that
 * are due, then prune the finished ones past their retention window. Returns null, having read and written
 * nothing, outside ENVIRONMENT exactly `production` (a dev Worker shares real accounts, and the job is absent
 * from `DEV_CRON_ALLOWLIST`; the tick fences itself as well). Bounded to {@link LOGOUT_ROWS_PER_RUN}
 * deliveries a tick, each in its own try and catch recording only a status and a fixed word. The prune
 * comes AFTER the delivery work, so a slow or failing prune never delays a logout, and a prune that throws
 * is counted as an error and costs nothing else (`OIDC_LOGOUT_PRUNE_PER_TICK`, and the windows, are in
 * `shared/oidc.ts`). The name avoids the word `sweep` on purpose: it is not one, and
 * `cron-sweep-wiring.test.ts` would ask for an entry it has no use for.
 */
export async function runOidcLogoutRetryTick(
  env: LogoutEnv,
  options: LogoutOptions = {},
): Promise<LogoutTally | null> {
  if (!isExactProduction(env)) return null;
  const tally = await attemptDueLogouts(env, options);
  // Skipped for want of a secret: not even the prune writes (a malformed secret was warned about already).
  if (tally.skipped) return tally;
  try {
    tally.pruned = await pruneDeliveries(env.DB);
  } catch (err) {
    tally.errors++;
    tally.errorClass = errorClassName(err);
  }
  return tally;
}

/**
 * The tick's one log line, or null when it did nothing and nothing went wrong: a tick that found no
 * delivery and pruned none says nothing. Counts and a fixed word only, never a client, a subject or an address.
 */
export function logoutTickLogLine(
  t: LogoutTally,
): { level: "info" | "error"; line: string } | null {
  if (t.examined === 0 && t.errors === 0 && t.pruned === 0) return null;
  const line = `[oidc-logout] examined=${t.examined} sent=${t.sent} retried=${t.retried} failed=${t.failed} fenced=${t.fenced} lost=${t.lost} errors=${t.errors} pruned=${t.pruned}${t.errorClass ? ` errorClass=${t.errorClass}` : ""}`;
  return { level: t.errors > 0 || t.failed > 0 ? "error" : "info", line };
}
