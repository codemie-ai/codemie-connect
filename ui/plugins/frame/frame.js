// A plugin frame's boot (DESIGN 7.3): served as connect-plugin://<id>/__host/frame.js into the
// plugin's sandboxed frame. It starts the shim (shim.js), which waits for Connect's window to hand
// it the frame's channel and then loads the plugin's client half. It does nothing outside a frame,
// and nothing in the isolation probe's frame (?probe=1, probe.js).
import { startFrame } from './shim.js';
import { createGraphs } from './graph.js';

const params = new URLSearchParams(location.search);
if (params.get('probe') !== '1') {
  const version = params.get('v') || '';
  const shim = startFrame({
    win: window,
    doc: document,
    importClient: path => import(new URL(`../${path}?v=${encodeURIComponent(version)}`, location.href).href),
    graphs: createGraphs,
  });
  if (shim) {
    const root = document.getElementById('cx-root');
    if (root && typeof ResizeObserver === 'function') new ResizeObserver(() => shim.reportHeight()).observe(root);
    window.addEventListener('resize', () => shim.resized());
  }
}
