# Quality Gates

Run order is fastest-to-slowest.

## Full runs

| Command | Covers | Source |
|---|---|---|
| `make check` | fmt-check (cargo fmt --check), lint (cargo clippy -D warnings), test (npm test, cargo test); stages the runtime first when it is missing | Makefile::check |
| `CI workflow "CI" (every pull request, pushes to main)` | job `Lint & Tests (macOS)`: cargo fmt --check, cargo clippy -D warnings, npm test, cargo test, tauri build --bundles app dmg --no-sign, DMG checksums and artifact upload; job `Security`: shared secrets detection | .github/workflows/ci.yaml::jobs.test |
| `CI workflow "PR Checks" (pull requests into main)` | PR title lint (shared commit-lint workflow) | .github/workflows/pr-title-lint.yml::pr-title |
| `CI workflow "CodeQL" (pull requests into main, pushes to main, weekly)` | CodeQL over the GitHub Actions workflows | .github/workflows/codeql.yml::jobs.codeql |

---

### format

**Run**: `make fmt-check`
**Pass**: exit 0 with no output
**Fail**: non-zero exit; cargo fmt prints the diff for each unformatted file
**Auto-fix**: make fmt

### lint

**Run**: `make lint`
**Side effects**: In a checkout without the staged runtime: downloads Node from nodejs.org, npm-installs the pinned CLI into assets/codemie-cli/node_modules, writes assets/staging-manifest.json and may rewrite the tracked assets/codemie-cli/package.json and package-lock.json. Compiles into src-tauri/target.
**Pass**: exit 0
**Fail**: non-zero exit with clippy diagnostics (file and line)
**Auto-fix**: make lint-fix (cargo clippy --fix --allow-dirty -- -D warnings; rewrites working-tree files)
**Notes**: Some lints have `cargo clippy --fix` suggestions; others need manual edits.

### test

**Run**: `make test`
**Side effects**: cargo test compiles into src-tauri/target; commands/runner.rs tests run real /bin/zsh -lc commands; workspace tests open SQLite in temp folders; staging download as in lint on first run; contract fixtures under ui/test/fixtures/contract are rewritten only with UPDATE_CONTRACT_FIXTURES=1.
**Pass**: exit 0: node:test reports no failing test and cargo test reports `test result: ok` for each target
**Fail**: non-zero exit; node:test prints the failing test and its assertion, cargo test lists the failed tests
**Skip if**: tests/echo_plugins.rs tests print `skipped:` and pass when the CONNECT_ECHO_PLUGINS_DIR folder is missing; the live_* Claude tests are #[ignore]
**Notes**: Do not skip the JS half for a Rust-only change that alters a response shape: the regenerated contract fixtures under ui/test/fixtures/contract are what the JS tests read. Rust unit tests live inline under #[cfg(test)], in sibling test modules (workspace/meetings/tests.rs, notes_tests.rs) and in src-tauri/tests/.

### build

**Run**: `make build`
**Side effects**: downloads Node and installs the CLI tree (stage), writes assets/staging-manifest.json, builds the app and DMG under src-tauri/target/release/bundle, runs the bundled shim
**Pass**: exit 0 and `Done. All assertions passed.`
**Fail**: exit 1 with `[build] <reason>` naming the failed assertion; exit 2 on an unknown argument
**Skip if**: a logic-only change already verified by tests (saves about 2-5 min)
**Notes**: Staging the runtime (`scripts/stage-runtime.sh`) is a prerequisite of `make build` / `build-installer.sh`, not of cargo commands: CI runs clippy, `cargo test` and `tauri build` without it. `make build-fast` (--skip-stage) reuses the staged tree and still verifies; `make build-app` (`CI=true cargo tauri build`) verifies nothing, for UI-only changes. Windows: `.\build-installer.ps1` writes the git-ignored assets\windows\bin\runtime-key, builds the NSIS installer and asserts the bundle, ending with `Done - all assertions passed.` (exit 1 with `[build] <reason>` on a failed assertion).

### tour

**Run**: `make tour` (optional `ONLY=0,3` or `ONLY=T05,T21` to run only those rollout steps or stop ids)
**Side effects**: builds the debug app with the `tour` feature into `src-tauri/target/tour` (a separate target folder, rebuilt only when sources changed); seeds a fresh test root and runs it in the background, offline and invisible, under `$TMPDIR/connect-tour-<stamp>-*`; writes screenshots and `tour/results.json` there and the self-contained HTML report under `output/tour/<stamp>-<sha>/` (git-ignored)
**Pass**: exit 0; stdout prints `TOUR {"path":…,"pass":true,"failed":[]}`
**Fail**: exit 1 (a check failed, printed with `"pass":false` and the failed checks), 2 (nothing reported within 600 s, the watchdog), or 3 (can't run: a bad `CODEMIE_TOUR` value or one that selects no stop, a reused or stale test folder, `CODEMIE_STATUS_SMOKE`/`CODEMIE_PLUGIN_SMOKE` also set, or another tour already running)
**Notes**: Every tour stop is real-app evidence for Definition of done item 4, from step 7 on; a built feature with no stop shows red in the report's coverage table and fails `npm test` (the tour's coverage test), not the tour itself. A `CODEMIE_TOUR`/`ONLY` value that selects no stop (an unknown stop id, or a step with no stops yet, such as 8 or 9) exits 3 naming it, and a tour that ran no stop fails. Never drives the desktop: the window is hidden, never focused or activated, and the user's own running Connect is untouched. Report path, run folder and verdict print at the end; `make tour ONLY=...` reruns a subset without rebuilding when nothing changed.
