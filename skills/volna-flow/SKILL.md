---
name: volna-flow
description: "Volna flow: run one task from a text assignment through analyze, spec, plan, implement with adversarial review, tests and an optional browser check to closing, keeping a work journal. Use when the user states a task, asks what is next, wants to move between stages, or when .volna/state.json holds an active task."
---

# Volna flow

Take one task from assignment to closing **in one context**, keeping a journal the task can be restored
from. The flow is the preferred order, not rails: the user decides.

Works only where the project part is deployed — `.volna/` in the repository root. No directory: say so in
one line, offer `/volna:init`, stop. Never create a journal in someone else's repository.

## Tools do the bookkeeping

| Need | Tool |
|---|---|
| accept an assignment | `volna_task` |
| enter a stage, open a new iteration, skip a stage | `volna_stage` |
| write the journal (log section, Status, open questions) | `volna_journal` |
| review your own changes | `volna_advocate` |
| check the web output in a browser | `volna_visual` |
| recall what was already done on the theme | `volna_recall` |
| route, check and rebuild the knowledge wiki | `volna_wiki` |
| run one part of the task in a subagent | `volna_part` |
| deliver: branch, commit, push | `volna_deliver` |
| close the task | `volna_finish` |

Never write journal markdown by hand: the tool sets the format, the iteration number and the timestamp.
The timestamp comes from the machine clock — the hours at closing are counted from it.

Each stage returns its own instructions through `volna_stage`; do not read `stages/*.md` yourself.

## Stages

| # | Stage | Level | About |
|---|---|---|---|
| 1 | `intake` | required | accept the assignment (text or file link), card, journal |
| 2 | `analyze` | expected | study the code, similar places, questions |
| 3 | `spec` | expected | statement in your own words, acceptance criteria |
| 4 | `plan` | expected | edits by file, order, risks |
| 5 | `implement` | expected | one iteration of edits |
| 6 | `advocate` | expected | adversarial review of the changes |
| 7 | `unit-tests` | expected | tests by project convention |
| 8 | `visual` | optional | browser, console errors, screenshot |
| 9 | `capture` | expected | extract the experience of the task into `.volna/wiki/` |
| 10 | `deliver` | expected | git: task branch, commit of the part, push |
| 11 | `close` | required | outcome and hours; of a part or of the whole task |

Levels: **required** is never skipped; **expected** is done by default and skipped only with a reason in
the journal; **optional** happens when there is a subject for it. A level is about skipping, not about
asking: what needs an explicit yes is listed under Autopass, and the list is short.

Delivery is git only and profile-driven (`доставка`, `ветка`, `база`, `удалённый`): `нет` means the stage
does not exist. Issue trackers and PRs are still outside the flow.

`implement` ⇄ `advocate` cycles until the verdict is clean. Any further code change is a new `implement`
iteration, and the advocate runs again after it — one passed review does not cover code changed later.

## Task in parts

Work that does not fit one run stays **one task, one journal, one branch**, split into parts: the cycle
`spec → plan → implement ⇄ advocate → unit-tests → visual → capture → close` runs once per part, with `/clear`
between them. No separate tasks and no separate plan file appear.

The list of parts lives in the `**части:**` subitem of Status — `volna_journal action=state`, field
`parts`, one line per part: `1. название - не начата | в работе | сделано (дата, часы) | снята (причина)`.
`part`/`parts` in the frontmatter are counted from that list by the code, and the list is carried over
untouched when `action=state` omits it: it is the source of truth about what is left.

Propose the split **with options** on `spec` when `analyze` showed several independent results, each with
its own «done when». The user decides — the split changes the order of work for days ahead.

- every stage of the cycle is about the **current part only**;
- part closed: `volna_finish part=true` — outcome and hours of the part into the journal, the part marked
  done, the task **stays active**, the branch stays, the hours keep accumulating. Then `/clear`, then
  `volna_task` with **no assignment**: it picks up this task and enters `spec` of the next part;
- last part done: `volna_finish` without `part` — outcome of the whole task, total hours, active task cleared;
- work abandoned mid-way is also a full close: name the remainder in `left`, unfinished parts are marked снята.

Delivery sits **inside** this cycle: `deliver` runs before every part's `close` — one branch per task, one
commit per part (more when the part needs them). The advocate's base is the commit the part started on,
written to the journal on the first `implement` iteration; closing a part clears it, so the next part sets
its own and the advocate never sees the previous part's work.

## Subagents

A subagent is legitimate **inside one stage**: go, read a lot, come back with a short conclusion. The signs
that it is: it only reads, writes nothing to the journal, commits nothing, crosses no stage boundary,
answers in a paragraph.

Work split into parts is **not handed out to subagents as branches of the flow**. The limit is not price
but construction: there is one journal (Status is rewritten, the log is append-only), `state.json` points
at one active task and the edit gate is held by it — parallel branches race on writing. The context between
parts is reset by `/clear`, which costs nothing.

`/volna:parts-run` runs the remaining parts **one at a time**: `volna_part` gives each its own `pi` process
with a clean context and write rights, and the run stops at the first question or blocker. The subagent is
a worker — Volna's extensions are off for it, so stages, the journal, the advocate, the tests and closing
the part stay with you. Preconditions are checked by the code: an active task, more than one unfinished
part, a journal that has not fallen behind. One part left — do it yourself: a subagent for it costs more
than the work.

## Autopass

Stages 2–11 run **as one chain in the same turn**, closing the task or the part at the end: a stage closes,
then `volna_stage` for the next one immediately, without waiting for a command. Write a line «stage X
closed, going to Y» as you go. **Carry the chain to the end while there is nothing to ask.** A stage done
and reported is not a checkpoint: reporting it and stopping there costs the user a turn and buys nothing —
the journal holds the same text, and an objection arrives just as well at the end.

The turn goes back to the user only when it must:

- a fork the flow does not resolve;
- a stop-criterion: ambiguous statement, missing data or access, divergence from the reference;
- the user themself is the source of the answer: a mockup to match, a decision that changes days of work;
- **push** — it is visible to other people and needs an explicit yes. The only mandatory yes in the flow;
- a part closed: `/clear` and the next `/volna:task` are the user's own commands.

Asking permission to continue is not on that list. Neither is a progress report, a proposed statement, a
plan, a diff, a screenshot or an outcome: show them as you pass, keep going, and let the user interrupt.

On long work a checkpoint is a step inside the chain, not a stop: rewrite Status (`volna_journal
action=state`) at a stage boundary. Context runs out before the chain reaches the end, and what was
written in an interrupted turn is lost entirely.

## Duties on every stage

1. **Log section at the end of the stage** (`action=log`). Without it the stage counts as unfinished.
2. **Status before handing the turn back** and at a checkpoint (`action=state`); once per chain is enough.
3. **Open questions** (`action=open`) — only what waits for the user or external data, not notes.
4. **A negative result is a record too**: «checked hypothesis X, did not hold, because…».
5. **References, not retelling**: file and lines, command, knowledge entry. The journal must be re-checkable.
6. **A secret the user says out loud** (token, password, connection string) goes into a file outside the
   repository, and only its path goes into settings. Never into the journal. Tell the user at once that the
   secret passed through session history and is worth rotating.

## Project profile

`## Профиль` in `.volna/project.md` says what the project consists of. Rule: **what the profile does not
list, the stage does not do** — silently, without a «skipped» record. A value in angle brackets means «not
asked yet»: stop and ask, never guess.

## Coming back to a task

After `/clear` or a restart the active task and its Status arrive on session start. Then `volna_stage` for
the current stage returns the instructions and context. Never read the log whole — it is opened by address
when Status points at it. Status beats the log: the log answers «how we got here», not «where things stand».

Journal format: skill `volna-journal`.
