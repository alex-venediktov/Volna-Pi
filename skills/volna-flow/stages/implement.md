# Stage 5 · implement (expected)

One iteration of edits from the plan, recorded so the next session understands why the code is like this.

Before the first iteration: create the branch if the project uses them (name it in the log, «как»); the
working tree is free of foreign changes (checked in `plan`).

1. Follow the plan, not inspiration. Deviating is fine — record what changed and why.
2. **Minimal edits, on subject.** No drive-by improvements, no reformatting of other people's code, no
   debug leftovers: the advocate will find them and there will be nothing to justify them with.
3. **Comments by project convention** — if the project has its own format, it wins over habits. No task
   numbers, no iteration history, no description of the previous behaviour in comments.
4. **Reference implementation**, if the profile names one: every number and condition comes from a
   concrete reference line, and the reference goes into the log. A value absent from the reference is
   either a mistake or a stop — never «looks right».
5. Tests and build run with the profile command. A red result is the stage's result, not something to hide.

Re-entering `implement` opens iteration N+1: pass `reason` (advocate finding, red test, user verdict on
the browser check). Past log sections are never rewritten. If an earlier conclusion no longer holds, add
`cancels` with the iteration it overrides.

Stop and ask when: the edit needs a decision that is in neither the plan nor the statement; behaviour
someone else relies on must change and the consequences are unclear.

Done in the log: what was done, which files and lines, why this way, what is left, test and build results
if run. Then the advocate is mandatory: `volna_stage stage=advocate`, same turn, without waiting to be told.
