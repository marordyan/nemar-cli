---
name: osa-checkout-parked-on-feature-branch
description: "The local osa checkout sits on an old feature branch; describe OSA from origin/develop, never the working tree"
metadata: 
  node_type: memory
  type: project
  modified: 2026-09-16T21:34:48.086Z
---

The local OSA checkout is routinely parked on a stale feature branch, not `develop`.
On 2026-09-16 it sat on `feature/browser-execution-tool-design`, cut 2026-09-08 and four commits behind.

Reading the working tree and reporting it as "OSA's current state" produced a wrong claim that
propagated into an advisor brief: I said OSA had no MCP client and still called the dead
legacy `dataexplorer` data-pipeline API. On `origin/develop` that had already been fixed by PR #352,
which added `src/tools/mcp_client.py`, put `mcp_servers` in `src/assistants/nemar/config.yaml`,
and DELETED `src/assistants/nemar/tools.py`.

**Why:** OSA has three live refs that disagree, and the differences are exactly the facts worth
reporting. `main` is what production runs (its version endpoint says which), `develop` is
integration and auto-deploys to dev, and the checkout is wherever a past session left it.

**How to apply:** `git fetch` first, then answer from `git show origin/develop:<path>` or
`git ls-tree origin/develop`. Before saying a feature is "in production", check `origin/main`, not
`develop`, and confirm against the deployed version endpoint. A CI failure on a stale branch is
usually the branch's age, not the change: merge `origin/develop` in before diagnosing it.
Related: [[retest-a-filed-diagnosis]], [[prod-readonly-checks-via-installed-cli]].
