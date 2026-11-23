# Task provider and the Todoist plugin · design

**Status:** written on 2026-11-23 from the rollout overview's decisions, the user's binding decisions for this step, and the code. This is step 4 of `2026-11-22-workspace-next-rollout-design.md`. Decisions the overview and the user left open are ruled on below, under "Rulings for the user".
**Builds on:**
- step 1, `2026-11-22-compact-view-design.md`: the Compact / Default view, the `--ws-*` size tokens;
- step 2, `2026-11-22-reply-design.md`: the one gated send path (Nudge uses it, never sends on its own);
- step 3, `2026-11-23-meetings-view-design.md`: the action items column and its single swap point, `ui/workspace/task-target.js` (`localTaskTarget {label, add, undo}`);
- step 0, the `codemie-ai/codemie-connect-marketplace` repository (built-in marketplace `codemie`, empty `plugins/`).

**Reference (read-only):**
- the reference app's Todoist behaviour (API v1, the key and source marker lines, the key ledger, 429 handling, close / reopen / delete; the tasks facade and its task schema: `id, key, content, description, due, kind ∈ reply|budget|client|waiting|task, sourceUrl, url, priority, closed`; meeting-found tasks; and the follow-up rules: labels, absolute dates from the source date, "looks handled", closing only on the user's say-so, or when they replied themselves);
- the reference app's Tasks page and its mockup.

## Intent

Connect keeps tasks on its own board (`commitment` records, `src-tauri/src/workspace/tasks.rs`). The user keeps their real task list in Todoist and wants Connect to use it, the way the reference app does, without losing what Connect does well: tasks found in meeting notes, tasks from Inbox messages, the 09:00 reminder, and automations that make tasks with the window closed.

This step makes the task store pluggable. One provider is active at a time. The built-in **Connect** provider (Local) is the default. Turning on a provider plugin makes it the place every task lives: the Tasks page, Today's Tasks widget, every "add a task" in Connect, and the meeting column's "Add N to …". Turning it off brings Local back. Connect keeps a local copy of the provider's tasks as a cache and an outbox, so nothing is lost while offline or while Todoist is down, and the core can talk to the provider through the QuickJS plugin host with the window closed.

The first provider is a Todoist plugin in the Connect marketplace. It works the way the reference app uses Todoist: the labels `reply`, `waiting`, the app label and the reserved `budget`; a key line and a source link at the end of the description, so reruns make nothing new; absolute due dates. With Todoist on, the Tasks page shows the reference app's date layout: Late, Today, Later (Next 7 days, No date, Later than that), "Check with <name>" rows for waiting tasks, and a "Looks handled" flag.

## Goals

- **One active provider.** Settings › Tasks chooses "Connect (on this Mac)" or an installed task plugin. Every task surface reads and writes the active provider.
- **A native provider contract.** A plugin declares `"provides": ["tasks"]` and registers `list`, `create`, `update`, `complete` and `changedSince` (plus `status` and `remove`, ruled below) with `ctx.tasks.provide`. The core calls them through the QuickJS host, window open or closed.
- **Cache and outbox.** Every change is saved locally first and queued for the provider. A write in Connect never fails because the provider is unreachable. The outbox replays in order when the provider comes back.
- **No duplicates.** Every task carries a stable key from its source. The key is written into the provider's task and remembered in a ledger, so a retry, a rerun or a crash between "sent" and "acknowledged" never makes a second task.
- **The Todoist plugin** in `codemie-connect-marketplace`, network limited to `api.todoist.com`, the token a plugin secret the user types into Connect, tested against a fake Todoist.
- **The reference app's Tasks page** for a provider: Late (move all to Tomorrow or Monday, done all), Today, Later folded, "Check with <name>" rows with Nudge / Done / Snooze, "Looks handled" with Done / Keep open.
- **Switching is safe.** Local → Todoist offers once to copy the open local tasks. Switching away never deletes anything, in Connect or in Todoist.
- **Compact and Default** draw the same markup. Compact differs only through the step-1 tokens.

## Non-goals

- Obsidian and OneNote providers. They are later plugins on the same contract.
- Step 5's create-tasks delivery, the reference-app automation templates and making `@budget` tasks. This step reserves the label and gives step 5 one native call to make a task by key.
- The reference app's People page, its "Chase" fold, AI-drafted nudges (✦) and the reply sweep's per-thread done marks.
- Editing Todoist's priorities, sub-task trees, comments, recurrence rules or other projects. Connect reads one project and preserves what it doesn't own.
- More than one active provider, or Local and Todoist side by side.
- The real-desktop GUI pass and the live check with the user's own token. Both happen at the end of the rollout, by the user.

## Anti-goals

- **Duplicated tasks.** A double click, a retry after a timeout, a crash after Todoist answered, a meeting's notes made again, a second "Copy to Todoist": none may make a second task.
- **Lost tasks offline.** A task added in Connect (by hand, from notes, by an automation with the window closed) while Todoist is unreachable must reach Todoist later, in order, or be shown as not synced with a reason. Never dropped silently.
- **The token leaking.** The Todoist token never enters a snapshot, the webview's storage, a plugin frame, a URL, a log line, a contract fixture, an error message or a crash report. Settings never reads it back.
- **Deleting the user's tasks on a switch.** Switching providers, turning the plugin off, removing it, or "Copy" never deletes or closes anything anywhere.
- **Silently overwriting a change made in Todoist.** When both sides changed, the rule below decides, and the task's history says what was kept.
- **Hammering Todoist.** Connect stays well under Todoist's limits, honours `Retry-After`, and stops at once on a rejected token.
- **Regressions for Local.** With Local active, the board, list, drawer, meeting column, Today widget and reminder behave exactly as today.
- **Anything sent to a person without a click.** Nudge opens a reply; only the step-2 Send sends.
- **A plugin frame writing tasks.** Only the host half provides tasks, and only the core calls it.

## Approaches considered

| Approach | Trade-off | Decision |
|---|---|---|
| **A. Native cache and outbox, the plugin's host half as provider.** The core owns the task records, the outbox, the key ledger and the sync job; it calls the plugin's registered provider functions through `PluginHost::ask`, as it already does for `deliver:<kind>`. | New native module and a small plugin-API addition. Works with the window closed, offline, and for any later provider. | **Chosen** |
| B. Provider in the window: the UI calls the plugin's commands (`plugin_call`) and keeps no copy. | Little native work, but nothing syncs with the window closed, automations can't make tasks, and an offline add is lost. | Rejected: contradicts the decision |
| C. A native Todoist client in Rust, no plugin. | Fast and simple for Todoist, but Obsidian and OneNote would each need Connect releases, and the token would be Connect's, not a plugin secret. | Rejected: the provider is a plugin by decision |
| D. Pass-through: the core calls the provider on every read, with no cache. | No merge logic, but every page open waits on Todoist, and offline shows nothing. | Rejected: anti-goal "lost tasks offline" |

## Design

### 1. Task records with a provider

Tasks stay `commitment` records. The body (see `tasks.rs`) gains:

| Field | Meaning |
|---|---|
| `provider` | absent for Local; `"plugin:<id>"` for a provider's task. Set on creation from the active provider. |
| `key` | 16 hex characters, set once on creation (§3), never changed, never shown. |
| `kind` | `task` (absent reads as `task`), `reply`, `waiting` or `budget`: the reference app's task-schema kinds minus `client`. |
| `remote` | provider tasks only: `{id, url, labels, updatedAt, base, syncedAt}`. `base` is the provider's last-seen `{text, notes, due, done, kind, owner}` for the merge (§4). `labels` keeps labels Connect doesn't own. |
| `pending` | `true` while an outbox entry for it waits. |
| `syncError` | the sentence of a parked entry (§4), else null. |
| `handled` | `{evidence, at, auto}` when the task looks handled (§6), else null. `keptEvidence` lists evidence hashes the user said "Keep open" to. |
| `copiedFrom` | on a task copied from Local, the local task's id. |

- **What each surface shows:** `tasksOf(s)` in `tasks-model.js` returns the records whose `provider` equals the snapshot's active provider (absent = Local). That one rule switches the Tasks page, Today's widget, the meeting column, Inbox's "added" marks and the people popover's task links. Natively, `tasks::active(r, w)` does the same for the 09:00 reminder, the automation context and Today's stats.
- **To review tasks follow the active provider.** A task found in notes starts To review with the active provider stamped, and is never sent anywhere while in review. On a switch, review tasks are re-stamped to the new provider: they are Connect's drafts and exist nowhere else.
- **`dismissed`** is never sent. **`doing`** is open in the provider (Todoist has no lanes); a move between To do and In progress sends nothing.

### 2. Settings and the snapshot

- **Native settings** gain `tasks: {provider: "local" | "plugin:<id>", copyOffered: [provider]}`, default `{provider: "local", copyOffered: []}`, app-wide like `meetings`.
- **The snapshot** gains `taskProvider` (no secret, ever):

```json
{ "active": "plugin:todoist", "name": "Todoist",
  "available": [{"id": "local", "name": "Connect"}, {"id": "plugin:todoist", "name": "Todoist", "on": true, "ready": true}],
  "state": "ready", "pending": 0, "parked": 0, "lastSync": 1795003200, "retryAt": null, "message": null,
  "copyOffered": false }
```

`state` is one of `local`, `ready`, `syncing`, `offline`, `rate_limited`, `needs_token`, `off` (the plugin is installed and turned off) or `failed` (it didn't load). A contract fixture, `task-provider-states.json`, holds one real snapshot part per state.

### 3. Keys and the ledger

- **The key** is `sha1("<source>#<normalized text>")`, first 16 hex characters, with the reference app's normalization (`commitmentKey`: NFKC, lower case, letters, digits and `#` kept, spaces collapsed). `<source>` is:
  - `meeting:<meetingId>:<line>` for a task found in notes;
  - `message:<sourceId>` for a task from an Inbox message;
  - `manual:<task id>` for a task typed by hand (the id is the operation id, so a retried add has the same key);
  - for step 5, `<automation source id>`, passed in.
- **The ledger** is a bookkeeping record per provider and key (kind `task_key`, id `<provider>|<key>`): `{remoteId, state: created | done | withdrawn | removed, at}`. It remembers every key ever created, so a task completed or deleted in Todoist is not made again by a rerun. "Withdrawn" (the meeting column's Undo) lets a later add create again.
- **A create** goes: ledger has a live remote id → nothing new (an update if fields differ); otherwise the plugin's `create` first looks for an open task with that key in the project and adopts it; only then does it create. The outbox entry's id travels as `requestId` on every attempt.
- **Step 5's call:** `tasks::create_by_key(core, workspace, body, key)` (native, idempotent) is the only way an automation makes a task.

### 4. The outbox and the sync job

**The outbox** is a bookkeeping record per entry (kind `task_outbox`, no revision bump): `{id, taskId, provider, op: create | update | complete | remove, patch, enqueuedAt, attempts, lastError, parked}`.

- `task_save`, `task_delete`, `task_withdraw`, `task_bulk` and `task_handled` write the task record and its outbox entry in the same repository transaction, then queue the `task_sync` job. For Local nothing is queued.
- Consecutive `update`s of one task coalesce into one patch. An `update` after a `complete` of the same task waits behind it.

**The job** `task_sync` (key `task_sync:<provider>`, one at a time, claimed by the background loop like the other jobs, also with the window closed):

1. **Push** the outbox, oldest first, at most 50 entries a pass:
   - a task's entries wait for its `create` to have a remote id;
   - `create` stores the remote id in the task and the ledger before the entry is removed, so a crash after Todoist answered is caught by the key lookup on replay;
   - an entry refused by the provider for its content (`refused`, `not_found` on update) is **parked** with the sentence; it blocks nothing else; the row shows it with "Try again" and "Discard change";
   - `offline`, `rate_limited` and `needs_token` stop the pass and keep the order.
2. **Pull** with `changedSince({cursor})` (the cursor in the bookkeeping record `task_state` `sync:<provider>`; `null` asks for everything open), then merge each task:
   - unknown remote task → a new record (`kind` from its labels, `key` from its key line or `remote:<id>` hashed);
   - removed in the provider → the record goes (its ledger entry becomes `removed`);
   - known task → the merge rule below.

**The merge rule** (three-way, per field, against `remote.base`):
- only Todoist changed a field → Todoist's value;
- only Connect changed it → Connect's (it is in the outbox);
- both changed it → the later change wins by time (Connect's edit time against Todoist's `updatedAt`), and the history says "Todoist had a newer <field>; Connect kept it." when Todoist's won;
- done or reopened in either place wins over an edit of the same task; deleted in Todoist wins over everything.

**Cadence and backoff:**
- a pull at most every 60 s; every 5 minutes from the background loop; at once after a push; when the Tasks page opens and when the window gains focus (the window asks `task_sync_now`, which the core runs at most once every 30 s);
- `offline` (network failure or a 5xx): retry after 30 s, doubling to 15 minutes; reset on success;
- `rate_limited`: nothing is sent until `retryAt` (`Retry-After`, else 60 s), shown in Settings and the Tasks header;
- `needs_token` (401 or 403): no call until the token is saved again, which queues a sync;
- `off` or `failed`: no call; changes keep queueing.
- **Budget:** at most 4 requests a second and 300 in any 15 minutes. That is well under Todoist's published per-user limits (about 1,000 requests and 100 full syncs per 15 minutes at the time of writing). A full pull happens on the first sync, on a switch, and on "Check" only.

### 5. Plugin role and host wiring

- **Manifest.** `"provides": ["tasks"]` (a string is accepted) and `"requires": ["tasks_provider"]`.
  - `tasks_provider` joins `FEATURES` in `manifest.rs`, so an older Connect, and Echo, refuse the plugin with "it needs tasks_provider, which Connect doesn't have" instead of loading it half-working.
  - `provides` is read into `Manifest.provides`; an unknown role is refused: "provides a role Connect doesn't know (<role>)".
- **Permission sheet.** `capabilities::sheet` adds a line for the role: "Hold your tasks: what you add and change in Connect goes to it, and Connect shows the tasks it lists." The `network` line lists `api.todoist.com`.
- **Host half.** The prelude gains `ctx.tasks.provide({list, create, update, complete, changedSince, status, remove})`, like `ctx.deliver.provide`. Each function becomes the provider `tasks:<op>`. A plugin that doesn't provide tasks gets a permission error from `tasks.provide`.
- **The core's way in.** A trait `TaskProviders` (`workspace/task_provider/mod.rs`), set once on `Core` by the plugin manager (like `EventSink`): `call(plugin, op, args) -> Result<Value, ProviderError>` and `available() -> [{id, name, on, ready}]`. The manager's implementation calls `PluginHost::ask(id, "tasks:<op>", args)` with a 30 s answer limit. Tests use `FakeProvider` (scripted answers and failures, recorded calls).
- **Errors.** A provider throws an `Error` whose message starts with a code, and the core maps it:
  - `needs_token:` → `needs_token`;
  - `rate_limited:<seconds>:` → `rate_limited` with `retryAt`;
  - `offline:` → `offline`;
  - `not_found:` and `refused:` → parked;
  - anything else, or a host `timeout` → `offline` (temporary).
  The rest of the message, cut to 200 characters, is the sentence shown to the user. The core drops it (keeping only the code) if it contains the stored token; the plugin never puts the token in a message in the first place.

**The wire shape** (one task between the core and any provider):

```json
{ "id": "8124", "key": "3f2a9c01d4e5b6a7", "text": "Send the pilot user list", "notes": "“I'll send you the names by Friday.” — Marek Novak, Philips sync, 2026-11-18",
  "due": "2026-11-20", "done": false, "kind": "waiting", "owner": {"name": "Marek Novak", "address": "marek.novak@example.test"},
  "source": "https://teams.microsoft.com/l/message/…", "meetingId": "mtg-philips", "url": "https://app.todoist.com/app/task/8124",
  "labels": ["waiting", "connect"], "updatedAt": "2026-11-18T12:00:00Z" }
```

| Op | Input | Answer |
|---|---|---|
| `status` | `{}` | `{ok: true, account, project}`; throws `needs_token:` without a usable token |
| `list` | `{}` | `{tasks: [task]}`: every open task of the project |
| `changedSince` | `{cursor}` (`null`: everything open) | `{tasks: [task], removed: [id], cursor}`: changed tasks, done ones included |
| `create` | `{key, task, requestId}` | `task` (`adopted: true` when an open task with the key was found) |
| `update` | `{id, patch, requestId}` | `task`; `patch` holds only changed fields; a `null` due clears it |
| `complete` | `{id, done}` | `task`; `done: false` reopens |
| `remove` | `{id}` | `{removed: true}`; only for the column's Undo and an explicit Delete |

### 6. "Looks handled"

- **The flag.** `handled {evidence, at, auto}` on a task shows on its row as "Looks handled · <evidence>" with "Done" and "Keep open". Keep open clears it and adds the evidence's hash to `keptEvidence`, so the same evidence never flags it again.
- **Closed on its own only when the user replied themselves.** After each Microsoft sync round, a native sweep looks at open `reply` tasks with a `sourceId`. When the same conversation (mail thread or Teams chat) has a message from the user newer than the source message, the task is completed with the history line "Closed: you replied in Teams at 17:32" (or "in Outlook"). The completion goes to the provider like any other.
- **Other evidence** (someone else answered, the deliverable arrived) only sets the flag. Step 5's Inbox triage and Commitments automations write it through `task_handled {id, evidence}`; this step builds the field, the sweep, the op and the UI.

### 7. The Todoist plugin (marketplace)

`codemie-connect-marketplace/plugins/todoist/`: `echo-plugin.json`, `main.js` (host half only, no client half), `icon.svg`, `README.md`. Tests in `tests/todoist/`, helpers in `tests/helpers/` (`fake-ctx.mjs`, `fake-todoist.mjs`), gates in `scripts/check.sh`.

```json
{ "id": "todoist", "name": "Todoist", "version": "1.0.0", "engine": ">=1.0", "requires": ["tasks_provider"],
  "provides": ["tasks"], "main": "main.js", "icon": "icon.svg",
  "summary": "Keeps Connect's tasks in your Todoist: one project, the reference app's labels, no duplicates",
  "uses": {"network": {"hosts": ["api.todoist.com"]}},
  "settings": [
    {"key": "token", "label": "API token", "type": "secret", "help": "Todoist › Settings › Integrations › Developer"},
    {"key": "project", "label": "Project", "type": "string", "default": "Connect"},
    {"key": "label", "label": "App label", "type": "string", "default": "connect"}] }
```

- **API.** `https://api.todoist.com/api/v1` with `Authorization: Bearer <token>`, read from `ctx.settings.get('token')` inside each call and never kept anywhere else.
  - `status`: `GET /user`, then the project.
  - The project is found by name (paged `GET /projects`) and made once with `POST /projects` when missing. Its id is kept in the plugin's store.
  - `list`: paged `GET /tasks?project_id=`.
  - `changedSince`: `POST /sync` with `sync_token` (`*` for null) and `resource_types: ["items"]`, filtered to the project; `checked` → `done`, `is_deleted` → `removed`.
  - `create`: the key lookup over the open tasks, then `POST /tasks`.
  - `update`: `POST /tasks/{id}`. `complete`: `POST /tasks/{id}/close` or `/reopen`. `remove`: `DELETE /tasks/{id}`.
- **What a task looks like in Todoist:**
  - **content** is the task's text. A waiting task reads `<First name>: <text>` (the reference app's form); the prefix is removed again on reading when it matches the owner line.
  - **description**: the notes (with the quote and who said it), then a blank line, then Connect's marker lines, last, one per line:
    - `key: <key>` (always);
    - `source: <https link>` (a message's web link; never a Teams meeting join link);
    - `meeting: <meeting id>`;
    - `owner: <Name> <address>` (someone else's task only).

    Any line of user text that looks like a marker (any case, Markdown-decorated, as the reference app's `MARKER_LINE`) is dropped before writing, so text can't plant a key or a link. On reading, the last line of each marker wins.
  - **labels**: the app label (setting, default `connect`) on every task Connect makes; `reply`, `waiting`, `budget` by kind; labels Connect doesn't own are kept on every update.
  - **due**: `due_date` `YYYY-MM-DD` only. Connect resolves every date to an absolute day before it is saved (from the source date for found tasks), so the plugin refuses anything else. `null` clears with `due_string: "no date"`. A recurring task's due string is never sent back: Connect sends `due_date` only when the user changed the date.
  - **Owner**: the user's own task has no `waiting` label. Someone else's has `waiting`, the content prefix and the `owner:` line. "Nobody named" goes as the user's own.
- **Errors**: 401 / 403 → `needs_token:`; 429 → `rate_limited:<Retry-After or error_extra.retry_after or 60>:`; network failure or 5xx → `offline:`; 404 → `not_found:`; other 4xx → `refused: Todoist didn't accept the change (<status>)`. Response bodies are never copied into messages.
- **Network:** `uses.network.hosts` is exactly `["api.todoist.com"]`. The host refuses any other address. No sign-in host, no `hosts_from`.

### 8. The token and plugin settings in Connect

- **Settings owned by Connect.** `plugins_request` gains `set_setting {id, key, value}` for a setting the manifest declares. It is guarded like the other `plugins_request` ops (`require_main_frame` first) and refuses `hosts_from` keys (they keep `set_addresses`).
  - A `secret` is **write-only**: it is stored in `<private>/credentials/plugins/<id>/secrets.json` (0600, existing `write_private`) and never read back by any op.
  - `installed` reports each declared setting as `{key, label, type, help, value}`, with `value` replaced by `set: true|false` for a secret.
  - Saving or clearing a provider's secret queues a sync.
- **No plugin frame** sees the token. The Todoist plugin has no client half. For any plugin, a frame's settings calls never return a secret (the builder keeps this as is and adds a test).
- **Logs** name provider errors by code and plugin only. A test greps the log file, the snapshot, every contract fixture and the outbox for a sentinel token.

### 9. Tasks page with a provider

**Views.** The Tasks page's view switch gains **By date**:
- Local: "Board | List | By date", Board by default, as today;
- a provider: "By date | List", By date by default. Board is hidden because its lanes don't exist in Todoist. List keeps working, its status select limited to To do, Waiting and Done.

**Header:** "Tasks", then a status line for the provider (§ Copy), "⋯" with "Sync now" and "Settings › Tasks". The meeting filter chip "From <meeting> ✕" shows when filtered.

**By date** (`tasks-dates-model.js` pure, `view-tasks-dates.js` pure), two columns when the page is at least 1100 px wide, one below that:

```
┌ Left ───────────────────────────────────────────┐ ┌ Right ────────────────────────────┐
│ To review · 2                    Accept all     │ │ Later                             │
│  ☐ Prepare the pilot user list · Philips sync   │ │ ▸ Next 7 days               6     │
│ Late · 3                                   ⋯    │ │ ▸ No date                   9     │
│  ✓ Send the follow-ups      · CLI review  2d    │ │ ▸ Later than that           2     │
│  ✓ Check with Marek: pilot user list      1d    │ │                                   │
│     Nudge Marek · Done · Snooze ▾                │ │                                   │
│ Today                                           │ │                                   │
│  ✓ Approve the hotfix                           │ │                                   │
│  ✓ Reply to Olga about SOW section 4            │ │                                   │
│     Looks handled · you replied in Teams 17:32  │ │                                   │
│     Done · Keep open                            │ │                                   │
│ 3 done today · Undo                             │ │                                   │
└─────────────────────────────────────────────────┘ └───────────────────────────────────┘
```

- **Groups** (in the workspace time zone): Late (open, due before today), Today (due today), and Later's folds:
  - Next 7 days (due in 1–7 days);
  - No date;
  - Later than that (due after 7 days).

  Each fold shows its count, is closed by default, and is drawn only when it has rows. An empty Late or Today shows "Nothing late." / "Nothing for today."
- **To review · N** shows at the top while there are review tasks, with "Accept all" and per row Accept / Not a task. Accept sends the task to the provider.
- **A row**: a done box ("Mark “<text>” done"), the text, a dim "· <meeting title>" or "· <sender>" when it has a source, and the due tone on the right ("2d late", "Mon"). A click on the row (not the box) unfolds its chips, closing any other:
  - Late and Today: Tomorrow · Monday · Pick date…;
  - Later: Today · Tomorrow · Pick date…;
  - then Open in Todoist ↗ (`url`), Open meeting / Open message, and the row's details (the existing drawer).
- **Check with rows**: a `waiting` task reads "Check with <first name>: <text>" (the owner's first name) and shows in the group of its due date, which is its check date. Its controls are:
  - "Nudge <first name>", only when its source is a synced mail thread or Teams chat. It opens that thread in Inbox with the reply box filled with "Hi <first name>, any news on <text>?". Nothing is sent without the step-2 Send.
  - "Done".
  - "Snooze ▾", with the row's date chips.
- **Looks handled** shows under the row, as in §6.
- **Late ⋯**: "Move all to Tomorrow", "Move all to Monday", "Pick date…", "Done all". Each is one `task_bulk`, with "Moved 3 to Tomorrow · Undo" (or "Marked 3 done · Undo") in the footer.
- **Footer**: "<n> done today" and the last action's Undo (`role="status"`).
- **Pending and parked**: a pending row shows a small "Not in Todoist yet" dot with that title. A parked row shows the sentence in red with "Try again" and "Discard change".
- **Banners** (one at a time, above the groups):
  - `needs_token`: "Todoist needs your API token." with "Open Settings";
  - `off`: "Todoist is turned off in Settings › Plugins. You're seeing the last copy; changes wait.";
  - `failed`: "The Todoist plugin didn't load: <reason>.";
  - `offline` and `rate_limited` stay in the header line only.

**Local and By date.** Local can use By date too: the same groups over Local's open tasks, without Open in Todoist. Waiting status and "someone else's" both read as Check with.

### 10. Every "add a task" with a provider

- **The meeting column.** `task-target.js` gains `providerTaskTarget({label, moveTask, withdraw})`, and app.js passes the target of the active provider:
  - **label** is the provider's name: "Add 2 to Todoist", "In Todoist", "2 in Todoist ›", "Added 2 to Todoist · Undo";
  - **`add(ids)`** is `task_save {id, status: 'todo'}` for each, the same as Local's, and the native side queues the create;
  - **`undo(ids)`** is one `task_withdraw {ids}`. Each task goes back to review. A create still in the outbox is dropped, so nothing reaches Todoist. A create already sent becomes a `remove` (a delete, not a close, so Todoist's completed list doesn't show it as done), and the ledger marks the key `withdrawn`.
  - Local's target uses `task_withdraw` too, which for Local is the move to review with "Moved back to review".
- **Today's Tasks widget** reads the active provider's open tasks with the same markup. With a provider, the row's trash button is not drawn (the done box stays), the header button reads "Tasks", and the quick add creates in the provider.
- **Inbox** "Add a task" and the "Asked of you" add write as today. The toast says "Added to Todoist" with a provider. Their key source is `message:<sourceId>`.
- **Delete with a provider** (drawer ⋯ › Delete) asks first: "Delete “<text>” in Todoist too? Undo makes it again as a new task." Then the record goes and a `remove` is queued. Undo saves it back, which creates it again under the same key (the ledger entry was `removed`, so a create is allowed).
- **Tasks found in notes** start To review with the active provider and wait for "Add N to …", as today.

### 11. Settings › Tasks

- **Where it lives.** The existing "Tasks" tab (id `meetings-tasks`, so links keep working) moves from the Meetings group to the Workspace group, after Notifications. Its content stays, and one card comes first.
- **The card "Where your tasks live"**: a radio group.
  - "Connect: kept on this Mac" (Local).
  - One row per installed plugin that provides tasks, with its name and its state line. A plugin that is off reads "Turned off in Settings › Plugins" with "Turn on".
- **Under the chosen provider**, its declared settings, drawn by Connect:
  - a secret as a password field ("API token") with "Save" and the line "Saved on this Mac. Connect never shows it again." once set ("Replace" and "Remove" then);
  - each string setting as a text field (Project, App label).
  - Also "Check", which runs `status` and says "Connected to Todoist as <account>, project “Connect”." or the error sentence; "Sync now"; and the pending, parked and last-sync line.
  - A link "Get your token in Todoist ↗" opens `https://app.todoist.com/app/settings/integrations/developer` through the existing link confirmation.
- **Choosing a provider** saves `task_provider_set`. The first time a provider is chosen, while Local has open tasks, a dialog offers the copy:
  - title "Copy your open tasks to Todoist?";
  - body "Connect has <n> open tasks. Copies go to the project “<project>”. Your tasks in Connect stay as they are.";
  - buttons "Copy <n> tasks" and "Not now".
  - Afterwards a quiet link "Copy open tasks from Connect…" stays in the card. A second copy creates nothing new: the keys match.
- **Choosing Connect again** needs no dialog. The status line says "<n> changes wait for Todoist" when the outbox isn't empty; those changes are sent when Todoist is chosen again.
- **Settings › Plugins**: the Todoist row's summary gains "Provides tasks · Settings › Tasks".
- **Removing the plugin while it is the provider**: Connect switches to Local and says "Todoist was removed, so tasks are back in Connect." The cached tasks and the outbox stay hidden, and come back if it is installed again.

### 12. Native operations

| Op | Data | Answer | Notes |
|---|---|---|---|
| `task_provider_set` | `{provider, copy?}` | `{provider, copied}` | `REBASE_SAFE`. Refusals: "Choose Connect or an installed task plugin." (`field: provider`), "Turn <name> on in Settings › Plugins first." Re-stamps review tasks; marks `copyOffered`; `copy: true` queues creates for open Local tasks (`copiedFrom`, same key). |
| `task_sync_now` | `{}` | `{queued}` | read-only (no operation id), at most once in 30 s |
| `task_withdraw` | `{ids}` | `{done, failed}` | §10 |
| `task_bulk` | `{items: [{id, due?, status?}]}` (≤ 200) | `{done, failed, before: [{id, due, status}]}` | Undo sends `before` back |
| `task_handled` | `{id, action: "done" \| "keep"}` or `{id, evidence}` | `{id}` | §6 |
| `task_parked` | `{id, action: "retry" \| "discard"}` | `{id}` | discard drops the entry and restores `remote.base` fields |

`task_save` and `task_delete` keep their shapes. With a provider they also queue outbox entries. With Local they behave exactly as today.

### 13. Migration

- Existing records have no `provider`, so they are Local's. Nothing is rewritten.
- `key` is added to a task the first time it is saved after this step, and given to every task the copy sends.
- Old settings without `tasks` read as Local.
- The contract fixtures that change: `task-records.json` (new fields), `task-delete.json`, the settings fixtures that carry the whole settings, and the new `task-provider-states.json`, `task-sync-cases.json` (push, pull, merge and backoff cases from the real job), `plugin-settings.json` (the `installed` settings view, secret as `set`).

## Copy

- **Settings › Tasks:**
  - card "Where your tasks live"; options "Connect: kept on this Mac" and "<Plugin name>";
  - "Turned off in Settings › Plugins", "Turn on";
  - "API token", "Save", "Replace", "Remove", "Saved on this Mac. Connect never shows it again.", "Get your token in Todoist ↗";
  - "Project", "App label";
  - "Check", "Connected to Todoist as <account>, project “<project>”.", "Sync now", "Copy open tasks from Connect…";
  - status: "Synced <ago>", "Syncing…", "<n> changes wait for Todoist", "<n> changes couldn't reach Todoist";
  - copy dialog: "Copy your open tasks to Todoist?", "Connect has <n> open tasks. Copies go to the project “<project>”. Your tasks in Connect stay as they are.", "Copy <n> tasks", "Not now";
  - toast "Todoist was removed, so tasks are back in Connect."
- **Tasks header line:**
  - "Todoist · synced <ago>", "Todoist · syncing…";
  - "Todoist can't be reached · <n> changes wait · trying again at <time>";
  - "Todoist asked Connect to slow down · trying again at <time>";
  - "Connect · on this Mac".
- **Banners:** "Todoist needs your API token." with "Open Settings"; "Todoist is turned off in Settings › Plugins. You're seeing the last copy; changes wait."; "The Todoist plugin didn't load: <reason>."
- **By date:**
  - groups "To review · <n>", "Late · <n>", "Today", "Later";
  - folds "Next 7 days", "No date", "Later than that";
  - empty lines "Nothing late.", "Nothing for today.";
  - "Accept all", "Accept", "Not a task";
  - Late ⋯ "Move all to Tomorrow", "Move all to Monday", "Pick date…", "Done all";
  - chips "Today", "Tomorrow", "Monday", "Pick date…", "Open in Todoist ↗", "Open meeting", "Open message";
  - due tones "<n>d late", "Today", weekday short names;
  - "Check with <first name>: <text>", "Nudge <first name>", "Done", "Snooze ▾", nudge text "Hi <first name>, any news on <text>?";
  - "Looks handled · <evidence>", "Done", "Keep open";
  - footer "<n> done today", "Moved <n> to Tomorrow · Undo", "Moved <n> to Monday · Undo", "Moved <n> to <date> · Undo", "Marked <n> done · Undo";
  - "Not in Todoist yet", "Try again", "Discard change".
- **Views:** "Board", "List", "By date".
- **Meeting column with a provider:** "Add <n> to <provider>", "In <provider>", "<n> in <provider> ›", "Added <n> to <provider> · Undo".
- **Delete:** "Delete “<text>” in Todoist too? Undo makes it again as a new task."
- **History lines:** "Todoist had a newer <text|notes|due date|owner>; Connect kept it.", "Done in Todoist", "Reopened in Todoist", "Closed: you replied in Teams at <time>" / "… in Outlook at <time>", "Copied from Connect".
- **Native refusals:** "Choose Connect or an installed task plugin.", "Turn <name> on in Settings › Plugins first.", "Choose up to 200 tasks."
- **Permission sheet:** "Hold your tasks: what you add and change in Connect goes to it, and Connect shows the tasks it lists."
- **Plugin refusals** (`refused:`): "Todoist didn't accept the change (<status>)", "Todoist needs a date like 2026-11-20."

## Accessibility

- "Where your tasks live" is a `role="radiogroup"` with a label. Each option is a real radio with its state line as `aria-describedby`.
- The token field is `type="password"`, `autocomplete="off"`, labelled "Todoist API token". It is empty after Save, and its saved state is announced through `role="status"`.
- By date: each group is a `section` with an `h2`. Folds are buttons with `aria-expanded` and `aria-controls`. A row's unfold control is a `button` with `aria-expanded`; the done box stays outside it, labelled "Mark “<text>” done".
- The Late ⋯ menu and Snooze ▾ use the existing menu handling (Enter, Space, Esc back to the button).
- The footer, the header sync line and the "Added … · Undo" status are `role="status"` (polite). A parked row's sentence is linked to its row with `aria-describedby`.
- Nudge, Done and Keep open are buttons named with the person or task ("Nudge Marek", "Done: <text>").
- Text stays at or above the step-1 minimum (10.5 px in Compact); focus rings are unchanged; colour is never the only signal (late rows say "2d late").

## Rulings for the user

1. **Provider selection lives in Settings › Tasks.** It is a radio group "Where your tasks live" on the existing Tasks tab, which moves from the Meetings group to the Workspace group (same id and links). The provider's token, project and label fields are drawn by Connect under it. *Why:* one place to choose and set up, and the token field is Connect's own, never a plugin frame.
2. **The token is a write-only plugin secret** set through a new `plugins_request set_setting`. It is stored 0600 in the private root, reported only as "set" or "not set", never logged, never in a frame. *Why:* the safety constraint, using the secret store plugins already have.
3. **Conflicts: a three-way merge per field.** One side changed → that side. Both changed → the later change by time, with a history line when Todoist's won. Done or reopened beats an edit. Deleted in Todoist beats everything. *Why:* no silent loss of a Todoist edit, no prompt for every clash, and the outcome is predictable and written down.
4. **Sync cadence:**
   - push at once after a change;
   - pull at most every 60 s: on Tasks open and on window focus (at most every 30 s), and every 5 minutes in the background, window open or closed;
   - offline backoff 30 s doubling to 15 min; `Retry-After` honoured; a rejected token stops all calls until it is saved again.
   *Why:* fresh enough while looking, quiet otherwise, far under Todoist's limits.
5. **Field mapping:**
   - owner Me → plain task; someone else → `waiting` label, "<First>: " content prefix and an `owner:` line; Nobody → plain;
   - lanes: To review and Dismissed stay in Connect; To do and In progress → open; Waiting → `waiting`; Done → closed;
   - meeting → a `meeting:` line; quote → the description text; due → `due_date` only.
   *Why:* the reference app's form, readable in Todoist's own app, and fully re-readable by Connect.
6. **With a provider, the Tasks page is "By date | List", By date first, and Board is hidden.** Local keeps Board first and gains By date as a third view. *Why:* Todoist has no lanes, and Local loses nothing.
7. **Later folds: Next 7 days, No date, and Later than that** (the reference app has the third). Folds are closed by default and drawn only with rows. *Why:* nothing due in three weeks is left out, and it matches the reference app.
8. **The meeting column's Undo removes the Todoist task.** Before it was sent, the create is just dropped. After, it is a delete (not a close), the task returns to review, and its key is marked withdrawn so a later add works. *Why:* a closed task would sit in Todoist's completed list as if done.
9. **Idempotent keys:** the reference app's normalized sha1 of `<source>#<text>`, 16 hex. The key is written as a `key:` line at the end of the description, with the `source:`, `meeting:` and `owner:` lines. A per-provider ledger remembers every key, and `create` adopts an open task with the same key before making one. *Why:* reruns, retries and crashes make nothing new, as in the reference app.
10. **Rate limits:** Connect's own budget is 4 requests a second and 300 per 15 minutes, with full pulls only on the first sync, a switch or Check. *Why:* a wide margin under Todoist's per-user limits, shared with the reference app while both run.
11. **Offline outbox replay order:**
    - oldest first; one task's entries in order, waiting for its create;
    - updates coalesced;
    - a content refusal parks only that entry (with Try again or Discard), while offline, rate limits and a rejected token pause the queue in place.
    *Why:* nothing is lost or reordered, and one bad task never blocks the rest.
12. **Todoist layout: one project, default "Connect", made once if missing, and no sections.** The proposed sections Reply / Waiting / Meetings are ruled out: the labels already say the kind, and a section per kind would put it in two places. The project name is a setting, so the user can point Connect at the project the reference app uses during the switch-over. *Why:* the simplest layout that reads the same in the reference app, Connect and Todoist.
13. **Labels:** `reply`, `waiting`, `budget` (reserved for step 5), and the app label `connect` (a setting) on every task Connect makes. Connect lists every open task of the project, whatever its labels, and keeps labels it doesn't own. *Why:* tasks the user adds in Todoist show in Connect too.
14. **The role is `"provides": ["tasks"]` plus `"requires": ["tasks_provider"]`.** The ops are `status`, `list`, `changedSince`, `create`, `update`, `complete` and `remove`, registered with `ctx.tasks.provide`. `status` and `remove` are added to the five named: Check needs one, and Undo needs the other. *Why:* older Connects and Echo refuse the plugin cleanly, and Obsidian or OneNote can follow the same seven ops.
15. **"Looks handled" closes on its own only for a `reply` task the user answered themselves** in the same thread, with a history line. Every other evidence only flags it, with Done / Keep open. Step 5's automations write that evidence. *Why:* the reference app's rule; Connect never decides a task is done for the user.
16. **Switching:**
    - the first switch to a provider offers once to copy the open Local tasks, with a quiet link to do it later;
    - To review tasks move with the switch;
    - switching back keeps the provider's cache and unsent changes for next time;
    - nothing is ever deleted or closed by a switch, an off or a removal.
    *Why:* the user's decision, made safe to repeat by the keys.
17. **Delete with a provider deletes in Todoist after a confirm,** and Undo makes it again under the same key. *Why:* the user asked for the delete, Connect says where it applies, and Undo stays real.
18. **Versioning and shipping:**
    - semver in the plugin's manifest, starting at 1.0.0, with a changelog in its README;
    - the catalog entry `{id: "todoist", source: "./plugins/todoist", categories: ["tasks"]}`, featured;
    - built and tested on the marketplace's `main`, and pushed to GitHub only in the plan's last step, once the definition of done has passed;
    - a later version that changes `uses` asks for consent again (existing update flow).
    *Why:* the marketplace is public, and the push is the one outward-facing act of the step.
19. **Nudge opens the source thread with a plain prefilled line;** it never drafts with Claude and never sends. It shows only when the source is a synced thread. *Why:* step 2's send rule, and AI nudges are a later addition.
20. **Recurring Todoist tasks:** done in Connect closes this occurrence. Todoist moves the date, and the next pull brings it back. Connect never sends a due string. *Why:* the recurrence stays Todoist's.

## Left to the builder

- Exact CSS within the step-1 tokens, and whether By date's two columns come from a container query or a width class.
- Whether outbox entries are bookkeeping records (suggested, like `task_state`) or a table, as long as the write and its entry share one transaction.
- Whether the plugin writes through REST calls (suggested) or `/sync` commands with `uuid = requestId`, as long as the key lookup comes first.
- The fake Todoist's exact endpoints beyond those the plugin uses, and how the Rust integration test's fake server is built (the `http.rs` test `serve` pattern is suggested, with `Client::for_tests` made available under `test-support`).
- How `tasks-controller.js` splits once the By date actions are added (a `tasks-dates-controller.js` is fine).
- Plan order. Suggested:
  1. records, keys, settings and the snapshot;
  2. the plugin role and host wiring;
  3. the outbox and sync;
  4. the operations, switching and looks handled;
  5. the marketplace plugin;
  6. the real-plugin integration test and smoke;
  7. By date;
  8. Settings › Tasks;
  9. provider everywhere;
  10. the browser checks;
  11. the definition of done.
