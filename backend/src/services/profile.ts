/**
 * Profile self-service helpers (#912), used by PATCH /auth/profile in
 * auth-web.ts. Pure functions so the semantics are unit-testable without a
 * Worker (same pattern as decideLinkOutcome / decideVerifiedFlag in
 * orcid-auth.ts).
 *
 * Field semantics, per the website Settings form (nemarOrg/website PR #144):
 *   - github_username: optional handle; empty string clears it (NULL). It is
 *     only *required* at publish time, not here. A leading "@" is stripped
 *     because people paste their handle that way.
 *   - city / country: required non-empty once submitted (US export-control
 *     screening, #835). The columns are nullable in D1 (migration 0052)
 *     for pre-existing rows; the non-empty rule lives here, at the write.
 *   - affiliation: optional free text; empty string clears it (NULL).
 *   - username: format-checked here, uniqueness and the post-approval lock
 *     checked at the route (both need the database). Added in ADR 0042 — a
 *     web/ORCID account has none, and an upload request cannot be approved
 *     without one, so this is the only way those 19 rows get a login handle.
 *     Never cleared: an empty string is a refusal, not a NULL.
 *   - given_name / family_name: accepted ONLY when the account has no verified
 *     ORCID link. NAMES STAY ORCID-CANONICAL when one is linked (#835): the
 *     record is re-read on every login and link, so a hand-edited value would
 *     be silently overwritten by the next sign-in — which is worse than
 *     refusing the edit. ADR 0041 relied on that rule and noted that ADR 0042
 *     would have to qualify it: an account whose ORCID record hides its name
 *     had no self-service fix at all, and could therefore never publish. The
 *     rule now covers exactly the accounts ORCID actually speaks for; the route
 *     answers 409 `name_is_orcid_canonical` for the rest.
 */

import type { ProfileEditErrorCode } from "../../../shared/contract/user.js";
import { normalizeGithubHandle } from "./identity";
import { type UsernameFormatError, validateUsernameFormat } from "./username";

/**
 * GitHub handle rule, matching the website's client-side check: 1-39 chars,
 * alphanumeric or hyphen, no leading/trailing/consecutive hyphens. Stricter
 * than the CLI signup regex (which permits consecutive hyphens GitHub itself
 * refuses); existing stored handles are unaffected because this only gates
 * new writes.
 */
export const GITHUB_HANDLE_RE = /^[a-zA-Z\d](?:[a-zA-Z\d]|-(?=[a-zA-Z\d])){0,38}$/;

/** Sparse update: `undefined` = field absent from the PATCH, `null` = clear. */
export interface ProfilePatch {
  github_username?: string | null;
  city?: string;
  country?: string;
  affiliation?: string | null;
  username?: string;
  given_name?: string;
  family_name?: string;
}

export interface ProfilePatchInput {
  github_username?: string;
  city?: string;
  country?: string;
  affiliation?: string;
  username?: string;
  given_name?: string;
  family_name?: string;
}

/** The closed error vocabulary of normalizeProfilePatch; the website's error
 *  mapping switches on these strings (nemarOrg/website PR #144, #301). The
 *  four `username_*` values (`username_reserved` was added by ADR 0119) are
 *  re-exported from services/username.ts so the rule and its error codes have
 *  one definition. */
export type ProfilePatchError =
  | "invalid_github_username"
  | "city_required"
  | "country_required"
  | "empty_patch"
  | UsernameFormatError
  | "given_name_required"
  | "family_name_required";

export type NormalizeResult =
  | { ok: true; patch: ProfilePatch }
  | { ok: false; error: ProfilePatchError; message: string };

/**
 * Compile-time proof that every refusal this module can raise is in the
 * shared vocabulary the CLI renders from (#1266, ADR 0044).
 *
 * The CLI prints `error` for an ordinary failure and `message` for a body
 * whose `error` is a machine code; it decides which by membership in
 * `PROFILE_EDIT_ERROR_CODES`. A code added here and not there does not fail
 * anywhere — it just prints the word `city_required` at a person — so the
 * alias below resolves to `never` and the assignment stops compiling instead.
 */
type AllDeclared<A extends string, B extends string> = [A] extends [B] ? true : never;
export const _profileErrorsAreDeclared: AllDeclared<ProfilePatchError, ProfileEditErrorCode> = true;

/**
 * The body of a route-level self-service refusal, with the code CHECKED.
 *
 * The alias above only covers the codes `normalizeProfilePatch` returns. The
 * ten raised by the routes themselves -- `username_taken`, `username_locked`,
 * `name_is_orcid_canonical`, `account_revoked`, `github_unavailable`,
 * `same_email`, `code_expired`, `code_incorrect`, `orcid_already_have`,
 * `orcid_unavailable` -- were bare string literals in `c.json({ error: "..." })`
 * calls, so the ADR's claim that a missing code "fails to compile" was true of
 * a third of them (PR #1269 review item 17). Going through this function makes
 * it true of all of them: the parameter is `ProfileEditErrorCode`, so a typo or
 * an undeclared code is a compile error at the call site rather than a bare
 * token printed at a person.
 *
 * `error` carries the code because that is where the browser-facing routes
 * have always put it (ADR 0043); extra fields are spread in by the caller.
 */
export function profileRefusal(
  code: ProfileEditErrorCode,
  message: string,
): { error: ProfileEditErrorCode; message: string } {
  return { error: code, message };
}

/**
 * Normalize a raw PATCH body into a sparse, validated update. Keys absent
 * from the input stay absent from the patch (true PATCH semantics); the
 * website always sends all four, but the endpoint contract is any subset.
 */
export function normalizeProfilePatch(input: ProfilePatchInput): NormalizeResult {
  const patch: ProfilePatch = {};

  if (input.github_username !== undefined) {
    // One spelling of the handle rule, shared with signup and the duplicate
    // report (services/identity.ts, ADR 0043).
    const handle = normalizeGithubHandle(input.github_username);
    if (handle.length === 0) {
      patch.github_username = null;
    } else if (!GITHUB_HANDLE_RE.test(handle)) {
      return {
        ok: false,
        error: "invalid_github_username",
        message:
          "GitHub username must be 1-39 characters, alphanumeric or hyphens, and cannot start, end, or double up on a hyphen",
      };
    } else {
      patch.github_username = handle;
    }
  }

  if (input.city !== undefined) {
    const city = input.city.trim();
    if (city.length === 0) {
      return { ok: false, error: "city_required", message: "City cannot be empty" };
    }
    patch.city = city;
  }

  if (input.country !== undefined) {
    const country = input.country.trim();
    if (country.length === 0) {
      return { ok: false, error: "country_required", message: "Country cannot be empty" };
    }
    patch.country = country;
  }

  if (input.affiliation !== undefined) {
    const affiliation = input.affiliation.trim();
    patch.affiliation = affiliation.length === 0 ? null : affiliation;
  }

  if (input.username !== undefined) {
    // Trimmed, never lowercased: the stored case is the user's own choice and
    // every comparison around it is COLLATE NOCASE. Unlike the other optional
    // fields an empty string does NOT clear this one — the account still needs
    // a handle, and a NULL username is the state ADR 0042 exists to end.
    const username = input.username.trim();
    const formatError = validateUsernameFormat(username);
    if (formatError) return { ok: false, ...formatError };
    patch.username = username;
  }

  if (input.given_name !== undefined) {
    const given = input.given_name.trim();
    if (given.length === 0) {
      return {
        ok: false,
        error: "given_name_required",
        message: "Given name cannot be empty",
      };
    }
    patch.given_name = given;
  }

  if (input.family_name !== undefined) {
    const family = input.family_name.trim();
    if (family.length === 0) {
      return {
        ok: false,
        error: "family_name_required",
        message: "Family name cannot be empty",
      };
    }
    patch.family_name = family;
  }

  if (Object.keys(patch).length === 0) {
    return { ok: false, error: "empty_patch", message: "No profile fields provided" };
  }

  return { ok: true, patch };
}

/**
 * Whether a submitted handle needs the external GitHub existence + dedup
 * checks. Re-saving your own current handle (case-insensitively) is a no-op
 * for those checks — it keeps routine "save profile" clicks from spending a
 * GitHub API call, and from failing when GitHub is unreachable.
 */
export function githubHandleChanged(submitted: string, current: string | null): boolean {
  return submitted.toLowerCase() !== (current ?? "").toLowerCase();
}
