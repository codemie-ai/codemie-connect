// Synthetic workspace snapshot for unit and browser tests. No real account data: every name,
// address and message below is invented. Times are relative to `nowMs` so Today always has a
// meeting in progress, a next meeting and free time.
import { deflateSync, crc32 } from 'node:zlib';

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
