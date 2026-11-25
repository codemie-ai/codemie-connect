// Builds the tour's seed (design docs/superpowers/specs/2026-11-24-real-app-tour-design.md § 4)
// from the browser run's own fixture builders and contract JSON, so every implemented screen of
// rollout steps 0-7 shows real, invented content — the same people and records the browser run
// itself uses. `commands::tour::seed::import` (Task 3, src-tauri/src/commands/tour/seed.rs) reads
// what this writes (`tour-seed.json`) into a fresh `workspace.sqlite` before `Core::open_tour`
// opens it.
//
// Usage: node scripts/tour/seed.mjs <testDir>
//   Refuses (exit 1) if <testDir> exists and already holds anything; creates it otherwise.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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

/** The synthetic `hello` plugin of the browser run (`ui/test/fixtures/plugins/hello`), as a seeded
 *  install: its files, and its permission sheet's `uses` keys agreed to. */
function helloPlugin() {
  const dir = new URL('../../ui/test/fixtures/plugins/hello/', import.meta.url);
  const files = Object.fromEntries(readdirSync(dir).sort().map(name => [name, readFileSync(new URL(name, dir), 'utf8')]));
  const manifest = JSON.parse(files['echo-plugin.json']);
  return { id: manifest.id, version: manifest.version, files, agreed: Object.keys(manifest.uses || {}).sort() };
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
  critical: 'm-critical',
  readyMeeting: 'mtg-philips',
  checkWithTask: 'task-marek',
  triageRun: 'run-triage',
  fallbackRun: 'run-triage',
};

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

  // Tasks: Todoist active (spec § 4 "Tasks").
  s.settings.tasks = { provider: 'plugin:todoist', copyOffered: ['plugin:todoist'] };

  // Menu bar: every source counted (spec § 4 "Menu bar").
  s.settings.menuBar = { replies: true, tasks: true, meetings: true, automations: true };

  // AI: default Claude Code with fallback CodeMie · prod; Inbox triage on local-ollama with
  // fallback Claude Code (Using fallback); Commitments on local-ollama with no fallback (Not
  // working) (spec § 4 "AI").
  s.settings.ai = {
    defaultProfile: 'claude', defaultModel: null, defaultFallback: 'codemie:prod',
    routes: {
      triage: { profile: 'codemie:local-ollama', model: null, fallback: 'claude' },
      commitments: { profile: 'codemie:local-ollama', model: null, fallback: 'codemie:local-ollama' },
    },
    plugins: {},
  };

  // Every meeting folder path moved from the fixture's own MEETINGS_ROOT onto the test folder:
  // the records that name one, and the files to write there.
  for (const r of s.records) {
    if (r.kind === 'meeting' && typeof r.data.folder === 'string' && r.data.folder.startsWith(MEETINGS_ROOT)) {
      r.data.folder = meetingsRoot + r.data.folder.slice(MEETINGS_ROOT.length);
    }
  }
  const folders = Object.values(meetingFolders(nowMs)).map(f => ({
    path: meetingsRoot + f.folder.slice(MEETINGS_ROOT.length),
    files: f.texts,
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
    // The browser run's synthetic `hello` plugin, installed and on, so a stop shows a plugin's
    // page in its sandboxed frame and the capture proves frames are composited (Ruling 5).
    plugins: [helloPlugin()],
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
  writeFileSync(path.join(testDir, 'tour-seed.json'), JSON.stringify(seed), 'utf8');
  const fileCount = folders.reduce((n, f) => n + Object.keys(f.files).length, 0);
  console.log(`Wrote ${seed.records.length} records, ${seed.connections.length} connection(s), ${folders.length} meeting folder(s) (${fileCount} files) to ${testDir}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
