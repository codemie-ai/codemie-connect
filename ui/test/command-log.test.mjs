import { test } from 'node:test';
import assert from 'node:assert/strict';

// Minimal DOM stub: enough for createElement/append/querySelector/remove.
function makeEl(tag) {
  const el = {
    _tag: tag,
    _children: [],
    className: '',
    textContent: '',
    appendChild(c) {
      c._parent = el;
      el._children.push(c);
      return c;
    },
    append(...cs) {
      cs.forEach((c) => el.appendChild(c));
    },
    remove() {
      const p = el._parent;
      if (p) p._children = p._children.filter((c) => c !== el);
    },
    querySelector(sel) {
      const cls = sel.replace(/^\./, '');
      return el._children.find((c) => c.className.split(' ').includes(cls)) || null;
    },
    _text() {
      return el._children.length ? el._children.map((c) => c._text()).join(' ') : el.textContent;
    },
  };
  Object.defineProperty(el, 'innerHTML', {
    get: () => '',
    set() {
      el._children = [];
    },
  });
  return el;
}
globalThis.document = { createElement: makeEl };
const { createCommandLog } = await import('../command-log.js');

test('before the first command the footer says so', () => {
  const body = makeEl('div');
  createCommandLog(body);
  assert.equal(body._text(), 'Nothing run yet');
});

test('a command is one line, running until its exit code arrives', () => {
  const body = makeEl('div');
  const log = createCommandLog(body, { now: () => new Date(2026, 8, 21, 14, 22) });
  const finish = log.start('codemie doctor');
  assert.equal(body._children.length, 1);
  assert.ok(!body._text().includes('Nothing run yet'));
  assert.match(body._text(), /\$ codemie doctor running/);
  finish(0);
  assert.match(body._text(), /\$ codemie doctor ok/);
  assert.equal(body._children[0].className, 'command-log-line ok');
});

test('a non-zero exit is failed, with the code', () => {
  const body = makeEl('div');
  const log = createCommandLog(body);
  log.start('codemie list')(1);
  assert.match(body._text(), /failed \(1\)/);
  assert.equal(body._children[0].className, 'command-log-line failed');
});

test('the footer keeps the newest fifty lines', () => {
  const body = makeEl('div');
  const log = createCommandLog(body);
  for (let i = 1; i <= 52; i += 1) log.start(`cmd ${i}`)(0);
  assert.equal(body._children.length, 50);
  assert.match(body._children[0]._text(), /\$ cmd 3 /);
  assert.match(body._children[49]._text(), /\$ cmd 52 /);
});
