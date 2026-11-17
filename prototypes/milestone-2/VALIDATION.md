# Milestone 2 — validation

Gate and smoke results recorded as each one runs, newest last. Each entry names the build, the
command and what was observed.

## 2026-11-17 — Plugin frame isolation (Task 17 gate): PASS

**Build:** debug, `cargo build` in `src-tauri/` (Tauri 2.12.6, WKWebView on macOS), the Task 17
commit. Run outside the agent sandbox, on a temporary workspace (never the owner's data):

```sh
CODEMIE_WORKSPACE_TEST_DIR="$(mktemp -d)/workspace" CODEMIE_PLUGIN_SMOKE=isolation ./target/debug/app
```

The main window opens `connect-plugin://isolation-probe/__host/frame.html?probe=1` in an
`<iframe sandbox="allow-scripts">`. `probe.js` runs inside it, tries what plugin code must not be
able to do, and posts its findings to the main window, which adds its own and has Rust write
`$TMPDIR/connect-plugin-isolation.json`. The app then quits (exit 0).

| Field | Expected | Observed |
|---|---|---|
| `tauriGlobal` | false | false: `typeof __TAURI__` is `undefined` |
| `internals` | false | false: `typeof __TAURI_INTERNALS__` is `undefined`; `window.ipc` is `undefined` too |
| `ipcFetchRejected` | true | true: `fetch('ipc://localhost/…')` and `fetch('http://ipc.localhost/…')` both fail with `TypeError: Load failed` (frame CSP `connect-src 'none'`) |
| `invokeRejected` | true | true: nothing to invoke with in the frame. A call forged through `webkit.messageHandlers.ipc` with a guessed key and a forged `Origin: tauri://localhost` reached Tauri and was dropped (`__TAURI_INVOKE_KEY__ expected <redacted> but received forged-by-plugin-frame` on stderr); it never reached a command (`forgedIpcReachedRust: false`) |
| `parentBlocked` | true | true: `parent.document`, `parent.__TAURI_INTERNALS__` and `top.location.href` throw `SecurityError: Sandbox access violation` |
| `moduleImportWorks` | true | true: the frame's module script and `import('./probe-import.js')` load (`Origin: null` requests, `Access-Control-Allow-Origin: null` responses) |
| `localStorageThrows` | true | true: `SecurityError: The operation is insecure.` (`sessionStorage` too) |

Also observed: the frame's origin and the message origin are `null` (opaque);
`storage_status` and `workspace_request {op: snapshot}` from Connect's own page are still allowed
by the caller checks; the navigation guard refused the same frame opening a plugin file as a
document (`nonShimDocumentRefused: true`, log `navigation: refused connect-plugin://isolation-probe`).
`document.cookie` reads as an empty string rather than throwing (WebKit).

**Finding on the way:** with DESIGN 7.3's CSP verbatim (`script-src 'self'` and so on), WebKit
blocked the shim's own module script: `frame.html` was served, `probe.js` was never requested, and
the frame never reported. WebKit matches `'self'` against the sandboxed document's opaque origin.
The served CSP now names the plugin's own origin where DESIGN writes `'self'`
(`default-src connect-plugin://<id>; script-src connect-plugin://<id>; style-src connect-plugin://<id> 'unsafe-inline'; img-src connect-plugin://<id> data:; connect-src 'none'`).
The sandbox attribute is unchanged.

`$TMPDIR/connect-plugin-isolation.json`:

```json
{
  "failed": [],
  "forgedIpcReachedRust": false,
  "internals": false,
  "invokeRejected": true,
  "ipcFetchRejected": true,
  "localStorageThrows": true,
  "moduleImportWorks": true,
  "observed": {
    "cookie": { "threw": false, "value": "" },
    "forgedPostMessage": { "threw": false, "value": "sent" },
    "frameSandbox": "allow-scripts",
    "frameSrc": "connect-plugin://isolation-probe/__host/frame.html?probe=1",
    "href": "connect-plugin://isolation-probe/__host/frame.html?probe=1",
    "internals": "undefined",
    "internalsInvoke": "undefined",
    "ipcFetch": { "error": "TypeError: Load failed", "rejected": true },
    "ipcFetchWindows": { "error": "TypeError: Load failed", "rejected": true },
    "isSecureContext": true,
    "localStorage": { "error": "SecurityError: The operation is insecure.", "threw": true },
    "mainFrameStorageStatus": "allowed",
    "mainFrameWorkspaceSnapshot": "allowed",
    "messageOrigin": "null",
    "moduleImport": { "marker": "module-import-ok", "ok": true },
    "nonShimDocumentRefused": true,
    "origin": "null",
    "parentDocument": { "error": "SecurityError: Sandbox access violation: Blocked a frame at \"connect-plugin://isolation-probe\" from accessing a cross-origin frame.  The frame requesting access is sandboxed and lacks the \"allow-same-origin\" flag.", "threw": true },
    "parentInternals": { "error": "SecurityError: Sandbox access violation: Blocked a frame at \"connect-plugin://isolation-probe\" from accessing a cross-origin frame.  The frame requesting access is sandboxed and lacks the \"allow-same-origin\" flag.", "threw": true },
    "sessionStorage": { "error": "SecurityError: The operation is insecure.", "threw": true },
    "tauriGlobal": "undefined",
    "topLocation": { "error": "SecurityError: Sandbox access violation: Blocked a frame at \"connect-plugin://isolation-probe\" from accessing a cross-origin frame.  The frame requesting access is sandboxed and lacks the \"allow-same-origin\" flag.", "threw": true },
    "windowIpc": "undefined"
  },
  "parentBlocked": true,
  "pass": true,
  "tauriGlobal": false
}
```

## 2026-11-17 — Plugin frame isolation, re-run after review fix round 1: PASS

This run supersedes the entry above. It is a fresh run on a temp workspace, from a debug `cargo build` of the fix-round code:

- **Run id:** `2afebd6a-8983-4b2b-a720-39d9f997b726`
- **Started / reported:** `2026-11-17T12:13:34.186613+00:00` / `2026-11-17T12:13:37.795424+00:00`
- **pid:** 46506, version 2.1.1, exit 0

What the fix round changed in the smoke:

- At startup the smoke deletes any previous report.
- It refuses to run beside another Connect, because single-instance would hand the launch to that app, which would exit 0 having tested nothing.
- The frame must echo the run id; otherwise `runId` fails.

**Negative check of the run guard.** A stale `{"pass":true,"stale":true}` report and a placeholder `/tmp/com_epam_codemie_installer_si.sock` were planted, then the app was launched. Result:

- exit 3
- the stale report was removed
- message: `CODEMIE_PLUGIN_SMOKE: another Connect is running (/tmp/com_epam_codemie_installer_si.sock exists). This launch would be handed to it and test nothing. …`

All seven gate fields hold, `failed` is empty, and `probeRunId` equals `runId`.

New observations in this run:

- **Escapes:**
  - `top.location.href = <shim>` threw `SecurityError: The operation is insecure.`
  - `window.open(<shim>)` returned `null`.
  - A `target=_top` form `submit()` returned without navigating; the sandbox has no `allow-forms`.
  - `mainPageStayed: true`.
- **postMessage fallback:** the probe made Tauri's `ipc:` fetch fail once, so Tauri switched to postMessage.
  - Connect's own invoke, which sends `Origin: location.origin` (`tauri://localhost`), was `allowed`.
  - A bare `__TAURI__.core.invoke` without the header was refused with `Only Connect's own page can do this.`
- **Windows:** plugin frames are now refused there: `serve` answers 404, `pluginUrl` throws, the navigation guard has no WebView2 plugin form, and the CSP's `frame-src` is `connect-plugin:` only. wry injects init scripts into subframes on Windows, so a frame would hold the invoke key.

`$TMPDIR/connect-plugin-isolation.json`:

```json
{
  "failed": [],
  "forgedIpcReachedRust": false,
  "internals": false,
  "invokeRejected": true,
  "ipcFetchRejected": true,
  "localStorageThrows": true,
  "moduleImportWorks": true,
  "observed": {
    "cookie": { "threw": false, "value": "" },
    "escapes": {
      "formTargetTop": { "threw": false, "value": "submit() returned" },
      "topNavigation": { "error": "SecurityError: The operation is insecure.", "threw": true },
      "windowOpen": { "threw": false, "value": "null" }
    },
    "forgedPostMessage": { "threw": false, "value": "sent" },
    "frameSandbox": "allow-scripts",
    "frameSrc": "connect-plugin://isolation-probe/__host/frame.html?probe=1&run=2afebd6a-8983-4b2b-a720-39d9f997b726",
    "href": "connect-plugin://isolation-probe/__host/frame.html?probe=1&run=2afebd6a-8983-4b2b-a720-39d9f997b726",
    "internals": "undefined",
    "internalsInvoke": "undefined",
    "ipcFetch": { "error": "TypeError: Load failed", "rejected": true },
    "ipcFetchWindows": { "error": "TypeError: Load failed", "rejected": true },
    "isSecureContext": true,
    "localStorage": { "error": "SecurityError: The operation is insecure.", "threw": true },
    "mainFrameLocationOrigin": "tauri://localhost",
    "mainFrameStorageStatus": "allowed",
    "mainFrameWorkspaceSnapshot": "allowed",
    "mainPageStayed": true,
    "messageOrigin": "null",
    "moduleImport": { "marker": "module-import-ok", "ok": true },
    "nonShimDocumentRefused": true,
    "origin": "null",
    "parentDocument": { "error": "SecurityError: Sandbox access violation: Blocked a frame at \"connect-plugin://isolation-probe\" from accessing a cross-origin frame.  The frame requesting access is sandboxed and lacks the \"allow-same-origin\" flag.", "threw": true },
    "parentInternals": { "error": "SecurityError: Sandbox access violation: Blocked a frame at \"connect-plugin://isolation-probe\" from accessing a cross-origin frame.  The frame requesting access is sandboxed and lacks the \"allow-same-origin\" flag.", "threw": true },
    "postMessageFallback": { "withAppOrigin": "allowed", "withoutOrigin": "refused: Only Connect's own page can do this." },
    "sessionStorage": { "error": "SecurityError: The operation is insecure.", "threw": true },
    "tauriGlobal": "undefined",
    "topLocation": { "error": "SecurityError: Sandbox access violation: Blocked a frame at \"connect-plugin://isolation-probe\" from accessing a cross-origin frame.  The frame requesting access is sandboxed and lacks the \"allow-same-origin\" flag.", "threw": true },
    "windowIpc": "undefined"
  },
  "parentBlocked": true,
  "pass": true,
  "pid": 46506,
  "probeRunId": "2afebd6a-8983-4b2b-a720-39d9f997b726",
  "reportedAt": "2026-11-17T12:13:37.795424+00:00",
  "runId": "2afebd6a-8983-4b2b-a720-39d9f997b726",
  "startedAt": "2026-11-17T12:13:34.186613+00:00",
  "tauriGlobal": false,
  "version": "2.1.1"
}
```

### Conditions of this gate for Task 23 (verbatim from the review)

- the shim refuses to run plugin code unless `window.parent !== window`;
- the main window accepts messages only from known frame `contentWindow`s with `event.origin === 'null'` and a strict schema (prefer a per-frame MessageChannel, reset on every iframe `load`);
- the plugin id is bound to the frame element, never taken from the message;
- nothing derived from the invoke key or `__TAURI_INTERNALS__` is ever sent to a frame;
- `go` limited to internal routes;
- never add `allow-same-origin`, `allow-top-navigation*`, `allow-popups`, `allow-forms`;
- `plugins_request`/`plugin_call` call `require_main_frame`.

The probe (`ui/plugins/frame/probe.js`) and `CODEMIE_PLUGIN_SMOKE=isolation` must stay runnable, so this gate can be re-run after Task 23.

## 2026-11-17 — Plugin frame isolation, re-run after Task 23 (frame shim and bridge): PASS

**Build:** debug, `cargo build` in `src-tauri/` with the Task 23–24 UI embedded (`frame.html` now
also loads `echo-compat.css`, the vendored graph libraries and the shim `frame.js`, which does
nothing in the probe's `?probe=1` frame). Run outside the agent sandbox, on a temporary workspace:

```sh
CODEMIE_WORKSPACE_TEST_DIR="$(mktemp -d)/workspace" CODEMIE_PLUGIN_SMOKE=isolation ./target/debug/app   # exit 0
```

- **Run id:** `a8137c38-a21e-4f50-bfd5-0661bd6fc5fc`, pid 92575, version 2.1.1.
- **Started / reported:** `2026-11-17T20:55:01.913729+00:00` / `2026-11-17T20:55:05.668323+00:00`.
- All seven gate fields hold, `failed` is empty, `probeRunId` equals `runId`; the escapes, the
  postMessage fallback and the navigation guard read as in the previous run.
- A stale `/tmp/com_epam_codemie_installer_si.sock` (no process held it, no Connect was running)
  made the first attempt exit 3 as designed; it was removed and the smoke run again.

How Task 23 keeps the gate's conditions (see `ui/plugins/host.js`, `ui/plugins/frame/shim.js`,
`ui/plugins/frame/messages.js`; covered by `ui/test/plugin-bridge.test.mjs` and the browser E2E):

- `startFrame` refuses to run plugin code unless `window.parent !== window`
  (`the shim refuses to run plugin code outside a frame`).
- The window has no `message` listener for frames. On every `load` of a frame it makes a new
  `MessageChannel`, closes the previous one, and hands the port to that frame's `contentWindow`
  only. The shim takes the port only from `event.source === window.parent`, once per load.
  Every message is checked against a strict schema (exact fields, types and sizes) on both sides.
- The plugin id is bound to the frame when it is made; `plugin_call` and `plugins_request` go out
  with that id, never one from a message (a message with any extra field is dropped).
- A frame is sent only its plugin's own facts, `{name, version, engine}`, the theme, where the
  window is, its own stored values and command answers (errors as `{code, message}` only).
- `go` reaches internal routes only (`internalRoute`), and only from the frame on screen or right
  after the window ran its palette entry.
- Frames are `<iframe sandbox="allow-scripts">` with a `src` on `connect-plugin://<id>/`; no
  `srcdoc`, no other sandbox flag.

`$TMPDIR/connect-plugin-isolation.json`:

```json
{
  "failed": [],
  "forgedIpcReachedRust": false,
  "internals": false,
  "invokeRejected": true,
  "ipcFetchRejected": true,
  "localStorageThrows": true,
  "moduleImportWorks": true,
  "observed": {
    "cookie": {
      "threw": false,
      "value": ""
    },
    "escapes": {
      "formTargetTop": {
        "threw": false,
        "value": "submit() returned"
      },
      "topNavigation": {
        "error": "SecurityError: The operation is insecure.",
        "threw": true
      },
      "windowOpen": {
        "threw": false,
        "value": "null"
      }
    },
    "forgedPostMessage": {
      "threw": false,
      "value": "sent"
    },
    "frameSandbox": "allow-scripts",
    "frameSrc": "connect-plugin://isolation-probe/__host/frame.html?probe=1&run=a8137c38-a21e-4f50-bfd5-0661bd6fc5fc",
    "href": "connect-plugin://isolation-probe/__host/frame.html?probe=1&run=a8137c38-a21e-4f50-bfd5-0661bd6fc5fc",
    "internals": "undefined",
    "internalsInvoke": "undefined",
    "ipcFetch": {
      "error": "TypeError: Load failed",
      "rejected": true
    },
    "ipcFetchWindows": {
      "error": "TypeError: Load failed",
      "rejected": true
    },
    "isSecureContext": true,
    "localStorage": {
      "error": "SecurityError: The operation is insecure.",
      "threw": true
    },
    "mainFrameLocationOrigin": "tauri://localhost",
    "mainFrameStorageStatus": "allowed",
    "mainFrameWorkspaceSnapshot": "allowed",
    "mainPageStayed": true,
    "messageOrigin": "null",
    "moduleImport": {
      "marker": "module-import-ok",
      "ok": true
    },
    "nonShimDocumentRefused": true,
    "origin": "null",
    "parentDocument": {
      "error": "SecurityError: Sandbox access violation: Blocked a frame at \"connect-plugin://isolation-probe\" from accessing a cross-origin frame.  The frame requesting access is sandboxed and lacks the \"allow-same-origin\" flag.",
      "threw": true
    },
    "parentInternals": {
      "error": "SecurityError: Sandbox access violation: Blocked a frame at \"connect-plugin://isolation-probe\" from accessing a cross-origin frame.  The frame requesting access is sandboxed and lacks the \"allow-same-origin\" flag.",
      "threw": true
    },
    "postMessageFallback": {
      "withAppOrigin": "allowed",
      "withoutOrigin": "refused: Only Connect's own page can do this."
    },
    "sessionStorage": {
      "error": "SecurityError: The operation is insecure.",
      "threw": true
    },
    "tauriGlobal": "undefined",
    "topLocation": {
      "error": "SecurityError: Sandbox access violation: Blocked a frame at \"connect-plugin://isolation-probe\" from accessing a cross-origin frame.  The frame requesting access is sandboxed and lacks the \"allow-same-origin\" flag.",
      "threw": true
    },
    "windowIpc": "undefined"
  },
  "parentBlocked": true,
  "pass": true,
  "pid": 92575,
  "probeRunId": "a8137c38-a21e-4f50-bfd5-0661bd6fc5fc",
  "reportedAt": "2026-11-17T20:55:05.668323+00:00",
  "runId": "a8137c38-a21e-4f50-bfd5-0661bd6fc5fc",
  "startedAt": "2026-11-17T20:55:01.913729+00:00",
  "tauriGlobal": false,
  "version": "2.1.1"
}
```

## 2026-11-17 — Published plugins in the native app (Task 25 marketplace smoke): PASS

**Build:** debug, `cargo build` in `src-tauri/` with the Task 25 code (WKWebView, macOS). Run outside the agent
sandbox. The smoke makes its own fresh data root under `$TMPDIR` (never the owner's data folder, and the
`location.json` pointer goes there too), so no `CODEMIE_WORKSPACE_TEST_DIR` is needed:

```sh
CODEMIE_PLUGIN_SMOKE=/Users/Vadym_Vlasenko/AI/projects/other/echo-plugins ./target/debug/app   # exit 0
```

What it does (`src-tauri/src/commands/plugin_smoke.rs`, `ui/plugins/market-smoke.js`):

1. At start (debug builds only; exit 3 otherwise, or when the folder has no `echo-marketplace.json`) it deletes the
   previous report, refuses to run beside another Connect (the single-instance socket, as the isolation smoke), and
   makes `$TMPDIR/connect-plugin-smoke-<run id>/workspace`, which the app opens instead of the user's own.
2. The app boots as usual. The window adds the folder as a marketplace and installs every plugin it offers, agreeing
   to each permission sheet by its `sheetHash` (only in this env-gated mode).
3. It waits for the plugin manager (each plugin loaded, or why not), reloads the installed list so the frames are
   made, then opens each plugin's pages, Settings sections and card through the app's own routes, 2.5 s each.
4. It records what each frame reported through the bridge (its page errors: uncaught errors, unhandled rejections,
   CSP refusals, render failures), whether the frame was shown over its slot, and every host-half command the frame
   asked for and how it went.
5. Rust adds the manager's view (`loaded`, `problems`), decides, writes `$TMPDIR/connect-plugin-smoke.json`, prints
   `PLUGIN_SMOKE {…}` and quits: 0 pass, 1 fail, 2 if the window never reported (300 s watchdog), 3 can't run.
   Telegram's sessions error is the one known failure (ruling R39); any other load error, page error, failed
   command, frame not shown or page that didn't start fails the run.

No routine was run (no live Claude) and nothing reached GitHub or Telegram: GitHub has no sign-in in a fresh data
root, and Telegram doesn't load.

- **Run id:** `fd8017fb-e9fc-4af8-a45a-4561aa571f19`, pid 99273, version 2.1.1, exit 0 (the final code of Task 25).
- **Started / reported:** `2026-11-17T21:48:30.779862+00:00` / `2026-11-17T21:49:37.736706+00:00`.
- An earlier run, `ed027317-9a72-428b-b0bf-89713ae0904b` (one line of `prelude.js` before the final code), had the
  same findings field for field.
- **Loaded:** github, obsidian, scheduler. **Known failure:** telegram, "needs plugin change: sessions API".

| Plugin | Install | Host half | Frame | Pages opened (shown · ready · page errors · commands) | Verdict |
|---|---|---|---|---|---|
| Scheduler 0.4.0 | installed | loaded | ready, 0 errors, `view` ok | section `main` ✓ · ✓ · 0 · —; card ✓ · ✓ · 0 · — | pass |
| GitHub 0.3.0 | installed | loaded | ready, 0 errors | section `main` ✓ · ✓ · 0 · `status` ok | pass |
| Obsidian 0.8.0 | installed | loaded | ready, 0 errors, `knowledge_wake` ok | activity `vaults` ✓ · ✓ · 0 · `view` ok; section `main` ✓ · ✓ · 0 · `view` ok; card ✓ · ✓ · 0 · — | pass |
| Telegram 0.4.0 | installed | didn't load: `unsupported: CodeMie Connect doesn't have ctx.sessions (only Echo has it), so this plugin needs a change to run here: cannot read property 'clearChannel' of undefined` | none (no frame for a plugin whose host half didn't load) | — | known failure |

The first real plugin pages ran in the native frame here (the module import from `connect-plugin://<id>/client.js`,
the MessagePort handshake into the opaque frame, `echo-compat.css`, GeistMono and the vendored graph libraries under
the frame CSP): no CSP refusal and no page error in any of them, so nothing on Connect's side needed fixing for the
frame shim. Obsidian's graph view itself needs a connected vault, which the smoke can't pick (a native dialog).

**Negative checks (same build):**

- A temp copy of the marketplace whose Scheduler `client.js` ends with an unhandled rejection: run
  `e3d62438-ba54-4dbf-b4e6-e85503adec83`, **exit 1**, `failed: ["scheduler: page error: Unhandled rejection: smoke
  negative check"]`, Telegram still the known failure. The published folder was never changed.
- A folder that isn't a marketplace (`…/echo-plugins/plugins`): **exit 3**, `CODEMIE_PLUGIN_SMOKE: … isn't a plugin
  marketplace folder (no echo-marketplace.json); give 'isolation' or a marketplace folder`.
- The isolation gate after these changes (`CODEMIE_PLUGIN_SMOKE=isolation`, temp workspace): run
  `cfb3b80e-940b-4f15-b051-a16ec8b2338f`, PASS, exit 0, `failed: []`, `probeRunId` equals `runId`.

The app removed its single-instance socket after each run. `$TMPDIR/connect-plugin-smoke.json` of the passing run,
trimmed to the window's findings and the verdict:

```json
{
  "runId": "fd8017fb-e9fc-4af8-a45a-4561aa571f19",
  "windowRunId": "fd8017fb-e9fc-4af8-a45a-4561aa571f19",
  "pass": true,
  "failed": [],
  "knownFailures": [
    {
      "id": "telegram",
      "why": "needs plugin change: sessions API",
      "problem": "unsupported: CodeMie Connect doesn't have ctx.sessions (only Echo has it), so this plugin needs a change to run here: cannot read property 'clearChannel' of undefined"
    }
  ],
  "loaded": ["github", "obsidian", "scheduler"],
  "market": { "name": "onetest-2", "source": "/Users/Vadym_Vlasenko/AI/projects/other/echo-plugins" },
  "plugins": [
    { "id": "scheduler", "version": "0.4.0", "install": "installed", "loadError": null,
      "frame": { "ready": true, "error": "", "errors": [], "calls": [{ "command": "view", "ok": true, "error": "" }] },
      "views": [
        { "view": "section", "id": "main", "hash": "#/settings/plugins/scheduler/main", "shown": true, "ready": true, "errors": [], "calls": [] },
        { "view": "card", "id": "", "hash": "#/settings/plugins/scheduler", "shown": true, "ready": true, "errors": [], "calls": [] }
      ] },
    { "id": "telegram", "version": "0.4.0", "install": "installed",
      "loadError": "unsupported: CodeMie Connect doesn't have ctx.sessions (only Echo has it), so this plugin needs a change to run here: cannot read property 'clearChannel' of undefined",
      "frame": null, "views": [] },
    { "id": "obsidian", "version": "0.8.0", "install": "installed", "loadError": null,
      "frame": { "ready": true, "error": "", "errors": [], "calls": [{ "command": "knowledge_wake", "ok": true, "error": "" }] },
      "views": [
        { "view": "activity", "id": "vaults", "hash": "#/p/obsidian/vaults", "shown": true, "ready": true, "errors": [], "calls": [{ "command": "view", "ok": true, "error": "" }] },
        { "view": "section", "id": "main", "hash": "#/settings/plugins/obsidian/main", "shown": true, "ready": true, "errors": [], "calls": [{ "command": "view", "ok": true, "error": "" }] },
        { "view": "card", "id": "", "hash": "#/settings/plugins/obsidian", "shown": true, "ready": true, "errors": [], "calls": [] }
      ] },
    { "id": "github", "version": "0.3.0", "install": "installed", "loadError": null,
      "frame": { "ready": true, "error": "", "errors": [], "calls": [] },
      "views": [
        { "view": "section", "id": "main", "hash": "#/settings/plugins/github/main", "shown": true, "ready": true, "errors": [], "calls": [{ "command": "status", "ok": true, "error": "" }] }
      ] }
  ],
  "verdicts": {
    "github": { "status": "pass", "why": [] },
    "obsidian": { "status": "pass", "why": [] },
    "scheduler": { "status": "pass", "why": [] },
    "telegram": { "status": "known-failure", "why": ["needs plugin change: sessions API"] }
  }
}
```

The plugin-by-plugin matrix and the conformance tests are in [PLUGIN-CONFORMANCE.md](PLUGIN-CONFORMANCE.md).

## 2026-11-18: Gates (Task 26)

Branch `feat/milestone-1-workspace`, run after the UI polish commit (`fix: polish Today, Inbox and Claude settings copy`).

| Gate | Command | Result |
|---|---|---|
| Format | `cd src-tauri && cargo fmt --check` | clean |
| Lint | `cd src-tauri && cargo clippy -- -D warnings` | no issues |
| Rust tests | `cd src-tauri && cargo test` | 517 passed, 2 ignored (the live Claude runs), 5 suites; includes `tests/echo_plugins.rs` against the published plugins |
| JS tests | `npm test` | 672 tests: 669 passed, 0 failed, 3 skipped |
| Browser E2E | `PLAYWRIGHT_CORE=… node ui/test/browser/workspace-e2e.mjs` | 183/183 checks passed, both themes at 1000, 1440 and 1680 px (screenshots in `output/playwright/workspace-e2e/`) |
| Installer build | `./build-installer.sh --skip-stage` | passes (exit 0) |

Native smokes recorded earlier in this file still stand: plugin frame isolation (PASS, re-run after Tasks 17, 20 and 23) and the published plugins in the native app (PASS; Telegram an expected, named failure).

## 2026-11-18: Final review fix wave (gates and native smokes)

Branch `feat/milestone-1-workspace`, the commit `fix: address the Milestone 2 final review`: Teams sender rules
take names (A-I1), the recovery choices work after the data folder breaks mid-run (B-I1), no plugin frame over
the recovery page (B-I2), a plugin's first call waits for the reload that loads it (C-I1), links in plugin pages
open after Connect's own confirmation (C-I2, ruling R41), and Today's "Day at a glance" tile uses the header's
clock ("Until 06:00 PM").

| Gate | Command | Result |
|---|---|---|
| Format | `cd src-tauri && cargo fmt --check` | clean |
| Lint | `cd src-tauri && cargo clippy -- -D warnings` | no issues |
| Rust tests | `cd src-tauri && cargo test` | 523 passed, 2 ignored (the live Claude runs), 5 suites |
| JS tests | `npm test` | 679 tests: 676 passed, 0 failed, 3 skipped |
| Browser E2E | `PLAYWRIGHT_CORE=… node ui/test/browser/workspace-e2e.mjs` | 193/193 checks passed, both themes at 1000, 1440 and 1680 px |

The E2E's "Day at a glance text is cut" check now measures in the page's own font and to the subpixel (with the
ellipsis off while measuring). The old check missed "Free to 06:00 PM", which overflowed its 102.33 px box by
0.08 px at 1440 px.

### Published plugins in the native app, frames made before the manager loads them: PASS

The marketplace smoke now reads the installed list right after each install, as Settings does, so the host
makes each plugin's frame while the manager is still loading it (Claude CLI detection runs first). Each plugin's
`framedBeforeLoad` is recorded. A run where no frame was made before its plugin loaded fails, because it didn't
test the case. A command refused with "isn't on in Connect" fails the run like any failed command.

```sh
CODEMIE_PLUGIN_SMOKE=/Users/Vadym_Vlasenko/AI/projects/other/echo-plugins ./target/debug/app   # exit 0
```

- **Run id:** `e0c27300-60ba-4628-b81b-5c7595d10626`, pid 98619, version 2.1.1, exit 0 (the final build).
- **Started / reported:** `2026-11-17T23:24:37.282942+00:00` / `2026-11-17T23:25:15.041354+00:00`.
- **Framed before load:** scheduler, telegram, obsidian. GitHub's frame came after it loaded in this run; in
  the earlier run `d2aa7511-9c93-465e-a945-b5f257e9a000` (same source), all four were framed early and all
  passed.
- **Loaded:** github, obsidian, scheduler. **Known failure:** telegram (sessions API, ruling R39).

| Plugin | Framed before load | Frame's first calls | Pages opened (shown · ready · page errors · commands) | Verdict |
|---|---|---|---|---|
| Scheduler 0.4.0 | yes | `view` ok | section `main` ✓ · ✓ · 0 · —; card ✓ · ✓ · 0 · — | pass |
| Obsidian 0.8.0 | yes | `knowledge_wake` ok | activity `vaults` ✓ · ✓ · 0 · `view` ok; section `main` ✓ · ✓ · 0 · `view` ok; card ✓ · ✓ · 0 · — | pass |
| GitHub 0.3.0 | no (loaded first) | — | section `main` ✓ · ✓ · 0 · `status` ok | pass |
| Telegram 0.4.0 | yes | — (its frame goes once its load error is known) | — | known failure |

**Negative check (C-I1 put back):** the same build with the manager's wait set to zero (`LOAD_WAIT =
Duration::ZERO`, reverted at once): run `89ac7df6-5f8b-4908-b4d6-93902ec11e87`, **exit 1**,
`failed: ["scheduler: its command “view” failed: “scheduler” isn't on in Connect"]`. That is the failure the
review describes, and the smoke catches it.

### Plugin frame isolation after the shim's link handling: PASS

```sh
CODEMIE_WORKSPACE_TEST_DIR="$(mktemp -d)/workspace" CODEMIE_PLUGIN_SMOKE=isolation ./target/debug/app   # exit 0
```

- **Run id:** `9818dc33-8cca-4634-b828-11f08e268c54`, pid 99860.
- **Started / reported:** `2026-11-17T23:25:24.646188+00:00` / `2026-11-17T23:25:28.363282+00:00`.
- All seven gate fields hold (`tauriGlobal` false, `internals` false, `ipcFetchRejected`, `invokeRejected`,
  `parentBlocked`, `moduleImportWorks`, `localStorageThrows` true), `failed` is empty and `probeRunId` equals
  `runId`.
- Escapes are unchanged: `top.location` throws, `window.open` gives `null`, a `target=_top` form doesn't
  navigate, `mainPageStayed: true`. The frame is still `sandbox="allow-scripts"` only.
- Links (ruling R41) add no sandbox flag. The frame's click and `window.open` become an `open` message, and the
  main window opens the address only after its own confirmation.

No single-instance socket was left after the runs, and no live Claude prompt was sent. Nothing reached the
network: the marketplace is a local folder, GitHub has no sign-in in a fresh data root, and no link was opened.

## Live checks (owner present): not done yet

These need the owner at the Mac with a real Claude sign-in and real Microsoft data. They are read-only or reversible; nothing is sent. The controller fills in the results.

| # | Check | Result |
|---|---|---|
| 1 | Claude page states: profile list, default and per-purpose routes, usage, Test on each ready profile, and the no-Claude state | not done |
| 2 | One AI draft on a real conversation (not sent): the box fills, Regenerate works, nothing leaves the Mac | not done |
| 3 | One summary of a real thread, with its asks | not done |
| 4 | One Morning brief run: the card on Today and the Run log entry | not done |
| 5 | Data folder move to a temp folder and back: the check page, the restart, the data intact, the old copy, then Use the default folder | not done |
| 6 | Install the four plugins from the local marketplace and open each (Scheduler, GitHub, Obsidian; Telegram is expected to say it needs a plugin change) | not done |

Open gates: none in code. Other open items are in [README.md](README.md), Known limits.
