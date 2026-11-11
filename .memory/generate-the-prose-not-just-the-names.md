---
name: generate-the-prose-not-just-the-names
description: Deriving identifiers from a single declaration but hand-writing the prose beside them recreates the drift in miniature
metadata: 
  node_type: memory
  type: feedback
  modified: 2026-09-17T00:39:26.196Z
---

In nemar-cli #1429 I generated the MCP facet PARAMETER NAMES from `shared/facets.ts` (per ADR 0032)
and then hand-wrote the per-kind syntax description next to them. The names could not drift; the prose
drifted on arrival, wrong for 9 of 20 facets. `bytes` and `duration` facets declare no `unit`, so my
description omitted the unit grammar and the bare form silently means bytes and SECONDS; `text` facets
are substring not exact; `version` facets are exact-or-prefix.

The correct prose already existed in `src/lib/facet-options.ts` with a comment naming the exact trap:
"the difference between `--duration 100h` and `--duration 360000` (#1169 review)". I re-created a
regression the repo had already fixed once, on a model-facing surface.

**Why:** the drift risk lives in whatever a human maintains by hand, not in whatever looks generated.
Half-generating a declaration moves the risk into the remaining half rather than removing it.

**How to apply:** When deriving from a single source, ask what else travels with each entry (units,
match semantics, accepted syntax, examples) and generate that too. `describeFacet` now lives in
`shared/facets.ts`, the zero-dependency module the CLI and `backend/` both import; `src/lib/` cannot be
imported from `backend/` (it pulls in Commander, and it inverts the layering). Before writing a
description of how a value is parsed, read the parser, and grep for an existing description of the same
thing. Related: [[make-vs-take-decision-test]], [[cite-adr-by-content-not-plan-numbers]].
