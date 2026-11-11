---
name: docs-gate-needs-website-in-prod-first
description: "docs.nemar.org/admin gate and its sign-in page live in repos with different release cadences; the website must reach PRODUCTION before docs#32-style gate changes merge, or every admin page 302s to a 404"
metadata: 
  node_type: memory
  type: project
  modified: 2026-09-13T10:05:06.447Z
---

The `docs.nemar.org/admin/*` gate (epic #1336 phase 0) spans three repos, and two of them deploy on
different cadences. Getting the order wrong locks the admin docs shut with no way in.

- `nemarOrg/docs` is a git-connected Cloudflare Pages project: **merging to `main` IS the deploy**,
  immediately.
- `nemarOrg/website` hosts the sign-in page at `app.nemar.org/auth/docs/authorize`, and merging a PR
  only reaches the `staging` branch and its test deployment. Production needs the separate promotion described in
  [[website-release-prepare-first]].
- The backend routes (`/auth/docs/{grant,exchange,verify}`) ship with nemar-cli releases.

**Why:** the gate 302s an unauthenticated visitor to `app.nemar.org/auth/docs/authorize`. If that
page is not in production, the redirect lands on a 404 and every admin page is unreachable.
Measured 2026-09-13: that path returned 404 on production while the gate was still unmerged.

**Still true after epic #1336 closed (2026-09-14), with one addition:** `nemarOrg/docs` is now
PRIVATE at source, so a CI job that checks it out needs `DOCS_READ_TOKEN`, and that token is NOT
available on fork pull requests. The checkout is conditioned on the PR coming from this repo for
exactly that reason; do not remove the condition. See [[docs-are-the-retrieval-surface]].

**How to apply:** website to production first, verify `curl -o /dev/null -w '%{http_code}'
https://app.nemar.org/auth/docs/authorize` is a redirect and not 404, and only then merge the docs
gate. Immediately after the docs merge run `bun run probe:gate` against `docs.nemar.org`, never a
preview, because preview deployments are protected by a different mechanism than production (read
the Pages project's access policy in the Cloudflare dashboard to see it), so an anonymous probe of a
preview reports on that mechanism rather than on the gate. The same ordering
applies to phase 3, which moves runbooks behind the gate. See [[verify-fix-against-known-broken]]:
that probe accepted 404 as "refused" and so passed against a completely ungated site until fixed.
