// Settings › Your voice (reply voice design §5, §6, §11, § Copy, § Accessibility): the card drawn
// from the snapshot's `replyVoice` in every state voice-states.json names, the style card and
// instruction editors, the people index and the skill import preview. All pure: no DOM, no store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importPanel, nextVoiceImport, nextVoiceSave, scopeLabel, stateLine, voiceCard } from '../workspace/settings-voice.js';
import { settings } from '../workspace/view-settings.js';
import { agoLabel, formatDateTime } from '../workspace/format.js';
import { buildSnapshot, contractFixtures, voiceStates, withVoice } from './fixtures/workspace-fixture.mjs';

const NOW = Date.parse('2026-11-25T10:00:00Z');
const STATES = voiceStates();
const PREVIEW = contractFixtures().voiceImport;
const snap = name => withVoice(buildSnapshot(NOW, { photo: false, zone: 'UTC' }), name);
const draw = (name, ui = {}, edit = s => s) => voiceCard(edit(snap(name)), { now: NOW, ...ui });
/** The words a reader sees: tags dropped, entities read, spaces folded. */
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
/** The markup of the element carrying `attr` (up to its own closing tag of the same name). */
function part(html, attr) {
  const at = html.indexOf(attr);
  assert.ok(at >= 0, `${attr} is drawn`);
  const open = html.lastIndexOf('<', at);
  const tag = html.slice(open + 1).match(/^[a-z0-9]+/)[0];
  let depth = 0;
  const re = new RegExp(`<${tag}[\\s>]|</${tag}>`, 'g');
  re.lastIndex = open;
  for (let m; (m = re.exec(html));) {
    depth += m[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return html.slice(open, re.lastIndex);
  }
  return html.slice(open);
}
const allChecked = preview => Object.fromEntries(preview.items.map(i => [i.key, true]));
const COPY_TIME = formatDateTime(1764000000, 'UTC');

test('ready: radio Off and Knowledge, Knowledge checked, the state line, facts checked, style with its head, six instructions in order, People (3), privacy line', () => {
  const html = draw('ready');
  const provider = part(html, 'data-voice-provider');
  assert.match(provider, /^<fieldset/);
  assert.match(provider, /<legend[^>]*>Where your voice comes from<\/legend>/);
  assert.match(provider, /<input type="radio" name="voice-provider" value="off" data-change="voice-provider" data-provider="off" aria-describedby="ws-voice-state-off">/);
  assert.match(provider, /<input type="radio" name="voice-provider" value="plugin:knowledge" data-change="voice-provider" data-provider="plugin:knowledge" checked aria-describedby="ws-voice-state-plugin_knowledge">/);
  assert.match(provider, /id="ws-voice-state-off">Drafts use only the conversation\.</);
  assert.match(provider, /id="ws-voice-state-plugin_knowledge">Ready · 3 people · style card · 6 instructions</);
  assert.equal(stateLine(STATES.ready, STATES.ready.available[0]), 'Ready · 3 people · style card · 6 instructions');

  assert.match(html, /<input type="checkbox" data-voice-facts data-action="voice-facts" checked aria-describedby="ws-voice-facts-hint">/);
  assert.match(text(html), /Add facts from Knowledge Before each draft, Connect sends Knowledge the names, codes and amounts it finds in the message, never the message, and adds the notes it finds\./);
  assert.match(text(part(html, 'ws-voice-privacy')), /^Connect keeps a copy on this Mac and adds the parts that fit to each reply draft, including drafts automations make\. Facts are looked up for each draft and never kept\. It goes only to the AI profile that writes the draft: the one your Mail and Teams replies use \(Settings › AI\), or an automation's own\.$/);

  assert.equal(text(part(html, 'data-voice-style-head')), 'From your page people/me.md · edit it in Knowledge Prefers short replies and plain words.');
  assert.match(text(html), new RegExp(`Style card From 12 mail previews and 140 Teams messages · updated ${agoLabel('2026-11-24T09:00:00Z', 'UTC', NOW)}`));
  assert.match(part(html, 'data-voice-style>'), /Short and direct\.\n\n## Mail/);

  const ids = [...html.matchAll(/data-voice-rule="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(ids, ['to-priya-n-example-test', 'chat-platform-review', 'domain-bank-example-test', 'topic-budget-request', 'no-profile-teams', 'everyone']);
  const scopes = ids.map(id => text(part(html, `data-voice-rule="${id}"`)).split(/ (?:Short|Terse|Formal|Ask|Polite|Never)/)[0]);
  assert.deepEqual(scopes, ['To priya.n@example.test', 'In the chat “Platform review”', 'Anyone at bank.example.test · mail only', 'About “budget request”', 'Anyone without a profile · Teams only', 'Everyone']);
  assert.match(part(html, 'data-voice-rule="to-priya-n-example-test"'), /aria-label="Edit the instruction for priya\.n@example\.test"/);

  assert.match(text(html), /People \(3\)/);
  assert.match(text(part(html, 'data-voice-person="marek-novak"')), /^Marek Novak Teams only Profile$/);
  assert.match(text(part(html, 'data-voice-person="priya-n"')), /^Priya N\. priya\.n@example\.test Profile$/);
  assert.match(text(part(html, 'ws-voice-copy')), new RegExp(`^Connect's copy · refreshed ${agoLabel(1764000000, 'UTC', NOW)} Refresh now Delete Connect's copy$`));
});

test('every state from voice-states.json draws its copy', () => {
  const needs = draw('needsSetup');
  assert.match(text(needs), /Choose its folder in Knowledge first\./);
  assert.match(needs, /data-action="voice-setup"[^>]*>(?:(?!<\/button>).)*Set up in Knowledge/s);

  assert.match(text(draw('unavailable')), new RegExp(`Knowledge isn't answering\\. Drafts use Connect's copy from ${COPY_TIME}\\.`));

  const off = draw('pluginOff');
  assert.match(text(off), /Turned off in Settings › Plugins/);
  assert.match(off, /data-action="voice-turn-on"[^>]*>(?:(?!<\/button>).)*Turn on/s);

  assert.match(text(draw('loading')), /Starting Knowledge…/);

  const kept = draw('offWithCopy');
  assert.match(text(part(kept, 'ws-voice-copy')), new RegExp(`^Off\\. Connect still keeps a copy from ${COPY_TIME}\\. Delete Connect's copy$`));
  assert.doesNotMatch(kept, /data-action="voice-refresh"/);
  assert.doesNotMatch(kept, /data-voice-facts/, 'no facts row with Off');
  assert.match(kept, /value="off"[^>]*checked/);

  const plain = draw('off');
  assert.doesNotMatch(plain, /ws-voice-copy/);
  assert.doesNotMatch(plain, /data-voice-facts/);

  const noFacts = draw('noFacts');
  assert.match(noFacts, /<input type="checkbox" data-voice-facts data-action="voice-facts" disabled aria-describedby="ws-voice-facts-hint">/);
  assert.match(text(noFacts), /Add facts from Knowledge Knowledge doesn't look up facts\./);

  // Every state draws without throwing and keeps the privacy line.
  for (const name of Object.keys(STATES)) assert.match(draw(name), /ws-voice-privacy/, name);
  // No snapshot field at all (an older native) reads as Off.
  assert.match(voiceCard(buildSnapshot(NOW, { photo: false, zone: 'UTC' }), { now: NOW }), /value="off"[^>]*checked/);
});

test('a provider turned off or not available keeps the saved facts choice, disabled, and says drafts get no facts', () => {
  const off = draw('pluginOff');
  assert.match(off, /<input type="checkbox" data-voice-facts data-action="voice-facts" checked disabled aria-describedby="ws-voice-facts-hint">/);
  assert.equal(text(part(off, 'id="ws-voice-facts-hint"')), 'Knowledge is turned off, so drafts get no facts.');
  const away = draw('unavailable');
  assert.match(away, /<input type="checkbox" data-voice-facts data-action="voice-facts" checked disabled aria-describedby="ws-voice-facts-hint">/);
  assert.equal(text(part(away, 'id="ws-voice-facts-hint"')), "Knowledge isn't available, so drafts get no facts.");
  // A saved "off" stays unticked while held.
  const savedOff = draw('pluginOff', {}, s => { s.replyVoice.facts.on = false; return s; });
  assert.match(savedOff, /<input type="checkbox" data-voice-facts data-action="voice-facts" disabled aria-describedby="ws-voice-facts-hint">/);
  // Ready keeps it enabled with the normal hint.
  assert.match(draw('ready'), /<input type="checkbox" data-voice-facts data-action="voice-facts" checked aria-describedby="ws-voice-facts-hint">/);
});

test('the style head is read-only and Edit opens only the card text', () => {
  const html = draw('ready');
  const head = part(html, 'data-voice-style-head');
  assert.doesNotMatch(head, /<(?:input|textarea|button)|tabindex/);
  assert.match(html, /data-action="voice-edit-style"[^>]*>(?:(?!<\/button>).)*Edit/s);

  const editing = draw('ready', { style: { text: STATES.ready.style.text, error: null } });
  const area = editing.match(/<textarea[^>]*data-voice-input="style"[^>]*>([^<]*)<\/textarea>/);
  assert.ok(area, 'the editor is a textarea');
  assert.match(area[0], /aria-label="Style card"|id="ws-voice-style-text"/);
  assert.match(editing, /<label[^>]*for="ws-voice-style-text"[^>]*>Style card<\/label>/);
  assert.match(area[0], /maxlength="8000"/);
  assert.equal(area[1], STATES.ready.style.text.replace(/"/g, '&quot;'));
  assert.doesNotMatch(area[1], /Prefers short replies/, 'never the head');
  assert.match(editing, /data-action="voice-save-style"[^>]*>(?:(?!<\/button>).)*Save/s);
  assert.match(editing, /data-action="voice-cancel"[^>]*>(?:(?!<\/button>).)*Cancel/s);
  assert.doesNotMatch(editing, /data-action="voice-edit-style"/);

  // A refusal is shown beside the field.
  const refused = draw('ready', { style: { text: 'x', error: 'Keep the style card under 8,000 characters.' } });
  assert.match(refused, /<p class="ws-field-error" id="ws-voice-style-error" role="alert">Keep the style card under 8,000 characters\.<\/p>/);
  assert.match(refused, /data-voice-input="style"[^>]*aria-describedby="ws-voice-style-error"/);

  // No card yet: the empty line names the provider; a user-written card says so.
  assert.match(text(draw('ready', {}, s => { s.replyVoice.style = null; return s; })), /No style card yet\. Build one in Knowledge from the messages you sent\./);
  assert.match(text(draw('ready', {}, s => { s.replyVoice.style.basedOn = null; return s; })), /Written by you · updated /);
  assert.match(text(draw('ready', {}, s => { s.replyVoice.style.basedOn = { mail: 0, teams: 1 }; return s; })), /From 1 Teams message · updated /);
});

test('a read-only instruction shows its source and no Edit or Delete', () => {
  const html = draw('ready', {}, s => {
    Object.assign(s.replyVoice.rules.find(r => r.id === 'everyone'), { editable: false, source: 'Skills/reply-style/SKILL.md' });
    return s;
  });
  const row = part(html, 'data-voice-rule="everyone"');
  assert.match(text(row), /From Skills\/reply-style\/SKILL\.md · edit it in Knowledge/);
  assert.doesNotMatch(row, /voice-edit-rule|voice-delete-rule/);
  assert.match(part(html, 'data-voice-rule="topic-budget-request"'), /voice-edit-rule[^]*voice-delete-rule/);
});

test('every voice and skill string is escaped', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const html = draw('ready', {}, s => {
    const v = s.replyVoice;
    v.name = evil;
    v.available[0].name = evil;
    v.rules[0].text = evil;
    v.rules[0].applies.value = evil;
    v.style.text = evil;
    v.style.head.text = evil;
    v.style.head.source = evil;
    v.people[0].name = evil;
    v.people[0].addresses = [evil];
    return s;
  });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  const preview = structuredClone(PREVIEW);
  preview.folder = evil;
  preview.items[0].skill = evil;
  preview.items[0].text = evil;
  preview.skipped[0].skill = evil;
  preview.skipped[0].reason = evil;
  const panel = importPanel(preview, { checked: allChecked(preview) });
  assert.doesNotMatch(panel, /<img/);
  assert.match(panel, /&lt;img onerror|&lt;img src=x/);
});

test('the rule editor offers six kinds and Only in; the value field follows the kind', () => {
  const html = draw('ready', { rule: { id: null, scope: 'everyone', value: '', channel: '', text: '', error: null } });
  const kinds = part(html, 'data-change="voice-rule-kind"');
  assert.deepEqual([...kinds.matchAll(/<option value="([^"]*)"[^>]*>([^<]+)</g)].map(m => [m[1], text(m[2])]), [
    ['to', "A person's address"], ['chat', 'A Teams chat'], ['domain', 'Anyone at a domain'], ['topic', 'A topic'], ['no-profile', 'Anyone without a profile'], ['everyone', 'Everyone'],
  ]);
  const channels = part(html, 'data-voice-input="rule-channel"');
  assert.deepEqual([...channels.matchAll(/<option value="([^"]*)"[^>]*>([^<]+)</g)].map(m => [m[1], m[2]]), [['', 'Mail and Teams'], ['mail', 'Mail only'], ['teams', 'Teams only']]);
  assert.match(html, />Applies to</);
  assert.match(html, />Only in</);
  assert.match(html, />What to do</);
  assert.match(html, /data-voice-input="rule-text"[^>]*maxlength="2000"/);
  assert.doesNotMatch(html, /data-voice-input="rule-value"/, 'Everyone has no value');
  assert.doesNotMatch(draw('ready', { rule: { id: null, scope: 'no-profile', value: '', channel: '', text: '' } }), /data-voice-input="rule-value"/);
  for (const [scope, label] of [['to', 'Address'], ['chat', 'Chat title'], ['domain', 'Domain'], ['topic', 'Topic words']]) {
    const one = draw('ready', { rule: { id: null, scope, value: 'v', channel: '', text: '' } });
    assert.match(one, new RegExp(`<label[^>]*for="ws-voice-rule-value"[^>]*>${label}</label>`), scope);
    assert.match(one, /data-voice-input="rule-value"[^>]*value="v"/, scope);
  }
  // A refused field shows its sentence beside it.
  const refused = draw('ready', { rule: { id: null, scope: 'chat', value: '', channel: '', text: 'x', error: { field: 'applies', message: 'Say what the instruction applies to.' } } });
  assert.match(refused, /id="ws-voice-rule-applies-error" role="alert">Say what the instruction applies to\./);
  // Editing a row draws the editor in its place.
  const edit = draw('ready', { rule: { id: 'chat-platform-review', scope: 'chat', value: 'Platform review', channel: '', text: 'Terse, lower case.' } });
  assert.match(part(edit, 'data-voice-rule="chat-platform-review"'), /data-voice-input="rule-text"/);

  assert.deepEqual(nextVoiceSave({ rule: { id: null, scope: 'chat', value: ' Platform review ', channel: 'teams', text: ' Terse. ' } }),
    { kind: 'rule', id: null, applies: { kind: 'chat', value: 'Platform review', channel: 'teams' }, text: 'Terse.' });
  assert.deepEqual(nextVoiceSave({ rule: { id: 'everyone', scope: 'everyone', value: 'ignored', channel: '', text: 'Be brief.' } }),
    { kind: 'rule', id: 'everyone', applies: { kind: 'everyone' }, text: 'Be brief.' });
  assert.deepEqual(nextVoiceSave({ style: 'Terse.' }), { kind: 'style', text: 'Terse.' });

  assert.equal(scopeLabel({ kind: 'to', value: 'a@example.test', channel: 'mail' }), 'To a@example.test · mail only');
  assert.equal(scopeLabel({ kind: 'no-profile', channel: 'teams' }), 'Anyone without a profile · Teams only');
});

test('import: the preview with every row and every reason', () => {
  const html = importPanel(PREVIEW, { checked: allChecked(PREVIEW) });
  assert.match(html, /role="region" aria-labelledby="ws-voice-import-title"/);
  assert.match(html, /id="ws-voice-import-title" tabindex="-1">Import from skills · voice-skills</);
  assert.match(text(html), /Found 6 skills\. 8 instructions to add\./);
  const keys = [...html.matchAll(/data-voice-import-item="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(keys, PREVIEW.items.map(i => i.key));
  assert.match(text(part(html, 'data-voice-import-item="reply-style#3"')), /From reply-style · Kept 11 of 12 lines\./);
  assert.match(text(part(html, 'data-voice-import-item="long-standard#4"')), /From long-standard · Kept 6 of 14 lines\. Shorten with AI/);
  assert.doesNotMatch(text(part(html, 'data-voice-import-item="long-standard#1"')), /Kept|Shorten/, 'once per skill, on its last row');
  assert.match(part(html, 'data-voice-import-item="reply-style#1"'), /<input type="checkbox"[^>]*checked[^>]*aria-label="Add the Everyone · mail only instruction from reply-style"/);
  assert.match(text(html), /Not imported \(3\)/);
  for (const s of PREVIEW.skipped) assert.match(text(part(html, `data-voice-import-skipped="${s.skill}"`)), new RegExp(`^${s.skill} ${s.reason.replace(/[.()]/g, '\\$&')}`));
  assert.match(part(html, 'data-voice-import-skipped="deploy-helper"'), /<button(?=[^>]*data-action="voice-import-distil")(?=[^>]*data-skill="deploy-helper")(?=[^>]*aria-label="Shorten deploy-helper with AI")/);
  assert.doesNotMatch(part(html, 'data-voice-import-skipped="broken"'), /voice-import-distil/);
  assert.match(text(html), /Shorten with AI uses the AI profile your Mail replies use\./);
  assert.match(html, /data-action="voice-import-save"[^>]*>(?:(?!<\/button>).)*Add 8 instructions/s);
  assert.match(html, /data-action="voice-import-cancel"[^>]*>(?:(?!<\/button>).)*Cancel/s);

  const fewer = { ...allChecked(PREVIEW), 'budget-answers#1': false };
  assert.match(importPanel(PREVIEW, { checked: fewer }), /Add 7 instructions/);
  const one = Object.fromEntries(PREVIEW.items.map((i, n) => [i.key, n === 0]));
  assert.match(importPanel(PREVIEW, { checked: one }), /Add 1 instruction</);
  assert.match(importPanel(PREVIEW, { checked: {} }), /data-action="voice-import-save" disabled/);
  // A Shorten with AI in progress says so.
  assert.match(importPanel(PREVIEW, { checked: allChecked(PREVIEW), busy: { 'long-standard': true } }), /data-skill="long-standard"[^>]*aria-busy="true"/);
  // Nothing found.
  assert.match(text(importPanel({ folder: 'empty', found: 0, items: [], skipped: [], ai: [] }, { checked: {} })), /No skills found in empty\./);
  // A row the AI shortened.
  const shortened = { ...PREVIEW, items: [{ key: 'x#ai1', skill: 'x', dir: 'x', applies: { kind: 'everyone' }, text: 'Lead with the answer.', ai: true }], skipped: [], ai: [] };
  assert.match(text(importPanel(shortened, { checked: { 'x#ai1': true } })), /From x · Shortened by AI/);

  assert.deepEqual(nextVoiceImport(PREVIEW, { checked: fewer }).items.map(i => i.from), PREVIEW.items.filter(i => i.key !== 'budget-answers#1').map(i => i.skill));
  assert.deepEqual(nextVoiceImport(PREVIEW, { checked: allChecked(PREVIEW) }).items[0], { applies: PREVIEW.items[0].applies, text: PREVIEW.items[0].text, from: 'budget-answers' });
});

test('import is disabled with Off: "Choose where your voice comes from first."', () => {
  for (const name of ['off', 'offWithCopy']) {
    const html = draw(name);
    assert.match(html, /data-action="voice-import" disabled[^>]*aria-describedby="ws-voice-import-off"/, name);
    assert.match(html, /id="ws-voice-import-off">Choose where your voice comes from first\.</, name);
    assert.doesNotMatch(html, /data-action="voice-(?:add-rule|edit-rule|delete-rule|edit-style)"(?![^>]*disabled)/, `${name}: no edits through no provider`);
  }
  assert.match(draw('ready'), /data-action="voice-import"(?![^>]*disabled)[^>]*>(?:(?!<\/button>).)*Import from skills…/s);
  // The open preview takes the Instructions list's place.
  const open = draw('ready', { import: { preview: PREVIEW, checked: allChecked(PREVIEW), busy: {} } });
  assert.match(open, /ws-voice-import/);
  assert.doesNotMatch(open, /data-voice-rule=/);
});

test('Import from skills… is disabled while an editor holds typed text, so it never drops it silently', () => {
  const style = draw('ready', { style: { text: 'My new card.', error: null } });
  assert.match(style, /data-action="voice-import" title="Finish editing first\." disabled/);
  const rule = draw('ready', { rule: { id: null, scope: 'everyone', value: '', channel: '', text: 'Be brief.', error: null } });
  assert.match(rule, /data-action="voice-import" title="Finish editing first\." disabled/);
  // No editor open: Import is enabled and carries no stray title.
  assert.doesNotMatch(draw('ready'), /data-action="voice-import"[^>]*title=/);
});

test('a chosen provider with a copy but no refresh yet never reads "No copy yet."', () => {
  const html = draw('ready', {}, s => { s.replyVoice.refreshedAt = null; return s; });
  assert.match(text(part(html, 'ws-voice-copy')), /^Connect's copy Refresh now Delete Connect's copy$/);
  assert.doesNotMatch(html, /No copy yet\./);
});

test('Default and Compact draw the same card and import markup', () => {
  const panel = view => {
    const s = snap('ready');
    s.settings.view = view;
    const html = settings(s, { state: { settingsTab: 'voice', voice: { import: { preview: PREVIEW, checked: allChecked(PREVIEW), busy: {} } } }, auth: {}, now: NOW, menu: { folded: [], collapsed: false, width: 272, query: '' } });
    return html.slice(html.indexOf('<div class="ws-settings-panels'));
  };
  const compact = panel('compact');
  assert.match(compact, /data-voice-provider/);
  assert.match(compact, /ws-voice-import/);
  assert.equal(compact, panel('default'));
  const tab = settings(snap('ready'), { state: { settingsTab: 'voice' }, auth: {}, now: NOW, menu: { folded: [], collapsed: false, width: 272, query: '' } });
  assert.match(tab, /<h2>Your voice<\/h2>/);
  assert.match(tab, /data-tab="voice"[^>]*aria-current="page"/);
});
