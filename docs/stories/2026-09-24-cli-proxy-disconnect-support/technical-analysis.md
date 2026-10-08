# Technical Analysis — CLI proxy disconnect support

**Note:** target implementation repo is the `codemie` CLI (`@codemieai/code`), not this repo
(`codemie-claude-installer-macos-tauri`). The `tech-analysis-orchestrator` skill would search this
repo's codebase, which does not contain the CLI source — skipped in favor of the findings already
captured in the source doc (written during scoping of EPMCDME-14574, where this gap was discovered).
Source: `docs/superpowers/tasks/2026-09-23-codemie-proxy-connections-ui/new-ticket-cli-disconnect.md`.

## Findings

- `codemie proxy connect` supports 4 client targets: `--claude-desktop`, `--vscode` (Copilot Chat,
  BYOK), `--vscode-claude-code` (Claude Code extension), `--codex-desktop`.
- `codemie proxy disconnect` currently only implements `--codex-desktop`. The removal logic for the
  other 3 was never built — not a missing flag.
- Reference implementation to mirror: `codex-desktop`'s `removeCodexDesktopConfig()` (Codex connector
  module) strips CodeMie's managed block from the shared `~/.codex/config.toml`, restoring a
  `.codemie-backup` if the managed region can't be cleanly stripped. A dedicated ownership-tracking
  file (`~/.codemie/proxy/codex-desktop-state.json`) records what CodeMie owns there, separate from
  the shared config. `disconnect-orchestrator.js` wires `--codex-desktop` to this function.
- Per-app removal target, each a "find and remove only CodeMie's managed slice of a shared file"
  operation (not a file delete):
  - **Claude Desktop**: config at `~/Library/Application Support/Claude-3p/configLibrary/`, with
    `_meta.json` pointing at an `appliedId` whose file is the actual applied config. Connect already
    has merge logic (`mergeManagedMcpServers`, `reconcileManagedMcpServers`); removal needs the
    inverse — undo only CodeMie's managed MCP entries, leave the user's other entries intact.
  - **VS Code Copilot Chat (BYOK)**: config at `.../Code/User/chatLanguageModels.json`, a shared JSON
    array of provider objects. CodeMie's entry is identifiable by
    `vendor === 'customendpoint' && name === 'CodeMie'`. Removal filters that entry out and writes the
    rest back.
  - **VS Code Claude Code extension**: config at `.../Code/User/settings.json`. CodeMie's entries live
    in the `claudeCode.environmentVariables` array as `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`.
    Removal strips only those two entries, preserving the rest of the user's settings.
- Blocks EPMCDME-14574 (Connections screen, this repo) from offering a working Disconnect action for
  3 of its 4 rows — that ticket ships with Disconnect scoped to Codex desktop only pending this work.
- Source repo for the CLI package (`@codemieai/code`) is not confirmed from this session — verify
  before filing to a Jira component/repo field if one is required.
