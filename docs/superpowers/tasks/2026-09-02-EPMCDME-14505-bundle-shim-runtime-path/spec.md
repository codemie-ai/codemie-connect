# Spec: Bundled Node Runtime Staging and Shim Wiring (Windows)

**Ticket**: EPMCDME-14505 (`EPMCDME-14505-bundle-shim-runtime-path`)
**Date**: 2026-09-03
**Decision record**: `.ai-run/decisions/2026-09-03-EPMCDME-14505-packaging-approach.md`
**Depends on**: EPMCDME-14573 (target layout, `pathman.rs` probe, `cmd.exe` dispatch — merged)

---

## Goal

Make `codemie --version` and `codemie install [agent]` work on a clean Windows user account with no system Node.js or npm, by staging a pinned portable Node runtime and a production CLI dependency tree into the NSIS bundle, and pointing the existing `.cmd` shim at them. Replace the `@yao-pkg/pkg` single-binary path entirely.

The build must **fail loudly** when any bundled artifact is missing, empty, or unreachable. Silent omission is the specific defect this ticket closes.

---

## Background

EPMCDME-14573 fixed the installed target layout, added `codemie.cmd` to the `pathman.rs` probe, and switched Windows shell dispatch to `cmd.exe`. It explicitly deferred *source preparation* to this ticket. That preparation was instead implemented with `pkg` (`ef60e76`), which produces a binary that crashes on first run with `[pkg] UNEXPECTED-20` and, even once that is fixed, breaks `process.execPath`, `keytar`, and undeclared assets. Full analysis in the decision record.

Consequently the tree is in a mixed state: a `codemie.cmd` shim exists but execs the broken `codemie.exe`; `assets/bin/node-x86_64-pc-windows-msvc.exe` is a **0-byte placeholder**; and `pathman.rs:253` probes `codemie.exe` *before* `codemie.cmd`, so the broken binary wins PATH resolution.

---

## Design

### 1. Pinned runtime version

Add a single source of truth at repo root, `runtime.json`:

```json
{
  "nodeVersion": "22.23.2",
  "nodeWin64Sha256": "1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97",
  "cliPackage": "@codemieai/code",
  "cliVersion": "0.14.1"
}
```

`nodeVersion` matches the Node major already targeted by the `pkg` path (`node22`) and satisfies `codemie-code`'s `engines.node >= 20`. `nodeWin64Sha256` must be taken from the official `SHASUMS256.txt` for that release — the staging script verifies against it and aborts on mismatch.

Pinning both versions here makes the bundle reproducible and makes a runtime bump a one-line reviewable change.

### 2. Staging script — `scripts/stage-runtime.ps1`

New script, the sole producer of every bundled artifact. Idempotent; safe to re-run.

**Responsibilities, in order:**

1. Read `runtime.json`.
2. **Node runtime** — if `assets/windows/node/node.exe` is absent or 0 bytes:
   - Download `https://nodejs.org/dist/v<nodeVersion>/node-v<nodeVersion>-win-x64.zip`.
   - Verify SHA-256 against `nodeWin64Sha256`; abort on mismatch.
   - Extract only `node-v<nodeVersion>-win-x64/node.exe` to `assets/windows/node/node.exe`.
3. **CLI tree** — into `assets/codemie-cli/`:
   - Write a minimal `package.json` declaring the single dependency `<cliPackage>@<cliVersion>`.
   - Run `npm install --omit=dev --ignore-scripts=false` so `keytar` and `codemie-opencode` postinstall steps run.
   - `--omit=dev` is required: `codemie-code`'s dev tree includes `node-pty` (64 MB) and `typescript` (23 MB), neither referenced from `dist`.
4. **Prune** — delete paths listed in §3.
5. **Verify** — assert every check in §6; abort non-zero on any failure.

The script writes `assets/staging-manifest.json` recording the resolved Node version, CLI version, total file count, and total byte size. `build-installer.ps1` fails if this file is absent or its `cliVersion` disagrees with `runtime.json`.

`assets/codemie-cli/node_modules/` and `assets/windows/node/` stay untracked (`.gitignore:6` already covers `node_modules/`; add `assets/windows/node/`). Only `runtime.json` and the generated manifest are reviewable inputs.

### 3. Prune list

Applied to `assets/codemie-cli/node_modules/` after install:

| Path | Size | Reason |
|---|---|---|
| `**/*.map` | — | Source maps unused at runtime |
| `**/{test,tests,__tests__,example,examples,docs}/` | — | Not reachable from `dist` |
| `node-pty/` | 64 MB | devDependency; no `dist` reference (verified) |
| `typescript/` | 23 MB | devDependency |
| `@rollup/`, `@esbuild/` | ~12 MB | Build-time only |

**Decision point — `@codemieai/codemie-opencode-windows-x64-baseline` (159 MB).** The `-baseline` variant is the fallback for CPUs lacking modern SIMD. Dropping it takes the bundle from ~468 MB to ~309 MB but breaks `codemie-opencode` on older CPUs. **Do not prune it by default.** Gate it behind a `-NoBaseline` switch on the staging script and leave the default decision to product.

Do **not** prune `keytar/build/Release/keytar.node` — credential storage depends on it and its absence degrades silently.

### 4. Shim rewrite — `assets/windows/bin/codemie.cmd`

Replace the current contents (which exec the pkg binary):

```bat
@echo off
setlocal
set "BUNDLE_DIR=%~dp0.."
"%BUNDLE_DIR%\node\node.exe" "%BUNDLE_DIR%\cli\node_modules\@codemieai\code\bin\codemie.js" %*
exit /b %ERRORLEVEL%
```

Four points, each load-bearing:

- **Entry point is `bin/codemie.js`, not `dist/index.js`.** The EPMCDME-14573 spec §1 specifies `dist/index.js`, which is a **library barrel of re-exports with no CLI bootstrap**. Verified against the staged tree — the 14573 target exits 0 while printing nothing, so `codemie --version` would look like it succeeded:

  ```
  $ node node_modules/@codemieai/code/dist/index.js --version   # 14573 spec §1
  stdout=[]   exit=0
  $ node node_modules/@codemieai/code/bin/codemie.js --version  # this spec
  0.14.1      exit=0
  ```

  `bin/codemie.js` is the package's declared `bin.codemie`: it runs migrations, does the update check, then imports `dist/cli/index.js`. **This corrects the 14573 spec.**
- `%~dp0..` keeps the shim independent of the product name and install root.
- `exit /b %ERRORLEVEL%` propagates the CLI exit code. Without it the shim always reports success, which would mask CLI failures from `runner.rs` `capture()`.
- `setlocal` prevents `BUNDLE_DIR` leaking into the caller's environment.

### 5. Bundle resources — `src-tauri/tauri.conf.json`

Replace the current `bundle.resources` map:

```json
"resources": {
  "../assets/windows/bin/codemie.cmd": "bin/codemie.cmd",
  "../assets/windows/node/node.exe": "node/node.exe",
  "../assets/codemie-cli/node_modules": "cli/node_modules"
}
```

**The CLI tree key must be a plain directory path with NO glob.** This is not stylistic — it is the difference between a working and a silently destroyed bundle. Verified empirically against `tauri-utils 2.9.2` (the exact version in `Cargo.lock`) driving the real 19,754-file tree, with `allow_walk = true` to match `tauri-build-2.6.2/src/lib.rs:572`:

| Form | Pattern | Files | Distinct targets | Colliding | Result |
|---|---|---|---|---|---|
| **A** | `…/node_modules/**/*` → `cli/node_modules/` | 19,754 | **9,782** | **3,516** | **FLATTENED** |
| **B** | `…/node_modules` → `cli/node_modules` | 19,754 | 19,754 | 0 | **PRESERVED** |

Form A flattens every file into one directory, because `tauri-utils/src/resources.rs:196` joins only the file name for glob patterns:

```rust
// if processing a glob and current_dest is not empty
// we put all globbed paths under current_dest
// preserving the file name as it is
ResourcePathsInnerIter::Glob { .. } => dest.join(path.file_name().unwrap()),
```

Measured collisions under Form A: `index.js` ← **620 sources**, `index.d.ts` ← 510, `package.json` ← 352, `README.md` ← 238, `LICENSE` ← 205. Node module resolution would be impossible.

Form B takes the `Walk` branch (`resources.rs:186-192`), which does `dest.join(path.strip_prefix(pattern))` and preserves full structure. Tauri's own test suite confirms both behaviours (`resources.rs:503-563`: `"../src/tiles/**/*" → "tiles"` yields `tiles/grey.tile`, dropping `sky/`; `"../src/sounds" → "voices"` yields `voices/lang/es.wav`, keeping `lang/`).

**Critically, Form A reports `errors: 0`.** Tauri raises nothing — the build succeeds and ships a broken bundle. This is the same silent-success class as the `pkg` warning-with-exit-0 and the `dist/index.js` empty-stdout defects, which is why §6 verification is mandatory regardless of which form is used.

The pkg entry `"../assets/bin/codemie-x86_64-pc-windows-msvc.exe": "bin/codemie.exe"` is **removed** — it is the broken binary and it wins PATH resolution while present.

Installed layout (relative to `%LOCALAPPDATA%\Programs\CodeMie Connect\`), matching EPMCDME-14573 §2:

```
bin\codemie.cmd
node\node.exe
cli\node_modules\@codemieai\code\bin\codemie.js
cli\node_modules\...
```

Resolution cost is not a concern: the full 19,754-file walk completes in **~4.0 s**, so no zip-and-extract fallback is needed for performance. (NSIS compression of that payload is a separate cost, measured during the first real build.)

**Never reintroduce a `*` into the CLI-tree key.** A future edit that "tidies" this into a glob silently reverts to Form A. §7a pins this with a test.

### 6. Build verification — `build-installer.ps1` rewrite

> **The assertions in this section are NOT NEGOTIABLE.**
>
> Every defect found in this ticket **succeeded silently**. Three independent tools returned success while producing a broken artifact:
>
> | Defect | Tool's report | Reality |
> |---|---|---|
> | `pkg` bytecode failure | warning, **exit 0** | file dropped from snapshot → `UNEXPECTED-20` at runtime |
> | `dist/index.js` entry point | **exit 0**, empty stdout | CLI never starts; `--version` prints nothing |
> | Tauri glob key | **`errors: 0`** | 19,754 files flattened to 9,782; 620 files overwrite one `index.js` |
>
> Not one of these is detectable by checking an exit code, and every one of them reached — or would have reached — a clean user machine. An exit-code gate is not verification; it is the absence of verification.
>
> Therefore: **no assertion in this section may be removed, downgraded to a warning, or skipped via a flag.** Adding a `-SkipVerify`-style switch is out of scope and must be rejected in review. If an assertion is wrong, fix the assertion — do not delete it. Every assertion must check the *artifact*, never the *exit status of the tool that produced it*.

Delete the entire pkg stage (`build-installer.ps1:22-80`), including the `chalk` `#imports` patch — Node resolves the `imports` field natively, so the patch is dead weight.

New sequence:

1. Run `scripts/stage-runtime.ps1`; abort on non-zero exit.
2. **Pre-build assertions** — abort with the offending path on any failure:
   - `assets/windows/node/node.exe` exists and is > 10 MB (catches the current 0-byte placeholder).
   - `assets/windows/node/node.exe --version` prints exactly `v<nodeVersion>`.
   - `assets/codemie-cli/node_modules/@codemieai/code/bin/codemie.js` exists and is non-empty.
   - `assets/codemie-cli/node_modules/@codemieai/code/dist/cli/index.js` exists (the shim's dynamic-import target).
   - `assets/codemie-cli/node_modules/keytar/build/Release/keytar.node` exists.
   - `assets/staging-manifest.json` `cliVersion` equals `runtime.json` `cliVersion`.
3. **Smoke-test the staged tree before bundling** — the cheapest possible proof the shim contract holds:
   ```powershell
   & "assets\windows\node\node.exe" `
     "assets\codemie-cli\node_modules\@codemieai\code\bin\codemie.js" --version
   ```
   Abort unless exit code is 0 **and** stdout is non-empty. The non-empty check is what would have caught the `dist/index.js` entry-point error in §4.
4. `npx tauri build --bundles nsis`.
5. **Post-build bundle assertions** against `src-tauri/target/release/` — resources land in `target_dir` itself, **not** a `resources/` subdirectory (`copy_resources` does `target_dir.join(target)` at `tauri-build-2.6.2/src/lib.rs:88-103`; `target_dir` is `out_dir`'s third parent, `:536-543`). Assert `bin\codemie.cmd`, `node\node.exe`, and `cli\node_modules\@codemieai\code\bin\codemie.js` exist, **and** that `cli\node_modules` contains nested files — a flattened tree still contains every file *name*, so presence checks alone cannot detect Form A. Scope the stray-`codemie*.exe` scan to `bin\`, `node\`, and `cli\` rather than all of `target\release`. §7a proves the resource map resolves 1:1 *before* the build; this step proves the bundler actually wrote those files, and is the direct mitigation for the EPMCDME-14573 staging risk.

Every abort must name the failing path or command. No stage may rely on `$LASTEXITCODE` alone where the underlying tool can warn-and-succeed — which, as the table above shows, is all three of them.

### 7. `pathman.rs` — remove the `.exe` candidate

`src-tauri/src/commands/pathman.rs:253`:

```rust
// before
&["codemie.exe", "codemie.cmd", "codemie"]
// after
&["codemie.cmd", "codemie"]
```

`codemie.exe` is no longer produced. Leaving it first in the list means any stale `codemie.exe` in a candidate directory — including one left by a previous install of this very branch — shadows the shim and reproduces the reported crash. Existing tests `probe_dir_detects_codemie_cmd_shim` (line 366) and the `bin/` variant (line 389) already cover `.cmd` detection and must keep passing.

The `sidecar_name` construction at `pathman.rs:304-306` still references `codemie-<arch>-pc-windows-msvc.exe`; remove the Windows branch or the probe will keep looking for an artifact the build no longer emits.

### 7a. Resource-resolution regression test

The Form A defect is invisible to every other gate in this spec: Tauri reports no error, the build succeeds, and only a runtime module-resolution failure on a clean machine reveals it. Pin it with a test that runs the real resolver over the real config.

Add to `src-tauri/Cargo.toml`:

```toml
[dev-dependencies]
tauri-utils = { version = "2", features = ["resources"] }
```

`tauri-utils` is already a transitive dependency at the version in `Cargo.lock` (2.9.2), so this adds no new download and cannot drift from what `tauri-build` uses.

New test file `src-tauri/tests/bundle_resources.rs`, which reads `tauri.conf.json` and asserts the map resolves 1:1:

```rust
use std::collections::{HashMap, HashSet};
use tauri_utils::resources::ResourcePaths;

/// `bundle.resources` must map every source file to a unique target.
/// A glob key silently flattens the tree (tauri-utils resources.rs:196),
/// producing 620 sources on a single `index.js` target. See §5.
#[test]
fn bundle_resources_resolve_one_to_one() {
    let conf: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string("tauri.conf.json").unwrap()).unwrap();
    let map: HashMap<String, String> =
        serde_json::from_value(conf["bundle"]["resources"].clone()).unwrap();

    // allow_walk = true matches tauri-build-2.6.2/src/lib.rs:572
    let mut total = 0usize;
    let mut targets = HashSet::new();
    for res in ResourcePaths::from_map(&map, true).iter() {
        let r = res.expect("resource pattern failed to resolve");
        total += 1;
        targets.insert(r.target().to_path_buf());
    }

    assert!(total > 0, "bundle.resources resolved to nothing");
    assert_eq!(
        targets.len(), total,
        "bundle.resources collapses {} sources into {} targets — a glob key is flattening \
         the tree; use a plain directory path instead (see spec §5)",
        total, targets.len()
    );
}

/// The pkg binary must never reappear in the bundle.
#[test]
fn bundle_resources_ship_no_pkg_exe() {
    let conf: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string("tauri.conf.json").unwrap()).unwrap();
    let map: HashMap<String, String> =
        serde_json::from_value(conf["bundle"]["resources"].clone()).unwrap();

    for (src, target) in &map {
        assert!(
            !src.contains("codemie-x86_64-pc-windows-msvc") && !target.ends_with("codemie.exe"),
            "pkg binary reintroduced into bundle.resources: {src} -> {target}"
        );
    }
}
```

Both tests require the staged tree to exist, so `scripts/stage-runtime.ps1` must run before `cargo test`. Gate them with `#[ignore]` plus an explicit `cargo test -- --ignored` step in `build-installer.ps1` if the team wants `cargo test` to stay runnable on an unstaged checkout.

### 8. Unchanged

`src-tauri/installer-hooks.nsi` already registers `$INSTDIR\bin` in `HKCU\Environment` as `REG_EXPAND_SZ` and broadcasts `WM_SETTINGCHANGE`, with matching uninstall removal. No change required.

---

## Acceptance Criteria

- On a clean Windows user account with no system Node.js or npm, `codemie --version` exits 0 and prints a non-empty version string.
- `codemie install [agent]` completes end-to-end using only the bundled runtime.
- A pre-existing system Node.js installation is unmodified after install.
- No UAC prompt during installation or first run.
- PATH is written exclusively to `HKCU\Environment`.
- `build-installer.ps1` exits non-zero with a named path when any bundled artifact is missing, 0 bytes, or absent from the built bundle.
- `build-installer.ps1` exits non-zero if the staged-tree smoke test produces empty stdout.
- No `codemie.exe` is present anywhere in the produced installer.
- `build-installer.ps1` exposes **no** switch that skips or downgrades any §6 assertion. Reviewers must reject one if added.
- Every §6 assertion inspects a produced artifact, not the exit status of the tool that produced it.
- `cargo clippy -- -D warnings` and `cargo test` pass on Windows.

---

## Test Coverage Requirements

**Rust** (`src-tauri/src/commands/pathman.rs`, inline `#[cfg(all(test, windows))]`):
- `candidate_bin_names` does **not** contain `codemie.exe` — pins §7 against regression.
- Existing `probe_dir_detects_codemie_cmd_shim` and its `bin/` variant continue to pass.
- A directory containing only `codemie.exe` is **not** detected as a bundled bin dir.

**Rust** (`src-tauri/tests/bundle_resources.rs`, see §7a):
- `bundle_resources_resolve_one_to_one` — every source maps to a unique target; fails loudly if a glob key flattens the tree.
- `bundle_resources_ship_no_pkg_exe` — no `codemie.exe` source or target in the map.

**Node** (`node:test`, per `.ai-run/guides/testing/testing-patterns.md`):
- `codemie.cmd` content assertions: references `%~dp0..`, targets `bin\codemie.js` (**not** `dist\index.js`), contains `exit /b %ERRORLEVEL%`.
- `tauri.conf.json` `bundle.resources` contains no key or value matching `codemie*.exe`.
- `runtime.json` parses and carries non-empty `nodeVersion`, `nodeWin64Sha256`, `cliVersion`.

**Manual, on a clean Windows VM with no Node or npm** — the acceptance gate; no CI exists:
- Install → open a fresh shell → `codemie --version` prints a version.
- `codemie install claude` completes.
- Uninstall → `HKCU\Environment` PATH no longer contains the install `bin` dir.

---

## Non-goals

- macOS staging and shim (EPMCDME-14503); this ticket is Windows-only. The macOS `assets/bin/codemie-aarch64-apple-darwin` artifact is untouched.
- Code-signing or notarization (EPMCDME-14508).
- Per-user install, uninstall, and handshake detection — the separate, already-approved scope in `docs/superpowers/tasks/2026-09-02-EPMCDME-14505-bundle-shim-runtime-path/spec.md`. That spec is **not superseded**; this one supplies the bundled runtime it assumes.
- Changing `pty.rs` Windows shell from PowerShell.
- Fixing the `const __filename = fileURLToPath(import.meta.url)` idiom in `codemie-code` — an upstream follow-up; the bundled runtime does not require it.
- Adding a bundled-install branch to `cli-updater` — follow-up recorded in the decision record.
- CI pipeline creation.
- Delta or differential updates to the bundled runtime.

---

## Open Risks

- ~~**Tauri glob semantics for 19,756 files.**~~ **RESOLVED 2026-09-03 by empirical verification.** A `**/*` key flattens 19,754 files into 9,782 targets with 3,516 collisions and reports no error; a plain directory key preserves structure 1:1 in ~4.0 s. Resolution is neither slow nor lossy in Form B. See §5 for measurements and §7a for the regression test. The zip-and-extract fallback is no longer required.
- **Installer size.** ~309 MB (without `-baseline`) to ~468 MB (with), plus ~80 MB for `node.exe`, before NSIS compression. If this exceeds distribution limits, the next lever is downloading `codemie-opencode` platform binaries post-install rather than bundling them — a scope change requiring its own ticket.
- **Reproducibility depends on npm registry state.** `npm install` of a pinned version can still drift in transitive dependencies. If bit-identical bundles become a requirement, commit `assets/codemie-cli/package-lock.json` (already tracked) and use `npm ci`.
- **`-baseline` prune is an unresolved product decision.** Shipping without it silently breaks `codemie-opencode` on older CPUs; that failure would surface only in the field, on hardware the team likely does not have.
- **Manual-only acceptance.** No CI exists. Every criterion above that says "clean Windows account" requires a VM run; unit tests cover the surrounding logic but cannot exercise the install path.
