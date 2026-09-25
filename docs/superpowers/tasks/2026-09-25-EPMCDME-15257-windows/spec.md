# Spec: EPMCDME-15257 — Windows setup install/validate npm-prefix mismatch

## Problem

On Windows, the legacy install-wizard's steps `2.3.3` ("Configure CodeMie") and `2.3.5`
("Install Claude Code engine") run through `ui/handlers.js::runExternalWindow` →
`ui/runner-bridge.js::externalWindow.spawnPs` → Rust `spawn_external_ps`
(`src-tauri/src/commands/pty.rs:283-294`). That function spawns a detached
`powershell.exe` console via a bare `tokio::process::Command` with **no env overrides at
all** — it never calls `npm_env::npm_env_for`, so it sets neither `npm_config_prefix` nor
a `PATH` prepended with the agents bin dir.

Every sibling spawn path disagrees with it: `shell_cmd_for` (`runner.rs:33-59`, used by
step `2.4`'s `codemie doctor` validation) and `pty_env_pairs_for` (`pty.rs:48-68`, used by
macOS's embedded PTY and the newer guided-setup screen) both route through
`npm_env::npm_env_for` and agree on `%USERPROFILE%\.codemie\agents` as the install prefix
(the convention from EPMCDME-15180 / `.ai-run/decisions/2026-09-21-EPMCDME-14514-npm-for-agent-install.md`).

Result: `codemie install claude --supported` (run via `spawn_external_ps`, no prefix
override) and the following `codemie doctor` validation (run via `shell_cmd_for`, prefix
overridden to `.codemie\agents`) look in two different directories for the same shim,
reproducing the reported "CodeMie command shim could not find codemie.cmd" failure across
all three wizard steps.

**Naming clarification (binding for downstream stages):** the ticket names
`ui/setup-view.js` as the likely affected file. It is not. `ui/setup-view.js` /
`ui/setup-driver.js` drive a structurally separate, newer "guided setup" screen (reached
via Home → "Choose how CodeMie reaches a model" → `onSetupAgain`) that runs `codemie
setup` through `spawn_pty`, which already sets `npm_config_prefix` correctly. The actually
broken flow is the **legacy install-wizard**: `config/steps-windows.yaml` +
`ui/handlers.js` + `ui/renderer.js::enterWizard()`. Any plan or implementation built from
this spec must touch the legacy-wizard files, not `setup-view.js`.

## Approach

Bring `spawn_external_ps` into line with its two siblings by extracting the same
`npm_config_prefix`/`PATH` logic those siblings already share (`npm_env::npm_env_for`,
`prefixed_path_with_bin_dir`) and applying it as `.env()` calls before spawning the
PowerShell child. Follow the codebase's existing pure-function-plus-thin-wrapper
convention (`shell_cmd_for`, `pty_env_pairs_for`): factor a small pure function that takes
the same inputs (`home`, `windows`, existing `PATH`) and returns the env pairs to apply,
so it is unit-testable without touching the real process environment, matching:

```rust
// shape only — mirrors the existing pty_env_pairs_for(home, windows, base_path) signature
fn external_ps_env_pairs_for(home: &str, windows: bool, base_path: &str) -> Vec<(String, String)>
```

`spawn_external_ps`'s real wrapper then reads `USERPROFILE`/`PATH` and calls this
function, same as the two existing wrappers already do. No new environment variables and
no new install-location convention are introduced — this is env-wiring parity only.

For AC4 (actionable failure on genuine install failure), improve how the legacy wizard
surfaces a non-zero exit from `runExternalWindow`/`runPty`-driven steps in
`ui/handlers.js` and/or `ui/renderer.js::enterWizard()`: when a step's process exits
non-zero, the UI must name the failed step (its `title` from `steps-windows.yaml`, e.g.
"Install Claude Code engine") and its exit code in the message shown, rather than a bare
"step failed" — improving how failures already available to the wizard are labeled and
surfaced. This does not touch or reformat any text produced by the vendored
`@codemieai/code` CLI itself.

## Acceptance Criteria

1. On Windows, with no pre-existing `codemie-code` install, running the legacy setup
   wizard's steps `2.3.3` → `2.3.5` installs the agent into the same prefix
   (`%USERPROFILE%\.codemie\agents`) that step `2.4`'s validation checks.
2. Step `2.4` (`codemie doctor`) locates `codemie.cmd` after a fresh install performed
   entirely through the wizard (no manual PATH/env intervention).
3. The wizard no longer fails with "CodeMie command shim could not find codemie.cmd" when
   run against a clean environment.
4. When a wizard step's underlying command genuinely exits non-zero, the UI shows a
   message naming that step's title and exit code (not a generic/blank failure).
5. `src-tauri/src/commands/pty.rs`'s Windows test module gains a test — mirroring
   `pty_env_pairs_includes_npm_config_prefix_and_prefixed_path` and
   `shell_cmd_sets_npm_config_prefix_and_prefixed_path_by_default` — asserting
   `spawn_external_ps`'s (or its extracted pure function's) env pairs include
   `npm_config_prefix` and a `PATH` prefixed with the agents bin dir. A JS test for
   `ui/handlers.js`'s `isWin` dispatch of steps `2.3.3`/`2.3.5` is added if it fits the
   existing `node --test` + hand-rolled-fakes pattern (`ui/test/*.test.mjs`); if the
   dispatch isn't cleanly testable under that pattern without new scaffolding, it is
   documented as a known coverage gap rather than forced in.
6. Real-Windows verification (clean environment, no pre-existing install) remains a manual
   confirmation step outside CI, per Jira AC5; it is not an automated-test requirement.

## Non-goals

- Not touching `src-tauri/src/commands/pathman.rs::candidate_dirs()` or `run_fresh_env` —
  that code path is not in the failing call chain (only steps `2.3.3`/`2.3.5`/`2.4`
  matter here), and its `AppData\Local\CodeMie\npm-prefix` entry must not be treated as a
  second valid install prefix.
- Not editing the vendored `@codemieai/code` CLI's own error text or install/doctor
  logic (`cli/node_modules/@codemieai/code`) — not owned by this repo; AC4 is satisfied
  entirely at the CodeMie Connect UI layer.
- Not touching `ui/setup-view.js`, `ui/setup-driver.js`, or the newer guided-setup screen
  — that flow already sets `npm_config_prefix` correctly via `spawn_pty` and is out of
  scope.
- Not introducing a new install-location convention or new env variables — reuses the
  existing `npm_env::npm_env_for` / `.codemie\agents` convention verbatim.
- Not requiring a real Windows machine for any automated test added by this change; the
  new Rust test uses the existing pure-function/parametrized-`windows: bool` pattern so it
  runs on any host.
- Not changing macOS behavior (`config/steps.yaml`, `ui/handlers.js`'s non-`isWin` branch,
  `pty_env_pairs_for`'s existing unix path) at all.

## Testing

- Rust: new unit test on `spawn_external_ps`'s (or its extracted pure function's) env
  pairs, `#[cfg(all(test, windows))]`, mirroring the two existing sibling env tests named
  above.
- JS: add `ui/test/handlers.test.mjs` covering the `isWin` dispatch to
  `runExternalWindow` for steps `2.3.3`/`2.3.5` if feasible under the existing
  deps-injection/fake pattern; otherwise leave as a documented gap (see AC5).
- No new end-to-end or real-Windows-machine automated test is added; Jira AC5's clean-env
  verification is manual.
