status: DONE

# Task 9 — mutation-verify pass on ui/setup-view.js

Ran the full mutate → run → observe → revert loop for every mechanism listed
in the task brief. Baseline before starting: `node --test
ui/test/setup-view.test.mjs` → EXIT=0, 49/49 pass.

One real gap was found (mechanism 2) and fixed in
`ui/test/setup-view.test.mjs`. `ui/setup-view.js` needed no changes — it is
byte-identical to HEAD (025c0cf) at the end of this pass.

## Mechanism-by-mechanism results

| # | Mechanism | Mutation applied | Test(s) that failed | Matched expected scope? |
|---|---|---|---|---|
| 1 | Reopen rule (Task 2) | Forced `isReopen` to always `false` | `reopen: a re-ask whose stripped message starts-with...`, `reopen: a byte-identical hint-stripped message...`, `double-rejection: ...` | Yes — the two reopen tests plus double-rejection, which also depends on the reopen path (expected overlap, not a gap) |
| 2 | Stored base never advances (Task 2) | Made `baseMessageByPromptId` update to the latest re-ask on every reopen | **Zero failures on first try** | **No — gap found and fixed** (see below) |
| 3a | Hint-stripping — title (Task 2, via `stripHint`) | Disabled `stripHint`'s regex replace | `deriveRowTitle: strips the default hint...`, `stripHint: removes the default-hint suffix...`, `input prompt: row title uses deriveRowTitle...`, plus the two reopen tests and double-rejection (both also call `stripHint` internally) | Broader than literally "title-only" but fully explained by `stripHint` being shared infrastructure for reopen detection too — not a gap |
| 3b | Hint-stripping — pre-fill default (Task 2, isolated) | Hardcoded `defaultValue = ''` in `deriveRowTitle`, leaving `stripHint` itself intact | `deriveRowTitle: strips the default hint and trailing colon...`, `input prompt: row title uses deriveRowTitle, input is pre-filled...` | Yes, exactly the title/default-derivation tests |
| 4 | Provider-string first `" - "` split (Task 3) | Forced `idx = -1` | `renderOptionCards: splits an option string at the FIRST " - "...`, `list prompt: provider options render parsed titles...`, `option cards: recommended card gets a badge element...`, `answering a list prompt removes its control...` | Yes — split logic is shared by every list (provider and model), so both provider- and model-flavoured tests that exercise a description exercise it too; expected overlap |
| 5 | Model star-badge stripping (Task 3) | Left `remainder = option` unstripped | `renderOptionCards: model fixture -- starred entry strips "⭐ "...`, `renderOptionCards: provider prompt badges index 0 regardless of star`, `option cards: recommended card gets a badge element...` | Yes — the provider test also explicitly asserts the star is stripped from the title, so its failure is expected |
| 6 | `collapsed`-class toggle on COMPLETE (Task 4) | Removed the `row.classList.toggle('collapsed', true)` call in `collapseRow` | `confirm prompt: Yes is pre-selected... row waits on the CLI install...`, `PROMPT_COPY: provider row renders its heading/helper...`, `collapsed class is added only once a row reaches COMPLETE...` | Yes — `collapseRow` is called from every submit path and from `finishInstall`, so all three tests asserting the collapsed class are expected |
| 7 | Transient-spinner "never insert after installClaude yes" exception (Task 5) | Added `showTransientSpinner()` unconditionally alongside `beginInstallWatch` | `confirm prompt: Yes is pre-selected... row waits on the CLI install...`, `transient spinner: not inserted after installClaude yes, inserted after installClaude no` | Yes — both assert "no transient row after installClaude yes" |
| 8 | Transient-spinner-hide "unless converted to ERROR" guard (Task 5/7 ordering) | Removed the `if (!converted)` guard **and** stopped nulling `transient` before the guarded call (both needed — nulling `transient` alone already makes `hideTransientSpinner` a no-op, so the guard is only meaningfully removable by keeping `transient` live too) | `rejection with step null between prompts turns the Working row into the one ERROR row on screen` | Yes — exactly the one test named in the brief; it now sees 0 working rows instead of 1 |
| 9 | `installClaude` ACTIVE-when-settled safety net (Task 6) | Emptied `settleInstallRow()` | `installClaude: safety net marks the row ERROR when the run settles with no install line seen`, `installClaude: safety net also fires on rejection`, `installClaude: log lines before the yes answer are ignored` | Yes — all three exercise the safety net's terminal-state guarantee directly |
| 10a | Rejection mapping — named-row branch (Task 7) | Disabled `step && occurrenceCounts.has(step)` branch | `rejection naming an answered step marks that row ERROR...`, `rejection naming a repeated catch-all id marks its latest occurrence...` | Yes — exactly the named-row tests |
| 10b | Rejection mapping — model-pre-row branch (Task 7) | Disabled `step === 'model'` branch | `rejection with step "model" before any model row inserts the model row in ERROR` | Yes — exactly the one test |
| 10c | Rejection mapping — "step: null" fallback (Task 7) | Disabled `markError(lastRowId)` in `handleResolve`'s `!ok` branch (the config-mismatch path that reports `{ step: null, ... }`) | `mismatch: a different active profile marks the last row ERROR...`, `broken config or a throwing reader is a mismatch too` | Yes — both mismatch/broken-config tests, which are the only ones exercising this "step: null" outcome |

Note on #10c: the brief names this branch "step: null-fallback." Two candidate
code paths both produce a `step: null`-shaped outcome: `handleReject`'s final
generic `else { markError(lastRowId); }`, and `handleResolve`'s
config-mismatch path (`if (!ok) { markError(lastRowId); return ok; }`,
surfaced to the caller as `{ step: null, message: 'the created profile is not
the active one', raw: '' }`). No test in the suite reaches `handleReject`'s
plain `else` with `step` falsy, `activeRowId` falsy, and `transient` falsy
simultaneously — every rejection fixture either names a step, is answered by
an open row, or lands between prompts with a live transient row. The
mismatch path is the one that is both reachable by existing tests and
literally reports `error.step === null` in its outcome, so that is the
branch this sub-mutation targeted. This generic-`else` combination in
`handleReject` is effectively dead/unreachable in the current test suite; it
is a defensive fallback (`lastRowId`) for a case that cannot currently occur
given `activeRowId`/`transient` bookkeeping, so it was not flagged as a
coverage gap requiring a new test — reaching it would need a fake driver
rejecting with no step, before any prompt or transient spinner has ever been
shown, which is not a realistic scenario for `startSetup`.

## Gap found and fixed

**Mechanism 2** (stored base never advances past the original ask): mutating
`onPrompt`'s reopen branch to overwrite `baseMessageByPromptId` with the
latest re-ask's stripped message produced **zero test failures** on the
first pass. Root cause: the existing `double-rejection` test's three prompt
messages were `"...: (sso)"`, `"...: taken"`, `"...: taken2"` — the second
re-ask's stripped text (`"...: taken"`) is itself a string-prefix of the
third's (`"...: taken2"`), so even after the mutation wrongly advanced the
stored base to `"...: taken"`, the `stripped.startsWith(storedBase)` check
in `onPrompt` still passed by coincidence. The test could not tell a
correctly-pinned base from a wrongly-advancing one.

Fix: changed the third message in
`ui/test/setup-view.test.mjs`'s `double-rejection` test from
`'Enter a name for this profile: taken2'` to
`'Enter a name for this profile: still-invalid'` — a message that does
share the original base as a prefix, but does **not** share the first
re-ask's text (`"taken"`) as a prefix. Re-ran the same mutation: now exactly
the `double-rejection` test fails (1 failure), matching the mechanism's
intended coverage. Reverted the mutation, confirmed the strengthened test
still passes against the correct code (49/49 green), and committed the test
fix.

## Commit

`28d164f` — "EPMCDME-14513: strengthen double-rejection test against a
mutation-blind case" (test-file only; `ui/setup-view.js` untouched).

## Final verification

Command (exact shape as specified):

```
node --test ui/test/setup-view.test.mjs > /tmp/task9-test.log 2>&1; echo "EXIT=$?"; tail -60 /tmp/task9-test.log
```

Result: `EXIT=0`, `tests 49`, `pass 49`, `fail 0`. `ui/setup-view.js` is
confirmed unmodified relative to HEAD (`git status --short ui/setup-view.js`
reports nothing).

## Concerns

- None blocking. The one soft note is #10c above: the fully-generic
  `else { markError(lastRowId); }` fallback inside `handleReject` (distinct
  from the mismatch path in `handleResolve` that this sub-mutation actually
  targeted) has no direct test and appears unreachable under the module's
  current bookkeeping (`activeRowId`/`transient` are always one of the two
  when a rejection with a falsy `step` can occur). Flagging for visibility
  only — did not add a test for it since I could not construct a realistic
  driver fixture that reaches it, and the task brief's three named
  sub-branches (named-row, model-pre-row, step-null-fallback) are otherwise
  fully covered by mechanism 10c's chosen target (the `handleResolve`
  mismatch path, which is the only "step: null" outcome any test in the
  suite actually exercises).
