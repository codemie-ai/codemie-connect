# Milestone 2: Claude, data location, automations and Echo plugins

Milestone 1 made CodeMie Connect a personal workspace over Microsoft 365 (Today, Calendar, Inbox, Settings). Milestone 2 adds:

| Feature | What it does |
|---|---|
| Claude integration | Connect finds the user's own Claude Code and any CodeMie (`codemie-claude`) profile, lets them pick one per purpose, and runs Claude headless and tool-free. Nothing a profile or secret holds is read or shown. |
| Drafts and summaries | Inbox and Today draft Outlook and Teams replies and summarize threads. A draft only fills the reply box; Connect sends nothing until the user presses Send. |
| Automations | Rules such as "Morning brief" run on a schedule or when mail arrives; their results appear on Today, in the Run log and in notifications. |
| Data location | Settings shows where Connect keeps its data, and can move it to another folder and back. Credentials and plugin secrets stay in the default folder. |
| Echo plugin host | Echo-compatible plugins (host half in QuickJS, UI half in a sandboxed frame) install from marketplaces, show a permission sheet, and run. Proven with the four published plugins. |
| Workspaces hidden | Only the personal workspace shows until workspaces are redesigned. |

## How to try each feature

1. **Claude** (Settings, Claude): lists the profiles found, which is the default and which one each purpose (mail drafts, chat drafts, summaries, automations) uses, this month's usage, and a Test button per profile. Sign in with Claude Code (`claude`) or a CodeMie profile first.
2. **Reply draft**: Inbox, open a conversation, Draft with AI (options: intent, tone, length, free times, instructions). Today's Needs your reply rows have Draft reply. Edit, then Send yourself, or Regenerate.
3. **Summary**: Inbox, open a thread, Summarize. The card shows asks you can add to commitments; it marks itself stale when the thread changes.
4. **Automations**: sidebar Automations, New automation, start from Morning brief, Run now. Turn on delivery to Today to get a card.
5. **Data location** (Settings, Storage): Change folder, pick a folder, read the check (cloud, network, exFAT and free-space problems are refused with the reason), confirm. Use the default folder returns it. A recovery page opens if the chosen folder is missing at launch.
6. **Plugins** (Settings, Plugins): add a marketplace (a git URL or local folder), Inspect a plugin to read its sheet, Install, open its page from the sidebar or Settings. Update and Disable are on the plugin's page. Scheduler, GitHub and Obsidian work; see limits.

Tests, smokes and commands to run: [../../.ai-run/guides/testing/testing-patterns.md](../../.ai-run/guides/testing/testing-patterns.md). Quality gates: [../../.ai-run/guides/quality-gates.md](../../.ai-run/guides/quality-gates.md).

## Document map

| Document | Read it for |
|---|---|
| [DESIGN.md](DESIGN.md) | The design: Claude (section 6), plugin host (7), data location (8), workspaces (9) |
| [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md) | The task plan |
| [PLUGIN-ENGINE.md](PLUGIN-ENGINE.md) | Plugin engine 1.0, the contract Connect and Echo both implement; section 10 is where Connect differs from the first plan |
| [PLUGIN-CONFORMANCE.md](PLUGIN-CONFORMANCE.md) | What each published plugin does in Connect, with the evidence |
| [SHARED-HOST-API.md](SHARED-HOST-API.md) | The host API shared with Echo |
| [VALIDATION.md](VALIDATION.md) | Gate results, the isolation and plugin smokes, live checks and what is still open |
| [KNOWLEDGE.md](KNOWLEDGE.md), [KNOWLEDGE-PLUGIN-FEASIBILITY.md](KNOWLEDGE-PLUGIN-FEASIBILITY.md) | Knowledge, postponed; another session owns these |
| [../../.ai-run/guides/architecture/architecture.md](../../.ai-run/guides/architecture/architecture.md) | Module boundaries, isolation model, data and private roots |

## Known limits

- **Telegram does not load.** Its host half calls `ctx.sessions` without a check, and Connect has no Echo sessions. Connect reports exactly that in Settings, Plugins; the fix is a small change in the plugin. Scheduler delivery to Telegram is unavailable until then.
- **Knowledge is postponed.** It needs Echo's Knowledge engine; its install shows a blocking line. See KNOWLEDGE.md.
- **Echo-only features are absent** (`sessions`, `channel`, `agent`, `scripts`, `threads`, `slots`, `view`, `terminal`); plugins that feature-detect them work without them (PLUGIN-ENGINE.md section 10).
- **Page widgets on Today are text only.** Palette entries are buttons on the plugin's Settings page. All plugins share a generic icon.
- **Held messages.** A plugin's delivery to mail or Teams is held on Today with Copy; Connect never sends it, and there is no send-to-self action yet.
- **Plugin settings:** only `hosts_from` has a Connect form field; GitHub's token comes from `gh auth token` after the user presses Sign in.
- **Plugin frames are macOS only.** On other systems the frames are not served (isolation is not verified there).
- **Claude runs are tool-free** and have no Echo sessions; plugin Claude runs carry no tools.
- **Live checks are partly open:** see the Live checks section of [VALIDATION.md](VALIDATION.md).
