// CODEMIE_PLUGIN_SMOKE=isolation (DESIGN 7.3), smoke only. Opens the isolation probe in a
// sandboxed plugin frame exactly as plugin UIs will be opened, adds what the main window sees,
// has Rust write $TMPDIR/connect-plugin-isolation.json with the verdict, prints it and quits.
import { pluginUrl } from './frame-url.js';

const PROBE_ID = 'isolation-probe';
const REPORT_TIMEOUT_MS = 15000;
const NAVIGATION_SETTLE_MS = 1500;

export async function runIsolationSmoke(invoke, { runId, doc = document } = {}) {
  let report;
  try {
    report = await probe(invoke, doc, runId);
  } catch (e) {
    report = { error: String((e && e.message) || e) };
  }
  let result;
  try {
    result = await invoke('smoke_plugin_report', { report });
  } catch (e) {
    result = { error: String((e && e.message) || e) };
  }
  await invoke('smoke_emit', { line: `PLUGIN_ISOLATION ${JSON.stringify({ ...result, report })}` });
  await invoke('close_app');
}

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function probe(invoke, doc, runId) {
  const startPage = location.href;
  const frame = doc.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.src = pluginUrl(PROBE_ID, `__host/frame.html?probe=1&run=${encodeURIComponent(runId || '')}`);
  const reported = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the probe frame did not report')), REPORT_TIMEOUT_MS);
    window.addEventListener('message', function onMessage(event) {
      if (event.source !== frame.contentWindow || event.data?.kind !== 'connect-plugin-isolation') return;
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
      resolve(event);
    });
  });
  doc.body.append(frame);
  const event = await reported;
  const report = { ...event.data.report };
  // The probe tried to take the main window to the shim page; it must still be on Connect's.
  await settle(NAVIGATION_SETTLE_MS);
  report.observed = {
    ...report.observed,
    frameSrc: frame.src,
    frameSandbox: frame.getAttribute('sandbox'),
    messageOrigin: event.origin,
    mainPageStayed: location.href === startPage,
    mainFrameLocationOrigin: location.origin,
    // Connect's own page still gets through the caller checks on guarded commands.
    mainFrameStorageStatus: await mainFrameCall(invoke, 'storage_status'),
    mainFrameWorkspaceSnapshot: await mainFrameCall(invoke, 'workspace_request', { request: { op: 'snapshot' } }),
    nonShimDocumentRefused: await nonShimDocumentRefused(doc),
    // Last, because it switches this page to Tauri's postMessage IPC for good.
    postMessageFallback: await postMessageFallback(invoke),
  };
  return report;
}

function mainFrameCall(invoke, cmd, args) {
  return invoke(cmd, args).then(() => 'allowed', (e) => `refused: ${e?.message || e}`);
}

// The navigation guard lets a frame open only the shim page. A plugin file opened as a document is
// refused, and the frame stays on its initial about:blank, which the main window can read.
async function nonShimDocumentRefused(doc) {
  const frame = doc.createElement('iframe');
  frame.src = pluginUrl(PROBE_ID, '__host/probe-import.js');
  doc.body.append(frame);
  await settle(NAVIGATION_SETTLE_MS);
  let url;
  try {
    url = frame.contentDocument ? frame.contentDocument.URL : 'cross-origin';
  } catch {
    url = 'cross-origin';
  }
  frame.remove();
  return url === 'about:blank';
}

// Makes Tauri's ipc: fetch fail once, as a blocked custom protocol would, so Tauri switches to
// postMessage. There the browser sets no Origin: Connect's invoke still gets through because it
// sends the page origin, and a bare call without one is refused.
async function postMessageFallback(invoke) {
  const realFetch = window.fetch;
  window.fetch = (input, init) =>
    String(input?.url || input).startsWith('ipc:')
      ? Promise.reject(new TypeError('ipc: blocked for the fallback check'))
      : realFetch(input, init);
  try {
    return {
      withAppOrigin: await mainFrameCall(invoke, 'storage_status'),
      withoutOrigin: await mainFrameCall(window.__TAURI__.core.invoke, 'storage_status'),
    };
  } finally {
    window.fetch = realFetch;
  }
}
