// Whether the Home checklist has ever been finished on this machine. Home
// derives everything else from live reads, but health is only known once the
// check has run in this session, so this is what keeps a returning user on the
// status cards instead of the checklist (see deriveHome's `onboarded`).
//
// Storage is injected so node:test can drive it; any failure to read or write
// behaves as a first run.
export const ONBOARDED_KEY = 'codemie.home.onboarded';

export function readOnboarded(storage) {
  try {
    return storage?.getItem(ONBOARDED_KEY) === '1';
  } catch {
    return false;
  }
}

export function rememberOnboarded(storage) {
  try {
    storage?.setItem(ONBOARDED_KEY, '1');
  } catch {
    // Not remembered: the next launch shows the checklist, as a first run does.
  }
}
