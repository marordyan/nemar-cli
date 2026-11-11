/**
 * What a call to Tapis can fail with (epic #2005 phase A4, #2009; ADR 0118).
 *
 * One class, six fixed kinds. The KIND is what a caller branches on; the message is a fixed sentence
 * that names the kind, the call and the status, and NEVER holds anything a response, a request or a
 * credential carried: a Tapis error body can echo the request (a validation error names the value it
 * refused, and the launch specification, which holds a job's token, is an environment value), and a
 * log line or a stored `failure_detail` must not hold a token. So no body is read into a message,
 * and `bodySnippet` of the wrapped `HttpError` is never set.
 *
 *   unconfigured      the Worker has no (or an unusable) Tapis configuration, or a request does not
 *                     fit it (a password-strategy submit for another owner); nothing was sent
 *   unauthorized      Tapis refused the credential: 401 (after the one refresh) and 403
 *   not_found         404
 *   rejected          another 4xx: Tapis understood the request and said no (400, 405, 409, ...)
 *   unavailable       a timeout, a network failure, 408, 429, 5xx or a redirect (3xx, which is never
 *                     followed): a proxy or a gateway answered, not Tapis's decision on the request, so
 *                     it may work later (review fixes of 2026-11-06: a submit that met a proxy's 302 or
 *                     408 ended the job for good as `tapis_submit_failed`)
 *   invalid_response  Tapis answered something that is not what its specification says (not JSON, a
 *                     body that fails its schema, one over the size bound): never partly trusted
 *
 * THE OUTCOME MAY BE UNKNOWN. For a call that changes something (`submitJob`, `cancelJob`,
 * `subscribeWebhook`), `unavailable` and `invalid_response` say nothing about whether it took effect:
 * the request may have been sent and acted on, and a 2xx answer that fails its schema means the job
 * MAY EXIST. Such an error has `outcomeUnknown` true and says so in its message, and the caller must
 * look the job up (by its tag) before it repeats the call. A refusal (`rejected`, `unauthorized`,
 * `not_found`) and a failure before anything was sent (no token could be had) are not unknown, and
 * neither is any failed read.
 *
 * `cause` is an `HttpError` for an HTTP status, so `isRetryable` classifies it as the rest of the
 * Worker does (5xx and 429), and a plain `Error` whose message says `timeout` or `network` for a
 * transport failure, which `isRetryable` also recognises.
 */

import { HttpError, isRetryable } from "../retry";

export const TAPIS_ERROR_KINDS = [
  "unconfigured",
  "unauthorized",
  "not_found",
  "rejected",
  "unavailable",
  "invalid_response",
] as const;

export type TapisErrorKind = (typeof TAPIS_ERROR_KINDS)[number];

/** The sentence a message ends with when the outcome of a call that changes something is unknown. */
const OUTCOME_UNKNOWN_SENTENCE =
  "the outcome is unknown: look the job up by its tag before repeating this call";

export interface TapisErrorOptions {
  status?: number | null;
  cause?: HttpError | Error;
  /** The call may have taken effect (see the header). Only meaningful for a call that changes something. */
  outcomeUnknown?: boolean;
  /** A fixed sentence of the code's own, never a value from a request, a response or a binding. */
  detail?: string;
}

export class TapisError extends Error {
  readonly kind: TapisErrorKind;
  /** The HTTP status Tapis answered with, or null when there was none (a timeout, no connection). */
  readonly status: number | null;
  readonly outcomeUnknown: boolean;
  override readonly cause: HttpError | Error | undefined;
  private readonly what: string;
  private readonly detail: string | undefined;

  constructor(kind: TapisErrorKind, what: string, options: TapisErrorOptions = {}) {
    const status = options.status ?? null;
    const outcomeUnknown = options.outcomeUnknown === true;
    const notes = [
      status === null ? undefined : `HTTP ${status}`,
      options.detail,
      outcomeUnknown ? OUTCOME_UNKNOWN_SENTENCE : undefined,
    ].filter((note): note is string => note !== undefined);
    super(`Tapis ${what}: ${kind}${notes.map((note) => ` (${note})`).join("")}`);
    this.name = "TapisError";
    this.kind = kind;
    this.status = status;
    this.outcomeUnknown = outcomeUnknown;
    this.cause = options.cause;
    this.what = what;
    this.detail = options.detail;
  }

  /** Whether a retry may help, by the Worker's one classifier (`isRetryable`). */
  get retryable(): boolean {
    return this.cause !== undefined && isRetryable(this.cause);
  }

  /**
   * The same error, marked as one whose outcome is unknown, when it is a kind that says nothing about
   * whether the call took effect (`unavailable`, `invalid_response`); any other kind comes back as it is.
   */
  withOutcomeUnknown(): TapisError {
    if (this.kind !== "unavailable" && this.kind !== "invalid_response") return this;
    return new TapisError(this.kind, this.what, {
      status: this.status,
      cause: this.cause,
      detail: this.detail,
      outcomeUnknown: true,
    });
  }
}

/** The error for an HTTP status that was not a success. Never reads the body. */
export function errorForStatus(status: number, what: string): TapisError {
  const cause = new HttpError(`Tapis ${what} answered HTTP ${status}`, status);
  const kind: TapisErrorKind =
    status === 401 || status === 403
      ? "unauthorized"
      : status === 404
        ? "not_found"
        : status === 408 || status === 429 || status >= 500 || status < 400
          ? "unavailable"
          : "rejected";
  return new TapisError(kind, what, { status, cause });
}

/** A transport failure: no answer came. `retryable`, because the message names a timeout or the network. */
export function transportError(what: string, timedOut: boolean): TapisError {
  return new TapisError("unavailable", what, {
    cause: new Error(timedOut ? `Tapis ${what} timeout` : `Tapis ${what} network error`),
  });
}

/** An answer that is not what Tapis's specification says, with the status it came with. Not retryable. */
export function invalidResponse(what: string, status: number | null): TapisError {
  return new TapisError("invalid_response", what, { status });
}
