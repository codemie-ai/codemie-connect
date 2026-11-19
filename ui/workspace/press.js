// A press that may become a drag, for mouse, pen and touch: Today's widgets and gallery cards,
// and the page sections later. It listens on `window` (no pointer capture, so the page under the
// pointer still gets its events), starts after `threshold` px, or, for a finger or a pen, after
// `longPress` ms held still. Escape cancels, and the click that ends a drag is swallowed.
// Ported from the prototype's `P.drag` (prototypes/today-customize/proto-core.js).

const CURSORS = ['ws-drag-move', 'ws-drag-ew', 'ws-drag-ns', 'ws-drag-nwse'];

/** Swallows the click the browser sends right after a drag ends. */
function swallowClick(win) {
  const swallow = ev => {
    ev.stopPropagation();
    ev.preventDefault();
  };
  win.addEventListener('click', swallow, { capture: true, once: true });
  setTimeout(() => win.removeEventListener('click', swallow, { capture: true }), 60);
}

/**
 * Tracks the press `ev` (a pointerdown). `onStart(ev, {sx, sy})` runs when the drag starts, with
 * where the press began; `onMove(ev, {dx, dy})` and `onEnd(ev, {dx, dy})` get the distance from
 * there; `onCancel()` runs on Escape or a cancelled pointer. `cursor` (move, ew, ns, nwse) is
 * shown everywhere while dragging. A release point that differs from the last move counts as a
 * final move, since some pointers skip it.
 */
export function trackPress(ev, { threshold = 4, longPress = 0, cursor, onStart, onMove, onEnd, onCancel } = {}) {
  if (ev.pointerType === 'mouse' && ev.button !== 0) return;
  const doc = ev.target?.ownerDocument || document;
  const win = doc.defaultView || window;
  const sx = ev.clientX;
  const sy = ev.clientY;
  const held = ev.pointerType !== 'mouse' && longPress > 0;
  let started = false;
  let done = false;
  let last = ev;
  let timer = null;

  const begin = at => {
    started = true;
    doc.body.classList.add('ws-dragging');
    if (cursor) doc.body.classList.add(`ws-drag-${cursor}`);
    if (held) win.navigator?.vibrate?.(8);
    onStart?.(at, { sx, sy });
  };
  const cleanup = () => {
    done = true;
    clearTimeout(timer);
    win.removeEventListener('pointermove', move);
    win.removeEventListener('pointerup', up);
    win.removeEventListener('pointercancel', cancel);
    win.removeEventListener('keydown', key, true);
    doc.body.classList.remove('ws-dragging', ...CURSORS);
  };
  const delta = at => ({ dx: at.clientX - sx, dy: at.clientY - sy });
  function move(at) {
    if (done) return;
    last = at;
    if (!started) {
      const distance = Math.hypot(at.clientX - sx, at.clientY - sy);
      // Waiting for a long press: moving first means the finger scrolls instead.
      if (held) {
        if (distance > 10) cleanup();
        return;
      }
      if (distance < threshold) return;
      begin(at);
    }
    at.preventDefault();
    onMove?.(at, delta(at));
  }
  function up(at) {
    const was = started;
    cleanup();
    if (!was) return;
    swallowClick(win);
    if (at.clientX !== last.clientX || at.clientY !== last.clientY) onMove?.(at, delta(at));
    onEnd?.(at, delta(at));
  }
  function cancel() {
    const was = started;
    cleanup();
    if (was) onCancel?.();
  }
  function key(at) {
    if (at.key !== 'Escape' || !started) return;
    at.preventDefault();
    at.stopPropagation();
    cleanup();
    swallowClick(win);
    onCancel?.();
  }
  if (held) {
    timer = setTimeout(() => {
      if (done) return;
      begin(last);
      onMove?.(last, { dx: 0, dy: 0 });
    }, longPress);
  }
  win.addEventListener('pointermove', move, { passive: false });
  win.addEventListener('pointerup', up);
  win.addEventListener('pointercancel', cancel);
  win.addEventListener('keydown', key, true);
}

/** Scrolls `box` while a drag's pointer is within 60 px of its top or bottom edge, faster the
 *  nearer it is; `onScroll()` runs after each step (the dragged thing moves with the page). */
export function autoScroll(box, onScroll = () => {}) {
  const win = box?.ownerDocument?.defaultView;
  let y = null;
  let frame = 0;
  const tick = () => {
    frame = 0;
    if (y === null || !box) return;
    const r = box.getBoundingClientRect();
    const edge = 60;
    const step = y < r.top + edge ? -Math.ceil((r.top + edge - y) / 4) : y > r.bottom - edge ? Math.ceil((y - (r.bottom - edge)) / 4) : 0;
    if (!step) return;
    const before = box.scrollTop;
    box.scrollTop += step;
    if (box.scrollTop !== before) onScroll();
    frame = win.requestAnimationFrame(tick);
  };
  return {
    update(clientY) {
      y = clientY;
      if (!frame && win) frame = win.requestAnimationFrame(tick);
    },
    stop() {
      y = null;
      if (frame) win.cancelAnimationFrame(frame);
      frame = 0;
    },
  };
}
