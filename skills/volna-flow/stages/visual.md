# Stage 8 · visual (optional)

Look at the result. Tests check claims somebody thought to write; the browser shows what nobody thought
of — a blank screen, a console error, a failed request.

The stage exists when the work is visible in a browser and the profile says `визуальная проверка:
chrome-devtools`. `нет` or no web output — the stage does nothing.

1. **Start the app** with the profile command (`запуск`). Already running? Do not start a second one — ask
   for the address.
2. **Call `volna_visual`** with the page URL. It runs in the browser managed by `pi-chrome-devtools`. If the
   browser is down, the tool says so: start it with `chrome_devtools_navigate` and call `volna_visual`
   again. Steps to reach the state go in `steps` (`click`, `fill`, `press`, `waitfor`, `wait`, `scroll`,
   `goto`); to await an element use `wait_for`. State set up by hand in an open tab — `reuse_page: true`.
3. **Read the report.** The automatic criterion is strict: console errors and page exceptions are red;
   4xx/5xx and failed requests are red; console warnings are not a verdict but worth a look.
4. **Show the screenshot to the user** — the path is in the report. Matching the mockup and «does this look
   like what was asked» is the user's verdict, not the automation's. Profile `скриншот модели: да` also
   hands the image to the model when the model can see images.
5. **Red result** → findings into the journal and a new `implement` iteration with that reason.

This does not replace tests: one green browser scenario says nothing about the branches it did not touch.

Done in the log: what was opened and with which steps, the automation verdict, the screenshot path, the
user's verdict if given. Then `volna_stage stage=deliver`.
