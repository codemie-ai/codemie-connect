# CodeMie Native Settings — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Settings → "CodeMie tools" (the legacy installer UI mounted into `#legacy-host`) with native workspace tabs — Overview, Profiles, Coding agents, Connected apps, Health — plus a first-launch setup sheet and a Today setup card, so a person who never opens Terminal can set up the CodeMie CLI (including a CodeMie on a client's own servers), manage profiles, install coding agents and connect apps. CLI usage analytics is removed.

**Architecture:** Frontend-brain, thin Rust (Option B, `.ai-run/guides/architecture/architecture.md`). A new folder `ui/workspace/codemie/` holds a service (state + every CLI call, injected `invoke`/`listen`), pure derivations, pure views and a controller that `ui/workspace/app.js` delegates `cm-*` actions to — the same pattern as `createAutomationsController`. Profile creation keeps driving `codemie setup` through the existing `ui/setup-driver.js` (PTY + headless xterm), behind a new adapter that answers prompts from the native UI. The other CLI calls use the existing `run_capture` / `run_stream` commands; four small Rust commands are added for what the CLI cannot tell us (all profiles, address check, org default address, which apps are connected) and for opening an agent in Terminal.

**Tech Stack:** Vanilla JS ES modules (no bundler), `node:test`; Rust (Tauri v2, reqwest 0.12, serde); CodeMie CLI `@codemieai/code` 0.16.3 (pinned in `runtime.json`).

**Spec:** No written spec, by request. The design is the clickable prototype and its flow map: `prototypes/codemie-tools/index.html` (run it with `/usr/bin/python3 -m http.server 5196 --bind 127.0.0.1 --directory prototypes/codemie-tools`) and `prototypes/codemie-tools/flow.html`. **Copy (every user-facing string) comes from `prototypes/codemie-tools/proto.js` verbatim** unless a task gives different text. Layout and classes come from `prototypes/codemie-tools/proto.css`.

## Global Constraints

- Branch `feat/codemie-native-settings` from `main`. Conventional Commits, no scope (`feat: …`, `fix: …`, `test: …`, `refactor: …`, `docs: …`), subject ≤ 100 chars, with the Co-Authored-By trailer the team uses.
- Gates before every commit that touches the area: `cd src-tauri && cargo fmt --check`, `cd src-tauri && cargo clippy -- -D warnings`, `npm test`, `cd src-tauri && cargo test`. `make check` runs all four.
- Only these CLI 0.16.3 commands are used: `codemie list`, `codemie update --check`, `codemie install|update|uninstall <name>`, `codemie setup` (via the driver), `codemie profile switch|rename|delete <…> -y`, `codemie profile login --url <url>`, `codemie proxy status --json`, `codemie proxy start|restart --profile <p>`, `codemie proxy connect <--claude-desktop|--vscode|--vscode-claude-code|--codex-desktop>… --profile <p> --silent`, `codemie proxy disconnect --codex-desktop`, `codemie doctor`, `codemie self-update [--check]`. `proxy disconnect` exists only for `--codex-desktop` in 0.16.3: the other apps get no Disconnect button.
- Every value interpolated into a shell command passes `assertSafe` (Part 2A) first. `run_capture` / `run_stream` run `/bin/zsh -lc <cmd>` (`cmd.exe /c` on Windows) with no validation of their own.
- Non-interactive CLI calls end with `< /dev/null` on macOS and `< NUL` on Windows, so a CLI question can never hang a call.
- Secrets never reach the page or the run log: `proxy status --json` carries the gateway `apiKey`; LiteLLM keys are typed into the setup PTY. The run log redacts (Part 2A) and `parseProxyStatus` never returns `apiKey`.
- Views are pure `(…) => string`; every CLI or provider string goes through `escapeHtml` (`ui/workspace/store.js`) or a `ui.js` component that escapes. `card.body`, `card.actions`, `settingRow.control` and banners are inserted raw — escape before.
- One PTY slot in Rust (`pty.rs`): only the setup session uses the PTY. Everything else uses `run_capture` / `run_stream`.
- New Rust commands live under `src-tauri/src/commands/`, return `CmdResult<T>` or plain serde structs with `#[serde(rename_all = "camelCase")]`, are registered in `src-tauri/src/lib.rs` inside `plugins::caller::app_page_only`, and have inline `#[cfg(test)]` tests. No `unwrap()` in commands.
- macOS is the target platform; Windows must still compile and keep working: every new Rust command has a `#[cfg(windows)]` branch or a portable implementation as stated in its task.
- Profiles are global only: Connect never offers `codemie setup`'s "Local" storage (the driver runs in `/`).
- Out of scope: deleting `ui/renderer.js` and the legacy views (smoke/probe mode and the storage-recovery page still use them — follow-up), a native usage/analytics page, `--install-client` style app installation, per-profile sign-in state for non-active profiles (`codemie profile status` reports the active profile only).

## Review Focus

1. **A setup run in progress while the window regains focus or another tab refreshes.** The config file is mid-write; a reload must not flash "Your profile is no longer working". Expected: the service skips config/profile reloads while `setupRunning()` is true and reloads once when the session settles. Test in Part 2C: `load_skips_config_while_setup_runs`.
2. **Profiles created outside Connect with names the shell would misread** (`my profile`, `a'b`, `prod;rm`). Expected: shown escaped; Make active, Rename, Delete and Sign in again are disabled with the hint "Rename this profile in Terminal to manage it here."; no command is built. Test in Part 3C: `unsafe_profile_name_disables_actions`.
3. **A CodeMie address pasted the way people paste it** — trailing slash, `/#/assistants`, upper-case host, surrounding spaces, no scheme, `http://localhost:8080` for a local dev server. Expected: one normalised origin; plain `http` refused except on localhost. Test in Part 2A: `normalize_accepts_pasted_forms`.
4. **The CLI exits non-zero with no output** (network drop mid-`npm`, killed process). Expected: the row shows the plain-language failure with "No output was captured." under Show output, the agent stays not installed / at its old version, and Try again works. Test in Part 3D: `install_failure_without_output_keeps_state`.
5. **Quit while setup or an install runs.** Expected: the setup PTY is cancelled (`cancelSetup`), `workspace_installer_busy(false)` is sent, and the next launch resumes at the first unfinished step derived from CLI state, not from memory. Test in Part 3A: `quit_request_cancels_setup_and_clears_busy`.

---

## File Structure

New (frontend, `ui/workspace/codemie/`):
- `url.js` — normalise a typed CodeMie address; the EPAM default.
- `cli.js` — the command vocabulary and `assertSafe`.
- `run-log.js` — "What CodeMie ran": entries, output capture, redaction.
- `catalog.js` — static agent metadata (maker, copy, grouping, providers) and the four apps.
- `model.js` — pure derivations: setup progress, agent/app states, attention list, tab dots, first step.
- `parse.js` — `parseProxyStatus`, `profilesFromCommand`, doctor-row mapping.
- `service.js` — the CodeMie state and every native/CLI call.
- `setup-prompts.js` — pure prompt helpers (moved from `ui/setup-view.js`), provider/credential matching.
- `setup-session.js` — answers `codemie setup` prompts from a plan; delegates project/model choices to the UI.
- `view-overview.js`, `view-profiles.js`, `view-agents.js`, `view-apps.js`, `view-health.js`, `view-sheet.js`, `view-today.js` — pure renderers.
- `controller.js` — `cm-*` action handling, sheet state, Today card, banners, dots.

New (backend, `src-tauri/src/commands/`):
- `codemie_server.rs` — `codemie_url_check`, `codemie_org_defaults`.
- `codemie_apps.rs` — `codemie_app_states`.
- `terminal_launch.rs` — `open_agent_in_terminal`, `pick_project_folder`, `open_app_download`.

Modified: `src-tauri/src/commands/codemie_config.rs` (+ `read_codemie_profiles`), `src-tauri/src/commands/mod.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/storage/commands.rs` (`pick_folder` → `pub(crate)`), `ui/setup-parse.js`, `ui/setup-driver.js`, `ui/test/tools/replay-capture.mjs`, `ui/workspace/app.js`, `ui/workspace/view-settings.js`, `ui/workspace/shell.js`, `ui/workspace/settings-ai.js`, `ui/workspace/draft-state.js`, `ui/workspace/ai-chooser.js`, `ui/workspace/icons.js`, `ui/workspace/workspace.css`, `ui/index.html`, `ui/renderer.js`, `ui/test/browser/workspace-e2e.mjs`, `.ai-run/guides/architecture/architecture.md`.

Deleted: `ui/analytics-command.js`, `ui/test/analytics-command.test.mjs`.

---

### Task 1: Rust — profiles, address check, org default, connected apps, Terminal

One Rust pass adding every native command the UI needs. **Done when** `cd src-tauri && cargo fmt --check && cargo clippy -- -D warnings && cargo test` pass and the manual checks in Parts 1B, 1C and 1D are done. Each part ends in its own commit.

#### Part 1A: Rust — list every profile without secrets

**Files:**
- Modify: `src-tauri/src/commands/codemie_config.rs` (next to `list_profiles`, line ~117)
- Modify: `src-tauri/src/lib.rs` (register)
- Test: `src-tauri/src/commands/codemie_config.rs` `mod tests`

**Interfaces:**
- Produces: `#[tauri::command] pub fn read_codemie_profiles() -> CodemieProfiles`
  - `CodemieProfiles { state: String /* "no-configuration"|"valid"|"broken" */, active: Option<String>, account: Option<String> /* userEmail */, profiles: Vec<ProfileDetail> }`
  - `ProfileDetail { name: String, provider: String, model: Option<String>, codemie_url: Option<String>, codemie_project: Option<String>, base_url: Option<String> }` — camelCase in JSON (`codemieUrl`, `codemieProject`, `baseUrl`).
  - Pure helper `pub fn profiles_from_value(v: &serde_json::Value) -> CodemieProfiles` used by the command and the tests. It reads the same file as `read_codemie_config` (`config_path()`), never fails (unreadable → `state: "no-configuration"`), and never copies `apiKey`, `ssoConfig`, `jwtConfig`, `awsSecretAccessKey` or any other field.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn profiles_from_value_lists_all_without_secrets() {
    let v = serde_json::json!({ "version": 2, "activeProfile": "prod", "userEmail": "a@b.c",
      "profiles": { "prod": { "name": "prod", "provider": "ai-run-sso", "model": "claude-sonnet-4-5",
        "codeMieUrl": "https://codemie.lab.epam.com", "codeMieProject": "EPM-CDME", "apiKey": "sso-provided" },
        "local": { "name": "local", "provider": "litellm", "baseUrl": "http://localhost:4000", "apiKey": "sk-secret" } } });
    let p = profiles_from_value(&v);
    assert_eq!(p.state, "valid");
    assert_eq!(p.active.as_deref(), Some("prod"));
    assert_eq!(p.profiles.len(), 2);
    let json = serde_json::to_string(&p).unwrap();
    assert!(!json.contains("sk-secret") && !json.contains("sso-provided") && !json.contains("apiKey"));
    assert!(json.contains("\"codemieProject\":\"EPM-CDME\""));
}

#[test]
fn profiles_from_value_broken_when_active_missing() {
    let v = serde_json::json!({ "activeProfile": "gone", "profiles": { "prod": { "provider": "ai-run-sso" } } });
    assert_eq!(profiles_from_value(&v).state, "broken");
}

#[test]
fn profiles_from_value_empty_is_no_configuration() {
    assert_eq!(profiles_from_value(&serde_json::json!({})).state, "no-configuration");
}
```

- [ ] **Step 2: Run the tests to verify they fail** — `cd src-tauri && cargo test profiles_from_value` → FAIL: `cannot find function profiles_from_value`.
- [ ] **Step 3: Implement** `profiles_from_value` and `read_codemie_profiles` in `codemie_config.rs`; profile order = `activeProfile` first, then the rest by name. Register `commands::codemie_config::read_codemie_profiles` in `lib.rs`.
- [ ] **Step 4: Run the tests** — `cd src-tauri && cargo test profiles_from_value` → PASS (3 tests).
- [ ] **Step 5: Commit** — `git add src-tauri/src/commands/codemie_config.rs src-tauri/src/lib.rs && git commit -m "feat: read every CodeMie profile without secrets"`

---

#### Part 1B: Rust — check a CodeMie address and read the organisation's default address

**Files:**
- Create: `src-tauri/src/commands/codemie_server.rs`
- Modify: `src-tauri/src/commands/mod.rs`, `src-tauri/src/lib.rs`
- Test: inline `mod tests`

**Interfaces:**
- Produces:
  - `#[tauri::command] pub async fn codemie_url_check(url: String) -> UrlCheck` with `UrlCheck { verdict: String /* "codemie"|"not_codemie"|"unreachable"|"invalid" */, status: Option<u16>, detail: String }`.
  - `#[tauri::command] pub fn codemie_org_defaults() -> Option<OrgDefaults>` with `OrgDefaults { codemie_url: String, organization_name: Option<String> }` (camelCase JSON).
  - Pure helpers: `pub fn api_base(origin: &str) -> String` (mirrors the CLI's `ensureApiBase`: append `/code-assistant-api` unless the host is `localhost` or `127.0.0.1`), `pub fn classify(status: u16, has_location: bool) -> &'static str`, `pub fn parse_org_defaults(text: &str) -> Option<OrgDefaults>`.
- Behaviour:
  - `codemie_url_check`: `invalid` unless `url` parses as an origin with scheme `https` (or `http` on localhost/127.0.0.1). Otherwise `GET {api_base(url)}/v1/auth/login/53117` with `reqwest::Client::builder().redirect(Policy::none()).timeout(5 s)` (system proxy on, as `runtime::mac::client` does). `classify`: 3xx with a `Location` header → `codemie`; any other HTTP status → `not_codemie`; connect, DNS, TLS or timeout error → `unreachable`. `detail` = `"GET <path> → <status>"` or the reqwest error text.
  - `codemie_org_defaults`: reads `/Library/Application Support/CodeMie/connect-defaults.json` on macOS, `%ProgramData%\CodeMie\connect-defaults.json` on Windows. File shape `{ "codemieUrl": "https://codemie.acme-bank.com", "organizationName": "Acme Bank" }`. Missing file, bad JSON, or a URL that is not `https` → `None`. Admin-written, read-only for Connect.

- [ ] **Step 1: Verify the login endpoint behaves as assumed** — run `curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://codemie.lab.epam.com/code-assistant-api/v1/auth/login/53117` on the VPN. Expected: `302 https://…` (identity provider). If it is not a 3xx with a redirect, change `classify` to the status the server actually returns and record the observed line in a comment above `classify`.
- [ ] **Step 2: Write the failing tests**

```rust
#[test] fn api_base_adds_prefix_except_localhost() {
    assert_eq!(api_base("https://codemie.acme.com"), "https://codemie.acme.com/code-assistant-api");
    assert_eq!(api_base("http://localhost:8080"), "http://localhost:8080");
}
#[test] fn classify_redirect_is_codemie() {
    assert_eq!(classify(302, true), "codemie");
    assert_eq!(classify(302, false), "not_codemie");
    assert_eq!(classify(404, false), "not_codemie");
    assert_eq!(classify(200, false), "not_codemie");
}
#[test] fn org_defaults_require_https() {
    assert!(parse_org_defaults(r#"{"codemieUrl":"https://codemie.acme-bank.com","organizationName":"Acme Bank"}"#).is_some());
    assert!(parse_org_defaults(r#"{"codemieUrl":"http://codemie.acme-bank.com"}"#).is_none());
    assert!(parse_org_defaults("not json").is_none());
}
#[tokio::test] async fn url_check_rejects_plain_http_remote() {
    assert_eq!(codemie_url_check("http://codemie.acme.com".into()).await.verdict, "invalid");
}
```

- [ ] **Step 3: Run** — `cd src-tauri && cargo test codemie_server` → FAIL (module missing).
- [ ] **Step 4: Implement** the module; register both commands in `lib.rs`.
- [ ] **Step 5: Run** — `cd src-tauri && cargo test codemie_server` → PASS (4 tests).
- [ ] **Step 6: Commit** — `feat: check CodeMie addresses and read the organisation default`

---

#### Part 1C: Rust — which apps are on this Mac and which are connected

**Files:**
- Create: `src-tauri/src/commands/codemie_apps.rs`
- Modify: `src-tauri/src/commands/mod.rs`, `src-tauri/src/lib.rs`
- Test: inline `mod tests` — each test builds its tree under `std::env::temp_dir().join(format!("cm-apps-{}-{}", std::process::id(), <test name>))` and removes it at the end (no new dev-dependency)

**Interfaces:**
- Produces: `#[tauri::command] pub fn codemie_app_states() -> Vec<AppStateInfo>`; `AppStateInfo { id: String, installed: bool, configured: bool }`; ids `claude-desktop`, `vscode-copilot`, `vscode-claude`, `codex-desktop`.
- Pure helper `pub fn app_states(env: &AppDirs) -> Vec<AppStateInfo>` where `AppDirs { home: PathBuf, app_support: PathBuf /* macOS ~/Library/Application Support; Windows %APPDATA% */, local_app_data: PathBuf /* Windows %LOCALAPPDATA%; macOS = app_support */, applications: Vec<PathBuf> /* /Applications, ~/Applications */ }`.
- Rules (they mirror what CLI 0.16.3's `proxy connect` writes — `dist/cli/commands/proxy/connectors/*.js`):

| id | installed when any exists | configured when |
|---|---|---|
| `claude-desktop` | `Claude.app` in `applications`; Windows `%LOCALAPPDATA%\AnthropicClaude` | `{local_app_data or app_support}/Claude-3p/configLibrary/_meta.json` has an entry `{ "name": "CodeMie Proxy", "id": X }` and `"appliedId" == X` |
| `vscode-copilot` | `Visual Studio Code.app`; Windows `%LOCALAPPDATA%\Programs\Microsoft VS Code` | `{app_support}/Code/User/chatLanguageModels.json` contains a provider with `"name": "CodeMie"` and `"vendor": "customendpoint"` |
| `vscode-claude` | same as `vscode-copilot` | `{app_support}/Code/User/settings.json` text contains both `claudeCode.environmentVariables` and `ANTHROPIC_BASE_URL` (the file is JSONC — substring check, no parse) |
| `codex-desktop` | `Codex.app`; Windows `%LOCALAPPDATA%\Programs\Codex` | `{home}/.codex/config.toml` contains `[model_providers.codemie]` |

- [ ] **Step 1: Write the failing tests** — one per row, each building the files in a temp dir: `claude_desktop_configured_only_when_applied`, `vscode_copilot_needs_codemie_customendpoint`, `vscode_claude_detects_env_keys`, `codex_needs_codemie_provider_block`, `nothing_installed_is_all_false`. Example:

```rust
#[test]
fn claude_desktop_configured_only_when_applied() {
    let d = dirs_in_temp();
    write(&d.app_support.join("Claude-3p/configLibrary/_meta.json"),
          r#"{"appliedId":"x1","entries":[{"id":"x1","name":"CodeMie Proxy"}]}"#);
    std::fs::create_dir_all(d.applications[0].join("Claude.app")).unwrap();
    let s = find(&app_states(&d), "claude-desktop");
    assert!(s.installed && s.configured);
    write(&d.app_support.join("Claude-3p/configLibrary/_meta.json"),
          r#"{"appliedId":"other","entries":[{"id":"x1","name":"CodeMie Proxy"}]}"#);
    assert!(!find(&app_states(&d), "claude-desktop").configured);
}
```

- [ ] **Step 2: Run** — `cd src-tauri && cargo test codemie_apps` → FAIL.
- [ ] **Step 3: Implement** `app_states` and the command (build `AppDirs` from `dirs`-style env lookups already used in `pathman.rs`/`logger.rs`). Read files with a 256 KB cap; any read/parse error → `configured: false`.
- [ ] **Step 4: Verify the bundle names on a real Mac** — `ls -d /Applications/{Claude,Codex,'Visual Studio Code'}.app`; if a name differs, fix the table and the test.
- [ ] **Step 5: Run** — `cd src-tauri && cargo test codemie_apps` → PASS (5 tests).
- [ ] **Step 6: Commit** — `feat: detect which apps CodeMie is connected to`

---

#### Part 1D: Rust — open a coding agent in Terminal in a chosen folder

**Files:**
- Create: `src-tauri/src/commands/terminal_launch.rs`
- Modify: `src-tauri/src/storage/commands.rs` (`async fn pick_folder` → `pub(crate) async fn pick_folder`), `src-tauri/src/commands/mod.rs`, `src-tauri/src/lib.rs`
- Test: inline `mod tests`

**Interfaces:**
- Produces:
  - `#[tauri::command] pub async fn pick_project_folder(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<Option<String>, String>` — calls `crate::storage::commands::pick_folder(&app, window, home)` and maps the error to its message.
  - `#[tauri::command] pub fn open_agent_in_terminal(folder: String, launcher: String, profile: String) -> CmdResult<()>`.
  - `#[tauri::command] pub fn open_app_download(app_id: String) -> CmdResult<()>` — opens a fixed page in the default browser (`/usr/bin/open <url>`; Windows `cmd /c start "" <url>`); unknown ids → `Err`. Allowlist: `claude-desktop` → `https://claude.ai/download`, `vscode-copilot` and `vscode-claude` → `https://code.visualstudio.com/download`, `codex-desktop` → `https://openai.com/codex/`. No other URL can be opened through it.
  - Pure helpers: `pub fn validate_launch(folder: &Path, launcher: &str, profile: &str) -> Result<(), String>`, `pub fn command_script(folder: &Path, launcher: &str, profile: &str) -> String`, `pub fn download_url(app_id: &str) -> Option<&'static str>`.
- Behaviour:
  - Validation: `launcher` matches `^codemie-[a-z0-9-]{1,40}$`; `profile` matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`; `folder` is absolute, exists and is a directory. Anything else → `Err` with a sentence for a person ("That folder no longer exists.").
  - macOS: write `command_script` to `<app cache dir>/start-agent.command` (mode 0755) and run `/usr/bin/open -a Terminal <file>`. Script: `#!/bin/zsh -l`, then `cd -- '<folder with ' escaped as '\''>' || exit 1`, then `exec <launcher> --profile <profile>`.
  - Windows: `cmd /c start "" /D <folder> cmd /k <launcher> --profile <profile>`.

- [ ] **Step 1: Write the failing tests** — `rejects_bad_launcher` (`codemie-claude;rm` → Err), `rejects_missing_folder`, `script_quotes_folder` (folder `/tmp/it's here` → script contains `cd -- '/tmp/it'\''s here'`), `script_runs_launcher_with_profile` (contains `exec codemie-claude --profile prod`), `download_url_is_allowlisted` (`download_url("claude-desktop") == Some("https://claude.ai/download")`, `download_url("https://evil") == None`).
- [ ] **Step 2: Run** — `cd src-tauri && cargo test terminal_launch` → FAIL.
- [ ] **Step 3: Implement** the module; make `pick_folder` `pub(crate)`; register the three commands.
- [ ] **Step 4: Run** — `cd src-tauri && cargo test terminal_launch` → PASS (5 tests); `cargo clippy -- -D warnings` clean.
- [ ] **Step 5: Manual check (macOS)** — `cargo tauri dev`, in devtools: `await __TAURI__.core.invoke('open_agent_in_terminal',{folder:'/tmp',launcher:'codemie-code',profile:'default'})` → Terminal opens in `/tmp` and runs the launcher.
- [ ] **Step 6: Commit** — `feat: open a coding agent in Terminal from Connect`

---

### Task 2: CodeMie core in JS — helpers, model, service

Everything below the views: pure helpers, the derived model and the service that owns CodeMie state and every CLI call. No UI changes yet. **Done when** `npm test` passes. Each part ends in its own commit.

#### Part 2A: JS — address, command vocabulary, run log, catalog

**Files:**
- Create: `ui/workspace/codemie/url.js`, `ui/workspace/codemie/cli.js`, `ui/workspace/codemie/run-log.js`, `ui/workspace/codemie/catalog.js`
- Test: `ui/test/codemie-foundation.test.mjs`

**Interfaces:**
- Produces:
  - `url.js`: `export const DEFAULT_CODEMIE_URL = 'https://codemie.lab.epam.com'`; `export function normalizeCodemieUrl(input: string): {ok: true, url: string} | {ok: false, reason: 'empty'|'invalid'|'insecure'}` — same rules as `prototypes/codemie-tools/proto-data.js` `normalizeCodemieUrl` (add `https://` when no scheme, keep the origin only, refuse `http` except `localhost`/`127.0.0.1`/`[::1]`, require a dot in the host otherwise), returning a reason code instead of copy; `export const isEpamUrl = (url: string) => boolean`.
  - `cli.js`: `export const SAFE = { name, agent, url, flag }` regexes `name /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/`, `agent /^[a-z0-9][a-z0-9-]{0,40}$/`, `url /^https?:\/\/(\[::1\]|[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*)(:\d{1,5})?$/`, `flag /^--[a-z][a-z-]{1,40}$/`; `export function assertSafe(kind: keyof SAFE, value: string): string` (throws `Error('Unsafe ' + kind)`); `export function cliCommands(platform: 'macos'|'windows')` returning `{ list, updateCheck, install(name), update(name), uninstall(name), commandPath(cmd), switchProfile(name), renameProfile(from, to), deleteProfile(name), login(url), proxyStatus, proxyConnect(flags: string[], profile), proxyDisconnect(flag), proxyStart(profile), proxyRestart(profile), doctor, selfUpdateCheck, selfUpdate }` — each a string; every one except `install|update|uninstall|login|doctor` ends with ` < /dev/null` (macOS) / ` < NUL` (Windows). `commandPath` is `command -v <cmd>` / `where <cmd>`.
  - `run-log.js`: `export function createRunLog({now = () => new Date(), limit = 50, maxChars = 20000} = {})` → `{ start(cmd: string): {id: number, append(text: string): void, finish(code: number): void}, list(): Entry[], text(): string, subscribe(fn: () => void): () => void }` with `Entry = {id, at: Date, cmd: string, code: number|null, output: string}`; `export function redact(text: string): string` masks values of keys matching `/api[_-]?key|token|secret|password|cookies?|gatewayKey/i` in JSON (`"apiKey": "…"`) and `key=value` forms, plus `Bearer <token>`. `append` and `start` both redact; `text()` is the "Copy all" text: `[HH:MM] ok|FAILED|running  $ <cmd>\n<output>` blocks.
  - `catalog.js`: `export const AGENT_INFO` keyed by CLI install name (`claude`, `gemini`, `codex`, `copilot`, `opencode`, `kimi`, `pi`, `openwiki`, `claude-acp`, `codex-acp`, `gemini-acp`, `opencode-acp`, `kimi-acp`) → `{ maker, short, featured?: true, recommended?: true, editor?: true, providers: string[] }` copied from `prototypes/codemie-tools/proto-data.js` `AGENTS` (providers from CLI 0.16.3, see that file); `export const BUILTIN_AGENT = 'codemie-code'`; `export const APPS = [{ id: 'claude-desktop', name: 'Claude Desktop', connectFlag: '--claude-desktop', disconnectFlag: null, icon: 'monitor' }, { id: 'vscode-copilot', name: 'VS Code — GitHub Copilot Chat', connectFlag: '--vscode', disconnectFlag: null, icon: 'chat' }, { id: 'vscode-claude', name: 'VS Code — Claude Code extension', connectFlag: '--vscode-claude-code', disconnectFlag: null, icon: 'terminal' }, { id: 'codex-desktop', name: 'Codex app', connectFlag: '--codex-desktop', disconnectFlag: '--codex-desktop', icon: 'monitor' }]`; `export const PROVIDERS` — `[id, label, short]` for `ai-run-sso`, `litellm`, `bedrock`, `ollama`, `anthropic-subscription`, `moonshot-subscription`; `export const SUBSCRIPTION_MODELS = { 'anthropic-subscription': ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5'], 'moonshot-subscription': ['kimi-k2'] }` — offered when the CLI asks "No models found. Enter model name manually:" (confirm the ids the CLI accepts in Part 4A, Step 5).

- [ ] **Step 1: Write the failing tests** in `ui/test/codemie-foundation.test.mjs`:

```js
test('normalize_accepts_pasted_forms', () => {
  for (const s of ['codemie.acme.com', ' https://CodeMie.Acme.com/ ', 'https://codemie.acme.com/#/assistants'])
    assert.deepEqual(normalizeCodemieUrl(s), { ok: true, url: 'https://codemie.acme.com' });
  assert.deepEqual(normalizeCodemieUrl('http://localhost:8080'), { ok: true, url: 'http://localhost:8080' });
  assert.equal(normalizeCodemieUrl('http://codemie.acme.com').reason, 'insecure');
  assert.equal(normalizeCodemieUrl('').reason, 'empty');
  assert.equal(normalizeCodemieUrl('not a url').reason, 'invalid');
});
test('assert_safe_refuses_shell_text', () => {
  assert.throws(() => assertSafe('name', 'prod;rm -rf ~'));
  assert.throws(() => assertSafe('name', "a'b"));
  assert.throws(() => assertSafe('url', 'https://x.com/$(id)'));
  assert.equal(assertSafe('agent', 'claude-acp'), 'claude-acp');
});
test('commands_close_stdin_per_platform', () => {
  assert.equal(cliCommands('macos').switchProfile('prod'), 'codemie profile switch prod < /dev/null');
  assert.equal(cliCommands('windows').proxyStatus, 'codemie proxy status --json < NUL');
  assert.equal(cliCommands('macos').proxyConnect(['--claude-desktop', '--vscode'], 'prod'), 'codemie proxy connect --claude-desktop --vscode --profile prod --silent < /dev/null');
  assert.equal(cliCommands('macos').install('claude'), 'codemie install claude');
});
test('run_log_redacts_and_caps', () => {
  const log = createRunLog({ limit: 2 });
  const r = log.start('codemie proxy status --json');
  r.append('{"status":"healthy","apiKey":"gk-123","port":4001}'); r.finish(0);
  assert.doesNotMatch(log.text(), /gk-123/);
  log.start('a').finish(0); log.start('b').finish(1);
  assert.equal(log.list().length, 2);
  assert.match(log.text(), /FAILED {2}\$ b/);
});
```

- [ ] **Step 2: Run** — `node --test ui/test/codemie-foundation.test.mjs` → FAIL (modules missing).
- [ ] **Step 3: Implement** the four modules.
- [ ] **Step 4: Run** — same command → PASS; `npm test` → all PASS.
- [ ] **Step 5: Commit** — `feat: add CodeMie address, command and run-log helpers`

---

#### Part 2B: JS — pure CodeMie model and parsers

**Files:**
- Create: `ui/workspace/codemie/model.js`, `ui/workspace/codemie/parse.js`
- Test: `ui/test/codemie-model.test.mjs`

**Interfaces:**
- Consumes: `APPS`, `AGENT_INFO`, `BUILTIN_AGENT` (Part 2A); `semverLt` (`ui/cli-update.js`).
- Produces:
  - The state shape `cm` (owned by Part 2C's service, defined here as `emptyCodemie()`): `{ loaded: false, runtime: { state: 'unknown'|'downloading'|'ready'|'failed', fraction: 0, error: '', ownCli: null|{version}, version: null, latest: null, updating: false }, config: { state: 'no-configuration'|'valid'|'broken', active: null, account: null }, profiles: [], auth: { state: 'unknown', detail: '' }, agents: undefined /* undefined = not read, null = read failed */, gateway: { state: 'unknown', port: null, profile: null }, apps: [], health: null, org: null, busy: {}, errors: {} }`.
  - `parseProxyStatus(stdout: string) => {state: 'running'|'unhealthy'|'stopped', port: number|null, profile: string|null}` — `healthy` → running; never reads `apiKey`; bad JSON → `{state:'stopped', port:null, profile:null}`.
  - `agentStatus(agent) => 'busy'|'none'|'too_old'|'update'|'ok'` — agent rows are `parseAgentList` + `joinUpdateStatus` rows (`{name, command, installed, version, description, updateAvailable, latest}`) plus `belowMinimum?: boolean` from Health.
  - `appState(cm, id) => 'connected'|'disconnected'|'not_set'|'not_installed'` — configured + gateway running → connected; configured + not running → disconnected.
  - `setupProgress(cm, prefs) => {account: boolean, agent: boolean, apps: boolean, count: 0..3, complete: boolean}` — account = `cm.profiles.length > 0`; agent = any installed agent whose `command !== BUILTIN_AGENT`; apps = any connected app or `prefs.appsSkipped`; complete = account && agent.
  - `attention(cm) => Array<{key, title, text, action: {label, action, id?}}>` in this order, copy from the prototype's `attention()`: `runtime-failed`, `config-broken` (title "Your CodeMie profile is no longer working", action Set up again → `cm-setup-open`), `signed-out` (active profile, `auth.state === 'not_signed_in'`, action Sign in again → `cm-profile-login`), `agent-old:<name>`, `gateway-stopped`.
  - `tabDots(cm, prefs) => Set<'cm-overview'|'cm-profiles'|'cm-agents'|'cm-apps'|'ai'>`.
  - `firstStep(cm, prefs) => 'found'|'welcome'|'signin'|'agents'|'apps'|'done'` — `found` when `cm.runtime.ownCli && cm.profiles.length && !prefs.introduced`.
  - `shouldAutoOpen(cm, prefs) => boolean` — true once per install: `!prefs.introduced && cm.loaded && (cm.profiles.length === 0 || cm.runtime.ownCli)`.

- [ ] **Step 1: Write the failing tests** — `parse_proxy_status_drops_api_key` (stdout `{"status":"healthy","apiKey":"gk","port":4001,"profile":"prod"}` → `{state:'running',port:4001,profile:'prod'}`, `JSON.stringify` has no `gk`); `builtin_agent_does_not_count_for_setup`; `app_state_follows_gateway`; `attention_orders_signed_out_before_agents`; `first_step_found_for_own_cli`; `auto_open_only_once` (`prefs.introduced = true` → false).
- [ ] **Step 2: Run** — `node --test ui/test/codemie-model.test.mjs` → FAIL.
- [ ] **Step 3: Implement** both modules.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat: derive CodeMie setup progress and attention`

---

#### Part 2C: JS — CodeMie service (state + every native and CLI call)

**Files:**
- Create: `ui/workspace/codemie/service.js`
- Test: `ui/test/codemie-service.test.mjs` (fake `invoke`/`listen`, like `automations-controller.test.mjs`'s `harness()`)

**Interfaces:**
- Consumes: Task 1, Parts 2A–2B; `parseAgentList` (`ui/agents-parse.js`), `parseUpdateStatus` (`ui/agents-update-parse.js`), `joinUpdateStatus` (`ui/agents-join.js`), `parseDoctorOutput` (`ui/doctor-parse.js`), `groupDoctorResults` (`ui/doctor-groups.js`), `findLoginError` (`ui/signin-parse.js`).
- Produces: `export function createCodemieService({ invoke, listen, runLog, platform, now = Date.now, setupRunning = () => false })` returning:
  - `state` (the live `cm` object), `subscribe(fn) => unsubscribe`, `busy(): boolean`.
  - `boot(): Promise<void>` — `runtime_ready`; if false, starts `ensureRuntime()` in the background; `check_handshake_state` → `ownCli` (`global_found`, `global_version`); `codemie_org_defaults` → `org`; then `load()`; after the runtime is ready, `update_cli` (background; a returned version sets `runtime.version` and refreshes agents).
  - `load({force = false} = {})` — skipped while `setupRunning()` (Review Focus 1) and throttled to once per 5 s unless `force`: `read_codemie_profiles`, `check_profile_status`, `codemie list` + `codemie update --check`, `codemie proxy status --json`, `codemie_app_states`. A failed `codemie list` sets `agents = null`.
  - `ensureRuntime()` — listens to `runtime:progress` `{phase, fraction}`, sets `runtime.state='downloading'`, invokes `ensure_runtime`; an error starting with `download failed:` → `state:'failed'`; success → `ready` then `load({force:true})`.
  - `checkUrl(url) => Promise<{verdict, status, detail}>` (`codemie_url_check`, logged as `Check <url> answers as CodeMie`).
  - `switchProfile(name)`, `renameProfile(from, to)`, `deleteProfile(name)` (`-y`), `signIn(url)` (`run_stream` `codemie profile login --url <url>`; then `findLoginError(lines)` → throw with that sentence; then `check_profile_status`).
  - `installAgent(name)`, `updateAgent(name)`, `removeAgent(name)` — `run_stream`, one at a time per agent (`busy[name]`); after remove, if `codemie list` still shows it installed, run `commandPath(command)` and set `agents[i].note = 'Removed CodeMie’s copy. <name> is still installed at <path>, outside CodeMie.'` (legacy behaviour, `agents-controller.js`).
  - `refreshGateway()` (`proxy status --json` → `parseProxyStatus`), `refreshApps()` (`codemie_app_states`).
  - `connectApps(ids: string[], profile)` — one `proxyConnect` call with every `connectFlag`; then `refreshGateway()` and `refreshApps()`. `disconnectApp(id)` — only when `APPS[id].disconnectFlag`. `startGateway(profile)` / `restartGateway(profile)` — `proxyStart`/`proxyRestart`. `openDownload(id)` — `open_app_download`.
  - `runDoctor()` — `run_stream` `codemie doctor`, stdout lines only → `parseDoctorOutput` → `groupDoctorResults`; stores `{rows, summary, checkedAt}` in `health`; sets `belowMinimum` on agent rows whose name matches a failing `tools` row.
  - `updateCli()` — bundled runtime: `invoke('update_cli')`; own CLI: `selfUpdate`.
  - `openInTerminal({folder, launcher, profile})` (`open_agent_in_terminal`), `pickFolder()` (`pick_project_folder`).
  - Every CLI call goes through one private `run(cmd, {stream})`: `runLog.start(cmd)`, `invoke('run_capture', {cmd})` or `invoke('run_stream', {cmd, streamId})` with `listen('engine:cmd-line')` filtered by `id`; on non-zero exit throws `Object.assign(new Error(<plain sentence>), {cmd, output, code})`. While any operation runs, `invoke('workspace_installer_busy', {busy: true})`; when the last one ends, `{busy: false}`.

- [ ] **Step 1: Write the failing tests** (fake `invoke` returns per command, records calls):
  - `load_reads_everything_once` — commands called: `read_codemie_profiles`, `check_profile_status`, `run_capture` ×3 (`codemie list …`, `codemie update --check …`, `codemie proxy status --json …`), `codemie_app_states`; second `load()` within 5 s calls nothing.
  - `load_skips_config_while_setup_runs` — `setupRunning: () => true` → no `read_codemie_profiles` call.
  - `rename_refuses_unsafe_names` — `renameProfile('prod', 'a b')` rejects, no `run_capture` call.
  - `run_failure_carries_output` — `run_capture` returns `{code: 1, stdout: '', stderr: 'npm error code ETIMEDOUT'}` → error has `.output` containing `ETIMEDOUT`, run log entry `code: 1`.
  - `busy_flag_wraps_operations` — `installAgent('gemini')` sends `workspace_installer_busy {busy:true}` then `{busy:false}`.
  - `runtime_failure_is_retryable` — `ensure_runtime` rejects `'download failed: timeout'` → `runtime.state === 'failed'`; second `ensureRuntime()` → `ready`.
- [ ] **Step 2: Run** — `node --test ui/test/codemie-service.test.mjs` → FAIL.
- [ ] **Step 3: Implement** `service.js`.
- [ ] **Step 4: Run** → PASS; `npm test` → PASS.
- [ ] **Step 5: Commit** — `feat: add the CodeMie service behind the native settings`

---

### Task 3: Settings → CodeMie tabs

The five native tabs replace the embedded installer. Until Task 4 lands, the controller gets a stand-in session `{ running: () => false, cancel: async () => true }` and `openSheet()` only shows the toast "Guided setup arrives in the next task" — Task 4 replaces both. **Done when** `npm test` passes and `cargo tauri dev` shows the five tabs with live data from the CLI, no legacy sidebar and no "CLI usage analytics". Each part ends in its own commit.

#### Part 3A: Settings plumbing — CodeMie tabs, controller, dots, quit

**Files:**
- Create: `ui/workspace/codemie/controller.js`
- Modify: `ui/workspace/view-settings.js`, `ui/workspace/app.js`, `ui/workspace/shell.js`, `ui/workspace/icons.js`, `ui/workspace/workspace.css`
- Test: `ui/test/codemie-controller.test.mjs`; update `ui/test/workspace.test.mjs:405`

**Interfaces:**
- Consumes: `createCodemieService` (Part 2C), a setup session `{ running(): boolean, cancel(): Promise<boolean> }` (the stand-in from the Task 3 intro; `createSetupSession` from Part 4A replaces it), `createRunLog` (Part 2A), model (Part 2B).
- Produces:
  - `export function createCodemieController({ state, service, session, runLog, render, route, openModal, confirmModal, toast, writeText, localPref, setLocalPref, store })` → `{ handle(action: string, el: HTMLElement): Promise<boolean> /* false = not a cm action */, change(el): Promise<boolean>, input(el): boolean /* stores [data-draft] values into the sheet draft without rendering */, panel(tab: string): string, headerActions(tab: string): string, banners(route: string): string, todayCard(): string, settingsDot(): boolean, tabDots(): Set<string>, sheet(): string /* '' when closed */, boot(): Promise<void>, onFocus(): void, onQuitRequest(): Promise<void>, prefs(): {introduced, snoozedUntil, appsSkipped} }`.
  - Prefs keys: `codemie.setup.introduced` ('1'), `codemie.setup.snoozedUntil` (epoch ms), `codemie.setup.appsSkipped` ('1'), `codemie.start.folders` (JSON array, last 5 paths). The old `codemie.setupBanner.dismissed` is no longer read.
  - `view-settings.js`: `SETTINGS_TABS` group `'CodeMie'` = `['cm-overview','Overview','spark']`, `['cm-profiles','Profiles','user']`, `['cm-agents','Coding agents','terminal']`, `['cm-apps','Connected apps','plug']`, `['cm-health','Health','heart']`; `LEGACY_TABS` and `#legacy-host` removed; `export const LEGACY_TAB_REDIRECTS = { installation: 'cm-overview', tools: 'cm-agents', desktop: 'cm-apps', health: 'cm-health', usage: 'cm-overview' }`; `settings(s, ctx)` reads `ctx.codemie` (`panel`, `headerActions`, `tabDots`) for `cm-*` tabs and dots; `TAB_DESCRIPTIONS` gets the prototype's five `TAB_TEXT` lines.
  - `shell.js`: `renderShell({ snapshot, route, resolvedDark, settingsDot = false })` — the Settings dot shows for the Microsoft condition **or** `settingsDot`.
  - `icons.js`: add `terminal`, `plug`, `package`, `cpu`, `globe`, `building`, `swap`, `rocket`, `user-plus` (paths from `prototypes/codemie-tools/proto.js` `EXTRA`).
  - `workspace.css`: new section `/* ------------------------------------------------------------------ CodeMie (Settings → CodeMie, setup sheet) */` appended at the end, holding every rule from `prototypes/codemie-tools/proto.css` except `.cm-proto*`, `.cm-placeholder-lines` and the two "url() inside a custom property" override lines; `.ws-legacy-host` removed.
  - `app.js`:
    - `handle()`: `if (action.startsWith('cm-')) { if (await codemie.handle(action, el)) return; }` before the `switch`; change listener likewise via `codemie.change(el)`.
    - `setup-tools` → `route('settings', 'cm-overview')`; `settings-tab` and `route()` map `LEGACY_TAB_REDIRECTS`; the boot hash parse validates the tab against `SETTINGS_TABS` (it does not today).
    - Remove: `mountLegacy`, the legacy unmount in `render()`, `legacyMounted` checks outside recovery/smoke, `prepare-tools`, `setup-dismiss`, the "Bring your AI coding tools here too" banner, `runtimeReady` (now `codemie.service.state.runtime`). Keep `legacyModule` only for `recovery-tools` and the smoke/probe boot path.
    - `banners(s)` appends `codemie.banners(state.route)`; `today()` ctx gets `codemieCard: codemie.todayCard()` (rendered in Part 4B); `shellMarkup()` passes `settingsDot: codemie.settingsDot()`; `render()` puts the sheet into a `<div class="cm-sheet">` kept inside a `#cm-sheet-host` appended to `document.body` once — create the `.cm-sheet` element when the sheet opens, replace only its `innerHTML` on later renders (so its fade-in does not replay), remove it when the sheet closes.
    - The input listener calls `codemie.input(el)` first. Service updates (progress ticks) re-render through `render()` at most every 250 ms, and skip a tick while a text input, textarea or select inside the sheet or Settings has focus (as the prototype's `renderLight` does).
    - `boot()`: after `bootWorkspace`, `await codemie.boot()`; window `focus` → `codemie.onFocus()`; `workspace:quit-request` → `await codemie.onQuitRequest()` (and the legacy leave only when `legacyModule` is loaded).

- [ ] **Step 1: Write the failing tests** — in `codemie-controller.test.mjs` with fakes: `unknown_action_is_not_handled` (`handle('ai-test', el)` → `false`); `legacy_tab_ids_redirect` (`LEGACY_TAB_REDIRECTS.usage === 'cm-overview'` and `SETTINGS_TABS` has no `usage`/`installation`); `settings_dot_when_setup_unfinished`; `quit_request_cancels_setup_and_clears_busy` (session `running()` true → `cancel()` called and `invoke('workspace_installer_busy',{busy:false})` recorded). In `workspace.test.mjs:405` replace `'installation'` with `'cm-overview'` in the tab loop and pass `ctx.codemie` stubs.
- [ ] **Step 2: Run** — `node --test ui/test/codemie-controller.test.mjs ui/test/workspace.test.mjs` → FAIL.
- [ ] **Step 3: Implement** the controller skeleton (panels return `''` until Parts 3B–3E), the settings/shell/app/icons/css changes.
- [ ] **Step 4: Run** → PASS; `npm test` → PASS; `cargo tauri dev` → Settings shows the CodeMie group with five empty tabs, no legacy sidebar, no "CLI usage analytics".
- [ ] **Step 5: Commit** — `feat: native CodeMie group in Settings replaces the embedded installer`

---

#### Part 3B: Overview, CLI card and Health

**Files:**
- Create: `ui/workspace/codemie/view-overview.js`, `ui/workspace/codemie/view-health.js`
- Modify: `ui/workspace/codemie/controller.js`
- Test: `ui/test/codemie-views.test.mjs`

**Interfaces:**
- Produces:
  - `overviewPanel(cm, prefs) => string` — prototype `overviewPanel`: attention banners, the setup checklist (`cm-hero`) until `setupProgress(cm).complete`, else four tiles + active-profile select (only when > 1 profile) + "Start coding" card; then the CodeMie CLI `ws-advanced` card. The CLI card has **no** "Use CodeMie from Terminal" toggle: show a read-only setting row "Terminal can use `codemie` and agent commands" (bundled) or the npm-copy row (own CLI). Actions: `cm-setup-open`, `cm-tab` (`data-tab`), `cm-profile-switch` (select), `cm-start-agent` (select), `cm-open-terminal` (`data-id`), `cm-copy` (`data-copy`), `cm-cli-update`, `cm-cli-check`, `cm-runtime-retry`.
  - `healthPanel(cm, runLog) => string` — before a run: empty state with "Check everything"; running: progress line; after: rows grouped by `group` (`account` → "Your CodeMie account", `tools` → "Your tools", `codemie` → "CodeMie itself") with `remedyText` and a button per `action`: `{kind:'navigate', view:'setup'}` → `cm-setup-open`, `{kind:'navigate', view:'agents'}` → `cm-tab data-tab=cm-agents`, `{kind:'signin'}` → `cm-profile-login`, `{kind:'recheck'}` → `cm-doctor`. Then "What CodeMie ran" from `runLog.list()` with `cm-ran-toggle` (expand output) and `cm-copy-all`.
  - Controller: `cm-doctor` → `service.runDoctor()`; auto-run once per session when Health opens and a profile exists (legacy `autoHealthCheck`). `cm-cli-update` / `cm-cli-check` → `service.updateCli()` (bundled: `update_cli`; own npm copy: `selfUpdate` / `selfUpdateCheck`). `cm-runtime-retry` → `service.ensureRuntime()`. `cm-open-terminal` → `openModal` listing `codemie.start.folders` (newest first) plus "Choose another folder…" (`service.pickFolder()`), submit → `service.openInTerminal({folder, launcher: <agent command>, profile: active})`, then the folder moves to the front of `codemie.start.folders` (max 5).
- [ ] **Step 1: Write the failing tests** — `overview_shows_checklist_until_complete`; `overview_tiles_when_complete` (four `cm-tile`); `cli_card_names_own_copy` (`ownCli` → text contains `installed with npm`); `health_maps_actions` (a row with `{kind:'signin'}` renders `data-action="cm-profile-login"`); `ran_log_output_is_escaped` (output `<img src=x onerror=1>` → `&lt;img`).
- [ ] **Step 2: Run** — `node --test ui/test/codemie-views.test.mjs` → FAIL.
- [ ] **Step 3: Implement** the two views and the controller actions.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat: CodeMie overview and health tabs`

---

#### Part 3C: Profiles tab

**Files:**
- Create: `ui/workspace/codemie/view-profiles.js`
- Modify: `ui/workspace/codemie/controller.js`
- Test: `ui/test/codemie-views.test.mjs`, `ui/test/codemie-controller.test.mjs`

**Interfaces:**
- Produces: `profilesPanel(cm, ui) => string` (prototype `profilesPanel`/`profileCard`; `ui.tests` holds Test results). Facts: Account (`cm.config.account` for SSO profiles), Provider (`PROVIDERS` short label), Project (`codemieProject`), Model, Server/Address (`codemieUrl` or `baseUrl`, host only). Sign-in chip only on the active profile (from `cm.auth`); other profiles show none.
- Controller actions:
  - `cm-profile-activate` → `service.switchProfile`; `cm-profile-switch` (select change) → same.
  - `cm-profile-login` → opens the compact sign-in dialog (Part 4B) and starts `service.signIn(profile.codemieUrl)` at once; on success closes with the toast from the prototype.
  - `cm-profile-test` → `store.query('ai_test', { profileId: 'codemie:' + name })` (the Claude tab's existing test; shows `testResultLabel` from `settings-ai.js`).
  - `cm-profile-edit` → opens the sheet in `edit` mode for that profile (Part 4B).
  - `cm-profile-rename` → `openModal` with one field (validation `SAFE.name`, duplicate check) → `service.renameProfile`.
  - `cm-profile-delete` → `confirmModal` (`variant:'danger', initialFocus:'cancel', guard:true`) with the prototype's text (active → next profile becomes active; gateway profile follows) → `service.deleteProfile`; if it was active, `switchProfile(next)`; if the gateway used it, `restartGateway(next)`.
  - `cm-profile-file` → copies `~/.codemie/codemie-cli.config.json` to the clipboard (`writeText`) with the toast "Copied the configuration file path".
  - `cm-profile-add` → sheet in `add` mode.
- [ ] **Step 1: Write the failing tests** — `unsafe_profile_name_disables_actions` (profile `"my profile"` → no `cm-profile-activate|rename|delete|login` buttons enabled and the hint "Rename this profile in Terminal to manage it here." present); `only_active_profile_shows_sign_in_state`; `delete_active_switches_to_next` (controller with fake service: deleting `prod` while active calls `switchProfile('staging')`).
- [ ] **Step 2: Run** — `node --test ui/test/codemie-views.test.mjs ui/test/codemie-controller.test.mjs` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat: manage CodeMie profiles in Settings`

---

#### Part 3D: Coding agents tab

**Files:**
- Create: `ui/workspace/codemie/view-agents.js`
- Modify: `ui/workspace/codemie/controller.js`
- Test: `ui/test/codemie-views.test.mjs`, `ui/test/codemie-controller.test.mjs`

**Interfaces:**
- Produces: `agentsPanel(cm, ui) => string` (prototype `agentsPanel`/`agentCard`/`builtinCard`). Rows come from `cm.agents` (CLI output, so any agent a newer CLI adds still appears, with the CLI's own description when `AGENT_INFO` has no entry). Order: installed first, built-in `codemie-code` card, then `featured`, then the rest behind "Show N more" with `editor` agents under "For code editors · Zed, JetBrains (ACP)". An agent whose `AGENT_INFO.providers` does not include the active profile's provider shows "Doesn’t work with <provider> profiles" instead of Install. `cm.agents === null` → empty state "CodeMie could not list the agents" with Try again (`cm-agents-refresh`).
- Controller actions: `cm-agent-install|update|remove` (`remove` behind `confirmModal`), `cm-agent-update-all` (sequential), `cm-agent-check` (`load({force:true})`), `cm-agents-more`, `cm-agent-dismiss`, `cm-open-terminal`.
- Failure copy: plain sentence (`'<Name> was not installed'` / `'… was not updated'`) + the prototype's explanation + the CLI output under "Show output"; with empty output show "No output was captured.".
- [ ] **Step 1: Write the failing tests** — `install_failure_without_output_keeps_state` (fake service rejects with `{output: ''}` → row still "Install", error block contains `No output was captured.`); `incompatible_agent_cannot_install` (active profile `bedrock`, agent `gemini` → no `cm-agent-install` for it); `unknown_cli_agent_still_listed` (`codemie list` row `newagent` without `AGENT_INFO` → rendered with its description).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat: install, update and remove coding agents natively`

---

#### Part 3E: Connected apps tab

**Files:**
- Create: `ui/workspace/codemie/view-apps.js`
- Modify: `ui/workspace/codemie/controller.js`
- Test: `ui/test/codemie-views.test.mjs`

**Interfaces:**
- Produces: `appsPanel(cm, ui) => string` (prototype `appsPanel`/`appRow`): gateway card when any app is configured (state, profile select `cm-gateway-profile`, Start/Restart `cm-gateway-start|restart`, port from `cm.gateway.port`), then one row per `APPS` entry by `appState`. Disconnect only when `disconnectFlag` (Codex app); other connected apps show the line "To disconnect, remove CodeMie in <app>’s settings — this CodeMie version can’t do it yet." Not installed → "Get it" (`cm-open-download` → `service.openDownload(id)`) and "Check again" (`cm-apps-refresh` → `service.refreshApps()`).
- Controller: `cm-app-connect` → `service.connectApps([id], gateway.profile || active)`; `cm-app-disconnect` → `confirmModal` → `service.disconnectApp(id)`; `cm-gateway-profile` → `service.restartGateway(value)`.
- [ ] **Step 1: Write the failing tests** — `disconnect_only_where_cli_supports` (Claude Desktop connected → no `cm-app-disconnect`; Codex connected → present); `gateway_card_hidden_until_configured`; `stopped_gateway_offers_start`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat: connect Claude Desktop, VS Code and Codex through the CodeMie gateway`

---

### Task 4: Guided setup — setup session, setup sheet, first launch, Claude tab

Profile creation and editing through `codemie setup` behind the native sheet, the Today card, first-launch opening and the Claude tab sign-in. **Done when** `npm test` passes and the manual runs in Parts 4A and 4B pass against a real CLI. Each part ends in its own commit.

#### Part 4A: JS — setup session: answer `codemie setup` from the native UI

**Files:**
- Modify: `ui/setup-parse.js` (`PROMPTS`), `ui/setup-driver.js`, `ui/test/tools/replay-capture.mjs` (`ANCHOR_MAP`)
- Create: `ui/workspace/codemie/setup-prompts.js`, `ui/workspace/codemie/setup-session.js`, `ui/test/fixtures/setup/integration.json`, `ui/test/fixtures/setup/bedrockAuth.json`
- Test: `ui/test/codemie-setup-session.test.mjs`, extend `ui/test/setup-parse.test.mjs`

**Interfaces:**
- Driver changes:
  - `setup-parse.js` `PROMPTS` gains, before `credential`: `{ id: 'integration', kind: 'list', anchor: 'Select LiteLLM integration' }`, `{ id: 'bedrockAuth', kind: 'list', anchor: 'Authentication method:' }`, `{ id: 'awsProfile', kind: 'list', anchor: 'Select AWS profile:' }`. Same anchors in `replay-capture.mjs`. Without this, "? Select LiteLLM integration:" is classified as `credential` and the driver types into a list.
  - `setup-driver.js`: `modelManual` and `customModel` are passed to `onPrompt` as `kind: 'input'` instead of rejecting with step `'model'`; the three new list ids are passed to `onPrompt` like `codemieProject`.
- Produces:
  - `setup-prompts.js`: `stripHint(message) => {text, defaultValue}` (moved from `ui/setup-view.js`, which re-imports it); `providerIndex(options: string[], provider: string) => number` using `{ 'ai-run-sso': /SSO/i, litellm: /LiteLLM/i, bedrock: /Bedrock/i, ollama: /Ollama/i, 'anthropic-subscription': /Anthropic/i, 'moonshot-subscription': /Moonshot/i }` (−1 when absent); `credentialAnswer(message: string, fields: {endpoint?, key?, awsRegion?, awsAccessKey?, awsSecret?}) => string|null` (`/Proxy URL|base URL/i` → endpoint, `/API Key/i` → key or `''`, `/AWS Region/i` → awsRegion, `/Access Key ID/i`, `/Secret Access Key/i`; `/Ollama cloud API key/i` → `''`); `recommendedIndex(options) => number|null` (the option with `⭐`).
  - `setup-session.js`: `export function createSetupSession({ startSetup, cancelSetup, readProfiles })` → `{ run(plan, ui): Promise<{profileName: string, updated: boolean}>, cancel(): Promise<boolean>, running(): boolean }`; `readProfiles` is `() => invoke('read_codemie_profiles')`.
    - `plan = { mode: 'add'|'update', profile?: string, provider: string, url?: string, fields?: object, name?: string }`.
    - `ui = { onBrowser(): void, choose({id, message, options, recommended}): Promise<number>, onFailure({id, message}): void }`.
    - Answers: `gate` → index of `/Add a new profile/` or `/Update an existing profile/`; `updateProfile` → index of `plan.profile`; `provider` → `providerIndex` (−1 → reject `{step:'provider', message:'This CodeMie version does not offer <provider>.'}`); `codemieUrl` → `plan.url`; `credential` → `credentialAnswer` (null → reject `{step:'credential', message:'CodeMie asked something Connect does not know: <message>'}`); `codemieProject`, `integration`, `model`, `bedrockAuth`, `awsProfile` → `ui.choose`; `modelManual`/`customModel` → `ui.choose({id: 'model', message, options: SUBSCRIPTION_MODELS[plan.provider] ?? [], recommended: 0})` and answer the chosen id (no options → reject `{step:'model', message:'CodeMie found no models for this provider.'}`); `profileName` → `plan.name ?? stripHint(message).defaultValue ?? 'default'`; `installClaude` → `false`. `onLog` text matching `/Opening browser for authentication/` → `ui.onBrowser()` once; `onScreen` → `detectFailure(lines)` → `ui.onFailure` once per id.
    - The run is accepted only when `read_codemie_profiles` (passed in as `readProfiles`) then lists `profileName` (legacy check: `setup-view.js:636-642`); otherwise reject `{step:'verify', message:'Setup finished, but the profile was not saved.'}`.
    - In-app deps for `startSetup`: `{ spawnPty, input, kill }` from `ui/runner-bridge.js` `pty`, `Terminal` from `ui/vendor/xterm.mjs`, `suspendPtyInput`/`resumePtyInput` as no-ops (no visible terminal).

- [ ] **Step 1: Write the failing tests** — fake `startSetup` that calls `onPrompt` with a scripted sequence and resolves `{profileName:'default', updated:false}`:
  - `answers_sso_add_flow` — sequence `provider` (options `['CodeMie SSO','LiteLLM','AWS Bedrock','Anthropic Subscription','Moonshot Subscription','Ollama']`) → `codemieUrl` → `codemieProject` → `integration` → `model` → `profileName` → `installClaude`; asserts answers `0`, `'https://codemie.acme-bank.com'`, ui choice, ui choice, ui choice, `'default'`, `false`.
  - `update_mode_picks_profile` — `gate` options `['Add a new profile','Update an existing profile']`, `updateProfile` options `['prod','staging']`, `plan.profile='staging'` → answers `1`, `1`.
  - `unknown_credential_rejects` — credential `'? Bedrock role ARN:'` → rejects with the message above.
  - `browser_line_fires_once` — two `onLog` chunks with the line → `onBrowser` called once.
  - In `setup-parse.test.mjs`: `integration_prompt_is_a_list` with `fixtures/setup/integration.json` (build it from `codemieProject.json`, replacing the question line with `? Select LiteLLM integration: (Use arrow keys)` and two options).
- [ ] **Step 2: Run** — `node --test ui/test/codemie-setup-session.test.mjs ui/test/setup-parse.test.mjs ui/test/setup-driver.test.mjs` → FAIL (new tests).
- [ ] **Step 3: Implement** the driver/parser changes, `setup-prompts.js`, `setup-session.js`.
- [ ] **Step 4: Run** the same command → PASS; existing `setup-driver.test.mjs` cases that expected `modelManual` to reject are updated to expect an `onPrompt` call (same commit).
- [ ] **Step 5: Manual capture (not automated)** — with a real CLI, run `node ui/test/tools/replay-capture.mjs` through one AWS Bedrock setup and one Anthropic Subscription setup; save `bedrockAuth.json` and confirm the anchors match the real screens. If Bedrock's flow shows a prompt the session cannot answer, keep `bedrock` out of the provider choices in Part 4B and note it in the commit message.
- [ ] **Step 6: Commit** — `feat: drive codemie setup from native answers`

---

#### Part 4B: Setup sheet, first launch and the Today card

**Files:**
- Create: `ui/workspace/codemie/view-sheet.js`, `ui/workspace/codemie/view-today.js`
- Modify: `ui/workspace/codemie/controller.js`, `ui/workspace/view-today.js` (render `ctx.codemieCard` after `${banners}`)
- Test: `ui/test/codemie-sheet.test.mjs`

**Interfaces:**
- Produces:
  - `sheetMarkup(sheet, cm) => string` — the prototype's `sheetMarkup` + `STEP_VIEWS` (welcome, found, signin, project, agents, apps, done) with these differences from the prototype: step 2 is driven by the session's `choose` calls — it shows the list the CLI sent (`codemieProject`, then `integration` when asked, then `model`), one at a time, with the CLI's ⭐ option marked "Recommended" and pre-selected; model names are the CLI's ids. "More options" holds only the profile name (and, in `add` mode, "Make it the active profile").
  - `sheet` state (controller-owned): `{ mode: 'setup'|'add'|'edit'|'relogin', step, d: draft, pending: null|{id, options, recommended, resolve} }`.
  - Sign-in step choices: `codemie` (EPAM default, or `cm.org` when present: label `<organizationName> CodeMie`, badge "Your organization"); `org` ("CodeMie at my organization", address field `data-draft="orgUrl"`, "Used before on this Mac" links from SSO profiles' `codemieUrl` other than the default); `subscription` (Claude or Kimi; installs Claude Code/Kimi Code first when missing); `other` (LiteLLM, AWS Bedrock, Ollama with the prototype's fields). Start: `org` → `normalizeCodemieUrl` (reason → prototype copy) → `service.checkUrl` (`not_codemie` / `unreachable` → prototype copy, nothing runs) → session run with `plan.url`. Runtime still downloading → "Getting CodeMie ready first…" and the run starts when `runtime.state === 'ready'`.
  - Modes: `setup` steps signin → project → agents → apps → done; `add` signin → project → done (switch back to the previous active profile when "Make it the active profile" is off); `edit` → session `{mode:'update', profile}` showing only the project/model step; `relogin` → compact dialog (`cm-sheet-panel cm-compact`), starts `service.signIn` immediately, closes itself on success.
  - `todayCard(cm, prefs) => string` — the prototype's `todaySetupCard` while `!setupProgress(cm).complete && now > prefs.snoozedUntil`; buttons `cm-setup-open`, `cm-setup-snooze` (sets `snoozedUntil = now + 24 h`).
  - First launch: after the first `render()` following `codemie.boot()`, if `shouldAutoOpen(cm, prefs)` → open the sheet at `firstStep` and set `codemie.setup.introduced = '1'`.
  - Closing: allowed at any time; a running step keeps running (`setupRunning` stays true until it settles); toast "Setup paused. Everything so far is saved — continue from Today or Settings → CodeMie." Re-opening resumes at `firstStep` (derived from CLI state).
- [ ] **Step 1: Write the failing tests** — `org_address_rejected_before_anything_runs` (draft `orgUrl: 'http://codemie.acme.com'` → error title "The address must start with https://", fake service `checkUrl` not called); `not_codemie_stops_before_setup` (`checkUrl` → `not_codemie` → session `run` not called); `org_default_is_first_choice`; `project_step_shows_cli_options` (pending `{id:'codemieProject', options:['EPM-CDME','taylor.morgan'], recommended:null}` → two radios, `EPM-CDME` checked); `today_card_snoozes_for_a_day`; `auto_open_once` (second boot with `introduced='1'` → no sheet).
- [ ] **Step 2: Run** — `node --test ui/test/codemie-sheet.test.mjs` → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `npm test` → PASS.
- [ ] **Step 5: Manual run (real CLI, VPN on)** — `cargo tauri dev` with an empty `CODEMIE_HOME` (`CODEMIE_HOME=$(mktemp -d) cargo tauri dev`): first launch opens the sheet → EPAM sign-in → project/model from the CLI → Claude Code installs → Claude Desktop connects → Done; "What CodeMie ran" lists each command. Repeat with "CodeMie at my organization" and a wrong address (`www.example.com`) → "is not a CodeMie address".
- [ ] **Step 6: Commit** — `feat: guided CodeMie setup on first launch with custom addresses`

---

#### Part 4C: Claude tab, Inbox drafts and the chooser point at the new flow

**Files:**
- Modify: `ui/workspace/settings-ai.js` (`stateAction`, lines 87–98), `ui/workspace/draft-state.js:137` (`toolsAction`), `ui/workspace/ai-chooser.js:22`
- Test: `ui/test/ai-settings.test.mjs:12`, `ui/test/ai-draft.test.mjs:220-223`

**Interfaces:**
- CodeMie `needs_login` → `button('Sign in', {action:'cm-profile-login', variant:'primary', iconName:'link', attrs:{'data-id': <name from 'codemie:<name>'>}})` plus `Manage profiles` (`cm-tab`, `data-tab="cm-profiles"`); the Terminal sentence goes. `not_installed` / `not_configured` / `too_old` (CodeMie) → `Set up CodeMie` (`cm-setup-open`). Native Claude rows are unchanged.
- `draft-state.js` `toolsAction` → same buttons; `ai-chooser.js` copy → "set up a CodeMie profile in Settings → CodeMie".
- [ ] **Step 1: Update the tests first** — `ai-settings.test.mjs` expects `/data-action="cm-profile-login"/` for the `codemie:staging` needs_login fixture and no `/Open CodeMie tools/`; `ai-draft.test.mjs` expects `'cm-setup-open'` / `'Set up CodeMie'`.
- [ ] **Step 2: Run** — `node --test ui/test/ai-settings.test.mjs ui/test/ai-draft.test.mjs` → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat: sign in to CodeMie profiles from the Claude tab`

---

### Task 5: Remove CLI usage analytics; browser end-to-end coverage

**Done when** `make check` passes and the browser end-to-end run exits 0 with the new screenshots checked against the prototype. Each part ends in its own commit.

#### Part 5A: Remove CLI usage analytics; keep the legacy UI only for smoke and recovery

**Files:**
- Delete: `ui/analytics-command.js`, `ui/test/analytics-command.test.mjs`
- Modify: `ui/renderer.js` (`openLegacyTools`: drop the `'analytics'` branch and `runAnalytics`), `ui/index.html:55` (remove `#sidebar-analytics`), `ui/shell-nav.js` and `ui/test/shell-nav.test.mjs:8,33-34`, `.ai-run/guides/architecture/architecture.md` (lines 20 and 30: the legacy tools mount is now only for smoke/probe and storage recovery; add a row for `ui/workspace/codemie/`)
- Test: `npm test`

- [ ] **Step 1: Update `shell-nav.test.mjs`** to assert there is no `sidebar-analytics` element; run `node --test ui/test/shell-nav.test.mjs` → FAIL.
- [ ] **Step 2: Remove** the analytics code and markup listed above; `grep -rn "analytics" ui --include=*.js --include=*.html | grep -v test/fixtures` returns only `workspace/` references unrelated to the CLI report (automations/AI usage).
- [ ] **Step 3: Run** — `npm test` → PASS; `make check` → PASS.
- [ ] **Step 4: Commit** — `refactor: remove CLI usage analytics`

---

#### Part 5B: Browser end-to-end coverage and screenshots

**Files:**
- Modify: `ui/test/browser/workspace-e2e.mjs`

**Interfaces:**
- `installBridge` gains a `codemie` option (`'fresh'|'ready'|'expired'`) mapping to mocked direct commands, added before the `Unexpected native command` throw (line ~360): `runtime_ready`, `ensure_runtime` (emits `runtime:progress`), `check_handshake_state`, `codemie_org_defaults`, `read_codemie_profiles`, `check_profile_status`, `codemie_app_states`, `codemie_url_check` (`www.example.com` → `not_codemie`), `run_capture`/`run_stream` (by command prefix: `codemie list`, `codemie update --check`, `codemie proxy status --json`, `codemie proxy connect`, `codemie install`, `codemie doctor`), `spawn_pty`/`pty_input`/`pty_kill` (replay the `ui/test/fixtures/setup` screens through `engine:pty-data`), `workspace_installer_busy`, `open_agent_in_terminal`, `pick_project_folder`. Replace `runtime_ready: false` at line ~321.
- Cases (both themes, widths 1000 and 1680): `codemie: first launch opens setup`, `codemie: org address errors`, `codemie: settings tabs render` (loop `cm-overview`, `cm-profiles`, `cm-agents`, `cm-apps`, `cm-health`; screenshot `${theme}-settings-${tab}`), `codemie: expired sign-in banner and sign in again`, `codemie: no legacy chrome in settings` (no `#identity-bar`, no `#sidebar-analytics` visible).
- [ ] **Step 1: Add the cases** — run `PLAYWRIGHT_CORE=<path>/node_modules/playwright-core node ui/test/browser/workspace-e2e.mjs` (outside the sandbox; needs loopback) → the new cases FAIL until the mocks exist.
- [ ] **Step 2: Add the mocks** → re-run → exit code 0; check `output/playwright/workspace-e2e/*-settings-cm-*.png` against the prototype in both themes.
- [ ] **Step 3: Commit** — `test: browser coverage for native CodeMie settings`

---

## Follow-ups (not in this plan)

- CLI team: `codemie setup` flags for every answer plus `--json` progress; `profile list|status --json` with email and expiry (and `--profile` for non-active profiles); `list --json`, `update --check --json`; `doctor --json`; `proxy disconnect` for `--claude-desktop`, `--vscode`, `--vscode-claude-code`; `models list --json`. Each one lets a part of `setup-session.js` / parsing go.
- Move smoke/probe mode and the storage-recovery "Open CodeMie tools" path off `ui/renderer.js`, then delete the legacy installer UI (`renderer.js`, `home-view.js`, `setup-view.js`, `agents-ui.js`, `health-ui.js`, the controllers that import them, the `#app` markup and `styles.css`) and the dead install wizard (`engine.js`, `handlers.js`, `config/steps.yaml`, `sprite.js`, `steps-ui.js`).
- Native usage page from `codemie analytics --export json`.
