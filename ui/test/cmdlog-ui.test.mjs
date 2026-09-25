// ui/test/cmdlog-ui.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── Stubs: must be in place before importing cmdlog-ui.js (which transitively
//    imports runner-bridge.js which reads window.__TAURI__ at module-init time) ──
let invokeImpl = async () => null;

globalThis.window = {
  isSecureContext: true,
  __TAURI__: {
    core: { invoke: async (cmd, args) => invokeImpl(cmd, args) },
    event: { listen: async () => () => {} },
  },
};

const clipboardCalls = [];
Object.defineProperty(globalThis, 'navigator', {
  value: { clipboard: { writeText: async (text) => { clipboardCalls.push(text); } } },
  writable: true,
  configurable: true,
});

// ── Minimal DOM stub ──────────────────────────────────────────────────────────
function makeEl(tag) {
  const el = {
    _tag: tag,
    _children: [],
    _listeners: {},
    id: '',
    dataset: {},
    textContent: '',
    open: false,
    classList: {
      _set: new Set(),
      remove(cls) { el.classList._set.delete(cls); },
      add(cls) { el.classList._set.add(cls); },
      has(cls) { return el.classList._set.has(cls); },
    },
    querySelector(sel) {
      if (sel === 'summary') return el._children.find(c => c._tag === 'summary') ?? null;
      return null;
    },
    appendChild(child) {
      child._parent = el;
      el._children.push(child);
      return child;
    },
    addEventListener(evt, fn) { el._listeners[evt] = fn; },
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return ''; },
    set() { el._children = []; },
  });
  return el;
}

const footer = makeEl('details');
footer.id = 'command-log-footer';
footer.classList._set.add('hidden');
const summary = makeEl('summary');
footer.appendChild(summary);

const body = makeEl('div');
body.id = 'command-log-body';
footer.appendChild(body);

globalThis.document = {
  getElementById(id) {
    if (id === 'command-log-footer') return footer;
    if (id === 'command-log-body') return body;
    if (id === 'cmdlog-copy-all') return summary._children.find(c => c.id === 'cmdlog-copy-all') ?? null;
    return null;
  },
  createElement(tag) { return makeEl(tag); },
  querySelector() { return null; },
};

// ── Import module under test ──────────────────────────────────────────────────
const { initCmdLog } = await import('../cmdlog-ui.js');

// ── Helpers ───────────────────────────────────────────────────────────────────
function resetFooter() {
  footer.classList._set.add('hidden');
  summary._children = [];
  body._children = [];
  footer._listeners = {};
}

// ── Tests ─────────────────────────────────────────────────────────────────────

// CR-006: initCmdLog DOM wiring
test('initCmdLog removes hidden class from footer', async () => {
  resetFooter();
  invokeImpl = async () => [];
  initCmdLog();
  assert.ok(!footer.classList._set.has('hidden'), 'hidden must be removed from footer');
});

test('initCmdLog appends copy-all button with correct id to summary', async () => {
  resetFooter();
  invokeImpl = async () => [];
  initCmdLog();
  const btn = summary._children.find(c => c.id === 'cmdlog-copy-all');
  assert.ok(btn, 'copy-all button must be appended to summary');
});

// CR-005: in-flight records render 'running...' not 'exit null'
test('_renderRecords shows running... for in-flight record with null exit_code', async () => {
  resetFooter();
  invokeImpl = async (cmd) => {
    if (cmd === 'cmdlog_list') return [
      { id: 'cmd-x', command: 'npm install', exit_code: null, duration_ms: null, raw_output: '' },
    ];
    return null;
  };
  initCmdLog();
  // Wait for the async _renderRecords to settle
  await new Promise(r => setTimeout(r, 10));
  const row = body._children[0];
  assert.ok(row, 'row must be rendered for in-flight record');
  // status indicator is the third child of <summary> (time, command, status)
  const summary = row._children[0];
  const status = summary._children[2];
  assert.ok(status, 'status indicator must exist');
  assert.ok(!status.textContent.includes('null'), `status must not contain 'null', got: ${status.textContent}`);
  assert.ok(status.textContent.includes('running'), `status must say 'running...', got: ${status.textContent}`);
});

test('_renderRecords shows a timestamp derived from start_time', async () => {
  resetFooter();
  invokeImpl = async (cmd) => {
    if (cmd === 'cmdlog_list') return [
      { id: 'cmd-t', command: 'codemie doctor', start_time: '2026-09-25T14:22:00.000Z', exit_code: 0, duration_ms: 100, raw_output: '' },
    ];
    return null;
  };
  initCmdLog();
  await new Promise(r => setTimeout(r, 10));
  const row = body._children[0];
  const summary = row._children[0];
  const time = summary._children[0];
  assert.ok(/^\d{2}:\d{2}$/.test(time.textContent), `time must be HH:MM, got: ${time.textContent}`);
});

test('_renderRecords shows an ok pill for exit code 0 and a failed pill otherwise', async () => {
  resetFooter();
  invokeImpl = async (cmd) => {
    if (cmd === 'cmdlog_list') return [
      { id: 'cmd-ok', command: 'codemie doctor', exit_code: 0, duration_ms: 50, raw_output: '' },
      { id: 'cmd-fail', command: 'codemie install gemini', exit_code: 1, duration_ms: 50, raw_output: 'ETIMEDOUT' },
    ];
    return null;
  };
  initCmdLog();
  await new Promise(r => setTimeout(r, 10));
  // newest-first: cmd-fail row is first
  const failStatus = body._children[0]._children[0]._children[2];
  const okStatus = body._children[1]._children[0]._children[2];
  assert.ok(failStatus.className.includes('log-badge-failed'), 'non-zero exit must render the failed badge');
  assert.equal(failStatus.textContent, 'failed');
  assert.ok(okStatus.className.includes('log-badge-ok'), 'exit 0 must render the ok badge');
  assert.equal(okStatus.textContent, 'ok');
});

test('_renderRecords puts raw output and the plain-language line in the row detail, beside each other', async () => {
  resetFooter();
  invokeImpl = async (cmd) => {
    if (cmd === 'cmdlog_list') return [
      { id: 'cmd-fail', command: 'codemie install gemini', exit_code: 1, duration_ms: 50, raw_output: 'npm error ETIMEDOUT' },
    ];
    return null;
  };
  initCmdLog();
  await new Promise(r => setTimeout(r, 10));
  const row = body._children[0];
  const detail = row._children[1];
  const raw = detail._children.find(c => c._tag === 'pre');
  assert.ok(raw, 'raw output block must be present');
  assert.equal(raw.textContent, 'npm error ETIMEDOUT');
  const shownAs = detail._children.find(c => c.className.includes('log-info'));
  assert.ok(shownAs, 'shown-as block must be present');
  assert.ok(shownAs.textContent.startsWith('Shown to the user as —'));
});

test('_renderRecords shows an error box when cmdlog.list() rejects', async () => {
  resetFooter();
  invokeImpl = async (cmd) => {
    if (cmd === 'cmdlog_list') throw new Error('store unavailable');
    return null;
  };
  initCmdLog();
  await new Promise(r => setTimeout(r, 10));
  const box = body._children[0];
  assert.ok(box, 'error box must be rendered');
  assert.ok(box.className.includes('log-box-error'), 'error box must carry log-box-error');
});

// CR-007: copy-all click handler integration
test('copy-all click handler calls navigator.clipboard.writeText with rendered record text', async () => {
  resetFooter();
  clipboardCalls.length = 0;
  invokeImpl = async (cmd) => {
    if (cmd === 'cmdlog_list') return [
      { id: 'cmd-1', command: 'echo hello', exit_code: 0, duration_ms: 100, raw_output: '' },
      { id: 'cmd-2', command: 'npm install', exit_code: 1, duration_ms: 200, raw_output: 'some error' },
    ];
    return null;
  };
  initCmdLog();
  await new Promise(r => setTimeout(r, 10));

  const btn = summary._children.find(c => c.id === 'cmdlog-copy-all');
  assert.ok(btn, 'copy-all button must exist before click');
  btn._listeners['click']?.();

  assert.equal(clipboardCalls.length, 1, 'writeText must be called once');
  assert.ok(clipboardCalls[0].includes('echo hello'), 'text must include first command');
  assert.ok(clipboardCalls[0].includes('npm install'), 'text must include second command');
  assert.ok(clipboardCalls[0].includes('some error'), 'text must include failure output');
});

test('copy-all copies every record (collapsed or not), full multi-line output included with real newlines', async () => {
  resetFooter();
  clipboardCalls.length = 0;
  invokeImpl = async (cmd) => {
    if (cmd === 'cmdlog_list') return [
      { id: 'cmd-1', command: 'codemie doctor', exit_code: 0, duration_ms: 300, raw_output: 'line1\nline2\nline3' },
      { id: 'cmd-2', command: 'npm install', exit_code: 1, duration_ms: 200, raw_output: 'boom' },
    ];
    return null;
  };
  initCmdLog();
  await new Promise(r => setTimeout(r, 10));
  // Neither row was expanded (no .open = true, no toggle event) — both stay collapsed.

  const btn = summary._children.find(c => c.id === 'cmdlog-copy-all');
  btn._listeners['click']?.();

  assert.equal(clipboardCalls.length, 1, 'writeText must be called once');
  const text = clipboardCalls[0];
  assert.ok(text.includes('codemie doctor'), 'text must include the collapsed success record');
  assert.ok(text.includes('npm install'), 'text must include the collapsed failed record');
  assert.ok(text.includes('line1\nline2\nline3'), 'multi-line output must keep its real newlines, not be flattened');
});
