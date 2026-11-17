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
