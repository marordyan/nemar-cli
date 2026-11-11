/**
 * The callers of the OpenID Connect cascade, held to the list the module documents (epic #2014 phase
 * #2019; ADR 0119 rule 12).
 *
 * The rule is the one `services/docs-auth.ts` and `services/private-auth.ts` state for their own
 * statements: every path that ends a credential runs the cascade, and the count in the docblock is
 * LOAD-BEARING, because the next person to add a path reads it to learn whether theirs is one more.
 * A count nobody checks decays the first time someone adds a call and not a line of prose, so this
 * test reads the syntax tree (`helpers/oidc-end-scan.ts`: a call in a comment is not a call, and a call by
 * another spelling is still one) and fails when the code and the documented list differ in either
 * direction:
 *
 *   - a call to `oidcEndStatements` or `oidcClientEndStatements` that is not on the list, however it is
 *     reached (an aliased import, a local alias chain, a namespace, a destructured namespace), and a
 *     listed one that is no longer there (so removing the statement from a caller fails here as well as
 *     in the behavioural suites);
 *   - any OTHER use outside the module, each a "stray" the list cannot describe: the function passed or
 *     stored as a value, an alias EXPORTED where it is declared (another file could call it), a raw
 *     `*_SQL` constant of the cascade run on its own, a dynamic import, a re-export, a default import, an
 *     element access on the namespace, a module-level reference;
 *   - a docblock whose spelled count is not the number of listed callers;
 *   - a deliberate non-path (a role demotion, a key revocation, the app session's sign-out) that has
 *     lost the sentence saying it is deliberate, which is how the next reader learns not to "fix" it;
 *   - a scan that stopped seeing: each way of reaching the cascade is also run on a planted file, so the
 *     scan is shown to fire and not only to stay quiet.
 *
 * What the scan does NOT promise: it names what an identifier is called, not what it means, and it reads
 * `backend/src` only. A file outside it that imports the module is out of reach, which is why nothing
 * else imports the module from the Worker's source, and why the planted cases are the proof. A call that
 * is present but never executed, or whose result is discarded, passes this scan; the behavioural suites
 * prove each path runs its statements.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OIDC_CLIENT_END_CALLERS, OIDC_END_CALLERS } from "../src/services/oidc-cascade";
import { type EndCall, scanEndUsers } from "./helpers/oidc-end-scan";
import { SRC, createTree } from "./helpers/ts-scan";

const CASCADE = join(SRC, "services/oidc-cascade.ts");

const order = (a: { file: string; site: string }, b: { file: string; site: string }) =>
  `${a.file} ${a.site}`.localeCompare(`${b.file} ${b.site}`);

/** The calls of one function, as the file and the function they are in. */
const callsOf = (calls: EndCall[], name: string) =>
  calls
    .filter((c) => c.name === name)
    .map((c) => ({ file: c.file, site: c.site }))
    .sort(order);

const listed = (callers: ReadonlyArray<{ file: string; site: string }>) =>
  callers.map((c) => ({ file: c.file, site: c.site })).sort(order);

const WORDS: Record<string, number> = {
  ONE: 1,
  TWO: 2,
  THREE: 3,
  FOUR: 4,
  FIVE: 5,
  SIX: 6,
  SEVEN: 7,
  EIGHT: 8,
  NINE: 9,
  TEN: 10,
};

/** The caller count a constant's docblock spells (`SIX CALLERS`), or null when it spells none. */
function docblockCount(source: string, constant: string): number | null {
  const at = source.indexOf(`export const ${constant}`);
  if (at < 0) throw new Error(`${constant} is not exported`);
  const close = source.lastIndexOf("*/", at);
  const open = source.lastIndexOf("/**", close);
  const m = /\b(ONE|TWO|THREE|FOUR|FIVE|SIX|SEVEN|EIGHT|NINE|TEN) CALLERS?\b/.exec(
    source.slice(open, close),
  );
  return m ? (WORDS[m[1] as string] as number) : null;
}

describe("the callers of oidcEndStatements", () => {
  const real = scanEndUsers(createTree());

  test("the code calls it from exactly the places the module lists", () => {
    expect(callsOf(real.calls, "oidcEndStatements")).toEqual(listed(OIDC_END_CALLERS));
  });

  test("the client's own cascade has exactly its one caller", () => {
    expect(callsOf(real.calls, "oidcClientEndStatements")).toEqual(listed(OIDC_CLIENT_END_CALLERS));
  });

  test("nothing else outside the module uses the cascade: no value, no raw statement, no import the scan cannot follow", () => {
    expect(real.strays).toEqual([]);
  });

  test("no path of the list is a deliberate non-path: demotion, key revocation, sign-out", () => {
    const files = new Set(OIDC_END_CALLERS.map((c) => c.file));
    for (const file of ["routes/auth-keys.ts", "routes/auth-web.ts", "services/docs-auth.ts"]) {
      expect(files.has(file)).toBe(false);
    }
    expect(OIDC_END_CALLERS.some((c) => c.site === "revokeDocsCredentials")).toBe(false);
  });

  test("every SQL constant's docblock spells the number of callers it lists", () => {
    const source = readFileSync(CASCADE, "utf8");
    for (const constant of [
      "OIDC_ENQUEUE_LOGOUTS_SQL",
      "OIDC_END_TOKENS_SQL",
      "OIDC_END_GRANTS_SQL",
      "OIDC_END_CODES_SQL",
    ]) {
      expect({ constant, count: docblockCount(source, constant) }).toEqual({
        constant,
        count: OIDC_END_CALLERS.length,
      });
    }
    for (const constant of [
      "OIDC_CLIENT_END_TOKENS_SQL",
      "OIDC_CLIENT_END_GRANTS_SQL",
      "OIDC_CLIENT_END_CODES_SQL",
    ]) {
      expect({ constant, count: docblockCount(source, constant) }).toEqual({
        constant,
        count: OIDC_CLIENT_END_CALLERS.length,
      });
    }
  });

  test("each listed caller names a function that exists in its file", () => {
    for (const c of [...OIDC_END_CALLERS, ...OIDC_CLIENT_END_CALLERS]) {
      expect(readFileSync(join(SRC, c.file), "utf8")).toContain(c.site);
    }
  });
});

describe("the scan fires on a planted violation", () => {
  /** Scan the real tree with one planted file laid over it. */
  const plant = (source: string) => scanEndUsers(createTree({ "routes/planted.ts": source }));
  const IMPORT = 'import { oidcEndStatements } from "../services/oidc-cascade";\n';
  const NAMESPACE = 'import * as ns from "../services/oidc-cascade";\n';

  /** A planted call, as the scan reports it. */
  const calledFrom = (scan: ReturnType<typeof scanEndUsers>, site: string) =>
    scan.calls.some((c) => c.file === "routes/planted.ts" && c.site === site);
  const planted = (scan: ReturnType<typeof scanEndUsers>) =>
    scan.strays.filter((x) => x.startsWith("routes/planted.ts"));

  test("a new caller that is not on the list is found, and so the list differs", () => {
    const scan = plant(`${IMPORT}export async function aNewPath(userId: number) {
  return oidcEndStatements(userId, "account_revoked");
}`);
    expect(calledFrom(scan, "aNewPath")).toBe(true);
    expect(callsOf(scan.calls, "oidcEndStatements")).not.toEqual(listed(OIDC_END_CALLERS));
    expect(planted(scan)).toEqual([]);
  }, 60_000);

  test("an aliased import is still the cascade", () => {
    const scan = plant(`import { oidcEndStatements as endThem } from "../services/oidc-cascade";
export function viaAlias(userId: number) {
  return endThem(userId, "account_revoked");
}`);
    expect(scan.calls).toContainEqual({
      file: "routes/planted.ts",
      site: "viaAlias",
      name: "oidcEndStatements",
    });
  }, 60_000);

  test("a local alias chain, an assignment and a cast are followed to the call", () => {
    const scan = plant(`${IMPORT}const first = oidcEndStatements;
const second = (first as typeof oidcEndStatements)!;
let third: typeof oidcEndStatements;
third = second;
export function viaChain(userId: number) {
  return third(userId, "account_revoked");
}`);
    expect(calledFrom(scan, "viaChain")).toBe(true);
    expect(planted(scan)).toEqual([]);
  }, 60_000);

  test("a call through a namespace, and through a destructured namespace, is still a call", () => {
    const scan = plant(`${NAMESPACE}export function viaNamespace(userId: number) {
  return ns.oidcEndStatements(userId, "account_revoked");
}
const { oidcClientEndStatements: clientEnd } = ns;
export function viaDestructuring(id: string) {
  return clientEnd(id);
}`);
    expect(scan.calls).toContainEqual({
      file: "routes/planted.ts",
      site: "viaNamespace",
      name: "oidcEndStatements",
    });
    expect(scan.calls).toContainEqual({
      file: "routes/planted.ts",
      site: "viaDestructuring",
      name: "oidcClientEndStatements",
    });
    expect(planted(scan)).toEqual([]);
  }, 60_000);

  test("the function passed or stored as a value is a stray", () => {
    for (const body of [
      "export const all = [1, 2].map(oidcEndStatements);",
      "export const holder = { oidcEndStatements };",
      "export const holder = { run: oidcEndStatements };",
      "export function pass(use: (f: unknown) => void) { use(oidcEndStatements); }",
      "export { oidcEndStatements as sneaky };",
    ]) {
      const strays = planted(plant(`${IMPORT}${body}`));
      expect(strays.length, body).toBeGreaterThan(0);
      expect(strays.join("\n"), body).toContain("used as a value");
    }
  }, 60_000);

  test("an alias exported where it is declared is a stray: a caller in another file would hide behind it", () => {
    // `export const endIt = oidcEndStatements;` makes no call and passes no value, so the scan saw nothing,
    // and `import { endIt } from "./planted"` in another file called the cascade without being listed.
    const FORMS: Array<[string, string]> = [
      ["export const", `${IMPORT}export const endIt = oidcEndStatements;`],
      ["export let", `${IMPORT}export let endIt = oidcEndStatements;`],
      ["export var", `${IMPORT}export var endIt = oidcEndStatements;`],
      [
        "the client's function",
        'import { oidcClientEndStatements } from "../services/oidc-cascade";\nexport const endIt = oidcClientEndStatements;',
      ],
      ["a cast", `${IMPORT}export const endIt = oidcEndStatements as unknown as () => void;`],
      ["a non-null assertion", `${IMPORT}export const endIt = oidcEndStatements!;`],
      [
        "an aliased import",
        'import { oidcEndStatements as e } from "../services/oidc-cascade";\nexport const endIt = e;',
      ],
      ["an alias chain", `${IMPORT}const first = oidcEndStatements;\nexport const endIt = first;`],
      ["a namespace member", `${NAMESPACE}export const endIt = ns.oidcEndStatements;`],
      ["a destructured namespace", `${NAMESPACE}export const { oidcEndStatements: endIt } = ns;`],
      [
        "a renamed destructured namespace member among others",
        `${NAMESPACE}export const { OIDC_END_CALLERS: lists, oidcClientEndStatements: endIt } = ns;`,
      ],
      ["one of several declarators", `${IMPORT}export const other = 1, endIt = oidcEndStatements;`],
      [
        "a later assignment to an exported let",
        `${IMPORT}export let endIt: typeof oidcEndStatements;\nendIt = oidcEndStatements;`,
      ],
    ];
    for (const [label, source] of FORMS) {
      const strays = planted(plant(source));
      // Reported once, however many rounds the alias pass takes to settle.
      expect(strays.length, `${label}: ${strays.join(" | ")}`).toBe(1);
      expect(strays.join("\n"), label).toContain("exported alias");
    }
  }, 60_000);

  test("an alias exported afterwards, as the default, or by an import-equals, is a stray as well", () => {
    for (const body of [
      `${IMPORT}const f = oidcEndStatements;\nexport { f };`,
      `${IMPORT}const f = oidcEndStatements;\nexport { f as g };`,
      `${IMPORT}export default oidcEndStatements;`,
      `${IMPORT}const f = oidcEndStatements;\nexport default f;`,
      `${NAMESPACE}export import endIt = ns.oidcEndStatements;`,
    ]) {
      expect(planted(plant(body)).length, body).toBeGreaterThan(0);
    }
  }, 60_000);

  test("an export that is not an alias of the cascade is not a stray, and neither is an alias that stays in its file", () => {
    const scan = plant(`${IMPORT}declare const somethingElse: () => void;
export const endIt = somethingElse;
export const value = 1, holder = { a: 2 };
export let counter: number;
counter = 3;
const local = oidcEndStatements;
export function viaLocal(userId: number) {
  return local(userId, "account_revoked");
}`);
    expect(planted(scan)).toEqual([]);
    expect(calledFrom(scan, "viaLocal")).toBe(true);
  }, 60_000);

  test("a raw statement of the cascade is a stray, imported by its name or through the namespace", () => {
    for (const source of [
      'import { OIDC_END_GRANTS_SQL } from "../services/oidc-cascade";\nexport const sql = OIDC_END_GRANTS_SQL;',
      'import { OIDC_ENQUEUE_LOGOUTS_SQL as q } from "../services/oidc-cascade";\nexport const sql = q;',
      `${NAMESPACE}export const sql = ns.OIDC_END_TOKENS_SQL;`,
      'import { OIDC_CLIENT_END_CODES_SQL } from "../services/oidc-cascade";\nexport function run(db: D1Database) { return db.prepare(OIDC_CLIENT_END_CODES_SQL); }',
    ]) {
      const strays = planted(plant(source));
      expect(strays.length, source).toBeGreaterThan(0);
      expect(strays.join("\n"), source).toContain("raw statement of the cascade");
    }
  }, 60_000);

  test("the namespace used as a value, by element access, or spread, is a stray", () => {
    for (const body of [
      "export const everything = ns;",
      'export function byName() { return ns["oidcEndStatements"](1, "account_revoked"); }',
      "export const copy = { ...ns };",
      "const { ...rest } = ns; export const r = rest;",
    ]) {
      const strays = planted(plant(`${NAMESPACE}${body}`));
      expect(strays.length, body).toBeGreaterThan(0);
    }
  }, 60_000);

  test("a dynamic import or require of the module is a stray, literal or not", () => {
    for (const body of [
      'export async function lazy() { const m = await import("../services/oidc-cascade"); return m; }',
      'export async function lazy() { const m = await import("../services/oidc-cascade.js"); return m; }',
      "export async function lazy(name: string) { return import(name); }",
      'export async function lazy(part: string) { return import("../services/" + part); }',
    ]) {
      const strays = planted(plant(body));
      expect(strays.length, body).toBeGreaterThan(0);
      expect(strays.join("\n"), body).toContain("dynamic import");
    }
  }, 60_000);

  test("a re-export, a default import and an import = require are strays", () => {
    for (const [source, words] of [
      ['export { oidcEndStatements } from "../services/oidc-cascade";', "re-export"],
      ['export * from "../services/oidc-cascade";', "re-export"],
      ['export * as cascade from "../services/oidc-cascade";', "re-export"],
      [
        'import cascade from "../services/oidc-cascade";\nexport const c = cascade;',
        "default import",
      ],
      [
        'import { default as cascade } from "../services/oidc-cascade";\nexport const c = cascade;',
        "default import",
      ],
      [
        'import cascade = require("../services/oidc-cascade");\nexport const c = cascade;',
        "require",
      ],
    ] as const) {
      const strays = planted(plant(source));
      expect(strays.length, source).toBeGreaterThan(0);
      expect(strays.join("\n"), source).toContain(words);
    }
  }, 60_000);

  test("a call at module level has no path to name, and is a stray as well as a call", () => {
    const scan = plant(`${IMPORT}export const eager = oidcEndStatements(1, "account_revoked");`);
    expect(calledFrom(scan, "(module)")).toBe(true);
    expect(planted(scan).join("\n")).toContain("module-level call");
  }, 60_000);

  test("a call in a comment or a string, a type import, the lists, and another object's method are not uses", () => {
    const scan = plant(`// oidcEndStatements(1, "account_revoked")
import type { OidcEndStatement } from "../services/oidc-cascade";
import { OIDC_END_CALLERS } from "../services/oidc-cascade";
const text = "oidcEndStatements(1, 'account_revoked') OIDC_END_GRANTS_SQL";
const other = { oidcEndStatements: (n: number) => n };
export const x = [text, other.oidcEndStatements(1), OIDC_END_CALLERS.length] as unknown as OidcEndStatement[];`);
    expect(scan.calls.filter((c) => c.file === "routes/planted.ts")).toEqual([]);
    expect(planted(scan)).toEqual([]);
    expect(callsOf(scan.calls, "oidcEndStatements")).toEqual(listed(OIDC_END_CALLERS));
  }, 60_000);

  test("a new raw statement exported by the module is guarded without touching the scan", () => {
    // The names come from the module's own exports, so a `*_SQL` constant added tomorrow is covered today.
    const tree = createTree({
      "services/oidc-cascade.ts": `${readFileSync(CASCADE, "utf8")}\nexport const OIDC_NEW_ENDING_SQL = "DELETE FROM oidc_grants";\n`,
      "routes/planted.ts":
        'import { OIDC_NEW_ENDING_SQL } from "../services/oidc-cascade";\nexport const s = OIDC_NEW_ENDING_SQL;',
    });
    expect(planted(scanEndUsers(tree)).join("\n")).toContain("OIDC_NEW_ENDING_SQL");
  }, 60_000);
});

/**
 * The paths that DELIBERATELY do not end the grants say so where the next reader will look, in the
 * words below; the behavioural proof that they leave the rows alone is
 * `oidc-cascade-nonmembership.test.ts`.
 */
describe("a deliberate non-path says so", () => {
  const SENTENCE = "not ended here (ADR 0119 rule 12)";
  for (const file of [
    "routes/admin/users.ts", // the role demotion's batch
    "services/docs-auth.ts", // revokeDocsCredentials: every key revocation
    "routes/auth-web.ts", // /auth/logout
  ]) {
    test(`${file} carries the sentence`, () => {
      expect(readFileSync(join(SRC, file), "utf8")).toContain(SENTENCE);
    });
  }
});
