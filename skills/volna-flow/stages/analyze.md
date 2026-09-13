# Stage 2 · analyze (expected)

Understand the subject from the code, not from assumptions. Output: where the affected behaviour
lives, what influences it, what the assignment does not say.

1. `volna_recall` first — a past journal on the same theme saves the whole stage.
2. `volna_wiki action=route query="<words of the task>"` — which index of the wiki to open. A route is
   cheaper than a walk: open the named node, not the section, and never the whole directory.
3. Find the places by search (`grep`, `find`), not by reading whole files: one careless full read of a
   large file costs more than this stage. Read only the lines the search points at.
4. Look at how a similar case is already solved nearby — that is where project conventions really are.
5. Check the edges: who else calls the affected code, which branches exist, which early exits and
   boundary cases are there.
6. Reference implementation, if the profile names one (`эталон`): find the matching code and note exact
   line references. Porting is 1:1, no heuristics, no fitting to the desired result; a divergence from
   the reference is a stop, not a guess.
7. Write down the questions neither the assignment nor the code answers — they become open questions
   (`volna_journal action=open`) and material for `spec`.

No code edits here — the gate blocks them. Need a probe? That is `implement` with an explicit reason.

Stop and ask when: the behaviour is nowhere in the code; the assignment contradicts what the code does.

Done in the log: what you searched and how, files and lines, similar places, remaining questions, what
recall gave (including «nothing on this theme»). Then `volna_stage stage=spec`.
