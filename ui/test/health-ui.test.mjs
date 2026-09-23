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
    remove() {
      const p = el._parent;
      if (p) p._children = p._children.filter((c) => c !== el);
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
      contains(cls) {
        return el.classList._set.has(cls);
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
const { renderHealth, showLoading, showLogError, showRunError } = await import('../health-ui.js');

// ── Tests ────────────────────────────────────────────────────────────────────

const passRow = { group: 'codemie', label: 'Everything CodeMie needs to run is included', status: 'pass' };

test('renders the summary, and a heading only for a group that has rows', () => {
  const container = makeEl('div');
  renderHealth(container, { rows: [passRow], summary: { passing: 1, total: 1 } }, {});
  assert.ok(container._innerText().includes('1 of 1 fine'));
  assert.ok(container._innerText().includes('CodeMie itself'));
  assert.ok(!container._innerText().includes('Your CodeMie account'));
  assert.ok(!container._innerText().includes('Your tools'));
});

test('the summary says when the checks ran, from the time it is given', () => {
  const container = makeEl('div');
  const checkedAt = new Date(2026, 8, 21, 14, 5);
  renderHealth(container, { rows: [passRow], summary: { passing: 1, total: 1 }, checkedAt }, {});
  const summary = container.querySelector('.health-summary').textContent;
  const clock = checkedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  assert.equal(summary, `1 of 1 fine · checked at ${clock}`);
});

test('a row shows its detail beside the label, and a passing row gets no panel', () => {
  const container = makeEl('div');
  renderHealth(
    container,
    { rows: [{ ...passRow, detail: 'Node.js v22.23.2 · uv 0.12.0' }], summary: { passing: 1, total: 1 } },
    {},
  );
  assert.equal(container.querySelector('.health-detail').textContent, 'Node.js v22.23.2 · uv 0.12.0');
  assert.equal(container.querySelector('.failure-panel'), null);
});

test('a warning draws its remedy in the amber failure panel, and its action navigates', () => {
  const container = makeEl('div');
  let navigatedTo = null;
  renderHealth(
    container,
    {
      rows: [
        {
          group: 'tools',
          label: 'OpenCode CLI 1.18.31',
          detail: 'CodeMie recommends vlatest',
          status: 'warn',
          remedyText: 'Open the Agents screen to update or reinstall it.',
          action: { kind: 'navigate', view: 'agents', label: 'Go to Agents' },
        },
      ],
      summary: { passing: 0, total: 1 },
    },
    { onNavigate: (v) => (navigatedTo = v) },
  );
  assert.equal(container.querySelector('.failure-panel').className, 'failure-panel warning');
  assert.ok(container._innerText().includes('What to do'));
  assert.ok(container._innerText().includes('Open the Agents screen to update or reinstall it.'));
  container._findButton('Go to Agents')._click();
  assert.equal(navigatedTo, 'agents');
});

test('a failure draws the red panel, and "Sign in again" starts sign-in rather than a recheck', () => {
  const container = makeEl('div');
  const calls = [];
  renderHealth(
    container,
    {
      rows: [
        {
          group: 'account',
          label: 'SSO credentials not found',
          status: 'fail',
          remedyText: 'Sign in again to restore your CodeMie session.',
          remedyDetail: 'Run: codemie profile login',
          action: { kind: 'signin', label: 'Sign in again' },
        },
      ],
      summary: { passing: 0, total: 1 },
    },
    { onSignIn: () => calls.push('signin'), onRecheck: () => calls.push('recheck') },
  );
  assert.equal(container.querySelector('.failure-panel').className, 'failure-panel');
  assert.equal(container.querySelector('.failure-detail').textContent, 'Run: codemie profile login');
  container._findButton('Sign in again')._click();
  assert.deepEqual(calls, ['signin']);
});

test('a "Check again" remedy and "Check everything again" both call onRecheck', () => {
  const container = makeEl('div');
  let rechecks = 0;
  renderHealth(
    container,
    {
      rows: [
        {
          group: 'account',
          label: 'No active profile',
          status: 'warn',
          remedyText: 'Run: codemie setup',
          action: { kind: 'recheck', label: 'Check again' },
        },
      ],
      summary: { passing: 0, total: 1 },
    },
    { onRecheck: () => (rechecks += 1) },
  );
  container._findButton('Check again')._click();
  container._findButton('Check everything again')._click();
  assert.equal(rechecks, 2);
});

test('two problem rows each keep their own panel', () => {
  const container = makeEl('div');
  const problem = (label) => ({
    group: 'tools',
    label,
    status: 'warn',
    remedyText: `fix ${label}`,
    action: { kind: 'navigate', view: 'agents', label: 'Go to Agents' },
  });
  renderHealth(container, { rows: [problem('A 1.0'), problem('B 2.0')], summary: { passing: 0, total: 2 } }, {});
  assert.ok(container._innerText().includes('fix A 1.0'));
  assert.ok(container._innerText().includes('fix B 2.0'));
});

// CR-003: showLoading() wipes the container (including the slot renderHealth
// built for the log error), which is exactly what "Check everything again"
// does while an earlier open-log rejection is still pending. Once the wipe has
// happened, showLogError must still surface the message rather than silently
// no-op on a missing element.
test('CR-003: showLogError still reports after the container was wiped', () => {
  const container = makeEl('div');
  renderHealth(container, { rows: [], summary: { passing: 0, total: 0 } }, {});
  showLoading(container); // simulates a recheck racing ahead of a pending open_log rejection
  showLogError(container, 'log file not found or unreadable: /tmp/x.log');
  assert.ok(container._innerText().includes('CodeMie cannot open your log'));
  assert.ok(container._innerText().includes('log file not found or unreadable: /tmp/x.log'));
});

test('a second log error replaces the first instead of stacking', () => {
  const container = makeEl('div');
  renderHealth(container, { rows: [], summary: { passing: 0, total: 0 } }, {});
  showLogError(container, 'first');
  showLogError(container, 'second');
  assert.ok(!container._innerText().includes('first'));
  assert.ok(container._innerText().includes('second'));
});

test('while the checks run the header stays and says so', () => {
  const container = makeEl('div');
  showLoading(container);
  assert.equal(container.querySelector('.health-title').textContent, 'Health');
  assert.equal(container.querySelector('.health-summary').textContent, 'Checking…');
});

test('while the checks run a spinner fills the empty screen', () => {
  const container = makeEl('div');
  showLoading(container);
  assert.ok(container.querySelector('.screen-spinner'));
});

test('showRunError says why and offers the retry', () => {
  const container = makeEl('div');
  let retried = false;
  showRunError(container, 'doctor not found', () => (retried = true));
  assert.ok(container._innerText().includes('CodeMie could not check its health'));
  assert.ok(container._innerText().includes('doctor not found'));
  container._findButton('Check everything again')._click();
  assert.ok(retried);
});
