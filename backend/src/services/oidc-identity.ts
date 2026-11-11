/**
 * Who may sign in to an OpenID Connect client (epic #2014 phase #2017; ADR 0119 rule 7), stated once.
 *
 * A client is registered with one of two rules:
 *
 *   `active_account`        the account is active (status `verified` or `approved`, ADR 0040) and
 *                           not deleted. A revoked account is not active.
 *   `person_proven_orcid`   `active_account`, AND the account's kind is `person` (ADR 0048), AND its
 *                           ORCID iD was proven by signing in with ORCID.
 *
 * "PROVEN" IS {@link ORCID_PROVEN_SQL} AND NOTHING ELSE: an `oauth_identities` row for the ORCID
 * provider whose iD is the account's `users.orcid`. NOT `users.orcid_verified`: an owner can set that
 * flag on an iD the person never signed in with (ADR 0106), and an iD filled in from a publication
 * record has neither. That is exactly the difference the rule exists for.
 *
 * The rule is applied in two places that must agree, and both read this module: the authorization
 * routes ask {@link signInRuleRefusal} of a row read with {@link ORCID_PROVEN_SQL} so the person is
 * told why, and every statement that mints (a code here; tokens in the token phase, #2018) re-applies
 * {@link SIGN_IN_RULE_SQL} in its own WHERE clause, so a change between the read and the write mints
 * nothing. The token and revocation phases (#2018, #2019) re-check the same rule at every use.
 */

import type { OidcRuleRefusalReason } from "../../../shared/contract/oidc-authorize.js";
import type { OidcSignInRule } from "../../../shared/oidc.js";
import { ACTIVE_ACCOUNT_STATUS_SQL_LIST, isActiveAccountStatus } from "./account-tier";

/**
 * True when the account aliased `u` (a `users` row) holds an ORCID iD it proved by signing in with
 * ORCID: an `oauth_identities` row for the ORCID provider whose iD is `u.orcid`. A NULL `u.orcid`
 * matches nothing, so an account with no iD is never proven.
 */
export const ORCID_PROVEN_SQL = `EXISTS (SELECT 1 FROM oauth_identities oi
   WHERE oi.user_id = u.id
     AND oi.provider = 'orcid'
     AND oi.provider_subject = u.orcid)`;

/** True when the account aliased `u` is active and not deleted: the `active_account` rule. */
export const ACCOUNT_ACTIVE_SQL = `(u.status IN ${ACTIVE_ACCOUNT_STATUS_SQL_LIST} AND u.deleted_at IS NULL)`;

/**
 * The whole sign-in rule of the client aliased `c` for the account aliased `u`, as one predicate for
 * a statement that mints. The rule names are the closed set of `oidc_clients.sign_in_rule` (migration
 * 0121's CHECK); an unknown one matches neither branch and so admits nobody.
 */
export const SIGN_IN_RULE_SQL = `(${ACCOUNT_ACTIVE_SQL}
    AND (c.sign_in_rule = 'active_account'
      OR (c.sign_in_rule = 'person_proven_orcid' AND u.account_kind = 'person' AND ${ORCID_PROVEN_SQL})))`;

/** What the rule needs to know about an account, as read with {@link ORCID_PROVEN_SQL}. */
export interface SignInSubject {
  status: string;
  /** `users.deleted_at`, or null for an account that is not deleted. */
  deleted_at: string | null;
  account_kind: string;
  /** 1 when {@link ORCID_PROVEN_SQL} held for the account, else 0. */
  orcid_proven: number;
}

/**
 * Why `rule` refuses this account, or null when it may sign in. The reasons are checked in the order
 * a person can do something about them least to most: an inactive account first, then the account's
 * kind, then the proof of its ORCID iD.
 */
export function signInRuleRefusal(
  rule: OidcSignInRule,
  subject: SignInSubject,
): OidcRuleRefusalReason | null {
  if (!isActiveAccountStatus(subject.status) || subject.deleted_at !== null) {
    return "account_inactive";
  }
  if (rule === "active_account") return null;
  if (subject.account_kind !== "person") return "account_not_person";
  if (subject.orcid_proven !== 1) return "orcid_not_proven";
  return null;
}
