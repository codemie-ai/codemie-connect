# Health Screen (EPMCDME-14506) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parse `codemie doctor`'s text output into a structured, three-group Health screen with a remedy per failure, and give `open_log` a real, existence-checked Windows implementation.

**Architecture:** Rust's `run_stream` keeps invoking `doctor` unchanged; a new independent call site in `ui/renderer.js` accumulates its stdout and hands it to a pure JS parser (`doctor-parse.js`) → a pure grouping/remedy module (`doctor-groups.js`) → a presentational render module (`health-ui.js`) that fills the already-routed, currently-empty `#health-view`. Separately, `logger.rs` gains a Windows log directory and open mechanism, gated the same `#[cfg(windows)]` way every sibling command module already is.

**Tech Stack:** Rust (`#[tauri::command]`, `std::process::Command`), vanilla JS (ES modules, `node:test`), Tauri `invoke`/`runStream`.

**Spec:** `docs/superpowers/tasks/2026-09-07-epmcdme-14506-health-screen/spec.md`

**Commits:** one commit per task, following this repo's existing convention (`.ai-run/guides/standards/git-workflow.md`) — no format is invented here.

## Global Constraints

- Parsing/grouping/remedy logic lives entirely in JS; no new Rust command for invoking `doctor` (spec decision 1).
- Wizard step `2.4` (`ui/handlers.js:89-96`) is not modified by any task (decision 2).
- The summary line is always `"<passing> of <total> fine"`, computed from whatever ran — never a hardcoded total (decision 5).
- The footer's global `#open-log` button (`ui/index.html:163-166`, `ui/log.js`) is not modified by any task; the Health screen's "Open today's log" is a separate action calling the same `open_log` command (decision 9).
- Windows log directory is `%USERPROFILE%\AppData\Local\CodeMie\Logs`, not a `HOME`-based path (decision 10).
- `open_log` checks the file exists and is readable before opening, returning a typed error the UI renders as "can't read your log" (decision 11).

---

### Task 1: Windows log directory + checked, cross-platform `open_log`

**Files:**
- Modify: `src-tauri/src/commands/logger.rs:1-64`
- Test: same file, `#[cfg(test)] mod tests`

**Interfaces:**
- Produces: `pub fn log_path() -> String` (signature unchanged — callers in `ui/log.js`/health-ui wiring are unaffected), `#[tauri::command] pub fn open_log() -> CmdResult<()>` (signature unchanged; now can reject with an `InstallerError::Other` message a caller renders as "can't read your log").

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(windows)]
#[test]
fn log_dir_uses_userprofile_appdata_local_codemie_logs() {
    assert_eq!(
        log_dir_with(r"C:\Users\alice"),
        r"C:\Users\alice\AppData\Local\CodeMie\Logs"
    );
}

#[cfg(not(windows))]
#[test]
fn log_dir_uses_home_library_logs_codemie() {
    assert_eq!(log_dir_with("/Users/alice"), "/Users/alice/Library/Logs/CodeMie");
}

#[test]
fn ensure_log_readable_errors_for_missing_file() {
    assert!(ensure_log_readable("/definitely/does/not/exist/codemie_wizard.log").is_err());
}

#[test]
fn ensure_log_readable_ok_for_existing_file() {
    let path = std::env::temp_dir().join("codemie_open_log_test.log");
    std::fs::write(&path, "hi").unwrap();
    assert!(ensure_log_readable(path.to_str().unwrap()).is_ok());
    let _ = std::fs::remove_file(&path);
}
```

- [ ] **Step 2: Run and confirm failure** — `cargo test log_dir_ ensure_log_readable` from `src-tauri/` fails: `log_dir_with`/`ensure_log_readable` don't exist yet.

- [ ] **Step 3: Implement**

```rust
#[cfg(not(windows))]
fn log_dir_with(home: &str) -> String { format!("{home}/Library/Logs/CodeMie") }
#[cfg(windows)]
fn log_dir_with(profile: &str) -> String { format!(r"{profile}\AppData\Local\CodeMie\Logs") }

#[cfg(not(windows))]
fn log_dir() -> String { log_dir_with(&std::env::var("HOME").unwrap_or_default()) }
#[cfg(windows)]
fn log_dir() -> String { log_dir_with(&std::env::var("USERPROFILE").unwrap_or_default()) }

fn ensure_log_readable(path: &str) -> CmdResult<()> {
    std::fs::File::open(path)
        .map(|_| ())
        .map_err(|_| InstallerError::Other(format!("log file not found or unreadable: {path}")))
}

#[cfg(not(windows))]
fn spawn_open(path: &str) -> CmdResult<()> {
    std::process::Command::new("open").arg(path).spawn().map_err(InstallerError::Io)?;
    Ok(())
}
#[cfg(windows)]
fn spawn_open(path: &str) -> CmdResult<()> {
    // "" is the required window-title arg for `start`, so a spaced path isn't
    // mistaken for it; this invokes the OS default handler for the file.
    std::process::Command::new("cmd")
        .args(["/c", "start", "", path])
        .spawn()
        .map_err(InstallerError::Io)?;
    Ok(())
}

#[tauri::command]
pub fn open_log() -> CmdResult<()> {
    let path = log_path();
    ensure_log_readable(&path)?;
    spawn_open(&path)
}
```

Delete the old single-platform `log_dir()` and `open_log()` bodies they replace (`logger.rs:29-36`, `:57-64`).

- [ ] **Step 4: Run and confirm pass** — `cargo test` from `src-tauri/`; all `logger::tests` pass, existing `format_line_*` tests untouched.

- [ ] **Step 5: Commit**

---

### Task 2: Doctor-output parser + fixtures

**Files:**
- Create: `ui/doctor-parse.js`
- Create: `ui/test/fixtures/doctor/all-passing.txt`, `ui/test/fixtures/doctor/provider-failure.txt`, `ui/test/fixtures/doctor/provider-absent.txt`
- Test: `ui/test/doctor-parse.test.mjs`

**Interfaces:**
- Produces: `export function parseDoctorOutput(raw: string): Array<{ name: string, status: 'ok'|'warn'|'error'|'info', message: string, hint?: string }>` — one record per `"  <icon> <message>"` detail line, tagged with its enclosing bold-header check name; consumed by Task 3's grouping module.

- [ ] **Step 1: Write the fixtures**, modeled on the formatter grammar (`Name:` header line; `"  <icon> <message>"` detail lines; optional `"      <hint>"` line; blank line between checks):

`all-passing.txt` — one block per: `Node Version`, `Npm`, `Python`, `Uv`, `AWS CLI`, `Active Profile`, `JWT Auth`, `Agents` (two `✓` items), `Workflows`, `Frameworks`, `Provider`, each `✓ ...`, ending `✓ All checks passed!`.

`provider-failure.txt` — same blocks, but `Provider:` has `  ✗ Anthropic unreachable` followed by `      Check your network connection and try again`, ending `⚠ Some issues detected. Review the checks above.`

`provider-absent.txt` — same runtime/account/tools blocks, no `Provider:` block at all, and `Active Profile:` has `  ⚠ No active profile configured` / `      Run: codemie setup`.

- [ ] **Step 2: Write the failing test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseDoctorOutput } from '../doctor-parse.js';

function fixture(id) {
  return readFileSync(fileURLToPath(new URL(`fixtures/doctor/${id}.txt`, import.meta.url)), 'utf8');
}

test('all-passing: every check parses ok, no hints', () => {
  const records = parseDoctorOutput(fixture('all-passing'));
  assert.equal(records.length, 12);
  assert.ok(records.every((r) => r.status === 'ok'));
  assert.ok(records.some((r) => r.name === 'Provider'));
});

test('provider-failure: Provider fails with a hint', () => {
  const records = parseDoctorOutput(fixture('provider-failure'));
  const provider = records.find((r) => r.name === 'Provider');
  assert.equal(provider.status, 'error');
  assert.equal(provider.hint, 'Check your network connection and try again');
});

test('provider-absent: no Provider record, Active Profile warns', () => {
  const records = parseDoctorOutput(fixture('provider-absent'));
  assert.ok(!records.some((r) => r.name === 'Provider'));
  const profile = records.find((r) => r.name === 'Active Profile');
  assert.equal(profile.status, 'warn');
  assert.equal(profile.hint, 'Run: codemie setup');
});
```

- [ ] **Step 3: Run and confirm failure** — `node --test ui/test/doctor-parse.test.mjs` fails: `doctor-parse.js` doesn't exist.

- [ ] **Step 4: Implement**

```js
const ICONS = { '✓': 'ok', '⚠': 'warn', '✗': 'error', '○': 'info', '•': 'info' };

export function parseDoctorOutput(raw) {
  const lines = raw.split(/\r?\n/);
  const records = [];
  let currentName = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) { currentName = null; continue; }
    const detail = line.match(/^\s{2}([✓⚠✗○•])\s+(.+)$/);
    if (detail && currentName) {
      const [, icon, message] = detail;
      let hint;
      const hintMatch = lines[i + 1] && lines[i + 1].match(/^\s{6}(.+)$/);
      if (hintMatch) { hint = hintMatch[1].trim(); i += 1; }
      records.push({ name: currentName, status: ICONS[icon] || 'info', message: message.trim(), hint });
      continue;
    }
    if (/^\S.*:\s*$/.test(line)) currentName = line.replace(/:\s*$/, '').trim();
  }
  return records;
}
```

- [ ] **Step 5: Run and confirm pass** — `node --test ui/test/doctor-parse.test.mjs`.

- [ ] **Step 6: Commit**

---

### Task 3: Grouping and remedy module

**Files:**
- Create: `ui/doctor-groups.js`
- Test: `ui/test/doctor-groups.test.mjs`

**Interfaces:**
- Consumes: the parser record shape from Task 2 (`{ name, status, message, hint }`), constructed by hand in tests — no fixture dependency.
- Produces: `export function groupDoctorResults(records): { rows: Array<{ group: 'account'|'tools'|'codemie', label: string, status: 'pass'|'fail', remedyText?: string, action?: { kind: 'recheck', label: string } | { kind: 'navigate', view: string, label: string } }>, summary: { passing: number, total: number } }` — consumed by Task 5's render call.

- [ ] **Step 1: Write the failing tests**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupDoctorResults } from '../doctor-groups.js';

const ok = (name) => ({ name, status: 'ok', message: 'fine' });

test('runtime checks collapse into one CodeMie-itself row', () => {
  const { rows } = groupDoctorResults([ok('Node Version'), ok('Npm'), ok('Python'), ok('Uv')]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].group, 'codemie');
  assert.equal(rows[0].status, 'pass');
});

test('Agents failure gets a Go to Agents deep-link action', () => {
  const { rows } = groupDoctorResults([
    { name: 'Agents', status: 'error', message: 'No agents installed', hint: 'Run: codemie install agent' },
  ]);
  const agents = rows.find((r) => r.label === 'Agents');
  assert.equal(agents.group, 'tools');
  assert.deepEqual(agents.action, { kind: 'navigate', view: 'agents', label: 'Go to Agents' });
});

test('a failing check with a hint but no deep-link gets a Check again action', () => {
  const { rows } = groupDoctorResults([
    { name: 'JWT Auth', status: 'error', message: 'Not authenticated', hint: 'Set TOKEN or run: codemie setup' },
  ]);
  const row = rows.find((r) => r.label === 'JWT Auth');
  assert.equal(row.group, 'account');
  assert.deepEqual(row.action, { kind: 'recheck', label: 'Check again' });
  assert.equal(row.remedyText, 'Set TOKEN or run: codemie setup');
});

test('a failing check with no hint and no deep-link gets no action', () => {
  const { rows } = groupDoctorResults([{ name: 'Workflows', status: 'error', message: 'unreachable' }]);
  assert.equal(rows.find((r) => r.label === 'Workflows').action, undefined);
});

test('summary reflects only what ran, no hardcoded total', () => {
  const withProvider = groupDoctorResults([ok('Node Version'), ok('Provider')]).summary;
  const withoutProvider = groupDoctorResults([ok('Node Version')]).summary;
  assert.deepEqual(withProvider, { passing: 2, total: 2 });
  assert.deepEqual(withoutProvider, { passing: 1, total: 1 });
});
```

- [ ] **Step 2: Run and confirm failure** — `node --test ui/test/doctor-groups.test.mjs` fails: module doesn't exist.

- [ ] **Step 3: Implement**

```js
const RUNTIME_NAMES = new Set(['Node Version', 'Npm', 'Python', 'Uv']);
const GROUP_BY_NAME = {
  'Active Profile': 'account', 'JWT Auth': 'account',
  'AWS CLI': 'tools', Agents: 'tools',
  Workflows: 'codemie', Frameworks: 'codemie', Provider: 'codemie',
};
const DEEP_LINKS = { Agents: { view: 'agents', label: 'Go to Agents' } };

const worst = (items) => (items.some((r) => r.status === 'error' || r.status === 'warn') ? 'fail' : 'pass');

export function groupDoctorResults(records) {
  const runtime = records.filter((r) => RUNTIME_NAMES.has(r.name));
  const rest = records.filter((r) => !RUNTIME_NAMES.has(r.name));
  const byName = new Map();
  for (const r of rest) (byName.get(r.name) ?? byName.set(r.name, []).get(r.name)).push(r);

  const rows = [];
  if (runtime.length) {
    rows.push({
      group: 'codemie',
      label: 'Everything CodeMie needs to run is included',
      status: worst(runtime),
    });
  }
  for (const [name, items] of byName) {
    const status = worst(items);
    const failing = items.find((r) => r.status === 'error' || r.status === 'warn');
    const deepLink = DEEP_LINKS[name];
    let action;
    if (status === 'fail' && deepLink) action = { kind: 'navigate', ...deepLink };
    else if (status === 'fail' && failing?.hint) action = { kind: 'recheck', label: 'Check again' };
    rows.push({
      group: GROUP_BY_NAME[name] || 'codemie',
      label: name,
      status,
      remedyText: status === 'fail' ? failing?.hint : undefined,
      action,
    });
  }
  const passing = rows.filter((r) => r.status === 'pass').length;
  return { rows, summary: { passing, total: rows.length } };
}
```

- [ ] **Step 4: Run and confirm pass** — `node --test ui/test/doctor-groups.test.mjs`.

- [ ] **Step 5: Commit**

---

### Task 4: Health-view render module

**Files:**
- Create: `ui/health-ui.js`
- Test: `ui/test/health-ui.test.mjs` — reuse/adapt the minimal DOM stub from `ui/test/steps-ui.test.mjs:1-70` (same `makeEl`/`classList`/`innerHTML` shape); do not duplicate it verbatim, import nothing extra.

**Interfaces:**
- Consumes: the `{ rows, summary }` shape produced by Task 3.
- Produces: `export function renderHealth(container, model, { onRecheck, onOpenLog, onNavigate })`, `export function showLoading(container)`, `export function showLogError(container, message)` — all called from Task 5's wiring.

- [ ] **Step 1: Write the failing tests** (using the adapted DOM stub's `makeEl('div')` as `container`)

```js
test('renders group headings only for groups with rows, and the summary line', () => {
  const container = makeEl('div');
  renderHealth(container, {
    rows: [{ group: 'codemie', label: 'Everything CodeMie needs to run is included', status: 'pass' }],
    summary: { passing: 1, total: 1 },
  }, {});
  assert.ok(container._innerText().includes('1 of 1 fine'));
  assert.ok(container._innerText().includes('CodeMie itself'));
  assert.ok(!container._innerText().includes('Your account'));
});

test('a row with a navigate action renders its label as a clickable button', () => {
  const container = makeEl('div');
  let navigatedTo = null;
  renderHealth(container, {
    rows: [{ group: 'tools', label: 'Agents', status: 'fail', action: { kind: 'navigate', view: 'agents', label: 'Go to Agents' } }],
    summary: { passing: 0, total: 1 },
  }, { onNavigate: (v) => { navigatedTo = v; } });
  container._findButton('Go to Agents')._click();
  assert.equal(navigatedTo, 'agents');
});

test('Check everything again calls onRecheck', () => {
  const container = makeEl('div');
  let recalled = false;
  renderHealth(container, { rows: [], summary: { passing: 0, total: 0 } }, { onRecheck: () => { recalled = true; } });
  container._findButton('Check everything again')._click();
  assert.ok(recalled);
});
```

(`_innerText()`/`_findButton()` are two small helpers to add to the adapted stub, mirroring how `steps-ui.test.mjs` adds `findByClass`.)

- [ ] **Step 2: Run and confirm failure** — `node --test ui/test/health-ui.test.mjs` fails: module doesn't exist.

- [ ] **Step 3: Implement**

```js
const GROUP_LABELS = { account: 'Your account', tools: 'Your tools', codemie: 'CodeMie itself' };
const GROUP_ORDER = ['account', 'tools', 'codemie'];

export function renderHealth(container, { rows, summary }, { onRecheck, onOpenLog, onNavigate } = {}) {
  container.innerHTML = '';
  const summaryEl = document.createElement('div');
  summaryEl.className = 'health-summary';
  summaryEl.textContent = `${summary.passing} of ${summary.total} fine`;
  container.appendChild(summaryEl);

  const actions = document.createElement('div');
  actions.className = 'health-actions';
  const recheckBtn = document.createElement('button');
  recheckBtn.textContent = 'Check everything again';
  recheckBtn.onclick = () => onRecheck && onRecheck();
  const logBtn = document.createElement('button');
  logBtn.textContent = "Open today's log";
  logBtn.onclick = () => onOpenLog && onOpenLog();
  actions.append(recheckBtn, logBtn);
  container.appendChild(actions);

  const logError = document.createElement('div');
  logError.className = 'health-log-error hidden';
  container.appendChild(logError);

  for (const group of GROUP_ORDER) {
    const groupRows = rows.filter((r) => r.group === group);
    if (!groupRows.length) continue;
    const heading = document.createElement('div');
    heading.className = 'health-group-heading';
    heading.textContent = GROUP_LABELS[group];
    container.appendChild(heading);
    groupRows.forEach((row) => container.appendChild(buildRow(row, { onRecheck, onNavigate })));
  }
}

function buildRow(row, { onRecheck, onNavigate }) {
  const el = document.createElement('div');
  el.className = `health-row health-${row.status}`;
  const icon = document.createElement('span');
  icon.textContent = row.status === 'pass' ? '✓' : '✗';
  const label = document.createElement('span');
  label.textContent = row.label;
  el.append(icon, label);
  if (row.status === 'fail' && row.remedyText) {
    const remedy = document.createElement('div');
    remedy.className = 'health-remedy';
    remedy.textContent = row.remedyText;
    el.appendChild(remedy);
  }
  if (row.action) {
    const btn = document.createElement('button');
    btn.textContent = row.action.label;
    btn.onclick = () => (row.action.kind === 'recheck' ? onRecheck?.() : onNavigate?.(row.action.view));
    el.appendChild(btn);
  }
  return el;
}

export function showLoading(container) {
  container.innerHTML = '';
  const el = document.createElement('div');
  el.className = 'health-loading';
  el.textContent = 'Checking…';
  container.appendChild(el);
}

export function showLogError(container, message) {
  const el = container.querySelector('.health-log-error');
  if (!el) return;
  el.textContent = message;
  el.classList.remove('hidden');
}
```

- [ ] **Step 4: Run and confirm pass** — `node --test ui/test/health-ui.test.mjs`.

- [ ] **Step 5: Commit**

---

### Task 5: Wire the Health screen into `renderer.js`

**Files:**
- Modify: `ui/renderer.js` (imports near `:1-12`; new function near `runAction`, `:298-307`; sidebar click handler, `:561-566`)

**Interfaces:**
- Consumes: `bridge.runner.runStream` (`ui/runner-bridge.js:17-30`), `parseDoctorOutput` (Task 2), `groupDoctorResults` (Task 3), `renderHealth`/`showLoading`/`showLogError` (Task 4), `views.health` (`renderer.js:75`), `showView` (`renderer.js:178-189`).

**Test-first: no** — this task only wires already-unit-tested pure modules (Tasks 2–4) into DOM/Tauri glue; there is no new decision logic here to isolate in a test, and the repo's own testing guide excludes `invoke()`/handler-integration territory from unit tests.

- [ ] **Step 1: Add imports**

```js
import { parseDoctorOutput } from './doctor-parse.js';
import { groupDoctorResults } from './doctor-groups.js';
import { renderHealth, showLoading, showLogError } from './health-ui.js';
```

- [ ] **Step 2: Add the run function** (placed alongside `runAction`, `renderer.js:296-307`)

```js
// Health screen's own doctor invocation — independent of wizard step 2.4,
// which stays exit-code-only. Filters to stdout lines only; doctor's own
// prompt/echo line ('> codemie doctor') and any stderr noise are dropped.
async function runHealthCheck() {
  showLoading(views.health);
  const lines = [];
  await bridge.runner.runStream('codemie doctor', (t, tag) => {
    if (tag === 'stdout') lines.push(t);
  });
  const grouped = groupDoctorResults(parseDoctorOutput(lines.join('\n')));
  renderHealth(views.health, grouped, {
    onRecheck: runHealthCheck,
    onNavigate: (view) => showView(view),
    onOpenLog: async () => {
      try {
        await invoke('open_log');
      } catch (e) {
        showLogError(views.health, `Can't read your log: ${(e && e.message) || e}`);
      }
    },
  });
}
```

- [ ] **Step 3: Auto-run on first navigation into the view.** Add `let healthChecked = false;` near the other module-level state (`renderer.js:163`), then in the sidebar click handler:

```js
document.querySelectorAll('#sidebar-main-group .sidebar-item, #sidebar-about').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (installRunning) return;
    showView(btn.dataset.view);
    if (btn.dataset.view === 'health' && !healthChecked) {
      healthChecked = true;
      runHealthCheck();
    }
  });
});
```

This replaces the plain `showView(btn.dataset.view);` body at `renderer.js:562-565`.

- [ ] **Step 4: Manual smoke check** (not the flow's own gate, just confirming the wire-up before commit) — run the app, click Health, confirm the loading state appears then resolves into grouped rows; click "Check everything again" and confirm it re-runs.

- [ ] **Step 5: Commit**

---

## Self-review notes

- Spec coverage: decision 1→Task 5 (separate call site, JS-only logic); decision 2→no task touches `ui/handlers.js`; decisions 3/4→Task 5's auto-run-once + shared `runHealthCheck` for both "Check everything again" and any per-row recheck action; decision 5→Task 3's dynamic `summary`; decisions 6/7→Task 3's `RUNTIME_NAMES`/`GROUP_BY_NAME`; decision 8→Task 3's `action` derivation + Task 4's button rendering; decision 9→no task touches `ui/log.js` or the footer button; decision 10→Task 1's `log_dir_with`; decision 11→Task 1's `ensure_log_readable`; decision 12→Task 2's fixtures.
- Negative constraints: verified none violated — see the Global Constraints section above, each tied to the task that honors it.
