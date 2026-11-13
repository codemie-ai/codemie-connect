# Technical Research

**Task**: cmdlog ui failure-mapping clipboard tauri
**Generated**: 2026-09-24T00:00:00Z
**Research path**: filesystem

---

## 1. Original Context

EPMCDME-15232: CodeMie Desktop: Command log - UI, failure mapping and copy-all. Slice 3 of 3. Render command-log records (from the store built in slices 1/2: EPMCDME-15230 cmdlog IPC/store, EPMCDME-15231 bridge instrumentation) into the existing #command-log-footer / #command-log-body HTML region. Requirements: one row per command newest-first, reuse existing CSS classes (.log-line .log-stdout .log-stderr .log-info .log-success .log-dim .log-prompt), do NOT reuse ui/log.js window-resizing expand behavior. Expose opening one specific record by ID. Add a plain-language failure-mapping ES module with its own test mirroring app-updater-utils.mjs. Cover: non-zero exit with no output, network error string, command-not-found. Add tauri-plugin-clipboard-manager Cargo dependency with capabilities/permissions. Wire Copy-all to browser clipboard API (window.isSecureContext + navigator.clipboard) with plugin fallback, inside click handler for user activation.

---

## 2. Codebase Findings

### Existing Implementations

**Slices 1 and 2 are both fully landed:**

- `src-tauri/src/commands/cmdlog.rs` (213 lines) — `CmdRecord { id, command, start_time, exit_code, duration_ms, raw_output }` and `CmdLogStore` with `open`, `append`, `close`, `list`, `get` methods. Five `#[tauri::command]` functions registered: `cmdlog_open`, `cmdlog_append`, `cmdlog_close`, `cmdlog_list`, `cmdlog_get`. Full inline `#[cfg(test)]` coverage (7 tests).
- `src-tauri/src/state.rs` line 41 — `pub cmdlog: Mutex<crate::commands::cmdlog::CmdLogStore>` on `AppState`.
- `src-tauri/src/lib.rs` lines 122–126 — all five cmdlog commands in `generate_handler!`.
- `ui/runner-bridge.js` lines 15–19 — `export const cmdlog = { open, append, close }` wrapping `cmdlog_open`, `cmdlog_append`, `cmdlog_close`. `cmdlog_list` and `cmdlog_get` are **not** exposed in the bridge yet.
- `ui/runner-bridge.js` — cmdlog wrapping fully wired on `runner.runCapture`, `runner.runFreshEnv`, `runner.runStream`, `pty.spawnPty`, `updater.runSelfUpdate`.
- `ui/ansi-strip.mjs` (4 lines) — stateless regex-based ANSI stripper, default export `stripAnsi`.
- `ui/test/ansi-strip.test.mjs` — 6 tests (CSI, OSC, plain text, partial escape, chunk boundary, TextDecoder UTF-8 streaming).
- `ui/test/cmdlog-bridge.test.mjs` — 9 tests covering full bridge instrumentation for all five paths.

**HTML region (ui/index.html lines 231–237):**
```html
<!-- Hidden for v1, not deleted: nothing writes to #command-log-body yet -->
<details id="command-log-footer" class="hidden">
  <summary>what CodeMie ran</summary>
  <div id="command-log-body"></div>
</details>
```
Currently hidden and empty. No Copy-all button. No record rows.

**CSS (ui/styles.css lines 145–164, 543–549):**
- `#command-log-footer`: `<details>` styled with `border-top`, `background: var(--panel-dark)`, `font-family: var(--font-mono)`, `font-size: 12px`, `max-height: 40vh`, `overflow-y: auto`.
- `#command-log-footer > summary`: `padding: 8px 16px`, `cursor: pointer`, `▸`/`▾` `::before` marker via CSS.
- `#command-log-body`: `padding: 0 16px 10px`.
- `.log-line`, `.log-stdout`, `.log-stderr`, `.log-info`, `.log-success`, `.log-dim`, `.log-prompt` — all present (lines 543–549).

**ui/log.js (34 lines):** `initLog` + `appendLine` bound to `#log-content`/`#log-panel` (wizard-view's collapsible log). Toggles window height via `invoke('set_window_height', ...)`. This is the "window-resizing expand behavior" the task explicitly forbids reusing. The command-log footer uses a native `<details>` element instead, which has no window-resize behavior.

**ui/app-updater-utils.mjs (7 lines) + ui/test/app-updater-utils.test.mjs (25 lines):** The exact pattern to mirror for the failure-mapping module — one exported pure function, one `node:test` file importing it, no mocking.

**ui/renderer.js (869 lines):** `boot()` initializes all subsystems. Currently calls `initLog(...)` (line 577) and `initTerminal(...)` (line 583) but has no cmdlog-UI initialization. The `#command-log-footer` element is not referenced anywhere in `renderer.js`.

**Cargo.toml:** `tauri-plugin-clipboard-manager` is absent from `[dependencies]`. The plugin block in `tauri.conf.json` is an empty object `{}`. The `capabilities/default.json` contains only `"core:default"`.

**tauri.conf.json line 25:** CSP is `"default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ipc: http://ipc.localhost"`. Tauri apps run on `ipc://localhost` which is a secure context; `navigator.clipboard` is available.

### Architecture and Layers Affected

- **UI rendering layer (new)**: a new `ui/cmdlog-ui.js` module that fetches records via `invoke('cmdlog_list')` and renders into `#command-log-body`; exposes `initCmdLog` (called from `renderer.js`'s `boot()`) and `openCmdLogRecord(id)`.
- **Frontend IPC bridge layer** (`ui/runner-bridge.js`): needs `list` and `get` methods added to the existing `export const cmdlog` object — thin `invoke('cmdlog_list')` and `invoke('cmdlog_get', { id })` wrappers.
- **Rust backend layer** (`src-tauri/src/lib.rs`): needs `.plugin(tauri_plugin_clipboard_manager::init())` added to the `Builder::default()` chain.
- **Cargo layer** (`src-tauri/Cargo.toml`): needs `tauri-plugin-clipboard-manager = "2"` in `[dependencies]`.
- **Capabilities layer** (`src-tauri/capabilities/default.json`): needs `"clipboard-manager:allow-write-text"` added to the `permissions` array.
- **HTML layer** (`ui/index.html`): needs a Copy-all button inside `#command-log-footer`, positioned so the click handler fires inside user activation.

### Integration Points

- `invoke('cmdlog_list')` → `cmdlog_list` Tauri command → `CmdLogStore::list()` → `Vec<CmdRecord>` in insertion order. The UI renders newest-first by reversing this array.
- `invoke('cmdlog_get', { id })` → `cmdlog_get` → `Option<CmdRecord>`.
- `navigator.clipboard.writeText(text)` — browser API available in secure context (Tauri's `ipc://` is secure). Fallback: `window.__TAURI__.clipboardManager.writeText(text)` from `tauri-plugin-clipboard-manager`.
- `<details id="command-log-footer">` — the panel's native `toggle` event fires on open/close; re-fetching `cmdlog_list` on `toggle` keeps rows current without polling.
- `renderer.js`'s `boot()` — the natural place to call `initCmdLog(...)`, following the `initLog`/`initTerminal` pattern at lines 577–589.

### Patterns and Conventions

- **Pure function module + test**: `app-updater-utils.mjs` / `app-updater-utils.test.mjs` — one exported function, no mocking, `node:test` + `node:assert/strict`. The failure-mapping module follows this shape exactly.
- **Bridge pattern**: `cmdlog` export in `runner-bridge.js` is a plain object — `list` and `get` are added as additional method entries, following the same `invoke()` wrapper pattern as `open`, `append`, `close`.
- **No log.js reuse**: the `<details>` element expands natively without JS; no `set_window_height` call; this is architecturally separate from `#log-panel`.
- **CSS tag classes**: `.log-line.log-stdout` (green/white text), `.log-line.log-stderr` (red), `.log-line.log-success` (success green), `.log-line.log-dim` (muted) — reused as-is per the task's instruction.
- **User activation**: `navigator.clipboard.writeText` must be called inside a synchronous user-gesture handler (click), not in a promise chain that resumed after an await. The Copy-all button's `onclick` is the correct location.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/architecture/architecture.md` — confirmed present; "Adding New System Commands" 6-step checklist; IPC pattern; Option B architecture. All Rust steps complete for cmdlog. The new JS module and bridge additions follow the established pattern.
- `.ai-run/guides/testing/testing-patterns.md` — confirmed present; `node:test` + `node:assert/strict`; `ui/test/*.test.mjs` glob; Rust inline `#[cfg(test)]`.
- `.ai-run/guides/development/development-practices.md` — present; not read in detail; error-handling and async patterns guide.

### Architectural Decisions

- **EPMCDME-14511**: `#command-log-footer`, `#command-log-body`, and all `.log-*` CSS classes were landed in this prior ticket and are inert until this task fills them.
- **EPMCDME-15230/15231**: Rust store and JS bridge instrumentation fully complete — this task is exclusively the UI rendering, failure mapping, and clipboard layer.
- **`<details>` for expansion**: the native `<details>` element provides expand/collapse without the `set_window_height` Tauri call that `ui/log.js` makes. This satisfies "do NOT reuse ui/log.js window-resizing expand behavior."
- **CR-005** (inline in `runner-bridge.js`): both PTY listeners inside the try/finally; any new cmdlog-UI listener on a Tauri event must follow the same cleanup pattern if added.

### Derived Conventions

- No bundler, no ESLint, no Prettier — files are ES modules loaded directly by Tauri's WebView.
- New UI module lives in `ui/` alongside `log.js`, `terminal.js`.
- New pure-function utility lives in `ui/` with `.mjs` extension (following `app-updater-utils.mjs`, `ansi-strip.mjs`).
- Test file for it lives in `ui/test/*.test.mjs` to match the `node --test ui/test/*.test.mjs` glob.

---

## 4. Testing Landscape

### Existing Coverage

- `ui/test/cmdlog-bridge.test.mjs` (9 tests) — full coverage of bridge instrumentation (runStream, runCapture, runFreshEnv, spawnPty, runSelfUpdate); CR-006 null-result skip; CR-007 close waits for pending appends; CR-008 pty.kill() path.
- `ui/test/ansi-strip.test.mjs` (6 tests) — CSI/OSC stripping, plain text, partial escape boundary, TextDecoder UTF-8 split chunk.
- `ui/test/app-updater-utils.test.mjs` (4 tests) — direct precedent pattern for failure-mapping tests.
- `src-tauri/src/commands/cmdlog.rs` inline tests (7 tests) — store lifecycle, error paths, insertion order, overlapping records.

### Testing Framework and Patterns

- JS: Node built-in `node:test` + `node:assert/strict`. No framework. `npm test` = `node --test ui/test/*.test.mjs`.
- Rust: `cargo test`, inline `#[cfg(test)] mod tests { use super::*; }`.
- Mocking: mutable delegate pattern in bridge tests; pure-function tests (like `app-updater-utils`) require no mocking.

### Coverage Gaps

- No existing test for the failure-mapping module (greenfield; `ui/test/cmdlog-failure-map.test.mjs` needed).
- No existing test for the cmdlog UI rendering module (`ui/cmdlog-ui.js` is new; rendering logic could be tested via DOM stubs or deferred to manual verification since it touches the DOM).
- No existing test for the Copy-all clipboard path (no clipboard code exists anywhere in the app today).
- No existing test for `cmdlog.list` / `cmdlog.get` bridge wrappers (not yet added to the bridge).

---

## 5. Configuration and Environment

### Environment Variables

- No environment variable governs the command-log UI rendering. The panel is always present in the DOM once un-hidden.
- `CODEMIE_SMOKE=1` / `CODEMIE_PROBE_SMOKE=1` — existing smoke-mode toggles; smoke runs will produce cmdlog records via the instrumented bridge, so the panel will have rows to render after a smoke run. No special handling needed.

### Configuration Files

- `src-tauri/Cargo.toml` — needs `tauri-plugin-clipboard-manager = "2"` added to `[dependencies]`. Regenerates `src-tauri/gen/schemas/acl-manifests.json` on next `cargo build`.
- `src-tauri/capabilities/default.json` — currently `"permissions": ["core:default"]`; needs `"clipboard-manager:allow-write-text"` added.
- `src-tauri/src/lib.rs` — the `tauri::Builder::default()` chain needs `.plugin(tauri_plugin_clipboard_manager::init())` before `.invoke_handler(...)`.
- `src-tauri/tauri.conf.json` — `"plugins": {}` is currently empty; plugin configuration for `clipboard-manager` in Tauri v2 is Rust-side (`.plugin()` call in `lib.rs`), not JSON-side, so `tauri.conf.json` may not require changes for this plugin. The CSP is `connect-src 'self' ipc: http://ipc.localhost` — `navigator.clipboard` is a browser API, no CSP entry needed.
- `package.json` — no changes needed; new test files match the existing `ui/test/*.test.mjs` glob.

### Feature Flags and Deployment Concerns

- No feature flag for the cmdlog UI — the `hidden` class on `#command-log-footer` is removed at init time (or on first record). Always on once this slice lands.
- Adding `tauri-plugin-clipboard-manager` as a new Cargo dependency will increase build time on first compile and binary size marginally. It requires `cargo add tauri-plugin-clipboard-manager@2` or a direct `Cargo.toml` edit.
- The Tauri v2 clipboard plugin permission identifier for write operations is `clipboard-manager:allow-write-text`. If the plugin version changes its identifier, the capability entry would need updating.

---

## 6. Risk Indicators

- **`cmdlog.list` / `cmdlog.get` not yet in the bridge**: the `export const cmdlog` object in `runner-bridge.js` only has `open`, `append`, `close`. The rendering module needs `cmdlog_list`; the "open by ID" feature needs `cmdlog_get`. These need to be added to the bridge before or alongside the UI module. A spec that writes the UI module importing from the bridge without updating the bridge first will fail at runtime.
- **`tauri-plugin-clipboard-manager` is a wholly new dependency**: not in `Cargo.toml`, not registered in `lib.rs`, no capability entry. All three changes must land together or the fallback call `window.__TAURI__.clipboardManager.writeText(text)` will throw at runtime. The `acl-manifests.json` schema must be regenerated via `cargo build` before the capability entry is valid.
- **Clipboard plugin permission identifier**: Tauri v2 clipboard plugin uses `clipboard-manager:allow-write-text` for the write-text command. This must match exactly; a mismatch produces a runtime capability-denied error, not a compile error.
- **`navigator.clipboard` user-activation requirement**: `navigator.clipboard.writeText()` must be called synchronously inside a user-gesture handler. If the Copy-all button's click handler `await`s anything before calling `writeText`, the user-activation context is lost and the call silently fails (no error, no copy). The entire copy path — both the primary `navigator.clipboard` branch and the plugin fallback branch — must execute without any `await` before the write call itself.
- **Newest-first ordering**: `CmdLogStore::list()` returns records in insertion order (`order: Vec<String>` iterated forward). The UI must reverse the array before rendering to satisfy "newest-first." This is a one-liner (`.reverse()` or `[...].reverse()`) but easy to omit.
- **`#command-log-footer` un-hiding**: the element carries `class="hidden"` in `index.html`. The rendering module needs to remove this class either at init time (always show the panel header) or on first record. If it is removed at init unconditionally but `cmdlog_list` returns an empty array, an empty expandable panel is shown — user experience question for the spec to decide.
- **Re-render trigger**: `cmdlog_list` is a snapshot query, not a live subscription. If the panel is expanded during a running command, records that arrive after the initial fetch won't appear until a re-fetch. The `<details>` `toggle` event can trigger a re-fetch on each open. No Tauri event exists for "new cmdlog record added" — this is by design (the bridge instruments writes, not reads) and a polling or toggle-refetch strategy is the only option without a new Rust event.
- **No test for clipboard or DOM rendering**: both are new code with zero existing coverage. The failure-mapping module is fully testable (pure function, no DOM, no Tauri); the clipboard and DOM rendering paths require manual verification or a separate integration test setup.

---

## 7. Summary for Complexity Assessment

This task is the final rendering and integration slice of a three-part feature. The Rust store (slice 1) and JS bridge instrumentation (slice 2) are both fully landed and tested. Slice 3 touches five layers: a new JS rendering module (`ui/cmdlog-ui.js`) that fetches records via `cmdlog_list` and writes rows into `#command-log-body` using existing `.log-*` CSS classes; a two-method extension to the existing `cmdlog` export in `ui/runner-bridge.js` adding `list` and `get`; a new pure-function failure-mapping ES module (`ui/cmdlog-failure-map.mjs`) with its own `node:test` test file; an `index.html` change adding a Copy-all button to `#command-log-footer`; and a three-file Cargo/capabilities/lib.rs change to add `tauri-plugin-clipboard-manager`. The HTML target region (`#command-log-footer`, `#command-log-body`) and all required CSS classes are already present and styled — this task is exclusively wiring, rendering, and the two new utility concerns (failure mapping, clipboard).

Technical novelty is concentrated in two places: the clipboard integration (a genuinely new Cargo dependency with Tauri v2 permissions wiring that has not been done in this repo before) and the user-activation constraint on `navigator.clipboard.writeText` (the primary path must fire synchronously inside the click handler with no intervening `await`). The failure-mapping module is straightforward bounded logic — three cases, one pure function — with a direct test precedent in `app-updater-utils.mjs`. The DOM rendering is standard `div`/`textContent` construction following the `log.js` `appendLine` pattern, and the newest-first ordering is a single array reversal of the `cmdlog_list` result.

Test coverage posture is complete for the already-landed primitives (store, bridge) and gap-free for everything this slice adds. The failure-mapping module is the only new code fully testable without DOM or Tauri stubs and must have its `node:test` file. The clipboard path and DOM rendering are new code with zero test coverage and must be verified manually. The single highest-risk change is the clipboard plugin integration: all three change sites (Cargo, lib.rs, capabilities) must be consistent and the permission identifier must match exactly, or the fallback call fails silently at runtime.

---

## 8. External References

None named by the task.
