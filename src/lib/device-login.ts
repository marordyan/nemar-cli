/**
 * The device authorization grant's CLI half (RFC 8628; epic #1272 phase 3;
 * ADR 0047): mint a code, print it, wait for a person to authorize it in a
 * browser, and poll for the API key it releases. `nemar auth login` and
 * `nemar auth signup` both drive this through {@link runDeviceLogin} --
 * signup differs only in what it does with a `success` outcome afterward
 * (guided profile completion), which is why the two must print identically
 * for every OTHER outcome: {@link describeDeviceOutcome} is the one place
 * that wording lives.
 *
 * Headless-first: the printed URL is the mechanism, a browser is only a
 * convenience. No display detection -- see ADR 0047 and the authentication
 * page, https://docs.nemar.org/cli/getting-started/authentication/.
 */

import { hostname } from "node:os";
import chalk from "chalk";
import {
  DEFAULT_MACHINE_NAME,
  DEVICE_CONFIRM_GRACE_SECONDS,
  type DeviceStartResponse,
  type DeviceTokenSuccess,
  MACHINE_NAME_MAX_CHARS,
} from "../../shared/contract/device-auth.js";
import { pollDeviceToken, startDeviceAuth } from "./api/auth.js";
import { ApiError, errorDetail } from "./api/errors.js";
import { openInBrowser } from "./browser.js";
import { dlog } from "./debug-log.js";

/**
 * The machine name a device code is minted for -- `os.hostname()`, cleaned
 * up for display and for the `tokens.name` row it becomes server-side.
 * Never throws: `os.hostname()` failing is not worth aborting a sign-in
 * over, so it falls back to {@link DEFAULT_MACHINE_NAME} like an empty or
 * all-control-character hostname does.
 */
/**
 * The cleanup rules on their own, pure and directly testable -- separated
 * from `machineName()`'s `os.hostname()` call (which a unit test cannot
 * hand an arbitrary value to) the same way the backend's own
 * `normalizeMachineName` (services/device-auth.ts) is one function, not a
 * method on a live hostname lookup.
 */
export function normalizeMachineNameInput(raw: string): string {
  const cleaned = raw
    // biome-ignore lint/suspicious/noControlCharactersInRegex: deliberately stripping control bytes, matching backend/src/services/device-auth.ts's normalizeMachineName
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned ? cleaned.slice(0, MACHINE_NAME_MAX_CHARS) : DEFAULT_MACHINE_NAME;
}

export function machineName(): string {
  try {
    return normalizeMachineNameInput(hostname());
  } catch {
    return DEFAULT_MACHINE_NAME;
  }
}

/**
 * The local wall-clock deadline (ms since epoch) to give up polling when the
 * server cannot be reached to say so itself. Pure, and built from RELATIVE
 * values (`expiresIn` seconds counted from `startedAt`, never an absolute
 * server timestamp) so it is immune to clock skew between this machine and
 * the API. The grace window matches the one `confirm` itself
 * extends a near-expiry code by (ADR 0047) so a person who authorizes in the
 * closing seconds of the window is not cut off locally before the server's
 * own `expired_token` answer would arrive -- this cutoff exists only for the
 * UNREACHABLE stretch; when the server can be reached, its own answer is
 * always what ends the wait.
 */
export function pollDeadlineMs(
  startedAt: number,
  expiresIn: number,
  graceSeconds: number = DEVICE_CONFIRM_GRACE_SECONDS,
): number {
  return startedAt + (expiresIn + graceSeconds) * 1000;
}

/** Every way `runDeviceLogin`/`pollForDeviceToken` can end. `success` carries
 *  the token endpoint's own payload verbatim; every other kind carries just
 *  enough for {@link describeDeviceOutcome} to render one sentence. */
export type DeviceLoginOutcome =
  | ({ kind: "success" } & DeviceTokenSuccess)
  | { kind: "denied"; message: string }
  | { kind: "expired"; message: string }
  | { kind: "invalid"; message: string }
  | { kind: "cancelled" }
  | { kind: "unreachable"; detail: string }
  | { kind: "server_error"; detail: string }
  | { kind: "start_failed"; detail: string };

/** What a non-success outcome should print, and the exit code to set.
 *  `login` and `signup` both call this so a person sees the identical
 *  sentence for the identical failure regardless of which command they ran. */
export interface DeviceOutcomeDescription {
  lines: string[];
  exitCode: number;
}

export function describeDeviceOutcome(
  outcome: Exclude<DeviceLoginOutcome, { kind: "success" }>,
): DeviceOutcomeDescription {
  switch (outcome.kind) {
    case "cancelled":
      // Exit code 130 (128 + SIGINT), not a bare 1: `main().catch` and the
      // exit hook's bug-report nudge both special-case it.
      return {
        lines: ["Sign-in canceled. Run `nemar auth login` to try again."],
        exitCode: 130,
      };
    case "denied":
    case "expired":
    case "invalid":
      // The contract sentence, verbatim -- `prefersMessage` (client.ts)
      // already chose `message` over the RFC/refusal code for this body, so
      // there is nothing to reconstruct here.
      return { lines: [outcome.message], exitCode: 1 };
    case "unreachable":
      return {
        lines: [
          `NEMAR could not be reached: ${outcome.detail}`,
          "Run `nemar auth login` again once you're back online.",
        ],
        exitCode: 1,
      };
    case "server_error":
      return {
        lines: [
          `NEMAR keeps answering with an error (${outcome.detail}). Try again in a few minutes; if it keeps happening, run \`nemar auth login --debug\` and report the log.`,
        ],
        exitCode: 1,
      };
    case "start_failed":
      return { lines: [`Could not start sign-in: ${outcome.detail}`], exitCode: 1 };
  }
}

const POLL_REQUEST_TIMEOUT_MS = 15_000;
const MIN_POLL_INTERVAL_MS = 1_000;
const SLOW_DOWN_INCREMENT_MS = 5_000;
/** Consecutive non-network poll failures (a 5xx, an unrecognized 400, a 200
 *  that failed the response schema, a non-ApiError) before the wait gives
 *  up rather than retrying forever. Distinct from an outright network
 *  failure (statusCode 0), which keeps retrying until the local deadline --
 *  a server that is UP and answering, just answering wrong, is a different
 *  problem than one that cannot be reached at all. */
const CONSECUTIVE_SERVER_ERROR_LIMIT = 3;

/** What to name a poll failure that is not a network failure, both in the
 *  printed retry line and in the terminal `server_error` outcome. An
 *  `ApiError` with a real HTTP status names it (`"HTTP 500"`); anything
 *  else (a non-ApiError exception) falls back to its own message. */
function describePollError(error: unknown): string {
  if (error instanceof ApiError && error.statusCode !== 0) {
    return `HTTP ${error.statusCode}`;
  }
  return errorDetail(error);
}

/** `AbortSignal.any` where Bun has it; a hand-composed controller otherwise.
 *  Only ever combines two signals here (the SIGINT controller and one
 *  request's own timeout), so the fallback need not generalize. */
function combineSignals(signals: AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === "function") return AbortSignal.any(signals);
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller.signal;
}

/** Resolves after `ms`, or as soon as `signal` aborts -- whichever is first.
 *  Never rejects: the caller checks `signal.aborted` itself right after. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Poll `POST /auth/device/token` from a started device code until it
 * resolves, expires, is canceled, or this machine gives up reaching NEMAR.
 *
 * A SIGINT handler is installed for exactly this stretch (`process.on`
 * before the loop, `process.off` in `finally`) and aborts both the sleep
 * and the in-flight fetch through one `AbortController` -- never calls
 * `process.exit` itself; the caller (`loginAction`/
 * `signupAction`) is what sets `process.exitCode` from
 * {@link describeDeviceOutcome}, so the exit hook still runs and still
 * writes the debug log.
 */
export interface PollForDeviceTokenOptions {
  /** Overrides `DEVICE_CONFIRM_GRACE_SECONDS`. Test-only knob -- the real
   *  CLI entry point (`runDeviceLogin` below) never passes this -- so a
   *  unit test can shrink the unreachable-give-up deadline to something it
   *  can actually wait out instead of the real ~2-minute grace window. */
  graceSeconds?: number;
}

export async function pollForDeviceToken(
  started: DeviceStartResponse,
  options: PollForDeviceTokenOptions = {},
): Promise<DeviceLoginOutcome> {
  const startedAt = Date.now();
  const deadline = pollDeadlineMs(
    startedAt,
    started.expires_in,
    options.graceSeconds ?? DEVICE_CONFIRM_GRACE_SECONDS,
  );
  let intervalMs = Math.max(started.interval * 1000, MIN_POLL_INTERVAL_MS);

  const cancel = new AbortController();
  const onSigint = () => cancel.abort();
  process.on("SIGINT", onSigint);
  // Consecutive poll failures that were NOT a plain network failure (see
  // describePollError) -- reset the moment a poll reaches the server and
  // gets a real answer, pending/slow_down/terminal/success alike.
  let consecutiveServerErrors = 0;

  try {
    while (true) {
      if (cancel.signal.aborted) return { kind: "cancelled" };
      // Only ever reached after a sustained stretch of NOT being able to
      // reach the server at all -- under normal operation the server's own
      // `expired_token` answer arrives well before this, since `deadline`
      // is `expires_in` PLUS a grace window (see pollDeadlineMs).
      if (Date.now() >= deadline) {
        return { kind: "unreachable", detail: "gave up waiting to reach NEMAR" };
      }

      await sleep(intervalMs, cancel.signal);
      if (cancel.signal.aborted) return { kind: "cancelled" };

      const pollSignal = combineSignals([
        cancel.signal,
        AbortSignal.timeout(POLL_REQUEST_TIMEOUT_MS),
      ]);
      let result: Awaited<ReturnType<typeof pollDeviceToken>>;
      try {
        result = await pollDeviceToken(started.device_code, pollSignal);
        consecutiveServerErrors = 0;
      } catch (error) {
        if (cancel.signal.aborted) return { kind: "cancelled" };
        if (error instanceof ApiError && error.statusCode === 0) {
          // A genuine network failure -- DNS, connection refused, the
          // request timing out -- retries indefinitely until the local
          // deadline, the same way `waitForOrcidLink` treats anything that
          // is not a definitive 401.
          console.log(chalk.dim("  NEMAR is unreachable; retrying..."));
          consecutiveServerErrors = 0;
          continue;
        }
        // The server IS reachable but answering wrong: a 5xx, a 400 whose
        // `error` this build's grant-error vocabulary does not recognize (a
        // contract drift), a 200 that failed `deviceTokenSuccessSchema`, or
        // a non-ApiError exception. A different problem from "cannot be
        // reached at all", so it does not retry forever.
        const detail = describePollError(error);
        consecutiveServerErrors += 1;
        dlog(
          `poll error ${consecutiveServerErrors}/${CONSECUTIVE_SERVER_ERROR_LIMIT}: ` +
            `${detail} -- ${errorDetail(error)}`,
        );
        console.log(chalk.dim(`  NEMAR answered with an error (${detail}); retrying...`));
        if (consecutiveServerErrors >= CONSECUTIVE_SERVER_ERROR_LIMIT) {
          return { kind: "server_error", detail };
        }
        continue;
      }

      if (result.status === "pending") continue;
      if (result.status === "slow_down") {
        intervalMs = Math.max(
          intervalMs + SLOW_DOWN_INCREMENT_MS,
          started.interval * 1000,
          MIN_POLL_INTERVAL_MS,
        );
        continue;
      }
      if (result.status === "success") {
        // `result.data` spreads FIRST so a passthrough field named `kind`
        // (the wire schemas allow additive fields) can never overwrite the
        // discriminant.
        return { ...result.data, kind: "success" };
      }
      // result.status === "terminal"
      if (result.error === "expired_token") return { kind: "expired", message: result.message };
      if (result.error === "access_denied") return { kind: "denied", message: result.message };
      return { kind: "invalid", message: result.message };
    }
  } finally {
    process.off("SIGINT", onSigint);
  }
}

export interface RunDeviceLoginOptions {
  /** `false` for `--no-open`/`NEMAR_NO_BROWSER=1` (openInBrowser already
   *  reads the env var itself; `false` here additionally skips the attempt
   *  entirely for `--no-open`). Defaults to trying. */
  open?: boolean;
}

/**
 * Mint a device code, print it, try the browser, then poll for the key.
 *
 * The URL comes first and is the whole mechanism: a headless host is the
 * CLI's normal case, not a fallback path, so nothing here waits
 * on whether a browser attempt looks like it worked.
 */
export async function runDeviceLogin(
  options: RunDeviceLoginOptions = {},
): Promise<DeviceLoginOutcome> {
  let started: DeviceStartResponse;
  try {
    started = await startDeviceAuth(machineName());
  } catch (error) {
    return { kind: "start_failed", detail: errorDetail(error) };
  }

  console.log(`  ${started.verification_uri_complete}`);
  console.log(`  Code: ${chalk.cyan(started.user_code)}`);
  console.log(chalk.dim("  (if the page asks for it)"));
  console.log();
  if (options.open !== false && openInBrowser(started.verification_uri_complete)) {
    // "Trying", not "opened": `openInBrowser` returns before a spawned
    // opener can fail (see its own docstring).
    console.log(chalk.dim("  (trying to open your browser; use the link above if it doesn't)"));
    console.log();
  }

  return pollForDeviceToken(started);
}
