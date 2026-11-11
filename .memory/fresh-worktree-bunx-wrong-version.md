---
name: fresh-worktree-bunx-wrong-version
description: "A new worktree has no node_modules, so bunx fetches latest biome and reports a config schema error that reads like a broken repo"
metadata: 
  node_type: memory
  type: feedback
  modified: 2026-09-18T02:30:19.351Z
---

In a freshly created worktree, run `bun install` at the root AND in `backend/` before any gate.
Until then `bunx biome` resolves to the newest published biome rather than the pinned 1.9.4 and
dies with `The configuration schema version does not match the CLI version` plus
`Found an unknown key organizeImports`, which looks like a corrupt `biome.json`. `bun run
typecheck` fails the same way with `Cannot find type definition file for
'@cloudflare/workers-types'` until the backend install runs.

**Why:** I spent a cycle believing the repo's lint config was broken. Nothing was wrong with
the checkout; the tool was the wrong major version because it was not installed locally.

**How to apply:** After `git worktree add`, run `bun install` and `(cd backend && bun install)`
first. Note `bun run lint` only checks `src/`, so lint backend files explicitly with
`./node_modules/.bin/biome check backend/src/<paths>` (the local binary, never `bunx`, which
can still reach past the pin). See [[wrangler-via-cfman]] for the same shape of trap: a tool
reporting a broken environment when it is really the wrong binary.
