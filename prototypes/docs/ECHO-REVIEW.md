# Echo future: complete review and mapping

Reviewed 16 November 2026. All 25 HTML files under `echo/future/mockups/` were opened in a real Chromium browser at 1600×1100. Each was inspected at the top and after scrolling; headings, controls and page notes were inventoried. Source HTML was also reviewed. No Echo source was changed.

Evidence: `validation/v2/reference/echo-browser-review.json`, `echo-source-inventory.json` and `echo-*-top.png` / `echo-*-bottom.png`. All 25 pages loaded without page errors. These are design references; their controls do not establish native feature availability.

| Echo page | Functionality reviewed | Revised Connect destination |
|---|---|---|
| index | Product narrative, connected day, principles, all-screen tour | proposal.html + library.html |
| onboarding | Role, areas, accounts, knowledge, permissions, skippable setup | onboarding.html + contextual Today setup banner |
| today | Sourced inline brief, cross-platform agenda, critical rule evidence, decision queue, work commitments, overnight Knowledge, AI spend, interruptions | index.html; seven default configurable cards, plugin additions, sizing and ordering |
| inbox | Critical/reply/waiting/FYI/low/decisions lanes, rule-before-AI triage, quote/confidence, ack, reply recipes and sending log | inbox.html + Settings → Notifications & focus |
| capture | Detected calls, opt-in arming, Teams/Meet/Zoom/Slack/app/system/room/memo sources, live transcript/chat/notes, imports and scope | capture.html + settings-capture.html |
| meeting | Recording, transcript, minutes, actions, context, delayed recipe, review/publish distinction | meeting.html; pending-minutes state after simulated capture |
| recipes | First-match rules, delay/manual/quiet hours, skill/prompt/template/profile/cap/output, past-meeting test, versions | recipes.html; six detail tabs and editable recipe content |
| knowledge | Sources → Pages → Rules; inline Ask/Recall, recent changes, vault profile, health and queue | knowledge.html is now vault home |
| knowledge-files | File tree, reader/editor, frontmatter, provenance, backlinks, version diff/restore, external editor | knowledge-pages.html; existing knowledge.html?doc= links remain supported |
| knowledge-graph | Folder/type/tag colors, search, local depth, hidden indexes, isolated pages, node inspector | knowledge-graph.html; 60 sample nodes, selection, filters and zoom |
| knowledge-ask | Ask/Curate/Research, selected profile, personal skills, source/tool reads, citations, save proposal, continue session | knowledge-ask.html; Ask/Curate/Research, Research source consent, sessions, sample tool trace, reviewed edit, answer save and continuation preview |
| knowledge-ingest | Immutable source queue, convert/AI-route/write/deterministic-index/review/ledger, multi-file diffs, duplicate and redo decisions | knowledge-ingest.html; per-file approval, source preview, duplicate comparison and ledger inspection |
| knowledge-health | Weighted score, trend, 12 finding types, human conflicts vs deterministic vs AI fixes, individual diff approval | knowledge-health.html; individual finding states; no blanket “everything fixed” action |
| knowledge-setup | Existing vault as-is; Vault/Schema/Skills/Sources/Access; Git policy; profile/folder matrix | knowledge-setup.html; profile skills stay in their original folders |
| chat | Conversations, independent harness profiles, platform assistants, context pack, tool trace, permission review, continue elsewhere | chat.html + settings-ai.html; context/profile/draft behavior preserved |
| delivery | Personal issues/commitments and handoff to agents | Delivery page excluded; personal commitments retained on Today |
| delivery-run | Agent run stages, gates, receipts and artifact review | Reviewed for context; excluded from this proposal |
| delivery-repos | Repositories, harness inventory, readiness and local tools | Delivery excluded; actual Connect AI tool inventory remains in Setup & tools |
| factories | Factory floor, capacity, spend and escalation | Reviewed for context; excluded |
| factory-designer | Typed deterministic/AI/human/check steps, pass criteria and dry-run | Factory designer excluded; routine detail borrows visible steps without factory orchestration |
| analytics | Personal usage/spend and portfolio/team/factory views | analytics.html keeps personal usage and budgets; portfolio/factory reporting excluded |
| space | Wiki brief, source-linked risks, meetings, work, inbox, knowledge, people and membership context | space.html + people.html + files.html; Delivery tabs excluded |
| automations | Schedule/event triggers, wake catch-up, deterministic fetch + one useful AI step, caps, history and draft delivery | automations.html; list/detail, steps, templates, run/history/output views |
| settings | Grouped navigation, profile routing, per-job caps, permissions, capture “Never wins”, focus and escalation | Settings pages; new Notifications & focus and job routing table |
| settings-codemie | Optional SSO/project models/budgets, assistants, harnesses and health | settings-ai.html + settings-setup.html + usage; direct profile remains complete |

## Intentional boundaries

The prototype demonstrates browser interactions with fictional state. OS app detection, microphone capture, transcription, live AI streaming, OAuth, Graph synchronization/writes, real escalations, background jobs and native plugin execution are implementation work. Echo's design contains future capabilities too; reviewing a mockup does not establish that its native runtime already implements them.

The license and unchanged-package compatibility work remains separately documented in PLUGIN-REUSE.md. Advanced run orchestration, Delivery, factories, real phone escalation and organization-wide portfolio analytics are excluded. These exclusions do not remove personal meetings, commitments or usage.
