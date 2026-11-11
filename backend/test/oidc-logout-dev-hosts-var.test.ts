/**
 * Where `OIDC_LOGOUT_DEV_HOSTS` may be set, and where it may not (epic #2014 phase #2019; ADR 0119 rule
 * 15).
 *
 * The var lists the hosts a dev or staging Worker may send a back-channel logout to besides a loopback
 * address. It is optional and ABSENT from `backend/wrangler-sccn.toml`: setting it on the dev Worker is
 * the owner's act, for a deliberate test against a partner's staging host, and the file is not where
 * that happens. The production Worker ignores it (`logoutAddressVerdict`, proven in
 * `oidc-logout-sender.test.ts`), and this test refuses it in every table of the file but the dev one,
 * so a line copied from the dev block into the production block fails here rather than being read as
 * a decision. The dev table is left free on purpose: the owner may add it there.
 *
 * It covers the file and nothing else: a Worker var set in the dashboard also takes effect.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Block = Record<string, unknown>;

const config = Bun.TOML.parse(
  readFileSync(join(import.meta.dir, "../wrangler-sccn.toml"), "utf-8"),
) as { env?: Record<string, Block> } & Block;

const NAME = "OIDC_LOGOUT_DEV_HOSTS";

/** The dotted path of every key called `NAME`, anywhere in the parsed document. */
function pathsOfName(node: unknown, path = ""): string[] {
  if (typeof node !== "object" || node === null) return [];
  const found: string[] = [];
  const entries: Array<[string, unknown]> = Array.isArray(node)
    ? node.map((v, i) => [`[${i}]`, v])
    : Object.entries(node);
  for (const [key, value] of entries) {
    const here = path === "" ? key : Array.isArray(node) ? `${path}${key}` : `${path}.${key}`;
    if (key === NAME) found.push(here);
    found.push(...pathsOfName(value, here));
  }
  return found;
}

describe("backend/wrangler-sccn.toml and OIDC_LOGOUT_DEV_HOSTS", () => {
  test("the walk sees the name wherever it is (it is not vacuous)", () => {
    expect(pathsOfName({ a: { b: [{ [NAME]: "x" }] }, [NAME]: "y" })).toEqual([
      `a.b[0].${NAME}`,
      NAME,
    ]);
  });

  test("the production tables do not set it", () => {
    const { env, ...production } = config;
    const { dev: _dev, ...otherEnvs } = env ?? {};
    expect(pathsOfName(production)).toEqual([]);
    expect(pathsOfName(otherEnvs)).toEqual([]);
    expect(config.vars?.ENVIRONMENT).toBe("production");
  });
});
