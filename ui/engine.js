import { StepStatus } from './models.js';

// Orchestrates the install plan. Faithful port of the Windows StepEngine:
//  - runs top-level steps in order (sub-steps run on demand from a handler),
//  - pauses at approval gates (resolved by approve()/ignore(); unattended auto-approves),
//  - a fatal failure marks remaining steps SKIPPED and stops,
//  - all engine -> UI communication goes through `emit(event, payload)` (IPC sink).
class Engine {
  constructor({ steps, handlers, emit, isUnattended } = {}) {
    this.steps = steps || [];
    this.handlers = handlers || {};
    this.emit = emit || (() => {});
    this.isUnattended = isUnattended || (() => false);
    this._gate = null; // { resolve } for the in-flight approval
    this.activeSubStepId = null; // download progress / subtitles target this when set
  }

  _find(id) {
    return this.steps.find((s) => s.id === id);
  }

  _setStatus(step, status) {
    step.status = status;
    this.emit('status-change', { id: step.id, status });
  }

  async run() {
    for (const step of this.steps) {
      if (step.is_sub_step) continue;
      this._setStatus(step, StepStatus.ACTIVE);
      this.emit('subtitle-change', { id: step.id, text: '' });
      this.emit('terminal-line', { text: `▶ ${step.title}…`, tag: 'info' });
      const result = await this._executeStep(step);
      if (result === false && step.fatal) {
        this._handleFatal(step);
        return;
      }
    }
    const failed = this.steps.filter((s) => !s.is_sub_step && s.status === StepStatus.ERROR);
    const ok = failed.length === 0;
    if (ok) {
      this.emit('terminal-line', { text: '✓ Installation complete! 🎉 CodeMie is ready to use.', tag: 'success' });
    } else {
      const titles = failed.map((s) => s.title).join(', ');
      this.emit('terminal-line', {
        text: `⚠ Finished with errors — these steps did not complete: ${titles}. See the log above.`,
        tag: 'stderr',
      });
    }
    this.emit('complete', { ok });
  }

  // Returns true (complete), false (error), or null (skipped / handler self-managed).
  async _executeStep(step) {
    if (step.requires_approval) {
      const approved = await this._requestApproval(step);
      if (!approved) {
        this._setStatus(step, StepStatus.SKIPPED);
        this.emit('terminal-line', { text: 'Step skipped by user', tag: 'dim' });
        return null;
      }
    }
    if (step.spinner) this.emit('spinner-start', { id: step.id });
    const handler = this.handlers[step.id];
    try {
      const result = handler ? await handler(this._ctx(step)) : true;
      if (result === false) {
        this._setStatus(step, StepStatus.ERROR);
        return false;
      }
      // null/undefined: handler managed its own status (e.g. delegated to a sub-step).
      if (result == null) {
        if (step.status === StepStatus.ACTIVE) this._setStatus(step, StepStatus.COMPLETE);
        return true;
      }
      this._setStatus(step, StepStatus.COMPLETE);
      return true;
    } catch (err) {
      this.emit('terminal-line', { text: String((err && err.message) || err), tag: 'stderr' });
      this._setStatus(step, StepStatus.ERROR);
      return false;
    }
  }

  _requestApproval(step) {
    if (this.isUnattended()) {
      this.emit('terminal-line', { text: 'Auto-approved (unattended mode)', tag: 'dim' });
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      this._gate = { resolve };
      this.emit('approval-needed', { id: step.id, message: step.approval_message });
    });
  }

  approve() {
    if (this._gate) {
      const g = this._gate;
      this._gate = null;
      g.resolve(true);
    }
  }

  ignore() {
    if (this._gate) {
      const g = this._gate;
      this._gate = null;
      g.resolve(false);
    }
  }

  _handleFatal(step) {
    for (const s of this.steps) {
      if (s.is_sub_step) continue;
      if (s.status === StepStatus.PENDING) this._setStatus(s, StepStatus.SKIPPED);
    }
    this.emit('fatal', {
      id: step.id,
      message: `${step.title} failed`,
      recommendation: step.fatal_recommendation,
    });
  }

  // Context handed to each step handler.
  _ctx(step) {
    return {
      step,
      emit: (ev, p) => this.emit(ev, p),
      line: (text, tag = 'stdout') => this.emit('terminal-line', { text, tag }),
      setSubtitle: (id, text) => this.emit('subtitle-change', { id, text }),
      setStatus: (id, status) => {
        const s = this._find(id);
        if (s) this._setStatus(s, status);
      },
      progress: (id, fraction) => this.emit('download-progress', { id, fraction }),
      runSubStep: (id, workFn) => this._runSubStep(id, workFn),
      isUnattended: () => this.isUnattended(),
    };
  }

  // Activate and run a sub-step (e.g. 1.1.1 install Git). Mirrors _run_sub_step.
  async _runSubStep(id, workFn) {
    const sub = this._find(id);
    if (!sub) throw new Error(`unknown sub-step ${id}`);
    this.emit('substep-activate', { id, parent_id: sub.parent_id, step: sub });
    this._setStatus(sub, StepStatus.ACTIVE);
    if (sub.requires_approval) {
      const approved = await this._requestApproval(sub);
      if (!approved) {
        this._setStatus(sub, StepStatus.SKIPPED);
        return false;
      }
    }
    if (sub.spinner) this.emit('spinner-start', { id });
    this.activeSubStepId = id;
    try {
      const ok = await workFn();
      this._setStatus(sub, ok === false ? StepStatus.ERROR : StepStatus.COMPLETE);
      return ok !== false;
    } catch (err) {
      this.emit('terminal-line', { text: String((err && err.message) || err), tag: 'stderr' });
      this._setStatus(sub, StepStatus.ERROR);
      return false;
    } finally {
      this.activeSubStepId = null;
    }
  }
}

export { Engine };
