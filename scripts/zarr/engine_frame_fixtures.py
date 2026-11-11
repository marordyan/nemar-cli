# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""Write the golden frames for the Zarr engine protocol (v0).

Run: ``uv run scripts/zarr/engine_frame_fixtures.py``

This is an INDEPENDENT second implementation of the framing in
``shared/zarr/protocol-frame.ts``, written from the frame table in ADR 0120 and
not ported from the TypeScript. ``test/zarr-engine-frame.test.ts`` decodes every
file written here with the TypeScript codec and re-encodes the same header and
payload, requiring the bytes to be identical. Two languages agreeing on bytes is
the point; if they disagree, one of them has the format wrong.

Frame layout (all integers little-endian):

    offset 0            4 bytes   magic b"NZE0"
    offset 4            4 bytes   header_len, u32
    offset 8            header_len bytes of UTF-8 JSON object, right-padded
                        with 0x20 so that 8 + header_len is a multiple of 8
    offset 8+header_len header["payload_bytes"] bytes of payload (absent = 0)

The header JSON is compact (separators "," and ":"), ASCII only, with keys in
the order the dicts below spell them. The padding keeps a float64 payload
8-byte aligned.

Standard library only. Output is deterministic: running it twice leaves
``git status`` clean.
"""

import json
import struct
from pathlib import Path

MAGIC = b"NZE0"
ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "test" / "fixtures" / "engine-frames"
# A real neuroschema record, as NEMAR publishes it (records.json of nm000103),
# so the opened frame carries nested JSON exactly as the engine will pass it on.
RECORD = json.loads(
    (ROOT / "test" / "fixtures" / "neuroschema-records" / "nm000103-sample.json").read_text(
        encoding="utf-8"
    )
)[0]


def frame(header: dict, payload: bytes = b"") -> bytes:
    body = json.dumps(header, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode("ascii")
    pad = (-(8 + len(body))) % 8
    body += b" " * pad
    assert (8 + len(body)) % 8 == 0
    assert header.get("payload_bytes", 0) == len(payload)
    return MAGIC + struct.pack("<I", len(body)) + body + payload


def pack_f64(channels: list[list[float]]) -> bytes:
    return b"".join(struct.pack(f"<{len(ch)}d", *ch) for ch in channels)


def pack_i16(channels: list[list[int]]) -> bytes:
    return b"".join(struct.pack(f"<{len(ch)}h", *ch) for ch in channels)


# Exactly representable in float64 and round-tripped by JSON: negative, a
# non-integer, and a tiny exponent.
F64_VALUES = [[-1.5, 0.1, 1e-7], [2.0, -0.25, 3.5]]
# The filled range covers samples 102..104, so both channels carry placeholder
# zeros there: missing data is reported in filled_ranges, never as real zeros.
I16_VALUES = [[-32768, 32767, 0, 0], [-1, 1234, 0, 0]]

FIXTURES = [
    (
        "hello-request.bin",
        {"id": 1, "type": "hello", "protocol": "0.1", "client": "nemar-py/0.1"},
        None,
    ),
    (
        "opened.bin",
        {
            "id": 2,
            "type": "opened",
            "handle": "h1",
            "dataset_id": "nm000103",
            "recording": RECORD["bids_relpath"],
            "representation": "eeg_250hz",
            "record": RECORD,
            "representations": [
                {
                    "kind": "zarr",
                    "id": "eeg_250hz",
                    "store": RECORD["bids_relpath"].removesuffix(".set") + ".zarr",
                    "modality": "EEG",
                    # Whole numbers stay ints: Python would print 250.0 where
                    # JavaScript prints 250, and the bytes must match.
                    "sampling_frequency": 250,
                    "source_sampling_frequency": 500,
                    "nchans": 2,
                    "ntimes": 43034,
                    "recording_duration": 172.136,
                    "scale": [0.5, 0.25],
                    "offset": [0, -1.5],
                }
            ],
        },
        None,
    ),
    (
        "window-float64.bin",
        {
            "id": 3,
            "type": "window",
            "start_sample": 500,
            "n_samples": 3,
            "channels": [0, 1],
            "dtype": "float64",
            "layout": "channel-major",
            "byte_order": "little",
            "filled_ranges": [],
            "payload_bytes": 48,
        },
        ("float64", F64_VALUES),
    ),
    (
        "window-int16-filled.bin",
        {
            "id": 4,
            "type": "window",
            "start_sample": 100,
            "n_samples": 4,
            "channels": [0, 1],
            "dtype": "int16",
            "layout": "channel-major",
            "byte_order": "little",
            "filled_ranges": [{"start_sample": 102, "end_sample": 104}],
            "payload_bytes": 16,
        },
        ("int16", I16_VALUES),
    ),
    (
        "error.bin",
        {
            "id": 7,
            "type": "error",
            "code": "unknown_handle",
            "message": "no such handle: h9",
        },
        None,
    ),
    (
        "error-null-id.bin",
        {
            "id": None,
            "type": "error",
            "code": "invalid_message",
            "message": "header is not valid JSON",
        },
        None,
    ),
]


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    expected = []
    for name, header, payload in FIXTURES:
        data = b""
        if payload is not None:
            dtype, values = payload
            data = pack_f64(values) if dtype == "float64" else pack_i16(values)
        (OUT / name).write_bytes(frame(header, data))
        expected.append(
            {
                "file": name,
                "header": header,
                "payload": None if payload is None else {"dtype": payload[0], "values": payload[1]},
            }
        )
    text = json.dumps(expected, indent=2, ensure_ascii=True) + "\n"
    (OUT / "expected.json").write_text(text, encoding="ascii")


if __name__ == "__main__":
    main()
