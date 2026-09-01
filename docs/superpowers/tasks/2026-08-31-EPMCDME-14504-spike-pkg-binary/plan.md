# pkg Binary Sidecar Spike — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Determine empirically whether `@codemieai/code` compiles to a self-contained `@yao-pkg/pkg` binary, survives Tauri `externalBin` sidecar wiring and `codesign --options runtime`, and runs `codemie --version` / `codemie install [agent]` on a clean aarch64 macOS VM with no system Node.js.

**Architecture:** Three-phase spike reusing the `externalBin` + PATH-injection patterns from `spike/epmcdme-14504-bundle-node`. The pkg binary replaces the JS-tree bundle entirely — no `bundle.resources` needed. Config changes are isolated to a new `src-tauri/tauri.macos.conf.json` override; the base `tauri.conf.json` is never touched.

**Tech Stack:** Rust/Tauri v2, `@yao-pkg/pkg`, Node 20, macOS `codesign`, Developer ID `9H5BAHWPG9`

**Spec:** `docs/superpowers/tasks/2026-08-31-EPMCDME-14504-spike-pkg-binary/spec.md`

## Global Constraints

- Branch: `spike/epmcdme-14504-pkg-binary` — every commit prefixed `[throwaway]`
- `src-tauri/tauri.conf.json` must not be modified
- Unit tests for `inject_bundled_bin_path` are out of scope — follow-on story owns them
- Windows runtime validation is out of scope; Windows compilation is best-effort only
- No changes land on `main`
- Commit per task using the repository's existing convention (`[throwaway] <type>: <subject>`)

---

### Task 1: Spike branch setup and keytar call-site investigation (Phase 1)

**Files:**
- Create: `SPIKE_RESULT.md`

**Test-first: no** — investigative phase; an unconditional-blocker finding is itself a valid spike deliverable and halts subsequent tasks.

- [ ] Create branch: `git checkout -b spike/epmcdme-14504-pkg-binary`
- [ ] Run baseline: `cargo test` and `npm test` — all must pass before any changes.
- [ ] Search `assets/codemie-cli/node_modules/@codemieai/code/` for every `require('keytar')` and `import … from 'keytar'` occurrence. For each site record: file path, line number, whether the call is at module top-level or inside a function/try-catch, and which CLI subcommands (`--version`, `install`, `setup`, `doctor`, credential ops) exercise that code path.
- [ ] Classify the verdict:
  - **unconditional-blocker**: top-level `require` with no error guard, reachable by `--version` or `install` — record in `SPIKE_RESULT.md` and halt; Tasks 2–7 are skipped; this finding is the spike's deliverable.
  - **guarded-non-blocker** or **degraded-but-acceptable**: wrapped in try/catch or lazy call, not in the `--version`/`install` critical path — proceed to Task 2.
- [ ] Write `SPIKE_RESULT.md` with Phase 1 section:

```markdown
## Phase 1 — keytar call-site finding
**Verdict**: <unconditional-blocker | guarded-non-blocker | degraded-but-acceptable>
**Sites**: <file:line — guard status — commands affected>
**Decision**: <proceed to Phase 2 | halt — pkg approach blocked>
```

---

### Task 2: pkg compilation — macOS arm64 and Windows best-effort (Phase 2)

**Files:**
- Populate (not committed): `assets/bin/codemie-aarch64-apple-darwin`
- Populate (not committed): `assets/bin/codemie-x86_64-pc-windows-msvc.exe`
- Update: `SPIKE_RESULT.md` (Phase 2 section)

**Test-first: no** — empirical compilation step; outcome captured verbatim in SPIKE_RESULT.md.

- [ ] Install `@yao-pkg/pkg` globally: `npm install -g @yao-pkg/pkg`
- [ ] Find the CLI entry point: read the `"bin"` field in `assets/codemie-cli/node_modules/@codemieai/code/package.json`.
- [ ] Compile for macOS arm64 (run from repo root):
  ```
  pkg <entry-point> \
    --target node20-macos-arm64 \
    --output assets/bin/codemie-aarch64-apple-darwin \
    --assets "assets/codemie-cli/node_modules/keytar/build/Release/keytar.node" \
    --no-bytecode
  ```
  Capture exact invocation, stdout, stderr, and exit code. Omit `--no-bytecode` if pkg accepts V8 bytecode without errors and retry.
- [ ] Verify Mach-O: `file assets/bin/codemie-aarch64-apple-darwin` must report `Mach-O 64-bit executable arm64`. If not, halt and record error.
- [ ] Attempt Windows compilation (best-effort; skip if cross-compilation is unavailable on this machine):
  ```
  pkg <entry-point> \
    --target node20-win-x64 \
    --output assets/bin/codemie-x86_64-pc-windows-msvc.exe \
    --assets "assets/codemie-cli/node_modules/keytar/build/Release/keytar.node"
  ```
- [ ] Append to `SPIKE_RESULT.md`:
  ```markdown
  ## Phase 2 — pkg compilation
  **macOS invocation**: <exact command>
  **macOS exit code**: <0 or error>
  **Mach-O verification**: <file output>
  **Asset warnings**: <any pkg warnings about unresolved asset paths>
  **Windows**: <success | skipped | error>
  **Decision**: <proceed to Phase 3 | halt>
  ```

---

### Task 3: Port inject_bundled_bin_path and wire in lib.rs (Phase 3 — Rust)

**Files:**
- Modify: `src-tauri/src/commands/pathman.rs` — append new function after the last existing helper
- Modify: `src-tauri/src/lib.rs:22` — add one call immediately after `apply_resolved_shell_path()`

**Test-first: no** — unit tests for `inject_bundled_bin_path` are explicitly out of scope (spec Non-Goals); existing `cargo test` is the regression baseline.

- [ ] In `pathman.rs`, append after the last existing function. This ports the function from `spike/epmcdme-14504-bundle-node`, changing the detection string from `"node-"` to `"codemie-"`:

```rust
/// Prepend the directory containing the bundled codemie sidecar to the
/// process PATH so all login-shell invocations (runner.rs, pty.rs) find it.
/// Called once in setup() before any thread is spawned.
pub fn inject_bundled_bin_path(app: &tauri::AppHandle) {
    let sidecar_name = concat!("codemie-", env!("TARGET"));
    // Approach B: Tauri places the sidecar alongside the main exe
    let bin_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .filter(|d| d.join(sidecar_name).exists() || d.join("codemie").exists())
        // Approach A fallback: resource_dir
        .or_else(|| {
            app.path()
                .resource_dir()
                .ok()
                .filter(|d| d.join(sidecar_name).exists() || d.join("codemie").exists())
        });
    if let Some(dir) = bin_dir {
        let current = std::env::var("PATH").unwrap_or_default();
        // SAFETY: setup() runs before any thread is spawned; no data races on PATH.
        unsafe { std::env::set_var("PATH", format!("{}:{}", dir.display(), current)) };
        log::info!("[inject_bundled_bin_path] prepended {}", dir.display());
    } else {
        log::warn!("[inject_bundled_bin_path] sidecar not found; PATH unchanged");
    }
}
```

- [ ] In `src-tauri/src/lib.rs`, immediately after the `apply_resolved_shell_path();` call at line 22, add:
  `commands::pathman::inject_bundled_bin_path(app.handle());`
- [ ] Run `cargo fmt` then `cargo clippy -- -D warnings`; fix any lint issues before continuing.
- [ ] Run `cargo test` — all tests must pass.

---

### Task 4: Create src-tauri/tauri.macos.conf.json override (Phase 3 — Config)

**Files:**
- Create: `src-tauri/tauri.macos.conf.json`
- Verify/update: `.gitignore` — ensure `assets/bin/` is excluded

**Test-first: no** — config-only; validated at `cargo tauri build` time in Task 6.

- [ ] Check `.gitignore` for an `assets/bin/` entry. If absent, add it — the previous spike branch added this rule but it may not be on `main`.
- [ ] Create `src-tauri/tauri.macos.conf.json`. JSON has no comment syntax; the `_throwaway_note` key serves as the inline marker required by AC#5:

```json
{
  "$schema": "../node_modules/@tauri-apps/cli/schema.json",
  "_throwaway_note": "[throwaway] spike-only override — externalBin + signingIdentity must not be merged to main",
  "bundle": {
    "externalBin": ["../assets/bin/codemie"],
    "macOS": {
      "signingIdentity": "Developer ID Application: ULADZISLAU SVETLAKOU (9H5BAHWPG9)"
    }
  }
}
```

- [ ] Confirm `assets/bin/codemie-aarch64-apple-darwin` is present (placed by Task 2). `cargo tauri build` will fail with a clear error if the file is missing — recoverable by re-running Task 2.

---

### Task 5: Short-circuit handlers.js steps 1.2 and 1.3 (Phase 3 — JS)

**Files:**
- Modify: `ui/handlers.js:109–197`

**Test-first: no** — these handler code paths have no existing test coverage (confirmed by technical analysis); `npm test` serves as the regression baseline.

- [ ] In `ui/handlers.js`, at the very top of the step 1.2 handler callback (around line 109), add an early return before any `node --version` probe:
  ```js
  // [throwaway] pkg binary is self-contained; no system Node check required
  emit({ type: 'step-complete' }); return;
  ```
- [ ] In `ui/handlers.js`, replace the `runner.runStream('npm install -g @codemieai/code', …)` call in the step 1.3 handler (around line 175) with a bundled-binary version probe:
  ```js
  // [throwaway] bundled binary replaces npm install
  const result = await runner.runCapture('codemie --version');
  if (result.code !== 0) throw new Error(`bundled codemie not on PATH: ${result.stderr}`);
  emit({ type: 'step-complete', data: result.stdout.trim() }); return;
  ```
- [ ] Run `npm test` — all engine, model, and version-utils tests must pass.

---

### Task 6: Build, re-sign, and record codesign output (Phase 3 — Build)

**Files:**
- Update: `SPIKE_RESULT.md` (Phase 3 build section)

**Test-first: no** — build and signing are empirical; output captured verbatim.

- [ ] Run: `cargo tauri build --config src-tauri/tauri.macos.conf.json`
  Confirm `codemie` appears in `Contents/MacOS/` of the built `.app` bundle.
- [ ] Re-sign the sidecar with hardened runtime:
  ```
  codesign --force --options runtime --timestamp \
    --sign "Developer ID Application: ULADZISLAU SVETLAKOU (9H5BAHWPG9)" \
    <path/to/.app/Contents/MacOS/codemie>
  ```
- [ ] Verify: `codesign --verify --deep --strict --verbose=2 <path/to/.app>`
- [ ] Append to `SPIKE_RESULT.md`:
  ```markdown
  ## Phase 3 — Build and sign
  **tauri build exit code**: <0 or error>
  **codesign output**: <verbatim>
  **codesign --verify output**: <verbatim>
  ```

---

### Task 7: VM validation and SPIKE_RESULT.md completion (Phase 3 — Validation)

**Files:**
- Update: `SPIKE_RESULT.md` (VM section + Recommendation)

**Test-first: no** — manual validation on a clean VM; verbatim output is the primary spike deliverable.

- [ ] Transfer the signed DMG to a clean aarch64 macOS VM. Confirm preconditions: no system Node.js, no npm, no `@codemieai/code` installed.
- [ ] Install the `.app` from the DMG and launch it — this triggers `inject_bundled_bin_path` and prepends the sidecar directory to PATH.
- [ ] From a terminal session started *after* the app launch (so the mutated PATH is inherited), run `codemie --version` and capture stdout/stderr.
- [ ] Run `codemie install [agent]` and capture stdout/stderr.
- [ ] Complete `SPIKE_RESULT.md`:
  ```markdown
  ## Phase 3 — VM validation
  **VM state**: macOS <version>, aarch64, no system Node/npm/codemie
  **codemie --version stdout**: <verbatim>
  **codemie --version stderr**: <verbatim>
  **codemie install [agent] stdout**: <verbatim>
  **codemie install [agent] stderr**: <verbatim>

  ## Recommendation
  **Decision**: <proceed to EPMCDME-14508 production integration | escalate keytar as blocker requiring alternative bundling strategy>
  **Rationale**: <one paragraph>
  ```

---

## Negative-constraint pass

| Constraint (spec Non-Goals / negative requirements) | Honoring task | Violation check |
|---|---|---|
| Do not modify `src-tauri/tauri.conf.json` | Task 4 creates a new override file; base config is never opened | No task opens `tauri.conf.json` for writing |
| No error recovery, retry logic, or UX polish | Short-circuits in Task 5 are one-liners; no fallback added | No task adds recovery or polish paths |
| No system PATH persistence (shell-profile injection is EPMCDME-14508's scope) | No task touches `~/.zprofile`, `~/.zshrc`, or `pathman::persist()` | Confirmed absent from Tasks 3, 5 |
| No changes land on `main` | All tasks execute on `spike/epmcdme-14504-pkg-binary` | No task includes a merge or PR step |
| No Windows VM validation | Task 2 attempts Windows compilation best-effort; no VM validation task exists for Windows | Confirmed absent |
| No universal (fat) binary | Task 2 compiles two separate per-arch binaries; fat binary not attempted | Confirmed absent |
| No unit tests for `inject_bundled_bin_path` | Task 3 marks this out of scope; no test file is created | No test added |
| No CI/CD pipeline usage | All quality gates and build steps are executed manually | No `.github/` or `.gitlab-ci.yml` touches |

negative-constraints: all eight Non-Goals verified; no task violates any of them.
