---
name: epic-branch-ci-and-purge-lock
description: nemar-cli test.yml runs on PRs into main/dev and now feature/issue-*-epic-*; the zarr-python-test job installs its own deps (add new pure-Python imports there); standalone conversion-host tools must not wait on the cron lock during a drain
metadata:
  type: project
---

Learned on epic nemarOrg/nemar-cli#1181 (2026-09-02):
- `.github/workflows/test.yml` only ran on PRs into `main`/`dev`; phase PRs into an epic branch had NO CI until the pattern `feature/issue-*-epic-*` was added (commit 9386abf on the epic branch). Any new epic branch name must match that pattern.
- The `zarr-python-test` job is a fast tier that installs its own dependency list (no biosigio/mne/zarr by design); a new pure-Python import in `scripts/zarr` (e.g. `jsonschema`) must be added to that job's install step or its tests error in CI while a converter that degrades gracefully passes vacuously locally.
- `npm-publish.yml` publishes a prerelease on every branch push; that is deliberate.
- The production conversion cron holds its lock for the whole queue drain (hours to days). A standalone tool such as `purge_non_raw_stores.py` must not `flock` on it with a short wait; run it without the lock (the tool is idempotent and rewrites one dataset's index from the live copy) and re-run per dataset if one overlapped with a conversion.

**How to apply:** when opening an epic, check the workflow branch patterns first; when adding a Python dependency to scripts/zarr, edit the CI job too; when running one-off tools on the conversion host, check the host's running process list for a drain before deciding on the lock (the host and the lock path are in the systems inventory on the gated documentation site, admin operations).
