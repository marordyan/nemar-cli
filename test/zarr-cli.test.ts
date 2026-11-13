/**
 * `nemar zarr read` as a real subprocess (the CLI entry, which starts the real engine as a
 * second subprocess) against a `Bun.serve` stand-in on 127.0.0.1 serving the committed
 * nm099500 store. Values are checked against `nm099500-zarr-python-int16.bin`, the whole array
 * as zarr-python read it, and the scale and offset in `nm099500-expected.json`. Every run has
 * an isolated config directory and disk cache, NEMAR_NO_UPDATE_CHECK=1 and NO_COLOR=1.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BIDS,
  ID,
  type Standin,
  expected,
  referenceDigital,
  runNemar,
  startStandin,
} from "./helpers/zarr-engine-standin.js";

setDefaultTimeout(60_000);

const N = expected.n_samples as number;
const SCALE = expected.scale as number[];
const OFFSET = expected.offset as number[];

let standin: Standin;
let tmp: string;
beforeAll(() => {
  standin = startStandin();
});
afterAll(() => standin.stop());
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nemar-zarr-cli-"));
  standin.requests.length = 0;
  standin.ranges.length = 0;
  standin.setUpdatedUtc(null);
  standin.setShardsDown(false);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const env = (extra: Record<string, string> = {}) => ({
  ...standin.env({ config: join(tmp, "config"), cache: join(tmp, "cache") }),
  ...extra,
});
const read = (args: string[], extra: Record<string, string> = {}) =>
  runNemar(["zarr", "read", ...args], env(extra));
const window = (start: number, duration: number, more: string[] = []) => [
  ID,
  BIDS,
  "--start",
  String(start),
  "--duration",
  String(duration),
  ...more,
];

/** The physical values zarr-python's digital array gives for `channels` over samples [a, b). */
function physical(channels: number[], a: number, b: number): Float64Array {
  const out = new Float64Array(channels.length * (b - a));
  channels.forEach((c, i) => {
    for (let s = a; s < b; s++) {
      out[i * (b - a) + (s - a)] = referenceDigital[c * N + s] * SCALE[c] + OFFSET[c];
    }
  });
  return out;
}
const asBytes = (a: Float64Array | Int16Array) =>
  new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

describe("the summary", () => {
  test("names the dataset, recording, representation, rate, channels and samples, and previews values", async () => {
    const r = await read(window(1, 1));
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toContain(`Dataset        ${ID}`);
    expect(r.stdout).toContain(`Recording      ${BIDS}`);
    expect(r.stdout).toContain("eeg_250hz");
    expect(r.stdout).toContain("Sampling rate  250 Hz");
    expect(r.stdout).toContain("Channels       4 of 4 (0, 1, 2, 3)");
    expect(r.stdout).toContain("250 samples");
    expect(r.stdout).toContain("1000 float64 (physical");
    expect(r.stdout).toContain("Filled ranges  none");
    const want = physical([0, 1, 2, 3], 250, 500);
    // Channel 0's first value, formatted the way the summary formats it.
    const first = Number(want[0].toPrecision(6)).toString();
    expect(r.stdout).toMatch(new RegExp(`ch 0\\s+${first.replace(".", "\\.")}\\s`));
    expect(r.stdout).toContain("Add --out <file>");
  });

  test("a window over the absent chunk reports its filled range", async () => {
    // Samples 1750..2250 straddle the absent inner chunk (2000-3000).
    const r = await read(window(7, 2, ["--units", "digital"]));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Filled ranges  [2000, 2250)");
    expect(r.stdout).toContain("int16");
    expect(r.stdout).toContain("the store does not hold; they read as 0.");
  });

  test("the filled-range note says offset for physical units", async () => {
    const r = await read(window(7, 2));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(
      "the store does not hold; they read as each channel's offset, the physical value of a digital 0.",
    );
    expect(r.stdout).not.toContain("they read as 0.");
  });

  test("previews at most four channels", async () => {
    const r = await read(window(1, 1, ["--channels", "3,1"]));
    expect(r.stdout).toContain("Channels       2 of 4 (3, 1)");
    expect(r.stdout).toMatch(/ch 3 /);
    expect(r.stdout).toMatch(/ch 1 /);
    expect(r.stdout).not.toMatch(/ch 0 /);
  });
});

describe("--out", () => {
  test("writes the physical window as float64, channel-major, equal to the zarr-python reference", async () => {
    const out = join(tmp, "w.bin");
    const r = await read(window(1, 1, ["--out", out]));
    expect(r.exitCode).toBe(0);
    expect(new Uint8Array(readFileSync(out))).toEqual(asBytes(physical([0, 1, 2, 3], 250, 500)));
    expect(r.stdout).toContain(`Wrote 8000 bytes to ${out}`);
    expect(r.stdout).toContain(`numpy.fromfile("${out}", "<f8").reshape(4, 250)`);
    expect(r.stdout).toContain("MATLAB");
    // Little-endian on any machine: the permission and the machine format are named.
    expect(r.stdout).toContain(`fopen('${out}', 'r', 'l')`);
    expect(r.stdout).toContain("float64=>float64");
    // No temporary file is left next to it.
    expect(readdirSync(tmp).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });

  test("--units digital writes the stored int16 values, with --channels in the order given", async () => {
    const out = join(tmp, "d.bin");
    const r = await read(window(1, 1, ["--units", "digital", "--channels", "3,1", "--out", out]));
    expect(r.exitCode).toBe(0);
    const want = new Int16Array(2 * 250);
    for (let s = 0; s < 250; s++) {
      want[s] = referenceDigital[3 * N + 250 + s];
      want[250 + s] = referenceDigital[1 * N + 250 + s];
    }
    expect(new Uint8Array(readFileSync(out))).toEqual(asBytes(want));
    expect(r.stdout).toContain('"<i2").reshape(2, 250)');
  });

  test("a window over the absent chunk: reference values before it, fill after, byte for byte", async () => {
    // Samples 1750..2250 straddle shard 0's absent inner chunk [2000, 3000).
    const out = join(tmp, "gap.bin");
    const r = await read(window(7, 2, ["--out", out]));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Filled ranges  [2000, 2250)");
    const want = new Float64Array(4 * 500);
    for (let c = 0; c < 4; c++) {
      for (let s = 0; s < 500; s++) {
        const sample = 1750 + s;
        // Present samples are the zarr-python reference; absent ones are digital 0, which is
        // the channel's offset in physical units.
        want[c * 500 + s] =
          sample < 2000 ? referenceDigital[c * N + sample] * SCALE[c] + OFFSET[c] : OFFSET[c];
      }
    }
    expect(new Uint8Array(readFileSync(out))).toEqual(asBytes(want));
    const digital = join(tmp, "gap-digital.bin");
    expect((await read(window(7, 2, ["--units", "digital", "--out", digital]))).exitCode).toBe(0);
    const wantDigital = new Int16Array(4 * 500);
    for (let c = 0; c < 4; c++) {
      for (let s = 0; s < 250; s++) wantDigital[c * 500 + s] = referenceDigital[c * N + 1750 + s];
    }
    expect(new Uint8Array(readFileSync(digital))).toEqual(asBytes(wantDigital));
  });

  test("creates the parent directory, and a failed read leaves an existing file alone", async () => {
    const out = join(tmp, "nested", "dir", "w.bin");
    expect((await read(window(1, 1, ["--out", out]))).exitCode).toBe(0);
    expect(existsSync(out)).toBe(true);
    const before = readFileSync(out);
    const bad = await read(window(1000, 1, ["--out", out]));
    expect(bad.exitCode).toBe(1);
    expect(readFileSync(out)).toEqual(before);
  });

  test("an unwritable path is exit 1 with a sentence", async () => {
    const file = join(tmp, "a-file");
    writeFileSync(file, "x");
    const r = await read(window(1, 1, ["--out", join(file, "w.bin")]));
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain("Could not write");
    expect(r.stdout + r.stderr).not.toContain("null");
  });
});

describe("--json", () => {
  test("prints the window header, the representation and the out path, and no values", async () => {
    const out = join(tmp, "j.bin");
    const r = await read(window(1, 1, ["--json", "--out", out]));
    expect(r.exitCode).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.dataset_id).toBe(ID);
    expect(doc.recording).toBe(BIDS);
    expect(doc.units).toBe("physical");
    expect(doc.out).toBe(out);
    expect(doc.representation).toMatchObject({
      kind: "zarr",
      id: "eeg_250hz",
      sampling_frequency: 250,
      nchans: 4,
    });
    expect(doc.window).toMatchObject({
      start_sample: 250,
      n_samples: 250,
      channels: [0, 1, 2, 3],
      dtype: "float64",
      layout: "channel-major",
      byte_order: "little",
      filled_ranges: [],
      payload_bytes: 8000,
    });
    expect(doc.window.id).toBeUndefined();
    expect(Object.keys(doc).sort()).toEqual(
      ["dataset_id", "out", "recording", "representation", "units", "window"].sort(),
    );
  });

  test("out is null without --out", async () => {
    const doc = JSON.parse((await read(window(0, 1, ["--json"]))).stdout);
    expect(doc.out).toBeNull();
  });

  test("a failure under --json writes nothing to stdout", async () => {
    const r = await read(window(1000, 1, ["--json"]));
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("outside the recording");
  });
});

describe("errors are exit 1 with a hint", () => {
  test("not_found: a dataset with no Zarr index", async () => {
    const r = await runNemar(
      ["zarr", "read", "nm099999", BIDS, "--start", "0", "--duration", "1"],
      env(),
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain("no Zarr index");
    expect(r.stdout + r.stderr).toContain("Check the dataset id");
    // An answer, not a crash: no bug-report nudge.
    expect(r.stdout + r.stderr).not.toContain("Run again with --debug");
  });

  test("not_found: an unknown recording", async () => {
    const r = await runNemar(
      ["zarr", "read", ID, "sub-x/eeg/none.edf", "--start", "0", "--duration", "1"],
      env(),
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain("is not in dataset");
  });

  test("not_found: an unknown representation names the ones there are", async () => {
    const r = await read(window(0, 1, ["--representation", "nope"]));
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain("eeg_250hz");
  });

  test("not_ready: a legacy index awaits re-conversion", async () => {
    const r = await runNemar(
      ["zarr", "read", "nm000111", BIDS, "--start", "0", "--duration", "1"],
      env(),
    );
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain("re-conversion");
  });

  test("out_of_range: a window past the end, and a channel that is not there", async () => {
    const past = await read(window(1000, 1));
    expect(past.exitCode).toBe(1);
    expect(past.stdout + past.stderr).toContain("outside the recording");
    expect(past.stdout + past.stderr).toContain("Check --start, --duration and --channels");
    const channel = await read(window(0, 1, ["--channels", "9"]));
    expect(channel.exitCode).toBe(1);
    expect(channel.stdout + channel.stderr).toContain("channel 9");
  });

  test("too_large: a window over the engine's payload limit says to shorten it", async () => {
    const r = await read(window(0, 5), { NEMAR_ZARR_MAX_PAYLOAD_BYTES: "1000" });
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain("Shorten --duration");
  });

  test("upstream_error: a host that answers 503 for the data", async () => {
    standin.setShardsDown(true);
    const r = await read(window(0, 1));
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain("data host failed");
  });

  test("a bad engine setting is a configuration error with a hint, before any engine starts", async () => {
    for (const [name, value] of [
      ["NEMAR_ZARR_BASE", "http://example.com"],
      ["NEMAR_ZARR_MAX_PAYLOAD_BYTES", "abc"],
      ["NEMAR_ZARR_RANGE_CACHE_BYTES", "0"],
      ["NEMAR_ZARR_DISK_CACHE_BYTES", "-1"],
    ]) {
      const r = await read(window(0, 1), { [name]: value });
      const all = r.stdout + r.stderr;
      expect(r.exitCode, name).toBe(1);
      expect(all, name).toContain(name);
      expect(all, name).toContain("Fix or unset that environment variable");
      // Not a crash: no engine was started, no engine line, no bug-report nudge.
      expect(all, name).not.toContain("[zarr-engine]");
      expect(all, name).not.toContain("Run again with --debug");
    }
    // (The CLI's own notices call reaches the stand-in too; nothing of the store's did.)
    expect(standin.requests.filter((p) => p.includes("/zarr/") || p.startsWith("/data"))).toEqual(
      [],
    );
  });

  test("under --json a configuration error goes to stderr only", async () => {
    const r = await read(window(0, 1, ["--json"]), { NEMAR_ZARR_BASE: "http://example.com" });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("NEMAR_ZARR_BASE");
  });
});

describe("arguments are checked before an engine starts", () => {
  const run = (args: string[]) => runNemar(["zarr", "read", ...args], env());
  test("a dataset id that is not one", async () => {
    const r = await run(["nm1", BIDS, "--start", "0", "--duration", "1"]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).toContain("is not a dataset id");
  });
  test("--start and --duration are both required", async () => {
    for (const args of [
      [ID, BIDS],
      [ID, BIDS, "--start", "1"],
      [ID, BIDS, "--duration", "1"],
    ]) {
      const r = await run(args);
      expect(r.exitCode).toBe(1);
      expect(r.stdout + r.stderr).toContain(
        "--start <seconds> and --duration <seconds> are required",
      );
    }
  });
  test("numbers, ranges, channels and units", async () => {
    const cases: [string[], string][] = [
      [["--start", "abc", "--duration", "1"], "--start must be a number"],
      [["--start", "0", "--duration", "x"], "--duration must be a number"],
      [["--start", "-1", "--duration", "1"], "--start must be 0 or more"],
      [["--start", "0", "--duration", "0"], "more than 0"],
      [["--start", "0", "--duration", "1", "--channels", "0,0"], "--channels must be distinct"],
      [["--start", "0", "--duration", "1", "--channels", "a,b"], "--channels must be distinct"],
      [["--start", "0", "--duration", "1", "--channels", "-1"], "--channels must be distinct"],
      [
        ["--start", "0", "--duration", "1", "--units", "volts"],
        "--units must be physical or digital",
      ],
    ];
    for (const [args, message] of cases) {
      const r = await run([ID, BIDS, ...args]);
      expect(r.exitCode, args.join(" ")).toBe(1);
      expect(r.stdout + r.stderr, args.join(" ")).toContain(message);
    }
    // None of them reached the host.
    expect(standin.requests.filter((p) => p.endsWith("index.json"))).toEqual([]);
  });
});

describe("the disk cache", () => {
  test("reading the same window again sends no range request, even from a new process", async () => {
    expect((await read(window(1, 1))).exitCode).toBe(0);
    expect(standin.ranges.length).toBeGreaterThan(0);
    standin.ranges.length = 0;
    const r = await read(window(1, 1));
    expect(r.exitCode).toBe(0);
    expect(standin.ranges).toEqual([]);
  });
});

describe("--help", () => {
  test("--help-all shows the examples, the options and the environment", async () => {
    const r = await runNemar(["zarr", "read", "--help-all"], env());
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Examples:");
    expect(r.stdout).toContain("nemar zarr read nm000103");
    expect(r.stdout).toContain("--start <seconds>");
    expect(r.stdout).toContain("--units <units>");
    expect(r.stdout).toContain("--out <file>");
    expect(r.stdout).toContain("channel-major");
    expect(r.stdout).toContain("NEMAR_ZARR_DISK_CACHE_BYTES");
    expect(r.stdout).toContain("mode 0700");
    // The cache saves data requests, not the index and records, which are read at each start.
    expect(r.stdout).toContain("sends no data request");
    expect(r.stdout).not.toContain("sends no request");
  });

  test("nemar --help lists the zarr group", async () => {
    const r = await runNemar(["--help"], env());
    expect(r.stdout).toMatch(/^ {2}zarr /m);
  });
});
