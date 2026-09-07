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

fail() { echo; echo "[build] $*" >&2; exit 1; }
step() { echo; printf '\033[36m==> %s\033[0m\n' "$*"; }
# node is only used to read JSON here and in the staging script; the product never needs it.
command -v node >/dev/null 2>&1 || fail "a system node is required to run this script (only for reading runtime.json and running npm)"
PRODUCT="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).productName)" "$ROOT/src-tauri/tauri.conf.json")"
APP="$TARGET_DIR/release/bundle/macos/$PRODUCT.app"
RES="$APP/Contents/Resources"

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
