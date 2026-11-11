# `.memory/` — what working on this project has taught, kept where anyone can read it

This directory holds durable operational knowledge learned while working on this repository:
the flag that actually works, the status code that lies, the test tier a comment silently moves a
file into, the fix that looked right and was not. One observation per file.

It is tracked in git on purpose. The same knowledge used to live only in a coding agent's private
memory store, keyed to one agent on one machine, which fails three ways:

- **It dies with the agent.** A different agent, model or machine starts from zero on the same
  project, and rediscovers the same trap at the same cost.
- **Nobody can review it.** Knowledge outside the repository is never read by a person, never
  corrected when it goes stale, and never challenged when it is wrong. A memory that has quietly
  become false is worse than no memory at all.
- **It is invisible.** Nothing outside that one agent can search it or ship it with the project.

The rule this follows is one the project already earned elsewhere: a verdict recorded only in a
transcript is not a decision. Private agent memory is the same problem wearing a different hat.

## What belongs here, and what does not

This is the third kind of document, and the boundary matters or everything lands in whichever
directory was seen most recently.

| Kind | Where | What it is |
|---|---|---|
| Decision | [`.context/decisions/`](../.context/decisions/README.md) | A ruling with authority. Binding. Where it and anything else disagree, it wins. |
| Analysis | [`.context/`](../.context/README.md) | Design notes, research, plans. The reasoning behind decisions. |
| **Memory** | **here** | An observation that cost someone time. No authority, no argument: just what is true and what to do about it. |

A memory is not a decision. It does not settle anything, and it must never be cited as if it did.
It is closer to a scar.

## Format

One fact per file, named in kebab case, with YAML frontmatter:

```markdown
---
name: <short-kebab-case-slug>
description: <one line, used to decide whether this entry is relevant>
metadata:
  type: project | feedback | reference | user
  recorded: <ISO date the fact was verified>
  revalidate_after: <ISO date, for a fact that depends on a changing surface>
---

<the fact, then why it matters, then what to do about it>
```

`recorded` and `revalidate_after` are optional on entries that predate them and expected on new ones
(the project plugin's memory template calls for both); set `revalidate_after` whenever the fact
depends on a file, flag, workflow, dependency or service.

`MEMORY.md` is the index: one line per entry, so a reader can find the relevant one without
loading all of them. Keep it in step with the files; an index that lies is worse than none.
The project plugin's template names this file `INDEX.md`; this repository keeps `MEMORY.md`, the name its
entries were seeded with, rather than carry two indexes.

Deliberately dull markdown, so an agent that did not write an entry can still read it.

## Rules

- **Never commit a secret.** No tokens, keys, credentials or connection strings. This directory is
  public in the same sense the repository is.
- **No personal data.** Refer to people by role ("the owner"). Do not record names, email
  addresses, handles or anything about a named individual.
- **No host or account specifics.** No hostnames or addresses of private machines, real home
  paths, cloud account ids, role ARNs, tenant, allocation or project ids, private repository
  contents, or how a host is hardened or exposed. Keep the lesson, and point at the gated
  documentation site (admin operations) for the specific.
- **Date a claim that can rot.** An entry naming a file, a flag or a workflow is a claim about a
  moving target. Say when it was verified.
- **Correct, do not accumulate.** When an entry turns out to be wrong, fix it or delete it. Where
  the mistake itself is instructive, say what was wrong and why it looked right, and remove the
  superseded claim. Do not leave two readings alive.
- **Write it where it binds.** If the thing you learned is really a decision, it belongs in an ADR,
  not here.

## Provenance

Seeded on 2026-09-20 from a coding agent's private memory store, which is where this knowledge had
accumulated until then. Entries carry their original dates where they had them.

The convention itself is being proposed for every project rather than just this one,
as issue 98 of the research-skills repository.
