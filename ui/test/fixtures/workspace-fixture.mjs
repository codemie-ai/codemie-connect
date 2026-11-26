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
    // As Graph says it: a Teams meeting is an online meeting (normalize_event, `isOnlineMeeting`).
    isOnlineMeeting: data.isOnlineMeeting ?? !!data.joinUrl,
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
      // Settings › Notifications' "Menu bar" card (menu-bar-count design §1): only replies on.
      menuBar: { replies: true, tasks: false, meetings: false, automations: false },
      ...contract('settings-view').default,
    },
    workspaces: [
      { id: 'personal', name: 'Personal', color: '#2297F6', archived: false, isDefault: true, connectionId: connected ? CID : null, revision: 3, accessRevision: 1, profileRevision: 0, sources: { all: true }, layout: ['brief', 'focus', 'calendar', 'inbox', 'commitments'], widgetWidths: {}, today: {} },
      { id: 'atlas', name: 'Project Atlas', color: '#7B3FBF', archived: false, isDefault: false, connectionId: connected ? CID : null, revision: 1, accessRevision: 1, profileRevision: 0, sources: { all: true }, layout: ['brief', 'calendar', 'commitments'], widgetWidths: {}, today: {} },
    ],
    connection,
    records: connected ? [...events, ...messages, calendars, chats, ...windows, ...localRecords] : localRecords,
    jobs: connected ? [{ id: 'job-sync-1', workspaceId: null, connectionId: CID, kind: 'sync', key: 'sync:1', state: 'succeeded', dueAt: now - 95, leaseUntil: null, attempts: 1, policy: {}, payload: { force: false }, result: 'Sources refreshed' }] : [],
    // The snapshot's own menu-bar count (menu-bar-count design §5), matching the settings above
    // (replies only): Task 2's "replies" contract state. `withMenuBar` swaps in another one.
    menuBar: contract('menu-bar-states').replies,
    // The snapshot's `ask` (ask-capture design § 6): no threads yet, the field in the menu.
    // `withAsk` swaps in another ask-states.json state.
    ask: contract('ask-states').empty,
  };
}

// ---------------------------------------------------------------- Ask (step 9, Task 9)
// Written by the Rust test that projects the real snapshot's `ask` (ask-states.json): `empty`,
// `idle`, `running`, `failedLast`, `stoppedLast`.

export const askStates = () => contract('ask-states');
/** An `ask_read` answer (ask-thread.json): a done turn with cites of every kind and three actions, a failed turn and a stopped turn. */
export const askThread = () => contract('ask-thread');

/** `snapshot.ask` replaced with one of the named states from ask-states.json. */
export function withAsk(s, stateName) {
  s.ask = askStates()[stateName];
  return s;
}

// ---------------------------------------------------------------- menu bar (Task 5)
// Written by the Rust test `contract_fixtures_match_the_menu_bar` (menu-bar-states.json,
// menu-bar-reply-cases.json).

export const menuBarStates = () => contract('menu-bar-states');

/** `snapshot.menuBar` replaced with one of Task 2's named states: `zero`, `replies`, `several`,
 *  `capped`, `amberOnly`, `amberWithCount`, `nothingChosen`. */
export function withMenuBar(s, stateName) {
  s.menuBar = menuBarStates()[stateName];
  return s;
}

// ---------------------------------------------------------------- Claude (AI) status presets
// Derived from ui/test/fixtures/contract/*.json, which the Rust test `contract_fixtures_*`
// writes from the real handlers (UPDATE_CONTRACT_FIXTURES=1 cargo test contract_fixtures).

const contract = name => JSON.parse(readFileSync(new URL(`./contract/${name}.json`, import.meta.url), 'utf8'));
export const contractFixtures = () => ({
  status: contract('ai-status'), usage: contract('ai-usage'), testOk: contract('ai-test-ok'), testFail: contract('ai-test-fail'),
  draft: contract('draft-ai'), draftChat: contract('draft-ai-chat'), draftVoice: contract('draft-ai-voice'), summary: contract('summary'),
  jobSummaryFailed: contract('job-ai-summarize-failed'), jobSummaryRunning: contract('job-ai-summarize-running'),
  jobFailed: contract('job-ai-draft-failed'), jobConflict: contract('job-ai-draft-conflict'), jobRunning: contract('job-ai-draft-running'),
  // The `voice_import_scan` answer for the invented skills folder (reply voice design §11).
  voiceImport: contract('voice-import-preview'),
});

// ---------------------------------------------------------------- reply voice (Task 9)
// Written by the Rust test that projects the real snapshot's `replyVoice` (voice-states.json):
// `off`, `offWithCopy`, `ready`, `needsSetup`, `unavailable`, `pluginOff`, `loading`, `noFacts`.

export const voiceStates = () => contract('voice-states');

/** `snapshot.replyVoice` replaced with one of the named states from voice-states.json. */
export function withVoice(s, stateName) {
  s.replyVoice = voiceStates()[stateName];
  return s;
}

// A test-only mirror of Rust `workspace::ai::choose` for the browser mock and the presets below.
// The window never resolves rows itself; `chooses_like_rust` (ai-settings.test.mjs) pins this
// mirror to ai-route-cases.json and ai-status.json, which Rust writes from `choose`. Self-contained,
// so the browser mock gets it as source.
/** `chosen` of `ai_status` / `ai_settings_save` for `settings` (test mirror of Rust `chosen_all`). */
export function chooseAll(s = {}) {
  const GROUP = { briefing: 'automation', triage: 'automation', commitments: 'automation' };
  const set = v => v || null;
  const inherited = key => {
    if (key == null) return { profile: set(s.defaultProfile), model: set(s.defaultModel), fallback: set(s.defaultFallback) };
    const plugin = key.startsWith('plugin:');
    const group = inherited(plugin ? 'plugin' : GROUP[key] || null);
    const r = plugin ? s.plugins?.[key.slice(7)] : s.routes?.[key];
    if (!r) return group;
    const own = set(r.profile);
    return { profile: own || group.profile, model: own ? set(r.model) : set(r.model) || group.model, fallback: set(r.fallback) || group.fallback };
  };
  const purposes = ['mail_draft', 'chat_draft', 'summary', 'automation', 'plugin', 'meeting', 'briefing', 'triage', 'commitments', 'ask'];
  const keys = [null, ...purposes, ...Object.keys(s.plugins || {}).map(id => `plugin:${id}`)];
  const groupOf = key => (key == null ? null : key.startsWith('plugin:') ? 'plugin' : GROUP[key] || 'default');
  return Object.fromEntries(keys.map(key => {
    const c = inherited(key);
    return [key ?? 'default', { ...c, fallback: c.fallback && c.fallback === c.profile ? null : c.fallback, group: groupOf(key) }];
  }));
}

/**
 * `ai_status` answers for the browser mock and unit tests. Kinds: none, native,
 * native_needs_login, codemie_only, both, and `all` (the whole contract fixture: an Ollama
 * profile, a default fallback and a plugin row). `defaultProfile` overrides the saved default.
 */
export function aiStatus(kind = 'both', { defaultProfile } = {}) {
  const { profiles: all, settings } = contract('ai-status');
  if (kind === 'all') {
    const out = JSON.parse(JSON.stringify({ profiles: all, settings }));
    if (defaultProfile !== undefined) out.settings.defaultProfile = defaultProfile;
    return { ...out, chosen: chooseAll(out.settings) };
  }
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
  const out = {
    profiles: JSON.parse(JSON.stringify(profiles)),
    settings: { defaultProfile: defaultProfile === undefined ? defaults[kind] : defaultProfile, routes: kind === 'both' ? settings.routes : {} },
  };
  out.chosen = chooseAll(out.settings);
  return out;
}

export const aiUsage = () => contract('ai-usage');

// ---------------------------------------------------------------- automations (DESIGN 6.6)
// Written by the Rust tests `contract_fixtures` (automation.json) and
// `contract_fixtures_match_the_real_automation_runs` (runs, Run log pages, snapshot runs).

export const automationContract = () => ({
  automation: contract('automation'), runOk: contract('automation-run-ok'), runFailed: contract('automation-run-failed'),
  runDraft: contract('automation-run-draft'), runsPage: contract('automation-runs-page'), snapshotRuns: contract('automation-snapshot-runs'),
  runSummary: contract('automation-run-summary'),
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

/**
 * Two habit automations and a run of each, for the checks of the create-tasks delivery and the
 * Formal summary: "Inbox triage" (`auto-triage`, weekdays 08:00, Tasks on) made two reply tasks
 * 30 minutes ago (one more was already there, one was left out, one task looks handled), and
 * "Formal meeting summary" (`auto-summary`) queued a Formal summary for the Daily stand-up
 * (`ev-standup`) 40 minutes ago. The task ids are links only; the tasks are not records here.
 */
export function habitRecords(nowMs, connectionId = CID) {
  const now = Math.floor(nowMs / 1000);
  const { schedule, summary } = contract('automation');
  const triage = {
    ...schedule, id: 'auto-triage', updatedAt: now - 86_400,
    data: {
      ...schedule.data, id: 'auto-triage', name: 'Inbox triage', ai: { profile: null, model: null }, capUsd: null,
      trigger: { kind: 'schedule', days: [1, 2, 3, 4, 5], time: '08:00' },
      read: { ...schedule.data.read, calendarToday: false, needsReply: true, commitmentsNotes: true },
      prompt: 'Go through the messages waiting for my reply. Make a reply task for each one that needs an answer or a decision from me.',
      deliver: { ...schedule.data.deliver, today: true, notify: false, createTasks: true },
    },
  };
  const formal = { ...summary, id: 'auto-summary', updatedAt: now - 86_400, data: { ...summary.data, id: 'auto-summary', name: 'Formal meeting summary', deliver: { ...summary.data.deliver, meetingSummary: 'formal-summary' } } };
  const ok = contract('automation-run-ok');
  const triageRun = {
    ...ok, id: 'run-triage', updatedAt: now - 1800 + 5,
    data: {
      ...ok.data, automationId: 'auto-triage', automationName: 'Inbox triage', connectionId, startedAt: now - 1800, durationMs: 4100, costUsd: 0.02,
      trigger: { kind: 'schedule', scheduledAt: now - 1800 }, delivered: ['today', 'tasks'], handled: 1,
      output: { title: '3 messages need you', items: [], summaryMarkdown: '3 messages need you; two are about the SOW.', summaryBlocks: [{ type: 'paragraph', inlines: [{ text: '3 messages need you; two are about the SOW.' }] }] },
      tasks: {
        made: [{ id: 'task-olga', kind: 'reply', text: 'Reply to Olga about SOW section 4' }, { id: 'task-marek', kind: 'reply', text: 'Reply to Marek about the pilot users' }],
        existing: 1, dropped: 1,
      },
    },
  };
  const queued = contract('automation-run-summary');
  const summaryRun = {
    ...queued, id: 'run-summary', updatedAt: now - 2400 + 5,
    data: { ...queued.data, automationName: 'Formal meeting summary', connectionId, startedAt: now - 2400, meetingId: 'ev-standup', trigger: { ...queued.data.trigger, sourceId: 'ev-standup' }, output: { title: 'Formal summary queued for Daily stand-up' } },
  };
  return { automations: [triage, formal], runs: [triageRun, summaryRun] };
}

/** `snapshot` with the contract automations, their runs and the records the runs cite; with
 *  `habits`, also the Inbox triage and Formal meeting summary automations and their runs. */
export function withAutomations(snapshot, nowMs, { habits = false } = {}) {
  const cid = snapshot.connection?.id || CID;
  const { automations, runs, sources } = automationRecords(nowMs, cid);
  snapshot.records.push(...automations, ...runs, ...sources);
  if (habits) {
    const more = habitRecords(nowMs, cid);
    snapshot.records.push(...more.automations, ...more.runs);
  }
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

// ---------------------------------------------------------------- meetings (Task 4)
// Meeting records as native keeps them (meeting-records.json, meeting-ready.json) on events
// relative to `nowMs`, a running notes job (meeting-notes-job.json) shape, and what
// `meeting_read` answers for their folders (meeting-transcript.json, meeting-files.json shapes).

export const meetingContract = () => ({
  records: contract('meeting-records'), ready: contract('meeting-ready'), job: contract('meeting-notes-job'),
  transcript: contract('meeting-transcript'), files: contract('meeting-files'), rules: contract('meeting-rules-cases'),
});

export const MEETINGS_ROOT = '/Users/taylor/CodeMie Connect/Meetings';
const P = {
  me: { name: 'Taylor Morgan', address: 'taylor.morgan@example.test' },
  jordan: { name: 'Jordan Lee', address: 'jordan.lee@example.test' },
  priya: { name: 'Priya Natarajan', address: 'priya.n@example.test' },
  sam: { name: 'Sam Okafor', address: 'sam.okafor@example.test' },
  elena: { name: 'Elena Varga', address: 'elena.varga@example.test' },
  jeroen: { name: 'Jeroen de Vries', address: 'jeroen.devries@philips.test' },
  anouk: { name: 'Anouk Bakker', address: 'anouk.bakker@philips.test' },
  hannah: { name: 'Hannah Lee', address: 'hannah.lee@northwind.test' },
};
const isoOf = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** The fixture's meetings: id, title, start, minutes, organizer, attendees, record state (null:
 *  no record), and what else the record holds.
 *
 *  Meetings a day or more back (`anchor`) sit at a fixed, safe hour of that day rather than at
 *  whatever hour the suite happens to run: anchoring them to `top` (the current hour) used to
 *  wrap a meeting "a day ago" into the last hour of the day whenever the suite ran shortly after
 *  local midnight, rendering it at the very bottom of the calendar's time grid — exactly where
 *  the toast notifications sit — and blocking clicks on it until a toast cleared (six
 *  WORKSPACE_E2E_ONLY=meetings "calendar badge → event card" checks, one per theme/width). Only
 *  the same-day meetings below (`top - N hours`) still need to track the real current hour, so
 *  they stay in the recent past however the suite is invoked; those are unaffected. */
function meetingPlan(nowMs) {
  const hour = 3_600_000;
  const day = 24 * hour;
  const top = Math.floor(nowMs / hour) * hour;
  const anchor = Math.floor(nowMs / day) * day + 13 * hour;
  return [
    { id: 'mtg-philips', title: 'Philips CodeMie conversations syncup', start: anchor - 2 * day - 2 * hour, minutes: 60, organizer: P.jeroen, people: [P.anouk, P.me, P.priya, P.sam, P.jordan], state: 'ready' },
    { id: 'mtg-roadmap', title: 'Roadmap review', start: anchor - day - hour, minutes: 60, organizer: P.jordan, people: [P.priya, P.me], state: 'downloaded' },
    { id: 'mtg-release', title: 'Release 2.4 go/no-go', start: top - 2 * hour, minutes: 45, organizer: P.sam, people: [P.elena, P.me], state: 'available' },
    { id: 'mtg-vendor', title: 'Vendor onboarding', start: top - 3 * hour, minutes: 30, organizer: P.elena, people: [P.me, P.jordan], state: 'available', saveError: { code: 'provider', message: 'Teams didn’t answer in time.' } },
    { id: 'mtg-sprint', title: 'Sprint 25 planning', start: nowMs - 80 * 60_000, minutes: 60, organizer: P.priya, people: [P.me, P.jordan, P.sam, P.elena], state: 'pending' },
    { id: 'mtg-northwind', title: 'Northwind partnership call', start: top - 5 * hour, minutes: 60, organizer: P.hannah, people: [P.me, P.jordan], state: 'blocked' },
    { id: 'mtg-critique', title: 'Design critique: Tasks board', start: anchor - day - 4 * hour, minutes: 45, organizer: P.elena, people: [P.me, P.sam], state: 'failed' },
    { id: 'mtg-planning', title: 'Quarterly planning', start: anchor - 3 * day - hour, minutes: 60, organizer: P.jordan, people: [P.me, P.priya], state: 'none' },
    { id: 'mtg-lunch', title: 'Team lunch', start: anchor - day + hour, minutes: 60, organizer: P.me, people: [P.jordan, P.priya], state: null, inPerson: true },
  ];
}

/** Lines of the fixture transcripts (segments.json as `meeting_read {part:"transcript"}` answers):
 *  [seconds, person or voice, text]. Line 4 of the Philips sync is a guest Teams couldn't name. */
const LINES = {
  'mtg-philips': [
    [0, P.jeroen, 'Welcome to the sync. Today: the export, retention and the January pilot.'],
    [14, P.me, 'Thanks. The export demo is ready on staging.'],
    [38, P.anouk, 'For the audit we need every tool output by id. Is that doable?'],
    [60, P.me, 'Yes. I’ll add the by-id endpoint in sprint 24.'],
    [92, '@1', 'Can I join late next time? I am the legal contact.'],
    [130, P.jeroen, 'Legal wants ninety days of retention, except anything on legal hold.'],
    [175, P.priya, 'I’ll send Legal the written requirement by Friday.'],
    [210, P.jeroen, 'Then the pilot: forty users in January. Code me will host it.'],
    [262, P.sam, 'I’ll prepare the pilot user list.'],
    [300, P.me, 'Great, I’ll send the notes after the call.'],
  ],
  'mtg-roadmap': [
    [0, P.jordan, 'Let’s go through the roadmap for Q1.'],
    [20, P.priya, 'Sync first, then the Tasks board. <img src=x onerror="window.__xss=1"> stays text.'],
    [61, P.me, 'Agreed. I’ll write the plan down today.'],
    [95, P.jordan, 'Good. That’s all for today.'],
  ],
  'mtg-critique': [
    [0, P.elena, 'Let’s look at the board columns.'],
    [30, P.sam, 'Review should be the first column.'],
    [70, P.me, 'Agreed, and overdue cards go first.'],
  ],
};

function segmentsOf(id) {
  const lines = LINES[id] || [];
  return lines.map(([start, who, text], i) => {
    const person = typeof who === 'string' ? null : who;
    const next = lines[i + 1]?.[0] ?? start + 12;
    return {
      address: person?.address ?? null,
      end: next - 2,
      name: person ? person.name : `Speaker ${who.slice(1)}`,
      speaker: person === P.me ? 'me' : 'remote',
      start,
      text,
      voice: person ? person.name : who,
    };
  });
}

const NOTES_MD = `---
title: Philips CodeMie conversations syncup
date: {date}
tags: [meeting, philips, pilot]
participants: Jeroen de Vries, Anouk Bakker, Taylor Morgan, Priya Natarajan, Sam Okafor
summary: "Philips and EPAM agreed the export, the retention rule and a January pilot."
---
# Philips CodeMie conversations syncup

## TL;DR
- The **export** demo is ready on staging.
- Tool outputs become readable by id for the audit [00:01].
- Retention is ninety days, except legal hold [00:02].

## Decisions
- **Ninety days of retention** — Legal asked for it; legal hold stays.

## Action items
| Owner | Action | Due | Said at |
|---|---|---|---|
| Taylor Morgan | Add the by-id endpoint | — | [00:01] |
| Priya Natarajan | Send Legal the written requirement | Friday | [00:03] |
| Sam Okafor | Prepare the pilot user list | — | [00:04] |

## Open questions
- [ ] Who is the legal contact for the pilot?
`;

const SUMMARY_MD = `# Short summary

Philips and EPAM met about the export, retention and the pilot. \`pilot\` starts in January.

## Decisions
- Ninety days of retention, legal hold excluded.

> Sent to Jeroen after the call. <script>window.__xss=1</script> stays text.
`;

/** What `meeting_read` answers for each fixture meeting that has a folder: `segments`, `files`
 *  (`{name, size, modified}`), the text of each file, and each document's text by id (and
 *  `<id>@<version>` for an earlier version). */
export function meetingFolders(nowMs = Date.now()) {
  const plan = meetingPlan(nowMs);
  const out = {};
  for (const m of plan.filter(x => ['ready', 'downloaded', 'failed'].includes(x.state))) {
    const date = new Date(m.start).toISOString().slice(0, 10);
    const segments = segmentsOf(m.id);
    const docs = m.state === 'ready' ? { 'meeting-notes': NOTES_MD.replace('{date}', date), 'short-summary': SUMMARY_MD } : {};
    const texts = {
      'meeting.json': JSON.stringify({ event_id: m.id, subject: m.title, organizer: m.organizer, attendees: m.people }, null, 2),
      'meta.json': JSON.stringify({ source: 'teams', started_at: isoOf(m.start), ended_at: isoOf(m.start + m.minutes * 60_000) }, null, 2),
      'segments.json': JSON.stringify(segments, null, 2),
      'transcript.md': `# ${m.title}\n\n${segments.map(s => `**${s.name}** [00:${String(Math.floor(s.start / 60)).padStart(2, '0')}:${String(s.start % 60).padStart(2, '0')}]\n${s.text}`).join('\n\n')}\n`,
      'transcript.vtt': `WEBVTT\n\n${segments.map(s => `00:00:${String(s.start % 60).padStart(2, '0')}.000 --> 00:00:${String(s.end % 60).padStart(2, '0')}.000\n<v ${s.voice}>${s.text}</v>`).join('\n\n')}\n`,
      ...(m.state === 'ready' ? { 'notes.md': docs['meeting-notes'], 'notes.short-summary.md': docs['short-summary'], 'tasks.json': '[]' } : {}),
      ...(m.state !== 'downloaded' ? { 'run.log': m.state === 'failed' ? '[failed] Claude is not signed in.\n' : '[ok] Meeting notes → notes.md\n' } : {}),
    };
    const modified = Math.floor(nowMs / 1000) - 3600;
    out[m.id] = {
      folder: `${MEETINGS_ROOT}/${date}_${m.id}`,
      segments,
      files: Object.keys(texts).sort().map(name => ({ modified, name, size: new TextEncoder().encode(texts[name]).length })),
      texts,
      docs,
    };
  }
  return out;
}

/**
 * `snapshot` with the Meetings page's meetings, one per state: ready with two documents
 * (Philips, made by a rule), downloaded, available (saving) and available after a failed save,
 * pending, blocked, failed (Claude signed out), none, and an in-person lunch (offline, no record);
 * an upcoming Team demo set to make notes automatically; rules (stand-up → Short summary, Philips
 * → Meeting notes automatically); tasks from the Philips sync; the `meetings` and `transcripts`
 * capabilities; `settings.meetings` as native sends it.
 */
export function withMeetings(snapshot, nowMs = Date.now()) {
  const now = Math.floor(nowMs / 1000);
  const cid = snapshot.connection?.id || CID;
  const zone = snapshot.settings.timeZone || 'UTC';
  const { records, ready, rules } = meetingContract();
  if (snapshot.connection) {
    snapshot.connection.enabled = [...new Set([...snapshot.connection.enabled, 'meetings', 'transcripts'])];
    snapshot.connection.scopes = [...new Set([...snapshot.connection.scopes, 'OnlineMeetings.Read', 'OnlineMeetingTranscript.Read.All'])];
  }
  snapshot.settings.meetings = { ...rules.settings.meetings, defaultTemplate: 'meeting-notes' };
  const folders = meetingFolders(nowMs);
  const base = records.find(r => r.data.state === 'pending');
  const added = [];
  for (const m of meetingPlan(nowMs)) {
    const end = m.start + m.minutes * 60_000;
    const ev = {
      id: m.id, kind: 'event', source: 'calendar:cal-main', connectionId: cid, workspaceId: null, revision: `r-${m.id}`, updatedAt: now - 600,
      data: {
        title: m.title, start: isoOf(m.start), end: isoOf(end), allDay: false, cancelled: false, calendarId: 'cal-main',
        location: m.inPerson ? 'Canteen, 2nd floor' : 'Microsoft Teams Meeting', organizer: m.organizer,
        attendees: m.people.map(p => ({ ...p, type: 'required', response: 'accepted' })), url: 'https://outlook.office.com/calendar/item/fixture',
        joinUrl: m.inPerson ? null : `https://teams.microsoft.com/l/meetup-join/${m.id}`, isOnlineMeeting: !m.inPerson, preview: '', showAs: 'busy',
        response: m.organizer === P.me ? 'organizer' : 'accepted', isOrganizer: m.organizer === P.me, categories: [], importance: 'normal', private: false,
      },
    };
    added.push(ev);
    if (!m.state) continue;
    const contractRecord = m.state === 'ready' ? ready : records.find(r => r.data.state === m.state) || base;
    const found = ['available', 'downloaded', 'ready', 'failed'].includes(m.state);
    const data = {
      ...clonePlain(contractRecord.data), eventId: m.id, title: m.title, start: ev.data.start, end: ev.data.end, state: m.state,
      folder: folders[m.id]?.folder ?? null, external: found || m.state === 'pending' ? `ONLINE-${m.id}` : contractRecord.data.external,
      transcriptIds: found ? ['t-1'] : [], transcriptStart: found ? isoOf(m.start + 4 * 60_000) : null, checkedAt: now - 120,
      saveError: m.saveError ?? (m.state === 'available' ? null : contractRecord.data.saveError), notesError: contractRecord.data.notesError ?? null, pendingNotes: null, removedLines: [],
    };
    if (m.state === 'ready') data.docs = data.docs.map((d, i) => ({ ...d, createdAt: now - 2 * 86_400 + i * 3600, updatedAt: now - 2 * 86_400 + i * 3600, auto: i === 0 }));
    added.push({ ...contractRecord, id: m.id, connectionId: cid, workspaceId: null, source: 'calendar:cal-main', revision: `r-meeting-${m.id}`, updatedAt: now - 300, data });
  }
  // An upcoming Teams meeting set to make notes by itself.
  const demo = snapshot.records.find(r => r.id === 'ev-week-1');
  if (demo) added.push({ ...base, id: demo.id, connectionId: cid, source: demo.source, revision: 'r-meeting-ev-week-1', updatedAt: now - 300, data: { ...clonePlain(base.data), eventId: demo.id, title: demo.data.title, start: demo.data.start, end: demo.data.end, state: 'upcoming', auto: true, external: null } });
  const rule = (id, order, field, value, template, autoNotes) => ({ id, kind: 'meeting_rule', source: 'local', connectionId: null, workspaceId: 'personal', revision: `rev-${id}`, updatedAt: now - 86_400, data: { field, value, template, autoNotes, on: true, order } });
  added.push(rule('r-standup', 1, 'title', 'stand-up', 'short-summary', false), rule('r-philips', 2, 'org', 'philips', 'meeting-notes', true));
  // Tasks from the Philips sync: two to review (one with an owner Connect isn't sure of), one on the board.
  const [template] = taskContract().records;
  const said = (id, status, text, owner, line, extra = {}) => {
    const seg = folders['mtg-philips'].segments[line];
    return {
      ...template, id, revision: `l-${id}`, updatedAt: now - 3600,
      data: {
        text, owner: owner.address, ownerName: owner.name, due: null, notes: null, meetingId: 'mtg-philips', line, quoteAt: seg.start, quote: seg.text, speaker: seg.name,
        confidence: 'high', createdAt: now - 2 * 86_400, history: [{ at: now - 2 * 86_400, text: 'Found in the notes (Meeting notes)' }], order: 100 + line, status, done: false, doneAt: null, ...extra,
      },
    };
  };
  added.push(
    said('task-endpoint', 'review', 'Add the by-id endpoint for tool outputs', P.me, 3),
    said('task-legal-req', 'todo', 'Send Legal the written retention requirement', P.priya, 6, { due: dayIn(nowMs, zone, 3) }),
    said('task-pilot-list', 'review', 'Prepare the pilot user list', P.sam, 8, { confidence: 'low' }),
  );
  snapshot.records.push(...added);
  return snapshot;
}

const clonePlain = value => JSON.parse(JSON.stringify(value));

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
