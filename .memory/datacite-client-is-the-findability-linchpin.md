---
name: datacite-client-is-the-findability-linchpin
description: "NEMAR datasets reach OpenAIRE but as \"Unknown Repository\"; the shared cdl.ucsd DataCite client, not re3data, is the fix"
metadata: 
  node_type: memory
  type: project
  modified: 2026-09-10T08:32:30.955Z
---

Per-dataset findability for NEMAR is blocked on the **DataCite client**, not on registry listings.
Verified 2026-09-10.

- re3data `r3d100013945` (DOI `10.17616/R31NJN95`, RRID `SCR_019100`) is registered and was
  refreshed 2026-09-07: size, contact, and two REST `api` entries are current.
  Still stale: `description` (OpenNeuro-only), `metadataStandardName` (absent),
  `dataLicenseName` (CC + CC0 only), keywords (no EMG/NIRS/motion/HED).
- DataCite client for prefix `10.82901` is `cdl.ucsd` ("UC San Diego"), with
  `re3data: null` and `url: null`. EZID mints under CDL's membership, so NEMAR almost
  certainly cannot edit it directly.
- Consequence, measured: `10.82901/nemar.nm000103` IS in OpenAIRE (collected from Datacite),
  but its NEMAR instances read `hostedby: "Unknown Repository"`. The Zenodo mirror reads
  `hostedby: ZENODO`, so the dedup record's `publisher` becomes "Zenodo" and NEMAR loses
  attribution on its own dataset. 769 OpenAIRE records mention the prefix, grouped under
  no NEMAR datasource.

**Why:** aggregators bind datasets to a repository through the DataCite client's `re3data`
field. Correcting the re3data record cannot supply that link from its side, so registry
work (FAIRsharing, OpenAIRE Provide, Wikidata) done first produces a datasource with no
DOIs attached to it.

**How to apply:** the first action is an EZID/CDL support request, asking for a
NEMAR-specific DataCite client for `10.82901` (preferred: own Commons page, own OpenAIRE
datasource) or at minimum `re3data = 10.17616/R31NJN95` on `cdl.ucsd`. Ask which is
possible rather than assuming. Do not propose OAI-PMH for this: DataCite already carries
the per-dataset records, so `/oai` would be a redundant second export path that does not
fix attribution. Tracked in `nemarOrg/website#288`; evidence in
`nemar-cli/.context/research-agent-findability.md`. See [[api-hosts-block-python-urllib-ua]]
when probing these APIs.
