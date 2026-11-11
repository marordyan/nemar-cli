#!/usr/bin/env bash
# Merge origin/main into the current branch (dev) for sync-dev.yml.
#
# Usage: scripts/ci/sync-dev-merge.sh "<merge commit message>"
#
# Run in a checkout whose current branch is dev, with origin/main already fetched.
#
# A hotfix released from main always conflicts with dev on the two version files, because main
# carries the released version and dev carries a -devN one. That one case is resolved here, to
# main's side, and the workflow's next step bumps dev. The resolution is a three-way merge of the
# file that favors main only inside a conflicting hunk, so a change dev made elsewhere in the same
# file (a dependency, say) is kept; and only when every conflicting hunk is a "version" line.
# Any other conflict, or a merge that fails without naming a conflicted path, is aborted and left
# to a person: exit 1.

set -euo pipefail

if [[ $# -ne 1 || -z "$1" ]]; then
  echo "usage: $0 \"<merge commit message>\"" >&2
  exit 2
fi

if git merge --no-ff origin/main -m "$1"; then
  exit 0
fi

conflicted="$(git diff --name-only --diff-filter=U)"

# True when every conflicting hunk of $1 (a path conflicted in the index) holds only "version" lines
# on both sides. Stage 1 is the common ancestor (absent when both sides added the file), 2 is dev's,
# 3 is main's.
version_lines_only() {
  local path="$1" dir ok
  dir="$(mktemp -d)"
  git show ":1:$path" >"$dir/base" 2>/dev/null || : >"$dir/base"
  git show ":2:$path" >"$dir/ours" 2>/dev/null || { rm -rf "$dir"; return 1; }
  git show ":3:$path" >"$dir/theirs" 2>/dev/null || { rm -rf "$dir"; return 1; }
  # Exit status of merge-file is the number of conflicts, so it is allowed to be non-zero here.
  git merge-file -p "$dir/ours" "$dir/base" "$dir/theirs" >"$dir/marked" || true
  ok=0
  awk '
    /^<<<<<<< / { inside = 1; hunks++; next }
    /^=======$/ && inside { next }
    /^>>>>>>> / && inside { inside = 0; next }
    inside && $0 !~ /^[[:space:]]*"version":/ { bad = 1 }
    END { exit (bad || hunks == 0) ? 1 : 0 }
  ' "$dir/marked" || ok=1
  rm -rf "$dir"
  return "$ok"
}

# Rewrite $1 as the three-way merge that takes main's side inside conflicting hunks only.
merge_favoring_main() {
  local path="$1" dir
  dir="$(mktemp -d)"
  git show ":1:$path" >"$dir/base" 2>/dev/null || : >"$dir/base"
  git show ":2:$path" >"$dir/ours"
  git show ":3:$path" >"$dir/theirs"
  git merge-file -p --theirs "$dir/ours" "$dir/base" "$dir/theirs" >"$dir/out"
  cat "$dir/out" >"$path"
  rm -rf "$dir"
}

only_version_files=1
if [[ -z "$conflicted" ]]; then
  only_version_files=0
else
  while IFS= read -r path; do
    if [[ "$path" != "package.json" && "$path" != "backend/package.json" ]]; then
      only_version_files=0
    elif ! version_lines_only "$path"; then
      only_version_files=0
    fi
  done <<<"$conflicted"
fi

if [[ "$only_version_files" -ne 1 ]]; then
  git merge --abort || true
  echo "sync-dev-merge: merge needs a person; conflicted paths:" >&2
  if [[ -n "$conflicted" ]]; then
    printf '%s\n' "$conflicted" >&2
  else
    echo "(none listed)" >&2
  fi
  exit 1
fi

resolved=()
while IFS= read -r path; do
  merge_favoring_main "$path"
  git add -- "$path"
  resolved+=("$path")
done <<<"$conflicted"

git commit --no-edit
echo "sync-dev-merge: resolved the version lines of ${resolved[*]} to main's"
