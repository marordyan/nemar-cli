---
name: mutate-in-the-dangerous-direction
description: A mutation battery that only moves a bound the SAFE way proves nothing about the failure that matters; and a negative assertion passes when the code under test never ran at all
metadata: 
  node_type: memory
  type: feedback
  modified: 2026-09-17T11:25:05.855Z
---

Two blind spots that let defects through a battery I had already run and called green. Both surfaced three separate times in one epic (nemar-cli #1430) before I treated them as systemic.

**1. Mutate a constant or a gate in BOTH directions; the widening one is the one that hurts.**

- `RESERVED_FIXTURE_FLOOR` was mutated DOWN (99900 to 99800), which is harmless. Moving it UP is what collides with `EXEMPLAR_ID_RE`, which declares the same band separately, and the battery never saw it.
- An environment fence read `ENVIRONMENT === "production"`. In the route's pre-existing use, `false` meant MORE restriction, so the literal comparison was fail-safe. A new gate reused the same variable in the opposite direction, where `false` is PERMISSION. Same expression, inverted valence, now fail-open. Nothing mutated it because it "already had coverage".
- A declared ownership set was mutated to EMPTY but not to WRONGLY POPULATED. Adding `nm099999` (which production also owns) to a dev-owned set is the mutation with the blast radius.

Ask of every mutant: which direction is recoverable and which is not? Write the unrecoverable one.

**2. A negative or "not refused" assertion can pass when the code under test never executed.**

`expect(res.status).not.toBe(403)` as an "allowed past the gate" signal is satisfied by 401, 400, 409, 422 and 500 alike. A reviewer demonstrated mine passing with a deliberately wrong bearer token, i.e. with the request dying in auth middleware before reaching the route. Same class as guarding assertions behind `if (res.status === 200)`, which silently never runs them.

The fix is to assert something only the correct path produces. In this repo, route tests die at an unconfigured external boundary AFTER the claim INSERT commits, so the row is readable: `SELECT dataset_id, is_sandbox FROM datasets` distinguishes "allowed", "allocated instead of named", "wrong sandbox flag" and "never ran", where a status code distinguishes none of them.

**Why:** a battery is evidence about the mutants you chose. Choosing only the mutants that break things loudly measures the tests you already trust.

**How to apply:** for each bound, write the widening mutant. For each gate, write the fail-open mutant. For each "not X" assertion, ask what else satisfies it, and replace it with a positive assertion on state the correct path alone produces. Re-run the battery after fixing tests, not just after writing them: two of these were found only because the battery was re-run and a previously-killed mutant survived the rewrite.

See [[test-entry-point-not-callee]], [[prove-the-inverse-path-too]] and [[verify-fix-against-known-broken]].
