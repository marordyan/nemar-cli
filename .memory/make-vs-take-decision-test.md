---
name: make-vs-take-decision-test
description: "The owner's standing test for bespoke code versus dependencies in NEMAR; offload when a well-established system owns the semantics, drop dependencies that add a runtime without value (DataLad precedent)"
metadata: 
  node_type: memory
  type: feedback
  modified: 2026-09-03T09:14:19.099Z
---

The owner wants every "build it ourselves or use an established system" question decided explicitly, in both directions.
Offload when a mature, well-known system owns the semantics and is in the same runtime (SPDX via `spdx-correct` and `spdx-license-list` replacing the bespoke license parsers across CLI, backend, and website, epic #1222; signal readers and the Zarr exporter offloaded to biosigio).
Drop or refuse a dependency when it drags in a runtime or a platform for little gain: DataLad was removed early because it would have required Python support in the CLI and added little; that turned out to be a very beneficial decision.
Bespoke stays justified where the behaviour is a NEMAR policy (annex policy, Zarr coverage accounting, live-data fences).

**Why:** "It was not our place to create our own thing" for licensing; the critical make-versus-take thinking is what the owner sees as the project's long-run advantage, so an audit that only says "replace" is as wrong as one that only says "keep".

**How to apply:** when proposing or reviewing a subsystem, name the established alternative, what it owns, what would be lost, and the runtime it brings, then give a replace / wrap / keep verdict with the reason. Record decisions that close off paths as ADRs. See [[biosigio-landing-policy]].
