// Which sidebar entries are usable while onboarding is still running.
//
// Until the checklist is done, the other screens are not somewhere to wander
// into: the checklist itself is what sends the user to them, item by item.
// So they are dimmed and cannot be clicked -- but Home never is, because a
// checklist item that opens Agents or Health has to leave a way back.
//
// Pure DOM: the caller passes the element that holds the entries.
// CLI usage analytics is locked with them: until setup is done there are no
// sessions for it to report on.
const ONBOARDING_LOCKED = ['sidebar-agents', 'sidebar-connections', 'sidebar-health', 'sidebar-analytics'];

export function applyOnboardingNav(root, { done } = {}) {
  for (const id of ONBOARDING_LOCKED) {
    const el = root?.querySelector?.(`#${id}`);
    if (!el) continue;
    el.classList.toggle('locked', !done);
    if (done) el.removeAttribute('aria-disabled');
    else el.setAttribute('aria-disabled', 'true');
    // The click handler is bound once at boot and never rebound, so the guard
    // has to be the property the handler cannot ignore: a disabled button
    // dispatches no click at all.
    el.disabled = !done;
  }
}
