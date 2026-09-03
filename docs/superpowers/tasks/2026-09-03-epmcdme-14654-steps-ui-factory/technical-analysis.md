# Technical Research

**Task**: steps-ui factory DOM rendering
**Generated**: 2026-09-03T00:00:00Z
**Research path**: codegraph

---

## 1. Original Context

EPMCDME-14654 — steps-ui factory (instantiable step lists). Make ui/steps-ui.js instantiable, so more than one step list can exist at once. Today it holds one module-global registry (rows and listEl at :13-15), and renderSteps (:56) reassigns listEl, empties the container and clears rows — the legacy install engine is its only user. When an id is missing from rows most functions quietly no-op (setStatus, setSubtitle, startSpinner, setProgress); stopSpinner is driven by a separate spinners map and never consults rows; insertSubStep does NOT no-op — it builds the row unconditionally and, failing to find the parent, appends it to whichever container owns the module-global listEl, so a sub-step can render into the wrong view. Refactor so each list owns its own rows/spinners/listEl/stepsById: a factory createStepsUi() returning an instance with the same nine functions: renderSteps, setStatus, setSubtitle, startSpinner, stopSpinner, setProgress, insertSubStep, showApproval, stampApproval. Keep the existing module-level exports working as a default instance so the legacy engine's call sites (ui/renderer.js, the steps-ui import) need no change. Add ui/test/steps-ui.test.mjs: two instances rendered into two containers update independently, and insertSubStep on one never appends into the other's container. Caveat: ui/steps-ui.js does not import ui/models.js — it has its own private STATUS_META copy at :3-10, rendered at :47; do not touch STATUS_META icons/colours, this is a structural refactor only. Repo has zero npm devDependencies by design; tests use node:test and a minimal test-only DOM stub (no jsdom) kept inside ui/test/. Need to find: current full source of ui/steps-ui.js, all its call sites (ui/renderer.js and anywhere else steps-ui is imported), existing test patterns in ui/test/ (e.g. from EPMCDME-14511's Playwright/node:test suite) to match style, and package.json test script to confirm how tests run (node:test via npx or plain node).

---

## 2. Codebase Findings

### Existing Implementations

- `ui/steps-ui.js` — The module under refactor. 140 lines. Holds four module-global state variables at lines 13–16: `rows` (Map, id → DOM record), `spinners` (Map, id → interval handle), `let listEl` (container element), `let stepsById` (Map, id → step data). Exports nine named functions. Two private helpers (`buildRow`, `applyStatus`) close over all four globals. `buildRow` writes to `rows` at line 39; `applyStatus` reads from `rows` and `spinners` and calls `stopSpinner`. `insertSubStep` falls back to module-global `listEl` at line 107 when the parent row's `nextSibling` is absent — the reported cross-instance contamination bug.
- `ui/renderer.js` — The sole caller of steps-ui. Imports all exports as a namespace (`import * as stepsUI`) and calls `stepsUI.renderSteps(stepListEl, steps)` at line 196 inside `enterWizard`. Additional calls to `setStatus`, `setSubtitle`, `startSpinner`, `stopSpinner`, `setProgress`, `insertSubStep`, `showApproval`, `stampApproval` are made from the `emit` event handler that wires Engine events to the UI. The namespace import means all nine named exports are accessed as `stepsUI.<fn>`.
- `ui/models.js` — Exports `StepStatus`, `STATUS_META`, and `makeStep`. `steps-ui.js` does NOT import this file; it carries a private inline copy of `STATUS_META` at lines 3–10 with identical icons and colors. This duplication is intentional per the task and must not be touched.
- `ui/engine.js` — Orchestration engine. Consumed by `renderer.js`. Emits events that renderer.js routes into stepsUI calls. Not directly coupled to steps-ui.

### Architecture and Layers Affected

- **Frontend UI layer** (`ui/`) — the only layer involved. `ui/steps-ui.js` is pure DOM manipulation with no Tauri IPC, no Rust, no backend calls.
- **No backend layer change** — `src-tauri/` is unaffected. The Rust `Step` struct and `get_steps` command are unchanged.

### Integration Points

- `ui/renderer.js` → `ui/steps-ui.js`: namespace import (`import * as stepsUI`). All nine exports are consumed. This is the only import of steps-ui in the codebase.
- `ui/renderer.js` → `ui/engine.js`: `Engine` is instantiated in `enterWizard`; engine events are routed to `stepsUI.*` calls via the `emit` callback.
- The `stepsById` map is populated in `renderSteps` (line 60) but is not read by any of the nine exported functions in the current implementation — it is populated but unused internally.

### Patterns and Conventions

- All UI modules are plain ESM with named exports; no classes, no default exports used elsewhere for stateful modules.
- `ui/renderer.js` uses the namespace-import pattern (`import * as stepsUI`) which gives the legacy call sites a stable object — a default instance re-exported as named exports satisfies this without changing the import statement.
- `buildRow` and `applyStatus` are private (non-exported) helpers; the factory pattern must keep them private to the instance closure, not promoted to exports.
- No npm dependencies by design — no lodash, no class utilities, pure closure/Map patterns throughout.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/architecture/architecture.md` — Frontend-brain + thin Rust backend (Option B), IPC pattern, component map. Confirms `ui/` is the frontend brain layer.
- `.ai-run/guides/testing/testing-patterns.md` — Documents the `node:test` + `node:assert` pattern, naming conventions, and that JS tests live in `ui/test/*.test.mjs`. Confirms `npm test` runs `node --test ui/test/*.test.mjs`.
- `.ai-run/guides/development/development-practices.md` — Error handling, async patterns, naming conventions for the frontend layer.

### Architectural Decisions

- The guide explicitly states "Repo has zero npm devDependencies by design" — confirmed by `package.json` having no `devDependencies` key. This constrains the DOM stub to be hand-written for tests.
- `ui/steps-ui.js` intentionally duplicates `STATUS_META` rather than importing `ui/models.js`; this is a recorded structural decision (ticket caveat).

### Derived Conventions

- Test files import the module under test with a relative path from `ui/test/` (e.g., `import { Engine } from '../engine.js'`).
- Fixture data is built with a local helper function (e.g., `mkSteps()` in `engine.test.mjs`) rather than loaded from files.
- `node:test` and `node:assert` (strict) are the only imports in test files besides the module under test.
- DOM-touching modules have no existing `node:test` coverage; prior tests in the suite cover pure-logic modules (`engine.js`, `models.js`, `version-utils.js`, `pty-bridge.js`). The steps-ui test will be the first DOM-touching test in the suite, requiring a hand-built DOM stub.

---

## 4. Testing Landscape

### Existing Coverage

- `ui/test/engine.test.mjs` — Engine orchestration: step sequencing, fatal logic, approval gates. Uses `mkSteps()` fixture helper. No DOM dependency.
- `ui/test/models.test.mjs` — `StepStatus`, `STATUS_META`, `makeStep` normalization. Pure data, no DOM.
- `ui/test/version-utils.test.mjs` — Version string utilities. Pure logic.
- `ui/test/pty-bridge.test.mjs` — PTY bridge logic.
- `docs/superpowers/tasks/2026-08-31-epmcdme-14511/dynamic-tests/identity-bar-config.spec.ts` — Playwright integration test for the identity bar. Not part of `npm test`; run separately via `npm run test:ui`.

### Testing Framework and Patterns

- Framework: `node:test` (Node.js built-in), `node:assert` strict mode.
- Runner: `node --test ui/test/*.test.mjs` (invoked by `npm test` per `package.json:8`).
- No jsdom, no testing-library, no sinon. DOM stubs for steps-ui must be crafted inline or in a shared stub file inside `ui/test/`.
- Fixture pattern: local `mk*` helper returns plain object arrays.
- Async tests use `async` test callbacks; sync tests use synchronous callbacks.

### Coverage Gaps

- `ui/steps-ui.js` has zero test coverage — confirmed by codegraph "no covering tests found" for `renderSteps`, `stepsById`, and all related symbols.
- The `insertSubStep` cross-container bug has no regression test.
- Multi-instance isolation (the core requirement of this ticket) is entirely untested.

---

## 5. Configuration and Environment

### Environment Variables

- No environment variables govern `ui/steps-ui.js` behavior. `CODEMIE_SMOKE` and `CODEMIE_PROBE_SMOKE` affect the renderer smoke mode but not the step-list rendering logic.

### Configuration Files

- `package.json` (root) — defines `"test": "node --test ui/test/*.test.mjs"`. A new file `ui/test/steps-ui.test.mjs` will be picked up automatically by the glob without any config change.
- No Vite, no webpack, no bundler config for the `ui/` layer — files are loaded as native ESM by Tauri's asset server.

### Feature Flags and Deployment Concerns

- No feature flags. The refactor is purely structural; the rendered output is identical to the current module-global behavior for a single instance.

---

## 6. Risk Indicators

- **`insertSubStep` fallback to module-global `listEl` (ui/steps-ui.js:107)** — the documented cross-container bug; the factory refactor must eliminate this by scoping `listEl` per instance.
- **`applyStatus` calls `stopSpinner` internally (ui/steps-ui.js:49)** — `stopSpinner` reads from `spinners`; both helpers must close over the same instance-scoped `spinners`, not two separate maps. If the factory creates the helpers as closures over instance state, this coupling is automatically correct, but the wiring must be verified.
- **`buildRow` calls `applyStatus` (line 40), which calls `stopSpinner` (line 49)** — a three-deep private call chain all closing over module globals. Moving all four state variables (`rows`, `spinners`, `listEl`, `stepsById`) into the factory closure is the minimal correct change; any partial scoping leaves a latent bug.
- **`stepsById` is populated but never read by exported functions** — the variable is populated in `renderSteps` and silently unused inside the module. The factory must carry it per-instance for completeness, but its current dead-code status means no caller depends on it being accurate post-refactor.
- **Namespace import in renderer.js (`import * as stepsUI`)** — the default instance must be re-exported as the same nine named exports that renderer.js consumes. A factory that only exports `createStepsUi` without re-exporting the default instance's methods would break renderer.js without any import-statement change being visible.
- **No existing DOM test infrastructure** — the `ui/test/` suite has never needed a DOM stub. The steps-ui test is the first; the stub must cover `createElement`, `innerHTML` assignment, `querySelector`, `classList.toggle`, `dataset`, `appendChild`, `insertBefore`, `parentNode.insertBefore`, `nextSibling`, `setInterval`, `clearInterval`, and `textContent`. An incomplete stub will produce silent wrong-behavior rather than explicit errors.
- **`setInterval`/`clearInterval` in spinners** — tests that call `startSpinner` will start real timers unless the DOM stub replaces them. Leaked timers cause `node --test` to hang. The stub or test teardown must clear all intervals.

---

## 7. Summary for Complexity Assessment

The task touches a single frontend file (`ui/steps-ui.js`, 140 lines) and adds one new test file (`ui/test/steps-ui.test.mjs`). The call surface in `ui/renderer.js` is a namespace import consuming all nine exported functions; the legacy call sites need no change provided the default instance re-exports each function at the module level. The architectural layer affected is exclusively the frontend UI layer — no IPC, no Rust, no config changes. The refactor is a pure structural change: lift four module-globals (`rows`, `spinners`, `listEl`, `stepsById`) into a factory-function closure, reconstruct the two private helpers (`buildRow`, `applyStatus`) as inner functions closing over that instance state, wrap the nine exported functions as an object returned by `createStepsUi()`, then create a default instance whose methods are re-exported as the existing named exports.

Technical novelty is low for the production change: the factory/closure pattern is idiomatic JS and the codebase uses Maps and closures throughout. The higher-novelty work is the test file: `ui/test/steps-ui.test.mjs` will be the first DOM-touching test in the suite and must supply a hand-crafted DOM stub (no jsdom, by repo policy) covering approximately ten DOM API surface points. The `setInterval`/`clearInterval` pair used by spinners must be shim-controlled to prevent timer leaks that hang `node --test`. The two mandated test assertions — two instances update independently, and `insertSubStep` on one never appends into the other's container — are well-scoped and do not require a full browser environment.

The primary risk is the `setInterval` leak in the spinner path and the completeness of the DOM stub. The `insertSubStep` fallback-to-`listEl` bug is the specific isolation failure the ticket targets; it is straightforward to fix within the factory scope but must have a covering test to prevent regression. All existing `stepsUI.*` call sites are in `ui/renderer.js` alone (2 direct calls visible; additional calls via the `emit` handler), so blast radius outside the two changed files is limited to confirming the namespace import still resolves. No test in the existing suite covers `ui/steps-ui.js`, so the new test file is net-new coverage with no conflicts.

---

## 8. External References

None named by the task.
