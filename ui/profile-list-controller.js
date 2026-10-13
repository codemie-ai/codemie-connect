// Profile list for Home's Profile card. One action at a time; after every action
// the list is re-read from the config file and the UI is drawn from that, never
// from the action's reply. Pure: the bridge is injected, no DOM or Tauri here.

const lastLine = (text) => String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';

export function createProfileListController({ bridge, onChanged = () => {}, onAdd = () => {} }) {
  const state = { profiles: [], busy: false, failure: null, notice: null };
  const subscribers = [];
  const notify = () => subscribers.forEach((fn) => fn(state));

  async function reread() {
    try {
      state.profiles = (await bridge.codemieConfig.listProfiles()) ?? [];
    } catch {
      // keep the last list; the failure, if any, is already recorded
    }
  }

  async function run(label, call, after) {
    if (state.busy) return;
    state.busy = true;
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
    notify();
    onChanged();
  }

  return {
    state,
    onAdd,
    load: async () => {
      await reread();
      notify();
    },
    switchTo: (name) => run(`codemie profile switch ${name}`, () => bridge.profile.switch(name)),
    rename: (oldName, newName) => run(`codemie profile rename ${oldName} ${newName}`, () => bridge.profile.rename(oldName, newName)),
    remove: (name) => run(`codemie profile delete ${name} --yes`, () => bridge.profile.delete(name), () => {
      const now = state.profiles.find((p) => p.active);
      state.notice = now ? `Active profile now: ${now.name}` : null;
    }),
    subscribe: (fn) => { subscribers.push(fn); },
  };
}
