---
name: retest-a-filed-diagnosis
description: "An issue's stated cause is a hypothesis; re-measure it before building the fix, even when I wrote it"
metadata: 
  node_type: memory
  type: feedback
  modified: 2026-09-13T21:22:50.500Z
---

An issue body in this repo usually names a confident cause, and that cause is often
mine from a debugging session under time pressure. Re-measure it before designing
anything on top of it. #1380 said the API's S3 identity could not reach an `on######`
prefix; the identity's policy covered the whole bucket all along, and the real fault was
my own migration tool handing `git annex copy` a temporary key with no session token.
The wrong cause had already produced a `--via-aws-cli` flag, an issue title, and a
plan to edit prod IAM.

**Why:** a symptom (403 on every request) supports several causes, and the cheapest
decisive test is usually read-only and takes minutes -- `aws iam get-user-policy`,
`aws s3api get-bucket-policy`, and one signed request made twice, with and without the
suspect variable. Build on measurement, not on the last session's narration.

**How to apply:** before implementing against a filed cause, state the claim, find the
one observation that separates it from the alternatives, and run that. When the claim
turns out wrong, correct the issue (comment plus title) so nobody else acts on it, and
say plainly in the PR what was re-tested. Related: [[verify-fix-against-known-broken]],
[[test-entry-point-not-callee]].
