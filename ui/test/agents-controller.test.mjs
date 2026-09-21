import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Same DOM stub as the other view tests; the controller only builds nodes
// through agents-ui.js, so this is all the document it needs.
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
      const m = sel.match(/^\.([\w-]+)(?:\[data-id="([^"]+)"\])?$/);
      const hit = (n) => m && n.className.split(' ').includes(m[1]) && (!m[2] || n.dataset.id === m[2]);
      let found = null;
      (function walk(n) {
        if (found) return;
        for (const c of n._children) {
          if (hit(c)) {
            found = c;
            return;
          }
          walk(c);
        }
      })(el);
      return found;
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
    setStatus(id, s) {
      calls.push(['setStatus', id, s]);
    },
    setSubtitle(id, t) {
      calls.push(['setSubtitle', id, t]);
    },
  };
}

const { createAgentsController } = await import('../agents-controller.js');
const fixture = readFileSync(fileURLToPath(new URL('fixtures/agents/list.txt', import.meta.url)), 'utf8');

const ok = (stdout) => async () => ({ code: 0, stdout, stderr: '' });

test('a successful read renders the agents and hands the same records to the caller', async () => {
  const container = makeEl('div');
  const seen = [];
  const c = createAgentsController({
    container,
    runCapture: ok(fixture),
    stepsUi: fakeStepsUi(),
    onResult: (agents) => seen.push(agents),
  });
  await c.run();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].length, 11);
  assert.equal(c.getLastAgents().length, 11);
  assert.match(container._text(), /3 of 11 installed/);
});

test('the command it runs is exactly `codemie list`', async () => {
  const cmds = [];
  await createAgentsController({
    container: makeEl('div'),
    runCapture: async (cmd) => {
      cmds.push(cmd);
      return { code: 0, stdout: fixture, stderr: '' };
    },
    stepsUi: fakeStepsUi(),
  }).run();
  assert.deepEqual(cmds, ['codemie list']);
});

test('a non-zero exit shows the CLI text, keeps no stale list, and releases the caller guard', async () => {
  const container = makeEl('div');
  let failures = 0;
  const c = createAgentsController({
    container,
    runCapture: async () => ({ code: 1, stdout: '', stderr: 'codemie: command not found' }),
    stepsUi: fakeStepsUi(),
    onFailure: () => {
      failures += 1;
    },
  });
  await c.run();
  assert.match(container._text(), /could not read the agent list/);
  assert.match(container._text(), /command not found/);
  assert.equal(c.getLastAgents(), null);
  assert.equal(failures, 1);
});

test('a rejected call is caught and shown rather than leaving the screen on "Reading…"', async () => {
  const container = makeEl('div');
  const c = createAgentsController({
    container,
    runCapture: async () => {
      throw new Error('spawn failed');
    },
    stepsUi: fakeStepsUi(),
  });
  await c.run();
  assert.match(container._text(), /spawn failed/);
  assert.doesNotMatch(container._text(), /Reading the agent list/);
});

test('output that parses to nothing is an error, never "0 of 0 installed"', async () => {
  const container = makeEl('div');
  const c = createAgentsController({ container, runCapture: ok('nothing like the list'), stepsUi: fakeStepsUi() });
  await c.run();
  assert.match(container._text(), /came back empty/);
  assert.doesNotMatch(container._text(), /0 of 0 installed/);
  assert.equal(c.getLastAgents(), null);
});

test('a second run while the first is in flight is a no-op', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const c = createAgentsController({
    container: makeEl('div'),
    runCapture: async () => {
      calls += 1;
      await gate;
      return { code: 0, stdout: fixture, stderr: '' };
    },
    stepsUi: fakeStepsUi(),
  });
  const first = c.run();
  await c.run();
  release();
  await first;
  assert.equal(calls, 1);
});

test('the action handlers the caller supplies reach the rows', async () => {
  const container = makeEl('div');
  const seen = [];
  await createAgentsController({
    container,
    runCapture: ok(fixture),
    stepsUi: fakeStepsUi(),
    actions: { onInstall: (a) => seen.push(a.command) },
  }).run();
  const slot = container.querySelector('.agent-actions[data-id="gemini"]');
  slot._children[0].onclick({ stopPropagation() {} });
  assert.deepEqual(seen, ['gemini']);
});
