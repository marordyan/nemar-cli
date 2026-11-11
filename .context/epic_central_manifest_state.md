# Epic state: Centralize manifest generation (PR-1)

> **Decision recorded:** [ADR 0020 - Dataset automation runs from central shared workflows](decisions/0020-dataset-automation-runs-from-central-shared-workflows.md).
> This document holds the wire contracts (dispatch payload, callback shape, artifact keys).


> **STATUS: HISTORICAL.** Epic state file for #559, now merged. The wire contracts remain accurate; the ops sequence references the retired personal Cloudflare account (see ADR 0008).
> Current decisions live in [`.context/decisions/`](decisions/README.md); where this document and an ADR disagree, the ADR wins.

integration_branch: dev
epic_issue: 559
epic_branch: feature/issue-559-epic-central-manifest
epic_worktree: <repo root>/../epic-central-manifest
merge_strategy_phase_to_epic: squash
merge_strategy_epic_to_integration: merge

## Scope

Implements PR-1 of the 4-PR phasing in #557:

- **#556**: replace API-per-pointer manifest algorithm with git-tree walk
- **#557 (PR-1 only)**: build central `repository_dispatch` workflow on `nemarOrg/nemar-cli`; keep old `generateManifest()` path as fallback behind a feature flag
- **#558**: emit `summary.json` alongside `manifest.json`; add `GET /<id>/<version>/summary.json` route; backfill the 5 recovered datasets

Out of scope for this epic (later PRs):
- **PR-2** (#557): dual-write phase, manifest comparison
- **PR-3** (#557): cutover, delete per-repo workflows, remove worker fallback
- **PR-4** (#557): migrate `generate-archive` to central workflow

## Three parallel streams

| Stream | Branch | Worktree | Files | Owner |
|---|---|---|---|---|
| A — Generator | feature/issue-556-stream-a-generator | epic-central-manifest-stream-a | `scripts/emit_manifest.py`, `.github/workflows/generate-manifest.yml` | TBD |
| B — Worker dispatch | feature/issue-557-stream-b-worker | epic-central-manifest-stream-b | `backend/src/services/github.ts`, `backend/src/routes/webhooks.ts` | TBD |
| C — Serving + backfill | feature/issue-558-stream-c-serving | epic-central-manifest-stream-c | `backend/src/routes/data.ts`, `scripts/backfill-summaries.sh` | TBD |

Each stream merges (squash) into the epic branch. After all three land, one epic→dev PR with E2E test + `/review-pr`.

## Contract: artifacts on S3

```
s3://nemar/<id>/version/v<X.Y.Z>.json           # existing manifest.json (unchanged shape)
s3://nemar/<id>/version/v<X.Y.Z>-summary.json   # NEW, sibling key
```

## Contract: manifest.json shape (unchanged from VersionManifest)

```json
{
  "dataset_id": "on005261",
  "version": "1.0.0",
  "doi": "10.82901/nemar.on005261.v1.0.0",
  "concept_doi": "10.82901/nemar.on005261",
  "created": "2026-05-18T...Z",
  "files": {
    "<path>": { "key": "<annexkey>|git:<sha>", "size": <int>, "checksum": "<algo>:<hex>" }
  }
}
```

## Contract: summary.json shape (NEW, per #558)

```json
{
  "schema_version": "1.0",
  "dataset_id": "on005261",
  "version": "1.0.0",
  "doi": "10.82901/nemar.on005261.v1.0.0",
  "concept_doi": "10.82901/nemar.on005261",
  "created": "2026-05-18T...Z",
  "totals": { "files": 14536, "bytes": 241618664825, "subjects": 17 },
  "modalities": ["meg", "beh"],
  "subjects": ["sub-01", "sub-02"],
  "readme": { "path": "README.md" } | null,
  "paths": ["README.md", "dataset_description.json", "sub-01/meg/..."]
}
```

Notes:
- `paths` is a flat array, sorted, all non-internal entries.
- `subjects` derived from top-level `sub-XXX/` prefixes.
- `modalities` derived from datatype directories (`eeg`, `emg`, `meg`, `func`, `anat`, `dwi`, `fmap`, `beh`, `ieeg`, `pet`, `perf`, `motion`).
- `totals.bytes` is the SUM of `files[*].size` from the manifest.
- `readme` is the path to whichever README the BIDS root has (`README`, `README.md`, `README.txt` — first match).
- NO per-entry presigned URLs, NO per-entry checksums (use manifest.json for that).

## Contract: dispatch payload (worker → central workflow)

```json
{
  "event_type": "generate-manifest",
  "client_payload": {
    "dataset_id": "nm099999",
    "version": "1.0.0",
    "doi": "10.82901/nemar.nm099999.v1.0.0",
    "concept_doi": "10.82901/nemar.nm099999",
    "callback_token": "<one-shot HMAC token>",
    "callback_url": "https://api.nemar.org/webhooks/manifest-ready",
    "skip_canary": false
  }
}
```

`callback_token` is a Workers-side HMAC over `{dataset_id, version, nonce}` signed with `MANIFEST_CALLBACK_SECRET`. Validated server-side on callback; one-shot via a `manifest_jobs` row or just a 5-minute cache key.

`skip_canary` (added during Stream A implementation) is the dispatch-path twin of `skipGitBackedVerification` on the inline `generateManifest()`. Worker always sets `true` at publish time because the central workflow's `raw.githubusercontent.com` canary races GitHub Pages propagation; the canary is redundant when the publish webhook is the authoritative caller.

## Contract: callback (central workflow → worker)

```
POST /webhooks/manifest-ready
X-Webhook-Token: <callback_token from dispatch>
{
  "dataset_id": "nm099999",
  "version": "1.0.0",
  "manifest_url": "https://nemar.s3.us-east-2.amazonaws.com/nm099999/version/v1.0.0.json",
  "summary_url": "https://nemar.s3.us-east-2.amazonaws.com/nm099999/version/v1.0.0-summary.json",
  "totals": { "files": ..., "bytes": ..., "annex": ..., "git": ... },
  "workflow_run_id": "...",
  "canary_skipped": true | false   // optional; Stream A fix round
}
```

`canary_skipped` echoes the `skip_canary` dispatch flag (#557 Stream A
fix round). Optional for back-compat with older Stream A runs; worker
logs it in the manifest-ready handler but does not persist it (no
column on `manifest_jobs` in migration 0025).

Worker validates token, HEAD-checks both S3 URLs return 200, inserts `dataset_versions` row, mints DOI (if not already minted by the dispatching caller).

## Contract: feature flag

`MANIFEST_VIA_CENTRAL_WORKFLOW` (Worker env var, default `false`).

- `false` → old path: `generateManifest()` inline, immediate insert into `dataset_versions`, immediate DOI mint.
- `true` → new path: `triggerManifestGeneration()` dispatch, return immediately, callback completes the row.

Flip per-environment for staged rollout. Start with `dev` (SCCN account), then prod after a week of clean runs.

## Contract: central workflow secrets needed on `nemarDatasets`

Relocated from `nemarOrg/nemar-cli` in #564 — Actions minutes now bill
against the GitHub Team plan on `nemarDatasets`, not the constrained
Free-plan tooling org. The workflow file lives at
`nemarDatasets/.github/.github/workflows/generate-manifest.yml`.

Required secrets at the nemarDatasets ORG level (visibility: all repos),
so both the central `.github` repo and the dataset repos inherit them:

- `NEMAR_APP_ID` — already present (Epic #432)
- `NEMAR_APP_PRIVATE_KEY` — already present (Epic #432)
- `AWS_ACCESS_KEY_ID` — already present (used by onboard-openneuro.yml)
- `AWS_SECRET_ACCESS_KEY` — already present (used by onboard-openneuro.yml)
- `MANIFEST_CALLBACK_SECRET` — NEW: symmetric secret matching Worker

Ops sequence (USER STEP, BLOCKS flag flip):
1. Verify the four already-present secrets are at ORG level (visibility:
   all repos) — `gh secret list --org nemarDatasets`
2. `gh secret set MANIFEST_CALLBACK_SECRET --org nemarDatasets --visibility all`
   (use the same value as the Workers secret below)
3. `npx cfman wrangler --account <retired personal account> -c backend/wrangler.toml secret put MANIFEST_CALLBACK_SECRET`
   then same for `--env dev`
4. `npx cfman wrangler --account sccn -c backend/wrangler-sccn.toml secret put MANIFEST_CALLBACK_SECRET`
   then same for `--env dev`
5. Apply migration 0025 to D1 (both accounts, prod + dev)

## Acceptance for epic → dev PR

- [ ] `nemar admin e2e-test --verbose` passes against dev with `MANIFEST_VIA_CENTRAL_WORKFLOW=true`
- [ ] Both `v1.0.0.json` and `v1.0.0-summary.json` written to S3 for `nm099999`
- [ ] `https://data.nemar.org/nm099999/1.0.0/summary.json` returns 200 with documented shape
- [ ] `https://data.nemar.org/nm099999/1.0.0/manifest.json` still returns the existing per-file presigned-URL shape (back-compat unchanged)
- [ ] `dataset_versions` row inserted via `/webhooks/manifest-ready` callback, not inline
- [ ] Feature flag `MANIFEST_VIA_CENTRAL_WORKFLOW=false` still routes through old `generateManifest()` (fallback verified)
- [ ] 5 recovered datasets backfilled with summary.json
- [ ] Zero GitHub API calls in the manifest generation path under the flag-on configuration
- [ ] `/review-pr` clean (all findings addressed)

## Phases

| # | Stream | Issue | Branch | Worktree | PR | Status |
|---|---|---|---|---|---|---|
| A | Generator | 556 + part of 558 | feature/issue-556-stream-a-generator | epic-central-manifest-stream-a | 560 (squashed 4318140) | merged into epic |
| B | Worker dispatch | 557 (PR-1 worker side) | feature/issue-557-stream-b-worker | epic-central-manifest-stream-b | 562 (squashed b1624f1) | merged into epic |
| C | Serving + backfill | 558 (serve + backfill) | feature/issue-558-stream-c-serving | epic-central-manifest-stream-c | 561 (squashed 2141c7d) | merged into epic |
| Z | Epic E2E + review | 559 | feature/issue-559-epic-central-manifest | epic-central-manifest | TBD | epic→dev PR open |

current_phase: epic→dev PR open; awaiting /review-pr + E2E + ops secrets
