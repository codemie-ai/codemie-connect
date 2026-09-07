# CodeMie Installer (macOS) — Tauri edition

A native macOS app that installs, configures, and connects the **CodeMie Claude Code CLI**.
This is a [Tauri v2](https://tauri.app) rewrite of the original Electron app — same install
flow and UX, a **~4 MB universal DMG instead of ~550 MB**.

| | Electron build | Tauri build |
|---|---|---|
| DMG size | ~550 MB | **~4 MB** universal (~1.9 MB single-arch) |
| Runtime | bundled Chromium + Node | system WebKit + a tiny Rust binary |
| Backend | Node.js modules | Rust `#[tauri::command]`s |

## Home / launcher

On launch the app shows a home page (2×2 tile grid) with four actions:

| Tile | What it does |
|---|---|
| **Full installation** | The complete guided wizard — Git → Node.js → CodeMie CLI → `codemie setup` → Claude Code engine → `codemie doctor`. |
| **Install only** | Installs Git, Node.js and the CodeMie CLI (`@codemieai/code`) and stops — skips the setup wizard, Claude engine and doctor. |
| **Connect Claude Desktop** | Opens a **Connect / Restart** screen. Both verify sign-in via `codemie profile status` first, then point Claude Desktop at the CodeMie proxy: **Connect** runs `codemie proxy connect desktop`; **Restart** runs `codemie proxy stop` then connects again. |
| **CLI usage analytics** | Runs `codemie analytics --report --open` to build an HTML report of your **local AI CLI usage** (Claude Code, Codex, …) and open it in the browser. |

Connect/analytics output streams in an embedded terminal; navigation between views is via the
"‹ Home" / "‹ Back" links (no page reloads).

## The install wizard

The **Full installation** and **Install only** tiles drive a guided wizard that:

1. Checks for **Git** (offers to install the Xcode Command Line Tools if missing).
2. Checks for **Node.js & npm** (offers to download + install the official universal `.pkg`).
3. Installs the **CodeMie CLI** globally via npm (`@codemieai/code`).
4. *(full only)* Runs **`codemie setup`** interactively (in an embedded terminal).
5. *(full only)* Installs the **Claude Code engine** via CodeMie (interactive).
6. *(full only)* Validates with **`codemie doctor`**.

Steps with system changes pause for approval (or auto-approve in *Unattended mode*).

## Architecture (Option B)

The orchestration "brain" (`engine.js`, `handlers.js`, `models.js`) lives in the frontend as
vanilla ES modules — reused almost verbatim from the Electron app. Only the system-facing
operations are Rust commands:

```
ui/                      frontend (no bundler; loaded as ES modules)
  index.html             home-view (launcher) + wizard-view + connect-view + overlays
  renderer.js            view routing, builds the Engine, drives it via Tauri invoke/listen
  engine.js handlers.js  install plan orchestration + per-step handlers (reused)
  runner-bridge.js       wraps Rust commands as the module surface handlers expect
  steps-ui.js sprite.js log.js terminal.js  UI widgets (terminal has a keep-open mode)
src-tauri/src/
  commands/runner.rs     run_capture / run_fresh_env / run_stream (login-shell exec)
  commands/inspector.rs  git / node / npm / codemie probes + profile-status auth check
  commands/installer.rs  Node .pkg URL + LTS lookup + osascript sudo + Xcode CLT
  commands/downloader.rs reqwest streaming download with progress events
  commands/pathman.rs    login-shell PATH resolution + ~/.zprofile persistence
  commands/pty.rs        portable-pty: interactive TUI steps (base64 framing)
  commands/logger.rs window.rs smoke.rs
  steps.rs               embedded config/steps.yaml (serde_yaml) + logo path
```

- `check_profile_status` runs `codemie profile status` (stdin closed so an expired-creds
  re-auth prompt can't hang it) and parses the **Auth Status** line — the live gate for the
  Connect Claude Desktop actions.
- PTY output is base64-framed across the IPC boundary so multi-byte UTF-8 / ANSI escape
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

The DMG ships the CodeMie CLI with its own Node runtime (Apple Silicon). Build it with the verifying script:

```bash
./build-installer.sh
```

It downloads the pinned Node (`runtime.json`), installs the CLI tree under `assets/codemie-cli/`, asserts every bundled artifact before and after the Tauri build, and prints the DMG path. The plain commands below skip those checks and, until `scripts/stage-runtime.sh` has run once, fail with `resource path ... doesn't exist`.

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

The app/Dock icon is generated from `assets/ai-run-codemie-logo-white_bg.svg`:

```bash
cargo tauri icon assets/ai-run-codemie-logo-white_bg.svg
```

## Running an unsigned build (Gatekeeper)

The default `cargo tauri build` output is *ad-hoc* signed only, so Gatekeeper will block it
on other Macs. This is expected for local/dev builds.

**To run it anyway (local / internal testers):**

- **GUI (macOS 13–15):** click **Done** in the block dialog, drag the app to **Applications**,
  then open **System Settings → Privacy & Security → Open Anyway** and authenticate.
- **Terminal (most reliable):**
  ```bash
  cp -R "/Volumes/CodeMie Installer/CodeMie Installer.app" /Applications/
  xattr -cr "/Applications/CodeMie Installer.app"
  open "/Applications/CodeMie Installer.app"
  ```

## Signing & notarizing for distribution

Signing produces a DMG that Gatekeeper accepts on any Mac without warnings. Requires an
**Apple Developer Program** account and a **Developer ID Application** certificate.

### Assets (`apple_developer/`)

| File | What it is |
|---|---|
| `developerID_application.cer` | Developer ID Application certificate (public) |
| `DeveloperID.key` | Matching private key — **never commit** |

### One-shot script

`sign-dmg.sh` does the full pipeline:

1. Imports the cert + key into the macOS login keychain (idempotent)
2. Downloads the Apple Developer ID G2 intermediate CA if missing
3. Mounts the source DMG, extracts the `.app`, signs it with hardened runtime + secure timestamp
4. Repacks a fresh DMG from the signed `.app`
5. Signs the new DMG
6. (optional) Submits to Apple notarization, waits for `Accepted`, staples the ticket

### Setup

Create `.env.signing` in the project root (it is gitignored):

```bash
# .env.signing — DO NOT COMMIT
KEYCHAIN_PASSWORD=your_mac_login_password

# Notarization only:
APPLE_ID=you@example.com
APPLE_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx   # app-specific password from appleid.apple.com
APPLE_TEAM_ID=XXXXXXXXXX
```

Generate an app-specific password at **appleid.apple.com → Security → App-Specific Passwords**.

### Run

```bash
# Build the DMG first
cd src-tauri && CI=true cargo tauri build && cd ..

# Sign only (internal distribution, your own Mac)
./sign-dmg.sh

# Sign + notarize + staple (required for distribution to other Macs)
NOTARIZE=1 ./sign-dmg.sh
```

The signed (and optionally notarized) DMG is written to:
```
src-tauri/target/release/bundle/dmg/CodeMie Installer_2.0.0_aarch64_signed.dmg
```

Verify Gatekeeper acceptance:
```bash
spctl --assess --type open --context context:primary-signature -v \
  "src-tauri/target/release/bundle/dmg/CodeMie Installer_2.0.0_aarch64_signed.dmg"
# expected: accepted
```

> **Notarization time:** typically 2–10 minutes. The script blocks with `--wait` and staples
> automatically on success.

## Tests

```bash
# Rust unit tests (ported from the Electron app's suite + the auth-status parser)
cd src-tauri && cargo test

# JS engine/model tests
npm test           # node --test ui/test/*.test.mjs
```

## Non-destructive smoke modes

The wizard's real steps modify your system, so two env-gated, **non-destructive** self-tests
exist for CI / verification (they print to stdout and quit). They boot straight into the wizard
view, bypassing the home page:

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
`~/.zprofile` edits) and the network actions (`proxy connect`, `analytics`) are **never run
automatically** — exercise them by hand from the home page.
```
