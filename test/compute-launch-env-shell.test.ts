/**
 * The launch specification against the scheduler's launch file (epic #2005, contract follow-up A1c,
 * #2043; ADR 0118).
 *
 * THE HAZARD. The launch specification travels as ONE scheduler environment value. The review of the
 * launcher phase read the scheduler as writing an environment value into a file that a shell sources
 * on the compute node, and as quoting it only conditionally; that reading is UNVERIFIED against a real
 * scheduler, and `backend/test/helpers/scheduler-launch-file.ts` writes the rule out. On that reading,
 * compact JSON is not shell-inert: a value with no space is left bare and the shell eats the quotes of
 * the JSON, and shell-active characters in a user's strings are expanded or break the quoting.
 *
 * WHAT IS ASSERTED, with a real `sh` in a fresh sandbox directory (the only place a command in these
 * inert examples ever writes, a `touch` of a path inside it):
 *  (a) THE NEGATIVE CONTROL. The wire value as it was before A1c, written out here and not imported,
 *      does NOT survive: no space, and `$(...)`, a backtick, `"` and a backslash in a user string each
 *      fail the round trip. `$(...)` and a backtick make the shell RUN what the value holds. One case
 *      it carries (a space and nothing else) is asserted too, so the detector is seen to tell the
 *      cases apart, and each failing case asserts that what the shell printed is not the value.
 *  (b) THE NEW VALUE, the specification's text in base64url, comes back from the shell EXACTLY, for
 *      arguments, a command and environment values full of what a shell treats as special and for a
 *      document of 64 KiB, and no file is made by sourcing it. What the launcher then does (decode
 *      strictly, hash the TEXT, parse) is asserted on what the shell printed.
 *
 * `test/compute-contract.unit.test.ts` pins the alphabet, the bound and the strict decoder; this file
 * is what shows the alphabet is the thing that matters.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Sandbox,
  launchFileLine,
  makeSandbox,
  schedulerQuote,
  sourceLaunchFile,
} from "../backend/test/helpers/scheduler-launch-file";
import {
  LAUNCH_SPEC_ENV_MAX_CHARS,
  LAUNCH_SPEC_MAX_BYTES,
  LaunchSpecSchema,
  SHELL_INERT_ENV_ALPHABET,
  decodeLaunchSpecEnv,
  encodeLaunchSpec,
  encodeLaunchSpecEnv,
  isShellInertEnvValue,
} from "../shared/contract/compute-launch";

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** Run `body` with a fresh sandbox and remove it afterwards, whatever happened. */
async function withSandbox<T>(body: (sandbox: Sandbox) => T | Promise<T>): Promise<T> {
  const sandbox = makeSandbox();
  try {
    return await body(sandbox);
  } finally {
    sandbox.remove();
  }
}

const HEX_B = "b".repeat(64);

/** A launch specification with the user-supplied parts left to each case. */
function launchSpec(over: Record<string, unknown> = {}) {
  return {
    job_id: "job_0123456789abcdef01234567",
    runtime: "python",
    entry: "run.py",
    args: [] as string[],
    bundle: { sha256: "a".repeat(64), size: 1234 },
    datasets: [{ id: "nm000104", version: "v1.0.2" }],
    api_base: "https://api.example.test",
    image: {
      uri: `docker://ghcr.io/example/runtime@sha256:${HEX_B}`,
      digest: `sha256:${HEX_B}`,
      sif: `${HEX_B}.sif`,
    },
    env: { OMP_NUM_THREADS: "4" },
    resources: { gpus: 0 },
    limits: { max_files: 38000, max_total_bytes: 1073741824 },
    job_token: "t".repeat(43),
    ...over,
  };
}

/**
 * THE NEGATIVE CONTROL: the wire value as it was before A1c. The specification validated, then
 * compact JSON with every UTF-16 unit from U+007F up written as a lowercase `\uXXXX` escape. Kept here,
 * not imported, so that a later change to the contract cannot quietly turn the control into the
 * thing under test.
 */
function legacyWireValue(spec: unknown): string {
  return JSON.stringify(LaunchSpecSchema.parse(spec)).replace(
    /[\u007f-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

describe("the scheduler's quoting, as the test writes it", () => {
  test("a value is left bare unless it holds a space, &, >, <, |, ; or a backtick, and then it is double-quoted with only the double quote escaped", () => {
    // Left bare: no trigger, whatever else is in it (this is the rule, which is the whole hazard).
    for (const bare of [
      "abc",
      '{"a":"b"}',
      "a$(x)b",
      "a\\b",
      "a'b",
      "a*b?c",
      "a!b#c~d=e",
      "{a,b}",
      "a(b)c",
      "a\nb",
      SHELL_INERT_ENV_ALPHABET,
    ]) {
      expect(schedulerQuote(bare), JSON.stringify(bare)).toBe(bare);
    }
    // Quoted: each trigger alone.
    for (const trigger of [" ", "&", ">", "<", "|", ";", "`"]) {
      expect(schedulerQuote(`a${trigger}b`), JSON.stringify(trigger)).toBe(`"a${trigger}b"`);
    }
    // Only the double quote is escaped, and every one of them: a backslash is left as it is.
    expect(schedulerQuote('a "b" c')).toBe('"a \\"b\\" c"');
    expect(schedulerQuote("a \\ c")).toBe('"a \\ c"');
    expect(schedulerQuote('a\\"b c')).toBe('"a\\\\"b c"');
    expect(launchFileLine("x y")).toBe('export NEMAR_LAUNCH_SPEC="x y"\n');
    expect(launchFileLine("xy")).toBe("export NEMAR_LAUNCH_SPEC=xy\n");
  });

  test("a real shell reads a value back that the rule leaves bare and the shell has nothing to act on", async () => {
    await withSandbox((sandbox) => {
      const sourced = sourceLaunchFile("abc-DEF_123", sandbox);
      expect(sourced).toMatchObject({ status: 0, seen: "abc-DEF_123", made: [], intact: true });
    });
  });
});

describe("the helper cannot be fooled by a shell that does not work", () => {
  /** Run `body` with `NEMAR_TEST_SH` set to `shell`, and put the variable back. */
  function withShell<T>(shell: string, body: () => T): T {
    const before = process.env.NEMAR_TEST_SH;
    process.env.NEMAR_TEST_SH = shell;
    try {
      return body();
    } finally {
      if (before === undefined) Reflect.deleteProperty(process.env, "NEMAR_TEST_SH");
      else process.env.NEMAR_TEST_SH = before;
    }
  }

  test("a shell that is not there fails the test: it does not make every negative control pass", async () => {
    await withSandbox((sandbox) => {
      const missing = join(sandbox.dir, "no-such-shell");
      expect(() => withShell(missing, () => sourceLaunchFile("abc", sandbox))).toThrow(
        "the shell could not be run",
      );
    });
  });

  test("a shell that is killed fails the test, with the signal", async () => {
    await withSandbox((sandbox) => {
      const doomed = join(sandbox.dir, "doomed-shell");
      writeFileSync(doomed, "#!/bin/sh\nkill -KILL $$\n");
      chmodSync(doomed, 0o755);
      expect(() => withShell(doomed, () => sourceLaunchFile("abc", sandbox))).toThrow(
        "the shell did not exit (signal SIGKILL)",
      );
    });
  });

  test("the working shell still reads a plain value back (so the two throws above are the shell's)", async () => {
    await withSandbox((sandbox) => {
      expect(sourceLaunchFile("abc", sandbox)).toMatchObject({ status: 0, seen: "abc" });
    });
  });
});

describe("(a) the old wire value, the JSON text itself, does not survive the scheduler's launch file", () => {
  interface Case {
    label: string;
    args: (sandbox: Sandbox) => string[];
    /** Whether the OLD value comes back byte for byte. */
    intact: boolean;
    /** Whether a command the value holds RAN, which a file in the sandbox shows. */
    ran: boolean;
    /** What it is that fails, for the reader of a failure. */
    why: string;
  }

  const CASES: Case[] = [
    {
      label: "no space and nothing shell-active in a user string",
      args: () => ["--fast"],
      intact: false,
      ran: false,
      why: "the value is written bare, so the shell removes the JSON's own quotes (bash also splits it at the commas)",
    },
    {
      label: "a command substitution in a user string",
      args: (sandbox) => ["a b", `$(touch ${sandbox.sentinel})`],
      intact: false,
      ran: true,
      why: "the value is double-quoted, and the shell still runs $(...) inside double quotes",
    },
    {
      label: "a command substitution to a relative path",
      args: (sandbox) => [`$(touch ${sandbox.relativeSentinel})`],
      intact: false,
      ran: true,
      why: "the same, to a path relative to the shell's working directory",
    },
    {
      label: "a backtick command in a user string",
      args: (sandbox) => [`\`touch ${sandbox.sentinel}\``],
      intact: false,
      ran: true,
      why: "a backtick makes the scheduler quote the value, and the shell runs it inside the quotes",
    },
    {
      label: "a variable in a user string",
      args: () => ["a b", "$PATH"],
      intact: false,
      ran: false,
      why: "the shell expands $PATH inside double quotes",
    },
    {
      label: "a double quote in a user string",
      args: () => ["a b", 'say "hi"'],
      intact: false,
      ran: false,
      why: "JSON writes \\\" and the scheduler escapes the quote again, which ends the shell's quote early",
    },
    {
      label: "a backslash in a user string",
      args: () => ["a b", "C:\\dir\\file"],
      intact: false,
      ran: false,
      why: "the shell reads \\\\ inside double quotes as one backslash",
    },
    {
      label: "CONTROL: a space and nothing else shell-active",
      args: () => ["--label", "a b"],
      intact: true,
      ran: false,
      why: "the one shape the old value did carry: double-quoted, and nothing in it the shell acts on",
    },
  ];

  for (const c of CASES) {
    test(`${c.label}: ${c.intact ? "comes back" : "does not come back"}${c.ran ? ", and a command it holds runs" : ""}`, async () => {
      await withSandbox((sandbox) => {
        const spec = launchSpec({ args: c.args(sandbox) });
        const old = legacyWireValue(spec);
        // The control is the very text `encodeLaunchSpec` still writes, which every digest is over.
        expect(old).toBe(encodeLaunchSpec(spec));
        const sourced = sourceLaunchFile(old, sandbox);
        const printed = `printed ${JSON.stringify(sourced.seen.slice(0, 80))}`;
        if (c.intact) {
          expect(sourced.seen, `${c.why} (${printed})`).toBe(old);
          expect(sourced.status).toBe(0);
        } else {
          // What the shell printed is not the value: that is why this case fails, and not a shell that
          // failed to run, which the helper throws at.
          expect(sourced.seen, `${c.why} (${printed})`).not.toBe(old);
        }
        expect(sourced.intact, `${c.why} (${printed})`).toBe(c.intact);
        const ran = sourced.made.some((name) => name.startsWith("made-by-the-value"));
        expect(ran, `${c.why} (made ${JSON.stringify(sourced.made)})`).toBe(c.ran);
      });
    });
  }

  test("the detector does not cry wolf: the control case round-trips and creates nothing", async () => {
    await withSandbox((sandbox) => {
      const sourced = sourceLaunchFile(
        legacyWireValue(launchSpec({ args: ["--label", "a b"] })),
        sandbox,
      );
      expect(sourced.intact).toBe(true);
      expect(sourced.made).toEqual([]);
      expect(sourced.stderr).toBe("");
    });
  });
});

describe("(b) the new value, the text in base64url, comes back from the shell exactly", () => {
  /**
   * Strings a shell, a glob or a quoting rule has something to say about, each inert as written.
   * Most are printable ASCII: the operators, the quotes, `$`, the backtick, the glob characters. Three
   * entries in the MIDDLE of the list are control characters, which a shell also acts on (a newline, a
   * tab, a carriage return). The last five are not printable ASCII either (an accented character, an
   * astral character, DEL, NUL, U+2028). Every one of them travels as an escape: JSON escapes the
   * control characters (the newline, the tab, the carriage return and NUL), and `encodeLaunchSpec`
   * escapes DEL and everything from 0x80 up, so the TEXT built from the corpus is printable. The
   * wire encoder would refuse the raw bytes (the contract tests pin that); what is shown here is that
   * the escapes survive a shell.
   */
  const adversarial = (sandbox: Sandbox): string[] => [
    "a b",
    `$(touch ${sandbox.sentinel})`,
    `$(touch ${sandbox.relativeSentinel})`,
    `\`touch ${sandbox.sentinel}\``,
    `\`touch ${sandbox.relativeSentinel}\``,
    'say "hi"',
    "C:\\dir\\file",
    "a;b",
    "a&b",
    "a|b",
    "a<b",
    "a>b",
    "a;b&c|d<e>f",
    "line1\nline2",
    "tab\there",
    "cr\rhere",
    "$HOME",
    "${PATH}",
    "$$",
    "$?",
    "~",
    "*",
    "?",
    "[a-z]*",
    "!",
    "#",
    "%s",
    "'single'",
    "a=b",
    "--flag=$(x)",
    "\\n",
    "\\",
    '"',
    "'",
    "`",
    "$(",
    "))",
    "&&",
    "||",
    ";;",
    ">>",
    "<<EOF",
    "caf\u00e9",
    "\u{1F600}",
    "\u007f",
    "\u0000",
    "\u2028",
  ];

  /** Put a specification through the encoder, the scheduler's quoting and a real shell, and judge it. */
  function roundTrip(spec: unknown, sandbox: Sandbox) {
    const text = encodeLaunchSpec(spec);
    const value = encodeLaunchSpecEnv(text);
    const sourced = sourceLaunchFile(value, sandbox);
    return { text, value, sourced };
  }

  test("each adversarial string, alone in the arguments, comes back exactly and makes nothing", async () => {
    await withSandbox((sandbox) => {
      for (const arg of adversarial(sandbox)) {
        const { text, value, sourced } = roundTrip(launchSpec({ args: [arg] }), sandbox);
        const label = JSON.stringify(arg);
        // The TEXT is printable ASCII whatever the string is, so the encoder never refuses a real one.
        expect(/^[\x20-\x7e]+$/.test(text), label).toBe(true);
        expect(isShellInertEnvValue(value), label).toBe(true);
        // The value is bare in the launch file: nothing for the scheduler to quote.
        expect(schedulerQuote(value), label).toBe(value);
        expect(sourced.status, label).toBe(0);
        expect(sourced.seen, label).toBe(value);
        expect(sourced.intact, label).toBe(true);
        expect(sourced.stderr, label).toBe("");
        // No command in the value ran: the sandbox holds nothing but the launch file.
        expect(sourced.made, label).toEqual([]);
        // And what the launcher reads from it is the string that was sent.
        const decoded = decodeLaunchSpecEnv(sourced.seen);
        expect(decoded.ok, label).toBe(true);
        const parsed = LaunchSpecSchema.parse(JSON.parse(decoded.ok ? decoded.text : "{}"));
        expect(parsed.args, label).toEqual([arg]);
      }
    });
  });

  test("all of them together, in the command, the arguments and the environment values", async () => {
    await withSandbox((sandbox) => {
      const strings = adversarial(sandbox);
      // An environment value is printable ASCII of at most 256 characters (the contract's own rule for
      // a job's environment), so only the entries that are go there. The others are arguments only.
      const printable = strings.filter((s) => /^[ -~]*$/.test(s) && s.length <= 256);
      // A command and no entry: exactly one of the two, and the bundle only an entry needs is left out.
      const { entry: _entry, bundle: _bundle, ...base } = launchSpec();
      const spec = {
        ...base,
        command: ["sh", "-c", ...strings.slice(0, 20)],
        args: strings,
        env: { OMP_NUM_THREADS: printable[1], MPLBACKEND: printable.join(" ").slice(0, 256) },
      };
      const { text, value, sourced } = roundTrip(spec, sandbox);
      expect(/^[\x20-\x7e]+$/.test(text)).toBe(true);
      expect(sourced.intact).toBe(true);
      expect(sourced.made).toEqual([]);
      const decoded = decodeLaunchSpecEnv(sourced.seen);
      expect(decoded).toEqual({ ok: true, text });
      expect(LaunchSpecSchema.parse(JSON.parse(text))).toEqual(LaunchSpecSchema.parse(spec));
      // The digest is over the TEXT the launcher decodes, and is not the digest of the value.
      expect(sha256(decoded.ok ? decoded.text : "")).toBe(sha256(text));
      expect(sha256(text)).not.toBe(sha256(value));
    });
  });

  test("a document of exactly 64 KiB, full of what a shell acts on, is 87382 characters and comes back exactly", async () => {
    await withSandbox((sandbox) => {
      // Every character of the filler is one byte in JSON, so the tail brings the document to the cap
      // to the byte. The head carries a quote and a backslash, which JSON writes as two bytes each.
      const pattern = `$(touch ${sandbox.sentinel}) \`touch y\` ;&|<> '*?[]{}~!#%=() `;
      const filler = (n: number) => pattern.repeat(Math.ceil(n / pattern.length)).slice(0, n);
      const head = 'say "hi" C:\\dir ';
      const withTail = (m: number) =>
        launchSpec({
          args: [
            `${head}${filler(1024 - head.length)}`,
            ...Array.from({ length: 62 }, () => filler(1024)),
            filler(m),
          ],
        });
      const m = LAUNCH_SPEC_MAX_BYTES - encodeLaunchSpec(withTail(0)).length;
      expect(m).toBeGreaterThan(0);
      expect(m).toBeLessThanOrEqual(1024);
      const spec = withTail(m);
      const { text, value, sourced } = roundTrip(spec, sandbox);
      expect(text.length).toBe(LAUNCH_SPEC_MAX_BYTES);
      expect(value.length).toBe(LAUNCH_SPEC_ENV_MAX_CHARS);
      expect(sourced.status).toBe(0);
      expect(sourced.seen.length).toBe(LAUNCH_SPEC_ENV_MAX_CHARS);
      expect(sourced.intact).toBe(true);
      expect(sourced.made).toEqual([]);
      const decoded = decodeLaunchSpecEnv(sourced.seen);
      expect(decoded).toEqual({ ok: true, text });
      expect(LaunchSpecSchema.parse(JSON.parse(text)).args).toEqual(spec.args);
      // One byte more is refused where the text is made, so no longer value is ever written.
      expect(() => encodeLaunchSpec(withTail(m + 1))).toThrow(RangeError);
    });
  });

  test("every character of the alphabet, alone and at each end of a value, is left as it is by a shell", async () => {
    await withSandbox((sandbox) => {
      const values = [
        SHELL_INERT_ENV_ALPHABET,
        SHELL_INERT_ENV_ALPHABET.repeat(40),
        ...[...SHELL_INERT_ENV_ALPHABET].flatMap((c) => [c, `${c}abc${c}`]),
      ];
      for (const value of values) {
        expect(isShellInertEnvValue(value)).toBe(true);
        const sourced = sourceLaunchFile(value, sandbox);
        expect(sourced.intact, JSON.stringify(value.slice(0, 12))).toBe(true);
        expect(sourced.made).toEqual([]);
      }
    });
  });

  test("characters the Tapis client refuses are ones a shell does change, in a bare value and in a quoted one", async () => {
    await withSandbox((sandbox) => {
      // Each is outside the alphabet (`isShellInertEnvValue` is false), and each is read back changed.
      // Not every character outside the alphabet is one a shell changes (`+`, `/` and `=` are not);
      // the alphabet is the set that is known safe, not the set that is known unsafe.
      const failing = [
        `abc"def"ghi`, // bare: the shell consumes the quotes
        "abc'def'ghi", // bare: the shell consumes the quotes
        "abc\\ndef", // bare: a backslash escapes the next character
        "abc$HOMEdef", // bare: the shell expands it
        "abc $PATH def", // quoted (a space): the shell expands it
        "abc\\\\ def", // quoted (a space): two backslashes become one
      ];
      for (const value of failing) {
        expect(isShellInertEnvValue(value), JSON.stringify(value)).toBe(false);
        expect(sourceLaunchFile(value, sandbox).intact, JSON.stringify(value)).toBe(false);
      }
    });
  });
});
