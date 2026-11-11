---
name: design-for-90-10-and-headless
description: "The owner wants designs that cover 90 percent of cases up front (not 80-20), and every CLI auth flow must work on headless hosts with an explicit paste-key fallback"
metadata: 
  node_type: memory
  type: feedback
  modified: 2026-09-06T19:23:46.804Z
---

When designing a flow (stated 2026-09-06 while planning ORCID-first CLI sign-in, epic nemar-cli#1272),
the owner asked for "90-10 not 80-20": enumerate and handle the edge cases before calling a phase done,
instead of shipping the happy path and patching later.
Headless hosts (HPC login nodes, transfer hosts) are first-class: the device-code flow
(print URL plus short code, confirm on any browser, CLI polls) is the primary path,
and a `--remote`-style paste-key fallback must exist for machines that cannot even poll.

**Why:** the CLI runs on HPC nodes without browsers, and past shortcuts
(approval that set status only, no grant path) stranded real users for weeks.

**How to apply:** when briefing an implementation agent for an auth or onboarding flow,
include the explicit edge-case list (expiry, reuse, denial, wrong account, revoked or pending
account, network loss mid-poll, multiple machines, config permissions, migration of existing
users, rate limits, audit) as acceptance criteria, and design the headless path first.
Related: [[make-vs-take-decision-test]], [[sweeps-fail-open-tri-state-fetch]].
