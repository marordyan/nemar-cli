/**
 * Zarr engine protocol (v0, unstable): the zod mirror of
 * `shared/zarr-engine-protocol.schema.json`, for TypeScript callers (the CLI
 * engine, phase 4, and its tests). The JSON Schema is the source of truth and
 * is what Python and MATLAB clients read; this mirror is NOT generated from it,
 * because two generators drift on shape even when accept/reject agrees. The
 * drift is caught instead by `test/zarr-engine-protocol-contract.test.ts`,
 * which runs one table of cases through both and compares verdicts and parsed
 * values (the same approach as `backend/test/mcp-schema-parity.test.ts`).
 *
 * Compatibility: every message object is `.passthrough()`. An engine ignores an
 * unknown request field and a client an unknown response field, and both keep
 * it in the parsed value, exactly as Ajv leaves the document alone. No zod
 * schema under `shared/contract/` may be strict, which rejects unknown keys
 * (test/contract-schemas.test.ts); the JSON Schema leaves its objects open too,
 * so the two keep the same verdicts. A known field with a bad value is still
 * rejected; a misspelled optional field is ignored, so a client checks the
 * answer (`opened.representation`, a window's `channels` and `dtype`, and a
 * recipe's `channel_slice`). A recipe's `channel_slice` is the half-open range
 * from the lowest requested channel to one past the highest, so it can include
 * channels the request did not name, and it is absent when the request named
 * no channels. `hello` and `recipe` requests and responses share a `type`, so
 * a response must not carry the request's marker field (`client`, `handle`),
 * matching the JSON Schema's `not`.
 * What the JSON Schema cannot express lives only here: the `window`
 * `payload_bytes` arithmetic; in `opened`, unique representation ids, a bound
 * `representation` that is listed, is `zarr` and has non-null
 * `sampling_frequency`/`nchans`/`ntimes`/`scale`/`offset`, and `scale`/`offset`
 * with `nchans` entries when `nchans` is known; a `Range` whose `end` is at least
 * its `start`; and the full shape of a `recipe` response (the schema types only
 * its `channel_slice` and `sample_slice` in v0; this mirror reuses the MCP's
 * `readRecipeSchema`).
 *
 * `opened.record` is a neuroschema `record` document passed through unchanged
 * and typed loosely on both sides (neuroschema's schemas have no resolvable
 * `$id`); `test/contract-neuroschema-record.test.ts` validates real ones
 * against the vendored neuroschema bundle.
 *
 * The frame (magic, header length, padding, payload) is `shared/zarr/protocol-frame.ts`.
 */

import { z } from "zod";
import { readRecipeSchema } from "./mcp.js";

/** The one protocol version v0 speaks. A hello request may name any MAJOR.MINOR; the
 *  engine answers one it does not speak with unsupported_version. */
export const ENGINE_PROTOCOL_VERSION = "0.1";

export const ENGINE_ERROR_CODES = [
  "invalid_message",
  "unsupported_version",
  "not_found",
  "not_ready",
  "unknown_handle",
  "out_of_range",
  "too_large",
  "upstream_error",
  "decode_error",
  "internal",
] as const;
/** The codes this version defines. The wire set is open (`engineErrorSchema`). */
export type EngineErrorCode = (typeof ENGINE_ERROR_CODES)[number];
/** An error code as received: a defined code or one a later version adds. The
 *  `string & {}` keeps editors suggesting the defined codes. */
export type WireErrorCode = EngineErrorCode | (string & {});

/** The code a client acts on: a defined code unchanged, anything else
 *  `internal`, as the protocol requires of a code the client does not know. */
export function normalizeErrorCode(code: string): EngineErrorCode {
  return (ENGINE_ERROR_CODES as readonly string[]).includes(code)
    ? (code as EngineErrorCode)
    : "internal";
}

/** Bytes per sample for each payload dtype. */
export const ENGINE_DTYPE_BYTES = { float64: 8, int16: 2 } as const;

/** The largest request id: 2^53 - 1, so a double holds every id exactly and any client echoes it unchanged. */
export const MAX_MESSAGE_ID = Number.MAX_SAFE_INTEGER;
/** 1 to {@link MAX_MESSAGE_ID}. */
const id = z.number().int().min(1).max(MAX_MESSAGE_ID);
const handle = z.string().min(1);
const datasetId = z.string().regex(/^[a-z]{2}[0-9]{6}$/);
const nonEmpty = z.string().min(1);
/** Store channel indices; omitted in a request means all, ascending. Row i of a
 *  window payload is `channels[i]`. They must not repeat. */
const channelIndices = z
  .array(z.number().int().min(0))
  .min(1)
  .refine((a) => new Set(a).size === a.length, { message: "channels must not repeat" });
/** Omitted means 0; on every message except `window` it must be 0. */
const payloadBytesZero = z.literal(0).optional();

export const filledRangeSchema = z
  .object({
    start_sample: z.number().int().min(0),
    end_sample: z.number().int().min(0),
  })
  .passthrough();

export const helloRequestSchema = z
  .object({
    id,
    type: z.literal("hello"),
    /** MAJOR.MINOR. The engine reads it before validating the rest of the hello:
     *  a well-formed version it does not speak is unsupported_version even when
     *  the rest of the hello does not validate. */
    protocol: z.string().regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/),
    client: nonEmpty,
    payload_bytes: payloadBytesZero,
  })
  .passthrough();

export const helloResponseSchema = z
  .object({
    id,
    type: z.literal("hello"),
    protocol: z.literal(ENGINE_PROTOCOL_VERSION),
    engine: nonEmpty,
    /** The largest payload the engine will send; a window past it is `too_large`. Engine policy. */
    max_payload_bytes: z.number().int().min(1),
    payload_bytes: payloadBytesZero,
  })
  .passthrough()
  // `client` marks a hello REQUEST; a response never carries it (JSON Schema `not`).
  .refine((m) => !("client" in m), { message: "a hello response must not carry client" });

export const openRequestSchema = z
  .object({
    id,
    type: z.literal("open"),
    dataset_id: datasetId,
    /** BIDS path relative to the repository root, or the store's zarr path. */
    recording: nonEmpty,
    /** A representation id; omitted means the first zarr representation. */
    representation: nonEmpty.optional(),
    payload_bytes: payloadBytesZero,
  })
  .passthrough();

/** A `zarr` representation: one Zarr group of the recording, described with
 *  neuroschema field names but group-level values. */
export const zarrRepresentationSchema = z
  .object({
    kind: z.literal("zarr"),
    id: nonEmpty,
    store: nonEmpty,
    modality: z.string().nullable(),
    sampling_frequency: z.number().gt(0).nullable(),
    source_sampling_frequency: z.number().gt(0).nullable(),
    nchans: z.number().int().min(1).nullable(),
    ntimes: z.number().int().min(1).nullable(),
    recording_duration: z.number().min(0).nullable(),
    /** physical = digital * scale[c] + offset[c]; null except on the bound representation. */
    scale: z.array(z.number()).nullable(),
    offset: z.array(z.number()).nullable(),
  })
  .passthrough()
  // Zod-only: JSON Schema cannot compare an array length to another field. Only
  // checkable when nchans is known; the bound representation always has it.
  .refine(
    (r) =>
      r.nchans === null ||
      ((r.scale === null || r.scale.length === r.nchans) &&
        (r.offset === null || r.offset.length === r.nchans)),
    { message: "scale and offset must each have nchans entries", path: ["scale"] },
  );

/** A representation of a kind this protocol version does not define; a client skips it. */
const otherRepresentationSchema = z
  .object({ kind: nonEmpty.refine((k) => k !== "zarr"), id: nonEmpty })
  .passthrough();

export const representationSchema = z.union([zarrRepresentationSchema, otherRepresentationSchema]);

/** Narrows a parsed representation to the `zarr` kind (the union's other branch
 *  is typed `kind: string`, so a plain `kind === "zarr"` check does not narrow). */
export function isZarrRepresentation(
  r: z.infer<typeof representationSchema>,
): r is z.infer<typeof zarrRepresentationSchema> {
  return r.kind === "zarr";
}

/** A neuroschema `record` document, passed through unchanged, or null. */
export const neuroschemaRecordSchema = z.record(z.unknown()).nullable();

export const openedSchema = z
  .object({
    id,
    type: z.literal("opened"),
    handle,
    dataset_id: datasetId,
    recording: nonEmpty,
    /** The id of the representation the handle is bound to. */
    representation: nonEmpty,
    record: neuroschemaRecordSchema,
    // Non-empty: the JSON Schema says minItems 1; here the superRefine's "bound
    // representation is listed" check already rejects an empty list.
    representations: z.array(representationSchema),
    payload_bytes: payloadBytesZero,
  })
  .passthrough()
  .superRefine((m, ctx) => {
    const ids = m.representations.map((r) => r.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "representation ids must be unique",
        path: ["representations"],
      });
    }
    const bound = m.representations.find((r) => r.id === m.representation);
    if (!bound) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "representation must name one of representations",
        path: ["representation"],
      });
      return;
    }
    if (!isZarrRepresentation(bound)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "in v0 the bound representation must be a zarr one",
        path: ["representation"],
      });
      return;
    }
    const missing = (["sampling_frequency", "nchans", "ntimes", "scale", "offset"] as const).filter(
      (k) => bound[k] === null,
    );
    if (missing.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `the bound zarr representation must have ${missing.join(", ")}`,
        path: ["representations"],
      });
    }
  });

export const readWindowRequestSchema = z
  .object({
    id,
    type: z.literal("read_window"),
    handle,
    start_s: z.number().min(0),
    duration_s: z.number().gt(0),
    channels: channelIndices.optional(),
    units: z.enum(["physical", "digital"]).optional(),
    payload_bytes: payloadBytesZero,
  })
  .passthrough();

export const windowSchema = z
  .object({
    id,
    type: z.literal("window"),
    start_sample: z.number().int().min(0),
    n_samples: z.number().int().min(1),
    channels: channelIndices,
    dtype: z.enum(["float64", "int16"]),
    layout: z.literal("channel-major"),
    byte_order: z.literal("little"),
    filled_ranges: z.array(filledRangeSchema),
    payload_bytes: z.number().int().min(0),
  })
  .passthrough()
  .refine(
    (m) => m.payload_bytes === m.channels.length * m.n_samples * ENGINE_DTYPE_BYTES[m.dtype],
    {
      message: "payload_bytes must equal channels.length * n_samples * bytes-per-sample of dtype",
      path: ["payload_bytes"],
    },
  );

export const recipeRequestSchema = z
  .object({
    id,
    type: z.literal("recipe"),
    handle,
    start_s: z.number().min(0),
    duration_s: z.number().gt(0),
    channels: channelIndices.optional(),
    payload_bytes: payloadBytesZero,
  })
  .passthrough();

export const recipeResponseSchema = z
  .object({
    id,
    type: z.literal("recipe"),
    // A protocol recipe always describes one window, so sample_slice is required
    // here, though the MCP's recipe-only mode may omit it.
    recipe: readRecipeSchema.extend({ sample_slice: readRecipeSchema.shape.sample_slice.unwrap() }),
    payload_bytes: payloadBytesZero,
  })
  .passthrough()
  // `handle` marks a recipe REQUEST; a response never carries it (JSON Schema `not`).
  .refine((m) => !("handle" in m), { message: "a recipe response must not carry handle" });

export const releaseRequestSchema = z
  .object({
    id,
    type: z.literal("release"),
    handle,
    payload_bytes: payloadBytesZero,
  })
  .passthrough();

export const releasedSchema = z
  .object({
    id,
    type: z.literal("released"),
    payload_bytes: payloadBytesZero,
  })
  .passthrough();

export const engineErrorSchema = z
  .object({
    /** null only when the request's id could not be read (JSON-RPC convention). */
    id: id.nullable(),
    type: z.literal("error"),
    /** Open: a later version may add codes, and a client treats one it does not
     *  know as `internal`. */
    code: z.union([z.enum(ENGINE_ERROR_CODES), nonEmpty]) as z.ZodType<WireErrorCode>,
    message: nonEmpty,
    payload_bytes: payloadBytesZero,
  })
  .passthrough();

/** Requests a client sends. */
export const engineRequestSchema = z.union([
  helloRequestSchema,
  openRequestSchema,
  readWindowRequestSchema,
  recipeRequestSchema,
  releaseRequestSchema,
]);

/** Responses the engine sends (success types, then `error`). */
export const engineResponseSchema = z.union([
  helloResponseSchema,
  openedSchema,
  windowSchema,
  recipeResponseSchema,
  releasedSchema,
  engineErrorSchema,
]);

/** Any frame header, in either direction. */
export const engineMessageSchema = z.union([
  helloRequestSchema,
  helloResponseSchema,
  openRequestSchema,
  openedSchema,
  readWindowRequestSchema,
  windowSchema,
  recipeRequestSchema,
  recipeResponseSchema,
  releaseRequestSchema,
  releasedSchema,
  engineErrorSchema,
]);

export type HelloRequest = z.infer<typeof helloRequestSchema>;
export type HelloResponse = z.infer<typeof helloResponseSchema>;
export type OpenRequest = z.infer<typeof openRequestSchema>;
export type Opened = z.infer<typeof openedSchema>;
export type ZarrRepresentation = z.infer<typeof zarrRepresentationSchema>;

/** The representation a handle is bound to, with the fields `openedSchema`
 *  guarantees non-null on it. */
export type BoundZarrRepresentation = ZarrRepresentation & {
  sampling_frequency: number;
  nchans: number;
  ntimes: number;
  scale: number[];
  offset: number[];
};

/**
 * The bound representation of an `opened` message that `openedSchema` parsed,
 * typed with the fields it guarantees. The schema's superRefine is the one place
 * this invariant is enforced; this helper is the one place it is relied on, so a
 * caller never needs a cast or a non-null assertion. Throws if handed an `opened`
 * that did not pass the schema.
 */
export function boundRepresentation(opened: Opened): BoundZarrRepresentation {
  const bound = opened.representations.find((r) => r.id === opened.representation);
  if (!bound || !isZarrRepresentation(bound)) {
    throw new Error(
      `opened.representation ${opened.representation} is not a listed zarr representation`,
    );
  }
  const { sampling_frequency, nchans, ntimes, scale, offset } = bound;
  if (
    sampling_frequency === null ||
    nchans === null ||
    ntimes === null ||
    scale === null ||
    offset === null
  ) {
    throw new Error(`the bound representation ${bound.id} is missing a required field`);
  }
  return { ...bound, sampling_frequency, nchans, ntimes, scale, offset };
}
export type Representation = z.infer<typeof representationSchema>;
export type ReadWindowRequest = z.infer<typeof readWindowRequestSchema>;
export type EngineWindow = z.infer<typeof windowSchema>;
export type RecipeRequest = z.infer<typeof recipeRequestSchema>;
export type RecipeResponse = z.infer<typeof recipeResponseSchema>;
export type ReleaseRequest = z.infer<typeof releaseRequestSchema>;
export type Released = z.infer<typeof releasedSchema>;
export type EngineError = z.infer<typeof engineErrorSchema>;
export type EngineRequest = z.infer<typeof engineRequestSchema>;
export type EngineResponse = z.infer<typeof engineResponseSchema>;
export type EngineMessage = z.infer<typeof engineMessageSchema>;
