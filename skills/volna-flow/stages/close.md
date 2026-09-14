# Stage 11 · close (required)

Record the outcome and the hours, then clear the active task. Level `required` means the stage is never
skipped, not that it waits to be told: reached with nothing to ask — close, in the same turn.

1. **Collect the outcome**: what changed for the user, which acceptance criteria are closed, what was
   verified (tests, advocate, browser check). The result, not a retelling of the work.
2. **Count the hours from the journal timestamps.** Section stamps come from the machine clock: the span
   between the first and the last, minus breaks, is the working time. Estimating by feel is exactly what
   the stamps exist to prevent.
3. **Check the remainder**: what is out of scope, what deserves a separate task. An unrecorded remainder is
   indistinguishable from a forgotten one a session later.
4. **State the outcome** in the turn, so it is read and not just filed. Asking for a yes to it is not
   needed: the closing is written down, and a task closed too early is reopened by `/volna:task` with no
   argument. Ask only when the outcome itself is in doubt — criteria left unclosed, a red test, a finding
   of the advocate answered by a promise rather than a fix.
5. **Call `volna_finish`** with the outcome and hours. It writes the `close` section, rewrites Status and
   clears the active task.
6. **Tidy up**: temporary files, diagnostic scripts, debug code. Advocate diffs and screenshots are local
   and need no cleaning.

**Split task.** A part is closed with `volna_finish part=true`: outcome and hours **of the part**, the part
marked done in the list, the task left active and the branch untouched — the hours are summed at the full
close. Last line of that turn: `/new`, then `/volna:task` with no argument, which enters `spec` of the
next part. The last part done — close the task the usual way, without `part`, with total hours. Dropping the
work mid-way is a full close too: the remainder goes into `left`, unfinished parts are marked снята.

Delivery happened on `deliver`. If the profile has no `доставка` line, commits are the user's own business —
Volna only warns when the current stage has no journal entry yet, and when work is left uncommitted or
unpushed at the full close.

No code was needed? `intake → analyze → close` is a legal path («no changes required»). No empty or fake
commit in that case, and the journal matters just as much: it holds the explanation.

Done: outcome and hours in the journal, Status rewritten, task cleared. Start the next one from a clean
context (`/new`, then `/volna:task`).
