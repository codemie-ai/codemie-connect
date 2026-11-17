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
