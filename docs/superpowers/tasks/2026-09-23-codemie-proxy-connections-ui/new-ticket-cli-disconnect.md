# New ticket: CLI — add disconnect support for Claude Desktop, VS Code Copilot Chat, VS Code Claude Code extension

**For:** a separate session, likely creating this against the CLI's own repo/project (the `codemie` CLI — package `@codemieai/code`; source repo not confirmed from this session, verify before filing).
**Origin:** discovered while scoping EPMCDME-14574 (Connections screen, `codemie-claude-installer-macos-tauri`), blocking that ticket's remove-connection requirement for 3 of 4 apps.

## Summary

`codemie proxy connect` supports 4 client apps, but `codemie proxy disconnect` only supports 1 of them:

```
codemie proxy connect --claude-desktop        ✅
codemie proxy connect --vscode                ✅  (Copilot Chat, BYOK)
codemie proxy connect --vscode-claude-code    ✅  (Claude Code extension)
codemie proxy connect --codex-desktop         ✅

codemie proxy disconnect --claude-desktop       ❌ not implemented
codemie proxy disconnect --vscode               ❌ not implemented
codemie proxy disconnect --vscode-claude-code   ❌ not implemented
codemie proxy disconnect --codex-desktop        ✅ implemented
```

This is not a missing flag — the removal logic itself was never built for 3 of the 4 connectors. Once a user connects Claude Desktop or either VS Code integration, there is currently no way to disconnect it, from the CLI or from any front end built on top of it.

## What exists today (reference implementation to mirror)

`codex-desktop` already has working disconnect logic — use it as the pattern:

- `removeCodexDesktopConfig()` in the Codex connector module removes CodeMie's managed block from the shared `~/.codex/config.toml`, restoring a `.codemie-backup` if the managed region can't be cleanly stripped.
- A dedicated ownership-tracking file (`~/.codemie/proxy/codex-desktop-state.json`) records what CodeMie owns there, separate from the shared config file itself.
- `disconnect-orchestrator.js` wires `--codex-desktop` to this removal function and reports success/failure.

## What's needed, per app

1. **Claude Desktop** — config lives at `~/Library/Application Support/Claude-3p/configLibrary/`, with `_meta.json` pointing at an `appliedId` whose file is the actual applied config. Connect (`writeDesktopConfig`) already has real merge logic (`mergeManagedMcpServers`, `reconcileManagedMcpServers`) to combine CodeMie's managed MCP servers with a user's own — the removal counterpart needs to undo only CodeMie's managed entries without touching the user's other configured MCP servers, not just delete the file wholesale.

2. **VS Code — Copilot Chat (BYOK)** — config is `.../Code/User/chatLanguageModels.json`, a shared JSON array of provider objects. CodeMie's entry is identifiable by `vendor === 'customendpoint' && name === 'CodeMie'`. Removal needs to filter that entry out of the array and write the rest back, not delete the whole file (other providers may be configured).

3. **VS Code — Claude Code extension** — config is `.../Code/User/settings.json`, a shared settings file. CodeMie's entries live in the `claudeCode.environmentVariables` array as entries named `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`. Removal needs to strip only those two entries from that array, preserving the rest of the user's settings.

Each of these is a real "find and remove only CodeMie's managed slice of a shared file" operation, not a file delete — same shape of problem `codex-desktop`'s connector already solves.

## Acceptance criteria (draft)

- `codemie proxy disconnect --claude-desktop` removes CodeMie's managed MCP entries from Claude Desktop's applied config, leaving any other configured MCP servers intact.
- `codemie proxy disconnect --vscode` removes CodeMie's entry from `chatLanguageModels.json`, leaving other configured providers intact.
- `codemie proxy disconnect --vscode-claude-code` removes the `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` entries from `claudeCode.environmentVariables` in `settings.json`, leaving the rest of the user's settings intact.
- Each reports success/failure the same way `--codex-desktop` does today (`✓ <App> disconnected` / an actionable error).
- "Nothing to disconnect" is handled gracefully when the app was never connected (matches `--codex-desktop`'s existing behavior).

## Why it matters

This blocks EPMCDME-14574's Connections screen from offering a working Disconnect action for 3 of its 4 rows. That ticket is shipping with Disconnect scoped down (see its own gap doc) specifically because this CLI capability doesn't exist yet — this ticket is what actually closes the gap.
