# Knowledge plugin in CodeMie Connect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Echo's Knowledge plugin (`obsidian` 1.0.1 from `onetest-ai/echo-plugins`) installs from Connect's built-in `onetest` marketplace unmodified and does in Connect, in Connect's look, everything it does in Echo.

**Architecture:** Connect implements the Echo 0.10 host members Knowledge calls (approach A of the spec) as plugin services in `src-tauri/src/plugins/services/`, exposed through `host/prelude.js` (host half) and `ui/plugins/frame/shim.js` (client half). Anything that needs the user's trust (a skill install, a typed web address, a terminal, a reveal, dropped files) is asked in Connect's own window and checked again in Rust. Connect's meetings, mail and chats feed the parts that read Echo's calls and mail through an adapter over existing data.

**Tech Stack:** Rust 2021 (Tauri v2, rquickjs 0.14, pulldown-cmark 0.13, sha2, the system `git`), vanilla ES modules in `ui/`, `node:test`, the real-plugin harness `src-tauri/tests/echo_plugins.rs`.

**Spec:** `docs/superpowers/specs/2026-11-18-knowledge-plugin-in-connect-design.md` (read with the git-ignored contract notes `docs/superpowers/tasks/knowledge-echo-host-contract.md` and the plugin's own `tests/helpers/fake-ctx.mjs` / `echo-rules.mjs` in `../echo-plugins`).

## Global Constraints

- No change to Echo or the plugin. Wherever the plugin calls a member without a check, Connect provides that member.
- The host enforces safety: grants, paths, hidden files, network and skill writes are checked in Rust. The frame stays sandboxed. A skill install, a typed web address and a terminal are confirmed in Connect's own window.
- Echo's error texts are part of the contract. Connect's messages must match: `/is there already/`, `/changed since( you read it)?/`, `/not UTF-8/i`, `/hidden/`, `/isn't installed/`, `/isn't connected/`, `/may reach only/`, `/the run's key is busy/`.
- Licensing: Echo is AGPL-3.0. Connect's services are written from the contract and the plugin's test fakes, never from Echo source. The plugin is downloaded and run, never vendored into this repo.
- Left `undefined` in `ctx`: `agent`, `sessions`, `view`, `threads`, `clients` (the plugin guards each).
- Every task ends with `cargo fmt`, `cargo clippy -D warnings`, `cargo test` (with `CONNECT_ECHO_PLUGINS_DIR` set), `npm test` and a check in the running app; each task grows `src-tauri/tests/echo_plugins.rs` by the flow it makes work.
- Branch `feat/knowledge-plugin-in-connect`, cut from `workspace-app`; Conventional Commit subjects (`.ai-run/guides/standards/git-workflow.md`).
- Response shapes the UI reads change → regenerate contract fixtures (`UPDATE_CONTRACT_FIXTURES=1 cargo test contract_fixtures`) and commit them.

## Assumptions and deviations (recorded here, decided without the owner)

- **`ECHO_COMPAT` is `0.10.0` from Task 1.** The spec sets it to `0.9.9` until Phase 4, but Knowledge 1.0.1 says `"echo": ">=0.10.0"`, so `0.9.9` would refuse it and Task 1's "Knowledge installs" could never be met. The branch merges whole, so the gate states the API the merged branch provides. Task 5 keeps the spec's check that `echo >=0.10.0` is met.
- **`store.write {ifSha, createNew}` moves into Task 1** (spec: Task 2), because `store.update`, which Knowledge calls on load, is built on it.
- **The image route is the path the plugin writes** (`/plugin/<id>/folder/<root>/<rel>`, resolved against the frame's own origin), not `__host/plugin/…`: Task 2 confirms the exact prefix from `main.js` before writing the route.

## Review Focus

- A vault with thousands of notes: the 2 s `rev` poll (`fs.walk {sha}`) and `fs.search` must stay off the plugin's thread and inside their caps (20k/100k files, 200/1000 hits, 4 MB per file), so the window never stalls. Task 2 tests the caps.
- A note that isn't UTF-8 (a Latin-1 export) or a 70 MB attachment: `fs.read {strict}` refuses with `not UTF-8: <path>`, `walk {sha}` skips the sha above 64 MB but still lists the file. Task 2 tests both.
- Two writers on one page (the user in Obsidian, Knowledge saving): `fs.write {ifSha}` must refuse with `changed since you read it` and leave the file as the other writer left it. Task 3 tests it.
- A vault folder carrying its own `.claude/settings.json` that redirects Claude (`env`, `apiKeyHelper`, hooks): a folder run is refused before Claude starts. Task 4 tests it.
- A plugin frame that isn't on screen asking for a terminal, a skill, a reveal or a drop: refused in the window, never reaching Rust. Task 3 and Task 5 test it in `plugin-bridge.test.mjs`.

## File structure

| File | Responsibility | Tasks |
|---|---|---|
| `src-tauri/src/plugins/capabilities.rs` | sheet lines for `skills`, `m365`, `network.ask`, `echo.read` `calls/me/recording`, events Connect lacks | 1, 4, 6 |
| `src-tauri/src/plugins/manifest.rs` | `ECHO_COMPAT`, `Manifest.echo`, the "Needs a newer Connect" refusal | 1 |
| `src-tauri/src/plugins/host/prelude.js` | the host half's `ctx`: `crypto`, `store.update/walk`, `fs.stat/search/append/copyIn`, `git`, `web`, `http.askAddress`, `claude.stop`, `markdown.links`, `system.pickFiles`, `m365` | 1–6 |
| `src-tauri/src/plugins/services/mod.rs` | routes each new service, `Outside` stand-ins (file picker, address asker) | 1–6 |
| `src-tauri/src/plugins/services/store.rs` | `store.write {ifSha, createNew}`, `store.walk` | 1, 2 |
| `src-tauri/src/plugins/services/fs.rs` | `fs.stat`, `fs.read {strict}`, `fs.walk {sha}`, `fs.search`, `fs.write {ifSha, createNew}`, the hidden allowlist, `fs.append` | 2, 3 |
| `src-tauri/src/plugins/services/hidden.rs` (new) | `hidden_ok`, `in_skills`, `skill_md_problem` (Echo's rules, from `echo-rules.mjs`) | 3, 5 |
| `src-tauri/src/plugins/services/files.rs` (new) | one-hour, plugin-owned file handles; `system.pickFiles`; `fs.copyIn`; dropped files | 3 |
| `src-tauri/src/plugins/services/vault_git.rs` (new) | `ctx.git.info/status/log/show/commit/init` over the system git, hardened | 3 |
| `src-tauri/src/plugins/services/markdown.rs` | `markdown(md, {breaks, links, images})`, `markdown.links(md, {detail})` | 2 |
| `src-tauri/src/plugins/protocol.rs` | the image route `plugin/<id>/folder/<root>/<rel>` | 2 |
| `src-tauri/src/plugins/services/claude.rs` + `snapshot.rs` (new) | folder runs (`read`, `edit`, `copy`), snapshots, `key`, `stop` | 4 |
| `src-tauri/src/ai/command.rs`, `ai/runner.rs`, `workspace/plugin_data.rs` | a `RunSpec` that can run in a folder with read or edit tools | 4 |
| `src-tauri/src/plugins/services/web.rs` (new) | `web.read`, `http.askAddress` admission | 5 |
| `src-tauri/src/plugins/services/skills.rs` (new) | `~/.claude/skills/<name>/SKILL.md` install/remove with an ownership record | 5 |
| `src-tauri/src/plugins/services/echo_read.rs`, `events.rs`, `m365.rs` (new) | `calls`, `me`, `recording`, `source call:<folder>`, dictionary from the glossary, `minutes_written`/`transcribed`, `m365.*` | 1, 6 |
| `src-tauri/src/plugins/commands.rs` | window-only requests: `file_handles`, `reveal`, `claude_session`, `skill_check/install/remove`, `address_answer` | 3–5 |
| `ui/plugins/frame/shim.js`, `messages.js` | `slots`, `onFileDrop`, `ui.sheet`, hash mirroring, `data-theme`, `editing()`, `go {replace}`, `system.reveal`, `claude.session/installSkill/removeSkill` | 1, 3, 4, 5, 6 |
| `ui/plugins/host.js` | the window's side of those messages, only for the frame on screen | 1, 3, 4, 5, 6 |
| `ui/plugins/frame/echo-compat.css`, `skins/obsidian.css` (new) | layers 1–2 and the Knowledge skin | 1, 7 |
| `ui/workspace/app.js`, `view-meetings.js`, `meetings-controller.js` | drop events, the address/skill prompts, the Meetings page's Knowledge items | 3, 5, 6 |
| `src-tauri/tests/echo_plugins.rs` | the published plugins in the real host, the Knowledge flow | 1–8 |

---

### Task 1: Knowledge installs and loads (Phase 1)

**Files:**
- Modify: `src-tauri/src/plugins/capabilities.rs`, `src-tauri/src/plugins/manifest.rs`, `src-tauri/src/plugins/install.rs` (refusal text), `src-tauri/src/plugins/services/{mod.rs,store.rs,echo_read.rs,events.rs}`, `src-tauri/src/plugins/host/prelude.js`
- Modify: `ui/plugins/frame/{shim.js,messages.js,echo-compat.css}`, `ui/plugins/host.js`, `ui/workspace/app.js` (`go` with `replace`)
- Test: inline Rust tests in each file above, `ui/test/plugin-bridge.test.mjs`, `src-tauri/tests/echo_plugins.rs`

**Interfaces:**
- Produces: `pub const ECHO_COMPAT: &str = "0.10.0"` and `ManifestError::NeedsNewerConnect { needs: String }` (`"it needs Echo {needs}: a newer Connect"`), `Manifest.echo: Option<VersionReq>`.
- Produces: sync service `crypto.sha256(text) -> hex`; `store.write(path, text, {ifSha?: string|null, createNew?: bool})` with Echo's texts `“p” changed since you read it: read it again` and `“p” is there already`; prelude `store.update(path, fn)` (50 tries, `“p” kept changing while it was updated`).
- Produces: `echo.read('calls') -> []`, `echo.read('me') -> {name, email}` (Microsoft profile, `null`s when signed out), `echo.read('recording') -> {state: 'idle', call: null, stamp: null}`.
- Produces (frame): `ctx.slots.add(slot, item)` for `call.header | call.menu | call.minutes | thread.profile | client.profile` (else throws `CodeMie Connect has no slot “x”`), `ctx.slots.list() -> []`, `ctx.onFileDrop(fn)`, `ctx.ui.sheet(html, {label, onClose}) -> HTMLElement`, `ctx.ui.closeSheet()`, `ctx.go(hash, {replace})`; message `event {type: 'go', hash, replace}`.

- [ ] **Step 1: Spike.** Make Knowledge installable with only the catalog keys (`skills`, `m365`) and run the published client in a frame with stubs (the native marketplace smoke `CODEMIE_PLUGIN_SMOKE=<echo-plugins>` on a temp data root, and a Chromium page that loads `client.js` through the real shim). List what breaks: hash routing in the opaque-origin frame, `import()` with `?v=`, the canvas graph, the `localStorage` stand-in. Append the list under "Spike findings" below and fold each item into Steps 2–7.
- [ ] **Step 2: Sheet and gate tests (fail first).** `capabilities::tests::knowledge_sheet_is_honest`: a manifest with Knowledge's `uses` gives lines `skills` (Supported, "Add a skill to your own Claude Code, only when you click and confirm"), `m365` (Partial), `network` text ending "and fetch one web page from an address you type in Connect's box", `echo` naming "your name and email address", events naming `recording_started, recording_stopped, transcribed` as things Connect doesn't have, `sessions` Unsupported; `"skills": true` is accepted, `"skills": "yes"` is `BadValue`. `manifest::tests::echo_range_above_connect_needs_a_newer_connect`: `"echo": ">=0.11.0"` → `NeedsNewerConnect`, `">=0.10.0"` and no `echo` pass, nonsense in `echo` is ignored (as today).
- [ ] **Step 3: Implement** the catalog entries, `describe` arms and the gate; the offer/listing shows "Needs a newer Connect" for `NeedsNewerConnect`. Run `cargo test -p app capabilities manifest install` → PASS.
- [ ] **Step 4: Host tests (fail first).** `store::tests::store_write_compares_and_creates_with_echos_words` (ifSha of another text → `changed since you read it`; `createNew` over a file → `is there already`; `ifSha: null` = createNew; right sha writes). `mod::tests::crypto_sha256_is_the_hex_of_the_utf8_text` (`"abc"` → `ba7816bf…15ad`). `echo_read::tests::calls_me_and_recording`. A host test that runs a tiny `main.js` calling `ctx.store.update` twice (a function returning the same text writes nothing).
- [ ] **Step 5: Implement** `crypto.sha256`, the CAS write under one services lock, `store.update` in the prelude, the three `echo.read` kinds, and `listen` granting the events Knowledge names (never sent yet). Run the module tests → PASS.
- [ ] **Step 6: Frame tests (fail first)** in `plugin-bridge.test.mjs`: `slots.add` accepts Echo's names and throws on `nope`; `onFileDrop` registers; `ui.sheet` returns a box, Esc and backdrop close it and call `onClose` once, `closeSheet` doesn't call it; a `show` of `{activity: 'knowledge', route: 'v/pages/a.md'}` sets the frame's hash to `#obsidian:knowledge/v/pages/a.md` before `render()` runs; an in-frame `hashchange` to `#obsidian:knowledge/v/graph` posts `go` with that hash; `go(h, {replace: true})` reaches `onGo(hash, id, {replace: true})`; `theme` sets `data-theme`; an activity whose `editing()` is true is not patched; an activity's `badge()` reaches the contribution.
- [ ] **Step 7: Implement** the shim members, the message fields (`go.replace`, activity `badge`), the window's `goHash(hash, {replace})`, layers 1–2 in `echo-compat.css` (tokens `--spk2..4`, `--sidebar`; classes `set-foot`, `set-nav`, `tag` `acc/ok/warn`, `seg`, `tab`/`tabs`, `menu`/`menu-item`/`menu-sep`, `icon-btn`, `selectable`, `grow`, `btn.sm`, `a.md-missing`), and full-bleed `body[data-view=activity] .cx-main`. `npm test` → PASS.
- [ ] **Step 8: Real plugin.** In `echo_plugins.rs` replace `knowledge_is_blocked_…` and `knowledge_is_refused_at_install…` with `knowledge_installs_with_an_honest_sheet` (no Blocking line; `skills`, `m365`, `sessions` lines as above) and update `obsidian_walks_fixture_vault…` to 1.0.1's commands (`add`, `view`, `kn`) with no load problem and no "not available in CodeMie Connect" log line. `CONNECT_ECHO_PLUGINS_DIR=… cargo test --test echo_plugins` → PASS.
- [ ] **Step 9: Gates and app check.** `cargo fmt`, `cargo clippy --all-targets -- -D warnings`, `cargo test`, `npm test`; the marketplace smoke reports Knowledge installed, its page opened and no frame error. Commit `feat: Knowledge installs from the marketplace and its page loads in Connect`.

**Spike findings** (Chromium, the real `client.js` through Connect's real `host.js` and shim, backed first by stubs and then by the real `main.js` over the plugin's own `fake-ctx.mjs` on a made-up twin vault):

1. `apply` rejects at `ctx.onFileDrop is not a function` after the activity is registered; with `onFileDrop`, `slots` and `ui.sheet` stubbed nothing else breaks: the client is ready, adds its Settings section, its card and nine palette entries. → Step 7.
2. `import()` of `view.js`, `model.js`, `rows.js` and `seam.js` with the `?v=` query works under the frame's CSP. The `localStorage` stand-in works (the chosen vault is remembered). Nothing to change.
3. Fragment navigation works inside the sandboxed, opaque-origin frame, and the plugin reads `location.hash` in `render()`. But Connect never sets the frame's hash, so every tab click (`ctx.go('#obsidian:knowledge/<vault>/<tab>')`) moves the window and the frame keeps drawing Home. An in-frame `hashchange` doesn't redraw. → Step 7: set the hash on `show`, redraw and report a `hashchange` as `go`.
4. The canvas graph draws, but into a box with no height: `.kn` is `height: 100%` and the frame's `.cx-main` has padding and no height. The legend and zoom buttons land over the header. → Step 7: full-bleed layout for an activity that draws its own rail and header.
5. The graph reads its colours when `data-theme` changes on `<html>`; Connect never sets it. → Step 7.
6. Echo's `tabs`/`tab`, `seg`, `menu`/`menu-item`/`menu-sep`, `icon-btn`, `tag` and `btn.sm` show as browser defaults. → Step 7 (layer 2).
7. `ctx.go(hash, {replace})` loses `replace` on the way to the window. → Step 7.

### Task 2: Read side (Phase 2)

**Files:**
- Modify: `src-tauri/src/plugins/services/{fs.rs,store.rs,markdown.rs,mod.rs}`, `src-tauri/src/plugins/protocol.rs`, `src-tauri/src/plugins/host/prelude.js`
- Test: inline tests, `src-tauri/tests/echo_plugins.rs`

**Interfaces:**
- Produces: `fs.stat(root, path, {sha}) -> {kind: 'file'|'dir'|'link'|'other', size, mtime (s), real: string|null, sha?} | null`; `fs.read(root, path, max | {max, strict})` (`not UTF-8: <path>`); `fs.readMany(root, paths, max | {max, strict})`; `fs.walk(root, {path, ext, hidden, max, sha})` (sha only for files ≤ 64 MB); async `fs.search(root, q, {path, ext, hidden, max, caseSensitive}) -> [{path, line, text}]` (literal, 1–1000 chars, 200 default, 1000 max, 4 MB per file, text cut at 300 chars, `ctx.fs.search looks for 1 to 1,000 characters`).
- Produces: async `store.walk(path, {ext, hidden, max, sha}) -> [{path, size, mtime, sha?}]` (paths relative to the store).
- Produces: `markdown(md, {breaks, links, images}) -> html` and `markdown.links(md, {detail}) -> {links, images, entries?: [{dest, kind: 'wiki'|'md', embed}]}` — the rules of `fake-ctx.mjs` `markdownOf` (`allowed`): links only `https://<host>`, `echo://<kind>/<id>`, `#<pluginId>:…`; images only `[/]plugin/<pluginId>/folder/<rest>` with no `.`/`..` segment or `?#`; a `null` map entry → `data-md-missing`. Rendering uses pulldown-cmark events with Connect's own escaping HTML writer (wiki links on); no raw HTML passes.
- Produces: protocol route `plugin/<id>/folder/<root>/<rel>` serving png/jpg/jpeg/gif/webp ≤ 10 MB from a root granted to `<id>`, only on `<id>`'s own origin.

- [ ] **Step 1: Failing tests.** `fs::tests::stat_search_strict_and_sha` (stat of a file/dir/link/missing, `real` of a link inside the root, sha matches `sha2`; strict read of Latin-1 → `not UTF-8: notes/latin.md`; a cut multi-byte character at `max` is dropped, not refused; walk `{sha: true}` gives sha ≤ 64 MB and none above; search finds `Atlas` case-insensitively with line numbers, honours `max` and `ext`, refuses `""`). `store::tests::store_walk_lists_with_shas`. `markdown::tests::wiki_links_images_and_refused_hrefs` (`[[Ann Lee]]` with `links: {"Ann Lee": "#obsidian:knowledge/v/pages/People%2FAnn%20Lee.md"}` → that `<a href>`; `null` → `<a class="md-missing" data-md-missing="Ann Lee" …>`; `javascript:` and `http:` → text; `![[a.png]]` → `<img src="/plugin/obsidian/folder/…">` only for that prefix; `<script>` stays text) and `links_detail_entries`. `protocol::tests::image_route_serves_granted_folders_only` (another plugin's id, an ungranted root, `..`, a `.txt`, an 11 MB png → 404).
- [ ] **Step 2: Implement** the members above; `fs.search` and `walk {sha}` run in `spawn_blocking`. Module tests → PASS.
- [ ] **Step 3: Real plugin.** Grow the Knowledge test: `add` a fixture vault (with an image and an Obsidian `.obsidian/`) → `kn` → `tree` → `page` (HTML has the wiki link and the image route) → `graph` → `health` (deterministic findings, no Claude run) → `find`. PASS with `CONNECT_ECHO_PLUGINS_DIR`.
- [ ] **Step 4: Gates and app check** (connect a folder and an Obsidian vault in the running app; Home, Pages with images and links, Graph, Health and find work). Commit `feat: Knowledge reads vaults in Connect (stat, search, strict reads, Markdown with wiki links, vault images)`.

### Task 3: Write side and history (Phase 3)

**Files:**
- Create: `src-tauri/src/plugins/services/{hidden.rs,files.rs,vault_git.rs}`
- Modify: `fs.rs`, `mod.rs` (`Outside.files: Arc<dyn FilePicker>`), `prelude.js`, `commands.rs` (`file_handles`, `reveal`), `src-tauri/src/testing.rs` (a file picker stand-in), `ui/plugins/frame/{shim.js,messages.js}`, `ui/plugins/host.js`, `ui/workspace/app.js` (Tauri `drag-drop` while a plugin page shows)
- Test: inline tests, `ui/test/plugin-bridge.test.mjs`, `src-tauri/tests/echo_plugins.rs`

**Interfaces:**
- Produces: `hidden::hidden_ok(rel: &str, folder: bool) -> bool`, `hidden::in_skills(rel) -> bool`, `hidden::skill_md_problem(md) -> Option<String>` (Echo's words, as `echo-rules.mjs`).
- Produces: `fs.write(root, path, text, {ifSha, createNew})` (atomic; refusal text for hidden contains `hidden`: `“p” is hidden: a plugin changes notes, not other programs' files`), `fs.append(root, path, text)` (newline added, ≤ 1 MB, `O_NOFOLLOW`, never in skills).
- Produces: `files::Handles` — `make(plugin, path) -> {file, name, size}` (ids `h<random>`, one hour, owned by the plugin), `path_of(plugin, file) -> Result<PathBuf>`; `system.pickFiles(prompt, {multiple, ext}) -> [{file, name, size}]`; `fs.copyIn(file|handle, root, path, {createNew = true}) -> {path, size}` (≤ 50 MB, never into `.claude/skills`, `that file isn't there (handed to another plugin, or over an hour ago)`).
- Produces: `git.info(root) -> {repo:false} | {repo, branch, head, detached, busy, subfolder}`, `git.status(root, {paths}) -> [{path, code, from?}]`, `git.log(root, {path, max}) -> [{rev, author, email, date, subject, echo, path?}]`, `git.show(root, rev, path, {max, strict}) -> {text, size, truncated} | null`, `git.commit(root, {paths, message}) -> {rev}`, `git.init(root, {branch}) -> info`. System git with `GIT_TERMINAL_PROMPT=0`, no pager, hooks, fsmonitor, signing or credential helpers, 20 s; author = the user's `user.name`/`user.email`, committer `CodeMie Connect (<id>) <<id>@plugins.connect.invalid>`; `echo` = the plugin id when the committer is ours (or Echo's `@plugins.echo.invalid`). Missing git → `git isn't installed`.
- Produces (window-only, `plugins_request`): `file_handles {id, paths} -> [{file, name, size}]`, `reveal {id, root, path}`. Frame: `ctx.system.reveal(root, path)`; drops reach only the frame on screen.

- [ ] **Step 1: Failing tests.** `hidden::tests::echos_hidden_rules` (`.gitignore`, `.obsidian/app.json`, `a/.obsidian/x.json` yes; `.obsidian/community-plugins.json`, `.obsidian/plugins/x/main.js`, `.git/config`, `.claude/skills/My Skill/SKILL.md` no) and `skill_md_problem` cases from `echo-rules.mjs`. `fs::tests::write_if_sha_create_new_and_hidden_allowlist` (conflict leaves the other writer's text). `files::tests::handles_belong_to_one_plugin_and_expire`. `files::tests::copy_in_refuses_over_a_file_and_into_skills`. `vault_git::tests::init_commit_log_show_status` in a temp repo with a fixed `HOME`, and `missing_git_says_isnt_installed`. `commands::tests::reveal_checks_the_grant`. JS: a drop while the frame isn't on screen sends nothing; on screen it delivers handles without paths.
- [ ] **Step 2: Implement.** Module tests and `npm test` → PASS.
- [ ] **Step 3: Real plugin.** Grow the Knowledge test: `save_page` → `save_page` with a stale sha (`changed_since`) → `history` → `version` → `restore` → `new_page` → `fix` / `fix_all`; `new_vault` (twin preset) makes a git repo with `.gitignore`, `.obsidian/*.json` and `.claude/skills/<n>/SKILL.md`; `pick_files` + `source_add` lists the picked file in Ingest's sources. PASS.
- [ ] **Step 4: Gates and app check** (edit, conflict, restore, create, fix in the app; twin preset; drop a file on the page). Commit `feat: Knowledge edits vaults with git history, picked and dropped files`.

### Task 4: Claude in a vault (Phase 4)

**Files:**
- Create: `src-tauri/src/plugins/services/snapshot.rs`
- Modify: `src-tauri/src/ai/{command.rs,runner.rs}`, `src-tauri/src/workspace/plugin_data.rs`, `services/claude.rs`, `prelude.js`, `capabilities.rs` (`claude` line), `commands.rs` (`claude_session`), `ui/plugins/frame/shim.js`, `ui/plugins/host.js`
- Test: inline tests, `src-tauri/tests/echo_plugins.rs`

**Interfaces:**
- Produces: `RunSpec.folder: Option<FolderRun>` with `FolderRun { dir: PathBuf, edit: bool }`; `build_command` for a folder run: cwd = `dir`, `--tools Read,Grep,Glob,Skill` (+`Edit,Write` when `edit`), `--permission-mode dontAsk` (`acceptEdits` when `edit`), `--setting-sources user,project`, `--strict-mcp-config`, `--no-session-persistence`; no `--disable-slash-commands` (the vault's skills load).
- Produces: `claude.run({…, folder, mode: 'read'|'edit'|'copy', exclude, key, timeout})` → `{answer, model, usage: {input_tokens, output_tokens, cost_usd}, actions, snapshot?: {path, files, bytes, skipped, why: {large, unreadable}}}`; timeout 1–60 min; `edit` needs `folders.write`; one live run per key (case-insensitive) else `the run's key is busy: a run with key “k” is running already`; `claude.stop(key) -> bool`, the stopped run fails `stopped`; a folder whose `.claude/settings*.json` sets `env`, `apiKeyHelper`, `awsAuthRefresh`, `awsCredentialExport`, `hooks` or `statusLine` is refused.
- Produces: `snapshot::take(store, root, exclude) -> Snapshot` into `<store>/cache/snapshots/<hex16>/` (dot files kept, no `.git`, no `.obsidian/plugins`, no links, at most 3 per plugin: `this plugin keeps 3 snapshots already: remove one (ctx.store.remove) first`); removed when the run fails.
- Produces (window-only): `claude_session {id, folder, mode, profile}` → opens the active profile's Claude Code in Terminal.app in the vault through `open_agent_in_terminal`.

- [ ] **Step 1: Failing tests.** `command::tests::folder_runs_read_and_edit`; `claude::tests::read_run_uses_the_vault_and_read_tools`, `copy_run_snapshots_and_removes_it_on_failure`, `keys_are_one_at_a_time_and_stop_stops`, `edit_needs_folders_write`, `redirecting_settings_are_refused`, `timeout_is_one_to_sixty_minutes`; `snapshot::tests::leaves_out_git_plugins_links_and_excluded`; `commands::tests::claude_session_checks_grants`.
- [ ] **Step 2: Implement.** Tests → PASS.
- [ ] **Step 3: Real plugin.** Grow the Knowledge test: `analyse` writes the description (tool-free); `lint_run` (AI checks) runs in the vault with read tools and its findings show in `health`; `ingest_run` of a file runs in a snapshot (the fake runner edits a page in its cwd), `ingest_changes` lists the change, `ingest_apply` writes it through `fs.write`. PASS.
- [ ] **Step 4: Gates and app check** (description, AI checks, an ingest proposal applied, "Ask the vault" opens Terminal). Commit `feat: Claude reads and edits Knowledge vaults through snapshots and keyed runs`.

### Task 5: Web and skills (Phase 4)

**Files:**
- Create: `src-tauri/src/plugins/services/{web.rs,skills.rs}`
- Modify: `services/{http.rs,mod.rs}` (`Outside.asker: Arc<dyn AddressAsker>`), `prelude.js`, `commands.rs` (`address_answer`, `skill_check`, `skill_install`, `skill_remove`), `src-tauri/src/lib.rs` (the app's asker emits `plugins:ask-address`), `ui/plugins/frame/shim.js`, `ui/plugins/host.js`, `ui/workspace/app.js` (the address box and the skill confirmation), `Cargo.toml` (an HTML parser, chosen in Step 2)
- Test: inline tests, `ui/test/plugin-bridge.test.mjs`, `src-tauri/tests/echo_plugins.rs`

**Interfaces:**
- Produces: `http.askAddress() -> string | null` (Connect's dialog "<name> asks for the address of a web page to fetch once. Type or paste it:"; http(s), no `@`, ≤ 2000 chars; one GET within 10 minutes); admission refusal contains `may reach only`.
- Produces: `web.read(url, {max, timeout, images: 'save'}) -> {url, title, markdown, links, images, lang, byline, published, description, source, needs_js, truncated, bytes}`; 5 MB, 30 s, no redirects, HTML only; images ≤ 50 × 10 MB, 50 MB in all, saved under `<store>/cache/web/`.
- Produces: `claude.installSkill(name, md)` / `removeSkill(name)` (client, `uses.skills`): the window shows the skill's name and description and asks; Rust writes `~/.claude/skills/<name>/SKILL.md` (256 KB, `skill_md_problem`, never over a skill it didn't add; ownership in `<data>/plugins/data/<id>/skills.json`).

- [ ] **Step 1: Failing tests.** `web::tests::reads_a_listed_site_and_refuses_others` (`may reach only`), `asked_address_is_good_once_for_ten_minutes`, `html_becomes_markdown_with_title_links_and_images`, `redirects_and_non_html_are_refused`; `skills::tests::install_writes_and_remove_takes_only_its_own`, `refuses_commands_and_unknown_frontmatter`; JS: a skill or address request from a frame not on screen is dropped.
- [ ] **Step 2: Implement** (add the HTML parser crate with `cargo add`, commit `Cargo.lock`). Tests → PASS.
- [ ] **Step 3: Real plugin.** Grow the Knowledge test: a web page (the test HTTP client answers it) ingested proposes a change; `manifest` check that `echo >=0.10.0` is met by `ECHO_COMPAT`. PASS.
- [ ] **Step 4: Gates and app check** (ingest a web page through the address box; the twin skill installs globally after confirming and removes cleanly). Commit `feat: Knowledge reads web pages and installs its twin skill after you confirm`.

### Task 6: Connect's meetings and mail into Knowledge (Phase 5)

**Files:**
- Create: `src-tauri/src/plugins/services/m365.rs`
- Modify: `services/{echo_read.rs,events.rs,mod.rs}`, `prelude.js`, `capabilities.rs` (`m365` Supported; events `minutes_written`, `transcribed` sent), the meetings code that saves a transcript and writes a main document (an event hook only), `ui/plugins/frame/shim.js` (`slots.list`, a slot render request), `ui/plugins/host.js`, `ui/workspace/{view-meetings.js,meetings-controller.js,app.js}`
- Test: inline tests, `ui/test/meetings-*.test.mjs`, `ui/test/plugin-bridge.test.mjs`, `src-tauri/tests/echo_plugins.rs`

**Interfaces:**
- Produces: `echo.read('calls', {q, since, until, limit ≤ 500})` from meetings with a saved folder: `{id: 'call:<folder>', stamp: <folder>, title, date, started_at, ended_at, duration_min, app: 'teams', memo: null, minutes, transcript, chat: false, people, participants, threads: [], client: null, profile: null}`; `echo.read('source', 'call:<folder>', {transcript})` → `{…, text: <main notes>, minutes: {summary, decisions, actions, questions, revision, body}, transcript?}` or `<title>: no minutes yet`; `echo.read('dictionary')` from the glossary parser.
- Produces: events `minutes_written` (`revision` = first 16 hex of the document's sha256, `rewritten`) and `transcribed` (`ok: true`).
- Produces: `m365.search(q, {kinds, days, limit})`, `m365.mailThread(id)`, `m365.chat(id, {since, until})` from synced records; signed out → `Microsoft 365 isn't connected: sign in to Microsoft in Settings`.
- Produces (window): while a meeting is open `ctx.where().view === 'calls'`; `call.menu` items as text in the meeting's ⋯ menu, `call.header` as a text chip, `call.minutes` as a line while notes run; the save sheet as the plugin's frame in a modal; `echo://call/<folder>` opens that meeting.

- [ ] **Step 1: Failing tests** for each read, both events, `m365.*` signed in and out, and the Meetings page items (model/controller tests over fakes).
- [ ] **Step 2: Implement.** Tests → PASS.
- [ ] **Step 3: Real plugin.** Grow the Knowledge test: a meeting folder in the test core → `past_minutes` / `sample` list it; `save_minutes` saves its minutes into the vault; a `minutes_written` event routes a new meeting's notes. PASS.
- [ ] **Step 4: Gates and app check.** Commit `feat: Connect's meetings, mail and chats feed Knowledge`.

### Task 7: The Knowledge skin (Phase 6)

**Files:**
- Create: `ui/plugins/frame/skins/obsidian.css`, `ui/test/knowledge-skin.test.mjs`
- Modify: `ui/plugins/frame/shim.js` (load the skin after the plugin's stylesheets for `obsidian@1.0.x` only), `src-tauri/src/plugins/protocol.rs` / `bundle` resources if the skin needs listing

**Interfaces:**
- Produces: `skinFor(id, version) -> 'skins/obsidian.css' | null` in `shim.js`.

- [ ] **Step 1: Failing tests.** `knowledge-skin.test.mjs`: every class selector in `skins/obsidian.css` exists in the installed `knowledge.css` (read from `CONNECT_ECHO_PLUGINS_DIR`, skipped with a message when missing); the skin has no `display: none`, `order` or `visibility` rule; `skinFor('obsidian', '1.0.1')` is the skin, `'1.1.0'` and other ids are `null`.
- [ ] **Step 2: Implement** the skin (Connect's type scale, spacing, radii, 8 px dialog over a 50 % scrim, tabs and checkboxes, matching Meetings and Settings) and the loader. `npm test` → PASS.
- [ ] **Step 3: Visual pass** of every Knowledge tab, sheet and empty state in light and dark beside Settings and Meetings in the running app. Commit `feat: a Connect skin for Knowledge`.

### Task 8: Contract tests, the full flow and docs (Phase 6)

**Files:**
- Modify: `src-tauri/tests/echo_plugins.rs`, `src-tauri/src/plugins/services/*` tests, `.ai-run/guides/architecture/architecture.md` (§ "Where Milestone 2 differs from Echo"), `.ai-run/guides/testing/testing-patterns.md`

- [ ] **Step 1: Contract tests**: one per error text the plugin matches (each regex in Global Constraints against Connect's real message), one per shape in `fake-ctx.mjs` (keys and types of each answer).
- [ ] **Step 2: Full flow** in `echo_plugins.rs`: add → kn → tree → page → graph → health → save_page → history → lint → ingest → save_minutes, with `CONNECT_ECHO_PLUGINS_DIR` set.
- [ ] **Step 3: Docs**: the guides describe the new members and that Connect now provides Echo 0.10's plugin API.
- [ ] **Step 4: Gates, a last run of the app, commit** `test: Knowledge's full flow against the published plugin; docs: Echo 0.10 members`.
