# Change-log Reads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The window stops re-reading the whole workspace after every write and every sync round: native keeps a change log and answers "what changed since revision N", and the window applies that to the snapshot it has.

**Architecture:** SQLite triggers write one row per changed record and job into a `changes` table, tagged with the revision the write committed on top of. A new read-only operation `changes_since {revision, scope}` builds a delta from those rows with the same visibility rules and Inbox projection the full snapshot uses, or answers `{reset: true}` when a delta can't be trusted. The store applies a delta with a pure `applyChanges(result, delta)` and falls back to the full `snapshot` read at start, on `reset` and on any error.

**Tech Stack:** Rust (rusqlite, serde_json), Tauri v2, vanilla JS ES modules, node:test, Playwright browser run against the mocked bridge.

**Spec:** No separate spec. The design is the comparison of Echo's and Connect's action paths from 2026-11-24 (Echo polls small per-area stamps and reads per page; Connect re-reads an 11.7 MB snapshot). The "Design" section below is the spec this plan argues from.

## Why

- Measured 2026-11-20 on an 18 MB test copy (debug build): a full snapshot takes 0.65–1.5 s to build natively plus about 1 s to serialize and parse; 11.7 MB, 4.5k records.
- Since 2026-11-24 (commits on `workspace-app`), task and meeting clicks show at once through previews, and queued writes share one read. Each queue still ends in one full read, and every sync round re-reads everything (up to about once a second while a sync writes).
- With deltas, a write's settle read and a sync round cost the changed records only: a task Accept is one record, a mail page is its messages.

## Design

**Native change log.**

```sql
CREATE TABLE IF NOT EXISTS changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  revision INTEGER NOT NULL,   -- meta.revision when the row was written (before the write's bump)
  tbl TEXT NOT NULL,           -- 'record' | 'job'
  kind TEXT NOT NULL,          -- records.kind, or '' for a job
  id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  deleted INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS changes_revision ON changes(revision);
```

`AFTER INSERT`, `AFTER UPDATE` and `AFTER DELETE` triggers on `records` and `jobs` insert a row with `(SELECT revision FROM meta WHERE id=1)`. Each repository write runs `put_record` and then `bump` in one transaction, so its rows carry revision `r` and it commits as `r+1`. A snapshot read at revision `r` was taken before that commit (WAL isolation), so the changes since a snapshot at `r` are exactly the rows with `revision >= r`.

`meta` gets a `changes_from INTEGER`, the lowest revision the log is complete from. A fresh log sets it to the current revision, and pruning raises it.

**Delta.** The answer to `changes_since {revision, scope}`:

```json
{
  "reset": false,
  "revision": 1234,
  "scope": "<sha256 hex of the visibility scope>",
  "records": ["<Record, projected as in the snapshot>"],
  "removed": [{ "kind": "commitment", "id": "t1", "connectionId": null, "workspaceId": "personal" }],
  "jobs": ["<Job>"],
  "removedJobs": ["job-id"],
  "settings": {}, "workspaces": [], "connection": null, "available": true,
  "meetingsRoot": null, "noteTemplates": [],
  "authPending": false, "authError": null
}
```

- `settings`, `workspaces`, `connection`, `available`, `meetingsRoot`, `noteTemplates`, `authPending` and `authError` are always sent. They are small, and the snapshot computes them the same way.
- `scope` covers what decides visibility: the active workspace id, its `connectionId` and `sources`, the active connection id, its `status`, and its granted capabilities. The snapshot answer carries `scope` too.
- `reset: true` (with nothing else) when:
  - `revision < meta.changes_from`;
  - the client's `scope` differs from native's;
  - a changed record is of kind `rule` or `catalog` (they re-project every message);
  - more than 2000 records would be sent.

**Inbox projection closure.** `inbox::project` sets each message's lane from every message of its conversation, from decisions, incidents, rules and the chat catalog. `ai_jobs::mark_stale_summaries` sets a summary's `stale` from its conversation's newest message. So a changed `message`, `decision`, `incident` or `summary` brings every `message` and `summary` of its conversations (`prompts::conversation_key`). They are projected by the same two functions before they are sent.

**Window.** On `read()`, with a snapshot and its scope in hand, the store sends `changes_since`, and `applyChanges` turns the delta into the next result:
- records keyed `kind|id|connectionId|workspaceId`;
- jobs by `id`, newest `dueAt` first, cut to 300 as native does;
- the always-sent fields replaced.

It reads the full snapshot on `reset`, on an error, or when it has none. Reads, previews and the queue keep their current rules (store.js).

## Global Constraints

- Do not raise `SCHEMA_VERSION` (repository.rs, now `1`): an older Connect refuses a newer schema (`newer_schema`). The table, index, triggers and `meta.changes_from` are added with `IF NOT EXISTS` / an `ALTER TABLE … ADD COLUMN` guarded by a `pragma_table_info` check, inside the existing `init` batch.
- `changes_since` is read-only: answered in `Core::request` next to `snapshot` and `revision`, before the mutation lock and the revision fence; no operation id.
- Provider tokens and plugin secrets never enter a delta (the snapshot rules apply unchanged; `connection` is the same object the snapshot sends).
- Writes that skip the revision bump (`put_record_unversioned`, `put_ai_run`) still log rows: harmless (sent once more), and the parity test proves it.
- Log retention: keep rows with `revision >= current - 100_000` and from the last 24 h, whichever keeps more. Prune in `Core::background_round` (mod.rs, every 15 s) and on open, and set `changes_from` to the lowest kept revision.
- Contract fixture `ui/test/fixtures/contract/changes-since.json`, written by a Rust test with `contract_fixture`, read by the UI tests and the browser mock.

## Review Focus

1. A message arriving in a conversation marked Waiting: the older messages of that conversation change lane ("A new response is available"). Task 3 pins it.
2. Switching the active workspace, or the account signing out and back in, while the window holds a snapshot: the next read must be a reset, never a delta from another scope. Task 2 pins it.
3. A Make notes job moving queued → running → succeeded with its `step`: the meeting's progress line follows it without a full read. Task 5 pins it (job upserts).
4. A record deleted and re-created with the same key between two reads (Undo after Delete): it ends up present. Task 4's parity test runs it.
5. A window idle for a day (log pruned past its revision): one reset, then deltas again. Task 2 pins it.

---

### Task 1: The change log

**Files:**
- Modify: `src-tauri/src/workspace/repository.rs` (`init` batch near lines 58–70; new `changes_from`, `prune_changes`, `changes_since_rows`)
- Modify: `src-tauri/src/workspace/mod.rs` (`background_round`, line ~459: call the prune)
- Test: `src-tauri/src/workspace/repository.rs` (its `#[cfg(test)]` module)

**Interfaces:**
- Produces:
  - `pub struct ChangeRow { pub revision: i64, pub tbl: String, pub kind: String, pub id: String, pub connection_id: String, pub workspace_id: String, pub deleted: bool }`
  - `Repository::changes_from(&self) -> Result<i64>`
  - `Repository::changes_since_rows(&self, revision: i64) -> Result<Vec<ChangeRow>>` (newest row per `(tbl, kind, id, connection_id, workspace_id)`, ordered by `seq`)
  - `Repository::prune_changes(&mut self, keep_revisions: i64, keep_secs: i64, now: i64) -> Result<usize>`

- [ ] **Step 1: Write the failing tests**
  - `writes_log_one_row_per_record_with_the_revision_before_their_bump`: a `put_record` at revision `r` logs `(revision r, 'record', kind, id, …, deleted false)`, and `revision()` is then `r+1`.
  - `deletes_and_job_changes_are_logged`: `delete_local` logs `deleted true`; `enqueue` and a job state update log `tbl 'job'`.
  - `changes_since_a_snapshot_are_the_writes_after_it`: snapshot at `r`, then two writes give both rows from `changes_since_rows(r)`, and none from `changes_since_rows(r + 4)`.
  - `pruning_keeps_the_newest_and_raises_changes_from`: 10 writes, then `prune_changes(3, 0, now)` leaves rows `>= current-3`, and `changes_from()` equals the lowest kept revision.
  - `an_existing_data_folder_gets_the_log_without_a_schema_bump`: open a database written by `init` without the table (create one with the old batch in the test), reopen it, and `user_version` is still `1`, with the table, triggers and `changes_from` present.
- [ ] **Step 2: Run them to see them fail.** Run: `cd src-tauri && cargo test --lib workspace::repository` (expected: FAIL, the functions don't exist).
- [ ] **Step 3: Implement.** Add the table, index and six triggers (records and jobs × insert, update, delete) to the `init` batch, and `meta.changes_from` guarded by `pragma_table_info('meta')`. Initialise `changes_from` to `revision` when it is NULL. Add the three functions, and call `prune_changes(100_000, 86_400, now())` in `background_round` and once in `init`.
- [ ] **Step 4: Run them to see them pass,** plus all workspace tests: `cd src-tauri && cargo test --lib workspace::` (outside the sandbox: the graph tests bind local ports).
- [ ] **Step 5: Commit.** `git commit -m "feat(store): log record and job changes for reads by revision"`

### Task 2: The `changes_since` operation

**Files:**
- Modify: `src-tauri/src/workspace/models.rs` (`Operation::ChangesSince` beside `Revision`)
- Modify: `src-tauri/src/workspace/repository.rs`: split `snapshot()` into `snapshot_scope()` plus `visible_records(filter: Option<&[RecordKey]>)`, so the snapshot and the delta share the visibility SQL
- Create: `src-tauri/src/workspace/changes.rs` (the delta builder)
- Modify: `src-tauri/src/workspace/mod.rs` (`Core::request`: answer `ChangesSince` beside `Revision`; add `scope` to the snapshot answer)
- Test: `src-tauri/src/workspace/changes.rs` (`#[cfg(test)]`)

**Interfaces:**
- Consumes: Task 1's `changes_from`, `changes_since_rows`.
- Produces:
  - `pub struct RecordKey { kind, id, connection_id, workspace_id }` (all `String`)
  - `Repository::visible_records(&self, only: Option<&[RecordKey]>) -> Result<Vec<Record>>`
  - `Repository::scope_hash(&self) -> Result<String>`
  - `Core::changes_since(&self, req: &Request) -> Result<Value>` returning the Design's delta JSON
  - the snapshot answer gains `"scope"`

- [ ] **Step 1: Write the failing tests**
  - `a_delta_carries_the_changed_task_and_nothing_else`: from a snapshot, save one task; the delta has `records` with that task only, `removed` empty, and `revision` equal to `revision()`.
  - `a_deleted_task_comes_as_removed`
  - `a_record_outside_the_selected_sources_is_not_sent` (a mail record for an unselected source)
  - `another_scope_or_a_pruned_log_resets`: a scope that isn't native's gives `{"reset": true}`; `revision < changes_from` gives `{"reset": true}`.
  - `a_rule_or_catalog_change_resets`
  - `jobs_come_as_upserts_and_removals` (a finished job pruned by `prune_finished_jobs` comes in `removedJobs`)
- [ ] **Step 2: Run them to see them fail.** `cd src-tauri && cargo test --lib workspace::changes`
- [ ] **Step 3: Implement.**
  - Share the snapshot's three record queries through `visible_records`. With `only`, add `AND (kind,id,connection_id,workspace_id) IN (…)` via a temp table of keys.
  - `changes_since` reads the rows. On an empty change list it still sends the always-sent fields and `revision`.
  - The rest as in the Design.
- [ ] **Step 4: Run them to see them pass,** then the snapshot tests: `cd src-tauri && cargo test --lib workspace::`.
- [ ] **Step 5: Commit.** `git commit -m "feat(store): changes_since answers what changed after a revision"`

### Task 3: Inbox projection closure

**Files:**
- Modify: `src-tauri/src/workspace/changes.rs`
- Test: `src-tauri/src/workspace/changes.rs`

**Interfaces:**
- Consumes: `inbox::project(repo, w, c, &mut records)`, `ai_jobs::mark_stale_summaries(&mut records)`, `prompts::conversation_key(&Record) -> String`.
- Produces: `fn conversation_closure(repo: &Repository, changed: &[Record]) -> Result<Vec<Record>>`, used by `Core::changes_since`.

- [ ] **Step 1: Write the failing tests**
  - `a_new_reply_moves_the_waiting_conversation_in_the_delta`: three messages, one marked Waiting by a `decision`; a new inbound message gives a delta with all four messages, where the Waiting one has `lane == "waiting"` and `responseSourceId` is the new message's id.
  - `a_summary_turns_stale_in_the_delta_when_its_conversation_moves`
  - `a_decision_change_reprojects_its_conversation_only` (a message of another conversation isn't sent)
- [ ] **Step 2: Run them to see them fail.** `cd src-tauri && cargo test --lib workspace::changes`
- [ ] **Step 3: Implement.**
  - Take the conversation keys of changed `message`, `decision`, `incident` and `summary` records. A decision or incident is keyed through the message it names.
  - Load those conversations' messages and summaries with `visible_records`.
  - Run `inbox::project` and `mark_stale_summaries` over them together with the decisions they need, then send them.
- [ ] **Step 4: Run them to see them pass.**
- [ ] **Step 5: Commit.** `git commit -m "feat(store): a delta re-projects the conversations its messages belong to"`

### Task 4: Snapshot parity and the contract fixture

**Files:**
- Modify: `src-tauri/src/workspace/changes.rs` (tests)
- Create: `ui/test/fixtures/contract/changes-since.json` (written by the test)

**Interfaces:**
- Consumes: Tasks 2–3.
- Produces: `changes-since.json` = `{ "before": <snapshot answer>, "delta": <changes_since answer>, "after": <snapshot answer> }` for one task save, one task delete, one meeting `meeting_set`, one queued notes job and one new message in a Waiting conversation.

- [ ] **Step 1: Write the failing tests**
  - `a_delta_applied_to_a_snapshot_is_the_next_snapshot`: a seeded workspace with tasks, meetings, mail and chats. It runs 40 random writes (task save, delete, re-create under the same key, `meeting_set`, `enqueue`, job state change, message put, decision put, `put_ai_run`), reading a delta every 5. After each, `apply(before, delta)` equals `snapshot()`, with records and jobs compared sorted by key. `apply` is a Rust mirror of the window's `applyChanges`, kept in the test module.
  - `contract_fixture_changes_since` writes the fixture with `contract_fixture("changes-since.json", …)`.
- [ ] **Step 2: Run them to see them fail** (fixture missing). `cd src-tauri && cargo test --lib workspace::changes`
- [ ] **Step 3: Fix what parity finds.** Write the fixture: `cd src-tauri && UPDATE_CONTRACT_FIXTURES=1 cargo test --lib contract_fixture`.
- [ ] **Step 4: Run them to see them pass** without the variable.
- [ ] **Step 5: Commit** the test and the JSON. `git commit -m "test(store): a delta brings a snapshot to the next one; contract fixture"`

### Task 5: The window applies deltas

**Files:**
- Create: `ui/workspace/changes.js`
- Modify: `ui/workspace/store.js` (`read()`)
- Test: `ui/test/changes.test.mjs`, `ui/test/workspace.test.mjs` (store tests)

**Interfaces:**
- Consumes: the fixture from Task 4.
- Produces:
  - `export function applyChanges(result, delta)`, which returns the next `{snapshot, authPending, authError}` or `null` when `delta.reset`
  - `export const recordKey = r => \`${r.kind}|${r.id}|${r.connectionId ?? ''}|${r.workspaceId ?? ''}\``
  - store option `createStore(invoke, { deltas: true })` (app.js passes it; tests without it keep full reads)

- [ ] **Step 1: Write the failing tests**
  - `applyChanges brings the fixture's before to its after`: deep-equal, with records and jobs sorted by key.
  - `a reset delta gives null`
  - `jobs stay newest first and at most 300`
  - In workspace.test.mjs, `a read with a snapshot asks changes_since and applies it; a reset or an error reads the snapshot`: a counting native gives `['snapshot', 'changes_since']`, then a reset gives `['changes_since', 'snapshot']`. Previews stay laid over a delta exactly as over a snapshot (reuse the preview tests with `deltas: true`).
- [ ] **Step 2: Run them to see them fail.** `node --test ui/test/changes.test.mjs ui/test/workspace.test.mjs`
- [ ] **Step 3: Implement.**
  - `read()` sends `{op: 'changes_since', data: {revision: state.snapshot.revision, scope: state.scope}}` when `deltas && state`.
  - On `reset`, an error, or no state, it sends `snapshot`.
  - The applied/asked ordering, `show()` and the queue stay as they are.
- [ ] **Step 4: Run them to see them pass,** then `npm test`.
- [ ] **Step 5: Commit.** `git commit -m "feat(store): the window reads what changed, not the whole workspace"`

### Task 6: Browser mock and checks

**Files:**
- Modify: `ui/test/browser/workspace-e2e.mjs` (the mocked bridge)

**Interfaces:**
- Consumes: `applyChanges` and its shapes.
- Produces: the mock answers `changes_since` by diffing the snapshot it would send now against the one it sent at that revision (it keeps the last 20 by revision), or `{reset: true}` when it has none. `changes_since` joins its read-only list.

- [ ] **Step 1: Add a check** in `meetings-checks.mjs`: after Accept on the meeting's Tasks tab, `window.__bridgeCalls` holds no `snapshot` read after the first. This needs the mock to record reads, behind `window.__recordReads = true`.
- [ ] **Step 2: Run it to see it fail.** `WORKSPACE_E2E_ONLY=meetings PLAYWRIGHT_CORE=… node ui/test/browser/workspace-e2e.mjs` (outside the sandbox: it binds a port)
- [ ] **Step 3: Implement the mock's `changes_since`.**
- [ ] **Step 4: Run the full browser suite.** Expected: all pass. "Today card → meeting" is a known flaky check; rerun once before treating it as a failure.
- [ ] **Step 5: Commit.** `git commit -m "test(browser): the mock answers changes_since"`

### Task 7: Faster refresh after a change, and redraw only what moved

**Files:**
- Modify: `ui/workspace/app.js` (`scheduleRefresh`, the store listener)
- Create: `ui/workspace/route-kinds.js`
- Test: `ui/test/route-kinds.test.mjs`

**Interfaces:**
- Consumes: the store's last delta. Add `store.lastChange()` returning `{kinds: Set<string>, jobs: boolean, full: boolean}` for the read just applied.
- Produces: `export function routeTouched(route, change)` → boolean. `ROUTE_KINDS` maps:
  - `today` → all
  - `tasks` → `commitment`, `meeting`
  - `meetings` → `meeting`, `event`, `commitment`, `note_template`, `meeting_rule`, jobs
  - `inbox` → `message`, `decision`, `summary`, `draft`, `incident`, `rule`
  - `calendar` → `event`, `meeting`, `schedule`
  - `automations` → `automation`, `automation_run`, jobs
  - anything else → all

- [ ] **Step 1: Write the failing tests:** `a mail-only change doesn't touch Meetings`, `a job change touches Meetings`, `a full read touches every route`.
- [ ] **Step 2: Run them to see them fail.** `node --test ui/test/route-kinds.test.mjs`
- [ ] **Step 3: Implement.**
  - The listener skips `render()` when `!routeTouched(state.route, store.lastChange())`, but still runs the draft, theme and event-dialog steps it runs today.
  - `scheduleRefresh` drops to `Math.max(150, 300 - elapsed)`, since a delta read costs milliseconds.
- [ ] **Step 4: Run them to see them pass,** then `npm test` and the Meetings and layout browser sets.
- [ ] **Step 5: Commit.** `git commit -m "perf(window): redraw only the page a change touches; refresh sooner"`

### Task 8: Measure in the real app, and document

**Files:**
- Modify: `.ai-run/guides/architecture/architecture.md` (Store rules R1/R1a; read-only operations add `changes_since`; a short "Change log" paragraph)
- Scratch (not committed): `src-tauri/examples/seed_look.rs` per the 2026-11-20 recipe (a meeting with 3 tasks to review, `FILLER=4500` records ≈ 18 MB)

- [ ] **Step 1: Build and seed** a debug bundle with its own identity (the user's Connect may be running):
  - `cd src-tauri && CI=true cargo tauri build --debug --bundles app --no-sign --config '{"identifier":"com.epam.codemie.connectlook","productName":"Connect Look"}'`
  - then the seed with `CODEMIE_WORKSPACE_TEST_DIR` set to a scratch folder.
- [ ] **Step 2: Measure** with a temporary on-screen timing line:
  - **Accept ×5:** native requests and time until the queue settles. Expected: 5 writes, 0 full snapshots, settle well under 300 ms (was 5 writes + 1 snapshot, about 1 s).
  - **A sync round** writing 50 messages: delta read time. Expected: under 100 ms (was about 1 s).
- [ ] **Step 3: Remove the scratch files,** and the test bundle's caches and WebKit data.
- [ ] **Step 4: Update the guide;** run `make check` (outside the sandbox for the terminal and network tests).
- [ ] **Step 5: Commit.** `git commit -m "docs(architecture): change-log reads"`
