/**
 * The platform fact the key set's short cache stands on (epic #2014 phase #2016): the cache is a
 * `WeakMap` keyed by the `env.DB` object (`services/oidc-keys.ts`, `jwksMemo`), which saves the
 * database read only if a Worker is handed the SAME `env.DB` object on every request in an isolate.
 *
 * Asserted against the real runtime, workerd under Miniflare, which is the one `wrangler dev` and the
 * dev Worker run: a script is dispatched four requests, and the second to fourth must find the entry
 * the first made. If a runtime ever hands out a fresh binding object per request, this fails, and the
 * cache is a no-op that costs a read per request: move it to a key the runtime keeps (the Cache API,
 * or a module-scope entry), as the module's comment says. It is a fact about workerd and says nothing
 * about the production edge until the dev Worker has been exercised.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { Miniflare } from "miniflare";

const mf = new Miniflare({
  modules: true,
  script: `
    let first;
    const seen = new WeakMap();
    export default {
      async fetch(request, env) {
        if (first === undefined) first = env.DB;
        const hit = seen.has(env.DB);
        seen.set(env.DB, true);
        return Response.json({ sameAsFirst: env.DB === first, weakMapHit: hit });
      },
    };
  `,
  compatibilityDate: "2024-12-01",
  d1Databases: ["DB"],
});

afterAll(async () => {
  await mf.dispose();
});

describe("env.DB is one object across the requests of an isolate", () => {
  test("a WeakMap keyed by it hits from the second request on", async () => {
    const answers: Array<{ sameAsFirst: boolean; weakMapHit: boolean }> = [];
    for (let i = 0; i < 4; i++) {
      const res = await mf.dispatchFetch(`http://localhost/${i}`);
      answers.push((await res.json()) as { sameAsFirst: boolean; weakMapHit: boolean });
    }
    expect(answers.map((a) => a.sameAsFirst)).toEqual([true, true, true, true]);
    expect(answers.map((a) => a.weakMapHit)).toEqual([false, true, true, true]);
  });
});
