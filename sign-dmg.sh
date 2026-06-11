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
APP="$SCRIPT_DIR/src-tauri/target/release/bundle/macos/CodeMie Installer.app"
DMG="$SCRIPT_DIR/src-tauri/target/release/bundle/dmg/CodeMie Installer_2.0.0_aarch64.dmg"
IDENTITY="Developer ID Application: ULADZISLAU SVETLAKOU (9H5BAHWPG9)"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

# Load .env.signing if it exists
if [[ -f "$SCRIPT_DIR/.env.signing" ]]; then
  # shellcheck disable=SC1091
  set -o allexport
  source "$SCRIPT_DIR/.env.signing"
  set +o allexport
fi

: "${KEYCHAIN_PASSWORD:?ERROR: KEYCHAIN_PASSWORD is not set. Add it to .env.signing}"

# ── Step 1: Import cert + key into Keychain ───────────────────────────────────
echo "▶ Importing certificate and key into keychain..."

# Ensure Apple Developer ID G2 intermediate CA is present (required for valid chain)
if ! security find-certificate -c "Developer ID Certification Authority" "$KEYCHAIN" &>/dev/null; then
  echo "  Downloading Apple Developer ID intermediate CA..."
  curl -sO /tmp/DeveloperIDG2CA.cer https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer
  security import /tmp/DeveloperIDG2CA.cer -k "$KEYCHAIN" 2>/dev/null || true
fi

# Import private key (suppress "already exists" errors — idempotent)
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

# ── Step 3: Sign the .app ─────────────────────────────────────────────────────
if [[ -d "$APP" ]]; then
  echo "▶ Signing .app bundle..."
  codesign \
    --deep \
    --force \
    --verify \
    --verbose \
    --options runtime \
    --entitlements "$SCRIPT_DIR/src-tauri/Entitlements.plist" 2>/dev/null \
    --sign "$IDENTITY" \
    "$APP" \
    || codesign \
         --deep --force --verify --verbose \
         --options runtime \
         --sign "$IDENTITY" \
         "$APP"

  codesign --verify --deep --strict --verbose=2 "$APP"
  echo "  ✓ .app signed"
else
  echo "  ⚠ .app not found at $APP — skipping .app signing (DMG-only mode)"
fi

# ── Step 4: Sign the DMG ──────────────────────────────────────────────────────
echo "▶ Signing DMG: $DMG"
codesign \
  --force \
  --verify \
  --verbose \
  --sign "$IDENTITY" \
  "$DMG"

codesign --verify --verbose "$DMG"
echo "  ✓ DMG signed"

# ── Step 5: Notarize (optional) ───────────────────────────────────────────────
if [[ "${NOTARIZE:-0}" == "1" ]]; then
  : "${APPLE_ID:?ERROR: APPLE_ID is required for notarization}"
  : "${APPLE_APP_PASSWORD:?ERROR: APPLE_APP_PASSWORD is required for notarization}"
  : "${APPLE_TEAM_ID:=9H5BAHWPG9}"

  echo "▶ Submitting DMG for notarization..."
  xcrun notarytool submit "$DMG" \
    --apple-id "$APPLE_ID" \
    --password "$APPLE_APP_PASSWORD" \
    --team-id "$APPLE_TEAM_ID" \
    --wait

  echo "▶ Stapling notarization ticket to DMG..."
  xcrun stapler staple "$DMG"
  xcrun stapler validate "$DMG"
  echo "  ✓ DMG notarized and stapled"
fi

echo ""
echo "✅ Done: $DMG"
spctl --assess --type open --context context:primary-signature -v "$DMG" 2>&1 || true
