// The View setting (Settings → Appearance): reads native Settings.view and mirrors it in
// localStorage so the window's first paint (before the native snapshot loads) uses the right one.
export const VIEW_KEY = 'codemie.view';

/** Settings.view, or 'default' for anything else (including missing or unknown values). */
export function viewOf(settings) {
  return settings?.view === 'compact' ? 'compact' : 'default';
}

/** The mirrored view from storage: 'default' on a throw or a value that is not 'compact'. */
export function readViewMirror(storage) {
  try {
    return storage.getItem(VIEW_KEY) === 'compact' ? 'compact' : 'default';
  } catch {
    return 'default';
  }
}

/** Writes the mirror; swallows a throw (preference only). */
export function writeViewMirror(storage, view) {
  try {
    storage.setItem(VIEW_KEY, view);
  } catch {
    /* preference only */
  }
}
