# Spec: EPMCDME-15232 — Command Log UI, Failure Mapping, Copy-All

**Slice**: 3 of 3 (Slices 1/2 — Rust store and bridge instrumentation — are fully landed.)
**Complexity**: M (score 20, 2–3 days)

---

## Problem

`#command-log-footer` / `#command-log-body` exist in the DOM and are styled, but carry `class="hidden"` and are empty. The Rust store (`cmdlog.rs`) and bridge instrumentation (runner-bridge.js) are complete. This slice wires the rendering, failure explanation, and clipboard export.

---

## Scope

| In scope | Out of scope |
|---|---|
| Render all CmdRecords newest-first into `#command-log-body` | Filtering, search, follow/tail |
| Un-hide `#command-log-footer` at init | Export to file, clear, session list |
| `openCmdLogRecord(id)` scroll-to | Health screen integration |
| `ui/cmdlog-failure-map.mjs` + its node:test | Per-row raw-output expansion |
| Copy-all with navigator.clipboard + plugin fallback | Polling or live-subscription updates |
| tauri-plugin-clipboard-manager dependency wiring | New Rust events or commands |

---

## Acceptance Criteria

1. `#command-log-footer` is visible (no `hidden` class) after `initCmdLog()` runs at boot.
2. `#command-log-body` shows one block per CmdRecord, ordered newest-first (most recent at top).
3. Each block shows: command text (`.log-prompt`), exit code + duration (`.log-dim`), and — when `mapFailure` returns a non-empty string — a failure message (`.log-info`).
4. `ui/log.js` `set_window_height` call is not invoked by any cmdlog-UI code path.
5. Opening `<details>` re-fetches and re-renders records (stale records do not persist).
6. `openCmdLogRecord(id)` expands the panel and scrolls the row with `data-id="{id}"` into view.
7. Copy-all button is visible in the `<summary>` bar. Clicking it places all rendered rows' text on the clipboard.
8. `navigator.clipboard.writeText` is called synchronously inside the click handler (no `await` before the write call).
9. Fallback to `window.__TAURI__.clipboardManager.writeText` when `window.isSecureContext` is false or `navigator.clipboard` is absent.
10. `mapFailure` returns a plain-language string for the three recognised cases; returns `raw_output` verbatim for all others; returns `''` for exit code 0.
11. `ui/test/cmdlog-failure-map.test.mjs` passes under `node --test ui/test/*.test.mjs`.
12. `cargo build` succeeds with `tauri-plugin-clipboard-manager = "2"` in Cargo.toml.
13. No new ESLint errors, no `console.error` at runtime for the clipboard capability path.

---

## Design

### `ui/cmdlog-failure-map.mjs`

Pure function, default export. Input: `{ exit_code, raw_output }` (CmdRecord subset). Output: `string`.

Detection order (first match wins):

| # | Condition | Returned string |
|---|---|---|
| 1 | `exit_code === 0` | `''` |
| 2 | `exit_code !== 0 && raw_output.trim() === ''` | `"Command exited with code N and produced no output."` |
| 3 | `/ENOTFOUND\|ECONNREFUSED\|ETIMEDOUT\|fetch failed\|network error/i` in `raw_output` | `"A network error occurred. Check your internet connection."` |
| 4 | `exit_code === 127` or `/command not found\|not found/i` in `raw_output` | `"Command not found. Check that the required tool is installed and on your PATH."` |
| 5 | (none of above) | `raw_output` verbatim — no invented sentence |

File: `ui/cmdlog-failure-map.mjs`. Mirrors `app-updater-utils.mjs` (7-line single-export shape).

### `ui/test/cmdlog-failure-map.test.mjs`

Four tests using `node:test` + `node:assert/strict`, no mocking:
- Case 2: non-zero exit, empty `raw_output` → expected plain-language string
- Case 3: `raw_output` containing `"ENOTFOUND"` → network error string
- Case 4: `exit_code === 127` → command-not-found string
- Case 5 (unrecognised): non-zero exit with non-matching `raw_output` → returns `raw_output` unchanged

Mirrors `ui/test/app-updater-utils.test.mjs` structure exactly.

### `ui/runner-bridge.js`

Add two entries to the existing `export const cmdlog` object:

```js
list: () => invoke('cmdlog_list'),
get:  (id) => invoke('cmdlog_get', { id }),
```

No other changes to this file.

### `ui/cmdlog-ui.js` (new file)

Module-level private variable `let _records = []` caches the last fetched list (used by Copy-all to build text synchronously).

**`initCmdLog()`** — exported, called from `renderer.js`'s `boot()`:
1. Removes `hidden` class from `#command-log-footer` unconditionally.
2. Injects a `<button id="cmdlog-copy-all">Copy all</button>` inside `<summary>` if absent.
3. Attaches the Copy-all click handler (see below).
4. Attaches a `toggle` listener on `<details id="command-log-footer">`: calls `_renderRecords()` when `event.target.open` is true.
5. Calls `_renderRecords()` once to populate on load.

**`openCmdLogRecord(id)`** — exported:
1. Sets `document.getElementById('command-log-footer').open = true`.
2. Calls `_renderRecords()` (awaited — then continues).
3. Calls `document.querySelector('[data-id="${id}"]')?.scrollIntoView({ block: 'nearest' })`.

**`_renderRecords()`** — module-private, async:
1. `_records = await cmdlog.list()` (bridge method added above).
2. Reverses array in place (insertion order → newest-first).
3. Clears `#command-log-body`.
4. For each record, builds and appends a block `<div data-id="…">`:
   - `<span class="log-line log-prompt">` — `record.command`
   - `<span class="log-line log-dim">` — `exit ${record.exit_code} · ${(record.duration_ms / 1000).toFixed(1)}s`
   - If `mapFailure(record)` is non-empty: `<span class="log-line log-info">` — failure message

**Copy-all click handler** (attached in `initCmdLog`, synchronous):
```js
btn.addEventListener('click', () => {
  const text = _records.map(r =>
    [r.command, `exit ${r.exit_code}`, mapFailure(r)].filter(Boolean).join('\n')
  ).join('\n\n');
  if (window.isSecureContext && navigator.clipboard) {
    navigator.clipboard.writeText(text);
  } else {
    window.__TAURI__.clipboardManager.writeText(text);
  }
});
```

`_records` is read synchronously (no `await`). Both `writeText` calls are synchronous-entry; their returned Promises are not awaited (fire-and-forget acceptable for clipboard).

No `set_window_height` call anywhere in this module.

### `ui/index.html`

No structural changes required at write time. `initCmdLog()` injects the Copy-all button at runtime via DOM manipulation. The `hidden` class on `<details id="command-log-footer">` is left as-is in HTML (removed by JS at boot). This keeps the HTML as the fallback no-JS state and avoids a diff in the static source.

### `ui/renderer.js`

Add inside `boot()` after `initLog(...)` and `initTerminal(...)`:
```js
import { initCmdLog } from './cmdlog-ui.js';
// inside boot():
initCmdLog();
```

Reference: `renderer.js` lines 577–589 establish the pattern.

### Cargo / capabilities / lib.rs

All three must land in the same commit (any subset breaks the fallback path at runtime):

- `src-tauri/Cargo.toml` `[dependencies]`: `tauri-plugin-clipboard-manager = "2"`
- `src-tauri/src/lib.rs` Builder chain: `.plugin(tauri_plugin_clipboard_manager::init())` before `.invoke_handler(...)`
- `src-tauri/capabilities/default.json` `permissions` array: `"clipboard-manager:allow-write-text"`

Permission identifier `clipboard-manager:allow-write-text` must match exactly; a mismatch produces a runtime capability-denied error, not a compile error.

---

## Non-Goals

- No filtering, search, or export UI.
- No follow/tail mode or live-subscription to new records (no Tauri event exists for this without new Rust work).
- No per-row expand to show raw output.
- No clear / reset of the log store from the UI.
- No session list or multi-session navigation.
- No Health screen integration.
- No polling strategy (toggle-refetch only).
- No clipboard write confirmation/toast UI.
- No test for DOM rendering or clipboard paths (no DOM test infrastructure in this repo).

---

## Risks

- **Clipboard three-file atomicity**: Cargo, lib.rs, capabilities must land together. A partial deploy leaves `window.__TAURI__.clipboardManager` undefined at runtime, causing a fallback throw.
- **User-activation context**: Any `await` inserted before either `writeText` call in the click handler silently loses user-activation on some platforms and the write is rejected with no error. The entire copy path must remain synchronous-entry.
- **`_records` staleness**: Copy-all reads `_records` from the last `_renderRecords()` call. If records were added since the panel was last opened, the clipboard text will be stale. Acceptable: the panel triggers a re-fetch on every open, so the only stale window is within a single open session.
