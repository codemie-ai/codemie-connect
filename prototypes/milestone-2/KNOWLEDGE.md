# Knowledge in CodeMie Connect — findings and handoff

Status: **postponed from Milestone 2** by the owner (2026-11-17); the owner continues it separately. This file collects everything found while planning, so the work can restart without repeating the research. Facts below were read from code unless marked *(inferred)*.

Milestone 2 builds what Knowledge depends on: the Echo-compatible plugin host, the Claude profiles and runner, and the data folder. See [DESIGN.md](DESIGN.md) and [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md).

**Follow-up:** [KNOWLEDGE-PLUGIN-FEASIBILITY.md](KNOWLEDGE-PLUGIN-FEASIBILITY.md) asks whether the whole engine can move into the plugin. Short answer: yes, but only once both apps give plugins six generic primitives. It includes a QuickJS benchmark. If that route is taken, §9 below changes: the engine would be ported to plugin JavaScript, not into Connect. The exact API both apps would add is in [SHARED-HOST-API.md](SHARED-HOST-API.md).

## 1. What the Knowledge plugin is

- **Pinned sources (both local only, not pushed):**
  - Plugin: worktree `/Users/Vadym_Vlasenko/.codex/worktrees/knowledge-plugin-0300/echo-plugins`, branch `codex/knowledge-plugin`, commit `498fe01`, "Knowledge 0.1.0 … (needs paired Echo build)".
  - Paired Echo: `/Users/Vadym_Vlasenko/.codex/worktrees/knowledge-plugin/echo`, branch `codex/knowledge-plugin`, commit `06ac4479`, on top of `feat/knowledge-vaults` `11c3d004`, which is 58 commits ahead of Echo `main`. The engine is not on Echo `main`.
- **Manifest** (`plugins/knowledge/echo-plugin.json`): `echo: ">=0.9.9"`, `uses: { knowledge: {}, sessions: { commands: ["status","read"] } }`, `agent.prefix: "kn"`, `main.js` and `client.js`.
- **The plugin is a client.** It is 5,638 lines: `view.js` 3,572, `model.js` 1,072, `knowledge.css` 974, `client.js` 14, `main.js` 6. All work happens in Echo's native **Knowledge engine**, `crates/echoctl/src/knowledge/`, which is 22,755 lines of Rust.
  - `client.js` loads `view.js`, adds `knowledge.css`, calls `ctx.knowledge.register(view)`, adds a settings section and calls `ctx.render()`.
  - `main.js` registers two agent commands, `status` and `read`, both calling `ctx.knowledge.read('api/kn/…')`.
- **Marketplace:** Echo's registry `~/Library/Application Support/echo/plugins.json` has one user-added marketplace, `"local"`, pointing at the Knowledge worktree. Nothing is installed. The installed `/Applications/Echo.app` (echoctl 0.9.11) refuses Knowledge with "uses 'knowledge', which this Echo doesn't know". The built-in marketplace `onetest-ai/echo-plugins` has only Scheduler, Telegram, Obsidian and GitHub.
- **Search** is in-memory substring and `#tag` matching (`scan.rs:326-352`). There are no embeddings, no FTS and no database.
- **Data:**
  - Vault registry: `<echo data>/.echo/knowledge/vaults.json`.
  - Per-vault caches (`index.json`) and the ingest ledger (`ingest.json`).
  - Vault content stays in the user's folder, with git history.
  - Drafts are kept in the page's `localStorage`.

## 2. Authorship and licence (decided)

- **Who wrote what** (`git log` per file):

  | Part | Files | Author |
  |---|---|---|
  | Engine | all 43 commits under `src/knowledge/` | the owner |
  | UI shim and bridge | `ui/knowledge.js` (61 lines), `ui/app/34-plugin-knowledge.js` (46 lines) | the owner |
  | Native bridges | `src/window/knowledge.rs`, `src/plugins/knowledge.rs` | the owner |
  | Plugin host | `jshost.rs`, `plugins.rs`, `ui/app/33-plugins-client.js` | Echo's maintainer |
  | Claude runs | `ai.rs`, `claudejob.rs` | Echo's maintainer |
  | Guard and terminal | `guard.rs`, `terminal.rs` | mostly Echo's maintainer |

- **Licences:** Echo is AGPL-3.0-only. Connect is Apache-2.0. `echo-plugins` has no LICENSE file.
- **Owner decision:** Connect gets its **own engine speaking the same protocol**. It is ported from the owner's own engine code, relicensed by the owner to Apache-2.0 inside Connect.
- **Rule for everything else** *(proposed, confirm when work restarts)*:
  - Reading the maintainer's code to match behaviour is fine; copying it is not.
  - In mixed files (`terminal::vault_args`, parts of `guard.rs` and `ai.rs`), `git blame` decides: lines the owner wrote may be ported, the rest is re-implemented.
  - Each ported file starts with `// Ported from Echo's Knowledge engine by its author; licensed Apache-2.0 in CodeMie Connect.`

## 3. The protocol Connect must serve

### 3.1 Reads — `ctx.knowledge.read(path)`

- `api/kn` → the vault list (status).
- `api/kn/<vault>/<view>?<query>`, with these views (`knowledge/api.rs:114-235`):
  - Vault and pages: `tree`, `rev`, `page` (`path`), `find`, `graph`, `rows`, `history`, `version` (`path`, `rev`), `asset`
  - Home and health: `home`, `checks`, `health` (`fixes`)
  - Ask: `chats`, `skills`
  - Settings and calls: `settings`, `preview` (call), `sample`, `twin-text`
  - Ingest sources: `ingest`, `calls` (`q`), `m365` (`q`)
- **Sub-routes the client uses:**
  - `chat/<id>` (`view.js:1147`)
  - `lint/<id>` (`:1247`)
  - `ingest/<id>/text` and `ingest/<id>/changes` (`:1282`, `:1610`)
  - `health/<key>` (`:2374`)
- **Polling:** `jobs?since=<n>` (actions run as jobs the page polls, `view.js:126-141`) and `pick` (the folder picker result, `view.js:144`).
- **Limits on the host half:** reads through the plugin's host half (`main.js`, used by Claude sessions) are restricted to the agent views `tree`, `page`, `find`, `graph`, `checks`, `health` (+ detail), `history` and `version` (`src/plugins/knowledge.rs:21-33`; denial tests at `:132-139`). Those denials apply to the **host half only**. The client reads every route above. Separately, encoded traversal (`%2e%2e`, `..%2f`) must be rejected everywhere.

### 3.2 Actions — `ctx.knowledge.send({cmd, …})`

- **Engine actions (37)** (`knowledge/api.rs:477-665`):
  - Vaults and pages: `kn_add`, `kn_new`, `kn_set`, `kn_remove`, `kn_reread`, `kn_preview`, `kn_save_page`, `kn_new_page`, `kn_restore`, `kn_index_add`
  - Calls, minutes and twin: `kn_save_minutes`, `kn_call_choice`, `kn_twin`, `kn_past`
  - Sources: `kn_import_plugin`, `kn_pick_files`, `kn_source_add`, `kn_source_skip`, `kn_baseline`
  - Ingest: `kn_ingest_run`, `kn_ingest_stop`, `kn_change` (approve, reject, edit or take), `kn_ingest_apply`, `kn_ingest_discard`, `kn_ingest_requeue`, `kn_ingest_skill`
  - Health: `kn_fix`, `kn_fix_all`, `kn_ignore`, `kn_lint`, `kn_lint_stop`
  - Ask: `kn_chat_send`, `kn_chat_permit`, `kn_chat_stop`, `kn_chat_terminal`
  - Other: `kn_test`, `kn_nope`
- **Window-level actions** in `src/window/knowledge.rs:43-60`: `kn_pick` (Add vault), `kn_reveal`, `kn_obsidian` and `kn_drops`, used at `view.js:147, 1710, 3220-3221`. **Without them, Add vault does not work.**
- **Bridge allowlist:** `send` accepts only `kn_*`, `open_url` and `sign_in`. Raw `pty_input` is blocked (`34-plugin-knowledge.js:16,36`).

### 3.3 Client context the plugin uses

- **`ctx.knowledge.*`:** `register`, `read`, `send`, `terminal` (8 uses), `context` (6), `tabs`, `profiles`, `closeCallMenu`, `refreshCall`.
- **Other `ctx` calls:** `ctx.listen`, `ctx.listenWindow`, `ctx.onUnload`, `ctx.where`, `ctx.go`, `ctx.render`, `ctx.command` (host half).
- **UI helpers:** `ctx.ui.stylesheet`, `setRow`, `setCard`, `notice`, `ICON`.
- **Settings:** `ctx.settings.section` and `ctx.settings.add`.
- **Graph:** drawn on its own canvas. It does not use `ctx.ui.graph`.
- **The view object** that `register` receives exposes `view`, `route`, `load`, `active`, `after`, `tick`, `overlay`, `callChip`, `callMenuItems`, `countdownLine`, `paletteActions`, `askView`, `feedQueued`, `dropped` and `syncDrops` (`view.js:3564`). Echo's `Kn` shim (`ui/knowledge.js:27-61`, owner-authored) drives it and reads Echo's global `S` state (`34-plugin-knowledge.js:22-30`).
- **Styling:** `knowledge.css` uses 467 Echo CSS variables (`--line`, `--text*`, `--accent*`, `--bg`, `--surface`, `--warn`, `--danger`, `--mono`, `--me`, `--spk2-4`, `--r-panel`, …) and the classes `.btn`, `.set-*`, `.icon-btn`, `.seg`, `.menu-item`. Connect's `echo-compat.css` (Milestone 2, Task 23) maps the common ones; Knowledge will need the full set.

## 4. Engine couplings to Echo core and proposed Connect replacements

| Echo symbol (count) | Proposed Connect replacement |
|---|---|
| `paths::testenv` (~278 in tests), `paths::write_atomic`, `paths::home`, `calls_dir` | Connect test env helper on `tempfile`; Connect atomic write; Connect data root (Milestone 2 Task 10) |
| `app::FileLock`, `process_alive`, `choose_folder`/`choose_files` | `fs2`; `libc::kill(pid,0)`; `tauri-plugin-dialog` |
| `ai::*` (44): profiles, `fake`, `call_profile_id`, `default_id`, `Settings`, `prepare_claude`, `term_group` | Connect AI profiles and runner (Milestone 2 Tasks 3-5) plus a new **vault session** mode (§5); the runner's `FakeRunner` |
| `config::Config` | Connect settings |
| `graph::account`, `graph::html_to_text`, `conversation_with_files`, `mail_item`, `crate::m365::search` | Connect active connection; Connect HTML→text; Connect mail/chat cache, plus read-only Graph `GET /me/messages?$search=` (`ConsistencyLevel: eventual`) |
| `minutes::page_html` (renders every page's HTML) | re-implement with `pulldown-cmark`; parity pinned by the ported page tests |
| `links::Link::parse`, `ledger::norm`, `recorder::slugify`, `memo::is_memo` | re-implement from behaviour; ported tests pin the output |
| `calls::*`, `recorder`, `minutes`, `notes::HEADLESS`, `meeting::*`, `transcribe_marker`, `watch::agenda` | No calls in Connect: `calls` returns `[]`; `kn_save_minutes`, `kn_call_choice`, `kn_past`, `kn_twin`, `preview`, `sample` and `twin-text` return `unsupported`; agenda comes from the Connect calendar |
| `projects::*` (spaces, clients, membership) | no-op; Connect workspaces are hidden |
| `attention::collect` | Connect Needs-your-reply data |
| `terminal::*` (vault PTY sessions, `kn_chat_terminal`) | **Continue in Terminal**: open Terminal.app with a confined `claude --resume <id>` in the vault folder; no embedded PTY |
| `guard::settings_for` and vault-mode hooks | Connect's own confinement (§5); no hooks ported |
| `grants::folders` | Connect plugin folder grants (Milestone 2 Task 21) |

Echo crate dependencies used by the engine: `pulldown-cmark 0.13`, `regex`, `ureq` (Connect uses `reqwest`), `sha2`, `chrono`, `base64`, `serde_json`, `anyhow`.

## 5. Vault sessions: Claude with tools, confined to the vault

Ask, Curate, Research, Ingest and Health fixes run Claude **with tools**. Follow the owner's own engine rules. Decision D40 is in `ingest.rs:293-297, 440-466` and `terminal.rs:661-663`:

- **Skills:** the vault's skills load only as a **defanged `--plugin-dir` copy** (port `defang.rs`). Never use `--setting-sources project`, because vault files could otherwise bring in hooks, allowed tools, permission modes, `` !`cmd` `` commands or `env` routing (`ANTHROPIC_BASE_URL`).
- **Settings sources:** `--setting-sources user`. A CodeMie profile never gets the project source.
- **Tools:** an explicit `--tools` list per mode, in addition to the allow list:
  - Ask: `Read,Grep,Glob`.
  - Curate and Ingest: Ask's tools plus `Edit,Write`. Ingest works on a scratch copy.
  - Research: Ask's tools plus `WebFetch`, which is never pre-allowed. Every URL is asked for, with the full URL shown.
- **Path rules:** the permission handler canonicalises every path and denies anything outside the vault. Edit and Write are always denied on `.claude/**`, `.mcp.json` and `.echo*`.
- **Other flags:** `--input-format/--output-format stream-json`, `--permission-prompt-tool stdio`, `--resume`, `--strict-mcp-config`, `cwd` = vault.
- **Limit:** at most 3 live conversations. This is a separate limit from Milestone 2's 2 isolated runs, so chats can't starve drafts.
- **Continue in Terminal** uses the same tool and path confinement. The user answers the prompts there.
- **Spike first:** before the port relies on this, verify on synthetic vaults: Ask reads and cites; a Curate edit raises a permission request; `--resume` continues; skills load from the defanged plugin dir; a write to `.claude/settings.json` is denied.

## 6. UI decision still open

Run unchanged in Connect, the plugin shows 79 Echo-specific strings ("Remove from Echo…", "Too large to edit in Echo"). It also shows features Connect won't have soon: Home's "Record a call", Vault settings → Meeting minutes, the "A call or memo" ingest source, and Recall. Options:

1. **Make the plugin host-aware** *(recommended)*. The owner adds a small change so Knowledge reads the host name and hides call and minutes features when the host lacks them. One build then runs in both Echo and Connect.
2. **Connect adapts it.** The frame rewrites the wording and hides elements by selector. The bytes stay identical, but this is brittle across plugin updates.
3. **Accept as is.** Show "not available in Connect yet" messages.

## 7. Existing Echo state and concurrent use

- **Existing state:** Echo keeps the vault list, per-vault settings, the ingest ledger and Ask history under its data folder.
  - Proposed: Connect starts empty, with a user-initiated **Add vaults you use in Echo**. It imports the vault paths, settings and ingest ledgers, so sources aren't ingested twice. Ask history is not imported. Echo profile pins map to Connect's `knowledge` route.
- **Concurrent use:** both apps write into vaults (git commits, `.echo-ingest`).
  - Page saves already detect conflicts (`kn_save_page` with `base`).
  - Ingest and lint should not run in both apps at once. A per-vault lock needs agreement in both apps; otherwise show a warning.

## 8. Plugin-runtime facts Knowledge relies on (from Milestone 2 review)

- In Tauri 2.12.6 a registered custom scheme counts as a local origin. Plugin frames therefore run sandboxed with an opaque origin (`sandbox="allow-scripts"`), and sensitive commands check the caller (Milestone 2 Task 17).
- With an opaque origin, `localStorage` throws. Knowledge keeps drafts there, so the frame needs a `localStorage` shim backed by the plugin store (Milestone 2 Task 23).
- **Proposed Connect commands:**
  - `knowledge_read(path)` and `knowledge_send(msg)` go from the frame to the main window to Rust.
  - The main window enforces the `kn_*`, `open_url` (https only) allowlist and the window-level actions.

## 9. Proposed tasks when Knowledge restarts (after Milestone 2)

1. **Spike:** vault-session flags (§5) on synthetic vaults, gated by the owner's OK for small prompts.
2. **Engine port, read side:** registry, scan, pages, links, frontmatter, git, catalog, checks, diff, detect, activity, evidence, defang, home, health views, all sub-routes in §3.1, and a `KnowledgeHost` trait with Connect and fake implementations. Port `page_tests.rs` and `testdata/`.
3. **Engine port, actions:** every §3.2 action, the window-level actions, jobs and picker polling, sources (files, web, M365 via the Connect cache and `$search`), and `unsupported` sentences for the call actions.
4. **Engine port, AI flows:** chat (Ask, Curate, Research), stream parsing, ingest with per-file approval, lint and health fixes on vault sessions. Port `export_tests.rs` minus calls, and the stream, ingest and lint fixtures.
5. **Client:** `ctx.knowledge` in the frame shim; port of the owner's `ui/knowledge.js` and `34-plugin-knowledge.js`; a sidebar entry; full `echo-compat.css` coverage; the host-half `ctx.knowledge.read` service with agent-view denials.
6. **Qualification:**
   - A Rust fixture dump of route and action responses for a synthetic vault.
   - Browser E2E of all 7 tabs (Home, Pages, Graph, Ask, Ingest, Health, Settings) in both themes, with a check that the plugin tree hash equals the source.
   - A native smoke mode.
   - With the owner's yes, a read-only check on a real vault, then one Ask.

## 10. Test assets already written by the owner

- Engine: `page_tests.rs`, `export_tests.rs`, and `testdata/` (`chat/`, `health/`, `ingest/`, `lint/`, `sources/`, `stream/`, `transcript/`). Plugin bridge tests: `src/plugins/knowledge.rs:95-155`.
- Plugin: `tests/knowledge/knowledge.test.mjs` (1,354 lines, 96 assertions, model and view blocks), manual cases TC-001…004, a feature map, and fixtures (`seed.py`, a fake `curl`).
- Not yet run, according to the plugin's test report (`tests/reports/knowledge-plugin-2026-11-16.md:155-170`, git-ignored):
  - native picker, drag-drop, OS URI dispatch, Obsidian launch;
  - real Claude Curate, Research, Ingest and Health;
  - real Microsoft 365;
  - Windows;
  - release autotests.
- `plugin-api.md:394-395` says the `knowledge.*` slots will change.
