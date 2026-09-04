DONE

## Commit
5468a7c

## Changed Paths
- runtime.json (created)
- scripts/stage-runtime.ps1 (created)
- .gitignore (modified)

## Test Command
npm test

## Summary

Task 1 complete. Created runtime.json pinning Node v22.23.2 with verified sha256 checksum and CLI @codemieai/code@0.14.1. Created scripts/stage-runtime.ps1 which downloads Node win-x64 zip, verifies checksum, checks the existing CLI tree is at the pinned version, prunes test/map files, and asserts all required artifacts. Fixed the download trigger to check only for non-existence (not 0-bytes) so the verification block is the authoritative guard for corrupt artifacts — confirmed with RED test that exits non-zero with "node.exe is only 0 bytes" message. Appended assets/windows/node/ and assets/staging-manifest.json to .gitignore. All 19 existing npm tests still pass.
