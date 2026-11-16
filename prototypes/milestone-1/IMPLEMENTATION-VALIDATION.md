# Milestone 1 — implementation validation

**Branch:** `feat/milestone-1-workspace`. **Qualification:** macOS first, with remaining connected/platform gates explicit. This report does not declare the complete 82-group release bar passed.

## Implemented scope

| Increment | Delivered behavior | Verification boundary |
|---|---|---|
| 1 — shell and local state | Today, Calendar, Inbox, Workspaces, Settings; light/dark/system; native SQLite state, revisions, operation deduplication; single instance; safe geometry; original installer mounted once and lazily | Automated regression, native local workflows and packaged launch; destructive legacy operations require a disposable user/VM |
| 2 — Microsoft | Native system-browser PKCE with shared CodeMie registration; explicit capabilities/account binding/source selection; native read sync, Calendar windows/cursors; reviewed event outbox | Read-only Calendar, Outlook and selected Teams reads pass with the Echo-style own-cache flow; no live writes |
| 3 — Inbox and work | Six native lanes, deterministic policy/manual decisions, local drafts and commitments; durable jobs, schedules, private native notifications; reviewed replies; bounded optional AI jobs with pinned profile/source and process cancellation | Repository/HTTP/process tests and browser flows pass; no live sends or calendar writes are authorized |
| 4 — Today and integration | Real canonical cards, deterministic sourced brief, local focus/notes, per-workspace widget selection/order/width; Settings/updates/exports; packaged macOS app and DMG | Local native and browser checks; full OS notification, upgrade, load and soak bar remains separate |

The core works without CodeMie, Node or Claude setup. Echo plugin execution, Knowledge, full Chat, recording, marketplace and Delivery remain outside this approved first milestone. Optional source-reading AI supports only the isolated API-key profile whose installed CLI enforces the required flags; unsupported Claude OAuth/CodeMie profiles fail closed with a reason. AI output is a local suggestion, explicitly loaded into the reply editor, and cannot send.

## Automated results

Final counts and build digests are recorded in [evidence/implementation-build.json](evidence/implementation-build.json): **529 JavaScript passes, 3 Windows-only skips; 166 Rust unit passes and 2 integration passes; 98 browser checks, no errors**. Formatting, Clippy and final app/DMG resource assertions pass. The final optimized app was opened again after packaging; all five routes, light/dark switching and the persisted local note passed, then Quit exited 0. Successful commands: repository `npm test`; `cargo fmt --check`, `cargo test`, `cargo clippy -- -D warnings` from `src-tauri`; repository `build-installer.sh --skip-stage` including all resource/shim assertions.

Browser integration uses the real frontend modules and an **explicitly mocked IPC bridge** (`ui/test/browser/workspace-check.js`). It is not native Graph or notification proof. It covers both themes at 1000/1360/1600 widths, all Settings groups at minimum geometry, workspace creation/archive, commitments, focus, schedules, escaped source HTML, reviewed-action flow, widget width persistence, note autosave/clearing, notification deferral, reply close/save/discard and explicit needs-sign-in state.

Native tests include real SQLite transitions and local controlled HTTP responses: permissions/cursor expiry, throttling, redirect rejection, malformed/oversized pages; DST boundaries; account/capability/source isolation; stale claims; operation replay; calendar-window reconciliation; unresolved rolling-window retention; 10,002/20,002 unrelated-record regressions; atomic incident+occurrence and brief+job commits; snooze of a claimed alert; pinned AI scheduling, cancellation after a paused probe, and killing only an owned synthetic process. Credential-cache tests use synthetic tokens in temporary directories only.

## Native macOS observations

- Packaged debug WKWebView: local startup and all primary views, commitment create, note autosave across navigation, local workspace create/archive, light/dark, privacy export, app updates view, single-instance activation and idle Quit.
- A real UTC weekday brief schedule ran successfully while another workspace and Settings were selected. The native repository contained one successful occurrence and one brief; no Microsoft connection existed in this test profile.
- Packaged optimized release: all five primary views opened in a fresh temporary HOME; a local note and appearance persisted after Quit/relaunch. Its isolated repository had zero Microsoft connections.
- Native benign stream/PTY smoke: stream exit 0; PTY exit 0 with expected marker; `SMOKE_OK`. Repaired detection-only probe completed with Git/Node/npm/CLI inspectors only; negative allowlist tests exclude install/setup/PATH mutations.
- Staged CLI verification runs with temporary HOME **and cwd**, preventing incidental project/profile migration. The tracked CLI configuration and CLI dependency lock stayed unchanged.

## Microsoft read-only validation

The user authorizes their existing signed-in account for reads only. No mail/Teams send, invitation or calendar mutation is performed. No credential/consent prompt is approved automatically.

Earlier native sign-in and a real Calendar week read succeeded. A rebuild/restart then exposed an inability to reopen the Keychain credential; cached data was retained. That runtime observation was not marked successful. The user directed that Keychain not be used, and the Keychain-backed test process was stopped.

Connect now uses a private macOS file cache following Echo/CLI, documented in [AUTHENTICATION.md](AUTHENTICATION.md). It neither reads nor migrates any Keychain, Echo or CLI credential. The old Keychain entry is untouched. The production Keychain dependency/calls have been removed. A fresh browser sign-in using the existing signed-in account succeeded without a credential, consent or Keychain prompt. After Quit/relaunch, Connect reused only its own session file and completed live reads. Cache inspection was limited to file count and modes: one file `0600`, containing folder `0700`; no tool read token contents.

A live Calendar delta response exposed sparse event fields. Calendar sync now uses bounded calendarView snapshots with explicit metadata selection for primary and additional calendars, matching Echo. Complete ranges and coverage commit together; partial failures retain prior data. Calendar delta is a documented plan amendment, not a passed production path. The projection follows the [Microsoft calendarView contract](https://learn.microsoft.com/en-us/graph/api/calendar-list-calendarview?view=graph-rest-1.0), including its selected-field restrictions. The live completed range contained **473 events with zero missing titles**. The native Week view rendered **65 event buttons**. Older out-of-range cached records from the earlier delta experiment are not represented as newly refreshed or validated.

The same connected native run completed synchronization of **74 Outlook Inbox messages, 13 Sent messages and 89 messages from one explicitly selected Teams conversation**, with a one-day initial mail/chat window. The native Inbox showed six queues (0 Critical, 2 Needs reply, 0 Waiting, 155 FYI, 19 Low priority, 0 Decisions at observation) and both source types. The account stayed `connected`, sync jobs succeeded, Calendar coverage committed, all three write capabilities stayed off, and there were **zero outbox actions**. Counts are a point-in-time observation, not a promise about future mailbox contents. No real subjects, bodies, account IDs or tokens are retained in the evidence.

On macOS, Graph GETs use system curl, matching Echo, because the prior HTTP transport failed while reading live Calendar bodies. Bearer configuration uses stdin, curlrc and redirects are disabled, TLS stays verified, and bounded body/header pipes avoid persistent response-header files. The final source review found no P0/P1 in this transport. After the final rebuild, a new native process completed sync using only its own cache (`lastSync` later than launch), and explicit Quit left zero header files. An unbound restored QA workspace displayed zero Calendar rows and zero Inbox counts; archiving it returned to Personal without exposing provider records.

## Open gates

| Gate | Status and reason |
|---|---|
| Microsoft session restart, selected Outlook/Teams and final Calendar projection | **PASS for this authorized account and selected sources** — fresh browser sign-in, own-cache restart, completed read sync and native views; no credential import. Independent Outlook/Teams application count comparison is not claimed |
| Live event creation, Outlook reply, Teams reply and recipient-side exactly-once observation | **BLOCKED by read-only authorization**; deliberately not executed |
| Second Microsoft account / tenant isolation and consent-denial variants | **BLOCKED** — no second QA account/tenant supplied; native repository fencing tests pass |
| Real OS notification allow/deny/display/click/DND/background matrix | **NOT FULLY RUN**; OS-managed submission status is honest, not a delivery claim; no permission prompt is approved automatically |
| Real Claude/CodeMie AI-provider generation | **NOT RUN**; no live model credential use/source transmission authorized for QA; manual and deterministic flows remain available |
| Destructive legacy install/update/remove/proxy/PATH/profile and upgrade/rollback matrix | **NOT FULLY RUN** — needs disposable OS user/VM; existing unit suite and benign native smoke pass |
| Windows WebView2, SDK build, notifications and installer/upgrade | **BLOCKED** — this Mac's cross-check stopped at missing Windows SDK C headers (`assert.h`). User explicitly chose macOS first; no Windows pass claimed |
| Intel macOS, external display removal, 150/200% native scaling | **NOT RUN** on this Apple Silicon host |
| 30-run launch/UI latency distribution and selected 10,000-item native UI load | **NOT RUN**; volume correctness tests are not performance qualification |
| Eight-hour mixed foreground/background soak with three sleep/wake cycles | **NOT RUN**; short checks do not replace it |
| Distribution signing/notarization and clean/upgrade installation in disposable users | **NOT QUALIFIED** by a local app/DMG build |

## Review and defects fixed

The architecture subagent performed source review separately from runtime checks. Fixed findings include resource identity collisions, stale policy/claim commits, provider-result replay, calendar reconciliation boundaries, notification/crash ambiguity, source-filter limits, cross-workspace retention, presentation/access revision separation, atomic incident scheduling, claimed snooze, manual Calendar source fencing, and cancellation during the AI capability probe. The final targeted reviews found no remaining P0/P1 in their inspected scope; they did not perform runtime or credential tests.

Additional browser/native fixes include unsaved notes on dialog close, cleared notes on navigation, scoped notification navigation, protected reply edits, update availability retention and the native session-recovery status.

## Reproducing local checks

Run `npm test` at repository root. Run `cargo fmt --check`, `cargo test` and `cargo clippy -- -D warnings` in `src-tauri`. Rust tests that bind local listeners need normal loopback permission. Serve `ui/` on an available loopback port, navigate Playwright to it, then execute the browser check file. Fixtures exist only in that browser test bridge and are never loaded by the production app. Use the repository build script to assert the real app/DMG resources.

Debug-only `CODEMIE_WORKSPACE_TEST_DIR` isolates native workspace data; it is ignored in release builds. Release QA used a fresh temporary HOME instead. Never run a connected test against an imported credential cache. Retain aggregate counts and synthetic screenshots only, never real message bodies, auth URLs/codes or tokens.
