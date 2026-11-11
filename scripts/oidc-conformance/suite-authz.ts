/**
 * The cause of each authorization-endpoint stop, read from the suite's OWN exported results (epic #2014
 * phase #2020, slice S7).
 *
 * WHY. The expected-failures entries match a module by test name, condition and block. The condition
 * `CheckIfAuthorizationEndpointError` is raised for ANY error from the authorization endpoint, so on its
 * own an entry for it would accept a refusal for the wrong reason as the approved PKCE deviation
 * (decision 3a). The rig's log answers that in rig mode (`authz-log.ts`). Against the deployed system
 * there is no rig, so this reads what the suite recorded for each module instead: the error NEMAR
 * answered (the `error` field of the failing entry) and the request the suite sent (the `auth_request`
 * of the entry before it). A module that stops at the authorization endpoint passes only if
 *
 *  1. the error is exactly `invalid_request`, and
 *  2. the request carried no `code_challenge`.
 *
 * An `invalid_request` to a request WITH a challenge is a different refusal wearing the PKCE deviation's
 * name; any other error code is not the deviation at all. The check also fails if it finds nothing to
 * check, or a stop whose request it cannot read.
 *
 * RESIDUAL RISK, stated plainly. This knows the error code and whether a challenge was sent. It does not
 * know WHICH parameter NEMAR refused, so an `invalid_request` with no challenge for a different cause is
 * indistinguishable from the PKCE case. The same limit applies to the rig's log.
 *
 * The functions here are pure; `check-suite-authz.ts` reads the files.
 */

/** One entry of a module's log, as far as this check reads it. */
export interface LogEntry {
  src?: string;
  result?: string;
  error?: unknown;
  actual?: unknown;
  auth_request?: unknown;
}

/** A module's exported log. */
export interface ModuleLog {
  testInfo?: { testName?: string };
  results?: LogEntry[];
}

export interface SuiteAuthzReport {
  /** How many modules stopped at the authorization endpoint. */
  checked: number;
  /** Modules by the error code they stopped on. */
  byError: Record<string, number>;
  violations: string[];
}

/**
 * The conditions that record a stop at the authorization endpoint, and the field each keeps the error in.
 * A module that expects an error of a given kind (`oidcc-prompt-none-not-logged-in` expects
 * `login_required`) records it under the second condition, in `actual`.
 */
const STOP_CONDITIONS: Record<string, "error" | "actual"> = {
  CheckIfAuthorizationEndpointError: "error",
  CheckErrorFromAuthorizationEndpointIsOneThatRequiredAUserInterface: "actual",
};
const PKCE_ERROR = "invalid_request";
const ERROR_WORD = /^[a-z_]+$/;

/** Check the modules' logs. `minimum` is the fewest stops a healthy run has (a sanity floor). */
export function checkSuiteResults(logs: ModuleLog[], minimum = 1): SuiteAuthzReport {
  const report: SuiteAuthzReport = { checked: 0, byError: {}, violations: [] };
  for (const log of logs) {
    const name = log.testInfo?.testName ?? "(unnamed module)";
    const entries = log.results ?? [];
    for (const [index, entry] of entries.entries()) {
      const field = entry.src === undefined ? undefined : STOP_CONDITIONS[entry.src];
      if (field === undefined || entry.result !== "FAILURE") continue;
      report.checked += 1;
      const value = entry[field];
      const error = typeof value === "string" && ERROR_WORD.test(value) ? value : "malformed_error";
      report.byError[error] = (report.byError[error] ?? 0) + 1;
      if (error !== PKCE_ERROR) {
        report.violations.push(
          `${name}: the authorization endpoint answered ${error}, which is not the PKCE deviation`,
        );
      }
      // The request is the nearest entry before the stop that carries one.
      let request: unknown;
      for (let i = index - 1; i >= 0; i--) {
        const candidate = entries[i]?.auth_request;
        if (candidate !== undefined) {
          request = candidate;
          break;
        }
      }
      if (request === null || typeof request !== "object") {
        report.violations.push(
          `${name}: the request the suite sent cannot be read, so whether it carried a code_challenge is unknown`,
        );
      } else if ("code_challenge" in (request as Record<string, unknown>) && error === PKCE_ERROR) {
        report.violations.push(
          `${name}: invalid_request answered a request that carried a code_challenge, so it is not the PKCE deviation`,
        );
      }
    }
  }
  if (report.checked < minimum) {
    report.violations.push(
      `${report.checked} modules stopped at the authorization endpoint, fewer than the ${minimum} a run has, so there is too little to check`,
    );
  }
  return report;
}
