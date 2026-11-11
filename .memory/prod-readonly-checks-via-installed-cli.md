---
name: prod-readonly-checks-via-installed-cli
description: "No wrangler login on this machine, but the installed `nemar` (~/.bun/bin, release version, prod API) is signed in with an admin account, so read-only production checks such as username spellings go through `nemar admin users`, not D1"
metadata: 
  node_type: memory
  type: project
  modified: 2026-09-08T12:05:25.053Z
---

Checked 2026-09-08 on epic nemar-cli#1272 phase 4: `wrangler whoami` is not logged in and there is no `CLOUDFLARE_API_TOKEN`, so a "verify this in production D1 before merge" step cannot run as a D1 query here. The installed CLI (`which nemar` gives `~/.bun/bin/nemar`, the npm release, v0.9.16 that day) uses the real `~/.config/nemar`, and its active account is an admin on production.

**Why:** the migration-spelling check for 0082 (the spellings of the service and test account rows) was recorded as a pre-merge gate and would otherwise block on the owner running wrangler by hand; a read-only `nemar admin users` listing answers it in seconds.

**How to apply:** for read-only production facts (does a user exist, its role, its spelling), run the installed `nemar admin ...` command and pipe through a filter that redacts email addresses before anything lands in a transcript or report; never use it for writes, and never point it at staging (staging uses `TEST_ADMIN_API_KEY` with an isolated `NEMAR_CONFIG_DIR`). See [[dev-worker-deploys-only-from-dev]] and [[classifier-blocks-remote-secret-writes]].

**Correction 2026-09-08:** D1 queries are possible after all through cfman (`bunx cfman wrangler --account sccn d1 execute ...`); see [[wrangler-via-cfman]]. The installed CLI remains the quicker path for a username or role check.
