'use strict';

// Step lifecycle states. Mirrors the Windows reference (core/models.py StepStatus).
const StepStatus = Object.freeze({
  PENDING: 'PENDING',
  ACTIVE: 'ACTIVE',
  COMPLETE: 'COMPLETE',
  WARNING: 'WARNING',
  ERROR: 'ERROR',
  SKIPPED: 'SKIPPED',
});

// Icon + color per status (analysis §9 — GitHub-dark palette).
const STATUS_META = Object.freeze({
  [StepStatus.PENDING]: { icon: '○', color: '#484f58' },
  [StepStatus.ACTIVE]: { icon: '▶', color: '#58a6ff' },
  [StepStatus.COMPLETE]: { icon: '✓', color: '#3fb950' },
  [StepStatus.WARNING]: { icon: '⚠', color: '#d29922' },
  [StepStatus.ERROR]: { icon: '✗', color: '#ff6b6b' },
  [StepStatus.SKIPPED]: { icon: '—', color: '#484f58' },
});

// Build a normalized Step from a raw YAML entry, applying defaults.
function makeStep(raw) {
  return {
    id: String(raw.id),
    title: raw.title || '',
    description: raw.description || '',
    status: StepStatus.PENDING,
    requires_approval: Boolean(raw.requires_approval),
    approval_message: raw.approval_message || '',
    is_sub_step: Boolean(raw.is_sub_step),
    parent_id: raw.parent_id != null ? String(raw.parent_id) : null,
    spinner: Boolean(raw.spinner),
    interactive: Boolean(raw.interactive),
    fatal: Boolean(raw.fatal),
    fatal_recommendation: raw.fatal_recommendation || '',
  };
}

module.exports = { StepStatus, STATUS_META, makeStep };
