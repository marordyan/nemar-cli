/**
 * What the rig logs about every authorization response, and the check the workflow runs on it (epic
 * #2014 phase #2020).
 *
 * WHY. The expected-failures entries match a module by test name, condition and block, not by the
 * error NEMAR answered. A module stopped by `CheckIfAuthorizationEndpointError` is recorded as the
 * approved PKCE deviation (decision 3a), but the same condition is raised by ANY error from the
 * authorization endpoint. So the rig logs, for each authorization response, the error code (if any)
 * and whether the request carried a `code_challenge`, and a workflow step fails the run unless:
 *
 *  1. every error code is one the approved deviations and the two REVIEW modules produce
 *     ({@link ALLOWED_AUTHORIZATION_ERRORS}); and
 *  2. no `invalid_request` answered a request that DID carry a `code_challenge` (that would be a
 *     different refusal, wearing the PKCE deviation's name).
 *
 * RESIDUAL RISK, stated plainly. The allowed set is global to the run, not per module. A module that
 * stops with `invalid_request` and no challenge is indistinguishable, in this log, from another module
 * that stopped with `invalid_request` and no challenge for a DIFFERENT cause (say, a malformed
 * parameter): the log names no module. What the check does guarantee is that no module stopped with any
 * other code, and that no refusal of a request that carried a challenge is called the PKCE deviation.
 * Telling two `invalid_request` causes apart would need the rig to log which parameter was refused,
 * which NEMAR's check route does not say.
 *
 * The line holds a kind, an error code and a yes/no. It never holds a value: no state, code, challenge,
 * token or address.
 */

/**
 * The error codes an authorization response may carry in the conformance run, and why each is there:
 *
 *  - `invalid_request`: a request with no `code_challenge` (decision 3a: PKCE is mandatory), which is
 *    what 26 of the 35 Basic modules send, and the `oidcc-response-type-missing` module's request with
 *    no response type, which the suite expects to be refused;
 *  - `request_not_supported`: the unsigned request object module, which the suite skips on exactly this
 *    answer (decision 4);
 *  - `page:invalid_redirect_uri`: the error page (not a redirect) for an address the client did not
 *    register, which the two REVIEW modules expect.
 */
export const ALLOWED_AUTHORIZATION_ERRORS = [
  "invalid_request",
  "request_not_supported",
  "page:invalid_redirect_uri",
] as const;

/** An error word: lower-case letters and underscores, nothing else. */
const ERROR_WORD = /^[a-z_]+$/;

/** The answer to an authorization request, as far as the log needs it. */
export type LoggedAnswer =
  | { readonly kind: "redirect"; readonly location: string }
  | { readonly kind: "error_page"; readonly code: string }
  | { readonly kind: "rule_refused"; readonly location: string }
  | { readonly kind: "login" | "reauth" | "consent" };

/**
 * The error a redirect location carries: null when it has no `error` key at all, the word when it has
 * exactly one and it is {@link ERROR_WORD}, and `malformed_error` for everything else (an empty value, a
 * value with a space or a newline, a repeated key in the query or the fragment, a location that is not an
 * address). The fragment is read as well as the query. Only "no key"
 * reads as no error, so a refusal cannot hide behind an odd spelling.
 */
function locationError(location: string): string | null {
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    return "malformed_error";
  }
  // The query and the fragment are both places a response can carry an error; read both, so one in the
  // fragment is not invisible.
  const values = [
    ...url.searchParams.getAll("error"),
    ...new URLSearchParams(url.hash.replace(/^#/, "")).getAll("error"),
  ];
  if (values.length === 0) return null;
  const only = values[0] as string;
  return values.length === 1 && ERROR_WORD.test(only) ? only : "malformed_error";
}

/** The error an answer carries, as the run's check names it: a redirect's `error`, or `page:<code>`. */
export function answerError(answer: LoggedAnswer): string | null {
  if (answer.kind === "redirect") return locationError(answer.location);
  // A refusal by the client's sign-in rule sends the person back with an error in the location; the
  // contract says it is `access_denied`, and if the location names none the refusal still is one.
  if (answer.kind === "rule_refused") return locationError(answer.location) ?? "access_denied";
  if (answer.kind === "error_page") {
    return ERROR_WORD.test(answer.code) ? `page:${answer.code}` : "malformed_error";
  }
  return null;
}

export type AuthorizationKind =
  | "redirect"
  | "error_page"
  | "login"
  | "reauth"
  | "rule_refused"
  | "consent"
  | "check_failed";

/** One log line: `[rig] authz kind=<kind> error=<code|none> pkce=<yes|no>`. */
export function authorizationLogLine(
  kind: AuthorizationKind,
  error: string | null,
  carriedChallenge: boolean,
): string {
  return `[rig] authz kind=${kind} error=${error ?? "none"} pkce=${carriedChallenge ? "yes" : "no"}`;
}

/** Whether an authorization request string carries a `code_challenge` (its value is never read out). */
export function carriesChallenge(request: string): boolean {
  return new URLSearchParams(request.replace(/^\?/, "")).has("code_challenge");
}

export interface AuthorizationLogReport {
  /** How many authorization responses the log records. */
  responses: number;
  /** How many lines name themselves an authorization line (well-formed or not). */
  authorizationLines: number;
  /** How many requests the rig answered at its two authorization pages (see {@link REQUEST_LINE}). */
  requests: number;
  /** Responses by error code (`none` for a response with no error). */
  byError: Record<string, number>;
  /** One sentence per response that breaks a rule above. */
  violations: string[];
}

/** The one shape an authorization line may have. A line that names itself `[rig] authz` and is not this is a violation. */
/**
 * The rig's own request line for a request that must have one authorization line: any method at
 * `/oauth/authorize`, and a POST at `/oauth/consent`. A request with no line is a response the check
 * never saw, so the two counts must be equal.
 */
const REQUEST_LINE = /^\[rig\] (?:[A-Z]+ \/oauth\/authorize|POST \/oauth\/consent) \d{3}$/;

const LINE =
  /^\[rig\] authz kind=(redirect|error_page|login|reauth|rule_refused|consent|check_failed) error=([a-z0-9_:]+) pkce=(yes|no)$/;

/** Read the rig's log and report what the check needs. */
export function checkAuthorizationLog(log: string): AuthorizationLogReport {
  const report: AuthorizationLogReport = {
    responses: 0,
    authorizationLines: 0,
    requests: 0,
    byError: {},
    violations: [],
  };
  const allowed = new Set<string>(ALLOWED_AUTHORIZATION_ERRORS);
  const lines = log.split("\n");
  for (const [index, raw] of lines.entries()) {
    if (REQUEST_LINE.test(raw)) report.requests += 1;
    if (!raw.includes("[rig] authz")) continue;
    report.authorizationLines += 1;
    const match = LINE.exec(raw);
    if (!match) {
      report.violations.push(`unparseable authorization line ${index + 1}`);
      continue;
    }
    const [, kind, error, pkce] = match as unknown as [string, string, string, string];
    report.responses += 1;
    report.byError[error] = (report.byError[error] ?? 0) + 1;
    if (error !== "none" && !allowed.has(error)) {
      report.violations.push(
        `an authorization response (${kind}) carried the error ${error}, which no approved deviation produces`,
      );
    }
    if (error === "invalid_request" && pkce === "yes") {
      report.violations.push(
        "invalid_request answered a request that carried a code_challenge, so it is not the PKCE deviation",
      );
    }
  }
  if (report.requests !== report.authorizationLines) {
    report.violations.push(
      `${report.requests} authorization requests but ${report.authorizationLines} authorization lines`,
    );
  }
  if (report.responses === 0) {
    report.violations.push(
      "the log records no authorization response, so there is nothing to check",
    );
  }
  return report;
}
