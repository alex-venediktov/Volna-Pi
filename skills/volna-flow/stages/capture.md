# Stage 9 · capture (expected)

Turn what this task taught into knowledge that outlives it. Journals are local and are not committed;
`.volna/wiki/` is committed and shared with the team.

**The stage stands before `deliver` for that reason**: a record written before the commit travels in the
same commit as the work. Written after delivery it usually is not written at all — closing takes the
context with it. This stage does not finish the work: outcome, hours and clearing the active task are
`close`.

No `.volna/wiki/` in the project — say so in one line, offer `/volna:init`, and move on. Nothing is
created behind the user's back.

## What to do

1. **Start from Status** (`journal/TASK-<id>.md`): the `**в вики:**` subitem is the list of candidates
   collected during the task, `**отвергнуто:**` holds the disproved hypotheses. Read the log
   (`logs/TASK-<id>.log.md`) after that and **by address** (grep for `**почему:**`, `**отменяет:**`), not
   whole. Keep what will be useful in **another** task:
   - a technique that worked;
   - a trap and its early sign («the value does not match — first check which reference build is open»);
   - a property of the reference or the infrastructure (encodings, dumper behaviour, fixture format);
   - a disproved hypothesis — so nobody checks it again.
2. **Drop** the circumstances of this order, the correspondence, numbers and statuses — everything that
   means something only inside this task.
3. **Write it impersonally, as a conclusion.** One record is one claim.
   - **the heading is a claim, not a topic.** «Form 99 does not load steps», not «Stepped laminate». What
     exactly is true must be clear before the record is opened;
   - required fields: `**тип:**` from the closed list of `SCHEMA.md`, `**предмет:**` in two to four words,
     `**этапы:**` (where the record will be useful) and `**вывод:**`. The type is what keeps a record from
     sliding into a retelling: if no type fits, it is probably not a conclusion;
   - **a claim about behaviour rests on a locator with a line number and a verbatim quote**:
     `` - `path/file.ts:120` — `the exact line` ``. The quote must occur in the source literally — that is
     what `/volna:wiki-verify` checks. A retelling is not a locator. In a code section the source is
     mandatory. **Take the line number from grep, not from memory**;
   - the file lies **flat in the section root**, the node lives in its name through a dash:
     `.volna/wiki/<section>/<node>-<slug>.md`. No node subdirectory. A new node goes into `topics` of
     `SCHEMA.md`, otherwise it is not recognised in the name and never becomes a level;
   - sections: `process` for ways of working, `project` for knowledge about the product, `reference` for
     the reference implementation;
   - where it belongs — `volna_wiki action=place query="<the text of the record>"`: it answers with a node
     of the existing tree or proposes a new one. Guessing a node by hand grows the tree at random.
4. **A defect that passed through the checks is type `постмортем`, not an ordinary conclusion.** It answers
   «why did the **process** let it through», not «how is it built». All three signs at once: the mechanism
   is non-obvious, the cause is systemic (a hole in a check, in a rule, or in where the rule lives), and
   finding it out again is expensive. Same fields plus the **mandatory** `**страховка:**` — what catches
   this class now: a test, a line in a stage file, a lint code. Without it the record stays a story, and
   stories live in the task log and are never re-read (`K024`).
5. Tell apart the two types that are easy to confuse: **`конфликт`** means one of the sides is wrong and the
   record must reach an outcome; **`расхождение`** means both sides are alive and each is right in its own
   area — then no resolution is needed, but `**область:**` is.
6. Already a record about this → refine the existing one instead of creating a second. A record that grew
   past the threshold is split in two, not extended.
7. **Rebuild the indexes** — `volna_wiki action=index fix=true`. Indexes are never edited by hand: they are
   assembled from the records and a manual edit is overwritten. The index exists so a stage reads its own
   file and opens the named records instead of the directory: knowledge accumulates, context does not.
8. **Check** — `volna_wiki action=lint` over the touched section, fix the findings here. Then
   `volna_wiki action=verify` over the **whole** wiki, not just the code section: an anchor that stopped
   matching is worse than a missing record, and anchors live in any section. Verify **after the last code
   change of the task** — your own edit shifts the anchors of your own records, and `lint` does not see it:
   the numbers stay plausible.

Nothing worth keeping? That is a legitimate outcome: say it in one line and go on to `deliver`. An invented
record costs more than no record — it will be read as knowledge.

Done in the log: which records appeared or were refined (by path), the index rebuild, the lint and verify
verdicts. Then `volna_stage stage=deliver`.
