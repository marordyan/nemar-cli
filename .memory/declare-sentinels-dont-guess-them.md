---
name: declare-sentinels-dont-guess-them
description: "A test fixture that picks a \"probably unused\" id, port, name or path from a space something else allocates from is a time bomb; declare the sentinel in the allocator and import it"
metadata: 
  node_type: memory
  type: feedback
  modified: 2026-09-17T13:47:36.297Z
---

Four live tests in nemar-cli used `nm099998` as their "this dataset does not exist" id, each commented *"valid format within the MAX_NUMBER=99999 cap, but unlikely to be allocated."*
Epic #1430 then designated that exact id as the standing anonymous-deposit fixture, and building it turned all four red at once.

The tests were not careless about the odds.
They were wrong about **whose space they were borrowing from**: `nm099900`-`nm099999` is the RESERVED band, which exists precisely so standing fixtures can be assigned there.
The safest-looking corner of the id space was the one guaranteed to be claimed.

**The fix is to make the sentinel a declaration, not a guess.**
`ABSENT_DATASET_ID` now lives in `backend/src/services/datasetId.ts` beside the allocator, and the tests import it.
Two properties, both load-bearing:

- **Structurally unallocatable.** It is inside the reserved band, so `generateDatasetId` can never return it. An id merely "not in use today" only postpones this.
- **Furthest from the next claim.** Fixtures are assigned DOWNWARD from `nm099999`, so the sentinel is the band's FLOOR. Putting it at `nm099997` would have parked it directly in the path of the next fixture.

Plus a guard test asserting it is reserved AND not in `DEV_OWNED_FIXTURE_IDS`, so the only way to claim the id is to delete the constant, which fails the guard and leads whoever does it to the four tests that depend on the absence.

**Why:** "unlikely to collide" is a probability claim about a future someone else controls. The cost of being wrong is paid by a stranger debugging four unrelated red tests, and the cost of declaring it is one exported constant.

**How to apply:** whenever a test needs a value that must never exist — a dataset id, a port, a username, a path, a UUID — ask which component ALLOCATES from that space, and put the sentinel there as a named export with a comment saying what depends on its absence. Never pick it from the range that component hands out, and never pick it from the range reserved for the very fixtures you are building. If the space has a direction of travel (allocated upward, assigned downward), put the sentinel at the far end.

See [[inert-values-are-the-third-test-class]] and [[test-entry-point-not-callee]].
