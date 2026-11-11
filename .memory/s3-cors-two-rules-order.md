---
name: s3-cors-two-rules-order
description: The nemar bucket CORS has two ordered rules; the read rule must stay first or uploads or Range reads break
metadata: 
  node_type: memory
  type: project
  modified: 2026-09-16T19:45:58.123Z
---

The `nemar` S3 bucket has a two-rule CORS configuration as of 2026-09-16.
This note records the rule order and the header lesson only; read the live configuration from the bucket itself with the AWS CLI (`aws s3api get-bucket-cors`, with credentials that may read it).
Order is load-bearing: S3 applies the FIRST rule matching origin plus method plus headers.

1. `browser-reads` -- GET/HEAD for browser readers.
   Exposes `ETag, Content-Length, Content-Range, Accept-Ranges, Content-Type, Last-Modified`, with a MaxAge of one day.
2. `website-uploads` -- PUT/GET/HEAD for the website's upload flow, exposes `ETag` only, with a MaxAge of one hour.
   This is the pre-existing rule, unchanged.

Put the read rule second and every GET falls into the upload rule, which exposes only `ETag`;
drop the upload rule and the website upload flow's `PUT` preflight fails.

**Why:** `Content-Range` is returned on the wire but is unreadable from browser code unless it is
in `Access-Control-Expose-Headers`. Without it a browser Zarr reader cannot tell a real 206 from a
server that ignored the Range and sent the whole object, which is the silent-wrong-bytes class that
the MCP read_window work already hit once. ADR 0049 puts browser compute on this path, so the
expose list is a correctness requirement, not a convenience.

**How to apply:** Probing the bucket with an origin that matches no rule returns NO CORS headers at
all and a 403 preflight, which reads exactly like "the bucket has no CORS config". It is not.
Always probe with an origin the configuration lists (the main site's) before concluding anything.
CORS never grants access: private objects still 403 (checked against `xx099907` with a public control).
Browser readers address `data_base` on S3 directly. Related: [[s3-403-is-not-absence]], [[prove-the-inverse-path-too]].
