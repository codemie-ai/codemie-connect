DONE

# Task 2: Row title/default derivation, occurrence naming, reopen-vs-new-row

## Commit

SHA: `47926b5a5c086388306c63dfe86a2b786366209e`

```
commit 47926b5a5c086388306c63dfe86a2b786366209e

    feat: setup-view row title derivation and reopen-vs-new-row logic

 ui/setup-view.js            | 113 ++++++++++++++++++++----
 ui/test/setup-view.test.mjs | 203 +++++++++++++++++++++++++++++++++++++++++++-
 2 files changed, 297 insertions(+), 19 deletions(-)
```

`git show --stat HEAD` confirms only `ui/setup-view.js` and `ui/test/setup-view.test.mjs` were touched.

## What was implemented

In `ui/setup-view.js`:
- `DEFAULT_HINT` regex re-declared locally (`/\s*\([^()]*\)\s*$/`), independent of `setup-driver.js`.
- `stripHint(message)` (exported) — removes the trailing default-hint parenthetical, leaves the colon intact.
- `deriveRowTitle(message)` (exported) — returns `{ title, defaultValue }`: strips the hint (captured as `defaultValue`, empty if absent), then strips a trailing colon from the remainder to produce `title`.
- `baseMessageByPromptId: Map<id, string>` — module-instance state alongside `occurrenceCounts`, holding the hint-stripped, original-ask message per prompt id.
- `onPrompt(prompt)` now branches on `isReopen = storedBase !== undefined && (stripped === storedBase || stripped.startsWith(storedBase))`:
  - Reopen: reuses the latest occurrence row id (via new `latestOccurrenceRowId`), clears the row's `.step-sub` textContent directly (bypassing `setSubtitle`), sets status back to `ACTIVE`, removes old `.prompt-control` children from the host (`clearControls`), rebuilds the control against the same `rowId`. `baseMessageByPromptId` is left untouched in this branch.
  - New occurrence: unchanged Task-1 behavior (`nextOccurrence` + new row), plus `baseMessageByPromptId.set(prompt.id, stripped)`.
- `renderInputControl` now pre-fills the text input with `deriveRowTitle(prompt.message).defaultValue` when non-empty.
- New row titles for `input`-kind prompts use `deriveRowTitle(prompt.message).title` instead of the raw message (via new `rowTitleFor` helper); non-input kinds keep the raw-message behavior from Task 1.
- Shared `renderControl` helper factors out the submit/control-dispatch logic previously inline in `onPrompt`, reused by both the reopen and new-occurrence paths so there is exactly one place building the `list`/`input`/`confirm` control.

In `ui/test/setup-view.test.mjs`:
- Added `deriveRowTitle`/`stripHint` to the imported names.
- Added 9 new `test(...)` blocks (all existing 6 Task-1 tests preserved verbatim):
  - `deriveRowTitle` hint+colon case and hint-less case.
  - `stripHint` hint-removal cases (matching the plan's worked example).
  - Reopen via `startsWith` (real driver strings: `"... (sso)"` then `"... taken"`).
  - Reopen via byte-identical stripped message (masked-password case).
  - New-occurrence case: same id, non-prefix different message → new row.
  - Double-rejection case: asserts the stored base is never advanced past the original ask and only one row exists after two rejections.
  - Input-control wiring: row title uses `deriveRowTitle`, input pre-filled with parsed default.

## Test run

Command:
```
node --test ui/test/setup-view.test.mjs > /tmp/epmcdme-14513-task2.log 2>&1; echo "EXIT=$?"; tail -30 /tmp/epmcdme-14513-task2.log
```

Before implementation (failing as expected — `deriveRowTitle`/`stripHint` undefined, reopen not implemented): `EXIT=1`, failures on missing-export usage and on the wired-title assertion (`'CodeMie organization URL: (https://codemie.lab.epam.com)'` vs expected `'CodeMie organization URL'`).

After implementation:
```
EXIT=0
✔ start() inserts a collapsed/COMPLETE storage row before startSetup runs (1.200042ms)
✔ gate and confirm-kind activate prompts never render a row (0.387666ms)
✔ list prompt: renders radio options, resolves with selected index, marks row COMPLETE (0.417542ms)
✔ input prompt: renders a text field, resolves with the typed string, marks row COMPLETE (0.358042ms)
✔ confirm prompt: Yes is pre-selected, resolves with a boolean, marks row COMPLETE (0.764875ms)
✔ confirm prompt: choosing No resolves with false (0.22775ms)
✔ deriveRowTitle: strips the default hint and trailing colon, hint becomes defaultValue (0.4625ms)
✔ deriveRowTitle: a hint-less message strips only the trailing colon, empty defaultValue (0.064417ms)
✔ stripHint: removes the default-hint suffix but leaves the colon intact (0.072917ms)
✔ reopen: a re-ask whose stripped message starts-with the stored base reopens the same row (0.393958ms)
✔ reopen: a byte-identical hint-stripped message (masked-password re-ask) reopens the same row (0.245167ms)
✔ new occurrence: same id but a different (non-prefix) hint-stripped message inserts a new row (0.236417ms)
✔ double-rejection: the stored comparison base never advances past the original ask; exactly one row survives (0.240333ms)
✔ input prompt: row title uses deriveRowTitle, input is pre-filled with the parsed default (0.1665ms)
ℹ tests 14
ℹ pass 14
ℹ fail 0
```

Full suite re-run:
```
node --test ui/test/*.test.mjs > /tmp/epmcdme-14513-task2-full.log 2>&1; echo "EXIT=$?"
EXIT=0
ℹ tests 141
ℹ pass 141
ℹ fail 0
```

## Concerns

None. All 6 pre-existing Task-1 tests preserved unmodified; 9 new tests added; full 141-test suite (all `ui/test/*.test.mjs`) passes. Only the two files named in the task were staged and committed — a pre-existing unrelated local modification to `.codemie/codemie-cli.config.json` and the untracked `.codegraph/` directory were left alone, not staged.
