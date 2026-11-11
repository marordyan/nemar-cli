/**
 * NEMAR's own runtime image for a `python` job (epic #2005 phase A5, #2010; ADR 0118, round 1 review).
 *
 * `COMPUTE_RUNTIME_IMAGE` is ONE digest-pinned reference and not JSON: `[docker://]registry/path@sha256:<64
 * hex>`, the `uri` the image workflow publishes as its `launch_image` output. Nothing else is configured.
 * The digest and the Singularity image file name are DERIVED here, at read time, with the shared
 * contract's own functions (`sifFileNameForDigest`), so a value cannot carry a digest and a file name
 * that disagree. A value that is not a digest-pinned reference (a tag, a typo, a stray newline inside it)
 * is `invalid` and is never launched: a `python` job stays `created` exactly as when it is unset.
 *
 * DRIFT. The image workflow also publishes a `sif` output (the file name the node's image file is stored
 * under). That name is the digest's hex plus `.sif`, and `sifFileNameForDigest` computes the same string;
 * the two are only the same while the workflow keeps that rule. If the workflow's `sif` output ever stops
 * being `<hex>.sif`, the launcher would fail to find its image file and no check on this side can see it,
 * so the contract test of `sifFileNameForDigest` (shared with the workflow's repository) is the place to
 * change first. This file holds no value of its own: the owner sets the variable, and it stays absent
 * from every table of `backend/wrangler-sccn.toml` (`compute-switches-flag.test.ts` pins that).
 *
 * `GET /admin/compute/status` reports whether it is set, whether it is valid and its digest (a digest
 * names a public image and is not a secret; the reference itself is never echoed).
 */

import { sifFileNameForDigest } from "../../../shared/contract/compute-launch.js";
import { COMPUTE_IMAGE_DIGEST_RE, COMPUTE_IMAGE_REF_RE } from "../../../shared/contract/compute.js";
import type { Bindings } from "../types/bindings.js";

/** A digest-pinned image reference as the launch specification carries it. */
export interface ImageFacts {
  /** The reference, trimmed. */
  ref: string;
  /** `sha256:<64 hex>`, the end of the reference. */
  digest: string;
  /** `<64 hex>.sif`, derived from the digest. */
  sif: string;
}

/** The facts of a digest-pinned reference, or null when it is not one (a tag, a typo, no digest). */
export function imageFacts(raw: string): ImageFacts | null {
  const ref = raw.trim();
  if (!COMPUTE_IMAGE_REF_RE.test(ref)) return null;
  const digest = /@(sha256:[0-9a-f]{64})$/.exec(ref)?.[1] ?? "";
  if (!COMPUTE_IMAGE_DIGEST_RE.test(digest)) return null;
  const sif = sifFileNameForDigest(digest);
  return sif === null ? null : { ref, digest, sif };
}

export type RuntimeImage =
  | { state: "unset" }
  | { state: "invalid" }
  | ({ state: "ok" } & ImageFacts);

/** What `COMPUTE_RUNTIME_IMAGE` holds: nothing, something that is not a pinned reference, or one that is. */
export function readRuntimeImage(env: Pick<Bindings, "COMPUTE_RUNTIME_IMAGE">): RuntimeImage {
  const raw = env.COMPUTE_RUNTIME_IMAGE;
  if (typeof raw !== "string" || raw.trim() === "") return { state: "unset" };
  const facts = imageFacts(raw);
  return facts === null ? { state: "invalid" } : { state: "ok", ...facts };
}
