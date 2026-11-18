// Synthetic workspace snapshot for unit and browser tests. No real account data: every name,
// address and message below is invented. Times are relative to `nowMs` so Today always has a
// meeting in progress, a next meeting and free time.
import { deflateSync, crc32 } from 'node:zlib';
import { readFileSync } from 'node:fs';

const CID = 'fixture-account';

/** 64×64 gradient PNG data URL standing in for a Microsoft profile photo. */
export function fixturePhoto() {
  const size = 64;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const i = y * (size * 3 + 1) + 1 + x * 3;
      const d = Math.hypot(x - 32, y - 24);
      const skin = d < 14;
      const body = Math.hypot(x - 32, y - 70) < 34;
      raw[i] = skin ? 236 : body ? 70 : 92 + y;
      raw[i + 1] = skin ? 196 : body ? 90 : 60 + x;
      raw[i + 2] = skin ? 170 : body ? 160 : 200;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  return `data:image/png;base64,${png.toString('base64')}`;
}

const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const dateOnly = ms => new Date(ms).toISOString().slice(0, 10);

export function buildSnapshot(nowMs = Date.now(), { connected = true, zone = 'UTC', theme = 'dark', photo = true } = {}) {
  const now = Math.floor(nowMs / 1000);
  const minute = 60_000;
  const hour = 60 * minute;
  // Anchor fixed-time events to the start of the current hour so they never collide oddly.
  const top = Math.floor(nowMs / hour) * hour;
  const record = (id, kind, source, data, extra = {}) => ({ id, kind, source, data, connectionId: CID, workspaceId: null, revision: `r-${id}`, updatedAt: now - 120, ...extra });
  const people = {
    jordan: { name: 'Jordan Lee', address: 'jordan.lee@example.test' },
    priya: { name: 'Priya Natarajan', address: 'priya.n@example.test' },
    sam: { name: 'Sam Okafor', address: 'sam.okafor@example.test' },
    elena: { name: 'Elena Varga', address: 'elena.varga@example.test' },
    me: { name: 'Taylor Morgan', address: 'taylor.morgan@example.test' },
  };
  const attendees = list => list.map((p, i) => ({ name: p.name, address: p.address, type: 'required', response: ['accepted', 'tentativelyAccepted', 'none', 'declined'][i % 4] }));
  const ev = (id, cal, title, startMs, endMs, data = {}) => record(id, 'event', `calendar:${cal}`, {
    title, start: iso(startMs), end: iso(endMs), allDay: false, cancelled: false, calendarId: cal,
    location: '', organizer: people.jordan, attendees: [], url: 'https://outlook.office.com/calendar/item/fixture',
    joinUrl: null, preview: '', showAs: 'busy', response: 'accepted', isOrganizer: false, categories: [], importance: 'normal', private: false, ...data,
  });
  const allDay = (id, cal, title, dayMs, days = 1) => record(id, 'event', `calendar:${cal}`, {
    title, start: `${dateOnly(dayMs)}T00:00:00Z`, end: `${dateOnly(dayMs + days * 86_400_000)}T00:00:00Z`, startDate: dateOnly(dayMs), endDate: dateOnly(dayMs + days * 86_400_000),
    allDay: true, cancelled: false, calendarId: cal, showAs: 'free', response: 'accepted', attendees: [], organizer: people.me, url: 'https://outlook.office.com/calendar/item/fixture',
  });
  const teams = 'https://teams.microsoft.com/l/meetup-join/fixture';
  const events = [
    ev('ev-standup', 'cal-main', 'Daily stand-up', top - 5 * hour, top - 5 * hour + 15 * minute, { joinUrl: teams, attendees: attendees([people.jordan, people.priya, people.sam]) }),
    ev('ev-current', 'cal-main', 'Architecture review: Connect sync', nowMs - 20 * minute, nowMs + 25 * minute, { joinUrl: teams, location: 'Microsoft Teams Meeting', preview: 'Agenda: calendar windows, Teams change detection, rollout plan.', attendees: attendees([people.jordan, people.priya, people.sam, people.elena]) }),
    ev('ev-next', 'cal-main', '1:1 with Jordan', nowMs + 60 * minute, nowMs + 90 * minute, { joinUrl: teams, organizer: people.me, isOrganizer: true, response: 'organizer', attendees: attendees([people.jordan]) }),
    ev('ev-overlap-a', 'cal-main', 'Design critique', nowMs + 3 * hour, nowMs + 4 * hour, { location: 'Kyiv · Room 4.12', attendees: attendees([people.elena, people.sam]) }),
    ev('ev-overlap-b', 'cal-team', 'Hiring sync', nowMs + 3.5 * hour, nowMs + 4.5 * hour, { response: 'tentativelyAccepted', showAs: 'tentative', joinUrl: teams }),
    ev('ev-short', 'cal-main', 'Quick check-in', nowMs + 5 * hour, nowMs + 5 * hour + 15 * minute, {}),
    ev('ev-tomorrow', 'cal-main', 'Sprint planning', top + 24 * hour, top + 25.5 * hour, { joinUrl: teams, attendees: attendees([people.jordan, people.priya, people.sam, people.elena]) }),
    ev('ev-week-1', 'cal-team', 'Team demo', top + 48 * hour, top + 49 * hour, { joinUrl: teams }),
    ev('ev-week-2', 'cal-main', 'Customer workshop <b>prep</b>', top + 72 * hour, top + 74 * hour, { location: 'Office' }),
    ev('ev-cancelled', 'cal-main', 'Cancelled sync', nowMs + 2 * hour, nowMs + 2.5 * hour, { cancelled: true }),
    allDay('ev-allday', 'cal-team', 'Release week', nowMs - 86_400_000, 3),
    allDay('ev-birthday', 'cal-birthdays', "Priya's birthday", nowMs + 86_400_000),
  ];
  const mail = (id, lane, from, title, text, ageMin, data = {}) => record(id, 'message', 'mail:inbox', {
    channel: 'mail', title, text, from: from.name, fromAddress: from.address, at: now - ageMin * 60, lane, reason: lane === 'reply' ? 'Direct question addressed to you' : lane === 'critical' ? 'Matches critical rule “production”' : lane === 'fyi' ? 'You are copied' : 'Automated sender exclusion',
    lifecycle: 'open', conversationId: `conv-${id}`, url: 'https://outlook.office.com/mail/fixture', isRead: ageMin > 90, importance: 'normal', hasAttachments: false, flagged: false,
    to: [{ emailAddress: { name: people.me.name, address: people.me.address } }], isMine: false, ...data,
  });
  const chat = (id, lane, from, chatId, text, ageMin, data = {}) => record(id, 'message', `chat:${chatId}`, {
    channel: 'chat', title: data.title || 'Teams chat', text, from: from.name, fromId: from.address, at: now - ageMin * 60, lane, reason: lane === 'reply' ? 'One-to-one chat waiting for you' : 'Group conversation', lifecycle: 'open', conversationId: `chat:${chatId}`, chatId, url: 'https://teams.microsoft.com/l/message/fixture', isMine: false, mentionsMe: lane === 'reply', ...data,
  });
  const messages = [
    mail('m-critical', 'critical', people.sam, 'Production alert: sync latency above threshold', 'Production sync latency is above 5s for EU tenants. Can you confirm the rollback plan?', 12, { importance: 'high' }),
    mail('m-reply-1', 'reply', people.priya, 'Review: Q4 workspace roadmap', 'Could you review the roadmap draft before Thursday? I left two open questions in section 3.', 35, { hasAttachments: true }),
    chat('c-reply-1', 'reply', people.jordan, 'chat-jordan', 'Can you share the calendar layout notes before our 1:1?', 8, { title: 'Jordan Lee', chatType: 'oneOnOne' }),
    chat('c-reply-1b', 'reply', people.jordan, 'chat-jordan', 'Also, could you check the event colours?', 20, { title: 'Jordan Lee', chatType: 'oneOnOne' }),
    mail('m-reply-2', 'reply', people.elena, 'Room booking for the workshop', 'Do we need the large room or is 4.12 enough? Let me know by EOD.', 190, { flagged: true }),
    chat('c-reply-2', 'reply', people.priya, 'chat-group', '@Taylor can you approve the release checklist?', 260, { title: 'Release crew', chatType: 'group' }),
    mail('m-thread-mine', 'fyi', people.me, 'Re: Review: Q4 workspace roadmap', 'Thanks Priya, looking at it today.', 400, { isMine: true, conversationId: 'conv-m-reply-1', from: people.me.name, fromAddress: people.me.address }),
    mail('m-fyi-1', 'fyi', people.jordan, 'Notes from Monday sync', 'Sharing the notes. No action needed.', 600),
    mail('m-fyi-2', 'fyi', people.sam, 'Office closed on Friday', 'Reminder: the office is closed on Friday.', 1600),
    mail('m-low-1', 'low', { name: 'Build bot', address: 'noreply@example.test' }, 'Nightly build passed', 'All 529 checks passed.', 300),
    mail('m-xss', 'fyi', people.elena, '<img src=x onerror=alert(1)>', '<script>window.__xss=1</script> escaped text', 2000),
  ];
  const calendars = record('calendars', 'catalog', 'catalog', { values: [
    { id: 'cal-main', name: 'Calendar', isDefaultCalendar: true, canEdit: true, color: 'auto', hexColor: '' },
    { id: 'cal-team', name: 'Team events', isDefaultCalendar: false, canEdit: true, color: 'lightGreen', hexColor: '' },
    { id: 'cal-birthdays', name: 'Birthdays', isDefaultCalendar: false, canEdit: false, color: 'lightPink', hexColor: '' },
  ] });
  const chats = record('chats', 'catalog', 'catalog', { hasMore: false, values: [
    { id: 'chat-jordan', chatType: 'oneOnOne', topic: null, members: [{ userId: 'me', displayName: people.me.name }, { userId: 'j', displayName: people.jordan.name }] },
    { id: 'chat-group', chatType: 'group', topic: 'Release crew', members: [] },
  ] });
  const windows = ['cal-main', 'cal-team', 'cal-birthdays'].map(cal => record(`win-${cal}`, 'calendar_window', `calendar:${cal}`, { start: now - 400 * 86400, end: now + 400 * 86400 }));
  const local = (id, kind, data, updated = now - 300) => ({ id, kind, source: 'local', data, connectionId: null, workspaceId: 'personal', revision: `l-${id}`, updatedAt: updated });
  const localRecords = [
    local('commit-1', 'commitment', { text: 'Send the roadmap comments to Priya', done: false, due: dateOnly(nowMs + 86_400_000), owner: 'You' }),
    local('commit-2', 'commitment', { text: 'Book the workshop room', done: false, due: null, owner: 'You' }),
    local('commit-3', 'commitment', { text: 'Share stand-up notes', done: true, owner: 'You' }),
    local('note-1', 'note', { text: 'Ask Jordan about the Teams rollout timeline.' }),
  ];
  const connection = connected ? {
    id: CID, accountKey: 'k', displayName: 'Taylor Morgan', givenName: 'Taylor', jobTitle: 'Lead Software Engineer', department: 'AI/Run CodeMie', officeLocation: 'Kyiv',
    email: people.me.address, userId: 'me', generation: 1, policyRevision: 1, sourceRevision: 1,
    scopes: ['Calendars.Read', 'Mail.Read', 'Chat.Read'], enabled: ['calendar', 'mail', 'chats'], status: 'connected',
    lastSync: now - 90, syncError: null, retryAt: null, photo: photo ? fixturePhoto() : null, profileAt: now - 3600,
  } : null;
  return {
    revision: 7,
    available: connected,
    // The resolved meetings folder (`meetingsRoot`): a setting, there signed in or not.
    meetingsRoot: { path: '/Users/taylor/CodeMie Connect/Meetings', isDefault: true },
    // Every note template (`noteTemplates`): the two built-ins as native sends them
    // (contract/note-templates.json), there signed in or not.
    noteTemplates: contract('note-templates'),
    settings: {
      theme, timeZone: zone, background: true, launchAtLogin: false, criticalRepeat: true, syncDays: 30, notifications: true, notificationPreview: false,
      quietStart: '22:00', quietEnd: '08:00', clientId: '3d7688c6-f449-4d04-8b0d-57d94818e922', tenant: 'common', activeWorkspace: 'personal',
      activeConnection: connected ? CID : null, notificationPermission: 'os_managed', focusUntil: null,
    },
    workspaces: [
      { id: 'personal', name: 'Personal', color: '#2297F6', archived: false, isDefault: true, connectionId: connected ? CID : null, revision: 3, accessRevision: 1, profileRevision: 0, sources: { all: true }, layout: ['brief', 'focus', 'calendar', 'inbox', 'commitments'], widgetWidths: {} },
      { id: 'atlas', name: 'Project Atlas', color: '#7B3FBF', archived: false, isDefault: false, connectionId: connected ? CID : null, revision: 1, accessRevision: 1, profileRevision: 0, sources: { all: true }, layout: ['brief', 'calendar', 'commitments'], widgetWidths: {} },
    ],
    connection,
    records: connected ? [...events, ...messages, calendars, chats, ...windows, ...localRecords] : localRecords,
    jobs: connected ? [{ id: 'job-sync-1', workspaceId: null, connectionId: CID, kind: 'sync', key: 'sync:1', state: 'succeeded', dueAt: now - 95, leaseUntil: null, attempts: 1, policy: {}, payload: { force: false }, result: 'Sources refreshed' }] : [],
  };
}

// ---------------------------------------------------------------- Claude (AI) status presets
// Derived from ui/test/fixtures/contract/*.json, which the Rust test `contract_fixtures_*`
// writes from the real handlers (UPDATE_CONTRACT_FIXTURES=1 cargo test contract_fixtures).

const contract = name => JSON.parse(readFileSync(new URL(`./contract/${name}.json`, import.meta.url), 'utf8'));
export const contractFixtures = () => ({
  status: contract('ai-status'), usage: contract('ai-usage'), testOk: contract('ai-test-ok'), testFail: contract('ai-test-fail'),
  draft: contract('draft-ai'), draftChat: contract('draft-ai-chat'), summary: contract('summary'),
  jobSummaryFailed: contract('job-ai-summarize-failed'), jobSummaryRunning: contract('job-ai-summarize-running'),
  jobFailed: contract('job-ai-draft-failed'), jobConflict: contract('job-ai-draft-conflict'), jobRunning: contract('job-ai-draft-running'),
});

/**
 * `ai_status` answers for the browser mock and unit tests. Kinds: none, native,
 * native_needs_login, codemie_only, both. `defaultProfile` overrides the saved default.
 */
export function aiStatus(kind = 'both', { defaultProfile } = {}) {
  const { profiles: all, settings } = contract('ai-status');
  const [native, prod, staging] = all;
  const notInstalled = { ...native, state: 'not_installed', version: null, account: null, message: 'Claude Code is not installed.' };
  const needsLogin = { ...native, state: 'needs_login', account: null, message: 'Claude Code is not signed in.' };
  const sets = {
    none: [notInstalled],
    native: [native],
    native_needs_login: [needsLogin],
    codemie_only: [notInstalled, prod],
    both: [native, prod, staging],
  };
  const profiles = sets[kind];
  if (!profiles) throw new Error(`Unknown aiStatus kind ${kind}`);
  const defaults = { none: null, native: 'claude', native_needs_login: null, codemie_only: 'codemie:prod', both: settings.defaultProfile };
  return {
    profiles: JSON.parse(JSON.stringify(profiles)),
    settings: { defaultProfile: defaultProfile === undefined ? defaults[kind] : defaultProfile, routes: kind === 'both' ? settings.routes : {} },
  };
}

export const aiUsage = () => contract('ai-usage');

// ---------------------------------------------------------------- automations (DESIGN 6.6)
// Written by the Rust tests `contract_fixtures` (automation.json) and
// `contract_fixtures_match_the_real_automation_runs` (runs, Run log pages, snapshot runs).

export const automationContract = () => ({
  automation: contract('automation'), runOk: contract('automation-run-ok'), runFailed: contract('automation-run-failed'),
  runDraft: contract('automation-run-draft'), runsPage: contract('automation-runs-page'), snapshotRuns: contract('automation-snapshot-runs'),
});

/**
 * The contract automations and the runs the snapshot keeps of them, moved to `nowMs`:
 * "Morning brief" (`auto-brief`, weekdays 08:45) ran an hour ago (delivered to Today) and failed
 * 5 minutes ago; "Draft replies to Ann" (`auto-reply`, mail from Ann) drafted a reply 20
 * minutes ago. Also the records the runs cite: Ann's two mails (`m0`, `m1`, FYI so the Inbox
 * counts stay) and the commitment `c1`.
 */
export function automationRecords(nowMs, connectionId = CID) {
  const now = Math.floor(nowMs / 1000);
  const { schedule, event } = contract('automation');
  const saved = (tpl, id, name) => ({ ...tpl, id, updatedAt: now - 86_400, data: { ...tpl.data, id, name } });
  const automations = [saved(schedule, 'auto-brief', 'Morning brief'), saved(event, 'auto-reply', 'Draft replies to Ann')];
  const byId = Object.fromEntries(contract('automation-snapshot-runs').map(r => [r.id, r]));
  const at = (run, ago) => ({ ...run, updatedAt: now - ago + 5, data: { ...run.data, connectionId, startedAt: now - ago } });
  const runs = [at(byId['run-1'], 3600), at(byId['run-2'], 300), at(byId['run-3'], 1200)];
  const ann = (id, ago, text) => ({
    id, kind: 'message', source: 'mail:inbox', connectionId, workspaceId: null, revision: `r-${id}`, updatedAt: now - ago,
    data: { channel: 'mail', title: 'Q3 budget', text, from: 'Ann Lee', fromAddress: 'ann@example.test', at: now - ago, lane: 'fyi', lifecycle: 'open', conversationId: 'conv-ann', url: 'https://outlook.office.com/mail/fixture', isRead: true, isMine: false, to: [] },
  });
  const sources = [
    ann('m0', 7200, 'Could you review the Q3 budget plan?'),
    ann('m1', 1500, 'Can you send the Q3 numbers by Friday?'),
    { id: 'c1', kind: 'commitment', source: 'local', connectionId: null, workspaceId: 'personal', revision: 'l-c1', updatedAt: now - 600, data: { text: 'Send the roadmap', done: false, owner: 'You' } },
  ];
  return { automations, runs, sources };
}

/** `snapshot` with the contract automations, their runs and the records the runs cite. */
export function withAutomations(snapshot, nowMs) {
  const { automations, runs, sources } = automationRecords(nowMs, snapshot.connection?.id || CID);
  snapshot.records.push(...automations, ...runs, ...sources);
  return snapshot;
}

// ---------------------------------------------------------------- tasks
// Written by the Rust test `contract_fixtures_match_the_real_tasks` (task-records.json,
// task-delete.json): the body of a task as `task_save` stores it, and the `task_delete` answer.

export const taskContract = () => ({ records: contract('task-records'), deleted: contract('task-delete'), meetings: contract('meeting-records') });

/** `YYYY-MM-DD` `days` from `nowMs` in `zone`. */
function dayIn(nowMs, zone, days) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(nowMs)).map(x => [x.type, x.value]));
  const d = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day) + days));
  return d.toISOString().slice(0, 10);
}

/**
 * `snapshot` with a Tasks board: two past meetings (today's "Daily stand-up" and the "Philips
 * CodeMie conversations syncup" two days ago, each with its meeting record), and tasks in every
 * column: two to review (one with an owner Connect isn't sure of), an overdue one, mine due today,
 * one waiting, one for nobody, one done two days ago, one done a month ago (behind Show older) and
 * one dismissed. Owners are the fixture's people by address; the legacy commitments stay as they are.
 */
export function withTasks(snapshot, nowMs = Date.now()) {
  const now = Math.floor(nowMs / 1000);
  const zone = snapshot.settings.timeZone || 'UTC';
  const day = n => dayIn(nowMs, zone, n);
  const cid = snapshot.connection?.id || CID;
  const people = {
    jordan: ['jordan.lee@example.test', 'Jordan Lee'],
    priya: ['priya.n@example.test', 'Priya Natarajan'],
    sam: ['sam.okafor@example.test', 'Sam Okafor'],
    elena: ['elena.varga@example.test', 'Elena Varga'],
    me: ['taylor.morgan@example.test', 'Taylor Morgan'],
  };
  const { records: [template], meetings } = taskContract();
  const downloaded = meetings.find(m => m.data.state === 'downloaded');
  const standup = snapshot.records.find(r => r.id === 'ev-standup');
  const syncStart = (now - 2 * 86_400 - 3600) * 1000;
  const sync = {
    ...standup, id: 'ev-sync', revision: 'r-ev-sync',
    data: {
      ...standup?.data, title: 'Philips CodeMie conversations syncup', start: new Date(syncStart).toISOString().replace(/\.\d{3}Z$/, 'Z'), end: new Date(syncStart + 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      organizer: { name: 'Jordan Lee', address: people.jordan[0] },
      attendees: [people.priya, people.sam, people.elena, people.me].map(([address, name]) => ({ name, address, type: 'required', response: 'accepted' })),
    },
  };
  const meeting = ev => ({
    ...downloaded, id: ev.id, connectionId: cid, revision: `r-meeting-${ev.id}`, updatedAt: now - 3600,
    data: { ...downloaded.data, eventId: ev.id, title: ev.data.title, start: ev.data.start, end: ev.data.end, folder: `/Users/taylor/CodeMie Connect/Meetings/${ev.id}` },
  });
  const extra = standup ? [sync, meeting(standup), meeting(sync)] : [];
  const added = now - 3 * 86_400;
  const task = (id, order, status, data = {}) => ({
    ...template, id, revision: `l-${id}`, updatedAt: data.doneAt || now - 600,
    data: {
      text: id, owner: null, ownerName: null, due: null, notes: null, meetingId: null, line: null, quote: null, quoteAt: null, speaker: null, confidence: null,
      createdAt: added, history: [{ at: added, text: 'Added by you' }], ...data,
      order, status, done: status === 'done', doneAt: data.doneAt || null,
    },
  });
  const owner = key => ({ owner: people[key][0], ownerName: people[key][1] });
  const said = (meetingId, line, quoteAt, quote, speaker = 'Jordan Lee') => ({ meetingId, line, quoteAt, quote, speaker, confidence: 'high', history: [{ at: now - 3600, text: 'Found in the notes (Meeting notes)' }] });
  const tasks = [
    task('task-share', 1, 'review', { text: 'Share the Tasks board mockups', ...owner('jordan'), due: day(1), ...said('ev-standup', 3, 173, 'I’ll share the Tasks board mockups tomorrow.') }),
    task('task-bug', 2, 'review', { text: 'Move the recurring-meeting sync bug to 2.5', ...owner('priya'), ...said('ev-sync', 7, 412, 'Priya, can you take the recurring sync bug into 2.5?'), confidence: 'low' }),
    task('task-legal', 3, 'todo', { text: 'Send Legal the written legal-hold requirement', ...owner('sam'), due: day(-3), ...said('ev-sync', 12, 655, 'I’ll send Legal the written requirement.', 'Sam Okafor') }),
    task('task-names', 4, 'todo', { text: 'Send the names of the 40 pilot users', ...owner('elena'), due: day(10), ...said('ev-sync', 15, 801, 'I’ll send the names next week.', 'Elena Varga') }),
    task('task-demo', 5, 'doing', { text: 'Prepare the export demo for the Philips sync', ...owner('me'), due: day(0), notes: 'Use the staging tenant.' }),
    task('task-hr', 6, 'waiting', { text: 'Ask HR for a user-to-department CSV export', ...owner('jordan'), meetingId: 'ev-standup' }),
    task('task-tenant', 7, 'todo', { text: 'Ask IT for a throttling test tenant' }),
    task('task-pilot', 8, 'done', { text: 'Draft the January pilot plan', ...owner('priya'), doneAt: now - 2 * 86_400 }),
    task('task-room', 9, 'done', { text: 'Book a room for demo day', owner: 'You', doneAt: now - 30 * 86_400 }),
    task('task-dashboard', 10, 'dismissed', { text: 'Re-check the old dashboard', ...said('ev-standup', 20, 1201, 'Maybe someone could look at the old dashboard.') }),
  ];
  snapshot.records.push(...extra, ...tasks);
  return snapshot;
}

// ---------------------------------------------------------------- data location (DESIGN 8)
// Written by the Rust test `contract_fixtures_match_the_real_data_location`.

export const LOCATIONS = ['default', 'custom', 'custom-copied', 'custom-adopted', 'default-previous'];
export const CHECKS = ['ok', 'cloud', 'network', 'exfat', 'tight', 'existing', 'existing-data', 'recovery'];
/** A `data_location_get` answer: default, custom, custom-copied, custom-adopted, default-previous. */
export const dataLocation = name => contract(`location-${name}`);
/** A `data_location_check` answer: ok, cloud, network, exfat, tight, existing, existing-data, recovery. */
export const folderCheck = name => contract(`check-${name}`);

/**
 * The browser mock's plugins (`plugins_request`), from the Rust contract answers: the built-in
 * marketplace, a catalog with a Knowledge plugin and one for a newer engine, and the synthetic
 * `hello` plugin (ui/test/fixtures/plugins/hello/) a local marketplace offers.
 */
export function pluginContract() {
  const hello = JSON.parse(readFileSync(new URL('./plugins/hello/echo-plugin.json', import.meta.url), 'utf8'));
  const catalog = contract('plugins-catalog');
  return {
    markets: contract('plugins-markets').filter(m => m.builtIn),
    others: catalog.plugins.filter(p => !p.installable),
    hello: {
      offer: { id: hello.id, name: hello.name, version: hello.version, summary: hello.summary, categories: ['test'], featured: true, installable: true, reason: null, installed: null, update: false },
      sheet: [
        { key: 'signin', support: { status: 'partial', limit: 'Connect signs in to GitHub only' }, text: 'Use your sign-in to github.com, and send it to the places it talks to' },
        { key: 'network', support: { status: 'supported' }, text: 'Connect to api.example.com and the addresses you list in its settings' },
      ],
      sheetHash: 'f00dfeed',
      manifest: hello,
    },
    signin: contract('plugins-signin'),
  };
}
