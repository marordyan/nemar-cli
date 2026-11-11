/**
 * Hosts under `nemar.org` that another party runs (epic #2014 phase #2015, ADR 0119, decision 9).
 *
 * Pure and import-free. The Worker and the tests read this one list; any other repository that
 * needs it transcribes it (as `shared/contract/account-copy.ts` is transcribed by the website),
 * and nothing outside this repository reads this file today.
 *
 * The API used to trust every `*.nemar.org` origin: in its cross-origin allow-list and in the
 * origin check on a write that carries the session cookie. A partner subdomain is run by someone
 * else and can serve pages whose JavaScript its visitors write, so it must not be one of ours.
 * A partner reaches NEMAR through OpenID Connect and bearer tokens, never through a cookie or a
 * cross-origin grant that only NEMAR's own pages were meant to have.
 *
 * Adding a host is a deliberate act: it takes the host (and every subdomain of it) out of both
 * checks. A client is registered by an owner command, so a partner host is added to this list and
 * released BEFORE the owner registers that partner's client.
 */

/** Lowercase hostnames, without a scheme, a port or a trailing dot. */
export const PARTNER_HOSTS: readonly string[] = ["compute.nemar.org"];

/**
 * True for a partner host or any subdomain of one.
 *
 * The `=== host || endsWith("." + host)` shape keeps suffix confusion out: `notcompute.nemar.org`
 * does not end with `.compute.nemar.org` (the character before the label is `t`, not `.`), and
 * `compute.nemar.org.evil.example` does not end with it either.
 *
 * Case is folded here and a single trailing dot is dropped, so the answer does not depend on the
 * caller having gone through `URL`, which lowercases a hostname but keeps the dot of a fully
 * qualified name. Expects the hostname alone, not a full origin.
 */
export function isPartnerHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return PARTNER_HOSTS.some((partner) => host === partner || host.endsWith(`.${partner}`));
}
