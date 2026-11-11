/**
 * The two sets that must agree (epic #2005 phase A8, #2013; AGENTS.md, "Revocation cascades, always"):
 * the functions that RUN `computeReleaseStatements`, and the functions that END every credential of an
 * account (revoke all of its API keys and its sessions THROUGH THE STATEMENT SHAPES THE SCAN RECOGNISES,
 * which `helpers/compute-end-scan.ts` lists, and no others). `COMPUTE_END_CALLERS` documents the first;
 * `COMPUTE_END_EXCEPTIONS` names the functions that revoke keys and sessions WITHOUT ending the account,
 * each with its reason. The scan (`helpers/compute-end-scan.ts`) holds both lists to the code, on the
 * syntax tree, so a third path that ends an account (the suspension of compute, an owner command that
 * merges two accounts) cannot be added without either running the compute set or being named an
 * exception here, in a reviewed change.
 *
 * Each rule is shown to FIRE by a planted file laid over the real tree: a new account-ending function
 * that forgot the compute set, whether its SQL is inline or in a constant or a helper; and every way of
 * reaching `computeReleaseStatements` (an aliased import, a namespace property, a local alias, a
 * destructuring, passing it as a value) is seen, while what the scan cannot follow (a dynamic import, a
 * re-export, a reference at module top level) is refused loudly and never guessed at.
 * Every shape it recognises is planted (the predicates in either order, a numbered placeholder, `IN`, a
 * subselect, a quoted, bracketed or schema-qualified table, `DELETE FROM web_sessions WHERE user_id`), and
 * the one-key shapes and the delete of expired sessions are shown NOT to be an end. A helper is resolved in
 * the module it is imported from, never by its bare name.
 * MUTATIONS: remove the statements from `finalizeRevocation` or `tombstoneUserCascade` (the scan names
 * the function); add a function of the same shape; break each rule of the scan.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMPUTE_END_CALLERS, COMPUTE_END_EXCEPTIONS } from "../src/services/compute-release";
import { analyse } from "./helpers/compute-end-scan";
import { SRC, createTree } from "./helpers/ts-scan";

const real = analyse(createTree());

describe("the real tree", () => {
  test("the scan sees what it is meant to see (it is not vacuous)", () => {
    expect(real.ends).toEqual(
      expect.arrayContaining([
        "db/user-tombstone.ts#tombstoneUserCascade",
        "routes/admin/users.ts#finalizeRevocation",
        "routes/admin/users.ts#POST /users/:username/role",
      ]),
    );
    expect(real.users.length).toBeGreaterThanOrEqual(2);
  });

  test("the functions that run the compute set are exactly COMPUTE_END_CALLERS", () => {
    expect(real.users).toEqual([...COMPUTE_END_CALLERS].sort());
  });

  test("every function that ends every credential runs the compute set, or is a deliberate exception", () => {
    const missing = real.unsatisfied.filter((key) => !(key in COMPUTE_END_EXCEPTIONS));
    expect(missing).toEqual([]);
  });

  test("every exception is a real function that ends keys and sessions, has a reason, and is not also a caller", () => {
    for (const [key, reason] of Object.entries(COMPUTE_END_EXCEPTIONS)) {
      expect([key, real.ends.includes(key)]).toEqual([key, true]);
      expect([key, reason.length >= 40]).toEqual([key, true]);
      expect(COMPUTE_END_CALLERS as readonly string[]).not.toContain(key);
    }
  });

  test("the demotion is an exception, with the reason the docblock gives", () => {
    expect(COMPUTE_END_EXCEPTIONS).toHaveProperty([
      "routes/admin/users.ts#POST /users/:username/role",
    ]);
  });

  test("nothing in the tree is a use the scan cannot follow", () => {
    expect(real.unfollowable).toEqual([]);
  });
});

/** The real `routes/admin/users.ts` and `db/user-tombstone.ts`, text. */
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

describe("the scan fires", () => {
  test("remove the statements from finalizeRevocation: it ends every credential and runs nothing (MUTATION)", () => {
    const text = read("routes/admin/users.ts");
    const line =
      "...computeReleaseStatements(user.id).map((s) => db.prepare(s.sql).bind(...s.binds)),";
    expect(text).toContain(line);
    const found = analyse(createTree({ "routes/admin/users.ts": text.replace(line, "") }));
    expect(found.unsatisfied).toContain("routes/admin/users.ts#finalizeRevocation");
    expect(found.users).not.toContain("routes/admin/users.ts#finalizeRevocation");
  }, 60_000);

  test("remove them from tombstoneUserCascade (MUTATION)", () => {
    const text = read("db/user-tombstone.ts");
    const line = "...computeReleaseStatements(id).map((s) => step(s.sql, ...s.binds)),";
    expect(text).toContain(line);
    const found = analyse(createTree({ "db/user-tombstone.ts": text.replace(line, "") }));
    expect(found.unsatisfied).toContain("db/user-tombstone.ts#tombstoneUserCascade");
  }, 60_000);

  const TOKENS = `"UPDATE tokens SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL"`;
  const SESSIONS = `"UPDATE web_sessions SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL"`;

  test("a new function that ends every credential and forgot compute is named, however its SQL is written", () => {
    const planted = analyse(
      createTree({
        // Inline.
        "routes/admin/planted-inline.ts": `
          export async function mergeAccounts(db: D1Database, id: number) {
            await db.batch([db.prepare(${TOKENS}).bind(id), db.prepare(${SESSIONS}).bind(id)]);
          }`,
        // In constants, imported under another name.
        "services/planted-constants.ts": `
          export const KEYS_GONE = ${TOKENS};
          export const SESSIONS_GONE = ${SESSIONS};`,
        "routes/admin/planted-imported.ts": `
          import { KEYS_GONE as k, SESSIONS_GONE as s } from "../../services/planted-constants";
          export async function suspendAccount(db: D1Database, id: number) {
            await db.batch([db.prepare(k).bind(id), db.prepare(s).bind(id)]);
          }`,
        // In a helper function, called from a route.
        "services/planted-helper.ts": `
          export async function revokeSessionsOf(db: D1Database, id: number) {
            await db.prepare(${SESSIONS}).bind(id).run();
          }`,
        "routes/admin/planted-route.ts": `
          import { revokeSessionsOf } from "../../services/planted-helper";
          export function register(admin: { post(path: string, h: (c: unknown) => unknown): void }) {
            admin.post("/users/:id/close", async () => {
              const db = {} as D1Database;
              await db.prepare(${TOKENS}).bind(1).run();
              await revokeSessionsOf(db, 1);
            });
          }`,
      }),
    );
    for (const key of [
      "routes/admin/planted-inline.ts#mergeAccounts",
      "routes/admin/planted-imported.ts#suspendAccount",
      "routes/admin/planted-route.ts#POST /users/:id/close",
    ]) {
      expect([key, planted.ends.includes(key), planted.unsatisfied.includes(key)]).toEqual([
        key,
        true,
        true,
      ]);
    }
  }, 60_000);

  test("a function that revokes keys alone, one key and the sessions, or one session by its cookie, is not an account's end", () => {
    const planted = analyse(
      createTree({
        "routes/planted-keys.ts": `
          export async function rotate(db: D1Database, id: number) {
            await db.prepare(${TOKENS}).bind(id).run();
          }
          export async function logout(db: D1Database, h: string) {
            await db.prepare("UPDATE web_sessions SET revoked_at = datetime('now') WHERE cookie_id_hash = ?").bind(h).run();
          }
          export async function oneKey(db: D1Database, id: number, user: number) {
            await db.prepare("UPDATE tokens SET revoked_at = datetime('now') WHERE id = ? AND user_id = ?").bind(id, user).run();
            await db.prepare(${SESSIONS}).bind(user).run();
          }`,
      }),
    );
    expect(planted.ends).not.toContain("routes/planted-keys.ts#oneKey");
    expect(planted.ends).not.toContain("routes/planted-keys.ts#rotate");
    expect(planted.ends).not.toContain("routes/planted-keys.ts#logout");
  }, 60_000);

  test("every shape of the statement that revokes all of an account's keys is recognised, and the one-key shapes are not", () => {
    const sessions = `"UPDATE web_sessions SET revoked_at = datetime('now') WHERE user_id = ?"`;
    const ender = (keys: string, sess = sessions) => `
      export async function ender(db: D1Database, id: number) {
        await db.batch([db.prepare(${JSON.stringify(keys)}).bind(id), db.prepare(${sess}).bind(id)]);
      }`;
    const all: Record<string, string> = {
      "the predicates in the other order":
        "UPDATE tokens SET revoked_at = datetime('now') WHERE revoked_at IS NULL AND user_id = ?",
      "a numbered placeholder": "UPDATE tokens SET revoked_at = datetime('now') WHERE user_id = ?1",
      "no spaces": "UPDATE tokens SET revoked_at=datetime('now') WHERE user_id=?",
      "lower case": "update tokens set revoked_at = datetime('now') where user_id = ?",
      "multi line":
        "UPDATE tokens\n   SET revoked_at = datetime('now')\n WHERE user_id = ?\n   AND revoked_at IS NULL",
      "IN a list": "UPDATE tokens SET revoked_at = datetime('now') WHERE user_id IN (?)",
      "IN a subselect":
        "UPDATE tokens SET revoked_at = datetime('now') WHERE user_id IN (SELECT id FROM users WHERE email = ?)",
      "equal to a subselect":
        "UPDATE tokens SET revoked_at = datetime('now') WHERE user_id = (SELECT id FROM users WHERE username = ?)",
      "a double-quoted table":
        "UPDATE \"tokens\" SET revoked_at = datetime('now') WHERE user_id = ?",
      "a backtick-quoted table":
        "UPDATE `tokens` SET revoked_at = datetime('now') WHERE user_id = ?",
      "a bracketed table": "UPDATE [tokens] SET revoked_at = datetime('now') WHERE user_id = ?",
      "a schema-qualified table":
        "UPDATE main.tokens SET revoked_at = datetime('now') WHERE user_id = ?",
      "an OR clause": "UPDATE OR IGNORE tokens SET revoked_at = datetime('now') WHERE user_id = ?",
      "a qualified column":
        "UPDATE tokens SET revoked_at = datetime('now') WHERE tokens.user_id = ?",
    };
    const oneKey: Record<string, string> = {
      "by id": "UPDATE tokens SET revoked_at = datetime('now') WHERE id = ? AND user_id = ?",
      "by id, user first":
        "UPDATE tokens SET revoked_at = datetime('now') WHERE user_id = ? AND id = ?",
      "by hash":
        "UPDATE tokens SET revoked_at = datetime('now') WHERE api_key_hash = ? AND user_id = ?",
      "by a qualified id":
        "UPDATE tokens SET revoked_at = datetime('now') WHERE tokens.id = ? AND user_id = ?",
      "by id alone": "UPDATE tokens SET revoked_at = datetime('now') WHERE id = ?",
    };
    const overlay: Record<string, string> = {};
    for (const [name, sql] of Object.entries(all)) {
      overlay[`routes/planted-all-${name.replace(/\W+/g, "-")}.ts`] = ender(sql);
    }
    for (const [name, sql] of Object.entries(oneKey)) {
      overlay[`routes/planted-one-${name.replace(/\W+/g, "-")}.ts`] = ender(sql);
    }
    const found = analyse(createTree(overlay));
    for (const name of Object.keys(all)) {
      const key = `routes/planted-all-${name.replace(/\W+/g, "-")}.ts#ender`;
      expect([name, found.ends.includes(key)]).toEqual([name, true]);
    }
    for (const name of Object.keys(oneKey)) {
      const key = `routes/planted-one-${name.replace(/\W+/g, "-")}.ts#ender`;
      expect([name, found.ends.includes(key)]).toEqual([name, false]);
    }
  }, 60_000);

  test("every shape of the statement that ends sessions is recognised: an UPDATE of any scope, and a DELETE of a user's sessions", () => {
    const keys = "UPDATE tokens SET revoked_at = datetime('now') WHERE user_id = ?";
    const variants: Record<string, [string, boolean]> = {
      "an update": ["UPDATE web_sessions SET revoked_at = datetime('now') WHERE user_id = ?", true],
      "a quoted update": [
        "UPDATE \"web_sessions\" SET revoked_at = datetime('now') WHERE user_id = ?",
        true,
      ],
      "a delete": ["DELETE FROM web_sessions WHERE user_id = ?", true],
      "a lower-case delete": ["delete from web_sessions where user_id = ?1", true],
      "a quoted delete": ['DELETE FROM "web_sessions" WHERE user_id = ?', true],
      "a delete by user in a subselect": [
        "DELETE FROM web_sessions WHERE user_id IN (SELECT id FROM users WHERE email = ?)",
        true,
      ],
      "a delete of EXPIRED sessions only": [
        "DELETE FROM web_sessions WHERE expires_at < datetime('now')",
        false,
      ],
      "a delete of one session": ["DELETE FROM web_sessions WHERE cookie_id_hash = ?", false],
    };
    const overlay: Record<string, string> = {};
    for (const [name, [sql]] of Object.entries(variants)) {
      overlay[`routes/planted-sess-${name.replace(/\W+/g, "-")}.ts`] = `
        export async function ender(db: D1Database, id: number) {
          await db.batch([db.prepare(${JSON.stringify(keys)}).bind(id), db.prepare(${JSON.stringify(sql)}).bind(id)]);
        }`;
    }
    const found = analyse(createTree(overlay));
    for (const [name, [, expected]] of Object.entries(variants)) {
      const key = `routes/planted-sess-${name.replace(/\W+/g, "-")}.ts#ender`;
      expect([name, found.ends.includes(key)]).toEqual([name, expected]);
    }
  }, 60_000);

  test("a helper is resolved in the module it is imported from, never by its bare name: a function of the same name elsewhere does not make an unrelated unit an end", () => {
    const before = analyse(createTree());
    const planted = analyse(
      createTree({
        // A helper named `a`, and one named like a real revoker, each REALLY revoking.
        "services/planted-a.ts": `
          export async function a(db: D1Database, id: number) {
            await db.prepare("UPDATE tokens SET revoked_at = datetime('now') WHERE user_id = ?").bind(id).run();
            await db.prepare("UPDATE web_sessions SET revoked_at = datetime('now') WHERE user_id = ?").bind(id).run();
          }
          export async function revokeDocsCredentials(db: D1Database, id: number) {
            await db.prepare("UPDATE web_sessions SET revoked_at = datetime('now') WHERE user_id = ?").bind(id).run();
          }`,
        // Units that merely USE the same words: a parameter, a local, an unrelated function of that name.
        "routes/planted-unrelated.ts": `
          export function f(a: number) { return a + 1; }
          export function g(ids: number[]) { return ids.map((a) => a * 2); }
          async function revokeDocsCredentials() { return 1; }
          export async function h(db: D1Database, id: number) {
            await db.prepare("UPDATE tokens SET revoked_at = datetime('now') WHERE user_id = ?").bind(id).run();
            await revokeDocsCredentials();
          }`,
        // One that really imports the revoker from the module that defines it.
        "routes/planted-real.ts": `
          import { revokeDocsCredentials } from "../services/planted-a";
          export async function k(db: D1Database, id: number) {
            await db.prepare("UPDATE tokens SET revoked_at = datetime('now') WHERE user_id = ?").bind(id).run();
            await revokeDocsCredentials(db, id);
          }`,
      }),
    );
    // Nothing of the real tree changes because a helper elsewhere has a common name.
    expect(planted.unsatisfied.filter((k) => !k.includes("planted-"))).toEqual(before.unsatisfied);
    expect(planted.ends).not.toContain("routes/planted-unrelated.ts#f");
    expect(planted.ends).not.toContain("routes/planted-unrelated.ts#g");
    expect(planted.ends).not.toContain("routes/planted-unrelated.ts#h");
    expect(planted.ends).toContain("routes/planted-real.ts#k");
    expect(planted.ends).toContain("services/planted-a.ts#a");
  }, 60_000);

  test("every way of reaching the compute set is seen as a use, and a function that ends credentials through one is satisfied", () => {
    const ends = (body: string) => `
      ${body}
      async function ender(db: D1Database, id: number) {
        await db.batch([db.prepare(${TOKENS}).bind(id), db.prepare(${SESSIONS}).bind(id)]);
      }`;
    const cases: Record<string, string> = {
      "named import": `import { computeReleaseStatements } from "../../services/compute-release";
        export function a(id: number) { return computeReleaseStatements(id); }`,
      "aliased import": `import { computeReleaseStatements as stmts } from "../../services/compute-release.js";
        export function a(id: number) { return stmts(id); }`,
      "namespace property": `import * as rel from "../../services/compute-release";
        export function a(id: number) { return rel.computeReleaseStatements(id); }`,
      "namespace element access": `import * as rel from "../../services/compute-release";
        export function a(id: number) { return rel["computeReleaseStatements"](id); }`,
      "local alias": `import { computeReleaseStatements } from "../../services/compute-release";
        const run = computeReleaseStatements;
        export function a(id: number) { return run(id); }`,
      "alias of a namespace property": `import * as rel from "../../services/compute-release";
        const run = rel.computeReleaseStatements;
        export function a(id: number) { return run(id); }`,
      "alias of a namespace element": `import * as rel from "../../services/compute-release";
        const run = rel["computeReleaseStatements"];
        export function a(id: number) { return run(id); }`,
      "alias of an alias": `import { computeReleaseStatements as first } from "../../services/compute-release";
        const second = first;
        const third = second;
        export function a(id: number) { return third(id); }`,
      "alias declared before the alias it copies": `import { computeReleaseStatements as first } from "../../services/compute-release";
        var third = second;
        var second = first;
        export function a(id: number) { return third(id); }`,
      "namespace destructuring": `import * as rel from "../../services/compute-release";
        const { computeReleaseStatements: run } = rel;
        export function a(id: number) { return run(id); }`,
      "passed as a value": `import { computeReleaseStatements } from "../../services/compute-release";
        export function a(ids: number[]) { return ids.map(computeReleaseStatements); }`,
    };
    for (const [name, body] of Object.entries(cases)) {
      const planted = analyse(createTree({ "routes/admin/planted-use.ts": ends(body) }));
      // The use is attributed to the function that makes it, not only to the module that declares an alias.
      expect([name, planted.users.includes("routes/admin/planted-use.ts#a")]).toEqual([name, true]);
      // Unreached by name, `ender` shares no function with the use, so it is still named.
      expect([name, planted.unsatisfied.includes("routes/admin/planted-use.ts#ender")]).toEqual([
        name,
        true,
      ]);
    }
    // A function that RUNS it itself is satisfied, and one that delegates to a function that does.
    const direct = analyse(
      createTree({
        "routes/admin/planted-direct.ts": `
          import { computeReleaseStatements as stmts } from "../../services/compute-release";
          export async function ender(db: D1Database, id: number) {
            await db.batch([db.prepare(${TOKENS}).bind(id), db.prepare(${SESSIONS}).bind(id), ...stmts(id).map((s) => db.prepare(s.sql))]);
          }`,
        "routes/admin/planted-delegate.ts": `
          import { computeReleaseStatements } from "../../services/compute-release";
          export function endCompute(id: number) { return computeReleaseStatements(id); }
          export async function ender(db: D1Database, id: number) {
            await db.batch([db.prepare(${TOKENS}).bind(id), db.prepare(${SESSIONS}).bind(id), ...endCompute(id).map((s) => db.prepare(s.sql))]);
          }`,
      }),
    );
    expect(direct.ends).toEqual(
      expect.arrayContaining([
        "routes/admin/planted-direct.ts#ender",
        "routes/admin/planted-delegate.ts#ender",
      ]),
    );
    expect(direct.unsatisfied).not.toContain("routes/admin/planted-direct.ts#ender");
    expect(direct.unsatisfied).not.toContain("routes/admin/planted-delegate.ts#ender");
  }, 60_000);

  test("what the scan cannot follow is refused, not guessed at: a dynamic import, a re-export, a module-level reference", () => {
    const planted = analyse(
      createTree({
        "routes/planted-dynamic.ts": `
          export async function a(id: number) {
            const m = await import("../services/compute-release.js");
            return m.computeReleaseStatements(id);
          }`,
        "routes/planted-reexport.ts": `export { computeReleaseStatements } from "../services/compute-release";`,
        "routes/planted-star.ts": `export * from "../services/compute-release";`,
        "routes/planted-top.ts": `
          import { computeReleaseStatements } from "../services/compute-release";
          export const later = computeReleaseStatements;`,
      }),
    );
    expect(planted.unfollowable.some((m) => m.includes("planted-dynamic.ts"))).toBe(true);
    expect(planted.unfollowable.some((m) => m.includes("planted-reexport.ts"))).toBe(true);
    expect(planted.unfollowable.some((m) => m.includes("planted-star.ts"))).toBe(true);
    expect(planted.unfollowable.some((m) => m.includes("planted-top.ts"))).toBe(true);
  }, 60_000);
});
