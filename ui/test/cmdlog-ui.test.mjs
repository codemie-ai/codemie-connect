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
  const block = body._children[0];
  assert.ok(block, 'block must be rendered for in-flight record');
  // meta span is the second child (index 1)
  const meta = block._children[1];
  assert.ok(meta, 'meta span must exist');
  assert.ok(!meta.textContent.includes('null'), `meta must not contain 'null', got: ${meta.textContent}`);
  assert.ok(meta.textContent.includes('running'), `meta must say 'running...', got: ${meta.textContent}`);
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
