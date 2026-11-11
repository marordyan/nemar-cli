/**
 * Fake `OIDC_SECRET` values for tests, in the form the Worker requires (`nmsso-` and a body; ADR
 * 0119). Built at runtime from a label, so no secret-shaped literal sits in the tree and a
 * production value is never imitated: the body is the label's own bytes as hex, zero padded.
 * Two different labels give two different valid secrets.
 */

import { OIDC_SECRET_PREFIX } from "../../../shared/oidc";

/** `nmsso-` plus `bodyLength` hex characters (64 by default, the length of the real ones). */
export function fakeOidcSecret(label: string, bodyLength = 64): string {
  const hex = [...new TextEncoder().encode(label)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${OIDC_SECRET_PREFIX}${hex.padEnd(bodyLength, "0").slice(0, bodyLength)}`;
}

/**
 * Values `OIDC_SECRET` must NOT take, by what is wrong with them. Every one is a string the old
 * "at least 32 characters" rule would have accepted, except the first four, so the table is also the
 * proof that the prefix, and not the length, is what decides. Non-strings are typed `unknown`
 * because a Worker binding is only ever a string and the check must hold regardless.
 */
export const BAD_OIDC_SECRETS: ReadonlyArray<readonly [string, unknown]> = [
  ["unset", undefined],
  ["empty", ""],
  ["null", null],
  ["31 characters, no prefix", "x".repeat(31)],
  ["the prefix and 25 more is 31 in all", `nmsso-${"a".repeat(25)}`],
  ["the prefix alone", "nmsso-"],
  ["long but no prefix", "x".repeat(70)],
  ["the old rig form", `rig-oidc-secret-${"0123456789abcdef".repeat(3)}`],
  ["an uppercase prefix", `NMSSO-${"0123456789abcdef".repeat(4)}`],
  ["a mixed-case prefix", `Nmsso-${"0123456789abcdef".repeat(4)}`],
  ["a different separator", `nmsso_${"0123456789abcdef".repeat(4)}`],
  ["the prefix not at the start", ` nmsso-${"0123456789abcdef".repeat(4)}`],
  ["a space in the body", `nmsso-${"0123456789abcdef".repeat(2)} ${"0123456789abcdef".repeat(2)}`],
  [
    "a newline in the body",
    `nmsso-${"0123456789abcdef".repeat(2)}\n${"0123456789abcdef".repeat(2)}`,
  ],
  ["a trailing newline", `${fakeOidcSecret("trailing")}\n`],
  ["a non-ASCII character in the body", `nmsso-${"0123456789abcdef".repeat(3)}é`],
  ["a number", 42],
  ["an object with a length", { length: 70, startsWith: () => true }],
];

/** Values that ARE valid: exactly the minimum length, and the length the real ones have. */
export const GOOD_OIDC_SECRETS: ReadonlyArray<readonly [string, string]> = [
  ["32 characters in all", fakeOidcSecret("good-min", 26)],
  ["70 characters in all", fakeOidcSecret("good-real", 64)],
  ["letters, digits, underscore and hyphen", `nmsso-${"aZ09_-".repeat(10)}`],
];
