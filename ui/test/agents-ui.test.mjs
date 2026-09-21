import { test } from 'node:test';
import assert from 'node:assert/strict';

// Minimal DOM stub, the shape the other view tests use.
function makeEl(tag) {
  const el = {
    _tag: tag,
    _children: [],
    className: '',
    textContent: '',
    dataset: {},
    appendChild(c) {
      c._parent = el;
      el._children.push(c);
      return c;
    },
    append(...cs) {
      cs.forEach((c) => el.appendChild(c));
    },
    querySelector(sel) {
      return find(el, sel);
    },
    _text() {
      return el._children.length ? el._children.map((c) => c._text()).join(' ') : el.textContent;
    },
    _all(pred) {
      const out = [];
      (function walk(n) {
        if (pred(n)) out.push(n);
        n._children.forEach(walk);
      })(el);
      return out;
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
function matches(n, sel) {
  const m = sel.match(/^\.([\w-]+)(?:\[data-id="([^"]+)"\])?$/);
  if (!m) return false;
  return n.className.split(' ').includes(m[1]) && (!m[2] || n.dataset.id === m[2]);
}
function find(root, sel) {
  for (const c of root._children) {
    if (matches(c, sel)) return c;
    const f = find(c, sel);
    if (f) return f;
  }
  return null;
}
globalThis.document = { createElement: makeEl };

// Recording stand-in for the screen's own steps-ui instance: builds a .step-row
// per agent so the action slot has a row to hang on, and records every call.
function fakeStepsUi() {
  const calls = [];
  return {
    calls,
    renderSteps(container, list) {
      calls.push(['renderSteps', list.map((s) => s.id)]);
      for (const s of list) {
        const row = makeEl('div');
        row.className = 'step-row';
        row.dataset.id = s.id;
        container.appendChild(row);
      }
    },
    setStatus(id, status) {
      calls.push(['setStatus', id, status]);
    },
    setSubtitle(id, text) {
      calls.push(['setSubtitle', id, text]);
    },
  };
}

const { renderAgents, showLoading, showRunError, summarise } = await import('../agents-ui.js');

const agents = [
  { name: 'CodeMie Code', command: 'codemie-code', installed: true, version: '0.0.47', description: 'CodeMie Code - AI coding assistant' },
  { name: 'Claude Code', command: 'claude', installed: true, version: '2.1.269', description: 'Claude Code - official Anthropic CLI tool' },
  { name: 'Gemini CLI', command: 'gemini', installed: false, version: null, description: 'Google Gemini CLI - AI coding assistant' },
];

const buttons = (container) => container._all((n) => n._tag === 'button').map((b) => b.textContent);

test('every agent the parser returned is a row, in the order the CLI printed them', () => {
  const container = makeEl('div');
  const stepsUi = fakeStepsUi();
  renderAgents(container, { agents }, { stepsUi });
  assert.deepEqual(stepsUi.calls[0], ['renderSteps', ['codemie-code', 'claude', 'gemini']]);
});

test('installed is COMPLETE and not installed is PENDING', () => {
  const stepsUi = fakeStepsUi();
  renderAgents(makeEl('div'), { agents }, { stepsUi });
  const status = Object.fromEntries(stepsUi.calls.filter((c) => c[0] === 'setStatus').map((c) => [c[1], c[2]]));
  assert.deepEqual(status, { 'codemie-code': 'COMPLETE', claude: 'COMPLETE', gemini: 'PENDING' });
});

test("an installed agent's row carries the version codemie list printed; one that is not installed carries none", () => {
  const stepsUi = fakeStepsUi();
  renderAgents(makeEl('div'), { agents }, { stepsUi });
  const subtitle = Object.fromEntries(stepsUi.calls.filter((c) => c[0] === 'setSubtitle').map((c) => [c[1], c[2]]));
  assert.equal(subtitle.claude, 'Claude Code - official Anthropic CLI tool · 2.1.269');
  assert.equal(subtitle.gemini, 'Google Gemini CLI - AI coding assistant');
});

test('the count is what the list held, never a hardcoded number', () => {
  const container = makeEl('div');
  renderAgents(container, { agents }, { stepsUi: fakeStepsUi() });
  assert.match(container._text(), /2 of 3 installed/);
  assert.deepEqual(summarise(agents), { installed: 2, total: 3, updateAvailable: 0 });
  assert.deepEqual(summarise([]), { installed: 0, total: 0, updateAvailable: 0 });
});

test('no action button is drawn while its handler is absent', () => {
  const container = makeEl('div');
  renderAgents(container, { agents }, { stepsUi: fakeStepsUi() });
  assert.deepEqual(buttons(container), []);
});

test('an installed agent offers Update and Remove, one that is not offers Install', () => {
  const container = makeEl('div');
  const seen = [];
  renderAgents(
    container,
    { agents },
    { stepsUi: fakeStepsUi(), onInstall: (a) => seen.push(['install', a.command]), onUpdate: (a) => seen.push(['update', a.command]), onRemove: (a) => seen.push(['remove', a.command]) },
  );
  assert.deepEqual(buttons(container), ['Update', 'Remove', 'Update', 'Remove', 'Install']);
  const slot = container.querySelector('.agent-actions[data-id="gemini"]');
  slot._children[0].onclick({ stopPropagation() {} });
  assert.deepEqual(seen, [['install', 'gemini']]);
});

test('the screen says it is reading before the list arrives', () => {
  const container = makeEl('div');
  showLoading(container);
  assert.match(container._text(), /Agents Reading the agent list/);
});

test('a failed read states what happened and offers the read again, instead of an empty list', () => {
  const container = makeEl('div');
  let retried = 0;
  showRunError(container, 'spawn codemie ENOENT', () => {
    retried += 1;
  });
  assert.match(container._text(), /CodeMie could not read the agent list/);
  assert.match(container._text(), /spawn codemie ENOENT/);
  assert.doesNotMatch(container._text(), /0 of 0 installed/);
  container._all((n) => n._tag === 'button')[0].onclick();
  assert.equal(retried, 1);
});

test('the screen says agents are run from a terminal, since it cannot launch one', () => {
  const container = makeEl('div');
  renderAgents(container, { agents }, { stepsUi: fakeStepsUi() });
  assert.match(container._text(), /Run an agent from a terminal/);
  assert.doesNotMatch(container._text(), /\bLaunch\b|\bRun agent\b/);
});

test('an agent with updateAvailable is WARNING even though it is installed', () => {
  const withUpdate = agents.map((a) => (a.command === 'claude' ? { ...a, updateAvailable: true } : a));
  const stepsUi = fakeStepsUi();
  renderAgents(makeEl('div'), { agents: withUpdate }, { stepsUi });
  const status = Object.fromEntries(stepsUi.calls.filter((c) => c[0] === 'setStatus').map((c) => [c[1], c[2]]));
  assert.equal(status.claude, 'WARNING');
});

test('summarise reports how many agents have an update available', () => {
  const withUpdate = agents.map((a) => (a.command === 'claude' ? { ...a, updateAvailable: true } : a));
  assert.equal(summarise(withUpdate).updateAvailable, 1);
  assert.equal(summarise(agents).updateAvailable, 0);
});

test('the header names the update count only when it is greater than zero', () => {
  const withUpdate = agents.map((a) => (a.command === 'claude' ? { ...a, updateAvailable: true } : a));
  const withUpdates = makeEl('div');
  renderAgents(withUpdates, { agents: withUpdate }, { stepsUi: fakeStepsUi() });
  assert.match(withUpdates._text(), /2 of 3 installed · 1 update available/);

  const withoutUpdates = makeEl('div');
  renderAgents(withoutUpdates, { agents }, { stepsUi: fakeStepsUi() });
  assert.doesNotMatch(withoutUpdates._text(), /update available/);
});
