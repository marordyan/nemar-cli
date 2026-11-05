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
 * Two documented gaps, each tested on the side that owns it and NOT in the
 * shared table (they would split the verdicts by design):
 *  - the `window` `payload_bytes` arithmetic (zod only; JSON Schema cannot
 *    express it);
 *  - the full shape of a `recipe` response (zod reuses the MCP recipe schema;
 *    the JSON Schema types it as a bare object in v0).
 */

import { describe, expect, test } from "bun:test";
import { Ajv2020 } from "ajv/dist/2020";
import { buildReadRecipe } from "../shared/contract/mcp.js";
import {
  ENGINE_ERROR_CODES,
  ENGINE_PROTOCOL_VERSION,
  engineMessageSchema,
  engineRequestSchema,
  engineResponseSchema,
  windowSchema,
} from "../shared/contract/zarr-engine-protocol.js";
import { zarrIndexSchema } from "../shared/contract/zarr-index.js";
import protocolSchema from "../shared/zarr-engine-protocol.schema.json";
import indexFixture from "./fixtures/zarr-index-v3.json";

const ajv = new Ajv2020({ strict: false, allErrors: true });
const validateJson = ajv.compile(protocolSchema as object);

/** A real recipe, built the way the MCP builds one from the checked-in index fixture. */
const realRecipe = (() => {
  const index = zarrIndexSchema.parse(indexFixture);
  return buildReadRecipe({ index, store: index.stores[0], groupName: "eeg_250hz" });
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

const OPENED = {
  id: 2,
  type: "opened",
  handle: "h1",
  dataset_id: "nm099500",
  recording: "sub-synth/eeg/rec",
  group: "eeg_250hz",
  n_channels: 4,
  sample_rate_hz: 250,
  n_samples: 5000,
  scale: [0.5, 0.5, 0.25, 1],
  offset: [0, 0, -1.5, 0],
};

const CASES: Case[] = [
  {
    def: "HelloRequest",
    label: "hello request",
    doc: { id: 1, type: "hello", protocol: "0.1", client: "nemar-py/0.1" },
    mutate: set("protocol", "0.2"),
    mutation: "protocol 0.2 (v0 matches exactly)",
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
    label: "open request, group omitted",
    doc: { id: 2, type: "open", dataset_id: "nm099500", recording: "sub-synth/eeg/rec" },
    mutate: set("dataset_id", "NM099500"),
    mutation: "dataset_id uppercase",
  },
  {
    def: "OpenRequest",
    label: "open request, group given",
    doc: {
      id: 3,
      type: "open",
      dataset_id: "nm099500",
      recording: "sub-synth/eeg/rec",
      group: "eeg_250hz",
    },
    mutate: addUnknown,
    mutation: "unknown extra field",
  },
  {
    def: "Opened",
    label: "opened",
    doc: {
      id: 2,
      type: "opened",
      handle: "h1",
      dataset_id: "nm099500",
      recording: "sub-synth/eeg/rec",
      group: "eeg_250hz",
      n_channels: 4,
      sample_rate_hz: 250,
      n_samples: 5000,
      scale: [0.5, 0.5, 0.25, 1],
      offset: [0, 0, -1.5, 0],
    },
    mutate: set("n_channels", 0),
    mutation: "n_channels 0",
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
    mutate: set("code", "oops"),
    mutation: "code not in the enum",
  },
];

/** Cases only one side can reject, or that no valid case can mutate into. */
const REJECTED_BY_BOTH: { label: string; doc: Doc }[] = [
  { label: "an unknown message type", doc: { id: 1, type: "ping" } },
  { label: "no type at all", doc: { id: 1 } },
  { label: "a request without an id", doc: { type: "release", handle: "h1" } },
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
  { label: "opened without scale", doc: { ...OPENED, scale: undefined } },
  { label: "opened without offset", doc: { ...OPENED, offset: undefined } },
  { label: "opened with a string in scale", doc: { ...OPENED, scale: ["0.5", 1, 1, 1] } },
  { label: "opened with offset not an array", doc: { ...OPENED, offset: 0 } },
  { label: "an error with id 0", doc: { id: 0, type: "error", code: "internal", message: "m" } },
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
      n_samples: 0,
      channels: [0],
      dtype: "float64",
      layout: "channel-major",
      byte_order: "little",
      filled_ranges: [],
      payload_bytes: 0,
    },
  },
  { label: "a fractional id", doc: { id: 1.5, type: "released" } },
  { label: "a string id", doc: { id: "1", type: "released" } },
  {
    // With open responses, {client, engine} is a valid hello RESPONSE carrying an
    // unknown field, so the old "both" row is gone; neither is still invalid.
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
    expect(() => new Ajv2020({ strict: false }).compile(protocolSchema as object)).not.toThrow();
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

  // Requests are closed, responses are open (ADR 0118): the engine rejects an
  // unknown field in a request, a client ignores one in a response.
  for (const c of CASES) {
    const isRequest = c.def.endsWith("Request");
    if (isRequest) {
      test(`${c.label}: an unknown extra field is rejected by both (request)`, () => {
        const { jsonOk, zod } = both(addUnknown(c.doc));
        expect(jsonOk).toBe(false);
        expect(zod.success).toBe(false);
      });
    } else {
      test(`${c.label}: an unknown extra field is accepted by both and kept (response)`, () => {
        const doc = addUnknown(c.doc);
        const { jsonOk, zod } = both(doc);
        expect(jsonOk, JSON.stringify(validateJson.errors)).toBe(true);
        expect(zod.success).toBe(true);
        if (zod.success) expect(zod.data).toEqual(doc);
      });
    }
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

  for (const r of REJECTED_BY_BOTH) {
    test(`${r.label}: rejected by both`, () => {
      const { jsonOk, zod } = both(r.doc);
      expect(jsonOk).toBe(false);
      expect(zod.success).toBe(false);
    });
  }

  test("every error code is accepted by both, and the lists are the same", () => {
    const schemaCodes = (protocolSchema.$defs.ErrorCode as { enum: string[] }).enum;
    expect([...ENGINE_ERROR_CODES]).toEqual(schemaCodes);
    for (const code of schemaCodes) {
      const doc = { id: 1, type: "error", code, message: "m" };
      const { jsonOk, zod } = both(doc);
      expect(jsonOk, code).toBe(true);
      expect(zod.success, code).toBe(true);
    }
  });

  test("the protocol version constant is the one the schema pins", () => {
    const hello = protocolSchema.$defs.HelloRequest.properties.protocol;
    expect(hello).toEqual({ const: ENGINE_PROTOCOL_VERSION });
  });

  test("request and response unions partition the message union", () => {
    for (const c of CASES) {
      const isReq = engineRequestSchema.safeParse(c.doc).success;
      const isRes = engineResponseSchema.safeParse(c.doc).success;
      expect(isReq !== isRes, c.label).toBe(true);
    }
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
      const one = new Ajv2020({ strict: false }).compile({
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
    // An empty window carries no payload.
    expect(windowSchema.safeParse(window({ n_samples: 0, payload_bytes: 0 })).success).toBe(true);
  });

  test("opened scale and offset must have n_channels entries (zod)", () => {
    expect(engineMessageSchema.safeParse(OPENED).success).toBe(true);
    expect(engineMessageSchema.safeParse({ ...OPENED, scale: [1, 1, 1] }).success).toBe(false);
    expect(engineMessageSchema.safeParse({ ...OPENED, offset: [0, 0, 0, 0, 0] }).success).toBe(
      false,
    );
    expect(engineMessageSchema.safeParse({ ...OPENED, scale: [], offset: [] }).success).toBe(false);
  });

  test("the JSON Schema cannot check that length and says so; Ajv accepts the mismatch", () => {
    const desc = protocolSchema.$defs.Opened.properties.scale.description;
    expect(desc).toContain("length equals n_channels");
    expect(desc).toContain("physical = digital * scale[c] + offset[c]");
    expect(validateJson({ ...OPENED, scale: [1, 1, 1] })).toBe(true);
  });

  test("the JSON Schema documents the arithmetic it cannot enforce", () => {
    const desc = protocolSchema.$defs.Window.properties.payload_bytes.description;
    expect(desc).toContain("channels.length * n_samples");
    // This is the documented gap: Ajv accepts a mismatched payload_bytes.
    expect(validateJson(window({ payload_bytes: 47 }))).toBe(true);
  });

  test("a recipe response must carry a full MCP recipe in zod; the schema only needs an object", () => {
    const doc = { id: 5, type: "recipe", recipe: {} };
    expect(validateJson(doc)).toBe(true);
    expect(engineMessageSchema.safeParse(doc).success).toBe(false);
  });
});
