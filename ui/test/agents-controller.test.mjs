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
    startSpinner(id) {
      calls.push(['startSpinner', id]);
    },
    stopSpinner(id) {
      calls.push(['stopSpinner', id]);
    },
  };
}

// A `codemie update --check` capture with zero records — none of the tests
// below care about the join outcome, only about the action wiring.
const upToDateCheck = readFileSync(fileURLToPath(new URL('fixtures/agents/update-check.txt', import.meta.url)), 'utf8');

// runCapture stub that answers `codemie list` and `codemie update --check`
// distinctly, the way the controller now calls both from load().
function fakeRunCapture(listStdout = fixture) {
  return async (cmd) => {
    if (cmd === 'codemie list') return { code: 0, stdout: listStdout, stderr: '' };
    if (cmd === 'codemie update --check') return { code: 0, stdout: upToDateCheck, stderr: '' };
    throw new Error(`unexpected runCapture command: ${cmd}`);
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

test('a load reads exactly `codemie list` and `codemie update --check`', async () => {
  const cmds = [];
  await createAgentsController({
    container: makeEl('div'),
    runCapture: async (cmd) => {
      cmds.push(cmd);
      if (cmd === 'codemie list') return { code: 0, stdout: fixture, stderr: '' };
      return { code: 0, stdout: upToDateCheck, stderr: '' };
    },
    stepsUi: fakeStepsUi(),
  }).run();
  assert.deepEqual(cmds, ['codemie list', 'codemie update --check']);
});

test('a failed update-check read is best-effort: the list still renders with no agent flagged', async () => {
  const container = makeEl('div');
  const c = createAgentsController({
    container,
    runCapture: async (cmd) => {
      if (cmd === 'codemie list') return { code: 0, stdout: fixture, stderr: '' };
      return { code: 1, stdout: '', stderr: 'network down' };
    },
    stepsUi: fakeStepsUi(),
  });
  await c.run();
  assert.equal(c.getLastAgents().every((a) => a.updateAvailable === false), true);
  assert.match(container._text(), /3 of 11 installed/);
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
  // One full load() reads both `codemie list` and `codemie update --check`;
  // the second run() call must add none of its own.
  assert.equal(calls, 2);
});

// The controller now builds its own onInstall/onUpdate/onRemove internally,
// driving the caller-supplied runStream directly (per ui/runner-bridge.js's
// contract: the resolved promise carries only { code }, never text; any
// text comes from the onLine callback, scripted here as [text, tag] pairs).
function fakeRunStream(scriptedLines, code = 0) {
  const calls = [];
  return {
    calls,
    fn: async (cmd, onLine) => {
      calls.push(cmd);
      for (const [text, tag] of scriptedLines) onLine(text, tag);
      return { code };
    },
  };
}

test('clicking Install on a not-installed row runs the exact install command with no version', async () => {
  const container = makeEl('div');
  const runStream = fakeRunStream([['Installing gemini…', 'stdout']]);
  await createAgentsController({
    container,
    runCapture: fakeRunCapture(),
    runStream: runStream.fn,
    stepsUi: fakeStepsUi(),
  }).run();
  const slot = container.querySelector('.agent-actions[data-id="gemini"]');
  slot._children[0].onclick({ stopPropagation() {} });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(runStream.calls, ['codemie install gemini --supported']);
});

test('clicking Update on an installed row runs the exact update command; Remove runs uninstall', async () => {
  const container = makeEl('div');
  const runStream = fakeRunStream([]);
  await createAgentsController({
    container,
    runCapture: fakeRunCapture(),
    runStream: runStream.fn,
    stepsUi: fakeStepsUi(),
  }).run();
  const slot = container.querySelector('.agent-actions[data-id="claude"]');
  slot._children[0].onclick({ stopPropagation() {} }); // Update
  await new Promise((r) => setImmediate(r));
  slot._children[1].onclick({ stopPropagation() {} }); // Remove
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(runStream.calls, ['codemie update claude', 'codemie uninstall claude']);
});

test('while an action is in flight the row is ACTIVE with a spinner and the latest streamed line as subtitle, and settling refreshes without ever blanking to the loading text', async () => {
  const container = makeEl('div');
  const stepsUi = fakeStepsUi();
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const runStream = async (cmd, onLine) => {
    onLine('Installing gemini…', 'stdout');
    await gate;
    onLine('Installed.', 'stdout');
    return { code: 0 };
  };
  const textsDuringRefresh = [];
  const c = createAgentsController({
    container,
    runCapture: async (cmd) => {
      if (cmd === 'codemie list') {
        // A refresh's list read happens after the action starts; capture the
        // container's text at that moment, before this read resolves, so a
        // stray showLoading() call (the loading-blanking path) would show up
        // here as "Reading the agent list…".
        textsDuringRefresh.push(container._text());
        return { code: 0, stdout: fixture, stderr: '' };
      }
      return { code: 0, stdout: upToDateCheck, stderr: '' };
    },
    runStream,
    stepsUi,
  });
  await c.run();
  textsDuringRefresh.length = 0;
  const slot = container.querySelector('.agent-actions[data-id="gemini"]');
  slot._children[0].onclick({ stopPropagation() {} });
  await new Promise((r) => setImmediate(r));

  assert.equal(stepsUi.calls.some((call) => call[0] === 'setStatus' && call[1] === 'gemini' && call[2] === 'ACTIVE'), true);
  assert.equal(stepsUi.calls.some((call) => call[0] === 'startSpinner' && call[1] === 'gemini'), true);
  assert.equal(stepsUi.calls.some((call) => call[0] === 'setSubtitle' && call[1] === 'gemini' && call[2] === 'Installing gemini…'), true);

  release();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  assert.equal(textsDuringRefresh.some((t) => /Reading the agent list/.test(t)), false);
});

test('a failing action leaves the row actionMessage equal to the accumulated stderr text after refresh', async () => {
  const container = makeEl('div');
  const stepsUi = fakeStepsUi();
  const runStream = async (cmd, onLine) => {
    onLine('some progress', 'stdout');
    onLine('boom: install failed', 'stderr');
    return { code: 1 };
  };
  const c = createAgentsController({
    container,
    runCapture: fakeRunCapture(),
    runStream,
    stepsUi,
  });
  await c.run();
  const slot = container.querySelector('.agent-actions[data-id="gemini"]');
  slot._children[0].onclick({ stopPropagation() {} });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  const subtitles = stepsUi.calls.filter((call) => call[0] === 'setSubtitle' && call[1] === 'gemini');
  assert.equal(subtitles.at(-1)[2], 'boom: install failed');
});

test('accumulated text matching a connection-error pattern renders as "Installing needs a connection."', async () => {
  const container = makeEl('div');
  const stepsUi = fakeStepsUi();
  const runStream = async (cmd, onLine) => {
    onLine('Error: connect ECONNREFUSED 127.0.0.1:443', 'stderr');
    return { code: 1 };
  };
  const c = createAgentsController({
    container,
    runCapture: fakeRunCapture(),
    runStream,
    stepsUi,
  });
  await c.run();
  const slot = container.querySelector('.agent-actions[data-id="gemini"]');
  slot._children[0].onclick({ stopPropagation() {} });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  const subtitles = stepsUi.calls.filter((call) => call[0] === 'setSubtitle' && call[1] === 'gemini');
  assert.equal(subtitles.at(-1)[2], 'Installing needs a connection.');
});

test('an agent.command with shell metacharacters is never handed to runStream', async () => {
  const container = makeEl('div');
  const maliciousList = `
📦 Available Agents:

  Evil Agent
    Command: gemini; rm -rf /
    Status: not installed
    Not a real agent
`;
  const runStream = fakeRunStream([]);
  const c = createAgentsController({
    container,
    runCapture: fakeRunCapture(maliciousList),
    runStream: runStream.fn,
    stepsUi: fakeStepsUi(),
  });
  await c.run();
  const slot = container.querySelector('.agent-actions[data-id="gemini; rm -rf /"]');
  slot._children[0].onclick({ stopPropagation() {} });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(runStream.calls, []);
});

test('a second click on the same row while its action is in flight does not fire a second runStream call', async () => {
  const container = makeEl('div');
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const runStream = fakeRunStream([]);
  runStream.fn = async (cmd, onLine) => {
    runStream.calls.push(cmd);
    await gate;
    return { code: 0 };
  };
  const c = createAgentsController({
    container,
    runCapture: fakeRunCapture(),
    runStream: runStream.fn,
    stepsUi: fakeStepsUi(),
  });
  await c.run();
  const slot = container.querySelector('.agent-actions[data-id="gemini"]');
  slot._children[0].onclick({ stopPropagation() {} });
  slot._children[0].onclick({ stopPropagation() {} });
  await new Promise((r) => setImmediate(r));
  release();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(runStream.calls, ['codemie install gemini --supported']);
});

test('a failing action with no real output never shows the echoed command as the error message', async () => {
  const container = makeEl('div');
  const stepsUi = fakeStepsUi();
  // Mirrors ui/runner-bridge.js's real runStream: it always emits a leading
  // `('> <command>', 'prompt')` line before any real output.
  const runStream = async (cmd, onLine) => {
    onLine(`> ${cmd}`, 'prompt');
    return { code: 1 };
  };
  const c = createAgentsController({
    container,
    runCapture: fakeRunCapture(),
    runStream,
    stepsUi,
  });
  await c.run();
  const slot = container.querySelector('.agent-actions[data-id="gemini"]');
  slot._children[0].onclick({ stopPropagation() {} });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  const subtitles = stepsUi.calls.filter((call) => call[0] === 'setSubtitle' && call[1] === 'gemini');
  assert.doesNotMatch(subtitles.at(-1)[2], /^> codemie install/);
});

test('ENETUNREACH and EAI_AGAIN also render as "Installing needs a connection."', async () => {
  for (const errCode of ['ENETUNREACH', 'EAI_AGAIN']) {
    const container = makeEl('div');
    const stepsUi = fakeStepsUi();
    const runStream = async (cmd, onLine) => {
      onLine(`Error: connect ${errCode} 127.0.0.1:443`, 'stderr');
      return { code: 1 };
    };
    const c = createAgentsController({
      container,
      runCapture: fakeRunCapture(),
      runStream,
      stepsUi,
    });
    await c.run();
    const slot = container.querySelector('.agent-actions[data-id="gemini"]');
    slot._children[0].onclick({ stopPropagation() {} });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const subtitles = stepsUi.calls.filter((call) => call[0] === 'setSubtitle' && call[1] === 'gemini');
    assert.equal(subtitles.at(-1)[2], 'Installing needs a connection.', `expected ${errCode} to be treated as no-network`);
  }
});

test('refresh() re-reads and re-renders without going through the loading-blanking path run() uses', async () => {
  const container = makeEl('div');
  const seenLoadingText = [];
  const c = createAgentsController({
    container,
    runCapture: async (cmd) => {
      seenLoadingText.push(container._text());
      if (cmd === 'codemie list') return { code: 0, stdout: fixture, stderr: '' };
      return { code: 0, stdout: upToDateCheck, stderr: '' };
    },
    stepsUi: fakeStepsUi(),
  });
  await c.run();
  seenLoadingText.length = 0;
  await c.refresh();
  assert.equal(seenLoadingText.some((t) => /Reading the agent list/.test(t)), false);
});
