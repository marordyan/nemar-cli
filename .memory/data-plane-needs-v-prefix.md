---
name: data-plane-needs-v-prefix
description: "Data plane paths need v1.0.0, not 1.0.0; a bare-version 404 is a path error, so probe a control dataset before diagnosing"
metadata: 
  node_type: memory
  type: project
  modified: 2026-09-18T02:30:11.653Z
---

Data-plane paths carry the `v`: `/{dataset_id}/v1.0.0/manifest.json` and
`/{dataset_id}/v1.0.0/<bidsPath>`. A bare `1.0.0` returns 404 `Version not found` for EVERY
dataset, including known-good published controls, so that 404 says nothing about the dataset
you are probing.

**Why:** I read a 404 on `/nm099998/1.0.0/dataset_description.json` as evidence the anonymous
fixture's broker path was broken, which would have been a real defect in ADR 0066's git-file
broker. Probing exemplar `xx099900` in both forms showed the control 404s on `1.0.0` and 200s
on `v1.0.0`, so the fault was in my URL. The production host is `data.nemar.org`;
the dev data host is set by `DATA_HOSTNAME`.

**How to apply:** Before diagnosing any data-plane 404, re-run the same request against a
public control dataset. If the control 404s too, fix the request, not the code. Same discipline
as [[s3-403-is-not-absence]] and [[openneuro-200-hides-every-failure]]: a status code only
means something once a control has told you what the healthy answer looks like.
