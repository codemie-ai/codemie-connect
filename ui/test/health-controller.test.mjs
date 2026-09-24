// ui/test/health-controller.test.mjs
//
// health-controller.js is the wiring that used to live inline as renderer.js's
// runHealthCheck(): stream 'codemie doctor' -> filter to stdout -> join -> parse
// -> group -> render, plus the open-log failure path. It was split out so this
// wiring is testable without stubbing the whole app shell (renderer.js has no
// exports and touches `window.__TAURI__`/`document.getElementById` at module
// scope) — the controller only needs a container object, a runStream function
// and an openLog function, all supplied by the test.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── Minimal DOM stub, same shape as health-ui.test.mjs's makeEl ─────────────
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

const { createHealthController } = await import('../health-controller.js');

// CR-007: the wiring (stdout-tag filter, join, parse -> group -> render) must
// be exercised end-to-end, not just the two pure functions it calls.
test('CR-007: runHealthCheck pipeline renders only stdout-derived records', async () => {
  const container = makeEl('div');
  const seenCmd = [];
  const runStream = async (cmd, onLine) => {
    seenCmd.push(cmd);
    onLine('> codemie doctor', 'prompt');
    onLine('Node.js:', 'stdout');
    // Shaped like a failing item on purpose: if stderr reached the parser this
    // would become a record under Node.js and the count below would be 0 of 1.
    onLine('  ✗ some noisy stderr the parser must never see', 'stderr');
    onLine('  ✓ Version v22.23.2', 'stdout');
    onLine('', 'stdout');
    return { code: 0 };
  };
  const controller = createHealthController({ container, runStream, openLog: async () => {} });
  await controller.run();
  assert.deepEqual(seenCmd, ['codemie doctor']);
  assert.ok(container._innerText().includes('1 of 1 fine'));
  assert.ok(!container._innerText().includes('noisy stderr'));
});

// CR-004: nothing stopped a second doctor run from firing while the first was
// still in flight; the busy flag must make the second call a no-op.
test('CR-004: a second run() call while one is in flight is a no-op', async () => {
  const container = makeEl('div');
  let calls = 0;
  let resolveFirst;
  const runStream = async () => {
    calls += 1;
    await new Promise((r) => {
      resolveFirst = r;
    });
    return { code: 0 };
  };
  const controller = createHealthController({ container, runStream, openLog: async () => {} });
  const p1 = controller.run();
  const p2 = controller.run();
  assert.equal(calls, 1, 'runStream must not be invoked twice for two concurrent run() calls');
  resolveFirst();
  await Promise.all([p1, p2]);
  assert.equal(calls, 1);
});

// CR-005: an empty stdout run must not read as a genuine all-clear.
test('CR-005: zero stdout records render an explicit could-not-determine state, not 0 of 0', async () => {
  const container = makeEl('div');
  const runStream = async () => ({ code: 1 }); // no onLine calls at all
  const controller = createHealthController({ container, runStream, openLog: async () => {} });
  await controller.run();
  assert.ok(!container._innerText().includes('0 of 0'));
  assert.ok(container._innerText().toLowerCase().includes('could not'));
  assert.ok(container._findButton('Check everything again'), 'a retry action must be offered');
  assert.equal(controller.getLastResult(), null);
});

// CR-006: a rejected runStream must not leave the screen stuck on
// "Checking..." forever, and must not permanently consume the caller's
// one-shot auto-run guard.
test('CR-006: a runStream rejection renders a retry action instead of hanging, and reports failure', async () => {
  const container = makeEl('div');
  let failureNotified = false;
  const runStream = async () => {
    throw new Error('doctor not found');
  };
  const controller = createHealthController({
    container,
    runStream,
    openLog: async () => {},
    onFailure: () => {
      failureNotified = true;
    },
  });
  await controller.run();
  assert.ok(!container._innerText().includes('Checking'));
  assert.ok(container._innerText().includes('doctor not found'));
  assert.ok(container._findButton('Check everything again'), 'a retry action must be rendered');
  assert.ok(failureNotified, 'onFailure must fire so the one-shot auto-run guard is not stuck forever');
  assert.equal(controller.getLastResult(), null);
});

// CR-006 continued: after a failed run, calling run() again (as the rendered
// retry button does) must actually attempt another doctor run.
test('CR-006: the rendered retry action runs another doctor check', async () => {
  const container = makeEl('div');
  let attempts = 0;
  const runStream = async (cmd, onLine) => {
    attempts += 1;
    if (attempts === 1) throw new Error('first attempt fails');
    onLine('Node.js:', 'stdout');
    onLine('  ✓ Version v22.23.2', 'stdout');
    return { code: 0 };
  };
  const controller = createHealthController({ container, runStream, openLog: async () => {} });
  await controller.run();
  container._findButton('Check everything again')._click();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(attempts, 2);
  assert.ok(container._innerText().includes('1 of 1 fine'));
});

// CR-008: a rejected open_log must surface through showLogError, never a
// silent no-op.
test("CR-008: an open_log rejection surfaces through showLogError, not silently", async () => {
  const container = makeEl('div');
  const runStream = async (cmd, onLine) => {
    onLine('Node.js:', 'stdout');
    onLine('  ✓ Version v22.23.2', 'stdout');
    return { code: 0 };
  };
  const openLog = async () => {
    throw new Error('log file missing');
  };
  const controller = createHealthController({ container, runStream, openLog });
  await controller.run();
  const logBtn = container._findButton("Open today's log");
  assert.ok(logBtn, "the Open today's log button must be rendered");
  logBtn._click();
  await new Promise((r) => setTimeout(r, 0)); // let the rejected openLog() settle
  assert.ok(container._innerText().includes('CodeMie cannot open your log'));
  assert.ok(container._innerText().includes('log file missing'));
});

test('a log that opens clears an earlier "cannot open your log"', async () => {
  const container = makeEl('div');
  const runStream = async (cmd, onLine) => {
    onLine('Node.js:', 'stdout');
    onLine('  ✓ Version v22.23.2', 'stdout');
    return { code: 0 };
  };
  let attempts = 0;
  const openLog = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('log file missing');
  };
  const controller = createHealthController({ container, runStream, openLog });
  await controller.run();
  container._findButton("Open today's log")._click();
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(container._innerText().includes('CodeMie cannot open your log'));
  container._findButton("Open today's log")._click();
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(!container._innerText().includes('CodeMie cannot open your log'));
});

// The whole pipeline over real CLI output: what run_stream delivers line by
// line, stderr spinner included, ends up as the grouped screen.
test('real doctor output renders grouped, counted and stamped with the injected clock', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const raw = readFileSync(fileURLToPath(new URL('fixtures/doctor/sso-expired.txt', import.meta.url)), 'utf8');
  const container = makeEl('div');
  const runStream = async (cmd, onLine) => {
    onLine('- Checking Node.js...', 'stderr');
    raw.split('\n').forEach((line) => onLine(line, 'stdout'));
    return { code: 1 };
  };
  const checkedAt = new Date(2026, 8, 21, 9, 30);
  const controller = createHealthController({ container, runStream, openLog: async () => {}, now: () => checkedAt });
  await controller.run();
  const text = container._innerText();
  const clock = checkedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  assert.ok(text.includes(`6 of 8 fine · checked at ${clock}`));
  assert.ok(text.includes('Your CodeMie account'));
  assert.ok(text.includes('SSO credentials not found'));
  assert.ok(container._findButton('Sign in again'));
  assert.ok(!text.includes('Checking Node.js'));
});

test('getLastResult() is null before any run', async () => {
  const container = makeEl('div');
  const runStream = async () => ({ code: 0 });
  const controller = createHealthController({ container, runStream, openLog: async () => {} });
  assert.equal(controller.getLastResult(), null);
});

test('getLastResult() returns the rendered result after a successful run', async () => {
  const container = makeEl('div');
  const runStream = async (cmd, onLine) => {
    onLine('Node.js:', 'stdout');
    onLine('  ✓ Version v22.23.2', 'stdout');
    return { code: 0 };
  };
  const checkedAt = new Date(2026, 8, 21, 9, 30);
  const controller = createHealthController({ container, runStream, openLog: async () => {}, now: () => checkedAt });
  await controller.run();
  const result = controller.getLastResult();
  assert.ok(result);
  assert.equal(result.checkedAt, checkedAt);
  assert.ok(Array.isArray(result.rows));
  assert.ok(result.summary);
});

test('onResult is invoked with the rendered result after a successful run', async () => {
  const container = makeEl('div');
  const runStream = async (cmd, onLine) => {
    onLine('Node.js:', 'stdout');
    onLine('  ✓ Version v22.23.2', 'stdout');
    return { code: 0 };
  };
  let seen;
  const controller = createHealthController({
    container,
    runStream,
    openLog: async () => {},
    onResult: (r) => {
      seen = r;
    },
  });
  await controller.run();
  assert.deepEqual(seen, controller.getLastResult());
});

test('"Sign in again" runs the app sign-in, then checks again', async () => {
  const container = makeEl('div');
  const order = [];
  let runs = 0;
  const runStream = async (cmd, onLine) => {
    runs += 1;
    order.push(`doctor ${runs}`);
    onLine('CodeMie SSO Provider:', 'stdout');
    if (runs === 1) {
      onLine('  ✗ SSO credentials not found', 'stdout');
      onLine('      Run: codemie profile login', 'stdout');
    } else {
      onLine('  ✓ Provider operational', 'stdout');
    }
    return { code: 0 };
  };
  const signIn = async () => {
    order.push('sign in');
  };
  const controller = createHealthController({ container, runStream, openLog: async () => {}, signIn });
  await controller.run();
  container._findButton('Sign in again')._click();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(order, ['doctor 1', 'sign in', 'doctor 2']);
  assert.ok(container._innerText().includes('1 of 1 fine'));
});
