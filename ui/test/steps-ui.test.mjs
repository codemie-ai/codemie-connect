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
