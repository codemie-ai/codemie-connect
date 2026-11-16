# Milestone 1 — independent architecture review

**Reviewer:** separately spawned architecture-review agent requested by the user.

**Review date:** 16 November 2026.

**Method:** read-only source inspection of current Connect, Echo and the proposed implementation plan; no real credentials or customer message data read; no production implementation or native integration test performed by this reviewer.

**Final disposition: no open P0/P1 planning findings after revision. Architecture recommendation: approve this plan for implementation, subject to the user's approval.** The four-task structure and native-service architecture are sound. Three initial P1 findings were corrected in the implementation plan and checked against the completed test plan. This is approval of the proposed architecture, not qualification of an implemented milestone.

## Findings and required dispositions

| ID | Priority | Finding | Required plan change | Status |
|---|---|---|---|---|
| AR-01 | P1 | Task 2 initially promised background sync, local reminders and reviewed event creation before Task 3 introduced their job/notification/action foundations. | Establish common durable primitives before their consumers; deliver reminder controls and real delivery together. | **Resolved in the plan.** Task 1 step 2 establishes records/claims/leases/outboxes/clock/policy; Task 2 steps 2 and 5 use them for sync and secured event creation; Task 3 extends them. Reminder controls/delivery move together to Task 3. Checked T1-04, T2-14/15, T2-11's deferred reminder check and T3-06/09/10/11/12/17/19. |
| AR-02 | P1 | The initial single-active-account contract did not explicitly bind workspaces and saved rules, leaving Personal ambiguous after A → B. | Specify nullable stable workspace/connection bindings, first connection and explicit reassignment. | **Resolved in the plan.** ADR-M1-02's Workspace/account binding paragraph makes local workspaces unbound, prompts at first binding, preserves A-bound Personal, offers B a new/unbound workspace and requires reviewed reassignment with old selections cleared. T2-05 and T4-05 check these transitions/races. |
| AR-03 | P1 | Logout generation alone did not cover local scope narrowing or a finishing job after workspace archive/profile revocation. | Add policy revisions checked at claim, dispatch and commit, with cancellation and stale-result/approval rejection. | **Resolved in the plan.** ADR-M1-02's Narrowed policy paragraph specifies connection/workspace/profile revisions, invalidation boundaries and archived/unavailable mutation semantics. T3-23 tests disable/remove/archive/revoke at all boundaries; T4-02/05 cover brief and cross-screen races. |

“Resolved in the plan” means that the actual revised contract and corresponding cases were inspected. It does not mean the production behavior has already been implemented or tested.

## Non-blocking implementation notes

- **AI isolation:** Task 3 step 3 now explicitly requires a staged source-reading context without tool/hook/MCP/skill execution and blocks unsupported versions/profiles rather than weakening isolation. Preserve that requirement in T3-14/15; “network disabled” in the general description means network tools, not the approved provider connection itself.
- **Conservative classification:** FYI fallback applies to otherwise unmatched sources. An existing deterministic direct-request or critical candidate must not be downgraded merely because AI failed or its output is invalid. The explicit precedence rule should be visible in the cases.
- **Credential portability:** the revised SecretStore contract now covers Keychain and Windows DPAPI-protected per-user refresh storage or a proven large-token backend, access tokens preferably in memory, no plaintext fallback, and locked/denied/re-signed/long-token cases. T2-04/18 carry the execution obligations.
- **Native notification semantics:** submitted-to-OS is not user-visible delivery. The plan correctly avoids claiming an OS DND bypass or fully atomic exactly-once toast display; retain those limits in UI wording and QA evidence.

## Contracts accepted in the draft

1. **Installer preservation and boot separation.** Keep the current JS Engine/controllers/runner contracts, mount the legacy UI once, retain cancel/settle semantics, and move runtime readiness from global application boot to CLI-dependent actions. This is required by current `ui/renderer.js:300–345,709–768` and `ui/setup-leave.js:10–12`.
2. **Native work beside the installer.** A scoped WorkspaceCore with a serialized durable repository, native Graph I/O, bounded jobs and thin IPC is appropriate. It is an explicit extension to Option B for new long-lived work; it leaves installer orchestration in JS. Preserve PATH initialization ordering in `src-tauri/src/lib.rs:13–77` and the single installer PTY ownership in `src-tauri/src/state.rs:15–18` and `commands/pty.rs:152–165`.
3. **Native geometry migration.** The plan addresses `tauri.conf.json`'s fixed window and `commands/window.rs:7–18` resetting width to 1000. Both must change together, with legacy log and scaling checks.
4. **Shared registration, independent credentials.** Echo's `graph.rs:31–62,262–340` establishes the CodeMie public-client/system-browser PKCE reference. Sharing the registration does not share tokens or turn CodeMie platform SSO into Graph authorization. The proposed per-app native secret store, incremental capability checks and live tenant validation are appropriate.
5. **Accurate Echo reuse boundary.** `needs.rs:1–11,305–316,433–443` implements tagged/hot “Needs you now” and periodic refresh, not the complete six-lane future Inbox. `needs.rs:44–51,294–328` preserves user decisions after slow reads; `attention.rs:515–548` preserves open items when a source failed. The plan correctly treats the broader Inbox as new Connect implementation and does not copy AGPL runtime modules into Apache-licensed production code.
6. **Graph API and sync boundaries.** The plan separates primary-calendar window delta, additional-calendar reconciliation, folder mail delta and selected-chat paging; it avoids a fictitious universal Teams delta. It covers immutable Outlook IDs, opaque cursor handling, allowed hosts, throttling, complete-vs-partial results and no cross-origin bearer forwarding. Timezone handling must not copy Echo's non-UTC-as-local shortcut at `calendar.rs:47–58`.
7. **Outward actions.** Native approval binds account, resource, recipient set and exact body/action revision. Provider acceptance differs from delivery, and ambiguous mail/Teams send outcomes must not blindly retry. Calendar creation has its own transaction ID. Background jobs cannot mint approval. These are sound boundaries.
8. **Lifecycle and notification scope.** One native process owns jobs, close-to-background is configurable, explicit Quit stops work, wake/relaunch performs bounded catch-up, and OS DND is respected. The scope excludes recording, arbitrary automation scripts and unimplemented plugin/Telegram/phone routes.
9. **Qualification.** Fixture tests, source tests and Chromium layouts are separate from real Tauri/OS/tenant/packaged-app checks. Windows and connected-service gates must remain named and BLOCKED if unavailable. Existing installer tests and disposable-user/VM checks remain mandatory after each relevant increment.

## Review of test coverage

The completed TEST-PLAN.md was reviewed in the second pass. It contains **66 task scenario groups** (12 + 18 + 24 + 12) and **16 legacy scenario groups**, with unique IDs. It distinguishes unit/property (U), native services (I), browser integration (B), native fixture E2E (N), connected native E2E (C) and packaged/upgrade E2E (P).

- AR-01–AR-03 have the explicit coverage listed in their dispositions above.
- Graph cases cover shared-registration login, state/cancellation, scoped consent, refresh rotation, account binding/isolation, paging/cursor invalidation, malicious pagination links, throttling, timezone/recurrence and real reviewed event creation.
- Inbox cases cover preserved decisions under slow sync, external replies/reopening, evidence and precedence, critical episodes/global ack/snooze, job leases, DST/wake behavior, headless isolation, native notification permission/display/click/quiet behavior, native approval, observed live send and ambiguous outcome recovery.
- Today and qualification cases cover canonical counts, scoped source citations, layout persistence, missing event recovery, actual native webviews/scaling, export/reset, measured performance, eight-hour soak and packaged upgrade/rollback.
- L01–L16 preserve setup/auth/tool/runtime/PTY/proxy/health/log/analytics/updater/path behavior in isolated test users/VMs. Required Windows and live-tenant gates cannot be converted to PASS by browser fixtures or availability assumptions.

One execution clarification: Task 3's brief catch-up example in T3-12 is scheduler-policy coverage using native fixture/service infrastructure until Task 4 supplies the finished Today brief. Actual user-facing brief output and its live citations belong to T4-02 and the T4-09 soak. A fixture scheduler result must not be reported as a live brief result. This does not block the architecture or require another milestone task.

## Existing-baseline test-safety prerequisite

**Independently source-verified; open in existing production source, planned for Task 1.** `ui/renderer.js:992–1005` describes `CODEMIE_PROBE_SMOKE` as detection-only, but `runProbe` filters the current Engine to step IDs `2.3.3`, `2.3.5` and `2.4`, then calls `engine.run()`. Those IDs are not an immutable read-only API: `ui/handlers.js:84–92` dispatches the first two to `codemie setup` and `codemie install claude --supported`. `config/steps.yaml:6–14` currently names the same setup/install actions, and `src-tauri/src/steps.rs:54–57,77–84` embeds and loads the current platform YAML. The detection-only comment therefore does not establish a non-mutating probe.

Task 1 step 1 and T1-08 now correctly require replacing that probe dispatch with explicit read-only inspectors and negative mutation assertions **before invoking it**. This is a source-confirmed existing test-safety hazard, separate from the resolved AR-01–AR-03 planning findings. It was not executed by this reviewer.

The separate benign `CODEMIE_SMOKE` renderer/stream/PTY result reported by the main agent belongs to BASELINE-VALIDATION.md; it is not execution or qualification of `CODEMIE_PROBE_SMOKE`. No production code was changed by this review or the planning work; repairing the unsafe probe remains future approved Task 1 implementation.

## Final disposition

**No remaining P0/P1 blockers in the reviewed planning contracts.** Recommend proceeding with the four-task sequence after user approval. Keep the documented non-blocking implementation obligations, mode distinctions and stop conditions in the actual task execution reports.

The reviewer changed only this review document. Native implementation, live Graph/OAuth, OS notification behavior, native dark-theme qualification and the milestone's future test cases remain unexecuted by this review. Current-app baseline evidence is separately owned by BASELINE-VALIDATION.md; it cannot establish that these planned capabilities already work.
