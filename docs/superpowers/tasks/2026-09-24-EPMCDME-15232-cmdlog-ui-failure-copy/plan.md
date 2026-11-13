# Command Log UI, Failure Mapping, Copy-All (EPMCDME-15232) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render CmdRecord rows into `#command-log-body`, add plain-language failure mapping, and wire Copy-all via `navigator.clipboard` with a Tauri plugin fallback.

**Architecture:** A new `cmdlog-ui.js` rendering module fetches records from the existing Rust store via two new bridge methods and writes DOM rows using the already-styled `.log-*` CSS classes. A pure-function `cmdlog-failure-map.mjs` module explains non-zero exits. The Tauri clipboard plugin is wired as an atomic three-file change (Cargo, lib.rs, capabilities).

**Tech Stack:** Tauri v2, vanilla ES modules (no bundler), `tauri-plugin-clipboard-manager@2`, `node:test`.

**Spec:** `docs/superpowers/tasks/2026-09-24-EPMCDME-15232-cmdlog-ui-failure-copy/spec.md`

## Global Constraints

- Reuse existing `.log-line .log-stdout .log-stderr .log-info .log-success .log-dim .log-prompt` classes — no new CSS classes.
- `set_window_height` / `ui/log.js` behavior must not appear in any cmdlog-UI code path.
- Records rendered newest-first: reverse the array returned by `cmdlog_list` before rendering.
- `navigator.clipboard.writeText` called synchronously inside the click handler — no `await` before the call.
- Permission identifier must be exactly `"clipboard-manager:allow-write-text"`.
- Cargo.toml + lib.rs + capabilities/default.json land in the same commit (any subset leaves the fallback broken at runtime).
- No polling; re-fetch on `<details>` `toggle` open only.
- No test for DOM rendering or clipboard paths (no DOM test infrastructure; spec Non-Goals).
- Commit per task using the repository's existing conventional-commits convention.

---

### Task 1: Extend `cmdlog` bridge with `list` and `get`

**Files:**
- Modify: `ui/runner-bridge.js:15-19` — add two entries to `export const cmdlog`
- Modify: `ui/test/cmdlog-bridge.test.mjs:17` — add `cmdlog` to destructure; append two tests

**Interfaces:**
- Produces: `cmdlog.list() → Promise<CmdRecord[]>`, `cmdlog.get(id: string) → Promise<CmdRecord | null>`

- [ ] **Step 1: Write the two failing tests**

Change line 17 of `cmdlog-bridge.test.mjs` from `const { runner, pty, updater } =` to `const { runner, pty, updater, cmdlog } =`.

Append to the file:

```js
test('cmdlog.list: invokes cmdlog_list', async () => {
  let calledCmd;
  invokeImpl = async (cmd) => { calledCmd = cmd; return []; };
  const result = await cmdlog.list();
  assert.equal(calledCmd, 'cmdlog_list');
  assert.deepEqual(result, []);
});

test('cmdlog.get: invokes cmdlog_get with { id }', async () => {
  let calledCmd, calledArgs;
  invokeImpl = async (cmd, args) => { calledCmd = cmd; calledArgs = args; return null; };
  await cmdlog.get('abc-123');
  assert.equal(calledCmd, 'cmdlog_get');
  assert.equal(calledArgs?.id, 'abc-123');
});
```

- [ ] **Step 2: Run tests to confirm failure**

```
node --test ui/test/cmdlog-bridge.test.mjs
```

Expected: both new tests fail — `cmdlog` is undefined / `list` is not a function.

- [ ] **Step 3: Add `list` and `get` to `runner-bridge.js`**

In the `export const cmdlog = { open, append, close }` block (lines 15–19), add after `close`:

```js
list: () => invoke('cmdlog_list'),
get:  (id) => invoke('cmdlog_get', { id }),
```

- [ ] **Step 4: Run all tests**

```
node --test ui/test/*.test.mjs
```

Expected: all 11 cmdlog-bridge tests pass; full suite clean.

- [ ] **Step 5: Commit**

---

### Task 2: Failure-mapping module

**Files:**
- Create: `ui/cmdlog-failure-map.mjs`
- Create: `ui/test/cmdlog-failure-map.test.mjs`

**Interfaces:**
- Produces: `default export mapFailure({ exit_code: number, raw_output: string }) → string`

- [ ] **Step 1: Write the test file**

```js
// ui/test/cmdlog-failure-map.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import mapFailure from '../cmdlog-failure-map.mjs';

test('non-zero exit with empty output returns plain-language string', () => {
  assert.equal(
    mapFailure({ exit_code: 1, raw_output: '' }),
    'Command exited with code 1 and produced no output.'
  );
});

test('raw_output containing ENOTFOUND returns network error string', () => {
  assert.equal(
    mapFailure({ exit_code: 1, raw_output: 'getaddrinfo ENOTFOUND example.com' }),
    'A network error occurred. Check your internet connection.'
  );
});

test('exit_code 127 returns command-not-found string', () => {
  assert.equal(
    mapFailure({ exit_code: 127, raw_output: 'some output' }),
    'Command not found. Check that the required tool is installed and on your PATH.'
  );
});

test('unrecognised failure returns raw_output verbatim', () => {
  assert.equal(
    mapFailure({ exit_code: 1, raw_output: 'some unknown error' }),
    'some unknown error'
  );
});
```

- [ ] **Step 2: Run tests to confirm failure**

```
node --test ui/test/cmdlog-failure-map.test.mjs
```

Expected: all four tests fail — module not found.

- [ ] **Step 3: Implement `ui/cmdlog-failure-map.mjs`**

```js
export default function mapFailure({ exit_code, raw_output }) {
  if (exit_code === 0) return '';
  if (raw_output.trim() === '')
    return `Command exited with code ${exit_code} and produced no output.`;
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|network error/i.test(raw_output))
    return 'A network error occurred. Check your internet connection.';
  if (exit_code === 127 || /command not found|not found/i.test(raw_output))
    return 'Command not found. Check that the required tool is installed and on your PATH.';
  return raw_output;
}
```

- [ ] **Step 4: Run full JS test suite**

```
node --test ui/test/*.test.mjs
```

Expected: all tests pass, including the four new ones.

- [ ] **Step 5: Commit**

---

### Task 3: Clipboard plugin wiring (atomic three-file change)

**Files:**
- Modify: `src-tauri/Cargo.toml` — add to `[dependencies]`
- Modify: `src-tauri/src/lib.rs` — add to `Builder::default()` chain
- Modify: `src-tauri/capabilities/default.json` — add to `permissions` array

**Test-first: no** — infrastructure change; `cargo build` is the verification gate.

- [ ] **Step 1: Add Cargo dependency**

In `src-tauri/Cargo.toml` under `[dependencies]`:
```toml
tauri-plugin-clipboard-manager = "2"
```

- [ ] **Step 2: Register plugin in lib.rs**

In `src-tauri/src/lib.rs`, inside `tauri::Builder::default()` chain, add before `.invoke_handler(...)`:
```rust
.plugin(tauri_plugin_clipboard_manager::init())
```

- [ ] **Step 3: Add capability permission**

In `src-tauri/capabilities/default.json`, add to the `permissions` array:
```json
"clipboard-manager:allow-write-text"
```

- [ ] **Step 4: Verify with cargo build**

Run from `src-tauri/`:
```
cargo build
```

Expected: builds successfully; `acl-manifests.json` regenerated automatically. No capability-denied errors.

- [ ] **Step 5: Commit all three files in one commit**

---

### Task 4: `cmdlog-ui.js` rendering module + renderer boot integration

**Files:**
- Create: `ui/cmdlog-ui.js`
- Modify: `ui/renderer.js` — add import + `initCmdLog()` call inside `boot()`

**Interfaces:**
- Consumes: `cmdlog.list()` from `./runner-bridge.js` (Task 1); `mapFailure` from `./cmdlog-failure-map.mjs` (Task 2).
- Produces: `initCmdLog()` (called from `boot()`); `openCmdLogRecord(id: string)` (public scroll-to API).

**Test-first: no** — DOM module; spec Non-Goals explicitly exclude DOM rendering and clipboard tests.

- [ ] **Step 1: Create `ui/cmdlog-ui.js`**

```js
import { cmdlog } from './runner-bridge.js';
import mapFailure from './cmdlog-failure-map.mjs';

let _records = [];

async function _renderRecords() {
  _records = [...(await cmdlog.list())].reverse(); // newest-first
  const body = document.getElementById('command-log-body');
  body.innerHTML = '';
  for (const r of _records) {
    const block = document.createElement('div');
    block.dataset.id = r.id;

    const cmd = document.createElement('span');
    cmd.className = 'log-line log-prompt';
    cmd.textContent = r.command;

    const meta = document.createElement('span');
    meta.className = 'log-line log-dim';
    meta.textContent = `exit ${r.exit_code} · ${(r.duration_ms / 1000).toFixed(1)}s`;

    block.appendChild(cmd);
    block.appendChild(meta);

    const msg = mapFailure(r);
    if (msg) {
      const info = document.createElement('span');
      info.className = 'log-line log-info';
      info.textContent = msg;
      block.appendChild(info);
    }
    body.appendChild(block);
  }
}

export function initCmdLog() {
  const footer = document.getElementById('command-log-footer');
  footer.classList.remove('hidden');

  if (!document.getElementById('cmdlog-copy-all')) {
    const btn = document.createElement('button');
    btn.id = 'cmdlog-copy-all';
    btn.textContent = 'Copy all';
    // No await before writeText — user-activation context must be preserved
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
    footer.querySelector('summary').appendChild(btn);
  }

  footer.addEventListener('toggle', (e) => { if (e.target.open) _renderRecords(); });
  _renderRecords();
}

export async function openCmdLogRecord(id) {
  document.getElementById('command-log-footer').open = true;
  await _renderRecords();
  document.querySelector(`[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' });
}
```

- [ ] **Step 2: Wire into `renderer.js`**

Add the import near the other UI-module imports at the top of `ui/renderer.js`:
```js
import { initCmdLog } from './cmdlog-ui.js';
```

Inside `boot()`, after the existing `initLog(...)` and `initTerminal(...)` calls (around lines 577–589):
```js
initCmdLog();
```

- [ ] **Step 3: Run full JS test suite to confirm no regressions**

```
node --test ui/test/*.test.mjs
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

---

## Negative-Constraint Checklist

- **"do NOT reuse ui/log.js window-resizing expand behavior"** — Task 4's `cmdlog-ui.js` uses native `<details>` toggle and `classList.remove('hidden')` only; no `set_window_height` call anywhere. Honored. ✓
- **No filtering, search, export** — no task adds any such UI. ✓
- **No follow/tail or live-subscription** — toggle-refetch only; no polling, no Tauri event listener for new records. ✓
- **No per-row expand** — Task 4 renders flat rows only. ✓
- **No clear/reset, no session list, no Health screen integration** — absent from all tasks. ✓
- **No clipboard write confirmation/toast** — click handler writes and returns; no toast. ✓
- **No test for DOM rendering or clipboard paths** — Task 4 is Test-first: no; no DOM test added. ✓
