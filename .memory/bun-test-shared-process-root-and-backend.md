---
name: bun-test-shared-process-root-and-backend
description: "nemar-cli `bun test` from repo root runs test/ AND backend/test/ in ONE process; no bunfig.toml scopes them separately"
metadata: 
  node_type: memory
  type: project
  modified: 2026-09-01T19:09:05.297Z
---

Running `bun test` from the nemar-cli repo root (no `bunfig.toml` at either
level) picks up every `*.test.ts` recursively, so root `test/` and
`backend/test/` execute sequentially in the SAME process — confirmed via a
full run: 3975 tests across 270 files, ~207s (2026-09-01; the suite has grown since, and a full run
is about 80 minutes under load as of 2026-11-04, see `full-suite-80-minutes-and-three-baseline-failures.md`).

**Why:** this is the root cause behind cross-file test-isolation bugs like
issue #1175 (`test/maintenance-client.test.ts` assigns `undefined` to
`process.env.TEST_API_URL` in an unguarded `afterAll`, which JS coerces to
the literal string `"undefined"`, poisoning every later file in the same
run that reads `getApiUrl()`). A file that looks isolated when run alone can
still leak state into whatever runs after it in a full-suite run.

**How to apply:** when hunting test-isolation defects in this repo, don't
assume root and backend tests are separate processes — grep both trees
together, and reproduce suspected leaks with `bun test <fileA> <fileB>` runs
that deliberately mix root + backend, old + new files, in both orders.
`backend/node_modules` must be installed for backend/test files to resolve
at all (missing deps silently changes the pass/fail counts, not just error
messages) — confirm with a quick presence check (e.g. `ls backend/node_modules/hono`)
before trusting any full-suite number.

Also: `test/cli.test.ts` and `test/api.test.ts` are large pre-existing
integration suites that require `test/.env.test` (`TEST_ADMIN_API_KEY`,
`TEST_USER_API_KEY`) and live staging network access — in a bare worktree
without that file, ~50 of their tests fail on auth/network preconditions
(missing key, 429/503 from staging) unrelated to whatever branch is checked
out. Don't mistake that baseline noise for a regression; diff the specific
failing test names against a known-clean baseline if in doubt.
