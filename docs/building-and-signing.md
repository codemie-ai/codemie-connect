# Building, signing and releasing

Moved out of the README. Releases are normally cut by `.github/workflows/release-macos.yaml` when a `vX.Y.Z` tag is pushed; this page covers building locally.

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

The macOS DMG (Apple Silicon) is small: it holds the app and the `codemie` shim only. On first launch the app downloads the pinned Node.js from nodejs.org (SHA-256 checked) and installs the pinned CLI from npm with the lock file in `assets/codemie-cli/`, into `~/Library/Application Support/CodeMie/runtime`. Later launches install a newer CLI from npm in the background, so a CLI release needs no new installer. All of it is skipped when the machine already has a CodeMie CLI. The Windows installer still bundles Node and the CLI. Build with the verifying script:

```bash
./build-installer.sh
```

It downloads the pinned Node (`runtime.json`), installs the CLI tree and its lock file under `assets/codemie-cli/`, asserts every artifact before and after the Tauri build, runs the bundled shim against that tree laid out the way the app installs it, and prints the DMG path. There is nothing to upload. The plain commands below skip those checks.

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
