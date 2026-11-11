---
name: openneuro-200-hides-every-failure
description: "OpenNeuro's object endpoint answers 200 for content it cannot serve; only the byte count tells you, never the status code"
metadata: 
  node_type: memory
  type: reference
  modified: 2026-09-15T16:42:45.809Z
---

`https://openneuro.org/crn/datasets/<id>/objects/<key>` returns **HTTP 200 for every
failing key**, measured across 17 datasets on 2026-09-15. Not one returned an error
status. The body is one of: an S3 error document (`AccessDenied` or `NoSuchVersion`,
243-392 bytes), zero bytes, or the wrong length. It also ignores `Range`.

So **a key counts as fetchable only when the declared number of bytes arrives.** The
size is in the key itself (`SHA256E-s<bytes>--...`). Any availability check written
against status codes reports the whole archive as healthy. git-annex catches it only
because it verifies the checksum afterward.

Two more upstream shapes worth knowing:

- `https://openneuro.org/git/0/<id>`, the clone URL their docs give, returns "not found"
  without their credential helper. The anonymous public route is really the GitHub mirror
  at `OpenNeuroDatasets/<id>`.
- Anonymous `ListObjectVersions` on `s3://openneuro.org` succeeds even where anonymous
  `GetObject` on the same key is `403`, so a listing is not proof of readability.
  Related: [[s3-403-is-not-absence]], [[git-annex-flag-and-log-truths]].
