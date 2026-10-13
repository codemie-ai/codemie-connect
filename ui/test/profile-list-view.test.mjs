import { test } from 'node:test';
import assert from 'node:assert/strict';

function makeEl(tag) {
  const el = {
    _tag: tag, _children: [], className: '', textContent: '', dataset: {}, value: '',
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      toggle(c, on) { if (on) this._set.add(c); else this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    remove() { if (el._parent) el._parent._children = el._parent._children.filter((c) => c !== el); },
    appendChild(c) { c._parent = el; el._children.push(c); return c; },
    append(...cs) { cs.forEach((c) => el.appendChild(c)); },
    querySelector(sel) { return el._all((n) => n !== el && matches(n, sel))[0] ?? null; },
    _text() { return el._children.length ? el._children.map((c) => c._text()).join(' ') : el.textContent; },
    _all(pred) {
      const out = [];
      (function walk(n) { if (pred(n)) out.push(n); n._children.forEach(walk); })(el);
      return out;
    },
  };
  Object.defineProperty(el, 'innerHTML', { get: () => '', set() { el._children = []; } });
  return el;
}
function matches(n, sel) {
  const m = sel.match(/^\.([\w-]+)$/);
  return !!m && n.className.split(' ').includes(m[1]);
}
globalThis.document = { createElement: makeEl };

const { renderProfileList } = await import('../profile-list-view.js');

const P = (name, active = false) => ({ name, provider: 'ai-run-sso', model: 'sonnet', active });
const state = (profiles, extra = {}) => ({ profiles, busy: false, failure: null, notice: null, ...extra });
const buttons = (root, label) => root._all((n) => n._tag === 'button' && n.textContent === label);

test('each row shows name, provider and model; exactly one Active badge; no Switch on the active row', () => {
  const root = makeEl('div');
  renderProfileList(root, state([P('a', true), P('b')]), {});
  assert.ok(root._text().includes('ai-run-sso · sonnet'));
  assert.equal(root._all((n) => n.className === 'profile-badge').length, 1);
  assert.equal(buttons(root, 'Switch').length, 1);
});

test('Switch calls the handler with that profile name', () => {
  const root = makeEl('div');
  const got = [];
  renderProfileList(root, state([P('a', true), P('b')]), { onSwitch: (n) => got.push(n) });
  buttons(root, 'Switch')[0].onclick();
  assert.deepEqual(got, ['b']);
});

test('Delete asks first and does not call the handler until confirmed', () => {
  const root = makeEl('div');
  const got = [];
  renderProfileList(root, state([P('a', true), P('b')]), { onDelete: (n) => got.push(n) });
  buttons(root, 'Delete')[1].onclick();
  assert.deepEqual(got, []);
  assert.ok(root._text().includes('Delete b?'));
  buttons(root, 'Confirm')[0].onclick();
  assert.deepEqual(got, ['b']);
});

test('deleting the active profile says so', () => {
  const root = makeEl('div');
  renderProfileList(root, state([P('a', true), P('b')]), {});
  buttons(root, 'Delete')[0].onclick();
  assert.ok(root._text().includes('the active profile'));
});

test('Rename shows an input and Save passes old and new names', () => {
  const root = makeEl('div');
  const got = [];
  renderProfileList(root, state([P('a', true)]), { onRename: (o, n) => got.push([o, n]) });
  buttons(root, 'Rename')[0].onclick();
  const input = root._all((n) => n._tag === 'input')[0];
  input.value = 'z';
  buttons(root, 'Save')[0].onclick();
  assert.deepEqual(got, [['a', 'z']]);
});

test('Add a profile calls onAdd; failure and notice are shown', () => {
  const root = makeEl('div');
  let added = 0;
  renderProfileList(root, state([P('a', true)], { failure: { message: 'boom' }, notice: 'Active profile now: a' }), { onAdd: () => { added++; } });
  buttons(root, 'Add a profile')[0].onclick();
  assert.equal(added, 1);
  assert.ok(root._text().includes('boom'));
  assert.ok(root._text().includes('Active profile now: a'));
});
