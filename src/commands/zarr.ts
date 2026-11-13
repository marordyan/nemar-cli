/**
 * `nemar zarr read`: read a window of one recording of a public dataset straight from its Zarr
 * store, through the local engine (ADR 0120).
 *
 * The command starts the engine (`nemar __zarr-engine`, see lib/zarr-engine/client.ts), opens the
 * recording and reads one window. The default output is a short summary and the first few
 * values; `--out` writes the whole window to a file as raw little-endian, channel-major values
 * (one row per channel), and `--json` prints the window's header, the representation and the
 * path instead of the summary. Values are never printed as text beyond the summary's preview.
 *
 * Every failure is exit 1 with a sentence and a hint (`failMessage`): an engine error code is a
 * dataset or argument problem the user can act on, so it is an answer, not a crash; a dead or
 * silent engine keeps the "attach the log" hint.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import chalk from "chalk";
import { Command } from "commander";
import {
  type Opened,
  type ZarrRepresentation,
  isZarrRepresentation,
} from "../../shared/contract/zarr-engine-protocol.js";
import { checkedDatasetId, failMessage } from "../lib/admin-command.js";
import { plain } from "../lib/terminal-text.js";
import {
  EngineClient,
  EngineClientError,
  type ReadWindowArgs,
  type WindowReply,
} from "../lib/zarr-engine/client.js";
import { CONFIG_HINT, resolveEngineConfig } from "../lib/zarr-engine/engine-config.js";
import { EngineConfigError } from "../lib/zarr-engine/http.js";

export interface ZarrReadOptions {
  start?: string;
  duration?: string;
  channels?: string;
  units?: string;
  representation?: string;
  out?: string;
  json?: boolean;
}

/** How many channels and how many values of each the summary previews. */
const PREVIEW_CHANNELS = 4;
const PREVIEW_VALUES = 6;

/** A sentence and a hint for each engine error code.
 *  `invalid_message`, `unsupported_version`, `unknown_handle` and `internal` have no entry on
 *  purpose: they mean a bug in this CLI or a version mismatch between it and its own engine,
 *  which changing the arguments cannot fix, so they take the generic hint that points at
 *  `--debug` (see `failEngine`). */
const ERROR_HINTS: Record<string, { hint: string; answered: boolean }> = {
  not_found: {
    hint: "Check the dataset id and the recording path (the BIDS path of the file, like sub-01/eeg/sub-01_task-x_eeg.edf). Only public datasets with a Zarr conversion can be read.",
    answered: true,
  },
  not_ready: {
    hint: "The dataset awaits re-conversion to the current Zarr format. Try again later.",
    answered: true,
  },
  out_of_range: {
    hint: "The window or a channel is outside the recording. Check --start, --duration and --channels against the recording's length and channel count.",
    answered: true,
  },
  too_large: {
    hint: "Shorten --duration or name fewer channels with --channels.",
    answered: true,
  },
  upstream_error: {
    hint: "The data host failed or sent something unexpected. Try again; if it persists, run again with --debug and attach the log to an issue.",
    answered: false,
  },
  decode_error: {
    hint: "The store's bytes could not be decoded. Run again with --debug and attach the log to an issue.",
    answered: false,
  },
  timeout: {
    hint: "The engine did not answer in time. Check your network and try again.",
    answered: false,
  },
};

/** Parse a number option; null (after saying so) when it is not one. */
function numberOption(name: string, raw: string | undefined, json?: boolean): number | null {
  const n = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
  if (!Number.isFinite(n)) {
    failMessage(`${name} must be a number of seconds, got ${JSON.stringify(raw ?? "")}.`, {
      json,
      answered: true,
    });
    return null;
  }
  return n;
}

/** `0,1,5` as channel indices, or null after saying why. */
function parseChannels(raw: string, json?: boolean): number[] | null {
  const parts = raw.split(",").map((p) => p.trim());
  const channels = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : Number.NaN));
  const bad = channels.some((c) => !Number.isSafeInteger(c));
  if (bad || new Set(channels).size !== channels.length) {
    failMessage(
      `--channels must be distinct channel numbers from 0, like 0,1,5; got ${JSON.stringify(raw)}.`,
      { json, answered: true },
    );
    return null;
  }
  return channels;
}

/** The first {@link PREVIEW_VALUES} values of the first {@link PREVIEW_CHANNELS} channels, and
 *  nothing else: only those bytes are decoded, so a window of millions of samples costs the
 *  summary no more than a short one. `rows[i]` belongs to `channels[i]`. */
export function previewRows(window: WindowReply): number[][] {
  const { channels, n_samples: n, dtype } = window.header;
  const view = new DataView(
    window.payload.buffer,
    window.payload.byteOffset,
    window.payload.length,
  );
  const size = dtype === "int16" ? 2 : 8;
  const rows: number[][] = [];
  for (let i = 0; i < Math.min(channels.length, PREVIEW_CHANNELS); i++) {
    const row: number[] = [];
    for (let j = 0; j < Math.min(n, PREVIEW_VALUES); j++) {
      const at = (i * n + j) * size;
      row.push(dtype === "int16" ? view.getInt16(at, true) : view.getFloat64(at, true));
    }
    rows.push(row);
  }
  return rows;
}

function formatValue(v: number, dtype: string): string {
  return dtype === "int16" ? String(v) : Number(v.toPrecision(6)).toString();
}

/** How to load the file `--out` wrote, for this window. */
function loadHint(path: string, window: WindowReply): string[] {
  const { channels, n_samples: n, dtype } = window.header;
  const np = dtype === "int16" ? "<i2" : "<f8";
  const matlab = dtype === "int16" ? "int16" : "float64";
  return [
    `  Python  x = numpy.fromfile(${JSON.stringify(path)}, "${np}").reshape(${channels.length}, ${n})`,
    `  MATLAB  f = fopen('${path.replace(/'/g, "''")}', 'r', 'l'); x = fread(f, [${n} ${channels.length}], '${matlab}=>${matlab}')'; fclose(f);`,
  ];
}

function describeRanges(window: WindowReply): string {
  const ranges = window.header.filled_ranges;
  if (ranges.length === 0) return "none";
  return ranges.map((r) => `[${r.start_sample}, ${r.end_sample})`).join(", ");
}

/** The summary: what was read and the first few values of up to four channels. */
function printSummary(
  opened: Opened,
  rep: ZarrRepresentation | undefined,
  args: { startS: number; durationS: number; units: "physical" | "digital" },
  window: WindowReply,
  out: string | null,
): void {
  const { channels, n_samples: n, dtype } = window.header;
  const line = (label: string, value: string) =>
    console.log(`  ${chalk.bold(label.padEnd(15))}${value}`);
  console.log(chalk.bold("\nZarr window\n"));
  line("Dataset", opened.dataset_id);
  line("Recording", plain(opened.recording));
  line(
    "Representation",
    `${plain(opened.representation)}${rep?.modality ? ` (${plain(rep.modality)})` : ""}`,
  );
  if (rep?.sampling_frequency) line("Sampling rate", `${rep.sampling_frequency} Hz`);
  line(
    "Channels",
    `${channels.length}${rep?.nchans ? ` of ${rep.nchans}` : ""} (${channels.slice(0, 12).join(", ")}${channels.length > 12 ? ", ..." : ""})`,
  );
  line(
    "Window",
    `${args.durationS} s from ${args.startS} s (${n} samples, starting at sample ${window.header.start_sample})`,
  );
  line("Values", `${channels.length * n} ${dtype} (${args.units}, little-endian, channel-major)`);
  line("Filled ranges", describeRanges(window));
  if (window.header.filled_ranges.length > 0) {
    // The payload inside a range is the fill value (0) converted like any other value (ADR 0120).
    const filledAs =
      args.units === "digital"
        ? "they read as 0."
        : "they read as each channel's offset, the physical value of a digital 0.";
    console.log(
      chalk.dim(`                 Filled ranges are samples the store does not hold; ${filledAs}`),
    );
  }
  const rows = previewRows(window);
  console.log(chalk.bold("\nFirst values\n"));
  for (let i = 0; i < Math.min(rows.length, PREVIEW_CHANNELS); i++) {
    const vals = rows[i].map((v) => formatValue(v, dtype));
    console.log(
      `  ch ${String(channels[i]).padEnd(4)}${vals.join("  ")}${n > PREVIEW_VALUES ? "  ..." : ""}`,
    );
  }
  if (channels.length > PREVIEW_CHANNELS) {
    console.log(chalk.dim(`  (${channels.length - PREVIEW_CHANNELS} more channels not shown)`));
  }
  console.log("");
  if (out) {
    console.log(`Wrote ${window.payload.length} bytes to ${out}. To load it:`);
    for (const l of loadHint(out, window)) console.log(l);
  } else {
    console.log(chalk.dim("Add --out <file> to save the window as raw values."));
  }
  console.log("");
}

/** Write `bytes` to `path` through a temporary file and a rename, so a failed run never
 *  leaves a half-written file where a good one may have been. The temporary file has a random
 *  name and is created exclusively (`wx`, which does not follow a symbolic link at that name),
 *  so a link planted next to the output cannot redirect the write. */
export function writeFileAtomic(path: string, bytes: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${randomBytes(8).toString("hex")}`;
  try {
    writeFileSync(tmp, bytes, { mode: 0o644, flag: "wx" });
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

function failEngine(err: EngineClientError, json?: boolean): void {
  const known = ERROR_HINTS[err.code];
  const stderrLine = err.stderr.split("\n").filter(Boolean).at(-1);
  const detail =
    (err.code === "exited" || err.code === "protocol") && stderrLine
      ? `${err.message}: ${stderrLine}`
      : err.message;
  failMessage(plain(detail), {
    json,
    answered: known?.answered ?? false,
    hint:
      known?.hint ??
      (err.code === "exited" || err.code === "protocol"
        ? "The local Zarr engine failed. Run `nemar engine status` to check it, or run again with --debug and attach the log to an issue."
        : "Run again with --debug and attach the log to an issue."),
  });
}

/** What a failure that is neither an engine answer nor a write error is reported as. */
export function failUnexpected(err: unknown, json?: boolean): void {
  failMessage(`Unexpected error: ${plain(err instanceof Error ? err.message : String(err))}`, {
    json,
    answered: false,
    hint: "Run again with --debug and attach the log to an issue.",
  });
}

export async function zarrReadAction(
  datasetArg: string,
  recording: string,
  options: ZarrReadOptions,
): Promise<void> {
  const json = options.json === true;
  const datasetId = checkedDatasetId(datasetArg, json);
  if (!datasetId) return;
  if (options.start === undefined || options.duration === undefined) {
    failMessage("Both --start <seconds> and --duration <seconds> are required.", {
      json,
      answered: true,
    });
    return;
  }
  const startS = numberOption("--start", options.start, json);
  const durationS = numberOption("--duration", options.duration, json);
  if (startS === null || durationS === null) return;
  if (startS < 0 || durationS <= 0) {
    failMessage("--start must be 0 or more and --duration more than 0.", { json, answered: true });
    return;
  }
  const units = options.units ?? "physical";
  if (units !== "physical" && units !== "digital") {
    failMessage(`--units must be physical or digital, got ${JSON.stringify(units)}.`, {
      json,
      answered: true,
    });
    return;
  }
  let channels: number[] | undefined;
  if (options.channels !== undefined) {
    const parsed = parseChannels(options.channels, json);
    if (!parsed) return;
    channels = parsed;
  }
  const out = options.out === undefined ? null : resolve(options.out);

  // A bad setting is a configuration error to fix, not an engine that crashed: check them all
  // before starting one (the engine checks the same ones, with the same messages).
  try {
    resolveEngineConfig();
  } catch (err) {
    if (err instanceof EngineConfigError) {
      failMessage(plain(err.message), { json, answered: true, hint: CONFIG_HINT });
    } else {
      // Anything else (an unreadable config file, say) is not the user's setting to fix.
      failUnexpected(err, json);
    }
    return;
  }

  const client = EngineClient.start();
  try {
    await client.hello();
    const opened = await client.open({
      datasetId,
      recording,
      representation: options.representation,
    });
    const request: ReadWindowArgs = { handle: opened.handle, startS, durationS, channels, units };
    const window = await client.readWindow(request);
    await client.release(opened.handle).catch(() => undefined);
    if (out) {
      try {
        writeFileAtomic(out, window.payload);
      } catch (err) {
        failMessage(`Could not write ${out}: ${plain((err as Error).message)}`, {
          json,
          answered: false,
        });
        return;
      }
    }

    const rep = opened.representations.find(
      (r): r is ZarrRepresentation => isZarrRepresentation(r) && r.id === opened.representation,
    );
    if (json) {
      const { id: _id, type: _type, ...header } = window.header as Record<string, unknown>;
      console.log(
        JSON.stringify(
          {
            dataset_id: opened.dataset_id,
            recording: opened.recording,
            representation: rep ?? { id: opened.representation },
            units,
            window: header,
            out,
          },
          null,
          2,
        ),
      );
    } else {
      printSummary(opened, rep, { startS, durationS, units }, window, out);
    }
  } catch (err) {
    if (err instanceof EngineClientError) failEngine(err, json);
    else failUnexpected(err, json);
  } finally {
    await client.close();
  }
}

const READ_HELP = `
Reads one window of a recording of a public dataset from its Zarr store, through the local
Zarr engine. Nothing is downloaded but the chunks the window needs, and they are cached on
disk, so reading the same window again sends no data request (the dataset's index and records
are read again each time the engine starts, which is how a re-conversion is noticed).

The dataset must be public and have a Zarr conversion. The recording is its BIDS path (or the
store's zarr path). Channels are numbered from 0, in the order of the recording.

Values are physical units (digital values times the channel's scale, plus its offset) as
float64 by default, or the stored int16 with --units digital. With --out the file holds the
raw values, little-endian, one row per channel (channel-major); the summary then says how to
load it.

Examples:
  $ nemar zarr read nm000103 sub-01/eeg/sub-01_task-rest_eeg.edf --start 10 --duration 2
  $ nemar zarr read nm000103 sub-01/eeg/sub-01_task-rest_eeg.edf --start 0 --duration 5 --channels 0,1,5
  $ nemar zarr read nm000103 sub-01/eeg/sub-01_task-rest_eeg.edf --start 10 --duration 2 --out window.bin
  $ nemar zarr read nm000103 sub-01/eeg/sub-01_task-rest_eeg.edf --start 10 --duration 2 --units digital --json

Environment:
  NEMAR_ZARR_BASE               Zarr host (default: the one for your account's API host)
  NEMAR_ZARR_DATA_PLANE         Data plane's /data mount (default: your API host's origin plus /data)
  NEMAR_ZARR_MAX_PAYLOAD_BYTES  Largest window the engine returns, in bytes (default 256 MiB, at most 1 GiB)
  NEMAR_ZARR_RANGE_CACHE_BYTES  In-memory range cache limit in bytes (default 256 MiB)
  NEMAR_ZARR_DISK_CACHE_BYTES   Disk cache limit in bytes (default 2 GiB, 0 turns it off)
  NEMAR_ZARR_DISK_CACHE_DIR     Disk cache directory; it is made private (mode 0700)
  The two hosts must be https (or http to 127.0.0.1 or [::1]); the payload and range-cache limits are positive integers.
  See \`nemar engine status\` for what is in use and \`nemar engine cache clear\` to empty the cache.`;

export const zarrCommand = new Command("zarr").description(
  "Read recordings of public datasets from their Zarr stores",
);

zarrCommand
  .command("read")
  .description("Read a time window of a recording")
  .argument("<dataset>", "Dataset id (like nm000103)")
  .argument("<recording>", "The recording's BIDS path (or its zarr path)")
  .option("--start <seconds>", "Start of the window, in seconds from the recording's start")
  .option("--duration <seconds>", "Length of the window, in seconds")
  .option("--channels <list>", "Channel numbers to read, from 0, like 0,1,5 (default: all)")
  .option("--units <units>", "physical (default) or digital (the stored int16)")
  .option("--representation <id>", "The Zarr group to read (default: the first)")
  .option(
    "--out <file>",
    "Write the window to this file as raw little-endian, channel-major values",
  )
  .option("--json", "Print the window's description as JSON instead of a summary")
  .addHelpText("after", READ_HELP)
  .action(zarrReadAction);
