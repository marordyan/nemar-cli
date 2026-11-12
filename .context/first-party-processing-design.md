# NEMAR first-party processing: design (v2, DRAFT)

**Status:** DRAFT under owner review, written 2026-10-12.

> **Amendment, 2026-11-03 (owner).**
> NEMAR's own pipelines use no MATLAB: every recipe is Python on `sccn/eegprep`, which is extended upstream when a recipe needs a step it lacks,
> and signalJourney (`signalJourney/signalJourney`) records every step, the ICA weights and the quality results.
> The repository this design proposed now exists as `nemarOrg/nemar-process`, and the work is filed as the compute program epics on `nemarOrg/nemar-cli`.
> The compute gateway that runs these pipelines on Expanse through Tapis is designed on the gated docs page `admin/design/compute-gateway`.
> The legacy MATLAB quality-assurance pipeline stays on its current path until the new recipes replace it.

It revises [`first-party-processing/design-v1.md`](first-party-processing/design-v1.md) (v1, kept as written) after the owner's decisions of the same day.
Three questions are open and each has an issue with a suggestion (section I.1: #1750, #1751, #1752); no epic is filed and no repository is created until the plan is final.
Research was read-only except where a section says a spike ran: B.6c and B.6d ran on SDSC Expanse, and their code and results are in [`first-party-processing/sp-p/`](first-party-processing/sp-p/).
Tags on current-state claims: `(verified: path, command or URL)`, `(inferred)`, `(measured)`, `(estimated)`, `(unknown)`.
Where an Architecture Decision Record (ADR) and any other document disagree, the ADR wins.

The two inputs that were still running when the first cut of this draft was closed have landed:
the pamica run-time measurement (section B.6a) and the join of the legacy quality-assurance (QA) mirror against dataset licenses (section G.3).

**Second round of owner rulings, 2026-10-12 (later the same day).**
1. **The first release is EEG only, through eegprep.**
   The owner ruled that the runner stays on eegprep for now, and that data quality and processing for the other modalities (intracranial EEG, magnetoencephalography, electromyography) come after EEG quality assurance and processing are in production.
   This is a sequencing ruling, not a design choice to make now: the other modalities are thought through here so that the first release does not close them off, and none of it is built, specified in a recipe, or put on a critical path.
   Sections B.2 to B.4 keep the multi-modality analysis and are marked **later, not built**; the plan (section J) is rewritten around EEG.
2. **Measured bucket policy:** 4,586 bytes with 127 private prefixes, against the 20,480-byte cap (section G.2).
   Headroom is 15,894 bytes, which is about 480 more private-dataset entries or about 330 per-dataset `.nemar/nemarproc/*` entries, so the cap is a shared budget that is not exhausted today but is not a reason, by itself, to refuse per-dataset held entries for the 42 datasets in question.
   Section G.4 is revised with this number.

**Third round of owner rulings, 2026-10-12 (answers to section I.1).**
1. **Held tier: option (a), the top-level `held/` prefix.** Settled.
2. **pamica rank cap 64 for the pilot, and a common average reference before ICA "for stability".** Settled; B.5 records the average-reference step and the resulting rank (N_good - 1).
3. **ICA at scale runs on GPU, with the native Fortran binary on CPU as the fallback (owner decision, 2026-10-12, after spike SP-P).** The owner's rule was to use the GPU only if it vastly outperforms the CPU. Measured on Expanse (B.6c, B.6d): a V100 costs about 0.12 service units (SU) per recording-hour against 13 to 15 for the best CPU arm (about 105 times), takes 7 minutes per fit against 49 to 114, and started a job in 10 seconds on `gpu-shared` while a 4-core `shared` job waited more than 4 hours. The Fortran binary beats pamica torch-CPU from 16 threads (2.2 times at 16, 2.7 at 32), so it is the CPU engine. pamica's published 4090 result, in which Fortran beat CUDA float64, was a block-size artifact (B.6c). Production fits run in float64 (owner, 2026-10-12): a full GPU pass is about 16,000 SU, a negligible share of the allocation.
4. **Git mirror of the dataset-level record: open, to be discussed** (I.1 item 4 carries the discussion).
5. **DataCite creators: NEMAR only.** The creator's affiliation can carry the SCCN ROR (`https://ror.org/01bt2qm76`), which the DataCite builder already uses as the publisher identifier (verified: `backend/src/services/datacite.ts` L1621); E records it.
6. **Retention: keep the latest products' artifacts, older ones reduced to receipts.** Open in detail: what a receipt is, and what happens to a DOI-bearing older product (I.1 item 6).
7. **Live datasets: no special status.** The owner: the `nm000103`-`nm000107` rule comes from the time there were five datasets; supersede those notes. F is rewritten around a general "published datasets" rule.
8. **Two scientific reviewers: not decided.** I.1 item 8 proposes a rule that does not need names yet.
9. **File naming: BIDS-like.** The owner rejected `<dataset_id>_datasetQA_signalJourney.json` as not BIDS-like and asked for an entity that can carry the dataset-level QA record, looking at BIDS-Prov and others. C.10 records the grammar check and a proposal.

**Fourth round of owner rulings, 2026-10-12.**
1. **Namespace:** everything goes under `.nemar/nemarproc/` (renamed from `.nemar/process/` throughout).
2. **QA in git:** the dataset-level QA record is committed to git under `.nemar/`.
3. **DOI:** for the signalJourney records, with the artifacts retained beside them; the preferred scope is the `.nemar/nemarproc/` portion linked to the dataset version. C.11 shows how to do that in git.
4. **Retention:** retain everything (supersedes the receipt idea).
5. **File name (C.10):** accepted.
6. **Reviewers:** Haiku or Sonnet agents.
7. **Compute:** the `shared` and `gpu-shared` go-ahead is given for after the `debug` and `gpu-debug` results.

**Operating rule for the spike (owner):** nothing runs on the Expanse login node; short experiments use the `debug` and `gpu-debug` partitions only (J.1).

---

## What changed from v1 and why

| Area | v1 | v2 | Why |
|---|---|---|---|
| Scope | EEG first; MEG and EMG "floor only"; ICLabel EEG-only | **EEG only in the first release, through eegprep**; the other modalities (iEEG, MEG, EMG) are designed for in a deferred modality matrix and built after EEG QA and processing are in production | owner: the archive is not EEG-only, then (second ruling) sequence it: EEG first, the rest after EEG is in production |
| Engine boundary | eegprep for everything | eegprep for every first-release step; the recipe schema keeps an `engine:` field per step so a later engine is an addition, not a redesign | owner: stay eegprep only for now; eegprep is EEG-only end to end at `origin/develop` (verified, section A), which is why the other modalities wait |
| ICA | Picard-O default, rank reduction to 64 | **pamica** (sccn/pAMICA, Adaptive Mixture ICA in PyTorch) with `n_models = 1`, rank reduction after bad-channel removal | owner decision; owner is its author |
| GPU | "none needed" | CPU and CUDA paths, GPU partitions on Expanse, two image flavors, a device-class tolerance contract | AMICA is 10 to 50 times the cost of Picard on CPU; CUDA float64 is bit-reproducible per pamica |
| Layout | BIDS-derivatives tree in S3 at `<id>/derivatives/...` | NEMAR namespace `.nemar/nemarproc/` (logical) with S3 as the physical home, a dataset-level signalJourney QA record, bidsignored, no derivatives tree | owner rejected the derivatives shape; v1 missed the existing `.nemar/` precedent and signalJourney's dataset-level form |
| Publication | all-or-nothing per dataset; 42 license-ineligible datasets not processed | **run for all; two tiers**: dataset-level QA always published; per-recording state published only for license-eligible datasets, otherwise processed and **held** | owner ruling; the held tier's home is resolved here (section G) |
| DOI | dotted scheme recommended | dotted scheme accepted; landing page and record target finalized for the new layout | owner accepted |
| Runner | new repo recommended | `nemarOrg/nemar-process`, MIT, scaffolded later | owner accepted |
| Live datasets | excluded from the pilot and gated by owner action | fixtures and exemplars first, then live datasets as ordinary datasets; AGENTS.md wording drafted | owner asked "why not?"; the analysis in section F says the hard rule is not what an additive, prefix-scoped write touches |
| ADR 0049 | supersede recommended | supersede, final | owner accepted |

What did **not** change: state-not-copies, S3 as the bulk home, the recipe-with-rules model, the late-mint quality gate, the verify-and-promote path, anonymity exclusion, and the vocabulary (recipe, engine, run, product, artifact, resolved plan, capability list).

---

## Executive summary (refreshed)

**The product.** For every public dataset version with EEG recordings (646 of the 858 public datasets, holding about 95% of the catalog's known recording hours, measured 2026-10-12; other modalities follow once EEG is in production), NEMAR runs a declared recipe inside a digest-pinned container and publishes the decisions and model state per recording (bad channels, bad segments, line-noise and filter parameters, Adaptive Subspace Reconstruction (ASR) calibration, Adaptive Mixture Independent Component Analysis (AMICA) decomposition from pamica, component labels where a labeler exists, quality metrics) with signalJourney provenance at two resolutions: one record per recording and one record per dataset.
The dataset-level record feeds the website's QA tab for every processed dataset; the per-recording state is published only where the dataset's license allows derivatives and is otherwise held.
Nothing is a cleaned copy; a consumer re-applies the state to the raw bytes it already streams.

**Five decisions that matter most.**
1. One namespace, git as the home of the DOI'd records. Everything is under `.nemar/nemarproc/`; published products are committed to a side branch `nemarproc` of the dataset repository (one commit and one tag per product, a DOI that points at that subtree by its git tree SHA), the tier-1 QA record is also committed to `main` under `.nemar/`, and S3 holds staging, the serving copy, over-budget bulk and the whole held tier (section C.11).
2. pamica is the decomposition engine, single model, rank-reduced, CPU or CUDA, with a device-class tolerance contract and a GPU budget that the pilot must measure before the catalog pass.
3. The first release is EEG only and eegprep only (owner ruling); one runner and one recipe schema with an `engine:` field per step keep iEEG, MEG and EMG an addition later rather than a redesign.
4. Two publication tiers under one run-for-all rule; the held tier is the 42 non-derivative or unknown-license datasets, all of which the first release already needs (all 26 non-derivative datasets are EEG-only), so the held tier is not deferred by the EEG-first ruling; its home is the top-level `held/` prefix (owner's choice, third round), one 29-byte constant in the bucket policy, chosen over per-dataset exclusions that the measured policy could have afforded (G.4).
5. Live datasets are ordinary datasets once the runner has run on fixtures and exemplars; the hard rule in AGENTS.md is reworded to say what it protects.

**Three biggest gaps.**
1. pamica cost: measured in SP-P (B.6c, B.6d). One catalog pass is about 16,000 GPU-hours (SU) at 64 channels in float64, half that in float32, against 1.7 to 2.1 million core-hours (SU) on CPU, which is a large share of the allocation (the allocation's size is kept in the gated docs). Every recipe-version reprocessing is another pass, which is why the GPU is the production path. The CPU figures are extrapolated from 75,000-sample windows and stay so until the real-recording CPU anchor runs.
2. eegprep is an EEG engine: it has no MEG or iEEG reader, types every channel `EEG`, and has no line-noise step or ASR state export. The first release therefore stays inside what eegprep does (EEG), needs the ZapLine plugin and the ASR-state surfacing upstream, and leaves the other modalities for after EEG is in production.
3. The bucket policy is measured (4,586 of 20,480 bytes, 127 private prefixes): the cap is a shared budget with room for about 480 more private datasets, so it did not forbid per-dataset held entries; the owner chose the one-constant `held/` prefix anyway.

---

## A. Inventory deltas since v1

Only what v2 depends on; v1 section A still holds for everything else.

| Finding | State | Evidence |
|---|---|---|
| eegprep readers | `.set/.fdt`, EDF/BDF/GDF, BrainVision, EGI `.mff`, Neuroscan `.cnt`; **no** FIF, CTF `.ds`, KIT, BTi, NWB, MEF; every MNE-imported channel is typed `EEG` and converted to microvolts; the BIDS importer lists only `suffix='eeg'` | verified: `functions/popfunc/pop_fileio.py` L27-99, `_file_io.py` L242-266, `plugins/EEG_BIDS/bids_list_eeg_files.py` |
| eegprep channel typing and units | `chanlocs[].type` is a free string; `channels.tsv` `units` is never read; no algorithm branches on type or unit; Tesla handled nowhere (`maxwell`, `sss`, `gradiometer`, `magnetometer`: zero hits) | verified: `pop_load_frombids.py` L199-205, whole-tree grep |
| eegprep `clean_channels` | requires Cartesian `X,Y,Z` for most channels, normalizes every position onto a unit sphere about the origin (spherical-spline RANSAC); falls back to `clean_channels_nolocs` on a location error | verified: `clean_channels.py` L65-114, `private/sphericalSplineInterpolate.py` L135-144, `clean_artifacts.py` L233-247 |
| eegprep ICLabel | needs `theta`/`radius` scalp coordinates and average reference; no refusal for non-EEG types (silent nonsense) | verified: `ICL_feature_extractor.py` L28-100 |
| eegprep AMICA | `eeg_amica` wraps the external Fortran `amica15` binary, excluded from wheels; no pamica call anywhere (`git grep -i pamica`: none); open bug #435 (channel-major input) | verified: `popfunc/eeg_amica.py`, `sigprocfunc/runamica.py`, `gh issue 435` |
| SSS for MaxShield MEG | lives in `scripts/zarr/generate_zarr.py` (`is_maxshield_fif`, `maxshield_calibration_for`, `apply_sss` with `mne.preprocessing.maxwell_filter(calibration, cross_talk)` and MNE defaults), recorded as the store's `sss` attribute and `derived: true` | verified: `generate_zarr.py` L1608-1756, ADR 0028 |
| MEG component labeling | `mne-icalabel` MEGnet (BSD-3, `megnet.onnx`, `onnxruntime`): requires `mag` or `grad` channels, at least 15,000 samples, warns unless 250 Hz, 1 to 100 Hz band, Infomax, 20 components; topomaps use magnetometer positions only, so gradiometer-only arrays (CTF, KIT) get no usable features | verified: `mne_icalabel/megnet/features.py`, `label_components.py` |
| iEEG and EMG labelers | none exist in eegprep, mne-icalabel or MNE | verified |
| `mne_bids.read_raw_bids` | datatypes `eeg, emg, ieeg, meg, nirs`; readers for FIF, CTF, KIT, BTi, MEF, EDF, BDF, BrainVision, `.set`; applies `channels.tsv` `type`, `units` (`T`, `T/m`, `uV`) and `status`; **sets `allow_maxshield=True` by default**, so the ADR 0028 gate must be re-checked after loading | verified: `mne_bids/read.py` L1457-1458 |
| pamica | BSD-3, PyPI 0.4.0 (2026-09-24); PyTorch; CPU, CUDA float64, Apple MLX float32; "CPU and CUDA float64 are bit-reproducible"; `AMICA(n_models, n_mix).fit(X)`; `write_amica_output` in EEGLAB amicaout format (`gm, W, S, mean, c, alpha, mu, sbeta, rho, LL, ...`); defaults follow amica15; `AMICA.from_params_file`; MNE wrapper `AMICAICA`; ADR 0003 best-iterate semantics, ADR 0004 rank-deficient input | verified: README at `github.com/sccn/pAMICA` and the owner's brief; the clone-level read and the CPU timing are pending (section B.6) |
| Bucket policy | public-by-default: one `Allow Principal:* s3:GetObject` with `NotResource = [staging/*, <privateId>/*, ...]`; rebuilt from the private-id set on every transition (`withPrivateSet`), so any non-id entry is dropped on the next rewrite; `putBucketPolicy` refuses above `MAX_BUCKET_POLICY_BYTES = 20480`; read-after-write with 3 retries; callers: `services/visibility.ts`, `publication-orchestrator.ts` L537, `routes/admin/fleet.ts` | verified: `backend/src/services/bucket-policy.ts`, `s3.ts` L1309-1430 |
| Anonymous `ListBucket` | denied on the bucket, including at the root | verified: `.context/eegprep_lean_contract.md`; `.memory/s3-403-is-not-absence.md` |
| S3 ARN wildcards | `*` matches any characters including `/`; AWS's own example `bucket/*/test/*` matches `bucket/1/2/test/3/object.jpg` | verified: IAM "Resource" element reference |
| R2 tokens | scoped to buckets, not key prefixes; S3-compatible access key and secret; "Object Read & Write" level | verified: Cloudflare R2 token docs |
| ADR 0076 | news images in their own R2 bucket, served by the Worker; "Dataset bytes stay in S3; this does not reopen that decision" | verified |
| Expanse GPU | 52 nodes, 4 x V100 32 GB each, 40 cores, 384 GB; `gpu` and `gpu-shared`, 48 h max; "A GPU SU is equivalent to 1 GPU, less than 10 CPUs, and less than 92G of memory"; `#SBATCH --gpus=N`; 1.6 TB node-local NVMe | verified: SDSC user guide |
| Tapis GPU passthrough | `parameterSet.schedulerOptions` are opaque scheduler args (`{"arg": "--gpus=1"}` works by construction); `containerArgs` are "command line arguments for the container runtime" and the Singularity launch template has a user-options slot; `--nv` is not mentioned anywhere in the Tapis jobs page | verified: Tapis jobs page; `--nv` passthrough is **inferred** and is a spike item |
| signalJourney dataset level | `docs/bids.md`: "a single `*_signalJourney.json` file might be placed at the root of the specific derivative pipeline directory ... would then reference multiple subject input files"; the root schema has `summaryMetrics` (an open `qualityMetricsObject`) and `versionHistory[]`; the `metrics_heavy.json` example shows namespaced metrics with `value/unit/threshold`; nothing else is specified for a dataset-level record (no per-recording table, no references to child records) | verified: `docs/bids.md` L40-120, `schema/signalJourney.schema.json`, `definitions/qualityMetricsObject.schema.json` |
| `.nemar/` precedent | exactly two backend writers commit into `.nemar/`: `enrichDataset` (`.nemar/metadata.json` plus the `.bidsignore` line `.nemar/`, batched tree commit) and `writeAvailabilityReport` (`.nemar/availability-report.json`), both to `main` as committer `nemarAdmin` through the NEMAR App, which is a `bypass_mode: always` actor on the published ruleset; backend commits are UTF-8 text only (`commitFilesAsTree`: "binary is not supported"); `ENRICHMENT_TRIGGER_PATHS = {README.md, dataset_description.json}` so a push touching only `.nemar/**` dispatches no enrichment (#643's fix), version DOIs fire on `v*` tag pushes only, `createTag` has one caller (the orchestrator), and no `.nemar/*` writer edits `Version`; the manifest walker excludes only `.git/` and `.github/`, so `.nemar/**` at the tag is in the version manifest; **every `.nemar/*` commit to `main` re-runs the BIDS-validation shim** (`push: branches: [main]`); `.nemar/` is **also the CLI's local working-state directory** (`config.json`, `upload-progress.json`, `http-snapshot.json`) and the upload path adds `.nemar/` to the local `.gitignore` | verified: `github/contents.ts` L14, L57, L384, L625-702; `enrich-dataset.ts` L1070-1099; `availability-report.ts` L179-253; `routes/webhooks/github.ts` L34-50, L81-182; `publication-orchestrator.ts` L1349-1401, L1554; `manifest.ts` L120-136; `github/workflows.ts` L131-138; `src/lib/dataset-config.ts` L25-27; `src/lib/upload/transfer.ts` L69-82 |
| Legacy `qa/` coverage and licenses | live probe of all 858 public datasets: **32 have a QA tree, all `on*`: 23 CC0 and 9 CC-BY-SA-4.0 (HBN releases); 0 ND, 0 unknown**; the 2024 pipeline CSV lists 238 `ds` ids of which 225 map to mirrors (224 CC0), but only 22 of those are mirrored today; every ND, NC and unknown license in the catalog sits on an `nm*` dataset, none of which has legacy QA | measured 2026-10-12: `GET data.nemar.org/<id>/qa/?format=json` x 858; `first-party-processing/evidence/qa_license_mix.json` |
| Zarr discovery and `.nemar` | `EXCLUDED_TREES = ("derivatives", "sourcedata", "code")`; dot-directories are not excluded; discovery is by extension over `git ls-tree`, so a `.set` or `.fif` under a git-tracked `.nemar/` would be converted | verified: `generate_zarr.py` L98, L143, L1563-1572, L1757-1771, L4544 |

---

## B. The adaptive cleaning model, by modality

### B.1 Vocabulary (unchanged from v1, two additions)

Recipe, engine, run, product, artifact, resolved plan, capability list as in v1.
**Tier 1** is the dataset-level QA record, published for every processed dataset.
**Tier 2** is the per-recording state (records, masks, matrices, labels), published only for a license-eligible, non-anonymous dataset and otherwise held.

### B.2 The engine boundary, stated honestly (first release: EEG only, eegprep only)

**Owner ruling (second round, 2026-10-12): the first release stays on eegprep and covers EEG.**
Data quality and processing for intracranial EEG (iEEG), magnetoencephalography (MEG) and electromyography (EMG) follow after EEG quality assurance and processing are in production.
This is a sequencing ruling and not a choice the design asks the owner to make now; what follows is thinking, kept so the first release does not close the later door.

What the first release uses: eegprep for loading, channel typing, drift, flatline, bad channels, bad windows, ASR and ICLabel; pamica for decomposition, invoked through eegprep's ICA entry point once the `icatype='pamica'` backend lands (upstream ask U6) and called directly meanwhile because eegprep's own AMICA path is the Fortran binary with the open #435 bug.
The first release has no MNE-Python dependency in the runner and no second conversion path.

Why the other modalities wait, so the reason is on record: eegprep at `origin/develop` is an EEG engine; it has no MEG or iEEG reader, types every imported channel `EEG`, forces microvolts, and its only location-aware step assumes a scalp sphere (verified, section A).
Carrying MEG and iEEG inside eegprep would mean six upstream changes (readers, type and unit propagation, per-type pooling in `clean_channels`, a non-spherical or forced no-locs mode, an ICLabel guard, a MaxShield re-check), none of which exists.
When the time comes there are two roads, and the choice belongs to that later phase, not to this plan: grow eegprep upstream until it covers the modality, or let a step name a second engine (MNE-Python is the obvious candidate) and add a second conversion and a second parity surface.
The first release keeps both roads open by two small commitments only: a recipe step carries an `engine:` field (always `eegprep` or `pamica` in the first release), and the runner holds its in-memory representation behind one internal interface (channels with type, unit, position and status; float64 data; annotations) so a second adapter would be an addition.
Neither commitment adds work to the first release beyond a field and a seam.

### B.3 The modality matrix (later modalities: design notes, not built)

The EEG column is the first release.
The iEEG, MEG and EMG columns are the design thinking behind B.2's later road, retained so the first release does not paint itself into a corner; they are not specified in a recipe, not tested, and not on any critical path, and a later phase will re-derive them against whatever eegprep covers by then.

| Component | EEG (scalp) | iEEG (ECoG, SEEG) | MEG | EMG |
|---|---|---|---|---|
| Load | eegprep (`pop_loadset`, EDF, BrainVision) or MNE for other formats | MNE via `mne_bids` (`.edf`, `.vhdr`, `.mefd`); `.nwb` has no reader in either (none exists) | MNE via `mne_bids` (FIF, CTF, KIT, BTi); **re-check `info["maxshield"]`** because `mne_bids` allows it silently | either (EDF/BDF) |
| Channel typing and units | eegprep from `channels.tsv` `type`; microvolts | MNE (`seeg`/`ecog`, uV) | MNE (`mag`, `grad`; T, T/m kept separate) | MNE (`emg`, uV) |
| SSS (MaxShield) | not applicable | not applicable | MNE `maxwell_filter` with the dataset's calibration pair, exactly as `generate_zarr.py` does; declined without the pair (ADR 0028); recorded in the record | not applicable |
| High-pass / drift | eegprep `clean_drifts` (0.25, 0.75) Hz | same, on uV | MNE `filter` per type at 0.5 Hz (unit-aware) | 20 Hz high-pass, 450 Hz low-pass (surface EMG convention); `clean_drifts(transition=(15, 25))` if eegprep carries it |
| Line noise | ZapLine plugin (v1 H.1) or MNE `spectrum_fit` under 16 channels; always measured | same | SSS removes most; residual measured, `spectrum_fit` applied | notch at the line frequency and harmonics (EMG band includes them); measured |
| Flatline | eegprep `clean_flatlines` | same | MNE `find_bad_channels_maxwell` flat (fT-scaled) | `clean_flatlines` |
| Bad channels | `clean_channels` RANSAC when locations are plausible, else `clean_channels_nolocs` | **forced no-locs** (`clean_channels_nolocs`) plus MNE `find_bad_channels_lof`; the spherical RANSAC is geometrically wrong for grids and depths | MNE `find_bad_channels_maxwell` (per type); `clean_channels` is not used (pools mag and grad on a sphere) | `clean_channels_nolocs` |
| Bad segments | eegprep `clean_windows` | `clean_windows` plus MNE `annotate_amplitude` | MNE `annotate_muscle_zscore` and `annotate_amplitude` | MNE `annotate_amplitude`; `clean_windows` |
| ASR | eegprep `asr_calibrate`/`asr_process` (state stored) | eegprep, **marked unvalidated** in the record | eegprep per sensor type separately (mag, grad), marked unvalidated | deferred (none is validated practice) |
| ICA | pamica, rank-reduced (B.5) | pamica | pamica per type after SSS, rank from SSS (`nfree`) | **later slot**: pamica's EEG/EMG claim is unvalidated; HD-sEMG motor-unit decomposition belongs to openhdemg; floor only in v2 |
| Component labeling | eegprep ICLabel (requires scalp coordinates; refused without them) | none exists | `mne-icalabel` MEGnet on magnetometer arrays (Elekta/MEGIN); gradiometer-only arrays get no labels, recorded as `labeler: none` | none exists |
| QC metrics | % good channels, % good samples, line-noise dB before and after, per-channel robust amplitude, spectrum summary, ICA convergence, % brain components at legacy thresholds | same minus labels | same, per type, plus SSS applied flag | % good channels and samples, line-noise dB, envelope summary |
| Deferred | cleaned preview | labeler (none exists) | gradiometer labeling; tSSS | ICA, envelope features |

Every "unvalidated" cell is written into the record and the dataset-level QC, never silently applied: the product says "ASR calibrated on iEEG with scalp defaults; not validated for this modality."

### B.4 The floor and the ICA tier per modality

First release (EEG): `nemar-floor` is the EEG column's rows from load to QC without ASR and ICA; `nemar-ica` adds ASR, pamica and ICLabel.
Eligibility for `nemar-ica`: at least 20 x rank² samples after bad windows, scalp coordinates plausible enough for ICLabel (otherwise decomposition runs and the labels are recorded as `labeler: none`).

Later (not built): the same two recipes extended per the deferred columns of B.3.
For MEG the eligibility rule would add "SSS applied or not MaxShield", and for iEEG "at least 16 good contacts"; these stay as notes until the later phase.

### B.5 pamica: what it is, how it is called, what is stored

**How eegprep calls AMICA today (verified):** `eeg_amica(EEG, posact, sortcomps, num_models=1, max_iter=2000, num_mix_comps=3, pcakeep=None, outdir, amica_binary, max_threads=4)` runs the Fortran `amica15` binary through `subprocess`, loads the amicaout files, and stores `icaweights`, `icasphere`, `icawinv` plus the full output under `EEG['etc']['amica']`; the binary is not in the wheel; the input serialization bug #435 is open; pamica is not referenced.
**What is missing:** a backend switch (`icatype='pamica'` in `pop_runica`, or `eeg_amica(backend='pamica')`), the output mapping from pamica's fitted attributes to `icaweights`/`icasphere`/`icawinv`, `EEG.etc.amica` populated from pamica's state, seed and device plumbing, and a manifest stamp of the pamica version and device.
The runner does not wait for that: it calls pamica directly on the runner's float64 array and writes eegprep-compatible fields itself, which is the same shape the eegprep backend switch should produce (upstream ask U1).

**Full state versus consumer state (single model, `n_mix = 3`, rank `r`, channels `N`):**

| Array | Shape | Needed by a consumer applying the decomposition | Needed to resume or audit |
|---|---|---|---|
| `S` (sphering) | r x N (or N x N) | yes | yes |
| `W` (unmixing, per model) | r x r | yes | yes |
| `A` (mixing, pseudo-inverse) | N x r | yes (topographies) | derivable |
| `mean` | N | yes | yes |
| `gm` (model weight) | n_models | no for one model | yes |
| `alpha`, `mu`, `sbeta`, `rho` (mixture-of-generalized-Gaussians source density) | 3 x r each | no | yes |
| `c` (per-model bias) | r | no | yes |
| `LL` per iteration | iterations | no | yes (QC) |
| PCA / rank matrix | N x r | yes when rank-reduced | yes |

Consumer set at float64 in TSV at 9 significant digits (about 12 bytes per value): N = r = 64: about 150 KB; N = 128, r = 64: about 170 KB; N = 306 MEG, r = 64: about 320 KB.
Full state adds under 20 KB for the density parameters plus the LL trace.
Multi-model (`n_models > 1`) multiplies `W`, `c`, `gm` and the densities by the model count and adds a per-sample model probability trace that is as large as the data; **it is excluded** from the product and is why `n_models = 1` is the default: a consumer applies one unmixing, the mixture of models is a research option with no viewer or downstream consumer today, and its state does not fit the state-not-copies rule.

**Rank handling.** After bad-channel removal the data has `N_good` channels; average-referenced EEG has rank `N_good - 1`; SSS-filtered MEG has rank `nfree` from `proc_history` (72 in ADR 0028's receipt); iEEG grids are often full rank but bipolar-referenced arrays are not.
The runner computes the numerical rank (pamica ADR 0004 governs rank-deficient input; the runner reduces to `min(rank, 64)` by PCA before `fit`, and stores the PCA matrix so the unmixing applies to the raw channel space.
Decision (owner, third round): 64 is the cap for the pilot, revisited after the pilot measures cost against the number of brain components actually labeled.
**A common average reference is applied before ICA, for stability** (owner).
It is a recipe step ahead of `fit`, recorded in `ica.json` as `reference: average` together with the good-channel set it was computed over, and it is why the rank is `N_good - 1`, which the PCA reduction then handles; a consumer re-applies the same average reference over the same channel set before multiplying by the unmixing, so the stored set is part of the contract.

**Convergence and best iterate.** pamica ADR 0003 keeps the best log-likelihood iterate; the product records `n_iter`, `converged` (tolerance reached), `best_iter`, `LL_final`, `LL_best`, the tolerance and `max_iter`, and the device class; a run that stopped at `max_iter` without reaching tolerance is `converged = false` and is published with that flag, not withheld.

### B.6 Cost model with pamica, and the GPU consequences

**Reference rates (estimated from the AMICA literature and pamica's README claims; the clone-level benchmark is pending).**
Fortran AMICA on 64 channels at 250 Hz is commonly quoted at hours per 10 to 30 minutes of data on a single core for 2,000 iterations; per-iteration cost scales as samples x r² x n_mix.
With pamica reproducing the reference "within tolerance" and a stated CPU/CUDA parity, the planning assumption is 10 to 50 times Picard's CPU cost at the same rank, and a 10 to 30 times speedup on a V100 in float64 over one CPU core (estimated; V100 fp64 is 7.8 TFLOPS).

| Class | Shape | Floor | ASR + pamica CPU (one core, rank 64, 2,000 iterations) | ASR + pamica V100 |
|---|---|---|---|---|
| S | ≤ 64 ch, ≤ 1 h at 250 Hz | 6 core-min | 2 to 8 core-h | 10 to 30 GPU-min |
| M | 65 to 128 ch or 1 to 3 h | 15 core-min | 8 to 30 core-h | 0.5 to 1.5 GPU-h |
| L | > 128 ch (MEG after SSS, high-density) | 30 core-min | 15 to 60 core-h | 1 to 3 GPU-h |

Catalog pass (144,000 recording-hours, measured in v1): the floor stays about 15,000 core-hours; `nemar-ica` is **300,000 to 1,000,000 core-hours on CPU** or **15,000 to 50,000 GPU-hours on V100** (estimated).
The ACCESS per-PI cap on Expanse is 75,000 GPU-hours; a Discover-class allocation (1.5 M credits) could carry the GPU pass if the exchange rate is near one credit per GPU-hour (unknown until the calculator is read).
These numbers decide the plan: **the ICA tier runs on GPU, the floor runs on CPU**, and spike SP-P must replace the estimates before any allocation request. SP-P has since run (B.6c, B.6d): the V100 pass measures about 16,000 GPU-hours at 64 channels in float64 (8,000 in float32), at the low end of the estimate above, and the owner confirmed the GPU as the production path.

**B.6a Measured pamica results (added after the benchmark finished; supersedes the "pending" notes above).**
Source: a benchmark run on an Apple M4 Pro (14 cores, 64 GB), pamica 0.4.0, torch 2.14.1, one process per configuration, seed 42, default block size 8192; synthetic data (64 planted sources, Laplace and Student-t, 1% noise), so quality figures depend on that data and the machine is not a production node.
Raw results are in [`first-party-processing/evidence/bench/`](first-party-processing/evidence/bench/) (`results.jsonl`, `conv.jsonl`). No CUDA or V100 run existed when this benchmark finished; B.6c now supplies the V100 measurements.

| Shape (k = samples / channels²) | Backend, threads | s per iteration | 100 iterations |
|---|---|---:|---:|
| 64 ch x 75k samples (5 min at 250 Hz, k = 18) | torch float64, 10 threads | 0.170 | 17 s |
| same | torch float64, 4 threads | 0.205 | 20.5 s |
| same | torch float64, 1 thread | 0.651 | 65 s |
| same | MLX float32 (Apple GPU) | 0.058 | 5.8 s |
| 64 ch x 300k (20 min, k = 73) | torch float64, 10 threads / 1 thread / MLX | 0.615 / 2.650 / 0.197 | 62 s / 265 s / 20 s |
| 128 ch x 75k (k = 4.6) | torch float64, 10 threads / 1 thread / MLX | 0.299 / 1.344 / 0.0945 | 30 s / 134 s / 9.4 s |

What the numbers change:
1. **Budget 2,000 iterations, not pamica's default of 100.** On planted-source data, 100 iterations recovered 0 of 64 sources above 0.95 |cos|, 1,000 iterations 24 of 64, 2,000 iterations 64 of 64 (min 0.9945). Every run stopped on `max_iter`; `min_dll` never fired within 2,000. At 64 ch x 75k, 2,000 iterations cost about 6 min (10 threads, extrapolated), about 22 min (1 thread, extrapolated) and 95 s on MLX (measured). Cost is about linear in samples and about 1.8x for doubling channels.
2. **The CPU half of the cost model holds.** One core needs about 4 core-hours per recording-hour at 64 channels and 250 Hz (linear extrapolation from 0.651 s per iteration at 75k samples, 2,000 iterations), inside v1's class S range of 2 to 8 core-h; the catalog CPU range of 300,000 to 1,000,000 core-hours stands for this machine. **That core is an Apple M4 Pro core; one Expanse EPYC 7742 core is about 2.9 times slower on this workload (1.895 s per iteration, 12.6 core-hours per recording-hour, B.6d), so on Expanse the catalog pass on CPU is about 1.7 to 2.1 million core-hours.** MLX float32 was 13.6x faster than one CPU core on 64 x 75k; a V100 in float64 is about 73 times faster than one Expanse core per iteration at 64 x 75k (0.026 s at block 8,192 against 1.895 s) and about 109 times at 64 x 900k (0.2088 s at block 131,072 against 1.895 s x 12 = 22.7 s, extrapolated), measured in B.6c and B.6d.
3. **A cost lever to evaluate in SP-P (my inference, not measured; superseded by B.6c, which tested it and found it unsafe on uncleaned data):** fit on a bounded window of the cleanest data (the rank-64 adequacy rule of 20 to 30 x rank² needs only about 5.5 to 8 min at 250 Hz) and apply the unmixing to the whole recording. The catalog averages about 36 min per recording, so a cap near 15 to 20 min would cut the fitted hours by roughly 2x or more, and more for the long sleep and monitoring recordings. The recipe would record the fit window.
4. **Determinism needs a pinned thread count.** Same seed and thread count gave identical SHA-256 for W, S, mu and LL, on torch and on MLX; 1 and 4 threads agreed bit for bit; 10 threads agreed on S but differed in W, mu and LL in the last digits (final LL differed by 1.4e-11). So the contract is per (device, dtype, thread count), the runner pins threads, and the stamp records the count. `seed=None` draws OS entropy; the runner always passes a seed.
5. **Record `stop_reason`, never trust `converged_`.** In pamica 0.4.0 `converged_` is True even when the fit stopped on `max_iter`. The product derives its own `did_converge` from `stop_reason_` (`min_dll`, `grad_norm`, `lrate_floor` count) and stores `stop_reason`, iterations run, `final_ll_` and whether a best-iterate restore fired (`final_ll_ != ll_history_[-1]`).
6. **State size, measured.** Single model, float64, written in the EEGLAB amicaout layout: W plus S is 65 KB at 64 channels and 1.4 MB at 300 channels (S is zero-padded to N x N on disk when rank-reduced); the full mixture state is about 7 KB at 64 channels; the per-sample `LLt` file (16 bytes per sample, 4.8 MB at 300k samples) dominates the directory and **must not be stored** (an upstream ask: an `LLt=False` option). Applying a decomposition needs only W, S and the PCA basis (eegprep's own `icaact = (icaweights @ icasphere) @ data` uses no mean), so the consumer set is smaller than B.5 assumed for the files, while TSV text roughly doubles it.
7. **eegprep's current AMICA path is broken.** eegprep issue #435 (open, P1): the Fortran-binary input is written in the wrong frame order, so "every runamica/eeg_amica decomposition is wrong"; PR #436 (draft) fixes it and should merge first. eegprep also never stops early (it disables `use_min_dll` and `use_grad_norm`, so it always runs all 2,000 iterations) and does not map a seed for AMICA. The runner calls pamica directly, as B.5 already says.
8. **Install footprint.** torch 2.12.1 Linux CPU-only wheel is 183 MiB; the default Linux wheel is 508 MiB plus about 2.1 GiB of CUDA libraries (about 2.6 GiB in all, estimated). `import pamica` pulls in torch (1.5 s), so a torch-free `apply` path is worth asking for.

9. **EEG-first barely changes the cost envelope.** From the 2026-10-12 catalog (858 public datasets, 714 with a recorded duration): 646 datasets list EEG among their modalities and hold about 136,800 of the catalog's 143,900 known recording hours (about 95%); iEEG datasets hold about 5,000 hours and MEG about 1,200. The 300,000 to 1,000,000 core-hour range therefore stands for the EEG pass, and the datasets (646 of 858, 75%) shrink more than the hours do. The channel-count median for EEG datasets is 64 (95th percentile 144), which is why 64 is the design point. (Some recording hours counted under EEG belong to multi-modal datasets whose other recordings are deferred; I did not split them.)

**The EEG hours are heavy-tailed, and that matters more than per-recording speed (measured from the catalog, 2026-10-12).** Four datasets hold about 101,000 of the 136,800 EEG recording hours (74%): SeizeIT2 `on005873` (44,000 h, tagged EEG and EMG), I-CARE `nm000289` (32,700 h, 36,123 recordings), the PhysioNet 2018 sleep-arousal challenge `nm000225` (15,300 h) and the Penn encoding and retrieval dataset `on004395` (9,100 h); the other 578 EEG datasets with a duration hold about 35,700 h.
Applying the bounded-fit-window lever of item 3 to the catalog's own numbers (arithmetic from per-dataset mean recording length, not a pamica measurement; kept for the arithmetic, since B.6c found the lever unsafe): a cap of 20 minutes per recording cuts the fitted hours from 136,800 to about 34,600 (about 4x), a 15-minute cap to about 28,300 (4.8x), a 30-minute cap to about 46,400 (2.9x); at the measured 4 core-hours per fitted hour that is roughly 140,000 core-hours instead of 550,000 at 64 channels (an upper bound for the many low-channel clinical recordings).
This paragraph predicted that SP-P's first decision would be whether a bounded fit window gives the same components. B.6c answered no on uncleaned data (a re-test on cleaned data remains possible), and B.6d showed the GPU makes the full-recording pass affordable (about 16,000 GPU-hours at 64 channels in float64), so cost no longer forces a fit cap. How the four giant datasets are treated stays a recipe-rule question (cap the fit, or floor-only), not a cost one.

**B.6b What pamica's own benchmarks say (read 2026-10-12 from the sccn/pAMICA clone at 0.4.1.dev0; run by its authors on a 32-core Linux workstation with an RTX 4090 and on an Apple M4 Pro; `benchmarks/README_dimsweep.md`, `.context/issue-63`, `.context/issue-351`).**
- **The Fortran binary beat pamica on CUDA float64 on the 4090.** One fit at 70 channels x 747,750 frames x 2,000 iterations, Newton off: native Fortran 1,303 s (about 22 min), pamica CUDA float64 1,856 s (about 31 min). Re-run on 2026-09-23 on a shared host, Fortran at 16 threads: Fortran 1,972 to 2,559 s, pamica CUDA float64 1,886 to 5,013 s (slowest while the GPU was shared). On the Mac at 32 channels and 100 iterations: Fortran reference 10.0 s, pamica torch-CPU 18.1 s, NumPy 32.6 s, MLX float32 3.0 s.
- **Speed-ups pamica reports for itself:** CUDA float64 about 4.5x over a 16-thread CPU on the same host (32 channels, 30,504 samples: 38.5 against 172.8 ms per iteration, same final LL to five digits); float32 on CUDA "about 10 to 19x" over CPU float64 (about 7 significant digits, not float64 parity); torch-CPU threads beyond about 4 give negative returns on small blocks.
- **Block size:** pamica 0.4's default is 8,192 samples (it was 512 in the #63 work; 128 to 2,048 changed 168 to 130 ms per iteration at one thread). The Fortran binary's block counts one thread's share, and a block larger than the data per thread yields an all-NaN fit (issue #292), so the native wrapper divides. Block size changes the trajectory by about 1e-6, so it belongs in the recipe pin.
- **The native binary** is a single process (a shim replaces MPI, no MKL, no vendor math library, OpenMP threads, a seeded random start), shipped as a release asset for linux-x64 and linux-arm64 with static LAPACK. The owner confirms this is fine for single-CPU jobs. The older Fortran copies under `<project dir>/eeglab/AMICA1.7/` (`amica15ub`, `amica15ex`) were not run; pamica's notes say the stock build seeds from the wall clock (so is not reproducible run to run), which is why the pamica release with its seed patch is the one to benchmark and pin.
- **The 4090 is a weak proxy for a V100 in float64 (inference from published specs, not measured here).** A consumer Ada card runs float64 at a small fraction of its float32 rate; a V100 runs float64 at half its float32 rate (about 7.8 teraflops) and the A100 faster still. The 4090's "CUDA float64 is slower than 16 CPU threads" result may therefore not transfer to Expanse. The owner's intuition that the V100 would not differ much is the hypothesis SP-P tests.
- **Expanse facts verified live on 2026-10-12:** the NEMAR allocation's size and use on the `expanse` resource were read (the figures are kept in the gated docs, not here); `gpu-shared` and `gpu` contain 6 A100 nodes (4 A100, 64 cores, 507 GB) beside 50 V100 nodes (4 V100, 40 cores, 385 GB), while `gpu-debug` has V100 nodes only; the singularitypro 3.11 and 4.1.2 modules exist; the NEMAR NFS share holds a 598-directory OpenNeuro mirror including ds002718.
- **Service-unit arithmetic that decides the CPU-versus-GPU question:** one SU is one core-hour on a shared CPU partition and one GPU-hour on a GPU partition, so a V100-hour costs what one CPU core-hour costs, and a node-exclusive CPU hour costs 128 SU. The whole CPU catalog pass in B.6a item 9 (about 140,000 to 550,000 core-hours) is a small share of the available allocation (its size is kept in the gated docs, not here), so allocation is not a constraint on the CPU route; queue availability, which the owner reports is better on CPU, is the other lever.
- **Wheel trap for V100s (from `eeg-frontends/docs/expanse/README.md`, verified there on 2026-08-22, to be re-verified for the torch version pamica needs):** CUDA 13 wheels dropped Volta (sm_70), so a default `torch` install fails on a V100 at the first kernel launch; pamica 0.4 requires torch >= 2.12.1, so the GPU image needs a cu128 build of that or newer that still carries sm_70, or must fall back to torch 2.8.0 with pamica installed without its dependency pin. The A100 (sm_80) has no such problem. This makes V100 and A100 different image flavors, not one CUDA image.

**B.6c SP-P measured on Expanse V100 (2026-10-12; `first-party-processing/sp-p/`; pre-registered in `PREREG.md`; `gpu-debug` only; synthetic data except where marked; one process per point, slope of two fits so setup drops out).**
Hardware and stack: Tesla V100-SXM2-32GB (sm_70), torch 2.8.0+cu128, pamica 0.4.0 installed without its dependency pin (the cu128 index stops at torch 2.11.0 and pamica requires >= 2.12.1; the V100 smoke test passed, so pamica 0.4.0 runs on torch 2.8.0).
- **Block size is the dominant knob, and the published GPU benchmarks pinned the worst value.** pamica's `benchmark_decompose.py` and `benchmark_dimsweep.py` hardcode `BLOCK_SIZE = 512`, while the library default has been 8,192 since 2026-08-15 (#229). On the V100, float64, 64 channels x 75,000 samples: block 512 takes 0.379 s per iteration, 2,048 takes 0.066, 8,192 takes 0.026, 32,768 takes 0.024. Beyond that the gain continues but flattens: 64 channels x 900,000 samples float64 takes 0.286 s at 8,192, 0.261 at 32,768, 0.233 at 65,536, 0.210 at 131,072, 0.206 at 262,144 and 0.201 with the whole recording as one block (15.6 GiB). **Rule from the grid: use a block of 131,072 samples (within about 4% of the best, 2.6 GiB at 64 channels x 900k, 5.2 GiB at 128 channels x 900k); do not use 512.** Block size changes the trajectory by about 1e-6 (pamica #63), so it belongs in the recipe pin.
- **The 4090 "Fortran beats CUDA" result is probably a block-size artifact (inference).** That comparison (Fortran 1,303 s, pamica CUDA float64 1,856 s at 70 channels x 747,750 frames x 2,000 iterations) ran through `benchmark_decompose.py` at block 512. On the V100 the same configuration on the real ds002718 recording measured 0.204 s per iteration at block 32,768 and 0.190 at 131,072, which is 380 s (6.3 minutes) for 2,000 iterations in float64 and 192 s in float32. Different GPU, so this does not prove the 4090 would flip; it shows the published ranking cannot be carried over.
- **float32 is 1.8x to 2.1x faster than float64 on the V100 at large blocks** (64 channels x 900k at block 131,072: 0.105 against 0.210 s; 128 channels: 0.201 against 0.408), the ratio V100 float64 throughput predicts (half rate), unlike the 4090's. At small blocks the two are equal because the run is launch-bound.
- **Memory is not the constraint.** Peak allocation at block 131,072: 64 channels x 300k 2.3 GiB, 64 x 900k 2.6 GiB, 128 x 900k 5.2 GiB, 70 x 747,750 2.8 GiB; the only out-of-memory point was 128 channels x 900k with the whole recording as one float64 block (more than 32 GiB).
- **Packing fits onto one GPU does not help, for large or small fits.** Aggregate iterations per second at N = 1, 2, 3, 4, 6 concurrent fits (64 channels x 300k, float32, block 8,192): 16.0, 16.2, 16.2, 16.3, 16.5; float64: 10.3, 9.3, 9.4, 9.4, 9.4. Small recordings (64 x 75k, block 32,768; N = 1, 2, 4, 8): float32 80.3, 73.5, 75.0, 75.3; float64 42.3, 37.7, 38.1, 38.3. One fit saturates the GPU; N concurrent fits each take N times as long. Decision R4: one fit per GPU, and the throughput lever is block size and precision, not packing.
- **Cost per recording-hour on a V100 (2,000 iterations, 250 Hz = 900,000 samples, block 131,072, linear in samples beyond 300k):** 64 channels float64 0.21 s per iteration, 7.0 minutes, 0.12 GPU-hours (0.12 SU); float32 3.5 minutes, 0.06 SU; 128 channels float64 13.6 minutes, 0.23 SU; float32 6.7 minutes, 0.11 SU. For the 136,800 EEG recording hours: about 16,000 GPU-hours at 64 channels float64, 8,000 in float32, and about 4,000 (float64) or 2,000 (float32) with a 20-minute fit cap (the 34,600 fitted hours of B.6a item 9). Against 24 GPUs per account in `gpu-shared`, 16,000 GPU-hours is 28 days of continuous running; 2,000 is under 4 days. These are timing figures on synthetic data and say nothing yet about convergence quality; the real-data anchors (below) address that.
- **Real-data anchors (ds002718 sub-002, 70 channels x 747,750 samples = 50 minutes at 250 Hz, uncleaned, 2,000 iterations, Newton off, block 131,072, library-default early stops; all five runs stopped on `max_iter`).** V100 float64 383 s, final log-likelihood -3.69938; float32 198 s, -3.69937; float64 with seed 43 382 s, -3.69935. pamica's own published value on the 4090 is -3.69934 (five seeds, SD 4e-5 to 6.5e-5), so the V100 on torch 2.8.0 reproduces the published likelihood within seed spread.
- **Equivalence on the real recording** (Hungarian-matched |correlation| of spatial maps and of component activations on a common 300,000-sample slice): float64 against float32 with the same seed 1.000 and 1.000 (every component above 0.95); seed 42 against seed 43 in float64 0.998 and 0.999 (every component above 0.95; this is the noise floor for "same decomposition"). So float32 on the V100 is, on this recording, indistinguishable from float64 at half the time, and with the same seed it meets the cross-device contract already written in the determinism row (every matched component at or above 0.999; the worst unmixing-row match was 1.0000). Different seeds only reach 0.98 on the worst unmixing row (97% of rows above 0.99), so the contract holds at a fixed seed and the seed is part of the pin. One recording is evidence, not proof; the next stage should repeat it on recordings with other channel counts and sampling rates.
- **The bounded fit window is not safe by default (this contradicts the lever proposed in B.6a item 3).** Fits on a 20-minute window (300,000 samples, k = 61) and a 10-minute window (150,000 samples, k = 31), both starting at sample 200,000, reproduce the full-data components poorly: mean matched activation correlation 0.63 and 0.48, mean map correlation 0.63 and 0.59, only 6% and 4% of components above 0.95, and even the ten highest-variance components agree only at 0.71 and 0.63 (the full-data fit against a different seed agrees at 1.000). The recording was uncleaned, so artifacts that differ between segments may be driving this, and one window position was tried; the fair statement is that **the 4x cost cut from a fit cap is unproven and the evidence so far is against it**, to be re-tested on cleaned data (after the floor recipe) with several window positions and a held-out likelihood. Until then the cost envelope uses full-recording fits, and the levers that are proven are float32 (about 2x) and large blocks.
- **Revised catalog cost with the proven levers only (float32, block 131,072, full recordings):** about 238 s per recording-hour at 70 channels (198 s scaled from 747,750 to 900,000 samples), so about 0.066 GPU-hours (0.066 SU) per recording-hour and roughly 9,000 GPU-hours for the 136,800 EEG recording hours, about 16 days at the account's 24-GPU cap if nothing else ran; float64 doubles that.
- **A100 nodes cannot see Lustre.** The six A100 nodes in `gpu-shared` lack the `lustre` feature that every V100 and CPU node carries, so an A100 run needs its environment and data off Lustre (home or the NFS share); the A100 arm is parked, and the V100 pool (about 50 nodes, 200 GPUs) is the production target anyway.
- **Scheduler facts learned:** `shared` rejects a 128-core request but accepts up to 120 cores; the `gpu-debug` queue let two jobs run at once on two nodes; the `debug` CPU queue left one job pending for over two hours in the afternoon but started two jobs within minutes in the evening, while `shared` was the congested queue (about 1,700 jobs pending, many nodes drained, a 4-core job pending for more than four hours), so neither CPU queue can be assumed available; compute nodes have internet (uv installs and the pamica binary download worked); `--gpus=a100:1` and `--gres=gpu:a100:1` are both rejected by the account's submit filter (`--gpus=1` is accepted but does not select the type).

**B.6d SP-P CPU arm: the native Fortran binary against pamica torch-CPU (2026-10-12; one AMD EPYC 7742 node, `debug` partition; 64 channels x 75,000 samples, float64, one process per point, slope of two fits).**
- **The published Linux binary cannot run on Expanse, and the fix is upstream.** The v0.4.0 `amica15-linux-x64` and `-arm64` assets reference glibc symbol versions up to 2.38 and depend on the build host's `libgomp.so.1`; Expanse is Rocky Linux 8.9 with glibc 2.28. Fixed in sccn/pAMICA (issue #370, PR #371, merged into `dev` 2026-10-13): the Linux targets build in a `rockylinux:8` container, link static OpenBLAS and `libgomp`, and a gate fails the release job above glibc 2.28 or on any non-glibc shared library. The binary measured here is that PR's CI artifact (25 MB stripped, glibc floor 2.27, runs directly on the node with no container). It reaches users only with the next pamica release, and pamica's resolver never rechecks a cached `latest` binary, so the runner image pins the binary by digest and does not use the resolver's download.
- **Seconds per iteration:**

| Threads | Fortran | torch-CPU | Fortran speed-up over torch |
|---|---|---|---|
| 1 | 2.173 | 1.895 | 0.87x |
| 2 | 1.101 | 0.979 | 0.89x |
| 4 | 0.597 | 0.553 | 0.93x |
| 8 | 0.286 | 0.316 | 1.10x |
| 16 | 0.158 | 0.347 | 2.2x |
| 32 | 0.123 | 0.331 | 2.7x |
| 16 threads, 128 channels | 0.339 | 0.595 | 1.75x |

  Fortran keeps scaling (7.6x at 8 threads, 13.8x at 16, 17.7x at 32 over one thread) where torch-CPU plateaus at about 8 threads and gets slower beyond 32. **R1 (at least 1.5x at the same thread count): met from 16 threads, not met below 8 threads, where torch-CPU is 7% to 13% faster.** So the native binary is the engine of the CPU arm when a fit gets 16 or more threads; a packed node of single-thread fits would favor torch-CPU slightly (the 1-thread cost is 14.5 core-hours per recording-hour for Fortran against 12.6 for torch, extrapolated below).
- **Cost per recording-hour (250 Hz = 900,000 samples, 2,000 iterations), extrapolated linearly in samples from the 75,000-sample points; unvalidated until the real-recording anchors run:** Fortran 1 thread 14.5 core-hours, 8 threads 15.3 (1.9 hours of wall time), 16 threads 16.9 (1.05 hours), 32 threads 26.2 (49 minutes); torch-CPU 1 thread 12.6. One shared-partition core-hour is one SU, so the best CPU arm costs about 12.6 to 15 SU per recording-hour (16.9 to 26.2 for the faster-latency configurations).
- **R2 (GPU against CPU): the V100 costs 0.12 SU per recording-hour in float64 (0.06 in float32), about 105x below the best CPU arm, far past the 3x threshold; per fit it is 7.0 minutes against 49 minutes for the fastest CPU configuration (7x) and 114 minutes at 8 threads (16x).** By the pre-registered rule the GPU arm is preferred.
- **What the two arms mean for the whole catalog (136,800 EEG recording hours, full recordings):** one CPU pass costs about 1.7 to 2.1 million SU, a large share of the allocation, and every recipe-version reprocessing is another pass; one GPU pass costs about 16,000 SU in float64 or 8,000 in float32. In calendar time the two are comparable at their account caps: 4,096 cores at about 14 core-hours per recording-hour is about 290 recording hours per hour, so about 20 days; 24 GPUs at 7.0 minutes (float64) is about 205 recording hours per hour, so 28 days, or 14 days in float32. The CPU figure assumes 4,096 cores are actually available, which the current `shared` queue does not suggest.
- **Owner decision rule (2026-10-12): the GPU arm is used only if it vastly outperforms the CPU arm; otherwise CPU.** Measured: about 100x cheaper in SU, 7x to 16x faster per fit, and about the same campaign calendar time at the account caps. The cost difference is the deciding number because the plan reprocesses (each recipe version is another pass over the catalog) and the CPU pass alone would consume a seventh of the allocation. The CPU arm stays as the fallback for short jobs and for any period when the GPU pool is unavailable. Production fits run in float64 (owner, 2026-10-12). Availability, the owner's tie-breaker, was measured and does not favor CPU today: see the next bullet.
- **Queue wait, one sample each, same account, evening of 2026-10-12 (single observations, not a distribution):** `gpu-shared` with one V100 and 4 cores started 10 seconds after submission; the `debug` CPU partition started a 32-core job after 2 minutes 40 seconds and a 4-core job after 23 minutes 55 seconds; `shared` with 4 cores for 20 minutes was still pending after more than 4 hours, and an 8-core job after more than 2 hours 25 minutes (a large part of the `shared` partition was drained or down). The 64-channel, 900,000-sample float64 point also reproduced on `gpu-shared` (0.2088 s per iteration against 0.2095 on `gpu-debug`, 6 minutes 41 seconds for the whole job including the environment start). The belief that CPU nodes are easier to get did not hold for this account and hour. A campaign needs the wait measured over days (the runner records submit-to-start for every chunk), and the plan must not depend on either pool.
- **Still open for this arm:** equivalence of the Fortran decomposition with the V100 anchors (the real 70-channel recording, 2,000 iterations, seed 42, at 16 and 64 threads) and independent single-thread fits packed onto a node (R5) are queued on `shared` and have not run. They matter for the engine choice only if Fortran and pamica disagree on components; the native backend writes the same state format.

**GPU consequences (replacing every "no GPU" in v1).**

| Concern | v2 decision |
|---|---|
| Images | two flavors from one `uv.lock`: `nemar-eegprep:<ver>-cpu` (torch CPU wheel, about 200 MB) for Hallu and CPU chunks, and `nemar-eegprep:<ver>-cuda` (torch CUDA wheel, 2 to 3 GB) for GPU chunks; both digest-pinned, both signed (cosign), both with a syft SBOM; the CUDA image's SIF is 3 to 5 GB and is staged once per digest on Expanse project space |
| Tapis | `execSystemLogicalQueue = gpu-shared`, `schedulerOptions: [{"arg": "--gpus=1"}]`, `containerArgs: ["--nv"]` (passthrough inferred; SP-T proves it), `memoryMB` sized to the class (up to 92 GB per GPU before a second GPU SU is charged) |
| Hallu | CPU only (no GPU, about 19 GiB ceiling); floor and class S CPU chunks only |
| Determinism | pamica: CPU float64 bit-reproducible with itself and CUDA float64 bit-reproducible with itself, **at a fixed thread count** (measured: 10 threads differ from 1 or 4 in the last digits, B.6a), so the runner pins threads and the stamp records them; **across device classes the contract is tolerance**: after Hungarian matching on absolute correlation, every component at or above 0.999, `LL_best` within 1e-6 relative; MLX float32 is a developer convenience and never a production device |
| Device class in the stamp | `engine_version` gains `device: cpu | cuda`; a re-run that lands on a different device class than the last is **not** a new product when the tolerance holds (fixture gate), and is a new product patch when it does not, with the record saying which device produced it |
| Apple MLX | not used for products |

Upstream asks (pamica, owner-controlled): U1 a stable, versioned on-disk state schema (`amicaout` plus a JSON header with shape, dtype, channel order, rank, PCA, device, seed); U2 an `apply(W, S, mean)` entry point that needs no density parameters; U3 explicit `random_state` and thread-pinning documentation; U4 a per-iteration LL and best-iterate flag in the output; U5 a modality applicability note (EMG claim); U6 the eegprep backend switch (`icatype='pamica'`) with #435 closed in the same change.

---

## C. Layout: the `.nemar/nemarproc/` namespace

### C.1 The `.nemar/` precedent, re-examined

`.nemar/` is already a NEMAR-owned, bidsignored directory committed into dataset repositories: `enrich-dataset.ts` writes `.nemar/metadata.json` and appends `.nemar/` to `.bidsignore`; `availability-report.ts` commits `.nemar/availability-report.json`; both go to `main` through the NEMAR App, which is a bypass actor on the published-dataset ruleset (verified: ADR 0001, 0005, 0065).
Do those commits bump a version or mint anything? No.
Versions are created by the depositor's `Version` field and a `v*` tag (`createTag`, one caller), the version DOI webhook fires on tag pushes only, and the enrichment dispatch keys on `README.md`/`dataset_description.json` changes with the `.nemar/metadata.json` self-trigger closed in #643 (verified at line level: `routes/webhooks/github.ts` L34-50, L81-182; `publication-orchestrator.ts` L1349-1401).
One side effect is not guarded: the dataset-repo "BIDS Validation" shim runs on every push to `main`, so each `.nemar/*` commit re-runs validation (verified: `github/workflows.ts` L131-138), which is why the availability sweep caps itself at 30 datasets per run and why a per-product git write rate would matter.
So v1's ADR 0006 objection was wrong as stated: a `.nemar/` commit does not bump a version.
What is true is the **circularity**: a file committed after tag `vX` is not in `vX`'s manifest; it appears in `vX+1`'s tree, describing `vX`.
`.nemar/availability-report.json` has exactly this shape today ("lives on `main` while archives build from the immutable version tag", ADR 0005), and the website reads the D1-backed `GET /:id/metadata.json`, not the git file, for the same reason.

The real objections to committing per-run artifacts to git are therefore narrower than v1 said and still decisive for the bulk: a commit per product per dataset reaches about 850 repositories per recipe version (ADR 0020's blast radius), a repository can be private while its dataset is public (anonymity), matrices over 100 kB in `.tsv` would **not** be annexed (the `exclude=*.tsv` clause wins, ADR 0031) and would bloat git, and the git tree cannot hold a version-pinned product for the version it describes.
A small dataset-level record is a different question, answered in C.4.

### C.2 Logical namespace and physical sources

| Logical path (what every surface sees) | Physical source | Notes |
|---|---|---|
| `/<id>/<vtag>/.nemar/nemarproc/` | S3 listing of `<id>/.nemar/nemarproc/*/<vtag>/manifest.json` | the per-version index of products |
| `/<id>/<vtag>/.nemar/nemarproc/<recipe>@<rv>/manifest.json` | S3 `<id>/.nemar/nemarproc/<recipe>@<rv>/<vtag>/manifest.json` | the capability list of that product |
| `/<id>/<vtag>/.nemar/nemarproc/<recipe>@<rv>/<path>` | S3 `<id>/.nemar/nemarproc/<recipe>@<rv>/<vtag>/<path>` | served only if named by the manifest |
| `/<id>/<vtag>/.nemar/desc-datasetQA_signalJourney.json` | S3 `<id>/.nemar/nemarproc/<recipe>@<rv>/<vtag>/desc-<recipelabel>_signalJourney.json` of the newest **published** product for that version | the owner's dataset-level record, one URL per version; the recipe is inside the document |
| `/<id>/latest/.nemar/...` | resolves `latest` as the data plane already does | convenience |
| git `.nemar/` on `main` | `metadata.json`, `availability-report.json`, `.bidsignore` entry, plus the tier-1 `desc-datasetQA_signalJourney.json` | the QA record is in git (owner); **products are on the `nemarproc` side branch, C.11** |

The owner first dictated the dataset-level record's name as `.nemar/onoxxxx_datasetQA_signalJourney.json` and then asked for a BIDS-like name; C.10 replaces it with `desc-datasetQA_signalJourney.json` (the dataset identity moves inside the record).

Physical key choice: the S3 keys mirror the logical path (`<id>/.nemar/nemarproc/...`) so there is one name to know; the Zarr converter and the bucket sweeps enumerate `<id>/<kind>/` and must learn that `.nemar` is a kind (one constant each).
The held tier (section G), in the recommended form (option a), lives at `held/<id>/.nemar/nemarproc/...`, the same shape under a top-level prefix; in the alternative form (option g) it lives at the final key `<id>/.nemar/nemarproc/...` from the start, behind a per-dataset policy exclusion that is removed on promotion.

### C.3 Data plane: merging a second capability list without breaking ADR 0066/0072/0074

Five rules, re-applied:
the product manifest is the capability list for `.nemar/nemarproc/<recipe>@<rv>/*`;
the S3 prefix is built from the dataset row's id and the registry row's `(recipe, rv, vtag)`, never from the request;
the visibility gate (`loadPublishedDataset`) runs before the registry or S3 is read;
the manifest cache key is `(origin, id, vtag, recipe, rv)`, never content-addressed;
refusals are 404.
Mechanically: `routes/data.ts`'s `fileOrIndexHandler` matches `.nemar/nemarproc/` first and routes to a `processHandler` that resolves the registry row, reads the product manifest through `readManifest` (ADR 0072 streaming, 60 s trust window, ETag revalidation) and answers a file (302 to the unsigned public URL, ADR 0074, or presigned for a bucket-policy-excluded dataset), a directory listing, or a 404.
The version manifest is untouched; the two lists never merge in memory, they meet in the path space only.
Listing `/<id>/<vtag>/` shows `.nemar/` as a directory only when at least one product is published for that version.
ADR 0066's own text says "a request is served only for a path the published manifest names"; the existing `qa/*` route (an S3 listing, not a manifest) is already an undocumented exception to that sentence (verified: `data-router.ts` L438-505).
So the new ADR for this namespace must **amend ADR 0066** to say "a published manifest" means the version manifest or a registry-named product manifest, and must list the `qa/` route as the legacy exception it retires.
Cache keys for product manifests use their own internal namespace (`__nemar-internal/process-manifest/v1/<id>/<vtag>/<recipe>@<rv>`), so the version manifest's 60-second trust window and answer memo are never applied to the wrong object.

### C.4 Versioning, addressing, listing, verification, retention and garbage collection

| Aspect | Rule |
|---|---|
| Versioned by | source dataset version (`vtag`) and recipe version (`<recipe>@<rv>`); the engine and image digest are inside the manifest and the record |
| Addressed by | the logical path above; `product_id = <id>/<vtag>/<recipe>@<rv>` |
| Listed by | the per-version index (S3 listing of manifests, cached) and the registry (`derived_products`) |
| Verified by | every artifact's sha256 in the manifest; the Worker verifies on promotion; `nemar dataset download --process` verifies on fetch |
| Immutable | a product is never rewritten; a repair is a new patch recipe version |
| Retention | last two products per `(id, recipe)` across versions kept; older tombstoned: manifest and dataset-level record kept, artifacts deleted, registry `tombstoned` |
| Garbage collection | a weekly reconcile lists `<id>/.nemar/nemarproc/` and `held/<id>/...`, compares to the registry, and deletes only what the registry says is tombstoned (ADR 0055 spirit: report disagreements, delete only on the registry's say) |

### C.5 "bidsignored" in practice

| Consumer | Behavior |
|---|---|
| BIDS validator | the git repository's `.bidsignore` already carries `.nemar/`; the process files are not in git, so the validator never sees them; a user who downloads a product into a clone keeps it under `.nemar/`, which is ignored |
| git-annex | not involved (nothing in git) |
| Zarr converter (ADR 0027) | discovery walks the git tree, so `.nemar/nemarproc/` in S3 is invisible; **`.nemar` is nonetheless added to `EXCLUDED_TREES` and the gate-superset test**, because dot-directories are not excluded today and a future git-tracked `.set` or `.fif` under `.nemar/` would be converted; the kind constant is added to the bucket-prefix enumerations so sweeps do not mistake it for a dataset |
| Local `.nemar/` collision | the CLI keeps `config.json`, `upload-progress.json`, `http-snapshot.json` at the `.nemar/` root and gitignores `.nemar/` locally; products download into `.nemar/nemarproc/<recipe>@<rv>/`, a sub-directory with no name overlap, and the local gitignore keeps a downloaded product out of an accidental commit; the HTTP snapshot path always fetches git-keyed `.nemar/**` manifest entries, which does not reach products because they are never git-keyed |
| `nemar dataset download` / `get` | unchanged by default; `--process [<recipe>]` fetches the product into `.nemar/nemarproc/<recipe>@<rv>/` of the download directory and writes both citations (v1 skipped `derivatives/` by default, the same shape) |
| `nemar dataset clone` | a git clone, so no process files arrive; `nemar dataset derived download` (G.4 in v1) adds them |
| A user mirroring the repository | sees `.nemar/metadata.json` and the availability report as today and nothing of the process namespace unless they fetch it |

### C.6 What the viewer and the website resolve

Naming inside a product is decided on its own merits, not for BIDS conformance, but entity-matched filenames remain the cheapest resolver for a viewer that already matches `channels.tsv` by entities.
Per recording the product holds one directory keyed by the recording's BIDS path stem: `sub-01/eeg/sub-01_task-rest_eeg/` containing `channels.tsv`, `segments.tsv`, `filters.json`, `qc.json`, `asr_calibration.json`, `asr_M.tsv`, `asr_T.tsv`, `ica.json`, `ica_unmixing.tsv`, `ica_mixing.tsv`, `ica_pca.tsv`, `ica_components.tsv`, `signalJourney.json`.
The viewer computes the directory from the recording path it is showing, fetches `manifest.json` once, and reads what the manifest names; the guard on `source_commit` equality with the Zarr index (v1 G.3) stands.
The website QA tab reads the dataset-level record at the fixed logical path for the dataset's latest version.

### C.7 The dataset-level record

Name: `desc-<recipelabel>_signalJourney.json` at the product root, served as `.nemar/desc-datasetQA_signalJourney.json` (C.10), a valid signalJourney document with `pipelineInfo.name = <recipe>`, `pipelineInfo.version = <rv>`, one `processingSteps[]` entry per recipe step at the dataset level (`inputSources[]` = the dataset version by DOI and `source_commit`), `summaryMetrics` holding the aggregates, and `extensions.nemar` holding identity and the per-recording summary table.

| Section | Content | Tier 1 (always) | Held dataset |
|---|---|---|---|
| identity | `dataset_id, vtag, source_commit, recipe_id, recipe_version, engine (per step), image digests, run_id, product_id, status (published / held / provisional), doi` | yes | yes, `status: held`, no DOI |
| aggregates (`summaryMetrics`) | distributions (histogram bins) of % good channels, % good samples, line-noise dB before/after, ICA convergence rate, % brain components, per-modality counts; counts of recordings `succeeded/failed/skipped`; the #1198 envelope fields | yes | yes |
| per-recording summary table | one row per recording: path, modality, n_channels, duration, resolved-plan hash, status, 6 scalar QC values | yes for published; **for held: scalars only, no masks, no channel names, no segment lists** | rows reduced to path, status and scalar QC |
| references | the product manifest path and per-recording record paths | yes | omitted (would advertise held keys) |
| size bound | 256 KB; above it the per-recording table is truncated with `truncated: n` and the full table is an artifact in the product | | |

Relation to #1198: the envelope fields (`process, engine_version, source_commit, started_utc, finished_utc, discovered_count, succeeded_count, failed_count, pending_count`, per-record `path, status, code, reason`) live in `extensions.nemar.report`, so the record **is** the second instance of the process-report envelope and `report.json` from v1 is folded into it.

### C.8 Worked tree (BIDS-like names, C.10)

```
s3://nemar/nm000396/.nemar/nemarproc/nemar-ica@1.0.0/v1.0.0/
  manifest.json                          capability list: path, size, sha256 for every file below
  desc-nemarica_signalJourney.json       dataset-level record (no sub- entity = dataset scope); served logically as
                                         /nm000396/v1.0.0/.nemar/desc-datasetQA_signalJourney.json
  recipe.yaml                            the recipe as run; image digests for cpu and cuda flavors; seeds policy
  sub-01/ses-01/eeg/
    sub-01_ses-01_task-rest_desc-nemarica_signalJourney.json   per-recording record: resolved plan, rules fired, engines,
                                                               device, seeds, inputs (annex key), outputs (sha256, shape)
    sub-01_ses-01_task-rest_desc-nemarica_channels.tsv         BIDS suffix: name, type, status, status_description (+ nemar_reason, nemar_score)
    sub-01_ses-01_task-rest_desc-nemarica_badsegments.tsv      onset, duration, label, nemar_reason, nemar_zscore
    sub-01_ses-01_task-rest_desc-nemarica_filters.json         drift kernel design, line frequency, method, dB before/after
    sub-01_ses-01_task-rest_desc-nemarica_qc.json              scalar and vector QC
    sub-01_ses-01_task-rest_desc-nemarica_asr.json             srate, channel order, cutoff, B, A
    sub-01_ses-01_task-rest_desc-nemarica_asrmix.tsv           ASR mixing/threshold matrices (M, T)
    sub-01_ses-01_task-rest_desc-nemarica_ica.json             engine pamica 0.4.0, backend and device, n_models 1, n_mix 3, rank, seed, threads,
                                                               n_iter, stop_reason, did_converge, best_iter, LL_best, channel order, average-reference flag
    sub-01_ses-01_task-rest_desc-nemarica_unmixing.tsv         r x N (W S combined)
    sub-01_ses-01_task-rest_desc-nemarica_mixing.tsv           N x r
    sub-01_ses-01_task-rest_desc-nemarica_pca.tsv              N x r (present when rank-reduced)
    sub-01_ses-01_task-rest_desc-nemarica_density.json         alpha, mu, sbeta, rho, c, gm (audit state, small)
    sub-01_ses-01_task-rest_desc-nemarica_components.tsv       component, variance_fraction, label, probabilities
  sub-02/...

s3://nemar/held/nm000401/.nemar/nemarproc/nemar-ica@1.0.0/v1.0.0/     (an ND-licensed dataset, option a)
  manifest.json, recipe.yaml, sub-*/...                              identical layout, not publicly readable
s3://nemar/nm000401/.nemar/nemarproc/nemar-ica@1.0.0/v1.0.0/
  desc-nemarica_signalJourney.json                                   tier 1 only, status: held, reduced shape
```

### C.9 signalJourney changes implied (revises v1 D.3)

| Change | Why |
|---|---|
| Define the `nemar` namespace with two profiles: `recording` (identity, engines, device, seeds, inputs, outputs with `sha256, size, shape, dtype, rowLabels, columnLabels`) and `dataset` (identity, `report` envelope, per-recording summary table, references) | the namespace is empty today; the dataset-level form has only `summaryMetrics` |
| Add an optional `artifact` object on `outputTargets[]` and `inputSources[]` | checksum and orientation for matrices |
| Specify the dataset-level record: naming (`desc-<recipelabel>_signalJourney.json` at the product root, alias `desc-datasetQA_signalJourney.json`, C.10), that `inputSources` may name a dataset by DOI, and a `childRecords[]` reference list | `docs/bids.md` mentions the form; the schema does not describe it |
| Size policy: inline data under 64 KB, otherwise reference | the README's inline-weights claim |
| Validator: `dependsOn` graph, `outputId` resolution, `--verify` of `artifact.sha256`, a `--dataset-record` mode that checks the child references resolve | JSON Schema only today |
| Publish `signaljourney-validator`; fix the two invalid NEMAR example copies; a BEP028 PROV mapping note | unchanged from v1 |

### C.10 BIDS-like file names (owner request: an entity that can carry the dataset-level QA record)

**What was checked (2026-10-12).**
- **BIDS file-name grammar** (common principles, current spec): "a chain of entity instances and a suffix all separated by underscores, and an extension"; an entity is a hyphen-separated key-label pair; a suffix is an alphanumeric string after the last entity; labels are alphanumeric (and may contain `+`); no recognized BIDS file may start with a dot; non-standard entities "SHOULD conform to BIDS-style naming conventions" and non-standard suffixes "SHOULD reflect the nature of the data". By that grammar `<dataset_id>_datasetQA_signalJourney.json` has two bare tokens, so it is not BIDS-like. The dataset identity also never appears in a BIDS file name (it lives in `dataset_description.json`).
- **The `desc` entity** exists for exactly this: "when necessary to distinguish two files that do not otherwise have a distinguishing entity ... only applicable to derivative data" (verified in the master schema, `entities.yaml`). The master schema has no quality-control, ICA or statistics suffix and no `qc` entity.
- **Scope in BIDS is carried by which entities are present**, not by a word: a file with no `sub-` entity at the dataset root applies to the dataset (the inheritance principle), and root metadata files are suffix-only (`participants.tsv`, `dataset_description.json`).
- **signalJourney's own rule** (`docs/bids.md`): a per-data-file record mirrors the source file's BIDS name with the suffix replaced by `_signalJourney.json` (`<source_entities>_desc-<description>_signalJourney.json`); pipeline-level records sit at the root of the pipeline directory with no fixed name; and signalJourney already defines `summaryMetrics` ("summary quality metrics ... across pipeline or dataset") beside per-step `qualityMetrics` (`docs/specification/fields.md`), so a dataset-level record with dataset QA is the same document type at the other resolution, not a different one.
- **BIDS-Prov (BEP 028).** State: `bids-specification` pull request 2099 is **still open** (last updated 2026-09-22; verified with `gh pr view`), although the BEP repository README says it is merged. The draft (read from the PR branch): file provenance goes in sidecar keys (`GeneratedBy`, `SidecarGeneratedBy`, `Checksum`); dataset provenance goes in `dataset_description.json` `GeneratedBy` (required for derivative datasets) and in a `prov/` directory of files named `prov-<label>_<suffix>.json` with suffixes `act` (activities), `io` (inputs and outputs), `soft` (software) and `env` (environments), plus a `prov/provenance.tsv` label table. It describes what was done, retrospectively, in W3C PROV terms; it has no place for quality results. So it is the right vocabulary for an export of the provenance half, not a home for QA.

**Proposal (all names valid under the grammar; no new entity).**

| Role | Name | Why |
|---|---|---|
| Per-recording record | `sub-01_ses-01_task-rest_run-1_desc-nemarica_signalJourney.json` | signalJourney's rule: the source recording's entities, the product identity in `desc`, suffix `signalJourney` |
| Per-recording BIDS-standard state | `..._desc-nemarica_channels.tsv` (standard suffix `channels`, with its standard `status` and `status_description` columns holding bad channels) | the one piece of the state that BIDS already has a home for |
| Per-recording other state | `..._desc-nemarica_badsegments.tsv`, `_asr.json`, `_asrmix.tsv`, `_ica.json`, `_unmixing.tsv`, `_mixing.tsv`, `_pca.tsv`, `_components.tsv`, `_density.json`, `_filters.json`, `_qc.json` | non-standard suffixes that name the nature of the data, as BIDS asks |
| Dataset-level record of a product | `desc-nemarica_signalJourney.json` at the product root (no `sub-` entity = dataset scope) | scope by the BIDS rule; the same suffix as the per-recording record |
| Dataset-level QA alias served to the website | `/<id>/<vtag>/.nemar/desc-datasetQA_signalJourney.json`, resolved by the data plane to the newest published product's dataset-level record | the owner's word `datasetQA` becomes the `desc` label, and the dataset identity moves inside the record (`sourceDatasets`, DOI, `source_commit`) where BIDS keeps it |
| Optional BEP 028 export | `prov/prov-nemarica_act.json`, `_soft.json`, `_env.json`, `_io.json` plus `prov/provenance.tsv`, generated from the signalJourney records on request | aligns with the draft standard without depending on it; the PR is still open |

Details: the `desc` label is the recipe id with its hyphen removed (`nemar-ica` becomes `nemarica`, because labels are alphanumeric); the recipe version and the dataset version live in the directory names (`nemar-ica@1.0.0/v1.0.0/`) and inside every record, not in file names; per-recording state sits under `sub-*/ses-*/eeg/` exactly as a BIDS derivative would, replacing C.8's per-recording directories.
Alternatives rejected: a new `qa-` or `level-` entity (nothing in the BIDS toolchain would know it and it needs its own documentation), a `group_` bare prefix (not grammatical), and the `prov-` entity for QA (it means provenance).
Open to the owner: whether the alias should instead be suffix-only like `participants.tsv` (for example `.nemar/qa.json`); the cost is that the record would no longer be a `signalJourney` file by name.

### C.11 Git-resident products, versioning, and what a DOI points at (fourth owner round; supersedes "nothing in git")

**Owner direction.** Everything lives under `.nemar/nemarproc/`; the QA record is in git under `.nemar/`; the DOI is for the signalJourney records, with the artifacts retained beside them ("they are not much anyways"); the preferred shape is a DOI for only the `.nemar/nemarproc/` portion that is linked to the dataset version ("the correct way"), and the open question was how to handle that in git.

**Facts read from the code on 2026-10-12.**
1. A dataset version is a git tag matching `^v\d+\.\d+\.\d+(-(rc|alpha|beta)\d*)?$` (anchored: `routes/webhooks/github.ts` L147; `VERSION_TAG_RE` in `services/data-router.ts` L44 is `^v\d+\.\d+\.\d+$`). The version DOI workflow dispatches only for such a tag. A tag that merely starts with `v1.0.0` but has more after it (`v1.0.0.P.nemarica.1.0.0`) matches neither, so it would not mint a dataset-version DOI or be served as a dataset version.
2. The tag ruleset "Protect version tags" covers `refs/tags/v*` with the rules `deletion` and `update` and no creation rule (`services/github/branch-protection.ts` L52-60). A product tag outside `v*` is not covered unless the ruleset gains a second include pattern.
3. `looksLikeTagRef` is the unanchored `/^v\d/` (`services/dataset-reindex.ts` L498), and `nemar-tools/scripts/bump_dataset_version.py` and `generate_nemar_metadata.py` read "the latest git tag" by a pattern I did not audit; a product tag beginning `v<digit>` is therefore a collision risk with legacy tooling.
4. The "BIDS Validation" shim runs on pushes to `main` and on pull requests to `main` only; enrichment dispatches only when a push touches `README.md` or `dataset_description.json` (`ENRICHMENT_TRIGGER_PATHS`). A push to any other branch runs neither; a `.nemar/**` commit on `main` costs one validation dispatch.
5. `.nemar/metadata.json` and `.nemar/availability-report.json` are committed to `main` by the GitHub App through the Contents API, one file per call, with the App as a bypass actor on main's ruleset (`services/availability-report.ts`, `services/github/branch-protection.ts` L80-86 and L157-159).
6. **Not traced:** whether the version manifest and the archives of later tags would carry `.nemar/**` from `main` into every later dataset version. If products live on `main` they would; the side branch below makes the question moot. SP-G measures it anyway.

**The design that satisfies all four directions.**

| Question | Answer |
|---|---|
| Where do products live in git? | On a side branch `nemarproc` of `nemarDatasets/<id>` whose tree holds only `.nemar/nemarproc/<recipe>@<rv>/<vtag>/...` (an orphan root, no dataset files); one commit per product, parent = the previous product commit. Pushes to it trigger no validation, enrichment or version workflow, main's protection does not apply, and no later dataset version's tree, manifest or archive can pick it up |
| Where is the QA record on `main`? | `.nemar/desc-datasetQA_signalJourney.json` (at most 256 KB), the tier-1 record of the newest product, committed by the App like `availability-report.json`; it carries `source_commit`, the product tag, the subtree SHA and the DOI when minted. Written by a capped nightly batch (the availability sweep's 30-per-run precedent), byte-identical to the product's own record. For held datasets it is the reduced shape, which is safe in a public repository |
| What does a DOI point at? | **The subtree.** The identity is (repository, product tag, path `.nemar/nemarproc/<recipe>@<rv>/<vtag>/`), and its integrity is the subtree's git tree SHA, a hash of exactly that directory, independent of anything else in the repository (git trees are content-addressed). The landing page presents the signalJourney records; the download is `git archive` of that subtree at the tag, built by our own endpoint. DataCite metadata carries `IsDerivedFrom` the dataset version DOI (whose tag commit is the record's `source_commit`) and `IsCompiledBy` the software, and the tree SHA as an alternate identifier |
| Is the owner's other option (tag the whole repository state as `v1.0.0.P.xxx` including results) different? | At the git level it is the same act, a tag on a commit. The difference is only what the DOI claims. We claim the subtree. Because the `nemarproc` branch contains nothing else, the tag's whole tree is exactly the set of products to date, so the two options coincide in practice, and a reader of the tag never sees a half-claimed dataset |
| How are products versioned? | Product identity is (dataset `vtag`, recipe id, recipe version); a product is immutable, a fix is a new recipe patch version. The tag is plumbing: `nemarproc/<vtag>/<recipe>@<rv>` (for example `nemarproc/v1.0.0/nemar-ica@1.0.0`). The human-facing form is the DOI `10.82901/NEMAR.<ID>.P.<RECIPE>.V<n>`. A `v`-prefixed tag would inherit the existing immutability ruleset for free but collides with fact 3; the `nemarproc/` prefix needs a second include pattern in `applyTagProtection` for new repositories and a one-time per-repository ruleset call for the existing ones (an API call each, not a workflow edit, but still a bulk write to be done with a dry run and a canary) |
| How do viewers and the data plane read it? | Git-keyed files in the product manifest are served as dataset files are today (ADR 0066's brokered git path, now pointed at the tag); anything over budget carries an `s3:` key. The product manifest stays the capability list (second manifest, amending ADR 0066) |
| What is retained? | Everything, forever (owner). The "receipt" idea is dropped; superseded products stay as tags. Git history is permanent, so a wrong product is superseded by a new recipe version, never rewritten |
| What happens to held datasets? | Tier 2 cannot go into a public repository, so it stays in S3 `held/` (settled); git carries only the tier-1 record on `main`. On promotion the product is committed to the `nemarproc` branch from the held copy, then tagged and minted |

**Size, because "not much" is true for the median and false for the tail.**
The median catalog dataset has 65 recordings; at about 15 small files each that is about 1,000 files and about 10 MB, which git holds easily.
The tail does not fit: I-CARE `nm000289` has 36,123 recordings (about 540,000 files), SeizeIT2 `on005873` 11,009, the Penn dataset `on004395` 6,483.
Proposed budget, provisional until SP-G measures it: a product is committed as individual BIDS-named files when it has at most 5,000 files and 50 MB; above that, the per-recording signalJourney records (the DOI'd content) are bundled into JSON Lines files of 1,000 recordings each and committed, and the bulky artifacts (unmixing, mixing, PCA and ASR matrices) stay in S3 with their sha256 in the manifest.
Retention still holds because S3 keeps them; what changes is only whether a byte lives in git.

**Write path.**
The Worker commits (it already holds the App); the runner never receives a GitHub credential, which keeps a runner bug from reaching about 850 repositories.
Many small files cannot be written one Contents-API call each (the blobs endpoint spends the 5,000 per hour budget); the Git Data API accepts a tree with inline file contents, which makes one product a handful of calls (documented limits of 100,000 entries and 7 MB per request, to be confirmed in SP-G), chunked for larger ones.
The Worker's verify-and-promote step reads the product from S3 staging, checks it against the manifest, commits the branch, tags it and only then mints.
Fences: dataset id validated against the registry, the branch name and path prefix fixed in code, a dry run, and the first real run on `nm099999`.

**What this changes elsewhere in the document.**
C.2's physical column (S3 as the primary home) is replaced for tier 2 by "git branch `nemarproc`, S3 for staging, held products, overflow and the serving copy"; C.1's "nothing in git" is superseded; the namespace ADR in I.2 records git as the home; SP-N gains SP-G below; E states the DOI's scope as the subtree.

---

## D. Provenance (delta from v1)

Unchanged in shape; three additions: `engine` is a list per step (`eegprep`, `mne`, `pamica`, `mne-icalabel`), `device` is recorded per decomposition, and the dataset-level record carries the #1198 envelope.
The registry stamp becomes `(dataset_id, vtag, recipe_id, recipe_version, engine_set_version, image_digest_cpu, image_digest_cuda)`; a device-class change re-runs nothing when the fixture tolerance holds (B.6).

---

## E. DOI (finalized for the new layout)

| Item | Decision |
|---|---|
| Identifiers | concept `10.82901/NEMAR.<ID>.P.<RECIPE>`, product `...P.<RECIPE>.V<n>` (accepted) |
| Landing page | `https://nemar.org/dataset/<id>/nemarproc/<recipe>` (concept, resolves to the latest published product) and `.../nemarproc/<recipe>/<n>` (product); the page shows the dataset-level record, the citation, the source citation, and the tier state |
| What the DOI is for | the signalJourney records (owner); the artifacts are retained in the same subtree and described as supplementary on the landing page. The cited object is the subtree `.nemar/nemarproc/<recipe>@<rv>/<vtag>/` at the product tag `nemarproc/<vtag>/<recipe>@<rv>` on the dataset repository's `nemarproc` branch (C.11) |
| DataCite target | the product landing page; `alternateIdentifiers` carry `product_id`, the manifest's logical URL, the product tag and the subtree's git tree SHA |
| Creators and contributors | NEMAR organizational creator only (owner), with the Swartz Center for Computational Neuroscience as affiliation by its ROR identifier `https://ror.org/01bt2qm76`, the identifier the DataCite builder already uses as the publisher's (verified: `backend/src/services/datacite.ts` L1621); no named recipe authors as creators; original authors `DataCollector`; as v1 E.3 |
| Relations | `IsDerivedFrom` source version DOI; `IsCompiledBy` pamica and eegprep (release URLs, or DOIs when they exist); `IsVersionOf` the concept; `IsSourceOf` added to the source record by the existing sync |
| Mint gate | unchanged: public source, non-anonymous, license-eligible (tier 2), at least 90% of eligible recordings succeeded, fixtures green. "Run for all" does not conflict: a held product is processed, never published, so it never reaches the gate; a tier-1 record alone is not a citable product and gets no DOI |
| Citation surfaces | the QA tab shows "Processed by NEMAR recipe X version Y" for every dataset and the DOI block only for a published product; CLI, MCP and the data plane as v1 E.6 |

---

## F. Published datasets are live; the five-dataset rule is superseded

**Owner (third round):** the `nm000103`-`nm000107` rule dates from when the archive had five datasets; there are far more now (858 public datasets in the catalog on 2026-10-12, verified), so supersede those notes and give the five no special status.

**What the hard rule protects (verified: AGENTS.md L149-L151, L241):** the catalog visibility, the annexed bytes under `<id>/objects/` (Object Lock governance, 100 years, applies only there; verified `s3.ts` L65, L1131-1134), the version manifests, the DOIs and the repository settings of a dataset that real users cite.
That reasoning holds for every published dataset, not five, so the rule is generalized and the ids are dropped.

**What a product write touches:** new keys under `<id>/.nemar/nemarproc/` (and `held/<id>/.nemar/nemarproc/` for held products), written by a credential scoped to `*/.nemar/nemarproc/*` and `held/*` (the existing `nemar-hallu-zarr-dev` user is the precedent for a kind-scoped IAM policy, verified: systems inventory), promoted by the Worker, plus a registry row.
No existing key is overwritten, no repository setting or DOI changes, and the dataset page gains a panel; an additive, prefix-scoped write is not what the rule protects.

**Residual risks, honestly:** the runner is new (a bug could write under the wrong id; the credential's resource pattern and the Worker's id validation bound it); the per-version index becomes visible on public dataset pages (a wrong product is a public embarrassment, not data loss); the data-plane route is new (a gate regression would be the real exposure, so it is tested on fixtures first).

**Sequencing:** fixtures (`nm099999`, `xx0999NN`) until SP-N and SP-H pass on staging; then a pilot cohort of about 20 production EEG datasets chosen by format, channel count and sampling rate, with no dataset excluded or included by id; then the catalog pass.

**AGENTS.md changes (same pull request as the ADR; nothing edited now):**

1. In "Live datasets", replace the opening with:

> **Every published dataset is LIVE.** Do NOT modify a published dataset's visibility, its annexed data under `<id>/objects/`, its version manifests, its DOIs, or its repository settings during development or testing; use `nm099999` and the `xx0999NN` exemplars for tests.
> First-party processing products under `<id>/.nemar/nemarproc/` and `held/<id>/.nemar/nemarproc/` are additive, written only by the processing credential scoped to those prefixes and promoted by the Worker after verification (ADR 00xx); they are not what this rule protects. A product written by any other path, or anything that rewrites an existing key under a published prefix, is still a violation.

   and delete the sentences about the five datasets being public (the "verified 2026-09-14" paragraph).

2. In the "Dataset ID bands" table, change the `nm000001`-`nm000107` row's note from "`nm000103`-`nm000107` are LIVE" to "predate `START_NUMBER`; published like any other dataset" (cleanup stays "never").

3. Outside this repository, `~/Documents/git/nemar/CLAUDE.md` lists `nm000103`-`nm000107` as live in two places; it is the owner's workspace file and is flagged here, not changed.

---

## G. Publication policy: run for all, two tiers, and the held tier's home

### G.1 The owner's ruling, restated

Every public dataset version with EEG recordings is processed in the first release, and the other modalities join as they are built (second-round ruling).
Tier 1 (dataset-level QA record) is published for every processed dataset and feeds the QA tab.
Tier 2 (per-recording state, overlays, DOI) is published only when the dataset's license tier is `public`, `attribution`, `sharealike` or `noncommercial`; for `noderiv` (26) and `unknown` (16, including `GPL-3.0` on 4) the tier-2 product is held: computed, stored, never advertised, never served anonymously, no DOI.
The legal question of what ND binds is not argued here, per the owner.

### G.2 Source of truth for public read, and what is unknown

The bucket is **public-by-default with per-dataset exclusions**: one statement `PublicReadExceptPrivate`, `Allow Principal:* s3:GetObject`, `NotResource = ["arn:aws:s3:::nemar/staging/*", "arn:aws:s3:::nemar/<privateId>/*", ...]` (verified: `bucket-policy.ts`).
An allowlist was the previous model and hit the 20,480-byte cap at about 149 public datasets (#673, verified in the module header).
A private or unpublished dataset is hidden by both layers: its prefix is carved out of the anonymous grant (policy), and the Worker's visibility gate refuses before any S3 call (ADR 0017/0066).
Each private ARN costs about 33 bytes serialized (`"arn:aws:s3:::nemar/<8-character id>/*", `).

**Measured by the owner, 2026-10-12** with the read-only command below: **4,586 bytes and 127 private prefixes**, against the 20,480-byte cap.
- Headroom is 15,894 bytes: about **480 more private datasets** (33 bytes each), or about **330 per-dataset held entries** of the shape `arn:aws:s3:::nemar/<id>/.nemar/nemarproc/*` (48 bytes each), or any mix.
- The 42 held datasets as per-dataset entries would cost about 2,016 bytes, 12.7% of the remaining headroom.
- The measure is the whole policy document as the command serializes it, which is about 200 bytes more than my reconstruction of the public-read statement alone (4,379 bytes for 127 ids of the standard shape); the difference is unexplained (a second statement, longer ids, or a different `Principal` shape would each do it), so the headroom is "about 15.9 KB" and not an exact figure.
- Consequence for the owner's earlier statement that per-dataset bucket-policy entries are impossible because of the policy size limit: **at today's numbers the limit is not binding for the 42 datasets**; it is a shared budget (every new private dataset and every held dataset spends from the same 20,480 bytes, and a rewrite above the cap is refused by `putBucketPolicy`, which would also fail visibility transitions), and it grows with the catalog, so it decides the shape of the held tier's home (G.4) rather than ruling any option out.

```
aws s3api get-bucket-policy --bucket nemar --query Policy --output text | python3 -c "import sys,json;p=json.load(sys.stdin);s=[x for x in p['Statement'] if x.get('Sid')=='PublicReadExceptPrivate'][0];print(len(json.dumps(p).encode()),'bytes;',len(s['NotResource'])-1,'private prefixes')"
```

### G.3 Precedent: the legacy `qa/` mirror

`data.nemar.org/<id>/qa/*` serves the legacy pipeline's QA tree regardless of license, unversioned, by S3 listing (verified: `routes/data.ts` L2013-2169, #511).
Measured on 2026-10-12 against all 858 public datasets: **32 have a QA tree, all `on*`, 23 CC0 and 9 CC-BY-SA-4.0 (HBN releases); 0 ND, 0 unknown** (`first-party-processing/evidence/qa_license_mix.json`).
The "269 processed datasets" of #511 was the pipeline's 2024 status list (238 `ds` ids, 225 mirrored, 224 of them CC0); only 22 of those are mirrored into `qa/` today, plus the HBN releases handled by a separate script.
So the precedent is narrower than it looked: the legacy mirror has never exposed an ND or unknown-license dataset, and every ND, NC and unknown license in the catalog sits on an `nm*` dataset, none of which has legacy QA.
The two-tier policy is therefore the first time NEMAR publishes any processing output for those 42 datasets, and tier 1 (aggregates only) is the conservative shape to do it in.
The legacy tree stays until the tier-1 record covers its 32 datasets, then the `qa/` route and the hourly mirror are retired.

### G.4 Options for the held tier's home

| Option | Policy bytes | Sweep and anonymity (ADR 0065/0067) | Capability list (ADR 0066/0072/0074) | Promotion when a license is normalized | Cost and simplicity | Verdict |
|---|---|---|---|---|---|---|
| (a) **Exclusion by kind: top-level `held/` prefix** in `NotResource`, added in the builder beside `STAGING_PREFIX` so rewrites keep it | one constant ARN, about 33 bytes, forever | the sweep adds one check: no object under `held/<id>/` answers 200 anonymously; a 403 is the expected verdict, a 200 is a finding, a network error is `unchecked` | held objects are never in a public manifest; staff reads are presigned through an admin route gated on role | server-side `CopyObject` from `held/<id>/.nemar/nemarproc/...` to `<id>/.nemar/nemarproc/...`, registry `held -> published`, then delete the held copy; DOI minted after promotion | no new bucket, no new credential beyond the prefix scope, one constant in code | **recommended** |
| (a') key pattern `*/.nemar/held/*` as the NotResource | same O(1) | same | same | same | the builder's `prefixIdFromArn` rejects ids with `/`, so this needs a second constant list; functionally identical to (a) with a worse fit to the code | acceptable fallback |
| (b) Restructure the public Allow into an allowlist of kinds (`objects/*`, `version/*`, `archives/*`, `zarr/*`, `qa/*`, `.nemar/nemarproc/*`) with private datasets still excluded | about 6 ARNs more than today | same checks | same | same | a rewrite of the model that #673 already migrated away from, with every future kind needing a policy change; the private-dataset carve-out still scales per dataset | not needed; (a) achieves private-by-default for held with one line |
| (c) A second bucket (`nemar-held`, or #1585's private results bucket) | none in the public bucket | the sweep reads a second bucket | a second S3 client configuration in the Worker and the runner | cross-bucket `CopyObject` (supported) | a new bucket, credential and lifecycle to operate; #1585's bucket is for third-party results with 30-day expiry, the wrong retention | reasonable second choice if the owner prefers separation over simplicity |
| (d) A private R2 bucket read only through the Worker | none | same | Worker binding; Hallu and Expanse write with an R2 S3-compatible token scoped to the bucket (no prefix scope exists) | cross-provider copy through the Worker or a runner job | contradicts the spirit of ADR 0076 ("dataset bytes stay in S3") for data that is derived from datasets; egress-free reads are an advantage the held tier does not need | not recommended |
| (e) Public bucket with unguessable per-product prefixes recorded only in the registry | none | protects only against enumeration: anonymous `ListBucket` is denied, but any leaked or logged URL is readable forever, and the data-plane 302 would publish the key | violates the premise that held is not served | trivial | weakest; it does not implement "not published" | rejected |
| (f) Object-level ACL or a Deny with a principal condition | none | n/a | n/a | n/a | ACLs are disabled on this bucket by policy intent; a Deny with `Principal:*` blocks the Worker and the runner unless conditioned on `aws:PrincipalArn`, which is what the module's own header rejected | rejected |
| (g) **Per-dataset exclusion of the process namespace**: while a dataset's product is held, the policy's `NotResource` carries `arn:aws:s3:::nemar/<id>/.nemar/nemarproc/*` beside the private-dataset entries; the product sits at its final key from the start | 48 bytes per held dataset: **2,016 bytes for today's 42**, about 330 held datasets at the measured headroom, grows with the catalog and competes with private-dataset entries for the same 15.9 KB | the sweep checks each held dataset's `.nemar/nemarproc/` answers 403 anonymously; **the sync between the registry's held state and the policy is the single safeguard**: a missed or failed policy write leaves held data publicly readable (fails open) | the manifest still lists nothing for held; staff reads presign as in (a) | **a policy edit only**: remove the ARN, no copy, no key change, no re-pointed manifest or DOI landing path; demotion is adding it back | needs the builder and `prefixIdFromArn` extended to a second entry kind (today any non-id entry is dropped on the next rewrite), one policy write per license transition, and the `putBucketPolicy` size check becomes a processing dependency | viable now that the numbers are known; fails open where (a) fails closed (mitigation: the exclusion is written and probed anonymously before the first byte of the product, and the sweep rechecks); second choice, with (c) |

**Recommendation: (a)**, and what the measurement changed.
Before the measurement the question was whether per-dataset entries fit; the answer is that for 42 datasets they do (option g), so size no longer decides.
What decides is the failure mode and the growth: (a) is private by location, so a bug, a lag or a failed policy write leaves held data unreachable (fails closed), costs 29 bytes once however many datasets are held, and never competes with private-dataset entries for the cap; (g) keeps the promotion path to a single policy edit (no copy, no key change) but is public until the policy says otherwise (fails open) and spends from the shared budget at a rate set by the catalog's ND and unknown-license share (4.9% today).
The cost of (a) is the two-step promotion (copy, verify, delete) already priced in G.5.
**The owner chose (a)** (third round, 2026-10-12); (g) stays above as the considered alternative with the measured numbers behind the choice.

`held/` becomes a second always-excluded top-level prefix next to `staging/` in `buildPublicAccessStatement`; `listPrivateDatasets` already ignores `staging`, and `held` is added to that exclusion so it is never read as a dataset id.
Write identity: the processing IAM user gets `s3:PutObject` on `nemar/held/*` and `nemar/*/.nemar/nemarproc/*`, `GetObject` on `nemar/*/objects/*`, no `ListBucket` beyond its own prefixes.
Read identity: the Worker's existing credentials sign reads of `held/*` for the aggregation step and for a role-gated admin route; anonymous readers get 403 from S3 and 404 from the data plane.
Headroom needed: 29 bytes, once (option g: 48 bytes per held dataset).

### G.5 The two tiers, precisely

| | Tier 1: dataset-level QA | Tier 2: per-recording state |
|---|---|---|
| Published for | every processed dataset version (public, non-anonymous) | license-eligible, non-anonymous datasets only |
| Content | the dataset-level record (C.7): identity, aggregates, distributions, counts, per-recording scalar summary; for held datasets no channel names, masks, segment lists or references | records, masks, matrices, labels, manifest, overlays, DOI |
| Home | `<id>/.nemar/nemarproc/<recipe>@<rv>/<vtag>/desc-<recipelabel>_signalJourney.json` (public prefix) | `<id>/.nemar/nemarproc/...` (published) or `held/<id>/.nemar/nemarproc/...` (held) |
| Access to held | owner and admins through a role-gated admin route that presigns; the Worker for aggregation; the runner's credential for writes | |
| Promotion (unknown license normalized to an eligible tier) | the dataset-level record is rewritten with `status: published` | copy `held/<id>/... -> <id>/...` server-side, verify sha256, registry `held -> published`, delete the held copy, then mint the DOI (late mint unchanged) |
| Demotion (license corrected to ND) | record rewritten to the held shape | copy `<id>/... -> held/<id>/...`, delete the public copy, registry `published -> held`, DOI set `unavailable` with a tombstone reason (DOIs are permanent; the landing page says why) |
| Website | QA tab shows the measures and a line "Processed by NEMAR; per-recording results not published because of the dataset license" | panel plus overlays plus citation |
| Viewer | no overlay; the legend says why | overlays |
| CLI | `nemar dataset derived list` shows `held (license)`; `download --process` refuses with that reason | works |
| MCP | `derived_products[].status: held` with `reason: license` | `published` |
| DOI | none | concept and product DOIs |

### G.6 Anonymous deposits

Excluded from processing entirely while `anonymous = 1`, as in v1 and #1585's proposal, for two reasons that the two-tier policy does not change: a tier-1 record names the dataset and would be a fourth attribution surface the sweep must blind (the `nemar` extension carries `source_commit`, engines and counts that fingerprint the deposit), and the Zarr index already fossilizes attribution until a re-conversion (ADR 0067), so adding a product that must also be re-generated at de-anonymization doubles that debt.
The reconcile excludes `anonymous = 1`; de-anonymization re-queues the dataset through the same `zarr_requeue_at`-style stamp.
The anonymity sweep gains two checks: no object exists under `<id>/.nemar/nemarproc/` or `held/<id>/` for an anonymous dataset (a listing error is `unchecked`), and the data plane answers 404 for `.nemar/nemarproc/` on it.

---

## H. Gaps and holes (revised)

| # | Gap | Sev | Evidence | Cheapest close |
|---|---|---|---|---|
| 1 | pamica cost per device class is measured on a V100 (0.12 SU per recording-hour in float64) and on one EPYC node (13 to 15 core-hours); the CPU figures are extrapolated from 75,000-sample windows, and the Fortran-versus-V100 component equivalence on a real recording has not run | S2 | B.6c, B.6d | the real-recording CPU anchor at 16 threads and the packed single-thread run are queued; both close before an allocation request. The bounded fit window was tested and rejected (B.6c) |
| 2 | eegprep carries only EEG, so iEEG, MEG and EMG have no engine yet | S3 now (was S1) | section A | **deferred by the owner's ruling**: the first release is EEG only; the later road (grow eegprep or add a second engine) is chosen when EEG is in production |
| 3 | Nothing serves `.nemar/nemarproc/` and the bucket has no `held/` exclusion (or per-dataset held entries) | S1 | C.3, G.4 | SP-N and SP-H on staging first |
| 4 | ~~Bucket policy size and private count unknown~~ | closed | G.2 | measured 2026-10-12: 4,586 bytes, 127 private prefixes; 15.9 KB headroom; the held tier's shape stays a choice (G.4 a versus g) |
| 5 | No line-noise removal in eegprep | S1 | v1 H.1 | ZapLine plugin (BSD-3 port from `meegkit`); until it lands the floor measures line noise and records it without removing it |
| 6 | `clean_rawdata` GPL-3 versus eegprep BSD-2 | S1 for image distribution | v1 H.3 | license decision in eegprep |
| 7 | ASR unvalidated on iEEG and MEG; MEG mag/grad pooling | deferred | A | later phase; not in the first release |
| 8 | MEGnet needs magnetometers; CTF/KIT get no labels | deferred | A | later phase; not in the first release |
| 9 | `--nv` passthrough in Tapis unverified | S2 for GPU on Expanse | A | SP-T |
| 10 | pamica state format has no schema or version | S2 | B.5 | upstream U1; the runner writes its own `ica.json` header meanwhile |
| 11 | eegprep AMICA path is the Fortran binary with an open serialization bug | S3 | A | the runner calls pamica directly; U6 upstream |
| 12 | Tier-1 record for held datasets could leak per-recording detail | S2 | C.7 | the reduced shape is enforced by the writer and checked by a test that diff-compares held and published records on a fixture |
| 13 | Promotion and demotion paths are two-step (copy then delete) | S3 | G.5 | the registry holds `promoting`/`demoting` states; reconcile finishes an interrupted transition |
| 14 | Zarr copy is latest-only; version-pinned products need the `source_commit` guard | S2 | v1 H.8 | unchanged |
| 15 | signalJourney dataset-level form is unspecified | S2 | A | C.9 schema work; the runner validates against a vendored schema until upstream merges |
| 16 | Live-dataset wording in AGENTS.md | S3 | F | the drafted paragraph in the ADR PR |
| 17 | ADR 0066's "the manifest is the capability list" sentence does not admit a second manifest, and the `qa/` route already violates it silently | S2 | C.3 | the namespace ADR amends 0066 and retires `qa/` |
| 21 | `.nemar/` doubles as the CLI's local working-state directory and is gitignored locally | S3 | C.5 | products live in the `nemarproc/` sub-directory; the local gitignore is a feature here |
| 22 | Zarr discovery does not exclude dot-directories | S3 | A | add `.nemar` to `EXCLUDED_TREES` and the superset test |
| 18 | GPU image size (3 to 5 GB SIF) and staging on Expanse | S3 | B.6 | stage once per digest; `oras://` push |
| 19 | Determinism across device classes is a tolerance, not bitwise | S3 | B.6 | the contract says so; the fixture gate enforces it |
| 20 | Scientific claims and recipe governance | S2 | v1 H.16, H.17 | unchanged |

---

## I. Decisions

### I.1 Owner answers (2026-10-12, third round) and what is still open

| # | Question | Status |
|---|---|---|
| 1 | Held-tier home | **Settled: (a)** a top-level `held/` prefix, one 29-byte constant in the bucket policy |
| 2 | Rank cap for pamica | **Settled: 64** for the pilot, with a common average reference before ICA (B.5) |
| 3 | GPU or CPU first for ICA at scale | **Decided 2026-10-12 after SP-P: the GPU is the production path and the native Fortran binary on CPU is the fallback** (owner: "go with GPU, CPU Fortran as the fallback"). Basis (B.6d): about 105 times cheaper in SU per recording-hour, similar campaign calendar time at the account caps, and a 10-second `gpu-shared` start against hours on `shared`. The fallback covers short jobs and any period when the GPU pool is unavailable |
| 4 | Mirror the dataset-level record into git | **Settled: yes** (owner: "we need to have the QA in git under .nemar"); C.11 |
| 5 | Recipe authors as DataCite creators | **Settled: NEMAR only**, affiliation SCCN by ROR |
| 6 | Retention | **Settled: retain everything** (owner: the artifacts are not much); the receipt idea is dropped |
| 7 | Live datasets in the first cohort | **Settled: no special status**; supersede the `nm000103`-`nm000107` notes (F) |
| 8 | Two scientific reviewers | **Settled: Haiku or Sonnet agents** (owner), under the rule below |
| 9 | Dataset-level record file name | **Accepted** ("yes that sounds good"): C.10 |
| 10 | Where products and the DOI live in git, and the product tag | **Open; suggestion in #1750**: side branch `nemarproc`, tag `nemarproc/<vtag>/<recipe>@<rv>`, DOI on the subtree (C.11) |
| 11 | How large a product may be before it leaves git | **Open; suggestion in #1751**: up to 5,000 files and 50 MB as individual files; above that, JSON Lines bundles of 1,000 recordings in git and the matrices in S3 (C.11) |
| 12 | Stable name of the dataset QA record | **Open; suggestion in #1752**: `.nemar/desc-datasetQA_signalJourney.json` (C.10, C.11) |
| 13 | Precision of production ICA fits | **Decided: float64** (owner, 2026-10-12: "float64 is good"). A full GPU pass costs about 16,000 SU (a negligible share of the allocation), float64 keeps the CPU fallback inside the cross-device tolerance contract, and the float32 equivalence measured so far covers one recording (B.6c). float32 stays a later option once more recordings are checked |

**Items 4 and 6, resolved by the fourth round.**
The QA record is mirrored into git on `main`, and products themselves are committed to the `nemarproc` side branch (C.11); the costs I listed for a mirror (a commit per dataset per recipe version, validation re-runs, a second copy that can drift) are accepted and bounded by the capped nightly batch and by making the git copy the DOI'd one rather than a duplicate.
Everything is retained; the one new cost is size at the tail (C.11), handled by the file-count and byte budget.

**Item 8, reviewers: Haiku or Sonnet agents (owner), under this rule.**
A recipe version below `1.0.0` is provisional: its products are labeled provisional and carry no DOI.
Activating `1.0.0` (the first DOI-eligible version) needs two recorded review sign-offs in `recipes/CHANGELOG.md`, each by a separate agent run (Haiku or Sonnet), recording the model id, the date, a hash of the exact inputs (recipe, fixtures, QA outputs) and the findings, with the owner activating.
These are automated reviews, so the DOI landing page and the record state "reviewed by automated agents (model ids)" and do not imply independent human validation; the owner can add a human reviewer at any time without changing the rule.

Still needed from the owner: items 10 to 12.
The owner answered "I don't know" and asked for an issue per question with a suggestion (#1750, #1751, #1752); the plan assumes the suggestions until they are answered, and none of them blocks the compute work (the pamica and eegprep runner stages products in S3 first).
The go-ahead for `shared` and `gpu-shared` was given and used (B.6d); the A100 arm is parked (B.6c).

### I.2 ADR candidates (revised and new)

Carried from v1 with wording updated: NEMAR runs first-party processing off the Worker (supersedes ADR 0049's "does not run it for them"); a derived product is state, not a copy; a product is keyed to (dataset version, recipe version, engine set) and only a change of meaning re-runs it; adaptivity is a rule set inside one recipe; a derived product has its own DOI with NEMAR as creator and a late mint; line noise is removed by a BSD-licensed ZapLine; third-party code reaches shared HPC only inside a NEMAR-built image.

**New: Processing products live under the `.nemar/nemarproc/` namespace; published products are committed to a side branch `nemarproc` of the dataset repository, and a DOI points at the product's subtree.**
The tree of the `nemarproc` branch holds only `.nemar/nemarproc/<recipe>@<rv>/<vtag>/...`; each product is one commit and one tag `nemarproc/<vtag>/<recipe>@<rv>`; the DOI's identity is (repository, tag, subtree path) with the subtree's git tree SHA as its integrity value; the tier-1 QA record `desc-datasetQA_signalJourney.json` is also committed to `main` under `.nemar/`; S3 holds staging, the serving copy, over-budget bulk and the held tier.
The Worker commits (the runner never holds a GitHub credential); a product is immutable and is superseded, never rewritten.

**New: pamica is the decomposition engine, single model, rank-reduced, with a device-class tolerance contract.**
`n_models = 1`, `n_mix = 3`, PCA to `min(rank, 64)`, fixed seed; CPU float64 and CUDA float64 are each bit-reproducible with themselves and are equivalent across device classes when the fixture gate's tolerance holds; a product records which device produced it; MLX never produces a product.

**New: The first release is EEG only and eegprep only; a step names its engine, and an unvalidated application is recorded, never silent.**
The recipe schema carries an `engine:` field per step (`eegprep` or `pamica` in the first release) and the runner holds its representation behind one internal interface, so iEEG, MEG and EMG are an addition after EEG is in production and not a redesign; which engine carries them is decided then.

**New: Every public EEG dataset is processed (other modalities follow); dataset-level QA is always published; per-recording state is published only under a license that allows derivatives and is otherwise held.**
In the recommended form (option a) the held tier is excluded from anonymous read by one top-level `held/` `NotResource` ARN added in the policy builder (29 bytes once), written by a prefix-scoped credential, readable by staff through a role-gated route, promoted by server-side copy when a license is normalized, and verified unreachable by the sweep; in the alternative form (option g) it is a per-dataset `<id>/.nemar/nemarproc/*` exclusion (48 bytes each, 2,016 for today's 42), promoted by one policy edit.
The ADR records whichever the owner picks and the measured baseline (4,586 of 20,480 bytes, 127 private prefixes, 2026-10-12).

**New: Live datasets receive products like any other public dataset once the runner has passed its fixture gates.**
The hard rule in AGENTS.md is reworded to name what it protects; an additive write under `<id>/.nemar/nemarproc/` by the processing credential is not a modification of a live dataset's data, visibility, DOIs or settings.

---

## J. Plan (DRAFT; no epic filed)

### J.1 Spikes with pre-registered go/no-go

| Spike | Question | Go | No-go consequence |
|---|---|---|---|
| SP-P AMICA cost per device class | **Stage 1 and the CPU arm are done (B.6c, B.6d); verdict by R1 and R2: GPU production, native Fortran CPU fallback (owner, 2026-10-12).** Still queued on Expanse: Fortran against the V100 anchors on the real recording at 16 threads, and packed single-thread CPU fits (R5). Not run: A100 nodes (no Lustre), SP-T (containers, Tapis). **Pre-registered** in `first-party-processing/sp-p/PREREG.md` (decision rules R1 to R5), first stage on the `debug` and `gpu-debug` partitions only (30-minute cap, nothing on a login node). Arms: the native Fortran binary (pamica release, single process, OpenMP, no MPI) against pamica torch-CPU on one 128-core EPYC node; pamica torch on one V100 in float64 and float32; a block-size x channels x samples grid with peak GPU memory; N concurrent fits on one GPU; P independent single-thread fits on one node; a real-data cross-check on ds002718 sub-002 against pamica's own 4090 figures. Next stage: component equivalence across backends and device classes at 2,000 iterations (the V100 anchors exist and the Fortran anchor is queued), real EEG from the NFS mirror, and the A100 nodes (parked: no Lustre); the bounded fit window was tested and rejected in B.6c | R1 (Fortran at least 1.5x faster than torch-CPU: use the native backend on CPU), R2 (GPU only if 3x cheaper in SU per fitted hour or 4x faster at similar SU), R3 (block size by lowest s/iter, ties to the larger), R4 (pack N per GPU if aggregate throughput rises 1.3x), R5 (CPU node price from the packed throughput) | moot: the GPU won R2 by about 105 times in SU (had no backend won, torch-CPU float64 on `shared` would have been the default) |
| ~~SP-M MEG and iEEG path~~ | **deferred by the owner's ruling**: iEEG, MEG and EMG follow after EEG QA and processing are in production; the question (grow eegprep or add a second engine) is asked then | n/a | n/a |
| SP-N `.nemar/nemarproc/` data plane | product manifest, logical route, per-version index on `data-test.nemar.org`; the five rules; private-flip 404; separate cache namespace; `.nemar` in `EXCLUDED_TREES` with the superset test | live tests pass | redesign the route before anything is public |
| SP-G git-resident product | on `nm099999` and one `xx0999NN`: create the orphan `nemarproc` branch; commit fixture products of 1, 65 (the median) and about 2,000 recordings with a tree-with-inline-content request; tag; `git archive` the subtree and compare its tree SHA with the recorded one; count API calls, wall time and rate-limit spend; confirm that the push runs no workflow; confirm what a `.nemar/` file on `main` does to the next version's manifest and GitHub archive; confirm the Git Data API limits (100,000 entries, 7 MB per request); try the tag-ruleset second include pattern on a scratch repository | all hold, at most 10 API calls for the median product, no dispatch | S3-only products with a git pointer record, or commit under a path the manifest excludes |
| SP-H held tier | whichever of (a) `held/` exclusion or (g) per-dataset `.nemar/nemarproc/*` exclusion the owner picks, built in the builder on the dev bucket; policy size measured before and after (production baseline 4,586 bytes, 127 private prefixes); a held object is 403 anonymously, 404 on every public route including the data plane, `manifest.json`, the Zarr host and the MCP; readable by the runner credential and by the Worker's signed read; for (a) the promotion copy and demotion copy round-trip on a fixture, for (g) the exclusion add and remove round-trip with the anonymous probe before the first byte | all hold; policy grows by one ARN for (a) or 48 bytes per held dataset for (g) | choose (c) a second bucket |
| SP-T Tapis GPU | a `gpu-shared` job through Tapis with `--gpus=1` and `--nv` reaching a CUDA-visible torch inside the SIF | `torch.cuda.is_available()` true inside the job | run GPU chunks by direct Slurm submission from the community account, or CPU only |
| SP-F floor headless | as v1 SP1, EEG only (BDF, EDF, BrainVision, EEGLAB `.set`; the formats eegprep reads) | as v1 | as v1 |
| SP-Z line noise, SP-D determinism, SP-S signalJourney (now with the dataset-level profile), SP-DOI | as v1 | as v1 | as v1 |

### J.2 Smallest first increment

On staging: `nemar-floor@0.1.0` on `xx099905` (EEG, 5 BDF recordings) and one more EEG exemplar in a different format, through the Hallu test instance (CPU), products at `s3://nemar-dev/<id>/.nemar/nemarproc/...`, the dataset-level record served at the logical path, the QA tab on `test.nemar.org` reading it, bad channels overlaid in the staging viewer, one exemplar forced into the held tier to prove the two shapes, and `nm099999` through the same path as the end-to-end test.
No DOI, no production data, no live prefix.

### J.3 Phased delivery

| Phase | Content | Depends on |
|---|---|---|
| 0 | ADRs (I.2), AGENTS.md wording, #1585 P0, #1198 envelope agreed, the owner's policy-size command run | nothing |
| 1 | `nemar-process` scaffold (E below), `nemar-floor@0.1.0` for EEG, CPU image, fixtures, SP-F, SP-D | nothing |
| 2 | registry, product manifest contract, `.nemar/nemarproc/` route and index, held-tier mechanism (a or g, per the owner), Hallu adapter, SP-N, SP-H, SP-S | phase 1 |
| 3 | website QA tab on the dataset-level record (replacing the legacy panel's role), viewer overlays, CLI `derived`/`--process`, MCP fields, docs | phase 2 contract |
| 4 | floor pilot on 20 production EEG datasets chosen across formats, channel counts and sampling rates (Hallu CPU); held tier exercised on at least two ND datasets (all 26 ND datasets are EEG) | phases 2 and 3 |
| 5 | pamica: SP-P, CUDA image, SP-T, `nemar-ica@1.0.0` pilot on GPU through Tapis | #1585 G3/G4, SDSC answers |
| 6 | DOI minting (SP-DOI), promotion/demotion tooling, retention | phase 4 green |
| 7 | catalog pass: floor (CPU), then ICA (GPU); retire the legacy `qa/` panel and route | allocation |

### J.4 Per-repository work list (to become epics later)

**nemarOrg/nemar-cli:** the git committer for the `nemarproc` branch (Git Data API trees with inline content, tag creation, a fixed branch name and path prefix, dry run), the subtree archive endpoint and the tree-SHA check, a second `applyTagProtection` include pattern for `nemarproc/*` plus a per-repository backfill, the capped nightly batch that commits the tier-1 QA record to `main`; registry tables (or `compute_jobs` kind); `shared/contract/process.ts` (product manifest, dataset-level record envelope) with zod4 mirror; `.nemar/nemarproc/` routes and per-version index; the held-tier mechanism in `bucket-policy.ts` (option a: a `held/` constant plus the `listPrivateDatasets` exclusion; option g: a second entry kind and `prefixIdFromArn` extended to it) with a size assertion test against the measured 4,586-byte baseline; processing IAM policy documented; Hallu adapter script (`scripts/process/`, the `zarr_queue.py` pattern); verify-and-promote, promotion and demotion transitions; sweep checks for held and anonymous; CLI verbs; MCP fields; DOI builder for `P.` identifiers; ADRs; AGENTS.md wording; Tapis adapter later.

**nemarOrg/nemar-process (new, MIT, scaffolded with the project init skill later):** `src/nemar_process/` (runner CLI, JobSpec, representation behind one internal interface with the eegprep EEG-dict adapter only, rule engine, step library for the `eegprep` and `pamica` engines, writers for TSV/JSON/signalJourney, dataset-level record builder, manifest writer, verify), `recipes/` (`nemar-floor`, `nemar-ica` as YAML, versioned by file, each activation recorded in `recipes/CHANGELOG.md`), `schemas/` (recipe schema, vendored signalJourney `nemar` profiles until upstream merges), `images/` (`Dockerfile.cpu`, `Dockerfile.cuda`, one `uv.lock`, cosign and syft in CI, SIF build and `oras://` push), `fixtures/` (frozen inputs and golden outputs per recipe version and device class), `deploy/tapis/` (app and system definitions), `tests/` (real data, no mocks; three-strength determinism; held-versus-published record diff), `docs/` generated from recipes.
Release cadence: semantic versions on tags; a recipe version pins a runner version and both image digests; CI refuses an image whose fixtures fail.
Tooling per the global rules: uv, ruff, ty.

**sccn/eegprep:** ZapLine plugin; `clean_asr`/`clean_artifacts` state surfacing; ICLabel guard for missing scalp coordinates; `icatype='pamica'` backend and #435; license reconciliation; scipy stamp. MEG and iEEG readers and type handling are **later** (after EEG is in production), not part of this work.

**sccn/pAMICA:** U1 to U5 (state schema, apply API, seed and thread docs, LL trace and best-iterate flag, modality note).

**signalJourney:** `nemar` namespace with `recording` and `dataset` profiles; `artifact` objects; dataset-level record specification; validator checks; PyPI release; example fixes.

**nemarOrg/neuroschema:** #1198 envelope as an extension; `derived_products[]` in the `nemar` extension; version bump and pin update.

**nemarOrg/website:** QA tab from the dataset-level record with the held-state line; viewer overlays; "Use this data" citation; Compute dialog fix; legacy panel retirement when covered.

**nemarOrg/docs:** `platform/processing/` contract (namespace, record, tiers, DOI, what is and is not claimed), recipe pages, admin runbook (queue, adapters, held tier, promotion, GPU images).

**eegdash/eegdash-viewer, OSA, EEGDash, NEMAR-pipeline:** as v1.

**nemarDatasets/.github and dataset repositories:** nothing.

### J.5 What can start now

Phases 0 to 3, SP-F, SP-N, SP-G, SP-H, SP-S, SP-D, the pamica CPU half of SP-P, and all eegprep and pamica upstream work can start now.
Blocked on SDSC and Tapis: SP-T, the GPU pilot, the catalog ICA pass.
Blocked on the owner: I.1 items 1, 3, 7 and 8.
Deferred by ruling: everything about iEEG, MEG and EMG (SP-M, the later columns of B.3, gaps 7 and 8).

---

## Appendix: sources added in v2

eegprep `origin/develop` (`beef5a0d`): `functions/popfunc/{pop_fileio,_file_io,pop_load_frombids,pop_biosig,eeg_amica,pop_runica}.py`, `functions/sigprocfunc/runamica.py`, `plugins/EEG_BIDS/{raw,bids_list_eeg_files,bids,bids_preproc}.py`, `plugins/clean_rawdata/{clean_artifacts,clean_channels,clean_channels_nolocs,clean_flatlines,asr_calibrate}.py`, `plugins/clean_rawdata/private/sphericalSplineInterpolate.py`, `plugins/ICLabel/{ICL_feature_extractor,iclabel}.py`, `functions/adminfunc/eeg_checkchanlocs.py`, `cli/commands/{pipeline,qc,transforms}.py`, `pyproject.toml`; issues #435, PR #436.
nemar-cli: `backend/src/services/bucket-policy.ts`, `s3.ts` L1309-1430, `visibility.ts`, `publication-orchestrator.ts` L537, `routes/admin/fleet.ts`, `scripts/zarr/generate_zarr.py` L150, L217, L762, L1608-1756, L7015-7056, L7100-7116, L7254-7255, `shared/zarr-index.schema.json`; ADRs 0005, 0017, 0028, 0065, 0067, 0075, 0076; issues #418, #511, #643, #673, #1198, #1585; AGENTS.md; `.context/eegprep_lean_contract.md`; `.memory/s3-403-is-not-absence.md`; systems inventory (via `nemar admin docs`).
signalJourney: `docs/bids.md` L40-120, `schema/signalJourney.schema.json`, `schema/definitions/{qualityMetricsObject,versionHistoryEntry}.schema.json`, `schema/examples/metrics_heavy.json`.
External (accessed 2026-10-12): `github.com/sccn/pAMICA` README; `mne-tools/mne-icalabel` (`LICENSE`, `megnet/features.py`, `megnet/label_components.py`); `mne-tools/mne-bids` `read.py`; MNE API pages for `maxwell_filter`, `find_bad_channels_maxwell`, `annotate_muscle_zscore`, `annotate_amplitude`, `ICA`; Treacher et al. 2021 (NeuroImage 241:118402); BIDS EMG specification; NeuroKit2 EMG docs; openhdemg `tools.py`; AWS IAM "Resource" element reference; Cloudflare R2 API tokens page; SDSC Expanse user guide (GPU sections); Tapis v3 Jobs page (full and tail).
