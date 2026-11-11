# ADR 0111: An upstream re-pull is a reviewed delta on a release branch

**Status:** accepted
**Date:** 2026-10-23
**Owner:** Seyed Yahya Shirazi

Epic #1046, Phase 1 (#1907).
Amends [ADR 0006](0006-upstream-re-pull-is-a-major-version-bump.md): its policy stands (a re-pull is a major bump), and this record adds the mechanism and says what major and patch mean on a mirror.
Narrows [ADR 0093](0093-pull-requests-awaiting-approval-are-managed-from-one-admin-command-and-an-approval-is-the-administrators-own.md) in one aspect, the merge, for one class of pull request, the re-pull pull request the automatic path opened (decision 7); ADR 0107 already partially supersedes ADR 0093, and for every other pull request what remains of it stands.
Builds on ADR 0001 (published datasets are PR-only), ADR 0023 (`--clean` reconciles), ADR 0034 (the column budget), ADR 0060, ADR 0085, ADR 0086, ADR 0089 and ADR 0091 (what an imported tree goes through), and ADR 0053 and ADR 0054 (unknown is never zero).
The analysis is `.context/design-upstream-repull.md`; where it and this record disagree, this record wins.
Decisions 4 and 10 are built, as their dated amendments below record, and so are the record of decision 3 (the table, its routes and its fences) and the fences of decision 6 (Amendment 2026-10-24 (#1912), Phase 6a); every other rule in the Decision section is designed here and built by the later phases of #1046, and its present tense states the rule, not today's behavior.
*Annotated 2026-10-24: superseded in part by the Phase 6e amendment (#1912): the identifier screen bound to the re-pull row (decision 7), the merge cap of decision 6, and the verified merge and release are built too.*
*Annotated 2026-10-24: and by the Phase 6d amendment (#1912): decision 8's pinned copy, and decision 2's registration, release branch and pull request, are built through `pr_open`.*
*Annotated 2026-10-25: and by the Phase 7 amendment's 7c slice (#1913): decision 6's scheduled path is built, in production only, and does nothing while its switch is off.*
*Annotated 2026-10-25: and by the Phase 6f amendment (#1912): resume, the administrator's merge through one gate, the release and the lock are built through `released`.*
*Annotated 2026-10-25: and by the Phase 7f amendment (#1913): the advance tick holds, gates and resumes the automatic re-pulls, in production only, and while its switch is off only records that it is off; decision 7's merge is still not built.*
*Annotated 2026-10-25: and by the Phase 7d amendment (#1913): the unattended run that opens an automatic re-pull's pull request and finishes a merged one is built, in a central workflow deployed only with the epic release.*
*Annotated 2026-10-27: the workflow is not held for the release.
Its copy in `nemarDatasets/.github` merged as `nemarDatasets/.github#148`, and this repository's #1980 compares the two copies byte for byte.
It runs only on a `repository_dispatch` of the type `run-upstream-repull`, which only the automatic path sends, and that is off until the owner turns its switch on (see the Phase 8 amendment, "The workflow pairs").*
*Annotated 2026-10-25: and by the Phase 6g amendment (#1912): N.0.1, abandoning a record, superseding one, the manual-major refusal and a mirror rehearsal fixture are built, which completes Phase 6's manual execution.*
*Annotated 2026-10-26: and by the Phase 7g amendment (#1913): decision 7's merge is built: the Worker merges a machine-clean automatic re-pull pull request and finishes it after its merge, and an administrator may merge a re-pull they opened over a failed BIDS validation, never over a rule that requires it.*
*Annotated 2026-10-26: and by the Phase 7h amendment (#1913): the automatic path is observable (the weekly report's re-pull section, the administrator's list of dispatches and `nemar admin repull auto`), which completes the slices of Phase 7; the owner's switches, gates G4 and G5 and the held workflow pair remain.*
*Annotated 2026-10-27: the workflow pair is no longer held: `nemarDatasets/.github#148` merged and this repository's #1980 compares the copies (the Phase 8 amendment, "The workflow pairs").
The owner's switches and gates G4 and G5 remain.*
*Annotated 2026-10-27: and by the Phase 8 amendment (#1914): the Decision section is built, and what that amendment lists under "Not yet verified" is unobserved, not unbuilt; what remains is the owner's act and the epic's release.
Phase 8 itself documents the epic, fixes the website's contract for the `mirror` flag and records the order in which the pieces reach production.*
*Annotated 2026-10-29: the production canary's first run found that the single `copy-object` of decision 8 needs `--tagging-directive REPLACE` (#1991).
Upstream's bucket does not let us read an object's tags and the default directive reads them, so a plain copy answered AccessDenied for every object the canary tried; the multipart copy, which carries no tags, was unaffected.
The copy and the canary send the flag, and the write guard refuses a `copy-object` without it.
ADR 0063 records the same denial for the content-recovery copy.*
*Annotated 2026-10-29: and by the amendment of that date (#1996): a re-pull merged outside NEMAR's gate is accepted on evidence the CLI and the Worker each read, and the privacy ledger names the accepted merge in a line NEMAR writes, which the fresh-clone proof reads.*

*Annotated 2026-11-09: and by the amendment of that date: the acceptance also takes a merge commit of two parents, when it is GitHub's plain merge of the re-pull's own pull request.*
*The first parent must be the record's base, or a commit enrichment moved it to, as for a squash.*
*The second parent must be the head GitHub reports for the merged pull request, which the record's gated head, or an enrichment-shaped descendant of it, already has to be.*
*The merge's tree must be the re-pull's commit outside `.nemar/**` and `.github/**`, and its effect on the privacy ledger must be nothing or a scrub's appended lines, both unchanged.*
*Any other shape is refused: no parent or three or more parents with `merge-not-squash`, and two parents whose second is not the merged head (including the head first) with `merge-second-parent-foreign`.*
*Why: a re-pull merged with GitHub's merge button produced a merge commit that the amendment of 2026-10-29 refused, although its tree was identical to the gated head's, and rewriting `main` was not an option once the tag and the version DOI named it.*
*The fresh-clone proof reads a merge's first-parent diff, so a `repull-merge-accepted` line that names the merge vouches for it as it does for a squash.*
*The line keeps the verification word `squash-merge-verified` for both shapes, because a ledger validator already deployed accepts that word and no other, and the line names the merge by its full id, so the shape is read from the commit.*
*One predicate, `classifyMergeParents` in `shared/repull-merge-acceptance.ts`, decides the shape for the CLI and the Worker; the section "Amendment 2026-11-09" below gives the reasoning.*

## Context

ADR 0006 fixed the policy for an upstream re-pull and left the machinery to epic #1046.
An imported mirror never re-enters candidacy: discovery parses `latestSnapshot.tag` into `DiscoveredDataset.latestTag`, which nothing reads or stores, and `diffNewDatasets` compares ids only.
Running the importer again is not a re-pull: `POST /admin/datasets/import` answers 403 outside production first, then 409 when the dataset or its repository already exists, prepare's step 4c resets onto `origin/main` under a same-version assumption (#993), so the copy manifest follows the new upstream while the tree stays NEMAR's old one, and finalize skips publication for a public dataset (#985).
Nothing records which upstream snapshot a version mirrors: the importer clones the default HEAD, no importer step sets `Version`, and neither `datasets` nor `dataset_versions` has a `source_version`.
*Annotated 2026-10-24: the importer now clones a pinned upstream tag and records it in `SourceDatasets` (see Amendment 2026-10-24).*
Early imports rewrote every commit, so on `on003645` NEMAR's history shares no ancestry with upstream's although the trees match upstream 2.0.2 plus `.github/`.
`AUTO_IMPORT_ENABLED` is `"true"` in production (`backend/wrangler-sccn.toml`), so nothing a re-pull needs may reach the auto-import's candidate set.
Measured staleness is real: `on004362` missed upstream's 1.0.1 metadata fix (#1810).

## Decision

Everything in this section is designed and not yet built.
*Annotated 2026-10-24: decisions 4 and 10 are built, as their dated amendments below record; the record of decision 3 and the fences of decision 6 are built by Phase 6a (#1912); every other rule is still designed and not built.*
*Annotated 2026-10-24: superseded in part by the Phase 6e amendment: the screen bound to the row, the merge cap and the verified merge and release are built as well.*
*Annotated 2026-10-24: and by the Phase 6d amendment: the pinned copy, the registration and the pull request are built through `pr_open`.*
*Annotated 2026-10-25: and by the Phase 7 amendment's 7c slice: the scheduled path of decision 6 is built, and does nothing while `AUTO_REPULL_ENABLED` is off.*
*Annotated 2026-10-25: and by the Phase 6f amendment: resume, the administrator's merge, the release and the lock are built through `released`.*
*Annotated 2026-10-25: and by the Phase 7f amendment: the automatic path's gates edge and its resume of a stalled run are built; the Worker's merge is not.*
*Annotated 2026-10-25: and by the Phase 7d amendment: the unattended run of decision 6's scheduled path is built, to the open pull request and from a merge to `complete`.*
*Annotated 2026-10-25: and by the Phase 6g amendment: N.0.1, abandon, supersede and the manual-major refusal are built.*
*Annotated 2026-10-26: and by the Phase 7g amendment: decision 7's merge is built, with its follow-through to `complete` and an administrator's merge over a failed BIDS validation.*
*Annotated 2026-10-26: and by the Phase 7h amendment: what the automatic path did is counted every week and listed for an administrator, and nothing about what it does changes.*
*Annotated 2026-10-27: and by the Phase 8 amendment: every rule in this section is built; the unobserved parts are listed under "Not yet verified" in that amendment, and nothing in it changes what a rule says.*

**An upstream re-pull replays the delta between two pinned upstream tags onto NEMAR's `main` as one synthesized commit on `release/vN.0.0`, landed through a pull request; N.0.0 is a pure mirror of the upstream snapshot, and NEMAR's corrections follow as N.0.1.**

`from_tag` is the upstream tag NEMAR's latest version mirrors, the `source_version` of its highest version row (decision 4), and `to_tag` is the upstream tag being pulled; both are tags, never a branch head (decision 10).

### 1. N.0.0 is a pure mirror, and upstream wins every conflict

- The N.0.0 tree is upstream's tree at `to_tag` with NEMAR's standard edits applied, and nothing else outside the paths NEMAR owns.
- NEMAR owns `.nemar/**`, `.github/**`, and in `dataset_description.json` the keys `DatasetDOI` (the concept DOI) and `Version`, and the `SourceDatasets` entry naming this dataset's own `ds`, which becomes `{DOI, URL, Version: to_tag}`.
  Other `SourceDatasets` entries are kept from both sides, and every other key and path is upstream-owned.
  `CHANGES` is upstream-owned, and NEMAR never writes it.
- The standard edits are re-applied as functions, never merged as text: the README rename and DOI badge, the `.nemar/` line in `.bidsignore`, ADR 0060's annex policy, moving git-resident data into the annex, ADR 0089's scrub with its provenance sentence, and ADR 0091's date normalization.
- A change recorded in the dataset's privacy ledger (`.nemar/corrections.jsonl`, ADR 0085) is a standard edit: N.0.0 carries it, and a plan that would revert one refuses.
  A ledger line whose `action` is other than `import-scrubbed` (the importer's own line, which the delta scrub re-applies as a function) is a recorded correction.
  *Annotated 2026-10-29: neither `repull-scrubbed` (the Phase 6b amendment) nor `repull-merge-accepted` (the amendment of 2026-10-29) is one.*
  The ledger holds counts and no per-file list (ADR 0036), so a plan cannot tell which unexplained paths a recorded correction made, and it refuses rather than revert one: the refusal applies to a dataset whose ledger holds at least one recorded correction, to any plan for it with an unexplained path, and it has no override.
  This keeps ADR 0085's promise that a re-pull is scrubbed again and does not reintroduce what was corrected.
- Base is upstream at `from_tag`, theirs is upstream at `to_tag`, and ours is NEMAR `main`.
  An upstream-changed path is one that differs between base and theirs.
  A delta path is one the re-pull's commit adds or changes relative to ours.
  Delta paths are fixed from the pre-scrub plan, so the scrub that runs on them never changes which paths they are.
  A path present on one side only differs from that side.
- An unexplained path is an upstream-owned path where ours differs from base, ours is not a standard edit applied to base, and ours is not already theirs with the standard edits applied.
  "Explained" is checked mechanically: a scrubbed key is explained when NEMAR's git-annex branch marks the upstream key dead, and a file moved into the annex is explained when its key hashes the base blob.
- An unexplained path is a conflict when it is upstream-changed and a correction when it is not, so "zero unexplained paths" means no conflict and no correction.
- N.0.0 takes, per upstream-owned path:
  ours, when the path is neither upstream-changed nor unexplained, so no standard edit is run on it again;
  theirs with the standard edits applied, when it is upstream-changed and not unexplained;
  theirs with the standard edits applied, for a conflict, so a re-pull never blocks on one;
  and theirs with the standard edits applied, for a correction, which N.0.1 then replays.
- The conflict cases each take upstream's side in N.0.0, and the plan lists NEMAR's side for an administrator:
  upstream deleted a path NEMAR changed (N.0.0 deletes it);
  NEMAR deleted a path upstream changed (N.0.0 has upstream's new file);
  and both added a path with different content (N.0.0 has upstream's).
  A path NEMAR added or deleted that upstream did not change is a correction: N.0.0 follows upstream, and N.0.1 replays NEMAR's addition or deletion.
- A conflict stays out of N.0.1 until an administrator resolves it.
- Corrections replay as N.0.1, the next patch, in a second pull request that targets `main`.
  That pull request is opened at `patch_synthesized`, on the new `main` after N.0.0 is merged and tagged, and its gates are read on that commit; until then the `patch_*` columns (decision 3) are NULL and the plan lists the corrections.
  Both pull requests are squash-merged, as `y` in ADR 0093's `next` merges, so N.0.1 is synthesized on the new `main` (the corrections replayed onto N.0.0's tree) and never stacked by branch ancestry.
  A re-pull with no corrections opens no N.0.1.
  *Annotated 2026-10-25: built by the Phase 6g amendment: the plan's conflicts wait for an administrator's decision (`--take-ours`, `--keep-upstream`) before N.0.1 is made, and a re-pull with no correction and no conflict resolved to NEMAR's side opens no N.0.1.*

### 2. The delta is replayed as one commit, through a pull request

- The plan compares base, theirs and ours per path (decision 1), on a clone of `nemarDatasets/<id>` at `main` (so `enableremote nemar-s3` reuses the bucket's UUID, avoiding #1320) and metadata-only clones of upstream at the two tags.
- The result is one commit on `release/vN.0.0`, carrying the trailers `Upstream-Snapshot: <ds>@<to_tag>` and `Repull-Plan: <digest>`.
  N is the next major after the highest of the `dataset_versions` rows, the `v*` tags and `Version` on `main`; the plan refuses when the three disagree or another release pull request is open.
  N.0.1's pull request is opened only after N.0.0's has merged, so the two are never open together.
- It lands through a pull request, never a bypass and never a direct push, and it is never a git merge of upstream's history: upstream's commits are not pushed to NEMAR.
- The scrub, the annex policy and the date normalization run on the delta paths only (decision 1), before the copy and before the commit.
  An object the copy writes is anonymously readable by key (ADR 0089), so nothing unscrubbed is copied into NEMAR's bucket, and nothing unscrubbed enters NEMAR's history.
  A recording the commit does not touch keeps its bytes and its key.
- `nemar admin repull <id>` is a dry run by default, and `--execute` requires `--plan <file>` with the digest of the reviewed plan; when `main` moved since the plan, it plans again and stops for review of the new digest, unless the new commits touch only `.nemar/**`.
- The merge goes through the existing release path: the existing dataset workflows tag the merge, the tag mints the version DOI through EZID (ADR 0007), and the DOI carries `IsDerivedFrom` `openneuro.<ds>.v<to_tag>` because the mint reads `SourceDatasets` at the tag.
  *Annotated 2026-10-27: not verified until gate G4; a second source can name the same DOI as `IsIdenticalTo`. See the Phase 8 amendment, "The relation on a re-pull's Digital Object Identifier (DOI)".*
- New behavior the build adds, because no callback does it today: after the tag, one ADR 0023 reconcile (`--clean`, never `--wipe`) is queued for the dataset, so the Zarr stores of deleted recordings go, and the dataset's hed, channel-montage, data and availability stamps are re-armed.
  Today those four stamps are cleared only fleet-wide, by `?reset=1` on the sweep routes in `backend/src/routes/admin/datasets-lifecycle.ts`; the identifier sweep's verdict already counts only for the version it was dispatched for (ADR 0088).

### 3. Re-pull state lives in `upstream_repulls`, never in `import_jobs`

- One row per `(dataset_id, to_tag)`, `UNIQUE`, plus a partial unique index allowing one non-terminal row per dataset.
  *Annotated 2026-10-25: read per attempt by the Phase 6a amendment (`(dataset_id, to_tag, attempt)`), so an abandoned or superseded tag can be tried again.*
- The one row records both pull requests: `branch`, `pr_number` and `head_sha` for N.0.0, and `patch_branch`, `patch_pr_number` and `patch_head_sha` for N.0.1, which stay NULL until `patch_synthesized`, and for good when there are no corrections.
  `origin` records who opened them: `automatic` for the scheduled path, `administrator` for `nemar admin repull <id> --execute`.
  A second row keyed by version was rejected: created at plan time it would be open beside the N.0.0 row, which the one-non-terminal-row index forbids, and created at `patch_synthesized` it would leave a gap after N.0.0's release in which another re-pull could start before the corrections land.
- Its states are planned, prepared, copied, registered, pr_open, gates_clear, merged and released, then, when there is an N.0.1, patch_synthesized, patch_gates_clear, patch_merged and patch_released, and finally complete.
  Abandoned, failed, superseded and patch_declined are terminal, and superseded means a newer tag arrived before N.0.0 merged, so its pull request is closed and the plan made again from the same `from_tag`.
- Every step checks its own end state before it acts, so `--resume` continues from the recorded status.
  *Annotated 2026-10-25: built as commands, not flags: `nemar admin repull execute <plan-file>` and `nemar admin repull resume <id>` (the Phase 6c, 6d and 6f amendments).*
- `--abandon` before N.0.0 merges closes its pull request and deletes its branch, when they exist, reports the orphaned bytes and ends the row `abandoned`.
  After N.0.0 has merged, it closes only N.0.1's pull request and branch, when they exist, and ends the row `patch_declined` (terminal).
  N.0.0 stays released, because its tag and DOI exist, and its corrections remain corrections in the next plan.
  A step that finds a recorded pull request closed unmerged ends the row the same way: `abandoned` before the N.0.0 merge, `patch_declined` after it.
  *Annotated 2026-10-25: built by the Phase 6g amendment as `nemar admin repull abandon <id>` (no `--abandon` flag) and `nemar admin repull execute --supersede`; abandon refuses between the N.0.0 merge and its release, and never ends a record whose pull request merged.*
- `last_error` is written through `import-error.ts`, so ADR 0051's rule applies.
- A re-pull never writes `import_jobs`: its sticky row per dataset, its `preparing` reset, its six-hour sweep and the retry engine, which reads only `import_jobs`, would each treat a re-pull as a broken import.

### 4. The upstream tag is recorded per version, and the dataset's tag is derived

- `dataset_versions` gains `source_version` (the upstream tag) and `source_version_basis` (`doi`, `lineage` or `unknown`).
  An unknown tag is stored as `source_version` NULL with basis `unknown`, and both NULL means the row was never examined, so "`source_version` set" always means a known tag.
- The dataset's mirrored tag is the `source_version` of its highest-semver version row, derived at read time, so `datasets` gains no column and stays under ADR 0034's budget (84 columns pinned, cap 97, on 2026-10-23).
- The value is written when the version row is inserted, from the tagged `dataset_description.json` the version-DOI callback already reads, by one parser, `sourceSnapshotOf(desc, sourceId)`.
  It reads `Version`, then a DOI matching `10.18112/openneuro.<ds>.v<tag>`, then the URL, accepts only an entry naming the dataset's own `ds`, and answers `unknown` when they disagree.
- The backfill of existing mirrors reads `v<version>/dataset_description.json` through the authenticated raw CDN, and no match is `unknown`.
- Unknown is never guessed and never rendered as zero: a mirror whose tag is unknown is never re-pulled, the staleness report counts it as unknown and never as current, and an import date compared with a snapshot date is shown only as "probably stale", never recorded as a tag.
  The `lineage` basis (tree equality outside NEMAR's paths) is established only inside a plan.

### 5. N.0.0 on a mirror always means an upstream pull

- A version row with `source_version` set (not NULL, so never an unknown tag) and a version of the form `N.0.0` is a mirror.
  The API exposes that as a derived flag, computed at read time and never stored, and the website shows a mirror tag on that version.
  *Annotated 2026-10-27: built by the Phase 8 amendment, on the website's `staging` branch only (`nemarOrg/website#489`): the website shows a chip from the flag (`mirror === true`), not the tag, which the public wire never carries.*
- A manual major bump is refused on `on` datasets: `nemar dataset release --type major`, and `nemar dataset update --bump major`, which reaches the same number.
  NEMAR's own changes to a mirror take minor and patch.
  *Annotated 2026-10-25: built by the Phase 6g amendment in the CLI only (`nemar dataset release`, `nemar dataset update`), for `on` ids and for rows recorded as OpenNeuro imports; the dataset repositories' `version-check` workflow is not changed (ADR 0020), so a major merged outside the CLI is not stopped.*

### 6. Discovery stays id-only, and the re-pull has its own switches and caps

- `diffNewDatasets` stays id-only, so the live auto-import never sees a stale mirror; staleness is computed by its own report.
- `AUTO_REPULL_ENABLED` lets the scheduled path open re-pull pull requests, and `AUTO_REPULL_MERGE_ENABLED` lets the Worker merge them (decision 7).
  Both are off when absent, and the scheduled path is production-only through the dev cron's allowlist.
- `REPULL_DAILY_OPEN_CAP` (default 2) bounds the dispatches the automatic path claims to open a re-pull in a day; the pull requests follow only under the timing the Phase 7b amendment ("The open cap") says a later slice pins.
- `REPULL_DAILY_MERGE_CAP` (default 5) bounds merges: every merge a NEMAR tool makes of a re-pull pull request, the Worker's and the manual ones (`nemar admin repull <id> --merge`, `nemar admin pr-reviews`) alike, first claims one from the backend, and a refused claim merges nothing, because every merge mints an irreversible DOI.
  *Annotated 2026-10-25: the manual command is built by Phase 6f as `nemar admin repull merge <id>`; no `--merge` flag exists (see the Phase 6f amendment).*
  *Annotated 2026-10-26: and the Worker's merge claims its unit through the same statement (the Phase 7g amendment).*
- The automatic path takes only a plan with zero unexplained paths.
- Outside production, the re-pull routes refuse every dataset that is not `xx`, because the GitHub organization is shared, and re-pull mail goes through the admin-only fence.

### 7. The Worker may merge a re-pull pull request, and nothing else, when it is machine clean

A re-pull pull request is machine clean when all of these hold:

- `AUTO_REPULL_MERGE_ENABLED` is on, and the pull request is the one `upstream_repulls` recorded for this re-pull (its branch, number and head SHA) on a row whose `origin` is `automatic`: a pull request an administrator opened, including through `--execute`, is never merged by the Worker;
- the plan had zero unexplained paths, so there is no conflict and no correction to replay: the Worker never merges an N.0.1 pull request, because N.0.1 exists only when a correction does, and an administrator merges it;
- the identifier screen, dispatched with `ref=<head sha>` and a callback bound to the re-pull row, says `clear`: never `unchecked`, never `rerun`, and never `acknowledge`, which needs a person (ADR 0086);
- BIDS validation and `version-check` are green;
- an ADR 0107 review is stored for that head and its verdict is `pass`; any other verdict, or none, is not machine clean, because unknown is never treated as clean (ADR 0053, ADR 0054), and this holds even where the review's ruleset is only a shadow check;
  *Annotated 2026-10-29: superseded by [ADR 0117](0117-an-upstream-re-pulls-own-pull-request-is-waived-from-the-review-by-nemars-record.md): the review is waived for the record's own pull request at the head the record holds, which machine clean reads as `waived` and passes; the Worker's start of that review (the Phase 7e and Phase 7f amendments) is retired.*
- the pull request's head equals the screened SHA;
- the daily merge cap is not exhausted, and its claim is made before the merge is sent.

The merge is sent with the screened SHA, so GitHub refuses a branch that moved, and only when GitHub reports the pull request `clean`: the NEMAR App is a bypass actor (ADR 0001, ADR 0107), and `clean` is what keeps "never a bypass" true for a merge the App makes.
The Worker submits no approving review on this class either, since ADR 0001 requires none; the record is the merge, the `upstream_repulls` row and the plan digest.
The Worker's merge call is not built until the ruleset check under "Not yet verified" is done.
*Annotated 2026-10-26: the check was run by the owner on 2026-10-26 and passed, and the merge call is built by the Phase 7g amendment.*

**What this narrows in ADR 0093, for re-pull pull requests only.**
ADR 0107 already partially supersedes ADR 0093; this record narrows one more aspect of it, the merge, and only for this class.
ADR 0093's approval sentences stand as written, "its approval is made by the administrator, from their machine, with their own GitHub login" and "No Worker code path approves", because the Worker submits no review.
What changes, for a re-pull pull request the automatic path opened, is that a merge no longer always follows an administrator's approval and `--merge` or `y`: the Worker merges one that is machine clean.
For every other pull request the Worker neither approves nor merges.
AGENTS.md's summary of ADR 0093 ("nothing merges without `--merge` or a `y`") is updated by the phase that builds the merge.
*Annotated 2026-10-25: updated by Phase 6f, which builds the administrator's merge (see the Phase 6f amendment).*
*Annotated 2026-10-26: and by Phase 7g, which names the Worker's merge of this one class (see the Phase 7g amendment).*

A re-pull pull request that is not machine clean, or that an administrator opened, is merged by an administrator, through `nemar admin repull <id> --merge` or `nemar admin pr-reviews`, under ADR 0093, with a screen that is `clear` or carries the administrator's recorded acknowledgment (ADR 0086).
*Annotated 2026-10-25: built by Phase 6f as `nemar admin repull merge <id>` (no `--merge` flag exists) and through `nemar admin pr-reviews`, both through one gate (see the Phase 6f amendment).*
`nemar admin pr-reviews` will require that screen for a re-pull pull request other than an `xx` one (below), which its `approve --merge` does not check today, and will claim the merge cap before the merge is sent.
*Annotated 2026-10-25: built by Phase 6f: `approve --merge` and `y` in `next` merge a re-pull pull request only through the re-pull's gate, which reads that screen and claims the cap (see the Phase 6f amendment).*

An `xx` re-pull takes the administrator path only.
ADR 0086 exempts `xx` from the identifier screen, so an `xx` re-pull never has a `clear` verdict and is never machine clean, and an administrator merges it under that exemption, with no screen.

### 8. A copy pins the object version, and nothing of the prior version is deleted

- The copy manifest is the keys the scrubbed new tree names that are not present and not dead, written to `<id>/staging/repull-<tag>.json`.
- Each copy item carries the S3 `versionId` upstream's `.log.rmet` records for its key, and the copy pins it; an item without a `versionId` is refused, never copied by path.
  Today `parseS3Url` drops the query string, so the import copy takes whatever object is current at the path.
- Prior-version objects stay under their governance lock, and the old version's manifest, DOI and data-plane routes are unchanged.
- An abandoned re-pull leaves locked orphan objects; the plan states their size, and `--abandon` reports them.
  *Annotated 2026-10-25: as built by Phase 6f, a release locks only the objects its own copy and uploads wrote, so an abandoned attempt's orphans are not locked (see the Phase 6f amendment).*

### 9. A re-pull is a new version of a published dataset, not a publication

- It makes no publication request; the identifier screen gates its merge (decision 7) instead.
- ADR 0089's forward-fix hold does not apply.
  That hold exists because an import pushes upstream's history, which still holds what the scrub replaced; a re-pull pushes none and scrubs its delta paths before its copy and its one commit, so nothing it copies or adds to NEMAR's history holds an original.
- ADR 0091's date normalization applies on delta paths only, so nothing already published is changed.

### 10. The upstream tag is pinned, never HEAD

- A first import clones the discovered tag (`--tag`), never the default HEAD, and writes the `SourceDatasets` entry with `Version`.
- A tag not yet on the GitHub mirror refuses with `[openneuro-mirror-lag]`, which is transient and retried, not parked.
  *Annotated 2026-10-24: see Amendment 2026-10-24 (parked after 14 days).*
- A re-pull's `from_tag` is the recorded `source_version`, and its `to_tag` is a tag.
- The import path gets #993's guard, and only for a released mirror.
  Step 4c refuses with `[openneuro-upstream-moved]` when three things hold: `origin/main` records a tag; the dataset has released a version (a `dataset_versions` row exists); and the tag being imported differs from the recorded one.
  "Records a tag" means `sourceSnapshotOf` (decision 4) finds one in `origin/main`'s `dataset_description.json`, not only in its `Version` key, so a legacy entry that names the tag only in its DOI or URL counts too.
  The classifier calls that `upstream_moved`, and the retry engine parks it like `identifier_scrub_refused`, because moving a released mirror to a new tag is a re-pull's job.
  An import that never released a version and is retried is prepared again at the tag the retry discovers: it is the same import, not a re-pull.
  An unrecorded tag, `origin/main` naming none or the released version's `source_version` being NULL, never trips the guard.

## Consequences

- **DOI volume grows with upstream churn.**
  Every merged re-pull mints a version DOI that cannot be withdrawn, and a re-pull with corrections mints two.
  The volume is measured before anything runs on its own (gate G2 of the design record), and the owner sets the caps from that estimate and turns the switches on (G5); the first Worker merges run with `REPULL_DAILY_MERGE_CAP` set to 1.
- **Two DOIs when N.0.1 has content.**
  N.0.0 cites upstream's snapshot without NEMAR's corrections, which is what its number says, and N.0.1 is the version a reader most likely wants.
- **A window between N.0.0 and N.0.1.**
  Between the two merges the public latest lacks NEMAR's corrections; the window lasts until an administrator merges N.0.1, which can happen only once N.0.0 is tagged and N.0.1 is synthesized and its gates pass, and a conflict keeps its correction out until an administrator resolves it.
  A change the privacy ledger records, and a change a deterministic rule re-applies (the scrub, the date normalization), are standard edits, so N.0.0 carries them and the window never lacks them.
  Every other correction is in the window, including a privacy-minded one the ledger does not record.
- **Orphan locked objects.**
  An abandoned re-pull leaves copied objects under the governance lock; they cost storage and are reported, not deleted.
  *Annotated 2026-10-25: not under the lock, as built by Phase 6f: a release locks only what its own copy and uploads wrote, so an abandoned attempt's orphans stay unlocked (see the Phase 6f amendment).*
- **One synthesized commit instead of upstream's history.**
  NEMAR's log shows one commit per re-pull, named by its trailers, and not upstream's commits; upstream's repository and `CHANGES` remain the record of how the snapshot was made.
- **Few re-pulls will be merged by the Worker at first.**
  Most mirrors are in formats the scanner does not parse, so their screen asks for an acknowledgment (ADR 0089, Consequences), and only an administrator can give one.
  Machine clean also needs an ADR 0107 review that passes, which no re-pull diff is yet known to get.
- **The merge cap binds NEMAR's tools only.**
  An organization administrator merging in the GitHub UI is not stopped by it.
- **The Worker gains a path that merges into `main` of a public dataset.**
  It is bounded by the machine definition, the switch and the cap, and a defect in it would mint a DOI; that is why the merge call waits for the ruleset check and for gates G1 to G5.
- **The Worker's merge has no staging rehearsal.**
  Outside production only `xx` datasets are re-pulled, and they never reach machine clean, so the Worker's merge first runs in production, behind its switch and with `REPULL_DAILY_MERGE_CAP` set to 1 for its first merges (G5).
- **A NEMAR change that would deserve a major has no major on a mirror;** it takes a minor.
- The importer changes as well: it clones a tag, and it refuses a re-import of a released mirror whose recorded tag moved.

## Alternatives considered

- **A git merge of upstream.** There is no shared ancestry on early rewritten imports, and pushing upstream's history would carry its unscrubbed bytes into NEMAR's (ADR 0089).
- **Replacing the whole tree.** Discards NEMAR's edits and re-scrubs and re-normalizes unchanged recordings under new keys, which breaks ADR 0091's rule that nothing already published is changed.
- **Carrying NEMAR's corrections inside N.0.0.** A re-pull would block on every conflict, and N.0.0 would no longer say "this is upstream's snapshot", which is the question ADR 0006's version rule answers.
- **The Worker never merges.** Keeps ADR 0093 whole, and leaves every re-pull of about 900 mirrors waiting for an administrator; the machine definition, the cap and a switch that is off by default bound the risk instead, and the switch off is exactly this alternative.
- **`source_version` on `datasets`.** Spends a column of ADR 0034's budget on a value the highest version row already gives, and loses which tag each version mirrored.
- **Reusing `import_jobs`.** Its sticky row, `preparing` reset, six-hour sweep and retry engine would each read a re-pull as a failed import.
- **A minor bump for upstream.** Rejected by ADR 0006 already; here it would also stop the version number from saying which versions are mirrors.

## Not yet verified

- Whether the rulesets let the GitHub App merge without a human review, and without using its bypass; the merge call is not built until this is checked.
  *Annotated 2026-10-26: checked by the owner on 2026-10-26 for what can be read, and passed: the installation's permissions allow it and no organization ruleset applies (the Phase 7g amendment); the App token's own reading of `mergeable_state` and GitHub's merge of its squash are seen only by the first production merge.*
- Where `source_version` is inserted under the central manifest flow.
  *Annotated 2026-10-27: closed by the Phase 2 amendment (#1908), "Where `source_version` is inserted under the central manifest flow (verified)".*
- Whether "explained" edits are detected on early rewritten imports (`on003645`, `on004362`); local dry-run plans count the unexplained paths.
- Whether ADR 0107's review can ever pass a re-pull diff.
  The App is not exempt, so the review runs, and ADR 0109 fails a changed `CHANGES` line and holds a replaced recording, both normal in a re-pull; until a re-pull's review passes, none is machine clean.
  *Annotated 2026-10-25: corrected by the Phase 7e amendment: the review's intake skipped every bot's pull request, so it did not run; it now runs on the App's automatic re-pull pull request when the Worker starts it, and on no other bot's.*
  *Annotated 2026-10-29: moot since [ADR 0117](0117-an-upstream-re-pulls-own-pull-request-is-waived-from-the-review-by-nemars-record.md): the review is waived for a re-pull's own pull request at its recorded head, so machine clean no longer waits for a pass.*
- Whether enrichment commits on the release branch move its head after the screen read it.
  *Annotated 2026-10-25: the Phase 7d amendment's settle records enrichment's moves of an automatic run's release head before the run reports it, and a later move holds the pull request; how soon enrichment commits is seen only in production.*
- Whether OpenNeuro writes S3 before it pushes to GitHub, and whether the object at a path lags the pinned `versionId`.
- That upstream's `.log.rmet` records a `versionId` per key, which the design record states and nothing here has checked.
- That the dataset workflows tag the squash merge of a re-pull pull request as they tag other merges to `main`.
  *Annotated 2026-10-26: still not seen for a squash the App makes: the first production merge of the Phase 7g amendment, under a cap of 1, is the check.*
- Whether the NEMAR installation token is accepted for another organization's public raw files (`OpenNeuroDatasets`), which the staleness report's mirror probe uses; if it is not, every probe reads `stale_unverified` with the reason and the first production run shows it.
- That the central `run-identifier-screen` workflow posts a re-pull screen's report to its own callback path (`/webhooks/identifier-screen-repull-result`); the workflow accepts any plain https `callback_url` (read), and no run has used this one yet (added by the Phase 6e amendment).
- GitHub's answers to the reads the re-pull's release and merge make (`commits/refs/tags/<tag>` asked for `application/vnd.github.sha`, `compare/<merge>...<tag>` and its status words, a squash-merged pull request's `head` and `merge_commit_sha`); only stand-ins have answered them (added by the Phase 6e amendment). *Annotated 2026-11-08: the tag read was first made against production for on003645 and on004362 and GitHub answered 422 to `commits/tags/<tag>`, so every release was refused as `tag-missing`; the stand-ins had accepted the short form. The read now uses `commits/refs/tags/<tag>` and both stand-ins refuse the short form.*
- What the weekly report's re-pull section reads on production data: the week's counts, the attribution of a merge to the user of its claim in the audit log, and the first week a switch is on (added by the Phase 7h amendment).

## Receipts

- Epic #1046 and its Phase 1, #1907; the design record `.context/design-upstream-repull.md`.
- #993 (step 4c's same-version assumption), #1320 (the bucket's annex UUID belongs to another special remote), #985 (finalize skips publication for a published dataset), #1810 (`on004362` missed upstream's 1.0.1).
- `src/lib/import-openneuro.ts` (`prepareImport`, step 4c, `finalizeImport`), `backend/src/routes/admin/imports.ts` (`POST /admin/datasets/import`), `backend/src/services/openneuro-discovery.ts` (`diffNewDatasets`, `latestTag`), `backend/src/services/auto-import.ts`, `backend/src/routes/admin/datasets-lifecycle.ts` (the `?reset=1` stamp resets), `backend/src/routes/callbacks/version-doi.ts`, `src/commands/dataset.ts` (`release --type`, `update --bump`), `backend/test/datasets-column-budget.test.ts`.

## Amendment 2026-10-23 (#1908): Phase 2 builds decision 4, and the insert site is verified

Epic #1046, Phase 2.
Decision 4 is built: migration 0104 adds `dataset_versions.source_version` and `source_version_basis`, `shared/source-snapshot.ts` holds the one parser, the version insert records the snapshot, and `nemar admin upstream-backfill` records it for the mirrors that predate the columns.
This section makes one correction and states three readings that the decision text left open.
The correction is to a sentence in decision 4, "from the tagged `dataset_description.json` the version-DOI callback already reads", and it answers the "Not yet verified" item "Where `source_version` is inserted under the central manifest flow."
The decision text above is unchanged.

### Where `source_version` is inserted under the central manifest flow (verified)

The item read "Where `source_version` is inserted under the central manifest flow."
Decision 4 says the value is written "from the tagged `dataset_description.json` the version-DOI callback already reads".
Under the central flow that sentence is wrong.
The mint reads the tagged description (`mintEzidVersionDoi`, `backend/src/services/central-manifest.ts`) but returns only the DOI and its warnings, `dispatchCentralManifestJob` stores `manifest_jobs` without the description, and `/webhooks/manifest-ready`, which inserts the row, reads none.
So the insert reads the tagged file itself, once, through the authenticated raw CDN (no REST quota), bounded by a 4 second fetch timeout and a 5 second deadline, and it can never fail the insert.

`dataset_versions` is inserted at five sites, all through one statement, `INSERT_DATASET_VERSION_SQL` in `backend/src/services/source-snapshot.ts`, and a source scan keeps it the only one.

| Site | Where | Live | How it gets the snapshot |
|---|---|---|---|
| A | `routes/callbacks/manifest.ts`, the manifest-ready callback | production, every central-flow publish | reads `v<version>/dataset_description.json` |
| B | `routes/admin/datasets-lifecycle.ts`, admin manifest regeneration | production, manual recovery | the same read, with the repository and token the route already holds |
| C | `services/publication-orchestrator.ts`, the inline path | dev only (`MANIFEST_VIA_CENTRAL_WORKFLOW` is `"false"` there) | the description `readRepoMetadata` returned |
| D | `routes/callbacks/version-doi.ts`, the legacy EZID handler | dev only | the description `readRepoMetadata` returned |
| E | `routes/callbacks/version-doi.ts`, the Zenodo handler | unreachable (EZID is the registrar, ADR 0007) | none; NULL/NULL |

`MANIFEST_VIA_CENTRAL_WORKFLOW` is `"true"` in the production `[vars]` of `backend/wrangler-sccn.toml` and `"false"` under `[env.dev.vars]`, so A and B are the sites that matter.
`readRepoMetadata` never throws: a failed read returns `{ Name }` and a `BIDS metadata unavailable` warning, and an absent file returns the same `{ Name }` with no warning.
C and D therefore record NULL/NULL for either, and record `unknown` only for a description that was really read.

### The parser reads the entry's `Version`, never the top-level one

Decision 4 says the parser "reads `Version`, then a DOI ..., then the URL".
The `Version` it reads is the one inside the dataset's own `SourceDatasets` entry.
The top-level `Version` and `DatasetDOI` are NEMAR's (decision 1), and reading the top-level `Version` would record NEMAR's own version number as upstream's.
An entry is the dataset's own only when its DOI or URL names the dataset's `ds`; an entry that names no `ds` is ignored, `Version` included.
In practice the existing evidence is usually the DOI alone, because `applyConceptDoiToDescription` moves OpenNeuro's original `DatasetDOI` into `SourceDatasets` as `{DOI}` with no URL and no `Version`.

The three signals are never ranked.
Any disagreement between signals, between two own entries, or an entry that names two datasets is `unknown`; the order in the decision text decides only which signal is looked at first.
A tag that cannot be read (`v2.0.2.`, `2.0.x`) is no signal, and a tag is stored exactly as upstream wrote it (`00001` is not `1`).

### What `doi` means

The basis word `doi` is kept as the decision fixed it, and it covers a tag found in the entry's `Version`, DOI or URL.
It says the tag is declared by the version's own tagged description.
It does not say the tree was compared with upstream's; early imports cloned the default HEAD, so a matching DOI is a claim.
Only `lineage`, which a Phase 5 plan alone writes, says the tree was compared.

### An absent file at insert time is not examined, and an error is never a verdict

At insert time an absent file, a failed fetch, a timeout, a body over 1 MiB, a token that cannot be minted and a dataset that is not `on######` all leave NULL/NULL.
A 404 shortly after a tag is pushed can be the raw CDN not having caught up, so an insert never turns "absent" into `unknown`.
`unknown` is written at insert only for a description that was read and names no single tag, which is a property of the content: a tagged blob is immutable.
Only the sites that read the raw file themselves (A and B) can see that the file is not JSON, so only they record `unknown` for it; the inline sites C and D go through `readRepoMetadata`, which turns unparseable JSON into a fallback and a warning, and that is NULL/NULL there.
The insert is `ON CONFLICT (dataset_id, version) DO NOTHING`, not `INSERT OR IGNORE`, so a snapshot pair the table's CHECK refuses raises (the callback answers 500 and the job stays retryable) and does not drop the row silently; a replayed insert for an existing version is still a no-op.

The backfill is the only writer that records `unknown` for an absent file, and `unknown` is final: nothing examines the row again.
So a 404 is recorded only when it is proved to be about the tag and not about the credential, which GitHub also answers with 404.
The proof is a control read: the same repository's `dataset_description.json` at `main`, with the same credential, must succeed.
If the control read fails, the row is counted `not_examined` as a transient error, nothing is written, and the next pass tries it again.
If the control read is also absent, the description is missing at the tag and at `main` (or the default branch is not `main`), nothing is written, and a rerun will not change that: the row is reported with `kind: "needs_admin"` and an administrator has to look at it.
Both hold for a batch of any size, a single row included.
The row must also be older than one hour, so a CDN-cached 404 on a fresh tag is never made final.
A fetch error in the backfill writes nothing, and a batch in which no read proved the credential while at least one 404 is unconfirmed is refused as `suspect_credential` (502), whatever else errored beside it.
Only a version of the form N.N.N is a candidate, and a ref is always the canonical `vX.Y.Z` tag, so a stored `v1.0.0` can never read `vv1.0.0`.
*Annotated 2026-10-27: a row spelled `vN.N.N` is a candidate too, read as `mirroredTagOf` reads it (one lowercase `v`, then `N.N.N`).
The ref is still the canonical `v<N.N.N>` tag, never `vv1.0.0`; see the #1983 review amendment, "The mirrored tag reads both spellings of a version".*
The write is `WHERE source_version_basis IS NULL`, so it never overwrites a recorded value; its paging is a keyset on `(dataset_id, version)`, so a row that always errors cannot starve the rows behind it.
A dry run, which is the default, writes nothing.

### Left open

Outside production only `xx` datasets are re-pulled (decision 6), and nothing says how an `xx` dataset names its upstream `ds`.
The parser takes the `ds` as an argument, but the insert sites and the backfill handle `on######` only.
Whether an `xx` fixture maps through `import_jobs.source_id` is a Phase 4 and 5 question.

## Amendment 2026-10-23 (#1911): Phase 5 builds the plan, and its readings are settled

Extended 2026-10-24, after the Phase 3 and Phase 4a amendments below: the section on `to_tag` (OpenNeuro's latest snapshot, and an order the tags cannot prove is unverified) and the reuse of Phase 3's tag shape and Phase 4a's `isSourceTag` were settled that day.

Epic #1046, Phase 5.
`nemar admin repull plan <id>` is built: a read-only plan, written to a file under its digest, that Phase 6's `nemar admin repull execute` will take.
Execution is not built.
This section records the owner's and the lead's rulings of 2026-10-23 that the decision text left open, and two corrections to it.
The decision text above is unchanged.

### The command is `nemar admin repull plan <id>`, then `nemar admin repull execute`

Decision 2 says `nemar admin repull <id>` is a dry run by default and `--execute` takes `--plan <file>`.
The built shape is two subcommands: `plan` makes the plan, and `execute` (Phase 6) takes the plan file.

`plan` writes nothing to the mirror, S3, D1 or the NEMAR API.
*Annotated 2026-10-27: the central workflow's unattended run, `plan --automatic-dispatch` (Phase 7d), is the one exception.
It reports its dispatch to the Worker, which stores `started` and then `refused` or `failed` if the run ends so; an administrator's `plan` still writes nothing.*
What it writes is its scratch directory, removed on exit, on SIGINT and on SIGTERM unless `--keep-workdir`, and the plan file, which is its output: mode 0600 in the administrator's config directory (`$NEMAR_CONFIG_DIR/repull/<id>/`, `~/.config/nemar` by default), because a path can itself be an identifier.
The default output holds counts and no path, key or file content.

Read-only is enforced by a guard, for every call the plan makes that could write:
each git subprocess, the git-annex branch reads included, may run only `clone`, `fetch`, `ls-remote`, `cat-file`, `ls-tree`, `rev-parse` or `rev-list`, each with a fixed list of options in the exact spelling the planner uses, so an attached form (`-ccore.hooksPath=x`, `-uevil`) is refused as the separated one is;
`clone` and `ls-remote` take only a `https://github.com/<org>/<repo>` or `file:///` URL and `fetch` only the remote `origin`;
the one `aws` call, when asked for, is `s3api list-objects-v2` with `--bucket`, `--prefix`, `--region` and `--output json`;
and the plan's own HTTP requests (the open pull requests, the bucket's anonymous `annex-uuid` marker) are GET or HEAD.
Outside the guard, and read-only by what they are: OpenNeuro's latest-snapshot query (a GraphQL POST that only asks); the NEMAR API's two GETs (the dataset row and its version rows), which the command makes through the API client before it plans; `gh auth token`, which reads the administrator's stored GitHub token; reads of the test bases' local directories; and the scratch directory and the plan file.
`GIT_NO_LAZY_FETCH=1` is set on every git call; the planner does not depend on it, because it reads only blobs the clone holds and lists the missing ones with `rev-list --missing=print`, which never fetches.

The digest is the sha256 of the plan body's canonical JSON.
The time, the environment, whether test bases redirected the remotes (`sources`), the preflight answers and executability are outside the body, so the same remotes and the same options give the same digest.
Because they are outside it, Phase 6 recomputes the preflight and executability itself and never trusts either from a file.

Exit 0 means the plan is executable, 3 that it was made and is not, and 1 that nothing was planned.
Conflicts and corrections do not by themselves stop a plan: N.0.0 takes upstream's side and N.0.1 replays NEMAR's corrections, as decision 1 says.
A plan is not executable when a preflight check is not `ok`, a key has no pin, or a plan refusal holds (the privacy ledger, a gitlink, a target that cannot be computed, a dead key, the fetch bound, a concept DOI that disagrees).

### `CHANGES` is upstream-owned, except ADR 0085's privacy sentence (correction)

Decision 1 says "`CHANGES` is upstream-owned, and NEMAR never writes it".
ADR 0085's correction does write it: its git plan appends one `changeLogEntry` sentence to `CHANGES` in every rewritten commit.
Read literally, decision 1 would make every corrected dataset's `CHANGES` unexplained, and decision 1's ledger rule would then refuse every re-pull of it.
The ruling: `CHANGES` stays upstream-owned, and the privacy sentence is a ledger edit, a standard edit like the provenance sentence.
A plan recognizes NEMAR's `CHANGES` as upstream's text followed by one or more sentences that `changeLogEntry` itself rebuilds byte for byte, and N.0.0's `CHANGES` is upstream's new text with the same sentences appended, whether upstream keeps `CHANGES` in git or in the annex.
Any other NEMAR change to `CHANGES` is unexplained.

### `SourceDatasets` merges three-way

"Other `SourceDatasets` entries are kept from both sides" means a three-way merge of the entries as a set, by canonical value: an entry either side added is kept, an entry upstream removed is not brought back, and an entry NEMAR removed stays removed.
The entry naming the dataset's own `ds` is NEMAR's and is replaced, as decision 1 says, by `{DOI: "doi:10.18112/openneuro.<ds>.v<to_tag>", URL, Version: to_tag}`.
An entry of any shape, `null` included, is merged as a value and never passed to `applyConceptDoiToDescription`, which throws on a `null` entry.

### A mirror whose tag is unknown gets a dry run only

Decision 4 says a mirror whose tag is unknown is never re-pulled.
`plan` refuses one with `from-tag-unknown`, and `--from-tag` on one makes the plan with the check refused as `from-tag-not-recorded`: it is shown, it is never executable, and its lineage is marked not recordable, so Phase 6 never records `lineage` from it.
`--from-tag` that disagrees with a recorded tag refuses as `from-tag-disagrees`, and a tag that is not an OpenNeuro snapshot tag at all (by `isOpenNeuroTag`, the shape decision 10's import also uses: `1..2`, `a/b`) as `from-tag-malformed` or `to-tag-malformed`; `v1.1.0` names the same snapshot as `1.1.0` (`sameUpstreamTag`).
A highest version row that was never examined (both columns NULL), or rows that cannot be read at all (a versions route that answers 404), is not unknown: the plan reads that version's tagged `dataset_description.json` from its own clone with `sourceSnapshotOf`, the file and the parser the backfill would use, and says so in `from_tag_source` (`tagged-description`).

### `to_tag` is OpenNeuro's latest snapshot, and its order is OpenNeuro's

Decision 10 says `to_tag` is a tag, never a branch head, and the Phase 4a amendment (dated 2026-10-24, below) rules that upstream's creation order decides, not the number.
So `plan` takes its default `to_tag` from OpenNeuro's own `latestSnapshot.tag`, the query decision 10's import pins its tag with (`fetchOpenNeuroLatestTag`), and never from the highest number among the mirror's tags.
The tag must have an OpenNeuro tag's shape (`isOpenNeuroTag`), be one the version rows can record (`isSourceTag`, `to-tag-unrecordable` otherwise, because a re-pull to it could never be proved), and be on the GitHub mirror (`mirror-lag` otherwise); equal to `from_tag` is `nothing-to-pull`, and with no answer from OpenNeuro and no `--to-tag` nothing is planned (`latest-unknown`).
A `--to-tag` that OpenNeuro does not name as its latest, or any `--to-tag` while OpenNeuro does not answer, is planned with the check `unchecked` (`order-unverified`), because the planner cannot prove from the tags that it is newer than `from_tag`; such a plan is never executable.
OpenNeuro's latest that is not numerically after `from_tag` is `order-unverified` too, never refused and never `ok`: it can be real creation order (`00006` before `1.0.0`) or a step backwards (a withdrawn snapshot, or a mirror recorded ahead of upstream's latest), and the tags cannot tell which.
The query is a GraphQL POST that only asks, and it runs outside the HTTP guard for that reason.

### Which `ds` a mirror names (closes the Phase 2 amendment's open item)

An `on` id maps to its `ds`, and its dataset row's `source_id` must agree (`source-disagrees` otherwise).
Any other id, an `xx` fixture included, maps through its dataset row's `source_id` (the `datasets` row `GET /datasets/:id` returns), and with none the plan refuses as `no-source-id`.
For every id the row's `source` must be `openneuro` (`not-a-mirror` otherwise).

### Legacy badges, an inherited `.gitattributes` and un-annexed root metadata are explained

The standard edits a plan recognizes include the forms early imports and publications left:
a README under one or more DOI badges for the catalog's concept DOI, in either spelling NEMAR has written (the shields.io form `buildDoiBadge` makes, and the Zenodo form it made before #1182), each rebuilt and compared byte for byte, while a badge naming any other DOI is not NEMAR's edit and is unexplained;
an inherited `.gitattributes` with its `annex.largefiles` attributes stripped (ADR 0060), and a git-held file NEMAR's policy annexed whose key hashes upstream's blob;
and root metadata upstream annexed that the import un-annexed, whose bytes hash to upstream's key.
The README family is compared as a unit, the import's rename (any case and extension, #642) applied before the publish step's (four exact spellings).
The concept DOI is the catalog's (`datasets.concept_doi`); a `DatasetDOI` on `main` that names another refuses as `concept-doi-disagrees`, and with none in the catalog no badge is explained and N.0.0's README cannot be computed.

### Presence comes from the location log, or from a bucket listing when asked

A key NEMAR already holds is not copied.
By default "holds" is read from NEMAR's git-annex branch (the newest `nemar-s3` status is present, or `main` names the key), and the plan says `presence_basis: "location-log"`.
`--bucket-listing` reads a listing of `nemar-s3`'s prefix instead, with the ambient AWS credentials, and holds a key only when its object is there at the size the key declares (`bucket-listing`), because the location log can claim content the bucket never received (#1396).
The listing must hold the prefix's own `annex-uuid` object, or it cannot be told from an empty or partial one, and nothing is planned.
A dead key is never held or copied: it is judged before presence, so an object that outlives its dead mark under the governance lock is not counted, and a dead key N.0.0 would name is listed separately, as `dead_recordings` when the path is a recording the scrub will re-key, and otherwise refused (`target-names-dead-key`).
Root metadata upstream annexed is read from upstream's pinned object at execution and kept in git, so its key is listed with `purpose: "unannex"`, needs a pin like a copied key, and is never counted as held.

### A blob the plan could not read is unchecked, never a guess

A git blob of 1 MiB or more is fetched only when a check needs it and an annex key states its size, within `--max-fetch-gb`.
A blob the bound refuses, or that a fetch which exited 0 did not deliver, makes its path `unchecked` (subtype `fetch-bound`), never a conflict or a correction, and refuses the plan (`fetch-bound`).
A byte count that is partly unknown is reported as at least the known part plus the number of unknown sizes, never as complete (`copy_bytes_unknown`, `local_bytes_unknown`, `orphan_bytes_unknown`).
A scrubbed key is explained only when both keys declare the same size; an unknown size is not the same size.

### Readings of decision 8 and decision 1 the plan needed (corrections and clarifications)

- "The keys the scrubbed new tree names" cannot be known before the scrub runs.
  The plan binds the pre-scrub manifest, and Phase 6 must check that what it copies is a subset of the plan's copy keys plus its own local uploads.
- Deletions are not delta paths as decision 1 defines them; the plan lists them separately, and reports a deleted path and an added path with the same content as one rename, without deciding anything from it.
- #1911's text says a plan refuses on a starting-point mismatch; decision 1 supersedes it, and the plan classifies such a path by the table instead.

### Left open

- A file NEMAR's enrichment adds that upstream lacks (the generated `participants.tsv` of `ensureParticipantsTsv`) is not among decision 1's standard edits, so a plan counts it as a correction.
  For a dataset whose ledger holds a recorded privacy correction, that one correction makes every plan refuse, with no override.
  That is the safe direction, and the owner decides before Phase 6 whether the generated file becomes a standard edit.
- The `CHANGES` sentence is matched only at the end of the file; a sentence followed by upstream text that ADR 0085's rewrite never produces is unexplained.

## Amendment 2026-10-24 (#1909): decision 10, as built

Phase 3 builds decision 10, on the parser Phase 2 built for decision 4 (Amendment 2026-10-23 above); the rest of the Decision section is still designed and not built.
The lead's rulings of 2026-10-23 settle three questions decision 10 left open, and this records them with what was built.

- **Which tag.** The auto-import passes the tag discovery found.
  Every other entry point (the retry engine, `recover --execute`, a dispatch without `--tag`) passes none, and prepare asks OpenNeuro's GraphQL for `latestSnapshot.tag` when it runs, so "the tag the retry discovers" is the latest at the retry.
  An explicit `--tag` is honored; when it is not the latest, prepare warns, because decision 8 is not built and the copy takes the object currently at each upstream path.
  *Annotated 2026-10-27: decision 8 is built for a re-pull's copy by the Phase 6d amendment; the import's copy still takes the object currently at each upstream path, and the import's warning now says so.*
- **Mirror lag.** A latest tag OpenNeuro cannot name refuses with `[openneuro-mirror-lag]` too, before the dataset record is created.
  Recovery quarantines it as `mirror_lag`, so it stays retryable rather than `not_found_dataset`.
  Retries are capped by the retry engine's 14-day window, counted from its first retry of the row; past it the row is parked as `mirror_lag` and one admin issue is filed then; no quarantine mail and no failure-time issue are sent for it (ruling 2).
  The window is the engine's existing `first_incomplete_at`, so a row whose window an earlier, unrelated retry opened and never closed parks at its first mirror lag, with its one issue.
  The override also bypasses `has_doi`, `made_public` and `has_version`: the refusal came before this run changed anything, and only a quarantine that stays retryable lets the lag clear.
- **What "records a tag" reads.** The guard reads origin's description with Phase 2's parser, `sourceSnapshotOf` in `shared/source-snapshot.ts`, the one reader of the tag; see Amendment 2026-10-23 for its rule.
  Phase 3 first shipped a reader of its own, and where the two differed the parser won: a tag is numeric and dotted (`1.0.0`, `00001`), so a `2.1.0-rc1` that OpenNeuro's tag shape admits is no tag; an entry naming this dataset and another gives no tag at all; and of the GitHub mirror's URLs only the tree and release forms name the dataset, not the `.git` clone URL.
  Two tags are the same snapshot only when equal after a leading `v` is dropped (`sameUpstreamTag`), the safe direction; the parser's `compareSourceTags` orders `1.0` and `1.0.0` as equal, so the guard does not use it.
- **An unreleased import whose tag moved is retargeted, not hard-reset (ruling 1).**
  `git reset --soft origin/main` keeps the new tag's tree and lands it as a fast-forward, so "prepared again at the tag the retry discovers" holds; the hard reset would have kept the old tree, #993's mismatch.
  "Released" is any `dataset_versions` row, read through `GET /datasets/:id/versions`, asked only when the tag moved; not being able to read it is a plain failure, never "unreleased".
  A retarget is refused when origin's `.nemar/corrections.jsonl` holds a line the new tree would drop with consequence: a recorded correction (ADR 0085), or an `import-scrubbed` line whose scrub blanked a JSON value or scrubbed a git-held recording, because origin's history still holds those originals and only a hard reset keeps that hold (ADR 0089).
  Step 5b's scrub writes the new tree's own ledger line; it does not carry the old ones.
- **The guard fails closed, and says when it is inert.** An origin whose `main` cannot be asked or fetched stops prepare (only `git ls-remote --exit-code`'s status 2, no such ref, is a first import; git's messages are localized, so none is matched); the recorded tag is read before the branch name, so a detached or adjusted branch cannot skip it.
  When origin's `main` records no readable tag, prepare prints why, because the guard cannot fire then.
  The refusal of a released mirror names the repair that passes the guard, `nemar admin import-openneuro <ds> --tag <recorded tag>`; the retry engine dispatches no tag, so it never runs it.
- **The entry.** A first import, and a retarget, record `{DOI: doi:10.18112/openneuro.<ds>.v<tag>, URL: https://openneuro.org/datasets/<ds>/versions/<tag>, Version: <tag>}` in `SourceDatasets`, all three from the one tag, unless an entry already records a tag for the dataset.
  An untagged entry that names the dataset alone (a concept DOI, a dataset page) is completed in place, so the dataset keeps one entry.
  The import writes only a record the parser then reads as the tag: when an entry for the dataset carries another tag or names another dataset too, or the tag is not one the parser reads, the file is left alone and prepare warns that the guard stays inert for the dataset.
  It is not written after a hard reset, whose tree is origin's.
  Publication's `applyConceptDoiToDescription` (`shared/standard-edits/description.ts`) compares DOIs normalized and adds no second entry for a dataset an entry already names, judged by the parser's `isOwnSourceEntry`, so a stale or differently spelled upstream `DatasetDOI` cannot make the recorded tag unknown.
- **`upstream_moved` and `annex_uuid_conflict` (ruling 3).** Recovery has no rule for either marker, so a failure usually quarantines the row by the dataset's state first (`has_doi` for a released mirror), and a quarantined row is no retry candidate.
  The retry engine's park, in both wordings of the annex conflict, is the backstop for a `failed` or `incomplete` row that carries one and reaches the sweep, because each retry fails the same way; an operator restarts the import by hand after fixing the bucket marker.
  The #1320 preflight compares the bucket's `annex-uuid` with the `nemar-s3` uuids the git-annex branch records and refuses a disagreement with `[nemar-annex-uuid-conflict]`, naming both and the recovery.
  It answers unchecked, and prepare goes on as before with a warning, whenever the comparison is incomplete: Step 4b's fetch or merge failed, git cannot read the branch, the bucket cannot be asked, or origin has a git-annex branch that records no `nemar-s3`.

## Amendment 2026-10-24 (#1910): Phase 4a builds the staleness report

Epic #1046, Phase 4, first part.
Decision 6 says staleness is "computed by its own report" and designs no more than that.
This section says what the report is, in the words the code uses, and states the readings the decision text left open.
The decision text above is unchanged.
The command (`nemar admin upstream-status`), the weekly section and the mirror flag are not built by this part; the next part builds them and records them in its own amendment, and where this section mentions them it says "will".

### What it is

`GET /admin/upstream-status[?limit=N][&after=onNNNNNN][&dataset=onNNNNNN]` is read-only and admin-only.
It reads D1, asks OpenNeuro for the snapshot lists of the mirrors that need it (a batched GraphQL query, fifty datasets to a request, sequential, ids only as variables), and asks OpenNeuro's GitHub mirror whether a newer tag has arrived.
The report itself writes nothing to D1, GitHub or S3, sends no mail and files no issue (ADR 0052, ADR 0053, ADR 0055); authentication, which wraps the route, still stamps `tokens.last_used_at`.
The verdicts are one pure function in `shared/upstream-staleness.ts`, so that the route now, and the command, the weekly report and the later scheduler (all still to be built) will read the same answer.
A call examines at most 100 mirrors.
`dataset` together with `after`, a `limit` that is not a positive integer, and a malformed `after` or `dataset` are 400.
`counts` in a response is for that page; aggregating pages is the caller's job, and the command of the next part will do it over the rows.

### The population

The report covers managed `on######` mirrors: `source = 'openneuro'`, not owned by the system user.
A withdrawn mirror is excluded from the pass and counted on its own, so the report says how many it left out.
Any other `on######` row (another `source`, or owned by the system user) is also left out and counted, as `excluded_unmanaged`, so what was left out is said (ADR 0054).
`xx` fixtures are not covered, and the "Left open" item above stays open for the re-pull phases.
Every other managed mirror is classified, public or not; the row carries its visibility.
Design §4 said "public"; the decision text does not, and a private mirror that is behind is still behind.

### The states, and which wins

A row is exactly one of `current`, `stale_ready`, `mirror_lag`, `stale_unverified`, `anomaly`, `unknown`, `not_examined`, `unpublished`, `in_progress`, `parked` or `unchecked`.
"Stale" is the sum of the three `stale_*` states.
The first matching step wins:

1. An import is preparing, copying or finalizing and the row is not blocklisted: `in_progress`.
2. The row is blocklisted, or its import is quarantined or rolled back: `parked`.
3. `source_id` names another dataset than the id implies: `anomaly` (`source_id_mismatch`).
4. No NEMAR version exists: `unpublished`.
5. The highest version was never examined for its tag: `not_examined`.
6. The highest version's tag is unknown: `unknown`, never current and never stale.
7. The tag is known and OpenNeuro was not asked or could not answer: `unchecked`.
8. Upstream is deleted or absent: `anomaly` (`upstream_deleted`, `upstream_absent`).
9. Upstream has no snapshot: `anomaly` (`upstream_no_snapshot`).
   A snapshot in upstream's own list was created after the one it calls latest: `anomaly` (`upstream_latest_inconsistent`), before the tags are compared.
10. The latest tag equals the recorded one: `current`.
11. The latest tag is not a numeric tag: `anomaly` (`upstream_tag_unparsable`).
12. The recorded tag is not among upstream's snapshots: `anomaly` (`recorded_tag_not_upstream`).
13. The latest snapshot was created at the same time as the recorded one (`upstream_older`; an earlier latest is already `upstream_latest_inconsistent`, because the recorded tag is in the list), or either date is unreadable: `anomaly` (`upstream_older`, `upstream_dates_unreadable`).
    The latest's own date is tried first and its entry in the list second; if neither reads, the row is `upstream_dates_unreadable` before the tags are compared, so an undated latest never reads `current`.
    *Annotated 2026-10-24 (Phase 6b): any other snapshot in the list whose date is unreadable (`list_undated`) is `upstream_dates_unreadable` too, before the times decide, because it could be the newest; see the Phase 6b amendment.*
14. Otherwise upstream is newer, and the GitHub mirror decides between `stale_ready`, `mirror_lag` and `stale_unverified`.

A row that cannot be compared (steps 1 to 5) is never sent to OpenNeuro.
`unchecked` is the state of a mirror whose answer could not be had, and it is never rendered as current or as not stale (ADR 0053, ADR 0054).
A partial GraphQL response (a node and an error for the same alias), a null latest beside a non-empty list, and an error message that is not "Dataset <that id> does not exist." are each an `unchecked` read, never a verdict.

### Upstream's creation order decides, not the number

Design §4 said tags compare numerically, and the decision text does not fix an order.
Real histories contradict the numeric reading: `ds000001` has snapshots `00006` (2018) and `1.0.0` (2020), and `1.0.0` is numerically smaller.
Ordering by number would call a mirror recorded at `00006` an anomaly while it is stale.
So the recorded tag must appear in upstream's snapshot list, and upstream's latest is newer when its creation time is later.
`compareSourceTags` is not used for the verdict.
A latest tag that the Phase 2 parser could never record (`57fecb0c...` is a legacy snapshot id; `v2.0.2.` is a negative example of the parser's tag pattern) is an anomaly, because a re-pull to it could never be proved afterwards by a recorded `source_version`.
Known limit: a tag re-created upstream under the SAME tag (OpenNeuro's `ds003645` 2.1.0 carries a creation time later than its first sighting) cannot be detected from the tag, so the mirror reads `current` or `stale` by tag alone.
The dry-run plan of the re-pull phase compares trees and sees it.
*Annotated 2026-10-27: not for the mirrored tag. A plan to a tag equal to the mirrored tag is refused as `nothing-to-pull` before any tree of upstream is cloned or compared (`src/lib/repull/preflight.ts:157-158`, `src/lib/repull/plan.ts:278-294`), so nothing detects that a mirror's recorded tag was re-created.
A re-created target tag is caught once a plan has read it: before the copy, the registration and the pull request, execution refuses with `upstream-tag-moved` when the tag names another commit than the plan read (`src/lib/repull/execute/advance.ts:146-176`).*

### Mirror lag is proved, not inferred

The report reads `dataset_description.json` of `OpenNeuroDatasets/<ds>` at the newer tag through the authenticated raw CDN.
A hit is `stale_ready`.
A 404 is `mirror_lag` only if a control read of the same repository at `HEAD`, with the same credential, succeeds: the same kind of proof as the backfill's for a 404 (Phase 2 amendment), read at `HEAD` because OpenNeuro's default branch name varies, where the backfill reads `main`.
A 200 counts only when its body is a JSON object, so an HTML page served with a 200 is `stale_unverified`, for the tag read and for the control read alike.
An error, a 404 on the control too, or a call whose probe budget ran out is `stale_unverified` with the reason, and is still counted stale.
Two known limits: a tag whose root holds no `dataset_description.json` would read as lag, which is not seen in practice; and the raw CDN caches a 404 for about five minutes, so a tag that arrived minutes ago can read `mirror_lag`, and a re-check inside that window will not change it.

### Probably stale, for display only

An `unknown` row is compared with upstream by date only to say "probably stale": upstream's latest snapshot was created after the mirror's highest NEMAR version row.
It is a separate count, never added to stale and never recorded as a tag (decision 4).

### No cron, and nothing is filed

Nothing acts on staleness before the scheduled re-pull, and ADR 0053 says an alarm needs outstanding work.
The report runs on demand.
The Monday report will carry a counts-only section (the next part builds it), which will be the unconditional heartbeat ADR 0054 asks for.
The argument against a daily job holds once that section lands: until then nothing sends the number anywhere, and the on-demand route is the only reader.
A daily job would spend subrequests on the busiest tick and produce a number nobody receives.
The scheduler of the later phase will call the same service.

### Two points the decision text should have made

"In-progress" can mean only `import_jobs` today.
When `upstream_repulls` exists, a non-terminal row there must join step 1, and candidates for a re-pull come from `stale_ready` alone.
A report with stale mirrors is a successful report.
The route answers 502 only when at least one row on the page needed an OpenNeuro verdict (a known tag) and every such row ended `unchecked`.
A page of only unknown-tag rows with OpenNeuro down is 200 with those rows `unknown`, their reasons naming the failure, and a partial failure is 200 with some rows `unchecked` and the problem in `errors[]`.
A per-alias OpenNeuro read failure on an UNKNOWN-tag row leaves the row `unknown`, with `unchecked` at 0 and `errors[]` empty (`errors[]` carries batch-level failures only), so the command must not read unknown rows as verified clean: they are by definition not compared, and the reason text names the failure.
So a 200 does not prove every mirror was compared: the command of the next part must treat a 200 whose rows include `unchecked`, or whose `errors[]` is not empty, as "could not see" and exit 2, not only a 502.


## Amendment 2026-10-24 (#1910): Phase 4b builds the command, the weekly section and the mirror flag

Epic #1046, Phase 4, second part.
This part builds what the Phase 4a amendment said "will" be built: the command that walks the report, its section in the Monday report, and the derived mirror flag of decision 5.
The decision text above and the Phase 4a amendment are unchanged.

### The command

`nemar admin upstream-status` walks `GET /admin/upstream-status` page by page and adds the pages up itself.
It recounts the states from the deduplicated rows with the shared counter and never adds the pages' own `counts`, so a row seen on two pages is counted once.
It exits 0 when no row was `unchecked`, no page failed or carried `errors[]`, `--max-pages` did not stop the walk early and the population did not change during the pass, whatever the stale count: stale is a finding, not a failure.
Exit 0 does not mean a clean fleet: unknown-tag and never-examined mirrors were not compared and still exit 0, which is why the report prints them with their own counts.
It exits 2 when the pass could not see: any `unchecked` row, any page the API refused (502, after which the walk stops, because a down OpenNeuro would cost its timeout on every remaining page), any page whose `errors[]` is not empty even on a 200, `--max-pages` reached before the end, or a population that changed during the pass.
It exits 1 when a request fails; after a failed first read it prints the failure and no table, because a table of zeros would claim a fleet that was never read.
An `unknown` row is by definition not compared, and the command says so; a per-alias OpenNeuro failure on one leaves it `unknown`, so it is never read as verified clean.
`--dataset` and `--after` examine part of the fleet and do not demand all of it.

### The weekly section

The Monday report gains `## Upstream freshness`, after Coverage: "Examined N of M" and how many of those were actually compared with upstream (a mirror never examined for its tag is examined and not compared), counts by state rendered only through the one renderer that prints unknown as unknown, "Stale in total", the count of unknown-tag mirrors that look stale by date (display only), and a pointer to the command.
The split of the stale rows between "tag on the GitHub mirror", "not there yet" and "not checked" depends on the 25 probes one pass makes and is not a fleet-wide proportion; the report says so.
No dataset is named in it, and none in the errors it adds, because the report is filed on a public-facing repository.
Stale is reported and is not a reason for the week to ask for attention: it is the expected backlog until the scheduled re-pull exists, and an alarm that never clears gets muted (ADR 0053).
Blindness is a reason, and arrives three ways.
A pass that did not run or threw leaves `upstream` null, which the shared attention rule treats as unknown, and so does a backend that predates the field.
A mirror that could not be compared (`unchecked`), a problem OpenNeuro reported, and a pass that did not reach every mirror each add one entry to the report's list of failed parts, which the headline counts.
The pass is bounded for the Monday tick, which shares ONE subrequest allowance with its other jobs.
A page of 100 mirrors is at most 2 GraphQL requests and 3 D1 statements, so 20 pages are at most 40 GraphQL requests and 60 statements, plus at most 25 tag reads and 25 control reads (the probe budget is for the whole pass, not per page), plus one token mint: about 151 in the worst case, and about 101 for a fleet of 1,000 mirrors.
The token is minted once for the pass, and a failed mint is remembered rather than retried on every page.
A stale row the budget left out reads `stale_unverified`, which is still stale.
The 20-page cap is a ceiling of 2,000 managed mirrors.
Past it `truncated` is always true and every Monday would add a "did not reach every mirror" entry, a permanent alarm that gets muted (ADR 0053), so when the fleet nears 2,000 the cap must be raised; each added page costs up to 5 subrequests.
`nemar admin import-weekly` prints the same counts, and `unknown` when the pass is null or absent.
It exits 2 when the pass threw (the backend then also lists an `upstream` entry among the failed parts, which that command already reads as "could not determine"), and 1 when the backend predates the field (the key is absent and there is no such entry).
The log line gains `upstream_stale=` and `upstream_unchecked=`, `unknown` when null.

### The mirror flag

Decision 5 defines a mirror as a version row with `source_version` set and a version of the form N.0.0, and says the API exposes it as a derived flag.
The flag is three-valued, because a literal boolean would have to say "not a mirror" for a version whose tag is unknown, which is the unknown-as-no that ADR 0054 forbids.
`true`: an N.0.0 of an `on######` dataset whose row records a known tag (basis `doi` or `lineage`).
`false`: any other dataset, or a version that is not N.0.0, whatever it records (NEMAR's own corrections are N.x.y).
`null`: an N.0.0 of an `on######` dataset whose tag is unknown or was never examined; a consumer must not show it as a mirror.
It is read from each row's own tag, not from the dataset's highest version, derived at read time and never stored, so `datasets` gains no column.
It rides on every version of `GET /datasets/:id/versions` (beside the tag and its basis, which that owner-or-admin route already carried) and of the public landing, `data.nemar.org/<id>/` as JSON and the page bundle's landing, which exposes the flag only and neither the tag nor its basis.
*Annotated 2026-10-27: the route is open to the dataset's owner, its collaborators and administrators (`backend/src/routes/datasets/manifests.ts`), not only to an owner or an administrator; the Phase 8 amendment, "The `mirror` field, as a reader sees it", corrects the phrase.*
Decision 5 says the website shows a mirror tag on that version.
What the website receives is the flag, so it shows a chip from `mirror`; the public wire carries the flag and never the tag itself.
`metadata.json` is not changed.
An `xx` fixture is `false` even after a rehearsal re-pull; how an `xx` names its upstream stays open (Left open, above).

## Amendment 2026-10-24 (#1912): Phase 6 builds manual execution

Epic #1046, Phase 6, delivered in slices; each pull request adds the slice for what it builds, and the decision text above is unchanged.
This slice is the record (decision 3) and the fences that guard it (decision 6).
Nothing here copies, pushes or opens a pull request: the record is written by routes that only record and refuse, and no route sends mail (a source scan pins that the code imports no mail service).

### The table keys a row by attempt

Decision 3 reads "one row per `(dataset_id, to_tag)`, `UNIQUE`".
Taken literally, a tag whose re-pull was abandoned or failed could never be tried again, so this record reads it per attempt: migration 0105 keys the row by `(dataset_id, to_tag, attempt)`, and the partial unique index still allows one non-terminal row per dataset.
A new attempt for a tag is allowed only when every earlier attempt ended `abandoned`, `failed` or `superseded`.
A tag is merged as a major once: a second partial unique index on `(dataset_id, to_tag)` where `merge_sha` is set backs that in the database.
A row with the same tag and the same plan digest is returned as it is (200), before the version rows are consulted, so a rerun resumes it even after N.0.0 is tagged and is no longer the dataset's highest version; any other open row is `repull-in-flight` and names itself.

### A merge that nothing has reconciled blocks the dataset

Create refuses (`merge-unreconciled`) when any record of the dataset holds a merge claim or a merge sha, for either pull request, and is not finished, whatever its status: `failed`, `released`, `merged` and `gates_clear` all count.
`complete` is finished, and so is `patch_declined`, which is reachable only from a released N.0.0 and is refused while the patch claim is held.
A `failed` row that has a tag sha and no patch claim or patch merge is finished too: N.0.0 is merged and tagged, so nothing is unreconciled, though its tag stays pulled.
The case Phase 6f still owns is a `failed` row with a claim or a merge sha and no tag sha, or with any patch claim or patch merge: nothing in 6a writes out of it.
*Annotated 2026-10-25: Phase 6f did not reconcile it: no path it builds writes `failed`, and such a record keeps the dataset blocked until an administrator resolves it by hand; the Phase 6f amendment names it as an open item for the owner.*
`failed` stays writable on purpose, so a lost merge answer can be reported; it does not free the dataset, because a merge may be on `main` with no row saying so, and a second major would be a second DOI.
Clearing a claim after GitHub confirms the pull request was not merged, and expiring a stuck open row, are written by Phase 6f (resume and reconcile); Phase 6a has no writer for either, and open rows never expire here.
*Annotated 2026-10-25: the first half is built by the Phase 6f amendment (a stuck claim on an open record expires, `expired`, through resume); the second is not: a `failed` record holding a claim is still not reconciled, an open item the Phase 6f amendment names.*

### The fences, as built

- **Environment.**
  Every `/admin/repulls` write refuses a dataset that is not `xx` unless `ENVIRONMENT` is exactly `production`.
  The test is "is production", not "is not a known non-production value": the organization is shared, so an unset or misspelled binding must leave the fence on, which is the reverse of the repository's usual fail-closed helper.
  The same fence applies to a transition, so a record of an `on` dataset cannot be moved outside production either.
- **Anonymous datasets** are refused (`anonymous-dataset`) with no override.
  A re-pull takes upstream's authors and README, which would undo ADR 0065's blind.
- **A withdrawn dataset**, **an import that is preparing, copying or finalizing**, and **a dataset not recorded as a mirror of that `ds`** are refused, each by its own code.
  These run at create only: the execution phases must re-check the anonymity, withdrawn and import fences when they move a record, which a transition does not do today.
  *Annotated 2026-10-24: superseded by the Phase 6e amendment: the mirror, anonymity, withdrawn and import fences now also run at the screen's dispatch, at the gates and at the claim to merge.*
  *Annotated 2026-10-25: and by the Phase 6f amendment: on every step past `prepared` that keeps the record open.*
- **The dataset's own version rows must agree with the plan.**
  The highest version (both `1.0.0` and `v1.0.0` spellings, ordered by number) must be the plan's `from_version`, and every row at it must name `from_tag` by `doi` or `lineage`.
  A row recorded `unknown` is never re-pulled (decision 4).
  A row never examined is accepted only when the plan itself establishes the lineage, because the Worker has no other evidence of the tag.

### The states as built

The 17 states, and the only edges between them, are `shared/repull-state.ts`; the database holds the stage invariants as CHECKs, so a half-written row is refused even by a writer that skips the service.
A transition is one compare-and-set on the recorded status and on the row's `revision`, which every write increments, so of two writers that read the same row only one applies, even when both repeat a status.
It takes only an allowed edge, writes only the columns its target names, and keeps the pull request's branch and number once set.
A branch must be the release branch of the version the row carries.
`counts` is merged key by key and holds only declared keys with non-negative integers, never a path or a key.
`last_error` goes through the ADR 0051 rule and is never blank; an edge into `failed`, or the `planned` edge that records why a step could not finish, must say why, and an edge into a different, non-terminal status clears the stored error.
*Annotated 2026-10-24: the Phase 6c amendment adds that a `prepared` self-edge sent with no error clears it too, because it records the whole stage again; execution sends one that way only when the stored error is a preparation's own (its words begin `[prepare:`), so an error a later step recorded is not cleared.*

Four edges repeat a status to write one thing: `planned` (the error), `released` (the count of locked objects) and `gates_clear` and `patch_gates_clear` (the claim to merge).
*Annotated 2026-10-24: the `prepared` self-edge is allowed as well and Phase 6c uses it, to record a preparation again (onto a moved base, or to clear a stale error of a preparation's own) or why it failed; see the Phase 6c amendment.*
*Annotated 2026-10-24: the Phase 6d amendment adds `copied` and `registered`, which repeat to record the error of the step that follows them, as `planned` does.*
The claim is recorded before the merge is sent, names exactly the screened head, and cannot be recorded twice.
The caller sends the head and nothing else: the Worker stamps the time with its own clock and refuses a request that carries one, because a caller-stated time could be backdated or set ahead and defeat the sweep for stuck claims that Phase 6f writes.
*Annotated 2026-10-25: Phase 6f writes no sweep: a stuck claim expires when resume reads it, through the claim's release with the outcome `expired`, once the Worker's own stamp is 30 minutes old (see the Phase 6f amendment).*
The time and the head are set together or not at all (a CHECK).
While it is held, closing the pull request (`abandoned`, `superseded`, `patch_declined`) and moving its head (`pr_open`, `patch_synthesized`) are refused, because the pull request may have merged; `failed` is not.

Two kinds of state are not written by this route, so a caller cannot state them.
`merged`, `released`, `patch_merged` and `patch_released` are facts about GitHub and the version row, and are written only by routes that read them.
`gates_clear` and `patch_gates_clear` are written only when the identifier screen is bound to the row.
Both groups are refused here (`use-verified-route`, `screen-not-built`) except for the repeating edges above, so the record cannot be used to skip the screen or to claim a merge that did not happen.
*Annotated 2026-10-24: superseded by the Phase 6e amendment: `screen-not-built` no longer exists; `gates_clear` and `patch_gates_clear` are accepted through the transition route when the screen bound to the row passes for the pull request's live head.*

### The record is deleted with its dataset

Unlike `import_jobs`, whose state row deliberately outlives the dataset so a rolled-back orphan stays auditable, `deleteDatasetCascade` deletes these rows.
A fixture dataset is deleted and re-created under one id, and a stale open row would block the re-created dataset for good; the DOI record of a merged re-pull lives in its own tables, not here.

### Lineage at create

`lineage_recordable` is an administrator's assertion that the plan compared the from-version's tree with upstream's outside the paths NEMAR owns.
The Worker holds neither tree and has no evidence of it; the assertion is recorded in the audit row.
When it is made, create upgrades that version's row to the basis `lineage`, in the same batch as the record, and says how many rows it upgraded (`lineage_rows`).
It writes only a row never examined, or one that already names the same tag by `doi` or `lineage`, in either spelling of the tag; a row recorded `unknown`, or naming another tag, is never overwritten.
The upgrade is one way: `doi` becomes `lineage` and nothing writes it back, so the audit row records the basis the row held before.
One statement writes the word `lineage`, and a source scan keeps it the only one.

### The staleness report reads the record

The staleness report's Amendment (#1910) says "in-progress" can mean only `import_jobs` until `upstream_repulls` exists, and that a non-terminal row there must then join the first step.
It does now: a mirror with one open re-pull, in any non-terminal status, is `in_progress` ("a re-pull to <tag> is <status>"), is never sent to OpenNeuro, and is never offered as a candidate for another re-pull.
The partial unique index allows at most one open row per dataset, so the join adds no rows.

## Amendment 2026-10-24 (#1910): Phase 4c builds the measurement

Epic #1046, Phase 4, third part.
Gate G2 of the design record asks for a measurement before anything runs on its own, and decision 6 lists what it holds.
This part builds the half of it that upstream alone can answer: `nemar admin upstream-status --measure`.
The decision text above and the earlier amendments are unchanged.

### What it measures

For each stale mirror (`stale_ready`, `mirror_lag` or `stale_unverified`) the command reads OpenNeuro's recursive file listing at the recorded tag and at upstream's latest tag, in one request, and summarizes the difference.
Files match by name, and a file is changed when its identifier differs, whatever its size.
An annexed file's identifier is its annex key, so a changed key is changed content.
A file counts as annexed when the snapshot that holds it says so: the new side for an addition, the old side for a deletion, either side for a change, so a file that moves between git and the annex is annexed.
A delta is data-changing when any annexed file was added, changed or deleted, and metadata-only otherwise.
The bytes to copy are the sizes of the distinct annex keys the latest snapshot has and the recorded one does not, read from the size each key declares in its fields (the strict field, so a free-text name that looks like a size is not read as one) and otherwise from the listing.
A listing is refused rather than summarized when it cannot be a snapshot: no file at all, no root `dataset_description.json`, a size that is not a non-negative integer, a repeated filename, or an answer that carries `errors[]` beside its data.
An empty tree would otherwise make every file of the other snapshot look added or deleted.
The mirror report prints the files added, changed and deleted, the bytes to copy, and how many deltas are metadata-only and how many are data-changing.
The listings are a few megabytes for a dataset of thousands of files, so the command reads them from the administrator's machine and the Worker never does.

### DOI volume

The estimate reads the snapshot lists the staleness pass already holds, for every mirror whose tag is known.
The catch-up is one re-pull, straight to the latest tag, for each stale mirror.
The trailing year of upstream churn is counted two ways: one re-pull for every snapshot created in the window, and at most one per 30 days for a dataset.
A dataset's first snapshot (the earliest by date, whatever the list order) was its import and is not counted; when any snapshot of a dataset has an unreadable date the earliest cannot be named, so none is left out for that dataset and the estimate errs high.
A snapshot whose creation date does not parse is counted separately and never read as old, and a snapshot dated in the future is counted separately and left out of the figures.
The human report also lists the mirrors the estimate left out, by state.
Whether a re-pull also carries NEMAR's corrections, and so a second DOI, is known only from a plan, so every figure is also given doubled as an upper bound.
At the default `REPULL_DAILY_OPEN_CAP` of 2 the catch-up takes the number of re-pulls divided by two, rounded up, in days.

### Two limits, and what belongs to Phase 5

The delta is upstream's between the two tags.
It is not NEMAR's tree: NEMAR's own corrections, the scrub, the annex policy and date normalization are not in it, so it says how much upstream changed and not how much a re-pull would write.
A tag recorded with basis `doi` is a declaration, not a tree comparison (see "What `doi` means"), and early imports cloned the default branch, so a delta measured from a wrong declaration is wrong.
The command prints both limits with the numbers.
The conflict and unexplained-path counts of gate G2 need a plan, which compares NEMAR's tree with upstream's; they come from Phase 5's `nemar admin repull plan`, and G2 is complete only with them.

### Unknown is never zero

A listing that could not be read leaves that delta null with its reason and counts it as unknown.
A stale mirror left out by `--measure-limit` is counted as not measured.
While either count is above zero, or a new key in a measured delta has no known size, the total bytes to copy is null, and the sum over the deltas with a known size is printed beside it as "at least".
A total also says what it does not cover.
Only stale mirrors are measured, so the measurement carries the scope of the pass (the whole fleet, one mirror, or the mirrors after a cursor) and a count of the mirrors it cannot measure: unknown tag (and how many of those look stale by date), never examined, unchecked, anomaly, in progress, parked and unpublished.
The measurement is marked incomplete while any delta is unknown or not measured or a new key has no known size, so a complete measurement always has a known byte total; a deliberate `--measure-limit` leaves the exit code at 0.
A delta that could not be read exits 2, as an `unchecked` row does: the pass could not see.
Reading is sequential, with a progress line every ten mirrors, and stops after five consecutive failed reads to reach OpenNeuro (a network error, a timeout or an HTTP error): the rest are recorded as unknown with that reason, because OpenNeuro being down would otherwise cost the timeout on every remaining mirror.
A listing that OpenNeuro answered but that is unusable for one dataset (a snapshot deleted upstream, no root `dataset_description.json`, errors beside the data) marks only that mirror unknown and does not count toward the stop.
Only a complete pass is measured: one that threw, was refused, stopped at `--max-pages`, saw the population change, had an `unchecked` row or carried `errors[]` may hold a partial set of stale mirrors, and totaling a part of the fleet would read as the whole.
Such a pass reports `measurement` as null with the reason and keeps its own exit code.
The measurement is read-only: it writes nothing to NEMAR or to OpenNeuro, and the only requests it sends OpenNeuro are read queries.

## Amendment 2026-10-24 (#1912): Phase 6e binds the screen to the row, caps the merge and verifies the release

A further slice of the Phase 6 amendment above, built by Phase 6e.

### The screen is bound to the row

This slice is the screen of decision 7, the merge cap of decision 6, and the two facts the record could not state before, the merge and the release.
Nothing here merges, opens or closes a pull request, and nothing mails anyone; the source scan that pins the record's import closure now covers the screen, its callback and the verified service too.

A re-pull's screens live in `upstream_repull_screens` (migration 0106): one row per screened commit of one of the two pull requests, `n0` for N.0.0's and `n1` for N.0.1's.
`POST /admin/repulls/:id/screen` dispatches the publication screen's workflow with `ref` set to the recorded head, `request_id` 0, and a callback of its own, `/webhooks/identifier-screen-repull-result`, whose token is a kind of its own.
The token binds the dataset, the row, the pull request, the commit and a one-shot nonce, under a domain line no other kind's message begins with.
A screen is dispatched only while its pull request is open and not yet clear (`pr_open`, `patch_synthesized`), only for the head the row records, and only while the environment and dataset fences hold.
Outside production only an `xx` dataset passes the environment fence, and ADR 0086 exempts `xx` from the screen, so a non-production Worker never dispatches one.
The workflow resolves a 40-character `ref` to that commit and reports it as the screened head (read in `scripts/identifier-screen-ci-lib.ts`, not run).

The publication screen mails its result; this one does not, so it reads the publication screen's helpers from the module that mails nobody.
The report deadline and the Worker's own error report moved there for that reason, and the publication screen re-exports both.

Unknown is never clear.
No screen, a screen that errored, and one still pending 50 minutes after its dispatch all read as "run it again"; the last reads `unreported` when it is read, so no cron writes it, and its run may still report until a new dispatch replaces the nonce.
A report about another commit or another dataset, or outside the contract, is stored as the Worker's `workflow-failed` error, never as a verdict.
A commit is dispatched again while it has no verdict, and while its verdict asks for a person (review, unchecked, not screened, clean in EDF only) and no administrator has acknowledged it, so a rerun may still clear it; a run still out, a clear verdict, a direct identifier and an acknowledged verdict are not, and only a new commit is screened anew.
Dispatching for a new head frees the earlier run, so at most one run per re-pull waits for a report, which the callback needs because the workflow echoes only the dataset.

An acknowledgment (ADR 0086) attaches only to a verdict that asks for a person, never to a direct identifier, with a reason of the publication path's length, and the database refuses one on any other state.
It counts only for the administrator who recorded it, the publication path's rule, so a reason one administrator gave does not stand in for another's at the gates or at the merge.
It is recorded once: a second administrator is refused (`already-acknowledged`), and the write itself holds only while none is recorded.
So if the administrator who recorded it is absent, or is no longer an administrator, nothing else unblocks the pull request: only a new head, screened anew, does.

The edges into `gates_clear` and `patch_gates_clear` were refused by the record until the screen was bound (`screen-not-built`); they now open.
The gates sha must be the head the row records, the dataset fences are read again, and the screen must pass for that head; the statement that writes the edge re-asserts the verdict it read, so a verdict that changed in between is not relied on (`screen-changed`).
The caller's word for the head is not taken: before the gates and before the claim the Worker reads the live pull request on GitHub, which must be open, not a draft, unmerged, aimed at `main` from the recorded release branch, with its head at the sha being gated or claimed; a GitHub that cannot be read refuses (502), a draft is `pr-draft` (409) and takes no unit of the cap, and any other mismatch is `head-moved` (409), with nothing recorded.
The live read is followed by the UPDATE and then the caller's merge, so the head check holds only if Phase 6f's merge call passes that same `sha` to GitHub's merge API, which refuses a head that moved: GitHub's `head.sha` can lag just after a push, in the unsafe direction, and the merge's own `sha` is the check that closes that gap.
The dataset fences are read again by the Worker at every step toward a merge: the dispatch, the gates and the claim; the other edges still re-check only the environment fence.

### The merge cap, as built

The claim to merge stays the self-edge the first slice built, and it now also needs the dataset fences, the screen passing for the claimed head, the live head, and one unit of `REPULL_DAILY_MERGE_CAP`.
The screen's verdict, the unit and two of the dataset fences (neither anonymous nor withdrawn) are in the statement that writes the claim, so they are atomic with it, and two claims racing for the last unit cannot both win; the mirror and import fences and the live head are read before it.
A refused claim writes nothing (ADR 0099).
The day is a fixed UTC day on D1's own clock, and N.0.0's and N.0.1's claims count together, because each merge mints a DOI.
The binding reads as Phase 7's caps will: absent, the default 5; one or two digits from 0 to 20, that number, and 0 stops every merge; anything else reads 0, and the refusal says the cap is unreadable (`merge-cap-unreadable`) rather than quietly falling back to the default.
Reporting that as attention in the weekly report is Phase 7's.

A claim is released only when the caller says the merge was not sent or was refused, while the row is still at its gates-clear status holding that claim, only once the claim is five minutes old by the Worker's own stamp (`claim-too-recent` before that), and only when GitHub says the pull request did not merge; an unknown outcome cannot release, so a lost answer is resolved from GitHub.
That is a guard of one read and an age, not proof that no merge is in flight: a merge that lands between the read and the release is recorded later, by the merge route, as one no tool held a claim for.
The route is built here; Phase 6f's resume is its caller.

### The merge and the release, verified

`merged` and `patch_merged` are written by `POST /admin/repulls/:id/merged`, after the Worker reads the recorded pull request on GitHub with its own credential: its number, its release branch, aimed at `main`, merged, and GitHub's merge commit.
A merge with no claim held by a NEMAR tool, and a merge at a head other than the screened one, are still recorded, because they happened and the record must say so before a second major could follow; each is counted on its own, `merged_outside_tool` meaning only that no claim was held and `merged_unscreened_head` only that the merged head is not the screened one, and those two counts are written only by the Worker and shown in the record.
The cap binds NEMAR's tools only (Consequences); this is how a merge outside them shows.
A pull request merged while the row is still `pr_open` has no edge here; the row stays open, which blocks a new re-pull, and Phase 6f's resume owns it.
*Annotated 2026-10-25: built by the Phase 6f amendment: the edge `pr_open -> merged` is the verified route's alone, and resume records such a merge through it.*

`released` and `patch_released` are written by `POST /admin/repulls/:id/released` once the version row exists with a DOI (either spelling of the version), the tag `v<version>` resolves to the commit the caller reports, and that commit contains the merge.
Containing, not equal: the dataset workflow tags `main`'s head when it runs, which can be an enrichment commit after the merge.
A comparison that says `diverged` or `behind`, or a tag on another commit, is `tag-mismatch`; a comparison GitHub could not make is `compare-unresolved`.
A retried `merged` or `released` that finds its fact already recorded for the same commit answers with the stored row (`replayed`), so a caller whose answer was lost may ask again; another commit is refused.
In the same batch, and only when the transition itself applies: N.0.0's version row is upgraded to `lineage` when the caller verified the tagged tree outside the paths NEMAR owns (an assertion recorded in the audit row, as at create; never for N.0.1, which carries NEMAR's corrections), and the dataset's hed, channel-montage, data and availability stamps are removed, so each of those sweeps reads the new version again.
Only that dataset's stamps are touched, and the values the sweeps wrote stay until each sweep overwrites them.

Decision 2's "one ADR 0023 reconcile is queued" needs no new writer: the Zarr queue's `reconcile` already re-queues a public dataset whose `latest_version` differs from the version it converted, and every conversion runs `--clean`, which reconciles (`scripts/zarr/zarr_queue.py`, `scripts/zarr/hallu-zarr.sh`, read).
A release changes `latest_version`, so the stamp re-arm is the only new behavior.

Checked only against stand-ins, until the canary and the first production runs: that GitHub's commit read resolves an annotated tag to its commit, the words its comparison answers with, and a squash-merged pull request's `head` and `merge_commit_sha` as this reads them.

## Amendment 2026-10-24 (#1912): Phase 6b builds the seams execution shares with the import

Epic #1046, Phase 6, the slice of shared seams: code the import runs that the later slices' execution will run too.
Nothing here executes a re-pull, and the decision text above is unchanged.
It builds the delta scrub's inputs, the ledger word that scrub writes, the generated `participants.tsv` as a standard edit, the order `to_tag` is checked in, and the finalize gate as functions.
It makes two corrections, to decision 1's ledger rule and to the Phase 5 amendment's reading of `to_tag`'s order.

### The scrub takes a scope, a source per key, and a pinned version

Decision 2 says the scrub runs on the delta paths only.
`scrubImportedTree` takes the paths it may read and change (`scope`), and a recording, a JSON file or a scans table outside them is neither read nor changed; its counts see only the scope.
The scope must name every path changed since `HEAD`, staged or not, and every untracked path `.gitignore` does not exclude, or the scrub refuses (`scope-incomplete`) before it reads anything, because a changed path it does not read would reach the commit unscrubbed.
So a re-pull's scope holds every delta path it wrote, every one it deleted, and every `.gitattributes` the annex policy edited (ADR 0060).
A re-pull never commits a header change whose provenance file lacks its sentence (ADR 0085's for a scrub, ADR 0091's for a date): when a header in the scope will change and a provenance file (`sourcedata/sourcedata_provenance.json` or its README) lies outside the scope, the scrub refuses (`provenance-out-of-scope`) after the ranged header reads that decide it and before any recording is downloaded, and the caller puts both files in the scope (the lead's ruling of 2026-10-24, which settles the owner question this slice first left open).
The rule counts a planned change, a date-only one included; a date-only recording whose download would later have failed, leaving its header as it was, is refused all the same, the safe side.
A provenance file that is not a JSON object is counted on its own (`provenance_malformed`), apart from one that is not a regular file (`provenance_not_annotated`); the importer warns on either, as it did.
The caller names each annexed recording's source (`sourceOf`) in place of the importer's whereis map: a source, a key NEMAR already holds, whose bytes are already in NEMAR's bucket where the identifier screen reads them (ADR 0086, ADR 0088), so it is counted and not read again, or none, which is counted.
A source can be one version of an S3 object, read at its path-style URL with every segment encoded and `?versionId=` kept, for the header and for the download, so the scrub reads the bytes decision 8's pinned copy will copy; the rules that the object is the key's size and hashes to it are unchanged.
The importer passes none of these, and its suites pass unedited.
The manifest's closing check, every recording a copy brings from upstream had its header read, is a function of its own (`assertCopiedRecordingsRead`), for the re-pull's copy to close with.
That `.log.rmet` records a `versionId` per key stays under "Not yet verified": this slice reads a pin it is given and verifies no upstream.

### `repull-scrubbed`, and the ledger rule (correction)

Decision 1 says a ledger line whose `action` is other than `import-scrubbed` is a recorded correction.
Read literally, the re-pull's own delta scrub would then record a correction on every dataset it scrubs, and the next plan of that dataset would refuse any unexplained path.
The delta scrub writes its own word, `repull-scrubbed`, before the one commit, so no history NEMAR pushes holds what it replaced (decision 9).
The rule, corrected: a recorded correction is a line whose `action` is neither `import-scrubbed` nor `repull-scrubbed`.
*Annotated 2026-10-29: nor `repull-merge-accepted` (the amendment of 2026-10-29).*
A `repull-scrubbed` line holds nothing: a re-import's history hold (ADR 0089) still reads `import-scrubbed` lines only.
ADR 0085's fresh-clone proof tolerates a commit that appends `repull-scrubbed` lines beside other files, as it tolerates the importer's, because the re-pull's commit is one commit; without that, every re-pulled dataset would fail `ledger-commit-not-alone` for good.
It does so only when that commit carries decision 2's `Upstream-Snapshot:` and `Repull-Plan:` trailers, as git reads trailers (the message's last paragraph), and edits no earlier line, so the merge that lands N.0.0 on `main` must end its commit message with both.
GitHub's default squash message lists each commit of the pull request as a bullet, so the re-pull commit's trailers end up mid-message; the proof reads no trailers in such a merge and fails the dataset with `ledger-commit-not-alone`.
Phase 6f writes the squash message itself so that it ends with both trailers.
*Annotated 2026-10-29: a squash merge made without them, with GitHub's own button, passes the proof only when a `repull-merge-accepted` line, which NEMAR's Worker writes after an administrator accepted the merge on evidence, names it (the amendment of 2026-10-29).*
*Annotated 2026-11-09: the same holds for GitHub's plain merge commit of the pull request, whose first-parent diff is the one the proof reads (the amendment of 2026-11-09).*
Neither scrub word can be typed: `ledger-cli.ts append` refuses `import-scrubbed` and `repull-scrubbed`, which only the scrub that wrote them, in the commit that carries what it scrubbed, may write.
*Annotated 2026-10-29: nor can `repull-merge-accepted`, which only NEMAR's Worker writes (`action-written-by-nemar-only`).*
Decision 10's retarget of an unreleased import still refuses any line but the importer's own, `repull-scrubbed` included.
A re-pull needs a released mirror, which the guard refuses before that rule runs, so the line should never meet it; if it does, dropping a record of a scrub is not the retarget's to decide, which is the safe direction.

### The generated `participants.tsv` is a standard edit (closes the Phase 5 amendment's open item)

The enrichment's placeholder `participants.tsv` (`ensureParticipantsTsv`, for a tree with `sub-*` directories and no file of its own) is one of decision 1's standard edits.
Its rule moved to `shared/standard-edits/participants.ts`, which the enrichment still reaches through `backend/src/services/participants-tsv.ts`, so the plan recognizes the edit by calling the function the enrichment commits with.
Where upstream ships no `participants.tsv` at a tag, NEMAR's file is explained from that tag when it is, byte for byte, the placeholder of that tag's subjects.
The file is a function of the subjects, not of any upstream file, so it is upstream-changed when the subjects changed between the tags, and N.0.0's is the placeholder of `to_tag`'s subjects, or no file when `to_tag` has none.
A placeholder edited afterwards is NEMAR's own addition and stays a correction.
So a dataset whose ledger records a privacy correction is no longer refused for that file alone.

### The plan records its planner

The plan body's `planner` is 2 for this planner, so a plan Phase 5's planner made is refused by execution as made under other rules, never read under these (the refusal is a later slice's).

### `to_tag` is ordered by OpenNeuro's creation order (correction to the Phase 5 amendment)

The Phase 5 amendment took OpenNeuro's latest as `ok` when it was numerically after `from_tag`, and `order-unverified` otherwise; the Phase 4a amendment had already ruled that upstream's creation order decides, not the number.
The plan now reads OpenNeuro's latest and its whole snapshot list, each with its creation time, in one answer: the query the staleness report sends, read by the same parser (`shared/openneuro-snapshots.ts`).
It orders them with the helper the report's verdict uses (`upstreamSnapshotOrder`), so the two cannot disagree.
The check is `ok` only when `to_tag` is OpenNeuro's latest and OpenNeuro's own list shows it created after `from_tag`.
Every order the answer cannot establish is `unchecked` (`order-unverified`), never refused and never `ok`, and the plan is not executable: an unreadable creation date, of the latest, of `from_tag` or of any other snapshot in the list (which could be the newest of all), a latest its own list contradicts, a `from_tag` the list does not name, a latest created no later than `from_tag`, no `from_tag` to order against, and no answer at all with `--to-tag` named; without `--to-tag`, no answer plans nothing (`latest-unknown`).
The staleness report reads the same helper, so another snapshot with an unreadable date makes a mirror `upstream_dates_unreadable` where it would have read stale or `upstream_older`; a mirror at the stated latest is still `current`.
The numbers are never compared, so a mirror recorded at `00006` whose upstream made `1.0.0` later is re-pullable.
A `--to-tag` that is not OpenNeuro's latest stays `unchecked`, as the Phase 5 amendment ruled, even when the list shows it newer.
The latest tag is the same `latestSnapshot.tag` an import pins to, and the query is still a GraphQL POST that only asks, outside the plan's HTTP guard.

### The import's refusal points at the re-pull

Decision 10's `[openneuro-upstream-moved]` refusal of a released mirror now names the re-pull, `nemar admin repull plan <id>`, to OpenNeuro's latest snapshot by default or with `--to-tag` to the tag the import was at, which need not be the newer one, before the repair at the recorded tag, which is still the last thing it says.

### The finalize gate is three functions

The verify, tree gate and register steps of an import's finalize are `verifyManifestObjects`, `treeGate` and `registerTreeKeys` (`src/lib/import-finalize-gate.ts`), with every message as it was, because the Worker classifies them; the re-pull's register step will call the same three.
*Annotated 2026-10-24: corrected by the Phase 6d amendment: the re-pull calls `verifyManifestObjects` and `treeGate`, and registers by a commit of its own instead of `registerTreeKeys`.*

## Amendment 2026-10-24 (#1912): Phase 6c prepares a re-pull, through `prepared`

A further slice of the Phase 6 amendment above, built by Phase 6c.
It builds the first half of decision 2's execution: the reviewed plan is proved and made again from live sources, the record is created, and the delta is materialized, scrubbed and synthesized into the one commit, which waits at `prepared`.
Nothing here copies from upstream, pushes or opens a pull request; those follow `prepared` and are a later slice's.
The decision text above is unchanged; two sentences of the first Phase 6 slice are annotated where this slice extends them.

### Execution runs on the administrator's machine

Execution is a library entry the `execute` command will call, run by an administrator with their own GitHub token and the ambient AWS credentials, against the API it is configured for.
The Worker records each step through the record's routes; this slice adds no route, so nothing in it can send mail.
The working directory is `$NEMAR_CONFIG_DIR/repull/<id>/work/<digest8>/`, mode 0700 like every directory above it up to `repull/`, because the clone holds every path of the dataset and a path can be an identifier.
It is kept until the pull request is open, which a later slice does.
Only a `prepared` record resumes from it: from its working clone or from the checkpoint beside it.
A `planned` record is prepared again from scratch, which clones, scrubs and uploads again, to the same result.
One execution of a plan runs at a time: a lock beside the working directory, holding the process id, refuses a second (`execution-locked`) rather than let it delete a live run's clones.
The lock is made atomically, its pid written in a private sibling directory that is then renamed onto the lock's path, so no lock is ever seen without its pid; a lock whose pid cannot be read is taken for a live one.
A lock whose process is gone is moved aside and taken over only when what was moved is still that crashed run's; the refusal names the lock's path and says to remove it when no execution is running (a crashed run whose process id is now another process's).

Every git and git-annex call of an execution, the planner's included, runs with neither the administrator's global configuration nor the system's, and the working clone is made with its own: locked annexed files, no line-ending conversion, no hooks, no attributes or excludes file but the tree's own, and no background gc or maintenance.
Without that, a setting on the administrator's machine (`annex.addunlocked`, `core.autocrlf`, a global attributes file) changes what is prepared, and a later run on another machine could not reproduce it.

### The reviewed plan, proved, and its preflight recomputed

The plan file is trusted for its body only.
It is refused, in this order: when it is not a plan this build reads (`plan-schema`); when another planner made it (`planner-version`), so it is never read under rules it was not made with; and when its body does not hash to the digest it states (`plan-tampered`).
Then, before anything is cloned: a plan made against another API (`plan-environment`), and a plan made from test bases when execution reads the real remotes, or the reverse (`plan-sources`).
Then the dataset must have a row (`dataset-missing` otherwise), and the row must say the dataset is not an anonymous deposit, by an `anonymous` of exactly 0: one is refused (`anonymous-dataset`), as the Worker refuses it at the record, and a row that does not say is refused as unknown (`anonymity-unknown`), since unknown is never clean.
The planner then runs again with the plan's own options, and its live preflight and `executable` decide: the file's two fields are not read at all, so a file that says not executable proceeds when the live plan is, and one that says executable is refused when a release pull request has since opened (`not-executable`).

### The `.nemar/**` rule, read narrowly (clarification)

Decision 2 lets execution go on when the commits since the plan "touch only `.nemar/**`".
As built, the live plan may differ from the reviewed one only in `main`'s commit and tree, with the git-annex branch where it was, and every path that differs between the two `main` commits must be under `.nemar/` and must not be the privacy ledger (`.nemar/corrections.jsonl`); execution then bases on the live `main`.
A ledger line is excluded because a recorded correction changes what the plan refuses: a line appended changes the plan's own ledger facts, and a line edited in place does not, so the path rule is what refuses the second.
A moved `main` with no path that differs is `plan-stale` too, and so is a moved git-annex branch whatever `main` did, and so is anything else: plan again and review the new digest.
The working clone checks the git-annex branch again when it fetches it, so one that moved after the plan was made again is refused there (`plan-stale`).

### A dead recording the plan would name refuses the plan

The Phase 5 amendment lists a dead key N.0.0 would name at a recording path as `dead_recordings`, a recording "the scrub will re-key".
The plan pins only the keys it copies, so nothing names the upstream version to read such a recording from.
The plan now says so itself, as a refusal (`dead-recording-unpinned`), so a reviewer sees it and execution refuses it as not executable.
Pinning those keys is the planner's to add.

### The preparation

The working clone is a fresh, non-partial clone of NEMAR's `main` at depth 2, checked out at the base, with git-annex initialized without enabling any special remote (`--no-autoenable`).
Each delta target is written from where the plan says it comes from and staged by its exact id, never through `git add`, so no attribute, filter or line-ending rule can change what is staged: a CRLF blob upstream committed stays the blob N.0.0 holds.
Upstream's blobs come from the planner's clone of upstream, fetched by id when missing; computed bytes come from the planner itself, which records the bytes of every computed target as it plans (outside the plan's body, so the digest does not move), and execution never rebuilds a standard edit; root metadata upstream annexed is read at its pinned version and must hash to its key (`unannex-content-mismatch`).
The NEMAR-owned edit rewrites `.nemar/metadata.json`'s `IsIdenticalTo`, reading the file as the planner reads it (a byte-order mark set aside and kept); an edit the plan lists with another status is left as it is, said to the operator and counted on the record.

The materialized index is committed locally on the work branch before the scrub, so the scrub works on committed paths as it does in an import; first, every path that differs from the base must be in the scrub's scope (`scope-incomplete`), the check the scrub makes of its own scope, made here because the scrub would see no change once the index is committed.
That commit is never pushed and is never an ancestor of the synthesized one, but it holds the delta's original, unscrubbed blobs: they stay in the private working clone (mode 0700), are not in the checkpoint and are not pushed, and go when the working directory is removed, when the pull request is open.

The scope is every path written or deleted, the NEMAR-owned edit included, and the provenance files, which the scrub annotates when a header changes: a header change needs its provenance file in the scope, or the scrub refuses (`provenance-out-of-scope`), so the caller always puts both in it.
The scrub reads each annexed recording at the version the plan pinned, sets dates (it is not a re-import), writes `repull-scrubbed` at the record's creation time under the fixed actor `nemar-repull`, and refuses with its own word for anything it cannot do.
Its refusal keeps the scrub's message as it is, and when upstream no longer serves a pinned object that message begins with the OpenNeuro-upstream marker (`[openneuro-upstream-inaccessible]`): the marker text is the contract that the failure may pass on a later run, as for an import, and no other field says so.
Dates are set on the delta's recordings and scans tables only, and a scans table in the scope has every dated row of the file set to 1 January, as the import does: N.0.0 is new, so this is the privacy-safe direction, and the versions already published are not touched.

To retire a key it re-keys, the scrub needs a location log for it, and NEMAR's git-annex branch has never recorded a key upstream added after the import; so before the scrub, the working clone records, for each recording the plan copies and NEMAR's branch does not know, the holders upstream's own git-annex branch records, and nothing else.
The scrub then retracts them and marks the key dead, which is what lets the next plan explain the scrubbed recording.
For a recording the scrub did not re-key, those records stay: upstream's own remote uuids, recorded present, in the working clone's local git-annex branch.
The slice that pushes that branch must decide, before it pushes, how such foreign holders are handled.
*Annotated 2026-10-24: decided by the Phase 6d amendment: that branch is never pushed, and the registration names no such holder.*
Git-held data NEMAR's policy annexes, and that the scrub did not take, is annexed and uploaded from this host with the same upload, to `<id>/objects/` only.

### The synthesized commit

The commit is the prepared index written as a tree and committed with `git commit-tree` onto the base: one parent, the fixed identity `NEMAR re-pull <noreply@nemar.org>`, author and committer dates the record's `created_at`, a body of counts with no path, and decision 2's two trailers as the message's last paragraph.
Before it is accepted, the tree must be the plan's targets, modes included, with the scrub's changes and nothing else: a recording the scrub re-keyed, a git-held data file annexed (each under a key this host uploaded, each a symlink), a JSON blanked, a scans table dated or a provenance file annotated in place (each with its mode kept).
Under `.nemar/**` and `.github/**` every path must be NEMAR's side as it was, except `.nemar/metadata.json`, which must be what the NEMAR-owned edit wrote, and the privacy ledger, which must be the base's text followed by exactly the scrub's one `repull-scrubbed` line when the scrub's counts show a change, and NEMAR's side as it was otherwise; an edited earlier line, a removal or a second line refuses.
No key the scrub replaced may be named, and every named key must be one the plan counted held, one it copies, or one this host uploaded.
The copy manifest is the tree's named keys the plan copies, at their pinned versions, and the keys this host uploaded; it must be a subset of the plan's copy keys, every upload must be a local one the tree names, and its digest is recorded.
After the commit, the original of every git blob the scrub changed must not be reachable from it, within what the clone holds (the commit, the base and the base's parent, the clone being two commits deep); one that NEMAR's own history already reaches there refuses the commit.
Every one of these refusals is `synthesis-mismatch` and names counts only.

### Deterministic re-preparation, the checkpoint and the record

Preparing twice from the same plan and base gives the same tree and the same commit, the scrub's downloads, re-keyed uploads and ledger line included, because every date in it is the record's and every identity is fixed.
After the commit, the work branch and the local git-annex branch are saved as a git bundle, mode 0600, at `$NEMAR_CONFIG_DIR/repull/<id>/<digest8>.bundle`, whose prerequisites are the base and origin's git-annex branch as fetched.
A run that finds its record `prepared` leaves it as it is when the working clone is at the recorded commit; restores the clone from the checkpoint when it is not, and only when the bundle delivers the recorded commit itself; and otherwise prepares again, which must reproduce the recorded tree, commit and copy manifest digest (`prepare-not-reproducible`, the record left `prepared` with why; abandoning it is the way out).
Each time it says why the clone or the checkpoint was not used, in fixed words.
A record found `prepared` whose base moved by `.nemar/**` only is prepared again onto the live `main`, and the self-edge records the new facts.
A step that fails records why on the record (`planned` to `planned`, or `prepared` to `prepared` with the facts it already holds) and refuses; what it records names counts, never a path, and when the record cannot be written the operator is told.
Every error the preparation records begins `[prepare:<code>]`.
When a `prepared` record is shown to hold its facts again and its stored error begins so, the `prepared` self-edge records them with no error, and the Worker clears that error: the self-edge records the whole stage again, so the step it repeats succeeded (the Worker's rule for it, `CLEARING_SELF_EDGES` in `shared/repull-state.ts`).
An error any other step recorded (one written after `prepared`, by the slices that follow) is left as it is.
The record's `delta_paths` count is the plan's at `planned` (the paths it writes, deletions aside) and, at `prepared`, the paths the preparation wrote, deleted and edited; beside it the record keeps what the scrub could not read or prove (JSON files unread or annexed, scans tables unread, dates unproven or left), so unknown is never recorded as nothing.

### Checked only against stand-ins

That an anonymous ranged GET of `openneuro.org` at `?versionId=` answers as the stand-in does was measured once, for one object of `ds004362`, while Phase 6 was planned.
That `aws s3 sync` and `list-objects-v2` answer the uploads as the stand-in does, and that GitHub lists open pull requests as the release-pr check reads them, only the canary and the first production runs can show.

## Amendment 2026-10-24 (#1913): Phase 7 builds the automatic path

Phase 7 builds the scheduled path of decision 6 and the Worker's merge of decision 7, in the slices below, one per pull request.
Nothing in this phase turns a switch on: the owner does, in a reviewed change, once the first two re-pulls have been run by hand.

### 7a: the switches and the caps are declared, and off

The automatic path has four variables, two switches and two caps, and the Worker's configuration file sets none of them, so it is off.

- A switch is on only as the exact string `"1"`, as `PR_REVIEW_ENABLED` is; `"true"`, `" 1"`, an empty string and an unset binding are all off.
- A switch is honored only when `ENVIRONMENT` is exactly `production`: no trim, no case fold, and an unset binding is not production.
  The dev cron's allowlist already keeps the daily jobs out of dev, but `isNonProductionEnv` reads an unknown `ENVIRONMENT` as production, so every automatic job also tests the exact string itself, and decision 6's re-pull fence (an `on` dataset only in production) now reads through the same test.
- `AUTO_REPULL_MERGE_ENABLED` acts only while `AUTO_REPULL_ENABLED` is also on, so switching the open switch off stops the whole automatic path whatever the merge switch says.
- `REPULL_DAILY_OPEN_CAP` defaults to 2 and `REPULL_DAILY_MERGE_CAP` to 5 when absent.
  A cap that is set to anything but one or two digits no larger than 20 (a sign, a decimal, a space, an empty string, 21) reads 0 and is reported as unreadable, so a typo stops the work instead of falling back to a number the owner never chose.
  Both caps read through one function, so the merge cap of Phase 6e and the open cap cannot drift apart; the merge cap's behavior is unchanged.
- The four variables are absent from `[vars]` and from `[env.dev.vars]`, a test pins that for every table of the file, and a value set only in the dashboard is dropped by the next deploy, so the owner sets them in the file.
  The first Worker merges run with `REPULL_DAILY_MERGE_CAP` set to `"1"`.
- `GET /admin/repulls/switches` reports what the Worker reads (production or not, both switches, and the open cap and the merge cap, each with how it was read) and no binding value.
  It is read-only, admin-only and sends no mail.
- The App's bot user is named once, beside the App's id: `nemar-publish-bot[bot]`, user id 283755542, type `Bot`, as `GET /users/nemar-publish-bot%5Bbot%5D` answered on 2026-10-24.
  A pull request is the App's only when both the login and the id match.

### 7a: what was measured about the rulesets, and what is still the owner's (updates "Not yet verified")

Read-only, 2026-10-24.

- The App (id 3679074) requests `contents`, `pull_requests`, `checks`, `administration`, `actions`, `workflows` and `issues` write, and subscribes to `pull_request` and `push` events only, so it learns no check result by event; the Worker reads checks on a tick.
- It has never opened a pull request in `nemarDatasets`, so an App merge has not been exercised.
- Most mirrors have no branch protection at all.
  `on003645` and `on004362` have no classic protection and no ruleset on `main`.
  Of 21 more repositories sampled, 16 have nothing; 5 carry the repository ruleset "NEMAR branch protection" (a pull request rule with no required approvals, the required checks `Run BIDS Validation`, pinned to the App, and `version-check`, `non_fast_forward`, `deletion`, and the App and the organization's administrators as bypass actors); `nm000103` has classic protection.
  So on most mirrors GitHub enforces nothing and `clean` proves no check ran, and on a ruleset repository the App may merge anything, so `clean` is the only thing that keeps an App merge from being a bypass.
  The Worker therefore reads the two checks itself, by name and pinned to the App, at the head it merges; that reader is a later slice.
- `mergeable_state` read by an always-bypass administrator: `blocked` where a ruleset's checks were never posted, `clean` on an unprotected repository with both checks green, `unstable` where a non-required check was `action_required`.
  A bypass-capable reader still saw `blocked`; whether the App's own token reads the same cannot be shown read-only, and the first Worker merge under a cap of 1 is the check.
- The ADR 0107 review's intake skips every pull request whose author is a bot, as ADR 0092 says ("not drafts, not bots"), so as the code stands no review row can exist for the App's pull request and none can be machine clean.
  This contradicts the sentence under "Not yet verified" that the App is not exempt from the review; the correction is built with the machine-clean rule, and it narrows ADR 0092 for exactly the App's re-pull pull request.

The split of the ruleset check, which the merge call waits for:

- Read by an administrator with the `neuromechanist` login on 2026-10-24: the `nemarDatasets` installation of App 3679074 has `contents: write`, `pull_requests: write`, `actions: write`, `administration: write`, `checks: write`, `workflows: write` and `issues: write`, with `repository_selection: all`.
  The App can therefore open a pull request, and the permission half of the check passes.
- Not read: the organization's rulesets.
  Listing them needs the `admin:org` scope, which that token does not hold, so whether an organization ruleset targets default branches, and whether the App is a bypass actor of it, is unknown.
  That half stays an owner step before the Worker's merge is built: `gh auth refresh -h github.com -s admin:org`, then `gh api orgs/nemarDatasets/rulesets --jq '.[] | {id, name, target, enforcement}'`.
  It passes when no organization ruleset targets default branches, or each one that does has the App as a bypass actor and asks for nothing the Worker does not read.
  If it fails, the Worker's merge is not built, `AUTO_REPULL_MERGE_ENABLED` has no effect, and an administrator merges each automatic pull request under the cap and the screen.
  *Annotated 2026-10-26: the owner ran it on 2026-10-26 and it passed (the Phase 7g amendment), so the Worker's merge is built.*

### 7b, 2026-10-25: the dispatch record, and an automatic record only through it

Phase 7b builds the record the automatic path keeps of what the Worker asked a run to do, the run's report back, and the one way a re-pull is recorded with `origin` automatic.
Nothing here sends a dispatch, schedules anything or merges: the Worker that sends dispatches, the scheduler, the unattended run and the merge are later slices, so this slice is inert until they land, and nothing in it sends mail (the source scan covers its service and its callback).

The record.

- Migration 0109 adds `upstream_repull_dispatches`, one row per dispatch, keyed by nothing but its id: a dispatch exists before any re-pull row does, a run that refuses before its create leaves none, and one re-pull may have many (a first dispatch, its resumes, its finish).
  *Annotated 2026-10-25: the migration is numbered 0111, not 0109; origin/dev took 0109 and 0110 for the ticket work after this slice was written.*
  *Annotated 2026-10-26: renumbered 0112; origin/dev took 0111.*
  A dispatch is `open` (run a plan to an open pull request, or resume a row that stalled before it) or `finish` (walk a merged re-pull to `complete`).
- Its states are `dispatched` and `started` while it is live, then the run's own last word (`opened`, `finished`, `refused`, `failed`) or the Worker's: `dispatch_failed` when GitHub refused the dispatch, so it never ran, and `unreported` when the run said nothing in time.
- A one-shot nonce is held exactly while the dispatch is live, and the edge that ends it clears it, so a token replayed after its run ended has nothing to verify against.
  One live dispatch per dataset, which also keeps two runs from working on one dataset at once.
- Only an `on` dataset has dispatches; the table refuses any other id, so an `xx` re-pull, which takes the administrator's path only (decision 7), cannot reach the automatic one even by a writer that skips the service.
- The same migration adds the scheduler's one row and, on `upstream_repulls`, `hold_reason` and `hold_since`, which a later slice writes: a fixed word and since when, set together, on an automatic row only.
  *Annotated 2026-10-25: the Phase 7f amendment's advance tick writes them, and the record's own transition clears them on every edge into another status.*
  The record, as Phase 6 said, is deleted with its dataset, and so are its dispatches, those with no re-pull row included.

Production only.

- Claiming a dispatch needs `ENVIRONMENT` exactly `production` and the open switch on; claiming the finish of a re-pull that already merged needs exact production only, because turning the switches off must not strand a minted DOI's lineage, lock and `complete`.
  The report callback and the watchdog read no switch either, for the same reason: a run dispatched before the switch went off must still be able to say how it ended, and its live row must not hold the dataset's one live slot for good.
- Outside exact production nothing is claimed, verified, stored or swept, and nothing is read: the `nemarDatasets` organization is shared with dev.

The open cap (decision 6).

- `REPULL_DAILY_OPEN_CAP` counts the day's `open` dispatches, first ones and resumes alike, on D1's own clock in a fixed UTC day, and the count is in the statement that claims the unit, so two claims racing for the last unit cannot both win; a refused claim writes nothing (ADR 0099).
- A dispatch GitHub refused never ran, so it frees its unit; one whose answer was lost keeps it, because it may be running, and so does one the watchdog ended `unreported`.
  A claim whose token could not be signed or whose row could not be read back is ended the same way, `dispatch-failed`, before the error goes on, so a claim that committed but was never sent does not hold a unit and the dataset's live slot for eight hours.
  A `finish` never counts: its merge already minted the DOI the cap exists to bound.
- The cap counts surviving rows: deleting a dataset deletes its dispatches (an administrator-only path), which frees that day's units.
- A cap set to something unreadable is `cap-unreadable`, not `cap`: it reads 0 but is not a full day, and the caller says which.
  An upstream tag that is not a tag, or two that name one snapshot, is the refusal `candidate`, because it comes from outside.
- The cap bounds dispatches, so it bounds the pull requests opened in a day only while every run that opens one starts on the day its unit was claimed; the later slice that schedules dispatches pins the timing that makes the two the same.
- A first dispatch is refused for a dataset with an open re-pull, and a resume names an automatic row of the same dataset and tags that stalled before its pull request opened, both read in the statement that claims.

The token and the callback.

- The dispatch token is a kind of its own, signed with the callback secret every other kind uses and domain-separated the same way: its message begins with a line no other kind's begins with, and binds the dispatch, its dataset and its nonce.
- A run reports to `POST /webhooks/repull-state`: `started` once, then `opened` (for the automatic record its dispatch is linked to, at `pr_open` or later), `finished` (a finish whose record is `complete`), or `refused` or `failed` with a code.
  Each is a compare-and-set on the dispatch's id, its nonce and the status it was read in, and the record's state is read in the statement that writes, so it holds when the report is stored.
  Every refusal of the token is one answer, at the callback (`invalid-token`) and at the automatic create alike (`dispatch-token`, 401, the same body whatever the cause), whether the dispatch does not exist, belongs to another dataset, has ended or the token is wrong, so neither door says which dispatches exist or how they ended; the token is checked before anything else is said about the dispatch, and no answer names a status.
  The one answer at the create door that is not a token answer is a Worker with no callback secret, which is configuration and answers 503 `dispatch-unconfigured` at both doors.
  A token that leaks (the later slice that sends a dispatch masks it in the step output, and this record asks that of it) lets anyone end a live dispatch as `failed` for up to eight hours; it is denial only, since a report stores fixed words and the record it opens or finishes is checked in the statement that writes.
- A code is a word from a closed list, never a message, a path or a key, because the weekly report will count codes on a public-facing repository.
  The callback refuses any other word, a run reports `no-code` for a refusal whose word the list does not hold, and a source scan requires every literal refusal word of the plan, the execution, the scrub and the Worker's re-pull routes to be on it.
  *Annotated 2026-10-26: the list is cut to 57 words: the Worker's own and its answers to a report, the run's own, the final codes and nine step classes (`plan-refused`, `record-refused`, `prepare-failed`, `scrub-failed`, `copy-failed`, `register-failed`, `pr-failed`, `settle-failed`, `finish-failed`).
  A run reports a refusal whose word the list does not hold as the class of the step that met it, `no-code` only when it met none.
  When the preparation, the copy, the registration or the pull request fails on its own, that step also writes the exact word to the record's `last_error`; every other refusal, before the record exists or after it, keeps only its listed word, as the owner accepted.
  The scan now requires every literal refusal word to reach a report as a listed word.*
- The watchdog ends a live dispatch eight hours after it was sent (the job's bound of 330 minutes, plus queueing) as `unreported`, and writes one audit row when it marked any; the production daily cron calls it, and that wiring lands in this slice rather than in 7c, because the cron declaration rule needs a call site for every sweep export; 7c keeps the scheduling of dispatches.

`origin` automatic only through a Worker-signed dispatch.

- `POST /admin/repulls` takes an optional `dispatch_id` and `dispatch_token`, both or neither, and `origin` is in no request: a create with a live dispatch whose token the Worker signed is automatic, and every other is the administrator's.
- Before the record's fences, in order: exact production, the open switch (so switching it off stops a run before its first write), and an `on` dataset; then the dispatch: its token verifies over a live dispatch (one answer for every failure of it, above), it is an `open` dispatch, and it names this dataset, this `ds` and both tags.
- Then the plan (decision 6, "the automatic path takes only a plan with zero unexplained paths"): it was made by the planner the CLI runs today (planner 2, which a test pins to the CLI's), and it states `unexplained`, `conflicts` and `corrections`, each zero, because a count left out is not zero; and it states the size of its copy, at most 1 TiB, so one run fits a runner's job.
  The administrator's path has no such bound.
  The Worker can check only what the plan states; the run checks the live plan itself before it writes, which is a later slice's.
- The insert links the dispatch to its record in the same batch, by the record's key and never by `last_insert_rowid()`, which the audit row moves, and only while the dispatch is still live under the nonce that verified: a dispatch that ended between the check and the write links nothing, the batch rolls back on the link's guard, and the create writes nothing and answers as any other failure of the token; when two creates of one valid dispatch race, the loser therefore gets that same 401 rather than `created: false`, which is kept because a retry converges on the winner's record.

The same plan is the same record, for a caller of the same origin (clarification of the Phase 6 amendment).

- The Phase 6 amendment returns an open record with the same tag and plan digest as it is.
  That is now so only for a caller of the record's own origin: an administrator's create never takes over a record a dispatched run is working on, and a run never takes over an administrator's; each is `repull-in-flight`, which names the record.
  Two executions of one record from two machines would each push its branch and open its pull request.
- A dispatch that names its record (a resume, or one whose own create already recorded it) takes only that record, and once that record has ended it creates none (`dispatch-mismatch`), so a resume never starts a second re-pull.
- An administrator who wants to take over a stalled automatic record abandons it and plans again; the record's history stays.
  *Annotated 2026-10-25: built by the Phase 6g amendment: abandon ends an automatic record as it ends an administrator's, and a supersede refuses one.*

What later slices use from here.

- The hold words, the content refusals that end the automatic path for a tag, and the prefix of every error the automatic path records on a re-pull row, `[auto:`, which is not the preparation's `[prepare:`, so a `prepared` self-edge never clears one (the Phase 6c amendment's rule).
- An administrator can now reset a stored review pass on the same head (`nemar admin pr-reviews start --redo`), so the slices that read the review for machine clean read it at each stage, the gates and the merge, and never carry one stage's reading to the next.
  *Annotated 2026-10-29: for this class the review is waived at the recorded head ([ADR 0117](0117-an-upstream-re-pulls-own-pull-request-is-waived-from-the-review-by-nemars-record.md)): machine clean reads `waived`, and no stored pass, or its reset, changes it.*

Every statement here was run on bun:sqlite and on Miniflare's D1.
Not checked here, and left to the later slices' canary and the first production run: that a run reaches the callback at the API host, and that the token survives the dispatch payload and the run's environment unchanged.

### 7c, 2026-10-25: the scheduled path, in production only and off

Phase 7c builds the scheduled half of decision 6: a daily tick, in production only, that finds the mirrors upstream has moved past and dispatches the central workflow that is to open their re-pull pull requests.
The workflow, the unattended run and the merge are later slices, and the workflow is not deployed, so nothing here can open a pull request yet; with the open switch off, as it is, the tick dispatches nothing at all.
*Annotated 2026-10-27: the unattended run (Phase 7d) and the merge (Phase 7g) are built, and the workflow's copy in `nemarDatasets/.github` merged as `nemarDatasets/.github#148`, so "not deployed" no longer holds; the tick still dispatches nothing while the open switch is off (the Phase 8 amendment, "The workflow pairs").*
Nothing here sends mail, and the source scan that pins the record's import closure covers the scheduler.

Candidates come from `stale_ready` alone.

- A candidate is a mirror the staleness report (the Phase 4a amendment) calls `stale_ready`, read through the same service its route and the weekly section read, so the three cannot disagree.
  The pull goes from the recorded tag to the latest tag the report read.
- No other state is a candidate.
  `mirror_lag` and `stale_unverified` are stale but cannot be planned yet, `unknown` and `not_examined` have no tag to pull from, and an anomaly is not a verdict.
- A never-published mirror is `unpublished`, never `stale_ready`, because it has no version row.
  The import retry already prepares it again at the latest tag in place (decision 10, the retarget ruling), so the automatic re-pull never takes it, and a completed import with no version row is left to an administrator.
- Withdrawn mirrors, imports in flight and mirrors with an open re-pull never reach `stale_ready`, and each fact is read again per candidate, below.

What is not dispatched.

- Each `stale_ready` mirror is checked again in one statement before any claim, and skipped with a fixed word:
  `missing` when its row is gone, and `anonymous` unless it says `anonymous` is exactly 0, because a re-pull would undo the blind (ADR 0065) and unknown is never clean;
  `unreconciled` when a record of it holds a merge nothing reconciled, by the create's own rule, which the statement imports and never retypes;
  `open-row` for an open re-pull, and `live` for a live dispatch;
  `final-refusal` when a run already refused this tag for content (the content refusals the 7b slice names): the automatic path is over for that tag, and an administrator may still re-pull it by hand;
  `unreported-streak` when its last three dispatches all ended `unreported`;
  and `recent` when a re-pull of it was created, or a first dispatch for it sent, in the last 30 days.
- The streak exists because a workflow that answers the dispatch and never runs leaves each one `unreported`, and the mirror would then be sent again on every rotation.
  Only a later dispatch that reports would break it, and the scheduler sends that mirror none, so nothing clears it: the mirror stays on the administrator's path.
  An administrator keeps it current by re-pulling it by hand (`nemar admin repull plan`, then `execute`), and a later staleness of it is the administrator's again.
  While the tick skips a mirror for the streak, its log line is raised to warn, so the skip is seen.
- Then the create's dataset fences (a mirror of that `ds`, not withdrawn, no import in flight) are read again through the record's own function, and a refusal is skipped under its code.
  The automatic create checks everything once more when the run arrives.

The 30-day reading.

- At most one first dispatch, or one re-pull of any origin, per dataset in 30 days.
- Every first dispatch counts except one GitHub refused (`dispatch_failed`), which never ran, and one whose run created a record counts through that record.
- A resume of an existing record is not a first dispatch: a later slice bounds it by its own count, not by the window.
  *Annotated 2026-10-25: the Phase 7f amendment's advance tick does: at most three `open` dispatches a record, the one that created it included.*
- An administrator's re-pull counts too, which errs toward fewer DOIs.

The open cap, claimed at dispatch.

- Every dispatch goes through the dispatch record's claim (the 7b slice), whose statement counts the day's `open` dispatches and claims the unit at once, so the scheduler cannot pass `REPULL_DAILY_OPEN_CAP`, and two ticks at once cannot either.
  The day's count is also read once before the scan, only so that a full day costs no OpenNeuro request (`cap-reached`); the claim alone decides a unit.
- The 7b slice says a dispatch GitHub refused frees its unit; this slice defines refused as a 4xx, which GitHub answers before it creates an event, so the dispatch ends `dispatch_failed` and its unit is freed.
  A 5xx, a lost connection and the 10-second timeout are a lost answer, because GitHub's edge can answer a 502, 503 or 504 after it queued the event (the reasoning the approval dispatch records): the dispatch stays `dispatched`, keeps its unit, and the watchdog ends it `unreported` if its run never reports.
- A refusal the next mirror would meet too stops the tick before that mirror, and the tick records `send-refused`: a 401, 403 or 404 (the credential cannot reach the central repository), a 429 (GitHub's rate limit), and a second refusal of any status in one tick.
  The next tick starts with that mirror, and the refused dispatch has freed its unit.
  One refusal of another status frees its unit, and the scan goes on to the next candidate.
- The claim reads the switch, the secret and the cap again when it claims, so one that changed while a tick ran ends the tick with the claim's own word (`switch-off`, `unconfigured`, `cap-unreadable`, or `cap-reached` when the day filled), before that mirror.
- The tick runs on the production daily cron at 03:00 UTC.
  The timing that makes a day's dispatches that day's pull requests is pinned by the slice that writes the workflow, as the 7b slice says.
  *Annotated 2026-10-25: pinned by the Phase 7d amendment's test, for the daily tick and for the stalled-run slice's resume window.*

Production only, and gate G4 in code.

- Outside `ENVIRONMENT` exactly `production` the tick returns before it reads, writes or sends anything, whatever the switches say.
  It is called only from the production-only daily block, `DEV_CRON_ALLOWLIST` is unchanged, and the wiring test now pins every production-only daily job out of the allowlist.
- In production, with `AUTO_REPULL_ENABLED` not exactly `"1"`, the tick only stamps its row (`switch-off`) and asks OpenNeuro nothing.
- The design record's gate G4 is that the first two re-pulls, of `on004362` and of `on003645` (either first, as upstream's snapshots allow), are run by hand, that the new major's DOI then resolves with `IsDerivedFrom`, and that the previous version still serves.
  *Annotated 2026-10-27: which relation the DOI carries is not verified until G4 runs; see the Phase 8 amendment, "The relation on a re-pull's Digital Object Identifier (DOI)".*
  The scheduler dispatches nothing (`waiting-for-manual-run`) until this database records both of those re-pulls as run by an administrator to `complete` with their tags.
  One of them alone, two runs of the same one, an automatic or an unfinished run, and any other mirror's re-pull do not count.
  The DOI and the previous version are read by the owner before turning the switch on, which is the act that opens the path.
- The dispatch names the CLI version the run installs, the dispatching Worker's own, and only a release version is sent, so a Worker built from a development version dispatches nothing (`cli-unreleased`).
- An accepted, narrow limit: the Worker deployed from the release bump on `main` carries the release version before npm has published it from the release tag, so a tick between that deploy and that publish can dispatch a run that cannot install its CLI.
  Such a run fails at its install and reports `failed`, or says nothing and is ended `unreported`; its unit stays used for the day, and its mirror waits out the 30-day window.
  The window is the minutes between the deploy and the publish, and the tick runs once a day.
- A Worker without the callback secret, which signs the dispatch token, dispatches nothing (`unconfigured`).
- Every tick in production stamps the scheduler's row with its time and its outcome, one of a closed list of words (`shared/repull-state.ts`), which the observability slice reads.

The rotation, and what may hold it.

- A tick reads at most three pages of the report (300 mirrors) from where the last one stopped, and once one reaches the end of the fleet the next starts again at the first mirror, so the fleet is covered in rotation.
- The GitHub probes that turn a stale row into `stale_ready` are bounded to ten for the whole tick.
  A stale row the budget did not reach reads `stale_unverified`, so the cursor stops before the first such row and the next tick probes it.
  Passing it by until the next rotation would starve every stale mirror that sits behind ten ineligible ones, whose probes would be spent first on every pass.
- The tick is `blind`, dispatches nothing from what it could not see and leaves the cursor where it was, in three cases: OpenNeuro failed a batch of the page; the probes had no GitHub credential (`probe-credential-missing`); or every probe the tick made came back unverified (`probes-unverified`: an expired token, GitHub's raw host down, or a credential that cannot read OpenNeuro's repositories).
- A page whose rows are all `unchecked` with no batch failure is a per-dataset problem: those mirrors are passed by and counted, and met again on the next rotation, so one mirror OpenNeuro will not answer for cannot hold the cursor.
- Two holds are bounded: a candidate whose own reads throw holds the tick before it, and a tick whose every probe failed holds where it started, but each holds at most two ticks at one place in 30 days, counted from the audit rows it writes; the third passes on (the candidate counted as `candidate-error`).
  A stale mirror whose OpenNeuro repository is gone probes unverified on every pass, and one that always throws would fail every tick, so an unbounded hold would stop the rotation for good.
  A batch failure holds without a bound: OpenNeuro down means nothing can be seen.
- Each tick logs one line of counts and fixed words, at error level when it could not see, a send was refused or unanswered, a mirror could not be compared or probed, or a candidate threw; a failure is named by a fixed word and its error's class, never its message.

What the dispatch carries.

- A `repository_dispatch` of the event `run-upstream-repull` on `nemarDatasets/.github`, whose payload holds the mode, the dataset, its `ds`, both tags, the dispatch's id and token, the CLI version and, for a resume or a finish, the re-pull's id: strings only, nine keys at most, under GitHub's limit of ten.
- Every field is checked before it is sent, and a malformed one stops the send and ends the claim; no error message names a value.
- It carries no callback URL: the run reports to the production API, whose address the workflow states.
- The token is the one secret in it, and the workflow's first step masks it before any step can print it (a later slice, as the 7b slice asks).
  A send that got no answer is logged by its error's class only.

What a tick costs.

- Counted from the code: 3 D1 statements before the first page (the proof, the day's count, the cursor) and 1 after it (the stamp); per page 3 statements and at most 2 GraphQL requests; at most 10 tag probes and 10 control reads; one token for an App credential; and per `stale_ready` mirror 2 statements to skip it, or 4 and the send to dispatch it, one more when GitHub refuses.
- A tick of three pages, ten probes and ten dispatches measures 79 calls, which a test pins; by the count, no tick exceeds about 85 of the daily tick's shared allowance.

Discovery untouched.

- Decision 6's id-only discovery is unchanged, and a source scan pins the separation both ways: the auto-import and discovery load no re-pull or staleness module, and the staleness report and the scheduler load neither.
- OpenNeuro's endpoint, which both read, moved to a module that imports nothing, because the report's snapshot reader used to import it from discovery.

Checked only against stand-ins.

- OpenNeuro, its GitHub mirror and GitHub's dispatch endpoint are loopback stand-ins in the suites, and the scheduler's statements, one whole tick included, run on bun:sqlite and on Miniflare's D1.
- Only production can show: that GitHub answers the dispatch with 204 and nothing runs until the workflow is deployed; that the installation token reads `OpenNeuroDatasets` raw files (an item under "Not yet verified": if it does not, every probe is unverified and the tick is `blind` until its bounded hold passes on); and that a 5xx can follow a queued event, which is assumed here in the safe direction.

## Amendment 2026-10-24 (#1912): Phase 6d copies, registers and opens the pull request

A further slice of the Phase 6 amendment above, built by Phase 6d.
It builds the second half of decision 2's execution and decision 8's copy: from `prepared` the record goes to `copied`, `registered` and `pr_open`, where `nemar admin repull execute` stops.
It never merges: a merge mints a version DOI that cannot be withdrawn, and is the administrator's own act through the merge path a later slice builds.
*Annotated 2026-10-25: that path is built by Phase 6f, `nemar admin repull merge <id>` and `nemar admin pr-reviews` through one gate (see the Phase 6f amendment).*
Nothing here adds a route, so nothing here can send mail; five annotations are added to earlier text (two on the record's header, three on sentences of earlier slices) where this one builds, decides or corrects them.

### The command, and a record past `prepared`

`nemar admin repull execute <plan-file>` runs on the administrator's machine with their own GitHub token and the ambient short-lived AWS credentials.
It asks before it writes anything, and the question says how many objects it copies, that it pushes the release branch and opens its pull request, how many version DOIs the merges will mint, and that execute never merges; `--yes` answers it.
`--until` stops after `planned`, `prepared`, `copied`, `registered` or `pr_open` (the default), and a later run takes the record up where it stopped.
Exit 0 means the requested status was reached, 3 that a step stopped and left the record as it was with why on it, and 1 that nothing was written or the run failed.

A record for the same digest past `prepared` is taken up without planning again.
A live plan cannot be compared with the reviewed one any more: the registration moved NEMAR's git-annex branch, which the plan reads, and the release branch and its pull request exist, which the release-pr check refuses.
Such a run proves the file instead (its digest, its planner, the API and the remotes it was made against), and takes the working clone, or the checkpoint when the clone is gone, as preparation left it; with neither it refuses (`checkpoint-lost`), and abandoning the record is the way out, for which no command is built yet.
*Annotated 2026-10-25: built by the Phase 6g amendment: `nemar admin repull abandon <id>`.*
Every run, whatever the record's status, first refuses a dataset whose catalog row does not say `anonymous` is exactly 0, before anything is written, as the Worker refuses one at the record.
Before each step past `prepared`, upstream's tag must still be the commit the plan read, because the commit's trailers name it (`upstream-tag-moved`): OpenNeuro has re-created a tag before.

### The copy pins the version (decision 8, as built)

The copy manifest is rebuilt from the synthesized commit and the plan, of which it is a function, and must hash to the digest recorded at `prepared` (`manifest-mismatch`).
It is written to `<id>/staging/repull-<to_tag>.json` before the first copy, as decision 8 says, because an abandoned attempt's orphans are read from it.
Each key it copies is skipped when the bucket holds it at the size the key declares, and copied again at any other size (#967).
Otherwise upstream's object is headed at the pinned version: a version upstream no longer serves is `pin-absent`, another size than the key declares is `pin-size-mismatch`, and an answer for another version, or for none, is `pin-version-mismatch` (unknown is never success); a key that declares no size is skipped only when the destination holds the pinned object's size, and otherwise copied, its pinned size being the one checked, never zero.
The copy is one server-side `copy-object` with `?versionId=` on the source, `--copy-source-if-match` on that version's ETag and `--tagging-directive REPLACE` (the default reads the source's tags, which upstream's bucket does not let us read; the copy holds none), or, above S3's 5 GiB single-copy limit, a multipart upload whose parts are each copied from the same version under the same condition, aborted when any part fails.
S3 must name the pinned version as the one it copied from (`CopySourceVersionId`), for the copy and for every part; any other answer, or none, is `pin-version-mismatch`, a single copy that already landed is deleted by its version id (a rerun would otherwise skip it at the declared size), and a multipart upload is aborted.
An abort that fails leaves the upload open, and the refusal names the count and the upload ids.
An endpoint that ignores the version and says so is refused here; one that ignores both the version and the ETag condition and says it copied the pinned version can only be shown up by the canary, which compares the copy's ETag.
The destination is headed after and must be the size copied.
A refusal stops new copies, the step refuses once those in flight have finished, and nothing is registered for a partial copy; a rerun skips what landed.
`prepared -> copied` is written only after a fresh listing shows every key of the manifest, copied or uploaded at preparation, at its declared size (`copy-unverified`).
The copy does not lock what it copies: decision 8's "locked orphan objects" holds only once a later slice locks a released version's objects.
*Annotated 2026-10-25: Phase 6f locks, at the release, only the objects that release's own copy and uploads wrote, so an abandoned attempt's orphans are never locked (see the Phase 6f amendment).*

### The write guard

Every push and every `aws s3api` call after `prepared` passes an allowlist before the process starts (`src/lib/repull/write-guard.ts`).
A push goes to `origin` only, one refspec at a time, from a commit id, and only to `release/v<N.0.0>` (or `release/v<N.0.1>`) or to `git-annex`, never forced; a release branch may also be deleted, or leased onto a re-synthesized commit, which later slices use.
*Annotated 2026-10-25: the lease is used by Phase 6f's re-synthesis onto a moved `main`; the deletion is still the abandon slice's.*
*Annotated 2026-10-25: the deletion is used by the Phase 6g amendment's abandon and supersede, and the lease by N.0.1's re-synthesis too; a deletion now carries a lease on the head that was judged, and one without it is refused (`delete-without-lease`).*
Never `main`, never a tag, never `+`, `--force`, `--mirror` or any option the list does not name.
An S3 call writes only under `<id>/objects/` or to the one staging key, copies only from upstream's bucket under the dataset's own `ds/` and only at a version id, and names no lock, ACL, metadata directive or governance bypass.
The one other write is `delete-object` by version id under `<id>/objects/`, which removes a copy S3 reported as made from another version than the pinned one.
A key or prefix with a `.` or `..` segment, or an empty one, is refused before the prefix test, because the test is lexical; a version id with a character the guard does not allow (older S3 version ids can hold `+` and `/`) is refused with that cause, which fails closed.
A push that origin's own rule refuses (a hook, a protected branch) is told apart from one that lost a race with a moved branch, and is not tried again; a push that fails carries a fixed-word cause (credentials, the network, or unknown).

### The registration publishes no holder NEMAR does not control (decides the Phase 6c amendment's open point)

The Phase 6c amendment left the holders preparation adopted from upstream's location log in the working clone's own git-annex branch, recorded present, for every copied recording the scrub did not re-key, and said the slice that pushes must decide what becomes of them.
The decision: the working clone's git-annex branch is never pushed.
What is pushed is one commit on top of origin's git-annex branch as fetched, written from facts, which changes location logs and nothing else.
For each annexed key the N.0.0 tree names it adds `nemar-s3`'s present line, and for each upstream key the scrub replaced it writes the dead mark: every repository origin's log for that key already names set to `X`, or `nemar-s3` alone when it names none.
So no line it adds names a repository origin's log did not already name, other than `nemar-s3`.
Three things the working clone's branch holds are therefore never published: the adopted upstream holders, which are presence claims for remotes NEMAR does not control; the working clone's own repository, recorded present for the content it annexed and gone when the working directory is removed; and that repository's `uuid.log` entry.
This is stricter than the import, which pushes its clone's whole git-annex branch, upstream's records included; the import is unchanged.

The registration runs only after the import's tree gate passes on a fresh listing: a key the location log claims and the bucket lacks refuses (`held-key-absent`) before anything is pushed (#1396).
It calls the import's `treeGate`, and `verifyManifestObjects` at the copy, but not `registerTreeKeys`, which records presence in the clone's own branch: the correction to the Phase 6b amendment's sentence that the register step would call all three.
A push GitHub rejects because origin's branch moved is written again on top of it, three times at most; the result is proved from origin's branch as fetched again, `nemar-s3` present for every tree key and every replaced key dead (`registration-unproven` otherwise).

### The release branch and its pull request

Before the push, NEMAR's `main` must be the commit the record bases on, or a descendant of it by commits of the three shapes enrichment writes and nothing else: a regular file under `.nemar/` other than the privacy ledger, the `.nemar/` line added to `.bidsignore` as `withBidsignoreEntry` adds it, or a root `participants.tsv` that is the placeholder of that commit's subjects (`main-moved` otherwise).
The ledger is excluded for the reason the Phase 6c amendment gives for `.nemar/**`: a line in it changes what a plan refuses.
A `release/v<N.0.0>` that already exists is reused only when it is the synthesized commit or such a descendant of it, since enrichment commits to every release push (`branch-foreign` otherwise).
The pull request is looked for among the open ones by its head branch before one is opened, so a run whose answer was lost finds it and never opens a second; another open release pull request refuses (`release-pr-open`), as the plan's preflight does, and so do 100 or more open, which one page cannot show complete.
It is opened into `main` with the administrator's token, titled `Release v<N.0.0>`, and its body holds counts, the record's number and the plan digest, never a path or a key.
The body also says what the Phase 6b amendment requires of the merge: the squash commit message must end with both trailers, `Upstream-Snapshot:` and `Repull-Plan:`, as its last paragraph, because GitHub's default squash message puts them mid-message and the privacy ledger's fresh-clone proof then fails the dataset; the merge path enforces it.
*Annotated 2026-10-25: built by the Phase 6f amendment: the merge gate writes that message and refuses one without both trailers.*
`pr_open` records the head GitHub reports, accepted only when it is the synthesized commit or an enrichment-shaped descendant of it.

### The record, and the working directory

`copied` and `registered` repeat, as `planned` does, to record why the step that follows them failed; the error is the whole write, and the edge forward clears it.
A step's error begins with its step, `[copy:`, `[register:` or `[pr:`, and never with `[prepare:`, which only a preparation clears; a `prepared` record that holds a copy's error keeps it until it is copied.
At `pr_open`, and on any later run that finds the record at `pr_open` or past it (one killed before the removal), the working directory is removed unless `--keep-workdir`, because it holds the delta's unscrubbed originals in the local commit preparation made before the scrub.
That commit is never pushed and never in the checkpoint: the suites check that neither origin nor the bundle holds the original blob of a JSON file the scrub blanked, and that the upstream key of a re-keyed recording is neither copied into the bucket nor anything but dead on origin.
The checkpoint is kept for the slices that follow.

### The canary

`nemar admin repull canary --prefix <p> --source <ds>/<path>@<versionId> --multipart-source <ds>/<path>@<versionId>` is the real-bucket check of what the copy believes, for the owner to run before the first production re-pull.
*Annotated 2026-10-26: moved out of the shipped CLI to `bun run scripts/repull-canary.ts`, with the same arguments, fences, dry-run default and `--execute`.*
The prefix must be `nm099999/repull-canary-<word>/` or `xx<090001 to 099899>/repull-canary-<word>/`, never a dataset's `objects/` or `staging/` and never the permanent exemplar fleet (`xx099900` to `xx099999`, ADR 0068), the bucket must be NEMAR's, and the two objects must belong to one dataset; the run itself checks all of it, so no caller can skip it.
A dry run, the default, makes no call and prints the calls.
With `--execute` it heads both sources at their versions, copies the small one with one `copy-object` and the other, over 10 MiB, in 5 MiB parts with `upload-part-copy`, through the same write guard; it requires S3 to name the pinned version as the one it copied, for the copy and for every part, compares the copies' sizes, and the small copy's ETag with its source's when the source is a single-part object.
It then writes a staging-shaped key, deletes it and both copies by version id, and lists the prefix's versions, which must hold neither a version nor a delete marker.
Every object it writes is deleted by version id on every path, including when a check of the copy fails, and an upload left open under the prefix is a failed step.
It never locks and never bypasses a lock, so a bucket whose default retention locks new objects makes the canary fail at its deletes, which is what an owner needs to know before a re-pull's orphans are counted.

### Checked only against stand-ins

The suites drive the real `git`, `git-annex` and `aws` CLI, but S3 and GitHub are stand-ins, and these are what only the canary and the first production runs can check:
that a signed cross-account `copy-object` and `upload-part-copy` of a public versioned object honor `?versionId=` and `--copy-source-if-match` and name the copied version (`x-amz-copy-source-version-id`) as the stand-in does (the first canary run, 2026-10-29, found that the single `copy-object` also needs `--tagging-directive REPLACE`, which the stand-in now requires);
that a multipart copy over 5 GiB in 4 GiB parts, and the CLI's retries and its ten-minute bound per copy call, behave as they do here;
that upstream's bucket answers from `us-east-1`, which the copy assumes;
whether NEMAR's bucket locks a copy by default retention;
and how GitHub opens and lists a pull request (the head's repository, the answer to a second one on the same branch).
git-annex reading the registration's location-log lines is checked locally: a fresh clone's `git annex whereis` finds the copied recording at `nemar-s3` alone (git-annex 10.20261006).

## Amendment 2026-10-25 (#1913): Phase 7e builds machine clean and reviews the App's pull request

A further slice of the Phase 7 amendment above, built by Phase 7e.
It builds decision 7's definition of machine clean, the readers of the facts it is decided from, and the review of the pull request the automatic path opens.
Nothing here merges, moves a record, dispatches a run or mails anyone: the slices that advance the gates and send the merge call what this one builds, and a source scan keeps its import closure free of mail.
One annotation is added to earlier text, on the sentence of "Not yet verified" this slice corrects.

### Machine clean, as built

- The rule is one pure function, `machineClean` in `shared/repull-machine-clean.ts`, of facts read at decision time, and it answers clean or the word of the first rule that does not hold.
  The gates and the merge each gather their own facts (`gatherMachineCleanFacts` in `backend/src/services/upstream-repull-facts.ts`) and nothing is carried from one stage to the next.
  A pass is never carried between stages; an administrator's `--redo` resets passes on other pull requests, and none can touch this class, whose review only the Worker starts (below).
  *Annotated 2026-10-29: the review rule now reads `waived` for the record's own head ([ADR 0117](0117-an-upstream-re-pulls-own-pull-request-is-waived-from-the-review-by-nemars-record.md)), so no review row is read and a `--redo` reaches nothing here.*
- The rules, in their order:
  exact production and the open switch, and at the merge the merge switch;
  a record the automatic path made, of an `on` dataset;
  no N.0.1, and the plan's unexplained, conflict and correction counts each stated and zero;
  a named dataset (anonymity that cannot be read holds as anonymous), not withdrawn, with no import that has not settled, and still the mirror of the record's `ds`;
  the recorded pull request, open and unmerged, by its number, from the recorded release branch into `main`, from the dataset's own repository (a fork, a deleted one included, is refused), not a draft, and opened by the App, its login, numeric id and type all matching;
  its head the recorded head at the gates, and at the merge the screened head, which must also still be the recorded head;
  `main` exactly the commit the record bases on;
  BIDS validation and `version-check`;
  the screen;
  the review;
  and GitHub's `clean`, where `unknown`, null and every other state wait.
  *Annotated 2026-10-29: the review is waived at the recorded head ([ADR 0117](0117-an-upstream-re-pulls-own-pull-request-is-waived-from-the-review-by-nemars-record.md)); a stored pass still passes where the rule does not waive.*
- The facts come from GitHub's record of the pull request, `git/ref/heads/main` and the check runs, read with the Worker's own credential; from the record; from the dataset row and its import, read by the statement the create reads; from the screen bound to the record; and from the review row of the head.
- Unknown is never clean.
  A GitHub answer that is not 200 (a 404 included), a timeout, a throttle and an answer of another shape read as unreadable, and each holds, as do a missing screen, a missing review and any value outside the declared ones.
- Outside exact production and with a switch off nothing is read, the database included, and for a record or a dataset the rule already refuses GitHub is not asked: the organization is shared with dev, and the tick's subrequests are shared by every job on it.
- An import has settled only at `complete`, `failed`, `quarantined` or `rolled_back`; any other status holds, `incomplete` included (the retry engine is repairing it), and so does a status no list declares.
  This is stricter than the record's own fence, which refuses an import that is preparing, copying or finalizing and is unchanged: that fence asks whether an import is writing, and machine clean whether it has settled.
- Three hold words are added, `dataset-not-mirror`, `pr-draft` and `screen-exempt`; the last is an `xx` screen, which decision 7 says is never clear.
- The daily merge cap is not a fact the rule reads.
  The claim to merge counts it in the statement that writes the claim (the Phase 6e amendment), so a reading taken earlier could only be stale, and the merge sent with the screened head is the last check.

### The checks are the App's own

- Each check is asked for by name (the names `deriveContexts` gives the dataset), for App 3679074's runs only and the latest of each, and the answer is filtered again by name, App and head, so a GitHub that ignored a filter cannot pass another App's run or one a person posted.
  Of the App's runs of a name the one with the highest id is read, since a re-run is a new run, and a page that does not hold every run GitHub counts is unreadable.
- Green is `completed` with `success` and nothing else.
  `neutral` and `skipped`, which GitHub counts as passing a required check, are not green here, and a commit status, which names no App, is not read.
- Measured read-only on 2026-10-25 on `nm000527#1`, a central-flow repository: both `Run BIDS Validation` and `version-check` are posted by App 3679074, the shims' own job runs are GitHub Actions' under other names, and GitHub honored `check_name`, `app_id` and `filter=latest`.
  `deriveContexts` still leaves `version-check` unpinned for the rulesets, which this slice does not change.
  The four legacy-inline repositories post `bids-validation` as GitHub Actions and so never read green here, which is the safe direction; none of them is a mirror.

### The screen and the review, read strictly

- The screen is read as its own gate reads it, a run past its report deadline included, but `acknowledge` never passes here, whoever recorded the reason, because machine clean needs `clear`.
  A clear verdict whose stored report does not name the head is unreadable, and no screen of the head is read as one to dispatch.
- The review is read as ADR 0093's detail view reads it: the stricter of the stored verdict and the one its stored report re-derives, so either can lower it and neither can raise it.
  *Annotated 2026-10-29: read only where the rule does not waive the head ([ADR 0117](0117-an-upstream-re-pulls-own-pull-request-is-waived-from-the-review-by-nemars-record.md)), which for the record's own head at its recorded commit it always does.*
  A stored report that no longer parses is an error unless the column says `fail`.

### The review of the App's pull request (corrects "Not yet verified")

*Annotated 2026-10-29: retired by [ADR 0117](0117-an-upstream-re-pulls-own-pull-request-is-waived-from-the-review-by-nemars-record.md). The App's pull request is waived at its recorded head, `startRepullPullRequestReview` and the intake's `admitRepullBot` are removed, and a delivery or a start of the App's pull request is a bot's (`bot_author`) as ADR 0092 says.*

- "Not yet verified" says the App is not exempt, so the review runs.
  As the code stood, that was false: the review's intake skipped every bot's pull request (`bot_author`), as ADR 0092 says ("not drafts, not bots"), so no review row could exist for the App's pull request and none could be machine clean.
- The correction admits exactly one class, the App's automatic re-pull pull request, and only when the Worker itself starts its review from the record (`startRepullPullRequestReview` in `backend/src/services/pr-review-start.ts`).
  Nothing calls the start yet; the slice that advances the gates will.
  *Annotated 2026-10-25: the Phase 7f amendment's advance tick calls it, and nothing else does.*
  Its gates, in order, each with the answer it starts nothing with:
  exact production (`not_production`) and the open switch (`auto_repull_off`);
  a dataset this Worker owns (`not_owned_here`), which is every dataset outside the dev Worker's own ids, none of which is an `on` mirror;
  an automatic record of an `on` dataset (`not_automatic`) at `pr_open` with its branch, number and head (`not_pr_open`);
  the review switched on (`pr_review_disabled`) and a dataset the review may read, live, named and published (`unknown_dataset`, `dataset_not_reviewable`);
  and GitHub's record of the recorded pull request (`github_unreadable` when it cannot be read), authored by the App by login, numeric id and type (`not_app_author`), at the recorded head (`head_moved`).
  The intake then admits it only from the release branch the record names, in the dataset's own repository, and any other is the intake's `bot_author`.
  A start that dispatched writes an audit row with no user; a row that could not be written is logged and does not undo or block the review, so the answer says nothing about it, by design.
- Nothing else about bot authors changes.
  A delivery GitHub sends for the App's pull request, and an administrator's `nemar admin pr-reviews start` of it, still answer `bot_author`, and every other bot's pull request is skipped as before.
- The App has no NEMAR account and its login is not a person's login, so it is never exempt, and every other rule of ADR 0107 applies to it unchanged: a reviewable dataset, an administrator's block, the per-commit row and the edit cap.
  The Worker's start is not an administrator's: it does not start again a commit whose review errored, was declined or went unreported, and only a review whose dispatch failed (`dispatch_failed`, a run GitHub never started) is tried again.
- 2026-10-25: this narrows ADR 0092's "not bots" for one class only, the NEMAR App's automatic re-pull pull request, which is reviewed when the Worker starts its review; for every other pull request ADR 0092 stands as written, and its header says so.
- Keeping the webhook out has two consequences.
  An edit of the App's pull request's title or body, which ADR 0107 re-reviews for anyone else, is not taken up, so a stored pass stands across it; a change of its base is still refused by machine clean.
  And nobody but the Worker's own start can restart the review of the App's pull request on the same head, and that start restarts only a review whose dispatch failed (`dispatch_failed`, a run GitHub never started); an administrator's `--redo` cannot.
  So once a review of a head has errored, been declined or gone unreported, the re-pull holds at `review-not-pass` until its pull request has a new head, and an administrator's merge is the only other way on.
- The review queue's detail view names the App's pull request's author `nemar-publish-bot[bot]`, from the stored review and from GitHub when the login and the numeric id both match, where it showed `(unknown)` and a mangled login before; every other login is reduced to a login's characters as before.

### Checked only against stand-ins

The suites run the real record, screen and review rows, but GitHub is a stand-in, and these are what only the first production runs can check:
that GitHub names the author of the App's pull request `nemar-publish-bot[bot]`, id 283755542, type `Bot`, as `GET /users` answered;
that the App's token reads `mergeable_state` as an administrator does;
that `check-runs` honors its filters on a mirror as it did on `nm000527`;
and that the review workflow claims and reports on a pull request a bot opened as it does on any other.
*Annotated 2026-10-29: moot: no review runs on the App's pull request since [ADR 0117](0117-an-upstream-re-pulls-own-pull-request-is-waived-from-the-review-by-nemars-record.md); what the first runs check instead is that its waived check is published.*

## Amendment 2026-10-25 (#1912): Phase 6f takes a re-pull past its pull request, merges it through one gate, and records the release

A further slice of the Phase 6 amendment above, built by Phase 6f.
It builds `nemar admin repull status`, `resume` and `merge`, routes `nemar admin pr-reviews`' merges of a re-pull pull request through the same gate, and records the release and the lock: a re-pull now goes from `pr_open` through `released`, and to `complete` when its plan had no corrections.
N.0.1, abandoning a record and superseding one are a later slice's.
*Annotated 2026-10-25: built by the Phase 6g amendment.*
Nothing here sends mail; the administrator reads a re-pull's state with `nemar admin repull status <id>`, which shows the record, its identifier screens and the command that takes it on.
Seventeen annotations are added to earlier text, where this slice builds, changes or does not build what it said was a later phase's.

### Resume never merges

`nemar admin repull resume <id>` runs on the administrator's machine with their own GitHub token, and refuses a dataset whose catalog row does not say `anonymous` is exactly 0 before anything is written, as every run of execution does.
The working clone is gone by then (it held the delta's unscrubbed originals and is removed at `pr_open`), so resume reads NEMAR's origin through a bare scratch repository of its own, `$NEMAR_CONFIG_DIR/repull/<id>/resume/<digest8>-<pid>/`, mode 0700 and removed at the end of the run (the merge gate keeps its own under `merge/`, so the two never remove each other's), under the same lock as an execution of the record's plan, so an execute and a resume of one record never both push.

At `pr_open` it reads the pull request on GitHub.
One found merged is recorded through the Worker's verified route, which reads the merge on GitHub itself; the record gains the edge `pr_open -> merged` (and its N.0.1 twin) for that route alone, and such a merge is counted as one no tool held a claim for, at a head that was not screened, which closes the case the Phase 6e amendment left to this slice.
One found closed without a merge ends the record `abandoned` (decision 3), at `pr_open` and at `gates_clear` alike.
A head that moved by the commits enrichment writes is recorded; any other head is `head-foreign`, recorded as the step's error with the recorded head kept, so a foreign commit is never screened or gated.
On top of a synthesized N.0.0 only the first of the three enrichment shapes can arise on the release branch (a regular file under `.nemar/`), because the commit's tree already carries the `.nemar/` line in `.bidsignore` and a `participants.tsv`; the other two are accepted by the same function and are covered by its own suite.
`main` must be the record's base or an enrichment-shaped descendant of it (`main-moved` otherwise).

The identifier screen of the recorded head is dispatched when none exists or it produced no verdict, and waited for.
A verdict that asks for a person is acknowledged with `--acknowledge-identifier-screen "<reason>"` on resume, not on merge: the edge into `gates_clear` already requires the screen to pass for the administrator who takes it, so the reason must be recorded before the gates (ADR 0086's rule that it counts only for the administrator who recorded it).
A direct identifier stops the gates, recorded as `screen-blocks`.
When the screen passes and GitHub reports the pull request `clean`, resume records `gates_clear` with the screened head, and stops: "Ready to merge".
It waits up to `--wait-minutes` (10 by default) for the screen and for GitHub, reading both again on each turn; still waiting at the bound is exit 3, with what it waits for.
Every error a step past the open pull request records begins with that step's word (`[gates:`, `[release:`, `[lock:`), never `[prepare:`, so a `prepared` self-edge never clears one.

### The re-synthesis onto a moved `main`

When `main` moved by enrichment and GitHub reports the pull request `dirty` or `behind`, resume makes the re-pull's commit again on the new `main` and replaces the release branch with the write guard's leased push, asking first unless `--yes`; a pull request GitHub reports `clean` is not re-synthesized.
The new commit has the recorded commit's message, identity and dates, one parent (the new `main`), and the recorded tree with what enrichment did on `main` applied to it as enrichment itself would, never undone.
Under `.nemar/**` it holds the new `main`'s files, except `.nemar/metadata.json`, which is the new `main`'s with the NEMAR-owned `IsIdenticalTo` edit applied again, and the privacy ledger, which is the recorded commit's (enrichment never writes it).
When enrichment changed `.bidsignore` on `main`, the new `.bidsignore` is the recorded one with the `.nemar/` line added, so upstream's lines stay and enrichment's line is kept.
When enrichment added a root `participants.tsv` on `main`, the new tree keeps N.0.0's own when it has one (upstream's, or the standard edit's placeholder of `to_tag`'s subjects), and otherwise holds the placeholder of the new tree's subjects, as enrichment makes it, or none when it has no subject.
Every other path is the recorded commit's, entry for entry, so the keys it names, their copies and their registration all stand.
The `IsIdenticalTo` edit is read off the recorded commit itself, which must differ from the base's file by exactly that edit, so resume needs no plan file, and the recorded commit's trailers are checked as git reads them before anything is made.

The new commit is a function of the recorded commit, the base and the new `main`, so it is made the same, byte for byte, every time.
A run that pushed it and could not record it (the write after the push failed) leaves a release branch whose head does not descend from the recorded commit; the next resume does not call that head foreign: it recognizes it as the commit it would make for that head's own parent, that parent being the base or an enrichment-shaped descendant of it (beneath enrichment commits on the release branch too), and records it.
The record's `base_sha`, `synth_sha`, `synth_tree` and head are written in one `pr_open` self-edge; the screen then runs again for the new head.

### The merge gate (decisions 6 and 7, the administrator's path)

Every merge of a re-pull pull request by a NEMAR tool, `nemar admin repull merge <id>` and `nemar admin pr-reviews` (`approve --merge`, `y` in `next`) alike, goes through one gate (`src/lib/repull/merge.ts`).
Before anything is written it reads, in order: the record at `gates_clear`; the dataset not anonymous; the live pull request open, not a draft, the record's release branch into `main`, at the screened head; `main` the base or moved by enrichment only; the ADR 0107 review of that head, with one that failed, is running or cannot be read needing `--force` as `approve` does; the identifier screen of that head; GitHub's state `clean`; and the squash message.
The gate writes the squash message itself: the title `Release v<N.0.0> (#<pull request>)` and a body whose last paragraph is the re-pull commit's two trailers, checked with `git interpret-trailers` against the privacy ledger proof's own patterns, so the merge on `main` is read as the re-pull's commit (the Phase 6b amendment's requirement); a message that would not carry both is refused at the gate (`message`).
Then the review is read once more, at the merge and never carried over, since an administrator can reset a stored pass on the same head (`start --redo`), and the administrator confirms (one version DOI that cannot be withdrawn).
*Annotated 2026-10-29: the review read here is `waived` for the record's own head at the screened commit ([ADR 0117](0117-an-upstream-re-pulls-own-pull-request-is-waived-from-the-review-by-nemars-record.md)), so it needs no `--force` and a reset of a stored pass changes nothing.*
Then, holding the record's lock, the one `resume` and `execute` take, so no resume expires the claim or moves the head while the merge is out, one unit of the day's merge cap is claimed from the Worker, the squash merge is sent with the screened `sha` (so GitHub refuses a head that moved after the gate's last read, which the Phase 6e amendment relies on), and the merge is recorded through the verified route.
A claim whose answer is lost (no answer, or a 5xx a gateway may send after the Worker wrote) may be held, and the gate says so and exits 3, never "nothing was claimed".

A claim already held for the screened head (a merge whose answer was lost, a run that stopped after its claim) is used again, without a second claim, because a pull request merges once, but only after `POST /admin/repulls/:id/merge-claim/check` passes: the Worker reads again, for that claim, what the claim's statement read when it was made (the dataset a mirror of its `ds`, not anonymous, not withdrawn, no import in flight; the identifier screen passing for this administrator, so one administrator never merges under another's acknowledgment; the live head at the screened `sha`), and the claim younger than 25 minutes by its own stamp, so no merge is sent under a claim resume may be expiring at 30 (`claim-too-old` otherwise).
That route writes nothing.
A merge GitHub did not make (not sent at its last look, or refused) keeps its claim: the claim is seconds old, younger than the five minutes the Worker requires before any release, so the gate does not try; a merge sent again within 25 minutes uses it, and resume expires it at 30.
A merge whose answer is lost keeps its claim too, and the next resume reads GitHub and records the merge; a merge GitHub made that could not be recorded exits 3 and is recorded by resume.
`nemar admin repull merge` uses a token that must belong to a person (never an App or workflow token), and, when the administrator's NEMAR account names a GitHub login, must be that login; an account that names none is not checked, as `pr-reviews` does, and only a different login refuses.
It submits no approving review: ADR 0001 requires none, and an administrator cannot approve the pull request they opened through `execute`.

`nemar admin pr-reviews` looks up a pull request whose head branch is `release/*` in the re-pull records.
A re-pull's runs the gate's checks before the approval is written, and again after the confirmation, so a refusal writes nothing, then the approval as before, then the gate's merge in place of its own; an explicit `--method` other than `squash` is refused before anything is written, and so is a re-pull's N.0.1 pull request (its merge is not built).
*Annotated 2026-10-25: N.0.1's merge is built by the Phase 6g amendment, through the same gate, and `pr-reviews` merges an N.0.1 pull request only through it.*
A NEMAR API that cannot say whether the pull request is a re-pull's refuses its merge ("could not tell"), never merges it unguarded, and so does a GitHub answer that does not name the head branch.
An ordinary release pull request, one no record names, is merged as before.
AGENTS.md's summary of ADR 0093 now names the three ways a NEMAR tool merges and the one gate a re-pull's pull request goes through (decision 7 asked the phase that builds the merge to update it).

### A stuck claim expires (closes the Phase 6a amendment's open point for open records)

A claim whose outcome the caller does not know (a lost answer, a run that stopped between its claim and its merge) is released with a third outcome, `expired`, only once the Worker's own stamp says the claim is 30 minutes old, long past any merge a tool can have in flight, and only when GitHub, read by the Worker, says the pull request did not merge, in a statement that clears the claim only while no merge is recorded.
`unknown` is still not an outcome a caller may send: only GitHub, read after nothing can be in flight, says a merge did not happen.
Resume sends `expired` when it finds a claim on a `gates_clear` record; a younger claim is kept, and resume says how to go on.

Left open, for the owner: a `failed` record holding a claim or a merge with no tag, which only a hand-made transition could leave, is not reconciled by anything.
No path built here writes `failed`, and such a record keeps the dataset blocked (a new re-pull is refused `merge-unreconciled`), the safe direction; until a later slice builds a reconcile for it, an administrator resolves it by hand.
*Annotated 2026-10-25: not reconciled by the Phase 6g amendment either: `failed` is terminal and abandon ends only an open record, so such a record still keeps the dataset blocked; the open item stays the owner's.*

### The fences on every step past `prepared`

The Worker now reads the dataset fences again (a mirror of that `ds`, not anonymous, not withdrawn, no import in flight) on every edge into a status after `prepared` that keeps the record open: the copy, the registration, the pull request and its head, the gates and the claim (as before, with the screen), and the lock's count; and the held-claim check reads them before a claim is used again.
Not on an edge that ends the record, so giving up stays possible on a dataset that became anonymous or withdrawn; not on a self-edge that writes nothing but why a step failed; and not on a fact a verified route writes from GitHub or the version row, because a merge that happened is recorded whatever the dataset has become since.

### The release and the lock (decisions 2, 4 and 8)

From `merged`, resume first reads back the squash commit GitHub wrote on `main`: its message must carry the re-pull commit's two trailers as its last paragraph, as git reads them.
The gate checked the message it sent; this checks the one committed, because a host that appends a paragraph of its own (a `Co-authored-by:` line, say) would push them out of the last paragraph and the privacy ledger's fresh-clone proof would then fail the dataset.
A message that does not is `merge-trailers`, recorded, and the record stays `merged`, loudly: the version may already be tagged and minted, and only an administrator decides what follows.
*Annotated 2026-10-29: built by the amendment of that date: resume waits for the tag and the version row first, then `nemar admin repull resume <id> --accept-merge-trailers "<reason>"` accepts the merge once the CLI and then the Worker have read that it is the record's own squash merge, and the release goes on as for a gated merge.*
Then resume waits for the tag `v<N.0.0>` on NEMAR's origin and for the version row, compares the tagged tree with the recorded synthesized tree outside `.nemar/**` and `.github/**`, and records the release through the Worker's verified route with that comparison as `tree_verified`, which alone upgrades the version's lineage; the Worker re-arms the dataset's four sweep stamps in the same batch.
A tag on another commit leaves the record `merged` with the error recorded, through a new `merged` self-edge that records only an error, as `planned`'s does: still resumable, and never `failed`, which would end a record whose merge minted a DOI.
Nothing here mints; the existing DOI tooling repairs a mint that failed.

Then the objects N.0.0's copy and uploads wrote, and only those, are locked under the governance lock with the existing s3-lock route, named one by one (`objects`, at most 100 per call), never the whole prefix: the earlier versions' objects are their publications' to lock, and an abandoned attempt's orphans are not N.0.0's.
Their keys come from the staging manifest the copy wrote to `<id>/staging/repull-<to_tag>.json` before its first copy, read with the ambient AWS credentials from the bucket NEMAR's git-annex branch names, whose digest must be the one recorded at `prepared` (`manifest-mismatch` otherwise).
For each key the route reads the current version and locks that version.
Read before it was relied on, the route took a 403 on PutObjectRetention for "already locked", which a credential without that permission also answers; it now reads the object's retention back on a 403 and counts it locked only when that is a GOVERNANCE or COMPLIANCE lock at least 50 years ahead (the lock it sets is 100), and the publication path's prefix mode reads it back the same way.
The count is recorded only when every one of the keys is locked; otherwise the `released` self-edge records why (`lock-incomplete`, counts only, never a key) and the record stays `released` without its count, a resumable state and never a silent release, and the next run locks again.
The Worker refuses a count below what the record says the copy and uploads wrote (`copied`, `skipped`, `local_uploads`; `lock-incomplete`, and a record that does not say is refused too, since unknown is never zero), refuses `released -> complete` and `released -> patch_synthesized` while the count is not recorded (`lock-unrecorded`), and a `released` self-edge that records the count clears the error the lock's failure recorded (`CLEARING_SELF_EDGES`).
A record whose plan stated zero corrections then ends `complete`; one with corrections, or that does not state the count, stays `released` until N.0.1 is built.
*Annotated 2026-10-25: N.0.1 is built by the Phase 6g amendment: a record with corrections goes on to N.0.1, one whose plan lists conflicts waits for an administrator's decision first, and one that does not state both counts stays `released`.*

### Checked only against stand-ins

The suites drive the real `execute`, `resume`, `merge` and `pr-reviews` commands, the real Worker routes over bun:sqlite and the real `git`; GitHub and S3 are stand-ins, and these are what only the canary and the first production runs can check:
that GitHub's merge endpoint refuses a head that moved for `sha` (a 409, as the stand-in answers) and writes `commit_title` and `commit_message` as the squash commit's message unchanged (the release reads the commit back, so a host that changes it is caught, not missed);
GitHub's `mergeable_state` words for a re-pull pull request, how soon its `head.sha` follows a push, and that a leased forced push to a release branch of a dataset repository is accepted;
that the dataset workflows tag the squash merge of a re-pull as they tag other merges (already under "Not yet verified");
and that the real bucket answers HEAD, PutObjectRetention and GetObjectRetention on a copied object's version as the stand-in does, including what it answers a credential without the lock permission.
The s3-lock route signs PutObjectRetention with an MD5 `Content-MD5`, which workerd's WebCrypto digests and Bun's does not; the suites give Bun's that one algorithm from `node:crypto` while the Worker's routes run in their process.

## Amendment 2026-10-25 (#1913): Phase 7f advances an automatic re-pull to its gates

A further slice of the Phase 7 amendment above, built by Phase 7f.
It builds the tick that takes an open automatic re-pull one step on, or says why it waits: the hold, the edge into `gates_clear`, the screen and the review that edge waits for, and the resume of a run that stalled before its pull request opened.
Nothing here merges, claims a merge or mails anyone: the merge, the follow-through after it and the observability are later slices, and a source scan keeps this slice's import closure free of mail.
*Annotated 2026-10-26: the merge and the follow-through after it are built by the Phase 7g amendment.*
Five annotations are added to earlier text: on the record's header, on the opening of the Decision section, on the 7b slice's sentence that a later slice writes `hold_reason` and `hold_since`, on the 7c slice's sentence that a later slice bounds a resume by its own count, and on the 7e slice's sentence that nothing calls the review's start yet.

### The tick

- It runs on the 30-minute production tick, inside that tick's production guard and absent from `DEV_CRON_ALLOWLIST`, and returns before it reads or writes anything unless `ENVIRONMENT` is exactly `production`, because the `nemarDatasets` organization is shared with dev.
- In production with `AUTO_REPULL_ENABLED` not exactly `"1"` it asks GitHub nothing, claims and sends nothing, and records `switch-off` on each row it reads, a row a run is still out for included.
  *Annotated 2026-10-26: but for the rows a merge minted a DOI for, or may have, which the Phase 7g amendment takes on whatever the switches say: a held claim is resolved from GitHub and a merged re-pull finished; nothing is merged while a switch is off.*
- It reads only automatic rows: an administrator's row is never read, held or advanced, because the Worker never takes an administrator's re-pull on (decision 7).
- It reads the rows stalled before their pull request opened (`planned` to `registered`) and the rows at `pr_open`.
  A row at `gates_clear`, `merged` or `released` waits for the merge slice, and this tick does not read it; a row that reaches another status between the tick's list and its own read of the row is left alone.
  *Annotated 2026-10-26: the Phase 7g amendment's merge and finish read those rows, in a third rotation; a row that reaches another kind between the list and its own read is still left alone.*
- At most five rows of each kind a tick, in two rotations by id, so neither kind crowds out the other.
  The rows at `pr_open` turn every half hour.
  The stalled rows are read only inside the resume window, the only time one can be resumed, and turn once for each half hour of the window, counted across days, so each is read inside the window within as many window ticks as it takes five at a time to cover them, whatever the number of rows of either kind.
- Two readings of the first design were changed, each because it would leave rows unread.
  Reading the five least recently updated rows would read the same five that wait on an administrator on every tick and a newer row never, because a hold does not update a row, and most automatic pull requests will wait on one, since most mirrors' screens ask for an acknowledgment (Consequences).
  One rotation turned by the half hour of the day would come back to the same rows at the same hours every day (48 ticks of five rows a day is one full turn of 240 rows), so of 240 open rows only 130 would ever be read inside the window, and the rest could never be resumed; a test reads every stalled row inside the window over 60 days for sets of 239, 240, 241 and 480 rows and for mixed sets.
- Each production tick that could list its rows stamps the scheduler's row with when it ran (`last_advance_at`), for the observability slice; one that could not list them stamps nothing.
- It sends no mail.
  Its one log line, in counts and fixed words, is written only when it changed something, a review's start or a clean row's edge was refused, or something failed; a row whose step threw is logged by the record's id and its error's class, never its dataset or a message, and the next row is taken up.
  *Annotated 2026-10-29: the tick starts no review since [ADR 0117](0117-an-upstream-re-pulls-own-pull-request-is-waived-from-the-review-by-nemars-record.md); the line counts `waivers=` and `waivers_failed=` instead of `reviews=` and `review_refused=`.*

### A hold is an observation

- A hold is a fixed word and since when, on the row, and only on an automatic row.
  It is the first machine-clean rule that does not hold, or a bound the automatic path reached.
- It is written only when the word changes, with one audit row (`repull_hold`, by the system user) per change, so a row that waits for the same reason keeps the time it began.
  Clearing a hold is such a change too.
- It is written only to the row as the tick read it (its `revision`), so a row that moved meanwhile is not given a reason about what it was.
- It moves neither `revision` nor `updated_at`: the record's compare-and-set, and the times other slices read, are untouched.
- An edge into another status clears it, and a self-edge keeps it until the tick reads the row again.
- A row a run is still out for (a live dispatch of its dataset) has no hold recorded, because nothing holds it but its own run, and GitHub is not read for it while the run settles the head it opened; a hold it had is cleared, with its audit row.
- This slice adds three hold words, `resume-refused`, `cap-unreadable` and `gates-refused` (below), and one code to the dispatch record's, `dispatch-deferred`.

### The gates

- A row at `pr_open` is read at the gates by the 7e slice's reader and decided by its rule, at the recorded head.
- Only a clean verdict writes `pr_open -> gates_clear`, with the head as `gates_sha`, as the system user, through the record's own transition on the row as the tick read it.
  The transition reads the dataset fences, the screen bound to the row and GitHub's live head again, and re-asserts the screen's verdict in the statement that writes, so a fact that changed in between refuses the edge and nothing is written.
- An unknown fact never writes the edge: an unreadable pull request, `main` or check, a mergeable state that is `unknown`, null or anything but `clean`, and every other word hold.
- A clean row whose edge the transition refuses holds `gates-refused`, and the tick's log line is an error with the refusal's code on every tick it happens: the rule and the record disagree, which should not happen, and is seen when it does.

### What the gates wait for

*Annotated 2026-10-29: the review half of this section is retired by [ADR 0117](0117-an-upstream-re-pulls-own-pull-request-is-waived-from-the-review-by-nemars-record.md). The tick starts the screen only; the review of the recorded head is waived, so machine clean reads it as `waived` and no review is started or read.*

- The tick starts the screen of the head only once every rule before the screen holds: the switches, the record, the dataset, the recorded pull request opened by the App at the recorded head, `main` unmoved, and both checks green.
  So no screen run is spent on a pull request the Worker would not take on anyway, and a pull request whose BIDS validation failed waits for an administrator, who may dispatch its screen by hand.
- The identifier screen is dispatched for the head (the 6e slice's start, `ref` the head, `request_id` 0, its callback bound to the row) when the head has no verdict: no screen, a screen that errored or one that never reported.
  At most three times for one head, counted from the screen's own audit rows of that head, so a workflow that always fails is not run on every tick, and a new head has its own three; an administrator may dispatch it again.
  A verdict that asks for a person is not dispatched again here: it never passes machine clean, and the same commit would be asked the same question.
- The ADR 0107 review is started (the 7e slice's start, the one that admits the App's pull request) only once the screen of the head is `clear`, so on a later tick than the screen, when the head has no review, or when its dispatch failed, a run GitHub never started, at least an hour before.
  A screen still out may yet block or ask for a person, and one that errored, blocks or asks for a person means the head is not machine clean now, so a review then would be a model call spent on a head that may never pass.
- When the review's own start declines (the review switched off, a dataset it may not read, GitHub unreadable, another author or another head), its reason is counted and logged on every tick it declines, so a row held `review-absent` says why.

### The resume of a stalled run

- A row stalled before its pull request opened is resumed when no dispatch of its dataset is live and its latest dispatch, by id, `failed`, went `unreported`, or was refused by GitHub before it ran (`dispatch_failed`), or it has none.
  The first design named the first two; a refused send ran nothing, and a row left with it would otherwise wait for good with nothing said.
- Before anything is claimed: the record and the dataset must pass the machine-clean rule's own rules for them, read by its reader (an automatic record with no correction, of a named, not withdrawn mirror with no import that has not settled), or the row holds with that rule's word.
- A latest run that refused holds `resume-refused`: the run said why it would not go on, and another would meet the same refusal, so an administrator looks.
- A row has at most three `open` dispatches, the one that created it included, so it is resumed twice at most; past that it holds `resume-exhausted`.
  A run that failed, refused or never reported counts, and so does a send GitHub refused for the dispatch itself (a 404 or a 422, `dispatch-refused`), so a refusal that repeats cannot dispatch for ever.
  A send GitHub turned away for a reason about the Worker (its credential, its permission, a rate limit: any other 4xx, a new dispatch code, `dispatch-deferred`) does not count, because nothing about the row was tried.
  GitHub also answers 404 when a token cannot see a private repository, so a credential outage that shows as 404 spends an attempt on each send, two at most for each stalled row, and can leave rows `resume-exhausted` for an administrator; this is accepted, because a 404 cannot be told from a refusal of the dispatch's own target, and counting it errs toward fewer dispatches, at the cost of an administrator's look.
- The bound relies on the creating dispatch being linked to its record.
  The automatic create links it in the batch that inserts the record, which rolls back when the link does not apply, so an automatic record is never without it; a record that somehow had none would be resumed up to three times more, which the bound cannot see.
- It is resumed only once neither the row nor its latest dispatch (its report, or its send when it has none) has moved for an hour: a run that fails before it writes anything leaves the row's `updated_at` hours old, and would otherwise be resumed on the next tick.
  A time that does not parse is the error word `time-unreadable`, never a wait, though D1 writes every one of these times itself.
- Only from 03:00 to 15:59 UTC, so a run dispatched at the end of the window has its 330 minutes and an hour of queueing before the UTC day ends and opens its pull request on the day whose unit of the open cap it claimed, the timing the 7b slice's open cap relies on.
- The claim is the dispatch record's own, naming the row, so the open cap is counted in the statement that claims and a resume can never pass it.
  The claim matches the record's tags in either spelling (`v1.0.0` and `1.0.0`), as the lineage write does, and one that does not find the row the tick read is the error word `repull-mismatch`, never a silent wait.
  A full day holds `cap-exhausted`; a cap set to something its reader cannot take holds `cap-unreadable` and is an error, because it is a fault in the configuration and not a full day; after either, no later row of the tick claims.
- The dispatch is sent as the scheduler sends a first one, in `open` mode with the row's id, from a release build only: GitHub's refusal ends the claim `dispatch_failed`, freeing its unit, and stops the tick's sends, and a lost answer keeps the dispatch and its unit, as the 7c slice reads them.
  A payload that cannot be built after the claim (every field is checked before it, so this guards drift between the two checks) ends the claim `dispatch-failed`.
- No GitHub token, no callback secret and a recorded tag that is not a tag each stop the resume before a claim, with their own error words.

### What a tick costs

*Annotated 2026-10-29: superseded by the figures in [ADR 0117](0117-an-upstream-re-pulls-own-pull-request-is-waived-from-the-review-by-nemars-record.md), Consequences: no review is started or read, so five rows at `pr_open` cost 62, 32 and 47 statements, and past the gates 32 and 77.*

Measured over five rows at `pr_open`, the most a tick reads of that kind: 67 D1 statements and 25 GitHub requests when each starts its screen, 37 and 20 while each waits, 82 and 35 when each starts its review, the most, and 52 and 25 when each is cleared; a resume is eight statements and one dispatch, and the tick itself two statements.
Add one request to mint the App's installation token on a cold isolate when the App's credential is configured; the suites use a personal token, so the figures leave it out.
The first design estimated about 45 in all; a tick that starts five rows' reviews and resumes five stalled rows costs more than three times that, within the shared allowance of 1,000 but no longer a small part of it, and a test pins each figure.

### Checked only against stand-ins

GitHub is a stand-in in the suites, and the unattended run is not built yet, so these are what only the first production runs can check:
that the screen and the review start on the App's pull request as they do on the stand-in;
*Annotated 2026-10-29: the review half is moot since [ADR 0117](0117-an-upstream-re-pulls-own-pull-request-is-waived-from-the-review-by-nemars-record.md): only the screen starts, and the App's pull request gets the waived check.*
that the review's check and comment are published on a pull request the App opened;
that a resumed run takes up the record its dispatch names (the unattended run's slice);
that GitHub answers a send it refuses for the Worker's credential or rate with a status other than 404 and 422, which is what keeps such a send from spending a resume;
and that the tick's real cost on the 30-minute tick is the one measured here.

## Amendment 2026-10-25 (#1913): Phase 7d runs a re-pull unattended

A further slice of the Phase 7 amendment above, built by Phase 7d.
It builds the run a dispatch starts: the central workflow that opens an automatic re-pull's pull request and finishes a merged one, and the CLI's automatic mode that workflow runs.
Nothing here merges; the Worker's merge is a later slice's.
The workflow is authored in this repository and not deployed: its copy in `nemarDatasets/.github` is a pull request of its own, held until the epic ships, so until then GitHub takes the Worker's dispatches and nothing runs, and the watchdog ends each one `unreported`.
*Annotated 2026-10-27: the copy in `nemarDatasets/.github` merged as `nemarDatasets/.github#148` before the release, and this repository's #1980 makes the `unit-pure` tier compare the two copies byte for byte.
The workflow runs only on a dispatch the automatic path sends, and that is off, so nothing runs because no dispatch is sent, not because the workflow is missing.*
Nothing here sends mail or adds a route.
Four annotations are added to earlier text, on the record's header, on the Decision section's, on the 7c slice's timing sentence and on the "Not yet verified" item about enrichment.

### Where the run executes

- The run is the one job of `run-upstream-repull.yml` in `nemarDatasets/.github`, started by the Worker's repository dispatch and by no other event, as the import's own workflow is started.
- In open mode it runs `nemar admin repull plan` and then `nemar admin repull execute`, through the execution an administrator's run takes (the record, the preparation, the copy, the registration, the release branch and the pull request), never a second path.
  In finish mode it runs `nemar admin repull resume`, through the release and the lock to `complete`, waiting at most 30 minutes (`--wait-minutes 30`) for the tag and the version row, which the finish dispatch is claimed after anyway; still waiting at that bound is `failed finish-incomplete`, resumable.
  It never merges.
- The release branch is pushed, and the pull request opened, with an App token the job mints for the dispatch's dataset repository alone, with write on its contents and its pull requests and nothing else, so the App is the pull request's author.
  Every action the job uses is pinned to a full commit, the commits the publication review's workflow pins.
- Each run is its own concurrency group, never one taken from the payload: GitHub replaces the pending run of a group, so a group named by the dataset would let a forged event replace a dispatched run before it started, the reason ADR 0092's review workflow gives for its own.
  The Worker's one live dispatch per dataset keeps two runs off one dataset.
  The plan named a group per dataset; this departs from it, in the safer direction.
- The job's bound is 330 minutes, `REPULL_JOB_TIMEOUT_MINUTES` in `shared/repull-state.ts`, which the workflow's test pins `timeout-minutes` to; nothing in the CLI or the Worker reads it.
  An hour of queueing and that bound end inside the watchdog's eight hours, and a dispatch claimed at the daily tick, at 03:00 UTC, ends before the UTC day it was counted in does, which is the timing the Phase 7b slice asked a later slice to pin: the open cap then bounds the pull requests opened in a day.
  The plan put the check of the last resume hour in this slice's test as well; the stalled-run slice, merged first, owns that hour (`RESUME_WINDOW_UTC`, 03:00 to 15:59 UTC), and this slice's test now checks it with the same function (`opensTheSameUtcDay`).

### The App token's hour

- An installation token lasts an hour, and the job mints it before it installs anything, so no code installed later runs before the App's private key is used.
  The step just before the mint notes the time, in epoch seconds (`NEMAR_REPULL_TOKEN_SINCE`), so the hour the run counts starts no later than the token's own.
  Everything the run does with the token, the registration, the push, the pull request and the settle of the release head, ends inside the first 55 minutes of it (`APP_TOKEN_USABLE_SECONDS`); the last five are kept for the clocks and the last calls.
  A run that cannot read that time, or reads one more than five minutes ahead of its own clock, refuses before it reads anything (`auto-token-clock`).
- The 55 minutes are shared out ahead of time.
  The settle keeps six, its five-minute quiet window and a minute of reads (`AUTO_SETTLE_RESERVE_SECONDS`).
  The install, the two plans, the preparation, the registration, the push and the pull request keep 29, an allowance no measurement here bounds (`AUTO_OTHER_STEPS_SECONDS`), five of them after the copy (`AUTO_AFTER_COPY_SECONDS`).
  The copy has the 20 that are left (`AUTO_COPY_BUDGET_SECONDS`, derived from the others, never set on its own).
  An earlier version of this slice gave the copy 20 minutes and the other steps the remaining 40 of a full hour, and left the settle out of it; the settle now has its share inside the hour.
- So the automatic path refuses a plan whose copy would take more than 20 minutes (`auto-copy-too-long`), at the plan and again from the live plan at execute, before the copy starts, as it refuses a copy over 1 TiB; it is one of the words that end the automatic path for a tag, and an administrator may still re-pull such a dataset by hand.
  The estimate is the copy's bytes and the preparation's uploads at 30 MiB/s, the server-side CopyObject rate ADR 0064 records as measured into NEMAR's bucket, with no credit for the eight copies in flight, plus a second an object, three `aws` calls an object having measured about 0.29 s each against a local stand-in; a count the plan does not state is unknown and refuses.
  The Worker does not check this bound: it does not receive the object count.
- The time already spent is checked as well, on the run's clock against the noted mint: the plan, the execute before its record, and each of the copy, the registration and the pull request at its start refuse (`auto-token-hour`) when what is left of the 55 minutes is less than the step's own estimate (the copy's, or none) with the five minutes after the copy and the settle's six.
  A refusal before the record writes nothing; one at a step leaves the record where it stopped, with `[<step>:auto-token-hour]` on it, before that step wrote anything, so no push is begun that the hour could not finish.
  It is not one of the words that end the automatic path for a tag: a slow install is a fact about the run, not about the tag.
- The settle ends at the end of the 55 minutes, whatever `--settle-minutes` asks, and reads nothing once they are over; a settle that they end before the branch was seen quiet is `head-unreadable`, with the cause `token-hour`, never a token error.
- A run that fails while GitHub answers its App token 401 is reported `token-expired`, whatever its step called the failure, so a run that outlived its token is never reported as a refusal it did not make; the record keeps the step's own error.
  GitHub is not asked when the run's word says why already: the token on the command line (whose report must go first), the token hour's own two words, and a settle's outcome (`head-unreadable`, `head-foreign`), a fact about a pull request that is open whatever the token's state.
- Once an open run wrote its record, `token-expired` is reported `refused`, and it is one of the words that end the automatic path for the tag (`DISPATCH_FINAL_CODES`): the registration and the pull request are the steps that use the token, both after the copy, and a later run would plan again over what the copy wrote and meet a record it cannot take up (the last section but one), so an administrator takes the record on.
  A token GitHub refuses earlier, at the preparation's clone of origin, which an aged token cannot be, ends the path the same way, the safe direction.
  Before the record exists it is reported `failed`, which ends nothing: a later dispatch's token may yet be taken.
  An earlier version of this slice reported it `failed` throughout and said a later dispatch's run could take the record up; past the copy none can.
- Each command's quiet line says, in whole seconds, how long the token had been held when the command started (`token_age_s`: the install and the sign-in for `plan`, and the plan as well for `execute`), how long each step took (`plan_s`; `replan_s`, `clone_s`, `prepare_s`, `copy_s`, `register_s`, `pr_s` and `settle_s`) and the command itself (`run_s`), so the first production runs can check the allowance against what the steps took.

### The log is public

- In automatic mode the CLI prints only lines of the form `repull-auto: <event> <key>=<value>`, and ends with one result line, `repull-auto: result phase=<phase>`, with `code=<word>` when the run refused or failed.
  What keeps a value out of the log is that every value is chosen by the code, a count, a status or a word from a closed list, never taken from the dataset, the plan, a message or the environment; the grammar only refuses what could not be one of those.
- Every other write of the process is swallowed from the moment the entry point sees the option: the libraries' progress lines, their warnings, a usage error and the exit hint; the notices request, which would carry the NEMAR key, is not made.
  An uncaught exception or an unhandled rejection, which the runtime would print with its message and a source excerpt, ends the run instead, with the fixed lines, and exits 1 whatever happens while it writes them.
  The run ends `failed`, unless the Worker had already stored a terminal report: then the last lines say the report stands (`repull-auto: report-stands phase=<phase>`) and repeat what was stored, which is what the dispatch's record holds and what the backstop, finding the marker, leaves alone.
  Subprocesses print nothing: every git, git-annex and aws child runs with its output piped, which reaches the console only under `--verbose`, and the automatic mode refuses `--verbose` and `--debug` (`auto-verbose`).
- The plan file and the work clones never leave the runner: no artifact is uploaded, `--json`, `--counts` and `--keep-workdir` are refused, and no path, key, file name or subject label is printed.
- The CLI's sign-in prints nothing, on either stream, and takes the key from its environment, not its command line, and the AWS session's request sends its error nowhere, because an explicit deny names the IAM user and the account.
- What a run did in detail is the record's, which administrators read: the re-pull's `last_error` and the dispatch's code.

### The dispatch and its token

- The run reads its dispatch from the event GitHub delivered, and both the workflow and the CLI take exactly the nine keys the Worker's builder writes, `repull_id` absent on a first dispatch, each a string of the shape the Worker checks before it sends one; a dispatch or re-pull id is at most fifteen digits for all three (`DISPATCH_ID_MAX`).
  A tenth key, a missing one, or a value of another type or shape is `dispatch-invalid`: the workflow refuses it before anything is installed, and the CLI reports nothing for it, since nothing in such a payload can be trusted to name the dispatch.
  The workflow's last step reports `failed dispatch-invalid` when the dispatch id, the dataset and the token at least have their shapes, and the Worker stores that report only for a token it signed over a live dispatch, so only the dispatch's own run can end it so.
  No event file at all is the runner's failure (`runner-failed`), not the dispatch's.
- The token is masked by the job's first step, which reads it from the event file and has no environment of its own; each of its lines is masked, so no line of a crafted value becomes a workflow command.
  It is in no environment variable at any level and in no argument: the CLI and the last step read it from the event file.
- A token found on the command line refuses the run (`auto-token-on-argv`), checked before anything that reads a file can refuse instead, and that refusal is reported first, which ends the dispatch and with it the token, since a token in a `run:` line is in the public log.
- The token and the NEMAR key go to the production API only: a `TEST_API_URL` or a stored `apiUrl` that names anything but production (or a loopback address, for the suites) refuses the run before anything is sent (`auto-api-not-production`), and the CLI does not report it, since the report would go there too; the workflow's last step reports it to the production API.
- No `run:` script interpolates an expression; the payload reaches the shell through the job's environment only, after the second step checked it.
- The CLI's report and its probe of the App token refuse a redirect rather than follow it, so neither token is sent wherever an answer points; a report so answered is unanswered, and a probe so answered is not taken as expiry.

### Production only

- The workflow installs exactly the release the dispatch names and refuses any installed version that is not `X.Y.Z` or not that release, so a development build never runs; the CLI refuses itself the same way (`auto-cli-version`).
- The CLI needs `GH_TOKEN`, the App token (`auto-no-app-token`); the Worker refuses an automatic record outside exact production on its own.
- The copy takes short-lived credentials only, as it does on an administrator's machine, so the job exchanges the import's long-lived AWS pair for a six-hour session (`GetSessionToken`) inside the step that runs the CLI, masks it, and writes it nowhere (`runner-credentials` when it cannot).

### The plan the automatic path takes, checked by the run

- `plan` writes the plan file, which stays on the runner, and then refuses a plan that is not executable, with the plan's first refusal, `key-without-pin`, or the word of the first check that is not ok, and one the automatic path does not take, with the create's own words (`auto-planner-version`, `auto-not-clean-plan`, `auto-copy-too-large`) or `auto-copy-too-long`; both exit 3, and no record is written.
  It plans from a listing of the bucket, never the location log, because the log can claim content the bucket never received.
- `execute` checks the LIVE plan it makes before anything is written, never the file's own fields: executable, this planner, `unexplained`, `conflicts` and `corrections` each stated and zero, a copy whose size is known for every key and at most 1 TiB, and one inside the token's hour; it states that size at the automatic create, which bounds it again.
  *Annotated 2026-10-26: `execute` no longer plans again.
  It takes the plan file the run's own `plan` wrote, proved by its digest, its API and its remotes, with the clones, the computed bytes and the digest of the plan that `plan` kept beside it.
  Before anything is written it checks the plan's counts and the token's hour, and it never reads the file's `executable` or `preflight`: the handoff, which `plan` leaves only for a plan it took, stands for them.
  Without a handoff that names the plan's digest it refuses (`not-planned`).
  So the run plans once, and `replan_s` and the second plan in the allowance above are gone.*
- A record that a run takes up past `prepared` must be the automatic path's own, and the dispatch's when the dispatch names one: an administrator's record of the same plan is never taken up (`repull-in-flight`), since the run would push and open its pull request as the App, and a create that answered with such a record, or with another than the dispatch's, is refused the same way (`repull-in-flight`, `repull-mismatch`).
  No live plan can be made past the registration, so its counts are read from the reviewed body.
- `plan` and `execute` refuse a dispatch for another kind of run, another dataset or other tags than the command or the plan file names (`dispatch-mismatch`), before the Worker is asked.

### The settle rule (on "Whether enrichment commits on the release branch move its head")

- Before the run reports its pull request open, it reads the release branch with git, holding the execution's lock, until successful reads have seen the recorded head unchanged for five minutes, or `--settle-minutes` passes (the workflow passes 30), and never past the App token's 55 minutes (above).
- Each move is judged by the head rule execution and resume use, the synthesized commit or an enrichment-shaped descendant of it, and recorded as the `pr_open` self-edge resume writes.
- A move enrichment does not make is `head-foreign`: recorded on the row as the automatic path's error (`[auto:head-foreign]`), the row left at `pr_open`, and the run reported `failed`.
- A read that cannot be made is counted and tried again, never taken as a move, and never taken as quiet: the branch is settled only when a read succeeded in the last five minutes before the settle ended.
  Otherwise, and when the token's hour ended the settle before the branch was seen quiet, the run records `[auto:head-unreadable]` on the row, with the cause in fixed words, and reports `failed head-unreadable`.
  The pull request stays open, and the gates read its head; no automatic run takes a `pr_open` record up again, so an administrator's `resume` is the only way to settle it again.
  An earlier version of this slice said a later run would take such a record up at `pr_open` and settle it; none does.
- A head that moves after the run reported holds the pull request for an administrator's `resume`, because the Worker never accepts a head it did not see recorded.

### The reports, and the backstop

- The run's first command (`plan`, or `resume` for a finish) reports `started`; a rerun of the same run that finds it started (`already-started`) goes on.
- Its last report is `opened` with the record, `finished`, `refused` (nothing was written, a plan the path does not take, or a token GitHub stopped taking after the record was written) or `failed` (a step after the record exists, a foreign or unreadable head, a finish that ended short of `complete`, a token GitHub stopped taking before the record, or a success the Worker did not store), with a word from the closed list, `no-code` for any other.
  A terminal report the Worker stored leaves a marker on the runner.
- The job's last step runs always, and when there is no marker it reports the phase and the word of the run's last result line, `failed runner-failed` when there is none, to the production API's literal address, with the token in curl's configuration on its standard input; a dispatch it cannot name is not reported, and nothing it does fails the job.
- The new words are the run's own: `dispatch-invalid`, `auto-cli-version`, `auto-token-on-argv`, `auto-verbose`, `auto-option`, `finish-incomplete`, `report-unanswered`, `runner-credentials`, `auto-copy-too-long`, `token-expired`, `auto-token-hour`, `auto-token-clock`, `head-unreadable` and `auto-api-not-production`.

### A limit the slice that resumes stalled runs inherits

- A run's plan file and checkpoint do not outlive its runner, so a resume dispatch plans again, and that plan is the record's only while nothing it reads has moved.
  Once a copy has written objects, the bucket listing reads their keys as held, and once the registration has pushed, NEMAR's git-annex branch has moved, so the new plan has another digest and the create answers `repull-in-flight`.
- The stalled-run slice dispatches a resume for a record anywhere from `planned` to `registered`, and the replanned digest decides which of them a resume can take on.
  It still works from `planned`, and from `prepared` while no object has been copied: the preparation's own uploads do not change the plan, which the suites measured with a bucket listing that held them, the resume taking the record on to `pr_open`.
  A record a run left at `prepared` with `[copy:auto-token-hour]` is such a one.
  From `prepared` once the copy has begun, and from `copied` and `registered`, the replanned digest differs, the create answers `repull-in-flight`, which the run reports `refused`, and the stalled-run rule then holds the row `resume-refused` for an administrator, the safe direction.
  An earlier version of this section said the stalled-run slice resumes records from `planned` to `registered`, which reads as if each of them resumes; only the first two do.

### Checked only against stand-ins

- The suites run the real CLI from this checkout with a release version, the real record, dispatch and callback over bun:sqlite, the real `git`, `git-annex` and `aws` against stand-ins of GitHub and S3, and the workflow's own guard scripts under bash.
  An expired token is a stand-in that answers it 401 while a hook turns the registration's push away; the token's hour is a mint time noted minutes in the past; the settle's timing, and its end at the token's hour, run on an injected clock.
- Only the first production runs can show: that GitHub answers the dispatch with 204 and runs this workflow; that the runner masks the token and the AWS session as the workflow asks; that the App token GitHub mints for one repository pushes the release branch and opens the pull request, and how GitHub refuses one past its hour; how long a real copy takes against the estimate; that `GetSessionToken` takes the import's pair and its session copies as the import's own keys do; that Ubuntu's git-annex reads what the planner reads; how soon enrichment commits after a push; and that the plan's anonymous clones of `OpenNeuroDatasets` hold up from a runner, since the App token is never sent there.

## Amendment 2026-10-25 (#1912): Phase 6g replays N.0.1, ends a record by hand, and refuses a mirror's manual major

The last slice of the Phase 6 amendment above, built by Phase 6g.
It builds N.0.1 (decision 1's corrections, replayed after N.0.0 is merged and tagged), the conflict resolutions, abandoning a record and superseding one (decision 3), the manual-major refusal (decision 5) and a mirror rehearsal fixture on staging.
With it, Phase 6's manual execution is complete: an administrator can take a re-pull from its plan to `complete`, or end it.
Nothing here sends mail, adds a route or a migration, or builds any part of the automatic path; fourteen annotations are added to earlier text where this slice builds what it said was a later one's, or where its words were stale.

### N.0.1, as built

`nemar admin repull resume <id>` makes N.0.1 at `released`, once the count of N.0.0's locked objects is recorded.
A plan with no correction and no conflict ends the record `complete`, as before.
A plan that lists conflicts now waits for an administrator's decision before anything is made, because N.0.1's content is fixed once its pull request is open: `--take-ours <path>` resolves one conflict to NEMAR's side, `--take-ours dataset_description.json#<Key>` one key of the description, and `--keep-upstream` leaves every conflict on upstream's side.
This changes the Phase 6f slice's rule, under which a plan with conflicts and no correction completed at `released` without anyone deciding.
Naming some conflicts and not the others still waits: a conflict stays on upstream's side only by `--keep-upstream`, and the run says how many conflicts it resolved and how many it left on upstream's side.
A name that is not a conflict the plan lists (a correction, which is replayed anyway, an explained path, an unknown name, or the description file as a whole) refuses (`take-ours-invalid`) and writes nothing.
A record that does not state both counts stays `released`: unknown is never zero.

N.0.1 is made from the reviewed plan file (`--plan <file>`, else the plan's own default path), which must be the record's plan by its digest (`plan-not-the-record`) and must count the corrections the record counts (`patch-plan-mismatch`: the plan's own count against the record's, which execution copied from that plan, so only a row written by hand trips it).
Its ledger must record no correction, in the plan and on `main` (`patch-ledger`); the plan already refuses any unexplained path otherwise, so this is a second guard that no reachable plan trips.
NEMAR's `main` must be the N.0.0 merge or an enrichment-shaped descendant of it (`main-moved`).

Per path it replays the plan's identity of NEMAR's side, read from NEMAR's `main` as N.0.0 was based on it (the record's `base_sha`, in NEMAR's own history), entry for entry: `absent` is a deletion, `G:<mode>:<oid>` is the blob NEMAR had, and `A:<key>` is the annexed entry NEMAR had, its symlink or its pointer file, byte for byte.
Replaying NEMAR's own entry, rather than writing a new link with `git annex fromkey`, gives the same tree with no working clone, so N.0.1 is made in a bare scratch repository of origin, as resume's other steps are.
An entry the base no longer holds as the plan read it refuses (`patch-ours-moved`), and so does a replayed file where N.0.0 holds a directory, or one under a path N.0.0 holds as a file (`patch-path-conflict`).
So does a replayed path whose entry on the new `main` is not the N.0.0 merge's (`patch-main-moved`): enrichment wrote it after the merge (a `.bidsignore` line, a generated `participants.tsv`), and what enrichment wrote is never undone.
The README family is replayed as a unit: a correction or a resolution of one member takes every member.
`dataset_description.json` is N.0.0's as `main` holds it, after N.0.0's own scrub, with each corrected key and each resolved key set to NEMAR's value (removed where NEMAR had none), `Version` set to N.0.1, written as canonical JSON.
A value the plan records for NEMAR's side that does not parse as JSON, or a key named `__proto__` (which an assignment would not write as a key), refuses (`patch-description-unreadable`).

Nothing is scrubbed and nothing is copied: every replayed byte is in a version NEMAR already published, which ADR 0091 leaves as it is.
So every annexed key N.0.1 replays must already be NEMAR's: in NEMAR's bucket at the size the key declares (a listing, with the ambient AWS credentials), recorded at `nemar-s3` on NEMAR's git-annex branch, and not dead there (`patch-key-absent`, `patch-key-dead`); N.0.1 would otherwise name content nothing serves.
The identifier screen still reads N.0.1's head before its merge (decision 7).

The commit has one parent, the new `main`; the fixed re-pull identity; and as its author and committer dates the N.0.0 merge commit's committer time, read from origin, so the commit is a function of `main`, the base, the plan, the resolutions and the merge, and is made the same every time.
The date is not the record's `updated_at`, which every write to the record moves: a run that pushed the branch and could not record it would then not make the same commit again.
Its message ends with the re-pull's two trailers and `Repull-Patch: corrections=<n>` as its last paragraph.
A `release/v<N.0.1>` an earlier run pushed is reused only when it holds exactly the commit this makes for that commit's own parent, beneath enrichment commits (`branch-foreign` otherwise).
The pull request is opened as N.0.0's is, with the administrator's token and another open release pull request refusing it, its body counts only, and the record goes to `patch_synthesized` with the resolutions counted (`resolutions`).
It asks before it pushes; `--yes` answers.

Then N.0.1 takes N.0.0's steps on its own columns: the screen of its head (`n1`), its gates (`patch_gates_clear`), the merge gate (the claim on the patch columns, so N.0.0's and N.0.1's claims count together in the day's cap; the title `Release v<N.0.1> (#<n>)`; the squash message ending with the trailers and `Repull-Patch:`, and a record that does not state its count of corrections refused at the message, before any claim), `pr-reviews` merging it only through that gate, the merge commit's trailers read back, the tag `v<N.0.1>` and its version row, and the release through the verified route, whose batch re-arms the dataset's sweep stamps.
No lineage is asked for: N.0.1 carries NEMAR's corrections, so its tree is not upstream's.
Instead the tagged tree must be N.0.1's gated head outside `.nemar/**` and `.github/**`, the one check that what was tagged is what was screened and gated: a tree that differs (`patch-tree-mismatch`) or cannot be read leaves the record `patch_merged` with why recorded, and its release is not recorded.

The enrichment window, closed at the merge gate.
Enrichment may move `main` after a pull request's gates, and on two paths outside NEMAR's own: the `.nemar/` line in `.bidsignore` and the placeholder `participants.tsv` of a tree that has none.
The squash would then tag `main`'s tree with the pull request's changes, which outside `.nemar/` and `.github/` is no longer the screened head, and N.0.1's release would refuse it after its DOI was minted, on every run, with its lock never taken, abandon refusing a merged record and the one-open-record rule blocking every later re-pull.
So the merge gate, for N.0.0 and N.0.1 alike and before any claim, refuses a `main` that changed any path outside `.nemar/` and `.github/` since the pull request's base (`merge-main-moved`); with no such change, `main`'s tree plus the pull request's changes is the screened head outside those paths, so that one reading also decides the predicted tree.
The recovery is `nemar admin repull resume <id>`: it takes the record back to its open status (`gates_clear` to `pr_open`, `patch_gates_clear` to `patch_synthesized`) and makes the commit again on the new `main`, pushed with a lease, whose screen and gates then run again; a main moved outside those paths is re-synthesized even when GitHub reports the pull request clean.
When enrichment wrote a path N.0.1 replays, that re-synthesis refuses (`patch-main-moved`) and the way out is to decline N.0.1 with `nemar admin repull abandon <id>`.
What can still reach `patch-tree-mismatch` is a `main` that moved in the seconds between the gate's last reading and GitHub's merge, or a tag that names other content.
Its recovery is named too: read the difference (`git diff <gated head> v<N.0.1> -- . ':!.nemar' ':!.github'`), then run `nemar admin repull resume <id> --accept-tag-tree "<reason>"`, which records the release (its batch re-arms the dataset's sweep stamps, so the identifier sweep reads the published version again, ADR 0088) and goes on to `complete`.
The reason is printed with the release; it is not stored, since the Worker's release route has no field for it, and a tree that could not be read is never accepted.
N.0.1 wrote no object, so it has nothing of its own to lock, and `patch_released` goes on to `complete`.
When `main` moved by enrichment and GitHub reports N.0.1's pull request `dirty` or `behind`, the commit is made again on the new `main`: its own changes applied to the new `main`'s tree, with its message, identity and dates, pushed with the write guard's lease; a path it replays that enrichment changed too refuses (`patch-main-moved`), because what enrichment wrote is never undone.
A re-synthesis a run pushed and could not record is recognized, byte for byte, as N.0.0's is.
N.0.1's pull request found closed without a merge ends the record `patch_declined`.

### Abandon, as built

`nemar admin repull abandon <id>` ends the dataset's open record, on the administrator's machine with their own GitHub token, holding the record's lock.

- Before N.0.0 merges (`planned` to `gates_clear`) the record ends `abandoned`: its pull request is closed and its release branch deleted, when they exist and are this re-pull's, and the objects its copy and uploads wrote are reported.
- Between N.0.0's merge and its release (`merged`) it refuses (`wait-for-release`): the merge minted a DOI, and its release, lineage, sweep stamps and lock are recorded first, by resume, which decision 3 does not say.
- After the release (`released`, `patch_synthesized`, `patch_gates_clear`) the record ends `patch_declined`: only N.0.1's pull request and branch are closed and deleted, when they exist; N.0.0 stays released, and its corrections remain corrections in the next plan.
  A `released` record whose lock is not recorded is refused (`lock-unrecorded`): the Worker lets an edge that gives up skip the lock, and abandon does not use that to leave a released version's objects unlocked; resume locks them first.
- Once N.0.1 merged (`patch_merged`, `patch_released`) it refuses (`wait-for-release`).
- A terminal record is not ended again, so a `failed` record holding a claim or a merge with no tag (the Phase 6f slice's open item) is still not reconciled, and still keeps the dataset blocked.

A merged record is never ended this way.
Before anything is written, every pull request GitHub holds of the release branch is read by its number (the recorded one is read by its number even when the list by branch misses it, and a list of 100 or more, or one that cannot be read, refuses), and one that merged refuses (`pull-request-merged`; resume records the merge); so does a claim to merge that is held (`merge-claim-held`; resume resolves it from GitHub), which the Worker refuses as well.
After each close the pull request is read again, and one found merged then is not ended either.
A release branch is deleted, through the write guard, only when its head is the record's commit or an enrichment-shaped descendant of it (for N.0.1, when it holds this record's N.0.1 commit beneath enrichment); any other head, or one that cannot be judged, is kept, and said, and a release pull request that is not the record's is not closed.
The deletion is leased on the head that was judged (the write guard refuses a deletion without a lease): a branch that moved after it was judged is not deleted (`branch-moved`).
A merged pull request of the branch that is provably not the record's (the record names another number) refuses with its own word (`foreign-pull-request-merged`): that version was released outside the re-pull, which resume does not record, so abandon says so rather than sending the administrator to resume, and ends nothing.

The orphans are the staging manifest's keys that NEMAR's bucket holds at their declared size and that `main`'s current tree does not name, recorded as `orphan_objects` and `orphan_bytes`.
Nothing is deleted, the staging manifest included, and nothing is locked (the Phase 6f slice locks only a released version's own objects).
When they cannot be counted (a record ended before the copy wrote its manifest, which then lists nothing preparation uploaded, or no AWS credentials), nothing is recorded for them and the command says why: unknown is never zero.
The record's working directory, which holds the delta's unscrubbed originals, and its checkpoint are removed.
Abandon ends a record on a dataset that became anonymous or withdrawn, since the Worker exempts an edge that ends a record from the dataset fences, and it ends an automatic record as it ends an administrator's, which is how the Phase 7b slice says an administrator takes one over; it touches no dispatch and no workflow run, and ends the record only (what an unattended run still in flight does with an ended record is the Phase 7d slice's).
A refusal before anything was written exits 1; one after a close or a deletion exits 3, resumable: abandon runs again.

### Supersede, as built

`nemar admin repull execute <plan-file>` now refuses a dataset's open record of another plan before planning anything (`repull-in-flight`, naming the record), unless `--supersede` is given.
With it, the open record must be the administrator's (`supersede-automatic`: an automatic record is taken over by abandoning it, the Phase 7b slice's rule), for another tag than the new plan's (`supersede-same-tag`), pulled from the same `from_tag` (`supersede-from-tag`, decision 3), before its merge (`supersede-too-late`), and holding no claim to merge (`merge-claim-held`, which abandon refuses too), each checked before anything is planned or written, and each refusing with exit 1.
The new plan is proved and made again from live sources first.
Its preflight then finds the open record's own release branch or pull request, so the one refusal tolerated is the `release-pr` check, judged from what that check itself read (nothing is read twice).
At a status at which the old record may have pushed its branch (`registered`, `pr_open`, `gates_clear`), the dataset's release branches must be at most the record's `release/v<N.0.0>` and its open release pull requests at most the record's own; with no pull request recorded (a run that opened it and could not record it), exactly one open pull request of that branch from the dataset's own repository, never a fork's; at an earlier status the record pushed nothing, so any release branch or release pull request refuses; and a list of open pull requests that was not read whole (100 or more, or unreadable) refuses.
A refusal for another release branch names it, so the administrator knows which stale branch to delete by hand.
Any other refusal, plan refusal or unpinned key still refuses (`not-executable`), with the reason the supersede was not tolerated said beside the live preflight, and a plan that went stale refuses (`plan-stale`) with the old record untouched.
Only then, after the confirmation, is the old record ended `superseded` under its own lock, by abandon's own steps, and the new record created.
A branch abandon would keep refuses the supersede before anything is closed (`branch-foreign`), because the new N.0.0 is the same version and pushes the same branch name.

What the old attempt registered stays on NEMAR's git-annex branch, as it stays after abandon: its copies are recorded present, so a new plan counts them held, and the upstream keys its scrub replaced are marked dead.
A new plan whose N.0.0 names such a key at a recording path refuses (`dead-recording-unpinned`), as the Phase 6c slice describes, until the planner pins those keys; an abandoned or superseded attempt that scrubbed a recording can therefore block the next plan of the same snapshot.

### The manual-major refusal, and its limit

`refuseMirrorMajor` (`src/lib/version-policy.ts`) is the rule: a higher major on an `on` id, or on a row recorded as an OpenNeuro import (`source = 'openneuro'`, so an `xx` mirror fixture too), is refused.
On a mirror, a version either side the rule cannot read (empty, `none`, `1.0`, a prerelease) is refused too, since whether it is a major is then not known and unknown is never a pass; the refusal says a version is of the form `X.Y.Z`.
`nemar dataset release` asks it after the new version is settled from `--type major`, `--version`, or the prompt's custom version (its `major` choice is disabled for a mirror), and `nemar dataset update --bump major` after it reads the bump, each before the confirmation and before anything is cloned, branched, changed or pushed; it exits 1 with the plan command to run instead.
The limit: the rule is the CLI's only.
The dataset repositories' `version-check` workflow is not changed, because a workflow edit reaches about 785 repositories at once (ADR 0020), so a major made outside NEMAR's CLI is not stopped, and its version row would record the old `source_version`.

### A mirror rehearsal fixture

Decision 6 re-pulls only `xx` datasets outside production, and no tool made an `xx` row a re-pull would take.
`nemar admin exemplar create <xx> --source <on> --mirror <ds>` makes one: an exemplar whose row records `source = 'openneuro'` and `source_id = <ds>`, the `ds` its `on` source mirrors (any other pair is refused, `exemplar_mirror_mismatch`), the source it was cloned from kept in the audit row and the answer.
Every other rule of an exemplar stands: the route answers 403 in production and for an unknown `ENVIRONMENT`, an anonymous exemplar is refused, and an `xx` publishes only through the exemplar exception.
The copy's own dev-bucket remote takes the name `nemar-s3`, the one remote a re-pull reads, after the inherited production remote is renamed out of its way (`nemar-s3-source`, in the copy's git config and in its `remote.log`) and ignored, so a re-pull of the fixture reads and writes the fixture's own prefix in the dev bucket and never the source's.
A rename that leaves anything still named `nemar-s3`, or a git-annex branch whose `remote.log` cannot be read, refuses before the new remote is configured; the clone step initializes git-annex first, so a missing branch means that step did not run, and the refusal says to run `git annex init`.
The fixture's row sets `source_id` to the `ds` id, which the `/resolve` lookup and the auto-import's duplicate check (migration 0049) also match on; that is harmless while the dev D1 holds only fixtures, and the route answers 403 in production.
Not verified: that the dev bucket answers the plan's anonymous read of its `annex-uuid` marker (if not, the plan's `annex-uuid` check is unchecked and the plan is not executable), and that a rehearsal plan establishes the lineage the fixture's never-examined version rows need at create.

### Checked only against stand-ins

The suites drive the real `resume`, `merge`, `pr-reviews`, `abandon`, `execute`, `plan`, `dataset release` and `dataset update` commands, the real Worker routes over bun:sqlite and the real `git` and `git-annex`; GitHub and S3 are stand-ins, and these are what only the first production runs (and, for the fixture, a staging rehearsal) can check:
that GitHub opens a second release pull request on a repository whose first one merged, and squash-merges it with the message it is sent;
that it lists a branch's pull requests by its `head` filter, closes one and deletes a branch as the stand-in does, and reports a merged pull request's state when it is read by number after a close;
that the dataset workflows tag `v<N.0.1>` and mint its DOI as they do any patch release;
and that the real bucket lists the keys N.0.1 replays as the stand-in does.

## Amendment 2026-10-26 (#1913): Phase 7g merges a machine-clean automatic re-pull, finishes it, and merges over a BIDS failure

A further slice of the Phase 7 amendment above, built by Phase 7g.
It builds decision 7's merge: the Worker's merge of a machine-clean automatic re-pull pull request, what follows a merge whose answer was lost or refused, the finish run that walks a merged re-pull to `complete`, and an administrator's merge of a re-pull they opened over a failed BIDS validation.
Nothing here sends mail, adds a migration or a route, or approves a pull request; the claim to merge gains one field, and a source scan keeps the merge's import closure free of mail.
Eleven annotations are added to earlier text, where this slice builds what it said was later, and where the ruleset check it waited for was run; ADR 0093's header now names the narrowing, and its amendment of 2026-10-23 is annotated as built.

### The ruleset check, as the owner ran it (on "Not yet verified")

- The owner ran the ruleset check on 2026-10-26, with an organization owner's token, and it passed.
- The `nemarDatasets` installation of App 3679074 (installation 131475246) has `contents` and `pull_requests` at write, and `actions`, `administration`, `checks`, `issues` and `workflows` at write too, with `repository_selection: all`.
- `GET orgs/nemarDatasets/rulesets` returned an empty list, so no organization ruleset applies to any dataset repository.
- What it cannot show stays unverified until the first production merge, which runs with `REPULL_DAILY_MERGE_CAP` set to `"1"`: whether the App's own token reads `mergeable_state` as an administrator does, that GitHub merges the App's squash at the `sha` it is sent with the message it is sent, and that the dataset workflows tag that squash and mint its DOI as they tag any merge to `main`.

### The Worker's merge, as built

- The advance tick reads the automatic records past their gates in a third rotation of its own, five a tick, turned every half hour, so neither the open pull requests nor the stalled runs crowd them out, and a record is taken on by the kind its list read it in.
  A record cleared at its gates on one tick is merged on a later one, from facts read then.
- A record at `gates_clear` holding no claim to merge is merged only when, in this order:
  both switches are exactly `"1"`, in exact production (`switch-off`, `merge-switch-off`, before anything is read);
  fewer than three merges were ever sent for it (`merge-exhausted`), and the last one it was sent was not refused (`merge-refused`: another would be refused too, so an administrator looks);
  machine clean holds on facts read now at the merge stage, never the gates' reading, and an unknown fact is never clean;
  its trailers are values the squash message can carry (`merge-message`);
  and the record's own claim, made as the system user, takes a unit of `REPULL_DAILY_MERGE_CAP` in the statement that claims (`cap-exhausted`, `cap-unreadable`, and `pr-unreadable` when GitHub could not answer for the live head; a record that moved while it was read is skipped, for the next tick to read as it is; any other refusal of a clean record is `claim-refused`, which should not happen and is logged at error level).
- Machine clean's `main` rule is the commit the record bases on, exactly, so any move of `main` holds `main-moved`: the administrator's gate refuses only a move outside `.nemar/` and `.github/` (`merge-main-moved`), and the Worker refuses more.
- From Phase 7g every merge gate and the claim refuse a pull request whose head or base repository is not `nemarDatasets/<dataset_id>` (compared without case, a deleted fork's head included), whoever merges; the earlier lists of what the gates and the claim read do not repeat it.
- Then one audit row of the merge (`repull_auto_merge`) is written, in a statement that applies only while the record holds that claim at the revision the claim left and the bound allows, so a merge is never sent without its row and the count never misses one.
- Then one squash merge, `PUT .../pulls/<n>/merge`, with the screened head as `sha`, `merge_method` `squash`, the Worker's own GitHub credential, and the message the administrator's gate writes, its title `Release v<N.0.0> (#<n>)` and its last paragraph the re-pull commit's two trailers.
  The message is built once, in `shared/repull-squash.ts`, for the gate and the Worker alike; the Worker cannot run `git interpret-trailers`, so it checks the two values against the privacy ledger proof's own patterns, and a test proves git reads the message it builds as the trailers.
- The merge is sent once, never retried blind.
  `merged: true` is recorded through the verified route, which reads GitHub again and stores GitHub's merge commit.
  Only GitHub's 405, 409 and 422 are its refusal of the merge, so nothing merged: the claim is kept (the record releases a claim only once it is five minutes old) and the record holds `merge-refused`, which the tick's log line counts at error level (`merge_refused=`); every other answer that is not a 2xx saying `merged: true`, a 401, a 403 or a 429, any other status, a 5xx, no answer, a timeout or a 2xx that does not say it merged, leaves what became of the merge unknown, so the claim is kept and the record holds `claim-held`.
  GitHub's answer is kept in an audit row of its own (`repull_auto_merge_answer`).
- The Worker submits no review, here or anywhere: ADR 0001 requires none, and ADR 0093's sentences that an approval is the administrator's own and that no Worker code path approves stand as written.
- An administrator's record is never merged by the Worker, outside exact production nothing is read, and nothing is ever merged while a switch is off.

### A claim the Worker holds, on a later tick

- A record at `gates_clear` that holds a claim is resolved from GitHub, whatever the switches say, because a merge that happened minted a DOI and must not be stranded; only a merge sent needs the switches.
- Merged at the claimed head, the merge is recorded through the verified route; merged at another head, the record holds `claim-held` for an administrator's `resume`, which records it with its counts.
- A claim is the Worker's when its own claim edge, as the system user, made it; an administrator's claim on an automatic record is theirs, and the Worker neither sends under it nor releases it.
- Not merged, and the last merge sent under the claim was refused: the claim is released through the record's own writer (`refused`, which needs the claim five minutes old and reads GitHub again), so its unit of the day's cap is free, and the record holds `merge-refused`.
- Not merged, and the merge's answer was lost or did not say what became of it, or none was sent under the claim: it is sent again under the same claim, and never a second one, only while the pull request is open at the claimed head, both switches are on, the bound allows, machine clean holds on facts read now, and the claim is younger than 25 minutes, the bound every merge sent again under a held claim obeys, so no merge goes out under a claim `resume` may be expiring at 30.
  On the 30-minute tick a claim is older than that by the next tick, so in production a merge whose answer was lost or did not say what became of it, and that GitHub says did not happen, waits, held `claim-held`, for an administrator's `resume`, which expires the claim; a claim under which nothing was sent is released (`not_sent`) and the record is taken on again from its facts.
- Closed and not merged, the claim is released by the age its answer allows (`refused` or `not_sent` at five minutes, `expired` at 30 for an answer that was lost or did not say what became of it), and the record holds `pr-closed` for an administrator.

### The finish run

- An automatic record at `merged` or `released` is walked to `complete` by the central workflow's finish run (`nemar admin repull resume`, trigger mode `finish`), which reads the merge commit's trailers back, records the release and the lineage, locks the objects the copy wrote and completes the record.
- It is dispatched at `merged` once the version row of N.0.0 has its DOI, in either spelling of the version, and at `released` at once, through the dispatch record's own claim: one live dispatch per dataset, outside the open cap, because the merge already minted the DOI the cap bounds.
- At most three finish dispatches a record, a send GitHub refused for the dispatch itself (404, 422) included and one it turned away for the Worker's credential, permission or rate not, then `finish-exhausted` for an administrator's `resume`.
- It reads no switch, in exact production only: turning the switches off never strands a minted DOI's lineage, lock and `complete`.
  A Worker built from a development version dispatches nothing.

### An administrator's merge over a failed BIDS validation

- `nemar admin repull merge <id> --bids-failure-reason "<text>"` merges a re-pull pull request over a failed BIDS validation, with the reason recorded, under the publication path's text rule (10 to 500 characters).
- It is an administrator's act alone, for a re-pull an administrator opened: the automatic path never merges over a failed check, and its pull request is merged over one by no one, through any NEMAR tool; an administrator merges it once BIDS validation passes, or abandons it and re-pulls by hand.
- It is taken only while GitHub reports the pull request `unstable`, which is a check that is not required failing.
  `blocked` means a rule requires the check, so a merge would be a bypass, which a re-pull never uses: it is refused before anything is written, and so is `clean`, which needs no override.
- Every other check of the gate is unchanged: the record, the dataset, the pull request at the screened head, `main`, the review (one that failed, is running or cannot be read still needs `--force`), the identifier screen for that administrator and the squash message.
- The claim carries the override, and the Worker reads, at the claimed head, that BIDS validation, the App's own run, completed with `failure`, that `version-check` completed with `success`, and that GitHub reports `unstable`, then records the claim and writes the reason in an audit row of its own (`repull_bids_override`) in the claim's batch, which applies only when the claim does.
  A claim that names the override where nothing reads those facts is refused (`bids-override-unverified`), so nothing takes it unchecked.
- A claim already held is never used for it, since the reason belongs to the claim it is made for, and the merge is sent only while GitHub still says `unstable`.

### The kill switch, as it now stands

- `AUTO_REPULL_ENABLED` removed stops new dispatches, gate work, resumes and merges at the next tick, and refuses a run's automatic create.
- A held claim is still resolved from GitHub and a merged re-pull still finished, whatever the switches say.
- `REPULL_DAILY_MERGE_CAP = "0"` stops every merge, the Worker's and the administrators', without touching the switches.

### Words

- Hold words added: `merge-exhausted`, `merge-message` and `claim-refused`; `claim-held`, `merge-refused` and `finish-exhausted`, which earlier slices declared, are written now.
- Refusal words added, for the claim over a failed BIDS validation: `bids-override-automatic`, `bids-override-blocked`, `bids-override-not-unstable`, `bids-override-bids`, `bids-override-version-check` and `bids-override-unverified`.

### What a tick costs

Measured over five rows, the most a tick reads past the gates, and pinned by a test: a row that waits at the merge costs seven D1 statements and four GitHub requests, one that is merged sixteen and seven, and a finish dispatched eight and one; the tick itself two statements.
Five merges on one tick are 82 statements and 35 requests, within the 30-minute tick's shared allowance of 1,000.

### Checked only against stand-ins

The suites run the real record, its claim and its cap, the machine-clean facts and rule, the verified routes, the real `nemar admin repull merge` with the real `git`, `git-annex` and `aws`; GitHub and S3 are stand-ins, and these are what only the first production runs can check:
the App token's reading of `mergeable_state`;
that GitHub merges the App's squash at `sha` with the title and message it is sent, and refuses a head that moved;
that an App's squash merge fires the dataset workflows that tag it and mint its DOI;
that the finish run, once its workflow is deployed with the epic release, records the release and the lock from a runner;
and that an unprotected mirror whose BIDS validation failed reads `unstable`, and not `blocked`, for an administrator's merge over it.

## Amendment 2026-10-26 (#1913): Phase 7h observes the automatic path, and the slices of Phase 7 are complete

The last slice of the Phase 7 amendment above, built by Phase 7h.
It builds what the owner reads while the automatic path runs: the weekly report's section, the administrator's list of dispatches, and `nemar admin repull auto`.
Nothing here adds a migration, a cron trigger or a route that writes, and nothing sends mail: the new service is a root of the source scan that pins the record's import closure.
Three additions are made to earlier text: an annotation on the record's header, one on the opening of the Decision section, and a new last item under "Not yet verified".

### The weekly report's section

- The Monday report gains `## Upstream re-pulls`, after the upstream freshness section.
  It arrives every week (ADR 0054), in a week with nothing to do and the switches off too, where its zeros are true zeros and it says the switches are off.
- It shows the switches and both caps as the Worker reads them, with a cap set to something unreadable said to read 0, the scheduler's last daily tick and what it concluded, and the advance tick's last run.
  "Never recorded" means nothing has stamped the row; a row the report could not find is unknown, and the section says so.
- It counts, over the seven days the report covers, the dispatches sent (by kind, by state and, for the three states that carry one, by word), the merges recorded (below) and the re-pulls that ended `failed`.
  It states, as of the moment the report is made, the open automatic re-pulls with the word each is held for, and the claims to merge still held.
- A dispatch is counted in the week it was sent, in the state it has when the report is made.
  One still running then is counted as running and is not counted again if it later goes unreported; the re-pull it was for is then stalled, and the bound on its resumes is what the report sees next.
- A merge is the edge into `merged` or `patch_merged` from another status.
  The release's step errors write an edge from `merged` to itself (and the same for N.0.1) whenever a tag or a version row is not there yet, and that is not a merge, so an edge that ends where it began is not counted.
- A merge is attributed by its claim, not by the row's origin or by who recorded it: to the user of the latest claim edge in the audit log before that edge, the claim of the pull request that merged (N.0.0's merge takes a `gates_clear` claim edge, N.0.1's a `patch_gates_clear` one, never the other's).
  The system user is the Worker, any other user is an administrator's tool, and a merge whose own audit row says no claim was held (`merged_outside_tool`) is a merge outside NEMAR's tools.
  A claim the audit log does not hold is counted apart, never as the Worker's, so the four counts add up to the merges.
  So an automatic re-pull an administrator merged is the administrator's, and N.0.1's merges count as well as N.0.0's.
- The report is filed on a public-facing repository, so it names no dataset.
  A word is printed only when it is on the closed list it belongs to (the dispatch codes, the hold words, the scheduler's outcomes) and does not name anonymity; any other is counted under `other`, because the tables check only the shape of a word and a dataset id has that shape.
  One function (`publicWord`) decides it, and it runs twice, where the counts are made and again where the report is written, so a fact that holds an identifier where a word should be does not reach the repository by either road.
  The scheduler's two stamps are text columns that check nothing about their content, so the report prints one only in the form SQLite writes a time, and says any other value could not be read.
- The reads are one batch of five statements and one read of the scheduler's row, so the Monday tick spends two D1 calls on them and no GitHub request.
  A read that fails leaves the section's facts null and lists a failed part; the section says unknown and the headline asks for attention, never a zero (ADR 0054).
  A batch that comes back with more or fewer answers than statements, with an answer that did not succeed, or with one that has no rows array, is a read that failed in the same way: a partial week is unknown, never the counts that did arrive.
  An answer whose rows array is empty is not missing: on a grouped read (the dispatches, the holds) it is a true zero, and on a count, which always returns one row, it is a read that failed.

### What asks for attention (ADR 0053)

- A week asks for attention for exactly these, each as a fixed phrase with a count:
  a switch is on and the scheduler's daily tick has not stamped its row for 26 hours (or ever, or the row cannot be read);
  a dispatch nobody answered (`unreported`) or that GitHub did not accept (`dispatch_failed`);
  a claim to merge held, unresolved, for over an hour;
  a re-pull that ended `failed`;
  a re-pull that used all its resumes (`resume-exhausted`) or all its finish runs (`finish-exhausted`);
  and a cap set to something unreadable.
  *Annotated 2026-10-27: the round 1 review of the epic's pull request (#1983) added one reason to this list.
  A switch is on and the scheduler's last tick concluded `waiting-for-manual-run`, which is gate G4 unmet: nothing dispatches until a person runs the two first re-pulls, so a switch turned on early would otherwise change nothing and say nothing.
  It depends on a switch as the first reason does, so with the switch off it is quiet, and the section's closing sentence names it.
  "Only the first reason depends on a switch" below now holds for these two.*
- The scheduler's age is read against the report's own instant.
  A scheduler silent for exactly 26 hours is not yet a reason, and neither is a claim exactly an hour old; one second more is.
  Only the first reason depends on a switch.
  A cap that cannot be read is a fault seen, not silence, and a dispatch, a claim, a failed re-pull or a resume or finish bound reached are there to be looked at, so each asks whatever the switches say.
- Nothing else asks: not a switch that is off, which is a path with nothing to do, not a hold waiting on a gate (the identifier screen, the review, BIDS validation and its checks, `not-clean`), which is the expected state of a path that works and would be an alarm that never clears, not a hold that names a fault the path saw (`gates-refused`, `claim-refused`, `merge-refused` and every other hold word but the two bounds above), which the table of holds counts and `nemar admin repull auto` lists, and not a run's refusal.
  A dispatch that ended `failed` is counted and shown by word, and is not a reason by itself: a re-pull stalled before its pull request opened is resumed within its bound and reaching the bound is the reason, and one that failed after it opened waits, held, for an administrator's `resume`, which the table of holds shows.
- One rule decides the week.
  The Worker decides the phrases, the facts carry them, and the shared attention rule adds them to the headline and to `nemar admin import-weekly`'s exit code, so the issue and the command cannot disagree.
  The field absent, from an older backend, is unknown and a reason of its own, and the command exits 1; the field null with a failed part is exit 2, as the freshness pass is.

### The administrator's list and command

- `GET /admin/repulls/dispatches?dataset=&status=&after=&limit=` lists the dispatches newest first, as a keyset page: `after` continues strictly below an id, a page is 25 rows by default and 50 at most (more is refused at the route and clamped in the service), and a cursor is returned only when the page is full.
  It is registered before `/repulls/:id`, which would answer 400 for "dispatches".
  It names its columns and never selects the row, because a live dispatch's nonce is the secret its run's token is checked against and leaves the Worker nowhere.
  It names the dataset, which the weekly report never does, and it is an administrator's read.
- `GET /admin/repulls/switches` also returns the scheduler's three stamps, never its cursor, which is a dataset id.
  The row absent is null, which is unknown and not "never", and a table that is missing is a 500 that names migration 0111.
  *Annotated 2026-10-26: the migration is now 0112.*
- `nemar admin repull auto [--json]` prints the switches and both caps, the scheduler's stamps, the open automatic re-pulls with their hold words and any claim still held, and the 20 newest dispatches.
  It reads every page of open re-pulls (an administrator's is not listed) up to ten pages, and says when the list stopped before its end; it makes only GET requests; and when a read fails it prints the failure and no table, because a table with a hole would claim what was not read.

### The kill switch, as the runbook states it

- `AUTO_REPULL_ENABLED` removed from `[vars]` in `backend/wrangler-sccn.toml`, in a reviewed change that is deployed (a value set only in the dashboard is dropped by the next deploy), stops new dispatches, gate work, resumes and merges at the next tick, and refuses an in-flight run's create (`auto-repull-off`).
- A run already past its create continues to `pr_open`: stopping it half way would only strand orphan objects.
- The watchdog continues, and so does the finish of a re-pull that already merged, because a minted DOI's lineage, lock and `complete` must not be stranded; a claim to merge the Worker holds is still resolved from GitHub.
- `REPULL_DAILY_OPEN_CAP = "0"` and `REPULL_DAILY_MERGE_CAP = "0"` stop opening and merging without touching the switches; a cap set to something unreadable reads 0, so a typo stops the work too.
  The merge cap stops every merge, the Worker's and the administrators' alike.
- `AUTO_REPULL_MERGE_ENABLED` removed stops the Worker's merges alone: the re-pulls still reach their gates and hold `merge-switch-off`.
- `nemar admin repull auto` shows what the Worker reads of all of this, and the next Monday's report states it.

### Checked only against stand-ins

The suites run the report's own entry point on real SQLite with every migration, the audit rows its merge counts read are written by the production writers, and the same statements run on Miniflare's D1; GitHub, OpenNeuro and the coverage sweep are stand-ins, and the report reads no GitHub.
What only production can show is how the counts read on real data, that every merge's claim is in the audit log as the attribution assumes, and the first week a switch is on.

With it, the slices of Phase 7 are complete: the automatic path is built, off by default, counted every week, listed for an administrator and stopped by removing one switch.
What remains is the owner's act and the epic's release, not another slice: the held workflow pair merged with the epic release, gate G4's two manual re-pulls, and the switches, which the owner turns on in a reviewed change once those are done.
*Annotated 2026-10-27: the workflow pair is not held for the epic release: `nemarDatasets/.github#148` merged and this repository's #1980 compares the copies.
What remains is gate G4's two manual re-pulls, the switches and the epic's release.*

## Amendment 2026-10-26 (#1979): the App is renamed to `nemar-bot`

On 2026-10-26 the NEMAR GitHub App was renamed from `nemar-publish-bot` to `nemar-bot`.
GitHub then reported the App's bot user as `nemar-bot[bot]`, with user id 283755542 and type `Bot` unchanged (`GET /users/nemar-bot%5Bbot%5D`),
the App as slug `nemar-bot`, with id 3679074 unchanged (`GET /apps/nemar-bot`),
and the old login as 404.
`NEMAR_APP_BOT_LOGIN` in `shared/nemar-app.ts` now holds `nemar-bot[bot]`, and both ids stay as they were.

- The lines above that name `nemar-publish-bot[bot]` are dated history and are kept as written: the measurement in the 7a slice of the Phase 7 amendment, and the review queue's label in the Phase 7e amendment, which now names the App `nemar-bot[bot]`.
- The checks compare the id and the login, as stated above: the machine-clean rule, the Worker's start of the App's review and the review's intake by login, numeric id and type, and the review queue's labels by login and numeric id, the stored review's as well as GitHub's record.
  A rename keeps both ids and frees the old login for anyone to register, so a later rename refuses the App's pull requests until the login follows it, and never admits whoever takes the old name.
- The Phase 7e amendment's "Checked only against stand-ins" no longer names the old login: what only the first production runs can check is that GitHub names the author of the App's pull request `nemar-bot[bot]`, id 283755542, type `Bot`.

## Amendment 2026-10-27 (#1914): Phase 8 documents the epic and fixes the website contract

Epic #1046, Phase 8.
Phase 8 adds no behavior to the Worker.
It documents what Phases 2 to 7 built, makes the website read the `mirror` flag, types that flag in the reader of the version listing in the command-line interface (CLI), and records the order in which these reach production.
The decision text above and the earlier amendments are unchanged.
Dated annotations are added to earlier text wherever this amendment builds, corrects or qualifies it; each begins "Annotated 2026-10-27".

### Where the documentation is

The pages were written from the merged epic head `1abf9286` and checked against its code, and each pull request named below carries its checks.
`nemar admin repull <command> --help` is the authority for flags, and the runbooks say what to do with them.

- Public pages, in `nemarOrg/docs` (`nemarOrg/docs#90`):
  `platform/doi-and-versioning`, the section "Versions of an OpenNeuro mirror" (the version rule, the separate numberings of NEMAR and OpenNeuro, what a reader can rely on);
  `platform/data-api`, the section "The `mirror` flag" (`#the-mirror-flag`);
  `platform/api`, the fields of `GET /datasets/:id/versions`;
  `cli/guides/versioning`, the Major bullet and the section "OpenNeuro Mirrors" (the CLI's refusal of a manual major, and its limit);
  and one sentence and a link in `why-nemar`.
- Gated pages, in `nemarOrg/docs` under `admin/operations/` (`nemarOrg/docs#92`):
  `upstream-freshness` (the staleness report, the backfill, the Monday section),
  `upstream-repull` (the manual path, the canary, the first two re-pulls, the staging rehearsal)
  and `upstream-repull-automatic` (the switches and caps, what runs, machine clean, the kill switch, the owner's steps).
  The same pull request edits `admin/index`, `identifier-screening`, `pr-reviews`, `systems-inventory` and `staging-environment`, regenerates `admin/commands`, and lists the three pages and their `.md` mirrors in `GATED_PAGES` of `scripts/probe-admin-gate.ts`.
- The website, in `nemarOrg/website` on `staging` (`nemarOrg/website#489`):
  `listMirrorVersions` in `src/lib/provenance.ts` lists only the versions whose `mirror` is `true` as soon as any version of a listing carries the key, and keeps the old rule (a version of the form `vN.0.0`) for a payload with no key at all.

### The `mirror` field, as a reader sees it

- The flag is three-valued, derived at read time and never stored (`mirrorFlagOf`, `shared/source-snapshot.ts`).
  `true` is an N.0.0 of an `on` dataset whose upstream tag is recorded, `false` is every other dataset and every other version, and `null` is an N.0.0 of an `on` dataset whose tag is unknown or was never examined.
  A consumer shows `null` without a mirror marker and never as a mirror.
  Only an id of the form `on` plus six digits is ever `true` or `null`, so an `xx` mirror fixture reads `false`; the CLI's refusal of a manual major is wider, because it also covers a row recorded as an OpenNeuro import.
- The public wire carries the flag and nothing of the tag.
  A landing entry has exactly `version`, `doi`, `created_at`, `mirror`, `manifest_url` and `browse_url`, in `GET /<id>` as JavaScript Object Notation (JSON) and in `landing.data.versions` of the page bundle (`backend/test/landing-mirror-flag.test.ts`, `backend/test/page-bundle-mirror-flag.test.ts`).
  `metadata.json` is unchanged: its `extensions.nemar.versions` entries keep `version`, `doi`, `created_at` and `manifest_url` (the mapping in `backend/src/services/data-router.ts`, pinned by `test/data-route.unit.test.ts`).
- `GET /datasets/:id/versions` also carries `source_version` and `source_version_basis`.
  It is open to the dataset's owner, its collaborators and administrators (`backend/src/routes/datasets/manifests.ts`), which corrects the Phase 4b amendment's "owner-or-admin route".
- A Worker that predates the release omits the key, and a reader takes an absent key as not stated, never as `false`.
- The CLI's reader of the listing types the field.
  `dataPlaneVersionListingSchema` in `shared/contract/data-plane.ts` takes `mirror` as an optional boolean that may be `null` and still passes every other key through, so a producer that sent any other value fails the CLI's read of a listing instead of having it passed on.
- No parity file between this repository and the website holds the field.
  The producer's tests and the website's three recorded payloads (`test/fixtures/landing-mirror-flag-*.json` in `nemarOrg/website`, recorded from the real data-plane route) cover it, and the epic changes none of the contract files the website's drift tests compare.

### The order the pieces reach production

- The documentation follows the release.
  The docs deploy on merge, so a page merged first describes commands and a field the deployed Application Programming Interface (API) lacks.
  `nemarOrg/docs#90` and `nemarOrg/docs#92` were merged on 2026-10-27, before the release.
  `test/docs-links.unit.test.ts` fails a link in this repository to a page that is not on `main` of `nemarOrg/docs`, when it reads a fresh docs checkout, which continuous integration (CI) supplies (`NEMAR_DOCS_CHECKOUT` in `.github/workflows/test.yml`).
- The website's fallback is deleted only after `nemar admin upstream-backfill --execute` has run in production and `mirror` reads `true` for the mirrors the backfill could establish.
  Until then an `on` N.0.0 whose snapshot is not recorded reads `null` and has no chip, so deleting the fallback early takes the chip from every mirror.
  The fallback covers only a payload with no key; once production sends the key, a `null` has no chip with or without it, so the website is promoted after the backfill and not between the release and the backfill (`nemarOrg/website#489`).

### The workflow pairs

Two workflows are authored here and copied into `nemarDatasets/.github`, per Architecture Decision Record (ADR) 0020, the copy there first.

- `onboard-openneuro.yml` takes the optional input `openneuro_tag` (Phase 3): `nemarDatasets/.github#144`, then this repository's #1933, which shipped in 0.10.24 (`CHANGELOG.md`).
- `run-upstream-repull.yml` (Phase 7d), authored at `.github/dataset-workflows/run-upstream-repull.yml`:
  `nemarDatasets/.github#148`, then this repository's #1980, which makes the `unit-pure` tier compare the two copies byte for byte (`NEMAR_REPULL_WORKFLOW_LIVE` in `.github/workflows/test.yml`, `test/repull-workflow.test.ts`).
  The workflow runs only on a `repository_dispatch` of the type `run-upstream-repull`, which only the automatic path sends, and the automatic path is off until the owner turns its switch on; neither merge turns anything on.

### The relation on a re-pull's Digital Object Identifier (DOI)

This clarifies decision 2, which says the version DOI of a re-pull carries `IsDerivedFrom` `openneuro.<ds>.v<to_tag>`, because the mint reads `SourceDatasets` at the tag.
That describes one of two sources of related identifiers, and no re-pull's record has been observed yet.
The DataCite builder turns each `SourceDatasets` DOI into `IsDerivedFrom` (`backend/src/services/datacite.ts`, the loop over the `SourceDatasets` entries).
The importer also seeds `.nemar/metadata.json` with the snapshot's DOI as `IsIdenticalTo` (`seedMetadata` in `src/lib/import-openneuro.ts`).
The builder carries that file's related identifiers into the record, and its de-duplication is by identifier and relation together, so one DOI can appear under both relations.
A re-pull rewrites both to the new tag's DOI: the `SourceDatasets` entry (`src/lib/repull/description.ts`) and the `IsIdenticalTo` identifier (`rewriteIsIdenticalTo` in `src/lib/repull/execute/materialize.ts`).
The record of an import published before the epic shows the second source alone.
DataCite's record for `10.82901/nemar.on005506.v1.0.0`, read on 2026-10-27, lists `IsIdenticalTo` `10.18112/openneuro.ds005506.v1.0.1` and no `IsDerivedFrom`, because that version's description has no `SourceDatasets` entry (`nemarOrg/docs#90`).
Which relation a re-pull's record carries, one or both, is therefore read from the first real N.0.0 DOI, which the owner's first two re-pulls produce.
Until then the public page says only that the DOI record lists the OpenNeuro snapshot's DOI among its related identifiers, and the runbook tells the owner to read what the record shows (`upstream-repull`, "The first two re-pulls").
Decision 2's sentence stays as the design's expectation.

### Not yet verified

Phase 8 moves nothing to verified.
Its checks read the code at `1abf9286` and a few public records, and it ran no re-pull, no canary and no Worker merge.
Two items of the "Not yet verified" list near the top of this record are closed by earlier amendments: where `source_version` is inserted (the Phase 2 amendment), and the ruleset half of the App's merge (the Phase 7g amendment).
The Phase 7e amendment corrects the item about the review.
These remain, grouped by what shows them.
The "Checked only against stand-ins" section of each earlier amendment holds the same items in its own words, and this list holds all of them.

- The canary (`scripts/repull-canary.ts`) and the first copy:
  - That a signed cross-account `copy-object` and `upload-part-copy` of a public versioned object honor `?versionId=` and `--copy-source-if-match` and name the copied version (the first canary run, 2026-10-29, found that the single `copy-object` also needs `--tagging-directive REPLACE`), that upstream's bucket answers from `us-east-1`, and whether NEMAR's bucket locks a copy by default retention (Phase 6d).
  - That a multipart copy over 5 GiB in 4 GiB parts, and the CLI's retries and its ten-minute bound per copy call, behave as they do against the stand-in (Phase 6d).
  - That `aws s3 sync` and `list-objects-v2` answer the uploads as the stand-in does (Phase 6c), that the real bucket answers HEAD, PutObjectRetention and GetObjectRetention on a copied object's version as the stand-in does, including what it answers a credential without the lock permission (Phase 6f), and that it lists the keys N.0.1 replays as the stand-in does (Phase 6g).
  - An anonymous ranged GET of `openneuro.org` at `?versionId=` was measured once, for one object of `ds004362`, while Phase 6 was planned (Phase 6c).
- The first two re-pulls by hand:
  - Whether the standard edits are recognized on the early rewritten imports `on003645` and `on004362`, and what their plans count as unexplained paths: the owner's review of their dry-run plans.
  - Which relation the first re-pull's DOI record carries (above).
  - That the new major's DOI resolves and the previous version still serves, which the owner reads before turning a switch on (gate G4; the Phase 7c amendment).
  - Whether OpenNeuro writes Simple Storage Service (S3) before it pushes to GitHub, whether the object at a path lags the pinned `versionId`, and that upstream's `.log.rmet` records a `versionId` per key.
  - What GitHub answers to the reads the release and the merge make: the tag's commit, the comparison words, a squash-merged pull request's `head` and `merge_commit_sha` (Phase 6e), the `mergeable_state` words for a re-pull pull request, how soon its `head.sha` follows a push, and whether a leased forced push to a release branch of a dataset repository is accepted (Phase 6f).
  - How GitHub opens and lists a pull request, the head's repository and the answer to a second one on the same branch included (Phase 6d), and lists open pull requests as the release-pr check reads them (Phase 6c).
  - That GitHub opens a second release pull request on a repository whose first one merged and squash-merges it with the message it is sent, lists a branch's pull requests by its `head` filter, closes one, deletes a branch, and reports a merged pull request's state when it is read by number after a close (Phase 6g).
  - That the dataset workflows tag the squash merge of a re-pull as they tag other merges to `main` (Phase 6f), and tag `v<N.0.1>` and mint its DOI as they do any patch release (Phase 6g).
  - Whether the central `run-identifier-screen` workflow posts a re-pull screen's report to its callback (Phase 6e).
  - On a staging rehearsal, that the dev bucket answers the plan's anonymous read of its `annex-uuid` marker, and that a rehearsal plan establishes the lineage the fixture's never-examined version rows need at create (Phase 6g).
- The first unattended run:
  - That GitHub answers the dispatch with 204 and runs the workflow, that the runner masks the token and the Amazon Web Services (AWS) session as the workflow asks, that the App token GitHub mints for one repository pushes the release branch and opens the pull request, and how GitHub refuses one past its hour (Phases 7c and 7d).
  - How long a real copy takes against the estimate, that `GetSessionToken` takes the import's pair and its session copies as the import's own keys do, that Ubuntu's git-annex reads what the planner reads, and that the plan's anonymous clones of `OpenNeuroDatasets` hold up from a runner, since the App token is never sent there (Phase 7d).
  - Whether the installation token is accepted for the raw files of `OpenNeuroDatasets`; if it is not, every probe reads `stale_unverified` (Phase 7c).
  - That a run reaches the callback at the API host and that the token survives the dispatch payload and the run's environment unchanged (Phase 7b), that a resumed run takes up the record its dispatch names (Phase 7f), and that a 5xx can follow a queued event, which is assumed in the safe direction (Phase 7c).
  - How soon enrichment commits to a release branch after a push, which the settle rule of the Phase 7d amendment records and only production shows.
  - That the finish run records the release and the lock from a runner (Phase 7g).
  - That the first automatic run works through the plan handoff, where `execute` takes the plan file the run's `plan` step wrote and proves it by its digest, and through the dispatch word list cut to 57 words (the epic cleanup, #1976, and the annotations of 2026-10-26 on the Phase 7d and 7b amendments).
- The first Worker merge, which runs with `REPULL_DAILY_MERGE_CAP` set to `"1"`:
  - Whether the App's own token reads `mergeable_state` as an administrator does, that GitHub merges the App's squash at the screened head with the message it is sent and refuses a head that moved, and that the dataset workflows tag that squash and mint its DOI as they tag any merge to `main` (Phases 7a, 7e and 7g).
  - That GitHub names the author of the App's pull request `nemar-bot[bot]`, id 283755542, type `Bot` (the Phase 7e amendment, as the rename amendment restates it), that `check-runs` honors its filters on a mirror as it did on `nm000527`, that the screen and the review start on the App's pull request and the review's check and comment are published on it, and that the review workflow claims and reports on a pull request a bot opened (Phases 7e and 7f).
    *Annotated 2026-10-29: the review half of this item is moot since [ADR 0117](0117-an-upstream-re-pulls-own-pull-request-is-waived-from-the-review-by-nemars-record.md): no review starts on the App's pull request, and the first run checks instead that its waived check is published and GitHub then reports it `clean`.*
  - That GitHub answers a send it refuses for the Worker's credential or rate with a status other than 404 and 422, and that the tick's real cost on the 30-minute tick is the one measured (Phase 7f).
  - That an unprotected mirror whose Brain Imaging Data Structure (BIDS) validation failed reads `unstable`, and not `blocked`, for an administrator's merge over it (Phase 7g).
  - Whether ADR 0107's review can ever pass a re-pull diff.
    The App's pull request is reviewed now, but ADR 0109 fails a changed `CHANGES` line and holds a replaced recording, both normal in a re-pull; until one passes, no re-pull is machine clean and an administrator merges each.
    *Annotated 2026-10-29: moot since [ADR 0117](0117-an-upstream-re-pulls-own-pull-request-is-waived-from-the-review-by-nemars-record.md): the review of a re-pull's own pull request is waived at its recorded head, and machine clean no longer needs a pass.*
- The release and the first weeks:
  - What the weekly report's re-pull section reads on production data, that every merge's claim is in the audit log as the attribution assumes, and the first week a switch is on (Phase 7h).
  - That the `mirror` field reaches production as the pages say.
    After the release, `curl -s -H 'Accept: application/json' https://data.nemar.org/<id>/ | jq '[.versions[].mirror]'` shows it on a mirror, and `null` is expected until the backfill has run.

### Left open for the owner, unchanged

- A `failed` record that holds a claim to merge, or a merge with no tag, is reconciled by nothing and keeps its dataset blocked until an administrator resolves it by hand (the Phase 6f amendment, annotated by the Phase 6g amendment).
- A mirror whose last three dispatches all ended `unreported` is skipped by the scheduler, nothing clears that streak, and the mirror stays on the administrator's path (the Phase 7c amendment).

## Amendment 2026-10-27 (#1983 review): the BIDS override is reached through resume, and the mirrored tag reads both spellings

The first review of the epic's pull request into `dev` (#1983) found two rules of this record that the code did not reach.
This amendment says what changed and why.
The decision text above is unchanged.
Earlier text is annotated, in a note that begins "Annotated 2026-10-27", where this amendment corrects it.

### An administrator's merge over a failed BIDS validation is reached through `resume`

- What was wrong.
  `resume` recorded the gates only when GitHub reported the pull request `clean`.
  A failed BIDS validation that no rule requires makes GitHub report `unstable`, so `resume` waited and exited 3, and `nemar admin repull merge --bids-failure-reason` refused, because the merge is taken only from `gates_clear`.
  The merge the Phase 7g amendment built could not be reached in the normal order.
  Its tests recorded the gates while the GitHub stand-in said `clean` and then turned it `unstable`.
- What `resume` records now.
  On a record an administrator opened, `resume` also records the gates when GitHub reports `unstable` and BIDS validation is the one check that fails at the head:
  BIDS validation, the App's own latest run, completed with `failure`;
  `version-check`, the App's own latest run, completed with `success`;
  every other check run, taken as the latest run of each name and App, completed with `success`, `neutral` or `skipped`, the conclusions GitHub counts as passing;
  and every commit status is `success`.
  A check still running is not passing yet.
  `resume` reads every check run and every commit status of the head with the administrator's own token, two reads, and a read that fails or an answer it cannot read waits: unknown is never a failure of BIDS validation alone.
  It says when the gates were recorded over a failed validation, and its last line names the merge with `--bids-failure-reason`.
- One rule, in `shared/repull-bids-override.ts`.
  The facts every reader has, the record's origin, GitHub's state and the App's two runs, are `bidsOverrideFault`, which the Worker's claim to merge (`bidsOverrideRefusal`) now asks too, with its refusal words unchanged.
  The App's latest run of a name is read by `checkFactOf`, which the Worker's reader of the two checks now uses as well.
  The check names are declared once, in `shared/dataset-checks.ts`, which `deriveContexts` reads for the rulesets.
- The merge gate reads the rest of the rule before the claim.
  With `--bids-failure-reason` it refuses, before anything is written, a head where any other check run or commit status does not pass, so the reason covers BIDS validation and no other check.
  That BIDS validation failed and `version-check` passed is still the claim's to read, in its own words.
  The Worker's claim reads only the App's two runs, as before: that nothing else fails is the administrator's gate's to read, as `clean` is for an ordinary merge.
- Everything else still requires `clean`.
  An automatic record is never gated on `unstable`, by `resume` or by the advance tick, and the Worker's merge holds a failed BIDS validation as `bids-failed` and an `unstable` head as `not-clean`.
  A merge without the reason refuses `unstable`, and `nemar admin pr-reviews`, which has no override, refuses it too.
- Verified on 2026-10-27 against `nemarDatasets/on004362`, pull request #1 at head `c06fa1cf`, with read-only calls.
  The repository's `main` has no branch protection (`GET .../branches/main/protection` answered 404, "Branch not protected"), and its one ruleset is the tag ruleset "Protect version tags", so no check is required on the branch.
  GitHub reports the pull request `unstable` (`mergeable_state` in REST, `mergeStateStatus` `UNSTABLE` in GraphQL), and its one failing check is "NEMAR PR Review", which nothing requires there: a check that is not required and fails reads `unstable`, the state this rule rests on.
  The check runs at the head are named exactly `version-check`, `Run BIDS Validation` and `NEMAR PR Review`, the first two being the names `shared/dataset-checks.ts` declares, and each is posted by App 3679074 (`nemar-bot`).
  The unfiltered check-runs answer carries `total_count` and `check_runs[]`, each run with `id`, `name`, `status`, `conclusion`, `head_sha` and `app.id`, the fields `checkFactOf` and `othersNotPassing` read.
  The combined status answers `state` `pending` with `total_count` 0 and an empty `statuses[]`, which the rule reads as no status at all, never as a pending one.
  Run on those two answers, the rule reads BIDS validation and `version-check` as passed and "NEMAR PR Review" as the check that fails, so that head is not BIDS validation's failure alone, and `resume` would wait on it.
- Still unverified: a live pull request on an unprotected dataset repository whose BIDS validation failed, read as `unstable` and not `blocked`, which the Phase 8 amendment lists too.
  A check run again is read by its latest run, the highest id of its name and App, whatever `filter=latest` leaves out, so the rule does not depend on that filter.

### The mirrored tag reads both spellings of a version

- What was wrong.
  `mirroredTagOf`, the derivation of decision 4, matched only a version row spelled `N.N.N`, while D1 holds `1.0.0` and `v1.0.0` (`shared/contract/version.ts`): the version-DOI callback strips the `v` before it writes, but older rows and other writers can carry it, the admin manifest route among them, which writes the version as its path names it.
  A mirror whose rows carry the `v` read as unpublished in the staleness report, so it was never compared or dispatched, and a newer row spelled `v` lost to an older bare one.
  The create check (`versionFactsProblem`) and the release already read both spellings.
- What it reads now.
  Decision 4's highest version row is found in both spellings and by number, and the version comes back bare.
  The rows of one version in the two spellings are read together, because both name the tag `v<N.N.N>`:
  a row never examined says nothing against one that was;
  the tag is known when every examined row names it, with `lineage` only when each of them says `lineage`;
  and two rows that disagree are `unknown`, never one of them picked.
  The staleness report dates such a version by its earliest row, for "probably stale".
  There is no migration, and no recorded value is rewritten.
- The backfill examines both spellings too.
  The Phase 2 amendment's "Only a version of the form N.N.N is a candidate" no longer holds: a row spelled `vN.N.N` is a candidate, read as `mirroredTagOf` reads it (one lowercase `v`, then `N.N.N`), so a row the staleness report calls never examined is one `nemar admin upstream-backfill` examines.
  The ref is still the canonical tag `v<N.N.N>`, never `vv1.0.0`.
  The rows of one version in both spellings are read once and each recorded from that read, the write stays on the row's own spelling, and the cursor carries that spelling, which the route takes back.
  Any other spelling, `vv1.0.0` and `V1.0.0` among them, is still never a candidate.

## Amendment 2026-10-29 (#1996): a merge made outside the gate is accepted on evidence, and the ledger names it

The first production re-pull of a mirror was merged with GitHub's own merge button instead of NEMAR's gate.
Its squash commit carries GitHub's one-line message and none of the re-pull's trailers, the tag was pushed on it, and the record stopped at `merged` with `merge-trailers`, as the Phase 6f amendment built it to.
That amendment left what follows to "an administrator", with no command to do it, and a merge outside the gate will happen again.
This amendment builds the way past it and says why it takes the shape it does.
The decision text above is unchanged.
Earlier text is annotated, in a note that begins "Annotated 2026-10-29", where this amendment changes what it says.

### What was wrong

- The privacy ledger's fresh-clone proof (ADR 0085, `ledger-commit-not-alone`) accepts a commit that appends a `repull-scrubbed` line beside other files only when the commit carries both trailers as git reads them (the Phase 6b amendment).
  A squash merge made outside the gate does not, so the dataset fails the proof for good, and the release refuses it (`merge-trailers`) so as not to complete a record over a dataset that fails it.
- Rewriting `main` to put the trailers back is not a repair: the tag, the version DOI it may have minted and every public clone name the commit.
- Nothing else in the record or the repository could say that the merge is the re-pull's own, so the record had no way to finish, and its open row blocked every later re-pull of the dataset.

### The acceptance is earned by evidence

- `nemar admin repull resume <id> --accept-merge-trailers "<reason>"` accepts the merge, with a reason of 10 to 500 characters, the publication path's rule that `--acknowledge-identifier-screen` and `--accept-tag-tree` take.
- The release waits for the tag and the version row first, as for any merge, so NEMAR's ledger line never lands on `main` before the dataset workflow tags the merge.
- The reason is never enough.
  Before anything is sent, `resume` reads, with the administrator's own GitHub token and from NEMAR's origin, in this order: the record is one an administrator opened (`accept-automatic`); its pull request on GitHub is merged, from the record's release branch into `main` of the dataset's own repository, with the record's merge commit (`pr-foreign`, `merge-mismatch`); the merge commit has one parent (`merge-not-squash`; *Annotated 2026-11-09: or two, the second the merged head, `merge-second-parent-foreign`, by the amendment of that date*), which is the record's base or an enrichment-shaped descendant of it (`merge-parent-foreign`, by the same `enrichmentOnlySince` the rest of the re-pull reads `main` with); the merged head is the recorded head or an enrichment-shaped descendant of it (`merge-head-foreign`); the merge's tree is the record's commit outside `.nemar/**` and `.github/**` (`merge-tree-mismatch`), by the very comparison the release makes for the tag (`tagTreeVersus`), N.0.0's synthesized commit and N.0.1's gated head; and the merge changed the privacy ledger by appending a scrub's lines only, or not at all (`merge-ledger-foreign`).
  It prints what it verified, line by line, before it asks the Worker.
- Then the Worker reads all of it again, on GitHub, with its own credential, before it records anything, through `POST /admin/repulls/:id/merge-trailers/accept`: the record at `merged` or `patch_merged` with the named merge commit, opened by an administrator and by this administrator (`accept-not-yours`, which only the Worker can check); the pull request through `readRecordedPullRequest` (its own word for another branch or repository is `pull-request-mismatch`, as at the verified merge); the merged head (`merge-head-foreign`); the merge commit's one parent (*Annotated 2026-11-09: or its first of two*) and its root tree, compared with the recorded tree by the top-level entries outside `.nemar` and `.github`, whose equal object ids are equal contents; and the ledger at the merge and at its parent through the Contents API.
  Before it records anything it also checks that, when the proof needs the line, the merge's `repull-scrubbed` line names a `scanner` a ledger line can carry (`merge-ledger-foreign`, so a stored acceptance can always build its line); that `main` still holds the merge, by GitHub's comparison of the merge with `main` (`merge-not-on-main`); and that `main`'s ledger exists (`ledger-missing-on-main`) and names the merge in no line yet, since NEMAR writes only after it records (`attestation-conflict`).
  The Worker reads "moved by enrichment only" from GitHub's comparison, which names paths: every path a file under `.nemar/` other than the ledger, `.bidsignore` or the root `participants.tsv`, added or modified, in at most 20 commits, and fewer than the 300 files GitHub lists.
  That is a weaker reading than the CLI's, which reads each commit's content.
  Both must pass through `resume`; the route itself is an administrator's, and a direct call to it gets the Worker's reading alone, against the record's own `synth_tree`, `head_sha` and `base_sha`.
  That is the trust boundary: the Worker does not take the caller's word for anything it can read on GitHub, and it relies on the record for what the record already says.
- One rule for exit codes, on a first acceptance and on every later run alike: a refusal on the evidence, or on what `main` holds, writes nothing, not even the step's error, and exits 1, because running again does not change it; a GitHub or a NEMAR API that could not be read, or a line not yet written or not yet seen on `main`, exits 3.
- The acceptance is recorded once, with its reason, the administrator and the time, in `upstream_repull_merge_acceptances` (migration 0113, keyed by the record and the pull request) and in an audit row (`repull_merge_trailers_accepted`).
  A later `resume` finds it and goes on with no flag; a second acceptance of the same merge is a replay, and of another merge is refused.
- After it, `resume` goes on exactly as for a gated merge: the lineage for N.0.0, the sweep stamps, the lock of the objects the copy wrote, N.0.1 or `complete`.
  The output says what this run verified, what the Worker read, and what was accepted, with the reason; a later run says plainly that the merge was accepted earlier, by whom, when and on what reason.
  A run given the flag that does not reach a merge's release, whether it ends normally or stops on a refusal, says the flag changed nothing.
- The automatic path is not widened: an automatic record is refused (`accept-automatic`) by the CLI and by the Worker, and a dispatched finish refuses the flag, because the Worker writes the automatic path's merges with the trailers, and an automatic record merged outside the gate is an administrator's to look at, not to accept.

### The evidence a fresh clone reads is one ledger line, written by NEMAR

The choice this amendment had to make is where the proof finds that one trailer-less commit is accepted, so that a fresh clone with no database can tell, and nothing else is loosened.
It is one line in the privacy ledger itself, `repull-merge-accepted`, appended to `.nemar/corrections.jsonl` on `main` in a commit of its own, after the merge, by NEMAR's Worker.
The line names the accepted merge commit by its full id (`commit`) and the record's plan digest (`plan`), carries the version as a tag, empty counts, the `scanner` of the `repull-scrubbed` line the merge appended, the verification `squash-merge-verified` (*Annotated 2026-11-09: for a plain merge commit too*), and the re-pull's fixed actor `nemar-repull`, and nothing else (`shared/repull-merge-acceptance.ts`).

Why the ledger, and not the other places a fact could live:

- **A git note or another ref.** A clone does not fetch notes or a ref outside `refs/heads` and `refs/tags` unless asked, so a fresh clone would not see it, and the proof would have to know to ask.
  A ref is also moved or deleted by anyone with push access, carries no history, and has nothing like the ledger's validation.
- **A file of its own under `.nemar/`.** A fresh clone sees it, but it would be a second record beside the ledger with none of the ledger's rules: no closed vocabulary, no validation at every tip, no word that the ledger's command line refuses to type, and nothing that keeps it append-only.
  The ledger already is the record of what NEMAR did to a dataset, and this is one more thing NEMAR did.
- **An allowlist handed to the proof from NEMAR's database.** The proof is the one check of a dataset's history that needs no database, and it runs where the database is not reachable; a list from it would make the proof's answer depend on a row a fresh clone cannot see.
- **The reason in the line.** The reason is free text an administrator types, and the ledger refuses free text by design (ADR 0085, ADR 0036): a line in a public repository is the one place a value must never reach.
  The reason stays in NEMAR's database and in the audit row.
- **A line that names the scrub line it vouches for, rather than the commit.** It would survive a history rewrite, since the ledger's text does, but an identical line appended in a second commit would be vouched for too.
  A full commit id vouches for exactly one commit.

The proof's rule (`ledgerChecks` in `scripts/scrub/git/git-lib.ts`), as amended:

- A commit that touches the ledger and other files, appends scrub lines only, edits no line before them, appends a `repull-scrubbed` line, and does not carry both trailers, is accepted only when the ledger at a branch tip (`refs/heads/`, `refs/remotes/`, the tips `ledger-invalid` reads) holds a valid `repull-merge-accepted` line naming it in full, and the commit is in that tip's first-parent history.
  A tag never vouches: it is pushed on the merge, before NEMAR can name it.
- Every commit an acceptance line names must be vouched for by some branch tip, its line there and the commit a re-pull's merge in that tip's first-parent history, or the proof fails with a reason of its own, `ledger-acceptance-unmatched`, counted once per named commit whichever tips carry the line: a forged or an unrelated id, a commit every tip that names it reaches only through a merge's second parent, a commit that appends no `repull-scrubbed` line, one that touches only the ledger.
  So a line never widens the rule for any commit but the one it names, and a missing line leaves that commit `ledger-commit-not-alone`, as before.
- Two readings are deliberate.
  A line naming a re-pull's merge that does carry its trailers, as the proof reads them, is matched: that commit passes on its own, so the line changes nothing.
  The Worker cannot read trailers as git does, and `resume` holds a merge to its record's own trailer values, stricter than the proof's patterns, so a merge whose trailers carry other values is accepted, and the line written for it must not fail the proof.
  And a named commit is counted unmatched once, whichever tips carry its line, and only when no tip vouches for it; this keeps a branch that brought `main` in through a second parent (GitHub's "Update branch") from being counted a second time for `main`'s line, but such a branch still fails the proof, on its own merge commit, which appends the scrub's line and the acceptance beside the merge's files (`ledger-commit-not-alone`, as before); the scrub runbook deletes merged branches before the clone.
- The line is validated like every other (`ledger-invalid`): `commit` must be 40 lowercase hex digits and `plan` a `sha256:` digest, both present on this word and on no other, with exactly one version and the verification `squash-merge-verified`, which no other word may carry; a tip whose ledger does not validate vouches for nothing.
- The commit that carries the line must touch the ledger only: written beside another file, it is a ledger commit that is not alone.
- `verify: ok` says `ledgerAcceptances=N`, the merges without their trailers a line vouched for, when there is one; a line naming a merge that carries its trailers is matched and not counted there.
- What the proof does not prove, as for the scrub's words: that NEMAR wrote the line.
  Nothing in a clone tells NEMAR's commit from one made by hand with the same line; the bound is the same one the scrub's words have.
  `ledger-cli.ts append` refuses the word (`action-written-by-nemar-only`), and the line holds only fixed words and hex.

### Who writes the line, and how

- The Worker writes it, with the credential enrichment already commits `.nemar/` files to `main` with, through the Contents API, as `nemarAdmin` like every backend commit on a dataset, with a fixed message that names no dataset.
  No new secret, no workflow and no ruleset change is needed.
  A person does not write it: the CLI never pushes the line.
- The write is leased on the ledger blob the Worker read: GitHub refuses it when another writer changed the ledger in between, and the Worker reads again, so nothing appended in between is dropped.
  The new text is the read text and one line; the line is a function of the stored acceptance, so a write whose answer was lost is found on the next request and not written twice.
  A line on `main` that already names the merge before the acceptance is recorded is not NEMAR's, since NEMAR writes only after it records, so the acceptance is refused (`attestation-conflict`) with nothing written; one that is not NEMAR's bytes and appears between the record and the write is refused the same way, the acceptance stays recorded without its line, and the release waits for an administrator.
  Neither is ever overwritten.
- Every request, a later run's replay included, reads `main`'s ledger first: a line already there is seen and not written again, and a missing one (a write whose answer was lost, a GitHub that answered a write it did not make, a line reverted) is written once more, and only when, just before the write, GitHub's comparison says `main` still holds the merge (`merge-not-on-main` otherwise, nothing written).
  The residual: the write is leased on the ledger's blob, not on `main`'s head (the Contents API has no compare-and-swap on a branch head), so a rewrite of `main` that lands between that comparison and the write, and leaves the ledger's blob as it was, is not caught by the write itself; the line would then name an id the rewritten history does not hold, and the fresh-clone proof fails closed on it (`ledger-acceptance-unmatched`).
- The line is written only when the proof needs it: when the merge appends a `repull-scrubbed` line beside other files.
  A merge that does not touch the ledger (N.0.1's never does, since it replays no `.nemar/` path, and N.0.0's does not when its scrub changed nothing) is accepted with no line, because a line naming a commit the proof does not need it for fails the proof on its own.
- The release is refused by the Worker unless it reads the needed line on `main` itself when the release is recorded (`acceptance-unattested`), whatever a caller or a stored flag says, and `resume` reads the line back from NEMAR's origin before it goes on (`attestation-unseen`, which the next run takes up).
- The commit is accepted where the re-pull reads `main` after N.0.0's merge, and nowhere else: N.0.1 is made on a `main` that holds it (`checkMain` with `acceptances`, and `findPatchCommit`), as a fourth shape beside enrichment's three, a commit whose only change appends valid acceptance lines to the ledger and edits none before them.
  Before a merge no acceptance belongs on `main`, so the gates, the merge gate and the re-synthesis still refuse one, and a release branch never takes one, since a pull request that carried such a line would land it beside the re-pull's files, which the proof refuses.
  The `.nemar/**` rule of the Phase 6c amendment is unchanged: a line that lands between a plan and its execution makes the plan stale, which cannot happen while the record that wrote it is the dataset's one open record.
- A push to `main` that touches only the ledger runs the repository's BIDS validation shim and nothing else, as the scrub runbook says of its own ledger commit (step 13, "What a push sets off"); that is read from the runbook, not observed for this commit.

### What the line is not

- It is not a recorded correction (decision 1, as the Phase 6b amendment corrected it): it changes no byte of the dataset.
  The rule, corrected again: a recorded correction is a line whose word is none of `import-scrubbed`, `repull-scrubbed` and `repull-merge-accepted` (`TOOL_ACTIONS` in `scripts/scrub/ledger.ts`, which the plan and N.0.1's ledger check read).
- It holds nothing: a re-import's history hold (ADR 0089) still reads `import-scrubbed` lines only.

### Limits, and what is left open for the owner

- **A history rewrite re-ids the commit, and re-accepting it is not supported.**
  ADR 0085's rewrite gives every commit a new id, and the ledger's text is carried over unchanged, so after a rewrite of a dataset with an accepted merge the line names an id the history no longer holds.
  The proof then fails closed, as it does for a forged id (`ledger-commit-not-alone` and `ledger-acceptance-unmatched`, tested on a forged id, not on a rewrite), and step 14 of the scrub runbook stops.
  An acceptance cannot be made again for the rewritten commit: it is taken only while the record is at `merged`, and the record is complete by then; the ledger's command line refuses the word; and a line a person appends is what the proof cannot tell from NEMAR's.
  The decision, recorded here for the owner: before a rewrite, the administrator checks the dataset's ledger for `repull-merge-accepted` (the scrub runbook says how), and a dataset that has one is not rewritten until the owner decides between translating the line through the rewrite's commit map (a tool not built) and another path.
- **An automatic record merged outside the gate stays at `merged`.**
  Nothing accepts it; it keeps the dataset's next re-pull blocked until an administrator decides, which this amendment does not build.
- **An N.0.1 merged before its gates were recorded** has no gated head to compare with, so its acceptance is refused (`tree-anchor-missing`), and its release could not compare the tag either.
- **The release's own tag check** (the Phase 6e amendment) still reads only that the tag contains the merge; the acceptance's order (the tag first) is what keeps the line after the tag, and that the dataset workflow tags the squash merge and not a later head of `main` is the open item it was.
- **The Worker still takes `resume`'s word that a merge carries its trailers** when no acceptance is recorded, as before: it cannot read trailers as git reads them.
  What it checks itself is every acceptance, and the line before a release.
- **On the mirror that prompted this**, `resume --accept-merge-trailers` is the way on; this amendment does not run it, and what the evidence reads there is seen only when the administrator runs it.

### Checked only against stand-ins

The suites drive the real `resume` (`test/repull-accept-merge-trailers-cli.test.ts`; N.0.1 over NEMAR's acceptance commit in `test/repull-accept-merge-trailers-patch-cli.test.ts`; an N.0.1 merged outside the gate, after and before its gates, in `test/repull-patch-cli.test.ts`; the dispatched finish in `test/repull-automatic-cli.test.ts`), the plan over a ledger holding the word (`test/repull-plan.test.ts`), the real Worker routes over bun:sqlite, the real `git` and `git-annex`, and the proof's own rule on a fresh clone of the origin the Worker wrote to, and the proof's rule through `git-scrub verify --fresh-clone` on hand-made histories (`test/scrub/git/fresh-clone.test.ts`).
GitHub is the suites' stand-in, answering from and writing to the bare origin, so these are what only production can show: that the Contents API takes the write leased on the blob's `sha` and answers a stale one with 409 or a 422 that says it does not match; that GitHub's comparison lists the files as the stand-in does, compares a commit with `main` by name, and answers 404 for two commits with no common history; and that the Git Data API answers a commit's parents and a tree's entries as the stand-in does.
The stand-in's squash also takes the head's tree, where GitHub's is a three-way merge onto `main`; the two differ only when `main` moved since the pull request's base, which the suites that move `main` read for the parent and the tree, not for what GitHub would merge.

## Amendment 2026-11-09 (#2108): a plain merge commit of the re-pull's own pull request is accepted too

The first use of the acceptance (on000117, re-pull #5) met a merge made with GitHub's merge button using the merge method, not the squash: `703396f2dd34`, two parents (the record's base and the pull request's head), GitHub's default message.
Its tree was identical to the gated head's, it created the ledger with one `repull-scrubbed` line, and it carries no trailers; the tag and the version DOI were made from it.
The CLI and the Worker both refused it (`merge-not-squash`), so the record stopped at `merged` and the dataset fails the fresh-clone proof, with no way to finish.
The decision text above is unchanged.
Earlier text of the 2026-10-29 amendment is annotated, in a note that begins "Annotated 2026-11-09", where this amendment changes what it says.

### What is accepted

- A merge commit of one parent (a squash), or of two parents whose first is the record's base, or a commit enrichment moved it to, and whose second is exactly the head GitHub reports for the merged pull request, which is the recorded head or a commit enrichment moved it to.
- One predicate, `classifyMergeParents` in `shared/repull-merge-acceptance.ts`, decides the shape for the CLI and the Worker.
  Each then compares the first or only parent with the base, and the head with the record's, through the readings it already made.
- No parent, or three or more parents, is `merge-not-squash`.
  The word is kept so that no word changes meaning for a caller that reads it, and its message says what is accepted.
- Two parents whose second is not the merged head (the head first among them) is `merge-second-parent-foreign`.
- Everything else of the 2026-10-29 amendment is unchanged: the record an administrator opened and the administrator who opened it; the pull request from the record's branch into `main` of the dataset's own repository; the tree outside `.nemar/**` and `.github/**`, read from the merge commit's own tree; what the merge did to the privacy ledger; `main` still holding the merge; the one line and the reasons it carries.

### What differs from a squash, and why that is tolerable

- A plain merge makes the release branch's history reachable from `main` through the second parent: the recorded head, the enrichment commits made on the branch since (at most `ENRICHMENT_MAX_COMMITS`, each read as enrichment-shaped content on a single parent by `enrichmentOnlySince`), and their ancestors.
  A squash kept that history off `main`.
- That history is what the gates already cleared: the head is pinned to the recorded head plus enrichment, and the re-pull commit in it is the one that carries the two trailers (decision 2).
- A second parent with a different tree cannot be accepted, because the tree check is made on the merge commit itself and not on the head.
- The fresh-clone proof reads the ledger by `git log --first-parent`, so a merge on `main` is judged by its diff against its first parent, which is the diff the acceptance checks, and the same `repull-merge-accepted` line vouches for it as for a squash.
  The proof's other scans are unchanged; none of them was run on production data for this shape, only on the suites' repositories.

### The ledger word does not change

- The line keeps the verification word `squash-merge-verified` for both shapes, because a ledger validator already deployed accepts that word and no other.
  A different word would make every older CLI mark the line `ledger-invalid`.
- The line names the merge commit by its full id, so which shape it has is read from the commit, not from the word.
  Documents that quote the word say so.

### What the acceptance does not claim

- It verifies the shape, the parents, the tree and the ledger effect of the commit; it does not verify that GitHub made it, as it did not for a squash.
  Its output says "a plain merge commit", not "GitHub's".
- Only an administrator can use it, on a record they opened, and the Worker reads all of it again on GitHub with its own credential.

### Checked only against stand-ins

The suites drive the real `resume` against a bare origin and a GitHub stand-in whose `merge` method writes a two-parent commit holding the head's tree (`test/repull-accept-merge-trailers-cli.test.ts`, and N.0.1 in `test/repull-patch-cli.test.ts`).
GitHub's own merge is a three-way merge onto `main`, which is the head's tree only while `main` is the pull request's base; the suites that move `main` read the parent and the tree, not what GitHub would merge.
The first production use is on000117.
