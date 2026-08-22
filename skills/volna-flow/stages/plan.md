# Stage 4 · plan (expected)

Lay the work out over files so every edit is justified by a criterion. From planning on, the work is
no longer reading.

1. **Edits by file**: file, what changes, which acceptance criterion it closes. An edit that matches no
   criterion is either a criterion missed in `spec` or an edit not needed.
2. **Order and groups.** Independent groups can close in one `implement` iteration; dependent ones go
   one at a time so the advocate reviews a meaningful diff.
3. **What can break**: who else uses the affected code, which branches are touched, where regression is
   likely. This is the advocate's checklist.
4. **How to verify**: the test command from the profile (`тесты`), which tests appear or change, whether
   a browser check (`visual`) is needed.
5. **Branch**, if the project uses them: name and base. It is created in `implement` before the first
   edit and recorded in the journal field `branch`.

Pre-flight before implementation:

- working tree: any foreign uncommitted changes? The advocate compares against the base, and they would
  land in its report as yours. Say so and decide what to do with them;
- data and access needed are in place;
- no open question blocks the plan.

Stop and ask when: the plan needs edits in code whose purpose was not analysed; a choice between two
correct approaches with different consequences.

Done in the log: plan by file, order, risks, verification method, pre-flight result. Then
`volna_stage stage=implement`.
