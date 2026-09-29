status: DONE

## Commit

`07588ea3b4b4ff72550e786a7126a026327ca199` — "EPMCDME-14982 : Add Windows real-stream tests for profile-name correction and activate confirm"

```
git show --stat HEAD
 ui/test/setup-driver.test.mjs | 22 ++++++++++++++++++++++
 1 file changed, 22 insertions(+)
```

Exactly one file changed, insertions only, no deletions — matches the constraint.

## What was added

Two new `test(...)` blocks in `ui/test/setup-driver.test.mjs`, inserted right after the existing
`'real stream: the same rejected name entered twice is asked a third time'` test and right before
`'real stream: a question-less chunk right after our answer does not make the driver forget the
answered question'`:

1. `'real stream (windows): a rejected profile name is re-asked once and the correction is
   accepted'` — loads `fixture('windows-profile-name-correction')`, replays with answers
   `['default', 'epmcdme-14982-capture-2784']`.
2. `'real stream (windows): the activate confirm is auto-answered after a corrected profile
   name'` — loads `fixture('windows-activate-confirm')`, same answers.

No new `fixturePath` helper was added — Step 3 was a no-op per the corrected instructions, since
the existing `fixture(id)` loader (`ui/test/setup-driver.test.mjs:30-32`) already does exactly
this.

## Actual seen/writes/result (from my own run, not hand-derived)

Both tests passed on the first run. My own replay produced:

```
seen:   ["Enter a name for this profile: (codemie-sso)", "Enter a name for this profile: default"]
writes: ["default\r", "epmcdme-14982-capture-2784\r", "y\r"]
result: {"profileName":"epmcdme-14982-capture-2784"}
```

This matches Task 5's independently-verified numbers exactly (same `seen`, same `writes`, same
`result`, for both fixtures). No discrepancy to explain — the driver code (untouched, per Task
5's conclusion) handles the collapsed Windows chunk shape correctly, so the assertions written
from the ground-truth values in Task 5's report were correct on the first try. The writes array
uses `ans('epmcdme-14982-capture-2784')` (i.e. `\x15epmcdme-14982-capture-2784\r`) for the
corrected name, and the second test additionally asserts `writes.slice(-1)` equals `['y\r']` for
the auto-answered activate confirm.

## Test run

Command: `node --test ui/test/setup-driver.test.mjs > docs\superpowers\tasks\2026-09-23-guided-setup-windows\test.local.log 2>&1; echo "EXIT=$?"`

Tail of the log:
```
1..71
# tests 71
# suites 0
# pass 71
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 8473.5917
```
`EXIT=0`.

Total test count is 71 — exactly 2 higher than Task 5's reported baseline of 69, confirming no
existing test was touched and both new tests are counted.

## Constraints respected

- No changes to `ui/setup-driver.js`, `ui/setup-parse.js`, `ui/handlers.js`, `config/steps-windows.yaml`, or anything under `src-tauri/`.
- No existing test or fixture file modified — only two new `test(...)` blocks added.
- Did not run the four-gate suite or touch `.superpowers/`, `state.local.json`, `decisions.jsonl`, `events.jsonl`.
- No merge, push, or PR opened.
