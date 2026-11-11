# ADR 0015: git-annex takes data files only; metadata always stays in plain git

**Status:** accepted
**Date:** 2026-01-14
**Owner:** Seyed Yahya Shirazi

Amended by [ADR 0031](0031-the-annex-policy-has-one-source-and-data-may-wear-a-metadata-extension.md),
which carves out data that wears a metadata extension (`*_motion.tsv`) and moves the
policy into a single module. The decision below stands.

## Context

git-annex replaces a tracked file with a symlink to content-addressed storage. That is right for multi-gigabyte recordings and wrong for everything a human or a machine needs to *read* from the repository. A size-only rule (`largerthan=100kb`) annexes whichever `.tsv` or `.json` happens to be large, and anything annexed becomes a symlink that GitHub cannot render — including workflow files, which then silently stop working.

## Decision

`annex.largefiles` is configured to annex recognised **data** extensions (`.edf`, `.bdf`, `.set`, `.fif`, `.vhdr`, `.eeg`, `.cnt`, `.fdt`) or files over 100 kB, **and** to explicitly exclude metadata regardless of size: `.tsv`, `.json`, `.md`, `.txt`, `.yml`, `.yaml`, `README*`, `LICENSE*`, `CHANGES*`, `.bidsignore`, `.gitignore`.

The `git-annex` branch must be pushed alongside `main` so clones can resolve remotes.

## Consequences

- BIDS sidecars, READMEs, and CI workflows stay readable on GitHub and in a metadata-only clone. `nemar dataset clone` is useful without fetching any data.
- Validation and enrichment can read a dataset's structure without an S3 round trip.
- The exclusion list is extension-based, so a new metadata format needs adding to it or it silently gets annexed. The mirror image also bites: a *data* format that happens to use a metadata extension gets silently un-annexed, which is what happened to Motion-BIDS `_motion.tsv` (ADR 0031).
- Forgetting to push the `git-annex` branch produces clones that cannot locate content — a confusing failure that looks like missing data.
- Content moves with `git annex copy --from --to`, never `aws s3 cp`: the latter transfers bytes without updating the location log, so annex then believes content is somewhere it is not.

## Alternatives considered

- **Size threshold only:** simplest, but annexes large sidecars and workflow files, breaking GitHub rendering and CI. This is the configuration that actually bit us. Rejected.
- **Annex everything:** uniform, but makes the repository unreadable without a data fetch and defeats metadata-only clone. Rejected.

## Receipts

- `https://docs.nemar.org/admin/operations/validated-workflows/` — validated 2026-01-14
- The validated workflows page above (formerly AGENTS.md "Full E2E PR Workflow")
