status: DONE

## Capture artifact

- Absolute path: `C:\repositories\dodemie_gui\codemie-claude-installer-macos\docs\superpowers\tasks\2026-09-23-guided-setup-windows\windows-capture-raw.log`
- 57 lines, 57 raw PTY chunks, one JSON object per line: `{"tag":"chunk","b64":"<base64 of raw bytes>"}` — every line validated as well-formed JSON with that exact shape.
- A parallel, non-required debug log with the harness's own settle/decision trace is at `docs\superpowers\tasks\2026-09-23-guided-setup-windows\windows-capture-decisions.log` (useful for verification, not the deliverable).

## How it was captured

Temporary Cargo example `src-tauri/examples/capture_win_pty.rs` (deleted after use, see Cleanup) opened a real ConPTY via `portable-pty`'s `native_pty_system().openpty(PtySize{rows:30, cols:100,...})`, spawned `CommandBuilder::new("powershell.exe")` with `args(["-NoProfile","-Command","codemie setup --force"])`, `env TERM=xterm-256color`, `USERPROFILE`/`cwd` = the real `%USERPROFILE%`, and inherited `PATH` — mirroring `src-tauri/src/commands/pty.rs::spawn_pty`'s Windows branch and `ui/setup-driver.js`'s `COLS=100`/`ROWS=30`. Every raw chunk read from the PTY was logged in order (before any ANSI stripping) as base64 JSON lines. A reactive decision loop read-until-quiet (450 ms idle, more generous than the driver's 200 ms), stripped ANSI, and pattern-matched the settled screen text to choose the next keystroke — never a fixed step list — using the real org already configured on this machine (`https://codemie.lab.epam.com`, project `epm-sdai`, existing profiles `default` and `my enthropic acc`), always via the "add a new profile" path (never touching those two existing profiles).

This was run live against the real `codemie` CLI (v0.15.1, resolved from `AppData\Local\CodeMie\npm-prefix\codemie.cmd`) three times; the first two runs had a bug in the harness's own screen-classification logic (not the CLI) that mis-selected "Local" storage instead of "Global," which — because the harness's `cwd` equals `USERPROFILE` — collided with the real global config path and overwrote the user's real `~/.codemie/codemie-cli.config.json`. Both times this was caught immediately and the file was restored from an in-memory-verified backup; see Safety section. The third run, after fixing the classification bug (matching keywords against the full settled screen rather than a `?`-sliced tail, and prioritizing the "Choose a model" question so it isn't shadowed by an auto-resolved single-option project list landing in the same idle window), completed correctly end-to-end and produced the capture log above.

## Phase-by-phase summary (from the real captured session)

1. **Welcome / storage** — CLI printed its welcome banner, then `? Where would you like to store this configuration?` with `Global` highlighted by default; harness pressed Enter and selected Global. Note: no separate "add a new profile" gate screen appeared in this real run (the CLI apparently only shows that gate when re-running `setup` against an existing *active* profile context in a way this fresh `--force` invocation didn't trigger) — the sequence went straight to storage. This is the CLI's real, observed behavior, not a harness shortcut.
2. **Provider** — `? Choose your LLM provider:` list with 6 options (CodeMie SSO, LiteLLM, AWS Bedrock, Anthropic Subscription, Moonshot Subscription, Ollama). Harness paged Down through all 6 (wrapping back to CodeMie SSO) and pressed Enter on "CodeMie SSO" (fewest secrets needed).
3. **URL** — `? CodeMie organization URL: (https://codemie.lab.epam.com)` — accepted the prefilled default with Enter, which triggered real browser-based SSO authentication (`✓ Authentication successful!`) using the machine's cached session — no manual browser interaction was needed.
4. **Project** — `Found 2 accessible project(s)` then `? Select your project:` auto-resolved to the single accessible option `epm-sdai` in the same idle window as the next prompt.
5. **Model list** — `? Choose a model (41 available):` with `⭐ claude-sonnet-5` highlighted first. Harness pressed a single bare Down-arrow (observed the redraw moving the pointer to `claude-4-5-sonnet`, per the required "at least one Down without Enter first" step), then pressed Enter selecting the real model `claude-4-5-sonnet` (not "Custom").
6. **Profile name — deliberate rejection** — `? Enter a name for this profile: (codemie-sso)`; harness typed `default` (already exists) and pressed Enter, and the CLI responded `>> A profile with this name already exists`, confirming the rejection. Harness then sent Ctrl-U, typed the fresh name `epmcdme-14982-capture-2784`, and pressed Enter, which the CLI accepted: `✔ Profile "epmcdme-14982-capture-2784" saved to global config`.
7. **Activate confirm** — `? Switch to profile "epmcdme-14982-capture-2784" as active? (Y/n)` — harness answered `y\r`, and the CLI confirmed `✓ Switched to profile "epmcdme-14982-capture-2784"`, printed the final success summary (provider `ai-run-sso`, model `claude-4-5-sonnet`) and next-steps text, then exited.

## Repo cleanliness

- `git status --porcelain=v1` from repo root shows only: `?? docs/superpowers/tasks/2026-09-23-guided-setup-windows/` — no changes under `src-tauri/` or `ui/`.
- `assets/codemie-cli/package.json` (touched as a side effect of an earlier `cargo build`) shows an empty `git diff --stat` — confirmed reverted/clean.
- `src-tauri/examples/capture_win_pty.rs` was deleted; `src-tauri/examples/` is now empty.
- `ui/setup-driver.js`, `ui/handlers.js`, and `config/steps-windows.yaml` were not touched.
- No commit was made.

## Cleanup performed

- Temporary example `src-tauri/examples/capture_win_pty.rs` deleted.
- Capture harness process (direct binary invocation, PID 12784) stopped; verified no orphaned `codemie`/`node`/`powershell.exe` child processes remain from this task (the handful of `powershell.exe`/`conhost.exe` processes seen during the final check were unrelated ambient Claude Code notification-hook activity on this machine, confirmed via their command lines).
- The real config file `C:\Users\RuslanBulko\.codemie\codemie-cli.config.json` was restored to its exact original pristine content (`activeProfile: "my enthropic acc"`, only the original `default` and `my enthropic acc` profiles, original `userEmail`/`workspace`) — the test profile `epmcdme-14982-capture-2784` created during the live run was removed from it.
- The safety-net backup `C:\Users\RuslanBulko\.codemie\codemie-cli.config.json.orig-backup` (created by me during this task, not part of the deliverables) was deleted.

## Note on two earlier accidental overwrites

During iteration on the harness's screen-classification logic (before the fix described above), two runs mis-selected "Local" storage, which — due to `cwd == USERPROFILE` in this harness — overwrote the real global config with a single test profile. Both incidents were caught immediately and the file was restored from verified original content each time; the final state above is the true original content, confirmed byte-for-byte against a backup taken at task start.
