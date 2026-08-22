# Stage 10 · close (required)

Record the outcome and the hours, then clear the active task. Level `required`: the user starts this stage
and the closing itself needs their explicit yes.

1. **Collect the outcome**: what changed for the user, which acceptance criteria are closed, what was
   verified (tests, advocate, browser check). The result, not a retelling of the work.
2. **Count the hours from the journal timestamps.** Section stamps come from the machine clock: the span
   between the first and the last, minus breaks, is the working time. Estimating by feel is exactly what
   the stamps exist to prevent.
3. **Check the remainder**: what is out of scope, what deserves a separate task. An unrecorded remainder is
   indistinguishable from a forgotten one a session later.
4. **Show the outcome to the user and get a yes.** This is the only irreversible action here: after it the
   active task is cleared and the header and gates stop working for it.
5. **Call `volna_finish`** with the outcome and hours. It writes the `close` section, rewrites Status and
   clears the active task.
6. **Tidy up**: temporary files, diagnostic scripts, debug code. Advocate diffs, snapshots and screenshots
   in `.volna/` are local and need no cleaning.

**Split task.** A part is closed with `volna_finish part=true`: outcome and hours **of the part**, the part
marked done in the list, the task left active and the branch untouched — the hours are summed at the full
close. Last line of that turn: `/clear`, then `/volna:task` with no argument, which enters `spec` of the
next part. The last part done — close the task the usual way, without `part`, with total hours. Dropping the
work mid-way is a full close too: the remainder goes into `left`, unfinished parts are marked снята.

Delivery happened on `deliver`. If the profile has no `доставка` line, commits are the user's own business —
Volna only warns when the current stage has no journal entry yet, and when work is left uncommitted or
unpushed at the full close.

No code was needed? `intake → analyze → close` is a legal path («no changes required»). No empty or fake
commit in that case, and the journal matters just as much: it holds the explanation.

Done: outcome and hours in the journal, Status rewritten, task cleared. Start the next one from a clean
context (`/new` or `/clear`, then `/volna:task`).
