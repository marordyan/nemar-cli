/**
 * The pure rules of an accepted re-pull merge (`shared/repull-merge-acceptance.ts`; ADR 0111, the
 * amendment of 2026-10-29): what a commit did to the ledger, which commits a ledger's acceptance
 * lines name, the root-tree comparison outside NEMAR's paths, the paths enrichment writes, and the
 * line itself. The Worker and the CLI read these; the proof reads the first two.
 */

import { describe, expect, test } from "bun:test";
import {
  type TreeEntry,
  acceptedMergesOf,
  changesBesideLedger,
  classifyMergeParents,
  isEnrichmentPath,
  ledgerChange,
  ledgerTimeOf,
  mergeAcceptanceLine,
  sameOutsideNemar,
} from "../shared/repull-merge-acceptance";

const line = (action: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ action, scanner: "identifier-scan@abcdef1", ...extra });
const MERGE = "0123456789abcdef0123456789abcdef01234567";
const PLAN = `sha256:${"a".repeat(64)}`;

describe("ledgerChange: what a commit did to the ledger", () => {
  test("nothing, an append of scrub lines, and with or without the re-pull's", () => {
    const a = `${line("plan")}\n`;
    expect(ledgerChange(a, a)).toEqual({ kind: "none" });
    expect(ledgerChange(null, null)).toEqual({ kind: "none" });
    expect(ledgerChange(a, `${a}${line("import-scrubbed")}\n`)).toEqual({
      kind: "scrub-append",
      repull: false,
      scanner: null,
    });
    expect(ledgerChange(null, `${line("repull-scrubbed")}\n`)).toEqual({
      kind: "scrub-append",
      repull: true,
      scanner: "identifier-scan@abcdef1",
    });
  });

  test("a removal, an edited earlier line, another word or a line that does not parse is other", () => {
    const a = `${line("plan")}\n`;
    expect(ledgerChange(a, null).kind).toBe("other");
    expect(ledgerChange(a, "").kind).toBe("other");
    expect(ledgerChange(a, `${line("files-removed")}\n${line("repull-scrubbed")}\n`).kind).toBe(
      "other",
    );
    expect(ledgerChange(a, `${a}${line("headers-scrubbed")}\n`).kind).toBe("other");
    expect(ledgerChange(a, `${a}${line("repull-merge-accepted")}\n`).kind).toBe("other");
    expect(ledgerChange(a, `${a}Jane Doe\n`).kind).toBe("other");
  });
});

describe("acceptedMergesOf: the commits a ledger's acceptance lines name", () => {
  test("each named once, in order, from acceptance lines only", () => {
    const other = "f".repeat(40);
    const text = [
      line("repull-scrubbed"),
      line("repull-merge-accepted", { commit: MERGE }),
      line("plan", { commit: other }),
      line("repull-merge-accepted", { commit: other }),
      line("repull-merge-accepted", { commit: MERGE }),
      "not json",
      "",
    ].join("\n");
    expect(acceptedMergesOf(text)).toEqual([MERGE, other]);
    expect(acceptedMergesOf("")).toEqual([]);
  });
});

describe("sameOutsideNemar: two root trees outside .nemar/ and .github/", () => {
  const entry = (path: string, sha: string, type = "blob", mode = "100644"): TreeEntry => ({
    path,
    mode,
    type,
    sha,
  });
  const tree = [
    entry("README.md", "1".repeat(40)),
    entry("sub-01", "2".repeat(40), "tree", "040000"),
    entry(".nemar", "3".repeat(40), "tree", "040000"),
    entry(".github", "4".repeat(40), "tree", "040000"),
  ];

  test("NEMAR's two directories are left out; everything else decides, in any order", () => {
    const moved = [
      entry(".github", "9".repeat(40), "tree", "040000"),
      entry("sub-01", "2".repeat(40), "tree", "040000"),
      entry("README.md", "1".repeat(40)),
    ];
    expect(sameOutsideNemar(tree, moved)).toBe(true);
  });

  test("another object, mode or type, an entry more or less, or a FILE named .nemar is a difference", () => {
    const swap = (i: number, e: TreeEntry) => tree.map((t, j) => (j === i ? e : t));
    expect(sameOutsideNemar(tree, swap(0, entry("README.md", "5".repeat(40))))).toBe(false);
    expect(
      sameOutsideNemar(tree, swap(0, entry("README.md", "1".repeat(40), "blob", "100755"))),
    ).toBe(false);
    expect(sameOutsideNemar(tree, tree.slice(1))).toBe(false);
    expect(sameOutsideNemar(tree, [...tree, entry("CHANGES", "6".repeat(40))])).toBe(false);
    expect(sameOutsideNemar(tree, [...tree.slice(0, 2), entry(".nemar", "3".repeat(40))])).toBe(
      false,
    );
  });
});

describe("changesBesideLedger: whether a commit changed a path but the ledger", () => {
  const e = (path: string, sha: string, type = "blob", mode = "100644"): TreeEntry => ({
    path,
    mode,
    type,
    sha,
  });
  const ledger = (sha: string) => e("corrections.jsonl", sha);
  const readme = e("README.md", "1".repeat(40));

  test("a parent with no .nemar and a merge that adds only the ledger changed nothing else", () => {
    const parent = [readme];
    const merge = [readme, e(".nemar", "2".repeat(40), "tree", "040000")];
    expect(changesBesideLedger(parent, merge, null, [ledger("3".repeat(40))])).toBe(false);
    // And with another file beside the ledger in the new .nemar, it did.
    expect(
      changesBesideLedger(parent, merge, null, [
        ledger("3".repeat(40)),
        e("metadata.json", "4".repeat(40)),
      ]),
    ).toBe(true);
  });

  test("a change outside .nemar, or under .nemar beside the ledger, is a change; the ledger alone is not", () => {
    const nemarA = e(".nemar", "5".repeat(40), "tree", "040000");
    const nemarB = e(".nemar", "6".repeat(40), "tree", "040000");
    const meta = e("metadata.json", "7".repeat(40));
    expect(
      changesBesideLedger([readme, nemarA], [e("README.md", "8".repeat(40)), nemarA], null, null),
    ).toBe(true);
    expect(
      changesBesideLedger(
        [readme, nemarA],
        [readme, nemarB],
        [meta, ledger("a".repeat(40))],
        [meta, ledger("b".repeat(40))],
      ),
    ).toBe(false);
    expect(
      changesBesideLedger(
        [readme, nemarA],
        [readme, nemarB],
        [meta, ledger("a".repeat(40))],
        [e("metadata.json", "9".repeat(40)), ledger("b".repeat(40))],
      ),
    ).toBe(true);
    // A .nemar removed with something beside the ledger in it is a change.
    expect(
      changesBesideLedger([readme, nemarA], [readme], [meta, ledger("a".repeat(40))], null),
    ).toBe(true);
  });
});

describe("isEnrichmentPath: the paths enrichment writes, by name", () => {
  test(".nemar/ files but the ledger, .bidsignore and the root participants.tsv", () => {
    expect(isEnrichmentPath(".nemar/metadata.json")).toBe(true);
    expect(isEnrichmentPath(".bidsignore")).toBe(true);
    expect(isEnrichmentPath("participants.tsv")).toBe(true);
    expect(isEnrichmentPath(".nemar/corrections.jsonl")).toBe(false);
    expect(isEnrichmentPath("sub-01/participants.tsv")).toBe(false);
    expect(isEnrichmentPath("README.md")).toBe(false);
    expect(isEnrichmentPath(".github/workflows/x.yml")).toBe(false);
  });
});

describe("mergeAcceptanceLine: the line, a function of the stored acceptance", () => {
  const facts = {
    dataset: "on099999",
    version: "2.0.0",
    mergeSha: MERGE,
    planDigest: PLAN,
    scanner: "identifier-scan@abcdef1",
    at: ledgerTimeOf("2026-10-29 12:00:00"),
  };

  test("the same facts give the same bytes, keys in the ledger's order, no reason", () => {
    const a = mergeAcceptanceLine(facts);
    expect(a).toBe(mergeAcceptanceLine({ ...facts }));
    expect(Object.keys(JSON.parse(a))).toEqual([
      "version",
      "at",
      "dataset",
      "action",
      "versions",
      "counts",
      "scanner",
      "verification",
      "actor",
      "commit",
      "plan",
    ]);
    expect(JSON.parse(a)).toMatchObject({
      at: "2026-10-29T12:00:00.000Z",
      versions: ["v2.0.0"],
      commit: MERGE,
      plan: PLAN,
    });
  });

  test("a value that is not of its shape is refused", () => {
    for (const over of [
      { mergeSha: MERGE.slice(0, 12) },
      { planDigest: "sha256:abc" },
      { scanner: "anything" },
      { version: "v2.0.0" },
      { at: "2026-10-29 12:00:00" },
    ]) {
      expect(() => mergeAcceptanceLine({ ...facts, ...over })).toThrow();
    }
    expect(() => ledgerTimeOf("2026-10-29T12:00:00Z")).toThrow();
  });
});

describe("classifyMergeParents: the shapes of merge commit the acceptance takes", () => {
  const BASE = "1".repeat(40);
  const HEAD = "2".repeat(40);
  const OTHER = "3".repeat(40);
  const short = MERGE.slice(0, 12);

  test("one parent is a squash, whatever it is: the caller compares it with the base", () => {
    expect(classifyMergeParents([BASE], HEAD, short)).toEqual({
      ok: true,
      shape: "squash",
      first: BASE,
    });
  });

  test("two parents with the merged head second are GitHub's plain merge, the first parent being the base side", () => {
    expect(classifyMergeParents([BASE, HEAD], HEAD, short)).toEqual({
      ok: true,
      shape: "merge-commit",
      first: BASE,
    });
  });

  test("two parents whose second is not the merged head are refused, and so is the head first", () => {
    for (const parents of [
      [BASE, OTHER],
      [HEAD, BASE],
      [BASE, BASE],
    ]) {
      const verdict = classifyMergeParents(parents, HEAD, short);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) {
        expect(verdict.code).toBe("merge-second-parent-foreign");
        expect(verdict.message).toContain(short);
      }
    }
  });

  test("no parent, or three or more, is merge-not-squash, even with the merged head among them", () => {
    for (const parents of [[], [BASE, HEAD, OTHER], [HEAD, BASE, OTHER], [BASE, OTHER, HEAD]]) {
      const verdict = classifyMergeParents(parents, HEAD, short);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) {
        expect(verdict.code).toBe("merge-not-squash");
        expect(verdict.message).toContain(`${parents.length} parents`);
      }
    }
  });
});
