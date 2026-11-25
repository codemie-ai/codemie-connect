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
    ],
    covers: ['m0.builtin-first', 'm0.not-fetched'],
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
      { name: 'the box holds the text', selector: `${crow(SEED_IDS.teams1to1)} #reply-body` },
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
    ],
    covers: ['tp4.settings-radio'],
  },
  {
    id: 'T23', step: [4], title: 'Compact Tasks on Connect: the Board', route: '#/tasks',
    view: 'compact', theme: 'light', width: 1440, action: { name: 'setProvider', arg: 'local' }, after: { name: 'setProvider', arg: 'plugin:todoist' },
    checks: [
      { name: 'Board, List and By date', selector: '.ws-tasks-heading [data-action="tasks-view"]', text: ['Board', 'List', 'By date'], order: true },
      { name: 'the board', selector: '.ws-task-board' },
    ],
    covers: ['tp4.local-board'],
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
    ],
    covers: ['ct5.gallery'],
  },
  {
    id: 'T25', step: [5], title: 'Automations: Inbox triage from its template', route: '#/automations/templates',
    view: 'default', theme: 'light', width: 1440, action: { name: 'useTemplate', arg: 'inbox-triage' }, after: { name: 'cancelModal' },
    scroll: '.ws-modal[open] #auto-deliver',
    checks: [
      { name: 'the editor is open', selector: '.ws-modal[open] #automation-editor', count: 1 },
      { name: '"Tasks in Todoist" in Deliver', selector: '.ws-auto-switch:has([data-deliver="createTasks"]) .ws-switch-label', exact: 'Tasks in Todoist' },
      { name: 'it is on', selector: '[data-deliver="createTasks"]:checked', count: 1 },
    ],
    covers: ['ct5.editor-tasks'],
  },
  {
    id: 'T26', step: [5, 7], title: 'Compact Run log: the triage run unfolded', route: '#/automations/runs',
    view: 'compact', theme: 'dark', width: 1440, action: { name: 'unfoldRun', arg: SEED_IDS.triageRun },
    checks: [
      { name: '"Tasks: 2 made in Todoist, 1 already there"', selector: `#run-${SEED_IDS.triageRun}`, text: 'Tasks: 2 made in Todoist, 1 already there' },
      { name: 'the fallback line', selector: `#run-${SEED_IDS.fallbackRun}`, text: 'Ran on' },
    ],
    covers: ['ct5.run-log-tasks', 'pm7.run-fallback'],
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
    ],
    covers: ['mb6.tray-state'],
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
    ],
    covers: ['pm7.ai-label', 'pm7.groups', 'pm7.fallback', 'pm7.status-chips', 'pm7.ollama'],
  },
  {
    id: 'T30', step: [7], title: 'Settings › AI in Compact at 1000', route: '#/settings/ai',
    view: 'compact', theme: 'dark', width: 1000, scroll: '.ws-ai-routes',
    checks: [
      { name: 'the routes card', selector: '.ws-ai-routes' },
      { name: 'rows', selector: '[data-ai-route-row]', min: 3 },
    ],
    covers: ['pm7.narrow'],
  },

  // ---------------------------------------------------------------- plugin frames (plugins-checks.mjs)
  // Not in spec § 6: the seed's `hello` plugin draws its page in its sandboxed frame, so this
  // capture proves WebKit's snapshot composites plugin frames (Ruling 5; Task 5 review M5).
  {
    id: 'T31', step: [0], title: 'A plugin’s page in its frame', route: '#/p/hello/home',
    view: 'default', theme: 'dark', width: 1440,
    checks: [
      { name: 'its frame over the content area', selector: 'iframe[data-plugin-frame="hello"]', count: 1 },
      { name: 'its sidebar entry is current', selector: '.ws-plugin-nav [aria-current=page][data-plugin-id="hello"]', count: 1 },
    ],
    covers: ['m0.plugin-frame'],
  },
];
