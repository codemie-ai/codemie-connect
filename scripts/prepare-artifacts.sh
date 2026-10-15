#!/usr/bin/env bash
set -euo pipefail

directory="${1:?Usage: prepare-artifacts.sh DIRECTORY PLATFORM}"
platform="${2:?Specify macos or windows}"

case "$platform" in
  macos)
    extension="dmg"
    checksum=(shasum -a 256)
    ;;
  windows)
    extension="exe"
    checksum=(sha256sum)
    ;;
  *)
    echo "Unsupported platform: $platform" >&2
    exit 1
    ;;
esac

cd "$directory"
shopt -s nullglob
files=(*."$extension")

if [ "${#files[@]}" -eq 0 ]; then
  echo "No .$extension artifacts found in $directory" >&2
  exit 1
fi

for file in "${files[@]}"; do
  name="${file//[ _]/-}"

  if [ "$platform" = "windows" ]; then
    name="$(printf '%s' "$name" | sed -E \
      's/-(x64|amd64|x86-64)-setup\.exe$/-windows-amd64.exe/; s/-setup\.exe$/-windows-amd64.exe/')"
  fi

  if [ "$file" != "$name" ]; then
    if [ -e "$name" ]; then
      echo "Cannot rename '$file': '$name' already exists" >&2
      exit 1
    fi
    echo "Renaming '$file' to '$name'"
    mv "$file" "$name"
  fi

  "${checksum[@]}" "$name" > "$name.sha256"
  cat "$name.sha256"
done
