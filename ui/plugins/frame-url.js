// Where a plugin's frame files are served (DESIGN 7.3, src-tauri/src/plugins/protocol.rs).
// macOS: connect-plugin://<id>/<path>, one host per plugin. Windows, where WebView2 serves custom
// schemes over http (https with useHttpsScheme): http://connect-plugin.localhost/<id>/<path>.
const PLUGIN_ID = /^[a-z][a-z0-9-]{1,40}$/;

function currentPlatform() {
  return {
    windows: /Windows/.test(globalThis.navigator?.userAgent || ''),
    protocol: globalThis.location?.protocol,
  };
}

export function pluginUrl(id, path, { windows, protocol } = currentPlatform()) {
  if (!PLUGIN_ID.test(id)) throw new Error(`Not a plugin id: ${id}`);
  const rel = String(path).replace(/^\/+/, '');
  return windows
    ? `${protocol === 'https:' ? 'https:' : 'http:'}//connect-plugin.localhost/${id}/${rel}`
    : `connect-plugin://${id}/${rel}`;
}
