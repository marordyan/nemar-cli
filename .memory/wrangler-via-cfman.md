---
name: wrangler-via-cfman
description: "On the owner's machines every Wrangler command runs through cfman with the SCCN account (`bunx cfman wrangler --account sccn ...`); plain `wrangler` says Not logged in, which is not a lack of access"
metadata:
  type: feedback
---

On 2026-09-08 (epic nemar-cli#1272 release work) I reported twice that wrangler was not logged in and asked the owner to run D1 seeds or deploys by hand.
The owner corrected it: wrangler runs through `bunx cfman wrangler --account sccn`, and that belonged in AGENTS.md, where it was not (a PR the same day added it; it is there now).

**Why:** cfman stores the Cloudflare API token per account and wraps wrangler; the bare wrangler binary has no credential, so "Not logged in" is expected and misleading.

**How to apply:** for any D1 query, seed, or deploy against `nemar-db-dev`/`nemar-api-dev` (or production, when the owner asks), run from `backend/`: `bunx cfman wrangler --account sccn d1 execute nemar-db-dev --remote --env dev -c wrangler-sccn.toml --file <sql>` (or `--command "..."`), and `bunx cfman wrangler --account sccn whoami` to confirm. Never ask for a manual wrangler step before trying cfman. This supersedes the "no local wrangler login" claims in [[dev-worker-deploys-only-from-dev]] and [[prod-readonly-checks-via-installed-cli]].
