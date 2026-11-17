# Plugin conformance: the four published Echo plugins in Connect

What each published plugin does in Connect's plugin host (engine 1.0, [PLUGIN-ENGINE.md](PLUGIN-ENGINE.md)), and
the evidence for it. Task 25 of Milestone 2.

| Status | Plugins | Connect |
|---|---|---|
| Qualified, 2026-11-17 | `echo-plugins` main at `8655273`: Scheduler 0.4.0, GitHub 0.3.0, Obsidian 0.8.0, Telegram 0.4.0 (all `echo >=0.9.9`) | branch `feat/milestone-1-workspace`, version 2.1.1 |

## Verdict

| Plugin | Loads | Its pages | Verdict |
|---|---|---|---|
| Scheduler | yes | Settings section and card open in the native frame; no errors | **Works** (Claude without tools; Telegram delivery unavailable while Telegram doesn't load) |
| GitHub | yes | Settings section opens in the native frame; no errors | **Works** without a sign-in: asks the user to sign in, sends nothing |
| Obsidian | yes | Its Vaults page, Settings section and card open in the native frame; no errors | **Works**; Echo-only help for Claude sessions is skipped by the plugin's own guards |
| Telegram | no | none (Connect makes no frame for a plugin whose host half didn't load) | **Known failure: needs plugin change: sessions API** (expected, ruling R39) |

Telegram's `apply(ctx)` calls `ctx.sessions.clearChannel()` without a check. `ctx.sessions` is `undefined` in Connect
(PLUGIN-ENGINE.md §10, rule 3), so it can't load until the plugin tests for it. Connect now says exactly that, in the
log and on the plugin's row and page in Settings → Plugins:

> unsupported: CodeMie Connect doesn't have ctx.sessions (only Echo has it), so this plugin needs a change to run
> here: cannot read property 'clearChannel' of undefined

The host stays healthy: the other three keep loading and answering, and loading Telegram again fails the same way.
The `ctx` members stay `undefined` to every presence test; the host only notes which Echo-only member a plugin
touched last, and names it when a TypeError follows from it (`prelude.js`, `ECHO_ONLY`).

## How it was checked

1. **Conformance tests** (`src-tauri/tests/echo_plugins.rs`, env-gated by `CONNECT_ECHO_PLUGINS_DIR`; a
   marketplace folder or its `plugins/`). Each test copies the marketplace into a temp folder, installs the four
   with every sheet agreed to into a temp data root, and loads them with the real `PluginManager`, the real host
   and Connect's real services over a real `Core`. Only what is outside Connect is faked: Claude (`FakeRunner`),
   the network (an offline client that records every request that passed the checks and sends none), the folder
   picker and the GitHub CLI. The doubles come from `app_lib::testing`, built only with the `test-support`
   feature, which only the crate's own dev-dependency turns on.

   ```sh
   cd src-tauri && CONNECT_ECHO_PLUGINS_DIR=/Users/Vadym_Vlasenko/AI/projects/other/echo-plugins cargo test --test echo_plugins
   # 9 passed (4 earlier + 5 of Task 25)
   ```

2. **Native smoke** (`CODEMIE_PLUGIN_SMOKE=<marketplace folder>`, debug build, outside the agent sandbox). The
   real app on a fresh temp data root installs every plugin the marketplace offers, waits for the manager, and opens
   each plugin's pages, Settings sections and card in its real sandboxed frame in WKWebView. Run `fd8017fb-…`:
   **PASS**, exit 0, Telegram listed as the known failure. Details in [VALIDATION.md](VALIDATION.md).

3. **Host unit tests** (`plugins::host::tests`): `missing_namespaces_are_undefined` (Telegram's start-up as a
   synthetic plugin, with the exact message) and `an_echo_only_api_is_named_only_when_it_caused_the_failure`
   (`ctx.claude.installPlugin` named; a guarded look followed by the plugin's own mistake is not blamed on it;
   presence tests still see nothing).

## Matrix

Status words: **Works**; **Partial** (works with a limit Connect states on the sheet); **Absent** (an Echo-only
member, `undefined` in Connect, which the plugin checks for); **Fails** (used without a check).

### Scheduler 0.4.0

| Capability | Status | Evidence |
|---|---|---|
| Install: sheet (`claude`, `schedule`, `deliver`), engine check | Works | `published_manifests_parse_and_none_is_blocked`, `published_plugins_install_from_their_local_marketplace` |
| Host half loads; no unknown capability or service | Works | `all_four_load_without_unknown_capability_errors` |
| `ctx.store`, `ctx.package` (routines, templates, runs) | Works | `scheduler_routine_runs_claude_tool_free_and_delivers_today` (`save`, `run_wait`, `view`, `run_detail`, `templates`) |
| `ctx.claude.run` | Partial: always without tools | same test: one run, `--tools ""` on the command line although the routine asked for `read`; the `ai_run` records `tools: read` |
| `ctx.deliver.send('today')` | Works | same test: one delivery card on Today, titled by the routine, `about: Routine · Monday asks` |
| `ctx.deliver.send('mail' / 'teams')` | Partial: held as a draft the user confirms | Task 22 `deliver_mail_creates_held_message_to_self_never_confirmed` |
| `ctx.deliver.send('telegram')` | Unavailable while Telegram doesn't load | `telegram_fails_…`: `deliver.status` lists no `telegram` provider |
| `ctx.every(30)` schedule | Works (host) | Not driven in Task 25 (no live Claude; the smoke never triggers a routine). Timers: `plugins::host` tests |
| Manifest `agent` | Absent (Echo's sessions only) | not read by Connect |
| Client half: Settings section, card, panels, palette | Works | native smoke: section `main` and card drawn, `view` answered, no page errors |

### GitHub 0.3.0

| Capability | Status | Evidence |
|---|---|---|
| Install: sheet (`signin`, `network`, `work`, `sessions`) | Works; `sessions` is a sheet line that grants nothing | manifest tests above |
| Host half loads | Works | `all_four_load_without_unknown_capability_errors` |
| `ctx.signin.get` without the user's Sign in | Works: refused, so no sign-in | `github_without_signin_shows_prompt_and_makes_no_requests`: `status.signedIn` false; the GitHub CLI is never read (0 reads) although it has a token |
| `ctx.http.fetch` | Works; none made without a sign-in | same test: after `pick`, `refresh` and `discover {force}`, 0 requests recorded |
| `ctx.widgets.provide` (repos, ci, glance) | Works | same test: after a tick the three widgets on Today ask to sign in; the work rows are empty |
| `ctx.work.provide` | Works | same test (`github:work`, no rows) |
| `ctx.signin.sources` | Works | `status.sources` is `{gh: true, git: false}` |
| `ctx.threads`, `ctx.view.hints`, slot `thread.profile` | Absent | the plugin checks for each; nothing logged as unsupported |
| Client half: Settings section | Works | native smoke: section `main` drawn, `status` answered, no page errors |
| Signed in (GraphQL reads) | Not run | needs the network; no recorded GitHub answers in Task 25 |

The widgets' prompt is the plugin's own words ("Sign in to GitHub on this computer (gh auth login), then
Refresh"). In Connect the user also presses Sign in with GitHub on the plugin's page in Settings → Plugins.

### Obsidian 0.8.0

| Capability | Status | Evidence |
|---|---|---|
| Install: sheet (`folders`, `claude`, `echo`, `sessions`) | Works | manifest tests above |
| Host half loads; `publish()` at start | Works | `all_four_load_without_unknown_capability_errors` |
| `ctx.system.pickFolder`, `ctx.fs.walk/list/read/readMany` | Works | `obsidian_walks_fixture_vault_sets_inbox_and_survives_unsupported_agent_calls`: a synthetic vault (4 notes, `.obsidian/`) is picked and surveyed; `backlinks` of `People/Ann Lee` answers from its index |
| `ctx.claude.run({tools: 'none'})` | Works | same test: one tool-free run whose prompt has the survey and the note heads |
| `ctx.inbox.set/clear` | Works | same test: "Check what Claude will be told about Team Wiki" on Today; gone after `confirm` |
| `ctx.echo.read('clients' / 'threads')` | Works: lists (`threads` is `[]`) | same test: `view.threads` is `[]` |
| `ctx.on('minutes_written' / 'sources_changed')` | Works: granted through `echo.read sources` | no refusal logged (`all_four_…`) |
| `ctx.sessions.skills/read`, `ctx.agent.set`, `ctx.view.hints` | Absent | same test: each call fails inside the plugin's own guard (`skill:`, `agent:`, `folders:`, `hints:` in its log) and the plugin keeps running |
| Knowledge (Echo's own vault) | Not run | the `knowledge` setting is off by default |
| Client half: Vaults page, Settings section, card | Works | native smoke: activity `vaults`, section `main` and card drawn, `knowledge_wake` and `view` answered, no page errors |
| Graph view (`ctx.ui.graph`, Sigma) in the native frame | Not run | needs a connected vault, which the smoke can't pick (native folder dialog). Proven in Chromium (browser E2E, Task 23) |

### Telegram 0.4.0

| Capability | Status | Evidence |
|---|---|---|
| Install: sheet (`deliver_provider`, `network`, `channel`) | Works; `channel` is a sheet line that grants nothing | manifest tests above |
| Host half loads | **Fails: needs plugin change: sessions API** | `telegram_fails_to_load_with_a_clear_unsupported_sessions_error`: the exact message above; the other three loaded and answer; reloading fails the same way; nothing of Telegram is left (no provider, no Today items) |
| `ctx.claude.hasPlugin/installPlugin` (commands `status`, `install`) | Absent; unreachable while it doesn't load | host test names `ctx.claude.installPlugin` the same way |
| `ctx.openEchoPanel` (client, on a click) | Absent; no frame is made for it | `a plugin whose host half did not load gets no frame` (`ui/test/plugin-bridge.test.mjs`) |
| Settings → Plugins | Says why | "Didn’t load" badge and the message on its row and page; it can still be turned off (unit test and browser E2E, screenshots `plugins-{dark,light}-1440-didnt-load{,-detail}.png`) |

What it needs (PLUGIN-ENGINE.md §10): `main.js` tests for `ctx.sessions` in `sync()` and for
`ctx.claude.installPlugin` in `install`, and `client.js` for `ctx.openEchoPanel`. Then it would load and provide
delivery to Telegram; the smoke's verdict already treats a Telegram that loads as a pass.

## Connect changes this qualification made

- **A clear error for Echo-only APIs** (`src-tauri/src/plugins/host/prelude.js`): an unguarded call is `unsupported`
  and names the member and the needed change, instead of a bare TypeError. `ctx` is a Proxy that only notes reads;
  members stay `undefined`.
- **Load errors reach the user**: `plugins_request installed` carries `loadError` (the manager's reason), shown in
  Settings → Plugins; no frame is made for such a plugin.
- **Page errors reach the window**: the frame shim reports uncaught errors, unhandled rejections, CSP refusals and
  render failures through the bridge (`{type: 'error'}`), once each, 20 at most; `host.status(id).errors` keeps them.
- **The native smoke** `CODEMIE_PLUGIN_SMOKE=<marketplace folder>` (`src-tauri/src/commands/plugin_smoke.rs`,
  `ui/plugins/market-smoke.js`).
- **Test doubles for `tests/`** (`src-tauri/src/testing.rs`, feature `test-support`).

## Limits of this evidence

- No live Claude run and no network: Claude is `FakeRunner`; GitHub and Telegram are never reached. GitHub signed in
  and Telegram delivery are not exercised.
- The smoke never triggers a Scheduler routine and can't connect an Obsidian vault (both need a person or a live
  Claude), so in the native frames it covers the pages each plugin draws on a fresh data root.
- Native visuals are not captured: the smoke checks that each frame was shown over its slot, became ready, answered
  its commands and reported no error. Layout in both themes is covered by the browser E2E (Chromium).
