# CLI: proxy disconnect support for Claude Desktop, VS Code Copilot Chat, VS Code Claude Code — Story

**Date**: 2026-09-24
**Status**: Approved
**Ticket**: —
**Parent story**: EPMCDME-14350

---

## Context

- `codemie proxy connect` supports 4 client apps; `codemie proxy disconnect` only implements 1 of them (`--codex-desktop`) today — the removal logic for the other 3 was never built.
- `--codex-desktop`'s disconnect is a working reference pattern: strip CodeMie's managed block from a shared config file, tracked via a dedicated ownership file, reporting success/failure.
- The 3 missing apps each store CodeMie's config as a managed slice inside a shared file the user also configures directly (Claude Desktop's applied MCP config, VS Code's `chatLanguageModels.json`, VS Code's `settings.json`) — removal must be surgical (strip only CodeMie's slice), not a file delete.
- Blocks EPMCDME-14574 (Connections screen, this repo) from offering a working Disconnect action for 3 of its 4 rows.
- Target implementation repo is the CLI's own repo (`@codemieai/code`), not this Tauri repo — not confirmed from this session, flagged as an open question.

---

## Complexity

**Size**: M (19/36) · **Recommended flow**: sdlc-standard

Three independent removal implementations against three different shared-config formats (Claude Desktop's appliedId indirection, VS Code's chatLanguageModels.json array filter, VS Code's settings.json environmentVariables strip), plus orchestrator wiring — enough component scope to warrant brainstorming before planning.

---

## Story

**As a** CodeMie CLI user who has connected Claude Desktop, VS Code Copilot Chat, or the VS Code Claude Code extension, **I want** `codemie proxy disconnect` to work for each of those apps **so that** I can cleanly remove CodeMie's connection without manually editing config files, the same way I already can for Codex desktop.

---

## Background

Today only Codex desktop has a working disconnect. A user who connects Claude Desktop or either VS Code integration has no supported way to undo it — the removal logic simply doesn't exist for those 3 connectors. This also blocks the Connections screen story (EPMCDME-14574) from shipping a uniform Disconnect action across all 4 apps: that ticket currently scopes Disconnect to Codex desktop only, pending this work.

---

## Acceptance Criteria

- [ ] Given a user has connected Claude Desktop, when they run `codemie proxy disconnect --claude-desktop`, then CodeMie's managed MCP entries are removed from Claude Desktop's applied config while any other configured MCP servers remain intact.
- [ ] Given a user has connected VS Code Copilot Chat (BYOK), when they run `codemie proxy disconnect --vscode`, then CodeMie's entry is removed from `chatLanguageModels.json` while other configured providers remain intact.
- [ ] Given a user has connected the VS Code Claude Code extension, when they run `codemie proxy disconnect --vscode-claude-code`, then the `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` entries are removed from `claudeCode.environmentVariables` in `settings.json` while the rest of the user's settings remain intact.
- [ ] Given any of the 3 disconnects completes, when it finishes, then the CLI reports success the same way `--codex-desktop` does today (e.g. `✓ <App> disconnected`).
- [ ] Given an app was never connected, when the user runs disconnect for it, then the CLI reports "nothing to disconnect" gracefully rather than erroring — matching `--codex-desktop`'s existing behavior.

---

## Out of Scope

- Connect logic for any of the 4 apps (already implemented).
- Any UI/front-end work — this is CLI-only. The consumer of this capability (Connections screen) is tracked separately in EPMCDME-14574.
- Installer download for any client app.

---

## Open Questions

- Confirm the CLI's actual source repo (`@codemieai/code`) before filing — not confirmed from this session.
