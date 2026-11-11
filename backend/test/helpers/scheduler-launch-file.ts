/**
 * The scheduler's launch file and a shell that sources it (epic #2005, contract follow-up A1c, #2043).
 *
 * THE HAZARD this reproduces. The launch specification travels as ONE scheduler environment value.
 * The review of the launcher phase read the scheduler as writing an environment value into a file
 * that a shell sources on the compute node, and as quoting the value only conditionally: left bare
 * unless it contains a space or one of `&`, `>`, `<`, `|`, `;` or a backtick, and then wrapped in
 * double quotes with only `"` escaped. That reading is UNVERIFIED against a real scheduler, and
 * these helpers do not claim to be one. They are the rule, written out, so a test can put a value
 * through it and through a real `sh` and see what comes back.
 *
 * What it shows, and what the tests built on it rely on. Compact JSON is not shell-inert: a value
 * with no space is written bare, and the shell then removes the quotes of the JSON (bash also splits
 * it at the commas); a value with a space is double-quoted, and the shell then still expands `$(...)`,
 * `$NAME` and a backtick inside it, and reads two backslashes, and a backslash before a quote, as
 * escapes. A base64url value (`A-Za-z0-9-_`) holds none of the characters the rule quotes for and
 * none the shell treats as special, so it comes back byte for byte.
 *
 * `sourceLaunchFile` runs a real `sh` in a fresh sandbox directory (its working directory, and the only
 * place the commands the tests use ever write): the adversarial strings are inert examples, a `touch`
 * of a path inside that directory. The directory is listed afterwards, so a file made by ANY command
 * in the value, at an absolute path or a relative one, is seen.
 *
 * What `sh` is differs by machine (bash in its POSIX mode on macOS, dash on most Linux), and no
 * assertion built on this depends on which it is: `NEMAR_TEST_SH` names another shell to run the same
 * assertions under (dash, ksh, bash).
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LAUNCHER_ENV } from "../../../shared/contract/compute";

/** The characters that make the scheduler quote a value: a space, `&`, `>`, `<`, `|`, `;` and a backtick. */
const QUOTE_TRIGGER = /[ &><|;`]/;

/** The value as the scheduler writes it: bare, or in double quotes with only `"` escaped. */
export function schedulerQuote(value: string): string {
  return QUOTE_TRIGGER.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

/** The line the scheduler writes into its launch file for the launch specification. */
export function launchFileLine(value: string, name: string = LAUNCHER_ENV.SPEC): string {
  return `export ${name}=${schedulerQuote(value)}\n`;
}

/** The sandbox a launch file is sourced in: a fresh directory, and a path in it for a command to make. */
export interface Sandbox {
  dir: string;
  /** An absolute path inside the sandbox: what an adversarial string asks `touch` to make. */
  sentinel: string;
  /** The name of a file made by a RELATIVE path, which lands in the sandbox, the shell's working directory. */
  relativeSentinel: string;
  remove(): void;
}

const LAUNCH_FILE = "launch.env";

export function makeSandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "nemar-launch-file-"));
  return {
    dir,
    sentinel: join(dir, "made-by-the-value"),
    relativeSentinel: "made-by-the-value-too",
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export interface Sourced {
  /** The shell's exit status. A shell that did not run or did not exit is thrown at, never reported. */
  status: number;
  /** What `printf %s "$NEMAR_LAUNCH_SPEC"` printed after the file was sourced. */
  seen: string;
  stderr: string;
  /** Everything in the sandbox but the launch file itself: what the value's commands made. */
  made: string[];
  /** The value came back byte for byte, and the shell was content. */
  intact: boolean;
}

/**
 * Write the scheduler's line for `value` into a file, source it with `sh` in the sandbox, and print the
 * variable back. `intact` is the round trip: the shell exited 0 AND printed exactly `value`.
 *
 * Throws if the shell could not be run or did not exit (it was killed, or timed out). A shell that
 * failed to run prints nothing, which is not what a value is read back as, and would let every
 * negative control "fail" for a reason that is not the hazard; a test that cannot trust its shell
 * must fail, not pass.
 */
export function sourceLaunchFile(value: string, sandbox: Sandbox): Sourced {
  const file = join(sandbox.dir, LAUNCH_FILE);
  writeFileSync(file, launchFileLine(value));
  const shell = process.env.NEMAR_TEST_SH ?? "sh";
  const run = spawnSync(shell, ["-c", `. "$1"; printf %s "$${LAUNCHER_ENV.SPEC}"`, "sh", file], {
    cwd: sandbox.dir,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    // `touch` is found on PATH; the locale is fixed so nothing depends on the machine's.
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C" },
  });
  if (run.error) throw new Error(`the shell could not be run: ${run.error.message}`);
  if (run.status === null) throw new Error(`the shell did not exit (signal ${run.signal})`);
  const seen = run.stdout ?? "";
  return {
    status: run.status,
    seen,
    stderr: run.stderr ?? "",
    made: readdirSync(sandbox.dir).filter((name) => name !== LAUNCH_FILE),
    intact: run.status === 0 && seen === value,
  };
}
