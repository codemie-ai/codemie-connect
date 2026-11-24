// Automations (DESIGN 6.6): the list, the editor, the templates, the Run log and Today's
// Automation results card. Automations and runs come from the Rust contract fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  automations, automationEditor, draftFromAutomation, editorDraft, toAutomation, fieldForError, runLog, outputText,
  triggerSummary, newAutomationDraft, duplicateDraft, nextRunLabel, deliveriesSentence, errorTarget, needsSenders, TEMPLATES, AUTOMATIONS_DOCK,
} from '../workspace/view-automations.js';
import { createAutomationsController } from '../workspace/automations-controller.js';
import { moveTab, normalizeDock, visibleTabs } from '../workspace/dock-model.js';
import { draftError } from '../workspace/draft-state.js';
import { today, WIDGETS, WIDGET_IDS } from '../workspace/view-today.js';
import { inbox } from '../workspace/view-inbox.js';
import { decisions, INLINE_AI_JOBS } from '../workspace/selectors.js';
import { buildSnapshot, aiStatus, withAutomations, automationContract } from './fixtures/workspace-fixture.mjs';

const NOW = Date.now();
const nowSec = Math.floor(NOW / 1000);
const AI = { status: 'ready', ...aiStatus('both') };
const snapshot = () => withAutomations(buildSnapshot(NOW, { photo: false, zone: 'Europe/Kyiv' }), NOW);
const page = (s, ui = {}) => automations(s, { state: { ai: AI, automations: { tab: 'automations', runs: {}, ...ui } }, banners: '' });
const record = (s, kind, id) => s.records.find(r => r.kind === kind && r.id === id);
const count = (html, pattern) => (html.match(pattern) || []).length;
/** The first control tag whose attributes match `attrs` (a regex source), in any attribute order around it. */
const tagWith = (html, attrs) => html.match(new RegExp(`<(?:input|select|button|textarea|a)\\b[^>]*${attrs}[^>]*>`))?.[0] || '';
const unescape = text => text.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
/** A FormData for the editor, as the browser builds it from the rendered form. */
function form(fields) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const x of [].concat(v)) f.append(k, String(x));
  return f;
}

// ---------------------------------------------------------------- the list

test('automations_list_shows_trigger_summary_last_run_and_cost', () => {
  const s = snapshot();
  const html = page(s);
  // Both automations, each with its switch, a human trigger and the latest run.
  assert.match(tagWith(html, 'data-action="automation-toggle"[^>]*data-id="auto-brief"'), /\bchecked\b/);
  assert.match(html, /Weekdays at 08:45/);
  assert.match(unescape(html), /When mail arrives from @epam\.com or ann@example\.org about “budget”/);
  // Morning brief's latest run failed 5 minutes ago; Ann's drafted a reply with a cost estimate.
  // Rows are sorted by name: "Draft replies to Ann", then "Morning brief".
  const row = id => html.slice(html.indexOf(`data-automation="${id}"`)).split('role="listitem"')[0];
  const brief = row('auto-brief');
  assert.match(brief, /ws-badge-error[^>]*>Failed/);
  assert.match(brief, /5 min ago/);
  const reply = row('auto-reply');
  assert.match(reply, /ws-badge-success[^>]*>Done/);
  assert.match(reply, /20 min ago/);
  assert.match(reply, /≈ \$0\.01/, 'a subscription run shows Claude Code’s estimate');
  // Run now, and Edit, Duplicate and Delete in the ⋯ menu, for each automation.
  for (const action of ['automation-run', 'automation-edit', 'automation-duplicate', 'automation-delete']) {
    assert.ok(tagWith(html, `data-action="${action}"[^>]*data-id="auto-brief"`), action);
  }
  // The list, the Run log and the templates are the tabs of one section.
  assert.match(html, /data-action="dock-tab" data-page="automations" data-tab="auto-list" aria-selected="true"[^>]*>[^]*?<span>Automations<\/span><span class="ws-tab-count">2<\/span><\/button>/, 'with the number of automations');
  assert.match(html, /data-tab="auto-runs" aria-selected="false"/);
  assert.match(html, /data-tab="auto-templates" aria-selected="false"/);

  // A run in progress replaces the last run and Run now waits.
  s.jobs.push({ id: 'job-a', kind: 'automation_run', state: 'running', workspaceId: 'personal', connectionId: null, dueAt: nowSec, payload: { automationId: 'auto-brief', startedAt: nowSec - 4 }, policy: {} });
  const running = page(s);
  assert.match(running, /ws-badge-info[^>]*>Running/);
  assert.match(tagWith(running, 'data-action="automation-run"[^>]*data-id="auto-brief"'), /\bdisabled\b/);

  // Names and senders are the user's text: always escaped.
  record(s, 'automation', 'auto-reply').data.name = '<img src=x onerror=alert(1)>';
  assert.doesNotMatch(page(s), /<img src=x/);

  // Without automations: an empty state that leads to the templates.
  const empty = buildSnapshot(NOW, { photo: false });
  const none = page(empty);
  assert.match(none, /No automations yet/);
  assert.doesNotMatch(none, /ws-tab-count/, 'no count without automations');
  assert.ok(tagWith(none, 'data-action="automations-tab"[^>]*data-tab="templates"'));
  assert.match(none, /Start from a template/);
  // One primary action (the template), one secondary (New automation); the heading adds none.
  assert.equal(count(none, /data-action="automation-new"/g), 1);
  assert.match(tagWith(none, 'data-action="automation-new"'), /ws-btn-secondary/);
  assert.match(tagWith(none.slice(none.indexOf('ws-empty')), 'data-tab="templates"'), /ws-btn-primary/);
});

test('schedule rows say when they run next, in the workspace zone', () => {
  // Tuesday 17 November 2026, 10:00 UTC.
  const now = Date.parse('2026-11-17T10:00:00Z');
  const at = (days, time) => nextRunLabel({ trigger: { kind: 'schedule', days, time } }, 'UTC', now);
  assert.equal(at([1, 2, 3, 4, 5], '08:45'), 'Tomorrow 08:45');
  assert.equal(at([1, 2, 3, 4, 5], '17:30'), 'Today 17:30');
  assert.equal(at([5], '16:00'), 'Fri 16:00');
  assert.equal(at([2], '09:00'), 'Tue 09:00');
  // 20:00 UTC on Tuesday is 05:00 on Wednesday in Tokyo.
  const late = Date.parse('2026-11-17T20:00:00Z');
  assert.equal(nextRunLabel({ trigger: { kind: 'schedule', days: [1, 2, 3, 4, 5], time: '08:45' } }, 'UTC', late), 'Tomorrow 08:45');
  assert.equal(nextRunLabel({ trigger: { kind: 'schedule', days: [1, 2, 3, 4, 5], time: '08:45' } }, 'Asia/Tokyo', late), 'Today 08:45');
  assert.equal(nextRunLabel({ trigger: { kind: 'event', event: 'critical' } }, 'UTC', now), '');
  const s = snapshot();
  assert.match(page(s), /Next: (Today|Tomorrow|Mon|Tue|Wed|Thu|Fri) 08:45/);
  record(s, 'automation', 'auto-brief').data.enabled = false;
  assert.doesNotMatch(page(s), /Next:/, 'an automation that is off never runs next');
});

test('trigger summaries read like sentences', () => {
  const at = (days, time = '08:45') => triggerSummary({ trigger: { kind: 'schedule', days, time } });
  assert.equal(at([1, 2, 3, 4, 5]), 'Weekdays at 08:45');
  assert.equal(at([5], '16:00'), 'Fridays at 16:00');
  assert.equal(at([6, 7]), 'Weekends at 08:45');
  assert.equal(at([7, 1, 2, 3, 4, 5, 6]), 'Every day at 08:45');
  assert.equal(at([1, 3, 5]), 'Mon, Wed and Fri at 08:45');
  const on = (event, senders = [], keywords = []) => triggerSummary({ trigger: { kind: 'event', event, senders, keywords } });
  assert.equal(on('mail_from', ['@epam.com']), 'When mail arrives from @epam.com');
  assert.equal(on('mail_from', ['a@x.org', 'b@x.org', 'c@x.org', 'd@x.org']), 'When mail arrives from a@x.org, b@x.org or 2 more');
  assert.equal(on('chat_from', ['Ann Lee']), 'When a Teams message arrives from Ann Lee');
  assert.equal(on('critical'), 'When a critical item arrives');
  assert.equal(on('meeting_ended', [], ['planning']), 'When a meeting about “planning” ends');
});

// ---------------------------------------------------------------- the editor

test('Teams sender fields ask for names, because Teams messages carry no address', () => {
  const ctx = { zone: 'Europe/Kyiv', ai: AI };
  const editor = ev => {
    const draft = draftFromAutomation({ ...TEMPLATES[0].automation, trigger: { kind: 'event', event: ev, senders: [], keywords: [] } });
    return unescape(automationEditor(draft, ctx));
  };
  const chat = editor('chat_from');
  assert.match(chat, /Names as Teams shows them/);
  assert.doesNotMatch(chat, /addresses/i);
  assert.doesNotMatch(chat, /ann@epam\.com/);
  const critical = editor('critical');
  assert.match(critical, /Addresses, domains or Teams names/);
  assert.match(critical, /Leave it empty for every critical item/);
  // The backend's sentence for an address in a Teams rule shows at the senders field.
  assert.equal(fieldForError('Teams messages carry names, not addresses. Enter the name as Teams shows it, for example Ann Lee.'), 'auto-senders');
  assert.equal(fieldForError('"x" is not an email address, a domain such as epam.com or a name as Teams shows it.'), 'auto-senders');
});

test('editor_validates_and_hides_draft_reply_for_schedules', () => {
  const ctx = { zone: 'Europe/Kyiv', ai: AI };
  // A schedule: weekday chips, a time in the workspace zone, catch-up; no reply draft.
  const schedule = automationEditor(draftFromAutomation(TEMPLATES[0].automation), ctx);
  assert.equal(count(schedule, /data-day="\d"/g), 7);
  assert.equal(count(schedule, /data-day="\d"[^>]*checked/g), 5);
  assert.match(schedule, /id="auto-time"[^>]*value="08:07"/);
  assert.match(schedule, /Europe\/Kyiv/);
  assert.match(schedule, /id="auto-catchup"/);
  assert.doesNotMatch(schedule, /data-deliver="draftReply"/);
  assert.match(tagWith(schedule, 'data-deliver="today"'), /\bchecked\b/);
  // What it reads goes to the chosen provider, and each box says what it is.
  assert.match(tagWith(schedule, 'data-read="calendarToday"'), /\bchecked\b/);
  assert.match(schedule, /Claude Code \(Anthropic\)/);
  assert.match(schedule, /Your meetings today/);
  assert.match(schedule, /select[^>]*name="auto-profile"/);
  assert.match(schedule, /id="auto-cap"/);
  assert.match(schedule, /CodeMie/);
  assert.match(schedule, /data-auto-count[^>]*>\d+ \/ 4,000/);

  // Mail from someone with a reply draft: the triggering conversation is ticked and locked.
  const event = draftFromAutomation(automationContract().automation.event.data);
  const reply = automationEditor(event, ctx);
  assert.match(tagWith(reply, 'data-deliver="draftReply"'), /\bchecked\b/);
  const locked = tagWith(reply, 'data-read="triggerConversation"');
  assert.match(locked, /\bchecked\b/);
  assert.match(locked, /\bdisabled\b/);
  assert.match(reply, /type="hidden" name="auto-read" value="triggerConversation"/);
  assert.match(reply, /A reply draft needs the message it answers/);
  assert.match(reply, /select[^>]*name="auto-event"/);
  assert.match(reply, /id="auto-senders"[^>]*value="@epam\.com, ann@example\.org"/);
  // A critical item or an ended meeting has no reply draft either.
  for (const kind of ['critical', 'meeting_ended']) {
    assert.doesNotMatch(automationEditor({ ...event, event: kind }, ctx), /data-deliver="draftReply"/, kind);
  }

  // What is saved follows the trigger: a schedule never asks for a reply draft.
  const switched = editorDraft(form({
    'auto-id': 'auto-x', 'auto-enabled': 'true', 'auto-name': 'Wrap-up', 'auto-kind': 'schedule', 'auto-day': [1, 5], 'auto-time': '17:30',
    'auto-event': 'mail_from', 'auto-senders': 'ann@example.org', 'auto-read': ['triggerConversation', 'needsReply'],
    'auto-prompt': 'Wrap up.', 'auto-profile': '', 'auto-model': '', 'auto-cap': '', 'auto-deliver': ['today', 'draftReply'],
  }));
  assert.deepEqual(toAutomation(switched), {
    id: 'auto-x', name: 'Wrap-up', enabled: true,
    trigger: { kind: 'schedule', days: [1, 5], time: '17:30' },
    read: { calendarToday: false, needsReply: true, triggerConversation: false, mailFromSenderDays: 0, commitmentsNotes: false, recentMessages: false },
    prompt: 'Wrap up.', ai: { profile: null, model: null }, capUsd: null,
    deliver: { today: true, notify: false, draftReply: false, createTasks: false, meetingSummary: null }, catchUp: false,
  });
  // A reply draft reads the triggering conversation even when its box was locked (not sent).
  const mail = toAutomation({ ...switched, kind: 'event', read: { ...switched.read, triggerConversation: false }, cap: '0.5', profile: 'codemie:prod', model: 'claude-haiku-4-5' });
  assert.deepEqual(mail.trigger, { kind: 'event', event: 'mail_from', senders: ['ann@example.org'], keywords: [] });
  assert.equal(mail.read.triggerConversation, true);
  assert.equal(mail.deliver.draftReply, true);
  assert.equal(mail.capUsd, 0.5);
  assert.deepEqual(mail.ai, { profile: 'codemie:prod', model: 'claude-haiku-4-5' });
  assert.throws(() => toAutomation({ ...switched, cap: 'a lot' }), /Enter the cost cap in US dollars/);

  // The backend's sentence shows at the field it is about.
  assert.equal(fieldForError('Add at least one sender or domain for this trigger.'), 'auto-senders');
  assert.equal(fieldForError('"bob" is not an email address or a domain such as epam.com.'), 'auto-senders');
  assert.equal(fieldForError('Give the automation a name (up to 80 characters).'), 'auto-name');
  assert.equal(fieldForError('Write the instructions for the automation.'), 'auto-prompt');
  assert.equal(fieldForError('Choose at least one day for the schedule.'), 'auto-days');
  assert.equal(fieldForError('Enter the time as HH:MM, for example 08:45.'), 'auto-time');
  assert.equal(fieldForError('The cost cap must be between 0.01 and 100 US dollars.'), 'auto-cap');
  assert.equal(fieldForError('You can keep up to 50 automations. Delete one first.'), null);
  // Native names the field; a field the trigger doesn't show never holds an error.
  assert.deepEqual(errorTarget({ code: 'validation', field: 'senders', message: 'Use up to 50 senders.' }, event), { field: 'auto-senders', message: 'Use up to 50 senders.' });
  assert.equal(errorTarget({ code: 'validation', field: 'senders', message: 'Use up to 50 senders.' }, { ...event, kind: 'schedule' }), null);
  assert.equal(errorTarget({ code: 'validation', field: 'time', message: 'Enter the time as HH:MM, for example 08:45.' }, event), null);
  assert.equal(errorTarget({ code: 'stale_view', message: 'Your inbox changed.' }, event), null);
  // The cap is off (and holds no error) when the run uses Claude Code.
  const nativeCap = { ...event, profile: 'claude', cap: '' };
  assert.equal(errorTarget({ code: 'validation', field: 'capUsd', message: 'The cost cap must be between 0.01 and 100 US dollars.' }, nativeCap, AI), null);
  assert.equal(errorTarget({ code: 'validation', field: 'capUsd', message: 'The cost cap must be between 0.01 and 100 US dollars.' }, { ...event, profile: 'codemie:prod' }, AI).field, 'auto-cap');
  assert.match(tagWith(automationEditor(nativeCap, ctx), 'id="auto-cap"'), /\bdisabled\b/);
  // A cap set earlier is kept while it is off: sent from a hidden field, shown greyed out.
  const keptCap = automationEditor({ ...nativeCap, cap: '0.5' }, ctx);
  assert.match(keptCap, /<input type="hidden" name="auto-cap" value="0\.5">/);
  assert.doesNotMatch(tagWith(keptCap, 'id="auto-cap"'), /name=/, 'the disabled input sends nothing itself');
  const kept = editorDraft(form({ 'auto-kind': 'event', 'auto-event': 'mail_from', 'auto-senders': 'a@b.co', 'auto-profile': 'claude', 'auto-cap': '0.5' }));
  assert.equal(kept.cap, '0.5');
  assert.equal(toAutomation(kept).capUsd, 0.5);
  // Switching to CodeMie in the editor shows the same cap, live again.
  assert.match(tagWith(automationEditor({ ...kept, profile: 'codemie:prod' }, ctx), 'id="auto-cap"'), /value="0\.5"/);
  assert.doesNotMatch(tagWith(automationEditor({ ...kept, profile: 'codemie:prod' }, ctx), 'id="auto-cap"'), /\bdisabled\b/);
  assert.doesNotMatch(tagWith(automationEditor({ ...event, profile: 'codemie:prod' }, ctx), 'id="auto-cap"'), /\bdisabled\b/);
  assert.ok(needsSenders(draftFromAutomation(TEMPLATES.find(t => t.id === 'draft-replies').automation)));
  assert.ok(!needsSenders(event));
  // An automation run never offers "Draft again".
  assert.notEqual(draftError({ id: 'r', state: 'failed', errorCode: 'conflict', payload: { automationId: 'a' } }, { kind: 'automation' }).action?.label, 'Draft again');
  const invalid = automationEditor({ ...event, senders: '' }, { ...ctx, error: { field: 'auto-senders', message: 'Add at least one sender or domain for this trigger.' } });
  assert.match(invalid, /id="auto-senders"[^>]*aria-invalid="true"/);
  assert.match(invalid, /class="ws-field-error"[^>]*>Add at least one sender or domain for this trigger\./);
});

test('profiles, models and the cap hint follow the chosen Claude', () => {
  const ctx = { zone: 'UTC', ai: AI };
  const base = newAutomationDraft();
  const html = automationEditor(base, ctx);
  assert.match(html, /<option value="" selected>Default · Claude Code<\/option>/);
  assert.match(html, /name="auto-model"[^>]*disabled/);
  const codemie = automationEditor({ ...base, profile: 'codemie:prod' }, ctx);
  assert.match(codemie, /<option value="claude-haiku-4-5"/);
  assert.match(codemie, /CodeMie · prod/);
  assert.match(codemie, /--max-budget-usd/);
  const native = automationEditor({ ...base, profile: 'claude' }, ctx);
  assert.match(native, /<option value="sonnet"/);
  assert.match(native, /ignores it/);
});

// ---------------------------------------------------------------- templates

test('template_prefills_editor', () => {
  assert.deepEqual(TEMPLATES.map(t => t.name), ['Morning briefing', 'Inbox triage', 'Commitments', 'Budget request reply', 'Formal meeting summary', 'Draft replies to someone', 'End-of-day wrap-up', 'Weekly reflection']);
  assert.deepEqual(TEMPLATES.map(t => triggerSummary(t.automation)), ['Weekdays at 08:07', 'Weekdays at 08:00', 'Weekdays at 08:03', 'When mail arrives from the people you name about “budget”', 'When a meeting’s transcript is ready', 'When mail arrives from the people you name', 'Weekdays at 17:30', 'Fridays at 16:00']);
  const cards = page(snapshot(), { tab: 'templates' });
  for (const t of TEMPLATES) assert.ok(tagWith(cards, `data-action="automation-template"[^>]*data-id="${t.id}"`), t.id);
  assert.match(cards, /Use template/);
  assert.match(cards, /Delivers to Today and a notification\./);
  assert.equal(deliveriesSentence({ today: true, draftReply: true }), 'Delivers to Today and a reply draft.');
  assert.equal(deliveriesSentence({ today: true, notify: true, draftReply: true }), 'Delivers to Today, a notification and a reply draft.');

  const brief = draftFromAutomation(TEMPLATES[0].automation);
  const html = automationEditor(brief, { zone: 'UTC', ai: AI });
  assert.match(html, /id="auto-name"[^>]*value="Morning briefing"/);
  assert.match(html, /name="auto-id" value=""/);
  assert.ok(brief.prompt.length > 40 && brief.prompt.length <= 4000);
  const saved = toAutomation(brief);
  assert.deepEqual(saved.trigger, { kind: 'schedule', days: [1, 2, 3, 4, 5], time: '08:07' });
  assert.equal(saved.id, '');
  assert.equal(saved.deliver.today, true);
  assert.equal(saved.catchUp, true);

  // Draft replies to someone: mail from people you name, delivering a reply draft.
  const replies = automationEditor(draftFromAutomation(TEMPLATES.find(t => t.id === 'draft-replies').automation), { zone: 'UTC', ai: AI });
  assert.match(tagWith(replies, 'data-deliver="draftReply"'), /\bchecked\b/);
  assert.match(replies, /id="auto-senders"[^>]*value=""/);
  assert.deepEqual(toAutomation(draftFromAutomation(TEMPLATES.find(t => t.id === 'weekly-reflection').automation)).trigger.days, [5]);

  // Duplicate: a copy that stays off until it is turned on.
  const copy = toAutomation(duplicateDraft(record(snapshot(), 'automation', 'auto-brief')));
  assert.equal(copy.id, '');
  assert.equal(copy.name, 'Copy of Morning brief');
  assert.equal(copy.enabled, false);
});

// ---------------------------------------------------------------- the Run log

test('run_log_expands_output_sources_and_error', () => {
  const s = snapshot();
  const { runsPage } = automationContract();
  const runs = [...runsPage.first.runs, ...runsPage.next.runs];
  const html = runLog(runs, { s, expanded: ['run-1', 'run-2'], ai: AI, next: runsPage.first.next });
  // Every run: when, which automation and trigger, status, duration and cost.
  assert.equal(count(html, /data-action="run-toggle"/g), 3);
  assert.match(html, /data-action="run-toggle" data-id="run-3" aria-expanded="false"/);
  assert.match(html, /data-action="run-toggle" data-id="run-1" aria-expanded="true"/);
  assert.match(html, /Draft replies to Ann/);
  assert.match(html, /Mail from Ann Lee/);
  assert.match(html, /3\.1 s/);
  assert.doesNotMatch(html, /Reply drafted for Ann/, 'a collapsed run hides its output');
  // The ok run: blocks (heading, bold, a web link by index), items with their sources.
  const ok = html.slice(html.indexOf('id="run-run-1"'));
  assert.match(ok, /2 replies owed/);
  assert.match(ok, /<h4[^>]*>Replies<\/h4>/);
  assert.match(ok, /<strong>Q3 budget<\/strong>/);
  assert.match(tagWith(ok, 'title="https://example\\.test/plan"'), /<button[^>]*data-action="run-link"[^>]*data-id="run-1"[^>]*data-link="0"/);
  // No address the app window could follow: a link is a button that opens through native. The
  // only href is Connect's own Tasks page, for the task the run made.
  assert.doesNotMatch(html.replace(/href="#\/tasks"/g, ''), /href=/);
  assert.match(ok, /Answer Ann about the Q3 budget[\s\S]*?data-action="open-message" data-id="m0"/);
  assert.match(ok, /Invented source/);
  assert.match(ok, /Send the roadmap/);
  assert.ok(tagWith(ok, 'data-action="run-copy"[^>]*data-id="run-1"'));
  // The failed run: Claude's sentence and its action, no output.
  const failed = html.slice(html.indexOf('id="run-run-2"'), html.indexOf('data-action="run-toggle" data-id="run-1"'));
  assert.match(failed, /Claude Code isn(’|'|&#39;)t signed in\./);
  assert.match(failed, /data-action="ai-copy-login"/);
  assert.doesNotMatch(failed, /data-action="run-copy"/);
  assert.match(html, /data-action="automation-runs-more"/);
  assert.doesNotMatch(runLog(runs, { s, ai: AI }), /automation-runs-more/);

  // A failure that is not Claude's says what the run needed.
  const signedOut = { ...runs[1], id: 'run-x', data: { ...runs[1].data, error: { class: null, code: 'needs_login', message: 'Sign in to Microsoft 365 in Settings. This automation reads your calendar or messages.' } } };
  const ms = runLog([signedOut], { s, expanded: ['run-x'], ai: AI });
  assert.match(ms, /Sign in to Microsoft 365 in Settings/);
  assert.match(ms, /data-tab="microsoft"/);

  // Rendered only from blocks: every text is escaped, only web links get an address, \n breaks.
  const hostile = { ...runs[2], id: 'run-h', data: { ...runs[2].data, output: { title: '<b>t</b>', summaryMarkdown: '<script>x</script>', items: [{ text: '<img src=x>' }], summaryBlocks: [
    { type: 'paragraph', inlines: [{ text: '<script>alert(1)</script>' }, { text: 'bad', href: 'javascript:alert(1)' }, { text: 'one\ntwo' }] },
  ] } } };
  const safe = runLog([hostile], { s, expanded: ['run-h'], ai: AI });
  assert.doesNotMatch(safe, /<script|<img src=x|<b>t|javascript:/);
  assert.match(safe, /one<br>two/);
  assert.doesNotMatch(safe, /&lt;script&gt;x/, 'summaryMarkdown is never rendered');

  // Copy takes the Markdown and the items as text.
  assert.equal(outputText(runs.find(r => r.id === 'run-1')), '2 replies owed\n\n### Replies\n\n- Ann asked about the **Q3 budget** p\n- See [the plan](https://example.test/plan)\n\n- Answer Ann about the Q3 budget\n- Invented source');

  // The tab shows the filter and an empty state before the first run.
  const empty = page(buildSnapshot(NOW, { photo: false }), { tab: 'runs', runs: { items: [], next: null } });
  assert.match(empty, /No runs yet/);
  assert.match(page(s, { tab: 'runs', runs: { items: runs, next: null, filter: 'auto-brief' } }), /name="auto-runs-filter"[\s\S]*<option value="auto-brief" selected>/);
});

test('the Run log loads when it sits beside Automations', async () => {
  // The spec's ids, minimum and default widths, and the pin to Today.
  assert.deepEqual(AUTOMATIONS_DOCK.initial, [['auto-list', 'auto-runs', 'auto-templates']]);
  assert.deepEqual(Object.entries(AUTOMATIONS_DOCK.tabs).map(([id, t]) => [id, t.title, t.min, t.w, t.pin]), [
    ['auto-list', 'Automations', 420, 900, 'automations'], ['auto-runs', 'Run log', 380, 600, undefined], ['auto-templates', 'Templates', 380, 600, undefined],
  ]);
  assert.equal(AUTOMATIONS_DOCK.tabs['auto-list'].pinTitle, WIDGETS.automations.title);
  // Run log dragged to the right of the list: both are drawn, under the page's heading.
  const s = snapshot();
  const { runsPage } = automationContract();
  const beside = moveTab(normalizeDock(AUTOMATIONS_DOCK, null), AUTOMATIONS_DOCK, 'auto-runs', { type: 'split', pane: 'p1', side: 'right' }).layout;
  assert.deepEqual(visibleTabs(beside), ['auto-list', 'auto-runs']);
  const ui = { tab: 'automations', runs: { items: runsPage.first.runs, next: null } };
  const html = automations(s, { state: { ai: AI, automations: ui }, banners: '', dock: { layouts: { automations: beside }, locked: false } });
  assert.match(html, /^<div class="ws-automations">\s*<header class="ws-page-heading">[^]*<h1>Automations<\/h1>[^]*<\/header>\s*<div class="ws-dock" data-page="automations">/);
  const [listAt, runsAt] = [html.indexOf('class="ws-card ws-auto-list"'), html.indexOf('name="auto-runs-filter"')];
  assert.ok(listAt > 0 && listAt < runsAt, 'the list, then the Run log');
  assert.match(html, /class="ws-dock-tab" role="tab" id="dock-automations-tab-auto-runs" data-action="dock-tab" data-page="automations" data-tab="auto-runs" aria-selected="true"/);
  // The controller reads the Run log because it is in view, though Automations was chosen last.
  let layout = normalizeDock(AUTOMATIONS_DOCK, null);
  const state = { route: 'automations', ai: AI, automations: { tab: 'automations', highlight: null, runs: { items: null, next: null, error: '', filter: '', expanded: [], loadingMore: false } } };
  const queries = [];
  const ctl = createAutomationsController({
    state, store: { query: async (op, data) => { queries.push([op, data]); return runsPage.first; } }, snap: () => s,
    mutate: async () => ({}), route: async () => {}, render: async () => {}, openModal: () => null, confirmModal: () => {}, toast: () => {},
    ensureClaudeChoice: async () => null, writeText: async () => {},
    dock: { visible: () => visibleTabs(layout) },
  });
  assert.equal(ctl.runLogOpen(), false, 'hidden behind the list');
  layout = beside;
  assert.equal(ctl.runLogOpen(), true);
  await ctl.follow(['auto-runs']);
  assert.deepEqual(queries.map(([op]) => op), ['automation_runs']);
  assert.deepEqual(state.automations.runs.items.map(r => r.id), runsPage.first.runs.map(r => r.id));
  assert.equal(state.automations.tab, 'runs', 'the hash names the tab brought into view');
  // Out of view again: the tab in view is the one the hash names.
  layout = normalizeDock(AUTOMATIONS_DOCK, null);
  await ctl.follow();
  assert.deepEqual([state.automations.tab, queries.length], ['automations', 1]);
});

// ---------------------------------------------------------------- Today

test('today_automation_card_shows_latest_results_with_sources', () => {
  assert.equal(WIDGETS.automations.title, 'Automation results');
  assert.equal(WIDGETS.automations.width, 6);
  assert.ok(WIDGET_IDS.includes('automations'));
  const s = snapshot();
  s.workspaces[0].layout = ['automations'];
  const html = today(s, { state: { ai: AI }, auth: {}, hidden: new Set(), banners: '' });
  const cardHtml = html.slice(html.indexOf('ws-auto-card'));
  assert.match(cardHtml, /Automation results/);
  // Morning brief's latest run failed, so its latest result on Today is the earlier one.
  assert.match(cardHtml, /2 replies owed/);
  assert.match(cardHtml, /Reply drafted for Ann/);
  // Newest first: Morning brief's failure 5 minutes ago, then Ann's reply 20 minutes ago.
  assert.ok(cardHtml.indexOf('2 replies owed') < cardHtml.indexOf('Reply drafted for Ann'), 'newest first');
  assert.match(cardHtml, /Answer Ann about the Q3 budget[\s\S]*?data-action="open-message" data-id="m0"/);
  assert.ok(tagWith(cardHtml, 'data-action="automation-open-run"[^>]*data-id="run-1"'));
  assert.ok(tagWith(cardHtml, 'data-action="automation-open-run"[^>]*data-id="run-3"'));
  // Its latest run failed after that result: one line says so, with what to do.
  const brief = cardHtml.slice(cardHtml.indexOf('Morning brief'), cardHtml.indexOf('Draft replies to Ann'));
  assert.match(brief, /Latest run failed 5 min ago:<\/strong> Claude Code isn(’|'|&#39;)t signed in\./);
  assert.ok(tagWith(brief, 'data-action="ai-copy-login"'));
  // Its own Open run opens the failed run; the result's opens the run that produced it.
  const line = brief.slice(brief.indexOf('ws-auto-problem'), brief.indexOf('2 replies owed'));
  assert.ok(tagWith(line, 'data-action="automation-open-run"[^>]*data-id="run-2"'), 'the failure has its own Open run');
  assert.ok(tagWith(brief.slice(brief.indexOf('2 replies owed')), 'data-action="automation-open-run"[^>]*data-id="run-1"'));
  assert.ok(brief.indexOf('Latest run failed') < brief.indexOf('2 replies owed'), 'the failure is above the older result');
  assert.doesNotMatch(cardHtml.slice(cardHtml.indexOf('Draft replies to Ann')), /Latest run/, 'Ann’s latest run is fine');
  // "Only failures": the automation whose latest run failed stays, Ann's goes.
  s.workspaces[0].today = { active: 'Mine', items: [{ id: 'automations', x: 0, y: 0, w: 6, h: 5 }], options: { automations: { failures: true } } };
  const failures = today(s, { state: { ai: AI }, auth: {}, hidden: new Set(), banners: '' });
  assert.match(failures, /Morning brief[\s\S]*Latest run failed 5 min ago/);
  assert.doesNotMatch(failures, /Draft replies to Ann/);
  s.workspaces[0].today = {};
  // With no result on Today yet, the failure alone keeps the automation on the card.
  const failedOnly = snapshot();
  failedOnly.workspaces[0].layout = ['automations'];
  failedOnly.records = failedOnly.records.filter(r => r.id !== 'run-1');
  const alone = today(failedOnly, { state: { ai: AI }, auth: {}, hidden: new Set(), banners: '' });
  assert.match(alone, /Morning brief[\s\S]*Latest run failed 5 min ago/);
  assert.ok(tagWith(alone, 'data-action="automation-open-run"[^>]*data-id="run-2"'));
  const aloneBrief = alone.slice(alone.indexOf('Morning brief'), alone.indexOf('Draft replies to Ann'));
  assert.equal(count(aloneBrief, /data-action="automation-open-run"/g), 1, 'one Open run for the failure alone');
  // A run whose automation is gone is not shown.
  s.records = s.records.filter(r => !(r.kind === 'automation' && r.id === 'auto-reply'));
  assert.doesNotMatch(today(s, { state: { ai: AI }, auth: {}, hidden: new Set(), banners: '' }), /Reply drafted for Ann/);
  // Nothing yet: the card says where results come from.
  const fresh = buildSnapshot(NOW, { photo: false });
  fresh.workspaces[0].layout = ['automations'];
  const empty = today(fresh, { state: { ai: AI }, auth: {}, hidden: new Set(), banners: '' });
  assert.ok(tagWith(empty, 'data-action="route"[^>]*data-route="automations"'));
});

// ---------------------------------------------------------------- elsewhere

test('automation failures are shown in the Run log, not as decisions', () => {
  assert.ok(INLINE_AI_JOBS.has('automation_run'));
  const s = snapshot();
  s.jobs.push({ id: 'job-f', kind: 'automation_run', state: 'failed', workspaceId: 'personal', connectionId: null, dueAt: nowSec, payload: { automationId: 'auto-brief' }, policy: null, result: 'Claude Code is not signed in.' });
  assert.equal(decisions(s).some(d => d.id === 'job-f'), false);
});

test('a draft from a deleted automation says it came from an automation', () => {
  const s = snapshot();
  const { runDraft } = automationContract();
  const m = record(s, 'message', 'm1');
  m.data.lane = 'reply';
  const draft = { ...runDraft, id: 'ai:m1', connectionId: s.connection.id, updatedAt: nowSec - 30, data: { ...runDraft.data, provenance: { ...runDraft.data.provenance, messageIds: ['m0', 'm1'] } } };
  s.records.push(draft);
  const view = () => inbox(s, { state: { lane: 'reply', channel: 'all', search: '', showArchived: false, showSnoozed: false, inboxLimit: 200, selectedMessage: 'm1', ai: AI, drafts: {}, summaryUi: {}, draftPopover: null, draftDismissed: [] }, auth: {}, hidden: new Set(), banners: '' });
  // The contract draft names `auto-reply`, which the fixture keeps as "Draft replies to Ann".
  assert.match(unescape(view()), /Drafted by “Draft replies to Ann” with Claude Code/);
  s.records = s.records.filter(r => r.kind !== 'automation');
  assert.match(view(), /Drafted by an automation with Claude Code/);
});

// ---------------------------------------------------------------- habits: templates, Tasks, summaries

const TODOIST = { zone: 'UTC', ai: AI, providerName: 'Todoist' };
const noteTemplates = () => buildSnapshot(NOW, { photo: false }).noteTemplates;
const template = id => TEMPLATES.find(t => t.id === id);

test('the gallery lists the five habits first, Morning briefing at 08:07', () => {
  assert.deepEqual(TEMPLATES.map(t => t.id), ['morning-brief', 'inbox-triage', 'commitments', 'budget-reply', 'formal-summary', 'draft-replies', 'end-of-day', 'weekly-reflection']);
  assert.deepEqual(TEMPLATES.slice(0, 5).map(t => t.name), ['Morning briefing', 'Inbox triage', 'Commitments', 'Budget request reply', 'Formal meeting summary']);
  const at = id => template(id).automation.trigger;
  assert.deepEqual(at('morning-brief'), { kind: 'schedule', days: [1, 2, 3, 4, 5], time: '08:07' });
  assert.deepEqual(at('inbox-triage'), { kind: 'schedule', days: [1, 2, 3, 4, 5], time: '08:00' });
  assert.deepEqual(at('commitments'), { kind: 'schedule', days: [1, 2, 3, 4, 5], time: '08:03' });
  assert.deepEqual(at('budget-reply'), { kind: 'event', event: 'mail_from', senders: [], keywords: ['budget'] });
  assert.deepEqual(at('formal-summary'), { kind: 'event', event: 'meeting_ready', senders: [], keywords: [] });
  for (const id of ['morning-brief', 'inbox-triage', 'commitments']) assert.equal(template(id).automation.catchUp, true, id);
  // What each reads and delivers, as saved.
  const saved = id => toAutomation(draftFromAutomation(template(id).automation));
  assert.equal(saved('inbox-triage').read.needsReply, true);
  assert.equal(saved('inbox-triage').deliver.createTasks, true);
  assert.equal(saved('commitments').read.recentMessages, true);
  assert.equal(saved('commitments').deliver.createTasks, true);
  assert.deepEqual(saved('budget-reply').deliver, { today: true, notify: true, draftReply: true, createTasks: true, meetingSummary: null });
  assert.equal(saved('budget-reply').read.triggerConversation, true);
  assert.equal(saved('formal-summary').deliver.meetingSummary, 'formal-summary');
  assert.equal(saved('formal-summary').prompt, '');
  assert.match(template('morning-brief').automation.prompt, /^Write my morning briefing\. First the budget requests/);
  assert.match(template('budget-reply').description, /^A budget request becomes a budget task and a reply draft/);
  // The budget reply opens with its From field to fill, as Draft replies does.
  assert.ok(needsSenders(draftFromAutomation(template('budget-reply').automation)));
  // The cards say where results go, with the provider's name at the moment.
  const s = snapshot();
  s.taskProvider = { active: 'plugin:todoist', name: 'Todoist' };
  const cards = page(s, { tab: 'templates' });
  assert.match(cards, /Delivers to Today and tasks in Todoist\./);
  assert.match(cards, /Makes a Formal summary for each meeting\./);
  assert.match(cards, /When a meeting(’|'|&#39;)s transcript is ready/);
  assert.equal(deliveriesSentence({ today: true, createTasks: true }, 'Todoist'), 'Delivers to Today and tasks in Todoist.');
  assert.equal(deliveriesSentence({ today: true, createTasks: true }), 'Delivers to Today and tasks in Connect.');
  assert.equal(deliveriesSentence({ meetingSummary: 'formal-summary' }, 'Todoist', noteTemplates()), 'Makes a Formal summary for each meeting.');
});

test('Tasks in <provider> shows only with a message read', () => {
  const triage = draftFromAutomation(template('inbox-triage').automation);
  const html = automationEditor(triage, TODOIST);
  assert.match(html, /Tasks in Todoist/);
  assert.match(html, /One task per message that needs it\. A rerun, or a task you deleted or finished, never makes it again\./);
  assert.match(tagWith(html, 'data-deliver="createTasks"'), /\bchecked\b/);
  assert.doesNotMatch(html.slice(0, html.indexOf('data-deliver="createTasks"')).split('<div class="ws-auto-switch">').at(-1), /hidden/);
  assert.match(automationEditor(triage, { zone: 'UTC', ai: AI }), /Tasks in Connect/);
  // The new read box.
  assert.match(html, /Messages since the last run/);
  assert.match(unescape(html), /Mail and Teams messages, yours too, since this automation last ran \(at most 3 days\)\./);
  // Calendar only: the switch stays in the form, hidden.
  const calendar = { ...triage, read: { calendarToday: true, needsReply: false, triggerConversation: false, senderMail: false, commitmentsNotes: false, recentMessages: false } };
  const off = automationEditor(calendar, TODOIST);
  assert.match(off, /<div hidden><div class="ws-auto-switch">[^]*?data-deliver="createTasks"/);
  // …and is not saved while hidden.
  assert.equal(toAutomation(calendar).deliver.createTasks, false);
  // Ticking a message read redraws the editor so the switch can show.
  assert.match(tagWith(html, 'data-read="needsReply"'), /data-action="automation-form"/);
  assert.match(tagWith(html, 'data-read="recentMessages"'), /data-action="automation-form"/);
  // A mail trigger with its conversation read makes tasks too.
  const budget = automationEditor(draftFromAutomation(template('budget-reply').automation), TODOIST);
  assert.doesNotMatch(budget, /<div hidden><div class="ws-auto-switch">[^]*?data-deliver="createTasks"/);
  // The list's Deliver chip names it.
  const s = snapshot();
  record(s, 'automation', 'auto-brief').data.deliver.createTasks = true;
  assert.match(page(s), /Today · Notification · Tasks/);
});

test('a summary automation shows Make, keywords and Wishes, not Read or Claude', () => {
  const ctx = { ...TODOIST, templates: noteTemplates() };
  const draft = draftFromAutomation(template('formal-summary').automation);
  const html = automationEditor(draft, ctx);
  const make = html.match(/<select[^>]*id="auto-summary"[^>]*>[^]*?<\/select>/)?.[0] || '';
  assert.ok(make, 'the template select');
  assert.match(make, /^<select[^>]*>\s*<option value="formal-summary" selected>Formal summary<\/option>/);
  assert.match(make, /Meeting notes/);
  assert.match(html, /<label class="ws-field"><span class="ws-field-label">Make<\/span><span class="ws-select-wrap"><select[^>]*id="auto-summary"/, 'a visible label');
  assert.match(html, /Only meetings whose title mentions \(optional\)/);
  assert.match(html, /<label[^>]*for="auto-prompt"[^>]*>Wishes \(optional\)<\/label>/);
  assert.match(html, /placeholder="e\.g\. Keep it to one page"/);
  assert.match(html, /Runs with the Claude route for meeting notes \(Settings › Claude\)\. Pin it as a summary tab in Settings › Meetings to open meetings on it\./);
  assert.doesNotMatch(html, /Instructions<\/label>/);
  // Read, Claude and the Claude deliveries are hidden, not merely styled away.
  assert.match(html, /<fieldset class="ws-auto-section" id="auto-read" hidden>/);
  assert.match(html, /<fieldset class="ws-auto-section" hidden><legend>Claude<\/legend>/);
  assert.match(html, /<fieldset class="ws-auto-section" hidden><legend>Deliver<\/legend>/);
  assert.equal(count(html, /id="auto-deliver"/g), 1, 'one place for the Deliver refusals: the template select');
  assert.match(html, /<option value="meeting_ready" selected>A meeting(’|'|&#39;)s transcript is ready<\/option>/);
  // Saved: the template, nothing read, no Claude delivery.
  const saved = toAutomation({ ...draft, read: { ...draft.read, needsReply: true, recentMessages: true }, deliver: { ...draft.deliver, today: true, createTasks: true }, prompt: 'Keep it short' });
  assert.equal(saved.deliver.meetingSummary, 'formal-summary');
  assert.deepEqual(saved.read, { calendarToday: false, needsReply: false, triggerConversation: false, mailFromSenderDays: 0, commitmentsNotes: false, recentMessages: false });
  assert.deepEqual(saved.deliver, { today: false, notify: false, draftReply: false, createTasks: false, meetingSummary: 'formal-summary' });
  assert.deepEqual(saved.trigger, { kind: 'event', event: 'meeting_ready', senders: [], keywords: [] });
  assert.equal(saved.prompt, 'Keep it short');
  assert.equal(saved.capUsd, null);
  // A template no longer there is named so, and the editor's form reads the choice.
  assert.match(automationEditor({ ...draft, meetingSummary: 'gone' }, ctx), /<option value="gone" selected>gone \(not found\)<\/option>/);
  assert.equal(editorDraft(form({ 'auto-kind': 'event', 'auto-event': 'meeting_ready', 'auto-summary': 'short-summary' })).meetingSummary, 'short-summary');
  // Other automations never send a template.
  assert.equal(toAutomation(draftFromAutomation(template('inbox-triage').automation)).deliver.meetingSummary, null);
  assert.equal(triggerSummary(template('formal-summary').automation), 'When a meeting’s transcript is ready');
  // The summary's errors stay at the template select; the hidden Read and cap hold none.
  assert.deepEqual(errorTarget({ code: 'validation', field: 'deliver', message: 'Choose a note template.' }, draft), { field: 'auto-deliver', message: 'Choose a note template.' });
  assert.equal(errorTarget({ code: 'validation', field: 'read', message: 'x' }, draft), null);
  assert.equal(errorTarget({ code: 'validation', field: 'capUsd', message: 'The cost cap must be between 0.01 and 100 US dollars.' }, { ...draft, profile: 'codemie:prod' }, AI), null);
  const invalid = automationEditor({ ...draft, meetingSummary: '' }, { ...ctx, error: { field: 'auto-deliver', message: 'Choose the template to make.' } });
  assert.match(invalid, /id="auto-deliver"[^]*?class="ws-field-error"[^>]*>Choose the template to make\./);
});

test('the editor round-trips the new fields', () => {
  for (const id of ['commitments', 'inbox-triage', 'budget-reply', 'formal-summary']) {
    const d = draftFromAutomation(template(id).automation);
    const again = draftFromAutomation(toAutomation(d));
    assert.equal(again.read.recentMessages, d.read.recentMessages, id);
    assert.equal(again.deliver.createTasks, d.deliver.createTasks, id);
    assert.equal(again.meetingSummary, d.meetingSummary, id);
    assert.equal(again.event, d.event, id);
  }
  assert.equal(draftFromAutomation(template('commitments').automation).read.recentMessages, true);
  assert.equal(draftFromAutomation(template('formal-summary').automation).meetingSummary, 'formal-summary');
  // From the form, as the browser sends it.
  const d = editorDraft(form({ 'auto-kind': 'schedule', 'auto-day': [1], 'auto-time': '08:03', 'auto-read': ['recentMessages'], 'auto-deliver': ['today', 'createTasks'] }));
  assert.equal(d.read.recentMessages, true);
  assert.equal(d.deliver.createTasks, true);
  assert.equal(toAutomation(d).deliver.createTasks, true);
  assert.equal(toAutomation(d).read.recentMessages, true);
  // The saved contract automations read back the same way.
  const { summary } = automationContract().automation;
  assert.equal(draftFromAutomation(summary.data).meetingSummary, 'meeting-notes');
  assert.equal(draftFromAutomation(summary.data).event, 'meeting_ready');
});

test('the run detail says what tasks were made and links them', () => {
  const s = snapshot();
  s.taskProvider = { active: 'plugin:todoist', name: 'Todoist' };
  const { runOk, runSummary } = automationContract();
  const run = { ...runOk, data: { ...runOk.data, handled: 1, tasks: { made: [
    { id: 'task-1', kind: 'reply', text: 'Reply to Olga about SOW section 4' },
    { id: 'task-2', kind: 'reply', text: 'Reply to <b>Marek</b> about the pilot users' },
  ], existing: 1, dropped: 1 } } };
  const html = runLog([run], { s, expanded: ['run-1'], ai: AI });
  assert.match(html, /Delivered to Today, Notification, Tasks/);
  assert.match(html, /Tasks: 2 made in Todoist, 1 already there/);
  assert.equal(count(html, /<a [^>]*href="#\/tasks"/g), 2, 'two links to Tasks');
  assert.match(tagWith(html, 'data-id="task-1"'), /^<a [^>]*href="#\/tasks"[^>]*data-action="task-open-today"/);
  assert.match(html, /Reply to Olga about SOW section 4/);
  assert.match(html, /Reply to &lt;b&gt;Marek&lt;\/b&gt; about the pilot users/);
  assert.doesNotMatch(html, /<b>Marek/);
  assert.match(html, /1 left out \(no message given\)/);
  assert.match(html, /Looks handled: 1 task flagged/);
  // Nothing made or found: still says so; no tasks object, no line.
  const none = runLog([{ ...run, data: { ...run.data, handled: 0, tasks: { made: [], existing: 0, dropped: 0 } } }], { s, expanded: ['run-1'], ai: AI });
  assert.match(none, /Tasks: none needed/);
  assert.doesNotMatch(none, /Looks handled|left out/);
  // Everything left out: none made, never "none needed" beside it.
  const dropped = runLog([{ ...run, data: { ...run.data, handled: 0, tasks: { made: [], existing: 0, dropped: 1 } } }], { s, expanded: ['run-1'], ai: AI });
  assert.match(dropped, /Tasks: none made/);
  assert.match(dropped, /1 left out/);
  assert.doesNotMatch(dropped, /none needed/);
  assert.doesNotMatch(runLog([{ ...run, data: { ...run.data, tasks: undefined, handled: undefined } }], { s, expanded: ['run-1'], ai: AI }), /Tasks:/);
  assert.match(runLog([{ ...run, data: { ...run.data, handled: 2 } }], { s, expanded: ['run-1'], ai: AI }), /Looks handled: 2 tasks flagged/);
  // Every other link is still a button that opens through native.
  assert.doesNotMatch(html.replace(/href="#\/tasks"/g, ''), /href=/);
  // A summary run: what was queued, and the meeting.
  s.records.push({ id: 'mtg-1', kind: 'meeting', source: 'local', connectionId: null, workspaceId: 'personal', revision: 'r', updatedAt: nowSec, data: { title: 'Weekly <i>sync</i>' } });
  const summaryRun = { ...runSummary, id: 'run-s', data: { ...runSummary.data, meetingId: 'mtg-1', trigger: { ...runSummary.data.trigger, sourceId: 'mtg-1' } } };
  const queued = runLog([summaryRun], { s, expanded: ['run-s'], ai: AI });
  assert.match(queued, /Formal summary queued for Weekly sync/);
  assert.match(queued, /Transcript ready · Weekly &lt;i&gt;sync&lt;\/i&gt;/);
  assert.match(tagWith(queued, 'data-action="meeting-open"'), /href="#\/meetings\/mtg-1\/summary"[^>]*data-id="mtg-1"/);
  assert.match(queued, /Open meeting/);
  assert.doesNotMatch(queued, /Tasks:/);
  // The meeting gone: no link to it.
  s.records = s.records.filter(r => r.id !== 'mtg-1');
  assert.doesNotMatch(runLog([summaryRun], { s, expanded: ['run-s'], ai: AI }), /Open meeting/);
});

test('Today says Made 2 tasks in Todoist', () => {
  const s = snapshot();
  s.taskProvider = { active: 'plugin:todoist', name: 'Todoist' };
  s.workspaces[0].layout = ['automations'];
  const run = record(s, 'automation_run', 'run-1');
  run.data.tasks = { made: [{ id: 'task-1', kind: 'reply', text: 'Reply to Ann' }, { id: 'task-2', kind: 'reply', text: 'Reply to Olga' }], existing: 0, dropped: 0 };
  const html = today(s, { state: { ai: AI }, auth: {}, hidden: new Set(), banners: '' });
  const link = html.match(/<a [^>]*href="#\/tasks"[^>]*>[^]*?<\/a>/)?.[0] || '';
  assert.match(link, /data-action="route"[^>]*data-route="tasks"/);
  assert.match(link, />Made 2 tasks in Todoist ›<\/a>$/);
  run.data.tasks.made = run.data.tasks.made.slice(0, 1);
  s.taskProvider = undefined;
  assert.match(today(s, { state: { ai: AI }, auth: {}, hidden: new Set(), banners: '' }), /Made 1 task in Connect ›/);
  run.data.tasks.made = [];
  assert.doesNotMatch(today(s, { state: { ai: AI }, auth: {}, hidden: new Set(), banners: '' }), /Made \d/);
});

test('a meeting summary automation has no Run now', () => {
  const s = withAutomations(buildSnapshot(NOW, { photo: false }), NOW, { habits: true });
  const html = page(s);
  const run = tagWith(html, 'data-action="automation-run"[^>]*data-id="auto-summary"');
  assert.match(run, /\bdisabled\b/);
  assert.match(unescape(run), /title="Run now isn’t available for a meeting summary\. It runs when a meeting’s notes are ready\."/);
  assert.doesNotMatch(tagWith(html, 'data-action="automation-run"[^>]*data-id="auto-triage"'), /\bdisabled\b/);
});

test('the refusals point at the Deliver section', () => {
  for (const sentence of [
    'Tasks are made from messages. Tick Needs your reply or Messages since the last run, or start it from a message.',
    'A meeting summary starts when a meeting\'s transcript is ready.',
    'Choose the template to make.',
    'Choose a note template.',
  ]) assert.equal(fieldForError(sentence), 'auto-deliver', sentence);
});

test('the habits fixture carries a triage run with tasks and a summary run', () => {
  const s = withAutomations(buildSnapshot(NOW, { photo: false }), NOW, { habits: true });
  assert.ok(record(s, 'automation', 'auto-triage').data.deliver.createTasks);
  assert.equal(record(s, 'automation', 'auto-summary').data.deliver.meetingSummary, 'formal-summary');
  assert.ok(record(s, 'automation_run', 'run-triage').data.tasks.made.length === 2);
  assert.equal(record(s, 'automation_run', 'run-summary').data.status, 'ok');
  // Without the option, the fixture is as before.
  assert.equal(snapshot().records.filter(r => r.kind === 'automation').length, 2);
});
