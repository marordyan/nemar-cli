/**
 * Discovery stays id-only, and the re-pull never reaches it (epic #1046 phases 4 and 7, #1910 and
 * #1913; ADR 0111, decision 6).
 *
 * Decision 6: "`diffNewDatasets` stays id-only, so the live auto-import never sees a stale
 * mirror; staleness is computed by its own report." `AUTO_IMPORT_ENABLED` is on in production, so
 * nothing a re-pull needs may reach the auto-import's candidate set, and the automatic re-pull's
 * scheduler, which reads the staleness report, must not reach discovery's set-diff either.
 *
 * A source scan on the syntax tree (`helpers/ts-scan.ts`, as `repull-no-mail-scan.test.ts` does):
 * the transitive import closures of the auto-import and of discovery hold no re-pull or staleness
 * module, and the closures of the staleness report (and of the scheduler that reads it) hold
 * neither the auto-import nor discovery. The two share OpenNeuro's endpoint through a leaf that
 * imports nothing (`services/openneuro-endpoint.ts`). Each rule is proven to fire on a planted
 * import.
 */

import { describe, expect, test } from "bun:test";
import { SRC, type Tree, chainTo, createTree, importClosure } from "./helpers/ts-scan";

const DISCOVERY_ROOTS = [
  `${SRC}/services/auto-import.ts`,
  `${SRC}/services/openneuro-discovery.ts`,
];
const DISCOVERY_FILES = new Set(DISCOVERY_ROOTS);

/** The modules on the re-pull's side: the record, its routes and dispatches, and the staleness report. */
const REPULL_SIDE = /\/services\/(upstream-repull[^/]*|upstream-status|openneuro-snapshots)\.ts$/;

const REPULL_ROOTS = [
  `${SRC}/services/upstream-status.ts`,
  `${SRC}/services/upstream-repull-scheduler.ts`,
];

function discoveryReachesRepull(tree: Tree): string[] {
  const closure = importClosure(tree, DISCOVERY_ROOTS, new Set());
  return [...closure.files].filter((f) => REPULL_SIDE.test(f)).map((f) => chainTo(closure, f));
}

function repullReachesDiscovery(tree: Tree, roots: readonly string[]): string[] {
  const closure = importClosure(tree, roots, new Set());
  return [...closure.files].filter((f) => DISCOVERY_FILES.has(f)).map((f) => chainTo(closure, f));
}

describe("discovery and the re-pull do not reach each other", () => {
  test("the auto-import and discovery load no re-pull or staleness module", () => {
    const tree = createTree();
    const closure = importClosure(tree, DISCOVERY_ROOTS, new Set());
    // The scan must reach what it is about, or an empty answer is not a pass.
    expect(closure.files.has(`${SRC}/services/openneuro-discovery.ts`)).toBe(true);
    expect(closure.files.has(`${SRC}/services/openneuro-endpoint.ts`)).toBe(true);
    expect(closure.unanalyzable).toEqual([]);
    expect(discoveryReachesRepull(tree)).toEqual([]);
  }, 60_000);

  test("the staleness report and the scheduler load neither the auto-import nor discovery", () => {
    const tree = createTree();
    const closure = importClosure(tree, REPULL_ROOTS, new Set());
    expect(closure.files.has(`${SRC}/services/upstream-repull-dispatch.ts`)).toBe(true);
    expect(closure.files.has(`${SRC}/services/openneuro-snapshots.ts`)).toBe(true);
    expect(closure.files.has(`${SRC}/services/openneuro-endpoint.ts`)).toBe(true);
    expect(closure.unanalyzable).toEqual([]);
    expect(repullReachesDiscovery(tree, REPULL_ROOTS)).toEqual([]);
  }, 60_000);

  test("it fires when the snapshot reader takes the endpoint from discovery again", () => {
    const base = createTree();
    const file = `${SRC}/services/openneuro-snapshots.ts`;
    const planted = createTree({
      "services/openneuro-snapshots.ts": (base.read(file) ?? "").replace(
        "./openneuro-endpoint.js",
        "./openneuro-discovery.js",
      ),
    });
    const found = repullReachesDiscovery(planted, REPULL_ROOTS);
    expect(found).toHaveLength(1);
    expect(found[0]).toEndWith(
      "services/upstream-status.ts -> services/openneuro-snapshots.ts -> services/openneuro-discovery.ts",
    );
  }, 60_000);

  test("it fires when discovery reaches the staleness report", () => {
    const base = createTree();
    const file = `${SRC}/services/openneuro-discovery.ts`;
    const planted = createTree({
      "services/openneuro-discovery.ts": `${base.read(file)}\nexport { runUpstreamStatusPage } from "./upstream-status";\n`,
    });
    expect(discoveryReachesRepull(planted).some((c) => c.endsWith("upstream-status.ts"))).toBe(
      true,
    );
  }, 60_000);
});
