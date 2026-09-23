status: DONE

## Commit

- SHA: `a041249`
- Message: `EPMCDME-14982 : Add temporary Windows debug logging to setup-driver.js`

## Changed files

- `ui/setup-driver.js` (only file changed/committed — 14 insertions, 0 deletions)

## What was added

All additions marked `// TEMP DEBUG — EPMCDME-14982, remove before commit (Task 7)`:

1. A local `debugLog(tag, payload)` async helper defined at the top of `runSetup`, appending JSON-line entries (with ISO timestamp) to `<tmpdir>/codemie-setup-debug.log` via `node:fs`/`node:os`/`node:path` dynamic imports.
2. `debugLog('chunk', { b64 })` at the very top of `processChunk`, before `decode(b64)`.
3. `debugLog('screen', { lines })` right after `readScreen()` builds `lines` in `processChunk`.
4. `debugLog('prompt', { prompt })` right after `detectPrompt(lines)` assigns `prompt`, before the `promptInFlight`/dispatch checks.
5. `debugLog('resolve', { value })` as the first line of `settleResolve`, called fire-and-forget (not awaited) since `settleResolve` stays synchronous.
6. `debugLog('reject', { error })` as the first line of `settleReject`, same fire-and-forget treatment.

`git diff ui/setup-driver.js` was reviewed before committing and confirmed to contain only these seven additions — no unrelated changes.

## Rebuild step

Skipped. Checked `package.json` at the repo root: its `scripts` only defines `test` and `test:ui` — no `build` / `build:ui` / bundling script exists. Checked `src-tauri/tauri.conf.json`: `build.frontendDist` points directly at `../ui` with no bundler configured, meaning the frontend is served from the `ui/` source files as-is (Option B: thin Rust backend + frontend-brain, no bundling step). A `cargo tauri dev` session picks up `ui/setup-driver.js` directly, so there is no separate rebuild command to run.

## Scope notes

- Only `ui/setup-driver.js` was touched and committed, as instructed.
- Did not touch `ui/handlers.js` or `config/steps-windows.yaml`.
- Did not run the full test/gate suite (out of scope per instructions).
- Did not add any new automated test (per the "Test-first: no" note — pure observability scaffolding).
- Did not merge, push, or open a PR.
- Pre-existing unstaged change to `assets/codemie-cli/package.json` (present before this task started) was left untouched and unstaged.
