---
name: plan-mode-pauses-running-subagents
description: "EnterPlanMode is session-wide; a subagent mid-implementation stops editing and waits, so plan the next phase before launching an implementer or after it reports, never while it runs"
metadata: 
  node_type: memory
  type: feedback
  modified: 2026-09-07T13:01:13.853Z
---

On epic nemar-cli#1272 (2026-09-07) the lead entered plan mode to design phase 4 while the phase 3 Sonnet implementer was still running its mutate-and-revert verification pass. The implementer saw "Plan Mode is active", stopped making edits, wrote its own plan file, and reported "should I resume?", costing a round trip and blocking the critical path until ExitPlanMode.

**Why:** plan mode's read-only rule propagates to every agent in the session, including background implementers that need to edit and commit.

**How to apply:** in the epic-dev loop, do the next phase's planning either before launching the current phase's implementer (planning is read-only and independent of the merge) or after its final report lands; if a plan must happen while one runs, expect the pause and send a "resume" message right after ExitPlanMode. Exploration agents (read-only) are unaffected and can run through plan mode. See [[dev-worker-deploys-only-from-dev]] and [[cite-adr-by-content-not-plan-numbers]].
