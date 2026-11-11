---
name: orcid-mock-project
description: "A charter-only, private repository exists for an ephemeral mock ORCID server; it is not scheduled, and it is started with the epic workflow from its MVP1 epic issue"
metadata:
  type: project
---

A separate repository for a mock ORCID server was created 2026-09-08, right after the nemar-cli v0.10.0 release, at the owner's request.
It is PRIVATE and holds a charter only (README, project instructions and planning notes); no code exists yet.
Its decisions, plan and open questions live in that repository, not here.

**Why it matters:** the backend's ORCID-touching tests use a per-file `Bun.serve` stand-in today ([[orcid-testing-reality]]), and the mock is meant to replace those once it is built, so a question about an ORCID test double has a planned answer.

**How to apply:** when the owner says to start it, run the epic workflow on the MVP1 epic issue in that repository; cite ORCID's documentation for every fidelity claim; adoption in nemar-cli replaces the per-file stand-ins in `backend/test`.
Its license follows [[new-tooling-repos-mit]].
