# CodeMie CLI: analytics `view` and memory fix · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Repository:** `codemie-code`. This file lives in Connect's repo because the design that drives it does; copy it to `codemie-code/docs/superpowers/plans/` when the work starts there.

**Goal:** One PR that stops `codemie analytics` from parsing logs it then throws away (same output, much less time and memory), and adds `codemie analytics view`, which computes the Analytics page's numbers from an existing JSON export.

**Architecture:**
- **Memory fix.** `loadNativeSessions` learns whether external sessions are wanted. When they aren't, it checks the ownership marker *before* parsing a Claude-family log and skips the ones that would be dropped later. `enrichCosts` frees each parsed log after pricing it.
- **New subcommand.** `view` is a separate command under `analytics`. It reads an export file, filters its sessions, and writes one of three things: a summary JSON, one session with its trace tree, or the existing HTML report. The formulas are ported from `report/client/app.js` into a typed module. Parity tests run `app.js`'s own functions against the module.
- **Untouched:** `app.js`, `template.html` and all existing outputs.
- **Connect's calls** pass `--include-external always`. The skip doesn't apply to them (nothing is dropped), so for Connect the freeing of parsed logs is the part that matters.

**Tech Stack:** TypeScript (ESM), commander, vitest, Node 20.

**Spec:** `docs/superpowers/specs/2026-11-19-analytics-design.md` (Connect repo), section "The `view` contract".

## Global Constraints

- Existing commands keep their output. `codemie analytics …` terminal output, `--export html|json|both` and `analytics sync` stay byte-identical, except `generatedAt`. Only speed and memory change.
- Do not edit `src/cli/commands/analytics/report/client/app.js` or `report/template.html`.
- Summary JSON schema strings are exactly `codemie.analytics.summary/1` and `codemie.analytics.session/1`.
- Week buckets apply when the range is longer than 35 days. Buckets are local calendar days, and a week starts on Monday.
- Depth bucket labels are exactly `1`, `2–5`, `6–10`, `11–25`, `26–50`, `51+` (en dash).
- Dead session: `costUSD > 0 && filesChanged === 0 && netLines === 0`. Bloat: `cacheReadCostUSD / costUSD`. Context per turn: `Σ cacheRead / Σ turns` over sessions with `tokens.cacheRead > 0`. Tool success: `Σ success / Σ calls`.
- Branch `feat/analytics-view` (or `EPMCDME-<NNNN>_analytics-view` if a ticket exists). PR title `feat(analytics): add view command and stop parsing dropped native logs`.
- Gates: `npm run typecheck`, `npm run lint`, `npx vitest run --project unit`, `npx vitest run --project cli`, `npm run build`.

## Review Focus

1. **An export with zero sessions, or filters that match none.** `view` must print a valid summary with zeros and empty arrays and exit 0, never crash. Covered in step 6.
2. **Unpriced sessions** (`hadLog: false`, `costUSD: 0`) count in `sessions` and `coverage`, but not in `pricedSessions`, cost or tokens. Covered in step 6.
3. **The same `sessionId` twice in the input** (a caller's merge slip). The last occurrence wins, so totals count it once. Covered in step 6.
4. **A range across the DST change** (Europe/Kyiv, 2026-10-25). Day buckets must be calendar days, not 24-hour steps: exactly one bucket per date, with no duplicate or missing day. Covered in step 6 (run with `TZ=Europe/Kyiv`).
5. **Date-only `--from/--to` keep the CLI's UTC-day meaning** (as in #760), while full ISO timestamps are used exactly. Covered in step 8.

---

### Task 1: Memory fix and `analytics view` (one PR)

**Files:**
- Modify: `src/cli/commands/analytics/native-loader.ts`
  - `loadNativeSessions` (line ~816): new options argument.
  - The final loop (line ~860–895): skip before `deps.parse`.
- Modify: `src/cli/commands/analytics/sources/sessions-source.ts:19`: pass `opts.includeExternal`.
- Modify: `src/cli/commands/analytics/cost/cost-enricher.ts`: the pricing loop `for (const entry of ordered)` at line ~634. Set `entry.parsed = null` after its last use (the dispatch block, line ~724–750).
- Modify: `src/cli/commands/analytics/index.ts` (`createAnalyticsCommand`, line ~75): `command.addCommand(createViewCommand())`.
- Create:
  - `src/cli/commands/analytics/view/types.ts`
  - `src/cli/commands/analytics/view/input.ts`
  - `src/cli/commands/analytics/view/summary.ts`
  - `src/cli/commands/analytics/view/trace.ts`
  - `src/cli/commands/analytics/view/view-command.ts`
- Test:
  - `src/cli/commands/analytics/__tests__/native-loader.test.ts` (extend)
  - `src/cli/commands/analytics/cost/__tests__/cost-enricher.test.ts` (extend)
  - `src/cli/commands/analytics/view/__tests__/summary.test.ts`
  - `src/cli/commands/analytics/view/__tests__/trace.test.ts`
  - `src/cli/commands/analytics/view/__tests__/view-command.test.ts`
  - `src/cli/commands/analytics/report/__tests__/view-parity.test.ts`
- Docs: `CHANGELOG.md` `[Unreleased]`, and the README analytics section (one paragraph and the command line).

**Interfaces:**
- Produces, used by Connect:
  - **The commands:** `codemie analytics view --input <file> [--from] [--to] [--last] [--agent] [--project] [--branch] [--compare] [--session <id>] [--export summary|html] [-o <path>]`. Exit 0 on success and on an empty result. Exit 1 with one-line `✗ …` text on stderr for a missing or unreadable file, a file that isn't an export, an unknown `--session`, or a bad date.
  - **The output:** JSON on stdout, or written to `-o`, exactly as in the spec's contract.
- Internal:
  - `loadNativeSessions(filter?: AnalyticsFilter, deps: NativeLoaderDeps = realNativeDeps, opts: { includeExternal?: boolean } = {}): Promise<RawSessionData[]>`. When `includeExternal` is undefined it means `true`, which keeps today's behavior for other callers.
  - `readExportFile(path: string): ReportPayload`. It throws `ViewInputError(message)`. Later rows win when two share a `sessionId`.
  - `filterRecords(records: ReportSessionRecord[], f: ViewFilter): ReportSessionRecord[]`, with `ViewFilter = { from?: number; to?: number; agent?: string; project?: string; branch?: string }`.
  - `buildSummary(payload: ReportPayload, f: ViewFilter, opts: { compare: boolean; now: number }): AnalyticsSummary`.
  - `buildTrace(s: ReportSessionRecord): TraceEntry[]`, with `TraceEntry = { key: string; kind: 'agent'|'skill'|'command'; name: string; label: string; level: number; parentKey: string | null; childKeys: string[]; issue: string | null }`.
  - `createViewCommand(): Command`.

- [ ] **Step 1: Write the failing native-loader test**

In `native-loader.test.ts`, use the file's existing fake `NativeLoaderDeps`. Have it discover three Claude descriptors: A has an ownership marker, B has none, and C belongs to an analytics-only agent. Record each `deps.parse` call.

```ts
it('does not parse a Claude log CodeMie did not start when external sessions are not wanted', async () => {
  const out = await loadNativeSessions(filter, deps, { includeExternal: false });
  expect(parsed).toEqual(['A', 'C']);                       // B is never opened
  expect(out.map(s => s.sessionId).sort()).toEqual(['A', 'C']);
});
it('still parses everything when external sessions are wanted or the option is omitted', async () => {
  await loadNativeSessions(filter, deps, { includeExternal: true });
  await loadNativeSessions(filter, deps);
  expect(parsed).toEqual(['A', 'B', 'C', 'A', 'B', 'C']);
});
it('keeps the Codex and Pi family passes unchanged when external sessions are not wanted', async () => {
  // discovery adds codex parent P (no marker) whose rollout names child thread K (marker)
  await loadNativeSessions(filter, codexDeps, { includeExternal: false });
  expect(parsed).toContain('P');                            // still parsed: it links K to its parent
  expect(outIds).not.toContain('K');                        // K stays counted inside P, as today
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run src/cli/commands/analytics/__tests__/native-loader.test.ts`
Expected: FAIL. B is parsed, and the options argument is ignored.

- [ ] **Step 3: Implement the skip**

1. In `loadNativeSessions`'s final loop, before the `else { parsed = await deps.parse(...) }` branch, `continue` when all four hold:
   - `opts.includeExternal === false`
   - not `isCodexFamilyAgent`
   - not `isPiFamilyAgent`
   - `!isAnalyticsOnlyAgent(agentName) && !deps.hasOwnershipMarker(descriptor.filePath)`

   This is the same condition that tags a session `native-external` at line ~890.
2. In `SessionsSource.load`, call `loadNativeSessions(opts.filter, undefined, { includeExternal: Boolean(opts.includeExternal) })`. Keep the `.filter(... !== 'native-external')` that follows; it stays as the safety net.

- [ ] **Step 4: Free each parsed log after pricing, and prove nothing changed**

Add `entry.parsed = null;` as the last statement of each iteration of the pricing loop (`for (const entry of ordered)`, line ~634), after the dispatch block that is the last reader (line ~724–750). No code after the loop reads `entry.parsed` (checked: `grep -n "\.parsed" cost/cost-enricher.ts`).

The behavior proof is the existing suite. The memory effect is measured in E2, because a unit test can't observe garbage collection.

Run: `npx vitest run src/cli/commands/analytics/cost/__tests__/cost-enricher.test.ts`
Expected: all existing cases PASS, unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/analytics/native-loader.ts src/cli/commands/analytics/sources/sessions-source.ts src/cli/commands/analytics/cost/cost-enricher.ts src/cli/commands/analytics/__tests__/native-loader.test.ts src/cli/commands/analytics/cost/__tests__/cost-enricher.test.ts
git commit -m "perf(analytics): skip parsing native logs that are dropped and free parsed logs after pricing"
```

- [ ] **Step 6: Write the failing summary tests**

In `view/__tests__/summary.test.ts`, use a fixture builder `record(overrides)` that returns a full `ReportSessionRecord`. Start from a copy of one session of a real `--export json`, with invented titles and paths under `/Users/taylor`.

```ts
it('totals match the per-session sums and the export meta for the same sessions', ...)        // sessions, costUSD, turns, durationMs, toolCalls, toolSuccessRate (rounded like meta: 1 decimal)
it('rolls up tools, skills, subagents, commands, models and projects, sorted by calls or cost', ...)
it('marks dead sessions with cost but no files and no net lines, and ranks them by cost', ...)   // top length <= 8
it('computes context per turn only over sessions with cache reads', ...)
it('puts sessions into the six depth buckets with the exact labels', ...)                       // ['1','2–5','6–10','11–25','26–50','51+']
it('uses day buckets up to 35 days and Monday weeks beyond', ...)
it('returns zeros and empty lists for an export with no matching sessions', ...)               // Review Focus 1
it('counts an unpriced session in sessions and coverage but not in cost or pricedSessions', ...) // Review Focus 2
it('counts a sessionId that appears twice once, keeping the later row', ...)                    // Review Focus 3 (via readExportFile)
it('makes one bucket per calendar day across the DST change', ...)                              // Review Focus 4: TZ=Europe/Kyiv, 2026-10-20..2026-10-30 → 11 buckets, dates unique
it('adds previous and change only with --compare and only when the input covers the previous range', ...)
```

In `view/__tests__/trace.test.ts`:

```ts
it('nests children under their parent by parentId, then by owner agentId', ...)
it('numbers repeated names in start order: "/teams-transcript #1", "#2"', ...)
it('keeps a step whose parent is missing at level 0 with issue "Parent not found"', ...)
```

- [ ] **Step 7: Run them and see them fail**

Run: `npx vitest run src/cli/commands/analytics/view`
Expected: FAIL with "Cannot find module '../summary.js'".

- [ ] **Step 8: Implement `types.ts`, `input.ts`, `summary.ts`, `trace.ts`**

- `types.ts`: `AnalyticsSummary` and `SessionDetail` exactly as in the spec's contract.
- `input.ts`:
  - `readExportFile`: `JSON.parse`; requires `meta` and `Array.isArray(sessions)`; dedupes by `sessionId`.
  - `parseViewDate(value, edge: 'from'|'to')`: `YYYY-MM-DD` keeps UTC-day bounds through the existing `parseDateOnly`; an ISO timestamp with time is used as-is. `--last` goes through the existing `parseDuration`.
- `summary.ts`: one exported `buildSummary`. Each formula carries a one-line comment naming the `app.js` function it mirrors (`successRate`, `VIEWS.efficiency` dead/bloat/depth, `appendToolsAndModels`).
- `trace.ts`: a port of `traceEntries` (app.js ~line 1189) with labels in the form `name` or `name #n`, without the kind prefix. Connect shows the kind as a badge.

Add a test for Review Focus 5 in `summary.test.ts`: `parseViewDate('2026-11-19','from')` equals `Date.UTC(2026,10,19)`, and `parseViewDate('2026-11-19T00:00:00+02:00','from')` equals `Date.parse` of the same string.

Run: `npx vitest run src/cli/commands/analytics/view`
Expected: PASS.

- [ ] **Step 9: Write the parity test, then make it pass**

In `report/__tests__/view-parity.test.ts`, slice `traceEntries` and `successRate` out of `client/app.js` with the vm-slice pattern of `report-views.test.ts::sessionPayloadHarness`. Run each on the same fixture sessions as the module:

```ts
it('buildTrace gives the same order, levels and parents as the report\'s traceEntries', ...)   // compare key, level, parent key; labels differ only by the "kind · " prefix
it('summary tool success equals the report\'s successRate for the same sessions', ...)
```

Run: `npx vitest run src/cli/commands/analytics/report/__tests__/view-parity.test.ts`
Expected: PASS.

- [ ] **Step 10: Write the failing command tests, then implement `view-command.ts`**

In `view/__tests__/view-command.test.ts`, run the command through commander with a temp export file. Capture stdout and `process.exitCode`.

```ts
it('prints a summary/1 JSON for the filters and exits 0', ...)
it('prints session/1 with the trace for --session', ...)
it('writes the normal HTML report for --export html -o', ...)            // file contains window.__ANALYTICS__ with only the filtered sessions
it('fails with one line and exit 1 for a missing file, a non-export file, an unknown session id and a bad date', ...)
it('never reads agent logs', ...)                                          // spy: loadNativeSessions and MetricsDataLoader are not called
```

Implement `createViewCommand()`:
- Options as listed in Interfaces. The default `--export` is `summary`. Stdout unless `-o` is given.
- `--export html` reuses `generateReport` from `report/report-generator.ts` on `{ meta, sessions: filtered }`.
- No prompts and no colors on stdout.
- Register it in `createAnalyticsCommand` next to `otel`.

Run: `npx vitest run src/cli/commands/analytics/view`
Expected: PASS.

- [ ] **Step 11: Run all gates**

Run: `npm run typecheck && npm run lint && npx vitest run --project unit && npx vitest run --project cli && npm run build`
Expected: every command exits 0. Existing analytics tests are unchanged and pass: `payload-builder.test.ts`, `report-views.test.ts`, `analytics-sync-cli.test.ts`, `native-loader.test.ts` and `cost-enricher.test.ts`.

- [ ] **Step 12: Run the end-to-end checks below on a real machine, record the numbers in the PR, then commit and open the PR**

```bash
git add src/cli/commands/analytics CHANGELOG.md README.md
git commit -m "feat(analytics): add view command for summaries, session traces and html from an export"
git push -u origin feat/analytics-view
```

PR description: what changed, the "unchanged output" evidence (E1), the before/after time and memory table (E2/E3), and the `view` contract.

---

## End-to-end verification (real machine, before merge)

Build the branch (`npm run build`) and run it as `node bin/codemie.js`. Run the installed 0.17.0 as `codemie`. Use the same machine and the same minute for both.

| # | Scenario | Command(s) | Pass when |
|---|---|---|---|
| E1 | Same output as today | `codemie analytics --last 3d --export json -o old.json` and the branch with `-o new.json`; repeat with `--include-external always`; repeat for `--export html` | `jq 'del(.meta.generatedAt)'` of both files is identical. The HTML differs only in `generatedAt`. |
| E2 | No more out-of-memory at default memory | branch: `/usr/bin/time -l node bin/codemie.js analytics --last 7d --export json -o w7.json`, then `--last 30d` | Both finish. Peak resident memory is recorded. 7 days stays under 2 GB on the reference Mac. |
| E2b | Connect's call shape | `/usr/bin/time -l` for `--from <3 days ago> --to <yesterday> --include-external always --export json` on 0.17.0 and on the branch | Same JSON (as E1); the branch's peak memory is not higher. Both numbers go in the PR (0.17.0 today: 4.2 GB at a 6 GB heap). |
| E3 | Faster small windows | `time` for `--last 24h` on 0.17.0 and on the branch | The branch is at least 3× faster on the reference Mac (13 s on 0.17.0 today). Both numbers go in the PR. |
| E4 | `view` matches a direct export | `--last 30d --export json -o s.json`, then `view --input s.json --last 30d` | `totals.sessions`, `totals.costUSD` (to the cent), `turns`, `toolCalls` and `toolSuccessRate` equal `s.json`'s `meta.totals`. |
| E5 | Trace equals the report's Timeline | `view --input s.json --session <id with subagents>`, and open the same session in `--export html` | Same steps, same nesting, same `#n` numbering, same parent for each child. |
| E6 | HTML from an export | `view --input s.json --last 7d --export html -o r.html` and open it | The report opens; Overview numbers equal `codemie analytics --last 7d --export html`. |
| E7 | Bad input | `view --input missing.json`, `view --input README.md`, `view --input s.json --session nope`, `view --input s.json --from 2026-13-01` | Each prints one `✗ …` line on stderr and exits 1, with no stack trace. |
| E8 | Speed of `view` | `time view --input s.json --last 90d` on a 90-day export | Under 2 s. |
| E9 | Windows and Codex/Pi users unaffected | Run E1 on one Windows machine and on one machine with Codex or Pi sessions | E1 passes there too. |
