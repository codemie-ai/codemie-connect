// The Meetings page's pure model: states without a record, the lanes, the hash, and the JS
// mirrors of native's template choice and glossary reading (checked against native's answers).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  meetingState, meetingRows, meetingCounts, parseHash, meetingHash, resolveTemplate, parseGlossary, parseTags, runOf, legendOf, lineAt, LANES,
} from '../workspace/meetings-model.js';
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
  assert.deepEqual(LANES.map(([id]) => id), ['all', 'process', 'ready', 'attention', 'upcoming']);
  const all = ids('all');
  for (const id of ['mtg-philips', 'mtg-roadmap', 'mtg-release', 'mtg-vendor', 'mtg-sprint', 'mtg-northwind', 'mtg-critique', 'ev-standup']) assert.ok(all.includes(id), `All shows ${id}`);
  for (const id of ['mtg-planning', 'mtg-lunch', 'ev-next', 'ev-current']) assert.ok(!all.includes(id), `All hides ${id}`);
  // Newest first.
  const starts = meetingRows(s, 'all', '', false, NOW).map(m => m.start);
  assert.deepEqual(starts, [...starts].sort((a, b) => b - a));
  const withNone = ids('all', '', true);
  assert.ok(withNone.includes('mtg-planning') && withNone.includes('mtg-lunch'), 'showNone lists them');
  assert.ok(!withNone.includes('ev-next'), 'upcoming ones stay in Upcoming');
  assert.deepEqual(ids('process').sort(), ['mtg-release', 'mtg-roadmap', 'mtg-vendor']);
  assert.deepEqual(ids('ready'), ['mtg-philips']);
  assert.deepEqual(ids('attention').sort(), ['mtg-critique', 'mtg-northwind']);
  const upcoming = ids('upcoming');
  assert.ok(upcoming.includes('ev-next') && upcoming.includes('ev-current') && upcoming.includes('ev-week-1'), upcoming.join());
  assert.ok(upcoming.indexOf('ev-current') < upcoming.indexOf('ev-next'), 'upcoming soonest first');
  // Counts for the filters: To do and Needs you; none for the switch.
  assert.deepEqual(meetingCounts(s, NOW), { process: 3, attention: 2, none: 2 });
  // Search: titles and people.
  assert.deepEqual(ids('all', 'PHILIPS'), ['mtg-philips']);
  assert.deepEqual(ids('all', 'hannah'), ['mtg-northwind']);
  // A meeting whose notes are being made stays in To do and shows its run.
  s.jobs.push({ ...meetingContract().job, payload: { ...meetingContract().job.payload, meetingId: 'mtg-roadmap' } });
  const row = meetingRows(s, 'process', '', false, NOW).find(m => m.id === 'mtg-roadmap');
  assert.equal(row.run.kind, 'meeting_notes');
  assert.deepEqual([row.run.index, row.run.total, row.run.step], [0, 3, 'Writing notes with Meeting notes']);
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

test('parseGlossary and parseTags match glossary-parse.json', () => {
  const fixture = contract('glossary-parse');
  assert.deepEqual(parseGlossary(fixture.glossary), fixture.expected.glossary);
  assert.deepEqual(parseTags(fixture.tags), fixture.expected.tags);
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
  assert.deepEqual(meetingCounts(s, NOW), { process: 4, attention: 2, none: 1 });
  // A meeting nobody transcribed stays out of All, behind the switch.
  assert.ok(!ids('all').includes('mtg-planning') && ids('all', true).includes('mtg-planning'));
});
