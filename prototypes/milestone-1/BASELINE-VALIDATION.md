# Planning baseline — what actually ran

**16 November 2026. This is the current unchanged Connect application baseline and the prototype palette correction. It is not a claim that milestone 1 has been implemented.**

Source: `8be17640b2ed2a4417a5450afef58c505debd358`; no tracked production diff. macOS 27.2, arm64; rustc/cargo 1.96.0; Node 25.2.1. Native debug artifact identity and SHA-256 are in [baseline-environment.json](evidence/baseline-environment.json). These host versions do not establish minimum-OS/MSRV compatibility; those remain implementation/package gates.

| Check | Result | Actual evidence / limits |
|---|---|---|
| Current JavaScript suite | PASS with platform skips | 523 cases: **520 passed, 0 failed, 3 skipped**. The three are Windows shim cases skipped on this Mac. [Log](evidence/baseline-js.log) |
| Rust format | PASS | `cargo fmt --check`, exit 0. [Log](evidence/baseline-rust-fmt.log) |
| Current Rust suite | PASS | **124 unit tests + 2 integration tests passed**, 0 failed; binary/doc targets have 0 tests. [Log](evidence/baseline-rust-tests.log) |
| Clippy | PASS | `cargo clippy -- -D warnings`, exit 0. [Log](evidence/baseline-rust-clippy.log) |
| Native source build | PASS | `cargo build` produced the unchanged Tauri app. [Log](evidence/baseline-native-build.log) |
| Real Tauri native smoke | PASS | Started that compiled debug app with documented `CODEMIE_SMOKE=1`; no mocked Tauri bridge. Native renderer reported no boot error, dark background `rgb(26,26,26)`, actual streaming IPC exit 0 and PTY marker/exit 0; `SMOKE_OK`; process exited 0 after 3.71 s. Identity was redacted before retaining stdout. [Log](evidence/baseline-native-smoke.log) |
| Live CodeMie dark-role inspection | PASS | Used Chrome extension and actual Appearance → Dark, measured theme roles, restored original Light preference. Only tokens retained. [Snapshot](evidence/live-codemie-dark-tokens.json) |
| Corrected prototype theme | PASS | **120 browser checks**: 35 screens in dark at 1000/1360/1600 px (105), plus five milestone screens in light at the same widths (15). No page errors, empty pages or unexpected content overflow. Neutral dark accent `#F2F0EF`; light remains `#007AFF`. Chromium 157.0.8103.51. [Results](evidence/theme-check.json) |
| Independent architecture review | PASS after revisions | AR-01/02/03 corrected and re-reviewed; no open P0/P1 planning blocker. [Review](ARCHITECTURE-REVIEW.md) |
| Current detection-only probe | NOT RUN — existing safety defect | The current step-ID filter can invoke setup/install; see B-01 below. It must not be treated as a harmless regression command yet. |
| Genuine install/remove/PATH/proxy/update operations | NOT RUN in this planning baseline | These are not needed to author the plan and may alter the user's live setup. They are mandatory applicable L-series cases during implementation, in disposable users/VMs. Native smoke does not establish them. |
| Real M1 Graph/OAuth/Calendar/Inbox/scheduler/notifications | NOT IMPLEMENTED / NOT RUN | Future work. A successful CodeMie website sign-in is not a Microsoft Graph integration test. No live Graph credentials, mail or Teams messages were read for this planning baseline; no Graph write or recipient send occurred. |
| Windows native and installed release artifacts | NOT RUN | Not executable on this Mac; named required implementation/qualification gates. A macOS unit/build pass cannot qualify Windows. |

## B-01 — existing probe no longer matches its safety comment

**Source-confirmed test-safety defect; not runtime-reproduced by executing the unsafe mode.**

- `ui/renderer.js:992–1005` describes `CODEMIE_PROBE_SMOKE` as detection-only, filters step IDs `2.3.3`, `2.3.5`, `2.4`, then executes the Engine.
- `ui/handlers.js:84–99` maps those IDs to `codemie setup`, `codemie install claude --supported` and `codemie doctor`.
- `src-tauri/src/steps.rs` embeds current `config/steps.yaml` / Windows counterpart; there is no separate read-only probe plan. The macOS config names setup and install as interactive steps.

The mode was **not launched**. Task 1 must replace probe dispatch with explicit read-only inspectors and add tests that reject setup/install/PATH/profile mutations. The separate benign `CODEMIE_SMOKE` path only exercised renderer + known stream + known PTY self-tests and passed. Do not conflate the two modes or hide this limitation behind the green unit suite.

## Dark palette correction

Only the HTML prototype stylesheet was changed: ordinary links/selection now use CodeMie's neutral dark roles; lavender remains a status color. Light mode is preserved. Production implementation has not started.

![Corrected prototype dark theme](evidence/dark-theme-today.png)

This screenshot is from the full design library. Knowledge, Meetings and plugin cards shown there are later scope; the M1 implementation plan explicitly defines the smaller first milestone and removes non-operational routes from its real app navigation.

## How implementation evidence differs

The [82 planned scenario groups](TEST-PLAN.md) are **PLANNED**, not passed by this report. Every task completion will attach actual source/build/OS-specific results, including native window behavior and applicable live tenant/provider checks. Eight-hour soak, install/upgrade/rollback, send acceptance and recipient verification, sleep/wake and native notification permission/display checks must actually run before their gates can be marked PASS. Missing access/resources remain BLOCKED; no browser fixture is a substitute.
