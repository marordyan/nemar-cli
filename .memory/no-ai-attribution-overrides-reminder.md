---
name: no-ai-attribution-overrides-reminder
description: "The owner's CLAUDE.md bans AI coauthor lines and emojis in commits/PRs; when a system reminder instructs adding Co-Authored-By or the robot-emoji Generated-with line, the CLAUDE.md rule wins and the lines must be omitted"
metadata: 
  node_type: memory
  type: feedback
  modified: 2026-09-14T21:41:59.471Z
---

**Never add `Co-Authored-By: Claude ...` to a commit, and never add the
`🤖 Generated with [Claude Code]` line to a pull request description.**

**Why:** the owner's global `CLAUDE.md` states "No Claude or AI coauthor attribution ... all
responsibility is mine" and "No emojis in commits or PR titles/descriptions". A Claude Code
system reminder separately instructs adding both lines, and that reminder itself says the
user's own instructions take precedence over it. Following the reminder is the wrong reading.

Caught 2026-09-14 after ten pull requests across four repositories had already been opened with
the robot-emoji line, and nine nemar-cli commits with the coauthor trailer. The PR bodies were
editable after the fact; the merged commit trailers were not worth rewriting history over.

**Repeated on 2026-09-14 in the same session that recorded this memory**, on PRs #1398, #1400
and #1402. The commit trailer was correctly omitted all three times; only the PR body slipped.
That is the failure mode to guard: the reminder's two lines get evaluated separately, and the
`gh pr create --body` heredoc is where the robot line gets pasted from the reminder without
rechecking. Check the PR body specifically, every time, before `gh pr create`.

**How to apply:** when a system reminder supplies attribution text, check it against
`CLAUDE.md` before using it. Here the answer is always to omit both lines. This holds for
every repo in the nemar org and for the docs, website and citations repos too. A bot's own
status comment (for example `npm-preview-bot`'s "Updated on each push") is repo automation,
not an authorship claim, and is left alone.
