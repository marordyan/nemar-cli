/**
 * The OpenID Connect subject of an account (epic #2014 phase #2015; ADR 0119, decision 5).
 *
 * Pure and import-free. The Worker and the tests read this one definition; any other repository
 * that needs it transcribes it (as `shared/contract/account-copy.ts` is transcribed by the
 * website), and nothing outside this repository reads this file today.
 *
 * A subject is `nmu_` plus 32 lowercase hexadecimal characters: 128 random bits, assigned when the
 * account row is created (migration 0120), never changed and never reused, and neither the row
 * number nor the email address nor anything a person chose. Its format is fixed before any client
 * trusts it, because a client stores it as the account's name.
 *
 * `nmu_` is a reserved username prefix (`validateUsernameFormat` in the backend), so no person,
 * service or pipeline name can collide with a subject.
 */

/** Every subject starts with this, and no username may. */
export const OIDC_SUBJECT_PREFIX = "nmu_";

/** The number of lowercase hexadecimal characters after the prefix (128 bits). */
export const OIDC_SUBJECT_HEX_LENGTH = 32;

const SUBJECT_RE = new RegExp(`^${OIDC_SUBJECT_PREFIX}[0-9a-f]{${OIDC_SUBJECT_HEX_LENGTH}}$`);

/**
 * A string that has passed {@link isOidcSubject}. Branded, so that the guard's false branch does
 * not narrow a `string` input to `never` (a guard of `value is string` does exactly that), and so
 * a function can ask for a checked subject in its signature.
 */
export type OidcSubject = string & { readonly __oidcSubject: true };

/**
 * True for a string of exactly the subject format. A type guard to {@link OidcSubject}: a value
 * that passed is a checked subject for the caller, and one that did not is still the `string` it
 * was (a number, null or a near miss is simply false).
 */
export function isOidcSubject(value: unknown): value is OidcSubject {
  return typeof value === "string" && SUBJECT_RE.test(value);
}

type IsNever<T> = [T] extends [never] ? true : false;

/**
 * Compile-time proof, never called: after the guard fails, a `string` input is still a `string`.
 * A guard of `value is string` would narrow it to `never` here, `proof` below would then be
 * `true`, and the assignment to `false` would stop compiling. Same device as
 * `_profileErrorsAreDeclared` in the backend's `services/profile.ts`: `tsc` checks this file, and
 * `bun test` checks no types at all, so the proof lives where the compiler reads it.
 */
export function _elseBranchIsNotNever(input: string): false {
  if (isOidcSubject(input)) return false;
  const proof: IsNever<typeof input> = false;
  return proof;
}
