---
name: volna-journal
description: "Volna journal format: TASK-<id>.md holds frontmatter and the rewritable Status section the task is restored from; logs/TASK-<id>.log.md is the append-only log of stage iterations. Use when writing the journal, making a checkpoint or restoring a task context."
---

# Volna journal

The journal is the single source of truth about a task. Invariant: the task can be restored from it from
scratch in a new session, with no leftover context.

| File | Layer | Editing |
|---|---|---|
| `.volna/journal/TASK-<id>.md` | frontmatter + `## Состояние · <date>` — the picture now | rewritten |
| `.volna/journal/logs/TASK-<id>.log.md` | `## <stage> · итерация N · <date>` — how we got here | **append-only** |

Two files, not two sections: `read` opens a whole file, and one careless return to a task would cost the
whole log. In the status file there is no log to read by accident.

**Coming back to a task means reading `TASK-<id>.md`, and nothing else.** It is one screen. The log is
opened by address when Status points at it. When the layers disagree, the upper one wins.

## Write with the tool, not by hand

| What | How |
|---|---|
| stage section in the log | `volna_journal action=log` |
| the whole Status | `volna_journal action=state` |
| open questions | `volna_journal action=open` |
| what breaks restoration | `volna_journal action=check` |

The tool sets the format, the iteration number and the timestamp. **The timestamp comes from the machine
clock**: the hours at closing are counted from it, and a model that estimates time («about five minutes
passed») sends the stamps into the future.

Journal content is written in Russian — it is a document for people.

## Log section fields

`what` and `done` are required; `left` is expected. `why` (which goal it closes), `why_chosen` (if there was
a choice), `how` (files, lines, commands), `need` (what is needed from outside), `knowledge` (which
knowledge entries were applied), `cancels` (which earlier conclusion no longer holds).

**Past sections are untouchable.** Re-entering a stage creates iteration N+1, never an edit of the old one.
If a new iteration cancels an earlier conclusion, `cancels` names the iteration — and the outcome of that
cancellation must reach Status, because nobody re-reads the log.

## Status fields

`goal`, `done`, `next` are required. `established` (settled facts), `decision` (chosen approach and why),
`rejected` (options with reasons), `careful` (limits in force now), `wiki` (knowledge candidates for stage `capture`).

`parts` appears only on a task split into parts (`volna-flow`, section «Task in parts»), and then it is the
**source of truth about what is left**: `volna_finish` reads it to decide whether it closes a part or the
task. One line per part, states `не начата` · `в работе` · `сделано (дата, часы)` · `снята (причина)`;
`part`/`parts` in the frontmatter are counted from it. Omitting the field on `action=state` keeps the list
as it was — it is never dropped by a rewrite.

**`rejected` is half the value of the section.** Without it the only way to learn that a path was already
tried is to read the whole log — which is exactly what Status exists to avoid.

The ceiling is about one screen. Grown too big — history goes to the log, «where things live» to knowledge.
`action=check` and the footer hints report the size and whether Status has fallen behind the log.

## Checkpoint

Before compaction and at a stage boundary of long work: `/volna:checkpoint` or `action=state` directly.
Four questions: can the task be restored from Status? did everything decided and rejected in this turn
reach it? is the current stage's log section written? are the open questions still open?

Volna cancels compaction when the journal has fallen behind, except on context overflow, where cancelling
would stop the work entirely.

## Identifier

`YYMMDD-<slug>`: start date plus 2–4 meaningful words in Latin letters, built by `volna_task` from the
title. It cannot be rebuilt later — the id is in the file name and in `state.json`. Words name the subject,
not the action: `260822-visual-console-errors` beats `260822-fix-bug`.

## Knowledge outlives the task

Journals are local; `.volna/wiki/` is committed and shared with the team. On stage `capture` the candidates
collected in the `wiki` field of Status become records — one record is one claim, with a locator carrying a
line number and a verbatim quote. Format, layout, indexes and the two routing calls: `references/wiki.md`.

## Not committed

`.volna/state.json`, `.volna/journal/`, `.volna/visual/` are local:
they are one person's work in one session. `.volna/project.md` and `.volna/wiki/` are committed — the
profile and the knowledge are shared.
