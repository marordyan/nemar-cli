/**
 * The statements of ADR 0119 that review of phase #2016 corrected or added, held where they are
 * said (the ADR, and its one-paragraph copy in the decisions index), so a later edit cannot put the
 * old claim back:
 *
 *   - a client that is not first-party NEVER SKIPS the consent screen and follows its consent mode;
 *     it is not one that "always shows" it;
 *   - first-party is its own rule (https on nemar.org, default port, no partner host, loopback and
 *     website previews only outside production), not the cross-origin one;
 *   - client secrets have a prefix, and signing keys have a revoked state;
 *   - the staging issuer is decided (each Worker's issuer is its own API_BASE_URL), so it is no
 *     longer in the not-decided list;
 *   - changing OIDC_SECRET after the first rotation is named as a consequence.
 *
 * Real files, no mocks.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { AUTO_IMPORT_CRON } from "../backend/src/services/auto-import";
import {
  OIDC_END_REASONS,
  OIDC_LOGOUT_ERROR_CLASSES,
  OIDC_LOGOUT_RETRY_AFTER_MAX_SECONDS,
  OIDC_LOGOUT_RETRY_DELAYS_SECONDS,
} from "../shared/oidc";

const DECISIONS = join(import.meta.dir, "../.context/decisions");
const ADR_FILE = readdirSync(DECISIONS).find((f) => f.startsWith("0119-")) as string;
const adr = readFileSync(join(DECISIONS, ADR_FILE), "utf-8");
const readme = readFileSync(join(DECISIONS, "README.md"), "utf-8");
const readmeLine = readme.split("\n").find((l) => l.includes("[ADR 0119]")) as string;

/** The text of one numbered rule of the Decision section, up to the next rule. */
function rule(n: number): string {
  const start = adr.indexOf(`\n${n}. **`);
  const next = adr.indexOf(`\n${n + 1}. **`, start + 1);
  const end = next === -1 ? adr.indexOf("\n### ", start) : next;
  return adr.slice(start, end);
}

describe("ADR 0119 says what a third-party client is", () => {
  test("the files exist and the helpers see the rules", () => {
    expect(ADR_FILE).toBeDefined();
    expect(readmeLine.length).toBeGreaterThan(100);
    expect(rule(8)).toContain("Clients are registered by the owner");
    expect(rule(2)).toContain("The issuer is");
  });

  test("it never skips consent and follows its consent mode; it does not 'always show' it", () => {
    const eight = rule(8);
    expect(eight).toMatch(/never skips the consent screen/);
    expect(eight).toMatch(/consent mode/);
    for (const text of [adr, readmeLine]) {
      expect(text).not.toMatch(/always shows? (the )?consent/i);
    }
    expect(readmeLine).toMatch(/never skips consent/);
  });

  test("first-party is its own rule, and the ADR names its parts", () => {
    const eight = rule(8);
    expect(eight).toMatch(/first-party origin/);
    expect(eight).toMatch(/default port/);
    expect(eight).toMatch(/loopback/);
    expect(eight).toMatch(/website preview/);
    expect(eight).toMatch(/not the cross-origin rule/);
    expect(readmeLine).toMatch(/default port/);
    // The index does not read as if "any other host" included NEMAR's own.
    expect(readmeLine).not.toMatch(/any other host makes it third-party/);
  });
});

describe("ADR 0119 records the key and secret decisions", () => {
  test("a client secret has the prefix nmo_cs_, in the ADR and in its index line", () => {
    expect(rule(4)).toContain("nmo_cs_");
    expect(readmeLine).toContain("nmo_cs_");
  });

  test("signing keys have a revoked state, and a rotation proves the key it promotes can be read", () => {
    const two = rule(2);
    expect(two).toMatch(/`revoked`/);
    expect(two).toMatch(/decrypt/);
    expect(two).toContain("OIDC_SECRET");
  });

  test("each Worker's issuer is its own API_BASE_URL, and the staging one is named", () => {
    const two = rule(2);
    expect(two).toContain("API_BASE_URL");
    expect(two).toContain("https://api-test.nemar.org");
    expect(two).toMatch(/answers 404/);
  });

  test("the staging issuer is no longer undecided, in the ADR or its index line", () => {
    const notDecided = adr.slice(
      adr.indexOf("### Not decided here"),
      adr.indexOf("## Consequences"),
    );
    expect(notDecided.length).toBeGreaterThan(100);
    expect(notDecided).not.toMatch(/staging/i);
    expect(readmeLine).not.toMatch(/the staging issuer/);
  });

  test("changing OIDC_SECRET after the first rotation is a named consequence", () => {
    const consequences = adr.slice(adr.indexOf("## Consequences"), adr.indexOf("## Alternatives"));
    expect(consequences).toContain("OIDC_SECRET");
    expect(consequences).toMatch(/every stored key unreadable/);
    expect(consequences).toMatch(/#2020/);
    // Losing the secret leaves no way back through the CLI, and the ADR says what recovery is.
    expect(consequences).toMatch(/no CLI way back/);
    expect(consequences).toContain("key_unreadable");
    expect(consequences).toMatch(
      /delete the current and next rows of `oidc_signing_keys` \(retired rows hold no private half and can stay\), then run `keys rotate`/,
    );
    expect(consequences).toMatch(/no re-encryption path exists/);
  });
});

describe("ADR 0119 records what the token phase settled (#2018)", () => {
  test("rule 13: replay, rotation, the retry, the expiries and client authentication", () => {
    const thirteen = rule(13);
    expect(thirteen).toContain("`code_replay`");
    expect(thirteen).toContain("`refresh_reuse`");
    expect(thirteen).toMatch(/one more child, never two/);
    expect(thirteen).toMatch(/30 days after it was minted/);
    expect(thirteen).toMatch(/90 days after the code was redeemed/);
    expect(thirteen).toMatch(/code's scopes, never the grant's/);
    expect(thirteen).toMatch(/HTTP Basic only/);
    expect(thirteen).toMatch(/machine-only scopes/);
    // Round 1: the retry's children are mutually exclusive, and a used code revokes only after its
    // verifier and redirect address match.
    expect(thirteen).toContain("`refresh_superseded`");
    expect(thirteen).toMatch(/mutually exclusive/);
    expect(thirteen).toMatch(/with the right verifier and redirect address/);
    expect(thirteen).not.toMatch(/both children stay live/);
    expect(thirteen).not.toMatch(/whatever verifier or redirect address/);
    expect(readmeLine).toContain("refresh_superseded");
    // Round 2: the retry needs the first child untouched, and a late retry is reuse.
    expect(thirteen).toMatch(/itself untouched, neither rotated nor revoked/);
    expect(thirteen).toMatch(/whatever the order the two holders acted in/);
    expect(thirteen).toMatch(/access tokens stay valid for up to their 15 minutes/);
  });

  test("rule 14 and the consequences: read-only maintenance, faults, the table's growth", () => {
    const fourteen = rule(14);
    expect(fourteen).toMatch(/`POST \/oauth\/userinfo` and `POST \/oauth\/introspect` are served/);
    expect(fourteen).toMatch(/never `invalid_token`, `invalid_grant` or `\{active: false\}`/);
    const consequences = adr.slice(adr.indexOf("## Consequences"), adr.indexOf("## Alternatives"));
    expect(consequences).toMatch(/In read-only maintenance no partner can refresh/);
    expect(consequences).toMatch(/What to watch once a partner is live/);
    expect(consequences).toMatch(/minimum interval between two rotations/);
    expect(consequences).toMatch(/A fault is never a verdict/);
    expect(consequences).toMatch(/The prune shares the batch that mints/);
    expect(fourteen).toMatch(/POST only/);
  });

  test("rule 14: the claim names, the refusal elsewhere and introspection's blindness", () => {
    const fourteen = rule(14);
    for (const claim of ["nemar_kind", "nemar_status", "nemar_tier"]) {
      expect(fourteen).toContain(claim);
      expect(readmeLine).toContain(claim);
    }
    expect(fourteen).toContain("oidc_token_not_accepted");
    expect(fourteen).toMatch(/`oidcBearer` is the one middleware/);
    expect(fourteen).toMatch(/shown to its own client only/);
    expect(readmeLine).toContain("oidc_token_not_accepted");
    expect(adr).toMatch(/Fifteen rules inside that/);
  });
});

describe("ADR 0119 records what the revocation phase settled (#2019)", () => {
  test("rule 12: the cascade is one function, its order, its callers, its filters and the client's disabling", () => {
    const twelve = rule(12);
    expect(twelve).toContain("`oidcEndStatements`");
    expect(twelve).toContain("`OIDC_END_CALLERS`");
    expect(twelve).toMatch(/BEFORE they are revoked/);
    expect(twelve).toMatch(/A used code stays/);
    expect(twelve).toMatch(/a later sign-in is a NEW grant/);
    expect(twelve).toMatch(/`oidc_clients.id` row, never the public `oc_` string/);
    expect(twelve).toMatch(/what it selects is GRANTS/);
    expect(twelve).toContain("`{scopePrefix}`");
    expect(twelve).toMatch(/no caller yet, because its state does not exist/);
    expect(twelve).toContain("`oidcClientEndStatements`");
    expect(twelve).toMatch(/does not revoke the account/);
    expect(readmeLine).toContain("oidcEndStatements");
    expect(readmeLine).toContain("OIDC_END_CALLERS");
    expect(readmeLine).toContain("nemar admin oidc end-account");
  });

  test("every end reason and every delivery error class the code has is named in the ADR", () => {
    for (const word of [...OIDC_END_REASONS, ...OIDC_LOGOUT_ERROR_CLASSES]) {
      expect(adr, word).toContain(`\`${word}\``);
    }
  });

  test("rule 15: the intent is a row, the call is afterwards, the token and the request are exact", () => {
    const fifteen = rule(15);
    expect(fifteen).toMatch(/never touches the network/);
    expect(fifteen).toMatch(/`waitUntil` right after the commit/);
    expect(fifteen).toMatch(/every 30 minutes, in production only/);
    expect(fifteen).toMatch(/at most 20 deliveries a tick/);
    expect(fifteen).toContain("`typ: logout+jwt`");
    expect(fifteen).toMatch(/two minutes later/);
    expect(fifteen).toMatch(/no `nonce`/);
    expect(fifteen).toMatch(/no `sid`/);
    expect(fifteen).toMatch(/new for every attempt/);
    expect(fifteen).toMatch(/no `Authorization`, no cookie, no client secret, no API key/);
    expect(fifteen).toMatch(
      /waits 5 seconds, never follows a redirect, and never reads the answer's body/,
    );
    expect(fifteen).toMatch(/`200` or `204` is `sent`/);
    expect(fifteen).toMatch(/the first attempt and five retries/);
    expect(fifteen).toMatch(/The wait is the EARLIEST time/);
    expect(fifteen).toMatch(/claimed before it is made/);
  });

  test("rule 15: the retry schedule in the ADR is the one in the code", () => {
    const words = (s: number): string =>
      s < 3600
        ? `${s / 60} minute${s === 60 ? "" : "s"}`
        : `${s / 3600} hour${s === 3600 ? "" : "s"}`;
    const delays = OIDC_LOGOUT_RETRY_DELAYS_SECONDS.map(words);
    const spelled = `${delays.slice(0, -1).join(", ")} and ${delays.at(-1)}`;
    expect(rule(15)).toContain(spelled);
  });

  test("rule 15: the fence is exact, fails closed, and the var is the owner's", () => {
    const fifteen = rule(15);
    expect(fifteen).toMatch(/checked again at send time and not only at registration/);
    expect(fifteen).toMatch(/`ENVIRONMENT` exactly `production`/);
    expect(fifteen).toMatch(/an unset or mistyped value included/);
    expect(fifteen).toContain("`OIDC_LOGOUT_DEV_HOSTS`");
    expect(fifteen).toMatch(/does not admit its subdomains/);
    expect(fifteen).toMatch(/fails closed the other way from `isNonProductionEnv`/);
    expect(fifteen).toMatch(/absent from `wrangler-sccn.toml`, is ignored in production/);
    expect(fifteen).toMatch(/does not resolve a name itself/);
    expect(readmeLine).toContain("OIDC_LOGOUT_DEV_HOSTS");
  });

  test("rule 15: throttling, unreported, the owner routes and retention are decided", () => {
    const fifteen = rule(15);
    expect(fifteen).toMatch(/A `408` or a `429` is recorded `http_throttled`/);
    expect(fifteen).toMatch(/LOWER bound for the next wait/);
    expect(fifteen).toMatch(/a number of seconds, of any length, or an HTTP date/);
    expect(fifteen).toMatch(/is never read as no header at all/);
    expect(fifteen).toMatch(/at most 12 hours/);
    expect(fifteen).toMatch(/can never add an attempt/);
    expect(fifteen).toMatch(/A `Retry-After` on any other answer is not read/);
    expect(fifteen).toMatch(/failed` with `unreported`/);
    expect(fifteen).toMatch(/would break the six-request bound/);
    expect(fifteen).toMatch(/a faster cron for the short waits is not built/);
    expect(fifteen).toMatch(/deliberately NOT `HOST_PREFIXED_SESSION_COOKIE`/);
    expect(fifteen).toMatch(/a planted cookie is the attacker's own non-owner session/);
    expect(fifteen).toMatch(/at most 500 a tick/);
    expect(fifteen).toMatch(/older than 30 days/);
    expect(fifteen).toMatch(/older than 180 days/);
    expect(fifteen).toMatch(/never a `pending` row/);
    expect(fifteen).toMatch(/DEFAULTS pending the owner/);
    expect(fifteen).toMatch(/data minimisation/);
    expect(fifteen).toMatch(/grows with the number of endings there/);
    expect(readmeLine).toContain("http_throttled");
    expect(readmeLine).toMatch(/prunes finished ones/);
  });

  test("rule 12: a new path adds to OIDC_END_CALLERS, and only the sweep is guarded", () => {
    const twelve = rule(12);
    expect(twelve).toMatch(/adds a line here and to `OIDC_END_CALLERS`/);
    expect(twelve).toMatch(/only when it also runs their statements/);
    expect(twelve).toMatch(/the owner's soft delete, which runs the statements as they stand/);
    expect(twelve).toMatch(
      /the sweep of the live tests' accounts, which runs each one conditional on the mask/,
    );
    expect(twelve).not.toMatch(
      /soft delete and the sweep of the live tests' accounts, which run it with every statement/,
    );
  });

  test("rule 12: a merge loser is ended with end-account and then a revocation or a deletion, and a kind change is no substitute", () => {
    const twelve = rule(12);
    expect(twelve).toMatch(/can get a new first-party grant at once/);
    expect(twelve).toMatch(
      /the owner runs `end-account` and then revokes or deletes that account, which end every grant it holds and leave it unable to sign in/,
    );
    expect(twelve).toMatch(
      /running `end-account` first is what makes the revoked tokens and the queued logouts record the merge and not the revocation/,
    );
    expect(twelve).toMatch(/A change of the account's kind away from `person` is no substitute/);
    expect(twelve).toMatch(
      /ends only the grants of the clients that sign people in by `person_proven_orcid`/,
    );
    expect(twelve).toMatch(/a non-person account still satisfies `active_account`/);
    expect(twelve).toMatch(/keeps its other grants and can sign in again at once/);
    // The claim this replaces, which was false for an active_account client, is in no sentence about a merge.
    expect(twelve).not.toMatch(/revocation, deletion or kind change/);
    expect(twelve).not.toMatch(/which end the grants themselves/);
  });

  test("rule 15: how long a delivery's attempts last is derived from the constants, and the ADR and the code say it", () => {
    const HOUR = 3600;
    const waits = OIDC_LOGOUT_RETRY_DELAYS_SECONDS.length;
    const TICK = 30 * 60;
    // The tick is the 30-minute cron the Worker runs, so a wait is taken up at most this much late.
    expect(AUTO_IMPORT_CRON).toBe("*/30 * * * *");
    // The cap on a partner's Retry-After IS the schedule's longest wait, so no wait is ever longer.
    expect(OIDC_LOGOUT_RETRY_AFTER_MAX_SECONDS).toBe(Math.max(...OIDC_LOGOUT_RETRY_DELAYS_SECONDS));
    // The schedule alone: its waits, each up to a tick late, and the first attempt up to a tick late if
    // the one after the commit did not run. Roughly fifteen to eighteen hours.
    const scheduleOnly =
      OIDC_LOGOUT_RETRY_DELAYS_SECONDS.reduce((a, b) => a + b, 0) + (waits + 1) * TICK;
    expect(scheduleOnly / HOUR).toBeGreaterThan(14.5);
    expect(scheduleOnly / HOUR).toBeLessThan(18);
    // A partner that asks for the longest wait every time: five waits of the cap, each up to a tick late,
    // and the same first attempt. 63 hours at the most, which is within three days and is NOT under a day.
    const throttled = (waits + 1) * TICK + waits * OIDC_LOGOUT_RETRY_AFTER_MAX_SECONDS;
    expect(throttled / HOUR).toBe(63);
    expect(throttled).toBeLessThan(3 * 24 * HOUR);
    expect(throttled).toBeGreaterThan(24 * HOUR);

    const fifteen = rule(15);
    expect(fifteen).toMatch(/a failed row's last attempt comes within three days of its creation/);
    expect(fifteen).toMatch(/63 hours at the most/);
    expect(fifteen).not.toMatch(/under a day/);
    expect(fifteen).toMatch(
      /the six attempts of the schedule alone span fifteen to eighteen hours/,
    );
    const consequences = adr.slice(adr.indexOf("## Consequences"), adr.indexOf("## Alternatives"));
    expect(consequences).toMatch(/over roughly fifteen to eighteen hours on the schedule alone/);
    expect(consequences).toMatch(
      /over 63 hours at the most when a throttling partner asks for the longest wait every time/,
    );
    // The code's own statement of it, in the retention constants' comment.
    const shared = readFileSync(join(import.meta.dir, "../shared/oidc.ts"), "utf-8");
    expect(shared).toMatch(/a failed row's last attempt comes within three days of its creation/);
    expect(shared).not.toMatch(/under a day/);
  });

  test("the consequences and the not-decided list say what a logout cannot promise", () => {
    const consequences = adr.slice(adr.indexOf("## Consequences"), adr.indexOf("## Alternatives"));
    expect(consequences).toMatch(/A logout is a best effort, and the revocation is not/);
    expect(consequences).toMatch(/Outside production nothing retries/);
    const notDecided = adr.slice(
      adr.indexOf("### Not decided here"),
      adr.indexOf("## Consequences"),
    );
    // Decided since round 1: a 408 or 429 is retried, and finished rows are pruned.
    expect(notDecided).not.toMatch(/`408` or a `429`/);
    expect(notDecided).toMatch(/retention windows of finished deliveries/);
    expect(notDecided).toMatch(/re-sends a `failed` or `unreported` delivery as a NEW row/);
    expect(notDecided).toMatch(/`sid` claim/);
  });
});
