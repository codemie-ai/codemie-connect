# EPMCDME-14575 Install and connect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** Enable "Install and connect" on macOS Connections rows by running `codemie proxy connect <flag> --install-client` in the terminal panel and surfacing the CLI result on the row.

**Architecture:** Frontend only. New DOM-free modules hold the logic (output parsing, PTY decoding, help-probe gate, result interpretation, per-app row state, URL opening); `ui/renderer.js` only wires them. No Rust.

**Tech Stack:** Vanilla JS ESM, node:test + assert/strict (`npm test`).

**Spec:** requirements inline in the task; research in `technical-analysis.md` (same dir).

## Acceptance criteria

- Not-installed rows show an enabled "Install and connect" button (macOS).
- It runs `codemie proxy connect <flag> --install-client` in the terminal panel.
- "Install cancelled" with exit 0 shows no row error; row stays Not installed.
- Install failure shows the ANSI-stripped ✗ line on the row, plus "Open the download page" when a `Download page: <https url>` line was printed; row is Not installed.
- Install ok but connect failed shows the reason on the row; row is Not set.
- The row error survives the row rebuild in `refreshConnectionsView`; cleared on the next attempt or on success.
- CLI without `--install-client` in `proxy connect --help`: row shows "needs a newer CodeMie CLI", nothing runs.
- Download page opens only for https URLs, via `runCapture` as `open '<url>'`.
- Analytics' use of `runAction` keeps working.

## Global Constraints

- Commit per task using the repository's existing convention: subject `EPMCDME-14575 : <subject>` plus a short body; never a Co-Authored-By line; stage by explicit path, never `.codemie/codemie-cli.config.json`.
- Never run the real `codemie`; fakes only. No new Rust. macOS only; no Windows, Intel, updates, outdated state, Insiders, confirmation card or step list.
- Load `.ai-run/guides/testing/testing-patterns.md` and `development/development-practices.md` first. Tests must be mutation-verifiable: after green, remove the mechanism from production code and confirm exactly one test fails.
- Decision recorded: the help probe fails closed. If the probe throws, or output (stdout + stderr) lacks `--install-client`, nothing runs; a thrown/empty probe shows "Could not check the CodeMie CLI version" while a clean probe without the flag shows "needs a newer CodeMie CLI".

## Review Focus

- Chunk-split escape or multi-byte ✗ across PTY chunks: error still found (tested in Task 2).
- `\x1b[nB` in output turning into newlines and masking the ✗ line (Task 2).
- Download URL that is `http:`, `javascript:`, malformed, or contains `'` / `;` / `$()`: never opened unquoted (Task 3).
- Exit 0 with "Install cancelled" must show no error; non-zero with no ✗ line still shows a generic reason (Task 3).
- Stale error from an earlier attempt after success or a rebuild (Task 3).

## Negative-constraint pass

negative-constraints honored: no real codemie (fake `runCapture`/`runStream` only, Tasks 2-3); no new Rust (open via `runCapture`, Task 3); never stage the config file (header); no confirmation card/step list (not planned); "no" must not show an error (Task 3); probe failure must not silently run install (Task 3 fail-closed); no Co-Authored-By (header). No task violates any.

### Task 1: Enable the install action

**Files:**
- Modify: `ui/connections-render.js:19-22`
- Test: `ui/test/connections-render.test.mjs:26`

**Test-first:** yes — flipped test asserts the not-installed install action has `disabled === false` and `note === null`, failing against the current disabled entry.

**Interfaces:** Produces: action `{kind:'install', label:'Install and connect', disabled:false, note:null}`.

- [ ] Flip the assertion at test line 26 (rename the test to "enabled"), see it fail, then change line 22 to the enabled entry and drop the "coming soon" comment. Run `npm test`. Commit.

### Task 2: ANSI-safe output analysis and UTF-8 PTY decoding

**Files:**
- Modify: `ui/proxy-parse.js` (add exports; keep `findProxyConnectError(lines)` working, strip ANSI per line inside it too)
- Create: `ui/pty-decode.js`
- Test: `ui/test/proxy-parse.test.mjs`, `ui/test/pty-decode.test.mjs`

**Test-first:** yes — failing tests: (a) raw `\x1b[31m✗ boom\x1b[0m` matches; (b) `Download page: https://x/y` extracted, `http://`, `javascript:` and garbage return null; (c) ✗ line whose escape is split across two decoder chunks is found; (d) bytes E2 9C 97 split across two chunks decode to `✗` (with the old `atob` string it does not); (e) a `\x1b[1B` before the ✗ line does not hide it.

**Interfaces:**
- Produces `analyzeProxyOutput(rawBuffer: string) -> { errorLine: string|null, downloadUrl: string|null }`: runs `stripAnsi` (from `./ansi-strip.mjs`) over the whole buffer first, then splits on `\n`, then reuses the `findProxyConnectError` regex and the `extractDownloadUrl` rule.
- Produces `extractDownloadUrl(lines: string[]) -> string|null`: first `^\s*Download page:\s*(\S+)` match, returned only if `new URL(x).protocol === 'https:'` (return `url.href`).
- Produces `createPtyDecoder() -> (base64: string) => string`: wraps `new TextDecoder('utf-8')` and decodes with `{stream:true}` from `Uint8Array.from(atob(b64), c => c.charCodeAt(0))`, so split multibyte characters survive.

- [ ] Write the failing tests, run, implement, run `npm test`. Commit.

### Task 3: Install-client logic module

**Files:**
- Create: `ui/install-client.js`
- Test: `ui/test/install-client.test.mjs`

**Test-first:** yes — failing tests with fake `runCapture`: (a) help text with the flag on stdout passes; on stderr only passes; absent gives `{ok:false, reason:'needs-newer-cli'}`; rejected probe or empty output gives `{ok:false, reason:'probe-failed'}`; (b) `interpretInstallResult({code:0, errorLine:null, rawBuffer:'Install cancelled'})` gives no error; code 0 with a ✗ line gives that line; non-zero without a ✗ line gives a generic message; `downloadUrl` carried through; (c) `quoteForShell("https://a/b'c")` yields `'https://a/b'\''c'`; (d) `openDownloadPage(url, runCapture)` calls `runCapture("open '<quoted>'")` once for https, never for `http:`/`javascript:`/garbage, and rejects non-strings; (e) row-state store: `set`, `get`, `clear(app)` survive independently of any DOM; setting a new error replaces the old.

**Interfaces:**
- `checkInstallSupported(runCapture) -> Promise<{ok:true}|{ok:false, reason:'needs-newer-cli'|'probe-failed'}>`: runs `codemie proxy connect --help` once; tests `/--install-client\b/` on `stdout + '\n' + stderr`.
- `interpretInstallResult({code, errorLine, downloadUrl}) -> { error: string|null, downloadUrl: string|null }`: error is null when `code === 0 && !errorLine`; for `code !== 0` without errorLine use `Install failed (exit <code>).`; downloadUrl is kept only when an error exists.
- `quoteForShell(s) -> string`, `openDownloadPage(url, runCapture) -> Promise<boolean>`.
- `createRowStateStore() -> { get(app), set(app, {error, downloadUrl, note}), clear(app) }` (plain `Map`).
- `INSTALL_NOTES = { 'needs-newer-cli': 'Needs a newer CodeMie CLI', 'probe-failed': 'Could not check the CodeMie CLI version' }`.

- [ ] Write the failing tests, run, implement, run `npm test`. Commit.

### Task 4: Wire into renderer and style the row

**Files:**
- Modify: `ui/renderer.js:474-514` (`runAction`), `:627-695` (`refreshConnectionsView`), `:701-713` (`runConnectionRowAction`); imports at top; `ui/styles.css` near the `.connection-row` rules (~498-543)
- Test: none beyond Tasks 2-3 (renderer cannot be imported under node); smoke by hand with a fake `codemie` script on PATH only.

**Test-first:** no — thin wiring over modules tested in Tasks 2-3.

**Interfaces:** Consumes everything from Tasks 2-3.

Steps (single pass):
- `runAction`: when `parseError` is given, decode chunks with `createPtyDecoder()` instead of `atob`; keep the existing `parseError(buf.split(...))` behaviour for current callers, and `return { code, rawBuffer: buf }` after the spawn (`return null` on the error and setup-running paths). Existing callers ignore the return, so analytics keeps working. Add `extra.rawParse` only if needed; otherwise pass `analyzeProxyOutput`-compatible `parseError` as `(lines) => analyzeProxyOutput(lines.join('\n')).errorLine`.
- `runConnectionRowAction`: add an `install` branch before spawning. Clear the row's state, run `checkInstallSupported`, on `!ok` set `{note: INSTALL_NOTES[reason]}`, refresh, and return without calling `runAction` (do not leave buttons disabled). Otherwise cmd is `codemie proxy connect <flag> --install-client`. After `runAction` returns, compute `analyzeProxyOutput(result.rawBuffer)` plus `interpretInstallResult`, store `{error, downloadUrl}` in the store (a module-level `createRowStateStore()` instance) for every action kind so a connect failure after a successful install also shows its reason. Clear on success.
- `refreshConnectionsView`: after building `.row-main`, read `store.get(row.app)`; render a `.row-error` div (error text, `textContent` only) or `.row-note`; when `downloadUrl` exists add an "Open the download page" button calling `openDownloadPage(url, (c) => bridge.runner.runCapture(c))`. Refresh on terminal close stays as is.
- `ui/styles.css`: `.row-error` (red text) and `.row-note` (muted), reusing existing tokens.
- Run `npm test`; hand-check with a fake CLI covering yes, no (exit 0), failure with red ✗ + Download page, and old help text. Commit CSS and JS together by explicit path.
