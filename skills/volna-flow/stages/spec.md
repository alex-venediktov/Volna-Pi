# Stage 3 · spec (expected)

Retell the assignment in your own words and get it confirmed. A misunderstanding is cheapest to fix here.

Write:

1. **The statement**, 3–6 lines: what changes for the user and why it is needed. Not a paraphrase of
   the assignment — its meaning.
2. **Acceptance criteria** — checkable claims. «Works correctly» is not one; «empty list shows the
   placeholder and makes no server request» is. The advocate checks the diff against these, and tests
   turn them into assertions.
3. **Out of scope** — an explicit boundary stops the work from creeping.
4. **Divergences and questions**: what contradicts the code, what is missing. Anything that blocks
   planning goes to `volna_journal action=open` — and that is when the turn goes back to the user.

Ask with options when you must ask: the first option is the one the flow or the code implies. No
blocking question — continue in the same turn without asking permission.

Stop and ask when: criteria cannot be written because the expected behaviour is unknown; the assignment
demands behaviour that contradicts existing correct behaviour.

Done in the log: statement, criteria, scope boundary, open questions (or an explicit «none»). Then
`volna_stage stage=plan`.
