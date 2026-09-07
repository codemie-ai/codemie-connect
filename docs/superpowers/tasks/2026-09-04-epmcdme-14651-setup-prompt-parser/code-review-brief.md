# Code review — 2026-09-04-epmcdme-14651-setup-prompt-parser (2026-09-04)

**request-changes** · confidence: low · 7 blocking · 0 deferred · 1 filtered as noise
Coverage: blind — n/a (compact profile) · edge-case ✓ · acceptance — n/a (no spec) · verification-gap — n/a (compact profile)  (1/4 lenses ran)

## Look here first

- `ui/setup-parse.js:10` — [infra] non-string element in lines array calls l.trimStart(), throws TypeError and aborts mid-scan — CR-001
- `ui/setup-parse.js:32` — [infra] null or non-array input throws before any parsing; detectPrompt never returns — CR-002
- `ui/setup-parse.js:41` — [other] confirm prompt message includes raw (Y/n) hint text; activate.json recording confirms the bug — CR-003
- `ui/setup-parse.js:53` — [other] startsWith('(') filter is over-broad; any option label beginning with '(' is silently dropped — CR-004
- `ui/setup-parse.js:55` — [other] last selection marker wins on partial renders instead of first — CR-005

## Also flagged

- `ui/test/tools/replay-capture.mjs:31` — [other] length >20 heuristic silently skips credential prompts shorter than 21 chars — CR-006
- `ui/test/tools/replay-capture.mjs:59` — [other] recursive next() inside term.write callback overflows stack on large recordings — CR-007

## Checked and clean

No standards review (compact profile; no guides configured).

Note: installClaude.json is a minimal hand-constructed fixture (single prompt line, 29 empty strings — no surrounding answered-prompt context). The test file comment at line 37-38 labels only model as "format-accurate constructed"; installClaude and customModel are not labeled. The minimal installClaude fixture does not exercise the last-match discriminator for that prompt id. No blocking finding is raised here (concern was not surfaced by the edge-case lens, which is the sole applicable lens under the compact profile), but the labeling gap and the discriminator coverage gap for installClaude are observable from the source.

plus 0 more — see code-review-final.json
