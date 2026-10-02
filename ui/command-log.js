// The "what CodeMie ran" footer: one line per command the app ran in this
// session, with whether it exited ok. The receipt, not the transcript: per-row
// output, "Copy all" and record-by-id are EPMCDME-14512's.
//
// Pure DOM. The runner bridge calls start() when a command is spawned and the
// function it returns when the exit code is known.
const EMPTY = 'Nothing run yet';
const MAX_LINES = 50;

const clock = (date) => date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

export function createCommandLog(body, { now = () => new Date() } = {}) {
  let count = 0;

  function showEmpty() {
    body.innerHTML = '';
    const line = document.createElement('div');
    line.className = 'command-log-empty';
    line.textContent = EMPTY;
    body.appendChild(line);
  }
  showEmpty();

  function start(cmd) {
    if (count === 0) body.innerHTML = '';
    count += 1;
    const line = document.createElement('div');
    line.className = 'command-log-line running';
    const when = document.createElement('span');
    when.className = 'command-log-when';
    when.textContent = clock(now());
    const text = document.createElement('span');
    text.className = 'command-log-cmd';
    text.textContent = `$ ${cmd}`;
    const status = document.createElement('span');
    status.className = 'command-log-status';
    status.textContent = 'running';
    line.append(when, text, status);
    body.appendChild(line);
    // The newest line goes at the bottom; the oldest leaves when the footer
    // is full.
    if (count > MAX_LINES) {
      body.querySelector('.command-log-line')?.remove();
    }
    return function finish(code) {
      const ok = code === 0;
      line.className = `command-log-line ${ok ? 'ok' : 'failed'}`;
      status.textContent = ok ? 'ok' : code == null ? 'failed' : `failed (${code})`;
    };
  }

  return { start };
}
