// Isolation probe (smoke only, CODEMIE_PLUGIN_SMOKE=isolation; DESIGN 7.3). It runs where plugin
// code will run, in a sandboxed connect-plugin frame, tries everything plugin code must not be
// able to do, and reports what it saw to the main window, echoing the run id it was opened with.
// Outside a frame opened with ?probe=1 it does nothing. Keep it: the gate must stay re-runnable.

// The start of the line a forged call would print through smoke_emit; Rust watches for it.
const FORGED = 'PLUGIN_FRAME_FORGED_IPC';
const GUESSED_KEY = 'forged-by-plugin-frame';

const params = new URLSearchParams(location.search);
if (window.parent !== window && params.get('probe') === '1') {
  const runId = params.get('run');
  run().then(
    (report) => parent.postMessage({ kind: 'connect-plugin-isolation', report: { runId, ...report } }, '*'),
    (e) => parent.postMessage({ kind: 'connect-plugin-isolation', report: { runId, error: describeError(e) } }, '*'),
  );
}

function describeError(e) {
  return `${(e && e.name) || 'Error'}: ${(e && e.message) || e}`;
}

function describe(value) {
  try {
    return typeof value === 'object' && value !== null ? Object.prototype.toString.call(value) : String(value);
  } catch (e) {
    return `unprintable (${describeError(e)})`;
  }
}

// Runs one access and records whether it threw and what it returned.
function attempt(fn) {
  try {
    return { threw: false, value: describe(fn()) };
  } catch (e) {
    return { threw: true, error: describeError(e) };
  }
}

// A command call over the custom-protocol IPC, shaped like Tauri's own, with a guessed key.
async function forgeFetch(url) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Tauri-Callback': '1',
        'Tauri-Error': '2',
        'Tauri-Invoke-Key': GUESSED_KEY,
      },
      body: JSON.stringify({ line: `${FORGED} fetch ${url}` }),
    });
    const tauriResponse = res.headers.get('Tauri-Response');
    const body = (await res.text()).slice(0, 200);
    return { rejected: !(res.ok && tauriResponse === 'ok'), status: res.status, tauriResponse, body };
  } catch (e) {
    return { rejected: true, error: describeError(e) };
  }
}

// Ways out of the frame the sandbox must close. Each aims the main window at the shim page, which
// the navigation guard would allow, so only the sandbox stands in the way. If one worked, the main
// window would leave Connect's page and the smoke would never write its report.
function escapes() {
  const shim = location.href;
  return {
    topNavigation: attempt(() => {
      top.location.href = shim;
      return 'assigned';
    }),
    windowOpen: attempt(() => window.open(shim)),
    formTargetTop: attempt(() => {
      const form = document.createElement('form');
      form.method = 'get';
      form.action = shim;
      form.target = '_top';
      document.body.append(form);
      form.submit();
      return 'submit() returned';
    }),
  };
}

// The same call through the native message handler, with a forged Origin header as well: only
// Tauri's invoke key (which frames never get) stands in the way on this path.
function forgePostMessage() {
  const handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.ipc;
  if (!handler) return { sent: false, reason: 'no native ipc handler in this frame' };
  return attempt(() => {
    handler.postMessage(JSON.stringify({
      cmd: 'smoke_emit',
      callback: 1,
      error: 2,
      payload: { line: `${FORGED} postMessage` },
      options: { headers: { Origin: 'tauri://localhost' } },
      __TAURI_INVOKE_KEY__: GUESSED_KEY,
    }));
    return 'sent';
  });
}

async function run() {
  const observed = {
    href: location.href,
    origin: self.origin,
    isSecureContext: self.isSecureContext,
    tauriGlobal: typeof window.__TAURI__,
    internals: typeof window.__TAURI_INTERNALS__,
    internalsInvoke: typeof (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke),
    windowIpc: typeof window.ipc,
  };
  observed.forgedPostMessage = forgePostMessage();
  observed.ipcFetch = await forgeFetch('ipc://localhost/smoke_emit');
  observed.ipcFetchWindows = await forgeFetch('http://ipc.localhost/smoke_emit');
  observed.parentDocument = attempt(() => parent.document);
  observed.parentInternals = attempt(() => parent.__TAURI_INTERNALS__);
  observed.topLocation = attempt(() => top.location.href);
  observed.moduleImport = await import('./probe-import.js').then(
    (m) => ({ ok: m.marker === 'module-import-ok', marker: m.marker }),
    (e) => ({ ok: false, error: describeError(e) }),
  );
  observed.localStorage = attempt(() => window.localStorage.length);
  observed.sessionStorage = attempt(() => window.sessionStorage.length);
  observed.cookie = attempt(() => document.cookie);
  observed.escapes = escapes();

  return {
    tauriGlobal: observed.tauriGlobal !== 'undefined',
    internals: observed.internals !== 'undefined',
    ipcFetchRejected: observed.ipcFetch.rejected && observed.ipcFetchWindows.rejected,
    // The frame has nothing to invoke with; Rust adds whether the forged calls reached a command.
    invokeRejected: observed.internalsInvoke === 'undefined' && observed.windowIpc === 'undefined',
    parentBlocked: observed.parentDocument.threw && observed.parentInternals.threw,
    moduleImportWorks: observed.moduleImport.ok,
    localStorageThrows: observed.localStorage.threw,
    observed,
  };
}
