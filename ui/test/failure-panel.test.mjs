// The app's shared failure panel. Guided setup uses it today; Home's broken
// profile and its npm warning are the same shape (01-home.png), so the contract
// is tested here rather than through any one screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderFailurePanel } from '../failure-panel.js';

function makeEl(tag) {
  const el = {
    _tag: tag, _children: [], className: '', textContent: '', style: {}, scrollTop: 0, scrollHeight: 999,
    appendChild(c) { c._parent = el; el._children.push(c); return c; },
    remove() { const p = el._parent; if (p) p._children = p._children.filter((c) => c !== el); },
    querySelector(sel) {
      const cls = sel.replace(/^\./, '');
      const walk = (n) => {
        for (const c of n._children ?? []) {
          if ((c.className ?? '').split(/\s+/).includes(cls)) return c;
          const found = walk(c);
          if (found) return found;
        }
        return null;
      };
      return walk(el);
    },
    classList: {
      _set: new Set(),
      add(c) { el.classList._set.add(c); },
      remove(c) { el.classList._set.delete(c); },
      contains(c) { return el.classList._set.has(c); },
      toggle(c, force) {
        if (force === true) el.classList._set.add(c);
        else if (force === false) el.classList._set.delete(c);
        else if (el.classList._set.has(c)) el.classList._set.delete(c);
        else el.classList._set.add(c);
      },
    },
    set onclick(fn) { el._click = fn; },
    get onclick() { return el._click; },
  };
  return el;
}
globalThis.document = { createElement: (tag) => makeEl(tag) };

const allText = (el) => [el.textContent ?? '', ...(el._children ?? []).map(allText)].join(' ');
const button = (block, label) => (block.querySelector('.failure-actions')?._children ?? []).find((b) => b.textContent === label);

test('an error carries the title, the explanation and the tool\'s own words', () => {
  const container = makeEl('div');
  renderFailurePanel(container, {
    title: 'Could not reach CodeMie',
    explanation: 'This is usually the VPN.',
    detail: 'Authentication timeout - no response received',
    raw: 'line one\nline two',
    command: 'codemie setup --force',
    primaryLabel: 'Try again',
  });
  const text = allText(container);
  assert.ok(text.includes('Could not reach CodeMie'));
  assert.ok(text.includes('This is usually the VPN.'));
  assert.ok(text.includes('Authentication timeout - no response received'));
});

test('the transcript is collapsed until asked for, and headed by its command', () => {
  const container = makeEl('div');
  const block = renderFailurePanel(container, { title: 'x', raw: 'the output', command: 'codemie doctor', primaryLabel: 'Try again' });
  const raw = block.querySelector('.failure-raw');
  assert.ok(raw.classList.contains('hidden'), 'collapsed by default');
  assert.ok(raw.textContent.startsWith('$ codemie doctor'), 'headed by the command');
  const details = button(block, 'Show details');
  details.onclick();
  assert.equal(raw.classList.contains('hidden'), false);
  assert.equal(details.textContent, 'Hide details', 'the label says what the next click does');
  details.onclick();
  assert.equal(raw.classList.contains('hidden'), true);
  assert.equal(details.textContent, 'Show details');
});

test('a detail identical to the title is not repeated', () => {
  const container = makeEl('div');
  const block = renderFailurePanel(container, { title: 'Ollama is not running', detail: 'Ollama is not running', raw: 'x' });
  assert.equal(block.querySelector('.failure-detail'), null);
});

test('a second failure replaces the first rather than stacking', () => {
  const container = makeEl('div');
  renderFailurePanel(container, { title: 'first', raw: 'a' });
  renderFailurePanel(container, { title: 'second', raw: 'b' });
  const blocks = container._children.filter((c) => c.className === 'failure-block');
  assert.equal(blocks.length, 1);
  assert.ok(allText(blocks[0]).includes('second'));
});

test('the primary action receives the block, so a caller can dismiss it', () => {
  const container = makeEl('div');
  let got = null;
  const block = renderFailurePanel(container, { title: 'x', raw: 'y', primaryLabel: 'Try again', onPrimary: (b) => { got = b; } });
  button(block, 'Try again').onclick();
  assert.equal(got, block);
});

// Home's npm warning: same shape, amber, and nothing to click.
test('a warning renders in the warning variant with no actions', () => {
  const container = makeEl('div');
  const block = renderFailurePanel(container, { variant: 'warning', title: 'Two copies of CodeMie on this computer', explanation: 'Your npm copy keeps working.' });
  assert.ok(block.querySelector('.failure-panel').className.includes('warning'));
  assert.equal(block.querySelector('.failure-actions'), null, 'a warning offers no actions');
});

test('a secondary action renders after the primary and receives the block', () => {
  const container = makeEl('div');
  let got = null;
  const block = renderFailurePanel(container, {
    title: 'x', raw: 'y', primaryLabel: 'Sign in again', secondaryLabel: 'Delete this profile', onSecondary: (b) => { got = b; },
  });
  const labels = block.querySelector('.failure-actions')._children.map((b) => b.textContent);
  assert.deepEqual(labels, ['Sign in again', 'Delete this profile', 'Show details']);
  button(block, 'Delete this profile').onclick();
  assert.equal(got, block);
});

test('a secondary action alone still renders the action row', () => {
  const container = makeEl('div');
  const block = renderFailurePanel(container, { title: 'x', secondaryLabel: 'Delete this profile' });
  assert.ok(button(block, 'Delete this profile'));
});

test('a disabled secondary action cannot be clicked', () => {
  const container = makeEl('div');
  const block = renderFailurePanel(container, { title: 'x', secondaryLabel: 'Deleting…', secondaryDisabled: true });
  assert.equal(button(block, 'Deleting…').disabled, true);
  const enabled = renderFailurePanel(makeEl('div'), { title: 'x', secondaryLabel: 'Delete' });
  assert.ok(!button(enabled, 'Delete').disabled);
});
