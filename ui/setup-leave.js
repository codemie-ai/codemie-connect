// Leaving guided setup ends its run (EPMCDME-15304). setup-view hands back the
// run in flight on start(), so a run left waiting on a question would reopen on
// that question the next time "Set up again" is clicked. Ending it here makes
// every visit start from step one. Nothing is lost: the CLI writes the config
// only after the last answer. Switching to the browser for sign-in is not a
// view change, so it never gets here.
//
// Returns a promise that settles once the run has fully unwound, or null when
// there is nothing to stop.
export function stopSetupOnLeave(from, to, { running, cancel, settled }) {
  if (from !== 'setup' || to === 'setup' || !running) return null;
  return cancel().then(() => settled(), () => settled());
}
