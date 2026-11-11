/**
 * Who uses the OpenID Connect cascade, read from the syntax tree (epic #2014 phase #2019; ADR 0119 rule 12).
 *
 * `services/oidc-cascade.ts` exports two functions that END an account's or a client's grants
 * (`oidcEndStatements`, `oidcClientEndStatements`) and the raw SQL each is built from (every `*_SQL`
 * constant). The list of paths that end a credential is only as good as the scan that holds the code to
 * it, so this scan follows the references a plain text search for a call misses:
 *
 *   - an ALIASED import (`import { oidcEndStatements as x }`), a LOCAL ALIAS CHAIN (`const f = x`, `g = f`),
 *     a NAMESPACE import (`import * as ns`, `ns.oidcEndStatements(...)`), and DESTRUCTURING of a namespace
 *     (`const { oidcEndStatements: f } = ns`);
 *   - the function passed or stored as a VALUE (`list.map(oidcEndStatements)`, `{ oidcEndStatements }`,
 *     `export { x }`), which is not a call this scan can attribute to a path;
 *   - an alias EXPORTED where it is declared (`export const endIt = oidcEndStatements`, `export let`, an
 *     exported destructured alias or namespace member, `export let f; f = oidcEndStatements`): it makes no
 *     call and passes no value in its own file, and another file can import it and call the cascade
 *     without being listed;
 *   - direct use of a raw `*_SQL` constant, which would run a statement of the cascade outside it;
 *   - the module reached in ways the scan cannot follow: a dynamic `import()` or `require()` (of the module,
 *     or of a name the scan cannot read), a re-export (`export ... from`), a default import, an element
 *     access on the namespace, and a reference at module level (no function to name as the path).
 *
 * A CALL is recorded with the file and the function it is in, which is what `OIDC_END_CALLERS` lists. Every
 * other way is a STRAY: a thing the list cannot describe, so the test that holds the list to the code fails
 * on it and the author either removes it or teaches this scan how to follow it.
 *
 * It resolves what an identifier is called, not what it means: scoping is not modelled, so an unrelated
 * local that shares a tracked name is flagged too, which is the safe direction (a false stray is a
 * rename; a missed alias is a path that ends a credential without being listed).
 *
 * A call that is present but never executed, or whose result is discarded, passes this scan; the
 * behavioural suites prove each path runs its statements.
 */

import { join } from "node:path";
import ts from "typescript";
import { SRC, type Tree, foldString, parse, rel, resolveImport } from "./ts-scan";

const CASCADE = join(SRC, "services/oidc-cascade.ts");

/** The two functions that end grants. */
export const END_FUNCTIONS = ["oidcEndStatements", "oidcClientEndStatements"] as const;

export interface EndCall {
  /** Under `backend/src`. */
  file: string;
  /** The function the call is in, or `(module)`. */
  site: string;
  /** Which exported function it calls, whatever the local name. */
  name: string;
}

export interface EndScan {
  calls: EndCall[];
  /** One sentence for each use the list of callers cannot describe. */
  strays: string[];
}

/** The `*_SQL` names the cascade module exports, read from the module itself so a new one is guarded. */
export function cascadeSqlExports(tree: Tree): string[] {
  const sf = parse(tree, CASCADE);
  const names: string[] = [];
  for (const statement of sf.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if (!statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    for (const d of statement.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.name.text.endsWith("_SQL")) names.push(d.name.text);
    }
  }
  return names;
}

/** An expression with the wrappers that change nothing at run time taken off. */
function bare(node: ts.Expression): ts.Expression {
  let e = node;
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isTypeAssertionExpression(e)
  ) {
    e = e.expression;
  }
  return e;
}

/** The name of the function or `(module)`: the same attribution `OIDC_END_CALLERS` is written in. */
function siteOf(node: ts.Node, sf: ts.SourceFile): string {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name) {
      return n.name.getText(sf);
    }
    if (
      ts.isVariableDeclaration(n) &&
      n.initializer &&
      (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
    ) {
      return n.name.getText(sf);
    }
  }
  return "(module)";
}

export function scanEndUsers(tree: Tree): EndScan {
  const calls: EndCall[] = [];
  const strays: string[] = [];
  const reported = new Set<string>();
  const guardedFunctions = new Set<string>(END_FUNCTIONS);
  const sqlNames = new Set(cascadeSqlExports(tree));
  const guarded = new Set<string>([...guardedFunctions, ...sqlNames]);

  for (const abs of tree.walk(SRC)) {
    if (abs === CASCADE) continue;
    const sf = parse(tree, abs);
    const file = rel(abs);
    const isCascade = (spec: string): boolean => resolveImport(tree, abs, spec) === CASCADE;
    const stray = (node: ts.Node, what: string): void => {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      const message = `${file}:${line + 1}: ${what}`;
      // The alias pass runs to a fixed point, so it reports the same use on each round.
      if (!reported.has(message)) {
        reported.add(message);
        strays.push(message);
      }
    };

    /**
     * The names this file exports at the declaration of a variable (`export const a = 1, { b } = x`), at any
     * depth (a namespace block can export too). An alias with one of these names is reachable from another
     * file, which is the one thing the references in THIS file cannot show.
     */
    const exportedNames = new Set<string>();
    const collectNames = (name: ts.BindingName): void => {
      if (ts.isIdentifier(name)) {
        exportedNames.add(name.text);
        return;
      }
      for (const element of name.elements) {
        if (ts.isBindingElement(element)) collectNames(element.name);
      }
    };
    const collectExports = (node: ts.Node): void => {
      if (
        ts.isVariableStatement(node) &&
        node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        for (const declaration of node.declarationList.declarations) {
          collectNames(declaration.name);
        }
      }
      ts.forEachChild(node, collectExports);
    };
    collectExports(sf);

    /** local name -> the guarded export it stands for. */
    const aliases = new Map<string, string>();
    const namespaces = new Set<string>();
    /** Reference nodes the alias tracking consumed (the right side of `const f = x`). */
    const consumed = new Set<ts.Node>();

    // ---- Pass 1: the ways the module is reached ------------------------------------------------
    const importsPass = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        if (
          isCascade(node.moduleSpecifier.text) &&
          node.importClause &&
          !node.importClause.isTypeOnly
        ) {
          const clause = node.importClause;
          if (clause.name) stray(clause.name, "a default import of the cascade module");
          const named = clause.namedBindings;
          if (named && ts.isNamespaceImport(named)) namespaces.add(named.name.text);
          if (named && ts.isNamedImports(named)) {
            for (const el of named.elements) {
              if (el.isTypeOnly) continue;
              const imported = (el.propertyName ?? el.name).text;
              if (guarded.has(imported)) aliases.set(el.name.text, imported);
              else if (imported === "default") stray(el, "a default import of the cascade module");
            }
          }
        }
      } else if (
        ts.isExportDeclaration(node) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        !node.isTypeOnly &&
        isCascade(node.moduleSpecifier.text)
      ) {
        stray(node, "a re-export from the cascade module");
      } else if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference) &&
        ts.isStringLiteral(node.moduleReference.expression) &&
        isCascade(node.moduleReference.expression.text)
      ) {
        stray(node, "an import = require of the cascade module");
      } else if (ts.isCallExpression(node)) {
        const dynamic =
          node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require");
        if (dynamic) {
          const arg = node.arguments[0];
          const folded = arg ? foldString(arg) : null;
          if (folded === null || folded.includes("\u0000")) {
            stray(node, "a dynamic import or require whose module name cannot be read");
          } else if (isCascade(folded)) {
            stray(node, "a dynamic import or require of the cascade module");
          }
        }
      }
      ts.forEachChild(node, importsPass);
    };
    importsPass(sf);
    if (aliases.size === 0 && namespaces.size === 0) {
      // Still scanned below for nothing: no binding to the module, so no reference to follow.
      continue;
    }

    /** What a reference expression stands for: a guarded export, through an alias or a namespace. */
    const standsFor = (expr: ts.Expression): string | null => {
      const e = bare(expr);
      if (ts.isIdentifier(e)) return aliases.get(e.text) ?? null;
      if (
        ts.isPropertyAccessExpression(e) &&
        ts.isIdentifier(e.expression) &&
        namespaces.has(e.expression.text) &&
        guarded.has(e.name.text)
      ) {
        return e.name.text;
      }
      return null;
    };

    // ---- Pass 2: aliases, to a fixed point ------------------------------------------------------
    const addAlias = (local: string, name: string, source: ts.Node): void => {
      consumed.add(source);
      // An alias EXPORTED where it is declared is a path the list cannot describe: nothing in this file is
      // a call or a value, and another file imports it and calls it. (`const f = x; export { f }` and
      // `export default` are caught as values in the last pass, where the export names the alias.)
      if (exportedNames.has(local)) {
        stray(source, `an exported alias (${local}) of ${name}, which another file could call`);
      }
      if (aliases.get(local) !== name) {
        aliases.set(local, name);
        changed = true;
      }
    };
    let changed = true;
    const aliasPass = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const init = bare(node.initializer);
        const target = standsFor(init);
        if (ts.isIdentifier(node.name) && target) addAlias(node.name.text, target, init);
        // `const { oidcEndStatements: f } = ns`
        if (
          ts.isObjectBindingPattern(node.name) &&
          ts.isIdentifier(init) &&
          namespaces.has(init.text)
        ) {
          consumed.add(init);
          for (const el of node.name.elements) {
            if (el.dotDotDotToken) {
              stray(el, "a rest element taken from the cascade module's namespace");
              continue;
            }
            const key = el.propertyName ?? el.name;
            if (!ts.isIdentifier(key) && !ts.isStringLiteral(key)) {
              stray(el, "a computed key taken from the cascade module's namespace");
              continue;
            }
            if (guarded.has(key.text) && ts.isIdentifier(el.name))
              addAlias(el.name.text, key.text, init);
            else if (guarded.has(key.text))
              stray(el, "a guarded export destructured into a pattern");
          }
        }
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(node.left)
      ) {
        const target = standsFor(node.right);
        if (target) addAlias(node.left.text, target, bare(node.right));
      }
      ts.forEachChild(node, aliasPass);
    };
    while (changed) {
      changed = false;
      aliasPass(sf);
    }

    // ---- Pass 3: every reference ----------------------------------------------------------------
    /** `typeof oidcEndStatements` in a type: it names the function and runs nothing. */
    const inTypeQuery = (id: ts.Identifier): boolean => {
      let n: ts.Node = id;
      while (ts.isQualifiedName(n.parent)) n = n.parent;
      return ts.isTypeQueryNode(n.parent);
    };

    const isDeclarationName = (id: ts.Identifier): boolean => {
      const p = id.parent;
      return (
        inTypeQuery(id) ||
        // `third = second`: the left side is a write of an alias, which the alias pass already follows.
        (ts.isBinaryExpression(p) &&
          p.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          p.left === id) ||
        (ts.isImportSpecifier(p) && (p.name === id || p.propertyName === id)) ||
        ts.isNamespaceImport(p) ||
        ts.isImportClause(p) ||
        (ts.isVariableDeclaration(p) && p.name === id) ||
        (ts.isBindingElement(p) && (p.name === id || p.propertyName === id)) ||
        (ts.isPropertyAccessExpression(p) && p.name === id) ||
        (ts.isPropertyAssignment(p) && p.name === id) ||
        (ts.isMethodDeclaration(p) && p.name === id) ||
        (ts.isParameter(p) && p.name === id) ||
        (ts.isFunctionDeclaration(p) && p.name === id)
      );
    };

    const classify = (reference: ts.Node, name: string): void => {
      // A raw statement is never a use the list can describe, whether or not it was also aliased.
      if (sqlNames.has(name)) {
        stray(reference, `use of ${name}, a raw statement of the cascade, outside it`);
        return;
      }
      if (consumed.has(reference)) return;
      const parent = reference.parent;
      if (ts.isCallExpression(parent) && parent.expression === reference) {
        const site = siteOf(reference, sf);
        calls.push({ file, site, name });
        if (site === "(module)") stray(reference, `a module-level call of ${name}`);
        return;
      }
      stray(reference, `${name} used as a value, not called`);
    };

    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && !isDeclarationName(node)) {
        const local = aliases.get(node.text);
        if (local) classify(node, local);
        else if (namespaces.has(node.text)) {
          const p = node.parent;
          if (ts.isPropertyAccessExpression(p) && p.expression === node) {
            // `ns.name`: a guarded name is a reference; any other export (a list, a type) is not one.
            if (guarded.has(p.name.text)) classify(p, p.name.text);
          } else if (!consumed.has(node)) {
            stray(node, "the cascade module's namespace used as a value or by element access");
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  calls.sort((a, b) =>
    `${a.file} ${a.site} ${a.name}`.localeCompare(`${b.file} ${b.site} ${b.name}`),
  );
  return { calls, strays };
}
