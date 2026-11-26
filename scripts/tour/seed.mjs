// Builds the tour's seed (design docs/superpowers/specs/2026-11-24-real-app-tour-design.md § 4)
// from the browser run's own fixture builders and contract JSON, so every implemented screen of
// rollout steps 0-9 shows real, invented content — the same people and records the browser run
// itself uses. `commands::tour::seed::import` (Task 3, src-tauri/src/commands/tour/seed.rs) reads
// what this writes (`tour-seed.json`) into a fresh `workspace.sqlite` before `Core::open_tour`
// opens it.
//
// Usage: node scripts/tour/seed.mjs <testDir>
//   Refuses (exit 1) if <testDir> exists and already holds anything; creates it otherwise.
import { cpSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildSnapshot, withTasks, withMeetings, meetingFolders, withAutomations, MEETINGS_ROOT,
} from '../../ui/test/fixtures/workspace-fixture.mjs';
import { allTodoist, marekCheckIn, demoHandled } from '../../ui/test/browser/tasks-provider-checks.mjs';

/** A contract fixture Rust wrote (`ui/test/fixtures/contract/<name>.json`): the same files
 *  `workspace-fixture.mjs`'s own `contract` helper reads from, read again here since that helper
 *  isn't exported. */
function contract(name) {
  const url = new URL(`../../ui/test/fixtures/contract/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8'));
}

/** The invented skills folder the Rust import tests scan (`src-tauri/tests/fixtures/voice-skills`):
 *  the CLI copies it into the test folder, since no seeded path may point outside it. */
const SKILLS_FIXTURE = fileURLToPath(new URL('../../src-tauri/tests/fixtures/voice-skills/', import.meta.url));

/** Copies the skills folder `from` to `to`, skipping every symlink, so nothing outside the
 *  folder comes into the test folder. */
export function copySkills(from, to) {
  cpSync(from, to, { recursive: true, filter: src => !lstatSync(src).isSymbolicLink() });
}

/** The texts Connect's copy holds for each person of voice-states.json's ready copy (the
 *  snapshot carries only their lengths): what Profile shows. Invented. */
const PROFILES = {
  'priya-n': { names: ['Priya', 'Priya Nair'], ids: [], text: 'Product lead at the bank; prefers mornings.', about: 'Product lead, platform team.' },
  'jordan-lee': { names: [], ids: [], text: 'Engineering manager.', about: '' },
  'marek-novak': { names: [], ids: ['00000000-0000-4000-8000-00000000a003'], text: 'Finance contact.', about: '' },
};

/** voice-states.json's ready copy as the provider's `export` answers it (`{style, rules,
 *  people}`), each person with their profile and about texts. */
function voiceCopy() {
  const ready = contract('voice-states').ready;
  return {
    style: ready.style,
    rules: ready.rules,
    people: ready.people.map(p => ({
      id: p.id, name: p.name, addresses: p.addresses, ...PROFILES[p.id], updatedAt: '2026-11-24T09:00:00Z', source: p.source,
    })),
  };
}

/** A plugin folder as a seeded install: its files, and its permission sheet agreed to (each
 *  `uses` key, and `provides_<role>` for each role it provides). */
function seededPlugin(dir) {
  const files = Object.fromEntries(readdirSync(dir).sort().map(name => [name, readFileSync(new URL(name, dir), 'utf8')]));
  const manifest = JSON.parse(files['echo-plugin.json']);
  const agreed = [...Object.keys(manifest.uses || {}), ...(manifest.provides || []).map(role => `provides_${role}`)].sort();
  return { id: manifest.id, version: manifest.version, files, agreed };
}

/** The seeded plugins:
 *  - the browser run's synthetic `hello` (`ui/test/fixtures/plugins/hello`): its page draws in
 *    its sandboxed frame, so a capture proves frames are composited (Ruling 5);
 *  - the tour's offline Todoist stand-in (`scripts/tour/plugins/todoist`): Todoist is installed,
 *    as it is whenever a user has it active, so the real boot keeps it and Settings shows the
 *    real Todoist card; it holds no token;
 *  - `digest` (`scripts/tour/plugins/digest`), which agreed to Claude: Settings › AI's plugin row;
 *  - the tour's offline Knowledge stand-in (`scripts/tour/plugins/knowledge`): the reply-context
 *    provider Settings › Your voice chooses; it registers nothing (the seed's `voice` is the
 *    quiet Core's provider). */
function seededPlugins() {
  return [
    new URL('../../ui/test/fixtures/plugins/hello/', import.meta.url),
    new URL('./plugins/todoist/', import.meta.url),
    new URL('./plugins/digest/', import.meta.url),
    new URL('./plugins/knowledge/', import.meta.url),
  ].map(seededPlugin);
}

/**
 * The ids the tour script (Task 5, `ui/workspace/tour/script.js`) routes to and checks for.
 * `triageRun` and `fallbackRun` name the same record: Inbox triage's own run both makes the two
 * Todoist tasks the Automations runs stop checks for and, seeded here with a `fallbackFrom`,
 * carries the fallback line that stop also checks for — unfolding it once shows both.
 */
export const SEED_IDS = {
  teams1to1: 'c-reply-1',
  groupChat: 'c-reply-2',
  priyaMail: 'm-reply-1',
  voiceMail: 'm-reply-2',
  critical: 'm-critical',
  readyMeeting: 'mtg-philips',
  checkWithTask: 'task-marek',
  triageRun: 'run-triage',
  fallbackRun: 'run-triage',
  askDone: 'ask-7f2c',
  askFailed: 'ask-3a9e',
  askQueued: 'ask-51bd',
};

/** Priya as the ask-capture design names her, and the fixture's full name the seed replaces. */
const PRIYA = 'Priya N.';
const PRIYA_FULL = 'Priya Natarajan';

/** A day as native's Ask labels write it, in the seed's zone (UTC): "Wed 25 Nov". */
function askDay(value) {
  const d = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(d).replace(',', '');
}

/** The next Friday after `nowMs`'s day (a week on when it is a Friday), as quick capture reads
 *  "by fri": `YYYY-MM-DD` in UTC. */
function seedFriday(nowMs) {
  const d = new Date(nowMs);
  const ahead = ((5 - d.getUTCDay() + 7) % 7) || 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + ahead)).toISOString().slice(0, 10);
}

/** One turn in ask-thread.json's shape, with nothing filled in. */
const askTurn = (id, at, question, state, extra = {}) => ({
  id, at, question, about: null, state, answer: null, cites: [], actions: [], searched: null, cut: false, took: null,
  profile: 'claude', model: null, fellBackFrom: null, fallbackReason: null, error: null, jobId: null, ...extra,
});

/**
 * Ask (step 9, ask-capture design § 13), written in ask-thread.json's shape: a done thread of two
 * turns whose cites point at Priya's mail, a meeting and a Todoist task, with three actions; a
 * thread whose turns failed and stopped; and a thread whose only turn is queued, with its queued
 * `ask` job, which the tour's stopped background loop never claims. Each finished turn names a
 * job id no longer kept, as an old thread's do.
 */
function askSeed(records, nowMs) {
  const now = Math.floor(nowMs / 1000);
  const find = (kind, id) => records.find(r => r.kind === kind && r.id === id);
  const mail = find('message', SEED_IDS.priyaMail);
  const task = find('commitment', 'commit-1');
  const meeting = find('meeting', 'mtg-roadmap');
  const mailLabel = `${mail.data.from} · mail · ${askDay(mail.data.at)}`;
  const cites = [
    { id: 'a1', kind: 'message', recordId: mail.id, label: mailLabel, title: null },
    { id: 't2', kind: 'task', recordId: task.id, label: `Task · ${task.data.text}`, title: null },
    { id: 'n3', kind: 'meeting', recordId: meeting.id, label: `Meeting · ${meeting.data.title} · ${askDay(meeting.data.start)}`, title: null },
  ];
  const doneAt = now - 3600;
  const done = {
    id: SEED_IDS.askDone, createdAt: doneAt, updatedAt: doneAt + 60, nextRef: 4,
    turns: [
      askTurn('turn-1', doneAt, 'What did I promise Priya this week?', 'done', {
        about: { kind: 'message', recordId: mail.id, label: mailLabel },
        answer: 'You told Priya you would send the **Atlas budget** by Friday [a1].\n\n- The roadmap comments for her are in Todoist [t2].\n- You agreed both in the roadmap review [n3].',
        cites,
        actions: [
          { kind: 'task', text: 'Send Priya the Atlas budget', due: seedFriday(nowMs) },
          { kind: 'open', ref: 'n3', recordId: meeting.id, label: cites[2].label },
          { kind: 'draft', ref: 'a1', recordId: mail.id, label: mailLabel, hint: 'Say the budget comes Friday.' },
        ],
        searched: 'tasks 12 (Todoist) · events 7 · messages 9 · meetings 2',
        took: 14, model: 'claude-sonnet-4-5', jobId: 'job-tour-ask-1',
      }),
      askTurn('turn-2', doneAt + 60, 'Is anything else due on Friday?', 'done', {
        answer: 'Nothing else in Connect is due on Friday.',
        searched: 'tasks 12 (Todoist) · messages 9',
        took: 6, model: 'claude-sonnet-4-5', jobId: 'job-tour-ask-2',
      }),
    ],
  };
  const failedAt = now - 7200;
  const failedStopped = {
    id: SEED_IDS.askFailed, createdAt: failedAt, updatedAt: failedAt + 60, nextRef: 1,
    turns: [
      askTurn('turn-1', failedAt, 'When is the QBR?', 'failed', { error: { code: 'needs_login', message: "Claude Code isn't signed in." }, jobId: 'job-tour-ask-3' }),
      askTurn('turn-2', failedAt + 60, 'When is the QBR?', 'stopped', { jobId: 'job-tour-ask-4' }),
    ],
  };
  const queuedAt = now - 60;
  const job = {
    id: 'job-tour-ask-5', workspaceId: 'personal', connectionId: null, kind: 'ask', key: `ask:${SEED_IDS.askQueued}`, state: 'queued',
    dueAt: queuedAt, leaseUntil: null, attempts: 0,
    policy: { generation: null, policyRevision: null, sourceRevision: null, workspaceRevision: 1 },
    payload: { threadId: SEED_IDS.askQueued, turnId: 'turn-1', purpose: 'ask', profile: 'claude', model: null, runModel: null, startedAt: queuedAt, hiddenCalendars: [] },
    result: null,
  };
  const queued = {
    id: SEED_IDS.askQueued, createdAt: queuedAt, updatedAt: queuedAt, nextRef: 1,
    turns: [askTurn('turn-1', queuedAt, 'Who is Marek Novak?', 'queued', { profile: null, jobId: job.id })],
  };
  return { threads: [done, failedStopped, queued], jobs: [job] };
}

/**
 * Builds the tour's seed for a run starting at `nowMs`, with every meeting folder moved from the
 * fixture's own `/Users/taylor/...` onto `<testDir>/Meetings` (design § 4). Pure: touches no
 * file; the caller (the CLI below) writes `seed` and `folders` to disk.
 */
export function buildSeed(testDir, nowMs) {
  const now = Math.floor(nowMs / 1000);
  const s = buildSnapshot(nowMs, { connected: true, zone: 'UTC', theme: 'light', photo: true });
  withTasks(s, nowMs);
  withMeetings(s, nowMs);
  withAutomations(s, nowMs, { habits: true });
  // Tasks: Todoist active, a waiting "Check with Marek" task, a looks-handled reply task.
  // `allTodoist` (run inside both of the above) tags every commitment Todoist's; move a subset
  // back to Local (`provider: null`) so the Board, List and By-date "Local" views still have
  // cards too — the same ids `tasks-provider-checks.mjs`'s own `mixedProviders()` keeps Local,
  // spanning more than one Board column/status (review, todo, done, dismissed).
  marekCheckIn(s);
  demoHandled(s);
  const LOCAL_IDS = ['task-tenant', 'task-names', 'task-pilot', 'task-room', 'task-dashboard', 'task-share', 'task-bug'];
  for (const r of s.records) {
    if (r.kind === 'commitment' && LOCAL_IDS.includes(r.id)) r.data.provider = null;
  }

  // Tasks: one more pending row (on a task that stays Todoist's — "pending" is a provider-sync
  // concept), and the one real parked sentence (task-sync-cases.json), both spec § 4 "Tasks".
  const pendingTask = s.records.find(r => r.id === 'task-legal-req');
  if (pendingTask) pendingTask.data.pending = true;
  // Tasks: one Todoist task due in 20 days, so By date's "Later than that" fold has a row too
  // (the tour's Tasks stop checks all three folds).
  const laterTask = s.records.find(r => r.id === 'commit-2');
  if (laterTask) laterTask.data.due = new Date(nowMs + 20 * 86_400_000).toISOString().slice(0, 10);
  const parked = contract('task-sync-cases').parked;
  const parkedIds = new Set(parked.map(r => r.id));
  s.records = s.records.filter(r => !parkedIds.has(r.id));
  s.records.push(...parked.map(r => ({ ...r, workspaceId: 'personal' })));

  // Automations: a Commitments automation whose only run failed (the menu bar's amber, design
  // § 4 "Menu bar"), and Inbox triage's own run seeded with a fallback (spec § 4 "Automations").
  const scheduleTpl = contract('automation').schedule;
  const cid = s.connection.id;
  const commitmentsAutomation = {
    ...scheduleTpl, id: 'auto-commitments', updatedAt: now - 86_400,
    data: {
      ...scheduleTpl.data, id: 'auto-commitments', name: 'Commitments', template: 'commitments',
      ai: { profile: null, model: null }, capUsd: null,
      trigger: { kind: 'schedule', days: [1, 2, 3, 4, 5], time: '09:00' },
      read: { ...scheduleTpl.data.read, calendarToday: false, needsReply: false, commitmentsNotes: true },
      prompt: 'Check in on open commitments and flag what is overdue.',
      deliver: { ...scheduleTpl.data.deliver, today: true, notify: false, createTasks: false },
    },
  };
  const failedTpl = contract('automation-run-failed');
  const commitmentsRun = {
    ...failedTpl, id: 'run-commitments', updatedAt: now - 1800 + 5,
    data: {
      ...failedTpl.data, automationId: 'auto-commitments', automationName: 'Commitments', connectionId: cid,
      startedAt: now - 1800, trigger: { kind: 'schedule', scheduledAt: now - 1800 },
    },
  };
  s.records.push(commitmentsAutomation, commitmentsRun);
  const triageRun = s.records.find(r => r.id === SEED_IDS.triageRun);
  if (triageRun) {
    triageRun.data.fallbackFrom = 'codemie:local-ollama';
    triageRun.data.fallbackReason = 'failed';
  }

  // Inbox: native files a message under Critical only through a critical rule (keyword and
  // sender, workspace/inbox.rs), where the browser run's fixture sets the lane directly; this is
  // the rule that makes the seeded production alert the one unacknowledged critical message.
  const critical = s.records.find(r => r.id === SEED_IDS.critical);
  if (critical) {
    s.records.push({
      id: 'rule-production-alert', kind: 'rule', connectionId: null, workspaceId: 'personal', source: 'local',
      revision: 'l-rule-production-alert', updatedAt: now - 86_400,
      data: { text: 'Critical: Production alert', keyword: 'Production alert', sender: critical.data.fromAddress, lane: 'critical', enabled: true },
    });
  }

  // Microsoft: Send buttons show (spec § 4 "Microsoft").
  s.connection.enabled = [...new Set([...s.connection.enabled, 'mail_send', 'chat_send'])];
  s.connection.scopes = [...new Set([...s.connection.scopes, 'Mail.Send', 'ChatMessage.Send'])];

  // Settings › Meetings: pinned summaries, and the meetings root moved onto the test folder so
  // every meeting folder below confines to it (spec § 4).
  const meetingsRoot = path.join(testDir, 'Meetings');
  s.settings.meetings.root = meetingsRoot;
  s.settings.meetings.summaryTabs = ['formal-summary', 'short-summary'];

  // Tasks: Todoist active (spec § 4 "Tasks"). The copy of Connect's open tasks has not been
  // offered yet, so the tour can show "Copy your open tasks to Todoist?" when Todoist is chosen
  // again from Connect (its "Not now" then records the offer, as the user's answer would).
  s.settings.tasks = { provider: 'plugin:todoist', copyOffered: [] };

  // Reply voice (step 8): Knowledge chosen with facts on; its copy and skills folder are the
  // seed's `voice` below.
  s.settings.voice = { provider: 'plugin:knowledge', facts: true };

  // Reply voice: Elena's mail holds an AI draft in your voice (draft-ai-voice.json's
  // provenance), and Inbox triage left a draft from Connect's copy with no facts in the group
  // chat (draft-ai-chat.json's record). The Jordan 1:1 and the Priya mail keep their boxes for
  // the reply stops and Nudge (T05, T55).
  const elena = s.records.find(r => r.id === SEED_IDS.voiceMail);
  const voiceTpl = contract('draft-ai-voice');
  s.records.push({
    ...voiceTpl, id: `ai:${elena.id}`, connectionId: s.connection.id, workspaceId: 'personal', source: elena.source,
    revision: `l-ai-${elena.id}`, updatedAt: now - 600,
    data: {
      ...voiceTpl.data, channel: 'mail', sourceId: elena.id, sourceRevision: elena.revision, draftKey: elena.id, conversationKey: elena.id,
      text: 'Hi Elena,\n\n[The large room, please / 4.12 is enough] for the workshop.\n\nThanks,\nTaylor',
      questions: ['Which room does the workshop need?'],
      provenance: { ...voiceTpl.data.provenance, at: now - 600, messageIds: [elena.id] },
    },
  });
  const group = s.records.find(r => r.id === SEED_IDS.groupChat);
  const groupKey = `chat:${group.data.conversationId}`;
  const chatTpl = contract('draft-ai-chat');
  s.records.push({
    ...chatTpl, id: `ai:${groupKey}`, connectionId: s.connection.id, workspaceId: 'personal', source: group.source,
    revision: `l-ai-${group.id}`, updatedAt: now - 1800,
    data: {
      ...chatTpl.data, channel: 'chat', sourceId: group.id, sourceRevision: group.revision, draftKey: groupKey, conversationKey: groupKey,
      options: { ...chatTpl.data.options, intent: 'reply', includeFreeTimes: false },
      text: 'Approved. [I went through the rollback steps / I still need to check the rollback steps].',
      questions: [],
      provenance: {
        ...chatTpl.data.provenance, at: now - 1800, messageIds: [group.id], automationId: 'auto-triage',
        voice: { provider: 'Knowledge', style: true, person: null, rules: 1, examples: 0, cut: false, from: 'copy', at: now - 3600, facts: [], factsMissed: true },
      },
    },
  });

  // Ask (step 9): the field in the menu, Ask's route on Claude Code (set with `ai` below), and
  // Priya's mail from "Priya N." about the Atlas budget, as the ask-capture design's mock-ups
  // and the seeded threads name it (`ask` below).
  s.settings.askInMenu = true;
  const priya = s.records.find(r => r.id === SEED_IDS.priyaMail);
  priya.data.title = 'Atlas budget';
  // T55's Nudge Marek fills the reply box of the task's source message: Jordan's Monday sync
  // notes (an FYI), so Priya's mail keeps its own box empty for step 9's Inbox stops.
  s.records.find(r => r.kind === 'commitment' && r.id === SEED_IDS.checkWithTask).data.sourceId = 'm-fyi-1';

  // Menu bar: every source counted (spec § 4 "Menu bar").
  s.settings.menuBar = { replies: true, tasks: true, meetings: true, automations: true };

  // AI: default Claude Code; Inbox triage on local-ollama with fallback Claude Code (Using
  // fallback); Commitments on local-ollama with no fallback anywhere (Not working) (spec § 4
  // "AI"). A route's `fallback: null` means "same as its group", so the Default row has no
  // fallback either: that is the only saveable way to a row with none (a fallback equal to the
  // profile is refused, ai.rs).
  s.settings.ai = {
    defaultProfile: 'claude', defaultModel: null, defaultFallback: null,
    routes: {
      triage: { profile: 'codemie:local-ollama', model: null, fallback: 'claude' },
      commitments: { profile: 'codemie:local-ollama', model: null, fallback: null },
      ask: { profile: 'claude', model: null, fallback: null },
    },
    plugins: {},
  };

  // One name for Priya across the seed (records here, the meeting files below): "Priya N.".
  s.records = JSON.parse(JSON.stringify(s.records).replaceAll(PRIYA_FULL, PRIYA));

  // Every meeting folder path moved from the fixture's own MEETINGS_ROOT onto the test folder:
  // the records that name one, and the files to write there.
  for (const r of s.records) {
    if (r.kind === 'meeting' && typeof r.data.folder === 'string' && r.data.folder.startsWith(MEETINGS_ROOT)) {
      r.data.folder = meetingsRoot + r.data.folder.slice(MEETINGS_ROOT.length);
    }
  }
  const folders = Object.values(meetingFolders(nowMs)).map(f => ({
    path: meetingsRoot + f.folder.slice(MEETINGS_ROOT.length),
    files: Object.fromEntries(Object.entries(f.texts).map(([name, text]) => [name, text.replaceAll(PRIYA_FULL, PRIYA)])),
  }));

  const seed = {
    settings: s.settings,
    connections: s.connection ? [s.connection] : [],
    workspaces: s.workspaces,
    records: s.records.filter(r => r.kind !== 'menu_bar_seen'),
    seen: { since: now - 86_400, automations: 0, meetings: {} },
    provider: {
      available: [{ id: 'plugin:todoist', name: 'Todoist', on: true, ready: true }],
      remote: s.records
        .filter(r => r.kind === 'commitment' && r.data.provider === 'plugin:todoist')
        .map(r => ({
          id: r.id, text: r.data.text, notes: r.data.notes ?? null, due: r.data.due ?? null,
          done: r.data.status === 'done', kind: 'task', owner: null, labels: [],
        })),
    },
    plugins: seededPlugins(),
    voice: {
      available: [{ id: 'plugin:knowledge', name: 'Knowledge', on: true, ready: true, facts: true }],
      copy: voiceCopy(),
      skillsFolder: path.join(testDir, 'voice-skills'),
    },
    ask: askSeed(s.records, nowMs),
  };

  return { seed, folders };
}

// ---------------------------------------------------------------- CLI

function main() {
  const given = process.argv[2];
  if (!given) {
    console.error('Usage: node scripts/tour/seed.mjs <testDir>');
    process.exit(1);
  }
  const testDir = path.resolve(given);
  mkdirSync(testDir, { recursive: true });
  if (readdirSync(testDir).length > 0) {
    console.error(`${testDir} is not empty; refusing to seed a reused folder.`);
    process.exit(1);
  }
  const { seed, folders } = buildSeed(testDir, Date.now());
  for (const folder of folders) {
    mkdirSync(folder.path, { recursive: true });
    for (const [name, text] of Object.entries(folder.files)) {
      writeFileSync(path.join(folder.path, name), text, 'utf8');
    }
  }
  copySkills(SKILLS_FIXTURE, seed.voice.skillsFolder);
  writeFileSync(path.join(testDir, 'tour-seed.json'), JSON.stringify(seed), 'utf8');
  const fileCount = folders.reduce((n, f) => n + Object.keys(f.files).length, 0);
  console.log(`Wrote ${seed.records.length} records, ${seed.connections.length} connection(s), ${folders.length} meeting folder(s) (${fileCount} files) to ${testDir}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
