---
name: annex-worktree-git-symlink
description: "git-annex rewrites nemar-cli worktree .git files into symlinks, breaking EnterWorktree and worktree remove; fix by restoring a gitdir file"
metadata:
  node_type: memory
  type: project
  modified: 2026-08-23T16:16:50.640Z
---

In nemar-cli (git-annex-initialized), `git worktree add` produces a worktree whose `.git` is a **symlink** into `.git/worktrees/<name>` (git-annex converts it so annexed-content resolution works), and annex re-converts it even after manual repair (observed 2026-08-23). Consequences: Claude Code's EnterWorktree refuses the worktree ("git metadata has symbolic links in place of annex"), and `git worktree remove` fails with "'.git' is not a .git file, error code 10".

**How to apply:** repair before EnterWorktree or removal by deleting the `.git` symlink and writing a plain gitdir file in its place, containing one line: `gitdir: <repo>/.git/worktrees/<name>`. Then work by absolute path if EnterWorktree still refuses.

Removal then needs no manual step and no user involvement: after restoring the gitdir file, plain `git worktree remove <wt>` succeeds. Confirmed 2026-08-23 on three worktrees, including two that had already been pruned; for those, restore the gitdir file and add `--force`.

An earlier version of this note claimed the user had to delete the directory by hand and then run `git worktree prune`. That was wrong, and only looked true because the repair step had not been tried before the removal.

A local guardrail does still block a recursive delete of a live worktree root, so repair-then-remove is the path that works, not deleting the directory. See also [[verify-fix-against-known-broken]].

**Addendum 2026-09-06:** write the gitdir file with an absolute repo root (`<absolute repo root>/.git/worktrees/<name>`), never `$(pwd)`: the Bash tool's cwd can still be `backend/` from a previous call, which produced `.../nemar-cli/backend/.git/worktrees/<name>` and a `git worktree remove` failure with "error code 7" (target missing) instead of 10. Repair by rewriting the file with the absolute path, then `git -C <root> worktree remove --force <wt>` and `git worktree prune`.

**Addendum 2026-09-08:** do not run any git command inside the worktree between the repair and the removal. On the epic worktree, "git -C <wt> status" right after writing the gitdir file let annex's hook re-convert .git (it printed "unable to convert .git file to symlink that will work with git-annex" and left a .git directory), and "git worktree remove" failed with error code 10 again. The sequence that works every time: delete <wt>/.git (a symlink or a stray directory, never the repository; a recursive delete of that one path is fine), write the gitdir file with the absolute path, then "git worktree remove <wt>" immediately from the primary checkout, then "git branch -D" and "git worktree prune". Also, "gh pr merge --delete-branch" run from a worktree cannot delete the local branch ("used by worktree"); the remote branch is still deleted, and the local one goes with the worktree cleanup.
