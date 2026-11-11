/**
 * Only `LINEAGE_WRITE_SQL` writes the basis word `lineage` (epic #1046 phase 6, #1912; ADR 0111,
 * decision 4: the word says a tree was compared with upstream's, which only a re-pull's plan
 * establishes). A source scan on the syntax tree, as `source-snapshot-insert.test.ts` does for the
 * version INSERT, and for the same reason: a second writer would be a second opinion about what
 * `lineage` means, and no behavior test would notice it.
 *
 * Three rules, each proven to fire on a planted violation:
 *  1. a statement that names `source_version_basis` and the literal `'lineage'` in a write is
 *     `LINEAGE_WRITE_SQL` itself and nothing else;
 *  2. no call to `bind` or `run` carries the string `"lineage"` as an argument, which is how a
 *     writer that takes the word as a parameter would spell it;
 *  3. an `UPDATE dataset_versions ... source_version_basis =` lives only in the two services that
 *     own such a write (the backfill, which writes `doi` and `unknown`, and the re-pull).
 */

import { describe, expect, test } from "bun:test";
import ts from "typescript";
import { LINEAGE_WRITE_SQL } from "../src/services/upstream-repull";
import { SRC, type Tree, createTree, foldedStrings, parse, rel } from "./helpers/ts-scan";

const OWNERS = ["services/upstream-backfill.ts", "services/upstream-repull.ts"];

const WRITE_RE = /\b(?:UPDATE|INSERT|REPLACE)\b/i;

/** Statements that write the word `lineage` into the basis column, by file. */
function lineageWrites(tree: Tree): Array<{ file: string; sql: string }> {
  const found: Array<{ file: string; sql: string }> = [];
  for (const file of tree.walk(SRC)) {
    for (const sql of foldedStrings(parse(tree, file))) {
      if (WRITE_RE.test(sql) && /source_version_basis/.test(sql) && /'lineage'/.test(sql)) {
        found.push({ file: rel(file), sql });
      }
    }
  }
  return found;
}

/** Files with a `bind` or `run` call that is handed the string "lineage". */
function boundLineage(tree: Tree): string[] {
  const found = new Set<string>();
  for (const file of tree.walk(SRC)) {
    const sf = parse(tree, file);
    const hasLineage = (n: ts.Node): boolean => {
      if (ts.isStringLiteralLike(n) && n.text === "lineage") return true;
      return ts.forEachChild(n, (c) => (hasLineage(c) ? true : undefined)) ?? false;
    };
    const visit = (n: ts.Node): void => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        ["bind", "run"].includes(n.expression.name.text) &&
        n.arguments.some(hasLineage)
      ) {
        found.add(rel(file));
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return [...found];
}

/** Files with an UPDATE of dataset_versions that sets the basis column. */
function basisUpdates(tree: Tree): string[] {
  const found = new Set<string>();
  for (const file of tree.walk(SRC)) {
    for (const sql of foldedStrings(parse(tree, file))) {
      if (/UPDATE\s+dataset_versions[\s\S]*?source_version_basis\s*=/i.test(sql)) {
        found.add(rel(file));
      }
    }
  }
  return [...found];
}

describe("the one writer of the basis word lineage", () => {
  test("the only statement that writes it is LINEAGE_WRITE_SQL, in the re-pull service", () => {
    const writes = lineageWrites(createTree());
    expect(writes.map((w) => w.file)).toEqual([rel(`${SRC}/services/upstream-repull.ts`)]);
    expect(writes[0]?.sql).toBe(LINEAGE_WRITE_SQL);
  }, 60_000);

  test("no bind or run call is handed the word", () => {
    expect(boundLineage(createTree())).toEqual([]);
  }, 60_000);

  test("only the backfill and the re-pull update the basis column", () => {
    expect(basisUpdates(createTree()).sort()).toEqual(OWNERS.map((o) => rel(`${SRC}/${o}`)).sort());
  }, 60_000);

  test("rule 1 fires on a planted second writer, including one split across a concatenation", () => {
    const planted = createTree({
      "services/planted.ts":
        "export const SQL = \"UPDATE dataset_versions SET source_version_basis = 'lineage' WHERE id = ?\";",
      "services/planted-split.ts":
        'export const SQL = "UPDATE dataset_versions SET source_version_basis = \'" + "lineage\' WHERE id = ?";',
    });
    expect(
      lineageWrites(planted)
        .map((w) => w.file)
        .sort(),
    ).toEqual([
      rel(`${SRC}/services/planted-split.ts`),
      rel(`${SRC}/services/planted.ts`),
      rel(`${SRC}/services/upstream-repull.ts`),
    ]);
  }, 60_000);

  test("rule 2 fires on a writer that takes the word as a parameter", () => {
    const planted = createTree({
      "services/planted-bind.ts":
        'export const f = (db: D1Database) => db.prepare("UPDATE dataset_versions SET source_version_basis = ?").bind("lineage").run();',
      "services/planted-nested.ts":
        "export const g = (s: { bind(...a: unknown[]): unknown }) => s.bind(1, [`lineage`]);",
    });
    expect(boundLineage(planted).sort()).toEqual([
      rel(`${SRC}/services/planted-bind.ts`),
      rel(`${SRC}/services/planted-nested.ts`),
    ]);
  }, 60_000);

  test("rule 3 fires on a third file that updates the basis column", () => {
    const planted = createTree({
      "services/planted-basis.ts":
        'export const SQL = "UPDATE dataset_versions SET source_version = ?, source_version_basis = ? WHERE id = ?";',
    });
    expect(basisUpdates(planted)).toContain(rel(`${SRC}/services/planted-basis.ts`));
  }, 60_000);
});
