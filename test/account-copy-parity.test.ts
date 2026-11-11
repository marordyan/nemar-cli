/**
 * Drift check between `shared/contract/account-copy.ts` and the website's
 * transcription of it (#1268, ADR 0045; nemarOrg/website#310).
 *
 * The two repos share no package, so the website's `src/lib/account-copy.ts` is
 * a copy of this contract rather than an import of it. A copy with nothing
 * watching it is a fork with a delay, which is what this test exists to
 * prevent: every key that is NOT `cli.`-prefixed must exist there, carrying the
 * same string.
 *
 * **It reads the website file as TEXT, and does not import it.** A dynamic
 * import would drag that repo's module graph (astro, vite-resolved specifiers)
 * in for a table of string constants and would fail for reasons that have
 * nothing to do with drift. Text extraction has one requirement in exchange,
 * documented in account-copy.ts and enforced below: every value is a plain
 * string literal.
 *
 * **The extractor is proved on THIS file, which is the same shape.** A
 * developer running the suite may have no website checkout at all, so the
 * reader that will be pointed at a file they cannot see is first pointed at one
 * they can — and those assertions run either way.
 *
 * **CI IS THE POINT, and it used to be excluded from it.** This block ended in
 * an early `return` when no website checkout was found, so the parity claim was
 * enforced on developer machines and nowhere else — a green required check that
 * had never once compared the two files. The `unit-pure` job now sparse-checks
 * out `nemarOrg/website`'s `src/lib/account-copy.ts` (public, no token) and
 * names it in `NEMAR_WEBSITE_ACCOUNT_COPY`.
 *
 * So there are two modes, and the difference between them is deliberate:
 *
 *   `NEMAR_WEBSITE_ACCOUNT_COPY` set   that path IS the contract. A file that
 *                                      is not there FAILS, naming the path and
 *                                      the variable — because the only way to
 *                                      reach it is a checkout step that broke,
 *                                      and a silent skip would hand the check
 *                                      straight back to nobody.
 *   unset                              search the sibling checkouts a developer
 *                                      is likely to have. Absent is a VISIBLE
 *                                      skip (bun's `describe.skipIf`), not a
 *                                      pass: a skipped test is reported as
 *                                      skipped, and an early `return` is
 *                                      reported as success.
 *
 * The website's own `test/account-copy-drift.test.ts` is the mirror image of
 * this file, and is getting the same treatment via `NEMAR_CLI_ACCOUNT_COPY`.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { ACCOUNT_COPY } from "../shared/contract/account-copy.js";
import {
  UPLOAD_ACCESS_WHY_MAX_CHARS,
  UPLOAD_ACCESS_WHY_MIN_CHARS,
} from "../shared/contract/user.js";

const REPO_ROOT = join(import.meta.dir, "..");
const CONTRACT_FILE = join(REPO_ROOT, "shared", "contract", "account-copy.ts");

/**
 * Where a website checkout is expected to sit relative to this one.
 *
 * Both repos live under one parent directory, and this repo is often a
 * WORKTREE (`account-tiers-phase8/`, `epic-account-tiers/`, ...) rather than
 * `nemar-cli/` itself — so the search is one level up from the repo root
 * whatever the root is called.
 *
 * Only consulted when {@link WEBSITE_ENV_VAR} is unset; CI names the file
 * outright rather than hoping it landed somewhere on this list.
 */
const WEBSITE_CANDIDATES = [
  join(REPO_ROOT, "..", "website", "src", "lib", "account-copy.ts"),
  join(REPO_ROOT, "..", "..", "website", "src", "lib", "account-copy.ts"),
];

/** Set by the `unit-pure` job to the sparse checkout it made. A relative value
 *  is resolved against the repo root, which is the workflow's working
 *  directory. */
const WEBSITE_ENV_VAR = "NEMAR_WEBSITE_ACCOUNT_COPY";
const declaredRaw = process.env[WEBSITE_ENV_VAR];
const DECLARED_PATH =
  declaredRaw && declaredRaw.trim() !== ""
    ? isAbsolute(declaredRaw)
      ? declaredRaw
      : join(REPO_ROOT, declaredRaw)
    : null;

/**
 * Pull `"key": "value"` pairs out of a TypeScript source file.
 *
 * Byte-for-byte the extractor the website's drift test uses (its
 * `test/copy-drift.ts`), so the two halves of the mirror cannot disagree about
 * what they are comparing. Comments are stripped first so a key quoted in prose
 * cannot become an entry; a value that is not a plain string literal is
 * invisible to it, which is why the literal-only rule exists and is asserted
 * below.
 */
function extractCopy(source: string): Map<string, string> {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, " ");
  const entries = new Map<string, string>();
  const pattern = /"([A-Za-z0-9_.]+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  for (const match of withoutComments.matchAll(pattern)) {
    entries.set(match[1], match[2].replace(/\\(.)/g, "$1"));
  }
  return entries;
}

/** Keys the website is expected to mirror: everything without the CLI prefix. */
const SHARED_KEYS = Object.keys(ACCOUNT_COPY).filter((key) => !key.startsWith("cli."));

describe("the copy table's own rules", () => {
  test("every value is a plain string literal, so the drift check can see it", () => {
    // The failure this prevents: a template literal or a concatenation is
    // extracted as NOTHING, so a silently unread key becomes a silently
    // unchecked key on both sides of the mirror.
    const extracted = extractCopy(readFileSync(CONTRACT_FILE, "utf8"));
    expect(Object.fromEntries(extracted)).toEqual({ ...ACCOUNT_COPY });
  });

  test("the extractor ignores a key quoted inside a comment", () => {
    const source = [
      '/* the key "tier.base.label": "Not this one" appears in prose */',
      '// "tier.base.label": "Nor this one"',
      'const X = { "tier.base.label": "Base access" };',
    ].join("\n");
    expect(extractCopy(source).get("tier.base.label")).toBe("Base access");
    expect(extractCopy(source).size).toBe(1);
  });

  test("the extractor invents nothing for a computed value", () => {
    const source = 'const X = { "a.b": `${MIN}-${MAX} chars`, "c.d": "plain" };';
    expect(extractCopy(source).has("a.b")).toBe(false);
    expect(extractCopy(source).get("c.d")).toBe("plain");
  });

  test("the why-hint's written-out bounds still match the constants", () => {
    // Rule 1 forbids interpolating them, so this is what keeps the sentence
    // honest when the bounds move.
    expect(ACCOUNT_COPY["upload_access.request.why_hint"]).toBe(
      `Describe what you intend to upload in ${UPLOAD_ACCESS_WHY_MIN_CHARS}-${UPLOAD_ACCESS_WHY_MAX_CHARS} characters`,
    );
  });

  test("every placeholder comes from the declared vocabulary", () => {
    const allowed = new Set([
      "label",
      "blocks",
      "web",
      "cli",
      "date",
      "client",
      "redirect_host",
      "reason",
    ]);
    for (const [key, value] of Object.entries(ACCOUNT_COPY)) {
      for (const [, name] of value.matchAll(/\{(\w+)\}/g)) {
        expect({ key, name, allowed: [...allowed] }).toEqual({
          key,
          name: allowed.has(name) ? name : `UNDECLARED:${name}`,
          allowed: [...allowed],
        });
      }
    }
  });

  test("keys are dotted lowercase tokens, which is what makes them extractable", () => {
    for (const key of Object.keys(ACCOUNT_COPY)) {
      expect(key).toMatch(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/);
    }
  });
});

/** Where the website's table is, or null when nobody has told us and none of
 *  the usual sibling checkouts is present. A DECLARED path counts as found
 *  whether or not it exists — the existence check is a failing assertion, not a
 *  reason to skip. */
const FOUND = DECLARED_PATH ?? WEBSITE_CANDIDATES.find((path) => existsSync(path)) ?? null;
const NO_CHECKOUT = FOUND === null;

if (NO_CHECKOUT) {
  console.info(
    `[account-copy parity] skipping: no website checkout at ${WEBSITE_CANDIDATES.join(" or ")}, ` +
      `and ${WEBSITE_ENV_VAR} is unset. CI sets it; this is the developer-machine path.`,
  );
}

/**
 * The website's table, or a failure that says exactly what to fix.
 *
 * The throw is the whole difference between this file and the version that
 * silently returned: when CI has named a path, a file that is not there means
 * the checkout step broke, and that must fail the job rather than quietly
 * disable the check it exists to run.
 */
function websiteCopy(): Map<string, string> {
  if (FOUND === null) throw new Error("unreachable: the parity block is skipped without a file");
  if (!existsSync(FOUND)) {
    throw new Error(
      `${WEBSITE_ENV_VAR}=${declaredRaw} resolves to ${FOUND}, which does not exist. That variable is the contract: CI points it at the sparse checkout of nemarOrg/website made by the unit-pure job. If that step changed or was removed, fix the workflow -- do not unset the variable to make this pass.`,
    );
  }
  return extractCopy(readFileSync(FOUND, "utf8"));
}

describe.skipIf(NO_CHECKOUT)("website parity", () => {
  const found = FOUND as string;

  test("every shared key matches the website string for string", () => {
    const theirs = websiteCopy();
    const drifted: string[] = [];
    const absent: string[] = [];
    for (const key of SHARED_KEYS) {
      const mine = ACCOUNT_COPY[key as keyof typeof ACCOUNT_COPY];
      const yours = theirs.get(key);
      if (yours === undefined) absent.push(key);
      else if (yours !== mine) {
        drifted.push(`${key}\n    nemar-cli: ${mine}\n    website:   ${yours}`);
      }
    }
    expect(
      drifted,
      `Copy drifted from ${found}. This contract is the source of truth; update the website.`,
    ).toEqual([]);
    expect(
      absent,
      `Keys absent from ${found}. Every non-cli key here is meant to be mirrored there.`,
    ).toEqual([]);
  });

  test("nothing the website carries is missing here", () => {
    // The other direction, and the one this repo can actually fix: a key the
    // website has and this contract does not is a sentence with no source of
    // truth. The website's own drift test fails on exactly this.
    const theirs = websiteCopy();
    const unmirrored = [...theirs.keys()].filter((key) => !(key in ACCOUNT_COPY));
    expect(unmirrored, "Add these to shared/contract/account-copy.ts.").toEqual([]);
  });

  test("CLI-only keys are prefixed, and are the only ones the website may lack", () => {
    // Rule 4. Enforced here rather than trusted: an unprefixed key the website
    // has no surface for would fail its drift test in the other repo, where
    // whoever added it is not looking.
    const cliOnly = Object.keys(ACCOUNT_COPY).filter((key) => key.startsWith("cli."));
    expect(cliOnly.length).toBeGreaterThan(0);
    const theirs = websiteCopy();
    for (const key of cliOnly) expect(theirs.has(key)).toBe(false);
    for (const key of SHARED_KEYS) expect(theirs.has(key)).toBe(true);
  });
});
