---
name: git-annex-flag-and-log-truths
description: "git annex find takes --include '*' not --all; bulk registration is setpresentkey --batch in one process; .log.rmet +/- is set/unset; whereis exits 1 on 0 copies; read the location log, never an exit code"
metadata: 
  node_type: memory
  type: project
  modified: 2026-09-15T16:42:36.363Z
---

On git-annex 10.20260901, as used across the NEMAR fleet:

- **`git annex find --all` is not valid** (`Invalid option '--all'`), though `fsck --all` is. Use `find --include '*'`, which walks the working tree. `--in` accepts a bare UUID as well as a remote name. A key no file references is invisible to `find` entirely; `whereis --key <KEY>` is how to ask about those.
- **`find --include '*' --in <uuid>` EXITS 1 with an uncaught Haskell exception** (`there is no available git remote named "<uuid>"`) whenever the uuid is not resolvable as a remote in that clone, which is ordinary in a fresh fleet clone. So it is not a reliable oracle; treat its failure as "could not answer", never as an empty result.
- **`whereis --key <KEY>` exits 1 for a key with ZERO copies**, printing `(0 copies) failed`, and `--json` gives `{"success":false,"whereis":[]}`. Zero copies is exactly what a fully retracted key looks like, so an `exitCode !== 0` test reports every correct retraction as a failure. Parse `--json`'s `whereis`/`untrusted` arrays instead.
- **Bulk registration must be one process.** `setpresentkey --batch` reads `KEY UUID 1` lines on stdin (`0` to retract). Running many concurrent `setpresentkey` processes makes them race on the same git-annex branch journal: they all exit 0 and their writes do not all survive. That silently published 528 imported datasets whose content NEMAR holds and never advertised (#1392). **One malformed key aborts the REST of its batch chunk**, so the keys after it are never written.
- **In `<key>.log.rmet`, the `+`/`-` before a value is set/unset, not escaping.** The line is `<stamp>s <uuid>:V <marker><versionId>#<object path>`. `+` records the version as a place the content is; `-` RETRACTS one recorded earlier. A `!` after the marker means the value is base64, which is how a path containing a space is carried. Reading `-` as part of the value sends S3 a literal leading minus and comes back as a bare `InvalidRequest`, which reads as an upstream defect rather than a misparse. Replay the log in timestamp order, not file order.
- **`fsck --from <remote>` only checks claims the location log already makes.** An upload that moved nothing makes no claim, so fsck examines nothing and exits 0. To verify a transfer, read the log *after* fsck has pruned it -- or, for an S3 remote, HEAD the objects directly (see [[s3-403-is-not-absence]]).
- `git annex config --set` to an already-current value writes no commit, so a policy sweep is idempotent. `.gitattributes` `annex.largefiles` outranks `git annex config`; with the setting absent everywhere, git-annex annexes everything, so stripping alone is worse than leaving it.

The general rule behind all of these: **an exit code is not evidence.** Ask the log. And the inverse of a proven write needs its own proof: see [[prove-the-inverse-path-too]] and [[test-entry-point-not-callee]].
