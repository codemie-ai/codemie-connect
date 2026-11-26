// The real-app tour's coverage matrix (design docs/superpowers/specs/2026-11-24-real-app-tour-design.md
// § 7): every user-visible feature of rollout steps 0–9, each with the design it comes from. A
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
const VOICE = 'docs/superpowers/specs/2026-11-25-reply-voice-design.md';
const VOICE_CHECKS = 'ui/test/browser/voice-checks.mjs';
const ASK = 'docs/superpowers/specs/2026-11-26-ask-capture-design.md';
const ASK_CHECKS = 'ui/test/browser/ask-checks.mjs';

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

  // step 8: Reply in the user's voice
  { id: 'v8.settings-tab', step: 8, text: 'Settings has a "Your voice" tab', spec: `${VOICE} § 5`, status: 'built' },
  { id: 'v8.provider-choice', step: 8, text: '"Where your voice comes from": Off or Knowledge, with its state line', spec: `${VOICE} § 5`, status: 'built' },
  { id: 'v8.privacy-line', step: 8, text: 'The privacy line: a copy on this Mac, facts never kept, only to the replies’ AI profile', spec: `${VOICE} § Copy`, status: 'built' },
  { id: 'v8.facts-setting', step: 8, text: '"Add facts from Knowledge": the names and codes, never the message', spec: `${VOICE} § 10`, status: 'built' },
  { id: 'v8.style-card', step: 8, text: 'The style card and what it was built from', spec: `${VOICE} § 5`, status: 'built' },
  { id: 'v8.style-head', step: 8, text: 'Your own page’s preferences head the style card, read-only', spec: `${VOICE} § 5`, status: 'built' },
  { id: 'v8.style-edit', step: 8, text: 'Edit opens the style card’s text without its head, with Save and Cancel', spec: `${VOICE} § 5`, status: 'built' },
  { id: 'v8.rules', step: 8, text: 'The instructions list', spec: `${VOICE} § 5`, status: 'built' },
  { id: 'v8.rule-scopes', step: 8, text: 'Each instruction names what it applies to: a chat, a domain, no profile, a channel', spec: `${VOICE} § 5`, status: 'built' },
  { id: 'v8.people', step: 8, text: 'People and a person’s profile: how to write to them and about them', spec: `${VOICE} § 5`, status: 'built' },
  { id: 'v8.teams-only-person', step: 8, text: 'A person known only by a Teams id says "Teams only"', spec: `${VOICE} § 5`, status: 'built' },
  { id: 'v8.off', step: 8, text: 'Off keeps Connect’s copy and says when it is from', spec: `${VOICE} § 6`, status: 'built' },
  { id: 'v8.delete-ask', step: 8, text: 'Delete Connect’s copy asks first, with Cancel focused', spec: `${VOICE} § 6`, status: 'built' },
  { id: 'v8.draft-voice', step: 8, text: 'A draft in your voice says " · in your voice" and Context names the voice', spec: `${VOICE} § 4`, status: 'built' },
  { id: 'v8.draft-examples', step: 8, text: 'Context counts the earlier messages used', spec: `${VOICE} § 4`, status: 'built' },
  { id: 'v8.draft-facts', step: 8, text: 'Context lists the facts’ page titles', spec: `${VOICE} § 10`, status: 'built' },
  { id: 'v8.background-draft', step: 8, text: 'An automation’s draft from Connect’s copy says so, and that no facts came in time', spec: `${VOICE} § 4`, status: 'built' },
  { id: 'v8.import-preview', step: 8, text: 'Import from skills: the preview’s rows, where each came from and what a long skill kept', spec: `${VOICE} § 11`, status: 'built' },
  { id: 'v8.import-skipped', step: 8, text: 'Import from skills: what was not imported and why, with Shorten with AI offered', spec: `${VOICE} § 11`, status: 'built' },
  { id: 'v8.compact', step: 8, text: 'Settings › Your voice in Compact at 1000', spec: `${VOICE} § 5`, status: 'built' },
  {
    id: 'v8.refresh', step: 8, text: 'Refresh now asks the provider for a new copy', spec: `${VOICE} § 5`, status: 'browser',
    reason: 'Its control is `voice-refresh`, which the deny-list’s `refresh` refuses.',
    browserCheck: { file: VOICE_CHECKS, check: 'voice V5', set: 'voice' },
  },
  {
    id: 'v8.save-through-provider', step: 8, text: 'A style card or instruction edit saves through the provider, one write each', spec: `${VOICE} § 5`, status: 'browser',
    reason: 'A save is a plugin call; the tour calls no plugin.',
    browserCheck: { file: VOICE_CHECKS, check: 'voice V3', set: 'voice' },
  },
  {
    id: 'v8.sheet-line', step: 8, text: 'Installing a reply-context plugin shows the role’s sheet line', spec: `${VOICE} § Copy`, status: 'browser',
    reason: 'It is an install; the tour installs nothing.',
    browserCheck: { file: VOICE_CHECKS, check: 'voice V7', set: 'voice' },
  },
  {
    id: 'v8.import-pick', step: 8, text: 'Import from skills… picks the folder, then scans it once', spec: `${VOICE} § 11`, status: 'browser',
    reason: 'The folder picker opens on the desktop; the tour opens no picker.',
    browserCheck: { file: VOICE_CHECKS, check: 'voice V10', set: 'voice' },
  },
  {
    id: 'v8.import-distil', step: 8, text: 'Shorten with AI rewrites a skill’s rows', spec: `${VOICE} § 11`, status: 'browser',
    reason: 'It is an AI run; the tour runs no AI.',
    browserCheck: { file: VOICE_CHECKS, check: 'voice V11', set: 'voice' },
  },
  {
    id: 'v8.import-save', step: 8, text: 'Add N instructions saves the ticked rows in one write', spec: `${VOICE} § 11`, status: 'browser',
    reason: 'Saving goes through the provider; the tour calls no plugin.',
    browserCheck: { file: VOICE_CHECKS, check: 'voice V12', set: 'voice' },
  },

  // step 9: Ask and quick capture
  { id: 'a9.field', step: 9, text: 'The Ask field first in the menu, and its About chip', spec: `${ASK} § 2`, status: 'built' },
  { id: 'a9.cmd-k', step: 9, text: '⌘K focuses the field, with Recent', spec: `${ASK} § 11`, status: 'built' },
  { id: 'a9.thread', step: 9, text: 'The Ask page: a thread’s turns, cite marks and chips, actions, the meta line and the follow-up box', spec: `${ASK} § 7`, status: 'built' },
  { id: 'a9.compact', step: 9, text: 'The Ask page in Compact: one column and History ▾', spec: `${ASK} § 12`, status: 'built' },
  { id: 'a9.add-as-task', step: 9, text: '+ Add as task fills quick capture with the action’s words and due date', spec: `${ASK} § 8`, status: 'built' },
  { id: 'a9.open-cite', step: 9, text: 'A cite chip opens its record, with "← Back to Ask"', spec: `${ASK} § 8`, status: 'built' },
  { id: 'a9.failed-stopped', step: 9, text: 'A failed turn (Try again, Check Settings › AI) and a stopped turn (Ask again)', spec: `${ASK} § 7`, status: 'built' },
  { id: 'a9.answering', step: 9, text: 'Answering with its profile, Stop shown, the field reading "Answering…"', spec: `${ASK} § 7`, status: 'built' },
  { id: 'a9.settings-ai', step: 9, text: 'Settings › AI’s Ask group and row', spec: `${ASK} § 6`, status: 'built' },
  { id: 'a9.shortcuts-switch', step: 9, text: 'Settings › Layout: ⌘K, ⌘N and ⌘. in the shortcuts, and "Ask in the menu"', spec: `${ASK} § 11`, status: 'built' },
  { id: 'a9.rail', step: 9, text: 'The menu as a rail: its ✦ Ask button', spec: `${ASK} § Copy`, status: 'built' },
  { id: 'c9.cmd-n', step: 9, text: '⌘N opens quick capture', spec: `${ASK} § 9`, status: 'built' },
  { id: 'c9.due', step: 9, text: 'Quick capture reads the due date and shows it', spec: `${ASK} § 9`, status: 'built' },
  { id: 'c9.source', step: 9, text: 'Quick capture’s source chip: the selected message', spec: `${ASK} § 9`, status: 'built' },
  { id: 'c9.task-undo', step: 9, text: 'Add saves the task through the provider: "Added to Todoist · Undo"', spec: `${ASK} § 9`, status: 'built' },
  { id: 'c9.note', step: 9, text: 'Note adds a line to Notes on Today', spec: `${ASK} § 10`, status: 'built' },
  {
    id: 'a9.answer-follow-up', step: 9, text: 'An answer arrives with its cites and actions, then a follow-up', spec: `${ASK} § 7`, status: 'browser',
    reason: 'An answer is an AI run, and the tour’s job loop is off; the tour never asks.',
    browserCheck: { file: ASK_CHECKS, check: 'ask Q4', set: 'ask' },
  },
  {
    id: 'a9.stop', step: 9, text: 'Stop (and ⌘.) stops a running answer', spec: `${ASK} § 7`, status: 'browser',
    reason: 'Nothing runs on the tour to stop: the seeded answer waits on a job no loop claims.',
    browserCheck: { file: ASK_CHECKS, check: 'ask Q5', set: 'ask' },
  },
  {
    id: 'a9.draft-reply', step: 9, text: '✦ Draft a reply opens the message and starts a draft with the action’s hint', spec: `${ASK} § 8`, status: 'browser',
    reason: 'A draft is an AI run; the tour runs no AI.',
    browserCheck: { file: ASK_CHECKS, check: 'ask Q6', set: 'ask' },
  },
  {
    id: 'a9.chooser', step: 9, text: 'Ask with no profile chosen opens the chooser, then asks again', spec: `${ASK} § 7`, status: 'browser',
    reason: 'It asks again once a profile is chosen; the tour never asks.',
    browserCheck: { file: ASK_CHECKS, check: 'ask Q5', set: 'ask' },
  },
  {
    id: 'a9.delete-clear', step: 9, text: 'History: Delete a thread, and Clear history', spec: `${ASK} § 7`, status: 'browser',
    reason: 'Both delete; the deny-list refuses deletes.',
    browserCheck: { file: ASK_CHECKS, check: 'ask Q7', set: 'ask' },
  },
];
