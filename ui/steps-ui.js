// Step list rendering + live updates. Mirrors ui/step_panel.py behavior.

const STATUS_META = {
  PENDING: { icon: '○', color: '#484f58' },
  ACTIVE: { icon: '▶', color: '#58a6ff' },
  COMPLETE: { icon: '✓', color: '#3fb950' },
  WARNING: { icon: '⚠', color: '#d29922' },
  ERROR: { icon: '✗', color: '#ff6b6b' },
  SKIPPED: { icon: '—', color: '#484f58' },
};
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';

const rows = new Map(); // id -> { el, icon, title, sub, main, status }
const spinners = new Map(); // id -> interval
let listEl = null;
let stepsById = new Map();

function buildRow(step) {
  const el = document.createElement('div');
  el.className = 'step-row' + (step.is_sub_step ? ' sub' : '');
  el.dataset.id = step.id;
  el.innerHTML = `
    <div class="step-progress"></div>
    <div class="step-icon">○</div>
    <div class="step-main">
      <div class="step-title"></div>
      <div class="step-sub"></div>
    </div>`;
  el.querySelector('.step-title').textContent = step.title;
  el.querySelector('.step-sub').textContent = step.description || '';
  const rec = {
    el,
    icon: el.querySelector('.step-icon'),
    title: el.querySelector('.step-title'),
    sub: el.querySelector('.step-sub'),
    main: el.querySelector('.step-main'),
    progress: el.querySelector('.step-progress'),
  };
  rows.set(step.id, rec);
  applyStatus(step.id, step.status || 'PENDING');
  return el;
}

function applyStatus(id, status) {
  const rec = rows.get(id);
  if (!rec) return;
  const meta = STATUS_META[status] || STATUS_META.PENDING;
  rec.el.classList.toggle('active', status === 'ACTIVE');
  if (status !== 'ACTIVE') stopSpinner(id);
  if (!spinners.has(id)) {
    rec.icon.textContent = meta.icon;
    rec.icon.style.color = meta.color;
  }
}

export function renderSteps(container, list) {
  listEl = container;
  container.innerHTML = '';
  rows.clear();
  stepsById = new Map(list.map((s) => [s.id, s]));
  for (const step of list) {
    if (step.is_sub_step) continue; // sub-steps are inserted on activation
    container.appendChild(buildRow(step));
  }
}

export function setStatus(id, status) {
  applyStatus(id, status);
}

export function setSubtitle(id, text) {
  const rec = rows.get(id);
  if (rec && text) rec.sub.textContent = text;
}

export function startSpinner(id) {
  const rec = rows.get(id);
  if (!rec || spinners.has(id)) return;
  let i = 0;
  rec.icon.style.color = '#58a6ff';
  const t = setInterval(() => {
    rec.icon.textContent = SPINNER[i % SPINNER.length];
    i += 1;
  }, 80);
  spinners.set(id, t);
}

export function stopSpinner(id) {
  const t = spinners.get(id);
  if (t) {
    clearInterval(t);
    spinners.delete(id);
  }
}

export function setProgress(id, frac) {
  const rec = rows.get(id);
  if (rec) rec.progress.style.width = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
}

export function insertSubStep(parentId, step) {
  if (rows.has(step.id)) return;
  const parentRec = rows.get(parentId);
  const el = buildRow(step);
  if (parentRec && parentRec.el.nextSibling) {
    parentRec.el.parentNode.insertBefore(el, parentRec.el.nextSibling);
  } else if (listEl) {
    listEl.appendChild(el);
  }
}

export function showApproval(id, message, onApprove, onIgnore) {
  const rec = rows.get(id);
  if (!rec) return;
  if (message) rec.sub.textContent = message;
  rec.main.querySelector('.approval')?.remove();
  const bar = document.createElement('div');
  bar.className = 'approval';
  bar.innerHTML =
    '<button class="btn-approve">✓ Approve</button><button class="btn-ignore">— Ignore</button>';
  bar.querySelector('.btn-approve').onclick = () => {
    stampApproval(id, true);
    onApprove && onApprove();
  };
  bar.querySelector('.btn-ignore').onclick = () => {
    stampApproval(id, false);
    onIgnore && onIgnore();
  };
  rec.main.appendChild(bar);
}

export function stampApproval(id, approved) {
  const rec = rows.get(id);
  if (!rec) return;
  rec.main.querySelector('.approval')?.remove();
  if (rec.main.querySelector('.stamp')) return;
  const stamp = document.createElement('div');
  stamp.className = 'stamp ' + (approved ? 'approved' : 'ignored');
  stamp.textContent = approved ? '✓ APPROVED' : '— IGNORED';
  rec.main.appendChild(stamp);
}
