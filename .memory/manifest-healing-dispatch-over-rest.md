---
name: manifest-healing-dispatch-over-rest
description: "To heal missing version manifests manually, prefer POST /admin/manifest/dispatch (central workflow) over the doctor-fix REST path, which starves under GitHub App quota"
metadata: 
  node_type: memory
  type: project
  modified: 2026-08-23T07:08:02.263Z
---

During the 2026-08-23 nm000225 incident remediation (nemar-cli#1130): the missing-manifest doctor fix regenerates manifests via GitHub REST (`generateManifest`) and failed with HTTP 403 for 40+ minutes under App-installation rate-limit starvation, while `POST /admin/manifest/dispatch {dataset_id, version}` (one cheap repository_dispatch; the manifest is built in the central `generate-manifest` workflow from a git checkout) succeeded first try for all 8 datasets. Also: the **un-narrowed** `POST /admin/doctor/fix` re-runs the full ~800-GET scan plus all fixes in one Worker request and dies on the subrequest budget (nemar-cli#1135); always narrow with `dataset_id`, which is what `nemar admin doctor fix` does per dataset since #1133.

**How to apply:** for manual manifest healing use `nemar admin manifest`-style dispatch (or the endpoint directly) per dataset; treat doctor-fix REST 403s as quota starvation, not data problems. Dispatch-fallback for the sweep is tracked in nemar-cli#1136.
