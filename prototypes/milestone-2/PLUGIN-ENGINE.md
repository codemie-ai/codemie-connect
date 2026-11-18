# Plugin engine 1.0

One plugin package that runs in both Echo and CodeMie Connect.

| Status | Baseline | Readers |
|---|---|---|
| Draft for review, 2026-11-17 | Echo 0.9.9 (checkout `11c3d004`) and its `.ai-run/reference/plugins/plugin-api.md`; the published marketplace `echo-plugins` at `0fa1079` | plugin authors, Echo's maintainer, whoever builds Connect's plugin host |

## 1. What this is

Echo has a working plugin engine and four published plugins: Scheduler, GitHub, Obsidian and Telegram. Connect will
run the same packages. This spec is what both apps promise a plugin: the package format, the two `ctx` objects, the
permissions, the limits, and the way the engine is allowed to change.

Echo's `plugin-api.md` is the detailed reference for long shapes: widget data, work rows, `http.fetch` errors and
event payloads. This spec does not copy those shapes. It names the section, and that section is binding for both hosts.

Out of scope: what the Knowledge plugin needs on top of this (vault sessions, git, a file watcher and so on). That is
proposed as engine 1.1 in [SHARED-HOST-API.md](SHARED-HOST-API.md).

## 2. Rules

1. **Echo's format is the format.** File names, `ctx` names and `uses` keys stay as Echo has them, including
   `echo-plugin.json` and `ctx.echo`. They name the format, not the app. Every published plugin is a valid 1.0
   plugin as it is; §10 says what each one needs to run in Connect.
2. **Only through `ctx`.** A plugin reaches its host through `ctx` alone. It never touches the host's files, DOM,
   globals or IPC, or another plugin's store.
3. **Missing means `undefined`.** A host that lacks a feature leaves the `ctx` member out, and the plugin tests for
   it (`if (ctx.work)`), as the published plugins already do. A host never ships a stub that throws: an unguarded
   call fails either way, and a stub would make the presence test lie. Data a host does not have reads as empty:
   in Connect, `ctx.echo.read('threads')` gives `[]`.
4. **The host enforces safety.** The host checks grants, paths, network hosts, limits and secrets on every call.
   Checks inside the plugin are a courtesy, not protection.
5. **Neutral words.** A plugin's user-visible text does not name the app; where the name matters it uses
   `ctx.host.name`. Each host writes the permission sheet in its own words.
6. **Spec first, then both hosts.** An engine change lands in this spec, then in both hosts, and the conformance
   plugin proves it (§9).

## 3. Package

A plugin is a folder of plain files (no links), at most 400 files and 20 MB, with `echo-plugin.json` at its root.

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | 1–40 characters, `a–z`, `0–9`, `-`, not starting with `-`; `echo` is taken |
| `name` | yes | up to 60 characters |
| `version` | yes | `X.Y.Z[-pre]`; a higher version is offered as an update (a plugin installed from a local folder updates on any file change) |
| `engine` | no, **new** | the engine range it needs, such as `">=1.1"`; absent means `>=1.0` |
| `requires` | no, **new** | optional features (§6) it cannot work without, such as `["work"]`; a host lacking one does not offer the plugin and names what is missing |
| `echo` | no | the minimum Echo version, `>=X.Y.Z`; Echo keeps reading it, Connect ignores it |
| `summary`, `icon` | no | up to 240 characters; an `.svg` of up to 16 KB |
| `main`, `client` | no | the host half (§4) and the client half (§5) |
| `uses` | no | what it asks permission for (§6) |
| `settings` | no | `{key, label, type, default?, help?}`, type `string`, `bool`, `folder` or `secret` |
| `widgets` | no | widgets for the host's home page (§4.3) |
| `skills`, `agent` | no | material for the host's own Claude sessions; Echo only for now (§6) |

Echo's manifest reader ignores fields it does not know, so plugins can carry `engine` and `requires` before Echo
reads them.

**Marketplace.** A marketplace is a folder or git repository with `echo-marketplace.json` at its root:
`{name, featured, plugins: [{id, source, categories}]}`. It is added as a local folder, a git address, or
`owner/repo[@ref]`. Installing shows the permission sheet. An update whose sheet differs asks again: a new `uses`
key, a new network host, a new script, changed Claude material.

## 4. Host half

`main` is one JavaScript file with no imports. It exports `apply(ctx)`, which registers everything the plugin does:
commands, timers, event handlers, widget providers. Both hosts run it in QuickJS.

### 4.1 Limits

| What | Limit |
|---|---|
| JavaScript between two `await`s | 5 s, then interrupted |
| A command called from the window | 30 s |
| A timer (`ctx.every`) | 10 s apart at least |
| A widget or work-row answer | 5 s |
| Memory | 64 MB; in Echo today all host halves share it |
| `http.fetch` | 60 s, 10 MB, redirects returned, never followed |

Bulk file reads go through `ctx.fs.readMany` and `ctx.fs.walk`. Long work goes to a script. Neither counts against
the 5 s.

### 4.2 Core `ctx`: every host has all of it

| Member | What it does |
|---|---|
| `id`, `log(...)` | the plugin's id; a line in the host's log |
| `host` | **new.** `{name, version, engine}`, for example `{name: "Echo", version: "0.9.9", engine: "1.0"}` |
| `terminal` | `true` when a CLI call loaded the plugin (no timers then); always `false` in Connect, which has no CLI |
| `command(name, fn)` | a command for its client half, its widget and inbox buttons, and Echo's CLI: JSON in, JSON out, throw to fail |
| `every(seconds, fn)` | periodic work |
| `on(event, fn)` | an event named in `uses.events.on` (§7); returns a promise that rejects when the event is not granted or the host never sends it |
| `store.read/write/list/remove/path/size`, `cache.size` | the plugin's own folder, by relative path; the host deletes files in `cache/` after 7 days |
| `settings.get/set` | its manifest settings; `secret` values are kept outside the store |
| `package.read/list` | the files of its own package |
| `http.fetch(url, opts)` | HTTPS to hosts in `uses.network.hosts`, or to addresses the user listed; resolves `{status, body}` |
| `markdown(md)` | Markdown to safe HTML |
| `notify(title, body)` | a system notification |
| `inbox.set(key, item)`, `inbox.clear(key)` | a decision for the user, `{title, why, urgent, go, actions}`, whose buttons run its commands |
| `widgets.provide/set/clear/changed` | data for its declared widgets (§4.3) |
| `shared.get/set` | values shared by the plugins of one marketplace, keyed `<ns>.<name>` |
| `fs.folders/list/read/readMany/walk/forget`, `fs.write/move/remove` | folders the user picked for it; writing needs `uses.folders.write` |
| `system.pickFolder/which/readFile` | the folder picker; whether a program is installed; another app's file named in `uses.files.read` |
| `signin.get/sources/keep/forget` | the user's sign-in for a host in `uses.signin.hosts`: from `gh` or git, or one the host keeps for the plugin |
| `claude.run(opts)`, `profiles()` | a Claude run (§4.4); the user's AI profiles, `{default, profiles: [{id, name}]}` |

### 4.3 Widgets

A plugin declares up to 24 widgets in its manifest and feeds them through `ctx.widgets`. The kinds are `stat`,
`stats`, `chart`, `list`, `status`, `card`, `table` and `page`; the sizes are S, M and L. Each host draws every kind
on its home page (Today in both apps; dashboards too in Echo). It accepts and refuses data exactly as
`plugin-api.md` § Widgets says. A `page` widget is drawn by the client half (`ctx.widgets.draw`).

Settings of type `thread` and `client` exist only where the host has threads. A host without threads never fills
them, and the widget gets its default.

### 4.4 Claude runs

`await ctx.claude.run({prompt, title, profile, model, tools, dir, timeout})` needs `claude` in `uses` and resolves
`{answer, model, usage, actions}`.

- It always runs on one of the user's own AI profiles, never on a key or account of the plugin.
- With `tools: "none"` both hosts run Claude with no tools. Everything Claude needs goes in the prompt. This is the
  only mode that behaves the same in both hosts.
- Without `tools: "none"`, Echo runs it as its folder session, with tools and in the mode the user chose. Connect 1.0
  still runs it with no tools. A plugin whose prompts only work with tools works worse in Connect.

### 4.5 Optional `ctx`: a host may lack it

| Member | `uses` key | Echo | Connect 1.0 |
|---|---|---|---|
| `work.provide/changed` | `work` | My work, a thread's Work | rows on Today |
| `deliver.send/status` | `deliver` | Teams, mail, Telegram, Today | Today; mail and Teams kept as drafts the user confirms; Telegram through its plugin |
| `deliver.provide/ready` | `deliver_provider` | yes | yes |
| `echo.read`, `echo.dictionary.add` | `echo` | clients, threads, people, dictionary, sources, source | people, sources and source from mail, chats and calendar; clients and the dictionary kept by Connect for the plugin, `dictionary.add` included; threads `[]` |
| `threads.get/set/list` | none | yes | no |
| `scripts.run` | `scripts` | yes | no |
| `sessions.skills/read`, `view.hints` | `sessions` | Claude in Echo | no |
| `agent.set` | manifest `agent` with a `summary` | Claude in Echo | no |
| `sessions.channel/clearChannel`, `claude.hasPlugin/installPlugin` | `channel` | yes | no |

## 5. Client half

`client` is an ES module, which may import the plugin's other files. It exports `apply(ctx)`. Everything it adds is
taken out when the plugin is switched off, updated or removed.

| Member | What it does | Hosts |
|---|---|---|
| `id`, `host` | as in the host half | both |
| `call(command, args)` | runs a host-half command | both |
| `render()` | asks the host to draw again | both |
| `listen(type, fn, opts)` | a document listener, removed on unload | both |
| `activities.add({id, label, icon, render, after})` | a page of its own, routed as `#<plugin>:<id>/<route>` | both |
| `settings.add(card)`, `settings.section(section)` | its card in Settings → Plugins; a Settings section of its own | both |
| `panels.add(view)`, `showPanel(view)` | a side view of its own, and opening it | both |
| `palette.add(item)` | a command-palette entry | both |
| `widgets.draw(widget, fn)` | draws a `page` widget from its data: the same data gives the same HTML | both |
| `go(hash)`, `where()` | navigate; which page and Settings section are shown | both |
| `ui.esc, setRow, setCard, sw, ICON, relDay, ago, notice, copy, style` | the host's building blocks (§5.2) | both |
| `ui.graph`, `ui.newGraph` | a graph view (Sigma over graphology) | both |
| `slots.list()`, `slots.add(slot, item)` | buttons and rows in the host's own screens | Echo only: `call.menu`, `calendar.event`, `task.actions`, `thread.profile`, `knowledge.tab`, `knowledge.settings` |
| `openEchoPanel(view)` | opens one of Echo's own panels | Echo only |

### 5.1 One client half, two ways of loading it

Echo loads the client half into its own page. Connect loads it into a sandboxed frame with an opaque origin. The same
code works in both if it keeps to these rules:

- It uses `document` only for the elements it drew itself (found by its own ids), its own `<style>`, and in Echo's
  slots the box the host hands to `after`. It handles events through `ctx.listen`.
- It never uses `window.parent`, host globals, the host's IPC, the network or browser storage. Data comes through
  `ctx.call`, and lasting state lives in the host half's store.
- Every piece of text goes into HTML through `ctx.ui.esc`. Markdown is rendered in the host half with `ctx.markdown`.

### 5.2 UI kit

Plugins look native by using the host's markup helpers (`ctx.ui.setRow`, `setCard`, `sw`) and only these shared
names. Each host styles them its own way, light and dark.

| Kind | Names |
|---|---|
| Classes | `btn` (with `primary`, `ghost`, `danger`), `tok` (with `add`, `link`), `sw`, `search`, `set-in`, `set-sub`, `set-ok`, `error`, `warn`, `skeleton` |
| CSS variables | `--bg`, `--surface`, `--text`, `--text-2`, `--text-3`, `--line`, `--line-strong`, `--accent`, `--accent-soft`, `--accent-ink`, `--warn`, `--danger`, `--me`, `--mono`, `--r-panel`, `--r-control`, `--shadow` |

The list is the subset of Echo's CSS that the published plugins use. A plugin's own CSS (`ctx.ui.style`) builds on
these variables and nothing else of the host's.

## 6. Permissions: `uses`

Each `uses` key is one line of the permission sheet the user agrees to on install.

| Key | Tier | Grants |
|---|---|---|
| `claude` | core | `ctx.claude.run` |
| `schedule` | core | the sheet line that it works on its own on a timer |
| `network` | core | `http.fetch` to `hosts`, or to the addresses the user lists in settings named by `hosts_from` |
| `folders` | core | the folder picker and `ctx.fs`; `write: true` to change files |
| `files` | core | `ctx.system.readFile` for each named file of another app |
| `signin` | core | `ctx.signin` for up to 4 hosts; `keep: true` lets the host keep a sign-in the plugin made |
| `events` | core | `ctx.on` for the events listed in `on` |
| `work`, `deliver`, `deliver_provider`, `echo`, `scripts`, `sessions`, `channel` | optional | the members in §4.5 |

These are also the feature names that `requires` takes, together with `threads` and `slots`.

When a host lacks an optional key, its sheet line says that the feature is not available in this app, and nothing is
granted. The `ctx` member is left out, and the plugin still installs unless `requires` names that key. A key outside
this spec refuses the install, with a hint that the plugin may need a newer version (Echo's rule today). That includes
`brain_source` and `export`, which Echo knows but has not built.

## 7. Events

`shared_changed` is core. The rest come from Echo's own data and are optional: `meeting_soon`, `call_started`,
`call_ended`, `recording_started`, `recording_stopped`, `transcribed`, `minutes_written`, `thread_synced`,
`sources_changed` and `threads_changed`. Connect 1.0 sends `meeting_soon`, `sources_changed` and `shared_changed`.

A plugin whose `echo.read` includes `source` or `sources` also gets `minutes_written` and `sources_changed` without
listing them.
Payloads are as in `plugin-api.md` § Events. A call's words are never in a payload; the plugin reads them with
`ctx.echo.read('source', id)`.

## 8. What each host enforces

- Before any service runs, the host checks it against the sheet the user agreed to.
- Paths are relative, never contain `..` and never pass through a link. Writes need `folders.write`, replace a file
  atomically, and never touch a hidden file or folder such as `.git`. A move never replaces another file.
- The network is limited to HTTPS to the listed hosts. Plain HTTP goes only to addresses the user typed, inside their
  own network, and the plugin cannot add such an address itself.
- `secret` settings and kept sign-ins live outside the plugin's store. A sign-in grants no network: the API host
  must also be in `network.hosts`. Sending a token only to its own service is the plugin's duty; the sheet tells the
  user it can send the sign-in to the places it talks to.
- Claude runs on the user's own profiles. A plugin's skills reach only the host's own Claude sessions, never the
  user's own Claude Code.
- A script runs only when declared. It runs without a shell or stdin, in its own process group, with capped output,
  and with no host secret and no `CLAUDE*` or `ANTHROPIC*` key in its environment.
- The host keeps its own files in the store. A plugin cannot write `settings.json`, `inbox.json`, `widgets.json`,
  `threads.json` or `work.json`, and cannot remove `settings.json`, `threads.json` or `work.json`; it changes them
  through `ctx`.
- On unload the host removes everything the plugin registered: commands, timers, listeners, styles, pages, slots and
  palette entries.

## 9. Changing the engine

The spec has two owners, Echo's maintainer and Connect's owner. A change needs both.

1. **Propose.** Open a pull request to this spec. It names the new member or field, its tier (core or optional), its
   `uses` line if any, its limits, and what the host checks.
2. **Version.** An addition raises the minor version (1.1). Nothing is removed or changed in place within 1.x. A
   breaking change waits for 2.0, and the old form keeps working until the published plugins have moved.
3. **Build.** A core addition ships in both hosts before either reports the new minor in `ctx.host.engine`. An
   optional addition may ship in one host first, while the other leaves it `undefined`.
4. **Prove.** The conformance plugin gets a case for the change, and both hosts run it in CI together with smoke
   checks of the published plugins.
5. **Use.** A plugin that relies on a new core member sets `engine: ">=1.1"`. One that relies on an optional feature
   tests for it, or names it in `requires`.

**The conformance plugin** lives beside the published plugins. Its host half has one command per core member, which
returns what it saw. Its client half registers one of each core client member. A runner in each host's test suite
installs it, calls every command and compares the answers with the expected ones in the spec repository.

Echo's `plugin-api.md` stays the detailed reference. Its shared sections change only through these steps. This spec
moves to the `echo-plugins` repository once both owners accept it.

## 10. Reaching 1.0

**Echo** is already almost there:

- add `ctx.host` to both halves;
- read `engine` and `requires`, and refuse a plugin that needs more than it has.

**Connect** builds its plugin host to this spec in Milestone 2, Tasks 17–25 of
[IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md). That means all of core, the optional `work`, `deliver`,
`deliver_provider` and `echo` (partly), the events listed in §7, and the client half in a sandboxed frame.

That plan and [DESIGN.md](DESIGN.md) §7 were written before this spec. These points in them change to match it:

| Point | DESIGN.md and the plan | This spec |
|---|---|---|
| `sessions`, `channel`, `agent`, `scripts`, `claude.hasPlugin/installPlugin` | exist and throw `unsupported` | `undefined` |
| `terminal` | `undefined` | `false` |
| manifest `echo` | checked against a compatibility version of 0.9.11 | ignored; `engine` is checked |
| `echo.read('threads')` | mapped from Connect's data | `[]` |
| `threads_changed` | sent | not sent |

The published plugins in Connect 1.0. All four declare `agent`, material for Echo's own Claude sessions; Connect 1.0
has no such sessions, so none of them gets it there.

| Plugin | Works | Missing in Connect | Plugin change needed |
|---|---|---|---|
| Scheduler | routines, delivery to Today, mail and Teams drafts | Claude tools in its runs; delivery to Telegram until Telegram is fixed | none |
| GitHub | sign-in, widgets, work rows | a thread's repos (`threads`, the `thread.profile` slot), hints for Claude (`view.hints`) | none |
| Obsidian | its page, reading vaults, Claude descriptions | the Knowledge tab, help for Claude sessions (`sessions`, `view.hints`) | none, if `echo.read('clients')` and `('threads')` give lists (rule 3) |
| Telegram | delivery, once loading works | the phone link into Claude sessions (`channel`, `sessions`) | yes: `main.js` calls `ctx.sessions` on load without a check, so loading fails; its `install` command calls `ctx.claude.installPlugin` without a check; `client.js` calls `ctx.openEchoPanel` on a click without a check |

## 11. Open questions

- **Memory.** Should Echo give each plugin its own 64 MB runtime instead of one shared runtime? Knowledge needs this
  (SHARED-HOST-API.md, D-5). It does not change the contract.
- **Where the spec lives.** Should it go in `echo-plugins` next to the plugins, or in a small repository of its own
  that both apps pin by commit?
