# EPMCDME-14350 — Sub-task Estimations (v2)

*Unit: engineering days per developer (sequential). Story points express complexity on the Fibonacci scale, not time.*
*EPMCDME-14504 is expanded into 4 sub-tickets (T1–T4). All other tickets are unchanged from v1.*

---

## Estimates

| # | Ticket | Name | Best (days) | Worst (days) | Best (SP) | Worst (SP) | Risk | Savings % | Revised est. |
|---|--------|------|-------------|--------------|-----------|------------|------|-----------|--------------|
| S1 | [14504](https://jiraeu.epam.com/browse/EPMCDME-14504) | **Bundled runtime + shim** *(expanded below)* | | | | | | | |
| S1-T1 | 14504-T1 | ↳ Spike: validate bundled `npm install` inside signed macOS app bundle | 2 d | 5 d | **8** | **8** | **Very High** | 0% | 2 d / 5 d |
| S1-T2 | 14504-T2 | ↳ Build pipeline: vendor Node.js runtime and CLI package at CI build time | 3–4 d | 5–7 d | **5** | **5** | Medium | 10% | 3 d / 5–6 d |
| S1-T3 | 14504-T3 | ↳ macOS: bundled Node.js shim, runtime wiring, and PATH registration | 4–6 d | 8–10 d | **8** | **8** | Medium-High | 35% | 3–4 d / 5–7 d |
| S1-T4 | 14504-T4 | ↳ Windows: bundled Node.js shim, runtime wiring, and PATH registration | 4–6 d | 8–10 d | **8** | **8** | Medium-High | 28% | 3–4 d / 6–7 d |
| S2 | [14505](https://jiraeu.epam.com/browse/EPMCDME-14505) | Per-user install + handshake | 3–5 d | 7–10 d | 3 | 5 | Medium | 40% | 2–3 d / 4–6 d |
| S3 | [14506](https://jiraeu.epam.com/browse/EPMCDME-14506) | Health screen | 7–10 d | 15–20 d | 8 | 13 | Medium-High | 45% | 4–6 d / 8–11 d |
| S4 | [14507](https://jiraeu.epam.com/browse/EPMCDME-14507) | Self-update | 5–8 d | 12–15 d | 8 | 13 | Medium-High | 15% | 4–7 d / 10–13 d |
| S5 | [14508](https://jiraeu.epam.com/browse/EPMCDME-14508) | Code signing | 3–5 d | 7–10 d | 5 | 8 | Medium | 20% | 2–4 d / 6–8 d |
| S6 | [14509](https://jiraeu.epam.com/browse/EPMCDME-14509) | Release + docs | 5–8 d | 12–15 d | 5 | 8 | Medium | 8% | 5–7 d / 11–14 d |
| S7 | [14510](https://jiraeu.epam.com/browse/EPMCDME-14510) | Claude Desktop carry-forward | 1–2 d | 3–4 d | 2 | 3 | Low | 78% | ≤1 d / 1 d |
| S8 | [14511](https://jiraeu.epam.com/browse/EPMCDME-14511) | App shell (React) | 8–12 d | 15–20 d | 13 | 21 | Medium | 25%¹ | 6–9 d / 11–15 d |
| S9 | [14512](https://jiraeu.epam.com/browse/EPMCDME-14512) | Command log | 4–6 d | 8–12 d | 8 | 13 | Medium | 25% | 3–5 d / 6–9 d |
| S10a | [14513](https://jiraeu.epam.com/browse/EPMCDME-14513) | Guided setup — Option A (PTY pass-through) | 14–20 d | 25–35 d | 21 | 34 | **High** | 80%² | 3–4 d / 5–7 d |
| S11a | [14514](https://jiraeu.epam.com/browse/EPMCDME-14514) | Agents — text-parse `codemie list` | 12–15 d | 18–23 d | 13 | 21 | Medium-High | 35% | 8–10 d / 12–15 d |
| S11b | [14514](https://jiraeu.epam.com/browse/EPMCDME-14514) | Agents — direct config read *(saves 3–4 d)* | 8–11 d | 14–18 d | 8 | 13 | Medium | 35% | 5–7 d / 9–12 d |
| S12 | [14515](https://jiraeu.epam.com/browse/EPMCDME-14515) | Sign-in + Home | 7–10 d | 12–16 d | 13 | 21 | Medium-High | 45% | 4–6 d / 7–9 d |

> T1 and T2 can run in parallel. T3 and T4 can run in parallel with each other after T1 and T2 complete.
> When T3 and T4 are parallelised, their combined calendar time = max(T3, T4), not T3 + T4.
>
> ¹ S8 savings (25%) assume React rewrite as scoped. Vanilla JS extension (recommended for POC — navigation must be rebuilt regardless per MR §4) saves ~50%; revised best 2–5 d / worst 4–8 d. See `existing-app-analysis.md`.
>
> ² S10a savings (80%) reflect wrapping the existing step 2.3.3 PTY invocation in a screen frame (PTY pass-through approach). The revised 3–4 d / 5–7 d covers that scope, not a full PTY-parse wizard.

---

## Totals

| Scenario | Best (days) | Worst (days) | Revised best | Revised worst |
|----------|-------------|--------------|--------------|---------------|
| S1 split, S10 Option B, S11 config read (optimistic) | ~68–92 d | ~117–144 d | ~47–65 d | ~83–105 d |
| S1 split, S10 PTY pass-through, S11 config read (POC path) | ~55–80 d | ~100–130 d | ~26–38 d | ~52–73 d |

*S1 sub-tickets T3 and T4 counted as max(T3,T4) = 4–6 d best / 8–10 d worst when parallelised.*
*"POC path" uses S10 PTY pass-through revised estimate (3–4 d) and vanilla JS S8 revised estimate (2–5 d).*

---

## Story point scale

| SP | Complexity signal |
|----|-------------------|
| 2 | Trivial — re-homing existing, well-understood code |
| 3 | Small — clear scope, minimal unknowns |
| 5 | Medium — clear scope, some cross-platform work or new tooling |
| 8 | Medium-large — new subsystem or significant text parsing, multiple moving parts |
| 13 | Large — new React feature area, cross-cutting service, or external team dependency |
| 21 | Very large — unproven approach, multi-platform, high fragility risk, or broad scope |
| 34 | Extra-large — PTY heuristic parsing over interactive wizard, ongoing maintenance risk |
| 55 | Extreme — POC required before commitment, gates all other work, blast radius if blocked |

---

## EPMCDME-14504 dependency order

```
T1 (spike) ──┐
             ├──► T3 (macOS shim + PATH)
T2 (CI)  ────┤
             └──► T4 (Windows shim + PATH)
```

T1 and T2 start in parallel. T3 and T4 are independent of each other and can also run in parallel.

---

## Critical path and schedule risks

**S1-T1 (spike) gates T3 and T4.**
Mandatory 2-day POC checkpoint. If the POC fails, the epic cannot proceed as scoped. Assign the strongest available engineer first and treat day 2 as a hard gate.

**S8 (App shell) must start immediately after S1-T1 is unblocked.**
Every UI ticket (S4, S9, S10, S11, S12) depends on the React shell being in place.

**S5 (Code signing) has an external hard blocker.**
Windows certificate procurement must be initiated in parallel with S1-T1 — not after. Delay blocks S6 and the entire publishable artifact.

**CLI team dependency on S10 must be resolved in week 1.**
If `codemie models list --json` and `codemie projects list --json` cannot land in the same release cycle, S10 reverts to Option A (+4–15 days and ongoing maintenance debt).

**S9 (Command log) should be built early despite appearing mid-list.**
S3, S10, S11, S12 all route CLI failures through it.

---

## Suggested sequencing (2-engineer team)

```
Engineer A:  S1-T1 → S1-T2 (parallel with T1) → S1-T3 → S5 (parallel with cert) → S6
Engineer B:  S8 → S9 → S1-T4 (parallel with A's T3) → S7 → S12
             (S2, S3, S10, S11, S4 start after S8 + S9 are unblocked)
```

---

## Open decisions affecting final estimates

| Decision | Affects | Impact if unresolved |
|----------|---------|----------------------|
| Can CLI team add `codemie models list --json` / `codemie projects list --json`? | S10 | +4–15 d, Option A becomes default |
| Is agent state readable from a config file directly? | S11 | +3–4 d if text-parse required |
| Windows code-signing certificate procurement timeline | S5, S6 | Blocks publishable release independent of engineering progress |

---

## Existing codebase savings summary

*Source: MR branch `EPMCDME-14517-codemie-desktop-decomposition`, §4 authoritative codebase analysis. The savings % and revised estimates above are based on these findings.*

The `codemie-claude-installer-macos` v2.0.1 codebase reduces full-project estimates by **~28–32%** (optimistic scenario) and POC (Stage 1) estimates by **~40–43%** when PTY pass-through is used for guided setup and vanilla JS is used for the app shell instead of a React rewrite.

**Three largest savings contributors:**

1. **S7 — Claude Desktop carry-forward (78%)**: `runAction` driving `codemie proxy connect desktop` and `runAnalytics` driving `codemie analytics --report --open` are both fully implemented and production-shipped. The MR §4 explicitly names these as "can be reused directly rather than rebuilt." Re-homing them in the new Connections screen takes ≤1 day.
2. **S10 — Guided setup via PTY pass-through (80%)**: Step 2.3.3 in the current wizard already runs `codemie setup` as an interactive PTY session in the embedded xterm.js terminal. The PTY, overlay open/close, auth pre-check, and completion detection are all done. Wrapping this in a dedicated screen frame for the POC takes 3–4 days instead of the full 14–20-day guided wizard scope.
3. **S3 — Health screen (45%)**: Step 2.4 already streams `codemie doctor` output via `run_stream`, and `logger.rs::open_log` already opens the debug log. The new work is a standalone screen, pass/fail text classification, and per-failure remedy text — not the streaming infrastructure.

**Two strategic recommendations:**

- **Do not migrate to React for the POC.** Navigation must be rebuilt regardless — the MR §4 confirms `renderer.js:showView` toggles 3 hard-coded `hidden` divs; there is no reusable sidebar or routing. Given that, adding new screens in vanilla JS saves ~50% vs a React rewrite (2–5 d vs 6–9 d best case). React migration is Stage 2.
- **Use PTY pass-through for guided setup.** The working `codemie setup` PTY invocation in step 2.3.3 is the POC implementation. The full 6-step native form wizard (Option B) is Stage 2.

**Three key corrections from MR analysis vs the prior 57% savings estimate:**

- **S8 navigation savings reduced**: The prior estimate assumed the `showView`/`.hidden` routing was reusable. The MR §4 explicitly corrects this. Navigation savings drop from ~75% (prior estimate) to ~50% (vanilla JS) or ~25% (React rewrite).
- **S4 savings reduced to 15%**: The existing `run_self_update` updates the CLI via `npm install -g`, not the app. `tauri-plugin-updater` is absent from `Cargo.toml`. App-level update logic is entirely greenfield.
- **S6 savings at 8%**: No `.gitlab-ci.yml` exists. The release pipeline is a new artefact. The prior estimate did not assess S6 directly; the MR confirms there is no CI base to extend.

**Note on S1-T1 (spike):** Savings are 0% and estimates are unchanged. Whether bundled `npm install` works inside a notarised macOS app bundle cannot be shortened by prior art. It remains the gating unknown for the entire epic.

---

## Sub-ticket detailed descriptions (EPMCDME-14504)

---

### S1-T1 — Spike: validate bundled `npm install` inside a signed macOS app bundle

**Parent:** EPMCDME-14504
**Estimates:** Best 2 d / Worst 5 d / **8 SP**

#### Context

This is the highest-risk unknown in EPMCDME-14504, and by extension in the entire EPMCDME-14350 epic. Every other sub-ticket assumes this spike succeeds. The question is not whether Node.js can be bundled — it can — but whether `npm install` works correctly when invoked as a subprocess from inside a signed and notarised macOS `.app` bundle.

The concern: Gatekeeper and macOS sandbox/TCC restrictions can silently block write access from binaries shipped inside a signed app bundle. The npm cache directory, package extraction paths, and any temp files npm creates during an install could be restricted depending on how the app is signed and whether it carries hardened runtime entitlements. A bundled `node --version` working does not prove `npm install` works.

Why this matters: agents (Claude Code, Gemini CLI, etc.) are npm packages that `codemie install [agent]` fetches at runtime via `npm install`. This is not a one-time build step — it happens every time a user installs an agent. If `npm install` cannot run from inside the bundle, the entire "zero prerequisites" premise of EPMCDME-14350 must be reconsidered.

#### Timebox

**2 working days.** At the end of day 2, one of the following must be true:

- A working demo exists (see Definition of done), or
- A spike report is posted as a comment naming exactly what failed and where it got stuck.

If the demo has not been produced by day 2, **stop implementation**, write the spike report, and this ticket moves to re-scoping.

#### Candidate approaches to test

**Approach A — `bundle.resources` with portable Node distribution**

Download the official `node-vX.Y.Z-darwin-arm64.tar.gz`, unpack it, and ship the entire `bin/node`, `bin/npm`, and `lib/node_modules/npm` tree via `tauri.conf.json`'s `bundle.resources`. Point a shim script at the bundled `node` running `npm-cli.js` and the CLI's own entry point.

Key unknowns to validate:
- Does Gatekeeper allow the bundled `node` binary to execute at all (it is not a sidecar declared in the entitlements, just a resource)?
- Can the bundled `npm` write to its cache directory (e.g., `~/.npm`) when invoked from inside a notarised `.app`?
- Does the hardened runtime flag `com.apple.security.cs.allow-unsigned-executable-memory` need to be set for Node.js JIT?

**Approach B — Tauri `externalBin` (sidecar)**

Declare `node` as a sidecar via `bundle.externalBin` in `tauri.conf.json`. Tauri signs the sidecar as part of the app signing step.

Key unknowns to validate:
- `externalBin` is designed for a single binary. Can the full `node` + `npm` + `node_modules/npm` tree be colocated with a declared sidecar entry and still work?
- Does signing the `node` binary as a sidecar add entitlement restrictions that break `npm install`'s subprocess spawning?

#### What the demo must prove

1. On a macOS machine with no Node.js and no npm installed, install the test build of the app.
2. Open a terminal. Run `codemie --version`. It prints a version using only the bundled runtime.
3. In the same terminal, run `codemie install [agent]` (any agent). It completes successfully using only the bundled `node` and `npm`.
4. `which node` and `which npm` return nothing (or the pre-existing system path), confirming the bundled copies were used, not a system install.

If step 3 fails, the spike is not done — the report must say exactly what error `npm install` produced and at which point it failed.

#### Acceptance criteria

- A working demo matching all four steps above exists and is reproducible on a clean macOS aarch64 VM, OR
- A spike report is posted within the 2-day timebox naming the exact failure, what was tried, and a recommended next step.

#### Dependencies

- Blocks T2 path confirmation, T3, T4.
- Can start in parallel with T2.

#### Out of scope

Production-quality shim, PATH wiring, installer integration, Windows.

---

### S1-T2 — Build pipeline: vendor Node.js runtime and CodeMie CLI package at CI build time

**Parent:** EPMCDME-14504
**Estimates:** Best 3–4 d / Worst 5–7 d / **5 SP**

#### Context

Before the Tauri app can bundle a Node.js runtime and the CodeMie CLI, the CI build pipeline must acquire the correct platform-specific artifacts at build time and place them where Tauri's `bundle.resources` expects them. This ticket owns that acquisition and placement — the Tauri config changes, the Cargo feature flags, and the CI steps — so that T3 and T4 can focus purely on the shim and PATH wiring.

This ticket can start in parallel with T1. The build pipeline work is largely approach-agnostic: whether T1 confirms Approach A (`bundle.resources`) or Approach B (`externalBin`), the CI step that downloads and unpacks Node.js is essentially the same.

#### Current state (evidence)

- `src-tauri/tauri.conf.json` has no `bundle.externalBin` and no `bundle.resources` entry for a runtime today.
- `src-tauri/Cargo.toml` line 32: `features = []` — no sidecar or shell-related features are enabled.
- There is no `.gitlab-ci.yml` in this repository today. The build pipeline must be created from scratch (tracked by EPMCDME-14552).

#### Scope

**1. Node.js version pinning** — Add a `NODE_VERSION` file in the repo root. CI steps and local bootstrap scripts both read from this single source of truth.

**2. CI download step — macOS aarch64** — Read `NODE_VERSION`, download `node-vX.Y.Z-darwin-arm64.tar.gz`, verify SHA-256 against the official `SHASUMS256.txt`, unpack to `src-tauri/resources/node/macos-aarch64/`.

**3. CI download step — Windows x64** — Same for `node-vX.Y.Z-win-x64.zip`, unpacking to `src-tauri/resources/node/windows-x64/`.

**4. CodeMie CLI package bundling** — Run `npm install --prefix src-tauri/resources/cli @codemieai/code@<CLI_VERSION>`. `CLI_VERSION` is read from a `CLI_VERSION` pinning file consistent with EPMCDME-14552.

**5. `tauri.conf.json` and `Cargo.toml` changes** — Add `bundle.resources` entries pointing to the downloaded runtime directories (exact paths finalised after T1). Enable required Tauri features. Add resource paths to `.gitignore`.

**6. Local development bootstrap scripts** — `scripts/bootstrap.sh` (macOS) and `scripts/bootstrap.ps1` (Windows) so developers can reproduce the CI download step locally.

#### Acceptance criteria

- `tauri build` on the CI runner produces a bundle containing the Node.js runtime and CLI JS files at the paths T3 and T4 expect.
- `NODE_VERSION` and `CLI_VERSION` are the single source of truth.
- Downloaded binaries are not committed (`.gitignore` entries present).
- SHA-256 verification failure aborts the build.
- A developer can run the bootstrap script and then `tauri build` locally on a clean machine.

#### Dependencies

- Core CI download steps can be written before T1 completes; `tauri.conf.json` paths are finalised after T1 confirms the approach.
- T3 and T4 depend on this ticket for the runtime to be present at build time.
- Related to EPMCDME-14552 (CI/CD release pipeline).

#### Out of scope

Shim scripts, PATH registration (T3, T4). App signing (EPMCDME-14508).

---

### S1-T3 — macOS: bundled Node.js shim, runtime wiring, and PATH registration

**Parent:** EPMCDME-14504
**Estimates:** Best 4–6 d / Worst 8–10 d / **8 SP**

#### Context

With T1 confirming that bundled `npm install` works on macOS and T2 placing the Node.js runtime and CLI JS files inside the app bundle, this ticket implements the macOS-specific integration: the shim script, runtime placement confirmation, and per-user PATH registration. The result is that on a clean macOS machine, opening a terminal after installation and running `codemie --version` or `codemie install [agent]` works with no system Node.js present.

#### Current state (evidence)

- `src-tauri/src/commands/pathman.rs` already implements per-user PATH persistence on macOS via `persist()`, which appends a marked block to `~/.zprofile`. **Reuse this — do not write new PATH-persistence code.**
- `src-tauri/src/commands/installer.rs:128-137` — the current `install_node` on macOS calls `sudo_exec` running `installer -pkg -target /` via `osascript` (system-wide, admin required). **Delete this once the bundled runtime is in place.**
- `config/steps.yaml` steps 1.2 and 1.2.1 drive the current Node.js install wizard step — also deleted as part of EPMCDME-14505, but this ticket removes their backend counterpart.

#### Scope

**1. Shim script** — Write `codemie.sh`:

```sh
#!/bin/sh
BUNDLE_RESOURCES="$(dirname "$(dirname "$(dirname "$0")")")/Contents/Resources"
exec "$BUNDLE_RESOURCES/node/bin/node" \
     "$BUNDLE_RESOURCES/cli/node_modules/@codemieai/code/dist/index.js" "$@"
```

Place the compiled shim at a stable per-user path outside the bundle (e.g., `~/.codemie/bin/codemie`) so it survives app updates without the PATH entry changing.

**2. Runtime placement** — Confirm the macOS aarch64 Node.js runtime and CLI JS files land at the correct paths inside `CodeMie Desktop.app/Contents/Resources/`. Apply any Gatekeeper-specific configuration (entitlement flags, re-signing of the bundled `node` binary) identified in T1.

**3. PATH registration** — Call the existing `persist_to_zprofile` Tauri command with `~/.codemie/bin` as the directory. Verify: entry written to `~/.zprofile`, no admin prompt, new terminal shell resolves `codemie`.

**4. Remove old admin-elevated Node install path** — Delete `install_node` (macOS branch) in `installer.rs` and steps 1.2 / 1.2.1 in `config/steps.yaml`. Do not keep as a fallback. Coordinate with EPMCDME-14505.

**5. End-to-end verification on a clean macOS VM** — On macOS aarch64 with no Node.js, no npm, no codemie: install the app, open a terminal, run `codemie --version` (must print version), run `codemie install [agent]` (must complete), confirm `which node` / `which npm` do not return the bundle, confirm `~/.zprofile` has the PATH block without admin prompt, confirm existing system Node.js (if any) is unchanged. Separately, on a VM with `codemie` already on PATH, confirm the app does not append a PATH entry and `codemie --version` still resolves to the pre-existing install (EPMCDME-14581).

#### Acceptance criteria

- `codemie --version` works on a clean macOS machine (no Node, no npm) after installation, and resolves to the pre-existing installation (not the bundled CLI) when `codemie` is already on PATH (EPMCDME-14581).
- `codemie install [agent]` completes using only the bundled runtime.
- Existing system Node.js is unchanged.
- No admin credential prompt appears.
- PATH change is scoped to `~/.zprofile`.

#### Dependencies

- Blocked by T1 and T2.
- Can run in parallel with T4.
- Coordinate with EPMCDME-14505 on removal of old Node install steps.

#### Out of scope

Windows (T4). App signing (EPMCDME-14508). Installer packaging (EPMCDME-14505).

---

### S1-T4 — Windows: bundled Node.js shim, runtime wiring, and PATH registration

**Parent:** EPMCDME-14504
**Estimates:** Best 4–6 d / Worst 8–10 d / **8 SP**

#### Context

The Windows counterpart to T3. With T1 confirming the bundled runtime approach and T2 placing the Windows x64 Node.js runtime and CLI JS files inside the installer output, this ticket implements the Windows-specific shim, runtime wiring, and per-user PATH registration. Fully independent of T3 and can be worked in parallel by a second engineer.

#### Current state (evidence)

- `src-tauri/src/commands/pathman.rs` already implements per-user PATH persistence on Windows via `persist()`, which writes to `HKCU\Environment` and calls `broadcast_env_change()` to send `WM_SETTINGCHANGE`. **Reuse this — do not write new PATH-persistence code.**
- `src-tauri/src/commands/installer.rs:198-208` — the current `install_node` on Windows runs `msiexec /i [path] /quiet /norestart` (machine-wide). **Delete this once the bundled runtime is in place.**
- The NSIS installer already uses `installMode: "currentUser"` — per-user installation is already the mode.

#### Scope

**1. Shim script** — Write `codemie.cmd`:

```bat
@echo off
set BUNDLE_DIR=%~dp0..
"%BUNDLE_DIR%\node\node.exe" "%BUNDLE_DIR%\cli\node_modules\@codemieai\code\dist\index.js" %*
```

Place the shim at a stable per-user path (e.g., `%LOCALAPPDATA%\Programs\CodeMie Desktop\bin\codemie.cmd`). Note: the Windows Node.js portable zip places `node.exe` directly in the root — there is no `bin/` subdirectory as on macOS. Shim paths must reflect this.

**2. PATH registration** — Call the existing Windows `persist()` Tauri command to write `HKCU\Environment` and broadcast `WM_SETTINGCHANGE`. Verify: no UAC prompt, new PowerShell/CMD window resolves `codemie`.

**3. Remove old admin-elevated Node install path** — Delete `install_node` (Windows branch) in `installer.rs` and steps 1.2 / 1.2.1 in `config/steps.yaml`. Do not keep as a fallback. Coordinate with EPMCDME-14505.

**4. End-to-end verification on a clean Windows user account** — On Windows x64 with no Node.js, no npm, no codemie: install the app, open a PowerShell window, run `codemie --version` (must print version), run `codemie install [agent]` (must complete), confirm `where.exe node` / `where.exe npm` do not return the bundle, confirm `HKCU\Environment` has the PATH entry without UAC prompt, confirm existing system Node.js (if any) is unchanged.

**5. Windows-specific edge cases to validate:**
- **Long path names:** shim path plus CLI entry point must not exceed 260 characters; test on a user account with a long username.
- **Encoding:** `codemie.cmd` must be saved as UTF-8 without BOM; `%*` argument forwarding must handle paths with spaces.
- **Antivirus false positives:** a newly placed `.cmd` launching `node.exe` from a non-standard location may trigger Windows Defender or corporate AV. Proper code signing (EPMCDME-14508) significantly reduces this risk.

#### Acceptance criteria

- `codemie --version` works on a clean Windows user account (no Node, no npm) after installation.
- `codemie install [agent]` completes using only the bundled runtime.
- Existing system Node.js is unchanged.
- No UAC credential prompt appears.
- PATH change is scoped to `HKCU\Environment`.

#### Dependencies

- Blocked by T1 and T2.
- Can run in parallel with T3.
- Coordinate with EPMCDME-14505 on removal of old Node install steps.
- Coordinate with EPMCDME-14508 (code signing) — signing reduces AV false-positive risk.

#### Out of scope

macOS (T3). App signing (EPMCDME-14508). Installer packaging (EPMCDME-14505).
