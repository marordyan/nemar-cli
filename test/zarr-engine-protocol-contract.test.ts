/**
 * The engine protocol's two copies, checked against each other (phase 3 of the
 * Zarr reader epic).
 *
 * `shared/zarr-engine-protocol.schema.json` is the language-neutral source of
 * truth; `shared/contract/zarr-engine-protocol.ts` is the zod mirror. Generated
 * schemas are not compared (two generators drift on shape even when accept and
 * reject agree; see `backend/test/mcp-schema-parity.test.ts`). Instead ONE case
 * table runs through Ajv (draft 2020-12) and zod, and both must give the same
 * verdict and, on success, the same parsed value.
 *
 * Documented gaps, each tested on the side that owns it and NOT in the
 * shared table (they would split the verdicts by design):
 *  - the `window` `payload_bytes` arithmetic (zod only; JSON Schema cannot
 *    express it);
 *  - in `opened`: unique representation ids, a bound `representation` that is
 *    listed, is `zarr` and is fully described, and `scale`/`offset` with
 *    `nchans` entries (zod only);
 *  - a `Range` whose `end` is below its `start` (zod only);
 *  - the full shape of a `recipe` response (zod reuses the MCP recipe schema;
 *    the JSON Schema types only its `channel_slice` and `sample_slice` in v0;
 *    the required `sample_slice` is in the shared table).
 *
 * `opened.record` uses a real neuroschema record (test/fixtures/
 * neuroschema-records). The group's rate, source rate, ntimes and duration
 * follow nm000103's index (500 Hz file, 250 Hz group), so the cases show the
 * record and the representation disagreeing on rate as they do in production;
 * the channel count, scale and offset are illustrative.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020";
import { buildReadRecipe } from "../shared/contract/mcp.js";
import {
  ENGINE_ERROR_CODES,
  ENGINE_PROTOCOL_VERSION,
  type EngineError,
  type WireErrorCode,
  boundRepresentation,
  engineMessageSchema,
  engineRequestSchema,
  engineResponseSchema,
  isZarrRepresentation,
  normalizeErrorCode,
  openedSchema,
  windowSchema,
} from "../shared/contract/zarr-engine-protocol.js";
import { zarrIndexSchema } from "../shared/contract/zarr-index.js";
import protocolSchema from "../shared/zarr-engine-protocol.schema.json";
import realRecords from "./fixtures/neuroschema-records/nm000103-sample.json";
import indexFixture from "./fixtures/zarr-index-v3.json";

const ajv = new Ajv2020({ strict: true, allErrors: true });
const validateJson = ajv.compile(protocolSchema as object);

/** A real recipe, built the way the MCP builds one from the checked-in index
 *  fixture, for one window (a protocol recipe always carries sample_slice). */
const realRecipe = (() => {
  const index = zarrIndexSchema.parse(indexFixture);
  return buildReadRecipe({
    index,
    store: index.stores[0],
    groupName: "eeg_250hz",
    sampleSlice: { start: 0, end: 250 },
  });
})();

type Doc = Record<string, unknown>;
interface Case {
  /** The `$defs` message this case exercises. */
  def: string;
  label: string;
  doc: Doc;
  /** One-field change that BOTH validators must reject. */
  mutate: (d: Doc) => Doc;
  mutation: string;
}

const addUnknown = (d: Doc): Doc => ({ ...d, extra_field: 1 });
const without =
  (key: string) =>
  (d: Doc): Doc => {
    const { [key]: _drop, ...rest } = d;
    return rest;
  };
const set =
  (key: string, value: unknown) =>
  (d: Doc): Doc => ({ ...d, [key]: value });

const REAL_RECORD = realRecords[0] as unknown as Doc;

/** A zarr representation; the bound one has scale and offset. */
const zarrRep = (over: Doc = {}): Doc => ({
  kind: "zarr",
  id: "eeg_250hz",
  store: "sub-NDARAA075AMK/eeg/sub-NDARAA075AMK_task-DespicableMe_eeg.zarr",
  modality: "EEG",
  sampling_frequency: 250,
  source_sampling_frequency: 500,
  nchans: 4,
  ntimes: 43034,
  recording_duration: 172.136,
  scale: [0.5, 0.5, 0.25, 1],
  offset: [0, 0, -1.5, 0],
  ...over,
});

const OPENED: Doc = {
  id: 2,
  type: "opened",
  handle: "h1",
  dataset_id: "nm000103",
  recording: "sub-NDARAA075AMK/eeg/sub-NDARAA075AMK_task-DespicableMe_eeg.set",
  representation: "eeg_250hz",
  record: REAL_RECORD,
  representations: [zarrRep()],
};

const setRep =
  (i: number, over: Doc) =>
  (d: Doc): Doc => {
    const reps = [...(d.representations as Doc[])];
    reps[i] = { ...reps[i], ...over };
    return { ...d, representations: reps };
  };

const CASES: Case[] = [
  {
    def: "HelloRequest",
    label: "hello request",
    doc: { id: 1, type: "hello", protocol: "0.1", client: "nemar-py/0.1" },
    mutate: set("protocol", "v0.1"),
    mutation: "protocol not MAJOR.MINOR",
  },
  {
    // Schema-valid on purpose: the engine, not validation, answers a version it
    // does not speak, with unsupported_version (not invalid_message).
    def: "HelloRequest",
    label: "hello request naming a version the engine may not speak",
    doc: { id: 1, type: "hello", protocol: "1.0", client: "nemar-py/2.0" },
    mutate: set("protocol", 1),
    mutation: "protocol a number",
  },
  {
    def: "HelloRequest",
    label: "hello request with explicit payload_bytes 0",
    doc: { id: 2, type: "hello", protocol: "0.1", client: "c", payload_bytes: 0 },
    mutate: set("payload_bytes", 4),
    mutation: "payload_bytes 4 on a non-window message",
  },
  {
    def: "HelloResponse",
    label: "hello response",
    doc: {
      id: 1,
      type: "hello",
      protocol: "0.1",
      engine: "0.10.28",
      max_payload_bytes: 67108864,
    },
    mutate: without("engine"),
    mutation: "engine removed",
  },
  {
    def: "OpenRequest",
    label: "open request, representation omitted",
    doc: { id: 2, type: "open", dataset_id: "nm099500", recording: "sub-synth/eeg/rec" },
    mutate: set("dataset_id", "NM099500"),
    mutation: "dataset_id uppercase",
  },
  {
    def: "OpenRequest",
    label: "open request, representation given",
    doc: {
      id: 3,
      type: "open",
      dataset_id: "nm099500",
      recording: "sub-synth/eeg/rec",
      representation: "eeg_250hz",
    },
    mutate: set("representation", ""),
    mutation: "empty representation",
  },
  {
    def: "Opened",
    label: "opened with a real neuroschema record",
    doc: OPENED,
    mutate: setRep(0, { nchans: 0 }),
    mutation: "nchans 0",
  },
  {
    def: "Opened",
    label: "opened with no record",
    doc: { ...OPENED, record: null },
    mutate: set("record", "not a record"),
    mutation: "record a string",
  },
  {
    def: "Opened",
    label: "opened with a second, unbound zarr group (nulls where the index has none)",
    doc: {
      ...OPENED,
      representations: [
        zarrRep(),
        zarrRep({
          id: "eeg_1000hz",
          sampling_frequency: 1000,
          source_sampling_frequency: null,
          nchans: 2,
          ntimes: null,
          recording_duration: null,
          modality: null,
          scale: null,
          offset: null,
        }),
      ],
    },
    mutate: setRep(1, { scale: "none" }),
    mutation: "scale a string on the unbound group",
  },
  {
    def: "Opened",
    label: "opened listing a representation of a kind v0 does not define",
    doc: {
      ...OPENED,
      representations: [zarrRep(), { kind: "edf", id: "source", url: "https://example.org/x" }],
    },
    mutate: setRep(1, { id: "" }),
    mutation: "empty id on the unknown kind",
  },
  {
    def: "ReadWindowRequest",
    label: "read_window request, defaults",
    doc: { id: 3, type: "read_window", handle: "h1", start_s: 0, duration_s: 1.5 },
    mutate: set("duration_s", 0),
    mutation: "duration_s 0",
  },
  {
    def: "ReadWindowRequest",
    label: "read_window request, channels and digital units",
    doc: {
      id: 4,
      type: "read_window",
      handle: "h1",
      start_s: 2,
      duration_s: 1,
      channels: [0, 2],
      units: "digital",
    },
    mutate: set("units", "volts"),
    mutation: "units not in the enum",
  },
  {
    def: "Window",
    label: "window, float64",
    doc: {
      id: 3,
      type: "window",
      start_sample: 500,
      n_samples: 3,
      channels: [0, 1],
      dtype: "float64",
      layout: "channel-major",
      byte_order: "little",
      filled_ranges: [],
      payload_bytes: 48,
    },
    mutate: set("byte_order", "big"),
    mutation: "byte_order big",
  },
  {
    def: "Window",
    label: "window, int16 with a filled range",
    doc: {
      id: 4,
      type: "window",
      start_sample: 0,
      n_samples: 4,
      channels: [0],
      dtype: "int16",
      layout: "channel-major",
      byte_order: "little",
      filled_ranges: [{ start_sample: 2, end_sample: 4 }],
      payload_bytes: 8,
    },
    mutate: set("filled_ranges", [{ start_sample: 2 }]),
    mutation: "filled range missing end_sample",
  },
  {
    def: "RecipeRequest",
    label: "recipe request",
    doc: { id: 5, type: "recipe", handle: "h1", start_s: 0, duration_s: 2, channels: [1] },
    mutate: set("channels", []),
    mutation: "empty channels",
  },
  {
    def: "RecipeResponse",
    label: "recipe response carrying a real MCP recipe",
    doc: { id: 5, type: "recipe", recipe: realRecipe as unknown as Doc },
    mutate: set("recipe", "not an object"),
    mutation: "recipe a string",
  },
  {
    def: "ReleaseRequest",
    label: "release request",
    doc: { id: 6, type: "release", handle: "h1" },
    mutate: set("handle", ""),
    mutation: "empty handle",
  },
  {
    def: "Released",
    label: "released",
    doc: { id: 6, type: "released" },
    mutate: set("id", 0),
    mutation: "id 0",
  },
  {
    def: "Error",
    label: "error",
    doc: { id: 7, type: "error", code: "unknown_handle", message: "no such handle: h9" },
    mutate: set("message", ""),
    mutation: "empty message",
  },
  {
    def: "Error",
    label: "error with a null id (the request id could not be read)",
    doc: { id: null, type: "error", code: "invalid_message", message: "header is not valid JSON" },
    mutate: set("id", 0),
    mutation: "id 0 (null is the only non-integer allowed)",
  },
  {
    def: "Error",
    label: "error, a different code",
    doc: { id: 8, type: "error", code: "out_of_range", message: "start_s beyond the recording" },
    mutate: set("code", ""),
    mutation: "an empty code",
  },
  {
    def: "Error",
    label: "error, a code this version does not define (the set is open)",
    doc: { id: 9, type: "error", code: "rate_limited", message: "try again later" },
    mutate: set("code", 3),
    mutation: "code not a string",
  },
];

/** Documents both validators must reject that no one-field mutation of a valid
 *  case above produces. */
const REJECTED_BY_BOTH: { label: string; doc: Doc }[] = [
  { label: "an unknown message type", doc: { id: 1, type: "ping" } },
  { label: "no type at all", doc: { id: 1 } },
  { label: "a request without an id", doc: { type: "release", handle: "h1" } },
  {
    label: "hello request, protocol 0.1.2",
    doc: { id: 1, type: "hello", protocol: "0.1.2", client: "c" },
  },
  { label: "hello request, protocol 1", doc: { id: 1, type: "hello", protocol: "1", client: "c" } },
  {
    label: "hello request, protocol with a leading zero (00.1)",
    doc: { id: 1, type: "hello", protocol: "00.1", client: "c" },
  },
  {
    label: "hello request, protocol with a leading zero (0.01)",
    doc: { id: 1, type: "hello", protocol: "0.01", client: "c" },
  },
  {
    label: "hello request, protocol empty",
    doc: { id: 1, type: "hello", protocol: "", client: "c" },
  },
  {
    label: "hello response naming another version",
    doc: { id: 1, type: "hello", protocol: "0.2", engine: "e", max_payload_bytes: 1 },
  },
  {
    label: "hello response without max_payload_bytes",
    doc: { id: 1, type: "hello", protocol: "0.1", engine: "e" },
  },
  {
    label: "hello response with max_payload_bytes 0",
    doc: { id: 1, type: "hello", protocol: "0.1", engine: "e", max_payload_bytes: 0 },
  },
  {
    label: "hello response with a fractional max_payload_bytes",
    doc: { id: 1, type: "hello", protocol: "0.1", engine: "e", max_payload_bytes: 1.5 },
  },
  { label: "opened without record (null, not absent)", doc: without("record")(OPENED) },
  { label: "opened without representations", doc: without("representations")(OPENED) },
  { label: "opened with no representations", doc: { ...OPENED, representations: [] } },
  { label: "opened without representation", doc: without("representation")(OPENED) },
  { label: "opened with a record that is an array", doc: { ...OPENED, record: [REAL_RECORD] } },
  {
    label: "a zarr representation without scale (null, not absent)",
    doc: setRep(0, { scale: undefined })(OPENED),
  },
  {
    label: "a zarr representation without store",
    doc: setRep(0, { store: undefined })(OPENED),
  },
  {
    label: "a zarr representation with a string in scale",
    doc: setRep(0, { scale: ["0.5", 1, 1, 1] })(OPENED),
  },
  {
    label: "a zarr representation with a fractional nchans",
    doc: setRep(0, { nchans: 1.5 })(OPENED),
  },
  {
    label: "a zarr representation with a zero sampling_frequency",
    doc: setRep(0, { sampling_frequency: 0 })(OPENED),
  },
  { label: "a representation without kind", doc: setRep(0, { kind: undefined })(OPENED) },
  { label: "a zarr representation with ntimes 0", doc: setRep(0, { ntimes: 0 })(OPENED) },
  {
    label: "an empty window (n_samples 0)",
    doc: {
      id: 3,
      type: "window",
      start_sample: 0,
      n_samples: 0,
      channels: [0],
      dtype: "float64",
      layout: "channel-major",
      byte_order: "little",
      filled_ranges: [],
      payload_bytes: 0,
    },
  },
  {
    // Not a valid request (client is empty), and a response may not carry client.
    label: "a hello response carrying client (the hello request's marker field)",
    doc: { id: 1, type: "hello", protocol: "0.1", engine: "e", max_payload_bytes: 1, client: "" },
  },
  {
    label: "a recipe response without sample_slice",
    doc: { id: 5, type: "recipe", recipe: without("sample_slice")(realRecipe as unknown as Doc) },
  },
  {
    label: "a recipe response carrying handle (the recipe request's marker field)",
    doc: { id: 5, type: "recipe", recipe: realRecipe as unknown as Doc, handle: "h1" },
  },
  {
    label: "read_window request with a repeated channel",
    doc: { id: 3, type: "read_window", handle: "h", start_s: 0, duration_s: 1, channels: [1, 1] },
  },
  {
    label: "recipe request with a repeated channel",
    doc: { id: 3, type: "recipe", handle: "h", start_s: 0, duration_s: 1, channels: [0, 2, 0] },
  },
  {
    label: "window with a repeated channel",
    doc: {
      id: 3,
      type: "window",
      start_sample: 0,
      n_samples: 1,
      channels: [1, 1],
      dtype: "int16",
      layout: "channel-major",
      byte_order: "little",
      filled_ranges: [],
      payload_bytes: 4,
    },
  },
  {
    label: "window without payload_bytes",
    doc: {
      id: 3,
      type: "window",
      start_sample: 0,
      n_samples: 1,
      channels: [0],
      dtype: "int16",
      layout: "channel-major",
      byte_order: "little",
      filled_ranges: [],
    },
  },
  { label: "an error with id 0", doc: { id: 0, type: "error", code: "internal", message: "m" } },
  {
    label: "a request with id 2^53 (past the largest integer a double holds exactly)",
    doc: { id: 2 ** 53, type: "release", handle: "h1" },
  },
  {
    label: "an error with a string id",
    doc: { id: "1", type: "error", code: "internal", message: "m" },
  },
  {
    label: "hello request with a null id",
    doc: { id: null, type: "hello", protocol: "0.1", client: "c" },
  },
  {
    label: "read_window request with a null id",
    doc: { id: null, type: "read_window", handle: "h", start_s: 0, duration_s: 1 },
  },
  { label: "release request with a null id", doc: { id: null, type: "release", handle: "h" } },
  {
    label: "hello response with a null id",
    doc: { id: null, type: "hello", protocol: "0.1", engine: "e", max_payload_bytes: 1 },
  },
  { label: "released with a null id", doc: { id: null, type: "released" } },
  {
    label: "window with a null id",
    doc: {
      id: null,
      type: "window",
      start_sample: 0,
      n_samples: 1,
      channels: [0],
      dtype: "float64",
      layout: "channel-major",
      byte_order: "little",
      filled_ranges: [],
      payload_bytes: 8,
    },
  },
  { label: "a fractional id", doc: { id: 1.5, type: "released" } },
  { label: "a string id", doc: { id: "1", type: "released" } },
  {
    // {client, engine} is a valid hello REQUEST carrying an unknown field (every
    // message is open), so the old "both" row is gone; neither is still invalid.
    label: "hello with neither client nor engine",
    doc: { id: 1, type: "hello", protocol: "0.1" },
  },
  {
    label: "a negative start_s",
    doc: { id: 3, type: "read_window", handle: "h", start_s: -1, duration_s: 1 },
  },
  {
    label: "a negative channel index",
    doc: { id: 3, type: "read_window", handle: "h", start_s: 0, duration_s: 1, channels: [-1] },
  },
  {
    label: "a fractional channel index",
    doc: { id: 3, type: "read_window", handle: "h", start_s: 0, duration_s: 1, channels: [0.5] },
  },
];

function both(doc: unknown) {
  const jsonOk = validateJson(doc) as boolean;
  const zod = engineMessageSchema.safeParse(doc);
  return { jsonOk, zod };
}

describe("protocol schema: Ajv and zod agree", () => {
  test("the JSON Schema compiles as draft 2020-12", () => {
    expect(() => new Ajv2020({ strict: true }).compile(protocolSchema as object)).not.toThrow();
  });

  for (const c of CASES) {
    test(`${c.label}: both accept, same parsed value`, () => {
      const { jsonOk, zod } = both(c.doc);
      expect(jsonOk, `ajv: ${JSON.stringify(validateJson.errors)}`).toBe(true);
      expect(zod.success, JSON.stringify(zod.success ? null : zod.error.issues)).toBe(true);
      if (zod.success) expect(zod.data).toEqual(c.doc);
    });

    test(`${c.label}: ${c.mutation} is rejected by both`, () => {
      const bad = c.mutate(c.doc);
      expect(bad).not.toEqual(c.doc);
      const { jsonOk, zod } = both(bad);
      expect(jsonOk).toBe(false);
      expect(zod.success).toBe(false);
    });
  }

  // Every message is open (ADR 0120): an engine ignores an unknown request
  // field and a client an unknown response field, and both keep it.
  for (const c of CASES) {
    test(`${c.label}: an unknown extra field is accepted by both and kept`, () => {
      const doc = addUnknown(c.doc);
      const { jsonOk, zod } = both(doc);
      expect(jsonOk, JSON.stringify(validateJson.errors)).toBe(true);
      expect(zod.success).toBe(true);
      if (zod.success) expect(zod.data).toEqual(doc);
    });
  }

  test("an unknown field inside a filled range is accepted by both and kept (it is part of a response)", () => {
    const doc = {
      id: 4,
      type: "window",
      start_sample: 0,
      n_samples: 4,
      channels: [0],
      dtype: "int16",
      layout: "channel-major",
      byte_order: "little",
      filled_ranges: [{ start_sample: 2, end_sample: 4, reason: "fetch_failed" }],
      payload_bytes: 8,
    };
    const { jsonOk, zod } = both(doc);
    expect(jsonOk).toBe(true);
    expect(zod.success).toBe(true);
    if (zod.success) expect(zod.data).toEqual(doc);
  });

  test("an unknown field inside a representation is accepted by both and kept (it is part of a response)", () => {
    for (const doc of [
      setRep(0, { chunk_samples: 1000 })(OPENED),
      {
        ...OPENED,
        representations: [zarrRep(), { kind: "edf", id: "source", url: "https://example.org/x" }],
      },
    ]) {
      const { jsonOk, zod } = both(doc);
      expect(jsonOk, JSON.stringify(validateJson.errors)).toBe(true);
      expect(zod.success).toBe(true);
      if (zod.success) expect(zod.data).toEqual(doc);
    }
  });

  for (const r of REJECTED_BY_BOTH) {
    test(`${r.label}: rejected by both`, () => {
      const { jsonOk, zod } = both(r.doc);
      expect(jsonOk).toBe(false);
      expect(zod.success).toBe(false);
    });
  }

  test("every error code is accepted by both, and the lists are the same", () => {
    const schemaCodes = (protocolSchema.$defs.ErrorCode as { anyOf: { enum?: string[] }[] })
      .anyOf[0].enum as string[];
    expect([...ENGINE_ERROR_CODES]).toEqual(schemaCodes);
    // The open branch: any non-empty string, so a later version's code still validates.
    expect((protocolSchema.$defs.ErrorCode as { anyOf: unknown[] }).anyOf[1]).toEqual({
      type: "string",
      minLength: 1,
    });
    for (const code of schemaCodes) {
      const doc = { id: 1, type: "error", code, message: "m" };
      const { jsonOk, zod } = both(doc);
      expect(jsonOk, code).toBe(true);
      expect(zod.success, code).toBe(true);
    }
  });

  test("on every message, an id of 2^53 - 1 is the largest both accept", () => {
    const defs = new Set<string>();
    for (const c of CASES) {
      if (typeof c.doc.id !== "number") continue;
      defs.add(c.def);
      const atCap = both({ ...c.doc, id: Number.MAX_SAFE_INTEGER });
      expect(atCap.jsonOk, `${c.label} at 2^53 - 1`).toBe(true);
      expect(atCap.zod.success, `${c.label} at 2^53 - 1`).toBe(true);
      for (const over of [2 ** 53, 1e300]) {
        const past = both({ ...c.doc, id: over });
        expect(past.jsonOk, `${c.label} at ${over}`).toBe(false);
        expect(past.zod.success, `${c.label} at ${over}`).toBe(false);
      }
    }
    // Every message definition that carries an id is covered, Error included.
    expect(defs.has("Error")).toBe(true);
    expect(defs.size).toBeGreaterThanOrEqual(10);
  });

  test("normalizeErrorCode keeps a defined code and maps anything else to internal", () => {
    for (const code of ENGINE_ERROR_CODES) expect(normalizeErrorCode(code)).toBe(code);
    expect(normalizeErrorCode("rate_limited")).toBe("internal");
    expect(normalizeErrorCode("NOT_FOUND")).toBe("internal");
    expect(normalizeErrorCode("toString")).toBe("internal");
    // A parsed error keeps the code it was sent; normalizing is the client's step.
    const parsed = engineMessageSchema.parse({
      id: 1,
      type: "error",
      code: "rate_limited",
      message: "m",
    }) as EngineError;
    const wire: WireErrorCode = parsed.code;
    expect(wire).toBe("rate_limited");
    expect(normalizeErrorCode(wire)).toBe("internal");
  });

  test("the protocol version constant is the one the hello response pins", () => {
    const response = protocolSchema.$defs.HelloResponse.properties.protocol;
    expect(response.const).toBe(ENGINE_PROTOCOL_VERSION);
    const pattern = new RegExp(protocolSchema.$defs.HelloRequest.properties.protocol.pattern);
    expect(pattern.test(ENGINE_PROTOCOL_VERSION)).toBe(true);
  });

  test("request and response unions partition the message union", () => {
    for (const c of CASES) {
      const isReq = engineRequestSchema.safeParse(c.doc).success;
      const isRes = engineResponseSchema.safeParse(c.doc).success;
      expect(isReq !== isRes, c.label).toBe(true);
    }
  });
});

describe("protocol schema: forward compatibility of requests", () => {
  // An older engine must accept a request from a newer client that carries
  // fields the older version does not define, and must still reject a request
  // whose KNOWN fields are invalid. Every request case is checked both ways.
  const requests = CASES.filter((c) => c.def.endsWith("Request"));

  test("every request message type is covered", () => {
    const covered = new Set(requests.map((c) => c.def));
    const requestDefs = (protocolSchema.oneOf as { $ref: string }[])
      .map((r) => r.$ref.replace("#/$defs/", ""))
      .filter((n) => n.endsWith("Request"));
    expect([...covered].sort()).toEqual(requestDefs.sort());
  });

  for (const c of requests) {
    const future = { ...c.doc, since_v1_1: { mode: "fast" }, tags: ["a", "b"] };

    test(`${c.label}: future fields are accepted, kept, and it stays a request`, () => {
      const { jsonOk, zod } = both(future);
      expect(jsonOk, JSON.stringify(validateJson.errors)).toBe(true);
      expect(zod.success).toBe(true);
      if (zod.success) expect(zod.data).toEqual(future);
      expect(engineRequestSchema.safeParse(future).success).toBe(true);
      expect(engineResponseSchema.safeParse(future).success).toBe(false);
    });

    test(`${c.label}: with future fields, ${c.mutation} is still rejected by both`, () => {
      const bad = c.mutate(future);
      expect(bad).not.toEqual(future);
      const { jsonOk, zod } = both(bad);
      expect(jsonOk).toBe(false);
      expect(zod.success).toBe(false);
    });
  }

  test("a required field cannot be replaced by an unknown one", () => {
    // Open does not mean loose: dropping a required field and adding another is invalid.
    const doc = { id: 3, type: "read_window", handle: "h1", start_seconds: 0, duration_s: 1 };
    const { jsonOk, zod } = both(doc);
    expect(jsonOk).toBe(false);
    expect(zod.success).toBe(false);
  });

  test("known fields keep their types when unknown fields are present", () => {
    const base = { id: 3, type: "read_window", handle: "h1", start_s: 0, duration_s: 1, extra: 1 };
    for (const [key, value] of [
      ["start_s", "0"],
      ["duration_s", -1],
      ["channels", [0, 0]],
      ["units", "volts"],
      ["handle", 7],
      ["id", 0],
      ["payload_bytes", 8],
    ] as const) {
      const { jsonOk, zod } = both({ ...base, [key]: value });
      expect(jsonOk, key).toBe(false);
      expect(zod.success, key).toBe(false);
    }
  });

  test("a newer client's hello with extra fields validates, same major or not; the engine decides by version", () => {
    for (const protocol of ["0.2", "1.1"]) {
      const doc = { id: 1, type: "hello", protocol, client: "nemar-py/3", capabilities: ["x"] };
      const { jsonOk, zod } = both(doc);
      expect(jsonOk, protocol).toBe(true);
      expect(zod.success, protocol).toBe(true);
      expect(engineRequestSchema.safeParse(doc).success, protocol).toBe(true);
    }
  });

  test("an open request that still names the old v0 draft field group is accepted, the field kept as unknown", () => {
    const doc = { id: 3, type: "open", dataset_id: "nm099500", recording: "r", group: "eeg_250hz" };
    const { jsonOk, zod } = both(doc);
    expect(jsonOk).toBe(true);
    expect(zod.success).toBe(true);
    // Not a known field: it selects nothing, and opened.representation tells the client what was bound.
    if (zod.success) expect(zod.data).toEqual(doc);
  });

  test("a request carrying the response's fields is still a request", () => {
    // hello: client marks the request, so engine and max_payload_bytes are just unknown here.
    const hello = {
      id: 1,
      type: "hello",
      protocol: "0.1",
      client: "c",
      engine: "e",
      max_payload_bytes: 9,
    };
    // recipe: handle marks the request, so a recipe object is just unknown here. A
    // REAL recipe, so the zod response branch would accept it but for the handle refine.
    const recipe = {
      id: 5,
      type: "recipe",
      handle: "h1",
      start_s: 0,
      duration_s: 1,
      recipe: realRecipe as unknown as Doc,
    };
    for (const doc of [hello, recipe]) {
      const { jsonOk, zod } = both(doc);
      expect(jsonOk, JSON.stringify(validateJson.errors)).toBe(true);
      expect(zod.success).toBe(true);
      expect(engineRequestSchema.safeParse(doc).success).toBe(true);
      expect(engineResponseSchema.safeParse(doc).success).toBe(false);
    }
  });
});

describe("protocol schema: request and response entry points", () => {
  const compileDef = (name: string) =>
    new Ajv2020({ strict: true }).compile({
      ...protocolSchema,
      oneOf: undefined,
      $ref: `#/$defs/${name}`,
    } as object);
  const requestRoot = compileDef("Request");
  const responseRoot = compileDef("Response");

  test("they partition the root: every case is exactly one of request or response, as in zod", () => {
    for (const c of CASES) {
      const isReq = requestRoot(c.doc) as boolean;
      const isRes = responseRoot(c.doc) as boolean;
      expect(isReq !== isRes, c.label).toBe(true);
      expect(isReq, c.label).toBe(engineRequestSchema.safeParse(c.doc).success);
      expect(isRes, c.label).toBe(engineResponseSchema.safeParse(c.doc).success);
    }
  });

  test("they list the same messages as the root", () => {
    const names = (refs: { $ref: string }[]) => refs.map((r) => r.$ref.replace("#/$defs/", ""));
    const req = names(protocolSchema.$defs.Request.oneOf as { $ref: string }[]);
    const res = names(protocolSchema.$defs.Response.oneOf as { $ref: string }[]);
    expect([...req, ...res].sort()).toEqual(
      names(protocolSchema.oneOf as { $ref: string }[]).sort(),
    );
  });

  test("an echoed request is not an answer", () => {
    const echoed = { id: 1, type: "release", handle: "h" };
    expect(validateJson(echoed)).toBe(true);
    expect(responseRoot(echoed)).toBe(false);
    expect(engineResponseSchema.safeParse(echoed).success).toBe(false);
  });
});

describe("protocol schema: coverage", () => {
  const messageDefs = (protocolSchema.oneOf as { $ref: string }[]).map((r) =>
    r.$ref.replace("#/$defs/", ""),
  );

  test("every oneOf entry names a real $defs message", () => {
    for (const name of messageDefs) {
      expect(protocolSchema.$defs, name).toHaveProperty(name);
    }
    expect(new Set(messageDefs).size).toBe(messageDefs.length);
  });

  test("every message type in the schema has a valid case and a rejecting mutation", () => {
    const covered = new Set(CASES.map((c) => c.def));
    for (const name of messageDefs) {
      expect(covered.has(name), `no case for ${name}`).toBe(true);
    }
    for (const name of covered) {
      expect(messageDefs, `case for unknown def ${name}`).toContain(name);
    }
  });

  test("every case validates against the def it names", () => {
    for (const c of CASES) {
      const one = new Ajv2020({ strict: true }).compile({
        ...protocolSchema,
        oneOf: undefined,
        $ref: `#/$defs/${c.def}`,
      } as object);
      expect(one(c.doc), c.label).toBe(true);
    }
  });
});

describe("protocol schema: gaps owned by one side", () => {
  const window = (over: Doc) => ({
    id: 3,
    type: "window",
    start_sample: 0,
    n_samples: 3,
    channels: [0, 1],
    dtype: "float64",
    layout: "channel-major",
    byte_order: "little",
    filled_ranges: [],
    payload_bytes: 48,
    ...over,
  });

  test("window payload_bytes must equal channels x n_samples x bytes (zod)", () => {
    expect(windowSchema.safeParse(window({})).success).toBe(true);
    expect(windowSchema.safeParse(window({ payload_bytes: 47 })).success).toBe(false);
    expect(windowSchema.safeParse(window({ payload_bytes: 49 })).success).toBe(false);
    // int16 is 2 bytes a sample: 2 channels x 3 samples x 2.
    expect(windowSchema.safeParse(window({ dtype: "int16", payload_bytes: 12 })).success).toBe(
      true,
    );
    expect(windowSchema.safeParse(window({ dtype: "int16", payload_bytes: 48 })).success).toBe(
      false,
    );
    // A window is never empty: the time rule makes that out_of_range instead.
    expect(windowSchema.safeParse(window({ n_samples: 0, payload_bytes: 0 })).success).toBe(false);
  });

  test("the bound representation must be listed (zod)", () => {
    expect(engineMessageSchema.safeParse(OPENED).success).toBe(true);
    expect(engineMessageSchema.safeParse({ ...OPENED, representation: "eeg_500hz" }).success).toBe(
      false,
    );
    expect(validateJson({ ...OPENED, representation: "eeg_500hz" })).toBe(true);
  });

  test("representation ids must be unique (zod)", () => {
    const doc = { ...OPENED, representations: [zarrRep(), zarrRep({ scale: null, offset: null })] };
    expect(engineMessageSchema.safeParse(doc).success).toBe(false);
    expect(validateJson(doc)).toBe(true);
  });

  test("a bound zarr representation must have its geometry, scale and offset (zod)", () => {
    for (const key of ["sampling_frequency", "nchans", "ntimes", "scale", "offset"]) {
      const doc = setRep(0, { [key]: null })(OPENED);
      expect(engineMessageSchema.safeParse(doc).success, key).toBe(false);
      expect(validateJson(doc), key).toBe(true);
    }
    // The same nulls are fine on a representation the handle is not bound to.
    const unbound = {
      ...OPENED,
      representation: "eeg_1000hz",
      representations: [
        zarrRep({
          sampling_frequency: null,
          nchans: null,
          ntimes: null,
          scale: null,
          offset: null,
        }),
        zarrRep({ id: "eeg_1000hz" }),
      ],
    };
    expect(engineMessageSchema.safeParse(unbound).success).toBe(true);
  });

  test("scale and offset must have nchans entries (zod)", () => {
    for (const over of [
      { scale: [1, 1, 1] },
      { offset: [0, 0, 0, 0, 0] },
      { scale: [], offset: [] },
    ]) {
      const doc = setRep(0, over)(OPENED);
      expect(engineMessageSchema.safeParse(doc).success, JSON.stringify(over)).toBe(false);
    }
  });

  test("an unbound representation with no nchans may carry scale and offset of any length (both copies)", () => {
    const doc = {
      ...OPENED,
      representations: [
        zarrRep(),
        zarrRep({ id: "eeg_1000hz", nchans: null, scale: [1, 2], offset: [0, 0] }),
      ],
    };
    const { jsonOk, zod } = both(doc);
    expect(jsonOk, JSON.stringify(validateJson.errors)).toBe(true);
    expect(zod.success).toBe(true);
  });

  test("the JSON Schema cannot check that length and says so; Ajv accepts the mismatch", () => {
    const desc = protocolSchema.$defs.ZarrRepresentation.properties.scale.description;
    expect(desc).toContain("nchans entries");
    expect(desc).toContain("physical = digital * scale[c] + offset[c]");
    expect(validateJson(setRep(0, { scale: [1, 1, 1] })(OPENED))).toBe(true);
  });

  test("in v0 the bound representation must be a zarr one (zod)", () => {
    const doc = {
      ...OPENED,
      representation: "source",
      representations: [zarrRep({ scale: null, offset: null }), { kind: "edf", id: "source" }],
    };
    expect(engineMessageSchema.safeParse(doc).success).toBe(false);
    expect(validateJson(doc)).toBe(true);
  });

  test("boundRepresentation returns the bound zarr representation with its guaranteed fields", () => {
    const parsed = openedSchema.parse({
      ...OPENED,
      representation: "eeg_1000hz",
      representations: [
        zarrRep({ scale: null, offset: null }),
        zarrRep({
          id: "eeg_1000hz",
          sampling_frequency: 1000,
          nchans: 2,
          scale: [1, 2],
          offset: [0, 0],
        }),
      ],
    });
    const bound = boundRepresentation(parsed);
    // The non-null typing is checked where it is declared: shared/ is in the root
    // typecheck, and the helper's return must satisfy BoundZarrRepresentation.
    const rate: number = bound.sampling_frequency;
    const scale: number[] = bound.scale;
    expect(bound.id).toBe("eeg_1000hz");
    expect(rate).toBe(1000);
    expect(scale).toEqual([1, 2]);
    expect(bound.nchans).toBe(2);
  });

  test("boundRepresentation refuses an opened that did not pass the schema", () => {
    const unlisted = { ...OPENED, representation: "nope" } as unknown as Parameters<
      typeof boundRepresentation
    >[0];
    expect(() => boundRepresentation(unlisted)).toThrow("not a listed zarr representation");
    const missing = {
      ...OPENED,
      representations: [zarrRep({ ntimes: null })],
    } as unknown as Parameters<typeof boundRepresentation>[0];
    expect(() => boundRepresentation(missing)).toThrow("missing a required field");
    const notZarr = {
      ...OPENED,
      representation: "source",
      representations: [zarrRep(), { kind: "edf", id: "source" }],
    } as unknown as Parameters<typeof boundRepresentation>[0];
    expect(() => boundRepresentation(notZarr)).toThrow("not a listed zarr representation");
  });

  test("isZarrRepresentation tells the kinds apart", () => {
    expect(isZarrRepresentation(zarrRep() as never)).toBe(true);
    expect(isZarrRepresentation({ kind: "edf", id: "source" })).toBe(false);
  });

  test("the record is passed through: any object is accepted and kept by both", () => {
    const record = { ...REAL_RECORD, extensions: { nemar: { processed: false } } };
    const doc = { ...OPENED, record };
    const { jsonOk, zod } = both(doc);
    expect(jsonOk).toBe(true);
    expect(zod.success).toBe(true);
    if (zod.success) expect(zod.data).toEqual(doc);
  });

  test("the JSON Schema documents the arithmetic it cannot enforce", () => {
    const desc = protocolSchema.$defs.Window.properties.payload_bytes.description;
    expect(desc).toContain("channels.length * n_samples");
    // This is the documented gap: Ajv accepts a mismatched payload_bytes.
    expect(validateJson(window({ payload_bytes: 47 }))).toBe(true);
  });

  test("a recipe's channel_slice and sample_slice are Range objects in both copies", () => {
    const withSlices = (over: Doc) => ({
      id: 5,
      type: "recipe",
      recipe: { ...(realRecipe as unknown as Doc), ...over },
    });
    const good = withSlices({
      sample_slice: { start: 0, end: 250 },
      channel_slice: { start: 2, end: 6 },
    });
    expect(validateJson(good), JSON.stringify(validateJson.errors)).toBe(true);
    expect(engineMessageSchema.safeParse(good).success).toBe(true);
    for (const [label, over] of [
      ["channel_slice as an array", { channel_slice: [2, 6] }],
      ["channel_slice with stop instead of end", { channel_slice: { start: 2, stop: 6 } }],
      ["channel_slice with a negative start", { channel_slice: { start: -1, end: 6 } }],
      ["sample_slice with a fractional end", { sample_slice: { start: 0, end: 2.5 } }],
      ["sample_slice as a string", { sample_slice: "0:250" }],
    ] as const) {
      const doc = withSlices(over as Doc);
      expect(validateJson(doc), label).toBe(false);
      expect(engineMessageSchema.safeParse(doc).success, label).toBe(false);
    }
  });

  test("a backwards Range is rejected by zod; JSON Schema cannot compare the two fields and says so", () => {
    const doc = {
      id: 5,
      type: "recipe",
      recipe: { ...(realRecipe as unknown as Doc), channel_slice: { start: 6, end: 2 } },
    };
    expect(engineMessageSchema.safeParse(doc).success).toBe(false);
    expect(validateJson(doc)).toBe(true);
    expect(protocolSchema.$defs.Range.description).toContain("JSON Schema cannot");
    expect(protocolSchema.description).toContain("that a Range's end is at least its start");
  });

  test("a recipe response must carry a full MCP recipe in zod; the schema only needs sample_slice", () => {
    const doc = { id: 5, type: "recipe", recipe: { sample_slice: { start: 0, end: 250 } } };
    expect(validateJson(doc)).toBe(true);
    expect(engineMessageSchema.safeParse(doc).success).toBe(false);
  });
});

describe("protocol schema: documented semantics", () => {
  const defs = protocolSchema.$defs as Record<string, { description?: string }>;

  test("the time rule and out_of_range are stated on both window-addressed requests", () => {
    for (const name of ["ReadWindowRequest", "RecipeRequest"]) {
      const d = defs[name].description ?? "";
      expect(d, name).toContain("floor(start_s * sampling_frequency + 0.5)");
      expect(d, name).toContain("floor(duration_s * sampling_frequency + 0.5)");
      expect(d, name).toContain("out_of_range");
      expect(d, name).toContain("never returns a truncated window");
    }
  });

  test("the two window-addressed requests say what each returns", () => {
    expect(defs.ReadWindowRequest.description).toContain("Asks for the samples of a window");
    expect(defs.RecipeRequest.description).toContain("Asks for the read recipe of a window");
    expect(defs.RecipeRequest.description).toContain("Nothing is read");
  });

  test("opened says the recording is always the BIDS path, and how the default is picked", () => {
    expect(protocolSchema.$defs.Opened.properties.recording.description).toContain(
      "Always the recording's BIDS path",
    );
    const open = protocolSchema.$defs.OpenRequest.properties.representation.description;
    expect(open).toContain("Zarr index's group order");
    expect(open).toContain("a recording with no zarr representation is not_found");
    expect(protocolSchema.description).toContain("the bound representation is a zarr one");
  });

  test("the record's version stamp is not a reason to reject it", () => {
    const d = protocolSchema.$defs.NeuroschemaRecord.description;
    expect(d).toContain("do not reject it on the stamp");
    // Conformance is an expectation checked on samples, not a guarantee.
    expect(d).toContain("checked on sample published records");
    expect(protocolSchema.$defs.HelloResponse.properties.protocol.description).toContain(
      "a client relies on a request field only when this version defines it",
    );
    expect(d).toContain("signal_properties.sampling_frequency");
  });

  test("growth of the lists is described: error codes open, payload enums closed", () => {
    const desc = protocolSchema.description;
    expect(desc).toContain("error codes are open");
    expect(desc).toContain("treats an error code it does not know as internal");
    expect(desc).toContain("dtype, layout and byte_order are closed");
    expect(desc).toContain("json.dumps(..., allow_nan=False)");
    expect(desc).toContain(
      "must refuse a window whose dtype, layout or byte_order it does not know",
    );
    expect(desc).toContain(
      "A field added to a request in a minor must be safe for an older engine to ignore",
    );
    expect(defs.ErrorCode.description).toContain("treats a code it does not know as internal");
    expect(defs.ErrorCode.description).toContain("any non-empty string is valid");
  });

  test("a window echoes the request's channels, in order", () => {
    expect(defs.ChannelIndices.description).toContain(
      "channels equals the request's channels exactly, in the request's order",
    );
  });

  test("a response field added in a minor must be safe for an older client to ignore", () => {
    expect(protocolSchema.description).toContain(
      "a field added to a response in a minor must be safe for an older client to ignore",
    );
  });

  test("hello versions compare as integers: no leading zeros, multi-digit parts allowed", () => {
    for (const protocol of ["0.1", "0.10", "1.0", "10.2"]) {
      const doc = { id: 1, type: "hello", protocol, client: "c" };
      expect(validateJson(doc), protocol).toBe(true);
      expect(engineMessageSchema.safeParse(doc).success, protocol).toBe(true);
    }
    expect(protocolSchema.$defs.HelloRequest.properties.protocol.description).toContain(
      "compared as integers",
    );
  });

  test("every error code is defined, with which ones are worth retrying", () => {
    const desc = defs.ErrorCode.description ?? "";
    for (const code of ENGINE_ERROR_CODES) expect(desc, code).toContain(`${code}:`);
    expect(desc).toContain("a later retry may succeed");
    expect(desc).toContain("retrying does not help");
  });

  test("hello comes first, once, and the engine survives unsupported_version", () => {
    const desc = defs.HelloRequest.description ?? "";
    expect(desc).toContain("any other request before a successful hello is invalid_message");
    expect(desc).toContain("a second hello after one");
    expect(desc).toContain("After unsupported_version the engine keeps running");
  });

  test("a channel past the end and adjacent filled ranges are described", () => {
    expect(defs.ChannelIndices.description).toContain("an index of nchans or more is out_of_range");
    expect(defs.ErrorCode.description).toContain("out_of_range: the window falls outside");
    expect(defs.ErrorCode.description).toContain("a channel index is nchans or more");
    expect(protocolSchema.$defs.Window.properties.filled_ranges.description).toContain(
      "adjacent ranges may or may not be merged",
    );
  });

  test("filled_ranges, channels and the version check are described", () => {
    const window = protocolSchema.$defs.Window.properties.filled_ranges.description;
    for (const word of ["end-exclusive", "sorted ascending", "non-overlapping", "fill value"]) {
      expect(window, word).toContain(word);
    }
    expect(defs.ChannelIndices.description).toContain(
      "all channels of the bound representation in ascending order",
    );
    expect(defs.ChannelIndices.description).toContain("payload row i is channels[i]");
    expect(protocolSchema.$defs.HelloRequest.description).toContain("unsupported_version");
    expect(protocolSchema.$defs.HelloRequest.description).toContain("invalid_message");
    // The version is read first, so a hello that is otherwise invalid for this
    // version still gets unsupported_version.
    expect(protocolSchema.$defs.HelloRequest.description).toContain(
      "reads protocol before validating anything else",
    );
    expect(protocolSchema.description).toContain("reads a hello's protocol before validating");
    expect(protocolSchema.description).toContain("must check them itself");
    expect(protocolSchema.description).toContain("MUST ignore unknown fields in a response");
    expect(protocolSchema.description).toContain("MUST ignore unknown fields in a request");
    expect(protocolSchema.description).toContain(
      "a known field with an invalid value is still invalid_message",
    );
    // Open requests ignore a misspelled optional field, so clients must check the answer.
    expect(protocolSchema.description).toContain(
      "a client MUST check the answer against what it asked for",
    );
    for (const field of [
      "opened.representation",
      "channels and dtype",
      "a recipe's channel_slice",
    ]) {
      expect(protocolSchema.description, field).toContain(field);
    }
    expect(protocolSchema.description).toContain("absent when the request named no channels");
  });

  test("the three texts agree on a recipe's channel_slice", () => {
    // The ADR, the JSON Schema and the zod docblock carry the SAME sentence, so a
    // client in any language can check the field; removing any clause from any of
    // the three fails here. Backticks and line wrapping are not part of the words.
    const SENTENCE =
      "A recipe's channel_slice is the half-open range from the lowest requested channel " +
      "to one past the highest, so it can include channels the request did not name, " +
      "and it is absent when the request named no channels.";
    const words = (s: string) => s.replace(/`/g, "").replace(/\s+/g, " ");
    const adr = words(
      readFileSync(
        new URL(
          "../.context/decisions/0120-the-zarr-read-core-is-shared-and-the-local-engine-speaks-a-versioned-protocol.md",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    // In the zod file the sentence sits in a JSDoc block: drop each line's " * ".
    const zodFile = words(
      readFileSync(
        new URL("../shared/contract/zarr-engine-protocol.ts", import.meta.url),
        "utf8",
      ).replace(/\n\s*\*\s?/g, " "),
    );
    const recipe = words(protocolSchema.$defs.RecipeRequest.description);
    for (const [name, text] of [
      ["ADR 0120", adr],
      ["zod docblock", zodFile],
      ["RecipeRequest description", recipe],
    ] as const) {
      expect(text, name).toContain(SENTENCE);
    }
    // The client-check rule in decision 6 names it too.
    expect(adr).toContain("a recipe's channel_slice (absent when the request named no channels)");
  });
});
