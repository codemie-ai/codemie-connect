# EPMCDME-14651 Setup Prompt Parser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `ui/setup-parse.js` exporting `detectPrompt(screenLines)` — a pure function that identifies which inquirer prompt is visible on the current terminal screen — together with 13 fixture snapshots and a full test suite.

**Architecture:** The parser accepts an array of 30 strings (the current viewport extracted from a headless xterm Terminal at cols:100 rows:30 scrollback:0). Fixture files are JSON arrays of 30 strings captured from real `codemie setup` runs (9 per-id + 1 answered-detection fixture) via `script` + replay, and hand-authored (3). Tests feed fixture arrays directly to `detectPrompt`. No PTY, no DOM, no new dependencies.

**Tech Stack:** Node.js ESM, `node:test`, `node:assert/strict`, `ui/vendor/xterm.mjs` (already vendored).

**Spec:** `docs/superpowers/tasks/2026-09-04-epmcdme-14651-setup-prompt-parser/technical-analysis.md`

## Global Constraints

- Zero new npm dependencies — use only `ui/vendor/xterm.mjs` (already vendored). No node-pty, no jsdom.
- Do not touch `src-tauri/` at all; do not run cargo commands.
- Do not modify `ui/runner-bridge.js`, `ui/terminal.js`, or any PTY/driver/setup-view file.
- Do not add failure-classification logic (EPMCDME-14588 scope).
- Headless Terminal must be constructed with `{ cols: 100, rows: 30, scrollback: 0 }`.
- Never select "Update an existing profile" during any recording session.
- Commit per task using the repository's existing conventional-commit convention.

## Acceptance Criteria

- `detectPrompt(screenLines)` returns the correct `{ kind, id, message, options?, selectedIndex? }` for all 12 prompt ids and `null` for a blank/answered screen.
- 13 fixture files committed under `ui/test/fixtures/setup/` (9 per-id captured live, 3 per-id hand-authored, 1 answered-detection fixture).
- `ui/test/setup-parse.test.mjs` contains 14 tests (12 per-id + answered-not-re-detected + windowed-custom-excluded).
- `npm test` passes: 24 existing + 14 new = 38 total.
- Zero new npm dependencies; `src-tauri/` untouched.

---

## Files

| File | Status | Role |
|---|---|---|
| `ui/test/fixtures/setup/<id>.json` | Create (12 files) | Screen snapshot per prompt id — JSON array of 30 strings |
| `ui/test/fixtures/setup/provider-answered-then-next-open.json` | Create (1 file) | Screen where provider is answered + next prompt is open — used for answered-detection test |
| `ui/test/tools/replay-capture.mjs` | Create (development tool) | Replays a `script` typescript file through headless xterm, auto-snapshots at each prompt boundary |
| `ui/test/setup-parse.test.mjs` | Create | 14 node:test tests |
| `ui/setup-parse.js` | Create | Exports `detectPrompt(screenLines)` |

`ui/test/tools/` is used rather than a non-existent `scripts/` root so the capture tool stays adjacent to the fixtures and tests that depend on its output.

---

### Task 1: Fixture capture and hand-authoring

**Files:**
- Create: `ui/test/tools/replay-capture.mjs`
- Create: `ui/test/fixtures/setup/*.json` (13 files)

**Test-first: no — produces test data (fixture files), not implementation code**

- [ ] **Step 1: Back up global config**

  Run from any directory OUTSIDE this repository:
  ```
  cp ~/.codemie/codemie-cli.config.json ~/.codemie/codemie-cli.config.json.bak
  ```
  Keep the backup in place until after Recording C (the gate run) is complete.

- [ ] **Step 2: Write the replay-capture helper**

  Create `ui/test/tools/replay-capture.mjs`. This tool reads a typescript file produced by `script`, feeds its bytes in chunks through a headless xterm Terminal, and after each chunk detects when the visible question line changes — snapshotting the screen at each prompt boundary. No node-pty, no live PTY, no interactive key handling.

  ```js
  import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
  import { fileURLToPath } from 'node:url';
  import { Terminal } from '../../vendor/xterm.mjs';

  const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/setup/', import.meta.url));
  mkdirSync(FIXTURE_DIR, { recursive: true });

  // Ordered: specific anchors first, catch-all credential last.
  const ANCHOR_MAP = [
    ['What would you like to do?',                 'gate'],
    ['Where would you like to store this',         'storage'],
    ['Choose your LLM provider:',                  'provider'],
    ['CodeMie organization URL:',                  'codemieUrl'],
    ['Select your project:',                       'codemieProject'],
    ['Choose a model',                             'model'],
    ['Enter model name:',                          'customModel'],
    ['No models found. Enter model name manually:','modelManual'],
    ['Enter a name for this profile:',             'profileName'],
    ['Switch to profile',                          'activate'],
    ['Would you like to install Claude Code now?', 'installClaude'],
  ];

  const isQuestion = (l) => l.trimStart().startsWith('?');

  function promptId(line) {
    for (const [anchor, id] of ANCHOR_MAP) {
      if (line.includes(anchor)) return id;
    }
    if (isQuestion(line)) return 'credential';
    return null;
  }

  function readScreen(term) {
    const buf = term.buffer.active;
    const lines = [];
    for (let r = buf.baseY; r < buf.baseY + 30; r++) {
      lines.push(buf.getLine(r)?.translateToString(true) ?? '');
    }
    return lines;
  }

  const tsFile = process.argv[2];
  if (!tsFile) { console.error('Usage: node replay-capture.mjs <typescript-file>'); process.exit(1); }
  const bytes = readFileSync(tsFile);

  const term = new Terminal({ cols: 100, rows: 30, scrollback: 0 });
  const snapped = new Set();
  let prevQuestion = '';

  const CHUNK = 256;
  let i = 0;
  function next() {
    if (i >= bytes.length) { console.log('Done:', [...snapped].join(', ')); return; }
    const chunk = bytes.slice(i, i + CHUNK);
    i += CHUNK;
    term.write(chunk, () => {
      const lines = readScreen(term);
      const qLine = lines.find(isQuestion) ?? '';
      if (qLine && qLine !== prevQuestion) {
        const id = promptId(qLine);
        if (id && !snapped.has(id)) {
          snapped.add(id);
          writeFileSync(`${FIXTURE_DIR}/${id}.json`, JSON.stringify(lines, null, 2));
          console.log(`Captured: ${id}`);
          // When the first post-provider prompt appears, the answered provider line
          // is already on screen above it — save that composite screen as the
          // answered-detection fixture used by the re-detection test.
          if ((id === 'codemieUrl' || id === 'credential') && !snapped.has('provider-answered-then-next-open')) {
            snapped.add('provider-answered-then-next-open');
            writeFileSync(`${FIXTURE_DIR}/provider-answered-then-next-open.json`, JSON.stringify(lines, null, 2));
            console.log('Captured: provider-answered-then-next-open');
          }
        }
        prevQuestion = qLine;
      }
      next();
    });
  }
  next();
  ```

- [ ] **Step 3: Recording A — SSO/CodeMie-backed provider (--force)**

  Captures: `storage`, `provider`, `codemieUrl`, `model`, `customModel`, `profileName`, `activate`, `provider-answered-then-next-open`.

  From a directory OUTSIDE the repository:
  ```
  script -q /tmp/recording-a.log codemie setup --force
  ```
  Drive the setup interactively: pick any storage option; choose a CodeMie-backed provider (SSO or similar — required to reach `codemieUrl`); enter the URL; proceed through the model list (navigate to "Custom model (manual entry)..." and press Enter to reach `customModel`); set a profile name; confirm activation. The `script` session ends when setup completes.

  Replay and snapshot:
  ```
  node ui/test/tools/replay-capture.mjs /tmp/recording-a.log
  ```
  Expected output includes: `storage, provider, codemieUrl, provider-answered-then-next-open, model, customModel, profileName, activate`.

- [ ] **Step 4: Verify answered-line prefix in captured fixtures**

  Open `ui/test/fixtures/setup/provider-answered-then-next-open.json`. Find the line for the answered provider prompt — it must look like:
  ```
  "✔ Choose your LLM provider: <chosen option>"
  ```
  If the line instead starts with `?` (e.g. `? Choose your LLM provider: ...`), the `isQuestion` helper used in Task 3's detection logic will NOT correctly distinguish answered from open lines. **Stop here and revise the detection approach** before proceeding to Task 3 — it is far cheaper to discover this now from a fixture than from a failing test after implementation.

  If the line starts with `✔` (or any non-`?` character), proceed.

- [ ] **Step 5: Recording B — API-key provider (--force)**

  Captures: `credential`.

  ```
  script -q /tmp/recording-b.log codemie setup --force
  ```
  Choose any API-key provider (e.g. Anthropic, OpenAI). Complete the flow so the credential prompt appears and is answered.

  Replay:
  ```
  node ui/test/tools/replay-capture.mjs /tmp/recording-b.log
  ```
  Expected: `Captured: credential` (other ids already snapped are skipped; `provider-answered-then-next-open` is saved here too if Recording A used SSO and credential wasn't seen yet).

- [ ] **Step 6: Recording C — gate prompt (no --force)**

  Captures: `gate`. Requires existing global config left by Recording A or B.

  ```
  script -q /tmp/recording-c.log codemie setup
  ```
  "What would you like to do?" appears. Press Ctrl-C immediately — do not complete the run.

  Replay:
  ```
  node ui/test/tools/replay-capture.mjs /tmp/recording-c.log
  ```
  Expected: `Captured: gate`.

- [ ] **Step 7: Hand-author the 3 unreachable fixtures**

  Each file is a JSON array of exactly 30 strings. Fill unused rows with `""`.

  `ui/test/fixtures/setup/codemieProject.json`:
  ```json
  ["", "? Select your project:  (Use arrow keys)", "> Project Alpha", "  Project Beta",
   "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""]
  ```

  `ui/test/fixtures/setup/modelManual.json`:
  ```json
  ["", "? No models found. Enter model name manually: ", "",
   "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""]
  ```

  `ui/test/fixtures/setup/installClaude.json`:
  ```json
  ["", "? Would you like to install Claude Code now? (Y/n) ", "",
   "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""]
  ```

- [ ] **Step 8: Verify all 13 fixture files are well-formed**

  ```
  node --input-type=module <<'EOF'
  import { readdirSync, readFileSync } from 'node:fs';
  const dir = 'ui/test/fixtures/setup';
  for (const f of readdirSync(dir)) {
    const lines = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'));
    if (!Array.isArray(lines) || lines.length !== 30) throw new Error(`Bad fixture: ${f}`);
  }
  console.log('All fixtures OK');
  EOF
  ```

- [ ] **Step 9: Restore global config**

  ```
  mv ~/.codemie/codemie-cli.config.json.bak ~/.codemie/codemie-cli.config.json
  ```

- [ ] **Step 10: Commit**

  ```
  git add ui/test/tools/replay-capture.mjs ui/test/fixtures/setup/
  git commit -m "test: EPMCDME-14651 task-1 — fixture files for all 12 setup prompt ids"
  ```

---

### Task 2: Write failing test file

**Files:**
- Create: `ui/test/setup-parse.test.mjs`

**Test-first: yes — all 14 tests fail RED because `ui/setup-parse.js` does not yet exist**

- [ ] **Step 1: Create the test file**

  Create `ui/test/setup-parse.test.mjs`:

  ```js
  import { test } from 'node:test';
  import assert from 'node:assert/strict';
  import { readFileSync } from 'node:fs';
  import { fileURLToPath } from 'node:url';
  import { detectPrompt } from '../setup-parse.js';

  function fixture(id) {
    const p = fileURLToPath(new URL(`fixtures/setup/${id}.json`, import.meta.url));
    return JSON.parse(readFileSync(p, 'utf8'));
  }

  const CASES = [
    ['gate',          'list',    'What would you like to do?'],
    ['storage',       'list',    'Where would you like to store this configuration?'],
    ['provider',      'list',    'Choose your LLM provider:'],
    ['codemieUrl',    'input',   'CodeMie organization URL:'],
    ['codemieProject','list',    'Select your project:'],
    ['credential',    'input',   null],          // message is provider-specific
    ['model',         'list',    'Choose a model'],
    ['customModel',   'input',   'Enter model name:'],
    ['modelManual',   'input',   'No models found. Enter model name manually:'],
    ['profileName',   'input',   'Enter a name for this profile:'],
    ['activate',      'confirm', 'Switch to profile'],
    ['installClaude', 'confirm', 'Would you like to install Claude Code now?'],
  ];

  for (const [id, kind, msgSnippet] of CASES) {
    test(`detectPrompt identifies "${id}"`, () => {
      const r = detectPrompt(fixture(id));
      assert.ok(r !== null, 'expected non-null');
      assert.equal(r.id, id);
      assert.equal(r.kind, kind);
      if (msgSnippet) assert.ok(r.message.includes(msgSnippet), `message="${r.message}"`);
    });
  }

  // Fixture captures a screen where the provider prompt is answered (✔ prefix) and the
  // next prompt (codemieUrl or credential) is already open below it.
  // The parser must return the NEXT prompt's id — never 'provider' again.
  test('answered provider prompt is not re-detected when next prompt is open', () => {
    const r = detectPrompt(fixture('provider-answered-then-next-open'));
    assert.ok(r !== null, 'expected non-null — next open prompt should be detected');
    assert.notEqual(r.id, 'provider', 'answered provider must not be re-detected');
    assert.ok(
      r.id === 'codemieUrl' || r.id === 'credential',
      `expected codemieUrl or credential, got: ${r.id}`
    );
  });

  test('windowed model list excludes trailing Custom row from options', () => {
    const r = detectPrompt(fixture('model'));
    assert.ok(r !== null && r.kind === 'list');
    assert.ok(
      !r.options?.some(o => /custom/i.test(o) && /manual/i.test(o)),
      'Custom row must be excluded from options'
    );
  });
  ```

- [ ] **Step 2: Run — verify all 14 fail**

  ```
  node --test ui/test/setup-parse.test.mjs
  ```
  Expected: 14 failures, all with "Cannot find module '../setup-parse.js'" or equivalent.

- [ ] **Step 3: Commit**

  ```
  git add ui/test/setup-parse.test.mjs
  git commit -m "test: EPMCDME-14651 task-2 — 14 failing tests for setup prompt parser"
  ```

---

### Task 3: Implement ui/setup-parse.js

**Files:**
- Create: `ui/setup-parse.js`

**Test-first: yes — the 14 failing tests from Task 2 drive this implementation**

- [ ] **Step 1: Smoke-verify xterm.mjs in Node**

  ```
  node --input-type=module <<'EOF'
  import { Terminal } from './ui/vendor/xterm.mjs';
  const t = new Terminal({ cols: 100, rows: 30, scrollback: 0 });
  await new Promise(r => t.write('\x1b[?25h hello', r));
  const line = t.buffer.active.getLine(0).translateToString(true);
  console.log(JSON.stringify(line));   // must contain "hello"
  EOF
  ```
  If this errors on a missing browser global, shim it minimally (e.g. `globalThis.document = undefined`) and retry.

- [ ] **Step 2: Verify `buffer.active.baseY` in the vendor bundle**

  ```
  node --input-type=module <<'EOF'
  import { Terminal } from './ui/vendor/xterm.mjs';
  const t = new Terminal({ cols: 100, rows: 30, scrollback: 0 });
  await new Promise(r => t.write('test', r));
  console.log('baseY:', t.buffer.active.baseY);  // must be a number
  EOF
  ```
  If `baseY` is undefined, iterate rows 0–29 directly instead of `baseY` through `baseY + 29`.

- [ ] **Step 3: Implement `ui/setup-parse.js`**

  ```js
  /**
   * Pure prompt parser for the codemie setup CLI.
   * @param {string[]} screenLines  30-element array — current viewport, no scrollback.
   * @returns {{ kind, id, message, options?, selectedIndex? } | null}
   */

  // A line is an open question iff it starts with '?' (ignoring leading whitespace).
  // Answered inquirer lines begin with '✔' or similar — never '?'.
  const isQuestion = (l) => l.trimStart().startsWith('?');

  // Ordered: all named anchors first; credential catch-all last.
  const PROMPTS = [
    { id: 'gate',          kind: 'list',    anchor: 'What would you like to do?' },
    { id: 'storage',       kind: 'list',    anchor: 'Where would you like to store this configuration?' },
    { id: 'provider',      kind: 'list',    anchor: 'Choose your LLM provider:' },
    { id: 'codemieUrl',    kind: 'input',   anchor: 'CodeMie organization URL:' },
    { id: 'codemieProject',kind: 'list',    anchor: 'Select your project:' },
    { id: 'model',         kind: 'list',    anchor: 'Choose a model' },
    { id: 'customModel',   kind: 'input',   anchor: 'Enter model name:' },
    { id: 'modelManual',   kind: 'input',   anchor: 'No models found. Enter model name manually:' },
    { id: 'profileName',   kind: 'input',   anchor: 'Enter a name for this profile:' },
    { id: 'activate',      kind: 'confirm', anchor: 'Switch to profile' },
    { id: 'installClaude', kind: 'confirm', anchor: 'Would you like to install Claude Code now?' },
    // credential: provider-specific message; detected when no other anchor appears on an open line.
    { id: 'credential',    kind: 'input',   anchor: null },
  ];

  export function detectPrompt(screenLines) {
    for (const spec of PROMPTS) {
      const result = _tryDetect(screenLines, spec);
      if (result) return result;
    }
    return null;
  }

  function _tryDetect(lines, spec) {
    let anchorIdx, message;

    if (spec.id === 'credential') {
      // Only match when no other spec's anchor appears on an open question line.
      // Answered lines (✔ prefix) are ignored — they may still contain anchor text.
      if (PROMPTS.some(p => p.anchor && lines.some(l => isQuestion(l) && l.includes(p.anchor)))) {
        return null;
      }
      anchorIdx = lines.findIndex(isQuestion);
      if (anchorIdx === -1) return null;
      message = _promptMessage(lines[anchorIdx]);
    } else {
      // Match only on open question lines — skip answered lines that share anchor text.
      anchorIdx = lines.findIndex(l => isQuestion(l) && l.includes(spec.anchor));
      if (anchorIdx === -1) return null;
      message = _promptMessage(lines[anchorIdx]);
    }

    if (spec.kind === 'list') {
      const { options, selectedIndex } = _parseListOptions(lines, anchorIdx);
      if (options.length === 0) return null; // no visible options → not a real open list
      return { kind: 'list', id: spec.id, message, options, selectedIndex };
    }

    return { kind: spec.kind, id: spec.id, message };
  }

  /** Strip the leading '? ' from an inquirer prompt line to get the display message. */
  function _promptMessage(line) {
    return line.replace(/^\s*\?\s*/, '').trim();
  }

  function _parseListOptions(lines, anchorIdx) {
    const options = [];
    let selectedIndex = 0;
    for (let r = anchorIdx + 1; r < lines.length; r++) {
      const raw = lines[r];
      const trimmed = raw.trim();
      if (!trimmed) break;
      // Inquirer navigation hints — end of option block.
      if (trimmed.startsWith('(')) break;
      // Exclude the trailing "Custom model (manual entry)..." row.
      if (/custom model/i.test(trimmed) && /manual/i.test(trimmed)) continue;
      const isSelected = /^[>❯]/.test(raw.trimStart());
      const label = trimmed.replace(/^[>❯]\s*/, '').trim();
      if (!label) continue;
      if (isSelected) selectedIndex = options.length;
      options.push(label);
    }
    return { options, selectedIndex };
  }
  ```

- [ ] **Step 4: Run the parser tests**

  ```
  node --test ui/test/setup-parse.test.mjs
  ```
  Work through any failures one at a time: adjust anchor strings to match actual fixture text, tune `_parseListOptions` break conditions if the option block delimiter differs from what the fixtures show.

- [ ] **Step 5: Run the full suite**

  ```
  npm test
  ```
  Expected: 38 tests pass (24 existing + 14 new). Zero regressions.

- [ ] **Step 6: Mutation verification (do not commit)**

  Temporarily remove the `storage` entry from `PROMPTS`. Run `node --test ui/test/setup-parse.test.mjs`. Confirm exactly the `"storage"` test fails and all others pass. Restore the entry. Repeat for one more id of your choosing.

- [ ] **Step 7: Commit**

  ```
  git add ui/setup-parse.js
  git commit -m "feat: EPMCDME-14651 task-3 — detectPrompt parser for all 12 setup prompt ids"
  ```

---

## Self-Review

**Spec coverage:**
- All 12 prompt ids in `PROMPTS` and test CASES: covered.
- `detectPrompt` return shape (kind, id, message, options, selectedIndex): covered in Task 3.
- scrollback:0 / current-viewport reading: enforced in smoke steps and replay-capture helper.
- Custom row excluded from `options`: covered in `_parseListOptions` + windowed-custom test in Task 2.
- Answered-prompt not re-detected: covered by `isQuestion` gating both branches so answered lines (✔ prefix) are never matched as anchors, plus the `provider-answered-then-next-open` fixture test in Task 2.
- Verify answered-line prefix from real fixture before implementing: covered in Task 1 Step 4.
- Windowed list hint line stops option parsing: covered by `startsWith('(')` break.
- credential catch-all — fires only when no other anchor appears on an open question line: covered (PROMPTS-scoped one-condition check using `isQuestion`).
- message is full prompt line minus leading `? `, not text sliced after anchor: covered by `_promptMessage`.
- Three separate recordings (A: SSO, B: API-key, C: gate): covered in Steps 3–6 of Task 1.
- Config backup before Recording A, restore after Recording C: covered in Steps 1 and 9 of Task 1.
- 3 unreachable fixtures hand-authored: covered in Step 7 of Task 1.
- `npm test` green (38 tests): Step 5 of Task 3.
- Mutation verification: Step 6 of Task 3.

**Negative constraints:**
- No node-pty in any new file: `ui/setup-parse.js` has zero imports; `replay-capture.mjs` imports only `ui/vendor/xterm.mjs` and Node built-ins. Confirmed.
- No failure-classification logic: no task adds it. Confirmed.
- No pty/driver/setup-view modifications: no task references them. Confirmed.
- `src-tauri/` untouched, no cargo commands: no task references either. Confirmed.
- No new npm dependencies: zero packages added. Confirmed.
- Never "Update an existing profile": Steps 3–6 of Task 1 direct the developer to add-new-profile flows only. Confirmed.

**negative-constraints check:** all confirmed above; no task violates any negative constraint stated in the requirements.
