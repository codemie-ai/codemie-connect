// Compact Inbox (spec docs/superpowers/specs/2026-11-22-compact-view-design.md, "Compact Inbox"):
// one list, rows open in place, selected and open kept apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clickRow, enterRow, escRow, nextAfter, followOpen } from '../workspace/inbox-open.js';
import { inbox } from '../workspace/view-inbox.js';
import { buildSnapshot } from './fixtures/workspace-fixture.mjs';

const ctx = (state = {}, view = 'compact') => ({
  state: { lane: 'reply', channel: 'all', search: '', showArchived: false, showSnoozed: false, inboxLimit: 200, selectedMessage: null, openMessage: null, threadAll: new Set(), ...state },
  auth: {}, hidden: new Set(), banners: '', view,
});

test('selected and open are separate: click opens, click again closes and keeps it selected', () => {
  assert.deepEqual(clickRow({ selected: 'a', open: null }, 'b'), { selected: 'b', open: 'b' });
  assert.deepEqual(clickRow({ selected: 'b', open: 'b' }, 'b'), { selected: 'b', open: null });
  assert.deepEqual(clickRow({ selected: 'b', open: 'b' }, 'c'), { selected: 'c', open: 'c' });
  assert.deepEqual(enterRow({ selected: 'c', open: null }), { selected: 'c', open: 'c' });
  assert.deepEqual(escRow({ selected: 'c', open: 'c' }), { selected: 'c', open: null });
});

test('after a row leaves, the next one is selected', () => {
  assert.equal(nextAfter(['a', 'b', 'c'], 'b'), 'c');
  assert.equal(nextAfter(['a', 'b', 'c'], 'c'), 'b');
  assert.equal(nextAfter(['a'], 'a'), null);
  assert.equal(nextAfter(['a', 'b'], 'zz'), null);
});

test('the open row follows its chat when a newer message arrives, and closes when it leaves', () => {
  const keyOf = m => m.key;
  // The chat's newest message replaced the row's id: the row stays open on that conversation.
  assert.deepEqual(followOpen([{ id: 'm1', key: 'mail' }, { id: 'c2', key: 'chat' }], { open: 'c1', openKey: 'chat' }, keyOf), { open: 'c2', openKey: 'chat' });
  // Same id still listed.
  assert.deepEqual(followOpen([{ id: 'c1', key: 'chat' }], { open: 'c1', openKey: 'chat' }, keyOf), { open: 'c1', openKey: 'chat' });
  // The conversation left the list.
  assert.deepEqual(followOpen([{ id: 'm1', key: 'mail' }], { open: 'c1', openKey: 'chat' }, keyOf), { open: null, openKey: null });
  // Nothing open stays nothing open.
  assert.deepEqual(followOpen([{ id: 'm1', key: 'mail' }], { open: null, openKey: null }, keyOf), { open: null, openKey: null });
});

test('Compact Inbox: one list, every row closed and one line, no reading pane', () => {
  const s = buildSnapshot(Date.now(), { photo: false });
  const html = inbox(s, ctx({ selectedMessage: 'm-reply-1' }));
  assert.match(html, /^<div class="ws-inbox-compact">/);
  assert.doesNotMatch(html, /ws-reader|Reading pane|ws-dock/);
  assert.doesNotMatch(html, /aria-expanded="true"|ws-msg-preview|ws-msg-avatar|ws-crow-body/);
  assert.match(html, /<div class="ws-inbox-items" role="list"/);
  assert.match(html, /<div class="ws-crow" role="listitem"><button type="button" class="ws-inbox-row ws-inbox-row-compact ws-selected[^"]*" data-action="select-message" data-id="m-reply-1" aria-expanded="false" aria-controls="crow-m-reply-1" aria-current="true">/);
  // Marks are icons with names: the attachment on Priya's roadmap mail, the flag on Elena's.
  assert.match(html, /title="Attachment" aria-label="Attachment"/);
  assert.match(html, /title="Flagged" aria-label="Flagged"/);
  // Jordan's chat shows its thread count.
  assert.match(html, /data-id="c-reply-1"[^]*?ws-thread-count[^>]*>2</);
  assert.equal([...html.matchAll(/aria-current="true"/g)].length, 1);
});

test('the open row: Done, Snooze, Acknowledge on an unacknowledged critical, ⋯, summary, thread, reply form', () => {
  const s = buildSnapshot(Date.now(), { photo: false });
  const html = inbox(s, ctx({ lane: 'critical', selectedMessage: 'm-critical', openMessage: 'm-critical' }));
  assert.match(html, /aria-expanded="true" aria-controls="crow-m-critical"/);
  assert.match(html, /<div class="ws-crow-body" id="crow-m-critical">/);
  assert.match(html, /ws-crow-actions[^]*?data-action="message-archive"[^]*?message-snooze[^]*?data-action="message-ack"[^]*?data-menu="crow-more"/);
  // The ⋯ holds Open in Outlook, Move to lane and Add a task; Acknowledge stays outside it.
  const more = html.slice(html.indexOf('data-menu="crow-more"'));
  assert.match(more, /Open in Outlook[^]*?data-action="message-lane"[^]*?data-action="commitment"/);
  assert.doesNotMatch(more.slice(0, more.indexOf('</details>')), /message-ack/);
  assert.match(html, /class="ws-thread ws-thread-compact"[^]*?<form class="ws-reply/);
  assert.equal([...html.matchAll(/id="reply-body"/g)].length, 1);
  // Acknowledged: no Acknowledge button.
  s.records.find(r => r.id === 'm-critical').data.acknowledgedAt = 1;
  assert.doesNotMatch(inbox(s, ctx({ lane: 'critical', selectedMessage: 'm-critical', openMessage: 'm-critical' })), /data-action="message-ack"/);
});

test('a thread longer than 12 shows Earlier until expanded', () => {
  const s = buildSnapshot(Date.now(), { photo: false });
  const first = s.records.find(r => r.id === 'c-reply-1b');
  for (let i = 0; i < 12; i++) s.records.push({ ...first, id: `c-old-${i}`, revision: `r-old-${i}`, data: { ...first.data, text: `older ${i}`, at: first.data.at - 600 * (i + 1), lane: 'fyi' } });
  const bubbles = html => [...html.matchAll(/class="ws-bubble[ "]/g)].length;
  const closed = inbox(s, ctx({ selectedMessage: 'c-reply-1', openMessage: 'c-reply-1' }));
  assert.equal(bubbles(closed), 12);
  assert.match(closed, /<button type="button" class="ws-thread-earlier" data-action="inbox-earlier" data-id="c-reply-1">Earlier<\/button>/);
  const all = inbox(s, ctx({ selectedMessage: 'c-reply-1', openMessage: 'c-reply-1', threadAll: new Set(['c-reply-1']) }));
  assert.equal(bubbles(all), 14);
  assert.doesNotMatch(all, /inbox-earlier/);
});

test('Default Inbox keeps the dock and the reading pane', () => {
  const s = buildSnapshot(Date.now(), { photo: false });
  const html = inbox(s, ctx({ selectedMessage: 'm-reply-1', openMessage: 'm-reply-1' }, 'default'));
  assert.match(html, /ws-dock/);
  assert.match(html, /aria-label="Reading pane"/);
  assert.match(html, /ws-msg-preview/);
  assert.match(html, /role="listbox"/);
  assert.doesNotMatch(html, /ws-inbox-compact|ws-crow/);
});
