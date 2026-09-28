# Technical Research

**Task**: setup-view ui setup-driver steps-ui
**Generated**: 2026-09-09T00:00:00Z
**Research path**: codegraph

---

## 1. Original Context

EPMCDME-14513: CodeMie Desktop: Guided setup, setup-view UI.

Present `codemie setup` as a graphical flow: the happy path, rendered in `setup-view` on top of EPMCDME-14668's driver. Today the app hands the user a raw terminal and the CLI asks the questions there.

Sub-task S10 of EPMCDME-14350. Failure states are EPMCDME-14588; answer replay and step revisit are EPMCDME-14656 (Stage 2).

Wireframe: docs/wireframes/02-setup.png (open before building; two upper panels are this ticket's, two lower failure panels are 14588's). docs/wireframes/01-home.png for context on how the user arrives.

## Prerequisites (already landed on this branch)
- EPMCDME-14511: provides the shell, the empty `setup-view` container (ui/index.html:177), and a config-reader command this ticket verifies with (reads activeProfile from ~/.codemie/codemie-cli.config.json).
- EPMCDME-14668: `ui/setup-driver.js`: `startSetup({ onPrompt, onLog, replay })`, runs the CLI, detects prompts via EPMCDME-14651's parser, asks for each answer. This ticket never touches the PTY; it renders and answers. Exposed on CODEMIE_DEV=1 hook at ui/renderer.js:490 as window.__codemie.showView('setup') / window.__codemie.startSetup.
- EPMCDME-14654: `ui/steps-ui.js` instance factory — createStepsUi at :13, renderSteps :57, setStatus :68, setSubtitle :70, startSpinner :75, stopSpinner :84, setProgress :89, insertSubStep :97, STATUS_META (private copy, NOT imported from models.js) at :3, rendered at :48. Take own instance; module-level default belongs to legacy install engine (ui/renderer.js:199 and :494 call the module default stepsUI.renderSteps for the legacy wizard-view / step-list flow — do not touch that).
- ui/models.js: StepStatus at :3, makeStep(raw) at :23.

## Driver contract (do not modify, only consume)
`startSetup({ onPrompt, onLog, replay })` calls `onPrompt(prompt)` for every detected prompt: `{ kind: 'list' | 'input' | 'confirm', id, message, options?, selectedIndex? }`. Caller resolves with: chosen option's index for 'list', the string for 'input', a boolean for 'confirm'. Resolves overall with `{ profileName }` on success, rejects with `{ step, message, raw }` on failure (that rejection is EPMCDME-14588's concern — this ticket just marks the step ERROR).
Driver auto-answers prompt 1 (storage, always 'global') and the activate confirm itself, reporting them as already-answered steps. The Claude Code install confirm is NOT driver-answered — it arrives at onPrompt like any other prompt, kind:'confirm', and THIS ticket renders it (default control to yes).

## What to build (rendering + wiring only, in ui/)
A new module that creates its own steps-ui instance, models the step sequence as dynamic (one row per prompt), wires onPrompt to render controls and resolve answers, renders driver-auto-answered steps (storage, activate) as collapsed, renders automatic phases with spinners, verifies success via config-reader, and marks ERROR on rejection without building failure UI. Must not import pty, listen to engine:pty-*, or touch anything but ui/setup-driver.js. Must not render into wizard-view or touch the module-level steps-ui default.

## What I need from research (be efficient — batch codegraph_explore calls, do not open every file individually)
1. ui/renderer.js: showView mechanism, CODEMIE_DEV hook exposing startSetup, and how the legacy wizard wires onPrompt-equivalent (lines ~199, ~490, ~494 relevant).
2. ui/setup-driver.js: real startSetup signature/behavior, onPrompt prompt shapes per kind, resolution mechanics (Promise per call? resolve fn passed in?).
3. ui/steps-ui.js: full createStepsUi API surface (renderSteps, setStatus, setSubtitle, startSpinner/stopSpinner, setProgress, insertSubStep, STATUS_META, rendered) and whether renderSteps re-renders the full list or rows are added incrementally.
4. ui/models.js: StepStatus enum values, makeStep(raw) shape.
5. ui/index.html: setup-view container markup, existing step-list/step-row CSS classes for consistency (SMOKE_PROBE counts `.step-row`).
6. EPMCDME-14511's config-reader command: exact IPC invoke name/shape from frontend, backing Rust command if any.
7. Existing test patterns for ui/*.js (node:test?) — any existing tests for setup-driver.js, steps-ui.js, or the wizard/engine.
8. Confirm ui/setup-driver.js and an instantiable ui/steps-ui.js factory currently exist on this branch (feat/epmcdme-14513-setup-view-ui).

---

## 2. Codebase Findings

### Existing Implementations
- `ui/setup-driver.js` — landed (EPMCDME-14668). Exports `startSetup({ onPrompt, onLog, replay } = {}, deps = {}) → Promise<{ profileName }>` (line 215), single-flight guarded by module-level `active` flag (throws `{ step: null, message: 'startSetup already in progress', raw: '' }` on concurrent call). Internally calls private `runSetup`. Not yet called from anywhere in the app except the CODEMIE_DEV hook — this ticket is its first real caller.
- `ui/setup-parse.js` — pure parser (EPMCDME-14651). `detectPrompt(lines)` returns `{ kind, id, message, options?, selectedIndex? } | null`. `PROMPTS` table (line 17) enumerates every named anchor: gate, storage, provider, codemieUrl, codemieProject, model, customModel, modelManual, profileName, activate, installClaude, credential (catch-all). `isQ` exported for driver reuse.
- `ui/steps-ui.js` — `createStepsUi()` factory (EPMCDME-14654) returns a closure-scoped instance: `{ renderSteps, setStatus, setSubtitle, startSpinner, stopSpinner, setProgress, insertSubStep, showApproval, stampApproval }`. `renderSteps(container, list)` clears and fully rebuilds the container's rows each call — not incremental (`container.innerHTML = ''` then one `buildRow` per non-sub-step). `insertSubStep` is the incremental-add primitive, and it is closure-scoped to whichever container `renderSteps` last targeted on that instance. A private, unexported `STATUS_META` (line 3, PENDING/ACTIVE/COMPLETE/WARNING/ERROR/SKIPPED → icon+color) governs `.step-icon` rendering; it is not the same object as `ui/models.js`'s exported `STATUS_META`, and the two files' copies are already in sync but not linked. A default module-level instance (line 138) exists purely to preserve `ui/renderer.js`'s existing `import * as stepsUI` calls for the legacy wizard-view flow (renderer.js:199, :494) — this ticket must call `createStepsUi()` itself, never touch the default.
- `ui/models.js` — `StepStatus` (frozen enum: PENDING/ACTIVE/COMPLETE/WARNING/ERROR/SKIPPED, line 3), `makeStep(raw)` (line 23, normalizes a raw step object with defaults; not obviously reusable as-is since setup-view's steps are dynamic per-prompt rather than loaded from `config/steps.yaml`/`get_steps()`).
- `ui/renderer.js` — `showView(name)` (line 180) toggles `.hidden` on each of the six `views` map entries plus `wizard-view`, and sets `aria-current` only on sidebar entries matching `name` (setup and wizard have no sidebar entry, so no highlight is ever set for them — expected). `boot()`'s `CODEMIE_DEV` block (line 488) lazy-imports `setup-driver.js` and exposes `window.__codemie = { showView, startSetup }` only when `flags.dev` is true; this is devtools-only, not a production caller. The legacy wizard flow's "answer questions" equivalent is `enterWizard(stepIds)` (line 194) + the module-default `stepsUI.renderSteps(stepListEl, steps)` (line 199) driving the *install* engine (`ui/engine.js`, not shown), which is unrelated to prompt-answering — there is no existing onPrompt-style wiring pattern to imitate for the interactive answer flow; setup-view establishes a new one.
- `ui/index.html:177` — `<div id="setup-view" class="hidden"></div>`, confirmed still an empty placeholder, comment explicitly deferring to this ticket. `ui/renderer.js`'s `views` map already includes `setup: document.getElementById('setup-view')` (line 74), so `showView('setup')` already works once content is inserted.
- `src-tauri/src/commands/codemie_config.rs` — `read_codemie_config()` (`#[tauri::command]`, line 110) reads `~/.codemie/codemie-cli.config.json`, returns `CodemieConfig { state: ConfigState (no-configuration|valid|broken, kebab-case serialized), profile, model, project, account: Option<String> }`. Never fails — file-missing/unparseable is a `state`, not an IPC error. Frontend wrapper: `ui/runner-bridge.js:52` `codemieConfig.read: () => invoke('read_codemie_config')`. This is the config-reader this ticket verifies setup success with — after `startSetup` resolves, `codemieConfig.read()` should report `state: 'valid'` and a `profile` matching the resolved `profileName`.

### Architecture and Layers Affected
Per `.ai-run/guides/architecture/architecture.md`, this is the "Frontend-brain" layer entirely: a new ES module under `ui/` (no bundler, plain `<script type=module>`), consuming `setup-driver.js` (orchestration), `steps-ui.js` (rendering), `models.js` (status enum), and `runner-bridge.js`'s `codemieConfig.read()` (IPC wrapper) — no new Rust commands, no `lib.rs` registration, no `state.rs` changes. The task explicitly forbids touching PTY (`commands/pty.rs`, `engine:pty-*` events) and the legacy `wizard-view`/module-default `steps-ui` path.

### Integration Points
- `ui/setup-driver.js` `startSetup` — the only driver entry point this ticket calls; contract is frozen (do not modify).
- `ui/steps-ui.js` `createStepsUi()` — own instance, own container (the `setup-view` div).
- `ui/runner-bridge.js` `codemieConfig.read()` → Rust `read_codemie_config` — used post-success to verify.
- `ui/renderer.js` `showView('setup')` — already wired into the `views` map; the new module presumably gets invoked when `showView('setup')` fires (exact trigger point — sidebar entry, home tile, or CODEMIE_DEV hook only — is not yet decided in code and is a design question, not a research finding).
- `window.__codemie` CODEMIE_DEV hook (renderer.js:488-491) — the only existing in-app caller of `startSetup` today; real production wiring must add a caller (this ticket's job).

### Patterns and Conventions
- Factory-per-instance pattern for stateful DOM controllers (`createStepsUi()`), established by EPMCDME-14654 specifically so a second consumer (this ticket) can hold independent state — module-level default exists only for backward compatibility with the legacy caller.
- Rust IPC commands are "never fail" for read-only status probes (`read_codemie_config`, `check_profile_status`) — errors become states, not rejected promises. Consistent with `.ai-run/guides/architecture/architecture.md`'s `CmdResult<T>` guidance for genuinely fallible commands vs. plain `T` for infallible ones.
- `ui/runner-bridge.js` is the sole seam between frontend and Tauri `invoke`/`listen` — the guide explicitly disallows importing Node/OS APIs or calling `invoke()` directly outside this module.
- Async command handlers in `ui/handlers.js` receive a `ctx` with `setSubtitle`/`setStatus`/`line`/`emit` — a shape steps-ui's own API mirrors (`setStatus`, `setSubtitle`, `setProgress`), suggesting the new module should drive its steps-ui instance with the same verb set rather than inventing new ones.

---

## 3. Documentation Findings

### Guides and Architecture Docs
- `.ai-run/guides/architecture/architecture.md` — Option B (frontend-brain, thin Rust backend), component responsibility table, IPC pattern (`invoke('<command>', {arg})` / `app.emit("engine:<event>", payload)`), "Adding New System Commands" checklist (not applicable here — no new Rust command needed).
- `.ai-run/guides/testing/testing-patterns.md` — JS tests use bare `node:test` + `node:assert/strict`, one `*.test.mjs` file per module under `ui/test/`, no framework dependency, no DOM library (steps-ui.test.mjs hand-rolls a minimal `document.createElement` stub — see Testing Landscape below).
- `.ai-run/guides/quality-gates.md`, `.ai-run/guides/standards/git-workflow.md`, `.ai-run/guides/development/development-practices.md` — present but not read in depth this pass; not directly load-bearing for the rendering-only scope of this ticket beyond standard lint/format/test/commit conventions already known from prior sessions on this branch.

### Architectural Decisions
- Inline comments in `setup-driver.js` (lines 69-71) record the decision that `installClaude` is a user-facing confirm (unlike `storage`/`activate`, which are driver-fixed policy) and that its rendered control should default to "yes" to match the CLI's own `(Y/n)` default — a UI requirement embedded directly in the driver's code comments, not a separate ADR doc.
- `ui/steps-ui.js` line 94-96 records why the `insertSubStep` `else-if (listEl)` fallback must stay closure-scoped per instance, directly relevant to this ticket taking its own `createStepsUi()` instance.

### Derived Conventions
- No existing "answer a live prompt in the UI" pattern exists anywhere in the codebase yet — the legacy wizard's approval-gate UI (`showApproval`/`stampApproval` in steps-ui.js, `ctx.setSubtitle` etc. in handlers.js) is the closest analog but serves a different purpose (approve/ignore a step, not answer a multi-kind prompt with list/input/confirm shapes). This ticket is establishing a new convention, not following one exactly.

---

## 4. Testing Landscape

### Existing Coverage
- `ui/test/setup-driver.test.mjs` — covers `startSetup`/`runSetup` (per codegraph blast-radius; contents not read in full this pass, but its existence confirms the driver module is testable in isolation via injected `deps`).
- `ui/test/steps-ui.test.mjs` — covers `createStepsUi()` instance independence (two instances render into separate containers without shared state), `insertSubStep` orphan-parent fallback (own container, not another instance's), and the nine default-instance exports staying intact. Uses a hand-rolled minimal DOM stub (`makeEl`, `findByClass`, a fake `innerHTML` setter that regex-parses class names) rather than a real DOM or jsdom.
- `ui/test/models.test.mjs` — covers `StepStatus`, `STATUS_META`, `makeStep` normalization.
- `ui/test/engine.test.mjs` — covers install-engine orchestration (sequencing, approval gates, fatal/non-fatal), unrelated to setup-view but the nearest sibling for "orchestrating a UI of driven steps."
- `src-tauri/src/commands/codemie_config.rs` — 7 inline `#[test]` cases cover all three `ConfigState` outcomes, account-present/absent, and cross-platform path construction. No Rust changes are needed for this ticket, so this is background confidence, not a gap.

### Testing Framework and Patterns
- JS: `node --test`, `node:assert/strict`, no external framework, no jsdom — DOM interactions are stubbed by hand per test file, following `steps-ui.test.mjs`'s `makeEl` pattern.
- Rust: `cargo test`, inline `#[cfg(test)] mod tests` in the same file, `#[tokio::test]` for async.

### Coverage Gaps
- No test file exists yet for a setup-view module (it doesn't exist yet — expected).
- `startSetup` itself (per the earlier blast-radius note in the first codegraph call) shows "no covering tests found" for the internal `runSetup` function specifically, though the exported `startSetup` does have `ui/test/setup-driver.test.mjs` coverage.
- No existing test demonstrates driving `createStepsUi()` through a live/simulated `onPrompt` sequence — this ticket's own module will need to establish that pattern from scratch, likely following `steps-ui.test.mjs`'s DOM-stub style and `setup-driver.test.mjs`'s injected-`deps` style for faking `startSetup`.

---

## 5. Configuration and Environment

### Environment Variables
- `CODEMIE_DEV=1` — gates the `window.__codemie = { showView, startSetup }` devtools hook in `renderer.js` boot() (line 488); the only current in-app way to invoke `startSetup` without a real caller.
- `CODEMIE_SMOKE=1` / `CODEMIE_PROBE_SMOKE=1` — existing smoke-mode flags (per architecture.md and renderer.js flags.smoke/flags.probe), routed today only to the legacy `wizard-view`; not wired to setup-view.
- `HOME` / `USERPROFILE` (fallback) — used by `config_path()` in `codemie_config.rs` to locate `~/.codemie/codemie-cli.config.json`.

### Configuration Files
- `~/.codemie/codemie-cli.config.json` — the CLI's own config file; read by `read_codemie_config`, contains `activeProfile`, `userEmail`, `profiles.<name>.{model, codeMieProject}`. This is what the new module verifies setup success against.
- `config/steps.yaml` / `config/steps-windows.yaml` — the legacy install-engine's step definitions (embedded via `include_str!`); NOT relevant here since setup-view's steps are dynamic (one row per live prompt), not loaded from this YAML.

### Feature Flags and Deployment Concerns
None specific to setup-view found; standard `CODEMIE_DEV`/smoke-mode conventions apply, no new flags required by anything discovered in code.

---

## 6. Risk Indicators

- No existing in-app caller wires `startSetup` into the real UI flow today — only the `CODEMIE_DEV` devtools hook exercises it. This ticket is the first production integration of a driver whose contract is otherwise only exercised by its own unit tests and manual devtools use.
- `renderSteps(container, list)` fully clears and rebuilds all rows on every call (`container.innerHTML = ''`), while `insertSubStep` is the only incremental primitive. Speculative: since prompts arrive one at a time via `onPrompt` and the step list is dynamic (unknown length until the CLI decides what to ask), the new module will likely need to call `insertSubStep`-style incremental appends per prompt rather than repeatedly calling `renderSteps` with a growing array — but no existing code demonstrates this usage, so it is unverified against `steps-ui.js`'s actual behavior under repeated partial lists.
- `steps-ui.js`'s private `STATUS_META` (icons/colors) is a duplicate, not an import, of `ui/models.js`'s exported `STATUS_META`. They are consistent today but drift-prone; not a defect to fix under this ticket's scope, just a note for whoever renders ERROR/WARNING status distinctly for setup-view rows.
- The wireframe (`docs/wireframes/02-setup.png`) shows a 6-dot step-progress indicator, per-step "Back"/"Continue" controls, and collapsed answered rows with a checkmark badge and "click back into" affordance — but the current ticket text scopes only the happy-path render + auto-answered collapse, deferring "click back into an earlier answered step" explicitly to EPMCDME-14656 (Stage 2). Speculative: the wireframe's "Back" button and the collapsed-row click affordance may visually exist in this ticket's build without being wired to actual step-revisit behavior; that ambiguity is not resolved by anything in code or the ticket text and would need spec/plan clarification.
- The wireframe's rejected-credential and CodeMie-unreachable panels are explicitly out of scope (EPMCDME-14588); the two upper panels (provider selection collapsed history, model selection with profile-name field trailing) are the only ones this ticket owns, and they show a much richer layout (status dots row, "recommended" badges, provider descriptions) than the current bare `.step-row` CSS (icon + title + subtitle + progress bar) supports — Speculative: new CSS/markup beyond the existing `.step-row`/`.step-icon`/`.step-title`/`.step-sub`/`.step-progress` classes will likely be needed for list-option and confirm controls (radio-style option list, Yes/No buttons, text input), none of which exist in the current CSS/JS today.
- `installClaude` confirm defaulting to "yes" is documented only in a code comment inside `setup-driver.js`, not in any UI spec — the rendered control's exact visual (checkbox? toggle? Yes/No buttons with Yes pre-focused?) is undefined by any artifact examined.
- No existing pattern for wiring a live multi-kind (`list`/`input`/`confirm`) prompt-answer UI exists anywhere in the codebase; the module under this ticket establishes a new convention rather than following one, raising implementation risk beyond what file-count alone would suggest.

---

## 7. Summary for Complexity Assessment

This task is confined entirely to the frontend-brain layer (`ui/`): a new ES module that instantiates its own `steps-ui.js` controller, consumes the already-landed `setup-driver.js` (`startSetup({ onPrompt, onLog, replay })`) without modification, and verifies success via the already-landed `read_codemie_config` IPC command through `runner-bridge.js`. No Rust changes, no new IPC commands, no `lib.rs` registration are required — every dependency this ticket needs (driver, steps-ui factory, config-reader, empty `setup-view` container, `StepStatus` enum) is already on this branch and tested in isolation (`ui/test/setup-driver.test.mjs`, `ui/test/steps-ui.test.mjs`, `codemie_config.rs`'s inline tests). The remaining work is one new module plus its test file, wiring the container that already exists in `index.html` and the `showView('setup')` routing that already works.

The technical novelty is real despite the narrow file surface: no existing code in this repository demonstrates driving a live multi-kind (list/input/confirm) prompt-answer UI loop, so the render/resolve wiring pattern is new rather than a repeat of an established convention. `steps-ui.js`'s `renderSteps` (full rebuild) versus `insertSubStep` (incremental) split raises an unresolved question about how a dynamically-growing, one-row-per-prompt sequence should actually be rendered — nothing in the codebase confirms which primitive fits, which is a design decision for the plan stage, not a fact this research can assert. The wireframe's visual richness (radio-style option lists, provider description text, "recommended" badges, collapsed-row checkmarks) exceeds what the current `.step-row` CSS/markup supports, implying new markup/CSS work whose exact size is a plan-stage estimate, not something this analysis quantifies.

Test coverage posture is favorable: every dependency this ticket touches already has unit tests with an established idiom (bare `node:test`, hand-rolled DOM stubs, injected-`deps` fakes for the driver) that a new `ui/test/setup-view.test.mjs` can follow directly. The primary risk factors are the undefined rendering strategy for the dynamic step sequence, the gap between wireframe fidelity and current CSS primitives, and the fact that this is the first real (non-devtools) caller of a driver contract that has so far only been exercised by its own tests and a console hook.

---

## 8. External References

- `docs/wireframes/02-setup.png` — resolved, read. Shows the "Guided setup" 6-of-6-dot progress model, with two upper panels in scope for this ticket (provider selection with collapsed "Where to store it — This computer ✓" history row and radio-style provider cards including "EPAM AI/Run CodeMie [recommended]", "I have an API key" with OpenAI/Azure OpenAI/AWS Bedrock/LiteLLM listed, and "A model running on this computer" / Ollama; and model selection with four collapsed history rows — storage, provider, signed-in-as, CodeMie project — followed by a model radio list with "Claude Sonnet 5 [recommended]", and a trailing disabled/placeholder "Profile name" field) and two lower panels explicitly out of scope for EPMCDME-14588 (rejected-credential inline error state; CodeMie-unreachable connectivity error with a "$ codemie setup" / raw-output disclosure). An annotation on the wireframe itself flags an open design question about whether the six-step flow should stay literal or relax to "same decisions available, with defaults pre-selected" — unresolved in any artifact, a plan-stage decision.
- `docs/wireframes/01-home.png` — resolved, read. Confirms context only: Home is a single screen that is an onboarding checklist pre-setup and a status dashboard post-setup, with no separate "guided mode" to leave. Not directly load-bearing for setup-view's internal implementation, only for how the user arrives at it (no dedicated sidebar entry into Setup was found in code either — consistent with `showView`'s comment that setup/wizard "have no sidebar entry").
