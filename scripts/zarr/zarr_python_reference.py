# /// script
# requires-python = ">=3.11"
# dependencies = ["zarr==3.1.6", "numpy==2.3.5"]
# ///
"""Read the committed nm099500 level-0 fixture with zarr-python, an
independent Zarr v3 reader, and write the whole array as the reference the
TypeScript core is checked against (gate G2, `backend/test/zarr-core-read.test.ts`).

    uv run scripts/zarr/zarr_python_reference.py

The fixture (`backend/test/fixtures/mcp/nm099500-*`) was written by hand with
numcodecs, not by zarr-python, so agreement here is evidence the core reads the
Zarr v3 format and not just our own writer. The script copies the fixture's
`zarr.json` and its two shard objects (`c/0/0`, `c/0/1`) into a temp store,
patches each shard's trailing index checksum in the TEMP COPY (the committed
fixture carries a placeholder of zeros, written by the generator's line 238;
zarr-python verifies the crc32c and the TS core never does), opens the store
with `zarr.open_array`, reads the full `[4, 6500]` int16 array, and writes:

  nm099500-zarr-python-int16.bin   little-endian int16, channel-major (52,000 bytes)
  nm099500-zarr-python-int16.json  zarr and numpy versions, shape, dtype

The versions in the metadata come from the running interpreter, not from the
pins above, so the .json records what actually produced the bytes. The
fixture files are only read, never modified.
"""

import json
import struct
import shutil
import tempfile
from pathlib import Path

import numpy as np
import zarr

REPO = Path(__file__).resolve().parents[2]
FIXTURES = REPO / "backend" / "test" / "fixtures" / "mcp"
OUT_BIN = FIXTURES / "nm099500-zarr-python-int16.bin"
OUT_JSON = FIXTURES / "nm099500-zarr-python-int16.json"


# Index checksums the patch must produce (hex of the 4 bytes written), so a
# change in the fixture or in the crc routine fails loudly.
EXPECTED_CRC_HEX = {"0": "937686d0", "1": "ee8d0792"}


def crc32c(data: bytes) -> int:
    """CRC-32C (Castagnoli): reflected polynomial 0x82F63B78, init and final
    xor 0xFFFFFFFF -- the checksum the Zarr v3 `crc32c` codec uses."""
    crc = 0xFFFFFFFF
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = (crc >> 1) ^ (0x82F63B78 if crc & 1 else 0)
    return crc ^ 0xFFFFFFFF


def patch_index_checksum(path: Path, n_inner: int) -> str:
    """Overwrite the last 4 bytes of the shard at `path` with the real crc32c of
    the index bytes before them (16 bytes per inner chunk, little-endian)."""
    raw = bytearray(path.read_bytes())
    index_bytes = bytes(raw[-(16 * n_inner + 4) : -4])
    raw[-4:] = struct.pack("<I", crc32c(index_bytes))
    path.write_bytes(bytes(raw))
    return bytes(raw[-4:]).hex()


def main() -> None:
    n_inner = json.loads((FIXTURES / "nm099500-expected.json").read_text())[
        "n_inner_per_shard"
    ]
    with tempfile.TemporaryDirectory() as tmp:
        store_dir = Path(tmp) / "store"
        array_dir = store_dir / "level0"
        (array_dir / "c" / "0").mkdir(parents=True)
        (store_dir / "zarr.json").write_text(
            json.dumps({"zarr_format": 3, "node_type": "group", "attributes": {}})
        )
        shutil.copy(FIXTURES / "nm099500-level0-zarr.json", array_dir / "zarr.json")
        shutil.copy(FIXTURES / "nm099500-shard-0.bin", array_dir / "c" / "0" / "0")
        shutil.copy(FIXTURES / "nm099500-shard-1.bin", array_dir / "c" / "0" / "1")
        for shard, expected in EXPECTED_CRC_HEX.items():
            got = patch_index_checksum(array_dir / "c" / "0" / shard, n_inner)
            assert got == expected, f"shard {shard}: crc32c {got}, expected {expected}"

        arr = zarr.open_array(store=str(array_dir), mode="r")
        data = np.asarray(arr[:, :])

    assert data.dtype == np.int16, data.dtype
    assert data.shape == (4, 6500), data.shape
    OUT_BIN.write_bytes(np.ascontiguousarray(data).astype("<i2").tobytes())
    OUT_JSON.write_text(
        json.dumps(
            {
                "zarr_version": zarr.__version__,
                "numpy_version": np.__version__,
                "shape": list(data.shape),
                "dtype": "<i2",
                "layout": "channel-major",
                "source": "nm099500-level0-zarr.json + nm099500-shard-0.bin + nm099500-shard-1.bin",
                "note": "The committed fixture carries a placeholder checksum (generator line 238) in each shard's index; scripts/zarr/zarr_python_reference.py patches it in a temp copy because zarr-python verifies it and the TS core does not.",
            },
            indent=2,
        )
        + "\n"
    )
    print(f"zarr {zarr.__version__}, numpy {np.__version__}: wrote {OUT_BIN} ({data.nbytes} bytes)")


if __name__ == "__main__":
    main()
