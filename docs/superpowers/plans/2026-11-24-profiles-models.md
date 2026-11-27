# Profiles and models (step 7) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Implementers also follow the shared rules in `.superpowers/sdd/common-implementer.md`.

**Goal:** Each AI job (replies, summaries, meeting notes, Morning briefing, Inbox triage, Commitments, other automations, Ask, every plugin that asks for AI) runs on the profile and model the user picks, with a fallback profile and a working status per row, over Claude Code, CodeMie profiles and Ollama reached through a CodeMie profile whose provider is `ollama`.

**Architecture:**
- `ai::profiles` learns the CodeMie provider and probes a local Ollama once per detection (`ollama list` through `CommandProbe`): new `AiProfile.provider`, `ProfileState::NotRunning`, Ollama models.
- `workspace::ai` gains rows (`RouteKey`: four new `Purpose`s and plugin ids), groups, a fallback field, the pure `choose` (the one resolution rule) and `resolve` / `Core::run_resolved` (fallback before the run and once after a qualifying failure); every AI caller moves to them. `ai_status` / `ai_settings_save` answer `chosen`.
- The window (`settings-ai.js`) draws Settings › AI: profile cards with Engine and Provider, the "What each job uses" table with Fallback and Status (`routeState`, pure, over the profiles after `withCodemieSignIn`).

**Tech Stack:** Rust (Tauri v2), `cargo test`; vanilla JS ES modules, `node:test`; Playwright (`playwright-core`) against the mocked bridge.

**Spec:** `docs/superpowers/specs/2026-11-24-profiles-models-design.md` (§ numbers and "ruling N" below refer to it). Definition of done: the spec's "Definition of done"; real-desktop screenshots are deferred to the announced pass at the end of the rollout.

## Global Constraints

- **Repository, branch, commits:**
  - `/Users/Nikita_Levyankov/repos/codemie-ai/codemie-connect`, branch `feat/workspace-next` (checked out). Do not switch branches. Do not push.
  - One commit per task, Conventional Commit subject, trailer `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
  - Before each commit, the case-insensitive `git grep -il` check for the reference app's name (the controller gives the word) must print nothing; never name the user's other assistant app or reference its files ("the reference app" if needed).
- **Running things:**
  - Raw `cargo` from `src-tauri/` with `export PATH="$HOME/.cargo/bin:$PATH"`; `make`, `npm`, `node` from the repo root; macOS/zsh syntax (BSD `sed`, `find`).
  - Skip the known failure: `cargo test -- --skip ai::profiles::tests::detects_native_and_codemie_states_and_caches` (Task 1 touches that test's module; keep the skip, and make Task 1's new tests independent of it).
  - Browser run: `PLAYWRIGHT_CORE=/Users/Nikita_Levyankov/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core node ui/test/browser/workspace-e2e.mjs`, outside the sandbox (`dangerouslyDisableSandbox: true`). One set: prefix `WORKSPACE_E2E_ONLY=<set>`. A UI task runs `ai-routes` (once it exists), `automations`, `compact` and `layout`; the whole run (about 40 minutes, `run_in_background`) is for Task 8.
  - **Never drive the desktop.** No GUI launch of the app except the headless smokes in Task 8.
- **Safety, every task:**
  - **Never run a live Claude or Ollama call.** No `live_*` test, no `ollama` command, no `ai_test` against a real profile. Claude is `FakeRunner`; detection is a fake `CommandProbe`.
  - No network in any test.
  - No secret anywhere: no `apiKey`, `token` or key field is read into a profile, route, ledger record, fixture or smoke report. `baseUrl` is read only inside `ai::profiles` to decide local vs remote and never serialized.
  - A status is never computed by running Claude or a model.
- **Code rules:**
  - Views and models stay pure; only `app.js` touches the DOM; writes go through `mutate`/the store; every profile, plugin and model string goes through `escapeHtml`.
  - Every Claude run goes through `ClaudeRunner` (via `Core::run_resolved`); no `Command::new("claude")`.
  - No new workspace operation and no new Tauri command.
  - Default and Compact draw the same markup.
- **Values:**
  - new wire names: purposes `briefing`, `triage`, `commitments`, `ask`; profile state `not_running`; plugin row key in `chosen` `plugin:<id>`; default row key `default`;
  - groups: `briefing|triage|commitments` → `automation`; plugin id → `plugin`; everything else → default;
  - template → row: `morning-brief` → `briefing`, `inbox-triage` → `triage`, `commitments` → `commitments`, else `automation`;
  - fallback-after-failure classes: `needs_login`, `not_installed`, `too_old`, `not_configured`, `rate_limited`; at most one extra attempt;
  - Ollama local: base URL empty, or host `localhost` / `127.0.0.1` / `[::1]` with no port or port `11434`; extra search dir `/Applications/Ollama.app/Contents/Resources`; a name without `:` compares as `<name>:latest`;
  - detection cache unchanged (30 s, 10 s after a failure); probe timeout 15 s.
- **Copy, verbatim from the spec § Copy** (each task quotes what it draws).
- **Contract fixtures:** after a native shape change run `cd src-tauri && UPDATE_CONTRACT_FIXTURES=1 cargo test contract_fixtures` and commit the JSON with the change.

## Review Focus

1. **Ollama is closed while the user changes an unrelated row.** The saved Ollama model on another row is kept (not silently dropped) and that row says Not working. (Task 2 `a_saved_model_is_kept_while_its_profile_cannot_list_it`; Task 5 `next_ai_settings_keeps_a_model_when_its_profile_did_not_change`.)
2. **A run times out or returns bad JSON on the chosen profile while a fallback is set.** No second, paid run on the fallback. (Task 3 `no_fallback_after_timeout_invalid_output_failed_or_cancelled`.)
3. **The chosen profile and the fallback both fail sign-in.** Exactly two attempts, both in the ledger, the error is the fallback's; never a loop. (Task 3 `fallback_runs_once_and_both_attempts_are_recorded`.)
4. **The active CodeMie profile's sign-in expired (known only to Settings › CodeMie).** Its card says Needs sign-in and every row on it says Using fallback or Not working, never Working. (Task 5 `route_state_reads_profiles_after_the_codemie_sign_in_overlay`.)
5. **A CodeMie config whose Ollama profile carries `apiKey` and a remote `baseUrl`.** It is not probed, it shows Ready, and neither the key nor the URL appears in `ai_status`, a fixture or the smoke report. (Task 1 `remote_ollama_is_not_probed_and_leaks_nothing`; Task 6 `status_smoke_reports_rows_and_ollama_without_urls`.)

---

### Task 1: Ollama through CodeMie in profile detection

**Files:**
- Modify: `src-tauri/src/commands/codemie_config.rs` (`ProfileSummary.base_url` from `baseUrl`)
- Modify: `src-tauri/src/ai/profiles.rs` (`AiProfile.provider`, `ProfileState::NotRunning`, `CodemieProfile.provider`/`base_url`, `parse_ollama_list`, `ollama_is_local`, the probe in detection)
- Modify: every `AiProfile { … }` literal (`ai/command.rs`, `ai/runner.rs`, `testing.rs`, `workspace/ai.rs` tests) to set `provider`
- Modify: `src-tauri/src/workspace/ai.rs` (`unready_error`: `NotRunning` → `ErrorClass::Failed` with the profile's message)
- Fixtures: regenerate `ai-status.json` (it gains `provider`)
- Test: `profiles.rs` test module

**Interfaces:**
- Produces:
  - `AiProfile.provider: Option<String>` (serde `provider`, `None` for native);
  - `ProfileState::NotRunning` (wire `not_running`);
  - `pub fn parse_ollama_list(out: &str) -> Vec<String>` (names, header skipped);
  - `pub fn ollama_is_local(base_url: &str) -> bool`;
  - `fn same_ollama_model(a: &str, b: &str) -> bool` (`:latest` rule);
  - detection runs `ollama list` at most once per `detect_profiles` and only when a local Ollama profile exists.

- [ ] **Step 1: Write the failing tests**

```rust
#[test] fn parse_ollama_list_reads_names()
// "NAME ID SIZE MODIFIED\nllama3.2:latest a80c 2.0 GB 2 weeks ago\nqwen3:8b 500a 5.2 GB 3 days ago\n" → ["llama3.2:latest","qwen3:8b"]; "" → []
#[test] fn ollama_is_local_only_for_loopback_on_11434()
// "" , "http://localhost:11434", "http://127.0.0.1", "http://[::1]:11434/" → true; "http://localhost:11500", "https://ollama.example.test" → false
#[tokio::test] async fn local_ollama_profile_states_and_models()
// config {"profiles":{"ol":{"provider":"ollama","model":"llama3.2"}}}, codemie-claude present:
//  no ollama binary → state NotInstalled, message "Ollama is not installed on this Mac.";
//  ollama present, probe for ["list"] fails → NotRunning, "Ollama isn't running. Open Ollama, then check again.";
//  list answers "llama3.2:latest" + "qwen3:8b" → Ready, models ids ["llama3.2:latest","qwen3:8b"], provider Some("ollama");
//  list answers only "qwen3:8b" → NotConfigured, "Ollama doesn't have llama3.2. Pull it in Ollama, then check again.", models ["qwen3:8b","llama3.2"]
#[tokio::test] async fn ollama_is_probed_once_for_two_profiles()   // two local Ollama profiles → the fake sees exactly one ["list"] call
#[tokio::test] async fn remote_ollama_is_not_probed_and_leaks_nothing()
// {"provider":"ollama","model":"m","baseUrl":"https://ollama.example.test","apiKey":"SECRET-KEY"} → Ready, no ["list"] call,
// serde_json::to_string(&profiles) contains neither "SECRET" nor "example.test"
#[tokio::test] async fn non_ollama_codemie_profiles_keep_their_provider()   // provider "litellm" → Some("litellm"), Ready, no probe
```

The existing test `Fake` probe gains a `list: Option<String>` (None = the command fails) and counts `["list"]` calls.

- [ ] **Step 2: Run them and see them fail.** `cd src-tauri && cargo test ai::profiles`. Expected: FAIL (functions and fields missing).

- [ ] **Step 3: Implement** per spec §1. `detect_codemie` becomes async (it takes the probe); `detect_profiles` passes it. A pulled model is a `ModelChoice {id: name, label: name}`. Remote and non-Ollama profiles keep today's path exactly.

- [ ] **Step 4: Run** `cargo test ai::profiles`, then `UPDATE_CONTRACT_FIXTURES=1 cargo test contract_fixtures`, then the whole suite with the skip. Expected: all pass; only `ai-status.json` (and fixtures that embed profiles) changed, each gaining `"provider"`.

- [ ] **Step 5: Commit**

```bash
git add src-tauri ui/test/fixtures/contract
git commit -m "feat(ai): detect Ollama through a CodeMie profile whose provider is ollama"
```

### Task 2: Rows, groups, fallback field and `choose`

**Files:**
- Modify: `src-tauri/src/workspace/models.rs` (`Purpose::{Briefing, Triage, Commitments, Ask}`; `Route.fallback`; `AiSettings.{default_model, default_fallback, plugins}`)
- Modify: `src-tauri/src/workspace/ai.rs` (`RouteKey`, `group_of`, `choose`, `chosen_all`, `validate_ai_settings`, `ai_status`, `ai_settings_save`; `chosen_profile` reimplemented on `choose`)
- Fixtures: regenerate `ai-status.json` (an Ollama profile, a fallback, a plugin row, `chosen`); create `ai-route-cases.json`
- Test: `ai.rs` test module

**Interfaces:**
- Consumes: Task 1 (`AiProfile.provider`, Ollama models).
- Produces:
  - `pub enum RouteKey { Purpose(Purpose), Plugin(String) }` with `fn wire(&self) -> String` (`"triage"`, `"plugin:knowledge"`);
  - `pub fn group_of(key: &RouteKey) -> Option<RouteKey>` (`None` = Default);
  - `#[derive(Serialize, Clone, Debug, PartialEq)] #[serde(rename_all = "camelCase")] pub struct Chosen { pub profile: Option<String>, pub model: Option<String>, pub fallback: Option<String> }`;
  - `pub fn choose(s: &AiSettings, key: &RouteKey) -> Chosen` (spec §2 rules) and `pub fn choose_default(s: &AiSettings) -> Chosen`;
  - `pub(super) fn chosen_all(s: &AiSettings) -> serde_json::Map<String, Value>` (keys: `default`, every `Purpose` wire name, `plugin:<id>` per saved plugin row);
  - `ai_status` → `{profiles, settings, chosen}`; `ai_settings_save` → `{settings, chosen}`;
  - `pub(super) fn chosen_profile(settings, purpose) -> Option<String>` keeps its meaning (now via `choose`).

- [ ] **Step 1: Write the failing tests**

```rust
#[test] fn old_settings_read_unchanged()
// {"defaultProfile":"claude","routes":{"summary":{"profile":"codemie:prod","model":"claude-haiku-4-5"}}} deserializes; choose(summary) == {codemie:prod, haiku, None}; choose(mail_draft) == {claude, None, None}
#[test] fn rows_inherit_from_their_group()
// routes.automation {profile codemie:prod, model m1} → choose(triage) == {codemie:prod, m1, _}; plugins.knowledge {} absent → choose(Plugin("knowledge")) == choose(plugin)
// triage {profile claude} → model None (profile and model go together); triage {model sonnet} with group profile claude → {claude, sonnet}
#[test] fn fallback_inherits_on_its_own_and_never_equals_the_profile()
// defaultFallback codemie:prod; triage {profile claude} → fallback codemie:prod; triage {profile codemie:prod} → fallback None
#[test] fn nothing_chosen_is_none()   // AiSettings::default() → choose(any).profile == None
#[tokio::test] async fn save_validates_fallbacks_plugins_and_models()
// fallback "nope" → "Choose one of the listed profiles."; routes.summary {profile claude, fallback claude} → "The fallback must be a different profile.";
// plugins {"../x": {...}} → "That plugin is not known."; model not offered → "That model is not offered by this profile."
#[tokio::test] async fn a_saved_model_is_kept_while_its_profile_cannot_list_it()
// save plugins.knowledge {profile codemie:ol, model qwen3:8b} with qwen listed; then profiles without qwen (Ollama closed):
// saving {…same plugins, defaultProfile changed} succeeds and keeps qwen3:8b; saving a *new* row with qwen3:8b is refused
#[tokio::test] async fn status_and_save_answer_chosen()
// ai_status["chosen"] has keys default, mail_draft, chat_draft, summary, automation, plugin, meeting, briefing, triage, commitments, ask, plugin:knowledge
#[test] fn contract_fixtures()   // writes ai-status.json and ai-route-cases.json: [{settings, chosen}] for: empty, old default+summary, automation group → triage, plugin row, fallback inheritance
```

- [ ] **Step 2: Run them and see them fail.** `cargo test workspace::ai`. Expected: FAIL.

- [ ] **Step 3: Implement** per spec §2. `resolve_route` stays for now (Task 3 replaces it) but reads through `choose`. Wire names come from `wire_name`.

- [ ] **Step 4: Run** `cargo test workspace::ai`, regenerate fixtures, then the whole suite with the skip, then `npm test`. Expected: all pass (`ui_renderers_accept_the_contract_fixtures_from_the_real_backend` still passes on the new `ai-status.json`).

- [ ] **Step 5: Commit**

```bash
git add src-tauri ui/test/fixtures/contract
git commit -m "feat(ai): rows for briefing, triage, commitments, Ask and each plugin, with groups and a fallback"
```

### Task 3: Running with a fallback

**Files:**
- Modify: `src-tauri/src/workspace/ai.rs` (`Resolved`, `resolve`, `Core::run_resolved`, ledger `fallbackFrom`; remove `resolve_route` and `Core::route` once no caller is left)
- Modify: `src-tauri/src/workspace/ai_jobs.rs` (drafts `:309`, summaries `:378`)
- Modify: `src-tauri/src/workspace/meetings/notes_job.rs` (`:370`), `meetings/notes_ops.rs` (`:102` uses `chosen_profile`)
- Modify: `src-tauri/src/workspace/plugin_data.rs` (`plugin_claude`: order of spec §3 "Plugins")
- Test: `ai.rs`, `ai_jobs.rs`, `plugin_data.rs` test modules

**Interfaces:**
- Consumes: Task 2 (`RouteKey`, `choose`).
- Produces:
  - `pub struct Resolved { pub profile: AiProfile, pub model: Option<String>, pub fallback: Option<AiProfile>, pub fell_back_from: Option<String> }`;
  - `pub fn resolve(s: &AiSettings, profiles: &[AiProfile], key: &RouteKey) -> Result<Resolved, AiError>` (pre-run fallback; `NeedsChoice` when no profile);
  - `pub(super) async fn resolve_key(&self, key: &RouteKey) -> Result<Resolved, AiError>` on `Core`;
  - `pub(super) async fn run_resolved(&self, r: &Resolved, spec: RunSpec, cancel: CancellationToken, on_event: Arc<dyn Fn(RunEvent) + Send + Sync>, ref_id: Option<&str>) -> (Result<RunOutcome, AiError>, RunSpec /* the attempt that answered, for the caller's ledger */)` — records a failed first attempt itself; the caller records the returned one as today;
  - ledger `ai_run.data.fallbackFrom: Option<String>`;
  - `PluginRun` resolution: own plugin row with a profile → plugin-named profile → `plugin` → default; fallback from `choose(Plugin(id))`.

- [ ] **Step 1: Write the failing tests**

```rust
#[test] fn resolve_uses_the_fallback_when_the_profile_is_not_ready()
// chosen codemie:prod NeedsLogin, fallback claude Ready → profile claude, model None, fell_back_from Some("codemie:prod");
// both unready → Err(class NeedsLogin) (the chosen profile's own error); chosen Ollama NotRunning → falls back
#[tokio::test] async fn fallback_runs_once_and_both_attempts_are_recorded()
// FakeRunner script [Err(NeedsLogin), Err(NeedsLogin)]; a summary job: runner.calls().len() == 2, second spec.profile_id == fallback,
// two ai_run records, the second with fallbackFrom; the job fails with the fallback's error
#[tokio::test] async fn rate_limit_falls_back_and_succeeds()   // [Err(RateLimited), Ok(..)] → draft ok, ledger statuses ["rate_limited","ok"]
#[tokio::test] async fn no_fallback_after_timeout_invalid_output_failed_or_cancelled()   // each class → exactly 1 runner call
#[tokio::test] async fn plugin_row_wins_over_the_profile_the_plugin_names()
// plugins.knowledge {profile codemie:prod}; run.profile Some("claude") → spec.profile_id "codemie:prod";
// no plugin row → "claude" (today's behaviour); neither → routes.plugin
#[tokio::test] async fn meeting_notes_need_a_choice_through_the_chain()   // defaultProfile None, routes.meeting none → needs_choice as today
```

- [ ] **Step 2: Run them and see them fail.** `cargo test fallback plugin_row meeting_notes_need`. Expected: FAIL.

- [ ] **Step 3: Implement** per spec §3. Every caller builds its `RunSpec` with `resolved.profile.id` and `resolved.model`; on a retry `run_resolved` replaces `profile_id` and sets `model: None`. Existing tests asserting `spec.profile_id` keep passing unchanged.

- [ ] **Step 4: Run** the whole Rust suite with the skip. Expected: all pass; `git grep -n "resolve_route\|self.route(" src-tauri/src` prints only `automations/run.rs` (Task 4).

- [ ] **Step 5: Commit**

```bash
git add src-tauri
git commit -m "feat(ai): fall back to the row's second profile before a run, and once after it could not run"
```

### Task 4: Automations on their template's row

**Files:**
- Modify: `src-tauri/src/workspace/automations/rules.rs` (`Automation.template: Option<String>`, kept on save)
- Modify: `src-tauri/src/workspace/automations/run.rs` (`automation_route` → `Resolved` on `row_of(a)`; `pinned` keeps the pin over the row; run record `fallbackFrom`; uses `run_resolved`)
- Modify: `ui/workspace/view-automations.js` (`draftFromAutomation`/`toAutomation` carry `template`; `aiSection` empty option "Default · <row> (<label>)"; `effectiveProfile` from `ai.chosen[row]`; Run log line "Ran on <fallback> because <profile> <reason>.")
- Modify: `ui/workspace/automations-controller.js` (`automation-template` sets `template: template.id` on the draft)
- Fixtures: regenerate `automation.json` (`template`), `automation-run-ok.json` (a run with `fallbackFrom`)
- Test: `rules.rs`, `run.rs` test modules; `ui/test/automations.test.mjs`

**Interfaces:**
- Consumes: Task 3 (`Resolved`, `run_resolved`), Task 2 (`RouteKey`, `chosen` in `ai_status`).
- Produces: `pub fn row_of(a: &Automation) -> RouteKey` (spec Values); `automation_run.data.fallbackFrom`; JS `routeRowOf(draft) -> 'briefing'|'triage'|'commitments'|'automation'` and `ROW_LABEL` shared with Task 5 (exported from `settings-ai.js`, see Task 5; until then defined in `view-automations.js` and moved there in Task 5).

- [ ] **Step 1: Write the failing tests**

```rust
#[test] fn template_is_kept_and_old_automations_read_without_it()   // JSON without template → None; save with "inbox-triage" round-trips
#[test] fn row_of_maps_templates()   // morning-brief→Briefing, inbox-triage→Triage, commitments→Commitments, draft-replies/None→Automation
#[tokio::test] async fn triage_runs_on_its_row_and_the_pin_still_wins()
// routes.triage {profile codemie:prod}; automation template inbox-triage, no pin → spec.profile_id "codemie:prod"; with pin claude → "claude"
#[tokio::test] async fn a_fallback_run_says_so_in_the_run_record()   // [Err(NeedsLogin), Ok] → run ok, data.fallbackFrom == chosen id
```

```js
test('use template records the template and the editor names its row')
// toAutomation(draftFromAutomation({...TEMPLATES inbox-triage, template:'inbox-triage'})).template === 'inbox-triage';
// aiSection with ai.chosen.triage {profile:'claude'} → first option text "Default · Inbox triage (Claude Code)"
test('run detail names a fallback run')   // automation-run-ok.json run with fallbackFrom → "Ran on Claude Code because CodeMie · prod …"
```

- [ ] **Step 2: Run them and see them fail.** `cargo test automations` and `node --test ui/test/automations.test.mjs`. Expected: FAIL.

- [ ] **Step 3: Implement** per spec §3 "Automations" and §5 "Automation editor". The reason in the Run log line is the failed attempt's message from the ledger record of that run's first attempt, else the chosen profile's state text.

- [ ] **Step 4: Run** the whole Rust suite with the skip, `npm test`, then the `automations` browser set. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri ui
git commit -m "feat(automations): briefing, triage and commitments run on their own row"
```

### Task 5: Settings › AI

**Files:**
- Modify: `ui/workspace/settings-ai.js` (`ROUTES`, `routeState`, `profileCard` facts and `not_running`, the "What each job uses" card replacing `defaultCard`, `nextAiSettings` for `fallback` and `plugin:<id>`, `PROVIDER_LABEL`, `ROW_LABEL`)
- Modify: `ui/workspace/ai-chooser.js` (`CHOOSER_TITLE`, Ollama line)
- Modify: `ui/workspace/view-settings.js` (tab label "AI" `:19`, description `:65`; pass `ctx.plugins` installed list to `aiPanel`)
- Modify: `ui/workspace/app.js` (`state.ai.chosen` from `ai_status`/`ai_settings_save`; `ai-route` handles `data-field="fallback"` and `data-route="plugin:<id>"`; `ai-default` handles model and fallback; the plugin list loaded for Settings › AI)
- Modify: `ui/workspace/workspace.css` (the two-line rows at narrow width)
- Test: `ui/test/ai-settings.test.mjs`

**Interfaces:**
- Consumes: Task 2 (`chosen`, `ai-route-cases.json`), Task 1 (`provider`, `not_running`).
- Produces:
  - `export const ROUTES` = `[{key, label, hint, group: 'replies'|'notes'|'automations'|'plugins'|null, parent: key|null, hidden?: true}]` in spec §2 order (Ask `hidden: true`);
  - `export function routeState(chosen, profiles, { savedModel } = {}) -> { state: 'working'|'fallback'|'broken'|'unset', text, using: profileId|null }`;
  - `export function aiPanel(ai, { codemie, plugins })` where `plugins` = installed views; rows for `p.enabled && p.agreed.includes('claude')`;
  - `export function nextAiSettings(settings, profiles, { field: 'default'|'defaultModel'|'defaultFallback'|'profile'|'model'|'fallback', purpose, value })`, `purpose` may be `plugin:<id>`.

- [ ] **Step 1: Write the failing tests**

```js
test('route_state_covers_working_fallback_broken_and_unset')
// ready profile → {state:'working'}; chosen needs_login + ready fallback → 'fallback', text starts "Using "; both unready → 'broken' with the chosen message;
// profile null → {state:'unset', text:'Nothing runs until you choose one.'}; ollama ready without savedModel in models → 'broken' "… doesn't offer qwen3:8b."
test('route_state_reads_profiles_after_the_codemie_sign_in_overlay')
// chosen codemie:prod (detection ready) + signIn {loaded, active:'prod', state:'not_signed_in'} → aiPanel row for it has no "Working" chip
test('ai_panel_draws_groups_plugin_rows_and_fallback_columns')
// ai-status.json: headings Replies, Summaries and notes, Automations, Plugins; rows mail_draft…plugin + plugin:knowledge; Ask row hidden;
// selects with aria-label "Inbox triage: fallback"; tab copy "What each job uses"; empty options "Same as Automations (…)"
test('same_as_labels_follow_the_native_groups')   // for each ai-route-cases.json case the row's "Same as" label names choose()'s group result
test('profile_cards_show_engine_and_provider_and_not_running')
// ollama profile → facts Engine "Ollama", Provider "Ollama"; not_running → chip "Not running" and "Ollama isn't running. Open Ollama, then check again."
test('next_ai_settings_handles_fallback_and_plugin_rows')
// {purpose:'plugin:knowledge', field:'profile', value:'claude'} → plugins.knowledge {profile:'claude'}; {purpose:'triage', field:'fallback', value:'codemie:prod'} → routes.triage {fallback}
test('next_ai_settings_keeps_a_model_when_its_profile_did_not_change')
// routes.plugin {profile:'codemie:ol', model:'qwen3:8b'} with ol listing no models; changing summary's profile keeps plugin's model
test('chooser_names_ollama')   // title "Choose which AI writes for you"; ollama option detail "Ollama · llama3.2:latest"
```

Update `next_ai_settings_resets_models_a_profile_does_not_offer` only where the new keys change its expectations; its four assertions stay true.

- [ ] **Step 2: Run them and see them fail.** `node --test ui/test/ai-settings.test.mjs`. Expected: FAIL.

- [ ] **Step 3: Implement** per spec §4, §5 and § Copy. Move `ROW_LABEL` here from Task 4 and import it in `view-automations.js`. The Status cell's "Check again" uses `data-action="ai-refresh"`.

- [ ] **Step 4: Run** `npm test`, then the browser sets `compact`, `layout` and the existing full-run Settings › Claude check (update its `route rows` count from 6 to the new visible count and its tab text). Look at Settings › AI at 1000 px in both views.

- [ ] **Step 5: Commit**

```bash
git add ui
git commit -m "feat(settings): Settings › AI with a fallback and a working status per job, and a row per plugin"
```

### Task 6: Status smoke facts

**Files:**
- Modify: `src-tauri/src/commands/status_smoke.rs` (`claude_report` `:652`: `chosen` per row with profile ids and models, each profile's `provider`, `ollama: {probed, running, models}`)
- Modify: `ui/workspace/status-smoke.js` only if it copies the Claude part (it reads `ai()`; keep it free of URLs)
- Test: `status_smoke.rs` test module

**Interfaces:**
- Consumes: Task 1, Task 2 (`ai_status` shape).
- Produces: report keys `claude.chosen`, `claude.profiles[].provider`, `claude.ollama`.

- [ ] **Step 1: Write the failing test**

```rust
#[test] fn status_smoke_reports_rows_and_ollama_without_urls()
// status with an ollama profile (state not_running, 0 models) and chosen {triage:{profile:"codemie:ol",fallback:"claude"}}:
// report["chosen"]["triage"]["fallback"] == "claude"; report["ollama"] == {"probed":true,"running":false,"models":0};
// serialized report contains no "http", no "apiKey"; a broken row adds nothing to the fail list
```

- [ ] **Step 2: Run it and see it fail.** `cargo test status_smoke`. Expected: FAIL.

- [ ] **Step 3: Implement.** `probed` = any profile with provider `ollama` that is local (its state is one the probe sets: `ready`, `not_running`, `not_configured`, `not_installed`); `running` = any such profile not `not_running`/`not_installed`; `models` = the largest model count among them.

- [ ] **Step 4: Run** `cargo test status_smoke` and the whole suite with the skip. Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add src-tauri ui
git commit -m "feat(status-smoke): report each job's profile and fallback, and whether Ollama answers"
```

### Task 7: Browser check set `ai-routes-checks.mjs`, and the guides

**Files:**
- Create: `ui/test/browser/ai-routes-checks.mjs`
- Modify: `ui/test/browser/workspace-e2e.mjs` (mock `ai_status` answers `chosen` from `ai-status.json` and a named state chosen by a test hook: `ollama-running`, `ollama-down`, `ollama-no-model`; mock `ai_settings_save` records the call and answers `{settings, chosen}` from `ai-route-cases.json` or a recomputed copy; mock `plugins_request list` includes an enabled plugin with `claude` agreed; the `WORKSPACE_E2E_ONLY` list `:1565` gains `ai-routes`; the full run calls `aiRoutesChecks` after `menuBarChecks`; header comment `:1564`)
- Modify: `.ai-run/guides/architecture/architecture.md` (`ai/` row: Ollama through CodeMie, `ollama list`; `workspace/ai.rs`: rows, groups, `choose`, `resolve`, `run_resolved`, `chosen`; Settings › AI), `.ai-run/guides/testing/testing-patterns.md` (browser sets gain `ai-routes`; fixtures gain `ai-route-cases.json`; the status smoke's `chosen` and `ollama` facts)

**Interfaces:**
- Consumes: `open({ theme, width, height, hash, settings, workspace, localPrefs, ai })`, `check`, `assert`, `shot`, `settled`, `calls`, `OUT`; `noClip`, `CLIP_SELECTORS`, `FIXED_NOW` from `compact-checks.mjs`; the `noOverflow` pattern from `reply-checks.mjs`.
- Produces: `export async function aiRoutesChecks({ open, check, assert, shot, settled, calls, OUT })`.

- [ ] **Step 1: Write the checks.**
  - **R1 `ai-routes R1: <theme> <view> <width>`**, both themes × {compact, default} × {1000, 1440, 1680}: `#/settings/ai` shows the profile cards (Claude Code, two CodeMie, one Ollama with Engine "Ollama") and "What each job uses" with the four groups, the plugin row and the Status column; no horizontal overflow; `noClip` empty; screenshots `ai-routes-<theme>-<view>-<width>`.
  - **R2 statuses:** with `ollama-down`, the plugin row on the Ollama profile says "Not working" and "Ollama isn't running. Open Ollama, then check again."; the Inbox triage row with a ready fallback says "Using fallback"; with no default anywhere a row says "Choose a profile". Screenshot `ai-routes-states-<theme>-<view>`.
  - **R3 saves:** choosing a fallback on Inbox triage sends exactly one `ai_settings_save` with `routes.triage.fallback`; choosing a profile on the plugin row sends one with `plugins.<id>.profile`; the row's chip updates from the answer's `chosen`.
  - **R4 kept model:** with `ollama-down`, changing Summaries' profile sends a save that still carries the plugin row's model.
  - **R5 chooser:** the first-use chooser's title is "Choose which AI writes for you" and lists the Ollama line "Ollama · …".
  - **R6 automations:** the Inbox triage template's editor shows "Default · Inbox triage (…)"; a run detail with `fallbackFrom` shows "Ran on … because …".
  - **R7 parity:** the card's normalized `outerHTML` (ids stripped) is identical in Default and Compact.
  - **R8 no paid call:** opening Settings › AI, pressing Check again and changing rows sends no `ai_test`.

- [ ] **Step 2: Run** `WORKSPACE_E2E_ONLY=ai-routes …` outside the sandbox. Expected: R1–R8 PASS. Fix product code only in a `fix:` commit naming the check. Look at the 1000 px screenshots in both views.

- [ ] **Step 3: Commit**

```bash
git add ui/test/browser .ai-run/guides
git commit -m "test(settings): browser checks for Settings › AI rows, fallbacks and statuses in both views, both themes and three widths"
```

### Task 8: Definition of done

**Files:** none change unless a check fails; a fix goes in a `fix:` commit naming the check.

- [ ] **Step 1: Gates.** `make fmt-check lint test-js`, then `cd src-tauri && cargo test -- --skip ai::profiles::tests::detects_native_and_codemie_states_and_caches`. Expected: fmt and clippy clean; `npm test` no failures; every target `test result: ok`; `UPDATE_CONTRACT_FIXTURES=1 cargo test contract_fixtures` leaves `git status` clean.

- [ ] **Step 2: Whole browser run** in the background, outside the sandbox (about 40 minutes). Expected: `N/N browser checks passed`, covering ai-routes R1–R8 and every earlier set (plugins, meetings, meetings-view, meetings-settings, layout, analytics, compact, reply, tasks-dates, settings-tasks, tasks-provider, automations, menu-bar). For a known flaky check (layout E1, the Today hover label), re-run that set alone once and report both results.

- [ ] **Step 3: Headless smokes only** (no desktop driving; no live Claude or Ollama call). Ask the user to quit their Connect first if the status smoke refuses to run beside it; do not quit it for them.
  1. `cd src-tauri && cargo build`.
  2. `T=$(mktemp -d)/workspace`; copy `workspace.sqlite` (with `-wal` and `-shm`) from `~/Library/Application Support/com.epam.codemie.installer/workspace/` into it, never `credentials/`; `CODEMIE_WORKSPACE_TEST_DIR=$T CODEMIE_STATUS_SMOKE=status ./target/debug/app`. Expected: exit 0; the report's Claude part has `chosen` for every row and `ollama`; `grep -c 'http' "$TMPDIR"/connect-status-smoke.json` finds no base URL; no key or token.
  3. `CODEMIE_WORKSPACE_TEST_DIR=$(mktemp -d)/workspace CODEMIE_PLUGIN_SMOKE=/Users/Nikita_Levyankov/repos/codemie-ai/codemie-connect-marketplace ./target/debug/app`. Expected: exit 0.

- [ ] **Step 4: Compare** the R1 and R2 screenshots with the spec §5 mockup; name each difference as kept or as a follow-up.

- [ ] **Step 5: Show the user:** the gate results, the browser-run summary, the R1 and R2 screenshots in both views, the status smoke's `chosen` and `ollama` facts, the comparison, a note that the real app is checked in the end-of-rollout desktop pass, and the rulings list from the spec. Do not push.
