# Spec: EPMCDME-14504 — pkg Binary Sidecar Spike

**Status**: Draft  
**Timebox**: 2 working days  
**Branch pattern**: `spike/epmcdme-14504-pkg-binary` — all commits `[throwaway]`

---

## Goal

Determine whether `@codemieai/code` can be compiled into a single self-contained binary via `@yao-pkg/pkg`, bundled as a Tauri `externalBin` sidecar, and invoked successfully from inside a signed and notarized macOS `.app` bundle on a clean `aarch64` VM — with no system Node.js, npm, or separate JS files present.

The primary unknown is `keytar`: a compiled native addon that `pkg` cannot bundle statically. The spike must establish whether `keytar` is called unconditionally at startup (a blocker) or is guarded or command-path-specific (non-blocking), and whether `pkg`'s `--assets` mechanism produces a binary that works under macOS hardened runtime.

The deliverable is empirical evidence in `SPIKE_RESULT.md`: either a working demo or a documented blocker.

---

## Three-Phase Approach

### Phase 1 — keytar call-site investigation (half day)

Inspect `assets/codemie-cli/node_modules/@codemieai/code/` for every `require('keytar')` or `import … from 'keytar'` site. Determine:

- Is `keytar` imported unconditionally at module load time (top-level `require`)?
- Is the import guarded by a try/catch or a lazy function?
- Which commands exercise keytar: `--version`, `install`, `setup`, `doctor`, credential operations only?

If keytar is loaded unconditionally at startup with no error guard, document this as a blocker and halt Phase 2. The SPIKE_RESULT.md records this finding as the outcome. If keytar is guarded or confined to credential-caching paths not exercised by `--version` or `install`, proceed to Phase 2.

### Phase 2 — pkg compilation (half day)

Install `@yao-pkg/pkg` globally on the dev machine. Compile `@codemieai/code`'s entry point with:

- Target `node20-macos-arm64` → output `assets/bin/codemie-aarch64-apple-darwin`
- `keytar.node` declared as an external asset via `--assets` so it is extracted to a temp directory at runtime rather than inlined
- `--no-bytecode` if V8 bytecode compilation causes issues with the target Node version
- Target `node20-win-x64` → output `assets/bin/codemie-x86_64-pc-windows-msvc.exe` (best-effort; not validated on a Windows VM)

Document the exact `pkg` invocation in `SPIKE_RESULT.md`. Record the exit code and any asset-path warnings. If compilation fails, document the error and halt.

Verify the macOS binary is a Mach-O (`file codemie-aarch64-apple-darwin`) before proceeding.

### Phase 3 — Tauri integration and VM validation (one day)

**Rust changes (port from `spike/epmcdme-14504-bundle-node`):**

- Add `inject_bundled_bin_path(app: &tauri::AppHandle)` to `src-tauri/src/commands/pathman.rs`. Port the implementation from that branch's `plan.md` (targeting `pathman.rs:110–146`), changing the detection string from `"node-"` to `"codemie-"`. No runtime symlink is needed — the binary name already matches the command name.
- Call `inject_bundled_bin_path(app.handle())` in `src-tauri/src/lib.rs` immediately after the existing `apply_resolved_shell_path()` call at line 22.

**Config changes (spike isolation):**

- Create `src-tauri/tauri.macos.conf.json` with `externalBin: ["../assets/bin/codemie"]` and `bundle.macOS.signingIdentity` set to the Developer ID. Mark every addition with a `// [throwaway]` comment. Do not modify `src-tauri/tauri.conf.json`.

**JS orchestration changes:**

- Short-circuit step 1.2 in `ui/handlers.js` (lines 109–149): the bundled binary embeds Node; no system Node check or download should occur.
- Replace step 1.3 in `ui/handlers.js` (line 175): swap `npm install -g @codemieai/code` with a `codemie --version` probe against the PATH-injected binary.

**Build and sign:**

- Run `cargo tauri build --config src-tauri/tauri.macos.conf.json` to produce a DMG containing `codemie-aarch64-apple-darwin` as a sidecar.
- Re-sign the binary with `codesign --options runtime --timestamp` using the Developer ID identity.

**VM validation (the acceptance gate):**

On a clean `aarch64` macOS VM with no system Node.js, npm, or `@codemieai/code`:

1. Install the signed and notarized `.app` from the DMG.
2. Run `codemie --version` from the app's context and capture stdout/stderr.
3. Run `codemie install [agent]` and capture stdout/stderr.

Record all captured output verbatim in `SPIKE_RESULT.md`.

---

## Acceptance Criteria

1. `codemie --version` prints a version string from inside the signed and notarized `.app` on a clean `aarch64` VM with no system Node.js, npm, or separate JS files.
2. `codemie install [agent]` completes without error from the same environment.
3. `SPIKE_RESULT.md` exists in the spike branch recording: the exact `pkg` invocation and exit code, `codesign` output, and verbatim VM stdout/stderr for both commands — or a documented blocker if Phase 1 or 2 halts early.
4. `keytar` compatibility is documented: unconditional-blocker, guarded-non-blocker, or degraded-but-acceptable, with the evidence that led to the finding.
5. `src-tauri/tauri.macos.conf.json` carries `[throwaway]` comments on every spike-specific key; `src-tauri/tauri.conf.json` is unmodified.
6. Existing `cargo test` and `npm test` pass on the spike branch without modification to any test.

---

## Non-Goals

- Production quality: no error recovery, retry logic, or UX polish for the bundled binary path.
- System PATH persistence: injecting the bundled binary into the user's shell profile is EPMCDME-14508's scope.
- Installer integration: no changes land on `main`; no production flow is altered.
- App signing infrastructure: provisioning, certificates, and CI notarization are EPMCDME-14508's scope. The spike uses the Developer ID already present in `sign-dmg.sh`.
- Windows VM validation: Windows `pkg` compilation is attempted (best-effort), but runtime validation on a Windows VM is out of scope.
- Universal (arm64 + x86_64) macOS binary: `pkg` produces per-arch binaries; fat binaries are not supported.
- Unit tests for `inject_bundled_bin_path`: a follow-on story owns this; the spike relies on manual VM validation.
- `cargo tauri build` on CI: no CI/CD pipeline exists.

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `keytar` loaded unconditionally at startup — `pkg` compilation fails or binary crashes at launch | Medium | Blocker | Phase 1 inspection gates Phase 2; finding is itself a valid spike deliverable |
| Extracted unsigned `keytar.node` blocked by macOS library validation under hardened runtime | Medium | High | Test with `--assets` first; if blocked, document and record as follow-on for EPMCDME-14508 signing scope |
| `pkg`-compiled Mach-O fails `codesign --options runtime` re-signing | Low | High | Previous spike validated the same re-signing pattern for the Node.js binary; apply same flags |
| Step 1.2 short-circuit triggers spurious Node.js download | Low | Medium | Verify step 1.2 handler returns early before any `node --version` probe |
| `tauri build` fails due to sidecar filename mismatch | Low | Low | Fails early with a clear error; recoverable by correcting the triple suffix |

---

## Deliverable

`SPIKE_RESULT.md` in the spike branch, structured as:

- **Phase 1 finding**: keytar call-site summary and blocker/non-blocker determination
- **Phase 2 finding**: `pkg` invocation, compilation exit code, Mach-O verification, asset warnings
- **Phase 3 finding**: `codesign` output, VM `codemie --version` output, VM `codemie install [agent]` output
- **Recommendation**: proceed to production integration (EPMCDME-14508) or escalate keytar as a blocker requiring an alternative bundling strategy
