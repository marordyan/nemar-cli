---
name: whole-row-select-defeats-field-withholding
description: "in nemar-cli a withholding rule applied to named fields is routinely defeated by a SELECT d.* that ships the raw column beside them; audit raw columns, not just the projection"
metadata: 
  node_type: memory
  type: feedback
  modified: 2026-09-16T21:29:37.351Z
---

The v0.10.4 release review (2026-09-16) found the third instance of one pattern in the anonymity work, after two the epic's own reviews had already caught:

- `GET /datasets/:id` nulled the four flat `anonymity_*` fields for a viewer who may not know the identifiers, and served `sweep_stamps` raw beside them -- which is the ONLY place `ANONYMITY_SWEEP_STAMP_SQL` writes the verdict. The flat fields are aliases read back out of that column, so the gate was defeated 160 lines above where it was written.
- Earlier in the same epic: the same route served raw `owner_user_id` next to the nulled `owner_username` (a stable pseudonymous handle linking one depositor's deposits), and `?owner=<username>` filtered on the real username in a `WHERE` clause that no `SELECT`-list rule can reach.

**Why:** `SELECT d.*` puts every column into the response without any of them being named at a call site, so a reviewer reading the projection sees a complete-looking rule. The withheld set (`withheldWhileAnonymous` strips only `github_repo`, `concept_doi`, `doi`) is a list someone has to remember to extend whenever a new column is added — and the anonymity sweep added one in the same release.

**How to apply:** when reviewing any change to a route that selects a whole row, enumerate the actual columns of the response against the withholding list rather than reading the rule — fetch the live endpoint and diff the key set. Ask specifically: does any NEW column in this release carry, in a JSON blob, a value some rule nulls elsewhere? `WHERE` clauses and FTS triggers are the two surfaces a projection rule cannot reach at all. Prefer withholding a column that is not in the declared contract for EVERYONE over nulling it conditionally. See [[prove-the-inverse-path-too]] and [[retest-a-filed-diagnosis]].
