# ADR 0016: CI owns version bumping and tagging; humans never bump before a release PR

**Status:** accepted
**Date:** 2026-05 (backfilled 2026-07-31)
**Owner:** Seyed Yahya Shirazi

## Context

Three things must agree at release time: `package.json`, the git tag, and the npm release. A human doing this by hand desynchronises them sooner or later — bumping before opening a PR, tagging the wrong commit, or publishing a version the tag does not name.

## Decision

`dev` always carries an `X.Y.Z-devN` suffix and feature branches never touch the version. On merge to `main`, CI strips the suffix, commits as `nemar-bot`, tags `vX.Y.Z`, publishes to npm on the tag push, then merges main back into dev and advances it to the next `-dev0`.

**Do not run `bump-version.sh` before a dev to main PR.** Manual bumps cause tag/version skew with the automation. Manual bumps apply only to cutting a minor/major (on dev, before the PR) or tagging an intentional pre-release.

## Consequences

- The three artifacts cannot disagree, because one process writes all three.
- The release is not reproducible by hand; understanding it means reading the workflows, and debugging a stuck release means debugging CI.
- A bot-authored commit pushes to `main`, so a job-level author guard is required or the workflow retriggers itself.
- **`[skip ci]` is deliberately NOT used** in the strip commit: GitHub's skip marker would also suppress the tag-push event that triggers publishing. This looks like an oversight and is not.
- `main` requires a stricter check set than `dev` (`lint`, `unit-pure`, `integration-dev`), so a red integration run on dev silently blocks promotion. Get dev green first.

## Alternatives considered

- **Manual bump and tag:** transparent, and exactly what produced version/tag skew. Rejected.
- **Release-please or similar:** more machinery and another config surface for a two-branch flow this small. Rejected as disproportionate.

## Receipts

- `https://docs.nemar.org/develop/release-pipeline/` and `.rules/release-and-repull.md` (formerly AGENTS.md "Version Bumping and Release")
- `.github/workflows/auto-tag.yml`, `npm-publish.yml`, `sync-dev.yml`; `scripts/bump-version.sh`

## Amendment 2026-10-04 (#1610): privacy corrections

Version tags are moved only by CI, with one exception: during a privacy correction ([ADR 0085](0085-a-privacy-correction-scrubs-every-version-in-place.md)) an administrator briefly lifts the per-repository tag ruleset, force-pushes the rewritten tags, and restores the ruleset.
