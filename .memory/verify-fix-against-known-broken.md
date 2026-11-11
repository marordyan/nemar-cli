---
name: verify-fix-against-known-broken
description: A remediation loop reporting instant success on known-broken state is a red flag; verify through the public/user-visible surface before trusting it
metadata: 
  node_type: memory
  type: feedback
  modified: 2026-08-23T07:08:07.905Z
---

During the 2026-08-23 remediation my background retry loop reported "ALL 8 MANIFESTS FIXED" in one round, but the datasets were still broken: the shell variable interpolation had produced bogus dataset ids, the narrowed scan found zero candidates, and my verdict treated `total: 0` ("nothing to fix") as success.

**Why:** "checked nothing" is indistinguishable from "fixed everything" unless the verdict refuses the benefit of the doubt; for state known to be broken, an instant clean result is evidence of a broken checker, not a fixed system.

**How to apply:** after any remediation, re-verify through the independent user-visible surface (for NEMAR: `data.nemar.org/<id>/<v>/?format=json` probes), never through the remediation tool's own return value; treat suspiciously-fast full success on known-broken input as a bug in the loop. Same principle is now encoded in the observability monitor (empty catalog = failure, not success).
