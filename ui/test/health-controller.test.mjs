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

const { createHealthController } = await import('../health-controller.js');

// CR-007: the wiring (stdout-tag filter, join, parse -> group -> render) must
// be exercised end-to-end, not just the two pure functions it calls.
test('CR-007: runHealthCheck pipeline renders only stdout-derived records', async () => {
  const container = makeEl('div');
  const seenCmd = [];
  const runStream = async (cmd, onLine) => {
    seenCmd.push(cmd);
    onLine('> codemie doctor', 'prompt');
    onLine('Node Version:', 'stdout');
    onLine('  ✓ v20.11.0 detected', 'stdout');
    onLine('', 'stdout');
    onLine('some noisy stderr the parser must never see', 'stderr');
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
});

// CR-006 continued: after a failed run, calling run() again (as the rendered
// retry button does) must actually attempt another doctor run.
test('CR-006: the rendered retry action runs another doctor check', async () => {
  const container = makeEl('div');
  let attempts = 0;
  const runStream = async (cmd, onLine) => {
    attempts += 1;
    if (attempts === 1) throw new Error('first attempt fails');
    onLine('Node Version:', 'stdout');
    onLine('  ✓ v20.11.0 detected', 'stdout');
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
    onLine('Node Version:', 'stdout');
    onLine('  ✓ v20.11.0 detected', 'stdout');
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
  assert.ok(container._innerText().includes("Can't read your log: log file missing"));
});
