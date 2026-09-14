# Stage 6 · advocate (expected)

Refute your own solution, do not confirm it. The review runs in a separate read-only `pi` process with a
clean context: it never saw the code being written and judges the changes, not the intent.

1. Call `volna_advocate`. Optional: `base` (default: the commit this part started on, from the journal),
   `focus` — what to look at first (last iteration's findings, a specific branch, a risk from the plan),
   `batch_kb` and `minutes` — the size of one batch and the timeout of one run.
2. The changes come from `git diff` against that base. The tool reports the base and what the limits of
   that data are — read those notes: they say what the review could not see. **No git, no review**: the
   tool says so instead of checking the whole project. Then either set git up or skip the stage with a
   reason (`volna_stage action=skip`) — never call it passed silently.
3. **One call reviews one batch of the diff, not the whole change.** The answer says which files it took,
   how many are left and the verdict over everything reviewed so far. Files left plus verdict `чисто` means
   **call `volna_advocate` again in the same turn** — and again, until nothing is left. The result of every
   batch is kept on disk, so a run killed by a timeout costs one batch and not the review: call it again.
   Timed out twice on the same batch — lower `batch_kb` (default 48).
4. **The whole report goes into the journal.** Findings that are not in the journal do not exist a session
   later. One journal entry per stage iteration is enough: collect the batch reports into it, do not open a
   new iteration per batch.

One of three outcomes — for the review as a whole, once no files are left:

- **чисто** → go on to `unit-tests` in the same turn. Record what was checked; «проверено то и то» is
  verifiable, «всё хорошо» is not;
- **дефекты** → findings into the journal and immediately a new `implement` iteration
  (`volna_stage stage=implement`, `reason` = the findings). Fixing is the only continuation, no command
  needed. After the fix the advocate runs again — it is a cycle, not a single pass;
- **нужен человек** → stop and ask: how to close the finding is unclear, or the choice is between two
  correct behaviours.

Disagree with a finding? Write into the journal **why** it is not a defect, with a reference to code or
the statement. «The advocate is wrong» without a reason returns in the next iteration.

Typical mistakes: treating the stage as passed forever (code changed after it — it must run again);
running it on an empty tree; fixing quietly and not recording it; **calling the stage passed after one
batch** while files are still unreviewed.

Done in the log: iteration number, how many batches were run, verdict, findings (or an explicit
«расхождений не найдено, проверено то и то»), decision on the next step.
