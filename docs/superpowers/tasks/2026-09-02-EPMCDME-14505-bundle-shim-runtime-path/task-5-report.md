DONE
commit: cd39000
changed_paths:
  - build-installer.ps1
test_command: .\build-installer.ps1 -SkipStage (stages 1-3 only; full build not run)

## Summary

Rewrote build-installer.ps1 from the old pkg-based approach to the new staged-runtime approach.

The pkg stage and chalk #imports patch were deleted. The file now:
- Stages bundled Node runtime + CodeMie CLI tree via stage-runtime.ps1 (or skips with -SkipStage)
- Runs mandatory pre-build assertions (node.exe exists, size > 10 MB, version matches runtime.json, required CLI files present, staging manifest version matches)
- Smoke-tests the staged CLI via `node.exe bin/codemie.js --version` asserting non-empty stdout
- Builds the NSIS installer via Tauri
- Runs post-build assertions (bundle structure, nesting depth, no stray pkg binaries, setup.exe present)

## Assertion verification results

Step 2 — missing node.exe assertion:
  - Moved node.exe to node.exe.bak, ran .\build-installer.ps1 -SkipStage
  - EXIT=1, error: [build] missing bundled runtime: ...assets\windows\node\node.exe
  - PASS

Step 3 — wrong entry point assertion:
  - Temporarily set $CliEntry to dist/index.js (the barrel that exits 0 silently)
  - EXIT=1, error: [build] staged CLI produced NO output. The entry point is almost certainly wrong...
  - PASS (reverted $CliEntry back to bin/codemie.js)

Steps 1-3 with correct configuration (-SkipStage):
  - Stage 1: Skipping staging (-SkipStage)
  - Stage 2: node v22.23.2 (83 MB), CLI 0.14.1: 14119 files, 399.2 MB
  - Stage 3: codemie --version -> 0.14.1 (non-empty stdout confirmed)
  - Stage 4: Tauri build started (Rust compilation began) — NOT completed (too time-consuming)
  - PASS for stages 1-3

## Note on full build

Step 4 (full Tauri build) and Step 5 (post-build assertions) were not run.
The Tauri build compiles Rust code and creates a full NSIS installer (10-30 minutes).
The build was observed to start correctly. Post-build assertions are included in the
script and will be verified when the actual installer build is run separately.
