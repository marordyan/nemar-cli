#!/usr/bin/env bash
# Print the test files of the process tier, one per line, from the root of a checkout.
#
# A file belongs to the process tier when its header says so: the first word after the first
# `CI TIER:` marker is `process`. These files spawn child processes, serve the real Worker on a
# loopback port or need a host tool such as `openssl`, so they run in their own job
# (`process-tier` in test.yml) and never inside a `unit-pure` shard. `unit-pure-files.sh` calls
# this script and skips what it lists, so a file is in exactly one of the two tiers.
#
# An empty list is not an error here, because `unit-pure-files.sh` needs the list even when no
# file claims the tier; the `process-tier` job refuses an empty list itself.

set -euo pipefail
shopt -s nullglob

for f in test/*.test.ts backend/test/*.test.ts backend/test/helpers/*.test.ts; do
  # The first line that holds the marker decides, as test/ci-tier-routing.unit.test.ts reads it.
  claim="$(grep -m1 'CI TIER:' "$f" || true)"
  if printf '%s\n' "$claim" | grep -Eq 'CI TIER: process([^A-Za-z-]|$)'; then
    printf '%s\n' "$f"
  fi
done
