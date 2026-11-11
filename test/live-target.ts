/**
 * Which backend the live test tier is allowed to talk to.
 *
 * This exists because the harness used to fail OPEN: `TEST_API_URL` unset meant
 * `https://api.nemar.org`, so a `bun test` in a fresh clone or worktree -- where
 * `test/.env.test` is gitignored and therefore absent -- pointed the whole live
 * tier at PRODUCTION without saying so. Six of the live suites had noticed and
 * grown their own `TEST_ALLOW_PROD` guard; the rest, including `test/cli.test.ts`
 * and `test/api.test.ts`, had not.
 *
 * What that cost, concretely: `test/cli.test.ts` runs `auth login -k <adminApiKey>`,
 * `adminApiKey` is `""` with no env file, and an empty `-k` used to fall through to
 * the browser device flow (fixed in `src/commands/auth.ts` in the same change) -- so
 * the suite minted a real device code on production and opened the developer's
 * browser on production's authorize page, which asks for an ORCID sign-in. A test
 * run initiating an account sign-in against production is the failure this file
 * closes, at the level where it can be closed once.
 *
 * The decision is a pure function because the enforcement in `test/setup.ts` runs
 * at import time, which is untestable by construction: by the time a test could
 * observe it, it has already happened.
 */

/** Hosts that ARE production. `data.nemar.org` is included because the six
 *  hand-rolled guards this generalises all check for it too: it fronts the same
 *  data plane, so pointing a live suite at it is the same mistake. */
export const PRODUCTION_API_HOSTS = ["api.nemar.org", "data.nemar.org"] as const;

/**
 * Where a blocked run is pointed instead.
 *
 * Port 1 is privileged and unassigned, so a connection is refused immediately
 * rather than hanging: a blocked live suite fails fast and locally. Deliberately
 * NOT left as the production URL with only a warning printed -- a warning in a
 * 6600-test run scrolls past, and the traffic still leaves the machine.
 */
export const BLOCKED_API_URL = "http://127.0.0.1:1";

/**
 * WHAT THIS FENCE DOES NOT COVER, so nobody over-trusts it.
 *
 * It governs the NEMAR API url and nothing else. A test that talks to S3, to
 * `api.resend.com`, or to GitHub with ambient credentials is outside it entirely --
 * `test/import-openneuro-s3-copy.integration.test.ts` writes to the PRODUCTION
 * bucket whenever AWS session credentials happen to be exported, which is a state
 * .rules/datasets-and-fixtures.md actively tells people to be in. Those need their own guards.
 */

export interface LiveTargetDecision {
  /** The DECLARED target: what suites should use to decide whether to skip.
   *  Stays the production URL when blocked, so the existing `POINTS_AT_PROD`
   *  checks in the six self-guarding suites keep skipping exactly as before. */
  declaredApiUrl: string;
  /** What a request should actually be sent to, and what child processes get. */
  effectiveApiUrl: string;
  /** Whether the declared target is a production host. */
  pointsAtProd: boolean;
  /** Production, without an explicit opt-in: no live request may be made. */
  blocked: boolean;
  /** Why, in one line, for the message the harness prints. */
  reason: string;
}

/** True for the spellings of "yes" a human types into an env var. `"0"`,
 *  `"false"` and `""` are NOT an opt-in: someone who exports
 *  `TEST_ALLOW_PROD=0` means the opposite of allowing it, and reading any
 *  non-empty value as truthy is how that becomes a production test run. */
export function isEnvOptIn(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * Does `url` name a production host?
 *
 * Parsed rather than substring-matched, so a local stub at
 * `http://localhost:3000/api.nemar.org` is not mistaken for production and nobody
 * learns to work around the fence.
 *
 * An UNREADABLE target is treated AS production, because the fence has to fail
 * closed: a target we cannot read is exactly the case where we cannot prove it is
 * safe. "Unreadable" is wider than "throws", which is what the first version of
 * this got wrong and its own test caught -- `new URL("localhost:8787")` parses
 * happily as scheme `localhost:` with an EMPTY hostname, so a schemeless host:port
 * came back "not production" from a value naming no host at all. So the readable
 * case is narrowed to what a live test could actually talk to: an http(s) url with
 * a hostname.
 */
export function pointsAtProduction(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }
  const readable =
    (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname !== "";
  if (!readable) return true;
  // A single trailing dot is stripped: `api.nemar.org.` is the same DNS name, and
  // WHATWG `URL` keeps the dot in `hostname`, so an equality check would have let
  // the one readable-but-equivalent spelling through.
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  return PRODUCTION_API_HOSTS.some((h) => host === h);
}

/**
 * Resolve the live-test target and whether talking to it is allowed.
 *
 * `testApiUrl` empty or whitespace-only is treated as unset, because that is how
 * it arrives from a `.env.test` line with no value and from `TEST_API_URL=` in a
 * shell -- and the whole point of this function is that "no target declared" must
 * not silently mean "production".
 */
export function decideLiveTarget(args: {
  testApiUrl: string | undefined;
  allowProd: string | undefined;
  defaultApiUrl: string;
}): LiveTargetDecision {
  const declared = (args.testApiUrl ?? "").trim() || args.defaultApiUrl;
  const pointsAtProd = pointsAtProduction(declared);
  const allowed = isEnvOptIn(args.allowProd);
  const blocked = pointsAtProd && !allowed;

  let reason: string;
  if (!pointsAtProd) {
    reason = `live target ${declared}`;
  } else if (allowed) {
    reason = `live target ${declared} (production, allowed by TEST_ALLOW_PROD)`;
  } else {
    reason = `${declared} is production; live requests are blocked`;
  }

  return {
    declaredApiUrl: declared,
    effectiveApiUrl: blocked ? BLOCKED_API_URL : declared,
    pointsAtProd,
    blocked,
    reason,
  };
}

/** The message the harness prints once when it blocks, and the one `testRequest`
 *  throws. Names all three ways out, because the fence is worthless if the person
 *  who hits it cannot tell what to do next. */
export function blockedTargetMessage(declaredApiUrl: string): string {
  return [
    `Refusing to run live tests against production (${declaredApiUrl}).`,
    "  TEST_API_URL is unset or points at production, so this run would have sent",
    "  real requests to the live backend. Do one of:",
    "    - create test/.env.test (see test/.env.test.example) so TEST_API_URL names a dev backend",
    "    - export TEST_API_URL=https://nemar-api-dev.sccn-org.workers.dev for one run",
    "    - export TEST_ALLOW_PROD=1 if you genuinely mean to test against production",
    "  A dev target alone is not enough for most live suites: they also need the seeded",
    "  TEST_ADMIN_API_KEY / TEST_USER_API_KEY, or they will fail on the auth gate.",
  ].join("\n");
}
