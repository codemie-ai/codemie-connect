# Technical Research

**Task**: setup prompt-parser xterm terminal fixtures
**Generated**: 2026-09-04T00:00:00Z
**Research path**: codegraph

---

## 1. Original Context

EPMCDME-14651 — CodeMie Desktop: Guided setup, prompt parser and fixtures.

Build the pure prompt parser for `codemie setup`: a function over a headless terminal's screen lines
that says which prompt is open, with captured fixtures for every prompt the CLI can raise. No PTY, no UI.

Sub-task of EPMCDME-14350. Carved out of EPMCDME-14513 so the parser and its fixtures land as one
small, test-only piece; EPMCDME-14513 then builds the driver and setup-view UI on it; EPMCDME-14588
extends it with failure classifications.

Prerequisite: EPMCDME-14511 (branch from its work). Nothing here touches the PTY or the shell;
ui/vendor/xterm.mjs is already in the repository.

## Deliverable

`ui/setup-parse.js` exporting:
```
detectPrompt(screenLines) -> null | {
  kind: 'list' | 'input' | 'confirm',
  id:   'gate' | 'storage' | 'provider' | 'codemieUrl' | 'codemieProject'
      | 'credential' | 'model' | 'customModel' | 'modelManual'
      | 'profileName' | 'activate' | 'installClaude',
  message: string,
  options?: string[],
  selectedIndex?: number
}
```
Pure function over an array of screen lines. No import of pty or any engine:* event.

## The real prompt sequence (12 ids + gate = 13)

1. list `storage` — "Where would you like to store this configuration?" — always
2. list `provider` — "Choose your LLM provider:" — always
3. input `codemieUrl` — "CodeMie organization URL:" — CodeMie-backed providers only
4. list `codemieProject` — "Select your project:" — CodeMie-backed, only when account has >1 project
5. input `credential` — provider-specific — API-key providers only
6. (automatic, spinner) model fetch
7. list `model` — "Choose a model (X available):" — when fetch returned models
8. input `customModel` — "Enter model name:" — only if user picks Custom entry in step 7
9. input `modelManual` — "No models found. Enter model name manually:" — only when fetch returned nothing
10. (conditional, automatic) model installation
11. input `profileName` — "Enter a name for this profile:" — always, asked last
12. confirm `activate` — 'Switch to profile "[name]" as active?' — when it would not already be active
13. confirm `installClaude` — "Would you like to install Claude Code now?" — global storage + Claude not installed

Plus list `gate` — "What would you like to do?" (Add a new profile / Update an existing profile / Cancel) —
shown when `!force && (hasGlobalConfig || hasLocalConfig)`; `codemie setup --force` skips it.

## Critical implementation detail: parse the terminal SCREEN, not accumulated text

inquirer erases and redraws the whole prompt block on every keypress — it does not append. Must feed
bytes to a headless xterm (`ui/vendor/xterm.mjs`, exports `Terminal`, works in plain Node, no DOM/jsdom)
and read `buffer.active` restricted to `baseY` through `baseY + rows` (or construct with `scrollback: 0`),
NOT the whole scrollback — otherwise every answered prompt persists forever and re-detects as open.
Must construct the Terminal at the same cols/rows as the PTY (100x30, see `ui/runner-bridge.js` around
line 114 for spawnPty defaults — note: ticket text says line 104, but EPMCDME-14647 moved it to 114).

Long lists (provider, model) use page size 15 — screen carries at most 15 rows plus a "move up and down"
hint line. The model list is windowed and has an extra "Custom model (manual entry)..." row appended
after the real models — must enumerate until no new entries, not by matching the stated count, and
exclude the Custom row from `options`.

## Fixtures

Checked-in fixtures under `ui/test/fixtures/setup/`, one per prompt id (13 total incl. gate), captured
by recording a real `codemie setup --force` run via `script -q /dev/null` and replaying the typescript
through a headless xterm at 100x30, snapshotting the screen at each prompt.

Test file: `ui/test/setup-parse.test.mjs`, run under `node --test`.

## Constraints
- Zero new npm dependencies (no jsdom). Use only `ui/vendor/xterm.mjs`.
- Do not touch `src-tauri/` at all in this ticket.
- Do not touch the PTY, the driver, or setup-view (EPMCDME-14513 scope).
- Do not add failure classifications (EPMCDME-14588 scope).

---

## 2. Codebase Findings

### Existing Implementations

- `ui/vendor/xterm.mjs` — vendored xterm Terminal class; already present; imported by `ui/terminal.js`; the ticket confirms it works in plain Node without DOM or jsdom
- `ui/vendor/addon-fit.mjs` — FitAddon (resize-to-container); present but not needed for headless parsing
- `ui/terminal.js` — live interactive terminal bound to DOM and Tauri PTY events; exports `initTerminal`, `openTerminal`, `writeData`, `writeLine`, `handlePtyExit`, `closeTerminal`; the new parser module must not import from this file
- `ui/runner-bridge.js:114` — `spawnPty(cmd, cols = 100, rows = 30, onData)` — confirms the canonical PTY dimensions: 100 columns, 30 rows; this is the size the headless Terminal must be constructed at
- `ui/handlers.js:145-147` — step 2.3.3 runs `codemie setup` via `runPty`; confirms the command name
- `ui/setup-parse.js` — does not yet exist; new file
- `ui/test/setup-parse.test.mjs` — does not yet exist; new file
- `ui/test/fixtures/setup/` — directory does not yet exist; 13 fixture files required

### Architecture and Layers Affected

This ticket touches a single architectural layer: the **frontend utility layer** (`ui/`). Specifically:

- **New pure-JS module** (`ui/setup-parse.js`): no DOM, no Tauri invoke, no PTY, no engine events
- **New test file** (`ui/test/setup-parse.test.mjs`): follows existing `node:test` pattern
- **New fixture directory** (`ui/test/fixtures/setup/`): screen-snapshot JSON or text files, 13 total
- The Rust backend (`src-tauri/`) is explicitly out of scope and must not be modified

### Integration Points

- `ui/vendor/xterm.mjs` exports `Terminal` — the only runtime dependency for the parser
- `ui/runner-bridge.js:114` — PTY default dimensions (100x30) define the Terminal constructor arguments; future consumers (EPMCDME-14513 driver) will import `detectPrompt` from `ui/setup-parse.js`
- EPMCDME-14513 (not yet built): will call `detectPrompt` from the setup driver
- EPMCDME-14588 (not yet built): will extend the return type with failure classifications

### Patterns and Conventions

- Existing JS modules in `ui/` are plain ES modules (`.js` or `.mjs`); they use `export function` rather than class hierarchies
- Test files live in `ui/test/*.test.mjs`, import the module under test by relative path, use `node:test` and `node:assert`
- The pure-parser pattern (split logic from I/O for testability) is already established in the Rust layer: `parse_config`, `parse_profile_status`, `parse_npm_latest` all separate parsing from filesystem or network calls
- Screen reading pattern: construct `new Terminal({ cols: 100, rows: 30, scrollback: 0 })`, write raw bytes, then iterate `terminal.buffer.active` lines from `baseY` through `baseY + rows - 1`, calling `.translateToString(true)` on each

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/testing/testing-patterns.md` — covers JS test conventions: `node:test`, `node:assert`, file naming `<module>.test.mjs`, placement under `ui/test/`; confirms `npm test` runs all JS tests
- `.ai-run/guides/architecture/architecture.md` — describes Frontend-brain + thin Rust backend (Option B); IPC via Tauri `invoke`; component map
- `.ai-run/guides/development/development-practices.md` — error handling, async patterns, naming conventions

### Architectural Decisions

- Option B architecture: all logic lives in `ui/`; Rust is thin I/O only. This ticket is 100% consistent with that decision.
- Zero new npm dependencies constraint is a project-wide rule, not ticket-specific; the vendored `xterm.mjs` path is the established workaround.

### Derived Conventions

- Parser modules are pure functions with no side effects; they accept data and return structured results
- Test files do not use a test runner framework (no Jest, no Mocha); `node:test` is the project standard
- Fixture data for JS tests is co-located under `ui/test/` (no separate `__fixtures__` root exists yet)

---

## 4. Testing Landscape

### Existing Coverage

- `ui/test/engine.test.mjs` — Engine orchestration (step sequencing, gates, fatal logic); imports `ui/engine.js`
- `ui/test/models.test.mjs` — StepStatus, STATUS_META, makeStep normalization
- `ui/test/version-utils.test.mjs` — semver utilities
- `ui/test/pty-bridge.test.mjs` — PTY bridge module
- `ui/test/steps-ui.test.mjs` — steps UI factory (landed in EPMCDME-14654)

None of the existing test files cover screen parsing, prompt detection, or xterm Terminal usage in Node.

### Testing Framework and Patterns

- Framework: `node:test` built-in (Node.js 18+), `node:assert/strict`
- Pattern: import module under test by relative path; stub collaborators inline; assert with `assert.deepStrictEqual` and `assert.ok`
- Run command: `npm test` (all JS) or `node --test ui/test/<file>.test.mjs` (single file)
- No DOM globals; no jsdom; no Tauri `invoke` in unit tests

### Coverage Gaps

- `ui/setup-parse.js` (new module) has zero tests — all 13 prompt-id detection paths are uncovered
- `ui/vendor/xterm.mjs` usage under Node (headless, no DOM) has no existing test exercising it
- The `gate` prompt fixture requires a separate capture path (no `--force`) vs. the other 12

---

## 5. Configuration and Environment

### Environment Variables

- No environment variables are specific to this module. `codemie setup --force` is the CLI invocation used for fixture capture (skips the gate prompt); a run without `--force` and with existing config is needed to capture the `gate` fixture.

### Configuration Files

- `ui/vendor/xterm.mjs` — vendored bundle; no build step or config file governs it
- `package.json` — `npm test` script runs `node --test ui/test/*.test.mjs`; no changes needed to pick up `setup-parse.test.mjs` if the glob already covers `ui/test/*.test.mjs`

### Feature Flags and Deployment Concerns

- No feature flags. The parser is a pure library module; it is not wired into the renderer or any view in this ticket (that is EPMCDME-14513 scope).

---

## 6. Risk Indicators

- **xterm.mjs Node compatibility unverified in tests**: `ui/vendor/xterm.mjs` is described as working in plain Node, but no existing test exercises it headlessly. If the vendor bundle uses any browser-only global (even lazily), the test suite will fail at import time. Validate early with a minimal smoke import before building the full parser.
- **`buffer.active` / `baseY` API surface**: The xterm `buffer.active` API and `baseY` property are the correct entry points for current-screen reading, but they depend on the vendored xterm version. The API must be verified against the actual bundle before finalising the parser implementation.
- **Fixture capture is a manual prerequisite**: The 13 fixture files must be captured from a real `codemie setup` run. If the CLI is not available in the dev environment, or if the prompt text differs from what is documented in the ticket, fixtures will need adjustment. The `gate` prompt requires a separate capture (run without `--force` against a machine that already has a config).
- **inquirer screen-erase behavior**: The parser's correctness depends on using `scrollback: 0` (or correctly restricting reads to the active viewport). Any deviation will cause answered prompts to persist in the scrollback and re-detect. This is a subtle correctness constraint with no existing test analog in the codebase.
- **Model list enumeration**: The task requires enumerating buffer rows until no new option text appears, and excluding the "Custom model (manual entry)..." terminal row from `options`. Off-by-one or inclusion of the Custom row are likely mistake surfaces.
- **No covering tests for `ui/terminal.js`**: The existing interactive terminal is untested. While this ticket does not modify it, the new headless usage of `xterm.mjs` is the first programmatic test of that vendor bundle, making it a first-of-kind integration.
- **`gate` prompt conditional path**: The `gate` id fires only when `!force && (hasGlobalConfig || hasLocalConfig)`. Its fixture requires a machine state with existing config; CI may not have this by default.

---

## 7. Summary for Complexity Assessment

This ticket is a self-contained frontend utility addition: one new pure-JS module (`ui/setup-parse.js`), one new test file (`ui/test/setup-parse.test.mjs`), and 13 fixture files under a new directory (`ui/test/fixtures/setup/`). It touches no Rust code, no existing modules, and no UI views. The architectural layer is narrow — purely the `ui/` utility layer — and the integration surface is a single import of `ui/vendor/xterm.mjs`. The `detectPrompt` function itself is a pure data transformation with a well-specified output shape.

The primary technical novelty is the headless-xterm screen-reading pattern, which has no prior usage in this codebase. The correctness of the approach depends on two xterm API details (`buffer.active`, `baseY`) and on constructing the Terminal with `scrollback: 0` to avoid answered-prompt re-detection. These are learnable constraints, not research unknowns, but they represent the sharpest edge in the implementation: a developer unfamiliar with xterm internals will need to experiment before writing a robust reader. Additionally, fixture capture requires a live `codemie setup` run, which is a one-time manual step that blocks the test file from passing until done.

Test coverage posture starts at zero for this area but the ticket is designed specifically to create coverage. The risk band is modest: the implementation is pure logic over an array of strings, the test framework is the project standard, and the deliverable boundary is tight. The main schedule risk is fixture availability (a real CLI run on a configured machine) and the unverified Node-compatibility of `ui/vendor/xterm.mjs` in a headless test context.

---

## 8. External References

None named by the task.
