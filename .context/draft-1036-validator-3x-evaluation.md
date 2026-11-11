# Evaluation: @bids/validator 3.x for nemar-cli#1036 / website#161

Research date: 2026-08-10. Read-only evaluation; nothing was posted to GitHub and no repository was modified.
Bundling and runtime findings below were verified empirically in a scratchpad spike
(`<scratchpad>/spike/`),
not just read off release notes.

## 1. Current state in nemar-cli (exact pins and call sites)

The pin is `<repo root>/validator-version.json`:

```json
{ "version": "2.4.1", "specifier": "jsr:@bids/validator" }
```

Everything that touches the validator flows from that one file. Note the crucial architectural fact:
**nemar-cli never imports the validator as a library.** Every use is a Deno subprocess running the
command-line interface (CLI), so the 3.0 library-API reorganization does not touch nemar-cli's code at all.

Call sites:

- `<repo root>/src/lib/bids-validator.ts:19-23` — imports the pin,
  exports `VALIDATOR_VERSION`, builds the JSR specifier `jsr:@bids/validator@2.4.1`.
- `src/lib/bids-validator.ts:192-232` (`buildValidatorArgs`) — invocation is
  `deno run --node-modules-dir=none [-​-reload=<spec>] -ERWN jsr:@bids/validator@<v> <path>`
  plus pass-through flags `--json`, `--config`, `--ignoreWarnings`, `--recursive`, `--prune`, `--verbose`.
- `src/lib/bids-validator.ts:241-293` (`validateBidsDataset`) — parses the `--json` output and consumes
  exactly this shape: `{ issues: { issues: BidsIssue[], codeMessages: Record<string,string> }, summary: BidsSummary }`,
  where `BidsIssue = { code, severity, location, rule, subCode?, issueMessage? }` (lines 28-49).
  Non-zero exit with empty stdout is treated as a hard failure (lines 258-264).
- `src/lib/bids-validator.ts:299-316` (`runBidsValidatorDirect`) — raw stdout/stderr/exit-code passthrough
  for `nemar dataset validate`.
- `src/lib/bids-validator.ts:135-186` — `--version` output parsed with `/(\d+\.\d+\.\d+)/` for cache
  refresh and version display.
- `<repo root>/src/lib/upload/preflight.ts:129` — upload preflight calls
  `validateBidsDataset(absolutePath, { prune: true })`; errors block upload.
- `<repo root>/src/commands/dataset.ts:67-70, 377` — the
  `nemar dataset validate` command; unknown flags are passed through to the validator CLI.
- `<repo root>/backend/src/services/github/shared.ts:12-14` — the backend
  re-imports the same pin and exports `VALIDATOR_VERSION`.
- `<repo root>/backend/src/services/github/workflows.ts:131-178` — the
  per-dataset-repo `bids-validation.yml` shim template interpolates
  `client_payload[validator_version]=${VALIDATOR_VERSION}` into a `repository_dispatch` to
  `nemarDatasets/.github`.
- The central workflow `nemarDatasets/.github` `.github/workflows/run-bids-validation.yml` runs
  `deno run -A "jsr:@bids/validator@${VALIDATOR_VERSION}" . --json --ignoreWarnings > .nemar/validation.json || true`,
  then filters with `jq '.issues.issues[] | select(.severity == "error")'` against a list of git-annex
  pointer-file locations (matching on `.location`), and posts a check-run. It also semver-shape-checks
  `validator_version` (`X.Y.Z`) but does not restrict the major.
- `.github/workflows/bump-validator.yml` — weekly Monday cron resolves the latest version from
  `https://jsr.io/@bids/validator/meta.json` with `select(test("^2\\.[0-9]+\\.[0-9]+\\.?[0-9]*$"))`
  style regex, literally `select(test("^2\\.[0-9]+\\.[0-9]+$"))` — hard-locked to major 2, exactly as
  issue #1036 states. It runs `bun test` against the new pin before opening a PR to `dev`.
- Tests asserting lockstep: `<repo root>/test/workflow-yaml.test.ts:178-207`
  (shim interpolation and pin shape), `backend/test/bids-validation-dispatch.test.ts:19-31`
  (dispatch payload equals the pin), `test/cli.test.ts:434-442` (raw JSON output has
  `{ issues: { issues: [...] }, summary: {...} }`).

## 2. Upstream status and the 3.x delta

Package landscape, as of 2026-08-10:

- `bids-validator` on the Node package manager registry (npm) is the **legacy** JavaScript validator,
  frozen at 1.15.0 and marked deprecated ("Package no longer supported"; last registry modification
  2025-12-11). It is dead; do not build anything on it.
- `@bids/validator` on the JavaScript Registry (JSR) is the schema-based validator and the only
  maintained line. Versions present: 2.x through 2.4.1 (published 2026-02-20), then 3.0.0
  (2026-07-13) and 3.0.1 (2026-07-20). 3.0.1 is a stable release, not a prerelease. Nothing is yanked.
- JSR's npm-compatibility bridge publishes the same content as `@jsr/bids__validator` on
  `https://npm.jsr.io`; 3.0.1 is there with the full subpath exports list, which is what a Bun or
  Vite project installs (`bunx jsr add @bids/validator`, or a `package.json` alias plus an `.npmrc`
  scope mapping `@jsr:registry=https://npm.jsr.io`).

What 3.0.0 changed (release notes, 2026-07-13):

- **"This is a major release that includes breaking changes to the public API. The CLI remains
  unchanged."** That sentence is the whole migration story for nemar-cli: its only consumer surface is
  the CLI plus `--json` output.
- Library imports moved to subpath entry points: `/validate`, `/files`, `/filetree`, `/files/deno`,
  `/files/browser`, `/files/git`, `/issues`, `/output`, `/cli`. The root export remains the CLI entry.
  `@bids/validator/main` and `@bids/validator/options` are deprecated, removed in v4.
- New public primitives for custom file sources (`FileOpener`, `filesToTree`, openers, stream helpers),
  `detectErrors()` made public, git-tree validation via `--git-ref` (including annexed-content access
  through `AnnexedGitFileOpener`), custom schema upload for the web validator.
- Behavioral fixes that can change issue sets on real datasets: derivative datasets no longer emit
  sidecar-key warnings that do not apply to them; opaque directories are computed from the dataset's
  actual `DatasetType`; broken symbolic links are now **reported as issues** instead of crashing or
  being silently ignored; dotfiles and `.git/` are pruned from the tree; `--prune` is redefined as
  "remove opaque BIDS directories from the tree" and is documented as incompatible with `--recursive`.
- Infrastructure: code-splitting enabled specifically "to make the validator more friendly to load in
  the browser or include in downstream bundled applications"; upstream states the initial validator
  load transfers under 400 kB with an additional 1.2 MB loaded only if Hierarchical Event Descriptor
  (HED) validation is required; the HED validator is lazy-loaded. 3.0.1 adds a `_motion.tsv` parsing
  fix and annex `hashDirMixed` support.

Output-schema stability (verified by source diff, 2.4.1 vs 3.0.1):

- `resultToJSONStr` in `src/utils/output.ts` is structurally identical (a `JSON.stringify` with a
  Map-to-object replacer), so `--json` still produces
  `{ issues: { issues: [...], codeMessages: {...} }, summary: {...} }`.
- The `Issue` interface in `src/types/issues.ts` has the identical field set
  (`code, subCode?, severity?, location?, issueMessage?, suggestion?, affects?, rule?, line?, character?`);
  3.0.1 only added JSDoc. `Severity` is unchanged.
- `SummaryOutput` still carries every field nemar-cli's `BidsSummary` reads
  (`sessions, subjects, tasks, modalities, totalFiles, size, dataProcessed, schemaVersion`).

The official online validator (`bids-standard.github.io/bids-validator`) is the repo's `web/`
React app. It imports `fileListToTree`, `validate`, `getVersion` from `dist/validator/web.js`
(`web/src/App.tsx:6`), an esbuild browser bundle of `src/web.ts`, which in turn re-exports
`fileListToTree` from `@bids/validator/files/browser` and `validate` from `@bids/validator/validate`.
It is built with Deno plus Vite and deployed to GitHub Pages on each release
(`.github/workflows/web_build.yml`, stable and dev builds). It runs fully client-side. So the exact
package and entry points the website would use are the ones already powering the official hosted
validator, at 3.x.

Schema loading (`src/setup/loadSchema.ts` at 3.0.1): the default schema ships bundled via the
`@bids/schema` dependency (3.0.1 bundles schema 1.2.7). Network fetch happens only if a schema
version or URL is explicitly requested (or `BIDS_SCHEMA` is set under Deno). In-browser validation
is therefore fully local by default — no Content Security Policy (CSP) `connect-src` addition and no
"file content leaves the browser" caveat.

## 3. Browser feasibility verdict: yes, verified empirically

I ran the spike the issue asks about, against the npm-bridge package under Bun (the website's
toolchain):

- `bun install` of `@bids/validator` aliased to `npm:@jsr/bids__validator@3.0.1` (with the `@jsr`
  registry scope in `.npmrc`) resolves cleanly; the tarball ships compiled JavaScript plus type
  declarations and the full subpath exports map.
- `bun build entry.ts --target=browser --minify --splitting` on an entry importing only
  `fileListToTree` (from `@bids/validator/files/browser`) and `validate` (from
  `@bids/validator/validate`) produced: **entry chunk 1.0 MB minified, 289 kB gzip**, plus a
  **lazily imported 9.27 MB / 1.29 MB gzip chunk that is entirely the HED validator** and loads only
  when HED validation is triggered. This matches upstream's "under 400 kB initial, 1.2 MB HED" claim.
- Grep of the emitted chunks confirms the 2.x dead weight is gone: zero occurrences of
  `isomorphic-git`, `cliffy`, or `s3-lite` in either chunk. Compare the 2.4.1 force-bundle attempt in
  issue #1036: 10.3 MB minified / 1.6 MB gzip with all of that inlined and no clean entry point.
- A runtime smoke test executed the bundle outside Deno (Bun runtime, browser-shaped inputs):
  synthetic `File` objects with `webkitRelativePath` defined, `fileListToTree` then `validate`.
  It completed against the bundled schema (`schemaVersion: 1.2.7`), detected the EEG modality and
  subject correctly, and returned 32 plausible issues (`TOO_FEW_AUTHORS`, `README_FILE_SMALL`,
  `SIDECAR_KEY_RECOMMENDED`, ...). No Deno globals required; `loadSchema` guards
  `typeof Deno !== 'undefined'`.

One integration detail that matters for the website: `fileListToTree`
(`src/files/browser.ts:18-49`) derives each file's dataset-relative path from
`file.webkitRelativePath` and strips the first path segment (the picked root directory name). Files
from `<input webkitdirectory>` have that property natively; files collected via drag-and-drop
directory walking do not, so the website must synthesize it
(`Object.defineProperty(file, "webkitRelativePath", { value: "root/" + relPath })` — proven to work
in the smoke test), or build the tree from the also-public `filesToTree` / `BrowserFileOpener`
primitives.

Verdict: 3.x removes the blocker completely. The 2.x pin was the only thing standing between
website#161 and a straightforward implementation.

## 4. Migration sketch for nemar-cli (moving the pin to 3.0.1)

Ordered by the three asks in issue #1036:

1. **What breaks in code and CI: almost nothing, by construction.** nemar-cli only spawns the CLI,
   and upstream states the CLI is unchanged. Concretely:
   - `validator-version.json` → `"3.0.1"`. All three consumers (CLI subprocess, backend shim
     interpolation, central workflow) pick it up through the existing threading; the central
     workflow's semver-shape check accepts any major.
   - The `--json` shape, `Issue` fields, and `SummaryOutput` fields are identical (verified by source
     diff, section 2), so `validateBidsDataset`'s parser, the central workflow's `jq` filters on
     `.issues.issues[].severity/.location`, and `test/cli.test.ts`'s shape assertions all hold.
   - The `--node-modules-dir=none` workaround (#1010) stays relevant: `hash-wasm` is still an npm
     dependency at 3.0.1.
   - Flags used (`--json`, `--config`, `--ignoreWarnings`, `--recursive`, `--prune`, `--verbose`,
     `--version`) all still exist. One semantic shift: `--prune` now removes all opaque directories
     from the tree and is incompatible with `--recursive`. nemar-cli never combines them
     (preflight uses `prune: true` alone; `dataset validate` exposes both but a user combining them
     gets upstream's documented behavior), so this is a doc note, not a break.

2. **Result equivalence on real datasets is the real acceptance test, and it will not be bit-identical.**
   Expect mostly *fewer* spurious findings (derivative sidecar warnings dropped, correct opaque-dir
   handling, dotfile pruning) but one category of *new* findings: broken symbolic links are now
   reported as issues. NEMAR dataset repos are git-annex backed, and the central workflow validates a
   plain checkout where annexed files are pointer files or symlinks — today it filters errors at
   annex-file locations after the fact. Whether 3.x's broken-symlink issues land on locations that
   filter already covers needs an empirical check. Recommended gate: run 2.4.1 and 3.0.1 side by side
   (`deno run -A jsr:@bids/validator@<v> . --json --ignoreWarnings`) over a sample of checked-out
   `nmXXXXXX` repos including at least one annexed EEG dataset and one derivative-bearing dataset,
   and diff the post-filter error sets. Only error-set changes matter, since publication gating is
   errors-only (`--ignoreWarnings`). Longer term, 3.x's `--git-ref` mode with `AnnexedGitFileOpener`
   could replace the pointer-file filtering entirely — validate the git tree directly — but that is a
   follow-up, not part of the bump.

3. **`bump-validator.yml`:** widen the regex and hoist the major into a variable, for example an
   `env: VALIDATOR_MAJOR: "3"` consumed as `select(test("^\($major)\\.[0-9]+\\.[0-9]+$"; "x"))` (or
   simple shell interpolation into the jq program), so the next major bump is a one-line change. The
   workflow already runs `bun test` against the new pin before opening the PR, which keeps future
   3.x patch bumps self-verifying.

Also update the stale comment at `src/lib/bids-validator.ts:7-8` ("newer 2.x release") when the pin
moves.

## 5. Integration sketch for website#161

The exact import specifiers (replacing the issue's `"@bids/validator/web"` guess):

```ts
const [{ fileListToTree }, { validate }] = await Promise.all([
  import("@bids/validator/files/browser"),
  import("@bids/validator/validate"),
]);
const tree = await fileListToTree(files); // File[] with webkitRelativePath set
const result = await validate(tree, {
  datasetPath: "<browser upload>", debug: "ERROR",
  datasetTypes: [], blacklistModalities: [],
});
```

- **Install:** `package.json` alias `"@bids/validator": "npm:@jsr/bids__validator@3.0.1"` (exact,
  no caret) plus `.npmrc` line `@jsr:registry=https://npm.jsr.io`. Bun resolves and bundles this
  today (verified).
- **Where it plugs in:** the upload page already holds everything needed. `UploadDropzone.astro`
  collects a `DroppedFile[]` (`src/lib/upload-client.ts:53-55`: `{ path, size, file: File }`) from
  both `<input webkitdirectory>` (`src/components/UploadDropzone.astro:25`) and drag-and-drop
  directory walking, and `src/pages/upload.astro:483` (`runPrecheck`) is the natural insertion point:
  keep the instant `bids-precheck.ts` structural scan as layer one, then lazily import the validator
  and run it as layer two with a progress state. For the drag-and-drop path, synthesize
  `webkitRelativePath` as `"root/" + droppedFile.path` on each `File` (section 3), since
  `fileListToTree` strips the first segment.
- **Lazy load:** dynamic `import()` on first drop keeps `/upload`'s initial payload unchanged; the
  validator itself then lazy-loads its HED chunk only for datasets that use HED. Under Astro the
  client build goes through Vite/Rollup, which handles both dynamic-import layers as split chunks;
  confirming Vite reproduces the Bun numbers is a small spike item, not a risk to the approach.
- **Web worker:** recommended but optional. The upstream web app validates on the main thread;
  for NEMAR-scale EEG datasets (thousands of files, TSV parsing) a worker avoids jank, and `File`
  objects are structured-cloneable so the existing collection code does not change. Reasonable to
  ship main-thread first and move to a worker if profiling says so.
- **Gating and rendering:** map `result.issues.issues` (flat list; group client-side by `code`, or use
  `result.issues.groupBy("code")`) into an issues panel; block the upload button on any
  `severity === "error"` — matching CI, which gates on errors only (`--ignoreWarnings`). `detectErrors()`
  from `/validate` is the upstream helper for exactly this.
- **Privacy and CSP:** the default schema is bundled, so validation is fully local with no new
  network destinations; the promised "no file content leaves the browser" note in the UI is accurate
  with no CSP changes.

## 6. Lockstep proposal (CLI, CI, browser on one version)

The version already flows from a single source inside nemar-cli
(`validator-version.json` → CLI subprocess, shim interpolation, central workflow payload, with tests
asserting each hop). Extend that spine across repos rather than inventing a second one:

1. **nemar-cli stays the source of truth.** The website adds the same pin as an exact dependency
   (`npm:@jsr/bids__validator@3.0.1`, no version range) — a version bump is then an ordinary,
   QA-able PR through `staging`, which is how this repo already ships everything.
2. **Drift detection in website CI:** a small check (in the existing CI workflow) that fetches
   `https://raw.githubusercontent.com/nemarOrg/nemar-cli/main/validator-version.json` and compares it
   to the website's pinned version, failing (or loudly warning) on mismatch. This mirrors how
   nemar-cli's own tests pin the shim to the JSON file.
3. **Bump automation:** when nemar-cli's `bump-validator.yml` opens its weekly bump PR, either
   (a) mirror the workflow in the website repo against the same JSR metadata endpoint and major
   variable — both repos then converge on the same latest X.Y.Z within a week — or (b) have
   nemar-cli's workflow additionally open the website PR via a cross-repo token. Option (a) is less
   coupling for the same outcome and needs no new secrets; the CI drift check from point 2 catches
   the window where one repo has merged and the other has not.
4. Transient skew is acceptable by design: the browser pass is user experience, not the trust
   boundary — repo CI remains authoritative (explicit non-goal in website#161), so a few days of
   version skew degrades to slightly-different advisory output, never to wrong gating.

## 7. Open questions / spike items before committing

1. **Error-set equivalence on real NEMAR datasets (the publication gate).** Run 2.4.1 vs 3.0.1 over a
   sample of real checked-out dataset repos, including annexed and derivative-bearing ones, and diff
   post-annex-filter error sets. The new broken-symlink issues interacting with the git-annex
   pointer-file filter in `run-bids-validation.yml` is the one place a behavior change could flip a
   CI verdict. This is ask #2 of issue #1036 and the only genuine gate.
2. **Vite bundling parity.** My spike used `bun build`; Astro client islands bundle through
   Vite/Rollup. Verify the same code-splitting (initial ~290 kB gzip, HED chunk lazy) and that no
   Node-builtin polyfills are demanded. Upstream's own web app builds with Vite, so the expectation
   is strong; the upstream config leans on `vite-plugin-node-polyfills` for a `Buffer` global —
   check whether the library path (as opposed to their full app) needs it.
3. **Memory and time on large drops.** `fileListToTree` holds `File` handles, not contents, and reads
   lazily, so hundreds of gigabytes should be fine; validate on a realistic large EEG dataset before
   claiming it in the UI (worker decision follows from this profiling).
4. **Schema pin philosophy.** Both CLI and browser use the schema bundled with the pinned validator
   (1.2.7 at 3.0.1), so schema lockstep is transitive; decide explicitly to never pass a schema
   version/URL option in the browser so no network fetch path exists.
5. **Website drag-and-drop path synthesis.** Decide between the `webkitRelativePath` defineProperty
   shim (works, slightly hacky) and building the tree from the public `filesToTree` +
   `BrowserFileOpener` primitives (cleaner, a little more code).
6. **Follow-up, not blocking:** whether the central CI should adopt `--git-ref` with the annex-aware
   opener and retire the pointer-file error filtering.

## Bottom line

The 2.x pin is the only blocker, and 3.0.1 dissolves it: stable release, purpose-built browser entry
points, identical CLI and JSON output surface for nemar-cli, verified 289 kB gzip initial browser
bundle with the HED validator split out and lazy, and a successful end-to-end validation run from
browser-shaped `File` inputs under Bun. The recommended path is: bump nemar-cli's pin to 3.0.1 behind
a side-by-side error-set comparison on real datasets, widen `bump-validator.yml` with the major as a
variable, then implement website#161 against `@bids/validator/validate` + `@bids/validator/files/browser`
with an exact-version pin and a CI drift check against nemar-cli's `validator-version.json`. The
server-side pre-flight fallback contemplated in issue #1036 is not needed.
