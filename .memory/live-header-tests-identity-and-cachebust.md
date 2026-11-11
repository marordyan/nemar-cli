---
name: live-header-tests-identity-and-cachebust
description: "a live test asserting response headers must cache-bust and request Accept-Encoding identity, or it fails against a correct origin for 300s after deploy and asserts whichever encoding the client negotiated"
metadata: 
  node_type: memory
  type: project
  modified: 2026-09-16T21:29:24.564Z
---

Found driving nemar-cli v0.10.4 (2026-09-16). `test/git-broker-live.test.ts` asserted `Content-Length` equals the manifest size and failed three separate times against a worker that was already correct. Two independent causes, both about the transport rather than the code:

1. **The edge cache.** Brokered data-plane responses are `public, max-age=300` (ADR 0066), so for five minutes after a deploy that changes a header the plain URL serves the PREVIOUS build's response. CI's `--retry` operates in seconds, so the run right after a deploy fails on a fix that is already live. A distinct query string is a distinct cache key and reaches the origin.
2. **Content negotiation.** `Content-Length` describes the ENCODED body (RFC 9110). Cloudflare compresses for any client that accepts it, and Bun's `fetch` negotiates zstd by default. Measured on one worker within one second: default fetch `Content-Length: null` with `Content-Encoding: zstd`; `Accept-Encoding: identity` gives `Content-Length: 1414`. Bun honors the identity request header.

**Why:** "the response carries a length equal to the manifest's size" is a claim about the DECODED body. A test that does not say which body it means asserts a property of whichever encoding the client happened to negotiate, through whatever the edge had cached.

**How to apply:** any live test asserting response headers on a cacheable route fetches with a unique query AND `Accept-Encoding: identity`, each with the measurement that justifies it. Keep a second unbusted fetch with no encoding preference to prove the published URL serves the right BYTES, compared as UTF-8 byte length (`.length` on a string counts UTF-16 units: `dataset_description.json` is 1412 by `.length`, 1414 in bytes). Corollary for the product: a compressing client legitimately gets no length, so the manifest stays the authority on decoded size, which is why `src/lib/file-download.ts` checks `file.size` and not the header. See [[bun-test-lenient-vs-workerd]] and [[verify-fix-against-known-broken]].
