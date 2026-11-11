---
name: biosigio-landing-policy
description: biosigio PRs land directly on main with a PATCH version bump after tests and review, and every change needs real-data tests (download-on-demand, skip offline)
metadata:
  type: feedback
---

The owner's standing rule for the biosigio repository (stated 2026-09-02 during epic nemarOrg/nemar-cli#1181): once tests and a review pass, land the PR directly on `main` with a patch version bump (biosigio bumps by hand: `chore: bump version to X.Y.Z`, tag `vX.Y.Z`, `publish.yml` fires on the tag). Tests-only PRs merge without a bump. Every behavioural change must carry a real-data test, not only synthetic fixtures: small real fixtures are committed (FIF, CTF, BTi), large NEMAR recordings are fetched on demand from `https://data.nemar.org/<id>/<path>` into a git-ignored cache and the test skips offline or when `BIOSIGIO_REAL_DATA` is unset.

**Why:** biosigio is the converter's read path; a synthetic fixture that passes has repeatedly hidden bugs that only real recordings expose (column-form chanlocs #110, MemoryError re-typing #123, unit relabelling #122).

**How to apply:** when delegating a biosigio change, require the real-data test in the brief, wait for CI plus a review, then squash to main, bump the patch version, tag and confirm `publish.yml`. Then bump `scripts/zarr/requirements.txt` in nemar-cli and remember the engine-version bump (ADR 0033) is what reaches the back catalog. See [[annex-worktree-git-symlink]] for worktree cleanup.
