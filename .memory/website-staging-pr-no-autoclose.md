---
name: website-staging-pr-no-autoclose
description: "nemarOrg/website feature PRs merge into `staging` (not the default branch), so \"Closes #N\" never auto-closes issues and `staging` has no branch protection; close issues by hand after the merge"
metadata: 
  node_type: memory
  type: project
  modified: 2026-09-02T23:25:08.739Z
---

nemarOrg/website feature PRs target `staging`, which is not the repository's default branch.
GitHub only auto-closes "Closes #N" references when a PR merges into the default branch,
so a website PR merged into `staging` leaves its issue open (seen 2026-09-02 with PR #278 and issue #276).
`staging` also has no branch protection or rulesets, so `gh pr merge --squash` works without a review approval;
a `mergeStateStatus` of `UNSTABLE` there just means the Cloudflare Pages check reported neutral.

**Why:** the "Closes" convention silently fails on non-default targets, and it is easy to assume the issue closed.

**How to apply:** after merging a website PR into `staging`, run `gh issue close <n> -R nemarOrg/website --comment "..."` naming the merge commit and noting it ships with the next staging promotion. Related: [[epic-branch-ci-and-purge-lock]].

**Same trap in nemar-cli, via epic branches.** A phase PR that merges into
`feature/issue-N-epic-*` does not close its issue either, and neither does the epic's merge
into `dev`: GitHub only honors `Closes #N` on a merge to the DEFAULT branch, which here is
`main`. So a sub-issue stays open through the whole epic. Comment on it when the phase lands
(saying where it merged and why it is still open), and close the set by hand after the release
reaches main.

