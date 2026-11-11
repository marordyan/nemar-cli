/**
 * Two things about the compute gateway's SOURCE that a run cannot prove (epic #2005 phase A5, #2010;
 * ADR 0118, round 1 of the review of PR #2041), on the syntax tree like `neurobagel-source-scan.test.ts`
 * (`helpers/ts-scan.ts`), each shown to FIRE by a planted violation laid over a scratch copy:
 *
 *  1. A TOKEN IS COMPARED IN CONSTANT TIME. `verifyComputeToken` ends in `timingSafeEqual(token,
 *     expected)`; nothing in it compares either with `===`, `!==`, `==` or `!=`. A run cannot tell the two
 *     apart: both answer true for the same token. (MUTATION: write `token === expected`.)
 *  2. THE COMPUTE SWITCH IS READ IN ONE PLACE THAT GATES. `computeEnabled(` is called by `submitLeased`
 *     (the one place that refuses to put a job on a cluster) and by `computeStatus` (which only REPORTS it).
 *     Nowhere else, and never by a reference that is not a call and never as `.COMPUTE_ENABLED`: a switch
 *     read in `applyTapisJob`'s terminal path would strand a running job's settlement the moment compute
 *     was turned off. The behaviour twin is `compute-lifecycle-money.test.ts`: a job that ends with
 *     compute off is settled. (MUTATION: call `computeEnabled(env)` in `commitTerminal`.)
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import ts from "typescript";
import { SRC, type Tree, createTree, parse, rel } from "./helpers/ts-scan";

const real = createTree();
const COMPARISONS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

/** The body of the function (or arrow) declared with `name` in `sf`, or null. */
function functionNamed(sf: ts.SourceFile, name: string): ts.Node | null {
  let found: ts.Node | null = null;
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer !== undefined
    ) {
      found = node.initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** The text of every comparison inside `node` that has one of `names` as an operand. */
function comparisonsOf(node: ts.Node, names: string[]): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (
      ts.isBinaryExpression(n) &&
      COMPARISONS.has(n.operatorToken.kind) &&
      [n.left, n.right].some((side) => ts.isIdentifier(side) && names.includes(side.text))
    ) {
      out.push(n.getText());
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

/** The calls of `callee` inside `node`, as their argument texts. */
function callsOf(node: ts.Node, callee: string): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === callee) {
      out.push(n.arguments.map((a) => a.getText()).join(", "));
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

const TOKENS = join(SRC, "services/compute-tokens.ts");

function tokenFindings(tree: Tree) {
  const sf = parse(tree, TOKENS);
  const verify = functionNamed(sf, "verifyComputeToken");
  if (verify === null) throw new Error("verifyComputeToken is not in compute-tokens.ts");
  return {
    safeCalls: callsOf(verify, "timingSafeEqual"),
    comparisons: comparisonsOf(verify, ["token", "expected"]),
    imported: sf.statements.some(
      (s) =>
        ts.isImportDeclaration(s) &&
        ts.isStringLiteral(s.moduleSpecifier) &&
        s.moduleSpecifier.text === "../lib/constant-time.js" &&
        s.getText().includes("timingSafeEqual"),
    ),
  };
}

describe("a compute token is compared in constant time", () => {
  test("verifyComputeToken calls timingSafeEqual(token, expected), imported from the shared helper, and compares neither with an operator", () => {
    const found = tokenFindings(real);
    expect(found.imported).toBe(true);
    expect(found.safeCalls).toEqual(["token, expected"]);
    expect(found.comparisons).toEqual([]);
  });

  test("the scan FIRES: a `===` compare, and a missing helper call, are both found", () => {
    const text = real.read(TOKENS) as string;
    const planted = createTree({
      "services/compute-tokens.ts": text.replace(
        "return timingSafeEqual(token, expected);",
        "return token === expected;",
      ),
    });
    expect(text).toContain("return timingSafeEqual(token, expected);");
    const found = tokenFindings(planted);
    expect(found.safeCalls).toEqual([]);
    expect(found.comparisons).toEqual(["token === expected"]);
  }, 60_000);
});

/** Every `computeEnabled(` call under `backend/src`, as `<file>:<enclosing function>`, and every other mention. */
function switchFindings(tree: Tree) {
  const calls: string[] = [];
  const otherMentions: string[] = [];
  for (const file of tree.walk(SRC)) {
    if (file.endsWith("services/compute-switches.ts")) continue;
    const sf = parse(tree, file);
    const visit = (node: ts.Node, enclosing: string) => {
      let here = enclosing;
      if (ts.isFunctionDeclaration(node) && node.name !== undefined) here = node.name.text;
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer !== undefined &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
      ) {
        here = node.name.text;
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        if (node.expression.text === "computeEnabled") calls.push(`${rel(file)}:${here}`);
      } else if (
        ts.isIdentifier(node) &&
        node.text === "computeEnabled" &&
        !ts.isImportSpecifier(node.parent) &&
        !(ts.isCallExpression(node.parent) && node.parent.expression === node)
      ) {
        otherMentions.push(`${rel(file)}:${here}`);
      }
      if (ts.isPropertyAccessExpression(node) && node.name.text === "COMPUTE_ENABLED") {
        otherMentions.push(`${rel(file)}:${here}:.COMPUTE_ENABLED`);
      }
      ts.forEachChild(node, (child) => visit(child, here));
    };
    visit(sf, "<module>");
  }
  return { calls: calls.sort(), otherMentions: otherMentions.sort() };
}

describe("the compute switch is read in one place that gates", () => {
  // The lifecycle gates in ONE place, `submitLeased`: a job already on a cluster is never stranded by
  // turning compute off. Phase A6 (#2011) adds the reads that stop NEW pipeline work being started with
  // compute off, each before anything is written: the dispatch refuses before it claims a stamp or takes
  // a hold (a hold taken with compute off would sit on a job `submitLeased` would then refuse to submit),
  // the admin route refuses a live run with `compute_disabled`, and the dry run only REPORTS the switch.
  // Phase A7 (#2012) adds the tenant sweep: it cancels jobs in the tenant and charges the partner pool, so
  // it acts only while the owner has switched compute on, and refuses before it lists anything. It moves
  // no job that is bound to a row (a job a row owns is left alone), but it does cancel a duplicate of a
  // NEMAR job and a job nobody reserved. Nothing that moves a job a row already owns reads it.
  test("only submitLeased gates the lifecycle on it; the pipeline dispatch and its route refuse new work, the tenant sweep acts only while it is on, the two reports only report it, and nothing else reads it", () => {
    expect(switchFindings(real)).toEqual({
      calls: [
        "routes/admin/compute-pipeline.ts:registerComputePipelineAdminRoutes",
        "services/compute-lifecycle.ts:submitLeased",
        "services/compute-pipeline.ts:dispatchPipelineJob",
        "services/compute-pipeline.ts:pipelineDryRun",
        "services/compute-status.ts:computeStatus",
        "services/compute-tenant-sweep.ts:sweepTenantJobs",
      ],
      otherMentions: [],
    });
  });

  test("the scan FIRES: a read in the terminal commit, an alias and a direct variable read are each found", () => {
    const lifecycle = real.read(join(SRC, "services/compute-lifecycle.ts")) as string;
    const needle = "async function commitTerminal(";
    expect(lifecycle).toContain(needle);
    const planted = createTree({
      "services/compute-lifecycle.ts": lifecycle
        .replace(
          needle,
          `const aliased = computeEnabled;\nconst direct = (env: Bindings) => env.COMPUTE_ENABLED;\n${needle}`,
        )
        .replace(
          "const db = env.DB;\n  const gate = { sql: SETTLEMENT_GATE_SQL, binds: [job.id, plan.to] };",
          "const db = env.DB;\n  if (!computeEnabled(env)) return false;\n  const gate = { sql: SETTLEMENT_GATE_SQL, binds: [job.id, plan.to] };",
        ),
    });
    const found = switchFindings(planted);
    expect(found.calls).toContain("services/compute-lifecycle.ts:commitTerminal");
    expect(found.otherMentions).toEqual([
      "services/compute-lifecycle.ts:<module>",
      "services/compute-lifecycle.ts:direct:.COMPUTE_ENABLED",
    ]);
  }, 60_000);
});
