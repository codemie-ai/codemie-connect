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

export function createStepsUi() {
  const rows = new Map();
  const spinners = new Map();
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
    // Exposed so a view can style a row by its state -- guided setup draws the
    // completed tick as a badge, the way the wireframe does, and only that one.
    rec.el.dataset.status = status;
    if (status !== 'ACTIVE') stopSpinner(id);
    if (!spinners.has(id)) {
      rec.icon.textContent = meta.icon;
      rec.icon.style.color = meta.color;
    }
  }

  function renderSteps(container, list) {
    listEl = container;
    container.innerHTML = '';
    rows.clear();
    stepsById = new Map(list.map((s) => [s.id, s]));
    for (const step of list) {
      if (step.is_sub_step) continue;
      container.appendChild(buildRow(step));
    }
  }

  function setStatus(id, status) { applyStatus(id, status); }

  function setSubtitle(id, text) {
    const rec = rows.get(id);
    if (rec && text) rec.sub.textContent = text;
  }

  function startSpinner(id) {
    const rec = rows.get(id);
    if (!rec || spinners.has(id)) return;
    let i = 0;
    rec.icon.style.color = '#58a6ff';
    const t = setInterval(() => { rec.icon.textContent = SPINNER[i % SPINNER.length]; i += 1; }, 80);
    spinners.set(id, t);
  }

  function stopSpinner(id) {
    const t = spinners.get(id);
    if (t) { clearInterval(t); spinners.delete(id); }
  }

  function setProgress(id, frac) {
    const rec = rows.get(id);
    if (rec) rec.progress.style.width = `${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
  }

  // Keep the else-if (listEl) fallback — closure-scoped to this instance.
  // An orphan sub-step falls back to this instance's own listEl, never
  // another instance's. ui/renderer.js:122 depends on this fallback.
  function insertSubStep(parentId, step) {
    if (rows.has(step.id)) return;
    const parentRec = rows.get(parentId);
    const el = buildRow(step);
    if (parentRec && parentRec.el.nextSibling) {
      parentRec.el.parentNode.insertBefore(el, parentRec.el.nextSibling);
    } else if (listEl) {
      listEl.appendChild(el);
    }
  }

  function showApproval(id, message, onApprove, onIgnore) {
    const rec = rows.get(id);
    if (!rec) return;
    if (message) rec.sub.textContent = message;
    rec.main.querySelector('.approval')?.remove();
    const bar = document.createElement('div');
    bar.className = 'approval';
    bar.innerHTML = '<button class="btn-approve">✓ Approve</button><button class="btn-ignore">— Ignore</button>';
    bar.querySelector('.btn-approve').onclick = () => { stampApproval(id, true); onApprove && onApprove(); };
    bar.querySelector('.btn-ignore').onclick = () => { stampApproval(id, false); onIgnore && onIgnore(); };
    rec.main.appendChild(bar);
  }

  function stampApproval(id, approved) {
    const rec = rows.get(id);
    if (!rec) return;
    rec.main.querySelector('.approval')?.remove();
    if (rec.main.querySelector('.stamp')) return;
    const stamp = document.createElement('div');
    stamp.className = 'stamp ' + (approved ? 'approved' : 'ignored');
    stamp.textContent = approved ? '✓ APPROVED' : '— IGNORED';
    rec.main.appendChild(stamp);
  }

  return { renderSteps, setStatus, setSubtitle, startSpinner, stopSpinner,
           setProgress, insertSubStep, showApproval, stampApproval };
}

// Default instance — keeps all existing named exports intact so
// `import * as stepsUI` in ui/renderer.js needs no change.
const _default = createStepsUi();
export const renderSteps   = _default.renderSteps;
export const setStatus     = _default.setStatus;
export const setSubtitle   = _default.setSubtitle;
export const startSpinner  = _default.startSpinner;
export const stopSpinner   = _default.stopSpinner;
export const setProgress   = _default.setProgress;
export const insertSubStep = _default.insertSubStep;
export const showApproval  = _default.showApproval;
export const stampApproval = _default.stampApproval;
