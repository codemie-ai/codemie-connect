# Code review — 2026-09-03-epmcdme-14654-steps-ui-factory (2026-09-03)

**request-changes** · confidence: low · 2 blocking · 0 deferred · 3 filtered as noise
Coverage: blind — n/a (compact profile) · edge-case ✓ · verification-gap — n/a (compact profile) · acceptance — n/a (no spec)  (1/4 lenses ran)

> No spec present; confidence is low (compact profile, no story artifact).

## Look here first

- `ui/steps-ui.js:57` — [infra] active spinner intervals never cancelled on re-render; leak to detached nodes — CR-001
- `ui/steps-ui.js:108` — [other: UI state] showApproval re-entry after stamp leaves orphaned no-op buttons — CR-002

## Checked and clean

3 filtered as noise: setInterval false positive (Node.js provides it natively; tests deliberately skip startSpinner), intentional silent sub-step drop (task-spec mandated, documented in code comment), dead stepsById Map (below emission floor)
