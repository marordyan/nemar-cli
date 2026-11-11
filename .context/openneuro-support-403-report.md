# OpenNeuro support email — inaccessible dataset objects (403)

**To:** OpenNeuro support (Contact form at openneuro.org, or a GitHub issue on OpenNeuroOrg/openneuro)
**From:** NEMAR (Neuroelectromagnetic Data Archive and Tools Resource), `<contact email>`

> Redacted for the public repository: the AWS account id, the IAM user ARN and the contact address are replaced by `<account id>`, `<IAM user ARN>` and `<contact email>`.
**Subject:** Several public OpenNeuro datasets have S3 objects that aren't readable (403)

---

Hi OpenNeuro team,

NEMAR (nemar.org) mirrors OpenNeuro EEG/MEG/iEEG datasets into our archive. We've hit a set of datasets that are listed as public and discoverable through your GraphQL API, but whose data objects under `s3://openneuro.org/<id>/` cannot be read by anyone other than (presumably) the owner.

For each of the datasets below, a request for any data file returns **403 Forbidden** in all three of:

1. **Anonymous HTTP** — e.g. `https://s3.amazonaws.com/openneuro.org/ds007720/CHANGES` → 403
2. **Your own GraphQL-provided download URL** — `latestSnapshot.files[].urls` returns `https://s3.amazonaws.com/openneuro.org/ds007720/CHANGES?versionId=...`, which also → 403
3. **A signed AWS request** from our AWS account (`<account id>`) → 403 Forbidden

By contrast, other OpenNeuro datasets (e.g. **ds007052**) are readable normally via all three methods, so this looks specific to these snapshots — most likely their objects are missing the public-read ACL / bucket-policy grant that the rest of OpenNeuro has.

**Affected datasets (OpenNeuro IDs):**

- ds007541
- ds007720
- ds007721
- ds007822
- ds007864
- ds007865
- ds007895
- ds007968

**Could you please** either make these snapshots' data objects publicly readable like the rest of OpenNeuro, or let us know the intended access path? (If the restriction is intentional, granting read access to AWS account `<account id>` would also unblock our mirror.)

Happy to provide request IDs, timestamps, or anything else that helps you trace it.

Thanks!
[Your name], NEMAR

---

## Notes / evidence (for our records, not for the email)
- Verified 2026-06-21. Signed test: `aws s3api head-object --bucket openneuro.org --key ds007720/CHANGES --region us-east-1` → 403 (caller `<IAM user ARN>`, the owner's IAM user). Public contrast `ds007052/dataset_description.json` → 200.
- These 8 are tracked in NEMAR as `import_jobs.status='quarantined'`, `last_error` contains `upstream_inaccessible`, surfaced on dashboard.nemar.org/observability ("OpenNeuro inaccessible" tile). They are currently private/unpublished in NEMAR (no data to serve).
- Re-run the list any time: `SELECT source_id FROM import_jobs WHERE status='quarantined' AND last_error LIKE '%upstream_inaccessible%'`.
- This is the manual seed of the weekly report (nemar-cli#827).
