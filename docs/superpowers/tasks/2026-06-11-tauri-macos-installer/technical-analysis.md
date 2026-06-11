# Technical Research

**Task**: tauri rust electron migration installer macos
**Generated**: 2026-06-11T00:00:00Z

---

## 1. Original Context

Migrate the CodeMie macOS installer from Electron to Tauri. The existing Electron app lives at /Users/Vadym_Vlasenko/AI/projects/codemie-claude-installer-macos and weighs 550MB when packaged. The goal is a Tauri-based app that is functionally equivalent but dramatically smaller (target under 20MB DMG). The new project will live at /Users/Vadym_Vlasenko/AI/projects/codemie-claude-installer-macos-tauri. Key requirements: macOS only, no code signing needed, same installation wizard UX (steps: check Git, check Node.js, install CodeMie CLI, configure CodeMie interactively via PTY, install Claude Code engine via PTY, validate). The UI reuses the existing HTML/CSS (dark theme, sprite animation, step list, xterm.js terminal overlay for interactive PTY steps, log panel). Backend moves from Node.js/Electron to Rust/Tauri. Must support: shell command execution (capture + stream to UI), PTY spawn for interactive codemie TUI steps (using portable-pty or similar Rust crate), file download with progress, sudo-elevated package install for Node.js .pkg, PATH resolution from user's login shell, writing to ~/.zprofile.

---

## 2. Codebase Findings

### Full Feature Inventory — Electron App

The reference app at `/Users/Vadym_Vlasenko/AI/projects/codemie-claude-installer-macos` consists of exactly 22 source files across four layers:

**Main-process modules (Node.js / Electron)**

- `src/main/main.js` — Entry point. Creates `BrowserWindow` (900×600, dark background `#0b0d14`, non-resizable, no menu bar). Wires all `ipcMain.handle` / `ipcMain.on` channels. Resolves user's login-shell PATH on startup via `pathman.applyResolvedShellPath()`. Holds a reference to the active PTY (`activePty`) for routing `pty-input` and `pty-resize` IPC events.
- `src/main/engine.js` — Orchestrates the install plan. Runs top-level steps in sequence; handles approval gates (pause / resume via `approve()` / `ignore()`); marks all remaining steps SKIPPED on fatal failure; emits all UI events through an injected `emit()` callback. Contains the key async approval gate: stores a `{ resolve }` closure as `this._gate` that is resolved when `approve()` or `ignore()` is called from an IPC handler.
- `src/main/handlers.js` — Per-step dispatch table keyed by step ID. Each handler receives an engine `ctx` object providing `line()`, `setSubtitle()`, `setStatus()`, `progress()`, `runSubStep()`. Implements `runPty()` — a helper that spawns a PTY, sets it as `activePty` via `setActivePty`, streams `pty-data` events, and resolves on exit code.
- `src/main/steps.js` — Loads and normalizes `config/steps.yaml` using `js-yaml`. Converts raw YAML entries to typed `Step` objects via `makeStep()`.
- `src/main/models.js` — Defines `StepStatus` enum (`PENDING | ACTIVE | COMPLETE | WARNING | ERROR | SKIPPED`) and `makeStep()` factory.
- `src/main/runner.js` — Three execution primitives: `runCapture(cmd)` → `{ code, stdout, stderr }`; `runStream(cmd, onLine)` → `{ code }` with line-by-line streaming callback; `runFreshEnv(cmd)` → runs with augmented PATH. All three spawn `/bin/zsh -lc <cmd>`. `spawnPty(cmd)` uses `node-pty` to open a PTY for interactive TUI steps.
- `src/main/inspector.js` — `Inspector` class. Probes `git --version`, `node --version`, `npm --version`, `codemie --help`. Filesystem fallbacks check known binary paths (`/usr/bin/git`, `/opt/homebrew/bin/git`, `/opt/homebrew/bin/node`, `/usr/local/bin/node`).
- `src/main/installer-macos.js` — `latestLtsNodeVersion()` fetches `https://nodejs.org/dist/index.json`. `nodePkgUrl()` builds the universal `.pkg` URL. `installNode(pkgPath)` calls `sudoExec('installer -pkg "..." -target /')`. `installGitCLT()` spawns `xcode-select --install` and polls `git --version` every 4 seconds up to 20 minutes. `sudoExec()` delegates to `@vscode/sudo-prompt` which pops the native macOS auth dialog.
- `src/main/pathman.js` — `resolveShellPath()` launches `/bin/zsh -ilc 'printf "%s" "__MARKER_${PATH}__MARKER_"'` and extracts the PATH from between markers. `applyResolvedShellPath()` merges shell PATH + current PATH + known candidate dirs. `persistToZprofile()` appends a `export PATH="...:"$PATH"` block to `~/.zprofile` idempotently. `augmentProcessPath()` mutates `process.env.PATH` at runtime.
- `src/main/downloader.js` — `download(url, dest, onProgress, redirects=5)`. HTTPS GET with redirect following (up to 5 hops), `content-length`-based progress fraction, 60-second timeout, streams to file via `fs.createWriteStream`.
- `src/main/logger.js` — Writes tagged log lines to `~/Library/Logs/CodeMie/codemie_wizard.log`. Tag vocabulary: `stdout/stderr/info/success/dim/prompt/approved`.

**Configuration**

- `config/steps.yaml` — 8 step definitions (IDs: `1.1`, `1.1.1`, `1.2`, `1.2.1`, `1.3`, `2.3.3`, `2.3.5`, `2.4`). Fields: `id`, `title`, `description`, `fatal`, `fatal_recommendation`, `is_sub_step`, `parent_id`, `requires_approval`, `approval_message`, `spinner`, `interactive`.

**Preload / IPC bridge**

- `src/preload/preload.js` — `contextBridge.exposeInMainWorld('codemie', {...})`. Exposes 2 query methods, 8 action methods, and 13 event listener methods. Full channel inventory in Section 7.

**Renderer (browser-side)**

- `src/renderer/index.html` — Single-page app. Two-column layout: left sprite panel (canvas + status pill + Install/Close buttons + unattended checkbox), right scrollable step list. Bottom log bar (toggle + open-log button), collapsible log panel. Terminal overlay div (for PTY steps), fatal error overlay div.
- `src/renderer/renderer.js` — Boot entry. Calls `api.getSteps()` and `api.getLogoPath()`, renders all modules. Wires all 13 engine event listeners. Handles Install/Close button clicks.
- `src/renderer/steps-ui.js` — Manages step rows. `renderSteps()`, `setStatus()`, `setSubtitle()`, `startSpinner()`, `stopSpinner()`, `setProgress()`, `insertSubStep()`, `showApproval()`, `stampApproval()`. Uses a `Map<id, row>` for O(1) updates.
- `src/renderer/terminal.js` — xterm.js + FitAddon. `initTerminal()`, `openTerminal()`, `writeData()`, `closeTerminal()`. Terminal keystrokes routed to `window.codemie.ptyInput()`.
- `src/renderer/sprite.js` — `initSprite(canvas, logoPath)`. Canvas-based animation at ~12 fps. States: `idle/working/warning/success/error/victory`. Renders breathing glow, rounded-rect masked logo image, accent ring, confetti (victory state), shake (error state).
- `src/renderer/log.js` — `initLog()`, `appendLine(text, tag)`. Tag-based CSS classes for color coding. Window-height expand/collapse via `setWindowHeight()` IPC.
- `src/renderer/styles.css` — GitHub-dark palette. CSS custom properties for all colors. Approval bar, stamp, log line color classes.
- `src/renderer/vendor/xterm.mjs`, `addon-fit.mjs`, `xterm.css` — Vendored xterm.js v6 and FitAddon (no CDN dependency).

**Assets**

- `assets/codemie-logo.svg` — 1.8KB SVG loaded at runtime via `file://` URL into the sprite canvas.

**Build / packaging**

- `package.json` — `electron@^42.4.0`, `node-pty@^1.1.0`, `@vscode/sudo-prompt@^9.3.2`, `js-yaml@^4.2.0`, `@xterm/xterm@^6.0.0`, `@xterm/addon-fit@^0.11.0`. Build: `electron-builder --mac --universal`.
- `electron-builder.yml` — `asar: true`, `asarUnpack: ["**/node-pty/**"]` (native module cannot be in asar). node-pty's `bin/` and `prebuilds/` stripped. Mac target: DMG, universal, `identity: null` (unsigned). App ID: `com.epam.codemie.installer`.

**Tests**

- 7 test files using Node.js `--test` runner: `engine.test.js`, `inspector.test.js`, `installer.test.js`, `logger.test.js`, `pathman.test.js`, `runner.test.js`, `steps.test.js`. Pure unit tests; no integration or E2E layer. No test for `downloader.js`, `models.js`, or renderer code.

---

### Architecture and Layers Affected

The migration touches every layer. Mapping current Electron layers to Tauri equivalents:

| Current Layer | Current Files | Tauri Equivalent |
|---|---|---|
| App bootstrap | `main.js` | `src-tauri/src/main.rs` (Tauri builder, plugin registration, state init) |
| IPC definitions (renderer→backend) | `preload.js` (contextBridge), `ipcMain.handle` | `#[tauri::command]` functions invoked via `invoke()` |
| IPC push (backend→renderer) | `win.webContents.send(channel, payload)` | `app_handle.emit(event, payload)` (Tauri v2) |
| Orchestration / engine | `engine.js` | Can stay in JS (Option B) OR port to Rust (Option A) — decision point |
| Shell execution | `runner.js` | Rust `std::process::Command` (capture/stream) via `tauri::command` |
| PTY | `runner.spawnPty`, `node-pty` | `portable-pty` crate — master/child in Tauri managed state |
| System inspection | `inspector.js` | Rust `inspector` module using `Command` |
| macOS installer | `installer-macos.js` | Rust `installer_macos` module |
| Sudo elevation | `@vscode/sudo-prompt` | `osascript -e 'do shell script "..." with administrator privileges'` |
| PATH management | `pathman.js` | Rust `pathman` module using `Command` + `fs::OpenOptions` |
| File download | `downloader.js` | `reqwest` crate (streaming, redirect follow, progress) |
| File logging | `logger.js` | Rust `logger` module using `std::fs::OpenOptions::append` |
| Window management | Electron `BrowserWindow` | Tauri `WindowBuilder` in `tauri.conf.json` + `tauri::Manager` |
| YAML config | `steps.js` + `js-yaml` | `serde_yaml` crate + Rust `steps` module OR ship YAML and parse in JS |
| Renderer (HTML/CSS/JS) | `src/renderer/` | `src/` or `ui/` — files copied nearly verbatim |

---

### Integration Points

**Internal dependencies within the Electron app:**
- `engine.js` ← `handlers.js` ← `runner.js`, `inspector.js`, `installer-macos.js`, `pathman.js`, `downloader.js`
- `main.js` ← all of the above + `steps.js`, `models.js`, `logger.js`
- `renderer.js` ← `steps-ui.js`, `terminal.js`, `sprite.js`, `log.js`

**External service integrations:**
- `https://nodejs.org/dist/index.json` — fetched to resolve latest LTS Node version
- `https://nodejs.org/dist/v{version}/node-v{version}.pkg` — Node.js universal installer download
- `npm install -g @codemieai/code` — npm registry (network)
- `codemie setup` — interactive TUI, spawned as PTY subprocess
- `codemie install claude --supported` — interactive TUI, spawned as PTY subprocess
- `codemie doctor` — non-interactive validation subprocess
- `xcode-select --install` — macOS system dialog for Xcode CLT
- `installer -pkg ... -target /` — macOS package installer (requires sudo)
- `/bin/zsh` — used as the shell for all command execution

---

### Patterns and Conventions

- **Dependency injection**: `makeHandlers(deps)` receives `inspector`, `runner`, `installer`, `pathman`, `downloader` as an object — enables unit testing without real system calls.
- **Engine context object** (`ctx`): each handler receives a typed context with `line()`, `setSubtitle()`, `setStatus()`, `progress()`, `runSubStep()` — a narrow, testable surface.
- **Step ID as dispatch key**: `handlers` is a plain `{ [stepId]: async (ctx) => bool | null }` map — easy to add/remove steps.
- **Idempotent detection**: every install step first detects (probe), then installs only if missing, then re-probes to confirm.
- **Approval gate pattern**: `engine._gate = { resolve }` holds a pending Promise resolver; `approve()` / `ignore()` call it — a JS-native coroutine hand-off that has no direct Rust async analog.
- **Emit fan-out**: all UI notifications go through a single `emit(event, payload)` function, making the IPC surface audit-able in one place.
- **Login-shell command execution**: all `spawn('/bin/zsh', ['-lc', cmd])` — `-l` flag crucial for resolving `~/.zprofile`-added PATH entries like npm prefix.
- **Fresh-env pattern**: `runFreshEnv` augments PATH with known candidate dirs + newly installed tool dirs before re-probing.
- **PTY active-ref pattern**: a module-level `activePty` reference in `main.js` is set/cleared by `setActivePty` callback passed into `makeHandlers` — routes `pty-input` and `pty-resize` IPC to the currently running PTY.

---

## 3. Documentation Findings

### Guides and Architecture Docs

No `.ai-run/guides/` directory exists in either the Electron or Tauri project. No `docs/` design documents found beyond the run directory itself. No CHANGELOG or README covering architecture decisions.

Conventions are derived entirely from code exploration below.

### Architectural Decisions

Recorded in comments within source files:

1. **`runner.js` line 9**: `SHELL_ARGS = (cmd) => ['-lc', cmd]` — "Login shell (`-l`) so the user's profile PATH ... is loaded" — explains why `-l` not `-c`.
2. **`electron-builder.yml` lines 10–27**: `asarUnpack: ["**/node-pty/**"]` with extended comment explaining node-pty's native module cannot be in asar, and that `bin/` and `prebuilds/` must be stripped for universal binary lipo-merge.
3. **`main.js` lines 197–201**: PATH resolved at app startup before window creation — "GUI-launched apps inherit a minimal PATH."
4. **`installer-macos.js` line 11**: `nodePkgUrl` ignores `_arch` — "the macOS Node.js installer is a single universal .pkg."
5. **`pathman.js` lines 78–81**: The `PATH_MARKER` trick with `printf '%s'` avoiding shell variable mis-parsing.
6. **`installer-macos.js` line 55**: `@vscode/sudo-prompt` is lazy-required so unit tests remain loadable without the native binary path.
7. **`runner.js` lines 51–60**: `node-pty` is lazy-required for the same reason.
8. **`main.js` line 9** (`electron-builder.yml`): `identity: null` — "Signing is intentionally disabled (per task). The DMG is unsigned/un-notarized."

### Derived Conventions

- Error handling: `try/catch` is used defensively in all I/O paths; errors are logged but never crash the app (logger `write()` swallows its own exceptions).
- All IPC channel names are namespaced: renderer→main channels are plain (`get-steps`, `start`, `approve`); main→renderer channels are prefixed with `engine:` (`engine:status-change`, `engine:pty-data`).
- No build tool (webpack/vite/rollup) on the renderer — vanilla ES modules loaded directly. This is preserved in Tauri with no bundler needed (Tauri's dev server / `distDir` can point to static files).
- YAML is the configuration format for steps; it is the sole file loaded from the bundled app resources at runtime.

---

## 4. Testing Landscape

### Existing Coverage

| Test File | What it covers |
|---|---|
| `test/engine.test.js` | Engine state machine: step sequencing, approval gate resolution, fatal propagation, sub-step activation, unattended auto-approve |
| `test/inspector.test.js` | `Inspector._probe()` parsing; `checkCodemie()` exit-127 / command-not-found heuristic |
| `test/installer.test.js` | `nodePkgUrl()`, `latestLtsNodeVersion()` (mocked HTTPS), `installNode()` command string |
| `test/logger.test.js` | `formatLine()`, `Logger.write()` tag mapping, log file path |
| `test/pathman.test.js` | `dedupePath()`, `missingEntries()`, `mergeShellPath()`, `persistToZprofile()` idempotency |
| `test/runner.test.js` | `runCapture()` / `runStream()` against real shell; exit-code propagation |
| `test/steps.test.js` | `loadSteps()` YAML parsing; `makeStep()` defaults |

### Testing Framework and Patterns

- **Framework**: Node.js built-in `--test` runner (no external test framework). No snapshot testing, no test doubles library.
- **Mocking**: manual function injection — `Inspector` receives `run` as constructor arg; installer tests pass mock `https.get` via module-level reassignment (brittle).
- **Fixtures**: inline YAML strings in `steps.test.js`; no shared fixture directory.
- **Coverage tooling**: none configured.

### Coverage Gaps

The following areas have **no tests** and will need new test coverage in the Tauri implementation:

- `downloader.js` / Rust download module (no test)
- `models.js` / Rust step model (no test beyond what `steps.test.js` incidentally exercises)
- Renderer modules: `steps-ui.js`, `terminal.js`, `sprite.js`, `log.js`, `renderer.js` — zero frontend test coverage
- The PTY spawn path (`runner.spawnPty`) — tested only by the `CODEMIE_SMOKE` smoke test, not by unit tests
- `main.js` bootstrap (window creation, IPC wiring) — not unit-testable in its current form
- All interactive step handlers (`2.3.3`, `2.3.5`) depend on live PTY

---

## 5. Configuration and Environment

### Environment Variables

| Variable | Where Used | Purpose |
|---|---|---|
| `CODEMIE_SMOKE` | `main.js` | Self-test mode: verify renderer boot + PTY, then quit |
| `CODEMIE_PROBE_SMOKE` | `main.js` | Run detection-only steps in unattended mode, then quit |
| `CODEMIE_SMOKE_MS` | `main.js` | Override smoke test delay (default 2500ms) |
| `CODEMIE_SHOT` | `main.js` | If set, capture a screenshot PNG to this path during smoke test |
| `SHELL` | `pathman.js` | User's preferred shell (default `/bin/zsh`) |
| `HOME` | `pathman.js`, `runner.js` | Used as PTY `cwd` and for `~/.zprofile` path |
| `PATH` | `runner.js`, `pathman.js` | Augmented at startup and after installs |
| `npm_config_prefix` | (implicit) | npm global prefix; read via `npm config get prefix` to find `codemie` binary post-install |

### Configuration Files

- `config/steps.yaml` — Install plan. Bundled inside the app (asar-packed). Loaded at startup by `loadSteps()`. In Tauri this becomes a static asset read via `tauri::api::path::resource_dir()` or bundled as a Rust `include_str!()` constant.
- `electron-builder.yml` — Build configuration. No Tauri equivalent; replaced by `src-tauri/tauri.conf.json`.
- `package.json` — Node dependency manifest. In Tauri: `package.json` is retained only if a JS frontend bundler (Vite) is used; otherwise only `src-tauri/Cargo.toml` is needed.

### Feature Flags and Deployment Concerns

- Smoke-test flags (`CODEMIE_SMOKE`, `CODEMIE_PROBE_SMOKE`) should be ported to Tauri using `std::env::var()` checks in `main.rs`.
- **No code signing** — `identity: null` in electron-builder. In Tauri: `"identity": null` and `"signingIdentity": "-"` (ad-hoc) in `tauri.conf.json > bundle > macOS`. Alternatively set `CODESIGN_IDENTITY="-"` in the build environment.
- **No notarization** — `tauri.conf.json > bundle > macOS > entitlements` can be omitted or left minimal.
- The app writes to `~/Library/Logs/CodeMie/` and `~/.zprofile` — these are user-writable paths; no sandbox entitlements needed.
- The app runs `installer -pkg ... -target /` with admin rights — this requires `com.apple.security.temporary-exception.mach-lookup.global-name` OR simply running via osascript which handles the privilege escalation outside the app's sandbox context. Since the app is unsigned/unsandboxed this is not an issue.

---

## 6. Risk Indicators

- **PTY thread-safety in Rust**: `portable-pty`'s reader is blocking. Output must be pumped on a dedicated `std::thread` (not a Tokio async task) that calls `app_handle.emit("pty-data", payload)` per chunk. The PTY master/writer + child process handle must live in Tauri managed state (`Mutex<Option<PtyState>>`) so `pty-input` and `pty-resize` Tauri commands can reach the active PTY. Forgetting the dedicated thread pattern and using an async reader causes hangs.
- **Approval-gate async coordination in Rust** (if Option A / engine-in-Rust is chosen): the JavaScript `engine.js` approval gate stores a `Promise` resolver closure (`this._gate = { resolve }`). The direct Rust equivalent is `tokio::sync::oneshot::channel()` — the `Sender` is stored in managed state, `approve` / `ignore` commands call `sender.send(true/false)`, the engine task `await`s the `Receiver`. This is non-trivial. **Option B** (keep engine/handlers in frontend JS, expose only granular Rust commands) avoids this entirely and reuses ~400 lines of well-tested JS — strongly recommended as the lower-risk approach.
- **`@vscode/sudo-prompt` replacement**: there is no mature, maintained Rust crate that wraps the macOS auth dialog as cleanly as `sudo-prompt`. The reliable, signing-free approach is `std::process::Command::new("osascript").args(["-e", &format!("do shell script \"{}\" with administrator privileges", cmd)])`. This pops the native Keychain-backed auth dialog. Do not use the `sudo` or `rpassword` crates — they require a terminal, not a GUI dialog.
- **`js-yaml` dependency**: YAML parsing for `config/steps.yaml` currently uses Node.js `js-yaml`. In Tauri, options are: (a) parse in Rust with `serde_yaml` crate and expose steps via a Tauri command, (b) embed the YAML as a Rust `include_str!()` constant and parse with `serde_yaml`, or (c) ship the YAML as a static frontend asset and parse in JS with a bundled YAML parser. Option (b) is simplest for a fixed installer plan.
- **No bundler on the renderer**: the existing renderer uses vanilla ES modules (`type="module"`). Tauri v2 supports a `devUrl`/`frontendDist` pointing to a static directory — the renderer files can be copied with minimal changes. However, `file://` scheme usage in `sprite.js` (`img.src = 'file://' + logoPath`) will change: in Tauri, assets are served via the custom `tauri://localhost` scheme or accessed via `convertFileSrc()` from `@tauri-apps/api/core`. This specific line must be updated.
- **`ipcRenderer.invoke` vs Tauri `invoke`**: all `ipcRenderer.invoke()` calls in preload become `invoke('command-name', args)` from `@tauri-apps/api/core`. All `ipcRenderer.on()` event subscriptions become `listen('event-name', callback)` from `@tauri-apps/api/event`. The preload layer (`contextBridge`) is **eliminated** — there is no sandbox boundary in the same way; Tauri's IPC is handled by the framework. The renderer can import `@tauri-apps/api` directly.
- **`setWindowHeight` IPC**: Electron's `win.setContentSize(w, h)` is called from main process in response to an IPC. In Tauri, this becomes `window.set_size(LogicalSize::new(w, h))` called inside a Tauri command that receives the `Window` parameter (use `LogicalSize`, not `PhysicalSize` — Electron`s `setContentSize` uses logical pixels; `PhysicalSize` on a Retina Mac is 2x and blows up the window). Or drive it from the frontend via `getCurrentWindow().setSize(new LogicalSize(w, h))` from `@tauri-apps/api/window`. The log panel expand/collapse resize behavior must be re-wired.
- **`shell.openPath` for log file**: Electron's `shell.openPath(path)` opens the log in the default viewer. Tauri v2 equivalent is the `tauri-plugin-opener` plugin's `open_path` or `open_url`. Alternatively, `std::process::Command::new("open").arg(path)` on macOS.
- **`app.getPath('temp')` for download destination**: Tauri equivalent is `tauri::api::path::temp_dir()` or `std::env::temp_dir()` in the Rust command handler.
- **Universal binary**: Electron-builder handled the universal (Intel + Apple Silicon) build with `--universal` flag. Tauri uses `tauri build --target universal-apple-darwin` (requires both `x86_64-apple-darwin` and `aarch64-apple-darwin` Rust targets installed). The `portable-pty` crate compiles natively for each target — no asar-unpack equivalent needed.
- **No test coverage for renderer code**: all five renderer modules (`steps-ui.js`, `terminal.js`, `sprite.js`, `log.js`, `renderer.js`) are untested. The migration carries this debt forward.
- **xterm.js vendored copies**: currently vendor-bundled as `.mjs` files. In the Tauri frontend they can remain vendored, or be replaced by npm-installed copies if Vite is added. No functional change needed.
- **`CODEMIE_SMOKE` screenshot test** uses `win.webContents.capturePage()` — a Chromium-only API with no direct Tauri equivalent. The smoke test harness will need rethinking (e.g., use `tauri-driver` + WebDriver).
- **`src-tauri/` directory does not yet exist**: the target project at `/Users/Vadym_Vlasenko/AI/projects/codemie-claude-installer-macos-tauri` is an empty shell (`run create tauri` not yet run). `cargo-tauri` CLI scaffolding is the first build task.

---

## 7. Summary for Complexity Assessment

The migration touches every architectural layer simultaneously: the Rust backend replaces 11 Node.js modules, the IPC surface is completely re-mapped from Electron contextBridge/ipcMain to Tauri commands/events, and the renderer undergoes surgical changes (asset URL scheme, preload elimination, API import replacement) while keeping the HTML/CSS intact. The estimated file change surface is 11 new Rust source files (main, engine_or_orchestration_glue, handlers, runner, inspector, installer_macos, pathman, downloader, logger, steps, models), 1 updated `tauri.conf.json`, and 5–6 renderer JS files requiring targeted edits. The `config/steps.yaml` and `styles.css` are carried over unchanged.

The most technically novel element is the PTY integration. `node-pty` had a well-established Electron pattern (native rebuild + asarUnpack); `portable-pty` is the Rust-native equivalent but requires a dedicated reader thread emitting Tauri events — a pattern that must be designed from scratch. The second novel element is the sudo elevation for `.pkg` install: `@vscode/sudo-prompt` must be replaced by an `osascript` shell invocation from Rust, which is idiomatic on macOS and requires no additional entitlements since the app is unsigned and unsandboxed. The approval-gate async coordination (the JavaScript Promise-resolver pattern in `engine.js`) is the highest-risk architectural decision: porting it to Rust as a `tokio::sync::oneshot` channel is sound but adds complexity; the lower-risk alternative (Option B) keeps the engine and step orchestration in frontend JavaScript and exposes only primitive Rust commands, reusing ~400 lines of thoroughly tested orchestration code.

Test coverage posture is mixed: the backend logic (engine, inspector, pathman, runner, steps, logger) has unit tests that are moderately thorough and will guide the Rust port. The renderer has zero test coverage and the PTY integration path has only a smoke test. The overall complexity rating should account for: (1) a fully greenfield Rust project with no existing scaffolding, (2) the PTY thread-emit pattern requiring careful Tauri managed-state design, (3) the Option A vs Option B architectural decision that must be resolved before implementation begins, and (4) the need to verify that the unsigned DMG target under 20MB is achievable (Tauri typically produces 3–8MB for macOS apps of this type, well within budget).

---

## 8. IPC Channel Mapping (Electron preload.js → Tauri v2)

This section provides the complete channel-by-channel migration map for all 23 IPC surface points in `src/preload/preload.js`.

**Tauri version target: v2.x (stable)**

### Renderer → Backend: Query commands (invoke)

| Electron channel | preload call | Tauri v2 command | Notes |
|---|---|---|---|
| `get-steps` | `ipcRenderer.invoke('get-steps')` | `invoke('get_steps')` | Returns serialized `Vec<Step>` from Rust; or reads embedded YAML |
| `get-logo-path` | `ipcRenderer.invoke('get-logo-path')` | `invoke('get_logo_path')` | Returns absolute path as `String`; frontend uses `convertFileSrc()` |

### Renderer → Backend: Action commands (invoke/send)

| Electron channel | preload call | Tauri v2 command | Notes |
|---|---|---|---|
| `start` | `ipcRenderer.invoke('start')` | `invoke('start')` | Spawns engine task; returns `Result<bool>` |
| `approve` | `ipcRenderer.send('approve')` | `invoke('approve')` | Sends on oneshot channel in managed state |
| `ignore` | `ipcRenderer.send('ignore')` | `invoke('ignore')` | Sends on oneshot channel in managed state |
| `set-unattended` | `ipcRenderer.send('set-unattended', v)` | `invoke('set_unattended', {value: v})` | Stores flag in managed state `Mutex<bool>` |
| `open-log` | `ipcRenderer.send('open-log')` | `invoke('open_log')` | Calls `open` shell command with log path |
| `close-app` | `ipcRenderer.send('close-app')` | `invoke('close_app')` or `appWindow.close()` from JS | Calls `app.exit(0)` |
| `set-window-height` | `ipcRenderer.send('set-window-height', h)` | `invoke('set_window_height', {height: h})` | Calls `window.set_size()` on Window handle |
| `pty-input` | `ipcRenderer.send('pty-input', data)` | `invoke('pty_input', {data})` | Writes to PTY master in managed state |
| `pty-resize` | `ipcRenderer.send('pty-resize', {cols, rows})` | `invoke('pty_resize', {cols, rows})` | Calls `pty.resize()` on PTY master |

### Backend → Renderer: Events (emit → listen)

| Electron channel | `win.webContents.send()` call | Tauri v2 event | Payload shape |
|---|---|---|---|
| `engine:status-change` | `emit('status-change', {id, status})` | `app_handle.emit("engine:status-change", payload)` | `{id: string, status: string}` |
| `engine:subtitle-change` | `emit('subtitle-change', {id, text})` | `app_handle.emit("engine:subtitle-change", payload)` | `{id: string, text: string}` |
| `engine:spinner-start` | `emit('spinner-start', {id})` | `app_handle.emit("engine:spinner-start", payload)` | `{id: string}` |
| `engine:approval-needed` | `emit('approval-needed', {id, message})` | `app_handle.emit("engine:approval-needed", payload)` | `{id: string, message: string}` |
| `engine:substep-activate` | `emit('substep-activate', {id, parent_id, step})` | `app_handle.emit("engine:substep-activate", payload)` | `{id: string, parent_id: string, step: Step}` |
| `engine:download-progress` | `emit('download-progress', {id, fraction})` | `app_handle.emit("engine:download-progress", payload)` | `{id: string, fraction: f64}` |
| `engine:terminal-line` | `emit('terminal-line', {text, tag})` | `app_handle.emit("engine:terminal-line", payload)` | `{text: string, tag: string}` |
| `engine:pty-open` | `emit('pty-open', {id, title})` | `app_handle.emit("engine:pty-open", payload)` | `{id: string, title: string}` |
| `engine:pty-data` | `emit('pty-data', {data})` | `app_handle.emit("engine:pty-data", payload)` | `{data: string}` — UTF-8 |
| `engine:pty-exit` | `emit('pty-exit', {code})` | `app_handle.emit("engine:pty-exit", payload)` | `{code: i32}` |
| `engine:fatal` | `emit('fatal', {id, message, recommendation})` | `app_handle.emit("engine:fatal", payload)` | `{id: string, message: string, recommendation: string}` |
| `engine:complete` | `emit('complete', {ok})` | `app_handle.emit("engine:complete", payload)` | `{ok: bool}` |

**Renderer-side change**: Replace `window.codemie.onStatusChange(cb)` etc. with `listen('engine:status-change', e => cb(e.payload))` from `@tauri-apps/api/event`. Replace `window.codemie.start()` etc. with `invoke('start')` from `@tauri-apps/api/core`. The `window.codemie` namespace and preload bridge are eliminated entirely.

---

## 9. Rust Crate Recommendations

| Need | Recommended Crate | Version | Notes |
|---|---|---|---|
| App framework | `tauri` | `2.x` | Core dependency; use `tauri = { version = "2", features = ["macos-private-api"] }` only if needed |
| Build-time | `tauri-build` | `2.x` | In `build.rs` |
| PTY spawn | `portable-pty` | `0.8.x` | Provides `PtySystem`, `PtySize`, `MasterPty`, `ChildProcess`. Reader is blocking — use `std::thread::spawn` to pump output. |
| HTTP download | `reqwest` | `0.12.x` | Features: `blocking = false`, `stream`, `rustls-tls`. Use `.bytes_stream()` for progress-reporting download. |
| Async runtime | `tokio` | `1.x` | Feature: `full`. Tauri 2 uses Tokio internally; `#[tauri::command]` async functions run on Tauri's Tokio runtime. |
| YAML parsing | `serde_yaml` | `0.9.x` | Parse `steps.yaml` embedded via `include_str!()`. Deserialize into `Vec<StepDef>`. |
| Serialization | `serde` | `1.x` | Features: `derive`. All command return types and event payloads must be `Serialize`; `StepDef` must also be `Deserialize`. |
| JSON (payloads) | `serde_json` | `1.x` | Used internally by Tauri for command arguments and event payloads. |
| Error handling | `thiserror` | `2.x` | Define `InstallerError` enum covering `Io`, `Command`, `Download`, `Pty`, `Sudo` variants. |
| Async streams | `futures` | `0.3.x` | Optional; `futures::StreamExt` for reqwest byte stream consumption. |
| Log file | `std::fs` | stdlib | `OpenOptions::new().append(true).create(true).open(path)` — no external crate needed. |
| Open file/URL | `tauri-plugin-opener` | `2.x` (Tauri plugin) | Replaces `shell.openPath`. Or just `std::process::Command::new("open").arg(path)`. |
| Shell interaction | `std::process::Command` | stdlib | All non-PTY command execution. No external crate needed. |

**Crates to avoid:**
- `sudo` crate — requires terminal; does not pop a GUI auth dialog.
- `elevation` crate — unmaintained.
- `nix` crate — Linux-focused; use only if PTY fallback is needed.
- `async-pty` / `ptyprocess` — less mature than `portable-pty`.

---

## 10. Recommended Project Structure

```
codemie-claude-installer-macos-tauri/
├── Cargo.toml                    # workspace (optional, single crate is fine)
├── package.json                  # only if using Vite for frontend; otherwise optional
├── src-tauri/
│   ├── Cargo.toml                # [dependencies]: tauri, portable-pty, reqwest, serde, serde_yaml, tokio, thiserror
│   ├── build.rs                  # tauri-build::build()
│   ├── tauri.conf.json           # window config, bundle, CSP, allowlist (Tauri v2: capabilities)
│   ├── capabilities/
│   │   └── default.json          # Tauri v2 capability file: allowed commands + event permissions
│   ├── icons/                    # .icns, .ico, .png (generated from codemie-logo.svg)
│   │   └── icon.icns
│   └── src/
│       ├── main.rs               # tauri::Builder::default(), manage() state, invoke_handler(), run()
│       ├── state.rs              # AppState struct: Mutex<Option<PtyHandle>>, Mutex<bool> (unattended), Arc<AppHandle>
│       ├── commands/
│       │   ├── mod.rs            # pub use all command modules
│       │   ├── engine.rs         # get_steps, start, approve, ignore, set_unattended
│       │   ├── runner.rs         # run_capture, run_stream (shell execution primitives)
│       │   ├── pty.rs            # spawn_pty, pty_input, pty_resize — manages PtyHandle in state
│       │   ├── installer.rs      # install_node_pkg (sudo via osascript), install_git_clt
│       │   ├── inspector.rs      # check_git, check_node, check_npm, check_codemie (probe commands)
│       │   ├── pathman.rs        # resolve_shell_path, persist_to_zprofile, augment_path
│       │   ├── downloader.rs     # download_file (reqwest streaming with progress events)
│       │   ├── logger.rs         # open_log (opens ~/Library/Logs/CodeMie/codemie_wizard.log)
│       │   └── window.rs         # set_window_height, close_app
│       ├── engine/
│       │   └── mod.rs            # OPTIONAL (Option A): Rust engine if orchestration is moved to backend
│       └── steps.rs              # load_steps(): parse embedded YAML, return Vec<Step>
├── ui/                           # (formerly src/renderer/)
│   ├── index.html                # COPY — update script imports only
│   ├── styles.css                # COPY unchanged
│   ├── renderer.js               # UPDATE: replace window.codemie.* with invoke/listen from @tauri-apps/api
│   ├── steps-ui.js               # COPY unchanged (pure DOM manipulation, no Electron API)
│   ├── terminal.js               # UPDATE: ptyInput/ptyResize now call invoke() directly
│   ├── sprite.js                 # UPDATE: replace file:// logoPath with convertFileSrc(logoPath)
│   ├── log.js                    # UPDATE: setWindowHeight calls invoke('set_window_height', ...)
│   ├── engine.js                 # COPY (Option B): keep JS orchestration, call Rust commands
│   ├── handlers.js               # COPY (Option B): keep JS handlers, call Rust commands
│   ├── models.js                 # COPY unchanged
│   ├── steps.js                  # UPDATE (Option B): load steps from invoke('get_steps') instead of YAML file
│   └── vendor/
│       ├── xterm.mjs             # COPY unchanged
│       ├── addon-fit.mjs         # COPY unchanged
│       └── xterm.css             # COPY unchanged
├── assets/
│   └── codemie-logo.svg          # COPY unchanged
└── config/
    └── steps.yaml                # COPY unchanged (embedded in Rust via include_str! or shipped as resource)
```

**Key `tauri.conf.json` settings (Tauri v2):**

```json
{
  "productName": "CodeMie Installer",
  "version": "2.0.0",
  "identifier": "com.epam.codemie.installer",
  "build": {
    "frontendDist": "../ui",
    "devUrl": "../ui"
  },
  "app": {
    "withGlobalTauri": true,
    "windows": [{
      "title": "CodeMie Installation Wizard",
      "width": 900,
      "height": 600,
      "resizable": false,
      "fullscreen": false,
      "decorations": true,
      "backgroundColor": "#0b0d14"
    }],
    "security": {
      "csp": "default-src 'self'; img-src 'self' asset: https://asset.localhost data:; style-src 'self' 'unsafe-inline'; script-src 'self'"
    }
  },
  "bundle": {
    "active": true,
    "targets": ["dmg"],
    "macOS": {
      "signingIdentity": null,
      "entitlements": null
    },
    "icon": ["icons/icon.icns"]
  }
}
```

---

## 11. Frontend Migration Strategy

### Files copied unchanged (zero modification)
- `styles.css` — no Electron-specific references
- `steps-ui.js` — pure DOM; all IPC calls come in via injected callbacks, none hardcoded
- `models.js` — pure data; no Node.js or Electron imports
- `vendor/xterm.mjs`, `vendor/addon-fit.mjs`, `vendor/xterm.css` — vendored, no changes

### Files updated surgically (targeted line changes only)

**`index.html`**
- Remove `<meta http-equiv="Content-Security-Policy">` tag (Tauri applies CSP from `tauri.conf.json`)
- No CDN script tag needed. Set `"withGlobalTauri": true` in `tauri.conf.json > app` (already shown in Section 10 config). This makes `window.__TAURI__.core.invoke`, `window.__TAURI__.event.listen`, `window.__TAURI__.core.convertFileSrc`, and `window.__TAURI__.window.getCurrentWindow` available globally with no npm install, no bundler, and no CSP violation. The CSP `script-src 'self'` remains intact.

**`renderer.js`**
- Replace `const api = window.codemie;` with direct `invoke`/`listen` calls
- Replace `api.getSteps()` → `invoke('get_steps')`
- Replace `api.getLogoPath()` → `invoke('get_logo_path')`, then wrap result in `convertFileSrc(path)`
- Replace `api.onStatusChange(cb)` → `listen('engine:status-change', e => cb(e.payload))`
- Replace all other `api.on*` listeners similarly
- Replace `api.start()` → `invoke('start')`
- Replace `api.approve()` → `invoke('approve')`
- Replace `api.close()` → `getCurrentWindow().close()` from `@tauri-apps/api/window`

**`terminal.js`**
- Replace `window.codemie.ptyInput(d)` → `invoke('pty_input', { data: d })`
- Replace `window.codemie.ptyResize(cols, rows)` → `invoke('pty_resize', { cols, rows })`

**`sprite.js`**
- Replace `img.src = 'file://' + logoPath` → `import { convertFileSrc } from '@tauri-apps/api/core'; img.src = convertFileSrc(logoPath)`

**`log.js`**
- Replace `window.codemie.openLog()` → `invoke('open_log')`
- Replace `window.codemie.setWindowHeight(h)` → `invoke('set_window_height', { height: h })`

### Files ported to Rust (eliminated as JS, reimplemented in Rust)
- `runner.js` → `src-tauri/src/commands/runner.rs`
- `inspector.js` → `src-tauri/src/commands/inspector.rs`
- `installer-macos.js` → `src-tauri/src/commands/installer.rs`
- `pathman.js` → `src-tauri/src/commands/pathman.rs`
- `downloader.js` → `src-tauri/src/commands/downloader.rs`
- `logger.js` → `src-tauri/src/commands/logger.rs`
- `steps.js` + `models.js` → `src-tauri/src/steps.rs`
- `main.js` → `src-tauri/src/main.rs`

### Option B specific (keep engine/handlers in JS)
- `engine.js` → `ui/engine.js`: unchanged except constructor receives Rust-backed command functions instead of Node.js module references
- `handlers.js` → `ui/handlers.js`: each handler replaces `runner.runCapture(cmd)` with `invoke('run_capture', { cmd })` etc.
- `preload.js` → eliminated; no replacement needed

---

## 12. PTY Integration Approach in Tauri

The PTY integration is the highest-complexity single component of the migration. The architecture must be:

**Rust side (`src-tauri/src/commands/pty.rs`):**

```
State: Mutex<Option<PtyHandle>>
  where PtyHandle {
    master: Box<dyn MasterPty + Send>,       // write + resize
    child:  Box<dyn Child + Send>,            // wait for exit
  }

#[tauri::command] spawn_pty(cmd: String, cols: u16, rows: u16, app: AppHandle, state: State)
  1. Create PtySystem::default() (uses platform PTY — /dev/pts on macOS)
  2. Open a PTY pair with PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }
  3. Build CommandBuilder for /bin/zsh with args ["-lc", cmd]
  4. Set env HOME, PATH (augmented), TERM=xterm-256color
  5. Spawn child from pair.slave
  6. Get reader from pair.master.try_clone_reader()
  7. Store PtyHandle { master: pair.master, child } in state
  8. Spawn std::thread::spawn(move || {
       let mut reader = ...;
       let mut buf = [0u8; 4096];
       loop {
         match reader.read(&mut buf) {
           Ok(0) | Err(_) => break,
           Ok(n) => {
             // CAUTION: a multi-byte UTF-8 char or ANSI escape sequence may be
             // split across two 4096-byte reads — from_utf8_lossy inserts U+FFFD
             // replacement chars mid-stream, corrupting TUI output. Buffer the
             // trailing incomplete sequence, or transmit as base64 and decode in JS.
             let data = String::from_utf8_lossy(&buf[..n]).to_string();
             app_handle.emit("engine:pty-data", PtyDataPayload { data }).ok();
           }
         }
       }
       // emit pty-exit after reader closes
     })
  9. Separately: wait for child exit in another thread, emit engine:pty-exit

#[tauri::command] pty_input(data: String, state: State)
  Lock state, call master.write_all(data.as_bytes())

#[tauri::command] pty_resize(cols: u16, rows: u16, state: State)
  Lock state, call master.resize(PtySize { rows, cols, ... })
```

**Key constraint**: `portable-pty`'s `try_clone_reader()` returns a `Box<dyn Read + Send>` — the `Read` impl is blocking. It must run on `std::thread`, not inside a Tokio async task (which would starve the runtime). The child-exit watcher also needs its own thread.

**Frontend side**: no change to `terminal.js` logic except replacing the `window.codemie` calls with `invoke`/`listen` as described in Section 11.

---

## 13. Build and Packaging Differences

| Concern | Electron (current) | Tauri v2 |
|---|---|---|
| Build command | `npm run build` → `electron-builder --mac --universal` | `cargo tauri build --target universal-apple-darwin` |
| Output | `dist/CodeMie-Installer-2.0.0-universal.dmg` (~550MB) | `src-tauri/target/universal-apple-darwin/release/bundle/dmg/*.dmg` (~5–15MB estimated) |
| Native module | `node-pty` rebuilt with `electron-rebuild` | `portable-pty` compiled from source by Cargo — no rebuild step |
| asar packing | `asar: true`, `asarUnpack: ["**/node-pty/**"]` | Not applicable — no asar in Tauri |
| Universal binary | `--universal` flag; electron-builder lipo-merges | `rustup target add x86_64-apple-darwin aarch64-apple-darwin`; Tauri merges automatically |
| Code signing | `identity: null` (unsigned) | `"signingIdentity": null` in `tauri.conf.json` bundle.macOS |
| Icon | `build/icon.icns` (generated by `make-icon` script) | `src-tauri/icons/icon.icns` (generated by `cargo tauri icon assets/codemie-logo.svg`) |
| App ID | `com.epam.codemie.installer` (electron-builder) | `"identifier": "com.epam.codemie.installer"` in `tauri.conf.json` |
| Dev mode | `electron .` | `cargo tauri dev` (starts Wry/WebKit window + Cargo watch) |
| Frontend bundler | None (vanilla ES modules) | None required (Vite optional); `frontendDist: "../ui"` points to static files |
| Dependencies shipped | Node.js runtime + Chromium + node_modules in asar (~550MB) | System WebKit (macOS built-in) + Rust binary (~5–15MB total) |
| Rust toolchain | Not applicable | `rustup`, `cargo`, `cargo-tauri` CLI |
| CI prerequisites | Node.js + npm | Rust stable toolchain + `cargo install tauri-cli` |

**`Cargo.toml` skeleton:**

```toml
[package]
name = "codemie-installer"
version = "2.0.0"
edition = "2021"

[dependencies]
tauri = { version = "2", features = [] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
serde_yaml = "0.9"
tokio = { version = "1", features = ["full"] }
reqwest = { version = "0.12", default-features = false, features = ["rustls-tls", "stream"] }
portable-pty = "0.8"
thiserror = "2"
futures = "0.3"

[build-dependencies]
tauri-build = { version = "2", features = [] }

[profile.release]
lto = true
codegen-units = 1
strip = true
```
