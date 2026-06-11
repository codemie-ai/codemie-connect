# Plan: Home/launcher page + app icon

**Spec:** `./spec.md` · **Slug:** home-launcher · **Branch:** feat/tauri-macos-installer

Commit per task group, referencing `home-launcher`.

---

## Task 1 — Rust: `check_codemie_setup` (+ unit tests)

**Test-first: yes** — `cargo test` for `parse_setup_config`: `""`/invalid → `(false,0)`; `{"profiles":{}}` → `(false,0)`; `{"profiles":{"default":{}}}` → `(true,1)`; two profiles → `(true,2)`. RED (fn absent) → GREEN.

- Add `parse_setup_config(json: &str) -> (bool, usize)` and `#[tauri::command] check_codemie_setup() -> SetupStatus { configured, profile_count }` to `src-tauri/src/commands/inspector.rs` (reads `$HOME/.codemie/codemie-cli.config.json`; missing file → `(false,0)`).
- Register `commands::inspector::check_codemie_setup` in `src-tauri/src/lib.rs`.

## Task 2 — Icon regeneration

**Test-first: no** — visual/bundle asset; verified by inspecting `src-tauri/icons/*` regeneration + final DMG.

- `assets/ai-run-codemie-logo-white_bg.svg` already downloaded.
- Run `cargo tauri icon assets/ai-run-codemie-logo-white_bg.svg`; confirm `src-tauri/icons/*` (icon.icns, *.png, icon.ico) rewritten. `tauri.conf.json` icon list already points at these paths — no config change.

## Task 3 — UI: home view + navigation shell

**Test-first: no** — UI; verified by launch + smoke.

- `ui/index.html`: wrap the current wizard markup in `#wizard-view` (add `hidden`); add `#home-view` (header + 2×2 `.home-tile` grid for the 4 actions + footer); add `#notice-overlay`; add a "‹ Home" back link to the wizard header.
- `ui/styles.css`: `.home-grid` (2×2), `.home-tile` (icon + title + desc, hover), `#notice-overlay`/`#notice-card`, `.back-link`. Dark-theme consistent (#0b0d14).

## Task 4 — UI: boot routing + `enterWizard` + tile handlers

**Test-first: no** — verified by launch + both smoke modes.

- `ui/renderer.js`: keep a master step list; factor `enterWizard(stepIds?)` that (re)builds `Engine` from the (filtered) steps and shows `#wizard-view`. Boot: build infra → `if (flags.probe||flags.smoke)` show wizard + run probe/smoke (unchanged) → else show `#home-view`.
- Wire tiles: (1) `enterWizard()`; (2) `enterWizard(INSTALL_ONLY_IDS)`; (3) `check_codemie_setup` → `runAction('codemie proxy connect desktop')` or notice; (4) `runAction('codemie analytics --report --open --report-output "$HOME/codemie-analytics.html"')`.
- `runAction(cmd, title)`: open keep-open terminal, `spawn_pty(cmd)`. Back link returns to `#home-view`.

## Task 5 — UI: terminal `keepOpen` mode

**Test-first: no** — verified by launch (and existing wizard PTY smoke still auto-closes).

- `ui/terminal.js`: `openTerminal(title, { keepOpen })`; on `pty-exit`, if `keepOpen` show a "‹ Home"/Close affordance + "finished" hint instead of auto-closing. Wizard PTY steps keep `keepOpen:false` (current auto-close).

## Task 6 — Verify + build + finalize

**Test-first: n/a** — verification gate.

- `cargo test` (Task 1 green) + `cargo clippy` clean.
- `CODEMIE_PROBE_SMOKE` + `CODEMIE_SMOKE` green.
- `cargo tauri build --target universal-apple-darwin`; assert DMG < 20 MB; record size + `lipo -archs` on the binary.
- Mount DMG, open `.app` live for the user (no destructive/network action auto-run).
- Commit; set `.state.json.phase = "maintenance"`; handoff summary.
