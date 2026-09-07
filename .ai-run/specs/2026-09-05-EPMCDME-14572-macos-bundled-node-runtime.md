# Spec: Bundled Node Runtime, Shim and PATH Registration (macOS)

**Ticket**: EPMCDME-14572 (`feat/epmcdme-14572-macos-bundled-runtime`)
**Date**: 2026-09-05
**Mirrors**: `.ai-run/specs/2026-09-03-EPMCDME-14505-bundled-node-runtime.md` (Windows) and its decision record `.ai-run/decisions/2026-09-03-EPMCDME-14505-packaging-approach.md`
**Depends on**: EPMCDME-14505 (MR !18: staging pattern, `runtime.json`, overlay pattern, `bundle_resources` test)

---

## Goal

Make `codemie --version` and `codemie install [agent]` work on a clean Apple Silicon Mac with no system Node.js, npm or CodeMie, by shipping a pinned Node runtime, the production CLI tree and a shell shim inside `CodeMie Connect.app`, and registering the shim's directory on the user's PATH. Replace nothing on Windows.

The build must fail loudly when any bundled artifact is missing, empty, not executable or absent from the produced `.app`. Every assertion inspects an artifact, never the exit status of the tool that produced it.

---

## Facts this spec rests on (all verified on 2026-09-05)

| Fact | Evidence |
|---|---|
| `node-v22.23.2-darwin-arm64.tar.gz` SHA-256 is `61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6` | official `SHASUMS256.txt`, re-hashed after download |
| `bin/node` from that tarball is 108 MB, signed `Developer ID Application: Node.js Foundation (HX7739G8FX)`, hardened runtime, entitlements `allow-jit`, `allow-unsigned-executable-memory`, `disable-library-validation`, `allow-dyld-environment-variables` | `codesign -d --entitlements :-` |
| `npm install --omit=dev @codemieai/code@0.14.1` on macOS yields a 274 MB tree; only `codemie-opencode-darwin-arm64` (113 MB) is installed, there is no `-baseline` variant on darwin; `keytar/build/Release/keytar.node` is present and unsigned; 23 symlinks, all in `node_modules/.bin`, none dangling | staged in a scratch dir, `find -type l ! -exec test -e {} \;` empty |
| `node bin/codemie.js --version` from that tree prints `0.14.1` | run |
| The Tauri macOS bundler copies every resource with `fs::copy` (mode bits kept, symlinks copied as their target's content) and signs only `Contents/{MacOS,Frameworks,Plugins,Helpers,XPCServices,Libraries}`; `Contents/Resources` is never re-signed | `tauri-bundler-2.9.4/src/bundle/macos/app.rs:44,489-530`, `src/utils/fs_utils.rs:81-95` |
| `cargo tauri build --bundles dmg` deletes the `.app` after the DMG is written; `--bundles app dmg` keeps it | `tauri-bundler-2.9.4/src/bundle.rs:243-262` |
| `resource_dir()` is `<App>.app/Contents/Resources` | Tauri path resolver, and the existing probe in `pathman.rs:326` already uses it |
| A `#!/bin/sh` script found through PATH sees `$0` as its full path; through a symlink it sees the symlink's path | run with both layouts |
| `codemie install claude` uses `https://claude.ai/install.sh`, not npm; `git` is used only by workflows and speckit, not by setup or install | `dist/agents/plugins/claude/claude.plugin.js:38`, grep of `dist/` |
| Login shells on macOS run `/etc/zprofile` (`path_helper`) and then `~/.zprofile`; a `PATH="<dir>:$PATH"` line appended at the end of `~/.zprofile` therefore lands first | macOS default `/etc/zprofile` |

---

## Design

### 1. Pinned versions, `runtime.json`

Add one key. Nothing else changes.

```json
{
  "nodeVersion": "22.23.2",
  "nodeWin64Sha256": "1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97",
  "nodeMacosArm64Sha256": "61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6",
  "cliPackage": "@codemieai/code",
  "cliVersion": "0.14.1"
}
```

Apple Silicon only. Intel would need `nodeMacosX64Sha256` (`58e99022c2ff89395576cc7fd4d98cea24bb68081475d5f88b801ee8729fb026`) plus a universal Tauri target; it is a separate ticket if ever needed.

### 2. Staging script, `scripts/stage-runtime.sh`

The sole producer of the macOS artifacts. Idempotent. `bash`, `set -euo pipefail`. Reads `runtime.json` with `node -e` at staging time (the developer machine has Node; the product does not need it).

1. **Node runtime**, if `assets/macos/node/bin/node` is absent or `--force`:
   download `https://nodejs.org/dist/v<nodeVersion>/node-v<nodeVersion>-darwin-arm64.tar.gz` to a temp dir, verify `shasum -a 256` against `nodeMacosArm64Sha256`, abort on mismatch, extract only `node-v<v>-darwin-arm64/bin/node` to `assets/macos/node/bin/node`, `chmod 755`. Only the binary ships, as on Windows: npm is not needed (see facts).
2. **CLI tree**, into `assets/codemie-cli/` (shared with Windows): write the same minimal `package.json`, `npm install --omit=dev`, skip when the installed version already equals `cliVersion`.
3. **Prune**: `*.map`; `test`, `tests`, `__tests__`, `example`, `examples`, `docs` directories; `node-pty`, `typescript`, `@rollup`, `@esbuild`. No `--no-baseline` switch: darwin has no baseline package.
4. **Verify** (not negotiable, same list as Windows §6): node exists, is executable, > 10 MB, `--version` prints exactly `v<nodeVersion>`; `@codemieai/code/bin/codemie.js`, `dist/cli/index.js`, `package.json`, `keytar/build/Release/keytar.node` exist and are non-empty; staged CLI version equals `cliVersion`.
5. **Manifest**: `assets/staging-manifest.json` with `nodeVersion`, `cliPackage`, `cliVersion`, `fileCount`, `byteSize`, `platform: "darwin-arm64"`.

`.gitignore` gains `assets/macos/node/`. `assets/codemie-cli/node_modules/` and the manifest are already ignored.

### 3. Shim, `assets/macos/bin/codemie`

Tracked, executable bit set in git (`100755`).

```sh
#!/bin/sh
# CodeMie CLI shim. Runs the bundled Node runtime against the bundled CLI tree.
# $(dirname "$0")/.. is Contents/Resources, so this file is correct wherever the
# app is installed and needs no update if productName changes.
RES="$(cd "$(dirname "$0")/.." && pwd)"
if [ ! -x "$RES/node/bin/node" ]; then
  echo "error: bundled node runtime not found: $RES/node/bin/node" 1>&2
  exit 1
fi
if [ ! -f "$RES/cli/node_modules/@codemieai/code/bin/codemie.js" ]; then
  echo "error: bundled CLI entry not found: $RES/cli/node_modules/@codemieai/code/bin/codemie.js" 1>&2
  exit 1
fi
exec "$RES/node/bin/node" "$RES/cli/node_modules/@codemieai/code/bin/codemie.js" "$@"
```

Load-bearing points:
- **One `..` hop**, the mirror of `%~dp0..`. The ticket text's `../..` lands on `Contents/`, verified.
- **No symlink from `~/.codemie/bin`.** Through a symlink `$0` is the symlink path and the relative resolution lands in `$HOME`, verified. The shim's own directory goes on PATH instead (§5).
- `exec` replaces the shell, so the CLI's exit code, signals and PTY ownership pass through unchanged.
- Entry point is `bin/codemie.js`, never `dist/index.js` (decision record Part 5).

### 4. Bundle resources, `src-tauri/tauri.macos.conf.json`

New platform overlay, the twin of `tauri.windows.conf.json`. The shared `tauri.conf.json` keeps no `bundle.resources` at all, so a Windows checkout never needs the macOS artifacts and vice versa.

```json
{
  "bundle": {
    "resources": {
      "../assets/macos/bin/codemie": "bin/codemie",
      "../assets/macos/node/bin/node": "node/bin/node",
      "../assets/codemie-cli/node_modules": "cli/node_modules"
    }
  }
}
```

Installed layout inside `CodeMie Connect.app/Contents/Resources/`:

```
bin/codemie
node/bin/node
cli/node_modules/@codemieai/code/bin/codemie.js
cli/node_modules/...
```

Plain directory key for the tree, never a glob (Windows spec §5 and the `bundle_resources` test, which already merges this overlay on macOS).

### 5. PATH registration at launch, `pathman.rs` and `lib.rs`

macOS has no installer hook: the DMG is drag-and-drop. So the app registers itself on first launch, which is what `inject_bundled_bin_path` already does for the process on both platforms and what it already persists on Windows.

- `inject_bundled_bin_path` drops the macOS `codemie-<arch>-apple-darwin` sidecar name. `probe_dir` finds `codemie` in `resource_dir()/bin` (the Windows path of the same function).
- After prepending to the process PATH it persists the directory on macOS too, through the existing `persist()` (`~/.zprofile`, marker block, textual dedupe), guarded by a new pure function:

  ```rust
  /// A bundle running from a DMG mount or an App Translocation sandbox has a
  /// throwaway path; writing it to ~/.zprofile would leave a dead entry.
  pub(crate) fn should_persist_bundle_dir(dir: &Path) -> bool
  ```

  Returns `false` when the path starts with `/Volumes/` or contains a component `AppTranslocation`, `true` otherwise. When it returns `false` the app logs one line and continues; the process PATH is still injected so the wizard works in that session, and the next launch from `/Applications` persists.
- Because `persist()` appends `export PATH="<dir>:$PATH"` at the end of `~/.zprofile`, the bundled shim comes first in every login shell, including `runner.rs` (`/bin/zsh -lc`), `pty.rs` (`/bin/zsh -lc`) and the user's terminals. A Homebrew or npm `codemie` earlier in the file is shadowed, which is the same precedence the Windows handshake reports (`bundled_takes_precedence`).
- `node/bin` is never put on PATH. `which node` must not resolve to the bundle.

### 6. Direct invocation for self-update, `state.rs`, `lib.rs`, `runner.rs`

`AppState.node_exe_path` and `cli_entry_path` lose their `#[cfg(windows)]`. `lib.rs` computes them on both platforms from `resource_dir()`:

| | node | entry |
|---|---|---|
| Windows | `node/node.exe` | `cli/node_modules/@codemieai/code/bin/codemie.js` |
| macOS | `node/bin/node` | same |

`self_update_direct` and the direct branch of `run_self_update` lose their `#[cfg(windows)]`; the PATH-shim fallback stays for both. The `cfg_attr(not(windows), allow(unused_variables))` added in `06014c8` goes away because `state` is now read everywhere.

### 7. Wizard steps

`config/steps.yaml` is unchanged: `2.3.3` setup, `2.3.5` install Claude, `2.4` doctor. The bundled shim makes `codemie` resolvable before step 2.3.3 runs. No Git step: neither setup nor install needs git (facts).

### 8. Build and verification, `build-installer.sh`

Same five phases and the same rule as `build-installer.ps1`: no switch skips or downgrades an assertion. `--skip-stage` reuses a staged tree and still verifies everything.

1. **Stage**: `scripts/stage-runtime.sh`, abort on non-zero.
2. **Pre-build assertions**, each naming the failing path: `assets/macos/node/bin/node` exists, is executable, > 10 MB, `--version` equals `v<nodeVersion>`; the four required tree files exist and are non-empty; manifest `cliVersion` equals `runtime.json`.
3. **Smoke** before bundling: `assets/macos/node/bin/node assets/codemie-cli/node_modules/@codemieai/code/bin/codemie.js --version`, exit 0 **and** non-empty stdout.
4. **Build**: `CI=true cargo tauri build --bundles app dmg` from `src-tauri/`. `app` keeps the `.app` on disk for phase 5.
5. **Post-build assertions** on `src-tauri/target/release/bundle/macos/CodeMie Connect.app/Contents/Resources/`:
   - `bin/codemie` exists and is executable; `node/bin/node` exists, executable, > 10 MB; `cli/node_modules/@codemieai/code/bin/codemie.js` exists;
   - `cli/node_modules` has a file at least 4 levels deep (flattening detection);
   - no `*.exe` under `bin/`, `node/`, `cli/`;
   - **the bundled shim runs**: `"<App>/Contents/Resources/bin/codemie" --version` exits 0 with non-empty stdout. This exercises shim, node and tree exactly as an installed user would;
   - a `.dmg` exists in `src-tauri/target/release/bundle/dmg/`.

Everything the script prints on failure names a path or a command.

### 9. Signing

Out of scope (EPMCDME-14508). Constraints this design fixes for 14508:
- Node stays under `Contents/Resources`, which the Tauri signer does not touch, so its Node.js Foundation signature and entitlements survive. Do not move it to `Contents/MacOS`.
- `keytar.node` is unsigned; Node's `disable-library-validation` entitlement is what lets it load. Any re-signing of node must keep that entitlement plus `allow-jit` and `allow-unsigned-executable-memory`.
- No Developer ID certificate or `.env.signing` exists on the build machine today (`security find-identity` returns 0 identities), so this ticket produces an unsigned DMG and verifies it on the build machine, not through Gatekeeper.

---

## Acceptance Criteria

- On an Apple Silicon Mac with no Node, npm or CodeMie on PATH, after copying the app to `/Applications` and launching it once, a new terminal runs `codemie --version` and prints a version.
- `codemie install claude` completes using only the bundled runtime.
- A pre-existing system Node.js is unchanged; `which node` does not resolve into the bundle.
- No admin prompt during install or first run.
- The PATH change is one marker block in `~/.zprofile` pointing at `<App>/Contents/Resources/bin`; nothing is written when the app runs from a DMG mount or an App Translocation path.
- `run_self_update` invokes the bundled node with the absolute entry path on both platforms.
- `build-installer.sh` exits non-zero with a named path for any missing, empty or non-executable bundled artifact, and for an empty smoke stdout, and exposes no switch that skips or downgrades a check.
- `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test`, `npm test` pass on macOS with the tree staged; `cargo test` on Windows is unaffected.

---

## Test Coverage Requirements

**Node** (`ui/test/shim.test.mjs`, source assertions like the Windows ones): the macOS shim uses `$(dirname "$0")/..` and never `../..`; targets `node/bin/node`; targets `bin/codemie.js` and never `dist/index.js`; uses `exec`. `runtime.json` carries a 64-hex `nodeMacosArm64Sha256`. `tauri.macos.conf.json` maps the three resources and contains no glob.

**Rust** (`pathman.rs`, `#[cfg(all(test, not(windows)))]`): `should_persist_bundle_dir` rejects `/Volumes/…` and any path with an `AppTranslocation` component and accepts `/Applications/…`; `probe_dir` finds `codemie` in a temp dir and rejects an empty one.

**Rust** (`runner.rs`, unix): `self_update_direct` returns `Err` when the node path is not executable, the mirror of the existing Windows test.

**Rust** (`tests/bundle_resources.rs`): already merges `tauri.macos.conf.json`; with the tree staged it resolves 1:1 on macOS.

**Manual, on this Mac** (no clean VM exists): build with `build-installer.sh`, copy the `.app` to `/Applications`, open a shell with `PATH=/usr/bin:/bin:/usr/sbin:/sbin` plus the bundle `bin`, run `codemie --version` and `codemie doctor`. Then the full wizard from the app.

---

## Non-goals

- Intel / universal builds.
- Signing, notarization, Gatekeeper validation (14508).
- A `.pkg` installer with a postinstall hook.
- Changing `config/steps.yaml`, the PTY shell, or `handlers.js`.
- CI (14571). The staging script is run by the developer, as on Windows.

---

## Open risks

- **`cargo test` and `cargo clippy` need the staged tree on macOS from now on**, exactly as on Windows: tauri-build checks every declared resource at compile time. Run `scripts/stage-runtime.sh` once after cloning; the 274 MB tree is gitignored and stays. Worktrees do not share it. Recorded in `.ai-run/guides/quality-gates.md`.
- **Moved app**: if the user later drags the app elsewhere, the `~/.zprofile` entry is stale; the next launch appends a second block for the new path and the old one is harmless. Not solved here.
- **Precedence over a Homebrew `codemie`** depends on `~/.zprofile` order. A user who edits the file by hand can invert it; the app does not police that.
- **Unsigned DMG**: on another Mac Gatekeeper will block the app until 14508 lands. Verification in this ticket is on the build machine only.
