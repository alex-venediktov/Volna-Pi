# Stage 3 · spec (expected)

Retell the assignment in your own words. A misunderstanding is cheapest to fix here — so state it out loud
and move on: the statement stays in the journal, and the user objects to it just as well from `plan`.

Write:

1. **The statement**, 3–6 lines: what changes for the user and why it is needed. Not a paraphrase of
   the assignment — its meaning.
2. **Acceptance criteria** — checkable claims. «Works correctly» is not one; «empty list shows the
   placeholder and makes no server request» is. The advocate checks the diff against these, and tests
   turn them into assertions.
3. **Out of scope** — an explicit boundary stops the work from creeping.
4. **Divergences and questions**: what contradicts the code, what is missing. Anything that blocks
   planning goes to `volna_journal action=open` — and that is when the turn goes back to the user.

**Parts.** `analyze` showed several independent results, each with its own «done when» — offer the split
**with options** (one task in one run · one task in N parts), the user decides. The task stays one, with
one journal and one branch. Already split: this stage is the statement and the criteria of the **current
part**, not of the whole task.

Agreed on a split, write it in **two places** — both are load-bearing:

1. The list of parts, with `volna_journal action=state`, field `parts`: one line per part, name and status
   only («1. схема хранения - не начата»). That is the state of the remainder, and it is rewritten as the
   work goes.
2. The **statement of each part**, in this stage's log entry (`volna_journal action=log`, `stage=spec`),
   field `части`, in exactly this form — this is what `volna_part` reads when it hands a part to a subagent:

```
- **части:**
  1. <name of the part, the same as in the list>
     готово, когда: <checkable condition: a command and its result, a behaviour, a test>
     трогает: <files and directories>
     не трогает: <the boundary>
     зависит от: <нет | часть N>
  2. ...
```

Numbers are positions in the list: part 2 of the list is part 2 here. `готово, когда` is mandatory — a part
without it cannot be handed to anyone, neither a subagent nor a person tomorrow, and `volna_part` refuses.
Do not invent the condition: not stated anywhere — ask. Restating a part later means a new `spec` iteration
with the same field; the later entry wins.

Incoming assignments sometimes already carry the split. Then reuse it: keep the names, copy each «done
when» verbatim into the form above, and say what you had to add — an assignment's wording is the user's,
and silently sharpening it is how the statement drifts.

Ask with options when you must ask: the first option is the one the flow or the code implies. Nothing to
ask — do not ask for approval of the statement either: continue to `plan` in the same turn.

Stop and ask when: criteria cannot be written because the expected behaviour is unknown; the assignment
demands behaviour that contradicts existing correct behaviour.

Done in the log: statement, criteria, scope boundary, open questions (or an explicit «none»); on a split
task also the list of parts and the `части` field with a statement per part. Then `volna_stage stage=plan`.
