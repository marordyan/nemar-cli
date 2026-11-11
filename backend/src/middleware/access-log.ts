/**
 * The Worker's access log, with the one secret that rides in a URL taken out (epic #2005 phase A5, #2010;
 * ADR 0118, round 1 review).
 *
 * Hono's `logger()` prints every request's method and path. The Tapis webhook address is
 * `/webhooks/tapis/<job id>/<token>` (Tapis does not sign its webhooks, so the token has to be in the
 * address), and a line that held it would put a bearer credential in the Worker's logs. The token is
 * bound to the job's nonce and dies a day after the job ends, and it can only make the Worker READ the job
 * from Tapis (it is a hint, never the source of a status), so a leaked one is a nuisance and not a breach:
 * but nothing here is the reason to log it. `redactSecretPaths` keeps the job id (it is not a secret, and
 * it is what a person debugging wants) and replaces everything after it with `[redacted]`; a path whose
 * first segment is not a job id loses that segment too.
 *
 * RESIDUALS, stated so nobody assumes more: this covers what THIS Worker prints. The platform's own
 * request logging (Workers Logs, a log push, a tail) records the request URL before any of this code runs
 * and is not changed by it; the redaction is only as complete as the one route that carries a token in a
 * path. Any new route that does so must be added here, and `backend/test/access-log.test.ts` pins that the
 * entry point mounts this logger and not Hono's own.
 */

import { logger } from "hono/logger";
import { COMPUTE_JOB_ID_RE } from "../../../shared/contract/compute.js";

/** `/webhooks/tapis/` and everything up to the next whitespace: a path as a log line holds it. */
const TAPIS_HOOK_RE = /\/webhooks\/tapis\/(\S*)/g;

/** `line` with the Tapis webhook token (and any non-job-id first segment) replaced by `[redacted]`. */
export function redactSecretPaths(line: string): string {
  return line.replace(TAPIS_HOOK_RE, (_match, rest: string) => {
    const first = rest.split("/")[0] ?? "";
    const id = COMPUTE_JOB_ID_RE.test(first) ? first : "[redacted]";
    return `/webhooks/tapis/${id}/[redacted]`;
  });
}

/** Hono's logger with every line passed through `redactSecretPaths`. Mounted once, first, in `index.ts`. */
export function accessLogger() {
  return logger((line, ...rest) => {
    console.log(redactSecretPaths(line), ...rest.map(redactSecretPaths));
  });
}
