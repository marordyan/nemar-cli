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
 * Compatibility: request objects are `.strict()` (the engine rejects an unknown
 * field), response objects are `.passthrough()` (a client ignores an unknown
 * field, and keeps it in the parsed value, exactly as Ajv leaves the document
 * alone). `FilledRange` is part of a response and so is open too.
 * Two things the JSON Schema cannot express live only here: the `window`
 * `payload_bytes` arithmetic, and the full shape of a `recipe` response (the
 * schema types it as a bare object in v0; this mirror reuses the MCP's
 * `readRecipeSchema`).
 *
 * The frame (magic, header length, padding, payload) is `shared/zarr/protocol-frame.ts`.
 */

import { z } from "zod";
import { readRecipeSchema } from "./mcp.js";

/** The one protocol version v0 speaks. v0 matches it exactly; from v1 only the major must match. */
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
export type EngineErrorCode = (typeof ENGINE_ERROR_CODES)[number];

/** Bytes per sample for each payload dtype. */
export const ENGINE_DTYPE_BYTES = { float64: 8, int16: 2 } as const;

const id = z.number().int().min(1);
const handle = z.string().min(1);
const datasetId = z.string().regex(/^[a-z]{2}[0-9]{6}$/);
const nonEmpty = z.string().min(1);
const channelIndices = z.array(z.number().int().min(0)).min(1);
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
    protocol: z.literal(ENGINE_PROTOCOL_VERSION),
    client: nonEmpty,
    payload_bytes: payloadBytesZero,
  })
  .strict();

export const helloResponseSchema = z
  .object({
    id,
    type: z.literal("hello"),
    protocol: z.literal(ENGINE_PROTOCOL_VERSION),
    engine: nonEmpty,
    payload_bytes: payloadBytesZero,
  })
  .passthrough();

export const openRequestSchema = z
  .object({
    id,
    type: z.literal("open"),
    dataset_id: datasetId,
    recording: nonEmpty,
    group: nonEmpty.optional(),
    payload_bytes: payloadBytesZero,
  })
  .strict();

export const openedSchema = z
  .object({
    id,
    type: z.literal("opened"),
    handle,
    dataset_id: datasetId,
    recording: nonEmpty,
    group: nonEmpty,
    n_channels: z.number().int().min(1),
    sample_rate_hz: z.number().gt(0),
    n_samples: z.number().int().min(0),
    payload_bytes: payloadBytesZero,
  })
  .passthrough();

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
  .strict();

export const windowSchema = z
  .object({
    id,
    type: z.literal("window"),
    start_sample: z.number().int().min(0),
    n_samples: z.number().int().min(0),
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
  .strict();

export const recipeResponseSchema = z
  .object({
    id,
    type: z.literal("recipe"),
    recipe: readRecipeSchema,
    payload_bytes: payloadBytesZero,
  })
  .passthrough();

export const releaseRequestSchema = z
  .object({
    id,
    type: z.literal("release"),
    handle,
    payload_bytes: payloadBytesZero,
  })
  .strict();

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
    code: z.enum(ENGINE_ERROR_CODES),
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
