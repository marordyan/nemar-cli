/**
 * The helper that lists every form of a job's token in the launch value (A1c, #2043), held to the real
 * encoder: wherever the token falls in the launch specification's text, the value holds exactly the
 * form of that alignment; a slice of the value that holds the token is found by it; and so is a slice
 * of the token, or of an aligned form, of `SECRET_WINDOW` characters or more.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { encodeLaunchSpec, encodeLaunchSpecEnv } from "../../shared/contract/compute-launch";
import { SECRET_WINDOW, alignedTokenForms, launchSecretForms } from "./helpers/launch-secret-forms";

/** A token of the real shape (64 lowercase hex) that does not repeat, from a fixed seed. */
const TOKEN = createHash("sha256").update("a token for the leak helper").digest("hex");

/** A valid launch specification whose token is `TOKEN`, moved later in the text by `extraBytes` bytes. */
function textWithTokenAfter(extraBytes: number): string {
  const text = encodeLaunchSpec({
    job_id: "job_0123456789abcdef01234567",
    runtime: "python",
    command: ["run", "x".repeat(1 + extraBytes)],
    args: [],
    datasets: [],
    api_base: "https://api.example.test",
    image: {
      uri: `docker://ghcr.io/example/runtime@sha256:${"b".repeat(64)}`,
      digest: `sha256:${"b".repeat(64)}`,
      sif: `${"b".repeat(64)}.sif`,
    },
    env: {},
    resources: { gpus: 0 },
    limits: { max_files: 38000, max_total_bytes: 1073741824 },
    job_token: TOKEN,
  });
  return text;
}

/** A line as a log would write it, with `slice` somewhere in it. */
const logLine = (slice: string) => `[compute-lifecycle] submit_unclear job=job_x ${slice} kind=y`;

/** Whether a leak check over `forms` would flag `line`. */
const flagged = (forms: string[], line: string) => forms.some((form) => line.includes(form));

describe("launchSecretForms", () => {
  test("it lists the plain token, the whole value, and every window of the token and of its three aligned forms", () => {
    const value = encodeLaunchSpecEnv(textWithTokenAfter(0));
    const forms = launchSecretForms(TOKEN, value);
    expect(forms[0]).toBe(TOKEN);
    expect(forms[1]).toBe(value);
    const aligned = alignedTokenForms(TOKEN);
    expect(aligned).toHaveLength(3);
    // Every window of the plain token and of each aligned form is on the list.
    for (const part of [TOKEN, ...aligned]) {
      for (let at = 0; at + SECRET_WINDOW <= part.length; at++) {
        expect(forms, `window ${at} of ${part.slice(0, 8)}...`).toContain(
          part.slice(at, at + SECRET_WINDOW),
        );
      }
    }
    // Nothing else short is on it: past the first two, every form is exactly one window wide.
    for (const form of forms.slice(2)) expect(form.length).toBe(SECRET_WINDOW);
    expect(new Set(forms).size).toBe(forms.length);
    // The plain token is not in the value, which is why the other forms exist.
    expect(value).not.toContain(TOKEN);
  });

  test("whichever alignment the token has in the text, the value holds exactly that alignment's form", () => {
    const seen = new Set<number>();
    for (let extra = 0; extra < 9; extra++) {
      const text = textWithTokenAfter(extra);
      const value = encodeLaunchSpecEnv(text);
      const where = alignedTokenForms(TOKEN).map((form) => value.includes(form));
      expect(where.filter(Boolean), `extra ${extra}`).toHaveLength(1);
      // And it is the alignment the token's position says: its offset in the text, modulo 3.
      expect(where.indexOf(true), `extra ${extra}`).toBe(text.indexOf(TOKEN) % 3);
      seen.add(text.indexOf(TOKEN) % 3);
    }
    // Nine texts reached all three alignments, so each form was shown to be the one that matches.
    expect(seen).toEqual(new Set([0, 1, 2]));
  });

  test("a slice of the value that holds the token is found, though the whole value and the plain token are not in it", () => {
    for (let extra = 0; extra < 3; extra++) {
      const value = encodeLaunchSpecEnv(textWithTokenAfter(extra));
      const forms = launchSecretForms(TOKEN, value);
      // The last 100 characters of the value hold the token's encoding (the token ends the text).
      const tail = value.slice(-100);
      expect(tail).not.toContain(TOKEN);
      expect(tail.includes(value)).toBe(false);
      expect(flagged(forms, tail), `extra ${extra}`).toBe(true);
    }
  });

  test("a log line holding a slice of an aligned form, which is part of the token, fails the check", () => {
    const value = encodeLaunchSpecEnv(textWithTokenAfter(0));
    const forms = launchSecretForms(TOKEN, value);
    for (const [alignment, form] of alignedTokenForms(TOKEN).entries()) {
      // Slices of every length from the window up, from the start, the middle and the end of the form.
      for (const length of [SECRET_WINDOW, SECRET_WINDOW + 1, 24, 40, form.length - 1]) {
        const last = form.length - length;
        for (const at of [0, Math.min(5, last), Math.floor(last / 2), last]) {
          const slice = form.slice(at, at + length);
          expect(slice.length).toBe(length);
          // Not the whole form, not the whole value, not the plain token: only a slice of one form.
          expect(slice).not.toBe(form);
          expect(
            flagged(forms, logLine(slice)),
            `alignment ${alignment}, ${length} characters at ${at}`,
          ).toBe(true);
        }
      }
    }
  });

  test("the same for a slice of the plain token", () => {
    const forms = launchSecretForms(TOKEN, encodeLaunchSpecEnv(textWithTokenAfter(0)));
    for (const at of [0, 10, 24, TOKEN.length - SECRET_WINDOW]) {
      expect(flagged(forms, logLine(TOKEN.slice(at, at + SECRET_WINDOW))), `at ${at}`).toBe(true);
    }
  });

  test("the window is exactly SECRET_WINDOW: one character fewer from the token or from an aligned form is not found", () => {
    const forms = launchSecretForms(TOKEN, encodeLaunchSpecEnv(textWithTokenAfter(0)));
    expect(SECRET_WINDOW).toBe(16);
    for (const part of [TOKEN, ...alignedTokenForms(TOKEN)]) {
      for (const at of [0, 7, part.length - (SECRET_WINDOW - 1)]) {
        const short = part.slice(at, at + SECRET_WINDOW - 1);
        expect(short.length).toBe(SECRET_WINDOW - 1);
        expect(flagged(forms, logLine(short)), `${short} (${short.length} characters)`).toBe(false);
      }
    }
  });

  test("ordinary output is not flagged: identifiers, digests and a launcher's own words", () => {
    const text = textWithTokenAfter(0);
    const forms = launchSecretForms(TOKEN, encodeLaunchSpecEnv(text));
    const digestOfText = createHash("sha256").update(text).digest("hex");
    for (const line of [
      "[compute-lifecycle] submit_unclear job=job_0123456789abcdef01234567 kind=unavailable_unknown",
      `launch_spec_digest=${digestOfText}`,
      `{"job_id":"job_0123456789abcdef01234567","state":"submitted","tapis_status":"PENDING"}`,
      `image=sha256:${"b".repeat(64)} sif=${"b".repeat(64)}.sif`,
      "eyJqb2JfaWQiOiJqb2JfMDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3Iiwicn",
    ]) {
      expect(flagged(forms, line), line).toBe(false);
    }
  });

  test("a token too short to have a form of its own is refused rather than matching everything", () => {
    expect(() => launchSecretForms("abc", "x")).toThrow("too short");
    expect(() => alignedTokenForms("abc")).toThrow("too short");
  });
});
