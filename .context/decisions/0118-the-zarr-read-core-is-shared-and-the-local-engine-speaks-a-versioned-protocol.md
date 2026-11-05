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
   `units: "digital"` returns the raw int16 with no scale or offset applied.
5. **Versioning.**
   `hello` carries the protocol version.
   In v0 it must match exactly (`"0.1"`), because v0 is unstable; from v1 a minor mismatch is accepted and only the major must match.
   v0 is published at `https://api.nemar.org/schemas/zarr-engine-protocol-v0.json` and is the one published schema that may change in place; every version after it is immutable like the index schema.
6. **Missing data is never zeros.**
   A `window` reports what could not be read in `filled_ranges` (ADR 0005).
7. **Still open:** plan A versus plan B for shipping the engine; private-dataset access, where ADR 0114's credential helper is the likely route; and a Unix-domain socket, which would add a transport and not change the messages.

## Consequences

- **One decoder to maintain.**
  A fix to chunk decoding or shard indexing lands once and reaches the MCP and the engine together; the cost is that `shared/zarr/` can never import anything the Worker cannot run.
- **A client needs three small things in any language:** an 8-byte prefix reader, a JSON parser, and a typed-array view over the payload.
- **The two protocol copies can disagree in two places by design.**
  JSON Schema cannot check the `payload_bytes` arithmetic, and the `recipe` response is typed as a bare object there while zod validates the full MCP recipe.
  Both gaps have tests that pin them, so closing one later is a visible change.
- **v0 gives no stability promise.**
  A client written against it can break until v1; the exact-match `hello` makes that a clear refusal instead of a silent misread.
- **Requests are serialized.**
  The `id` field is already there, so concurrent requests can be added without breaking the format.
- **This ADR's number is provisional.**
  Upstream's compute epic (nemarOrg/nemar-cli#2021) has reserved 0118 and 0119, so this record will be renumbered when the work goes upstream; the gapless-index test is why it is 0118 here.

## Alternatives considered

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
- **Localhost TCP.**
  Any local process or web page can connect to it; stdio is reachable only by the process that started the engine.

## Receipts

- `shared/zarr-engine-protocol.schema.json`, `shared/contract/zarr-engine-protocol.ts`, `shared/zarr/protocol-frame.ts`.
- `test/zarr-engine-protocol-contract.test.ts`, `test/zarr-engine-frame.test.ts`, `test/fixtures/engine-frames/`, `scripts/zarr/engine_frame_fixtures.py`.
- `backend/src/routes/schemas.ts` serves the v0 schema; `backend/test/zarr-index-v3.test.ts` tests it.
- ADR 0005, ADR 0029, ADR 0057, ADR 0114.
