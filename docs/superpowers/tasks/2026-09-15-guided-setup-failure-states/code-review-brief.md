# Code review — 2026-09-15-guided-setup-failure-states (2026-09-15)

**request-changes** · confidence: low · 5 blocking · 0 deferred · 10 filtered as noise
Coverage: blind ✓ · edge-case ✓ · verification-gap ✓ · acceptance — n/a (no spec)  (3/4 lenses ran)

## Look here first

- `ui/setup-view.js:726` — [other] race: proactive authTimeout notice vs. the driver's own re-ask recovery — CR-004
- `ui/setup-view.js:699` — [other] notice: noticeFailureShown latch blocks every later failure notice this run — CR-003
- `ui/setup-view.js:686` — [other] crash-handling: handleReject can throw on a message-less rejection value — CR-002
- `ui/setup-view.js:758` — [other] data-integrity: answeredValues never cleared on restart — CR-005
- `ui/setup-parse.js:75` — [other] parsing: authTimeout reason regex mishandles nested parens — CR-001

## Checked and clean

commit-format ✓ · code-quality na (no guide/ArtifactRef) · security na (no guide/ArtifactRef; manual scan found no injection-prone patterns) · 0 deferred
