# Milestone 1 — a working CodeMie personal workspace

**Status: proposed for approval. No production implementation is authorized by this document yet.**

The milestone delivers a real Tauri workspace with **Today, Calendar, Inbox, Workspaces and Settings**, in CodeMie light and corrected dark themes. Microsoft 365 uses the same CodeMie public Entra application registration that Echo defaults to, with Connect-owned authentication and storage. The current installer, tools, Desktop proxy, health, logs, analytics and update behavior remain supported.

There are **four major tasks**. Each is a coherent implementation increment and may require several small changes. A task closes only after its automated, native-app and applicable connected-service gates pass. Screenshots and browser mocks alone cannot close it. Detailed cases are in [TEST-PLAN.md](TEST-PLAN.md); architectural review is in [ARCHITECTURE-REVIEW.md](ARCHITECTURE-REVIEW.md).

## 1. Scope to approve

| Area | Working behavior included in milestone 1 |
|---|---|
| Application shell | CodeMie navigation, persistent active workspace, resizable native window, accessible keyboard navigation, light/dark/system themes, non-blocking setup banner, loading/empty/error/offline states. |
| Today | Calendar timeline, sourced morning brief, requests needing attention, source-linked personal commitments, focus controls, actual job status/usage where available, persistent core-widget visibility/order/width. Counts and actions use the same records as Calendar and Inbox. |
| Calendar | Microsoft 365 agenda/week/month, date and timezone navigation, event details, join/open-provider actions, local reminders, workspace membership, reviewed creation of timed calendar events/focus blocks (all-day events are readable; all-day creation is deferred). Distinguish a local focus timer from a real Outlook calendar event. |
| Inbox | Outlook Inbox/Sent context and selected Teams 1:1/group/meeting chats; six lanes; source detail and reason/evidence; manual lane override; local archive/restore; snooze; acknowledge critical; commitments; local reply drafts and explicitly reviewed mail/Teams replies. |
| Queues and schedules | Durable sync/classification/draft/brief/reminder/snooze/notification jobs, recurrence and quiet schedules, retry/cancel/run status, restart and sleep/wake recovery. Built-in job types only. |
| Workspaces | Local CRUD, archive/restore, immutable IDs, selected sources and membership rules, pinned notes/context, local commitments, per-workspace AI choice, overview and filtered Calendar/Inbox. One source can belong to several workspaces. |
| Settings | General/workspaces, appearance, Microsoft connection/capabilities, AI profiles, Inbox rules/schedules, notifications/focus, Setup & tools, privacy/data, About. Every visible action is implemented or clearly capability-blocked with a recovery path. |
| Existing Connect | Installation/guided setup, AI tool inventory/install/update/remove, profile/model/provider/project setup, SSO and BYOK/local-model paths already supported, Desktop connect/restart/disconnect, health, command log, terminal, analytics, app/CLI updates, first-launch runtime and PATH behavior. |

**Boundaries:** Knowledge/vault editing, full Chat/Meetings/capture, recording arming, plugin marketplace/runtime, arbitrary user automation scripts, Telegram/phone escalation, Google Calendar and Delivery/factories remain later milestones. Do not ship clickable routes into the prototype for those features. Today’s “waiting” queue contains real M1 conditions: drafts needing review, local commitments, connection/action failures and existing tool updates. Knowledge/plugin widgets appear only when those later services exist.

Calendar event editing/deletion/RSVP and remote Outlook archive/read-state modification are not required for M1; open the provider for those actions. “Archive” in Connect is explicitly local. M1 calendar creation and reviewed replies are included because the approved mockups expose them. No arbitrary send-later/auto-send is included: schedules prepare drafts or issue local reminders; a human approves each outward action.

**Microsoft account scope:** one active Microsoft 365 connection in the M1 UI, independently of CodeMie platform sign-in. Account switching is supported with isolation and explicit reconnection; a workspace never silently changes account. Schema keys include tenant/account so simultaneous connections can be added later. Personal Microsoft accounts can use supported mail/calendar features; Teams chat capabilities are work/school-only. The primary real-service acceptance target is an organization test tenant using the shared CodeMie registration.

## 2. Evidence and architectural decisions

### Existing behavior that constrains the migration

- `ui/renderer.js:709–768` currently waits for Node/CLI runtime readiness before booting the app. Moving the home DOM would leave the workspace blocked on installation. The new shell must start independently; CLI-dependent actions retain a readiness gate.
- `renderer.js:300–345`, `ui/setup-leave.js` and `setup-driver.js` own setup settlement/cancellation. Keep one mounted workflow, controller instance and Engine. Route changes must not orphan a setup prompt or leave it running invisibly.
- `src-tauri/src/state.rs` and `commands/pty.rs` own a single installer PTY. Graph and AI background jobs must never use it.
- `tauri.conf.json` fixes the window at 1000×660 and disables resizing. `commands/window.rs` resets its width to 1000 when the command log changes height. Both must be adapted together.
- Current `commands/` already owns runtime, config, tool and update operations. Preserve the app identifier `com.epam.codemie.installer`, existing configuration/runtime locations, PATH rules, update feeds and CLI precedence.
- A pre-existing safety mismatch must be fixed before invoking `CODEMIE_PROBE_SMOKE`: `renderer.js:992–1005` calls its filter detection-only, but IDs 2.3.3/2.3.5 map to `codemie setup` and `codemie install claude --supported` in `handlers.js:84–92` and config/steps.yaml. It was not executed during planning. `CODEMIE_SMOKE` is the separate benign render/stream/PTY check that was run.
- Current tests include real shell/PTY checks as well as injected JS tests. Existing browser suites that stub Tauri remain useful component/integration checks, not native E2E proof.

### What is reused from Echo

`echo/crates/echoctl/src/graph.rs:31–62,262–340` establishes the public CodeMie registration, tenant override, system-browser PKCE and loopback flow. `needs.rs` provides tagged/hot source semantics, deterministic filtering, quote-checked AI and preservation of user decisions during slow sync. `attention.rs` retains open items when a source fails. Its `schedule.rs` is recording arming, not a general Inbox job engine.

The six-lane Inbox, durable snooze/escalation and full future dashboard are **new implementation work inspired by Echo’s future designs**. They are not a complete existing subsystem to transplant. Echo’s base scope list omits Mail.Read and write/send scopes; Connect must request and check its own explicit capabilities. Echo code is AGPL-3.0-only while Connect is Apache-2.0: use documented behavior/contracts and independently implemented Connect modules; copying/linking runtime code requires a separate licensing decision. The later unchanged-plugin compatibility effort remains separate.

### ADR-M1-01: keep the installer, add a native workspace service

Retain the current frontend-brain/thin-Rust arrangement **for the installer**. Add a native `WorkspaceCore` for state and work that must survive renderer reload, route changes and hidden windows. This extends the architecture deliberately; it does not move the install Engine into Rust.

```text
Tauri window: CodeMie shell + small JS view modules
     | typed query/mutation IPC            ^ revision/invalidation events
     v                                     |
thin commands/workspace*.rs adapters -> WorkspaceCore
                                        |-- repository / migrations
                                        |-- Graph auth + API + sync
                                        |-- Inbox rules + decisions
                                        |-- job runner + schedules
                                        |-- notification / action outboxes
                                        `-- bounded AI profile runner

Existing Settings -> Setup & tools host -> existing JS Engine/controllers
                                        -> existing runner-bridge commands
                                        -> installer runtime / installer PTY
```

The UI renders local snapshots immediately and requests refresh asynchronously. No authoritative queues, schedules, OAuth credentials or workspace data live in `localStorage` or JS timers. JS can own transient form state, selection and optimistic display; confirmed native snapshots remain authoritative.

### ADR-M1-02: durable data and account isolation

Use a Connect-owned SQLite database under a **new workspace subdirectory** of the existing app data location. Use migrations, foreign keys and transactions; one serialized repository owner/actor runs DB work off the async network/UI thread. Choose/pin a maintained SQLite integration compatible with the project’s supported Rust/OS versions; no unreviewed minimum-version upgrade. Keep network awaits outside DB transactions/locks. Configure WAL and explicit durability/checkpoint/backup behavior and test abrupt termination.

| Data family | Key ownership / invariants |
|---|---|
| workspace / settings / layout | Stable UUID; default Personal workspace cannot be deleted; archive preserves data; optimistic expected-revision writes prevent lost edits. |
| connection / capabilities | Tenant + account + configured client/authority; selected capabilities separate from actual grants; connection generation increases on logout/switch/registration change. No tokens in DB. |
| source records / memberships | Account + provider + stable source ID + revision; workspace memberships reference canonical records; sync once per account, not once per workspace. |
| calendar / mail / chat cursors | Resource-specific cursor, query/window version, completed revision and last-success timestamp; page data and cursor advance transactionally. |
| Inbox decision / override | Workspace-specific lane/archive/ordinary snooze; manual decision version separate from provider revision. A new relevant message may reopen a conversation under an explicit rule; re-reading the same revision cannot. |
| critical acknowledgement | Global per account + incident/source revision, so acknowledging in one workspace stops duplicate escalation everywhere; resolving a source and acknowledging it are distinct. New incident/revision may alert again under cooldown rules. |
| commitments / notes / drafts | Workspace-owned; source identity/revision and exact quote retained when derived; manual edits remain authoritative. Drafts do not modify remote Drafts in M1. |
| jobs / occurrences / runs | Durable state, unique occurrence key, lease/heartbeat/attempt/retry time, pinned account/generation/workspace/profile and source revision. |
| notifications / outward actions | Separate transactional outboxes; dedup IDs and audit entries. Approval binds account, resource, recipient set, body/hash and action revision. |

**Workspace/account binding:** every workspace has an explicit nullable `connection_id`; every saved provider selection/rule also retains that connection/tenant/account identity. An account-less workspace contains local content and no implicit “current account” source filter. At the first connection, ask which unbound workspace to bind. Switching A → B leaves A-bound workspaces intact but their provider data/jobs unavailable under B; local user-written content remains available with that status. For B, offer a new workspace or an explicitly selected unbound workspace. Reassigning an A-bound workspace requires a reviewed summary, invalidation of pending work/approvals, clearing old provider memberships/selections and explicit B source selection. Do not migrate A bodies/derived AI content into B or reinterpret A's filters as B filters. The Personal workspace can remain bound to A; its non-deletable status does not imply automatic rebinding. Reconnecting the same tenant/account can restore its existing stable connection after fresh authorization.

**Narrowed policy is immediate:** connection generation alone is insufficient. Persist connection capability/policy revision, workspace source/grant revision and pinned profile grant revision. Jobs capture those revisions and the source snapshot revision. Check them at claim, network/AI/action dispatch and result commit. Disabling a capability, removing a source, archiving a workspace, changing its binding or revoking a profile cancels affected work and rejects late results/approvals. Hide or purge its cached/derived content under the documented cache policy. Changing only the default AI profile does not revoke a separately pinned ready profile. A stale UI snapshot cannot authorize broader access. Scheduled notification delivery rechecks these same policies immediately before submission. Archived workspaces allow history/export/restore, not new provider/AI mutations; local user-owned notes/tasks in an account-unavailable but active workspace may still be edited. Global critical acknowledgement is an account-scoped safety action and remains available from the active account notification/Inbox even if one membership is archived.

Disconnect cancels account jobs, invalidates in-flight results and removes credentials. Default behavior removes synchronized mail/chat/calendar bodies and derived AI content for that connection after an explicit summary; preserve user-written local notes/commitments, showing unavailable source links. A separately explained opt-in can retain a read-only cache. Account B never sees account A’s cache while disconnect/purge is pending. App reset/export affects only Connect-owned workspace data; it must not remove CLI profiles, runtime/tool installations or Echo data.

### ADR-M1-03: typed IPC and lifecycle

Proposed modules: `src-tauri/src/workspace/{mod,repository,migrations,models,service,jobs,schedules,notifications,ai}.rs`; `workspace/graph/{auth,client,capabilities,calendar,mail,chats,sync}.rs`; thin `commands/workspace.rs`, `commands/workspace_graph.rs`, `commands/workspace_jobs.rs`; `ui/workspace/{bridge,store,router,shell,today,calendar,inbox,workspaces,settings,legacy-tools-host}.js`. Adjust names to existing conventions; keep one owner per concern.

Queries include `workspace_snapshot`, `calendar_list`, `inbox_list` and `job_list`. Mutations include workspace/settings updates, `graph_connect/cancel/disconnect`, `sync_request`, Inbox decision/snooze/ack, draft save, action prepare/confirm and job cancel/retry. Every mutation carries explicit scope, expected revision where relevant and a client operation ID. Commands validate IDs, grants and connection generation. The renderer never passes arbitrary shell/Graph URLs or token headers. Keep the current restrictive CSP; Graph requests use native `reqwest`.

Emit coalesced `workspace:changed`, `connection:changed`, `sync:status`, `job:changed` and installer’s existing events with scope/revision. On subscribe/reopen/focus, query a snapshot and reconcile newer revisions; missing an event cannot lose state. Unsubscribe old view listeners. Cancellation means an acknowledged state transition, not merely hiding a spinner. Keep structured new error codes (`needs_login`, `permission_required`, `offline`, `throttled`, `conflict`, etc.) without changing legacy command error contracts.

One OS instance owns workspace background work. Initialize services after the existing PATH initialization, taking Tauri plugin setup/thread ordering into account. Define startup/single-instance handling before introducing plugin threads. Main-window close hides it and retains the tray process while “Continue in background” is enabled; explicit Quit stops work and flushes/returns leases. Disabling background mode restores close-to-quit semantics. Preserve confirmation/settlement rules for an active installer, including tray Quit. Launch-at-login is explicit and optional. No jobs run while the app/computer is off; wake/relaunch performs bounded catch-up. OS Focus/DND is respected; ordinary notifications do not claim a privileged critical-alert bypass.

## 3. Microsoft Graph contract

### Registration and credentials

Use Echo’s **CodeMie public-client registration constant**, not the CodeMie web login client and not a client secret. Allow organization tenant/client override. Reuse the registered loopback shape (`http://localhost` with an ephemeral port) only after verifying its public/native redirect configuration in the test tenant; do not silently change to an unregistered callback path. Bind only loopback, use high-entropy state + PKCE S256, a single-use bounded callback and a five-minute cancellation/timeout window, and validate method/path/state. Permit one interactive login attempt per connection; a superseded/cancelled attempt cannot commit credentials after its callback/token exchange completes. A library-backed, reviewed OAuth implementation is preferred. Never use an embedded sign-in webview, copy Echo’s `graph.json`, read CodeMie CLI secrets or treat platform SSO as a Graph token. Conditional Access may still require tenant/broker support; verify it live rather than promising success from browser choice alone. [Microsoft auth-code/PKCE guidance](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow), [redirect rules](https://learn.microsoft.com/en-us/entra/identity-platform/reply-url).

Credentials belong behind a native SecretStore: macOS Keychain and Windows DPAPI-protected, per-user refresh cache (or a proven credential backend with large-token support), using compatible maintained libraries. Prefer access tokens in memory only. Test long refresh tokens, locked/denied storage and macOS re-signing; do not assume a generic Windows credential blob accommodates every token. Use stable app/service names and a separate development test namespace, with no plaintext fallback. OS credential denial becomes a usable settings error. Refresh is single-flight per connection and token rotation serialized. Token endpoint errors, token-response granted scopes and actual API 403/challenges drive capability status; an unverified access-token claim is not an authorization boundary. Purge on logout and invalidate when authority/client changes. No credentials in JS, URLs, logs, exports, screenshots or fixtures.

### Capability and endpoint matrix

| Capability | Delegated permission | Native operations |
|---|---|---|
| Identity / persistent sign-in | openid, profile, offline_access, User.Read | Auth-code exchange/refresh and `/me`; separate from CodeMie profile identity. |
| Calendar read | Calendars.Read | Paginated calendars and calendarView; primary-calendar calendarView delta for a fixed window. Additional calendars use supported paginated views with full-window reconciliation; do not assume every calendar has the primary delta route. |
| Outlook Inbox and reply detection | Mail.Read | Selected folder message delta (Inbox + Sent Items), conversation grouping and lazy bounded body reads; `Mail.ReadBasic` is insufficient for the message body behavior we show. |
| Teams chats | Chat.Read | Discover user chats; paginate messages for selected chats with supported last-modified ordering/filter and overlap/reconciliation. No universal chat delta endpoint is assumed. |
| Calendar create | Calendars.ReadWrite, requested when enabled | Reviewed `POST /me/calendars/{id}/events`; persist a transactionId for safe create retry. Attendees cause invitations, which the confirmation explicitly shows. |
| Mail reply | Mail.Send, requested separately | Reviewed `POST /me/messages/{id}/reply`; honor replyTo, preview recipients, treat 202 as provider acceptance rather than delivery. |
| Teams reply | ChatMessage.Send, requested separately | Reviewed `POST /chats/{id}/messages`; response to an existing chat, not creation of a new chat, channel posting or a promised threaded-reply API. Store returned message ID on 201. |

People/photo, OneDrive, shared/delegated mailbox, channel-posting and organization-directory scopes are deferred. Do not request broad `*.All` application permissions. Local feature switches can narrow use even if a tenant-issued token contains broader scopes. A denied optional scope leaves granted capabilities working.

Endpoint references: [calendar-view delta](https://learn.microsoft.com/en-us/graph/api/event-delta?view=graph-rest-1.0), [folder message delta](https://learn.microsoft.com/en-us/graph/api/message-delta?view=graph-rest-1.0), [chat listing/paging](https://learn.microsoft.com/en-us/graph/api/chat-list-messages?view=graph-rest-1.0), [create event](https://learn.microsoft.com/en-us/graph/api/user-post-events?view=graph-rest-1.0), [mail reply](https://learn.microsoft.com/en-us/graph/api/message-reply?view=graph-rest-1.0), [chat send](https://learn.microsoft.com/en-us/graph/api/chat-post-messages?view=graph-rest-1.0). Use the dedicated chat-send page and permission reference: the combined channel/chat page currently has an inconsistent permission table.

### Synchronization and calendar rules

- One account sync coordinator; manual/periodic requests coalesce. Initial defaults: foreground sync every 60 s, background sync every 5 min, wake/network/focus refresh when stale, adjustable within bounded limits. Fetch changed/selected resources, not every chat every minute. Rate-limit each account/resource; honor Retry-After and jittered backoff. [Graph throttling](https://learn.microsoft.com/en-us/graph/throttling).
- Start with a bounded 30-day mail/chat history and a calendar window covering the previous month through three months ahead. UI states that range and supports explicit load-more/range expansion. Already-open Inbox items are not silently aged out merely because the initial read window rolls forward; retain minimal source metadata/quote until resolved or explicitly cleared under the configured retention policy. A complete empty result can reconcile data; failed, partial or timed-out fetches cannot erase the last good cache or mark requests done.
- Follow every supported nextLink, keep opaque delta URLs intact, and validate HTTPS host/resource/account before adding bearer auth. Do not forward auth across redirects to other origins. Cursor invalidation triggers controlled resync; it does not mean “clear Inbox.” Separate cursors per folder/calendar/window/query version.
- Use stable Outlook immutable IDs where supported; retain folder memberships independently so a move is not mistaken for a deleted/re-created conversation. Edits/deletions and tombstones carry provider revision. Preserve manual decisions while applying slow sync results.
- Store UTC instants plus original timezone/date semantics. Use an explicit timezone conversion library and supported mailbox timezone mapping; never interpret arbitrary Graph local timestamps as the Mac’s local time. All-day exclusive-end dates, DST gaps/folds, recurring instances/exceptions, cancellations, series changes and simultaneous local/remote updates have dedicated cases. Calendar entry rejects a nonexistent local time and asks the user to choose; an ambiguous repeated time requires an explicit offset choice. This is different from the documented recurrence scheduler policy. Timed writes may use correctly converted UTC values; preserve the reviewed display timezone and never guess an offset.
- `calendarView` expands relevant occurrences; use provider instance identity, series ID and occurrence start. Local reminders reference the occurrence; reschedule/cancel invalidates old reminders. Joining opens only validated provider HTTPS/approved Teams URLs and never starts recording.
- No cloud webhook relay is introduced. This desktop M1 uses bounded polling; its detection latency is visible. Graph change notifications/subscriptions require separate infrastructure and are not implied by “notifications.”

## 4. Inbox, scheduling and action semantics

### Six lanes, independent state dimensions

| Lane | Entry behavior |
|---|---|
| Critical | Explicit user critical rule (for example VIP + outage), or reviewed/evidence-checked urgent suggestion promoted under policy. Critical rules cannot be downgraded by AI. |
| Needs reply | Unanswered direct request: 1:1 last sender is not me; unresponded mention in selected group/meeting chat; trusted mail addressed To me with no subsequent own reply. Exclude automated/self mail under visible rules. |
| Waiting on others | User marks waiting or confirms a source-linked promise by another person; due/reminder is local. A new inbound response reopens it for review. AI alone cannot establish that someone committed. |
| FYI | Relevant selected source needing no action, or safe fallback when classification is unavailable/uncertain. Failed AI must not drop the source. |
| Low priority | Explicit newsletter/automation/low rules or user choice. Rule exclusions stay visible and reversible. |
| Decisions | Local draft approvals, account/permission/action failures and existing tool-update requests; not a second copy of every unread message. |

Lane, lifecycle (open/archived/resolved), snooze-until, acknowledgement and unread/source revision are **different fields**. Define and unit-test precedence: trusted native policy/exclusions → manual override → explicit critical rules → deterministic direct-request rules → optional AI suggestions → FYI fallback. A manual override from Critical to another lane requires an explicit “Acknowledge and move” confirmation: the global incident is acknowledged, while the lane override is workspace-local. Acknowledgement stops escalation but does not claim the incident is resolved or a reply sent. Ordinary snooze is workspace-local. Critical snooze is an explicitly confirmed global incident reminder pause, reflected in every workspace containing that incident; it does not acknowledge it. An incident episode groups repeated matches in the same conversation/rule until acknowledged/resolved. Only a new matching inbound revision after acknowledgement and a default 15-minute per-rule cooldown can create a new episode; ordinary edits/non-matching messages only update context. Repeated identical sync never resets snooze, overrides or archive. A genuinely new relevant revision may reopen according to the documented rule and cooldown; old critical revision stays acknowledged.

AI classification, reply drafts and briefs use a pinned direct-Claude or CodeMie-backed profile. Use a separate bounded headless process/runner, never the installer PTY. Inspect supported installed CLI versions/JSON modes in Task 3 rather than hardcoding guessed commands. Read only selected source text; tools, shell and extra network browsing are disabled for source interpretation (only the explicitly approved AI-provider connection remains); verify structured output and exact source quotes. Email/chat text is untrusted input. No personal-skill discovery or full Chat product is required in this milestone. If AI is absent, signed out, over cap or unavailable, deterministic queues, manual drafts, local tasks and Calendar keep working. Profile changes never silently reroute an already queued job.

### Durable job and notification rules

Jobs use `queued → running → succeeded / failed / blocked / cancelled`; running work owns a lease + heartbeat. Expired leases are recovered after a crash. Blocked work names its prerequisite and resumes only when valid. Unique `(job type, scope, occurrence/source revision)` keys and transactional outboxes prevent duplicate scheduling. One AI job per selected profile by default; bounded Graph parallelism; installer has its own capacity/PTY. Manual and scheduled sync coalesce; a CPU/AI backlog must not prevent a critical acknowledgement or installer input.

Schedules retain IANA zone, local recurrence, computed UTC occurrence and execution key. On a DST repeated hour run once; for a missing time use the next valid local time. Recompute future occurrences when zone/rule changes. Brief catch-up window defaults to 2 h; skip older missed brief runs with a reason. Snooze expiration is applied on wake/relaunch; an expired meeting reminder is suppressed, not replayed in a flood. Cancel/reconfigure/ack must be rechecked immediately before delivery. Task 3 tests clock jumps, lease loss and simultaneous wake/manual refresh.

Native notifications are local OS messages driven by the notification outbox. Request permission only when the user enables them; denial leaves in-app Decisions/Inbox usable. Focus/quiet hours suppress ordinary notifications; user critical rules can bypass **app quiet policy**, never promise to bypass OS DND. Deduplicate one incident across workspaces. Use an app-scoped stable ID; default lock-screen content is private, with source text opt-in. Distinguish “queued,” “submitted to OS,” “failed/permission denied” and “acknowledged”; do not claim OS display/delivery merely from API success. M1 escalation is an in-app persistent banner plus at most one repeated desktop reminder (default two minutes after first detection, configurable); acknowledgement cancels pending repeats. An OS submission already begun before acknowledgement may still become visible; the UI/history distinguishes that from a new post-ack dispatch. Telegram/phone are deferred. Fully atomic exactly-once OS display across a crash is not promised: prefer no repeated toast on an ambiguous crash boundary, keep the in-app alert durable and reconcile by stable ID where the platform permits.

### Outward-action review

Prepare action → native validates permissions and current source → display account, recipients/destination, exact content and invitation side effects → user confirms a single-use approval with a five-minute expiry tied to that action and policy revision → native sends. Editing destination/content/profile/account or narrowing policy invalidates approval. A background AI/routine cannot mint approvals or call the write service. UI double-click and duplicate IPC are deduplicated locally.

An accepted request is not guaranteed delivery. A definite pre-dispatch failure can retry safely; a timeout/disconnect after possible dispatch enters **Unknown outcome — check provider**, with no blind retry. `client-request-id` is correlation, not Graph send idempotency. Calendar create uses its supported transactionId; mail/Teams sends still require outcome-aware recovery. Recipient/body changes require a new approval. The live QA send cases use owned test mailboxes/chats with a known marker, verify one recipient-side result, and clean up only records the test created.

## 5. Four incremental tasks

### Task 1 — native shell, local Workspaces, Settings and legacy preservation

**Deliverable:** the real app opens a useful local workspace in CodeMie light/dark without downloading tools first; existing Connect functions live in Settings and remain operable.

1. Capture the current source/baseline and build native smoke. First repair the existing detection-only probe to call explicit read-only inspectors instead of mutable install step IDs, with negative assertions that setup/install/PATH/profile mutations cannot run. Until that fix is verified, do not invoke the current probe mode. Add isolated test app-data/credential namespaces, injectable clock/network adapters and deterministic fixture support behind a test-only mode. Fixtures must never be accepted as real Graph data in production.
2. Add `WorkspaceCore`, versioned repository/migrations, local workspaces/settings/layout/commitments and typed bridge. Establish instance ownership and background lifecycle before worker threads. Include the **minimal common job foundation** now: persistent job/occurrence/run/lease records, transactional outbox records, claim/recovery/cancel primitives, clock and policy-revision checks. Prove them with native repository/service integration tests. They support Graph refresh and action recovery in Task 2; Task 3 adds Inbox-specific job types, recurrence UI and notification delivery. A workspace initialization/DB failure is a managed degraded state, not a fatal error returned from Tauri setup: the recovery shell and legacy tools must still open. Show recovery/export/read-only options, not silent reset.
3. Build the real app shell with primary Today / Calendar / Inbox / Workspaces / Settings navigation and no unimplemented feature links. Local empty/connection states are truthful. Workspace selection and theme survive restart; preserve existing `cm-theme` with an explicit migration and provide system-mode handling without first-paint flash.
4. Host the existing setup/tools controllers and DOM **once** behind an adapter. Keep Engine/runner/PTY contracts, cancel/settle on a route change where current setup requires it, and preserve prompts, logs, health and update actions. Replace startup’s global runtime gate with per-CLI-action gating; the local shell never waits on it. Do not copy the prototype override scripts/CSS into production.
5. Add real Settings groups and workspace CRUD/archival. Legacy Home/checklist becomes Setup & tools overview; Installation, AI tools, Desktop, Health, Activity, Updates and About/usage retain their behavior. Workspace archive pauses its schedules; default Personal workspace remains available. A later permanent delete, if offered, previews/removes only workspace-owned records, never remote items or the installed tools.
6. Make native geometry resizable with defined minimum (initially 1000×700), default about 1360×900 bounded to available display, persisted safe bounds and restored off-screen positions. Adapt legacy log expansion to preserve current width rather than forcing 1000; keyboard/terminal overlays remain reachable at scaling factors.
7. Apply [DARK-THEME.md](DARK-THEME.md): neutral dark links/selection, correct card/header/raised surfaces, semantic status colors, real CodeMie primary gradient outline and local fonts. Keep light behavior stable. Test real WKWebView and WebView2, not just Chromium.

**Tests/exit:** T1-01–T1-12 and applicable L-series cases in TEST-PLAN; full JS/Rust gates; native boot/PTY smoke; actual macOS window interaction and Windows native qualification. Reject if any old CLI/proxy/update flow regresses, or a runtime failure blocks the workspace. Task 2 may begin only after Task 1’s required platform/legacy gates are passed or an explicitly scoped internal-development checkpoint is recorded; no release qualification is inferred from unavailable OS gates.

### Task 2 — Microsoft identity, read synchronization and real Calendar

**Deliverable:** select capabilities, sign in using the shared CodeMie registration, restart/refresh safely and see real calendar data in the native app. Mail/chat source ingestion is available for Task 3 without polling from views.

1. Implement public-client PKCE, native credential store, registration/tenant settings, cancellation and partial/expired/admin-consent states. Verify the registration’s actual redirect/scopes with a test tenant. No tenant setting is changed automatically.
2. Add typed Graph client with explicit endpoint/host policy, timeouts, paging, refresh single-flight, cancellation, correlation IDs and rate-limit handling. Use Task 1's common job primitives for durable/coalesced refresh. Respect supported corporate proxy and OS trust roots; never disable certificate verification. Preserve the restrictive CSP. Capture sanitized provider errors, never tokens or message bodies in diagnostics.
3. Implement canonical account-scoped calendar/mail/chat read sync and cursor/reconciliation rules from §3. Source selection, cache timestamps, per-capability disable, disconnect/purge and connection-generation invalidation are native operations. Keep manual decisions in separate versioned records.
4. Implement Calendar’s week/month/agenda and detail drawer, timezone/date navigation and provider open/join; load uncached windows on demand. Assign events to explicitly bound workspaces without duplicating the remote event. Calendar data never depends on a configured AI profile. Calendar reminder controls and actual OS delivery arrive together in Task 3; Task 2 does not advertise a non-operational reminder action.
5. Implement the **common prepare/approve/action-outbox/unknown-outcome path** now for reviewed event creation/focus blocks, using Task 1's durable records. Request incremental Calendars.ReadWrite consent and provider transactionId. Review attendee invitations and timezone. Task 3 reuses this path for replies. If a tenant refuses write access, read Calendar remains complete and “Open in Outlook” is offered; no locally painted fake Outlook event.

**Tests/exit:** T2-01–T2-18; actual browser sign-in + loopback on macOS and Windows, real test-tenant calendar comparison/create/verify, account-switch races, paging/throttling/offline and calendar-edge fixtures. Task 2 cannot claim working Graph from fixture-only tests or an existing Echo login. Read/write permission gates are reported separately.

### Task 3 — Inbox, durable queues, schedules and native notifications

**Deliverable:** real Outlook/selected Teams activity enters persistent lanes, supports safe manual actions, reminders and reviewed replies, and remains correct through restart, race and provider failures.

1. Implement source/conversation/incident identity and the lane/lifecycle rules in §4. Surface sender/time/quote/rule/confidence; preserve manual decisions. Sanitize provider HTML and block remote images/active content. Add local archive/restore, snooze, critical acknowledgement, workspace assignment and source-linked commitment confirmation.
2. Extend Task 1's native job foundation with Inbox/AI/reminder job types, full recurrence/sleep-wake policy, queue Settings and run/activity views. Use its existing SQLite claim/lease/cancel/recovery primitives. Add Calendar reminder controls and real notification delivery in this task, including occurrence reschedule/cancellation. Native scheduling works with every UI view hidden; explicit Quit stops it and future startup handles missed occurrences honestly.
3. Implement bounded, opt-in AI classification and editable draft generation on direct Claude and supported CodeMie-backed profiles. Capability-probe actual installed commands; pin job profile. Isolate source-reading runs in a staged context directory with no tool, hook, MCP or skill execution; prove the installed CLI's flags/config enforce that contract. If isolation cannot be enforced for that version/profile, block AI for this purpose and retain manual/deterministic behavior. Reply recipients follow the provider semantics and are independently validated.
4. Add native notification permission/status, click-to-open correct workspace/item, private previews, app quiet/focus rules and global critical dedup/ack. Use the transactional notification outbox, stable IDs, explicit limited repeat and cancel-before-delivery checks. Add tray settings and proper active-install Quit guard.
5. Implement reviewed mail/Teams replies and the action outbox with separate Mail.Send / ChatMessage.Send grants. Enforce the approval contract at the native boundary, including changed-content rejection and Unknown outcome handling. Scheduled jobs produce drafts; they cannot auto-send.

**Tests/exit:** T3-01–T3-24; fixture/failure/race cases and real mailbox/chat cycles; real OS permission allowed/denied/click/quiet states; restart/crash/sleep/wake; owned recipient-side send verification. Reject lost items on failed sync, duplicate incident alerts, cross-account content or an unreviewed/duplicated send. Any unverified native notification or live send gate remains BLOCKED, not passed by browser fixtures.

### Task 4 — live Today, integrated Settings and milestone qualification

**Deliverable:** the daily workspace is complete and coherent across Today, Calendar, Inbox and Workspaces; a packaged app passes the full migration/regression bar.

1. Connect Today cards to shared native snapshots and real action routes. Generate a useful deterministic brief even without AI; optional AI adds a sourced summary without introducing invented claims. Show actual source timestamps/profile/run status and provider-reported costs only. Missing services show a clear empty state, never fictional numbers.
2. Persist widget selection, width/order and keyboard/drag arrangement per workspace. Implement local focus/commitments and daily/weekday brief scheduling. Switching workspaces updates scope atomically; unfinished drafts require save/discard confirmation or remain explicitly scoped. Home badges/counts reconcile with Inbox and Calendar.
3. Finish Settings integration and migrations, permission recovery, export/redaction/reset semantics, lazy screen subscription cleanup, native accessibility and performance. Preserve install/terminal usability while jobs are queued/running. Check display scaling and theme transitions across every included screen/overlay.
4. Rebuild packaged macOS and Windows artifacts with repository build scripts, validate resources/upgrade identity, exercise the packaged application (not only a dev server), run all milestone and legacy cases, and produce source/build-specific evidence. Test fresh/offline startup and upgrade from the current Connect version with real configuration preserved.

**Tests/exit:** T4-01–T4-12 plus all earlier T/L cases. No known P0/P1 defects, all mandatory functional/tenant/native/platform gates PASS, lower-severity issues explicitly dispositioned, no unreviewed skips. Performance and soak thresholds in TEST-PLAN are met. This is a quality bar, not a promise that software can be proven free of every possible defect.

## 6. Preservation, migration and rollback contract

1. Establish source/build identifiers and user-state snapshots using non-sensitive hashes/redacted keys. Do not include real secrets or mail bodies in retained evidence. Release candidate tests run on isolated user/test resources; destructive installation/PATH/proxy/update tests use disposable macOS/Windows users or VMs.
2. Additive workspace storage has its own schema. No migration rewrites existing CodeMie profiles, npm prefixes, managed runtime or Echo files. Existing version metadata mismatch (npm 2.1.0 vs native 2.1.1) is pre-existing; do not incidentally change version/update compatibility while moving navigation.
3. Preserve legacy command names and event payloads, single PTY ownership, existing-CLI precedence and error handling. Introduce new workspace commands/events rather than changing unrelated existing contracts.
4. Back up/checkpoint DB before a schema migration. Migrations are transactional and repeatable. A failed or newer unsupported schema must preserve the file and offer recovery; no auto-delete/reseed. Define whether an older binary can open it; rollback may retain the newer workspace directory unused while legacy Connect still starts.
5. Internal feature flags can support incremental validation; the milestone release exposes only functional routes. If a workspace service fails, Setup & tools still opens. If the CLI runtime fails, local workspace and granted Graph read capabilities still work.
6. Do not open an MR/release or mark a task complete based on a mocked `invoke` bridge. Each completion carries actual evidence from the native source build and required test resources.

## 7. Approval and readiness

Approve this scope, four-task sequence and contracts as the basis for implementation. No Jira items, commits, production changes or external messages are created by this planning work. The dark palette correction is confined to the HTML prototypes.

Before connected tests in Task 2/3, provide an organization test account allowed to consent to the shared CodeMie registration, a second account for isolation tests, owned calendar/mailbox/chat recipients, and Windows execution access. These are execution prerequisites, not reasons to leave design/plan work unfinished. Tenant policy or signing/OS availability that cannot be satisfied must remain a named gate; the app is not declared fully verified until the required gates actually run.

Current planning baseline and limitations: [BASELINE-VALIDATION.md](BASELINE-VALIDATION.md). Detailed tests: [TEST-PLAN.md](TEST-PLAN.md). Independent review/dispositions: [ARCHITECTURE-REVIEW.md](ARCHITECTURE-REVIEW.md).


## Execution amendment — Microsoft session storage

At the user's explicit request during implementation, macOS uses Echo-style browser PKCE and a Connect-owned private JSON session cache instead of Keychain. See [AUTHENTICATION.md](AUTHENTICATION.md) for the verified Echo/CLI references, file-permission contract and migration behavior. No Keychain, Echo or CLI credentials are imported. The user authorizes existing-account read-only checks only; sends/calendar writes remain excluded. macOS is qualified first; Windows gates remain visible.


## Execution amendment — Calendar read synchronization

Native read-only testing exposed sparse initial calendar delta fields and interrupted large delta responses. M1 uses bounded `calendarView` snapshots with an explicit occurrence-metadata selection for both primary and additional calendars, following Echo's read path. Successful rounds reconcile only their requested range and atomically mark coverage; failed/partial rounds retain prior data. Calendar navigation queues background window jobs. Outlook Inbox/Sent retain per-folder message delta. This replaces the planned primary-calendar delta optimization; it does not change calendar write approval or source/account boundaries. Primary-calendar delta is not a passed implementation gate.
