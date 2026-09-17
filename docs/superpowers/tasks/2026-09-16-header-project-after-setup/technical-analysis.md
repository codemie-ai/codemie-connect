# Technical Research

**Task**: header identity renderer setup-wizard config
**Generated**: 2026-09-16T00:00:00Z
**Research path**: filesystem

---

## 1. Original Context

Fix EPMCDME-14987: after setup completion, the CodeMie Connect header does not display the selected project value. Confirmed root cause (do not re-derive from scratch, just confirm and gather exact context needed for a fix plan): renderIdentity() is called once, in the boot path at ui/renderer.js:544. The setup wizard runs `codemie setup` at step 2.3.3 (ui/handlers.js:81), which writes codeMieProject into ~/.codemie/codemie-cli.config.json. Nothing re-reads the config when the engine emits 'complete' (ui/renderer.js:143), so the header keeps whatever it read at boot. updateIdentityAuthStatus already re-reads config after sign-in at ui/renderer.js:384 - that's the pattern to follow for this fix (re-read config + re-render identity on 'complete'). Fix must be small: no boot-path restructuring, don't touch the Rust side (src-tauri/src/commands/codemie_config.rs already parses codeMieProject correctly and has tests for every state). Need to know: exact signature/behavior of renderIdentity() and updateIdentityAuthStatus(), what data structure they expect (esp. for codeMieProject/profile fields), how 'complete' event handler at ui/renderer.js:143 is structured today, whether there's an existing IPC command that returns parsed config (for Rust codemie_config.rs) callable from the renderer, and how ui/renderer.js is tested/verified today (no unit test file - it's DOM-bound, checked via SMOKE_PROBE in a built binary at ui/renderer.js:704) so we know where any new test should live.

---

## 2. Codebase Findings

### Existing Implementations

- `ui/renderer.js:229-241` — `function renderIdentity(cfg)`. Reads five fields off `cfg` (`state`, `account`, `profile`, `model`, `project`) and writes them into DOM nodes `#identity-product`, `#identity-account`, `#identity-profile`, `#identity-model`, `#identity-project` via a local `set(id, text)` helper (`textContent = text || ''`). `cfg.state === 'valid' || cfg.state === 'broken'` toggles whether `#identity-product` shows `'CodeMie Desktop'` or is cleared. Pure DOM-write function — no fetch inside it, takes the config object as its only argument, synchronous.
- `ui/renderer.js:245-257` — `function updateIdentityAuthStatus(st)`. Writes `#identity-auth-status` from a `{ state, detail }` shape (`signed_in` / `unknown` / `no_profile` / else `'Not signed in'`). This is the existing "re-read after an action, then re-render" pattern the ticket points at: called at boot (`renderer.js:537-541`, via `bridge.inspector.checkProfileStatus()`) and again after sign-in completes (`renderer.js:376-384`, inside `startSignIn()`, re-reading `bridge.inspector.checkProfileStatus()` then calling `updateIdentityAuthStatus(st)`).
- `ui/renderer.js:543-546` — the only call site of `renderIdentity`, inside `boot()`: `bridge.codemieConfig.read().then((cfg) => renderIdentity(cfg || {})).catch(() => renderIdentity({}))`. This runs once, at boot, before `handlers`/`engine` are even constructed (handlers is built at `renderer.js:553`, engine at `renderer.js:566`).
- `ui/renderer.js:101-153` — the `emit(event, payload)` sink passed into `new Engine(...)`. The `'complete'` case (`renderer.js:143-149`) currently does: `setInstallRunning(false)`, `setSprite(p.ok === false ? 'warning' : 'victory')`, unhide `closeBtn`/`wizardBack`, hide `installBtn`. It does not touch identity. `emit` is a plain synchronous function (not `async`), defined at module scope with access to all module-level bindings (`renderIdentity`, `bridge`, etc. are all in scope already).
- `ui/engine.js:50` — `this.emit('complete', { ok })` is the only place `'complete'` is emitted; payload shape is exactly `{ ok: boolean }`, confirming `emit`'s `case 'complete':` sees `p.ok`.
- `ui/runner-bridge.js:51-53` — `export const codemieConfig = { read: () => invoke('read_codemie_config') }`. This is the existing IPC wrapper the boot path already calls; it is the one and only bridge export for reading config, already `async`, already used by `renderIdentity`'s caller.
- `src-tauri/src/commands/codemie_config.rs:110-116` — `#[tauri::command] pub fn read_codemie_config() -> CodemieConfig`. Synchronous Rust command (not `async`), never errors (`Result` is not used — a missing/unreadable file yields `CodemieConfig::default()`, i.e. `state: NoConfiguration`). Returns `{ state, profile, model, project, account }` serialized kebab-case for `state`. Already covered by 7 unit tests (lines 118-182) for every state combination (`NoConfiguration`, `Valid`, `Broken`, absent account, Windows/Unix path). No changes to this file are indicated or needed for this fix.
- `ui/handlers.js:80-82` — handler `'2.3.3'` runs `codemie setup` via `runPty` (macOS) or `runExternalWindow` (Windows). This is the step that writes `codeMieProject` into the config file; the handler itself returns a boolean success/failure to the Engine and has no config-reading responsibility.

### Architecture and Layers Affected

- **Renderer / UI layer** (`ui/renderer.js`) — the only layer this fix needs to touch. Specifically the `emit()` function's `case 'complete':` branch (line 143-149).
- **Bridge layer** (`ui/runner-bridge.js`) — already exposes what's needed (`codemieConfig.read()`); no new export required.
- **Rust command layer** (`src-tauri/src/commands/codemie_config.rs`) — already exposes `read_codemie_config`; explicitly out of scope per the ticket.
- **Engine layer** (`ui/engine.js`) — emits `'complete'` with `{ ok }`; not modified by this fix, only consumed.

### Integration Points

- `renderIdentity(cfg)` ← `bridge.codemieConfig.read()` ← `invoke('read_codemie_config')` ← Rust `read_codemie_config()` ← `~/.codemie/codemie-cli.config.json`. This full chain already exists and is exercised once at boot; the fix is to invoke the same chain again from the `'complete'` handler.
- `updateIdentityAuthStatus(st)` ← `bridge.inspector.checkProfileStatus()` — the sibling identity element following the identical "action completes → re-read → re-render" shape, used as the reference pattern per the ticket text.

### Patterns and Conventions

- Re-read-then-render pattern already established for the auth-status segment (`startSignIn()`, `renderer.js:376-384`): `try { st = await bridge.X.read() } catch { st = <fallback> } ; updateY(st)`.
- `renderIdentity` itself already follows a `.then(cfg => renderIdentity(cfg || {})).catch(() => renderIdentity({}))` shape at its boot call site — the same defensive fallback-to-`{}` idiom would apply to any second call site.
- `emit()`'s `case` branches are synchronous; adding an `await`ed re-read inside `case 'complete':` would make that one branch async relative to the rest of the switch — comments in the file (e.g. line 100) note `emit` is currently a plain synchronous dispatch, so this is the one structural wrinkle to be aware of, not a blocker.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/architecture/architecture.md` — describes the frontend-brain + thin Rust backend (Option B) and IPC pattern; not read in full here but named by AGENTS.md as the P1 guide for development tasks in this domain.
- `.ai-run/guides/testing/testing-patterns.md` — read in full (see Section 4).
- `.ai-run/guides/development/development-practices.md` — named by AGENTS.md as P0 for "add features, fix bugs" tasks; not read in this pass (task_context already supplies the confirmed root cause and constraints, so the guide's error-handling/naming conventions can be pulled by the fix author directly if needed).

### Architectural Decisions

- Inline comment at `ui/runner-bridge.js:46-50` documents the `codemieConfig` contract explicitly: the three `state` values, and that `account: null` is a deliberate "absent, not unread" signal distinct from `no-configuration`.
- Inline comment at `src-tauri/src/commands/codemie_config.rs:1-12` records why the config file (not `codemie profile status` or a shell-spawning `runCapture`) is the identity bar's data source, and why `read_codemie_config` deliberately never fails.
- Prior ticket EPMCDME-14505's lens-verification-gap.json (`docs/superpowers/tasks/2026-09-02-EPMCDME-14505-bundle-shim-runtime-path/lens-verification-gap.json:24`) already flagged a related but distinct risk: on Windows without `HOME` set, `read_codemie_config` silently returns `no-configuration` even with a valid config file, so `renderIdentity` shows the product-name fallback instead of real values. That is a different bug (env-var fallback) from EPMCDME-14987 (missing re-render trigger) but touches the same function.

### Derived Conventions

- Identity-bar changes in this codebase are consistently verified with Playwright specs stored under `docs/superpowers/tasks/<ticket-dir>/dynamic-tests/*.spec.ts`, not `ui/test/*.mjs` — see Section 4.

---

## 4. Testing Landscape

### Existing Coverage

- No `ui/test/*.mjs` file references `renderIdentity`, `updateIdentityAuthStatus`, `identity-project`, or `codemieConfig` at all — `renderer.js` has no unit-test file (it is not itself imported by any `ui/test/*.test.mjs`; those cover `engine.js`, `models.js`, `steps-ui.js`, `auth-gate.js`, `signin-parse.js`, `setup-driver.js`, etc., all imported directly, whereas `renderer.js` is the boot script itself, referenced only from `index.html`).
- Real DOM-level coverage of the identity bar exists as **Playwright specs**, not `node:test`, under prior ticket folders:
  - `docs/superpowers/tasks/2026-08-31-epmcdme-14511/dynamic-tests/identity-bar-config.spec.ts` — boots the page with a stubbed `window.__TAURI__.core.invoke` (a plain `Record<string, unknown>` keyed by command name, e.g. `read_codemie_config`), then asserts `#identity-project` etc. text/visibility for SSO, API-key, no-config, and broken-config states. This is the closest existing template for a "does the header show the right project" test.
  - `docs/superpowers/tasks/2026-08-31-epmcdme-14511/dynamic-tests/identity-bar-recheck.spec.ts` and `identity-geometry-dump.spec.ts` also read `#identity-project` (pre/post comparisons), suggesting a "recheck" pattern already exists for re-reading identity state after an event — worth opening if the fix's own tests follow that shape.
  - `docs/superpowers/tasks/2026-08-31-epmcdme-14511/dynamic-tests/app-shell-navigation.spec.ts:150,157,171` also asserts on `#identity-project`.
- `ui/renderer.js:688-745` — `runSmoke()` / `SMOKE_PROBE` (invoked via `CODEMIE_SMOKE=1` against a **built binary**) dumps the identity bar's live text (`renderer.js:704-707`) as one line of evidence, per the ticket's own note. This is a manual/CI smoke check, not a per-PR automated assertion of the fix's behavior.

### Testing Framework and Patterns

- JS unit tests: Node's built-in `node:test` + `node:assert/strict`, run via `npm test` → `node --test ui/test/*.test.mjs` (`package.json:8`). No mocking library; Tauri `invoke` is never unit-tested directly per `.ai-run/guides/testing/testing-patterns.md:68`.
- DOM/e2e tests: Playwright, run via `npm run test:ui` → `cd docs/superpowers/tasks/2026-08-31-epmcdme-14511/dynamic-tests && npx playwright test` (`package.json:9`). These specs stub `window.__TAURI__` entirely (`identity-bar-config.spec.ts:41-49`) and load `/index.html` directly — no Tauri runtime needed.
- Rust: inline `#[cfg(test)]` modules per file, `cargo test`.

### Coverage Gaps

- No existing automated test exercises the `'complete'` event handler's effect on the identity bar (only its `setSprite`/button-visibility effects are covered indirectly via `engine.test.mjs`'s assertions on the `complete` event itself, which stub `emit` and never touch the real DOM-writing `emit()` in `renderer.js`).
- `renderer.js`'s own `emit()` function is never imported/unit-tested anywhere — it is only exercised via Playwright loading the real `index.html`/`renderer.js`, or via the built-binary smoke modes. Any new test for this fix will need to follow the Playwright pattern (stub `invoke`, drive an install run or simulate `'complete'`, assert `#identity-project`) rather than a `node:test` unit test, since `renderer.js` has no exported surface to import.
- The Playwright test config's location under a specific prior-ticket's `dynamic-tests/` directory (`docs/superpowers/tasks/2026-08-31-epmcdme-14511/dynamic-tests`) rather than a stable top-level `tests/` or `e2e/` directory is itself worth flagging — new specs for this fix would need to either add to that existing directory (per `package.json:9`'s hardcoded path) or the plan should decide where a 14987-specific spec belongs.

---

## 5. Configuration and Environment

### Environment Variables

- `HOME` / `USERPROFILE` — read by `config_path()` in `src-tauri/src/commands/codemie_config.rs:96-102` to locate `~/.codemie/codemie-cli.config.json`. Not touched by this fix.
- `CODEMIE_DEV=1` — gates exposing `window.__codemie` dev hooks in `boot()` (`renderer.js:482-485`); unrelated to this fix but present in the same file.
- `CODEMIE_SMOKE` / `CODEMIE_PROBE_SMOKE` — gate `runSmoke()` / `runProbe()` in `renderer.js`, which dump `#identity-project` text as part of `SMOKE_PROBE` output (`renderer.js:704-707`).

### Configuration Files

- `~/.codemie/codemie-cli.config.json` — the runtime config file `codemie setup` writes to and `read_codemie_config` reads from; not a repo file, user-machine state.
- No repo-tracked config file (`.env`, `settings.py`-equivalent) governs the identity bar; it is entirely driven by the runtime file above plus the two IPC commands (`read_codemie_config`, `check_profile_status`).

### Feature Flags and Deployment Concerns

- None found specific to the identity bar or the `'complete'` handler. `flags.dev` / `flags.smoke` / `flags.probe` (from `invoke('smoke_mode')`, `renderer.js:470`) are the only runtime toggles in `boot()`, and none of them affect the fix's target code path (`emit()`'s `'complete'` case runs during a normal wizard run in all modes).

---

## 6. Risk Indicators

- `emit()` in `renderer.js` is a synchronous dispatcher; adding an `await`ed config re-read inside `case 'complete':` makes that one case asynchronous while every other case stays synchronous — Speculative: the fix will need to decide whether to make `emit` itself `async` (all callers already treat it as fire-and-forget, so this is likely low-risk, but it is a shape change worth calling out explicitly in the plan) or fire-and-forget the re-read inside the case without awaiting it, mirroring `startSignIn()`'s pattern loosely.
- No automated test currently exercises `renderer.js`'s `emit()`/`'complete'` path against the real DOM; verification for this fix will most likely mean adding to (or extending) a Playwright spec such as `identity-bar-config.spec.ts`, which lives under a previous ticket's task folder rather than a stable shared test directory — Speculative: the plan should decide whether the new spec belongs in that existing file/directory or a new one, since `package.json:9`'s `test:ui` script path is hardcoded to `docs/superpowers/tasks/2026-08-31-epmcdme-14511/dynamic-tests`.
- A related but distinct bug is already on record (EPMCDME-14505's lens-verification-gap.json): `read_codemie_config` can silently return `no-configuration` on Windows if `HOME`/`USERPROFILE` resolution fails, which would make a re-render-on-complete fix *appear* not to work in that specific environment even once implemented correctly. Worth flagging so a failed manual verification in that environment isn't mistaken for the fix itself being wrong.
- `renderIdentity({})` is the documented fallback shape on read failure (`renderer.js:546`); any second call site added for this fix should preserve the same `cfg || {}` defensive pattern used at boot.

---

## 7. Summary for Complexity Assessment

This is a small, well-localized renderer-layer fix. The full data path already exists end-to-end and is exercised once at boot: `ui/renderer.js:544` (`bridge.codemieConfig.read()`) → `ui/runner-bridge.js:52` (`invoke('read_codemie_config')`) → `src-tauri/src/commands/codemie_config.rs:111` (already tested, out of scope) → `renderIdentity(cfg)` at `ui/renderer.js:229`. The only gap is that this chain is never re-run after the setup wizard completes. The fix's natural site is the `case 'complete':` branch of the `emit()` function at `ui/renderer.js:143-149`, which currently only manages sprite/button state and has no config-reread logic. The closest existing precedent for "re-read then re-render" is `updateIdentityAuthStatus` after sign-in (`renderer.js:376-384`), which the ticket already points to.

Technical novelty is low — no new IPC commands, no Rust changes, no new data shapes; the change is additive within a single existing function. The one structural wrinkle is that `emit()` is currently synchronous while the needed re-read is async (`bridge.codemieConfig.read()` returns a Promise), so the plan needs to decide how the `'complete'` case awaits or fires-and-forgets that read without disrupting the other synchronous cases in the same switch.

Test coverage posture is the main risk factor: `renderer.js` has no `node:test` unit-test file at all (it's the boot script with no exported surface), so verification of the fix will need to extend the existing Playwright DOM-level suite (e.g. `docs/superpowers/tasks/2026-08-31-epmcdme-14511/dynamic-tests/identity-bar-config.spec.ts`, which already stubs `read_codemie_config` and asserts on `#identity-project`) rather than add a new unit test — and that suite currently lives under a different ticket's task folder, hardcoded into `package.json`'s `test:ui` script, which the plan should account for when deciding where a regression test for this fix belongs.

---

## 8. External References

None named by the task. `task_context` names only in-repo file paths and line numbers (`ui/renderer.js:544`, `ui/handlers.js:81`, `ui/renderer.js:143`, `ui/renderer.js:384`, `ui/renderer.js:704`, `src-tauri/src/commands/codemie_config.rs`) as the confirmed root cause, all of which were read directly and are cited by path/line above rather than treated as an external source of truth.
