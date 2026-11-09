# ADR 0118: The Zarr read core is shared, and the local engine speaks a versioned protocol

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
   `shared/zarr-engine-protocol.schema.json` (JSON Schema, draft 2020-12) is the source of truth.
   `shared/contract/zarr-engine-protocol.ts` is a hand-written zod mirror, not generated from it, and `test/zarr-engine-protocol-contract.test.ts` runs one table of cases through both and requires the same verdict and parsed value.
3. **Every message in either direction is one frame.**
   Magic `NZE0`; `header_len` as a little-endian u32; a UTF-8 JSON header right-padded with spaces so that `8 + header_len` is a multiple of 8; then `payload_bytes` of binary samples.
   The padding makes a float64 payload start 8-byte aligned, so numpy `frombuffer` and MATLAB `typecast` read it without a copy.
   `header_len` is at most 1 MiB.
   The payload limit is the engine's policy and is not in the schema.
   `shared/zarr/protocol-frame.ts` is the TypeScript codec; `scripts/zarr/engine_frame_fixtures.py` is an independent Python implementation, and `test/zarr-engine-frame.test.ts` requires the two to produce identical bytes.
4. **The messages** are `hello`, `open`, `read_window`, `recipe` and `release`, answered by `hello`, `opened`, `window`, `recipe` and `released`, or by `error` with one of ten codes.
   A request carries a client-chosen integer `id` of at least 1 and the response echoes it; an `error` reply carries `id: null` when the request's id could not be read (an unparseable frame, invalid JSON, a missing or non-integer id), and no other message may; v0 handles one request at a time.
   `payload_bytes` is 0 on every message except `window`, where it equals `channels.length * n_samples` times 8 (`float64`) or 2 (`int16`); the JSON Schema documents that arithmetic and the zod mirror enforces it.
   `units: "digital"` returns the raw int16 with no scale or offset applied; the bound representation carries `scale` and `offset`, one entry per channel, with physical = digital * scale[c] + offset[c], so a digital client can convert.
   Channel names are deferred: neither the published records nor the Zarr index carry them today.
   A window is addressed in time by the MCP's own rule, one helper both use (`shared/zarr/window-samples.ts`): `start_sample = floor(start_s * sampling_frequency + 0.5)` and `n_samples = floor(duration_s * sampling_frequency + 0.5)`, ties rounding up, with the bound representation's rate; if `n_samples < 1`, or `start_sample` is at or past its `ntimes`, or `start_sample + n_samples` exceeds it, the engine answers `out_of_range` and never returns a truncated window.
   An omitted `channels` means all channels of the bound representation in ascending order, payload row i is `channels[i]`, channels must not repeat, and an index of `nchans` or more is `out_of_range`.
   `filled_ranges` are absolute sample indices, end-exclusive, sorted, non-overlapping (adjacent ones may or may not be merged) and inside the window; the payload inside one is the array's fill value (0 for these stores) converted like any other value, so for `physical` it is `offset[c]`.
   A `hello` request names any `MAJOR.MINOR`, and the engine reads it before validating the rest of the hello: a version it does not speak is `unsupported_version` even when the rest of the hello does not validate, and a malformed one is `invalid_message`.
   JSON Schema cannot check the `payload_bytes` arithmetic, unique representation ids, that `opened.representation` is listed and is a `zarr` representation with non-null `sampling_frequency`, `nchans`, `ntimes`, `scale` and `offset`, or the `scale` and `offset` lengths; the zod mirror does, and clients in other languages must.
   The `hello` response carries `max_payload_bytes`, the largest payload the engine will send; a `read_window` whose window would exceed it is `too_large`, and the value itself is engine policy.
5. **`opened` describes the recording in neuroschema and its stored forms separately.**
   `opened.recording` is always the BIDS path, even when `open` named the store's zarr path, and `record` is the neuroschema `record` whose `bids_relpath` equals it, from the dataset's latest published `records.json`, passed through exactly as published, or `null` when there is none (ADR 0005: missing metadata never blocks a read).
   It is typed as a bare object in the protocol schema, because neuroschema's schemas have no resolvable `$id`; nemar-cli vendors the neuroschema record schema next to the dataset one and tests real records against it.
   The engine never refuses to open because a record fails that schema, and a client must not reject one on its `schema_version` stamp: the published records are stamped 0.3.0 while conforming to 0.4.1.
   That is this ADR's decision under ADR 0005; the live `metadata.json` check already only warns on neuroschema conformance (ADR 0077, #1247), which is the precedent.
   The record may come from another release than the Zarr copy, since records are per version and the Zarr index is the latest serving copy.
   `representations` lists every form the samples can be read from, each with a `kind` and an `id` unique within the recording; v0 defines `zarr`, one per Zarr group, and a client skips a kind it does not know.
   A `zarr` representation uses neuroschema field names (`sampling_frequency`, `nchans`, `ntimes`, `recording_duration`) for the group's own values, and fields the index lacks are `null`, not absent.
   `open` may name a representation; otherwise the engine binds the first `zarr` one in the Zarr index's group order, as the MCP picks the first group, and `opened.representation` says which.
   In v0 only a `zarr` representation can be bound: naming another kind, or opening a recording with no `zarr` representation, is `not_found`, and a group the index does not describe well enough to read (no positive rate, channel count or sample count) is `upstream_error`.
   The record is the authority for file-level facts and none of them is renamed outside it.
   A `zarr` representation carries two values that resemble record facts but belong to its group: the group's `modality` (a recording can hold groups of several modalities) and `source_sampling_frequency`, the source rate the converter recorded for that group; for the file's own rate the record wins.
6. **Compatibility.**
   Every message is open: the engine MUST ignore unknown fields in a request and a client MUST ignore unknown fields in a response, so from v1 a minor version may add fields in either direction.
   Open is not loose: a missing required field or a known field with an invalid value is still `invalid_message`.
   The `filled_ranges` items and the representations are open too.
   `hello` and `recipe` share a `type` between request and response, so each request has a marker field (`client`, `handle`) that the response never carries.
   The first draft closed requests; that was reversed (2026-11-08) because the contract forbids a closed schema under `shared/contract/` (`test/contract-schemas.test.ts`: one closed schema breaks every un-upgraded client), and because an older engine refusing a newer client's request is the failure open messages exist to prevent.
   A client treats an error code it does not know as `internal`, and refuses a `window` whose `dtype`, `layout` or `byte_order` it does not know rather than guess at the bytes.
   A field added to a request in a minor must be safe for an older engine to ignore, and a client relies on a newer request field only when the engine's `hello` response names a version that defines it.
7. **Versioning.**
   `hello` carries the protocol version.
   In v0 the engine speaks only `"0.1"`, because v0 is unstable; from v1 a minor mismatch is accepted and only the major must match.
   v0 is published at `https://api.nemar.org/schemas/zarr-engine-protocol-v0.json` and is the one published schema that may change in place; every version after it is immutable like the index schema.
8. **Missing data is never zeros.**
   A `window` reports what could not be read in `filled_ranges` (ADR 0005).
9. **Still open:** plan A versus plan B for shipping the engine; private-dataset access, where ADR 0114's credential helper is the likely route; and a Unix-domain socket, which would add a transport and not change the messages.

## Consequences

- **One decoder to maintain.**
  A fix to chunk decoding or shard indexing lands once and reaches the MCP and the engine together; the cost is that `shared/zarr/` can never import anything the Worker cannot run.
- **A client needs three small things in any language:** an 8-byte prefix reader, a JSON parser, and a typed-array view over the payload.
- **The two protocol copies can disagree in known places by design.**
  JSON Schema cannot check the `payload_bytes` arithmetic or the cross-field rules of `opened`, and the `recipe` response is typed as a bare object there while zod validates the full MCP recipe.
  Each gap has a test that pins it, so closing one later is a visible change.
- **Metadata has one owner.**
  A client reads file-level facts (the file's modality, BIDS entities, the file's own rate and channel count) from the neuroschema record and never from a representation, so a neuroschema change reaches engine clients without a protocol change; the price is that a client must be ready for `record: null`.
- **New stored forms do not break clients.**
  A derivative or another format becomes a new representation `kind` that old clients skip.
- **v0 gives no stability promise.**
  A client written against it can break until v1; `unsupported_version` in answer to `hello` makes that a clear refusal instead of a silent misread.
- **Requests are serialized.**
  The `id` field is already there, so concurrent requests can be added without breaking the format.
- **This ADR's number is provisional.**
  Upstream's compute epic (nemarOrg/nemar-cli#2021) has reserved 0118 and 0119, so this record will be renumbered when the work goes upstream; the gapless-index test is why it is 0118 here.

## Alternatives considered

- **Closed requests (the engine rejects an unknown request field).**
  The first draft's rule. It breaks the repository's ban on closed schemas in `shared/contract/`, and it turns every newer client into an error against an older engine; ignoring unknown fields, with new request fields safe to ignore, gives the same safety for known fields.
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

- `shared/zarr-engine-protocol.schema.json`, `shared/contract/zarr-engine-protocol.ts`, `shared/zarr/protocol-frame.ts`.
- `test/zarr-engine-protocol-contract.test.ts`, `test/zarr-engine-frame.test.ts`, `test/fixtures/engine-frames/`, `scripts/zarr/engine_frame_fixtures.py`.
- `shared/contract/neuroschema/record.bundle.json`, `test/contract-neuroschema-record.test.ts`, `test/fixtures/neuroschema-records/` (three records from nm000103's public `records.json`); `shared/zarr/window-samples.ts` and `backend/test/zarr-window-samples.test.ts`.
- `backend/src/routes/schemas.ts` serves the v0 schema; `backend/test/zarr-index-v3.test.ts` tests it.
- ADR 0005, ADR 0029, ADR 0037, ADR 0057, ADR 0077 (precedent only), ADR 0114.
