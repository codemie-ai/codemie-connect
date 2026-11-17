// Connect's own invoke: every call carries the page origin as an `Origin` header. Over Tauri's
// ipc: scheme the browser sends the real Origin and drops this one (a forbidden header); after
// Tauri falls back to postMessage it is the only Origin the native caller check
// (src-tauri/src/plugins/caller.rs `require_main_frame`) sees. Plugin frames never get this
// function or the invoke key it relies on.
export function withAppOrigin(rawInvoke, origin) {
  return (cmd, args, options = {}) =>
    rawInvoke(cmd, args, { ...options, headers: { ...(options.headers || {}), Origin: origin } });
}
