# Stage 9 · deliver (expected)

Hand the work over: the task branch, a commit for this part, push. Everything here is visible to other
people, so nothing happens without the user's yes.

The profile decides what exists. `доставка: нет` or no such line — **the stage does not exist**: say so in
one line and go to `close`, without a «skipped» record. `commit` stops after the commit; `commit+push`
pushes too. Not a git repository — same thing: there is nothing to deliver into.

1. **Branch** — `volna_deliver action=branch`. One branch per task, created once from the profile pattern
   (`ветка`, `база`); on a split task the parts land in it one after another. The name is recorded in the
   journal by the tool.
2. **Look at what is going in**: `volna_deliver action=status` lists the changed files, the branch and what
   is not pushed yet. Foreign changes that are not yours must not ride along — name them and decide with the
   user, do not commit them silently.
3. **Commit** — `volna_deliver action=commit` with a message by the project convention (`## Конвенции` in
   `.volna/project.md`). One line, the subject of the change, no retelling of the diff. On a split task the
   message names the part. The advocate has already passed by this point: an unreviewed commit is a defect.
4. **Push** — `volna_deliver action=push`, only when the profile says `commit+push` and the user has said
   yes; the tool asks for confirmation itself where there is a UI.

Nothing to commit is a normal outcome: the work was reading, or the previous part already took it. Say it in
one line and move on.

Stop and ask when: the tree holds changes you did not make; the branch already exists with someone else's
commits; push is rejected (diverged upstream, no access) — a force push is never a decision the flow makes.

Done in the log: branch, commit hash and files, push result or why there was none. Then
`volna_stage stage=close`.
