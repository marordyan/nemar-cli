# ADR 0120: The Zarr read core is shared, and the local engine speaks a versioned protocol

**Status:** proposed
**Date:** 2026-11-05
**Owner:** Maria Mordyan

## Context

The Worker's MCP server reads level-0 windows out of the Zarr serving copy (sharded, blosc-compressed Zarr v3).
The same read is wanted by programs that are not the Worker: the CLI, and through it Python and MATLAB sessions.
Two copies of a decoder that has to agree with the converter byte for byte would drift, and ADR 0057 records what drift costs.

The code runs inside a Worker, so it is held to the Worker's limits: no filesystem, no `node:` or `bun:` imports, no WebAssembly, and network and cache access only through what the caller hands in.
Whatever other programs speak to the CLI must be understood by three languages, must not open a port that any local process or web page could reach, and must carry float64 samples without losing a bit.
It is not known yet whether the engine ships inside the CLI (plan A) or as a separate download (plan B), nor how a private dataset is read.
NEMAR describes recordings in neuroschema (nemarOrg/neuroschema): a `record` document per primary signal file, published for each dataset version in `records.json`.
ADR 0037 says to take the standard that owns the meaning instead of naming the same facts again.
A Zarr store is not the file, though: one recording can have several groups, and a group's rate can differ from the file's (nm000103's 500 Hz files are served as 250 Hz groups).

## Decision

1. **The read core lives in `shared/zarr/` and is pure TypeScript.**
   Metadata, shard footers, chunk decoding and window assembly are one copy, imported by the Worker.
   I/O happens only through the `Fetcher` and `JsonCache` interfaces; no WebAssembly.
   Rules that exist only for the MCP (taste caps, the wire form with seconds, the envelope) stay in the Worker.
2. **The local engine speaks a versioned protocol over its own stdin and stdout, never TCP.**
   `shared/zarr-engine-protocol.schema.json` (JSON Schema, draft 2020-12) is the source of truth; its `$defs/Request` and `$defs/Response` are what an engine and a client validate against, and its root accepts either direction.
   `shared/contract/zarr-engine-protocol.ts` is a hand-written zod mirror, not generated from it, and `test/zarr-engine-protocol-contract.test.ts` runs one table of cases through both and requires the same verdict and parsed value, except for the gaps the JSON Schema cannot express, which the test file lists and tests on the zod side.
3. **Every message in either direction is one frame.**
   Magic `NZE0`; `header_len` as a little-endian u32; a UTF-8 JSON header right-padded with spaces so that `8 + header_len` is a multiple of 8; then `payload_bytes` of binary samples.
   The padding makes a float64 payload start 8-byte aligned, so numpy `frombuffer` and MATLAB `typecast` read it without a copy.
   `header_len` is at most 1 MiB.
   The payload limit is the engine's policy and is not in the schema.
   `shared/zarr/protocol-frame.ts` is the TypeScript codec; `scripts/zarr/engine_frame_fixtures.py` is an independent Python implementation, and `test/zarr-engine-frame.test.ts` requires the two to produce identical bytes.
4. **The messages** are `hello`, `open`, `read_window`, `recipe` and `release`, answered by `hello`, `opened`, `window`, `recipe` and `released`, or by `error`, whose `code` is any non-empty string: this version defines ten, listed in the schema, and a client treats an unknown one as `internal` (decision 6).
   A request carries a client-chosen integer `id` from 1 to 2^53 - 1 (the largest integer a double holds exactly, so a client whose JSON parser reads doubles echoes it unchanged) and the response echoes it; an `error` reply carries `id: null` when the request's id could not be read (an unparseable frame, invalid JSON, a missing or non-integer id), and no other message may; v0 handles one request at a time.
   `payload_bytes` is 0 on every message except `window`, where it equals `channels.length * n_samples` times 8 (`float64`) or 2 (`int16`); the JSON Schema documents that arithmetic and the zod mirror enforces it.
   `units: "digital"` returns the raw int16 with no scale or offset applied; the bound representation carries `scale` and `offset`, one entry per channel, with physical = digital * scale[c] + offset[c], so a digital client can convert.
   Channel names are deferred: neither the published records nor the Zarr index carry them today.
   A window is addressed in time by the MCP's own rule, one helper both use (`shared/zarr/window-samples.ts`): `start_sample = floor(start_s * sampling_frequency + 0.5)` and `n_samples = floor(duration_s * sampling_frequency + 0.5)`, ties rounding up, with the bound representation's rate; if `n_samples < 1`, or `start_sample` is at or past its `ntimes`, or `start_sample + n_samples` exceeds it, the engine answers `out_of_range` and never returns a truncated window.
   An omitted `channels` means all channels of the bound representation in ascending order; a window's `channels` equals the request's exactly, in the request's order, or that ascending list when the request omitted it; payload row i is `channels[i]`, channels must not repeat, and an index of `nchans` or more is `out_of_range`.
   A recipe's `channel_slice` is the half-open range from the lowest requested channel to one past the highest, so it can include channels the request did not name, and it is absent when the request named no channels.
   The recipe is the MCP's read-recipe object; the protocol schema types only its `channel_slice` and `sample_slice`, as `Range` objects (`{start, end}`, half-open, the MCP's `rangeSchema`), because a client checks them against its request, and leaves the rest loose until v1. `sample_slice` is always present and is `[start_sample, start_sample + n_samples)`.
   `filled_ranges` are absolute sample indices, end-exclusive, sorted, non-overlapping (adjacent ones may or may not be merged) and inside the window; the payload inside one is the array's fill value (0 for these stores) converted like any other value, so for `physical` it is `offset[c]`.
   A `hello` request names any `MAJOR.MINOR` (no leading zeros; major and minor compare as integers), and the engine reads it before validating the rest of the hello: a version it does not speak is `unsupported_version` even when the rest of the hello does not validate, and a malformed one is `invalid_message`.
   `hello` is the first request: another request before a successful `hello`, or a second `hello` after a successful one, is `invalid_message`; after `unsupported_version` the engine keeps running and the client may try another version.
   Each error code is defined in the schema, including which are worth retrying: `not_ready` (the serving copy is not available yet), `too_large` (with a smaller window) and `upstream_error` (only for a host failure); `decode_error` (bytes that cannot be decoded) is not.
   JSON Schema cannot check the `payload_bytes` arithmetic, unique representation ids, that `opened.representation` is listed and is a `zarr` representation with non-null `sampling_frequency`, `nchans`, `ntimes`, `scale` and `offset`, the `scale` and `offset` lengths when `nchans` is known, or that a `Range`'s `end` is at least its `start`; the zod mirror does, and clients in other languages must.
   A window always has at least one sample, and a bound representation's `ntimes` is at least 1.
   The `hello` response carries `max_payload_bytes`, the largest payload the engine will send; a `read_window` whose window would exceed it is `too_large`, and the value itself is engine policy.
5. **`opened` describes the recording in neuroschema and its stored forms separately.**
   `opened.recording` is always the BIDS path, even when `open` named the store's zarr path, and `record` is the neuroschema `record` whose `bids_relpath` equals it, from the dataset's latest published `records.json`, passed through exactly as published, or `null` when there is none (ADR 0005: missing metadata never blocks a read).
   It is typed as a bare object in the protocol schema, because neuroschema's schemas have no resolvable `$id`; nemar-cli vendors the neuroschema record schema next to the dataset one and tests real records against it.
   The engine never refuses to open because a record fails that schema, and a client must not reject one on its `schema_version` stamp: the sampled published records are stamped 0.3.0 and conform to 0.4.1.
   That is this ADR's decision under ADR 0005; the live `metadata.json` check already only warns on neuroschema conformance (ADR 0077, #1247), which is the precedent.
   The record may come from another release than the Zarr copy, since records are per version and the Zarr index is the latest serving copy.
   `representations` lists every form the samples can be read from, each with a `kind` and an `id` unique within the recording; v0 defines `zarr`, one per Zarr group, and a client skips a kind it does not know.
   A `zarr` representation uses neuroschema field names (`sampling_frequency`, `nchans`, `ntimes`, `recording_duration`) for the group's own values, and fields the index lacks are `null`, not absent.
   `open` may name a representation; otherwise the engine binds the first `zarr` one in the Zarr index's group order, as the MCP picks the first group, and `opened.representation` says which.
   In v0 only a `zarr` representation can be bound: naming another kind, or opening a recording with no `zarr` representation, is `not_found`, and a group the index does not describe well enough to read (no positive rate, no channel count of at least 1, or no sample count of at least 1, as the MCP `read_window` tool treats it) is `upstream_error`.
   The record is the authority for file-level facts and none of them is renamed outside it.
   A `zarr` representation carries two values that resemble record facts but belong to its group: the group's `modality` (a recording can hold groups of several modalities) and `source_sampling_frequency`, the source rate the converter recorded for that group; for the file's own rate the record wins.
6. **Compatibility.**
   Every message is open: the engine MUST ignore unknown fields in a request and a client MUST ignore unknown fields in a response, so from v1 a minor version may add fields in either direction.
   Open is not loose: a missing required field or a known field with an invalid value is still `invalid_message`.
   The price is that a misspelled optional request field is ignored rather than refused (`unit` for `units`, `chanels` for `channels`, `representaton` for `representation`), so a client checks the answer against what it asked for: `opened.representation`, a window's `channels` and `dtype`, and a recipe's `channel_slice` (absent when the request named no channels).
   The `filled_ranges` items and the representations are open too.
   `hello` and `recipe` share a `type` between request and response, so each request has a marker field (`client`, `handle`) that the response never carries.
   The first draft closed requests; that was reversed on 2026-11-08 for two reasons.
   No zod schema under `shared/contract/` may call `.strict()` (`test/contract-schemas.test.ts`: one strict schema there breaks every un-upgraded client), and the protocol's JSON Schema leaves its objects open too, so the two keep giving the same verdicts.
   And an older engine refusing a newer client's request is the failure open messages exist to prevent.
   Error codes are an open set (any non-empty string validates), so a client that validates against `$defs/Response` still receives a code a later version adds, and treats a code it does not know as `internal` (the zod mirror's `normalizeErrorCode` does this; a parsed error keeps the code it was sent). A client refuses a `window` whose `dtype`, `layout` or `byte_order` it does not know rather than guess at the bytes.
   A field added to a request in a minor must be safe for an older engine to ignore, and a client relies on a newer request field only when the engine's `hello` response names a version that defines it.
   Likewise a field added to a response in a minor must be safe for an older client to ignore: anything that changes how a payload is read comes as a new `dtype`, `layout` or `byte_order` value, which an older client refuses, or in a new major.
7. **Versioning.**
   `hello` carries the protocol version.
   In v0 the engine speaks only `"0.1"`, because v0 is unstable; from v1 a minor mismatch is accepted and only the major must match.
   v0 is published at `https://api.nemar.org/schemas/zarr-engine-protocol-v0.json` and is the one published schema that may change in place; every version after it is immutable like the index schema.
8. **Missing data is never zeros.**
   A `window` reports what could not be read in `filled_ranges` (ADR 0005).
9. **Still open:** plan A versus plan B for shipping the engine; private-dataset access, where ADR 0114's credential helper is the likely route (and what, if anything, may be cached on disk, decision 11); and a Unix-domain socket, which would add a transport and not change the messages.
10. **Engine policies (phase 4, `src/lib/zarr-engine/`).**
   These are the engine's rules, not the protocol's.
   *Framing.* Bad JSON or a bad header with an intact prefix is `invalid_message` with `id: null` and the engine keeps reading; bad magic, a `header_len` over the limit, an unpadded prefix, a request payload over 1 MiB, and end of input inside a frame cannot be resynchronized, so the engine sends the same error and exits with status 2; end of input between frames exits 0; logs go to stderr only; requests are handled one at a time.
   *Hosts.* The zarr base (`NEMAR_ZARR_BASE`, else the host that goes with the active account's API host: `https://zarr.nemar.org` for `api.nemar.org`, `https://zarr-test.nemar.org` for `api-test.nemar.org`, and production for any other API host), the data-plane base (`NEMAR_ZARR_DATA_PLANE`, default the API origin plus `/data`) and the index's `data_base` and `contract_base` must be `https`, or `http` to a loopback address only, the exception ADR 0114 makes for `NEMAR_DATA_HOSTS`. Loopback here means the literal addresses `127.0.0.1` and `[::1]`; unlike ADR 0114's list, the name `localhost` is refused, because the hosts file decides where a name resolves.
   These settings are not ADR 0114's list: they are never added to `NEMAR_DATA_HOSTS` and never decide where a credential goes, and `src/lib/data-hosts.ts` stays the only list a credential follows.
   The public fetcher sends no `Authorization` or `Cookie` and refuses a request that carries one; every cache key starts with the source kind (`public`).
   *The record* comes from the dataset's data-plane version listing: its `latest`, then `<latest>/records.json`, the record whose `bids_relpath` is the recording; any failure is `record: null` and one line on stderr, and the open succeeds.
   *Limits.* `max_payload_bytes` defaults to 256 MiB (`NEMAR_ZARR_MAX_PAYLOAD_BYTES`), and a read whose decode work (store channels x samples x 2 bytes) would exceed it is `too_large` as well, before anything is fetched, because a chunk holds every channel; the range cache holds 256 MiB of `206` bodies (`NEMAR_ZARR_RANGE_CACHE_BYTES`) so a repeated window sends no range request.
   *Bodies and bounds.* A reply's `record` over 256 KiB (serialized) is sent as `null` with one stderr line, like a missing record, and a reply that still cannot be framed (a header over 1 MiB) is an `internal` error for its request while the engine keeps serving.
   A response body is never read past a bound: a JSON document past its limit (counted in bytes) fails without being read whole, a `Range` request is bounded by the length it asks for (a `206` whose `Content-Length` or body differs fails as `upstream_error`; any other status keeps its status and a body cut at that length), and any other body the read core reads is bounded at 8 MiB.
   Because that asked-for length comes from the shard footer, which the data host serves, each `Range` read of a window is also capped, before it is sent, at what the store's geometry allows (the chunks the window can touch, each holding every channel, plus 64 bytes of compression overhead per chunk); a footer claiming more is `upstream_error`.
   The process keeps the parsed index and the records of the 4 most recently used datasets, and at most 1024 handles are open (an `open` beyond that is `too_large`, telling the client to release handles).
   A redirect from `https` to `http` is refused even to loopback, an index's `data_base` and `contract_base` may be plain `http` to loopback only when the configured zarr base is itself plain `http` to loopback (otherwise they must be `https`), and an index naming a `zarr` path or group with a `..` segment, a leading `/`, `?`, `#`, `%` (the URL parser decodes `%2e%2e` to `..`), a backslash or a control character is `upstream_error`.
   The fetcher refuses `Proxy-Authorization` as well; Bun honours `HTTP_PROXY` and `HTTPS_PROXY`, and the no-credentials guarantee does not cover a proxy URL's own userinfo.
   Index-derived strings written to stderr are JSON-quoted so a control character cannot forge a log line.
   *A private source, when one is added,* attaches credentials per request and only to an origin `src/lib/data-hosts.ts` admits, never because "this dataset is private", never across a redirect, and never from the index's `data_base`, which is a published document.
   Private bytes are not written to disk without a decision first (decision 11), since access can be revoked and cached bytes would outlive it.
11. **The disk cache (phase 5, `src/lib/zarr-engine/disk-cache.ts`).**
   A repeated read sends no data (range) request, even after the engine restarts, because the engine keeps `206` range bodies, and the read core's JSON (shard footers and array metadata) as a second tier behind the in-memory cache, on disk.
   The dataset's `index.json` and records are still read again at each engine start; only the data requests are saved.
   *Public only, one cache per host.* Only the public source writes it. It lives at `<config dir>/zarr-cache/public/v1/` (`NEMAR_ZARR_DISK_CACHE_DIR` overrides the directory), created at mode 0700 (the directory and each one above it up to the config directory; a directory named by `NEMAR_ZARR_DISK_CACHE_DIR` is made 0700 too, so name one that is meant to be private), and holds 2 GiB by default (`NEMAR_ZARR_DISK_CACHE_BYTES`; `0` turns it off).
   *The key is the store's identity.* Chunk URLs do not change when a store is re-converted (`data_base` is `<id>/zarr/`), so a key of URL and Range would serve the old bytes for the new store. Every key (in memory too) is the source kind, the origin of `data_base`, the dataset id, `source_commit` and the index's `updated_utc` (the `convertedAt` the JSON cache already uses), then the URL and the Range.
   *`index.json` is never cached on disk.* It is read again at each engine start, which is how a re-conversion is noticed; a changed `updated_utc` makes every older entry unreachable, and the eviction removes it in time.
   *Entries are verified and written whole.* One file per entry, named for the hash of its key, holding a magic word, the full key, the body length and the body; a read checks all of it, and an entry that fails is a miss and is deleted. A write goes to a temporary file in the same directory and is renamed into place, so a crash or a second engine never leaves a torn entry. Only a `206` body of exactly the asked length, after the byte caps, is stored.
   *The directory is the cache's own, and links are not followed.* An entry is opened without following a link and must be a regular file within the limit; an entry subdirectory that is a link, or not a directory, is refused and nothing is written or chmodded through it. When the cache creates its root it writes a marker file there (`.nemar-zarr-cache`); `nemar engine cache clear` refuses a directory without it, and removes only files named like entries inside the two-hex-digit directories, so a setting that names an unrelated folder cannot cost it anything.
   *Several engines may share the directory.* Each instance rescans the directory total once its own writes since the last scan pass a tenth of the limit, so the cache stays near its limit and does not grow to one limit per engine.
   *The engine child gets an allowlisted environment* (the home, temporary and locale variables, proxy and certificate settings, `NEMAR_CONFIG_DIR`, `TEST_API_URL` and `NEMAR_ZARR_*`): it sends no credential, so `NEMAR_API_KEY` and the rest of the parent's environment are not passed. Its `NEMAR_ZARR_MAX_PAYLOAD_BYTES` may not exceed 1 GiB, the largest reply the CLI client reads, so a window that is too big is `too_large` and never a framing failure.
   *The cache never fails a read.* A disk error is a miss, with one stderr line. A hit refreshes the file's modification time; a write that takes the total past the limit deletes the oldest entries until it is at 90%; a missing file is tolerated everywhere because two engines may share the directory.
   *The rule for a private source, when one is added:* private bytes get their own per-account location, or none, under a separate decision, and are wiped on logout or revocation. They never share this directory.
   *The edge case:* a public dataset that is later made private leaves its public bytes in this cache until they are cleared (`nemar engine cache clear`) or evicted; the cache cannot see the change, because it never asks the host again for bytes it holds.
   *The commands* `nemar zarr read`, `nemar engine status`, `nemar engine cache clear` and the Zarr engine section of `nemar doctor` start the engine as the hidden subcommand `nemar __zarr-engine`, which is dispatched before notices and the update check.

## Consequences

- **One decoder to maintain.**
  A fix to chunk decoding or shard indexing lands once and reaches the MCP and the engine together; the cost is that `shared/zarr/` can never import anything the Worker cannot run.
- **A client needs three small things in any language:** an 8-byte prefix reader, a JSON parser, and a typed-array view over the payload.
- **The two protocol copies can disagree in known places by design.**
  JSON Schema cannot check the `payload_bytes` arithmetic or the cross-field rules of `opened`, and the `recipe` response is typed there only as far as its `channel_slice` and `sample_slice` while zod validates the full MCP recipe; a `Range` whose `end` is before its `start` is caught by zod only.
  Each gap has a test that pins it, so closing one later is a visible change.
- **Metadata has one owner.**
  A client reads file-level facts (the file's modality, BIDS entities, the file's own rate and channel count) from the neuroschema record and never from a representation, so a neuroschema change reaches engine clients without a protocol change; the price is that a client must be ready for `record: null`.
- **New stored forms do not break clients.**
  A derivative or another format becomes a new representation `kind` that old clients skip.
- **v0 gives no stability promise.**
  A client written against it can break until v1; `unsupported_version` in answer to `hello` makes that a clear refusal instead of a silent misread.
- **Requests are serialized.**
  The `id` field is already there, so concurrent requests can be added without breaking the format.
- **This ADR's number was settled when the epic merged upstream `dev`.**
  It was drafted as 0118, but upstream's compute gateway and OpenID Connect records took 0118 and 0119 first, so it is 0120.

- **A repeated read costs nothing, and a cache can outlive its reason.**
  The disk cache holds public bytes for as long as the limit allows; the price is the made-private edge case in decision 11, which `nemar engine cache clear` answers by hand.

## Alternatives considered

- **A disk cache for private data too, or one cache per account.**
  Private bytes outlive the access that fetched them, so they need their own decision about revocation first; a per-account split of public bytes would store the same public chunk once per account for nothing.
- **Caching `index.json` on disk.**
  It is the only thing that says a store was re-converted; a cached copy would hide exactly that.
- **Closed requests (the engine rejects an unknown request field).**
  The first draft's rule. It needs `.strict()` in the zod mirror, which the repository forbids under `shared/contract/` (the JSON Schema would then differ from its mirror), and it turns every newer client into an error against an older engine; ignoring unknown fields, with new request fields safe to ignore, gives the same safety for known fields.
- **Copy the core instead of moving it.**
  A second decoder that must match the first byte for byte; ADR 0057 is the account of how two copies of one thing diverge.
- **Put the core in `src/lib/zarr/`.**
  The Worker cannot import from the CLI tree, so this rules out plan A and forces the copy above.
- **Generate the JSON Schema from zod.**
  Generators drift on shape even when accept and reject agree (`backend/test/mcp-schema-parity.test.ts` explains it); two hand-written copies with a table that runs through both are checked where it matters.
- **Protobuf or MessagePack.**
  A dependency, and a code generator or library, in each of three languages, for a protocol with five requests.
- **Newline-delimited JSON with base64 samples.**
  A third larger than the bytes, and a decode step on both ends for every window.
- **Name the recording's facts in the protocol** (`sample_rate_hz`, `n_channels`, `n_samples`, as the first draft did).
  A second vocabulary for facts neuroschema owns (ADR 0037), and it hid which facts belong to the file and which to a Zarr group.
- **Put the Zarr facts inside the record, or in a new neuroschema extension.**
  The record core is closed (`additionalProperties: false`), and an extension needs a neuroschema release for a protocol that is still unstable.
- **One `zarr` object instead of a list of representations.**
  A recording can have several Zarr groups, and a derivative stored as Zarr would collide with the raw copy.
- **Localhost TCP.**
  Any local process or web page can connect to it; stdio is reachable only by the process that started the engine.

## Receipts

- `shared/zarr-engine-protocol.schema.json`, `shared/contract/zarr-engine-protocol.ts`, `shared/zarr/protocol-frame.ts`; the engine, `src/lib/zarr-engine/`, and `test/zarr-engine-runtime.test.ts` (a real child process).
- `test/zarr-engine-protocol-contract.test.ts`, `test/zarr-engine-frame.test.ts`, `test/fixtures/engine-frames/`, `scripts/zarr/engine_frame_fixtures.py`.
- `shared/contract/neuroschema/record.bundle.json`, `test/contract-neuroschema-record.test.ts`, `test/fixtures/neuroschema-records/` (three records from nm000103's public `records.json`); `shared/zarr/window-samples.ts` and `backend/test/zarr-window-samples.test.ts`.
- `backend/src/routes/schemas.ts` serves the v0 schema; `backend/test/zarr-index-v3.test.ts` tests it.
- `src/lib/zarr-engine/disk-cache.ts`, `test/zarr-engine-disk-cache.test.ts`, the restart tests in `test/zarr-engine-runtime.test.ts`; `src/lib/zarr-engine/client.ts`, `src/commands/zarr.ts`, `src/commands/engine.ts` and their `test/zarr-*cli.test.ts` files.
- ADR 0005, ADR 0029, ADR 0037, ADR 0057, ADR 0077 (precedent only), ADR 0114.
