/**
 * The secret comparisons of the OpenID Connect provider are constant time (epic #2014 phase #2018;
 * ADR 0119 rule 13), held on the source the compiler reads, as `neurobagel-source-scan.test.ts` holds
 * the Neurobagel token's. A timing difference cannot be observed by a route test, so this is the
 * guard: the PKCE verifier against its challenge, and a client secret against its stored hash, go
 * through the shared `timingSafeEqual`, and neither is ever compared with `===` or `!==`.
 *
 * The redirect address is compared with the same helper but is not a secret (the client registered
 * it in the clear), so it is not held here.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import ts from "typescript";
import { SRC, createTree, parse } from "./helpers/ts-scan";

const tree = createTree();

/** Code without its comments, as the compiler would emit it, reformatted. */
function codeOf(file: string): string {
  return ts.createPrinter({ removeComments: true }).printFile(parse(tree, join(SRC, file)));
}

/** The text of one top-level function, from its declaration to its closing brace. */
function functionOf(code: string, name: string): string {
  const start = code.search(new RegExp(`function ${name}\\(`));
  expect(start).toBeGreaterThanOrEqual(0);
  const end = code.indexOf("\n}\n", start);
  return code.slice(start, end + 2);
}

const SHARED_HELPER =
  /import\s*\{[^}]*\btimingSafeEqual\b[^}]*\}\s*from\s*"\.\.\/lib\/constant-time\.js"/;

describe("the PKCE verifier is compared in constant time", () => {
  const tokens = codeOf("services/oidc-tokens.ts");

  test("from the shared helper, with no equality operator in the comparison", () => {
    expect(tokens).toMatch(SHARED_HELPER);
    const fn = functionOf(tokens, "verifierMatches");
    expect(fn).toMatch(/timingSafeEqual\(/);
    expect(fn).not.toMatch(/===|!==|==|!=/);
  });

  test("the redemption reaches the challenge only through that function", () => {
    const fn = functionOf(tokens, "redeemAuthorizationCode");
    expect(fn).toMatch(/verifierMatches\(form\.verifier, code\.code_challenge\)/);
    expect(fn).not.toMatch(
      /code_challenge\s*(===|!==|==|!=)|(===|!==|==|!=)\s*code\.code_challenge/,
    );
  });
});

describe("a client secret is compared in constant time", () => {
  const clients = codeOf("services/oidc-clients.ts");

  test("from the shared helper, against both hashes, with no equality operator on either", () => {
    expect(clients).toMatch(SHARED_HELPER);
    const fn = functionOf(clients, "verifyClientSecret");
    expect(fn).toMatch(/timingSafeEqual\(presentedHash, row\.secret_hash\)/);
    expect(fn).toMatch(/timingSafeEqual\(\s*presentedHash,/);
    // A test against null is not a comparison of secrets.
    expect(fn).not.toMatch(/(===|!==|==|!=)\s*row\.(previous_)?secret_hash/);
    expect(fn).not.toMatch(/row\.(previous_)?secret_hash\s*(?:===|!==|==|!=)(?!=)\s*(?!null\b)\S/);
    expect(fn).not.toMatch(/presentedHash\s*(===|!==|==|!=)|(===|!==|==|!=)\s*presentedHash/);
  });
});
