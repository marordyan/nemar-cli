---
name: classifier-blocks-remote-secret-writes
description: the auto-mode classifier refuses commands that pipe a freshly minted secret into a remote credentials file; hand the owner a one-liner that never prints the secret instead
metadata:
  type: feedback
---

On 2026-09-02 the auto-mode classifier blocked a command that minted an AWS access key and piped it over ssh into a credentials file on a remote host (writing a secret to a remote host), and an earlier variant that passed the classifier failed silently because `aws configure` was not on PATH in the remote's non-login shell, so the minted key was lost and had to be revoked.
Creating the IAM user and policy was fine.

**Why:** the classifier treats remote credential writes as high risk regardless of scope; retrying variants wastes keys.

**How to apply:** do the IAM side (user, policy, revocations, verification) yourself, and give the owner one paste-able command that mints the key and writes it remotely without echoing the secret (print only the key id prefix).
A non-login ssh shell on the remote host does not have the user-local tool directories on its PATH, so the command must set PATH itself; where the tools live on that host is in the gated documentation site, admin operations.
Verify afterwards from the remote host with `sts get-caller-identity` plus a denied prod write.
