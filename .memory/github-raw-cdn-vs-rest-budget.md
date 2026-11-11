---
name: github-raw-cdn-vs-rest-budget
description: "Authenticated raw.githubusercontent.com serves PRIVATE repos and spends none of the REST core rate limit; the blobs API spends 5,000/hr shared across the whole installation"
metadata: 
  node_type: memory
  type: reference
  modified: 2026-09-15T15:10:05.025Z
---

Measured live on 2026-09-15, against `nemarDatasets`:

- `https://raw.githubusercontent.com/<org>/<repo>/<ref>/<path>` with
  `Authorization: Bearer <token>` serves a **private** repo (checked on `nm099999`:
  anonymous 404, authenticated 200). Responses carry **no `x-ratelimit-*` header** — it is a
  CDN, not the REST API, so it spends none of the installation's `core` budget.
- `GET /repos/<org>/<repo>/git/blobs/<sha>` with `Accept: application/vnd.github.raw` returns
  the raw bytes, and DOES spend `core`: `x-ratelimit-limit: 5000`, shared across publishing,
  imports and every sweep on that installation.
- The raw host **gzips text by default**, and `Content-Length` then describes the COMPRESSED
  body (717 vs the manifest's 1353 for the same `dataset_description.json`). Send
  `Accept-Encoding: identity` when the length has to mean the file's real size.
- Raw responses carry `cache-control: max-age=300`, so a repo visibility flip is eventually
  consistent: a path fetched just before the flip keeps serving anonymously for ~5 minutes,
  while untouched paths 404 immediately.
- Raw sends `access-control-allow-origin: *`; `data.nemar.org` does not for third-party
  origins. Moving bytes from one to the other silently revokes browser access unless the new
  response sets it.

**Why:** these four facts decide whether a Worker can broker repo content at dataset scale.
One cold download of `nm000104` is 4,557 git-tracked files; through the blobs API that single
download would exhaust the org's hourly quota and break publishing as a side effect, while
through the raw CDN it costs nothing from that budget.

**How to apply:** broker repo file bytes through the authenticated raw host; keep
blobs-by-SHA as a bounded fallback for when a path is not at the ref (a retag), never as the
hot path. Remember GitHub answers **404, not 403**, for a repo a credential cannot see — so a
404 is only evidence of absence when a working credential was actually used
([[sweeps-fail-open-tri-state-fetch]] is the same rule one level up).
Related: [[s3-403-is-not-absence]].
