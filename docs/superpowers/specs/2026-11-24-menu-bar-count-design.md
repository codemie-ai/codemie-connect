# Menu-bar count · design

**Status:** written on 2026-11-24 from the rollout overview's decisions and the code. This is step 6 of `2026-11-22-workspace-next-rollout-design.md`. Decisions the overview leaves open are ruled on below, under "Rulings".
**Builds on:**
- the tray as it is today: `src-tauri/src/workspace/mod.rs::setup_tray` (a template icon, `icons/tray-template.png`, 36 × 36, tinted by AppKit; a menu with "Open CodeMie Connect" and "Quit CodeMie Connect"; no id, no title);
- the sidebar counts in `ui/workspace/shell.js::renderShell` (Inbox: `attentionMessages`, Tasks: To review, Meetings: `meetingCounts` process + attention) and the Settings dot;
- step 4, `2026-11-23-task-provider-design.md`: the snapshot's `taskProvider` (`state` one of `local`, `ready`, `syncing`, `offline`, `rate_limited`, `needs_token`, `off`, `failed`; `parked`, `pending`), `tasks::active`, `tasks::is_mine`, `tasks::is_open`;
- step 5, `2026-11-24-create-tasks-templates-design.md`: automation runs (`automation_run` records with `status` `ok | failed | skipped | cancelled`, `delivered`), reply tasks made by Inbox triage, the Formal summary as a meeting document;
- `Core::emit("workspace:changed")`, sent after every operation, every finished job and once a minute by the background loop.

**The user's words:** "as for menu-bar, it should be configurable - by default, only needs reply" and "menu icon shows new items".

## Intent

Connect lives in the menu bar while its window is hidden, but the icon says nothing. The user wants it to show how many things wait for them, the way the reference app's menu-bar badge does, counting only messages that need a reply unless they choose more. When something is broken and only they can fix it (a sign-in, a token, a failing automation), the icon turns amber, so a quiet count is never mistaken for "all fine".

## Goals

- **A number beside the menu-bar icon**: the sum of the sources the user chose; nothing when it is zero.
- **Sources:** messages that need a reply (on by default), tasks due today or late, meetings with new notes, automation results. Settings › Notifications chooses them.
- **Amber** when something needs fixing, whatever is chosen.
- **The menu says what the number is made of**: a row per counted source and per fix, each opening the window where it is handled.
- **Correct with the window hidden**: the count is computed natively from the database, after each change and once a minute.
- **Compact and Default** draw the same Settings markup; the menu bar is the same in both.

## Non-goals

- A Dock badge, a sound or a notification for the count.
- Per-source colours or several numbers in the menu bar.
- A "new" dot on Meetings or Automations rows inside the window.
- Changing the sidebar counts.
- Real-desktop screenshots of the menu bar. They wait for the one announced pass at the end of the rollout.

## Anti-goals

- **A count that disagrees with Inbox.** "Needs reply" in the menu bar is Inbox's own number.
- **A count stuck after the user dealt with it.** Every source clears by the same action that clears it in the window, within a second of the change.
- **A flood on upgrade.** Notes and results made before this step never count as new.
- **Private text in the menu bar.** The title is a number only; names and subjects appear only in the menu and the tooltip, which only the user sees, and never in the status smoke's report.
- **Writes the user didn't cause.** Marking something seen happens only when the window actually showed it, in front, focused.
- **Silencing breakage.** Amber cannot be turned off; it goes away when the problem is fixed.

## Approaches considered

| Approach | Trade-off | Decision |
|---|---|---|
| **A. Native count, native tray.** A `menu_bar` module computes the count from the snapshot data after each `workspace:changed` and sets the tray; the snapshot carries the same result for Settings. | One rule in one place; works with the window hidden or never shown; Rust unit tests can assert the title and the icon. Needs a Rust port of Inbox's reply rule, pinned by a parity fixture. | **Chosen** |
| B. The window computes and sets the tray through a new Tauri command. | Reuses the JS selectors, but a hidden webview's timers are throttled, nothing updates while the window is not drawing, and it adds a command the caller checks must guard. | Rejected: anti-goal "count stuck" |
| C. The Dock badge. | Built into macOS, but the user asked for the menu bar, and Connect hides its Dock icon with the window in background mode. | Rejected |

## Design

### 1. Settings (`menuBar`)

`Settings` gains `menu_bar: MenuBarSettings` (serde camelCase `menuBar`, `#[serde(default)]` so older settings read):

| Field | Default | Meaning |
|---|---|---|
| `replies` | `true` | count messages that need a reply |
| `tasks` | `false` | count my open tasks due today or late |
| `meetings` | `false` | count meetings with new notes |
| `automations` | `false` | count automation results |

`settings_update {menuBar: {tasks: true}}` merges the fields given (`MenuBarSettings::apply`, a non-boolean is refused as `validation` "Choose on or off.", field `menuBar`), like `meetings`.

### 2. Seen marks

A bookkeeping record (kind `menu_bar_seen`, id `personal`, written with `put_record_unversioned`, not in `snapshot.records`):

```json
{"since": 1795003200, "automations": 1795003500, "meetings": {"m-ready": 1795003400}}
```

- `since`: written the first time Core opens with this step (now). Nothing made before it is new.
- `automations`: the last time the user saw automation results.
- `meetings`: per meeting, the last time the user saw it. An entry whose meeting record no longer exists is dropped on the next write.

They change through:
- a new workspace operation `menu_bar_seen {meetingId}` or `{automations: true}` (sent through the store's `mutate`; answers `{seen: true}`; an unknown meeting is `not_found`); the window sends it only as §6 says;
- `meeting_doc` and `meeting_set` stamp the meeting seen in the same request (the user is in that meeting, editing or choosing).

### 3. What each source counts

All four are computed for the active workspace (`personal`) every time; the settings only choose which are added up. `now` is the workspace time zone's.

| Source | Counts | Clears when |
|---|---|---|
| **Needs reply** (`replies`) | Inbox's number exactly: unacknowledged critical messages, then Needs reply messages, one row per Teams chat, a chat with a critical message represented by it; not archived, not snoozed, not deleted (`selectors.js::attentionMessages`, ported as `menu_bar::attention_rows`). | the message leaves Needs reply or Critical, is acknowledged, archived, snoozed or deleted, as in Inbox. Reading it does not clear it. |
| **Tasks due or late** (`tasks`) | my open tasks (To do, In progress, Waiting; `tasks::is_open`) of the active provider (`tasks::active`) whose `due` is today or earlier, owned by me (`tasks::is_mine`, the 09:00 reminder's rule). When `replies` is also counted, tasks of kind `reply` are left out (their message is already counted). | done, dismissed, moved to a later day, or given to someone else. A task becomes late at midnight within a minute (the loop's minute emit). |
| **Meetings with new notes** (`meetings`) | meetings with a document whose `updatedAt` is after `max(seen.meetings[id], seen.since)` and within the last 7 days. | the user opens that meeting in the window (§6), edits or chooses in it (§2), or 7 days pass. |
| **Automation results** (`automations`) | `automation_run` records with `status: "ok"` and a non-empty `delivered` that is not only `["meeting_summary"]`, whose record `updatedAt` is after `max(seen.automations, seen.since)` and within the last 7 days. | the user looks at Automations, or at Today while it has the Automation results card (§6). |

### 4. Needs fixing (amber)

Amber is on while any of these holds; each is one fix row `{id, text, open}`:

| Fix | When | Text | Opens |
|---|---|---|---|
| `microsoft` | the connection exists and its status is neither `connected` nor `disconnected` (the "Sign in again" pill) | "Microsoft 365 needs you to sign in again." | Settings › Microsoft 365 |
| `tasks-token` | `taskProvider.state == "needs_token"` | "<Provider> needs your API token." | Settings › Tasks |
| `tasks-plugin` | `taskProvider.state == "failed"` | "The <Provider> plugin didn't load." | Settings › Tasks |
| `tasks-parked` | `taskProvider.parked > 0` | "<Provider> refused <n> task change(s)." | Tasks |
| `automation:<id>` | an enabled automation's newest run has `status: "failed"`, unless it failed because Connect was offline or something was rate limited (`error.code` `offline`, `throttled` or `rate_limited`, or `error.class` `rate_limited`) | "<Automation name> failed: <error message>" | Automations › Run log, that run |
| `meetings-folder` | any meeting's `saveError.code == "folder_unwritable"` | "Connect can't write to the meetings folder." | Settings › Transcripts & folders |

`offline`, `rate_limited`, `syncing` and `off` are not fixes (they pass by themselves or were chosen), and neither is an automation run that failed for one of those reasons. A fix clears when its condition stops holding: a new sign-in, a saved token, Try again or Discard change, a later `ok` run or the automation turned off, a writable folder.

### 5. The menu bar

`menu_bar::compute(snapshot, task_provider, seen, now) -> MenuBar` is pure; the snapshot gains it as `menuBar`:

```json
{"count": 3, "label": "3", "amber": true,
 "sources": {"replies": 2, "tasks": 1, "meetings": 0, "automations": 4},
 "counted": ["replies", "tasks"],
 "fixes": [{"id": "tasks-token", "text": "Todoist needs your API token.", "open": {"route": "settings", "tab": "meetings-tasks"}}],
 "newMeetings": [], "tooltip": "CodeMie Connect · 2 messages need a reply, 1 task due or late · Needs fixing: Todoist needs your API token."}
```

- `count` sums the counted sources; `label` is `""` at zero, the number up to 99, `"99+"` above.
- **macOS:** the tray's title is `label` (no title at zero). The icon stays the template icon; amber swaps it for the same glyph recoloured amber `#F5A623` (alpha kept, `icon_as_template(false)`), made at runtime from `tray-template.png`, so no new asset ships. The title stays in the system text colour beside it.
- **Windows:** no title (the tray has none); the tooltip carries the count; amber uses the same amber glyph.
- **Tooltip:** "CodeMie Connect" at zero; otherwise "CodeMie Connect · " and the counted rows joined with ", "; amber appends " · Needs fixing: " and the first fix's text.
- **The menu:** a row per counted source with a non-zero count ("2 messages need a reply", "1 task due or late", "1 meeting with new notes", "4 automation results"), then the fix rows (at most 3, then "and <n> more"), a separator, then "Open CodeMie Connect" and "Quit CodeMie Connect" as today. Zero and no fixes: only the last two.
- **A row's click** shows the window and emits `workspace:notification-open` with `{route, tab?, lane?, meetingId?, runId?, automationId?}`: replies `{route: "inbox", lane: "reply"}`; tasks `{route: "tasks"}`; meetings the meeting when exactly one is new (`{meetingId}`), else `{route: "meetings"}`; automations `{route: "automations"}`; a fix its `open`.
- **When it updates:** `Core::emit("workspace:changed")` wakes a refresher task (a `tokio::sync::Notify`) that waits 300 ms for more changes, computes, and applies to the tray only when the view differs from the last one applied. It runs once at start. It takes the repository guard only while computing, never across an `.await`, and never from inside `emit` (callers of `emit` may hold a guard).
- The tray gets an id (`TrayIconBuilder::with_id("main")`). Applying goes through a `TraySink` trait: the app's `AppTray` sets title, icon, tooltip and menu; tests use `FakeTray`, which records each applied view.
- Storage unavailable (no Core): the tray stays as today.
- Quiet hours and Focus don't change the count. Hidden pages don't either: the menu bar is its own place.

### 6. What the window does

- **Settings › Notifications** gains a second card, "Menu bar" (below "Desktop notifications"), drawn from `snapshot.menuBar` and `settings.menuBar` (Copy below). Each switch sends `settings_update {menuBar: {<source>: checked}}`; on failure the switch goes back.
- **Seen.** After each render, while the document is visible and focused and nothing is being typed in (`editing()` false) and no dialog is open, a pure `seenToSend` decides:
  - an open meeting whose id is in `menuBar.newMeetings` → `menu_bar_seen {meetingId}`;
  - every meeting in `menuBar.newMeetings` that the user hid (`codemie.meetings.hidden`, ids or series) → `menu_bar_seen {meetingId}` (hidden meetings never count for long);
  - route `automations`, or route `today` with the `automations` card on the grid, while `menuBar.sources.automations > 0` → `menu_bar_seen {automations: true}`.
  Each mark is sent at most once per snapshot revision; a failure is ignored (the next render tries again).
- **Opening from the menu:** `openNotification` gains a general `route` branch: `inbox` (with `lane`), `meetings`, `automations` (Run log, or the run when `runId` is given, as today), `settings` (with `tab`), beside the existing `tasks`, `meetingId`, `itemId` and `eventId` cases.

### 7. Native operations and shapes

- New operation `menu_bar_seen` (`Operation::MenuBarSeen`), handled in `Core::request` like the others (it reserves a revision; the window sends it rarely).
- `settings_update` accepts `menuBar`.
- Snapshot gains `menuBar` (`Snapshot.menu_bar: Value`, filled by `Core` for the window's snapshot like `taskProvider`, `Value::Null` elsewhere).
- No new Tauri command.
- Contract fixtures, new: `menu-bar-states.json` (the snapshot's `menuBar` for `zero`, `replies`, `several`, `capped`, `amberOnly`, `amberWithCount`, `nothingChosen`), written from real `compute` calls over a test core; `menu-bar-reply-cases.json` (message records and the native `replies` count, which the JS test checks against `attentionMessages`). The UI's `buildSnapshot` gains `settings.menuBar` with the defaults and `menuBar` from `menu-bar-states.json`'s `replies` state.

### 8. Status smoke

`CODEMIE_STATUS_SMOKE=status` adds `menuBar` to Rust's facts: whether the tray with id `main` exists, the last view applied (`title`, `amber`, the tooltip's length, the menu's row count) and the freshly computed `count`, `label`, `amber`. The report fails when the tray is missing or the applied title or amber differ from the computed ones (after one forced refresh). No tooltip or row text enters the report.

## Copy

- **Card:** title "Menu bar". Hint: "The number beside CodeMie Connect in the menu bar. Choose what it counts."
- **Switches** (`settingRow`):
  - "Messages that need a reply" — "Needs reply and unacknowledged critical messages, as Inbox counts them.";
  - "Tasks due today or late" — "Your open tasks in <Provider>." (`taskProvider.name`, else "Connect");
  - "Meetings with new notes" — "Notes made since you last opened the meeting.";
  - "Automation results" — "Results since you last looked at Today or Automations."
- **Status line** (`role="status"`): "Now: <n> — <rows joined with ", ">", "Now: nothing to count.", or with nothing chosen "Nothing is counted. The icon still turns amber when something needs fixing."
- **Fixes:** "Needs fixing" followed by each fix's text as a link button "Fix" that opens its place.
- **Footer hint:** "Amber means something needs fixing, such as a sign-in or a plugin token. It can't be turned off."
- **Menu rows:** "<n> message needs a reply" / "<n> messages need a reply", "<n> task due or late" / "<n> tasks due or late", "<n> meeting with new notes" / "<n> meetings with new notes", "<n> automation result" / "<n> automation results", "and <n> more".
- **Fix texts:** as in §4. **Tab description** for Notifications: "Desktop reminders, critical alerts, quiet hours and the menu-bar count."

## Accessibility

- The four switches use `toggle` with `aria-label` equal to their title and the hint as `aria-describedby`.
- The status line is `role="status"` (polite); the fixes list is a `ul` with real buttons named "Fix: <text>".
- Amber is never the only signal: the menu and the tooltip say "Needs fixing" in words, and so does the card.
- Text stays at or above the step-1 minimum in Compact; focus rings unchanged.

## Rulings

Each ruling says what it costs if it is wrong.

1. **The count is computed natively and the tray is set natively; the snapshot carries the same result.** *If wrong:* a rule written once in Rust and once in JS (Inbox's) needs the parity fixture to stay in step; it fails loudly when they drift.
2. **"Needs reply" is Inbox's own count: unacknowledged critical plus Needs reply, one per chat.** *If wrong:* an unacknowledged critical message adds one even though the user said "only needs reply"; it is the more urgent kind of the same thing.
3. **Sources clear by being handled, except the two "new" ones, which clear by being seen.** Replies and tasks clear when dealt with; meetings and automation results when the window showed them. *If wrong:* a user who wanted replies to clear on reading keeps a number until they reply, archive or snooze.
4. **Tasks due or late are my open tasks of the active provider due today or earlier (the 09:00 reminder's rule plus late); reply tasks drop out while replies are counted.** *If wrong:* "Check with Ann" tasks waiting on others don't count; a reply task whose message isn't in Needs reply doesn't count while replies are on.
5. **New meetings notes and automation results count for 7 days and never before the step's first start.** *If wrong:* an unopened meeting stops counting after a week.
6. **A meeting is seen when the window shows it in front and focused, or the user edits or chooses in it; a hidden meeting is marked seen on the next render.** *If wrong:* glancing at a meeting for a second clears it; a meeting hidden by series clears without being read.
7. **Automation results are seen together, when Automations is shown or Today with its Automation results card.** *If wrong:* opening Today clears results the user scrolled past.
8. **The number is the sum of the counted sources, capped "99+", with no title at zero.** *If wrong:* the user can't tell sources apart from the bar alone; the menu and tooltip say it.
9. **Amber is the template glyph recoloured `#F5A623` at runtime, not a dot, and it can't be turned off.** *If wrong:* the amber glyph is low-contrast on a light bar (about 2:1) or looks off-brand; swapping in a drawn asset is one image and one line.
10. **Needs fixing is six conditions: Microsoft sign-in, the task provider's token, a failed task plugin, refused task changes, an enabled automation whose newest run failed, and an unwritable meetings folder.** `offline` and rate limits are not. *If wrong:* another broken thing (a non-task plugin that didn't load) stays quiet until a later step adds a condition.
11. **The menu lists what the number is made of and what needs fixing, each row opening its place.** *If wrong:* three to six more menu rows than a user who only wanted the number expected.
12. **Default and Compact are the same in the menu bar; the Settings card follows the step-1 tokens only.** *If wrong:* nothing to undo; Compact has no menu-bar setting of its own.
13. **Windows gets the tooltip and the amber icon, no title.** *If wrong:* Windows users must hover to see the count.
14. **One new workspace operation, `menu_bar_seen`, through `mutate`, and no new Tauri command.** *If wrong:* each mark reserves a revision and redraws the window once; marks are rare (at most once per new item).

## Definition of done

1. **Quality gates** (`.ai-run/guides/quality-gates.md`): `make fmt-check`, `make lint`, `npm test`, `cargo test` (with the known skip), the contract fixtures regenerated and committed.
2. **Rust tests that assert the tray:** `FakeTray` records the applied title, amber flag, tooltip and menu rows for zero, one source, several, 99+, amber only and amber with a count; the refresher applies once per burst of changes; the amber recolour keeps alpha and paints `#F5A623`.
3. **Browser run, new checks:** `ui/test/browser/menu-bar-checks.mjs` (`WORKSPACE_E2E_ONLY=menu-bar`): the Menu bar card, the switches and the status line, the fixes list, the seen marks and the menu-row navigation, in both themes, in Compact and Default, at 1000 / 1440 / 1680 px, no horizontal overflow, screenshots saved.
4. **Browser run, no regressions:** the whole `workspace-e2e.mjs` run passes (plugins, meetings, meetings-view, meetings-settings, layout, analytics, compact, reply, tasks-dates, settings-tasks, tasks-provider, automations and the new set).
5. **Headless smokes only:** `CODEMIE_STATUS_SMOKE=status` on `CODEMIE_WORKSPACE_TEST_DIR` passes with its new `menuBar` facts (tray present, applied title and amber equal to the computed ones), and `CODEMIE_PLUGIN_SMOKE=<codemie-connect-marketplace>` passes. Real-desktop screenshots of the menu bar (the title, the amber icon, the menu) are deferred to the one announced pass at the end of the rollout.

There is no reference-app screen to compare beside: the menu bar has no mockup; the deferred desktop pass covers it.

## Left to the builder

- Exact CSS within the step-1 tokens.
- Where the refresher task lives (`Core::start` or beside `setup_tray`), as long as it starts after the tray exists and stops with `stop_background`.
- How `AppTray` rebuilds the menu (a new `Menu` per change is fine).
- Plan order. Suggested: settings, seen and the four sources; fixes, the snapshot part and the operation; the tray; the status smoke; the Settings card; seen marks and menu navigation in the window; the browser checks; the definition of done.
