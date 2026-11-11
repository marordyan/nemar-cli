---
name: aws-creds-via-export-credentials
description: "Tools needing ambient AWS_ACCESS_KEY_ID get it from `aws configure export-credentials`; reading the AWS config file directly is deny-blocked"
metadata: 
  node_type: memory
  type: reference
  modified: 2026-09-16T13:38:49.754Z
---

The exemplar clone tool (`src/lib/exemplar-clone.ts`) and other scripts read
`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` from the **ambient environment**, and the
owner's local `aws` CLI resolves credentials through a source that does not populate them:
`aws sts get-caller-identity` succeeds while `aws configure get aws_access_key_id` returns
nothing.
Reading the AWS config file directly is blocked by a deny rule, so do not try.

The working form, verified 2026-09-16 in a clean env (`env -i`), where
`aws sts get-caller-identity` then resolved to the expected IAM user:

```bash
eval "$(aws configure export-credentials --format env)" && <command>
```

Run it in the **same** shell invocation as the command that needs it; shell state does not
persist between Bash tool calls.
It prints nothing sensitive to the transcript.
Which account and profile the command targets is recorded on the gated documentation site,
admin operations; check the identity before running anything that writes.

Note `e2e-test.ts` does NOT need this: it fetches per-user S3 credentials from the backend.
Only the ambient-env readers do.
If a task outlives the credentials' lifetime, export again.

Related: [[classifier-blocks-remote-secret-writes]] is the different problem of writing
secrets to a remote host; [[s3-403-is-not-absence]] for reading results back.
