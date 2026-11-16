# Screen & behavior map · v2

All routes are ordinary linked HTML files. Shared scripts save fictional state locally. Every native effect is simulated.

| HTML | Browser interactions / purpose |
|---|---|
| proposal.html | Revised product direction, measured visual baseline, navigation and compatibility decisions |
| index.html / today.html | Sourced brief, evidence/ack, agenda/arming, decisions, commitments, Knowledge, usage, focus, configurable widget catalog |
| inbox.html | Six lanes, thread selection, priority explanation, ack, snooze, archive/undo, source save, prepared reply/recipient review, sending policy/log |
| chat.html | Conversation profiles, draft persistence, selected context, exact slash skill, sample response/stop, local saved sessions, answer save, handoff preview |
| calendar.html | Week/agenda/month, date navigation, event preparation, local event review and creation, cached/expired Graph states |
| meetings.html | Search/status filtering, meeting cards, capture and import navigation |
| capture.html | Eight source choices, source/scope/notice consent, opt-in arming, live sample transcript/chat/screens-off tabs, private notes, pause/resume/stop, minutes delay |
| meeting.html | Audio simulation, transcript/minutes/actions/context, recipe selection, generate/edit, reviewed save to Knowledge, pending-minutes controls |
| recipes.html | Rule/timing/skill/template/output/history tabs, recipe editor, matching rules, delay, output options, sample test, version restore |
| knowledge.html | Vault home: Sources → Pages → Rules, inline Ask/Recall, recent changes, health/queue, vault switch; legacy ?doc= reader links still work |
| knowledge-pages.html | File tree/search, reader/editor/new page, frontmatter, backlinks, history/diff/restore, external-editor preview |
| knowledge-ask.html | Ask/Curate/Research, Research raw-source consent, exact personal skills, context, pinned profile, sessions, sample trace, citations, reviewed proposal, answer save, continuation preview |
| knowledge-graph.html | 60 sample nodes, color by folder/type/tag, search highlight, local depth, index/isolated toggles, selection inspector, zoom and page/Ask links |
| knowledge-ingest.html | Source queue, original source preview, five pipeline phases, four per-file diffs, selected approval, optional taxonomy proposal, redo instruction, duplicate comparison, ledger |
| knowledge-health.html | Score components, twelve finding types, side-by-side source conflict, selected resolution diff, individual approval/undo, read-only guard |
| knowledge-setup.html | Vault/Schema/Skills/Sources/Access tabs, existing folder in place, profile skill preview, watch folder, Git/cache preferences, folder/profile matrix and read-only grant |
| spaces.html / space.html | Create/edit space; overview wiki brief, risks/decisions, meetings/work/inbox/knowledge/people/sources tabs, membership rules and source selection |
| people.html | People search, local person form, related-context cards, organization preview |
| files.html | OneDrive sample list/filter/preview, context selection and Knowledge source review |
| automations.html | Routine selection, enable/pause/create/edit/delete, schedule/event toggle, visible deterministic/AI steps, catch-up policy, run/history/output, paused templates |
| plugins.html | Discover/installed/updates/marketplaces, category/search, add/remove marketplace, permission update review |
| plugin.html | Six package examples; overview/settings/permissions/compatibility; install/enable/disable/remove; package-specific configuration; widget addition |
| plugin-studio.html | Exact Echo contract explanation, basic manifest validation, original starter package download and native-capability boundaries |
| settings.html | Workspace name, launch/notification/start page/time zone preferences, export and data layout |
| settings-setup.html | Installation / AI tools / Desktop connections / Health / Activity log / Updates; progress, cancel, failure/retry, logs and supported recovery |
| settings-ai.html | Independent direct and optional CodeMie profiles, profile test/config, per-job profile/cap routing and folder-access link |
| settings-connections.html | Microsoft Graph capability selection, connection/reconnect/disconnect, tenant approval path, separate send consent |
| settings-capture.html | Detection policy per app with Never precedence, source preferences, OS permission preview, local/server transcription, model requirements and vocabulary |
| settings-notifications.html | Quiet schedule, VIP list, ordered triage rules, critical desktop/Telegram/phone boundary, reply recipe, send policy and local log |
| settings-appearance.html | Light/dark/system themes, density, Today customization, measured font baseline |
| settings-privacy.html | Local folders/exports, plugin grants, privacy and destructive-demo reset controls |
| analytics.html | Personal usage periods, provider distinction, activity chart, CLI report preview and sample export |
| onboarding.html | Three skippable steps: AI, context, theme/capabilities; direct profile and optional CodeMie |
| library.html | Searchable links to all 35 distinct screens |

## Interaction boundaries

- Static fixtures illustrate source counts and run costs; they are not live analytics. A local action changes the relevant sample state, not an actual account or desktop service.
- Raw-source Research requires opt-in. Curate produces a reviewed edit. A read-only vault blocks writes across page editing, answer saving, ingestion and repairs.
- Routine trigger and catch-up execution needs the native scheduler. Phone escalation and screen capture are shown as separate opt-in implementation capabilities, not working services.
- A continuation dialog describes profile/folder/session handoff; it does not launch a terminal. Graph consent and send dialogs are simulated.
- Package validation in the browser checks basic manifest shape. Full package/runtime/UI conformance remains native work.
