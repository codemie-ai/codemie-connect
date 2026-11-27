// The desktop the window runs on, for the few words and keys that differ.
const nav = typeof navigator === 'undefined' ? {} : navigator;
export const IS_WINDOWS = /^Win/i.test(nav.platform || '');
/** What the platform calls its file manager. */
export const FILE_MANAGER = IS_WINDOWS ? 'File Explorer' : 'Finder';
/** The shortcut modifier as a label: "⌘" or "Ctrl+". */
export const MOD = IS_WINDOWS ? 'Ctrl+' : '⌘';
/** ⌘ then ⇧ ("⌘⇧") as the Settings menu shortcut reads it. */
export const MOD_THEN_SHIFT = IS_WINDOWS ? 'Ctrl+Shift+' : '⌘⇧';
export const MOD_SHIFT = IS_WINDOWS ? 'Ctrl+Shift+' : '⇧⌘';
/** Whether a key event carries the platform's shortcut modifier. */
export const hasMod = (ev) => (IS_WINDOWS ? ev.ctrlKey : ev.metaKey);
