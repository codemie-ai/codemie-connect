# Preserve Connect while changing its home

No application files are changed in this proposal. The current Rust command layer, frontend install engine and controllers remain the implementation starting point after design approval.

| Existing capability | New location | Preserve in implementation |
|---|---|---|
| Home onboarding checklist | Today setup banner + onboarding | Existing-install detection, optional steps, resume and dismiss behavior. A successful setup removes the banner; a failure leaves a recovery path. |
| Runtime preparation | Settings → Setup & tools → Installation | `runtime_ready`, `ensure_runtime`, existing CLI reuse, app-managed Node/CLI, download integrity and retry. Prepare CodeMie runtime only for a CodeMie path, not before local/direct workspace use. |
| Interactive CodeMie configuration | Installation → Through CodeMie | Existing setup driver, PTY prompts, provider choice (SSO/BYOK/local), project and auth gates. Keep leave/cancel behavior. |
| Claude Code engine installation | Installation + AI tools | Existing handlers and approval sequencing. Direct Claude uses its own detection/install/account adapter. |
| Tools list | AI tools | List, install, update and remove; show command result and per-tool failure/retry. |
| Claude Desktop connection | Desktop connections | Sign-in preflight, Connect, Restart and confirmed Disconnect. Disconnect removes Desktop configuration; proxy stays running. Explain restarting Desktop. |
| Health | Health tab | Current account checks and doctor grouping, plain-language remediation, detailed diagnostics and CLI debug log access. |
| “What CodeMie ran” | Activity log + contextual progress | Keep command/output visibility, per-row expand and copy. Setup can open a terminal for genuine interactive steps. |
| CLI updates | Updates tab + contextual notice | Existing update parser/controller, error handling and current-version detection. |
| Native app updates | Updates + Today notice | Existing app updater, manifest/integrity validation and workspace-preserving restart. Active recording/setup must gate restart. |
| CLI usage analytics | Usage → CLI usage analytics | Keep existing report generation/open command; separate local observations from provider-reported cost. |
| Theme and shell | Shared workspace shell | Carry theme through overlays, terminal, pages and plugins. Save UI preferences without changing provider credentials. |

Source map: `ui/renderer.js`, `home-view.js`, `home-state.js`, `setup-driver.js`, `engine.js`, `handlers.js`, `runner-bridge.js`, `agents-controller.js`, `health-controller.js`, `disconnect.js`, `cli-update.js`, `command-log.js`, `analytics-command.js`; native `runtime.rs`, `inspector.rs`, `pty.rs`, `app_updater.rs` and `lib.rs`.

## Delivery sequence after approval

1. **Shell + safe relocation:** add routing and Settings pages around existing controllers. Keep current behavior available while testing relocation. Make the workspace window resizable: current Tauri config is fixed at 1000×660 and `resizable: false`.
2. **Local workspace + profile boundary:** Today, local Knowledge and spaces. Make startup independent of CodeMie preparation. Implement direct-Claude detection/account/session routing separately from CodeMie gateway setup.
3. **Plugin host foundation:** resolve licensing, implement the versioned Echo contract, package lifecycle and conformance gates. Native plugin execution is not a frontend-only change.
4. **Meetings + Microsoft 365:** consented capture, transcription/runtime management, Graph account/capability lifecycle, caches, reviewed minutes and guarded outward actions.
5. **Connected workflows:** Ask/ingest/health, routines, people and plugin dashboards. Roll out only verified capabilities; make unavailable services clear.

## Gates to retain

Existing installer and controller tests; native smoke modes; CLI/SSO/PTY flows; real install, update, repair and uninstall on supported macOS/Windows environments; direct-Claude without CodeMie; failed/expired account recovery; real tenant consent behavior; recording permissions; background and sleep/restart behavior; plugin conformance and a same-package run in both hosts.

The prototype browser report does not satisfy these native gates. Detailed specs and implementation tickets should follow approval of the screens and behavior.
