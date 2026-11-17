// `ctx.ui.graph` and `ctx.ui.newGraph` (PLUGIN-ENGINE.md §5): a graph view drawn by Sigma (WebGL)
// over a graphology graph, both vendored under vendor/ (MIT, see vendor/README.md). One view per
// box (an element with an id). A graph is built and laid out once per data key and kept, so a
// render that replaces the box draws the same graph again where the camera was.
export function createGraphs(win, doc) {
  /** box id → {key, box, graph, sigma, opts, match, near, hover, sel} */
  const live = new Map();
  /** data key → a laid-out graph (the last few) */
  const built = new Map();
  const css = (name, fallback) => (win.getComputedStyle(doc.documentElement).getPropertyValue(name) || '').trim() || fallback;

  function layout(graph) {
    const lib = win.graphologyLibrary;
    const fa2 = lib && lib.layoutForceAtlas2;
    if (!fa2 || !graph.order) return;
    const big = graph.order > 400;
    fa2.assign(graph, {
      iterations: graph.order > 2000 ? 60 : big ? 120 : 220,
      settings: { ...fa2.inferSettings(graph), barnesHutOptimize: big, gravity: 1, scalingRatio: big ? 6 : 10, slowDown: 2 },
    });
    if (lib.layoutNoverlap) lib.layoutNoverlap.assign(graph, { maxIterations: 60, settings: { margin: 4, ratio: 1.2 } });
  }

  function neighbourhood(graph, keys) {
    const out = new Set();
    for (const k of keys) {
      out.add(k);
      for (const n of graph.neighbors(k)) out.add(n);
    }
    return out;
  }

  /** Draws `box` from `build()` (a graphology graph whose nodes carry x, y, size, color, label and
   *  `pinLabel`); `opts.click(node, attributes)` runs on a click. The same key keeps the graph. */
  function draw(box, key, build, opts = {}) {
    if (!box || !box.id || typeof win.Sigma !== 'function' || !win.graphology) return null;
    const was = live.get(box.id);
    if (was && was.key === key && was.box === box && box.querySelector('canvas')) return was;
    const camera = was && was.key === key ? was.sigma.getCamera().getState() : null;
    if (was) {
      try { was.sigma.kill(); } catch { /* its box is gone */ }
      live.delete(box.id);
    }
    let graph = built.get(key);
    if (!graph) {
      graph = build();
      layout(graph);
      built.set(key, graph);
      if (built.size > 6) built.delete(built.keys().next().value);
    }
    box.innerHTML = '';
    box.setAttribute('data-cx-graph', '');
    const dark = doc.documentElement.classList.contains('dark');
    const dim = dark ? '#2f3033' : '#e6e6e6';
    const text = css('--text', dark ? '#ffffff' : '#333333');
    const muted = css('--text-3', '#8a8a8a');
    const v = { key, box, graph, opts, match: was && was.key === key ? was.match : null, near: was && was.key === key ? was.near : null, hover: null, sel: null };
    const backdrop = dark
      ? { backdropColor: '#2e3033', backdropBorderColor: '#47484a', backdropBorderWidth: 1 }
      : { backdropColor: '#ffffff', backdropBorderColor: '#e5e5e5', backdropBorderWidth: 1 };
    v.sigma = new win.Sigma(graph, box, {
      settings: {
        labelDensity: 0.08, labelGridCellSize: 120, labelRenderedSizeThreshold: 7, zIndex: true,
        minCameraRatio: 0.02, maxCameraRatio: 4, stagePadding: 24, labelSize: 11, labelColor: { color: muted },
        labelFont: win.getComputedStyle(doc.body).fontFamily, hideEdgesOnMove: graph.size > 3000,
      },
      nodeReducer: (node, data) => {
        const hovered = v.hover && neighbourhood(graph, [v.hover]);
        const out = { ...data, ...backdrop, labelColor: data.pinLabel ? text : muted };
        const off = (v.near && !v.near.has(node)) || (hovered && !hovered.has(node));
        if (off) return { ...out, color: dim, label: null, zIndex: 0 };
        if ((v.match && v.match.has(node)) || node === v.sel || node === v.hover) {
          return { ...out, highlighted: true, forceLabel: true, labelColor: text, zIndex: 3 };
        }
        if (data.pinLabel) return { ...out, forceLabel: true, zIndex: 1 };
        return out;
      },
      edgeReducer: (edge, data) => {
        const [a, b] = graph.extremities(edge);
        const hovered = v.hover && neighbourhood(graph, [v.hover]);
        const on = n => (!v.near || v.near.has(n)) && (!hovered || hovered.has(n));
        if (!on(a) || !on(b)) return { ...data, hidden: true };
        if ((v.hover && (a === v.hover || b === v.hover)) || (v.sel && (a === v.sel || b === v.sel))) {
          return { ...data, color: css('--accent', '#4f9cf9'), size: Math.max(data.size || 1, 1.5), zIndex: 2 };
        }
        return data;
      },
    });
    v.sigma.on('enterNode', ({ node }) => { v.hover = node; box.style.cursor = 'pointer'; v.sigma.refresh({ skipIndexation: true }); });
    v.sigma.on('leaveNode', () => { v.hover = null; box.style.cursor = ''; v.sigma.refresh({ skipIndexation: true }); });
    v.sigma.on('clickNode', ({ node }) => { if (typeof opts.click === 'function') opts.click(node, graph.getNodeAttributes(node)); });
    if (camera) v.sigma.getCamera().setState(camera);
    live.set(box.id, v);
    return v;
  }

  function fly(v, keys) {
    const camera = v.sigma.getCamera();
    const points = [...(keys || [])].map(k => v.sigma.getNodeDisplayData(k)).filter(Boolean);
    if (!points.length) return camera.animate({ x: 0.5, y: 0.5, ratio: 1, angle: 0 }, { duration: 400 });
    const xs = points.map(p => p.x);
    const ys = points.map(p => p.y);
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    return camera.animate({ x: (Math.max(...xs) + Math.min(...xs)) / 2, y: (Math.max(...ys) + Math.min(...ys)) / 2, ratio: Math.min(1, Math.max(0.08, span * 1.4)) }, { duration: 500 });
  }

  /** Lights these nodes and their neighbours (null: all), dims the rest and flies to them;
   *  answers how many matched. */
  function focus(id, keys) {
    const v = live.get(id);
    if (!v) return 0;
    const match = keys ? new Set([...keys].filter(k => v.graph.hasNode(k))) : null;
    v.match = match && match.size ? match : null;
    v.near = v.match ? neighbourhood(v.graph, v.match) : null;
    v.sigma.refresh({ skipIndexation: true });
    fly(v, v.match);
    return v.match ? v.match.size : 0;
  }

  /** Marks one node as chosen (null: none). */
  function select(id, key) {
    const v = live.get(id);
    if (!v) return;
    v.sel = key && v.graph.hasNode(key) ? key : null;
    v.sigma.refresh({ skipIndexation: true });
  }

  /** The nodes whose label (or `search` attribute) has every word of `q`; null for no words. */
  function find(id, q) {
    const v = live.get(id);
    const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!v || !words.length) return null;
    const hits = new Set();
    v.graph.forEachNode((node, a) => {
      const hay = `${a.label || ''} ${a.search || ''}`.toLowerCase();
      if (words.every(w => hay.includes(w))) hits.add(node);
    });
    return hits;
  }

  function resize() {
    for (const v of live.values()) if (v.box.isConnected) v.sigma.resize();
  }

  /** The views go; the next draw makes them again (in the theme's colours). */
  function retheme() {
    for (const v of live.values()) {
      try { v.sigma.kill(); } catch { /* its box is gone */ }
      v.box.removeAttribute('data-cx-graph');
    }
    live.clear();
  }

  /** Every view and graph goes (the plugin unloads). */
  function killAll() {
    retheme();
    built.clear();
  }

  const newGraph = () => new win.graphology.Graph();
  return { api: { draw, focus, select, find, live, resize }, newGraph, retheme, killAll };
}
