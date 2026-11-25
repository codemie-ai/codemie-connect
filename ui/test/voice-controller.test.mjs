// The Settings › Your voice controller (reply voice design §5, §6, §11): each action sends exactly
// one native request through the store (`mutate` for writes, `query` for reads), keeps what the
// user typed through a refusal, and shows the refusal beside its field. Driven over fakes, as
// tasks-controller.test.mjs drives the Tasks controller.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceController, newVoiceView } from '../workspace/voice-controller.js';
import { voiceCard } from '../workspace/settings-voice.js';
import { buildSnapshot, contractFixtures, voiceStates, withVoice } from './fixtures/workspace-fixture.mjs';

const NOW = Date.parse('2026-11-25T10:00:00Z');
const STATES = voiceStates();
const PREVIEW = contractFixtures().voiceImport;
const FOLDER = '/Users/taylor/voice-skills';
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const refusal = (message, field, code = 'validation') => Object.assign(new Error(message), { code, message, ...(field ? { field } : {}) });

function harness({ name = 'ready', answers = {}, queries = {}, picks = [] } = {}) {
  const snapshot = withVoice(buildSnapshot(NOW, { photo: false, zone: 'UTC' }), name);
  const calls = { mutate: [], query: [], plugins: [], render: 0, toasts: [], modals: [], go: [], focus: [], html: '' };
  const state = { voice: newVoiceView() };
  const answer = (table, op, data) => {
    const a = table[op];
    return typeof a === 'function' ? a(data) : a ?? {};
  };
  const ctl = createVoiceController({
    state,
    snap: () => snapshot,
    mutate: async (op, data) => { calls.mutate.push([op, data]); return answer(answers, op, data); },
    query: async (op, data) => { calls.query.push([op, data]); return answer(queries, op, data); },
    pluginsRequest: async (op, data) => { calls.plugins.push([op, data]); return picks.length ? picks.shift() : { path: null }; },
    render: async () => { calls.render++; calls.html = voiceCard(snapshot, { ...state.voice, now: NOW }); },
    openModal: options => { calls.modals.push(options); return {}; },
    confirmModal: options => { calls.modals.push(options); },
    toast: (message, tone, action) => calls.toasts.push({ message, tone, action }),
    go: hash => calls.go.push(hash),
    focus: selector => calls.focus.push(selector),
  });
  return { ctl, state, calls, snapshot };
}
const el = (dataset = {}, extra = {}) => ({ dataset, ...extra });
const type = (ctl, input, value) => ctl.input(el({ voiceInput: input }, { value }));

test('saving the style card sends one voice_save and closes the editor', async () => {
  const { ctl, state, calls } = harness({ answers: { voice_save: { item: { text: 'Terse.' } } } });
  await ctl.handle('voice-edit-style', el());
  assert.equal(state.voice.style.text, STATES.ready.style.text, 'the editor starts from the card text, never the head');
  assert.deepEqual(calls.focus.at(-1), '#ws-voice-style-text');
  type(ctl, 'style', 'Terse.');
  await ctl.handle('voice-save-style', el());
  assert.deepEqual(calls.mutate, [['voice_save', { kind: 'style', text: 'Terse.' }]]);
  assert.equal(state.voice.style, null);
  assert.match(calls.html, /data-action="voice-edit-style"/);
  // Cancel closes the editor and sends nothing; focus goes back to Edit.
  await ctl.handle('voice-edit-style', el());
  await ctl.handle('voice-cancel', el());
  assert.equal(state.voice.style, null);
  assert.equal(calls.mutate.length, 1);
  assert.deepEqual(calls.focus.at(-1), '[data-action="voice-edit-style"]');
});

test('a_refused_save_keeps_the_editor_text', async () => {
  const sentence = "Knowledge didn't save it: The page changed in your folder. Refresh and try again.";
  const { ctl, state, calls } = harness({ answers: { voice_save: () => { throw refusal(sentence, null, 'refused'); } } });
  await ctl.handle('voice-edit-style', el());
  type(ctl, 'style', 'My new card.');
  await ctl.handle('voice-save-style', el());
  assert.equal(calls.mutate.length, 1);
  assert.equal(state.voice.style.text, 'My new card.', 'the editor keeps what was typed');
  assert.match(calls.html, /data-voice-input="style"[^>]*>My new card\.<\/textarea>/);
  assert.match(text(calls.html), /The page changed in your folder\. Refresh and try again\./);

  // A field refusal is drawn beside that field.
  const field = harness({ answers: { voice_save: () => { throw refusal('Keep the style card under 8,000 characters.', 'text'); } } });
  await field.ctl.handle('voice-edit-style', el());
  type(field.ctl, 'style', 'x'.repeat(10));
  await field.ctl.handle('voice-save-style', el());
  assert.match(field.calls.html, /id="ws-voice-style-error" role="alert">Keep the style card under 8,000 characters\./);

  // A rule refusal keeps the rule editor's fields.
  const rule = harness({ answers: { voice_save: () => { throw refusal('Say what the instruction applies to.', 'applies'); } } });
  await rule.ctl.handle('voice-add-rule', el());
  await rule.ctl.handle('voice-rule-kind', el({}, { value: 'chat' }));
  type(rule.ctl, 'rule-text', 'Terse.');
  await rule.ctl.handle('voice-save-rule', el());
  assert.equal(rule.state.voice.rule.text, 'Terse.');
  assert.equal(rule.state.voice.rule.scope, 'chat');
  assert.match(rule.calls.html, /id="ws-voice-rule-applies-error" role="alert">Say what the instruction applies to\./);
});

test('the rule editor offers six kinds and Only in; the value field follows the kind', async () => {
  const { ctl, state, calls } = harness({ answers: { voice_save: { item: { id: 'chat-platform-review-2' } } } });
  await ctl.handle('voice-add-rule', el());
  assert.deepEqual(state.voice.rule, { id: null, scope: 'everyone', value: '', channel: '', text: '', error: null });
  assert.doesNotMatch(calls.html, /data-voice-input="rule-value"/);
  await ctl.handle('voice-rule-kind', el({}, { value: 'chat' }));
  assert.match(calls.html, /for="ws-voice-rule-value"[^>]*>Chat title</);
  type(ctl, 'rule-value', 'Platform review');
  type(ctl, 'rule-channel', 'teams');
  type(ctl, 'rule-text', 'Terse, lower case.');
  await ctl.handle('voice-save-rule', el());
  assert.deepEqual(calls.mutate, [['voice_save', { kind: 'rule', id: null, applies: { kind: 'chat', value: 'Platform review', channel: 'teams' }, text: 'Terse, lower case.' }]]);
  assert.equal(state.voice.rule, null);
  // An unknown kind from a tampered select is ignored.
  await ctl.handle('voice-add-rule', el());
  await ctl.handle('voice-rule-kind', el({}, { value: 'anyone' }));
  assert.equal(state.voice.rule.scope, 'everyone');
});

test('add, edit and delete an instruction; delete toasts "Instruction deleted." with Undo that saves it back', async () => {
  const removed = STATES.ready.rules.find(r => r.id === 'topic-budget-request');
  const { ctl, state, calls } = harness({ answers: { voice_delete: { removed }, voice_save: { item: {} } } });
  // Edit: the editor starts from the row.
  await ctl.handle('voice-edit-rule', el({ id: 'domain-bank-example-test' }));
  assert.deepEqual(state.voice.rule, { id: 'domain-bank-example-test', scope: 'domain', value: 'bank.example.test', channel: 'mail', text: 'Formal, full sentences.', error: null });
  type(ctl, 'rule-text', 'Formal.');
  await ctl.handle('voice-save-rule', el());
  assert.deepEqual(calls.mutate.at(-1), ['voice_save', { kind: 'rule', id: 'domain-bank-example-test', applies: { kind: 'domain', value: 'bank.example.test', channel: 'mail' }, text: 'Formal.' }]);

  // Delete asks nothing; the toast's Undo saves the rule back as a new one.
  await ctl.handle('voice-delete-rule', el({ id: 'topic-budget-request' }));
  assert.deepEqual(calls.mutate.at(-1), ['voice_delete', { id: 'topic-budget-request' }]);
  assert.equal(calls.modals.length, 0);
  const toast = calls.toasts.at(-1);
  assert.equal(toast.message, 'Instruction deleted.');
  assert.equal(toast.action.label, 'Undo');
  const before = calls.mutate.length;
  await toast.action.run();
  assert.equal(calls.mutate.length, before + 1);
  assert.deepEqual(calls.mutate.at(-1), ['voice_save', { kind: 'rule', id: null, applies: { kind: 'topic', value: 'budget request' }, text: 'Ask for the project code.' }]);

  // A refused delete says why and keeps the row.
  const refused = harness({ answers: { voice_delete: () => { throw refusal("Knowledge isn't answering, so nothing was saved. Try again.", null, 'unavailable'); } } });
  await refused.ctl.handle('voice-delete-rule', el({ id: 'everyone' }));
  assert.equal(refused.calls.toasts.at(-1).tone, 'error');
  assert.equal(refused.calls.toasts.at(-1).message, "Knowledge isn't answering, so nothing was saved. Try again.");
});

test('choosing Knowledge or Off sends one voice_set; a refusal puts the radio back', async () => {
  const off = harness({ name: 'ready' });
  await off.ctl.handle('voice-provider', el({ provider: 'off' }, { value: 'off', checked: true }));
  assert.deepEqual(off.calls.mutate, [['voice_set', { provider: 'off' }]]);

  const on = harness({ name: 'off' });
  await on.ctl.handle('voice-provider', el({ provider: 'plugin:knowledge' }, { value: 'plugin:knowledge', checked: true }));
  assert.deepEqual(on.calls.mutate, [['voice_set', { provider: 'plugin:knowledge' }]]);

  const refused = harness({ name: 'ready', answers: { voice_set: () => { throw refusal('Turn Knowledge on in Settings › Plugins first.', 'provider'); } } });
  await refused.ctl.handle('voice-provider', el({ provider: 'off' }, { value: 'off', checked: true }));
  assert.equal(refused.calls.mutate.length, 1);
  assert.equal(refused.calls.toasts.at(-1).message, 'Turn Knowledge on in Settings › Plugins first.');
  assert.ok(refused.calls.render > 0, 'drawn again');
  assert.match(refused.calls.html, /value="plugin:knowledge"[^>]*checked/, 'the radio is back on the chosen provider');
});

test('the facts checkbox sends one voice_set {provider, facts:false}', async () => {
  const { ctl, calls } = harness();
  await ctl.handle('voice-facts', el({}, { checked: false }));
  assert.deepEqual(calls.mutate, [['voice_set', { provider: 'plugin:knowledge', facts: false }]]);
  const refused = harness({ answers: { voice_set: () => { throw refusal('Choose whether to add facts.', 'facts'); } } });
  const box = el({}, { checked: false });
  await refused.ctl.handle('voice-facts', box);
  assert.equal(box.checked, true, 'put back');
  assert.equal(refused.calls.toasts.at(-1).tone, 'error');
});

test('Profile reads voice_read and shows "How to write to them" and "About them" with "From People/priya-n.md. Edit it in Knowledge."', async () => {
  const { ctl, calls } = harness({
    queries: { voice_read: { id: 'priya-n', name: 'Priya N.', text: 'Short sentences; no small talk. <b>', about: 'Product lead; prefers mornings.', source: 'People/priya-n.md' } },
  });
  await ctl.handle('voice-person', el({ id: 'priya-n' }));
  assert.deepEqual(calls.query, [['voice_read', { id: 'priya-n' }]]);
  assert.equal(calls.mutate.length, 0);
  const modal = calls.modals[0];
  assert.equal(modal.title, 'Priya N.');
  assert.equal(modal.submit, '');
  assert.equal(modal.cancel, 'Close');
  assert.equal(modal.initialFocus, 'cancel');
  assert.match(modal.body, /How to write to them/);
  assert.match(modal.body, /Short sentences; no small talk\. &lt;b&gt;/);
  assert.match(modal.body, /About them/);
  assert.match(modal.body, /Product lead; prefers mornings\./);
  assert.match(text(modal.body), /From People\/priya-n\.md\. Edit it in Knowledge\./);
});

test('a voice_read refusal toasts near the Profile button instead of reaching the global handler', async () => {
  const { ctl, calls } = harness({
    queries: { voice_read: () => { throw refusal("Knowledge isn't answering, so nothing was saved. Try again.", null, 'unavailable'); } },
  });
  await ctl.handle('voice-person', el({ id: 'priya-n' }));
  assert.equal(calls.modals.length, 0, 'no dialog opened on a refusal');
  assert.equal(calls.toasts.at(-1).tone, 'error');
  assert.equal(calls.toasts.at(-1).message, "Knowledge isn't answering, so nothing was saved. Try again.");
});

test('Delete Connect\'s copy asks first; Cancel is the default; confirming sends one voice_forget', async () => {
  const { ctl, calls } = harness({ answers: { voice_forget: { deleted: 7, provider: 'off' } } });
  await ctl.handle('voice-forget', el());
  assert.equal(calls.mutate.length, 0, 'nothing before the answer');
  const modal = calls.modals[0];
  assert.equal(modal.title, "Delete Connect's copy of your voice?");
  assert.equal(text(modal.body), "Connect stops adding your voice to drafts and turns it off. Your Knowledge folder is not touched; choose Knowledge again to make a new copy.");
  assert.equal(modal.submit, 'Delete copy');
  assert.equal(modal.cancel, 'Cancel');
  assert.equal(modal.returnCancels, true, 'Cancel focused and Return cancels');
  await modal.onSubmit();
  assert.deepEqual(calls.mutate, [['voice_forget', {}]]);
});

test('Refresh now sends voice_refresh', async () => {
  const { ctl, calls } = harness({ queries: { voice_refresh: { queued: true } } });
  await ctl.handle('voice-refresh', el());
  assert.deepEqual(calls.query, [['voice_refresh', {}]]);
  assert.equal(calls.mutate.length, 0);
});

test('Turn on and Set up go to the plugin', async () => {
  const off = harness({ name: 'pluginOff' });
  await off.ctl.handle('voice-turn-on', el({ provider: 'plugin:knowledge' }));
  assert.deepEqual(off.calls.plugins, [['set_enabled', { id: 'knowledge', enabled: true }]]);
  const setup = harness({ name: 'needsSetup' });
  await setup.ctl.handle('voice-setup', el({ provider: 'plugin:knowledge' }));
  assert.deepEqual(setup.calls.go, ['#/p/knowledge/home']);
});

test('import: the pick, then one scan, then the preview with every row and every reason', async () => {
  const { ctl, state, calls } = harness({ picks: [{ path: FOLDER }], queries: { voice_import_scan: PREVIEW } });
  await ctl.handle('voice-import', el());
  assert.deepEqual(calls.plugins, [['pick_folder', { purpose: 'skills' }]]);
  assert.deepEqual(calls.query, [['voice_import_scan', { path: FOLDER }]]);
  assert.equal(state.voice.import.path, FOLDER);
  const words = text(calls.html);
  assert.match(words, /Import from skills · voice-skills/);
  assert.match(words, /Found 6 skills\. 8 instructions to add\./);
  assert.match(words, /From reply-style/);
  assert.match(words, /Kept 6 of 14 lines\./);
  assert.match(words, /Not imported \(3\)/);
  for (const s of PREVIEW.skipped) assert.ok(words.includes(s.reason), s.reason);
  assert.deepEqual(calls.focus.at(-1), '#ws-voice-import-title');
  assert.equal(calls.mutate.length, 0, 'the preview stores nothing');

  // A cancelled pick sends no scan.
  const none = harness({ picks: [{ path: null }] });
  await none.ctl.handle('voice-import', el());
  assert.equal(none.calls.plugins.length, 1);
  assert.equal(none.calls.query.length, 0);
  assert.equal(none.state.voice.import, null);

  // The tour hands the preview over as it is (no picker).
  const tour = harness();
  await tour.ctl.openImport(PREVIEW, FOLDER);
  assert.equal(tour.calls.plugins.length, 0);
  assert.match(text(tour.calls.html), /Found 6 skills\./);
});

test('a pick or scan refusal toasts near Import from skills…, not through the global handler, and opens no preview', async () => {
  const pickRefused = harness();
  const ctlPick = createVoiceController({
    state: pickRefused.state,
    snap: () => pickRefused.snapshot,
    mutate: async () => ({}),
    query: async () => ({}),
    pluginsRequest: async () => { throw refusal('The plugin host is not responding.', null, 'unavailable'); },
    render: async () => { pickRefused.calls.render++; },
    openModal: () => null,
    toast: (message, tone) => pickRefused.calls.toasts.push({ message, tone }),
    go: () => {},
    focus: () => {},
  });
  await ctlPick.handle('voice-import', el());
  assert.equal(pickRefused.calls.toasts.at(-1).tone, 'error');
  assert.equal(pickRefused.calls.toasts.at(-1).message, 'The plugin host is not responding.');
  assert.equal(pickRefused.state.voice.import, null, 'no preview opened');

  const scanRefused = harness({ picks: [{ path: FOLDER }], queries: { voice_import_scan: () => { throw refusal("Knowledge isn't answering, so nothing was saved. Try again.", null, 'unavailable'); } } });
  await scanRefused.ctl.handle('voice-import', el());
  assert.deepEqual(scanRefused.calls.plugins, [['pick_folder', { purpose: 'skills' }]]);
  assert.deepEqual(scanRefused.calls.query, [['voice_import_scan', { path: FOLDER }]]);
  assert.equal(scanRefused.calls.toasts.at(-1).tone, 'error');
  assert.equal(scanRefused.calls.toasts.at(-1).message, "Knowledge isn't answering, so nothing was saved. Try again.");
  assert.equal(scanRefused.state.voice.import, null, 'no preview opened');
});

test('import: Shorten with AI sends one voice_import_distil for that skill and replaces its rows with "Shortened by AI"; a refusal keeps the rows', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const { ctl, state, calls } = harness({
    picks: [{ path: FOLDER }],
    queries: { voice_import_scan: PREVIEW, voice_import_distil: () => pending },
  });
  await ctl.handle('voice-import', el());
  const running = ctl.handle('voice-import-distil', el({ skill: 'long-standard' }));
  await Promise.resolve();
  assert.match(calls.html, /data-skill="long-standard"[^>]*aria-busy="true"/);
  release({ skill: 'long-standard', items: [{ applies: { kind: 'everyone' }, text: 'Lead with the answer.' }, { applies: { kind: 'everyone', channel: 'mail' }, text: 'Short paragraphs.' }] });
  await running;
  assert.deepEqual(calls.query.at(-1), ['voice_import_distil', { path: FOLDER, skill: 'long-standard', dir: 'long-standard' }]);
  assert.equal(calls.query.filter(([op]) => op === 'voice_import_distil').length, 1);
  const rows = state.voice.import.preview.items.filter(i => i.skill === 'long-standard');
  assert.equal(rows.length, 2);
  assert.ok(rows.every(r => r.ai && state.voice.import.checked[r.key]), 'new rows, ticked');
  assert.match(text(calls.html), /From long-standard · Shortened by AI/);
  assert.doesNotMatch(calls.html, /data-skill="long-standard"/, 'offered once');
  assert.equal(state.voice.import.preview.items.length, 8 - 4 + 2);

  // A skill that wasn't imported becomes rows.
  const skipped = harness({ picks: [{ path: FOLDER }], queries: { voice_import_scan: PREVIEW, voice_import_distil: { skill: 'deploy-helper', items: [{ applies: { kind: 'everyone' }, text: 'Say what changed.' }] } } });
  await skipped.ctl.handle('voice-import', el());
  await skipped.ctl.handle('voice-import-distil', el({ skill: 'deploy-helper' }));
  assert.deepEqual(skipped.calls.query.at(-1)[1], { path: FOLDER, skill: 'deploy-helper', dir: 'deploy-helper' });
  assert.doesNotMatch(skipped.calls.html, /data-voice-import-skipped="deploy-helper"/);
  assert.match(text(skipped.calls.html), /Not imported \(2\)/);

  // A refusal keeps the rows and says why.
  const refused = harness({
    picks: [{ path: FOLDER }],
    queries: { voice_import_scan: PREVIEW, voice_import_distil: () => { throw refusal("AI's answer didn't fit, so long-standard is unchanged.", null, 'invalid_output'); } },
  });
  await refused.ctl.handle('voice-import', el());
  await refused.ctl.handle('voice-import-distil', el({ skill: 'long-standard' }));
  assert.equal(refused.state.voice.import.preview.items.filter(i => i.skill === 'long-standard').length, 4);
  assert.match(text(refused.calls.html), /AI's answer didn't fit, so long-standard is unchanged\./);
  assert.doesNotMatch(refused.calls.html, /aria-busy="true"/);
});

test('import: unticking a row and saving sends one voice_import with the ticked rows; toast "Added 3 instructions to Knowledge."; Cancel sends nothing', async () => {
  const { ctl, state, calls } = harness({ picks: [{ path: FOLDER }], queries: { voice_import_scan: PREVIEW }, answers: { voice_import: { added: 3, skipped: 4 } } });
  await ctl.handle('voice-import', el());
  await ctl.handle('voice-import-toggle', el({ key: 'budget-answers#1' }, { checked: false }));
  assert.match(calls.html, /Add 7 instructions/);
  await ctl.handle('voice-import-save', el());
  assert.equal(calls.mutate.length, 1);
  const [op, data] = calls.mutate[0];
  assert.equal(op, 'voice_import');
  assert.deepEqual(data.items, PREVIEW.items.filter(i => i.key !== 'budget-answers#1').map(i => ({ applies: i.applies, text: i.text, from: i.skill })));
  assert.equal(calls.toasts.at(-1).message, 'Added 3 instructions to Knowledge.');
  assert.equal(state.voice.import, null);
  assert.deepEqual(calls.focus.at(-1), '[data-action="voice-import"]');

  // A refused save keeps the preview and says why.
  const refused = harness({ picks: [{ path: FOLDER }], queries: { voice_import_scan: PREVIEW }, answers: { voice_import: () => { throw refusal("Knowledge isn't answering, so nothing was saved. Try again.", null, 'unavailable'); } } });
  await refused.ctl.handle('voice-import', el());
  await refused.ctl.handle('voice-import-save', el());
  assert.ok(refused.state.voice.import, 'still open');
  assert.match(text(refused.calls.html), /Knowledge isn't answering, so nothing was saved\. Try again\./);

  const cancel = harness({ picks: [{ path: FOLDER }], queries: { voice_import_scan: PREVIEW } });
  await cancel.ctl.handle('voice-import', el());
  await cancel.ctl.handle('voice-import-cancel', el());
  assert.equal(cancel.calls.mutate.length, 0);
  assert.equal(cancel.state.voice.import, null);
  assert.deepEqual(cancel.calls.focus.at(-1), '[data-action="voice-import"]');

  const single = harness({ picks: [{ path: FOLDER }], queries: { voice_import_scan: PREVIEW }, answers: { voice_import: { added: 1, skipped: 0 } } });
  await single.ctl.handle('voice-import', el());
  await single.ctl.handle('voice-import-save', el());
  assert.equal(single.calls.toasts.at(-1).message, 'Added 1 instruction to Knowledge.');
});

test('import with Off asks for no folder', async () => {
  const { ctl, calls } = harness({ name: 'offWithCopy', picks: [{ path: FOLDER }] });
  await ctl.handle('voice-import', el());
  assert.equal(calls.plugins.length, 0);
  assert.equal(calls.query.length, 0);
});
