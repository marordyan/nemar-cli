#!/usr/bin/env -S uv run --with numcodecs python3
"""One-time generator for a synthetic `view/*` pyramid chunk fixture the MCP
`render_overview` tests need (epic #1065 phase 3, issue #1295, PR review item
1).

WHY THIS EXISTS. `render_overview`'s tests need a REAL ADR 0028 derived (SSS-
filtered MEG) store, so `computeProvenanceEnvelope`'s sss-iff-derived
refinement is exercised against a store that actually carries `sss` -- the
bug this fixture's test catches (`buildProjection` in `list-recordings.ts`
was dropping `sss`/`units_report`, making every derived-store envelope
throw) only shows up on a store where `derived: true`. The real live store
(`on003392`, `sub-01/meg/sub-01_task-localizer_meg.zarr`, already committed
as `test/fixtures/zarr-index-on003392-meg-sss-slice.json`) is 320 channels;
its own coarsest view level (`view/4`, 266 columns, one chunk) is 327 KB
compressed -- over the ~150 KB budget for a committed test fixture. So this
script writes a SYNTHETIC chunk with a much smaller channel/column count
instead, encoded with the SAME codec configuration biosigIO's real
`ZarrExporter` uses for a view chunk (`numcodecs.Blosc`, `cname="zstd"`,
`clevel=5`, byte shuffle, one block per chunk) -- so the bytes this script
produces decode through the exact same path
(`shared/zarr/codecs/blosc.ts`'s `decodeBloscZstdInt16`) a real
store's chunk would.

GEOMETRY (single-chunk MEG fixture). 8 channels, 132 columns, one chunk
(`view/3/c/0/0/0` for a synthetic 3-level pyramid over 8500 samples:
`floor(8500/4)=2125`, `floor(2125/4)=531`, `floor(531/4)=132` -- the
biosigio stopping rule halts after 132 because 531 is still above the
512-sample floor but 132 itself is at or below it). Data is a simple
per-channel sine wave (min/max envelope of a few periods across the 132
columns), scaled into a distinct int16 range per channel so the pixel-level
render tests have real variation to check, not a rerun of `nm000329`'s
content -- just a different, small, real-shaped signal.

GEOMETRY (multi-chunk fixture, PR review item 15). A second, SEPARATE
synthetic store/group: 4 channels, 117 columns in ONE view level
(`n_samples=468`, `n_view_levels=1`: `floor(468/4)=117`), chunked at
`view_chunk_columns=50` -- three chunks, `50 + 50 + 17` (a short last
chunk, exercising `reassembleViewChunks`' "chunks must arrive in `k` order,
the last may be shorter" case at the route level, not just the pure-function
level). nm000329's own real `view/3` (the smallest level actually needing 3
chunks) is ~490 KB across its three chunks -- over the fixture budget -- so
this is synthetic too, same codec configuration.

GEOMETRY (sharded level-0 fixture, epic #1065 phase 4, issue #1296). A THIRD,
separate synthetic store for `read_window` taste mode: a small sharded LEVEL-0
signal array (not a view pyramid chunk) using the SAME `sharding_indexed`
codec configuration real level-0 arrays use (`test/fixtures/zarr-array-level0.zarr.json`,
nm000329's real `eeg_250hz` level-0 `zarr.json`) -- `bytes` + `blosc`
(zstd/clevel 5/shuffle/typesize 2) inner codecs, `bytes` + `crc32c` index
codecs, `index_location: "end"`. 4 channels, `chunk_samples` 1000,
`shard_samples` 4000, `n_samples` 6500.

EVERY shard's footer carries `shard_samples // chunk_samples` == 4 entries,
including the boundary shard: the entry count is a property of the chunk grid,
not of how much real data lands in that particular shard. An earlier version
of this generator wrote shard 1 with only THREE entries, matching a reader bug
that computed the count from the remaining extent; because generator and
reader agreed, the whole suite was green while production data was being
misread by 11 chunks (see `sharding.ts`'s module doc for the measured
evidence). The rule here is now the spec's: a chunk whose nominal span lies
entirely past `n_samples` is an ABSENT ENTRY, never an omitted one.

So shard 0 covers samples [0, 4000) with 4 entries and shard 1 covers
[4000, 8000) with 4 entries, of which local index 3 ([7000, 8000)) is absent
because it is wholly past `n_samples`. Local index 2 ([6000, 7000)) STRADDLES
the array's real end and is present and stored FULL SIZE (1000 columns), with
columns past sample 6500 written as `fill_value` 0 -- Zarr never emits a
narrower chunk, verified against nm000329's own final present chunk, which
decodes to 63 x 1000 for 750 real samples. Shard 0's
local index 2 ([2000, 3000)) is deliberately marked ABSENT (both footer fields
`2**64 - 1`) so the mid-array fill-value path is exercised too, and because
its neighbors' byte offsets skip straight past it, it is what exercises
`planShardReads`' "do not coalesce across an absent entry" rule at the route
level, not just the pure-function level. Every present
chunk's digital value is `channel * 100 + (global_sample % chunk_samples)` --
deterministic and hand-computable from the sample index alone, so a test can
assert an exact physical value (`digital * scale[channel] + offset[channel]`)
without re-implementing the encoder. `scale`/`offset` are `[0.5, 1.0, 1.5,
2.0]` / `[10.0, 20.0, 30.0, 40.0]`, real-shaped per-channel arrays matching
the live fixture's `attributes.scale`/`attributes.offset` convention. Writes
`backend/test/fixtures/mcp/nm099500-shard-0.bin`,
`backend/test/fixtures/mcp/nm099500-shard-1.bin` (each a full shard object:
concatenated inner-chunk blosc frames, in local-index order, immediately
followed by its own `n_inner * 16 + 4`-byte footer -- `n_inner` little-endian
uint64 `(offset, nbytes)` pairs plus a 4-byte crc32c placeholder, never
verified by the reader), and
`backend/test/fixtures/mcp/nm099500-level0-zarr.json` (the array's own
`zarr.json`, `attributes.scale`/`attributes.offset` included). The dataset id
`nm099500` is fictitious -- test-fixture-only, chosen INSIDE the dataset id
band `isValidDatasetId` (`backend/src/services/datasetId.ts`) accepts (numeric
part `<= 99999`): this fixture's index.json is read through the real zarr
sub-app (`createZarrDataRoutes`), whose own `isPublicDataset` gate calls
`isValidDatasetId` before touching D1 at all, unlike `mcp-route.test.ts`'s/
`mcp-overview.test.ts`'s `nm5000xx`-band ids, which only ever reach tools that
short-circuit before a real index.json fetch.

USAGE. `uv run --with numcodecs --with pyarrow python3 scripts/zarr/generate_mcp_test_fixture.py`
from the repo root. Writes
`backend/test/fixtures/mcp/on003392-synthetic-meg-view3-c-0-0-0.bin`,
`backend/test/fixtures/mcp/nm000329-synthetic-multichunk-view1-c-0-0-{0,1,2}.bin`,
`backend/test/fixtures/mcp/oversized-events.parquet`,
`backend/test/fixtures/mcp/row-groups-events.parquet`,
`backend/test/fixtures/mcp/no-stats-events.parquet`,
`backend/test/fixtures/mcp/two-group-events.parquet`,
`backend/test/fixtures/mcp/invalid-row-events.parquet`,
and the sharded level-0 fixture set above, printing each one's byte size.
Re-run only if a fixture's geometry needs to change; the committed bytes are
stable and this script is not part of the conversion pipeline.
"""

from __future__ import annotations

import json
import math
import struct
from pathlib import Path

import numpy as np
from numcodecs import Blosc

N_CHANNELS = 8
N_COLUMNS = 132
LEVEL = 3

MULTI_N_CHANNELS = 4
# Nominal chunk stride and the level's real column count. THREE chunks of 50,
# the last carrying 17 real columns and 33 of `fill_value` 0 -- because that is
# what Zarr writes. This used to be `(50, 50, 17)`, a genuinely truncated tail
# chunk that no store contains, and that fixture is why the suite stayed green
# while `render_overview` threw a RangeError on nm000329's DEFAULT width: the
# reassembler inferred each chunk's width from its decoded length, so a padded
# boundary chunk pushed every later column past the end. Same trap as the
# level-0 shard footer above, one axis over.
MULTI_CHUNK_STRIDE = 50
MULTI_TOTAL_COLUMNS = 117

# Sharded level-0 fixture (epic #1065 phase 4, issue #1296) -- see the module
# docstring's "GEOMETRY (sharded level-0 fixture...)" section.
SHARD_DATASET_ID = "nm099500"
SHARD_N_CHANNELS = 4
SHARD_CHUNK_SAMPLES = 1000
SHARD_SAMPLES = 4000
SHARD_N_SAMPLES = 6500
SHARD_SCALE = [0.5, 1.0, 1.5, 2.0]
SHARD_OFFSET = [10.0, 20.0, 30.0, 40.0]
SHARD_ABSENT_MARKER = (1 << 64) - 1

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURES_DIR = REPO_ROOT / "backend" / "test" / "fixtures" / "mcp"
OUT_PATH = FIXTURES_DIR / "on003392-synthetic-meg-view3-c-0-0-0.bin"


def build_minmax_envelope() -> np.ndarray:
    """[2, N_CHANNELS, N_COLUMNS] int16, axis0 = [min, max] (matches the real
    pyramid's `axis0: ["min", "max"]` attribute)."""
    data = np.zeros((2, N_CHANNELS, N_COLUMNS), dtype=np.int16)
    columns = np.arange(N_COLUMNS)
    for ch in range(N_CHANNELS):
        # A distinct amplitude and period per channel so every band has real,
        # channel-specific variation -- not sixteen copies of one signal.
        amplitude = 500 * (ch + 1)
        period = 20 + ch * 3
        center = np.sin(2 * math.pi * columns / period) * amplitude
        spread = 50 + ch * 5
        data[0, ch, :] = (center - spread).astype(np.int16)  # min
        data[1, ch, :] = (center + spread).astype(np.int16)  # max
    return data


def build_multichunk_envelope(valid_columns: int, column_offset: int) -> np.ndarray:
    """[2, MULTI_N_CHANNELS, MULTI_CHUNK_STRIDE] int16 for one chunk of the
    multi-chunk fixture. ALWAYS the full stride: only the first
    `valid_columns` hold signal, the rest stay at `fill_value` 0, which is how
    Zarr stores a boundary chunk. `column_offset` shifts the sine phase so
    consecutive chunks visibly continue one another rather than each starting
    the wave over."""
    data = np.zeros((2, MULTI_N_CHANNELS, MULTI_CHUNK_STRIDE), dtype=np.int16)
    columns = np.arange(column_offset, column_offset + valid_columns)
    for ch in range(MULTI_N_CHANNELS):
        amplitude = 300 * (ch + 1)
        period = 15 + ch * 4
        center = np.sin(2 * math.pi * columns / period) * amplitude
        spread = 30 + ch * 5
        data[0, ch, :valid_columns] = (center - spread).astype(np.int16)
        data[1, ch, :valid_columns] = (center + spread).astype(np.int16)
        # columns valid_columns: left at fill_value 0
    return data


def digital_value(channel: int, global_sample: int) -> int:
    """`channel * 100 + (global_sample % SHARD_CHUNK_SAMPLES)` -- see the
    module docstring's sharded-fixture geometry section for why this
    particular formula (hand-computable, distinguishes every channel, and
    -- because `SHARD_CHUNK_SAMPLES` divides `SHARD_SAMPLES` evenly -- the
    result for a non-boundary chunk depends only on the LOCAL sample offset
    within that chunk, never on which chunk it is)."""
    return channel * 100 + (global_sample % SHARD_CHUNK_SAMPLES)


def build_shard(shard_index: int, absent_local: set[int]) -> bytes:
    """Build one complete shard object for `shard_index`: concatenated
    present-chunk blosc frames in local-index order, followed by the
    `n_inner * 16 + 4`-byte footer (`sharding.ts`'s `footerByteLength`) --
    `n_inner` little-endian uint64 `(offset, nbytes)` pairs, absent entries as
    `(SHARD_ABSENT_MARKER, SHARD_ABSENT_MARKER)`, plus a 4-byte crc32c
    placeholder the reader never verifies.

    `n_inner` is derived here, from `SHARD_SAMPLES // SHARD_CHUNK_SAMPLES`, and
    is the same for every shard -- the caller cannot pass a per-shard count,
    because there is no such thing. `absent_local` names chunks to mark absent
    ON PURPOSE (the mid-array fill-value case); a chunk whose nominal span
    starts at or past `SHARD_N_SAMPLES` is marked absent automatically, and a
    chunk that merely straddles `SHARD_N_SAMPLES` is written FULL SIZE with the
    out-of-extent columns left at `fill_value` 0."""
    codec = Blosc(cname="zstd", clevel=5, shuffle=Blosc.SHUFFLE, blocksize=0)
    n_inner = SHARD_SAMPLES // SHARD_CHUNK_SAMPLES
    body = bytearray()
    footer_pairs: list[tuple[int, int]] = []
    for local in range(n_inner):
        start = shard_index * SHARD_SAMPLES + local * SHARD_CHUNK_SAMPLES
        if local in absent_local or start >= SHARD_N_SAMPLES:
            footer_pairs.append((SHARD_ABSENT_MARKER, SHARD_ABSENT_MARKER))
            continue
        data = np.zeros((SHARD_N_CHANNELS, SHARD_CHUNK_SAMPLES), dtype=np.int16)
        for ch in range(SHARD_N_CHANNELS):
            for col in range(SHARD_CHUNK_SAMPLES):
                global_sample = start + col
                if global_sample < SHARD_N_SAMPLES:
                    data[ch, col] = digital_value(ch, global_sample)
                # else: left at fill_value 0, the out-of-extent padding
        encoded = codec.encode(data)
        footer_pairs.append((len(body), len(encoded)))
        body.extend(encoded)

    out = bytearray(body)
    for off, nb in footer_pairs:
        out += struct.pack("<QQ", off, nb)
    out += b"\x00\x00\x00\x00"  # crc32c placeholder -- never verified
    return bytes(out)


def build_expected_values() -> dict:
    """Ground truth for the JS route tests, emitted as DATA so the expected
    physical values have exactly one source of truth.

    The tests used to re-implement `digital_value` in TypeScript and keep the
    two in sync by comment; nothing failed if they drifted, the assertions just
    quietly started checking different, equally plausible numbers. The spot
    checks below are the authority: each carries the channel, the global sample,
    the digital value, and the physical value the reader must produce, covering
    the first sample, a mid-chunk sample, a sample inside the deliberately
    absent mid-array chunk, the last REAL sample of the straddling boundary
    chunk, and a padded column past `n_samples`."""
    absent_shard0_local2 = 2 * SHARD_CHUNK_SAMPLES + 17  # inside [2000, 3000)
    spot_samples = [
        (0, 0),
        (1, 0),
        (3, 1500),
        (0, absent_shard0_local2),
        (2, absent_shard0_local2),
        (0, 4000),
        (3, 5999),
        (0, SHARD_N_SAMPLES - 1),
        (3, SHARD_N_SAMPLES - 1),
        (0, SHARD_N_SAMPLES),
        (1, SHARD_N_SAMPLES + 250),
    ]
    absent_spans = [(2000, 3000), (7000, 8000)]

    def is_filled(global_sample: int) -> bool:
        if global_sample >= SHARD_N_SAMPLES:
            return True
        return any(lo <= global_sample < hi for lo, hi in absent_spans)

    checks = []
    for channel, global_sample in spot_samples:
        filled = is_filled(global_sample)
        digital = 0 if filled else digital_value(channel, global_sample)
        checks.append(
            {
                "channel": channel,
                "global_sample": global_sample,
                "digital": digital,
                "physical": digital * SHARD_SCALE[channel] + SHARD_OFFSET[channel],
                "fill_value_substituted": filled,
                # A sample at or past `n_samples` describes real stored bytes
                # (the boundary chunk's fill padding) but is NOT reachable
                # through `read_window`: the tool's bounds check refuses a
                # window past the array's extent rather than returning padding
                # as if it were signal. Route-level tests must skip these; they
                # exist so the padding itself is pinned as data.
                "addressable_via_read_window": global_sample < SHARD_N_SAMPLES,
            }
        )
    return {
        "note": (
            "Ground truth for backend/test/mcp-read-window.test.ts. Generated by "
            "scripts/zarr/generate_mcp_test_fixture.py; do not hand-edit."
        ),
        "dataset_id": SHARD_DATASET_ID,
        "n_channels": SHARD_N_CHANNELS,
        "n_samples": SHARD_N_SAMPLES,
        "chunk_samples": SHARD_CHUNK_SAMPLES,
        "shard_samples": SHARD_SAMPLES,
        "n_inner_per_shard": SHARD_SAMPLES // SHARD_CHUNK_SAMPLES,
        "fill_value": 0,
        "scale": SHARD_SCALE,
        "offset": SHARD_OFFSET,
        "absent_sample_spans": [{"start": lo, "end": hi} for lo, hi in absent_spans],
        "spot_checks": checks,
    }


def build_sharded_level0_fixture() -> None:
    n_inner = SHARD_SAMPLES // SHARD_CHUNK_SAMPLES
    shard0 = build_shard(0, absent_local={2})
    shard0_path = FIXTURES_DIR / f"{SHARD_DATASET_ID}-shard-0.bin"
    shard0_path.write_bytes(shard0)
    print(f"wrote {shard0_path} ({len(shard0)} bytes, {n_inner} entries, local index 2 absent)")

    # No hand-listed absences: local index 3 ([7000, 8000)) is past n_samples,
    # so build_shard marks it absent on its own, and local index 2 straddles
    # n_samples and is written full size with fill padding.
    shard1 = build_shard(1, absent_local=set())
    shard1_path = FIXTURES_DIR / f"{SHARD_DATASET_ID}-shard-1.bin"
    shard1_path.write_bytes(shard1)
    print(
        f"wrote {shard1_path} ({len(shard1)} bytes, {n_inner} entries, "
        "local index 3 absent as wholly past n_samples, local index 2 full size with fill padding)"
    )

    expected_path = FIXTURES_DIR / f"{SHARD_DATASET_ID}-expected.json"
    expected_path.write_text(json.dumps(build_expected_values(), indent=2) + "\n")
    print(f"wrote {expected_path}")

    level0_zarr_json = {
        "shape": [SHARD_N_CHANNELS, SHARD_N_SAMPLES],
        "data_type": "int16",
        "chunk_grid": {
            "name": "regular",
            "configuration": {"chunk_shape": [SHARD_N_CHANNELS, SHARD_SAMPLES]},
        },
        "chunk_key_encoding": {"name": "default", "configuration": {"separator": "/"}},
        "fill_value": 0,
        "codecs": [
            {
                "name": "sharding_indexed",
                "configuration": {
                    "chunk_shape": [SHARD_N_CHANNELS, SHARD_CHUNK_SAMPLES],
                    "codecs": [
                        {"name": "bytes", "configuration": {"endian": "little"}},
                        {
                            "name": "blosc",
                            "configuration": {
                                "typesize": 2,
                                "cname": "zstd",
                                "clevel": 5,
                                "shuffle": "shuffle",
                                "blocksize": 0,
                            },
                        },
                    ],
                    "index_codecs": [
                        {"name": "bytes", "configuration": {"endian": "little"}},
                        {"name": "crc32c"},
                    ],
                    "index_location": "end",
                },
            }
        ],
        "attributes": {
            "level": 0,
            "rate": 250.0,
            "source_rate_hz": 1000.0,
            "downsample_factor": 1,
            "kind": "signal",
            "chunk_samples": SHARD_CHUNK_SAMPLES,
            "shard_samples": SHARD_SAMPLES,
            "anti_aliased": True,
            "usable_for_inference": True,
            "scale": SHARD_SCALE,
            "offset": SHARD_OFFSET,
            "physical_formula": "physical = digital * scale + offset",
        },
        "zarr_format": 3,
        "node_type": "array",
        "storage_transformers": [],
    }
    zarr_json_path = FIXTURES_DIR / f"{SHARD_DATASET_ID}-level0-zarr.json"
    zarr_json_path.write_text(json.dumps(level0_zarr_json, indent=2) + "\n")
    print(f"wrote {zarr_json_path}")


#: One row past `MAX_EVENTS_PARQUET_ROWS` in
#: `backend/src/mcp/tools/get-events.ts`, so `get_events` must refuse to read it
#: whole. Every column is a repeated constant, so dictionary encoding plus zstd
#: brings 100,001 rows down to about 4.5 KB -- a real over-cap parquet that costs
#: nothing to commit, rather than a 95 MB one like nm000104's.
OVERSIZED_EVENTS_ROWS = 100_001


#: The first three stores of the nm000329 index fixture, in the byte order the
#: producer sorts `store_path` by (`sub-1/` sorts before `sub-10/`: `/` < `0`).
FIXTURE_STORES = (
    "sub-1/ses-0/eeg/sub-1_ses-0_task-imagery_acq-calibration_run-0_eeg.zarr",
    "sub-1/ses-0/eeg/sub-1_ses-0_task-imagery_acq-clean_run-1_eeg.zarr",
    "sub-10/ses-0/eeg/sub-10_ses-0_task-imagery_acq-calibration_run-0_eeg.zarr",
)

#: Row-group layout of row-groups-events.parquet (#1498): 120,000 rows, over the
#: 100,000-row whole-file cap, in three row groups of 40,000. The middle store's
#: 20 rows straddle the first boundary, so reading it takes two row groups.
ROW_GROUP_SIZE = 40_000
STRADDLE_START = 39_990
STRADDLE_ROWS = 20
ROW_GROUPS_TOTAL_ROWS = 120_000


def build_oversized_events_parquet() -> None:
    """A parquet whose ROW COUNT crosses get_events' inline-read budget, every row
    for ONE store the index knows, so even that store's own row group is over it
    (#1498: a file over the cap is read by row group when statistics allow)."""
    import pyarrow as pa
    import pyarrow.parquet as pq

    n = OVERSIZED_EVENTS_ROWS
    table = pa.table(
        {
            "store_path": pa.array([FIXTURE_STORES[0]] * n),
            "group_name": pa.array(["eeg_250hz"] * n),
            "onset_s": pa.array([1.5] * n, type=pa.float64()),
            "duration_s": pa.array([0.5] * n, type=pa.float64()),
            "sample_index": pa.array([375] * n, type=pa.int64()),
            "trial_type": pa.array(["stim"] * n),
        }
    )
    out = FIXTURES_DIR / "oversized-events.parquet"
    pq.write_table(table, out, compression="zstd")
    print(f"wrote {out} ({out.stat().st_size} bytes, {n} rows)")


def _row_groups_table():
    """The 120,000-row table row-groups-events.parquet and no-stats-events.parquet share:
    the first store as filler, the second store's 20 events across the first row-group
    boundary, and the third store as filler after them, sorted by `store_path`."""
    import pyarrow as pa

    first = STRADDLE_START
    middle = STRADDLE_ROWS
    last = ROW_GROUPS_TOTAL_ROWS - first - middle
    # The middle store's events are distinct, so a read that returned another
    # store's rows, or dropped one, is visible: onset k seconds, sample k * 250.
    onsets = [1.5] * first + [float(k) for k in range(1, middle + 1)] + [2.5] * last
    samples = [375] * first + [k * 250 for k in range(1, middle + 1)] + [625] * last
    return pa.table(
        {
            "store_path": pa.array(
                [FIXTURE_STORES[0]] * first
                + [FIXTURE_STORES[1]] * middle
                + [FIXTURE_STORES[2]] * last
            ),
            "group_name": pa.array(["eeg_250hz"] * ROW_GROUPS_TOTAL_ROWS),
            "onset_s": pa.array(onsets, type=pa.float64()),
            "duration_s": pa.array([0.5] * ROW_GROUPS_TOTAL_ROWS, type=pa.float64()),
            "sample_index": pa.array(samples, type=pa.int64()),
            "trial_type": pa.array(
                ["stim"] * first
                + ["face" if k % 2 else "scrambled_face" for k in range(1, middle + 1)]
                + ["stim"] * last
            ),
        }
    )


def build_row_groups_events_parquet() -> None:
    """Over the whole-file row cap, but sorted by `store_path` with statistics, as the
    producer writes it: one store's rows are found by row group (#1498)."""
    import pyarrow.parquet as pq

    out = FIXTURES_DIR / "row-groups-events.parquet"
    pq.write_table(_row_groups_table(), out, compression="zstd", row_group_size=ROW_GROUP_SIZE)
    meta = pq.ParquetFile(out).metadata
    size = out.stat().st_size
    print(f"wrote {out} ({size} bytes, {meta.num_rows} rows, {meta.num_row_groups} row groups)")


def build_no_stats_events_parquet() -> None:
    """The same rows with no column statistics: nothing locates one store's rows, so
    get_events must still decline (#1498)."""
    import pyarrow.parquet as pq

    out = FIXTURES_DIR / "no-stats-events.parquet"
    pq.write_table(
        _row_groups_table(),
        out,
        compression="zstd",
        row_group_size=ROW_GROUP_SIZE,
        write_statistics=False,
    )
    print(f"wrote {out} ({out.stat().st_size} bytes, no statistics)")


def build_two_group_events_parquet() -> None:
    """A parquet with rows for TWO channel groups of ONE store.

    `events.parquet` is one row per (event, channel group), so a store with two
    groups carries every event twice. `get_events` used to return both when no
    `group` was named, reporting `total_count` as the sum while its envelope
    described only the first group -- this fixture is what makes that
    double-counting visible in a test rather than only in prose.
    """
    import pyarrow as pa
    import pyarrow.parquet as pq

    store = "sub-1/ses-0/eeg/sub-1_ses-0_task-imagery_acq-calibration_run-0_eeg.zarr"
    onsets = [1.0, 2.0, 3.0, 4.0]
    rows: dict[str, list] = {
        "store_path": [],
        "group_name": [],
        "onset_s": [],
        "duration_s": [],
        "sample_index": [],
        "trial_type": [],
    }
    for group, rate in (("eeg_250hz", 250), ("eeg_500hz", 500)):
        for onset in onsets:
            rows["store_path"].append(store)
            rows["group_name"].append(group)
            rows["onset_s"].append(onset)
            rows["duration_s"].append(0.5)
            rows["sample_index"].append(int(onset * rate + 0.5))
            rows["trial_type"].append("stim")

    table = pa.table(
        {
            "store_path": pa.array(rows["store_path"]),
            "group_name": pa.array(rows["group_name"]),
            "onset_s": pa.array(rows["onset_s"], type=pa.float64()),
            "duration_s": pa.array(rows["duration_s"], type=pa.float64()),
            "sample_index": pa.array(rows["sample_index"], type=pa.int64()),
            "trial_type": pa.array(rows["trial_type"]),
        }
    )
    out = FIXTURES_DIR / "two-group-events.parquet"
    pq.write_table(table, out, compression="zstd")
    print(f"wrote {out} ({out.stat().st_size} bytes, {len(rows['store_path'])} rows, 2 groups)")


def build_invalid_row_events_parquet() -> None:
    """Three valid rows plus one `eventRowSchema` rejects (negative
    `sample_index`), so the dropped-row count has something real to report.

    The count used to live only in the miss path's return value, so it reached
    the one caller that happened to miss and no one else; every later call for
    the store was a cache hit reporting 0 dropped rows.
    """
    import pyarrow as pa
    import pyarrow.parquet as pq

    store = "sub-1/ses-0/eeg/sub-1_ses-0_task-imagery_acq-calibration_run-0_eeg.zarr"
    table = pa.table(
        {
            "store_path": pa.array([store] * 4),
            "group_name": pa.array(["eeg_250hz"] * 4),
            "onset_s": pa.array([1.0, 2.0, 3.0, 4.0], type=pa.float64()),
            "duration_s": pa.array([0.5] * 4, type=pa.float64()),
            # The last one is invalid: sample_index must be a non-negative int.
            "sample_index": pa.array([250, 500, 750, -5], type=pa.int64()),
            "trial_type": pa.array(["stim"] * 4),
        }
    )
    out = FIXTURES_DIR / "invalid-row-events.parquet"
    pq.write_table(table, out, compression="zstd")
    print(f"wrote {out} ({out.stat().st_size} bytes, 4 rows, 1 invalid)")


def main() -> None:
    FIXTURES_DIR.mkdir(parents=True, exist_ok=True)
    # Byte-shuffle, zstd, one block per chunk (blocksize=0 lets c-blosc pick
    # one block for a buffer this small) -- the same configuration the live
    # view5/view4 zarr.json fixtures already committed for nm000329 report
    # (`"cname": "zstd", "clevel": 5, "shuffle": "shuffle", "blocksize": 0`).
    codec = Blosc(cname="zstd", clevel=5, shuffle=Blosc.SHUFFLE, blocksize=0)

    # Pass the int16 ARRAY, not `.tobytes()`, to every `.encode()` call
    # below: numcodecs infers the blosc2 frame's typesize from the buffer's
    # own itemsize, and a raw bytes object has itemsize 1 -- exactly the
    # "typesize 1" mismatch this decoder deliberately refuses to
    # reinterpret (`shared/zarr/codecs/blosc.ts`'s own int16-only
    # invariant), caught by decoding every fixture back in Bun before
    # trusting it.
    data = build_minmax_envelope()
    encoded = codec.encode(data)
    OUT_PATH.write_bytes(encoded)
    print(f"wrote {OUT_PATH} ({len(encoded)} bytes, decoded shape {data.shape})")

    n_multi_chunks = math.ceil(MULTI_TOTAL_COLUMNS / MULTI_CHUNK_STRIDE)
    for k in range(n_multi_chunks):
        offset = k * MULTI_CHUNK_STRIDE
        valid = min(MULTI_CHUNK_STRIDE, MULTI_TOTAL_COLUMNS - offset)
        chunk_data = build_multichunk_envelope(valid, offset)
        chunk_encoded = codec.encode(chunk_data)
        chunk_path = FIXTURES_DIR / f"nm000329-synthetic-multichunk-view1-c-0-0-{k}.bin"
        chunk_path.write_bytes(chunk_encoded)
        print(
            f"wrote {chunk_path} ({len(chunk_encoded)} bytes, decoded shape "
            f"{chunk_data.shape}, {valid} valid columns)"
        )

    build_oversized_events_parquet()
    build_row_groups_events_parquet()
    build_no_stats_events_parquet()
    build_two_group_events_parquet()
    build_invalid_row_events_parquet()
    build_sharded_level0_fixture()


if __name__ == "__main__":
    main()
