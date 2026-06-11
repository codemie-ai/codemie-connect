# Complexity Assessment: tauri rust electron migration installer macos pty

**Task**: Migrate CodeMie macOS installer from Electron to Tauri with greenfield Rust backend (portable-pty, reqwest, osascript, serde_yaml) while surgically updating frontend JS (Option B architecture).
**Generated**: 2026-06-11T00:00:00Z

---

## Dimension Scores

| Dimension            | Score | Label    |
|----------------------|-------|----------|
| Component Scope      | 6     | XXL      |
| Requirements Clarity | 2     | S        |
| Technical Risk       | 5     | XL       |
| File Change Estimate | 6     | XXL      |
| Dependencies         | 6     | XXL      |
| Affected Layers      | 5     | XL       |

**Total: 30/36 — XL**

---

## Key Reasoning

- **Component Scope (XXL)**: Full architectural boundary replacement — Electron contextBridge/ipcMain entirely replaced by Tauri commands/events; 11 Rust modules created from scratch mapping to 11 Node.js modules; IPC contract (23 channels) fully re-mapped. "Migrate" red flag applied (already at XXL).
- **File Change Estimate (XXL)**: 11 new Rust source files (main.rs, state.rs, commands/{engine,runner,pty,installer,inspector,pathman,downloader,logger,window}.rs, steps.rs) plus 6 JS files updated surgically, plus tauri.conf.json, Cargo.toml, build.rs, capabilities/default.json. Exceeds the 6+ new files and 16+ modified threshold.
- **Dependencies (XXL)**: ~10 new Rust crates required (tauri, portable-pty, reqwest, tokio, serde, serde_yaml, serde_json, thiserror, futures, tauri-build) plus Rust toolchain (rustup) and Tauri CLI — none yet installed. Exceeds the 3+ new dependencies XXL threshold.
- **Technical Risk (XL)**: Base L(4) from novel PTY thread-emit pattern (portable-pty reader on dedicated std::thread emitting Tauri events) and osascript sudo replacement; bumped to XL(5) by "real-time/streaming" red flag (PTY interactive streaming to xterm.js). Greenfield nature keeps this below XXL — no live users, no data migration, old Electron app untouched.
- **Affected Layers (XL)**: UI (renderer JS + xterm.js) + IPC/API layer (Tauri commands/events) + Service/business logic (engine, handlers, runner, inspector, installer, pathman, downloader) + External (nodejs.org download, npm, osascript, codemie PTY subprocesses) + Build/Infra (Cargo, tauri.conf.json, universal binary targets). Single codebase, no cross-service changes.
- **Red flags applied**: "Migrate large subsystem" → Component Scope bumped (confirmed XXL). "Real-time/Streaming" PTY requirement → Technical Risk bumped from L(4) to XL(5).

---

## Routing

SPLIT REQUIRED — XL (30/36). Splitting is strongly recommended. Provide decomposed stories or confirm you want to proceed as-is.

---

## Splitting Recommendation

- **By layer**: Story 1 — Tauri scaffolding + static frontend serving (tauri.conf.json, main.rs skeleton, capabilities, universal build target, static ui/ dir served). Story 2 — Rust primitives layer (runner.rs, inspector.rs, pathman.rs, logger.rs, steps.rs + Tauri commands wired). Story 3 — PTY integration (pty.rs with portable-pty reader thread + Tauri event emit + frontend terminal.js invoke/listen wiring). Story 4 — Installer + download layer (installer.rs with osascript sudo, downloader.rs with reqwest streaming progress). Story 5 — Frontend IPC migration (renderer.js, sprite.js, log.js, engine.js/handlers.js Option B wiring).

- **By feature**: Story 1 — Non-interactive steps only (git check, node check, codemie CLI install via npm — no PTY). Story 2 — PTY interactive steps (codemie setup, codemie install claude — requires portable-pty integration). Story 3 — Node.js .pkg download + sudo install (reqwest + osascript path). Story 4 — UI completeness (approval gate, log panel resize, sprite animation, fatal overlay).

- **By dependency**: Story 1 — Rust toolchain setup + Tauri scaffold (unblocks all other stories; installs rustup, cargo-tauri, both universal targets, verifies DMG output). Story 2 — portable-pty integration spike (validates the reader-thread emit pattern before other stories depend on it). Story 3 — reqwest download integration (validates streaming progress pattern). Story 4 — Full wiring of engine/handlers Option B.

- **By phase**: Phase 1 — Infrastructure (scaffolding, build pipeline, hello-world DMG under 20MB verified). Phase 2 — Non-PTY backend commands (runner, inspector, pathman, installer, downloader, logger all working as Tauri commands with frontend calling invoke). Phase 3 — PTY integration (spawn_pty, pty_input, pty_resize, engine:pty-data/exit events). Phase 4 — End-to-end wizard flow (full install sequence runs, approval gate works, log panel works, sprite animates).

> XL: Splitting is strongly recommended. Provide decomposed stories or confirm you want to proceed as-is.
