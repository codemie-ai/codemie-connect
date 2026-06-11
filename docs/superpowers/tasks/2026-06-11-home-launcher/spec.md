# Spec: CodeMie Installer — Home/launcher page + app icon

**Date:** 2026-06-11
**Slug:** home-launcher
**Status:** Approved (design approved interactively — "go")
**Builds on:** `2026-06-11-tauri-macos-installer` (maintenance).

## Goal

Replace the installer's straight-to-wizard launch with a **home/launcher page** offering four actions, and update the **Dock/app icon** to the new CodeMie logo. macOS only. Parity-preserving: the existing wizard, engine, PTY, and smoke modes keep working unchanged.

## Decisions (locked)

1. **Icon:** Dock/app icon only — regenerate `src-tauri/icons/*` from the new `assets/ai-run-codemie-logo-white_bg.svg` via `cargo tauri icon`. No menu-bar tray. In-app logo unchanged.
2. **Connect Claude Desktop:** an intermediate screen with two actions — **Connect** and **Restart** — each gated by a live `codemie profile status` auth check; if not authenticated → **block** with a notice that offers a jump to the full installation.
3. **Home layout:** 2×2 tile grid.

## Non-goals

- Code signing / notarization (unchanged).
- Menu-bar (status-bar) tray item.
- Changing `config/steps.yaml` semantics.
- Swapping the in-app wizard logo.
- Introducing a JS test runner.
- Auto-running destructive or network actions during verification.

## Architecture

Single window; views toggled by `.hidden` (no router — consistent with the existing overlay pattern).

- **`#home-view`** *(new)* — header (in-app logo + "CodeMie Installer" + subtitle), 2×2 grid of four `.home-tile` cards, footer. Shown on normal boot.
- **`#wizard-view`** — the existing wizard (`#main-row` + log bar + footer), hidden on boot; gains a "‹ Home" back link.
- **`#connect-view`** *(new)* — intermediate Connect Claude Desktop screen: "‹ Home" back link + **Connect** and **Restart** action cards.
- **Terminal overlay** *(reused)* — gains a `keepOpen` mode for command actions: on `pty-exit` it shows the finished output + a "‹ Back" button (returns to the launching view) instead of auto-closing.
- **`#notice-overlay`** *(new, small modal)* — generic message + primary button (configurable label/action) + Close. Used for the not-signed-in block.

### Boot routing (preserves smoke)

`boot()` builds all wizard infrastructure as today, then:
- **if `flags.probe || flags.smoke`** → show `#wizard-view` and run probe/smoke unchanged (their `.step-row`/title/canvas/bg assertions still hold);
- **else** → show `#home-view` and wire the tiles.

Entering a wizard mode is factored into `enterWizard(stepIds?)` which (re)builds the `Engine` from a master step list, optionally filtered.

## The four actions

1. **Full installation + setup** → `enterWizard()` (all steps); today's behavior, manual **Install**.
2. **Install only (no setup)** → `enterWizard(['1.1','1.1.1','1.2','1.2.1','1.3'])`; header notes "install only".
3. **Connect Claude Desktop** → opens `#connect-view` with two actions. Each first calls `invoke('check_profile_status')`; if `authenticated`, it runs the command in the keep-open terminal, else it shows `#notice-overlay` ("CodeMie isn't signed in — run Full installation first" → `enterWizard()`).
   - **Connect** → `spawn_pty('codemie proxy connect desktop')`.
   - **Restart** → `spawn_pty('codemie proxy stop; codemie proxy connect desktop')` (`;` not `&&`, so a no-op stop still proceeds to connect).
4. **CLI usage analytics** → `spawn_pty('codemie analytics --report --open --report-output "$HOME/codemie-analytics.html"')` in the keep-open terminal; builds an HTML report of **local AI CLI usage** (Claude Code, Codex, …) and the CLI opens it in the browser.

## Backend (Rust) — one new command

`check_profile_status` in `commands/inspector.rs`: runs `codemie profile status < /dev/null` and returns `{ authenticated: bool, detail: String }`.
- `authenticated` = the output's `Auth Status` line shows `✓ Authenticated` and neither `not authenticated` nor `expired` ("expires in …" is not mistaken for expired). A live check of real CLI output — not a hardcoded/config-presence check.
- stdin is closed (`< /dev/null`) so the CLI's interactive re-auth prompt (shown when credentials are expired) cannot hang the capture; the status row prints before any prompt, so the parse still works.
- Pure parser `parse_profile_status(&str, &str) -> (bool, String)` is unit-tested (RED→GREEN).
- Registered in `src-tauri/src/lib.rs`. All other behavior reuses existing commands (`spawn_pty`, `get_steps`, `get_logo_path`, …).

## Testing / verification (non-destructive boundary)

- **Rust unit tests** for `parse_profile_status`: `✓ Authenticated (expires in …)` → authenticated; `✗ Expired` and `✗ Not authenticated` → not authenticated; "expires in …" not mistaken for expired; empty output → not authenticated.
- **No forced TDD** on UI/navigation/glue (no JS runner) — verified via build + launch + smoke.
- **Both smoke modes green:** `CODEMIE_PROBE_SMOKE`, `CODEMIE_SMOKE`.
- **`cargo clippy`** clean on our code.
- **Universal DMG built, asserted < 20 MB**, size/arch checked.
- **Live launch:** home renders with 4 tiles; navigation home↔wizard↔connect works; install-only filters steps; the Connect/Restart auth gate is confirmed against the real `codemie profile status` output. Destructive/network actions never auto-run.

## Success criteria

- App boots to the home page with four working tiles (smoke-exempt).
- Full install = today's wizard; install-only runs `1.x` only.
- Connect Claude Desktop opens a Connect/Restart screen; both actions run a live `codemie profile status` check and block-with-pointer when not authenticated. Restart stops the proxy before reconnecting.
- The "CLI usage analytics" tile constructs `codemie analytics --report --open --report-output "$HOME/codemie-analytics.html"`.
- New Dock icon present in the bundle.
- Rust tests + clippy clean; both smoke modes green; universal DMG < 20 MB; `.app` launches.
