// The real-app tour's coverage matrix (design docs/superpowers/specs/2026-11-24-real-app-tour-design.md
// § 7): every user-visible feature of rollout steps 0–7, each with the design it comes from. A
// stop of `script.js` names the features it shows in `covers`. The report colours each row:
// - `built`: green when a passing stop covers it, red with no stop or when all its stops failed;
// - `browser`: amber, for what the real app can't show without sending or without the desktop;
//   `browserCheck` names the browser check file and the check in it that covers the feature;
// - `planned`: grey, a later step's feature. That step makes it `built` and adds its stops in
//   the same change as its code.
//
// Pure data.

const ROLLOUT = 'docs/superpowers/specs/2026-11-22-workspace-next-rollout-design.md';
const COMPACT = 'docs/superpowers/specs/2026-11-22-compact-view-design.md';
const REPLY = 'docs/superpowers/specs/2026-11-22-reply-design.md';
const MEETINGS = 'docs/superpowers/specs/2026-11-23-meetings-view-design.md';
const TASKS = 'docs/superpowers/specs/2026-11-23-task-provider-design.md';
const TEMPLATES = 'docs/superpowers/specs/2026-11-24-create-tasks-templates-design.md';
const MENU_BAR = 'docs/superpowers/specs/2026-11-24-menu-bar-count-design.md';
const PROFILES = 'docs/superpowers/specs/2026-11-24-profiles-models-design.md';

export const FEATURES = [
  // step 0: the Connect marketplace
  { id: 'm0.builtin-first', step: 0, text: 'codemie is a built-in marketplace, listed before onetest, and neither can be removed', spec: `${ROLLOUT} § Order, step 0`, status: 'built' },
  { id: 'm0.plugin-frame', step: 0, text: 'An installed plugin’s page draws in its sandboxed frame, captured with the page', spec: 'docs/superpowers/specs/2026-11-24-real-app-tour-design.md Ruling 5', status: 'built' },
  { id: 'm0.not-fetched', step: 0, text: 'A built-in marketplace not fetched yet says so', spec: `${ROLLOUT} § Order, step 0`, status: 'built' },
  { id: 'm0.already-added', step: 0, text: 'Adding a built-in marketplace again is refused as already added', spec: `${ROLLOUT} § Order, step 0`, status: 'built' },

  // step 1: Compact view
  { id: 'c1.view-setting', step: 1, text: 'Settings › Appearance › View switches between Compact and Default', spec: COMPACT, status: 'built' },
  { id: 'c1.compact-sizes', step: 1, text: 'Compact uses the compact size tokens', spec: COMPACT, status: 'built' },
  { id: 'c1.default-unchanged', step: 1, text: 'Default keeps the list and the reading pane', spec: COMPACT, status: 'built' },
  { id: 'c1.compact-inbox', step: 1, text: 'Compact Inbox: one list of one-line rows, no reading pane', spec: COMPACT, status: 'built' },
  { id: 'c1.open-in-place', step: 1, text: 'Compact Inbox rows open in place, with the thread and the reply box', spec: COMPACT, status: 'built' },
  { id: 'c1.compact-today', step: 1, text: 'Compact Today: the date and summary line, no avatar, no greeting', spec: COMPACT, status: 'built' },
  { id: 'c1.today-menu', step: 1, text: 'Today’s toolbar lives in one ⋯ menu', spec: COMPACT, status: 'built' },
  { id: 'c1.hide-pages', step: 1, text: 'Settings › Layout hides a page from the menu', spec: COMPACT, status: 'built' },
  { id: 'c1.hidden-route', step: 1, text: 'A hidden page still opens by its route, greyed in the menu while open', spec: COMPACT, status: 'built' },
  { id: 'c1.last-switch', step: 1, text: 'The last visible page’s switch is disabled: "Keep one page in the menu."', spec: COMPACT, status: 'built' },

  // step 2: Reply
  { id: 'r2.named-send', step: 2, text: 'The primary names who it sends to ("Send to Jordan")', spec: REPLY, status: 'built' },
  { id: 'r2.mail-ellipsis', step: 2, text: 'A mail reply’s primary ends with … (it asks before sending)', spec: REPLY, status: 'built' },
  { id: 'r2.draft-link', step: 2, text: 'The empty box offers "Write a reply, or ✦ draft with AI"', spec: REPLY, status: 'built' },
  { id: 'r2.change-line', step: 2, text: 'With text in the box, "✦ Tell AI what to change" shows', spec: REPLY, status: 'built' },
  { id: 'r2.three-controls', step: 2, text: 'The reply bar has three controls: the primary, Snooze ▾ or Acknowledge, and ⋯', spec: REPLY, status: 'built' },
  { id: 'r2.more-menu', step: 2, text: '⋯ holds Done, Draft options…, Summarize, Open in Teams, Move to lane and Add a task', spec: REPLY, status: 'built' },
  { id: 'r2.acknowledge', step: 2, text: 'An unacknowledged critical message shows Acknowledge in Snooze’s place', spec: REPLY, status: 'built' },
  { id: 'r2.autosave', step: 2, text: 'The reply autosaves: "Saved on this device"', spec: REPLY, status: 'built' },
  { id: 'r2.copy-reply', step: 2, text: 'With sending not allowed, the primary is "Copy reply"', spec: REPLY, status: 'built' },
  { id: 'r2.own-mail', step: 2, text: 'Your own Outlook message has no reply box; Done is the primary', spec: REPLY, status: 'built' },
  { id: 'r2.group-label', step: 2, text: 'A group chat’s primary names the chat ("Send to Release crew")', spec: REPLY, status: 'built' },
  { id: 'r2.snooze-under-more', step: 2, text: 'When Acknowledge takes Snooze’s place, Snooze and its choices move under ⋯', spec: REPLY, status: 'built' },
  { id: 'r2.draft-options', step: 2, text: 'Draft options… opens the Draft with AI popover', spec: REPLY, status: 'built' },
  { id: 'r2.allow-actions', step: 2, text: 'Settings › Microsoft 365 › Allow actions: "Nothing is sent without your click."', spec: REPLY, status: 'built' },
  {
    id: 'r2.teams-send', step: 2, text: 'A Teams reply sends on click, once, and the status says "Sent to <name>."', spec: REPLY, status: 'browser',
    reason: 'It is a real send; the tour sends nothing (Rust refuses action_prepare and action_confirm).',
    browserCheck: { file: 'ui/test/browser/reply-checks.mjs', check: 'reply R4', set: 'reply' },
  },
  {
    id: 'r2.cmd-enter', step: 2, text: '⌘↩ sends only a touched reply, once, and never from inside a menu', spec: REPLY, status: 'browser',
    reason: 'It is a send from the keyboard; the tour sends nothing and types no keys.',
    browserCheck: { file: 'ui/test/browser/reply-checks.mjs', check: 'reply R7', set: 'reply' },
  },
  {
    id: 'r2.mail-confirm', step: 2, text: 'A mail reply asks in a confirm dialog before it sends', spec: REPLY, status: 'browser',
    reason: 'The confirm needs action_prepare, which reads Microsoft; the tour sends nothing.',
    browserCheck: { file: 'ui/test/browser/reply-checks.mjs', check: 'reply R6', set: 'reply' },
  },

  // step 3: Meetings default view
  { id: 'mv3.summary-first', step: 3, text: 'A meeting opens on its summary', spec: MEETINGS, status: 'built' },
  { id: 'mv3.strip', step: 3, text: 'The strip has one primary and ⋯', spec: MEETINGS, status: 'built' },
  { id: 'mv3.pinned-tabs', step: 3, text: 'Pinned summaries are tabs, in the pinned order', spec: MEETINGS, status: 'built' },
  { id: 'mv3.panes-behind-more', step: 3, text: 'Transcript, Notes and Advanced › Files sit behind ⋯', spec: MEETINGS, status: 'built' },
  { id: 'mv3.back-to-summary', step: 3, text: 'Another pane offers "← Back to summary"', spec: MEETINGS, status: 'built' },
  { id: 'mv3.action-items', step: 3, text: 'The action items column beside the summary', spec: MEETINGS, status: 'built' },
  { id: 'mv3.list-needs-you', step: 3, text: 'The meetings list leads with Needs you', spec: MEETINGS, status: 'built' },
  { id: 'mv3.with-header', step: 3, text: 'The header’s "with …" opens the people popover', spec: MEETINGS, status: 'built' },
  { id: 'mv3.make-tab', step: 3, text: 'A pinned tab without its document: "No <name> yet." and the primary "Make <name>"', spec: MEETINGS, status: 'built' },
  { id: 'mv3.review-tasks', step: 3, text: 'With the column off: "Review N tasks" and ⋯ › Action items', spec: MEETINGS, status: 'built' },
  { id: 'mv3.added-undo', step: 3, text: 'Adding a meeting’s tasks: "Added N to Todoist · Undo"', spec: MEETINGS, status: 'built' },
  { id: 'mv3.column-below', step: 3, text: 'In a narrow window the action items drop below the summary', spec: MEETINGS, status: 'built' },
  { id: 'mv3.pin-menus', step: 3, text: '"Pin a summary ▾" and a template’s "Pin as a summary tab"', spec: MEETINGS, status: 'built' },
  { id: 'mv3.plugin-minutes', step: 3, text: 'A plugin’s minutes as a pinned tab, as text', spec: MEETINGS, status: 'built' },
  { id: 'mv3.deep-links', step: 3, text: 'Old links (/notes, /tasks) open their panes', spec: MEETINGS, status: 'built' },
  { id: 'mv3.settings-open-on', step: 3, text: 'Settings: "When you open a meeting", the action items switch and the pinned list', spec: MEETINGS, status: 'built' },

  // step 4: Task provider and the Todoist plugin
  { id: 'tp4.by-date', step: 4, text: 'With a provider, Tasks shows By date and List (no Board): To review, Late, Today and the Later folds', spec: TASKS, status: 'built' },
  { id: 'tp4.check-with', step: 4, text: '"Check with <name>" rows with Nudge, Snooze ▾ and ⋯', spec: TASKS, status: 'built' },
  { id: 'tp4.looks-handled', step: 4, text: 'A task that looks handled says so', spec: TASKS, status: 'built' },
  { id: 'tp4.pending-parked', step: 4, text: 'A pending task has the "Not in Todoist yet" dot; a parked one says why', spec: TASKS, status: 'built' },
  { id: 'tp4.add-to-provider', step: 4, text: 'A meeting’s action items add to the provider ("Add 2 to Todoist")', spec: TASKS, status: 'built' },
  { id: 'tp4.today-widget', step: 4, text: 'Today’s Tasks widget shows the provider’s tasks, with no trash button', spec: TASKS, status: 'built' },
  { id: 'tp4.settings-radio', step: 4, text: 'Settings › Tasks: "Where your tasks live", Connect or Todoist', spec: TASKS, status: 'built' },
  { id: 'tp4.local-board', step: 4, text: 'On Connect, Tasks keeps Board, List and By date', spec: TASKS, status: 'built' },
  { id: 'tp4.accept-all', step: 4, text: 'Accept all moves every task to review onto the board', spec: TASKS, status: 'built' },
  { id: 'tp4.late-menu', step: 4, text: 'Late ⋯: Move all to Tomorrow or Monday, Pick date…, Done all', spec: TASKS, status: 'built' },
  { id: 'tp4.done-undo', step: 4, text: 'A task ticked done: "Marked 1 done · Undo"', spec: TASKS, status: 'built' },
  { id: 'tp4.header-sync', step: 4, text: 'The provider’s status line, and ⋯ › Sync now', spec: TASKS, status: 'built' },
  { id: 'tp4.token-fields', step: 4, text: 'Settings › Tasks: the provider’s API token, Project and App label fields', spec: TASKS, status: 'built' },
  { id: 'tp4.copy-dialog', step: 4, text: 'Choosing Todoist with open tasks in Connect asks "Copy your open tasks to Todoist?"', spec: TASKS, status: 'built' },
  { id: 'tp4.inbox-added', step: 4, text: 'Inbox › Add a task lands in Todoist', spec: TASKS, status: 'built' },
  { id: 'tp4.nudge', step: 4, text: 'Nudge fills the reply to the person, and sends nothing', spec: TASKS, status: 'built' },
  { id: 'tp4.removed-local', step: 4, text: 'Removing the provider’s plugin switches tasks back to Connect, with a toast', spec: TASKS, status: 'built' },
  { id: 'tp4.provides-tasks', step: 4, text: 'Settings › Plugins: "Provides tasks" on the provider’s row', spec: TASKS, status: 'built' },
  { id: 'tp4.delete-ask', step: 4, text: 'Deleting a provider’s task asks "Delete … in Todoist too?"', spec: TASKS, status: 'built' },
  {
    id: 'tp4.banners', step: 4, text: 'The provider banners for needs_token, off and failed', spec: TASKS, status: 'browser',
    reason: 'The seed has one provider state (ready); the other states are the browser run’s.',
    browserCheck: { file: 'ui/test/browser/tasks-provider-checks.mjs', check: 'tasks-provider P8', set: 'tasks-provider' },
  },

  // step 5: Create-tasks delivery and the templates
  { id: 'ct5.gallery', step: 5, text: 'The templates gallery leads with the five habit templates, in order', spec: TEMPLATES, status: 'built' },
  { id: 'ct5.editor-tasks', step: 5, text: 'The editor’s Deliver offers "Tasks in Todoist"', spec: TEMPLATES, status: 'built' },
  { id: 'ct5.run-log-tasks', step: 5, text: 'A run says what tasks it made ("Tasks: 2 made in Todoist, 1 already there")', spec: TEMPLATES, status: 'built' },
  { id: 'ct5.today-made', step: 5, text: 'Today’s automation card links "Made 2 tasks in Todoist ›"', spec: TEMPLATES, status: 'built' },
  { id: 'ct5.read-box', step: 5, text: 'The editor’s Read box offers "Messages since the last run"', spec: TEMPLATES, status: 'built' },
  { id: 'ct5.summary-editor', step: 5, text: 'The summary automation’s editor: Make (Formal summary) and Wishes', spec: TEMPLATES, status: 'built' },
  { id: 'ct5.deliver-chips', step: 5, text: 'Where an automation delivers: the list row and the gallery card’s sentence', spec: TEMPLATES, status: 'built' },
  { id: 'ct5.run-log-details', step: 5, text: 'The run log’s task links, "Looks handled: 1 task flagged" and "Formal summary queued for …"', spec: TEMPLATES, status: 'built' },
  { id: 'ct5.formal-template', step: 5, text: 'The Formal summary note template', spec: TEMPLATES, status: 'built' },

  // step 6: Menu-bar count
  { id: 'mb6.settings-card', step: 6, text: 'Settings › Notifications: the Menu bar card with four switches', spec: MENU_BAR, status: 'built' },
  { id: 'mb6.fix-rows', step: 6, text: '"Needs fixing" rows with Fix', spec: MENU_BAR, status: 'built' },
  { id: 'mb6.tray-state', step: 6, text: 'The menu bar’s count and amber, applied as recounted', spec: MENU_BAR, status: 'built' },
  { id: 'mb6.row-texts', step: 6, text: 'The tray menu’s row texts', spec: MENU_BAR, status: 'built' },
  {
    id: 'mb6.row-click', step: 6, text: 'A tray row’s click opens its place in the window', spec: MENU_BAR, status: 'browser',
    reason: 'It is a click in the macOS menu bar; the tour builds no tray and touches no desktop.',
    browserCheck: { file: 'ui/test/browser/menu-bar-checks.mjs', check: 'menu-bar M6', set: 'menu-bar' },
  },
  {
    id: 'mb6.seen-marks', step: 6, text: 'Opening what was new marks it seen', spec: MENU_BAR, status: 'browser',
    reason: 'Marks are sent only while the window has focus; the tour’s window never takes focus.',
    browserCheck: { file: 'ui/test/browser/menu-bar-checks.mjs', check: 'menu-bar M5', set: 'menu-bar' },
  },

  // step 7: Profiles and models
  { id: 'pm7.ai-label', step: 7, text: 'The Settings tab is labelled "AI"', spec: PROFILES, status: 'built' },
  { id: 'pm7.groups', step: 7, text: 'Routes grouped Replies, Summaries and notes, Automations, Plugins', spec: PROFILES, status: 'built' },
  { id: 'pm7.fallback', step: 7, text: 'A Fallback select per row', spec: PROFILES, status: 'built' },
  { id: 'pm7.status-chips', step: 7, text: 'Status chips Working, Using fallback, Not working', spec: PROFILES, status: 'built' },
  { id: 'pm7.ollama', step: 7, text: 'The Ollama profile card: Engine Ollama, Not running', spec: PROFILES, status: 'built' },
  { id: 'pm7.narrow', step: 7, text: 'Settings › AI fits Compact at 1000 with no overflow', spec: PROFILES, status: 'built' },
  { id: 'pm7.run-fallback', step: 7, text: 'A run that fell back says what it ran on', spec: PROFILES, status: 'built' },
  { id: 'pm7.plugin-rows', step: 7, text: 'One Settings › AI row per plugin that agreed to Claude', spec: PROFILES, status: 'built' },
  { id: 'pm7.provider-fact', step: 7, text: 'A CodeMie profile card’s Provider fact', spec: PROFILES, status: 'built' },
  { id: 'pm7.same-as', step: 7, text: 'A row’s "Same as <group> (…)" choice', spec: PROFILES, status: 'built' },
  { id: 'pm7.chooser', step: 7, text: 'The first-use chooser offers the ready profiles, and leaves out one that is not running', spec: PROFILES, status: 'built' },
  {
    id: 'pm7.chooser-ollama', step: 7, text: 'The first-use chooser’s Ollama line ("Ollama · <model>") for a running Ollama', spec: PROFILES, status: 'browser',
    reason: 'A seed-state exception to ruling 12 (controller ruling, Task 6 fix round 2): it needs Ollama running, and the seed’s Ollama profile is not_running (spec § 4), as the banners need provider states the seed doesn’t hold.',
    browserCheck: { file: 'ui/test/browser/ai-routes-checks.mjs', check: 'ai-routes R5', set: 'ai-routes' },
  },
  { id: 'pm7.editor-default', step: 7, text: 'The automation editor’s "Default · <row> (…)" profile line', spec: PROFILES, status: 'built' },

  // planned
  { id: 's8.reply-voice', step: 8, text: 'Reply in the user’s voice', spec: `${ROLLOUT} § Order, step 8`, status: 'planned' },
  { id: 's9.ask-inline', step: 9, text: 'Ask, inline in the window', spec: `${ROLLOUT} § Order, step 9`, status: 'planned' },
];
