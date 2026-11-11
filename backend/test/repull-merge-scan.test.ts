/**
 * The Worker merges a pull request in one place, and approves none (epic #1046 phase 7, #1913;
 * ADR 0111's Phase 7g amendment; ADR 0093: an approval is the administrator's own act, and no
 * Worker code path approves).
 *
 * A source scan on the syntax tree, as `repull-no-mail-scan.test.ts` does for mail, over every
 * file of the Worker (`backend/src`) and the transitive import closure of the re-pull services
 * (`backend/src/services/upstream-repull*.ts`), which adds the shared modules they load: a string
 * that folds to GitHub's merge endpoint (`/pulls/<n>/merge`) appears once, as the URL of a `PUT`
 * in `sendSquashMerge`; no string names GraphQL's merge mutations; and no string folds to GitHub's
 * review endpoint (`/pulls/<n>/reviews`), the `APPROVE` event or GraphQL's review mutations.
 * Strings are folded from literals, templates and concatenations, so a name split in two is still
 * seen. Each rule is proven to fire on a planted violation. A URL built at run time from parts the
 * scan cannot read is outside what it can see.
 */

import { describe, expect, test } from "bun:test";
import ts from "typescript";
import {
  HOLE,
  SRC,
  type Tree,
  createTree,
  foldString,
  importClosure,
  parse,
  rel,
} from "./helpers/ts-scan";

/** Every re-pull service: the files the Worker's re-pull code is made of. */
const repullServices = (tree: Tree) =>
  tree.walk(`${SRC}/services`).filter((f) => /\/upstream-repull[^/]*\.ts$/.test(f));

/** GitHub's merge endpoint, a hole standing for the number. */
const MERGE_PATH = /\/pulls\/[^/]*\/merge(?:$|[?#])/;
const GRAPHQL_MERGE = /\b(?:mergePullRequest|enablePullRequestAutoMerge)\b/;
/** GitHub's review endpoint, the event that approves, and GraphQL's review mutations. */
const REVIEWS = [
  /\/pulls\/[^/]*\/reviews(?:$|[/?#])/,
  /\bAPPROVE\b/,
  /\b(?:addPullRequestReview|submitPullRequestReview)\b/,
];

/** The one merge the Worker may send. */
const THE_MERGE = { file: "services/upstream-repull-merge.ts", fn: "sendSquashMerge", put: true };

interface Found {
  file: string;
  /** The function the string is in, or null at a module's top level. */
  fn: string | null;
  /** Whether the string is the URL of a call whose options say `method: "PUT"`. */
  put: boolean;
}

function enclosingFunction(n: ts.Node): string | null {
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
    if ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) && p.name) {
      return p.name.getText();
    }
    if (
      (ts.isArrowFunction(p) || ts.isFunctionExpression(p)) &&
      ts.isVariableDeclaration(p.parent)
    ) {
      return p.parent.name.getText();
    }
  }
  return null;
}

function isPutUrl(n: ts.Node): boolean {
  const call = n.parent;
  if (!call || !ts.isCallExpression(call) || call.arguments[0] !== n) return false;
  const opts = call.arguments[1];
  return Boolean(
    opts &&
      ts.isObjectLiteralExpression(opts) &&
      opts.properties.some(
        (p) =>
          ts.isPropertyAssignment(p) &&
          p.name.getText() === "method" &&
          foldString(p.initializer)?.toUpperCase() === "PUT",
      ),
  );
}

/** Every folded string of `files`, with where it is: each file parsed once. */
function foldedStringsIn(tree: Tree, files: Iterable<string>): Array<Found & { text: string }> {
  const out: Array<Found & { text: string }> = [];
  for (const file of files) {
    const visit = (n: ts.Node): void => {
      const text = foldString(n);
      if (text !== null && !ts.isParenthesizedExpression(n)) {
        out.push({ file: rel(file), fn: enclosingFunction(n), put: isPutUrl(n), text });
        // A template's spans can hold more strings; a concatenation's operands are folded in.
        if (ts.isTemplateExpression(n)) for (const s of n.templateSpans) visit(s.expression);
        return;
      }
      ts.forEachChild(n, visit);
    };
    visit(parse(tree, file));
  }
  return out;
}

/** The files scanned: every file of the Worker, and the re-pull services' closure. */
function scanned(tree: Tree): { files: Set<string>; unanalyzable: string[] } {
  const closure = importClosure(tree, repullServices(tree), new Set());
  return {
    files: new Set([...tree.walk(SRC), ...closure.files]),
    unanalyzable: closure.unanalyzable.map((u) => rel(u.file)),
  };
}

/** The merges the scan sees, without the folded text. */
function merges(tree: Tree): Found[] {
  return foldedStringsIn(tree, scanned(tree).files)
    .filter((s) => MERGE_PATH.test(s.text))
    .map(({ file, fn, put }) => ({ file, fn, put }));
}

const where = (f: Found) => `${f.file}${f.fn ? ` (${f.fn})` : ""}`;

/** What the rules find, in words: empty when the Worker merges once and approves nothing. */
function findings(tree: Tree): string[] {
  const { files, unanalyzable } = scanned(tree);
  const strings = foldedStringsIn(tree, files);
  const found: string[] = [];
  const merging = strings.filter((s) => MERGE_PATH.test(s.text));
  const theOne = merging.filter(
    (m) => m.file === THE_MERGE.file && m.fn === THE_MERGE.fn && m.put === THE_MERGE.put,
  );
  if (theOne.length !== 1) found.push(`the one merge is found ${theOne.length} times`);
  for (const m of merging) {
    if (!theOne.includes(m)) found.push(`a merge in ${where(m)}${m.put ? "" : ", not a PUT"}`);
  }
  for (const m of strings.filter((s) => GRAPHQL_MERGE.test(s.text))) {
    found.push(`a GraphQL merge in ${where(m)}`);
  }
  for (const m of strings.filter((s) => REVIEWS.some((re) => re.test(s.text)))) {
    found.push(`a review in ${where(m)}`);
  }
  for (const file of unanalyzable) found.push(`unanalyzable import in ${file}`);
  return found;
}

const MERGE_MODULE = `${SRC}/services/upstream-repull-merge.ts`;

/** `file` (under `backend/src`) with `tail` appended. */
const appended = (file: string, tail: string) => ({
  [file]: `${createTree().read(`${SRC}/${file}`)}\n${tail}\n`,
});

describe("the Worker merges in one place and approves nothing", () => {
  test("the Worker holds one merge, a PUT in sendSquashMerge, and no review", () => {
    const tree = createTree();
    const services = repullServices(tree);
    // The scan is only as good as the files it reads: it must reach the code it is about.
    for (const f of [
      "services/upstream-repull.ts",
      "services/upstream-repull-advance.ts",
      "services/upstream-repull-merge.ts",
      "services/upstream-repull-verified.ts",
      "services/upstream-repull-github.ts",
    ]) {
      expect(services).toContain(`${SRC}/${f}`);
    }
    const { files } = scanned(tree);
    for (const f of ["routes/admin/upstream-repulls.ts", "services/pr-review-start.ts"]) {
      expect(files.has(`${SRC}/${f}`)).toBe(true);
    }
    // The shared modules the re-pull loads are scanned too, though they are not under `backend/src`.
    expect([...files].some((f) => f.endsWith("/shared/repull-squash.ts"))).toBe(true);
    // Not vacuous: the one merge is there to be found, where it is expected.
    expect(merges(tree)).toEqual([THE_MERGE]);
    expect(findings(tree)).toEqual([]);
  }, 60_000);

  test("it fires on a second merge in another re-pull service", () => {
    const planted = createTree(
      appended(
        "services/upstream-repull-verified.ts",
        'export const again = (u: string, n: number) => fetch(`${u}/pulls/${n}/merge`, { method: "PUT" });',
      ),
    );
    expect(findings(planted)).toEqual(["a merge in services/upstream-repull-verified.ts (again)"]);
  }, 60_000);

  test("it fires on a merge elsewhere in the Worker, its path built from pieces", () => {
    const planted = createTree(
      appended(
        "services/github/shared.ts",
        'export function mergeUrl(n: number) { return "/pulls/" + n + "/merge"; }',
      ),
    );
    expect(findings(planted)).toEqual([
      "a merge in services/github/shared.ts (mergeUrl), not a PUT",
    ]);
  }, 60_000);

  test("it fires when the one merge is no longer a PUT, and when it moves out of sendSquashMerge", () => {
    const text = createTree().read(MERGE_MODULE) as string;
    expect(text.split('method: "PUT"')).toHaveLength(2);
    const post = createTree({
      "services/upstream-repull-merge.ts": text.replace('method: "PUT"', 'method: "POST"'),
    });
    expect(findings(post)).toEqual([
      "the one merge is found 0 times",
      "a merge in services/upstream-repull-merge.ts (sendSquashMerge), not a PUT",
    ]);
    expect(text.split("async function sendSquashMerge(")).toHaveLength(2);
    const moved = createTree({
      "services/upstream-repull-merge.ts": text.replace(
        "async function sendSquashMerge(",
        "async function sendAnyMerge(",
      ),
    });
    expect(findings(moved)).toEqual([
      "the one merge is found 0 times",
      "a merge in services/upstream-repull-merge.ts (sendAnyMerge)",
    ]);
  }, 60_000);

  test("it fires on GraphQL's merge mutation", () => {
    const planted = createTree(
      appended(
        "services/upstream-repull-advance.ts",
        'export const q = "mutation { mergePullRequest(input: $i) { clientMutationId } }";',
      ),
    );
    expect(findings(planted)).toEqual(["a GraphQL merge in services/upstream-repull-advance.ts"]);
  }, 60_000);

  test("it fires on a review written with the event that approves, even split in two", () => {
    const planted = createTree(
      appended(
        "services/upstream-repull-advance.ts",
        'export const approve = (u: string) => fetch(`${u}/pulls/7/reviews`, { method: "POST", body: JSON.stringify({ event: "APP" + "ROVE" }) });',
      ),
    );
    expect(findings(planted)).toEqual([
      "a review in services/upstream-repull-advance.ts (approve)",
      "a review in services/upstream-repull-advance.ts (approve)",
    ]);
    const graphql = createTree(
      appended(
        "services/upstream-repull-facts.ts",
        'export const m = "mutation { addPullRequestReview(input: $i) { clientMutationId } }";',
      ),
    );
    expect(findings(graphql)).toEqual(["a review in services/upstream-repull-facts.ts"]);
  }, 60_000);

  test("it fires on an approval anywhere in the Worker, outside the re-pull's own code", () => {
    const planted = createTree(
      appended("routes/users.ts", 'export const review = { event: "APPROVE" };'),
    );
    expect(findings(planted)).toEqual(["a review in routes/users.ts"]);
  }, 60_000);

  test("a new re-pull service is scanned without being named", () => {
    const planted = createTree({
      "services/upstream-repull-approve.ts":
        'export const send = (u: string) => fetch(`${u}/pulls/1/reviews`, { method: "POST" });\n',
    });
    expect(findings(planted)).toEqual(["a review in services/upstream-repull-approve.ts (send)"]);
  }, 60_000);

  test("a merge path with a hole for its number is still a merge path", () => {
    expect(MERGE_PATH.test(`${HOLE}/repos/${HOLE}/${HOLE}/pulls/${HOLE}/merge`)).toBe(true);
    expect(MERGE_PATH.test("/pulls/7/merged-files")).toBe(false);
  });
});
