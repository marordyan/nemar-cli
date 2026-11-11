/**
 * `nemar admin oidc`: NEMAR as an OpenID Connect provider (epic #2014 phase #2016; ADR 0119). Owner
 * role.
 *
 *   nemar admin oidc clients add            register a client; its secret is printed once
 *   nemar admin oidc clients list           every client
 *   nemar admin oidc clients show <id>      one client in full
 *   nemar admin oidc clients rotate-secret  a new secret; the old one stays valid for a grace
 *   nemar admin oidc clients disable        cut a client off
 *   nemar admin oidc keys list              the signing keys and their states
 *   nemar admin oidc keys rotate            make the first keys, or rotate them
 *   nemar admin oidc keys revoke <kid>      withdraw a retired key from the key set
 *   nemar admin oidc end-account <user-id>  end an account's grants at every client (manual merge, incident)
 *   nemar admin oidc logout-deliveries      the back-channel logouts owed to clients, and what became of each
 *
 * A secret is printed on `add` and on `rotate-secret` and nowhere else, and no command prints a
 * hash or a private key, because the Worker returns none. Every command takes `--json`: standard
 * output is then the Worker's answer and nothing else, and every sentence goes to standard error.
 * Every string that came from the network is made plain before it is printed.
 *
 * The routes exist only on a Worker whose provider is on (`OIDC_SECRET`) and only on the issuer's
 * own host, so a 404 here is said plainly (`hintsFor`), and not as "this backend does not support
 * this command yet". The numbers and lists the help and the messages state (the grace, the 24 hours,
 * the scope catalog) are interpolated from `shared/oidc.ts`, where they are declared once.
 */

import chalk from "chalk";
import { Command, InvalidArgumentError, Option } from "commander";
import type {
  OidcClientView,
  OidcKeyView,
  OidcLogoutDeliveryView,
} from "../../shared/contract/oidc-admin.js";
import {
  OIDC_ACCOUNT_END_NAMES,
  OIDC_CONSENT_MODES,
  OIDC_FORCE_MIN_NEXT_AGE_MINUTES,
  OIDC_GRANTS,
  OIDC_KEY_MIN_NEXT_AGE_HOURS,
  OIDC_LOGOUT_MAX_ATTEMPTS,
  OIDC_LOGOUT_RETRY_DELAYS_SECONDS,
  OIDC_LOGOUT_STATUSES,
  OIDC_MAX_REDIRECT_URIS,
  OIDC_PUBLIC_DOCUMENT_MAX_AGE_SECONDS,
  OIDC_RETIRED_KEY_PUBLISH_DAYS,
  OIDC_RETIRED_KEY_PUBLISH_MAX,
  OIDC_SCOPES,
  OIDC_SCOPE_NAMES,
  OIDC_SECRET_GRACE_HOURS_DEFAULT,
  OIDC_SECRET_GRACE_HOURS_MAX,
  OIDC_SECRET_MIN_LENGTH,
  OIDC_SECRET_PREFIX,
  OIDC_SIGN_IN_RULES,
  type OidcAccountEndReason,
  type OidcConsentMode,
  type OidcSignInRule,
} from "../../shared/oidc.js";
import { failMessage, failWith, requireSignedIn, say } from "../lib/admin-command.js";
import { isRouteNotFound } from "../lib/api/errors.js";
import {
  createOidcClient,
  disableOidcClient,
  endOidcAccount,
  getOidcClient,
  listOidcClients,
  listOidcKeys,
  listOidcLogoutDeliveries,
  oidcErrorCode,
  oidcSecretWord,
  revokeOidcKey,
  rotateOidcClientSecret,
  rotateOidcKeys,
} from "../lib/api/oidc.js";
import { confirm } from "../lib/confirm.js";
import { clip, plain } from "../lib/terminal-text.js";

/** Whole minutes of a cache lifetime in seconds, as the help says it ("5 minutes"). */
const CACHE_MINUTES = OIDC_PUBLIC_DOCUMENT_MAX_AGE_SECONDS / 60;

/** The scopes only a machine may hold, for the help. */
const MACHINE_SCOPES = OIDC_SCOPES.filter((s) => s.machineOnly).map((s) => s.name);

// ---------------------------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------------------------

/** What to tell the owner for a status, in place of the generic hint. */
function hintsFor(error: unknown, afterNetworkError?: string): Record<number, string> {
  const hints: Record<number, string> = {
    403: "These commands are for the owner role only.",
  };
  if (isRouteNotFound(error)) {
    hints[404] =
      "The server does not serve this route: the OpenID Connect provider is off there (no OIDC_SECRET), or the API URL is not the issuer's own host, or the server is older than this command.";
    const word = oidcSecretWord(error);
    if (word === "unset") {
      hints[404] = "The OpenID Connect provider is off on this server: OIDC_SECRET is unset.";
    } else if (word === "malformed") {
      hints[404] = `The OpenID Connect provider is off on this server: OIDC_SECRET is set but is not in the ${OIDC_SECRET_PREFIX} form (${OIDC_SECRET_PREFIX} and at least ${OIDC_SECRET_MIN_LENGTH} characters in all).`;
    }
  }
  // A refusal of a rotation says what to do about it; 409 is the status of all of them.
  const code = oidcErrorCode(error);
  if (code === "user_not_found") hints[404] = "There is no account with that id.";
  if (code === "rotation_next_too_new") {
    hints[409] =
      "In an emergency, `nemar admin oidc keys rotate --force --emergency` overrides this; the audit trail records it.";
  } else if (code === "key_unreadable") {
    hints[409] =
      "Check that the Worker's OIDC_SECRET is the one the keys were made under; nothing was changed.";
  }
  // Status 0 is a network failure: the request may or may not have reached the server.
  if (afterNetworkError) hints[0] = afterNetworkError;
  return hints;
}

/**
 * Sign-in check, then the call; a failure is reported once (exit 1) and the result is null.
 * `afterNetworkError` is what to say when the request failed on the network: for a write, to look
 * before trying again, because the request may have been carried out.
 */
async function run<T>(
  json: boolean,
  what: string,
  call: () => Promise<T>,
  afterNetworkError?: string,
): Promise<T | null> {
  if (!requireSignedIn(json)) return null;
  try {
    return await call();
  } catch (err) {
    failWith(err, null, `Could not ${what}.`, hintsFor(err, afterNetworkError), { json });
    return null;
  }
}

const printJson = (value: unknown): void => console.log(JSON.stringify(value, null, 2));

/** A comma-separated list, trimmed, with empty items dropped. */
function list(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function wholeNumber(max: number | undefined) {
  return (value: string): number => {
    const n = Number(value);
    if (value.trim() === "" || !Number.isInteger(n) || n < 0 || (max !== undefined && n > max)) {
      throw new InvalidArgumentError(
        max === undefined
          ? "a whole number, zero or more, is required."
          : `a whole number from 0 to ${max} is required.`,
      );
    }
    return n;
  };
}

const yesNo = (b: boolean): string => (b ? "yes" : "no");
const utc = (s: string | null): string => (s ? `${plain(s)} UTC` : "never");

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

/** A table: the header in bold, then one line per row, each column as wide as its widest cell. */
function renderTable(head: string[], rows: string[][]): string[] {
  const widths = head.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] as string).length)),
  );
  const fmt = (cells: string[]) =>
    cells
      .map((cell, i) => cell.padEnd(widths[i] as number))
      .join("  ")
      .trimEnd();
  return [chalk.bold(fmt(head)), ...rows.map(fmt)];
}

function clientLines(c: OidcClientView): string[] {
  const caps =
    c.cap_open_reservations === null && c.cap_su_per_day === null
      ? "none"
      : `open reservations ${c.cap_open_reservations ?? "none"}, service units per day ${c.cap_su_per_day ?? "none"}`;
  return [
    `${chalk.bold(plain(c.client_id))}  ${plain(c.name)}`,
    `  Status:            ${plain(c.status)}${c.disabled_at ? ` (since ${utc(c.disabled_at)})` : ""}`,
    `  First-party:       ${yesNo(c.first_party)}${c.first_party ? " (skips the consent screen)" : ""}`,
    `  Sign-in rule:      ${plain(c.sign_in_rule)}`,
    `  Consent:           ${plain(c.consent_mode)}`,
    `  Audience:          ${plain(c.audience)}`,
    `  Redirect URIs:     ${c.redirect_uris.map(plain).join("\n                     ")}`,
    `  Scopes:            ${c.allowed_scopes.map(plain).join(", ")}`,
    `  Grants:            ${c.allowed_grants.map(plain).join(", ")}`,
    `  Logout URI:        ${c.backchannel_logout_uri ? plain(c.backchannel_logout_uri) : "none"}`,
    `  Introspection:     ${c.introspection_audiences.length ? c.introspection_audiences.map(plain).join(", ") : "none"}`,
    `  Caps:              ${caps}`,
    `  Previous secret:   ${c.previous_secret_expires_at ? `still valid until ${utc(c.previous_secret_expires_at)}` : "none"}`,
    `  Registered:        ${utc(c.created_at)} by user ${c.created_by}`,
  ];
}

function clientTable(clients: OidcClientView[]): string[] {
  return renderTable(
    ["CLIENT ID", "NAME", "STATUS", "KIND", "SIGN-IN RULE", "SCOPES"],
    clients.map((c) => [
      plain(c.client_id),
      clip(c.name, 32),
      plain(c.status),
      c.first_party ? "first-party" : "third-party",
      plain(c.sign_in_rule),
      String(c.allowed_scopes.length),
    ]),
  );
}

function deliveryTable(rows: OidcLogoutDeliveryView[]): string[] {
  return renderTable(
    ["ID", "CLIENT", "REASON", "STATUS", "TRIES", "NEXT ATTEMPT", "LAST", "CLASS", "CREATED"],
    rows.map((d) => [
      String(d.id),
      d.client_id ? plain(d.client_id) : "(gone)",
      plain(d.reason),
      plain(d.status),
      String(d.attempts),
      d.next_attempt_at ? utc(d.next_attempt_at) : "-",
      d.last_status === null ? "-" : String(d.last_status),
      d.last_error_class ? plain(d.last_error_class) : "-",
      utc(d.created_at),
    ]),
  );
}

function keyTable(keys: OidcKeyView[]): string[] {
  return renderTable(
    ["KEY ID", "STATE", "ALG", "CREATED", "PROMOTED", "RETIRED", "REVOKED"],
    keys.map((k) => [
      plain(k.kid),
      plain(k.state),
      plain(k.alg),
      utc(k.created_at),
      k.promoted_at
        ? utc(k.promoted_at)
        : k.promotable_at
          ? `may be promoted ${utc(k.promotable_at)}`
          : "-",
      k.retired_at ? utc(k.retired_at) : "-",
      k.revoked_at ? utc(k.revoked_at) : "-",
    ]),
  );
}

// ---------------------------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------------------------

const ADD_HELP = `
Registers an OpenID Connect client (owner only). The client's secret is printed once, here, and
cannot be read again: store it now. Only its hash is kept. A refusal prints the Worker's reason,
which names the field and never repeats what was typed.

  --redirect-uri     Exact addresses, from one to ${OIDC_MAX_REDIRECT_URIS} (repeat the flag). https only; a loopback
                     address may use http outside production; no wildcard, no fragment, no user
                     information. Each must be written as a browser would navigate to it (lower-case,
                     with a path, no dot segments, no default port): one that is not is refused.
  --scopes           A comma-separated list from the catalog: ${OIDC_SCOPE_NAMES.join(", ")}.
                     A scope a person grants needs the authorization_code grant; ${MACHINE_SCOPES.join(", ")} is
                     for a machine and needs client_credentials; offline_access and refresh_token
                     come together.
  --grants           A comma-separated list: ${OIDC_GRANTS.join(", ")}.
  --sign-in-rule     ${OIDC_SIGN_IN_RULES.join(" or ")} (the second: an account of kind person whose ORCID
                     iD was proven by signing in with ORCID).
  --consent-mode     ${OIDC_CONSENT_MODES.join(" or ")} (default ${OIDC_CONSENT_MODES[0]}): how often a third-party client is asked.
  --first-party      Skips the consent screen. Allowed only when EVERY redirect address is an https
                     address on nemar.org or one of its subdomains (a loopback address or a website
                     preview only outside production). A client with a partner-host redirect, or any
                     other, is refused as first-party: register it without --first-party and it is a
                     third-party client, which never skips the consent screen and follows its
                     --consent-mode.

Examples:
  nemar admin oidc clients add --name "Compute portal" --redirect-uri https://portal.example.org/cb \\
    --scopes openid,profile,orcid --grants authorization_code --sign-in-rule person_proven_orcid \\
    --audience https://api.nemar.org

Exit codes:
  0  registered; the secret was printed.
  1  not signed in, not the owner, a missing or malformed flag, a refusal of the registry (nothing
     was registered; a name already used by an active client is one), a network failure (the request
     may have been carried out: run \`clients list\` before adding again), or a server on which the
     provider is off.`;

const LIST_HELP = `
Lists every registered client: its id, name, status, whether it is first-party, its sign-in rule and
how many scopes it may ask for. No secret, no hash. Use \`show\` for one client in full.

Exit codes:
  0  listed (an empty registry is not a failure).
  1  not signed in, not the owner, or a server on which the provider is off.`;

const SHOW_HELP = `
Shows one client in full: redirect addresses, scopes, grants, caps, and whether a previous secret is
still valid after a rotation. No secret, no hash.

Exit codes:
  0  shown.
  1  not signed in, not the owner, no such client, or a server on which the provider is off.`;

const ROTATE_SECRET_HELP = `
Makes a new secret for the client and prints it once; store it now. The old secret stays valid for
--grace-hours (default ${OIDC_SECRET_GRACE_HOURS_DEFAULT}, at most ${OIDC_SECRET_GRACE_HOURS_MAX}; 0 ends it at once), so a client that has
not been given the new one keeps working. A second rotation inside the grace ends the first secret.
A disabled client's secret cannot be rotated.

Exit codes:
  0  rotated; the new secret was printed.
  1  not signed in, not the owner, no such client, a disabled client, a grace out of range, a
     network failure (the secret may have been rotated: run \`clients show\`), or a server on which
     the provider is off.`;

const DISABLE_HELP = `
Cuts a client off: it can no longer authenticate, and in the same step everything it holds is revoked:
every token it was issued, every grant a person made to it and every unused authorization code. It is
NOT told (no back-channel logout is sent): the owner cut it off, and telling it is not owed. There is no
command to enable it again, so it asks first (--yes answers). Disabling a client that is already disabled
revokes whatever it may still hold, and says how many.

Exit codes:
  0  disabled, or it already was (the answer says which, and how many tokens, grants and codes went).
  1  not signed in, not the owner, no such client, the question was not answered yes (nothing was
     changed), or a server on which the provider is off.`;

const KEYS_LIST_HELP = `
Lists the signing keys: current (signs), next (published, not yet signing), retired (still
published for ${OIDC_RETIRED_KEY_PUBLISH_DAYS} days, at most ${OIDC_RETIRED_KEY_PUBLISH_MAX} of them) and revoked (withdrawn, never published). A next key
shows when it may become current without --force. The private half is never returned.

Exit codes:
  0  listed (no keys yet is not a failure).
  1  not signed in, not the owner, or a server on which the provider is off.`;

const KEYS_ROTATE_HELP = `
With no keys yet, makes the first current key and a next key. After that, the next key becomes
current, the current key is retired (still published for ${OIDC_RETIRED_KEY_PUBLISH_DAYS} days, at most ${OIDC_RETIRED_KEY_PUBLISH_MAX} retired keys, so a
token signed just before the rotation verifies), and a new next key is made. The next key becomes
current only when it is ${OIDC_KEY_MIN_NEXT_AGE_HOURS} hours old, so a client has time to fetch it.

--force skips that wait, but refuses while the next key is under ${OIDC_FORCE_MIN_NEXT_AGE_MINUTES} minutes old: a client whose
cached key set predates the key can fail verification of tokens signed with it for up to about
${CACHE_MINUTES} minutes (the key set is cached that long). --force --emergency overrides that floor; the audit
trail records it.

Before it promotes a key, the Worker proves it can decrypt it. A key that was encrypted under a
different OIDC_SECRET is refused and nothing changes: set OIDC_SECRET before the first rotation, and
do not change it afterwards (every stored key becomes unreadable).

OIDC_SECRET is valid only as \`${OIDC_SECRET_PREFIX}\` followed by random characters, ${OIDC_SECRET_MIN_LENGTH} or more in all:
\`${OIDC_SECRET_PREFIX}\` and the output of \`openssl rand -hex 32\`. Dev and production use different values. A Worker
whose value is absent or in another form answers these commands as the provider being off, and the
command says "unset" or "malformed" (never the value).

Exit codes:
  0  rotated, or the first keys were made.
  1  not signed in, not the owner, the next key is not ${OIDC_KEY_MIN_NEXT_AGE_HOURS} hours old yet (nothing changed; --force
     rotates now), --force on a key under ${OIDC_FORCE_MIN_NEXT_AGE_MINUTES} minutes old without --emergency, a key that cannot be
     decrypted under OIDC_SECRET, another rotation won the race (read the keys again), a network
     failure (run \`keys list\` before rotating again), or a server on which the provider is off.`;

const KEYS_REVOKE_HELP = `
Withdraws a RETIRED key from the key set at once, for a key whose private half is thought to have
leaked: tokens it signed stop verifying wherever the key set is read again (clients cache it for up
to ${CACHE_MINUTES} minutes). The key that signs and the next key cannot be revoked: rotate first, then revoke the
key once it is retired. It asks first (--yes answers); the CLI cannot undo it. Revoking a revoked key
changes nothing.

Exit codes:
  0  revoked, or it already was (the answer says which).
  1  not signed in, not the owner, not a key id, no such key, a key that is current or next (rotate
     first), the question was not answered yes (nothing was changed), or a server on which the
     provider is off.`;

/**
 * The question `end-account` asks before it ends anything. A first-party client skips the consent screen,
 * so it is not true that "the person is asked again" at every client: only a third-party client asks.
 */
export function endAccountQuestion(userId: number): string {
  return `End every OpenID Connect grant of account ${userId}? Its tokens are revoked at once, each client with a logout address is told, and a third-party client asks the person for consent again at their next sign-in (a first-party client does not ask). The CLI cannot undo it.`;
}

const END_ACCOUNT_HELP = `
Ends every OpenID Connect grant an account holds, at every client, in one step (owner only): the
account's access and refresh tokens are revoked, its grants are ended (a later sign-in is a new grant:
a third-party client asks the person for consent again, a first-party client does not ask), its unused
authorization codes are deleted, and each client that registered a back-channel logout address is queued
to be told. Nothing else of the account changes: it is not revoked, its keys and sessions stay. It is the
manual-merge step of ADR 0043 (end the loser of a merge with --reason merged; the winner's grants are
untouched) and the incident tool.

Ending the grants does not stop the account signing in again, because its app sessions and keys survive,
so it can get a new first-party grant at once. For the loser of a merge, run this command and then revoke
or delete that account: revoking and deleting end every grant the account holds and leave it unable to sign
in, and running this command first is what makes the revoked tokens and the queued logouts record the merge
and not the revocation. Changing the account's kind away from person is no substitute: it ends only the
grants of the clients that sign people in by person_proven_orcid, and a non-person account still meets the
active_account rule, so it keeps its other grants and can sign in again. Used alone, this command is for an
incident that is about the grants and not the account.

  --reason   ${OIDC_ACCOUNT_END_NAMES.join(" or ")}: the word recorded on the revoked tokens and the queued logouts
             (account_merged or account_revoked).

The call to each client is made after the step commits, from the server, and is retried on a schedule
(${OIDC_LOGOUT_RETRY_DELAYS_SECONDS.length} times, from 1 minute to 12 hours): what became of each is in \`logout-deliveries\`. It
asks first (--yes answers); ending is idempotent, so running it again finds nothing live.

Exit codes:
  0  ended (the answer counts the logouts queued, tokens and grants ended and codes deleted; zero
     everywhere means the account held nothing).
  1  not signed in, not the owner, not an account id, no such account, a missing or unknown --reason,
     the question was not answered yes (nothing was changed), a network failure (the step may have been
     carried out: it is safe to run again), or a server on which the provider is off.`;

const LOGOUT_DELIVERIES_HELP = `
Lists the back-channel logouts owed to clients, newest first: one row for each client told about each
ending, with why (the reason word), its status, how many attempts were made, when the next is due, the
last answer's HTTP status and a fixed word for what went wrong. No token, no address, no text of any
partner's answer. The counts of every status are printed whatever --status says.

  pending  to be attempted or retried (the retry tick runs every 30 minutes, so a short wait is taken up
           at the next half hour)
  sent     the client answered 200 or 204
  failed   not to be tried again: the client answered with a redirect, a 4xx other than 408 and 429, or
           any answer that is not a 200, a 204, a 408, a 429 or a 5xx; or all ${OIDC_LOGOUT_MAX_ATTEMPTS} attempts were used on
           answers that are retried (a 5xx, a 408, a 429, no answer in time, a connection that failed, a
           token NEMAR could not sign); or it was never sent because its client was disabled or its
           address is no longer one NEMAR sends to
  fenced   outside production, an address that is neither loopback nor listed: recorded and never sent

Exit codes:
  0  listed (an empty list is not a failure).
  1  not signed in, not the owner, a --status or --limit the server refuses, or a server on which the
     provider is off.`;

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

export const oidcCommand = new Command("oidc").description(
  "Register OpenID Connect clients and manage NEMAR's signing keys (owner only; ADR 0119)",
);

const clientsCommand = new Command("clients").description(
  "Register and manage OpenID Connect clients",
);
const keysCommand = new Command("keys").description("List, rotate and revoke the signing keys");

interface AddOptions {
  name: string;
  redirectUri: string[];
  scopes: string;
  grants: string;
  signInRule: OidcSignInRule;
  consentMode?: OidcConsentMode;
  firstParty?: boolean;
  logoutUri?: string;
  audience: string;
  introspectionAudiences?: string;
  capOpenReservations?: number;
  capSuPerDay?: number;
  json?: boolean;
}

clientsCommand
  .command("add")
  .description("Register a client; its secret is printed once")
  .requiredOption("--name <name>", "What the consent screen and the listing call the client")
  .option(
    "--redirect-uri <uri>",
    `An exact redirect address (repeat for up to ${OIDC_MAX_REDIRECT_URIS})`,
    collect,
    [],
  )
  .requiredOption("--scopes <list>", "Comma-separated scopes the client may ask for")
  .requiredOption("--grants <list>", "Comma-separated grants the client may use")
  .addOption(
    new Option("--sign-in-rule <rule>", "Who may sign in to the client")
      .choices([...OIDC_SIGN_IN_RULES])
      .makeOptionMandatory(),
  )
  .addOption(
    new Option("--consent-mode <mode>", "Ask once per set of scopes, or every time").choices([
      ...OIDC_CONSENT_MODES,
    ]),
  )
  .option(
    "--first-party",
    "Skip the consent screen (every redirect must be https on nemar.org or a subdomain)",
  )
  .option("--logout-uri <uri>", "The https address NEMAR tells when an account is cut off")
  .requiredOption("--audience <audience>", "The resource the client's access tokens are bound to")
  .option(
    "--introspection-audiences <list>",
    "Comma-separated audiences whose servers may introspect",
  )
  .option("--cap-open-reservations <n>", "Cap on open reservations", wholeNumber(undefined))
  .option("--cap-su-per-day <n>", "Cap on service units reserved per day", wholeNumber(undefined))
  .option("--json", "Print the answer as JSON (the secret included)")
  .addHelpText("after", ADD_HELP)
  .action(async (options: AddOptions) => {
    const json = options.json === true;
    if (options.redirectUri.length === 0) {
      failMessage("Give at least one --redirect-uri.", { json, answered: true });
      return;
    }
    const result = await run(
      json,
      "register the client",
      () =>
        createOidcClient({
          name: options.name,
          redirect_uris: options.redirectUri,
          allowed_scopes: list(options.scopes),
          allowed_grants: list(options.grants),
          sign_in_rule: options.signInRule,
          audience: options.audience,
          ...(options.firstParty ? { first_party: true } : {}),
          ...(options.consentMode ? { consent_mode: options.consentMode } : {}),
          ...(options.logoutUri ? { backchannel_logout_uri: options.logoutUri } : {}),
          ...(options.introspectionAudiences
            ? { introspection_audiences: list(options.introspectionAudiences) }
            : {}),
          ...(options.capOpenReservations !== undefined
            ? { cap_open_reservations: options.capOpenReservations }
            : {}),
          ...(options.capSuPerDay !== undefined ? { cap_su_per_day: options.capSuPerDay } : {}),
        }),
      "The request may have been carried out before it failed. Run `nemar admin oidc clients list` before adding again: a second add registers a second client, and its secret is the only one anybody sees.",
    );
    if (!result) return;
    if (json) {
      printJson(result);
      return;
    }
    const out = say(false);
    out(`Registered ${plain(result.client.client_id)} (${plain(result.client.name)}).`);
    out("");
    out(`Client secret (shown once, store it now): ${plain(result.client_secret)}`);
    out(
      chalk.dim("It cannot be read again; only its hash is kept. Rotate it with `rotate-secret`."),
    );
  });

clientsCommand
  .command("list")
  .description("List every client")
  .option("--json", "Print the list as JSON")
  .addHelpText("after", LIST_HELP)
  .action(async (options: { json?: boolean }) => {
    const json = options.json === true;
    const result = await run(json, "list the clients", listOidcClients);
    if (!result) return;
    if (json) {
      printJson(result);
      return;
    }
    if (result.clients.length === 0) {
      console.log("No clients are registered.");
      return;
    }
    for (const line of clientTable(result.clients)) console.log(line);
  });

clientsCommand
  .command("show <client_id>")
  .description("Show one client in full")
  .option("--json", "Print the client as JSON")
  .addHelpText("after", SHOW_HELP)
  .action(async (clientId: string, options: { json?: boolean }) => {
    const json = options.json === true;
    const result = await run(json, "show the client", () => getOidcClient(clientId));
    if (!result) return;
    if (json) {
      printJson(result);
      return;
    }
    for (const line of clientLines(result.client)) console.log(line);
  });

clientsCommand
  .command("rotate-secret <client_id>")
  .description("Make a new secret; the old one stays valid for a grace")
  .option(
    "--grace-hours <n>",
    `Hours the old secret stays valid (default ${OIDC_SECRET_GRACE_HOURS_DEFAULT}, 0 to ${OIDC_SECRET_GRACE_HOURS_MAX})`,
    wholeNumber(OIDC_SECRET_GRACE_HOURS_MAX),
  )
  .option("--json", "Print the answer as JSON (the secret included)")
  .addHelpText("after", ROTATE_SECRET_HELP)
  .action(async (clientId: string, options: { graceHours?: number; json?: boolean }) => {
    const json = options.json === true;
    const result = await run(
      json,
      "rotate the secret",
      () => rotateOidcClientSecret(clientId, options.graceHours),
      "The request may have been carried out before it failed. Run `nemar admin oidc clients show <client_id>` to see whether a previous secret is now in its grace; rotating again makes yet another secret.",
    );
    if (!result) return;
    if (json) {
      printJson(result);
      return;
    }
    const out = say(false);
    out(`Rotated the secret of ${plain(result.client.client_id)} (${plain(result.client.name)}).`);
    out("");
    out(`New client secret (shown once, store it now): ${plain(result.client_secret)}`);
    out(
      result.grace_hours > 0
        ? `The old secret stays valid for ${result.grace_hours} ${result.grace_hours === 1 ? "hour" : "hours"}${result.client.previous_secret_expires_at ? `, until ${utc(result.client.previous_secret_expires_at)}` : ""}.`
        : "The old secret is no longer valid.",
    );
  });

clientsCommand
  .command("disable <client_id>")
  .description("Cut a client off (it cannot be enabled again from the CLI)")
  .option("-y, --yes", "Do not ask first")
  .option("--json", "Print the answer as JSON")
  .addHelpText("after", DISABLE_HELP)
  .action(async (clientId: string, options: { yes?: boolean; json?: boolean }) => {
    const json = options.json === true;
    if (!requireSignedIn(json)) return;
    const answer = await confirm(
      `Disable ${clientId}? It can no longer authenticate, and the CLI cannot enable it again.`,
      { yes: options.yes },
    );
    if (answer !== "confirmed") {
      failMessage("Not disabled: the question was not answered yes (use --yes).", {
        json,
        answered: true,
      });
      return;
    }
    const result = await run(json, "disable the client", () => disableOidcClient(clientId));
    if (!result) return;
    if (json) {
      printJson(result);
      return;
    }
    const out = say(false);
    out(
      result.changed
        ? `Disabled ${plain(result.client.client_id)} (${plain(result.client.name)}).`
        : `${plain(result.client.client_id)} was already disabled; its status is unchanged.`,
    );
    if (result.revoked) {
      const { tokens, grants, codes } = result.revoked;
      out(
        `Revoked ${tokens} ${tokens === 1 ? "token" : "tokens"}, ${grants} ${grants === 1 ? "grant" : "grants"} and deleted ${codes} unused ${codes === 1 ? "code" : "codes"}. No logout was sent.`,
      );
    }
  });

keysCommand
  .command("list")
  .description("List the signing keys")
  .option("--json", "Print the keys as JSON")
  .addHelpText("after", KEYS_LIST_HELP)
  .action(async (options: { json?: boolean }) => {
    const json = options.json === true;
    const result = await run(json, "list the signing keys", listOidcKeys);
    if (!result) return;
    if (json) {
      printJson(result);
      return;
    }
    if (result.keys.length === 0) {
      console.log(
        "There are no signing keys yet. Run `nemar admin oidc keys rotate` to make them.",
      );
      return;
    }
    for (const line of keyTable(result.keys)) console.log(line);
  });

keysCommand
  .command("rotate")
  .description("Make the first signing keys, or rotate them")
  .option(
    "--force",
    `Rotate now even when the next key is under ${OIDC_KEY_MIN_NEXT_AGE_HOURS} hours old`,
  )
  .option(
    "--emergency",
    `With --force: override the floor, for a next key under ${OIDC_FORCE_MIN_NEXT_AGE_MINUTES} minutes old`,
  )
  .option("--json", "Print the answer as JSON")
  .addHelpText("after", KEYS_ROTATE_HELP)
  .action(async (options: { force?: boolean; emergency?: boolean; json?: boolean }) => {
    const json = options.json === true;
    const result = await run(
      json,
      "rotate the signing keys",
      () => rotateOidcKeys({ force: options.force, emergency: options.emergency }),
      "The request may have been carried out before it failed. Run `nemar admin oidc keys list` before rotating again.",
    );
    if (!result) return;
    if (json) {
      printJson(result);
      return;
    }
    const out = say(false);
    const words: Record<string, string> = {
      bootstrapped: "Made the first signing keys: a current key and a next key.",
      rotated: `Rotated: the next key is now current, the old current key is retired (still published for ${OIDC_RETIRED_KEY_PUBLISH_DAYS} days), and a new next key was made.`,
      next_created: "Made a new next key; the current key is unchanged.",
    };
    out(plain(words[result.action] ?? `Done (${result.action}).`));
    for (const line of keyTable(result.keys)) console.log(line);
  });

keysCommand
  .command("revoke <kid>")
  .description("Withdraw a retired signing key from the key set")
  .option("-y, --yes", "Do not ask first")
  .option("--json", "Print the answer as JSON")
  .addHelpText("after", KEYS_REVOKE_HELP)
  .action(async (kid: string, options: { yes?: boolean; json?: boolean }) => {
    const json = options.json === true;
    if (!requireSignedIn(json)) return;
    const answer = await confirm(
      `Revoke signing key ${kid}? Tokens it signed stop verifying wherever the key set is read again (clients cache it for up to ${CACHE_MINUTES} minutes), and the CLI cannot undo it.`,
      { yes: options.yes },
    );
    if (answer !== "confirmed") {
      failMessage("Not revoked: the question was not answered yes (use --yes).", {
        json,
        answered: true,
      });
      return;
    }
    const result = await run(json, "revoke the signing key", () => revokeOidcKey(kid));
    if (!result) return;
    if (json) {
      printJson(result);
      return;
    }
    say(false)(
      result.changed
        ? `Revoked signing key ${plain(result.key.kid)}; it is no longer published.`
        : `Signing key ${plain(result.key.kid)} was already revoked; nothing changed.`,
    );
  });

/** A positive whole number argument: an account id. */
function accountId(value: string): number {
  if (!/^[1-9][0-9]{0,15}$/.test(value)) {
    throw new InvalidArgumentError("an account id is a whole number from 1.");
  }
  return Number(value);
}

oidcCommand
  .command("end-account <user-id>")
  .description("End an account's grants at every client and tell the clients (owner only)")
  .addOption(
    new Option("--reason <reason>", "Why: the word recorded on the tokens and the logouts")
      .choices([...OIDC_ACCOUNT_END_NAMES])
      .makeOptionMandatory(),
  )
  .option("-y, --yes", "Do not ask first")
  .option("--json", "Print the answer as JSON")
  .addHelpText("after", END_ACCOUNT_HELP)
  .action(
    async (
      rawId: string,
      options: { reason: OidcAccountEndReason; yes?: boolean; json?: boolean },
    ) => {
      const json = options.json === true;
      let userId: number;
      try {
        userId = accountId(rawId);
      } catch {
        failMessage("An account id is a whole number from 1.", { json, answered: true });
        return;
      }
      if (!requireSignedIn(json)) return;
      const answer = await confirm(endAccountQuestion(userId), { yes: options.yes });
      if (answer !== "confirmed") {
        failMessage("Nothing was changed: the question was not answered yes (use --yes).", {
          json,
          answered: true,
        });
        return;
      }
      const result = await run(
        json,
        "end the account's grants",
        () => endOidcAccount(userId, options.reason),
        "The request may have been carried out before it failed. Ending is safe to run again: a second run finds nothing live.",
      );
      if (!result) return;
      if (json) {
        printJson(result);
        return;
      }
      const out = say(false);
      out(
        `Ended the OpenID Connect grants of account ${result.user_id} (${plain(result.reason)}).`,
      );
      out(
        `Tokens revoked ${result.tokens_ended}, grants ended ${result.grants_ended}, unused codes deleted ${result.codes_deleted}, logouts queued ${result.logouts_queued}.`,
      );
      if (result.logouts_queued > 0) {
        out(
          chalk.dim(
            "The clients are told after this step, and retried if they do not answer: see `logout-deliveries`.",
          ),
        );
      }
    },
  );

oidcCommand
  .command("logout-deliveries")
  .description("List the back-channel logouts owed to clients, and what became of each")
  .addOption(
    new Option("--status <status>", "Only deliveries in this state").choices([
      ...OIDC_LOGOUT_STATUSES,
    ]),
  )
  .option("--limit <n>", "How many to list, from 1 to 500 (default 100)", wholeNumber(500))
  .option("--json", "Print the answer as JSON")
  .addHelpText("after", LOGOUT_DELIVERIES_HELP)
  .action(async (options: { status?: string; limit?: number; json?: boolean }) => {
    const json = options.json === true;
    const result = await run(json, "list the logout deliveries", () =>
      listOidcLogoutDeliveries({ status: options.status, limit: options.limit }),
    );
    if (!result) return;
    if (json) {
      printJson(result);
      return;
    }
    const counts = OIDC_LOGOUT_STATUSES.map((s) => `${s} ${result.counts[s] ?? 0}`).join(", ");
    console.log(`All deliveries: ${counts}.`);
    if (result.deliveries.length === 0) {
      console.log(options.status ? `None is ${options.status}.` : "There are no deliveries.");
      return;
    }
    for (const line of deliveryTable(result.deliveries)) console.log(line);
  });

oidcCommand.addCommand(clientsCommand);
oidcCommand.addCommand(keysCommand);
