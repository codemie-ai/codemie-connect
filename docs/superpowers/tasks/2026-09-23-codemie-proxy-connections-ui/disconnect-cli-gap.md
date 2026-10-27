# CLI gap: no way to disconnect Claude Desktop or VS Code

**Ticket:** EPMCDME-14574 (Connections screen), parent story EPMCDME-14350

## What's missing

`codemie proxy disconnect` only works for one of the four apps the Connections screen needs to manage:

```
codemie proxy disconnect --codex-desktop        ✅ works
codemie proxy disconnect --claude-desktop       ❌ doesn't exist
codemie proxy disconnect --vscode               ❌ doesn't exist
codemie proxy disconnect --vscode-claude-code   ❌ doesn't exist
```

This isn't a missing command-line flag — the removal logic itself hasn't been built for those three apps yet.

## Why it's blocking

Once a user connects Claude Desktop or VS Code from the app, there's currently no way — from the app or the terminal — to undo it.

## Options

1. **CLI adds the missing removal logic** for Claude Desktop, VS Code Copilot Chat, and the VS Code Claude Code extension, matching what already exists for Codex. Full parity across all 4 apps, clean UX. Needs CLI-team work.

2. **Keep Disconnect for Codex only.** Ship the screen with a working Disconnect on the one row the CLI already supports; the other 3 rows show status with no Disconnect action until the CLI catches up.

3. **Ship without Disconnect at all** until the CLI supports all four apps — avoids an inconsistent "works for one app, not the others" screen. Gate the whole Disconnect action behind a feature flag (or omit it from v1 entirely), then turn it on for all four at once once Option 1 lands.

4. **Interim: the app implements removal itself, behind a feature flag**, as a stopgap while Option 1 is in progress. Technically possible — we know the file locations and formats — but comes with real risk: it gives the app a capability the CLI doesn't have, which contradicts this product's own stated design (a front end only, never a second product); it depends on undocumented internal file formats that could change in any CLI release with nothing to warn us; and for Claude Desktop specifically, removal isn't a simple file delete — it needs to merge out only CodeMie's entries while preserving the user's other configured MCP servers, logic the CLI already has and we'd be duplicating and risking getting wrong. If we go this route, it ships behind a flag and gets deleted the moment Option 1 lands, not kept as a permanent second implementation.

**Recommendation:** Raise Option 1 with the CLI team now. In the meantime, ship with either Option 2 (Codex only) or Option 3 (no Disconnect at all) — both are reasonable while CLI work is in progress. Fall back to Option 4 only if Option 1's timeline turns out to be too long to wait on.
