# Spike: pkg Binary Sidecar — SPIKE_RESULT.md

## Phase 1 — keytar call-site finding

**Verdict**: guarded-non-blocker

**Sites**:
- `assets/codemie-cli/node_modules/@codemieai/code/dist/utils/security.js:242`
  — guard status: lazy dynamic `import('keytar')` inside a `try/catch` block within the `getKeytar()` helper; on failure sets `keytar = null` and falls back to encrypted file storage
  — commands affected: `doctor` (JWTAuthCheck), `proxy` (daemon-manager, connect/disconnect-orchestrator, IDE connectors), `sdk` (cli-utils credential reads)
  — commands NOT affected (no credential path): `--version`, `install`, `setup`

**Evidence summary**:
- `let keytar = undefined` declared at module scope, never synchronously loaded
- `getKeytar()` is the sole consumer of `import('keytar')`; it is never called at module top-level
- Every caller (`storeSSOCredentials`, `retrieveSSOCredentials`, `clearSSOCredentials`, `storeJWT`, `retrieveJWT`, `clearJWT`) checks `if (keytarModule)` before invoking any keytar method; all credential operations also write an encrypted fallback file unconditionally
- The `--version` command reads only `package.json`; the `install` and `setup` commands import no credential utilities

**Decision**: proceed to Phase 2

## Phase 2 — pkg compilation

**macOS invocation**: `pkg assets/codemie-cli/node_modules/@codemieai/code/bin/codemie.js --target node22-macos-arm64 --output assets/bin/codemie-aarch64-apple-darwin --no-bytecode --public-packages "*"`

**First attempt (node20 target)**: Failed — pre-built binary `node-v20.20.2-macos-arm64` not in remote cache (404), and `@yao-pkg/pkg` cannot cross-compile macOS from source on Windows ("Not able to build for 'macos' here, only for 'win'", exit code -1073740791). Node20 is absent from the v3.6 pkg-fetch release. Retry used `node22` target (v22.22.3 binary is in the v3.6 release cache).

**macOS exit code**: 0

**Mach-O verification**: Magic bytes CF FA ED FE — valid Mach-O arm64 (little-endian, confirmed via PowerShell `[System.IO.File]::ReadAllBytes(...)`)

**File size**: 173,162,842 bytes (165.14 MB)

**Asset warnings**:
- `Cannot include file xdg-open` — Linux helper for the `open` npm package; must be distributed alongside the binary if needed on Linux (not relevant for macOS/Windows targets)
- `esbuild transform returned no code for @standard-schema/spec/dist/index.js` — empty/export-only file, non-fatal
- `Entry 'main' not found in @modelcontextprotocol/client` and `@modelcontextprotocol/server` — these packages lack a `main` field; pkg uses them from context of `stdio-http-bridge.js`, non-fatal
- Multiple `@langchain/langgraph-sdk` ESM modules with top-level await + export — pkg used original source as-is; non-fatal with `--public-packages "*"`
- macOS binary unsigned: "Unable to sign the macOS executable" — binary must be signed with `codesign --sign - <executable>` on a Mac before distribution; ad-hoc signature is sufficient

**Windows**: success — `assets/bin/codemie-x86_64-pc-windows-msvc.exe` produced, 170,639,215 bytes (162.76 MB), exit code 0. Command: `pkg ... --target node22-win-x64 --output assets/bin/codemie-x86_64-pc-windows-msvc.exe --no-bytecode --public-packages "*"`. Note: node22 target with pre-built binary from pkg-fetch v3.6 release cache; `patch` from Git for Windows was added to PATH to unblock source fallback, but the pre-built binary was fetched successfully.

**Decision**: proceed to Phase 3
