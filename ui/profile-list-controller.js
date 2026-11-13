// Profile list for the Profiles screen. One action at a time; after every action
// the list is re-read from the config file and the UI is drawn from that, never
// from the action's reply. Pure: the bridge is injected, no DOM or Tauri here.

const lastLine = (text) => String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';

export function createProfileListController({ bridge, onChanged = () => {} }) {
  // pending: the row an action is running on, until the list is read again --
  // { name, label, text }: the row to mark, the name it will carry, and what
  // is happening -- so the old name never shows while the CLI works.
  const state = { profiles: [], busy: false, failure: null, notice: null, pending: null };
  const subscribers = [];
  const notify = () => subscribers.forEach((fn) => fn(state));

  async function reread() {
    try {
      state.profiles = (await bridge.codemieConfig.listProfiles()) ?? [];
    } catch {
      // keep the last list; the failure, if any, is already recorded
    }
  }

  async function run(label, call, after, pending = null) {
    if (state.busy) return;
    state.busy = true;
    state.pending = pending;
    state.failure = null;
    state.notice = null;
    notify();
    let res = null;
    try {
      res = await call();
      if (res?.code !== 0) {
        const output = `${res?.stdout ?? ''}${res?.stderr ?? ''}`;
        state.failure = { message: lastLine(res?.stderr) || lastLine(res?.stdout) || `${label} did not finish`, raw: output, command: label };
      }
    } catch (e) {
      state.failure = { message: String(e?.message ?? e), raw: '', command: label };
    }
    await reread();
    if (!state.failure) after?.();
    state.busy = false;
    state.pending = null;
    notify();
    onChanged();
  }

  return {
    state,
    load: async () => {
      await reread();
      notify();
    },
    switchTo: (name) => run(`codemie profile switch ${name}`, () => bridge.profile.switch(name), undefined, { name, label: name, text: 'Switching…' }),
    rename: async (oldName, newName) => {
      if (newName === oldName || state.busy) return;
      // The CLI refuses a name that is taken but prints nothing unless in debug
      // mode, so the app says it itself, from the list it already has.
      if (state.profiles.some((p) => p.name === newName)) {
        state.notice = null;
        state.failure = { message: `A profile named "${newName}" already exists.`, raw: '', command: '' };
        notify();
        return;
      }
      await run(`codemie profile rename ${oldName} ${newName}`, () => bridge.profile.rename(oldName, newName), undefined, { name: oldName, label: newName, text: 'Renaming…' });
    },
    remove: (name) => {
      // Only deleting the active profile changes which one is active.
      const wasActive = !!state.profiles.find((p) => p.name === name)?.active;
      return run(`codemie profile delete ${name} --yes`, () => bridge.profile.delete(name), () => {
        const now = state.profiles.find((p) => p.active);
        state.notice = wasActive && now ? `Active profile now: ${now.name}` : null;
      }, { name, label: name, text: 'Deleting…' });
    },
    // A message belongs to the action that caused it, not to the next visit.
    clearMessages: () => {
      state.failure = null;
      state.notice = null;
    },
    subscribe: (fn) => { subscribers.push(fn); },
  };
}
