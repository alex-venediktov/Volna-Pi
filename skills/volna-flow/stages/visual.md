# Stage 8 · visual (optional)

Look at the result. Tests check claims somebody thought to write; a picture shows what nobody thought of
— a blank screen, a console error, a scene where nothing got built.

**A picture is the whole stage.** Without one there is no visual check, and no amount of clean output
substitutes for it: a scene whose objects all ended up at the origin starts, logs nothing and exits 0,
exactly like a working one. «Launched without errors», «tests are green», «the file loads» are not
visual verdicts. Never write one from logs or an exit code.

The channel is the profile line `визуальная проверка`:

- `chrome-devtools` — a page in the browser driven by `pi-chrome-devtools`;
- any other text — a **project command** that renders the current state and prints the image path as its
  last stdout line (`tools/shot.sh` and the like);
- `нет` — no channel: the stage does nothing, and that is a hole, not a pass. Say so in one line, and if
  the part's criterion needs eyes, hand the turn to the user instead of closing it.

## What to do

1. **Start the app** with the profile command (`запуск`) when the channel is the browser. Already running?
   Do not start a second one — ask for the address.
2. **Call `volna_visual`.** Browser channel: the page URL, steps to reach the state in `steps` (`click`,
   `fill`, `press`, `waitfor`, `wait`, `scroll`, `goto`), `wait_for` to await an element, `reuse_page:
   true` for a tab set up by hand. Command channel: `argument` is appended to the profile command — the
   scene, the address, the state to render.
3. **Read the report.** The browser criterion is strict: console errors and page exceptions are red;
   4xx/5xx and failed requests are red; warnings are not a verdict but worth a look. The command channel
   has no automatic criterion — the picture is the evidence, so the next step is not optional.
4. **Say what is in the picture**, item by item against the criterion. Name what you see, not what should
   be there: which objects are present, where they are, what is lit, what is empty. A criterion asking for
   three guards on patrol is not met by a grey plane.
   - Profile `скриншот модели: да` hands the image to the model when the model can see images.
   - **A model that cannot see images says exactly that and stops.** Reporting a verdict on an image you
     did not receive is the one failure this stage exists to prevent.
5. **Path into the journal** — the report has it. Waiting for a verdict on the picture is not a stage
   boundary: state what you see and go on. Hand the turn back only when the answer is the user's alone —
   a mockup to match, or a picture that contradicts the criteria in a way the code does not explain.
6. **Red result or a picture that fails the criterion** → findings into the journal and a new `implement`
   iteration with that reason.

This does not replace tests: one green scenario says nothing about the branches it did not touch. And
tests do not replace this: they exercise components that were added to the tree correctly, which is
precisely what a broken scene does not do.

Done in the log: the channel, what was rendered, the automation verdict where there is one, the image
path, what the picture shows against the criterion, the user's verdict if given. Then
`volna_stage stage=capture`.
