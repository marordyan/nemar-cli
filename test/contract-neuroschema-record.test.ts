/**
 * neuroschema `record` conformance: the vendored record bundle compiles and
 * accepts the record documents NEMAR actually publishes. The Zarr engine
 * protocol's `opened.record` passes one of these through unchanged, so the
 * protocol tests reuse these fixtures.
 *
 * The fixtures are three records copied verbatim from the public
 * https://data.nemar.org/nm000103/latest/records.json (read on 2026-11-06).
 * They are stamped schema_version "0.3.0" yet conform to the vendored 0.4.1
 * record schema: the stamp is the emitter's, and only conformance is asserted.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NEUROSCHEMA_VERSION } from "../shared/contract/index.js";
import {
  compileNeuroschemaRecordValidator,
  formatAjvErrors,
} from "./contract/neuroschema-validator.js";

const validate = compileNeuroschemaRecordValidator();

const readJson = (rel: string): unknown =>
  JSON.parse(readFileSync(join(import.meta.dir, rel), "utf8"));

const records = readJson("fixtures/neuroschema-records/nm000103-sample.json") as Array<
  Record<string, unknown>
>;
const first = records[0] as Record<string, unknown>;

interface Provenance {
  _provenance: { neuroschema_version: string; source_commit: string };
}

describe("vendored neuroschema record bundle", () => {
  test("is cut from the same neuroschema release and commit as the dataset bundle", () => {
    const record = readJson("../shared/contract/neuroschema/record.bundle.json") as Provenance;
    const dataset = readJson("../shared/contract/neuroschema/dataset.bundle.json") as Provenance;
    expect(record._provenance.neuroschema_version).toBe(NEUROSCHEMA_VERSION);
    expect(record._provenance.source_commit).toBe(dataset._provenance.source_commit);
  });

  test("accepts every published record fixture", () => {
    expect(records.length).toBe(3);
    for (const r of records) {
      const ok = validate(r);
      if (!ok) throw new Error(`${String(r.bids_relpath)}: ${formatAjvErrors(validate)}`);
    }
  });

  test("rejects a field the record core does not declare", () => {
    expect(validate({ ...first, zarr_group: "eeg_250hz" })).toBe(false);
  });

  test("rejects a record missing a required field", () => {
    for (const key of ["dataset", "bids_relpath", "modality"]) {
      const { [key]: _dropped, ...rest } = first;
      expect(validate(rest)).toBe(false);
    }
  });

  test("rejects a channel count that is not an integer", () => {
    const summary = first.signal_summary as Record<string, unknown>;
    expect(validate({ ...first, signal_summary: { ...summary, nchans: "129" } })).toBe(false);
  });
});
