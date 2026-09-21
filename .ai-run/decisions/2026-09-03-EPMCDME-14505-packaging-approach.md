# Packaging Decision — Bundled Node Runtime over `pkg` Single Binary

**Ticket**: EPMCDME-14505 (`EPMCDME-14505-bundle-shim-runtime-path`)
**Date**: 2026-09-03
**Status**: Decided — supersedes the `pkg` staging implemented in `ef60e76`
**Spec**: `.ai-run/specs/2026-09-03-EPMCDME-14505-bundled-node-runtime.md`

---

## Decision

**Ship a portable Node.js runtime alongside the CLI package tree and invoke it through a thin `.cmd` shim on per-user PATH.** Abandon the `@yao-pkg/pkg` single-executable approach.

This is not a preference between two working options. The `pkg` approach is **not viable** for this CLI: one defect blocks the build outright, and four further defects would ship a binary whose `--version` works while its daemons, skills runner, and hook installation are broken.

This decision restores alignment with the already-approved EPMCDME-14573 spec, which specifies the bundled-runtime layout and explicitly assigns source staging to EPMCDME-14505.

---

## Part 1 — Why the `pkg` build fails

### Observed symptom

Build emits a warning and **exits 0**:

```
Warning Failed to generate V8 bytecode for C:\snapshot\codemie-code\dist\utils\errors.js.
Cause: Failed to make bytecode node22-x64 for file C:\snapshot\codemie-code\dist\utils\errors.js.
Use --fallback-to-source to include the file as plain source instead.
```

On a clean Windows machine with no Node or npm, `codemie --version` then dies:

```
Error: [pkg] UNEXPECTED-20: no source or bytecode for C:\snapshot\codemie-code\dist\utils\errors.js
    at readFileFromSnapshot (pkg/prelude/bootstrap.js:943:7)
```

### Root cause

`dist/utils/errors.js:126` uses a standard ESM idiom to recover `__filename`:

```js
const __filename = fileURLToPath(import.meta.url);
```

The failure chain, verified against `@yao-pkg/pkg` 6.22.0 source:

| # | Stage | Evidence |
|---|---|---|
| 1 | `codemie-code` is `"type": "module"`; 495 of 498 `dist/*.js` files are ESM | `package.json`, file scan |
| 2 | pkg transpiles **all** ESM to CJS before bytecode generation | `walker.js:869-888` |
| 3 | The bytecode fabricator wraps each file with `module.wrap(body)`, injecting `__filename` as a **function parameter** | `fabricator.js:23` |
| 4 | The transpiled `const __filename` now collides with that parameter | reproduced, see below |
| 5 | Fabricator child exits non-zero; pkg logs a **warning**, sets `stripe.skip = true`, writes **zero bytes**, and never registers the file in the virtual filesystem | `producer.js:313-325` |
| 6 | pkg exits **0** | observed |
| 7 | First `require` of that file at runtime → `UNEXPECTED-20` | observed |

Reproduced in isolation against the real `fetched-v22.23.2-win-x64` target binary, driving pkg's own fabricator protocol:

```
DIAG: THREW Identifier '__filename' has already been declared
child exit code: 3
```

**Blast radius — 4 files** use this idiom:

- `dist/utils/errors.js`
- `dist/workflows/templates/github/metadata.js`
- `dist/workflows/templates/gitlab/metadata.js`
- `dist/agents/plugins/claude/plugin/skills/codemie-html-report/scripts/inject-css.js`

### The remediation in pkg's own error message does not work

`--fallback-to-source` ships the **transpiled** source (`producer.js:317-320`), which carries the identical collision. Verified against the real runtime CJS loader parameter list:

```
vm.compileFunction(out, ['exports','require','module','__filename','__dirname'])
  -> RUNTIME COMPILE FAILED: Identifier '__filename' has already been declared
```

So `--fallback-to-source` trades `UNEXPECTED-20` for a runtime `SyntaxError`. `--no-bytecode` has the same outcome. **Following pkg's advice costs a build cycle and fixes nothing.**

### Secondary defect — the build script cannot detect this

`build-installer.ps1:58-61` gates only on `$LASTEXITCODE`. pkg warnings do not set an exit code, so a 96 MB installer was produced around a known-broken binary and the defect surfaced only on a clean machine.

The chalk `#imports` patch at `build-installer.ps1:40-69` is the same problem one iteration earlier: hand-patching ESM constructs pkg cannot handle, discovered one clean-machine failure at a time.

---

## Part 2 — Why fixing those 4 files still would not work

These are runtime-behaviour defects, not packaging defects. No pkg flag addresses them.

### `process.execPath` — 4 call sites

Inside a pkg binary `process.execPath` is *the executable itself*, not `node`:

| File | Line | Consequence |
|---|---|---|
| `dist/cli/commands/proxy/daemon-manager.js` | 83 | `spawnDetached(process.execPath, args)` — proxy daemon never starts |
| `dist/cli/commands/codebase/daemon-manager.js` | 68 | codebase daemon never starts |
| `dist/cli/commands/skills/lib/run-skills-cli.js` | 89 | `spawn(process.execPath, [skillsBin, ...])` — skills runner broken |
| `dist/utils/hook-command.js` | 31 | Builds a hook command string **written into Claude Code settings** — persists a corrupted hook into user config |

The `hook-command.js` case is the worst: it corrupts durable user configuration rather than failing at the point of use.

### `keytar` is a native `.node` module

`assets/codemie-cli/node_modules/keytar/build/Release/keytar.node`. It is lazy-loaded with a graceful fallback (`dist/utils/security.js:233-239`), so credential storage would **silently degrade** rather than error — the hardest failure mode to diagnose in the field.

### No `pkg` configuration block

`codemie-code/package.json` has no `pkg` field. `src/workflows/templates/**/*.yml` and the Claude plugin/skills tree are never declared as assets, and dynamic requires are not traced.

### Net outcome

A binary where `codemie --version` succeeds while the proxy daemon, codebase daemon, skills runner, and hook installation all fail — several of them silently. Worse than a clean build failure.

---

## Part 3 — Why the bundled runtime resolves each item

| Blocker under `pkg` | Under bundled runtime |
|---|---|
| ESM → CJS transpile + `__filename` collision | No transform. Node runs the ESM package natively. |
| `process.execPath` (4 sites) | Correctly resolves to the bundled `node.exe`. All 4 work unmodified. |
| `keytar` native module | Loads normally from the real `node_modules` tree. |
| Undeclared template/skill assets | Real files on disk. No snapshot tracing. |
| `chalk` `#imports` patch | Unnecessary — Node resolves `imports` natively. |
| Silent broken builds | Build verifies real files exist; failure is loud. |

Every blocker **disappears** rather than acquiring a workaround. Requiring no system Node or npm is satisfied by bundling the runtime, not by producing a single file.

---

## Part 4 — This restores the approved architecture

The bundled-runtime approach was **already specified and approved**. The `pkg` staging in `ef60e76` diverged from it.

- `docs/superpowers/tasks/2026-09-01-EPMCDME-14573-windows-node-shim-runner-path/spec.md` §1-2 fixes the shim and the installed layout, and states: *"The `src` side of each `bundle.resources` entry … is a staging concern coordinated with EPMCDME-14505. The spec fixes the target layout; EPMCDME-14505 fixes source preparation."*
- `docs/superpowers/tasks/2026-09-02-EPMCDME-14505-bundle-shim-runtime-path/spec.md` Background already asserts *"The app ships a bundled Node runtime (EPMCDME-14504/EPMCDME-14573)"* and lists bundled-runtime packaging under Non-goals — i.e. it assumed this work was done elsewhere.

EPMCDME-14573 recorded this exact failure as an open risk:

> **EPMCDME-14505 staging dependency**: if node runtime and CLI tree are not staged in the expected `src` locations before `cargo tauri build`, the NSIS installer produces a bundle with no runtime and the shim script cannot function. The build must fail loudly rather than silently omitting resources.

That risk materialised precisely as written.

### Current divergence in the tree

| Artifact | State | Required |
|---|---|---|
| `assets/windows/bin/codemie.cmd` | Execs `%~dp0codemie.exe` (the pkg binary) | Exec bundled `node.exe` + CLI entry |
| `assets/bin/node-x86_64-pc-windows-msvc.exe` | **0 bytes** — placeholder | Real Node v22 `node.exe` |
| `assets/codemie-cli/node_modules/` | Present, 468 MB, untracked (`.gitignore:6`) | Pruned, reproducibly generated |
| `tauri.conf.json` `bundle.resources` | Ships `codemie.cmd` + pkg `codemie.exe` | Ship `codemie.cmd` + `node.exe` + CLI tree |
| `pathman.rs:253` candidates | `["codemie.exe", "codemie.cmd", "codemie"]` — **`.exe` probed first** | Drop `codemie.exe` |

Because `codemie.exe` is probed first, the broken pkg binary wins PATH resolution even though a shim is already shipped. That is the direct cause of the reported clean-machine failure.

---

## Part 5 — Correction to the EPMCDME-14573 shim

The EPMCDME-14573 spec §1 shim targets the wrong entry point:

```bat
:: EPMCDME-14573 spec §1 — INCORRECT
"%BUNDLE_DIR%\node\node.exe" "%BUNDLE_DIR%\cli\node_modules\@codemieai\code\dist\index.js" %*
```

`dist/index.js` is a **library barrel** — re-exports only, with no CLI bootstrap and no `program.parse()`. Verified against the staged tree at `assets/codemie-cli/`:

```
$ node node_modules/@codemieai/code/dist/index.js --version    # 14573 spec §1
stdout=[]
exit=0                                                          # <-- silent success

$ node node_modules/@codemieai/code/bin/codemie.js --version    # correct entry
0.14.1
exit=0
```

The wrong entry point **exits 0 while printing nothing**. Any build or install check that gates on exit code alone would pass, and the defect would surface only when a user ran `codemie --version` and saw a blank line. This is the same silent-success class as the `pkg` warning-with-exit-0 defect, and it is why the spec requires asserting non-empty stdout rather than exit status.

The correct entry is the package's declared `bin.codemie`:

```
node_modules/@codemieai/code/bin/codemie.js
```

which runs pending migrations, performs the update check, then dynamically imports `dist/cli/index.js`. It relies on top-level `await`, which works because the real `package.json` (`"type": "module"`) ships with the tree.

---

## Part 6 — Verified: a glob key in `bundle.resources` silently destroys the tree

The first draft of the spec used `"../assets/codemie-cli/node_modules/**/*": "cli/node_modules/"` and flagged the glob semantics as an unverified assumption. Verified 2026-09-03 by running the real resolver — `tauri-utils 2.9.2`, the version pinned in `Cargo.lock`, with `allow_walk = true` to match `tauri-build-2.6.2/src/lib.rs:572` — over the actual staged tree:

| Form | Pattern | Files | Distinct targets | Colliding | Verdict |
|---|---|---|---|---|---|
| A | `…/node_modules/**/*` → `cli/node_modules/` | 19,754 | **9,782** | **3,516** | flattened |
| B | `…/node_modules` → `cli/node_modules` | 19,754 | 19,754 | 0 | correct |

Cause — `tauri-utils/src/resources.rs:196` joins only the file name for glob patterns:

```rust
ResourcePathsInnerIter::Glob { .. } => dest.join(path.file_name().unwrap()),
```

Measured collisions under Form A: `index.js` ← **620 sources**, `index.d.ts` ← 510, `package.json` ← 352, `README.md` ← 238, `LICENSE` ← 205. Every nested path collapses:

```
.../@aws/lambda-invoke-store/dist-cjs/invoke-store.js  ->  cli/node_modules/invoke-store.js
.../@aws/lambda-invoke-store/dist-es/invoke-store.js   ->  cli/node_modules/invoke-store.js
```

Node module resolution would be impossible. **Tauri reports `errors: 0`** — the build succeeds and ships the wreckage.

The plain directory form takes the `Walk` branch (`resources.rs:186-192`), does `dest.join(path.strip_prefix(pattern))`, and preserves structure exactly. Tauri's own test suite documents both behaviours at `resources.rs:503-563`.

Resolution takes ~4.0 s for the full tree, so the previously-proposed zip-and-extract fallback is unnecessary.

**This is the third silent-success defect in this ticket**, alongside pkg's warning-with-exit-0 and `dist/index.js`'s empty-stdout-with-exit-0. All three would pass an exit-code-based gate. The spec's §7a regression test and §6 assertions exist specifically because this failure class is invisible to normal build gating.

---

## Sizing

Measured on the staged tree:

| Item | Size |
|---|---|
| `assets/codemie-cli` total | 468 MB |
| ├─ `@codemieai/codemie-opencode-windows-x64` | 160 MB |
| ├─ `@codemieai/codemie-opencode-windows-x64-baseline` | 159 MB |
| ├─ `@codemieai/code` (dist + bin + src) | 13 MB |
| └─ remainder (`@langchain`, `js-tiktoken`, `openai`, `@aws-sdk`, …) | ~136 MB |

The two `codemie-opencode` platform packages are **319 MB of 468 MB** — the same binary in modern and baseline-CPU variants. Dropping `-baseline` saves 159 MB but removes support for CPUs without modern SIMD. That is a product tradeoff; the spec treats it as a decision point, not a default.

Node v22 `node.exe` adds roughly 80 MB (verify against the pinned version).

---

## Follow-ups (out of scope here)

- **`cli-updater` advises npm on a bundled install.** `dist/utils/cli-updater.js:245` prints `npm install -g @codemieai/code@<v>`, which is unactionable for bundled users. It only *prints* — no npm subprocess — so it degrades harmlessly, but the copy is misleading. Needs a bundled-install branch. `CODEMIE_AUTO_UPDATE=false` does **not** disable the check; it only switches silent-update to prompt (`dist/utils/cli-updater.js:108-113`).
- **Upstream the `__filename` idiom fix.** Regardless of packaging, `const __filename = fileURLToPath(import.meta.url)` in 4 `dist` files is a portability hazard for any CJS-wrapping consumer. Fix in `codemie-code` `src/` and rename to a non-reserved identifier.
- **`pty.rs` still spawns `powershell.exe`** (carried over from EPMCDME-14573 open risks) — not a runtime problem today, but inconsistent with the `cmd.exe` dispatch used elsewhere.
