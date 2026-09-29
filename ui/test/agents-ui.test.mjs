import { test } from 'node:test';
import assert from 'node:assert/strict';

// Minimal DOM stub, the shape the other view tests use.
function makeEl(tag) {
  const el = {
    _tag: tag,
    children: [],
    className: '',
    textContent: '',
    dataset: {},
    appendChild(c) {
      c.remove?.();
      c._parent = el;
      el.children.push(c);
      return c;
    },
    // Real DOM semantics: moving a node detaches it first, a null reference
    // appends, and inserting a node before itself leaves it where it is.
    insertBefore(c, ref) {
      if (ref === c) ref = c.nextSibling;
      c.remove?.();
      c._parent = el;
      const i = ref ? el.children.indexOf(ref) : -1;
      if (i < 0) el.children.push(c);
      else el.children.splice(i, 0, c);
      return c;
    },
    get parentNode() {
      return el._parent || null;
    },
    get nextSibling() {
      const p = el._parent;
      return p ? p.children[p.children.indexOf(el) + 1] || null : null;
    },
    append(...cs) {
      cs.forEach((c) => el.appendChild(c));
    },
    querySelector(sel) {
      return find(el, sel);
    },
    querySelectorAll(sel) {
      return el._all((n) => n !== el && matches(n, sel));
    },
    remove() {
      const p = el._parent;
      if (p) p.children = p.children.filter((c) => c !== el);
    },
    classList: {
      add(c) {
        if (!el.className.split(' ').includes(c)) el.className = `${el.className} ${c}`.trim();
      },
      remove(c) {
        el.className = el.className.split(' ').filter((x) => x && x !== c).join(' ');
      },
      contains: (c) => el.className.split(' ').includes(c),
      toggle(c, force) {
        const on = force ?? !el.className.split(' ').includes(c);
        if (on) el.classList.add(c);
        else el.classList.remove(c);
      },
    },
    _text() {
      return el.children.length ? el.children.map((c) => c._text()).join(' ') : el.textContent;
    },
    _all(pred) {
      const out = [];
      (function walk(n) {
        if (pred(n)) out.push(n);
        n.children.forEach(walk);
      })(el);
      return out;
    },
  };
  Object.defineProperty(el, 'innerHTML', {
    get: () => '',
    set() {
      el.children = [];
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
  for (const c of root.children) {
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

const { renderAgents, renderPane, setSelectedRow, showLoading, showRunError, summarise } = await import('../agents-ui.js');

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

test('an installed agent offers Remove, one that is not offers Install, the built-in one neither', () => {
  const container = makeEl('div');
  const seen = [];
  const stepsUi = fakeStepsUi();
  renderAgents(
    container,
    { agents },
    { stepsUi, onInstall: (a) => seen.push(['install', a.command]), onUpdate: (a) => seen.push(['update', a.command]), onRemove: (a) => seen.push(['remove', a.command]) },
  );
  assert.deepEqual(buttons(container), ['Remove', 'Install']);
  const subs = Object.fromEntries(stepsUi.calls.filter((c) => c[0] === 'setSubtitle').map((c) => [c[1], c[2]]));
  assert.match(subs['codemie-code'], /built into the CLI$/);
  const slot = container.querySelector('.agent-actions[data-id="gemini"]');
  slot.children[0].onclick({ stopPropagation() {} });
  assert.deepEqual(seen, [['install', 'gemini']]);
});

test('a clicked action disables every button on the screen and says what is running', () => {
  const container = makeEl('div');
  const noop = () => {};
  renderAgents(container, { agents }, { stepsUi: fakeStepsUi(), onInstall: noop, onUpdate: noop, onRemove: noop });
  const [remove] = container.querySelector('.agent-actions[data-id="claude"]').children;
  remove.onclick({ stopPropagation() {} });
  assert.equal(remove.textContent, 'Removing…');
  assert.equal(remove.disabled, true);
  const [install] = container.querySelector('.agent-actions[data-id="gemini"]').children;
  assert.equal(install.disabled, true, 'other rows wait for it too');
});

test('the screen says it is reading before the list arrives', () => {
  const container = makeEl('div');
  showLoading(container);
  assert.match(container._text(), /Tools Reading the tool list/);
});

// Reading the list takes a few seconds, and a header over an empty screen
// reads as a screen that failed to draw.
test('the screen shows a spinner while the list is read', () => {
  const container = makeEl('div');
  showLoading(container);
  assert.ok(container.querySelector('.screen-spinner'));
});

test('a failed read states what happened and offers the read again, instead of an empty list', () => {
  const container = makeEl('div');
  let retried = 0;
  showRunError(container, 'spawn codemie ENOENT', () => {
    retried += 1;
  });
  assert.match(container._text(), /CodeMie could not read the tool list/);
  assert.match(container._text(), /spawn codemie ENOENT/);
  assert.doesNotMatch(container._text(), /0 of 0 installed/);
  container._all((n) => n._tag === 'button')[0].onclick();
  assert.equal(retried, 1);
});

test('the screen says agents are run from a terminal, since it cannot launch one', () => {
  const container = makeEl('div');
  renderAgents(container, { agents }, { stepsUi: fakeStepsUi() });
  assert.match(container._text(), /Run a tool from a terminal/);
  assert.doesNotMatch(container._text(), /\bLaunch\b|\bRun agent\b/);
});

test('an installed agent with an update keeps its tick, not a warning', () => {
  const withUpdate = agents.map((a) => (a.command === 'claude' ? { ...a, updateAvailable: true } : a));
  const stepsUi = fakeStepsUi();
  renderAgents(makeEl('div'), { agents: withUpdate }, { stepsUi });
  const status = Object.fromEntries(stepsUi.calls.filter((c) => c[0] === 'setStatus').map((c) => [c[1], c[2]]));
  assert.equal(status.claude, 'COMPLETE');
});

// The row says in words that an update is out, and its tooltip says what
// Update will do.
test('a row with an update says so, and names the version on offer', () => {
  const withUpdate = agents.map((a) => (a.command === 'claude' ? { ...a, updateAvailable: true, latest: '2.2.0' } : a));
  const stepsUi = fakeStepsUi();
  const container = makeEl('div');
  renderAgents(container, { agents: withUpdate }, { stepsUi });
  const subs = Object.fromEntries(stepsUi.calls.filter((c) => c[0] === 'setSubtitle').map((c) => [c[1], c[2]]));
  assert.match(subs.claude, /2\.2\.0 available$/);
  const row = container.querySelector('.step-row[data-id="claude"]');
  assert.match(row.title, /Update installs 2\.2\.0/);
});

test('a row without an update has no update wording or tooltip', () => {
  const stepsUi = fakeStepsUi();
  const container = makeEl('div');
  renderAgents(container, { agents }, { stepsUi });
  const subs = stepsUi.calls.filter((c) => c[0] === 'setSubtitle').map((c) => c[2]);
  assert.ok(subs.every((t) => !/available/.test(t)));
  assert.ok(!container.querySelector('.step-row[data-id="claude"]').title);
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

test('Update is offered only when an update is out', () => {
  const container = makeEl('div');
  const noop = () => {};
  const withUpdate = agents.map((a) => (a.command === 'claude' ? { ...a, updateAvailable: true, latest: '2.2.0' } : a));
  renderAgents(container, { agents: withUpdate }, { stepsUi: fakeStepsUi(), onInstall: noop, onUpdate: noop, onRemove: noop });
  assert.deepEqual(buttons(container), ['Update', 'Remove', 'Install']);
});

test('the built-in agent is not counted as an update, since its row offers none', () => {
  const withUpdates = agents.map((a) => (a.command === 'codemie-code' || a.command === 'claude' ? { ...a, updateAvailable: true } : a));
  assert.equal(summarise(withUpdates).updateAvailable, 1);
});

// ---- Detail pane (EPMCDME-14655) ----

const claude = { ...agents[1], launcher: 'codemie-claude' };
const gemini = { ...agents[2], launcher: 'codemie-gemini' };
const builtin = { ...agents[0], launcher: 'codemie-code', current: '0.16.0', latest: '0.15.2' };
const noop = () => {};
const handlers = { onInstall: noop, onUpdate: noop, onRemove: noop };
const paneOf = (container) => container.querySelector('.agent-pane');
const paneButtons = (container) => paneOf(container)._all((n) => n._tag === 'button');

function mountPane(agent, state = {}) {
  const container = makeEl('div');
  const stepsUi = fakeStepsUi();
  renderAgents(container, { agents: [builtin, claude, gemini], selected: agent?.command }, { stepsUi, ...handlers });
  const before = stepsUi.calls.length;
  renderPane(container, agent, state);
  return { container, stepsUi, before };
}

test('the details open under the selected row, inside the list', () => {
  const container = makeEl('div');
  renderAgents(container, { agents: [builtin, claude, gemini], selected: 'claude' }, { stepsUi: fakeStepsUi(), ...handlers });
  const list = container.querySelector('.agents-list');
  const ids = list.children.map((c) => c.dataset.id || c.className);
  assert.deepEqual(ids, ['codemie-code', 'claude', 'agent-pane', 'gemini']);
  assert.equal(paneOf(container).hidden, false);
  assert.match(paneOf(container)._text(), /codemie-claude/, 'the selected agent is drawn by renderAgents');
});

test('a not-installed agent says so, with no launcher line and no buttons of its own', () => {
  const { container } = mountPane(gemini);
  const text = paneOf(container)._text();
  assert.match(text, /Not installed/);
  assert.doesNotMatch(text, /Run it from a terminal/);
  assert.deepEqual(paneButtons(container), [], 'the actions stay on the row');
});

test('an installed agent shows its version and the derived launcher, never the raw command', () => {
  const { container } = mountPane(claude);
  const text = paneOf(container)._text();
  assert.match(text, /Installed 2\.1\.269/);
  assert.match(text, /Run it from a terminal: codemie-claude/);
  assert.doesNotMatch(text, /Run it from a terminal: claude\b/);
});

test('an agent with an update says which version is on offer', () => {
  const { container } = mountPane({ ...claude, updateAvailable: true, latest: '2.2.0' });
  assert.match(paneOf(container)._text(), /Update available 2\.2\.0/);
});

test('a version above the supported one is kept and said so with both numbers', () => {
  const { container } = mountPane({ ...claude, current: '2.1.290', latest: '2.1.281', newerThanSupported: true });
  const text = paneOf(container)._text();
  assert.match(text, /Newer than CodeMie supports — kept/);
  assert.match(text, /2\.1\.290/);
  assert.match(text, /2\.1\.281/);
});

test('the built-in agent shows its launcher and no Current, Latest or buttons', () => {
  const { container } = mountPane(builtin);
  const text = paneOf(container)._text();
  assert.match(text, /built into the CLI/);
  assert.match(text, /codemie-code/);
  assert.doesNotMatch(text, /0\.16\.0|0\.15\.2|Current|Latest/);
  assert.deepEqual(paneButtons(container), []);
});

test('progress appears in the pane and never in a row subtitle', () => {
  const { container, stepsUi, before } = mountPane(gemini, { progress: 'Downloading gemini 40%' });
  assert.match(paneOf(container)._text(), /Downloading gemini 40%/);
  assert.equal(stepsUi.calls.length, before, 'no stepsUi call');
  assert.ok(!stepsUi.calls.some((c) => c[0] === 'setSubtitle' && /Downloading/.test(c[2])));
});

test('a failure is a plain-language failure block with no transcript and no Show details', () => {
  const { container } = mountPane({ ...gemini, actionStatus: 'error', actionMessage: 'Installing needs a connection.' });
  const block = paneOf(container).querySelector('.failure-block');
  assert.ok(block);
  assert.match(block._text(), /Installing needs a connection\./);
  assert.ok(!block._all((n) => n._tag === 'button').some((b) => /details/i.test(b.textContent)));
  assert.equal(block.querySelector('.failure-raw').textContent, '', 'nothing raw is kept');
});

test('a note left by an update that changed nothing is shown in the pane, not as a failure', () => {
  const { container } = mountPane({ ...claude, actionMessage: 'Claude Code is already up to date' });
  assert.match(paneOf(container)._text(), /already up to date/);
  assert.equal(paneOf(container).querySelector('.failure-block'), null);
});


test('with no selection, or a selected agent that is gone, the details stay closed', () => {
  const container = makeEl('div');
  renderAgents(container, { agents: [claude], selected: 'gone' }, { stepsUi: fakeStepsUi(), ...handlers });
  assert.equal(paneOf(container).hidden, true);
  assert.doesNotThrow(() => renderPane(container, undefined, {}));
  assert.equal(paneOf(container).hidden, true);
  assert.equal(paneOf(container)._text(), '');
});

test('opening another agent moves the one details block under its row', () => {
  const container = makeEl('div');
  renderAgents(container, { agents: [builtin, claude, gemini], selected: 'claude' }, { stepsUi: fakeStepsUi(), ...handlers });
  renderPane(container, gemini, {});
  const list = container.querySelector('.agents-list');
  assert.deepEqual(list.children.map((c) => c.dataset.id || c.className), ['codemie-code', 'claude', 'gemini', 'agent-pane']);
  assert.equal(container.querySelectorAll('.agent-pane').length, 1);
});

test('renderPane and setSelectedRow never touch the step list', () => {
  const { container, stepsUi, before } = mountPane(claude, { progress: 'x' });
  setSelectedRow(container, 'claude');
  renderPane(container, gemini, {});
  assert.equal(stepsUi.calls.length, before);
});

test('setSelectedRow marks exactly one row, and keeps the running row active', () => {
  const container = makeEl('div');
  renderAgents(container, { agents: [builtin, claude, gemini] }, { stepsUi: fakeStepsUi(), ...handlers });
  const row = (id) => container.querySelector(`.step-row[data-id="${id}"]`);
  row('claude').className += ' active';
  setSelectedRow(container, 'claude');
  setSelectedRow(container, 'gemini');
  assert.ok(!row('claude').className.split(' ').includes('selected'));
  assert.ok(row('gemini').className.split(' ').includes('selected'));
  assert.ok(row('claude').className.split(' ').includes('active'), 'active is a different class');
});

test('clicking a row selects it, clicking its button does not', () => {
  const container = makeEl('div');
  const selected = [];
  renderAgents(container, { agents: [builtin, claude, gemini] }, { stepsUi: fakeStepsUi(), ...handlers, onSelect: (c) => selected.push(c) });
  container.querySelector('.step-row[data-id="gemini"]').onclick({});
  assert.deepEqual(selected, ['gemini']);
});

test('a row subtitle is description and version only; a note or failure lives in the pane', () => {
  const stepsUi = fakeStepsUi();
  renderAgents(makeEl('div'), { agents: [{ ...claude, actionStatus: 'error', actionMessage: 'Updating needs a connection.' }] }, { stepsUi, ...handlers });
  const sub = stepsUi.calls.find((c) => c[0] === 'setSubtitle');
  assert.equal(sub[2], 'Claude Code - official Anthropic CLI tool · 2.1.269');
});

test('no Launch or Run button exists anywhere in the pane', () => {
  for (const a of [builtin, claude, gemini]) {
    const { container } = mountPane(a);
    assert.doesNotMatch(paneOf(container)._text(), /\bLaunch\b|\bRun agent\b/);
    assert.ok(!paneButtons(container).some((b) => /launch|run/i.test(b.textContent)));
  }
});
