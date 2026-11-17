// Where a plugin's frame files are served (DESIGN 7.3, src-tauri/src/plugins/protocol.rs):
// connect-plugin://<id>/<path>, one host per plugin. macOS only (ruling R30): wry injects its init
// scripts into subframes on Windows, so a plugin frame would hold the invoke key, and Linux
// (WebKitGTK) isolation is not verified.
const PLUGIN_ID = /^[a-z][a-z0-9-]{1,40}$/;

function currentPlatform() {
  return { macos: /Macintosh|Mac OS X/.test(globalThis.navigator?.userAgent || '') };
}

export function pluginUrl(id, path, { macos } = currentPlatform()) {
  if (!macos) throw new Error('Plugins are only available on macOS for now.');
  if (!PLUGIN_ID.test(id)) throw new Error(`Not a plugin id: ${id}`);
  return `connect-plugin://${id}/${String(path).replace(/^\/+/, '')}`;
}
