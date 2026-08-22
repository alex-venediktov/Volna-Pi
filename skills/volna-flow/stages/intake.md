# Stage 1 · intake (required)

`volna_task` already did the mechanics: built the id (`YYMMDD-slug`), created the journal, stored the
assignment verbatim in the log, set the task active.

Do now:

1. Check the title names the subject, not the action. A bad title cannot be renamed (it is in the file
   name) — say so and offer to start over with an explicit `title`.
2. Set `type` if it is not `task`: `bug`, `story`, `research`.
3. State the goal in one phrase: what changes for the user.
4. Call `volna_recall` with keywords from the assignment. The same work may sit in a past journal;
   a knowledge note may forbid the obvious path. Say out loud what you found or that nothing matched.

Stop and ask when: the result is not defined; the assignment holds several independent results (take
the first, the rest become separate tasks — this version has no task splitting).

Done: goal stated, type right, recall reported. Then `volna_stage stage=analyze`, same turn.
