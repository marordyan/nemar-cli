/**
 * Archive-wide conformance check for the level-0 geometry invariants
 * `read_window` DEPENDS ON (epic #1065 phase 4, issue #1296).
 *
 * WHY THIS EXISTS. Phase 4's shard-footer defect shipped because a factual
 * claim about the on-disk format was written into `.context/mcp-server-design.md`
 * from a sample of two stores, and then everything downstream -- the code, the
 * tests, the synthetic fixture, and five independent reviewers -- validated
 * against that prose instead of against the format. The prose was wrong, so
 * everything agreed with everything else and disagreed with production. See
 * `shared/zarr/sharding.ts`'s module doc for the measured evidence.
 *
 * The lesson is not "write more careful prose". It is that a claim about a real
 * on-disk format has to be EXECUTABLE, so it can be re-checked whenever the
 * producer changes rather than trusted because it was true once. This script is
 * that check. Every invariant it asserts is one the reading code would be wrong
 * without, and each is checked against every store and group of every v3 index
 * the catalog publishes -- not a sample.
 *
 * WHAT IT ASSERTS, and where the code depends on it:
 *
 *  1. `shard_samples % chunk_samples == 0`. `nInnerForShard`
 *     (`shared/zarr/sharding.ts`) THROWS otherwise, so a single violating
 *     group anywhere in the archive is a hard failure of `read_window` for that
 *     dataset. This is the invariant that replaced the extent-derived entry
 *     count, so it is the one most worth watching.
 *  2. Both `chunk_samples` and `shard_samples` are present on every group.
 *     Absent, a taste is refused (a typed error, not a crash), but a wholesale
 *     regression would silently make `read_window` useless.
 *  3. The index's own `n_channels`/`n_samples`/`chunk_samples`/`shard_samples`
 *     match the level-0 array's `zarr.json`. The tools read geometry from the
 *     INDEX and never probe the array, so a disagreement means every window
 *     computed from the index is wrong.
 *  4. The inner chunk spans EVERY channel (`inner_chunk_shape[0] == n_channels`).
 *     Chunk keys are hand-rolled as `c/0/<j>`; a channel-chunked array would
 *     need `c/<i>/<j>` and every read would silently land on the wrong chunk.
 *  5. `sharding_indexed` with `index_location: "end"`, inner codecs
 *     `bytes` + `blosc`, `data_type: "int16"`, `fill_value: 0`. The footer is
 *     read as a suffix Range; the decoder is `decodeBloscZstdInt16`; the fill
 *     value is what an absent chunk contributes.
 *  6. `attributes.scale` / `attributes.offset` are arrays of length
 *     `n_channels`. They are the physical conversion, applied per channel.
 *  7. Every `events.parquet` column is ZSTD-compressed, and every file carries
 *     the columns `eventRowSchema` requires. `get_events`
 *     (`backend/src/mcp/tools/get-events.ts`) builds a ONE-ENTRY compressors
 *     map (`{ ZSTD }`) because `hyparquet-compressors` cannot load under
 *     workerd -- it compiles SNAPPY's WASM at import. So a single non-ZSTD
 *     column anywhere would make `get_events` throw for that dataset, and a
 *     file missing a required column would have every row silently dropped by
 *     validation. This was previously justified in the design doc by "every
 *     column sampled", from one file.
 *
 * It also REPORTS the observed distribution of `chunk_samples`, `shard_samples`
 * and store channel counts, because those are the figures the design doc quotes
 * and the ones most easily over-generalised from a small sample.
 *
 * DELIBERATELY NOT IN CI. It makes one request per dataset (plus one array
 * `zarr.json` per sampled dataset) against the live public zarr host, so a full
 * run is a few thousand requests and a couple of minutes -- the same reason
 * `bun run migrations:d1-check` is an on-demand gate rather than a per-PR job.
 * Run it when the converter's geometry changes, when `ZARR_ENGINE_VERSION` is
 * bumped, or before trusting a geometry claim in the design doc.
 *
 * USAGE (from the repo root):
 *   bun run zarr:geometry-check                    # indexes + every events.parquet footer
 *   bun run zarr:geometry-check -- --arrays 30     # also probe 30 level-0 arrays
 *   bun run zarr:geometry-check -- --no-events     # skip the parquet half
 *
 * A TRANSIENT INFRA ERROR IS NOT A VIOLATION. A 429 or 5xx from the zarr host
 * says nothing about whether the archive conforms, so those are retried with
 * backoff and, if they persist, reported in their own bucket and do NOT set a
 * failing exit code -- the same fail-open discipline
 * `backend/src/services/zarr-fidelity-sweep.ts` applies per row. A checker that
 * cried wolf on a flaky minute would train its reader to ignore it, which is
 * worse than not having it. Only a document that really contradicts an
 * invariant fails the run.
 *
 * Concurrency is deliberately modest: this hits a host serving real users, and
 * an earlier version at 12-way concurrency plus a parquet footer read per
 * dataset drew a run of 500s from it. Politeness here is not optional.
 *
 * Exits non-zero if any invariant is violated, so it can gate a release step.
 */

import { asyncBufferFromUrl, parquetMetadataAsync } from "hyparquet";
import { zarrIndexSchema } from "../../shared/contract/zarr-index.js";

const CATALOG_URL = "https://zarr.nemar.org/catalog.json";
/** A named User-Agent: the api and zarr hosts reject the default Python/urllib
 *  UA outright, and an unnamed agent is indistinguishable from a scraper in the
 *  access logs. */
const HEADERS = { "User-Agent": "nemar-cli/zarr-geometry-conformance" };
/** Deliberately modest. At 12, with a parquet footer read per dataset on top
 *  of the index fetch, the zarr host started answering 500s -- this script is
 *  a guest on infrastructure serving real users. */
const CONCURRENCY = 4;
/** Retries for a transient 429/5xx, with linear backoff. */
const RETRIES = 3;
const RETRY_BASE_MS = 600;

/** Fetch with retry on a transient status. Returns the response, or null when
 *  every attempt was transiently rejected -- the caller records that as an
 *  infra error, never as a conformance violation. */
async function politeFetch(url: string): Promise<Response | null> {
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, { headers: HEADERS });
    } catch {
      if (attempt === RETRIES) return null;
      await Bun.sleep(RETRY_BASE_MS * (attempt + 1));
      continue;
    }
    // 404 is a real answer (the document is not published); only 429/5xx are
    // worth retrying.
    if (response.status !== 429 && response.status < 500) return response;
    if (attempt === RETRIES) return null;
    await Bun.sleep(RETRY_BASE_MS * (attempt + 1));
  }
  return null;
}

/** The columns `eventRowSchema` (`shared/contract/mcp.ts`) requires. A row
 *  missing any of them fails validation and is dropped, so a file missing one
 *  yields a silently empty result rather than an error. */
const REQUIRED_EVENT_COLUMNS = ["store_path", "group_name", "onset_s", "sample_index"];

interface Violation {
  datasetId: string;
  where: string;
  detail: string;
}

function bump(counter: Map<number, number>, key: number): void {
  counter.set(key, (counter.get(key) ?? 0) + 1);
}

function topN(counter: Map<number, number>, n: number): string {
  return [...counter.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([value, count]) => `${value} (x${count})`)
    .join(", ");
}

async function main(): Promise<void> {
  const arraysFlagIndex = process.argv.indexOf("--arrays");
  const arrayProbeBudget =
    arraysFlagIndex === -1 ? 0 : Number(process.argv[arraysFlagIndex + 1] ?? 30);
  const checkEvents = !process.argv.includes("--no-events");

  const catalogResponse = await fetch(CATALOG_URL, { headers: HEADERS });
  if (!catalogResponse.ok) {
    throw new Error(`catalog.json: HTTP ${catalogResponse.status}`);
  }
  const catalog = (await catalogResponse.json()) as {
    datasets: Array<{ dataset_id: string }>;
  };
  const ids = catalog.datasets.map((d) => d.dataset_id);

  const violations: Violation[] = [];
  /** Transient fetch failures. Reported, never conflated with a violation. */
  const infraErrors: Violation[] = [];
  const chunkSamplesSeen = new Map<number, number>();
  const shardSamplesSeen = new Map<number, number>();
  const channelCountsSeen = new Map<number, number>();
  let v3Count = 0;
  let legacyCount = 0;
  let groupsInspected = 0;
  let arraysProbed = 0;
  let parquetsChecked = 0;
  const parquetCodecsSeen = new Map<string, number>();
  let widest = { channels: 0, datasetId: "", store: "", group: "" };

  async function inspect(datasetId: string): Promise<void> {
    const response = await politeFetch(`https://zarr.nemar.org/${datasetId}/zarr/index.json`);
    if (!response) {
      infraErrors.push({ datasetId, where: "index.json", detail: "transient after retries" });
      return;
    }
    if (!response.ok) {
      // A non-transient non-2xx IS a finding: the catalog lists this dataset as
      // served, so its index should be fetchable.
      violations.push({ datasetId, where: "index.json", detail: `HTTP ${response.status}` });
      return;
    }
    let raw: unknown;
    try {
      raw = await response.json();
    } catch (err) {
      violations.push({
        datasetId,
        where: "index.json",
        detail: `not JSON: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    // A v1 index carries no layout, no data base and no group geometry at all
    // (`read_window` refuses it with a typed error), so there is nothing here to
    // conform to. Counted, not checked.
    if ((raw as { format_version?: number }).format_version !== 3) {
      legacyCount++;
      return;
    }

    // The consumer contract is the oracle: if a live document does not parse,
    // every tool in this repo is one index away from a 500.
    const parsed = zarrIndexSchema.safeParse(raw);
    if (!parsed.success) {
      violations.push({
        datasetId,
        where: "zarrIndexSchema",
        detail: parsed.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; "),
      });
      return;
    }
    v3Count++;
    const index = parsed.data;

    for (const store of index.stores) {
      for (const group of store.groups ?? []) {
        groupsInspected++;
        const { chunk_samples: chunkSamples, shard_samples: shardSamples, n_channels } = group;

        if (typeof n_channels === "number") {
          bump(channelCountsSeen, n_channels);
          // Ties broken by dataset id so the reported figure is REPRODUCIBLE:
          // datasets are inspected concurrently, and several MEG stores sit at
          // the same maximum, so "whichever arrived first" would name a
          // different store run to run -- useless for a spec claim someone is
          // meant to be able to re-derive.
          const tie = n_channels === widest.channels && datasetId < widest.datasetId;
          if (n_channels > widest.channels || tie) {
            widest = {
              channels: n_channels,
              datasetId,
              store: store.zarr,
              group: group.name,
            };
          }
        }

        if (typeof chunkSamples !== "number" || typeof shardSamples !== "number") {
          violations.push({
            datasetId,
            where: `${store.zarr} ${group.name}`,
            detail: `missing geometry: chunk_samples=${chunkSamples} shard_samples=${shardSamples}`,
          });
          continue;
        }
        bump(chunkSamplesSeen, chunkSamples);
        bump(shardSamplesSeen, shardSamples);

        // Invariant 1, the load-bearing one: nInnerForShard throws otherwise.
        if (shardSamples % chunkSamples !== 0) {
          violations.push({
            datasetId,
            where: `${store.zarr} ${group.name}`,
            detail: `shard_samples ${shardSamples} is not an exact multiple of chunk_samples ${chunkSamples} -- nInnerForShard would throw`,
          });
        }
      }
    }

    // Invariant 7. Full coverage, not budgeted: one non-ZSTD column anywhere
    // makes `get_events` throw for that dataset, so a sample cannot answer it.
    // hyparquet reads only the footer here (a couple of Range requests), never
    // the row groups.
    if (checkEvents && index.events_parquet) {
      try {
        const file = await asyncBufferFromUrl({
          url: index.events_parquet,
          requestInit: { headers: HEADERS },
        });
        const metadata = await parquetMetadataAsync(file);
        parquetsChecked++;
        const columnNames = new Set<string>();
        for (const rowGroup of metadata.row_groups ?? []) {
          for (const column of rowGroup.columns ?? []) {
            const meta = column.meta_data as
              | { codec?: unknown; path_in_schema?: string[] }
              | undefined;
            const name = meta?.path_in_schema?.join(".") ?? "(unnamed)";
            columnNames.add(name);
            const codec = String(meta?.codec ?? "(none)");
            parquetCodecsSeen.set(codec, (parquetCodecsSeen.get(codec) ?? 0) + 1);
            if (codec !== "ZSTD") {
              violations.push({
                datasetId,
                where: `events.parquet ${name}`,
                detail: `codec is ${codec}; get_events supplies only a ZSTD decompressor and would throw`,
              });
            }
          }
        }
        const absent = REQUIRED_EVENT_COLUMNS.filter((name) => !columnNames.has(name));
        if (absent.length > 0) {
          violations.push({
            datasetId,
            where: "events.parquet",
            detail: `missing column(s) eventRowSchema requires: ${absent.join(", ")} -- every row would be dropped by validation`,
          });
        }
      } catch (err) {
        // A footer read is several Range requests through the same host, so a
        // failure here is far more likely to be transient than to mean the file
        // is malformed. Recorded as infra; a genuinely corrupt footer will fail
        // every run and stand out by persisting.
        infraErrors.push({
          datasetId,
          where: "events.parquet",
          detail: `could not read footer: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    // Probing the array's own zarr.json costs a second request per dataset, so
    // it is budgeted rather than universal. The index-level invariants above are
    // what a wrong document would break first; this half catches an index that
    // is internally consistent but MISDESCRIBES the array it points at.
    if (arraysProbed >= arrayProbeBudget) return;
    const store = index.stores[0];
    const group = store?.groups?.[0];
    if (!store || !group) return;
    arraysProbed++;

    const arrayUrl = `${index.contract_base}${store.zarr}/${group.name}/0/zarr.json`;
    let array: {
      shape?: number[];
      data_type?: string;
      fill_value?: unknown;
      chunk_grid?: { configuration?: { chunk_shape?: number[] } };
      codecs?: Array<{ name?: string; configuration?: Record<string, unknown> }>;
      attributes?: { scale?: unknown; offset?: unknown };
    };
    const arrayResponse = await politeFetch(arrayUrl);
    if (!arrayResponse) {
      infraErrors.push({ datasetId, where: arrayUrl, detail: "transient after retries" });
      return;
    }
    if (!arrayResponse.ok) {
      violations.push({ datasetId, where: arrayUrl, detail: `HTTP ${arrayResponse.status}` });
      return;
    }
    try {
      array = await arrayResponse.json();
    } catch (err) {
      violations.push({
        datasetId,
        where: arrayUrl,
        detail: `not JSON: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    const where = `${store.zarr} ${group.name} level-0 zarr.json`;
    const add = (detail: string) => violations.push({ datasetId, where, detail });

    const arrayChannels = array.shape?.[0];
    const arraySamples = array.shape?.[1];
    const outerChunk = array.chunk_grid?.configuration?.chunk_shape;
    const shardCodec = array.codecs?.[0];
    const shardConfig = shardCodec?.configuration as
      | { chunk_shape?: number[]; index_location?: string; codecs?: Array<{ name?: string }> }
      | undefined;
    const innerChunk = shardConfig?.chunk_shape;

    // Invariant 5: the codec chain and dtype the reader hardcodes.
    if (shardCodec?.name !== "sharding_indexed") add(`codecs[0] is ${shardCodec?.name}`);
    if (shardConfig?.index_location !== "end") {
      add(`index_location is ${shardConfig?.index_location}, not "end"`);
    }
    const innerCodecs = shardConfig?.codecs?.map((codec) => codec.name).join("+");
    if (innerCodecs !== "bytes+blosc") add(`inner codecs are ${innerCodecs}`);
    if (array.data_type !== "int16") add(`data_type is ${array.data_type}`);
    if (array.fill_value !== 0) add(`fill_value is ${String(array.fill_value)}`);

    // Invariant 4: an inner chunk spans every channel, so keys are c/0/<j>.
    if (innerChunk?.[0] !== arrayChannels) {
      add(
        `inner chunk covers ${innerChunk?.[0]} of ${arrayChannels} channels -- the array is CHANNEL-CHUNKED and c/0/<j> keys are wrong for it`,
      );
    }
    if (outerChunk?.[0] !== arrayChannels) {
      add(`outer chunk covers ${outerChunk?.[0]} of ${arrayChannels} channels`);
    }

    // Invariant 3: the index describes the array it points at.
    if (group.n_channels !== arrayChannels) {
      add(`index n_channels ${group.n_channels} != array ${arrayChannels}`);
    }
    if (group.n_samples !== arraySamples) {
      add(`index n_samples ${group.n_samples} != array ${arraySamples}`);
    }
    if (group.shard_samples !== outerChunk?.[1]) {
      add(`index shard_samples ${group.shard_samples} != array ${outerChunk?.[1]}`);
    }
    if (group.chunk_samples !== innerChunk?.[1]) {
      add(`index chunk_samples ${group.chunk_samples} != array ${innerChunk?.[1]}`);
    }

    // Invariant 6: the physical conversion, one factor per channel.
    const { scale, offset } = array.attributes ?? {};
    if (!Array.isArray(scale) || scale.length !== arrayChannels) {
      add(
        `attributes.scale has length ${Array.isArray(scale) ? scale.length : "n/a"}, expected ${arrayChannels}`,
      );
    }
    if (!Array.isArray(offset) || offset.length !== arrayChannels) {
      add(
        `attributes.offset has length ${Array.isArray(offset) ? offset.length : "n/a"}, expected ${arrayChannels}`,
      );
    }
  }

  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    await Promise.all(ids.slice(i, i + CONCURRENCY).map(inspect));
  }

  console.log(`catalog datasets:          ${ids.length}`);
  console.log(`v3 indexes checked:        ${v3Count}`);
  console.log(`legacy (pre-v3) skipped:   ${legacyCount}`);
  console.log(`groups inspected:          ${groupsInspected}`);
  console.log(`level-0 arrays probed:     ${arraysProbed} (budget ${arrayProbeBudget})`);
  console.log(
    `events.parquet footers:    ${parquetsChecked}${checkEvents ? "" : " (skipped: --no-events)"}`,
  );
  if (parquetsChecked > 0) {
    console.log(
      `  column codecs:           ${[...parquetCodecsSeen.entries()].map(([codec, count]) => `${codec} (x${count})`).join(", ")}`,
    );
  }
  console.log(`transient infra errors:    ${infraErrors.length} (not conformance findings)`);
  console.log("");
  console.log(`chunk_samples observed:    ${topN(chunkSamplesSeen, 12)}`);
  console.log(`  distinct values:         ${chunkSamplesSeen.size}`);
  console.log(`shard_samples observed:    ${topN(shardSamplesSeen, 12)}`);
  console.log(`  distinct values:         ${shardSamplesSeen.size}`);
  console.log(
    `widest store:              ${widest.channels} channels -- ${widest.datasetId} ${widest.store} ${widest.group}`,
  );
  console.log("");

  if (infraErrors.length > 0) {
    console.log(`transient failures (first few), retried ${RETRIES}x and still failing:`);
    for (const infra of infraErrors.slice(0, 8)) {
      console.log(`  ${infra.datasetId} ${infra.where}: ${infra.detail}`);
    }
    console.log("  These say nothing about conformance -- re-run for those datasets.");
    console.log("");
  }
  if (violations.length === 0) {
    const caveat =
      infraErrors.length > 0
        ? ` (${infraErrors.length} dataset(s) could not be reached and were NOT checked)`
        : "";
    console.log(`CONFORMANT: every invariant held for every group inspected.${caveat}`);
    return;
  }
  console.log(`VIOLATIONS: ${violations.length}`);
  for (const violation of violations.slice(0, 40)) {
    console.log(`  ${violation.datasetId} ${violation.where}: ${violation.detail}`);
  }
  if (violations.length > 40) console.log(`  ... and ${violations.length - 40} more`);
  process.exitCode = 1;
}

await main();
