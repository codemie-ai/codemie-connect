# CodeMie Desktop — POC Scope and Estimations

## Rationale

The goal is a working, demonstrable end-to-end path as fast as possible:
**install → sign in → configure a profile → install an agent → verify health.**

Everything beyond that path is Stage 2. Specifically deferred:

- CI/CD build pipeline automation ([EPMCDME-14571](https://jiraeu.epam.com/browse/EPMCDME-14571) / T2)
- Windows platform (T4)
- macOS code signing and notarisation (EPMCDME-14508)
- Automated release pipeline (EPMCDME-14630)
- App self-update (EPMCDME-14507)
- Full command log screen (EPMCDME-14512)
- **Connections screen** (`codemie proxy`, proposed in design comment by N.Levyankov — not in scope for POC)
- **Client app installation** (Claude Desktop / VS Code / Codex download and connect — proposed in design comment, not in scope for POC)
- **Launching an agent from the app** (removed per design comment — running an agent is terminal work)
- CLI usage analytics (deferred per design comment)
- **Profile management** — listing, switching, renaming and deleting profiles. The single profile created by guided setup is active and readable by the CLI (shared `~/.codemie/codemie-cli.config.json`); any further profile lifecycle management is Stage 2. New ticket required — see Stage 2 table.

SSO and profile configuration (EPMCDME-14513, EPMCDME-14515) are **essential** and not negotiable for the POC.

---

## Stage 1 — POC Estimates

| # | Ticket | POC name | Best (days) | Worst (days) | SP | Notes |
|---|--------|----------|-------------|--------------|----|----|
| T1 | [14504](https://jiraeu.epam.com/browse/EPMCDME-14504) | Spike: validate complete pre-assembled bundle inside signed macOS app bundle | 2 d | 5 d | **8** | Full scope — gates everything, can't cut |
| T5 | [14581](https://jiraeu.epam.com/browse/EPMCDME-14581) | Rename standalone CLI binary (`<new-name>` TBD) to distinguish from npm-installed `codemie` | 1–2 d | 2–3 d | **3** | Prerequisite for T3; new name TBD — implement once name is decided |
| T3 | [14572](https://jiraeu.epam.com/browse/EPMCDME-14572) | macOS shim + runtime wiring + PATH (manual build, no CI) | 3–4 d | 6–8 d | **8** | Reduced: no CI integration, manual `tauri build` only; depends on T5 |
| S2 | [14505](https://jiraeu.epam.com/browse/EPMCDME-14505) | Per-user install handshake + npm precedence warning | 2–3 d | 4–6 d | **3** | Reduced: basic handshake; edge cases deferred |
| S8 | [14511](https://jiraeu.epam.com/browse/EPMCDME-14511) | App shell — vanilla JS navigation skeleton (existing tech stack) | 3–5 d | 5–8 d | **5** | Reduced: extend existing renderer.js; no framework migration |
| S12 | [14515](https://jiraeu.epam.com/browse/EPMCDME-14515) | Sign-in + Home (SSO login, home state, broken profile delete) | 4–6 d | 8–11 d | **8** | Reduced: SSO path only, no onboarding checklist UX |
| S10 | [14513](https://jiraeu.epam.com/browse/EPMCDME-14513) | Guided setup — 6 decisions, SSO + API key providers, model select | 7–10 d | 12–16 d | **13** | Reduced: basic step UI; fast path deferred; PTY output parsing is the chosen approach |
| S3 | [14506](https://jiraeu.epam.com/browse/EPMCDME-14506) | Health screen — doctor output, pass/fail list, open log | 3–5 d | 6–9 d | **5** | Reduced: no per-failure remedies, no grouped-by-actor layout |
| S11 | [14514](https://jiraeu.epam.com/browse/EPMCDME-14514) | Agents — list, install, uninstall, progress, update badge | 5–7 d | 9–12 d | **8** | Reduced: no agent launch, no detail panel |
| S7 | [14510](https://jiraeu.epam.com/browse/EPMCDME-14510) | Claude Desktop connect carry-forward — re-home connect + restart actions into new shell | 1–2 d | 2–3 d | **3** | Re-homing only (existing `runAction` / `ensureAuthenticated`); full Connections screen deferred |
| S6a | [14509](https://jiraeu.epam.com/browse/EPMCDME-14509) | Product branding rename — CodeMie Connect → Desktop (tauri.conf.json, package.json, README, docs site, GitLab repo description) | 1–2 d | 2–4 d | **3** | Independent — can run in parallel with any Stage 1 ticket; final product name must be confirmed first |

> T1 and T3 can run in parallel with S8. T3 depends on T1 for approach confirmation. T5 can run in parallel with T1 and S8; T3 depends on both T1 and T5. S7 depends on S8 and can run in parallel with S12, S10, S3, and S11.

### POC totals

| | Best (days) | Worst (days) |
|--|-------------|--------------|
| Sequential | 34–50 d | 60–90 d |
| Parallel (T1 ‖ T5 ‖ S8 start together; T3 after T1 and T5; S7 after S8; S6a in parallel with any ticket) | ~27–38 d | ~47–69 d |

---

## Stage 2 — Deferred

| # | Ticket | Name | Original Best | Original Worst | SP |
|---|--------|------|---------------|----------------|----|
| T2 | [14571](https://jiraeu.epam.com/browse/EPMCDME-14571) | Build pipeline: vendor Node.js runtime + CLI at CI build time | 3–4 d | 5–7 d | 5 |
| T4 | [14573](https://jiraeu.epam.com/browse/EPMCDME-14573) | Windows: bundled Node.js shim, runtime wiring, PATH registration | 4–6 d | 8–10 d | 8 |
| S4 | [14507](https://jiraeu.epam.com/browse/EPMCDME-14507) | Self-update | 5–8 d | 12–15 d | 8–13 |
| S5 | [14508](https://jiraeu.epam.com/browse/EPMCDME-14508) | Code signing (macOS notarisation + Windows Authenticode) | 3–5 d | 7–10 d | 5–8 |
| S6b | [14630](https://jiraeu.epam.com/browse/EPMCDME-14630) | Release pipeline — automated build, signing, and artifact publication | 4–7 d | 10–13 d | 7 |
| S9 | [14512](https://jiraeu.epam.com/browse/EPMCDME-14512) | Command log (full screen with raw output) | 4–6 d | 8–12 d | 8–13 |
| — | [14574](https://jiraeu.epam.com/browse/EPMCDME-14574) | Connections screen (`codemie proxy` for Claude Desktop / VS Code / Codex) | 5–8 d | 12–18 d | 8–13 |
| — | [14575](https://jiraeu.epam.com/browse/EPMCDME-14575) | Client app installation (download + install Claude Desktop / VS Code etc.) | 4–7 d | 10–15 d | 8–13 |
| — | [14576](https://jiraeu.epam.com/browse/EPMCDME-14576) | Profile management — list, switch, rename, delete profiles; active profile change reflected in terminal | 4–6 d | 8–12 d | 8–13 |

---

## POC ticket descriptions

---

### T1 — Spike: validate complete pre-assembled bundle inside a signed macOS app bundle

**Ticket:** EPMCDME-14504-T1
**Estimates:** Best 2 d / Worst 5 d / **8 SP**
**Scope change from full:** None — the spike cannot be cut. If it fails, Stage 1 stops.

#### What this covers

Validate that the complete pre-assembled bundle — Node.js runtime + pre-bundled CLI JS files — executes correctly when invoked from inside a signed and notarised macOS `.app` bundle. This is the highest-risk unknown in the epic: if Gatekeeper or sandbox restrictions block the bundled `node` binary from running, the entire "no prerequisites" premise collapses.

Two approaches tested in parallel (see `estimations2.md` → S1-T1 for full details):
- **Approach A** — `bundle.resources` with the portable Node.js tar.gz
- **Approach B** — Tauri `externalBin` sidecar

**Timebox: 2 working days.** Output is either a working demo or a spike report naming the exact failure.

#### What the demo must prove

1. macOS machine with no Node.js, no npm — install the test build.
2. `codemie --version` prints a version — the bundled runtime's version on a machine with no prior install, or the pre-existing installation's version if `codemie` was already on PATH before the app ran (EPMCDME-14581).
3. `codemie install [agent]` completes using only the bundled runtime.
4. `which node` does not return the bundle path (system Node.js, if any, is untouched).

#### Acceptance criteria

Working demo reproducible on a clean macOS aarch64 VM, OR spike report within 2 days naming failure, root cause, and recommended next step.

---

### T5 — Rename standalone CLI binary to distinguish from npm-installed `codemie`

**Ticket:** EPMCDME-14581
**Estimates:** Best 1–2 d / Worst 2–3 d / **3 SP**
**Scope change from full:** N/A — new ticket. New name is TBD; implement once decided.

#### What this covers

The bundled standalone binary and shim currently share the name `codemie` with the npm-installed CLI. This ticket renames the standalone binary to `<new-name>` (TBD) everywhere it is produced or referenced:

- `scripts/bootstrap.sh` — shim filename and internal `exec` call
- `tauri.conf.json` `bundle.resources` / `externalBin` declaration
- `pathman.rs::persist()` — PATH registration writes `~/.codemie/bin/<new-name>`
- `runner.rs` — absolute path used for app-internal invocation
- S2 precedence warning text — references `<new-name>` vs `codemie` by name
- T1 and T3 acceptance criteria demo steps

#### What is excluded

- Deciding the new name (prerequisite, handled outside this ticket).
- Renaming CLI sub-commands or flags (public API unchanged).
- Windows platform (T4 scope).

#### Acceptance criteria

- `<new-name> --version` works on a clean macOS machine after a manual build, and continues to resolve to an already-installed CodeMie CLI's version (not the bundled one) when one is present (EPMCDME-14581).
- `codemie --version` continues to resolve to the npm CLI if one exists (no regression).
- PATH registration at `~/.codemie/bin/<new-name>` is appended to `~/.zprofile`.
- S2 precedence warning correctly names both binaries.
- No hardcoded string `codemie` remains in the app referring to the bundled binary.

---

### T3 — macOS: bundled Node.js shim, runtime wiring, and PATH registration (POC build)

**Ticket:** EPMCDME-14504-T3
**Estimates:** Best 3–4 d / Worst 6–8 d / **8 SP**
**Scope change from full:** No CI pipeline integration. Developer runs `scripts/bootstrap.sh` and `tauri build` locally. T2 (automated CI download) is Stage 2.

#### What this covers

With T1 confirming the approach, place the Node.js runtime and CLI JS files inside the bundle manually (bootstrap script), write the `codemie.sh` shim, register `~/.codemie/bin` in `~/.zprofile` via the existing `pathman.rs::persist()`, and delete the old admin-elevated `install_node` macOS branch from `installer.rs`.

The `scripts/bootstrap.sh` script downloads and unpacks the Node.js tar.gz and runs `npm install @codemieai/code` locally — the same logic T2 will eventually automate in CI.

#### What is excluded (Stage 2 / T2)

- CI/CD automation of the download, SHA-256 verification, and placement.
- `NODE_VERSION` / `CLI_VERSION` pinning files feeding into `.gitlab-ci.yml`.
- Windows platform (T4).

#### Acceptance criteria

- `codemie --version` works on a clean macOS machine after a manual build, and reports the pre-existing installation's version instead of installing the bundled CLI when one is already on PATH (EPMCDME-14581).
- `codemie install [agent]` completes using only the bundled runtime.
- No admin prompt. PATH scoped to `~/.zprofile`.
- Existing system Node.js is unchanged.

---

### S2 — Per-user install handshake and npm precedence warning

**Ticket:** EPMCDME-14505
**Estimates:** Best 2–3 d / Worst 4–6 d / **3 SP**
**Scope change from full:** Edge-case handling (offline install, failed location, partial cleanup) deferred to Stage 2 along with Windows-specific installer nuances.

#### What this covers

Three distinct first-open states the app must handle:

1. **Clean machine** — no npm CLI, no profile. App starts the onboarding flow.
2. **Existing npm CLI, no profile** — app detects `codemie` on PATH from npm, warns which binary will take precedence after installation, and asks for confirmation before proceeding.
3. **Existing npm CLI, existing profile** — handshake path: the user is already set up. App shows a one-screen confirmation that the existing profile is found and active, skips guided setup.

#### What is excluded (Stage 2)

- Install-location-not-writable error state with cleanup verification.
- Offline install detection and messaging.
- Windows-specific NSIS installer edge cases.

#### Acceptance criteria

- All three first-open states are handled without crashing.
- Precedence warning is shown before any change is made to the machine.
- Existing npm CLI installation and global packages are unchanged.

---

### S8 — App shell: vanilla JS navigation skeleton

**Ticket:** EPMCDME-14511
**Estimates:** Best 3–5 d / Worst 5–8 d / **5 SP**
**Scope change from full:** Uses the existing vanilla JS tech stack (no React or Vite migration). Routing and component structure only. Full design-spec compliance is Stage 2.

#### What this covers

Extend the current vanilla JS frontend (`ui/renderer.js`, `ui/handlers.js`) with a proper navigation skeleton. The existing tech stack (vanilla JS ES modules, no bundler, no framework) is retained — no migration cost. Deliverable for POC:

- Navigation skeleton: sidebar with links to Home, Setup, Agents, Health
- `showView(name)` routing: replaces the current three hard-coded `hidden` div toggles in `renderer.js:showView`
- Per-screen JS modules loaded as ES modules (Home, Setup, Agents, Health)
- Tauri `invoke` calls kept in place — no wrapper abstraction needed for POC
- Basic error state display for failed Tauri command responses

#### What is excluded (Stage 2)

- Design-spec visual styling, animations, transitions.
- Connections and Command Log screens (Stage 2 features).
- Accessibility pass (WCAG).
- Dark mode / system theme.

#### Acceptance criteria

- All Stage 1 screens render and navigate correctly.
- Existing Tauri commands (`runner.rs`, `inspector.rs`, `pathman.rs`) callable from the new shell.
- `tauri dev` works without a separate build step.

---

### S12 — Sign-in and Home screen

**Ticket:** EPMCDME-14515
**Estimates:** Best 4–6 d / Worst 8–11 d / **8 SP**
**Scope change from full:** Multiple-provider sign-in paths reduced to CodeMie SSO only for POC (API key providers are handled in S10). Home screen shows state without the animated onboarding-checklist UX. Broken profile delete is in scope (essential for re-setup).

#### What this covers

**Sign-in**

- CodeMie SSO via system browser: invoke `codemie profile login --url <url>`, open browser, wait for the CLI's localhost callback, parse authenticated/expired/not-authenticated status from `codemie profile status` output via `inspector.rs::parse_profile_status()`.
- Authenticated state persisted; on next open the app skips sign-in and goes directly to Home.
- Expired-session state: show expiry indicator on Home, allow re-login without losing profile.
- "CodeMie SSO endpoint unreachable" error shown as a specific message, not a generic failure.

**Home — two states**

1. **Not set up**: show the four steps (sign in → setup → install agent → health) with their current completion status. Clicking an incomplete step navigates to it.
2. **Set up**: show active profile, CLI version, last doctor result summary. No step checklist.

**Broken profile delete**

If `parse_profile_status()` returns an unrecoverable error, show the profile in the Home error state with a single "Delete and start over" action. (Carved out of the deferred profile-management story because a user whose sign-in state is corrupt must be able to recover without waiting for that story.)

#### What is excluded (Stage 2)

- Onboarding checklist animated progress UI.
- Multiple profiles listed on Home.
- "Switch active profile" on Home.
- Non-SSO providers on the Sign-in screen (they are in Guided Setup).

#### Acceptance criteria

- New user can complete SSO login and reach Home without a terminal.
- Expired session is detected and shown; re-login restores the session.
- Unreachable SSO endpoint shows a specific error message.
- Broken profile can be deleted from Home; Home reflects the empty state afterwards.

---

### S10 — Guided setup: 6 decisions, SSO + API key, model selection

**Ticket:** EPMCDME-14513
**Estimates:** Best 7–10 d / Worst 12–16 d / **13 SP**
**Scope change from full:** PTY stream parsing (text/terminal output) is the chosen tech approach. Step UI is functional but not polished (collapsed/expanded step animation is Stage 2). "Fast path with sensible defaults" is Stage 2.

#### What this covers

Six `codemie setup` decisions presented as a linear step sequence, driven by PTY stream parsing:

The app runs `codemie setup` in a PTY via the existing `portable-pty` infrastructure in `pty.rs`. Terminal output is parsed in real time using text matching to detect which prompt is active. Each detected prompt is surfaced as the current step in the UI; the user's selection is injected back to the PTY as input. Steps:

1. **Configuration location** — Global (`~/.codemie/`) or repo-local. POC: show both options, default to global.
2. **Provider selection** — AI/Run CodeMie SSO, OpenAI, Azure, AWS Bedrock, LiteLLM, Ollama shown by plain-language name.
3. **Credentials / SSO** — CodeMie SSO: browser flow (reuse Sign-in logic). API key providers: text input. Rejected credentials shown as a step-level error; no profile saved.
4. **Project selection** — list projects available to the account; parsed from PTY output at this step.
5. **Model selection** — list models available; parsed from PTY output at this step.
6. **Profile name** — text input, validated for uniqueness.

On completion: PTY exits with a success code; app confirms profile is active via `codemie profile status`.

Error states:
- Rejected credentials: detected from PTY error output; step shown as failed; user can retry.
- CodeMie SSO unreachable: detected from connection error in PTY output; specific message shown.
- Provider connectivity failure at model-fetch: show error, allow manual retry.

#### What is excluded (Stage 2)

- Collapsed/expanded step animation (steps render as a static list for POC).
- "Fast path" (sign in → sensible defaults auto-selected, single confirm).
- `--json` CLI sub-commands as a data source — PTY output parsing is the chosen approach.
- Edit-step-after-completion (click a completed step to go back and change it).

#### Acceptance criteria

- A user completing all 6 steps ends up with a named, active profile readable by `codemie profile status`.
- PTY output is parsed correctly for all 6 prompt transitions; each step is reflected in the UI.
- Rejected credentials stop the step and show the provider's error; no profile is written.
- SSO unreachable shows a specific error message.
- `codemie profile status` shows the created profile as active after completion.

---

### S7 — Claude Desktop connect carry-forward

**Ticket:** EPMCDME-14510
**Estimates:** Best 1–2 d / Worst 2–3 d / **3 SP**
**Scope change from full:** Re-homing only — carry forward the Claude Desktop connect/restart actions that already work today into the new app shell. Full Connections screen (VS Code, Codex, status polling, disconnect, install-client) remains Stage 2.

#### What this covers

The existing Claude Desktop connect actions (`codemie proxy connect desktop` and `codemie proxy stop; codemie proxy connect desktop`) are already implemented in `ui/renderer.js:426–437` using the general `runAction()` / `ensureAuthenticated()` mechanism. This ticket re-homes them into the new navigation shell (S8) without rebuilding anything:

- Wire the Connect and Restart buttons in the new shell to the same `runAction` calls already present.
- Preserve the existing `check_profile_status`-based auth gate (`inspector.rs:133–145`) before either action runs.
- No new CLI flags, no new backend commands, no status polling.

#### What is excluded (Stage 2)

- VS Code, Codex, and other client rows in the Connections screen.
- Four-state model (Not set / Connected / Disconnected / App not installed).
- `codemie proxy connect --install-client` flow (flag does not exist yet).
- Disconnect action.

#### Acceptance criteria

- Signed-out user clicks Connect → same "CodeMie isn't signed in" notice as today.
- Signed-in user clicks Connect → Claude Desktop connects identically to the current app.
- Signed-in user clicks Restart while connected → stops then reconnects; no-op stop does not error.

---

### S3 — Health screen: doctor output and log access

**Ticket:** EPMCDME-14506
**Estimates:** Best 3–5 d / Worst 6–9 d / **5 SP**
**Scope change from full:** No grouped-by-actor layout (your account / your tools / CodeMie itself). No per-failure remedy text. No command-log panel (that is S9, Stage 2). Raw `codemie doctor` output available inline for each check.

#### What this covers

- Run `codemie doctor` via `runner.rs::run_stream()`, display live output as it arrives.
- Parse pass / warn / fail per check using text matching on the streamed output.
- Show a summary: N checks, M passed, K failed.
- "Open log" button: resolve `~/.codemie/logs/debug-YYYY-MM-DD.log`, open in the system default text editor. If the path is missing or unreadable, show a specific error (not silent empty state).
- Re-run button.

#### What is excluded (Stage 2)

- Per-failure remedy guidance ("what you should do about this specific failure").
- Grouped-by-actor layout (the design-comment screen 5 layout).
- Command log panel within the health screen.
- Automatic health check on app open.

#### Acceptance criteria

- `codemie doctor` runs and each check is shown as pass/warn/fail.
- Live streaming output visible while doctor runs.
- "Open log" works; unreachable log path shows a specific message.
- Re-run produces a fresh result.

---

### S11 — Agents: list, install, uninstall, update badge

**Ticket:** EPMCDME-14514
**Estimates:** Best 5–7 d / Worst 9–12 d / **8 SP**
**Scope change from full:** No agent launch from the app (removed per design comment). No detail panel. Progress shown inline in the list row, not in a separate detail view. Direct config read used if `codemie list --json` is not available.

#### What this covers

- List all agents CodeMie CLI manages by parsing the output of `codemie list`. Each row shows: display name, installed / not installed, installed version if present.
- **Install**: run `codemie install [agent] --supported`, show streamed output inline. On completion, re-read the agent list. On failure: show the CLI's own error text; agent remains not-installed.
- **Uninstall**: run `codemie uninstall [agent]`, confirm, show completion.
- **Update available badge**: if installed version < supported version per CLI, show "Update available". Run `codemie install [agent] --supported` on user action.
- **Below-minimum blocked badge**: if installed version < minimum per CLI, show "Must update before use" (launch removed per design comment, so no launch-gate needed; the badge is informational).
- **No network install error**: if install fails with a network error, show "Installing an agent requires a network connection."

#### What is excluded (Stage 2)

- **Agent launch from the app** (removed per Nikita Levyankov's design comment — terminal work).
- Detail panel / expanded row view (design screen 3 list-and-detail layout).
- Per-agent progress in a separate pane.
- Pinning to a specific version.

#### Acceptance criteria

- All agents CodeMie CLI manages are listed with correct installed / not-installed / update-available status.
- Install completes and the agent is shown as installed at the supported version.
- Uninstall completes and the agent is shown as not installed.
- Install failure shows the CLI's own error text; agent remains not installed.
- No network message shown on connectivity failure; no partial install left behind.
