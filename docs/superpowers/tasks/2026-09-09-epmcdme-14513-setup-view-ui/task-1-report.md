DONE

## Commit

`2d19992` — feat: setup-view module skeleton, storage row, one-shot round trip

## Files changed (`git show --stat HEAD`)

```
 ui/setup-view.js            | 200 ++++++++++++++++++++++++++++++++
 ui/test/setup-view.test.mjs | 272 ++++++++++++++++++++++++++++++++++++++++++++
 2 files changed, 472 insertions(+)
```

Only the two files this task declared. Nothing else staged/committed (a
pre-existing unstaged modification to `.codemie/codemie-cli.config.json` was
left untouched — not part of this commit).

## TDD evidence

RED (implementation temporarily moved aside, module missing):
```
mv ui/setup-view.js /tmp/setup-view.js.bak
node --test ui/test/setup-view.test.mjs > /tmp/epmcdme-14513-task1-red.log 2>&1; echo "EXIT=$?"; tail -30 ...
EXIT=1
...
code: 'ERR_MODULE_NOT_FOUND',
url: 'file:///.../ui/setup-view.js'
...
✖ ui/test/setup-view.test.mjs (68.51375ms)
ℹ tests 1
ℹ pass 0
ℹ fail 1
```

GREEN (implementation restored, one bug fixed along the way — see below):
```
node --test ui/test/setup-view.test.mjs > /tmp/epmcdme-14513-task1.log 2>&1; echo "EXIT=$?"; tail -25 /tmp/epmcdme-14513-task1.log
EXIT=0
✔ start() inserts a collapsed/COMPLETE storage row before startSetup runs (1.275291ms)
✔ gate and confirm-kind activate prompts never render a row (0.305041ms)
✔ list prompt: renders radio options, resolves with selected index, marks row COMPLETE (0.410958ms)
✔ input prompt: renders a text field, resolves with the typed string, marks row COMPLETE (0.253417ms)
✔ confirm prompt: Yes is pre-selected, resolves with a boolean, marks row COMPLETE (0.272583ms)
✔ confirm prompt: choosing No resolves with false (0.836292ms)
ℹ tests 6
ℹ pass 6
ℹ fail 0
```

Full suite sanity check (all pre-existing tests + the new file), unaffected:
```
node --test ui/test/*.test.mjs
EXIT=0
ℹ tests 133
ℹ pass 133
ℹ fail 0
```

## What was built

- `ui/setup-view.js`: `export function createSetupView(container, deps = {})` returning `{ start }`.
  - `start()`: binds the container via `stepsUi.renderSteps(container, [])`, inserts the bare `storage` row via `insertSubStep(null, {...})`, sets it `COMPLETE` with subtitle `"This computer"` — all before `deps.startSetup` (or its lazy default) is ever called. Wraps the `startSetup({ onPrompt, onLog: () => {} })` call in try/catch that swallows (Task 7's job to build on).
  - `onPrompt(prompt)`: for `gate`/`activate` (belt-and-suspenders per the plan's Global Constraint — the real driver never calls onPrompt for these), resolves immediately with a harmless default and renders nothing. For every other prompt, tracks a per-id occurrence counter (`Map`), inserts a row `${prompt.id}-${occurrence}` (always a fresh row this task — reopen/dedup logic is explicitly Task 2's), sets it `ACTIVE`, and renders a generic control keyed on `prompt.kind`:
    - `list`: one radio + label per `prompt.options` entry, no pre-selection, resolves the selected index (defaults to 0 if operator submits without choosing).
    - `input`: a text field, resolves the typed string.
    - `confirm`: Yes/No radios with Yes pre-selected (per the driver's own default hint `(Y/n)`), resolves a boolean.
  - On submit: `setStatus(rowId, 'COMPLETE')` + `setSubtitle(rowId, <human-readable text>)`, then resolves the prompt promise with the driver-expected shape.
  - `deps.startSetup` defaults to a lazy `import('./setup-driver.js')`; `deps.readConfig` defaults to a lazy `import('./runner-bridge.js')`'s `codemieConfig.read` — defined but intentionally never invoked in this task (Task 7's job), consistent with the file's own no-top-level-window-touching contract.
  - Statically imports `createStepsUi` (`./steps-ui.js`) and `StepStatus` (`./models.js`) — both window-free, so this stays safe.

- `ui/test/setup-view.test.mjs`: hand-rolled DOM stub adapted from `ui/test/steps-ui.test.mjs`'s (`makeEl`/`findByClass`), extended with a `children` getter (setup-view.js's row lookup walks `container.children` matching `dataset.id`, so it works unmodified against a real DOM too) and a readable `onclick` getter (the original stub only had a setter; these tests need to invoke the handler). Six tests, using the `setup-driver.test.mjs` injected-`deps` idiom: a fake `startSetup({ onPrompt, onLog })` that calls the real `onPrompt` inline rather than spawning anything.
  1. `start()` inserts the collapsed/COMPLETE storage row before the fake `startSetup` is invoked.
  2. `gate` and `activate` prompts (fed through a fake `onPrompt`) never produce a row.
  3. `list` prompt: radios rendered, selecting index 1 and submitting resolves with `1` and sets subtitle to the chosen option's label.
  4. `input` prompt: text field, submitting resolves with the typed string, subtitle echoes it.
  5. `confirm` prompt: Yes pre-selected, accepting the default resolves `true`, subtitle `"Yes"`.
  6. `confirm` prompt: explicitly choosing No resolves `false`, subtitle `"No"`.

## Bug found and fixed during the RED→GREEN cycle

Initial `renderListControl` wrapped each radio+label pair in a `.prompt-option`
div, so `control._children` held those wrapper divs rather than the radios
themselves — the "list prompt" test failed with `0 !== 3` on the radio count.
Fixed by appending each radio and its label span directly to the control
container (flat structure, matching how the confirm control was already
built), then re-ran to GREEN.

## Concerns

- Task 1's spec explicitly defers markup/copy refinement to Task 4 and reopen/dedup logic to Task 2 — the controls here are functional but plain (no CSS classes beyond bare `prompt-control`/`prompt-option-label`/`prompt-submit`/`prompt-input`; no styling in `ui/styles.css`, which I did not touch per the "don't touch" list). Later tasks are expected to build on this.
- `deps.readConfig`'s lazy-default wiring is present but deliberately unused (`void readConfig;`) in this task, per the task's own instruction that Task 7 owns calling it. Flagging in case a reviewer expects to see it exercised somewhere.
- I did not touch `ui/renderer.js` to actually mount `createSetupView` into the app — that wasn't in this task's file list and no interface for it was specified here.
