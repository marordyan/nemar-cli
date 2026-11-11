# ADR 0029: The Zarr conversion engine lives in nemar-cli, not the Actions repo

**Status:** accepted
**Amendment 2026-09-02:** The Consequences section below describes `hallu-zarr.sh` as
needing hand-placement with an atomic rename as an ongoing characteristic ("still has to be
hand-placed... because it must exist before the clone does"). That was accurate for the
transition moment this decision landed in, but is stale as a description of steady-state
operation: once the clone exists, cron invokes the CLONE's own copy of the script, and the
same `git reset --hard` that redeploys the Python driver redeploys `hallu-zarr.sh` too.
Hand-placement is only for bootstrapping a node that has no clone yet. See
`https://docs.nemar.org/admin/operations/systems-inventory/` §3.3 for the corrected, current description;
the decision text below is left as originally written.
**Date:** 2026-08-22
**Owner:** Seyed Yahya Shirazi

## Context

`scripts/zarr/` (the Zarr serving-copy converter, its SQLite queue, the Hallu driver script, and their tests) lived in `nemarDatasets/.github` because the conversion was originally designed to run as a GitHub Actions workflow, and ADR 0020 put dataset automation there so Actions minutes bill against the `nemarDatasets` Team allowance rather than the Free-plan tooling org.

That premise expired. Actions cannot sustain bulk or backfill conversion: a large dataset stalls past the 120-minute cap, which is why `run-generate-zarr.yml` capped at 120 minutes and why the engine moved to an hourly cron on SDSC Hallu. The Worker followed: `ZARR_AUTODISPATCH` was defaulted off with the note "the Hallu cron is the conversion engine," making `triggerZarrGeneration` unreachable in every environment. Only the code never moved.

The cost of leaving it was real, not theoretical. Every converter change was a cross-repo pull request; five landed in three days during epic #1095 alone. The deployed script on Hallu was a hand-copied file at `/data/projects/yahya/nemar/hallu-zarr.sh` rather than a checkout, this repo carried a stale 12.8 KB fork at `scripts/hallu-zarr.sh` that ran nowhere, and reconciling that drift already required its own commit (`nemarDatasets/.github` `a6fd52d`). Issue #1103 — that nothing enforces the webhook's `ZARR_DATA_EXTENSIONS` stays a superset of the converter's `PRIMARY_EXTS` — was unfixable by construction, because the two constants sat in different repositories and different languages with only a doc comment between them.

## Decision

**Code that does not run in GitHub Actions does not live in the Actions repo.** `scripts/zarr/` moves to `nemarOrg/nemar-cli`, and `run-generate-zarr.yml`, `test-generate-zarr.yml`, and the `triggerZarrGeneration` / `ZARR_AUTODISPATCH` dispatch path are retired. Manual per-dataset recovery is `hallu-zarr.sh --dataset <id>`, which has no 120-minute cap and is strictly better than the `workflow_dispatch` button it replaces. Hallu tracks a `nemar-cli` checkout, so the Python driver deploys itself on the next cron tick. `hallu-zarr.sh` itself is the exception and still has to be hand-placed with an atomic rename, because it must exist before the clone does; the script's own drift guard exists to catch that, and this move does not change it.

**This is a scoped carve-out from ADR 0020, not a supersede.** ADR 0020 remains accepted and continues to govern everything that genuinely runs as Actions against dataset repos: manifest, records, archive, BIDS validation, DOI, prescreen, onboarding. Its rejection of "keep workflows in `nemarOrg/nemar-cli`" was reasoned from Actions billing, and that reasoning does not reach an engine that runs on Hallu and bills no Actions minutes at all.

The rule is the same one already applied in the opposite direction: `.github/workflows/test.yml` records that the `emit_manifest.py` Python job moved *to* `nemarDatasets/.github` under #564 "where the workflow itself runs." Only the runner changed.

## Consequences

- Converter changes are ordinary single-repo pull requests with CI, and phases 2-5 of epic #1108 (the memory-robustness work) stop being cross-repo surgery. So do #1106 and the rest of epic #1095's converter work.
- #1103 becomes enforceable and is closed in the same change: `test/zarr-gate-superset.unit.test.ts` parses `PRIMARY_EXTS` / `COMPANION_EXTS` / `CTF_DS_EXT` / `MEFD_EXT` out of `scripts/zarr/generate_zarr.py` and asserts the webhook gate covers them in both directions.
- The three-way `hallu-zarr.sh` drift ends. There is one copy under version control and one deployment mechanism.
- **`patch_duration.py` moves too, because it imports the converter.** The Tier-2 duration backfill inside `generate-records.yml` does `sys.path.insert(..."zarr"); import generate_zarr` and calls `_run` and `materialize_recording`, so deleting `scripts/zarr/` from `.github` without moving it would have broken a live publish-path workflow. It ships here alongside the module it depends on, keeping the same `scripts/patch_duration.py` + `scripts/zarr/` relative layout, so no path surgery was needed. `generate-records.yml` gains an `actions/checkout` of `nemarOrg/nemar-cli` and runs the script from there. `emit_records.py` is unaffected: it only *mentions* the converter in comments and deliberately duplicates the helpers it needs.
- **The `biosigio` pin stays single-sourced.** Because the only `.github` consumer of it moved here with the converter, `scripts/zarr/requirements.txt` remains the one pin, now read from the nemar-cli checkout. `.github` needs no requirements file of its own.
- **A small amount of Actions billing moves from the Team-plan org to the Free-plan org**, since the converter's Python unit tests now run in this repo's `test.yml`. They install no dependencies (biosigIO and zarr are lazy-imported inside the I/O functions), so the cost is marginal against the existing suite.
- The Actions recovery button is gone. Anyone who reached for `workflow_dispatch` on `run-generate-zarr.yml` now needs shell access to Hallu. Acceptable, because that path could not finish a large dataset anyway.
- `isZarrTriggerPath` / `shouldDispatchZarr` survive with no caller. They are the executable statement of ADR 0027's raw-only contract and the subject of #1103's assertion, and are annotated in place so they are not later removed as dead code.

## Alternatives considered

- **Keep the scripts in `.github` and fix the memory bugs cross-repo.** No migration risk, but every fix stays a cross-repo pull request with no local dev loop, #1103 stays unfixable, and the hand-copy drift stays. Rejected: this is the status quo whose cost prompted the decision.
- **Move the scripts but keep `run-generate-zarr.yml`, checking out nemar-cli to get them.** Preserves a `workflow_dispatch` recovery button and the Team-plan billing. Rejected: it adds a cross-repo checkout to a production workflow in order to keep alive a path that is off by default and cannot finish a large dataset. Note the contrast with `generate-records.yml`, which *does* gain such a checkout: there the checkout buys a real dependency and single-sources the pin, rather than propping up a dead path.
- **Leave `patch_duration.py` in `.github` and check out nemar-cli only to satisfy its import.** Smaller diff there. Rejected: it separates a script from the module it imports and forces `.github` to carry a second `biosigio` pin that must be bumped in lockstep.
- **Copy to nemar-cli and leave `.github`'s copy in place as a fallback.** Cheapest immediately. Rejected: it recreates exactly the duplication that produced the stale `scripts/hallu-zarr.sh` fork, with two live copies instead of one live and one dead.
- **Preserve file history via `git subtree` instead of copying.** Keeps `git blame` across the move. Rejected as not worth the complexity here: phase pull requests squash-merge into the epic branch and would flatten it anyway, and `nemarDatasets/.github`'s own history remains the record. The source commit is named in the migration commit message instead.

## Receipts

- Migration commit records the source: `nemarDatasets/.github` @ `039045dfea8a30bb3d74846577fae3c00b535640`.
- `hallu-zarr.sh` moved byte-identical to the deployed copy (md5 `cd7421da955e890ad81cf698e04d6091`).
- ADR 0020 (central shared workflows) — carved out from, not superseded.
- ADR 0027 (raw-only dispatch) — why the gate functions survive the dispatcher.
- Issues: #1109 (this phase), #1108 (epic), #1103 (closed here), #1095 (the converter work this unblocks).
- `nemarDatasets/.github` `a6fd52d` "Reconcile hallu-zarr.sh with the deployed copy" — the drift, already paid for once.
