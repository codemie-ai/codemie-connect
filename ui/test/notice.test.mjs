// ui/test/notice.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Minimal DOM stub, following ui/test/setup-view.test.mjs's makeEl/findByClass
// convention -- just enough surface for notice.js: classList add/remove/
// contains, textContent, appendChild/replaceChildren, a settable+readable
// onclick, and addEventListener for the close button's wiring.
function makeEl(id) {
  const el = {
    id,
    _children: [],
    textContent: '',
    _listeners: {},
    classList: {
      _set: new Set(),
      add(c) { el.classList._set.add(c); },
      remove(c) { el.classList._set.delete(c); },
      contains(c) { return el.classList._set.has(c); },
    },
    appendChild(child) { el._children.push(child); return child; },
    replaceChildren() { el._children = []; },
    set onclick(fn) { el._listeners.click = fn; },
    get onclick() { return el._listeners.click; },
    addEventListener(evt, fn) { el._listeners[evt] = fn; },
  };
  return el;
}

const IDS = ['notice-overlay', 'notice-title', 'notice-message', 'notice-primary', 'notice-secondary', 'notice-close'];
const els = {};
for (const id of IDS) els[id] = makeEl(id);
// notice.js reads these at module scope -- stub document.getElementById
// BEFORE dynamically importing the module, or the real DOM lookup would
// throw immediately on import. This also confirms notice.js's only DOM
// dependency is getElementById on these six ids: nothing else is stubbed
// here, and importing it never touches window.__TAURI__ or runner-bridge.js
// (no such stub exists in this file at all).
globalThis.document = { getElementById: (id) => els[id] };

const { showNotice, hideNotice } = await import('../notice.js');

test('(a) single-action call shows the primary button; secondary stays hidden', () => {
  showNotice({ title: 'Title', message: 'Body text', primaryLabel: 'OK', primaryAction: () => {} });
  assert.equal(els['notice-title'].textContent, 'Title');
  assert.equal(els['notice-message'].textContent, 'Body text');
  assert.equal(els['notice-primary'].textContent, 'OK');
  assert.equal(els['notice-primary'].classList.contains('hidden'), false);
  assert.equal(els['notice-secondary'].classList.contains('hidden'), true);
  assert.equal(els['notice-overlay'].classList.contains('hidden'), false);
});

test('(b) a secondaryLabel/secondaryAction call shows both buttons; clicking secondary hides then acts', () => {
  const calls = [];
  showNotice({
    title: 'Title',
    message: 'Body',
    primaryLabel: 'Try again',
    primaryAction: () => calls.push('primary'),
    secondaryLabel: 'Show details',
    secondaryAction: () => calls.push('secondary'),
  });
  assert.equal(els['notice-primary'].classList.contains('hidden'), false);
  assert.equal(els['notice-secondary'].classList.contains('hidden'), false);
  assert.equal(els['notice-secondary'].textContent, 'Show details');

  els['notice-secondary'].onclick();
  assert.equal(els['notice-overlay'].classList.contains('hidden'), true, 'hideNotice() ran first');
  assert.deepEqual(calls, ['secondary'], 'only the secondary action ran, and only once');
});

test('(c) a string message sets textContent', () => {
  showNotice({ title: 't', message: 'plain string body' });
  assert.equal(els['notice-message'].textContent, 'plain string body');
});

test('(d) a DOM-Node message is appended as a child; textContent is left empty', () => {
  const node = { tag: 'pre', textContent: 'raw output' };
  showNotice({ title: 't', message: node });
  assert.equal(els['notice-message'].textContent, '', 'no textContent set for a Node body');
  assert.ok(els['notice-message']._children.includes(node), 'the node was appended as a child');
});

test('(e) hideNotice() re-adds the hidden class', () => {
  showNotice({ title: 't', message: 'm' });
  assert.equal(els['notice-overlay'].classList.contains('hidden'), false);
  hideNotice();
  assert.equal(els['notice-overlay'].classList.contains('hidden'), true);
});
