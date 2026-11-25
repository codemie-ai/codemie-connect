// Removing the active task provider's plugin switches Connect to Local, once (task-provider
// design §11, ruling 16): nothing is deleted, the cache and the outbox stay, and come back if the
// plugin is installed again. `app.js`'s `installedChanged` learns of the same removal more than
// once — its own direct `loadInstalled` after `remove`'s `request`, the Plugins tab reopening
// (`route`'s own `pluginsUi.load()`), and the native `plugins:reloaded` event all call it for the
// one removal — so without a guard each call races `switchToLocal` again before the first has
// updated the snapshot, and the user sees the toast and the `task_provider_set` call more than
// once. `createRemovalSwitch` is the guard: told the same still-missing provider again while an
// earlier switch for it hasn't settled, it does nothing.
export function createRemovalSwitch(switchToLocal) {
  let inFlight = null;
  return (active, stillInstalled) => {
    if (!active?.startsWith('plugin:') || stillInstalled) {
      inFlight = null;
      return null;
    }
    if (inFlight === active) return null;
    inFlight = active;
    return Promise.resolve(switchToLocal()).finally(() => {
      if (inFlight === active) inFlight = null;
    });
  };
}
