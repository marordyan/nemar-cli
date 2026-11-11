---
name: crontab-edit-via-file-not-pipe
description: Editing a crontab through `crontab -l | sed | crontab -` wiped it when sed failed; always write the edited copy to a file, diff it against the backup, then `crontab <file>`
metadata:
  type: feedback
---

On 2026-09-03 a `crontab -l | sed -e '...' | crontab -` edit on the conversion host wiped the whole crontab for about a minute: the sed expression failed (the replacement text contained `#`, which was also the delimiter), sed emitted nothing, and `crontab -` installed the empty input. The backup taken one line earlier (a dated file next to the cron state) was the only reason recovery was instant.

**Why:** `crontab -` treats empty stdin as a valid, empty crontab, so any failure upstream in the pipe silently removes every job (the production and staging conversion cron jobs here).

**How to apply:** back up with `crontab -l > $B`, produce the edit into a temp file with `sed ... "$B" > "$T"`, `diff "$B" "$T"` to confirm the change is exactly what was intended, then `crontab "$T"` and verify with `crontab -l | wc -l` and a grep. Use `|` as the sed delimiter and avoid `#` in replacement text. Never pipe into `crontab -`. Related: [[epic-branch-ci-and-purge-lock]].
