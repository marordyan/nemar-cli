---
name: cite-adr-by-content-not-plan-numbers
description: "Implementer agents briefed from a numbered plan write \"(decision N)\" citations into code comments that resolve to nothing in the repo; brief them to cite the ADR by content and to invent no rule citations"
metadata: 
  node_type: memory
  type: feedback
  modified: 2026-09-07T07:22:11.041Z
---

On epic nemar-cli#1272 phase 1 (2026-09-07) the Sonnet implementer, briefed from a plan file with a numbered "Decisions" list, left about 24 "(decision N)" citations across the migration, service, routes, contract and tests, plus an invented citation "AGENTS.md: hoist only what gains a second consumer" for a rule that exists only in the plan. The comment-accuracy reviewer caught both; ADR 0047 had no numbered list, and five of the cited decisions were not in the ADR at all.

**Why:** the plan file lives outside the repository and is deleted after the epic; a maintainer cannot resolve the number, and a rule attributed to AGENTS.md that is not there erodes trust in every other citation.

**How to apply:** when briefing an implementer, say explicitly: cite decisions by ADR number plus a content phrase ("ADR 0047: the key is minted when the CLI collects it"), never by plan decision number; quote a repository rule only after grepping that it exists; and make sure every rationale a comment cites is actually written into the ADR being added in the same PR. Also fix arithmetic claims at every copy (the "third poll" error was pasted into four files). See [[test-entry-point-not-callee]] and [[design-for-90-10-and-headless]].
