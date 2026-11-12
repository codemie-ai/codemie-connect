# Update manifest from GitHub releases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** The app reads its update manifest from the latest codemie-connect release; the release workflow generates and uploads that manifest.

**Architecture:** Change the default base URL; a dependency-free Node script builds manifest.json from the draft release's assets; the publish job runs it before un-drafting.

**Tech Stack:** Rust (inline tests), Node ESM + node:test, GitHub Actions.

**Spec:** EPMCDME-16171 requirements (inline); research in `technical-analysis.md` beside this file.

Commit per task using the repository's existing convention (conventional commits, ticket EPMCDME-16171 in body, no Co-Authored-By). Do not touch `.codemie/codemie-cli.config.json`, `.ai-run/guides/project.md`, `AGENTS.md`, codemie-code or package.json.

## Acceptance criteria

- Default manifest URL is `https://github.com/codemie-ai/codemie-connect/releases/latest/download/manifest.json`; `CODEMIE_INSTALLER_BASE_URL` still overrides.
- Published release has `manifest.json` with bare version and a URL per shipped installer; absent platforms omitted.
- App version is 2.1.1 in tauri.conf.json, Cargo.toml, Cargo.lock.

### Task 1: Default base URL

**Files:** Modify `src-tauri/src/commands/app_updater.rs:114-119` (`get_base_url`), tests `:357-535`.

- [ ] Add `const DEFAULT_BASE_URL: &str = "https://github.com/codemie-ai/codemie-connect/releases/latest/download";` and use it in `get_base_url()`'s `unwrap_or_else`; env override unchanged.
- [ ] Update tests: `MANIFEST` fixture (L407) to version 2.1.1 with urls `https://github.com/codemie-ai/codemie-connect/releases/download/v2.1.1/CodeMie-Connect-2.1.1-aarch64.dmg` and `.../CodeMie-Connect-2.1.1-x64-setup.exe`; fix the `ends_with` assertions in `manifest_gives_the_version_and_this_platforms_installer` (L416) and `manifest_is_fetched_over_http` (L441-468, path `/manifest.json`).
- [ ] Rewrite `manifest_is_read_from_one_place_for_every_platform` (L437) to assert `DEFAULT_BASE_URL` equals the new literal and `format!("{}/manifest.json", DEFAULT_BASE_URL)` shape; no env mutation.
- [ ] Run from `src-tauri/`: `cargo test app_updater`, `cargo fmt --check`, `cargo clippy -- -D warnings`.

Test-first: yes — `manifest_is_read_from_one_place_for_every_platform` asserting the new default fails to compile/pass before the constant exists.

### Task 2: Manifest generator script

**Files:** Create `scripts/generate-release-manifest.mjs`, `ui/test/generate-release-manifest.test.mjs` (picked up by `node --test ui/test/*.test.mjs`).

**Interfaces:** Produces `export function buildManifest({ tag, assetNames }) -> { version, platforms }`; version is `tag` minus leading `v`. CLI: `node scripts/generate-release-manifest.mjs <tag> [outFile=manifest.json]` runs `gh release view <tag> --json assets`, writes the file.

- [ ] Write tests first, following `ui/test/shim.test.mjs` style: (a) mac-only assets -> only `darwin-aarch64`; (b) mac + `-setup.exe` -> both, URL `https://github.com/codemie-ai/codemie-connect/releases/download/<tag>/<asset>`; (c) `-windows-amd64.exe` only -> `windows-x86_64`; (d) both Windows patterns -> the `-setup.exe` one; (e) `.sha256` and unrelated assets ignored; (f) CLI run with a fake `gh` shell script in a tmp dir prepended to PATH writes the expected file.
- [ ] Implement with a table `PLATFORMS = { "darwin-aarch64": [v => \`CodeMie-Connect-${v}-aarch64.dmg\`-style matchers], "windows-x86_64": [setup.exe, windows-amd64.exe] }`; first matching pattern in list order wins (one-line comment: deterministic tie-break). Omit platforms with no match. Node builtins only.
- [ ] Mutation check: drop the omit-if-absent branch, then swap Windows pattern order; confirm exactly the covering test fails each time; restore.

Test-first: yes — the test file fails (module missing) before the script exists.

### Task 3: Workflow step

**Files:** Modify `.github/workflows/release-macos.yaml`, job `publish-github-release`, before the `gh release edit "$RELEASE_TAG" --draft=false` step.

- [ ] Confirm the job has `actions/checkout` (pinned SHA); Node is preinstalled on ubuntu-latest, no setup-node needed.
- [ ] Add step "Generate and upload manifest" with `env: GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`, `RELEASE_TAG: ${{ needs.make-draft-release.outputs.tag }}` (mirror the publish step's env), `set -eo pipefail`: `node scripts/generate-release-manifest.mjs "$RELEASE_TAG" manifest.json` then `gh release upload "$RELEASE_TAG" manifest.json --clobber`.
- [ ] Verify YAML parses (`ruby -ryaml -e 'YAML.load_file(...)'` or equivalent).

Test-first: no — covered by Task 2 tests; workflow has no test harness.

### Task 4: Version bump

**Files:** Modify `src-tauri/tauri.conf.json:4`, `src-tauri/Cargo.toml:3`, `src-tauri/Cargo.lock:78-80` (the `name = "app"` entry only), each 2.1.0 -> 2.1.1.

- [ ] Edit the three; run `cargo test` from `src-tauri/` to confirm the lock is consistent (no other lock changes in `git diff`).

Test-first: no — metadata only.

## Negative constraints

Checked: only the default URL changes in Task 1 (env override kept); no env mutation in tests (Task 1); no real codemie, fake `gh` only (Task 2); platforms with no installer omitted (Task 2 a, c); package.json, codemie-code and the three local files untouched (header, Task 4).
