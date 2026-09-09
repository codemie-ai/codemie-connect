DONE

## Commit

SHA: `403ff7bea678dd8902585b2536a296413f71d24f`
Subject: `EPMCDME-14513: setup-view option-card string parsing (renderOptionCards)`

```
$ git show --stat HEAD
commit 403ff7bea678dd8902585b2536a296413f71d24f
Author: Mert <mert_efe@epam.com>
Date:   Wed Sep 9 19:46:01 2026 +0300

    EPMCDME-14513: setup-view option-card string parsing (renderOptionCards)

 ui/setup-view.js            | 41 ++++++++++++++++++++++--
 ui/test/setup-view.test.mjs | 76 ++++++++++++++++++++++++++++++++++++++++++++-
 2 files changed, 114 insertions(+), 3 deletions(-)
```

Only `ui/setup-view.js` and `ui/test/setup-view.test.mjs` are touched — confirmed via `git show --stat HEAD` above.

## What was done

1. Read `ui/setup-view.js` and `ui/test/setup-view.test.mjs` in full (post Tasks 1-2 state).
2. Read `ui/test/fixtures/setup/model.json` and `ui/setup-parse.js`'s `parseOptions` to confirm the exact already-parsed strings this module receives: fixture line 16 `"❯ ⭐ claude-sonnet-5 "` → `"⭐ claude-sonnet-5"`, line 17 `"  claude-4-5-sonnet "` → `"claude-4-5-sonnet"`.
3. Added 6 new test blocks to `ui/test/setup-view.test.mjs` (test-first):
   - split at first `" - "` for the `"CodeMie SSO - Enterprise SSO Authentication..."` string
   - model fixture strings: starred entry → `title: 'claude-sonnet-5', recommended: true`; plain entry → `recommended: false`
   - `provider` case: `badgeIndex: 0` badges index 0 regardless of star
   - `model` case (no `badgeIndex`): badge follows star only, never index
   - no `" - "` separator → whole string is title, empty description
   - wiring test: a `provider`-id list prompt's rendered option labels reflect the parsed `title`, not the raw option string
   - Ran `node --test ui/test/setup-view.test.mjs`; confirmed FAIL (`renderOptionCards is not a function` / assertion failures on unparsed label text).
4. Implemented `renderOptionCards(options, { badgeIndex } = {})` in `ui/setup-view.js`:
   - strips leading `/^⭐\s*/`, remembers `starred`
   - splits the remainder at the first literal `" - "` via `indexOf` (not regex)
   - `recommended = index === badgeIndex` when `badgeIndex` is a number (provider case); else `recommended = starred` (model/default case)
   - exported it alongside the existing exports.
5. Wired it into `renderListControl`: calls `renderOptionCards(prompt.options, { badgeIndex: prompt.id === 'provider' ? 0 : undefined })`, uses the parsed `title` as the radio label's `textContent`, and threads `description`/`recommended` through as `dataset.description` / `dataset.recommended` on the label span (minimal wiring per the plan — Task 4 owns the real visual card markup).
6. Re-ran the test file: EXIT=0, 20/20 passing (14 pre-existing + 6 new).
7. Ran the full suite `node --test ui/test/*.test.mjs`: EXIT=0, 147/147 passing — nothing else broke.
8. Staged only the two target files and committed.

## Test commands + output

```
$ node --test ui/test/setup-view.test.mjs > /tmp/epmcdme-14513-task3.log 2>&1; echo "EXIT=$?"; tail -30 /tmp/epmcdme-14513-task3.log
EXIT=0
✔ start() inserts a collapsed/COMPLETE storage row before startSetup runs (1.241791ms)
✔ gate and confirm-kind activate prompts never render a row (0.304458ms)
✔ list prompt: renders radio options, resolves with selected index, marks row COMPLETE (0.527875ms)
✔ input prompt: renders a text field, resolves with the typed string, marks row COMPLETE (0.813334ms)
✔ confirm prompt: Yes is pre-selected, resolves with a boolean, marks row COMPLETE (0.2535ms)
✔ confirm prompt: choosing No resolves with false (0.200459ms)
✔ deriveRowTitle: strips the default hint and trailing colon, hint becomes defaultValue (0.447833ms)
✔ deriveRowTitle: a hint-less message strips only the trailing colon, empty defaultValue (0.060625ms)
✔ stripHint: removes the default-hint suffix but leaves the colon intact (0.0715ms)
✔ reopen: a re-ask whose stripped message starts-with the stored base reopens the same row (0.388209ms)
✔ reopen: a byte-identical hint-stripped message (masked-password re-ask) reopens the same row (0.261584ms)
✔ new occurrence: same id but a different (non-prefix) hint-stripped message inserts a new row (0.222667ms)
✔ double-rejection: the stored comparison base never advances past the original ask; exactly one row survives (0.252ms)
✔ renderOptionCards: splits an option string at the FIRST " - " into title/description (0.069333ms)
✔ renderOptionCards: model fixture -- starred entry strips "⭐ " to title, recommended true (0.085792ms)
✔ renderOptionCards: provider prompt badges index 0 regardless of star (0.05075ms)
✔ renderOptionCards: model list (no badgeIndex) badges by star only, never by index (0.044084ms)
✔ renderOptionCards: no " - " separator yields the whole string as title, empty description (0.042167ms)
✔ list prompt: provider options render parsed titles and badge the recommended (index 0) entry (0.160041ms)
✔ input prompt: row title uses deriveRowTitle, input is pre-filled with the parsed default (0.133208ms)
ℹ tests 20
ℹ pass 20
ℹ fail 0
```

Full suite:
```
$ node --test ui/test/*.test.mjs > /tmp/epmcdme-14513-task3-full.log 2>&1; echo "EXIT=$?"; tail -10 /tmp/epmcdme-14513-task3-full.log
EXIT=0
ℹ tests 147
ℹ pass 147
ℹ fail 0
```

Pre-implementation FAIL run (test-first evidence) also captured: `renderOptionCards is not a function` errors and one assertion failure on the unparsed raw label text, before implementation.

## Concerns

None. Behavior matches the plan's exact contract (indexOf-based first-occurrence split, star-strip regex, index-based badge for `provider` only, star-based badge otherwise). Markup wiring is intentionally minimal (dataset attributes) since Task 4 owns the visual card design.
