// Settings › Meetings (Transcripts & folders, Note templates, Automatic rules, Glossary & tags,
// Tasks): the panels as markup and the settings controller with its store, dialogs and page
// faked. Editors update in place (the dirty bar, the summary, the tester) and never re-render.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SETTINGS_TABS, settings, settingsTabFor } from '../workspace/view-settings.js';
import { meetingsSettingsPanel, folderName, folderSamples } from '../workspace/view-settings-meetings.js';
import { createMeetingsSettingsController, newMeetingsSettingsView } from '../workspace/meetings-settings-controller.js';
import { createMeetingsController } from '../workspace/meetings-controller.js';
import { newMeetingsView } from '../workspace/meetings-model.js';
import { newTasksView } from '../workspace/tasks-model.js';
import { REBASE_SAFE } from '../workspace/store.js';
import { EXAMPLE_GLOSSARY, EXAMPLE_TAGS, exampleText } from '../workspace/settings-meetings-editors.js';
import { parseGlossary } from '../workspace/meetings-model.js';
import { readFileSync } from 'node:fs';
import { buildSnapshot, withMeetings } from './fixtures/workspace-fixture.mjs';

const NOW = Date.UTC(2026, 10, 18, 15, 20);
const snapshot = () => withMeetings(buildSnapshot(NOW, { photo: false, zone: 'UTC' }), NOW);
const MEETING_TABS = ['meetings-transcripts', 'meetings-templates', 'meetings-rules', 'meetings-glossary', 'meetings-tasks'];
const failure = (code, message = code, field) => Object.assign(new Error(message), { code, ...(field ? { field } : {}) });
const control = (dataset = {}, extra = {}) => ({ dataset, closest: () => null, ...extra });

/** A controller over fakes. `answers` maps an op to what it returns (a function of the data, a
 *  value, or an error to throw); `later` timers run only when the test says so. */
function harness({ s = snapshot(), answers = {}, view = {}, tab = 'meetings-templates', transcriptsOn, plugins = [] } = {}) {
  const calls = { mutate: [], save: [], query: [], render: 0, patches: [], toasts: [], modals: [], routes: [], focus: [], timers: [], copied: [], opened: [], made: [], inserted: [] };
  const state = { route: 'settings', settingsTab: tab, meetingsSettings: { ...newMeetingsSettingsView(), ...view } };
  const answer = (op, data) => {
    const a = answers[op];
    if (a instanceof Error) throw a;
    return typeof a === 'function' ? a(data) : a;
  };
  const ctl = createMeetingsSettingsController({
    state,
    snap: () => s,
    store: { query: async (op, data) => { calls.query.push([op, data]); return answer(op, data); } },
    mutate: async (op, data) => { calls.mutate.push([op, data]); return answer(op, data) ?? { saved: true }; },
    save: async (op, data) => { calls.save.push([op, data]); return answer(op, data) ?? { saved: true }; },
    render: async () => { calls.render++; },
    patch: (selector, html) => calls.patches.push([selector, html]),
    route: async (name, t) => { calls.routes.push(t ? [name, t] : [name]); },
    openModal: options => { calls.modals.push(options); return { querySelector: () => null, close() {} }; },
    confirmModal: options => { calls.modals.push(options); },
    toast: (message, tone, action) => calls.toasts.push({ message, tone, action }),
    focus: selector => calls.focus.push(selector),
    writeText: async text => { calls.copied.push(text); },
    insertText: (selector, text) => { calls.inserted.push([selector, text]); return `${state.meetingsSettings.edit?.draft?.prompt || ''}${text}`; },
    pickRoot: async () => answer('meetings_root_pick'),
    transcriptsOn: transcriptsOn || (async () => { calls.routes.push(['transcripts-on']); }),
    makeNotes: async (id, options) => { calls.made.push([id, options]); return answer('meeting_notes', { id, ...options }) ?? { queued: true }; },
    openMeeting: async (id, t) => { calls.opened.push([id, t]); },
    guarded: async (id, run) => { try { await run(); return true; } catch (err) { calls.toasts.push({ message: err.message, tone: 'error', code: err.code }); return false; } },
    glossaryChanged: () => { calls.glossaryChanged = (calls.glossaryChanged || 0) + 1; },
    later: fn => { calls.timers.push(fn); return calls.timers.length; },
    cancel: handle => { calls.timers[handle - 1] = null; },
    now: () => NOW,
    plugins: () => plugins,
  });
  const v = () => state.meetingsSettings;
  const panel = (t = state.settingsTab) => meetingsSettingsPanel(t, s, { v: v(), auth: {}, now: NOW, plugins });
  const runTimers = async () => {
    const due = calls.timers.splice(0).filter(Boolean);
    for (const fn of due) await fn();
  };
  return { ctl, state, calls, s, v, panel, runTimers };
}

test('settings has a Meetings group with the five tabs in order', () => {
  const ids = SETTINGS_TABS.map(([, id]) => id);
  const at = ids.indexOf('meetings-transcripts');
  assert.deepEqual(ids.slice(at, at + 5), MEETING_TABS);
  assert.deepEqual(SETTINGS_TABS.slice(at, at + 5).map(([group, , label]) => [group, label]), [
    ['Meetings', 'Transcripts & folders'], ['', 'Note templates'], ['', 'Automatic rules'], ['', 'Glossary & tags'], ['', 'Tasks'],
  ]);
  // After Workspace, before CodeMie (R2).
  assert.ok(at > ids.indexOf('plugins'), 'after the Workspace group');
  assert.equal(SETTINGS_TABS[at + 5][0], 'CodeMie');
  const s = snapshot();
  const ctx = tab => ({ state: { settingsTab: tab, meetingsSettings: newMeetingsSettingsView() }, auth: {}, now: NOW });
  const nav = settings(s, ctx('meetings-rules'));
  assert.match(nav, /class="ws-nav-group" data-action="settings-group" data-group="Meetings"/);
  for (const tab of MEETING_TABS) {
    assert.equal(settingsTabFor(tab), tab);
    const html = settings(s, ctx(tab));
    assert.match(html, new RegExp(`data-tab="${tab}" aria-current="page"`));
    assert.match(html, /<header class="ws-settings-header[^"]*"><div>(?:(?!<\/header>).)*<p>[^<]+<\/p>/s, `${tab} has a description`);
    assert.ok(meetingsSettingsPanel(tab, s, { v: newMeetingsSettingsView(), auth: {}, now: NOW }).length > 400, tab);
  }
  // Note templates and Automatic rules carry their actions in the header.
  assert.match(settings(s, ctx('meetings-templates')), /data-action="meetings-settings-skill-add"[^]*data-action="meetings-settings-tpl-new"/);
  assert.match(settings(s, ctx('meetings-rules')), /data-action="meetings-settings-rule-add"/);
});

test('folder preview uses the chosen pattern for three sample meetings', () => {
  const s = snapshot();
  const samples = folderSamples(s, NOW);
  assert.equal(samples.length, 3);
  const at = Date.UTC(2026, 10, 4, 16, 4, 26);
  // As folder.rs: lower case, every run of other characters one “-”, Unicode letters kept,
  // cut at 60, `meeting` when nothing is left.
  assert.equal(folderName(at, 'Philips CodeMie conversations syncup', 'echo', 'UTC'), '2026-11-04_160426-philips-codemie-conversations-syncup');
  assert.equal(folderName(at, 'Philips CodeMie conversations syncup', 'date-title', 'UTC'), '2026-11-04-philips-codemie-conversations-syncup');
  assert.equal(folderName(at, 'Philips CodeMie conversations syncup', 'title-date', 'UTC'), 'philips-codemie-conversations-syncup-2026-11-04');
  assert.equal(folderName(at, '🚀 / Q1', 'date-title', 'UTC'), '2026-11-04-q1');
  assert.equal(folderName(at, '🚀', 'date-title', 'UTC'), '2026-11-04-meeting');
  assert.equal(folderName(at, 'Ревю  архітектури', 'date-title', 'UTC'), '2026-11-04-ревю-архітектури');
  assert.equal(folderName(at, `${'a'.repeat(59)} bcd`, 'date-title', 'UTC'), `2026-11-04-${'a'.repeat(59)}`);
  assert.equal(folderName(at, 'Stand-up', 'echo', 'Europe/Kyiv'), '2026-11-04_180426-stand-up', 'local time');
  for (const [pattern, shape] of [['echo', /^\d{4}-\d{2}-\d{2}_\d{6}-[\p{L}\p{N}-]+\/$/u], ['date-title', /^\d{4}-\d{2}-\d{2}-[\p{L}\p{N}-]+\/$/u], ['title-date', /^[\p{L}\p{N}-]+-\d{4}-\d{2}-\d{2}\/$/u]]) {
    s.settings.meetings.folderPattern = pattern;
    const html = meetingsSettingsPanel('meetings-transcripts', s, { v: newMeetingsSettingsView(), auth: {}, now: NOW });
    const preview = html.match(/<div class="ws-ms-pattern-preview"[^>]*>([^]*?)<\/div>/)?.[1] || '';
    const names = [...preview.matchAll(/<code>([^<]+)<\/code>/g)].map(m => m[1]);
    assert.equal(names.length, 3, pattern);
    for (const name of names) assert.match(name, shape, `${pattern}: ${name}`);
    assert.deepEqual(names, samples.map(m => `${folderName(m.start, m.title, pattern, 'UTC')}/`));
    assert.match(html, new RegExp(`name="folderPattern" value="${pattern}"[^>]* checked`));
  }
});

test('the open-a-meeting card: three choices, the switch, pins in order with move and unpin', () => {
  const s = snapshot();
  s.settings.meetings.openOn = 'transcript';
  s.settings.meetings.actionItems = false;
  s.settings.meetings.summaryTabs = ['short-summary', 'meeting-notes'];
  const html = meetingsSettingsPanel('meetings-templates', s, { v: newMeetingsSettingsView(), auth: {}, now: NOW });
  assert.match(html, /When you open a meeting/);
  assert.match(html, /<div class="ws-segmented" role="group" aria-label="Open a meeting on">/);
  for (const [val, pressed] of [['summary', 'false'], ['transcript', 'true'], ['notes', 'false']]) {
    assert.match(html, new RegExp(`data-action="meetings-settings-open-on" data-v="${val}" aria-pressed="${pressed}"`), val);
  }
  // The switch: off, since actionItems is false.
  assert.match(html, /<input[^>]*data-action="meetings-settings-set"[^>]*data-key="actionItems"[^>]*>/);
  assert.doesNotMatch(html.match(/<input[^>]*data-key="actionItems"[^>]*>/)[0], /checked/);
  // Pins, in order, each with Move up / Move down and Unpin.
  const order = [...html.matchAll(/<li data-pin="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(order, ['short-summary', 'meeting-notes']);
  assert.match(html, /data-action="meetings-settings-pin-move" title="Move up" aria-label="Move up" disabled data-pin="short-summary" data-d="-1"/, 'Move up disabled on the first');
  assert.match(html, /data-action="meetings-settings-pin-move" title="Move down" aria-label="Move down" disabled data-pin="meeting-notes" data-d="1"/, 'Move down disabled on the last');
  assert.doesNotMatch(html, /data-action="meetings-settings-pin-move" title="Move down" aria-label="Move down" disabled data-pin="short-summary"/, 'Move down enabled on the first');
  assert.match(html, /data-action="meetings-settings-unpin"[^>]*data-pin="short-summary"/);
  assert.match(html, /data-action="meetings-settings-unpin"[^>]*data-pin="meeting-notes"/);
});

test('Pin a summary lists unpinned templates and summary plugins, disabled at four', () => {
  const s = snapshot();
  s.noteTemplates.push({ id: 'client-recap', name: 'Client recap', kind: 'custom', blurb: '', prompt: 'x', sections: ['summary'], extractTasks: true, color: '#2297F6', icon: 'note', skillPath: null, edited: false });
  const plugins = [{ id: 'pod', name: 'Podervianskyi' }, { id: 'exec', name: 'Executive brief' }];
  s.settings.meetings.summaryTabs = ['meeting-notes'];
  const html = meetingsSettingsPanel('meetings-templates', s, { v: newMeetingsSettingsView(), auth: {}, now: NOW, plugins });
  const start = html.indexOf('data-menu="ms-pin-add"');
  const menuHtml = html.slice(start, html.indexOf('</details>', start));
  assert.match(menuHtml, /data-action="meetings-settings-pin" data-pin="short-summary"/, 'an unpinned built-in');
  assert.match(menuHtml, /data-action="meetings-settings-pin" data-pin="client-recap"/, 'an unpinned custom template');
  assert.doesNotMatch(menuHtml, /data-pin="meeting-notes"/, 'already pinned, so not offered');
  assert.match(menuHtml, /Plugins/);
  assert.match(menuHtml, /data-action="meetings-settings-pin" data-pin="plugin:pod"/);
  assert.match(menuHtml, /data-action="meetings-settings-pin" data-pin="plugin:exec"/);
  assert.doesNotMatch(html.slice(0, start), /aria-disabled="true"/, 'not disabled with fewer than four pins');
  // Disabled at four, with its reason.
  s.settings.meetings.summaryTabs = ['meeting-notes', 'short-summary', 'client-recap', 'plugin:pod'];
  const full = meetingsSettingsPanel('meetings-templates', s, { v: newMeetingsSettingsView(), auth: {}, now: NOW, plugins });
  assert.match(full, /<details class="ws-menu" data-menu="ms-pin-add" title="Pin up to 4 summaries\."><summary class="ws-btn ws-btn-secondary" aria-disabled="true" title="Pin up to 4 summaries\."/);
});

test('pinning sends summaryTabs with the new id last; Move up swaps; Unpin removes', async () => {
  const s = snapshot();
  s.settings.meetings.summaryTabs = ['meeting-notes'];
  const plugins = [{ id: 'pod', name: 'Podervianskyi' }];
  const { ctl, calls, panel } = harness({ s, plugins });
  await ctl.handle('meetings-settings-pin', control({ pin: 'short-summary' }));
  assert.deepEqual(calls.mutate.at(-1), ['settings_update', { meetings: { summaryTabs: ['meeting-notes', 'short-summary'] } }]);
  s.settings.meetings.summaryTabs = ['meeting-notes', 'short-summary'];
  // A plugin pins the same way.
  await ctl.handle('meetings-settings-pin', control({ pin: 'plugin:pod' }));
  assert.deepEqual(calls.mutate.at(-1), ['settings_update', { meetings: { summaryTabs: ['meeting-notes', 'short-summary', 'plugin:pod'] } }]);
  s.settings.meetings.summaryTabs = ['meeting-notes', 'short-summary', 'plugin:pod'];
  // Move up swaps with the one before it.
  await ctl.handle('meetings-settings-pin-move', control({ pin: 'short-summary', d: '-1' }));
  assert.deepEqual(calls.mutate.at(-1), ['settings_update', { meetings: { summaryTabs: ['short-summary', 'meeting-notes', 'plugin:pod'] } }]);
  s.settings.meetings.summaryTabs = ['short-summary', 'meeting-notes', 'plugin:pod'];
  // Unpin removes it, keeping the others' order.
  await ctl.handle('meetings-settings-unpin', control({ pin: 'meeting-notes' }));
  assert.deepEqual(calls.mutate.at(-1), ['settings_update', { meetings: { summaryTabs: ['short-summary', 'plugin:pod'] } }]);
  s.settings.meetings.summaryTabs = ['short-summary', 'plugin:pod'];
  // Open a meeting on.
  await ctl.handle('meetings-settings-open-on', control({ v: 'transcript' }));
  assert.deepEqual(calls.mutate.at(-1), ['settings_update', { meetings: { openOn: 'transcript' } }]);
  // A refusal (over 4) shows under the card.
  const refused = harness({ s, answers: { settings_update: failure('validation', 'Pin up to 4 summaries.', 'summaryTabs') } });
  await refused.ctl.handle('meetings-settings-pin', control({ pin: 'meeting-notes' }));
  assert.match(refused.panel(), /data-error-for="meetings\.summaryTabs">Pin up to 4 summaries\./);
  assert.ok(panel());
});

test('a template card’s ⋯ says Pin as a summary tab, or Unpin from summary tabs when pinned', () => {
  const s = snapshot();
  const unpinned = meetingsSettingsPanel('meetings-templates', s, { v: newMeetingsSettingsView(), auth: {}, now: NOW });
  assert.match(unpinned, /data-action="meetings-settings-pin" data-pin="meeting-notes">[^]*?Pin as a summary tab/);
  assert.doesNotMatch(unpinned.slice(unpinned.indexOf('data-template="meeting-notes"'), unpinned.indexOf('data-template="short-summary"')), /Unpin from summary tabs/);
  s.settings.meetings.summaryTabs = ['meeting-notes'];
  const pinned = meetingsSettingsPanel('meetings-templates', s, { v: newMeetingsSettingsView(), auth: {}, now: NOW });
  assert.match(pinned, /data-action="meetings-settings-unpin" data-pin="meeting-notes">[^]*?Unpin from summary tabs/);
});

test('template editor marks unsaved changes and Save sends template_save with sections and prompt', async () => {
  const { ctl, calls, v, panel } = harness();
  await ctl.handle('meetings-settings-tpl-edit', control({ id: 'meeting-notes' }));
  assert.equal(v().edit.id, 'meeting-notes');
  let html = panel();
  assert.match(html, /class="ws-ms-editor-bar"[^>]*>[^]*Saved/);
  assert.match(html, /data-action="meetings-settings-tpl-save"[^>]*disabled/);
  assert.match(html, /\{\{transcript\}\}/, 'the variable chips');
  const renders = calls.render;
  // Typing changes only the dirty bar (and the word count): no re-render.
  ctl.input({ dataset: { msInput: 'tpl-prompt' }, value: 'Write the notes for {{me}}.\n\n{{transcript}}' });
  assert.equal(calls.render, renders, 'typing never re-renders');
  const bar = calls.patches.filter(([sel]) => sel === '.ws-ms-editor-bar').at(-1)?.[1] || '';
  assert.match(bar, /Unsaved changes/);
  assert.doesNotMatch(bar, /data-action="meetings-settings-tpl-save"[^>]*disabled/);
  assert.match(bar, /data-action="meetings-settings-tpl-discard"/);
  // A section and the colour change in place too.
  await ctl.handle('meetings-settings-tpl-section', control({ s: 'risks' }, { checked: true }));
  await ctl.handle('meetings-settings-tpl-color', control({ c: '#E65100' }));
  assert.equal(calls.render, renders, 'sections and colour never re-render');
  html = panel();
  assert.match(html, /Unsaved changes/);
  assert.match(html, /Write the notes for \{\{me\}\}\./);
  await ctl.handle('meetings-settings-tpl-save', control());
  const [op, sent] = calls.mutate.at(-1);
  assert.equal(op, 'template_save');
  assert.equal(sent.id, 'meeting-notes');
  assert.equal(sent.prompt, 'Write the notes for {{me}}.\n\n{{transcript}}');
  assert.deepEqual(sent.sections, ['frontmatter', 'tldr', 'context', 'knowledge', 'decisions', 'plan', 'actions', 'questions', 'transcriptNotes', 'risks']);
  assert.equal(sent.color, '#E65100');
  assert.equal(sent.extractTasks, true);
  assert.equal(sent.name, 'Meeting notes');
  assert.match(calls.toasts.at(-1).message, /^Saved “Meeting notes”\. New notes use it; notes already made don’t change\.$/);
  // A refusal shows next to its field and the edit stays.
  const refused = harness({ answers: { template_save: failure('validation', 'Name the template (up to 80 characters).', 'name') } });
  await refused.ctl.handle('meetings-settings-tpl-edit', control({ id: 'short-summary' }));
  refused.ctl.input({ dataset: { msInput: 'tpl-name' }, value: '' });
  await refused.ctl.handle('meetings-settings-tpl-save', control());
  assert.match(refused.panel(), /<input[^>]*data-ms-input="tpl-name"[^>]*>(?:(?!<\/label>).)*<p class="ws-field-error" role="alert" data-error-for="tpl\.name">Name the template \(up to 80 characters\)\.<\/p>/s);
  assert.deepEqual(refused.calls.focus.at(-1), '[data-ms-input="tpl-name"]');
  assert.equal(refused.v().edit.draft.name, '', 'the edit stays');
});

test('built-in shows Reset to built-in only when edited', async () => {
  const s = snapshot();
  const h = harness({ s });
  await h.ctl.handle('meetings-settings-tpl-edit', control({ id: 'meeting-notes' }));
  assert.doesNotMatch(h.panel(), /Reset to built-in/);
  assert.doesNotMatch(meetingsSettingsPanel('meetings-templates', s, { v: newMeetingsSettingsView(), auth: {}, now: NOW }), /Reset to built-in/);
  const notes = s.noteTemplates.find(t => t.id === 'meeting-notes');
  Object.assign(notes, { edited: true, prompt: 'My own take.' });
  assert.match(h.panel(), /data-action="meetings-settings-tpl-reset" data-id="meeting-notes"/);
  const list = meetingsSettingsPanel('meetings-templates', s, { v: newMeetingsSettingsView(), auth: {}, now: NOW });
  assert.match(list, /data-action="meetings-settings-tpl-reset" data-id="meeting-notes"/);
  assert.match(list, /ws-badge-warning">Edited/);
  // Short summary was never edited: no reset there.
  assert.doesNotMatch(list, /data-action="meetings-settings-tpl-reset" data-id="short-summary"/);
  // Reset deletes the override; Undo saves the edit back.
  await h.ctl.handle('meetings-settings-tpl-reset', control({ id: 'meeting-notes' }));
  assert.deepEqual(h.calls.mutate.at(-1), ['template_delete', { id: 'meeting-notes' }]);
  const undo = h.calls.toasts.at(-1);
  assert.match(undo.message, /“Meeting notes” is back to the built-in version/);
  assert.equal(undo.action.label, 'Undo');
  await undo.action.run();
  assert.equal(h.calls.mutate.at(-1)[0], 'template_save');
  assert.equal(h.calls.mutate.at(-1)[1].prompt, 'My own take.');
  assert.equal(h.calls.mutate.at(-1)[1].id, 'meeting-notes');
});

test('rule tester shows the template and reason for a typed title and people count', async () => {
  const s = snapshot();
  s.records.push({ id: 'r-three', kind: 'meeting_rule', source: 'local', connectionId: null, workspaceId: 'personal', revision: 'rev-r-three', updatedAt: 1, data: { field: 'people', value: '3', template: 'meeting-notes', autoNotes: true, on: true, order: 3 } });
  const { ctl, calls, v, panel } = harness({ s, tab: 'meetings-rules' });
  const result = () => calls.patches.filter(([sel]) => sel === '.ws-ms-test-result').at(-1)?.[1] || '';
  ctl.input({ dataset: { msInput: 'test-title' }, value: 'Daily stand-up' });
  ctl.input({ dataset: { msInput: 'test-people' }, value: '3' });
  assert.equal(calls.render, 0, 'the tester never re-renders');
  assert.match(result(), /<strong>Short summary<\/strong>/);
  assert.match(result(), /Rule 1: title contains “stand-up”/);
  // No title rule: the people rule (third in the list) makes notes by itself.
  ctl.input({ dataset: { msInput: 'test-title' }, value: 'Weekly sync' });
  assert.match(result(), /<strong>Meeting notes<\/strong>/);
  assert.match(result(), /Rule 3: number of people is “3” · notes made automatically/);
  ctl.input({ dataset: { msInput: 'test-people' }, value: '2' });
  assert.match(result(), /No rule matches — your default template/);
  assert.deepEqual(v().test, { title: 'Weekly sync', people: 2 });
  // The panel shows what was typed and the same result.
  const html = panel();
  assert.match(html, /data-ms-input="test-title"[^>]*value="Weekly sync"/);
  assert.match(html, /No rule matches — your default template/);
  // Moving the people rule up makes it the winner for a stand-up of three.
  ctl.input({ dataset: { msInput: 'test-title' }, value: 'Daily stand-up' });
  ctl.input({ dataset: { msInput: 'test-people' }, value: '3' });
  await ctl.handle('meetings-settings-rule-move', control({ id: 'r-three', d: '-1' }));
  assert.deepEqual(calls.mutate.at(-1), ['meeting_rule_order', { ids: ['r-standup', 'r-three', 'r-philips'] }]);
});

test('glossary panel parses as you type without re-rendering the textarea', async () => {
  const text = '## Me\n**Taylor Morgan** — also “Taylor”.\n\n## Products\n- **CodeMie** — heard as “code me”\n';
  const { ctl, calls, v, panel, runTimers } = harness({ tab: 'meetings-glossary', answers: { meeting_text: d => ({ text: d.name === 'glossary' ? text : '- `meeting`\n', path: `/Users/taylor/CodeMie Connect/Meetings/${d.name}.md`, linked: false }) } });
  await ctl.load();
  assert.deepEqual(calls.query.map(([op, d]) => [op, d.name]), [['meeting_text', 'glossary'], ['meeting_text', 'tags']]);
  let html = panel();
  assert.match(html, /<textarea[^>]*data-ms-input="md"[^>]*data-k="glossary"[^>]*>## Me/);
  assert.match(html, /1 spelling fix/);
  assert.match(html, /Restore the example/);
  const renders = calls.render;
  const typed = `${text}- **Jeroen** — heard as “Yeroen”`;
  ctl.input({ dataset: { msInput: 'md', k: 'glossary' }, value: typed });
  assert.equal(calls.render, renders, 'typing never re-renders the textarea');
  const summary = calls.patches.filter(([sel]) => sel === '[data-md-summary="glossary"]').at(-1)?.[1] || '';
  assert.match(summary, /2 spelling fixes/);
  assert.match(summary, /<span>Yeroen<\/span>[^]*<strong>Jeroen<\/strong>/);
  assert.match(calls.patches.filter(([sel]) => sel === '[data-md-status="glossary"]').at(-1)?.[1] || '', /Saving…/);
  assert.equal(calls.save.length, 0, 'saved once typing pauses');
  await runTimers();
  assert.deepEqual(calls.save, [['meeting_text_save', { name: 'glossary', text: typed }]]);
  assert.equal(calls.glossaryChanged, 1, 'the Meetings page reads the glossary again (transcript underlines)');
  assert.match(calls.patches.filter(([sel]) => sel === '[data-md-status="glossary"]').at(-1)?.[1] || '', /Saved/);
  assert.equal(v().texts.glossary.text, typed);
  html = panel();
  assert.match(html, /Yeroen/);
  // A refused save says why next to the editor and keeps the text.
  const refused = harness({ tab: 'meetings-glossary', answers: { meeting_text: { text, path: '/x/glossary.md', linked: false }, meeting_text_save: failure('too_large', 'Keep the glossary and the tag list to 100 KB each.') } });
  await refused.ctl.load();
  refused.ctl.input({ dataset: { msInput: 'md', k: 'glossary' }, value: 'x'.repeat(10) });
  await refused.runTimers();
  assert.match(refused.calls.patches.filter(([sel]) => sel === '[data-md-status="glossary"]').at(-1)?.[1] || '', /role="alert"[^>]*>[^]*Keep the glossary and the tag list to 100 KB each\./);
  assert.equal(refused.v().texts.glossary.text, 'x'.repeat(10));
});

test('a glossary that could not be read, or was read only in part, is shown read-only and never saved', async () => {
  const unreadable = failure('unreadable', 'Connect can’t read glossary.md (it isn’t allowed to open it), so it won’t change it. Check the file in Finder, then try again.');
  const long = `- \`meeting\` — every meeting note\n${'- **Term** — a long list\n'.repeat(3)}`;
  let glossary = unreadable;
  const answers = { meeting_text: d => { if (d.name === 'tags') return { text: long, path: '/x/tags.md', linked: false, cut: true }; if (glossary instanceof Error) throw glossary; return glossary; } };
  const { ctl, calls, v, panel, runTimers } = harness({ tab: 'meetings-glossary', answers });
  await ctl.load();
  const html = panel();
  const card = kind => html.slice(html.indexOf(`data-md-card="${kind}"`), html.indexOf('</section>', html.indexOf(`data-md-card="${kind}"`)));
  // Not read: why, and Try again; no editor, nothing to restore, no "Your text is still here".
  assert.doesNotMatch(card('glossary'), /<textarea/);
  assert.match(card('glossary'), /role="alert"[^]*Connect can’t read glossary\.md/);
  assert.match(card('glossary'), /data-action="meetings-settings-md-reread"[^>]*data-k="glossary"[^>]*>[^]*Try again/);
  assert.doesNotMatch(card('glossary'), /Your text is still here/);
  assert.doesNotMatch(card('glossary'), /Restore the example/);
  assert.doesNotMatch(card('glossary'), /data-action="meetings-settings-md-tab"/);
  // Read in part: the first 100 KB shown read-only, with what to do.
  assert.doesNotMatch(card('tags'), /<textarea/);
  assert.match(card('tags'), /longer than 100 KB/);
  assert.match(card('tags'), /<code>meeting<\/code>/, 'the text is shown');
  assert.match(card('tags'), /data-action="meetings-settings-md-reread"[^>]*data-k="tags"/);
  assert.doesNotMatch(card('tags'), /Restore the example/);
  // Typing (a stale editor) and Restore the example change nothing.
  for (const k of ['glossary', 'tags']) {
    ctl.input({ dataset: { msInput: 'md', k }, value: 'typed' });
    await ctl.handle('meetings-settings-md-flush', control({ k }));
    await ctl.handle('meetings-settings-md-reset', control({ k }));
  }
  await runTimers();
  assert.equal(calls.timers.length, 0);
  assert.deepEqual([...calls.save, ...calls.mutate].filter(([op]) => op === 'meeting_text_save'), []);
  // Try again reads it once more; now it can be edited and saved.
  glossary = { text: '## Me\n**Taylor Morgan**\n', path: '/x/glossary.md', linked: false, cut: false };
  await ctl.handle('meetings-settings-md-reread', control({ k: 'glossary' }));
  assert.deepEqual(calls.query.at(-1), ['meeting_text', { name: 'glossary' }]);
  const patched = calls.patches.filter(([sel]) => sel === '[data-md-card="glossary"]').at(-1)?.[1] || '';
  assert.match(patched, /<textarea[^>]*data-k="glossary"[^>]*>## Me/);
  ctl.input({ dataset: { msInput: 'md', k: 'glossary' }, value: '## Me\n**Taylor Morgan** — “TM”' });
  await runTimers();
  assert.deepEqual(calls.save, [['meeting_text_save', { name: 'glossary', text: '## Me\n**Taylor Morgan** — “TM”' }]]);
  // Restored, then the file can't be read: Undo doesn't write over it.
  await ctl.handle('meetings-settings-md-reset', control({ k: 'glossary' }));
  const undo = calls.toasts.find(t => /back to the example/.test(t.message));
  v().texts.glossary = { text: '', read: 'failed', readError: 'Connect can’t read glossary.md.', state: 'idle' };
  const writes = calls.mutate.length;
  await undo.action.run();
  assert.equal(calls.mutate.length, writes, 'Undo writes nothing over a file Connect could not read');
  assert.match(calls.toasts.at(-1).message, /can’t read glossary\.md/);
});

test('linked mode shows the file path read-only and hides Restore the example', async () => {
  const s = snapshot();
  Object.assign(s.settings.meetings, { glossarySource: 'file', glossaryFile: '/Users/taylor/knowledge/TERMS_TAXONOMY.md', tagsFile: '/Users/taylor/knowledge/TAG_TAXONOMY.md' });
  const answers = { meeting_text: d => ({ text: d.name === 'glossary' ? '## Me\n**Taylor Morgan**\n- **LiteLLM** — heard as “light LLM”\n' : '- `meeting`\n- `pilot`\n', path: d.name === 'glossary' ? s.settings.meetings.glossaryFile : s.settings.meetings.tagsFile, linked: true }) };
  const { ctl, calls, panel } = harness({ s, tab: 'meetings-glossary', answers });
  await ctl.load();
  const html = panel();
  assert.match(html, /name="glossarySource" value="file"[^>]* checked/);
  assert.match(html, /Read from <code>\/Users\/taylor\/knowledge\/TERMS_TAXONOMY\.md<\/code>/);
  assert.match(html, /Read from <code>\/Users\/taylor\/knowledge\/TAG_TAXONOMY\.md<\/code>/);
  assert.doesNotMatch(html, /<textarea[^>]*data-ms-input="md"/, 'no editor');
  assert.doesNotMatch(html, /Restore the example/);
  assert.doesNotMatch(html, /data-action="meetings-settings-md-tab"/, 'no Write/Preview');
  assert.match(html, /<strong>LiteLLM<\/strong>/, 'what Connect picks up still shows');
  assert.match(html, /2 tags/);
  // Where the files are: two full paths, saved when left.
  assert.match(html, /data-commit="meetings-settings-field" data-key="glossaryFile"[^>]*value="\/Users\/taylor\/knowledge\/TERMS_TAXONOMY\.md"/);
  await ctl.handle('meetings-settings-field', control({ key: 'tagsFile' }, { value: '  /Users/taylor/knowledge/TAGS.md ' }));
  assert.deepEqual(calls.mutate.at(-1), ['settings_update', { meetings: { tagsFile: '/Users/taylor/knowledge/TAGS.md' } }]);
  // Nothing is ever written to a linked file.
  ctl.input({ dataset: { msInput: 'md', k: 'glossary' }, value: 'typed' });
  assert.equal(calls.timers.length, 0);
  assert.equal(calls.save.length, 0);
});

test('transcripts toggle asks for meetings and transcripts capabilities', async () => {
  const OFF = /<input(?=[^>]*data-action="meetings-settings-transcripts")(?![^>]*\schecked\b)[^>]*>/;
  const ON = /<input(?=[^>]*data-action="meetings-settings-transcripts")(?=[^>]*\schecked\b)[^>]*>/;
  const s = snapshot();
  s.connection.enabled = ['calendar', 'mail', 'chats'];
  s.connection.scopes = ['Calendars.Read', 'Mail.Read', 'Chat.Read'];
  // The same connect path as the Meetings page's Turn on.
  const connected = [];
  const modals = [];
  const meetingsUi = createMeetingsController({
    state: { route: 'settings', meetings: newMeetingsView(), tasks: newTasksView() }, snap: () => s, store: { query: async () => ({}) },
    mutate: async () => ({}), render: async () => {}, confirmModal: options => modals.push(options), connect: async caps => { connected.push(caps); },
  });
  const { ctl, calls, panel } = harness({ s, tab: 'meetings-transcripts', transcriptsOn: meetingsUi.transcriptsOn });
  let html = panel();
  assert.match(html, OFF);
  assert.match(html, /Read Teams transcripts/);
  const toggle = control({}, { checked: true });
  await ctl.handle('meetings-settings-transcripts', toggle);
  assert.equal(toggle.checked, false, 'stays off until Microsoft says yes');
  assert.equal(modals.at(-1).title, 'Read Teams transcripts?');
  await modals.at(-1).onConfirm();
  assert.deepEqual(connected, [['meetings', 'transcripts']]);
  // Declined in Microsoft: still off, with the reason.
  html = meetingsSettingsPanel('meetings-transcripts', s, { v: newMeetingsSettingsView(), auth: { authError: 'The user declined to consent.' }, now: NOW });
  assert.match(html, OFF);
  assert.match(html, /The user declined to consent\./);
  // Allowed: on; turning it off keeps every other capability.
  s.connection.enabled = ['calendar', 'mail', 'chats', 'meetings', 'transcripts'];
  s.connection.scopes = [...s.connection.scopes, 'OnlineMeetings.Read', 'OnlineMeetingTranscript.Read.All'];
  html = panel();
  assert.match(html, ON);
  await ctl.handle('meetings-settings-transcripts', control({}, { checked: false }));
  assert.deepEqual(calls.mutate.at(-1), ['settings_update', { capabilities: ['calendar', 'mail', 'chats'] }]);
  assert.match(calls.toasts.at(-1).message, /stopped reading Teams transcripts/);
});

// ---------------------------------------------------------------- more

test('rules: add focuses the new rule, a value saves when left, delete offers Undo and keeps focus', async () => {
  const { ctl, calls, v, panel } = harness({ tab: 'meetings-rules', answers: { meeting_rule_save: d => ({ id: d.id || 'r-new' }), meeting_rule_delete: d => ({ deleted: true, id: d.id, body: { field: 'title', value: 'stand-up', template: 'short-summary', autoNotes: false, on: true, order: 1 } }) } });
  let html = panel();
  assert.ok(html.indexOf('“stand-up”') < 0 || true);
  assert.ok(html.indexOf('value="stand-up"') < html.indexOf('value="philips"'), 'rules in their order');
  assert.match(html, /Otherwise use/);
  await ctl.handle('meetings-settings-rule-add', control());
  assert.deepEqual(calls.mutate.at(-1), ['meeting_rule_save', { field: 'title', value: '', template: 'meeting-notes', autoNotes: false, on: true }]);
  assert.deepEqual(calls.focus.at(-1), '[data-commit="meetings-settings-rule-value"][data-id="r-new"]');
  await ctl.handle('meetings-settings-rule-value', control({ id: 'r-standup' }, { value: ' daily ' }));
  assert.deepEqual(calls.mutate.at(-1), ['meeting_rule_save', { id: 'r-standup', value: 'daily' }]);
  const before = calls.mutate.length;
  await ctl.handle('meetings-settings-rule-value', control({ id: 'r-philips' }, { value: 'philips' }));
  assert.equal(calls.mutate.length, before, 'an unchanged value sends nothing');
  // A refused value shows next to it.
  const refused = harness({ tab: 'meetings-rules', answers: { meeting_rule_save: failure('validation', 'Keep the rule’s text to 200 characters.', 'value') } });
  await refused.ctl.handle('meetings-settings-rule-value', control({ id: 'r-standup' }, { value: 'x'.repeat(201) }));
  html = refused.panel();
  assert.match(html, /data-error-for="rule\.r-standup\.value">Keep the rule’s text to 200 characters\./);
  assert.match(html, new RegExp(`data-commit="meetings-settings-rule-value" data-id="r-standup" value="${'x'.repeat(201)}"`), 'the refused text stays to be fixed');
  // Delete: Undo puts the rule back where it was; focus moves to the next rule meanwhile.
  await ctl.handle('meetings-settings-rule-delete', control({ id: 'r-standup' }));
  assert.deepEqual(calls.mutate.at(-1), ['meeting_rule_delete', { id: 'r-standup' }]);
  assert.deepEqual(calls.focus.at(-1), ['[data-action="meetings-settings-rule-delete"][data-id="r-philips"]', '[data-action="meetings-settings-rule-add"]']);
  const undo = calls.toasts.at(-1);
  assert.equal(undo.message, 'Rule deleted');
  await undo.action.run();
  assert.deepEqual(calls.mutate.at(-1), ['meeting_rule_save', { id: 'r-standup', field: 'title', value: 'stand-up', template: 'short-summary', autoNotes: false, on: true, order: 1 }]);
  assert.deepEqual(calls.focus.at(-1), '[data-action="meetings-settings-rule-delete"][data-id="r-standup"]');
  assert.equal(v().errors['rule.r-standup.value'], undefined);
});

test('every person-supplied string is escaped in Settings › Meetings', async () => {
  const s = snapshot();
  const evil = '<img src=x onerror=alert(1)>';
  s.noteTemplates.push({ id: 'mine', name: evil, kind: 'custom', blurb: evil, prompt: `${evil} {{title}}`, sections: ['summary'], extractTasks: true, color: '"><script>', icon: 'note', skillPath: null, edited: false });
  s.noteTemplates.push({ id: 'skill-x', name: `Skill ${evil}`, kind: 'skill', blurb: '', prompt: '', sections: [], extractTasks: true, color: '#7B3FBF', icon: 'shield', skillPath: `/Users/taylor/.claude/skills/${evil}/SKILL.md`, edited: false });
  s.records.push({ id: 'r-evil', kind: 'meeting_rule', source: 'local', connectionId: null, workspaceId: 'personal', revision: 'r', updatedAt: 1, data: { field: 'title', value: evil, template: 'mine', autoNotes: false, on: true, order: 5 } });
  s.settings.meetings.glossarySource = 'file';
  s.settings.meetings.glossaryFile = `/Users/${evil}/g.md`;
  const v = { ...newMeetingsSettingsView(), texts: { glossary: { text: `## Me\n**${evil}**\n- **${evil}** — heard as “${evil}”`, path: `/Users/${evil}/g.md`, linked: true }, tags: { text: `- \`${evil}\``, path: '/t.md', linked: true } }, test: { title: evil, people: 3 } };
  const all = MEETING_TABS.map(tab => meetingsSettingsPanel(tab, s, { v, auth: { authError: evil }, now: NOW })).join('');
  const h = harness({ s });
  await h.ctl.handle('meetings-settings-tpl-edit', control({ id: 'mine' }));
  const editor = h.panel();
  const skill = harness({ s });
  await skill.ctl.handle('meetings-settings-tpl-edit', control({ id: 'skill-x' }));
  for (const html of [all, editor, skill.panel()]) {
    assert.doesNotMatch(html, /<img src=x/);
    assert.doesNotMatch(html, /<script>/);
  }
  assert.match(all, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(all, /--tpl:"/, 'a colour reaches style only as a hex colour');
});

test('add a skill from meeting_skills or a SKILL.md path', async () => {
  const skills = [{ name: 'interview-review', path: '/Users/taylor/.claude/skills/interview-review/SKILL.md', description: 'Assessment of an interview you ran.' }, { name: 'teams-transcript', path: '/Users/taylor/.claude/skills/teams-transcript/SKILL.md', description: '' }];
  const s = snapshot();
  s.noteTemplates.push({ id: 'skill-tt', name: 'Teams transcript', kind: 'skill', blurb: '', prompt: '', sections: [], extractTasks: true, color: '#7B3FBF', icon: 'shield', skillPath: skills[1].path, edited: false });
  const { ctl, calls } = harness({ s, answers: { meeting_skills: skills, template_save: { id: 'skill-new' } } });
  await ctl.handle('meetings-settings-skill-add', control());
  const dialog = calls.modals.at(-1);
  assert.equal(dialog.title, 'Use a skill as a note template');
  assert.match(dialog.body, /name="skill" value="\/Users\/taylor\/\.claude\/skills\/interview-review\/SKILL\.md" checked/);
  assert.match(dialog.body, /value="\/Users\/taylor\/\.claude\/skills\/teams-transcript\/SKILL\.md" disabled/, 'one already added');
  assert.match(dialog.body, /Added/);
  const form = new FormData();
  form.append('skill', skills[0].path);
  form.append('path', '');
  await dialog.onSubmit(form, { querySelector: () => null });
  assert.deepEqual(calls.mutate.at(-1), ['template_save', { kind: 'skill', name: 'Interview review', blurb: 'Assessment of an interview you ran.', skillPath: skills[0].path, sections: [], extractTasks: true }]);
  assert.match(calls.toasts.at(-1).message, /“Interview review” is now a note template/);
  await calls.toasts.at(-1).action.run();
  // A typed path wins over the list; a refused path shows next to it and the dialog stays.
  const refused = harness({ s, answers: { meeting_skills: [], template_save: failure('validation', 'Choose the skill’s SKILL.md by its full path.', 'skillPath') } });
  await refused.ctl.handle('meetings-settings-skill-add', control());
  const shown = [];
  const el = { textContent: '', hidden: true };
  const dialog2 = refused.calls.modals.at(-1);
  assert.match(dialog2.body, /No Claude Code skills in ~\/\.claude\/skills yet/);
  const f2 = new FormData();
  f2.append('path', 'skills/x.md');
  const kept = await dialog2.onSubmit(f2, { querySelector: sel => { shown.push(sel); return el; } });
  assert.equal(kept, false, 'the dialog stays open');
  assert.equal(el.textContent, 'Choose the skill’s SKILL.md by its full path.');
  assert.equal(el.hidden, false);
  assert.ok(shown.includes('[data-error-for="skillPath"]'));
});

test('Try on a meeting makes notes with the template and offers the meeting', async () => {
  const { ctl, calls } = harness();
  await ctl.handle('meetings-settings-tpl-edit', control({ id: 'short-summary' }));
  await ctl.handle('meetings-settings-tpl-try', control());
  const dialog = calls.modals.at(-1);
  assert.equal(dialog.title, 'Try “Short summary” on a meeting');
  assert.match(dialog.body, /<option value="mtg-philips"/);
  assert.doesNotMatch(dialog.body, /<option value="mtg-sprint"/, 'only meetings with a transcript');
  const form = new FormData();
  form.append('meetingId', 'mtg-roadmap');
  await dialog.onSubmit(form);
  assert.deepEqual(calls.made.at(-1), ['mtg-roadmap', { templateId: 'short-summary', wishes: '', findTasks: true, remember: false }]);
  const toast = calls.toasts.at(-1);
  assert.match(toast.message, /Making “Short summary” for “Roadmap review”/);
  await toast.action.run();
  assert.deepEqual(calls.opened.at(-1), ['mtg-roadmap', 'notes']);
});

test('the latest document made with a template is read for the editor', async () => {
  const { ctl, calls, panel } = harness({ answers: { meeting_read: { text: '# Philips sync\n\n- **Export** ready' } } });
  await ctl.handle('meetings-settings-tpl-edit', control({ id: 'meeting-notes' }));
  await ctl.load();
  assert.deepEqual(calls.query.at(-1), ['meeting_read', { meetingId: 'mtg-philips', part: 'doc', docId: 'meeting-notes' }]);
  const html = panel();
  assert.match(html, /Latest notes made with it/);
  assert.match(html, /Philips CodeMie conversations syncup/);
  assert.match(html, /<strong>Export<\/strong> ready/);
  // Read once per document revision.
  await ctl.load();
  assert.equal(calls.query.filter(([op]) => op === 'meeting_read').length, 1);
});

test('a refused setting shows next to its field, and changing the folder offers Undo', async () => {
  const { ctl, calls, v, panel } = harness({ tab: 'meetings-transcripts', answers: { meetings_root_pick: '/Volumes/Gone', settings_update: failure('validation', 'That folder doesn’t exist. Choose another one.', 'root') } });
  await ctl.handle('meetings-settings-root-pick', control());
  assert.deepEqual(calls.mutate.at(-1), ['settings_update', { meetings: { root: '/Volumes/Gone' } }]);
  assert.match(panel(), /data-error-for="meetings\.root">That folder doesn’t exist\. Choose another one\./);
  // Picked and saved: new meetings go there, with Undo back to the default.
  const ok = harness({ tab: 'meetings-transcripts', answers: { meetings_root_pick: '/Volumes/Work/Meetings' } });
  ok.v().errors['meetings.root'] = 'old';
  await ok.ctl.handle('meetings-settings-root-pick', ok.v() && control());
  assert.deepEqual(ok.calls.mutate.at(-1), ['settings_update', { meetings: { root: '/Volumes/Work/Meetings' } }]);
  assert.equal(ok.v().errors['meetings.root'], undefined);
  const toast = ok.calls.toasts.at(-1);
  assert.match(toast.message, /New meeting folders go to \/Volumes\/Work\/Meetings\. Meetings saved before keep their folders\./);
  await toast.action.run();
  assert.deepEqual(ok.calls.mutate.at(-1), ['settings_update', { meetings: { root: null } }]);
  // Cancelled: nothing changes.
  const cancelled = harness({ tab: 'meetings-transcripts', answers: { meetings_root_pick: null } });
  await cancelled.ctl.handle('meetings-settings-root-pick', control());
  assert.equal(cancelled.calls.mutate.length, 0);
  // A switch that is refused goes back and says why.
  const sw = harness({ tab: 'meetings-tasks', answers: { settings_update: failure('validation', 'Turn this setting on or off.', 'review') } });
  const el = control({ key: 'review' }, { type: 'checkbox', checked: false });
  await sw.ctl.handle('meetings-settings-set', el);
  assert.equal(el.checked, true);
  assert.match(sw.panel(), /data-error-for="meetings\.review">Turn this setting on or off\./);
  // A refused path stays in its field with the reason under it.
  const path = harness({ tab: 'meetings-glossary', answers: { settings_update: failure('validation', 'Choose the glossary file by its full path.', 'glossaryFile') } });
  path.s.settings.meetings.glossarySource = 'file';
  await path.ctl.handle('meetings-settings-field', control({ key: 'glossaryFile' }, { value: 'knowledge/TERMS.md' }));
  const linked = path.panel();
  assert.match(linked, /data-key="glossaryFile" value="knowledge\/TERMS\.md"/);
  assert.match(linked, /data-error-for="meetings.glossaryFile">Choose the glossary file by its full path./);
  assert.ok(v());
});

test('a new meetings folder says which of the glossary and tags came along, and which it already had', async () => {
  const moved = texts => harness({ tab: 'meetings-transcripts', answers: { meetings_root_pick: '/Volumes/Work/Meetings', settings_update: { saved: true, texts } } });
  let h = moved({ copied: ['glossary.md', 'tags.md'], kept: [], failed: [] });
  await h.ctl.handle('meetings-settings-root-pick', control());
  assert.match(h.calls.toasts.at(-1).message, /^New meeting folders go to \/Volumes\/Work\/Meetings\. Meetings saved before keep their folders\. Your glossary and tag list were copied there\.$/);
  assert.equal(h.calls.toasts.at(-1).tone, 'success');
  assert.equal(h.calls.glossaryChanged, 1, 'the Meetings page reads the glossary again');
  h = moved({ copied: ['glossary.md'], kept: ['tags.md'], failed: [] });
  await h.ctl.handle('meetings-settings-root-pick', control());
  assert.match(h.calls.toasts.at(-1).message, /glossary\.md was copied there\. The folder already had its own tags\.md, so Connect kept it as it is\.$/);
  h = moved({ copied: [], kept: [], failed: ['glossary.md'] });
  await h.ctl.handle('meetings-settings-root-pick', control());
  const failed = h.calls.toasts.at(-1);
  assert.match(failed.message, /Connect couldn’t copy glossary\.md there: copy it from the old folder yourself\.$/);
  assert.equal(failed.tone, 'info', 'not a plain success');
  // Use the default: the same words.
  h = harness({ tab: 'meetings-transcripts', answers: { settings_update: { saved: true, texts: { copied: ['tags.md'], kept: [], failed: [] } } } });
  h.s.settings.meetings.root = '/Volumes/Work/Meetings';
  await h.ctl.handle('meetings-settings-root-default', control());
  assert.match(h.calls.toasts.at(-1).message, /^New meeting folders go to the default folder again\. Meetings saved before keep their folders\. tags\.md was copied there\.$/);
});

test('Edit the template from a document opens that template; settings ops rebase on a stale view', async () => {
  const { ctl, calls, v } = harness({ tab: 'general' });
  await ctl.editTemplate('short-summary');
  assert.deepEqual(calls.routes.at(-1), ['settings', 'meetings-templates']);
  assert.equal(v().edit.id, 'short-summary');
  // A clean editor closes when Note templates is opened again; one with changes stays.
  ctl.leaveEditor('meetings-templates');
  assert.equal(v().edit, null);
  await ctl.editTemplate('short-summary');
  ctl.input({ dataset: { msInput: 'tpl-blurb' }, value: 'Mine' });
  ctl.leaveEditor('meetings-templates');
  assert.equal(v().edit.id, 'short-summary');
  // Another template from a document while this one has changes: it asks first.
  await ctl.editTemplate('meeting-notes');
  const ask = calls.modals.at(-1);
  assert.match(ask.text, /Your changes to “Short summary” aren’t saved\. Open “Meeting notes” anyway\?/);
  assert.equal(v().edit.id, 'short-summary', 'nothing changes before the answer');
  ask.onClose();
  assert.equal(v().edit.id, 'short-summary', 'Cancel keeps the changes');
  ask.onConfirm();
  ask.onClose();
  await new Promise(r => setTimeout(r, 0));
  assert.equal(v().edit.id, 'meeting-notes');
  for (const op of ['template_save', 'template_delete', 'meeting_rule_save', 'meeting_rule_delete', 'meeting_rule_order', 'meeting_text_save']) assert.ok(REBASE_SAFE.has(op), op);
});

test('Restore the example writes native’s example, with the signed-in person under ## Me, and offers Undo', async () => {
  // The examples are native’s (glossary.rs EXAMPLE_GLOSSARY / EXAMPLE_TAGS, kept in glossary-parse.json).
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/contract/glossary-parse.json', import.meta.url), 'utf8'));
  assert.equal(EXAMPLE_TAGS, fixture.tags);
  assert.ok(fixture.glossary.startsWith(EXAMPLE_GLOSSARY));
  const s = snapshot();
  s.connection.displayName = 'Olena Kovalenko';
  s.connection.givenName = 'Olena';
  const mine = exampleText('glossary', s);
  assert.deepEqual(parseGlossary(mine).me, { name: 'Olena Kovalenko', aliases: ['Olena'], address: null });
  assert.equal(parseGlossary(mine).pairs.length, parseGlossary(EXAMPLE_GLOSSARY).pairs.length, 'the rest is the example');
  assert.equal(exampleText('glossary', { connection: null }), EXAMPLE_GLOSSARY);
  const { ctl, calls, v } = harness({ s, tab: 'meetings-glossary', answers: { meeting_text: d => ({ text: d.name === 'glossary' ? '## Me\n**Olena**' : '', path: `/x/${d.name}.md`, linked: false }) } });
  await ctl.load();
  await ctl.handle('meetings-settings-md-reset', control({ k: 'glossary' }));
  assert.deepEqual(calls.mutate.at(-1), ['meeting_text_save', { name: 'glossary', text: mine }]);
  assert.equal(v().texts.glossary.text, mine);
  const undo = calls.toasts.at(-1);
  assert.match(undo.message, /The glossary is back to the example/);
  await undo.action.run();
  assert.deepEqual(calls.mutate.at(-1), ['meeting_text_save', { name: 'glossary', text: '## Me\n**Olena**' }]);
  assert.equal(v().texts.glossary.text, '## Me\n**Olena**');
});
