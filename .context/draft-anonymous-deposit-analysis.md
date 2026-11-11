# Draft: anonymous deposit for double-blind review

**Status:** analysis. Direction chosen (section 3); the ADR is still to be written.
**Date:** 2026-09-14
**Owner:** Seyed Yahya Shirazi

Conferences that review double-blind reject a submission whose data record names the authors.
A depositor who wants to submit to one of those venues currently has two choices,
both bad: keep the data out of NEMAR until the paper is accepted,
or deposit it and break the blind.

This document works out what would actually have to be true for NEMAR to serve that case.
Section 3 records the direction taken on 2026-09-14:
the data is served publicly, the repository stays private, and the page says so.
The remaining decision, which belongs in an ADR,
is how that state is represented and how it answers the collisions in section 5.

---

## 1. What is being asked for, stated precisely

Five requirements, and they are not the same requirement.

**R1 Reviewer access.**
Reviewers can obtain and inspect the data from the submission alone,
without creating an account and without contacting the authors.

**R2 Author concealment.**
Nothing reachable from the submission reveals who deposited the data.

**R3 Reviewer concealment.**
The authors do not learn who the reviewers are.
Double-blind runs in both directions,
and every per-reviewer access mechanism NEMAR has today violates this half,
which is the strongest argument for the design in section 3:
it has no per-reviewer access mechanism at all.

**R4 Reversibility.**
At acceptance the record becomes the real, attributed, citable record,
with the identifier in the camera-ready still resolving.

**R5 Attribution to the archive.**
NEMAR knows exactly who deposited it, throughout.
Anonymity is toward the public, never toward the archive.

R5 is what separates this from a genuinely anonymous drop box.
Without it there is nobody to hold to the deposit attestation (ADR 0024),
nobody to contact about a consent problem,
and an obvious abuse channel.
The feature to build is **pseudonymous deposit**, not anonymous upload,
and the name matters because it settles several arguments below before they start.

---

## 2. The leak inventory

The working assumption, stated in the original framing, was that the challenge is public search plus GitHub.
Those are two of twelve, and the two that are hardest to fix are not on that list.
Everything below was verified against production on 2026-09-14 unless marked otherwise.

### 2.1 Verified, live, and unintended today

**`uuid.log` on the `git-annex` branch names the depositor's account, machine and directory.**
`git annex init` with no `--description` records `user@host:/absolute/path`,
and `initDataset` in `src/lib/git-annex/init.ts` passes no description.
That line is committed to the `git-annex` branch and is public when the repo is public.
On `nm000281`, which is public right now:

```
b6200c43-...  <login name>@<login node>:<project path carrying a first name>/bids
```

A login name, an HPC login node, and a path carrying a first name.
Nobody chose to publish that and nobody would think to scrub it.
This is a live disclosure independent of anything in this document,
and section 7 treats it as its own work item.

**Commit authorship carries a personal email address.**
`nm000281`'s public history is authored by a collaborator (`<contact email>`),
linked to that collaborator's GitHub account.

**The deposit is attributed on GitHub.**
`GET /repos/nemarDatasets/nm000281/contributors` answers anonymously with `["<collaborator handle>", "nemarAdmin"]`,
the push events appear on that account's public activity,
and every later change is a pull request authored by it (ADR 0001 makes published datasets pull-request-only,
and `gh pr create` runs on the depositor's machine with the depositor's token).

### 2.2 Verified, and working as designed

**`GET /datasets/:id` serves `owner_username` and `owner_github` to anonymous callers.**
`backend/src/routes/datasets/catalog.ts`: `owner_github` in the detail projection,
`owner_username` in the detail and all three list projections.
The detail response also carries `enrichment_json` -- the whole author map, with ORCID
identifiers and affiliations -- and `readme`.

**The website falls back to the depositor's handle when the author list is empty.**
`DatasetCard.astro:33`: `formatAuthorByline(dataset.authors) || dataset.owner_username || "NEMAR"`.
Scrubbing `Authors` therefore makes concealment strictly worse:
it swaps the paper's author list for the depositor's NEMAR handle.

**`datasets.authors` is a search field, a facet and a filter.**
It is populated by enrichment from `dataset_description.json`,
indexed in the full-text search table (ADR 0003),
and exposed as `nemar dataset list --author`.

**The DataCite record is public, harvested and permanent.**
Creators come from the author list; the depositor is added as a `DataCurator` contributor by real name (ADR 0041);
ORCID identifiers ride along on both.
EZID is the registrar (ADR 0007) and the record propagates to DataCite Commons and OpenAIRE.

**Zarr republishes attribution.**
Index format v3 carries dataset-level `doi`, `license` and `citation`,
and every store carries a `nemar` root attribute with the same,
served from public S3 at `zarr.nemar.org`.

### 2.3 Inside the deposit itself

**`.nemar/metadata.json` is committed to the repo and carries the author list plus collected co-author ORCID identifiers.**
An ORCID iD is a permanent global identifier;
one of them in the record de-anonymizes the entire author list in a single lookup.
This is the highest-value leak in the set and the least visible,
and it is not the depositor's to fix:
the CLI actively gitignores the file (`upload/transfer.ts:69-81`),
and it reaches the repository from the BACKEND,
committed as `nemarAdmin` on the App token by `commitEnrichmentWithBidsignore`.
So a depositor-side scrub cannot suppress it,
and the enrichment service re-commits the identifiers after any scrub.
Suppressing it is a backend change (`commitEnrichmentWithBidsignore` needs an anonymous branch),
not a line in a checklist.

**BIDS metadata names people by design.**
`dataset_description.json` has `Authors`, `Funding`, `Acknowledgements` and `EthicsApprovals`;
an institutional review board protocol number identifies the institution even with no name attached.
`README` and `CHANGES` are free text.
`participants.tsv` and `scans.tsv` carry free text and acquisition dates.

**The recordings themselves carry identity.**
European Data Format and BioSemi Data Format headers have a recording-identification field,
EEGLAB `.set` files carry `EEG.comments`,
and Functional Imaging File Format headers carry subject and experimenter fields.
Magnetoencephalography and electroencephalography toolchains ship de-identification helpers precisely because of this.

### 2.4 Weak signals

Dataset identifiers are assigned in reserved bands (ADR 0011), gap-filling rather than
strictly sequentially, so adjacency is weaker evidence of deposit order than it looks.
Deposit timestamps correlate with submission deadlines.
Neither is worth designing against on its own; both are worth one sentence in the user-facing guidance,
because a depositor who believes the blind is perfect will behave differently from one who knows it is merely good.

---

## 3. Option A: private repository, public data surface

**Owner decision, 2026-09-14.** The dataset is served normally on `data.nemar.org` and on the
website while the GitHub repository stays private, with the page carrying a visible flag that
the dataset is temporarily anonymous and the GitHub control grayed out.
This supersedes the tokenized review link sketched in earlier drafts of this section,
and it is a better design for a reason worth stating plainly:
**there is no access request, so there is nothing to conceal in the other direction.**
R3 is satisfied by construction rather than by machinery.
A reviewer follows a public URL like any other reader.

It also deletes a whole component.
An unguessable link would have needed a token table, an expiry, a scope, a revocation path and
a serving path; none of that is needed if the data is simply public.

### The state this creates

Visibility is currently one concept applied to three systems at once.
`applyDatasetVisibility` in `backend/src/services/visibility.ts`
flips the GitHub repository, the bucket policy and the D1 `visibility` column in one
transaction with revert-on-failure at each stage.
This design decouples them for the first time:
D1 `public` (so the catalog, the website and `data.nemar.org` serve it),
bucket policy `public`, GitHub repository `private`.

The two public data surfaces already gate on exactly the D1 column and nothing else,
which is what makes this cheap:
`backend/src/routes/data.ts` rejects on `row.visibility !== "public"`,
and `backend/src/routes/zarr-data.ts` on the same.
Set the column and both serve.

Note that this is a different axis from **published**.
Published means a concept DOI exists, the repository is public,
and the branch ruleset makes `main` pull-request-only (ADR 0001).
A dataset in this state is readable but not published,
which is a combination the system has never expressed
and which needs a name before it gets a column.

### Anonymity is available only before first publication

**Owner decision, 2026-09-14.** A dataset that has ever been published cannot be made anonymous.
The flag is offered at first deposit and refused on anything with a public history.

This is not a policy preference; it is the only defensible line.
Retracting an attribution that has already been public is theatre:
the DataCite record is harvested and permanent (ADR 0007),
the git history and `uuid.log` are in every clone and every fork,
the repository has been indexed,
and the catalog, the search index and the Zarr documents have all served the real authors.
Hiding those fields afterwards changes what NEMAR displays and nothing about what is known,
while telling the depositor they are anonymous.
A feature whose guarantee is false is worse than its absence,
because someone will rely on it.

It also makes the state cheap to reason about.
"Never published" means no concept DOI, no public repository, no catalog history,
so there is nothing to retract and the whole of section 2 is a forward-looking
list rather than a cleanup.
The predicate is mechanical and belongs next to the flag:
no `concept_doi`, no row in `dataset_versions`, and `visibility` has never been `public`.
The first two are already columns; the third is the one that needs recording,
because `visibility` is current state and not a history.

### Predicates

**A1. Concealment is now load-bearing, and there is more of it to do.**
Under a private dataset the inventory in section 2.2 was unreachable.
Here it is all reachable, so each item becomes work:
`owner_username` and `owner_github` must be withheld from `GET /datasets/:id`,
the website's byline fallback to `owner_username` must be suppressed rather than merely unused,
`datasets.authors` must not carry the real author list into the search index and the `--author` facet,
and the Zarr index and store attributes must not carry a citation.
This is the trade for losing the token machinery, and it is the right trade,
but it is not a smaller feature. It is a differently shaped one.

**A2. The GitHub control has to be suppressed, not merely hidden.**
`ActionBar.astro` in `nemarOrg/website` reads
`const ghCloneUrl = githubUrl ?? \`https://github.com/nemarDatasets/${ds}\``,
and `dataset/[id].astro:234` fabricates the same URL BEFORE passing the prop,
so `ActionBar.astro`'s `??` is dead as wired and the `{githubUrl && ...}` guard always passes.
There are two fabrication sites, and nulling `github_repo` hides neither the button nor the
clone command.
That URL 404s for a reviewer today and resolves later, which is the worst of both.
The website needs an explicit anonymous state, not an absent field.

**A3. `nemar dataset download` needs a route that is not a clone.**
It clones the repository through git-annex (`cloneDataset`, `src/lib/git-annex/clone-push.ts`),
and the repository is private, so the command the website's own download modal advertises first
cannot work.
Proposed, not merged: #1401 / PR #1402 would add a plain-HTTP download path
(`nemar dataset download --http`, and automatic when git-annex is missing) that reads the data
plane's manifest and fetches over HTTPS, with the same BIDS filters.
It was worth building on its own merits -- containers, HPC login nodes, CI runners, and anyone
who installed the CLI and nothing else -- so it is not a cost of this design.
What remains is that the path is only as good as A4: today it would fetch the recordings and
404 on the metadata.

**A4. The data plane hands clients a GitHub URL, against its own stated contract.**
This is the blocker, and it is larger than it looks --
and it is not really an anonymity problem, which is why it should be fixed on its own terms.
`buildBytesUrl` in `backend/src/services/data-router.ts` documents `bytes_url` as
"a STABLE, storable contract URL, so it is host-invariant: always the canonical
data.nemar.org regardless of which host [...] actually served the manifest",
and then, 37 lines later, sends git-backed files to `raw.githubusercontent.com`.
The carve-out is documented rather than accidental (`buildBytesUrl`'s own docstring states it),
and the host-invariance claim is itself qualified for staging.
So this is a stated exception that has outlived its justification, not a self-contradiction;
the rule is the one worth keeping.

The correction is that the URL a client is handed is always `data.nemar.org/<id>/<version>/<path>`,
and whether the Worker streams the bytes or redirects to a backing store
is a server-side decision per file class:
stream the small git-tracked metadata, keep the redirect for the large annexed data.
That is the rule the Zarr contract already follows
(`contract_base` is the only URL a client may hardcode);
the file plane should not answer it differently.

Three things it fixes that have nothing to do with anonymity:
the publish-time canary in `services/manifest.ts` exists only because the manifest embeds a
third party's URL, and can go;
per-file access becomes countable at all, since `recordAccess` fires only on the archive zip
and the zarr store routes, and no per-file BIDS download is counted on either backing store;
and the website's advertised
`jq -r '.[].bytes_url' | wget` recipe stops silently depending on GitHub.

**The canary is NOT a blocker, and an earlier draft of this document said it was.**
`verifyGitBackedFiles` does HEAD a sample of `git:` entries against `raw.githubusercontent.com`
and refuse to write the manifest otherwise,
with a failure message that even names the case ("the repo may be private").
But production runs `MANIFEST_VIA_CENTRAL_WORKFLOW = "true"`,
so `generateManifest` and its canary are not called at publish time at all,
and every publish-time dispatch passes `skipCanary: true` unconditionally.
The central workflow has its own canary plus a first-class escape hatch already labelled for
this exact case (`skip_canary: "Skip raw.githubusercontent.com canary (for private repos)"`),
and it clones with an App installation token, so a private repo's manifest is generable today.
A4 is a serving problem, not a manifest-write problem.
It is still first in the order below, because nothing else works without it,
but not for the reason the earlier draft gave.
`buildRedirectUrl` in `backend/src/services/data-router.ts` sends git-tracked files to
`raw.githubusercontent.com` and only annexed files to S3,
and its own docstring names the invariant it depends on:
the repository must be public, or "the 302 target itself returns 404 to the user with no
Worker-side signal".
Measured on public `on008701`: **2,802 of 3,201 files, 88 percent, come from GitHub** --
4.1 MB of metadata against 14.0 GB of recordings.
That set is `dataset_description.json`, `participants.tsv`, `README`, `CHANGES`,
and every sidecar.
With a private repository a reader gets the recordings and none of the metadata that makes
them interpretable, which is not a BIDS dataset and will not validate.
The fix is to serve those files through the Worker on the App token rather than redirecting.
It is cheap -- kilobyte files, version-pinned, immutably cacheable, nothing like the large-file
proxying that drove the Zarr redirect design -- and it is worth doing on its own merits,
because it replaces a documented fail-silent invariant with one the Worker can observe.
Filed as issue #1403.

**A5. The Zarr fidelity sweep will mark every such dataset `unverifiable`.**
Its candidate predicate is `status = 'active' AND visibility = 'public'`
(`backend/src/services/zarr-fidelity-sweep.ts`),
and the comment above it says why:
a private repository cannot be read anonymously through `raw.githubusercontent.com`,
so including one "would only ever produce `unverifiable` noise".
That predicate uses D1 visibility as a proxy for "the repository is public",
and this design is precisely the case where the proxy stops holding.
The consequence is bounded and not a false failure:
every sidecar fetch 404s, nothing is checked,
and the verdict falls to `unverifiable` rather than `failed`.
But the dataset then fails `has_zarr_verified` for the whole review window,
which degrades a published quality signal on exactly the datasets being shown to reviewers.
The predicate needs to test what it actually means.

**A6. The identifier has to be a reserved DOI.**
Venues increasingly want an identifier in the submission,
and you cannot have a resolving DOI and a concealed dataset at the same time.
Three ways out, and only one is clean.

*Mint a public DOI with anonymized creators and fix it later.* Reject.
DataCite records are harvested and snapshotted; there is no un-harvesting.
It also inverts ADR 0041, which exists to keep exactly this kind of placeholder out of a permanent record.

*Carry no identifier.* Workable, weak, and some venues object.

*Reserve the identifier.* EZID supports `_status: reserved`,
and `backend/src/services/ezid.ts` already implements creation as reserved,
transition to public, and deletion of a reserved identifier.
The string exists and is stable enough to cite in a camera-ready;
it is absent from the public index and does not resolve;
if the paper is rejected the identifier is deletable.
At acceptance the same identifier goes public against the same dataset with the real creators,
which is R4 satisfied with the identifier unchanged.
This capability is built and unused for this purpose,
so it is close to free.

**A7. Scrubbing is deferred, not removed.**
On the day the dataset goes public, `uuid.log` still names a machine
and the commits still carry a personal email address.
For double-blind that is acceptable, because by then attribution is wanted,
but it is only acceptable if nothing went public early.
The publish flip has to remain the single moment anything becomes visible,
which is ADR 0001's consequence that governance is applied at publish rather than at repo creation.

**A8. One link, and the product has to say so.**
A blinded submission that carries both a review link and a repository URL is self-defeating.
The command should print exactly one URL and say what it is for.

**A9. Scheduled cleanup will nag the depositor for the length of the review.**
A private `nm` dataset with no concept DOI becomes cleanup-eligible after ninety days of inactivity,
and a review window runs three to nine months, so every such dataset crosses the line.
Since #662 the cron does **not** delete: it emails the owner at thirty, fourteen, seven, two and one days,
then notifies admins once and leaves the deletion to a deliberate `nemar admin delete-dataset`
(`backend/src/services/staleness.ts`, and the handler in `backend/src/index.ts`).
So the hazard is not data loss;
it is a depositor receiving five "your dataset will be deleted" emails during peer review,
and an admin queue filling with handoffs that must not be acted on.
Both are suppressed by one clause in the candidate predicate, and it has to be written down.

**A10. The window needs a default, a cap, and a defined expiry behaviour.**
Expiry must restore attribution and notify the depositor.
It must never publish anything automatically, and it must never silently extend.

---

## 4. Option B: deposit through the NEMAR service account

**Not required under the decision in section 3, and kept here as the fallback it now is.**
The GitHub-identity family, which is the only thing this option uniquely removes,
is already unreachable while the repository is private,
and under the chosen design the repository stays private for the whole window.
The case that would force this option back on the table is a venue or journal that requires the
**repository itself** to be open at submission, not merely the data;
that case has not been raised, and should be confirmed as real before anyone builds for it.
The analysis below stands, and the two predicates worth carrying forward regardless
are B2 (the annex description, which is section 7's first item)
and B3 (where the real depositor is recorded, which this design needs anyway
so that the attribution can be restored at acceptance).

The deposit is made by NEMAR.
`owner_user_id` points at a service account (ADR 0048),
the commits are authored by the bot,
and the push comes from the GitHub App.
The real depositor is recorded separately.

**The precedent already exists in production.**
Every OpenNeuro import is this shape:
`on008768` serves `owner_username: nemarAdmin` and is owned by a service account.
The precedent is narrower than it looks, though: `owner_github` is `"nemarAdmin"`, not null,
and the git history carries the upstream authors' real institutional addresses alongside the
bot's commits.
So "a public record that names no human depositor" holds for the D1 owner field and NOT for git
history, which is the one place this option is supposed to help.

**What it solves.** The GitHub-identity family, 2.1 in full, permanently rather than by deferral,
plus `owner_username` in 2.2.
That is precisely the set Option A defers rather than removes.

### Predicates

**B1. The bytes are the hard part, not the commits.**
Git metadata can already be committed server-side:
`commitFilesAsTree` in `backend/src/services/github/contents.ts` commits as the bot with the App token,
and is used today for continuous-integration workflow files.
What cannot move server-side is the data,
which goes from the depositor's machine to the bucket through git-annex with per-user credentials,
and ADR 0002 keeps NEMAR out of the path of ordinary git operations
(ADR 0010 is about import-time S3 copy, not this).
The shape has to be: depositor uploads to the bucket as today,
then the backend composes and commits the pointer tree as the bot.
That is implementable, because annex keys are deterministic and the client already computes them,
but it is a second deposit path, not a flag on the existing one.

**B2. The annex branch is still written by the client.**
See 2.1.
Either pass a non-identifying `--description` to `git annex init`, which is a one-line change,
or have the backend build the annex branch, which is not.
The one-line change is worth making regardless of whether this feature is ever built.

**B3. Accountability has to move somewhere that tooling reads.**
Quota, abuse handling, the deposit attestation (ADR 0024), the publication request,
and the contact of last resort all currently key off `owner_user_id`.
A `real_depositor_user_id` column is the obvious answer,
but `datasets` is under an enforced column budget (ADR 0034),
and ADR 0035 reserves the JSON stamp column for bookkeeping.
Ownership is a first-class relationship that wants to be joined and indexed, not a stamp,
so the column is probably right, and that argument belongs in an ADR rather than in a migration nobody reviews as a decision.

**B4. Ownership semantics get strange, and this is the deepest problem.**
If the service account owns the dataset, it owns the permissions.
Deletion of a published dataset is owner-only;
merging its pull requests is governed by GitHub collaboration.
The real depositor loses the ability to act on their own dataset
unless NEMAR grows a permission vocabulary of its own,
which ADR 0002 explicitly declined to build.

There is an escape, and it is the reason the two options are complementary rather than alternative:
**on a private repository, collaborators are not publicly listed.**
Option A plus Option B together dissolve B4.
The depositor stays a collaborator throughout, invisibly, because the repository is private;
the bot authors the commits;
at publication the repository goes public with a history that never named anyone.

**B5. It has to be temporary, or it is a false record.**
A dataset that stays service-owned after publication tells the public that NEMAR deposited it,
which is false, and is the exact failure mode ADR 0041 exists to prevent.
Git history is append-only, so attribution cannot be restored retroactively without a rewrite,
and a rewrite of a published dataset is not on the table.
The resolution is that git history staying bot-authored is honest,
because NEMAR's automation genuinely made those commits;
attribution belongs in the places that carry it,
which are the DOI record, `dataset_description.json`, and the D1 owner,
all of which are set at publication.

**B6. ADR 0041 needs an answer, not an exemption.**
`requiresUploaderName` exempts OpenNeuro imports and the exemplar fleet from the citable-name requirement.
A third exemption would be the wrong instrument,
because the depositor does have a citable name and does want it cited, just not yet.
The curator attribution should come from the real depositor at the moment of de-anonymization,
which makes the exemption temporary and keeps the permanent record complete.

---

## 5. Collisions with standing decisions

Three, and each needs an explicit answer before any code.

**ADR 0026, submission minimums.**
`backend/src/services/submission-minimums.ts` hard-gates native publication on named, non-placeholder authors,
and its rejection message reads
"anonymous submissions and placeholder entries are not accepted".
`PLACEHOLDER_AUTHOR` matches the literal string `anonymous`.
This is a deliberate policy, not an oversight, and it forbids the feature as stated.
The reconciliation is that the gate applies at publication, which is exactly when the blind ends,
so the feature never needs it relaxed.
That has to be stated, because a reader of the gate will otherwise conclude the feature was snuck past it.

**ADR 0041, DOIs cite the uploader by real name or not at all.**
See B6.

**ADR 0002, access control rides on GitHub collaboration.**
A capability link is a NEMAR-side read grant that GitHub cannot express.
It does not contradict ADR 0002's reasoning, which is about not proxying ordinary git operations,
but it does add a second access vocabulary, and the ADR's consequences section already anticipates this
("anything GitHub cannot express, we cannot express").

---

## 6. The option that was not raised, and why it is rejected

Do nothing in NEMAR.
Document that depositors should keep the dataset private
and share a snapshot themselves through a service built for anonymized sharing.
Zero engineering.

Rejected: it sends the depositor to another product at the moment NEMAR wants the deposit,
and a self-hosted snapshot has no provenance link to whatever eventually gets published,
so a reviewer cannot verify that the accepted dataset is the reviewed dataset.
That verification link is the thing an archive is uniquely able to provide.
It is the actual value on offer here, and it is worth building for.

---

## 7. What follows from this

**Now, and independent of any decision below.**
Pass a non-identifying description to `git annex init`.
Decide separately what to do about the repositories that already carry the default one.
This is a live, unintended disclosure of account names, hostnames and directory paths on public repositories.

**The design.**
Private repository, public data surface, per section 3:
the dataset is served on `data.nemar.org` and on the website exactly as any public dataset is,
the GitHub repository stays private,
the page carries a visible flag that the dataset is temporarily anonymous,
and the GitHub control is grayed out.
Identity is withheld at the API, in the byline, in the search index and in the Zarr documents
for as long as the flag is set,
and restored, together with the repository flip and the DOI, at acceptance.

Nine pieces of work follow from the predicates in section 3, in dependency order:

1. **A name and a representation for the state**, refusable on anything ever published.
   Readable but not published is a combination the system cannot express,
   and D1 visibility is currently welded to repository visibility and the bucket policy
   in a single transition (`applyDatasetVisibility`).
   This is the decision the ADR exists to take;
   everything below is mechanical once it is taken.
2. **Withhold identity on the public surfaces:**
   `owner_username` and `owner_github` in `GET /datasets/:id`,
   the byline fallback in `DatasetCard.astro`,
   `datasets.authors` in the full-text index and the `--author` facet,
   and `doi`/`citation` in the Zarr index and store attributes.
3. **The website state** (issue filed on `nemarOrg/website`):
   the anonymous flag on the dataset page, the grayed-out GitHub control,
   and a download modal that does not advertise a clone route that cannot work.
4. **Serve git-tracked files through the Worker** rather than redirecting to
   `raw.githubusercontent.com` (#1403). Without this the state does not work at all:
   88 percent of a dataset's files are served from GitHub, and a private repository 404s
   every one of them.
5. **Four predicates that use D1 visibility as a proxy for repository visibility**
   and stop being correct here:
   the Zarr fidelity sweep's candidate query;
   the staleness candidate query, which would otherwise email the depositor five times mid-review;
   `nemar admin fleet drift`, which reads visibility from the D1 ledger and would mark every
   anonymous dataset `PUBLIC_UNPROTECTED` forever, with `fleet enforce` then trying to apply a
   public-repo ruleset to a private repo;
   and the MCP events fallback, which reads `events.tsv` through `raw.githubusercontent.com`
   behind the same public gate.
6. **A governance answer, not just a name.**
   ADR 0001 gives an unpublished repository no branch ruleset at all,
   because protection is applied at publish.
   So for the whole review window the public would be reading `data.nemar.org`
   while `main` stays force-pushable and retaggable by the depositor.
   Readable-but-not-published needs to say what protects the bytes people are reading.
7. **The website's own GitHub fetches.**
   `Readme.astro` fetches `raw.githubusercontent.com` from the BROWSER,
   so brokering on the Worker does not fix it and the most prominent panel on the dataset page
   would be blank; the demographics panel degrades to "no demographics" the same way.
   Both live in `nemarOrg/website`, not here.
8. **The identifier.** Reserved EZID status during the window, public at acceptance,
   per predicate A6.
9. **An ordering for de-anonymization.** Restoring attribution is a content commit to
   `dataset_description.json`, not a flag flip, and if the repository goes public first then
   ADR 0001 has already made `main` pull-request-only. The order of restore, flip and mint is
   load-bearing.

**The fallback, if a venue ever requires the repository itself to be open at submission.**
Bot-authored deposit, per Option B. Not needed for the design above.
Confirm the case is real before building for it.

**A blind check, in the same shape as `evaluateSubmissionMinimums`.**
The blind holds only if the deposit itself is scrubbed,
and a mechanical report of what still names somebody
is worth more than a paragraph of policy:
`Authors`, `Funding`, `Acknowledgements` and `EthicsApprovals` in `dataset_description.json`,
ORCID identifiers in `.nemar/metadata.json`,
recording-identification fields in signal file headers,
and a free-text scan of `README`, `CHANGES` and `participants.tsv`.

**The ADR, before the code.**
It has to answer section 5 explicitly,
and it should be named for what the feature is,
which is pseudonymous deposit with reviewer access, not anonymous upload.
