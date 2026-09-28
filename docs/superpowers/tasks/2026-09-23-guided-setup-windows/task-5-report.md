status: DONE

## Branch taken: no-fix-needed

Task 4 flagged one axis ("chunk/echo/repaint order") as a *possible* divergence — the Windows
capture collapses several logical stages (unanswered echo, ctrl-U repaint, character-by-character
typing, verdict) that macOS's `typedOut()` shows as separate PTY chunks into fewer/single chunks —
and asked Task 5 to actually confirm, not assume, that no logic in `ui/setup-driver.js` implicitly
relies on multi-chunk typing.

### Investigation

Read `ui/setup-driver.js` in full, focusing on the mechanism Task 4 pointed at: the per-run dedup
state (`lastPromptSignature`/`lastPromptScreenText`/`signatureEligibleToClear`,
`lastAnsweredInput`/`answeredInputs`/`answeredOnce`) inside `runSetup()` (`ui/setup-driver.js:344-417`),
the re-ask/progress logic in `handleDetectedPrompt()` (`ui/setup-driver.js:419-704`), the idle-settle
timer `scheduleIdleCheck()` (`ui/setup-driver.js:726-765`), and `collectModelOptions()`
(`ui/setup-driver.js:148-210`). Confirmed structurally: every one of these re-derives its decision
from `detectPrompt(readScreen())` freshly on *every* chunk (`processChunk`, `ui/setup-driver.js:828-892`)
— there is no code path that counts chunks, expects a fixed number of redraws, or distinguishes
"this is chunk N of an expected sequence" from "this is chunk N of some other sequence length."
The guards key off screen *content* (question text, validation marker, default-hint presence,
answered-line length) and off *time* (`IDLE_MS` debounce), never off chunk arity. So collapsing
four logical stages into one or two PTY chunks changes only how many times `processChunk` runs
against intermediate states, not what any single run of it decides — nothing in the code that
Task 4's report pointed at has an implicit multi-chunk-typing assumption.

### Empirical verification

Replayed both of Task 4's fixtures through the real `startSetup()`/`detectPrompt()`, using the
same `fixture()`/`replay()` shape already established in `ui/test/setup-driver.test.mjs` (ad hoc
throwaway script at repo root, deleted before finishing — never committed, confirmed by
`git status --porcelain` showing only the pre-existing untracked
`docs/superpowers/tasks/2026-09-23-guided-setup-windows/` directory afterward).

**Fixture 1 — `windows-profile-name-correction`** (answers `['default', 'epmcdme-14982-capture-2784']`):
```
seen:   ["Enter a name for this profile: (codemie-sso)", "Enter a name for this profile: default"]
writes: ["default\r", "epmcdme-14982-capture-2784\r", "y\r"]
result: {"profileName":"epmcdme-14982-capture-2784"}
```

**Fixture 2 — `windows-activate-confirm`** (same answers, longer sequence through the activate confirm):
```
seen:   ["Enter a name for this profile: (codemie-sso)", "Enter a name for this profile: default"]
writes: ["default\r", "epmcdme-14982-capture-2784\r", "y\r"]
result: {"profileName":"epmcdme-14982-capture-2784"}
```

Both are exactly correct: two real onPrompt calls (the initial hinted open prompt, then the
rejected "default" re-ask — no phantom prompt from the collapsed echo/rejection chunk), the
re-answer correctly prefixed with ctrl-U (``, i.e. `ans()`'s `\x15`) even though the
collapsed chunk never showed an intermediate character-by-character typing stage, the `activate`
confirm auto-answered `y\r` with no third `onPrompt` call (fixed policy, as `AUTO_CONFIRM.activate`
intends), and `result.profileName` correctly set to the corrected name. This matches Task 4's own
informal sanity-check numbers exactly (`writes: ["default\r","epmcdme-14982-capture-2784\r","y\r"]`,
`result: {"profileName":"epmcdme-14982-capture-2784"}`), now confirmed as an actual run rather than
eyeballed.

### Conclusion

The driver already handles the collapsed-chunk shape correctly end-to-end. Task 4's reasoning was
right, and it is now independently verified rather than rubber-stamped: no divergence needing a
driver/parser fix exists. Per the plan's "If Task 4 found no divergence" branch, no test was added
and no code was changed — no throwaway test was committed either, per the task's own instruction
not to fabricate a change just to prove the point.

## Verification run (full suite, no changes made)

Command: `node --test ui/test/setup-driver.test.mjs > docs\superpowers\tasks\2026-09-23-guided-setup-windows\test.local.log 2>&1; echo "EXIT=$?"`

Final lines of the log:
```
1..69
# tests 69
# suites 0
# pass 69
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 8259.7327
```
`EXIT=0`.

## Files changed

None. `git status --porcelain` shows no tracked-file changes and no new untracked files beyond the
pre-existing `docs/superpowers/tasks/2026-09-23-guided-setup-windows/` directory. There is nothing
to commit for this task — the controller's ledger should record "no commit" / "no fix needed" for
Task 5, and Task 6 can proceed on the understanding that the shipped `ui/setup-driver.js` and
`ui/setup-parse.js` already match the Windows PTY contract with no changes required.
