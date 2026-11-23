// The Meetings page's pure model: states without a record, the lanes, the hash, and the JS
// mirrors of native's template choice and glossary reading (checked against native's answers).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  meetingState, meetingRows, meetingCounts, parseHash, meetingHash, resolveTemplate, parseGlossary, parseTags, runOf, legendOf, lineAt, FILTERS,
  readHidden, isHidden, seriesOf, listModel, listOrder, newMeetingsView, meetingItems, tabsOf, TABS,
} from '../workspace/meetings-model.js';
import { dayKey } from '../workspace/format.js';
import { buildSnapshot, withMeetings, meetingContract } from './fixtures/workspace-fixture.mjs';

const NOW = Date.UTC(2026, 10, 18, 15, 20);
const contract = name => JSON.parse(readFileSync(new URL(`./fixtures/contract/${name}.json`, import.meta.url), 'utf8'));
const iso = ms => new Date(ms).toISOString();
const HOUR = 3_600_000;
const event = (data = {}) => ({ id: 'e', kind: 'event', data: { title: 'Sync', start: iso(NOW - 2 * HOUR), end: iso(NOW - HOUR), joinUrl: 'https://teams.microsoft.com/l/x', isOnlineMeeting: true, allDay: false, cancelled: false, response: 'accepted', ...data } });
const snapshot = () => withMeetings(buildSnapshot(NOW, { photo: false, zone: 'UTC' }), NOW);

test('meetingState derives upcoming, offline, pending and none without a record, and none for meetings the round never checks', () => {
  // Not over yet (in progress too): upcoming, online or not.
  assert.equal(meetingState(event({ start: iso(NOW + HOUR), end: iso(NOW + 2 * HOUR) }), null, NOW, true), 'upcoming');
  assert.equal(meetingState(event({ start: iso(NOW - 10 * 60_000), end: iso(NOW + 20 * 60_000), joinUrl: null, isOnlineMeeting: false }), null, NOW, true), 'upcoming');
  // Over: in person is offline; a Teams meeting less than a day ago waits for Teams; older, none.
  assert.equal(meetingState(event({ joinUrl: null, isOnlineMeeting: false }), null, NOW, true), 'offline');
  assert.equal(meetingState(event(), null, NOW, true), 'pending');
  assert.equal(meetingState(event({ start: iso(NOW - 26 * HOUR), end: iso(NOW - 25 * HOUR) }), null, NOW, true), 'none');
  // Meetings the round never checks: none at once.
  assert.equal(meetingState(event(), null, NOW, false), 'none', 'transcripts are off');
  assert.equal(meetingState(event({ response: 'declined' }), null, NOW, true), 'none', 'declined');
  assert.equal(meetingState(event({ cancelled: true }), null, NOW, true), 'none', 'cancelled');
  assert.equal(meetingState(event({ allDay: true }), null, NOW, true), 'none', 'all day');
  assert.equal(meetingState(event({ joinUrl: '  ', isOnlineMeeting: true }), null, NOW, true), 'none', 'online without a Teams link');
  // A record says where it stands; one still marked upcoming after the meeting ended is derived.
  for (const r of contract('meeting-records')) assert.equal(meetingState(event(), r, NOW, true), r.data.state);
  assert.equal(meetingState(event(), { data: { state: 'upcoming' } }, NOW, true), 'pending');
  // Records' bodies or plain data both work.
  assert.equal(meetingState(event().data, { state: 'ready' }, NOW, true), 'ready');
});

test('boot opens #/meetings/<encoded id>/transcript', () => {
  for (const id of ['AAMkADk0/Zj+Rk==', 'an id with spaces', '100% done', 'ev-standup']) {
    const hash = meetingHash(id, 'transcript');
    assert.equal(hash, `#/meetings/${encodeURIComponent(id)}/transcript`);
    assert.deepEqual(parseHash(hash), { route: 'meetings', meetingId: id, tab: 'transcript' });
  }
  assert.equal(meetingHash(null, 'notes'), '#/meetings');
  assert.equal(meetingHash('a/b', 'notes'), '#/meetings/a%2Fb/notes');
  assert.deepEqual(parseHash('#/meetings'), { route: 'meetings', meetingId: null, tab: null });
  assert.deepEqual(parseHash('#/meetings/x/bogus'), { route: 'meetings', meetingId: 'x', tab: null }, 'an unknown tab');
  assert.deepEqual(parseHash('#/meetings/%E0%A4%A/notes'), { route: 'meetings', meetingId: null, tab: 'notes' }, 'a broken id');
  assert.deepEqual(parseHash('#/settings/ai'), { route: 'settings', meetingId: null, tab: 'ai' });
  assert.deepEqual(parseHash('#/tasks'), { route: 'tasks', meetingId: null, tab: null });
  assert.deepEqual(parseHash('#/nowhere/x'), { route: 'today', meetingId: null, tab: 'x' });
  assert.deepEqual(parseHash(''), { route: null, meetingId: null, tab: null });
});

test('lanes: All hides no-transcript meetings unless showNone; To do counts available+downloaded', () => {
  const s = snapshot();
  const ids = (filter, q = '', showNone = false) => meetingRows(s, filter, q, showNone, NOW).map(m => m.id);
  assert.deepEqual(FILTERS, [['all', 'All meetings'], ['needs', 'Needs you'], ['ready', 'With notes'], ['upcoming', 'Coming up']]);
  const all = ids('all');
  for (const id of ['mtg-philips', 'mtg-roadmap', 'mtg-release', 'mtg-vendor', 'mtg-northwind', 'mtg-critique']) assert.ok(all.includes(id), `All shows ${id}`);
  // Still waiting for Teams (mtg-sprint) or done waiting (ev-standup, ended over two hours ago): no transcript.
  for (const id of ['mtg-planning', 'mtg-lunch', 'mtg-sprint', 'ev-standup', 'ev-next', 'ev-current']) assert.ok(!all.includes(id), `All hides ${id}`);
  // Newest first.
  const starts = meetingRows(s, 'all', '', false, NOW).map(m => m.start);
  assert.deepEqual(starts, [...starts].sort((a, b) => b - a));
  const withNone = ids('all', '', true);
  for (const id of ['mtg-planning', 'mtg-lunch', 'mtg-sprint', 'ev-standup']) assert.ok(withNone.includes(id), `showNone lists ${id}`);
  assert.ok(!withNone.includes('ev-next'), 'upcoming ones stay in Upcoming');
  assert.deepEqual(ids('process').sort(), ['mtg-release', 'mtg-roadmap', 'mtg-vendor']);
  assert.deepEqual(ids('ready'), ['mtg-philips']);
  assert.deepEqual(ids('attention').sort(), ['mtg-critique', 'mtg-northwind']);
  const upcoming = ids('upcoming');
  assert.ok(upcoming.includes('ev-next') && upcoming.includes('ev-current') && upcoming.includes('ev-week-1'), upcoming.join());
  assert.ok(upcoming.indexOf('ev-current') < upcoming.indexOf('ev-next'), 'upcoming soonest first');
  // Counts for the filters: To do and Needs you; none for the switch.
  assert.deepEqual(meetingCounts(s, NOW), { process: 3, attention: 2, none: 4, hidden: 0 });
  // Search: titles and people.
  assert.deepEqual(ids('all', 'PHILIPS'), ['mtg-philips']);
  assert.deepEqual(ids('all', 'hannah'), ['mtg-northwind']);
  // A meeting whose notes are being made stays in To do and shows its run.
  s.jobs.push({ ...meetingContract().job, payload: { ...meetingContract().job.payload, meetingId: 'mtg-roadmap' } });
  const row = meetingRows(s, 'process', '', false, NOW).find(m => m.id === 'mtg-roadmap');
  assert.equal(row.run.kind, 'meeting_notes');
  assert.deepEqual([row.run.index, row.run.total, row.run.step], [0, 3, 'Writing notes with Meeting notes']);
});

// ---------------------------------------------------------------- the calmer list: hiding and days

const NO_HIDDEN = { ids: [], series: [] };
/** The fixture with the Roadmap review and the Design critique as two occurrences of one series. */
const seriesSnapshot = () => {
  const s = snapshot();
  for (const id of ['mtg-roadmap', 'mtg-critique']) s.records.find(r => r.kind === 'event' && r.id === id).data.seriesId = 'series-review';
  return s;
};
const view = (extra = {}) => ({ ...newMeetingsView(), ...extra });
const modelOf = (s, extra = {}) => listModel(s, view(extra), { now: NOW, zone: 'UTC' });
const idsOf = model => ({ needs: model.needs.map(m => m.id), days: model.days.flatMap(d => d.items.map(m => m.id)) });

test('readHidden survives bad values', () => {
  assert.deepEqual(readHidden(null), NO_HIDDEN);
  assert.deepEqual(readHidden('x'), NO_HIDDEN);
  assert.deepEqual(readHidden([1, 2]), NO_HIDDEN);
  assert.deepEqual(readHidden({ ids: [1, 'a', 'a', '', null], series: 'series-x' }), { ids: ['a'], series: [] });
  assert.deepEqual(readHidden({ ids: ['a'], series: ['s', 's', 7] }), { ids: ['a'], series: ['s'] });
  assert.deepEqual(newMeetingsView({ hidden: 'broken' }).hidden, NO_HIDDEN, 'the view state starts empty on a broken value');
});

test('isHidden by id and by series', () => {
  const items = meetingItems(seriesSnapshot(), NOW);
  const byId = id => items.find(m => m.id === id);
  assert.equal(seriesOf(byId('mtg-roadmap')), 'series-review');
  assert.equal(seriesOf(byId('mtg-philips')), null);
  assert.equal(isHidden(byId('mtg-philips'), { ids: ['mtg-philips'], series: [] }), true);
  assert.equal(isHidden(byId('mtg-roadmap'), { ids: ['mtg-philips'], series: [] }), false);
  const series = { ids: [], series: ['series-review'] };
  assert.equal(isHidden(byId('mtg-roadmap'), series), true);
  assert.equal(isHidden(byId('mtg-critique'), series), true, 'every occurrence of the series');
  assert.equal(isHidden(byId('mtg-philips'), series), false);
  assert.equal(isHidden(byId('mtg-philips'), undefined), false);
});

test('meetingCounts leaves hidden meetings out', () => {
  const s = snapshot();
  const counts = meetingCounts(s, NOW, undefined, { ids: ['mtg-critique'], series: [] });
  assert.deepEqual(counts, { process: 3, attention: 1, none: 4, hidden: 1 });
});

test('listModel puts the needs lane in a card and the rest in days', () => {
  const s = snapshot();
  const model = modelOf(s);
  const { needs, days } = idsOf(model);
  assert.deepEqual([...needs].sort(), ['mtg-critique', 'mtg-northwind', 'mtg-release', 'mtg-roadmap', 'mtg-vendor']);
  const starts = model.needs.map(m => m.start);
  assert.deepEqual(starts, [...starts].sort((a, b) => b - a), 'newest first');
  for (const id of needs) assert.ok(!days.includes(id), `${id} is only in the card`);
  assert.ok(days.includes('mtg-philips'));
  // Today's meetings still to come (ev-current is going on, ev-next later) come first, in their own group, soonest first.
  const [coming, ...past] = model.days;
  assert.equal(coming.key, 'coming');
  assert.equal(coming.label, 'Coming up');
  const ids = coming.items.map(m => m.id);
  assert.ok(ids.includes('ev-current') && ids.includes('ev-next') && ids.indexOf('ev-current') < ids.indexOf('ev-next'), ids.join());
  const soon = coming.items.map(m => m.start);
  assert.deepEqual(soon, [...soon].sort((a, b) => a - b), 'soonest first');
  for (const m of coming.items) assert.ok(m.state === 'upcoming' && dayKey(m.start, 'UTC') === dayKey(NOW, 'UTC'), m.id);
  assert.ok(!past.some(d => d.items.some(m => m.state === 'upcoming')), 'the days below hold past meetings only');
  assert.ok(!modelOf(s, { filter: 'ready' }).days.some(d => d.key === 'coming' || d.items.some(m => m.state === 'upcoming')), 'only All adds them');
  assert.ok(!days.includes('ev-week-1') || ids.includes('ev-week-1'), 'upcoming meetings of later days stay in Coming up');
  // Days newest first; every item sits under its own day.
  const keys = past.map(d => d.key);
  assert.deepEqual(keys, [...keys].sort().reverse());
  for (const d of past) for (const m of d.items) assert.equal(dayKey(m.start, 'UTC'), d.key);
  assert.equal(model.hiddenCount, 0);
});

test('hidden meetings leave the card and the days unless shown', () => {
  const s = snapshot();
  const hidden = { ids: ['mtg-critique', 'mtg-philips'], series: [] };
  const model = modelOf(s, { hidden });
  const { needs, days } = idsOf(model);
  assert.ok(!needs.includes('mtg-critique') && !days.includes('mtg-critique') && !days.includes('mtg-philips'));
  assert.equal(model.hiddenCount, 2);
  const shown = idsOf(modelOf(s, { hidden, showHidden: true }));
  assert.ok(!shown.needs.includes('mtg-critique'), 'a hidden meeting never goes back into Needs you');
  assert.ok(shown.days.includes('mtg-critique') && shown.days.includes('mtg-philips'), 'shown greyed in their days');
});

test('listModel keeps the selected hidden meeting', () => {
  const s = snapshot();
  const model = modelOf(s, { hidden: { ids: ['mtg-philips'], series: [] }, selected: 'mtg-philips' });
  assert.ok(idsOf(model).days.includes('mtg-philips'));
  assert.equal(model.hiddenCount, 1);
});

test('search finds hidden meetings', () => {
  const s = snapshot();
  const model = modelOf(s, { hidden: { ids: ['mtg-philips'], series: [] }, q: 'philips' });
  assert.deepEqual(idsOf(model).days, ['mtg-philips']);
});

test('with filter needs, there is no card', () => {
  const s = snapshot();
  const model = modelOf(s, { filter: 'needs' });
  assert.deepEqual(model.needs, []);
  assert.deepEqual(idsOf(model).days.sort(), ['mtg-critique', 'mtg-northwind', 'mtg-release', 'mtg-roadmap', 'mtg-vendor']);
  assert.deepEqual(idsOf(modelOf(s, { filter: 'ready' })).days, ['mtg-philips']);
});

test('listOrder follows the screen', () => {
  const s = snapshot();
  const model = modelOf(s);
  const order = listOrder(model, view());
  assert.deepEqual(order, [...model.needs.map(m => m.id), ...model.days.flatMap(d => d.items.map(m => m.id))]);
  const first = model.days[0];
  const folded = listOrder(model, view({ folded: { [first.key]: true } }));
  for (const m of first.items) assert.ok(!folded.includes(m.id), `${m.id} is folded away`);
  const noCard = listOrder(model, view({ needsFolded: true }));
  for (const m of model.needs) assert.ok(!noCard.includes(m.id), `${m.id} is in the folded card`);
  const hiddenModel = modelOf(s, { hidden: { ids: ['mtg-philips'], series: [] } });
  assert.ok(!listOrder(hiddenModel, view()).includes('mtg-philips'));
});

test('runOf gives the running job and its step; legendOf groups states for the badges', () => {
  const s = snapshot();
  assert.equal(runOf(s, 'mtg-roadmap'), null);
  const job = meetingContract().job;
  s.jobs.push({ ...job, payload: { ...job.payload, meetingId: 'mtg-roadmap', step: 'Finding tasks' } });
  s.jobs.push({ ...job, id: 'old', state: 'succeeded', payload: { ...job.payload, meetingId: 'mtg-release' } });
  s.jobs.push({ id: 'dl', kind: 'transcript_download', state: 'queued', payload: { meetingId: 'mtg-vendor' } });
  const run = runOf(s, 'mtg-roadmap');
  assert.deepEqual({ kind: run.kind, index: run.index, total: run.total, template: run.templateId }, { kind: 'meeting_notes', index: 1, total: 3, template: 'meeting-notes' });
  assert.equal(runOf(s, 'mtg-release'), null, 'a finished job is not a run');
  assert.equal(runOf(s, 'mtg-vendor').kind, 'transcript_download');
  assert.equal(legendOf('ready'), 'ready');
  assert.equal(legendOf('downloaded'), 'process');
  assert.equal(legendOf('available'), 'process');
  assert.equal(legendOf('pending'), 'busy');
  assert.equal(legendOf('downloaded', { busy: true }), 'busy');
  assert.equal(legendOf('failed'), 'attention');
  assert.equal(legendOf('blocked'), 'attention');
  assert.equal(legendOf('upcoming', { auto: true }), 'auto');
  assert.equal(legendOf('upcoming'), null);
  assert.equal(legendOf('none'), null);
  assert.equal(legendOf('offline'), null);
});

test('lineAt finds the transcript line a [hh:mm] or [hh:mm:ss] reference points at', () => {
  const segments = [{ start: 0 }, { start: 14 }, { start: 60 }, { start: 130 }, { start: 3725 }];
  // [hh:mm] as the notes input numbers the transcript: the first line said in that minute.
  assert.equal(lineAt(segments, '00:00'), 0);
  assert.equal(lineAt(segments, '00:01'), 2, 'one minute in');
  assert.equal(lineAt(segments, '00:02'), 3);
  assert.equal(lineAt(segments, '01:02'), 4);
  assert.equal(lineAt(segments, '00:05'), 3, 'nothing said that minute: the line before');
  // [hh:mm:ss]: the line being said then.
  assert.equal(lineAt(segments, '01:02:05'), 4);
  assert.equal(lineAt(segments, '00:00:20'), 1);
  assert.equal(lineAt([], '00:01'), -1);
  assert.equal(lineAt(segments, 'nonsense'), -1);
});

test('resolveTemplate matches meeting-rules-cases.json', () => {
  const fixture = contract('meeting-rules-cases');
  const s = { settings: fixture.settings, records: fixture.records, noteTemplates: fixture.noteTemplates };
  for (const c of fixture.cases) {
    const got = resolveTemplate({ data: c.event }, c.meeting ? { data: c.meeting } : null, s);
    assert.deepEqual({ template: got.template.id, why: got.why, rule: got.rule, auto: got.auto }, c.expected, c.name);
  }
  // Every reason reads as a sentence where the template is shown.
  const rule = resolveTemplate({ data: fixture.cases[1].event }, null, s);
  assert.equal(rule.reason, 'Rule: title contains “stand-up”');
  assert.equal(resolveTemplate({ data: fixture.cases[0].event }, { data: fixture.cases[0].meeting }, s).reason, 'Chosen for this meeting');
  assert.equal(resolveTemplate({ data: fixture.cases[6].event }, null, s).reason, 'Your default template');
});

test('the meeting view settings fixture: defaults, a dedupe and a delete unpin', () => {
  const fixture = contract('meeting-view-settings');
  assert.deepEqual(fixture.default, { openOn: 'summary', actionItems: true, summaryTabs: [] });
  assert.deepEqual(fixture.updated.summaryTabs, ['short-summary', 'custom-formal', 'plugin:podervianskyi']);
  assert.ok(!fixture.afterTemplateDelete.summaryTabs.includes('custom-formal'));
});

test('parseGlossary and parseTags match glossary-parse.json', () => {
  const fixture = contract('glossary-parse');
  assert.deepEqual(parseGlossary(fixture.glossary), fixture.expected.glossary);
  assert.deepEqual(parseTags(fixture.tags), fixture.expected.tags);
  // Blanks that differ between Rust and JavaScript (a byte order mark, a next line, a no-break space).
  assert.deepEqual(parseTags(fixture.tagEdges), fixture.expected.tagEdges);
  assert.deepEqual(parseGlossary(''), { me: null, pairs: [], terms: [], people: [] });
  assert.deepEqual(parseTags('- not a tag\n* `ok`\n-`no space`'), ['ok']);
  // Unclosed bold reads nothing; a quoted "we will…" is not an alias.
  assert.deepEqual(parseGlossary('## Me\n**Ann** — “Annie”, “we will do it”\n## Terms\n- **Open bold'), { me: { name: 'Ann', aliases: ['Annie'], address: null }, pairs: [], terms: [], people: [] });
});

test('an in-person meeting with an imported transcript is in All and To do, not counted as without one', () => {
  const s = snapshot();
  const roadmap = s.records.find(r => r.kind === 'meeting' && r.id === 'mtg-roadmap');
  s.records.push({ ...roadmap, id: 'mtg-lunch', data: { ...roadmap.data, title: 'Team lunch', imported: true, transcriptIds: [] } });
  const ids = (filter, showNone = false) => meetingRows(s, filter, '', showNone, NOW).map(m => m.id);
  assert.ok(ids('all').includes('mtg-lunch'), 'All shows the imported in-person meeting');
  assert.ok(ids('process').includes('mtg-lunch'), 'To do shows it');
  assert.deepEqual(meetingCounts(s, NOW), { process: 4, attention: 2, none: 3, hidden: 0 });
  // A meeting nobody transcribed stays out of All, behind the switch.
  assert.ok(!ids('all').includes('mtg-planning') && ids('all', true).includes('mtg-planning'));
});

test('tabsOf gives four tabs with a transcript and none without', () => {
  const s = snapshot();
  const items = meetingItems(s, NOW);
  const byId = id => items.find(m => m.id === id);
  const FOUR = ['notes', 'transcript', 'tasks', 'files'];
  assert.deepEqual(TABS, FOUR);
  for (const id of ['mtg-philips', 'mtg-roadmap', 'mtg-release', 'mtg-vendor', 'mtg-critique']) assert.deepEqual(tabsOf(byId(id)), FOUR, id);
  for (const id of ['mtg-sprint', 'mtg-northwind', 'mtg-planning', 'mtg-lunch', 'ev-next']) assert.deepEqual(tabsOf(byId(id)), [], id);
  // A save running for a waiting meeting: its tabs show what comes in.
  assert.deepEqual(tabsOf({ ...byId('mtg-sprint'), run: { kind: 'transcript_download' } }), FOUR);
  assert.deepEqual(tabsOf({ ...byId('mtg-sprint'), run: { kind: 'transcript_check' } }), []);
});

test('a #/meetings/<id>/people hash opens notes', () => {
  assert.deepEqual(parseHash('#/meetings/x/people'), { route: 'meetings', meetingId: 'x', tab: null });
});

test('hiddenCount counts what Show would bring back', () => {
  const s = snapshot();
  for (const id of ['mtg-philips', 'mtg-planning', 'ev-week-1']) s.records.find(r => r.kind === 'event' && r.id === id).data.seriesId = 'series-sync';
  const hidden = { ids: [], series: ['series-sync'] };
  // Philips is in All; Quarterly planning has no transcript (behind its own switch); the
  // upcoming one is later this week (in Coming up).
  assert.equal(modelOf(s, { hidden }).hiddenCount, 1);
  assert.equal(modelOf(s, { hidden, showNone: true }).hiddenCount, 2);
  assert.equal(modelOf(s, { hidden, filter: 'upcoming' }).hiddenCount, 1, 'Coming up counts its own');
  assert.equal(modelOf(s, { hidden, q: 'zzz' }).hiddenCount, 0, 'a search counts what matches');
});
