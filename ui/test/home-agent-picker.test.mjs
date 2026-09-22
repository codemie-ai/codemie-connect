import { test } from 'node:test';
import assert from 'node:assert/strict';

// The same minimal DOM stub the other view tests use, plus classList — the
// option cards toggle a 'selected' class as the selection moves.
function makeEl(tag) {
  const el = {
    _tag: tag,
    _children: [],
    className: '',
    textContent: '',
    type: '',
    name: '',
    value: '',
    checked: false,
    title: '',
    dataset: {},
    classList: {
      add(c) { if (!el.className.split(' ').includes(c)) el.className = (el.className + ' ' + c).trim(); },
      remove(c) { el.className = el.className.split(' ').filter((x) => x && x !== c).join(' '); },
      contains(c) { return el.className.split(' ').includes(c); },
      toggle(c, on) { (on ? el.classList.add : el.classList.remove)(c); },
    },
    appendChild(c) { c._parent = el; el._children.push(c); return c; },
    append(...cs) { cs.forEach((c) => el.appendChild(c)); },
    querySelector(sel) { return find(el, sel); },
    closest(sel) {
      let n = el;
      while (n) { if (matches(n, sel)) return n; n = n._parent; }
      return null;
    },
    _click(target = el) {
      if (el.onclick) el.onclick({ target, stopPropagation() {} });
      else if (el._parent) el._parent._click(target);
    },
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

function fakeStepsUi() {
  return {
    renderSteps(container, list) {
      for (const s of list) {
        const row = makeEl('div');
        row.className = 'step-row';
        row.dataset.id = s.id;
        container.appendChild(row);
      }
    },
    setStatus() {},
    setSubtitle() {},
  };
}

const { renderAgentPicker } = await import('../home-agent-picker.js');
const { createHomeView } = await import('../home-view.js');

const AGENTS = [
  { name: 'CodeMie Code', command: 'codemie-code', description: 'Built in', installed: true },
  { name: 'Gemini CLI', command: 'gemini', description: 'Google', installed: false },
  { name: 'Claude Code', command: 'claude', description: 'Anthropic', installed: false },
];

const item = (id, status, subtitle = '') => ({ id, title: id, status, subtitle });
const checklist = (agentStatus = 'PENDING') => ({
  done: false,
  items: [item('sign-in', 'COMPLETE', 'in'), item('model', 'COMPLETE', 'demo7'), item('agent', agentStatus), item('health', 'PENDING')],
  agents: AGENTS,
  cards: [],
});

const cardTitles = (root) => root._all((n) => n.className.includes('setup-option-title')).map((n) => n.textContent);

// ---- the list on its own ----------------------------------------------------

const names = (root) => root._all((n) => n.className === 'home-agent-name').map((n) => n.textContent);

test("every agent is listed: what is installed first, then the CLI's suggestion, then the rest", () => {
  const host = makeEl('div');
  renderAgentPicker(host, { agents: AGENTS }, {});
  assert.deepEqual(names(host), ['CodeMie Code', 'Claude Code', 'Gemini CLI']);
  const badges = host._all((n) => n.className === 'home-agent-badge');
  assert.equal(badges.length, 1, 'one recommendation, and it is the CLI\'s');
  assert.equal(badges[0]._parent.textContent, 'Claude Code');
});

// The built-in agent ships inside the CLI package: always reported installed,
// never installable, so it is listed but carries no button.
test('an installed agent shows its version instead of a button', () => {
  const host = makeEl('div');
  renderAgentPicker(host, { agents: [{ name: 'CodeMie Code', command: 'codemie-code', description: 'Built in', installed: true, version: '0.0.47' }] }, {});
  assert.ok(host._text().includes('Installed · 0.0.47'));
  assert.equal(host._all((n) => n._tag === 'button').length, 0);
});

test('each row installs its own agent in one click', () => {
  const host = makeEl('div');
  const chosen = [];
  renderAgentPicker(host, { agents: AGENTS }, { onInstall: (a) => chosen.push(a.command) });
  const buttons = host._all((n) => n._tag === 'button' && n.textContent === 'Install');
  assert.equal(buttons.length, 2, 'one per installable agent');
  buttons[1]._click();
  assert.deepEqual(chosen, ['gemini'], 'the row that was clicked, not the first one');
});

test('while one install runs its row reports progress, loses the badge, and the others cannot be started', () => {
  const host = makeEl('div');
  renderAgentPicker(host, { agents: AGENTS, busy: { command: 'claude', name: 'Claude Code', line: 'Fetching…' } }, {});
  assert.ok(host._text().includes('Fetching…'));
  assert.equal(host._all((n) => n.className === 'home-agent-badge').length, 0, 'recommending a choice already made says nothing');
  const buttons = host._all((n) => n._tag === 'button' && n.textContent === 'Install');
  assert.equal(buttons.length, 1, 'the busy row has no button');
  assert.equal(buttons[0].disabled, true);
});

test('a failure is stated above the list, which stays available for another go', () => {
  const host = makeEl('div');
  renderAgentPicker(host, { agents: AGENTS, error: 'Installing needs a connection.' }, {});
  assert.ok(host._text().includes('Installing needs a connection.'));
  assert.equal(host._all((n) => n._tag === 'button' && n.textContent === 'Install').length, 2);
});

// ---- the item on Home -------------------------------------------------------

test('item 3 expands in place instead of navigating, and collapses when clicked again', () => {
  const container = makeEl('div');
  const opened = [];
  const view = createHomeView(container, { stepsUi: fakeStepsUi(), onItem: (id) => opened.push(id) });
  view.render(checklist());
  assert.equal(container.querySelector('.home-picker'), null);

  container.querySelector('.step-row[data-id="agent"]')._click();
  const picker = container.querySelector('.home-picker');
  assert.ok(picker, 'the picker is drawn inside the row');
  assert.equal(picker._parent.dataset.id, 'agent');
  assert.deepEqual(opened, [], 'nothing navigated');

  container.querySelector('.step-row[data-id="agent"]')._click();
  assert.equal(container.querySelector('.home-picker'), null);
});

// The list already shows every agent, installed or not, so the only button in
// the row is the one that installs; the Agents screen is the sidebar's job.
test('the row offers nothing but installing: no second way out of the flow', () => {
  const container = makeEl('div');
  const view = createHomeView(container, { stepsUi: fakeStepsUi() });
  view.render(checklist());
  container.querySelector('.step-row[data-id="agent"]')._click();
  const buttons = container.querySelector('.home-picker')._all((n) => n._tag === 'button').map((b) => b.textContent);
  assert.deepEqual(new Set(buttons), new Set(['Install']));
});

// Home rebuilds its whole body on every refresh, and refreshes arrive while an
// install is running. Without state kept outside render(), the row the user
// opened would close under them mid-install.
test('an expanded row survives a refresh that arrives while it is open', () => {
  const container = makeEl('div');
  const view = createHomeView(container, { stepsUi: fakeStepsUi() });
  view.render(checklist());
  container.querySelector('.step-row[data-id="agent"]')._click();
  view.render(checklist());
  assert.ok(container.querySelector('.home-picker'), 'still open after the re-render');
});

test('the install runs through the caller, streams its output into the row, and the row closes when the item ticks', async () => {
  const container = makeEl('div');
  const calls = [];
  // Read inside the install and asserted after it: the view catches whatever
  // the callback throws, so an assertion in there would be swallowed.
  const seen = { written: null, afterRerender: null };
  const view = createHomeView(container, {
    stepsUi: fakeStepsUi(),
    onInstallAgent: async (agent, onLine) => {
      calls.push(agent.command);
      onLine('Installing @anthropic-ai/claude-code…');
      // Written straight into the open row, without a re-render: streamed
      // output must not rebuild the list on every chunk.
      seen.written = container.querySelector('.home-agent-progress')?.textContent;
      // And it survives one: a refresh can arrive mid-install.
      view.render(checklist());
      seen.afterRerender = container.querySelector('.home-agent-progress')?.textContent;
      return { ok: true };
    },
  });
  view.render(checklist());
  container.querySelector('.step-row[data-id="agent"]')._click();
  await container._all((n) => n._tag === 'button' && n.textContent === 'Install')[0].onclick({ stopPropagation() {} });

  assert.deepEqual(calls, ['claude']);
  assert.equal(seen.written, 'Installing @anthropic-ai/claude-code…', 'the line is written into the open row as output arrives');
  assert.equal(seen.afterRerender, 'Installing @anthropic-ai/claude-code…', 'and a refresh mid-install does not lose it');
  // The list closes itself once the install lands, and the row opens again on
  // a click if the user wants another agent.
  assert.equal(container.querySelector('.home-picker'), null, 'closed after a successful install');
  container.querySelector('.step-row[data-id="agent"]')._click();
  assert.ok(container.querySelector('.home-picker'), 'and opens again on demand');
});

test('a failed install leaves the row open with the reason, and the item incomplete', async () => {
  const container = makeEl('div');
  const view = createHomeView(container, {
    stepsUi: fakeStepsUi(),
    onInstallAgent: async () => ({ ok: false, message: 'Installing needs a connection.' }),
  });
  view.render(checklist());
  container.querySelector('.step-row[data-id="agent"]')._click();
  await container._all((n) => n._tag === 'button' && n.textContent === 'Install')[0].onclick({ stopPropagation() {} });

  assert.ok(container.querySelector('.home-picker'), 'the row stays open');
  assert.ok(container._text().includes('Installing needs a connection.'));
});

test('an install that throws is reported in the row rather than lost', async () => {
  const container = makeEl('div');
  const view = createHomeView(container, {
    stepsUi: fakeStepsUi(),
    onInstallAgent: async () => { throw new Error('the bridge went away'); },
  });
  view.render(checklist());
  container.querySelector('.step-row[data-id="agent"]')._click();
  await container._all((n) => n._tag === 'button' && n.textContent === 'Install')[0].onclick({ stopPropagation() {} });
  assert.ok(container._text().includes('the bridge went away'));
});

// agents is `undefined` before the first read and `null` when it failed.
// Treating either as an empty list would tell the user everything was already
// installed, which is the one thing it must never say.
test('an unread or failed agent list says so, and offers nothing to install', () => {
  for (const [agents, expected] of [[undefined, 'Reading the agent list…'], [null, 'The agent list could not be read.']]) {
    const host = makeEl('div');
    renderAgentPicker(host, { agents }, {});
    assert.ok(host._text().includes(expected), `${String(agents)} -> ${expected}`);
    assert.ok(!host._text().includes('already installed'));
    assert.equal(host._all((n) => n._tag === 'button' && n.textContent === 'Install').length, 0);
  }
});

test('item 3 carries a chevron that flips with the row', () => {
  const container = makeEl('div');
  const view = createHomeView(container, { stepsUi: fakeStepsUi() });
  view.render(checklist());
  const chevron = () => container.querySelector('.home-row-toggle')?.textContent;
  assert.equal(chevron(), '⌄', 'closed');
  container.querySelector('.step-row[data-id="agent"]')._click();
  assert.equal(chevron(), '⌃', 'open');
  container.querySelector('.step-row[data-id="agent"]')._click();
  assert.equal(chevron(), '⌄', 'closed again');
});

// Installing an agent before signing in and choosing a model gets the user
// nowhere, so the row waits its turn.
test('item 3 does not open while the steps above it are unfinished', () => {
  const container = makeEl('div');
  const early = { ...checklist(), items: [item('sign-in', 'PENDING'), item('model', 'PENDING'), item('agent', 'PENDING'), item('health', 'PENDING')] };
  const view = createHomeView(container, { stepsUi: fakeStepsUi() });
  view.render(early);
  assert.equal(container.querySelector('.home-row-toggle'), null, 'no chevron before its turn');
  container.querySelector('.step-row[data-id="agent"]')._click();
  assert.equal(container.querySelector('.home-picker'), null, 'and clicking does nothing');

  view.render(checklist());
  assert.ok(container.querySelector('.home-row-toggle'), 'the chevron appears once the steps above are done');
  container.querySelector('.step-row[data-id="agent"]')._click();
  assert.ok(container.querySelector('.home-picker'));
});
