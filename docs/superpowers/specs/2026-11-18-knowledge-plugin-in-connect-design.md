# Knowledge plugin in CodeMie Connect: design and implementation plan

| Status | Date | Baseline |
|---|---|---|
| Approved | 2026-11-18 | Connect `workspace-app` `e4cf7d6`; Echo `main` 0.10.0; echo-plugins `main` `1f238c5` (Knowledge = plugin `obsidian` 1.0.1) |

Research notes behind this document:
[knowledge-echo-host-contract.md](../tasks/knowledge-echo-host-contract.md) (what Echo 0.10 gives the plugin, with
file:line evidence). Earlier context: `prototypes/milestone-2/KNOWLEDGE-PLUGIN-FEASIBILITY.md`, `SHARED-HOST-API.md`
and `PLUGIN-ENGINE.md` (local, git-ignored).

## 1. Goal

Install Knowledge from Connect's built-in `onetest` marketplace, as it is published, and have it work in Connect as it
works in Echo: vaults, Home, Pages, Graph, Health with AI checks, Ingest, page edits with git history, the twin
preset, and "Ask the vault". It must look like CodeMie Connect, not like Echo. All of its logic stays in the plugin.

Non-goals: changing Echo or the plugin; Echo's "Claude in Echo" folder session and `echoctl`; Telegram and GitHub
fixes.

Scope decided 2026-11-18: all six phases, including Phase 5. Connect's meetings, transcripts, notes, tasks and glossary
are finished, so Phase 5 is an adapter over them.

## 2. Where things stand

**Knowledge 1.0.1 is now pure plugin code.** The native engine in Echo is gone. `main.js` (7,580 lines, 94 host
commands) holds the vault index, pages, graph, health, ingest and minutes export. `client.js`, `view.js` and
`model.js` (about 4,100 lines) hold the activity. It relies on host services that Echo 0.10.0 added for it: `fs.stat`,
`fs.search`, `fs.copyIn`, `ctx.git`, `ctx.web.read`, Claude runs in a folder or a copy of it, skill install, and more.

**Connect already has an Echo-compatible plugin engine** (Milestone 2, `src-tauri/src/plugins/`, `ui/plugins/`):

- one QuickJS runtime per plugin, 64 MB each, which is more than Echo's 64 MB shared by all plugins;
- the client half in a sandboxed `connect-plugin://` frame;
- `echo-compat.css`, which already draws Echo's tokens in CodeMie's look;
- the built-in `onetest` marketplace (`onetest-ai/echo-plugins`), which is where Knowledge 1.0.1 is published.

It implements engine 1.0, the API as it was at Echo 0.9.9.

**Today Knowledge cannot run in Connect:**

1. **Install is refused.** `uses.skills` and `uses.m365` are keys Connect doesn't know, and an unknown key refuses the
   whole sheet (`capabilities.rs:68-70`).
2. **The client half fails to load.** `client.js` calls `ctx.slots.add` and `ctx.onFileDrop` without a check, so
   `apply` rejects partway and the "What Claude knows" editor never gets its listeners.
3. **Most host commands throw.** They call members Connect lacks without a check. `ctx.crypto.sha256` is used 28
   times (index revision, locks). `ctx.fs.stat` / `fs.search` / `fs.copyIn`, `ctx.markdown(md, opts)` and
   `ctx.markdown.links` break pages. `echo.read('calls')` breaks Past minutes, Sample and call sources.
   `ctx.package` breaks the twin preset and Ingest.
4. **Writes the plugin needs are refused.** Connect writes have no `ifSha` / `createNew`. It refuses every hidden path,
   but the twin preset writes `.gitignore`, `.obsidian/*.json` and `.claude/skills/<name>/SKILL.md`.
5. **Claude runs are tool-free only.** AI checks need read tools in the vault. Ingest needs edit tools in a copy of the
   vault with the vault's own skills (§5.2).

What already works as Echo does: `ctx.command`, `every`, `on`, `log`, `store` read/write/list/remove/path, `settings`,
`package`, `fs.folders/list/read/readMany/walk/write/forget`, `system.pickFolder`, `http.fetch`, `claude.run`
(tool-free), `profiles`, `inbox`, `markdown(md)`, `echo.read` for clients/threads/sources/source/dictionary; and on
the client `call`, `render`, `where`, `go`, `listen`, `listenWindow`, `onUnload`, `activities.add`, `settings`,
`palette`, `ui.*` (except `sheet`/`closeSheet`).

## 3. Constraints

- **No change to Echo or the plugin.** Wherever the plugin calls a member without a check, Connect must provide that
  member.
- **The host enforces safety** (PLUGIN-ENGINE.md rule 4). Grants, paths, hidden files, network and skill writes are
  checked in Rust. The frame stays sandboxed. Anything that needs the user's trust happens in Connect's own window:
  confirming a skill install, typing a web address, opening a terminal.
- **Echo's error texts are part of the contract.** The plugin matches host errors with regexes: `/is there already/`,
  `/changed since( you read it)?/`, `/not UTF-8/i`, `/hidden/`, `/isn't installed/`, `/isn't connected/`,
  `/may reach only/`, `/the run's key is busy/`. Connect's messages must match them.
- **Licensing.** Echo is AGPL-3.0, and the 0.10 host services (`jshost/git.rs`, `folders.rs`, `web.rs`,
  `claude_skills.rs`, `claudejob.rs`) are the Echo maintainer's commits. Connect is Apache-2.0. Connect's services are
  written from the contract (Echo's `plugin-api.md` and the plugin's test fakes `tests/helpers/fake-ctx.mjs`), on
  Connect's own code (`plugins/git.rs`, `services/fs.rs`, `http.rs`, `ai/`). No Echo source is copied. The plugin is
  downloaded and run, never vendored into Connect's repo (echo-plugins has no LICENSE).

## 4. Approaches

| | Approach | Trade-off |
|---|---|---|
| **A (recommended)** | **Host parity for what Knowledge uses.** Connect implements the Echo 0.10 members Knowledge calls, as plugin services. Connect's own data (meetings, Microsoft mail and chats) feeds the parts that use Echo's calls and mail. | The only option that meets "fully workable, unmodified". Every other plugin built for Echo 0.10 gains too. Most of the work is in Rust services. |
| B | **Knowledge Lite.** Only what lets it load and read: stubs, `crypto`, `fs.stat/search`, `markdown`. | Fast. But no Ingest, no AI checks, no edits or history, no twin preset. That is not "fully workable". |
| C | **Native Knowledge page** in Connect that uses the plugin's JS as a library. | Looks the most native. But it forks the plugin's UI and logic, so every plugin release needs porting. That is the opposite of "logic from the plugin". |

**A**, delivered in phases, so the read side is usable after Phase 2.

## 5. Design

### 5.1 Host half: services to add or extend (`src-tauri/src/plugins/services/`, `host/prelude.js`)

| Member | Connect implementation | Reuses |
|---|---|---|
| `crypto.sha256(text)` | sync service, hex | `sha2` (already a dependency) |
| `store.update(path, fn)` | pure JS in the prelude: read, then write with `ifSha`, 50 tries | — |
| `store.write(p, t, {ifSha, createNew})`, `store.walk(path, {ext, hidden, max, sha})` | compare-and-swap under the plugin's lock; Echo's texts `“p” changed since you read it: read it again` and `“p” is there already` | `store.rs` |
| `fs.stat(root, path, {sha})` | `{kind, size, mtime (s), real, sha?}` or null | `fs.rs` resolve |
| `fs.read(…, {max, strict})`, `fs.walk(…, {sha, path})` | 1 MB default, 4 MB max; strict UTF-8 → `not UTF-8: <path>`; sha for files ≤ 64 MB | `fs.rs` |
| `fs.write(…, {ifSha, createNew})` + hidden allowlist | atomic replace; hidden paths refused except `.gitignore`, `.obsidian/*.json` (not plugin switches) and `.claude/skills/<n>/*.md` (frontmatter allowlist, no `` !` `` commands) | `fs.rs` |
| `fs.append`, `fs.copyIn(handle, root, path, {createNew})` | append ≤ 1 MB with O_NOFOLLOW; copyIn ≤ 50 MB from a file handle | new `services/files.rs` |
| `fs.search(root, q, opts)` | literal search, off the plugin thread; 200 hits default, 1000 max, 4 MB per file, lines cut at 300 | `fs.rs` walk |
| `system.pickFiles(prompt, {multiple, ext})` | file dialog; one-hour handles `{file, name, size}` owned by the plugin | `pick_folder` |
| `git.info/status/log/show/commit/init` | the system `git`, hardened (no prompt, pager, hooks or signing; 20 s); allowlisted subcommands; author is the user's identity, committer `CodeMie Connect (<id>)`; writes need `folders.write` | `plugins/git.rs` (marketplaces already run git) |
| `markdown(md, {breaks, links, images})`, `markdown.links(md, {detail})` | pulldown-cmark 0.13 (both apps use it): wiki links and embeds, `data-md-missing`, only `https:`, `#<id>:` and the plugin's image route allowed | `workspace::markdown` |
| `web.read(url, {images: 'save'})` | GET through the existing network admission; HTML → `{title, markdown, links, images…}`; 5 MB, 30 s, no redirects; images into `cache/web` | `http.rs` |
| `http.askAddress()` | Connect's own dialog in the window, not the frame; one plain GET within 10 minutes | new window prompt |
| `claude.run` folder modes, `claude.stop(key)` | §5.2 | `ai/command.rs`, `runner.rs` |
| `echo.read('calls'\|'me'\|'recording')` | `[]` / `{name, email}` from the Microsoft profile / `{state: 'idle'}`; Phase 5 fills `calls` from meetings | `echo_read.rs` |
| `m365.search/mailThread/chat` (Phase 5) | read-only, from Connect's synced mail and chats and its own Graph sign-in; `Microsoft 365 isn't connected: …` when signed out | `workspace/` Graph client |

Left `undefined`, as Connect's engine rule says: `agent`, `sessions`, `view`, `threads`, `clients`. The plugin wraps
each of them in a check or a try. They serve "Claude in Echo", a folder session Connect doesn't have.

### 5.2 Claude in a vault

| Run | Plugin sends | Connect runs |
|---|---|---|
| Description | `{tools: 'none', dir, timeout: 10}` | as today (tool-free) |
| AI checks | `{folder, mode: 'read', profile, key, dir, timeout: 20}` | cwd = the vault; `--tools Read,Grep,Glob,Skill`, `--strict-mcp-config`, `--no-session-persistence`, `--permission-mode dontAsk`, `--setting-sources user,project` |
| Ingest | `{folder, mode: 'copy', exclude, key, …}` | snapshot the vault (dot files included, no `.git`, no `.obsidian/plugins`, no links, `exclude` paths left out) into `<store>/cache/snapshots/<hex>/`, at most 3 per plugin. Run there with `Edit,Write` added and `acceptEdits`; answer `snapshot: {path, files, skipped}`. A failed run removes its copy |

Rules:

- `key`: one live run per key, otherwise `the run's key is busy`. Connect has its own message, written to match the
  plugin's regex.
- `stop(key)` kills the process group, and the run fails with `stopped`.
- `edit` mode needs `folders.write`.
- A folder whose `.claude/settings*.json` could send a CodeMie profile's run elsewhere is refused, as in Echo.
- Timeout is 1–60 minutes.
- Usage reports `cost_usd`, `input_tokens` and `output_tokens`.
- Every run is an `ai_run` record, as today.

The `claude` sheet line changes from "runs without tools" to what Connect now does.

### 5.3 Client half (`ui/plugins/frame/shim.js`, `ui/plugins/host.js`, window)

| Member | Connect behaviour |
|---|---|
| `slots.add(slot, item)`, `slots.list()` | Echo's slot names are accepted. A slot Connect doesn't draw stays registered and is never drawn. `list()` names only the slots Connect draws (none until Phase 5). An unknown name throws, as in Echo |
| `onFileDrop(fn)` | the window takes Tauri's drop event while the plugin's page shows, makes plugin-owned one-hour handles in Rust, and hands the frame `{file, name, size}` (never paths) |
| `ui.sheet(html, {label, onClose})`, `ui.closeSheet()` | a modal inside the frame: scrim, Esc, backdrop click, Tab trapped, `onClose` once. Phase 5 also shows the frame as a modal over a meeting |
| `system.reveal(root, path)` | message → Rust checks the grant → Finder (`open -R`) |
| `claude.session({folder, path, mode, profile})` | message on the user's click → Rust checks `claude` + `folders` (+ `folders.write` for edit). It opens the active AI profile's Claude Code (`claude` or `codemie-claude`) in Terminal.app in the vault, with Echo's tool list, through the existing `open_agent_in_terminal` |
| `claude.installSkill(name, md)` / `removeSkill(name)` | needs `uses.skills`. Connect's window shows the skill's name and description and asks; Rust writes `~/.claude/skills/<name>/SKILL.md` (256 KB, frontmatter allowlist, never over a skill it didn't add, kept in an ownership record) |
| Routes | the plugin reads `location.hash`. On every `show`, the shim sets the frame's own hash to `#obsidian:knowledge/<route>` before drawing. A `hashchange` inside the frame goes back to the window as `go`. `go(hash, {replace})` keeps `replace` |
| Theme | besides `html.light/dark`, the shim sets `data-theme`, which the graph watches |
| Images | the protocol serves `__host/plugin/<id>/folder/<root>/<rel>` (png, jpg, gif, webp ≤ 10 MB) when `<id>` is the frame's own plugin and `<root>` is one of its granted folders |

Trust: the window still never takes a plugin id from a message. Session, skill, reveal and file drops are honoured only
for the frame on screen, and a skill install or removal always asks in Connect's window first.

### 5.4 Manifest and permission sheet (`capabilities.rs`, `manifest.rs`)

- New keys:
  - `skills`: "Add a skill to your own Claude Code, only when you click and confirm".
  - `m365`: Partial until Phase 5, then read-only mail and chats.
- `network.ask`: "Fetch one web page from an address you type in Connect's box".
- `echo.read`: Connect knows `calls`, `me` and `recording`.
- `events`: `recording_*` and `transcribed` are named as not available.
- **Echo version gate.** Connect ignores the manifest's `echo` today. It will instead compare it with a declared
  `ECHO_COMPAT` (`0.10.0` once Phase 4 lands; `0.9.9` until then). A later Knowledge that needs a newer Echo is then
  listed as "Needs a newer Connect" instead of installing and breaking.

### 5.5 Look: Connect's styles, three layers

Knowledge's look comes from three places. Each one is set to CodeMie Connect, and none of it changes the plugin.

| Layer | What it covers | Where it comes from in Connect |
|---|---|---|
| 1. Tokens | every colour, light and dark, plus the fonts. `knowledge.css` takes them all from variables (`--bg`, `--text-*`, `--accent*`, `--line*`, `--mono`…): only 4 × `#fff` and one scrim are hard-coded | `echo-compat.css` defines Echo's token names with Connect's own values (the window's `--ws-*` palette, same hex values); add `--spk2..4`, `--sidebar` |
| 2. Shared components | buttons, settings rows and cards, inputs, switches, tags, menus, tabs, segmented control, skeletons, search: classes the plugin borrows from its host | `echo-compat.css` draws them as Connect's components (28 px buttons, 32×16 switches, 16 px checkboxes, Connect's inputs). Add `set-foot`, `set-nav`, `tag` (`acc`, `ok`, `warn`), `seg`, `tab`/`tabs`, `menu`/`menu-item`/`menu-sep`, `icon-btn`, `selectable`, `grow`, `btn.sm`, `a.md-missing` |
| 3. Knowledge's own components | 272 `kn-*` classes: the vault rail and switcher, page tree, reader and editor, diffs, graph panels, Health list, Ingest review, its own dialog (`.kn-sheet`). Geometry is the plugin's (Echo's density: 11.5–12.5 px text, 6–12 px radii, its own spacing) | **a Connect skin for Knowledge**: `ui/plugins/frame/skins/obsidian.css`. The frame loads it after the plugin's stylesheet, and it restyles those components to Connect's type scale, spacing, radii, dialog (8 px, 50 % scrim), tabs and checkboxes. It matches the Meetings and Settings pages |

**How the skin is kept honest:**

- It applies only to plugin `obsidian` within a tested version range (`1.0.x`). A newer Knowledge gets layers 1–2 only
  (Connect colours and controls, the plugin's own geometry) until the skin is checked against it.
- A test checks that every selector in the skin still exists in the installed `knowledge.css`. A renamed class shows up
  as a failing test, not as a silently half-styled page.
- The skin only restyles (sizes, spacing, radii, borders). It never hides or reorders anything, so a missed selector
  degrades the look, not what the plugin does.

**Also part of the look:**

- **Full-bleed layout:** a page with its own rail and header, as Knowledge has, gets no padding from `.cx-main`
  (`body[data-view=activity]`).
- **Fonts:** the frame uses the window's font stack exactly.
- **Sidebar:** Knowledge shows in the sidebar's Plugins group with Connect's icon. The plugin's own SVG isn't taken
  into the window.

The visual check is every Knowledge tab, sheet and empty state side by side with Connect's Settings and Meetings
pages, light and dark, in the running app.

### 5.6 What stays different from Echo (stated, not fixed)

- **The plugin's text says "Echo"** in about 170 places, for example "Remove from Echo…" and "Echo is reading this
  vault". Connect can't change it without editing the plugin. Rewriting text in the frame would also rewrite the
  user's own notes. This plan accepts it. The clean fix is a small plugin release that uses `ctx.host.name`, which
  Connect already provides, whenever you choose to make one.
- **No Claude-in-Echo material.** The plugin's `agent/` part, its 10 commands for Claude, and hints by client or
  thread are not used. "Ask the vault" opens Claude Code in the vault, as in Echo, but without Echo's index commands.
- **Calls are Connect meetings** (Phase 5). There is no recording, threads or clients, so routing minutes by thread
  or client, recording waits and the thread/client profile rows don't apply.

## 6. Implementation plan

Eight tasks, in order. Each one:

- ends with `cargo fmt`, `cargo clippy`, `cargo test`, `npm test` and a check in the running app;
- grows the real-plugin test in `src-tauri/tests/echo_plugins.rs` by the flow it makes work (see Task 8).

Sizes are rough new code, tests included *(inference)*. A detailed plan written from this one keeps to 10 tasks or
fewer: combine steps rather than add tasks. Where this document says "Phase N":

| Phase | Tasks |
|---|---|
| 1 | Task 1 |
| 2 | Task 2 |
| 3 | Task 3 |
| 4 | Tasks 4–5 |
| 5 | Task 6 |
| 6 | Tasks 7–8 |

### Task 1: Knowledge installs and loads (Phase 1, ~800 lines)

- **Spike first.** Run the published client in the frame with temporary stubs, and list what breaks. Look at:
  - hash routing in an opaque-origin frame;
  - `import()` with `?v=` queries;
  - the canvas graph;
  - the `localStorage` stand-in.

  Fold what you find into the rest of this task.
- **Manifest and sheet** (§5.4, in `capabilities.rs`, `manifest.rs` and `install.rs`):
  - the `skills`, `m365` and `network.ask` keys and their sheet lines;
  - the `ECHO_COMPAT` gate, set to `0.9.9` for now.
- **Host:** `crypto.sha256`, `store.update`, and `echo.read` for `calls` (empty), `me` and `recording`.
- **Client** (§5.3): `slots`, `onFileDrop` (registration only), `ui.sheet`/`closeSheet`, hash mirroring and
  `data-theme`.
- **Look, layers 1 and 2** (§5.5): add the missing tokens and shared classes to `echo-compat.css`, and give the page
  full-bleed layout.
- **`tests/echo_plugins.rs`:** the published `obsidian` is now Knowledge 1.0.1, and today it fails these tests on
  `uses.m365`. Replace "Knowledge is blocked / refused at install" with "Knowledge installs with an honest sheet and
  loads". This supersedes ruling R31, which was made when Knowledge existed only in a moving worktree.

**Done when:**

- Knowledge installs from the built-in marketplace with an honest sheet.
- "Knowledge" shows in the sidebar and in Settings, in Connect's colours and controls.
- The frame reports no load error.

### Task 2: read side (Phase 2, ~1,600 lines)

- `fs.stat`, `fs.search`, `fs.read {strict}`, `fs.walk {sha}`.
- `store.write {ifSha, createNew}`, `store.walk`.
- `markdown(md, opts)`, `markdown.links`, the image route.

**Done when:** you connect a folder and an Obsidian vault and the index builds. Home, Pages (with images and links),
Graph, deterministic Health and find all work.

### Task 3: write side and history (Phase 3, ~1,500 lines)

- `fs.write {ifSha, createNew}` with the hidden-file allowlist.
- `fs.append`, `fs.copyIn`, `system.pickFiles`.
- `onFileDrop` delivered: a Tauri drop becomes file handles.
- `ctx.git.*`, `system.reveal`.

**Done when:**

- A page can be:
  - edited;
  - saved over a changed copy (you get the conflict message);
  - restored from history;
  - created;
  - fixed with Fix and Fix all.
- The twin preset makes a new vault with a git repository.
- Files dropped on the page appear in Ingest's sources.

### Task 4: Claude in a vault (Phase 4, ~1,100 lines)

- `claude.run` read and copy modes, with the snapshot, `key` and `stop` (§5.2).
- The new `claude` sheet line.
- `claude.session` in Terminal.app.

**Done when:**

- A vault's description is written.
- AI checks find issues.
- Ingest of a file proposes changes, and you can review and apply them.
- "Ask the vault" opens Claude Code in the vault.

### Task 5: web and skills (Phase 4, ~700 lines)

- `web.read` + `http.askAddress`.
- `installSkill`/`removeSkill`, with Connect's confirmation.
- `ECHO_COMPAT = 0.10.0`.

**Done when:**

- Ingest of a web page proposes changes.
- The twin skill installs globally after you confirm, and removes cleanly.
- Knowledge's `echo >=0.10.0` is met.

### Task 6: Connect's meetings and mail into Knowledge (Phase 5, ~1,000 lines)

The data side is done. Meetings, transcripts, note documents, tasks and the glossary landed on `workspace-app`
(`5afed98..e4cf7d6`). Their folders already use Echo's layout:

- folder names are `YYYY-MM-DD_HHMMSS-<slug>`;
- each folder holds `notes.md`, `transcript.md` and `meta.json`;
- `tasks.json` uses Echo's `actions.json` shape.

This task adds an adapter over that data in `services/echo_read.rs` and `services/events.rs`, plus the Meetings
page's part. Nothing changes in `workspace/meetings/`.

| Knowledge asks for | Connect answers from |
|---|---|
| `echo.read('calls', {q, since, until, limit})` | meeting records that have a saved folder; a meeting without one is not a call. `id` is `call:<folder>` and `stamp` is the folder name. Also `title`, `started_at`, `ended_at`, `duration_min`, `app: 'teams'`. `minutes` = a main document exists; `transcript` = `transcript.md` exists. `participants` from speakers and attendees. `threads: []`, `client: null` |
| `echo.read('source', 'call:<folder>', {transcript})` | `text` = the main notes document; `minutes.actions` from `tasks.json`; `transcript.md` when asked. A meeting with no main document gives `<title>: no minutes yet` |
| `minutes_written` event | a notes run that writes or replaces the main document. `revision` = the first 16 hex characters of the document's sha256; `rewritten` when it replaced one |
| `transcribed` event | a saved transcript (`ok: true`). `recording_*` events are never sent: Connect doesn't record |
| `echo.read('dictionary')` | the glossary, through the native glossary parser behind Settings › Meetings |
| `echo.read('me')` | the Microsoft profile's name and email (from Task 1) |
| `ctx.m365.search/mailThread/chat` | Connect's synced Outlook mail and Teams chats, read through Connect's own Graph sign-in |

On the Meetings page:

- `ctx.where()` gives `view: 'calls'` while a meeting is open.
- The plugin's `call.menu` items show as text in the meeting's ⋯ menu, and `call.header` as a text chip. Clicking one
  runs it in the frame.
- `call.minutes` is a text line while notes are being made.
- The save sheet opens as the plugin's frame in a modal over the meeting.
- An `echo://call/<folder>` link in a vault note opens that meeting in Connect.

**Done when:**

- "Save the minutes to Knowledge" works from a Connect meeting.
- A new meeting's notes reach the vault that Knowledge routes them to.
- Past minutes and Sample list Connect's meetings.
- Ingest takes a meeting, a mail thread and a Teams chat.

### Task 7: the Knowledge skin (Phase 6, ~500 lines)

- `ui/plugins/frame/skins/obsidian.css`. The shim loads it after the plugin's stylesheets, for `obsidian@1.0.x` only.
- A test that every selector in the skin still exists in the installed `knowledge.css`.
- A light/dark pass of every Knowledge tab, sheet and empty state, against Settings and Meetings.

The skin comes after the features because it has to follow the screens as they actually work.

**Done when:**

- Side by side with Settings and Meetings, in light and dark, Knowledge looks like part of Connect.
- The selector test passes.

### Task 8: contract tests and docs (Phase 6, ~700 lines)

- **Contract tests:** one per error text the plugin matches, and one per shape in `fake-ctx.mjs`.
- **Real-plugin test.** This extends the existing harness in `tests/echo_plugins.rs`, which:
  - runs the published plugins' real `main.js` in Connect's real host, over a real `Core`;
  - loads the plugins from `CONNECT_ECHO_PLUGINS_DIR`;
  - fakes only Claude, the network and the pickers.

  Tasks 1–6 each grow `obsidian_walks_fixture_vault…` by a step. This task fills the gaps so it runs the full flow:
  add → kn → tree → page → graph → health → save_page → history → lint → ingest → save_minutes. The plugin stays out
  of the repository.
- **Docs:** update `.ai-run/guides/architecture/architecture.md` (§ "Where Milestone 2 differs from Echo") and
  PLUGIN-ENGINE.md §4.5, §5 and §10.

**Done when:**

- With `CONNECT_ECHO_PLUGINS_DIR` set, `cargo test` runs the full flow against the published plugin.
- The guides describe the new members.

## 7. Risks

| Risk | Mitigation |
|---|---|
| Echo's plugin API keeps moving, and Knowledge 1.1 uses a member Connect lacks | the `ECHO_COMPAT` gate (§5.4) lists it as "Needs a newer Connect" instead of letting it break; the contract tests show what changed |
| Claude with tools in a user's folder | read runs can't edit; edits happen only in a snapshot inside the plugin's store and reach the vault only through the plugin's reviewed apply, which goes through `fs.write` and its checks; no Bash, web or MCP |
| Big vaults in QuickJS (cold scan of 5k pages ≈ 3 s, memory ≈ 18 MB, per the earlier benchmark) | Connect's per-plugin 64 MB is already above Echo's shared budget; raise it to 128 MB only if Phase 2 testing on a 10k-page vault needs it |
| The 2 s `rev` poll walks the whole vault | `fs.walk` runs off the plugin's thread; measure in Phase 2, and add a change token later only if needed |
| The frame differs from Echo's page (hash, focus, drops) | the Phase 1 spike first; the shim's mirroring is covered by `node:test` cases |
