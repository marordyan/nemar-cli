/**
 * `OIDC_SECRET` is a Worker SECRET and is declared as one (epic #2014 phase #2016; ADR 0119): named
 * in the secrets comment of `backend/wrangler-sccn.toml`, optional on the bindings, and in no table
 * of that file. It encrypts the provider's private signing keys at rest, so a value in this file would
 * be the key to every stored key, committed to a public repository. The owner sets it with
 * `wrangler secret put`; this test refuses a change that would put one anywhere else.
 *
 * The file is parsed with Bun's TOML parser and every table is walked, not only the vars blocks, so a
 * name misplaced under a binding or an observability block fails too. The walk is shown to see a name
 * wherever it is, and the vars blocks are checked by name, so the guard is not vacuous. It covers the
 * file only: a Worker secret of that name, which is the intended one, does not show here.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const TOML_PATH = join(import.meta.dir, "../wrangler-sccn.toml");
const raw = readFileSync(TOML_PATH, "utf-8");
const config = Bun.TOML.parse(raw) as {
  vars?: Record<string, unknown>;
  env?: Record<string, { vars?: Record<string, unknown> }>;
};

/** The dotted path of every key called `name`, anywhere in the parsed document. */
function pathsOfName(node: unknown, name: string, path = ""): string[] {
  if (typeof node !== "object" || node === null) return [];
  const found: string[] = [];
  const entries: Array<[string, unknown]> = Array.isArray(node)
    ? node.map((v, i) => [`[${i}]`, v])
    : Object.entries(node);
  for (const [key, value] of entries) {
    const here = path === "" ? key : Array.isArray(node) ? `${path}${key}` : `${path}.${key}`;
    if (key === name) found.push(here);
    found.push(...pathsOfName(value, name, here));
  }
  return found;
}

describe("OIDC_SECRET is a secret", () => {
  test("the vars blocks the check relies on exist (the guard is not vacuous)", () => {
    expect(config.vars?.ENVIRONMENT).toBe("production");
    expect(config.env?.dev?.vars?.ENVIRONMENT).toBe("development");
    expect(pathsOfName({ a: { b: [{ OIDC_SECRET: "x" }] } }, "OIDC_SECRET")).toEqual([
      "a.b[0].OIDC_SECRET",
    ]);
  });

  test("it is named in no table of wrangler-sccn.toml, in any environment", () => {
    expect(pathsOfName(config, "OIDC_SECRET")).toEqual([]);
  });

  test("it is listed in the secrets comment, with the owner as the one who sets it", () => {
    const line = raw.split("\n").find((l) => /^# - OIDC_SECRET\b/.test(l));
    expect(line, "the secrets comment names OIDC_SECRET").toBeDefined();
    expect(raw).toContain("The owner sets it; an agent never does.");
  });

  test("the comment says it must differ from ENCRYPTION_KEY and be random, with a way to make one", () => {
    expect(raw).toMatch(/OIDC_SECRET[\s\S]{0,900}MUST differ from ENCRYPTION_KEY/);
    expect(raw).toContain("`nmsso-` followed by the output of `openssl rand -hex 32`");
  });

  test("the bindings declare it optional, so a Worker without it still starts", () => {
    const bindings = readFileSync(join(import.meta.dir, "../src/types/bindings.ts"), "utf-8");
    expect(bindings).toMatch(/^\s*OIDC_SECRET\?: string;/m);
  });
});
