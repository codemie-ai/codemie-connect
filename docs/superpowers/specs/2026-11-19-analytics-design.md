# Analytics page: design

**Date:** 2026-11-19 · **Prototype:** `prototypes/analytics/` (port 5215, gitignored) · **Plans:** `docs/superpowers/plans/2026-11-19-analytics-cli.md`, `docs/superpowers/plans/2026-11-19-analytics-connect.md`

## Why

Connect gets an **Analytics** page with two parts:

- **AI analytics:** what the CodeMie CLI knows about coding-agent sessions on this Mac. It has three tabs: Overview (with tools and models), Efficiency, and Sessions (with a trace per session).
- **App analytics:** what Connect itself spent on AI, and what it got done.

The page has to be calm and readable. A refresh reads only what changed. A notice says the numbers cover local sessions only. **Connect calculates no AI metric itself**: the CLI computes every number. Connect runs the CLI as a binary and never loads its code.

## Facts this design rests on (measured 2026-11-19, CLI 0.17.0, this Mac)

- **Time and memory.** `codemie analytics --last 24h --export json` takes 13 s. `--last 7d` crashes with a Node out-of-memory error at the default 4 GB heap. With `NODE_OPTIONS=--max-old-space-size=8192`, 7 days takes 36 s and 30 days 86 s.
- **Sessions CodeMie didn't start.** With `--include-external always` the CLI also counts agents run directly (plain `claude`). On this Mac yesterday has 17 sessions with it and 1 without; three days have 74. Measured with `--max-old-space-size=6144`: 1 day 6 s / 4.0 GB peak memory, 3 days 9 s / 4.2 GB, 7 days 22 s / 4.9 GB. Three days also finish at the default 4 GB heap (3.8 GB peak).
- **Wasted reading.** A 1-day export reads 2 GB of logs to produce **one** session. `loadNativeSessions` (`native-loader.ts`) fully parses every agent log modified in the window. Only then does `SessionsSource.load` drop the `native-external` sessions, which is the default without `--include-external`. `enrichCosts` then parses the kept logs again and holds every parsed log until the end.
- **Where the numbers live today.** `--export json` writes per-session records (`{meta, sessions}`). Every number across sessions (rollups, Efficiency, trace tree) is computed in the browser script `report/client/app.js`. That script has almost no tests on its numbers, so refactoring it is risky. It stays untouched.
- **Outdated bundle.** Connect bundles CLI 0.16.3. Its `--report` flags are removed stubs in 0.17.0, so Connect needs a CLI bump regardless of this feature.
- **Connect's own runs.** Connect's headless Claude runs use `--no-session-persistence`, so the CLI never sees them. Connect records each one in its `ai_run` ledger (`workspace/ai.rs::ai_run_record`).

## Decisions

1. **One CLI PR**, made only of additions and a fix that leaves output unchanged:
   - **Fix:** skip parsing logs that are dropped anyway, and free each parsed log once it's priced. Output is identical.
   - **New subcommand** `codemie analytics view --input <export.json>`. It computes the page's numbers (`--export summary`), one session with its trace (`--session <id>`), or the full HTML report (`--export html`) from an existing export, without reading any agent logs.
   - **Unchanged:** `report/client/app.js`, the template, and the existing outputs.
2. **Connect owns fetching and storage. The CLI owns every number.**
   - Connect fetches with the existing `codemie analytics --from D --to D --include-external always --export json` and upserts the sessions by `sessionId` into `<data root>/analytics/sessions.json`, which is the CLI's own export shape.
   - For every view Connect calls `codemie analytics view --input <that file>` with the filters and renders the JSON it gets back.
   - **Every session on this Mac counts**, including agents run without CodeMie (`--include-external always`, user's call 2026-11-19). The CLI fix's skip doesn't apply to these calls, because nothing is dropped; the freeing of parsed logs and the 3-day windows keep memory in bounds (see the measured facts).
3. **Refresh** reads from the start of yesterday (UTC) to now in one call, which catches sessions that were still running. **First open** reads 90 days back, newest first, 3 days per call. A failed call splits into single days, and a day that still fails is listed with a retry. Opening the page refreshes on its own when the data is more than 15 minutes old.
4. **The CLI binary** is the same `codemie` that Settings → CodeMie uses, found with `ai::discover::find_program_in`. Connect runs it without a shell (an argument array), with `NODE_OPTIONS=--max-old-space-size=6144` and a 10-minute timeout per call. It checks for support with `codemie analytics view --help` (exit 0); otherwise the page shows the "needs a newer CLI" state.
5. **App analytics** is Connect's own logic over Connect's own records: `ai_run`, `meeting`, `commitment`, `action`, `decision` and `automation_run`.
   - **Terminal sessions:** Connect logs each terminal-dock start (folder, program, time). A CLI session counts as "started in Connect" when its `project` equals that folder and it started within 120 s of the launch.
   - **The one exception to decision 2:** the App tab adds up `costUSD` of those matched sessions, because attributing its own launches is Connect's job.

## The `view` contract (both plans use it)

Output is written to stdout (or to `-o <path>`). It is UTF-8 JSON with a `schema` string.

`codemie analytics view --input F [--from X] [--to Y] [--last 7d] [--agent A] [--project P] [--branch B] [--compare] [--export summary]`
→ `schema: "codemie.analytics.summary/1"`

```
range      { from: ms, to: ms, bucket: "day" | "week" }        // week when the range is longer than 35 days; local-time calendar days
filter     { agent, project, branch }                          // null when not set
coverage   [{ agentName, sessions, priced, withLog }]         // for "What's counted"
totals     { sessions, pricedSessions, costUSD, cacheReadCostUSD, durationMs, turns,
             linesAdded, linesRemoved, netLines, filesChanged, toolCalls, toolSuccessRate,
             tokens: { input, output, cacheRead, cacheCreation, total } }
previous   totals of the same-length range just before, or null   // only with --compare, and only when the input covers it (meta.periodStart <= previous.from)
change     { costUSD, sessions, durationMs } as fractions, or null
series     [{ from, to, sessions, costUSD, tokens, durationMs }]
tools      [{ name, calls, success, failure, successRate }]          // sorted by calls
skills | agents | commands   [{ name, calls, sessions }]
models     [{ model, costUSD, tokens, sessions, share }]
projects   [{ project, costUSD, sessions, netLines }]
agentsUsed [{ agentName, sessions, costUSD }]                        // for the Agent filter
efficiency { costPerFileUSD, toolSuccessRate, contextPerTurn, cacheReadCostShare,
             dead: { sessions, costUSD, shareOfCost, shareOfSessions, top: [row] },
             depth: { buckets: [{ label, sessions }], median, average },
             heavy: [row + { contextPerTurn, bloatPct }] }
sessions   [row]   // newest first
row        { sessionId, title, agentName, project, branch, models, startTime, durationMs, turns,
             linesAdded, linesRemoved, filesChanged, costUSD, hadLog, sessionSource,
             steps: { agents, skills, commands } }
```

`codemie analytics view --input F --session <id>` → `schema: "codemie.analytics.session/1"`

```
session    the full ReportSessionRecord from the input
trace      [{ key, kind, name, label, level, parentKey | null, childKeys: [], issue | null }]  // traceEntries() order and labels: "#n" for repeats
```

`codemie analytics view --input F [filters] --export html -o <file>` writes the CLI's normal HTML report for the filtered sessions.

The formulas are the report's own, from `app.js`:
- **Dead session:** `costUSD > 0 && filesChanged === 0 && netLines === 0`
- **Bloat %:** `cacheReadCostUSD / costUSD`
- **Context per turn:** `cacheRead / turns`, over sessions with cache reads
- **Depth buckets:** `1, 2–5, 6–10, 11–25, 26–50, 51+`
- **Tool success:** `success / calls`

## Non-goals

- Changing `report/client/app.js`, or making the HTML report use the new module. That's a possible later PR, after a snapshot test exists.
- Streaming the cost enricher one log at a time. It's only needed if `--include-external` users still run out of memory after the fix.
- A server or a shared database. Sync to a team stays with `codemie analytics sync`.
- A switch for sessions CodeMie didn't start. Connect always counts them; "What's counted" says so and has no toggle, because switching would mean reading the stored history again.

## Prototype calls carried over (user has seen them)

- A top-level switch between AI and App analytics, with Overview, Efficiency and Sessions only under AI. One filter row with date, agent and project. A local-only notice that can be hidden and shrinks to a "Local sessions only" chip.
- A session drawer with header IDs and log path, a five-number strip, and three tabs: Trace (step tree with a side panel), Tokens & cost, and Tools. **Open the CLI report** sits in the header.
- On the App tab, the cost chart shows background runs by default, with terminal sessions as an opt-in.
