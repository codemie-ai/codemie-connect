// Where a plugin's frame files are served (DESIGN 7.3, src-tauri/src/plugins/protocol.rs):
// connect-plugin://<id>/<path>, one host per plugin. Not on Windows: wry injects its init
// scripts into subframes there, so a plugin frame would hold the invoke key.
const PLUGIN_ID = /^[a-z][a-z0-9-]{1,40}$/;

function currentPlatform() {
  return { windows: /Windows/.test(globalThis.navigator?.userAgent || '') };
}

export function pluginUrl(id, path, { windows } = currentPlatform()) {
  if (windows) throw new Error("Plugins aren't available on Windows yet.");
  if (!PLUGIN_ID.test(id)) throw new Error(`Not a plugin id: ${id}`);
  return `connect-plugin://${id}/${String(path).replace(/^\/+/, '')}`;
}
