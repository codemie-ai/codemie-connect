# Update EPMCDME-14574: corrections to match verified CLI/design reality

**For:** a separate session updating the ticket itself in Jira.
**Why:** the ticket text as written has statements that don't match the real CLI or the approved parent-story design, discovered while scoping and spec'ing this work. Listed here so the ticket can be corrected before/alongside implementation, not discovered as a surprise during review.

## The ticket's current text (for reference)

> Expose codemie proxy connection management in the app UI so users can connect supported AI client apps (Claude Desktop, VS Code, Codex) to their CodeMie profile without using the terminal. Scope: list currently connected client apps and connection status; add a new connection (select app type, run `codemie proxy connect [app]` in a PTY, parse output for success/failure); remove a connection (confirm, run `codemie proxy disconnect [app]`, reflect result); show connection health (proxy running/stopped/unreachable); start/stop the proxy from the UI. Out of scope: Claude Desktop / VS Code installer download.

## Corrections needed

1. **"(Claude Desktop, VS Code, Codex)" names 3 apps; there are 4, and "VS Code" is actually two distinct integrations.** The real `codemie proxy connect` supports `--claude-desktop`, `--vscode` (Copilot Chat, BYOK), `--vscode-claude-code` (Claude Code extension), and `--codex-desktop` — four separate targets, not three. There is no single "VS Code" connection; a user can connect the Copilot Chat integration, the Claude Code extension, both, or neither, independently. The app list should read as 4 items, not 3, and there is no "other" app type — these four are the complete set the CLI supports.

2. **"remove a connection (... run `codemie proxy disconnect [app]` ...)" is not currently true for 3 of the 4 apps.** `codemie proxy disconnect` only works for `--codex-desktop` today. There is no working disconnect for Claude Desktop, Copilot Chat, or the Claude Code extension — not a missing flag, the removal logic doesn't exist in the CLI yet. As written, the ticket's scope line describes a uniform remove-connection flow that only 1 of 4 rows can actually deliver. (Separate CLI-side ticket needed to close this — filed alongside this doc.)

3. **"start/stop the proxy from the UI" conflicts with the parent story's approved design.** EPMCDME-14350's design-exploration comment (the one that added Connections back into scope) is explicit: *"No 'gateway' concept in the interface — someone who will not open a terminal cannot act on 'the gateway is off', they can act on 'Claude Desktop isn't working, press Fix'."* A literal visible start/stop control contradicts that. The ticket should either drop this line in favor of "per-app Fix/Reconnect action on an unhealthy row" (matching the approved design), or explicitly confirm it wants to diverge from that design — right now the two documents disagree and neither addresses the other.

4. **"list currently connected client apps and connection status" doesn't say how status is derived, and the obvious approach doesn't exist.** There is no `codemie proxy list` and `codemie proxy status` is daemon-level only (running/stopped/unreachable), not per-app. Per-app status has to be a composite of client config-file presence + daemon health, checked per app — worth stating explicitly so it isn't assumed to be a single CLI call.

5. **Out-of-scope line only names 2 of the relevant apps.** "Claude Desktop / VS Code installer download" is out of scope, but Codex desktop's installer is presumably out of scope too and isn't mentioned — worth confirming and making the exclusion apply uniformly across all 4 apps rather than reading as Codex being different.

## Suggested corrected scope line

> Expose codemie proxy connection management in the app UI for the 4 client integrations the CLI supports: Claude Desktop, VS Code Copilot Chat (BYOK), VS Code Claude Code extension, and the Codex desktop app. List each app's connection status (derived from client config presence + proxy daemon health, since no single CLI call reports this). Add a connection: select app, run `codemie proxy connect --<app>` in a PTY, parse output for success/failure. Remove a connection: only supported today for Codex desktop (`codemie proxy disconnect --codex-desktop`) — the CLI has no disconnect capability yet for the other 3 apps; see [CLI ticket] for closing that gap. No visible proxy start/stop control — per-app "Fix"/"Reconnect" action on an unhealthy row instead, per the approved parent-story design. Out of scope: installer download for any of the 4 client apps.
