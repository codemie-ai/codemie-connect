# EPMCDME-14654 — steps-ui factory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `ui/steps-ui.js` instantiable via `createStepsUi()` so multiple independent step lists can coexist, while keeping all existing named exports working unchanged.

**Architecture:** Lift the four module-globals (`rows`, `spinners`, `listEl`, `stepsById`) into a factory-function closure; reconstruct `buildRow` and `applyStatus` as inner functions that close over the same instance state; re-export the nine functions of a default instance as module-level named exports so `ui/renderer.js` needs no change. Add a first-ever DOM-touching test using a hand-crafted stub, no new dependencies.

**Tech Stack:** Vanilla ESM, `node:test`, `node:assert/strict`, hand-written DOM stub (no jsdom).

**Spec:** requirements inline (EPMCDME-14654).

## Global Constraints

- Zero new npm dependencies — no jsdom, no sinon, nothing.
- Do NOT modify `ui/renderer.js` or any other existing call site.
- Do NOT touch `STATUS_META` at `ui/steps-ui.js:3-10`.
- Do NOT touch any Rust file (`src-tauri/`).
- `npm test` must stay green at **24/24** (19 existing + 5 new tests).
- TDD order: RED (failing test) → GREEN (implementation) within the same task.
- Commit per task using the repository's existing conventional-commit convention.

---

## Acceptance criteria

- [ ] `createStepsUi()` is exported from `ui/steps-ui.js` and returns an object with all nine functions.
- [ ] Two instances rendered into separate containers update independently; positive assertions confirm instA's mutations landed in containerA AND containerB is untouched.
- [ ] `insertSubStep` with an unknown `parentId` falls back to the calling instance's own `listEl` — the orphan lands in its own container, never the other instance's container.
- [ ] `insertSubStep` under a known parent inserts the sub-step immediately after that parent's row in the same container.
- [ ] All nine existing named exports remain present and behave identically for a single-instance caller (`ui/renderer.js` unchanged).
- [ ] `npm test` passes at 24/24 with no timer leaks hanging `node --test`.
- [ ] No production file change exists solely to accommodate the test stub.

---

### Task 1: Write five failing tests (RED)

**Files:**
- Create: `ui/test/steps-ui.test.mjs`

**Interfaces:**
- Consumes: `createStepsUi` named export from `../steps-ui.js` (does not exist yet — the import will resolve to `undefined`, making every test fail as required).

- [ ] **Step 1: Create `ui/test/steps-ui.test.mjs` with the DOM stub and five failing tests**

```js
// ui/test/steps-ui.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── Minimal DOM stub ─────────────────────────────────────────────────────────
// No setInterval/clearInterval shims needed — none of these tests call
// startSpinner, so no timers are ever created.

function makeEl(tag) {
  const el = {
    _tag: tag,
    _children: [],
    _listeners: {},
    className: '',
    dataset: {},
    textContent: '',
    style: {},
    get nextSibling() {
      const p = el._parent;
      if (!p) return null;
      const i = p._children.indexOf(el);
      return i >= 0 ? (p._children[i + 1] ?? null) : null;
    },
    get parentNode() { return el._parent ?? null; },
    querySelector(sel) {
      const cls = sel.replace(/^\./, '');
      return findByClass(el, cls);
    },
    appendChild(child) {
      child._parent = el;
      el._children.push(child);
      return child;
    },
    insertBefore(newEl, ref) {
      newEl._parent = el;
      const i = el._children.indexOf(ref);
      if (i >= 0) el._children.splice(i, 0, newEl);
      else el._children.push(newEl);
      return newEl;
    },
    classList: {
      _set: new Set(),
      toggle(cls, force) {
        if (force === true) el.classList._set.add(cls);
        else if (force === false) el.classList._set.delete(cls);
        else if (el.classList._set.has(cls)) el.classList._set.delete(cls);
        else el.classList._set.add(cls);
      },
    },
    remove() {
      const p = el._parent;
      if (p) p._children = p._children.filter((c) => c !== el);
    },
    set onclick(fn) { el._listeners.click = fn; },
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._innerHTML ?? ''; },
    set(html) {
      el._innerHTML = html;
      el._children = [];
      const re = /<(?:div|button)[^>]+class="([^"]+)"/g;
      let m;
      while ((m = re.exec(html)) !== null) {
        for (const cls of m[1].split(/\s+/)) {
          const child = makeEl('div');
          child._cls = cls;
          child._parent = el;
          el._children.push(child);
        }
      }
    },
  });
  return el;
}

function findByClass(root, cls) {
  for (const c of root._children) {
    if (c._cls === cls || c.className === cls || (c.className ?? '').split(' ').includes(cls)) return c;
    const found = findByClass(c, cls);
    if (found) return found;
  }
  return null;
}

globalThis.document = { createElement: (tag) => makeEl(tag) };

// ── Import module under test (after stub is in place) ───────────────────────
const { createStepsUi } = await import('../steps-ui.js');

// ── Helpers ──────────────────────────────────────────────────────────────────
function mkSteps(prefix) {
  return [
    { id: `${prefix}-a`, title: `${prefix} Step A`, status: 'PENDING', is_sub_step: false },
    { id: `${prefix}-b`, title: `${prefix} Step B`, status: 'PENDING', is_sub_step: false },
  ];
}

// ── Tests ────────────────────────────────────────────────────────────────────

// Test 1 — factory is present
test('createStepsUi() is a function', () => {
  assert.equal(typeof createStepsUi, 'function');
});

// Test 2 — instances stay independent; positive assertions required
test('two instances render into separate containers independently', () => {
  const instA = createStepsUi();
  const instB = createStepsUi();
  const containerA = makeEl('div');
  const containerB = makeEl('div');

  instA.renderSteps(containerA, mkSteps('a')); // a-a at [0], a-b at [1]
  instB.renderSteps(containerB, mkSteps('b')); // b-a at [0], b-b at [1]

  assert.equal(containerA._children.length, 2);
  assert.equal(containerB._children.length, 2);

  instA.setStatus('a-a', 'ACTIVE');
  instA.setProgress('a-a', 0.5);

  // NEGATIVE: containerB must not have grown
  assert.equal(containerB._children.length, 2, 'containerB child count unchanged');

  // POSITIVE: instA's mutations must have landed in containerA
  // (these fail under shared module-global state where instB.renderSteps cleared rows)
  const rowA = containerA._children[0]; // a-a row
  assert.ok(
    rowA.classList._set.has('active'),
    'setStatus(ACTIVE) landed in containerA row',
  );
  const progressEl = findByClass(rowA, 'step-progress');
  assert.equal(
    progressEl.style.width,
    '50%',
    'setProgress(0.5) landed in containerA progress bar',
  );
});

// Test 3 — unknown parent: orphan falls back to own listEl, not the other instance's
test('insertSubStep with unknown parentId appends to own container, not the other', () => {
  const instA = createStepsUi();
  const instB = createStepsUi();
  const containerA = makeEl('div');
  const containerB = makeEl('div');

  instA.renderSteps(containerA, mkSteps('a'));
  instB.renderSteps(containerB, mkSteps('b'));

  const beforeA = containerA._children.length; // 2
  const beforeB = containerB._children.length; // 2

  // Unknown parent triggers the else-if (listEl) fallback
  instA.insertSubStep('NONEXISTENT-PARENT', {
    id: 'orphan-sub',
    title: 'Orphan',
    status: 'PENDING',
    is_sub_step: true,
  });

  // Orphan must land in instA's own container (containerA), never containerB.
  // Under shared module-global state, listEl = containerB (instB rendered last),
  // so containerB would grow — both assertions would fail.
  assert.equal(
    containerA._children.length,
    beforeA + 1,
    'orphan appended to instA\'s own container',
  );
  assert.equal(containerB._children.length, beforeB, 'containerB untouched');
});

// Test 4 — known parent: sub-step inserted immediately after parent's row
test('insertSubStep under known parent inserts right after parent row inside own container', () => {
  const instA = createStepsUi();
  const instB = createStepsUi();
  const containerA = makeEl('div');
  const containerB = makeEl('div');

  instA.renderSteps(containerA, mkSteps('a')); // a-a at [0], a-b at [1]
  instB.renderSteps(containerB, mkSteps('b'));

  const beforeB = containerB._children.length;

  // a-a has a-b as nextSibling — triggers the insertBefore path
  instA.insertSubStep('a-a', {
    id: 'a-a-sub',
    title: 'Sub of A-A',
    status: 'PENDING',
    is_sub_step: true,
  });

  // Result should be [a-a, a-a-sub, a-b] in containerA
  assert.equal(containerA._children.length, 3, 'containerA gained one row');
  assert.equal(
    containerA._children[1].dataset.id,
    'a-a-sub',
    'sub-step inserted right after parent (index 1)',
  );
  assert.equal(containerB._children.length, beforeB, 'containerB untouched');
});

// Test 5 — nine default named exports remain present
test('createStepsUi() is a function and the nine default exports are intact', async () => {
  assert.equal(typeof createStepsUi, 'function');
  const mod = await import('../steps-ui.js');
  for (const name of ['renderSteps', 'setStatus', 'setSubtitle', 'startSpinner', 'stopSpinner',
                       'setProgress', 'insertSubStep', 'showApproval', 'stampApproval']) {
    assert.equal(typeof mod[name], 'function', `${name} must stay exported`);
  }
});
```

- [ ] **Step 2: Run the test to confirm RED**

  ```
  node --test ui/test/steps-ui.test.mjs
  ```

  Expected: all five tests fail — `createStepsUi` is `undefined` because the export does not exist yet.

---

### Task 2: Implement the factory and re-export default instance (GREEN)

**Files:**
- Modify: `ui/steps-ui.js` (lines 13 onward; lines 1–11 — `STATUS_META` and `SPINNER` — are untouched)

**Interfaces:**
- Produces: `createStepsUi()` named export; nine existing named exports re-exported from a default instance.

- [ ] **Step 1: Replace lines 13–end of `ui/steps-ui.js` with the factory**

  Keep lines 1–11 exactly as they are. Replace everything from line 13 onward.

  IMPORTANT: Preserve every function body byte-for-byte from the current `ui/steps-ui.js`. Specifically:
  - Do NOT rewrite `SPINNER[i % SPINNER.length]; i += 1;` to `SPINNER[i++ % SPINNER.length]` — they are equivalent but the original line has no test coverage and this is a structural refactor only.
  - Do NOT rewrite `onApprove && onApprove()` to `onApprove?.()` — same reason.

  The diff must be limited to the closure/scoping change (module-globals → closure state, default-instance re-export block). No incidental style rewrites.

```js
export function createStepsUi() {
  const rows = new Map();
  const spinners = new Map();
  let listEl = null;
  let stepsById = new Map();

  function buildRow(step) {
    const el = document.createElement('div');
    el.className = 'step-row' + (step.is_sub_step ? ' sub' : '');
    el.dataset.id = step.id;
    el.innerHTML = `
      <div class="step-progress"></div>
      <div class="step-icon">○</div>
      <div class="step-main">
        <div class="step-title"></div>
        <div class="step-sub"></div>
      </div>`;
    el.querySelector('.step-title').textContent = step.title;
    el.querySelector('.step-sub').textContent = step.description || '';
    const rec = {
      el,
      icon: el.querySelector('.step-icon'),
      title: el.querySelector('.step-title'),
      sub: el.querySelector('.step-sub'),
      main: el.querySelector('.step-main'),
      progress: el.querySelector('.step-progress'),
    };
    rows.set(step.id, rec);
    applyStatus(step.id, step.status || 'PENDING');
    return el;
  }

  function applyStatus(id, status) {
    const rec = rows.get(id);
    if (!rec) return;
    const meta = STATUS_META[status] || STATUS_META.PENDING;
    rec.el.classList.toggle('active', status === 'ACTIVE');
    if (status !== 'ACTIVE') stopSpinner(id);
    if (!spinners.has(id)) {
      rec.icon.textContent = meta.icon;
      rec.icon.style.color = meta.color;
    }
  }

  function renderSteps(container, list) {
    listEl = container;
    container.innerHTML = '';
    rows.clear();
    stepsById = new Map(list.map((s) => [s.id, s]));
    for (const step of list) {
      if (step.is_sub_step) continue;
      container.appendChild(buildRow(step));
    }
  }

  function setStatus(id, status) { applyStatus(id, status); }

  function setSubtitle(id, text) {
    const rec = rows.get(id);
    if (rec && text) rec.sub.textContent = text;
  }

  function startSpinner(id) {
    const rec = rows.get(id);
    if (!rec || spinners.has(id)) return;
    let i = 0;
    rec.icon.style.color = '#58a6ff';
    const t = setInterval(() => { rec.icon.textContent = SPINNER[i % SPINNER.length]; i += 1; }, 80);
    spinners.set(id, t);
  }

  function stopSpinner(id) {
    const t = spinners.get(id);
    if (t) { clearInterval(t); spinners.delete(id); }
  }

  function setProgress(id, frac) {
    const rec = rows.get(id);
    if (rec) rec.progress.style.width = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
  }

  // Keep the else-if (listEl) fallback — closure-scoped to this instance.
  // An orphan sub-step falls back to this instance's own listEl, never
  // another instance's. ui/renderer.js:122 depends on this fallback.
  function insertSubStep(parentId, step) {
    if (rows.has(step.id)) return;
    const parentRec = rows.get(parentId);
    const el = buildRow(step);
    if (parentRec && parentRec.el.nextSibling) {
      parentRec.el.parentNode.insertBefore(el, parentRec.el.nextSibling);
    } else if (listEl) {
      listEl.appendChild(el);
    }
  }

  function showApproval(id, message, onApprove, onIgnore) {
    const rec = rows.get(id);
    if (!rec) return;
    if (message) rec.sub.textContent = message;
    rec.main.querySelector('.approval')?.remove();
    const bar = document.createElement('div');
    bar.className = 'approval';
    bar.innerHTML = '<button class="btn-approve">✓ Approve</button><button class="btn-ignore">— Ignore</button>';
    bar.querySelector('.btn-approve').onclick = () => { stampApproval(id, true); onApprove && onApprove(); };
    bar.querySelector('.btn-ignore').onclick = () => { stampApproval(id, false); onIgnore && onIgnore(); };
    rec.main.appendChild(bar);
  }

  function stampApproval(id, approved) {
    const rec = rows.get(id);
    if (!rec) return;
    rec.main.querySelector('.approval')?.remove();
    if (rec.main.querySelector('.stamp')) return;
    const stamp = document.createElement('div');
    stamp.className = 'stamp ' + (approved ? 'approved' : 'ignored');
    stamp.textContent = approved ? '✓ APPROVED' : '— IGNORED';
    rec.main.appendChild(stamp);
  }

  return { renderSteps, setStatus, setSubtitle, startSpinner, stopSpinner,
           setProgress, insertSubStep, showApproval, stampApproval };
}

// Default instance — keeps all existing named exports intact so
// `import * as stepsUI` in ui/renderer.js needs no change.
const _default = createStepsUi();
export const renderSteps   = _default.renderSteps;
export const setStatus     = _default.setStatus;
export const setSubtitle   = _default.setSubtitle;
export const startSpinner  = _default.startSpinner;
export const stopSpinner   = _default.stopSpinner;
export const setProgress   = _default.setProgress;
export const insertSubStep = _default.insertSubStep;
export const showApproval  = _default.showApproval;
export const stampApproval = _default.stampApproval;
```

- [ ] **Step 2: Run the new test file in isolation to confirm GREEN**

  ```
  node --test ui/test/steps-ui.test.mjs
  ```

  Expected: all five tests pass, no timer leak, process exits cleanly.

- [ ] **Step 3: Run the full suite to confirm 24/24**

  ```
  npm test
  ```

  Expected: **24 passing, 0 failing** (19 pre-existing + 5 new). Do not accept 20/20 — that would mean a test was silently lost. Pre-existing Rust failures are out of scope.

---

## negative-constraints

| Constraint | Task that honours it |
|---|---|
| Do NOT touch `STATUS_META` at `:3-10` | Task 2 — lines 1–11 explicitly preserved |
| Do NOT change `ui/renderer.js` | Both tasks — renderer.js is never opened |
| Do NOT touch any Rust file | Both tasks — `src-tauri/` is never opened |
| `insertSubStep` orphan must fall back to own instance's `listEl`, never another instance's | Task 2 — `else if (listEl)` uses the per-instance closure variable; test 3 verifies this with a cross-instance assertion that fails under shared state |
| `insertSubStep` `else if (listEl)` fallback body must not be removed | Task 2 — ui/renderer.js:122 is a live caller that depends on the fallback path |
| Zero new npm dependencies | Task 1 — stub is hand-written; no new imports |
| No setInterval/clearInterval stubs in DOM stub | Task 1 — none of the five tests call startSpinner; no timers are created; no shims needed |
| No production code changes to accommodate the test stub | Both tasks — stub lives entirely in `ui/test/steps-ui.test.mjs` |
| `startSpinner` body preserves `SPINNER[i % SPINNER.length]; i += 1;` verbatim | Task 2 — no style rewrite; structural refactor only |
| `showApproval` body preserves `onApprove && onApprove()` verbatim | Task 2 — no optional-chaining rewrite; structural refactor only |
| Do not add a whole-suite quality-gate task | Not present — the calling flow owns that stage |
