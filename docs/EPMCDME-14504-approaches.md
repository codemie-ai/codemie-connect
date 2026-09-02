# EPMCDME-14504 — Spike Comparison: Bundling CodeMie CLI in macOS .app

Two spikes investigated how to ship the CodeMie CLI inside the Tauri installer with no system Node.js required. Both are throwaway branches. **Decision: Approach 2 chosen.**

---

## Approach 1 — Bundle Node.js Runtime + JS files (`spike/epmcdme-14504-bundle-node`)

**Concept:** Download the official Node.js 22 LTS aarch64 tarball, place the `node` binary as a Tauri `externalBin` sidecar (Approach B) or under `bundle.resources` (Approach A), and ship the CLI JS tree alongside it. A new `inject_bundled_bin_path` Rust function prepends the bundled binary directory to process PATH at startup so all `zsh` and PTY children pick it up transparently.

**Status: ABORTED — VM validation never executed.**

The code was written and compiled cleanly:
- `inject_bundled_bin_path` added to `pathman.rs`; `lib.rs` calls it at startup
- `tauri.macos.conf.json` configured with `externalBin` + `signingIdentity` (Approach B)
- `handlers.js` step 1.3 bypasses npm install, uses bundled CLI
- `cargo build` passed; code review found 10 findings, fixes were requested

The spike was closed before the aarch64 VM build and signing test ran. The key open questions remain unanswered:

- Will Gatekeeper accept a re-signed official `node` binary under hardened runtime?
- Does `com.apple.security.cs.require-lv` block the re-signed binary?
- Does `codesign --deep` in `sign-dmg.sh` sign the `node` sidecar correctly under Approach A?

**Bundle size:** ~70 MB for the Node.js tarball alone, before the JS tree.

**Risk:** Re-signing the official Apple-notarized `node` binary is the highest-risk unknown. macOS hardened runtime with `require-lv` is known to reject re-signed binaries that were originally signed by a different identity. AMFI log analysis would be required on failure.

---

## Approach 2 — Single `pkg`-compiled Binary (`spike/EPMCDME-14504-pkg-binary`) ✓ CHOSEN

**Concept:** Compile `@codemieai/code` CLI source + embedded Node.js runtime into one standalone binary using `@yao-pkg/pkg`. Declare it as a Tauri `externalBin` sidecar — same mechanism as Approach B above, but one self-contained Mach-O instead of `node` + JS tree.

**Status: COMPILATION VERIFIED — VM validation pending.**

Phase-by-phase results:

| Phase | Result |
|-------|--------|
| 1 — keytar audit | Non-blocker. Lazy dynamic `import('keytar')` in try/catch; falls back to encrypted file storage on failure. Commands `--version`, `install`, `setup` have no credential path. |
| 2 — pkg compilation (macOS arm64) | **Exit 0.** Binary: `assets/bin/codemie-aarch64-apple-darwin`, 165 MB, magic bytes `CF FA ED FE` (valid Mach-O). Used `node22` target — `node20` absent from pkg-fetch v3.6 cache. Binary is unsigned; must run `codesign --sign - <binary>` on Mac before distribution. |
| 2 — pkg compilation (Windows x64) | **Exit 0.** Binary: `assets/bin/codemie-x86_64-pc-windows-msvc.exe`, 163 MB. |
| 3 — PATH injection | `inject_bundled_bin_path` implemented in `pathman.rs`; runtime arch detection via `std::env::consts::ARCH` + `cfg` guards. 29/29 tests pass, `cargo clippy -D warnings` clean. |

### Investigated risks

**V8 JIT under macOS hardened runtime — resolved by design**

The pkg-compiled binary embeds V8, which requires the `com.apple.security.cs.allow-jit` entitlement to run under hardened runtime. Without it the binary crashes at startup or falls back to interpreter-only mode. This entitlement is standard for Developer ID distribution (no App Store review required) and is used by Electron and all Node-embedding apps. Fix: create `src-tauri/entitlements.plist` with `allow-jit` and reference it via `bundle.macOS.entitlements` in `tauri.conf.json` — Tauri passes it to `codesign` automatically for both the app and its `externalBin` sidecar during `cargo tauri build`. Needs VM validation to confirm no additional entitlements are required (e.g. `com.apple.security.cs.allow-unsigned-executable-memory`).

**Gatekeeper acceptance of the pkg-compiled binary — open, requires VM**

Zero empirical evidence of runtime behaviour on a clean aarch64 Mac. The Mach-O magic bytes are confirmed valid but the binary has never been signed, notarized, or launched under Gatekeeper. This is the primary remaining gate before production adoption.

**`keytar` native addon — non-blocker, security trade-off accepted**

When `keytar` is unavailable (pkg cannot bundle native `.node` addons statically), credentials are stored as AES-256-CBC encrypted files under `~/.codemie/`:

| Credential type | Fallback path |
|----------------|---------------|
| SSO (default) | `~/.codemie/sso-credentials.enc` |
| SSO (per URL) | `~/.codemie/credentials/sso-<sha256>.enc` |
| JWT (default) | `~/.codemie/credentials/jwt-credentials.enc` |
| JWT (per URL) | `~/.codemie/credentials/jwt-<sha256>.enc` |

The encryption key is machine-specific and also stored on disk — weaker than system keychain (which is protected by the OS and user login password) but not plaintext. Importantly, the code always writes to both keychain and file when keytar is available; the fallback only means keychain is skipped on write and read. Commands `--version`, `install`, and `setup` have no credential path and are unaffected. Commands `doctor`, `proxy`, and `sdk` will function correctly but use file-based credential storage instead of the system keychain. This trade-off is accepted for the production follow-on.

### Remaining open items before production adoption

- VM validation on clean aarch64 macOS: sign with `entitlements.plist` containing `allow-jit`, notarize, launch from DMG, run `codemie --version` and `codemie install claude`
- Confirm no additional entitlements needed beyond `allow-jit`
- Integrate signing with entitlements into `sign-dmg.sh`
- Binary size (~165 MB) acceptable for spike; may warrant investigation for production

**Asset warnings (non-fatal):** `xdg-open` excluded (Linux only), empty `@standard-schema/spec` entry, `@modelcontextprotocol` packages missing `main` field, `@langchain/langgraph-sdk` ESM modules with top-level await.

---

## Comparison

| | Approach 1 (Bundle Node tarball) | Approach 2 (pkg binary) |
|---|---|---|
| Binaries to sign | 2 — app + `node` Mach-O | 2 — app + `codemie` Mach-O |
| Re-signing risk | **High** — official Node binary, `require-lv` unknown | Lower — `pkg`-produced binary, no prior signing identity |
| JIT entitlement | Same gap | Solvable via `entitlements.plist` + `allow-jit` |
| macOS VM tested | **No** | **No** |
| Compilation verified | Cargo build only | pkg exit 0, Mach-O magic bytes confirmed |
| Bundle size | ~70 MB Node + JS tree | ~165 MB single binary |
| PATH injection | `inject_bundled_bin_path` (Rust, shared with Approach 2) | Same function |
| Cross-platform | macOS only in spike | macOS arm64 + Windows x64 both compiled |
| Tauri complexity | `externalBin` + `resources` + macOS conf override | `externalBin` only |
| Credential storage | keytar + file fallback (same) | keytar + file fallback (same) |
| Status | Aborted | Implementation complete, VM pending |

---

## Decision: Approach 2 chosen

Approach 2 (pkg binary) is selected for the production follow-on EPMCDME-14508.

- Compilation is verified end-to-end on both macOS arm64 and Windows x64; Approach 1 was never built on macOS.
- The primary blocker (V8 JIT entitlement) is solvable with a standard `entitlements.plist` — no App Store review, no special Apple approval.
- The `keytar` degradation is accepted: credential commands fall back to AES-256-CBC file storage under `~/.codemie/`, which is functional and non-plaintext.
- A single self-contained binary is simpler to sign, bundle, and maintain than a Node tarball + JS tree.
- Cross-platform support (macOS + Windows) falls out of the same toolchain with no additional architecture decisions.
- The re-signing risk specific to Approach 1 (re-signing an Apple-notarized official Node binary under a different identity) is avoided entirely.

Remaining gate: clean aarch64 VM validation of the signed and notarized binary with `allow-jit` entitlement.
