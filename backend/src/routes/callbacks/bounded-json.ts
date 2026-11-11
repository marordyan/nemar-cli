/**
 * Read a callback's JSON object body under a size bound, before anything in it
 * is trusted (epic #1610). The two identifier-screen callbacks, the publication
 * request's and the scheduled sweep's, both take a report from a workflow; a
 * real report is a few kilobytes, so anything near the bound is not one, and
 * reading it would only spend the Worker's memory on an attacker's payload.
 *
 * Bounded twice: by the declared length, and by the bytes that actually arrive
 * (a declared length can be absent or wrong). The second bound is a counted read
 * of the stream, not a size check on a buffer that was already filled: a body
 * without a length (chunked) would otherwise be held whole, up to the platform's
 * request limit, before anything looked at it, and this door is open to anyone
 * until the token has been checked. The read stops and cancels the stream at the
 * bound. The answers are fixed words.
 */

import type { Context } from "hono";

/** The largest body a screen callback reads. */
export const MAX_CALLBACK_BODY_BYTES = 256 * 1024;

export type BoundedJson =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: 400 | 413; error: string };

/**
 * The request body as bytes, read chunk by chunk and abandoned the moment it passes `max`.
 * Null means it did. A stream that errors (a client that went away) throws, like a body
 * that is not JSON, and is answered the same way. Also the OpenID Connect endpoints' reader
 * (`routes/oauth.ts`), whose form bodies are open to anyone until the client has authenticated.
 */
export async function readCapped(request: Request, max: number): Promise<Uint8Array | null> {
  const stream = request.body;
  if (stream === null) return new Uint8Array(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

export async function readBoundedJsonObject(
  c: Context,
  max: number = MAX_CALLBACK_BODY_BYTES,
): Promise<BoundedJson> {
  const declared = Number(c.req.header("Content-Length") ?? "0");
  if (Number.isFinite(declared) && declared > max) {
    return { ok: false, status: 413, error: "Body too large" };
  }
  let body: unknown;
  try {
    const raw = await readCapped(c.req.raw, max);
    if (raw === null) return { ok: false, status: 413, error: "Body too large" };
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return { ok: false, status: 400, error: "Invalid JSON in request body" };
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, status: 400, error: "Body must be a JSON object" };
  }
  return { ok: true, body: body as Record<string, unknown> };
}
