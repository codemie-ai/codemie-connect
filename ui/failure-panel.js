// The app's failure panel: a red block reported INSIDE the screen that failed,
// with the underlying command's transcript collapsed beneath it.
//
// Both wireframes draw the same shape -- Home's broken profile (01-home.png)
// and guided setup's unreachable service (02-setup.png) -- so it lives here
// rather than inside one view: a title in plain language, an explanation that
// says what to do about it, the tool's own words kept underneath, actions in
// the panel, and `$ command` + output in a block below, behind "Show details".
//
// A warning (Home's "Two copies of CodeMie on this computer") is the same shape
// in amber with no actions: pass variant: 'warning'.
//
// Pure DOM: no window/Tauri globals, so it imports cleanly under node:test.

const DETAILS_SHOW = 'Show details';
const DETAILS_HIDE = 'Hide details';

/**
 * Render (or replace) the failure panel inside `container`.
 *
 * Only one panel exists per container at a time: a second failure replaces the
 * first rather than stacking, so the screen always shows the current state.
 *
 * @returns the block element, so a caller can remove it itself.
 */
export function renderFailurePanel(container, {
  variant = 'error',
  title,
  explanation,
  detail,
  raw = '',
  command,
  primaryLabel,
  onPrimary,
} = {}) {
  container.querySelector('.failure-block')?.remove();

  const block = document.createElement('div');
  block.className = 'failure-block';

  const panel = document.createElement('div');
  panel.className = variant === 'warning' ? 'failure-panel warning' : 'failure-panel';

  const titleEl = document.createElement('div');
  titleEl.className = 'failure-title';
  titleEl.textContent = title ?? '';
  panel.appendChild(titleEl);

  if (explanation) {
    const body = document.createElement('div');
    body.className = 'failure-body';
    body.textContent = explanation;
    panel.appendChild(body);
  }

  // The tool's own sentence, but only when it says something the title does not:
  // "Ollama is not running" under a heading reading "Ollama is not running" is
  // just the panel repeating itself.
  if (detail && detail.trim() !== (title ?? '').trim()) {
    const detailEl = document.createElement('div');
    detailEl.className = 'failure-detail';
    detailEl.textContent = detail;
    panel.appendChild(detailEl);
  }

  const rawEl = document.createElement('pre');
  rawEl.className = 'failure-raw';
  rawEl.classList.add('hidden');
  rawEl.textContent = command ? `$ ${command}\n${raw}` : raw;

  const actions = document.createElement('div');
  actions.className = 'failure-actions';
  if (primaryLabel) {
    const primary = document.createElement('button');
    primary.className = 'btn btn-accent';
    primary.textContent = primaryLabel;
    primary.onclick = () => onPrimary?.(block);
    actions.appendChild(primary);
  }
  if (raw) {
    const details = document.createElement('button');
    details.className = 'btn btn-ghost';
    details.textContent = DETAILS_SHOW;
    details.onclick = () => {
      const wasOpen = !rawEl.classList.contains('hidden');
      rawEl.classList.toggle('hidden', wasOpen);
      details.textContent = wasOpen ? DETAILS_SHOW : DETAILS_HIDE;
      // A transcript is read from the bottom: the failure is its last line.
      if (!wasOpen) rawEl.scrollTop = rawEl.scrollHeight;
    };
    actions.appendChild(details);
  }
  // Only when it holds a button: an empty row still takes its top margin.
  if (primaryLabel || raw) panel.appendChild(actions);

  block.appendChild(panel);
  block.appendChild(rawEl);
  container.appendChild(block);
  return block;
}
