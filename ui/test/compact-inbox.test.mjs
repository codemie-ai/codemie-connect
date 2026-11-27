// Compact Inbox (spec docs/superpowers/specs/2026-11-22-compact-view-design.md, "Compact Inbox"):
// one list, rows open in place, selected and open kept apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clickRow, enterRow, escRow, nextAfter, followOpen, retrySource } from '../workspace/inbox-open.js';
import { inbox } from '../workspace/view-inbox.js';
import { buildSnapshot } from './fixtures/workspace-fixture.mjs';
import { draftKeyOf } from '../workspace/selectors.js';

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

test('a retry runs for the row that holds its button, not for the selection', () => {
  // Compact: row A open, the selection moved to B with j/k, Retry clicked in A's reply or summary.
  assert.equal(retrySource({ sourceId: null, rowId: 'A', compact: true, selected: 'B', open: 'A' }), 'A');
  // No row to read: the open message in Compact, the selected one in Default.
  assert.equal(retrySource({ sourceId: null, rowId: null, compact: true, selected: 'B', open: 'A' }), 'A');
  assert.equal(retrySource({ sourceId: null, rowId: null, compact: false, selected: 'B', open: 'A' }), 'B');
  // The job's own request wins.
  assert.equal(retrySource({ sourceId: 'C', rowId: 'A', compact: true, selected: 'B', open: 'A' }), 'C');
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

/** The reply bar of `html` (the first one), and its top-level controls (a menu counts once). */
const replyBarOf = html => html.match(/<div class="ws-reply-bar"[^]*?<span class="ws-reply-status"[^>]*>[^<]*<\/span><\/div>/)?.[0] || '';
const topControls = bar => bar.replace(/<div class="ws-menu-panel"[^]*?<\/div><\/details>/g, '</details>').match(/<button\b|<details\b/g) || [];

test('the open row: summary, thread, then the reply form with its three-control bar', () => {
  const s = buildSnapshot(Date.now(), { photo: false });
  const html = inbox(s, ctx({ lane: 'critical', selectedMessage: 'm-critical', openMessage: 'm-critical' }));
  assert.match(html, /aria-expanded="true" aria-controls="crow-m-critical"/);
  assert.match(html, /<div class="ws-crow-body" id="crow-m-critical" data-message-id="m-critical">/);
  assert.match(html, /class="ws-thread ws-thread-compact"[^]*?<form class="ws-reply[^]*?class="ws-reply-bar"/);
  assert.doesNotMatch(html, /ws-crow-actions/);
  assert.equal([...html.matchAll(/id="reply-body"/g)].length, 1);
  const bar = replyBarOf(html);
  assert.equal(topControls(bar).length, 3, bar);
  // Acknowledge takes Snooze's place on the line; Snooze goes under ⋯.
  const more = bar.slice(bar.indexOf('data-menu="reply-more"'));
  assert.match(bar.slice(0, bar.indexOf('data-menu="reply-more"')), /data-action="message-ack"/);
  assert.match(more, /data-action="message-snooze"/);
  assert.doesNotMatch(more, /message-ack/);
  // ⋯ in its order: Done, Snooze ▸ and its presets, Draft options…, Reply in Outlook ↗ (no
  // permission to send), Move to lane, Add a task.
  assert.match(more, /data-action="message-archive"[^]*?>Snooze<[^]*?data-action="message-snooze"[^]*?data-action="ai-draft-options"[^]*?Reply in Outlook ↗[^]*?data-action="message-lane"[^]*?data-action="commitment"/);
  // Acknowledged: Snooze is back on the line, no Acknowledge.
  s.records.find(r => r.id === 'm-critical').data.acknowledgedAt = 1;
  const acked = replyBarOf(inbox(s, ctx({ lane: 'critical', selectedMessage: 'm-critical', openMessage: 'm-critical' })));
  assert.doesNotMatch(acked, /data-action="message-ack"/);
  assert.equal(topControls(acked).length, 3, acked);
  assert.doesNotMatch(acked.slice(acked.indexOf('data-menu="reply-more"')), /message-snooze/);
});

test('Default and Compact draw the same reply bar', () => {
  const s = buildSnapshot(Date.now(), { photo: false });
  const def = replyBarOf(inbox(s, ctx({ selectedMessage: 'c-reply-1' }, 'default')));
  const compact = replyBarOf(inbox(s, ctx({ selectedMessage: 'c-reply-1', openMessage: 'c-reply-1' })));
  assert.ok(def, 'Default draws a reply bar');
  assert.equal(def, compact);
  assert.doesNotMatch(inbox(s, ctx({ selectedMessage: 'c-reply-1' }, 'default')), /ws-read-actions/);
});

test('after a send the status line says where it went, with a link to the conversation; a failure reads as an error', () => {
  const s = buildSnapshot(Date.now(), { photo: false });
  const key = draftKeyOf(s.records.find(r => r.id === 'c-reply-1'));
  const sent = inbox(s, ctx({ selectedMessage: 'c-reply-1', openMessage: 'c-reply-1', replyStatus: { [key]: { text: 'Sent to Jordan.', url: 'https://teams.microsoft.com/l/message/fixture' } } }));
  assert.match(sent, /<span class="ws-reply-status" role="status">Sent to Jordan\. <button type="button" class="ws-link" data-action="source" data-kind="message" data-id="c-reply-1">Open in Teams ↗<\/button><\/span>/);
  const mail = inbox(s, ctx({ selectedMessage: 'm-reply-1', openMessage: 'm-reply-1', replyStatus: { 'm-reply-1': { text: 'Sent to Priya.', url: 'https://outlook.office.com/mail/fixture' } } }));
  assert.match(mail, /Sent to Priya\. <button[^>]*data-action="source"[^>]*data-id="m-reply-1">Open in Outlook ↗</);
  const failed = inbox(s, ctx({ selectedMessage: 'c-reply-1', openMessage: 'c-reply-1', replyStatus: { [key]: { text: 'Allow replies in <Settings> first.', tone: 'error' } } }));
  assert.match(failed, /<span class="ws-reply-status ws-reply-status-error" role="status">Allow replies in &lt;Settings&gt; first\.<\/span>/);
  assert.match(inbox(s, ctx({ selectedMessage: 'c-reply-1', openMessage: 'c-reply-1', replyStatus: { [key]: 'Sending…' } })), /<span class="ws-reply-status" role="status">Sending…<\/span>/);
});

test('the empty box offers ✦ draft with AI; text brings the change line', () => {
  const s = buildSnapshot(Date.now(), { photo: false });
  const empty = inbox(s, ctx({ selectedMessage: 'c-reply-1', openMessage: 'c-reply-1' }));
  assert.match(empty, /Write a reply, or <\/span><button[^>]*data-action="ai-draft-quick"[^>]*>✦ draft with AI/);
  assert.match(empty, /<div class="ws-reply-hint" id="reply-hint">/);
  assert.match(empty, /<textarea id="reply-body"[^>]*aria-describedby="reply-hint"/);
  assert.doesNotMatch(empty, /<textarea id="reply-body"[^>]*placeholder/);
  assert.doesNotMatch(empty, /reply-change/);
  s.records.push({ id: 'd-hi', kind: 'draft', source: 'local', connectionId: null, workspaceId: 'personal', revision: 'r-d-hi', updatedAt: 1, data: { text: 'Hi', sourceId: 'c-reply-1' } });
  const typed = inbox(s, ctx({ selectedMessage: 'c-reply-1', openMessage: 'c-reply-1' }));
  assert.match(typed, /<div class="ws-reply-hint" id="reply-hint" hidden>/);
  assert.doesNotMatch(typed, /<textarea id="reply-body"[^>]*aria-describedby/);
  assert.match(typed, /<input[^>]*id="reply-change"[^>]*placeholder="✦ Tell AI what to change"/);
  assert.match(typed, /data-action="ai-draft-change"[^>]*>(?:(?!<\/button>).)*Change</);
});

test('no Save draft, no Draft with AI button, Draft options under ⋯', () => {
  const s = buildSnapshot(Date.now(), { photo: false });
  for (const view of ['default', 'compact']) {
    const html = inbox(s, ctx({ selectedMessage: 'c-reply-1', openMessage: 'c-reply-1' }, view));
    assert.doesNotMatch(html, /draft-save|ai-draft-options" [^>]*aria-haspopup="dialog"/);
    assert.doesNotMatch(html, />Draft with AI</);
    assert.match(html, /data-menu="reply-more"[^]*?data-action="ai-draft-options"[^>]*>[^]*?Draft options…/);
  }
});

test('your own Outlook message has no reply box and Done is the only primary', () => {
  const s = buildSnapshot(Date.now(), { photo: false });
  for (const view of ['default', 'compact']) {
    const html = inbox(s, ctx({ lane: 'fyi', selectedMessage: 'm-thread-mine', openMessage: 'm-thread-mine' }, view));
    assert.doesNotMatch(html, /id="reply-body"|data-form="reply"/);
    const bar = replyBarOf(html);
    assert.equal(topControls(bar).length, 3, bar);
    assert.match(bar, /^<div class="ws-reply-bar"[^>]*>\s*<button[^>]*class="ws-btn ws-btn-primary"[^>]*data-action="message-archive"/);
    const more = bar.slice(bar.indexOf('data-menu="reply-more"'));
    assert.doesNotMatch(more, /message-archive|ai-draft-options/);
    assert.doesNotMatch(bar, /reply-send|reply-copy/);
  }
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

// Today's open row offers Earlier before 12 messages, for a short widget (reply design ruling 20);
// the Compact Inbox is unchanged: no Earlier under 12, however short the pane.
test('a short thread (under 12) shows no Earlier in Compact Inbox', () => {
  const s = buildSnapshot(Date.now(), { photo: false });
  const html = inbox(s, ctx({ selectedMessage: 'c-reply-1', openMessage: 'c-reply-1' }));
  assert.equal([...html.matchAll(/class="ws-bubble[ "]/g)].length, 2, 'c-reply-1 + c-reply-1b');
  assert.doesNotMatch(html, /ws-thread-earlier/);
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
