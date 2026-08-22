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
| 9 | `close` | required | outcome and hours; of a part or of the whole task |

Levels: **required** needs a decision from the user; **expected** is done by default and skipped only with
a reason in the journal; **optional** happens when there is a subject for it.

No delivery in this version: commit, push, PR and issue trackers are outside the flow.

`implement` ⇄ `advocate` cycles until the verdict is clean. Any further code change is a new `implement`
iteration, and the advocate runs again after it — one passed review does not cover code changed later.

## Task in parts

Work that does not fit one run stays **one task, one journal, one branch**, split into parts: the cycle
`spec → plan → implement ⇄ advocate → unit-tests → visual → close` runs once per part, with `/clear`
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

Delivery is reserved, not absent by design: when a `deliver` stage appears it sits **inside** this cycle —
one branch per task, one commit per part (more when the part needs them), one PR that gets amended.
Committing a part shifts the advocate's base by itself; where there is no version control, closing a part
re-takes the tree snapshot for the same reason.

## Autopass

Stages 2–8 run **as one chain in the same turn**: a stage closes, then `volna_stage` for the next one
immediately, without waiting for a command. Write a line «stage X closed, going to Y» as you go.

The turn goes back to the user only when it must:

- a fork the flow does not resolve;
- a stop-criterion: ambiguous statement, missing data or access, divergence from the reference;
- the user themself is needed: a verdict on a picture, an answer from `spec`, a look at the changes;
- the `close` boundary — the user starts closing.

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
