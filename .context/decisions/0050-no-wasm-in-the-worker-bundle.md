# ADR 0050: No WebAssembly in the MCP Worker bundle, and real workerd is the only gate that proves it

**Status:** accepted
**Date:** 2026-09-09
**Owner:** Seyed Yahya Shirazi

## Context

The NEMAR Model Context Protocol (MCP) server (epic #1065) runs inside the same Cloudflare Worker
as the rest of the backend. Cloudflare's runtime restricts dynamic code generation, and
WebAssembly (WASM) compilation falls under that restriction, but NOT uniformly, and the difference
turns out to matter:

- **Compiling WASM inside a request is disallowed unconditionally.** No compatibility date or flag
  changes it.
- **Compiling WASM at module load is disallowed for THIS worker specifically**, because
  `backend/wrangler-sccn.toml` pins `compatibility_date = "2024-12-01"`. The
  `allow_eval_during_startup` flag permits it, and became the DEFAULT as of `2025-06-01` (the
  runtime says so in as many words when you specify it past that date: "became the default as of
  2025-06-01 so does not need to be specified anymore").

Either way, a Worker that tries does not degrade; it fails.

Twice, in two different phases, a plausible npm package turned out to be unusable this exact way,
and in neither case could `bun test` have told us:

- **Phase 1, `numcodecs`, evaluated in the transport spike and never adopted.** Its Blosc codec
  loads its WASM module through a runtime `fetch()` followed by `WebAssembly.instantiate()` on the
  fetched bytes, and the published tarball ships no `.wasm` file to import instead. Under real
  workerd: `RuntimeError: Aborted(CompileError: WebAssembly.instantiate(): Wasm code generation
  disallowed by embedder)`, on EVERY `decode_chunk` call. It also cost about 604 KiB of bundle for
  no benefit. It was only ever in `backend/spike/mcp-transport/package.json`, never in
  `backend/package.json`: the spike existed to answer this question and did.
- **Phase 3, `hyparquet-compressors`, installed during development and removed before merge.** Its
  `compressors` export eagerly constructs `hysnappy`'s `snappyUncompressor()` at MODULE LOAD, which
  synchronously compiles a WASM module: `WebAssembly.Module(): Wasm code generation disallowed by
  embedder`. This is the worse shape of the two, because it crashed isolate startup for EVERY
  request rather than only a `get_events` call, and regardless of whether any dataset's parquet
  actually used SNAPPY. It was caught by the smoke script while `bun test` stayed fully green
  (PR #1326), and never reached `backend/package.json`.

Neither was caught by `bun test`, and neither could be. Bun compiles WASM happily, so the suite
stayed green throughout the window `hyparquet-compressors` was installed, and nothing in the suite
exercised `numcodecs` at all. Phase 3's shape would have shipped a worker that could not start;
phase 1's would have failed every decode call. Both were found by running the real runtime, which
is the only thing that can find them.

## Decision

**No package in this server's dependency graph may compile or instantiate WebAssembly, at import or
at runtime.** When a dependency needs WASM for a codec we need, we implement the codec in pure
JavaScript or use a pure-JS package instead, and we say so where the substitution lives.

**A phase that adds or upgrades a dependency is not done until `backend/scripts/mcp-smoke.sh`
has passed under real workerd.** `bun test` is necessary and not sufficient; it cannot observe this
class of failure at all.

The two substitutions this rule has already produced:

- `shared/zarr/codecs/blosc.ts` (formerly `backend/src/services/blosc-decode.ts`) decodes
  blosc/zstd/shuffle int16 chunks in pure JavaScript (a blosc header parse plus `fzstd` plus an unshuffle), replacing `numcodecs`.
- `backend/src/mcp/tools/get-events.ts` builds a one-entry `{ ZSTD }` compressors map over
  `fzstd` instead of importing `hyparquet-compressors`. That the archive is entirely ZSTD is
  measured, not assumed: `bun run zarr:geometry-check` reads every published `events.parquet`
  footer and reports the codec of every column chunk (row group x column).

## Consequences

Easier: the bundle stays small, isolate startup stays fast, and a dependency bump cannot silently
take the server down in a way tests bless.

Harder: we own codec code we would otherwise get for free, and we must keep it correct. The
mitigation is that these decoders are narrow, pure, and tested against real captured production
bytes wherever a real store exercises the path, with synthetic chunks only for shapes the catalog
does not currently contain (a short trailing view chunk, for instance).

**The platform is only half-enforcing this rule for us, and a date bump would stop it enforcing
the other half.** Request-time compilation stays impossible no matter what. But the module-load
half, the shape that kills isolate startup, is currently blocked only because our
`compatibility_date` predates `2025-06-01`. Measured under `wrangler dev --local`: with
`compatibility_date = "2024-12-01"` plus `allow_eval_during_startup`, or with any date from
`2025-06-01` on, the phase 3 entry module compiles its WASM and the worker starts normally. So
**a routine `compatibility_date` bump silently removes the guard that caught the phase 3 failure**,
which is precisely why this rule is written down and gated by the smoke script rather than left to
the runtime to police.

New obligations: every dependency addition or upgrade in this subsystem runs the workerd smoke
before merge, and a reviewer who sees a new dependency should ask what it does at module load.
Reading a package's import-time side effects is now part of the review, not an optimization.

The smoke script currently drives a throwaway entry module
(`backend/scripts/mcp-smoke-entry.ts`) rather than `backend/src/index.ts`, because
`wrangler dev --local` cannot start the real entry in this environment (issue #1324, unrelated to
the MCP work). `index.ts` carries three non-handler named exports (`NON_PROD_SANDBOX_CLEANUP_QUERY`
and `PROD_SANDBOX_CLEANUP_QUERY`, both strings, and `DEV_CRON_ALLOWLIST`, a `readonly string[]`),
and this workerd build rejects any named export on an entry module that is not a function or an
`ExportedHandler`; fixing only the strings would not fix the issue. That is a real gap in the gate:
it proves the MCP sub-app and its dependency graph start under workerd, not that the whole worker
does. Closing #1324 closes the gap.

## Alternatives considered

- **Allow WASM by widening the compatibility settings.** This works, for exactly one of the two
  shapes. Measured under `wrangler dev --local` on the phase 3 entry module: adding
  `allow_eval_during_startup` to `compatibility_flags` (or moving `compatibility_date` to
  `2025-06-01` or later, where it is the default) lets `hysnappy` compile at load and the worker
  starts and answers 200; without it the worker never starts. Rejected anyway, on three grounds:
  it grants dynamic code generation to the whole worker at startup to buy one codec we already
  have in 15 lines of pure JavaScript; it does nothing for the phase 1 shape, since request-time
  compilation stays disallowed under every combination tested; and it would make a
  `compatibility_date` bump a load-bearing security-adjacent decision rather than routine
  maintenance. Note that the flag's documented text names only `eval()` and `new Function(text)`
  and never mentions WebAssembly, so the WASM behavior above is MEASURED, not documented; a future
  reader who consults only the docs page will reach the wrong conclusion.
- **A statically imported `.wasm` module**, which Cloudflare does support (Wrangler bundles
  `.wasm` as a `CompiledWasm` module). Neither offending package ships a `.wasm` file to import,
  so adopting this would mean vendoring and maintaining a fork of each.
- **Keep the WASM packages and lazily load them only on the paths that need them.** Lazy USE does
  not help the phase 3 case at all: `hyparquet-compressors/src/index.js` statically re-exports
  `compressors.js`, so importing anything from the package root runs the eager compile, and the
  failure is at module load taking down every request. A subpath import that never touches
  `compressors.js` was technically available (the package declares no `exports` map), but
  depending on an undeclared internal path is more coupling than a one-entry map over `fzstd`,
  which we already pin. Lazy loading would also leave a landmine for whoever later imports the
  module from a hot path.
- **Trust `bun test` and catch it in staging.** This is what would have happened without the
  smoke gate, and it is why the rule exists: the phase 3 failure crashed isolate startup for
  every request, so the first symptom would have been a fully dead deployment.
- **A dependency allowlist enforced in CI.** Considered and deferred as premature. The check
  that actually catches the failure is running the runtime; a list of forbidden package names
  would need maintaining and would not catch a transitive dependency that adds WASM in a patch
  release.

## Receipts

- `.context/mcp-server-design.md` section 9 (dependency table, both offending rows, including that
  `numcodecs` was the spike's path (a) and never a dependency of the real server), section 10
  (phase 1 decode-path measurements and the bundle figures), section 10.3 (the phase 3 failure).
- `shared/zarr/codecs/blosc.ts` (formerly `backend/src/services/blosc-decode.ts`), `backend/src/mcp/tools/get-events.ts`,
  `backend/scripts/mcp-smoke.sh`, `backend/scripts/mcp-smoke-entry.ts`.
- PR #1326 (the phase 3 failure, caught by the smoke script with `bun test` green).
- Issue #1324 (`wrangler dev --local` cannot start `backend/src/index.ts`).
- The compatibility-flag measurements in this ADR were taken on 2026-09-09 with
  `wrangler dev --local` against a two-line entry module importing `hysnappy@1.0.0`, at module
  load and inside `fetch()`, across `compatibility_date` `2024-12-01` and `2025-11-09` with and
  without `allow_eval_during_startup`.
- ADR 0049 for the posture this server inherits: a stateless, recipe-first broker whose job is
  to hand a client the information to fetch bytes itself, which is what keeps the Worker's
  dependency surface small enough for this rule to be practical.

## Amendment 2026-11-13: the blosc decoder moved

The decoder named above as `backend/src/services/blosc-decode.ts` now lives at `shared/zarr/codecs/blosc.ts`, moved there with the rest of the Zarr reader core under [ADR 0120](0120-the-zarr-read-core-is-shared-and-the-local-engine-speaks-a-versioned-protocol.md) so the Worker and the local engine share one copy. It is the same pure-JavaScript decoder and this rule applies to it unchanged. The paths in the body and the receipts are updated in place; its error messages still begin `blosc-decode:`.
