// ui/test/health-ui.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── Minimal DOM stub ─────────────────────────────────────────────────────────
// Adapted from ui/test/steps-ui.test.mjs's makeEl/classList/innerHTML shape,
// trimmed to what renderHealth/showLoading/showLogError actually touch, plus
// two health-specific helpers: _innerText() (recursive text dump, for the
// "does the summary/heading text appear anywhere" assertions) and
// _findButton(label) (recursive lookup by tag + textContent, since rows are
// built with plain <button> elements rather than classed divs).

function makeEl(tag) {
  const el = {
    _tag: tag,
    _children: [],
    className: '',
    textContent: '',
    set onclick(fn) {
      el._onclick = fn;
    },
    appendChild(child) {
      child._parent = el;
      el._children.push(child);
      return child;
    },
    append(...children) {
      children.forEach((c) => el.appendChild(c));
    },
    querySelector(sel) {
      const cls = sel.replace(/^\./, '');
      return findByClass(el, cls);
    },
    classList: {
      _set: new Set(),
      add(cls) {
        el.classList._set.add(cls);
      },
      remove(cls) {
        el.classList._set.delete(cls);
      },
      toggle(cls, force) {
        if (force === true) el.classList._set.add(cls);
        else if (force === false) el.classList._set.delete(cls);
        else if (el.classList._set.has(cls)) el.classList._set.delete(cls);
        else el.classList._set.add(cls);
      },
    },
    _click() {
      if (el._onclick) el._onclick();
    },
    _innerText() {
      const own = el._children.length ? '' : el.textContent;
      return [own, ...el._children.map((c) => c._innerText())].join(' ');
    },
    _findButton(label) {
      return findByTagAndText(el, 'button', label);
    },
  };
  Object.defineProperty(el, 'innerHTML', {
    get() {
      return '';
    },
    set() {
      el._children = [];
    },
  });
  return el;
}

function findByClass(root, cls) {
  for (const c of root._children) {
    if ((c.className ?? '').split(' ').includes(cls)) return c;
    const found = findByClass(c, cls);
    if (found) return found;
  }
  return null;
}

function findByTagAndText(root, tag, text) {
  for (const c of root._children) {
    if (c._tag === tag && c.textContent === text) return c;
    const found = findByTagAndText(c, tag, text);
    if (found) return found;
  }
  return null;
}

globalThis.document = { createElement: (tag) => makeEl(tag) };

// ── Import module under test (after stub is in place) ───────────────────────
const { renderHealth } = await import('../health-ui.js');

// ── Tests ────────────────────────────────────────────────────────────────────

test('renders group headings only for groups with rows, and the summary line', () => {
  const container = makeEl('div');
  renderHealth(
    container,
    {
      rows: [{ group: 'codemie', label: 'Everything CodeMie needs to run is included', status: 'pass' }],
      summary: { passing: 1, total: 1 },
    },
    {}
  );
  assert.ok(container._innerText().includes('1 of 1 fine'));
  assert.ok(container._innerText().includes('CodeMie itself'));
  assert.ok(!container._innerText().includes('Your account'));
});

test('a row with a navigate action renders its label as a clickable button', () => {
  const container = makeEl('div');
  let navigatedTo = null;
  renderHealth(
    container,
    {
      rows: [
        {
          group: 'tools',
          label: 'Agents',
          status: 'fail',
          action: { kind: 'navigate', view: 'agents', label: 'Go to Agents' },
        },
      ],
      summary: { passing: 0, total: 1 },
    },
    {
      onNavigate: (v) => {
        navigatedTo = v;
      },
    }
  );
  container._findButton('Go to Agents')._click();
  assert.equal(navigatedTo, 'agents');
});

test('Check everything again calls onRecheck', () => {
  const container = makeEl('div');
  let recalled = false;
  renderHealth(container, { rows: [], summary: { passing: 0, total: 0 } }, {
    onRecheck: () => {
      recalled = true;
    },
  });
  container._findButton('Check everything again')._click();
  assert.ok(recalled);
});
