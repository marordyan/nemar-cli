# NEMAR CLI Development Plan

> **Decisions recorded:** [ADR 0021 - The API token is the master credential](decisions/0021-the-api-token-is-the-master-credential.md), [ADR 0001 - Published datasets are PR-only](decisions/0001-dataset-changes-go-through-pull-requests.md).
> Note: the "Storage Strategy" section below still lists Zenodo for DOIs — superseded by [ADR 0007](decisions/0007-ezid-is-the-sole-doi-provider.md).


> **STATUS: HISTORICAL.** Development phases through Phase 7. Phase status is a record of what was done, not a to-do list, and several sections (Storage Strategy, Open Questions) name choices later reversed.
> Current decisions live in [`.context/decisions/`](decisions/README.md); where this document and an ADR disagree, the ADR wins.

## Project Overview
**Goal:** Build a comprehensive CLI for NEMAR (Neuroelectromagnetic Data Archive and Tools Resource) dataset management; similar to OpenNeuro CLI but with **PR-mandatory versioning**, enhanced authentication, admin workflows, and DataLad/S3 integration
**Stack:** TypeScript, Bun, Commander.js, Cloudflare Workers/D1, DataLad, AWS S3, GitHub API

### Key Differentiators from OpenNeuro
1. **PR-Mandatory**: All changes require pull requests (main branch protected)
2. **Collaborative**: Any user can propose changes to any public dataset
3. **Staged Data**: Data PRs use temporary S3 staging before merge
4. **Serial IDs**: Centrally managed dataset IDs (nm000XXX)

### Architecture Documents
- `.context/access_control.md` - Granular GitHub/S3 access control
- `.context/pr_architecture.md` - PR-mandatory workflow design
- `.context/dataset_workflow.md` - Dataset ID management and PR flow

---

## Phase 1: Foundation [COMPLETED]
**Status:** Done
**Description:** Project scaffolding and basic CLI structure

### Completed Tasks
- [x] Initialize project structure with vibe-rules templates
- [x] Set up TypeScript project with Bun
- [x] Create package.json with CLI entry point for bunx
- [x] Configure TypeScript and linting (biome)
- [x] Set up basic CLI framework with commander.js
- [x] Create initial command structure skeleton (auth, dataset, admin)
- [x] Add .gitignore and project documentation
- [x] Create CLAUDE.md with project context
- [x] Set up .context/ and .rules/ directories

### Artifacts
- `src/index.ts` - Main CLI entry point
- `src/commands/auth.ts` - Authentication command stubs
- `src/commands/dataset.ts` - Dataset command stubs
- `src/commands/admin.ts` - Admin command stubs
- `src/lib/config.ts` - Configuration management

---

## Phase 2: Backend Infrastructure [COMPLETED]
**Status:** Done
**Description:** Cloudflare Workers backend with D1 database for user and token management

### Deployment Info
- **URL:** https://api.nemar.org (the worker is also mounted at `/nemar`; the old
  `api.osc.earth/nemar` spelling now 404s and `src/lib/config.ts` migrates stored configs off it)
- **Database:** D1 `nemar-db` (`<D1 database id>`)
- **Rate Limit KV:** `<KV namespace id>`
- **Email:** Resend, sending as `noreply@nemar.org` (`DEFAULT_FROM_EMAIL`, overridable by `FROM_EMAIL`)

### Completed Tasks
- [x] Create Cloudflare Workers project structure (`backend/`)
- [x] Design and implement D1 database schema (users, tokens, datasets, id_sequence, audit_log)
- [x] Implement user registration endpoint (POST /auth/signup)
- [x] Set up email verification system (Resend API, nemar@osc.earth sender)
- [x] Create API key generation logic (SHA-256 hashed, prefix stored)
- [x] Implement authentication middleware (Bearer token validation)
- [x] Add admin endpoints (list users, approve, revoke)
- [x] Add dataset endpoints (create, list, get)
- [x] Implement rate limiting middleware (KV-based)
- [x] Deploy to Cloudflare Workers
- [x] Create admin user (the owner)
- [x] Set all secrets (GITHUB_ADMIN_PAT, AWS credentials, RESEND_API_KEY)
- [x] Add description field to signup (reason for needing NEMAR access)
- [x] Add admin notification email when user verifies email and needs approval
- [x] Add rate limit bypass for CI/CD testing (X-Test-Bypass header)

### API Endpoints Implemented
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /auth/signup | None | Register new user |
| GET | /auth/verify | None | Email verification link |
| POST | /auth/login | None | Validate API key |
| POST | /auth/resend-verification | None | Resend verification email |
| GET | /users/me | User | Get current user info |
| GET | /admin/users | Admin | List users (filter by status) |
| POST | /admin/approve/:username | Admin | Approve user, generate token |
| POST | /admin/revoke/:username | Admin | Revoke user access |
| POST | /datasets | User | Create dataset |
| GET | /datasets | Public | List datasets |
| GET | /datasets/:id | Public | Get dataset info |

### Artifacts
- `backend/src/index.ts` - Hono app entry point
- `backend/src/routes/auth.ts` - Authentication routes
- `backend/src/routes/admin.ts` - Admin routes
- `backend/src/routes/datasets.ts` - Dataset routes
- `backend/src/routes/users.ts` - User routes
- `backend/src/middleware/auth.ts` - API key validation
- `backend/src/middleware/rateLimit.ts` - Rate limiting
- `backend/src/services/email.ts` - Resend email (fetch-based)
- `backend/src/services/password.ts` - bcrypt hashing
- `backend/src/services/token.ts` - API key generation
- `backend/src/services/github.ts` - GitHub collaborator management
- `backend/src/services/s3.ts` - S3 presigned URLs
- `backend/src/db/migrations/0001_initial.sql` - Database schema
- `backend/.dev.vars` - Local development secrets (gitignored)

---

## Phase 3: Authentication System (CLI) [COMPLETED]
**Status:** Done
**Description:** CLI authentication commands that connect to backend

### Completed Tasks
- [x] Implement `nemar auth login` with API key validation (interactive + `-k` flag)
- [x] Implement `nemar auth signup` with interactive prompts
- [x] Add description field to signup (why user needs NEMAR access)
- [x] Add environment variable support (NEMAR_API_KEY)
- [x] Implement `nemar auth status` with backend query (`--refresh` flag)
- [x] Implement `nemar auth logout` with confirmation
- [x] Implement `nemar auth resend-verification` for failed verifications
- [x] Cross-platform config storage (Conf library with NEMAR_CONFIG_DIR override)
- [x] Write CLI integration tests (18 tests passing)
- [x] Write API integration tests (31 tests passing)

### Test Infrastructure
- **Total Tests:** 49 (31 API + 18 CLI)
- **CI/CD:** GitHub Actions workflow (`.github/workflows/test.yml`)
- **Rate Limit Bypass:** X-Test-Bypass header for CI testing
- **Test Isolation:** Each test uses unique config directory

### Artifacts
- `src/commands/auth.ts` - All auth commands
- `src/lib/api.ts` - Backend API client
- `src/lib/config.ts` - Cross-platform config management
- `test/api.test.ts` - API integration tests
- `test/cli.test.ts` - CLI integration tests
- `test/setup.ts` - Test utilities and configuration

---

## Phase 4: BIDS Validation [COMPLETED]
**Status:** Done
**Description:** BIDS validation via Deno subprocess, always using latest validator

### Implementation Notes
- Uses Deno subprocess (`deno run jsr:@bids/validator`) for validation
- Always pulls latest validator from JSR (currently v2.2.7)
- Requires Deno runtime (provides install instructions if missing)
- Parses JSON output from validator for structured results

### Completed Tasks
- [x] Research bids-validator integration options (JSR package via Deno)
- [x] Implement `nemar dataset validate` command
- [x] Add validation configuration file support (`--config`)
- [x] Create clear error/warning output with colors
- [x] Add `--json` output flag for programmatic use
- [x] Add `--recursive` flag for derivatives validation
- [x] Add `--prune` flag for faster validation
- [x] Add `--version-info` to show validator version
- [x] Write 6 validation tests (55 total tests)

### Command Options
```bash
nemar dataset validate <path>
  --ignore-warnings    Only report errors, not warnings
  -c, --config <file>  Validation config file (.bidsvalidatorrc)
  -r, --recursive      Validate derivatives subdirectories
  --prune              Skip sourcedata and derivatives for faster validation
  -v, --verbose        Show verbose output
  --json               Output results as JSON
  --version-info       Show BIDS validator version
```

### Artifacts
- `src/lib/bids-validator.ts` - Deno subprocess wrapper
- `src/commands/dataset.ts` - Validate command implementation

---

## Phase 5: Dataset Upload [COMPLETED]
**Status:** Done
**Description:** Implement dataset upload workflow with DataLad, S3, and GitHub

### Implementation Notes
- Uses SSH for GitHub uploads (better performance for large datasets)
- Parallel upload processing with 8 streams by default (`-j/--jobs` flag)
- Prerequisites check: DataLad, git-annex, GitHub SSH, AWS credentials
- Largefiles pattern configured BEFORE adding files (critical)
- Branch protection applied after initial upload via finalize endpoint

### Completed Tasks
- [x] Create DataLad service (`src/lib/datalad.ts`)
- [x] Check tool installation (DataLad, git-annex, GitHub SSH, AWS)
- [x] Create DataLad dataset from BIDS directory
- [x] Configure git-annex largefiles pattern
- [x] Add S3 special remote configuration with signature v4
- [x] Create GitHub repository automation (via backend)
- [x] Parallel upload to S3 (`git annex copy --to -J 8`)
- [x] Push git-annex branch (critical for cloning)
- [x] Implement `nemar dataset upload` command with all options
- [x] Add POST /datasets/:id/finalize endpoint
- [x] Write 3 integration tests for upload command

### Command Options
```bash
nemar dataset upload <path>
  -n, --name <name>           # Dataset name (default: directory name)
  -d, --description <desc>    # Dataset description
  --skip-validation           # Skip BIDS validation (not recommended)
  --dry-run                   # Show what would be uploaded
  -j, --jobs <number>         # Parallel upload streams (default: 8)
  -y, --yes                   # Skip confirmation prompt
```

### Artifacts
- `src/lib/datalad.ts` - DataLad/git-annex service
- `src/commands/dataset.ts` - Upload command implementation
- `src/lib/api.ts` - createDataset, finalizeDataset methods
- `backend/src/routes/datasets.ts` - finalize endpoint

### Dependencies
- DataLad >= 0.19.0 and git-annex >= 10.0 installed
- GitHub SSH access configured
- Backend provides AWS credentials (users don't need local AWS config)

---

## Phase 6: Dataset Download and Status [COMPLETED]
**Status:** Done
**Description:** Implement dataset download and status checking

### Implementation Notes
- Download requires fewer prerequisites than upload (no AWS credentials, no GitHub SSH)
- Uses DataLad clone + get for seamless data retrieval from S3
- Status and list commands query the backend API

### Completed Tasks
- [x] Implement `nemar dataset download` command with parallel data fetching
- [x] Add `--no-data` option for metadata-only download
- [x] Add `-j/--jobs` option for parallel download streams (default: 4)
- [x] Implement `nemar dataset status` command with `--json` output
- [x] Implement `nemar dataset list` command with `--mine` and `--json` options
- [x] Add checkDownloadPrerequisites() for simpler prereq check
- [x] Write 10 CLI tests for download/status/list commands

### Command Options
```bash
nemar dataset download <dataset-id>
  -o, --output <path>    # Output directory (default: ./<dataset-id>)
  -j, --jobs <number>    # Parallel download streams (default: 4)
  --no-data              # Download metadata only (no large files)

nemar dataset status <dataset-id>
  --json                 # Output as JSON

nemar dataset list
  --mine                 # List only your datasets (requires auth)
  --json                 # Output as JSON
  --limit <n>            # Limit number of results (default: 50)
```

### Artifacts
- `src/lib/datalad.ts` - Added cloneDataset, getDatasetData, getLocalDatasetInfo
- `src/commands/dataset.ts` - Download, status, list command implementations
- `test/cli.test.ts` - 10 new tests for download/status/list

---

## Phase 7: Pull Request Workflow [COMPLETED]
**Status:** Done
**Description:** PR-mandatory versioning system with owner self-merge capability

### Key Design Decision
Owner can merge their own PRs (no external approval required), but BIDS validation and version checks must pass. This provides audit trail and quality gates without blocking owner autonomy.

### Implementation Notes
- **GitHub as source of truth** - No separate database tables for PRs
- **GitHub Actions** handle all automation (validation, version check, releases)
- **S3 versioning enabled** - Safety net for data recovery
- **Simplified workflow** - Users can use GitHub UI directly

### Completed Tasks
- [x] Update branch protection: `required_approving_review_count: 0` (owner self-merge)
- [x] Add required status checks: `bids-validation`, `version-check`
- [x] Set `enforce_admins: false` (admins can bypass if needed)
- [x] Create `deployWorkflows()` function in github.ts
- [x] Create workflow templates:
  - `bids-validation.yml` - BIDS validation on PR
  - `version-check.yml` - Ensure version bumped in dataset_description.json
  - `pr-merge.yml` - Create tag/release on merge, cleanup staging on close
- [x] Integrate workflow deployment into finalize endpoint

### GitHub Actions Workflows
Each dataset repository gets 3 workflows deployed on finalize:

1. **bids-validation.yml** - Runs BIDS validator via Deno on every PR
2. **version-check.yml** - Ensures Version field is incremented
3. **pr-merge.yml** - On merge: creates git tag and GitHub release; on close: cleans up staging

### Branch Protection Rules
```yaml
required_pull_request_reviews:
  required_approving_review_count: 0
  dismiss_stale_reviews: true
enforce_admins: false
required_status_checks:
  strict: true
  contexts: ["bids-validation", "version-check"]
allow_force_pushes: false
allow_deletions: false
```

### Artifacts
- `backend/src/services/github.ts` - deployWorkflows(), createOrUpdateFile(), updated applyBranchProtection()
- `backend/src/routes/datasets.ts` - Workflow deployment in finalize endpoint

### How It Works
1. User uploads dataset → finalize deploys workflows and protection
2. User clones, creates branch, makes changes, opens PR
3. GitHub Actions run bids-validation and version-check
4. If both pass, owner can merge their own PR
5. On merge: pr-merge.yml creates tag and release automatically

---

## Phase 8: DOI Management [COMPLETED]
**Status:** Done
**Description:** Zenodo integration for DOI creation and versioning

### Implementation Notes
- **Concept DOI:** Created by admin only via `nemar admin doi create`
- **Version DOI:** Created automatically on GitHub release (PR merge workflow)
- DOIs are PERMANENT and cannot be deleted (Zenodo limitation)
- Sandbox mode supported via `--sandbox` flag for testing
- Webhook endpoint for GitHub Actions to publish version DOIs

### Completed Tasks
- [x] Implement Zenodo API client (`backend/src/services/zenodo.ts`)
- [x] Add database migration for zenodo columns (`zenodo_concept_id`, `zenodo_latest_version_id`)
- [x] Create `nemar admin doi create` command with confirmation prompt
- [x] Create `nemar admin doi info` command
- [x] Add admin endpoints: GET/POST `/admin/datasets/:id/doi`
- [x] Add webhook endpoint: POST `/webhooks/publish-version-doi`
- [x] Update pr-merge workflow to auto-publish version DOIs
- [x] Add tests for DOI endpoints (84 total tests)

### Command Options
```bash
nemar admin doi create <dataset-id>
  --title <title>      # DOI title (default: dataset name)
  --sandbox            # Use Zenodo sandbox for testing

nemar admin doi info <dataset-id>
  --json               # Output as JSON
```

### API Endpoints
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /admin/datasets/:id/doi | Admin | Get DOI info |
| POST | /admin/datasets/:id/doi/concept | Admin | Create concept DOI |
| POST | /admin/datasets/:id/doi/publish | Admin | Publish version DOI |
| POST | /webhooks/publish-version-doi | Webhook | GitHub Actions webhook |

### Artifacts
- `backend/src/services/zenodo.ts` - Zenodo API client
- `backend/src/routes/webhooks.ts` - GitHub Actions webhook route
- `backend/src/db/migrations/0002_zenodo.sql` - Database migration
- `src/commands/admin.ts` - DOI CLI commands

### Required Secrets
- `ZENODO_API_KEY` - Production Zenodo API token
- `ZENODO_SANDBOX_API_KEY` - Sandbox Zenodo API token (optional)
- `GITHUB_WEBHOOK_SECRET` - Webhook auth for GitHub Actions
- `NEMAR_WEBHOOK_TOKEN` - Repository secret for each dataset repo

---

## Phase 9: Admin Commands [COMPLETED]
**Status:** Done
**Description:** Admin functionality for user and dataset management

### Completed Tasks
- [x] Implement `nemar admin users` command (list users with filters: `--pending`, `--verified`, `--approved`, `--revoked`)
- [x] Implement `nemar admin approve <username>` command
- [x] Implement `nemar admin revoke <username>` command
- [x] Add credential cascade (token revocation on user revoke)
- [x] Admin notification emails when users need approval
- [x] Write tests for admin commands

### Artifacts
- `src/commands/admin.ts` - Admin CLI commands
- `backend/src/routes/admin.ts` - Admin API endpoints
- Tests in `test/api.test.ts` and `test/cli.test.ts`

---

## Phase 10: Polish and Release
**Status:** In Progress
**Description:** Documentation, testing, CI/CD, and npm publishing

### Completed Tasks
- [x] Create README with architecture diagrams and command reference
- [x] Set up GitHub Actions CI/CD (`.github/workflows/test.yml`)
- [x] Write integration tests (49 tests passing)

### Remaining Tasks
- [ ] Add test coverage reporting and reach 90% target (Issue #1)
- [ ] Add shell completion scripts (bash, zsh, fish)
- [ ] Publish to npm
- [ ] Create release notes

### Related Issues
- GitHub Issue #1: Test coverage tracking and 90% target

---

## Sprint: Issues #51, #56, #58, #68 (Jan 2026)

Cross-cutting sprint implementing DataLad-like commands, publication workflow,
BIDS CI integration, and versioning architecture.

### Phase 1: Admin Command Restructuring [COMPLETED]
**PR:** #69 | **Closes:** #68 Phase 1
- Restructured admin commands into subgroups: `admin s3`, `admin repo`, `admin ci`
- Added `admin ci add/check`, `admin repo public/private`
- Moved `regenerate-iam` under `admin s3`

### Phase 2: Publication Workflow [COMPLETED]
**PR:** #70 | **Closes:** #68 Phase 2+3
- D1 schema: `publication_requests` table with step tracking
- User commands: `dataset publish request/status/resend`
- Admin commands: `admin publish list/approve/deny`
- 5-step orchestrator with `--resume` support
- Email notifications at each stage

### Phase 3: DataLad-like Commands [COMPLETED]
**PR:** #73 | **Closes:** #58
- `dataset clone <id>` - Clone dataset repo
- `dataset get [files]` - Download annexed files
- `dataset save [-m msg]` - Stage + commit changes
- `dataset push` - Push to GitHub + S3
- `dataset drop [files]` - Remove local copies
- Pure git-annex (no DataLad dependency)

### Phase 4: BIDS CI at Upload + PR Workflow [COMPLETED]
**PR:** #74 | **Closes:** #51, #68 Phase 4
- Auto-deploy BIDS CI workflow after upload finalization
- `push --pr --title --body` for PR creation from CLI
- `dataset ci [id]` command with auto-detection from git remote
- User-accessible `GET /datasets/:id/ci/status` endpoint
- E2E validated with nm099999

### Phase 5: Versioning, Tags, Manifests [IN PROGRESS]
**Closes:** #56
- [ ] Version manifest generation (JSON: files -> S3 annex keys)
- [ ] Upload manifests to S3 at `version/v*.json`
- [ ] GitHub tag protection rules for dataset repos
- [ ] `nemar admin s3 lock` command (already implemented in backend)
- [ ] Integrate manifest generation into DOI/publish workflow
- [ ] CLI command to view/compare manifests

**Key insight:** Git-annex content-addressed storage + git tags already provides
versioning. Manifests add web-frontend access without git clone. S3 Object Lock
(already implemented) prevents deletion of DOI-referenced data.

---

## Metadata Pipeline Architecture (Issue #154, PR #152)
**Status:** Implemented
**Description:** Staged metadata enrichment pipeline where `.nemar/metadata.json` is the single source of truth for DOI records

### Design

`.nemar/metadata.json` is built through a staged pipeline. Each stage adds or refines metadata, and the file tracks its current stage via `pipeline_stage`.

```
dataset_description.json ─┐
repo file tree ────────────┤
                           ├─> Stage 1: Seed ─> Stage 2a: LLM Enrich ─> Stage 2b: MeSH Validate ─> Stage 3: LLM Validate (with feedback loop) ─> DOI Mint
README.md ─────────────────┘
```

### Pipeline Stages

**Stage 1: Seed** (`pipeline_stage: "seeded"`)
Deterministic extraction from BIDS sources:
- All authors from `dataset_description.json` (even without ORCIDs)
- Title (`Name`), license (`License`), data type (`DatasetType`: raw/derivative)
- Modalities detected from repo file tree (eeg, emg, func, etc.)
- `resource_type_specific` mapped from modalities (e.g., "EMG Dataset")
- `SourceDatasets` -> `IsDerivedFrom` related identifiers
- `Funding` references
- `ReferencesAndLinks` -> related identifiers
- GitHub repo URL and NEMAR landing page as `IsDescribedBy` related identifiers

**Stage 2a: LLM Enrichment** (`pipeline_stage: "enriched"`)
Extract what BIDS doesn't provide from README:
- Rich description/abstract
- Methods description
- Structured keywords with MeSH subject scheme (MeSH only; LCSH removed)
- Additional funding details (award numbers from text)
- Additional related identifiers from README

**Stage 2b: MeSH Validation**
NLM API validates MeSH-tagged keywords:
- Confirms valid terms (adds URI from `id.nlm.nih.gov`)
- Strips scheme from invalid terms (keeps term as plain keyword)
- Also strips any non-MeSH schemes (LCSH, etc.)
- API: `https://id.nlm.nih.gov/mesh/lookup/descriptor?label={term}&match=exact&limit=1`

**Stage 3: LLM Validation with Feedback Loop** (`pipeline_stage: "validated"`)
A second LLM pass that reviews the assembled metadata:
- Validates relation types (e.g., `IsDerivedFrom` vs `IsVersionOf`)
- Checks author completeness against README mentions
- Validates keyword relevance and scheme assignments
- Flags inconsistencies between description and actual data
- If blocking issues found: feeds them back to LLM for correction via `correctFromFeedback()` (up to 3 attempts)
- If still failing after 3 attempts: creates GitHub issue on dataset repo with blocking issues

### DOI Gating

DOI concept creation is blocked unless `pipeline_stage` is `"validated"`. Admin override available with `skip_enrichment_check: true`.

### DOI Target URL

DOI `_target` always resolves to a NEMAR landing page, not GitHub. That page is now
`https://nemar.org/dataset/<id>` (`datasetLandingUrl` in `shared/datacite-constants.ts`); the
`dataexplorer/detail` URL this section was written against is gone and 301s there.

### Refactoring Target

`bidsToDataCite()` should read primarily from `.nemar/metadata.json` as the single source of truth, with `dataset_description.json` only as a fallback for unseeded datasets.

### Schema

```json
{
  "version": "2.0",
  "pipeline_stage": "validated",
  "title": "Dataset Name",
  "license": "ODC-By-1.0",
  "dataset_type": "raw",
  "modalities": ["emg", "beh"],
  "resource_type_general": "Dataset",
  "resource_type_specific": "EMG Dataset",
  "authors": {
    "Author Name": { "orcid": "...", "affiliations": [{ "name": "..." }] },
    "Author Without ORCID": {}
  },
  "description": "...",
  "methods_description": "...",
  "keywords": [{ "term": "Electromyography", "subject_scheme": "MeSH", "scheme_uri": "https://id.nlm.nih.gov/mesh/", "value_uri": "https://id.nlm.nih.gov/mesh/D004576" }],
  "funding_references": [{ "funder_name": "...", "award_number": "..." }],
  "related_identifiers": [
    { "identifier": "10.xxxx/...", "identifier_type": "DOI", "relation_type": "IsDerivedFrom" },
    { "identifier": "https://github.com/nemarDatasets/nm000108", "identifier_type": "URL", "relation_type": "IsDescribedBy" },
    { "identifier": "https://nemar.org/dataexplorer/detail?dataset_id=nm000108", "identifier_type": "URL", "relation_type": "IsDescribedBy" }
  ]
}
```

### Key Files

| File | Role |
|---|---|
| `backend/src/services/llm-enrich.ts` | `seedFromBids()`, `enrichFromReadme()`, `validateMetadata()`, `correctFromFeedback()`, `validateMeshTerms()` |
| `backend/src/routes/webhooks.ts` | Pipeline orchestration (POST `/webhooks/llm-enrich`) |
| `backend/src/routes/admin.ts` | DOI gating (`pipeline_stage === "validated"`) |
| `backend/src/services/datacite.ts` | `parseNemarMetadataV2()`, `detectModalitiesFromTree()`, `mapModalityToResourceType()` |
| `shared/datacite-constants.ts` | `NemarMetadataV2` type, `PipelineStage` |
| `.github/workflows/llm-enrichment.yml` | CI trigger on README/dataset_description changes |

---

## Architecture Decisions

### Authentication Flow
1. `nemar auth signup` -> collect credentials -> send to backend
2. Backend sends verification email
3. User clicks verification link
4. Admin receives notification; uses `nemar admin approve <user>`
5. Backend generates: API token, GitHub PAT, S3 credentials
6. User receives email with instructions

### Token Hierarchy
- API Token (master) -> links to:
  - GitHub PAT (for nemarDatasets org access)
  - S3 credentials (scoped to user's datasets)
- Revoking API token invalidates all linked credentials

### Storage Strategy
- **GitHub:** Metadata, git history, releases (via DataLad)
- **S3:** Binary data files (EDF, BDF, etc.)
- **Zenodo:** DOI registration and archived releases
- **Cloudflare D1:** User accounts, tokens, dataset metadata

### Permissions Model
- **Users:** Create datasets, version existing datasets (after concept DOI)
- **Admins:** Approve users, create concept DOIs, revoke access, delete datasets
- **System:** Cannot delete repositories; versioning on S3

---

## Success Criteria
- [x] User can sign up and get approved (backend + CLI complete)
- [x] Admin gets notified when users need approval
- [x] CLI authentication works (login, signup, status, logout)
- [x] Admin commands work (users, approve, revoke)
- [x] CI/CD pipeline with 84 passing tests
- [x] BIDS validation catches issues before upload (via Deno subprocess)
- [x] Dataset upload completes with progress feedback (parallel S3 upload)
- [ ] All operations work offline-first where possible
- [ ] CLI installable via `bunx nemar-cli` or `bun install -g nemar-cli`
- [ ] Test coverage reaches 90% target

---

## Open Questions
- ~~Cloudflare D1 vs. other database options?~~ **Resolved: Using D1**
- ~~GitHub App vs. PAT for organization access?~~ **Resolved: Using PAT (GITHUB_ADMIN_PAT)**
- ~~How to handle large dataset resumption?~~ **Resolved: git-annex handles resumption natively**
- Version control strategy for S3 (S3 versioning vs. DataLad)?

---

## Notes
- Reference existing tools in ~/Documents/git/EMG-2-BIDS/tools/
- Follow OpenNeuro CLI patterns where applicable
- DataLad/git-annex expertise available in existing publish scripts
- Each phase should be planned in detail using plan mode before implementation
