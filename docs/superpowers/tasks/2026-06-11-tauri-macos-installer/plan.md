# CodeMie Installer — Tauri v2 Migration Implementation Plan

> **For agentic workers:** Executed inline in this session (sdlc-task Stage 6, TDD). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Re-implement the CodeMie macOS install wizard on Tauri v2 (Option B: JS orchestration + Rust command layer) producing a launching, parity-equivalent **universal DMG < 20 MB**.

**Architecture:** Frontend keeps `engine.js`/`handlers.js`/`models.js` (orchestration brain, approval gate stays a JS Promise). Rust ports the 8 system modules as granular `#[tauri::command]`s; push events via `app.emit("engine:*", …)`. No Rust `start` command. PTY chunks base64-encoded to dodge UTF-8/ANSI split corruption.

**Tech Stack:** Tauri v2, Rust (portable-pty, reqwest, serde, serde_yaml, tokio, thiserror, base64), vanilla ES-module frontend, `node --test` for JS engine, `cargo test` for Rust.

**Reference source (already read):** `/Users/Vadym_Vlasenko/AI/projects/codemie-claude-installer-macos/`. Port faithfully — behavior must match.

**Verification boundary (agreed):** non-destructive only. Build + launch + `CODEMIE_PROBE_SMOKE` + `CODEMIE_SMOKE` + benign PTY echo + DMG size gate. Never auto-run the real install.

---

## File map

```
src-tauri/Cargo.toml, build.rs, tauri.conf.json, capabilities/default.json, icons/, src/
src-tauri/src/main.rs        — builder, manage(AppState), startup PATH resolve, smoke runner glue
src-tauri/src/state.rs       — AppState { pty: Mutex<Option<PtyHandle>>, augmented_path: Mutex<Option<String>> }
src-tauri/src/error.rs       — InstallerError (thiserror) + Result alias; Serialize→String for IPC
src-tauri/src/commands/mod.rs
src-tauri/src/commands/runner.rs      ← runner.js     (run_capture, run_stream, run_fresh_env)
src-tauri/src/commands/inspector.rs   ← inspector.js  (check_git/node/npm/codemie, *_binary_path)
src-tauri/src/commands/installer.rs   ← installer-macos.js (latest_lts_node_version, node_pkg_url, install_node, install_git_clt)
src-tauri/src/commands/pathman.rs     ← pathman.js    (dedupe/missing/merge/resolve/persist/augment)
src-tauri/src/commands/downloader.rs  ← downloader.js (download_file)
src-tauri/src/commands/logger.rs      ← logger.js     (log_line, open_log, format_line)
src-tauri/src/commands/pty.rs         ← runner.spawnPty (spawn_pty, pty_input, pty_resize)
src-tauri/src/commands/window.rs      ← main.js IPC   (set_window_height, close_app)
src-tauri/src/steps.rs                ← steps.js+yaml (get_steps over embedded steps.yaml), get_logo_path
ui/  index.html, styles.css, steps-ui.js, sprite.js, log.js, terminal.js, renderer.js,
     engine.js, handlers.js, models.js, runner-bridge.js (new), vendor/{xterm.mjs,addon-fit.mjs,xterm.css}
ui/test/engine.test.mjs, models.test.mjs  — node --test
config/steps.yaml, assets/codemie-logo.svg
package.json (scripts only: test, tauri), .gitignore
```

---

# PHASE 1 — Scaffold + risk-kill (prove sub-20MB launching DMG)

### Task 1.1: Install Rust toolchain + Tauri CLI
**Files:** none (environment).
**Test-first:** no — environment setup, verified by version output.

- [ ] Install rustup non-interactively: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --profile default`
- [ ] `source "$HOME/.cargo/env"`; verify `cargo --version` and `rustc --version`.
- [ ] Install CLI: `cargo install tauri-cli --version "^2" --locked` (provides `cargo tauri`). Verify `cargo tauri --version`.
- [ ] Commit nothing (no repo changes).

### Task 1.2: Scaffold Tauri project (official, vanilla, no bundler)
**Files:** Create `src-tauri/*`, `package.json`.
**Test-first:** no — scaffolding; verified by `cargo tauri info` + build.

- [ ] From repo root, scaffold into current dir keeping a static frontend. Use `cargo tauri init` with: app name "CodeMie Installer", identifier `com.epam.codemie.installer`, frontend dist `../ui`, dev url `../ui`, dev command empty, build command empty. (If `cargo tauri init` prompts interactively and that's awkward, hand-create `src-tauri/` from the scaffold template — but prefer the tool so the **current-version** `tauri.conf.json` + `capabilities/` format is emitted.)
- [ ] Create `ui/index.html` minimal placeholder (`<h1>CodeMie</h1>`) so dev/build has something to load.
- [ ] Confirm `src-tauri/Cargo.toml`, `tauri.conf.json`, `capabilities/default.json`, `build.rs` exist. Record the scaffolded Tauri crate version (pin it).
- [ ] `git add -A && git commit -m "chore: scaffold Tauri v2 project (tauri-macos-installer)"`

### Task 1.3: Configure window + bundle + release profile
**Files:** Modify `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`.
**Test-first:** no — config; verified by build + launch.

- [ ] `tauri.conf.json`: set `productName`/`version` `2.0.0`; window `{title:"CodeMie Installation Wizard", width:900, height:600, resizable:false, fullscreen:false, backgroundColor:"#0b0d14"}`; `app.withGlobalTauri:true`; `app.security.csp:"default-src 'self'; img-src 'self' asset: data:; style-src 'self' 'unsafe-inline'; script-src 'self'"`; `bundle.active:true`, `bundle.targets:["dmg"]`, `bundle.macOS.signingIdentity:null`. Verify against the scaffolded version's schema (field names may differ slightly — adapt to what the scaffold emitted, e.g. `app.windows` vs `tauri.windows`).
- [ ] `Cargo.toml` add `[profile.release]`: `lto=true`, `codegen-units=1`, `strip=true`, `panic="abort"`, `opt-level="z"`.
- [ ] `git commit -am "chore: configure window, dmg bundle, size-optimized release profile"`

### Task 1.4: Copy frontend assets verbatim + asset URL fix
**Files:** Create `ui/*` (copy from reference `src/renderer/`), `assets/codemie-logo.svg`, `config/steps.yaml`.
**Test-first:** no — asset copy; verified by launch.

- [ ] Copy verbatim: `styles.css`, `steps-ui.js`, `vendor/{xterm.mjs,addon-fit.mjs,xterm.css}` → `ui/`. Copy `assets/codemie-logo.svg` and `config/steps.yaml`.
- [ ] Copy `index.html` → `ui/index.html`; remove the `<meta http-equiv="Content-Security-Policy">` line (CSP now from tauri.conf). Keep everything else.
- [ ] Copy `engine.js`, `handlers.js`, `models.js`, `renderer.js`, `terminal.js`, `sprite.js`, `log.js` to `ui/` (edited in later tasks). Convert `models.js` + `engine.js` `require`/`module.exports` → ESM `import`/`export` now (they're pure logic). Leave handlers/renderer wiring for Phase 2–4.
- [ ] `git commit -am "feat: copy renderer assets into ui/ (Tauri frontend root)"`

### Task 1.5: Build native DMG, launch, measure size (RISK-KILL GATE)
**Files:** none.
**Test-first:** no — this IS the verification.

- [ ] `cd src-tauri && cargo tauri build` (native arch). Expect a `.app` + `.dmg` under `src-tauri/target/release/bundle/`.
- [ ] **Size gate:** `du -sh` the `.dmg`. Expected **< 20 MB**. If over, investigate (debug symbols, unintended bundled files) before proceeding.
- [ ] Launch the `.app` (or `cargo tauri dev`) and confirm a 900×600 dark window renders the placeholder. Screenshot/observe.
- [ ] `git commit -am "test: phase-1 risk-kill — launching sub-20MB native DMG verified"` (no code change; empty-ish commit documents the milestone, or skip if nothing changed).

---

# PHASE 2 — Non-PTY Rust commands + JS rewiring (`CODEMIE_PROBE_SMOKE` green)

> Rust unit tests use `#[cfg(test)] mod tests`. Run a single module's tests with `cargo test --manifest-path src-tauri/Cargo.toml <name>`. Commands use `tokio::process::Command` (async) for shell exec.

### Task 2.1: Error type + AppState + shell helper
**Files:** Create `src-tauri/src/error.rs`, `src-tauri/src/state.rs`. Modify `main.rs`, `commands/mod.rs`.
**Test-first:** no — plumbing; exercised by later command tests.

- [ ] `error.rs`: `#[derive(Debug, thiserror::Error)] pub enum InstallerError { #[error("{0}")] Io(...), Command(String), Download(String), Pty(String), Sudo(String) }`; `impl serde::Serialize for InstallerError { serialize_str(self.to_string()) }`; `pub type CmdResult<T> = Result<T, InstallerError>;`
- [ ] `state.rs`: `pub struct AppState { pub pty: std::sync::Mutex<Option<PtyHandle>> }` (PtyHandle defined in pty.rs Phase 3 — for now `pub pty: Mutex<Option<()>>` placeholder or gate behind Phase 3). Keep minimal: only fields needed now.
- [ ] `main.rs`: `tauri::Builder::default().manage(AppState::default()).invoke_handler(tauri::generate_handler![…]).run(...)`. Register commands as added.
- [ ] `cargo build` clean. `git commit -am "feat(rust): error type + app state scaffolding"`

### Task 2.2: runner.rs — run_capture / run_fresh_env (TDD)
**Files:** Create `src-tauri/src/commands/runner.rs`. Test inside same file.
**Test-first:** YES — port runner.test.js: `run_capture('echo hi')` → code 0, stdout "hi"; `run_capture('exit 3')` → code 3.

- [ ] Write `#[cfg(test)] mod tests`: `run_capture_echo` asserts `code==0 && stdout.trim()=="hi"`; `run_capture_exit3` asserts `code==3`. (Use `tokio::runtime` or `#[tokio::test]`.)
- [ ] Run: `cargo test --manifest-path src-tauri/Cargo.toml runner` → FAIL (not implemented).
- [ ] Implement `CaptureResult{code:i32,stdout:String,stderr:String}`; `async fn run_capture_impl(cmd) -> CaptureResult` spawning `/bin/zsh -lc <cmd>` via `tokio::process::Command`, capturing output, mapping no-exit→1, spawn error→127. `#[tauri::command] pub async fn run_capture(cmd: String) -> CaptureResult`. Add `run_fresh_env(cmd)` = run_capture with PATH augmented by pathman candidate dirs (depends on Task 2.4 — stub PATH augmentation as `std::env::var("PATH")` for now, wire candidates after 2.4).
- [ ] Run tests → PASS. Register `run_capture`,`run_fresh_env` in main.rs.
- [ ] `git commit -am "feat(rust): runner.rs run_capture/run_fresh_env (ported runner.test.js)"`

### Task 2.3: runner.rs — run_stream via event (build/smoke-verified)
**Files:** Modify `runner.rs`, `capabilities/default.json`.
**Test-first:** no — event streaming is integration-verified (PROBE smoke).

- [ ] Implement `#[tauri::command] pub async fn run_stream(app: AppHandle, cmd: String, stream_id: String) -> CmdResult<i32>`: spawn `/bin/zsh -lc <cmd>` with piped stdout/stderr; read both line-by-line (`tokio::io::BufReader.lines()`), for each line `app.emit("engine:cmd-line", json!({"id":stream_id,"text":line,"tag":tag}))`; await exit; return code. (`tag`="stdout"/"stderr".)
- [ ] Ensure `engine:cmd-line` is permitted by capabilities (event emit from Rust needs no capability; listen on JS side does — add `core:event:default` / `core:default` to `capabilities/default.json`).
- [ ] `cargo build` clean. Register command. `git commit -am "feat(rust): run_stream line-streaming via engine:cmd-line event"`

### Task 2.4: pathman.rs (TDD)
**Files:** Create `src-tauri/src/commands/pathman.rs`.
**Test-first:** YES — port pathman.test.js.

- [ ] Tests: `dedupe_path("/a:/b:/a:/c")=="/a:/b:/c"`, `dedupe_path("/a::/b:")=="/a:/b"`; `missing_entries("/a:/b",["/b","/c","/d"])==["/c","/d"]`, `==[]` for `["/a","/b"]`; `merge_shell_path("/a:/b","/b:/c",["/d","/a"])=="/a:/b:/c:/d"`, `merge_shell_path("","/x",["/y"])=="/x:/y"`; `resolve_shell_path()` returns `Some` containing "/" and not the marker (integration).
- [ ] Run → FAIL. Implement `dedupe_path`, `missing_entries`, `merge_shell_path`, `candidate_dirs()` (`/opt/homebrew/bin`,`/usr/local/bin`,`/usr/bin`,`~/.npm-global/bin`), `resolve_shell_path()` (spawn `$SHELL -ilc "printf '%s' \"<MARKER>${PATH}<MARKER>\""`, split on marker, 8s timeout via `std::process` + thread or tokio), `persist_to_zprofile(entries)` (idempotent append with `# Added by CodeMie Installer` marker), `apply_resolved_shell_path()` (sets process PATH = merge). Expose `#[tauri::command]`s: `resolve_shell_path`, `persist_to_zprofile`. Run → PASS.
- [ ] Wire `run_fresh_env` (Task 2.2) to prepend `candidate_dirs()`.
- [ ] `git commit -am "feat(rust): pathman.rs (ported pathman.test.js)"`

### Task 2.5: inspector.rs (TDD)
**Files:** Create `src-tauri/src/commands/inspector.rs`.
**Test-first:** YES — port inspector.test.js (inject a `run` fn).

- [ ] Tests with an injected probe runner closure (mirror JS `Inspector({run})`): `check_node` parses `v24.15.0\n` → found=true,version="v24.15.0"; non-zero exit → found=false; checkCodemie: exit1 with "Usage…" → found=true; exit127 empty → false; exit127 "command not found: codemie" → false; exit1 "Usage…" → true.
- [ ] Run → FAIL. Implement a `probe(run, cmd)` helper + `Probe{found,version}`; `check_git/node/npm` via `probe`; `check_codemie` with the 127/"command not found"/"not found:" heuristic. `git_binary_path`/`node_binary_path` check known paths via `Path::exists`. Tauri commands `check_git/node/npm/codemie` call the real `run_capture`; `git_binary_path`/`node_binary_path` return `Option<String>`. Run → PASS.
- [ ] Register. `git commit -am "feat(rust): inspector.rs (ported inspector.test.js)"`

### Task 2.6: installer.rs (TDD for url, build-verified for sudo)
**Files:** Create `src-tauri/src/commands/installer.rs`.
**Test-first:** YES — port installer.test.js (node_pkg_url); sudo/git paths build-verified only.

- [ ] Tests: `node_pkg_url("arm64","24.15.0")=="https://nodejs.org/dist/v24.15.0/node-v24.15.0.pkg"`; `node_pkg_url("x64",v)==node_pkg_url("arm64",v)`.
- [ ] Run → FAIL. Implement `node_pkg_url(_arch,version)` (strip leading `v`). `latest_lts_node_version()` async: GET `https://nodejs.org/dist/index.json` via reqwest, first entry with truthy `lts`, strip `v`, else `FALLBACK_NODE_VERSION="24.16.0"`. `install_node(pkg_path)` → `sudo_exec(format!("installer -pkg \"{}\" -target /", pkg))` where `sudo_exec(cmd)` runs `osascript -e 'do shell script "<escaped cmd>" with administrator privileges'`. `install_git_clt(app)`: spawn `xcode-select --install`, poll `git --version` every 4s up to 20min, emit progress ticks via event, return bool. Tauri commands: `latest_lts_node_version`, `node_pkg_url`, `install_node`, `install_git_clt`. Run url tests → PASS.
- [ ] Register. `git commit -am "feat(rust): installer.rs — node url (TDD) + osascript sudo + git CLT"`

### Task 2.7: downloader.rs (build-verified)
**Files:** Create `src-tauri/src/commands/downloader.rs`.
**Test-first:** no — network streaming; verified by build (and incidentally by real Node install, out of scope).

- [ ] `#[tauri::command] pub async fn download_file(app, url, dest, progress_id) -> CmdResult<String>`: reqwest GET (rustls, follows redirects by default), read `content_length`, stream `bytes_stream()`, write to `dest`, emit `engine:download-progress {id:progress_id, fraction}` per chunk, 60s connect/read timeout. Return dest path.
- [ ] `cargo build` clean. Register. `git commit -am "feat(rust): downloader.rs (reqwest streaming + progress event)"`

### Task 2.8: logger.rs (TDD for format) + steps.rs (TDD for parse)
**Files:** Create `src-tauri/src/commands/logger.rs`, `src-tauri/src/steps.rs`.
**Test-first:** YES — port logger.test.js (format_line) + steps.test.js loadSteps part.

- [ ] logger tests: `format_line("OUT","hello","2026-06-10T00:00:00.000Z")=="[2026-06-10T00:00:00.000Z] [OUT] hello"`; with no iso, matches `^\[\d{4}-…Z\] \[INF\] x$`. Implement `format_line(tag,text,iso:Option<&str>)` (iso default = now via `chrono` or `std::time` formatted RFC3339), `TAG_MAP`, `log_line(text,tag)` appending to `~/Library/Logs/CodeMie/codemie_wizard.log` (mkdir -p, swallow errors), `log_path()`, `#[tauri::command] open_log()` → `open <path>`. Run → PASS. (Add `chrono` dep if needed for timestamp.)
- [ ] steps tests: embed YAML `include_str!("../../config/steps.yaml")`; `get_steps()` parses via serde_yaml into `Vec<Step>` with serde defaults matching models.js (`status="PENDING"`, bools default false, parent_id Option). Assert ids `["1.1","1.1.1","1.2","1.2.1","1.3","2.3.3","2.3.5","2.4"]`; 1.1 fatal=true/approval=false/sub=false; 1.1.1 sub=true/parent="1.1"/approval=true/msg non-empty; 2.3.3 interactive=true. Implement `Step` struct (`#[derive(Serialize,Deserialize,Clone)]` with `#[serde(default)]`), `StepRaw`→`Step` normalization, `#[tauri::command] get_steps() -> Vec<Step>`, `#[tauri::command] get_logo_path()` → resource path to logo (or embed logo as data URL — decide: ship `codemie-logo.svg` as a Tauri resource and return `convertFileSrc`-able path, OR inline as base64 data URI returned by get_logo_path; **chosen: bundle logo as resource**, configure `bundle.resources`). Run → PASS.
- [ ] Register `open_log`, `get_steps`, `get_logo_path`. `git commit -am "feat(rust): logger.rs + steps.rs (ported logger/steps tests)"`

### Task 2.9: window.rs + main.rs startup wiring
**Files:** Create `src-tauri/src/commands/window.rs`. Modify `main.rs`.
**Test-first:** no — glue; verified by launch + smoke.

- [ ] `window.rs`: `#[tauri::command] set_window_height(window, height:f64)` → clamp `[600,1000]`, `window.set_size(LogicalSize::new(900.0, h))`; `#[tauri::command] close_app(app)` → `app.exit(0)`.
- [ ] `main.rs` `setup`: call `pathman::apply_resolved_shell_path()`, `logger::log_line("Resolved PATH: …","dim")`. Register all commands.
- [ ] `cargo build` clean. `git commit -am "feat(rust): window commands + startup PATH resolve"`

### Task 2.10: JS runner-bridge + handlers/renderer rewiring (Option B)
**Files:** Create `ui/runner-bridge.js`. Modify `ui/handlers.js`, `ui/renderer.js`, `ui/log.js`, `ui/sprite.js`, `ui/steps.js`(loader), `ui/index.html`.
**Test-first:** no — wiring; verified by PROBE smoke (Task 2.12).

- [ ] `runner-bridge.js` (ESM): export `runCapture(cmd)=invoke('run_capture',{cmd})`; `runFreshEnv(cmd)=invoke('run_fresh_env',{cmd})`; `runStream(cmd,onLine)` → `onLine('> '+cmd,'prompt')`, gen id, `listen('engine:cmd-line', e=>{if(e.payload.id===id)onLine(e.payload.text,e.payload.tag)})`, `const code=await invoke('run_stream',{cmd,streamId:id})`, unlisten, return `{code}`. Also export `inspector` object (`checkGit=()=>invoke('check_git')`, etc., `gitBinaryPath=()=>invoke('git_binary_path')`), `installer` (`latestLtsNodeVersion`,`nodePkgUrl(arch,v)=>invoke('node_pkg_url',{arch,version:v})`,`installNode(p)`,`installGitCLT({onTick})` — onTick via `listen('engine:git-tick')`), `pathman` (`augmentProcessPath`→ no-op or `invoke('augment_path')`; `persistToZprofile(dirs)=>invoke('persist_to_zprofile',{entries:dirs})`), `downloader.download(url,dest,onProgress)` → listen `engine:download-progress`. Use `window.__TAURI__.core.invoke` / `.event.listen` (withGlobalTauri).
- [ ] `handlers.js`: replace `require('node:path')`/`os` with small JS helpers (`pathJoin`, get tmp via `invoke`); change `makeHandlers(deps)` to receive the bridge objects; `runPty` emits via... (PTY wired Phase 3 — leave runPty calling `invoke('spawn_pty',…)` + listen, stub acceptable until Phase 3). Keep handler logic identical.
- [ ] `renderer.js`: replace `const api = window.codemie` with `const { invoke } = window.__TAURI__.core; const { listen } = window.__TAURI__.event; const { getCurrentWindow } = window.__TAURI__.window;`. Build the engine in the renderer: import `Engine` from `engine.js`, `makeHandlers` from `handlers.js`, get steps via `invoke('get_steps')`, construct `emit` that forwards to the same UI handlers AND `invoke('log_line',…)` for terminal-line. Replace `api.start()` → `engine.run()`; `api.approve/ignore` → `engine.approve()/ignore()`; `api.setUnattended` → local flag; `api.close()` → `getCurrentWindow().close()`; subscribe to `engine:*` events that originate in Rust (download-progress, cmd-line, pty-*) and route to UI. **Key:** since the engine lives in JS, status/subtitle/spinner/approval/substep/complete/fatal/terminal-line are emitted by the JS engine directly to UI functions (no Tauri round-trip); only Rust-origin events (download-progress, pty-data/exit, cmd-line, git-tick) come via `listen`.
- [ ] `log.js`: `window.codemie.openLog()` → `invoke('open_log')`; `setWindowHeight(h)` → `invoke('set_window_height',{height:h})`.
- [ ] `sprite.js`: `img.src='file://'+logoPath` → `img.src = window.__TAURI__.core.convertFileSrc(logoPath)`.
- [ ] `index.html`: scripts already module; ensure no `window.codemie` refs remain.
- [ ] `cargo tauri build` (or dev) → window renders steps. `git commit -am "feat(ui): Option B rewiring — JS engine drives Rust commands via bridge"`

### Task 2.11: Port engine.test.js → ESM (TDD regression for orchestration)
**Files:** Create `ui/test/engine.test.mjs`, `ui/test/models.test.mjs`, `package.json` test script.
**Test-first:** YES — these tests must pass against the ESM-converted engine/models.

- [ ] Read reference `test/engine.test.js`; port to `ui/test/engine.test.mjs` using ESM `import { Engine } from '../engine.js'`, `import { StepStatus } from '../models.js'`. Keep all cases (sequencing, approval gate, fatal propagation, sub-step, unattended).
- [ ] Port `STATUS_META` + `makeStep` defaults checks to `models.test.mjs`.
- [ ] `package.json`: `"test:js":"node --test ui/test/*.test.mjs"`. Run → PASS (engine/models already converted to ESM in Task 1.4). If any `require` remains, fix.
- [ ] `git commit -am "test(ui): port engine/models unit tests to ESM (node --test)"`

### Task 2.12: `CODEMIE_PROBE_SMOKE` mode + PROBE verification (GATE)
**Files:** Modify `src-tauri/src/main.rs`, `ui/renderer.js`.
**Test-first:** no — this IS the Phase 2 verification gate.

- [ ] `main.rs`: read `std::env::var("CODEMIE_PROBE_SMOKE")`; pass a flag to the frontend (via `tauri.conf` `app` init script, a `window.eval`, or a `get_smoke_mode` command the renderer calls on boot). **Chosen:** add `#[tauri::command] smoke_mode() -> SmokeFlags { probe, smoke, smoke_ms, shot }` reading env; renderer calls it on boot.
- [ ] `renderer.js`: if `probe`, set unattended, filter steps to `{1.1,1.1.1,1.2,1.2.1,1.3}`, `await engine.run()`, then `invoke('log_line', "PROBE_RESULT "+steps.map(s=>s.id+':'+s.status).join(' '))` and also `console.log` it, then `invoke('close_app')`. (Mirror main.js lines 53-110.)
- [ ] Run: `CODEMIE_PROBE_SMOKE=1 cargo tauri dev` (or run the built .app with env). Capture stdout/log. Expected: `PROBE_RESULT 1.1:COMPLETE 1.1.1:… 1.2:COMPLETE … 1.3:…` then `PROBE_DONE`, app quits. On this machine (git/node present), 1.1 & 1.2 should be COMPLETE; 1.3 depends on whether codemie is installed (detection-only, no install triggered because approval is auto + install only runs if missing — **note**: 1.3 WILL attempt `npm install -g` if codemie absent; to stay non-destructive in PROBE, guard 1.3 to detection-only or rely on codemie being present). **Decision:** in PROBE mode, replace the 1.3 handler with detection-only (no npm install) to honor the non-destructive boundary.
- [ ] `git commit -am "feat: CODEMIE_PROBE_SMOKE detection-only mode + green PROBE run"`

---

# PHASE 3 — PTY integration (benign-echo smoke green)

### Task 3.1: pty.rs — spawn_pty/pty_input/pty_resize with base64 reader thread
**Files:** Create `src-tauri/src/commands/pty.rs`. Modify `state.rs`, `Cargo.toml` (portable-pty, base64).
**Test-first:** no — thread+emit pattern is integration-verified by SMOKE.

- [ ] `state.rs`: `pub struct PtyHandle { pub master: Box<dyn portable_pty::MasterPty + Send>, pub writer: Box<dyn std::io::Write + Send> }`; `AppState.pty: Mutex<Option<PtyHandle>>`.
- [ ] `pty.rs` `spawn_pty(app, state, cmd, cols, rows)`: `native_pty_system()`, `openpty(PtySize{rows,cols,0,0})`; `CommandBuilder::new("/bin/zsh")`, `args(["-lc",&cmd])`, `env("TERM","xterm-256color")`, `env("HOME", home)`, `env("PATH", augmented)`, `cwd(home)`; `pair.slave.spawn_command(cmd_builder)` → child; `let mut reader = pair.master.try_clone_reader()`; `let writer = pair.master.take_writer()`; store `{master:pair.master, writer}` in state. Spawn **`std::thread`**: loop `reader.read(&mut [0u8;4096])`; on n>0 `app.emit("engine:pty-data", json!({"data": BASE64.encode(&buf[..n])}))`; on 0/err break. Spawn second `std::thread`: `child.wait()` → `app.emit("engine:pty-exit", json!({"code": code}))`, clear state pty. 
- [ ] `pty_input(state, data)`: base64? No — terminal.js sends raw keystrokes; `data:String`; lock state, `writer.write_all(data.as_bytes())`. `pty_resize(state, cols, rows)`: lock, `master.resize(PtySize{…})`.
- [ ] `Cargo.toml`: add `portable-pty = "0.8"`, `base64 = "0.22"`. `cargo build` clean. Register commands.
- [ ] `git commit -am "feat(rust): pty.rs — portable-pty reader thread, base64 pty-data, input/resize"`

### Task 3.2: terminal.js base64 decode + handlers runPty wiring
**Files:** Modify `ui/terminal.js`, `ui/handlers.js`, `ui/renderer.js`.
**Test-first:** no — verified by SMOKE.

- [ ] `terminal.js`: `writeData(b64)` → `term.write(atob-decode to bytes)`; decode base64 to a Uint8Array and `term.write(uint8array)` (xterm accepts Uint8Array). `onData(d)` → `invoke('pty_input',{data:d})`; `doFit` → `invoke('pty_resize',{cols,rows})`.
- [ ] `handlers.js` `runPty(ctx,cmd,title)`: `ctx.emit('pty-open',{id,title})`; `await invoke('spawn_pty',{cmd,cols:100,rows:30})`; resolve on `engine:pty-exit` (subscribe in renderer, route to a resolver the handler awaits — or have runPty itself `listen('engine:pty-exit', once)`); map exit 0 → true. Emit `pty-data` is handled by renderer→`writeData`.
- [ ] `renderer.js`: `listen('engine:pty-data', e=>writeData(e.payload.data))`; `listen('engine:pty-exit', e=>{ closeTerminal(); /* resolve active runPty */ })`.
- [ ] `cargo tauri build`. `git commit -am "feat(ui): base64 PTY decode + runPty via spawn_pty/pty-exit"`

### Task 3.3: `CODEMIE_SMOKE` mode + benign PTY echo (GATE)
**Files:** Modify `src-tauri/src/main.rs` (smoke_mode already added), `ui/renderer.js`.
**Test-first:** no — Phase 3 verification gate.

- [ ] `renderer.js`: if `smoke` flag — after boot, probe DOM (`document.querySelectorAll('.step-row').length`, `document.title`, `!!#sprite-canvas`, `window.__bootError`), `console.log('SMOKE_PROBE '+json)`; then benign PTY: `invoke('spawn_pty',{cmd:'echo PTY_SELFTEST_OK; exit 0',cols:80,rows:24})`, accumulate `engine:pty-data` (base64-decode), on `engine:pty-exit` `console.log('SMOKE_PTY '+JSON.stringify({exit,sawMarker:buf.includes('PTY_SELFTEST_OK')}))`; after `smoke_ms` (default 2500) `console.log('SMOKE_OK')` + `invoke('close_app')`. Optional `CODEMIE_SHOT` screenshot via `getCurrentWindow()` capture (or skip — Tauri lacks capturePage; use `cargo tauri` screenshot alternative or drop the screenshot, logging `SMOKE_SHOT_SKIP`).
- [ ] Run: `CODEMIE_SMOKE=1 cargo tauri dev` capturing stdout. Expected `SMOKE_PROBE {"rows":8,…}`, `SMOKE_PTY {"exit":0,"sawMarker":true}`, `SMOKE_OK`, quit.
- [ ] `git commit -am "feat: CODEMIE_SMOKE renderer+PTY self-test (green)"`

---

# PHASE 4 — End-to-end wizard + universal DMG + final verification

### Task 4.1: Full wizard wiring sweep (approval gate, log resize, fatal, sprite)
**Files:** Modify `ui/renderer.js`, `ui/steps-ui.js` (if needed), `ui/log.js`.
**Test-first:** no — verified by launch + manual dry-run of non-destructive paths.

- [ ] Confirm approval gate: `steps.showApproval(id,msg,onApprove,onIgnore)` calls `engine.approve()/ignore()`. Confirm `engine:download-progress` (Rust) routes to `steps.setProgress`. Confirm log panel expand resizes window via `set_window_height`. Confirm fatal overlay + sprite states transition. Confirm `complete` swaps Install→Close button.
- [ ] Launch, click Install with a benign/already-installed environment (1.1/1.2 detect & pass), observe approval prompt appears for 1.3, click Ignore to avoid real npm install. Confirm UI parity with Electron screenshots.
- [ ] `git commit -am "feat(ui): complete end-to-end wizard wiring (Option B)"`

### Task 4.2: Light polish (additive, parity-safe)
**Files:** Modify `ui/styles.css`, `ui/sprite.js`, `src-tauri/tauri.conf.json` (window effects).
**Test-first:** no — visual; verified by launch.

- [ ] Try macOS window vibrancy: `tauri.conf.json` window `windowEffects: { effects: ["hudWindow"|"underWindowBackground"], state:"active" }` (Tauri v2). If it fights the opaque `#0b0d14` bg or CSP, **revert** — parity wins. 
- [ ] Smoother sprite easing (ease the breathe/state transitions); tidy CSS transitions on buttons/log panel. Keep subtle.
- [ ] Launch, confirm no regression. `git commit -am "feat(ui): light native polish (vibrancy/easing/transitions)"`

### Task 4.3: Universal DMG build + size gate + full verification (FINAL GATE)
**Files:** none.
**Test-first:** no — final verification.

- [ ] `rustup target add x86_64-apple-darwin aarch64-apple-darwin`.
- [ ] `cd src-tauri && cargo tauri build --target universal-apple-darwin`. Locate `target/universal-apple-darwin/release/bundle/dmg/*.dmg`.
- [ ] **Size gate:** `du -sh` the DMG → assert **< 20 MB**. Record actual size.
- [ ] Re-run `CODEMIE_PROBE_SMOKE=1` and `CODEMIE_SMOKE=1` against the universal build (or dev) → both green.
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` (all Rust tests green); `node --test ui/test/*.test.mjs` (JS tests green); `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` clean on our code.
- [ ] Verify the DMG mounts and the app launches from it; verify `lipo -info` shows both arches in the binary.
- [ ] `git commit -am "build: universal DMG (<20MB) + full green verification"`

### Task 4.4: README + .gitignore + handoff doc
**Files:** Create `README.md`, `.gitignore`.
**Test-first:** no.

- [ ] `.gitignore`: `src-tauri/target/`, `node_modules/`, `*.dmg`, `.DS_Store`.
- [ ] `README.md`: what it is, prereqs (Rust toolchain), `cargo tauri dev`, `cargo tauri build [--target universal-apple-darwin]`, smoke env vars, the non-destructive testing note, final DMG size vs Electron's 550MB.
- [ ] `git commit -am "docs: README + gitignore"`

---

## Self-review notes
- **Spec coverage:** every spec section maps to a task (architecture→Option B wiring 2.10/3.2/4.1; IPC surface→2.x/3.1; PTY base64→3.1/3.2; build/profile→1.3/4.3; smoke modes→2.12/3.3; Rust tests→2.2-2.8; JS engine tests→2.11; size gate→1.5/4.3; light polish→4.2; README→4.4).
- **Non-destructive boundary honored:** PROBE 1.3 forced detection-only (Task 2.12); SMOKE uses benign echo; real install never auto-run.
- **Risk-kill first:** Task 1.5 proves sub-20MB launching DMG before any porting.
- **Type consistency:** `run_capture`→`{code,stdout,stderr}`; `run_stream`→`engine:cmd-line {id,text,tag}`+returns code; `Step` fields match models.js; events keep `engine:*` names.
- **Open adaptation point:** exact `tauri.conf.json`/capabilities field names depend on the scaffolded Tauri version — adapt to the emitted schema (Task 1.2/1.3), don't assume.
