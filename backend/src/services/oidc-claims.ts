/**
 * The claims a token's scopes give a client (epic #2014 phase #2018; ADR 0119 rule 6), stated once
 * for the two places that serve them: the identity token the token endpoint signs, and
 * `/oauth/userinfo`. Both read the account at the moment of the call ({@link ACCOUNT_CLAIM_COLUMNS})
 * and hand the row here; nothing is ever read from a token row about the account.
 *
 *   openid          `sub`, the account's stored subject (`users.oidc_subject`, ADR 0119 rule 5)
 *   profile         `name`, `given_name`, `family_name`; a part the account has not filled in is
 *                   left out, never sent as null or as an empty string
 *   email           `email`, `email_verified`
 *   orcid           `orcid` as `https://orcid.org/<iD>`, and `orcid_verified`, TRUE ONLY when the iD
 *                   was proven by an ORCID sign-in ({@link ORCID_PROVEN_SQL}): an iD an owner attested
 *                   (ADR 0106) gives false. An account with no iD gets neither claim.
 *   nemar.account   `nemar_kind` (`person`, `service` or `test`, ADR 0048), `nemar_status` (the
 *                   account's status, ADR 0040) and `nemar_tier` (`base` or `upload`,
 *                   `accountTier`)
 *
 * Any other scope adds no claim: `offline_access` is a grant, and the compute scopes are read through
 * the API with the access token, never from a token (ADR 0119 rule 6).
 */

import { accountTier } from "./account-tier.js";
import { ORCID_PROVEN_SQL } from "./oidc-identity.js";
import { isValidOrcidId } from "./orcid-auth.js";

/**
 * The columns of the account aliased `u` that the claims are made from. `orcid_proven` is the sign-in
 * rule's own proof, so a claim and the rule can never disagree about what "proven" means.
 */
export const ACCOUNT_CLAIM_COLUMNS = `u.oidc_subject, u.given_name, u.family_name, u.email,
       u.email_verified, u.orcid, ${ORCID_PROVEN_SQL} AS orcid_proven, u.account_kind, u.status,
       u.service_access`;

/** One account as {@link ACCOUNT_CLAIM_COLUMNS} reads it. */
export interface ClaimAccount {
  oidc_subject: string;
  given_name: string | null;
  family_name: string | null;
  email: string;
  email_verified: number;
  orcid: string | null;
  orcid_proven: number;
  account_kind: string;
  status: string;
  service_access: number;
}

/** A name part, trimmed, or null when there is nothing to send. */
function part(value: string | null): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

/** The claims `scopes` give for `account`, `sub` always first. */
export function claimsForScopes(
  scopes: readonly string[],
  account: ClaimAccount,
): Record<string, unknown> {
  const has = new Set(scopes);
  const claims: Record<string, unknown> = { sub: account.oidc_subject };
  if (has.has("profile")) {
    const given = part(account.given_name);
    const family = part(account.family_name);
    const name = [given, family].filter((p) => p !== null).join(" ");
    if (name !== "") claims.name = name;
    if (given !== null) claims.given_name = given;
    if (family !== null) claims.family_name = family;
  }
  if (has.has("email")) {
    claims.email = account.email;
    claims.email_verified = account.email_verified === 1;
  }
  if (has.has("orcid") && isValidOrcidId(account.orcid)) {
    claims.orcid = `https://orcid.org/${account.orcid}`;
    claims.orcid_verified = account.orcid_proven === 1;
  }
  if (has.has("nemar.account")) {
    claims.nemar_kind = account.account_kind;
    claims.nemar_status = account.status;
    const tier = accountTier(account.status, account.service_access === 1);
    if (tier !== null) claims.nemar_tier = tier;
  }
  return claims;
}
