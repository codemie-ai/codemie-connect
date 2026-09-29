import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Same DOM stub as the other view tests; the controller only builds nodes
// through agents-ui.js, so this is all the document it needs.
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
      const m = sel.match(/^\.([\w-]+)(?:\[data-id="([^"]+)"\])?$/);
      const hit = (n) => m && n.className.split(' ').includes(m[1]) && (!m[2] || n.dataset.id === m[2]);
      let found = null;
      (function walk(n) {
        if (found) return;
        for (const c of n.children) {
          if (hit(c)) {
            found = c;
            return;
          }
          walk(c);
        }
      })(el);
      return found;
    },
    querySelectorAll(sel) {
      const m = sel.match(/^\.([\w-]+)$/);
      const out = [];
      (function walk(n) {
        for (const c of n.children) {
          if (m && c.className.split(' ').includes(m[1])) out.push(c);
          walk(c);
        }
      })(el);
      return out;
    },
    _all(pred) {
      const out = [];
      (function walk(n) {
        if (pred(n)) out.push(n);
        n.children.forEach(walk);
      })(el);
      return out;
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
        if (force ?? !el.className.split(' ').includes(c)) el.classList.add(c);
        else el.classList.remove(c);
      },
    },
    _text() {
      return el.children.length ? el.children.map((c) => c._text()).join(' ') : el.textContent;
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
// Real output with one update out: OpenCode CLI 1.18.31 -> 1.18.32.
const openCodeUpdateCheck = readFileSync(fileURLToPath(new URL('fixtures/agents/update-check-available.txt', import.meta.url)), 'utf8');

// runCapture stub that answers `codemie list` and `codemie update --check`
// distinctly, the way the controller now calls both from load().
function fakeRunCapture(listStdout = fixture, checkStdout = upToDateCheck) {
  return async (cmd) => {
    if (cmd === 'codemie list') return { code: 0, stdout: listStdout, stderr: '' };
    if (cmd === 'codemie update --check') return { code: 0, stdout: checkStdout, stderr: '' };
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
  assert.match(container._text(), /could not read the tool list/);
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
  assert.doesNotMatch(container._text(), /Reading the tool list/);
});

test('output that parses to nothing is an error, never "0 of 0 installed"', async () => {
  const container = makeEl('div');
  const c = createAgentsController({ container, runCapture: ok('nothing like the list'), stepsUi: fakeStepsUi() });
  await c.run();
  assert.match(container._text(), /came back empty/);
  assert.doesNotMatch(container._text(), /0 of 0 installed/);
  assert.equal(c.getLastAgents(), null);
});

test('a second run while the first is in flight waits for it instead of racing it', async () => {
  const seen = [];
  let calls = 0;
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const c = createAgentsController({
    container: makeEl('div'),
    runCapture: async (cmd) => {
      calls += 1;
      seen.push(cmd);
      if (calls === 1) await gate;
      return { code: 0, stdout: cmd === 'codemie list' ? fixture : '', stderr: '' };
    },
    stepsUi: fakeStepsUi(),
  });
  const first = c.run();
  await c.run();
  // Nothing from the second call has run yet: the first read is still open.
  assert.equal(calls, 1);
  release();
  await first;
  // One full load() reads `codemie list` and `codemie update --check`. The
  // deferred second load follows it rather than being dropped, which is what
  // a post-action refresh depends on to put the row's result on screen.
  assert.deepEqual(seen, ['codemie list', 'codemie update --check', 'codemie list', 'codemie update --check']);
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

// No --supported: it routes every agent to the native-installer path and
// fails for the eight that install through npm. See
// .ai-run/decisions/2026-09-21-EPMCDME-14514-install-without-supported.md.
test('clicking Install on a not-installed row runs the exact install command with no version and no flag', async () => {
  const container = makeEl('div');
  const runStream = fakeRunStream([['Installing gemini…', 'stdout']]);
  await createAgentsController({
    container,
    runCapture: fakeRunCapture(),
    runStream: runStream.fn,
    stepsUi: fakeStepsUi(),
  }).run();
  const slot = container.querySelector('.agent-actions[data-id="gemini"]');
  slot.children[0].onclick({ stopPropagation() {} });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(runStream.calls, ['codemie install gemini']);
});

test('clicking Update on an installed row runs the exact update command; Remove runs uninstall', async () => {
  const container = makeEl('div');
  const runStream = fakeRunStream([]);
  await createAgentsController({
    container,
    runCapture: fakeRunCapture(fixture, openCodeUpdateCheck),
    runStream: runStream.fn,
    stepsUi: fakeStepsUi(),
  }).run();
  container.querySelector('.agent-actions[data-id="opencode"]').children[0].onclick({ stopPropagation() {} }); // Update
  await new Promise((r) => setImmediate(r));
  container.querySelector('.agent-actions[data-id="opencode"]').children[1].onclick({ stopPropagation() {} }); // Remove
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(runStream.calls, ['codemie update opencode', 'codemie uninstall opencode']);
});

test('while an action is in flight the row is ACTIVE with a spinner, and settling refreshes without ever blanking to the loading text', async () => {
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
        // here as "Reading the tool list…".
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
  slot.children[0].onclick({ stopPropagation() {} });
  await new Promise((r) => setImmediate(r));

  assert.equal(stepsUi.calls.some((call) => call[0] === 'setStatus' && call[1] === 'gemini' && call[2] === 'ACTIVE'), true);
  assert.equal(stepsUi.calls.some((call) => call[0] === 'startSpinner' && call[1] === 'gemini'), true);
  assert.equal(stepsUi.calls.some((call) => call[0] === 'setSubtitle' && call[2] === 'Installing gemini…'), false, 'progress is not a row subtitle');

  release();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  assert.equal(textsDuringRefresh.some((t) => /Reading the tool list/.test(t)), false);
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
  slot.children[0].onclick({ stopPropagation() {} });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(c.getLastAgents().find((a) => a.command === 'gemini').actionMessage, 'boom: install failed');
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
  slot.children[0].onclick({ stopPropagation() {} });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(c.getLastAgents().find((a) => a.command === 'gemini').actionMessage, 'Installing needs a connection.');
});

test('a Remove that fails for want of a connection says removing, not installing', async () => {
  const container = makeEl('div');
  const stepsUi = fakeStepsUi();
  const runStream = async (cmd, onLine) => {
    onLine('Error: getaddrinfo ENOTFOUND registry.npmjs.org', 'stderr');
    return { code: 1 };
  };
  const c = createAgentsController({ container, runCapture: fakeRunCapture(), runStream, stepsUi });
  await c.run();
  const slot = container.querySelector('.agent-actions[data-id="opencode"]');
  slot.children[slot.children.length - 1].onclick({ stopPropagation() {} }); // Remove
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(c.getLastAgents().find((a) => a.command === 'opencode').actionMessage, 'Removing needs a connection.');
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
  slot.children[0].onclick({ stopPropagation() {} });
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
  slot.children[0].onclick({ stopPropagation() {} });
  slot.children[0].onclick({ stopPropagation() {} });
  // Another row too: npm installs into one shared folder, so one at a time.
  container.querySelector('.agent-actions[data-id="claude"]').children[0].onclick({ stopPropagation() {} });
  await new Promise((r) => setImmediate(r));
  release();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(runStream.calls, ['codemie install gemini']);
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
  slot.children[0].onclick({ stopPropagation() {} });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.doesNotMatch(c.getLastAgents().find((a) => a.command === 'gemini').actionMessage, /^> codemie install/);
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
    slot.children[0].onclick({ stopPropagation() {} });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(c.getLastAgents().find((a) => a.command === 'gemini').actionMessage, 'Installing needs a connection.', `expected ${errCode} to be treated as no-network`);
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
  assert.equal(seenLoadingText.some((t) => /Reading the tool list/.test(t)), false);
});

// Captured from a real failing run of `codemie install claude-acp --supported`.
// The CLI does not stop at its error: it prints the reason, then the whole
// list of available agents, then a tip. Taking the last line rendered
// "Tip: Run codemie install to see all agents" on the row, which says nothing
// about the failure.
const REAL_FAILURE = [
  ['- Installing Claude Code ACP v2.1.269 (supported version)...', 'stdout'],
  ['✖ Failed to install Claude Code ACP', 'stderr'],
  ['✗ Failed to install agent claude-acp: No installer URLs configured for native installation', 'stderr'],
  ['', 'stdout'],
  ['💡 Available agents:', 'stdout'],
  ['   • claude-acp', 'stdout'],
  ['   • gemini', 'stdout'],
  ['', 'stdout'],
  ['💡 Tip: Run codemie install to see all agents', 'stdout'],
];

test('a failure that keeps printing after its error shows the error, not the trailing tip', async () => {
  const container = makeEl('div');
  const runStream = fakeRunStream(REAL_FAILURE, 1);
  const c = createAgentsController({
    container,
    runCapture: fakeRunCapture(),
    runStream: runStream.fn,
    stepsUi: fakeStepsUi(),
  });
  await c.run();
  const slot = container.querySelector('.agent-actions[data-id="claude-acp"]');
  slot.children[0].onclick({ stopPropagation() {} });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  const row = c.getLastAgents().find((a) => a.command === 'claude-acp');
  assert.equal(row.actionMessage, 'Failed to install agent claude-acp: No installer URLs configured for native installation');
  assert.doesNotMatch(row.actionMessage, /Tip:|Available agents/);
});

// Captured from a real failing run: the app's own CLI, told to reach a registry
// that refuses connections (ui/test/fixtures/agents/install-no-registry.txt).
// The CLI prints its own two error lines and then ~40 lines of npm's raw dump,
// so the row must not end up showing the last line of that noise.
const noRegistry = readFileSync(new URL('fixtures/agents/install-no-registry.txt', import.meta.url), 'utf8')
  .split('\n')
  .filter(Boolean);

test('a real registry-unreachable failure reads as a connection problem, and Home is told the same', async () => {
  const container = makeEl('div');
  const stepsUi = fakeStepsUi();
  const c = createAgentsController({
    container,
    runCapture: async (cmd) => (cmd === 'codemie list'
      ? { code: 0, stdout: fixture, stderr: '' }
      : { code: 0, stdout: upToDateCheck, stderr: '' }),
    runStream: async (cmd, onLine) => {
      for (const line of noRegistry) onLine(line, 'stdout');
      return { code: 1 };
    },
    stepsUi,
  });
  await c.run();
  const result = await c.install({ name: 'Gemini CLI', command: 'gemini' });
  assert.deepEqual(result, { ok: false, message: 'Installing needs a connection.' });
  const message = c.getLastAgents().find((a) => a.command === 'gemini').actionMessage;
  assert.equal(message, 'Installing needs a connection.', 'the Agents screen settles on the same message');
  assert.ok(!message.includes('npm error'), "npm's raw dump never becomes the screen's message");
});

test('after an Update the row keeps the CLI\'s result line, and the next action clears it', async () => {
  const container = makeEl('div');
  const stepsUi = fakeStepsUi();
  const seenInPane = [];
  let lines = [['- Checking Gemini CLI for updates...', 'stdout'], ['⚠ Could not check Gemini CLI for updates', 'stdout']];
  const c = createAgentsController({
    container,
    runCapture: fakeRunCapture(fixture, openCodeUpdateCheck),
    runStream: async (cmd, onLine) => {
      for (const [t, tag] of lines) {
        onLine(t, tag);
        seenInPane.push(container.querySelector('.agent-pane')._text());
      }
      return { code: 0 };
    },
    stepsUi,
  });
  await c.run();
  c.select('opencode');
  container.querySelector('.agent-actions[data-id="opencode"]').children[0].onclick({ stopPropagation() {} });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  const row = () => c.getLastAgents().find((a) => a.command === 'opencode');
  assert.equal(row().actionMessage, 'Could not check Gemini CLI for updates');
  assert.notEqual(row().actionStatus, 'error');
  assert.ok(seenInPane.some((t) => t.includes('Checking Gemini CLI for updates...') && !t.includes('- Checking')), 'the "- " spinner frame is dropped');
  lines = [];
  container.querySelector('.agent-actions[data-id="opencode"]').children[0].onclick({ stopPropagation() {} });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(row().actionMessage, undefined);
});

test('an install that hits the CLI\'s time limit says so in minutes', async () => {
  const container = makeEl('div');
  const c = createAgentsController({
    container,
    runCapture: fakeRunCapture(),
    runStream: async (cmd, onLine) => {
      onLine('✗ Failed to install agent claude: Failed to install: Command timed out after 300000ms', 'stdout');
      onLine('💡 Tip: Run codemie install to see all agents', 'stdout');
      return { code: 1 };
    },
    stepsUi: fakeStepsUi(),
  });
  await c.run();
  container.querySelector('.agent-actions[data-id="gemini"]').children[0].onclick({ stopPropagation() {} });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(c.getLastAgents().find((a) => a.command === 'gemini').actionMessage, 'Took longer than 5 minutes. Check your connection and try again.');
});

// The echoed command flashed before the CLI's first line.
test('the echoed command never shows as the progress text', async () => {
  const container = makeEl('div');
  const seen = [];
  const c = createAgentsController({
    container,
    runCapture: fakeRunCapture(),
    runStream: async (cmd, onLine) => {
      onLine(`> ${cmd}`, 'prompt');
      seen.push(container.querySelector('.agent-pane')._text());
      onLine('- Installing Gemini CLI...', 'stdout');
      seen.push(container.querySelector('.agent-pane')._text());
      return { code: 0 };
    },
    stepsUi: fakeStepsUi(),
  });
  await c.run();
  c.select('gemini');
  container.querySelector('.agent-actions[data-id="gemini"]').children[0].onclick({ stopPropagation() {} });
  await new Promise((r) => setImmediate(r));
  assert.ok(!seen[0].includes('> codemie'), `no echoed command in ${seen[0]}`);
  assert.ok(seen[1].includes('Installing Gemini CLI...'));
  assert.ok(!seen[1].includes('- Installing'));
});

// ---- Selection and per-agent progress (EPMCDME-14655) ----

// An action held open on gemini, so the tests below can act mid-stream.
async function midStream({ lines = ['- Downloading gemini'], code = 0, stderr = [], preselect = true } = {}) {
  const container = makeEl('div');
  const stepsUi = fakeStepsUi();
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const c = createAgentsController({
    container,
    runCapture: fakeRunCapture(),
    runStream: async (cmd, onLine) => {
      for (const l of lines) onLine(l, 'stdout');
      await gate;
      for (const l of stderr) onLine(l, 'stderr');
      return { code };
    },
    stepsUi,
  });
  await c.run();
  if (preselect) c.select('gemini');
  container.querySelector('.agent-actions[data-id="gemini"]').children[0].onclick({ stopPropagation() {} });
  await new Promise((r) => setImmediate(r));
  const settle = async () => {
    release();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  };
  return { c, container, stepsUi, settle };
}
const renderSteps = (stepsUi) => stepsUi.calls.filter((x) => x[0] === 'renderSteps').length;
const paneText = (container) => container.querySelector('.agent-pane')._text();

test('a progress line redraws only the pane: the running row keeps ACTIVE and no list render happens', async () => {
  const m = await midStream();
  const before = renderSteps(m.stepsUi);
  assert.match(paneText(m.container), /Downloading gemini/);
  assert.equal(renderSteps(m.stepsUi), before, 'renderSteps not called by progress');
  const statuses = m.stepsUi.calls.filter((x) => x[0] === 'setStatus' && x[1] === 'gemini');
  assert.equal(statuses.at(-1)[2], 'ACTIVE');
  await m.settle();
});

test('selecting another row mid-stream leaves the running row and its disabled buttons alone', async () => {
  const m = await midStream();
  const before = m.stepsUi.calls.length;
  const renders = renderSteps(m.stepsUi);
  const runningButton = m.container.querySelector('.agent-actions[data-id="gemini"]').children[0];
  m.c.select('claude');
  assert.equal(renderSteps(m.stepsUi), renders, 'select does not render the list');
  assert.equal(m.stepsUi.calls.length, before, 'select touches no stepsUi');
  assert.equal(runningButton.disabled, true);
  assert.match(paneText(m.container), /codemie-claude/);
  assert.equal(m.container.querySelector('.step-row[data-id="claude"]').className.includes('selected'), true);
  assert.doesNotMatch(paneText(m.container), /Downloading gemini/, 'progress belongs to the row it came from');
  await m.settle();
});

test('starting an action opens its details under the row, so the progress is seen', async () => {
  const m = await midStream({ preselect: false });
  const row = m.container.querySelector('.step-row[data-id="gemini"]');
  assert.ok(row.nextSibling === m.container.querySelector('.agent-pane'), 'the details sit right under the gemini row');
  assert.equal(m.container.querySelector('.agent-pane').hidden, false);
  assert.match(paneText(m.container), /Downloading gemini/);
  await m.settle();
});

test('while its install runs the details say Installing, not the Not installed the list was read with', async () => {
  const m = await midStream();
  assert.match(paneText(m.container), /Installing…/);
  assert.doesNotMatch(paneText(m.container), /Not installed/);
  await m.settle();
  assert.doesNotMatch(paneText(m.container), /Installing…/);
});

test('once the CLI is done the details say it is being checked until the list is read again', async () => {
  const container = makeEl('div');
  let reads = 0;
  let releaseRead;
  const readGate = new Promise((r) => {
    releaseRead = r;
  });
  const c = createAgentsController({
    container,
    runCapture: async (cmd) => {
      if (cmd === 'codemie list' && ++reads === 2) await readGate;
      return fakeRunCapture()(cmd);
    },
    runStream: async (cmd, onLine) => {
      onLine('- Installing Gemini CLI...', 'stdout');
      return { code: 0 };
    },
    stepsUi: fakeStepsUi(),
  });
  await c.run();
  const done = c.install(c.getLastAgents().find((a) => a.command === 'gemini'));
  await new Promise((r) => setImmediate(r));
  const text = container.querySelector('.agent-pane')._text();
  assert.match(text, /Checking it installed…/);
  assert.doesNotMatch(text, /Installing Gemini CLI/, 'the finished progress line is gone');
  releaseRead();
  await done;
  assert.doesNotMatch(container.querySelector('.agent-pane')._text(), /Checking/);
});

test('a second click on the open row closes its details', async () => {
  const m = await midStream();
  await m.settle();
  m.c.select('gemini');
  assert.equal(m.container.querySelector('.agent-pane').hidden, true);
  assert.equal(m.container.querySelector('.step-row[data-id="gemini"]').className.includes('selected'), false);
});


test('the selection survives the reload an action ends with', async () => {
  const m = await midStream();
  await m.settle();
  assert.equal(m.container.querySelector('.agent-pane').hidden, false);
  assert.equal(m.container.querySelector('.step-row[data-id="gemini"]').className.includes('selected'), true);
  await m.c.refresh();
  assert.equal(m.container.querySelector('.step-row[data-id="gemini"]').className.includes('selected'), true);
});

test('progress is kept for its agent while the action runs and gone after', async () => {
  const m = await midStream();
  assert.match(paneText(m.container), /Downloading gemini/);
  await m.settle();
  assert.doesNotMatch(paneText(m.container), /Downloading gemini/);
});

test('a failed action leaves its plain-language failure in the pane after the silent reload', async () => {
  const m = await midStream({ code: 1, stderr: ['Error: getaddrinfo ENOTFOUND registry.npmjs.org'] });
  await m.settle();
  const block = m.container.querySelector('.agent-pane').querySelector('.failure-block');
  assert.ok(block);
  assert.match(block._text(), /Installing needs a connection\./);
});

test('a selected agent that is gone from the reloaded list closes the details, no throw', async () => {
  const container = makeEl('div');
  let list = fixture;
  const c = createAgentsController({
    container,
    runCapture: async (cmd) => ({ code: 0, stdout: cmd === 'codemie list' ? list : upToDateCheck, stderr: '' }),
    stepsUi: fakeStepsUi(),
  });
  await c.run();
  c.select('gemini');
  list = fixture.replace(/  Gemini CLI[\s\S]*?\n\n/, '');
  await assert.doesNotReject(c.refresh());
  assert.equal(container.querySelector('.agent-pane').hidden, true);
});

test('Home install still receives every line, echo included', async () => {
  const container = makeEl('div');
  const got = [];
  const c = createAgentsController({
    container,
    runCapture: fakeRunCapture(),
    runStream: async (cmd, onLine) => {
      onLine(`> ${cmd}`, 'prompt');
      onLine('- working', 'stdout');
      return { code: 0 };
    },
    stepsUi: fakeStepsUi(),
  });
  await c.run();
  const result = await c.install({ name: 'Gemini CLI', command: 'gemini' }, (t, tag) => got.push([t, tag]));
  assert.equal(result.ok, true);
  assert.deepEqual(got, [['> codemie install gemini', 'prompt'], ['- working', 'stdout']]);
});
