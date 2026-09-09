DONE_WITH_CONCERNS

# Task 4: Layout and copy — header, collapsed row shape, helper lines, option-card markup, Continue button

## Commit

`73a57bbfb22e8be5755fb8b782143f8711800560` on branch `feat/epmcdme-14513-setup-view-ui`

```
$ git show --stat HEAD
commit 73a57bbfb22e8be5755fb8b782143f8711800560
Author: Mert <mert_efe@epam.com>
Date:   Wed Sep 9 20:02:02 2026 +0300

    EPMCDME-14513: setup-view header/copy/collapsed-row layout and option-card markup

    Adds the "Set up CodeMie" mount-time header, a PROMPT_COPY table that
    overrides open-row heading/helper text and the collapsed-row label for
    the wireframe's named steps (provider, codemieProject, model,
    profileName, installClaude) without replacing the general
    deriveRowTitle/raw-message fallback for any other prompt id. List
    options now render as real .setup-option-card markup (title/description/
    recommended badge, textContent only) instead of flat radio/label pairs,
    and every row toggles a `collapsed` class the moment it reaches COMPLETE,
    swapping its title to the collapsedLabel where one exists. New CSS is
    added alongside (never inside) the existing .step-row block, scoped to
    #setup-view for the collapsed-row layout.

 ui/setup-view.js            | 136 +++++++++++++++++++++--
 ui/styles.css               |  43 ++++++++
 ui/test/setup-view.test.mjs | 263 +++++++++++++++++++++++++++++++++++++++++++-
 3 files changed, 430 insertions(+), 12 deletions(-)
```

Confirmed via `git show --stat HEAD` that only `ui/setup-view.js`, `ui/styles.css`, and `ui/test/setup-view.test.mjs` were touched.

## Test-first sequence

RED (before implementation, after writing the new/adjusted tests only):

```
node --test ui/test/setup-view.test.mjs > /tmp/epmcdme-14513-task4-red.log 2>&1; echo "EXIT=$?"
EXIT=1
```
4 tests failed as expected: "collapsed class is added only once a row reaches COMPLETE...", "option cards: recommended card gets a badge element...", "Continue button (list): ...", "Continue button (input): ...".

GREEN (after implementation):

```
$ node --test ui/test/setup-view.test.mjs > /tmp/epmcdme-14513-task4.log 2>&1; echo "EXIT=$?"; tail -40 /tmp/epmcdme-14513-task4.log
EXIT=0
✔ start() inserts a collapsed/COMPLETE storage row before startSetup runs (1.303084ms)
✔ gate and confirm-kind activate prompts never render a row (0.319375ms)
✔ list prompt: renders radio options, resolves with selected index, marks row COMPLETE (1.031167ms)
✔ input prompt: renders a text field, resolves with the typed string, marks row COMPLETE (0.311459ms)
✔ confirm prompt: Yes is pre-selected, resolves with a boolean, marks row COMPLETE (0.256667ms)
✔ confirm prompt: choosing No resolves with false (0.201625ms)
✔ deriveRowTitle: strips the default hint and trailing colon, hint becomes defaultValue (0.471166ms)
✔ deriveRowTitle: a hint-less message strips only the trailing colon, empty defaultValue (0.06275ms)
✔ stripHint: removes the default-hint suffix but leaves the colon intact (0.071583ms)
✔ reopen: a re-ask whose stripped message starts-with the stored base reopens the same row (0.4005ms)
✔ reopen: a byte-identical hint-stripped message (masked-password re-ask) reopens the same row (0.225875ms)
✔ new occurrence: same id but a different (non-prefix) hint-stripped message inserts a new row (0.238417ms)
✔ double-rejection: the stored comparison base never advances past the original ask; exactly one row survives (0.254208ms)
✔ renderOptionCards: splits an option string at the FIRST " - " into title/description (0.055125ms)
✔ renderOptionCards: model fixture -- starred entry strips "⭐ " to title, recommended true (0.077916ms)
✔ renderOptionCards: provider prompt badges index 0 regardless of star (0.048875ms)
✔ renderOptionCards: model list (no badgeIndex) badges by star only, never by index (0.045875ms)
✔ renderOptionCards: no " - " separator yields the whole string as title, empty description (0.050708ms)
✔ list prompt: provider options render parsed titles and badge the recommended (index 0) entry (0.193583ms)
✔ input prompt: row title uses deriveRowTitle, input is pre-filled with the parsed default (0.138958ms)
✔ header: "Set up CodeMie" heading renders once at mount, before the storage row (0.0985ms)
✔ PROMPT_COPY: provider row renders its heading/helper while active, collapses to "How to reach a model" (0.160459ms)
✔ PROMPT_COPY: model row renders its own heading/helper and collapses to "Model", never the provider label (0.173083ms)
✔ PROMPT_COPY: a prompt id outside the table (credential) falls back to deriveRowTitle, proving an override not a takeover (0.131ms)
✔ collapsed class is added only once a row reaches COMPLETE, never while PENDING/ACTIVE (0.508375ms)
✔ option cards: recommended card gets a badge element and the "recommended" class; markup uses real elements, not dataset text (0.255209ms)
✔ Continue button (list): clicking Continue with a card selected resolves the prompt with that card's index (0.184791ms)
✔ Continue button (input): clicking Continue with a typed value resolves the prompt with that string (0.15675ms)
ℹ tests 28
ℹ pass 28
ℹ fail 0
```

Full suite:

```
$ node --test ui/test/*.test.mjs > /tmp/epmcdme-14513-task4-full.log 2>&1; echo "EXIT=$?"
EXIT=0
ℹ tests 155
ℹ pass 155
ℹ fail 0
```

## What was implemented

`ui/setup-view.js`:
- `PROMPT_COPY` table (exported), exactly matching the plan's literal object (see concern below re: `profileName`).
- `headingFor(prompt)` / `helperFor(promptId)` / `collapsedLabelFor(promptId)` — small pure helpers, shared by both the new-occurrence and reopen code paths in `onPrompt`, per the plan's explicit instruction not to duplicate this logic.
- `appendHelperText(host, promptId)` — creates a new `.step-helper` element (distinct from steps-ui.js's `.step-sub`) shown only on the open row, when the table has a `helper` entry.
- `collapseRow(rowId, promptId)` — toggles the `collapsed` class via `classList.toggle('collapsed', true)` and swaps `.step-title`'s textContent to the `collapsedLabel` when the table has one. Called from every control's `submit()` closure, and from `start()` for the fixed `storage` row (which is COMPLETE from mount and should collapse identically to any driver-answered row).
- Reopen path additionally un-collapses the row and restores the open-row heading (`headingFor`), since a previously-submitted row that gets re-asked (validation rejection) should visually re-open, not stay collapsed.
- Header: `start()` now creates an `<h1 class="setup-view-heading">Set up CodeMie</h1>` and appends it to `container` immediately after `stepsUi.renderSteps(container, [])` (which clears the container via `innerHTML = ''`) and before the `storage` row is inserted — so it is always the first child, ahead of every row.
- `renderListControl` rebuilt to emit real `.setup-option-card` divs (containing the radio, a `.setup-option-title` div, an optional `.setup-option-description` div, and — when recommended — a `.setup-option-badge` span with static text `'Recommended'`) instead of the old flat radio + `.prompt-option-label` span pair. Title/description are always set via `.textContent`, never `.innerHTML`, since they come from driver-supplied strings. Card click (`card.onclick`) selects its radio; the submit handler is unchanged (`radios.findIndex(r => r.checked)`).
- All three controls' Continue buttons now also carry a `setup-continue-btn` class via `btn.classList.toggle('setup-continue-btn', true)` — deliberately NOT baked into `btn.className` (which stays `'prompt-submit'` unchanged) so every existing test that does `_children.find(c => c.className === 'prompt-submit')` keeps working unmodified. In a real browser, `classList` and the class attribute are the same underlying list, so this still produces a normal, stylable class in production.

`ui/styles.css`:
- New block inserted between the existing `.stamp.ignored` rule (line 520) and the `/* ---- Log bar + panel ---- */` comment (line 522) — verified this range was still exactly 489-520/522 before editing (unchanged from Task 3). Nothing inside the existing `.step-row`/`.approval`/`.stamp` rules was touched.
- New selectors: `.setup-view-heading`, `.step-helper`, `.setup-option-card` (+ `:hover`, `.recommended`), `.setup-option-title`, `.setup-option-description`, `.setup-option-badge`, `.setup-continue-btn`, and the collapsed-row family scoped under `#setup-view .step-row.collapsed ...` (`.step-main` becomes an inline flex row; `.step-sub` is bolded and gets an em-dash via `::before` content, producing the "label — value" shape entirely in CSS rather than baking a dash into JS-set textContent; `.step-icon` gets `order: 2; margin-left: auto` to move it to the row's right edge). All reuse existing custom properties already used elsewhere in the file (`--muted`, `--accent-blue`, `--border`, `--radius-lg`, `--radius-md`, `--text`, `--surface-2`, `--color-text-inverse`).

`ui/test/setup-view.test.mjs`:
- Added a recursive `collectAll(el, predicate)` helper (test-file-local, not a change to setup-view.js) to search descendants, since option-card markup now nests radios/titles one level deeper than the old flat shape.
- Added 8 new tests per the plan's Test-first list: header-renders-first, provider heading/helper/collapse, model heading/helper/collapse (and never swapped with provider's label), credential id falling back to `deriveRowTitle` (table-is-an-override proof), collapsed class only on COMPLETE, option-card markup (title/description/badge elements, recommended class), Continue-button resolving a list row by selected card index, Continue-button resolving an input row by typed string.
- Adjusted 2 pre-existing Task 1-3 tests (see concern below).

## Concerns / notes for reviewer

1. **Two pre-existing tests were adjusted, not left byte-identical** — this is the one deviation from "preserve every existing test verbatim," and it was necessary and foreseen by the plan itself ("Task 4 replaces/extends this [flat radio/label] markup with real card markup").
   - `list prompt: renders radio options, resolves with selected index, marks row COMPLETE` — changed `control._children.filter((c) => c.type === 'radio')` to `collectAll(control, (c) => c.type === 'radio')`, because radios now live one level deeper inside `.setup-option-card` divs instead of being direct children of `.prompt-control`. The assertion itself (`radios.length === 3`, then `radios[1].checked = true`) is unchanged in intent and still passes with the new markup.
   - `list prompt: provider options render parsed titles and badge the recommended (index 0) entry` — changed the `.prompt-option-label` lookup to a `.setup-option-title` lookup (via `collectAll`), since the old flat `<span class="prompt-option-label">` was replaced by the new card's `.setup-option-title` div (same assertion: `textContent === 'CodeMie SSO'`). Also switched the radio lookup to `collectAll` for the same nesting reason.
   - No other existing test needed changes; I audited every pre-existing assertion touching `.step-title`, `.step-sub`, `.step-icon`, `classList`, and radios/inputs for each affected prompt id (`provider`, `model`, `profileName`, `installClaude`, `orgUrl`, `password`, `freeform`) and confirmed none of them check title text for ids that gained a `PROMPT_COPY` heading/collapsedLabel, so the new copy-override and collapse-on-complete behavior doesn't silently change what any old test observes.

2. **`profileName`'s `heading` key — literal table vs. prose disagree, I followed the literal table.** The plan's "Produces:" interface line spells out `profileName: { heading: 'Profile name', collapsedLabel: 'Profile name' }` (i.e. `profileName` HAS a `heading`), but the later "Context you need" prose says "`codemieProject`/`profileName`/`installClaude` in the table have no `heading`/`helper` key (only `collapsedLabel`)" — which contradicts the literal object for `profileName` specifically. I treated the literal `PROMPT_COPY` object in the "Produces:" section as the normative interface spec (it's what the task explicitly says the module must "produce") and implemented `profileName: { heading: 'Profile name', collapsedLabel: 'Profile name' }` exactly as written there. Practical effect: the `profileName` row's OPEN heading now reads "Profile name" instead of the previous deriveRowTitle-derived "Enter a name for this profile" — no existing test asserted that title text, so nothing broke, but a reviewer should double check this is the intended behavior (a bare "Profile name" heading with no helper line) rather than the prose's implied "keep the CLI's own question as the open heading, only override the collapsed label."

3. **Old `.prompt-option-label` span, `dataset.description`, `dataset.recommended` were removed entirely** rather than kept alongside the new visible card elements — I read the plan's "Task 4 replaces/extends this with real card markup" as license to retire the dataset-attribute approach now that the same information (title/description/recommended) is carried by real, visible DOM elements. Nothing else in the two touched files referenced those dataset attributes or that class name, per a repo-wide grep before removing them.

4. **`installClaude`'s version-capture (e.g. "v1.2.3") is intentionally not implemented here** — per the plan, that's Task 6's job. This task only wires the shared `collapseRow`/`collapsedLabelFor` mechanism generically enough (label from `collapsedLabelFor` or existing title, value from whatever `.step-sub` already holds, dash supplied by CSS) that Task 6 should be able to set `installClaude`'s subtitle to a captured version string and get "Claude Code — v1.2.3" for free, with no further change to this file's collapse logic.

5. Did not touch `.codemie/codemie-cli.config.json`, which showed as modified in `git status` at session start (pre-existing, unrelated to this task) — left untouched and unstaged, consistent with "stage only the three files" instruction.
