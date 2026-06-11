# Technical Research

**Task**: windows tauri cross-platform installer pty-terminal bundling
**Generated**: 2026-06-11

---

## 1. Original Context

> let's make windows compatible build as well. it should look like totally same, but installation and terminal invocation should be probably different. you can explore additionally here I think "/Users/Vadym_Vlasenko/AI/projects/codemie-claude-installer-win". let's do correctly and do not break current application and logic for macos. works cool

**Interpretation**: Add a Windows target to the existing macOS Tauri app so the same UI/UX runs on Windows, without regressing the working macOS path. Installation mechanics and terminal/shell invocation differ per OS. A separate Python/PyInstaller Windows installer exists at `codemie-claude-installer-win` — it is a *behavioral reference* for what Windows must install and how it elevates, not code to reuse.

---

## 2. Codebase Findings

### Architecture (primary repo — macOS Tauri, "Option B")

The app is a **frontend-brain + thin Rust backend**. The install orchestration logic lives in platform-agnostic vanilla-JS ES modules; Rust provides only thin, platform-specific system commands invoked over Tauri IPC.

- Frontend orchestration (platform-agnostic): `ui/engine.js`, `ui/handlers.js`, `ui/models.js`, `ui/renderer.js`, `ui/terminal.js`, `ui/runner-bridge.js`.
- Rust command layer (platform-specific): `src-tauri/src/commands/*.rs`, registered in `src-tauri/src/lib.rs:27-57`.
- Embedded step plan: `config/steps.yaml` → `src-tauri/src/steps.rs:51` (`include_str!`).

**Key finding**: the macOS-specific surface is small, isolated, and well-named. There is currently **no `#[cfg(target_os = "...")]` anywhere** in the Rust source — the code is unconditionally macOS-only (hardcoded `/bin/zsh`, `osascript`, `~/Library/Logs`, etc.). This is the central fact for the port: Windows support is achieved by introducing OS-conditional branches (or per-OS modules) around ~6 Rust files, not by rewriting the orchestration.

### Existing Implementations (the platform touchpoints)

| File | Role | macOS-specific evidence |
|---|---|---|
| `src-tauri/src/commands/pty.rs` | Interactive PTY for TUI steps (`codemie setup`, `codemie install claude`). Uses `portable-pty` (ConPTY-capable). | `pty.rs:47-49` spawns `/bin/zsh -lc <cmd>`; `pty.rs:45` reads `HOME`. |
| `src-tauri/src/commands/runner.rs` | Shell exec: `run_capture` / `run_stream` / `run_fresh_env`. | `runner.rs:14` `const SHELL = "/bin/zsh"`; `runner.rs:34,72` `-lc` flag. |
| `src-tauri/src/commands/pathman.rs` | Login-shell PATH resolution + `~/.zprofile` persistence + `:`-dedupe. | `pathman.rs:13-21` `/opt/homebrew/bin` etc.; `:74-96` `$SHELL -ilc`; `:108-128` writes `~/.zprofile`; `:24-34` colon separator. Called at startup `lib.rs:22`. |
| `src-tauri/src/commands/inspector.rs` | Probes git/node/npm/codemie; binary-path fallbacks. | `inspector.rs:8-9` `/usr/bin/git`, `/opt/homebrew/bin/node` etc.; `inspector.rs:100` `codemie profile status < /dev/null` (Unix `/dev/null`). Probe *commands* (`git --version`) are shell-agnostic. |
| `src-tauri/src/commands/installer.rs` | Node `.pkg` URL + `osascript` sudo install + Xcode CLT (Git) installer. | `installer.rs:23` `.pkg` URL; `:56-71` `osascript ... with administrator privileges`; `:76` `installer -pkg`; `:87` `xcode-select --install`. |
| `src-tauri/src/commands/logger.rs` | File logger. | `logger.rs:31` `~/Library/Logs/CodeMie`; `:59` `open` to view log. |
| `src-tauri/src/lib.rs` | Builder + startup. | `lib.rs:22` calls `apply_resolved_shell_path()` (login-shell PATH resolution — no Windows analog). |
| `ui/handlers.js` | Per-step glue. | `handlers.js:21` `tmpDir \|\| '/tmp'`; `:114` `node-v${version}.pkg`; `:119` `rememberDirs(['/usr/local/bin'])`. |
| `ui/renderer.js` | Engine wiring. | `renderer.js:249` `arch: 'universal'` (macOS universal `.pkg` assumption). |

`window.rs`, `smoke.rs`, `downloader.rs`, `steps.rs` are **already platform-neutral** (reqwest download, window resize, env-var smoke flags). `icon.ico` already exists in `src-tauri/icons/` — one fewer Windows gap.

### Architecture and Layers Affected

- **PTY / terminal layer** (`pty.rs`): shell command string only — see Risk note, the crate itself is fine.
- **Shell-exec / runner layer** (`runner.rs`): shell binary + flags.
- **PATH / environment layer** (`pathman.rs` + `lib.rs:22` startup): structural reimplementation (registry, not file + colon string).
- **Inspector layer** (`inspector.rs`): binary-path fallbacks + `/dev/null`.
- **Installer layer** (`installer.rs`): download targets + **elevation model** (the highest-novelty area).
- **Logger layer** (`logger.rs`): log dir + open command.
- **Bundle / build layer** (`tauri.conf.json`, `Cargo.toml`): Windows targets + target-gated deps.
- **Frontend glue** (`handlers.js`, `renderer.js`): a few hardcoded macOS path strings.

### Integration Points

- Frontend → backend: `invoke('<command>', {...})` via `ui/runner-bridge.js` (the only JS↔Rust seam). Backend → frontend: `app.emit("engine:<event>", payload)` (`runner.rs:87`, `pty.rs:90`, etc.). **The IPC contract is platform-neutral** — Windows ports change the *implementation* of existing commands, not the JS surface or event names. This is what makes "look totally same" achievable.
- External: `nodejs.org/dist` (Node download + LTS index), npm registry (`@codemieai/code`), GitHub releases (Git for Windows, per reference).

### Patterns and Conventions

- One Rust file per system concern under `commands/`; pure helpers + `#[tauri::command]` wrappers + `#[cfg(test)]` block (development-practices.md).
- Errors: all fallible commands return `CmdResult<T>` = `Result<T, InstallerError>` (`error.rs:25`); serializes to a plain string for IPC.
- New commands must be registered in `lib.rs` `invoke_handler!` and wrapped in `runner-bridge.js` (architecture.md "Adding New System Commands").
- Convention for the port: prefer `#[cfg(target_os = "windows")]` / `#[cfg(not(target_os = "windows"))]` branches inside the existing command files (or split `installer.rs` into `installer_macos.rs` / `installer_windows.rs` behind a `cfg` `mod`), preserving identical command names so the JS bridge and registration are unchanged.

---

## 3. Reference Windows Installer (behavioral findings only)

The secondary repo (`codemie-claude-installer-win`, Python + customtkinter + PyInstaller) mirrors this app's step model 1:1 (same step IDs, same approval-gate concept, same `steps.yaml` shape). It is the authoritative source for **what Windows must do**, not how to render it.

| Concern | Reference behavior (Windows) | Evidence |
|---|---|---|
| Shell | PowerShell: `powershell.exe -NoProfile -NonInteractive -Command <cmd>`. | `powershell_runner.py:21-27` |
| Interactive TUI | Spawns a **separate visible console** (`CREATE_NEW_CONSOLE`) for `codemie setup` / `codemie install claude`. | `powershell_runner.py:54-67`, `step_engine.py:400-407,419-426` |
| Git install | Download Git-for-Windows `.exe`, run `/VERYSILENT /NORESTART`. | `step_engine.py:17-20,294-305` |
| Node install | Download `node-...-x64.msi`, run `msiexec /i <msi> /quiet /norestart`. | `step_engine.py:21,344-357` |
| PATH | Read/write `HKCU\Environment` (and read `HKLM` system PATH) via `winreg`; broadcast `WM_SETTINGCHANGE`. `;`-separated. | `path_manager.py:9-54` |
| Fresh env | Re-read PATH from registry (HKCU + HKLM) into a fresh env dict for the next subprocess. | `powershell_runner.py:69-99` |
| Elevation | Detect admin (`IsUserAnAdmin`); **relaunch the entire process elevated** (`ShellExecuteW "runas"`) with state save/resume to a temp JSON. | `privilege_manager.py:15-46` |
| Default install locations probed | `C:\Program Files\Git\cmd\git.exe`, `C:\Program Files\nodejs\node.exe`. npm prefixes: `%USERPROFILE%\AppData\Roaming\npm`, `%USERPROFILE%\AppData\Local\CodeMie\npm-prefix`. | `system_inspector.py:35-39`, `step_engine.py:374-377` |
| Extra step | Adds step `1.0` "PowerShell execution policy" (`Set-ExecutionPolicy RemoteSigned -Scope CurrentUser`) that the macOS `steps.yaml` deliberately dropped. | win `config/steps.yaml:2-6`; macOS `config/steps.yaml:2` ("step 1.0 … dropped — no macOS analog") |
| No-console flag | All non-interactive subprocesses use `CREATE_NO_WINDOW` to suppress flashing console windows. | `system_inspector.py:25,48`, `powershell_runner.py:36,78` |
| Build | PyInstaller `--onefile`, `console=False`, `icon=assets/icon.ico`. Not reusable — different stack. | `build.bat`, `codemie_wizard.spec` |

**Important design caveat (flagged for downstream design phase, not decided here):** the reference uses an *external visible console* for interactive steps. The current Tauri app renders interactive steps inside an **embedded xterm/PTY** (`ui/terminal.js` + `pty.rs`). To honor "look totally same", the Windows port should **keep the embedded PTY** (portable-pty drives Windows ConPTY) and **not** copy the external-console pattern. Treat the reference's interactive handling as *what command to run*, not *how to display it*.

---

## 4. Windows Gap → File Map

Each row is one Windows gap mapped to the file(s) that must change. Goal: identical command names + identical `engine:*` events so the frontend is unchanged.

| # | Gap | File(s) to change | Specific change |
|---|---|---|---|
| 1 | Non-interactive shell | `src-tauri/src/commands/runner.rs:14,34,72` | Replace `/bin/zsh -lc` with a Windows shell: `cmd.exe /C <cmd>` or `powershell.exe -NoProfile -NonInteractive -Command <cmd>`, behind `cfg(windows)`. Keep `capture`/`run_stream` signatures. |
| 2 | Interactive PTY shell | `src-tauri/src/commands/pty.rs:45-55` | Spawn a Windows shell in the PTY (ConPTY via portable-pty — **no crate change**). Use `USERPROFILE` instead of `HOME` for cwd/env. Keep the base64 reader-thread protocol identical. |
| 3 | Login-shell PATH resolution | `src-tauri/src/commands/pathman.rs:74-105`, `src-tauri/src/lib.rs:22` | No Windows login-shell concept. Replace `resolve_shell_path`/`apply_resolved_shell_path` with a Windows path: read `HKCU\Environment` + `HKLM\...\Session Manager\Environment` (via `winreg`). On Windows the GUI process already inherits a usable PATH, so startup resolution may be a no-op or a registry refresh. |
| 4 | PATH persistence | `src-tauri/src/commands/pathman.rs:108-135` | Replace `~/.zprofile` append with `HKCU\Environment` registry write + `WM_SETTINGCHANGE` broadcast (ref `path_manager.py`). `persist_to_zprofile` should remain a registered command name (or add a neutral `persist_path`) to avoid breaking the JS bridge. |
| 5 | PATH separator / candidate dirs | `src-tauri/src/commands/pathman.rs:13-21,24-34,48-69` | `;` vs `:`; Windows candidate dirs (`%APPDATA%\npm`, `%LOCALAPPDATA%\CodeMie\npm-prefix`, `C:\Program Files\nodejs`, `C:\Program Files\Git\cmd`). |
| 6 | Binary-path fallbacks | `src-tauri/src/commands/inspector.rs:8-9,109-122` | Windows default install paths (`C:\Program Files\Git\cmd\git.exe`, `C:\Program Files\nodejs\node.exe`). |
| 7 | `/dev/null` redirect | `src-tauri/src/commands/inspector.rs:100` | `codemie profile status < /dev/null` → `< NUL` on Windows. |
| 8 | Node installer | `src-tauri/src/commands/installer.rs:19-24,73-81` | Build `node-...-x64.msi` (or arm64) URL instead of `.pkg`; install via `msiexec /i <msi> /quiet /norestart` instead of `installer -pkg`. |
| 9 | Git installer | `src-tauri/src/commands/installer.rs:85-117` | Replace `xcode-select --install` + poll with Git-for-Windows `.exe` download + `/VERYSILENT /NORESTART` (ref `step_engine.py:294-305`). |
| 10 | Elevation model | `src-tauri/src/commands/installer.rs:56-71` (`sudo_exec`) | **Open design decision (see Risk #2).** Either self-elevating `msiexec`/UAC per-op (keeps current per-command model) or full-process relaunch w/ state save-resume (ref `privilege_manager.py`). The latter does not exist today. |
| 11 | Logging path + open | `src-tauri/src/commands/logger.rs:29-32,57-64` | `%LOCALAPPDATA%\CodeMie\Logs` (or similar) instead of `~/Library/Logs/CodeMie`; open with `explorer`/`cmd /c start` instead of `open`. |
| 12 | Frontend macOS strings | `ui/handlers.js:21,114,119`, `ui/renderer.js:249` | `tmpDir` already injected via `invoke('temp_dir')` (neutral) — but `node-v${version}.pkg` filename, `'/usr/local/bin'` remembered dir, and `arch:'universal'` are macOS assumptions. Drive these from the backend (`node_pkg_url` returns the right extension; backend reports remembered dirs) so JS stays platform-agnostic. |
| 13 | Step plan wording / 1.0 step | `config/steps.yaml` | macOS messages say "on this Mac", "Xcode Command Line Tools", "macOS system dialog". Windows needs its own wording and (optionally) the dropped `1.0` execution-policy step. Cleanest: ship a Windows `steps.yaml` selected by `cfg`, or make messages OS-aware. |
| 14 | Bundle config | `src-tauri/tauri.conf.json:26-41` | `targets: ["dmg"]` → add `nsis` and/or `msi` (WiX). Add a `bundle.windows` block. `icon.ico` already listed. |
| 15 | Windows-only Cargo deps | `src-tauri/Cargo.toml:27-41` | Add `[target.'cfg(windows)'.dependencies]` for `winreg` (registry) and `windows`/`winapi` (elevation/broadcast) so the **macOS build never pulls them**. |

---

## 5. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/architecture/architecture.md` — confirms Option B (JS brain, thin Rust), the one-file-per-concern command layout, the IPC pattern (`invoke`/`emit`), and "Adding New System Commands" steps. Names every command file and its responsibility.
- `.ai-run/guides/development/development-practices.md` — error-handling (`CmdResult`/`InstallerError`), logging tags, async patterns, naming.
- `.ai-run/guides/testing/testing-patterns.md` — Rust inline `#[cfg(test)]` + JS `node --test`; "real shell, no mocks" Rust testing philosophy; smoke modes.
- `.ai-run/guides/quality-gates.md`, `.ai-run/guides/standards/git-workflow.md`, `.ai-run/guides/project.md` — present (GitLab MR workflow, brianna Jira adapter).

### Architectural Decisions

- **Option B (architecture.md:37)**: orchestration brain stays in JS; Rust is thin system commands. **Implication for this task**: the Windows port is almost entirely backend; the JS engine/handlers should change minimally (only the 4 hardcoded strings in Gap #12). This is what makes "look totally same" structurally cheap.
- `config/steps.yaml:1-3` records that the macOS plan was *ported from the Windows reference* and that step `1.0` was intentionally dropped — direct provenance link between the two repos.

### Derived Conventions

- Per-OS behavior should be expressed as `#[cfg(target_os = ...)]` branches inside the existing command files, or as `cfg`-gated sibling modules, **keeping registered command names identical** so `lib.rs` and `runner-bridge.js` are untouched. There is no precedent in-repo yet (no `cfg` exists today) — this convention is being established by this task.

---

## 6. Testing Landscape

### Existing Coverage

- Rust: `runner.rs:129-146`, `pathman.rs:149-183`, `inspector.rs:124-186`, `logger.rs:66-85`, `installer.rs:119-139`, `steps.rs:87-116`.
- JS: `ui/test/engine.test.mjs` (orchestration), `ui/test/models.test.mjs`. Run via `npm test` (`package.json:8`).

### Testing Framework and Patterns

- Rust: inline `#[cfg(test)]`, `#[tokio::test]` for async, **real system / no mocks** (testing-patterns.md). JS: `node:test` + `node:assert/strict`, synthetic `emit` injection.

### Coverage Gaps (and a platform hazard)

- **The real-shell Rust tests are Unix-coupled and will FAIL on a Windows runner unless `cfg`-gated.** `runner.rs:135` runs `/bin/zsh -lc 'echo hi'`; `runner.rs:142` runs `exit 3`; `pathman.rs:178` (`resolve_shell_path_captures_real_login_shell_path`) asserts a login-shell PATH; `inspector.rs:130` parses `v24.15.0`. These tests bake in POSIX semantics and a login shell that do not exist on Windows.
- No tests exist for the Windows install/elevation/registry paths (they will be new code).
- The genuine install operations and PTY interactivity are never run automatically on either OS (testing-patterns.md "What Is Not Tested"); verified by hand + smoke modes (`CODEMIE_SMOKE`, `CODEMIE_PROBE_SMOKE`).

---

## 7. Configuration and Environment

### Environment Variables

- macOS reads `HOME`, `PATH`, `SHELL` (`pathman.rs`, `pty.rs:45-46`, `runner.rs`). Windows analogs: `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `PATH` (no `SHELL`).
- Smoke flags (platform-neutral): `CODEMIE_SMOKE`, `CODEMIE_PROBE_SMOKE`, `CODEMIE_SMOKE_MS`, `CODEMIE_SHOT` (`smoke.rs:15-25`).

### Configuration Files

- `config/steps.yaml` — embedded via `include_str!` (`steps.rs:51`). macOS-worded; needs Windows variant (Gap #13).
- `src-tauri/tauri.conf.json` — bundle/window/CSP. Bundle target currently `dmg` only (Gap #14).
- `src-tauri/capabilities/default.json` — only `core:default` permissions; no FS/shell plugin caps to adjust (commands are custom, not plugin-based).

### Feature Flags and Deployment Concerns

- No feature flags. Per-OS selection is compile-time (`cfg`) + Tauri per-target bundle config.
- **Build mechanics (task #4)**: Tauri Windows bundles (NSIS and/or WiX MSI) **must be built on a Windows host or Windows CI runner** — cross-compiling a Windows installer from macOS is not supported (WiX/NSIS toolchains and the WebView2 dependency are Windows-only). **CI is implied** for producing the Windows artifact. The macOS DMG continues to build on macOS. The Windows app also depends on the **WebView2 runtime** (a deployment concern; bundle it via Tauri's WebView2 install mode or document the prerequisite).

---

## 8. Risk Indicators

- **Elevation architecture mismatch is the #1 complexity driver.** macOS elevates per-command via `osascript` (`installer.rs:56`). The Windows reference relaunches the *entire process* elevated with save/resume state (`privilege_manager.py:41`). These are incompatible models, and the Tauri app has **no state-save/resume mechanism today**. Choosing the Windows approach (self-elevating `msiexec`/UAC per-op vs. full-process relaunch) is an unresolved design decision that materially changes scope.
- **PATH handling is a structural reimplementation, not a constant swap.** `pathman.rs` login-shell resolution + `~/.zprofile` + `:`-dedupe have no Windows analog; Windows uses registry (`HKCU\Environment`) + `WM_SETTINGCHANGE`. The startup call at `lib.rs:22` also needs a Windows branch.
- **macOS-build regression risk from Windows-only crates.** `winreg`/`windows`/`winapi` must be confined to `[target.'cfg(windows)'.dependencies]` (Gap #15) or they break the macOS `cargo build`/`cargo test`.
- **Unix-coupled Rust tests will fail on Windows CI** (`runner.rs:135,142`, `pathman.rs:178`, `inspector.rs:130`) unless `#[cfg(...)]`-gated. Touching `runner.rs`/`pathman.rs` without gating their tests breaks the suite on the new platform.
- **PTY display divergence risk**: copying the reference's external-console pattern would violate "look totally same". Keep the embedded ConPTY PTY (`pty.rs` + `ui/terminal.js`); only the spawned shell string changes (`pty.rs:47`). Do not change the base64 reader-thread protocol (`pty.rs:81-94`).
- **Silent Unix leaks in shared code**: `inspector.rs:100` `< /dev/null` (→ `NUL`), `handlers.js:114` `.pkg` filename, `handlers.js:119` `'/usr/local/bin'`, `renderer.js:249` `arch:'universal'`. These are easy to miss because they sit in otherwise-neutral code.
- **No `cfg` precedent in the repo**: introducing the first OS-conditional code; reviewers must ensure every macOS code path stays reachable under `cfg(not(windows))` so the working build is byte-for-byte unaffected.
- **WebView2 runtime dependency** on Windows is a deployment prerequisite with no macOS analog.
- **Build/test cannot be fully validated on this macOS dev box** — the Windows bundle and Windows-conditional code paths require a Windows runner; expect to verify the Windows half via CI, not locally.

---

## 9. Summary for Complexity Assessment

This is a **moderate-to-high complexity, backend-concentrated** task whose difficulty comes from breadth and one genuinely novel subsystem rather than from deep coupling. The frontend orchestration (`ui/engine.js`, `ui/handlers.js`, `ui/renderer.js`) is platform-agnostic by design (Option B), and the JS↔Rust IPC contract — command names and `engine:*` events — is already platform-neutral, so "look totally same" is structurally cheap: the UI and event flow do not change. The work lands in the Rust command layer and the bundle config. Expect roughly **12–15 files touched**: ~6 Rust command files (`runner.rs`, `pty.rs`, `pathman.rs`, `inspector.rs`, `installer.rs`, `logger.rs`) plus `lib.rs` startup, `Cargo.toml` (target-gated deps), `tauri.conf.json` (NSIS/MSI targets), a Windows `config/steps.yaml`, and ~4 small string edits in `handlers.js`/`renderer.js`.

**Technical novelty is concentrated in two places.** First, **elevation**: macOS's per-command `osascript` model and the Windows reference's full-process-relaunch-with-state-resume model are incompatible, and the app has no resume mechanism today — this is an unresolved design decision that can swing the estimate by a lot. Second, **PATH management**: the entire login-shell-resolution + `~/.zprofile` + colon-dedupe machinery has no Windows analog and must be reimplemented against the Windows registry with a `WM_SETTINGCHANGE` broadcast. Everything else (shell string, installer download/exec, log path, `/dev/null`→`NUL`) is established-pattern adaptation guided directly by the working Python reference. Notably, `portable-pty` already supports Windows ConPTY, so the PTY does **not** need a new crate — only its spawned shell changes.

**Test coverage posture is mixed and carries a platform trap.** The existing Rust tests run against a real Unix login shell (`runner.rs`, `pathman.rs`, `inspector.rs`) and will fail on a Windows CI runner unless `#[cfg(...)]`-gated; the Windows install/elevation/registry code will be entirely new and currently untested, and real installs are never exercised automatically on either OS. Key risk factors for scoring: (1) the elevation design choice, (2) the structural PATH reimplementation, (3) keeping Windows-only crates and tests `cfg`-gated so the proven macOS build never regresses, and (4) the build requiring a Windows host/CI runner plus a WebView2 runtime dependency — meaning the Windows half cannot be fully validated on the current macOS development machine.
