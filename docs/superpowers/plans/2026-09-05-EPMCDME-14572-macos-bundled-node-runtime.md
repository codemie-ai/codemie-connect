# macOS Bundled Node Runtime, Shim and PATH Registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `codemie --version` and `codemie install [agent]` work on a clean Apple Silicon Mac with no system Node.js, npm or CodeMie, by shipping a pinned Node runtime, the CLI tree and a shell shim inside `CodeMie Connect.app` and registering the shim directory on the user's PATH at first launch.

**Architecture:** The macOS twin of EPMCDME-14505. A bash staging script produces `assets/macos/node/bin/node` and `assets/codemie-cli/node_modules`; `tauri.macos.conf.json` ships them plus the shim as bundle resources under `Contents/Resources`; the existing `inject_bundled_bin_path` probe finds `Resources/bin/codemie`, prepends it to the process PATH and, on macOS, appends it to `~/.zprofile`; `self_update_direct` becomes cross-platform; `build-installer.sh` asserts every artifact before and after `cargo tauri build`.

**Tech Stack:** bash 3.2 (macOS default `/bin/bash`), Rust / Tauri 2.11.2, `node:test`, Node.js 22.23.2 darwin-arm64 (bundled runtime), `@codemieai/code@0.14.1`.

**Spec:** `.ai-run/specs/2026-09-05-EPMCDME-14572-macos-bundled-node-runtime.md`
**Windows reference:** `scripts/stage-runtime.ps1`, `build-installer.ps1`, `assets/windows/bin/codemie.cmd`, `src-tauri/tauri.windows.conf.json`

## Global Constraints

- **Apple Silicon only.** Node tarball `node-v22.23.2-darwin-arm64.tar.gz`, SHA-256 `61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6`.
- **Node version `22.23.2`, CLI `@codemieai/code@0.14.1`**, both read from `runtime.json`; never hard-code them in scripts.
- **Do not change Windows behaviour.** `build-installer.ps1`, `scripts/stage-runtime.ps1`, `assets/windows/`, `tauri.windows.conf.json` and `installer-hooks.nsi` are not touched.
- **Only `bin/node` ships.** No npm, no `lib/`, no `include/`.
- **Entry point is `bin/codemie.js`**, never `dist/index.js` (a barrel that exits 0 printing nothing).
- **Plain directory keys in `bundle.resources`**, never a glob (tauri-utils flattens globs, `tests/bundle_resources.rs`).
- **No switch on any script skips or downgrades an assertion.** Every failure names the offending path or command.
- **Shell scripts**: `#!/usr/bin/env bash`, `set -euo pipefail`, must run on the stock macOS bash 3.2 (no associative arrays, no `mapfile`).
- **Rust**: `cargo fmt --check`, `cargo clippy -- -D warnings`, `cargo test` from `src-tauri/`; JS: `npm test` from the repo root. Zero npm dependencies in `package.json` stays true.
- **Commits**: Conventional Commits, type only (`feat:`, `fix:`, `test:`, `docs:`, `chore:`), per `.ai-run/guides/standards/git-workflow.md`.
- **Working tree**: the branch is `feat/epmcdme-14572-macos-bundled-runtime`, branched from `06014c8` on `EPMCDME-14505-codemie-desktop-peruser-install`. `CARGO_TARGET_DIR` may point at another checkout's `target/`; every script honours it.

---

## File Structure

| File | Responsibility |
|---|---|
| `runtime.json` (modify) | adds `nodeMacosArm64Sha256` |
| `.gitignore` (modify) | ignores `assets/macos/node/` |
| `assets/macos/bin/codemie` (create, mode 100755) | shell shim, one `..` hop to `Contents/Resources` |
| `scripts/stage-runtime.sh` (create, 100755) | sole producer of the macOS artifacts, mirrors `stage-runtime.ps1` |
| `src-tauri/tauri.macos.conf.json` (create) | macOS resource overlay, twin of the Windows one |
| `src-tauri/src/commands/pathman.rs` (modify) | `should_persist_bundle_dir`, macOS persist in `inject_bundled_bin_path`, sidecar probe removed |
| `src-tauri/src/state.rs` (modify) | `node_exe_path` / `cli_entry_path` on both platforms |
| `src-tauri/src/lib.rs` (modify) | computes both paths on both platforms |
| `src-tauri/src/commands/runner.rs` (modify) | `self_update_direct` cross-platform, unix test |
| `ui/test/shim.test.mjs` (modify) | source assertions for shim, `runtime.json`, overlay, `lib.rs` |
| `build-installer.sh` (create, 100755) | five-phase build with non-negotiable assertions, mirrors `build-installer.ps1` |
| `.ai-run/guides/quality-gates.md`, `README.md` (modify) | staging prerequisite and the macOS build command |

---

### Task 1: Pinned checksum, shim and their source tests

**Files:**
- Modify: `runtime.json`
- Modify: `.gitignore`
- Create: `assets/macos/bin/codemie`
- Test: `ui/test/shim.test.mjs`

**Interfaces:**
- Produces: `runtime.json.nodeMacosArm64Sha256` (64 hex chars) read by Task 2; the shim path `assets/macos/bin/codemie` shipped by Task 3 as `bin/codemie`.

- [ ] **Step 1: Write the failing tests**

Append to `ui/test/shim.test.mjs`:

```js
// ---- macOS ----------------------------------------------------------------

const MAC_SHIM = 'assets/macos/bin/codemie';
const macShim = readFileSync(MAC_SHIM, 'utf8');

test('macOS shim resolves Contents/Resources with one hop, never two', () => {
  assert.match(macShim, /\$\(dirname "\$0"\)\/\.\."/, 'must resolve $(dirname "$0")/.. (bin -> Resources)');
  assert.doesNotMatch(macShim, /\.\.\/\.\./, '../.. lands on Contents/, not Resources/');
  assert.doesNotMatch(macShim, /CodeMie Connect/, 'must not hardcode the product name');
});

test('macOS shim execs the bundled node runtime', () => {
  assert.match(macShim, /exec "\$RES\/node\/bin\/node"/, 'must exec node/bin/node so exit code and signals pass through');
});

test('macOS shim targets bin/codemie.js, never dist/index.js', () => {
  assert.match(macShim, /bin\/codemie\.js/, 'must target the package bin entry');
  assert.doesNotMatch(macShim, /dist\/index\.js/, 'dist/index.js is a barrel with no CLI bootstrap');
});

test('macOS shim names the missing artifact before exiting 1', () => {
  assert.match(macShim, /\[ ! -x "\$RES\/node\/bin\/node" \]/, 'node guard');
  assert.match(macShim, /\[ ! -f "\$RES\/cli\/node_modules\/@codemieai\/code\/bin\/codemie\.js" \]/, 'entry guard');
});

test('runtime.json pins the darwin-arm64 Node checksum', () => {
  const rt = JSON.parse(readFileSync('runtime.json', 'utf8'));
  assert.match(rt.nodeMacosArm64Sha256 ?? '', /^[0-9a-f]{64}$/, 'nodeMacosArm64Sha256 must be a 64-hex SHA-256');
  assert.equal(rt.nodeVersion, '22.23.2');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test ui/test/shim.test.mjs`
Expected: the suite aborts with `ENOENT ... assets/macos/bin/codemie` (the file does not exist yet).

- [ ] **Step 3: Add the checksum and the ignore rule**

`runtime.json`:

```json
{
  "nodeVersion": "22.23.2",
  "nodeWin64Sha256": "1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97",
  "nodeMacosArm64Sha256": "61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6",
  "cliPackage": "@codemieai/code",
  "cliVersion": "0.14.1"
}
```

Append to `.gitignore` after `assets/windows/node/`:

```
assets/macos/node/
```

- [ ] **Step 4: Write the shim**

Create `assets/macos/bin/codemie`:

```sh
#!/bin/sh
# CodeMie CLI shim. Runs the bundled Node runtime against the bundled CLI tree.
# $(dirname "$0")/.. is Contents/Resources, so this file is correct wherever the
# app is installed and needs no update if productName changes.
RES="$(cd "$(dirname "$0")/.." && pwd)"
if [ ! -x "$RES/node/bin/node" ]; then
  echo "error: bundled node runtime not found: $RES/node/bin/node" 1>&2
  exit 1
fi
if [ ! -f "$RES/cli/node_modules/@codemieai/code/bin/codemie.js" ]; then
  echo "error: bundled CLI entry not found: $RES/cli/node_modules/@codemieai/code/bin/codemie.js" 1>&2
  exit 1
fi
exec "$RES/node/bin/node" "$RES/cli/node_modules/@codemieai/code/bin/codemie.js" "$@"
```

Then: `chmod 755 assets/macos/bin/codemie`

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: all pass, 5 more tests than before.

- [ ] **Step 6: Prove the shim's path logic with a fake layout**

```bash
T=$(mktemp -d); mkdir -p "$T/App.app/Contents/Resources/bin" "$T/App.app/Contents/Resources/node/bin" "$T/App.app/Contents/Resources/cli/node_modules/@codemieai/code/bin"
cp assets/macos/bin/codemie "$T/App.app/Contents/Resources/bin/codemie"
printf '#!/bin/sh\necho "node called with: $*"\n' > "$T/App.app/Contents/Resources/node/bin/node"; chmod +x "$T/App.app/Contents/Resources/node/bin/node"
: > "$T/App.app/Contents/Resources/cli/node_modules/@codemieai/code/bin/codemie.js"
PATH="$T/App.app/Contents/Resources/bin:$PATH" codemie --version
rm "$T/App.app/Contents/Resources/node/bin/node"; PATH="$T/App.app/Contents/Resources/bin:$PATH" codemie --version; echo "exit=$?"
rm -rf "$T"
```

Expected: first call prints `node called with: <...>/Contents/Resources/cli/node_modules/@codemieai/code/bin/codemie.js --version`; second prints `error: bundled node runtime not found: ...` and `exit=1`.

- [ ] **Step 7: Commit**

```bash
git add runtime.json .gitignore assets/macos/bin/codemie ui/test/shim.test.mjs
git commit -m "feat: EPMCDME-14572 — macOS shim, darwin-arm64 Node checksum, shim source tests"
```

Verify the mode: `git ls-files -s assets/macos/bin/codemie` must print `100755`.

---

### Task 2: Staging script

**Files:**
- Create: `scripts/stage-runtime.sh`

**Interfaces:**
- Consumes: `runtime.json` keys `nodeVersion`, `nodeMacosArm64Sha256`, `cliPackage`, `cliVersion`.
- Produces: `assets/macos/node/bin/node` (mode 755), `assets/codemie-cli/node_modules/`, `assets/staging-manifest.json` with `nodeVersion`, `cliPackage`, `cliVersion`, `platform`, `fileCount`, `byteSize`. Task 3 and Task 6 depend on all three.

- [ ] **Step 1: Write the script**

Create `scripts/stage-runtime.sh`:

```bash
#!/usr/bin/env bash
# Sole producer of the bundled macOS runtime artifacts. Idempotent.
# Usage: scripts/stage-runtime.sh [--force]
#   --force   Re-download Node and reinstall the CLI tree from scratch.
# Mirrors scripts/stage-runtime.ps1 (Windows). Apple Silicon only.
set -euo pipefail

FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    *) echo "[stage-runtime] unknown argument: $arg" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CFG="$ROOT/runtime.json"
NODE_DIR="$ROOT/assets/macos/node"
NODE_BIN="$NODE_DIR/bin/node"
CLI_DIR="$ROOT/assets/codemie-cli"
CLI_MODULES="$CLI_DIR/node_modules"
MANIFEST="$ROOT/assets/staging-manifest.json"

fail() { echo "[stage-runtime] $*" >&2; exit 1; }
say()  { printf '\033[36m==> %s\033[0m\n' "$*"; }

# runtime.json is read with whatever node the developer machine has; the
# product never needs a system node.
command -v node >/dev/null 2>&1 || fail "a system node is required to run this script (only for reading runtime.json and running npm)"
cfg() { node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))[process.argv[2]] ?? ''))" "$CFG" "$1"; }

NODE_VERSION="$(cfg nodeVersion)"
NODE_SHA="$(cfg nodeMacosArm64Sha256)"
CLI_PACKAGE="$(cfg cliPackage)"
CLI_VERSION="$(cfg cliVersion)"
[ -n "$NODE_VERSION" ] || fail "runtime.json: nodeVersion missing"
[ -n "$NODE_SHA" ]     || fail "runtime.json: nodeMacosArm64Sha256 missing"
[ -n "$CLI_PACKAGE" ]  || fail "runtime.json: cliPackage missing"
[ -n "$CLI_VERSION" ]  || fail "runtime.json: cliVersion missing"

# ── 1. Node runtime ─────────────────────────────────────────────────────────
if [ "$FORCE" = 1 ] && [ -d "$NODE_DIR" ]; then rm -rf "$NODE_DIR"; fi

if [ ! -x "$NODE_BIN" ]; then
  say "Fetching Node v$NODE_VERSION (darwin-arm64)..."
  TARBALL="node-v$NODE_VERSION-darwin-arm64.tar.gz"
  URL="https://nodejs.org/dist/v$NODE_VERSION/$TARBALL"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  curl -fsSL -o "$TMP/$TARBALL" "$URL"
  ACTUAL="$(shasum -a 256 "$TMP/$TARBALL" | awk '{print $1}')"
  if [ "$ACTUAL" != "$NODE_SHA" ]; then
    fail "Node tarball checksum mismatch for $TARBALL
  expected: $NODE_SHA
  actual:   $ACTUAL"
  fi
  echo "    checksum OK"
  # Only the binary ships; npm, headers and docs stay out (spec §2).
  tar -xzf "$TMP/$TARBALL" -C "$TMP" "node-v$NODE_VERSION-darwin-arm64/bin/node"
  mkdir -p "$NODE_DIR/bin"
  cp "$TMP/node-v$NODE_VERSION-darwin-arm64/bin/node" "$NODE_BIN"
  chmod 755 "$NODE_BIN"
  echo "    node staged at $NODE_BIN"
else
  say "node already staged at $NODE_BIN (use --force to refresh)"
fi

# ── 2. CLI tree ─────────────────────────────────────────────────────────────
WANT="$CLI_PACKAGE@$CLI_VERSION"
CLI_PKG_JSON="$CLI_MODULES/$CLI_PACKAGE/package.json"
INSTALLED=""
if [ -f "$CLI_PKG_JSON" ]; then
  INSTALLED="$(node -e "process.stdout.write(require(process.argv[1]).version)" "$CLI_PKG_JSON")"
fi

if [ "$FORCE" = 1 ] || [ "$INSTALLED" != "$CLI_VERSION" ]; then
  say "Installing $WANT (production deps only)..."
  if [ "$FORCE" = 1 ] && [ -d "$CLI_MODULES" ]; then rm -rf "$CLI_MODULES"; fi
  mkdir -p "$CLI_DIR"
  # Minimal manifest so npm resolves exactly the pinned CLI and nothing else.
  printf '{\n  "name": "codemie-cli-bundle",\n  "version": "0.0.0",\n  "private": true,\n  "dependencies": {\n    "%s": "%s"\n  }\n}\n' "$CLI_PACKAGE" "$CLI_VERSION" > "$CLI_DIR/package.json"
  # --omit=dev drops node-pty and typescript. Postinstall scripts MUST run:
  # keytar and codemie-opencode need them.
  (cd "$CLI_DIR" && npm install --omit=dev)
else
  say "CLI tree already at $WANT (use --force to refresh)"
fi

# ── 3. Prune ────────────────────────────────────────────────────────────────
say "Pruning..."
BEFORE="$(find "$CLI_MODULES" -type f | wc -l | tr -d ' ')"
find "$CLI_MODULES" -type f -name '*.map' -delete
for d in test tests __tests__ example examples docs; do
  find "$CLI_MODULES" -type d -name "$d" -prune -exec rm -rf {} + 2>/dev/null || true
done
for p in node-pty typescript @rollup @esbuild; do
  [ -e "$CLI_MODULES/$p" ] && rm -rf "$CLI_MODULES/$p"
done
AFTER="$(find "$CLI_MODULES" -type f | wc -l | tr -d ' ')"
echo "    files: $BEFORE -> $AFTER"

# ── 4. Verify (spec §2 step 4, not negotiable) ──────────────────────────────
say "Verifying staged artifacts..."
[ -x "$NODE_BIN" ] || fail "missing or not executable: $NODE_BIN"
NODE_SIZE="$(stat -f %z "$NODE_BIN")"
[ "$NODE_SIZE" -gt 10485760 ] || fail "node is only $NODE_SIZE bytes, expected > 10 MB (0-byte placeholder?)"
REPORTED="$("$NODE_BIN" --version 2>&1)" || fail "node --version failed: $REPORTED"
[ "$REPORTED" = "v$NODE_VERSION" ] || fail "node reports $REPORTED, expected v$NODE_VERSION"

for r in \
  "$CLI_PACKAGE/bin/codemie.js" \
  "$CLI_PACKAGE/dist/cli/index.js" \
  "$CLI_PACKAGE/package.json" \
  "keytar/build/Release/keytar.node"; do
  p="$CLI_MODULES/$r"
  [ -f "$p" ] || fail "missing required bundled file: $p"
  [ -s "$p" ] || fail "required bundled file is empty: $p"
done

ACTUAL_CLI="$(node -e "process.stdout.write(require(process.argv[1]).version)" "$CLI_PKG_JSON")"
[ "$ACTUAL_CLI" = "$CLI_VERSION" ] || fail "staged CLI is $ACTUAL_CLI but runtime.json pins $CLI_VERSION"

DANGLING="$(find "$CLI_MODULES" -type l ! -exec test -e {} \; -print | head -1)"
[ -z "$DANGLING" ] || fail "dangling symlink in the CLI tree (the bundler copies symlink targets): $DANGLING"

# ── 5. Manifest ─────────────────────────────────────────────────────────────
FILE_COUNT="$(find "$CLI_MODULES" -type f | wc -l | tr -d ' ')"
BYTE_SIZE="$(find "$CLI_MODULES" -type f -exec stat -f %z {} + | awk '{s+=$1} END {print s+0}')"
printf '{\n  "nodeVersion": "%s",\n  "cliPackage": "%s",\n  "cliVersion": "%s",\n  "platform": "darwin-arm64",\n  "fileCount": %s,\n  "byteSize": %s\n}\n' \
  "$NODE_VERSION" "$CLI_PACKAGE" "$CLI_VERSION" "$FILE_COUNT" "$BYTE_SIZE" > "$MANIFEST"
printf '\033[32m==> Staging OK: %s files, %s MB\033[0m\n' "$FILE_COUNT" "$(( BYTE_SIZE / 1048576 ))"
```

Then: `chmod 755 scripts/stage-runtime.sh`

- [ ] **Step 2: Run it and check the artifacts**

Run: `scripts/stage-runtime.sh`
Expected: `checksum OK`, `node staged`, npm install output, `Staging OK: <n> files, <m> MB` (about 270 MB).

Then:

```bash
ls -la assets/macos/node/bin/node && assets/macos/node/bin/node --version
cat assets/staging-manifest.json
assets/macos/node/bin/node assets/codemie-cli/node_modules/@codemieai/code/bin/codemie.js --version
git status --short
```

Expected: node is 755 and > 100 MB and prints `v22.23.2`; manifest has `"platform": "darwin-arm64"` and `cliVersion 0.14.1`; the smoke prints `0.14.1`; `git status` shows only `scripts/stage-runtime.sh` (node dir, tree and manifest are ignored; `assets/codemie-cli/package.json` must be unchanged from `06014c8`, i.e. still `^0.14.1`? No: the script rewrites it to the pinned form, so it shows modified. That matches what the Windows script does; commit it in the pinned form, which also closes Marian's "Found, not fixed" note in MR !18).

- [ ] **Step 3: Run it a second time to prove idempotence**

Run: `scripts/stage-runtime.sh`
Expected: `node already staged`, `CLI tree already at @codemieai/code@0.14.1`, pruning reports the same file count, `Staging OK`.

- [ ] **Step 4: Prove the checksum gate**

```bash
sed -i.bak 's/"nodeMacosArm64Sha256": "6/"nodeMacosArm64Sha256": "0/' runtime.json && scripts/stage-runtime.sh --force; echo "exit=$?"; mv runtime.json.bak runtime.json
```

Expected: `Node tarball checksum mismatch ... expected: 0... actual: 6...` and `exit=1`, no `assets/macos/node/bin/node` written. Then run `scripts/stage-runtime.sh` once more without `--force` to restore the staged node.

- [ ] **Step 5: Commit**

```bash
git add scripts/stage-runtime.sh assets/codemie-cli/package.json
git commit -m "feat: EPMCDME-14572 — macOS staging script (pinned Node, CLI tree, prune, verify, manifest)"
```

---

### Task 3: macOS resource overlay

**Files:**
- Create: `src-tauri/tauri.macos.conf.json`
- Test: `ui/test/shim.test.mjs`, `src-tauri/tests/bundle_resources.rs` (existing, already overlay-aware)

**Interfaces:**
- Consumes: staged artifacts from Task 2, the shim from Task 1.
- Produces: `Contents/Resources/{bin/codemie, node/bin/node, cli/node_modules}` inside the built app, relied on by Tasks 4, 5, 6.

- [ ] **Step 1: Write the failing test**

Append to `ui/test/shim.test.mjs`:

```js
test('tauri.macos.conf.json ships shim, node and the CLI tree with plain directory keys', () => {
  const conf = JSON.parse(readFileSync('src-tauri/tauri.macos.conf.json', 'utf8'));
  const res = conf.bundle.resources;
  assert.equal(res['../assets/macos/bin/codemie'], 'bin/codemie');
  assert.equal(res['../assets/macos/node/bin/node'], 'node/bin/node');
  assert.equal(res['../assets/codemie-cli/node_modules'], 'cli/node_modules');
  for (const [src, dst] of Object.entries(res)) {
    assert.doesNotMatch(src + dst, /\*/, `glob keys flatten the tree (spec §4): ${src} -> ${dst}`);
    assert.doesNotMatch(dst, /\.exe$/, 'no pkg binary in the macOS bundle');
  }
});

test('the shared tauri.conf.json declares no resources; each platform has its overlay', () => {
  const conf = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
  assert.equal(conf.bundle.resources, undefined, 'a shared resource forces the other platform to stage it before cargo builds');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test ui/test/shim.test.mjs`
Expected: FAIL with `ENOENT ... src-tauri/tauri.macos.conf.json`.

- [ ] **Step 3: Create the overlay**

`src-tauri/tauri.macos.conf.json`:

```json
{
  "bundle": {
    "resources": {
      "../assets/macos/bin/codemie": "bin/codemie",
      "../assets/macos/node/bin/node": "node/bin/node",
      "../assets/codemie-cli/node_modules": "cli/node_modules"
    }
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: all pass.

Run: `cd src-tauri && cargo test --test bundle_resources`
Expected: `bundle_resources_resolve_one_to_one ... ok` (it now resolves the real staged tree on macOS, several thousand files, in a few seconds) and `bundle_resources_ship_no_pkg_exe ... ok`.

- [ ] **Step 5: Prove the build script now needs the tree, and that it is present**

Run: `cd src-tauri && cargo clippy -- -D warnings`
Expected: passes (the overlay is merged at build time; with the tree staged there is no `resource path ... doesn't exist`).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/tauri.macos.conf.json ui/test/shim.test.mjs
git commit -m "feat: EPMCDME-14572 — tauri.macos.conf.json overlay ships shim, node and CLI tree"
```

---

### Task 4: PATH registration at launch

**Files:**
- Modify: `src-tauri/src/commands/pathman.rs:297-357` (`inject_bundled_bin_path`) and its test modules
- Test: `src-tauri/src/commands/pathman.rs` (inline)

**Interfaces:**
- Produces: `pub(crate) fn should_persist_bundle_dir(dir: &std::path::Path) -> bool` (non-Windows). `inject_bundled_bin_path(app) -> Result<(), String>` keeps its signature; on macOS it now also persists to `~/.zprofile`.

- [ ] **Step 1: Write the failing tests**

Add to `pathman.rs`, before `#[cfg(test)] mod tests {`:

```rust
#[cfg(all(test, not(windows)))]
mod tests_macos_bundle_dir {
    use super::*;
    use std::fs;
    use std::path::Path;
    use tempfile::TempDir;

    #[test]
    fn should_persist_rejects_a_dmg_mount() {
        assert!(!should_persist_bundle_dir(Path::new(
            "/Volumes/CodeMie Connect/CodeMie Connect.app/Contents/Resources/bin"
        )));
    }

    #[test]
    fn should_persist_rejects_app_translocation() {
        assert!(!should_persist_bundle_dir(Path::new(
            "/private/var/folders/x1/abc/T/AppTranslocation/6F0A-1B2C/d/CodeMie Connect.app/Contents/Resources/bin"
        )));
    }

    #[test]
    fn should_persist_accepts_applications() {
        assert!(should_persist_bundle_dir(Path::new(
            "/Applications/CodeMie Connect.app/Contents/Resources/bin"
        )));
        assert!(should_persist_bundle_dir(Path::new(
            "/Users/alice/Applications/CodeMie Connect.app/Contents/Resources/bin"
        )));
    }

    #[test]
    fn probe_dir_detects_the_macos_shim() {
        let dir = TempDir::new().unwrap();
        fs::write(dir.path().join("codemie"), b"#!/bin/sh\n").unwrap();
        assert!(probe_dir(dir.path()));
    }

    #[test]
    fn probe_dir_returns_false_for_empty_directory() {
        let dir = TempDir::new().unwrap();
        assert!(!probe_dir(dir.path()));
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd src-tauri && cargo test tests_macos_bundle_dir`
Expected: compile error `cannot find function should_persist_bundle_dir`.

- [ ] **Step 3: Implement**

In `pathman.rs`, add after `build_new_path` (around line 295):

```rust
/// A bundle running from a DMG mount or an App Translocation sandbox has a
/// throwaway path; writing it to ~/.zprofile would leave a dead entry behind.
/// The next launch from /Applications persists the real one.
#[cfg(not(windows))]
pub(crate) fn should_persist_bundle_dir(dir: &std::path::Path) -> bool {
    !dir.starts_with("/Volumes")
        && !dir
            .components()
            .any(|c| c.as_os_str() == "AppTranslocation")
}
```

Replace the body of `inject_bundled_bin_path` (from the doc comment down to the closing brace) with:

```rust
/// Prepend the directory containing the bundled codemie shim to the process
/// PATH so all login-shell invocations (runner.rs, pty.rs) find it, and persist
/// it for terminals opened later. Must be called before any plugin is
/// installed (see lib.rs setup order).
pub fn inject_bundled_bin_path(app: &tauri::AppHandle) -> Result<(), String> {
    // Approach B: next to the main executable. Approach A: resource_dir, where
    // tauri.<os>.conf.json places the shim at bin/codemie(.cmd); probe_with_bin_dir
    // tries both `d` and `d/bin/`.
    let bin_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .and_then(|d| probe_with_bin_dir(d, probe_dir))
        .or_else(|| {
            app.path()
                .resource_dir()
                .ok()
                .and_then(|d| probe_with_bin_dir(d, probe_dir))
        });

    let Some(dir) = bin_dir else {
        return Err("[inject_bundled_bin_path] bundled shim not found; PATH unchanged".to_string());
    };
    let dir_str = dir.to_str().ok_or_else(|| {
        "[inject_bundled_bin_path] shim dir has non-UTF-8 path; PATH unchanged".to_string()
    })?;
    let current = std::env::var("PATH").unwrap_or_default();
    let new_path = build_new_path(&current, dir_str);
    // SAFETY: set_var mutates the process environment; Rust's safety contract
    // requires no concurrent env reads from other threads. This call is placed
    // inside Tauri's setup() closure, which runs synchronously before any
    // plugin::init() call that could spawn a worker thread. In Tauri 2.x,
    // Builder::run() wraps the event-loop initialisation; setup() executes
    // single-threaded before the event loop starts plugins. If Tauri's internal
    // threading model changes, this call must move to before Builder::default().
    // See lib.rs for the call site and invocation order.
    unsafe { std::env::set_var("PATH", &new_path) };
    log::info!("[inject_bundled_bin_path] prepended {}", dir_str);

    // set_var affects the current process only. Persist so terminals opened
    // after installation inherit it: HKCU\Environment on Windows (the NSIS hook
    // writes it too), ~/.zprofile on macOS, where the app is its own installer.
    #[cfg(windows)]
    let persistable = true;
    #[cfg(not(windows))]
    let persistable = should_persist_bundle_dir(&dir);
    if persistable {
        if let Err(e) = persist(&[dir_str.to_string()]) {
            log::warn!("[inject_bundled_bin_path] PATH persist failed: {e}");
        }
    } else {
        log::warn!(
            "[inject_bundled_bin_path] not persisting {dir_str}: the app runs from a DMG mount or an App Translocation path; move it to /Applications"
        );
    }
    Ok(())
}
```

This removes the `sidecar_name` variables, the `probe` closure and the `#[allow(clippy::needless_borrows_for_generic_args)]`: `probe_dir` already covers `codemie` on both platforms (`candidate_bin_names`), so the sidecar probe was redundant.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd src-tauri && cargo fmt && cargo test pathman`
Expected: all `pathman` tests pass, including the five new ones.

Run: `cd src-tauri && cargo clippy -- -D warnings`
Expected: passes (if clippy suggests `let ... else` changes or unused imports, fix them, do not `allow`).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/pathman.rs
git commit -m "feat: EPMCDME-14572 — persist the bundled bin dir to ~/.zprofile at launch, drop the sidecar probe"
```

---

### Task 5: Cross-platform direct invocation for self-update

**Files:**
- Modify: `src-tauri/src/state.rs:17-24`
- Modify: `src-tauri/src/lib.rs:26-58`
- Modify: `src-tauri/src/commands/runner.rs:140-206` and `:247-270`
- Test: `src-tauri/src/commands/runner.rs` (inline), `ui/test/shim.test.mjs` (existing `lib.rs` test keeps passing)

**Interfaces:**
- Consumes: `AppState` from Task 4's unchanged `pre_injection_path` / `bundled_injected`.
- Produces: `AppState.node_exe_path: PathBuf`, `AppState.cli_entry_path: PathBuf` on all platforms; `pub(crate) async fn self_update_direct(node_exe: &Path, cli_entry: &Path) -> CmdResult<String>` on all platforms.

- [ ] **Step 1: Write the failing test**

In `runner.rs`, replace the `#[cfg(all(test, windows))] mod tests_windows_self_update { ... }` module with:

```rust
#[cfg(test)]
mod tests_self_update {
    use super::*;

    /// `self_update_direct` must surface a spawn failure as `Err`, on both
    /// platforms: a file that is not a valid executable (Windows: not a PE;
    /// unix: no execute bit) cannot be run as the bundled node.
    /// The success path needs the real bundled node and is exercised by
    /// build-installer's post-build shim smoke.
    #[tokio::test]
    async fn self_update_direct_errors_when_node_not_executable() {
        let dir = tempfile::TempDir::new().unwrap();
        let fake_node = dir.path().join(if cfg!(windows) { "node.exe" } else { "node" });
        let fake_cli = dir.path().join("codemie.js");
        std::fs::write(&fake_node, b"not an executable").unwrap();
        std::fs::write(&fake_cli, b"// placeholder").unwrap();
        let result = self_update_direct(&fake_node, &fake_cli).await;
        assert!(
            result.is_err(),
            "self_update_direct must return Err when the node binary cannot be executed"
        );
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src-tauri && cargo test tests_self_update`
Expected: compile error, `self_update_direct` is `#[cfg(windows)]`.

- [ ] **Step 3: Make the state cross-platform**

`state.rs` lines 17-24 become:

```rust
    /// Absolute path to the bundled node binary: `node/node.exe` on Windows,
    /// `node/bin/node` on macOS. Populated in the `setup` closure from `resource_dir()`.
    pub node_exe_path: std::path::PathBuf,
    /// Absolute path to the bundled CLI entry-point (`bin/codemie.js`).
    /// Populated in the `setup` closure from `resource_dir()`.
    pub cli_entry_path: std::path::PathBuf,
```

- [ ] **Step 4: Compute both paths on both platforms**

`lib.rs`: replace the block from `// Build AppState with Windows-specific absolute paths` through the `app.manage(AppState { ... });` call with:

```rust
            // The bundled runtime and CLI entry live under resource_dir(): node/node.exe
            // on Windows (tauri.windows.conf.json), node/bin/node on macOS
            // (tauri.macos.conf.json). If resource_dir() fails, both paths stay empty and
            // run_self_update falls back to the codemie shim on PATH.
            let (node_exe, cli_entry) = app
                .path()
                .resource_dir()
                .map(|res| {
                    let node = if cfg!(windows) {
                        res.join("node").join("node.exe")
                    } else {
                        res.join("node").join("bin").join("node")
                    };
                    let entry = res
                        .join("cli")
                        .join("node_modules")
                        .join("@codemieai")
                        .join("code")
                        .join("bin")
                        .join("codemie.js");
                    (node, entry)
                })
                .unwrap_or_else(|e| {
                    log::warn!("resource_dir() failed: {e}; absolute CLI invocation unavailable");
                    (std::path::PathBuf::new(), std::path::PathBuf::new())
                });

            app.manage(AppState {
                pre_injection_path,
                bundled_injected,
                node_exe_path: node_exe,
                cli_entry_path: cli_entry,
                ..AppState::default()
            });
```

- [ ] **Step 5: Make the runner cross-platform**

`runner.rs`: on `self_update_direct` delete the `#[cfg(windows)]` line and change its doc to:

```rust
/// Direct invocation of the bundled node binary + CLI entry-point.
/// Extracted from `run_self_update` so the invocation logic can be unit-tested
/// independently of Tauri's managed `State`.
```

On `run_self_update`: delete the `#[cfg_attr(not(windows), allow(unused_variables))]` line, change the doc to:

```rust
/// Run `codemie self-update` silently (captured, not PTY).
/// Invokes the bundled node + CLI entry absolutely when both paths exist;
/// falls back to the `codemie` shim on PATH through the platform shell.
/// Returns stdout on exit 0; serializes as an error string on non-zero exit.
```

and unwrap the `#[cfg(windows)] { ... }` block so its body runs on every platform:

```rust
#[tauri::command]
pub async fn run_self_update(state: tauri::State<'_, crate::state::AppState>) -> CmdResult<String> {
    let node = &state.node_exe_path;
    let cli = &state.cli_entry_path;
    if node.exists() && cli.exists() {
        return self_update_direct(node, cli).await;
    }
    // At least one bundled path is absent. Log which one is missing to help
    // diagnose PATH injection failures before falling back to the shim.
    if !node.exists() {
        log::warn!(
            "[run_self_update] node_exe_path not found ({}); falling back to PATH shim",
            node.display()
        );
    }
    if !cli.exists() {
        log::warn!(
            "[run_self_update] cli_entry_path not found ({}); falling back to PATH shim",
            cli.display()
        );
    }
    let r = capture("codemie self-update", None).await;
    if r.code == 0 {
        Ok(r.stdout)
    } else {
        Err(crate::error::InstallerError::Other(format!(
            "codemie self-update failed (exit {}): {}",
            r.code,
            r.stderr.trim()
        )))
    }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd src-tauri && cargo fmt && cargo clippy --all-targets -- -D warnings && cargo test`
Expected: clippy clean; `tests_self_update::self_update_direct_errors_when_node_not_executable ... ok`; every other test passes.

Run: `npm test`
Expected: `lib.rs cli_entry_path targets bin/codemie.js, never dist/index.js` still passes.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/state.rs src-tauri/src/lib.rs src-tauri/src/commands/runner.rs
git commit -m "feat: EPMCDME-14572 — self-update runs the bundled node directly on both platforms"
```

---

### Task 6: Build script, docs, full build and manual verification

**Files:**
- Create: `build-installer.sh`
- Modify: `.ai-run/guides/quality-gates.md` (Build section), `README.md:84-97` (Build a shareable DMG)

**Interfaces:**
- Consumes: everything above.
- Produces: `src-tauri/target/release/bundle/dmg/CodeMie Connect_<version>_aarch64.dmg` and the kept `.app`.

- [ ] **Step 1: Write the build script**

Create `build-installer.sh`:

```bash
#!/usr/bin/env bash
# build-installer.sh
# Stages the bundled Node runtime + CodeMie CLI tree, verifies every artifact,
# then builds the macOS .app and DMG via Tauri. Mirrors build-installer.ps1.
#
# Usage: ./build-installer.sh [--skip-stage]
#
# --skip-stage   Reuse an already-staged tree. Does NOT skip verification.
#
# There is deliberately no switch to skip verification. Every defect the Windows
# script guards against was produced by a tool that reported success:
#   * pkg emitted a warning and exited 0, shipping a snapshot missing a file.
#   * dist/index.js exits 0 and prints nothing, so the CLI never starts.
#   * A glob in bundle.resources flattens the tree and reports errors: 0.
# An exit-code check is not verification. Do not add a bypass.
set -euo pipefail

SKIP_STAGE=0
for arg in "$@"; do
  case "$arg" in
    --skip-stage) SKIP_STAGE=1 ;;
    *) echo "[build] unknown argument: $arg" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")" && pwd)"
CFG="$ROOT/runtime.json"
NODE_BIN="$ROOT/assets/macos/node/bin/node"
CLI_MODULES="$ROOT/assets/codemie-cli/node_modules"
CLI_ENTRY="$CLI_MODULES/@codemieai/code/bin/codemie.js"
MANIFEST="$ROOT/assets/staging-manifest.json"
TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/src-tauri/target}"
PRODUCT="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).productName)" "$ROOT/src-tauri/tauri.conf.json")"
APP="$TARGET_DIR/release/bundle/macos/$PRODUCT.app"
RES="$APP/Contents/Resources"

fail() { echo; echo "[build] $*" >&2; exit 1; }
step() { echo; printf '\033[36m==> %s\033[0m\n' "$*"; }
cfg()  { node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))[process.argv[2]] ?? ''))" "$CFG" "$1"; }

NODE_VERSION="$(cfg nodeVersion)"
CLI_VERSION="$(cfg cliVersion)"

# ── 1. Stage ────────────────────────────────────────────────────────────────
if [ "$SKIP_STAGE" = 1 ]; then
  step "[1/5] Skipping staging (--skip-stage); verification still runs"
else
  step "[1/5] Staging bundled runtime and CLI tree"
  "$ROOT/scripts/stage-runtime.sh" || fail "scripts/stage-runtime.sh failed"
fi

# ── 2. Pre-build assertions ─────────────────────────────────────────────────
step "[2/5] Verifying staged artifacts"
[ -f "$NODE_BIN" ] || fail "missing bundled runtime: $NODE_BIN"
[ -x "$NODE_BIN" ] || fail "bundled runtime is not executable: $NODE_BIN"
NODE_SIZE="$(stat -f %z "$NODE_BIN")"
[ "$NODE_SIZE" -gt 10485760 ] || fail "bundled node is $NODE_SIZE bytes, expected > 10 MB: $NODE_BIN"
NODE_REPORTED="$("$NODE_BIN" --version 2>&1)" || fail "node --version failed: $NODE_REPORTED"
[ "$NODE_REPORTED" = "v$NODE_VERSION" ] || fail "bundled node reports $NODE_REPORTED but runtime.json pins v$NODE_VERSION"
echo "    node $NODE_REPORTED ($(( NODE_SIZE / 1048576 )) MB)"

for rel in \
  "@codemieai/code/bin/codemie.js" \
  "@codemieai/code/dist/cli/index.js" \
  "@codemieai/code/package.json" \
  "keytar/build/Release/keytar.node"; do
  p="$CLI_MODULES/$rel"
  [ -f "$p" ] || fail "missing required bundled file: $p"
  [ -s "$p" ] || fail "required bundled file is empty: $p"
done

[ -f "$MANIFEST" ] || fail "missing staging manifest: $MANIFEST (run without --skip-stage)"
MF_CLI="$(node -e "process.stdout.write(require(process.argv[1]).cliVersion)" "$MANIFEST")"
[ "$MF_CLI" = "$CLI_VERSION" ] || fail "staging manifest reports CLI $MF_CLI but runtime.json pins $CLI_VERSION"
echo "    CLI $MF_CLI: $(node -e "const m=require(process.argv[1]);process.stdout.write(m.fileCount+' files, '+Math.round(m.byteSize/1048576)+' MB')" "$MANIFEST")"

# ── 3. Smoke-test the staged tree ───────────────────────────────────────────
step "[3/5] Smoke-testing the staged CLI"
# Non-empty stdout is the real assertion. dist/index.js would exit 0 silently.
SMOKE="$("$NODE_BIN" "$CLI_ENTRY" --version 2>&1)" || fail "staged CLI exited non-zero: $SMOKE"
[ -n "$(echo "$SMOKE" | tr -d '[:space:]')" ] || fail "staged CLI produced NO output. The entry point is almost certainly wrong: dist/index.js is a library barrel that exits 0 and prints nothing. Expected bin/codemie.js."
echo "    codemie --version -> $SMOKE"

# ── 4. Build ────────────────────────────────────────────────────────────────
step "[4/5] Building .app and DMG via Tauri"
# `app` keeps the .app on disk (tauri-bundler deletes it when only dmg is requested).
(cd "$ROOT/src-tauri" && CI=true cargo tauri build --bundles app dmg) || fail "cargo tauri build failed"

# ── 5. Post-build assertions ────────────────────────────────────────────────
step "[5/5] Verifying the produced bundle"
[ -d "$APP" ] || fail "no app bundle at $APP"

[ -f "$RES/bin/codemie" ] || fail "bundle is missing bin/codemie (looked at $RES/bin/codemie)"
[ -x "$RES/bin/codemie" ] || fail "bundled shim is not executable: $RES/bin/codemie"
[ -f "$RES/node/bin/node" ] || fail "bundle is missing node/bin/node (looked at $RES/node/bin/node)"
[ -x "$RES/node/bin/node" ] || fail "bundled node is not executable: $RES/node/bin/node"
[ "$(stat -f %z "$RES/node/bin/node")" -gt 10485760 ] || fail "bundled node is smaller than 10 MB: $RES/node/bin/node"
[ -f "$RES/cli/node_modules/@codemieai/code/bin/codemie.js" ] || fail "bundle is missing cli/node_modules/@codemieai/code/bin/codemie.js. If the tree is present but flat, a glob key crept back into bundle.resources (spec §4)."

# A flattened tree still contains every file NAME, so presence checks alone
# cannot detect it. Assert nesting depth independently.
DEEP="$(find "$RES/cli/node_modules" -mindepth 4 -type f -print -quit)"
[ -n "$DEEP" ] || fail "bundled cli/node_modules has no nested files: the tree was FLATTENED. Remove any '*' from the bundle.resources CLI-tree key (spec §4)."

for scope in bin node cli; do
  [ -d "$RES/$scope" ] || continue
  STRAY="$(find "$RES/$scope" -type f -name '*.exe' -print -quit)"
  [ -z "$STRAY" ] || fail "Windows binary present in the macOS bundle: $STRAY"
done

# The strongest check: run the shim exactly as an installed user would.
SHIM_OUT="$("$RES/bin/codemie" --version 2>&1)" || fail "bundled shim exited non-zero: $SHIM_OUT"
[ -n "$(echo "$SHIM_OUT" | tr -d '[:space:]')" ] || fail "bundled shim produced NO output: $RES/bin/codemie"
echo "    bundled shim: codemie --version -> $SHIM_OUT"

DMG="$(ls -t "$TARGET_DIR/release/bundle/dmg/"*.dmg 2>/dev/null | head -1 || true)"
[ -n "$DMG" ] || fail "no .dmg produced in $TARGET_DIR/release/bundle/dmg"

echo
printf '\033[32m==> Done. All assertions passed.\033[0m\n'
echo "    App:  $APP"
echo "    DMG:  $DMG"
echo "    Size: $(( $(stat -f %z "$DMG") / 1048576 )) MB"
```

Then: `chmod 755 build-installer.sh`

- [ ] **Step 2: Prove an assertion fires before trusting the green path**

```bash
mv assets/macos/node/bin/node assets/macos/node/bin/node.off
./build-installer.sh --skip-stage; echo "exit=$?"
mv assets/macos/node/bin/node.off assets/macos/node/bin/node
```

Expected: `[build] missing bundled runtime: .../assets/macos/node/bin/node` and `exit=1`, no build started.

- [ ] **Step 3: Run the full build**

Run: `./build-installer.sh --skip-stage` (staging was done in Task 2; the Node download is cached)
Expected: phases 1 to 5 print, `bundled shim: codemie --version -> 0.14.1`, `Done. All assertions passed.` with the app, DMG and size (expect roughly 150 to 200 MB compressed).

- [ ] **Step 4: Manual verification on this Mac, as an installed user**

```bash
APP="${CARGO_TARGET_DIR:-src-tauri/target}/release/bundle/macos/CodeMie Connect.app"
rm -rf "/Applications/CodeMie Connect.app" && cp -R "$APP" /Applications/
cp ~/.zprofile ~/.zprofile.bak-14572
open "/Applications/CodeMie Connect.app"      # first launch registers PATH; close it after the home screen shows
sleep 5; tail -3 ~/.zprofile
env -i HOME="$HOME" TERM=xterm /bin/zsh -lc 'which codemie; codemie --version; which node || echo "no node on PATH: OK"'
```

Expected: `~/.zprofile` ends with the marker block `# Added by CodeMie Installer` and `export PATH="/Applications/CodeMie Connect.app/Contents/Resources/bin:$PATH"`; the login shell prints `/Applications/CodeMie Connect.app/Contents/Resources/bin/codemie`, then the version, and `which node` resolves to Homebrew or nothing, never into the bundle.

Then in the app: run the wizard through `2.3.3` (`codemie setup`) and `2.4` (`doctor`), confirm the PTY shows the CLI starting. Finally `tail -3 ~/Library/Logs/CodeMie/codemie_wizard.log` shows the resolved PATH beginning with the bundle `bin`.

Restore: `cp ~/.zprofile.bak-14572 ~/.zprofile` only if the block should not stay on this machine.

- [ ] **Step 5: Document the staging prerequisite and the build**

`.ai-run/guides/quality-gates.md`, replace the Build section with:

```markdown
### Build

**Prerequisite (both platforms)**: the bundled runtime must be staged once per checkout or `tauri-build` aborts every cargo command with `resource path ... doesn't exist`. macOS: `scripts/stage-runtime.sh`. Windows: `scripts\stage-runtime.ps1`. The staged tree is gitignored and survives branch switches; worktrees need their own.
**Run**: `./build-installer.sh` (macOS) or `.\build-installer.ps1` (Windows). Both stage, assert every artifact, build, then assert the produced bundle. There is no switch to skip verification.
**Pass**: `Done. All assertions passed.` with the app and DMG (macOS) or the NSIS setup exe (Windows) paths
**Fail**: the first failing assertion names the missing, empty or non-executable path
**Plain Tauri build**: `cd src-tauri && CI=true cargo tauri build` still works but verifies nothing; use it only for UI-only changes
**Skip if**: logic-only change verified by tests; skip to save ~2–5 min build time
```

`README.md`, in "Build a shareable DMG" (line 84), add before the `cargo tauri build` block:

```markdown
The DMG ships the CodeMie CLI with its own Node runtime. Build it with the verifying script:

```bash
./build-installer.sh
```

It downloads the pinned Node (`runtime.json`), installs the CLI tree, asserts every bundled artifact before and after the Tauri build, and prints the DMG path. The plain command below skips those checks.
```

- [ ] **Step 6: Run all four gates once more, then commit**

```bash
npm test
(cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test)
git add build-installer.sh .ai-run/guides/quality-gates.md README.md
git commit -m "feat: EPMCDME-14572 — build-installer.sh with non-negotiable artifact assertions, docs"
```

---

### Task 7: Push and open the MR

**Files:** none.

- [ ] **Step 1: Push**

```bash
git push -u origin feat/epmcdme-14572-macos-bundled-runtime
```

- [ ] **Step 2: Open the MR** targeting `EPMCDME-14505-codemie-desktop-peruser-install` (stacked on MR !18; GitLab retargets to `codemie-desktop` when !18 merges), description in the repo skeleton: Goal, Acceptance Criteria (from the spec), What changed (per file, with the why), Found not fixed, Testing (every number measured, not remembered), Known limits, `## Jira` with `https://jira.epam.com/jira/browse/EPMCDME-14572`. No "Generated with" footer.

---

## Self-Review

**Spec coverage**: §1 Task 1; §2 Task 2; §3 Task 1; §4 Task 3; §5 Task 4; §6 Task 5; §7 no change (verified in Task 6 step 4); §8 Task 6; §9 constraints only, recorded in the MR's Known limits. Test coverage list: shim and `runtime.json` and overlay tests in Tasks 1 and 3; `pathman` tests Task 4; `runner` test Task 5; `bundle_resources` Task 3; manual Task 6.

**Placeholders**: none; every step carries its code or command and its expected output.

**Type consistency**: `should_persist_bundle_dir(&Path) -> bool` (Task 4) is only used inside `pathman.rs`; `self_update_direct(&Path, &Path) -> CmdResult<String>` keeps its Windows signature (Task 5); `AppState.node_exe_path` / `cli_entry_path` names match `state.rs`, `lib.rs` and `runner.rs`.
