// Connect's terminal dock without the DOM (ui/workspace/terminal-model.js): its tabs, the output a
// tab still has to write, Mac keys, links, colours and what an ended session says.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTerminalModel, clampHeight, endedText, keySequence, dockShortcut, linksIn, xtermTheme, bytesOf,
  MIN_HEIGHT, PAGE_LEFT, DEFAULT_HEIGHT,
} from '../workspace/terminal-model.js';
import { terminalButton } from '../workspace/shell.js';

const info = (id, extra = {}) => ({
  id, key: `plugin:obsidian:/Users/taylor/${id}`, title: id, detail: 'Knowledge', program: 'Claude Code', folder: `/Users/taylor/${id}`,
  running: true, code: null, resumable: true, generation: 1, theme: 'dark', ...extra,
});
const key = (k, mods = {}) => ({ type: 'keydown', key: k, code: mods.code || '', metaKey: false, altKey: false, shiftKey: false, ctrlKey: false, isComposing: false, ...mods });

test('tabs open in order, the first is shown, and closing one shows its neighbour', () => {
  const m = createTerminalModel();
  assert.equal(m.upsert(info('t1')), true);
  assert.equal(m.upsert(info('t2')), true);
  assert.equal(m.upsert(info('t3')), true);
  assert.equal(m.active(), 't1');
  assert.equal(m.upsert(info('t2', { title: 'renamed' })), false, 'known');
  assert.deepEqual(m.list().map(i => i.title), ['t1', 'renamed', 't3']);
  assert.equal(m.select('t2'), 't2');
  assert.equal(m.select('nope'), 't2');
  assert.equal(m.remove('t2'), 't3', 'the next one');
  assert.equal(m.remove('t3'), 't1', 'else the one before');
  assert.equal(m.remove('t1'), null);
  assert.equal(m.size(), 0);
});

test('an ended program marks its tab, but only for the start it belongs to', () => {
  const m = createTerminalModel();
  m.upsert(info('t1', { generation: 2 }));
  assert.equal(m.running(), 1);
  assert.equal(m.ended('t1', 1, 0), false, 'an older start');
  assert.equal(m.get('t1').running, true);
  assert.equal(m.ended('t1', 2, 130), true);
  assert.deepEqual([m.get('t1').running, m.get('t1').code], [false, 130]);
  assert.equal(m.running(), 0);
  assert.equal(m.ended('gone', 1, 0), false);
});

test('output already written is skipped, overlapping output is cut, another start is ignored', () => {
  const m = createTerminalModel();
  // The tab drew 100 kept bytes from the list; events that raced the list come after.
  m.upsert(info('t1'), 100);
  assert.equal(m.accept('t1', 1, 40, 60), null, 'all in the list already');
  assert.deepEqual(m.accept('t1', 1, 90, 20), { from: 10 }, 'the last ten are new');
  assert.deepEqual(m.accept('t1', 1, 110, 5), { from: 0 });
  assert.equal(m.accept('t1', 2, 0, 5), null, 'a start the tab hasn’t heard of');
  // Started again: a fresh output from zero.
  m.upsert(info('t1', { generation: 2 }));
  assert.deepEqual(m.accept('t1', 2, 0, 5), { from: 0 });
  assert.equal(m.accept('t1', 1, 115, 5), null, 'the old start’s late output');
  assert.equal(m.accept('nope', 1, 0, 1), null);
});

test('the dock keeps a usable height and leaves room for the page', () => {
  assert.equal(clampHeight(50, 900), MIN_HEIGHT);
  assert.equal(clampHeight(5000, 900), 900 - PAGE_LEFT);
  assert.equal(clampHeight(321.6, 900), 322);
  assert.equal(clampHeight(NaN, 900), DEFAULT_HEIGHT);
  assert.equal(clampHeight(400, 200), MIN_HEIGHT, 'a tiny window still shows the terminal');
});

test('an ended session says what happened and what to do next', () => {
  assert.deepEqual(endedText(info('t1', { running: false, code: 0 })), { title: 'Claude Code ended', detail: 'Start again to go on with the conversation.', tone: 'quiet' });
  assert.deepEqual(endedText(info('t1', { running: false, code: 1, resumable: false, program: 'Gemini CLI' })), { title: 'Gemini CLI stopped (exit 1)', detail: 'Start it again when you need it.', tone: 'warning' });
  const missing = endedText(info('t1', { running: false, code: 127 }));
  assert.equal(missing.title, 'Connect couldn’t find Claude Code on this Mac');
  assert.equal(missing.detail, 'Install it in Settings → AI, then start again.');
  assert.equal(missing.tone, 'error');
  assert.match(endedText(info('t1', { code: 127, program: 'Codex' })).detail, /Settings → CodeMie/);
});

test('Mac editing keys send what a Mac terminal sends', () => {
  assert.equal(keySequence(key('Enter', { shiftKey: true })), '\x1b\r', 'a new line in Claude Code’s prompt');
  assert.equal(keySequence(key('Enter', { altKey: true })), '\x1b\r');
  assert.equal(keySequence(key('Enter')), null, 'Enter sends');
  assert.equal(keySequence(key('Enter', { metaKey: true, shiftKey: true })), null);
  assert.equal(keySequence(key('ArrowLeft', { altKey: true })), '\x1bb');
  assert.equal(keySequence(key('ArrowRight', { altKey: true })), '\x1bf');
  assert.equal(keySequence(key('Backspace', { altKey: true })), '\x17');
  assert.equal(keySequence(key('ArrowLeft', { metaKey: true })), '\x01');
  assert.equal(keySequence(key('ArrowRight', { metaKey: true })), '\x05');
  assert.equal(keySequence(key('Backspace', { metaKey: true })), '\x15');
  assert.equal(keySequence(key('c', { ctrlKey: true })), null, 'Ctrl+C is xterm’s');
  assert.equal(keySequence(key('Escape')), null);
  assert.equal(keySequence(key('Enter', { shiftKey: true, isComposing: true })), null, 'an IME composing');
  assert.equal(keySequence({ ...key('Enter', { shiftKey: true }), type: 'keyup' }), null);
});

test('the dock’s own shortcuts', () => {
  assert.equal(dockShortcut(key('c', { metaKey: true }), true), 'copy');
  assert.equal(dockShortcut(key('c', { metaKey: true }), false), null, 'nothing selected');
  assert.equal(dockShortcut(key('k', { metaKey: true }), false), 'clear');
  assert.equal(dockShortcut(key('a', { metaKey: true }), false), 'selectAll');
  assert.equal(dockShortcut(key('`', { ctrlKey: true, code: 'Backquote' }), false), 'toggle');
  assert.equal(dockShortcut(key('v', { metaKey: true }), false), null, 'paste is the browser’s');
  assert.equal(dockShortcut(key('k', { metaKey: true, altKey: true }), false), null);
});

test('links: https addresses in a line, without trailing punctuation', () => {
  assert.deepEqual(linksIn('See https://docs.claude.com/en/docs. Then go.'), [{ start: 4, end: 35, url: 'https://docs.claude.com/en/docs' }]);
  assert.deepEqual(linksIn('(https://example.com/a)').map(l => l.url), ['https://example.com/a']);
  assert.deepEqual(linksIn('https://en.wikipedia.org/wiki/Echo_(app), next').map(l => l.url), ['https://en.wikipedia.org/wiki/Echo_(app)']);
  assert.deepEqual(linksIn('two: https://a.io and https://b.io/x?y=1'), [
    { start: 5, end: 17, url: 'https://a.io' },
    { start: 22, end: 40, url: 'https://b.io/x?y=1' },
  ]);
  assert.deepEqual(linksIn('http://plain.io file:///etc/hosts https://'), [], 'https only');
});

test('colours follow Claude Code’s own theme in Connect’s palette', () => {
  const dark = xtermTheme('dark');
  const light = xtermTheme('light');
  assert.equal(dark.foreground, '#ECEAE8');
  assert.equal(light.background, '#FFFFFF');
  assert.equal(xtermTheme('anything').background, dark.background, 'dark is Claude Code’s default');
  // On white, "white" and "bright white" text stays readable.
  for (const c of [light.white, light.brightWhite, light.foreground]) assert.match(c, /^#[0-6]/);
  for (const t of [dark, light]) {
    for (const k of ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']) {
      assert.ok(t[k] && t[`bright${k[0].toUpperCase()}${k.slice(1)}`], k);
    }
  }
});

test('output bytes come from base64', () => {
  assert.deepEqual([...bytesOf(btoa('hi\x1b[0m'))], [104, 105, 27, 91, 48, 109]);
  assert.deepEqual([...bytesOf('')], []);
});

test('the topbar shows a Terminal button once a session opened, with a count while the dock is hidden', () => {
  const hidden = terminalButton({ count: 2, running: 1, shown: false });
  assert.match(hidden, /data-action="terminal-toggle"/);
  assert.match(hidden, /aria-pressed="false"/);
  assert.match(hidden, /aria-label="Terminal: 2 sessions, 1 running"/);
  assert.match(hidden, /<span class="ws-term-count" aria-hidden="true">1<\/span>/);
  const shown = terminalButton({ count: 1, running: 1, shown: true });
  assert.match(shown, /aria-pressed="true"/);
  assert.doesNotMatch(shown, /ws-term-count/, 'no count over an open dock');
  assert.match(terminalButton({ count: 1, running: 0, shown: false }), /aria-label="Terminal: 1 session"/);
});
