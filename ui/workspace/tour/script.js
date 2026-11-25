// The real-app tour's stops (design docs/superpowers/specs/2026-11-24-real-app-tour-design.md § 6):
// pure data that `runner.js` walks inside the tour build's own window. Each stop names its route,
// view, theme and width, an optional in-app action (a name from `ACTIONS` in runner.js, with its
// argument), the checks that must hold on screen and the features of `coverage.js` it shows.
//
// Every selector is the one the browser check set of that feature already uses (named per stop),
// so the tour and the browser run look at the same things.
//
// A check is `{name, selector, text?, exact?, order?, notText?, count?, min?, absent?, before?, ids?, css?}`:
// - `selector` alone: at least one visible match;
// - `text`: the matches' text holds it (a list: holds each; with `order`, in that order);
// - `exact`: the first match's text, whitespace folded, is exactly it;
// - `count` / `min`: exactly / at least that many visible matches;
// - `absent`: no visible match;
// - `notText`: the matches' text holds none of these;
// - `before`: the first match comes before the first match of this selector in the page;
// - `ids`: the matches' `data-id`s start with these, in order;
// - `css`: `[property, value]` of the first match's computed style.
// `scroll` (optional) names the part to scroll into view before the capture.
// `expectRefused` (optional) names the refusals the stop legitimately hits (the window gate's or
// Rust's); any other refusal during the stop fails it, and so does an expected one that never came.
// A menu-bar check is `{name, fact, equals?, min?}` over `tour_menu_bar`'s answer.
// `noOverflow` is added to every captured stop by the runner.

/**
 * The seed's ids, as `scripts/tour/seed.mjs` exports them (`ui/` can't import `scripts/`; a test
 * pins the two equal).
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
};

/** The heights and widths the tour sizes its window to (the browser run's widths). */
export const HEIGHT = 900;
export const WIDTHS = [1000, 1440, 1680];

const MTG = `#/meetings/${SEED_IDS.readyMeeting}/summary`;
const crow = id => `.ws-crow-body[data-message-id="${id}"]`;
const read = id => `.ws-read[data-message-id="${id}"]`;
const bar = sel => `${sel} .ws-reply-bar`;
/** The reply bar's direct controls (reply-checks.mjs `barControls`). */
const controls = sel => `${sel} .ws-reply-bar > button, ${sel} .ws-reply-bar > details`;
const TODAY_MORE = '.ws-today-actions details[data-menu="today-more"]';
const MEETING_MORE = '.ws-mtg-strip > .ws-menu';
const TASK = id => `.ws-tdate-row[data-task="${id}"]`;

/** The seed's AI settings (scripts/tour/seed.mjs; a test pins the two equal): the chooser stop
 *  clears the default to open the chooser, then saves these back. */
export const SEED_AI = {
  defaultProfile: 'claude', defaultModel: null, defaultFallback: null,
  routes: {
    triage: { profile: 'codemie:local-ollama', model: null, fallback: 'claude' },
    commitments: { profile: 'codemie:local-ollama', model: null, fallback: null },
  },
  plugins: {},
};
const SEED_PINS = ['formal-summary', 'short-summary'];
const NAV_IDS = ['today', 'inbox', 'calendar', 'meetings', 'tasks', 'automations', 'analytics'];
const SHOW_ALL = { name: 'mutate', arg: { op: 'settings_update', data: { hiddenPages: [] } } };
const click = arg => ({ name: 'click', arg });
const menu = arg => ({ name: 'menu', arg });
const until = arg => ({ name: 'until', arg });
const settings = data => ({ name: 'mutate', arg: { op: 'settings_update', data } });

/** Stops added after spec § 6's first table (Task 6's fix rounds): every built feature of steps
 *  0–7 that T01–T31 didn't check. They change state only through in-app clicks and store actions.
 *  Most put back what they changed (`after`); T50 (tasks accepted), T54 (a task added) and T61
 *  (the Todoist plugin removed) leave it changed, and T61 runs last. */
const MORE = [
  // ---------------------------------------------------------------- step 0 (marketplace plan, plugins-checks.mjs)
  {
    id: 'T32', step: [0], title: 'Add marketplace refuses a built-in’s name', route: '#/settings/plugins',
    view: 'default', theme: 'dark', width: 1440,
    // "codemie" is the built-in's own source, refused as already added before anything is fetched
    // (plugins/market.rs `add`: `already_added` comes before `fetch`).
    action: [click('[data-action="market-add"]'), until('.ws-modal[open] #market-source'), { name: 'type', arg: { selector: '.ws-modal[open] #market-source', text: 'codemie' } },
      click('.ws-modal[open] button[type="submit"]'), { name: 'wait', arg: 400 }],
    after: click('.ws-modal[open] .ws-modal-footer [data-modal-close]'),
    checks: [
      { name: 'refused: "That marketplace is already added, as “codemie”."', selector: '.ws-modal[open], .ws-toast', text: 'already added, as “codemie”' },
    ],
    covers: ['m0.already-added'],
  },

  // ---------------------------------------------------------------- step 1 (compact-checks.mjs C5)
  {
    id: 'T33', step: [1], title: 'A hidden page still opens by its route, greyed in the menu', route: '#/settings/layout',
    view: 'compact', theme: 'light', width: 1440,
    action: [settings({ hiddenPages: ['calendar'] }), { name: 'go', arg: '#/calendar' }], after: SHOW_ALL,
    checks: [
      { name: 'Calendar opened', selector: '.ws-page-calendar', count: 1 },
      { name: 'greyed in the menu while open', selector: '[data-route="calendar"].ws-nav-hidden', count: 1 },
    ],
    covers: ['c1.hidden-route'],
  },
  {
    id: 'T34', step: [1], title: 'The last page in the menu can’t be hidden', route: '#/settings/layout',
    view: 'default', theme: 'dark', width: 1440, scroll: '.ws-card:has(input[data-action="menu-page"])',
    action: settings({ hiddenPages: NAV_IDS.filter(id => id !== 'inbox') }), after: SHOW_ALL,
    checks: [
      { name: 'the Inbox switch is disabled', selector: 'input[data-action="menu-page"][data-page="inbox"]', disabled: true },
      { name: '"Keep one page in the menu."', selector: 'span[title="Keep one page in the menu."]', count: 1 },
    ],
    covers: ['c1.last-switch'],
  },

  // ---------------------------------------------------------------- step 2 (reply-checks.mjs)
  {
    id: 'T35', step: [2], title: 'Teams sending off: "Copy reply"', route: '#/inbox',
    view: 'default', theme: 'dark', width: 1440,
    action: [settings({ capabilities: ['calendar', 'mail', 'chats', 'meetings', 'transcripts', 'mail_send'] }), { name: 'selectRow', arg: SEED_IDS.teams1to1 }],
    after: settings({ capabilities: ['calendar', 'mail', 'chats', 'meetings', 'transcripts', 'mail_send', 'chat_send'] }),
    checks: [
      { name: 'primary "Copy reply"', selector: `${bar(read(SEED_IDS.teams1to1))} [data-action="reply-copy"]`, exact: 'Copy reply' },
      { name: 'no Send', selector: `${read(SEED_IDS.teams1to1)} [data-action="reply-send"]`, absent: true },
    ],
    covers: ['r2.copy-reply'],
  },
  {
    id: 'T36', step: [2], title: 'Your own Outlook message: no reply box, Done', route: '#/inbox',
    view: 'default', theme: 'light', width: 1440, action: { name: 'selectRow', arg: 'm-thread-mine' },
    checks: [
      { name: 'it is in the reading pane', selector: read('m-thread-mine'), count: 1 },
      { name: 'no reply box', selector: `${read('m-thread-mine')} #reply-body`, absent: true },
      { name: 'Done is the primary', selector: `${read('m-thread-mine')} .ws-btn-primary`, text: 'Done' },
    ],
    covers: ['r2.own-mail'],
  },
  {
    id: 'T37', step: [2], title: 'A group chat: "Send to Release crew"', route: '#/inbox',
    view: 'compact', theme: 'light', width: 1440, action: { name: 'openRow', arg: SEED_IDS.groupChat },
    checks: [
      { name: 'primary "Send to Release crew"', selector: `${bar(crow(SEED_IDS.groupChat))} [data-action="reply-send"]`, exact: 'Send to Release crew' },
    ],
    covers: ['r2.group-label'],
  },
  {
    id: 'T38', step: [2], title: 'The critical message’s ⋯ holds Snooze', route: '#/inbox',
    view: 'default', theme: 'light', width: 1440, action: { name: 'openMore', arg: `reply:${SEED_IDS.critical}` },
    checks: [
      { name: 'Snooze and its four choices under ⋯', selector: `${read(SEED_IDS.critical)} details[data-menu="reply-more"] [data-action="message-snooze"]`, count: 4 },
    ],
    covers: ['r2.snooze-under-more'],
  },
  {
    id: 'T39', step: [2], title: 'Draft options… opens its popover', route: '#/inbox',
    view: 'default', theme: 'dark', width: 1680,
    action: [{ name: 'openMore', arg: `reply:${SEED_IDS.teams1to1}` }, click(`${read(SEED_IDS.teams1to1)} [data-action="ai-draft-options"]`), until('#draft-options'), { name: 'wait', arg: 400 }],
    after: click('#draft-options [data-action="ai-draft-cancel"]'),
    checks: [
      { name: 'the Draft with AI popover', selector: '#draft-options', text: 'Draft with AI' },
      { name: 'its tones', selector: '#draft-options [data-draft-tone]', min: 2 },
    ],
    covers: ['r2.draft-options'],
  },
  {
    id: 'T40', step: [2], title: 'Settings › Microsoft 365: Allow actions', route: '#/settings/microsoft',
    view: 'default', theme: 'light', width: 1440, scroll: '.ws-card:has([data-action="graph-permission"])',
    checks: [
      { name: 'the Allow actions copy', selector: '.ws-card:has([data-action="graph-permission"])', text: ['Allow actions', 'Nothing is sent without your click.'], order: true },
      { name: 'a switch per action', selector: 'input[data-action="graph-permission"]', min: 2 },
    ],
    covers: ['r2.allow-actions'],
  },

  // ---------------------------------------------------------------- step 3 (meetings-view-checks.mjs, meetings-settings-checks.mjs)
  {
    id: 'T41', step: [3], title: 'A meeting’s "with …" and its people', route: MTG,
    view: 'default', theme: 'light', width: 1440, action: menu(`details[data-menu="people-${SEED_IDS.readyMeeting}"]`),
    checks: [
      { name: 'the header’s "with …"', selector: '.ws-mtg-with', text: 'with' },
      { name: 'the people popover', selector: '.ws-mtg-people-pop .ws-mtg-people' },
    ],
    covers: ['mv3.with-header'],
  },
  {
    id: 'T42', step: [3], title: 'A pinned tab with no document: "Make Formal summary"', route: MTG,
    view: 'default', theme: 'dark', width: 1440, action: click('.ws-mtg-tabs [data-action="meeting-summary-tab"][data-key="tpl:formal-summary"]'),
    checks: [
      { name: '"No Formal summary yet."', selector: '.ws-mtg-nosummary', text: 'No Formal summary yet.' },
      { name: 'the primary "Make Formal summary"', selector: '.ws-mtg-strip [data-action="meeting-make-tab"]', text: 'Make Formal summary' },
    ],
    covers: ['mv3.make-tab'],
  },
  {
    id: 'T43', step: [3], title: 'Action items off: "Review 2 tasks" and ⋯ › Action items', route: MTG,
    view: 'default', theme: 'light', width: 1440,
    action: [settings({ meetings: { actionItems: false } }), menu('.ws-mtg-strip > .ws-menu')], after: settings({ meetings: { actionItems: true } }),
    checks: [
      { name: 'no column', selector: '.ws-mtg-items:not(.ws-mtg-items-pane)', absent: true },
      { name: '"Review N tasks"', selector: '.ws-btn[data-action="meeting-pane"][data-pane="tasks"]', text: ['Review', 'task'], order: true },
      { name: '⋯ › Action items', selector: '.ws-mtg-strip > .ws-menu [data-action="meeting-pane"][data-pane="tasks"]', text: 'Action items' },
    ],
    covers: ['mv3.review-tasks'],
  },
  {
    id: 'T44', step: [3, 4], title: 'Adding a meeting’s task to Todoist, and Undo', route: MTG,
    view: 'default', theme: 'dark', width: 1680, action: [click('[data-action="meeting-items-add"]'), until('.ws-mtg-items-foot [data-action="meeting-items-undo"]')],
    after: click('.ws-mtg-items-foot [data-action="meeting-items-undo"]'),
    checks: [
      { name: '"Added 1 to Todoist · Undo"', selector: '.ws-mtg-items-foot', text: ['Added 1 to Todoist', 'Undo'], order: true },
    ],
    covers: ['mv3.added-undo'],
  },
  {
    id: 'T45', step: [3], title: 'At 1000 the action items drop below the summary', route: MTG,
    view: 'default', theme: 'light', width: 1000,
    checks: [
      { name: 'the column is below the pane', selector: '.ws-mtg-items:not(.ws-mtg-items-pane)', below: '.ws-mtg-detail' },
    ],
    covers: ['mv3.column-below'],
  },
  {
    id: 'T46', step: [3], title: 'Pin a summary ▾ and a template’s "Pin as a summary tab"', route: '#/settings/meetings-templates',
    view: 'compact', theme: 'dark', width: 1440, scroll: '.ws-card:has([data-menu="ms-pin-add"])',
    action: menu('details[data-menu="ms-pin-add"]'),
    checks: [
      { name: 'Pin a summary ▾ offers the other templates', selector: 'details[data-menu="ms-pin-add"]', text: ['Pin a summary', 'Meeting notes'], order: true },
      { name: 'a template card offers "Pin as a summary tab"', selector: '.ws-ms-tpl-card[data-template="meeting-notes"] [data-action="meetings-settings-pin"]', any: true, text: 'Pin as a summary tab' },
    ],
    covers: ['mv3.pin-menus'],
  },
  {
    id: 'T47', step: [3], title: 'A plugin’s minutes as a pinned tab', route: MTG,
    view: 'default', theme: 'light', width: 1440,
    action: [settings({ meetings: { summaryTabs: ['plugin:digest', ...SEED_PINS] } }), { name: 'go', arg: MTG }, until('.ws-mtg-tabs [role="tab"][data-key="plugin:digest"]'),
      click('.ws-mtg-tabs [role="tab"][data-key="plugin:digest"]'), { name: 'untilText', arg: { selector: '.ws-mtg-summary', text: 'three decisions' } }],
    after: settings({ meetings: { summaryTabs: SEED_PINS } }),
    checks: [
      { name: 'the Digest tab, first', selector: '.ws-mtg-tabs [role="tab"]', text: ['Digest', 'Formal summary'], order: true },
      { name: 'its minutes, as text', selector: '.ws-mtg-summary', text: 'three decisions and two follow-ups' },
    ],
    covers: ['mv3.plugin-minutes'],
  },
  {
    id: 'T48', step: [3], title: 'An old link: /notes opens Notes', route: `#/meetings/${SEED_IDS.readyMeeting}/notes`,
    view: 'default', theme: 'dark', width: 1440,
    checks: [
      { name: 'the Notes pane with its document picker', selector: '.ws-mtg-doc-pick-sum', text: 'of 2' },
    ],
    covers: ['mv3.deep-links'],
  },
  {
    id: 'T49', step: [3], title: 'An old link: /tasks shows the summary with its column', route: `#/meetings/${SEED_IDS.readyMeeting}/tasks`,
    view: 'compact', theme: 'light', width: 1440,
    checks: [
      { name: 'the summary pane', selector: '.ws-mtg-detail[data-panel="summary"]', count: 1 },
      { name: 'the action items column', selector: '.ws-mtg-items:not(.ws-mtg-items-pane)' },
    ],
    covers: ['mv3.deep-links'],
  },

  // ---------------------------------------------------------------- step 4 (tasks-provider-checks.mjs, tasks-dates-checks.mjs, settings-tasks-checks.mjs)
  {
    id: 'T50', step: [4], title: 'Accept all moves the tasks to review onto the board', route: '#/tasks',
    view: 'default', theme: 'dark', width: 1440, action: [click('[data-action="task-accept-all"]'), { name: 'untilText', arg: { selector: '.ws-toast', text: 'accepted' } }],
    checks: [
      { name: 'To review is cleared', selector: 'section.ws-tdate-review', absent: true },
      { name: '"N tasks accepted. They’re on your board."', selector: '.ws-toast', text: 'tasks accepted. They’re on your board.' },
    ],
    covers: ['tp4.accept-all'],
  },
  {
    id: 'T51', step: [4], title: 'Late ⋯: Move all to…, Done all', route: '#/tasks',
    view: 'compact', theme: 'dark', width: 1000, action: menu('details[data-menu="tasks-late"]'),
    checks: [
      { name: 'Move all to Tomorrow, Move all to Monday, Pick date…, Done all', selector: 'details[data-menu="tasks-late"] .ws-menu-panel', text: ['Move all to Tomorrow', 'Move all to Monday', 'Pick date…', 'Done all'], order: true },
    ],
    covers: ['tp4.late-menu'],
  },
  {
    id: 'T52', step: [4], title: 'A task done: "Marked 1 done · Undo"', route: '#/tasks',
    view: 'default', theme: 'light', width: 1680, action: [click('input[data-action="task-done"][data-id="task-legal"]'), until('.ws-tdate-foot [data-action="tasks-undo"]')],
    after: click('.ws-tdate-foot [data-action="tasks-undo"]'),
    checks: [
      { name: '"Marked 1 done · Undo"', selector: '.ws-tdate-foot', text: ['Marked 1 done', 'Undo'], order: true },
    ],
    covers: ['tp4.done-undo'],
  },
  {
    id: 'T53', step: [4], title: 'Tasks’ status line and ⋯ › Sync now', route: '#/tasks',
    view: 'default', theme: 'light', width: 1440, action: menu('details[data-menu="tasks-more"]'),
    checks: [
      { name: 'the status line names Todoist', selector: '.ws-tasks-line', text: 'Todoist' },
      { name: '⋯ › Sync now and Settings › Tasks', selector: 'details[data-menu="tasks-more"] .ws-menu-panel', text: ['Sync now', 'Settings › Tasks'], order: true },
    ],
    covers: ['tp4.header-sync'],
  },
  {
    id: 'T54', step: [4], title: 'Inbox ⋯ › Add a task lands in Todoist', route: '#/inbox',
    view: 'default', theme: 'light', width: 1440,
    action: [{ name: 'openMore', arg: `reply:${SEED_IDS.priyaMail}` }, click(`${read(SEED_IDS.priyaMail)} [data-action="commitment"]`), until('.ws-modal[open] textarea[name="text"]'),
      click('.ws-modal[open] button[type="submit"]'), until('.ws-toast')],
    checks: [
      { name: 'the toast says it is in Todoist', selector: '.ws-toast', text: 'Todoist' },
    ],
    covers: ['tp4.inbox-added'],
  },
  {
    id: 'T55', step: [4], title: 'Nudge Marek fills the reply, sends nothing', route: '#/tasks',
    view: 'default', theme: 'dark', width: 1440,
    action: [{ name: 'unfoldTask', arg: SEED_IDS.checkWithTask }, click(`${TASK(SEED_IDS.checkWithTask)} [data-action="task-nudge"]`), until('#reply-body')],
    checks: [
      { name: 'the reply box holds the nudge', selector: '#reply-body', valueStarts: 'Hi Marek, any news on' },
    ],
    covers: ['tp4.nudge'],
  },

  // ---------------------------------------------------------------- step 5 (automations-checks.mjs)
  {
    id: 'T56', step: [5], title: 'The Formal summary automation’s editor: Make and Wishes', route: '#/automations/templates',
    view: 'compact', theme: 'dark', width: 1440, action: { name: 'useTemplate', arg: 'formal-summary' }, after: { name: 'cancelModal' },
    checks: [
      { name: 'Make is Formal summary', selector: '.ws-modal[open] #auto-summary', value: 'formal-summary' },
      { name: '"Wishes (optional)"', selector: '.ws-modal[open] label[for="auto-prompt"]', exact: 'Wishes (optional)' },
      { name: 'no Read box', selector: '.ws-modal[open] #auto-read', absent: true },
    ],
    covers: ['ct5.summary-editor'],
  },
  {
    id: 'T57', step: [5], title: 'The automations list: where each one delivers', route: '#/automations/automations',
    view: 'default', theme: 'light', width: 1440,
    checks: [
      { name: 'Inbox triage delivers to Today and Tasks', selector: '.ws-auto-row[data-automation="auto-triage"] .ws-auto-deliver', text: 'Tasks' },
    ],
    covers: ['ct5.deliver-chips'],
  },
  {
    id: 'T58', step: [5], title: 'Run log: the summary run’s meeting', route: '#/automations/runs',
    view: 'default', theme: 'light', width: 1440, action: { name: 'unfoldRun', arg: 'run-summary' }, scroll: '#run-run-summary',
    checks: [
      { name: '"Formal summary queued for …"', selector: '#run-run-summary', text: 'Formal summary queued for' },
      { name: 'Open meeting', selector: '#run-run-summary a.ws-run-task', text: 'Open meeting' },
    ],
    covers: ['ct5.run-log-details'],
  },

  // ---------------------------------------------------------------- step 7 (ai-routes-checks.mjs R5)
  {
    id: 'T59', step: [7], title: 'The first-use chooser offers the ready profiles', route: '#/inbox',
    view: 'default', theme: 'dark', width: 1440,
    action: [{ name: 'mutate', arg: { op: 'ai_settings_save', data: { ...SEED_AI, defaultProfile: null } } }, { name: 'selectRow', arg: SEED_IDS.teams1to1 },
      click(`${read(SEED_IDS.teams1to1)} [data-action="ai-draft-quick"]`), until('.ws-modal[open] [data-action="ai-choose"]'), { name: 'wait', arg: 400 }],
    after: [click('.ws-modal[open] [data-modal-close]'), { name: 'mutate', arg: { op: 'ai_settings_save', data: SEED_AI } }],
    checks: [
      { name: '"Choose which AI writes for you"', selector: '.ws-modal[open] .ws-modal-header h2', exact: 'Choose which AI writes for you' },
      { name: 'Claude Code and CodeMie · prod, the ready profiles', selector: '.ws-modal[open] .ws-ai-choices', text: ['Claude Code', 'CodeMie · prod'], order: true },
      // ai-chooser.js offers only ready profiles; the seed's Ollama is not running (spec § 4).
      { name: 'the not-running Ollama profile is not offered', selector: '.ws-modal[open] [data-profile="codemie:local-ollama"]', absent: true },
    ],
    covers: ['pm7.chooser'],
  },

  // ---------------------------------------------------------------- step 4 (tasks-dates-checks.mjs provider)
  {
    id: 'T60', step: [4], title: 'Deleting a Todoist task asks first', route: '#/tasks',
    view: 'default', theme: 'light', width: 1440,
    // The Delete control only opens the ask; `task_delete` (its yes) is still refused by the
    // gate, and the stop answers Cancel.
    allow: ['task-delete'],
    action: [{ name: 'unfoldTask', arg: 'task-legal' }, menu('.ws-tdate-row[data-task="task-legal"] .ws-tdate-more'),
      click('.ws-tdate-row[data-task="task-legal"] [data-action="task-delete"]'), until('.ws-modal[open] .ws-modal-text'), { name: 'wait', arg: 400 }],
    after: click('.ws-modal[open] [data-modal-close]'),
    checks: [
      { name: '"Delete … in Todoist too? Undo makes it again as a new task."', selector: '.ws-modal[open] .ws-modal-text', exact: 'Delete “Send Legal the written legal-hold requirement” in Todoist too? Undo makes it again as a new task.' },
    ],
    covers: ['tp4.delete-ask'],
  },

  // ---------------------------------------------------------------- step 4, last: removing the plugin (settings-tasks-checks.mjs)
  {
    id: 'T61', step: [4], title: 'Removing the Todoist plugin puts tasks back in Connect', route: '#/settings/plugins/todoist',
    view: 'default', theme: 'light', width: 1440,
    // Removing deletes the plugin's files, all inside the tour's own test folder; this one stop
    // allows that control and that request, and runs last.
    allow: ['plugin-remove', 'plugins_request:remove'],
    // The dialog ignores a submit in its first moments (ui.js `COMMIT_GUARD_MS`), as a person's
    // double click would be; the click comes after it.
    action: [click('[data-action="plugin-remove"][data-plugin-id="todoist"]'), until('.ws-modal[open] button[type="submit"]'), { name: 'wait', arg: 900 },
      click('.ws-modal[open] button[type="submit"]'), { name: 'untilText', arg: { selector: '.ws-toast', text: 'back in Connect' } }],
    checks: [
      // Exactly one toast says it, and it says exactly this (never the removal's own "Todoist is
      // removed. Its data is kept." success toast beside it): joining the text of every `.ws-toast`
      // (as a plain `text` check does) would still pass with three of this one shown at once.
      { name: '"Todoist was removed, so tasks are back in Connect." — exactly one toast', selector: '.ws-toast.ws-toast-info', count: 1, exact: 'Todoist was removed, so tasks are back in Connect.' },
      // Design §11 ruling 16: removing a provider switches to Local once.
      { name: 'exactly one task_provider_set', op: 'task_provider_set', count: 1 },
    ],
    covers: ['tp4.removed-local'],
  },
];

/** Settings › Your voice (rollout step 8, voice-checks.mjs's selectors). */
const VOICE = '#/settings/voice';
const MODAL_CANCEL = '.ws-modal[open] .ws-modal-footer [data-modal-close]';
/** The seed's skills folder (scripts/tour/seed.mjs copies the invented fixture there). */
const SKILLS = 'voice-skills';
/** voice-import-preview.json's skipped skills, as § 11 words their reasons (voice-checks.mjs). */
const SKIPPED = [
  ['deploy-helper', 'A procedure that runs tools. It waits for the skill runner, a later step.'],
  ['meeting-notes', 'Not about how you write messages.'],
  ['broken', 'Its SKILL.md has no name in its frontmatter.'],
];

/** Step 8's stops. They change state only through in-app clicks and store actions, and put back
 *  what they changed: T68 chooses Knowledge again with facts on, the import stops Cancel. */
const VOICE_STOPS = [
  {
    id: 'T62', step: [8], title: 'Settings › Your voice: Knowledge, facts, the instructions and the privacy line', route: VOICE,
    view: 'default', theme: 'light', width: 1440,
    checks: [
      { name: 'the tab is "Your voice"', selector: '.ws-settings-nav [data-tab="voice"]', exact: 'Your voice' },
      { name: 'the radios: Off and Knowledge', selector: '[data-voice-provider] input[name="voice-provider"]', count: 2 },
      { name: 'Knowledge is chosen', selector: '[data-voice-provider] input[value="plugin:knowledge"]:checked', count: 1 },
      { name: '"Ready · 3 people · style card · 6 instructions"', selector: '#ws-voice-state-plugin_knowledge', exact: 'Ready · 3 people · style card · 6 instructions' },
      { name: 'facts on', selector: '[data-voice-facts]:checked', count: 1 },
      { name: 'facts: "never the message"', selector: '#ws-voice-facts-hint', text: 'never the message' },
      { name: 'six instructions', selector: '[data-voice-rule]', count: 6 },
      { name: 'a chat, a domain on mail only and no profile on Teams only', selector: '.ws-voice-rules', text: ['In the chat “Platform review”', 'Anyone at bank.example.test · mail only', 'Anyone without a profile · Teams only'] },
      { name: 'the privacy line', selector: '.ws-voice-privacy', text: ['goes only to the AI profile that writes the draft', "or an automation's own", 'never kept'] },
      { name: 'Refresh now', selector: '[data-action="voice-refresh"]', exact: 'Refresh now' },
      { name: 'Delete Connect’s copy', selector: '[data-action="voice-forget"]', exact: 'Delete Connect\'s copy' },
    ],
    covers: ['v8.settings-tab', 'v8.provider-choice', 'v8.privacy-line', 'v8.facts-setting', 'v8.rules', 'v8.rule-scopes'],
  },
  {
    id: 'T63', step: [8], title: 'Settings › Your voice in Compact at 1000', route: VOICE,
    view: 'compact', theme: 'dark', width: 1000, scroll: '#ws-voice-rules-title',
    checks: [
      { name: 'the card', selector: '.ws-voice-card', count: 1 },
      { name: 'the instructions', selector: '[data-voice-rule]', min: 6 },
    ],
    covers: ['v8.compact'],
  },
  {
    id: 'T64', step: [8], title: 'The style card: its head, and Edit', route: VOICE,
    view: 'default', theme: 'dark', width: 1440, scroll: '[data-voice-style-head]',
    action: [click('[data-action="voice-edit-style"]'), until('#ws-voice-style-text')],
    after: click('[data-action="voice-cancel"]'),
    checks: [
      { name: '"From your page people/me.md"', selector: '[data-voice-style-head]', text: 'From your page people/me.md' },
      { name: 'a labelled box', selector: 'label[for="ws-voice-style-text"]', exact: 'Style card' },
      { name: 'it holds the card', selector: '#ws-voice-style-text', valueStarts: 'Short and direct.' },
      { name: 'and not the head', selector: '#ws-voice-style-text', notText: 'Prefers short replies' },
      { name: '"From 12 mail previews and 140 Teams messages"', selector: '.ws-voice-meta', text: 'From 12 mail previews and 140 Teams messages' },
      { name: 'Save', selector: '[data-action="voice-save-style"]', count: 1 },
      { name: 'Cancel', selector: '[data-action="voice-cancel"]', count: 1 },
    ],
    covers: ['v8.style-card', 'v8.style-head', 'v8.style-edit'],
  },
  {
    id: 'T65', step: [8], title: 'People: Marek is Teams only, and Priya’s profile', route: VOICE,
    view: 'default', theme: 'light', width: 1440, scroll: '#ws-voice-people-title',
    action: [click('[data-voice-person="priya-n"] [data-action="voice-person"]'), until('.ws-modal[open] .ws-voice-dialog-head'), { name: 'wait', arg: 400 }],
    after: click('.ws-modal[open] [data-modal-close]'),
    checks: [
      { name: 'Marek Novak: "Teams only"', selector: '[data-voice-person="marek-novak"]', text: ['Marek Novak', 'Teams only'] },
      { name: 'the profile: how to write to them, about them, edit it in Knowledge', selector: '.ws-modal[open] .ws-modal-body', text: ['How to write to them', 'About them', 'Edit it in Knowledge'] },
      { name: 'one voice_read', op: 'voice_read', count: 1 },
    ],
    covers: ['v8.people', 'v8.teams-only-person'],
  },
  {
    // Elena's mail, not Priya's: T55's Nudge fills Priya's reply, and a seeded draft would hold
    // that box. draft-ai-voice.json's voice names no person (controller ruling: the fixture wins).
    id: 'T66', step: [8], title: 'A mail’s draft in your voice, with its facts', route: '#/inbox',
    view: 'default', theme: 'light', width: 1440,
    action: [{ name: 'selectRow', arg: SEED_IDS.voiceMail }, click(`${read(SEED_IDS.voiceMail)} [data-action="ai-draft-context"]`), until('#draft-context:not([hidden])')],
    checks: [
      { name: '" · in your voice"', selector: `${read(SEED_IDS.voiceMail)} .ws-draft-source`, text: ' · in your voice' },
      { name: 'Context: your voice, the style card and 2 earlier messages', selector: '#draft-context .ws-draft-voice', text: ['Your voice (Knowledge): style card', '2 earlier messages'] },
      // draft-ai-voice.json's facts (controller ruling: the contract fixture wins over the brief).
      { name: '"Facts from Knowledge: Atlas rollout · EPM-1234"', selector: '#draft-context .ws-draft-voice', text: 'Facts from Knowledge: Atlas rollout · EPM-1234' },
    ],
    covers: ['v8.draft-voice', 'v8.draft-examples', 'v8.draft-facts'],
  },
  {
    // The group chat, not the Jordan 1:1: T05 needs that box empty, and a seeded draft fills it.
    id: 'T67', step: [8], title: 'Inbox triage’s draft from Connect’s copy, with no facts in time', route: '#/inbox',
    view: 'compact', theme: 'light', width: 1440,
    action: [{ name: 'openRow', arg: SEED_IDS.groupChat }, click(`${crow(SEED_IDS.groupChat)} [data-action="ai-draft-context"]`), until('#draft-context:not([hidden])')],
    checks: [
      { name: 'drafted by “Inbox triage”, in your voice', selector: `${crow(SEED_IDS.groupChat)} .ws-draft-source`, text: ['“Inbox triage”', ' · in your voice'], order: true },
      { name: 'Context: Connect’s copy, and no facts in time', selector: '#draft-context .ws-draft-voice', text: ['Knowledge found no facts in time.', 'Connect\'s copy from'] },
    ],
    covers: ['v8.background-draft'],
  },
  {
    id: 'T68', step: [8], title: 'Off keeps the copy; Delete Connect’s copy asks first', route: VOICE,
    view: 'default', theme: 'light', width: 1440,
    action: [{ name: 'mutate', arg: { op: 'voice_set', data: { provider: 'off' } } }, { name: 'untilText', arg: { selector: '.ws-voice-copy', text: 'Off. Connect still keeps a copy from' } }],
    next: {
      title: 'Delete Connect’s copy of your voice? Cancel is focused',
      action: [click('[data-action="voice-forget"]'), until('.ws-modal[open] .ws-modal-header h2'), { name: 'wait', arg: 400 }],
      checks: [
        { name: '"Delete Connect\'s copy of your voice?"', selector: '.ws-modal[open] .ws-modal-header h2', exact: 'Delete Connect\'s copy of your voice?' },
        { name: 'Cancel is focused', selector: MODAL_CANCEL, focused: true },
      ],
    },
    // Cancel, then Knowledge again with facts on (as T23 goes back to Todoist).
    after: [click(MODAL_CANCEL), { name: 'mutate', arg: { op: 'voice_set', data: { provider: 'plugin:knowledge', facts: true } } }],
    checks: [
      { name: 'Off is chosen', selector: '[data-voice-provider] input[value="off"]:checked', count: 1 },
      { name: '"Off. Connect still keeps a copy from …"', selector: '.ws-voice-copy', text: 'Off. Connect still keeps a copy from' },
    ],
    covers: ['v8.off', 'v8.delete-ask'],
  },
  {
    // The real scan of the invented skills folder (voice-import-preview.json; the brief's
    // counts gave way to it, controller ruling).
    id: 'T69', step: [8], title: 'Import from skills: the preview', route: VOICE,
    view: 'compact', theme: 'light', width: 1440, scroll: '#ws-voice-import-title',
    action: { name: 'voiceImport', arg: SKILLS }, after: click('[data-action="voice-import-cancel"]'),
    checks: [
      { name: '"Import from skills · voice-skills"', selector: '#ws-voice-import-title', exact: 'Import from skills · voice-skills' },
      { name: '"Found 6 skills. 8 instructions to add."', selector: '.ws-voice-import > .ws-hint', text: 'Found 6 skills. 8 instructions to add.' },
      { name: 'eight rows', selector: '[data-voice-import-item]', count: 8 },
      { name: 'where each came from', selector: '.ws-voice-import-rows', text: ['From budget-answers', 'From long-standard', 'From reply-style'], order: true },
      { name: 'a long skill says what it kept', selector: '[data-voice-import-item="long-standard#4"] .ws-voice-src', exact: 'From long-standard · Kept 6 of 14 lines.' },
      { name: '"Add 8 instructions"', selector: '[data-action="voice-import-save"]', exact: 'Add 8 instructions' },
      { name: 'one voice_import_scan', op: 'voice_import_scan', count: 1 },
      { name: 'no voice_import_distil', op: 'voice_import_distil', count: 0 },
      { name: 'no voice_import', op: 'voice_import', count: 0 },
    ],
    covers: ['v8.import-preview'],
  },
  {
    id: 'T70', step: [8], title: 'Import from skills: what was not imported', route: VOICE,
    view: 'default', theme: 'dark', width: 1000, scroll: '.ws-voice-subhead',
    action: { name: 'voiceImport', arg: SKILLS }, after: click('[data-action="voice-import-cancel"]'),
    checks: [
      { name: '"Not imported (3)"', selector: '.ws-voice-subhead', exact: 'Not imported (3)' },
      ...SKIPPED.map(([skill, reason]) => ({ name: `${skill}: "${reason}"`, selector: `[data-voice-import-skipped="${skill}"] .ws-muted`, exact: reason })),
      { name: 'Shorten with AI for deploy-helper', selector: '[data-action="voice-import-distil"][data-skill="deploy-helper"]', count: 1 },
      { name: 'Shorten with AI for long-standard', selector: '[data-action="voice-import-distil"][data-skill="long-standard"]', count: 1 },
      { name: 'no voice_import_distil', op: 'voice_import_distil', count: 0 },
      { name: 'no voice_import', op: 'voice_import', count: 0 },
    ],
    covers: ['v8.import-skipped'],
  },
];

export const STOPS = [
  // ---------------------------------------------------------------- step 0 (plugins-checks.mjs)
  {
    id: 'T01', step: [0], title: 'Settings › Plugins: the built-in marketplaces', route: '#/settings/plugins',
    view: 'default', theme: 'light', width: 1440,
    checks: [
      { name: 'codemie is badged Built-in', selector: '.ws-market-row[data-market="codemie"]', text: 'Built-in' },
      { name: 'onetest is badged Built-in', selector: '.ws-market-row[data-market="onetest"]', text: 'Built-in' },
      { name: 'codemie is listed before onetest', selector: '.ws-market-row[data-market="codemie"]', before: '.ws-market-row[data-market="onetest"]' },
      { name: 'codemie has no remove button', selector: '[data-action="market-remove"][data-market="codemie"]', absent: true },
      { name: 'onetest has no remove button', selector: '[data-action="market-remove"][data-market="onetest"]', absent: true },
      { name: 'codemie says Not fetched yet', selector: '.ws-market-row[data-market="codemie"]', text: 'Not fetched yet' },
      { name: 'Todoist is installed and provides tasks', selector: '#workspace-main', text: ['Todoist', 'Provides tasks'], order: true },
    ],
    covers: ['m0.builtin-first', 'm0.not-fetched', 'tp4.provides-tasks'],
  },

  // ---------------------------------------------------------------- step 1 (compact-checks.mjs)
  {
    id: 'T02', step: [1], title: 'Settings › Appearance: the View card on Compact', route: '#/settings/appearance',
    view: 'compact', theme: 'dark', width: 1440,
    checks: [
      { name: 'the View card has Compact pressed', selector: '[data-action="view-set"][data-view="compact"][aria-selected="true"]', count: 1 },
      { name: 'the app is drawn in Compact', selector: '#workspace-app[data-view="compact"]', count: 1 },
      { name: 'Compact line height (compact C3)', selector: '#workspace-app', css: ['line-height', '18px'] },
    ],
    covers: ['c1.view-setting', 'c1.compact-sizes'],
  },
  {
    id: 'T03', step: [1], title: 'Inbox in Default: the list and the reading pane', route: '#/inbox',
    view: 'default', theme: 'light', width: 1440,
    checks: [
      { name: 'the app is drawn in Default', selector: '#workspace-app[data-view="default"]', count: 1 },
      { name: 'the list', selector: '.ws-inbox-row', min: 2 },
      { name: 'the reading pane', selector: '.ws-reader' },
    ],
    covers: ['c1.default-unchanged'],
  },
  {
    id: 'T04', step: [1], title: 'Inbox in Compact: one list, rows closed', route: '#/inbox',
    view: 'compact', theme: 'dark', width: 1440,
    checks: [
      { name: 'one-line rows', selector: '.ws-inbox-row-compact', min: 2 },
      { name: 'no reading pane', selector: '.ws-reader', absent: true },
      { name: 'no row open', selector: '.ws-inbox-row[aria-expanded="true"]', absent: true },
      { name: 'Compact nav button height (compact C3)', selector: '.ws-nav button[data-route="inbox"]', css: ['height', '28px'] },
      { name: 'Compact Inbox title size (compact C3)', selector: '.ws-inbox-title h1', css: ['font-size', '22px'] },
    ],
    covers: ['c1.compact-inbox', 'c1.compact-sizes'],
  },

  // ---------------------------------------------------------------- steps 1, 2 (compact-checks.mjs C6, reply-checks.mjs)
  {
    id: 'T05', step: [1, 2], title: 'Compact Inbox: Jordan’s 1:1 open in place', route: '#/inbox',
    view: 'compact', theme: 'dark', width: 1440, action: { name: 'openRow', arg: SEED_IDS.teams1to1 },
    checks: [
      { name: 'the row is open in place', selector: `.ws-inbox-row[data-id="${SEED_IDS.teams1to1}"][aria-expanded="true"]`, count: 1 },
      { name: 'the thread under the row', selector: `${crow(SEED_IDS.teams1to1)} .ws-thread-compact` },
      { name: 'the reply box under the row', selector: `${crow(SEED_IDS.teams1to1)} #reply-body`, count: 1 },
      { name: 'the ✦ hint', selector: `${crow(SEED_IDS.teams1to1)} .ws-reply-hint`, exact: 'Write a reply, or ✦ draft with AI' },
      { name: 'primary "Send to Jordan"', selector: `${bar(crow(SEED_IDS.teams1to1))} [data-action="reply-send"]`, exact: 'Send to Jordan' },
      { name: 'Snooze ▾', selector: `${bar(crow(SEED_IDS.teams1to1))} > details[data-menu="reply-snooze"]`, count: 1 },
      { name: '⋯', selector: `${bar(crow(SEED_IDS.teams1to1))} > details[data-menu="reply-more"]`, count: 1 },
      { name: 'three controls, no fourth', selector: controls(crow(SEED_IDS.teams1to1)), count: 3 },
    ],
    covers: ['c1.open-in-place', 'r2.named-send', 'r2.draft-link', 'r2.three-controls'],
  },
  {
    id: 'T06', step: [2], title: 'Compact Inbox: the reply ⋯ menu', route: '#/inbox',
    view: 'compact', theme: 'dark', width: 1440, action: { name: 'openMore', arg: `reply:${SEED_IDS.teams1to1}` },
    checks: [
      { name: '⋯ is open', selector: `${crow(SEED_IDS.teams1to1)} details[data-menu="reply-more"][open]`, count: 1 },
      // Summarize joins the list only on a long conversation with no summary yet
      // (view-inbox.js `summaryOffer`); this 1:1 is short, so it isn't offered here.
      {
        name: 'Done, Draft options…, Open in Teams, Move to lane, Add a task, in that order',
        selector: `${crow(SEED_IDS.teams1to1)} details[data-menu="reply-more"] .ws-menu-panel`,
        text: ['Done', 'Draft options…', 'Open in Teams', 'Move to lane', 'Add a task'], order: true,
      },
    ],
    covers: ['r2.more-menu'],
  },
  {
    id: 'T07', step: [2], title: 'Compact Inbox: a typed reply, the change line and autosave', route: '#/inbox',
    view: 'compact', theme: 'dark', width: 1440, action: { name: 'typeReply', arg: `${SEED_IDS.teams1to1}:Sure, at 14:30.` },
    checks: [
      { name: 'the box holds the typed text', selector: `${crow(SEED_IDS.teams1to1)} #reply-body`, value: 'Sure, at 14:30.' },
      { name: 'the "✦ Tell AI what to change" line', selector: `${crow(SEED_IDS.teams1to1)} #reply-change` },
      { name: '"Saved on this device" after autosave', selector: `${crow(SEED_IDS.teams1to1)} .ws-reply-status`, exact: 'Saved on this device' },
    ],
    covers: ['r2.change-line', 'r2.autosave'],
  },
  {
    id: 'T08', step: [2], title: 'Default Inbox: Priya’s mail selected', route: '#/inbox',
    view: 'default', theme: 'light', width: 1440, action: { name: 'selectRow', arg: SEED_IDS.priyaMail },
    checks: [
      { name: 'the mail is in the reading pane', selector: read(SEED_IDS.priyaMail), count: 1 },
      { name: 'primary "Send to Priya…"', selector: `${bar(read(SEED_IDS.priyaMail))} [data-action="reply-send"]`, exact: 'Send to Priya…' },
      { name: 'three controls', selector: controls(read(SEED_IDS.priyaMail)), count: 3 },
    ],
    covers: ['r2.mail-ellipsis', 'r2.three-controls'],
  },
  {
    id: 'T09', step: [2], title: 'Default Inbox at 1000: the critical message', route: '#/inbox',
    view: 'default', theme: 'dark', width: 1000, action: { name: 'selectRow', arg: SEED_IDS.critical },
    checks: [
      { name: 'the message is in the reading pane', selector: read(SEED_IDS.critical), count: 1 },
      { name: 'Acknowledge is a visible button on the bar', selector: `${bar(read(SEED_IDS.critical))} > [data-action="message-ack"]`, count: 1 },
      { name: 'no Snooze ▾ in its place', selector: `${bar(read(SEED_IDS.critical))} > details[data-menu="reply-snooze"]`, absent: true },
      { name: 'three controls', selector: controls(read(SEED_IDS.critical)), count: 3 },
    ],
    covers: ['r2.acknowledge', 'r2.three-controls'],
  },

  // ---------------------------------------------------------------- step 1: Today and the menu (compact-checks.mjs C4, C5)
  {
    id: 'T10', step: [1], title: 'Compact Today: the head', route: '#/today',
    view: 'compact', theme: 'light', width: 1440,
    checks: [
      { name: 'the date and summary line', selector: '.ws-today-head .ws-today-sum-link[data-route="inbox"][data-lane="reply"]', count: 1 },
      { name: 'no avatar', selector: '.ws-today-avatar', absent: true },
      { name: 'no greeting', selector: '.ws-today-head', notText: ['Good morning', 'Good afternoon', 'Good evening'] },
      { name: 'one ⋯', selector: `${TODAY_MORE} > summary`, count: 1 },
    ],
    covers: ['c1.compact-today'],
  },
  {
    id: 'T11', step: [1], title: 'Compact Today: the ⋯ menu', route: '#/today',
    view: 'compact', theme: 'light', width: 1440, action: { name: 'openTodayMore' },
    checks: [
      { name: '⋯ is open', selector: `${TODAY_MORE}[open]`, count: 1 },
      { name: 'Layouts, Add widget, Customize, Lock layouts', selector: `${TODAY_MORE} .ws-menu-panel`, text: ['Layouts', 'Add widget', 'Customize', 'Lock layouts'] },
    ],
    covers: ['c1.today-menu'],
  },
  {
    id: 'T12', step: [1, 4, 5], title: 'Default Today at 1680: widgets', route: '#/today',
    view: 'default', theme: 'dark', width: 1680, scroll: '.ws-commitments',
    checks: [
      { name: 'no layout toolbar before ⋯ opens', selector: '.ws-today-head [data-action="today-lock"], .ws-today-head [data-action="today-customize"], .ws-today-head .ws-today-layout-pill', absent: true },
      { name: '⋯ present', selector: `${TODAY_MORE} > summary`, count: 1 },
      { name: 'the Tasks widget', selector: '.ws-commitments' },
      { name: 'no trash button with a provider', selector: '.ws-commitments [data-action="task-delete"]', absent: true },
      { name: '"Made 2 tasks in Todoist ›"', selector: '.ws-auto-card a.ws-auto-made', text: 'Made 2 tasks in Todoist ›' },
    ],
    covers: ['c1.today-menu', 'tp4.today-widget', 'ct5.today-made'],
  },
  {
    id: 'T13', step: [1], title: 'Settings › Layout: hiding Calendar from the menu', route: '#/settings/layout',
    view: 'default', theme: 'light', width: 1440, action: { name: 'hidePage', arg: 'calendar' }, after: { name: 'showPage', arg: 'calendar' },
    scroll: '.ws-card:has(input[data-action="menu-page"])',
    checks: [
      { name: 'a Menu switch per page', selector: 'input[data-action="menu-page"][data-page]', min: 5 },
      { name: 'Calendar is switched off', selector: 'input[data-action="menu-page"][data-page="calendar"]:not(:checked)', count: 1 },
      { name: 'Calendar is gone from the menu while hidden', selector: '.ws-sidebar [data-route="calendar"]', absent: true },
    ],
    covers: ['c1.hide-pages'],
  },

  // ---------------------------------------------------------------- step 3 (meetings-view-checks.mjs), step 4 (tasks-provider-checks.mjs)
  {
    id: 'T14', step: [3, 4], title: 'A ready meeting: summary first, the strip and action items', route: MTG,
    view: 'default', theme: 'light', width: 1440,
    checks: [
      { name: 'the summary pane is shown', selector: '.ws-mtg-detail[data-panel="summary"]', count: 1 },
      { name: 'the summary', selector: '.ws-mtg-summary .ws-md' },
      { name: 'the strip has exactly one primary', selector: '.ws-mtg-strip [data-action="meeting-copy-tab"]', count: 1 },
      { name: 'the strip has ⋯', selector: `${MEETING_MORE} > summary`, count: 1 },
      { name: 'the action items column', selector: '.ws-mtg-items:not(.ws-mtg-items-pane)' },
      // The seed ticks only the task that is the user's and sure (meetings-view-checks.mjs V4):
      // "Add 1 to Todoist"; the provider's name in the button is the feature.
      { name: '"Add … to Todoist"', selector: '[data-action="meeting-items-add"]', text: ['Add', 'to Todoist'], order: true },
    ],
    covers: ['mv3.summary-first', 'mv3.strip', 'mv3.action-items', 'tp4.add-to-provider'],
  },
  {
    id: 'T15', step: [3], title: 'A ready meeting: the pinned summary tabs', route: MTG,
    view: 'default', theme: 'light', width: 1440,
    checks: [
      { name: 'the tablist', selector: '.ws-mtg-tabs[role="tablist"]', count: 1 },
      { name: 'Formal summary, Short summary, in that order', selector: '.ws-mtg-tabs', text: ['Formal summary', 'Short summary'], order: true },
    ],
    covers: ['mv3.pinned-tabs'],
  },
  {
    id: 'T16', step: [3], title: 'A ready meeting: the strip’s ⋯', route: MTG,
    view: 'default', theme: 'light', width: 1440, action: { name: 'openMore', arg: 'meeting' },
    checks: [
      { name: '⋯ is open', selector: `${MEETING_MORE}[open]`, count: 1 },
      { name: 'Transcript', selector: `${MEETING_MORE} [data-action="meeting-pane"][data-pane="transcript"]`, count: 1 },
      { name: 'Notes', selector: `${MEETING_MORE} [data-action="meeting-pane"][data-pane="notes"]`, count: 1 },
      { name: 'Advanced › Files', selector: `${MEETING_MORE} .ws-menu-panel`, text: ['Advanced', 'Files'], order: true },
    ],
    covers: ['mv3.panes-behind-more'],
  },
  {
    id: 'T17', step: [3], title: 'A meeting’s transcript in Compact at 1000', route: `#/meetings/${SEED_IDS.readyMeeting}/transcript`,
    view: 'compact', theme: 'dark', width: 1000, after: { name: 'backToSummary' },
    checks: [
      { name: '"← Back to summary"', selector: '.ws-mtg-strip [data-action="meeting-back"]', text: '← Back to summary' },
      { name: 'the transcript', selector: '.ws-mtg-transcript' },
    ],
    covers: ['mv3.back-to-summary'],
  },
  {
    id: 'T18', step: [3], title: 'The meetings list in Compact at 1000', route: '#/meetings',
    view: 'compact', theme: 'dark', width: 1000,
    checks: [
      { name: 'the list', selector: '.ws-mtg-row', min: 2 },
      { name: 'Needs you', selector: '.ws-mtg-needs', text: 'Needs you' },
      { name: 'rows that need you', selector: '.ws-mtg-needs .ws-mtg-row', min: 1 },
    ],
    covers: ['mv3.list-needs-you'],
  },
  {
    id: 'T19', step: [3, 5], title: 'Settings › Note templates: opening a meeting and the templates', route: '#/settings/meetings-templates',
    view: 'default', theme: 'light', width: 1440, scroll: '.ws-card:has([data-action="meetings-settings-open-on"])',
    checks: [
      { name: '"When you open a meeting"', selector: '#workspace-main', text: 'When you open a meeting' },
      { name: 'Summary, Transcript, Notes', selector: '[data-action="meetings-settings-open-on"]', count: 3 },
      { name: 'Summary is chosen', selector: '[data-action="meetings-settings-open-on"][data-v="summary"][aria-pressed="true"]', count: 1 },
      { name: 'the action items switch', selector: '#workspace-main', text: 'Show action items beside the summary' },
      { name: 'the pinned list', selector: '.ws-ms-pins', text: ['Formal summary', 'Short summary'], order: true },
      { name: 'a Formal summary template card', selector: '.ws-ms-tpl-card[data-template="formal-summary"]', count: 1 },
    ],
    covers: ['mv3.settings-open-on', 'ct5.formal-template'],
  },

  // ---------------------------------------------------------------- step 4 (tasks-provider-checks.mjs, tasks-dates-checks.mjs, settings-tasks-checks.mjs)
  {
    id: 'T20', step: [4], title: 'Tasks with Todoist: By date', route: '#/tasks',
    view: 'default', theme: 'light', width: 1440,
    checks: [
      { name: 'By date and List, no Board', selector: '.ws-tasks-heading [data-action="tasks-view"]', text: ['By date', 'List'], order: true },
      { name: 'no Board', selector: '.ws-tasks-heading [data-action="tasks-view"][data-view="board"]', absent: true },
      { name: 'By date is a provider’s', selector: '.ws-tdate[data-provider]', count: 1 },
      { name: 'To review', selector: 'section.ws-tdate-review', text: 'To review' },
      { name: 'Late', selector: 'section.ws-tdate-late', count: 1 },
      { name: 'Today', selector: 'section.ws-tdate-today', count: 1 },
      { name: 'the folds Next 7 days, No date, Later than that', selector: 'section.ws-tdate-later', text: ['Next 7 days', 'No date', 'Later than that'], order: true },
      { name: '"Check with Marek"', selector: `${TASK(SEED_IDS.checkWithTask)} .ws-tdate-text`, text: 'Check with Marek' },
      { name: 'Looks handled', selector: '.ws-tdate-handled', text: 'Looks handled' },
      { name: 'the "Not in Todoist yet" dot', selector: '.ws-tdate-pending', min: 1 },
      { name: 'the parked row’s sentence', selector: '.ws-tdate-row-parked .ws-tdate-error', min: 1 },
    ],
    covers: ['tp4.by-date', 'tp4.check-with', 'tp4.looks-handled', 'tp4.pending-parked'],
  },
  {
    id: 'T21', step: [4], title: 'Tasks: the Check with row unfolded', route: '#/tasks',
    view: 'default', theme: 'light', width: 1440, action: { name: 'unfoldTask', arg: SEED_IDS.checkWithTask },
    checks: [
      { name: 'the row is open', selector: `${TASK(SEED_IDS.checkWithTask)}.ws-tdate-open`, count: 1 },
      { name: 'Nudge Marek', selector: `${TASK(SEED_IDS.checkWithTask)} .ws-btn-primary`, exact: 'Nudge Marek' },
      { name: 'Snooze ▾', selector: `${TASK(SEED_IDS.checkWithTask)} .ws-tdate-acts`, text: 'Snooze' },
      { name: '⋯', selector: `${TASK(SEED_IDS.checkWithTask)} .ws-tdate-acts details[data-menu] > summary`, min: 1 },
    ],
    covers: ['tp4.check-with'],
  },
  {
    id: 'T22', step: [4], title: 'Settings › Tasks: where your tasks live', route: '#/settings/meetings-tasks',
    view: 'default', theme: 'dark', width: 1440,
    checks: [
      { name: '"Where your tasks live"', selector: '.ws-tasks-provider-list[role="radiogroup"]', count: 1 },
      { name: 'Connect is offered', selector: 'input[name="tasks-provider"][value="local"]', count: 1 },
      { name: 'Todoist is chosen', selector: 'input[name="tasks-provider"][value="plugin:todoist"]:checked', count: 1 },
      { name: 'the API token field (a password box)', selector: '[data-provider-secret="token"] input[type=password]', count: 1 },
      { name: 'the Project field', selector: '[data-change="tasks-provider-setting"][data-key="project"]', count: 1 },
      { name: 'the App label field', selector: '[data-change="tasks-provider-setting"][data-key="label"]', count: 1 },
    ],
    covers: ['tp4.settings-radio', 'tp4.token-fields'],
  },
  {
    id: 'T23', step: [4], title: 'Compact Tasks on Connect: the Board', route: '#/tasks',
    view: 'compact', theme: 'light', width: 1440, action: { name: 'setProvider', arg: 'local' },
    // Back to Todoist the way the user goes: Settings › Tasks, Todoist. The seed has not offered
    // the copy yet, so Connect asks first (`T23-next`); "Not now" switches without copying.
    next: {
      title: 'Choosing Todoist again: "Copy your open tasks to Todoist?"',
      action: [{ name: 'go', arg: '#/settings/meetings-tasks' }, { name: 'click', arg: 'input[name="tasks-provider"][value="plugin:todoist"]' }, { name: 'until', arg: '.ws-modal[open]' }, { name: 'wait', arg: 400 }],
      checks: [
        { name: '"Copy your open tasks to Todoist?"', selector: '.ws-modal[open]', text: 'Copy your open tasks to Todoist?' },
        { name: 'Not now and Copy', selector: '.ws-modal[open] button[name="decision"]', count: 2 },
      ],
    },
    after: [{ name: 'click', arg: '.ws-modal[open] button[value="skip"]' }, { name: 'until', arg: 'input[name="tasks-provider"][value="plugin:todoist"]:checked' }],
    checks: [
      { name: 'Board, List and By date', selector: '.ws-tasks-heading [data-action="tasks-view"]', text: ['Board', 'List', 'By date'], order: true },
      { name: 'the board', selector: '.ws-task-board' },
    ],
    covers: ['tp4.local-board', 'tp4.copy-dialog'],
  },

  // ---------------------------------------------------------------- step 5 (automations-checks.mjs), step 7 (ai-routes-checks.mjs)
  {
    id: 'T24', step: [5], title: 'Automations › Templates: the gallery', route: '#/automations/templates',
    view: 'default', theme: 'light', width: 1440,
    checks: [
      {
        name: 'Morning briefing, Inbox triage, Commitments, Budget request reply, Formal meeting summary, in that order',
        selector: '.ws-auto-template [data-action="automation-template"]', ids: ['morning-brief', 'inbox-triage', 'commitments', 'budget-reply', 'formal-summary'],
      },
      { name: 'Inbox triage’s card: "Delivers to Today and tasks in Todoist."', selector: '.ws-auto-template:has([data-id="inbox-triage"])', text: 'Delivers to Today and tasks in Todoist.' },
    ],
    covers: ['ct5.gallery', 'ct5.deliver-chips'],
  },
  {
    id: 'T25', step: [5], title: 'Automations: Inbox triage from its template', route: '#/automations/templates',
    view: 'default', theme: 'light', width: 1440, action: { name: 'useTemplate', arg: 'inbox-triage' }, after: { name: 'cancelModal' },
    scroll: '.ws-modal[open] #auto-deliver',
    checks: [
      { name: 'the editor is open', selector: '.ws-modal[open] #automation-editor', count: 1 },
      { name: '"Tasks in Todoist" in Deliver', selector: '.ws-auto-switch:has([data-deliver="createTasks"]) .ws-switch-label', exact: 'Tasks in Todoist' },
      { name: 'it is on', selector: '[data-deliver="createTasks"]:checked', count: 1 },
      { name: 'the Read box offers "Messages since the last run"', selector: '#auto-read', text: 'Messages since the last run', any: true },
      { name: 'the profile’s Default line names the row', selector: '#auto-profile option', any: true, text: 'Default · Inbox triage (' },
    ],
    covers: ['ct5.editor-tasks', 'ct5.read-box', 'pm7.editor-default'],
  },
  {
    id: 'T26', step: [5, 7], title: 'Compact Run log: the triage run unfolded', route: '#/automations/runs',
    view: 'compact', theme: 'dark', width: 1440, action: { name: 'unfoldRun', arg: SEED_IDS.triageRun },
    checks: [
      { name: '"Tasks: 2 made in Todoist, 1 already there"', selector: `#run-${SEED_IDS.triageRun}`, text: 'Tasks: 2 made in Todoist, 1 already there' },
      { name: 'the fallback line', selector: `#run-${SEED_IDS.fallbackRun}`, text: 'Ran on' },
      { name: 'a link per task it made', selector: `#run-${SEED_IDS.triageRun} .ws-run-made a.ws-run-task`, count: 2 },
      { name: '"Looks handled: 1 task flagged"', selector: `#run-${SEED_IDS.triageRun}`, text: 'Looks handled: 1 task flagged' },
    ],
    covers: ['ct5.run-log-tasks', 'pm7.run-fallback', 'ct5.run-log-details'],
  },

  // ---------------------------------------------------------------- step 6 (menu-bar-checks.mjs)
  {
    id: 'T27', step: [6], title: 'Settings › Notifications: the Menu bar card', route: '#/settings/notifications',
    view: 'default', theme: 'light', width: 1440, scroll: '.ws-card:has(input[data-source])',
    checks: [
      { name: 'four switches', selector: 'input[data-source]', count: 4 },
      { name: 'all on', selector: 'input[data-source]:checked', count: 4 },
      { name: 'Needs fixing', selector: '.ws-mb-fixes .ws-mb-fix', min: 1 },
      { name: 'a Fix button', selector: '.ws-mb-fixes [data-fix]', min: 1 },
    ],
    covers: ['mb6.settings-card', 'mb6.fix-rows'],
  },
  {
    id: 'T28', step: [6], title: 'The menu bar: computed state, not a screenshot', route: null,
    view: null, theme: null, width: null, capture: false, action: { name: 'menuBar' },
    checks: [
      // The tour builds no tray (no icon in the user's menu bar), so "tray exists: false" is the
      // correct tour state; the count and the colour are the refresher's, applied and recounted.
      { name: 'tray exists: false (the tour builds no tray)', fact: 'tray', equals: false },
      { name: 'the applied view equals the recount', fact: 'appliedEqualsComputed', equals: true },
      { name: 'amber', fact: 'computed.amber', equals: true },
      { name: 'count > 0', fact: 'computed.count', min: 1 },
      { name: 'the menu’s row texts', fact: 'rowTexts.length', min: 1 },
    ],
    covers: ['mb6.tray-state', 'mb6.row-texts'],
  },

  // ---------------------------------------------------------------- step 7 (ai-routes-checks.mjs)
  {
    id: 'T29', step: [7], title: 'Settings › AI: routes, fallbacks and statuses', route: '#/settings/ai',
    view: 'default', theme: 'light', width: 1440, scroll: '[data-ai-route-row="triage"]',
    checks: [
      { name: 'the tab is labelled "AI"', selector: '.ws-settings-nav [data-tab="ai"]', exact: 'AI' },
      { name: 'group Replies', selector: 'th[scope=rowgroup]', text: 'Replies' },
      { name: 'group Summaries and notes', selector: 'th[scope=rowgroup]', text: 'Summaries and notes' },
      { name: 'group Automations', selector: 'th[scope=rowgroup]', text: 'Automations' },
      { name: 'a Fallback select per row', selector: '[data-ai-route-row] select[data-field="fallback"]', min: 3 },
      { name: 'chip Working', selector: '[data-ai-route-state="working"]', min: 1 },
      { name: 'chip Using fallback', selector: '[data-ai-route-row="triage"] [data-ai-route-state="fallback"]', count: 1 },
      { name: 'chip Not working', selector: '[data-ai-route-state="broken"]', min: 1 },
      { name: 'the Ollama card: Engine Ollama', selector: '[data-ai-profile="codemie:local-ollama"]', text: ['Engine', 'Ollama'] },
      { name: 'the Ollama card: Not running', selector: '[data-ai-profile="codemie:local-ollama"]', text: 'Not running' },
      { name: 'group Plugins', selector: 'th[scope=rowgroup]', text: 'Plugins' },
      { name: 'Digest’s own row (it agreed to Claude)', selector: '[data-ai-route-row="plugin:digest"]', count: 1, text: 'Digest' },
      { name: 'the CodeMie profile card’s Provider fact', selector: '[data-ai-profile="codemie:prod"]', text: 'Provider' },
      { name: '"Same as Default (…)" in a row’s Profile', selector: '[data-ai-route-row="mail_draft"] select[data-field="profile"] option', any: true, text: 'Same as Default (' },
    ],
    covers: ['pm7.ai-label', 'pm7.groups', 'pm7.fallback', 'pm7.status-chips', 'pm7.ollama', 'pm7.plugin-rows', 'pm7.provider-fact', 'pm7.same-as'],
  },
  {
    id: 'T30', step: [7], title: 'Settings › AI in Compact at 1000', route: '#/settings/ai',
    view: 'compact', theme: 'dark', width: 1000, scroll: '.ws-ai-routes',
    checks: [
      { name: 'the routes card', selector: '.ws-ai-routes' },
      { name: 'rows', selector: '[data-ai-route-row]', min: 3 },
      { name: 'two-line rows: the job above its selects', selector: '[data-ai-route-row="mail_draft"]', stacked: ['th.ws-ai-job', 'td.ws-ai-cell-profile'] },
    ],
    covers: ['pm7.narrow'],
  },

  // ---------------------------------------------------------------- plugin frames (plugins-checks.mjs)
  // Not in spec § 6: the seed's `hello` plugin draws its page in its sandboxed frame, so this
  // capture proves WebKit's snapshot composites plugin frames (Ruling 5; Task 5 review M5).
  {
    id: 'T31', step: [0], title: 'A plugin’s page in its frame', route: '#/p/hello/home',
    view: 'default', theme: 'dark', width: 1440, frame: 'iframe[data-plugin-frame="hello"]',
    action: { name: 'until', arg: 'iframe[data-plugin-frame="hello"][data-plugin-ready]' },
    checks: [
      { name: 'its frame told the window it is ready', selector: 'iframe[data-plugin-frame="hello"][data-plugin-ready]', count: 1 },
      { name: 'its frame lies over its slot (plugins-checks.mjs `framed`)', selector: 'iframe[data-plugin-frame="hello"]', over: '[data-plugin-slot="hello"]' },
      { name: 'its sidebar entry is current', selector: '.ws-plugin-nav [aria-current=page][data-plugin-id="hello"]', count: 1 },
    ],
    covers: ['m0.plugin-frame'],
  },
  ...MORE,
  ...VOICE_STOPS,
];
