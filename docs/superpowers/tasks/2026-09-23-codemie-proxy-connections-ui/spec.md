# Spec: Connections Screen (EPMCDME-14574)

## What

Replace the single-app, hardcoded `#connect-view` (`ui/index.html:196-225`) with a data-driven
Connections screen listing 4 client-app rows, each with its own status and action. Reached from
the same Home-grid tile as today (`data-action="connect-desktop"`, generalized), not the sidebar.

Apps (per approved parent-story wireframe "4. Connections", EPMCDME-14350):

| Row | CLI connect flag | CLI disconnect flag |
|---|---|---|
| Claude Desktop | `--claude-desktop` | not yet supported by CLI (see Open Risks) |
| VS Code — Copilot Chat (BYOK) | `--vscode` | not yet supported by CLI |
| VS Code — Claude Code extension | `--vscode-claude-code` | not yet supported by CLI |
| Codex desktop app | `--codex-desktop` | `--codex-desktop` |

This supersedes the ticket's literal "3 apps" / "`codemie proxy connect [app]`" wording — verified
against the installed CLI and confirmed with the user.

## Per-row status model

Composite, computed client-side per app, no new Rust command required for status:

- **App not installed** — the client app itself isn't present on the machine. Action: **Install and
  connect**, shown but disabled — the actual install flow is out of scope for this ticket and lands
  in a future ticket; the row surfaces the affordance now so it isn't a second UI change later.
- **Not set** — app installed, but its config file (via the existing path getters:
  `getDesktopConfigPath`, `getCodexDesktopConfigPath`, `getVsCodeLanguageModelsPath`,
  `getVsCodeClaudeCodeSettingsPath`) does not exist. Action: **Connect**.
- **Connected** — config file present AND `codemie proxy status --deep` currently succeeds.
  Action: **Disconnect**, enabled for all 4 rows (see Open Risks — CLI parity resolved).
- **Disconnected** — config file present but `codemie proxy status --deep` fails (daemon dead,
  machine rebooted). Two actions, matching the parent-story mockup: **Reconnect** (`connect
  --force`) and **Remove setup** (`disconnect`).

No standalone proxy start/stop control. `codemie proxy status --deep` is a daemon-level-only check
(no per-app info) and is never surfaced as its own toggle — only used as one input to each row's
composite status, per the parent story's confirmed principle "no gateway concept in the interface."

## Row visual design (corrected 2026-09-24)

Original approval used a plain uppercase status-badge pill and a single "Fix" button for the
Disconnected state; corrected to match the parent-story mockup's visual language in full, per user
review of the running UI against EPMCDME-14350's wireframe:

- A colored status dot precedes the app name (green = connected, orange = disconnected, grey =
  not set, blue = not installed).
- A subtitle line under the app name shows the human-readable status.
- The card's border color matches the status dot color, for visibility at a glance.
- Actions stay right-aligned; a disabled action's note (e.g. "Install flow coming soon") is a
  hover tooltip (`title` attribute) rather than inline text.
- Disconnected rows show **two** actions — Reconnect and Remove setup — matching the mockup.

## How

- **Frontend view layer** (`ui/index.html`, `ui/renderer.js`, `ui/styles.css`): replace
  `#connect-view`'s two-button layout with a 4-row list. Reuse `runAction()`
  (`ui/renderer.js:352-361`) for the connect/reconnect PTY calls, and `ensureAuthenticated()`
  (`ui/renderer.js:368-386`) as the existing pre-action gate.
- **New pure-JS parser module**, mirroring `ui/signin-parse.js`: parses `codemie proxy connect`
  output for success/failure (don't trust exit code, per existing convention) and parses
  `codemie proxy status --json --deep` output into a typed health result. Unit-tested with
  `node:test`, no browser globals, mirroring `ui/test/signin.test.mjs`.
- **Config-file presence check**: read the 4 known paths from the Rust side (mirroring the
  existing connector path getters) via a thin new Rust command returning file-exists booleans —
  or, if those getters are reachable from JS already, do it client-side. Confirm during planning
  which surface currently exposes the paths; this spec only fixes the *shape* of the check
  (file-exists + `status --deep`), not which layer performs the file read.
- **PTY serialization**: all 4 rows' actions and the periodic-ish status check share the app's
  single global PTY slot (`src-tauri/src/state.rs`). Disable all row actions while any one PTY
  operation is in flight, consistent with no existing queuing mechanism.
- Preserve the `CODEMIE_SMOKE=1`/`CODEMIE_PROBE_SMOKE=1` exclusion already applied to
  proxy-connect actions (`README.md:227`).

## Non-goals

- No Claude Desktop / VS Code installer download flow (explicit ticket exclusion) — "App not
  installed" rows show a disabled "Install and connect" button, not a working install-and-connect
  path; wiring it up is future-ticket work.
- No visible proxy start/stop control, and no raw daemon-status surface — daemon health is only
  ever shown as an input to a row's composite status.
- No sidebar reveal — `#app-sidebar` stays hidden; entry point is the existing Home-grid tile.
- No reimplementation of connector config-parsing logic — only file-presence checks against
  existing path getters, never reading/interpreting file contents.
  - **Exception (recorded post-implementation, CR-002)**: the two VS Code checks
    (`vscode_copilot_connected`, `vscode_claude_code_connected` in `connectors.rs`) parse
    `chatLanguageModels.json`/`settings.json` content instead of doing existence-only checks. This
    is a deliberate, researched override, not a drift: VS Code's own path getters for these files
    live only in an unreachable external CLI package, and a pure existence check can't distinguish
    a CodeMie-managed entry from any other content written to the same file by another extension.
    Codex Desktop's check is also content-based (non-empty state file, not just existence), for a
    third reason: `disconnect` overwrites rather than deletes its state file. Claude Desktop's
    check was existence-only at first release but was later found to have the same gap as Codex
    (`disconnect` empties its applied config to `{}` rather than deleting it) and was fixed to
    match — it is now the only one of the four still doing a *generic* content check (empty vs.
    non-empty / empty-object) rather than key-aware parsing.
- No `codemie proxy list` usage (does not exist) and no local-only "last known state" tracking
  that could go stale if the user connects/disconnects from the terminal directly.

## Open Risks

- **Disconnect CLI gap — resolved.** The installed CLI's `codemie proxy disconnect` originally
  only supported `--codex-desktop`; the other 3 flags were tracked separately as EPMCDME-15246,
  which the product team approved and which ships alongside this feature. The interim
  disable-with-"CLI support pending"-note UI this risk originally called for has been removed —
  Disconnect/Remove setup is now enabled unconditionally for all 4 rows. Bundling the CLI release
  that includes EPMCDME-15246 (`assets/codemie-cli` currently still pins an older version) is
  tracked as a release-readiness item, not a UI concern.
- Exact Rust-vs-JS layer for the config-path-existence check is left to planning (see How).
