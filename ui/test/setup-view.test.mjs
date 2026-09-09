// ui/test/setup-view.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── Minimal DOM stub ─────────────────────────────────────────────────────────
// Adapted from ui/test/steps-ui.test.mjs's hand-rolled stub (makeEl/
// findByClass), extended with a `children` getter (setup-view.js locates a
// row by walking container.children and matching dataset.id -- the real
// DOM's `.children` name, so setup-view.js's lookup works unmodified against
// a real browser DOM too) and a readable `onclick` (real DOM element.onclick
// is both a setter and a getter; this stub only had the setter, which is
// enough for steps-ui.js's own tests since none of them ever click anything,
// but this file's tests need to invoke the handler setup-view.js installs).
function makeEl(tag) {
  const el = {
    _tag: tag,
    _children: [],
    _listeners: {},
    className: '',
    dataset: {},
    textContent: '',
    style: {},
    type: '',
    value: '',
    checked: false,
    name: '',
    get children() { return el._children; },
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
    get onclick() { return el._listeners.click; },
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
const { createSetupView } = await import('../setup-view.js');

function findRowById(container, id) {
  for (const child of container.children) {
    if (child.dataset.id === id) return child;
  }
  return null;
}

// ── Tests ────────────────────────────────────────────────────────────────────

test('start() inserts a collapsed/COMPLETE storage row before startSetup runs', async () => {
  const container = makeEl('div');
  let sawStorageRowBeforeStart = false;

  const fakeStartSetup = async ({ onPrompt: _onPrompt, onLog: _onLog } = {}) => {
    const row = findRowById(container, 'storage');
    sawStorageRowBeforeStart = !!row && row.querySelector('.step-icon').textContent === '✓';
    return { profileName: 'default' };
  };

  const view = createSetupView(container, { startSetup: fakeStartSetup });
  await view.start();

  assert.ok(sawStorageRowBeforeStart, 'storage row exists and is COMPLETE before startSetup is invoked');
  const storageRow = findRowById(container, 'storage');
  assert.ok(storageRow, 'storage row is present');
  assert.equal(storageRow.querySelector('.step-sub').textContent, 'This computer');
});

test('gate and confirm-kind activate prompts never render a row', async () => {
  const container = makeEl('div');
  const fakeStartSetup = async ({ onPrompt }) => {
    await onPrompt({ kind: 'list', id: 'gate', message: 'Add a new profile?', options: ['create', 'update'] });
    await onPrompt({ kind: 'confirm', id: 'activate', message: 'Activate this profile now?' });
    return { profileName: 'default' };
  };

  const view = createSetupView(container, { startSetup: fakeStartSetup });
  await view.start();

  assert.equal(findRowById(container, 'gate-1'), null, 'no gate row ever appears');
  assert.equal(findRowById(container, 'activate-1'), null, 'no activate row ever appears');
});

test('list prompt: renders radio options, resolves with selected index, marks row COMPLETE', async () => {
  const container = makeEl('div');
  let resolvedAnswer;
  const fakeStartSetup = async ({ onPrompt }) => {
    resolvedAnswer = await onPrompt({
      kind: 'list',
      id: 'provider',
      message: 'Pick a provider',
      options: ['OpenAI', 'Bedrock', 'Anthropic'],
    });
    return { profileName: 'default' };
  };

  const view = createSetupView(container, { startSetup: fakeStartSetup });
  const startPromise = view.start();

  // Give onPrompt's synchronous body a tick to run and insert the row.
  await Promise.resolve();
  const row = findRowById(container, 'provider-1');
  assert.ok(row, 'provider-1 row was inserted');
  assert.ok(row.classList._set.has('active'), 'row is ACTIVE while awaiting an answer');

  const control = row.querySelector('.prompt-control');
  assert.ok(control, 'a control was rendered');
  const radios = control._children.filter((c) => c.type === 'radio');
  assert.equal(radios.length, 3, 'one radio per option');

  radios[1].checked = true; // select "Bedrock" (index 1)
  const submitBtn = control._children.find((c) => c.className === 'prompt-submit');
  assert.ok(submitBtn, 'submit control present');
  submitBtn.onclick();

  await startPromise;

  assert.equal(resolvedAnswer, 1, 'resolved with the selected index');
  assert.ok(!row.classList._set.has('active'), 'row is no longer ACTIVE');
  assert.equal(row.querySelector('.step-icon').textContent, '✓', 'row is COMPLETE');
  assert.equal(row.querySelector('.step-sub').textContent, 'Bedrock', 'subtitle is the human-readable choice');
});

test('input prompt: renders a text field, resolves with the typed string, marks row COMPLETE', async () => {
  const container = makeEl('div');
  let resolvedAnswer;
  const fakeStartSetup = async ({ onPrompt }) => {
    resolvedAnswer = await onPrompt({ kind: 'input', id: 'profileName', message: 'Enter a name for this profile:' });
    return { profileName: resolvedAnswer };
  };

  const view = createSetupView(container, { startSetup: fakeStartSetup });
  const startPromise = view.start();

  await Promise.resolve();
  const row = findRowById(container, 'profileName-1');
  assert.ok(row, 'profileName-1 row was inserted');

  const control = row.querySelector('.prompt-control');
  const input = control._children.find((c) => c.type === 'text');
  assert.ok(input, 'text input present');
  input.value = 'my-workspace';
  const submitBtn = control._children.find((c) => c.className === 'prompt-submit');
  submitBtn.onclick();

  await startPromise;

  assert.equal(resolvedAnswer, 'my-workspace', 'resolved with the typed string');
  assert.equal(row.querySelector('.step-icon').textContent, '✓', 'row is COMPLETE');
  assert.equal(row.querySelector('.step-sub').textContent, 'my-workspace', 'subtitle echoes the typed value');
});

test('confirm prompt: Yes is pre-selected, resolves with a boolean, marks row COMPLETE', async () => {
  const container = makeEl('div');
  let resolvedAnswer;
  const fakeStartSetup = async ({ onPrompt }) => {
    resolvedAnswer = await onPrompt({ kind: 'confirm', id: 'installClaude', message: 'Install Claude Code?' });
    return { profileName: 'default' };
  };

  const view = createSetupView(container, { startSetup: fakeStartSetup });
  const startPromise = view.start();

  await Promise.resolve();
  const row = findRowById(container, 'installClaude-1');
  assert.ok(row, 'installClaude-1 row was inserted');

  const control = row.querySelector('.prompt-control');
  const radios = control._children.filter((c) => c.type === 'radio');
  assert.equal(radios.length, 2, 'Yes/No radios present');
  const yesRadio = radios.find((r) => r.value === 'yes');
  assert.ok(yesRadio.checked, 'Yes is pre-selected');

  // Accept the default (Yes) without touching anything.
  const submitBtn = control._children.find((c) => c.className === 'prompt-submit');
  submitBtn.onclick();

  await startPromise;

  assert.equal(resolvedAnswer, true, 'resolved with boolean true for the pre-selected Yes');
  assert.equal(row.querySelector('.step-icon').textContent, '✓', 'row is COMPLETE');
  assert.equal(row.querySelector('.step-sub').textContent, 'Yes', 'subtitle is the human-readable choice');
});

test('confirm prompt: choosing No resolves with false', async () => {
  const container = makeEl('div');
  let resolvedAnswer;
  const fakeStartSetup = async ({ onPrompt }) => {
    resolvedAnswer = await onPrompt({ kind: 'confirm', id: 'installClaude', message: 'Install Claude Code?' });
    return { profileName: 'default' };
  };

  const view = createSetupView(container, { startSetup: fakeStartSetup });
  const startPromise = view.start();

  await Promise.resolve();
  const row = findRowById(container, 'installClaude-1');
  const control = row.querySelector('.prompt-control');
  const radios = control._children.filter((c) => c.type === 'radio');
  const yesRadio = radios.find((r) => r.value === 'yes');
  const noRadio = radios.find((r) => r.value === 'no');
  yesRadio.checked = false;
  noRadio.checked = true;

  const submitBtn = control._children.find((c) => c.className === 'prompt-submit');
  submitBtn.onclick();

  await startPromise;

  assert.equal(resolvedAnswer, false, 'resolved with boolean false when No is chosen');
  assert.equal(row.querySelector('.step-sub').textContent, 'No');
});
