// Settings › Tasks (task-provider design §11, rulings 1, 2, 12, 13, 16): the "Where your tasks
// live" radio group, the chosen plugin's settings (never a prefilled token), the copy dialog, and
// the controller actions that save them. `whereTasksLive`/`providerSettings`/`copyDialog` are
// pure; the controller tests drive `createTasksController` as `tasks-controller.test.mjs` does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { copyDialog, providerSettings, whereTasksLive } from '../workspace/settings-tasks.js';
import { createTasksController } from '../workspace/tasks-controller.js';
import { newTasksView } from '../workspace/tasks-model.js';
import { buildSnapshot } from './fixtures/workspace-fixture.mjs';

const NOW = Date.UTC(2026, 10, 23, 9);
const STATES = JSON.parse(readFileSync(new URL('./fixtures/contract/task-provider-states.json', import.meta.url), 'utf8'));

// ---------------------------------------------------------------- whereTasksLive

test('Where your tasks live lists Connect and each task plugin as a radio group with state lines', () => {
  const html = whereTasksLive({
    active: 'plugin:todoist',
    available: [{ id: 'local', name: 'Connect' }, { id: 'plugin:todoist', name: 'Todoist', on: true, ready: true }],
    tp: STATES.ready, now: NOW, zone: 'UTC', busy: {},
  });
  assert.match(html, /<h2 class="ws-card-title">[^]*?Where your tasks live<\/h2>/);
  assert.match(html, /role="radiogroup" aria-label="Where your tasks live"/);
  assert.match(html, /<input type="radio" name="tasks-provider" value="local"[^>]*data-action="tasks-provider-choose" data-provider="local"[^>]*aria-describedby="ws-tp-state-local"/);
  assert.match(html, /<input type="radio"[^>]*value="plugin:todoist"[^>]*checked[^>]*aria-describedby="ws-tp-state-plugin_todoist"/);
  assert.match(html, /id="ws-tp-state-local">Kept on this Mac/);
  assert.match(html, /id="ws-tp-state-plugin_todoist">Synced/);
  assert.match(html, />Connect: kept on this Mac</);
  assert.match(html, />Todoist</);

  // Off: the radio is disabled and a "Turn on" sits beside it instead of a checked state.
  const offParams = {
    active: 'local',
    available: [{ id: 'local', name: 'Connect' }, { id: 'plugin:todoist', name: 'Todoist', on: false, ready: false }],
    tp: null, now: NOW, zone: 'UTC', busy: {},
  };
  const off = whereTasksLive(offParams);
  assert.match(off, /value="plugin:todoist"[^>]*disabled[^>]*aria-describedby/);
  assert.match(off, /id="ws-tp-state-plugin_todoist">Turned off in Settings › Plugins</);
  assert.match(off, /data-action="tasks-provider-turn-on" data-provider="plugin:todoist"[^>]*>(?:(?!<\/button>).)*Turn on/s);

  // Busy: the button says so and is disabled.
  const busy = whereTasksLive({ ...offParams, busy: { 'plugin:todoist': true } });
  assert.match(busy, /data-action="tasks-provider-turn-on" disabled data-provider="plugin:todoist"[^>]*>(?:(?!<\/button>).)*Turning on…/s);
});

test('an installed, on, not-active plugin reads "Installed and on."; a didn’t-load one says so', () => {
  const html = whereTasksLive({
    active: 'local',
    available: [{ id: 'local', name: 'Connect' }, { id: 'plugin:todoist', name: 'Todoist', on: true, ready: true }],
    tp: null, now: NOW, zone: 'UTC', busy: {},
  });
  assert.match(html, /id="ws-tp-state-plugin_todoist">Installed and on\./);
  const failed = whereTasksLive({
    active: 'plugin:todoist',
    available: [{ id: 'local', name: 'Connect' }, { id: 'plugin:todoist', name: 'Todoist', on: true, ready: false }],
    tp: STATES.failed, now: NOW, zone: 'UTC', busy: {},
  });
  assert.match(failed, /id="ws-tp-state-plugin_todoist">The Todoist plugin didn’t load\./);
});

// ---------------------------------------------------------------- the token field (ruling 2)

const todoistSettings = (over = {}) => [
  { key: 'token', label: 'API token', type: 'secret', help: 'Todoist › Settings › Integrations › Developer', set: false, ...over },
  { key: 'project', label: 'Project', type: 'string', value: 'Connect', help: null },
  { key: 'label', label: 'App label', type: 'string', value: 'connect', help: null },
];
const provider = (over = {}) => ({
  providerId: 'plugin:todoist', pluginId: 'todoist', name: 'Todoist', settings: todoistSettings(),
  tp: STATES.ready, now: NOW, zone: 'UTC', check: null, copyOffered: false, ...over,
});

test('the token field is a password field, never prefilled, and says "Saved on this Mac. Connect never shows it again." once set', () => {
  const unset = providerSettings(provider());
  assert.match(unset, /<input class="ws-input" type="password" name="token"[^>]*autocomplete="off"/);
  assert.doesNotMatch(unset, /type="password"[^>]*value=/, 'never prefilled');
  assert.doesNotMatch(unset, /Saved on this Mac/);
  assert.match(unset, /data-action="tasks-provider-secret-save"[^>]*data-key="token"[^>]*>(?:(?!<\/button>).)*Save/s);
  assert.doesNotMatch(unset, /tasks-provider-secret-remove/);

  const set = providerSettings(provider({ settings: todoistSettings({ set: true }) }));
  assert.match(set, /type="password" name="token"/);
  assert.doesNotMatch(set, /type="password"[^>]*value=/);
  assert.match(set, /Saved on this Mac\. Connect never shows it again\./);
  assert.match(set, /data-action="tasks-provider-secret-save"[^>]*data-key="token"[^>]*>(?:(?!<\/button>).)*Replace/s);
  assert.match(set, /data-action="tasks-provider-secret-remove"[^>]*data-key="token"/);
  assert.match(set, /Get your token in Todoist ↗/);
  assert.match(set, /data-action="tasks-provider-token-link" data-url="https:\/\/app\.todoist\.com\/app\/settings\/integrations\/developer"/);

  // Project and App label are plain text fields, not write-only.
  assert.match(set, /data-change="tasks-provider-setting" data-key="project"[^>]*value="Connect"/);
  assert.match(set, /data-change="tasks-provider-setting" data-key="label"[^>]*value="connect"/);

  // Nothing is drawn under Local.
  assert.equal(providerSettings({ providerId: 'local' }), '');
  assert.equal(providerSettings(null), '');
});

test('Check and Sync now, and the quiet copy link only once the copy was offered', () => {
  const html = providerSettings(provider({ check: { ok: true, account: 'Taylor Morgan', project: 'Connect' } }));
  assert.match(html, /data-action="tasks-provider-check"[^>]*>(?:(?!<\/button>).)*Check/s);
  assert.match(html, /Connected to Todoist as Taylor Morgan, project “Connect”\./);
  assert.match(html, /data-action="tasks-provider-sync"[^>]*>(?:(?!<\/button>).)*Sync now/s);
  assert.doesNotMatch(html, /Copy open tasks from Connect…/);

  const failed = providerSettings(provider({ check: { ok: false, message: 'Todoist needs your API token.' } }));
  assert.match(failed, /Todoist needs your API token\./);

  const offered = providerSettings(provider({ copyOffered: true }));
  assert.match(offered, /data-action="tasks-provider-copy"[^>]*>(?:(?!<\/button>).)*Copy open tasks from Connect…/s);
});

// ---------------------------------------------------------------- the copy dialog (ruling 16)

test('the copy dialog shows once, with the counts and the project, and offers the quiet link afterwards', () => {
  const body = copyDialog({ count: 3, project: 'Connect' });
  assert.match(body, /Connect has 3 open tasks\. Copies go to the project “Connect”\. Your tasks in Connect stay as they are\./);
  assert.match(copyDialog({ count: 1, project: 'Work' }), /Connect has 1 open task\. Copies go to the project “Work”\./);

  // The controller: the first choice of a provider while Local has open tasks opens the dialog;
  // a provider already offered (or Local itself) switches at once, no dialog.
  const s = { ...buildSnapshot(NOW, { photo: false, zone: 'UTC' }), settings: { timeZone: 'UTC', meetings: {}, tasks: { provider: 'local', copyOffered: [] } },
    taskProvider: { active: 'local', name: 'Connect', available: [{ id: 'local', name: 'Connect' }, { id: 'plugin:todoist', name: 'Todoist', on: true, ready: true }] },
    records: [{ id: 't1', kind: 'commitment', updatedAt: 0, data: { text: 'Send the deck', status: 'todo' } }] };
  const calls = { mutate: [], modals: [] };
  const ctl = createTasksController({
    state: { tasks: newTasksView() },
    snap: () => s,
    mutate: async (op, data) => { calls.mutate.push([op, data]); return { provider: data.provider, copied: data.copy ? 1 : 0 }; },
    render: async () => {}, openModal: options => { calls.modals.push(options); return { querySelector: () => null }; },
    toast: () => {},
  });
  ctl.handle('tasks-provider-choose', { dataset: { provider: 'plugin:todoist' } });
  assert.equal(calls.modals.length, 1, 'the first choice opens the dialog');
  assert.match(calls.modals[0].body, /Connect has 1 open task\./);
  assert.equal(calls.mutate.length, 0, 'the dialog decides, not the click');

  // "Copy 1 tasks" sends copy: true; "Not now" (the other submit button) sends copy: false.
  const decision = value => new Map([['decision', value]]);
  calls.modals[0].onSubmit(decision('copy'));
  assert.deepEqual(calls.mutate.at(-1), ['task_provider_set', { provider: 'plugin:todoist', copy: true }]);
  calls.modals[0].onSubmit(decision('skip'));
  assert.deepEqual(calls.mutate.at(-1), ['task_provider_set', { provider: 'plugin:todoist', copy: false }]);

  // Already offered: the quiet link's own action, and a plain choose, both skip the dialog.
  s.settings.tasks.copyOffered = ['plugin:todoist'];
  ctl.handle('tasks-provider-choose', { dataset: { provider: 'plugin:todoist' } });
  assert.equal(calls.modals.length, 1, 'no second dialog once offered');
  assert.deepEqual(calls.mutate.at(-1), ['task_provider_set', { provider: 'plugin:todoist' }]);
});

// ---------------------------------------------------------------- saving the token (ruling 2)

test('saving the token sends set_setting and empties the field; nothing is written to localStorage', async () => {
  const s = { ...buildSnapshot(NOW, { photo: false, zone: 'UTC' }), taskProvider: { active: 'plugin:todoist', name: 'Todoist', available: [] } };
  const calls = { plugins: [], refreshed: 0 };
  const ctl = createTasksController({
    state: { tasks: newTasksView() },
    snap: () => s,
    mutate: async () => ({}), render: async () => {}, openModal: () => null, toast: () => {},
    pluginRequest: async (op, data) => { calls.plugins.push([op, data]); return {}; },
    refreshInstalled: async () => { calls.refreshed++; },
  });
  const input = { type: 'password', value: 'tdi_abc123secretvalue' };
  const wrap = { querySelector: sel => (sel === 'input[type=password]' ? input : null) };
  const button = { dataset: { key: 'token' }, closest: sel => (sel === '[data-provider-secret]' ? wrap : null) };

  const guard = { setItem() { throw new Error('must not write to localStorage'); }, getItem() { return null; } };
  const before = globalThis.localStorage;
  globalThis.localStorage = guard;
  try {
    await ctl.handle('tasks-provider-secret-save', button);
  } finally {
    if (before === undefined) delete globalThis.localStorage; else globalThis.localStorage = before;
  }
  assert.deepEqual(calls.plugins, [['set_setting', { id: 'todoist', key: 'token', value: 'tdi_abc123secretvalue' }]]);
  assert.equal(input.value, '', 'cleared at once');
  assert.equal(calls.refreshed, 1, 'the installed list is read again so "set" follows');

  // Remove: the same `set_setting`, with an empty value; no field to read.
  calls.plugins.length = 0;
  await ctl.handle('tasks-provider-secret-remove', { dataset: { key: 'token' } });
  assert.deepEqual(calls.plugins, [['set_setting', { id: 'todoist', key: 'token', value: '' }]]);

  // A string setting (Project, App label), on change.
  calls.plugins.length = 0;
  await ctl.handle('tasks-provider-setting', { dataset: { key: 'project' }, value: 'Work' });
  assert.deepEqual(calls.plugins, [['set_setting', { id: 'todoist', key: 'project', value: 'Work' }]]);
});

test('Turn on sends set_enabled and reads the installed list again', async () => {
  const s = { ...buildSnapshot(NOW, { photo: false, zone: 'UTC' }), taskProvider: { active: 'local', name: 'Connect', available: [] } };
  const calls = { plugins: [], refreshed: 0, renders: 0 };
  const state = { tasks: newTasksView() };
  const ctl = createTasksController({
    state, snap: () => s, mutate: async () => ({}), render: async () => { calls.renders++; }, openModal: () => null, toast: () => {},
    pluginRequest: async (op, data) => { calls.plugins.push([op, data]); return {}; },
    refreshInstalled: async () => { calls.refreshed++; },
  });
  await ctl.handle('tasks-provider-turn-on', { dataset: { provider: 'plugin:todoist' } });
  assert.deepEqual(calls.plugins, [['set_enabled', { id: 'todoist', enabled: true }]]);
  assert.equal(calls.refreshed, 1);
  assert.equal(state.tasks.provider.busy['plugin:todoist'], undefined, 'cleared once done');
});
