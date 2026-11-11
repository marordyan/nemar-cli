/**
 * Account tiers: which statuses can use the API at all (ADR 0040, epic #1250).
 *
 * ADR 0040 fixed four statuses and their meanings:
 *   pending  - the account exists, its email is NOT verified.
 *   verified - the email is verified. THE BASE TIER: browse, dashboard,
 *              settings, CLI API key, sandbox training, request upload access.
 *              Needs no admin.
 *   approved - an admin approved the one-time upload request. Approval is the
 *              single writer of `service_access`.
 *   revoked  - access withdrawn.
 *
 * So "can this credential be used" and "may this account upload" are two
 * different questions with two different answers, and this module owns only
 * the first one. The second lives in services/upload-gate.ts and reads
 * `service_access`, never `status` (phase 1, #1251).
 *
 * Before phase 2 every authenticated path required `status = 'approved'`,
 * which is why migration 0075 must not ship without this: 0075 moves the
 * auto-approved web accounts down to `verified`/`pending`, and a middleware
 * that only knows `approved` would lock them out of the tier they now hold.
 */

/** The statuses an account may authenticate with. Everything else (pending,
 *  revoked, and any unrecognised value) is refused at the credential check. */
export const ACTIVE_ACCOUNT_STATUSES = ["verified", "approved"] as const;

export type ActiveAccountStatus = (typeof ACTIVE_ACCOUNT_STATUSES)[number];

/**
 * SQL list literal for `... AND u.status IN <here>`, derived from the array
 * above so the predicate has exactly one definition. Tests import this rather
 * than re-typing the statuses: a hand-copied `IN ('verified','approved')` in a
 * test passes whatever the production query later becomes
 * (`.rules/testing.md`). The values are compile-time constants from this
 * module, never user input.
 */
export const ACTIVE_ACCOUNT_STATUS_SQL_LIST = `(${ACTIVE_ACCOUNT_STATUSES.map(
  (status) => `'${status}'`,
).join(", ")})`;

/** True when an account at this status may authenticate. A type predicate,
 *  so a caller that has checked it holds an `ActiveAccountStatus` without a
 *  cast. */
export function isActiveAccountStatus(
  status: string | null | undefined,
): status is ActiveAccountStatus {
  return (ACTIVE_ACCOUNT_STATUSES as readonly string[]).includes(status ?? "");
}

/**
 * The 403 body returned when a credential resolves to a real account that is
 * not active.
 *
 * `error` is the stable machine-readable half and deliberately keeps its
 * pre-ADR-0040 wording (same reasoning as SERVICE_ACCESS_ERROR in
 * upload-gate.ts): clients pattern-match on it, and no client can tell a
 * renamed string from a new failure. `message` is the human half, and it is
 * what changed: `verified` is no longer a waiting room, so the only account
 * that gets told to wait for an admin is one that has not verified its email —
 * and what it is told to do is verify the email, not wait.
 */
export function inactiveAccountBody(status: string): {
  error: string;
  status: string;
  message: string;
} {
  return {
    error: "Account not approved",
    status,
    message:
      status === "pending"
        ? "Verify your email address to activate your account. Check your inbox for the verification link, or run 'nemar auth resend-verification' to get a new one."
        : status === "revoked"
          ? "Your account access has been revoked"
          : "Your account is not active",
  };
}

/**
 * The three tiers ADR 0040 names, in the words the copy uses (`tier.unverified`, `tier.base`,
 * `tier.upload` in `shared/contract/account-copy.ts`) and the website derives (`deriveAccountTier`):
 * `pending` is unverified; an active account is at the upload tier when an admin granted upload
 * access (`users.service_access`, which approval alone writes) and at the base tier otherwise.
 */
export type AccountTier = "unverified" | "base" | "upload";

/**
 * Which tier an account holds, or null for one that holds none (`revoked`, or a status this module
 * does not know). Keyed on the status and the grant together, as the website's derivation is, so an
 * account that is no longer active never reads as `upload` whatever its grant says.
 */
export function accountTier(status: string, serviceAccess: boolean): AccountTier | null {
  if (status === "pending") return "unverified";
  if (!isActiveAccountStatus(status)) return null;
  return serviceAccess ? "upload" : "base";
}
