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
  # Written only when it differs, so the tracked file does not churn per platform.
  WANT_JSON="$(printf '{\n  "name": "codemie-cli-bundle",\n  "version": "0.0.0",\n  "private": true,\n  "dependencies": {\n    "%s": "%s"\n  }\n}\n' "$CLI_PACKAGE" "$CLI_VERSION")"
  if [ ! -f "$CLI_DIR/package.json" ] || [ "$(cat "$CLI_DIR/package.json")" != "$WANT_JSON" ]; then
    printf '%s\n' "$WANT_JSON" > "$CLI_DIR/package.json"
  fi
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

DANGLING="$(find "$CLI_MODULES" -type l ! -exec test -e {} \; -print -quit)"
[ -z "$DANGLING" ] || fail "dangling symlink in the CLI tree (the bundler copies symlink targets): $DANGLING"

# ── 5. Manifest ─────────────────────────────────────────────────────────────
FILE_COUNT="$(find "$CLI_MODULES" -type f | wc -l | tr -d ' ')"
BYTE_SIZE="$(find "$CLI_MODULES" -type f -exec stat -f %z {} + | awk '{s+=$1} END {print s+0}')"
printf '{\n  "nodeVersion": "%s",\n  "cliPackage": "%s",\n  "cliVersion": "%s",\n  "platform": "darwin-arm64",\n  "fileCount": %s,\n  "byteSize": %s\n}\n' \
  "$NODE_VERSION" "$CLI_PACKAGE" "$CLI_VERSION" "$FILE_COUNT" "$BYTE_SIZE" > "$MANIFEST"
printf '\033[32m==> Staging OK: %s files, %s MB\033[0m\n' "$FILE_COUNT" "$(( BYTE_SIZE / 1048576 ))"
