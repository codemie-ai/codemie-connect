# Workspace next · rollout overview

**Status:** agreed in brainstorming on 2026-11-22. Each step gets its own design before it is planned.
**Background:** the earlier feature and UI comparison analysis (2026-11-19) and the UI comparison done in the same session.

## Intent

The user wants CodeMie Connect to be their primary app instead of the reference app they use today. Connect keeps what it already does better (installer, safety defaults, the Automations page, the Today grid, the plugin platform). The reference app does better: a compact look, rows that open in place with the reply under the thread, a calm Today, Todoist as the task store, and its daily habits as automations.

## Decisions taken

- **No separate "reference-app mode".** Connect gets a view setting with two values, **Compact** and **Default**. Compact uses the compact sizes (13 / 12 / 11 …) and, on the screens where the reference app's layout is better, that layout. Default keeps today's look and layouts.
- **Menu items can be hidden** in Settings, Today included.
- **Today's toolbar** (layout picker, lock, Add widget, Customize) is too much on screen and can go away.
- **Tasks get a pluggable provider.** One provider is active at a time. Built-in Local is the default; a provider plugin (Todoist first, Obsidian or OneNote later) replaces it while it is on. Connect keeps a local copy as cache and outbox, so tasks made with the window closed (automations, automatic meeting notes) are not lost. Todoist works the way the reference app uses it: `@reply`, `@waiting`, `@budget` and an app label, a hidden key and source line in the description against duplicates, absolute due dates, Late / Today / Later, "looks handled".
- **Meetings open the way the reference app opens them:** the main summary first, action items in a column on the right with "Add N to <provider>", transcript and notes behind ⋯, files under ⋯ › Advanced. Summary tabs are the templates the user pins; this builds on the existing template processing and automatic rules. No layouts per meeting type.
- **Reply** follows the reference app's rules in both views: one Send button named for its target, a ✦ draft link instead of the intent/tone/length popover, Teams sends at once, mail asks a short confirm with To/Cc.
- **Automation templates from the reference app's habits:** Morning briefing (weekdays 08:07, replaces "Morning brief"), Inbox triage (`@reply` task per item needing the user), Commitments (mine and `@waiting`), Budget request reply (`@budget` task plus a reply draft, without the project-exists check), and Formal and Informal meeting summaries (Informal as a marketplace plugin). One new delivery is needed: **create tasks**, through the task provider. End of day, repo digest and performance stay in the reference app.

## Order

All steps go on one branch, `feat/workspace-next`, cut from `workspace-app`, and reach it in one pull request at the end. Each step still gets its own design and plan, its own commits, and passes the definition of done before the next step starts.

0. **Connect marketplace** — a public `codemie-ai/codemie-connect-marketplace` repo in the `echo-plugins` layout, added to Connect as a second built-in marketplace (listed first; `onetest` stays). Home of the Todoist, reply-context and Podervianskyi notes plugins.
1. **Compact view** — view setting, size tokens, compact Inbox and Today, hiding menu items and Today's toolbar. Design: `2026-11-22-compact-view-design.md`.
2. **Reply** — the reference app's reply controls in both views.
3. **Meetings default view** — summary first, action items column, pinned templates, "Open a meeting on" setting.
4. **Task provider and the Todoist plugin.** Plugins run natively in QuickJS, so the core can call the provider with the window closed; the local copy is a cache and an outbox for offline or provider failures.
5. **Create-tasks delivery and the reference-app templates.**
6. **Menu-bar count** — needs-reply by default; Settings › Notifications chooses what else counts (tasks due or late, meetings with new notes, automation results); amber when something needs fixing.
7. **Profiles and models** — routes for the new features (Ask, triage, commitments, briefing), one route per plugin, a fallback profile per route, a working status per row. Engines: Claude (Claude Code and CodeMie profiles) and Ollama, reached through a CodeMie profile whose provider is ollama, as the reference app does; no Codex, pi or opencode.
8. **Reply in the user's voice** — a `reply-context` plugin role (per-person profile, style card from Sent mail, instructions per sender or topic); Connect keeps a copy and adds it to every draft, background ones included. The Knowledge plugin is the first provider.
9. **Ask, inline in the window** — a ⌘K field at the top of the menu; the answer and follow-ups show inside the Connect window, no floating panel. Quick capture (⌘N) with it.

Later: the Podervianskyi notes plugin (Informal meeting summary through the `call.minutes` slot), sentence-based inbox rules.

## How the remaining steps run

The user asked (2026-11-22) to proceed through all steps without stopping. For each step: a design written from this overview's decisions and the code (decisions the overview leaves open are ruled on in the design and listed for the user), a plan, subagent-driven implementation with a review per task, the definition of done below, a final whole-branch review, then the next step.

## Definition of done for every step

The user wants each step properly built and visually verified, so Connect stays fully functional after every merge. A step is done only when all of these pass and the screenshots have been shown to the user:

1. **Quality gates** from `.ai-run/guides/quality-gates.md`: format, lint, `npm test`, `cargo test`, contract fixtures regenerated and committed when a shape changed.
2. **Browser run, new checks:** a check set for the step in `ui/test/browser/` (for example `compact-checks.mjs`) that drives the changed screens in both themes, in Compact and Default, at 1000 / 1440 / 1680 px, with no horizontal overflow, and saves screenshots.
3. **Browser run, no regressions:** the whole `workspace-e2e.mjs` run passes (plugins, meetings, meetings-settings, layout, analytics), not only the new set.
4. **The real app:** a debug build launched on real data, with screenshots of every changed screen, and `CODEMIE_STATUS_SMOKE=status` passing.
5. **Plugin steps:** `CODEMIE_PLUGIN_SMOKE=<marketplace folder>` passes against `codemie-connect-marketplace`.
6. **A side-by-side comparison with the reference mockups** where the step ports a reference-app screen (Inbox, Today, Meetings, Tasks, reply): the Connect screenshot next to the reference one, differences named.

## Not ported

The reference app's Inbox row checkboxes, "Close all" and the "N done today · Show done" footer (decided 2026-11-22: not wanted at all).

The reference app's config editing, engine routes, Terminal logins, launchd jobs, CLI-first actions, the git knowledge base, and the personal skills (performance, repo digest, kid-guard, school meals, pitches).
