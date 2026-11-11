---
name: passthrough-defeats-schema-tests
description: A .passthrough() zod schema makes parse-and-read-back assertions unfalsifiable; assert the declared shape instead
metadata: 
  node_type: memory
  type: feedback
  modified: 2026-09-17T00:39:16.019Z
---

The MCP contract schemas end in `.passthrough()`. So `schema.parse({anything: "x"}).anything` returns `"x"`
whether or not `anything` is declared. Any test shaped "parse an object, assert the value came back"
is unfalsifiable and survives deleting the declaration it claims to protect.

I wrote exactly that test in nemar-cli #1429 and it reached review. I had mutation-checked the three
tests around it and skipped the fourth because it looked obviously fine.

**Why:** `.passthrough()` exists so an unknown argument does not break an older client. The cost is that
the schema is not an oracle for what it declares, only for what it rejects by type.

**How to apply:** Test the declared SHAPE, not a round-trip: `Object.keys(schema.shape)`. Useful
assertions are set-equality against a generated list, disjointness between generated and hand-declared
names, and an exact count (`BESPOKE.length + 2 + FACETS.length`). Also compare the zod3 contract's shape
against the zod4 mirror's: sample-object parity tests cannot see a key missing from one side, because
passthrough accepts it on both. The zod4 mirror in `backend/src/mcp/schemas.ts` is what `registerTool`
advertises, so a widened contract that skips the mirror changes nothing the model sees.
Mutation-check EVERY new assertion, including the one that looks too simple to be wrong.
Related: [[test-entry-point-not-callee]], [[verify-fix-against-known-broken]].
