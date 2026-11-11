/**
 * What the Neurobagel feature's SOURCE may and may not do (epic #1586, phase 4; ADR 0084).
 *
 * These are scans of the code, so they prove an ABSENCE a behavioural test cannot: that no
 * second module can write the bucket, that nothing in the feature reads the reserved DOI
 * except through the blinded projection, that no code path of the feature sends mail or
 * dispatches to GitHub, that the hooks are never awaited, and that the committed
 * configuration turns everything off. A scan is weaker than a behaviour, so each one is
 * paired with a test that RUNS the thing it is about, named in a comment.
 *
 * They read the SYNTAX TREE (`helpers/ts-scan.ts`), not the text, so a rule is about what the
 * code does and not how it is spelled: an extensionless or dynamic import, a destructured
 * binding, `bucket["put"]`, a method taken with `.bind`, a string built from two halves. And
 * each rule is shown to FIRE: a planted violation is laid over the tree (a scratch copy; the
 * real files are never touched) and must be found, next to a plain control that must not.
 *
 * "The feature" is `services/neurobagel-*.ts`, `routes/neurobagel.ts` and
 * `routes/admin/neurobagel.ts`. The data plane the gatherer calls in-process
 * (`routes/data.ts`, `services/data-router.ts`) is a BOUNDARY: it is the code whose answers
 * the feature takes as given, it already reads the public repositories it serves, and the
 * import closure below stops at it.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import ts from "typescript";
import { DEV_CRON_ALLOWLIST } from "../src/index";
import {
  BUCKET_MUTATORS,
  HOLE,
  SRC,
  type Tree,
  bucketLeaks,
  bucketMutations,
  chainTo,
  createTree,
  foldedStrings,
  importClosure,
  namesTheBucketBinding,
  parse,
  rel,
  resolveImport,
  scanImports,
  wildcardSelects,
} from "./helpers/ts-scan";

const SERVICES = join(SRC, "services");
const WRITER = join(SERVICES, "neurobagel-writer.ts");
const HOOKS = join(SERVICES, "neurobagel-hooks.ts");
// Phase 6: the verification sweep (ADR 0067's amendment) and its upstream drift reader.
const VERIFY = join(SERVICES, "neurobagel-verify.ts");
const DRIFT = join(SERVICES, "neurobagel-drift.ts");
const real = createTree();

function featureOf(tree: Tree): string[] {
  return [
    ...tree.walk(SERVICES).filter((f) => /^neurobagel-.*\.ts$/.test(basename(f))),
    join(SRC, "routes/neurobagel.ts"),
    join(SRC, "routes/admin/neurobagel.ts"),
  ];
}

/** Code without its comments, from the tree: what the compiler would emit, reformatted. */
function codeOf(tree: Tree, file: string): string {
  return ts.createPrinter({ removeComments: true }).printFile(parse(tree, file));
}

const BOUNDARY = new Set([join(SRC, "routes/data.ts"), join(SERVICES, "data-router.ts")]);
const PUBLIC_API_HOST = /\bapi\.github\.com\b/;

/** A scratch file the planted violations live in: not the writer, not part of the feature unless named so. */
const SCRATCH = join(SERVICES, "scratch-not-the-writer.ts");
const planted = (text: string, file = "services/scratch-not-the-writer.ts") =>
  createTree({ [file]: text });

const FORBIDDEN_NAMES =
  /\b(sendEmail|sendBroadcast|sendAnonymity\w*Email|repository_dispatch|getDatasetsToken|createOrUpdateFile|createIssue|triggerWorkflow|RESEND_API_KEY|api\.github\.com)\b/;

/**
 * The ONE exemption: the upstream drift reader names the public GitHub API host, to read it.
 * Every other forbidden name stays forbidden there, and the host stays forbidden everywhere
 * else; `describe("the upstream drift reader")` below holds what it does with that host to a
 * plain GET.
 */
const PUBLIC_READ_HOST = PUBLIC_API_HOST;
const exempt = (file: string, text: string): boolean =>
  file === DRIFT && PUBLIC_READ_HOST.test(text) && !FORBIDDEN_NAMES_WITHOUT_HOST.test(text);
const FORBIDDEN_NAMES_WITHOUT_HOST =
  /\b(sendEmail|sendBroadcast|sendAnonymity\w*Email|repository_dispatch|getDatasetsToken|createOrUpdateFile|createIssue|triggerWorkflow|RESEND_API_KEY)\b/;

/** The names the feature uses, as identifiers and as strings (a name split in two included). */
function forbiddenNames(tree: Tree): string[] {
  const hits: string[] = [];
  for (const file of featureOf(tree)) {
    const sf = parse(tree, file);
    const visit = (n: ts.Node): void => {
      if (ts.isIdentifier(n) && FORBIDDEN_NAMES.test(n.text)) {
        hits.push(`${rel(file)}: ${n.text}`);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    for (const s of foldedStrings(sf)) {
      const text = s.replaceAll(HOLE, "");
      if (FORBIDDEN_NAMES.test(text) && !exempt(file, text)) {
        hits.push(`${rel(file)}: "${s.slice(0, 40)}"`);
      }
    }
  }
  return hits;
}

describe("the feature is the set of files this scan thinks it is", () => {
  test("discovery finds the modules, so nothing below passes over an empty list", () => {
    expect(featureOf(real).map(rel).sort()).toEqual(
      [
        "routes/admin/neurobagel.ts",
        "routes/neurobagel.ts",
        "services/neurobagel-curation.ts",
        "services/neurobagel-drift.ts",
        "services/neurobagel-eligibility.ts",
        "services/neurobagel-fingerprint.ts",
        "services/neurobagel-gather.ts",
        "services/neurobagel-hooks.ts",
        "services/neurobagel-ops.ts",
        "services/neurobagel-plan.ts",
        "services/neurobagel-status.ts",
        "services/neurobagel-store.ts",
        "services/neurobagel-verify.ts",
        "services/neurobagel-writer.ts",
      ].sort(),
    );
  });
});

describe("only the writer writes the bucket", () => {
  // Behavioural twin: neurobagel-writer.test.ts counts every put and delete a run makes.
  const FEATURE_SET = new Set(featureOf(real));
  const isFeatureModule = (spec: string) => /(^|\/)neurobagel-[a-z]+(\.js)?$/.test(spec);

  test("no file in the tree but the writer can reach a mutating method of the binding, by any syntax", () => {
    for (const file of real.walk(SRC)) {
      if (file === WRITER) continue;
      // In the feature anything typed R2Bucket may be the binding; elsewhere an R2Bucket is
      // another bucket's (the news media's), and only what traces to the binding counts.
      const typed = FEATURE_SET.has(file);
      expect(bucketMutations(parse(real, file), { typed }), rel(file)).toEqual([]);
    }
  });

  test("the binding is never handed to code outside the feature, by the files that hold it", () => {
    for (const file of FEATURE_SET) {
      expect(bucketLeaks(parse(real, file), isFeatureModule), rel(file)).toEqual([]);
    }
  });

  test("handing it to a helper elsewhere is found; handing it to the feature's own store module is not", () => {
    const leaks = (code: string) => bucketLeaks(parse(planted(code), SCRATCH), isFeatureModule);
    expect(
      leaks(
        'import { rogue } from "./news-media.js"; export const f = (e: Bindings) => rogue(e.NEUROBAGEL);',
      ),
    ).toHaveLength(1);
    expect(
      leaks('import { rogue } from "../lib/x.js"; export const f = (b: R2Bucket) => rogue(b);'),
    ).toHaveLength(1);
    expect(leaks("export const f = (b: R2Bucket) => globalThis.rogue(b);")).toHaveLength(1);
    expect(
      leaks(
        'import { listStore } from "./neurobagel-store.js"; export const f = (e: Bindings) => listStore(e.NEUROBAGEL);',
      ),
    ).toEqual([]);
    expect(
      leaks(
        "function local(b: R2Bucket) { return b; } export const f = (b: R2Bucket) => local(b);",
      ),
    ).toEqual([]);
    expect(
      leaks("export const f = (e: Bindings) => new Proxy(e.NEUROBAGEL as object, {});"),
    ).toEqual([]);
  });

  test("the writer does reach them, so the scan above is not vacuous", () => {
    const found = bucketMutations(parse(real, WRITER)).map((f) => f.what);
    expect(found.some((w) => w.startsWith(".put"))).toBe(true);
    expect(found.some((w) => w.startsWith(".delete"))).toBe(true);
  });

  test("the binding is named only by the files that are meant to hold it", () => {
    const holders = real
      .walk(SRC)
      .filter((f) => namesTheBucketBinding(parse(real, f)))
      .map(rel)
      .sort();
    expect(holders).toEqual(
      [
        "routes/neurobagel.ts",
        "services/neurobagel-ops.ts",
        "services/neurobagel-status.ts",
        "services/neurobagel-verify.ts",
        "services/neurobagel-writer.ts",
        "types/bindings.ts",
      ].sort(),
    );
  });

  describe("each way round the rule is found, in a file that is not the writer", () => {
    const VIOLATIONS: [string, string][] = [
      [
        "a plain put on the binding",
        "export async function f(env: Bindings) { await env.NEUROBAGEL.put('k', 'v'); }",
      ],
      [
        "optional chaining",
        "export async function f(env: Bindings) { await env.NEUROBAGEL?.delete('k'); }",
      ],
      [
        "a destructured binding",
        "export async function f(env: Bindings) { const { NEUROBAGEL } = env; await NEUROBAGEL.put('k', 'v'); }",
      ],
      [
        "a renamed destructured binding",
        "export async function f(env: Bindings) { const { NEUROBAGEL: store } = env; await store.delete('k'); }",
      ],
      [
        "a destructured parameter",
        "export async function f({ NEUROBAGEL }: Bindings) { await NEUROBAGEL.put('k', 'v'); }",
      ],
      [
        "an alias of an alias",
        "export async function f(env: Bindings) { const a = env.NEUROBAGEL; const b = a; await b.put('k', 'v'); }",
      ],
      [
        "a cast",
        "export async function f(env: Bindings) { const b = env.NEUROBAGEL as R2Bucket; await b.put('k', 'v'); }",
      ],
      [
        "a parameter typed as a bucket",
        "export async function f(bucket: R2Bucket) { await bucket.delete('k'); }",
      ],
      [
        "an element access with a literal key",
        "export async function f(bucket: R2Bucket) { await bucket['put']('k', 'v'); }",
      ],
      [
        "an element access with a key built from two halves",
        "export async function f(bucket: R2Bucket) { await bucket['pu' + 't']('k', 'v'); }",
      ],
      [
        "an element access with a variable key",
        "export async function f(bucket: R2Bucket, op: string) { await bucket[op]('k', 'v'); }",
      ],
      [
        "a method taken with bind",
        "export function f(bucket: R2Bucket) { return bucket.put.bind(bucket); }",
      ],
      [
        "a method destructured from the bucket",
        "export async function f(bucket: R2Bucket) { const { put } = bucket; await put('k', 'v'); }",
      ],
      [
        "a rest element taken from the bucket",
        "export async function f(bucket: R2Bucket) { const { ...methods } = bucket; return methods; }",
      ],
      [
        "a multipart upload",
        "export async function f(bucket: R2Bucket) { return bucket.createMultipartUpload('k'); }",
      ],
      [
        "a field typed as a bucket",
        "export class K { private bucket: R2Bucket; run() { return this.bucket.put('k', 'v'); } }",
      ],
    ];
    for (const [label, code] of VIOLATIONS) {
      test(label, () => {
        expect(bucketMutations(parse(planted(code), SCRATCH)).length).toBeGreaterThan(0);
      });
    }

    test("elsewhere in the tree the binding is followed by where it came from, not by a type", () => {
      const elsewhere = (code: string) =>
        bucketMutations(
          parse(
            planted(code, "services/news-media-clone.ts"),
            join(SERVICES, "news-media-clone.ts"),
          ),
          { typed: false },
        );
      // Another bucket, typed as one: not the binding, not a finding.
      expect(elsewhere("export const f = (bucket: R2Bucket) => bucket.put('k', 'v');")).toEqual([]);
      // The binding itself, by any route: a finding.
      expect(
        elsewhere("export const f = (env: Bindings) => env.NEUROBAGEL.put('k', 'v');"),
      ).toHaveLength(1);
      expect(
        elsewhere(
          "export async function f(env: Bindings) { const { NEUROBAGEL } = env; await NEUROBAGEL.put('k', 'v'); }",
        ),
      ).toHaveLength(1);
      expect(
        elsewhere("export const f = (env: Bindings) => env['NEUROBAGEL']['delete']('k');"),
      ).toHaveLength(1);
    });

    const CONTROLS: [string, string][] = [
      [
        "a read through the binding",
        "export const f = (env: Bindings) => env.NEUROBAGEL.get('k');",
      ],
      ["a listing", "export const f = (bucket: R2Bucket) => bucket.list();"],
      ["a head", "export const f = (b: R2Bucket) => b['head']('k');"],
      [
        "a put on something that is not the bucket",
        "export const f = (cache: Cache, req: Request) => cache.put(req, new Response('x'));",
      ],
      ["a map's delete", "export const f = (m: Map<string, string>) => m.delete('k');"],
    ];
    for (const [label, code] of CONTROLS) {
      test(`control: ${label} is not a finding`, () => {
        expect(bucketMutations(parse(planted(code), SCRATCH))).toEqual([]);
      });
    }

    test("the mutating methods are the ones R2 has", () => {
      expect([...BUCKET_MUTATORS].sort()).toEqual([
        "createMultipartUpload",
        "delete",
        "put",
        "resumeMultipartUpload",
      ]);
    });
  });
});

describe("no SELECT in the feature names a wildcard", () => {
  test("every statement names its columns, so a column added to a table is not silently read", () => {
    for (const file of featureOf(real)) {
      expect(wildcardSelects(parse(real, file)), rel(file)).toEqual([]);
    }
  });

  test("a SELECT over `*` or `alias.*` is found; COUNT(*) and named columns are not", () => {
    const find = (sql: string) =>
      wildcardSelects(parse(planted(`export const q = \`${sql}\`;`), SCRATCH));
    expect(find("SELECT d.* FROM datasets d")).toHaveLength(1);
    expect(find("SELECT * FROM datasets")).toHaveLength(1);
    expect(find("SELECT DISTINCT * FROM datasets")).toHaveLength(1);
    expect(find("SELECT d.dataset_id, dv.* FROM datasets d JOIN dataset_versions dv")).toHaveLength(
      1,
    );
    // Built from two halves, it is still the same statement.
    expect(
      wildcardSelects(
        parse(planted("export const q = 'SELECT d' + '.* FROM datasets d';"), SCRATCH),
      ),
    ).toHaveLength(1);
    expect(find("SELECT COUNT(*) AS n FROM datasets")).toEqual([]);
    expect(find("SELECT d.dataset_id, d.name FROM datasets d")).toEqual([]);
  });
});

describe("the reserved DOI is read only through the blinded projection", () => {
  // Behavioural twin: neurobagel-writer.test.ts runs an anonymous dataset through the
  // writer and the anonymity-projection suites pin CONCEPT_DOI_SQL itself.
  const RAW = /\bd\.concept_doi\b|\bdatasets\.concept_doi\b/;

  const rawReads = (tree: Tree, file: string): string[] =>
    foldedStrings(parse(tree, file)).filter((s) => RAW.test(s));

  test("no feature SQL names d.concept_doi or datasets.concept_doi, however it is assembled", () => {
    for (const file of featureOf(real)) expect(rawReads(real, file), rel(file)).toEqual([]);
  });

  test("a raw read is found, including one built from two halves", () => {
    const raw = (code: string) => rawReads(planted(code), SCRATCH);
    expect(raw("export const q = 'SELECT d.concept_doi FROM datasets d';")).toHaveLength(1);
    expect(raw("export const q = 'SELECT d.concept' + '_doi FROM datasets d';")).toHaveLength(1);
    expect(raw("export const q = 'SELECT d.dataset_id FROM datasets d';")).toEqual([]);
  });

  test("a statement that selects from datasets names concept_doi only as the projection's alias", () => {
    for (const file of featureOf(real)) {
      const withoutProjection = (s: string) =>
        s.replace(new RegExp(`${HOLE}\\s+AS\\s+concept_doi`, "g"), "");
      for (const sql of foldedStrings(parse(real, file)).filter((s) =>
        /\bFROM\s+datasets\b/i.test(s),
      )) {
        expect(withoutProjection(sql), `${rel(file)}: ${sql.slice(0, 60)}`).not.toMatch(
          /concept_doi/,
        );
      }
    }
  });

  test("the modules that project it import the blinded projection", () => {
    const projecting: string[] = [];
    for (const file of featureOf(real)) {
      const code = codeOf(real, file);
      if (/\$\{CONCEPT_DOI_SQL\}\s+AS\s+concept_doi/.test(code)) {
        projecting.push(rel(file));
        expect(code).toMatch(
          /import\s*\{[^}]*\bCONCEPT_DOI_SQL\b[^}]*\}\s*from\s*"\.\/anonymity\.js"/,
        );
      }
    }
    // And there are such modules: the plan and the writer both read the DOI.
    expect(projecting.sort()).toEqual([
      "services/neurobagel-plan.ts",
      "services/neurobagel-writer.ts",
    ]);
  });
});

describe("nothing in the feature sends mail or dispatches to GitHub", () => {
  // Behavioural twin: neurobagel-hooks.test.ts runs the writer as a dev worker with a
  // live mail key and records everything it speaks to.
  const FORBIDDEN_MODULE =
    /^(services\/(email|broadcast|approval-dispatch|import-failure-issue|notices|publication-orchestrator|central-manifest|doi|doi-metadata|doi-registry|doi-reconcile|datacite|ezid|zenodo|github-auth|github)(\.ts|\/.*)|routes\/(callbacks|webhooks)\/.*)$/;

  /** What a feature, as laid out in `tree`, loads that it must not: with how it got there. */
  function reached(tree: Tree): { forbidden: string[]; unanalyzable: string[]; size: number } {
    const closure = importClosure(tree, featureOf(tree), BOUNDARY);
    return {
      forbidden: [...closure.files]
        .filter((f) => FORBIDDEN_MODULE.test(rel(f)))
        .map((f) => chainTo(closure, f)),
      unanalyzable: closure.unanalyzable.map((u) => `${rel(u.file)}: ${u.text}`),
      size: closure.files.size,
    };
  }

  test("the transitive closure of the feature loads no mail, GitHub-write, registrar or webhook module", () => {
    const result = reached(real);
    expect(result.forbidden).toEqual([]);
    expect(result.unanalyzable).toEqual([]);
    // Not vacuous: the closure is the feature and what it really loads.
    expect(result.size).toBeGreaterThan(25);
    const files = [...importClosure(real, featureOf(real), BOUNDARY).files].map(rel);
    expect(files).toContain("services/anonymity.ts");
    expect(files).toContain("services/s3.ts");
    expect(files).toContain("routes/data.ts");
    // The data plane is a boundary: reached, not entered, so its own reads do not count.
    expect(files).not.toContain("services/github.ts");
  });

  test("no feature module names a mail or dispatch API", () => {
    expect(forbiddenNames(real)).toEqual([]);
  });

  describe("each way of loading one is found", () => {
    const FEATURE_FILE = "services/neurobagel-plan.ts";
    const withExtra = (extra: string) => {
      const original = readFileSync(join(SRC, FEATURE_FILE), "utf8");
      return createTree({ [FEATURE_FILE]: `${original}\n${extra}\n` });
    };
    const IMPORTS: [string, string][] = [
      ["a static import with .js", 'import { sendEmail } from "./email.js";'],
      ["an extensionless static import", 'import { sendEmail } from "./email";'],
      ["a side-effect import", 'import "./email.js";'],
      ["a re-export", 'export { sendEmail } from "./email";'],
      ["a dynamic import", "export const lazy = () => import('./email.js');"],
      ["an extensionless dynamic import", "export const lazy = () => import('./email');"],
      [
        "a dynamic import with the name built from two halves",
        "export const lazy = () => import('./em' + 'ail.js');",
      ],
      ["the GitHub write barrel", 'import { createIssue } from "./github.js";'],
      ["a GitHub submodule", 'import { dispatch } from "./github/dispatch.js";'],
      ["a registrar", 'import { createIdentifier } from "./ezid.js";'],
      ["the approval dispatcher", 'import "./approval-dispatch.js";'],
      [
        "the publication orchestrator, which itself loads mail (a TRANSITIVE import)",
        'import { runPublicationApproval } from "./publication-orchestrator.js";',
      ],
      ["a webhook route", 'import "../routes/callbacks/manifest.js";'],
    ];
    for (const [label, code] of IMPORTS) {
      test(label, () => {
        expect(reached(withExtra(code)).forbidden.length, label).toBeGreaterThan(0);
      });
    }

    test("a transitive import names the chain that led to it", () => {
      const tree = withExtra(
        'import { runPublicationApproval } from "./publication-orchestrator.js";',
      );
      const chain = reached(tree).forbidden.find((c) => c.includes("publication-orchestrator"));
      expect(chain).toContain("neurobagel-plan.ts -> services/publication-orchestrator.ts");
    });

    test("a module name that is computed cannot be read, and is a finding", () => {
      expect(
        reached(withExtra("export const lazy = (n: string) => import(`./${n}.js`);")).unanalyzable
          .length,
      ).toBeGreaterThan(0);
      expect(
        reached(withExtra("export const r = (n: string) => require(n);")).unanalyzable.length,
      ).toBeGreaterThan(0);
    });

    test("a name split in two halves is still the name", () => {
      expect(
        forbiddenNames(withExtra("export const e = 'repository' + '_dispatch';")),
      ).toHaveLength(1);
      expect(
        forbiddenNames(withExtra("export const u = 'https://api.' + 'github.com/x';")),
      ).toHaveLength(1);
      expect(forbiddenNames(withExtra("export const f = () => sendEmail;"))).toHaveLength(1);
    });

    test("controls: a type-only import and a harmless one are not edges, and a name in a comment is not code", () => {
      const clean = reached(
        withExtra(
          [
            'import type { Foo } from "./email.js";',
            'import { type Bar } from "./email.js";',
            'import { utcDay } from "./neurobagel-plan.js";',
            "// sendEmail and repository_dispatch, in a comment",
          ].join("\n"),
        ),
      );
      expect(clean.forbidden).toEqual([]);
      expect(forbiddenNames(withExtra("// sendEmail, repository_dispatch"))).toEqual([]);
    });
  });

  test("the resolver reads extensionless, .js and index forms, and ignores packages and JSON", () => {
    const from = join(SERVICES, "neurobagel-plan.ts");
    expect(resolveImport(real, from, "./email")).toBe(join(SERVICES, "email.ts"));
    expect(resolveImport(real, from, "./email.js")).toBe(join(SERVICES, "email.ts"));
    expect(resolveImport(real, from, "./github.js")).toBe(join(SERVICES, "github.ts"));
    expect(resolveImport(real, from, "zod")).toBeNull();
    expect(resolveImport(real, from, "./nope.js")).toBeNull();
    const kinds = scanImports(parse(real, join(SERVICES, "neurobagel-curation.ts"))).specifiers;
    // The lazy imports of the curation loader are dynamic and literal: read, not guessed.
    expect(kinds.filter((k) => k.kind === "dynamic").length).toBeGreaterThanOrEqual(1);
  });

  test("an anonymity-class finding is written to the audit log and nowhere else", () => {
    expect(codeOf(real, join(SERVICES, "neurobagel-plan.ts"))).toMatch(/auditLogStatement/);
    // The dataset_anonymity mail category is the other channel ADR 0067 names; not used here.
    for (const file of featureOf(real)) {
      expect(codeOf(real, file), rel(file)).not.toMatch(/dataset_anonymity/);
    }
  });
});

describe("the verification sweep reports and never repairs", () => {
  // Behavioural twin: neurobagel-verify.test.ts runs the sweep against a store holding residue
  // and a missing dataset and shows the bucket, the catalog and every request unchanged except
  // for the heartbeat. The scans here prove the absences a run cannot: no second kind of write.
  const SWEEP_MODULES = [VERIFY, DRIFT];
  const SQL_WRITE = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|REPLACE|CREATE)\b/;
  const WRITE_METHODS = /^(PUT|PATCH|DELETE)$/;

  /** Strings of a module that are, or contain, a SQL write statement. */
  const sqlWrites = (tree: Tree, file: string): string[] =>
    foldedStrings(parse(tree, file)).filter((str) => SQL_WRITE.test(str.replaceAll(HOLE, "")));

  /**
   * Every `fetch(...)` call of a module: the option keys, and the string-literal value of each
   * key that has one. `<not a literal>` is a call whose options cannot be read, `<spread>` a key
   * that cannot be named; either one fails every shape below.
   */
  interface FetchCall {
    keys: string[];
    literal: Record<string, string>;
  }
  function fetchCalls(tree: Tree, file: string): FetchCall[] {
    const out: FetchCall[] = [];
    const visit = (n: ts.Node): void => {
      if (
        ts.isCallExpression(n) &&
        ts.isIdentifier(n.expression) &&
        n.expression.text === "fetch"
      ) {
        const options = n.arguments[1];
        if (options === undefined) out.push({ keys: [], literal: {} });
        else if (!ts.isObjectLiteralExpression(options)) {
          out.push({ keys: ["<not a literal>"], literal: {} });
        } else {
          const call: FetchCall = { keys: [], literal: {} };
          for (const p of options.properties) {
            if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) {
              const key = p.name.getText();
              call.keys.push(key);
              if (ts.isPropertyAssignment(p) && ts.isStringLiteralLike(p.initializer)) {
                call.literal[key] = p.initializer.text;
              }
            } else call.keys.push("<spread>");
          }
          out.push(call);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(parse(tree, file));
    return out;
  }
  const sameKeys = (a: string[], b: string[]) => [...a].sort().join() === [...b].sort().join();
  /** A plain read: headers, a signal, and a redirect that is NOT followed. No method, no body. */
  const isPlainRead = (c: FetchCall) =>
    sameKeys(c.keys, ["headers", "redirect", "signal"]) && c.literal.redirect === "manual";
  /** The one question put to the node: a fixed method, a fixed body, no redirect followed. */
  const isDatasetsQuery = (c: FetchCall) =>
    sameKeys(c.keys, ["method", "headers", "body", "redirect", "signal"]) &&
    c.literal.method === "POST" &&
    c.literal.body === "{}" &&
    c.literal.redirect === "manual";

  /** String literals of a module that say what KIND of dataset something concerns. */
  const KIND = /anonym|deposit|\bclass\b/i;
  const kindStrings = (tree: Tree, file: string): string[] =>
    foldedStrings(parse(tree, file))
      .map((str) => str.replaceAll(HOLE, ""))
      .filter((str) => KIND.test(str));

  test("the sweep modules write no SQL: every statement they hold is a read", () => {
    for (const file of SWEEP_MODULES) expect(sqlWrites(real, file), rel(file)).toEqual([]);
  });

  test("a write statement is found, including one built from two halves; a read is not", () => {
    const found = (code: string) => sqlWrites(planted(code), SCRATCH);
    expect(found("export const q = 'UPDATE datasets SET anonymous = 0';")).toHaveLength(1);
    expect(found("export const q = 'DEL' + 'ETE FROM audit_log';")).toHaveLength(1);
    expect(found("export const q = `INSERT INTO audit_log VALUES (1)`;")).toHaveLength(1);
    expect(
      found("export const q = 'SELECT dataset_id FROM datasets WHERE anonymous IS NOT 0';"),
    ).toEqual([]);
  });

  test("the only write a sweep module makes to D1 goes through the audit helper", () => {
    // The helper is the one shape every audit row converges on (db/audit-log.ts); a sweep that
    // wrote the catalog directly would need a SQL string, which the scan above would find.
    expect(codeOf(real, VERIFY)).toMatch(/auditLogStatement/);
    expect(codeOf(real, DRIFT)).not.toMatch(/\.run\(|\.exec\(|\.batch\(/);
  });

  test("neither module names a write method of HTTP", () => {
    for (const file of SWEEP_MODULES) {
      const strings = foldedStrings(parse(real, file)).map((str) => str.replaceAll(HOLE, ""));
      expect(
        strings.filter((str) => WRITE_METHODS.test(str)),
        rel(file),
      ).toEqual([]);
    }
  });

  describe("the upstream drift reader", () => {
    test("every fetch is a plain read: no method, no body, no credential, and no redirect is followed", () => {
      const calls = fetchCalls(real, DRIFT);
      // Not vacuous: it does fetch.
      expect(calls.length).toBeGreaterThanOrEqual(1);
      for (const call of calls) expect(isPlainRead(call), call.keys.join(",")).toBe(true);
      expect(codeOf(real, DRIFT)).not.toMatch(/authorization|cookie|bearer|token|secret|password/i);
    });

    test("a fetch with a method, a body, a spread, a followed redirect or none declared is found", () => {
      const bad = (code: string) =>
        fetchCalls(planted(code), SCRATCH).filter((call) => !isPlainRead(call));
      expect(bad("export const f = () => fetch('x', { method: 'POST' });")).toHaveLength(1);
      expect(
        bad("export const f = () => fetch('x', { body: 'b', signal: s, redirect: 'manual' });"),
      ).toHaveLength(1);
      expect(bad("export const f = (o: RequestInit) => fetch('x', o);")).toHaveLength(1);
      expect(bad("export const f = (o: RequestInit) => fetch('x', { ...o });")).toHaveLength(1);
      expect(bad("export const f = () => fetch('x', { headers: {}, signal: s });")).toHaveLength(1);
      expect(
        bad("export const f = () => fetch('x', { headers: {}, signal: s, redirect: 'follow' });"),
      ).toHaveLength(1);
      expect(bad("export const f = () => fetch('x');")).toHaveLength(1);
      expect(
        bad("export const f = () => fetch('x', { headers: {}, signal: s, redirect: 'manual' });"),
      ).toEqual([]);
    });

    test("it is the only module that names the public GitHub API host, and a copy elsewhere is found", () => {
      const holders = featureOf(real).filter((f) =>
        foldedStrings(parse(real, f)).some((str) => PUBLIC_API_HOST.test(str)),
      );
      expect(holders.map(rel)).toEqual(["services/neurobagel-drift.ts"]);
      const planted2 = createTree({
        "services/neurobagel-plan.ts": `${readFileSync(join(SERVICES, "neurobagel-plan.ts"), "utf8")}\nexport const h = "https://api.github.com/x";`,
      });
      expect(forbiddenNames(planted2)).toHaveLength(1);
    }, 60_000);
  });

  describe("the node probe and the registration reads", () => {
    test("the verification module makes exactly two kinds of request: a plain read, and the one datasets query", () => {
      const calls = fetchCalls(real, VERIFY);
      expect(calls).toHaveLength(2);
      expect(calls.filter(isPlainRead)).toHaveLength(1);
      expect(calls.filter(isDatasetsQuery)).toHaveLength(1);
      expect(codeOf(real, VERIFY)).not.toMatch(/authorization|cookie|bearer|credentials/i);
    });

    test("a different method, a different body, a body that is not fixed, or a followed redirect is found", () => {
      const notDatasetsQuery = (options: string) =>
        fetchCalls(planted(`export const f = () => fetch('x', ${options});`), SCRATCH).filter(
          (c) => !isDatasetsQuery(c),
        );
      const good = "{ method: 'POST', headers: {}, body: '{}', redirect: 'manual', signal: s }";
      expect(notDatasetsQuery(good)).toEqual([]);
      expect(notDatasetsQuery(good.replace("'POST'", "'PUT'"))).toHaveLength(1);
      expect(notDatasetsQuery(good.replace("'{}'", "JSON.stringify(q)"))).toHaveLength(1);
      expect(notDatasetsQuery(good.replace("'{}'", "'{\"x\":1}'"))).toHaveLength(1);
      expect(notDatasetsQuery(good.replace("'manual'", "'follow'"))).toHaveLength(1);
      expect(notDatasetsQuery(good.replace(", redirect: 'manual'", ""))).toHaveLength(1);
      expect(
        notDatasetsQuery(good.replace("headers: {}, ", "headers: {}, credentials: 'include', ")),
      ).toHaveLength(1);
    });
  });

  describe("what a reason may say", () => {
    // Behavioural twin: neurobagel-verify.test.ts collects every reason a sweep produced across
    // its scenarios. A reason can reach the weekly report, which is filed on a public-facing
    // repository, so it may say a record is wrong and never that it belongs to a concealed
    // deposit: the audit log says that, and only the audit log.
    const ALLOWED_IN_VERIFY = new Set([
      // The audit action and the check code of the one finding that goes to the audit log, and
      // the query that finds the rows it concerns. None of them is a reason.
      "neurobagel_verify_anonymity_finding",
      "node_serves_anonymous_record",
      "SELECT dataset_id FROM datasets WHERE anonymous IS NOT 0",
    ]);
    const WEEKLY_TEXT = [
      join(SRC, "../../shared/contract/weekly-attention.ts"),
      join(SERVICES, "import-weekly-summary.ts"),
    ];

    test("no string of the sweep modules says what kind of dataset a finding concerns, but the three that are not reasons", () => {
      expect(kindStrings(real, DRIFT)).toEqual([]);
      expect(kindStrings(real, VERIFY).filter((str) => !ALLOWED_IN_VERIFY.has(str))).toEqual([]);
      // Not vacuous: the three allowed strings are really there.
      expect(new Set(kindStrings(real, VERIFY))).toEqual(ALLOWED_IN_VERIFY);
    });

    test("no string the weekly report renders, or decides its headline from, says it", () => {
      for (const file of WEEKLY_TEXT) expect(kindStrings(real, file), file).toEqual([]);
    });

    test("a string that says it is found, however it is built; one that does not is not", () => {
      const found = (code: string) => kindStrings(planted(code), SCRATCH);
      expect(found("export const r = '1 anonymity-class finding';")).toHaveLength(1);
      expect(found("export const r = 'a deposit ' + 'in the store';")).toHaveLength(1);
      expect(found("export const r = `${n} record(s) of the Class`;")).toHaveLength(1);
      expect(found("export const r = '3 record(s) are not protected';")).toEqual([]);
      expect(found("export const r = 'subclass of nothing';")).toEqual([]);
    });
  });
});

describe("the hooks", () => {
  const SITES: Record<string, number> = {
    "services/publication-orchestrator.ts": 2,
    "routes/callbacks/manifest.ts": 1,
    "routes/callbacks/version-doi.ts": 1,
    "routes/callbacks/import-state.ts": 1,
  };

  interface HookCall {
    file: string;
    line: number;
    statement: boolean;
    args: string[];
  }

  /** Every call of `scheduleNeurobagelSync` in a file, and whether it stands alone as a statement. */
  function hookCalls(tree: Tree, file: string): HookCall[] {
    const sf = parse(tree, file);
    const out: HookCall[] = [];
    const visit = (n: ts.Node): void => {
      if (
        ts.isCallExpression(n) &&
        ((ts.isIdentifier(n.expression) && n.expression.text === "scheduleNeurobagelSync") ||
          (ts.isPropertyAccessExpression(n.expression) &&
            n.expression.name.text === "scheduleNeurobagelSync"))
      ) {
        out.push({
          file: rel(file),
          line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
          // Not awaited, returned, assigned, passed on or chained: the statement IS the call.
          statement: ts.isExpressionStatement(n.parent),
          args: n.arguments.map((a) => a.getText(sf)),
        });
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return out;
  }

  const allCalls = (tree: Tree) =>
    tree.walk(SRC).flatMap((f) => (f === HOOKS ? [] : hookCalls(tree, f)));

  test("exactly these files call the hook, this many times (the one reachable legacy version path included)", () => {
    const found: Record<string, number> = {};
    for (const c of allCalls(real)) found[c.file] = (found[c.file] ?? 0) + 1;
    expect(found).toEqual(SITES);
  });

  test("it is never awaited, returned, assigned or chained: the flow cannot depend on it", () => {
    for (const c of allCalls(real)) expect(c.statement, `${c.file}:${c.line}`).toBe(true);
  });

  test("each way of depending on it is found", () => {
    const scratch = join(SRC, "routes/callbacks/scratch.ts");
    const callOf = (code: string) =>
      hookCalls(planted(code, "routes/callbacks/scratch.ts"), scratch);
    const a = "scheduleNeurobagelSync(a, b, c, 'd')";
    expect(callOf(`async function f() { await ${a}; }`)[0]?.statement).toBe(false);
    expect(callOf(`function f() { return ${a}; }`)[0]?.statement).toBe(false);
    expect(callOf(`function f() { const x = ${a}; }`)[0]?.statement).toBe(false);
    expect(callOf(`function f() { return Promise.all([${a}]); }`)[0]?.statement).toBe(false);
    expect(callOf(`function f() { ${a}.catch(() => {}); }`)[0]?.statement).toBe(false);
    expect(callOf(`function f() { ${a}; }`)[0]?.statement).toBe(true);
    expect(callOf(`function f() { hooks.${a}; }`)[0]?.statement).toBe(true);
  });

  test("every call site hands it the flow's own waitUntil and a stable trigger name", () => {
    for (const c of allCalls(real)) {
      expect(c.args[1], `${c.file}:${c.line}`).toMatch(/waitUntil/);
      expect(c.args[3], `${c.file}:${c.line}`).toMatch(/^"hook:(publication|version|import)"$/);
    }
  });

  test("the version hooks follow the metadata refresh they depend on (they read what it writes)", () => {
    for (const file of ["routes/callbacks/manifest.ts", "routes/callbacks/version-doi.ts"]) {
      const calls = hookCalls(real, join(SRC, file));
      expect(calls.length, file).toBeGreaterThan(0);
      for (const c of calls) expect(c.args[4], file).toMatch(/after:\s*refreshed/);
    }
  });

  test("the hook module runs the work inside waitUntil and catches everything", () => {
    const hooks = codeOf(real, HOOKS);
    const fn = hooks.slice(hooks.indexOf("export function scheduleNeurobagelSync"));
    expect(fn).toMatch(/waitUntil\(work\)/);
    expect(fn).toMatch(/\.catch\(/);
    expect(fn).toMatch(/try\s*\{/);
    expect(fn).toMatch(/catch\s*\(err\)/);
  });
});

describe("the read route", () => {
  const route = codeOf(real, join(SRC, "routes/neurobagel.ts"));

  test("compares the token in constant time, from the shared helper", () => {
    expect(route).toMatch(
      /import\s*\{\s*timingSafeEqual\s*\}\s*from\s*"\.\.\/lib\/constant-time\.js"/,
    );
    expect(route).toMatch(/timingSafeEqual\(/);
    expect(route).not.toMatch(/===\s*token\b|\btoken\s*===|!==\s*token\b|\btoken\s*!==/);
    expect(route).not.toMatch(/NEUROBAGEL_READ_TOKEN[^\n]*(===|!==)/);
  });

  test("never lists the bucket, and only reads from it", () => {
    expect(route).not.toMatch(/\.list\s*\(/);
    expect(route).not.toMatch(/\.(put|delete|head)\s*\(/);
    expect(route).toMatch(/\.get\(/);
  });

  test("answers only GET (a route handler for any other method is a new surface)", () => {
    expect(route).not.toMatch(/neurobagelRoutes\.(post|put|patch|delete|all)\s*\(/);
  });

  test("re-checks eligibility on the artifact path and filters the index through the same check", () => {
    expect(route).toMatch(/loadEligibleRow\(/);
    expect(route).toMatch(/eligibleAmong\(/);
  });
});

describe("the committed configuration is OFF", () => {
  const text = readFileSync(join(import.meta.dir, "../wrangler-sccn.toml"), "utf8");
  const config = Bun.TOML.parse(text) as {
    vars?: Record<string, unknown>;
    r2_buckets?: { binding: string; bucket_name: string }[];
    triggers?: { crons: string[] };
    env?: {
      dev?: {
        vars?: Record<string, unknown>;
        r2_buckets?: { binding: string; bucket_name: string }[];
        triggers?: { crons: string[] };
      };
    };
  };

  test("no environment sets the writer's switch, and no secret is committed", () => {
    expect(config.vars?.NEUROBAGEL_WRITER_ENABLED).toBeUndefined();
    expect(config.env?.dev?.vars?.NEUROBAGEL_WRITER_ENABLED).toBeUndefined();
    for (const name of ["NEUROBAGEL_READ_TOKEN"]) {
      expect(config.vars?.[name]).toBeUndefined();
      expect(config.env?.dev?.vars?.[name]).toBeUndefined();
      expect(text).not.toMatch(new RegExp(`^\\s*${name}\\s*=`, "m"));
    }
    expect(text).not.toMatch(/^\s*NEUROBAGEL_WRITER_ENABLED\s*=/m);
  });

  test("each environment has its own private bucket under one binding name", () => {
    const prod = config.r2_buckets?.find((b) => b.binding === "NEUROBAGEL");
    const dev = config.env?.dev?.r2_buckets?.find((b) => b.binding === "NEUROBAGEL");
    expect(prod?.bucket_name).toBe("nemar-neurobagel");
    expect(dev?.bucket_name).toBe("nemar-neurobagel-dev");
    expect(prod?.bucket_name).not.toBe(dev?.bucket_name);
  });

  test("the dev worker's cron is unchanged and the reconcile is not on the dev allowlist", () => {
    expect(config.env?.dev?.triggers?.crons).toEqual(["0 4 * * *"]);
    expect([...DEV_CRON_ALLOWLIST].some((n) => /neurobagel/i.test(n))).toBe(false);
    expect([...DEV_CRON_ALLOWLIST]).toEqual([
      "publishZarrCatalog",
      "runZarrFidelitySweep",
      "fetchAndSyncDataPapers",
      "purgeExpiredTickets",
    ]);
  });

  test("the cron call sits in the production-only block, inside waitUntil, with a catch", () => {
    const index = readFileSync(join(SRC, "index.ts"), "utf8");
    const start = index.indexOf("if (prodOnlyJobs) {");
    const reconcile = index.indexOf("runNeurobagelReconcileCron(env,");
    const nonProdTail = index.indexOf("fetchAndSyncCitationCounts(env.DB)");
    expect(start).toBeGreaterThan(-1);
    expect(reconcile).toBeGreaterThan(start);
    expect(reconcile).toBeLessThan(nonProdTail);
    expect(index.slice(reconcile - 40, reconcile)).toMatch(/ctx\.waitUntil\(\s*$/);
    expect(index.slice(reconcile, reconcile + 1800)).toContain(".catch(");
  });

  test("the verification sweep's cron call is production-only, inside waitUntil, with a catch, and the raw sweep is never called there", () => {
    // Epic #1586 phase 6. A new daily job is production-only by default (AGENTS.md); this one
    // sends no mail and dispatches nothing, so the fence is the rule and not a necessity.
    const index = readFileSync(join(SRC, "index.ts"), "utf8");
    const start = index.indexOf("if (prodOnlyJobs) {");
    const call = index.indexOf("runNeurobagelVerificationSweepCron(env)");
    const nonProdTail = index.indexOf("fetchAndSyncCitationCounts(env.DB)");
    expect(start).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(start);
    expect(call).toBeLessThan(nonProdTail);
    expect(index.slice(call - 40, call)).toMatch(/ctx\.waitUntil\(\s*$/);
    expect(index.slice(call, call + 1200)).toContain(".catch(");
    // Called once, and only the wrapper: the raw sweep has no environment fence of its own.
    expect(index.split("runNeurobagelVerificationSweepCron(env)").length - 1).toBe(1);
    expect(index).not.toMatch(/\brunNeurobagelVerificationSweep\(/);
  });

  test("no verification name is on the dev allowlist, and the committed configuration sets neither probe address", () => {
    expect([...DEV_CRON_ALLOWLIST].some((n) => /verif/i.test(n))).toBe(false);
    for (const name of ["NEUROBAGEL_NODE_URL", "NEUROBAGEL_FEDERATION_URL"]) {
      expect(config.vars?.[name], name).toBeUndefined();
      expect(config.env?.dev?.vars?.[name], name).toBeUndefined();
      expect(text).not.toMatch(new RegExp(`^\\s*${name}\\s*=`, "m"));
    }
  });
});
