# Profiles and models · design

**Status:** written on 2026-11-24 from the rollout overview's decisions and the code. This is step 7 of `2026-11-22-workspace-next-rollout-design.md`. Decisions the overview leaves open are ruled on below, under "Rulings".
**Builds on:**
- the AI features (DESIGN 6.1/6.2): `src-tauri/src/ai/` (`profiles` detection of the native Claude Code and of each CodeMie profile, `command::build_command`, `ClaudeRunner` / `CliRunner`, `FakeRunner`), `src-tauri/src/workspace/ai.rs` (`AiSettings {defaultProfile, routes}`, `Purpose`, `resolve_route`, `ai_status`, `ai_settings_save`, `ai_test`, the `ai_run` ledger) and Settings › Claude (`ui/workspace/settings-ai.js`, `ai-chooser.js`);
- step 5, `2026-11-24-create-tasks-templates-design.md`: the Morning briefing (`morning-brief`), Inbox triage (`inbox-triage`) and Commitments (`commitments`) templates, which run as automations on the `automation` route unless the automation pins its own profile;
- step 6, `2026-11-24-menu-bar-count-design.md`: "needs fixing" (amber) and its six conditions, among them an enabled automation whose newest run failed.

**Reference (read-only):** the overview's words for this step and the user's: "I want to have ability to configure profiles and models similar to [the reference app] as for crafting replies", and "claude, ollama (similar to [the reference app])". The overview's "Not ported" excludes the reference app's engine routes, its config editing and its Terminal logins. This design reconciles the two: Connect gets **its own** routes in its own Settings, over the profiles Connect already detects; it does not read, write or imitate the reference app's config, and it never edits the CodeMie CLI's config.

## Intent

Connect already lets the user pick a default Claude profile and route six purposes (mail replies, Teams replies, summaries, automations, plugins, meeting notes) to another profile and model. The user wants what they have in the reference app: each job on the profile and model they choose, a second profile to fall back to when the first can't run, a status per row that says whether it works right now, and Ollama as a second engine beside Claude.

This step adds the jobs the rollout introduced (Morning briefing, Inbox triage, Commitments, and Ask for step 9), one row per plugin that asks for AI, a fallback per row, a working status per row from detection Connect already runs (plus one local Ollama probe), and Ollama through a CodeMie profile whose provider is `ollama`.

## Goals

- **Rows for the new jobs:** Morning briefing, Inbox triage and Commitments (automations made from those templates), and Ask (defined now, shown when step 9 lands).
- **One row per plugin** that has the `claude` permission agreed and is enabled.
- **A fallback profile per row.** A run whose profile can't run uses the fallback, before the run or once after it failed for a reason that says the profile itself is unusable.
- **A working status per row** from cached detection: Working, Using fallback, Not working, or Choose a profile. No paid call, no network call to a provider.
- **Ollama** as an engine: a CodeMie profile whose provider is `ollama` is labelled Ollama, its models are the ones the local Ollama has, and its state says whether Ollama is running.
- **Migration with no rewrite:** today's saved default and routes keep doing exactly what they do.
- **Compact and Default** draw the same markup; Compact differs only through the step-1 tokens.

## Non-goals

- The Ask feature (step 9) and reply in the user's voice (step 8). Ask gets its route here; step 8 needs none (§2).
- Codex, pi, opencode or any engine other than Claude Code and CodeMie (`codemie-claude`), Ollama included through CodeMie.
- Editing CodeMie profiles, their providers or keys. Settings › CodeMie stays the only place that changes `~/.codemie/codemie-cli.config.json`, through the CLI.
- Terminal logins. The existing "Open Terminal and run `claude`, then type `/login`" steps and CodeMie's browser sign-in stay as they are.
- `ollama pull`, starting Ollama, or any Ollama management. Connect says what is missing; the user does it.
- A test call per row. The per-profile Test button (a paid call the user starts) stays on the profile cards.
- Real-desktop screenshots. They are deferred to one announced pass at the end of the rollout.

## Anti-goals

- **A paid call to show a status.** Statuses come from detection (`claude --version`, `--help`, `auth status`, the CodeMie config, `ollama list`), cached 30 s, refreshed when Settings opens or Check again is pressed. Never from a Claude or model call.
- **A network call in tests.** Detection goes through `CommandProbe`; tests use a fake probe. Runs use `FakeRunner`.
- **Secrets on screen or in the snapshot.** No API key, token or `apiKey` field is read into a profile, a route, the ledger, the status smoke or a fixture. The CodeMie base URL is read only to decide whether Ollama is local, and is not shown or stored.
- **Silent double billing.** A fallback after a failed run happens at most once, never after a timeout, invalid output, a failure of the prompt itself or a cancel, and every attempt is in the ledger.
- **Changing what a saved setup does.** A user who never opens Settings sees every job on the same profile and model as before.
- **Dropping a model choice because Ollama was closed.** A saved model is kept while its profile is temporarily unable to list it; the row says it is not working instead.

## Approaches considered

| Approach | Trade-off | Decision |
|---|---|---|
| **A. Extend Connect's own `settings.ai`:** more purposes, plugin routes, a fallback field; Rust resolves a row through its group; Rust answers the resolved choice per row with `ai_status` and `ai_settings_save`; the window draws the status from the profiles it already shows. | Small model change; one resolution rule (Rust); today's settings read unchanged; statuses agree with the profile cards because both read the same profile states. | **Chosen** |
| B. Port the reference app's engine routes and config. | Familiar to the user, but the overview's "Not ported" excludes it and it would add a second config file beside the CodeMie one. | Rejected |
| C. A route per saved automation instead of per template. | Precise, but rows grow with every automation and duplicate the editor's own Claude pin, which already does this. | Rejected: the pin stays the per-automation choice |
| D. Ollama as its own engine (`ollama run` / HTTP). | No CodeMie needed, but a second runner without the isolation flags, the stream parser or the ledger; the overview says "through a CodeMie profile". | Rejected |
| E. Statuses from a dry-run per row. | Most truthful, but a dry run of Claude is a paid call. | Rejected: anti-goal |

## Design

### 1. Profiles and the Ollama engine (`ai::profiles`)

`AiProfile` gains `provider: Option<String>`: the CodeMie profile's `provider` (`ai-run-sso`, `litellm`, `bedrock`, `ollama`, `anthropic-subscription`, …), `None` for the native Claude Code. It is not a secret; Settings › CodeMie already shows it. The window calls a profile's engine **Ollama** when `provider == "ollama"`, else **Claude**.

`ProfileState` gains `NotRunning` ("Ollama isn't running.").

`codemie_config::ProfileSummary` gains `base_url: String` (the profile's `baseUrl`), read only to decide where Ollama is. It never leaves `ai::profiles`.

**An Ollama profile** (a CodeMie profile whose provider is `ollama`) is detected as today (the `codemie-claude` launcher and the profile must exist), then:
- **Local or remote.** Local when `baseUrl` is empty, or its host is `localhost`, `127.0.0.1` or `[::1]` with no port or port `11434`. Anything else is remote: not probed, `Ready` as other CodeMie profiles are (the first run proves it), models from the config only.
- **The probe** (local only, once per detection whatever the number of Ollama profiles): find `ollama` with `find_program_in` (extra dir `/Applications/Ollama.app/Contents/Resources`) and run `ollama list` through `CommandProbe` (15 s timeout, no stdin).
  - no `ollama` program → `NotInstalled`, "Ollama is not installed on this Mac.";
  - the command fails or times out → `NotRunning`, "Ollama isn't running. Open Ollama, then check again.";
  - it answers → its model names (first column after the header line).
- **Models** offered by an Ollama profile: the pulled models, then the config's models not among them. A name without a tag means `:latest` when comparing (`llama3.2` is `llama3.2:latest`).
- **State:** `Ready` when the profile's default model is pulled; `NotConfigured` with "Ollama doesn't have <model>. Pull it in Ollama, then check again." when it is not.

`ollama list` talks to the local Ollama server only. It is the one new probe; it is cached with the rest of detection (30 s, 10 s after a failure) and never runs in tests (fake probe).

Runs are unchanged: an Ollama profile runs through `codemie-claude --profile <name>` with the isolated, tool-free flags of `build_command`, exactly like any CodeMie profile.

### 2. Rows and groups (`workspace::ai`)

`Purpose` gains `Briefing`, `Triage`, `Commitments` and `Ask` (wire names `briefing`, `triage`, `commitments`, `ask`). A row is a `RouteKey`: a `Purpose`, or a plugin id.

| Row | Key | Group (used when the row sets nothing) | Used by |
|---|---|---|---|
| Default | — | — | every row that sets nothing up its chain |
| Mail replies | `mail_draft` | Default | AI drafts for mail (step 8's voice context rides on these drafts) |
| Teams replies | `chat_draft` | Default | AI drafts for Teams |
| Summaries | `summary` | Default | thread and day summaries |
| Meeting notes | `meeting` | Default | note templates, automatic notes, Formal summary |
| Morning briefing | `briefing` | Automations | automations made from the `morning-brief` template |
| Inbox triage | `triage` | Automations | automations made from `inbox-triage` |
| Commitments | `commitments` | Automations | automations made from `commitments` |
| Automations | `automation` | Default | every other automation |
| Ask | `ask` | Default | step 9's ⌘K box; hidden until step 9 |
| All plugins | `plugin` | Default | plugins without a row of their own set |
| <Plugin name> | plugin id | All plugins | that plugin's `ctx.claude.run` |

Step 8 (reply in the user's voice) adds context to the reply drafts, which already run on Mail replies and Teams replies; a `reply-context` plugin that itself asks for AI gets its plugin row. No `reply_voice` route.

**Settings shape** (`settings.ai`, every field optional, old settings read as they are):

```json
{ "defaultProfile": "claude", "defaultModel": null, "defaultFallback": "codemie:prod",
  "routes":  { "summary": {"profile": "codemie:prod", "model": "claude-haiku-4-5"},
               "triage":  {"fallback": "codemie:local-ollama"} },
  "plugins": { "knowledge": {"profile": "codemie:local-ollama", "model": "qwen3:8b"} } }
```

`Route` gains `fallback: Option<String>`. `AiSettings` gains `default_model`, `default_fallback` and `plugins: BTreeMap<String, Route>` (keys are valid plugin ids).

**Resolution** (`choose(settings, key) -> Chosen {profile, model, fallback}`, pure, the only place the rule lives):
- **Profile and model go together.** A row that sets its own profile uses its own model (empty = the profile's default). A row that sets no profile takes its group's profile, and its own model if it set one, else the group's model. Up the chain to Default.
- **Fallback is its own field:** the row's, else its group's, up to `defaultFallback`. A fallback equal to the row's chosen profile is no fallback.
- No profile anywhere: `profile: None` (the caller asks the user, `needs_choice`, as today).

`ai_status` answers `{profiles, settings, chosen}`; `ai_settings_save` answers `{settings, chosen}`. `chosen` has one entry per `Purpose` (`ask` included), `"default"`, and `"plugin:<id>"` for each saved plugin row. The window draws a plugin row with no saved entry from `chosen.plugin`.

**Validation** (`ai_settings_save`, refusals `validation` with these messages):
- every profile and fallback is a listed profile: "Choose one of the listed profiles.";
- a fallback differs from the profile it backs up: "The fallback must be a different profile.";
- a model is offered by the row's chosen profile, **or** it is the model already saved on that row with the same chosen profile (kept while Ollama is closed): "That model is not offered by this profile.";
- a plugin key is a valid plugin id: "That plugin is not known.";
- empty rows are dropped, as today.

### 3. Running with a fallback

`resolve(settings, profiles, key) -> Resolved {profile, model, fallback: Option<AiProfile>, fell_back_from: Option<String>}`:
- **Before the run:** the chosen profile is used when its state is `Ready`. Otherwise, when the fallback is `Ready`, the fallback is used with its own default model and `fell_back_from` names the chosen profile. Otherwise the chosen profile's own error is returned (as `unready_error` does today).
- **After the run:** `Core::run_resolved(resolved, spec, cancel, on_event)` runs once. When that run fails with `needs_login`, `not_installed`, `too_old`, `not_configured` or `rate_limited`, and a fallback is `Ready` and was not used yet, it records the failed attempt in the ledger and runs **once** more on the fallback (its default model). Timeout, invalid output, failed and cancelled never fall back.
- **The ledger** (`ai_run`) gains `fallbackFrom` on a run made on the fallback. Usage totals count both attempts.
- **Every caller** moves to `resolve` + `run_resolved`: AI drafts and summaries (`ai_jobs`), meeting notes (`notes_job`; `notes_ops`'s "is anything chosen" check uses `choose`), automations (`automations/run.rs`), plugins (`plugin_data::plugin_claude`). `ai_test` stays on one named profile, no fallback.

**Automations.** `Automation` gains `template: Option<String>`, the gallery template it was made from, set by Use template and kept by edits. Its row: `morning-brief` → `briefing`, `inbox-triage` → `triage`, `commitments` → `commitments`, anything else (or none) → `automation`. The automation's own pin (the editor's Claude section) still wins over its row, as `pinned` does today; the pin's fallback is its row's fallback. The run record gains `fallbackFrom`; the Run log detail says "Ran on <fallback label> because <chosen label> <reason>." Automations saved before this step have no `template` and keep the Automations row.

**Plugins.** A plugin's run uses, in order: its own row when the user set a profile on it; else the profile the plugin names in `ctx.claude.run({profile})` (as today); else All plugins, else Default. A model the plugin names is used only when the profile in use offers it (as today). The fallback is the plugin row's chosen fallback.

### 4. Working status per row (window)

`routeState(chosen, profiles, savedModel) -> {state, text, using}` in `settings-ai.js`, pure, over the profiles **after** `withCodemieSignIn`, so a row and its profile card never disagree:

| State | When | Chip | Text |
|---|---|---|---|
| `working` | the chosen profile is `ready` and offers the model (or none is set) | success "Working" | "<profile> · <model or Profile default>" |
| `fallback` | the chosen profile isn't ready (or lacks the model) and the fallback is `ready` | warning "Using fallback" | "Using <fallback>: <chosen's reason>" |
| `broken` | neither can run | error "Not working" | the chosen profile's message, or "<Profile> doesn't offer <model>." |
| `unset` | no profile is chosen | neutral "Choose a profile" | "Nothing runs until you choose one." |

The statuses come from the detection Settings already runs when it opens (`ai_status {refresh: true}`) and from Check again. Drawing never probes.

### 5. Settings › AI

The tab keeps its id `ai`; its label becomes **AI** (was Claude), its description "Which profile and model does each job, a fallback for each, and what it costs."

**Profiles** (the cards, as today) gain:
- facts: "Engine" (Claude or Ollama) and "Provider" (the CodeMie provider's label: CodeMie SSO, LiteLLM, AWS Bedrock, Ollama, Anthropic subscription, Moonshot subscription; the raw id otherwise) in place of "Provider: CodeMie";
- for `not_running`: chip "Not running" (warning), text "Ollama isn't running. Open Ollama, then check again.", action Check again;
- for an Ollama `not_configured`: the profile's message and Check again.

**What each job uses** replaces "Which Claude writes for you": the Default row (profile, model, fallback) as a setting row, then a table with groups **Replies** (Mail replies, Teams replies), **Summaries and notes** (Summaries, Meeting notes), **Automations** (Morning briefing, Inbox triage, Commitments, Automations), **Plugins** (All plugins, then one row per enabled plugin with `claude` agreed, by name); Ask is in the list and hidden until step 9.

Each row: the job and its hint, Profile, Model, Fallback, Status.
- Profile: "Same as <group> (<label>)" first, then the ready profiles, then a saved profile that isn't ready "(not ready)".
- Model: the chosen profile's models with "Profile default" first; disabled until a profile is chosen somewhere.
- Fallback: "Same as <group> (<label or None>)" first, then the ready profiles other than the row's chosen profile, then a saved one that isn't ready "(not ready)".
- Status: the chip and text of §4; for `broken`, a "Check again" button.

`nextAiSettings` (pure) handles the new rows, `field: 'fallback'` and plugin keys (`plugin:<id>`), and drops a model only when the row's chosen profile changed in this edit and the new one doesn't offer it.

At 1000 px the table becomes rows of two lines (job and status on the first, the three selects on the second); no horizontal scroll at any width.

```
┌ What each job uses ────────────────────────────────────────────────────────┐
│ Default   [Claude Code ▾] [Account default ▾]  Fallback [CodeMie · prod ▾] │
│                                                                            │
│ Replies                                                                    │
│ Mail replies   [Same as Default (Claude Code) ▾] [Profile default ▾]       │
│                [Same as Default (CodeMie · prod) ▾]        ● Working       │
│ Automations                                                                │
│ Inbox triage   [Same as Automations (Claude Code) ▾] [ … ▾]                │
│                [CodeMie · local-ollama ▾]   ▲ Using fallback               │
│                Using CodeMie · local-ollama: Claude is not signed in.      │
│ Plugins                                                                    │
│ Knowledge      [CodeMie · local-ollama ▾] [qwen3:8b ▾] [Same as … ▾]       │
│                                             ✕ Not working  [Check again]   │
│                Ollama isn't running. Open Ollama, then check again.        │
└────────────────────────────────────────────────────────────────────────────┘
```

**First-use chooser:** title "Choose which AI writes for you"; an Ollama profile's line reads "Ollama · <default model>"; the rest as today.

**Automation editor:** the Claude section's empty Profile option names the row it uses: "Default · <row> (<label>)", for example "Default · Inbox triage (Claude Code)". The cost cap stays CodeMie-only.

### 6. Needs fixing (menu bar)

A broken row does **not** add an amber condition. A row matters when something runs on it, and step 6 already turns amber when an enabled automation's newest run failed (a run that fell back and succeeded is `ok`, so it does not). On-demand jobs (drafts, summaries, notes, plugins, Ask) show their error where the user started them. The Settings row says what is wrong in the meantime.

### 7. Native operations and shapes

No new operation and no new Tauri command. `ai_status` gains `chosen`; `ai_settings_save` accepts the new fields and answers `chosen`; `automation_save` accepts `template`; `ai_run` and `automation_run` data gain `fallbackFrom`; `AiProfile` gains `provider`; `ProfileState` gains `not_running`.

Contract fixtures that change: `ai-status.json` (an Ollama profile, a fallback, a plugin row, `chosen`), `automation.json` (`template`), `automation-run-ok.json` (a run with `fallbackFrom`), and any fixture carrying `settings.ai` or profiles. New: `ai-route-cases.json` (settings and the expected `chosen` per key, written from `choose`, which the JS tests read to check that the window's "Same as" labels name the right group).

**Status smoke:** the Claude part of `connect-status-smoke.json` gains `chosen` per row (profile ids and models only) and each profile's `provider` and state, and `ollama: {probed, running, models: <count>}`. A broken row is reported, not failed: the user's setup is not a defect.

## Copy

- **Tab:** "AI"; description "Which profile and model does each job, a fallback for each, and what it costs."
- **Card:** "What each job uses"; Default row text "Used for every job below unless you pick another."
- **Groups:** "Replies", "Summaries and notes", "Automations", "Plugins".
- **Rows and hints:** "Mail replies" "Drafts for Outlook messages."; "Teams replies" "Drafts for Teams chats."; "Summaries" "Thread and day summaries."; "Meeting notes" "Notes and summaries from transcripts."; "Morning briefing" "Automations made from the Morning briefing template."; "Inbox triage" "Automations made from the Inbox triage template."; "Commitments" "Automations made from the Commitments template."; "Automations" "Every other automation, unless it picks its own profile."; "Ask" "Questions you type in ⌘K."; "All plugins" "Plugins without a choice of their own."; a plugin row "Your choice here wins over the profile the plugin asks for."
- **Columns:** "Job", "Profile", "Model", "Fallback", "Status".
- **Options:** "Same as <group> (<label>)", "Same as <group> (None)", "Profile default", "(not ready)".
- **Statuses:** "Working", "Using fallback", "Not working", "Choose a profile"; "Using <fallback>: <reason>"; "<Profile> doesn't offer <model>."; "Nothing runs until you choose one."
- **Profiles:** facts "Engine", "Provider"; chip "Not running"; "Ollama is not installed on this Mac."; "Ollama isn't running. Open Ollama, then check again."; "Ollama doesn't have <model>. Pull it in Ollama, then check again."
- **Refusals:** "Choose one of the listed profiles.", "The fallback must be a different profile.", "That model is not offered by this profile.", "That plugin is not known."
- **Chooser:** "Choose which AI writes for you"; "Ollama · <model>".
- **Automation editor:** "Default · <row> (<label>)".
- **Run log:** "Ran on <fallback> because <profile> <reason>."
- The privacy line stays: "The message text you draft from is sent to this provider. Runs are isolated and tool-free, and Connect never sends a reply without your review."

## Accessibility

- Each select has an `aria-label` naming the row and the column ("Inbox triage: fallback").
- The status chip is text, never colour alone; the reason is a sentence beside it.
- The group headings are `th scope="rowgroup"` in the table (or headings in the two-line layout), so a screen reader names the group.
- A hidden Ask row is `hidden`, not styled away.
- Text stays at or above the step-1 minimum in Compact; focus rings unchanged.

## Rulings

Each ruling says what it costs if it is wrong.

1. **Rows for Morning briefing, Inbox triage, Commitments and Ask are added; budget request reply, Formal summary and the other templates have none** (budget runs on Automations, Formal summary on Meeting notes). *If wrong:* a user who wants the budget reply on another model pins it in the automation's editor, which already works.
2. **Ask's row exists now and is hidden until step 9.** *If wrong:* the user can't pre-set Ask; it uses Default until step 9 shows the row.
3. **Step 8 gets no route of its own;** its context rides on Mail and Teams replies, and a reply-context plugin that runs AI gets a plugin row. *If wrong:* step 8 adds one `Purpose` and one row.
4. **One row per enabled plugin with `claude` agreed, under All plugins; the user's choice on a plugin row wins over the profile the plugin names.** *If wrong:* a plugin whose author pinned a profile for a reason is overridden by the user's choice; the user clears the row to restore it.
5. **A row that sets nothing is its group's: briefing, triage and commitments under Automations, plugin rows under All plugins, the rest under Default.** *If wrong:* a user who set Automations to CodeMie sees triage on CodeMie too, which they change on the triage row.
6. **Profile and model inherit together; fallback inherits on its own, and there is no "no fallback" override below a group that has one.** *If wrong:* a row can't refuse its group's fallback; the user clears the fallback on the group.
7. **The fallback is a profile, run with its own default model.** *If wrong:* the fallback can't be pinned to a cheaper model; a `fallbackModel` is one more field.
8. **Fallback happens before the run when the chosen profile isn't ready, and once after a run that failed with needs_login, not_installed, too_old, not_configured or rate_limited; never after timeout, invalid output, failed or cancelled.** *If wrong:* a rate-limited subscription user is billed by the CodeMie fallback without noticing; the ledger and the Run log name every fallback run.
9. **"Working" means the profile is ready by detection (Claude Code version, flags and sign-in; CodeMie launcher and profile, plus Settings › CodeMie's sign-in for the active profile; for local Ollama, `ollama list` answering and the model pulled) and offers the row's model.** It is not a test call. *If wrong:* a row says Working while the provider would refuse the call (an expired CodeMie key for a non-active profile); the first run then fails and falls back, and Test proves it on demand.
10. **Ollama is reached only through a CodeMie profile whose provider is `ollama`; only a local Ollama (empty base URL, or loopback on 11434) is probed, with `ollama list`.** *If wrong:* an Ollama on another port or host shows Ready until its first run; adding `OLLAMA_HOST` to the probe is one line.
11. **An Ollama profile offers the pulled models plus the config's; `llama3.2` matches `llama3.2:latest`.** *If wrong:* a model with an unusual tag shows as not pulled; the user picks the exact name from the list.
12. **Migration rewrites nothing:** old `settings.ai` reads as is; automations saved before this step have no `template` and keep the Automations row. *If wrong:* a Morning briefing made in a step-5 debug build stays on Automations until the user makes it again from the template or pins it.
13. **A saved model is kept while its profile can't list it (Ollama closed); only a profile change in the same edit drops it.** *If wrong:* a model removed from Ollama for good stays saved and the row says Not working until the user picks another.
14. **A broken row does not turn the menu bar amber;** a failed automation run already does, and a fallback that worked is not a failure. *If wrong:* a broken row for an on-demand job is noticed when it is used, where its error explains the fix.
15. **The Settings tab is called AI (id unchanged), and the cards say profile, not Claude.** *If wrong:* a user looks for "Claude" in Settings once.
16. **One resolution rule, in Rust (`choose`); the window draws the status from `chosen` and the profiles it already shows, after the CodeMie sign-in overlay.** *If wrong:* `chosen` is one more field in two answers; the fixture `ai-route-cases.json` catches drift in the window's labels.
17. **No per-row Test; the paid Test stays on the profile cards.** *If wrong:* the user tests a profile, not a row's model; the profile card's model picker covers it.
18. **The status smoke reports rows and Ollama facts and never fails on a broken row.** *If wrong:* a broken setup passes the smoke; the report still shows it.

## Definition of done

1. **Quality gates** (`.ai-run/guides/quality-gates.md`): `make fmt-check`, `make lint`, `npm test`, `cargo test` (with the known skip), the contract fixtures regenerated and committed.
2. **Browser run, new checks:** `ui/test/browser/ai-routes-checks.mjs` (`WORKSPACE_E2E_ONLY=ai-routes`): Settings › AI with Claude Code, two CodeMie profiles and an Ollama profile (running, not running, model not pulled); the What each job uses table with every group, a plugin row, a fallback in use, a broken row and an unset state; choosing a fallback and a plugin row's profile sends one `ai_settings_save` each; the chooser with an Ollama line; the automation editor's route label; a run detail with "Ran on …"; in both themes, in Compact and Default, at 1000 / 1440 / 1680 px, no horizontal overflow, screenshots saved.
3. **Browser run, no regressions:** the whole `workspace-e2e.mjs` run passes (plugins, meetings, meetings-view, meetings-settings, layout, analytics, compact, reply, tasks-dates, settings-tasks, tasks-provider, automations, menu-bar and the new set), with the existing Settings › Claude check updated for the new rows.
4. **Headless smokes only** (real-desktop screenshots are deferred to the announced pass at the end of the rollout): `CODEMIE_STATUS_SMOKE=status` on `CODEMIE_WORKSPACE_TEST_DIR` passes with its new `chosen` and `ollama` facts, and `CODEMIE_PLUGIN_SMOKE=<codemie-connect-marketplace>` passes. No live Claude or Ollama run.
5. **A comparison with this design's own mockup** (§5): the browser screenshots beside it, each difference named as kept or as a follow-up.

## Left to the builder

- Exact CSS within the step-1 tokens, and the breakpoint of the two-line rows, as long as nothing scrolls sideways at 1000 px.
- Whether `RouteKey` is an enum or a string with a parser, as long as the wire names above hold.
- How `run_resolved` shares `on_event` between two attempts (an `Arc` turned into a fresh `Box` per attempt is enough).
- The profile icon for an Ollama card, from the existing icon set.
- Plan order. Suggested: Ollama detection; rows, resolution and validation; running with a fallback; automations and plugins on their rows; Settings › AI; the status smoke; the browser checks; the definition of done.
