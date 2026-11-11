---
name: test-entry-point-not-callee
description: Tests that call a helper instead of the orchestration entry point cannot fail; mutate one line at a time and confirm the mutation applied
metadata: 
  node_type: memory
  type: feedback
  modified: 2026-08-25T08:05:40.583Z
---

A test that exercises a helper, an exported SQL constant, or a pure sub-function
directly cannot catch a regression in how the **caller** derives that helper's
inputs, which is where the bugs actually are. Drive the orchestration function or
the HTTP route that production uses; isolated-piece tests are a supplement, never
the coverage.

Recurring smells: looping over a parameter the function under test does not
accept; re-implementing production logic in the test (fetch-then-slice, a
hand-copied SQL string) and asserting on its own arithmetic; a fixture too small
to reach the boundary it claims to probe.

**Why:** this happened four separate times in one epic (nemar-cli #1144) before it
was recognised as systemic rather than as a run of bad luck. Twice caught by me,
twice more by review agents afterwards.

**How to apply:**
- Never hand-copy a SQL statement into a test; export the real one and import it.
  A copy tests itself.
- Prove each new test fails: mutate the single production line it targets, run it,
  confirm it fails for the expected reason, revert, confirm the tree is clean.
- **One perturbation at a time.** Reverting two fixes together masks both; a
  candidate-window fix and a count fix were verified as a pair, and the window
  half turned out to have no coverage at all.
- **Confirm the mutation actually applied.** A `sed`/`perl` substitution that
  matched nothing followed by a green run looks exactly like a passing check. I
  did this once and nearly recorded a false verification.
- When the production corpus cannot falsify the rule (two implementations agree on
  all real data), a synthetic fixture is the only guard; say so in its comment or
  the next reader deletes it as redundant.

Codified in that repo's `.rules/testing.md` as two `[STRICT]` sections.
See also [[verify-fix-against-known-broken]].
