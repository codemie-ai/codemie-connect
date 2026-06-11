# Technical Analysis — Home/launcher page + icon

**Date:** 2026-06-11
**Slug:** home-launcher
**Builds on:** completed `2026-06-11-tauri-macos-installer` (Electron→Tauri v2 migration, maintenance phase).

## Current app flow (pre-change)

- Single window, single screen. `ui/renderer.js` `boot()` runs on load: `get_steps` → render step rows → init sprite/log/terminal → build `Engine` (Option B, orchestration in JS) → wire the **Install** button to `engine.run()`.
- `engine.run()` executes **all** steps in `config/steps.yaml`.
- System-touching work crosses into Rust via `#[tauri::command]`s in `src-tauri/src/commands/*` (runner, inspector, installer, pathman, downloader, logger, pty, window) + `steps.rs`. Commands registered in `src-tauri/src/lib.rs`.
- Backend→frontend PTY output streams via `engine:pty-data` / `engine:pty-exit` events; `ui/terminal.js` renders an xterm overlay (`#terminal-overlay`) and **auto-closes on pty-exit**.

## steps.yaml split (drives "install vs setup")

| Step | Title | Bucket |
|---|---|---|
| 1.1 / 1.1.1 | Check / Install Git (Xcode CLT) | installation |
| 1.2 / 1.2.1 | Check / Install Node.js & npm | installation |
| 1.3 | Install CodeMie CLI (`npm i -g @codemieai/code`) | installation |
| 2.3.3 | Configure CodeMie (interactive `codemie setup`) | **setup** |
| 2.3.5 | Install Claude Code engine (interactive) | **setup** |
| 2.4 | Validate (`codemie doctor`) | **setup** |

→ **Install-only** = run `1.1, 1.1.1, 1.2, 1.2.1, 1.3` only (skip `2.x`). Mirrors the existing `runProbe()` step-filter (`renderer.js:170-189`).

## CodeMie CLI facts (ref: /Users/Vadym_Vlasenko/AI/projects/codemie-code, binary `codemie` 0.4.1 on PATH)

- **`codemie proxy connect desktop`** — configures Claude Desktop to use the local CodeMie proxy. Preconditions: `codemie setup` completed, **active profile SSO-backed with valid creds**, `codeMieUrl` configured. (`src/cli/commands/proxy/index.ts:247-401`.)
- **`codemie analytics --report --open`** — generates a self-contained HTML dashboard and opens it in the browser. Default output `./codemie-analytics-YYYY-MM-DD.html` in **CWD** — must override with `--report-output` because a Finder-launched bundle's CWD is `/`. (`src/cli/commands/analytics/index.ts:15-207`, `report/report-generator.ts:66,159-165`.)
- **Setup-correctness check** — global config `~/.codemie/codemie-cli.config.json` with a non-empty `profiles` map indicates setup ran. Heavier alternatives: `codemie profile status`, `codemie doctor`. Lightweight config-presence check chosen (non-interactive; `profile status` can re-prompt and hang `run_capture`).

## Risk indicators

1. **Smoke regression (top risk).** `CODEMIE_SMOKE` / `CODEMIE_PROBE_SMOKE` assert on boot that `.step-row` rows, the title, and `#sprite-canvas` exist (`renderer.js:170-237`). A home page shown before the wizard would break them → boot must route smoke/probe straight into the wizard view.
2. Actions 3 & 4 are "run one command, stream output", not wizards → reuse `spawn_pty` + the terminal overlay, **not** `engine.run()`.
3. `--report-output` must target a writable, discoverable path (`$HOME`).
4. No JS test runner exists (original spec carved out JS UI from forced TDD) → unit-test pure Rust logic only; verify UI via build + launch + smoke.

## Toolchain

cargo 1.96.0, tauri-cli 2.11.2, targets `aarch64-apple-darwin` + `x86_64-apple-darwin` installed (universal build OK). `cargo`/`rustc` live in `~/.cargo/bin` (not on the non-login shell PATH — prefix builds with `export PATH="$HOME/.cargo/bin:$PATH"`).
