// Workspaces are hidden until they are redesigned, so Connect always runs in Personal.
// Backend workspace data stays; only the active selection is reset.
export async function bootWorkspace(store, snapshot) {
  if (snapshot.settings.activeWorkspace !== 'personal') {
    await store.mutate('workspace_select', { id: 'personal' });
  }
}
