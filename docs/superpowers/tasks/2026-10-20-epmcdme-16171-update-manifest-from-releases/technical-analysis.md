# Technical Research

**Task**: app_updater manifest release-macos workflow version
**Generated**: 2026-10-20
**Research path**: filesystem

---

## 1. Original Context

EPMCDME-16171. The app reads its update manifest from get_base_url() in src-tauri/src/commands/app_updater.rs, default https://github.com/codemie-ai/codemie-code/raw/main/install, overridable with CODEMIE_INSTALLER_BASE_URL. Change only the default to https://github.com/codemie-ai/codemie-connect/releases/latest/download and keep the env override. GitHub serves that path through two redirects and the app's reqwest client already follows them and gets a content-length, so nothing else in the updater needs to change. Update the tests that assert the old URL.

The release is .github/workflows/release-macos.yaml: it makes a draft release, builds, signs, notarizes and uploads CodeMie-Connect-<version>-aarch64.dmg and its .sha256, then a last job publishes. Add a step before publish that reads the draft release's assets with gh, writes manifest.json as {"version": "<version>", "platforms": {...}} with one entry per installer actually in that release (darwin-aarch64 for the aarch64 dmg, windows-x86_64 for a Windows -setup.exe or -windows-amd64.exe if one is there), each url being https://github.com/codemie-ai/codemie-connect/releases/download/<tag>/<asset name>, and uploads it to the release as manifest.json. A platform with no installer in the release must not appear, otherwise that platform is offered the same version again. Another PR is adding Windows to the same release, so keep the step platform-agnostic.

Bump the version to 2.1.1 in src-tauri/tauri.conf.json, src-tauri/Cargo.toml and Cargo.lock; the release workflow refuses a tag that doesn't match tauri.conf.json.

Do not touch codemie-code. Never run a real codemie in tests, use fake commands. Mutation check on the new tests.

Acceptance: a published release contains manifest.json with release version and installer URL of every platform it ships; 2.1.1 finds a newer release through that manifest; a later release needs no change in codemie-code.

Research focus: where the old URL appears (code, tests, docs, scripts, other workflows), how the manifest is parsed (field names, platform keys, version comparison) so the generated manifest.json matches exactly, how the workflow's jobs/permissions/tag/version handling look, how existing tests are structured (Rust inline + JS node:test), and where the version string lives. Leave the three locally-modified files (.codemie/codemie-cli.config.json, .ai-run/guides/project.md, AGENTS.md) alone.

---

## 2. Codebase Findings

### Existing Implementations
- `/Users/mert_efe/codemie-installers/codemie-claude-installer-macos/src-tauri/src/commands/app_updater.rs`
  - L114-119 `get_base_url()`: `std::env::var("CODEMIE_INSTALLER_BASE_URL").unwrap_or_else(|_| "https://github.com/codemie-ai/codemie-code/raw/main/install".to_string())`. This literal is the only non-test occurrence of the old URL.
  - L123-125 `get_manifest_url()` = `format!("{}/manifest.json", get_base_url())`.
  - L127-136 manifest structs (serde Deserialize, no `deny_unknown_fields`): `PlatformEntry { url: String }`, `Manifest { version: String, platforms: HashMap<String, PlatformEntry> }`.
  - L138-146 `platform_key()`: `"windows-x86_64"` on Windows, otherwise `"darwin-aarch64"`.
  - L150-163 `parse_manifest(text, platform)`: parse error -> Err; `is_valid_version` must pass (>=3 dot parts, all digits-only, no `v` prefix, no pre-release suffix); missing platform key -> Err("No installer available for platform"). Returns (version, url).
  - L165-175 `fetch_manifest(client, url)`: plain `client.get(url).send().await?.text()`, no status-code check (a 404 HTML body fails at parse).
  - L177 `APP_VERSION = env!("CARGO_PKG_VERSION")` (from src-tauri/Cargo.toml).
  - L201-215 `is_newer_version(current, new)`: numeric part-wise compare.
  - L218 `check_for_update`: 24h throttle, errors swallowed (logged, returns Ok(None)). L261 `download_and_install`: fetches manifest, takes filename from last URL path segment (strips `?`), requires `response.content_length()`, saves to temp dir, `launch_installer`.
  - Generated manifest.json must therefore be: `{"version":"X.Y.Z","platforms":{"darwin-aarch64":{"url":"..."},"windows-x86_64":{"url":"..."}}}`. Extra fields are tolerated; version must be bare X.Y.Z (no `v`).

### Architecture and Layers Affected
- Rust backend (Tauri command module `app_updater.rs`): one constant string.
- CI/release layer: `.github/workflows/release-macos.yaml`.
- Version metadata: three files (see below). Frontend is not involved in URL (ui/renderer.js and ui/runner-bridge.js only invoke `check_for_update`/`download_and_install`/`get_app_version`).

### Integration Points
- Release workflow (`release-macos.yaml`, 270 lines), jobs:
  - `make-draft-release` (ubuntu-latest): validates tag/version, `gh release create "$TAG" --draft`, outputs `tag`, `version`, `commit_sha`. Tag trigger `v*` (must equal `v` + tauri.conf.json version, else error L88-92) or `workflow_dispatch` (main only; version from input or tauri.conf.json; `TAG="v${VERSION}"`). Version is validated against strict X.Y.Z regex, so `needs.make-draft-release.outputs.version` is the bare version suitable for the manifest.
  - `build-macos` (macos-15, `environment: release`): stamps version into tauri.conf.json and Cargo.toml (sed; not Cargo.lock), runs `npm test` and `cargo test`, `tauri build --bundles dmg`, renames files replacing spaces/underscores with hyphens (so asset is `CodeMie-Connect-<version>-aarch64.dmg`), notarizes, writes `*.dmg.sha256`, `gh release upload "$RELEASE_TAG" *.dmg *.sha256 --clobber`.
  - `publish-github-release` (ubuntu-latest, needs make-draft-release + build-macos): checkout, then `gh release edit "$RELEASE_TAG" --draft=false` with `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`, `RELEASE_TAG` env. New manifest step goes in this job before the publish step (needs `contents: write`, already set at workflow level).
  - Workflow-level: `permissions: contents: write`; concurrency group `release-macos-${{ inputs.tag || github.ref_name }}`; actions pinned by full SHA (checkout `de0fac2e...` v6.0.2). `jq` and `gh` are available on ubuntu-latest; `gh` and `jq` are also present locally (/opt/homebrew/bin/gh, /usr/bin/jq).
  - Draft-release asset listing by `gh release view "$TAG" --json assets` works for drafts when authenticated with GITHUB_TOKEN. Note: `latest/download` only resolves for published, non-draft, non-prerelease releases; the manifest is uploaded before the `--draft=false` edit.
- Another PR adds Windows to the same workflow (not present in this checkout); the only workflow in repo besides release-macos is `ci.yaml` (no URL or manifest references).

### Patterns and Conventions
- Workflow shell steps use `set -eo pipefail`, `env:` blocks for `GH_TOKEN`/`RELEASE_TAG`, `jq` for JSON.
- Rust tests are inline `#[cfg(test)] mod tests` in the same file.

---

## 3. Documentation Findings

### Guides and Architecture Docs
- `.ai-run/guides/` exists (architecture, development, testing, standards, project.md, quality-gates.md). Quality gates: `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test`, `npm test`, build (mirrored in `.github/workflows/ci.yaml`). Rust commands run from `src-tauri/` (or `--manifest-path`).
- No README/docs reference the old URL or `CODEMIE_INSTALLER_BASE_URL` (grep of README.md, docs/windows-build.md, scripts, build-installer.sh, ci.yaml: no hits). Only historical task docs under `docs/superpowers/` and `.ai-run/specs/` mention `app_updater`/manifest; they are records, not updated.

### Architectural Decisions
- Commit style (from project conventions): conventional commits `fix(scope): subject`, ticket in body; CI validates commit messages and PR title (commitlint in ci.yaml).

### Derived Conventions
- Branch `feat/EPMCDME-16171-update-manifest-from-releases` (current).

---

## 4. Testing Landscape

### Existing Coverage
- Rust, inline in `app_updater.rs` L357-535:
  - L407-413 `const MANIFEST` fixture with version `2.1.1` and old-URL urls (`.../codemie-code/raw/main/install/macos/CodeMie%20Connect_2.1.1_aarch64.dmg` and `.../windows/CodeMie%20Connect_2.1.1_x64-setup.exe`). Contains the old URL host/path and `%20` filenames.
  - L416 `manifest_gives_the_version_and_this_platforms_installer`: asserts `url.ends_with("/macos/CodeMie%20Connect_2.1.1_aarch64.dmg")` and `/windows/...x64-setup.exe` (depend on the fixture layout).
  - L425 missing platform -> Err; L430 bad version / HTML page refused.
  - L437-439 `manifest_is_read_from_one_place_for_every_platform`: `assert!(get_manifest_url().ends_with("/install/manifest.json"))`. This is the test that asserts the old URL path and will fail when the default changes. It reads the real env var, so it also depends on `CODEMIE_INSTALLER_BASE_URL` being unset.
  - L441-468 `manifest_is_fetched_over_http`: local TcpListener server, url `http://{addr}/install/manifest.json`, asserts installer URL ends with `CodeMie%20Connect_2.1.1_{x64-setup.exe|aarch64.dmg}`.
  - L470+ macOS-only tests for platform key, app bundle detection, DMG replace (uses real `hdiutil`).
  - No test of `get_base_url()` env override, and no test of `check_for_update`/`is_newer_version` against 2.1.1 vs the app version via manifest.
- JS: `npm test` = `node --test ui/test/*.test.mjs`. `ui/test/app-updater-utils.test.mjs` tests only `shouldCheckForAppUpdate` from `ui/app-updater-utils.mjs`; `ui/test/version-utils.test.mjs` exists. No JS test references the manifest URL. No tests exist for the workflow.

### Testing Framework and Patterns
- Rust: built-in `#[test]` and `#[tokio::test]`, `tempfile` dev-dependency; local TCP listener fakes for HTTP; macOS tests use real system tools (hdiutil, ditto). Integration test dir `src-tauri/tests/` has only `bundle_resources.rs`.
- JS: `node:test` + `node:assert/strict`, ESM `.mjs`, fixtures in `ui/test/fixtures`, helper tools in `ui/test/tools`. Other tests use fake CLIs / fixtures (project rule: never run a real `codemie`).

### Coverage Gaps
- The manifest-generation step has no test harness; no existing tests for shell/workflow logic (a JS node:test that runs the step's script against a fake `gh` on PATH would be a new pattern; unverified whether the project already does that, though `ui/test/shim.test.mjs` runs shim scripts).
- No test for the env override in `get_base_url()` (process-global env mutation in Rust tests is racy across parallel tests).

---

## 5. Configuration and Environment

### Environment Variables
- `CODEMIE_INSTALLER_BASE_URL` (app_updater.rs L116): optional override of the base URL; manifest is read from `<base>/manifest.json`. Only referenced in that file.
- Workflow: `GH_TOKEN` (secrets.GITHUB_TOKEN), `RELEASE_TAG`, `NEW_VERSION`, `RELEASE_TAG_INPUT`.

### Configuration Files
- Version strings (current value `2.1.0` in all):
  - `/Users/mert_efe/codemie-installers/codemie-claude-installer-macos/src-tauri/tauri.conf.json` L4 `"version": "2.1.0"`
  - `/Users/mert_efe/codemie-installers/codemie-claude-installer-macos/src-tauri/Cargo.toml` L3 `version = "2.1.0"` (package name `app`)
  - `/Users/mert_efe/codemie-installers/codemie-claude-installer-macos/src-tauri/Cargo.lock` L78-80 `name = "app"` / `version = "2.1.0"`
  - Also `/Users/mert_efe/codemie-installers/codemie-claude-installer-macos/package.json` L3 `"version": "2.1.0"` (not named by the task; the workflow's Stamp version step does not touch it either).
- `src-tauri/tauri.conf.json` is the version the release workflow compares tags against.

### Feature Flags and Deployment Concerns
- Release environment `release` holds Apple signing secrets (build job only). Publish job uses only GITHUB_TOKEN.
- Asset naming: DMG is renamed to hyphenated form in CI, so URL-encoding is not needed for `CodeMie-Connect-<version>-aarch64.dmg`; the old fixture's `%20` names differ from what the new release uploads.

---

## 6. Risk Indicators

- `manifest_is_read_from_one_place_for_every_platform` asserts `/install/manifest.json` and will break on the URL change; it also reads the live env var (fails if `CODEMIE_INSTALLER_BASE_URL` is set in the shell).
- `MANIFEST` fixture and two tests that assert old-URL layout (`/macos/...`, `/windows/...`) are coupled to the old URL; fixture contents only need the new release-asset shape if the tests are to describe real manifests.
- `fetch_manifest` does not check HTTP status; a 404 body fails at JSON parse and is swallowed by `check_for_update` (update silently never offered). A release without manifest.json (e.g. all releases published before this change) yields no update, which is acceptable but silent.
- `latest/download` resolves only for the latest non-draft, non-prerelease release; ordering of upload (manifest before `--draft=false`) matters.
- Version bump touches Cargo.lock; the build job's sed stamps only tauri.conf.json and Cargo.toml, so Cargo.lock can drift from them on workflow_dispatch builds.
- `package.json` also carries 2.1.0 and is not in the task's bump list.
- Speculative: manifest step must glob asset names (`*-aarch64.dmg`, `*-setup.exe`, `*-windows-amd64.exe`) and omit absent platforms; if both Windows patterns exist the choice is ambiguous. Speculative: a stale or partial `--clobber` upload could leave an old manifest.json on the draft; the step should upload with `--clobber`.
- Speculative: testing the workflow step requires extracting the script (or a script file under `scripts/`) so a node:test or shell test can run it against a fake `gh` and mutate it; the current inline-YAML pattern is not directly testable.
- Local modifications to `.codemie/codemie-cli.config.json`, `.ai-run/guides/project.md`, `AGENTS.md` must be left alone (unrelated working-tree changes).

---

## 7. Summary for Complexity Assessment

The change touches three layers with a small surface: one string literal in `src-tauri/src/commands/app_updater.rs`, one new step in the publish job of `.github/workflows/release-macos.yaml`, and the version string in three files (tauri.conf.json, Cargo.toml, Cargo.lock; package.json also holds 2.1.0). The manifest schema is simple and fully determined by the Rust deserializer: `version` (bare X.Y.Z) and `platforms.<key>.url` with keys `darwin-aarch64` and `windows-x86_64`; extra fields are ignored and a missing platform simply means no update, which matches the requirement to omit absent platforms.

Technical novelty is low in Rust but moderate for CI: the workflow has no existing step that lists release assets or generates JSON, and there is no test pattern for workflow shell logic, so the "tests with mutation check" requirement for the manifest step needs the script to be runnable outside YAML against a fake `gh`. Rust tests already cover manifest parsing and an HTTP fetch with a local server; one test asserts the old `/install/manifest.json` path and the `MANIFEST` fixture uses old-URL shapes.

Test posture is good for the updater (inline Rust tests, node:test for JS) and absent for the workflow. Key risks: the env-var-dependent URL test, silent failure on a missing manifest (no HTTP status check), draft-vs-published semantics of `latest/download`, and the coordination with the parallel Windows PR on the same workflow file (merge conflict surface in the publish job).

---

## 8. External References

None named by the task
