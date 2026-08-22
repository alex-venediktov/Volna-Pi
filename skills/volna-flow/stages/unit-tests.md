# Stage 7 · unit-tests (expected)

Close the acceptance criteria with checks that stay in the project and fail when the behaviour breaks again.

1. **Take the criteria from `spec`** and turn each into a test. A criterion without a test is a claim on
   trust.
2. **Look at the neighbouring tests**: names, structure, how data is prepared. Project conventions beat
   general habits; your own style inside someone else's suite is noise in every future review.
3. **The test name is a claim about behaviour**, not `test1`. The reader should know what broke from the
   name of the failing test alone.
4. **Edge cases from `analyze`**: empty input, range boundaries, early exits, the branches you studied. A
   happy-path-only test leaves exactly the defects the advocate hunts.
5. **Run with the profile command** (`тесты`). Red tests are the stage's result: the finding goes into the
   journal and a new `implement` iteration opens with that reason.
6. **One-off diagnostic scaffolding is not committed.** Needed a script to understand something? It stays
   outside the repository; its output goes into the journal.

Never fit a test to the current behaviour. A test written to be green is worse than no test: it fixes the
defect as the norm.

Profile line `тесты: нет` — the project has no tests and the stage does nothing; that is an absent step,
not a skip. An unfilled line (`тесты: <команда>`) — ask the user how tests run.

Done in the log: which tests were added or changed (files), which criteria they close, run result. Then
`volna_stage stage=visual`, or straight to `close` with the reason if there is no visual output.
