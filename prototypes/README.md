# CodeMie Connect workspace · proposal v2

Start with **[proposal.html](proposal.html)**, **[Today](index.html)** or the **[screen library](library.html)**. This revision uses the real CodeMie visual system inspected through the Chrome extension, and restores the deeper workflows from all 25 Echo future prototype pages.

Everything is contained in this folder. Open an HTML page directly, or run from the repository root:

```sh
python3 -m http.server 5194 --bind 127.0.0.1 --directory prototypes
```

Then open http://127.0.0.1:5194/. No build, install, CDN or external runtime is required. Keep the shared assets beside the HTML files.

## First implementation milestone

The [Milestone 1 approval package](milestone-1/README.md) contains the four-task implementation plan, 82 scenario groups, architecture review and current-app baseline. The prototype dark palette has been corrected against live CodeMie semantic roles; see [the theme note](milestone-1/DARK-THEME.md). Production implementation still awaits approval.

## What changed in v2

- **CodeMie styling:** actual GeistMono / Geist fonts, blue light mode, charcoal dark mode, CodeMie gradient button outlines, flat panels and 196 px navigation. Removed the Echo-like title bar and decorative welcome hero.
- **Today:** inline five-point sourced briefing, cross-platform timeline, critical evidence and acknowledgement, decision queue, commitments, Knowledge changes, profile usage and focus rules. Change card visibility, widths and order; drag cards in Arrange mode. Plugin cards participate in the same layout.
- **Knowledge:** a vault home, separate Pages reader, graph filters and inspector, Ask, a staged ingestion pipeline with selected file diffs, 12 health finding types, and Vault / Schema / Skills / Sources / Access settings.
- **Meetings:** dedicated Capture page with eight source choices, consent and scope, opt-in arming, simulated live transcript/chat/private notes, pause/resume, stop and minutes delay. Recipes have matching rules, timing, skill, template, outputs, history and a past-meeting test.
- **Inbox and routines:** six triage lanes, deterministic-rule evidence, AI confidence, prepared replies, separate send review, routine steps, catch-up behavior and run inspection.
- **Settings:** setup functionality remains in Setup & tools. Notifications & focus has quiet hours, VIPs, critical rules and escalation. AI profiles add routing and cap behavior by job.

## Try these journeys

1. Today → critical alert → inspect evidence → acknowledge → Inbox → review a prepared reply → review recipient/body → simulate send.
2. Today → Customize → hide/show cards, change widths, reorder → Arrange on page → drag a card → Finish arranging. Reload to check persistence.
3. Meetings → Capture → choose a source → Configure & record → confirm scope and participant notice → start → pause/resume → stop → review transcript → generate minutes → save to Knowledge.
4. Knowledge → Ingest → read original source → deselect a file → approve selected diffs. Health → choose the conflicting fact → review diff → resolve only that finding.
5. Knowledge → Schema & skills → Access → enable read-only. Ingest and health writes are blocked while browsing and Ask stay available.
6. Recipes → Timing / Skill / Template / Outputs / History → test on a past meeting. Automations → choose a routine → inspect steps, run history and output.
7. Plugins → inspect unchanged Echo package requirements → approve access → install Focus card → add its widget to Today. Disable the plugin and its contribution disappears.
8. Footer sample-data menu → First launch / Ready / CodeMie / Microsoft expired / tenant approval scenarios. Finish setup through Settings → Setup & tools.

**⌘K / Ctrl+K** opens navigation search. **⌘J / Ctrl+J** opens contextual Ask. Escape closes dialogs/panels; ⌘Enter submits Chat or Knowledge Ask. Themes, drafts and sample edits persist under `connect-prototype-v1` in localStorage. Existing sessions retain their selected profile.

## Scope and evidence

35 distinct screens, plus a `today.html` alias. All people, messages, meetings and usage figures are fictional. Forms, navigation, filters, local edits, review states, exports and downloads work in the browser.

**Native operations are simulated:** installation, OAuth, Microsoft Graph, recording, transcription, AI, OS notifications, background scheduling and plugin execution. Direct Claude Code is a complete proposed path without a CodeMie account. CodeMie adds project assistants, routing and budgets. Delivery and factories remain excluded.

- [Measured CodeMie design](docs/DESIGN-SYSTEM.md)
- [Complete Echo page review and feature mapping](docs/ECHO-REVIEW.md)
- [Implementation sequence](docs/PLAN.md)
- [Screen map](docs/SCREEN-MAP.md)
- [Plugin compatibility investigation](docs/PLUGIN-REUSE.md)
- [Current Connect functionality migration](docs/MIGRATION.md)
- [Current browser validation](validation/v2/REPORT.md)
- [Echo-format starter ZIP](examples/focus-card.zip)

Production source is unchanged. The prototype reuses the existing CodeMie logo and local CodeMie font files, with the font license in assets/fonts/. No Echo runtime source is embedded. Version 1 browser evidence in validation/v1/ is historical; current evidence is in validation/v2/.
