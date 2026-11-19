// Automations (DESIGN 6.6): the list, the editor, the templates, the Run log and Today's
// Automation results card. Automations and runs come from the Rust contract fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  automations, automationEditor, draftFromAutomation, editorDraft, toAutomation, fieldForError, runLog, outputText,
  triggerSummary, newAutomationDraft, duplicateDraft, nextRunLabel, deliveriesSentence, errorTarget, needsSenders, TEMPLATES,
} from '../workspace/view-automations.js';
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
  assert.match(html, /data-tab="automations"[^>]*aria-selected="true"/);
  assert.match(html, /data-tab="runs"/);
  assert.match(html, /data-tab="templates"/);

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
  assert.match(schedule, /id="auto-time"[^>]*value="08:45"/);
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
    read: { calendarToday: false, needsReply: true, triggerConversation: false, mailFromSenderDays: 0, commitmentsNotes: false },
    prompt: 'Wrap up.', ai: { profile: null, model: null }, capUsd: null,
    deliver: { today: true, notify: false, draftReply: false }, catchUp: false,
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
  assert.ok(needsSenders(draftFromAutomation(TEMPLATES[1].automation)));
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
  assert.deepEqual(TEMPLATES.map(t => t.name), ['Morning brief', 'Draft replies to someone', 'End-of-day wrap-up', 'Weekly reflection']);
  assert.deepEqual(TEMPLATES.map(t => triggerSummary(t.automation)), ['Weekdays at 08:45', 'When mail arrives from the people you name', 'Weekdays at 17:30', 'Fridays at 16:00']);
  const cards = page(snapshot(), { tab: 'templates' });
  for (const t of TEMPLATES) assert.ok(tagWith(cards, `data-action="automation-template"[^>]*data-id="${t.id}"`), t.id);
  assert.match(cards, /Use template/);
  assert.match(cards, /Delivers to Today and a notification\./);
  assert.equal(deliveriesSentence({ today: true, draftReply: true }), 'Delivers to Today and a reply draft.');
  assert.equal(deliveriesSentence({ today: true, notify: true, draftReply: true }), 'Delivers to Today, a notification and a reply draft.');

  const brief = draftFromAutomation(TEMPLATES[0].automation);
  const html = automationEditor(brief, { zone: 'UTC', ai: AI });
  assert.match(html, /id="auto-name"[^>]*value="Morning brief"/);
  assert.match(html, /name="auto-id" value=""/);
  assert.ok(brief.prompt.length > 40 && brief.prompt.length <= 4000);
  const saved = toAutomation(brief);
  assert.deepEqual(saved.trigger, { kind: 'schedule', days: [1, 2, 3, 4, 5], time: '08:45' });
  assert.equal(saved.id, '');
  assert.equal(saved.deliver.today, true);
  assert.equal(saved.catchUp, true);

  // Draft replies to someone: mail from people you name, delivering a reply draft.
  const replies = automationEditor(draftFromAutomation(TEMPLATES[1].automation), { zone: 'UTC', ai: AI });
  assert.match(tagWith(replies, 'data-deliver="draftReply"'), /\bchecked\b/);
  assert.match(replies, /id="auto-senders"[^>]*value=""/);
  assert.deepEqual(toAutomation(draftFromAutomation(TEMPLATES[3].automation)).trigger.days, [5]);

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
  // No address the app window could follow: a link is a button that opens through native.
  assert.doesNotMatch(html, /href=/);
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
