---
name: new-tooling-repos-mit
description: "New public tooling repos under nemarOrg meant for outside use (for example the mock ORCID server) get the MIT license; nemar-cli's CC BY-NC-ND is the exception, not the default"
metadata:
  type: feedback
---

Asked while initializing the mock ORCID server project (2026-09-08): nemar-cli carries Creative Commons BY-NC-ND 4.0, which forbids reuse in a tool meant for everyone. The owner decided on MIT.

**Why:** a test double for a third-party API is only useful if other integrators can adopt and modify it; a no-derivatives license defeats that.

**How to apply:** when creating a new nemarOrg repository intended for reuse outside NEMAR, add an MIT LICENSE with "The Regents of the University of California" as the holder unless the owner names another, and say in the README that it is MIT. Do not copy nemar-cli's LICENSE into tooling repos. See [[make-vs-take-decision-test]].
