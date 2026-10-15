import { test } from 'node:test';
import assert from 'node:assert/strict';

function makeEl(tag) {
  const el = {
    _tag: tag, _children: [], className: '', textContent: '', dataset: {}, value: '', _attrs: {},
    setAttribute(k, v) { el._attrs[k] = v; },
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

test('failure and notice are shown; the list draws no Add button', () => {
  const root = makeEl('div');
  renderProfileList(root, state([P('a', true)], { failure: { message: 'boom' }, notice: 'Active profile now: a' }));
  assert.equal(buttons(root, 'Add a profile').length, 0);
  assert.ok(root._text().includes('boom'));
  assert.ok(root._text().includes('Active profile now: a'));
});

test('an open rename keeps its typed name, and an open delete stays open, when the list is drawn again', () => {
  const root = makeEl('div');
  const s1 = state([P('a', true), P('b')]);
  renderProfileList(root, s1);
  buttons(root, 'Rename')[0].onclick();
  const input = root.querySelector('.profile-rename-input');
  input.value = 'typed';
  input.oninput();
  renderProfileList(root, state([P('a', true), P('b')]));
  assert.equal(root.querySelector('.profile-rename-input').value, 'typed');
  buttons(root, 'Cancel')[0].onclick();
  buttons(root, 'Delete')[1].onclick();
  renderProfileList(root, state([P('a', true), P('b')]));
  assert.equal(buttons(root, 'Confirm').length, 1);
});

test('an empty list draws no empty box', () => {
  const root = makeEl('div');
  renderProfileList(root, state([]));
  assert.equal(root.querySelector('.profile-list'), null);
});

test('the active profile is listed first, the others keep their order', () => {
  const root = makeEl('div');
  renderProfileList(root, state([P('a'), P('b'), P('c', true)]));
  const names = root._all((n) => n.className === 'profile-name').map((n) => n.textContent);
  assert.deepEqual(names, ['c', 'a', 'b']);
});

test('the rename field never auto-capitalises or corrects the name', () => {
  const root = makeEl('div');
  renderProfileList(root, state([P('work', true)]));
  buttons(root, 'Rename')[0].onclick();
  const input = root.querySelector('.profile-rename-input');
  assert.equal(input._attrs.autocapitalize, 'off');
  assert.equal(input._attrs.autocorrect, 'off');
  assert.equal(input.spellcheck, false);
});

test('the row an action is running on shows the new name and a spinner, with no buttons', () => {
  const root = makeEl('div');
  renderProfileList(root, state([P('a', true), P('b')], { busy: true, pending: { name: 'b', label: 'work', text: 'Renaming…' } }));
  const names = root._all((n) => n.className === 'profile-name').map((n) => n.textContent);
  assert.deepEqual(names, ['a', 'work']);
  assert.equal(root._all((n) => n.className === 'inline-spinner').length, 1);
  assert.ok(root._text().includes('Renaming…'));
  assert.equal(buttons(root, 'Switch').length, 0, 'the pending row has no buttons');
  assert.equal(buttons(root, 'Rename').length, 1, 'the other row keeps its (disabled) buttons');
  assert.equal(buttons(root, 'Rename')[0].disabled, true);
});
