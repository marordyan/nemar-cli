/**
 * Public JSON Schema documents: `GET /schemas/<name>.json`.
 *
 * The Zarr serving index is the mandatory entry point to the whole Zarr layer
 * (anonymous in-prefix ListBucket is denied on the serving bucket), and until
 * issue #1059 it was entirely undocumented -- every field was discoverable only
 * by probing a live object, so external clients were coupling to a shape nobody
 * had written down. Serving the schema from a stable URL is what lets
 * docs.nemar.org and any client point at a versioned contract instead.
 *
 * Static and D1-free by design: the bytes are the repo's own
 * `shared/zarr-index.schema.json`, imported at build time, so this route cannot
 * drift from the schema the converter validates against before upload
 * (scripts/zarr/generate_zarr.py's `validate_document`). One file, two readers.
 *
 * Versioned in the PATH, not by content negotiation: a schema is a contract, and
 * a client that pinned v3 must keep getting v3 when v4 exists. A new format
 * version adds a route; it never edits this one in place. The one exception is
 * `zarr-engine-protocol-v0.json`: v0 is unstable and may change in place.
 */

import { Hono } from "hono";
import zarrEngineProtocolSchema from "../../../shared/zarr-engine-protocol.schema.json" with {
  type: "json",
};
import zarrIndexSchema from "../../../shared/zarr-index.schema.json" with { type: "json" };
import zarrManifestSchema from "../../../shared/zarr-manifest.schema.json" with { type: "json" };
import type { Bindings } from "../types/bindings";

/**
 * Immutable-ish: a published schema version's content does not change, so a long
 * TTL is safe and keeps this off the Worker's critical path. The documented
 * exception is `zarr-engine-protocol-v0.json`, which is unstable and may change
 * in place: a client can see the previous v0 for up to a day after a change.
 * Not `immutable`, because a clarification to a `description` is a legitimate
 * republish and a day-long window is short enough to make that reachable.
 */
const CACHE_CONTROL = "public, max-age=86400";

const SCHEMAS: Record<string, unknown> = {
  "zarr-index-v3.json": zarrIndexSchema,
  "zarr-manifest-v1.json": zarrManifestSchema,
  "zarr-engine-protocol-v0.json": zarrEngineProtocolSchema,
};

export const schemaRoutes = new Hono<{ Bindings: Bindings }>();

schemaRoutes.get("/:name", (c) => {
  const schema = SCHEMAS[c.req.param("name")];
  if (!schema) {
    return c.json({ error: "Unknown schema", available: Object.keys(SCHEMAS).sort() }, 404);
  }
  // `application/schema+json` is the media type registered for a JSON Schema
  // document by RFC 9358 (published, not a draft), and it is what a
  // schema-aware client content-sniffs for. It is a strict subtype of
  // application/json, so a plain JSON client is unaffected.
  return new Response(JSON.stringify(schema), {
    headers: {
      "Content-Type": "application/schema+json; charset=utf-8",
      "Cache-Control": CACHE_CONTROL,
    },
  });
});

/** Names this route serves, so a listing endpoint or a test can enumerate them. */
export const SCHEMA_NAMES = Object.keys(SCHEMAS).sort();
