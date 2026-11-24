// Settings › Notifications' "Menu bar" card (menu-bar-count design `docs/superpowers/specs/
// 2026-11-24-menu-bar-count-design.md` §6, § Copy): the four switches, the status line, and the
// fixes list. `menuBarCard`/`statusLine`/`ROWS` are pure; `app.js`'s `menu-bar-toggle` and
// `menu-bar-fix` actions are exercised by the browser checks (the `menu-bar` set).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { menuBarCard, statusLine, ROWS } from '../workspace/menu-bar.js';
import { buildSnapshot, withMenuBar } from './fixtures/workspace-fixture.mjs';
import { attentionMessages } from '../workspace/selectors.js';

const NOW = Date.UTC(2026, 10, 24, 9);
const STATES = JSON.parse(readFileSync(new URL('./fixtures/contract/task-provider-states.json', import.meta.url), 'utf8'));
const REPLY_CASES = JSON.parse(readFileSync(new URL('./fixtures/contract/menu-bar-reply-cases.json', import.meta.url), 'utf8'));

test('the card offers four switches, only replies on by default', () => {
  const s = buildSnapshot(NOW, { zone: 'UTC', photo: false });
  const html = menuBarCard(s);
  assert.match(html, /<h2 class="ws-card-title">[^]*?Menu bar<\/h2>/);
  assert.match(html, /The number beside CodeMie Connect in the menu bar\. Choose what it counts\./);

  // The four titles, verbatim (spec § Copy).
  for (const [, title] of ROWS) assert.match(html, new RegExp(`<strong>${title.replace(/\./g, '\\.')}</strong>`));
  assert.match(html, /id="ws-mb-hint-replies">Needs reply and unacknowledged critical messages, as Inbox counts them\.<\/p>/);
  assert.match(html, /id="ws-mb-hint-meetings">Notes made since you last opened the meeting\.<\/p>/);
  assert.match(html, /id="ws-mb-hint-automations">Results since you last looked at Today or Automations\.<\/p>/);
  // Tasks names the active provider, "Connect" with none.
  assert.match(html, /id="ws-mb-hint-tasks">Your open tasks in Connect\.<\/p>/);
  const withProvider = menuBarCard({ ...s, taskProvider: STATES.ready });
  assert.match(withProvider, /id="ws-mb-hint-tasks">Your open tasks in Todoist\.<\/p>/);

  // Exactly one checked toggle, and it is replies.
  const checked = html.match(/<input [^>]*role="switch"[^>]*\schecked\b[^>]*>/g) || [];
  assert.equal(checked.length, 1);
  assert.match(checked[0], /data-source="replies"/);

  // Each toggle: aria-label its title, aria-describedby its own hint paragraph.
  for (const [key, title] of ROWS) {
    const [tag] = html.match(new RegExp(`<input [^>]*data-source="${key}"[^>]*>`));
    assert.match(tag, new RegExp(`aria-label="${title}"`));
    assert.match(tag, new RegExp(`aria-describedby="ws-mb-hint-${key}"`));
  }
});

test('the status line says what the number is made of', () => {
  const several = { count: 3, counted: ['replies', 'tasks'], sources: { replies: 2, tasks: 1, meetings: 0, automations: 0 } };
  const chosen = { replies: true, tasks: true, meetings: false, automations: false };
  assert.equal(statusLine(several, chosen), 'Now: 3 — 2 messages need a reply, 1 task due or late');

  const zero = { count: 0, counted: ['replies'], sources: { replies: 0, tasks: 0, meetings: 0, automations: 0 } };
  assert.equal(statusLine(zero, { replies: true, tasks: false, meetings: false, automations: false }), 'Now: nothing to count.');

  // Nothing chosen wins even when a source still carries a count.
  const nothingChosen = { count: 0, counted: [], sources: { replies: 2, tasks: 1, meetings: 1, automations: 2 } };
  assert.equal(
    statusLine(nothingChosen, { replies: false, tasks: false, meetings: false, automations: false }),
    'Nothing is counted. The icon still turns amber when something needs fixing.',
  );

  // The card draws it with role="status".
  const html = menuBarCard(buildSnapshot(NOW, { zone: 'UTC' }));
  assert.match(html, /<p class="ws-muted ws-hint" role="status">Now: 2 — 2 messages need a reply<\/p>/);
});

test('fixes are listed with a Fix button each', () => {
  const s = withMenuBar(buildSnapshot(NOW, { zone: 'UTC' }), 'amberWithCount');
  const html = menuBarCard(s);
  assert.match(html, /<strong>Needs fixing<\/strong>/);
  assert.match(html, /<ul><li class="ws-mb-fix">/);
  assert.match(html, /<li class="ws-mb-fix"><span>Todoist needs your API token\.<\/span>/);
  assert.match(html, /data-action="menu-bar-fix" aria-label="Fix: Todoist needs your API token\." data-fix="tasks-token"/);
  assert.match(html, /Amber means something needs fixing, such as a sign-in or a plugin token\. It can't be turned off\./);

  // Every fix text is escaped (an automation named '<b>x</b>').
  const xss = withMenuBar(buildSnapshot(NOW, { zone: 'UTC' }), 'amberWithCount');
  xss.menuBar = { ...xss.menuBar, fixes: [{ id: 'automation:a1', text: 'Automation <b>x</b> failed: boom', open: { route: 'automations' } }] };
  const xssHtml = menuBarCard(xss);
  assert.match(xssHtml, /<span>Automation &lt;b&gt;x&lt;\/b&gt; failed: boom<\/span>/);
  assert.doesNotMatch(xssHtml, /<b>x<\/b>/);
  assert.match(xssHtml, /aria-label="Fix: Automation &lt;b&gt;x&lt;\/b&gt; failed: boom"/);

  // No fixes: no "Needs fixing" section at all.
  const clean = menuBarCard(buildSnapshot(NOW, { zone: 'UTC' }));
  assert.doesNotMatch(clean, /Needs fixing/);
});

test('the reply count matches Inbox', () => {
  const base = buildSnapshot(NOW, { zone: 'UTC' });
  const { records, replies } = REPLY_CASES;
  assert.equal(attentionMessages({ ...base, records }).length, replies);
});

test('Default and Compact draw the same card', () => {
  const compact = buildSnapshot(NOW, { zone: 'UTC' });
  compact.settings.view = 'compact';
  const defaultView = buildSnapshot(NOW, { zone: 'UTC' });
  defaultView.settings.view = 'default';
  assert.equal(menuBarCard(compact), menuBarCard(defaultView));
});
