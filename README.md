# CodeMie Installer (macOS) — Tauri edition

A native macOS installation wizard that installs and configures the **CodeMie Claude Code CLI**.
This is a [Tauri v2](https://tauri.app) rewrite of the original Electron app — same wizard, same
UX, **~1.9 MB DMG instead of ~550 MB**.

| | Electron build | Tauri build |
|---|---|---|
| DMG size | ~550 MB | **~1.9 MB** |
| Runtime | bundled Chromium + Node | system WebKit + a tiny Rust binary |
| Backend | Node.js modules | Rust `#[tauri::command]`s |

## What it does

A guided wizard that:

1. Checks for **Git** (offers to install the Xcode Command Line Tools if missing).
2. Checks for **Node.js & npm** (offers to download + install the official universal `.pkg`).
3. Installs the **CodeMie CLI** globally via npm (`@codemieai/code`).
4. Runs **`codemie setup`** interactively (in an embedded terminal).
5. Installs the **Claude Code engine** via `codemie install claude` (interactive).
6. Validates with **`codemie doctor`**.

Steps with system changes pause for approval (or auto-approve in *Unattended mode*).

## Architecture (Option B)

The orchestration "brain" (`engine.js`, `handlers.js`, `models.js`) stays in the frontend as
vanilla ES modules — reused almost verbatim from the Electron app. Only the system-facing
operations are Rust commands:

```
ui/                      frontend (no bundler; loaded as ES modules)
  renderer.js            builds the Engine in the webview, drives it via Tauri invoke/listen
  engine.js handlers.js  install plan orchestration + per-step handlers (reused)
  runner-bridge.js       wraps Rust commands as the module surface handlers expect
  steps-ui.js sprite.js log.js terminal.js  UI widgets
src-tauri/src/
  commands/runner.rs     run_capture / run_fresh_env / run_stream (login-shell exec)
  commands/inspector.rs  git / node / npm / codemie probes
  commands/installer.rs  Node .pkg URL + LTS lookup + osascript sudo + Xcode CLT
  commands/downloader.rs reqwest streaming download with progress events
  commands/pathman.rs    login-shell PATH resolution + ~/.zprofile persistence
  commands/pty.rs        portable-pty: interactive TUI steps (base64 framing)
  commands/logger.rs window.rs smoke.rs
  steps.rs               embedded config/steps.yaml (serde_yaml) + logo path
```

PTY output is base64-framed across the IPC boundary so multi-byte UTF-8 / ANSI escape
sequences split across read boundaries are never corrupted.

## Prerequisites

- macOS 10.15+
- [Rust toolchain](https://rustup.rs) (stable)
- Tauri CLI: `cargo install tauri-cli --version "^2" --locked`
- Node.js (only to run the JS unit tests)

## Develop

```bash
cd src-tauri
cargo tauri dev
```

## Build a shareable DMG

```bash
cd src-tauri

# Native architecture (fast iteration):
CI=true cargo tauri build

# Universal (Intel + Apple Silicon) — for sharing:
rustup target add x86_64-apple-darwin aarch64-apple-darwin
CI=true cargo tauri build --target universal-apple-darwin
```

The DMG lands in `src-tauri/target/<target>/release/bundle/dmg/`.

> **`CI=true` is required** when building outside an interactive desktop session: it tells
> Tauri's `bundle_dmg.sh` to skip the Finder AppleScript that styles the DMG window
> (which otherwise fails headless).

### Unsigned DMG — sharing note

The DMG is intentionally **unsigned / un-notarized**. On another Mac, Gatekeeper will block the
first launch. Recipients open it once via **right-click → Open**, or strip the quarantine flag:

```bash
xattr -dr com.apple.quarantine "/Applications/CodeMie Installer.app"
```

## Tests

```bash
# Rust unit tests (ported from the Electron app's suite)
cd src-tauri && cargo test

# JS engine/model tests
npm test           # node --test ui/test/*.test.mjs
```

## Non-destructive smoke modes

The wizard's real steps modify your system, so two env-gated, **non-destructive** self-tests
exist for CI / verification (they print to stdout and quit):

| Env var | Behaviour |
|---|---|
| `CODEMIE_PROBE_SMOKE=1` | Runs the detection-only steps (git/node/codemie) unattended; step 1.3 detects without installing. Prints `PROBE_RESULT … / PROBE_DONE`. |
| `CODEMIE_SMOKE=1` | Verifies the renderer booted (step rows, canvas) and runs a benign PTY echo. Prints `SMOKE_PROBE / SMOKE_PTY / SMOKE_OK`. |
| `CODEMIE_SMOKE_MS=<n>` | Override the smoke quit delay (default 2500 ms). |

```bash
CODEMIE_PROBE_SMOKE=1 ./src-tauri/target/release/app
CODEMIE_SMOKE=1 ./src-tauri/target/release/app
```

The genuine end-to-end install (npm global install, `codemie setup`, sudo `.pkg` install,
`~/.zprofile` edits) is **never run automatically** — run the wizard by hand to exercise it.
