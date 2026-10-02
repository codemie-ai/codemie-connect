#!/usr/bin/env bash
# Packs the staged macOS runtime (Node + CLI tree) into the one archive the app
# downloads on first launch, and writes what the app and the shim need to find
# and verify it. Run after scripts/stage-runtime.sh. Apple Silicon only.
# Upload dist/<file> to the URL printed at the end before publishing the app.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CFG="$ROOT/runtime.json"
NODE_DIR="$ROOT/assets/macos/node"
CLI_MODULES="$ROOT/assets/codemie-cli/node_modules"
OUT_DIR="$ROOT/dist"
PACK_JSON="$ROOT/assets/macos/runtime-pack.json"
KEY_FILE="$ROOT/assets/macos/bin/runtime-key"

fail() { echo "[pack-runtime] $*" >&2; exit 1; }
cfg() { node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))[process.argv[2]] ?? ''))" "$CFG" "$1"; }

[ -x "$NODE_DIR/bin/node" ] || fail "no staged node at $NODE_DIR; run scripts/stage-runtime.sh first"
[ -f "$CLI_MODULES/@codemieai/code/bin/codemie.js" ] || fail "no staged CLI at $CLI_MODULES; run scripts/stage-runtime.sh first"

NODE_VERSION="$(cfg nodeVersion)"
CLI_VERSION="$(cfg cliVersion)"
BASE_URL="$(cfg runtimeBaseUrlMacos)"
[ -n "$BASE_URL" ] || fail "runtime.json: runtimeBaseUrlMacos missing"

KEY="$CLI_VERSION-node$NODE_VERSION"
FILE="codemie-runtime-$KEY-darwin-arm64.tar.gz"
URL="${BASE_URL//\{key\}/$KEY}/$FILE"

# Same layout the app's Resources had: node/..., cli/node_modules/...
# Built in a temp tree so the archive never carries the staging paths.
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/node" "$TMP/cli/node_modules"
cp -R "$NODE_DIR/." "$TMP/node/"
cp -R "$CLI_MODULES/." "$TMP/cli/node_modules/"
mkdir -p "$OUT_DIR"
(cd "$TMP" && COPYFILE_DISABLE=1 tar -czf "$OUT_DIR/$FILE" node cli)

SHA="$(shasum -a 256 "$OUT_DIR/$FILE" | cut -d' ' -f1)"
SIZE="$(stat -f %z "$OUT_DIR/$FILE")"
printf '{\n  "key": "%s",\n  "url": "%s",\n  "sha256": "%s",\n  "size": %s\n}\n' "$KEY" "$URL" "$SHA" "$SIZE" > "$PACK_JSON"
printf '%s\n' "$KEY" > "$KEY_FILE"

echo "==> $OUT_DIR/$FILE ($(( SIZE / 1048576 )) MB)"
echo "    sha256 $SHA"
echo "    upload to $URL"
