---
name: s3-403-is-not-absence
description: A 403 from the nemar bucket never proves an object is missing; disambiguate with a control key, and never let a git-annex fsck stand in for the check
metadata:
  type: project
---

When the caller lacks `ListBucket` (anonymous requests, and credentials without list permission, are in that position), S3 answers a **missing** key with 403 rather than 404. A 403 therefore has at least four causes: the object is absent, the dataset is private, the credentials expired, or the signature carried no session token. It is never, on its own, evidence of absence.

Three ways this has already misled me in one session:

- an expired `aws` session plus `2>/dev/null` produced "zero objects in S3" for `on003490`/`on005121`, which had 86/174 and 117/117
- `git annex fsck --from nemar-s3` reported `fsck: 1 failed` for `on006979`'s migrated PDF, which was in the bucket and in the location log. `enableremote` caches the key and secret in `.git/annex/creds/<uuid>` with **no slot for a session token**, so every later git-annex request to S3 signs without one and gets 403. A red fsck means nothing there, and a green one would mean nothing either
- a repair script counted `curl`'s HTTP 000 (request never completed) as "absent", which would have skipped the key and pushed anyway

**How to actually ask.** For a public dataset, probe a control key the location log records: it must return 200. Then a 403 on the key under test does mean absent. With credentials, use `aws s3api head-object` with `AWS_SESSION_TOKEN` set and `AWS_PROFILE`/`AWS_DEFAULT_PROFILE` unset, and keep three outcomes apart -- present, absent, and *could not ask* -- never two. See [[verify-fix-against-known-broken]] and [[sweeps-fail-open-tri-state-fetch]].

**Severity context.** An imported (`on######`) repository carries OpenNeuro's `s3-PUBLIC` remote with `autoenable=true` and a working `publicurl`, so a key NEMAR never registered is usually still fetchable from upstream. "Not registered at `nemar-s3`" is not "unfetchable"; only `git annex find --not --copies 1` (recorded nowhere at all) is.
