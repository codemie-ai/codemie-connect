#!/usr/bin/env bash
# sign-dmg.sh — Import Apple Developer ID certs, sign .app + DMG, and optionally notarize.
#
# Usage:
#   ./sign-dmg.sh                    # sign only
#   NOTARIZE=1 ./sign-dmg.sh         # sign + notarize + staple
#
# Required env vars (set in .env.signing, never commit that file):
#   KEYCHAIN_PASSWORD   — login keychain password (needed to unlock for codesign access)
#
# Optional env vars for notarization:
#   NOTARIZE=1
#   APPLE_ID            — your Apple ID email
#   APPLE_APP_PASSWORD  — app-specific password from appleid.apple.com
#   APPLE_TEAM_ID       — Team ID (9H5BAHWPG9)

set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CERT_DIR="$SCRIPT_DIR/apple_developer"
CERT="$CERT_DIR/developerID_application.cer"
KEY="$CERT_DIR/DeveloperID.key"
SOURCE_DMG="$SCRIPT_DIR/src-tauri/target/release/bundle/dmg/CodeMie Installer_2.0.0_aarch64.dmg"
IDENTITY="Developer ID Application: ULADZISLAU SVETLAKOU (9H5BAHWPG9)"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
WORK_DIR="$(mktemp -d)"
SIGNED_DMG="$SCRIPT_DIR/src-tauri/target/release/bundle/dmg/CodeMie Installer_2.0.0_aarch64_signed.dmg"

# Load .env.signing if it exists
if [[ -f "$SCRIPT_DIR/.env.signing" ]]; then
  # shellcheck disable=SC1091
  set -o allexport
  source "$SCRIPT_DIR/.env.signing"
  set +o allexport
fi

: "${KEYCHAIN_PASSWORD:?ERROR: KEYCHAIN_PASSWORD is not set. Add it to .env.signing}"

cleanup() {
  # Unmount any leftover mount
  hdiutil detach "$WORK_DIR/mnt" -force 2>/dev/null || true
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

# ── Step 1: Import cert + key into Keychain ───────────────────────────────────
echo "▶ Importing certificate and key into keychain..."

# Ensure Apple Developer ID G2 intermediate CA is present (required for valid chain)
if ! security find-certificate -c "Developer ID Certification Authority" "$KEYCHAIN" &>/dev/null; then
  echo "  Downloading Apple Developer ID intermediate CA..."
  curl -s -o /tmp/DeveloperIDG2CA.cer https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer
  security import /tmp/DeveloperIDG2CA.cer -k "$KEYCHAIN" 2>/dev/null || true
fi

# Import private key (idempotent)
security import "$KEY" \
  -k "$KEYCHAIN" \
  -T /usr/bin/codesign \
  -T /usr/bin/security 2>/dev/null || echo "  (key already in keychain, skipping)"

# Import certificate
security import "$CERT" \
  -k "$KEYCHAIN" \
  -T /usr/bin/codesign 2>/dev/null || echo "  (cert already in keychain, skipping)"

# Allow codesign to use the key without prompting
security set-key-partition-list \
  -S "apple-tool:,apple:,codesign:" \
  -s -k "$KEYCHAIN_PASSWORD" \
  "$KEYCHAIN"

echo "  ✓ Keychain updated"

# ── Step 2: Verify identity is available ─────────────────────────────────────
echo "▶ Verifying signing identity..."
security find-identity -v -p codesigning "$KEYCHAIN" | grep "$IDENTITY" \
  || { echo "ERROR: Signing identity not found in keychain"; exit 1; }
echo "  ✓ Identity found"

# ── Step 3: Extract .app from DMG ────────────────────────────────────────────
echo "▶ Mounting source DMG to extract .app..."
mkdir -p "$WORK_DIR/mnt"
hdiutil attach "$SOURCE_DMG" -mountpoint "$WORK_DIR/mnt" -nobrowse -readonly

APP_IN_DMG=$(find "$WORK_DIR/mnt" -maxdepth 1 -name "*.app" | head -1)
: "${APP_IN_DMG:?ERROR: No .app found inside DMG}"
APP_NAME="$(basename "$APP_IN_DMG")"
echo "  Found: $APP_NAME"

echo "▶ Copying .app out of DMG..."
cp -R "$APP_IN_DMG" "$WORK_DIR/$APP_NAME"
hdiutil detach "$WORK_DIR/mnt" -force
echo "  ✓ .app extracted"

# ── Step 4: Sign all binaries inside the .app ────────────────────────────────
echo "▶ Signing .app with hardened runtime + secure timestamp..."

# Sign nested frameworks/dylibs/binaries first, then the .app bundle itself
find "$WORK_DIR/$APP_NAME" -type f \( -name "*.dylib" -o -name "*.framework" \) | while read -r lib; do
  codesign --force --options runtime --timestamp --sign "$IDENTITY" "$lib" 2>/dev/null || true
done

codesign \
  --deep \
  --force \
  --options runtime \
  --timestamp \
  --sign "$IDENTITY" \
  "$WORK_DIR/$APP_NAME"

codesign --verify --deep --strict --verbose=2 "$WORK_DIR/$APP_NAME"
echo "  ✓ .app signed"

# ── Step 5: Repackage into a new DMG ─────────────────────────────────────────
echo "▶ Creating new DMG from signed .app..."
rm -f "$SIGNED_DMG"
# hdiutil auto-appends .dmg if the path doesn't end in it — use a no-space tmp name then move
TMP_DMG="$WORK_DIR/output.dmg"
hdiutil create \
  -volname "CodeMie Installer" \
  -srcfolder "$WORK_DIR/$APP_NAME" \
  -ov \
  -format UDZO \
  "$TMP_DMG"
cp "$TMP_DMG" "$SIGNED_DMG"
[[ -f "$SIGNED_DMG" ]] || { echo "ERROR: DMG not created at $SIGNED_DMG"; exit 1; }
echo "  ✓ DMG created: $(basename "$SIGNED_DMG")"

# ── Step 6: Sign the DMG itself ───────────────────────────────────────────────
echo "▶ Signing DMG..."
codesign \
  --force \
  --verify \
  --verbose \
  --timestamp \
  --sign "$IDENTITY" \
  "$SIGNED_DMG"

codesign --verify --verbose "$SIGNED_DMG"
echo "  ✓ DMG signed"

# ── Step 7: Notarize (optional) ───────────────────────────────────────────────
if [[ "${NOTARIZE:-0}" == "1" ]]; then
  : "${APPLE_ID:?ERROR: APPLE_ID is required for notarization}"
  : "${APPLE_APP_PASSWORD:?ERROR: APPLE_APP_PASSWORD is required for notarization}"
  : "${APPLE_TEAM_ID:=9H5BAHWPG9}"

  echo "▶ Submitting DMG for notarization..."
  xcrun notarytool submit "$SIGNED_DMG" \
    --apple-id "$APPLE_ID" \
    --password "$APPLE_APP_PASSWORD" \
    --team-id "$APPLE_TEAM_ID" \
    --wait

  echo "▶ Stapling notarization ticket..."
  xcrun stapler staple "$SIGNED_DMG"
  xcrun stapler validate "$SIGNED_DMG"
  echo "  ✓ DMG notarized and stapled"
fi

echo ""
echo "✅ Done: $SIGNED_DMG"
spctl --assess --type open --context context:primary-signature -v "$SIGNED_DMG" 2>&1 || true
